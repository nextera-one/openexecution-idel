/**
 * Extraction of typed Phase 1 function and run-request models from the
 * generic IDEL Structure AST.
 *
 * Everything this module accepts is a *composition*: there is no expression
 * language, only the closed set of reference forms the standard names
 * (`input(…)`, `step(…)[.field(…)]`, `execution.actor`, `equal(…)`,
 * `empty(…)`, and literals). Anything else is a load error, so an
 * unimplementable document is rejected before admission rather than
 * half-executed.
 */

import {
  digestStructure,
  parseStructure,
  type Assignment,
  type Block,
  type Entry,
  type StructureValue,
} from "@openexecution/structure";

export class FunctionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionLoadError";
  }
}

export type FunctionMode = "query" | "action" | "workflow";
export type EffectKind = "read" | "write" | "append" | "invoke";

export interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  minimumLength?: number;
  maximumLength?: number;
}

export interface CapabilityRequirement {
  name: string;
  scope?: string;
}

export interface EffectGrant {
  kind: EffectKind;
  label: string;
  /** Resource URI for read/write/append; function identity for invoke. */
  resource: string;
  /** Final path segment of a data resource — the entity a step may name. */
  entity?: string;
}

export interface ResourceLimits {
  memoryBytes?: number;
  cpuCores?: number;
  timeoutMs: number;
  maximumRetries: number;
}

export type Expression =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "input"; name: string }
  | { kind: "step"; name: string; field?: string }
  | { kind: "actor" }
  | { kind: "field"; name: string }
  | { kind: "empty"; operand: Expression }
  | { kind: "equal"; left: Expression; right: Expression };

export interface Binding {
  field: string;
  value: Expression;
}

export type Step =
  | { kind: "query"; name: string; entity: string; where?: Expression; select: string[]; limit?: number }
  | { kind: "insert"; name: string; entity: string; values: Binding[] }
  | { kind: "guard"; name: string; require: Expression; refusal: string }
  | { kind: "evidence"; name: string; event: string; subject?: Expression; actor?: Expression }
  | { kind: "invoke"; name: string; functionRef: string; resolved: string; inputs: Binding[] }
  | { kind: "return"; name: string; outputs: Binding[] };

export interface FunctionDefinition {
  name: string;
  identity: string;
  version: string;
  mode: FunctionMode;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  capabilities: CapabilityRequirement[];
  effects: EffectGrant[];
  limits: ResourceLimits;
  steps: Step[];
  digest: string;
}

export interface RunRequest {
  name: string;
  functionRef: string;
  /** Identity without the @version suffix. */
  functionIdentity: string;
  resolved: string;
  inputs: Record<string, string | number | boolean>;
  actor: string;
  requiredCapabilities: string[];
  nonce: string;
  validUntil: string;
  singleUse: boolean;
  runtime?: string;
  evidenceRequired: boolean;
}

// --- AST helpers -------------------------------------------------------------

const blocks = (entries: Entry[], prefix: string): Block[] =>
  entries.filter(
    (entry): entry is Block =>
      entry.kind === "block" && (entry.verb === prefix || entry.verb.startsWith(`${prefix}.`)),
  );

const assignment = (entries: Entry[], key: string): Assignment | undefined =>
  entries.find((entry): entry is Assignment => entry.kind === "assignment" && entry.key === key);

function callArgument(value: StructureValue | undefined, name: string): string | undefined {
  if (value?.kind !== "call" || value.name !== name) return undefined;
  const first = value.args[0];
  return first?.kind === "string" ? first.value : undefined;
}

function requireCallArgument(entries: Entry[], key: string, name: string, context: string): string {
  const found = callArgument(assignment(entries, key)?.value, name);
  if (found === undefined) {
    throw new FunctionLoadError(`${context}: expected ${key} = ${name}("…")`);
  }
  return found;
}

function optionalNumber(entries: Entry[], key: string): number | undefined {
  const value = assignment(entries, key)?.value;
  return value?.kind === "number" ? value.value : undefined;
}

function optionalBoolean(entries: Entry[], key: string): boolean | undefined {
  const value = assignment(entries, key)?.value;
  return value?.kind === "boolean" ? value.value : undefined;
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const DURATION_SCALE: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
const BYTES = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/;
const BYTES_SCALE: Record<string, number> = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 };

function parseScaled(text: string, pattern: RegExp, scale: Record<string, number>, what: string): number {
  const match = pattern.exec(text);
  const factor = match ? scale[match[2] as string] : undefined;
  if (!match || factor === undefined) throw new FunctionLoadError(`invalid ${what} "${text}"`);
  return Number(match[1]) * factor;
}

