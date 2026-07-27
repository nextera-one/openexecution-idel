/**
 * @openexecution/runtime — the OpenExecution Runtime pipeline (spec §12).
 *
 * This is the integration core. It wires the independently-built stages into a
 * single deterministic pipeline:
 *
 *   parse → resolve (registry) → coerce → safety (two-phase) → policy → plan
 *         → execute → log (OpenLogs)
 *
 * The two design decisions that came out of the spec review and live HERE:
 *
 *  1. Safety is two-phase. We run the cheap AST pass early, then — only when we
 *     are actually about to execute against the filesystem — the resolved-path
 *     pass. The effective risk is the MAX of the two. This is what catches
 *     `remove.folder name=dist` when `dist` is a symlink to `/`.
 *
 *  2. Two precedence systems point in opposite directions and BOTH are enforced
 *     here. Registry content resolves custom > official > core. Safety floors
 *     resolve core-first and are non-overridable: a custom registry or a lax
 *     policy can never weaken a CRITICAL core floor. The policy engine enforces
 *     the CRITICAL floor; the runtime additionally refuses to let the resolved
 *     phase be skipped for destructive commands.
 */

export { EvidenceWriteError, Runtime } from "./runtime.js";
export type { RuntimeOptions, ApprovalHandler } from "./runtime.js";
export {
  formatDecision,
  formatRisk,
  describeOutcome,
} from "./format.js";

// Re-export the whole shared contract so the CLI can depend on just the runtime.
export * from "@openexecution/types";
