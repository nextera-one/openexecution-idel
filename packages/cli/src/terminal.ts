import { createInterface, type Interface } from "node:readline";

import { IdelAgent } from "@openexecution/agent";
import { TerminalService } from "@openexecution/server";
import type { Runtime } from "@openexecution/runtime";
import type { RuntimeContext } from "@openexecution/runtime";

import { complete } from "./complete.js";
import { render } from "./render.js";
import { color } from "./render.js";
import { renderEvent } from "./ask.js";

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

  // The agent (Claude console) is built lazily on first `?` use, so a missing
  // ANTHROPIC_API_KEY only matters if you actually ask. It shares one
  // TerminalService over this runtime, so agent-run commands are audited
  // identically (source: "agent") to typed ones.
  let agent: IdelAgent | undefined;
  const getAgent = (): IdelAgent | undefined => {
    if (agent) return agent;
    if (!process.env["ANTHROPIC_API_KEY"]) {
      process.stdout.write(
        color.red("ANTHROPIC_API_KEY is not set. ") +
          color.gray("Export it to use `?`.\n"),
      );
      return undefined;
    }
    const service = new TerminalService({
      runtime,
      cwd: process.cwd(),
      environment: baseCtx.environment,
      noNative: baseCtx.noNative,
    });
    agent = new IdelAgent({
      service,
      approve: async ({ command }) => promptYesNo(rl, `Run for real: ${command}?`),
    });
    return agent;
  };

  process.stdout.write(
    color.bold("IDEL Terminal") +
      color.gray("  —  type a command, `? <ask Claude>`, `help`, or `exit`. TAB completes.\n"),
  );
  rl.prompt();

  return await new Promise<number>((resolveP) => {
    rl.on("line", async (raw) => {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        return;
      }
      if (line === "exit" || line === "quit") {
        rl.close();
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
        rl.prompt();
        return;
      }

      // `? <intent>` routes to the embedded Claude console.
      if (line.startsWith("?")) {
        const intent = line.slice(1).trim();
        const a = intent ? getAgent() : undefined;
        if (a && intent) {
          try {
            for await (const ev of a.ask(intent)) renderEvent(ev);
          } catch (err) {
            process.stdout.write(color.red(`Agent error: ${(err as Error).message}\n`));
          }
        } else if (!intent) {
          process.stdout.write(color.gray("Usage: ? <what you want to do>\n"));
        }
        rl.prompt();
        return;
      }

      // cwd can change between commands (path.change), so re-read it each line.
      const ctx: RuntimeContext = { ...baseCtx, cwd: process.cwd() };
      try {
        const outcome = await runtime.run(line, ctx);
        process.stdout.write(render(outcome) + "\n");
      } catch (err) {
        process.stdout.write(color.red(`Error: ${(err as Error).message}\n`));
      }
      rl.prompt();
    });

    rl.on("close", () => {
      process.stdout.write("\n");
      resolveP(0);
    });
  });
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
