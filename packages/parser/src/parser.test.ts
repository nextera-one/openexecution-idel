import { describe, it, expect } from "vitest";
import { isNativeAst, ParseError } from "@openexecution/types";
import type { CommandAst, NativeCommandAst } from "@openexecution/types";
import { parse, tokenize } from "./index.js";

const OPTS = { cwd: "/work" } as const;

/** Narrow an AnyAst to a CommandAst, failing the test if it's native. */
function asCommand(input: string): CommandAst {
  const ast = parse(input, OPTS);
  if (isNativeAst(ast)) throw new Error("expected a CommandAst, got native");
  return ast;
}

describe("parse — basics", () => {
  it("parses a simple command with one param", () => {
    const ast = asCommand("create.file name=readme.md");
    expect(ast.command).toBe("create.file");
    expect(ast.params).toEqual({ name: "readme.md" });
    expect(ast.rawParams).toEqual({ name: "readme.md" });
    expect(ast.source).toBe("idel");
    expect(ast.cwd).toBe("/work");
  });

  it("respects an explicit source override", () => {
    const ast = parse("create.file name=x", { cwd: "/w", source: "api" });
    expect(ast.source).toBe("api");
  });

  it("handles multiple spaces between tokens gracefully", () => {
    const ast = asCommand("remove.folder    name=dist     recursive=true");
    expect(ast.command).toBe("remove.folder");
    expect(ast.params).toEqual({ name: "dist", recursive: true });
  });

  it("tolerates spaces around the `=` separator", () => {
    const ast = asCommand("create.file name = readme.md");
    expect(ast.params).toEqual({ name: "readme.md" });
  });

  it("parses several params of mixed kinds", () => {
    const ast = asCommand("remove.folder name=dist recursive=true force=false");
    expect(ast.params).toEqual({ name: "dist", recursive: true, force: false });
    // Numbers are NOT coerced by the parser:
    const m = asCommand("permission.folder.set path=public mode=755 recursive=true");
    expect(m.params).toEqual({ path: "public", mode: "755", recursive: true });
    expect(m.rawParams.mode).toBe("755");
    expect(typeof m.params.mode).toBe("string");
  });
});

describe("parse — quoting", () => {
  it("keeps spaces inside double quotes and strips the outer quotes", () => {
    const ast = asCommand('create.file name="my notes.md"');
    expect(ast.params.name).toBe("my notes.md");
    expect(ast.rawParams.name).toBe("my notes.md");
  });

  it("supports single quotes too", () => {
    const ast = asCommand("find.files name='*.js'");
    expect(ast.params.name).toBe("*.js");
  });

  it("resolves escaped quotes inside a quoted value", () => {
    const ast = asCommand('say.text text="he said \\"hi\\""');
    expect(ast.params.text).toBe('he said "hi"');
  });

  it("preserves a glob/special-char value", () => {
    const ast = asCommand('find.files path=. name="*.js" modifiedWithin=7d');
    expect(ast.params).toEqual({
      path: ".",
      name: "*.js",
      modifiedWithin: "7d",
    });
  });
});

describe("parse — boolean coercion", () => {
  it("coerces bare true/false to real booleans", () => {
    const ast = asCommand("remove.folder recursive=true force=false");
    expect(ast.params.recursive).toBe(true);
    expect(ast.params.force).toBe(false);
    // raw strings are preserved verbatim
    expect(ast.rawParams.recursive).toBe("true");
    expect(ast.rawParams.force).toBe("false");
  });

  it("keeps quoted \"true\"/\"false\" as strings", () => {
    const ast = asCommand('set.flag a="true" b=\'false\'');
    expect(ast.params.a).toBe("true");
    expect(ast.params.b).toBe("false");
    expect(typeof ast.params.a).toBe("string");
    expect(typeof ast.params.b).toBe("string");
  });
});

