/**
 * OpenLogWriter — the append-only, signed, hash-chained audit trail (spec §23).
 *
 * Each command becomes an **OpenLogs v2 record**: the redacted audit data is
 * wrapped in a TPS-stamped entry, SHA-256-linked to the previous record, and
 * Ed25519-signed with the machine's OpenLogs key. The file is JSONL, one signed
 * record per line. An independently loaded public trust configuration and a
 * durable local checkpoint bind the expected kid, record count, and chain
 * head, allowing verification to reject corruption and local rollback.
 *
 * This replaces the earlier plain-JSONL writer. The public API (`append`,
 * `read`, `path`) is unchanged so the runtime and CLI are unaffected; what
 * changed is that records are now locally verifiable, not merely append-only.
 * This remains explicitly local-development assurance: there is no external
 * head anchor, HSM, transparency log, or protection from a principal that can
 * replace every local evidence file together.
 *
 * Redaction runs *before* the entry is built and signed, so secrets never enter
 * the signed payload. Because the payload is immutable once signed, getting the
 * redaction order right matters more here than it did for plain JSONL.
 */

import {
  mkdir,
  readFile,
  open,
  unlink,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { homedir, hostname } from "node:os";
import { randomBytes } from "node:crypto";

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
const DEFAULT_TRUST_REL_PATH = ".idel/keys/openlogs.trust.json";

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
  /**
   * Verifier trust roots supplied independently of the signing private key.
   * When present, these are authoritative and `trustPath` is not read or
   * created. Supplying a key here does not imply external anchoring.
   */
  trustedKeys?: readonly OpenLogsTrustedKey[];
  /**
   * Public verifier trust configuration. Defaults beside the local signing
   * key, but is a separate file that never contains private key material.
   */
  trustPath?: string;
  /**
   * Permit first-use creation of a self-pinned public trust file for local
   * development. Disable this in deployments that require pre-provisioned
   * verifier trust. Defaults to true for CLI compatibility.
   */
  allowLocalDevelopmentTrustBootstrap?: boolean;
  /** Durable rollback checkpoint. Defaults to `${path}.continuity.json`. */
  continuityPath?: string;
  /**
   * Explicitly adopt an already populated, valid local-development chain when
   * no continuity checkpoint exists. Disabled by default because automatic
   * adoption would make deletion/reset indistinguishable from migration.
   */
  allowUnanchoredLegacyAdoption?: boolean;
  /** Internal/test tuning for cross-process lock acquisition. */
  lockWaitMs?: number;
  /** Internal/test tuning for reclaiming locks whose owner process is gone. */
  lockStaleMs?: number;
}

export interface OpenLogContinuityState {
  version: 1;
  assurance: "local-development-not-externally-anchored";
  expectedKid: string;
  expectedPublicKeyHex: string;
  recordCount: number;
  chainHead: string;
}

export interface OpenLogContinuityCheck {
  ok: boolean;
  established: boolean;
  expectedRecords?: number;
  expectedHead?: string;
  error?: string;
}

export interface OpenLogVerifyResult extends VerifyResult {
  continuity: OpenLogContinuityCheck;
  assurance: {
    signing: "local-development";
    externalAnchoring: false;
    trustSource: "explicit-verifier-configuration" | "local-development-trust-file";
  };
}

interface StoredTrustConfiguration {
  version: 1;
  assurance: "local-development-self-pinned-not-externally-anchored";
  trustedKeys: OpenLogsTrustedKey[];
}

interface ParsedLog {
  records: OpenLogsV2Record[];
  error?: string;
  index?: number;
}

function resolveLogPath(input?: string): string {
  const home = homedir();
  if (!input) return join(home, DEFAULT_REL_PATH);
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (isAbsolute(input)) return input;
  return join(home, input);
}

