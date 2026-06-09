import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Registry } from "@openexecution/registry";
import { defaultPolicy } from "@openexecution/policy";
import { OpenLogWriter } from "@openexecution/openlogs";
import { Runtime } from "@openexecution/runtime";

import { TerminalService } from "./service.js";
import { startServer, type RunningServer } from "./server.js";

/**
 * Tests for the server layer. Two halves:
 *   1. TerminalService — the transport-agnostic core, exercised directly.
 *   2. startServer — the real node:http server, hit over loopback with fetch.
 *
 * Both run every command through a real Runtime + core registry, so they assert
 * the GUI boundary preserves the full safety/policy/OpenLogs contract. All
 * filesystem effects are confined to fresh temp dirs.
 */

let registry: Registry;

beforeAll(async () => {
  registry = await Registry.loadCore();
});

const tmpDirs: string[] = [];
async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "idel-srv-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeService(cwd: string, opts: { noNative?: boolean } = {}): TerminalService {
  const runtime = new Runtime({ registry, policy: defaultPolicy() });
  return new TerminalService({ runtime, cwd, noNative: opts.noNative });
}

// ---------------------------------------------------------------------------
// TerminalService
// ---------------------------------------------------------------------------

describe("TerminalService.registry", () => {
  it("returns the full command catalog with risk + params", async () => {
    const svc = makeService(await sandbox());
    const entries = svc.registry();
    expect(entries.length).toBeGreaterThan(20);
    const removeFolder = entries.find((e) => e.id === "remove.folder");
    expect(removeFolder).toBeDefined();
    expect(removeFolder!.risk).toBe("HIGH");
    expect(removeFolder!.params.some((p) => p.name === "recursive")).toBe(true);
  });

  it("explains a command's resolution", async () => {
    const svc = makeService(await sandbox());
    const view = svc.explain("create.file");
    expect(view.resolved?.id).toBe("create.file");
    expect(view.resolved?.source).toBe("core");
  });
});

describe("TerminalService.complete", () => {
  it("completes command names", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "create." });
    expect(out).toContain("create.file");
    expect(out).toContain("create.folder");
  });

  it("completes parameter names after a command", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "remove.folder " });
    expect(out).toContain("name=");
    expect(out).toContain("recursive=");
  });

  it("completes boolean values", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "remove.folder recursive=" });
    expect(out).toEqual(expect.arrayContaining(["recursive=true", "recursive=false"]));
  });

  it("completes local paths for path params against the request cwd", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "buildout"));
    await writeFile(join(dir, "readme.md"), "hi");
    const svc = makeService(dir);
    // `name=./` lists the cwd's contents (a bare `name=` lists the parent, by the
    // shared completer's contract — same as the CLI readline completer).
    const out = svc.complete({ input: "remove.folder name=./", cwd: dir });
    expect(out).toContain("name=./buildout/");
    expect(out).toContain("name=./readme.md");
  });
});

describe("TerminalService.run — the safety/policy contract is preserved", () => {
  it("runs a LOW meta command and succeeds", async () => {
    const svc = makeService(await sandbox());
    const out = await svc.run({ command: "registry.list" });
    expect(out.risk.level).toBe("LOW");
    expect(out.record.result).toBe("success");
  });

  it("executes a LOW create.file in the sandbox", async () => {
    const dir = await sandbox();
    const svc = makeService(dir);
    const out = await svc.run({ command: "create.file name=hello.txt", cwd: dir });
    expect(out.record.result).toBe("success");
    expect(out.risk.level).toBe("LOW");
  });

  it("blocks remove.folder name=/ as CRITICAL before execution", async () => {
    const svc = makeService(await sandbox());
    const out = await svc.run({
      command: "remove.folder name=/ recursive=true force=true",
    });
    expect(out.risk.level).toBe("CRITICAL");
    expect(out.decision.action).toBe("block");
    expect(out.record.result).toBe("blocked_before_execution");
  });

  it("surfaces HIGH risk + policy decision for a real destructive command", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "victim"));
    const svc = makeService(dir);
    const out = await svc.run({
      command: "remove.folder name=victim recursive=true",
      cwd: dir,
      dryRun: true, // never actually delete inside the test
    });
    expect(out.risk.level).toBe("HIGH");
    expect(out.record.dryRun).toBe(true);
    expect(out.record.result).toBe("dry_run");
  });

  it("rejects native passthrough when noNative is set", async () => {
    const svc = makeService(await sandbox(), { noNative: true });
    await expect(
      svc.run({ command: "rm -rf x", native: true }),
    ).rejects.toThrow(/native passthrough is disabled/);
  });
});

