/**
 * Parser and linter for declarative lowercase IDEL Structure documents.
 *
 * Deliberately dependency-free and self-contained in one module so the
 * compiled output can be embedded verbatim by editor tooling (the VS Code
 * IDEL language extension bundles dist/index.js). The only import is the
 * node:crypto builtin, used by digestStructure.
 */

import { createHash } from "node:crypto";

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export type StructureValue =
  | { kind: "string"; value: string; span: Span }
  | { kind: "number"; value: number; span: Span }
  | { kind: "boolean"; value: boolean; span: Span }
  | { kind: "token"; name: string; span: Span }
  | { kind: "call"; name: string; args: StructureValue[]; chain: ChainSegment[]; span: Span }
  | { kind: "list"; items: StructureValue[]; span: Span };

export interface ChainSegment {
  name: string;
  args: StructureValue[];
}

export interface Assignment {
  kind: "assignment";
  key: string;
  value: StructureValue;
  span: Span;
}

export interface Block {
  kind: "block";
  verb: string;
  label: string | null;
  entries: Entry[];
  span: Span;
}

export interface UseImport {
  kind: "use";
  source: StructureValue;
  alias: string;
  span: Span;
}

export type Entry = Assignment | Block | UseImport;

export interface StructureDocument {
  kind: "document";
  version: string;
  entries: Entry[];
}

export interface StructureDiagnostic {
  severity: "error" | "warning";
  message: string;
  span: Span;
}

export class StructureError extends Error {
  readonly position: Position;

  constructor(message: string, position: Position) {
    super(`${position.line}:${position.column} ${message}`);
    this.name = "StructureError";
    this.position = position;
  }
}

type TokenType =
  | "header"
  | "ident"
  | "string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lbracket"
  | "rbracket"
  | "lparen"
  | "rparen"
  | "comma"
  | "equals"
  | "dot"
  | "eof";

interface Token {
  type: TokenType;
  text: string;
  span: Span;
}

const IDENT_START = /[a-z_]/;
const IDENT_PART = /[a-z0-9_]/;

class Tokenizer {
  private readonly source: string;
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(source: string) {
    this.source = source;
  }

  private position(): Position {
    return { line: this.line, column: this.column, offset: this.offset };
  }

