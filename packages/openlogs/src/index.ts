/**
 * @openexecution/openlogs — the OpenLogs accountability layer (spec §23, §28).
 *
 * Writes one **signed, hash-chained** record per command to an append-only log,
 * via `@nextera.one/openlogs-sdk` (OpenLogs v2). Each record is TPS-stamped,
 * SHA-256-linked to its predecessor, and Ed25519-signed with a machine-local
 * key, so the log is tamper-*evident*, not merely append-only — `verify()`
 * pinpoints any broken link or forged signature.
 *
 * The redaction layer ({@link redact}) scrubs secrets both by parameter-name
 * and by value-shape *before* the data enters the signed (immutable) payload,
 * so credentials never reach disk and never end up inside a signature.
 *
 * A policy block is recorded as an ordinary audit event with
 * `result: "blocked_before_execution"` — it is signed evidence, not an error.
 */

export { OpenLogWriter } from "./writer.js";
export type { OpenLogWriterOptions } from "./writer.js";
export { loadOrCreateKeypair } from "./keys.js";
export type { OpenLogKeypair, StoredKeypair } from "./keys.js";
export {
  redact,
  redactString,
  isSensitiveKey,
  looksLikeSecretValue,
  REDACTED,
} from "./redact.js";
