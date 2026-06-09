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

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

import {
  createV2Record,
  signV2Record,
  verifyV2Chain,
  type OpenLogsV2Record,
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
    await this.ensureDir();
    const keypair = await this.ensureKeypair();
    const prevHash = await this.resolvePrevHash();

    // Redact BEFORE the data enters the signed (immutable) payload.
    const safe = redact(record);

    const unsigned = createV2Record(
      {
        actor: actorOf(safe),
        tps: tpsOf(safe),
        event: safe.command,
        data: safe as unknown as Record<string, unknown>,
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
   * unwrapped from their signed envelopes — the shape callers (logs.list /
   * logs.show) expect. Records whose payload isn't a recognizable audit record
   * are skipped.
   */
  async read(limit: number = DEFAULT_READ_LIMIT): Promise<OpenLogRecord[]> {
    const signed = await this.readSigned(limit);
    const out: OpenLogRecord[] = [];
    for (const rec of signed) {
      const data = rec.entry?.data;
      if (data && typeof data === "object") {
        out.push(data as unknown as OpenLogRecord);
      }
    }
    return out;
  }

  /**
   * Verify the integrity and signatures of the whole on-disk chain. Returns the
   * SDK's structured {@link VerifyResult}: `integrity` proves no link was broken
   * or reordered, `signatures` proves each record was signed by the held key.
   * Trust (actor-binding to a known key) is reported but not required here —
   * the writer signs with its own key, which a caller can pin if they want full
   * trust verification.
   */
  async verify(): Promise<VerifyResult> {
    const signed = await this.readSigned(Number.MAX_SAFE_INTEGER);
    return verifyV2Chain(signed, { requireSignature: true });
  }
}
