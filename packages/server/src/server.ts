import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";

import { TerminalService, ServiceError } from "./service.js";
import type {
  RunRequest,
  CompleteRequest,
  ServiceOptions,
} from "./service.js";

/**
 * A dependency-free HTTP server over the {@link TerminalService}. It is the
 * local boundary the web and desktop (Javelle/Electron) terminals talk to.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /api/health                 → { ok, version, agentAvailable }
 *   GET  /api/registry               → RegistryEntry[]
 *   GET  /api/registry/:id           → { resolved, shadowed }
 *   POST /api/complete   {input,cwd} → string[]
 *   POST /api/run        RunRequest  → RuntimeOutcome
 *   GET  /api/logs?limit=N           → OpenLogRecord[]   (redacted by the writer)
 *   GET  /api/logs/verify            → VerifyResult
 *   GET  /  (+ static)               → the bundled UI, when `staticDir` is set
 *
 * Streaming: `POST /api/run/stream` runs the command and emits the same outcome
 * over Server-Sent Events (one `event: outcome`, then `event: done`). SSE is
 * used deliberately — it needs no extra dependency and matches Javelle's own
 * patch-stream contract (`EventSource`), so the desktop/web bridge is uniform.
 *
 * Agent: `POST /api/agent/stream` {intent, allowReal?} — the embedded Claude
 * console. It drives the injected agent, streaming one SSE event per AgentEvent
 * (`text`, `proposed`, `blocked`, `approval_request`, ... then `done`). Each
 * command the agent proposes flows through the same TerminalService.run pipeline
 * (audited as `source: "agent"`). Returns 501 when no agent was wired. The
 * Anthropic key stays server-side; loopback-only bind keeps it off the network.
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
  /** Allow cross-origin browser requests (dev). Default true for loopback dev. */
  cors?: boolean;
  /**
   * Factory for the embedded Claude agent, given the server's TerminalService.
   * Injected (not imported) so the dependency-free server core never pulls in
   * `@anthropic-ai/sdk`; the host (`idel serve`) wires it. When omitted,
   * `POST /api/agent/stream` returns 501 and the rest of the API is unchanged.
   */
  agent?: (service: TerminalService) => AgentRunner;
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

/** Resolves true to allow a real (non-dry-run) execution of `command`. */
export type AgentApprovalGate = (info: {
  command: string;
  outcome: unknown;
}) => Promise<boolean>;

const VERSION = "1.1.0";
const DEFAULT_PORT = 7878;
const MAX_BODY_BYTES = 1_000_000; // 1MB — command lines are tiny; cap abuse.

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const service = new TerminalService(opts);
  const host = opts.host ?? "127.0.0.1";
  const cors = opts.cors ?? true;
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;
  // Build the agent once and share it (its system prompt — the registry catalog
  // — is cached by Anthropic across turns). Undefined when the host didn't wire one.
  const agent = opts.agent ? opts.agent(service) : undefined;
  // Coordinates the async approval round-trip: an agent stream that proposes a
  // real run parks here on an id; POST /api/agent/approve resolves it.
  const approvals = new PendingApprovals();

  const httpServer = createServer((req, res) => {
    handle(req, res, service, { cors, staticDir, agent, approvals }).catch((err) => {
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
    close: () => {
      // Release any parked approvals (deny) so suspended agent loops unwind
      // instead of keeping handles open across shutdown.
      approvals.cancelAll();
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
    approvals: PendingApprovals;
  },
): Promise<void> {
  const { cors, staticDir, agent, approvals } = cfg;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Preflight.
  if (method === "OPTIONS") {
    if (cors) setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API routes ---------------------------------------------------------
  if (path === "/api/health") {
    return sendJson(res, 200, { ok: true, version: VERSION, agentAvailable: Boolean(agent) }, cors);
  }

  if (path === "/api/registry" && method === "GET") {
    return sendJson(res, 200, service.registry(), cors);
  }

  if (path.startsWith("/api/registry/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/api/registry/".length));
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

  if (path === "/api/run" && method === "POST") {
    const body = await readJsonBody<RunRequest>(req);
    try {
      const outcome = await service.run(body);
      return sendJson(res, 200, outcome, cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/run/stream" && method === "POST") {
    const body = await readJsonBody<RunRequest>(req);
    return runStream(res, service, body, cors);
  }

  if (path === "/api/agent/stream" && method === "POST") {
    if (!agent) {
      return sendJson(
        res,
        501,
        {
          error:
            "agent not configured on this server (install Claude Code + run `claude login`, or set ANTHROPIC_API_KEY)",
        },
        cors,
      );
    }
    const body = await readJsonBody<{ intent?: string; allowReal?: boolean }>(req);
    return agentStream(res, agent, body.intent ?? "", cors, body.allowReal ?? false, approvals);
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

  if (path === "/api/logs" && method === "GET") {
    const limit = clampLimit(url.searchParams.get("limit"));
    return sendJson(res, 200, await service.logs(limit), cors);
  }

  if (path === "/api/logs/verify" && method === "GET") {
    return sendJson(res, 200, await service.verifyLogs(), cors);
  }

  // --- Static UI (optional) ----------------------------------------------
  if (staticDir && method === "GET") {
    const served = await serveStatic(res, staticDir, path, cors);
    if (served) return;
  }

  sendJson(res, 404, { error: `not found: ${method} ${path}` }, cors);
}

/** Run a command and stream the outcome as SSE (matches Javelle EventSource). */
async function runStream(
  res: ServerResponse,
  service: TerminalService,
  body: RunRequest,
  cors: boolean,
): Promise<void> {
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  try {
    const outcome = await service.run(body);
    writeSse(res, "outcome", outcome);
  } catch (err) {
    const status = err instanceof ServiceError ? err.status : 500;
    writeSse(res, "error", { error: String((err as Error).message), status });
  } finally {
    writeSse(res, "done", {});
    res.end();
  }
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
  private seq = 0;
  private readonly pending = new Map<string, (approved: boolean) => void>();
  /** How long a parked approval waits before auto-denying. */
  private static readonly TIMEOUT_MS = 5 * 60_000;

  /** Mint an approval id and the promise the agent gate awaits. */
  create(): { id: string; decision: Promise<boolean> } {
    const id = `appr_${++this.seq}`;
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

// --- helpers ---------------------------------------------------------------

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
  });
  res.end(body);
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
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
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "content-length": data.length,
  });
  res.end(data);
  return true;
}
