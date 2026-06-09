/**
 * Risk-level ordering and merge helpers.
 *
 * A {@link RiskAssessment}'s overall `level` is always the maximum level among
 * its findings. Across the two phases (ast + resolved) the runtime takes the
 * higher level again — {@link maxRisk} powers both.
 */

import type { RiskAssessment, RiskFinding, RiskLevel } from "@openexecution/types";

/**
 * Total order on risk levels, ascending. The index is the comparable rank;
 * higher index = more dangerous.
 */
export const RISK_ORDER: readonly RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Numeric rank of a risk level (0 = LOW … 3 = CRITICAL). */
export function riskRank(level: RiskLevel): number {
  const idx = RISK_ORDER.indexOf(level);
  // Unknown levels (shouldn't happen given the union) sort as the floor.
  return idx < 0 ? 0 : idx;
}

/** Return the higher (more dangerous) of two risk levels. */
export function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/**
 * Overall level for a set of findings = the max finding level, or LOW when
 * there are no findings (a clean assessment is LOW, not undefined).
 */
export function levelOfFindings(findings: readonly RiskFinding[]): RiskLevel {
  let level: RiskLevel = "LOW";
  for (const f of findings) {
    level = higherRisk(level, f.level);
  }
  return level;
}

/**
 * The maximum risk across any number of assessments. With zero arguments the
 * result is LOW (nothing assessed = nothing dangerous found).
 */
export function maxRisk(...assessments: RiskAssessment[]): RiskLevel {
  let level: RiskLevel = "LOW";
  for (const a of assessments) {
    level = higherRisk(level, a.level);
  }
  return level;
}
