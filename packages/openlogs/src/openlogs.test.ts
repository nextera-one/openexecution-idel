import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenLogRecord, ParamValue } from "@openexecution/types";

import { redact, redactString, REDACTED } from "./redact.js";
import { OpenLogWriter } from "./writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a baseline record; override `ast.params` (and anything else) per-test. */
function makeRecord(params: Record<string, ParamValue>, command = "noop"): OpenLogRecord {
  return {
    timestamp: "2026-06-09T00:00:00.000Z",
    sessionId: "sess-1",
    user: "alice",
    host: "host-1",
    os: "linux",
    cwd: "/work",
    source: "idel",
    command,
    ast: { command: "noop", params },
    risk: "LOW",
    riskFindings: [],
    policyDecision: "allow",
    policyReason: "ok",
    dryRun: false,
    result: "success",
  };
}

const tmpDirs: string[] = [];
function freshLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openlogs-test-"));
  tmpDirs.push(dir);
  return join(dir, "openlogs.jsonl");
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// redact() — key-based
// ---------------------------------------------------------------------------

describe("redact() by key name", () => {
  it("redacts a `password` value", () => {
    const out = redact(makeRecord({ password: "hunter2" }));
    expect(out.ast.params.password).toBe(REDACTED);
  });

  it("redacts a `token` value", () => {
    const out = redact(makeRecord({ token: "shorttok" }));
    expect(out.ast.params.token).toBe(REDACTED);
  });

  it("redacts an `api_key` value (api[-_]?key)", () => {
    const out = redact(makeRecord({ api_key: "x", "api-key": "y", apikey: "z" }));
    expect(out.ast.params.api_key).toBe(REDACTED);
    expect(out.ast.params["api-key"]).toBe(REDACTED);
    expect(out.ast.params.apikey).toBe(REDACTED);
  });

  it("redacts a `secret` value", () => {
    const out = redact(makeRecord({ client_secret: "abc" }));
    expect(out.ast.params.client_secret).toBe(REDACTED);
  });

  it("redacts a sensitive key even when the value is a number/boolean", () => {
    const out = redact(makeRecord({ passphrase: 1234, authEnabled: true }));
    expect(out.ast.params.passphrase).toBe(REDACTED);
    expect(out.ast.params.authEnabled).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// redact() — value-based
// ---------------------------------------------------------------------------

describe("redact() by value shape", () => {
  it("redacts a JWT-shaped value under an innocent key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redact(makeRecord({ note: jwt }));
    expect(out.ast.params.note).toBe(REDACTED);
  });

  it("redacts a long base64-ish token under an innocent key", () => {
    const out = redact(makeRecord({ comment: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVox" }));
    expect(out.ast.params.comment).toBe(REDACTED);
  });

  it("redacts an AWS access key id under an innocent key", () => {
    const out = redact(makeRecord({ ref: "AKIAIOSFODNN7EXAMPLE" }));
    expect(out.ast.params.ref).toBe(REDACTED);
  });

  it("redacts a GitHub PAT / OpenAI key under an innocent key", () => {
    const out = redact(
      makeRecord({ a: "ghp_" + "A".repeat(36), b: "sk-" + "b".repeat(40) }),
    );
    expect(out.ast.params.a).toBe(REDACTED);
    expect(out.ast.params.b).toBe(REDACTED);
  });

  it("passes through short, non-secret values untouched", () => {
    const out = redact(makeRecord({ path: "/etc/hosts", count: 3, force: true, name: "abc" }));
    expect(out.ast.params.path).toBe("/etc/hosts");
    expect(out.ast.params.count).toBe(3);
    expect(out.ast.params.force).toBe(true);
    expect(out.ast.params.name).toBe("abc");
  });

  it("is pure — does not mutate the input record", () => {
    const input = makeRecord({ password: "hunter2" });
    redact(input);
    expect(input.ast.params.password).toBe("hunter2");
  });

  it("passes the caller-supplied timestamp through unchanged", () => {
    const out = redact(makeRecord({ x: "y" }));
    expect(out.timestamp).toBe("2026-06-09T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// redactString()
// ---------------------------------------------------------------------------

describe("redactString()", () => {
  it("redacts `--token <value>`", () => {
    const out = redactString("idel deploy --token abc123longvalueABCDEF --env prod");
    expect(out).not.toContain("abc123longvalueABCDEF");
    expect(out).toContain(`--token ${REDACTED}`);
    expect(out).toContain("--env prod");
  });

  it("redacts `key=value` for a sensitive key", () => {
    const out = redactString("run --api-key=supersecretvalue123 foo");
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain(`--api-key=${REDACTED}`);
  });

  it("redacts a bare secret-looking token anywhere in the line", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactString(`curl -H authorization ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED);
  });

  it("leaves a command with no secrets untouched", () => {
    const cmd = "ls -la /tmp --color=auto";
    expect(redactString(cmd)).toBe(cmd);
  });
});

// ---------------------------------------------------------------------------
// OpenLogWriter
// ---------------------------------------------------------------------------

describe("OpenLogWriter", () => {
  it("appends JSONL and read() returns parsed records in order", async () => {
    const path = freshLogPath();
    const writer = new OpenLogWriter({ path });

    await writer.append(makeRecord({ i: 1 }, "first"));
    await writer.append(makeRecord({ i: 2 }, "second"));
    await writer.append(makeRecord({ i: 3 }, "third"));

    const got = await writer.read();
    expect(got.map((r) => r.command)).toEqual(["first", "second", "third"]);

    // File really is newline-delimited JSON, one record per line.
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk.trimEnd().split("\n")).toHaveLength(3);
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  it("redacts secrets before writing to disk", async () => {
    const path = freshLogPath();
    const writer = new OpenLogWriter({ path });
    await writer.append(makeRecord({ password: "hunter2" }, "do --token abc123longvalueABCDEF"));

    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("hunter2");
    expect(onDisk).not.toContain("abc123longvalueABCDEF");
    expect(onDisk).toContain(REDACTED);
  });

  it("read(limit) returns only the last N records", async () => {
    const path = freshLogPath();
    const writer = new OpenLogWriter({ path });
    for (let i = 0; i < 5; i++) {
      await writer.append(makeRecord({ i }, `cmd-${i}`));
    }
    const got = await writer.read(2);
    expect(got.map((r) => r.command)).toEqual(["cmd-3", "cmd-4"]);
  });

  it("tolerates a malformed trailing line", async () => {
    const path = freshLogPath();
    const writer = new OpenLogWriter({ path });
    await writer.append(makeRecord({ i: 1 }, "good-1"));
    await writer.append(makeRecord({ i: 2 }, "good-2"));

    // Simulate an interrupted write: a partial JSON fragment with no newline.
    writeFileSync(path, '{"command":"good-3","ast":{"command":"x","par', { flag: "a" });

    const got = await writer.read();
    expect(got.map((r) => r.command)).toEqual(["good-1", "good-2"]);
  });

  it("read() on a missing file returns an empty array", async () => {
    const writer = new OpenLogWriter({ path: join(tmpdir(), "openlogs-does-not-exist-xyz.jsonl") });
    expect(await writer.read()).toEqual([]);
  });

  it("records a policy block as a normal event (blocked_before_execution)", async () => {
    const path = freshLogPath();
    const writer = new OpenLogWriter({ path });
    const blocked: OpenLogRecord = {
      ...makeRecord({ target: "/" }, "remove.folder"),
      policyDecision: "block",
      policyReason: "root delete",
      result: "blocked_before_execution",
    };
    await writer.append(blocked);

    const [got] = await writer.read();
    expect(got?.result).toBe("blocked_before_execution");
    expect(got?.policyDecision).toBe("block");
  });
});
