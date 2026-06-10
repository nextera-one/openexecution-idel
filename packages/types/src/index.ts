/**
 * @openexecution/types — the shared contract every package depends on.
 *
 * Design notes (from the v1.1 spec critique):
 *  - Safety is two-phase: an AST-level pass and a resolved-real-path pass run
 *    immediately before execution. Both produce a {@link RiskAssessment}; the
 *    higher of the two wins. TOCTOU between them is itself acknowledged.
 *  - Adapters build argv with *conditional array construction in code*, never
 *    string templates. The registry describes the mapping declaratively
 *    ({@link AdapterArgSpec}); the adapter package renders it to a real
 *    `string[]` with no empty-string placeholders.
 *  - Registry resolution is custom > official > core, but core safety floors
 *    are non-overridable. These are two precedence systems pointing opposite
 *    directions, captured by {@link CommandSource} + {@link SafetyFloor}.
 */

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Where a command entered the runtime. `agent` marks a command an AI proposed
 * through {@link @openexecution/agent} — it still flows through the identical
 * safety/policy/OpenLogs pipeline, but the signed audit record carries
 * `source: "agent"` so AI-initiated actions are distinguishable from human ones.
 */
export type CommandOrigin = "idel" | "native" | "ci" | "api" | "agent";

/** A scalar parameter value after type coercion against the schema. */
export type ParamValue = string | number | boolean;

/** Result of parsing an IDEL command string into a typed AST. */
export interface CommandAst {
  /** Full dotted command name, e.g. "remove.folder". */
  command: string;
  /** Coerced parameters keyed by name. */
  params: Record<string, ParamValue>;
  /** Raw (pre-coercion) parameter strings, preserved for logging/debug. */
  rawParams: Record<string, string>;
  /** How this command entered the runtime. */
  source: CommandOrigin;
  /** Absolute working directory the command was issued from. */
  cwd: string;
}

/** A native (non-IDEL) command captured for risk-scanning and passthrough. */
export interface NativeCommandAst {
  command: "native.run";
  /** The raw native command line, exactly as the user typed it. */
  native: string;
  params: Record<string, ParamValue>;
  rawParams: Record<string, string>;
  source: CommandOrigin;
  cwd: string;
}

export type AnyAst = CommandAst | NativeCommandAst;

export function isNativeAst(ast: AnyAst): ast is NativeCommandAst {
  return ast.command === "native.run";
}

