/**
 * Safety engine tests.
 *
 * The safety engine NEVER executes or deletes anything — it only classifies.
 * These tests therefore perform NO destructive fs operations. The resolved-
 * phase tests create a harmless temp dir + a symlink *to that temp dir* in
 * os.tmpdir() and clean them up; no symlink ever points at `/` and nothing is
 * removed beyond the temp scaffolding this test created.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  CommandAst,
  CommandDef,
  NativeCommandAst,
  ParamValue,
} from "@openexecution/types";

import {
  assessAst,
  assessResolved,
  maxRisk,
  RISK_ORDER,
  SAFETY_FLOORS,
  scanNative,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

const HOME = os.homedir();

function makeAst(
  command: string,
  params: Record<string, ParamValue>,
  opts: { cwd?: string } = {},
): CommandAst {
  const rawParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) rawParams[k] = String(v);
  return {
    command,
    params,
    rawParams,
    source: "idel",
    cwd: opts.cwd ?? "/home/u/project",
  };
}

function makeNative(native: string): NativeCommandAst {
  return {
    command: "native.run",
    native,
    params: {},
    rawParams: {},
    source: "native",
    cwd: "/home/u/project",
  };
}

/** Minimal CommandDef for a destructive folder-removal command. */
function removeFolderDef(): CommandDef {
  return {
    id: "remove.folder",
    version: "1.0.0",
    summary: "Remove a folder",
    category: "filesystem",
    riskDefault: "MEDIUM",
    params: {
      name: { type: "path", required: true },
      recursive: { type: "boolean" },
      force: { type: "boolean" },
    },
    safety: { destructive: true, targetParam: "name" },
    adapters: {},
  };
}

/** Minimal CommandDef for a permission/chmod command. */
function permissionDef(): CommandDef {
  return {
    id: "permission.set",
    version: "1.0.0",
    summary: "Change permissions",
    category: "filesystem",
    riskDefault: "MEDIUM",
    params: {
      path: { type: "path", required: true },
      mode: { type: "mode", required: true },
      recursive: { type: "boolean" },
    },
    safety: { destructive: true, targetParam: "path" },
    adapters: {},
  };
}

/** Minimal CommandDef for a read-only command. */
function readFileDef(): CommandDef {
  return {
    id: "read.file",
    version: "1.0.0",
    summary: "Read a file",
    category: "filesystem",
    riskDefault: "LOW",
    params: { path: { type: "path", required: true } },
    safety: { destructive: false, targetParam: "path" },
    adapters: {},
  };
}

