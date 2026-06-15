import { hostname, userInfo, platform } from "node:os";

import { splitBatch } from "@openexecution/parser";
import type { Runtime } from "@openexecution/runtime";
import type {
  AdapterArgSpec,
  AdapterName,
  AdapterSpec,
  CommandDef,
  CommandOrigin,
  ExecutionOutcome,
  OpenLogRecord,
  ParamValue,
  RiskLevel,
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
   * inherited shell cwd, so the server owns one. `change.path` (a runtime command)
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

export interface BatchRunResult {
  batch: true;
  commands: string[];
  outcomes: RuntimeOutcome[];
  /** 1-based step number where execution stopped, omitted when every step ran. */
  stoppedAt?: number;
  ok: boolean;
}

export interface CompleteRequest {
  /** The partial command line being typed. */
  input: string;
  /** Directory to resolve `path=` value completions against. */
  cwd?: string;
}

export interface EditorOpenRequest {
  /** File path to load into the browser editor. */
  file?: string;
  /** Directory to resolve relative file paths against. */
  cwd?: string;
}

export interface EditorSaveRequest {
  /** File path to overwrite with `content`. */
  file?: string;
  /** Full text content to save. */
  content?: string;
  /** Directory to resolve relative file paths against. */
  cwd?: string;
}

export interface EditorOpenResponse {
  file: string;
  content: string;
  language: string;
  outcome: RuntimeOutcome;
}

export interface RegistryEntry {
  id: string;
  summary: string;
  category: string;
  risk: CommandDef["riskDefault"];
  source: CommandDef["source"];
  params: { name: string; type: string; required: boolean; description?: string; enum?: string[] }[];
  examples: string[];
  adapters: RegistryAdapterEntry[];
}

export interface RegistryAdapterEntry {
  name: AdapterName;
  command: string;
  args: AdapterArgSpec[];
  pattern: string;
  semanticNotes?: string;
}

export class TerminalService {
  private readonly runtime: Runtime;
  private readonly baseCwd: string;
  private readonly environment: string | undefined;
  private readonly noNative: boolean;
  private auditFailureWarned = false;

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

  /** Split a user line into batch steps using IDEL's top-level `&&` syntax. */
  batchCommands(command: string): string[] {
    try {
      return splitBatch(command);
    } catch (err) {
      throw new ServiceError((err as Error)?.message ?? String(err), 400);
    }
  }

  /** Run a top-level `&&` batch sequentially, stopping after the first non-success. */
  async runBatch(req: RunRequest): Promise<BatchRunResult> {
    if (req.native) {
      const outcome = await this.run(req);
      return {
        batch: true,
        commands: [req.command],
        outcomes: [outcome],
        ok: batchStepSucceeded(outcome, req.dryRun === true),
        ...(batchStepSucceeded(outcome, req.dryRun === true) ? {} : { stoppedAt: 1 }),
      };
    }

    const commands = this.batchCommands(req.command);
    const outcomes: RuntimeOutcome[] = [];
    for (let i = 0; i < commands.length; i++) {
      const outcome = await this.run({ ...req, command: commands[i]!, native: false });
      outcomes.push(outcome);
      if (!batchStepSucceeded(outcome, req.dryRun === true)) {
        return { batch: true, commands, outcomes, stoppedAt: i + 1, ok: false };
      }
    }
    return { batch: true, commands, outcomes, ok: true };
  }

  /** Registry-driven completion for the current input. */
  complete(req: CompleteRequest): string[] {
    return complete(req.input, this.runtime.reg, req.cwd ?? this.baseCwd);
  }

  /** Load a file for the browser editor via the audited runtime read path. */
  async openEditor(req: EditorOpenRequest): Promise<EditorOpenResponse> {
    const file = normalizeEditorFile(req.file);
    const outcome = await this.run({
      command: `read.file name=${quoteParamValue(file)}`,
      cwd: req.cwd,
      origin: "api",
    });
    if (outcome.record.result !== "success") {
      throw new ServiceError(
        outcome.result?.stderr?.trim() || `could not open editor file: ${file}`,
        400,
      );
    }
    return {
      file,
      content: outcome.result?.stdout ?? "",
      language: languageForPath(file),
      outcome,
    };
  }

  /** Save a browser-editor buffer through the audited runtime write path. */
  async saveEditor(req: EditorSaveRequest): Promise<RuntimeOutcome> {
    const file = normalizeEditorFile(req.file);
    const content = req.content ?? "";
    return await this.run({
      command: `write.file name=${quoteParamValue(file)} content=${quoteParamValue(content)}`,
      cwd: req.cwd,
      origin: "api",
    });
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

  /** Record native terminal lifecycle events that bypass the IDEL command parser. */
  async auditNativeTerminal(
    command: "native.terminal.start" | "native.terminal.close" | "native.terminal.signal" | "native.terminal.exit",
    params: Record<string, ParamValue>,
    opts: { result?: ExecutionOutcome; risk?: RiskLevel; exitCode?: number } = {},
  ): Promise<void> {
    const writer = this.runtime.logWriter;
    if (!writer) return;
    const ui = safeUserInfo();
    const cwd = typeof params["cwd"] === "string" ? params["cwd"] : this.baseCwd;
    const record: OpenLogRecord = {
      timestamp: new Date().toISOString(),
      sessionId: `srv_${process.pid}`,
      user: ui.username,
      host: hostname(),
      os: platform(),
      cwd,
      source: "api",
      command,
      ast: { command, params },
      risk: opts.risk ?? "HIGH",
      riskFindings: [
        {
          code: "native-terminal",
          level: opts.risk ?? "HIGH",
          message:
            "Native terminal session bypasses IDEL command parsing; lifecycle event audited.",
        },
      ],
      policyDecision: "allow",
      policyReason: "native terminal explicitly enabled on this server",
      dryRun: false,
      ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
      result: opts.result ?? "success",
    };
    await writer.append(record).catch((err: unknown) => {
      if (this.auditFailureWarned) return;
      this.auditFailureWarned = true;
      const detail = (err as Error)?.message ?? String(err);
      process.stderr.write(
        `openlogs: failed to record native terminal event — audit trail may be incomplete (${detail})\n`,
      );
    });
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
        ...(schema.description ? { description: schema.description } : {}),
        ...(schema.enum ? { enum: schema.enum.map(String) } : {}),
      })),
      examples: def.examples ?? [],
      adapters: Object.entries(def.adapters).map(([name, spec]) =>
        toAdapterEntry(name as AdapterName, spec),
      ),
    };
  }
}