// --- expressions -------------------------------------------------------------

function readExpression(value: StructureValue | undefined, context: string): Expression {
  if (!value) throw new FunctionLoadError(`${context}: missing value`);
  if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") {
    return { kind: "literal", value: value.value };
  }
  if (value.kind === "token") {
    if (value.name === "execution.actor") return { kind: "actor" };
    throw new FunctionLoadError(`${context}: unsupported token "${value.name}"`);
  }
  if (value.kind !== "call") {
    throw new FunctionLoadError(`${context}: unsupported value`);
  }
  const first = value.args[0];
  switch (value.name) {
    case "input": {
      if (first?.kind !== "string") throw new FunctionLoadError(`${context}: input("…") requires a name`);
      return { kind: "input", name: first.value };
    }
    case "field": {
      if (first?.kind !== "string") throw new FunctionLoadError(`${context}: field("…") requires a name`);
      return { kind: "field", name: first.value };
    }
    case "step": {
      if (first?.kind !== "string") throw new FunctionLoadError(`${context}: step("…") requires a name`);
      const chained = value.chain[0];
      if (value.chain.length > 1) {
        throw new FunctionLoadError(`${context}: only one chained selector is supported`);
      }
      if (!chained) return { kind: "step", name: first.value };
      if (chained.name !== "field") {
        throw new FunctionLoadError(`${context}: unsupported selector ".${chained.name}(…)"`);
      }
      const selector = chained.args[0];
      if (selector?.kind !== "string") {
        throw new FunctionLoadError(`${context}: .field("…") requires a field name`);
      }
      return { kind: "step", name: first.value, field: selector.value };
    }
    case "empty":
      return { kind: "empty", operand: readExpression(first, context) };
    case "equal": {
      const [left, right] = value.args;
      return {
        kind: "equal",
        left: readExpression(left, context),
        right: readExpression(right, context),
      };
    }
    default:
      throw new FunctionLoadError(
        `${context}: "${value.name}(…)" is not part of the Phase 1 composition set`,
      );
  }
}

function readBindings(block: Block, prefix: string): Binding[] {
  return blocks(block.entries, prefix).map((entry) => {
    if (!entry.label) throw new FunctionLoadError(`${entry.verb} requires a field label`);
    return {
      field: entry.label,
      value: readExpression(
        assignment(entry.entries, "value")?.value,
        `${entry.verb} "${entry.label}"`,
      ),
    };
  });
}

// --- function definition -----------------------------------------------------

function readFields(root: Block, prefix: string): FieldSpec[] {
  return blocks(root.entries, prefix).map((entry) => {
    if (!entry.label) throw new FunctionLoadError(`${entry.verb} requires a field label`);
    const type = entry.verb.slice(prefix.length + 1);
    if (!type) throw new FunctionLoadError(`${entry.verb} must name a type, e.g. ${prefix}.text`);
    const spec: FieldSpec = {
      name: entry.label,
      type,
      required: optionalBoolean(entry.entries, "required") ?? false,
    };
    const minimum = optionalNumber(entry.entries, "minimum_length");
    const maximum = optionalNumber(entry.entries, "maximum_length");
    if (minimum !== undefined) spec.minimumLength = minimum;
    if (maximum !== undefined) spec.maximumLength = maximum;
    return spec;
  });
}

