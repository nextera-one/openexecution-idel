import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { isIP, type AddressInfo } from "node:net";
import { platform } from "node:os";

import { TerminalService, ServiceError, batchStepSucceeded } from "./service.js";
import {
  NativeTerminalError,
  NativeTerminalManager,
} from "./native-terminal.js";
import type {
  NativeTerminalInfo,
  NativeTerminalSignal,
} from "./native-terminal.js";
import type { ParamValue, RuntimeOutcome } from "@openexecution/types";
import type {
  RunRequest,
  CompleteRequest,
  PreviewRequest,
  ServiceOptions,
} from "./service.js";

/**
 * A dependency-free HTTP server over the {@link TerminalService}. It is the
 * local boundary the web and desktop (Electron) terminals talk to.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /api/health                 → { ok, version, platform, agentAvailable }
 *   GET  /api/registry               → RegistryEntry[]
 *   GET  /api/registry/:id           → { resolved, shadowed }
 *   POST /api/complete   {input,cwd} → string[]
 *   POST /api/preview    {command,cwd} → RuntimePreview (no execute/log)
 *   POST /api/run        RunRequest  → RuntimeOutcome
 *   POST /api/learn      {cli,write} → host-specific learned-command preview
 *   POST /api/editor/open {file,cwd} → { file, content, language, outcome }
 *   POST /api/editor/save {file,content,cwd} → RuntimeOutcome
 *   POST /api/agent/configure {provider,apiKey} → in-memory provider status
 *   POST /api/native/start {cwd,shell} → NativeTerminalInfo
 *   GET  /api/native/:id/stream        → SSE native terminal output
 *   POST /api/native/:id/input {data}  → write to native terminal stdin
 *   POST /api/native/:id/resize {cols,rows} → resize native terminal
 *   POST /api/native/:id/signal {signal} → interrupt/terminate/kill native terminal
 *   POST /api/native/:id/close         → close native terminal
 *   GET  /api/logs?limit=N           → OpenLogRecord[]   (redacted by the writer)
 *   GET  /api/logs/verify            → VerifyResult
 *   GET  /  (+ static)               → the bundled UI, when `staticDir` is set
 *
 * Streaming: `POST /api/run/stream` runs the command and emits the same outcome
 * over Server-Sent Events (one `event: outcome`, then `event: done`). SSE is
 * used deliberately because it needs no extra dependency and keeps the
 * desktop/web bridge uniform.
 *
 * Agent: `POST /api/agent/stream` {intent, allowReal?, provider?} — the embedded AI
 * console. It drives the injected agent, streaming one SSE event per AgentEvent
 * (`text`, `proposed`, `blocked`, `approval_request`, ... then `done`). Each
 * command the agent proposes flows through the same TerminalService.run pipeline
 * (audited as `source: "agent"`). Returns 501 when no agent was wired. After
 * configuration, credentials stay server-side; the setup route requires the
 * server bearer and remains restricted to loopback.
 *
 * Real-run approval: with `allowReal: true`, a real run pauses on an
 * `approval_request` SSE event and the stream parks until the client posts
 * `POST /api/agent/approve` {approvalId, approve}. Without it the agent is
 * propose/dry-run only.
 */

export interface ServerOptions extends ServiceOptions {
  /** Port to listen on. 0 picks a free port (useful for tests). Default 7878. */
  port?: number;
  /** Host/interface to bind. Default 127.0.0.1 (loopback only — never 0.0.0.0). */
  host?: string;
  /** Directory of built UI assets to serve at `/`. Omit for an API-only server. */
  staticDir?: string;
  /** Allow cross-origin loopback browser requests (dev). Default false. */
  cors?: boolean;
  /**
   * Bearer secret required by every non-health API route. When omitted, the
   * server generates an in-memory 256-bit secret and injects it only into the
   * no-store terminal boot document. API-only callers should provide a stable
   * value with IDEL_SERVER_AUTH_TOKEN through the CLI host.
   */
  authToken?: string;
  /** Disable the API bearer boundary only for tightly scoped tests. Default true. */
  authRequired?: boolean;
  /** Enable raw native shell sessions and native API passthrough. Default false. */
  allowNativeTerminal?: boolean;
  /**
   * Legacy native bearer option. Prefer `authToken`, which protects the whole
   * API. Retained for compatibility with older hosts.
   */
  nativeTerminalAuthToken?: string;
  /** Exact native shell executables clients may request. Defaults to the host shell only. */
  allowedNativeShells?: readonly string[];
  /**
   * Factory for the embedded AI agent, given the server's TerminalService.
   * Injected (not imported) so the dependency-free server core never pulls in
   * `@anthropic-ai/sdk`; the host (`idel serve`) wires it. When omitted,
   * `POST /api/agent/stream` returns 501 and the rest of the API is unchanged.
   */
  agent?: (service: TerminalService) => AgentRunner;
  /**
   * Optional selectable provider catalog. Each factory is built once at server
   * startup; requests may select one configured id without ever receiving its
   * credential. `default` is used when a request omits `provider`.
   */
  agents?: {
    default: string;
    providers: Record<string, (service: TerminalService) => AgentRunner>;
  };
  /**
   * Authenticated, in-memory provider configuration supplied by the host UI.
   * The server validates the request but never persists or returns the key.
   */
  configureAgentProvider?: AgentProviderConfigurator;
  /**
   * Optional host-provided CLI learning surface. The server does not import the
   * agent package directly; `idel serve` injects this when available.
   */
  learn?: LearnRunner;
}

