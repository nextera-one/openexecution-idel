import { spawn } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";
import { checkCommandDef, ID_RE } from "@openexecution/registry";
import type {
  AdapterArgSpec,
  CommandDef,
  RiskLevel,
} from "@openexecution/types";

/**
 * `idel learn <cli>` — turn an *already-installed* CLI into a set of draft IDEL
 * command definitions.
 *
 * The pitch (README item: "convert any newly installed CLI to IDEL"): you
 * install some tool — `gh`, `kubectl`, `docker`, a company script — and IDEL
 * learns it by reading its own `--help` output and proposing IDEL `CommandDef`s
 * for the common subcommands. The output is then governed by the exact same
 * runtime: risk-classified, policy-gated, and audited.
 *
 * Three hard safety rules make this safe to ship (and match CONCERNS Phase 3 —
 * "native.learn draft-only, behind the safety engine, disabled by default"):
 *
 *  1. **Introspection only — never execution.** We invoke `<cli> --help` (and a
 *     couple of well-known help variants), capture stdout, and stop. We never
 *     run a real subcommand to "see what it does". The help text is the input
 *     to the local generator or to an explicitly configured AI generator.
 *  2. **Draft layer, never core.** Generated defs are tagged `source: "custom"`
 *     and written to `~/.idel/registries/custom/learned/`. They shadow nothing
 *     in core they shouldn't (resolution is custom > official > core, but a
 *     learned def gets a distinct verb-first `<action>.<cli>[.<object>]` id),
 *     and core safety floors still apply on top.
 *  3. **Fail-closed validation.** Every generated def is run through the
 *     registry's own {@link checkCommandDef}. Anything that doesn't validate is
 *     dropped with its errors reported — an invalid def never reaches disk.
 *
 * The generator proposes; the schema validator disposes. A learned
 * `remove`-shaped command is classified by the same two-phase safety engine as
 * a hand-written one, so "I taught IDEL a destructive tool" does not weaken any
 * guarantee.
 */

/** A model for one-shot structured generation. Cheaper than the agent loop. */
const LEARN_MODEL = "claude-opus-4-8";

/** Help invocations we try, in order, to introspect a CLI. First non-empty wins. */
const HELP_VARIANTS: readonly string[][] = [["--help"], ["help"], ["-h"]];

/** Cap on captured help bytes — some tools dump enormous help. */
const MAX_HELP_BYTES = 200_000;

/** Cap on how long a help invocation may run before we give up on it. */
const HELP_TIMEOUT_MS = 5_000;
const LEARN_CLI_TIMEOUT_MS = 120_000;

interface ClaudeCliJson {
  result?: string;
  is_error?: boolean;
  subtype?: string;
}

export interface LearnOptions {
  /** Anthropic client. Defaults to a new one reading ANTHROPIC_API_KEY. */
  client?: Anthropic;
  /** Override the generation model. */
  model?: string;
  /**
   * Capture a CLI's help text. Injectable so tests don't shell out and so a
   * future sandbox can wrap the spawn. Defaults to {@link captureHelp}.
   */
  capture?: (cli: string) => Promise<string>;
  /** Override the claude binary name/path for the subscription CLI path. */
  bin?: string;
  /** Injectable `claude -p` runner for tests. */
  runClaudeCli?: (args: string[], stdin: string) => Promise<string>;
  /** Max subcommands to define in one pass. Default 12. */
  maxCommands?: number;
  /**
   * Replay a learned def's declared `tests[]` through a real runtime to PROVE
   * its risk/policy classification, not just its schema. Injected (not imported)
   * so the agent package stays runtime-free; the CLI wires a verifier backed by
   * an ephemeral runtime carrying the learned defs as a custom layer.
   *
   * Given the accepted defs, returns one {@link TestVerification} per def id. A
   * def with no `tests[]` should report `{ ran: 0 }`. When omitted, learning is
   * schema-only (the prior behavior) and `verification` is left undefined.
   */
  verify?: (defs: CommandDef[]) => Promise<Record<string, TestVerification>>;
}