function resolveHomePath(input: string): string {
  const home = homedir();
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

/** Keep the SDK event identifier semantic while retaining the exact command in data. */
function eventOf(record: OpenLogRecord): string {
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i.test(record.command)
    ? record.command
    : record.source === "native"
      ? "native.command"
      : "idel.command";
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
  private readonly trustPath: string;
  private readonly continuityPath: string;
  private readonly configuredTrustedKeys?: readonly OpenLogsTrustedKey[];
  private readonly allowLocalDevelopmentTrustBootstrap: boolean;
  private readonly allowUnanchoredLegacyAdoption: boolean;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;

  /** Guards directory creation so we only `mkdir` once per writer instance. */
  private dirEnsured = false;

  /** Serializes appends inside this process; the lock file handles other processes. */
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenLogWriterOptions = {}) {
    this.path = resolveLogPath(options.path);
    this.keyPath = options.keyPath;
    this.trustPath = options.trustPath
      ? resolveHomePath(options.trustPath)
      : options.keyPath
        ? `${resolveHomePath(options.keyPath)}.trust.json`
        : join(homedir(), DEFAULT_TRUST_REL_PATH);
    this.continuityPath = options.continuityPath
      ? resolveHomePath(options.continuityPath)
      : `${this.path}.continuity.json`;
    this.configuredTrustedKeys = options.trustedKeys
      ? options.trustedKeys.map((key) => ({ ...key }))
      : undefined;
    this.allowLocalDevelopmentTrustBootstrap =
      options.allowLocalDevelopmentTrustBootstrap ?? true;
    this.allowUnanchoredLegacyAdoption =
      options.allowUnanchoredLegacyAdoption ?? false;
    this.lockWaitMs = options.lockWaitMs ?? 10_000;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.dirEnsured = true;
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
      const parsed = await this.readStrict();
      if (parsed.error) {
        throw new Error(`OpenLogs log is malformed at line ${parsed.index}: ${parsed.error}`);
      }
      const keypair = await loadOrCreateKeypair(this.keyPath);
      const continuity = await this.readContinuity();
      const localTrustExisted =
        !this.configuredTrustedKeys && (await pathExists(this.trustPath));
      if (
        localTrustExisted &&
        !continuity &&
        parsed.records.length === 0 &&
        !this.allowUnanchoredLegacyAdoption
      ) {
        throw new Error(
          "OpenLogs log and continuity evidence disappeared while verifier trust remained; refusing automatic reset",
        );
      }
      const trustedKeys = await this.loadTrustForAppend(
        keypair,
        parsed.records.length,
        continuity !== undefined,
      );
      this.assertContinuity(parsed.records, continuity, keypair, trustedKeys);

      const existingVerification = await this.verifyRecords(parsed.records, trustedKeys);
      if (!cryptographicChecksOk(existingVerification) && parsed.records.length > 0) {
        throw new Error(
          `OpenLogs existing chain failed verification: ${existingVerification.error ?? "unknown verification failure"}`,
        );
      }
      const prevHash = parsed.records.at(-1)?.hash ?? null;

      // Redact BEFORE the data enters the signed (immutable) payload.
      const safe = redact(record);

      const unsigned = createV2Record(
        {
          actor: actorOf(safe),
          tps: tpsOf(safe),
          event: eventOf(safe),
          data: toEnvelopeData(safe),
        },
        prevHash,
      );
      const signed = await signV2Record(unsigned, {
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
        kid: keypair.kid,
      });
      const candidate = [...parsed.records, signed];
      const candidateVerification = await this.verifyRecords(candidate, trustedKeys);
      if (!cryptographicChecksOk(candidateVerification)) {
        throw new Error(
          `OpenLogs refused an unverifiable append: ${candidateVerification.error ?? "unknown verification failure"}`,
        );
      }

      const log = await open(this.path, "a", 0o600);
      try {
        await log.writeFile(JSON.stringify(signed) + "\n", "utf8");
        await log.sync();
      } finally {
        await log.close();
      }
      await this.writeContinuity({
        version: 1,
        assurance: "local-development-not-externally-anchored",
        expectedKid: keypair.kid,
        expectedPublicKeyHex: keypair.publicKeyHex,
        recordCount: candidate.length,
        chainHead: signed.hash,
      });
    });
  }

  private async withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const token = randomBytes(16).toString("hex");
    const deadline = Date.now() + this.lockWaitMs;
    while (!handle) {
      try {
        const acquired = await open(lockPath, "wx", 0o600);
        try {
          await acquired.writeFile(
            JSON.stringify({
              version: 1,
              token,
              pid: process.pid,
              hostname: hostname(),
              createdAtMs: Date.now(),
            }) + "\n",
            "utf8",
          );
          await acquired.sync();
          handle = acquired;
        } catch (err) {
          await acquired.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw err;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        if (await this.reclaimStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`OpenLogs append lock timed out: ${lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
        if (current.token === token) {
          await unlink(lockPath);
          await this.syncDirectory(dirname(lockPath));
        }
      } catch {
        // A missing/replaced lock is not ours to remove.
      }
    }
  }

  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    let ageMs = 0;
    let ownerPid: number | undefined;
    let ownerHost: string | undefined;
    try {
      const [raw, metadata] = await Promise.all([
        readFile(lockPath, "utf8"),
        stat(lockPath),
      ]);
      ageMs = Date.now() - metadata.mtimeMs;
      try {
        const lock = JSON.parse(raw) as {
          pid?: unknown;
          hostname?: unknown;
          createdAtMs?: unknown;
        };
        if (typeof lock.createdAtMs === "number" && Number.isFinite(lock.createdAtMs)) {
          ageMs = Date.now() - lock.createdAtMs;
        }
        if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid)) {
          ownerPid = lock.pid;
        }
        if (typeof lock.hostname === "string") ownerHost = lock.hostname;
      } catch {
        // A crashed owner may have left an incomplete lock. Its mtime is the lease.
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    if (ageMs < this.lockStaleMs) return false;
    if (ownerHost === hostname() && ownerPid !== undefined && processIsAlive(ownerPid)) {
      return false;
    }

    const tombstone = `${lockPath}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
    try {
      await rename(lockPath, tombstone);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    await unlink(tombstone).catch(() => undefined);
    await this.syncDirectory(dirname(lockPath));
    return true;
  }

  private async readStrict(): Promise<ParsedLog> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
      throw err;
    }

    const records: OpenLogsV2Record[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { records, error: "invalid JSON", index: i + 1 };
      }
      if (!isSignedRecordShape(parsed)) {
        return { records, error: "not a signed OpenLogs v2 record", index: i + 1 };
      }
      records.push(parsed);
    }
    return { records };
  }

  private async readContinuity(): Promise<OpenLogContinuityState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.continuityPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`OpenLogs continuity state is corrupt: ${this.continuityPath}`);
    }
    if (!isContinuityState(parsed)) {
      throw new Error(`OpenLogs continuity state has an invalid shape: ${this.continuityPath}`);
    }
    return parsed;
  }

  private async writeContinuity(state: OpenLogContinuityState): Promise<void> {
    await this.writeJsonAtomic(this.continuityPath, state);
  }

  private async readTrustFile(): Promise<OpenLogsTrustedKey[] | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.trustPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`OpenLogs verifier trust configuration is corrupt: ${this.trustPath}`);
    }
    if (!isTrustConfiguration(parsed)) {
      throw new Error(
        `OpenLogs verifier trust configuration has an invalid shape: ${this.trustPath}`,
      );
    }
    return parsed.trustedKeys;
  }

  private async loadTrustForAppend(
    keypair: OpenLogKeypair,
    recordCount: number,
    continuityEstablished: boolean,
  ): Promise<OpenLogsTrustedKey[]> {
    if (this.configuredTrustedKeys) {
      const keys = validateTrustedKeys(this.configuredTrustedKeys);
      this.assertSignerTrusted(keypair, keys);
      return keys;
    }
    const stored = await this.readTrustFile();
    if (stored) {
      const keys = validateTrustedKeys(stored);
      this.assertSignerTrusted(keypair, keys);
      return keys;
    }
    if (continuityEstablished) {
      throw new Error(
        "OpenLogs verifier trust configuration disappeared after continuity was established; refusing automatic re-pin",
      );
    }
    if (!this.allowLocalDevelopmentTrustBootstrap) {
      throw new Error(
        "OpenLogs verifier trust configuration is missing and local-development self-pinning is disabled",
      );
    }
    if (recordCount > 0 && !this.allowUnanchoredLegacyAdoption) {
      throw new Error(
        "OpenLogs verifier trust configuration disappeared for an existing chain; refusing automatic re-pin",
      );
    }

    const key: OpenLogsTrustedKey = {
      kid: keypair.kid,
      publicKeyHex: keypair.publicKeyHex,
      actorPrefixes: ["user:"],
      description: "Local-development IDEL OpenLogs key (not externally anchored)",
    };
    const configuration: StoredTrustConfiguration = {
      version: 1,
      assurance: "local-development-self-pinned-not-externally-anchored",
      trustedKeys: [key],
    };
    await this.writeJsonAtomic(this.trustPath, configuration);
    return [key];
  }

  private async loadTrustForVerify(): Promise<{
    keys: OpenLogsTrustedKey[];
    source: OpenLogVerifyResult["assurance"]["trustSource"];
  }> {
    if (this.configuredTrustedKeys) {
      return {
        keys: validateTrustedKeys(this.configuredTrustedKeys),
        source: "explicit-verifier-configuration",
      };
    }
    const stored = await this.readTrustFile();
    if (!stored) {
      throw new Error(
        "OpenLogs verifier trust configuration is missing; verification will not trust the signing private key",
      );
    }
    return {
      keys: validateTrustedKeys(stored),
      source: "local-development-trust-file",
    };
  }

  private assertSignerTrusted(
    keypair: OpenLogKeypair,
    trustedKeys: readonly OpenLogsTrustedKey[],
  ): void {
    if (
      !trustedKeys.some(
        (key) =>
          key.kid === keypair.kid &&
          key.publicKeyHex.toLowerCase() === keypair.publicKeyHex.toLowerCase(),
      )
    ) {
      throw new Error(
        `OpenLogs signing key ${keypair.kid} is not present in the independent verifier trust configuration`,
      );
    }
  }

  private assertContinuity(
    records: readonly OpenLogsV2Record[],
    state: OpenLogContinuityState | undefined,
    keypair: OpenLogKeypair,
    trustedKeys: readonly OpenLogsTrustedKey[],
  ): void {
    if (!state) {
      if (records.length > 0 && !this.allowUnanchoredLegacyAdoption) {
        throw new Error(
          "OpenLogs continuity checkpoint disappeared for an existing chain; refusing automatic reset",
        );
      }
      return;
    }
    const check = checkContinuity(records, state, trustedKeys);
    if (!check.ok) throw new Error(check.error ?? "OpenLogs continuity check failed");
    if (
      state.expectedKid !== keypair.kid ||
      state.expectedPublicKeyHex.toLowerCase() !== keypair.publicKeyHex.toLowerCase()
    ) {
      throw new Error(
        `OpenLogs signing key replacement detected: expected ${state.expectedKid}, found ${keypair.kid}`,
      );
    }
  }

  private verifyRecords(
    records: OpenLogsV2Record[],
    trustedKeys: readonly OpenLogsTrustedKey[],
  ): Promise<VerifyResult> {
    return verifyV2Chain(records, {
      requireSignature: true,
      requireKid: true,
      requireTrustedKey: true,
      requireActorBinding: true,
      trustedKeys: [...trustedKeys],
    });
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
      await this.syncDirectory(dirname(path));
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw err;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    let directory: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directory = await open(path, "r");
      await directory.sync();
    } catch (err) {
      // Windows does not support opening/fsyncing directories. POSIX does, and
      // there durability failures must be observable rather than downgraded.
      if (process.platform !== "win32") throw err;
    } finally {
      await directory?.close().catch(() => undefined);
    }
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
   * SDK checks plus the durable local continuity checkpoint. Verifier trust is
   * loaded independently from the signing private key. The result labels this
   * as local-development assurance and never claims external anchoring.
   */
  async verify(): Promise<OpenLogVerifyResult> {
    await this.ensureDir();
    return this.withAppendLock(async () => {
      let parsed: ParsedLog;
      let trust: Awaited<ReturnType<OpenLogWriter["loadTrustForVerify"]>>;
      let continuity: OpenLogContinuityState | undefined;
      let observedRecords = 0;
      try {
        parsed = await this.readStrict();
        observedRecords = parsed.records.length;
        if (parsed.error) {
          return verificationFailure(
            parsed.records.length,
            `Malformed OpenLogs line ${parsed.index}: ${parsed.error}`,
            parsed.index,
            this.configuredTrustedKeys
              ? "explicit-verifier-configuration"
              : "local-development-trust-file",
          );
        }
        trust = await this.loadTrustForVerify();
        continuity = await this.readContinuity();
      } catch (err) {
        return verificationFailure(
          observedRecords,
          (err as Error).message,
          undefined,
          this.configuredTrustedKeys
            ? "explicit-verifier-configuration"
            : "local-development-trust-file",
        );
      }

      const sdk = await this.verifyRecords(parsed.records, trust.keys);
      const continuityCheck = continuity
        ? checkContinuity(parsed.records, continuity, trust.keys)
        : {
            ok: false,
            established: false,
            error:
              parsed.records.length > 0
                ? "OpenLogs continuity checkpoint is missing for an existing chain"
                : "OpenLogs has no established continuity evidence",
          };
      const ok = sdk.ok && continuityCheck.ok;
      return {
        ...sdk,
        ok,
        ...(!ok
          ? {
              error: sdk.ok
                ? continuityCheck.error
                : sdk.error ?? "OpenLogs cryptographic verification failed",
            }
          : {}),
        continuity: continuityCheck,
        assurance: {
          signing: "local-development",
          externalAnchoring: false,
          trustSource: trust.source,
        },
      };
    });
  }
}