/**
 * The minimal agent surface the server drives — structurally satisfied by
 * `@openexecution/agent`'s `IdelAgent`, but typed here so the server has no
 * compile-time dependency on it.
 *
 * `ask` optionally takes an `approve` gate. When supplied, the agent calls it
 * before promoting a (non-blocked) command from a dry run to a REAL run, and
 * only executes for real if it resolves true. The server passes a gate that
 * round-trips to the browser (emit `needs_approval`, await the client's
 * `POST /api/agent/approve`), so the hosted console can run for real with an
 * explicit human confirmation — never silently. When `approve` is omitted the
 * agent stays propose/dry-run only.
 */
export interface AgentRunner {
  ask(intent: string, approve?: AgentApprovalGate): AsyncIterable<unknown>;
}

export interface AgentProviderConfiguration {
  provider: string;
  apiKey: string;
}

export type AgentProviderConfigurator = (
  request: AgentProviderConfiguration,
  service: TerminalService,
) => AgentRunner | Promise<AgentRunner>;

/** Resolves true to allow a real (non-dry-run) execution of `command`. */
export type AgentApprovalGate = (info: {
  command: string;
  outcome: unknown;
}) => Promise<boolean>;

export interface LearnRequest {
  cli?: string;
  write?: boolean;
}

export type LearnRunner = (req: LearnRequest) => Promise<unknown>;

const VERSION = "1.1.0";
const DEFAULT_PORT = 7878;
const MAX_BODY_BYTES = 1_000_000; // 1MB — command lines are tiny; cap abuse.
const ASK_AI_USAGE = 'ask.ai prompt="what you want to do"';
const AGENT_UNAVAILABLE =
  "Ask AI is not configured on this server (configure Claude Code, ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)";

export interface RunningServer {
  url: string;
  port: number;
  /** Host-side bearer value. Never exposed by an HTTP endpoint or printed. */
  authToken?: string;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  if (!isLoopbackBindHost(host)) {
    throw new ServiceError(
      `refusing to bind non-loopback host "${host}"; IDEL serve is local-only`,
      403,
    );
  }
  const authRequired = opts.authRequired ?? true;
  const apiAuthToken = authRequired
    ? validateAuthToken(
        opts.authToken ??
          opts.nativeTerminalAuthToken ??
          randomBytes(32).toString("base64url"),
        "server",
      )
    : undefined;
  const nativeEnabled = opts.allowNativeTerminal === true && opts.noNative !== true;
  const nativeTerminalAuthToken = nativeEnabled
    ? apiAuthToken ?? validateAuthToken(opts.nativeTerminalAuthToken, "native terminal")
    : undefined;
  const service = new TerminalService({ ...opts, noNative: !nativeEnabled });
  const cors = opts.cors ?? false;
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;
  // Build configured agents once. Provider credentials remain in these host-side
  // instances and are never serialized into health or agent responses.
  const agents = new Map<string, AgentRunner>();
  for (const [id, factory] of Object.entries(opts.agents?.providers ?? {})) {
    agents.set(id, factory(service));
  }
  let agentProvider = opts.agents?.default && agents.has(opts.agents.default)
    ? opts.agents.default
    : agents.keys().next().value as string | undefined;
  let agent = agentProvider ? agents.get(agentProvider) : opts.agent?.(service);
  const configureAgentProvider = opts.configureAgentProvider
    ? async (request: AgentProviderConfiguration): Promise<void> => {
        const configured = await opts.configureAgentProvider!(request, service);
        agents.set(request.provider, configured);
        agentProvider = request.provider;
        agent = configured;
      }
    : undefined;
  const learn = opts.learn;
  const nativeTerminals = new NativeTerminalManager({
    cwd: opts.cwd,
    disabled: !nativeEnabled,
    allowedShells: opts.allowedNativeShells,
  });
  // Coordinates the async approval round-trip: an agent stream that proposes a
  // real run parks here on an id; POST /api/agent/approve resolves it.
  const approvals = new PendingApprovals();
  const runApprovals = new PendingRunApprovals();

