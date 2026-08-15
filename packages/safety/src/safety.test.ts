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
  escapesCwd,
  isHome,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

const HOME = os.homedir();

describe("Windows path comparison semantics", () => {
  it("compares Windows home paths case-insensitively", () => {
    expect(isHome("C:\\Users\\ALICE", "c:\\users\\alice")).toBe(true);
    expect(isHome("\\\\Server\\Users\\ALICE", "\\\\server\\users\\alice")).toBe(
      true,
    );
  });

  it("compares Windows cwd containment case-insensitively cross-platform", () => {
    expect(
      escapesCwd(
        "C:\\USERS\\Alice\\Project\\src\\index.ts",
        "c:\\users\\alice\\project",
      ),
    ).toBe(false);
    expect(
      escapesCwd(
        "C:\\Users\\Alice\\Project-Escape\\file.txt",
        "c:\\users\\alice\\project",
      ),
    ).toBe(true);
  });

  it("preserves case-sensitive POSIX comparisons", () => {
    expect(isHome("/Home/Alice", "/home/alice")).toBe(false);
    expect(escapesCwd("/Work/Project/file", "/work/project")).toBe(true);
  });
});

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

function networkDef(
  id: string,
  riskDefault: CommandDef["riskDefault"] = "MEDIUM",
): CommandDef {
  return {
    id,
    version: "0.1.0",
    summary: "Network command",
    category: id.includes("firewall") ? "firewall" : "network",
    riskDefault,
    params: {},
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
    // `/` is a filesystem root on POSIX (`root-delete`) but normalizes to a
    // drive root on Windows (`drive-root-delete`). Both are CRITICAL root-class
    // findings — assert one of them rather than the POSIX-only code.
    const found = codes(a.findings);
    expect(
      found.includes("root-delete") || found.includes("drive-root-delete"),
    ).toBe(true);
    expect(found).toContain("recursive-force");
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

  it("destructive op outside cwd (not root/home/system) => MEDIUM (outside-cwd)", () => {
    const a = assessAst(
      makeAst("remove.folder", { name: "/srv/scratch" }, { cwd: "/home/u/project" }),
      removeFolderDef(),
    );
    expect(codes(a.findings)).toContain("outside-cwd");
  });

  it.each(["/etc", "/usr/bin", "/var/lib/app", "/System/Library", "/Library"])(
    "destructive POSIX/macOS target %s has the protected-system HIGH floor",
    (name) => {
      const a = assessAst(makeAst("remove.folder", { name }), removeFolderDef());
      expect(RISK_ORDER.indexOf(a.level)).toBeGreaterThanOrEqual(
        RISK_ORDER.indexOf("HIGH"),
      );
      expect(codes(a.findings)).toContain("protected-system-path");
    },
  );

  it.each([
    "C:\\Windows",
    "c:\\WINDOWS\\System32",
    "D:\\Program Files\\Vendor",
    "C:\\ProgramData",
    "\\\\server\\c$\\Windows\\System32",
  ])("destructive Windows target %s has the protected-system HIGH floor", (name) => {
    const a = assessAst(makeAst("remove.folder", { name }), removeFolderDef());
    expect(RISK_ORDER.indexOf(a.level)).toBeGreaterThanOrEqual(
      RISK_ORDER.indexOf("HIGH"),
    );
    expect(codes(a.findings)).toContain("protected-system-path");
  });

  it("does not confuse similarly prefixed ordinary paths with system trees", () => {
    for (const name of ["/etc-backup", "/variable", "C:\\Windows.old-app"] as const) {
      const a = assessAst(makeAst("remove.folder", { name }), removeFolderDef());
      expect(codes(a.findings)).not.toContain("protected-system-path");
    }
  });
});

