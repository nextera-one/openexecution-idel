import type {
  CommandOrigin,
  ParamValue,
  PolicyAction,
  PolicyConfig,
  PolicyMatch,
  PolicyRule,
  RiskLevel,
} from "@openexecution/types";

/** Thrown when a policy document cannot be parsed into a valid PolicyConfig. */
export class PolicyParseError extends Error {
  override readonly name = "PolicyParseError";
}

const RISK_LEVELS: readonly RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const COMMAND_ORIGINS: readonly CommandOrigin[] = ["idel", "native", "ci", "api"];
const CANONICAL_ACTIONS: readonly PolicyAction[] = [
  "allow",
  "warn",
  "require_dry_run",
  "approval_required",
  "block",
];

/**
 * Action-name normalization (spec §19).
 *
 * The spec's example YAML uses friendlier action names than the type union:
 *   - `approval`        -> `approval_required`
 *   - `scan_then_warn`  -> `warn`
 * Canonical names are accepted unchanged. Anything else is rejected so typos
 * fail loudly rather than silently defaulting.
 */
const ACTION_ALIASES: Readonly<Record<string, PolicyAction>> = {
  approval: "approval_required",
  scan_then_warn: "warn",
};

function normalizeAction(raw: string): PolicyAction {
  if (raw in ACTION_ALIASES) {
    // Safe: key guarded by `in` against the alias table.
    return ACTION_ALIASES[raw]!;
  }
  if ((CANONICAL_ACTIONS as readonly string[]).includes(raw)) {
    return raw as PolicyAction;
  }
  throw new PolicyParseError(
    `Unknown policy action "${raw}". Expected one of ${CANONICAL_ACTIONS.join(
      ", ",
    )} (or the aliases ${Object.keys(ACTION_ALIASES).join(", ")}).`,
  );
}

// ---------------------------------------------------------------------------
// Validation of an already-structured (JSON-or-YAML-derived) object
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asParamValue(value: unknown, ctx: string): ParamValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new PolicyParseError(
    `${ctx}: expected a string, number, or boolean, got ${typeof value}.`,
  );
}

function buildMatch(raw: unknown): PolicyMatch {
  if (!isPlainObject(raw)) {
    throw new PolicyParseError(`rule.match must be an object.`);
  }
  const match: PolicyMatch = {};

  if (raw.risk !== undefined) {
    const risk = raw.risk;
    if (typeof risk !== "string" || !(RISK_LEVELS as readonly string[]).includes(risk)) {
      throw new PolicyParseError(
        `match.risk must be one of ${RISK_LEVELS.join(", ")}, got ${JSON.stringify(risk)}.`,
      );
    }
    match.risk = risk as RiskLevel;
  }

  if (raw.command !== undefined) {
    if (typeof raw.command !== "string") {
      throw new PolicyParseError(`match.command must be a string.`);
    }
    match.command = raw.command;
  }

  if (raw.source !== undefined) {
    const source = raw.source;
    if (
      typeof source !== "string" ||
      !(COMMAND_ORIGINS as readonly string[]).includes(source)
    ) {
      throw new PolicyParseError(
        `match.source must be one of ${COMMAND_ORIGINS.join(", ")}, got ${JSON.stringify(source)}.`,
      );
    }
    match.source = source as CommandOrigin;
  }

  if (raw.environment !== undefined) {
    if (typeof raw.environment !== "string") {
      throw new PolicyParseError(`match.environment must be a string.`);
    }
    match.environment = raw.environment;
  }

  if (raw.params !== undefined) {
    if (!isPlainObject(raw.params)) {
      throw new PolicyParseError(`match.params must be an object.`);
    }
    const params: Record<string, ParamValue> = {};
    for (const key of Object.keys(raw.params)) {
      params[key] = asParamValue(raw.params[key], `match.params.${key}`);
    }
    match.params = params;
  }

  return match;
}

function buildRule(raw: unknown, index: number): PolicyRule {
  if (!isPlainObject(raw)) {
    throw new PolicyParseError(`rules[${index}] must be an object.`);
  }
  if (raw.action === undefined) {
    throw new PolicyParseError(`rules[${index}] is missing required "action".`);
  }
  if (typeof raw.action !== "string") {
    throw new PolicyParseError(`rules[${index}].action must be a string.`);
  }

  const rule: PolicyRule = {
    match: buildMatch(raw.match ?? {}),
    action: normalizeAction(raw.action),
  };

  if (raw.approvers !== undefined) {
    if (
      !Array.isArray(raw.approvers) ||
      !raw.approvers.every((a): a is string => typeof a === "string")
    ) {
      throw new PolicyParseError(`rules[${index}].approvers must be an array of strings.`);
    }
    rule.approvers = raw.approvers;
  }

  return rule;
}

/**
 * Validate and normalize an arbitrary parsed value (from JSON or YAML) into a
 * PolicyConfig. Applies action-name normalization and rejects unknown shapes.
 */
