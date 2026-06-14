#!/usr/bin/env node
/*
 * Cross-platform smoke test for a freshly built `idel` binary.
 *
 * This intentionally runs the CLI through node packages/cli/bin/idel.js rather
 * than importing source modules. It proves the user-facing entrypoint can:
 *   1. print a version;
 *   2. block the thesis demo before execution;
 *   3. run a harmless command;
 *   4. write and verify a signed OpenLogs chain.
 */

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idel = join(root, "packages", "cli", "bin", "idel.js");
const sandbox = await mkdtemp(join(tmpdir(), "idel-smoke-"));

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

async function run(args) {
  return await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [idel, ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: sandbox,
        USERPROFILE: sandbox,
      },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolveRun({ code: 127, stdout, stderr: stderr + err.message + "\n" });
    });
    child.on("close", (code) => {
      resolveRun({ code: code ?? 0, stdout, stderr });
    });
  });
}

try {
  await access(idel, constants.R_OK).catch(() => {
    fail(`CLI not built (${idel} missing). Run 'pnpm build' first.`);
  });

  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  console.log(`smoke: HOME=${sandbox}`);

  const version = await run(["--version"]);
  const versionText = version.stdout.trim();
  if (version.code !== 0 || !versionText.startsWith("idel ")) {
    fail(`--version did not print a version (code ${version.code}, got: ${JSON.stringify(versionText)})`);
  } else {
    console.log(`smoke: ok ${versionText}`);
  }

  const demo = await run(["remove.folder", "name=/", "recursive=true", "force=true"]);
  await writeDebug("demo.out", demo.stdout + demo.stderr);
  if (demo.code !== 4) {
    fail(`thesis demo exit code was ${demo.code}, expected 4 (BLOCK)`);
  } else if (!/CRITICAL/.test(demo.stdout + demo.stderr)) {
    fail("thesis demo did not classify CRITICAL");
  } else if (!/BLOCK/i.test(demo.stdout + demo.stderr)) {
    fail("thesis demo was not BLOCKED");
  } else {
    console.log("smoke: ok remove.folder name=/ -> CRITICAL -> BLOCKED (exit 4)");
  }

  const ok = await run(["show.path"]);
  await writeDebug("ok.out", ok.stdout + ok.stderr);
  if (ok.code !== 0) {
    fail(`show.path exit code was ${ok.code}, expected 0`);
  } else {
    console.log("smoke: ok show.path -> exit 0");
  }

  const { OpenLogWriter } = await import(
    pathToFileURL(join(root, "packages", "openlogs", "dist", "index.js")).href
  );
  const writer = new OpenLogWriter();
  const verification = await writer.verify();
  if (verification.records < 2) {
    fail(`expected >=2 signed records, got ${verification.records}`);
  } else if (!verification.ok || !verification.integrity.ok || !verification.signatures.ok) {
    fail(
      "chain did not verify: " +
        JSON.stringify({
          ok: verification.ok,
          integrity: verification.integrity.ok,
          signatures: verification.signatures.ok,
        }),
    );
  } else {
    console.log(
      `smoke: ok OpenLogs chain verified (${verification.records} signed records, integrity+signatures OK)`,
    );
  }

  console.log("smoke: ALL CHECKS PASSED");
} catch (err) {
  process.exitCode = 1;
  if (err instanceof SmokeFailure) {
    console.error(`smoke: FAIL - ${err.message}`);
  } else {
    console.error(`smoke: FAIL - ${err?.stack ?? err}`);
  }
  const demoOut = await readFile(join(sandbox, "demo.out"), "utf8").catch(() => "");
  const okOut = await readFile(join(sandbox, "ok.out"), "utf8").catch(() => "");
  if (demoOut) console.error(`smoke: demo.out\n${demoOut}`);
  if (okOut) console.error(`smoke: ok.out\n${okOut}`);
} finally {
  if (process.env.IDEL_SMOKE_KEEP !== "1") {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function writeDebug(name, text) {
  await writeFile(join(sandbox, name), text, "utf8");
}
