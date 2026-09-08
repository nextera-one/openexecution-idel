import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isSignedRegistryEntry,
  REGISTRY_MANIFEST_VERSION,
  REGISTRY_TRUST_STORE_VERSION,
  verifyDef,
  type RegistryTrustStore,
  type SignedRegistryEntry,
  type TrustedRegistryKey,
} from "@openexecution/registry";
import type { CommandDef } from "@openexecution/types";

import { color } from "./render.js";

/** Default independent trust configuration; never populated by promotion. */
export function registryTrustStorePath(): string {
  return (
    process.env["IDEL_REGISTRY_TRUST_STORE"] ??
    join(homedir(), ".idel", "trust", "registry-keys.json")
  );
}

/**
 * Load pinned registry verification keys. A missing file means no keys are
 * trusted; malformed or ambiguous configuration is a hard failure.
 */
export async function loadTrustedRegistryKeys(
  path = registryTrustStorePath(),
): Promise<TrustedRegistryKey[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read registry trust store ${path}: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid registry trust store ${path}: expected an object`);
  }
  const store = parsed as Partial<RegistryTrustStore>;
  if (store.trustStoreVersion !== REGISTRY_TRUST_STORE_VERSION) {
    throw new Error(
      `invalid registry trust store ${path}: expected trustStoreVersion ${REGISTRY_TRUST_STORE_VERSION}`,
    );
  }
  if (!Array.isArray(store.keys)) {
    throw new Error(`invalid registry trust store ${path}: keys must be an array`);
  }

  const seen = new Set<string>();
  const keys: TrustedRegistryKey[] = [];
  for (const [index, candidate] of store.keys.entries()) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.kid !== "string" ||
      candidate.kid.length === 0 ||
      typeof candidate.publicKeyHex !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(candidate.publicKeyHex)
    ) {
      throw new Error(`invalid registry trust store ${path}: malformed key at index ${index}`);
    }
    if (seen.has(candidate.kid)) {
      throw new Error(`invalid registry trust store ${path}: duplicate kid ${candidate.kid}`);
    }
    seen.add(candidate.kid);
    keys.push({ kid: candidate.kid, publicKeyHex: candidate.publicKeyHex.toLowerCase() });
  }
  return keys;
}

/** Verify the configured official registry against independently pinned keys. */
export async function verifyRegistry(opts: { json: boolean }): Promise<number> {
  const officialDir = join(homedir(), ".idel", "registries", "official");
  const trustPath = registryTrustStorePath();

  let report: VerifyReport;
  try {
    const trustedKeys = await loadTrustedRegistryKeys(trustPath);
    report = await verifyOfficialLayer(officialDir, trustedKeys);
    report.trustStorePath = trustPath;
    report.trustedKeyCount = trustedKeys.length;
  } catch (error) {
    process.stderr.write(color.red(`registry verify failed: ${(error as Error).message}\n`));
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.ok ? 0 : 1;
  }

  renderReport(report, officialDir);
  return report.ok ? 0 : 1;
}

export interface VerifyItem {
  id: string;
  file: string;
  status: "ok" | "unsigned" | "invalid" | "untrusted";
  detail?: string;
  kid?: string;
}

export interface VerifyReport {
  ok: boolean;
  dir: string;
  checked: number;
  okCount: number;
  failures: number;
  items: VerifyItem[];
  trustStorePath?: string;
  trustedKeyCount?: number;
}

/**
 * Verify every official definition against v2 envelopes and caller-supplied
 * pins. Omitting `trustedKeys` trusts nobody and therefore fails closed for any
 * signed content.
 */
export async function verifyOfficialLayer(
  dir: string,
  trustedKeys: readonly TrustedRegistryKey[] = [],
): Promise<VerifyReport> {
  const items: VerifyItem[] = [];

  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((file) => file.endsWith(".json") && !file.endsWith(".sig.json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyReport(dir);
    }
    throw error;
  }

  for (const file of files) {
    const defs = await readDefs(join(dir, file));
    const manifestName = file.replace(/\.json$/, ".sig.json");
    const manifest = await readManifest(join(dir, manifestName));

    if (manifest.kind !== "current") {
      const detail =
        manifest.kind === "missing"
          ? `missing manifest ${manifestName}`
          : manifest.detail;
      if (defs.length === 0) {
        items.push({ id: "<manifest>", file, status: "invalid", detail });
      } else {
        for (const def of defs) {
          items.push({
            id: commandId(def),
            file,
            status: manifest.kind === "missing" ? "unsigned" : "invalid",
            detail,
          });
        }
      }
      continue;
    }

    if (!manifest.entries.every(isSignedRegistryEntry)) {
      const detail = "malformed or unsupported signed envelope; re-promote the file";
      for (const def of defs.length ? defs : ([{}] as CommandDef[])) {
        items.push({ id: commandId(def), file, status: "invalid", detail });
      }
      continue;
    }

    const entries = manifest.entries as SignedRegistryEntry[];
    const defCounts = countBy(defs.map(commandId));
    const entryCounts = countBy(entries.map((entry) => entry.payload.commandId));
    const duplicateIds = new Set(
      [...defCounts, ...entryCounts]
        .filter(([, count]) => count !== 1)
        .map(([id]) => id),
    );
    const byId = new Map(entries.map((entry) => [entry.payload.commandId, entry]));

    for (const def of defs) {
      const id = commandId(def);
      const entry = byId.get(id);
      if (duplicateIds.has(id)) {
        items.push({ id, file, status: "invalid", detail: "duplicate definition or envelope id" });
        continue;
      }
      if (!entry) {
        items.push({
          id,
          file,
          status: "unsigned",
          detail: "no signed envelope for this id in the manifest",
        });
        continue;
      }
      const result = await verifyDef(def, entry, trustedKeys);
      if (result.ok) {
        items.push({ id, file, status: "ok", kid: entry.payload.kid });
      } else {
        items.push({
          id,
          file,
          status: result.reason === "untrusted-key" ? "untrusted" : "invalid",
          detail: `${result.reason}: ${result.detail}`,
          kid: entry.payload.kid,
        });
      }
    }

    // Extra envelopes are also a manifest-integrity failure; they must not be
    // ignored because doing so permits hidden or stale signed metadata.
    const defIds = new Set(defs.map(commandId));
    for (const entry of entries) {
      const id = entry.payload.commandId;
      if (!defIds.has(id)) {
        items.push({
          id,
          file,
          status: "invalid",
          detail: "signed envelope has no matching command definition",
          kid: entry.payload.kid,
        });
      }
    }
  }

  const okCount = items.filter((item) => item.status === "ok").length;
  const failures = items.length - okCount;
  return { ok: failures === 0, dir, checked: items.length, okCount, failures, items };
}

function emptyReport(dir: string): VerifyReport {
  return { ok: true, dir, checked: 0, okCount: 0, failures: 0, items: [] };
}

function commandId(def: CommandDef): string {
  return typeof def?.id === "string" ? def.id : "<no id>";
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function renderReport(report: VerifyReport, dir: string): void {
  if (report.checked === 0) {
    process.stdout.write(
      color.gray(`No signed official commands found under ${dir}.\n`) +
        color.gray("  Promote a learned draft with:  idel promote <cli>\n"),
    );
    return;
  }
  process.stdout.write(
    color.bold("Official registry signatures") +
      color.gray(`  (${report.okCount}/${report.checked} valid)\n`) +
      color.gray(
        `Pinned keys: ${report.trustedKeyCount ?? 0} from ${report.trustStorePath ?? "caller configuration"}\n\n`,
      ),
  );
  for (const item of report.items) {
    if (item.status === "ok") {
      process.stdout.write(
        color.green("  ✓ ") + item.id + color.gray(`  signed (${item.kid})\n`),
      );
    } else {
      process.stdout.write(
        color.red(`  ✗ ${item.id}`) + color.gray(`  [${item.file}] — ${item.detail}\n`),
      );
    }
  }
  if (report.ok) {
    process.stdout.write(color.green("\nAll official commands verify against pinned keys.\n"));
  } else {
    process.stdout.write(
      color.red(`\n${report.failures} official command(s) failed verification.\n`) +
        color.gray(
          "  A legacy, tampered, unsigned, or unpinned official def is untrusted.\n" +
            "  Re-promote legacy entries and pin the signer out-of-band before use.\n",
        ),
    );
  }
}

async function readDefs(path: string): Promise<CommandDef[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read official defs ${path}: ${(error as Error).message}`);
  }
  if (Array.isArray(parsed)) return parsed as CommandDef[];
  if (parsed && typeof parsed === "object") return [parsed as CommandDef];
  throw new Error(`invalid official defs ${path}: expected an object or array`);
}

type ManifestRead =
  | { kind: "missing" }
  | { kind: "invalid"; detail: string }
  | { kind: "current"; entries: unknown[] };

async function readManifest(path: string): Promise<ManifestRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new Error(`cannot read manifest ${path}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "invalid", detail: "malformed signature manifest" };
  }
  const candidate = parsed as { manifestVersion?: unknown; entries?: unknown };
  if (candidate.manifestVersion !== REGISTRY_MANIFEST_VERSION) {
    const version = String(candidate.manifestVersion ?? "missing");
    return {
      kind: "invalid",
      detail: `unsupported manifest version ${version}; version 1 is unanchored and must be re-promoted`,
    };
  }
  if (!Array.isArray(candidate.entries)) {
    return { kind: "invalid", detail: "malformed signature manifest entries" };
  }
  return { kind: "current", entries: candidate.entries };
}