function codes(findings: { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

// ---------------------------------------------------------------------------
// AST phase — canonical destructive cases
// ---------------------------------------------------------------------------

describe("assessAst — destructive folder removal", () => {
  it("remove.folder name=/ recursive force => CRITICAL (root-delete)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "/", recursive: true, force: true }),
      removeFolderDef(),
    );
    expect(a.phase).toBe("ast");
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("root-delete");
    expect(codes(a.findings)).toContain("recursive-force");
  });

  it("home directory delete => CRITICAL (home-delete)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: HOME, recursive: true, force: true }),
      removeFolderDef(),
    );
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("home-delete");
  });

  it("remove.folder name=dist recursive=true => HIGH (recursive-delete)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "dist", recursive: true }),
      removeFolderDef(),
    );
    expect(a.level).toBe("HIGH");
    expect(codes(a.findings)).toContain("recursive-delete");
    expect(codes(a.findings)).not.toContain("root-delete");
  });

  it("empty target on destructive verb => finding 'empty-target', HIGH", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "" }),
      removeFolderDef(),
    );
    expect(a.level).toBe("HIGH");
    expect(codes(a.findings)).toContain("empty-target");
  });

  it("missing target param on destructive verb => 'empty-target'", () => {
    // No `name` at all.
    const ast = makeAst("remove.folder", {});
    const a = assessAst(ast, removeFolderDef());
    expect(codes(a.findings)).toContain("empty-target");
  });

  it("broad glob near root => HIGH (broad-glob)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "/*" }),
      removeFolderDef(),
    );
    expect(RISK_ORDER.indexOf(a.level)).toBeGreaterThanOrEqual(
      RISK_ORDER.indexOf("HIGH"),
    );
    expect(codes(a.findings)).toContain("broad-glob");
  });

  it("ordinary glob in target => MEDIUM (glob-target)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "logs/*.tmp" }),
      removeFolderDef(),
    );
    expect(codes(a.findings)).toContain("glob-target");
  });

  it("parent traversal escaping cwd => HIGH (parent-traversal)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "../../etc" }, { cwd: "/home/u/project" }),
      removeFolderDef(),
    );
    expect(codes(a.findings)).toContain("parent-traversal");
    expect(RISK_ORDER.indexOf(a.level)).toBeGreaterThanOrEqual(
      RISK_ORDER.indexOf("HIGH"),
    );
  });

  it("destructive op outside cwd (not root/home) => MEDIUM (outside-cwd)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "/var/tmp/scratch" }, { cwd: "/home/u/project" }),
      removeFolderDef(),
    );
    expect(codes(a.findings)).toContain("outside-cwd");
  });
});

describe("assessAst — permissions", () => {
  it("recursive chmod 777 on root => CRITICAL (recursive-chmod-777-broad)", () => {
    const a = assessAst(
      makeAst("permission.set", { path: "/", mode: "777", recursive: true }),
      permissionDef(),
    );
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("recursive-chmod-777-broad");
  });

  it("recursive chmod 777 on a normal dir => HIGH (recursive-chmod-777)", () => {
    const a = assessAst(
      makeAst("permission.set", { path: "build", mode: "777", recursive: true }),
      permissionDef(),
    );
    expect(a.level).toBe("HIGH");
    expect(codes(a.findings)).toContain("recursive-chmod-777");
  });
});

describe("assessAst — device + low-risk", () => {
  it("write to a device path => CRITICAL (device-write)", () => {
    // A destructive op whose target is a raw device.
    const a = assessAst(
      makeAst("remove.folder", { name: "/dev/sda" }),
      removeFolderDef(),
    );
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("device-write");
  });

  it("read.file => LOW, no critical findings", () => {
    const a = assessAst(
      makeAst("read.file", { path: "src/index.ts" }),
      readFileDef(),
    );
    expect(a.level).toBe("LOW");
    expect(a.findings.every((f) => f.level !== "CRITICAL")).toBe(true);
  });

  it("read.file even at root path => not CRITICAL (non-destructive)", () => {
    const a = assessAst(makeAst("read.file", { path: "/" }), readFileDef());
    expect(a.level).not.toBe("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// Native scanner
// ---------------------------------------------------------------------------

describe("native scanner", () => {
  it("native `rm -rf /` => CRITICAL", () => {
    const a = assessAst(makeNative("rm -rf /"));
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("native-rm-rf-root-target");
  });

  it("native `dd of=/dev/sda` => CRITICAL", () => {
    const findings = scanNative("dd if=/dev/zero of=/dev/sda bs=1M");
    expect(findings.some((f) => f.level === "CRITICAL")).toBe(true);
    expect(codes(findings)).toContain("native-dd-device");
  });

  it("native fork bomb => CRITICAL", () => {
    const findings = scanNative(":(){ :|:& };:");
    expect(codes(findings)).toContain("native-fork-bomb");
  });

  it("native harmless `ls -la` => no CRITICAL findings", () => {
    const findings = scanNative("ls -la");
    expect(findings.some((f) => f.level === "CRITICAL")).toBe(false);
    // The full ast assessment still has a MEDIUM passthrough baseline.
    const a = assessAst(makeNative("ls -la"));
    expect(a.level).not.toBe("CRITICAL");
    expect(a.level).not.toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
// maxRisk + floors
// ---------------------------------------------------------------------------

describe("maxRisk + RISK_ORDER + floors", () => {
  it("maxRisk takes the higher of two assessments", () => {
    const low = assessAst(makeAst("read.file", { path: "a" }), readFileDef());
    const crit = assessAst(
      makeAst("remove.folder", { name: "/" }),
      removeFolderDef(),
    );
    expect(maxRisk(low, crit)).toBe("CRITICAL");
    expect(maxRisk(low)).toBe("LOW");
    expect(maxRisk()).toBe("LOW");
  });

  it("RISK_ORDER is the ascending total order", () => {
    expect([...RISK_ORDER]).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
  });

  it("SAFETY_FLOORS includes the non-overridable core floors", () => {
    const floorCodes = SAFETY_FLOORS.map((f) => f.code);
    expect(floorCodes).toEqual(
      expect.arrayContaining([
        "root-delete",
        "home-delete",
        "drive-root-delete",
        "device-write",
        "recursive-chmod-777-broad",
        "empty-target",
      ]),
    );
    expect(SAFETY_FLOORS.find((f) => f.code === "root-delete")?.level).toBe(
      "CRITICAL",
    );
    expect(SAFETY_FLOORS.find((f) => f.code === "empty-target")?.level).toBe(
      "HIGH",
    );
  });
});

// ---------------------------------------------------------------------------
// Resolved phase — real fs, symlink-to-temp-dir (NOT to root)
// ---------------------------------------------------------------------------

describe("assessResolved — real path resolution", () => {
  let tmpRoot: string;
  let realDir: string;
  let linkDir: string;
  let cwd: string;

  beforeAll(async () => {
    // Scaffolding only — created and removed by this test, nothing else.
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oe-safety-"));
    realDir = path.join(tmpRoot, "real-target");
    cwd = path.join(tmpRoot, "work");
    await fs.mkdir(realDir);
    await fs.mkdir(cwd);
    // A couple of files so the blast-radius estimate is non-zero.
    await fs.writeFile(path.join(realDir, "a.txt"), "hello");
    await fs.writeFile(path.join(realDir, "b.txt"), "world!!");
    // A symlink INSIDE cwd that points at the harmless realDir (NOT at /).
    linkDir = path.join(cwd, "dist");
    await fs.symlink(realDir, linkDir, "dir");
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("symlink target is surfaced via 'symlink-target' finding", async () => {
    const ast = makeAst("remove.folder", { name: "dist", recursive: true }, { cwd });
    const a = await assessResolved(ast, removeFolderDef());
    expect(a.phase).toBe("resolved");
    expect(codes(a.findings)).toContain("symlink-target");
    const sl = a.findings.find((f) => f.code === "symlink-target");
    expect(sl?.message).toContain(realDir);
  });

  it("destructive dir op reports affected paths + bytes estimate", async () => {
    const ast = makeAst("remove.folder", { name: realDir, recursive: true }, { cwd });
    const a = await assessResolved(ast, removeFolderDef());
    expect(a.affectedPathsEstimate).toBeGreaterThanOrEqual(2);
    expect(a.affectedBytesEstimate).toBeGreaterThan(0);
  });

  it("cwd that IS the temp root => resolved classifies the real path", async () => {
    // Relative target "." with cwd = realDir resolves to realDir (a real dir).
    const ast = makeAst("remove.folder", { name: ".", recursive: true }, { cwd: realDir });
    const a = await assessResolved(ast, removeFolderDef());
    expect(a.phase).toBe("resolved");
    // Non-empty real dir, recursive delete => at least HIGH.
    expect(RISK_ORDER.indexOf(a.level)).toBeGreaterThanOrEqual(
      RISK_ORDER.indexOf("HIGH"),
    );
  });

  it("ast + resolved combined via maxRisk", async () => {
    const ast = makeAst("remove.folder", { name: "dist", recursive: true }, { cwd });
    const astA = assessAst(ast, removeFolderDef());
    const resA = await assessResolved(ast, removeFolderDef());
    // Combined risk is at least the resolved (symlink) level.
    expect(RISK_ORDER.indexOf(maxRisk(astA, resA))).toBeGreaterThanOrEqual(
      RISK_ORDER.indexOf(resA.level),
    );
  });
});
