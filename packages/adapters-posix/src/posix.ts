/**
 * PosixAdapter — executes commands via POSIX utilities (rm, mkdir, cp, …).
 *
 * Spec §22 / §28: argv is built by structured rendering ({@link renderArgv}),
 * then handed to `spawn` with an ARGUMENT ARRAY and `shell: false`. No part of
 * the command line is ever assembled by string concatenation, so shell
 * metacharacters in parameter values are inert.
 */

import { spawn } from "node:child_process";
import type {
  Adapter,
  AdapterName,
  CommandAst,
  ExecutionPlan,
  ExecutionResult,
  ResolvedCommand,
} from "@openexecution/types";
import { renderArgv } from "./render.js";

/** Commands whose `command` is a runtime sentinel handled elsewhere. */
const NON_SPAWN_COMMANDS = new Set<string>(["@node", "@runtime"]);

/** Resolves a command id to its def so capability checks can inspect adapters. */
export type ResolveFn = (commandId: string) => ResolvedCommand | undefined;

export class PosixAdapter implements Adapter {
  readonly name: AdapterName = "posix";
  readonly available: boolean = process.platform !== "win32";

  /**
   * Optional resolver so {@link supports} can answer accurately from just a
   * command id (the {@link Adapter} interface only passes an id). When omitted,
   * the runtime should call {@link supportsResolved} with the resolved def.
   */
  constructor(private readonly resolve?: ResolveFn) {}

  /**
   * True when the resolved def has a POSIX adapter spec that is a spawnable
   * executable (not a `@node` in-process op or a `@runtime` meta op). If no
   * resolver was supplied and the id cannot be resolved, returns false; use
   * {@link supportsResolved} for the authoritative, def-in-hand check.
   * Note: this is pure, so it works for inspection even on Windows where
   * {@link available} is false.
   */
  supports(commandId: string): boolean {
    const resolved = this.resolve?.(commandId);
    if (resolved === undefined) return false;
    return this.supportsResolved(resolved);
  }

  /** Authoritative capability check given the resolved def. */
  supportsResolved(resolved: ResolvedCommand): boolean {
    const spec = resolved.def.adapters.posix;
    if (spec === undefined) return false;
    return !NON_SPAWN_COMMANDS.has(spec.command);
  }

  plan(resolved: ResolvedCommand, ast: CommandAst): ExecutionPlan {
    const spec = resolved.def.adapters.posix;
    if (spec === undefined) {
      throw new Error(
        `PosixAdapter cannot plan "${resolved.def.id}": no posix adapter spec`,
      );
    }
    const argv = renderArgv(spec, ast.params);
    const describe = argv.length > 0
      ? `${spec.command} ${argv.join(" ")}`
      : spec.command;
    return { adapter: "posix", command: spec.command, argv, describe };
  }

  async execute(
    plan: ExecutionPlan,
    opts: { dryRun: boolean; cwd: string },
  ): Promise<ExecutionResult> {
    if (opts.dryRun) {
      return {
        exitCode: 0,
        durationMs: 0,
        stdout: `[dry-run] would execute: ${plan.describe} (cwd=${opts.cwd})\n`,
        stderr: "",
        simulated: true,
      };
    }

    const start = process.hrtime.bigint();
    return await new Promise<ExecutionResult>((resolve) => {
      const child = spawn(plan.command, plan.argv, {
        cwd: opts.cwd,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const finish = (exitCode: number, extraStderr = ""): void => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({
          exitCode,
          durationMs,
          stdout,
          stderr: stderr + extraStderr,
          simulated: false,
        });
      };

      child.on("error", (err: Error) => {
        // e.g. ENOENT when the executable is missing — report as failure.
        finish(127, `${err.message}\n`);
      });
      child.on("close", (code: number | null) => {
        finish(code ?? 0);
      });
    });
  }
}

/** Convenience singleton; the runtime may also instantiate its own. */
export const posixAdapter = new PosixAdapter();