function toAdapterEntry(name: AdapterName, spec: AdapterSpec): RegistryAdapterEntry {
  return {
    name,
    command: spec.command,
    args: spec.args,
    pattern: renderAdapterPattern(spec),
    ...(spec.semanticNotes ? { semanticNotes: spec.semanticNotes } : {}),
  };
}

function renderAdapterPattern(spec: AdapterSpec): string {
  const parts = [spec.command];
  for (const arg of spec.args) {
    switch (arg.kind) {
      case "flag":
        parts.push(`[${arg.flag}]`);
        break;
      case "option":
        parts.push(`[${arg.flag} <${arg.param}>]`);
        break;
      case "value":
        parts.push(`<${arg.param}>`);
        break;
      case "literal":
        parts.push(arg.value);
        break;
      default: {
        const _never: never = arg;
        void _never;
      }
    }
  }
  return parts.join(" ");
}

export function batchStepSucceeded(outcome: RuntimeOutcome, explicitDryRun = false): boolean {
  return outcome.record.result === "success" || (explicitDryRun && outcome.record.result === "dry_run");
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

function normalizeEditorFile(file: string | undefined): string {
  if (!file || !file.trim()) {
    throw new ServiceError("editor file is required", 400);
  }
  return file.trim();
}

function quoteParamValue(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function languageForPath(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return "text";
}
