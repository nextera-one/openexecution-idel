import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, symlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
    const createFolder = entries.find((e) => e.id === "create.folder");
    expect(createFolder?.examples).toContain("create.folder name=dist");
    expect(createFolder?.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "posix",
          command: "mkdir",
          pattern: "mkdir [-p] <name>",
        }),
      ]),
    );
  });

  it("explains a command's resolution", async () => {
    const svc = makeService(await sandbox());
    const view = svc.explain("create.file");
    expect(view.resolved?.id).toBe("create.file");
    expect(view.resolved?.source).toBe("core");
  });
});

describe("TerminalService native terminal audit", () => {
  it("records native terminal lifecycle events to OpenLogs", async () => {
    const dir = await sandbox();
    const writer = new OpenLogWriter({
      path: join(dir, "openlogs.jsonl"),
      keyPath: join(dir, "openlogs.key.json"),
    });
    const runtime = new Runtime({ registry, policy: defaultPolicy(), logWriter: writer });
    const svc = new TerminalService({ runtime, cwd: dir });

    await svc.auditNativeTerminal("native.terminal.start", {
      id: "native_test",
      cwd: dir,
      shell: "/bin/sh",
      pty: true,
      cols: 80,
      rows: 24,
    });

    const [record] = await writer.read();
    expect(record?.command).toBe("native.terminal.start");
    expect(record?.source).toBe("api");
    expect(record?.risk).toBe("HIGH");
    expect(record?.ast.params.shell).toBe("/bin/sh");
    expect(record?.riskFindings.some((f) => f.code === "native-terminal")).toBe(true);
    expect((await writer.verify()).ok).toBe(true);
  });
});

describe("TerminalService.complete", () => {
  it("completes command names", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "create." });
    expect(out).toContain("create.file");
    expect(out).toContain("create.folder");
    expect(svc.complete({ input: "edit." })).toContain("edit.file");
    expect(svc.complete({ input: "open." })).toContain("open.editor");
    expect(svc.complete({ input: "ask." })).toContain("ask.ai");
    expect(svc.complete({ input: "learn." })).toContain("learn.cli");
    expect(svc.complete({ input: "list." })).toContain("list.history");
    expect(svc.complete({ input: "list." })).toContain("list.logs");
    expect(svc.complete({ input: "list." })).toContain("list.registry");
    expect(svc.complete({ input: "tail." })).toContain("tail.file");
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

  it("completes edit.file editor enum values", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "edit.file editor=" });
    expect(out).toEqual(expect.arrayContaining(["editor=auto", "editor=nano", "editor=code"]));
  });

  it("completes ask.ai prompt parameter", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "ask.ai " });
    expect(out).toContain("prompt=");
  });

  it("completes open.editor files and directories", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "package.json"), "{}\n");
    const svc = makeService(dir);
    const out = svc.complete({ input: "open.editor file=", cwd: dir });
    expect(out).toContain("file=package.json");
    expect(out).toContain("file=src/");
  });

  it("completes tail.file files and directories", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "logs"));
    await writeFile(join(dir, "app.log"), "ready\n");
    const svc = makeService(dir);
    const out = svc.complete({ input: "tail.file file=", cwd: dir });
    expect(out).toContain("file=app.log");
    expect(out).toContain("file=logs/");
  });

  it("completes local paths for path params against the request cwd", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "buildout"));
    await writeFile(join(dir, "readme.md"), "hi");
    const svc = makeService(dir);
    const bare = svc.complete({ input: "remove.folder name=", cwd: dir });
    expect(bare).toContain("name=buildout/");
    expect(bare).toContain("name=readme.md");

    const out = svc.complete({ input: "remove.folder name=./", cwd: dir });
    expect(out).toContain("name=./buildout/");
    expect(out).toContain("name=./readme.md");
  });

  it("completes quoted paths with spaces", async () => {
    const dir = await sandbox();
    await mkdir(join(dir, "my folder"));
    await writeFile(join(dir, "my file.sh"), "echo hi\n");
    const svc = makeService(dir);
    const out = svc.complete({ input: 'create.file name="my ', cwd: dir });
    expect(out).toContain('name="my folder/');
    expect(out).toContain('name="my file.sh"');
  });

  it("completes native passthrough script paths", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "script.sh"), "echo hi\n");
    const svc = makeService(dir);
    const out = svc.complete({ input: "! ./", cwd: dir });
    expect(out).toContain("./script.sh");
  });

  it("completes the current command after a batch separator", async () => {
    const svc = makeService(await sandbox());
    const out = svc.complete({ input: "create.file name=a && wai" });
    expect(out).toContain("wait.time");
  });

  it("rejects a completion cwd outside the configured workspace", async () => {
    const dir = await sandbox();
    const svc = makeService(dir);
    expect(() => svc.complete({ input: "read.file name=", cwd: dirname(dir) })).toThrow(
      /cwd escapes the configured workspace root/i,
    );
  });

  it("does not enumerate an absolute or parent-escaping path fragment", async () => {
    const dir = await sandbox();
    const svc = makeService(dir);
    expect(svc.complete({ input: "read.file name=/", cwd: dir })).toEqual([]);
    expect(svc.complete({ input: "read.file name=../", cwd: dir })).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not follow completion symlinks outside the workspace", async () => {
    const dir = await sandbox();
    const outside = await sandbox();
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(dir, "outside"), "dir");
    const svc = makeService(dir);
    expect(svc.complete({ input: "read.file name=outside/", cwd: dir })).toEqual([]);
  });
});