/** The outcome of replaying one def's declared tests through the runtime. */
export interface TestVerification {
  /** How many `tests[]` entries were replayed. */
  ran: number;
  /** How many matched their expected risk/policy. */
  passed: number;
  /** Human-readable failure descriptions (empty when all passed). */
  failures: string[];
}

/** One learned (or rejected) command, with provenance for review. */
export interface LearnedCommand {
  /** The proposed IDEL command id, e.g. `create.gh.pr`. */
  id: string;
  /** The validated def, or null if it failed schema validation. */
  def: CommandDef | null;
  /** Schema errors when `def` is null. */
  errors: string[];
  /**
   * Test-replay result for this def, when a verifier was supplied AND the def
   * passed schema validation. Undefined for schema-only learning or rejected
   * defs. A def whose tests failed is still listed (with failures) but is
   * EXCLUDED from {@link LearnResult.accepted} — fail-closed.
   */
  verification?: TestVerification;
}

export interface LearnResult {
  cli: string;
  /** The raw help text that was introspected (truncated to the cap). */
  helpExcerpt: string;
  /** Every command the generator proposed, valid and invalid. */
  commands: LearnedCommand[];
  /** The valid defs only — what would be written to the draft layer. */
  accepted: CommandDef[];
}

/**
 * Capture `<cli> --help` output without executing any real subcommand. Spawns
 * with `shell:false` (no shell interpolation), a timeout, and an output cap.
 * Tries each help variant until one produces output.
 */
export async function captureHelp(cli: string): Promise<string> {
  // Defense in depth: the CLI name must look like a plain executable name, not
  // a path or a string with shell metacharacters. We never pass it to a shell
  // (shell:false), but reject obviously hostile input early and loudly.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(cli)) {
    throw new Error(
      `refusing to introspect "${cli}": a CLI name may only contain letters, digits, and . _ + -`,
    );
  }

  for (const args of HELP_VARIANTS) {
    const out = await runCapture(cli, args).catch(() => "");
    if (out.trim()) return out.slice(0, MAX_HELP_BYTES);
  }
  throw new Error(
    `could not capture help for "${cli}" — is it installed and on PATH? ` +
      `(tried: ${HELP_VARIANTS.map((v) => `${cli} ${v.join(" ")}`).join(", ")})`,
  );
}

/** Spawn one help invocation, capturing stdout+stderr, bounded by time and size. */
function runCapture(cli: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveCapture, reject) => {
    const child = spawn(cli, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let killed = false;
    const onChunk = (c: Buffer): void => {
      buf += c.toString("utf8");
      if (buf.length > MAX_HELP_BYTES) {
        killed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", onChunk);
    // Many CLIs print help to stderr; capture both.
    child.stderr.on("data", onChunk);
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, HELP_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // A killed-by-cap run still yields the bytes we captured.
      resolveCapture(killed ? buf : buf);
    });
  });
}

/**
 * Learn a CLI: introspect, generate draft defs, validate each one.
 * Returns both accepted and rejected proposals — the CLI layer decides what to
 * write and what to report.
 */
export async function learnCli(
  cli: string,
  opts: LearnOptions = {},
): Promise<LearnResult> {
  const capture = opts.capture ?? captureHelp;
  const model = opts.model ?? LEARN_MODEL;
  const maxCommands = opts.maxCommands ?? 12;

  const help = await capture(cli);
  const raw = await generateDefs(cli, help, maxCommands, model, opts);

  const proposed = parseDefs(raw);
  const commands: LearnedCommand[] = [];

  // Pass 1 — schema validation (fail-closed). Anything invalid is dropped here.
  for (const item of proposed) {
    const id = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "<no id>";
    const { ok, errors } = checkCommandDef(item);
    if (ok) {
      // checkCommandDef narrows to CommandDef on ok; re-tag the draft layer.
      const def = { ...(item as CommandDef), source: "custom" as const };
      const idErrors = validateLearnedCommandId(cli, def.id);
      if (idErrors.length) {
        commands.push({ id: def.id, def: null, errors: idErrors });
      } else {
        commands.push({ id: def.id, def, errors: [] });
      }
    } else {
      commands.push({ id, def: null, errors });
    }
  }

  // Pass 2 — test replay (when a verifier is wired). Replay each schema-valid
  // def's declared tests[] through a real runtime and prove its risk/policy.
  // A def whose tests FAIL is kept in `commands` (with its failures) but is
  // excluded from `accepted` — a learned def that misclassifies is not trusted.
  const schemaValid = commands.filter((c) => c.def).map((c) => c.def!);
  if (opts.verify && schemaValid.length) {
    const verifications = await opts.verify(schemaValid);
    for (const cmd of commands) {
      if (!cmd.def) continue;
      cmd.verification = verifications[cmd.def.id] ?? { ran: 0, passed: 0, failures: [] };
    }
  }

  // A def is accepted iff it is schema-valid AND (no verifier ran, OR its tests
  // all passed). `ran === 0` (no tests declared) does not block acceptance.
  const accepted = commands
    .filter((c) => c.def && (!c.verification || c.verification.failures.length === 0))
    .map((c) => c.def!);

  return { cli, helpExcerpt: help.slice(0, 2000), commands, accepted };
}