  private advance(): string {
    const character = this.source[this.offset] as string;
    this.offset += 1;
    if (character === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return character;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.offset < this.source.length) {
      const character = this.source[this.offset] as string;
      if (character === " " || character === "\t" || character === "\r" || character === "\n") {
        this.advance();
        continue;
      }
      if (character === "#") {
        while (this.offset < this.source.length && this.source[this.offset] !== "\n") this.advance();
        continue;
      }
      const start = this.position();
      if (character === "@") {
        let text = "";
        this.advance();
        while (this.offset < this.source.length && IDENT_PART.test(this.source[this.offset] as string)) {
          text += this.advance();
        }
        if (text !== "idel") {
          throw new StructureError(`unknown directive "@${text}"`, start);
        }
        tokens.push({ type: "header", text: `@${text}`, span: { start, end: this.position() } });
        continue;
      }
      if (character === '"') {
        this.advance();
        let value = "";
        for (;;) {
          if (this.offset >= this.source.length) {
            throw new StructureError("unterminated string", start);
          }
          const next = this.advance();
          if (next === "\n") throw new StructureError("unterminated string", start);
          if (next === '"') break;
          if (next === "\\") {
            if (this.offset >= this.source.length) {
              throw new StructureError("unterminated string escape", start);
            }
            const escaped = this.advance();
            if (escaped === '"' || escaped === "\\") value += escaped;
            else if (escaped === "b") value += "\b";
            else if (escaped === "f") value += "\f";
            else if (escaped === "n") value += "\n";
            else if (escaped === "r") value += "\r";
            else if (escaped === "t") value += "\t";
            else if (escaped === "u") {
              const hex = this.source.slice(this.offset, this.offset + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                throw new StructureError("invalid unicode string escape", start);
              }
              for (let index = 0; index < 4; index += 1) this.advance();
              value += String.fromCharCode(Number.parseInt(hex, 16));
            }
            else throw new StructureError(`unsupported string escape "\\${escaped}"`, start);
            continue;
          }
          value += next;
        }
        tokens.push({ type: "string", text: value, span: { start, end: this.position() } });
        continue;
      }
      if (/[0-9]/.test(character)) {
        let text = "";
        while (this.offset < this.source.length && /[0-9.]/.test(this.source[this.offset] as string)) {
          text += this.advance();
        }
        if (!/^[0-9]+(\.[0-9]+)*$/.test(text)) {
          throw new StructureError(`invalid number "${text}"`, start);
        }
        tokens.push({ type: "number", text, span: { start, end: this.position() } });
        continue;
      }
      if (IDENT_START.test(character)) {
        let text = "";
        while (this.offset < this.source.length && IDENT_PART.test(this.source[this.offset] as string)) {
          text += this.advance();
        }
        while (
          this.source[this.offset] === "." &&
          this.offset + 1 < this.source.length &&
          IDENT_START.test(this.source[this.offset + 1] as string)
        ) {
          text += this.advance();
          while (this.offset < this.source.length && IDENT_PART.test(this.source[this.offset] as string)) {
            text += this.advance();
          }
        }
        tokens.push({ type: "ident", text, span: { start, end: this.position() } });
        continue;
      }
      if (/[A-Z]/.test(character)) {
        throw new StructureError(
          "IDEL Structure identifiers are lowercase; uppercase is not permitted",
          start,
        );
      }
      const single: Record<string, TokenType> = {
        "{": "lbrace",
        "}": "rbrace",
        "[": "lbracket",
        "]": "rbracket",
        "(": "lparen",
        ")": "rparen",
        ",": "comma",
        "=": "equals",
        ".": "dot",
      };
      const type = single[character];
      if (!type) {
        throw new StructureError(`unexpected character "${character}"`, start);
      }
      this.advance();
      tokens.push({ type, text: character, span: { start, end: this.position() } });
    }
    const end = this.position();
    tokens.push({ type: "eof", text: "", span: { start: end, end } });
    return tokens;
  }
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    if (token.type !== "eof") this.index += 1;
    return token;
  }

  private expect(type: TokenType, description: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new StructureError(
        `expected ${description}, found ${token.type === "eof" ? "end of file" : `"${token.text}"`}`,
        token.span.start,
      );
    }
    return this.next();
  }

  parseDocument(): StructureDocument {
    const header = this.peek();
    if (header.type !== "header") {
      throw new StructureError('an IDEL Structure document must begin with "@idel <version>"', header.span.start);
    }
    this.next();
    const version = this.expect("number", "a structure language version");
    const entries: Entry[] = [];
    while (this.peek().type !== "eof") {
      entries.push(this.parseEntry());
    }
    return { kind: "document", version: version.text, entries };
  }

  private parseEntry(): Entry {
    const name = this.expect("ident", "a block verb or assignment key");
    if (name.text === "use" && this.peek().type === "ident") {
      const source = this.parseValue();
      const keyword = this.expect("ident", '"as"');
      if (keyword.text !== "as") {
        throw new StructureError(`expected "as", found "${keyword.text}"`, keyword.span.start);
      }
      const alias = this.expect("ident", "an import alias");
      return {
        kind: "use",
        source,
        alias: alias.text,
        span: { start: name.span.start, end: alias.span.end },
      };
    }
    const after = this.peek();
    if (after.type === "equals") {
      this.next();
      const value = this.parseValue();
      return {
        kind: "assignment",
        key: name.text,
        value,
        span: { start: name.span.start, end: value.span.end },
      };
    }
    let label: string | null = null;
    if (after.type === "string") {
      label = this.next().text;
    }
    this.expect("lbrace", 'an assignment "=", a block label, or "{"');
    const entries: Entry[] = [];
    while (this.peek().type !== "rbrace") {
      if (this.peek().type === "eof") {
        throw new StructureError(`block "${name.text}" is never closed`, name.span.start);
      }
      entries.push(this.parseEntry());
    }
    const close = this.next();
    return {
      kind: "block",
      verb: name.text,
      label,
      entries,
      span: { start: name.span.start, end: close.span.end },
    };
  }

  private parseValue(): StructureValue {
    const token = this.peek();
    if (token.type === "string") {
      this.next();
      return { kind: "string", value: token.text, span: token.span };
    }
    if (token.type === "number") {
      this.next();
      return { kind: "number", value: Number(token.text), span: token.span };
    }
    if (token.type === "lbracket") {
      this.next();
      const items: StructureValue[] = [];
      while (this.peek().type !== "rbracket") {
        if (this.peek().type === "eof") {
          throw new StructureError("list is never closed", token.span.start);
        }
        items.push(this.parseValue());
        if (this.peek().type === "comma") this.next();
      }
      const close = this.next();
      return { kind: "list", items, span: { start: token.span.start, end: close.span.end } };
    }
    if (token.type === "ident") {
      this.next();
      if (token.text === "true" || token.text === "false") {
        return { kind: "boolean", value: token.text === "true", span: token.span };
      }
      if (this.peek().type !== "lparen") {
        return { kind: "token", name: token.text, span: token.span };
      }
      const args = this.parseArguments();
      const chain: ChainSegment[] = [];
      let end = (this.tokens[this.index - 1] as Token).span.end;
      while (this.peek().type === "dot") {
        this.next();
        const method = this.expect("ident", "a chained call name");
        if (this.peek().type !== "lparen") {
          throw new StructureError(`chained segment "${method.text}" must be a call`, method.span.start);
        }
        chain.push({ name: method.text, args: this.parseArguments() });
        end = (this.tokens[this.index - 1] as Token).span.end;
      }
      return { kind: "call", name: token.text, args, chain, span: { start: token.span.start, end } };
    }
    throw new StructureError(
      `expected a value, found ${token.type === "eof" ? "end of file" : `"${token.text}"`}`,
      token.span.start,
    );
  }

  private parseArguments(): StructureValue[] {
    const open = this.expect("lparen", '"("');
    const args: StructureValue[] = [];
    while (this.peek().type !== "rparen") {
      if (this.peek().type === "eof") {
        throw new StructureError("call is never closed", open.span.start);
      }
      args.push(this.parseValue());
      if (this.peek().type === "comma") this.next();
    }
    this.next();
    return args;
  }
}

