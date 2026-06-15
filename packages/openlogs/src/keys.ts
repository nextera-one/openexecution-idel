/**
 * Signing-key management for OpenLogs (spec §23 "accountability layer").
 *
 * OpenLogs v2 records are Ed25519-signed and hash-chained. That requires a
 * stable signing keypair on the machine writing the log. We generate one on
 * first use and persist it under `~/.idel/keys/`, with the private key written
 * `0600` so it is not world-readable. The public key (and `kid`) are what a
 * verifier needs to trust the chain; the private key never leaves this file.
 *
 * This is intentionally local-only key management — no HSM, no rotation policy.
 * Those belong to the team/CI story (a managed `KeyRegistry`), which is future
 * work. See CONCERNS.md.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { generateEd25519Keypair, hexToBytes } from "@nextera.one/openlogs-sdk";

/** Default key location: `~/.idel/keys/openlogs.key.json`. */
const DEFAULT_REL_PATH = ".idel/keys/openlogs.key.json";

/** Shape persisted to disk (hex-encoded). `kid` lets verifiers pin a key. */
export interface StoredKeypair {
  kid: string;
  publicKeyHex: string;
  privateKeyHex: string;
}

/** Runtime keypair: raw bytes ready for the SDK's sign API, plus identifiers. */
export interface OpenLogKeypair {
  kid: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function resolveKeyPath(input?: string): string {
  const home = homedir();
  if (!input) return join(home, DEFAULT_REL_PATH);
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/**
 * Load the persisted keypair, generating and saving one on first use.
 *
 * The generated `kid` is derived from the public key so it is stable and
 * self-describing without needing a counter or clock (both of which would make
 * the key non-reproducible). The private key file is chmod `0600`.
 */
export async function loadOrCreateKeypair(
  keyPath?: string,
): Promise<OpenLogKeypair> {
  const path = resolveKeyPath(keyPath);
  try {
    const raw = await readFile(path, "utf8");
    const stored = JSON.parse(raw) as Partial<StoredKeypair>;
    if (stored.publicKeyHex && stored.privateKeyHex && stored.kid) {
      return {
        kid: stored.kid,
        publicKeyHex: stored.publicKeyHex,
        privateKey: hexToBytes(stored.privateKeyHex),
        publicKey: hexToBytes(stored.publicKeyHex),
      };
    }
    // Fall through to regenerate if the file is incomplete/corrupt.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const generated = await generateEd25519Keypair();
  const publicKeyHex = bytesToHex(generated.publicKey);
  const privateKeyHex = bytesToHex(generated.privateKey);
  const kid = `key:openlogs:${publicKeyHex.slice(0, 16)}`;
  const stored: StoredKeypair = { kid, publicKeyHex, privateKeyHex };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, JSON.stringify(stored, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return loadOrCreateKeypair(keyPath);
    }
    throw err;
  }
  // Best-effort lock-down of the private key; chmod is a no-op semantics-wise
  // on Windows but harmless.
  try {
    await chmod(path, 0o600);
  } catch {
    /* non-fatal: filesystem may not support POSIX modes */
  }
  return {
    kid,
    publicKeyHex,
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };
}