  const httpServer = createServer((req, res) => {
    handle(req, res, service, {
      cors,
      staticDir,
      agent,
      agents,
      agentProvider,
      configureAgentProvider,
      learn,
      approvals,
      runApprovals,
      nativeTerminals,
      apiAuthToken,
      nativeTerminalAuthToken,
    }).catch((err) => {
      // A ServiceError carries the intended HTTP status (e.g. 413 for an
      // oversized body thrown while reading the request stream); honor it here
      // so transport-level failures don't all collapse to 500.
      const status = err instanceof ServiceError ? err.status : 500;
      // An unexpected (non-ServiceError) failure is a real bug, not a client
      // error — surface it to the operator's stderr instead of letting it vanish
      // into an opaque 500 the user can't diagnose. ServiceErrors are expected
      // control flow and stay quiet.
      if (!(err instanceof ServiceError)) {
        process.stderr.write(
          `idel serve: unhandled error on ${req.method} ${req.url}: ` +
            `${(err as Error)?.stack ?? String(err)}\n`,
        );
      }
      // The response may already be partially written (e.g. an SSE stream that
      // failed mid-flight set its headers). Guard against a double-write throw.
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: String((err as Error)?.message ?? err) }, cors);
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? DEFAULT_PORT, host, () => {
      httpServer.removeListener("error", reject);
      resolveListen();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;

  return {
    url,
    port: addr.port,
    ...(apiAuthToken ? { authToken: apiAuthToken } : {}),
    close: () => {
      // Release any parked approvals (deny) so suspended agent loops unwind
      // instead of keeping handles open across shutdown.
      approvals.cancelAll();
      runApprovals.cancelAll();
      nativeTerminals.closeAll();
      return new Promise<void>((resolveClose, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolveClose())),
      );
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: TerminalService,
  cfg: {
    cors: boolean;
    staticDir: string | undefined;
    agent: AgentRunner | undefined;
    agents: Map<string, AgentRunner>;
    agentProvider: string | undefined;
    configureAgentProvider: ((request: AgentProviderConfiguration) => Promise<void>) | undefined;
    learn: LearnRunner | undefined;
    approvals: PendingApprovals;
    runApprovals: PendingRunApprovals;
    nativeTerminals: NativeTerminalManager;
    apiAuthToken: string | undefined;
    nativeTerminalAuthToken: string | undefined;
  },
): Promise<void> {
  const {
    cors,
    staticDir,
    agent,
    agents,
    agentProvider,
    configureAgentProvider,
    learn,
    approvals,
    runApprovals,
    nativeTerminals,
    apiAuthToken,
    nativeTerminalAuthToken,
  } = cfg;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const boundary = validateRequestBoundary(req, cors);
  if (!boundary.ok) {
    return sendJson(res, 403, { error: boundary.error }, false);
  }
  if (cors && boundary.origin) setCors(res, boundary.origin);

  // Health remains available for local discovery. Every other API route uses
  // the same per-server bearer, including editor, learning, approvals, logs,
  // and native PTYs. Loopback is a network boundary, not authentication.
  if (
    apiAuthToken &&
    method !== "OPTIONS" &&
    path.startsWith("/api/") &&
    path !== "/api/health" &&
    !hasBearerAuthorization(req, apiAuthToken)
  ) {
    res.setHeader("www-authenticate", 'Bearer realm="idel-server"');
    return sendJson(res, 401, { error: "IDEL server authorization required" }, false);
  }

  // Native PTYs intentionally bypass IDEL parsing and command-level policy.
  // Enabling the feature therefore also requires a separate bearer boundary;
  // loopback binding and Host/Origin validation are defense in depth, not auth.
  if (nativeTerminals.available && method !== "OPTIONS" && isNativeApiPath(path)) {
    if (!hasBearerAuthorization(req, nativeTerminalAuthToken)) {
      res.setHeader("www-authenticate", 'Bearer realm="idel-native-terminal"');
      return sendJson(res, 401, { error: "native terminal authorization required" }, false);
    }
  }

  // Preflight.
  if (method === "OPTIONS") {
    if (cors) setCors(res, boundary.origin);
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API routes ---------------------------------------------------------
  if (path === "/api/health") {
    return sendJson(
      res,
      200,
      {
        ok: true,
        version: VERSION,
        platform: platform(),
        agentAvailable: Boolean(agent),
        agentProvider,
        agentProviders: [...agents.keys()],
        nativeAvailable: nativeTerminals.available,
      },
      cors,
    );
  }

  if (path === "/api/registry" && method === "GET") {
    return sendJson(res, 200, service.registry(), cors);
  }

  if (path.startsWith("/api/registry/") && method === "GET") {
    let id: string;
    try {
      id = decodeURIComponent(path.slice("/api/registry/".length));
    } catch {
      return sendJson(res, 400, { error: "invalid encoded registry id" }, cors);
    }
    // Validate the shape up front (defense in depth) rather than relying on the
    // registry to reject it downstream: a command id is dotted lowercase, never
    // a path. Anything else is a 400, not a registry miss.
    if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/.test(id)) {
      return sendJson(res, 400, { error: `invalid command id: ${id}` }, cors);
    }
    return sendJson(res, 200, service.explain(id), cors);
  }

  if (path === "/api/complete" && method === "POST") {
    const body = await readJsonBody<CompleteRequest>(req);
    return sendJson(res, 200, service.complete(body), cors);
  }

  if (path === "/api/preview" && method === "POST") {
    const untrusted = await readJsonBody<PreviewRequest>(req);
    const body = publicPreviewRequest(untrusted);
    try {
      return sendJson(res, 200, await service.preview(body), cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/run" && method === "POST") {
    const untrusted = await readJsonBody<RunRequest>(req);
    const body = publicRunRequest(untrusted);
    const commands = service.batchCommands(body.command ?? "");
    if (commands.length > 1) {
      const result = await service.runBatch(body);
      const outcomes = result.outcomes.map((outcome, index) =>
        bindRunApproval(outcome, { ...body, command: commands[index]! }, runApprovals),
      );
      return sendJson(res, 200, { ...result, outcomes }, cors);
    }
    const ask = parseAskAiRunCommand(body.command ?? "");
    if (ask.isAskAi) {
      if (!ask.intent) {
        return sendJson(res, 400, { error: `Usage: ${ASK_AI_USAGE}` }, cors);
      }
      if (!agent) {
        return sendJson(res, 501, { error: AGENT_UNAVAILABLE }, cors);
      }
      return sendJson(
        res,
        409,
        { error: "ask.ai streams agent events; use POST /api/agent/stream or /api/run/stream" },
        cors,
      );
    }
    try {
      const outcome = await service.run(body);
      return sendJson(res, 200, bindRunApproval(outcome, body, runApprovals), cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/run/stream" && method === "POST") {
    const untrusted = await readJsonBody<RunRequest>(req);
    const body = publicRunRequest(untrusted);
    const commands = service.batchCommands(body.command ?? "");
    if (commands.length > 1) {
      return runBatchStream(res, service, body, commands, cors, runApprovals);
    }
    const ask = parseAskAiRunCommand(body.command ?? "");
    if (ask.isAskAi) {
      return runAskAiStream(res, agent, ask.intent, cors, approvals);
    }
    return runStream(res, service, body, cors, runApprovals);
  }

  // A direct execution approval is an opaque, single-use capability bound to
  // the exact server-derived request that produced the approval_required
  // outcome. Clients cannot change the command, cwd, origin, or approval bit.
  if (path === "/api/run/approve" && method === "POST") {
    const body = await readJsonBody<{ approvalId?: string; approve?: boolean }>(req);
    const approved = runApprovals.consume(body.approvalId ?? "");
    if (!approved) {
      return sendJson(res, 404, { error: "no pending run approval with that id" }, cors);
    }
    try {
      const outcome = await service.run({ ...approved, approve: body.approve === true });
      return sendJson(res, 200, outcome, cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/learn" && method === "POST") {
    if (!learn) {
      return sendJson(res, 501, { error: "learn is not configured on this server" }, cors);
    }
    const body = await readJsonBody<LearnRequest>(req);
    try {
      return sendJson(res, 200, await learn(body), cors);
    } catch (err) {
      return sendJson(res, 400, { error: String((err as Error)?.message ?? err) }, cors);
    }
  }

  if (path === "/api/editor/open" && method === "POST") {
    const body = await readJsonBody<{ file?: string; cwd?: string }>(req);
    try {
      return sendJson(res, 200, await service.openEditor(body), cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/editor/save" && method === "POST") {
    const body = await readJsonBody<{ file?: string; content?: string; cwd?: string }>(req);
    try {
      return sendJson(res, 200, await service.saveEditor(body), cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/agent/stream" && method === "POST") {
    const body = await readJsonBody<{ intent?: string; allowReal?: boolean; provider?: string }>(req);
    const requestedProvider = body.provider?.trim();
    const selectedAgent = requestedProvider ? agents.get(requestedProvider) : agent;
    if (!selectedAgent) {
      if (requestedProvider && agents.size > 0) {
        return sendJson(res, 400, { error: `AI provider is not configured: ${requestedProvider}` }, cors);
      }
      return sendJson(res, 501, { error: AGENT_UNAVAILABLE }, cors);
    }
    return agentStream(res, selectedAgent, body.intent ?? "", cors, body.allowReal ?? false, approvals);
  }

  if (path === "/api/agent/configure" && method === "POST") {
    if (!configureAgentProvider) {
      return sendJson(res, 501, { error: "AI provider configuration is not available on this server" }, cors);
    }
    const body = await readJsonBody<{ provider?: unknown; apiKey?: unknown }>(req);
    const request = validateAgentProviderConfiguration(body);
    try {
      await configureAgentProvider(request);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
    return sendJson(res, 200, {
      ok: true,
      agentAvailable: true,
      agentProvider: request.provider,
      agentProviders: [...agents.keys()],
    }, cors);
  }

  // Resolve a pending real-run approval the agent stream is parked on. The
  // browser POSTs { approvalId, approve } after the user confirms (or declines)
  // the dry-run shown in the needs_approval SSE event. Idempotent-ish: an
  // unknown/expired id is a 404 (the stream already moved on or timed out).
  if (path === "/api/agent/approve" && method === "POST") {
    const body = await readJsonBody<{ approvalId?: string; approve?: boolean }>(req);
    const ok = approvals.resolve(body.approvalId ?? "", body.approve === true);
    if (!ok) {
      return sendJson(res, 404, { error: "no pending approval with that id" }, cors);
    }
    return sendJson(res, 200, { ok: true }, cors);
  }

  if (path === "/api/native/sessions" && method === "GET") {
    return sendJson(res, 200, nativeTerminals.list(), cors);
  }

  if (path === "/api/native/start" && method === "POST") {
    try {
      const body = await readJsonBody<{ cwd?: string; shell?: string }>(req);
      const info = nativeTerminals.start(body);
      void service.auditNativeTerminal("native.terminal.start", nativeTerminalParams(info));
      const session = nativeTerminals.get(info.id);
      session?.subscribe((event) => {
        if (event.type !== "exit") return;
        const exitCode = event.code ?? undefined;
        void service.auditNativeTerminal(
          "native.terminal.exit",
          nativeTerminalParams(info, {
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(event.signal ? { signal: event.signal } : {}),
          }),
          {
            result: event.code === 0 ? "success" : "failed",
            ...(exitCode !== undefined ? { exitCode } : {}),
          },
        );
      });
      return sendJson(res, 200, info, cors);
    } catch (err) {
      if (err instanceof NativeTerminalError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  const nativeRoute = parseNativeRoute(path);
  if (nativeRoute) {
    if (nativeRoute.action === "stream" && method === "GET") {
      return nativeTerminalStream(req, res, nativeTerminals, nativeRoute.id, cors);
    }
    if (nativeRoute.action === "input" && method === "POST") {
      const body = await readJsonBody<{ data?: string }>(req);
      const ok = nativeTerminals.write(nativeRoute.id, String(body.data ?? ""));
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "native session not found" }, cors);
    }
    if (nativeRoute.action === "resize" && method === "POST") {
      const body = await readJsonBody<{ cols?: number; rows?: number }>(req);
      const size = parseTerminalResizeBody(body);
      if (!size) {
        return sendJson(res, 400, { error: "resize requires integer cols>=2 and rows>=1" }, cors);
      }
      const ok = nativeTerminals.resize(nativeRoute.id, size.cols, size.rows);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "native session not found" }, cors);
    }
    if (nativeRoute.action === "signal" && method === "POST") {
      const body = await readJsonBody<{ signal?: string }>(req);
      const signal = parseNativeSignal(body.signal);
      if (!signal) {
        return sendJson(res, 400, { error: "signal must be one of interrupt, terminate, kill, hangup" }, cors);
      }
      const info = nativeTerminals.get(nativeRoute.id)?.info();
      const ok = nativeTerminals.signal(nativeRoute.id, signal);
      void service.auditNativeTerminal(
        "native.terminal.signal",
        nativeTerminalParams(info, { id: nativeRoute.id, signal }),
        { result: ok ? "success" : "failed" },
      );
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "native session not found" }, cors);
    }
    if (nativeRoute.action === "close" && method === "POST") {
      const info = nativeTerminals.get(nativeRoute.id)?.info();
      const ok = nativeTerminals.close(nativeRoute.id);
      void service.auditNativeTerminal(
        "native.terminal.close",
        nativeTerminalParams(info, { id: nativeRoute.id }),
        { result: ok ? "success" : "failed" },
      );
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "native session not found" }, cors);
    }
  }

  if (path === "/api/logs" && method === "GET") {
    const limit = clampLimit(url.searchParams.get("limit"));
    return sendJson(res, 200, await service.logs(limit), cors);
  }

  if (path === "/api/logs/verify" && method === "GET") {
    return sendJson(res, 200, await service.verifyLogs(), cors);
  }

  // --- Static UI (optional) ----------------------------------------------
  if (staticDir && method === "GET") {
    const served = await serveStatic(res, staticDir, path, cors, apiAuthToken);
    if (served) return;
  }

  sendJson(res, 404, { error: `not found: ${method} ${path}` }, cors);
}

/** Run a command and stream the outcome as server-sent events. */
async function runStream(
  res: ServerResponse,
  service: TerminalService,
  body: RunRequest,
  cors: boolean,
  approvals: PendingRunApprovals,
): Promise<void> {
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  try {
    const outcome = await service.run(body);
    writeSse(res, "outcome", bindRunApproval(outcome, body, approvals));
  } catch (err) {
    const status = err instanceof ServiceError ? err.status : 500;
    writeSse(res, "error", { error: String((err as Error).message), status });
  } finally {
    writeSse(res, "done", {});
    res.end();
  }
}

/** Run a top-level `&&` batch and stream each child outcome as it completes. */
async function runBatchStream(
  res: ServerResponse,
  service: TerminalService,
  body: RunRequest,
  commands: string[],
  cors: boolean,
  approvals: PendingRunApprovals,
): Promise<void> {
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeSse(res, "batch_start", { commands });
  try {
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i]!;
      writeSse(res, "batch_step", { index: i + 1, total: commands.length, command });
      const outcome = await service.run({ ...body, command, native: false });
      writeSse(
        res,
        "outcome",
        bindRunApproval(outcome, { ...body, command, native: false }, approvals),
      );
      if (!batchStepSucceeded(outcome, body.dryRun === true)) {
        writeSse(res, "batch_stop", {
          index: i + 1,
          total: commands.length,
          command,
          result: outcome.record.result,
        });
        break;
      }
    }
  } catch (err) {
    const status = err instanceof ServiceError ? err.status : 500;
    writeSse(res, "error", { error: String((err as Error).message), status });
  } finally {
    writeSse(res, "done", {});
    res.end();
  }
}

/** Reroute `ask.ai ...` lines that arrive through the generic run stream. */
function runAskAiStream(
  res: ServerResponse,
  agent: AgentRunner | undefined,
  intent: string,
  cors: boolean,
  approvals: PendingApprovals,
): Promise<void> | void {
  if (!intent.trim()) {
    return writeSseError(res, cors, `Usage: ${ASK_AI_USAGE}`, 400);
  }
  if (!agent) {
    return writeSseError(res, cors, AGENT_UNAVAILABLE, 501);
  }
  return agentStream(res, agent, intent, cors, true, approvals);
}

function writeSseError(res: ServerResponse, cors: boolean, error: string, status: number): void {
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, "error", { error, status });
  writeSse(res, "done", {});
  res.end();
}

/**
 * Drive the embedded agent and stream its events as SSE. Each AgentEvent becomes
 * one named SSE event (`event: <event.type>`), then a final `event: done`. The
 * browser/desktop terminal consumes this with the same EventSource contract as
 * /api/run/stream. The Anthropic call happens server-side — the key never
 * reaches the client.
 *
 * Real-run approval: when `allowReal` is set, the agent is given a gate that
 * round-trips to the browser. Before a (non-blocked) command is promoted from
 * dry-run to a REAL run, the gate emits an `approval_request` SSE event carrying
 * an `approvalId` + the dry-run outcome, then PARKS on {@link PendingApprovals}
 * (on THIS connection — the loop is suspended) until the client POSTs
 * `/api/agent/approve { approvalId, approve }`. The agent only touches disk on an
 * explicit human yes. Without `allowReal`, no gate is passed and the agent stays
 * propose/dry-run only — identical to the prior behavior.
 */
async function agentStream(
  res: ServerResponse,
  agent: AgentRunner,
  intent: string,
  cors: boolean,
  allowReal: boolean,
  approvals: PendingApprovals,
): Promise<void> {
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (!intent.trim()) {
    writeSse(res, "error", { error: "empty intent" });
    writeSse(res, "done", {});
    res.end();
    return;
  }

  // The gate the agent calls before a real run (only wired when allowReal).
  // Track this stream's own outstanding approval id so a disconnect denies only
  // THIS stream's pending approval, never another concurrent stream's.
  let outstandingId: string | undefined;
  const gate: AgentApprovalGate = async ({ command, outcome }) => {
    const { id, decision } = approvals.create();
    outstandingId = id;
    writeSse(res, "approval_request", { approvalId: id, command, outcome });
    // Suspend the agent loop here until the client resolves this id (or it is
    // cancelled when the connection drops). Default-deny on cancellation.
    try {
      return await decision;
    } finally {
      outstandingId = undefined;
    }
  };

  // If the client disconnects mid-park, release only this stream's pending
  // approval as a deny so its agent resumes (the dry-run result stands) instead
  // of hanging — without disturbing other concurrent agent streams.
  const onClose = () => {
    if (outstandingId) approvals.resolve(outstandingId, false);
  };
  res.on("close", onClose);

  try {
    for await (const ev of agent.ask(intent, allowReal ? gate : undefined)) {
      const type = (ev as { type?: string }).type ?? "message";
      writeSse(res, type, ev);
    }
  } catch (err) {
    writeSse(res, "error", { error: String((err as Error)?.message ?? err) });
  } finally {
    res.off("close", onClose);
    writeSse(res, "done", {});
    res.end();
  }
}

function parseNativeRoute(
  path: string,
): { id: string; action: "stream" | "input" | "resize" | "signal" | "close" } | undefined {
  const match = /^\/api\/native\/([^/]+)\/(stream|input|resize|signal|close)$/.exec(path);
  if (!match) return undefined;
  return {
    id: decodeURIComponent(match[1]!),
    action: match[2] as "stream" | "input" | "resize" | "signal" | "close",
  };
}

function parseTerminalResizeBody(body: { cols?: number; rows?: number }): { cols: number; rows: number } | undefined {
  const cols = Number(body.cols);
  const rows = Number(body.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return undefined;
  return { cols: Math.min(cols, 1000), rows: Math.min(rows, 1000) };
}

function parseNativeSignal(value: unknown): NativeTerminalSignal | undefined {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "interrupt":
    case "ctrl-c":
    case "ctrlc":
    case "sigint":
    case "int":
      return "interrupt";
    case "terminate":
    case "term":
    case "sigterm":
      return "terminate";
    case "kill":
    case "sigkill":
      return "kill";
    case "hangup":
    case "hup":
    case "sighup":
      return "hangup";
    default:
      return undefined;
  }
}

function nativeTerminalStream(
  req: IncomingMessage,
  res: ServerResponse,
  nativeTerminals: NativeTerminalManager,
  id: string,
  cors: boolean,
): void {
  const session = nativeTerminals.get(id);
  if (!session) {
    sendJson(res, 404, { error: "native session not found" }, cors);
    return;
  }
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, "ready", session.info());

  let ended = false;
  let unsubscribe: () => void = () => {};
  const end = () => {
    if (ended) return;
    ended = true;
    unsubscribe();
    writeSse(res, "done", {});
    res.end();
  };
  unsubscribe = session.subscribe((event) => {
    if (ended) return;
    if (event.type === "data") {
      writeSse(res, "data", { data: event.data });
      return;
    }
    writeSse(res, "exit", { code: event.code, signal: event.signal });
    end();
  });
  req.on("close", () => {
    if (!ended) unsubscribe();
  });
}

function parseAskAiRunCommand(command: string): { isAskAi: boolean; intent: string } {
  const tokens = tokenizeIdelCommand(command.trim());
  if (tokens[0] !== "ask.ai") return { isAskAi: false, intent: "" };

  const rest = tokens.slice(1);
  const promptKeys = new Set(["prompt", "question", "intent", "message", "text"]);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if (!promptKeys.has(key)) continue;
    const words = [token.slice(eq + 1)];
    for (let j = i + 1; j < rest.length; j++) {
      const next = rest[j]!;
      if (isParamToken(next)) break;
      words.push(next);
    }
    return { isAskAi: true, intent: words.join(" ").trim() };
  }

  return {
    isAskAi: true,
    intent: rest.filter((token) => !isParamToken(token)).join(" ").trim(),
  };
}

function isParamToken(token: string): boolean {
  return /^[a-z][a-zA-Z0-9]*=/.test(token);
}

function tokenizeIdelCommand(value: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i]!)) i++;
    if (i >= value.length) break;

    let token = "";
    while (i < value.length && !/\s/.test(value[i]!)) {
      const ch = value[i]!;
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < value.length) {
          const quoted = value[i]!;
          if (quoted === "\\") {
            if (i + 1 < value.length) token += value[i + 1]!;
            i += 2;
            continue;
          }
          if (quoted === quote) {
            i++;
            break;
          }
          token += quoted;
          i++;
        }
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < value.length) token += value[i + 1]!;
        i += 2;
        continue;
      }
      token += ch;
      i++;
    }
    tokens.push(token);
  }

  return tokens;
}

