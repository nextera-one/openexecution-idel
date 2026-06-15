import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandDef } from "@openexecution/types";

import { promote } from "./promote.js";
import { verifyRegistry, verifyOfficialLayer } from "./registry-verify.js";

/**
 * End-to-end promote → verify tests against a temp $HOME. `idel promote` and
 * `idel registry verify` resolve their layers under `~/.idel/registries`, and
 * `os.homedir()` honors $HOME on POSIX, so we point HOME at a sandbox per test.
 *
 * These exercise the REAL crypto and the REAL runtime test-replay (verifyDefs
 * builds an ephemeral runtime and dry-runs each def's tests), so they prove the
 * promotion gate end to end, not just the file shuffling.
 */

let home: string;
let customDir: string;
let officialDir: string;
const origHome = process.env["HOME"];
const origUserProfile = process.env["USERPROFILE"];

// A schema-valid, correctly-classified draft (a LOW gh status command whose
// declared test matches what the runtime will classify it as).
function goodDraft(): CommandDef {
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
        semanticNotes: "Read-only auth status.",
      },
    },
    examples: ["show.gh.status"],
    tests: [{ input: "show.gh.status", expectRisk: "LOW" }],
  };
}

// A draft whose declared test LIES about its risk: it claims LOW but asserts
// CRITICAL, so the runtime replay will reject it.
function misclassifyingDraft(): CommandDef {
  return {
    id: "list.gh.repo",
    version: "0.1.0",
    summary: "List gh repos.",
    category: "gh",
    riskDefault: "LOW",
    params: {},
    adapters: {
      posix: {
        command: "gh",
        args: [
          { kind: "literal", value: "repo" },
          { kind: "literal", value: "list" },
        ],
      },
    },
    tests: [{ input: "list.gh.repo", expectRisk: "CRITICAL" }],
  };
}

async function writeDrafts(defs: CommandDef[]): Promise<void> {
  await mkdir(customDir, { recursive: true });
  await writeFile(join(customDir, "learned-gh.json"), JSON.stringify(defs, null, 2) + "\n");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "idel-promote-"));
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  customDir = join(home, ".idel", "registries", "custom");
  officialDir = join(home, ".idel", "registries", "official");
  // Silence the command's stdout/stderr writes during tests.
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (origHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHome;
  if (origUserProfile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUserProfile;
  await rm(home, { recursive: true, force: true });
});

describe("idel promote", () => {
  it("promotes a verified draft: writes signed official files and prunes the custom draft", async () => {
    await writeDrafts([goodDraft()]);

    const code = await promote("gh", { yes: true, json: false });
    expect(code).toBe(0);

    // Official defs + manifest exist.
    const defs = (await readJson(join(officialDir, "promoted-gh.json"))) as CommandDef[];
    expect(defs.map((d) => d.id)).toEqual(["show.gh.status"]);
    // The loader-assigned `source` is not persisted to disk.
    expect(defs[0]).not.toHaveProperty("source");

    const manifest = (await readJson(join(officialDir, "promoted-gh.sig.json"))) as {
      manifestVersion: number;
      entries: { id: string; signature: string; sha256: string; kid: string }[];
    };
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.id).toBe("show.gh.status");
    expect(manifest.entries[0]!.signature).toMatch(/^[0-9a-f]{128}$/);

    // The promoted id was removed from the custom draft file.
    const remaining = (await readJson(join(customDir, "learned-gh.json"))) as CommandDef[];
    expect(remaining).toEqual([]);
  });

  it("verifies the freshly-promoted official layer", async () => {
    await writeDrafts([goodDraft()]);
    await promote("gh", { yes: true, json: false });

    const report = await verifyOfficialLayer(officialDir);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.items[0]).toMatchObject({ id: "show.gh.status", status: "ok" });

    // The user-facing command exits 0 too.
    expect(await verifyRegistry({ json: true })).toBe(0);
  });

  it("refuses to promote a draft whose declared tests misclassify (fail-closed)", async () => {
    await writeDrafts([misclassifyingDraft()]);

    const code = await promote("gh", { yes: true, json: false });
    // Nothing eligible → non-zero, and no official files written.
    expect(code).toBe(1);
    await expect(readFile(join(officialDir, "promoted-gh.json"), "utf8")).rejects.toThrow();
  });

  it("promotes only the eligible defs from a mixed batch", async () => {
    await writeDrafts([goodDraft(), misclassifyingDraft()]);

    const code = await promote("gh", { yes: true, json: false });
    expect(code).toBe(0);

    const defs = (await readJson(join(officialDir, "promoted-gh.json"))) as CommandDef[];
    expect(defs.map((d) => d.id)).toEqual(["show.gh.status"]);

    // The misclassifying draft stays in custom (not promoted), the good one left.
    const remaining = (await readJson(join(customDir, "learned-gh.json"))) as CommandDef[];
    expect(remaining.map((d) => d.id)).toEqual(["list.gh.repo"]);
  });

  it("returns 1 when there are no drafts for the CLI", async () => {
    const code = await promote("nonexistent", { yes: true, json: false });
    expect(code).toBe(1);
  });

  it("refuses non-interactive JSON promotion without --yes (fail-closed)", async () => {
    await writeDrafts([goodDraft()]);
    const code = await promote("gh", { yes: false, json: true });
    expect(code).toBe(2);
    await expect(readFile(join(officialDir, "promoted-gh.json"), "utf8")).rejects.toThrow();
  });
});

describe("idel registry verify", () => {
  it("passes (exit 0) when there is no official layer at all", async () => {
    expect(await verifyRegistry({ json: true })).toBe(0);
    const report = await verifyOfficialLayer(officialDir);
    expect(report).toMatchObject({ ok: true, checked: 0 });
  });

  it("fails when an official def is edited after signing (tamper)", async () => {
    await writeDrafts([goodDraft()]);
    await promote("gh", { yes: true, json: false });

    // Tamper: relax the def on disk without re-signing.
    const path = join(officialDir, "promoted-gh.json");
    const defs = (await readJson(path)) as CommandDef[];
    defs[0]!.riskDefault = "CRITICAL";
    await writeFile(path, JSON.stringify(defs, null, 2) + "\n");

    const report = await verifyOfficialLayer(officialDir);
    expect(report.ok).toBe(false);
    expect(report.items[0]).toMatchObject({ id: "show.gh.status", status: "invalid" });
    expect(await verifyRegistry({ json: true })).toBe(1);
  });

  it("fails when an official def has no signature in the manifest (unsigned)", async () => {
    // Hand-drop a def into the official layer with an empty manifest.
    await mkdir(officialDir, { recursive: true });
    await writeFile(
      join(officialDir, "promoted-gh.json"),
      JSON.stringify([goodDraft()], null, 2) + "\n",
    );
    await writeFile(
      join(officialDir, "promoted-gh.sig.json"),
      JSON.stringify({ manifestVersion: 1, entries: [] }, null, 2) + "\n",
    );

    const report = await verifyOfficialLayer(officialDir);
    expect(report.ok).toBe(false);
    expect(report.items[0]).toMatchObject({ status: "unsigned" });
  });

  it("fails when an official def has no manifest file at all", async () => {
    await mkdir(officialDir, { recursive: true });
    await writeFile(
      join(officialDir, "promoted-gh.json"),
      JSON.stringify([goodDraft()], null, 2) + "\n",
    );
    const report = await verifyOfficialLayer(officialDir);
    expect(report.ok).toBe(false);
    expect(report.items[0]).toMatchObject({ status: "unsigned" });
  });
});
