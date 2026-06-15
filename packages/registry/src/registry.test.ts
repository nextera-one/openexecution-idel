import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RegistryError } from "@openexecution/types";
import type { CommandDef } from "@openexecution/types";

import { checkCommandDef, validateCommandDef } from "./schema.js";
import { Registry, findCoreDir, loadLayerFromDir } from "./loader.js";
import { coerceParams } from "./coerce.js";

const CORE_COMMAND_VERBS = new Set([
  "append",
  "ask",
  "change",
  "check",
  "clear",
  "copy",
  "create",
  "edit",
  "explain",
  "extract",
  "find",
  "get",
  "install",
  "learn",
  "list",
  "move",
  "open",
  "read",
  "remove",
  "rename",
  "run",
  "save",
  "search",
  "set",
  "show",
  "tail",
  "update",
  "wait",
  "write",
]);

// A minimal, valid command def used as a baseline to mutate in tests.
function goodDef(over: Partial<CommandDef> = {}): unknown {
  return {
    id: "remove.folder",
    version: "1.0.0",
    summary: "Delete a directory.",
    category: "filesystem",
    riskDefault: "HIGH",
    params: {
      name: { type: "path", required: true },
      recursive: { type: "boolean", default: false },
    },
    safety: { destructive: true, targetParam: "name" },
    adapters: {
      posix: {
        command: "rm",
        args: [
          { kind: "flag", flag: "-r", when: "recursive" },
          { kind: "value", param: "name" },
        ],
      },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// schema validation
// ---------------------------------------------------------------------------

describe("schema — validateCommandDef", () => {
  it("accepts a well-formed definition", () => {
    const { ok, errors } = checkCommandDef(goodDef());
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it("the assertion form does not throw for a good def", () => {
    expect(() => validateCommandDef(goodDef())).not.toThrow();
  });

  it("rejects a bad id (uppercase / single segment)", () => {
    expect(checkCommandDef(goodDef({ id: "Remove" })).ok).toBe(false);
    expect(checkCommandDef(goodDef({ id: "removefolder" })).ok).toBe(false);
    expect(checkCommandDef(goodDef({ id: "a.b.c.d.e" })).ok).toBe(false);
  });

  it("rejects a bad risk level", () => {
    const res = checkCommandDef(goodDef({ riskDefault: "SUPER" as never }));
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/riskDefault/);
  });

  it("rejects a bad version string", () => {
    expect(checkCommandDef(goodDef({ version: "v1" as never })).ok).toBe(false);
    expect(checkCommandDef(goodDef({ version: "" })).ok).toBe(false);
  });

  it("rejects a bad adapter arg kind", () => {
    const bad = goodDef({
      adapters: {
        posix: { command: "rm", args: [{ kind: "switch", flag: "-r" } as never] },
      },
    });
    const res = checkCommandDef(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/kind/);
  });

  it("rejects a 'flag' arg missing its 'when' field", () => {
    const bad = goodDef({
      adapters: { posix: { command: "rm", args: [{ kind: "flag", flag: "-r" } as never] } },
    });
    expect(checkCommandDef(bad).ok).toBe(false);
  });

  it("rejects an unknown adapter name", () => {
    const bad = goodDef({
      adapters: { bash: { command: "rm", args: [] } } as never,
    });
    const res = checkCommandDef(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/unknown adapter/);
  });

  it("rejects @node outside the node adapter", () => {
    const bad = goodDef({
      adapters: { powershell: { command: "@node", args: [] } },
    });
    const res = checkCommandDef(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/@node is only valid/);
  });

  it("rejects missing required fields (summary/category)", () => {
    expect(checkCommandDef(goodDef({ summary: "" })).ok).toBe(false);
    expect(checkCommandDef(goodDef({ category: "" })).ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(checkCommandDef("nope").ok).toBe(false);
    expect(checkCommandDef(null).ok).toBe(false);
    expect(checkCommandDef([1, 2]).ok).toBe(false);
  });

  it("rejects a bad param type", () => {
    const bad = goodDef({ params: { x: { type: "json" } } as never });
    expect(checkCommandDef(bad).ok).toBe(false);
  });

  it("allows empty adapters only for meta category", () => {
    expect(checkCommandDef(goodDef({ category: "filesystem", adapters: {} })).ok).toBe(false);
    expect(
      checkCommandDef({
        id: "list.registry",
        version: "1.0.0",
        summary: "List commands.",
        category: "meta",
        riskDefault: "LOW",
        params: {},
        adapters: {},
      }).ok,
    ).toBe(true);
  });

  it("validateCommandDef throws a RegistryError with details", () => {
    let caught: unknown;
    try {
      validateCommandDef(goodDef({ id: "BAD" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    expect((caught as Error).message).toMatch(/id:/);
  });
});

// ---------------------------------------------------------------------------
// loader — real core dir
// ---------------------------------------------------------------------------

describe("loader — core registry", () => {
  it("locates the registries/core dir by walking up", () => {
    // Use fileURLToPath (not a `file://` string replace) so this resolves on
    // Windows too, where import.meta.url is `file:///D:/...` and a naive replace
    // leaves an invalid `/D:/...` path.
    const dir = findCoreDir(fileURLToPath(import.meta.url));
    // Compare with the platform's own separator rather than a hardcoded "/".
    expect(dir.endsWith(join("registries", "core"))).toBe(true);
  });

  it("loads the real core dir and indexes commands", async () => {
    const reg = await Registry.loadCore();
    expect(reg.size).toBeGreaterThanOrEqual(25);
    expect(reg.has("remove.folder")).toBe(true);
    expect(reg.has("create.file")).toBe(true);
    expect(reg.has("list.logs")).toBe(true);
    expect(reg.has("logs.list")).toBe(false);
  });

  it("list() returns effective defs sorted by id", async () => {
    const reg = await Registry.loadCore();
    const ids = reg.list().map((d) => d.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(ids).toContain("remove.folder");
  });

  it("every core def validates against the schema (zero errors)", async () => {
    const dir = findCoreDir();
    const { defs, problems } = await loadLayerFromDir(dir, "core");
    expect(problems).toEqual([]);
    expect(defs.length).toBeGreaterThanOrEqual(25);
    for (const def of defs) {
      expect(checkCommandDef(def).ok).toBe(true);
    }
  });

  it("every core command id is verb-first", async () => {
    const dir = findCoreDir();
    const { defs } = await loadLayerFromDir(dir, "core");
    const offenders = defs
      .map((def) => def.id)
      .filter((id) => !CORE_COMMAND_VERBS.has(id.split(".")[0] ?? ""));
    expect(offenders).toEqual([]);
  });

  it("tags loaded core defs with source=core", async () => {
    const reg = await Registry.loadCore();
    const resolved = reg.resolve("remove.folder");
    expect(resolved?.source).toBe("core");
  });
});

// ---------------------------------------------------------------------------
// loader — layered resolution
// ---------------------------------------------------------------------------

function def(id: string, source: string, version: string): CommandDef {
  return {
    id,
    version,
    summary: `v${version} of ${id} from ${source}`,
    category: "filesystem",
    riskDefault: "LOW",
    params: {},
    adapters: { posix: { command: "true", args: [] } },
  };
}

describe("resolve — custom > official > core", () => {
  it("picks the highest-priority layer and records shadowed lower ones", () => {
    const reg = new Registry();
    reg.addLayer("core", [def("create.file", "core", "1.0.0")]);
    reg.addLayer("official", [def("create.file", "official", "1.1.0")]);
    reg.addLayer("custom", [def("create.file", "custom", "2.0.0")]);

    const r = reg.resolve("create.file");
    expect(r?.source).toBe("custom");
    expect(r?.def.version).toBe("2.0.0");
    expect(r?.shadowed).toEqual([
      { source: "official", version: "1.1.0" },
      { source: "core", version: "1.0.0" },
    ]);
  });

  it("official shadows core when no custom exists", () => {
    const reg = new Registry();
    reg.addLayer("core", [def("read.file", "core", "1.0.0")]);
    reg.addLayer("official", [def("read.file", "official", "1.2.0")]);
    const r = reg.resolve("read.file");
    expect(r?.source).toBe("official");
    expect(r?.shadowed).toEqual([{ source: "core", version: "1.0.0" }]);
  });

  it("returns undefined for an unknown command", () => {
    const reg = new Registry();
    expect(reg.resolve("does.not.exist")).toBeUndefined();
  });

  it("explain() returns the resolved winner plus all layers", () => {
    const reg = new Registry();
    reg.addLayer("core", [def("write.file", "core", "1.0.0")]);
    reg.addLayer("custom", [def("write.file", "custom", "3.0.0")]);
    const { resolved, allLayers } = reg.explain("write.file");
    expect(resolved?.source).toBe("custom");
    expect(allLayers.map((l) => l.source)).toEqual(["custom", "core"]);
  });

  it("replaceLayer clears stale commands from a reloaded layer", () => {
    const reg = new Registry();
    reg.addLayer("core", [def("create.file", "core", "1.0.0")]);
    reg.addLayer("custom", [def("show.demo.status", "custom", "1.0.0")]);
    expect(reg.has("show.demo.status")).toBe(true);

    reg.replaceLayer("custom", [def("list.demo.items", "custom", "1.0.0")]);

    expect(reg.has("show.demo.status")).toBe(false);
    expect(reg.has("list.demo.items")).toBe(true);
    expect(reg.has("create.file")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// coerceParams
// ---------------------------------------------------------------------------

const rmDef = goodDef() as CommandDef;

describe("coerceParams", () => {
  it("coerces booleans from raw strings", () => {
    const { params, errors } = coerceParams(
      rmDef,
      { name: "dist", recursive: "true" },
      {},
    );
    expect(errors).toEqual([]);
    expect(params.recursive).toBe(true);
    expect(params.name).toBe("dist");
  });

  it("honors a quoted boolean string and a parser-typed boolean", () => {
    const fromRaw = coerceParams(rmDef, { name: "d", recursive: "false" }, {});
    expect(fromRaw.params.recursive).toBe(false);
    const fromParsed = coerceParams(rmDef, { name: "d" }, { recursive: true });
    expect(fromParsed.params.recursive).toBe(true);
  });

  it("coerces numbers and errors on NaN", () => {
    const numDef: CommandDef = {
      id: "list.logs",
      version: "1.0.0",
      summary: "x",
      category: "meta",
      riskDefault: "LOW",
      params: { limit: { type: "number", default: 20 } },
      adapters: {},
    };
    expect(coerceParams(numDef, { limit: "50" }, {}).params.limit).toBe(50);
    const bad = coerceParams(numDef, { limit: "abc" }, {});
    expect(bad.errors.join("")).toMatch(/number/);
  });

  it("validates octal mode and keeps it a string", () => {
    const modeDef: CommandDef = {
      id: "set.file.permission",
      version: "1.0.0",
      summary: "x",
      category: "permissions",
      riskDefault: "HIGH",
      params: {
        path: { type: "path", required: true },
        mode: { type: "mode", required: true },
      },
      adapters: { posix: { command: "chmod", args: [] } },
    };
    const ok = coerceParams(modeDef, { path: "a", mode: "0755" }, {});
    expect(ok.errors).toEqual([]);
    expect(ok.params.mode).toBe("0755");
    const bad = coerceParams(modeDef, { path: "a", mode: "999" }, {});
    expect(bad.errors.join("")).toMatch(/octal mode/);
  });

  it("applies defaults for missing optional params", () => {
    const { params } = coerceParams(rmDef, { name: "dist" }, {});
    expect(params.recursive).toBe(false);
  });

  it("errors on a missing required param", () => {
    const { errors } = coerceParams(rmDef, { recursive: "true" }, {});
    expect(errors.join("")).toMatch(/required parameter is missing/);
  });

  it("rejects an unknown param by default", () => {
    const { errors } = coerceParams(rmDef, { name: "d", bogus: "x" }, {});
    expect(errors.join("")).toMatch(/unknown parameter/);
  });

  it("validates enums", () => {
    const enumDef: CommandDef = {
      id: "a.b",
      version: "1.0.0",
      summary: "x",
      category: "filesystem",
      riskDefault: "LOW",
      params: { level: { type: "string", enum: ["low", "high"] } },
      adapters: { posix: { command: "true", args: [] } },
    };
    expect(coerceParams(enumDef, { level: "low" }, {}).errors).toEqual([]);
    expect(coerceParams(enumDef, { level: "mid" }, {}).errors.join("")).toMatch(
      /must be one of/,
    );
  });

  it("collects extraArgs on a LOW non-destructive command that opts in", () => {
    const lowDef: CommandDef = {
      id: "a.b",
      version: "1.0.0",
      summary: "x",
      category: "filesystem",
      riskDefault: "LOW",
      allowExtraArgs: true,
      params: { name: { type: "path", required: true } },
      adapters: { posix: { command: "true", args: [] } },
    };
    const res = coerceParams(lowDef, { name: "d", color: "blue" }, {});
    expect(res.errors).toEqual([]);
    expect(res.extraArgs).toEqual({ color: "blue" });
  });

  it("rejects extraArgs on a destructive command even with allowExtraArgs", () => {
    const destructive = goodDef({ allowExtraArgs: true, riskDefault: "HIGH" }) as CommandDef;
    const res = coerceParams(destructive, { name: "d", extra: "x" }, {});
    expect(res.errors.join("")).toMatch(/extra args are not permitted/);
    expect(res.extraArgs).toEqual({});
  });

  it("rejects extraArgs on a HIGH command (risk gate) even if non-destructive", () => {
    const highNonDestructive: CommandDef = {
      id: "a.b",
      version: "1.0.0",
      summary: "x",
      category: "filesystem",
      riskDefault: "HIGH",
      allowExtraArgs: true,
      params: { name: { type: "path", required: true } },
      adapters: { posix: { command: "true", args: [] } },
    };
    const res = coerceParams(highNonDestructive, { name: "d", extra: "x" }, {});
    expect(res.errors.join("")).toMatch(/extra args are not permitted/);
  });
});