/**
 * Coordinates the async approval round-trip between an agent SSE stream (which
 * parks on a promise) and the `/api/agent/approve` route (which resolves it).
 *
 * Kept deliberately tiny and per-server: at most a handful of approvals are ever
 * outstanding (one per active agent stream that hit a real run). Each gets an id;
 * `resolve(id, approved)` settles its promise; `create()` also arms a timeout so
 * a forgotten approval defaults to DENY rather than leaking a parked agent loop.
 */
class PendingApprovals {
  private readonly pending = new Map<string, (approved: boolean) => void>();
  /** How long a parked approval waits before auto-denying. */
  private static readonly TIMEOUT_MS = 5 * 60_000;

  /** Mint an approval id and the promise the agent gate awaits. */
  create(): { id: string; decision: Promise<boolean> } {
    const id = `appr_${randomUUID()}`;
    const decision = new Promise<boolean>((resolveDecision) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolveDecision(false); // fail-closed
      }, PendingApprovals.TIMEOUT_MS);
      // Unref so a pending approval never keeps the process alive on its own.
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, (approved: boolean) => {
        clearTimeout(timer);
        resolveDecision(approved);
      });
    });
    return { id, decision };
  }

  /** Settle a pending approval. Returns false if the id is unknown/expired. */
  resolve(id: string, approved: boolean): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    this.pending.delete(id);
    settle(approved);
    return true;
  }

  /** Deny every outstanding approval (e.g. on client disconnect / shutdown). */
  cancelAll(): void {
    for (const [id, settle] of this.pending) {
      this.pending.delete(id);
      settle(false);
    }
  }
}