function buildConfig(raw: unknown): PolicyConfig {
  if (!isPlainObject(raw)) {
    throw new PolicyParseError(`Policy document must be an object with a "rules" array.`);
  }
  if (!Array.isArray(raw.rules)) {
    throw new PolicyParseError(`Policy document must have a "rules" array.`);
  }
  const rules = raw.rules.map((r, i) => buildRule(r, i));
  return { rules };
}

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser
// ---------------------------------------------------------------------------

/**
 * A deliberately tiny YAML parser — JUST enough to handle the §19 policy
 * example shape and reasonable variations of it. It is NOT a general YAML
 * implementation; if you need full YAML, install a real library.
 *
 * Supported subset:
 *   - 2-space (or any consistent) indentation for nesting.
 *   - block mappings: `key: value` and `key:` (nested block on following lines).
 *   - block sequences: `- value` and `- key: value` (a list of mappings).
 *   - inline flow sequences for scalars: `["a", "b"]` / `[a, b]`.
 *   - scalar coercion: true/false -> boolean, integers/floats -> number,
 *     quoted strings keep their text, everything else is a bare string.
 *   - `#` line comments and blank lines are ignored.
 *
 * NOT supported (and will usually error or mis-parse — out of scope by design):
 *   block literals (`|`, `>`), anchors/aliases, inline flow mappings (`{a: 1}`),
 *   multi-document streams, complex keys.
 */
export function parseSimpleYaml(text: string): unknown {
  interface Line {
    indent: number;
    content: string;
    lineNo: number;
  }

  const lines: Line[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i] ?? "";
    const stripped = stripComment(rawLine);
    if (stripped.trim() === "") {
      continue;
    }
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, content: stripped.trim(), lineNo: i + 1 });
  }

  if (lines.length === 0) {
    return {};
  }

  // Recursive-descent over the indented line list. `parseBlock` consumes all
  // consecutive lines indented at exactly `indent` (and their deeper children),
  // returning the parsed value and the index of the first unconsumed line.
  function parseBlock(start: number, indent: number): { value: unknown; next: number } {
    const first = lines[start];
    if (first === undefined) {
      return { value: null, next: start };
    }

    if (first.content.startsWith("- ") || first.content === "-") {
      return parseSequence(start, indent);
    }
    return parseMapping(start, indent);
  }

  function parseMapping(start: number, indent: number): { value: unknown; next: number } {
    const map: Record<string, unknown> = {};
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        throw new PolicyParseError(
          `YAML line ${line.lineNo}: unexpected indentation in mapping.`,
        );
      }
      if (line.content.startsWith("- ")) {
        throw new PolicyParseError(
          `YAML line ${line.lineNo}: sequence item not allowed where a mapping key was expected.`,
        );
      }

      const colon = findKeyColon(line.content);
      if (colon === -1) {
        throw new PolicyParseError(
          `YAML line ${line.lineNo}: expected "key: value" in mapping.`,
        );
      }
      const key = line.content.slice(0, colon).trim();
      const valuePart = line.content.slice(colon + 1).trim();

      if (valuePart === "") {
        // Nested block on the following deeper-indented lines.
        const child = nextChild(i, indent);
        if (child === undefined) {
          map[key] = null;
          i += 1;
        } else {
          const result = parseBlock(child.index, child.indent);
          map[key] = result.value;
          i = result.next;
        }
      } else {
        map[key] = parseScalarOrFlow(valuePart, line.lineNo);
        i += 1;
      }
    }
    return { value: map, next: i };
  }

  function parseSequence(start: number, indent: number): { value: unknown; next: number } {
    const arr: unknown[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        throw new PolicyParseError(
          `YAML line ${line.lineNo}: unexpected indentation in sequence.`,
        );
      }
      if (!line.content.startsWith("- ") && line.content !== "-") {
        break;
      }

      const itemBody = line.content === "-" ? "" : line.content.slice(2).trim();

      if (itemBody === "") {
        // "-" alone: the item is the nested block beneath it.
        const child = nextChild(i, indent);
        if (child === undefined) {
          arr.push(null);
          i += 1;
        } else {
          const result = parseBlock(child.index, child.indent);
          arr.push(result.value);
          i = result.next;
        }
        continue;
      }

      const colon = findKeyColon(itemBody);
      if (colon !== -1) {
        // "- key: value" — an inline mapping whose first key sits on this line.
        // The key's column is `indent + 2`; subsequent sibling keys of the same
        // mapping are indented to that column. Synthesize by reparsing the
        // remaining lines as a mapping starting from a virtual entry.
        const result = parseInlineMappingItem(i, indent);
        arr.push(result.value);
        i = result.next;
      } else {
        arr.push(parseScalarOrFlow(itemBody, line.lineNo));
        i += 1;
      }
    }
    return { value: arr, next: i };
  }

  // Handles `- key: value` plus any continuation keys at column indent+2, and
  // nested blocks under those keys.
  function parseInlineMappingItem(
    start: number,
    seqIndent: number,
  ): { value: unknown; next: number } {
    const keyIndent = seqIndent + 2;
    const map: Record<string, unknown> = {};
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) break;

      // First line of the item carries the "- " marker.
      const isFirst = i === start;
      const effectiveIndent = isFirst ? keyIndent : line.indent;
      const content = isFirst ? line.content.slice(2).trim() : line.content;

      if (!isFirst) {
        if (line.indent < keyIndent) break; // mapping ended
        if (line.content.startsWith("- ")) break; // next sequence item handled by caller
        if (line.indent > keyIndent) {
          throw new PolicyParseError(
            `YAML line ${line.lineNo}: unexpected indentation inside list item.`,
          );
        }
      }

      const colon = findKeyColon(content);
      if (colon === -1) {
        throw new PolicyParseError(
          `YAML line ${line.lineNo}: expected "key: value" inside list item.`,
        );
      }
      const key = content.slice(0, colon).trim();
      const valuePart = content.slice(colon + 1).trim();

      if (valuePart === "") {
        const child = nextChild(i, effectiveIndent);
        if (child === undefined) {
          map[key] = null;
          i += 1;
        } else {
          const result = parseBlock(child.index, child.indent);
          map[key] = result.value;
          i = result.next;
        }
      } else {
        map[key] = parseScalarOrFlow(valuePart, line.lineNo);
        i += 1;
      }
    }

    return { value: map, next: i };
  }

  // Find the first line after `index` that is indented deeper than `indent`.
  function nextChild(
    index: number,
    indent: number,
  ): { index: number; indent: number } | undefined {
    const next = lines[index + 1];
    if (next === undefined || next.indent <= indent) {
      return undefined;
    }
    return { index: index + 1, indent: next.indent };
  }

  const root = parseBlock(0, lines[0]!.indent);
  return root.value;
}