describe("parse — native passthrough", () => {
  it("turns `! cmd` into a NativeCommandAst", () => {
    const ast = parse("! rm -rf dist", OPTS);
    expect(isNativeAst(ast)).toBe(true);
    const n = ast as NativeCommandAst;
    expect(n.command).toBe("native.run");
    expect(n.native).toBe("rm -rf dist");
    expect(n.params).toEqual({});
    expect(n.rawParams).toEqual({});
    expect(n.cwd).toBe("/work");
  });

  it("does not tokenize/quote-process the native body", () => {
    const ast = parse('! echo "a b"  &&  ls', OPTS) as NativeCommandAst;
    expect(ast.native).toBe('echo "a b"  &&  ls');
  });

  it("treats native.run as an ordinary command (not the bang shorthand)", () => {
    const ast = parse('native.run command="rm -rf dist"', OPTS);
    expect(isNativeAst(ast)).toBe(true); // command === "native.run"
    const c = ast as CommandAst;
    expect(c.command).toBe("native.run");
    expect(c.params).toEqual({ command: "rm -rf dist" });
    // It is a CommandAst shape: no `native` field carried.
    expect((c as Record<string, unknown>).native).toBeUndefined();
  });

  it("rejects a lone bang or bang without a body", () => {
    expect(() => parse("!", OPTS)).toThrow(ParseError);
    expect(() => parse("!rm", OPTS)).toThrow(ParseError);
    expect(() => parse("!   ", OPTS)).toThrow(ParseError);
  });
});

describe("parse — validation", () => {
  it("accepts 2, 3, and 4 dotted segments", () => {
    expect(asCommand("create.file").command).toBe("create.file");
    expect(asCommand("permission.folder.set").command).toBe("permission.folder.set");
    expect(asCommand("a.b.c.d name=x").command).toBe("a.b.c.d");
  });

  it("rejects 1 segment and 5 segments", () => {
    expect(() => parse("create", OPTS)).toThrow(ParseError);
    expect(() => parse("a.b.c.d.e", OPTS)).toThrow(ParseError);
  });

  it("rejects malformed command names", () => {
    expect(() => parse("Create.file", OPTS)).toThrow(ParseError); // uppercase
    expect(() => parse("1create.file", OPTS)).toThrow(ParseError); // digit-initial
    expect(() => parse("create..file", OPTS)).toThrow(ParseError); // empty segment
    expect(() => parse("create.file.", OPTS)).toThrow(ParseError); // trailing dot
  });

  it("rejects a quoted command name", () => {
    expect(() => parse('"create.file"', OPTS)).toThrow(ParseError);
  });

  it("rejects invalid parameter keys", () => {
    expect(() => parse("create.file Name=x", OPTS)).toThrow(ParseError); // uppercase-initial
    expect(() => parse("create.file 1n=x", OPTS)).toThrow(ParseError); // digit-initial
    expect(() => parse("create.file na-me=x", OPTS)).toThrow(ParseError); // hyphen
  });

  it("rejects a duplicate parameter key", () => {
    expect(() => parse("create.file name=a name=b", OPTS)).toThrow(ParseError);
  });

  it("rejects a key without a value", () => {
    expect(() => parse("create.file name=", OPTS)).toThrow(ParseError);
    expect(() => parse("create.file name", OPTS)).toThrow(ParseError);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(() => parse("", OPTS)).toThrow(ParseError);
    expect(() => parse("   \t ", OPTS)).toThrow(ParseError);
  });

  it("reports an offset on the ParseError", () => {
    try {
      parse("create.file name=a name=b", OPTS);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect(typeof (e as ParseError).offset).toBe("number");
    }
  });
});

describe("tokenize", () => {
  it("emits word/eq/word for a key=value pair", () => {
    expect(tokenize("name=readme.md")).toEqual([
      { type: "word", value: "name", quoted: false, offset: 0 },
      { type: "eq", value: "=", quoted: false, offset: 4 },
      { type: "word", value: "readme.md", quoted: false, offset: 5 },
    ]);
  });

  it("marks quoted words and strips their quotes", () => {
    const toks = tokenize('"a b"');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ type: "word", value: "a b", quoted: true });
  });

  it("throws on an unterminated quote", () => {
    expect(() => tokenize('name="oops')).toThrow(ParseError);
  });

  it("throws on a dangling escape", () => {
    expect(() => tokenize("name=a\\")).toThrow(ParseError);
  });
});