function readSteps(root: Block): Step[] {
  return blocks(root.entries, "execute.step").map((block): Step => {
    const name = block.label;
    if (!name) throw new FunctionLoadError(`${block.verb} requires a step label`);
    const context = `${block.verb} "${name}"`;
    const kind = block.verb.slice("execute.step.".length);
    switch (kind) {
      case "query": {
        const entity = requireCallArgument(block.entries, "from", "entity", context);
        const where = assignment(block.entries, "where")?.value;
        const selectValue = assignment(block.entries, "select")?.value;
        const select =
          selectValue?.kind === "list"
            ? selectValue.items.map((item) => {
                if (item.kind !== "string") throw new FunctionLoadError(`${context}: select entries are strings`);
                return item.value;
              })
            : [];
        const step: Step = { kind: "query", name, entity, select };
        if (where) step.where = readExpression(where, context);
        const limit = optionalNumber(block.entries, "limit");
        if (limit !== undefined) step.limit = limit;
        return step;
      }
      case "insert":
        return {
          kind: "insert",
          name,
          entity: requireCallArgument(block.entries, "into", "entity", context),
          values: readBindings(block, "bind.value.field"),
        };
      case "guard": {
        const refusal = callArgument(assignment(block.entries, "otherwise")?.value, "refuse");
        if (!refusal) throw new FunctionLoadError(`${context}: expected otherwise = refuse("…")`);
        return {
          kind: "guard",
          name,
          require: readExpression(assignment(block.entries, "require")?.value, context),
          refusal,
        };
      }
      case "evidence": {
        const event = assignment(block.entries, "event")?.value;
        if (event?.kind !== "string") throw new FunctionLoadError(`${context}: expected event = "…"`);
        const step: Step = { kind: "evidence", name, event: event.value };
        const subject = assignment(block.entries, "subject")?.value;
        const actor = assignment(block.entries, "actor")?.value;
        if (subject) step.subject = readExpression(subject, context);
        if (actor) step.actor = readExpression(actor, context);
        return step;
      }
      case "invoke":
        return {
          kind: "invoke",
          name,
          functionRef: requireCallArgument(block.entries, "function", "idel", context),
          resolved: requireCallArgument(block.entries, "resolved", "digest", context),
          inputs: readBindings(block, "bind.input.field"),
        };
      case "return":
        return { kind: "return", name, outputs: readBindings(block, "bind.output.field") };
      default:
        throw new FunctionLoadError(`${context}: unknown step kind "${kind}"`);
    }
  });
}

function readEffects(root: Block): EffectGrant[] {
  return blocks(root.entries, "allow.effect").map((block): EffectGrant => {
    const label = block.label;
    if (!label) throw new FunctionLoadError(`${block.verb} requires a label`);
    const kind = block.verb.slice("allow.effect.".length) as EffectKind;
    if (!["read", "write", "append", "invoke"].includes(kind)) {
      throw new FunctionLoadError(`${block.verb}: unknown effect kind "${kind}"`);
    }
    if (kind === "invoke") {
      return {
        kind,
        label,
        resource: requireCallArgument(block.entries, "function", "idel", `${block.verb} "${label}"`),
      };
    }
    const resourceValue = assignment(block.entries, "resource")?.value;
    const resource =
      callArgument(resourceValue, "dobase") ??
      callArgument(resourceValue, "evidence") ??
      callArgument(resourceValue, "database");
    if (!resource) {
      throw new FunctionLoadError(`${block.verb} "${label}": expected resource = dobase("…") or evidence("…")`);
    }
    const grant: EffectGrant = { kind, label, resource };
    const entity = resource.split("/").filter(Boolean).pop();
    if (entity) grant.entity = entity;
    return grant;
  });
}

/** Parse and validate a `*.func.idel` source into an executable model. */
export function loadFunction(source: string): FunctionDefinition {
  const document = parseStructure(source);
  const root = document.entries.find(
    (entry): entry is Block => entry.kind === "block" && entry.verb.startsWith("define.function."),
  );
  if (!root) throw new FunctionLoadError("expected a define.function.<mode> block");
  if (!root.label) throw new FunctionLoadError("define.function.<mode> requires a name label");

  const declaredMode = assignment(root.entries, "mode")?.value;
  const modeToken = declaredMode?.kind === "token" ? declaredMode.name : "";
  if (modeToken === "function.pure") {
    throw new FunctionLoadError(
      "function.pure is reserved for Phase 2 and is not executable by this runtime",
    );
  }
  const mode = modeToken.startsWith("function.")
    ? (modeToken.slice("function.".length) as FunctionMode)
    : undefined;
  if (!mode || !["query", "action", "workflow"].includes(mode)) {
    throw new FunctionLoadError(`unsupported mode "${modeToken || "(missing)"}"`);
  }
  if (root.verb !== `define.function.${mode}`) {
    throw new FunctionLoadError(`${root.verb} does not match mode ${modeToken}`);
  }

  const limitsBlock = blocks(root.entries, "limit.execution.resources")[0];
  if (!limitsBlock) throw new FunctionLoadError("limit.execution.resources is required");
  const timeoutText = requireCallArgument(limitsBlock.entries, "timeout", "duration", "limit.execution.resources");
  const limits: ResourceLimits = {
    timeoutMs: parseScaled(timeoutText, DURATION, DURATION_SCALE, "duration"),
    maximumRetries: optionalNumber(limitsBlock.entries, "maximum_retries") ?? 0,
  };
  const memoryText = callArgument(assignment(limitsBlock.entries, "memory")?.value, "bytes");
  const cpuText = callArgument(assignment(limitsBlock.entries, "cpu")?.value, "cores");
  if (memoryText) limits.memoryBytes = parseScaled(memoryText, BYTES, BYTES_SCALE, "byte size");
  if (cpuText) limits.cpuCores = Number(cpuText);

  const effects = readEffects(root);
  const definition: FunctionDefinition = {
    name: root.label,
    identity: requireCallArgument(root.entries, "identity", "idel", `define.function.${mode}`),
    version: requireCallArgument(root.entries, "version", "semver", `define.function.${mode}`),
    mode,
    inputs: readFields(root, "input.field"),
    outputs: readFields(root, "output.field"),
    capabilities: blocks(root.entries, "require.authority.capability").map((block) => {
      if (!block.label) throw new FunctionLoadError("require.authority.capability requires a label");
      const scope = callArgument(assignment(block.entries, "scope")?.value, "dobase");
      return scope === undefined ? { name: block.label } : { name: block.label, scope };
    }),
    effects,
    limits,
    steps: readSteps(root),
    digest: digestStructure(source),
  };

  // Mode is a capability ceiling, enforced at load time so a mislabeled
  // function can never reach admission (conformance idel-function-v1 §5).
  const allowedEffects: Record<FunctionMode, EffectKind[]> = {
    query: ["read"],
    action: ["read", "write", "append"],
    workflow: ["invoke"],
  };
  for (const effect of effects) {
    if (!allowedEffects[mode].includes(effect.kind)) {
      throw new FunctionLoadError(
        `mode function.${mode} may not declare an ${effect.kind} effect ("${effect.label}")`,
      );
    }
  }
  return definition;
}

