/**
 * @openexecution/parser — the IDEL intent-language parser.
 *
 * IDEL lines look like:
 *
 *     create.file name=readme.md
 *     remove.folder name=dist recursive=true force=false
 *     permission.folder.set path=public mode=755 recursive=true
 *     find.files path=. name="*.js" modifiedWithin=7d
 *
 * and a leading `! ` (bang space) marks a native passthrough line:
 *
 *     ! rm -rf dist
 *
 * The parser is deliberately *dumb about types*: numbers stay strings, only
 * bare (unquoted) `true`/`false` become real booleans. Schema-driven coercion
 * (numbers, paths, modes, enums) happens later in the registry layer. We keep
 * the raw string of every parameter in `rawParams` so that the registry and the
 * logging layer can see exactly what the user typed.
 *
 * See spec §13 for the full requirement list.
 */

import type {
  AnyAst,
  CommandAst,
  CommandOrigin,
  NativeCommandAst,
  ParamValue,
} from "@openexecution/types";
import { ParseError } from "@openexecution/types";

// ---------------------------------------------------------------------------
// Public option / token shapes
// ---------------------------------------------------------------------------

/** Options accepted by {@link parse}. */
export interface ParseOptions {
  /** How the command entered the runtime. Defaults to `"idel"`. */
  source?: CommandOrigin;
  /** Absolute working directory the command was issued from. Required. */
  cwd: string;
}

/**
 * A token produced by {@link tokenize}.
 *
 * - `word`  — a bare or quoted run of characters. For quoted tokens the outer
 *   quotes are already stripped and escapes resolved; `value` is the literal
 *   text. The `quoted` flag distinguishes `true` (a bare boolean) from
 *   `"true"` (a quoted string that merely looks like a boolean).
 * - `eq`    — a single `=` separator that sat *outside* of any quotes. Its
 *   `value` is always `"="`.
 */
export interface Token {
  type: "word" | "eq";
  value: string;
  /** True when this `word` originated from a quoted run. Always false for `eq`. */
  quoted: boolean;
  /** Byte offset in the original input where this token began (for diagnostics). */
  offset: number;
}

// ---------------------------------------------------------------------------
// Batch splitting
// ---------------------------------------------------------------------------

/**
 * Split a host-level IDEL batch into individual command lines.
 *
 * `&&` is recognized only at top level. Quoted strings and backslash escapes are
 * preserved verbatim, and native passthrough (`! ...`) remains opaque so shell
 * users do not lose existing behavior like `! echo a && echo b`.
 *
 * @throws {ParseError} when a separator leaves an empty command segment.
 */
export function splitBatch(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed.startsWith("!")) return [trimmed];

  const parts: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "&" && input[i + 1] === "&") {
      pushBatchPart(input.slice(start, i), parts, i);
      i += 1;
      start = i + 1;
    }
  }

  pushBatchPart(input.slice(start), parts, input.length);
  return parts;
}

function pushBatchPart(raw: string, parts: string[], offset: number): void {
  const part = raw.trim();
  if (!part) {
    throw new ParseError("Empty command in batch near `&&`", offset);
  }
  parts.push(part);
}

// ---------------------------------------------------------------------------
// Command-name + key validators
// ---------------------------------------------------------------------------

/**
 * Command names are 2–4 dotted lowercase segments:
 *   verb.scope
 *   verb.scope.action
 *   verb.scope.action.qualifier
 * Each segment is `[a-z][a-z0-9]*`.
 */
const COMMAND_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/;

/** Parameter keys are `[a-z][a-zA-Z0-9]*` (lower-initial, then alnum). */
const KEY_RE = /^[a-z][a-zA-Z0-9]*$/;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split an IDEL line into {@link Token}s while respecting single/double quotes
 * and backslash escapes. Whitespace between tokens is collapsed — any run of
 * spaces/tabs is just a separator. A bare `=` becomes its own `eq` token so the
 * parser can pair `key = value`, but a `=` *inside* a quoted run is literal.
 *
 * This function does NOT understand the `! ` native shorthand — {@link parse}
 * strips that before tokenizing, because everything after `! ` is opaque.
 *
 * @throws {ParseError} on an unterminated quote or a dangling escape.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input[i]!;

    // Skip runs of whitespace between tokens.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    // A standalone `=` separator.
    if (ch === "=") {
      tokens.push({ type: "eq", value: "=", quoted: false, offset: i });
      i += 1;
      continue;
    }

    // Otherwise we are at the start of a word. A word runs until the next
    // unquoted whitespace or unquoted `=`. It may contain quoted spans and
    // escapes, which we resolve into `value` as we go.
    const start = i;
    let value = "";
    let sawQuote = false;

    while (i < len) {
      const c = input[i]!;

      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "=") {
        // Unquoted terminator — stop the word here (handled by outer loop).
        break;
      }

      if (c === '"' || c === "'") {
        // Enter a quoted span; the same quote char closes it.
        const quote = c;
        sawQuote = true;
        const quoteStart = i;
        i += 1; // consume opening quote

        let closed = false;
        while (i < len) {
          const qc = input[i]!;

          if (qc === "\\") {
            // Escape: take the next char literally. A backslash at EOL is an error.
            if (i + 1 >= len) {
              throw new ParseError("Dangling escape at end of input", i);
            }
            value += input[i + 1]!;
            i += 2;
            continue;
          }

          if (qc === quote) {
            // Closing quote.
            i += 1;
            closed = true;
            break;
          }

          value += qc;
          i += 1;
        }

        if (!closed) {
          throw new ParseError(
            `Unterminated ${quote === '"' ? "double" : "single"} quote`,
            quoteStart,
          );
        }
        continue;
      }

      if (c === "\\") {
        // Escape outside quotes: take the next char literally.
        if (i + 1 >= len) {
          throw new ParseError("Dangling escape at end of input", i);
        }
        value += input[i + 1]!;
        i += 2;
        continue;
      }

      // Ordinary character.
      value += c;
      i += 1;
    }

    tokens.push({ type: "word", value, quoted: sawQuote, offset: start });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Value coercion (intentionally minimal)