function isSignedRecordShape(value: unknown): value is OpenLogsV2Record {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OpenLogsV2Record>;
  return (
    !!record.entry &&
    typeof record.entry === "object" &&
    record.entry.spec === "openlogs.v2" &&
    typeof record.hash === "string" &&
    record.hash.length > 0 &&
    (record.prev_hash === null || typeof record.prev_hash === "string") &&
    !!record.sig &&
    typeof record.sig === "object"
  );
}

function isContinuityState(value: unknown): value is OpenLogContinuityState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OpenLogContinuityState>;
  return (
    state.version === 1 &&
    state.assurance === "local-development-not-externally-anchored" &&
    typeof state.expectedKid === "string" &&
    state.expectedKid.length > 0 &&
    typeof state.expectedPublicKeyHex === "string" &&
    /^[0-9a-f]{64}$/i.test(state.expectedPublicKeyHex) &&
    Number.isSafeInteger(state.recordCount) &&
    (state.recordCount ?? 0) > 0 &&
    typeof state.chainHead === "string" &&
    /^[0-9a-f]{64}$/i.test(state.chainHead)
  );
}

function isTrustConfiguration(value: unknown): value is StoredTrustConfiguration {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<StoredTrustConfiguration>;
  return (
    config.version === 1 &&
    config.assurance ===
      "local-development-self-pinned-not-externally-anchored" &&
    Array.isArray(config.trustedKeys) &&
    config.trustedKeys.length > 0 &&
    config.trustedKeys.every(isTrustedKeyShape)
  );
}

