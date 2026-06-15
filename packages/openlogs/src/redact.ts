/**
 * Secret redaction for OpenLogs (spec §28 — "Scrub secrets from logs").
 *
 * Two complementary strategies:
 *
 *  1. KEY-BASED: if a parameter *name* looks sensitive (password, token,
 *     api_key, …) we redact its value regardless of what the value looks like.
 *     This catches short or structured secrets that would otherwise slip past
 *     value heuristics (e.g. `password=hunter2`).
 *
 *  2. VALUE-BASED: if a *value* itself looks like a secret (long base64/hex
 *     blob, JWT, AWS access key, GitHub PAT, OpenAI key) we redact it no matter
 *     what key it sits under — secrets leak into innocent-looking fields all
 *     the time (e.g. `url=https://x?sig=<jwt>`).
 *
 * The bar is deliberately conservative: we accept the occasional un-redacted
 * exotic secret in exchange for never mangling ordinary, non-secret data. We
 * never throw, and we never mutate the caller's record in place.
 */

import type { OpenLogRecord, ParamValue } from "@openexecution/types";

/** The token written in place of any redacted secret. */
export const REDACTED = "***REDACTED***";

/**
 * Parameter *names* that mark their value as sensitive. Matched case-insensitively
 * against the whole key (substring match — `db_password`, `X-Api-Key`, … all hit).
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word)?/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /auth/i,
  /credential/i,
  /private[-_]?key/i,
  /passphrase/i,
];

/**
 * Value *shapes* that are secrets on their own, independent of their key.
 * Order does not matter — any match triggers full-value redaction.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // JWT: three base64url segments separated by dots (header.payload.signature).
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
  // AWS access key id: AKIA/ASIA + 16 alphanumeric chars (case-insensitive so a
  // lowercased transcription still redacts).
  /^(?:AKIA|ASIA)[A-Z0-9]{16}$/i,
  // GitHub classic PAT and fine-grained PAT.
  /^ghp_[A-Za-z0-9]{20,}$/,
  /^gh[osru]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  // OpenAI/Anthropic-style keys.
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^sk-ant-[A-Za-z0-9_-]{16,}$/,
  // Stripe live/test keys and npm automation tokens.
  /^sk_(?:live|test)_[A-Za-z0-9]{16,}$/,
  /^npm_[A-Za-z0-9_-]{20,}$/,
  // Slack tokens.
  /^xox[baprs]-[A-Za-z0-9-]{20,}$/,
  // Generic long hex/base64-ish blob — kept LAST so the more specific
  // patterns above win first. ≥24 chars of [A-Za-z0-9+/=_-].
  /^[A-Za-z0-9+/=_-]{24,}$/,
];

/** True if a parameter key marks its value as sensitive by name. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

/** True if a string value, on its own, looks like a secret. */
export function looksLikeSecretValue(value: string): boolean {
  if (isLikelyNonSecretPath(value)) return false;
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

function isLikelyNonSecretPath(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")) {
    return true;
  }
  if ((value.includes("/") || value.includes("\\")) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return true;
  }
  return false;
}

/**
 * Redact a single param value given its key. Numbers and booleans are never
 * secrets-by-shape, but a sensitive *key* still forces redaction so we don't
 * leak e.g. a numeric PIN under `secret`.
 */
function redactParamValue(key: string, value: ParamValue): ParamValue {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string" && looksLikeSecretValue(value)) return REDACTED;
  return value;
}

/**
 * Scrub a free-form command string. Handles three forms:
 *   - `key=value`         (e.g. `--api-key=abc…`, `TOKEN=abc…`)
 *   - `--flag value`      (e.g. `--token abc…`, `-p secret`)
 *   - bare secret-looking tokens anywhere in the line
 *
 * Operates token-by-token on whitespace so we never have to reconstruct exact
 * original spacing-sensitive shells; redaction is about not leaking, not about
 * round-tripping the command verbatim.
 */
/** Query-string parameter names whose value is a secret (within a URL). */
const SENSITIVE_QUERY_KEYS =
  /\b(token|access_token|api[-_]?key|apikey|key|secret|sig|signature|password|passwd|pwd|auth|sas|code|session)\b/i;