/**
 * Single-use capabilities for direct (non-agent) policy approvals. Keeping the
 * original request server-side prevents a client from previewing one command
 * and approving another, or from forging `origin` / `approve` fields.
 */
class PendingRunApprovals {
  private readonly pending = new Map<string, { request: RunRequest; expiresAt: number }>();
  private static readonly TIMEOUT_MS = 5 * 60_000;

  create(request: RunRequest): string {
    this.prune();
    if (this.pending.size >= 256) {
      const oldest = this.pending.keys().next().value;
      if (typeof oldest === "string") this.pending.delete(oldest);
    }
    const id = `run_appr_${randomUUID()}`;
    this.pending.set(id, {
      request: {
        command: request.command,
        native: false,
        dryRun: request.dryRun === true,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        origin: "api",
      },
      expiresAt: Date.now() + PendingRunApprovals.TIMEOUT_MS,
    });
    return id;
  }

  consume(id: string): RunRequest | undefined {
    const item = this.pending.get(id);
    this.pending.delete(id);
    if (!item || item.expiresAt <= Date.now()) return undefined;
    return item.request;
  }

  cancelAll(): void {
    this.pending.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(id);
    }
  }
}

function publicRunRequest(body: RunRequest): RunRequest {
  return {
    command: typeof body.command === "string" ? body.command : "",
    native: false,
    dryRun: body.dryRun === true,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    origin: "api",
  };
}

