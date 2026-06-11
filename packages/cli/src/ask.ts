import { createInterface } from "node:readline";

import { createAgent, type AgentEvent } from "@openexecution/agent";
import { TerminalService } from "@openexecution/server";
import type { Runtime } from "@openexecution/runtime";

import { color, render } from "./render.js";

/**
 * `idel ask "<intent>"` and the REPL's `?` prefix — the Claude console embedded
 * in the terminal. Natural language goes to the agent, which proposes IDEL
 * commands; each one runs through the same runtime pipeline as a typed command,
 * so safety/policy/OpenLogs are identical and AI-run commands are audited as
 * `source: "agent"`. The Claude credential stays in this process.
 *
 * Claude is reached via the user's SUBSCRIPTION (the installed `claude` CLI,
 * preferred) or the ANTHROPIC_API_KEY (fallback) — {@link createAgent} picks.
 *
 * `allowReal` controls whether a proposed command may run for real after the
 * dry run. The CLI prompts the human (readline); declining leaves the dry-run
 * result standing. The agent never auto-approves.
 */
export async function ask(
  runtime: Runtime,
  intent: string,
  opts: { cwd: string; environment?: string; noNative?: boolean; allowReal: boolean },
): Promise<number> {
  const service = new TerminalService({
    runtime,
    cwd: opts.cwd,
    environment: opts.environment,
    noNative: opts.noNative,
  });

  const selection = await createAgent({
    service,
    // Only wire a real-run gate when the user opted in (--yes). Otherwise the
    // agent stays in propose/dry-run-only mode and nothing touches disk.
    approve: opts.allowReal
      ? async ({ command }) => promptYesNo(`Run for real: ${command}?`)
      : undefined,
  });
  if (!selection) {
    process.stderr.write(noClaudeMessage());
    return 2;
  }
  process.stderr.write(
    color.gray(
      selection.kind === "cli"
        ? "Using your Claude subscription (claude CLI).\n"
        : "Using the Anthropic API (ANTHROPIC_API_KEY).\n",
    ),
  );
  const agent = selection.agent;

  let exitCode = 0;
  // The model decides dryRun per call; when --yes is passed we also let it ask
  // for a real run. We surface that by telling the agent, via the system prompt
  // contract, to dry-run first — the loop enforces classify-before-execute.
  const intentLine = opts.allowReal
    ? intent
    : `${intent}\n\n(Propose and dry-run only — do not request a real execution.)`;

  try {
    for await (const ev of agent.ask(intentLine)) {
      exitCode = renderEvent(ev) ?? exitCode;
    }
  } catch (err) {
    process.stderr.write(color.red(`Agent error: ${(err as Error).message}\n`));
    return 1;
  }
  return exitCode;
}

/** Render one agent event to stdout. Returns a suggested exit code, if any. */
export function renderEvent(ev: AgentEvent): number | undefined {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text.replace(/\n*$/, "") + "\n");
      return undefined;
    case "proposed":
      process.stdout.write(
        color.gray(ev.dryRun ? "↳ proposed (dry-run):\n" : "↳ ran:\n") +
          render(ev.outcome) +
          "\n",
      );
      return undefined;
    case "blocked":
      process.stdout.write(
        color.red("↳ BLOCKED:\n") + render(ev.outcome) + "\n",
      );
      return 4;
    case "needs_approval":
      process.stdout.write(color.yellow(`↳ declined: ${ev.command}\n`));
      return undefined;
    case "tool_error":
      process.stdout.write(color.red(`↳ tool error (${ev.tool}): ${ev.message}\n`));
      return undefined;
    case "error":
      process.stderr.write(color.red(`Error: ${ev.message}\n`));
      return 1;
    case "done":
      return undefined;
  }
}

/** One-shot y/N readline prompt. */
function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolveP) => {
    rl.question(color.yellow(`${question} [y/N] `), (answer) => {
      rl.close();
      resolveP(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Guidance shown when neither the claude CLI nor an API key is available. */
export function noClaudeMessage(): string {
  return (
    color.red("Claude is not available. ") +
    color.gray(
      "To use `idel ask` / `?`, either:\n" +
        "  • install Claude Code and run `claude login` (uses your Pro/Max subscription), or\n" +
        "  • set ANTHROPIC_API_KEY (uses the pay-per-token API).\n",
    )
  );
}
