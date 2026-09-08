import { describe, expect, it } from "vitest";

import type { CommandDef } from "@openexecution/types";

import {
  canonicalizeDef,
  sha256Hex,
  signDef,
  verifyDef,
  type RegistryPromotionProvenance,
  type SignedRegistryEntry,
  type SigningKey,
  type TrustedRegistryKey,
} from "./signing.js";

const TEST_KEY: SigningKey = {
  privateKeyHex: "a".repeat(64),
  kid: "key:registry:test-a",
};
const OTHER_KEY: SigningKey = {
  privateKeyHex: "b".repeat(64),
  kid: "key:registry:test-b",
};
const PROVENANCE: RegistryPromotionProvenance = {
  promotedAt: "2026-06-15T00:00:00.000Z",
  promotedBy: "tester",
  promotedFrom: "custom",
  signingMode: "development",
};

function baseDef(over: Partial<CommandDef> = {}): CommandDef {
  return {
    id: "show.gh.status",
    version: "0.1.0",
    summary: "Show gh auth status.",
    category: "gh",
    riskDefault: "LOW",
    params: {},
    adapters: {
      posix: {
        command: "gh",
        args: [
          { kind: "literal", value: "auth" },
          { kind: "literal", value: "status" },
        ],
      },
    },
    ...over,
  };
}

async function signed(
  def = baseDef(),
  key = TEST_KEY,
  provenance = PROVENANCE,
): Promise<{ entry: SignedRegistryEntry; pin: TrustedRegistryKey }> {
  const result = await signDef(def, key, provenance);
  return {
    entry: {
      envelopeVersion: result.envelopeVersion,
      payload: result.payload,
      signature: result.signature,
    },
    pin: { kid: key.kid, publicKeyHex: result.signerPublicKeyHex },
  };
}

describe("canonicalizeDef", () => {
  it("is independent of object key order", () => {
    const def = baseDef();
    const reordered: CommandDef = {
      adapters: def.adapters,
      params: {},
      riskDefault: "LOW",
      category: "gh",
      summary: "Show gh auth status.",
      version: "0.1.0",
      id: "show.gh.status",
    };
    expect(canonicalizeDef(def)).toEqual(canonicalizeDef(reordered));
  });

  it("ignores the loader-assigned source field", () => {
    expect(canonicalizeDef(baseDef({ source: "custom" }))).toEqual(
      canonicalizeDef(baseDef({ source: "official" })),
    );
  });

  it("changes when semantic content changes", async () => {
    const original = await sha256Hex(canonicalizeDef(baseDef()));
    const changed = await sha256Hex(
      canonicalizeDef(baseDef({ riskDefault: "CRITICAL" })),
    );
    expect(original).not.toEqual(changed);
  });
});

describe("v2 signed registry envelope", () => {
  it("round-trips only with a caller-supplied pinned key", async () => {
    const def = baseDef();
    const { entry, pin } = await signed(def);
    expect(await verifyDef(def, entry, [pin])).toEqual({ ok: true });
    expect(await verifyDef(def, entry, [])).toMatchObject({
      ok: false,
      reason: "untrusted-key",
    });
  });

  it("does not embed a self-authenticating public key", async () => {
    const { entry } = await signed();
    expect(entry).not.toHaveProperty("publicKeyHex");
    expect(entry.payload).not.toHaveProperty("publicKeyHex");
    expect(entry.envelopeVersion).toBe(2);
  });

  it("rejects an attacker self-signed definition against the legitimate pin", async () => {
    const def = baseDef();
    // The attacker deliberately reuses the trusted kid; verification still
    // selects the independently pinned legitimate public key.
    const attacker = await signed(def, { ...OTHER_KEY, kid: TEST_KEY.kid });
    const legitimate = await signed(def, TEST_KEY);
    expect(await verifyDef(def, attacker.entry, [legitimate.pin])).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects missing and wrong pinned keys", async () => {
    const def = baseDef();
    const legitimate = await signed(def);
    const other = await signed(def, { ...OTHER_KEY, kid: TEST_KEY.kid });
    expect(await verifyDef(def, legitimate.entry, [])).toMatchObject({
      ok: false,
      reason: "untrusted-key",
    });
    expect(await verifyDef(def, legitimate.entry, [other.pin])).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects promotion-provenance tampering", async () => {
    const def = baseDef();
    const { entry, pin } = await signed(def);
    const tampered: SignedRegistryEntry = {
      ...entry,
      payload: {
        ...entry.payload,
        provenance: { ...entry.payload.provenance, promotedBy: "attacker" },
      },
    };
    expect(await verifyDef(def, tampered, [pin])).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("binds kid identity inside the signed envelope", async () => {
    const def = baseDef();
    const { entry, pin } = await signed(def);
    const renamedKid = "key:registry:renamed";
    const tampered: SignedRegistryEntry = {
      ...entry,
      payload: { ...entry.payload, kid: renamedKid },
    };
    expect(
      await verifyDef(def, tampered, [{ ...pin, kid: renamedKid }]),
    ).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("rejects command and adapter tampering", async () => {
    const original = baseDef();
    const { entry, pin } = await signed(original);
    const changed = baseDef({
      adapters: {
        posix: {
          command: "gh",
          args: [{ kind: "literal", value: "repo" }, { kind: "literal", value: "delete" }],
        },
      },
    });
    expect(await verifyDef(changed, entry, [pin])).toMatchObject({
      ok: false,
      reason: "sha-mismatch",
    });
  });

  it("rejects v1 unanchored entries instead of silently migrating them", async () => {
    const legacy = {
      id: "show.gh.status",
      version: "0.1.0",
      sha256: "0".repeat(64),
      signature: "0".repeat(128),
      kid: "attacker",
      publicKeyHex: "0".repeat(64),
      promotedAt: PROVENANCE.promotedAt,
      promotedBy: PROVENANCE.promotedBy,
      promotedFrom: PROVENANCE.promotedFrom,
    } as unknown as SignedRegistryEntry;
    expect(await verifyDef(baseDef(), legacy, [])).toMatchObject({
      ok: false,
      reason: "unsupported-envelope",
    });
  });

  it("rejects malformed signatures and invalid schema without throwing", async () => {
    const def = baseDef();
    const { entry, pin } = await signed(def);
    expect(await verifyDef(def, { ...entry, signature: "zz" }, [pin])).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
    const invalid = { ...def, id: "NotAValidId" } as CommandDef;
    expect(await verifyDef(invalid, entry, [pin])).toMatchObject({
      ok: false,
      reason: "schema",
    });
  });
});