async function generateDefs(
  cli: string,
  help: string,
  maxCommands: number,
  model: string,
  opts: LearnOptions,
): Promise<string> {
  if (opts.client) {
    const prompt = learnPrompt(cli, help, maxCommands);
    const client = opts.client;
    const res = await client.messages.create({
      model,
      max_tokens: 8000,
      system: [{ type: "text", text: LEARN_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  if (opts.runClaudeCli) {
    const prompt = learnPrompt(cli, help, maxCommands);
    return await generateDefsWithClaudeCli(prompt, {
      bin: opts.bin ?? "claude",
      model: opts.model,
      run: opts.runClaudeCli,
    });
  }

  if (opts.bin) {
    return await generateDefsWithInstalledClaude(cli, help, maxCommands, model, opts);
  }

  return JSON.stringify(generateLocalDefs(cli, help, maxCommands));
}

function generateDefsWithInstalledClaude(
  cli: string,
  help: string,
  maxCommands: number,
  model: string,
  opts: LearnOptions,
): Promise<string> {
  const prompt = learnPrompt(cli, help, maxCommands);
  return generateDefsWithClaudeCli(prompt, {
    bin: opts.bin ?? "claude",
    model,
  });
}

async function generateDefsWithClaudeCli(
  prompt: string,
  opts: {
    bin: string;
    model: string | undefined;
    run?: (args: string[], stdin: string) => Promise<string>;
  },
): Promise<string> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--append-system-prompt",
    LEARN_SYSTEM,
  ];
  if (opts.model) args.push("--model", opts.model);
  const run = opts.run ?? ((a, stdin) => spawnClaudeForLearn(opts.bin, a, stdin));
  return await run(args, prompt);
}

function spawnClaudeForLearn(bin: string, args: string[], stdin: string): Promise<string> {
  return new Promise<string>((resolveSpawn, reject) => {
    const env = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];

    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      return reject(claudeSpawnError(bin, err));
    }

    let out = "";
    let errOut = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${LEARN_CLI_TIMEOUT_MS}ms`));
    }, LEARN_CLI_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (errOut += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(claudeSpawnError(bin, err));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(`claude CLI exited ${code}: ${errOut.trim() || out.trim() || "no output"}`),
        );
      }
      try {
        const json = JSON.parse(out) as ClaudeCliJson;
        if (json.is_error) {
          reject(
            new Error(
              `claude CLI error${json.subtype ? ` (${json.subtype})` : ""}: ${json.result ?? "unknown"}`,
            ),
          );
          return;
        }
        resolveSpawn(json.result ?? "");
      } catch {
        reject(new Error(`claude CLI returned non-JSON output: ${out.slice(0, 200)}`));
      }
    });

    child.stdin.end(stdin);
  });
}

function claudeSpawnError(bin: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return new Error(
      `the "${bin}" CLI is not installed or not on PATH. Install Claude Code and run \`claude login\`, ` +
        `or set ANTHROPIC_API_KEY to use the API instead.`,
    );
  }
  return new Error(`failed to spawn "${bin}": ${e?.message ?? String(err)}`);
}

/**
 * Extract the JSON array of defs from the model's reply. The model is told to
 * emit a single fenced ```json block; we also tolerate a bare array. Anything
 * unparseable yields an empty list (fail-closed: nothing learned beats wrong).
 */
function parseDefs(raw: string): unknown[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  // A single object is also acceptable.
  return parsed && typeof parsed === "object" ? [parsed] : [];
}

interface HelpCommand {
  name: string;
  summary: string;
}

interface LocalTemplate {
  action: string;
  object?: string;
  summary?: string;
  risk: RiskLevel;
  params: CommandDef["params"];
  args: AdapterArgSpec[];
  safety?: CommandDef["safety"];
  testParams?: Record<string, string | number | boolean>;
}

const HELP_COMMAND_RE = /^\s{2,}([A-Za-z][A-Za-z0-9-]{0,39}):?\s{2,}(.+?)\s*$/;

function generateLocalDefs(
  cli: string,
  help: string,
  maxCommands: number,
): CommandDef[] {
  const tool = cliIdSegment(cli);
  if (!tool) return [];

  const defs: CommandDef[] = [];
  const seen = new Set<string>();
  for (const cmd of parseHelpCommands(help)) {
    const template = templateForHelpCommand(cmd);
    if (!template) continue;

    const id = localCommandId(tool, cmd.name, template);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const adapterArgs: AdapterArgSpec[] = [
      { kind: "literal", value: cmd.name },
      ...template.args,
    ];
    const def: CommandDef = {
      id,
      version: "0.1.0",
      summary: sentence(template.summary ?? (cmd.summary || `Run ${cli} ${cmd.name}.`)),
      category: tool,
      riskDefault: template.risk,
      params: template.params,
      ...(template.safety ? { safety: template.safety } : {}),
      adapters: {
        posix: {
          command: cli,
          args: adapterArgs,
          semanticNotes:
            "Generated locally from top-level help. Review command-specific flags before promoting to an official registry.",
        },
      },
      examples: [renderLearnedInput(id, template.testParams ?? {})],
      tests: [
        {
          input: renderLearnedInput(id, template.testParams ?? {}),
          expectRisk: template.risk,
        },
      ],
    };
    defs.push(def);
    if (defs.length >= maxCommands) break;
  }
  return defs;
}

function parseHelpCommands(help: string): HelpCommand[] {
  const out: HelpCommand[] = [];
  const seen = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    const match = HELP_COMMAND_RE.exec(line);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (seen.has(name) || name === "usage" || name === "options") continue;
    const summary = sentence(match[2]!.trim());
    if (!summary || /^(and|or)\s+/i.test(summary)) continue;
    seen.add(name);
    out.push({ name, summary });
  }
  return out;
}

