import { spawn } from "node:child_process";

import type Anthropic from "@anthropic-ai/sdk";

/**
 * A Claude provider abstracts HOW the agent reaches Claude, so the IdelAgent
 * loop is auth-agnostic. Two implementations:
 *
 *  - {@link AnthropicApiProvider} — the developer API via `@anthropic-ai/sdk`,
 *    authenticated by ANTHROPIC_API_KEY, billed per token. Native tool-use loop.
 *  - {@link ClaudeCliProvider} — shells out to the installed `claude` CLI in
 *    headless mode (`claude -p`), authenticated by the user's Pro/Max
 *    SUBSCRIPTION login (no API key). The CLI returns a final text answer rather
 *    than exposing the tool-call protocol, so this provider asks Claude to emit
 *    IDEL command lines as structured text; the IdelAgent treats each as a
 *    proposed command and runs it through the runtime, then feeds the outcome
 *    back via `--resume` so Claude can adapt — the same loop, different transport.
 *
 * The runtime stays the enforcement boundary in BOTH cases: whatever Claude
 * proposes is parsed → classified → policy-checked → executed-or-refused →
 * audited. The provider only decides where the proposal text comes from.
 */

/** What the model wants to do this turn, normalized across providers. */
export interface ProviderTurn {
  /** Prose to surface to the user (may be empty). */
  text: string;
  /** IDEL command lines the model proposes to run this turn. */
  commands: ProviderCommand[];
  /** True when the model is done (no further commands; end the loop). */
  done: boolean;
}

export interface ProviderCommand {
  /** The IDEL command line, e.g. `remove.folder name=dist recursive=true`. */
  command: string;
  /** Whether the model asked for a real run (false) or a dry run (true/omitted). */
  dryRun?: boolean;
}

/**
 * One step of the conversation. `priorOutcomes` carries the JSON results of the
 * commands run in the PREVIOUS turn back to the model (empty on the first turn).
 * The provider returns the model's next turn.
 */
export interface ProviderStep {
  /** The user's natural-language intent (first turn) or empty on follow-ups. */
  userIntent: string;
  /** Results of commands executed since the last turn, fed back to the model. */
  priorOutcomes: { command: string; outcomeJson: string }[];
}

export interface ClaudeProvider {
  /** Stable name for diagnostics ("claude-cli" | "anthropic-api"). */
  readonly name: string;
  /** Advance the conversation one turn. */
  next(step: ProviderStep): Promise<ProviderTurn>;
}

// ---------------------------------------------------------------------------
// Claude CLI (subscription) provider
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 120_000;

/** Result shape we parse from `claude -p --output-format json`. */
interface ClaudeCliJson {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
}

/** What the IDEL system prompt instructs `claude` to emit as its result text. */
interface ClaudePlan {
  commands?: { command?: unknown; dryRun?: unknown }[];
  explanation?: string;
  done?: boolean;
}

export interface ClaudeCliOptions {
  /** Path/name of the claude binary. Default "claude" (resolved on PATH). */
  bin?: string;
  /** Model alias/id passed via --model (e.g. "opus"). */
  model?: string;
  /** The IDEL system prompt (catalog + contract), appended to Claude's default. */
  system: string;
  /**
   * Spawn function, injectable for tests. Defaults to a real `claude` subprocess.
   * Given (args, stdin) returns the parsed CLI JSON. Throws on spawn failure.
   */
  run?: (args: string[], stdin: string) => Promise<ClaudeCliJson>;
}

/**
 * Drives the installed `claude` CLI in headless JSON mode using the user's
 * subscription. Carries the conversation across turns with the CLI's own
 * `--resume <session_id>` so the model adapts to each command's outcome.
 */
export class ClaudeCliProvider implements ClaudeProvider {
  readonly name = "claude-cli";
  private readonly bin: string;
  private readonly model: string | undefined;
  private readonly system: string;
  private readonly run: (args: string[], stdin: string) => Promise<ClaudeCliJson>;
  private sessionId: string | undefined;

  constructor(opts: ClaudeCliOptions) {
    this.bin = opts.bin ?? "claude";
    this.model = opts.model;
    this.system = opts.system;
    this.run = opts.run ?? ((args, stdin) => spawnClaude(this.bin, args, stdin));
  }

