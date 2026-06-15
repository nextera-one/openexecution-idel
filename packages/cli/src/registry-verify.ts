import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  verifyDef,
  type SignedRegistryEntry,
  type SignedRegistryManifest,
} from "@openexecution/registry";
import type { CommandDef } from "@openexecution/types";

import { color } from "./render.js";

/**
 * `idel registry verify [--json]` — check the integrity of the signed *official*
 * registry layer.
 *
 * The official layer is the trusted one; `idel promote` signs each def it writes
 * there (Ed25519 over the def's canonical bytes) and records the signature in a
 * sidecar `*.sig.json` manifest. This command reads every official def back and:
 *
 *  - verifies its signature against the manifest (content hash + Ed25519), and
 *  - FAILS CLOSED on an official def that has no signature at all.
 *
 * An unsigned def appearing in the official layer is exactly the thing signing
 * is meant to catch (someone hand-dropped a def into the trusted layer, or
 * edited a promoted one and the bytes no longer match). Such a def is reported
 * and the command exits non-zero. The custom and core layers are intentionally
 * NOT checked: core is the product itself, and custom is the explicitly
 * lower-trust draft layer (it is not signed by design).
 *
 * This does not mutate anything — it only reports. The runtime can apply the
 * same check at load time to refuse a tampered official layer (see Runtime).
 */
export async function verifyRegistry(opts: { json: boolean }): Promise<number> {
  const officialDir = join(homedir(), ".idel", "registries", "official");

  let report: VerifyReport;
  try {
    report = await verifyOfficialLayer(officialDir);
  } catch (err) {
    process.stderr.write(color.red(`registry verify failed: ${(err as Error).message}\n`));
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
  status: "ok" | "unsigned" | "invalid";
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
}

/**
 * Verify every `promoted-*.json` def in `dir` against its `*.sig.json` manifest.
 * Exposed for tests and for the runtime's load-time check.
 */
export async function verifyOfficialLayer(dir: string): Promise<VerifyReport> {
  const items: VerifyItem[] = [];

  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".sig.json"))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No official layer yet is a valid, passing state (nothing to distrust).
      return { ok: true, dir, checked: 0, okCount: 0, failures: 0, items: [] };
    }
    throw err;
  }

  for (const file of files) {
    const defsPath = join(dir, file);
    const manifestPath = join(dir, file.replace(/\.json$/, ".sig.json"));

    const defs = await readDefs(defsPath);
    const manifest = await readManifest(manifestPath);
    const byId = new Map<string, SignedRegistryEntry>();
    if (manifest) {
      for (const e of manifest.entries) byId.set(e.id, e);
    }

    for (const def of defs) {
      const id = typeof def?.id === "string" ? def.id : "<no id>";
      const entry = byId.get(id);
      if (!entry) {
        items.push({
          id,
          file,
          status: "unsigned",
          detail: manifest
            ? "no signature for this id in the manifest"
            : `missing manifest ${file.replace(/\.json$/, ".sig.json")}`,
        });
        continue;
      }
      const result = await verifyDef(def, entry);
      if (result.ok) {
        items.push({ id, file, status: "ok", kid: entry.kid });
      } else {
        items.push({
          id,
          file,
          status: "invalid",
          detail: `${result.reason}: ${result.detail}`,
          kid: entry.kid,
        });
      }
    }
  }

  const okCount = items.filter((i) => i.status === "ok").length;
  const failures = items.length - okCount;
  return {
    ok: failures === 0,
    dir,
    checked: items.length,
    okCount,
    failures,
    items,
  };
}

function renderReport(report: VerifyReport, dir: string): void {
  if (report.checked === 0) {
    process.stdout.write(
      color.gray(`No signed official commands found under ${dir}.\n`) +
        color.gray(`  Promote a learned draft with:  idel promote <cli>\n`),
    );
    return;
  }
  process.stdout.write(
    color.bold("Official registry signatures") +
      color.gray(`  (${report.okCount}/${report.checked} valid)\n\n`),
  );
  for (const item of report.items) {
    if (item.status === "ok") {
      process.stdout.write(
        color.green("  ✓ ") + item.id + color.gray(`  signed (${item.kid})\n`),
      );
    } else {
      process.stdout.write(
        color.red(`  ✗ ${item.id}`) +
          color.gray(`  [${item.file}] — ${item.detail}\n`),
      );
    }
  }
  if (report.ok) {
    process.stdout.write(color.green("\nAll official commands verify.\n"));
  } else {
    process.stdout.write(
      color.red(`\n${report.failures} official command(s) failed verification.\n`) +
        color.gray(
          "  A tampered or unsigned official def is untrusted. Re-promote it from\n" +
            "  a clean draft, or remove it from ~/.idel/registries/official.\n",
        ),
    );
  }
}

async function readDefs(path: string): Promise<CommandDef[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read official defs ${path}: ${(err as Error).message}`);
  }
  if (Array.isArray(parsed)) return parsed as CommandDef[];
  return parsed && typeof parsed === "object" ? [parsed as CommandDef] : [];
}

async function readManifest(path: string): Promise<SignedRegistryManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SignedRegistryManifest;
    if (parsed && Array.isArray(parsed.entries)) return parsed;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read manifest ${path}: ${(err as Error).message}`);
  }
}