/** Strip a trailing `#` comment, but not a `#` inside quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      // A comment must be at line start or preceded by whitespace.
      if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/** Index of the `:` that separates a mapping key from its value, ignoring quotes. */
function findKeyColon(content: string): number {
  let inSingle = false;
  let inDouble = false;
  let inBracket = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "[" && !inSingle && !inDouble) inBracket++;
    else if (ch === "]" && !inSingle && !inDouble) inBracket--;
    else if (ch === ":" && !inSingle && !inDouble && inBracket === 0) {
      // A YAML key/value colon is followed by EOL or whitespace.
      const next = content[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        return i;
      }
    }
  }
  return -1;
}

/** Parse a scalar value, an inline flow sequence (`[a, b]`), or empty `{}`. */
function parseScalarOrFlow(text: string, lineNo: number): unknown {
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) {
      throw new PolicyParseError(`YAML line ${lineNo}: malformed flow sequence ${text}.`);
    }
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowItems(inner).map((item) => parseScalar(item.trim()));
  }
  // Empty flow mapping `{}` — the only flow-mapping form we accept. A non-empty
  // `{a: 1}` is still out of scope (use the block form), but `match: {}` is
  // idiomatic enough (it means "match anything") that we support it explicitly.
  if (text === "{}") {
    return {};
  }
  return parseScalar(text);
}

/** Split `a, "b, c", d` on top-level commas (commas inside quotes are kept). */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "," && !inSingle && !inDouble) {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items;
}

/** Coerce a bare/quoted YAML scalar to string | number | boolean. */
function parseScalar(text: string): ParamValue {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  // Integers and simple floats become numbers; anything else stays a string.
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------

/**
 * Parse a policy document that is strictly JSON. Useful when the caller knows
 * the source format and wants to skip YAML heuristics.
 */
export function loadPolicyJson(json: string): PolicyConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new PolicyParseError(
      `Policy JSON is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return buildConfig(parsed);
}

/**
 * Parse a policy file that is EITHER JSON or the minimal YAML subset.
 *
 * Detection: if the trimmed text starts with `{` or `[` we treat it as JSON;
 * otherwise we run the YAML-subset parser. Both paths funnel through the same
 * validation + action-normalization, so the resulting PolicyConfig is identical
 * regardless of source format.
 */
export function loadPolicy(yamlOrJson: string): PolicyConfig {
  const trimmed = yamlOrJson.trim();
  if (trimmed === "") {
    throw new PolicyParseError(`Policy document is empty.`);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return loadPolicyJson(yamlOrJson);
  }
  const parsed = parseSimpleYaml(yamlOrJson);
  return buildConfig(parsed);
}

/**
 * A sensible built-in policy (spec §27 "sensible default"):
 *   1. CRITICAL          -> block
 *   2. HIGH              -> require_dry_run
 *   3. native source     -> warn (native passthrough is scanned but allowed)
 *   4. everything else   -> allow
 *
 * Order matters because of first-match-wins: the CRITICAL/HIGH rules sit above
 * the broad `allow` catch-all so they take precedence.
 */
export function defaultPolicy(): PolicyConfig {
  return {
    rules: [
      { match: { risk: "CRITICAL" }, action: "block" },
      { match: { risk: "HIGH" }, action: "require_dry_run" },
      { match: { source: "native" }, action: "warn" },
      { match: {}, action: "allow" },
    ],
  };
}
