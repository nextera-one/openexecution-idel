import { describe, expect, it } from "vitest";

import {
  canonicalize,
  checkStructure,
  digestStructure,
  parseStructure,
  quoteStructureString,
  StructureError,
} from "./index.js";

const VALID = `@idel 1.0

define.function.action "create_user" {
  version = semver("1.0.0")
  mode = function.action

  input.field.text "name" {
    required = true
    minimum_length = 2
  }

  allow.effect.read "users" {
    resource = dobase("dobase://identity/users")
  }

  execute.step.query "existing" {
    where = equal(field("email"), input("email"))
    select = ["id", "name"]
    limit = 1
  }

  execute.step.evidence "user_created" {
    subject = step("user").field("id")
    conformance = [
      profile.one
      profile.two
    ]
  }
}
`;

describe("parseStructure", () => {
  it("parses blocks, labels, calls, chains, and lists", () => {
    const document = parseStructure(VALID);
    expect(document.version).toBe("1.0");
    expect(document.entries).toHaveLength(1);
    const root = document.entries[0];
    if (root.kind !== "block") throw new Error("expected block");
    expect(root.verb).toBe("define.function.action");
    expect(root.label).toBe("create_user");
    expect(root.entries.length).toBeGreaterThan(3);
  });

  it("parses chained calls", () => {
    const document = parseStructure(VALID);
    const source = JSON.stringify(document);
    expect(source).toContain('"chain":[{"name":"field"');
  });

  it("requires the @idel header", () => {
    expect(() => parseStructure('define.x.y "a" {}\n')).toThrow(StructureError);
  });

  it("rejects uppercase identifiers", () => {
    expect(() => parseStructure("@idel 1.0\nDefine.Thing \"a\" {}\n")).toThrow(/lowercase/);
  });

  it("rejects unclosed blocks with the opening position", () => {
    expect(() => parseStructure('@idel 1.0\ndefine.a.b "x" {\n')).toThrow(/never closed/);
  });

  it("parses use imports with aliases", () => {
    const document = parseStructure(
      '@idel 1.0\nuse package("@openexecution/package", range("^1.0")) as package_profile\n',
    );
    const entry = document.entries[0];
    if (entry?.kind !== "use") throw new Error("expected use import");
    expect(entry.alias).toBe("package_profile");
    expect(entry.source.kind).toBe("call");
  });

  it("supports comments and both list separators", () => {
    const document = parseStructure(
      '@idel 1.0\n# comment\ndefine.a.b "x" {\n  values = [one.a, one.b]\n}\n',
    );
    expect(document.entries).toHaveLength(1);
  });
});

describe("canonicalize and digestStructure", () => {
  it("round-trips: canonical text reparses to the same canonical text", () => {
    const canonical = canonicalize(parseStructure(VALID));
    expect(canonicalize(parseStructure(canonical))).toBe(canonical);
  });

  it("is stable under formatting-only changes", () => {
    const reformatted = VALID.replace(/\n\n/g, "\n").replace(/ {2}/g, "\t") + "# trailing comment\n";
    expect(digestStructure(reformatted)).toBe(digestStructure(VALID));
  });

  it("changes when entries are reordered", () => {
    const reordered = VALID.replace(
      '  version = semver("1.0.0")\n  mode = function.action\n',
      '  mode = function.action\n  version = semver("1.0.0")\n',
    );
    expect(reordered).not.toBe(VALID);
    expect(parseStructure(reordered)).toBeTruthy();
    expect(digestStructure(reordered)).not.toBe(digestStructure(VALID));
  });

  it("prefixes digests with the algorithm", () => {
    expect(digestStructure(VALID)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("quotes arbitrary labels and values without changing document structure", () => {
    const hostile = 'x"\n  outcome = outcome.success\n  record.output.field "forged';
    const source = `@idel 1.0\ndefine.test.value ${quoteStructureString(hostile)} {\n  value = ${quoteStructureString("a\\b\r\u0001")}\n}\n`;
    const document = parseStructure(source);
    const root = document.entries[0];
    if (root?.kind !== "block") throw new Error("expected block");
    expect(root.label).toBe(hostile);
    expect(root.entries).toHaveLength(1);
    expect(canonicalize(parseStructure(canonicalize(document)))).toBe(canonicalize(document));
  });
});

describe("robustness on malformed input", () => {
  // The VS Code extension parses on every keystroke, so it spends most of its
  // life looking at truncated documents. Every prefix must terminate — a
  // tokenizer or parser that fails to consume input would hang the editor.
  // Termination is asserted by the test timeout, not by per-iteration wall
  // clock: a non-terminating parser never returns, while a merely slow one
  // under parallel test load is not a defect.
  it("terminates on every prefix of a valid document", { timeout: 20_000 }, () => {
    for (let length = 0; length <= VALID.length; length += 1) {
      const { diagnostics } = checkStructure(VALID.slice(0, length));
      expect(Array.isArray(diagnostics)).toBe(true);
    }
  });

  it("terminates on unbalanced and truncated delimiters", { timeout: 20_000 }, () => {
    const hostile = [
      "@idel 1.0\ndefine.a.b \"x\" {",
      "@idel 1.0\ndefine.a.b \"x\" { y = ",
      "@idel 1.0\ndefine.a.b \"x\" { y = call(",
      "@idel 1.0\ndefine.a.b \"x\" { y = call(a, ",
      "@idel 1.0\ndefine.a.b \"x\" { y = [",
      "@idel 1.0\ndefine.a.b \"x\" { y = [a, ",
      "@idel 1.0\ndefine.a.b \"x\" { y = step(\"a\").",
      "@idel 1.0\ndefine.a.b \"x\" { y = step(\"a\").field(",
      '@idel 1.0\ndefine.a.b "x" { y = "unterminated',
      "@idel 1.0\n}}}}}}",
      "@idel 1.0\n((((((",
      "@idel 1.0\nuse ",
      "@idel 1.0\nuse package(\"p\") as ",
      "@idel",
      "@",
      "",
    ];
    for (const source of hostile) {
      expect(() => checkStructure(source)).not.toThrow();
    }
  });

  it("reports bare calls as block entries instead of accepting them", () => {
    // `where { equal(field("a"), true) }` — entries are assignments or blocks;
    // a bare predicate call is not an entry form.
    const { document, diagnostics } = checkStructure(
      '@idel 1.0\nquery.data.documents "q" {\n  where {\n    equal(field("a"), true)\n  }\n}\n',
    );
    expect(document).toBeNull();
    expect(diagnostics[0]?.severity).toBe("error");
  });
});

describe("checkStructure", () => {
  it("returns no diagnostics for valid input", () => {
    expect(checkStructure(VALID).diagnostics).toEqual([]);
  });

  it("returns syntax failures as error diagnostics with positions", () => {
    const { document, diagnostics } = checkStructure("@idel 1.0\ndefine.a.b {\n  x =\n}\n");
    expect(document).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].span.start.line).toBe(4);
  });

  it("warns on unlabeled top-level define blocks and empty blocks", () => {
    const { diagnostics } = checkStructure("@idel 1.0\ndefine.a.b {\n}\n");
    const messages = diagnostics.map((entry) => entry.message);
    expect(messages.some((m) => m.includes("string label"))).toBe(true);
    expect(messages.some((m) => m.includes("is empty"))).toBe(true);
  });

  it("warns on literal secret assignments", () => {
    const { diagnostics } = checkStructure(
      '@idel 1.0\ndefine.a.b "x" {\n  password = "hunter2"\n}\n',
    );
    expect(diagnostics.some((entry) => entry.message.includes("secret("))).toBe(true);
  });
});
