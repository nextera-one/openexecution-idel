/**
 * @openexecution/openlogs — the OpenLogs audit trail (spec §23, §28).
 *
 * Writes one redacted JSONL record per command to an append-only log. The
 * redaction layer ({@link redact}) scrubs secrets both by parameter-name and by
 * value-shape so credentials never reach disk.
 *
 * A policy block is recorded here as an ordinary audit event with
 * `result: "blocked_before_execution"` — it is data, not an error. OpenLogs does
 * not decide outcomes; it faithfully records whatever the runtime hands it.
 */

export { OpenLogWriter } from "./writer.js";
export type { OpenLogWriterOptions } from "./writer.js";
export {
  redact,
  redactString,
  isSensitiveKey,
  looksLikeSecretValue,
  REDACTED,
} from "./redact.js";
