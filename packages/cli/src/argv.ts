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
  /** Top-level subcommand: "run" (default), "terminal", "completion", "help", "version". */
  mode: "run" | "terminal" | "completion" | "help" | "version";
  /** The reassembled IDEL command string (for run mode). */
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
}

const RUNTIME_FLAGS = new Set([
  "--dry-run",
  "--ci",
  "--no-native",
  "--yes",
  "--json",
]);
const RUNTIME_VALUE_FLAGS = new Set(["--policy", "--env"]);

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
      continue;
    }
    if (RUNTIME_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Flag ${arg} requires a value`);
      }
      if (arg === "--policy") flags.policyPath = value;
      else if (arg === "--env") flags.environment = value;
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
  if (first === "completion") {
    // `idel completion <partial...>` — used by shells / the interactive REPL.
    return {
      mode: "completion",
      command: rest.slice(1).join(" "),
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