function publicPreviewRequest(body: PreviewRequest): PreviewRequest {
  return {
    command: typeof body.command === "string" ? body.command : "",
    native: false,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    origin: "api",
  };
}

function bindRunApproval(
  outcome: RuntimeOutcome,
  request: RunRequest,
  approvals: PendingRunApprovals,
): RuntimeOutcome & { approvalId?: string } {
  if (outcome.record.result !== "approval_required") return outcome;
  return { ...outcome, approvalId: approvals.create(request) };
}

// --- helpers ---------------------------------------------------------------

function validateRequestBoundary(
  req: IncomingMessage,
  allowCrossOrigin: boolean,
): { ok: true; origin?: string } | { ok: false; error: string } {
  const host = req.headers.host;
  if (host && !isLoopbackHostHeader(host)) {
    return { ok: false, error: `host is not allowed: ${host}` };
  }

  const origin = req.headers.origin;
  if (origin === undefined) return { ok: true };
  const allowedOrigin = normalizeAllowedOrigin(origin);
  if (!allowedOrigin) {
    return { ok: false, error: `origin is not allowed: ${origin}` };
  }
  if (!sameOriginHost(origin, host) && !allowCrossOrigin) {
    return { ok: false, error: `cross-origin request is not allowed: ${origin}` };
  }
  return { ok: true, origin: allowedOrigin };
}

