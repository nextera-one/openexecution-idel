/**
 * Pinned-key Ed25519 envelopes for promoted registry definitions.
 *
 * A registry signature is useful only when its verification key comes from a
 * trust decision outside the signed artifact. Version 2 therefore deliberately
 * carries no public key in the manifest. Callers must supply pinned
 * `{ kid, publicKeyHex }` records, and verification fails closed when a key is
 * missing, ambiguous, malformed, or wrong.
 *
 * The signature covers a domain-separated canonical envelope containing the
 * complete canonical command, its digest and version, the signing `kid`, and
 * all promotion provenance. Editing any of those fields invalidates the
 * signature. Version-1 manifests are not compatible and must be re-promoted;
 * they are never silently treated as trusted.
 */

import { getPublicKeyAsync, signAsync, verifyAsync } from "@noble/ed25519";

import type { CommandDef } from "@openexecution/types";

import { checkCommandDef } from "./schema.js";

/** Current detached-manifest and signed-envelope versions. */
export const REGISTRY_MANIFEST_VERSION = 2 as const;
export const REGISTRY_ENVELOPE_VERSION = 2 as const;
export const REGISTRY_TRUST_STORE_VERSION = 1 as const;

const ENVELOPE_DOMAIN = "openexecution.registry.signed-envelope.v2";

/** Signed provenance for the deliberate promotion event. */
export interface RegistryPromotionProvenance {
  /** ISO-8601 promotion time. */
  promotedAt: string;
  /** Account or automation identity that performed the promotion. */
  promotedBy: string;
  /** Source layer, normally `custom`. */
  promotedFrom: string;
  /** Makes local development signatures distinguishable from release signing. */
  signingMode: "development" | "release";
}

/** The payload metadata covered by an entry signature. */
export interface SignedRegistryPayload {
  commandId: string;
  commandVersion: string;
  commandSha256: string;
  kid: string;
  provenance: RegistryPromotionProvenance;
}

/** One versioned, signed registry envelope. No verification key is embedded. */
export interface SignedRegistryEntry {
  envelopeVersion: typeof REGISTRY_ENVELOPE_VERSION;
  payload: SignedRegistryPayload;
  /** Hex Ed25519 signature over the domain-separated canonical envelope. */
  signature: string;
}

/** The sidecar file written next to a promoted-`<cli>`.json. */
export interface SignedRegistryManifest {
  manifestVersion: typeof REGISTRY_MANIFEST_VERSION;
  entries: SignedRegistryEntry[];
}

/** A public key trusted by caller configuration, never by the manifest. */
export interface TrustedRegistryKey {
  kid: string;
  publicKeyHex: string;
}

/** On-disk shape for an independently managed pinned-key configuration. */
export interface RegistryTrustStore {
  trustStoreVersion: typeof REGISTRY_TRUST_STORE_VERSION;
  keys: TrustedRegistryKey[];
}

/**
 * Render a command to stable bytes. Object keys are sorted recursively, array
 * order is retained, and the loader-assigned `source` field is removed.
 */
export function canonicalizeDef(def: CommandDef): Uint8Array {
  const { source: _source, ...content } = def;
  return new TextEncoder().encode(canonicalJson(content));
}

/** Deterministic JSON: sorted object keys recursively, arrays left in order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string, expectedBytes: number, label: string): Uint8Array {
  if (!new RegExp(`^[0-9a-fA-F]{${expectedBytes * 2}}$`).test(hex)) {
    throw new Error(`${label} must be exactly ${expectedBytes} bytes of hexadecimal`);
  }
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Hex SHA-256 of arbitrary bytes via Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return bytesToHex(new Uint8Array(digest));
}

/** Material needed to sign: a 32-byte Ed25519 seed and stable key identity. */
export interface SigningKey {
  privateKeyHex: string;
  kid: string;
}

/** Result of signing one complete registry envelope. */
export interface DefSignature extends SignedRegistryEntry {
  /** Derived for display or an explicit pinning operation, never for verification. */
  signerPublicKeyHex: string;
}

function envelopeBytes(
  def: CommandDef,
  payload: SignedRegistryPayload,
): Uint8Array {
  const canonicalCommand = new TextDecoder().decode(canonicalizeDef(def));
  const envelope = canonicalJson({
    domain: ENVELOPE_DOMAIN,
    envelopeVersion: REGISTRY_ENVELOPE_VERSION,
    payload,
    command: JSON.parse(canonicalCommand) as unknown,
  });
  return new TextEncoder().encode(envelope);
}

/**
 * Sign the command, key identity, and complete promotion provenance together.
 * The returned public key is informational and intentionally excluded from the
 * persisted envelope type.
 */
