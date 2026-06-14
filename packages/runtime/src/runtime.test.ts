import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Registry } from "@openexecution/registry";
import { defaultPolicy, loadPolicy } from "@openexecution/policy";
import { OpenLogWriter } from "@openexecution/openlogs";
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

  it("tails a file and returns the last requested lines", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "app.log"), "alpha\nbeta\ngamma\n");
    const rt = await makeRuntime();
    const out = await rt.run("tail.file file=app.log lines=2", ctx({ cwd: dir }));
    expect(out.risk.level).toBe("LOW");
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toBe("beta\ngamma\n");
  });

  it("waits for a short duration with wait.time", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("wait.time ms=1", ctx());
    expect(out.risk.level).toBe("LOW");
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toContain("waited 1ms");
  });

  it("runs a script through the runtime pipeline", async () => {
    const dir = await sandbox();
    await writeFile(
      join(dir, "hello.js"),
      "console.log(process.argv.slice(2).join('|'));\n",
    );
    const rt = await makeRuntime();
    const out = await rt.run(
      'run.script path=hello.js shell=node args="one two"',
      ctx({ cwd: dir }),
    );
    expect(out.risk.level).toBe("MEDIUM");
    expect(out.decision.action).toBe("allow");
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toBe("one|two\n");
  });

  it("dry-runs edit.file through the runtime pipeline", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "hi\n");
    const rt = await makeRuntime();
    const out = await rt.run(
      "edit.file path=note.txt editor=code wait=true",
      ctx({ cwd: dir, dryRun: true }),
    );
    expect(out.risk.level).toBe("MEDIUM");
    expect(out.record.result).toBe("dry_run");
    expect(out.result?.stdout).toContain("code --wait");
  });

  it("dry-runs open.editor file= through the runtime pipeline", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "hi\n");
    const rt = await makeRuntime();
    const out = await rt.run(
      "open.editor file=note.txt editor=code wait=true",
      ctx({ cwd: dir, dryRun: true }),
    );
    expect(out.risk.level).toBe("MEDIUM");
    expect(out.record.result).toBe("dry_run");
    expect(out.result?.stdout).toContain("code --wait");
    expect(out.result?.stdout).toContain("note.txt");
  });

  it("refuses edit.file outside an interactive host", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "hi\n");
    const rt = await makeRuntime();
    const out = await rt.run(
      "edit.file path=note.txt editor=nano",
      ctx({ cwd: dir, interactive: false }),
    );
    expect(out.risk.level).toBe("MEDIUM");
    expect(out.record.result).toBe("failed");
    expect(out.result?.stderr).toMatch(/interactive terminal/i);
  });

  it("refuses open.editor outside an interactive host", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "hi\n");
    const rt = await makeRuntime();
    const out = await rt.run(
      "open.editor file=note.txt editor=nano",
      ctx({ cwd: dir, interactive: false }),
    );
    expect(out.risk.level).toBe("MEDIUM");
    expect(out.record.result).toBe("failed");
    expect(out.result?.stderr).toMatch(/open\.editor requires an interactive terminal/i);
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

