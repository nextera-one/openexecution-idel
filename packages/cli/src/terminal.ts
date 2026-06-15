import { createInterface, type Interface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAgent, type AgentLike } from "@openexecution/agent";
import { TerminalService } from "@openexecution/server";
import { splitBatch } from "@openexecution/parser";
import type { Runtime } from "@openexecution/runtime";
import type { RuntimeContext, RuntimeOutcome } from "@openexecution/runtime";

import { complete, completionFragment } from "./complete.js";
import { render, translateLine } from "./render.js";
import { color } from "./render.js";
import { renderEvent, noClaudeMessage } from "./ask.js";
import { ASK_AI_USAGE, askAiIntent, isAskAiCommand } from "./ask-ai.js";
import { learn } from "./learn.js";
import { LEARN_USAGE, parseLearnCommand } from "./learn-command.js";

/**
 * Interactive IDEL terminal (spec §24, `idel terminal`). A thin readline REPL
 * with registry-driven TAB completion. Each line goes through the full runtime
 * pipeline, so the same safety/policy/logging applies as in one-shot mode.
 */
export async function startTerminal(
  runtime: Runtime,
  baseCtx: RuntimeContext,
  opts: { autoApprove?: boolean } = {},
): Promise<number> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: color.blue("idel> "),
    completer: (line: string): [string[], string] => {
      const suggestions = complete(line, runtime.reg, process.cwd());
      return [suggestions, completionFragment(line)];
    },
  });

  runtime.setApprovalHandler(async ({ command, risk, reason, approvers }) => {
    if (opts.autoApprove) return true;
    const approverText = approvers?.length
      ? ` approvers: ${approvers.join(", ")}.`
      : "";
    return promptYesNo(
      rl,
      `Policy requires approval for ${command} (${risk}): ${reason}.${approverText} Run for real?`,
    );
  });

  // The agent (Claude console) is built lazily on first `?` use, so the absence
  // of both a claude CLI and an API key only matters if you actually ask. It
  // shares one TerminalService over this runtime, so agent-run commands are
  // audited identically (source: "agent") to typed ones. Claude is reached via
  // the user's subscription (claude CLI) or ANTHROPIC_API_KEY — createAgent picks.
  let agent: AgentLike | undefined;
  let agentChecked = false;
  const getAgent = async (): Promise<AgentLike | undefined> => {
    if (agent) return agent;
    if (agentChecked) return undefined; // already determined unavailable
    agentChecked = true;
    const service = new TerminalService({
      runtime,
      cwd: process.cwd(),
      environment: baseCtx.environment,
      noNative: baseCtx.noNative,
    });
    const selection = await createAgent({
      service,
      approve: async ({ command }) => promptYesNo(rl, `Run for real: ${command}?`),
    });
    if (!selection) {
      process.stdout.write(noClaudeMessage());
      return undefined;
    }
    process.stdout.write(
      color.gray(
        selection.kind === "cli"
          ? "(Claude console via your subscription — claude CLI)\n"
          : "(Claude console via the Anthropic API)\n",
      ),
    );
    agent = selection.agent;
    return agent;
  };

  process.stdout.write(
    color.bold("IDEL Terminal") +
      color.gray("  —  type a command, `ask.ai prompt=\"...\"`, `help`, or `exit`. TAB completes.\n"),
  );
  rl.prompt();

  return await new Promise<number>((resolveP) => {
    // Lines are handled one at a time. A command (or a `?` ask, or a sensitive
    // confirm) is async, and readline keeps emitting `line` events meanwhile, so
    // we QUEUE incoming lines and drain them serially — otherwise the next line
    // (e.g. a "y"/"n" answer) races the in-flight handler. `closed` guards
    // against prompting a readline that `exit` already tore down.
    const queue: string[] = [];
    let draining = false;
    let stop = false; // set by `exit`/`quit` — abandon the queue and finish.
    let inputEnded = false; // stdin EOF — finish AFTER the queue drains.

    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      // Drain everything queued. On EOF we keep going until the queue empties
      // (so all piped lines run); only an explicit `exit` (`stop`) abandons it.
      while (queue.length && !stop) {
        const line = queue.shift()!.trim();
        await handleLine(line);
      }
      draining = false;
      if (stop || inputEnded) {
        finish();
        return;
      }
      rl.prompt();
    };

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      process.stdout.write("\n");
      rl.close();
      resolveP(0);
    };

    const handleLine = async (line: string): Promise<void> => {
      if (!line) return;
      if (line === "exit" || line === "quit") {
        stop = true;
        return;
      }
      if (line === "help") {
        process.stdout.write(
          color.gray(
            "Enter IDEL commands like `create.file name=x.txt`, `cmd.one && cmd.two`, or `! rm -rf dist`.\n" +
              "Ask AI in natural language with `ask.ai prompt=\"delete the dist folder\"` or a leading `?`.\n" +
              `Learn an installed CLI with \`${LEARN_USAGE}\` or \`learn.cli cli=git\`.\n` +
              "Meta: list.registry, explain.registry command=remove.folder, check.policy, list.history, list.logs.\n" +
              "Web scrollback: clear.all, clear.last limit=10, clear.first limit=10, clear.range from=2 to=5.\n",
          ),
        );
        return;
      }

      let batch: string[];
      try {
        batch = splitBatch(line);
      } catch (err) {
        process.stdout.write(color.red(`${(err as Error).message}\n`));
        return;
      }
      if (batch.length > 1) {
        await runBatchWithPreview(runtime, batch, baseCtx, rl);
        return;
      }

      const learned = parseLearnCommand(line);
      if (learned) {
        const code = await learn(learned.cli, { write: learned.write, json: false });
        if (code === 0 && learned.write) {
          try {
            await runtime.reg.loadLayer(userCustomRegistryDir(), "custom");
            process.stdout.write(color.gray("(custom registry reloaded)\n"));
          } catch (err) {
            process.stdout.write(color.red(`Could not reload custom registry: ${(err as Error).message}\n`));
          }
        }
        return;
      }

      // `ask.ai prompt="..."` is the IDEL-shaped alias for the embedded AI console.
      if (isAskAiCommand(line)) {
        const intent = askAiIntent(line);
        const a = intent ? await getAgent() : undefined;
        if (a && intent) {
          try {
            for await (const ev of a.ask(intent)) renderEvent(ev);
          } catch (err) {
            process.stdout.write(color.red(`Agent error: ${(err as Error).message}\n`));
          }
        } else if (!intent) {
          process.stdout.write(color.gray(`Usage: ${ASK_AI_USAGE}\n`));
        }
        return;
      }

      // `? <intent>` routes to the embedded Claude console.
      if (line.startsWith("?")) {
        const intent = line.slice(1).trim();
        const a = intent ? await getAgent() : undefined;
        if (a && intent) {
          try {
            for await (const ev of a.ask(intent)) renderEvent(ev);
          } catch (err) {
            process.stdout.write(color.red(`Agent error: ${(err as Error).message}\n`));
          }
        } else if (!intent) {
          process.stdout.write(color.gray("Usage: ? <what you want to do>\n"));
        }
        return;
      }

      // cwd can change between commands (change.path), so re-read it each line.
      const ctx: RuntimeContext = { ...baseCtx, cwd: process.cwd() };
      try {
        await runWithPreview(runtime, line, ctx, rl);
      } catch (err) {
        process.stdout.write(color.red(`Error: ${(err as Error).message}\n`));
      }
    };

    rl.on("line", (raw) => {
      queue.push(raw);
      void drain();
    });

    rl.on("SIGINT", () => {
      queue.length = 0;
      if (draining) {
        process.stdout.write("^C\n");
        return;
      }
      if (rl.line.length > 0) {
        rl.write(null, { ctrl: true, name: "a" });
        rl.write(null, { ctrl: true, name: "k" });
        process.stdout.write("^C\n");
        rl.prompt();
        return;
      }
      stop = true;
      finish();
    });

    // EOF (piped stdin exhausted, or Ctrl-D). Let the queue finish draining,
    // then finish. If nothing is in flight, finish now.
    rl.on("close", () => {
      inputEnded = true;
      if (!draining) finish();
    });
  });
}