export class ParseError extends Error {
  override readonly name = "ParseError";
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ParamType = "string" | "boolean" | "number" | "path" | "mode";

export interface ParamSchema {
  type: ParamType;
  required?: boolean;
  default?: ParamValue;
  /** Closed set of allowed values, if any. */
  enum?: ParamValue[];
  description?: string;
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Static safety hints declared on a command definition. */
export interface CommandSafety {
  /** True if the command can destroy or overwrite data. */
  destructive?: boolean;
  /** Absolute/normalized targets that must always be blocked. */
  blockTargets?: string[];
  /** Require an affected-path estimate before HIGH+ execution. */
  requiresAffectedPathEstimate?: boolean;
  /** Parameter name that holds the primary filesystem target, if any. */
  targetParam?: string;
}

/**
 * Declarative description of how a parameter maps to adapter argv.
 * Rendered to a real string[] in code — NEVER via string templating.
 */
export type AdapterArgSpec =
  /** Emit `flag` only when boolean param `when` is true. */
  | { kind: "flag"; flag: string; when: string }
  /** Emit `flag` then the value of param `param` as two argv elements. */
  | { kind: "option"; flag: string; param: string }
  /** Emit the value of param `param` as a single positional argv element. */
  | { kind: "value"; param: string }
  /** Emit a fixed literal argv element. */
  | { kind: "literal"; value: string };

export interface AdapterSpec {
  /** Executable to spawn (e.g. "rm", "Remove-Item"), or "@node" for the in-process fs adapter. */
  command: string;
  /** Ordered argv specs. */
  args: AdapterArgSpec[];
  /**
   * Cross-platform semantic notes. Where POSIX and PowerShell diverge in
   * meaning (exit codes, glob handling, read-only behavior), say so here
   * rather than pretending parity.
   */
  semanticNotes?: string;
}

export type AdapterName = "posix" | "powershell" | "node";

export interface RegistryTest {
  input: string;
  expectPolicy?: PolicyAction;
  expectRisk?: RiskLevel;
}

export type CommandSource = "core" | "official" | "custom";

export interface CommandDef {
  id: string;
  version: string;
  summary: string;
  category: string;
  riskDefault: RiskLevel;
  params: Record<string, ParamSchema>;
  /** Allow unknown params (e.g. low-risk passthrough extraArgs). Off by default. */
  allowExtraArgs?: boolean;
  safety?: CommandSafety;
  adapters: Partial<Record<AdapterName, AdapterSpec>>;
  examples?: string[];
  tests?: RegistryTest[];
  /** Set by the loader; not present in the JSON on disk. */
  source?: CommandSource;
}

export interface ResolvedCommand {
  def: CommandDef;
  /** The layer the winning definition came from. */
  source: CommandSource;
  /** Lower-priority definitions that were shadowed, for `registry.explain`. */
  shadowed: { source: CommandSource; version: string }[];
}

export class RegistryError extends Error {
  override readonly name = "RegistryError";
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/** Which of the two safety phases produced an assessment. */
export type SafetyPhase = "ast" | "resolved";

export interface RiskFinding {
  /** Stable machine code, e.g. "root-delete", "recursive-force", "broad-glob". */
  code: string;
  level: RiskLevel;
  message: string;
}

export interface RiskAssessment {
  phase: SafetyPhase;
  level: RiskLevel;
  findings: RiskFinding[];
  /** Estimated affected paths for destructive ops, when feasible to compute. */
  affectedPathsEstimate?: number;
  /** Estimated total bytes affected, when feasible. */
  affectedBytesEstimate?: number;
}

/**
 * A core safety floor that custom/official registries cannot weaken.
 * Resolution: registry content is custom-first; safety floors are core-first.
 */
export interface SafetyFloor {
  code: string;
  level: RiskLevel;
  description: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PolicyAction =
  | "allow"
  | "warn"
  | "require_dry_run"
  | "approval_required"
  | "block";

export interface PolicyMatch {
  risk?: RiskLevel;
  command?: string;
  source?: CommandOrigin;
  environment?: string;
  /** Match on specific parameter values. */
  params?: Record<string, ParamValue>;
}

export interface PolicyRule {
  match: PolicyMatch;
  action: PolicyAction;
  approvers?: string[];
}

export interface PolicyConfig {
  rules: PolicyRule[];
}

export interface PolicyDecision {
  action: PolicyAction;
  /** The rule index that matched, or -1 for the implicit default. */
  matchedRule: number;
  reason: string;
  approvers?: string[];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecutionPlan {
  adapter: AdapterName;
  /** Executable to spawn, or "@node" sentinel for in-process fs ops. */
  command: string;
  /** Fully-rendered argv — no empty strings, no shell metacharacters injected. */
  argv: string[];
  /** Human-readable one-line description of what will run. */
  describe: string;
}

export interface ExecutionResult {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when the executor short-circuited (dry-run or blocked). */
  simulated: boolean;
}

/** Adapters declare what they can do so unsupported commands fail cleanly. */
export interface AdapterCapabilities {
  name: AdapterName;
  /** True if this adapter runs on the current platform. */
  available: boolean;
  /** Command ids this adapter can execute. */
  supports(commandId: string): boolean;
}

export interface Adapter extends AdapterCapabilities {
  /** Build a (possibly dry-run) plan from a resolved command + AST. */
  plan(resolved: ResolvedCommand, ast: CommandAst): ExecutionPlan;
  /** Execute a plan. Must honor dryRun by returning a simulated result. */
  execute(plan: ExecutionPlan, opts: { dryRun: boolean; cwd: string }): Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// OpenLogs
// ---------------------------------------------------------------------------

export interface OpenLogRecord {
  timestamp: string;
  sessionId: string;
  user: string;
  host: string;
  os: string;
  cwd: string;
  source: CommandOrigin;
  command: string;
  ast: { command: string; params: Record<string, ParamValue> };
  risk: RiskLevel;
  riskFindings: RiskFinding[];
  policyDecision: PolicyAction;
  policyReason: string;
  adapter?: AdapterName;
  dryRun: boolean;
  affectedPathsEstimate?: number;
  exitCode?: number;
  durationMs?: number;
  /** One of: success | blocked_before_execution | failed | dry_run | approval_required. */
  result: ExecutionOutcome;
}

export type ExecutionOutcome =
  | "success"
  | "failed"
  | "blocked_before_execution"
  | "dry_run"
  | "approval_required";

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RuntimeContext {
  cwd: string;
  user: string;
  host: string;
  os: string;
  sessionId: string;
  /** Logical environment for policy matching, e.g. "production". */
  environment?: string;
  /** CI mode: approval-required commands fail instead of prompting. */
  ci?: boolean;
  /** Force a dry-run regardless of policy. */
  dryRun?: boolean;
  /** Disallow native passthrough (e.g. in CI/production). */
  noNative?: boolean;
  /**
   * Override the logged command origin. When omitted, the runtime infers
   * `"ci"` or `"idel"`. Set to `"agent"` so AI-proposed commands are recorded
   * with `source: "agent"` in OpenLogs. Does not affect risk/policy — those are
   * origin-independent; it only changes the audit attribution.
   */
  origin?: CommandOrigin;
}

export interface RuntimeOutcome {
  record: OpenLogRecord;
  result?: ExecutionResult;
  plan?: ExecutionPlan;
  decision: PolicyDecision;
  risk: RiskAssessment;
}
