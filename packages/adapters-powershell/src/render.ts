/**
 * renderArgv — the canonical structured-argv renderer (spec §22, §28).
 *
 * COPY. The CANONICAL source of truth lives in
 * `packages/adapters-posix/src/render.ts`. This byte-identical copy exists so
 * `@openexecution/adapters-powershell` does not take a runtime dependency on
 * the posix package (both depend only on `@openexecution/types`). If you change
 * one, change the other.
 *
 * Design rule: argv is built by CONDITIONAL ARRAY CONSTRUCTION IN CODE from the
 * declarative {@link AdapterArgSpec} list — never via string templates, never by
 * shell concatenation. Crucially, we NEVER push an empty-string argv element:
 * a missing/empty parameter means "omit this argument entirely", not "pass an
 * empty positional". An empty argv element is never a legitimate argument here.
 */

import type { AdapterSpec, ParamValue } from "@openexecution/types";

export interface RenderArgvOptions {
  /**
   * Insert `--` immediately before the first positional value. This is opt-in
   * because not every CLI accepts `--` in every argument position.
   */
  endOfOptionsBeforeValues?: boolean;
}

/** A param value is "present" when defined and not the empty string. */
function isPresent(value: ParamValue | undefined): value is ParamValue {
  return value !== undefined && value !== "";
}

/**
 * Render a declarative {@link AdapterSpec} to a concrete argv array.
 *
 * @param spec   The adapter spec from the resolved command def.
 * @param params The coerced AST params (string | number | boolean | undefined).
 * @returns A `string[]` with no empty-string elements.
 */
export function renderArgv(
  spec: AdapterSpec,
  params: Record<string, ParamValue>,
  opts: RenderArgvOptions = {},
): string[] {
  const argv: string[] = [];
  let insertedEndOfOptions = false;

  /** Defensive: never let an empty string into argv. */
  const push = (s: string): void => {
    if (s.length > 0) argv.push(s);
  };

  for (const arg of spec.args) {
    switch (arg.kind) {
      case "flag": {
        // Emit the flag ONLY when the boolean param is strictly true.
        if (params[arg.when] === true) push(arg.flag);
        break;
      }
      case "option": {
        // Emit [flag, String(value)] when the param is present; else skip.
        const value = params[arg.param];
        if (isPresent(value)) {
          push(arg.flag);
          push(String(value));
        }
        break;
      }
      case "value": {
        // Emit [String(value)] as one positional when present; else skip.
        const value = params[arg.param];
        if (isPresent(value)) {
          if (opts.endOfOptionsBeforeValues && !insertedEndOfOptions) {
            push("--");
            insertedEndOfOptions = true;
          }
          push(String(value));
        }
        break;
      }
      case "literal": {
        // Always emit the fixed literal.
        push(arg.value);
        break;
      }
      default: {
        // Exhaustiveness guard — surfaces a type error if a new kind is added.
        const _never: never = arg;
        void _never;
      }
    }
  }

  return argv;
}
