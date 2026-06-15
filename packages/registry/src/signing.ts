/**
 * Detached Ed25519 signing for promoted registry definitions (spec §16 "official
 * layer", README "promote a learned draft to the signed official layer").
 *
 * The `idel learn` flow drafts commands into the *custom* layer. `idel promote`
 * moves a reviewed draft up to the *official* layer — and the official layer is
 * the one a team is meant to trust, so its defs are signed. This module is the
 * crypto seam:
 *
 *  - {@link canonicalizeDef} renders a def to STABLE bytes (sorted keys, no
 *    `source` field — that is loader-assigned, not content). The same def always
 *    hashes/signs to the same bytes regardless of JSON key order on disk, so a
 *    signature survives a reformat but breaks on any semantic edit.
 *  - {@link signDef} / {@link verifyDef} sign and check those bytes with
 *    Ed25519 (`@noble/ed25519`, the same pure-JS primitive OpenLogs uses — no
 *    Node builtin, so it works on every target including the ESM build).
 *  - A {@link SignedRegistryManifest} is the sidecar written next to a promoted
 *    JSON file: one entry per def (id, version, content sha-256, signature,
 *    `kid`, who/when). `idel registry verify` reads it back and fails closed on
 *    any official-layer def whose bytes no longer match its signature, or which
 *    has no signature at all.
 *
 * Trust model (honest scope): the signing key is the machine-local Ed25519 key
 * under `~/.idel/keys/` — the same local-only key as OpenLogs. There is no team
 * key registry or out-of-band public-key distribution yet (CONCERNS §5); this
 * proves *integrity since promotion on this machine*, and is the seam where a
 * managed `KeyRegistry` will plug in. We do not overclaim it as multi-party
 * trust.
 */

import { signAsync, verifyAsync, getPublicKeyAsync } from "@noble/ed25519";

import type { CommandDef } from "@openexecution/types";

import { checkCommandDef } from "./schema.js";

/** Current manifest format version, so a future change can migrate cleanly. */
export const REGISTRY_MANIFEST_VERSION = 1 as const;

/** One signed entry in a {@link SignedRegistryManifest}. */
export interface SignedRegistryEntry {
  /** The def id this signature covers. */
  id: string;
  /** The def version at signing time (a version bump re-signs). */
  version: string;
  /** Hex SHA-256 of the canonical bytes — a fast pre-check before verify. */
  sha256: string;
  /** Hex Ed25519 signature over the canonical bytes. */
  signature: string;
  /** Key id of the signing key (matches the OpenLogs `kid` scheme). */
  kid: string;
  /** Hex Ed25519 public key, so a verifier can check without the private key. */
  publicKeyHex: string;
  /** ISO-8601 promotion time (provenance, not part of the signed payload). */
  promotedAt: string;
  /** Who promoted it (provenance). */
  promotedBy: string;
  /** The layer the def was promoted FROM (provenance), e.g. "custom". */
  promotedFrom: string;
}

/** The sidecar file written next to a promoted-`<cli>`.json. */
export interface SignedRegistryManifest {
  manifestVersion: typeof REGISTRY_MANIFEST_VERSION;
  entries: SignedRegistryEntry[];
}

/**
 * Render a {@link CommandDef} to canonical bytes for signing/hashing.
 *
 * Rules that make the bytes stable and meaningful:
 *  - Object keys are emitted in sorted order, recursively, so JSON key order on
 *    disk does not change the signature.
 *  - The loader-assigned `source` field is stripped — it is not content, and a
 *    def signed in `custom` must verify unchanged once it lives in `official`.
 *  - Arrays keep their order (argv order is semantic).
 *
 * Any edit to the actual command — a changed flag, a relaxed risk, an added
 * param — changes these bytes and therefore invalidates the signature. That is
 * the point: a signature attests to exactly these semantics.
 */
export function canonicalizeDef(def: CommandDef): Uint8Array {
  const { source: _source, ...content } = def;
  return new TextEncoder().encode(canonicalJson(content));
}

/** Deterministic JSON: sorted object keys (recursive), arrays left in order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex (odd length): ${hex.slice(0, 16)}…`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Hex SHA-256 of arbitrary bytes via Web Crypto (available on every target). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so the type is the exact
  // `ArrayBuffer` (not `ArrayBufferLike`) that `crypto.subtle.digest` wants
  // under @types/node, without pulling in the DOM `BufferSource` lib type.
  const buf = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}

/** Material needed to sign: the private seed and a stable key id. */
export interface SigningKey {
  /** 32-byte Ed25519 private seed (hex), as stored by the OpenLogs key file. */
  privateKeyHex: string;
  /** Key id, e.g. `key:openlogs:<pub16>`. */
  kid: string;
}

/** The signature + identifiers produced for one def. */
export interface DefSignature {
  sha256: string;
  signature: string;
  publicKeyHex: string;
  kid: string;
}

/**
 * Sign a def's canonical bytes with an Ed25519 private seed. Returns the hex
 * signature, the content hash, and the public key (derived from the seed) so a
 * verifier never needs the private key.
 */
export async function signDef(
  def: CommandDef,
  key: SigningKey,
): Promise<DefSignature> {
  const bytes = canonicalizeDef(def);
  const priv = hexToBytes(key.privateKeyHex);
  const signature = await signAsync(bytes, priv);
  const publicKey = await getPublicKeyAsync(priv);
  return {
    sha256: await sha256Hex(bytes),
    signature: bytesToHex(signature),
    publicKeyHex: bytesToHex(publicKey),
    kid: key.kid,
  };
}

/** Why a def failed verification, for precise reporting. */
export type VerifyDefFailure =
  | { ok: false; reason: "schema"; detail: string }
  | { ok: false; reason: "sha-mismatch"; detail: string }
  | { ok: false; reason: "bad-signature"; detail: string };

export type VerifyDefResult = { ok: true } | VerifyDefFailure;

/**
 * Verify that `entry` is a valid signature for `def`. Checks, in order:
 *  1. the def still passes schema validation (a def that no longer validates is
 *     not trustworthy even if its bytes match an old signature),
 *  2. the content hash matches (fast tamper pre-check),
 *  3. the Ed25519 signature verifies against the embedded public key.
 *
 * Fail-closed: any error (bad hex, malformed signature) is reported as a
 * failure, never thrown to the caller.
 */
export async function verifyDef(
  def: CommandDef,
  entry: SignedRegistryEntry,
): Promise<VerifyDefResult> {
  const schema = checkCommandDef({ ...def, source: undefined });
  if (!schema.ok) {
    return { ok: false, reason: "schema", detail: schema.errors.join("; ") };
  }
  let bytes: Uint8Array;
  let actualSha: string;
  try {
    bytes = canonicalizeDef(def);
    actualSha = await sha256Hex(bytes);
  } catch (err) {
    return { ok: false, reason: "sha-mismatch", detail: (err as Error).message };
  }
  if (actualSha !== entry.sha256) {
    return {
      ok: false,
      reason: "sha-mismatch",
      detail: `content hash ${actualSha.slice(0, 12)}… != signed ${entry.sha256.slice(0, 12)}…`,
    };
  }
  try {
    const ok = await verifyAsync(
      hexToBytes(entry.signature),
      bytes,
      hexToBytes(entry.publicKeyHex),
    );
    return ok
      ? { ok: true }
      : { ok: false, reason: "bad-signature", detail: "Ed25519 signature does not verify" };
  } catch (err) {
    return { ok: false, reason: "bad-signature", detail: (err as Error).message };
  }
}
