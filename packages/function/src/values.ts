/**
 * Input validation and the closed Phase 1 expression evaluator.
 *
 * Evaluation sees only three sources — declared inputs, prior step results,
 * and the admitted actor. It cannot reach the filesystem, the network, the
 * clock (beyond the runtime's own timestamps), or any resource handle it was
 * not given.
 */

import type { Expression, FieldSpec } from "./model.js";

export type IdelValue = string | number | boolean | null | Record<string, unknown>;

/** A typed, deterministic refusal — an outcome, never an internal error. */
export class RefusalError extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "RefusalError";
    this.reason = reason;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a request's literal inputs against the function's declared input
 * fields. Unknown inputs are rejected rather than ignored: silently dropping
 * an input the caller believed was meaningful is how confused-deputy bugs
 * start.
 */
export function validateInputs(
  specs: FieldSpec[],
  supplied: Record<string, string | number | boolean>,
): Record<string, IdelValue> {
  const declared = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) throw new RefusalError("unknown_input", name);
  }

  const result: Record<string, IdelValue> = {};
  for (const spec of specs) {
    const value = supplied[spec.name];
    if (value === undefined) {
      if (spec.required) throw new RefusalError("missing_input", spec.name);
      result[spec.name] = null;
      continue;
    }
    switch (spec.type) {
      case "text":
      case "email":
      case "uuid":
      case "timestamp": {
        if (typeof value !== "string") throw new RefusalError("invalid_input", `${spec.name} must be text`);
        if (spec.minimumLength !== undefined && value.length < spec.minimumLength) {
          throw new RefusalError("invalid_input", `${spec.name} is shorter than ${spec.minimumLength}`);
        }
        if (spec.maximumLength !== undefined && value.length > spec.maximumLength) {
          throw new RefusalError("invalid_input", `${spec.name} is longer than ${spec.maximumLength}`);
        }
        if (spec.type === "email" && !EMAIL.test(value)) {
          throw new RefusalError("invalid_input", `${spec.name} is not an email address`);
        }
        if (spec.type === "uuid" && !UUID.test(value)) {
          throw new RefusalError("invalid_input", `${spec.name} is not a uuid`);
        }
        if (spec.type === "timestamp" && Number.isNaN(Date.parse(value))) {
          throw new RefusalError("invalid_input", `${spec.name} is not a timestamp`);
        }
        break;
      }
      case "integer": {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new RefusalError("invalid_input", `${spec.name} must be an integer`);
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") throw new RefusalError("invalid_input", `${spec.name} must be true or false`);
        break;
      }
      default:
        throw new RefusalError("unsupported_input_type", `${spec.name}: ${spec.type}`);
    }
    result[spec.name] = value;
  }
  return result;
}

export interface EvaluationScope {
  inputs: Record<string, IdelValue>;
  steps: Map<string, IdelValue>;
  actor: string;
  /** Present only while evaluating a row predicate. */
  row?: Record<string, unknown>;
}

/** True when a value carries nothing: null, empty string, or an empty list. */
export function isEmpty(value: IdelValue): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.length === 0;
  return false;
}

/** Evaluate a Phase 1 expression. Throws {@link RefusalError} on bad references. */
export function evaluate(expression: Expression, scope: EvaluationScope): IdelValue {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "actor":
      return scope.actor;
    case "input": {
      if (!(expression.name in scope.inputs)) {
        throw new RefusalError("unknown_input_reference", expression.name);
      }
      return scope.inputs[expression.name] ?? null;
    }
    case "field": {
      if (!scope.row) throw new RefusalError("field_outside_predicate", expression.name);
      return (scope.row[expression.name] ?? null) as IdelValue;
    }
    case "step": {
      if (!scope.steps.has(expression.name)) {
        throw new RefusalError("unknown_step_reference", expression.name);
      }
      const value = scope.steps.get(expression.name) ?? null;
      if (!expression.field) return value;
      if (Array.isArray(value)) {
        const first = value[0] as Record<string, unknown> | undefined;
        return first ? ((first[expression.field] ?? null) as IdelValue) : null;
      }
      if (value && typeof value === "object") {
        return ((value as Record<string, unknown>)[expression.field] ?? null) as IdelValue;
      }
      return null;
    }
    case "empty":
      return isEmpty(evaluate(expression.operand, scope));
    case "equal": {
      const left = evaluate(expression.left, scope);
      const right = evaluate(expression.right, scope);
      return left === right;
    }
  }
}
