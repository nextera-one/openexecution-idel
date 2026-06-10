import { createInterface } from "node:readline";

import { IdelAgent, type AgentEvent } from "@openexecution/agent";
import { TerminalService } from "@openexecution/server";
import type { Runtime } from "@openexecution/runtime";

import { color, render } from "./render.js";

/**
 * `idel ask "<intent>"` and the REPL's `?` prefix — the Claude console embedded
 * in the terminal. Natural language goes to the agent, which proposes IDEL
 * commands; each one runs through the same runtime pipeline as a typed command,
 * so safety/policy/OpenLogs are identical and AI-run commands are audited as
 * `source: "agent"`. The Anthropic key stays in this process.
 *
 * `confirmReal` controls whether a proposed command may run for real after the
 * dry run. The CLI prompts the human (readline); declining leaves the dry-run
 * result standing. The agent never auto-approves.
 */
export async function ask(
  runtime: Runtime,
  intent: string,
  opts: { cwd: string; environment?: string; noNative?: boolean; allowReal: boolean },
): Promise<number> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    process.stderr.write(
      color.red("ANTHROPIC_API_KEY is not set. ") +
        color.gray("Export it to use `idel ask`.\n"),
    );
    return 2;
  }

  const service = new TerminalService({
    runtime,
    cwd: opts.cwd,
    environment: opts.environment,
    noNative: opts.noNative,
  });

  const agent = new IdelAgent({
    service,
    // Only wire a real-run gate when the user opted in (--yes). Otherwise the
    // agent stays in propose/dry-run-only mode and nothing touches disk.
    approve: opts.allowReal
      ? async ({ command }) => promptYesNo(`Run for real: ${command}?`)
      : undefined,
  });

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
