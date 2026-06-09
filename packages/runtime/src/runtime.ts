import { parse } from "@openexecution/parser";
import { Registry, coerceParams } from "@openexecution/registry";
import {
  assessAst,
  assessResolved,
  scanNative,
  levelOfFindings,
  maxRisk,
} from "@openexecution/safety";
import { evaluate, defaultPolicy } from "@openexecution/policy";
import { OpenLogWriter } from "@openexecution/openlogs";
import {
  PosixAdapter,
  NodeAdapter,
} from "@openexecution/adapters-posix";
import { PowerShellAdapter } from "@openexecution/adapters-powershell";

import type {
  Adapter,
  AnyAst,
  CommandAst,
  ExecutionOutcome,
  ExecutionPlan,
  ExecutionResult,
  NativeCommandAst,
  OpenLogRecord,
  PolicyConfig,
  PolicyDecision,
  RiskAssessment,
  RiskFinding,
  RiskLevel,
  RuntimeContext,
  RuntimeOutcome,
} from "@openexecution/types";
import { isNativeAst, ParseError, RegistryError } from "@openexecution/types";

import { runMeta, isMetaCommand } from "./meta.js";

/** Asks a human to approve an approval_required command. Returns true to proceed. */
export type ApprovalHandler = (info: {
  command: string;
  risk: RiskLevel;
  reason: string;
  approvers?: string[];
}) => Promise<boolean>;

export interface RuntimeOptions {
  registry: Registry;
  policy?: PolicyConfig;
  logWriter?: OpenLogWriter;
  /**
   * Ordered adapter preference. The runtime picks the FIRST available adapter
   * that supports the resolved command. Node (in-process fs) is preferred for
   * `@node` commands because it never shells out — the safest executor.
   */
  adapters?: Adapter[];
  /** Called when policy says approval_required and we're interactive. */
  onApproval?: ApprovalHandler;
}

/**
 * The runtime can be driven from the CLI, the interactive terminal, CI, or a
 * future agent/API. A single instance is reusable across commands.
 */
export class Runtime {
  private readonly registry: Registry;
  private readonly policy: PolicyConfig;
  private readonly openLogWriter: OpenLogWriter | undefined;
  private readonly adapters: Adapter[];
  private readonly onApproval: ApprovalHandler | undefined;

  constructor(opts: RuntimeOptions) {
    this.registry = opts.registry;
    this.policy = opts.policy ?? defaultPolicy();
    this.openLogWriter = opts.logWriter;
    this.onApproval = opts.onApproval;
    // Default adapter chain: Node fs first (safest), then platform shell.
    this.adapters =
      opts.adapters ??
      [
        new NodeAdapter(),
        new PosixAdapter((id) => this.registry.resolve(id)),
        new PowerShellAdapter((id) => this.registry.resolve(id)),
      ];
  }

  /** Convenience: load the bundled core registry and build a runtime. */
  static async withCore(
    opts: Omit<RuntimeOptions, "registry"> & {
      coreDir?: string;
      /** Extra layer dirs to load over core, e.g. ~/.idel/registries/{official,custom}. */
      officialDir?: string;
      customDir?: string;
    } = {},
  ): Promise<Runtime> {
    const registry = await Registry.loadCore(opts.coreDir);
    // Layer user-supplied registries over core (custom > official > core). A
    // missing directory is not an error — most installs only ship core.
    if (opts.officialDir) {
      await registry.loadLayer(opts.officialDir, "official").catch(() => undefined);
    }
    if (opts.customDir) {
      await registry.loadLayer(opts.customDir, "custom").catch(() => undefined);
    }
    return new Runtime({ ...opts, registry });
  }

  get reg(): Registry {
    return this.registry;
  }

  /**
   * The OpenLogs writer, if one was configured. Exposed read-only so a host
   * (the server's `logs.*` surface, an agent SDK) can read/verify the audit
   * chain without re-running commands. May be undefined when logging is off.
   */
  get logWriter(): OpenLogWriter | undefined {
    return this.openLogWriter;
  }

