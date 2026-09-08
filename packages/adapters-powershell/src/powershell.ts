/**
 * PowerShellAdapter — executes commands via PowerShell cmdlets (Remove-Item,
 * New-Item, Copy-Item …).
 *
 * Spec §22 / §28: argv is built by structured rendering ({@link renderArgv}),
 * never string concatenation. PowerShell's `-Command` mode reparses every token
 * after the command as script text, even when Node used `shell:false`, so no
 * registry value is ever placed there. Execution uses a fixed encoded script
 * and sends binding metadata as JSON over stdin; the script invokes the command
 * through the programmatic PowerShell API (`AddCommand` / `AddParameter` /
 * `AddArgument`), preserving both value-as-data and named-parameter semantics.
 */

import { spawn } from "node:child_process";
import type {
  Adapter,
  AdapterName,
  AdapterSpec,
  CommandAst,
  ExecutionPlan,
  ExecutionResult,
  ParamValue,
  ResolvedCommand,
} from "@openexecution/types";
import { renderArgv } from "./render.js";

/** Commands whose `command` is a runtime sentinel handled elsewhere. */
const NON_SPAWN_COMMANDS = new Set<string>(["@node", "@runtime"]);

/** The PowerShell host executable. `powershell` is Windows PowerShell 5.x. */
const PWSH_EXE = "powershell";

type PowerShellBinding =
  | { kind: "parameter"; name: string; value?: string }
  | { kind: "argument"; value: string };

interface PowerShellDispatchRequest {
  command: string;
  bindings: PowerShellBinding[];
}

const DISPATCH_REQUEST = Symbol("openexecution.powershell.dispatch-request");
type BoundPowerShellPlan = ExecutionPlan & {
  [DISPATCH_REQUEST]: PowerShellDispatchRequest;
};

/**
 * Fixed, value-independent dispatcher passed through `-EncodedCommand`.
 * Windows PowerShell expects UTF-16LE for encoded commands. The dispatcher
 * consumes stdin completely before invoking the command, which is acceptable
 * for registry adapters: their contract has no stdin channel.
 */
const POWERSHELL_STDIN_DISPATCHER = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $payload = [Console]::In.ReadToEnd()",
  "  $request = ConvertFrom-Json -InputObject $payload",
  "  if ($null -eq $request.command) { throw 'Missing command in adapter request.' }",
  "  $command = [string]$request.command",
  "  $runner = [System.Management.Automation.PowerShell]::Create()",
  "  [void]$runner.AddCommand($command)",
  "  foreach ($binding in @($request.bindings)) {",
  "    if ([string]$binding.kind -eq 'parameter') {",
  "      $hasValue = $null -ne $binding.PSObject.Properties['value']",
  "      if ($hasValue) {",
  "        [void]$runner.AddParameter([string]$binding.name, [string]$binding.value)",
  "      } else {",
  "        [void]$runner.AddParameter([string]$binding.name)",
  "      }",
  "    } elseif ([string]$binding.kind -eq 'argument') {",
  "      [void]$runner.AddArgument([string]$binding.value)",
  "    } else {",
  "      throw 'Invalid binding kind in adapter request.'",
  "    }",
  "  }",
  "  $results = $runner.Invoke()",
  "  foreach ($item in @($results)) {",
  "    if ($null -ne $item) { [Console]::Out.WriteLine($item.ToString()) }",
  "  }",
  "  foreach ($failure in @($runner.Streams.Error)) {",
  "    [Console]::Error.WriteLine($failure.ToString())",
  "  }",
  "  if ($runner.HadErrors) { exit 1 }",
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "} finally {",
  "  if ($null -ne $runner) { $runner.Dispose() }",
  "}",
].join("\n");

const ENCODED_STDIN_DISPATCHER = Buffer.from(
  POWERSHELL_STDIN_DISPATCHER,
  "utf16le",
).toString("base64");

export interface PowerShellHostInvocation {
  /** Host-only arguments. No command or parameter value appears here. */
  argv: string[];
  /** Exact data document delivered over stdin. */
  stdin: string;
}

/**
 * Build the host invocation separately so the non-executable data boundary is
 * unit-testable on POSIX CI, where Windows PowerShell is unavailable.
 */
