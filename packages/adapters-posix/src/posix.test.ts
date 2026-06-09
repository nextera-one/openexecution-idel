import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterSpec,
  CommandAst,
  CommandDef,
  ParamValue,
  ResolvedCommand,
} from "@openexecution/types";
import { NodeAdapter } from "./node-adapter.js";
import { PosixAdapter } from "./posix.js";
import { renderArgv } from "./render.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function def(
  id: string,
  adapters: CommandDef["adapters"],
): CommandDef {
  return {
    id,
    version: "1.0.0",
    summary: id,
    category: "test",
    riskDefault: "LOW",
    params: {},
    adapters,
  };
}

function resolved(d: CommandDef): ResolvedCommand {
  return { def: d, source: "core", shadowed: [] };
}

function ast(
  command: string,
  params: Record<string, ParamValue>,
  cwd: string,
): CommandAst {
  return { command, params, rawParams: {}, source: "idel", cwd };
}

/** A realistic remove.folder POSIX spec: `rm [-r] [-f] <path>`. */
const removeFolderSpec: AdapterSpec = {
  command: "rm",
  args: [
    { kind: "flag", flag: "-r", when: "recursive" },
    { kind: "flag", flag: "-f", when: "force" },
    { kind: "value", param: "path" },
  ],
};

// ---------------------------------------------------------------------------
// renderArgv
// ---------------------------------------------------------------------------

