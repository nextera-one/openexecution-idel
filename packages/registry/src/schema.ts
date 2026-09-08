/**
 * @openexecution/registry — command-definition schema validation (spec §14, §15).
 *
 * Hand-rolled validation (no ajv): we keep the dependency surface tiny and the
 * error messages tuned to the IDEL author's mental model. The validator is the
 * gate the whole runtime trusts, so it FAILS CLOSED (spec §28): an object that
 * does not validate is never tagged with a `.source` and never enters a layer.
 *
 * Two entry points:
 *  - {@link checkCommandDef} returns a structured `{ ok, errors }` result so the
 *    loader can report *which* file failed and why.
 *  - {@link validateCommandDef} is the assertion form used at call sites that
 *    want a thrown {@link RegistryError} (it narrows `unknown` to `CommandDef`).
 */

import type {
  AdapterArgSpec,
  AdapterName,
  AdapterSpec,
  CommandDef,
  ParamSchema,
  ParamType,
  RiskLevel,
  SupportStatus,
} from "@openexecution/types";
import { RegistryError } from "@openexecution/types";

// ---------------------------------------------------------------------------
// Closed sets — single source of truth for "what the type union allows".
// ---------------------------------------------------------------------------

const PARAM_TYPES: readonly ParamType[] = [
  "string",
  "boolean",
  "number",
  "path",
  "mode",
] as const;

const RISK_LEVELS: readonly RiskLevel[] = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

const ADAPTER_NAMES: readonly AdapterName[] = [
  "posix",
  "powershell",
  "node",
] as const;

const ADAPTER_KINDS = ["flag", "option", "value", "literal"] as const;

const SUPPORT_STATUSES: readonly SupportStatus[] = [
  "implemented",
  "requires_adapter_install",
  "requires_capability",
  "unsupported",
  "planned",
] as const;

/**
 * Command ids are 2–4 dotted lowercase segments, mirroring the parser's
 * `COMMAND_RE`. Each segment is `[a-z][a-z0-9]*`.
 */
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/;

/**
 * "semver-ish": MAJOR.MINOR.PATCH with an optional `-prerelease` / `+build`.
 * We are lenient on the metadata tails but insist on the numeric core so a
 * typo'd `"v1"` or empty string is caught.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Categories that are runtime-handled and therefore may carry no adapters. */
const META_CATEGORY = "meta";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Field validators — each pushes scoped messages into `errors`.
// ---------------------------------------------------------------------------

function validateParamSchema(
  name: string,
  raw: unknown,
  errors: string[],
): void {
  const scope = `params.${name}`;
  if (!isObject(raw)) {
    errors.push(`${scope}: must be an object`);
    return;
  }
  if (!PARAM_TYPES.includes(raw.type as ParamType)) {
    errors.push(
      `${scope}.type: must be one of ${PARAM_TYPES.join(", ")} (got ${JSON.stringify(raw.type)})`,
    );
  }
  if (raw.required !== undefined && typeof raw.required !== "boolean") {
    errors.push(`${scope}.required: must be a boolean when present`);
  }
  if (
    raw.default !== undefined &&
    typeof raw.default !== "string" &&
    typeof raw.default !== "number" &&
    typeof raw.default !== "boolean"
  ) {
    errors.push(`${scope}.default: must be a string, number, or boolean`);
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum)) {
      errors.push(`${scope}.enum: must be an array when present`);
    } else if (raw.enum.length === 0) {
      errors.push(`${scope}.enum: must not be empty when present`);
    } else {
      for (const [i, member] of raw.enum.entries()) {
        if (
          typeof member !== "string" &&
          typeof member !== "number" &&
          typeof member !== "boolean"
        ) {
          errors.push(`${scope}.enum[${i}]: must be a string, number, or boolean`);
        }
      }
    }
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    errors.push(`${scope}.description: must be a string when present`);
  }
}

