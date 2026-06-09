import { createInterface } from "node:readline";

import type { Runtime } from "@openexecution/runtime";
import type { RuntimeContext } from "@openexecution/runtime";

import { complete } from "./complete.js";
import { render } from "./render.js";
import { color } from "./render.js";

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

  process.stdout.write(
    color.bold("IDEL Terminal") +
      color.gray("  —  type a command, `help`, or `exit`. TAB completes.\n"),
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
              "Meta: registry.list, registry.explain command=remove.folder, policy.check, logs.list.\n",
          ),
        );
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