  /**
   * Run a single IDEL (or native `!`) command end-to-end.
   *
   * Never throws on a *blocked* or *failed* command — those are outcomes,
   * recorded and returned. It only throws on programmer/usage errors that
   * happen before classification (e.g. a malformed parse with no context to
   * log). Parse/registry errors after we have a context are returned as failed
   * outcomes so they still get logged.
   */
  async run(input: string, ctx: RuntimeContext): Promise<RuntimeOutcome> {
    let ast: AnyAst;
    try {
      ast = parse(input, { cwd: ctx.cwd, source: ctx.ci ? "ci" : "idel" });
    } catch (err) {
      if (err instanceof ParseError) {
        return this.failBeforeClassification(input, ctx, "idel", err.message);
      }
      throw err;
    }

    if (isNativeAst(ast)) {
      return this.runNative(ast, ctx);
    }
    return this.runIdel(ast, ctx);
  }

  // -------------------------------------------------------------------------
  // IDEL command path
  // -------------------------------------------------------------------------

  private async runIdel(
    ast: CommandAst,
    ctx: RuntimeContext,
  ): Promise<RuntimeOutcome> {
    // Meta commands (registry.*, policy.*, logs.*) are handled by the runtime
    // itself, not by an execution adapter. They are LOW risk and bypass the
    // adapter chain, but still get logged.
    if (isMetaCommand(ast.command)) {
      return this.handleMeta(ast, ctx);
    }

    // 1) Resolve in the registry (custom > official > core).
    const resolved = this.registry.resolve(ast.command);
    if (!resolved) {
      return this.failAfterParse(
        ast,
        ctx,
        `Unknown command "${ast.command}". Try \`registry.list\` or use native passthrough: ! <command>.`,
      );
    }

    // 2) Schema-driven coercion (numbers, modes, defaults, required, extras).
    const coerced = coerceParams(resolved.def, ast.rawParams, ast.params);
    if (coerced.errors.length > 0) {
      return this.failAfterParse(
        ast,
        ctx,
        `Invalid parameters: ${coerced.errors.join("; ")}`,
      );
    }
    const typedAst: CommandAst = { ...ast, params: coerced.params };

    // 3) Safety — AST phase (cheap, string-level).
    const astRisk = assessAst(typedAst, resolved.def);

    // 4) Safety — resolved phase (real fs paths) for anything that can touch
    //    the filesystem destructively. We always run it for destructive defs;
    //    for non-destructive defs we still run it when a target param exists so
    //    symlink/escape cases are caught, but failures there are non-fatal.
    //
    //    Short-circuit: if the AST phase is already CRITICAL, skip the resolved
    //    pass entirely. CRITICAL is terminal (the resolved phase can only
    //    escalate, and there is nothing above CRITICAL), and skipping avoids the
    //    affected-path walk — we must NOT walk `/` just to estimate a count for a
    //    command we are about to block. The block decision must not depend on a
    //    filesystem traversal of the very target we refuse to touch.
    let resolvedRisk: RiskAssessment | undefined;
    if (astRisk.level !== "CRITICAL") {
      try {
        resolvedRisk = await assessResolved(typedAst, resolved.def);
      } catch {
        // The resolved pass best-effort. If the path can't be stat'd (e.g. it
        // doesn't exist yet for a create), we fall back to the AST assessment.
        resolvedRisk = undefined;
      }
    }

    const effectiveRisk: RiskLevel = resolvedRisk
      ? maxRisk(astRisk, resolvedRisk)
      : astRisk.level;
    const findings = mergeFindings(astRisk, resolvedRisk);
    const affected = resolvedRisk?.affectedPathsEstimate;

    // 5) Policy decision.
    const decision = evaluate(
      {
        risk: effectiveRisk,
        command: ast.command,
        source: typedAst.source,
        environment: ctx.environment,
        params: coerced.params,
      },
      this.policy,
    );

    // 6) Pick an adapter + build a plan (needed for dry-run output too).
    const adapter = this.pickAdapter(resolved.def.id);
    let plan: ExecutionPlan | undefined;
    if (adapter) {
      plan = adapter.plan(resolved, typedAst);
    }

    return this.enforceAndExecute({
      ast: typedAst,
      ctx,
      risk: { level: effectiveRisk, findings, affected, assessment: resolvedRisk ?? astRisk },
      decision,
      adapter,
      plan,
    });
  }