describe("Phase 2: requiresAffectedPathEstimate is enforced (fail-closed)", () => {
  it("escalates to >= HIGH when a required blast-radius estimate is unavailable", async () => {
    // Override core `remove.folder` (so the real node adapter still resolves it)
    // with a LOWER riskDefault but keep `requiresAffectedPathEstimate`. An
    // unbounded glob whose static prefix doesn't exist yields no estimate, so the
    // fail-closed gate must lift the level above the MEDIUM default.
    const reg = await Registry.loadCore();
    reg.addLayer("custom", [
      {
        id: "remove.folder",
        version: "1.0.0",
        summary: "remove.folder override that requires an estimate (test).",
        category: "filesystem",
        riskDefault: "MEDIUM",
        params: {
          name: { type: "path", required: true },
          recursive: { type: "boolean", default: false },
          force: { type: "boolean", default: false },
          dryRun: { type: "boolean", default: false },
        },
        safety: { destructive: true, requiresAffectedPathEstimate: true, targetParam: "name" },
        adapters: {
          node: { command: "@node", args: [{ kind: "value", param: "name" }] },
        },
      },
    ]);
    const rt = new Runtime({ registry: reg, policy: defaultPolicy() });
    const dir = await sandbox();
    // An unbounded glob whose static prefix doesn't exist => no estimate.
    const out = await rt.run(
      `remove.folder name=${join(dir, "missing-prefix")}/* recursive=true`,
      ctx({ cwd: dir, dryRun: true }),
    );
    // Without the estimate the op must NOT stay MEDIUM — it escalates fail-closed.
    expect(["HIGH", "CRITICAL"]).toContain(out.risk.level);
    expect(out.risk.findings.some((f) => f.code === "missing-affected-estimate")).toBe(true);
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

  it("lets hosts replace the approval handler after construction", async () => {
    const policy = loadPolicy(
      JSON.stringify({
        rules: [
          { match: { command: "remove.folder" }, action: "approval", approvers: ["lead"] },
        ],
      }),
    );
    const dir = await sandbox();
    await mkdir(join(dir, "dist"));
    const rt = new Runtime({ registry, policy, onApproval: async () => false });
    rt.setApprovalHandler(async () => true);

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
  it("list.registry returns the command set", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("list.registry", ctx());
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toMatch(/remove\.folder/);
  });

  it("explain.registry describes a command", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("explain.registry command=remove.folder", ctx());
    expect(out.result?.stdout).toMatch(/riskDefault: HIGH/);
  });

  it("accepts legacy noun-first aliases but records the canonical verb-first id", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("logs.list", ctx());
    expect(out.record.command).toBe("list.logs");
    expect(out.record.ast.command).toBe("list.logs");
  });

  it("ask.ai reports that the host must route the agent", async () => {
    const rt = await makeRuntime();
    const out = await rt.run('ask.ai prompt="list files"', ctx());
    expect(out.risk.level).toBe("LOW");
    expect(out.record.result).toBe("failed");
    expect(out.result?.stderr).toMatch(/handled by the CLI or web terminal/i);
  });

  it("learn.cli reports that the host must route learning", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("learn.cli cli=git", ctx());
    expect(out.risk.level).toBe("LOW");
    expect(out.record.result).toBe("failed");
    expect(out.result?.stderr).toMatch(/handled by the CLI or web terminal/i);
  });

  it("clear commands report that the terminal UI handles scrollback", async () => {
    const rt = await makeRuntime();
    const out = await rt.run("clear.last limit=1", ctx());
    expect(out.risk.level).toBe("LOW");
    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toMatch(/terminal UI/i);
  });

  it("list.history returns recent audited commands capped by limit", async () => {
    const dir = await sandbox();
    const rt = new Runtime({
      registry,
      policy: defaultPolicy(),
      logWriter: new OpenLogWriter({
        path: join(dir, "logs", "openlogs.jsonl"),
        keyPath: join(dir, "keys", "openlogs.key.json"),
      }),
    });
    await rt.run("create.file name=a.txt", ctx({ cwd: dir }));
    await rt.run("read.file name=a.txt", ctx({ cwd: dir }));

    const out = await rt.run("list.history limit=1000", ctx({ cwd: dir }));

    expect(out.record.result).toBe("success");
    expect(out.result?.stdout).toMatch(/create\.file name=a\.txt/);
    expect(out.result?.stdout).toMatch(/read\.file name=a\.txt/);
    expect(out.result?.stdout).toMatch(/success\s+LOW/);
  });
});

describe("OpenLogs append failure is surfaced, not silently swallowed (CONCERNS §2)", () => {
  it("completes the command but warns once on stderr when append fails", async () => {
    const dir = await sandbox();
    let appendCalls = 0;
    // A log writer whose append always rejects — simulates the prev_hash bug that
    // previously meant "no record written, but the demo still printed BLOCKED".
    const failingWriter = {
      append: async () => {
        appendCalls++;
        throw new Error("simulated append failure");
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = new Runtime({ registry, policy: defaultPolicy(), logWriter: failingWriter as any });

    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: any): boolean => {
      writes.push(String(chunk));
      return true;
    };
    try {
      // Two commands → two failed appends, but only ONE warning (once per runtime).
      const a = await rt.run("create.file name=a.txt", ctx({ cwd: dir }));
      const b = await rt.run("create.file name=b.txt", ctx({ cwd: dir }));
      // The command itself must still succeed — logging never sinks a command.
      expect(a.record.result).toBe("success");
      expect(b.record.result).toBe("success");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }

    expect(appendCalls).toBe(2);
    const warnings = writes.filter((w) => w.includes("audit trail may be incomplete"));
    expect(warnings).toHaveLength(1); // warned exactly once, not per-command
    expect(warnings[0]).toContain("simulated append failure");
  });
});
