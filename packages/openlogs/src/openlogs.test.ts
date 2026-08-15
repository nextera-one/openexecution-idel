import { describe, it, expect, afterEach } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenLogRecord, ParamValue } from "@openexecution/types";

import { redact, redactString, REDACTED } from "./redact.js";
import { loadOrCreateKeypair } from "./keys.js";
import { OpenLogWriter } from "./writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a baseline record; override `ast.params` (and anything else) per-test. */
function makeRecord(
  params: Record<string, ParamValue>,
  command = "noop",
  policyReason = "ok",
): OpenLogRecord {
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
    policyReason,
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

  it("redacts slash-bearing credential material instead of assuming it is a path", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const out = redact(makeRecord({ comment: secret }));
    expect(out.ast.params.comment).toBe(REDACTED);
    expect(redactString(`credential ${secret}`)).toBe(
      `credential ${REDACTED}`,
    );
  });

  it("redacts a credential embedded in prose under a non-sensitive key", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const out = redact(makeRecord({ note: `production key is ${key} use it` }));
    expect(out.ast.params.note).toBe(
      `production key is ${REDACTED} use it`,
    );
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

  it("redacts modern provider tokens under innocent keys", () => {
    const out = redact(
      makeRecord({
        gh: "ghs_" + "A".repeat(36),
        anthropic: "sk-ant-api03-" + "b".repeat(40),
        stripe: "sk_live_" + "c".repeat(32),
        npm: "npm_" + "d".repeat(32),
        slack: "xoxb-" + "1".repeat(12) + "-" + "2".repeat(12) + "-" + "3".repeat(24),
      }),
    );
    expect(Object.values(out.ast.params)).toEqual([
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
    ]);
  });

  it("passes through short, non-secret values untouched", () => {
    const out = redact(makeRecord({ path: "/etc/hosts", count: 3, force: true, name: "abc" }));
    expect(out.ast.params.path).toBe("/etc/hosts");
    expect(out.ast.params.count).toBe(3);
    expect(out.ast.params.force).toBe(true);
    expect(out.ast.params.name).toBe("abc");
  });

  it("does not mistake dotted IDEL command names for JWTs", () => {
    expect(redactString("native.terminal.start")).toBe("native.terminal.start");
    expect(redactString("remove.folder")).toBe("remove.folder");
  });

  it("does not redact ordinary long paths as generic secrets", () => {
    const path = "/home/mohammed/Work/openexecution-idel/packages/web/public/terminal.html";
    const out = redact(makeRecord({ path }));
    expect(out.ast.params.path).toBe(path);
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

  it("redacts multi-line private key PEM blocks", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "abc123",
      "def456",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactString(`write.file content="${pem}"`);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
    expect(out).toContain(REDACTED);
  });

  // --- Phase 2: targeted high-confidence bypass shapes -------------------
  it("redacts URL userinfo (user:pass@host)", () => {
    const out = redactString("curl https://alice:hunter2@example.com/repo.git");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("example.com"); // host kept
    expect(out).toContain(REDACTED);
  });

  it("redacts a secret-bearing URL query param (?token=…)", () => {
    const out = redactString(
      "fetch https://api.example.com/v1/data?token=abc123SECRETvalue&page=2",
    );
    expect(out).not.toContain("abc123SECRETvalue");
    expect(out).toContain("page=2"); // non-secret query param kept
    expect(out).toContain(REDACTED);
  });

  it("redacts an Authorization: Bearer header", () => {
    const out = redactString(
      'curl -H "Authorization: Bearer sk-test-ABCDEFGHIJKLMNOP1234" https://x',
    );
    expect(out).not.toContain("sk-test-ABCDEFGHIJKLMNOP1234");
    expect(out).toContain(REDACTED);
  });

  it("redacts a lowercase AWS access key id", () => {
    // Valid shape: AKIA + 16 chars = 20 total, lowercased.
    const out = redactString("export KEYID akiaiosfodnn7example");
    expect(out).not.toContain("akiaiosfodnn7example");
    expect(out).toContain(REDACTED);
  });

  it("redact() scrubs a secret embedded in policyReason", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const rec = makeRecord({ name: "x" }, "create.file", `blocked: token ${jwt} present`);
    const out = redact(rec);
    expect(out.policyReason).not.toContain(jwt);
    expect(out.policyReason).toContain(REDACTED);
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
    const [signed] = await writer.readSigned();
    expect(signed?.entry.event).toBe("idel.command");
    expect((await writer.verify()).ok).toBe(true);
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
    expect(v.trust.ok).toBe(true);
    expect(v.trust.trusted).toBe(4);
    expect(v.policy.ok).toBe(true);
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

  it("serializes concurrent appends without forking the chain", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => writer.append(makeRecord({ i }, `cmd-${i}`))),
    );

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(10);
    const v = await new OpenLogWriter({ path, keyPath }).verify();
    expect(v.records).toBe(10);
    expect(v.ok).toBe(true);
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

  it("creates the key file with owner-only permissions on POSIX", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "first"));
    if (process.platform === "win32") return;
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });
});