describe("TerminalService.preview", () => {
  it("classifies a command without executing or appending OpenLogs", async () => {
    const dir = await sandbox();
    const writer = new OpenLogWriter({
      path: join(dir, "openlogs.jsonl"),
      keyPath: join(dir, "openlogs.key.json"),
    });
    const runtime = new Runtime({ registry, policy: defaultPolicy(), logWriter: writer });
    const svc = new TerminalService({ runtime, cwd: dir });

    const preview = await svc.preview({
      command: "remove.folder name=/ recursive=true force=true",
    });

    expect(preview.risk.level).toBe("CRITICAL");
    expect(preview.decision.action).toBe("block");
    expect("record" in preview).toBe(false);
    expect(await writer.read()).toEqual([]);
  });

  it("aggregates batch previews to the highest risk command", async () => {
    const svc = makeService(await sandbox());
    const preview = await svc.preview({
      command: "create.file name=x && remove.folder name=/ recursive=true force=true",
    });

    expect("batch" in preview && preview.batch).toBe(true);
    expect(preview.risk.level).toBe("CRITICAL");
    expect(preview.decision.action).toBe("block");
  });
});

describe("TerminalService.run — the safety/policy contract is preserved", () => {
  it("runs a LOW meta command and succeeds", async () => {
    const svc = makeService(await sandbox());
    const out = await svc.run({ command: "list.registry" });
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

  it("does not launch edit.file from the web/service context", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "hi\n");
    const svc = makeService(dir);
    const out = await svc.run({ command: "edit.file path=note.txt editor=nano", cwd: dir });
    expect(out.record.result).toBe("failed");
    expect(out.result?.stderr).toMatch(/interactive terminal/i);
  });

  it("does not launch open.editor from the web/service context", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "hi\n");
    const svc = makeService(dir);
    const out = await svc.run({ command: "open.editor file=note.txt editor=nano", cwd: dir });
    expect(out.record.result).toBe("failed");
    expect(out.result?.stderr).toMatch(/open\.editor requires an interactive terminal/i);
  });

  it("runs && batches sequentially", async () => {
    const dir = await sandbox();
    const svc = makeService(dir);
    const out = await svc.runBatch({
      command: 'create.file name=a.txt && write.file name=b.txt content="ok"',
      cwd: dir,
    });
    expect(out.ok).toBe(true);
    expect(out.outcomes).toHaveLength(2);
    expect(out.outcomes.map((o) => o.record.result)).toEqual(["success", "success"]);
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("ok");
  });

  it("stops && batches after the first non-successful step", async () => {
    const dir = await sandbox();
    const svc = makeService(dir);
    const out = await svc.runBatch({
      command: "read.file name=missing.txt && create.file name=never.txt",
      cwd: dir,
    });
    expect(out.ok).toBe(false);
    expect(out.stoppedAt).toBe(1);
    expect(out.outcomes).toHaveLength(1);
    await expect(readFile(join(dir, "never.txt"), "utf8")).rejects.toThrow();
  });
});

