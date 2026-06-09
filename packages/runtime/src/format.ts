import type {
  ExecutionOutcome,
  PolicyDecision,
  RiskAssessment,
} from "@openexecution/types";

/**
 * Human-facing rendering of a runtime outcome (spec §25). Kept deliberately
 * plain: state what happened, why, and whether anything changed. No ANSI here —
 * the CLI layer adds color so this stays testable.
 */

export function formatRisk(risk: RiskAssessment): string {
  const lines: string[] = [`Risk: ${risk.level}`];
  for (const f of risk.findings) {
    lines.push(`  - [${f.level}] ${f.code}: ${f.message}`);
  }
  if (risk.affectedPathsEstimate !== undefined) {
    lines.push(`  affected paths (estimate): ${risk.affectedPathsEstimate}`);
  }
  return lines.join("\n");
}

export function formatDecision(decision: PolicyDecision): string {
  const rule =
    decision.matchedRule >= 0
      ? `rule #${decision.matchedRule}`
      : "default policy";
  const approvers = decision.approvers?.length
    ? ` (approvers: ${decision.approvers.join(", ")})`
    : "";
  return `Decision: ${decision.action.toUpperCase()} [${rule}]${approvers}\nReason: ${decision.reason}`;
}

export function describeOutcome(outcome: ExecutionOutcome): string {
  switch (outcome) {
    case "success":
      return "Executed successfully.";
    case "failed":
      return "Command failed.";
    case "blocked_before_execution":
      return "BLOCKED. No files were changed.";
    case "dry_run":
      return "Dry run. No files were changed.";
    case "approval_required":
      return "Approval required. Not executed.";
    default:
      return outcome;
  }
}