function validateArgSpec(
  adapter: string,
  index: number,
  raw: unknown,
  errors: string[],
): void {
  const scope = `adapters.${adapter}.args[${index}]`;
  if (!isObject(raw)) {
    errors.push(`${scope}: must be an object`);
    return;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !ADAPTER_KINDS.includes(kind as never)) {
    errors.push(
      `${scope}.kind: must be one of ${ADAPTER_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
    );
    return;
  }
  // Each discriminant requires its own fields. This is the structured argv
  // form that REPLACED the old handlebars template strings — so we reject any
  // stray `value`/`flag`/`param` that does not belong to the kind only loosely
  // (extra keys are tolerated, missing required keys are hard errors).
  switch (kind as AdapterArgSpec["kind"]) {
    case "flag":
      if (!isNonEmptyString(raw.flag)) {
        errors.push(`${scope}.flag: 'flag' kind requires a non-empty 'flag' string`);
      }
      if (!isNonEmptyString(raw.when)) {
        errors.push(`${scope}.when: 'flag' kind requires a non-empty 'when' param name`);
      }
      break;
    case "option":
      if (!isNonEmptyString(raw.flag)) {
        errors.push(`${scope}.flag: 'option' kind requires a non-empty 'flag' string`);
      }
      if (!isNonEmptyString(raw.param)) {
        errors.push(`${scope}.param: 'option' kind requires a non-empty 'param' name`);
      }
      break;
    case "value":
      if (!isNonEmptyString(raw.param)) {
        errors.push(`${scope}.param: 'value' kind requires a non-empty 'param' name`);
      }
      break;
    case "literal":
      if (typeof raw.value !== "string" || raw.value.length === 0) {
        errors.push(`${scope}.value: 'literal' kind requires a non-empty 'value' string`);
      }
      break;
  }
}

function validateAdapterSpec(
  name: string,
  raw: unknown,
  errors: string[],
): void {
  const scope = `adapters.${name}`;
  if (!isObject(raw)) {
    errors.push(`${scope}: must be an object`);
    return;
  }
  if (!isNonEmptyString(raw.command)) {
    errors.push(`${scope}.command: must be a non-empty string`);
  } else if (raw.command === "@node" && name !== "node") {
    errors.push(`${scope}.command: @node is only valid on the node adapter`);
  }
  if (!Array.isArray(raw.args)) {
    errors.push(`${scope}.args: must be an array`);
  } else {
    for (const [i, arg] of raw.args.entries()) {
      validateArgSpec(name, i, arg, errors);
    }
  }
  if (raw.semanticNotes !== undefined && typeof raw.semanticNotes !== "string") {
    errors.push(`${scope}.semanticNotes: must be a string when present`);
  }
}

function validateSafety(raw: unknown, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`safety: must be an object when present`);
    return;
  }
  if (raw.destructive !== undefined && typeof raw.destructive !== "boolean") {
    errors.push(`safety.destructive: must be a boolean when present`);
  }
  if (raw.blockTargets !== undefined) {
    if (!Array.isArray(raw.blockTargets) || raw.blockTargets.some((t) => typeof t !== "string")) {
      errors.push(`safety.blockTargets: must be an array of strings when present`);
    }
  }
  if (
    raw.requiresAffectedPathEstimate !== undefined &&
    typeof raw.requiresAffectedPathEstimate !== "boolean"
  ) {
    errors.push(`safety.requiresAffectedPathEstimate: must be a boolean when present`);
  }
  if (raw.targetParam !== undefined && typeof raw.targetParam !== "string") {
    errors.push(`safety.targetParam: must be a string when present`);
  }
}

function validateSupportTarget(
  name: string,
  raw: unknown,
  errors: string[],
): void {
  const scope = `support.targets.${name}`;
  if (!isObject(raw)) {
    errors.push(`${scope}: must be an object`);
    return;
  }
  if (!SUPPORT_STATUSES.includes(raw.status as SupportStatus)) {
    errors.push(
      `${scope}.status: must be one of ${SUPPORT_STATUSES.join(", ")} (got ${JSON.stringify(raw.status)})`,
    );
  }
  if (raw.adapter !== undefined && typeof raw.adapter !== "string") {
    errors.push(`${scope}.adapter: must be a string when present`);
  }
  if (raw.platform !== undefined && typeof raw.platform !== "string") {
    errors.push(`${scope}.platform: must be a string when present`);
  }
  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires) || raw.requires.some((v) => typeof v !== "string")) {
      errors.push(`${scope}.requires: must be an array of strings when present`);
    }
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    errors.push(`${scope}.reason: must be a string when present`);
  }
}

function validateSupport(raw: unknown, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`support: must be an object when present`);
    return;
  }
  if (raw.domain !== undefined && typeof raw.domain !== "string") {
    errors.push(`support.domain: must be a string when present`);
  }
  if (!isObject(raw.targets)) {
    errors.push(`support.targets: must be an object`);
    return;
  }
  const entries = Object.entries(raw.targets);
  if (entries.length === 0) {
    errors.push(`support.targets: must not be empty`);
  }
  for (const [name, target] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      errors.push(`support.targets.${name}: target id must be lowercase alnum plus '.', '_' or '-'`);
    }
    validateSupportTarget(name, target, errors);
  }
}

function hasExternalAdapterSupport(obj: Record<string, unknown>): boolean {
  const support = obj.support;
  if (!isObject(support) || !isObject(support.targets)) return false;
  return Object.values(support.targets).some((target) => {
    if (!isObject(target)) return false;
    return (
      target.status === "requires_adapter_install" ||
      target.status === "requires_capability" ||
      target.status === "planned" ||
      target.status === "unsupported"
    );
  });
}

function validateTests(raw: unknown, errors: string[]): void {
  if (!Array.isArray(raw)) {
    errors.push(`tests: must be an array when present`);
    return;
  }
  for (const [i, t] of raw.entries()) {
    const scope = `tests[${i}]`;
    if (!isObject(t)) {
      errors.push(`${scope}: must be an object`);
      continue;
    }
    if (!isNonEmptyString(t.input)) {
      errors.push(`${scope}.input: must be a non-empty string`);
    }
    if (
      t.expectRisk !== undefined &&
      !RISK_LEVELS.includes(t.expectRisk as RiskLevel)
    ) {
      errors.push(`${scope}.expectRisk: must be a valid risk level when present`);
    }
    // expectPolicy is validated loosely (the policy package owns that union);
    // we just require a string so a typo'd boolean is caught.
    if (t.expectPolicy !== undefined && typeof t.expectPolicy !== "string") {
      errors.push(`${scope}.expectPolicy: must be a policy-action string when present`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a {@link CommandDef}, returning every problem
 * found (not just the first). Pure — never throws.
 */
export function checkCommandDef(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(obj)) {
    return { ok: false, errors: ["definition: must be a JSON object"] };
  }

  // id
  if (typeof obj.id !== "string" || !ID_RE.test(obj.id)) {
    errors.push(
      `id: must match ${ID_RE.source} (2–4 dotted lowercase segments); got ${JSON.stringify(obj.id)}`,
    );
  }

  // version
  if (typeof obj.version !== "string" || !VERSION_RE.test(obj.version)) {
    errors.push(`version: must be a semver-ish string (e.g. "1.0.0"); got ${JSON.stringify(obj.version)}`);
  }

  // summary / category
  if (!isNonEmptyString(obj.summary)) {
    errors.push(`summary: must be a non-empty string`);
  }
  const category = obj.category;
  if (!isNonEmptyString(category)) {
    errors.push(`category: must be a non-empty string`);
  }

  // riskDefault
  if (!RISK_LEVELS.includes(obj.riskDefault as RiskLevel)) {
    errors.push(
      `riskDefault: must be one of ${RISK_LEVELS.join(", ")}; got ${JSON.stringify(obj.riskDefault)}`,
    );
  }

  // params
  if (!isObject(obj.params)) {
    errors.push(`params: must be an object`);
  } else {
    for (const [name, schema] of Object.entries(obj.params)) {
      validateParamSchema(name, schema, errors);
    }
  }

  // allowExtraArgs
  if (obj.allowExtraArgs !== undefined && typeof obj.allowExtraArgs !== "boolean") {
    errors.push(`allowExtraArgs: must be a boolean when present`);
  }

  // safety
  if (obj.safety !== undefined) {
    validateSafety(obj.safety, errors);
  }

  if (obj.support !== undefined) {
    validateSupport(obj.support, errors);
  }

  // adapters — keys must be known adapter names. Empty adapters are allowed
  // for the `meta` category (runtime-intercepted commands), or when the def has
  // an explicit support matrix showing that execution is delegated to
  // installable/external adapters.
  if (!isObject(obj.adapters)) {
    errors.push(`adapters: must be an object (use {} for meta commands)`);
  } else {
    const keys = Object.keys(obj.adapters);
    for (const key of keys) {
      if (!ADAPTER_NAMES.includes(key as AdapterName)) {
        errors.push(
          `adapters.${key}: unknown adapter (allowed: ${ADAPTER_NAMES.join(", ")})`,
        );
        continue;
      }
      validateAdapterSpec(key, (obj.adapters as Record<string, unknown>)[key], errors);
    }
    if (
      keys.length === 0 &&
      category !== META_CATEGORY &&
      !hasExternalAdapterSupport(obj)
    ) {
      errors.push(
        `adapters: must declare at least one adapter unless category is "${META_CATEGORY}" or support declares external adapter coverage`,
      );
    }
  }

  // examples
  if (obj.examples !== undefined) {
    if (!Array.isArray(obj.examples) || obj.examples.some((e) => typeof e !== "string")) {
      errors.push(`examples: must be an array of strings when present`);
    }
  }

  // tests
  if (obj.tests !== undefined) {
    validateTests(obj.tests, errors);
  }

  // source (optional; set by the loader, but tolerate it on disk)
  if (
    obj.source !== undefined &&
    obj.source !== "core" &&
    obj.source !== "official" &&
    obj.source !== "custom"
  ) {
    errors.push(`source: must be one of core, official, custom when present`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Assertion form: narrow `unknown` to {@link CommandDef} or throw a
 * {@link RegistryError} with all problems. Fails closed.
 */
export function validateCommandDef(obj: unknown): asserts obj is CommandDef {
  const { ok, errors } = checkCommandDef(obj);
  if (!ok) {
    const id = isObject(obj) && typeof obj.id === "string" ? obj.id : "<unknown>";
    throw new RegistryError(
      `invalid command definition "${id}":\n  - ${errors.join("\n  - ")}`,
    );
  }
}

// Re-export the closed sets so the loader/coercer share one source of truth.
export {
  PARAM_TYPES,
  RISK_LEVELS,
  ADAPTER_NAMES,
  ADAPTER_KINDS,
  SUPPORT_STATUSES,
  ID_RE,
  VERSION_RE,
  META_CATEGORY,
};

// Type-only re-exports to keep validateAdapterSpec's signature honest under
// verbatimModuleSyntax (referenced in JSDoc only).
export type { AdapterSpec, ParamSchema };
