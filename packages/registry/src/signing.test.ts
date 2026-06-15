import { describe, it, expect } from "vitest";

import type { CommandDef } from "@openexecution/types";

import {
  canonicalizeDef,
  sha256Hex,
  signDef,
  verifyDef,
  type SignedRegistryEntry,
} from "./signing.js";

/**
 * Signing unit tests for the promoted "official" layer. The crypto must be:
 *  - deterministic in its canonical bytes (independent of JSON key order, and
 *    excluding the loader-assigned `source` field), so a reformat keeps a
 *    signature but a semantic edit breaks it;
 *  - a true Ed25519 round-trip; and
 *  - fail-closed against tampering and malformed signatures.
 */

// A throwaway 32-byte test seed. NOT a real key.
const TEST_KEY = { privateKeyHex: "a".repeat(64), kid: "key:test:aaaaaaaaaaaaaaaa" };

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

async function entryFor(def: CommandDef): Promise<SignedRegistryEntry> {
  const sig = await signDef(def, TEST_KEY);
  return {
    id: def.id,
    version: def.version,
    sha256: sig.sha256,
    signature: sig.signature,
    kid: sig.kid,
    publicKeyHex: sig.publicKeyHex,
    promotedAt: "2026-06-15T00:00:00.000Z",
    promotedBy: "tester",
    promotedFrom: "custom",
  };
}

describe("canonicalizeDef", () => {
  it("is independent of object key order", () => {
    const a = baseDef();
    const reordered: CommandDef = {
      adapters: a.adapters,
      params: {},
      riskDefault: "LOW",
      category: "gh",
      summary: "Show gh auth status.",
      version: "0.1.0",
      id: "show.gh.status",
    };
    expect(canonicalizeDef(a)).toEqual(canonicalizeDef(reordered));
  });

  it("ignores the loader-assigned source field", () => {
    const custom = baseDef({ source: "custom" });
    const official = baseDef({ source: "official" });
    const bare = baseDef();
    expect(canonicalizeDef(custom)).toEqual(canonicalizeDef(bare));
    expect(canonicalizeDef(official)).toEqual(canonicalizeDef(bare));
  });

  it("changes when any semantic field changes", async () => {
    const a = await sha256Hex(canonicalizeDef(baseDef()));
    const b = await sha256Hex(canonicalizeDef(baseDef({ riskDefault: "CRITICAL" })));
    expect(a).not.toEqual(b);
  });
});

describe("signDef / verifyDef", () => {
  it("round-trips a valid signature", async () => {
    const def = baseDef();
    const entry = await entryFor(def);
    expect(await verifyDef(def, entry)).toEqual({ ok: true });
  });

  it("derives the public key from the private seed", async () => {
    const sig = await signDef(baseDef(), TEST_KEY);
    expect(sig.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("rejects a def whose risk was relaxed after signing (sha-mismatch)", async () => {
    const entry = await entryFor(baseDef());
    const tampered = baseDef({ riskDefault: "CRITICAL" });
    const result = await verifyDef(tampered, entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("sha-mismatch");
  });

  it("rejects a def whose adapter argv was changed after signing", async () => {
    const entry = await entryFor(baseDef());
    const tampered = baseDef({
      adapters: {
        posix: {
          command: "gh",
          // someone swaps in a destructive subcommand under a signed id
          args: [{ kind: "literal", value: "repo" }, { kind: "literal", value: "delete" }],
        },
      },
    });
    const result = await verifyDef(tampered, entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("sha-mismatch");
  });

  it("rejects a forged signature (right hash, wrong signature bytes)", async () => {
    const def = baseDef();
    const entry = await entryFor(def);
    // Keep the (correct) sha but corrupt the signature so the hash pre-check
    // passes and the Ed25519 check is what fails.
    const forged: SignedRegistryEntry = {
      ...entry,
      signature: entry.signature.replace(/^../, "00"),
    };
    const result = await verifyDef(def, forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects a signature made by a different key", async () => {
    const def = baseDef();
    const entry = await entryFor(def);
    // Swap in an unrelated public key; the signature no longer verifies.
    const otherSig = await signDef(def, { privateKeyHex: "b".repeat(64), kid: "key:test:b" });
    const mixed: SignedRegistryEntry = { ...entry, publicKeyHex: otherSig.publicKeyHex };
    const result = await verifyDef(def, mixed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects a def that no longer passes schema validation", async () => {
    const def = baseDef();
    const entry = await entryFor(def);
    // Corrupt the def into something invalid (bad id) but keep the old entry.
    const broken = { ...def, id: "NotAValidId" } as CommandDef;
    const result = await verifyDef(broken, entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  it("does not throw on malformed signature hex (fail-closed)", async () => {
    const def = baseDef();
    const entry = await entryFor(def);
    const bad: SignedRegistryEntry = { ...entry, signature: "zz" };
    const result = await verifyDef(def, bad);
    expect(result.ok).toBe(false);
  });
});
