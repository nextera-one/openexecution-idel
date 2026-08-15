import type {
  CommandOrigin,
  ParamValue,
  PolicyMatch,
  RiskLevel,
} from "@openexecution/types";

/**
 * The normalized shape the engine evaluates a policy against. This mirrors the
 * fields a {@link PolicyMatch} can constrain, plus `params` which is always
 * present on the input (an empty object means "no params").
 */
export interface EvaluationInput {
  risk: RiskLevel;
  command: string;
  source: CommandOrigin;
  environment?: string;
  params: Record<string, ParamValue>;
}

/**
 * Does `pattern` match `command`?
 *
 * Three forms are supported (and ONLY these three — we deliberately do not pull in
 * a full glob engine):
 *   - catch-all:     "*" matches every command.
 *   - exact:        "remove.folder" matches only "remove.folder".
 *   - prefix-glob:  a trailing ".*" is a prefix wildcard, so "remove.*" matches
 *                   "remove.folder", "remove.file", etc. The dot before `*` is
 *                   required and is matched literally as a path separator, so
 *                   "remove.*" does NOT match "removed.x" (there is a literal
 *                   "remove." prefix). The bare prefix without the segment,
 *                   e.g. exactly "remove", does not match "remove.*".
 *
 * Everything else is treated as an exact string compare. We intentionally do
 * not interpret "*" anywhere other than a trailing ".*" so that command names
 * containing regex/glob metacharacters can never be misinterpreted.
 */
export function commandMatches(pattern: string, command: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    // Keep the trailing dot in the prefix ("remove." ) so the wildcard only
    // expands a full dotted segment, never a partial token.
    const prefix = pattern.slice(0, -1); // drop the "*", keep the "."
    return command.startsWith(prefix);
  }
  return pattern === command;
}

/**
 * True when EVERY field present in `match` equals the corresponding field on
 * the input. Absent fields in `match` are treated as "don't care".
 *
 * Field semantics:
 *   - risk:        EXACT level equality (not >=). The spec chose explicit exact
 *                  matching to avoid surprising "HIGH rule also fired on
 *                  CRITICAL" behavior; ordering of rules expresses intent
 *                  instead. (If a future minRisk is wanted, add it as a
 *                  separate field — `risk` stays exact.)
 *   - command:     exact OR trailing ".*" prefix-glob (see commandMatches).
 *   - source:      exact equality.
 *   - environment: exact equality. Note: a rule that constrains `environment`
 *                  will NOT match an input that has no environment.
 *   - params:      every key in match.params must be present on the input with
 *                  an equal value. Extra input params are ignored.
 */
export function ruleMatches(match: PolicyMatch, input: EvaluationInput): boolean {
  if (match.risk !== undefined && match.risk !== input.risk) {
    return false;
  }
  if (match.command !== undefined && !commandMatches(match.command, input.command)) {
    return false;
  }
  if (match.source !== undefined && match.source !== input.source) {
    return false;
  }
  if (match.environment !== undefined && match.environment !== input.environment) {
    return false;
  }
  if (match.params !== undefined) {
    for (const key of Object.keys(match.params)) {
      // noUncheckedIndexedAccess: these can be undefined; an absent input param
      // simply fails the equality check, which is the behavior we want.
      const expected = match.params[key];
      const actual = input.params[key];
      if (actual !== expected) {
        return false;
      }
    }
  }
  return true;
}
