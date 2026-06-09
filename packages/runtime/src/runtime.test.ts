import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Registry } from "@openexecution/registry";
import { defaultPolicy, loadPolicy } from "@openexecution/policy";
import type { RuntimeContext } from "@openexecution/types";

import { Runtime } from "./runtime.js";

/**
 * End-to-end runtime integration tests. These exercise the FULL pipeline
 * (parse → resolve → coerce → safety → policy → plan → execute → outcome) with
 * NO log writer, and only ever touch freshly-created temp directories.
 *
 * Safety invariant for the test suite itself: no destructive op may run outside
 * a temp root. The blocked-command tests assert the command never executed.
 */

let registry: Registry;

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    cwd: process.cwd(),
    user: "test",
    host: "test-host",
    os: "linux",
    sessionId: "sess_test",
    ...overrides,
  };
}

async function makeRuntime(policy = defaultPolicy()): Promise<Runtime> {
  return new Runtime({ registry, policy });
}

beforeAll(async () => {
  registry = await Registry.loadCore();
});

const tmpDirs: string[] = [];
async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "idel-rt-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("the thesis: dangerous commands are blocked before execution", () => {
  it("blocks remove.folder name=/ as CRITICAL", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("remove.folder name=/ recursive=true force=true", ctx());
    expect(out.risk.level).toBe("CRITICAL");
    expect(out.decision.action).toBe("block");
    expect(out.record.result).toBe("blocked_before_execution");
    // Critical short-circuit: we must NOT have walked / for an estimate.
    expect(out.record.affectedPathsEstimate).toBeUndefined();
  });

  it("blocks a native rm -rf / passthrough", async () => {
    const rt = await makeRuntime();
    const out = await rt.run('! rm -rf /', ctx());
    expect(out.risk.level).toBe("CRITICAL");
    expect(out.record.result).toBe("blocked_before_execution");
  });

  it("blocks native passthrough entirely when noNative is set", async () => {
    const rt = await makeRuntime();
    const out = await rt.run('! echo hi', ctx({ noNative: true }));
    expect(out.decision.action).toBe("block");
    expect(out.record.result).toBe("blocked_before_execution");
  });
});

describe("safe commands execute for real in a sandbox", () => {
  it("creates a file (node adapter, in-process)", async () => {
    const dir = await sandbox();
    const rt = await makeRuntime();
    const out = await rt.run("create.file name=readme.md", ctx({ cwd: dir }));
    expect(out.record.result).toBe("success");
    const entries = await readdir(dir);
    expect(entries).toContain("readme.md");
  });

  it("lists a folder and returns entries on stdout", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "a.txt"), "");
    await writeFile(join(dir, "b.txt"), "");
    const rt = await makeRuntime();
    const out = await rt.run("list.folder path=.", ctx({ cwd: dir }));
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toContain("a.txt");
    expect(out.result?.stdout).toContain("b.txt");
  });
});

describe("dry-run never touches the filesystem", () => {
  it("simulates remove.folder and leaves the directory intact", async () => {
    const dir = await sandbox();
    const target = join(dir, "dist");
    await mkdir(target);
    await writeFile(join(target, "x.txt"), "");
    const rt = await makeRuntime();
    const out = await rt.run(
      "remove.folder name=dist recursive=true",
      ctx({ cwd: dir, dryRun: true }),
    );
    expect(out.record.result).toBe("dry_run");
    // dist must still exist.
    const entries = await readdir(dir);
    expect(entries).toContain("dist");
  });

  it("HIGH risk triggers require_dry_run under the default policy", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "dist"));
    const rt = await makeRuntime();
    const out = await rt.run("remove.folder name=dist recursive=true", ctx({ cwd: dir }));
    expect(out.risk.level).toBe("HIGH");
    expect(out.decision.action).toBe("require_dry_run");
    expect(out.record.result).toBe("dry_run");
    // Still there because require_dry_run forced a simulation.
    expect(await readdir(dir)).toContain("dist");
  });
});

describe("two-phase safety: the resolved phase catches symlink-to-root", () => {
  it("escalates a symlink whose real target is the filesystem root", async () => {
    const dir = await sandbox();
    const link = join(dir, "innocent");
    // Point a symlink at / — we only CLASSIFY it, never execute against it.
    await symlink("/", link);
    const rt = await makeRuntime();
    const out = await rt.run(
      "remove.folder name=innocent recursive=true",
      ctx({ cwd: dir }),
    );
    // The AST string "innocent" looks harmless; the resolved phase must catch it.
    expect(out.risk.findings.some((f) => f.code === "symlink-target")).toBe(true);
    expect(out.risk.level).toBe("CRITICAL");
    expect(out.record.result).toBe("blocked_before_execution");
  });
});

describe("policy: CRITICAL floor cannot be cleared by a lax rule", () => {
  it("an allow-everything policy still blocks CRITICAL", async () => {
    const policy = loadPolicy(
      JSON.stringify({ rules: [{ match: {}, action: "allow" }] }),
    );
    const rt = await makeRuntime(policy);
    const out = await rt.run("remove.folder name=/ recursive=true force=true", ctx());
    // Even though rule 0 says "allow everything", the CRITICAL floor wins.
    expect(out.decision.action).toBe("block");
    expect(out.record.result).toBe("blocked_before_execution");
  });
});

describe("approval flow", () => {
  it("fails closed in CI when approval is required", async () => {
    const policy = loadPolicy(
      JSON.stringify({
        rules: [
          { match: { command: "remove.folder" }, action: "approval", approvers: ["lead"] },
        ],
      }),
    );
    const rt = new Runtime({ registry, policy });
    const dir = await sandbox();
    await mkdir(join(dir, "dist"));
    const out = await rt.run(
      "remove.folder name=dist recursive=true",
      ctx({ cwd: dir, ci: true }),
    );
    expect(out.decision.action).toBe("approval_required");
    expect(out.record.result).toBe("approval_required");
    expect(await readdir(dir)).toContain("dist");
  });

  it("executes when an interactive approval handler approves", async () => {
    const policy = loadPolicy(
      JSON.stringify({
        rules: [
          { match: { command: "remove.folder" }, action: "approval", approvers: ["lead"] },
        ],
      }),
    );
    const dir = await sandbox();
    await mkdir(join(dir, "dist"));
    const rt = new Runtime({ registry, policy, onApproval: async () => true });
    const out = await rt.run(
      "remove.folder name=dist recursive=true",
      ctx({ cwd: dir }),
    );
    expect(out.record.result).toBe("success");
    expect(await readdir(dir)).not.toContain("dist");
  });
});

describe("usage errors are returned, not thrown", () => {
  it("reports an unknown command as a failed outcome", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("frobnicate.everything now=true", ctx());
    expect(out.record.result).toBe("failed");
    expect(out.decision.reason).toMatch(/unknown command/i);
  });

  it("reports a missing required parameter", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("remove.folder recursive=true", ctx());
    expect(out.record.result).toBe("failed");
    expect(out.decision.reason).toMatch(/param/i);
  });
});

describe("meta commands", () => {
  it("registry.list returns the command set", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("registry.list", ctx());
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toMatch(/remove\.folder/);
  });

  it("registry.explain describes a command", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("registry.explain command=remove.folder", ctx());
    expect(out.result?.stdout).toMatch(/riskDefault: HIGH/);
  });
});