describe("TerminalService editor API", () => {
  it("opens a file through the runtime read path", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "package.json"), '{ "ok": true }\n');
    const svc = makeService(dir);
    const out = await svc.openEditor({ file: "package.json", cwd: dir });
    expect(out.file).toBe("package.json");
    expect(out.language).toBe("json");
    expect(out.content).toBe('{ "ok": true }\n');
    expect(out.outcome.record.command).toBe("read.file");
    expect(out.outcome.record.result).toBe("success");
  });

  it("saves arbitrary text through the runtime write path", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.txt"), "old\n");
    const svc = makeService(dir);
    const content = 'line one\nline "two"\npath C:\\Temp\n';
    const out = await svc.saveEditor({ file: "note.txt", content, cwd: dir });
    expect(out.record.command).toBe("write.file");
    expect(out.record.result).toBe("success");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe(content);
  });

  it("rejects absolute editor paths and parent traversal", async () => {
    const dir = await sandbox();
    const svc = makeService(dir);
    await expect(svc.openEditor({ file: "/etc/passwd", cwd: dir })).rejects.toThrow(
      /must be relative/i,
    );
    await expect(
      svc.saveEditor({ file: "../escaped.txt", content: "blocked\n", cwd: dir }),
    ).rejects.toThrow(/escapes the configured workspace root/i);
  });

  it.skipIf(process.platform === "win32")("rejects editor symlinks that resolve outside the workspace", async () => {
    const dir = await sandbox();
    const outside = await sandbox();
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(dir, "outside"), "dir");
    const svc = makeService(dir);
    await expect(svc.openEditor({ file: "outside/secret.txt", cwd: dir })).rejects.toThrow(
      /resolves outside/i,
    );
    await expect(
      svc.saveEditor({ file: "outside/new.txt", content: "blocked", cwd: dir }),
    ).rejects.toThrow(/parent resolves outside/i);
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

  it("executes when an approval_required command is resubmitted with approve=true", async () => {
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
    const out = await svc.run({
      command: "remove.folder name=v2 recursive=true",
      cwd: dir,
      approve: true,
    });
    expect(out.record.result).toBe("success");
    expect(await readdir(dir)).not.toContain("v2");
  });

  it("records a refusal when an approval_required command is resubmitted with approve=false", async () => {
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
    const out = await svc.run({
      command: "remove.folder name=v2 recursive=true",
      cwd: dir,
      approve: false,
    });
    expect(out.record.result).toBe("blocked_before_execution");
    expect(await readdir(dir)).toContain("v2");
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
    await svc.run({ command: "list.registry", cwd: dir });
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
    expect(typeof body.platform).toBe("string");
    expect(body.agentAvailable).toBe(false);
    expect(body.nativeAvailable).toBe(false);
  });

  it("does not send wildcard CORS and rejects non-loopback browser origins", async () => {
    const allowed = await fetch(`${base}/api/health`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const rejected = await fetch(`${base}/api/health`, {
      headers: { origin: "https://example.com" },
    });
    expect(rejected.status).toBe(403);

    const prefixTrick = await fetch(`${base}/api/health`, {
      headers: { origin: "http://127.0.0.1.evil.com:3000" },
    });
    expect(prefixTrick.status).toBe(403);
  });

  it("rejects DNS-rebinding Host names that merely start with 127.", async () => {
    const rejected = await new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
      const req = httpRequest(`${base}/api/health`, {
        headers: { host: "127.0.0.1.evil.com" },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(rejected.status).toBe(403);
    expect(JSON.parse(rejected.body).error).toMatch(/host is not allowed/i);
  });

  it("accepts a canonical numeric IPv4 address inside 127/8", async () => {
    const accepted = await new Promise<number>((resolveResponse, reject) => {
      const req = httpRequest(`${base}/api/health`, {
        headers: { host: "127.23.45.67:7878" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolveResponse(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
    expect(accepted).toBe(200);
  });

  it("GET /api/native/sessions → active native terminal list", async () => {
    const res = await fetch(`${base}/api/native/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST /api/native/start is disabled unless serve explicitly opts in", async () => {
    const res = await fetch(`${base}/api/native/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/disabled/i);
  });

  it("POST /api/native/:id/input → 404 for an unknown native terminal", async () => {
    const res = await fetch(`${base}/api/native/missing/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "pwd\n" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("POST /api/native/:id/resize → validates size and returns 404 for unknown sessions", async () => {
    const invalid = await fetch(`${base}/api/native/missing/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 1, rows: 0 }),
    });
    expect(invalid.status).toBe(400);

    const missing = await fetch(`${base}/api/native/missing/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    expect(missing.status).toBe(404);
    const body = await missing.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("POST /api/native/:id/signal → validates signal and returns 404 for unknown sessions", async () => {
    const invalid = await fetch(`${base}/api/native/missing/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal: "explode" }),
    });
    expect(invalid.status).toBe(400);

    const missing = await fetch(`${base}/api/native/missing/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal: "SIGINT" }),
    });
    expect(missing.status).toBe(404);
    const body = await missing.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("GET /api/registry → catalog", async () => {
    const res = await fetch(`${base}/api/registry`);
    const body = (await res.json()) as { id: string }[];
    expect(body.some((e) => e.id === "create.file")).toBe(true);
    expect(body.some((e) => e.id === "edit.file")).toBe(true);
    expect(body.some((e) => e.id === "open.editor")).toBe(true);
    expect(body.some((e) => e.id === "ask.ai")).toBe(true);
    expect(body.some((e) => e.id === "learn.cli")).toBe(true);
    const createFolder = body.find((e) => e.id === "create.folder") as {
      adapters?: { name: string; command: string; pattern: string }[];
    } | undefined;
    expect(createFolder?.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "posix", command: "mkdir", pattern: "mkdir [-p] <name>" }),
      ]),
    );
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

  it("POST /api/complete → edit.file suggestions", async () => {
    const res = await fetch(`${base}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "edit.file editor=" }),
    });
    const body = (await res.json()) as string[];
    expect(body).toContain("editor=nano");
    expect(body).toContain("editor=code");
  });

  it("POST /api/complete → open.editor suggestions", async () => {
    const res = await fetch(`${base}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "open.editor file=pack", cwd: process.cwd() }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/cwd escapes/i);
  });

  it("POST /api/complete → learn.cli suggestions", async () => {
    const res = await fetch(`${base}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "learn.cli " }),
    });
    const body = (await res.json()) as string[];
    expect(body).toContain("cli=");
    expect(body).toContain("write=");
  });

  it("POST /api/editor/open and /api/editor/save edit a file", async () => {
    const dir = await sandbox();
    await writeFile(join(dir, "note.json"), '{"old":true}\n');
    const open = await fetch(`${base}/api/editor/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "note.json", cwd: dir }),
    });
    expect(open.status).toBe(200);
    const opened = (await open.json()) as { content: string; language: string };
    expect(opened.content).toBe('{"old":true}\n');
    expect(opened.language).toBe("json");

    const save = await fetch(`${base}/api/editor/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "note.json", content: '{"new":true}\n', cwd: dir }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { record: { result: string } };
    expect(saved.record.result).toBe("success");
    expect(await readFile(join(dir, "note.json"), "utf8")).toBe('{"new":true}\n');
  });

  it("POST /api/editor rejects absolute and parent-escaping files", async () => {
    const absolute = await fetch(`${base}/api/editor/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "/etc/passwd", cwd: tmpdir() }),
    });
    expect(absolute.status).toBe(403);

    const dir = await sandbox();
    const traversal = await fetch(`${base}/api/editor/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "../../escaped.txt", content: "blocked", cwd: dir }),
    });
    expect(traversal.status).toBe(403);
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

  it("POST /api/preview → returns risk without an execution record", async () => {
    const res = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "remove.folder name=/ recursive=true force=true" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record?: unknown; risk: { level: string }; decision: { action: string } };
    expect(body.record).toBeUndefined();
    expect(body.risk.level).toBe("CRITICAL");
    expect(body.decision.action).toBe("block");
  });

  it("POST /api/run → returns batch outcomes for && input", async () => {
    const dir = await sandbox();
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "create.file name=batch-a.txt && read.file name=batch-a.txt",
        cwd: dir,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: boolean; ok: boolean; outcomes: { record: { result: string } }[] };
    expect(body.batch).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.outcomes.map((o) => o.record.result)).toEqual(["success", "success"]);
  });

  it("POST /api/run → rejects ask.ai when no agent is wired", async () => {
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: 'ask.ai prompt="how are you"' }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toMatch(/claude login|ANTHROPIC_API_KEY/i);
  });

  it("POST /api/run/stream → SSE outcome then done", async () => {
    const res = await fetch(`${base}/api/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "list.registry" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: outcome");
    expect(text).toContain("event: done");
  });

  it("POST /api/run/stream → streams each && batch step", async () => {
    const dir = await sandbox();
    const res = await fetch(`${base}/api/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "create.file name=batch-stream.txt && read.file name=batch-stream.txt",
        cwd: dir,
      }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: batch_start");
    expect(text).toContain("event: batch_step");
    expect(text.match(/event: outcome/g)?.length).toBe(2);
    expect(text).toContain("event: done");
  });

  it("POST /api/run/stream → reroutes ask.ai to an SSE error when no agent is wired", async () => {
    const res = await fetch(`${base}/api/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: 'ask.ai prompt="how are you"' }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).not.toContain("event: outcome");
    expect(text).not.toContain("handled by the CLI or web terminal");
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

  it("GET /api/registry/:id with a malformed id → 400 (not a registry miss)", async () => {
    const res = await fetch(`${base}/api/registry/${encodeURIComponent("../../etc/passwd")}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid command id/);
  });

  it("GET /api/registry/:id with a valid id → resolved entry", async () => {
    const res = await fetch(`${base}/api/registry/create.file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: { id: string } | null };
    expect(body.resolved?.id).toBe("create.file");
  });

  it("POST /api/agent/stream → 501 when no agent is wired", async () => {
    const res = await fetch(`${base}/api/agent/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "do something" }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toMatch(/claude login|ANTHROPIC_API_KEY/i);
  });

  it("POST /api/learn → 501 when learning is not wired", async () => {
    const res = await fetch(`${base}/api/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cli: "git" }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toMatch(/learn is not configured/i);
  });
});

// ---------------------------------------------------------------------------
// Native terminal authorization/policy boundary
// ---------------------------------------------------------------------------

describe("startServer — enabled native terminal boundary", () => {
  const token = "test-native-terminal-token-32-bytes-minimum";

  it("refuses insecure enablement without a bearer secret", async () => {
    const dir = await sandbox();
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    await expect(
      startServer({ runtime, port: 0, cwd: dir, allowNativeTerminal: true }),
    ).rejects.toThrow(/requires nativeTerminalAuthToken/i);
  });

  it("requires authorization and rejects unallowed shells and escaped cwd", async () => {
    const dir = await sandbox();
    await writeFile(
      join(dir, "terminal.html"),
      '<meta name="idel-native-terminal-auth" content="__IDEL_NATIVE_TERMINAL_AUTH_TOKEN__">',
    );
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const nativeServer = await startServer({
      runtime,
      port: 0,
      cwd: dir,
      staticDir: dir,
      allowNativeTerminal: true,
      nativeTerminalAuthToken: token,
      allowedNativeShells: ["idel-test-allowed-shell"],
    });
    try {
      const unauthorized = await fetch(`${nativeServer.url}/api/native/sessions`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toMatch(/^Bearer /);

      const authorized = await fetch(`${nativeServer.url}/api/native/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
      expect(authorized.headers.get("set-cookie")).toBeNull();

      const boot = await fetch(`${nativeServer.url}/terminal.html`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(boot.status).toBe(200);
      expect(await boot.text()).toContain(`content="${token}"`);
      expect(boot.headers.get("access-control-allow-origin")).toBeNull();
      expect(boot.headers.get("cache-control")).toBe("no-store");

      const cookieOnly = await fetch(`${nativeServer.url}/api/native/sessions`, {
        headers: { cookie: "idel_native_terminal=attacker-controlled" },
      });
      expect(cookieOnly.status).toBe(401);

      const unallowedShell = await fetch(`${nativeServer.url}/api/native/start`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ shell: "idel-attacker-controlled-executable" }),
      });
      expect(unallowedShell.status).toBe(403);
      expect((await unallowedShell.json()).error).toMatch(/shell is not allowed/i);

      const escapedCwd = await fetch(`${nativeServer.url}/api/native/start`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: dirname(dir), shell: "idel-test-allowed-shell" }),
      });
      expect(escapedCwd.status).toBe(403);
      expect((await escapedCwd.json()).error).toMatch(/cwd escapes/i);
    } finally {
      await nativeServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Static UI + injected agent
// ---------------------------------------------------------------------------

describe("startServer — static UI", () => {
  let server: RunningServer;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "idel-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>UI</title>");
    await writeFile(join(dir, "app.js"), "console.log('hi')");
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    server = await startServer({ runtime, port: 0, cwd: tmpdir(), staticDir: dir });
    base = server.url;
  });
  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>UI</title>");
  });

  it("serves a real asset with its mime type", async () => {
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("does not leak files outside the static dir on traversal", async () => {
    // A decoded traversal must never return the real file outside `dir`. The
    // guard either 404s or falls back to index.html — never the escaped target.
    const res = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    const body = await res.text();
    expect(body).not.toMatch(/root:.*:0:0:/); // no /etc/passwd content
  });

  it("API routes still work alongside static serving", async () => {
    const res = await fetch(`${base}/api/health`);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("startServer — injected agent", () => {
  it("drives an injected agent and streams its events over SSE", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    // A fake agent runner: structurally an AgentRunner, no Anthropic dependency.
    const fakeAgent = () => ({
      // eslint-disable-next-line require-yield
      async *ask(): AsyncGenerator<unknown> {
        yield { type: "text", text: "thinking" };
        yield { type: "proposed", command: "list.registry", dryRun: true };
        yield { type: "done", reason: "end_turn" };
      },
    });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: fakeAgent });
    try {
      const res = await fetch(`${server.url}/api/agent/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "list commands" }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: text");
      expect(text).toContain("event: proposed");
      expect(text).toContain("event: done");
    } finally {
      await server.close();
    }
  });

  it("reroutes ask.ai submitted to /api/run/stream into the injected agent", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    let seenIntent = "";
    const fakeAgent = () => ({
      async *ask(intent: string): AsyncGenerator<unknown> {
        seenIntent = intent;
        yield { type: "text", text: "hello" };
        yield { type: "done", reason: "end_turn" };
      },
    });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: fakeAgent });
    try {
      const res = await fetch(`${server.url}/api/run/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: 'ask.ai prompt="how are you"' }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(seenIntent).toBe("how are you");
      expect(text).toContain("event: text");
      expect(text).toContain("hello");
      expect(text).not.toContain("event: outcome");
    } finally {
      await server.close();
    }
  });

  it("rejects an empty intent with an SSE error", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const fakeAgent = () => ({
      async *ask(): AsyncGenerator<unknown> {
        yield { type: "text", text: "unreached" };
      },
    });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: fakeAgent });
    try {
      const res = await fetch(`${server.url}/api/agent/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "  " }),
      });
      const text = await res.text();
      expect(text).toContain("event: error");
      expect(text).toContain("empty intent");
    } finally {
      await server.close();
    }
  });
});

describe("startServer — injected learn runner", () => {
  it("drives an injected CLI learner over JSON", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const server = await startServer({
      runtime,
      port: 0,
      cwd: tmpdir(),
      learn: async (req) => ({
        cli: req.cli,
        write: req.write === true,
        accepted: 1,
        rejected: 0,
        commands: [{ id: `${req.cli}.status`, accepted: true, risk: "LOW" }],
      }),
    });
    try {
      const res = await fetch(`${server.url}/api/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cli: "git", write: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cli: string; write: boolean; commands: { id: string }[] };
      expect(body.cli).toBe("git");
      expect(body.write).toBe(true);
      expect(body.commands[0]?.id).toBe("git.status");
    } finally {
      await server.close();
    }
  });

  it("returns a JSON error when the injected learner fails", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const server = await startServer({
      runtime,
      port: 0,
      cwd: tmpdir(),
      learn: async () => {
        throw new Error("no model");
      },
    });
    try {
      const res = await fetch(`${server.url}/api/learn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cli: "git" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no model/);
    } finally {
      await server.close();
    }
  });
});

describe("startServer — real-run approval round-trip", () => {
  // A fake agent that, when given an `approve` gate, asks for one real run and
  // yields a different final event depending on the answer — exactly the shape
  // IdelAgent produces, but deterministic and network-free.
  const approvalAgent = () => ({
    // eslint-disable-next-line require-yield
    async *ask(_intent: string, approve?: (info: { command: string; outcome: unknown }) => Promise<boolean>) {
      if (!approve) {
        yield { type: "proposed", command: "create.file name=x", dryRun: true };
        yield { type: "done", reason: "end_turn" };
        return;
      }
      const ok = await approve({ command: "create.file name=x", outcome: { dry: true } });
      if (ok) yield { type: "proposed", command: "create.file name=x", dryRun: false };
      else yield { type: "needs_approval", command: "create.file name=x" };
      yield { type: "done", reason: "end_turn" };
    },
  });

  /** Stream an SSE response, calling onFrame(event, data) per frame. */
  async function streamSse(
    res: Response,
    onFrame: (event: string, data: Record<string, unknown>) => void,
  ): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const l of frame.split("\n")) {
          if (l.startsWith("event:")) event = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        onFrame(event, data ? JSON.parse(data) : {});
      }
    }
  }

  it("emits approval_request, parks, and runs for real after POST /approve true", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: approvalAgent });
    try {
      const res = await fetch(`${server.url}/api/agent/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "make x", allowReal: true }),
      });
      const events: { event: string; data: Record<string, unknown> }[] = [];
      await streamSse(res, (event, data) => {
        events.push({ event, data });
        // When the agent parks for approval, approve it (the stream resumes).
        if (event === "approval_request") {
          void fetch(`${server.url}/api/agent/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approvalId: data["approvalId"], approve: true }),
          });
        }
      });
      const types = events.map((e) => e.event);
      expect(types).toContain("approval_request");
      // After approval, the agent ran for real (dryRun:false).
      const ran = events.find((e) => e.event === "proposed");
      expect(ran?.data["dryRun"]).toBe(false);
      expect(types).toContain("done");
    } finally {
      await server.close();
    }
  });

  it("declines (POST /approve false) → agent leaves the dry-run standing", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: approvalAgent });
    try {
      const res = await fetch(`${server.url}/api/agent/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "make x", allowReal: true }),
      });
      const events: { event: string; data: Record<string, unknown> }[] = [];
      await streamSse(res, (event, data) => {
        events.push({ event, data });
        if (event === "approval_request") {
          void fetch(`${server.url}/api/agent/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approvalId: data["approvalId"], approve: false }),
          });
        }
      });
      const types = events.map((e) => e.event);
      expect(types).toContain("approval_request");
      expect(types).toContain("needs_approval"); // declined
      expect(types).not.toContain("proposed");
    } finally {
      await server.close();
    }
  });

  it("stays propose-only (no approval_request) when allowReal is omitted", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: approvalAgent });
    try {
      const res = await fetch(`${server.url}/api/agent/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "make x" }), // no allowReal
      });
      const text = await res.text();
      expect(text).not.toContain("event: approval_request");
      expect(text).toContain("event: proposed");
    } finally {
      await server.close();
    }
  });

  it("POST /api/agent/approve with an unknown id → 404", async () => {
    const runtime = new Runtime({ registry, policy: defaultPolicy() });
    const server = await startServer({ runtime, port: 0, cwd: tmpdir(), agent: approvalAgent });
    try {
      const res = await fetch(`${server.url}/api/agent/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: "appr_999", approve: true }),
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
