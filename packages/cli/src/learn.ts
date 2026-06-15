import { mkdir, writeFile } from "node:fs/promises";
import { hostname, homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

import { learnCli, type LearnResult, type TestVerification } from "@openexecution/agent";
import { Registry } from "@openexecution/registry";
import { Runtime } from "@openexecution/runtime";
import { defaultPolicy } from "@openexecution/policy";
import type { CommandDef, RuntimeContext } from "@openexecution/types";

import { color } from "./render.js";

export interface LearnHostResponse {
  cli: string;
  write: boolean;
  path?: string;
  accepted: number;
  rejected: number;
  helpExcerpt: string;
  commands: {
    id: string;
    accepted: boolean;
    risk?: CommandDef["riskDefault"];
    summary?: string;
    errors: string[];
    verification?: TestVerification;
  }[];
}

/**
 * `idel learn <cli> [--write] [--json]` — teach IDEL an installed CLI.
 *
 * Introspects the CLI's `--help`, drafts IDEL command definitions locally
 * (optionally using an AI-backed generator when one is explicitly wired),
 * validates each against the registry schema (fail-closed), REPLAYS each def's
 * declared `tests[]` through a real runtime to prove its risk/policy
 * classification, and either previews the results (default) or writes the
 * accepted ones to the custom draft layer (with `--write`).
 *
 * Two gates a learned def must pass to be accepted: (1) schema validation, and
 * (2) every declared test must match the runtime's actual classification. A def
 * whose tests misclassify is shown with its failures but NOT written —
 * schema-valid-but-wrong is still wrong. The drafts are not blindly trusted:
 * once written, they are resolved through the same custom > official > core
 * layering and re-classified by the two-phase safety engine on every run.
 * Learning a destructive tool weakens no floor. Preview-first is deliberate.
 */
export async function learn(
  cli: string,
  opts: { write: boolean; json: boolean },
): Promise<number> {
  if (!cli) {
    process.stderr.write(
      color.gray('Usage: idel learn <cli> [--write]   e.g. `idel learn gh`\n'),
    );
    return 2;
  }

  let result: LearnResult;
  try {
    process.stderr.write(color.gray(`Introspecting "${cli}" and drafting IDEL commands…\n`));
    result = await runLearn(cli);
  } catch (err) {
    process.stderr.write(color.red(`learn failed: ${(err as Error).message}\n`));
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.accepted.length ? 0 : 1;
  }

  renderResult(result);

  if (!result.accepted.length) {
    process.stdout.write(color.yellow("\nNothing valid to learn — no defs written.\n"));
    return 1;
  }

  if (!opts.write) {
    process.stdout.write(
      color.gray(
        `\nPreview only. Re-run with --write to save ${result.accepted.length} command(s) to the draft layer.\n`,
      ),
    );
    return 0;
  }

  const path = await writeDraft(cli, result);
  process.stdout.write(
    color.green(`\n✓ wrote ${result.accepted.length} learned command(s) `) +
      color.gray(`to ${path}\n`) +
      color.gray(
        `  They are now draft (custom) commands. Inspect one with:\n` +
          `    idel explain.registry command=${result.accepted[0]!.id}\n`,
      ),
  );
  return 0;
}

export async function learnForHost(
  cli: string,
  opts: { write: boolean },
): Promise<LearnHostResponse> {
  if (!cli.trim()) throw new Error(`Usage: ${"idel learn <cli>"} [--write]`);
  const result = await runLearn(cli.trim());
  let path: string | undefined;
  if (opts.write && result.accepted.length) {
    path = await writeDraft(cli.trim(), result);
  }
  return toHostResponse(result, opts.write, path);
}

async function runLearn(cli: string): Promise<LearnResult> {
  return await learnCli(cli, { verify: verifyDefs });
}

function toHostResponse(
  result: LearnResult,
  write: boolean,
  path: string | undefined,
): LearnHostResponse {
  return {
    cli: result.cli,
    write,
    ...(path ? { path } : {}),
    accepted: result.accepted.length,
    rejected: result.commands.length - result.accepted.length,
    helpExcerpt: result.helpExcerpt,
    commands: result.commands.map((cmd) => ({
      id: cmd.id,
      accepted: Boolean(cmd.def) && !cmd.verification?.failures.length,
      ...(cmd.def
        ? {
            risk: cmd.def.riskDefault,
            summary: cmd.def.summary,
          }
        : {}),
      errors: cmd.errors,
      ...(cmd.verification ? { verification: cmd.verification } : {}),
    })),
  };
}

/** Pretty-print accepted + rejected proposals, including test-replay status. */
function renderResult(result: LearnResult): void {
  const rejected = result.commands.length - result.accepted.length;
  process.stdout.write(
    color.bold(`Learned ${result.cli}`) +
      color.gray(`  (${result.accepted.length} accepted, ${rejected} rejected)\n\n`),
  );
  for (const cmd of result.commands) {
    if (!cmd.def) {
      process.stdout.write(
        color.red("  ✗ ") + cmd.id + color.gray(`  — ${cmd.errors.join("; ")}\n`),
      );
      continue;
    }
    const riskColor =
      cmd.def.riskDefault === "CRITICAL" || cmd.def.riskDefault === "HIGH"
        ? color.red
        : color.gray;
    const v = cmd.verification;
    const testsFailed = v && v.failures.length > 0;
    const mark = testsFailed ? color.red("  ✗ ") : color.green("  ✓ ");
    const testNote = v
      ? v.ran === 0
        ? color.gray(" (no tests)")
        : testsFailed
          ? color.red(` (tests ${v.passed}/${v.ran} — rejected)`)
          : color.green(` (tests ${v.passed}/${v.ran} ✓)`)
      : "";
    process.stdout.write(
      mark +
        cmd.def.id +
        riskColor(`  [${cmd.def.riskDefault}]`) +
        testNote +
        color.gray(`  ${cmd.def.summary}\n`),
    );
    if (testsFailed) {
      for (const f of v!.failures) {
        process.stdout.write(color.red(`      · ${f}\n`));
      }
    }
  }
}

/**
 * Verify learned defs by replaying their declared `tests[]` through a REAL
 * runtime. Builds an ephemeral runtime with the learned defs loaded as a custom
 * layer (over core), then dry-runs each test input and compares the actual
 * risk/policy to the declared expectation. No filesystem writes happen — every
 * replay is a dry run — and there is no log writer, so this never touches the
 * audit trail.
 *
 * Returns one {@link TestVerification} per def id. A def with no tests reports
 * `{ ran: 0 }` and is accepted (the model just didn't assert anything to check).
 */
export async function verifyDefs(
  defs: CommandDef[],
): Promise<Record<string, TestVerification>> {
  const registry = await Registry.loadCore();
  // Load the learned defs as a custom layer so their adapters resolve and the
  // safety/policy engine classifies them exactly as it would post-write.
  registry.addLayer("custom", defs);
  const runtime = new Runtime({ registry, policy: defaultPolicy() });

  const out: Record<string, TestVerification> = {};
  for (const def of defs) {
    const tests = def.tests ?? [];
    const result: TestVerification = { ran: 0, passed: 0, failures: [] };
    for (const t of tests) {
      result.ran++;
      let actualRisk: string;
      let actualPolicy: string;
      try {
        const outcome = await runtime.run(t.input, verifyContext());
        actualRisk = outcome.risk.level;
        actualPolicy = outcome.decision.action;
      } catch (err) {
        result.failures.push(`"${t.input}" threw: ${(err as Error).message}`);
        continue;
      }
      let ok = true;
      if (t.expectRisk && t.expectRisk !== actualRisk) {
        ok = false;
        result.failures.push(
          `"${t.input}" expected risk ${t.expectRisk}, runtime classified ${actualRisk}`,
        );
      }
      if (t.expectPolicy && t.expectPolicy !== actualPolicy) {
        ok = false;
        result.failures.push(
          `"${t.input}" expected policy ${t.expectPolicy}, runtime decided ${actualPolicy}`,
        );
      }
      if (ok) result.passed++;
    }
    out[def.id] = result;
  }
  return out;
}

/** A dry-run context for test replay — no real execution, no log writer. */
function verifyContext(): RuntimeContext {
  let username = "learn";
  try {
    username = userInfo().username;
  } catch {
    /* keep default */
  }
  return {
    cwd: process.cwd(),
    user: username,
    host: hostname(),
    os: platform(),
    sessionId: `learn_${process.pid}`,
    dryRun: true, // never execute a learned command for real during verification
  };
}

/**
 * Write accepted defs as one JSON file in the custom draft layer. The runtime
 * auto-discovers `~/.idel/registries/custom` as a custom layer (see
 * Runtime.withCore), and the loader reads every `*.json` directly in that
 * directory — so the file lands there, namespaced `learned-<cli>.json` to keep
 * learned drafts visually distinct from hand-authored custom defs.
 */
async function writeDraft(cli: string, result: LearnResult): Promise<string> {
  const dir = join(homedir(), ".idel", "registries", "custom");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `learned-${cli}.json`);
  await writeFile(path, JSON.stringify(result.accepted, null, 2) + "\n", "utf8");
  return path;
}