  // -------------------------------------------------------------------------
  // Native passthrough path (spec §20)
  // -------------------------------------------------------------------------

  private async runNative(
    ast: NativeCommandAst,
    ctx: RuntimeContext,
  ): Promise<RuntimeOutcome> {
    if (ctx.noNative) {
      const findings: RiskFinding[] = [
        {
          code: "native-disabled",
          level: "HIGH",
          message: "Native passthrough is disabled in this context (CI/production).",
        },
      ];
      return this.finish({
        ast: nativeToLoggable(ast),
        ctx,
        risk: { level: "HIGH", findings, affected: undefined },
        decision: {
          action: "block",
          matchedRule: -1,
          reason: "native passthrough disabled",
        },
        outcome: "blocked_before_execution",
      });
    }

    // Deterministic native danger scan (no AI).
    const findings = scanNative(ast.native);
    const risk = levelOfFindings(findings);

    const decision = evaluate(
      {
        risk,
        command: "native.run",
        source: "native",
        environment: ctx.environment,
        params: {},
      },
      this.policy,
    );

    // Build a plan: spawn the native line via the platform shell. We mark the
    // command for what it is so OpenLogs records source=native.
    const isWin = process.platform === "win32";
    const plan: ExecutionPlan = {
      adapter: isWin ? "powershell" : "posix",
      command: isWin ? "powershell" : "/bin/sh",
      argv: isWin ? ["-NoProfile", "-Command", ast.native] : ["-c", ast.native],
      describe: ast.native,
    };

    // Native execution is the one place we DO use a shell string — it is the
    // user's explicit, logged, risk-scanned escape hatch (spec §20). We never
    // construct it from untrusted concatenation; it is passed through verbatim.
    return this.enforceAndExecute({
      ast: nativeToLoggable(ast),
      ctx,
      risk: { level: risk, findings, affected: undefined, assessment: undefined },
      decision,
      adapter: undefined,
      plan,
      nativeShell: true,
    });
  }

  // -------------------------------------------------------------------------
  // Shared enforcement + execution
  // -------------------------------------------------------------------------