function isTrustedKeyShape(value: unknown): value is OpenLogsTrustedKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<OpenLogsTrustedKey>;
  return (
    typeof key.kid === "string" &&
    key.kid.length > 0 &&
    typeof key.publicKeyHex === "string" &&
    /^[0-9a-f]+$/i.test(key.publicKeyHex) &&
    key.publicKeyHex.length === 64
  );
}

function validateTrustedKeys(
  values: readonly OpenLogsTrustedKey[],
): OpenLogsTrustedKey[] {
  if (values.length === 0 || !values.every(isTrustedKeyShape)) {
    throw new Error("OpenLogs verifier trust configuration contains no valid keys");
  }
  const kids = new Set<string>();
  for (const key of values) {
    if (kids.has(key.kid!)) {
      throw new Error(`OpenLogs verifier trust configuration duplicates key ${key.kid}`);
    }
    kids.add(key.kid!);
  }
  return values.map((key) => ({ ...key }));
}

function checkContinuity(
  records: readonly OpenLogsV2Record[],
  state: OpenLogContinuityState,
  trustedKeys: readonly OpenLogsTrustedKey[],
): OpenLogContinuityCheck {
  const base = {
    established: true,
    expectedRecords: state.recordCount,
    expectedHead: state.chainHead,
  };
  const trusted = trustedKeys.some(
    (key) =>
      key.kid === state.expectedKid &&
      key.publicKeyHex.toLowerCase() === state.expectedPublicKeyHex.toLowerCase(),
  );
  if (!trusted) {
    return {
      ...base,
      ok: false,
      error: `OpenLogs verifier trust replacement detected for ${state.expectedKid}`,
    };
  }
  if (records.length < state.recordCount) {
    return {
      ...base,
      ok: false,
      error: `OpenLogs rollback/truncation detected: expected at least ${state.recordCount} records, found ${records.length}`,
    };
  }
  const checkpointRecord = records[state.recordCount - 1];
  if (!checkpointRecord || checkpointRecord.hash !== state.chainHead) {
    return {
      ...base,
      ok: false,
      error: "OpenLogs reset/rewrite detected: checkpoint chain head is absent",
    };
  }
  const swapped = records.findIndex(
    (record) => record.sig?.kid !== state.expectedKid,
  );
  if (swapped >= 0) {
    return {
      ...base,
      ok: false,
      error: `OpenLogs unexpected signing key at record ${swapped + 1}`,
    };
  }
  return { ...base, ok: true };
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function cryptographicChecksOk(result: VerifyResult): boolean {
  return result.integrity.ok && result.signatures.ok && result.trust.ok;
}

function verificationFailure(
  records: number,
  error: string,
  index?: number,
  trustSource: OpenLogVerifyResult["assurance"]["trustSource"] =
    "local-development-trust-file",
): OpenLogVerifyResult {
  const failed = { ok: false, error, ...(index !== undefined ? { index } : {}) };
  return {
    ok: false,
    records,
    error,
    ...(index !== undefined ? { index } : {}),
    integrity: failed,
    signatures: { ...failed, present: 0, total: records },
    trust: {
      ...failed,
      trusted: 0,
      unresolved: records,
      revoked: 0,
      unsigned: 0,
      actorBound: 0,
      validAtEventTime: 0,
      total: records,
    },
    semantics: {
      ...failed,
      validTps: 0,
      validEvents: 0,
      validIndexes: 0,
      validPolicies: 0,
      total: records,
    },
    policy: { ...failed, mode: "strict-local-continuity" },
    continuity: { ok: false, established: false, error },
    assurance: {
      signing: "local-development",
      externalAnchoring: false,
      trustSource,
    },
  };
}
