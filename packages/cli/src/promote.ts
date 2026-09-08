import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeypair } from "@openexecution/openlogs";
import {
  checkCommandDef,
  signDef,
  REGISTRY_MANIFEST_VERSION,
  type SignedRegistryEntry,
  type SignedRegistryManifest,
} from "@openexecution/registry";
import type { CommandDef } from "@openexecution/types";

import { verifyDefs } from "./learn.js";
import { color } from "./render.js";

/**
 * `idel promote <cli> [--yes] [--json]` — promote learned draft commands from
 * the *custom* layer up to the signed *official* layer (README "promote a
 * learned draft to the official layer behind review/signing"; the remaining V2
 * piece in CONCERNS).
 *
 * `idel learn gh --write` drafts commands into
 * `~/.idel/registries/custom/learned-gh.json`. Those are unsigned drafts the
 * runtime treats as the lowest-trust layer. Promotion is the deliberate, gated
 * step that says "I reviewed these and vouch for them":
 *
 *  1. **Re-verify, don't trust the past.** Every draft is re-validated against
 *     the registry schema AND its declared `tests[]` are REPLAYED through a real
 *     runtime *right now* (not relying on the earlier learn run). A draft that
 *     no longer validates, or whose tests no longer match the runtime's
 *     classification, is rejected and never promoted — fail-closed.
 *  2. **Explicit human review.** The accepted set is shown with its risk and the
 *     promotion is gated behind an interactive y/N (or `--yes` in CI). Nothing
 *     is signed without that confirmation.
 *  3. **Sign what passes.** Each confirmed def is Ed25519-signed with a
 *     machine-local development key over a v2 envelope that binds its canonical
 *     bytes, key identity, and promotion provenance. The defs are
 *     written to `~/.idel/registries/official/promoted-<cli>.json` and a
 *     detached signature manifest to `promoted-<cli>.sig.json`. The promoted
 *     ids are then removed from the custom draft file so a command lives in
 *     exactly one writable layer.
 *
 * The official layer still does NOT override safety: a promoted destructive
 * command is re-classified by the same two-phase engine on every run. Promotion
 * raises *trust/provenance*, never *privilege*. `idel registry verify` checks
 * these signatures and fails closed on any tampered or unsigned official def.
 *
 * Trust scope (honest): promotion creates an explicitly DEVELOPMENT signature,
 * but never silently trusts that signer. Verification and runtime loading use
 * only independently pinned keys from the registry trust store. A team/CI must
 * distribute that pin (or use a separately managed release signer) before an
 * official layer is trusted across machines.
 */
