/**
 * @openexecution/policy — the policy engine (spec §19, §27).
 *
 * Policy decides what to DO with a risk result: allow, warn, require a dry-run,
 * require approval, or block. It is the layer that makes the team/CI enterprise
 * story possible.
 *
 * Two precedence systems live here and they point in opposite directions:
 *   - Rule selection is FIRST-MATCH-WINS (author ordering = intent).
 *   - The CRITICAL safety floor is non-overridable by a plain allow/warn rule.
 * See {@link evaluate} for the full, commented contract.
 */

export { evaluate } from "./evaluate.js";
export { commandMatches, ruleMatches } from "./match.js";
export type { EvaluationInput } from "./match.js";
export {
  defaultPolicy,
  loadPolicy,
  loadPolicyJson,
  parseSimpleYaml,
  PolicyParseError,
} from "./load.js";
