export interface StructureDocument {
  languageVersion: string;
  uses: StructureUse[];
  commands: StructureCommand[];
}

export interface StructureUse {
  source: StructureValue;
  alias?: string;
}

export interface StructureCommand {
  name: string;
  label?: string;
  assignments: StructureAssignment[];
  commands: StructureCommand[];
}

export interface StructureAssignment {
  path: string;
  value: StructureValue;
}

export interface StructureConstructor {
  kind: "constructor";
  name: string;
  arguments: StructureValue[];
}

export interface StructureEnum {
  kind: "enum";
  name: string;
}

export type StructureValue =
  | string
  | number
  | boolean
  | StructureConstructor
  | StructureEnum
  | StructureValue[];

type TokenKind =
  | "identifier"
  | "string"
  | "number"
  | "{"
  | "}"
  | "["
  | "]"
  | "("
  | ")"
  | "="
  | ","
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
}

const IDENTIFIER = /^[A-Za-z_@][A-Za-z0-9_.:@/-]*$/;
const COMMAND = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const FIELD_PATH = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const CONSTRUCTOR = /^[a-z][a-z0-9_]*$/;
const NATIVE_VALUE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const ALIAS = /^[a-z][a-z0-9_]*$/;

export class StructureSyntaxError extends Error {
  override readonly name = "StructureSyntaxError";