function templateForHelpCommand(cmd: HelpCommand): LocalTemplate | undefined {
  const summary = cmd.summary.toLowerCase();
  switch (cmd.name) {
    case "auth":
      return {
        action: "show",
        object: "auth",
        summary: "Show GitHub CLI authentication status.",
        risk: "LOW",
        params: {},
        args: [{ kind: "literal", value: "status" }],
      };
    case "browse":
      return {
        action: "open",
        object: "browse",
        summary: "Open the current GitHub repository in the browser.",
        risk: "LOW",
        params: {
          target: { type: "string", description: "Optional repository, issue, pull request, or URL target." },
        },
        args: [{ kind: "value", param: "target" }],
      };
    case "codespace":
      return ghListTemplate("codespace", "List GitHub Codespaces.");
    case "gist":
      return ghListTemplate("gist", "List GitHub gists.");
    case "issue":
      return ghListTemplate("issue", "List GitHub issues.");
    case "pr":
      return ghListTemplate("pr", "List GitHub pull requests.");
    case "release":
      return ghListTemplate("release", "List GitHub releases.");
    case "repo":
      return {
        action: "show",
        object: "repo",
        summary: "Show GitHub repository details.",
        risk: "LOW",
        params: {
          repository: { type: "string", description: "Optional OWNER/REPO repository." },
        },
        args: [
          { kind: "literal", value: "view" },
          { kind: "value", param: "repository" },
        ],
      };
    case "run":
      return ghListTemplate("run", "List GitHub Actions workflow runs.");
    case "workflow":
      return ghListTemplate("workflow", "List GitHub Actions workflows.");
    case "cache":
      return ghListTemplate("cache", "List GitHub Actions caches.");
    case "label":
      return ghListTemplate("label", "List GitHub labels.");
    case "secret":
      return ghListTemplate("secret", "List GitHub secrets.");
    case "variable":
      return ghListTemplate("variable", "List GitHub Actions variables.");
    case "clone":
      return {
        action: "clone",
        object: "repo",
        risk: "MEDIUM",
        params: {
          url: { type: "string", required: true, description: "Repository URL to clone." },
          directory: { type: "path", description: "Optional destination directory." },
        },
        args: [{ kind: "value", param: "url" }, { kind: "value", param: "directory" }],
        testParams: { url: "https://example.invalid/repo.git" },
      };
    case "init":
      return {
        action: "init",
        object: "repo",
        risk: "MEDIUM",
        params: { path: { type: "path", description: "Optional repository directory." } },
        args: [{ kind: "value", param: "path" }],
      };
    case "add":
      return {
        action: "add",
        object: "file",
        risk: "MEDIUM",
        params: { path: { type: "path", required: true, description: "Path to stage." } },
        args: [{ kind: "value", param: "path" }],
        testParams: { path: "." },
      };
    case "mv":
    case "move":
      return {
        action: "move",
        object: "file",
        risk: "MEDIUM",
        params: {
          from: { type: "path", required: true, description: "Source path." },
          to: { type: "path", required: true, description: "Destination path." },
        },
        args: [{ kind: "value", param: "from" }, { kind: "value", param: "to" }],
        safety: { targetParam: "to" },
        testParams: { from: "old.txt", to: "new.txt" },
      };
    case "restore":
      return {
        action: "restore",
        object: "file",
        risk: "HIGH",
        params: { path: { type: "path", required: true, description: "Path to restore." } },
        args: [{ kind: "value", param: "path" }],
        safety: { destructive: true, targetParam: "path" },
        testParams: { path: "file.txt" },
      };
    case "rm":
    case "remove":
    case "delete":
      return {
        action: "remove",
        object: "file",
        risk: "HIGH",
        params: {
          path: { type: "path", required: true, description: "Path to remove." },
          recursive: { type: "boolean", default: false, description: "Pass recursive removal flag." },
          force: { type: "boolean", default: false, description: "Pass force flag." },
        },
        args: [
          { kind: "flag", flag: "-r", when: "recursive" },
          { kind: "flag", flag: "-f", when: "force" },
          { kind: "value", param: "path" },
        ],
        safety: {
          destructive: true,
          targetParam: "path",
          requiresAffectedPathEstimate: true,
        },
        testParams: { path: "file.txt" },
      };
    case "status":
      return lowNoArg("show", "status", "Show the working tree status.");
    case "diff":
      return lowNoArg("diff", undefined, "Show changes.");
    case "grep":
      return {
        action: "find",
        object: "text",
        risk: "LOW",
        params: { pattern: { type: "string", required: true, description: "Pattern to search for." } },
        args: [{ kind: "value", param: "pattern" }],
        testParams: { pattern: "TODO" },
      };
    case "log":
      return lowNoArg("list", "log", "Show commit logs.");
    case "show":
      return {
        action: "show",
        object: "object",
        risk: "LOW",
        params: { ref: { type: "string", description: "Optional object, ref, or revision." } },
        args: [{ kind: "value", param: "ref" }],
      };
    case "branch":
      return lowNoArg("list", "branch", "List branches.");
    case "commit":
      return {
        action: "create",
        object: "commit",
        risk: "MEDIUM",
        params: { message: { type: "string", required: true, description: "Commit message for -m." } },
        args: [{ kind: "option", flag: "-m", param: "message" }],
        testParams: { message: "update" },
      };
    case "merge":
      return stringArg("merge", "branch", "HIGH", "branch", "Branch to merge.");
    case "rebase":
      return stringArg("rebase", "branch", "HIGH", "branch", "Branch to rebase onto.");
    case "reset":
      return {
        action: "reset",
        object: "head",
        risk: "HIGH",
        params: {
          hard: { type: "boolean", default: false, description: "Pass --hard." },
          ref: { type: "string", default: "HEAD", description: "Ref to reset to." },
        },
        args: [{ kind: "flag", flag: "--hard", when: "hard" }, { kind: "value", param: "ref" }],
        safety: { destructive: true },
        testParams: { ref: "HEAD" },
      };
    case "switch":
    case "checkout":
      return stringArg("switch", "branch", "MEDIUM", "branch", "Branch to switch to.");
    case "tag":
      return lowNoArg("list", "tag", "List tags.");
    case "fetch":
      return stringArg("fetch", undefined, "MEDIUM", "remote", "Optional remote to fetch.");
    case "pull":
      return {
        action: "pull",
        risk: "MEDIUM",
        params: {
          remote: { type: "string", description: "Optional remote." },
          branch: { type: "string", description: "Optional branch." },
        },
        args: [{ kind: "value", param: "remote" }, { kind: "value", param: "branch" }],
      };
    case "push":
      return {
        action: "push",
        risk: "HIGH",
        params: {
          remote: { type: "string", description: "Optional remote." },
          branch: { type: "string", description: "Optional branch." },
        },
        args: [{ kind: "value", param: "remote" }, { kind: "value", param: "branch" }],
      };
  }

  if (/^(show|display|print|view)\b/.test(summary)) return lowNoArg("show", cmd.name);
  if (/^(list)\b/.test(summary)) return lowNoArg("list", cmd.name);
  if (/^(search)\b/.test(summary)) return stringArg("search", cmd.name, "LOW", "query", "Search query.");
  return undefined;
}

