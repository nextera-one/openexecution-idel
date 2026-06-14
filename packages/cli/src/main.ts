import { hostname, userInfo, platform, homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
import { ask } from "./ask.js";
import { learn } from "./learn.js";
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

  let policy: PolicyConfig;
  try {
    policy = await resolvePolicy(inv.flags);
  } catch (err) {
    // Fail closed: a broken policy file must not silently widen permissions.
    process.stderr.write(color.red(`${(err as Error).message}\n`));
    return 2;
  }
  // Auto-discover user registry layers (spec §15). custom > official > core.
  const idelHome = join(homedir(), ".idel", "registries");
  const runtime = await Runtime.withCore({
    policy,
    officialDir: join(idelHome, "official"),
    customDir: join(idelHome, "custom"),
    logWriter: new OpenLogWriter({}),
    // Interactive approval only when not in CI and the user passed --yes is NOT
    // a blanket bypass: --yes still cannot clear CRITICAL (the policy floor
    // handles that). Here --yes simply auto-approves approval_required prompts.
    onApproval: inv.flags.ci
      ? undefined
      : async () => inv.flags.yes,
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

/**
 * `idel serve` — start the local HTTP server that backs the web/desktop
 * terminal. Binds loopback only by default. Blocks until interrupted (Ctrl-C),
 * which the runtime maps to exit code 0. The same runtime instance (registry,
 * policy, OpenLogs) backs every request, so a GUI command is audited identically
 * to a CLI command.
 */
async function serve(runtime: Runtime, flags: CliFlags): Promise<number> {
  // Pick how the embedded Claude console reaches Claude: the user's Pro/Max
  // SUBSCRIPTION via the installed `claude` CLI (preferred), else the API key.
  // Detected once at startup so the (synchronous) agent factory can build the
  // matching agent per request. The hosted agent can run for real, but only
  // behind the browser approval round-trip (`allowReal` + POST
  // /api/agent/approve) — it never touches disk without an explicit "Approve."
  const provider = await detectProvider();
  const agentFactory =
    provider === "cli"
      ? (service: TerminalService) => new IdelCliAgent({ service })
      : provider === "api"
        ? (service: TerminalService) => new IdelAgent({ service })
        : undefined;

  const server = await startServer({
    runtime,
    port: flags.port,
    host: flags.host,
    staticDir: flags.staticDir,
    environment: flags.environment,
    noNative: flags.noNative,
    agent: agentFactory,
  });

  process.stdout.write(
    color.bold("IDEL Server") +
      color.gray(`  —  listening on `) +
      color.blue(server.url) +
      "\n",
  );
  const claudeNote =
    provider === "cli"
      ? "(Claude console enabled — your subscription, via the claude CLI)\n"
      : provider === "api"
        ? "(Claude console enabled — Anthropic API)\n"
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
