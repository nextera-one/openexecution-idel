/**
 * argv handling. We deliberately keep a *small custom layer around raw argv*
 * (spec §10) rather than a generic CLI parser, so IDEL's `verb.scope key=value`
 * syntax is not mangled by an opinionated flag parser.
 *
 * Runtime flags use the `--flag` form and are stripped out; everything that is
 * left over is the IDEL command line, reassembled verbatim and handed to the
 * runtime's own parser.
 */

export interface CliInvocation {
  /** Top-level subcommand: "run" (default), "ask", "learn", "terminal", "serve", "completion", "help", "version". */
  mode: "run" | "ask" | "learn" | "terminal" | "serve" | "completion" | "help" | "version";
  /** The reassembled IDEL command string (run mode), NL intent (ask), or CLI name (learn). */
  command: string;
  /** Whether the command is a native passthrough (leading `!`). */
  native: boolean;
  flags: CliFlags;
}

export interface CliFlags {
  dryRun: boolean;
  ci: boolean;
  noNative: boolean;
  yes: boolean;
  json: boolean;
  policyPath?: string;
  environment?: string;
  /** `idel serve` HTTP port (default 7878). */
  port?: number;
  /** `idel serve` bind host (default 127.0.0.1, loopback only). */
  host?: string;
  /** `idel serve` directory of built UI assets to serve at `/`. */
  staticDir?: string;
  /** `idel serve` open the URL in the default browser on start. */
  open?: boolean;
  /** `idel learn` write accepted defs to the custom draft layer (default: preview only). */
  write?: boolean;
}

const RUNTIME_FLAGS = new Set([
  "--dry-run",
  "--ci",
  "--no-native",
  "--yes",
  "--json",
  "--open",
  "--write",
]);
const RUNTIME_VALUE_FLAGS = new Set([
  "--policy",
  "--env",
  "--port",
  "--host",
  "--static",
]);

export function parseArgv(argv: string[]): CliInvocation {
  const flags: CliFlags = {
    dryRun: false,
    ci: false,
    noNative: false,
    yes: false,
    json: false,
  };

  // Pull recognized runtime flags out of the stream; keep order of the rest.
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (RUNTIME_FLAGS.has(arg)) {
      if (arg === "--dry-run") flags.dryRun = true;
      else if (arg === "--ci") flags.ci = true;
      else if (arg === "--no-native") flags.noNative = true;
      else if (arg === "--yes") flags.yes = true;
      else if (arg === "--json") flags.json = true;
      else if (arg === "--open") flags.open = true;
      else if (arg === "--write") flags.write = true;
      continue;
    }
    if (RUNTIME_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Flag ${arg} requires a value`);
      }
      if (arg === "--policy") flags.policyPath = value;
      else if (arg === "--env") flags.environment = value;
      else if (arg === "--host") flags.host = value;
      else if (arg === "--static") flags.staticDir = value;
      else if (arg === "--port") {
        const port = Number.parseInt(value, 10);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`Flag --port requires a valid port number, got "${value}"`);
        }
        flags.port = port;
      }
      i++;
      continue;
    }
    rest.push(arg);
  }

  const first = rest[0];

  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { mode: "help", command: "", native: false, flags };
  }
  if (first === "version" || first === "--version" || first === "-v") {
    return { mode: "version", command: "", native: false, flags };
  }
  if (first === "terminal") {
    return { mode: "terminal", command: "", native: false, flags };
  }
  if (first === "serve") {
    return { mode: "serve", command: "", native: false, flags };
  }
  if (first === "ask") {
    // `idel ask "<natural language intent>"` — the embedded Claude console.
    return {
      mode: "ask",
      command: rest.slice(1).join(" "),
      native: false,
      flags,
    };
  }
  if (first === "learn") {
    // `idel learn <cli>` — introspect an installed CLI and draft IDEL defs.
    return {
      mode: "learn",
      command: rest.slice(1).join(" ").trim(),
      native: false,
      flags,
    };
  }
  if (first === "completion") {
    // `idel completion <partial...>` — used by shells / the interactive REPL.
    return {
      mode: "completion",
      command: rest.slice(1).join(" "),
      native: false,
      flags,
    };
  }

  if (first === "editor" || first === "edit") {
    const args = rest.slice(1);
    return {
      mode: "run",
      command: editorAliasCommand(args),
      native: false,
      flags,
    };
  }

  // Native passthrough: `idel ! "rm -rf dist"` or `idel native.run command="..."`.
  if (first === "!") {
    return {
      mode: "run",
      command: rest.slice(1).join(" "),
      native: true,
      flags,
    };
  }

  // One-shot IDEL: reassemble the remaining tokens verbatim.
  return {
    mode: "run",
    command: rest.join(" "),
    native: false,
    flags,
  };
}

function editorAliasCommand(args: string[]): string {
  if (args.length === 0) return "edit.file";
  const [first, ...rest] = args;
  if (first === undefined) return "edit.file";
  if (first.includes("=")) return `edit.file ${args.join(" ")}`;
  return `edit.file path=${quoteParamValue(first)}${rest.length ? ` ${rest.join(" ")}` : ""}`;
}

function quoteParamValue(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