  async next(step: ProviderStep): Promise<ProviderTurn> {
    const prompt = this.buildPrompt(step);
    const args = [
      "-p",
      "--output-format",
      "json",
      // Pure text — Claude must NOT touch the filesystem or run shell commands;
      // the IDEL runtime is the only thing that executes. Disable all tools.
      "--tools",
      "",
      "--append-system-prompt",
      this.system,
    ];
    if (this.model) args.push("--model", this.model);
    // Resume the same conversation so the model sees its own history + the
    // outcomes we fed back, instead of starting fresh each turn.
    if (this.sessionId) args.push("--resume", this.sessionId);

    const json = await this.run(args, prompt);
    if (json.session_id) this.sessionId = json.session_id;
    if (json.is_error) {
      throw new Error(`claude CLI error${json.subtype ? ` (${json.subtype})` : ""}: ${json.result ?? "unknown"}`);
    }
    return parsePlan(json.result ?? "");
  }

  private buildPrompt(step: ProviderStep): string {
    if (step.priorOutcomes.length === 0) return step.userIntent;
    // Follow-up turn: report what happened so the model can adapt or finish.
    const lines = step.priorOutcomes.map(
      (o) => `Command: ${o.command}\nResult: ${o.outcomeJson}`,
    );
    return [
      "Here are the results of the commands you proposed. Adapt if needed, or set",
      "done:true if the task is complete.",
      "",
      ...lines,
    ].join("\n");
  }
}

/**
 * Parse the model's result text into a normalized turn. The IDEL system prompt
 * asks `claude` to reply with a JSON object `{ commands: [...], explanation,
 * done }`. We tolerate a fenced block or bare JSON; a reply with no parseable
 * commands is treated as a final text answer (done).
 */
function parsePlan(resultText: string): ProviderTurn {
  const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? resultText).trim();
  let plan: ClaudePlan | undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") plan = parsed as ClaudePlan;
  } catch {
    // Not JSON — treat the whole reply as prose and finish.
    return { text: resultText.trim(), commands: [], done: true };
  }

  const commands: ProviderCommand[] = [];
  for (const c of plan?.commands ?? []) {
    if (c && typeof c.command === "string" && c.command.trim()) {
      commands.push({
        command: c.command.trim(),
        dryRun: typeof c.dryRun === "boolean" ? c.dryRun : undefined,
      });
    }
  }
  // Done when the model says so, or when it proposed nothing to run.
  const done = plan?.done === true || commands.length === 0;
  return { text: (plan?.explanation ?? "").trim(), commands, done };
}

/** Spawn the real `claude` CLI, capture stdout, parse the JSON result. */
function spawnClaude(bin: string, args: string[], stdin: string): Promise<ClaudeCliJson> {
  return new Promise<ClaudeCliJson>((resolveSpawn, reject) => {
    // Force SUBSCRIPTION auth: a stray ANTHROPIC_API_KEY would take precedence
    // in the child and silently bill per-token instead of the user's plan.
    const env = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];

    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      return reject(spawnError(bin, err));
    }

    let out = "";
    let errOut = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (errOut += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(spawnError(bin, err));
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(`claude CLI exited ${code}: ${errOut.trim() || out.trim() || "no output"}`),
        );
      }
      try {
        resolveSpawn(JSON.parse(out) as ClaudeCliJson);
      } catch {
        reject(new Error(`claude CLI returned non-JSON output: ${out.slice(0, 200)}`));
      }
    });

    child.stdin.end(stdin);
  });
}

function spawnError(bin: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return new Error(
      `the "${bin}" CLI is not installed or not on PATH. Install Claude Code and run \`claude login\`, ` +
        `or set ANTHROPIC_API_KEY to use the API instead.`,
    );
  }
  return new Error(`failed to spawn "${bin}": ${e?.message ?? String(err)}`);
}

// ---------------------------------------------------------------------------
// Anthropic API (SDK) provider
// ---------------------------------------------------------------------------

/**
 * Wraps the existing SDK tool-use loop as a provider. Unlike the CLI provider,
 * this exposes Claude's native tool calls, so the IdelAgent's richer multi-tool
 * loop (complete_idel / explain_command / read_logs) is preserved on this path.
 * The IdelAgent uses the SDK directly when this provider is selected; this class
 * exists mainly so provider SELECTION is uniform and the API client is carried
 * in one place.
 */
export class AnthropicApiProvider {
  readonly name = "anthropic-api";
  constructor(readonly client: Anthropic) {}
}