/** Parse an IDEL Structure document. Throws {@link StructureError} on invalid input. */
export function parseStructure(source: string): StructureDocument {
  return new Parser(new Tokenizer(source).tokenize()).parseDocument();
}

/**
 * Parse and lint. Never throws: syntax failures are returned as error
 * diagnostics, style issues as warnings. `document` is null when parsing
 * failed. Editor tooling maps these one-to-one onto squiggles.
 */
export function checkStructure(source: string): {
  document: StructureDocument | null;
  diagnostics: StructureDiagnostic[];
} {
  let document: StructureDocument;
  try {
    document = parseStructure(source);
  } catch (error) {
    if (error instanceof StructureError) {
      const position = error.position;
      return {
        document: null,
        diagnostics: [
          {
            severity: "error",
            message: error.message.replace(/^\d+:\d+ /, ""),
            span: { start: position, end: { ...position, column: position.column + 1, offset: position.offset + 1 } },
          },
        ],
      };
    }
    throw error;
  }
  const diagnostics: StructureDiagnostic[] = [];
  const visit = (entry: Entry, depth: number): void => {
    if (entry.kind === "use") return;
    if (entry.kind === "assignment") {
      lintSecretAssignment(entry, diagnostics);
      return;
    }
    const segments = entry.verb.split(".");
    if (segments.length < 2) {
      diagnostics.push({
        severity: "warning",
        message: `block verb "${entry.verb}" should be dotted verb.scope form`,
        span: entry.span,
      });
    }
    if (depth === 0 && segments[0] === "define" && entry.label === null) {
      diagnostics.push({
        severity: "warning",
        message: `top-level "${entry.verb}" block should carry a string label`,
        span: entry.span,
      });
    }
    if (entry.entries.length === 0) {
      diagnostics.push({
        severity: "warning",
        message: `block "${entry.verb}" is empty`,
        span: entry.span,
      });
    }
    for (const child of entry.entries) visit(child, depth + 1);
  };
  for (const entry of document.entries) visit(entry, 0);
  return { document, diagnostics };
}

