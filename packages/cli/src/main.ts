import { hostname, userInfo, platform, homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { splitBatch } from "@openexecution/parser";
import { Runtime } from "@openexecution/runtime";
import { OpenLogWriter } from "@openexecution/openlogs";
import { loadPolicy, defaultPolicy } from "@openexecution/policy";
import { startServer, type TerminalService } from "@openexecution/server";
import { IdelAgent, IdelCliAgent, detectProvider } from "@openexecution/agent";
import type { PolicyConfig, RuntimeContext, RuntimeOutcome } from "@openexecution/runtime";

import { parseArgv, type CliFlags } from "./argv.js";
import { complete } from "./complete.js";
import { color, render, renderJson } from "./render.js";
import { startTerminal } from "./terminal.js";
import { connectTerminal } from "./connect.js";
import { ask } from "./ask.js";
import { ASK_AI_USAGE, askAiIntent, isAskAiCommand } from "./ask-ai.js";
import { learn, learnForHost } from "./learn.js";
import { promote } from "./promote.js";
import {
  loadTrustedRegistryKeys,
  registryTrustStorePath,
  verifyRegistry,
  verifyOfficialLayer,
} from "./registry-verify.js";
import { parseLearnCommand } from "./learn-command.js";
import { runFunction, verifyExecution } from "./function-command.js";
import { HELP_TEXT, VERSION } from "./help.js";

/** Process entry point. Returns the desired process exit code. */
export async function main(argv: string[]): Promise<number> {
  let inv;
  try {
    inv = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  if (inv.mode === "help") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (inv.mode === "version") {
    process.stdout.write(`idel ${VERSION}\n`);
    return 0;
  }

  // `idel learn <cli>` introspects an installed CLI and drafts IDEL defs. It
  // needs no runtime/policy/registry of its own (it only writes the draft
  // layer), so handle it before building the runtime.
  if (inv.mode === "learn") {
    return learn(inv.command, {
      write: inv.flags.write ?? false,
      json: inv.flags.json,
    });
  }

  if (inv.mode === "connect") {
    return connectTerminal(inv.command);
  }

  // `idel run.function` / `idel verify.execution` — the Phase 1 function
  // runtime. It has its own admission chain (nonce, expiry, digest,
  // capabilities) and capability-scoped handles, so it does not build the
  // command runtime, policy, or registry.
  if (inv.mode === "function") {
    const [verb, ...restParts] = inv.command.split(/\s+/);
    const target = restParts.join(" ").replace(/^path=/, "").trim();
    if (!target) {
      process.stderr.write(
        `Usage: idel ${verb} <file>   (${
          verb === "run.function" ? "a *.run.idel request" : "a rendered receipt"
        })\n`,
      );
      return 2;
    }
    const options = {
      json: inv.flags.json,
      ...(inv.flags.functionRoot ? { root: inv.flags.functionRoot } : {}),
      ...(inv.flags.receiptPath ? { receiptPath: inv.flags.receiptPath } : {}),
      ...(inv.flags.dryRun ? { dryRun: true } : {}),
    };
    return verb === "run.function"
      ? runFunction(target, options)
      : verifyExecution(target, options);
  }

  // `idel promote <cli>` moves reviewed learned drafts up to the signed official
  // layer. Like learn, it builds its own ephemeral runtime for re-verification
  // and writes the registry layers directly — no shared runtime/policy needed.
  if (inv.mode === "promote") {
    return promote(inv.command, {
      yes: inv.flags.yes,
      json: inv.flags.json,
    });
  }

  // `idel registry <subcommand>` — registry-layer maintenance.
  if (inv.mode === "registry") {
    const sub = inv.command.split(/\s+/)[0] ?? "";
    if (sub === "verify") {
      return verifyRegistry({ json: inv.flags.json });
    }
    process.stderr.write(
      color.gray(`Usage: idel registry verify   (check signed official-layer commands)\n`),
    );
    return 2;
  }

  let policy: PolicyConfig;
  try {
    policy = await resolvePolicy(inv.flags);
  } catch (err) {
    // Fail closed: a broken policy file must not silently widen permissions.
    process.stderr.write(color.red(`${(err as Error).message}\n`));
    return 2;
  }
  // Auto-discover user registry layers (spec §15). custom > official > core.
  // The official layer is the trusted one, so it is signature-checked before it
  // is loaded: a tampered or unsigned official def causes the WHOLE official
  // layer to be dropped (fail-closed) with a stderr warning, rather than letting
  // an untrusted "trusted" def in. The custom (draft) layer is not signed by
  // design and loads as-is.
  const registryDirs = userRegistryDirs();
  const officialDir = await trustedOfficialDir(registryDirs.official);
  const runtime = await Runtime.withCore({
    policy,
    officialDir,
    customDir: registryDirs.custom,
    logWriter: new OpenLogWriter({}),
    // Interactive approval only when not in CI and the user passed --yes is NOT
    // a blanket bypass: --yes still cannot clear CRITICAL (the policy floor
    // handles that). Here --yes simply auto-approves approval_required prompts.
    onApproval: inv.flags.ci
      ? undefined
      : async ({ risk }) => inv.flags.yes && risk !== "CRITICAL",
  });

  if (inv.mode === "completion") {
    const suggestions = complete(inv.command, runtime.reg, process.cwd());
    process.stdout.write(suggestions.join("\n") + (suggestions.length ? "\n" : ""));
    return 0;
  }

  if (inv.mode === "terminal") {
    return startTerminal(runtime, makeContext(inv.flags), {
      autoApprove: inv.flags.yes,
    });
  }

  if (inv.mode === "serve") {
    return serve(runtime, inv.flags);
  }

  if (inv.mode === "ask") {
    if (!inv.command.trim()) {
      process.stderr.write(
        color.gray('Usage: idel ask "<what you want to do>"  (add --yes to allow real runs)\n'),
      );
      return 2;
    }
    return ask(runtime, inv.command, {
      cwd: process.cwd(),
      environment: inv.flags.environment,
      noNative: inv.flags.noNative,
      // --yes lets a confirmed command run for real (still prompted per-command);
      // without it the agent stays propose/dry-run only.
      allowReal: inv.flags.yes,
    });
  }

  // run mode
  if (!inv.command.trim()) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (!inv.native) {
    let commands: string[];
    try {
      commands = splitBatch(inv.command);
    } catch (err) {
      process.stderr.write(color.red(`${(err as Error).message}\n`));
      return 2;
    }
    if (commands.length > 1) {
      return runBatch(runtime, commands, makeContext(inv.flags), inv.flags.json);
    }
  }

  if (!inv.native && isAskAiCommand(inv.command)) {
    const intent = askAiIntent(inv.command);
    if (!intent) {
      process.stderr.write(
        color.gray(`Usage: idel ${ASK_AI_USAGE}  (add --yes to allow real runs)\n`),
      );
      return 2;
    }
    return ask(runtime, intent, {
      cwd: process.cwd(),
      environment: inv.flags.environment,
      noNative: inv.flags.noNative,
      allowReal: inv.flags.yes,
    });
  }

  if (!inv.native) {
    const learned = parseLearnCommand(inv.command);
    if (learned) {
      return learn(learned.cli, {
        write: learned.write,
        json: inv.flags.json,
      });
    }
  }

  const ctx = makeContext(inv.flags);
  const line = inv.native ? `! ${inv.command}` : inv.command;
  const outcome = await runtime.run(line, ctx);

  if (inv.flags.json) {
    process.stdout.write(renderJson(outcome) + "\n");
  } else {
    process.stdout.write(render(outcome) + "\n");
  }

  return exitCodeFor(outcome);
}

async function runBatch(
  runtime: Runtime,
  commands: string[],
  ctx: RuntimeContext,
  json: boolean,
): Promise<number> {
  const outcomes: RuntimeOutcome[] = [];
  let exitCode = 0;
  let stoppedAt: number | undefined;

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    if (!json) {
      process.stdout.write(color.gray(`Batch ${i + 1}/${commands.length}: ${command}\n`));
    }
    const outcome = await runtime.run(command, ctx);
    outcomes.push(outcome);
    if (!json) process.stdout.write(render(outcome) + "\n");
    if (!batchStepSucceeded(outcome, ctx.dryRun === true)) {
      exitCode = exitCodeFor(outcome);
      stoppedAt = i + 1;
      if (!json && i + 1 < commands.length) {
        process.stdout.write(color.yellow(`Batch stopped at step ${i + 1}; ${commands.length - i - 1} step(s) skipped.\n`));
      }
      break;
    }
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          batch: true,
          commands,
          stoppedAt,
          ok: stoppedAt === undefined,
          outcomes: outcomes.map((outcome) => JSON.parse(renderJson(outcome))),
        },
        null,
        2,
      ) + "\n",
    );
  }

  return exitCode;
}