function ghListTemplate(object: string, summary: string): LocalTemplate {
  return {
    action: "list",
    object,
    summary,
    risk: "LOW",
    params: {},
    args: [{ kind: "literal", value: "list" }],
  };
}

function lowNoArg(action: string, object?: string, summary?: string): LocalTemplate {
  return {
    action,
    ...(object ? { object } : {}),
    ...(summary ? { summary } : {}),
    risk: "LOW",
    params: {},
    args: [],
  };
}

function stringArg(
  action: string,
  object: string | undefined,
  risk: RiskLevel,
  name: string,
  description: string,
): LocalTemplate {
  return {
    action,
    ...(object ? { object } : {}),
    risk,
    params: { [name]: { type: "string", required: true, description } },
    args: [{ kind: "value", param: name }],
    testParams: { [name]: sampleStringParam(name) },
  };
}

function localCommandId(
  tool: string,
  commandName: string,
  template: LocalTemplate,
): string | undefined {
  const action = idSegment(template.action);
  const object = template.object ? idSegment(template.object) : undefined;
  const command = idSegment(commandName);
  if (!action || !command) return undefined;
  const parts = [action, tool];
  if (object && object !== tool) {
    parts.push(object);
  } else if (command !== action) {
    parts.push(command);
  }
  const id = parts.slice(0, 4).join(".");
  return ID_RE.test(id) ? id : undefined;
}