  constructor(
    readonly code: string,
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${line}:${column}: ${message}`);
  }
}

export function parseStructure(source: string): StructureDocument {
  return new Parser(tokenize(source)).document();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  document(): StructureDocument {
    const header = this.take("identifier", "IDEL_STRUCTURE_HEADER_REQUIRED");
    if (header.text !== "@idel") {
      this.fail(
        header,
        "IDEL_STRUCTURE_HEADER_REQUIRED",
        "document must begin with @idel <major.minor>",
      );
    }
    const version = this.take("number", "IDEL_STRUCTURE_VERSION_REQUIRED");
    if (!/^[0-9]+\.[0-9]+$/.test(version.text)) {
      this.fail(
        version,
        "IDEL_STRUCTURE_INVALID_VERSION",
        "language version must be major.minor",
      );
    }
    if (version.text !== "1.0") {
      this.fail(
        version,
        "IDEL_STRUCTURE_UNSUPPORTED_VERSION",
        `unsupported IDEL Structure version ${version.text}`,
      );
    }

    const uses: StructureUse[] = [];
    const commands: StructureCommand[] = [];
    while (!this.at("eof")) {
      if (this.current().kind === "identifier" &&
          this.current().text === "use") {
        uses.push(this.use());
      } else {
        commands.push(this.command());
      }
    }
    if (commands.length === 0) {
      this.fail(
        this.current(),
        "IDEL_STRUCTURE_COMMAND_REQUIRED",
        "document must contain at least one command",
      );
    }
    return { languageVersion: version.text, uses, commands };
  }

  private use(): StructureUse {
    this.take("identifier");
    const source = this.expression();
    if (this.current().kind === "identifier" && this.current().text === "as") {
      this.take("identifier");
      const alias = this.take("identifier", "IDEL_STRUCTURE_ALIAS_REQUIRED");
      if (!ALIAS.test(alias.text)) {
        this.fail(
          alias,
          "IDEL_STRUCTURE_INVALID_ALIAS",
          "aliases must be lowercase native identifiers",
        );
      }
      return { source, alias: alias.text };
    }
    return { source };
  }

  private command(): StructureCommand {
    const name = this.take("identifier", "IDEL_STRUCTURE_COMMAND_EXPECTED");
    if (name.text === "use" || name.text === "@idel") {
      this.fail(
        name,
        "IDEL_STRUCTURE_INVALID_COMMAND",
        `${name.text} is not valid in this position`,
      );
    }
    if (!COMMAND.test(name.text)) {
      this.fail(
        name,
        "IDEL_STRUCTURE_INVALID_COMMAND_NAME",
        "commands must be lowercase dotted identifiers",
      );
    }
    const label = this.at("string") ? this.take("string").text : undefined;
    this.take("{", "IDEL_STRUCTURE_BLOCK_REQUIRED");
    const assignments: StructureAssignment[] = [];
    const commands: StructureCommand[] = [];
    const assigned = new Set<string>();

    while (!this.at("}")) {
      if (this.at("eof")) {
        this.fail(
          this.current(),
          "IDEL_STRUCTURE_UNCLOSED_BLOCK",
          `command ${name.text} is missing }`,
        );
      }
      const first = this.current();
      const second = this.tokens[this.index + 1];
      if (first.kind === "identifier" && second?.kind === "=") {
        if (!FIELD_PATH.test(first.text)) {
          this.fail(
            first,
            "IDEL_STRUCTURE_INVALID_FIELD_PATH",
            `${first.text} is not a lowercase snake_case field path`,
          );
        }
        this.take("identifier");
        this.take("=");
        if (assigned.has(first.text)) {
          this.fail(
            first,
            "IDEL_STRUCTURE_DUPLICATE_FIELD",
            `field ${first.text} is assigned more than once`,
          );
        }
        assigned.add(first.text);
        assignments.push({ path: first.text, value: this.expression() });
      } else {
        commands.push(this.command());
      }
    }
    this.take("}");
    return {
      name: name.text,
      ...(label === undefined ? {} : { label }),
      assignments,
      commands,
    };
  }

  private expression(): StructureValue {
    const token = this.current();
    if (token.kind === "string") {
      this.index++;
      return token.text;
    }
    if (token.kind === "number") {
      this.index++;
      const value = Number(token.text);
      if (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        this.fail(
          token,
          "IDEL_STRUCTURE_INVALID_NUMBER",
          `number ${token.text} is outside the supported range`,
        );
      }
      return value;
    }
    if (token.kind === "[") return this.list();
    if (token.kind === "identifier") {
      this.index++;
      if (token.text === "true") return true;
      if (token.text === "false") return false;
      if (this.at("(")) {
        if (!CONSTRUCTOR.test(token.text)) {
          this.fail(
            token,
            "IDEL_STRUCTURE_INVALID_CONSTRUCTOR",
            "constructors must be lowercase native identifiers",
          );
        }
        this.take("(");
        const args: StructureValue[] = [];
        while (!this.at(")")) {
          args.push(this.expression());
          if (this.at(",")) {
            this.take(",");
          } else if (!this.at(")")) {
            this.fail(
              this.current(),
              "IDEL_STRUCTURE_COMMA_REQUIRED",
              "constructor arguments must be separated by commas",
            );
          }
        }
        this.take(")");
        return { kind: "constructor", name: token.text, arguments: args };
      }
      if (!NATIVE_VALUE.test(token.text)) {
        this.fail(
          token,
          "IDEL_STRUCTURE_INVALID_NATIVE_VALUE",
          "enum values and native identifiers must be lowercase",
        );
      }
      return { kind: "enum", name: token.text };
    }
    this.fail(
      token,
      "IDEL_STRUCTURE_EXPRESSION_EXPECTED",
      `expected a typed expression, received ${token.kind}`,
    );
  }

  private list(): StructureValue[] {
    this.take("[");
    const values: StructureValue[] = [];
    while (!this.at("]")) {
      values.push(this.expression());
      if (this.at(",")) {
        this.take(",");
      } else if (!this.at("]")) {
        this.fail(
          this.current(),
          "IDEL_STRUCTURE_COMMA_REQUIRED",
          "list values must be separated by commas",
        );
      }
    }
    this.take("]");
    return values;
  }

  private current(): Token {
    return this.tokens[this.index]!;
  }

  private at(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private take(kind: TokenKind, code = "IDEL_STRUCTURE_UNEXPECTED_TOKEN"): Token {
    const token = this.current();
    if (token.kind !== kind) {
      this.fail(token, code, `expected ${kind}, received ${token.kind}`);
    }
    this.index++;
    return token;
  }

  private fail(token: Token, code: string, message: string): never {
    throw new StructureSyntaxError(code, message, token.line, token.column);
  }
}

function tokenize(source: string): Token[] {
  if (source.charCodeAt(0) === 0xfeff) {
    throw new StructureSyntaxError(
      "IDEL_STRUCTURE_BOM_FORBIDDEN",
      "UTF-8 byte order marks are forbidden",
      1,
      1,
    );
  }
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (): string => {
    const character = source[index++]!;
    if (character === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return character;
  };

  while (index < source.length) {
    const character = source[index]!;
    if (/\s/u.test(character)) {
      advance();
      continue;
    }
    if (character === "#" ||
        (character === "/" && source[index + 1] === "/")) {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    const tokenLine = line;
    const tokenColumn = column;
    if ("{}[]=(),".includes(character)) {
      tokens.push({
        kind: character as TokenKind,
        text: advance(),
        line: tokenLine,
        column: tokenColumn,
      });
      continue;
    }
    if (character === "\"") {
      const start = index;
      advance();
      let escaped = false;
      while (index < source.length) {
        const current = advance();
        if (!escaped && current === "\"") break;
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
      }
      const raw = source.slice(start, index);
      if (!raw.endsWith("\"")) {
        throw new StructureSyntaxError(
          "IDEL_STRUCTURE_UNCLOSED_STRING",
          "string literal is missing a closing quote",
          tokenLine,
          tokenColumn,
        );
      }
      try {
        tokens.push({
          kind: "string",
          text: JSON.parse(raw) as string,
          line: tokenLine,
          column: tokenColumn,
        });
      } catch {
        throw new StructureSyntaxError(
          "IDEL_STRUCTURE_INVALID_STRING",
          "string literal contains an invalid escape",
          tokenLine,
          tokenColumn,
        );
      }
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/.exec(
      source.slice(index),
    );
    if (number) {
      for (let count = 0; count < number[0].length; count++) advance();
      tokens.push({
        kind: "number",
        text: number[0],
        line: tokenLine,
        column: tokenColumn,
      });
      continue;
    }

    const start = index;
    while (index < source.length) {
      const current = source[index]!;
      if (/\s/u.test(current) || "{}[]=(),\"#".includes(current)) break;
      if (current === "/" && source[index + 1] === "/") break;
      advance();
    }
    const text = source.slice(start, index);
    if (!IDENTIFIER.test(text)) {
      throw new StructureSyntaxError(
        "IDEL_STRUCTURE_INVALID_TOKEN",
        `invalid token ${JSON.stringify(text || character)}`,
        tokenLine,
        tokenColumn,
      );
    }
    tokens.push({
      kind: "identifier",
      text,
      line: tokenLine,
      column: tokenColumn,
    });
  }
  tokens.push({ kind: "eof", text: "", line, column });
  return tokens;
}
