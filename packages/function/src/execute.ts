/**
 * The Phase 1 composition executor.
 *
 * Steps run in declared order against a handle set. Every resource touch goes
 * through a handle that exists only because the function declared the matching
 * effect, and every step checks the deadline first, so a runaway composition
 * cannot outlive its declared timeout.
 */

import type { FunctionDefinition, Step } from "./model.js";
import type { HandleSet } from "./handles.js";
import { evaluate, isEmpty, RefusalError, type EvaluationScope, type IdelValue } from "./values.js";

export interface InvokeContext {
  /** Execute a nested function by identity, verifying its digest pin. */
  invoke(
    functionIdentity: string,
    resolvedDigest: string,
    inputs: Record<string, IdelValue>,
  ): Promise<Record<string, IdelValue>>;
}

export interface ExecuteOptions {
  definition: FunctionDefinition;
  handles: HandleSet;
  inputs: Record<string, IdelValue>;
  actor: string;
  invoker?: InvokeContext;
  /** Injected for deterministic tests. */
  now?: () => number;
  timestamp?: () => string;
}

export interface ExecutionTrace {
  step: string;
  kind: Step["kind"];
  durationMs: number;
}

export interface ExecutionResult {
  outputs: Record<string, IdelValue>;
  trace: ExecutionTrace[];
}

export async function executeFunction(options: ExecuteOptions): Promise<ExecutionResult> {
  const { definition, handles, inputs, actor } = options;
  const now = options.now ?? (() => Date.now());
  const timestamp = options.timestamp ?? (() => new Date().toISOString());

  const deadline = now() + definition.limits.timeoutMs;
  const scope: EvaluationScope = { inputs, steps: new Map(), actor };
  const trace: ExecutionTrace[] = [];
  let outputs: Record<string, IdelValue> = {};
  let sawReturn = false;

  for (const step of definition.steps) {
    const started = now();
    if (started > deadline) throw new RefusalError("timeout_exceeded", step.name);

    switch (step.kind) {
      case "query": {
        const handle = handles.read.get(step.entity);
        if (!handle) throw new RefusalError("effect_not_declared", `read ${step.entity}`);
        let rows = handle.read(step.entity);
        if (step.where) {
          const predicate = step.where;
          rows = rows.filter((row) => evaluate(predicate, { ...scope, row }) === true);
        }
        if (step.limit !== undefined) rows = rows.slice(0, step.limit);
        const projected =
          step.select.length === 0
            ? rows
            : rows.map((row) =>
                Object.fromEntries(step.select.map((field) => [field, row[field] ?? null])),
              );
        scope.steps.set(step.name, projected as unknown as IdelValue);
        break;
      }

      case "insert": {
        const handle = handles.write.get(step.entity);
        if (!handle) throw new RefusalError("effect_not_declared", `write ${step.entity}`);
        const values: Record<string, unknown> = {};
        for (const binding of step.values) {
          values[binding.field] = evaluate(binding.value, scope);
        }
        scope.steps.set(step.name, handle.insert(step.entity, values) as unknown as IdelValue);
        break;
      }

      case "guard": {
        const satisfied = evaluate(step.require, scope);
        if (satisfied !== true) throw new RefusalError(step.refusal, step.name);
        scope.steps.set(step.name, true);
        break;
      }

      case "evidence": {
        if (!handles.append) throw new RefusalError("effect_not_declared", "evidence append");
        await handles.append.append({
          event: step.event,
          subject: step.subject ? evaluate(step.subject, scope) : null,
          actor: step.actor ? String(evaluate(step.actor, scope)) : actor,
          timestamp: timestamp(),
        });
        scope.steps.set(step.name, true);
        break;
      }

      case "invoke": {
        const identity = step.functionRef.split("@")[0] as string;
        if (!handles.invoke.has(identity)) {
          throw new RefusalError("effect_not_declared", `invoke ${identity}`);
        }
        if (!options.invoker) throw new RefusalError("invoke_unavailable", identity);
        const nested: Record<string, IdelValue> = {};
        for (const binding of step.inputs) {
          nested[binding.field] = evaluate(binding.value, scope);
        }
        const result = await options.invoker.invoke(identity, step.resolved, nested);
        scope.steps.set(step.name, result as unknown as IdelValue);
        break;
      }

      case "return": {
        outputs = {};
        for (const binding of step.outputs) {
          outputs[binding.field] = evaluate(binding.value, scope);
        }
        sawReturn = true;
        break;
      }
    }

    trace.push({ step: step.name, kind: step.kind, durationMs: now() - started });
    if (sawReturn) break;
  }

  if (!sawReturn) throw new RefusalError("no_return_step", definition.name);

  for (const spec of definition.outputs) {
    if (spec.required && isEmpty(outputs[spec.name] ?? null)) {
      throw new RefusalError("missing_output", spec.name);
    }
  }
  return { outputs, trace };
}