function idSegment(raw: string): string | undefined {
  const seg = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!seg) return undefined;
  return /^[a-z]/.test(seg) ? seg : `x${seg}`;
}

function renderLearnedInput(
  id: string,
  params: Record<string, string | number | boolean>,
): string {
  const rendered = Object.entries(params).map(
    ([key, value]) => `${key}=${quoteLearnedValue(value)}`,
  );
  return rendered.length ? `${id} ${rendered.join(" ")}` : id;
}

function quoteLearnedValue(value: string | number | boolean): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return /[\s"'\\&=]/.test(value)
    ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : value;
}

function sampleStringParam(name: string): string {
  if (name === "branch") return "main";
  if (name === "remote") return "origin";
  return "value";
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function cliIdSegment(cli: string): string {
  return idSegment(cli) ?? "";
}

function validateLearnedCommandId(cli: string, id: string): string[] {
  const tool = cliIdSegment(cli);
  if (!tool) return [];
  const segments = id.split(".");
  const errors: string[] = [];
  if (segments[0] === tool) {
    errors.push(
      `id: learned command ids must be verb-first; use "show.${tool}.status" instead of "${tool}.status"`,
    );
  }
  if (!segments.slice(1).includes(tool)) {
    errors.push(
      `id: learned command ids must include the CLI segment "${tool}" after the verb`,
    );
  }
  return errors;
}

function learnPrompt(cli: string, help: string, maxCommands: number): string {
  const tool = cliIdSegment(cli);
  return [
    `The user has the CLI "${cli}" installed. Below is its help text.`,
    `Propose up to ${maxCommands} IDEL command definitions for its most useful, common subcommands.`,
    "",
    "Rules:",
    "- Every command id MUST be verb-first: the first segment is the action, not the CLI name.",
    `  Use "${tool}" as the tool segment after the verb, e.g. "show.${tool}.status",`,
    `  "list.${tool}.branch", or "create.${tool}.repo". Never emit "${tool}.status".`,
    "  Use dotted lowercase segments matching the regex " + ID_RE.source + ".",
    "- Map each subcommand to ONE adapter spec under \"adapters.posix\" (and powershell if you",
    "  know the Windows equivalent). Build argv declaratively with the arg-spec union —",
    "  never string templates.",
    "- Classify riskDefault honestly: a delete/prune/rm-shaped subcommand is HIGH; anything",
    "  that can target a whole system or force-destroys is CRITICAL; status/list/get is LOW.",
    "- If a subcommand is destructive, set safety.destructive = true and name the target param.",
    "- Include a one-line summary, a category (the CLI name is fine), realistic params with",
    "  types (string | boolean | number | path | mode), and 1-2 examples.",
    "- For EACH command, include a `tests` array with 1-2 entries asserting its",
    "  classification: { input: \"<a full command line>\", expectRisk: \"<LEVEL>\" }. These are",
    "  replayed through the real runtime to PROVE your riskDefault — a def whose tests do not",
    "  match the runtime's classification is rejected, so make the expectation match how you",
    "  classified the command (a destructive test input should expect HIGH or CRITICAL).",
    "- Prefer correctness over coverage. Skip a subcommand rather than guess its flags.",
    "",
    "Reply with ONLY a single fenced ```json block containing a JSON array of CommandDef",
    "objects. No prose before or after.",
    "",
    `--- ${cli} help ---`,
    help,
  ].join("\n");
}

const LEARN_SYSTEM = [
  "You translate an installed CLI's help text into IDEL CommandDef JSON objects.",
  "",
  "An IDEL CommandDef has this shape (TypeScript):",
  "  {",
  "    id: string;            // dotted lowercase and verb-first, e.g. \"create.gh.pr\"",
  "    version: string;       // semver, use \"0.1.0\" for a learned draft",
  "    summary: string;",
  "    category: string;",
  "    riskDefault: \"LOW\" | \"MEDIUM\" | \"HIGH\" | \"CRITICAL\";",
  "    params: Record<string, {",
  "      type: \"string\"|\"boolean\"|\"number\"|\"path\"|\"mode\";",
  "      required?: boolean; default?: string|number|boolean;",
  "      enum?: (string|number|boolean)[]; description?: string;",
  "    }>;",
  "    allowExtraArgs?: boolean;",
  "    safety?: { destructive?: boolean; targetParam?: string;",
  "               requiresAffectedPathEstimate?: boolean; blockTargets?: string[]; };",
  "    adapters: { posix?: AdapterSpec; powershell?: AdapterSpec; node?: AdapterSpec };",
  "    examples?: string[];",
  "    tests?: { input: string; expectRisk?: \"LOW\"|\"MEDIUM\"|\"HIGH\"|\"CRITICAL\"; expectPolicy?: string }[];",
  "  }",
  "",
  "An AdapterSpec is { command: string; args: AdapterArgSpec[]; semanticNotes?: string }.",
  "An AdapterArgSpec is exactly one of:",
  "  { kind: \"literal\"; value: string }            // a fixed argv token",
  "  { kind: \"value\"; param: string }              // the value of a param, positional",
  "  { kind: \"option\"; flag: string; param: string } // a flag then its value (two tokens)",
  "  { kind: \"flag\"; flag: string; when: string }  // the flag only when boolean param `when` is true",
  "",
  "Be conservative and honest about risk. The runtime will independently re-classify and",
  "may BLOCK or require approval regardless of what you set — your riskDefault is a hint,",
  "not an override. Output valid JSON only.",
].join("\n");