// ---------------------------------------------------------------------------

/**
 * Coerce a single parameter token to a {@link ParamValue}.
 *
 * Per spec §13.5–6: ONLY bare `true`/`false` become real booleans. Numbers and
 * everything else stay strings — the registry coerces those against a schema.
 * A quoted `"true"` stays the string `"true"`.
 */
function coerceValue(token: Token): ParamValue {
  if (!token.quoted) {
    if (token.value === "true") return true;
    if (token.value === "false") return false;
  }
  return token.value;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single IDEL command line into an {@link AnyAst}.
 *
 * @param input  one IDEL line (a normal command, or `! native …`).
 * @param opts   `{ source?, cwd }` — `cwd` is required.
 * @throws {ParseError} on empty input, a malformed command name, a bad
 *         parameter key, a duplicate key, a `key` without `=value`, or a
 *         tokenizer error (unterminated quote / dangling escape).
 */
export function parse(input: string, opts: ParseOptions): AnyAst {
  const source: CommandOrigin = opts.source ?? "idel";
  const cwd = opts.cwd;

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ParseError("Empty input", 0);
  }

  // --- Native passthrough shorthand: `! <anything>` -------------------------
  // Everything after the bang-space is opaque and is NOT tokenized.
  if (trimmed.startsWith("! ")) {
    const native = trimmed.slice(2).trim();
    if (native.length === 0) {
      throw new ParseError("Native passthrough (`!`) requires a command", 0);
    }
    const ast: NativeCommandAst = {
      command: "native.run",
      native,
      params: {},
      rawParams: {},
      source,
      cwd,
    };
    return ast;
  }
  // A lone `!` (or `!` with no following space) is not a valid native line.
  if (trimmed === "!" || (trimmed.startsWith("!") && !trimmed.startsWith("! "))) {
    throw new ParseError(
      "Native passthrough must be written as `! <command>` (bang then space)",
      0,
    );
  }

  // --- Normal command path --------------------------------------------------
  const tokens = tokenize(trimmed);

  // The tokenizer can only return [] for whitespace-only input, which we
  // already rejected above; guard anyway for completeness.
  const first = tokens[0];
  if (first === undefined) {
    throw new ParseError("Empty input", 0);
  }

  // The command name is the first token. It must be an unquoted word and must
  // not be an `=` separator.
  if (first.type !== "word") {
    throw new ParseError("Expected a command name", first.offset);
  }
  const command = first.value;
  if (first.quoted || !COMMAND_RE.test(command)) {
    throw new ParseError(
      `Invalid command name: ${JSON.stringify(command)} ` +
        `(expected 2–4 dotted segments like "verb.scope" or "verb.scope.action")`,
      first.offset,
    );
  }

  // Remaining tokens are `key = value` triples. We expect the pattern
  // word(key) eq word(value), repeated.
  const params: Record<string, ParamValue> = {};
  const rawParams: Record<string, string> = {};

  let idx = 1;
  while (idx < tokens.length) {
    const keyTok = tokens[idx]!;

    if (keyTok.type !== "word") {
      throw new ParseError("Expected a parameter name", keyTok.offset);
    }
    if (keyTok.quoted || !KEY_RE.test(keyTok.value)) {
      throw new ParseError(
        `Invalid parameter key: ${JSON.stringify(keyTok.value)} ` +
          `(expected [a-z][a-zA-Z0-9]*)`,
        keyTok.offset,
      );
    }

    const eqTok = tokens[idx + 1];
    if (eqTok === undefined || eqTok.type !== "eq") {
      throw new ParseError(
        `Parameter ${JSON.stringify(keyTok.value)} is missing "=value"`,
        keyTok.offset,
      );
    }

    const valTok = tokens[idx + 2];
    if (valTok === undefined || valTok.type !== "word") {
      throw new ParseError(
        `Parameter ${JSON.stringify(keyTok.value)} is missing a value after "="`,
        eqTok.offset,
      );
    }

    const key = keyTok.value;
    if (Object.prototype.hasOwnProperty.call(rawParams, key)) {
      throw new ParseError(`Duplicate parameter key: ${JSON.stringify(key)}`, keyTok.offset);
    }

    // `rawParams` stores the literal post-quote-strip text; `params` stores the
    // (minimally) coerced value. We deliberately do not re-quote the raw value.
    rawParams[key] = valTok.value;
    params[key] = coerceValue(valTok);

    idx += 3;
  }

  const ast: CommandAst = { command, params, rawParams, source, cwd };
  return ast;
}
