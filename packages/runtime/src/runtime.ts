import { parse } from "@openexecution/parser";
import { Registry, coerceParams } from "@openexecution/registry";
import {
  assessAst,
  assessResolved,
  scanNative,
  levelOfFindings,
  maxRisk,
  higherRisk,
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
  ParamValue,
  PolicyConfig,
  PolicyDecision,
  RiskAssessment,
  RiskFinding,
  RiskLevel,
  RuntimeContext,
  RuntimeOutcome,
  RuntimePreview,
} from "@openexecution/types";
import { isNativeAst, ParseError, RegistryError } from "@openexecution/types";

import { runMeta, isMetaCommand } from "./meta.js";

const LEGACY_COMMAND_ALIASES = new Map<string, string>([
  ["registry.list", "list.registry"],
  ["registry.explain", "explain.registry"],
  ["policy.check", "check.policy"],
  ["logs.list", "list.logs"],
  ["logs.show", "show.logs"],
  ["path.current", "show.path"],
  ["path.change", "change.path"],
  ["env.get", "get.env"],
  ["env.set", "set.env"],
  ["archive.create", "create.archive"],
  ["archive.extract", "extract.archive"],
  ["archive.list", "list.archive"],
  ["permission.file.set", "set.file.permission"],
  ["permission.folder.set", "set.folder.permission"],
  ["owner.file.set", "set.file.owner"],
  ["owner.folder.set", "set.folder.owner"],
]);