export async function promote(
  cli: string,
  opts: { yes: boolean; json: boolean },
): Promise<number> {
  const trimmed = cli.trim();
  if (!trimmed) {
    process.stderr.write(
      color.gray('Usage: idel promote <cli> [--yes]   e.g. `idel promote gh`\n'),
    );
    return 2;
  }

  const dirs = registryDirs();
  const draftPath = join(dirs.custom, `learned-${trimmed}.json`);

  let drafts: CommandDef[];
  try {
    drafts = await readDrafts(draftPath);
  } catch (err) {
    process.stderr.write(color.red(`${(err as Error).message}\n`));
    return 1;
  }
  if (!drafts.length) {
    process.stderr.write(
      color.yellow(
        `No learned drafts for "${trimmed}" at ${draftPath}.\n`,
      ) +
        color.gray(`  Run \`idel learn ${trimmed} --write\` first.\n`),
    );
    return 1;
  }

  // ----- Pass 1: re-verify schema + replay tests through a real runtime ------
  const { eligible, rejected } = await reverify(drafts);

  if (!opts.json) {
    renderPlan(trimmed, eligible, rejected);
  }

  if (!eligible.length) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { cli: trimmed, promoted: 0, rejected: rejected.length, signatures: [] },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(
        color.yellow("\nNothing eligible to promote — no official defs written.\n"),
      );
    }
    return 1;
  }

  // ----- Review gate ---------------------------------------------------------
  if (!opts.yes) {
    if (opts.json) {
      // Non-interactive JSON without --yes would hang on the prompt. Refuse,
      // fail-closed, and tell the caller how to proceed.
      process.stderr.write(
        color.red("refusing to promote without confirmation: pass --yes for non-interactive promotion.\n"),
      );
      return 2;
    }
    const ok = await confirm(
      color.bold(
        `\nPromote ${eligible.length} command(s) for "${trimmed}" to the signed official layer?`,
      ) + color.gray(" [y/N] "),
    );
    if (!ok) {
      process.stdout.write(color.gray("Aborted. Nothing promoted.\n"));
      return 1;
    }
  }

  // ----- Sign + write --------------------------------------------------------
  let written;
  try {
    written = await signAndWrite(trimmed, eligible, dirs, draftPath, drafts);
  } catch (err) {
    process.stderr.write(color.red(`promote failed: ${(err as Error).message}\n`));
    return 1;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          cli: trimmed,
          promoted: eligible.length,
          rejected: rejected.length,
          officialPath: written.defsPath,
          manifestPath: written.manifestPath,
          kid: written.kid,
          signerPublicKeyHex: written.signerPublicKeyHex,
          signingMode: "development",
          trustedByDefault: false,
          trustStorePath: written.trustStorePath,
          signatures: written.manifest.entries.map((e) => ({
            id: e.payload.commandId,
            sha256: e.payload.commandSha256,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    color.green(`\n✓ promoted ${eligible.length} command(s) `) +
      color.gray(`to the official layer\n`) +
      color.gray(`  defs:      ${written.defsPath}\n`) +
      color.gray(`  signed by: ${written.kid} (DEVELOPMENT; not trusted by default)\n`) +
      color.gray(`  public key: ${written.signerPublicKeyHex}\n`) +
      color.gray(`  manifest:  ${written.manifestPath}\n`) +
      color.yellow(`  Pin this key out-of-band in ${written.trustStorePath}\n`) +
      color.gray(`  Then verify with:  idel registry verify\n`),
  );
  return 0;
}

interface ReverifyResult {
  eligible: CommandDef[];
  rejected: { id: string; reasons: string[] }[];
}

/**
 * Re-validate each draft against the schema and replay its `tests[]` through a
 * real runtime now. Only defs that pass BOTH are eligible to promote.
 */
async function reverify(drafts: CommandDef[]): Promise<ReverifyResult> {
  const eligible: CommandDef[] = [];
  const rejected: { id: string; reasons: string[] }[] = [];

  // Schema first; a malformed draft never reaches test replay.
  const schemaOk: CommandDef[] = [];
  for (const draft of drafts) {
    const id = typeof draft?.id === "string" ? draft.id : "<no id>";
    const { ok, errors } = checkCommandDef({ ...draft, source: undefined });
    if (ok) {
      schemaOk.push(draft);
    } else {
      rejected.push({ id, reasons: errors });
    }
  }

  // Replay tests for all schema-valid drafts at once (one ephemeral runtime).
  const verifications = schemaOk.length ? await verifyDefs(schemaOk) : {};
  for (const def of schemaOk) {
    const v = verifications[def.id];
    if (v && v.failures.length > 0) {
      rejected.push({
        id: def.id,
        reasons: [
          `test replay failed (${v.passed}/${v.ran}): ${v.failures.join("; ")}`,
        ],
      });
    } else {
      eligible.push(def);
    }
  }

  return { eligible, rejected };
}

interface WriteResult {
  defsPath: string;
  manifestPath: string;
  manifest: SignedRegistryManifest;
  kid: string;
  signerPublicKeyHex: string;
  trustStorePath: string;
}

async function signAndWrite(
  cli: string,
  defs: CommandDef[],
  dirs: { custom: string; official: string },
  draftPath: string,
  allDrafts: CommandDef[],
): Promise<WriteResult> {
  // This key is intentionally separate from OpenLogs and explicitly labelled
  // development. Creating it does NOT add it to the verification trust store.
  const developmentKeyPath = join(
    homedir(),
    ".idel",
    "keys",
    "registry-development.key.json",
  );
  const key = await loadOrCreateKeypair(developmentKeyPath);
  const registryKid = `key:registry-development:${key.publicKeyHex.slice(0, 16)}`;
  const promotedAt = new Date().toISOString();
  const promotedBy = currentUser();
  const provenance = {
    promotedAt,
    promotedBy,
    promotedFrom: "custom",
    signingMode: "development" as const,
  };

  const entries: SignedRegistryEntry[] = [];
  let signerPublicKeyHex = key.publicKeyHex;
  for (const def of defs) {
    const sig = await signDef(
      def,
      {
        privateKeyHex: bytesToHex(key.privateKey),
        kid: registryKid,
      },
      provenance,
    );
    signerPublicKeyHex = sig.signerPublicKeyHex;
    entries.push({
      envelopeVersion: sig.envelopeVersion,
      payload: sig.payload,
      signature: sig.signature,
    });
  }
  const manifest: SignedRegistryManifest = {
    manifestVersion: REGISTRY_MANIFEST_VERSION,
    entries,
  };

  await mkdir(dirs.official, { recursive: true });
  // Strip the loader-assigned `source` before writing — it is not content.
  const onDisk = defs.map(({ source: _s, ...rest }) => rest);
  const defsPath = join(dirs.official, `promoted-${cli}.json`);
  const manifestPath = join(dirs.official, `promoted-${cli}.sig.json`);
  await writeFile(defsPath, JSON.stringify(onDisk, null, 2) + "\n", "utf8");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Remove the promoted ids from the custom draft file so a command lives in a
  // single writable layer. If nothing remains, write an empty array (keeps the
  // file's existence stable rather than deleting under the user).
  const promotedIds = new Set(defs.map((d) => d.id));
  const remaining = allDrafts.filter((d) => !promotedIds.has(d.id));
  await writeFile(draftPath, JSON.stringify(remaining, null, 2) + "\n", "utf8");

  return {
    defsPath,
    manifestPath,
    manifest,
    kid: registryKid,
    signerPublicKeyHex,
    trustStorePath: join(homedir(), ".idel", "trust", "registry-keys.json"),
  };
}

function renderPlan(
  cli: string,
  eligible: CommandDef[],
  rejected: { id: string; reasons: string[] }[],
): void {
  process.stdout.write(
    color.bold(`Promote ${cli}`) +
      color.gray(`  (${eligible.length} eligible, ${rejected.length} rejected)\n\n`),
  );
  for (const def of eligible) {
    const riskColor =
      def.riskDefault === "CRITICAL" || def.riskDefault === "HIGH"
        ? color.red
        : color.gray;
    process.stdout.write(
      color.green("  ✓ ") +
        def.id +
        riskColor(`  [${def.riskDefault}]`) +
        color.gray(`  ${def.summary}\n`),
    );
  }
  for (const r of rejected) {
    process.stdout.write(
      color.red("  ✗ ") + r.id + color.gray(`  — ${r.reasons.join("; ")}\n`),
    );
  }
}

async function readDrafts(path: string): Promise<CommandDef[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Error(`cannot read drafts at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`expected an array of command defs in ${path}`);
  }
  return parsed as CommandDef[];
}

function confirm(prompt: string): Promise<boolean> {
  // No TTY (piped/CI without --yes): fail closed rather than block forever.
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function registryDirs(): { custom: string; official: string } {
  const base = join(homedir(), ".idel", "registries");
  return { custom: join(base, "custom"), official: join(base, "official") };
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    // Some environments (no passwd entry) make userInfo throw.
    return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
