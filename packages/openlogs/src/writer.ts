/**
 * OpenLogWriter — the append-only, signed, hash-chained audit trail (spec §23).
 *
 * Each command becomes an **OpenLogs v2 record**: the redacted audit data is
 * wrapped in a TPS-stamped entry, SHA-256-linked to the previous record, and
 * Ed25519-signed with the machine's OpenLogs key. The file is JSONL, one signed
 * record per line, and only ever appended to — so the log is tamper-*evident*
 * (break a hash link or a signature and `verify()` flags the exact index).
 *
 * This replaces the earlier plain-JSONL writer. The public API (`append`,
 * `read`, `path`) is unchanged so the runtime and CLI are unaffected; what
 * changed is that records are now provable, not merely append-only.
 *
 * Redaction runs *before* the entry is built and signed, so secrets never enter
 * the signed payload. Because the payload is immutable once signed, getting the
 * redaction order right matters more here than it did for plain JSONL.
 */

import { mkdir, appendFile, readFile, open, unlink } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

import {
  createV2Record,
  signV2Record,
  verifyV2Chain,
  type OpenLogsV2Record,
  type OpenLogsTrustedKey,
  type VerifyResult,
} from "@nextera.one/openlogs-sdk";
import { TPS } from "@nextera.one/tps-standard";

import type { OpenLogRecord } from "@openexecution/types";

import { redact } from "./redact.js";
import { loadOrCreateKeypair, type OpenLogKeypair } from "./keys.js";

/** Default log location: `~/.idel/logs/openlogs.jsonl`. */
const DEFAULT_REL_PATH = ".idel/logs/openlogs.jsonl";

/** Number of records `read()` returns when no limit is given. */
const DEFAULT_READ_LIMIT = 50;

export interface OpenLogWriterOptions {
  /**
   * Override the log file path. `~` is expanded to the user's home directory.
   * Relative paths are resolved against home as well, matching the default.
   */
  path?: string;
  /** Override the signing-key path (defaults to `~/.idel/keys/...`). */
  keyPath?: string;
}

function resolveLogPath(input?: string): string {
  const home = homedir();
  if (!input) return join(home, DEFAULT_REL_PATH);
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (isAbsolute(input)) return input;
  return join(home, input);
}

/**
 * Build the `actor` for a record. OpenLogs v2 requires an actor; we use the
 * record's `user`, namespaced so it reads as an identity (`user:alice`) rather
 * than a bare string. The same actor must be declared trusted to verify trust.
 */
function actorOf(record: OpenLogRecord): string {
  const user = record.user?.trim() || "local-user";
  return user.includes(":") ? user : `user:${user}`;
}

/**
 * Convert the record's ISO timestamp into a TPS time string (no location — a
 * local CLI has no meaningful coordinate, and TPS time-only strings are valid).
 * Falls back to "now" only if the timestamp is unparseable.
 */
function tpsOf(record: OpenLogRecord): string {
  const d = new Date(record.timestamp);
  const when = Number.isNaN(d.getTime()) ? new Date() : d;
  return TPS.fromDate(when, "greg");
}

/**
 * Bridge an {@link OpenLogRecord} into the SDK's structurally-typed envelope
 * `data` slot. The SDK types `data` as an open `Record<string, unknown>`; our
 * record is a closed interface of JSON-safe scalars, so it satisfies that shape
 * but TypeScript can't prove the structural relation across the package
 * boundary. This single localized cast documents the invariant — "a redacted
 * audit record is valid envelope data" — instead of scattering `as unknown as`
 * at call sites.
 */
function toEnvelopeData(record: OpenLogRecord): Record<string, unknown> {
  return record as unknown as Record<string, unknown>;
}

/**
 * Inverse of {@link toEnvelopeData}: unwrap envelope `data` back to an
 * {@link OpenLogRecord}. Defensive — returns null for anything that isn't a
 * record-shaped object (a malformed or non-audit payload), so a single bad line
 * never produces a half-typed record downstream.
 */
function fromEnvelopeData(data: unknown): OpenLogRecord | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  // A real audit record always has these required string fields; use them as a
  // cheap shape gate before trusting the cast.
  if (typeof d["command"] !== "string" || typeof d["result"] !== "string") {
    return null;
  }
  return d as unknown as OpenLogRecord;
}

export class OpenLogWriter {
  /** Absolute, fully-resolved path to the JSONL log file. */
  readonly path: string;

  private readonly keyPath?: string;

  /** Guards directory creation so we only `mkdir` once per writer instance. */
  private dirEnsured = false;

  /** Cached signing key (loaded once, lazily, on first append). */
  private keypair?: OpenLogKeypair;

  /**
   * Hash of the last record in the chain, so a new append links to it. `null`
   * means "start of chain". `undefined` means "not yet determined" — on first
   * append we read the tail of an existing log to continue its chain rather
   * than forking a new one.
   */
  private prevHash: string | null | undefined = undefined;