function normalizeLegacyCommand(ast: CommandAst): CommandAst {
  const command = LEGACY_COMMAND_ALIASES.get(ast.command);
  return command ? { ...ast, command } : ast;
}

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
  private onApproval: ApprovalHandler | undefined;
  /** Set once an OpenLogs append has failed, so we warn only on the first miss. */
  private logFailureWarned = false;

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
   * (the server's log-reading surface, an agent SDK) can read/verify the audit
   * chain without re-running commands. May be undefined when logging is off.
   */
  get logWriter(): OpenLogWriter | undefined {
    return this.openLogWriter;
  }

  /**
   * Replace the approval handler used for future runs. Hosts with their own
   * prompt surface, such as the readline REPL, can install this after the
   * Runtime is constructed without rebuilding the registry/logging stack.
   */
  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.onApproval = handler;
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
    // Origin attribution: an explicit ctx.origin (e.g. "agent" for an
    // AI-proposed command) wins; otherwise infer ci vs interactive. This only
    // labels the audit record — risk and policy are origin-independent.
    const origin = ctx.origin ?? (ctx.ci ? "ci" : "idel");
    let ast: AnyAst;
    try {
      ast = parse(input, { cwd: ctx.cwd, source: origin });
    } catch (err) {
      if (err instanceof ParseError) {
        return this.failBeforeClassification(input, ctx, origin, err.message);
      }
      throw err;
    }

    if (isNativeAst(ast)) {
      return this.runNative(ast, ctx);
    }
    return this.runIdel(normalizeLegacyCommand(ast), ctx);
  }

  /**
   * Classify and plan a command without executing it and without appending an
   * OpenLogs record. This is for live UI affordances such as risk indicators;
   * `run()` remains the only path that produces auditable command outcomes.
   */
  async preview(input: string, ctx: RuntimeContext): Promise<RuntimePreview> {
    const origin = ctx.origin ?? (ctx.ci ? "ci" : "idel");
    let ast: AnyAst;
    try {
      ast = parse(input, { cwd: ctx.cwd, source: origin });
    } catch (err) {
      if (err instanceof ParseError) {
        return this.previewFailure(input, origin, err.message, "parse-error");
      }
      throw err;
    }

    if (isNativeAst(ast)) {
      return this.previewNative(ast, ctx);
    }
    return this.previewIdel(normalizeLegacyCommand(ast), ctx);
  }

  // -------------------------------------------------------------------------
  // IDEL command path
  // -------------------------------------------------------------------------

  private async runIdel(
    ast: CommandAst,
    ctx: RuntimeContext,
  ): Promise<RuntimeOutcome> {
    // 1) Resolve in the registry (custom > official > core).
    const resolved = this.registry.resolve(ast.command);
    if (!resolved) {
      return this.failAfterParse(
        ast,
        ctx,
        `Unknown command "${ast.command}". Try \`list.registry\` or use native passthrough: ! <command>.`,
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

    // 3) Safety — assess the winning definition, plus the core definition when
    //    this command shadows a core command. Registry resolution is custom-first
    //    for behavior, but safety floors are core-first and non-overridable.
    const coreDef = this.registry.coreDef(ast.command);
    const safetyDefs = coreDef && coreDef !== resolved.def
      ? [resolved.def, coreDef]
      : [resolved.def];
    const assessments: RiskAssessment[] = [];

    for (const def of safetyDefs) {
      const astRisk = assessAst(typedAst, def);
      assessments.push(astRisk);

      // 4) Safety — resolved phase (real fs paths). Short-circuit each def at
      //    CRITICAL so we never walk a target that is already terminally blocked.
      if (astRisk.level !== "CRITICAL") {
        try {
          assessments.push(await assessResolved(typedAst, def));
        } catch {
          // The resolved pass is best-effort. If the path can't be stat'd (e.g.
          // it doesn't exist yet for a create), fall back to AST classification.
        }
      }
    }

    let effectiveRisk: RiskLevel = maxRisk(...assessments);
    const findings = mergeFindings(...assessments);
    const affected = maxAffectedEstimate(assessments);
    const assessmentForBytes = assessmentWithBytes(assessments);
    const requiresAffectedEstimate = safetyDefs.some(
      (def) => def.safety?.requiresAffectedPathEstimate === true,
    );

    // 4b) Enforce requiresAffectedPathEstimate (fail-closed). A command that
    //     declares it needs a blast-radius estimate but for which we could not
    //     produce one — an unbounded glob, a target we couldn't walk, or the
    //     resolved phase was skipped — must not be treated as low/medium just
    //     because the count is unknown. Escalate to at least HIGH so the policy
    //     gets to gate it (warn/dry-run/approval/block per its rules). The CRITICAL
    //     short-circuit above already handles the worst case, so we never lower it.
    if (
      requiresAffectedEstimate &&
      affected === undefined &&
      effectiveRisk !== "CRITICAL"
    ) {
      effectiveRisk = higherRisk(effectiveRisk, "HIGH");
      findings.push({
        code: "missing-affected-estimate",
        level: "HIGH",
        message:
          "Destructive command requires a blast-radius estimate, but none could be computed; escalated to HIGH (fail-closed).",
      });
    }

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

    // 6) Meta commands (list.registry, install.adapter, list.logs, etc.) are
    // runtime-internal and have no execution adapter, but they still pass
    // registry resolution, schema coercion, risk defaults, policy, and logging.
    if (isMetaCommand(ast.command)) {
      return this.handleMeta(typedAst, ctx, {
        risk: { level: effectiveRisk, findings, affected, assessment: assessmentForBytes },
        decision,
      });
    }

    // 7) Pick an adapter + build a plan (needed for dry-run output too).
    const adapter = this.pickAdapter(resolved.def.id);
    let plan: ExecutionPlan | undefined;
    if (adapter) {
      plan = adapter.plan(resolved, typedAst);
    }

    return this.enforceAndExecute({
      ast: typedAst,
      ctx,
      risk: { level: effectiveRisk, findings, affected, assessment: assessmentForBytes },
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
  // Non-executing preview path
  // -------------------------------------------------------------------------

  private async previewIdel(
    ast: CommandAst,
    ctx: RuntimeContext,
  ): Promise<RuntimePreview> {
    const resolved = this.registry.resolve(ast.command);
    if (!resolved) {
      return this.previewFailure(
        ast.command,
        ast.source,
        `Unknown command "${ast.command}". Try \`list.registry\` or use native passthrough: ! <command>.`,
        "usage-error",
      );
    }

    const coerced = coerceParams(resolved.def, ast.rawParams, ast.params);
    if (coerced.errors.length > 0) {
      return this.previewFailure(
        ast.command,
        ast.source,
        `Invalid parameters: ${coerced.errors.join("; ")}`,
        "usage-error",
      );
    }
    const typedAst: CommandAst = { ...ast, params: coerced.params };

    const coreDef = this.registry.coreDef(ast.command);
    const safetyDefs = coreDef && coreDef !== resolved.def
      ? [resolved.def, coreDef]
      : [resolved.def];
    const assessments: RiskAssessment[] = [];

    for (const def of safetyDefs) {
      const astRisk = assessAst(typedAst, def);
      assessments.push(astRisk);
      if (astRisk.level !== "CRITICAL") {
        try {
          assessments.push(await assessResolved(typedAst, def));
        } catch {
          // Preview follows the runtime's best-effort resolved phase behavior.
        }
      }
    }

    let effectiveRisk: RiskLevel = maxRisk(...assessments);
    const findings = mergeFindings(...assessments);
    const affected = maxAffectedEstimate(assessments);
    const assessmentForBytes = assessmentWithBytes(assessments);
    const requiresAffectedEstimate = safetyDefs.some(
      (def) => def.safety?.requiresAffectedPathEstimate === true,
    );

    if (
      requiresAffectedEstimate &&
      affected === undefined &&
      effectiveRisk !== "CRITICAL"
    ) {
      effectiveRisk = higherRisk(effectiveRisk, "HIGH");
      findings.push({
        code: "missing-affected-estimate",
        level: "HIGH",
        message:
          "Destructive command requires a blast-radius estimate, but none could be computed; escalated to HIGH (fail-closed).",
      });
    }

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

    const adapter = this.pickAdapter(resolved.def.id);
    const plan = adapter ? adapter.plan(resolved, typedAst) : undefined;

    return this.buildPreview({
      ast: typedAst,
      risk: { level: effectiveRisk, findings, affected, assessment: assessmentForBytes },
      decision,
      plan,
    });
  }

  private previewNative(
    ast: NativeCommandAst,
    ctx: RuntimeContext,
  ): RuntimePreview {
    const loggable = nativeToLoggable(ast);
    if (ctx.noNative) {
      return this.buildPreview({
        ast: loggable,
        risk: {
          level: "HIGH",
          findings: [
            {
              code: "native-disabled",
              level: "HIGH",
              message: "Native passthrough is disabled in this context (CI/production).",
            },
          ],
          affected: undefined,
        },
        decision: {
          action: "block",
          matchedRule: -1,
          reason: "native passthrough disabled",
        },
      });
    }

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

    const isWin = process.platform === "win32";
    const plan: ExecutionPlan = {
      adapter: isWin ? "powershell" : "posix",
      command: isWin ? "powershell" : "/bin/sh",
      argv: isWin ? ["-NoProfile", "-Command", ast.native] : ["-c", ast.native],
      describe: ast.native,
    };

    return this.buildPreview({
      ast: loggable,
      risk: { level: risk, findings, affected: undefined, assessment: undefined },
      decision,
      plan,
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
      if (ctx.approval === false) {
        return this.finish({
          ast,
          ctx,
          risk,
          decision,
          plan,
          outcome: "blocked_before_execution",
        });
      }
      if (ctx.approval !== true) {
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
    }

    // Determine dry-run: explicit flag, runtime ctx, or policy require_dry_run.
    const dryRun =
      Boolean(ctx.dryRun) ||
      decision.action === "require_dry_run" ||
      Boolean((ast.params as Record<string, unknown>)["dryRun"]);

    // No adapter and no native plan → nothing to execute.
    if (!plan) {
      return this.finish({
        ast,
        ctx,
        risk,
        decision,
        result: {
          exitCode: 1,
          durationMs: 0,
          stdout: "",
          stderr: `No adapter available to execute "${ast.command}" on this platform.\n`,
          simulated: false,
        },
        outcome: "failed",
      });
    }

    // Execute.
    let result: ExecutionResult;
    try {
      if (nativeShell) {
        result = await execNativeShell(plan, { dryRun, cwd: ast.cwd });
      } else if (adapter) {
        result = await adapter.execute(plan, {
          dryRun,
          cwd: ast.cwd,
          interactive: ctx.interactive === true,
        });
      } else {
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
            stderr: `No adapter bound for "${ast.command}".\n`,
            simulated: false,
          },
          outcome: "failed",
        });
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
  // Meta commands (list.registry, check.policy, list.logs, etc.)
  // -------------------------------------------------------------------------

  private async handleMeta(
    ast: CommandAst,
    ctx: RuntimeContext,
    classified?: {
      risk: {
        level: RiskLevel;
        findings: RiskFinding[];
        affected: number | undefined;
        assessment?: RiskAssessment;
      };
      decision: PolicyDecision;
    },
  ): Promise<RuntimeOutcome> {
    const risk = classified?.risk ?? {
      level: "LOW" as RiskLevel,
      findings: [],
      affected: undefined,
    };
    const decision = classified?.decision ?? {
      action: "allow" as const,
      matchedRule: -1,
      reason: "meta command",
    };

    if (decision.action === "block") {
      return this.finish({
        ast,
        ctx,
        risk,
        decision,
        outcome: "blocked_before_execution",
      });
    }

    if (decision.action === "approval_required") {
      if (ctx.approval === false) {
        return this.finish({
          ast,
          ctx,
          risk,
          decision,
          outcome: "blocked_before_execution",
        });
      }
      if (ctx.approval !== true) {
        if (ctx.ci || !this.onApproval) {
          return this.finish({
            ast,
            ctx,
            risk,
            decision,
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
            outcome: "blocked_before_execution",
          });
        }
      }
    }

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
      risk,
      decision,
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

  private buildPreview(args: {
    ast: { command: string; params: CommandAst["params"] | Record<string, never>; source: CommandAst["source"]; cwd: string };
    risk: { level: RiskLevel; findings: RiskFinding[]; affected: number | undefined; assessment?: RiskAssessment };
    decision: PolicyDecision;
    plan?: ExecutionPlan;
  }): RuntimePreview {
    const { ast, risk, decision, plan } = args;
    return {
      ast: { command: ast.command, params: ast.params as Record<string, ParamValue> },
      ...(plan ? { plan } : {}),
      decision,
      risk: this.riskToAssessment(risk),
    };
  }

  private riskToAssessment(risk: {
    level: RiskLevel;
    findings: RiskFinding[];
    affected: number | undefined;
    assessment?: RiskAssessment;
  }): RiskAssessment {
    return {
      phase: risk.assessment?.phase ?? "ast",
      level: risk.level,
      findings: risk.findings,
      affectedPathsEstimate: risk.affected,
      ...(risk.assessment?.affectedBytesEstimate !== undefined
        ? { affectedBytesEstimate: risk.assessment.affectedBytesEstimate }
        : {}),
    };
  }

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
      // Logging must never sink a command — a failed append cannot fail the
      // command. But an accountability layer that silently stops recording is
      // worse than one that complains, so surface the FIRST failure to stderr
      // (once per runtime) instead of swallowing it entirely (CONCERNS §2).
      await this.openLogWriter.append(record).catch((err: unknown) => {
        if (!this.logFailureWarned) {
          this.logFailureWarned = true;
          const detail = (err as Error)?.message ?? String(err);
          process.stderr.write(
            `openlogs: failed to record this command — audit trail may be incomplete (${detail})\n`,
          );
        }
      });
    }

    // Build the returned assessment from the AUTHORITATIVE merged values
    // (risk.level/findings/affected) rather than echoing risk.assessment
    // verbatim: the runtime may have escalated the level and appended findings
    // (e.g. the requiresAffectedPathEstimate fail-closed gate) after the
    // resolved-phase assessment was produced, and those must surface in the
    // outcome and the signed record alike.
    const assessment = this.riskToAssessment(risk);

    return { record, result, plan, decision, risk: assessment };
  }

  // -------------------------------------------------------------------------
  // Error helpers
  // -------------------------------------------------------------------------

  private previewFailure(
    input: string,
    source: CommandAst["source"],
    message: string,
    code: "parse-error" | "usage-error",
  ): RuntimePreview {
    return this.buildPreview({
      ast: { command: input, params: {}, source, cwd: "" },
      risk: {
        level: "LOW",
        findings: [{ code, level: "LOW", message }],
        affected: undefined,
      },
      decision: { action: "block", matchedRule: -1, reason: message },
    });
  }

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
  ...assessments: (RiskAssessment | undefined)[]
): RiskFinding[] {
  const seen = new Set<string>();
  const out: RiskFinding[] = [];
  for (const assessment of assessments) {
    if (!assessment) continue;
    for (const f of assessment.findings) {
      const key = `${f.code}:${f.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

function maxAffectedEstimate(assessments: readonly RiskAssessment[]): number | undefined {
  let max: number | undefined;
  for (const assessment of assessments) {
    const estimate = assessment.affectedPathsEstimate;
    if (estimate === undefined) continue;
    max = max === undefined ? estimate : Math.max(max, estimate);
  }
  return max;
}

function assessmentWithBytes(assessments: readonly RiskAssessment[]): RiskAssessment | undefined {
  for (let i = assessments.length - 1; i >= 0; i -= 1) {
    const assessment = assessments[i];
    if (assessment?.affectedBytesEstimate !== undefined) return assessment;
  }
  return assessments[assessments.length - 1];
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
