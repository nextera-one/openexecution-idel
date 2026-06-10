import { hostname, userInfo, platform } from "node:os";

import type { Runtime } from "@openexecution/runtime";
import type {
  CommandDef,
  CommandOrigin,
  OpenLogRecord,
  RuntimeContext,
  RuntimeOutcome,
} from "@openexecution/types";

import { complete } from "./complete.js";

/**
 * Transport-agnostic service layer over the OpenExecution Runtime.
 *
 * The HTTP layer (server.ts) is a thin shell around this. Keeping the logic here
 * means the whole API surface is unit-testable without binding a socket, and a
 * future transport (the Electron in-process host, an agent SDK) can reuse it.
 *
 * Every command still flows through `runtime.run`, so the safety → policy →
 * OpenLogs pipeline is identical to the CLI. The server never re-implements any
 * of that; it only adapts request/response shapes.
 */

export interface ServiceOptions {
  runtime: Runtime;
  /**
   * Base directory the terminal operates in. The web/desktop terminal has no
   * inherited shell cwd, so the server owns one. `path.change` (a meta command)
   * does not mutate this — the front-end passes an explicit cwd per request when
   * it wants to scope completion/execution to a directory.
   */
  cwd?: string;
  /** Logical environment for policy matching, e.g. "production". */
  environment?: string;
  /** Disallow native `!` passthrough (recommended for a hosted/web terminal). */
  noNative?: boolean;
}

/** A run request from a client. Mirrors the CLI's flag surface. */
export interface RunRequest {
  /** The IDEL command line, e.g. `remove.folder name=dist recursive=true`. */
  command: string;
  /** Treat `command` as a native shell line (prefix with `! `). */
  native?: boolean;
  /** Force a dry-run regardless of policy. */
  dryRun?: boolean;
  /** Per-request working directory override. Defaults to the service cwd. */
  cwd?: string;
  /**
   * Resolution for an `approval_required` command. When omitted, an
   * approval_required outcome is returned to the client unexecuted; the client
   * re-submits with `approve: true` to proceed (or `false` to record a refusal).
   */
  approve?: boolean;
  /**
   * Logged command origin. Defaults to the service default (`undefined` →
   * runtime infers idel/ci). The agent layer passes `"agent"` so AI-proposed
   * commands are audited with `source: "agent"`. Risk/policy are unaffected.
   */
  origin?: CommandOrigin;
}

export interface CompleteRequest {
  /** The partial command line being typed. */
  input: string;
  /** Directory to resolve `path=` value completions against. */
  cwd?: string;
}

export interface RegistryEntry {
  id: string;
  summary: string;
  category: string;
  risk: CommandDef["riskDefault"];
  source: CommandDef["source"];
  params: { name: string; type: string; required: boolean; enum?: string[] }[];
}

export class TerminalService {
  private readonly runtime: Runtime;
  private readonly baseCwd: string;
  private readonly environment: string | undefined;
  private readonly noNative: boolean;

  constructor(opts: ServiceOptions) {
    this.runtime = opts.runtime;
    this.baseCwd = opts.cwd ?? process.cwd();
    this.environment = opts.environment;
    this.noNative = opts.noNative ?? false;
  }

  /** Run one command through the full runtime pipeline. */
  async run(req: RunRequest): Promise<RuntimeOutcome> {
    if (req.native && this.noNative) {
      // Mirror the runtime's own noNative stance but fail fast with a clear
      // message rather than letting an unparsed `!` line reach the pipeline.
      throw new ServiceError(
        "native passthrough is disabled on this server",
        403,
      );
    }
    const cwd = req.cwd ?? this.baseCwd;
    const ctx = this.makeContext(cwd, req.dryRun ?? false, req.approve, req.origin);
    const line = req.native ? `! ${req.command}` : req.command;
    return await this.runtime.run(line, ctx);
  }

  /** Registry-driven completion for the current input. */
  complete(req: CompleteRequest): string[] {
    return complete(req.input, this.runtime.reg, req.cwd ?? this.baseCwd);
  }

  /** Full command catalog, shaped for a UI command palette. */
  registry(): RegistryEntry[] {
    return this.runtime.reg.list().map((def) => this.toEntry(def));
  }

  /** Per-command detail: the winning definition plus shadowed layers. */
  explain(commandId: string): {
    resolved: RegistryEntry | null;
    shadowed: { source: string; version: string }[];
  } {
    const view = this.runtime.reg.explain(commandId);
    return {
      resolved: view.resolved ? this.toEntry(view.resolved.def) : null,
      shadowed: view.resolved?.shadowed ?? [],
    };
  }

  /** Recent OpenLogs audit records (already redacted by the writer on read). */
  async logs(limit = 50): Promise<OpenLogRecord[]> {
    const writer = this.runtime.logWriter;
    if (!writer) return [];
    return await writer.read(limit);
  }

  /** Verify the signed OpenLogs chain. */
  async verifyLogs(): Promise<unknown> {
    const writer = this.runtime.logWriter;
    if (!writer) return { ok: true, records: 0, reason: "no log writer" };
    return await writer.verify();
  }

  private makeContext(
    cwd: string,
    dryRun: boolean,
    approve: boolean | undefined,
    origin: CommandOrigin | undefined,
  ): RuntimeContext {
    const ui = safeUserInfo();
    return {
      cwd,
      user: ui.username,
      host: hostname(),
      os: platform(),
      sessionId: origin === "agent" ? `agent_${process.pid}` : `srv_${process.pid}`,
      environment: this.environment,
      // When the client has not yet decided on an approval, run in CI mode so an
      // approval_required command fails closed (is returned, not executed)
      // instead of blocking on a prompt the HTTP layer cannot answer inline.
      ci: approve === undefined ? true : false,
      dryRun,
      noNative: this.noNative,
      origin,
    };
  }

  private toEntry(def: CommandDef): RegistryEntry {
    return {
      id: def.id,
      summary: def.summary,
      category: def.category,
      risk: def.riskDefault,
      source: def.source,
      params: Object.entries(def.params).map(([name, schema]) => ({
        name,
        type: schema.type,
        required: schema.required ?? false,
        ...(schema.enum ? { enum: schema.enum.map(String) } : {}),
      })),
    };
  }
}

/** An error carrying an HTTP status for the transport layer to surface. */
export class ServiceError extends Error {
  override readonly name = "ServiceError";
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

function safeUserInfo(): { username: string } {
  try {
    return { username: userInfo().username };
  } catch {
    return { username: "unknown" };
  }
}
