/**
 * PowerShellAdapter — executes commands via PowerShell cmdlets (Remove-Item,
 * New-Item, Copy-Item …).
 *
 * Spec §22 / §28: argv is built by structured rendering ({@link renderArgv}),
 * never string concatenation. The cmdlet and its rendered argv are passed to
 * `spawn` as SEPARATE argument-array elements after `-Command`; we never build
 * a single shell string from parameter values.
 *
 * LIMITATION (v1): passing `<cmdlet> <arg1> <arg2> …` as separate elements
 * after `-Command` works for simple "cmdlet + parameters" cases — which is all
 * the core registry needs. It does NOT handle cases requiring PowerShell-side
 * quoting, pipelines, or expression evaluation. Where POSIX and PowerShell
 * semantics diverge (exit codes, glob handling, read-only behavior), the def's
 * `semanticNotes` documents it rather than this adapter pretending parity.
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

/** The PowerShell host executable. `powershell` is Windows PowerShell 5.x. */
const PWSH_EXE = "powershell";

/** Resolves a command id to its def so capability checks can inspect adapters. */
export type ResolveFn = (commandId: string) => ResolvedCommand | undefined;

export class PowerShellAdapter implements Adapter {
  readonly name: AdapterName = "powershell";
  readonly available: boolean = process.platform === "win32";

  /**
   * Optional resolver so {@link supports} can answer accurately from just a
   * command id (the {@link Adapter} interface only passes an id). When omitted,
   * the runtime should call {@link supportsResolved} with the resolved def.
   */
  constructor(private readonly resolve?: ResolveFn) {}

  supports(commandId: string): boolean {
    const resolved = this.resolve?.(commandId);
    if (resolved === undefined) return false;
    return this.supportsResolved(resolved);
  }

  /** Authoritative capability check given the resolved def. */
  supportsResolved(resolved: ResolvedCommand): boolean {
    const spec = resolved.def.adapters.powershell;
    if (spec === undefined) return false;
    return !NON_SPAWN_COMMANDS.has(spec.command);
  }

  plan(resolved: ResolvedCommand, ast: CommandAst): ExecutionPlan {
    const spec = resolved.def.adapters.powershell;
    if (spec === undefined) {
      throw new Error(
        `PowerShellAdapter cannot plan "${resolved.def.id}": no powershell adapter spec`,
      );
    }
    const argv = renderArgv(spec, ast.params);
    const describe = argv.length > 0
      ? `${spec.command} ${argv.join(" ")}`
      : spec.command;
    // `command` holds the cmdlet name; argv holds its rendered parameters.
    return { adapter: "powershell", command: spec.command, argv, describe };
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

    // Cmdlets must run inside a PowerShell host. We invoke the host with the
    // cmdlet and its rendered argv as SEPARATE elements after -Command — no
    // shell string is assembled from parameter values.
    const hostArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      plan.command,
      ...plan.argv,
    ];

    const start = process.hrtime.bigint();
    return await new Promise<ExecutionResult>((resolve) => {
      const child = spawn(PWSH_EXE, hostArgs, {
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
        finish(127, `${err.message}\n`);
      });
      child.on("close", (code: number | null) => {
        finish(code ?? 0);
      });
    });
  }
}

/** Convenience singleton; the runtime may also instantiate its own. */
export const powerShellAdapter = new PowerShellAdapter();
