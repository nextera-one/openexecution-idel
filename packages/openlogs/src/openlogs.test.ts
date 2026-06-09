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
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openlogs-test-"));
  tmpDirs.push(dir);
  return dir;
}
/**
 * A log path + an isolated key path under the same temp dir, so signing tests
 * never read or write the real `~/.idel/keys/` and don't collide in parallel.
 */
function freshPaths(): { path: string; keyPath: string } {
  const dir = freshDir();
  return { path: join(dir, "openlogs.jsonl"), keyPath: join(dir, "key.json") };
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
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });

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
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ password: "hunter2" }, "do --token abc123longvalueABCDEF"));

    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("hunter2");
    expect(onDisk).not.toContain("abc123longvalueABCDEF");
    expect(onDisk).toContain(REDACTED);
  });

  it("read(limit) returns only the last N records", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    for (let i = 0; i < 5; i++) {
      await writer.append(makeRecord({ i }, `cmd-${i}`));
    }
    const got = await writer.read(2);
    expect(got.map((r) => r.command)).toEqual(["cmd-3", "cmd-4"]);
  });

  it("tolerates a malformed trailing line", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
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
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
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

// ---------------------------------------------------------------------------
// OpenLogWriter — signed, hash-chained accountability (OpenLogs v2)
// ---------------------------------------------------------------------------

describe("OpenLogWriter signed chain", () => {
  it("writes signed v2 records (entry/hash/sig) one per line", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "first"));
    await writer.append(makeRecord({ i: 2 }, "second"));

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const rec0 = JSON.parse(lines[0]!);
    const rec1 = JSON.parse(lines[1]!);
    // v2 envelope shape.
    expect(rec0.entry?.event).toBe("first");
    // The SDK normalizes a bare time string into a full TPS URI, filling in a
    // placeholder location (`L:-`) since a local CLI has no coordinate.
    expect(rec0.entry?.tps).toContain("T:greg.");
    expect(typeof rec0.hash).toBe("string");
    expect(rec0.sig?.alg).toBe("ed25519");
    // The audit record itself rides inside entry.data.
    expect(rec0.entry?.data?.command).toBe("first");
    // Chain link: record 1 points back to record 0's hash.
    expect(rec0.prev_hash).toBeNull();
    expect(rec1.prev_hash).toBe(rec0.hash);
  });

  it("verify() passes for an untouched chain", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    for (let i = 0; i < 4; i++) await writer.append(makeRecord({ i }, `cmd-${i}`));

    const v = await writer.verify();
    expect(v.records).toBe(4);
    expect(v.ok).toBe(true);
    expect(v.integrity.ok).toBe(true);
    expect(v.signatures.ok).toBe(true);
  });

  it("verify() FAILS when a record's payload is tampered with", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "alpha"));
    await writer.append(makeRecord({ i: 2 }, "beta"));
    await writer.append(makeRecord({ i: 3 }, "gamma"));

    // Flip the middle record's payload — the hash no longer matches the link.
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const mid = JSON.parse(lines[1]!);
    mid.entry.data.command = "TAMPERED";
    lines[1] = JSON.stringify(mid);
    writeFileSync(path, lines.join("\n") + "\n");

    const v = await new OpenLogWriter({ path, keyPath }).verify();
    expect(v.ok).toBe(false);
    expect(v.integrity.ok).toBe(false);
  });

  it("verify() FAILS when a record is removed (chain hole)", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "one"));
    await writer.append(makeRecord({ i: 2 }, "two"));
    await writer.append(makeRecord({ i: 3 }, "three"));

    // Drop the middle line: record 3's prev_hash now dangles.
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");

    const v = await new OpenLogWriter({ path, keyPath }).verify();
    expect(v.ok).toBe(false);
    expect(v.integrity.ok).toBe(false);
  });

  it("continues the existing chain across writer instances", async () => {
    const { path, keyPath } = freshPaths();
    await new OpenLogWriter({ path, keyPath }).append(makeRecord({ i: 1 }, "a"));
    // A fresh writer (new process, same files) must link onto the prior head,
    // not fork a new chain.
    await new OpenLogWriter({ path, keyPath }).append(makeRecord({ i: 2 }, "b"));

    const v = await new OpenLogWriter({ path, keyPath }).verify();
    expect(v.records).toBe(2);
    expect(v.ok).toBe(true);
    expect(v.integrity.ok).toBe(true);
  });

  it("redacts secrets before they enter the signed payload", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ password: "hunter2" }, "deploy"));

    // The secret must be absent from the on-disk (signed) bytes, and the chain
    // must still verify — proving redaction happened *before* signing.
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("hunter2");
    expect(onDisk).toContain(REDACTED);
    const v = await writer.verify();
    expect(v.ok).toBe(true);
  });
});
