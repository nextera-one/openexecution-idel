import { createInterface, type Interface } from "node:readline";

import { createAgent, type AgentLike } from "@openexecution/agent";
import { TerminalService } from "@openexecution/server";
import type { Runtime } from "@openexecution/runtime";
import type { RuntimeContext } from "@openexecution/runtime";

import { complete } from "./complete.js";
import { render, translateLine } from "./render.js";
import { color } from "./render.js";
import { renderEvent, noClaudeMessage } from "./ask.js";

/**
 * Interactive IDEL terminal (spec §24, `idel terminal`). A thin readline REPL
 * with registry-driven TAB completion. Each line goes through the full runtime
 * pipeline, so the same safety/policy/logging applies as in one-shot mode.
 */
export async function startTerminal(
  runtime: Runtime,
  baseCtx: RuntimeContext,
): Promise<number> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: color.blue("idel> "),
    completer: (line: string): [string[], string] => {
      const suggestions = complete(line, runtime.reg, process.cwd());
      return [suggestions, line];
    },
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
      color.gray("  —  type a command, `? <ask Claude>`, `help`, or `exit`. TAB completes.\n"),
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
            "Enter IDEL commands like `create.file name=x.txt` or `! rm -rf dist`.\n" +
              "Ask Claude in natural language with a leading `?`: `? delete the dist folder`.\n" +
              "Meta: registry.list, registry.explain command=remove.folder, policy.check, logs.list.\n",
          ),
        );
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

      // cwd can change between commands (path.change), so re-read it each line.
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

    // EOF (piped stdin exhausted, or Ctrl-D). Let the queue finish draining,
    // then finish. If nothing is in flight, finish now.
    rl.on("close", () => {
      inputEnded = true;
      if (!draining) finish();
    });
  });
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
): Promise<void> {
  if (line.startsWith("!") || ctx.dryRun) {
    process.stdout.write(render(await runtime.run(line, ctx)) + "\n");
    return;
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
    return;
  }

  // allow / approval_required → a real run is possible. For a still-sensitive
  // command, show the translated command and confirm before executing.
  const sensitive = level === "HIGH" || level === "CRITICAL";
  if (sensitive) {
    process.stdout.write(
      color.yellow("⚠ sensitive command — review before running:\n") + render(preview) + "\n",
    );
    const ok = await promptYesNo(rl, `Run for real${translated ? `: ${translated}` : ""}?`);
    if (!ok) {
      process.stdout.write(color.gray("Skipped. Nothing was changed.\n"));
      return;
    }
  }
  // approval_required will additionally fire the runtime's onApproval gate.
  process.stdout.write(render(await runtime.run(line, ctx)) + "\n");
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