  /** Serializes appends inside this process; the lock file handles other processes. */
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenLogWriterOptions = {}) {
    this.path = resolveLogPath(options.path);
    this.keyPath = options.keyPath;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.dirEnsured = true;
  }

  private async ensureKeypair(): Promise<OpenLogKeypair> {
    if (!this.keypair) {
      this.keypair = await loadOrCreateKeypair(this.keyPath);
    }
    return this.keypair;
  }

  /**
   * Determine the hash to chain a new record onto. On first call we read the
   * existing log's last *signed* record so appends continue the same chain
   * across process restarts; a missing/empty log — or one that predates signing
   * (plain-JSONL records with no `hash`) — starts a fresh chain (`null`).
   *
   * Guarding on a real string `hash` matters: an older log written by the
   * pre-signing writer has no `hash`, and passing `undefined` to the SDK throws
   * ("prev_hash must be a string or null"). We coalesce to `null` so signing
   * cleanly begins a new chain on top of legacy records rather than failing.
   */
  private async resolvePrevHash(): Promise<string | null> {
    if (this.prevHash !== undefined) return this.prevHash;
    const records = await this.readSigned(Number.MAX_SAFE_INTEGER);
    let head: string | null = null;
    for (const rec of records) {
      if (typeof rec.hash === "string" && rec.hash.length > 0) head = rec.hash;
    }
    this.prevHash = head;
    return this.prevHash;
  }

  /**
   * Redact `record`, wrap it in a signed, hash-chained v2 record, and append
   * the signed record as a single JSON line. Append-only.
   *
   * A policy block is a normal audit event — pass a record with
   * `result: "blocked_before_execution"` and it is signed and appended like any
   * other. Blocks are evidence, not errors.
   */
  async append(record: OpenLogRecord): Promise<void> {
    const queued = this.appendQueue.then(() => this.appendLocked(record));
    this.appendQueue = queued.catch(() => undefined);
    return queued;
  }

  private async appendLocked(record: OpenLogRecord): Promise<void> {
    await this.ensureDir();
    await this.withAppendLock(async () => {
      // Another process may have appended while we waited; reread the tail.
      this.prevHash = undefined;
      const keypair = await this.ensureKeypair();
      const prevHash = await this.resolvePrevHash();

      // Redact BEFORE the data enters the signed (immutable) payload.
      const safe = redact(record);

      const unsigned = createV2Record(
        {
          actor: actorOf(safe),
          tps: tpsOf(safe),
          event: safe.command,
          data: toEnvelopeData(safe),
        },
        prevHash,
      );
      const signed = await signV2Record(unsigned, {
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
        kid: keypair.kid,
      });

      await appendFile(this.path, JSON.stringify(signed) + "\n", "utf8");
      // Advance the chain head so the next append links to this record.
      this.prevHash = signed.hash;
    });
  }

  private async withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const deadline = Date.now() + 10_000;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private trustedKeyFor(keypair: OpenLogKeypair): OpenLogsTrustedKey {
    return {
      kid: keypair.kid,
      publicKeyHex: keypair.publicKeyHex,
      actorPrefixes: ["user:"],
      description: "Local IDEL OpenLogs signing key",
    };
  }

  /**
   * Read the last `limit` *signed* records (default 50), in chronological
   * order. Malformed/unparseable lines are skipped. Missing file → empty.
   */
  async readSigned(
    limit: number = DEFAULT_READ_LIMIT,
  ): Promise<OpenLogsV2Record[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const records: OpenLogsV2Record[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Skip malformed lines (e.g. an interrupted trailing write).
        continue;
      }
      // Only accept well-formed signed v2 records. Legacy plain-JSONL records
      // (written before signing existed) lack `entry`/`hash` and are ignored
      // here so they don't corrupt chaining or verification.
      const rec = parsed as Partial<OpenLogsV2Record>;
      if (rec && typeof rec === "object" && rec.entry && typeof rec.hash === "string") {
        records.push(rec as OpenLogsV2Record);
      }
    }

    if (limit <= 0) return [];
    return records.length > limit
      ? records.slice(records.length - limit)
      : records;
  }

  /**
   * Return the last `limit` audit records as plain {@link OpenLogRecord}s,
   * unwrapped from their signed envelopes — the shape callers (list.logs /
   * show.logs) expect. Records whose payload isn't a recognizable audit record
   * are skipped.
   */
  async read(limit: number = DEFAULT_READ_LIMIT): Promise<OpenLogRecord[]> {
    const signed = await this.readSigned(limit);
    const out: OpenLogRecord[] = [];
    for (const rec of signed) {
      const data = rec.entry?.data;
      const record = fromEnvelopeData(data);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * Verify the integrity and signatures of the whole on-disk chain. Returns the
   * SDK's structured {@link VerifyResult}: `integrity` proves no link was broken
   * or reordered, `signatures` proves each record was signed, and `trust` proves
   * each signature chains to the local pinned key and user actor namespace.
   */
  async verify(): Promise<VerifyResult> {
    const signed = await this.readSigned(Number.MAX_SAFE_INTEGER);
    const keypair = await this.ensureKeypair();
    return verifyV2Chain(signed, {
      requireSignature: true,
      requireKid: true,
      requireTrustedKey: true,
      requireActorBinding: true,
      trustedKeys: [this.trustedKeyFor(keypair)],
    });
  }
}