describe("OpenLogWriter trust and durable continuity", () => {
  it("can require pre-provisioned verifier trust instead of self-pinning", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({
      path,
      keyPath,
      allowLocalDevelopmentTrustBootstrap: false,
    });
    await expect(writer.append(makeRecord({ i: 1 }, "first"))).rejects.toThrow(
      /self-pinning is disabled/,
    );
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("keeps verifier trust separate from the signing private key and labels assurance", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "first"));

    const trustPath = `${keyPath}.trust.json`;
    const trustRaw = readFileSync(trustPath, "utf8");
    expect(trustRaw).not.toContain("privateKey");
    const trust = JSON.parse(trustRaw) as {
      assurance: string;
      trustedKeys: Array<{ kid: string; publicKeyHex: string }>;
    };
    expect(trust.assurance).toBe(
      "local-development-self-pinned-not-externally-anchored",
    );

    // Verification is independent of the private key file. An explicitly
    // configured verifier continues to work after the local trust file and
    // signing private key are removed.
    unlinkSync(keyPath);
    unlinkSync(trustPath);
    const verified = await new OpenLogWriter({
      path,
      keyPath,
      trustedKeys: trust.trustedKeys,
    }).verify();
    expect(verified.ok).toBe(true);
    expect(verified.assurance).toEqual({
      signing: "local-development",
      externalAnchoring: false,
      trustSource: "explicit-verifier-configuration",
    });

    const withoutTrust = await new OpenLogWriter({ path, keyPath }).verify();
    expect(withoutTrust.ok).toBe(false);
    expect(withoutTrust.error).toMatch(/trust configuration is missing/);
  });

  it("persists the expected kid, record count and chain head with owner-only permissions", async () => {
    const { path, keyPath } = freshPaths();
    await new OpenLogWriter({ path, keyPath }).append(
      makeRecord({ i: 1 }, "first"),
    );
    const statePath = `${path}.continuity.json`;
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    const [record] = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
    expect(state).toMatchObject({
      version: 1,
      assurance: "local-development-not-externally-anchored",
      expectedKid: record.sig.kid,
      recordCount: 1,
      chainHead: record.hash,
    });
    expect(state.expectedPublicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      expect(statSync(`${keyPath}.trust.json`).mode & 0o777).toBe(0o600);
    }
  });

  it("fails verification and append after tail truncation", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "one"));
    await writer.append(makeRecord({ i: 2 }, "two"));
    await writer.append(makeRecord({ i: 3 }, "three"));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");

    const verifier = new OpenLogWriter({ path, keyPath });
    const result = await verifier.verify();
    expect(result.ok).toBe(false);
    expect(result.continuity.error).toMatch(/rollback\/truncation/);
    await expect(
      verifier.append(makeRecord({ i: 4 }, "four")),
    ).rejects.toThrow(/rollback\/truncation/);
  });

  it("recovers a fully fsynced append left ahead of its checkpoint", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "one"));
    const statePath = `${path}.continuity.json`;
    const oldCheckpoint = readFileSync(statePath, "utf8");
    await writer.append(makeRecord({ i: 2 }, "two"));

    // This is the recoverable crash window: log fsync completed, but the
    // atomic checkpoint replace did not. The old head must still be present at
    // its exact count and the whole extension must remain cryptographically valid.
    writeFileSync(statePath, oldCheckpoint);
    expect((await new OpenLogWriter({ path, keyPath }).verify()).ok).toBe(true);
    await new OpenLogWriter({ path, keyPath }).append(
      makeRecord({ i: 3 }, "three"),
    );
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      recordCount: number;
    };
    expect(state.recordCount).toBe(3);
  });

  it.each([
    ["empty log", (path: string) => writeFileSync(path, "")],
    ["deleted log", (path: string) => unlinkSync(path)],
  ])("fails closed after an established chain becomes an %s", async (_name, reset) => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "one"));
    reset(path);

    const result = await new OpenLogWriter({ path, keyPath }).verify();
    expect(result.ok).toBe(false);
    expect(result.continuity.error).toMatch(/rollback\/truncation/);
    await expect(
      new OpenLogWriter({ path, keyPath }).append(makeRecord({ i: 2 }, "two")),
    ).rejects.toThrow(/rollback\/truncation/);
  });

  it("fails closed when continuity evidence disappears", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "one"));
    unlinkSync(`${path}.continuity.json`);

    const result = await new OpenLogWriter({ path, keyPath }).verify();
    expect(result.ok).toBe(false);
    expect(result.continuity.error).toMatch(/checkpoint is missing/);
    await expect(
      new OpenLogWriter({ path, keyPath }).append(makeRecord({ i: 2 }, "two")),
    ).rejects.toThrow(/checkpoint disappeared/);
  });

  it("refuses a fresh root when log and checkpoint disappear but trust remains", async () => {
    const { path, keyPath } = freshPaths();
    await new OpenLogWriter({ path, keyPath }).append(
      makeRecord({ i: 1 }, "one"),
    );
    unlinkSync(path);
    unlinkSync(`${path}.continuity.json`);

    const resetWriter = new OpenLogWriter({ path, keyPath });
    expect((await resetWriter.verify()).ok).toBe(false);
    await expect(
      resetWriter.append(makeRecord({ i: 2 }, "two")),
    ).rejects.toThrow(/log and continuity evidence disappeared/);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("detects a replaced signing key before appending", async () => {
    const { path, keyPath } = freshPaths();
    await new OpenLogWriter({ path, keyPath }).append(
      makeRecord({ i: 1 }, "one"),
    );
    const replacementPath = join(freshDir(), "replacement.key.json");
    await loadOrCreateKeypair(replacementPath);
    copyFileSync(replacementPath, keyPath);

    // Existing evidence still verifies against independent trust.
    expect((await new OpenLogWriter({ path, keyPath }).verify()).ok).toBe(true);
    await expect(
      new OpenLogWriter({ path, keyPath }).append(makeRecord({ i: 2 }, "two")),
    ).rejects.toThrow(/not present in the independent verifier trust/);
  });

  it("does not regenerate over a corrupt existing signing key", async () => {
    const { path, keyPath } = freshPaths();
    await new OpenLogWriter({ path, keyPath }).append(
      makeRecord({ i: 1 }, "one"),
    );
    writeFileSync(keyPath, '{"kid":"broken"}\n');

    await expect(
      new OpenLogWriter({ path, keyPath }).append(makeRecord({ i: 2 }, "two")),
    ).rejects.toThrow(/signing key file is invalid; refusing replacement/);
    expect(JSON.parse(readFileSync(keyPath, "utf8"))).toEqual({ kid: "broken" });
  });

  it("detects verifier trust replacement against the continuity pin", async () => {
    const { path, keyPath } = freshPaths();
    await new OpenLogWriter({ path, keyPath }).append(
      makeRecord({ i: 1 }, "one"),
    );
    const replacement = freshPaths();
    await new OpenLogWriter(replacement).append(makeRecord({ i: 9 }, "other"));
    copyFileSync(`${replacement.keyPath}.trust.json`, `${keyPath}.trust.json`);

    const result = await new OpenLogWriter({ path, keyPath }).verify();
    expect(result.ok).toBe(false);
    expect(result.continuity.error).toMatch(/trust replacement/);
  });

  it("detects a wholesale locally re-signed log reset while the checkpoint remains", async () => {
    const original = freshPaths();
    await new OpenLogWriter(original).append(makeRecord({ i: 1 }, "original"));
    await new OpenLogWriter(original).append(makeRecord({ i: 2 }, "original-two"));

    const replacement = freshPaths();
    await new OpenLogWriter(replacement).append(makeRecord({ i: 9 }, "forged-reset"));
    copyFileSync(replacement.path, original.path);
    copyFileSync(replacement.keyPath, original.keyPath);
    copyFileSync(
      `${replacement.keyPath}.trust.json`,
      `${original.keyPath}.trust.json`,
    );

    const result = await new OpenLogWriter(original).verify();
    expect(result.ok).toBe(false);
    expect(result.continuity.error).toMatch(/trust replacement/);
  });

  it("rejects malformed trailing bytes instead of silently skipping them", async () => {
    const { path, keyPath } = freshPaths();
    const writer = new OpenLogWriter({ path, keyPath });
    await writer.append(makeRecord({ i: 1 }, "one"));
    writeFileSync(path, '{"partial":', { flag: "a" });

    const result = await writer.verify();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Malformed OpenLogs line 2/);
    await expect(writer.append(makeRecord({ i: 2 }, "two"))).rejects.toThrow(
      /malformed at line 2/,
    );
  });

  it("reclaims a stale lock whose owner is gone", async () => {
    const { path, keyPath } = freshPaths();
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({
        version: 1,
        token: "abandoned",
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAtMs: Date.now() - 60_000,
      }) + "\n",
      { mode: 0o600 },
    );
    const writer = new OpenLogWriter({
      path,
      keyPath,
      lockStaleMs: 10,
      lockWaitMs: 1_000,
    });
    await writer.append(makeRecord({ i: 1 }, "one"));
    expect((await writer.verify()).ok).toBe(true);
  });

  it("serializes concurrent appends from independent writer instances", async () => {
    const { path, keyPath } = freshPaths();
    const writers = Array.from(
      { length: 12 },
      () => new OpenLogWriter({ path, keyPath }),
    );
    await Promise.all(
      writers.map((writer, i) =>
        writer.append(makeRecord({ i }, `parallel-${i}`)),
      ),
    );

    const result = await new OpenLogWriter({ path, keyPath }).verify();
    expect(result.ok).toBe(true);
    expect(result.records).toBe(12);
    const state = JSON.parse(
      readFileSync(`${path}.continuity.json`, "utf8"),
    ) as { recordCount: number };
    expect(state.recordCount).toBe(12);
  });
});