function sameOriginHost(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

function normalizeAllowedOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname)) {
      return url.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isLoopbackBindHost(host: string): boolean {
  const value = stripIpv6Brackets(host.trim().toLowerCase());
  return value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1";
}

function isLoopbackHostHeader(hostHeader: string): boolean {
  const host = stripHostPort(hostHeader);
  return host !== undefined && isLoopbackHost(host);
}

function isLoopbackHost(host: string): boolean {
  const value = stripIpv6Brackets(host.trim().toLowerCase());
  if (value === "localhost" || value === "::1") return true;
  return isIP(value) === 4 && value.split(".", 1)[0] === "127";
}

function stripHostPort(hostHeader: string): string | undefined {
  const value = hostHeader.trim();
  if (!value || /[\s/@\\]/.test(value)) return undefined;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value);
    if (!match || !validOptionalPort(match[2])) return undefined;
    return match[1];
  }
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    const host = value.slice(0, firstColon);
    const port = value.slice(firstColon + 1);
    return host && validOptionalPort(port) ? host : undefined;
  }
  // An unbracketed IPv6 address is accepted only without an appended port.
  if (firstColon !== -1 && isIP(value) !== 6) return undefined;
  return value;
}

function validOptionalPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  if (!/^[0-9]{1,5}$/.test(port)) return false;
  const value = Number(port);
  return value >= 1 && value <= 65_535;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function validateAuthToken(token: string | undefined, boundary: string): string {
  if (!token || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ServiceError(
      `${boundary} authorization requires a 32-256 character base64url secret`,
      400,
    );
  }
  return token;
}