describe("TerminalService approval handling", () => {
  it("returns approval_required unexecuted when no approval is supplied", async () => {
    // A policy that requires approval for HIGH. Build a runtime with it.
    const runtime = new Runtime({
      registry,
      policy: {
        rules: [
          { match: { risk: "HIGH" }, action: "approval_required", approvers: ["lead"] },
        ],
      },
    });
    const dir = await sandbox();
    await mkdir(join(dir, "v2"));
    const svc = new TerminalService({ runtime, cwd: dir });
    const out = await svc.run({ command: "remove.folder name=v2 recursive=true", cwd: dir });
    // ci-mode default (no approve flag) → approval_required is recorded, not run.
    expect(out.decision.action).toBe("approval_required");
    expect(out.record.result).toBe("approval_required");
  });
});

describe("TerminalService.logs", () => {
  it("reads back recorded audit entries", async () => {
    const dir = await sandbox();
    const runtime = new Runtime({
      registry,
      policy: defaultPolicy(),
      logWriter: new OpenLogWriter({
        path: join(dir, "logs", "openlogs.jsonl"),
        keyPath: join(dir, "keys", "openlogs.key.json"),
      }),
    });
    const svc = new TerminalService({ runtime, cwd: dir });
    await svc.run({ command: "registry.list", cwd: dir });
    await svc.run({ command: "create.file name=a.txt", cwd: dir });
    const logs = await svc.logs(10);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((r) => r.command.includes("create.file"))).toBe(true);
  });

  it("returns empty logs when no writer is configured", async () => {
    const svc = makeService(await sandbox());
    expect(await svc.logs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTP server (real socket)
// ---------------------------------------------------------------------------

describe("startServer (HTTP)", () => {
  let server: RunningServer;
  let base: string;

  beforeAll(async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    server = await startServer({ runtime, port: 0, cwd: tmpdir() });
    base = server.url;
  });
  afterAll(async () => {
    await server.close();
  });

  it("GET /api/health → ok", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /api/registry → catalog", async () => {
    const res = await fetch(`${base}/api/registry`);
    const body = (await res.json()) as { id: string }[];
    expect(body.some((e) => e.id === "create.file")).toBe(true);
  });

  it("POST /api/complete → suggestions", async () => {
    const res = await fetch(`${base}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "create." }),
    });
    const body = (await res.json()) as string[];
    expect(body).toContain("create.file");
  });

  it("POST /api/run → blocks CRITICAL", async () => {
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "remove.folder name=/ recursive=true force=true" }),
    });
    const body = (await res.json()) as { record: { result: string }; risk: { level: string } };
    expect(body.risk.level).toBe("CRITICAL");
    expect(body.record.result).toBe("blocked_before_execution");
  });

  it("POST /api/run/stream → SSE outcome then done", async () => {
    const res = await fetch(`${base}/api/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "registry.list" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: outcome");
    expect(text).toContain("event: done");
  });

  it("unknown route → 404 JSON", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/);
  });

  it("rejects an oversized body", async () => {
    const big = "x".repeat(1_000_001);
    const res = await fetch(`${base}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: big }),
    });
    expect(res.status).toBe(413);
  });
});
