import type {
  PolicyConfig,
  PolicyDecision,
  RiskLevel,
} from "@openexecution/types";

import type { EvaluationInput } from "./match.js";
import { ruleMatches } from "./match.js";

/**
 * Risk-based implicit default, applied when NO rule matches.
 *   LOW / MEDIUM -> allow
 *   HIGH         -> require_dry_run
 *   CRITICAL     -> block
 * (spec §19/§27 "implicit default")
 */
function defaultActionForRisk(risk: RiskLevel): PolicyDecision["action"] {
  switch (risk) {
    case "LOW":
    case "MEDIUM":
      return "allow";
    case "HIGH":
      return "require_dry_run";
    case "CRITICAL":
      return "block";
  }
}

/**
 * Evaluate an input against a policy config and return a decision.
 *
 * PRECEDENCE (the load-bearing decision from the spec review — documented here
 * so readers never have to guess):
 *
 *   1. FIRST-MATCH-WINS. Rules are evaluated strictly in array order and the
 *      FIRST rule whose `match` matches the input is selected. This is NOT
 *      "most specific wins" — ordering in the policy file is how authors
 *      express priority. Put your broad CRITICAL/block rule first if you want
 *      it to take precedence; put narrow exceptions before broad catch-alls.
 *
 *   2. CRITICAL HARD FLOOR (§28 "custom registries cannot override core
 *      critical safety rules"; §18 "never let --yes bypass CRITICAL by
 *      default"). User policy can RAISE the bar but cannot WEAKEN the floor for
 *      CRITICAL risk:
 *        - If risk === CRITICAL and the first-matched action is one of
 *          allow / warn / require_dry_run, we OVERRIDE the action to `block`
 *          and record the override in `reason`. A plain allow/warn rule can
 *          never downgrade CRITICAL.
 *        - The ONLY sanctioned exception is an explicit `approval_required`
 *          rule (a deliberate team exception). `approval_required` and `block`
 *          are both honored as-is on CRITICAL — they are at or above the floor.
 *      The floor also applies to the implicit default, but the default for
 *      CRITICAL is already `block`, so there is nothing to override there.
 *
 *   3. IMPLICIT DEFAULT. If no rule matches, fall back to the risk-based
 *      default (see defaultActionForRisk) with matchedRule = -1.
 */
export function evaluate(input: EvaluationInput, config: PolicyConfig): PolicyDecision {
  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];
    if (rule === undefined) {
      // Unreachable for a well-formed array, but noUncheckedIndexedAccess makes
      // the element possibly-undefined; skip defensively.
      continue;
    }
    if (!ruleMatches(rule.match, input)) {
      continue;
    }

    const baseDecision: PolicyDecision = {
      action: rule.action,
      matchedRule: i,
      reason: `Matched rule ${i} (action: ${rule.action}).`,
      ...(rule.approvers !== undefined ? { approvers: rule.approvers } : {}),
    };

    // CRITICAL hard floor: a matched allow/warn/require_dry_run cannot stand on
    // CRITICAL risk. Override to block and explain. approval_required and block
    // are honored as-is.
    if (
      input.risk === "CRITICAL" &&
      (rule.action === "allow" ||
        rule.action === "warn" ||
        rule.action === "require_dry_run")
    ) {
      return {
        ...baseDecision,
        action: "block",
        reason:
          `Matched rule ${i} (action: ${rule.action}), but CRITICAL risk ` +
          `enforces a hard 'block' floor — only an explicit approval_required ` +
          `rule may permit a CRITICAL command. Overriding '${rule.action}' to 'block'.`,
      };
    }

    return baseDecision;
  }

  // No rule matched: risk-based implicit default.
  const action = defaultActionForRisk(input.risk);
  return {
    action,
    matchedRule: -1,
    reason: `No policy rule matched; applied risk-based default for ${input.risk}: ${action}.`,
  };
}
