/**
 * @openexecution/openlogs — the OpenLogs accountability layer (spec §23, §28).
 *
 * Writes one **signed, hash-chained** record per command to an append-only log,
 * via `@nextera.one/openlogs-sdk` (OpenLogs v2). Each record is TPS-stamped,
 * SHA-256-linked to its predecessor, and Ed25519-signed with a machine-local
 * key. Verification uses a separate public trust configuration and a durable
 * local continuity checkpoint, so ordinary corruption, truncation, reset, and
 * key replacement fail closed.
 *
 * This package deliberately labels that assurance as local-development and
 * not externally anchored. A principal able to replace the log, trust file,
 * and continuity state together can still rewrite history; production-grade
 * evidence requires an independently administered trust root and remote head
 * anchoring.
 *
 * The redaction layer ({@link redact}) scrubs secrets both by parameter-name
 * and by value-shape *before* the data enters the signed (immutable) payload,
 * so credentials never reach disk and never end up inside a signature.
 *
 * A policy block is recorded as an ordinary audit event with
 * `result: "blocked_before_execution"` — it is signed evidence, not an error.
 */

export { OpenLogWriter } from "./writer.js";
export type {
  OpenLogContinuityCheck,
  OpenLogContinuityState,
  OpenLogVerifyResult,
  OpenLogWriterOptions,
} from "./writer.js";
export { loadOrCreateKeypair } from "./keys.js";
export type { OpenLogKeypair, StoredKeypair } from "./keys.js";
export {
  redact,
  redactString,
  isSensitiveKey,
  looksLikeSecretValue,
  REDACTED,
} from "./redact.js";
