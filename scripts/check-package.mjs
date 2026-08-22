#!/usr/bin/env node
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("check:package must be run through pnpm");

const manifest = JSON.parse(await readFile(resolve(root, "packages/openlogs/package.json"), "utf8"));
const declared = manifest.dependencies?.["@nextera.one/tps-standard"];
if (typeof declared !== "string" || declared.startsWith("file:")) {
  throw new Error("published OpenLogs manifest must not expose a repository-relative TPS dependency");
}

const out = await mkdtemp(join(tmpdir(), "idel-pack-check-"));
try {
  const packed = spawnSync(
    process.execPath,
    [
      pnpmCli,
      "--config.node-linker=hoisted",
      "--filter",
      "@openexecution/openlogs",
      "pack",
      "--pack-destination",
      out,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || "pnpm pack failed");
  const tarball = (await readdir(out)).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack did not create a tarball");
  const listing = spawnSync("tar", ["-tzf", join(out, tarball)], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(listing.stderr || "could not inspect package tarball");
  for (const required of [
    "package/dist/index.js",
    "package/node_modules/@nextera.one/tps-standard/package.json",
    "package/node_modules/@nextera.one/tps-standard/dist/esm/index.js",
  ]) {
    if (!listing.stdout.split(/\r?\n/).includes(required)) {
      throw new Error(`OpenLogs package is missing ${required}`);
    }
  }

  const deployDir = join(out, "deploy");
  const deployed = spawnSync(
    process.execPath,
    [pnpmCli, "--filter", "@openexecution/cli", "deploy", "--prod", deployDir],
    { cwd: root, encoding: "utf8" },
  );
  if (deployed.status !== 0) throw new Error(deployed.stderr || deployed.stdout || "pnpm deploy failed");
  for (const required of [
    join(deployDir, "dist/main.js"),
    join(
      deployDir,
      "node_modules/@openexecution/openlogs/node_modules/@nextera.one/tps-standard/dist/esm/index.js",
    ),
  ]) {
    await access(required);
  }
  process.stdout.write(
    "package check passed: OpenLogs bundles TPS and the CLI deploy artifact is self-contained\n",
  );
} finally {
  await rm(out, { recursive: true, force: true });
}