function userCustomRegistryDir(): string {
  return join(homedir(), ".idel", "registries", "custom");
}

/**
 * Run one typed command, but FIRST classify it as a dry run so we can show the
 * user what it TRANSLATES TO (the real adapter invocation) and its risk BEFORE
 * anything executes. This is the preview the user asked for. The real run then
 * honors the policy model — we never quietly override it:
 *
 *   - block (CRITICAL floor, etc.) → refused; show the dry preview and stop.
 *   - require_dry_run (the default for HIGH) → dry-run ONLY by policy. We show
 *     the preview and say so; confirming cannot promote it (that's the point of
 *     the floor). To really run it you need a policy that allows it.
 *   - approval_required → the runtime's own onApproval gate (wired to a y/N
 *     prompt) decides; we just run it and let that gate fire.
 *   - allow → run for real. If it is still sensitive (HIGH/CRITICAL under a lax
 *     custom policy), confirm first; otherwise run directly.
 *
 * Native `!` lines and an explicit --dry-run are pass-through (run as-is).
 */
async function runWithPreview(
  runtime: Runtime,
  line: string,
  ctx: RuntimeContext,
  rl: Interface,
): Promise<RuntimeOutcome | undefined> {
  if (line.startsWith("!") || ctx.dryRun) {
    const outcome = await runtime.run(line, ctx);
    process.stdout.write(render(outcome) + "\n");
    return outcome;
  }

  // Classify first without touching disk to build the preview.
  const preview = await runtime.run(line, { ...ctx, dryRun: true });
  const level = preview.risk.level;
  const action = preview.decision.action;
  const translated = translateLine(preview);

  // Blocked or dry-run-only by policy: the preview IS the answer; nothing more
  // can run. Make the "translates to" + reason visible and stop.
  if (action === "block" || action === "require_dry_run") {
    if (action === "require_dry_run") {
      process.stdout.write(
        color.yellow("⚠ sensitive — policy allows a dry run only (not a real execution):\n"),
      );
    }
    process.stdout.write(render(preview) + "\n");
    return preview;
  }

  // allow / approval_required → a real run is possible. For a still-sensitive
  // command, show the translated command and confirm before executing. Policy
  // approval has its own runtime prompt, so avoid asking twice.
  const sensitive = level === "HIGH" || level === "CRITICAL";
  const needsPolicyApproval = action === "approval_required";
  if (sensitive || needsPolicyApproval) {
    process.stdout.write(
      color.yellow(
        needsPolicyApproval
          ? "⚠ policy approval required — review before running:\n"
          : "⚠ sensitive command — review before running:\n",
      ) + render(preview) + "\n",
    );
    if (!needsPolicyApproval) {
      const ok = await promptYesNo(rl, `Run for real${translated ? `: ${translated}` : ""}?`);
      if (!ok) {
        process.stdout.write(color.gray("Skipped. Nothing was changed.\n"));
        return undefined;
      }
    }
  }
  // approval_required fires the runtime's onApproval gate here.
  const outcome = await runtime.run(line, ctx);
  process.stdout.write(render(outcome) + "\n");
  return outcome;
}