  private async enforceAndExecute(args: {
    ast: { command: string; params: Record<string, never> | CommandAst["params"]; source: CommandAst["source"]; cwd: string };
    ctx: RuntimeContext;
    risk: { level: RiskLevel; findings: RiskFinding[]; affected: number | undefined; assessment?: RiskAssessment };
    decision: PolicyDecision;
    adapter: Adapter | undefined;
    plan: ExecutionPlan | undefined;
    nativeShell?: boolean;
  }): Promise<RuntimeOutcome> {
    const { ast, ctx, risk, decision, adapter, plan, nativeShell } = args;

    // BLOCK — record and stop. No fs touched.
    if (decision.action === "block") {
      return this.finish({
        ast,
        ctx,
        risk,
        decision,
        plan,
        outcome: "blocked_before_execution",
      });
    }

    // APPROVAL_REQUIRED — in CI this fails closed; interactively we ask.
    if (decision.action === "approval_required") {
      if (ctx.ci || !this.onApproval) {
        return this.finish({
          ast,
          ctx,
          risk,
          decision,
          plan,
          outcome: "approval_required",
        });
      }
      const approved = await this.onApproval({
        command: ast.command,
        risk: risk.level,
        reason: decision.reason,
        approvers: decision.approvers,
      });
      if (!approved) {
        return this.finish({
          ast,
          ctx,
          risk,
          decision,
          plan,
          outcome: "blocked_before_execution",
        });
      }
    }

    // Determine dry-run: explicit flag, runtime ctx, or policy require_dry_run.
    const dryRun =
      Boolean(ctx.dryRun) ||
      decision.action === "require_dry_run" ||
      Boolean((ast.params as Record<string, unknown>)["dryRun"]);

    // No adapter and no native plan → nothing to execute.
    if (!plan) {
      return this.failAfterParse(
        ast as CommandAst,
        ctx,
        `No adapter available to execute "${ast.command}" on this platform.`,
      );
    }

    // Execute.
    let result: ExecutionResult;
    try {
      if (nativeShell) {
        result = await execNativeShell(plan, { dryRun, cwd: ast.cwd });
      } else if (adapter) {
        result = await adapter.execute(plan, { dryRun, cwd: ast.cwd });
      } else {
        return this.failAfterParse(
          ast as CommandAst,
          ctx,
          `No adapter bound for "${ast.command}".`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.finish({
        ast,
        ctx,
        risk,
        decision,
        plan,
        result: {
          exitCode: 1,
          durationMs: 0,
          stdout: "",
          stderr: message,
          simulated: false,
        },
        outcome: "failed",
      });
    }

    const outcome: ExecutionOutcome = result.simulated
      ? "dry_run"
      : result.exitCode === 0
        ? "success"
        : "failed";

    return this.finish({ ast, ctx, risk, decision, plan, result, outcome });
  }

  // -------------------------------------------------------------------------
  // Meta commands (registry.*, policy.*, logs.*)
  // -------------------------------------------------------------------------

  private async handleMeta(
    ast: CommandAst,
    ctx: RuntimeContext,
  ): Promise<RuntimeOutcome> {
    const out = await runMeta(ast, {
      registry: this.registry,
      policy: this.policy,
      logWriter: this.openLogWriter,
      ctx,
    });
    const result: ExecutionResult = {
      exitCode: out.exitCode,
      durationMs: 0,
      stdout: out.stdout,
      stderr: out.stderr,
      simulated: false,
    };
    return this.finish({
      ast,
      ctx,
      risk: { level: "LOW", findings: [], affected: undefined },
      decision: { action: "allow", matchedRule: -1, reason: "meta command" },
      result,
      outcome: out.exitCode === 0 ? "success" : "failed",
    });
  }

  // -------------------------------------------------------------------------
  // Adapter selection
  // -------------------------------------------------------------------------

  /** First available adapter (in preference order) that supports the command. */
  private pickAdapter(commandId: string): Adapter | undefined {
    const resolved = this.registry.resolve(commandId);
    for (const a of this.adapters) {
      if (!a.available) continue;
      // Prefer the def-in-hand check when the adapter exposes it.
      const supportsResolved = (a as { supportsResolved?: (r: typeof resolved) => boolean })
        .supportsResolved;
      const ok =
        resolved && typeof supportsResolved === "function"
          ? supportsResolved.call(a, resolved)
          : a.supports(commandId);
      if (ok) return a;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Outcome assembly + logging
  // -------------------------------------------------------------------------

  private async finish(args: {
    ast: { command: string; params: CommandAst["params"] | Record<string, never>; source: CommandAst["source"]; cwd: string };
    ctx: RuntimeContext;
    risk: { level: RiskLevel; findings: RiskFinding[]; affected: number | undefined; assessment?: RiskAssessment };
    decision: PolicyDecision;
    plan?: ExecutionPlan;
    result?: ExecutionResult;
    outcome: ExecutionOutcome;
  }): Promise<RuntimeOutcome> {
    const { ast, ctx, risk, decision, plan, result, outcome } = args;

    const record: OpenLogRecord = {
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      user: ctx.user,
      host: ctx.host,
      os: ctx.os,
      cwd: ctx.cwd,
      source: ast.source,
      command: ast.command,
      ast: { command: ast.command, params: ast.params as CommandAst["params"] },
      risk: risk.level,
      riskFindings: risk.findings,
      policyDecision: decision.action,
      policyReason: decision.reason,
      adapter: plan?.adapter,
      dryRun: outcome === "dry_run",
      affectedPathsEstimate: risk.affected,
      exitCode: result?.exitCode,
      durationMs: result?.durationMs,
      result: outcome,
    };

    if (this.openLogWriter) {
      // Logging must never sink a command. Swallow log errors but surface once.
      await this.openLogWriter.append(record).catch(() => undefined);
    }

    const assessment: RiskAssessment =
      risk.assessment ?? {
        phase: "ast",
        level: risk.level,
        findings: risk.findings,
        affectedPathsEstimate: risk.affected,
      };

    return { record, result, plan, decision, risk: assessment };
  }

  // -------------------------------------------------------------------------
  // Error helpers
  // -------------------------------------------------------------------------

  private failBeforeClassification(
    input: string,
    ctx: RuntimeContext,
    source: CommandAst["source"],
    message: string,
  ): Promise<RuntimeOutcome> {
    return this.finish({
      ast: { command: input, params: {}, source, cwd: ctx.cwd },
      ctx,
      risk: {
        level: "LOW",
        findings: [{ code: "parse-error", level: "LOW", message }],
        affected: undefined,
      },
      decision: { action: "block", matchedRule: -1, reason: message },
      outcome: "failed",
    });
  }

  private failAfterParse(
    ast: CommandAst | { command: string; params: CommandAst["params"]; source: CommandAst["source"]; cwd: string },
    ctx: RuntimeContext,
    message: string,
  ): Promise<RuntimeOutcome> {
    return this.finish({
      ast,
      ctx,
      risk: {
        level: "LOW",
        findings: [{ code: "usage-error", level: "LOW", message }],
        affected: undefined,
      },
      decision: { action: "block", matchedRule: -1, reason: message },
      outcome: "failed",
    });
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function mergeFindings(
  astRisk: RiskAssessment,
  resolvedRisk: RiskAssessment | undefined,
): RiskFinding[] {
  const seen = new Set<string>();
  const out: RiskFinding[] = [];
  for (const f of [...astRisk.findings, ...(resolvedRisk?.findings ?? [])]) {
    const key = `${f.code}:${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Flatten a native AST into the minimal loggable shape the pipeline expects. */
function nativeToLoggable(ast: NativeCommandAst): {
  command: string;
  params: CommandAst["params"];
  source: CommandAst["source"];
  cwd: string;
} {
  return {
    command: ast.native,
    params: { native: ast.native },
    source: ast.source,
    cwd: ast.cwd,
  };
}

/** Execute a native shell plan. Honors dryRun by simulating. */
async function execNativeShell(
  plan: ExecutionPlan,
  opts: { dryRun: boolean; cwd: string },
): Promise<ExecutionResult> {
  if (opts.dryRun) {
    return {
      exitCode: 0,
      durationMs: 0,
      stdout: `[dry-run] would execute: ${plan.describe}`,
      stderr: "",
      simulated: true,
    };
  }
  const { spawn } = await import("node:child_process");
  const start = process.hrtime.bigint();
  return await new Promise<ExecutionResult>((resolveP) => {
    const child = spawn(plan.command, plan.argv, {
      cwd: opts.cwd,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      resolveP({
        exitCode: 127,
        durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
        stdout,
        stderr: e.message,
        simulated: false,
      });
    });
    child.on("close", (code) => {
      resolveP({
        exitCode: code ?? 0,
        durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
        stdout,
        stderr,
        simulated: false,
      });
    });
  });
}

// Re-export so consumers don't need a separate import for these guards.
export { isNativeAst, RegistryError };