export async function signDef(
  def: CommandDef,
  key: SigningKey,
  provenance: RegistryPromotionProvenance,
): Promise<DefSignature> {
  const privateKey = hexToBytes(key.privateKeyHex, 32, "private key");
  const commandSha256 = await sha256Hex(canonicalizeDef(def));
  const payload: SignedRegistryPayload = {
    commandId: def.id,
    commandVersion: def.version,
    commandSha256,
    kid: key.kid,
    provenance,
  };
  const signature = await signAsync(envelopeBytes(def, payload), privateKey);
  const publicKey = await getPublicKeyAsync(privateKey);
  return {
    envelopeVersion: REGISTRY_ENVELOPE_VERSION,
    payload,
    signature: bytesToHex(signature),
    signerPublicKeyHex: bytesToHex(publicKey),
  };
}

/** Why a def failed verification, for precise fail-closed reporting. */
export type VerifyDefFailure =
  | { ok: false; reason: "schema"; detail: string }
  | { ok: false; reason: "unsupported-envelope"; detail: string }
  | { ok: false; reason: "metadata-mismatch"; detail: string }
  | { ok: false; reason: "sha-mismatch"; detail: string }
  | { ok: false; reason: "untrusted-key"; detail: string }
  | { ok: false; reason: "invalid-trust-config"; detail: string }
  | { ok: false; reason: "bad-signature"; detail: string };

export type VerifyDefResult = { ok: true } | VerifyDefFailure;

/**
 * Verify a v2 entry against caller-supplied pinned keys. There is intentionally
 * no default key and no fallback to manifest metadata.
 */
export async function verifyDef(
  def: CommandDef,
  entry: SignedRegistryEntry,
  trustedKeys: readonly TrustedRegistryKey[],
): Promise<VerifyDefResult> {
  const schema = checkCommandDef({ ...def, source: undefined });
  if (!schema.ok) {
    return { ok: false, reason: "schema", detail: schema.errors.join("; ") };
  }

  if (!isSignedRegistryEntry(entry)) {
    return {
      ok: false,
      reason: "unsupported-envelope",
      detail: "expected registry signed-envelope version 2; re-promote legacy entries",
    };
  }
  if (
    entry.payload.commandId !== def.id ||
    entry.payload.commandVersion !== def.version
  ) {
    return {
      ok: false,
      reason: "metadata-mismatch",
      detail: "signed command id/version does not match the registry definition",
    };
  }

  const actualSha = await sha256Hex(canonicalizeDef(def));
  if (actualSha !== entry.payload.commandSha256) {
    return {
      ok: false,
      reason: "sha-mismatch",
      detail: `content hash ${actualSha.slice(0, 12)}… != signed ${entry.payload.commandSha256.slice(0, 12)}…`,
    };
  }

  const pins = trustedKeys.filter((key) => key.kid === entry.payload.kid);
  if (pins.length === 0) {
    return {
      ok: false,
      reason: "untrusted-key",
      detail: `no pinned registry key for kid ${entry.payload.kid}`,
    };
  }
  const distinctKeys = new Set(pins.map((key) => key.publicKeyHex.toLowerCase()));
  if (distinctKeys.size !== 1) {
    return {
      ok: false,
      reason: "invalid-trust-config",
      detail: `conflicting pinned public keys for kid ${entry.payload.kid}`,
    };
  }

  try {
    const publicKeyHex = pins[0]?.publicKeyHex;
    if (!publicKeyHex) throw new Error("missing pinned public key");
    const ok = await verifyAsync(
      hexToBytes(entry.signature, 64, "signature"),
      envelopeBytes(def, entry.payload),
      hexToBytes(publicKeyHex, 32, "pinned public key"),
    );
    return ok
      ? { ok: true }
      : {
          ok: false,
          reason: "bad-signature",
          detail: "Ed25519 signature does not verify against the pinned key",
        };
  } catch (error) {
    return { ok: false, reason: "bad-signature", detail: (error as Error).message };
  }
}

/** Strict structural check used before any untrusted manifest fields are read. */
export function isSignedRegistryEntry(value: unknown): value is SignedRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SignedRegistryEntry>;
  if (entry.envelopeVersion !== REGISTRY_ENVELOPE_VERSION) return false;
  if (typeof entry.signature !== "string") return false;
  const payload = entry.payload as Partial<SignedRegistryPayload> | undefined;
  const provenance = payload?.provenance as Partial<RegistryPromotionProvenance> | undefined;
  return Boolean(
    payload &&
      typeof payload.commandId === "string" &&
      typeof payload.commandVersion === "string" &&
      typeof payload.commandSha256 === "string" &&
      typeof payload.kid === "string" &&
      provenance &&
      typeof provenance.promotedAt === "string" &&
      typeof provenance.promotedBy === "string" &&
      typeof provenance.promotedFrom === "string" &&
      (provenance.signingMode === "development" || provenance.signingMode === "release"),
  );
}