async function runBatchWithPreview(
  runtime: Runtime,
  commands: string[],
  baseCtx: RuntimeContext,
  rl: Interface,
): Promise<void> {
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    process.stdout.write(color.gray(`Batch ${i + 1}/${commands.length}: ${command}\n`));
    const ctx: RuntimeContext = { ...baseCtx, cwd: process.cwd() };
    const outcome = await runWithPreview(runtime, command, ctx, rl);
    if (!outcome || !batchStepSucceeded(outcome, ctx.dryRun === true)) {
      if (i + 1 < commands.length) {
        process.stdout.write(color.yellow(`Batch stopped at step ${i + 1}; ${commands.length - i - 1} step(s) skipped.\n`));
      }
      return;
    }
  }
}

function batchStepSucceeded(outcome: RuntimeOutcome, explicitDryRun = false): boolean {
  return outcome.record.result === "success" || (explicitDryRun && outcome.record.result === "dry_run");
}

/**
 * Ask a y/N question on the REPL's own readline interface. Reusing `rl` (rather
 * than opening a second interface on the same stdin) avoids dueling line
 * listeners; the in-flight `line` handler is async, so the prompt resolves
 * before the next line is read.
 */
function promptYesNo(rl: Interface, question: string): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    rl.question(color.yellow(`${question} [y/N] `), (answer) => {
      resolveP(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