/**
 * Deterministic canonical text for a parsed document: two-space indentation,
 * one entry per line, comments and incidental whitespace erased, entry order
 * preserved (order is semantic — execute steps run in sequence). Two sources
 * that differ only in formatting canonicalize identically; digests are taken
 * over these bytes so formatting-only edits never change identity.
 */
export function canonicalize(document: StructureDocument): string {
  const lines: string[] = [`@idel ${document.version}`, ""];
  const writeValue = (value: StructureValue): string => {
    switch (value.kind) {
      case "string":
        return quoteStructureString(value.value);
      case "number":
        return String(value.value);
      case "boolean":
        return value.value ? "true" : "false";
      case "token":
        return value.name;
      case "list":
        return `[${value.items.map(writeValue).join(", ")}]`;
      case "call": {
        const head = `${value.name}(${value.args.map(writeValue).join(", ")})`;
        return value.chain.reduce(
          (text, segment) => `${text}.${segment.name}(${segment.args.map(writeValue).join(", ")})`,
          head,
        );
      }
    }
  };
  const writeEntry = (entry: Entry, depth: number): void => {
    const indent = "  ".repeat(depth);
    if (entry.kind === "use") {
      lines.push(`${indent}use ${writeValue(entry.source)} as ${entry.alias}`);
      return;
    }
    if (entry.kind === "assignment") {
      lines.push(`${indent}${entry.key} = ${writeValue(entry.value)}`);
      return;
    }
    const label = entry.label === null ? "" : ` ${quoteStructureString(entry.label)}`;
    if (entry.entries.length === 0) {
      lines.push(`${indent}${entry.verb}${label} {}`);
      return;
    }
    lines.push(`${indent}${entry.verb}${label} {`);
    for (const child of entry.entries) writeEntry(child, depth + 1);
    lines.push(`${indent}}`);
  };
  for (const entry of document.entries) writeEntry(entry, 0);
  return `${lines.join("\n")}\n`;
}

/**
 * Encode one arbitrary JavaScript string as a single IDEL Structure string
 * token. The returned token cannot terminate its surrounding assignment,
 * call, or block label.
 */
export function quoteStructureString(value: string): string {
  let encoded = '"';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    const code = value.charCodeAt(index);
    switch (character) {
      case '"': encoded += '\\"'; break;
      case "\\": encoded += "\\\\"; break;
      case "\b": encoded += "\\b"; break;
      case "\f": encoded += "\\f"; break;
      case "\n": encoded += "\\n"; break;
      case "\r": encoded += "\\r"; break;
      case "\t": encoded += "\\t"; break;
      default:
        encoded += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    }
  }
  return `${encoded}"`;
}

/**
 * Content digest of a Structure source: sha256 over its canonical UTF-8
 * bytes, returned as "sha256:<hex>". Formatting-only edits do not change
 * the digest; any semantic edit (including entry reordering) does.
 */
export function digestStructure(source: string): string {
  const canonical = canonicalize(parseStructure(source));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

const SECRET_LITERAL_KEYS = new Set(["password", "token", "private_key", "api_key"]);

function lintSecretAssignment(entry: Assignment, diagnostics: StructureDiagnostic[]): void {
  if (!SECRET_LITERAL_KEYS.has(entry.key)) return;
  if (entry.value.kind === "call" && entry.value.name === "secret") return;
  diagnostics.push({
    severity: "warning",
    message: `"${entry.key}" must reference secret("secret://…"), never a literal value`,
    span: entry.span,
  });
}