export function buildPowerShellHostInvocation(
  plan: Pick<ExecutionPlan, "command" | "argv">,
): PowerShellHostInvocation {
  const request = (plan as Partial<BoundPowerShellPlan>)[DISPATCH_REQUEST];
  if (!request) {
    throw new Error(
      "PowerShell execution requires a plan produced by PowerShellAdapter.plan().",
    );
  }
  return {
    argv: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      ENCODED_STDIN_DISPATCHER,
    ],
    stdin: JSON.stringify(request),
  };
}

function isPresent(value: ParamValue | undefined): value is ParamValue {
  return value !== undefined && value !== "";
}

function parameterName(flag: string): string {
  return flag.replace(/^-+/, "");
}

/** PowerShell cmdlets follow the standard approved Verb-Noun naming form. */
function isCmdletName(command: string): boolean {
  return /^[A-Za-z]+-[A-Za-z][A-Za-z0-9]*$/.test(command);
}

/**
 * Convert the trusted declarative adapter spec to structural invocation calls.
 * External programs receive only `AddArgument`; cmdlets receive named
 * `AddParameter` bindings where the spec declares flags/options.
 */
function buildPowerShellBindings(
  spec: AdapterSpec,
  params: CommandAst["params"],
): PowerShellBinding[] {
  if (!isCmdletName(spec.command)) {
    return renderArgv(spec, params).map((value) => ({ kind: "argument", value }));
  }

  const bindings: PowerShellBinding[] = [];
  for (let index = 0; index < spec.args.length; index += 1) {
    const arg = spec.args[index];
    if (!arg) continue;
    switch (arg.kind) {
      case "flag":
        if (params[arg.when] === true) {
          bindings.push({ kind: "parameter", name: parameterName(arg.flag) });
        }
        break;
      case "option": {
        const value = params[arg.param];
        if (isPresent(value)) {
          bindings.push({
            kind: "parameter",
            name: parameterName(arg.flag),
            value: String(value),
          });
        }
        break;
      }
      case "value": {
        const value = params[arg.param];
        if (isPresent(value)) {
          bindings.push({ kind: "argument", value: String(value) });
        }
        break;
      }
      case "literal": {
        if (!arg.value.startsWith("-")) {
          bindings.push({ kind: "argument", value: arg.value });
          break;
        }

        const next = spec.args[index + 1];
        if (next?.kind === "value") {
          const value = params[next.param];
          if (isPresent(value)) {
            bindings.push({
              kind: "parameter",
              name: parameterName(arg.value),
              value: String(value),
            });
          }
          index += 1;
          break;
        }
        if (next?.kind === "literal" && !next.value.startsWith("-")) {
          bindings.push({
            kind: "parameter",
            name: parameterName(arg.value),
            value: next.value,
          });
          index += 1;
          break;
        }
        bindings.push({ kind: "parameter", name: parameterName(arg.value) });
        break;
      }
    }
  }
  return bindings;
}

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
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(spec.command)) {
      throw new Error(
        `PowerShellAdapter refuses non-token command name ${JSON.stringify(spec.command)}.`,
      );
    }
    const argv = renderArgv(spec, ast.params);
    const describe = argv.length > 0
      ? `${spec.command} ${argv.join(" ")}`
      : spec.command;
    const plan: BoundPowerShellPlan = {
      adapter: "powershell",
      command: spec.command,
      argv,
      describe,
      [DISPATCH_REQUEST]: {
        command: spec.command,
        bindings: buildPowerShellBindings(spec, ast.params),
      },
    };
    // Avoid leaking internal dispatch metadata into execution logs while
    // retaining it on the exact plan object passed to execute().
    Object.defineProperty(plan, DISPATCH_REQUEST, { enumerable: false });
    return plan;
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

    // `-Command` reparses trailing process arguments as PowerShell source. Keep
    // every registry-controlled value out of the host argv and transport the
    // request as inert JSON to a fixed encoded dispatcher instead.
    const invocation = buildPowerShellHostInvocation(plan);

    const start = process.hrtime.bigint();
    return await new Promise<ExecutionResult>((resolve) => {
      const child = spawn(PWSH_EXE, invocation.argv, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Ignore EPIPE here: the child's close/error handlers below produce the
      // authoritative execution result if the host exits before reading stdin.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(invocation.stdin, "utf8");

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
