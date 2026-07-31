import { describe, expect, it } from "vitest";

import { checkStructure, parseStructure, StructureError } from "./index.js";

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