describe("assessAst — Windows/UNC cross-platform normalization (Phase 2)", () => {
  // These classify Windows-shaped targets even when running on a POSIX host:
  // before the fix, path.resolve joined them under cwd so the drive-root floor
  // never fired. cwd is POSIX to prove the classifier is host-independent.
  const POSIX_CWD = { cwd: "/home/u/project" };
  const rm = (name: string) =>
    assessAst(
      makeAst("remove.folder", { name, recursive: true, force: true }, POSIX_CWD),
      removeFolderDef(),
    );

  it("drive root C:\\ => CRITICAL (drive-root-delete)", () => {
    const a = rm("C:\\");
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("drive-root-delete");
  });

  it("extended-length drive root \\\\?\\C:\\ => CRITICAL (drive-root-delete)", () => {
    const a = rm("\\\\?\\C:\\");
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("drive-root-delete");
  });

  it("UNC share root \\\\server\\share => CRITICAL (drive-root-delete)", () => {
    const a = rm("\\\\server\\share");
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("drive-root-delete");
  });

  it("extended-length UNC \\\\?\\UNC\\server\\share => CRITICAL", () => {
    const a = rm("\\\\?\\UNC\\server\\share");
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("drive-root-delete");
  });

  it("Windows raw device \\\\.\\PhysicalDrive0 => CRITICAL (device-write)", () => {
    const a = rm("\\\\.\\PhysicalDrive0");
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("device-write");
  });

  it("drive-relative C:foo => escapes cwd (>= MEDIUM, fail-closed)", () => {
    // C:foo has no unambiguous base; we anchor it at the drive root so it reads
    // as outside the POSIX cwd rather than as a harmless local dir.
    const a = rm("C:foo");
    expect(RISK_ORDER.indexOf(a.level)).toBeGreaterThanOrEqual(
      RISK_ORDER.indexOf("MEDIUM"),
    );
    expect(codes(a.findings)).toContain("outside-cwd");
  });

  it("trailing-space evasion C:\\Windows\\u0020 is not treated as a drive root", () => {
    // The trailing space is trimmed in canonicalization, so this is the dir
    // C:\\Windows (still outside the POSIX cwd), NOT a spurious root match.
    const a = rm("C:\\Windows ");
    expect(codes(a.findings)).not.toContain("drive-root-delete");
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

  it.each([
    "/dev/mapper/vg-root",
    "/dev/md0",
    "/dev/dm-0",
    "/dev/nvme0n1p2",
    "/dev/mmcblk0p1",
  ])("RAID/LVM/device-mapper target %s => CRITICAL", (name) => {
    const a = assessAst(makeAst("remove.folder", { name }), removeFolderDef());
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

describe("assessAst — network and firewall intent", () => {
  it("allow.network any to any on any port => CRITICAL", () => {
    const a = assessAst(
      makeAst("allow.network", {
        from: "any",
        to: "any",
        port: "any",
        protocol: "any",
      }),
      networkDef("allow.network"),
    );
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("network-allow-any-any-any");
  });

  it("allow.network public SSH => CRITICAL", () => {
    const a = assessAst(
      makeAst("allow.network", {
        from: "0.0.0.0/0",
        to: "host",
        port: "22",
        protocol: "tcp",
      }),
      networkDef("allow.network"),
    );
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("network-allow-public-admin-port");
  });

  it.each(["0.0.0.0", "::"])(
    "allow.network treats bare unspecified source %s as public for SSH",
    (from) => {
      const a = assessAst(
        makeAst("allow.network", {
          from,
          to: "host",
          port: "22",
          protocol: "tcp",
        }),
        networkDef("allow.network"),
      );
      expect(a.level).toBe("CRITICAL");
      expect(codes(a.findings)).toContain("network-allow-public-admin-port");
    },
  );

  it("does not reinterpret a bare unspecified route destination as a default route", () => {
    const a = assessAst(
      makeAst("add.network.route", {
        destination: "0.0.0.0",
        gateway: "10.0.0.1",
      }),
      networkDef("add.network.route", "HIGH"),
    );
    expect(codes(a.findings)).not.toContain("network-add-default-route");
  });

  it("deny.network SSH => HIGH lockout risk", () => {
    const a = assessAst(
      makeAst("deny.network", { from: "any", to: "host", port: "22" }),
      networkDef("deny.network"),
    );
    expect(a.level).toBe("HIGH");
    expect(codes(a.findings)).toContain("network-deny-admin-port");
  });

  it("flush.firewall => CRITICAL", () => {
    const a = assessAst(
      makeAst("flush.firewall", {}),
      networkDef("flush.firewall", "CRITICAL"),
    );
    expect(a.level).toBe("CRITICAL");
    expect(codes(a.findings)).toContain("firewall-flush");
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
    expect(codes(findings)).toContain("native-passthrough-untrusted");
    // A missed signature must never make arbitrary shell source default-allow.
    const a = assessAst(makeNative("ls -la"));
    expect(a.level).toBe("HIGH");
  });

  it.each([
    "rm --recursive --force /etc",
    "rm -r --force /home/user",
    "rm --recursive -f /usr/local",
  ])("native long/mixed rm flags are detected: %s", (line) => {
    expect(codes(scanNative(line))).toContain("native-rm-rf-root");
  });

  it.each([
    "rm --recursive --force /etc",
    "shred /usr/bin/tool",
    "rmdir /System/Library",
  ])("native POSIX/macOS system-tree deletion is CRITICAL: %s", (line) => {
    const findings = scanNative(line);
    expect(codes(findings)).toContain("native-posix-system-delete");
    expect(findings.find((f) => f.code === "native-posix-system-delete")?.level)
      .toBe("CRITICAL");
  });

  it.each([
    "del /f /s /q C:\\Windows\\System32",
    "Remove-Item -Recurse -Force C:\\Windows",
    "Remove-Item C:\\Windows\\System32 -Force -Recurse",
    "rd /s C:\\ProgramData",
  ])("native Windows system-tree deletion is CRITICAL: %s", (line) => {
    expect(codes(scanNative(line))).toContain("native-windows-system-delete");
  });

  it.each([
    "dd if=/dev/zero of=/dev/mapper/vg-root",
    "dd if=/dev/zero of=/dev/md0",
    "printf x > /dev/dm-0",
  ])("native RAID/LVM/device-mapper writes are CRITICAL: %s", (line) => {
    expect(scanNative(line).some((f) => f.level === "CRITICAL")).toBe(true);
  });

  it("flags find -delete but relies on the unconditional baseline for novel bypasses", () => {
    expect(codes(scanNative("find /tmp -type f -delete"))).toContain(
      "native-find-delete",
    );
    expect(scanNative("python -c 'novel spelling'")[0]).toMatchObject({
      code: "native-passthrough-untrusted",
      level: "HIGH",
    });
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
        "protected-system-path",
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

  it("glob target estimates the blast radius from its static prefix (Phase 2)", async () => {
    // `<realDir>/*.txt` resolved literally would lstat-fail and leave the
    // estimate undefined; we now walk the static prefix <realDir> instead.
    const ast = makeAst(
      "remove.folder",
      { name: path.join(realDir, "*.txt"), recursive: true },
      { cwd },
    );
    const a = await assessResolved(ast, removeFolderDef());
    expect(a.affectedPathsEstimate).toBeGreaterThanOrEqual(2);
    expect(codes(a.findings)).toContain("glob-estimate");
  });

  it("glob with no walkable static prefix => 'glob-unbounded' (fail-closed)", async () => {
    // Point the static prefix at a nonexistent dir so it can't be walked.
    const ast = makeAst(
      "remove.folder",
      { name: path.join(tmpRoot, "nope-missing", "*"), recursive: true },
      { cwd },
    );
    const a = await assessResolved(ast, removeFolderDef());
    expect(a.affectedPathsEstimate).toBeUndefined();
    expect(codes(a.findings)).toContain("glob-unbounded");
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