// --- run request -------------------------------------------------------------

/** Parse and validate a `*.run.idel` execution request. */
export function loadRunRequest(source: string): RunRequest {
  const document = parseStructure(source);
  const root = document.entries.find(
    (entry): entry is Block => entry.kind === "block" && entry.verb === "define.run.request",
  );
  if (!root) throw new FunctionLoadError("expected a define.run.request block");
  if (!root.label) throw new FunctionLoadError("define.run.request requires a label");

  const functionRef = requireCallArgument(root.entries, "function", "idel", "define.run.request");
  const resolved = requireCallArgument(root.entries, "resolved", "digest", "define.run.request");

  const inputs: Record<string, string | number | boolean> = {};
  for (const binding of readBindings(root, "bind.input.field")) {
    if (binding.value.kind !== "literal") {
      throw new FunctionLoadError(`bind.input.field "${binding.field}": run requests bind literal values`);
    }
    inputs[binding.field] = binding.value.value;
  }

  const authority = blocks(root.entries, "require.authority.actor")[0];
  if (!authority) throw new FunctionLoadError("require.authority.actor is required");
  const actor = requireCallArgument(authority.entries, "actor", "idelkey", "require.authority.actor");
  const requireValue = assignment(authority.entries, "require")?.value;
  const requiredCapabilities: string[] = [];
  if (requireValue?.kind === "call" && requireValue.name === "capability") {
    const first = requireValue.args[0];
    if (first?.kind === "string") requiredCapabilities.push(first.value);
  } else if (requireValue?.kind === "list") {
    for (const item of requireValue.items) {
      const name = callArgument(item, "capability");
      if (name) requiredCapabilities.push(name);
    }
  }

  const replay = blocks(root.entries, "protect.request.replay")[0];
  if (!replay) {
    throw new FunctionLoadError("protect.request.replay is required (nonce and valid_until)");
  }
  const nonce = requireCallArgument(replay.entries, "nonce", "nonce", "protect.request.replay");
  const validUntil = requireCallArgument(
    replay.entries,
    "valid_until",
    "timestamp",
    "protect.request.replay",
  );
  if (Number.isNaN(Date.parse(validUntil))) {
    throw new FunctionLoadError(`protect.request.replay: invalid valid_until "${validUntil}"`);
  }

  const target = blocks(root.entries, "configure.execution.target")[0];
  const evidenceToken = target ? assignment(target.entries, "evidence")?.value : undefined;
  const runtime = target
    ? callArgument(assignment(target.entries, "runtime")?.value, "nexrun") ??
      callArgument(assignment(target.entries, "runtime")?.value, "local")
    : undefined;

  const request: RunRequest = {
    name: root.label,
    functionRef,
    functionIdentity: functionRef.split("@")[0] as string,
    resolved,
    inputs,
    actor,
    requiredCapabilities,
    nonce,
    validUntil,
    singleUse: optionalBoolean(replay.entries, "single_use") ?? true,
    evidenceRequired: evidenceToken?.kind === "token" && evidenceToken.name === "evidence.required",
  };
  if (runtime) request.runtime = runtime;
  return request;
}