function validateAgentProviderConfiguration(
  body: { provider?: unknown; apiKey?: unknown },
): AgentProviderConfiguration {
  const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) {
    throw new ServiceError("invalid AI provider", 400);
  }
  if (apiKey.length < 8 || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new ServiceError("API key must be 8-4096 printable characters", 400);
  }
  return { provider, apiKey };
}

function isNativeApiPath(path: string): boolean {
  return path === "/api/native" || path.startsWith("/api/native/");
}

function hasBearerAuthorization(
  req: IncomingMessage,
  expected: string | undefined,
): boolean {
  if (!expected) return false;
  const header = req.headers.authorization;
  return typeof header === "string" &&
    header.startsWith("Bearer ") &&
    constantTimeTextEqual(header.slice("Bearer ".length), expected);
}

function constantTimeTextEqual(supplied: string, expected: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function nativeTerminalParams(
  info: NativeTerminalInfo | undefined,
  extra: Record<string, ParamValue> = {},
): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = { ...extra };
  if (!info) return params;
  params["id"] = info.id;
  params["cwd"] = info.cwd;
  params["shell"] = info.shell;
  params["pty"] = info.pty;
  params["cols"] = info.cols;
  params["rows"] = info.rows;
  params["startedAt"] = info.startedAt;
  params["exited"] = info.exited;
  if (info.pid !== undefined) params["pid"] = info.pid;
  if (typeof info.exitCode === "number") params["exitCode"] = info.exitCode;
  return params;
}

function clampLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new ServiceError("request body too large", 413);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ServiceError("invalid JSON body", 400);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  cors: boolean,
): void {
  if (cors) setCors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCors(res: ServerResponse, origin?: string): void {
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a static file from `dir`, defending against path traversal. Returns true
 * if a response was sent. Falls back to index.html for SPA routes (no extension).
 */
async function serveStatic(
  res: ServerResponse,
  dir: string,
  urlPath: string,
  cors: boolean,
  apiAuthToken?: string,
): Promise<boolean> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Resolve and confirm the target stays inside `dir` (traversal guard).
  const target = normalize(join(dir, rel));
  if (target !== dir && !target.startsWith(dir + sep)) {
    return false;
  }

  let filePath = target;
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    // SPA fallback: a path with no file extension serves index.html so the
    // client router can handle it. Anything with an extension is a real 404.
    if (extname(rel)) return false;
    filePath = join(dir, "index.html");
  }

  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    return false;
  }
  const isHtml = extname(filePath) === ".html";
  const hasAuthBootstrap = isHtml &&
    (data.includes(API_BOOTSTRAP_MARKER) || data.includes(LEGACY_NATIVE_BOOTSTRAP_MARKER));
  if (hasAuthBootstrap) {
    const rendered = data.toString("utf8")
      .replaceAll(API_BOOTSTRAP_MARKER, escapeHtmlAttribute(apiAuthToken ?? ""))
      .replaceAll(LEGACY_NATIVE_BOOTSTRAP_MARKER, escapeHtmlAttribute(apiAuthToken ?? ""));
    data = Buffer.from(rendered, "utf8");
  }
  // A boot document carrying the in-memory API bearer is never CORS-readable
  // and never cacheable. Same-origin navigation remains unaffected.
  if (hasAuthBootstrap) {
    res.removeHeader("access-control-allow-origin");
    res.removeHeader("access-control-allow-credentials");
  } else if (cors) {
    setCors(res);
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "content-length": data.length,
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' http://127.0.0.1:* http://localhost:*",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self' vscode-webview: https://*.vscode-webview.net",
      "form-action 'self'",
    ].join("; "),
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    ...(hasAuthBootstrap
      ? { "cache-control": "no-store", "referrer-policy": "no-referrer" }
      : {}),
  });
  res.end(data);
  return true;
}

const API_BOOTSTRAP_MARKER = "__IDEL_API_AUTH_TOKEN__";
const LEGACY_NATIVE_BOOTSTRAP_MARKER = "__IDEL_NATIVE_TERMINAL_AUTH_TOKEN__";

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