/**
 * `idel serve` — start the local HTTP server that backs the web/desktop
 * terminal. Binds loopback only by default. Blocks until interrupted (Ctrl-C),
 * which the runtime maps to exit code 0. The same runtime instance (registry,
 * policy, OpenLogs) backs every request, so a GUI command is audited identically
 * to a CLI command.
 */
async function serve(runtime: Runtime, flags: CliFlags): Promise<number> {
  // Pick how the embedded AI console reaches Claude: the user's Pro/Max
  // SUBSCRIPTION via the installed `claude` CLI (preferred), else the API key.
  // Detected once at startup so the (synchronous) agent factory can build the
  // matching agent per request. The hosted agent can run for real, but only
  // behind the browser approval round-trip (`allowReal` + POST
  // /api/agent/approve) — it never touches disk without an explicit "Approve."
  const provider = await detectProvider();
  const registryDirs = userRegistryDirs();
  const agentFactory =
    provider === "cli"
      ? (service: TerminalService) => new IdelCliAgent({ service })
      : provider === "api"
        ? (service: TerminalService) => new IdelAgent({ service })
        : undefined;
  // Native PTYs bypass command-level IDEL policy, so even a loopback server
  // gives them a separate high-entropy bearer. Operators automating API access
  // can pin it through the environment; otherwise it is generated in memory,
  // injected only into the no-store same-origin terminal page, and never logged.
  const nativeTerminalAuthToken = flags.enableNativeTerminal
    ? process.env.IDEL_NATIVE_TERMINAL_AUTH_TOKEN || randomBytes(32).toString("base64url")
    : undefined;

  const server = await startServer({
    runtime,
    port: flags.port,
    host: flags.host,
    staticDir: flags.staticDir,
    environment: flags.environment,
    noNative: flags.noNative,
    allowNativeTerminal: flags.enableNativeTerminal,
    nativeTerminalAuthToken,
    agent: agentFactory,
    learn: async (req) => {
      const result = await learnForHost(req.cli ?? "", { write: req.write === true });
      if (result.path) await runtime.reg.loadLayer(registryDirs.custom, "custom");
      return result;
    },
  });

  process.stdout.write(
    color.bold("IDEL Server") +
      color.gray(`  —  listening on `) +
      color.blue(server.url) +
      "\n",
  );
  const claudeNote =
    provider === "cli"
      ? "(AI console enabled — your subscription, via the claude CLI)\n"
      : provider === "api"
        ? "(AI console enabled — Anthropic API)\n"
        : "(disabled — install Claude Code + `claude login`, or set ANTHROPIC_API_KEY)\n";
  process.stdout.write(
    color.gray(
      `  API:  ${server.url}/api/health · /api/registry · /api/run · /api/complete · /api/logs\n` +
        `  Ask:  ${server.url}/api/agent/stream  ` +
        claudeNote +
        (flags.staticDir
          ? `  UI:   serving ${flags.staticDir} at ${server.url}/\n`
          : `  UI:   none (pass --static <dir> to serve a built terminal UI)\n`) +
        `  Stop: Ctrl-C\n`,
    ),
  );

  // Keep the process alive until a termination signal, then close cleanly.
  return await new Promise<number>((resolveServe) => {
    const shutdown = () => {
      void server.close().finally(() => resolveServe(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function userRegistryDirs(): { official: string; custom: string } {
  const idelHome = join(homedir(), ".idel", "registries");
  return {
    official: join(idelHome, "official"),
    custom: join(idelHome, "custom"),
  };
}

/**
 * Verify the signed official layer before it is trusted at load time. Returns
 * the dir to load if everything verifies (or the layer is empty/absent), or
 * `undefined` to skip loading the official layer entirely when ANY def fails —
 * a tampered "trusted" layer is dropped wholesale (fail-closed), not partially
 * honored. Verification failures are surfaced on stderr; `idel registry verify`
 * gives the full report.
 */
async function trustedOfficialDir(dir: string): Promise<string | undefined> {
  let report;
  try {
    // Trust is supplied by independent configuration. A missing trust store is
    // an empty pin set, never an instruction to trust keys found in manifests.
    const trustedKeys = await loadTrustedRegistryKeys(registryTrustStorePath());
    report = await verifyOfficialLayer(dir, trustedKeys);
  } catch {
    // A verification error (unreadable manifest, malformed file) is itself a
    // reason not to trust the layer.
    process.stderr.write(
      color.yellow(
        `warning: could not verify the official registry layer at ${dir}; ` +
          `skipping it. Run \`idel registry verify\` for details.\n`,
      ),
    );
    return undefined;
  }
  if (report.checked === 0) return dir; // nothing signed to distrust
  if (report.ok) return dir;
  process.stderr.write(
    color.yellow(
      `warning: ${report.failures} official command(s) failed signature verification — ` +
        `the official layer is NOT loaded. Run \`idel registry verify\` for details.\n`,
    ),
  );
  return undefined;
}

function makeContext(flags: CliFlags): RuntimeContext {
  const ui = safeUserInfo();
  return {
    cwd: process.cwd(),
    user: ui.username,
    host: hostname(),
    os: platform(),
    sessionId: `sess_${process.pid}`,
    environment: flags.environment,
    ci: flags.ci,
    dryRun: flags.dryRun,
    noNative: flags.noNative,
    interactive: !flags.ci && process.stdin.isTTY === true && process.stdout.isTTY === true,
  };
}

function safeUserInfo(): { username: string } {
  try {
    return { username: userInfo().username };
  } catch {
    return { username: "unknown" };
  }
}

/**
 * Load the policy named by --policy, or the built-in default.
 *
 * A FAILED `--policy` load is a hard error, never a silent fallback. Quietly
 * dropping to the default policy could *widen* what is permitted — the exact
 * failure mode this product exists to prevent. The caller treats a thrown
 * PolicyLoadError as a fatal exit before any command runs.
 */
class PolicyLoadError extends Error {}

async function resolvePolicy(flags: CliFlags): Promise<PolicyConfig> {
  if (!flags.policyPath) return defaultPolicy();
  let text: string;
  try {
    text = await readFile(flags.policyPath, "utf8");
  } catch (err) {
    throw new PolicyLoadError(
      `Could not read policy file ${flags.policyPath}: ${(err as Error).message}`,
    );
  }
  try {
    return loadPolicy(text);
  } catch (err) {
    throw new PolicyLoadError(
      `Invalid policy file ${flags.policyPath}: ${(err as Error).message}`,
    );
  }
}

/**
 * Map a runtime outcome to a process exit code:
 *   success / dry_run        → 0
 *   blocked / approval / fail → non-zero (so CI fails closed)
 */
function exitCodeFor(outcome: RuntimeOutcome): number {
  switch (outcome.record.result) {
    case "success":
    case "dry_run":
      return 0;
    case "approval_required":
      return 3;
    case "blocked_before_execution":
      return 4;
    case "failed":
    default:
      return 1;
  }
}

function batchStepSucceeded(outcome: RuntimeOutcome, explicitDryRun = false): boolean {
  return outcome.record.result === "success" || (explicitDryRun && outcome.record.result === "dry_run");
}