export function redactString(s: string): string {
  if (!s) return s;

  // Pass 0: private-key PEM blocks can span many lines; remove the entire block
  // before whitespace-token passes split it apart.
  let out0 = s.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    REDACTED,
  );

  // Pass 0a: URL userinfo — `scheme://user:pass@host` leaks the password (and
  // arguably the user) into the log. Redact the credentials, keep the host so
  // the audit line stays useful. Handles http(s), ftp, redis, postgres, etc.
  out0 = out0.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]+)(?::([^/\s@]+))?@/g,
    (_m, scheme: string, user: string, pass: string | undefined) =>
      pass !== undefined ? `${scheme}${user}:${REDACTED}@` : `${scheme}${REDACTED}@`,
  );

  // Pass 0b: secret-bearing URL query params — `?token=…&sig=…`. These ride
  // inside a single whitespace token (a URL), so the key=value pass below won't
  // see them; scrub each sensitive query value in place.
  out0 = out0.replace(
    /([?&])([A-Za-z0-9_.-]+)=([^&\s#"']+)/g,
    (match, sep: string, key: string, _val: string) =>
      SENSITIVE_QUERY_KEYS.test(key) ? `${sep}${key}=${REDACTED}` : match,
  );

  // Pass 0c: HTTP auth headers — `Authorization: Bearer <token>`, `-H
  // "Authorization: Basic <b64>"`, and bare `Bearer <token>`. The colon syntax
  // and the scheme word break the key=value / flag-value shapes, so handle them
  // explicitly. Redact the credential, keep the scheme name.
  out0 = out0.replace(
    /(authorization\s*:\s*)(bearer|basic|token|digest)?\s*([^"'\s][^"'\n]*)/gi,
    (_m, head: string, scheme: string | undefined, _cred: string) =>
      `${head}${scheme ? scheme + " " : ""}${REDACTED}`,
  );
  out0 = out0.replace(
    /\b(bearer)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    (_m, scheme: string) => `${scheme} ${REDACTED}`,
  );

  // Pass 1: inline `key=value`. Redact the value when the key is sensitive,
  // or when the value itself looks like a secret. The key may carry leading
  // dashes (`--api-key=…`); strip them before testing sensitivity.
  // The unquoted value stops at `&` so a `k=v&other=v2` URL query (already
  // handled per-param by Pass 0b) isn't greedily swallowed whole.
  let out = out0.replace(
    /([A-Za-z0-9_.-]+)=("[^"]*"|'[^']*'|[^\s&]+)/g,
    (match, rawKey: string, rawVal: string) => {
      const key = rawKey.replace(/^-+/, "");
      const unquoted = rawVal.replace(/^["']|["']$/g, "");
      if (isSensitiveKey(key) || looksLikeSecretValue(unquoted)) {
        return `${rawKey}=${REDACTED}`;
      }
      return match;
    },
  );

  // Pass 2: `--flag value` / `-f value` where the flag name is sensitive.
  // We only consume a following value that isn't itself another flag.
  out = out.replace(
    /(--?[A-Za-z0-9][A-Za-z0-9_-]*)(\s+)("[^"]*"|'[^']*'|(?!-)\S+)/g,
    (match, flag: string, gap: string, rawVal: string) => {
      const key = flag.replace(/^-+/, "");
      if (isSensitiveKey(key)) {
        return `${flag}${gap}${REDACTED}`;
      }
      return match;
    },
  );

  // Pass 3: any remaining bare token that looks like a secret on its own.
  // Split on whitespace, test each token, rejoin preserving single spaces is
  // lossy for tabs/multiple spaces, so instead replace tokens in place via a
  // word-boundary-ish scan that keeps surrounding whitespace intact.
  out = out.replace(/(^|\s)([A-Za-z0-9+/=_.-]+)(?=\s|$)/g, (match, lead: string, tok: string) => {
    // Don't touch tokens that are part of an already-redacted/`key=value`
    // fragment — those were handled above and won't match the secret shapes
    // anyway. A plain bare token like a JWT or AWS key gets caught here.
    if (looksLikeSecretValue(tok)) {
      return `${lead}${REDACTED}`;
    }
    return match;
  });

  return out;
}

/**
 * Return a redacted deep-ish clone of an OpenLogRecord. Pure: does not mutate
 * the input and does not consult the clock (timestamp is passed through as-is —
 * the caller owns the timestamp, per spec §23).
 *
 * Redacts:
 *   - every value in `ast.params` (by key name and by value shape)
 *   - the free-form `command` string (via {@link redactString})
 *
 * A policy *block* is recorded as ordinary data here — redact neither knows nor
 * cares that `result === "blocked_before_execution"`; that outcome is just
 * another field written verbatim.
 */
export function redact(record: OpenLogRecord): OpenLogRecord {
  const params: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(record.ast.params)) {
    params[key] = redactParamValue(key, value);
  }

  return {
    ...record,
    command: redactString(record.command),
    // policyReason is free-form text that can echo user-controlled input (a
    // matched param value, a target path). Run it through the same scrubber so a
    // secret embedded in a reason can't ride into the signed log. redactString
    // only touches known secret shapes, so ordinary reason text is untouched.
    policyReason: redactString(record.policyReason),
    ast: {
      command: record.ast.command,
      params,
    },
    // riskFindings is an array of objects; clone it shallowly so callers can't
    // observe shared references, but its contents are never secret-bearing.
    riskFindings: record.riskFindings.map((f) => ({ ...f })),
  };
}