describe("renderArgv", () => {
  it("emits a flag only when its boolean param is true", () => {
    const spec: AdapterSpec = {
      command: "x",
      args: [{ kind: "flag", flag: "-r", when: "recursive" }],
    };
    expect(renderArgv(spec, { recursive: true })).toEqual(["-r"]);
  });

  it("omits a flag (no empty string) when false or missing", () => {
    const spec: AdapterSpec = {
      command: "x",
      args: [{ kind: "flag", flag: "-r", when: "recursive" }],
    };
    expect(renderArgv(spec, { recursive: false })).toEqual([]);
    expect(renderArgv(spec, {})).toEqual([]);
  });

  it("emits two elements for an option, skips when undefined/empty", () => {
    const spec: AdapterSpec = {
      command: "x",
      args: [{ kind: "option", flag: "--mode", param: "mode" }],
    };
    expect(renderArgv(spec, { mode: "755" })).toEqual(["--mode", "755"]);
    expect(renderArgv(spec, { mode: 644 })).toEqual(["--mode", "644"]);
    expect(renderArgv(spec, {})).toEqual([]);
    expect(renderArgv(spec, { mode: "" })).toEqual([]);
  });

  it("emits a single positional for value, skips when undefined/empty", () => {
    const spec: AdapterSpec = {
      command: "x",
      args: [{ kind: "value", param: "path" }],
    };
    expect(renderArgv(spec, { path: "dist" })).toEqual(["dist"]);
    expect(renderArgv(spec, {})).toEqual([]);
    expect(renderArgv(spec, { path: "" })).toEqual([]);
  });

  it("always emits a literal", () => {
    const spec: AdapterSpec = {
      command: "x",
      args: [{ kind: "literal", value: "--" }],
    };
    expect(renderArgv(spec, {})).toEqual(["--"]);
  });

  it("renders remove.folder with recursive+force as [-r,-f,dist]", () => {
    const argv = renderArgv(removeFolderSpec, {
      recursive: true,
      force: true,
      path: "dist",
    });
    expect(argv).toEqual(["-r", "-f", "dist"]);
    expect(argv.every((a) => a.length > 0)).toBe(true);
  });

  it("renders remove.folder without flags as just [dist] (no empty strings)", () => {
    const argv = renderArgv(removeFolderSpec, {
      recursive: false,
      force: false,
      path: "dist",
    });
    expect(argv).toEqual(["dist"]);
    expect(argv.every((a) => a.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PosixAdapter
// ---------------------------------------------------------------------------

describe("PosixAdapter", () => {
  const adapter = new PosixAdapter();

  it("has the expected name/availability", () => {
    expect(adapter.name).toBe("posix");
    expect(adapter.available).toBe(process.platform !== "win32");
  });

  it("supportsResolved is true for a spawnable posix spec", () => {
    const d = resolved(def("remove.folder", { posix: removeFolderSpec }));
    expect(adapter.supportsResolved(d)).toBe(true);
  });

  it("supportsResolved is false for @node and @runtime commands", () => {
    expect(
      adapter.supportsResolved(
        resolved(def("create.file", { posix: { command: "@node", args: [] } })),
      ),
    ).toBe(false);
    expect(
      adapter.supportsResolved(
        resolved(def("x", { posix: { command: "@runtime", args: [] } })),
      ),
    ).toBe(false);
    expect(
      adapter.supportsResolved(resolved(def("y", {}))),
    ).toBe(false);
  });

  it("supports uses an injected resolver", () => {
    const d = resolved(def("remove.folder", { posix: removeFolderSpec }));
    const withResolver = new PosixAdapter((id) =>
      id === "remove.folder" ? d : undefined,
    );
    expect(withResolver.supports("remove.folder")).toBe(true);
    expect(withResolver.supports("unknown")).toBe(false);
    // No resolver → conservative false.
    expect(adapter.supports("remove.folder")).toBe(false);
  });

  it("plan() produces the expected shape", () => {
    const d = resolved(def("remove.folder", { posix: removeFolderSpec }));
    const plan = adapter.plan(
      d,
      ast("remove.folder", { recursive: true, force: true, path: "dist" }, "/tmp"),
    );
    expect(plan.adapter).toBe("posix");
    expect(plan.command).toBe("rm");
    expect(plan.argv).toEqual(["-r", "-f", "dist"]);
    expect(plan.describe).toBe("rm -r -f dist");
  });

  it("execute() dryRun returns a simulated result and does NOT spawn", async () => {
    const plan = {
      adapter: "posix" as const,
      command: "rm",
      argv: ["-rf", "/definitely/should/not/run"],
      describe: "rm -rf /definitely/should/not/run",
    };
    const result = await adapter.execute(plan, { dryRun: true, cwd: "/tmp" });
    expect(result.simulated).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.stdout).toContain("[dry-run]");
  });

  it("execute() really spawns a harmless command (exit 0)", async () => {
    // `true` is a harmless POSIX builtin/binary that exits 0. On Windows there
    // is no `true`, so we skip the real spawn there.
    if (process.platform === "win32") return;
    const plan = {
      adapter: "posix" as const,
      command: "true",
      argv: [],
      describe: "true",
    };
    const result = await adapter.execute(plan, {
      dryRun: false,
      cwd: process.cwd(),
    });
    expect(result.simulated).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// NodeAdapter — real in-process fs effects in a temp dir
// ---------------------------------------------------------------------------

describe("NodeAdapter", () => {
  const adapter = new NodeAdapter();
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oe-node-adapter-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(
    id: string,
    params: Record<string, ParamValue>,
    opts: { dryRun: boolean },
  ) {
    const d = resolved(def(id, { node: { command: "@node", args: [] } }));
    const plan = adapter.plan(d, ast(id, params, dir));
    return adapter.execute(plan, { dryRun: opts.dryRun, cwd: dir });
  }

  it("name is node and available is always true", () => {
    expect(adapter.name).toBe("node");
    expect(adapter.available).toBe(true);
  });

  it("supports only the handled ids; supportsResolved requires @node", () => {
    expect(adapter.supports("create.file")).toBe(true);
    expect(adapter.supports("remove.folder")).toBe(true);
    expect(adapter.supports("native.run")).toBe(false);
    expect(
      adapter.supportsResolved(
        resolved(def("create.file", { node: { command: "@node", args: [] } })),
      ),
    ).toBe(true);
    // Right id but not marked @node → false.
    expect(
      adapter.supportsResolved(
        resolved(def("create.file", { node: { command: "touch", args: [] } })),
      ),
    ).toBe(false);
  });

  it("performs create.folder + create.file + read/write/append + list + remove", async () => {
    // create.folder
    const sub = "nested/inner";
    let r = await run("create.folder", { name: sub }, { dryRun: false });
    expect(r.exitCode).toBe(0);
    expect((await stat(join(dir, sub))).isDirectory()).toBe(true);

    // create.file (touch-like)
    r = await run("create.file", { name: "readme.md" }, { dryRun: false });
    expect(r.exitCode).toBe(0);
    expect((await stat(join(dir, "readme.md"))).isFile()).toBe(true);

    // write.file
    r = await run(
      "write.file",
      { path: "readme.md", content: "hello" },
      { dryRun: false },
    );
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(dir, "readme.md"), "utf8")).toBe("hello");

    // append.file
    r = await run(
      "append.file",
      { path: "readme.md", content: " world" },
      { dryRun: false },
    );
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(dir, "readme.md"), "utf8")).toBe("hello world");

    // read.file → stdout
    r = await run("read.file", { path: "readme.md" }, { dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello world");

    // list.folder → stdout lists readme.md and the nested dir
    r = await run("list.folder", {}, { dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("readme.md");
    expect(r.stdout).toContain("nested");

    // copy.file then move/rename
    r = await run(
      "copy.file",
      { from: "readme.md", to: "copy.md" },
      { dryRun: false },
    );
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(dir, "copy.md"), "utf8")).toBe("hello world");

    r = await run(
      "move.file",
      { from: "copy.md", to: "moved.md" },
      { dryRun: false },
    );
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(dir, "moved.md"), "utf8")).toBe("hello world");
    await expect(stat(join(dir, "copy.md"))).rejects.toThrow();

    // remove.file (only files this test created, in temp)
    r = await run("remove.file", { path: "moved.md" }, { dryRun: false });
    expect(r.exitCode).toBe(0);
    await expect(stat(join(dir, "moved.md"))).rejects.toThrow();
  });

  it("remove.folder honors recursive/force", async () => {
    await run("create.folder", { name: "to-del/inner" }, { dryRun: false });
    await run(
      "write.file",
      { path: "to-del/inner/f.txt", content: "x" },
      { dryRun: false },
    );
    const r = await run(
      "remove.folder",
      { path: "to-del", recursive: true, force: true },
      { dryRun: false },
    );
    expect(r.exitCode).toBe(0);
    await expect(stat(join(dir, "to-del"))).rejects.toThrow();
  });

  it("path.current returns cwd on stdout", async () => {
    const r = await run("path.current", {}, { dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(dir);
  });

  it("dryRun does NOT touch the filesystem", async () => {
    const r = await run("create.file", { name: "ghost.md" }, { dryRun: true });
    expect(r.simulated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[dry-run]");
    await expect(stat(join(dir, "ghost.md"))).rejects.toThrow();
  });

  it("returns a failure result (exit 1) when a required path is missing", async () => {
    const r = await run("read.file", {}, { dryRun: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing required path");
  });
});
