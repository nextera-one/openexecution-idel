/**
 * @openexecution/registry — schema-driven parameter coercion (spec §15, §21).
 *
 * The parser is deliberately dumb about types: it leaves every value as the raw
 * string the user typed, except bare `true`/`false` which it turns into real
 * booleans. THIS module finishes the job, driven by the command's
 * {@link ParamSchema}s:
 *
 *  - boolean  — "true"/"false" (case-insensitive) → real boolean
 *  - number   — parseFloat, error on NaN
 *  - mode     — validate an octal permission like 755 / 0755 / 644; kept as the
 *               original string so the adapter passes exactly what was typed
 *  - path     — stays a string (no filesystem touch here; safety resolves later)
 *  - string   — stays a string
 *
 * It then applies defaults for missing optional params, errors on missing
 * required params, validates enums, and handles unknown params per spec §21:
 * extraArgs passthrough is ONLY allowed for LOW/MEDIUM, non-destructive
 * commands. A HIGH/CRITICAL or destructive command with `allowExtraArgs: true`
 * still rejects unknown params (fail closed).
 */

import type {
  CommandDef,
  ParamSchema,
  ParamValue,
} from "@openexecution/types";

export interface CoerceResult {
  /** Coerced, schema-typed params plus any allowed extraArgs passthrough. */
  params: Record<string, ParamValue>;
  /** Human-readable errors; empty array means success. */
  errors: string[];
  /**
   * Unknown params collected as passthrough when `allowExtraArgs` is honored.
   * Empty unless the command permits extras. Surfaced separately so callers
   * can route them to a literal argv tail without re-deriving "what was extra".
   */
  extraArgs: Record<string, string>;
}

/** Octal file mode: optional leading 0, then 3–4 octal digits. e.g. 755, 0644, 1777. */
const MODE_RE = /^0?[0-7]{3,4}$/;

/**
 * `true`/`false` accepted case-insensitively, and the already-parsed boolean
 * values the parser may have produced.
 */
function coerceBoolean(scope: string, raw: ParamValue, errors: string[]): boolean {
  if (typeof raw === "boolean") return raw;
  const s = String(raw).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  errors.push(`${scope}: expected a boolean (true/false), got ${JSON.stringify(raw)}`);
  return false;
}

function coerceNumber(scope: string, raw: ParamValue, errors: string[]): number {
  if (typeof raw === "number") return raw;
  const n = Number.parseFloat(String(raw));
  if (Number.isNaN(n)) {
    errors.push(`${scope}: expected a number, got ${JSON.stringify(raw)}`);
    return 0;
  }
  return n;
}

function coerceMode(scope: string, raw: ParamValue, errors: string[]): string {
  const s = String(raw);
  if (!MODE_RE.test(s)) {
    errors.push(
      `${scope}: expected an octal mode like 755, 0644 or 1777, got ${JSON.stringify(raw)}`,
    );
  }
  // Kept as a string so the adapter emits exactly what the author intended
  // (e.g. preserving a leading 0). Numbers would lose that.
  return s;
}

function coerceOne(
  scope: string,
  schema: ParamSchema,
  raw: ParamValue,
  errors: string[],
): ParamValue {
  switch (schema.type) {
    case "boolean":
      return coerceBoolean(scope, raw, errors);
    case "number":
      return coerceNumber(scope, raw, errors);
    case "mode":
      return coerceMode(scope, raw, errors);
    case "path":
    case "string":
      return String(raw);
  }
}

/**
 * Coerce `rawParams` (raw strings) merged with `alreadyParsed` (the parser's
 * partial typing, e.g. bare booleans) into the schema's declared types.
 *
 * `alreadyParsed` takes precedence as the *source value* for a key, but
 * coercion is always re-run against the schema so a quoted `"true"` for a
 * boolean param is still honored and a number param is still parsed.
 */
export function coerceParams(
  def: CommandDef,
  rawParams: Record<string, string>,
  alreadyParsed: Record<string, ParamValue>,
): CoerceResult {
  const errors: string[] = [];
  const params: Record<string, ParamValue> = {};
  const extraArgs: Record<string, string> = {};

  // The set of keys the user actually supplied (union of both inputs).
  const suppliedKeys = new Set<string>([
    ...Object.keys(rawParams),
    ...Object.keys(alreadyParsed),
  ]);

  // Whether unknown params may pass through. Spec §21: extras are LOW/MEDIUM,
  // never destructive. A HIGH/CRITICAL or destructive command can NOT opt in,
  // even with allowExtraArgs:true — we fail closed.
  const riskAllowsExtras = def.riskDefault === "LOW" || def.riskDefault === "MEDIUM";
  const notDestructive = !def.safety?.destructive;
  const extrasPermitted = Boolean(def.allowExtraArgs) && riskAllowsExtras && notDestructive;

  // 1) Walk the schema: coerce supplied values, apply defaults, flag missing.
  for (const [name, schema] of Object.entries(def.params)) {
    const scope = `param "${name}"`;
    const hasValue = suppliedKeys.has(name);

    if (hasValue) {
      // Prefer the parser's already-typed value as the source; fall back to raw.
      const source: ParamValue =
        name in alreadyParsed
          ? (alreadyParsed[name] as ParamValue)
          : (rawParams[name] as string);
      const value = coerceOne(scope, schema, source, errors);

      if (schema.enum && !schema.enum.some((e) => e === value)) {
        errors.push(
          `${scope}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(value)}`,
        );
      }
      params[name] = value;
      continue;
    }

    // Missing: apply default if any, else error if required.
    if (schema.default !== undefined) {
      params[name] = schema.default;
    } else if (schema.required) {
      errors.push(`${scope}: required parameter is missing`);
    }
    // optional + no default → simply absent.
  }

  // 2) Unknown params: reject, or collect as extraArgs when permitted.
  for (const name of suppliedKeys) {
    if (name in def.params) continue;
    if (extrasPermitted) {
      // Keep the raw string; fall back to stringifying a parsed value.
      const rawVal =
        name in rawParams
          ? (rawParams[name] as string)
          : String(alreadyParsed[name]);
      extraArgs[name] = rawVal;
    } else {
      const why = def.allowExtraArgs
        ? ` (extra args are not permitted on ${def.riskDefault}${def.safety?.destructive ? "/destructive" : ""} commands — spec §21)`
        : "";
      errors.push(`param "${name}": unknown parameter${why}`);
    }
  }

  return { params, errors, extraArgs };
}
