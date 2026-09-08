import Anthropic from "@anthropic-ai/sdk";
import { ServiceError, type TerminalService } from "@openexecution/server";
import type { RuntimeOutcome } from "@openexecution/types";

import {
  isModelProposedNative,
  MODEL_NATIVE_REJECTION,
} from "./command-boundary.js";
import { AGENT_TOOLS, systemPrompt } from "./tools.js";

/**
 * Default model for command planning. The best coding/agent model — see the
 * Claude API reference. Override per-construction for cost-sensitive paths
 * (e.g. claude-haiku-4-5 for a one-shot NL→IDEL translation with no tool loop).
 */
const DEFAULT_MODEL = "claude-opus-4-8";

/** A streamed step the loop emits so a UI (CLI or SSE) can show progress. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "proposed"; command: string; dryRun: boolean; outcome: RuntimeOutcome }
  | { type: "blocked"; command: string; outcome: RuntimeOutcome }
  | { type: "needs_approval"; command: string; outcome: RuntimeOutcome }
  | { type: "tool_error"; tool: string; message: string }
  | { type: "done"; reason: "end_turn" | "max_steps" }
  | { type: "error"; message: string };

/**
 * Asks the human to approve a real (non-dry-run) execution of a command Claude
 * proposed. The agent never auto-approves — confirmation always comes from the
 * human. Returning false means "do not run it for real" (the dry-run result
 * already stands as the answer).
 */
export type AgentApproval = (info: {
  command: string;
  outcome: RuntimeOutcome;
}) => Promise<boolean>;

export interface AgentOptions {
  service: TerminalService;
  /** Anthropic client. Reads ANTHROPIC_API_KEY from the env by default. */
  client?: Anthropic;
  /** Explicit host-side key, used by the authenticated terminal setup dialog. */
  apiKey?: string;
  /** Override the planning model. Defaults to claude-opus-4-8. */
  model?: string;
  /**
   * Gate for promoting a dry-run to a real run. When omitted, the agent stays in
   * propose-only mode: it dry-runs every command and never executes for real.
   * Provide this to let a confirmed command actually touch the filesystem.
   */
  approve?: AgentApproval;
  /** Safety cap on tool-use rounds per ask(). Default 12. */
  maxSteps?: number;
}

/**
 * The IDEL agent: a thin, manual tool-use loop over {@link TerminalService}.
 *
 * Every command Claude proposes is run through `service.run(..., origin:"agent")`
 * — the same pipeline the CLI and web terminal use — so safety, policy, and
 * signed OpenLogs are byte-identical to a human-typed command, and the audit
 * trail records `source:"agent"`. After setup, the Anthropic credential lives
 * only in this host-side instance. A setup form may transmit it once over the
 * authenticated loopback boundary, then clears its input without persisting it.
 */
export class IdelAgent {
  private readonly service: TerminalService;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly approve: AgentApproval | undefined;
  private readonly maxSteps: number;
  private readonly system: Anthropic.TextBlockParam[];

  constructor(opts: AgentOptions) {
    this.service = opts.service;
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : undefined);
    this.model = opts.model ?? DEFAULT_MODEL;
    this.approve = opts.approve;
    this.maxSteps = opts.maxSteps ?? 12;
    // The catalog is the frozen, cacheable prefix — mark it for prompt caching so
    // the (large) registry vocabulary is not re-billed every turn.
    this.system = [
      {
        type: "text",
        text: systemPrompt(this.service),
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  /**
   * Run one natural-language request to completion, yielding events as it goes.
   *
   * `approve` is an optional per-call real-run gate. When provided it OVERRIDES
   * the constructor-time `approve` for this call — the server uses this to inject
   * a gate that round-trips to the browser, while the CLI passes its gate at
   * construction. When neither is set, the agent stays propose/dry-run only.
   *
   * `messages` is carried across calls by the caller if it wants a multi-turn
   * conversation; the simplest use is a fresh ask each time.
   */
  async *ask(
    userIntent: string,
    approve?: AgentApproval,
    messages: Anthropic.MessageParam[] = [],
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const gate = approve ?? this.approve;
    messages.push({ role: "user", content: userIntent });

    for (let step = 0; step < this.maxSteps; step++) {
      let res: Anthropic.Message;
      try {
        res = await this.client.messages.create({
          model: this.model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: this.system,
          tools: AGENT_TOOLS,
          messages,
        });
      } catch (err) {
        yield { type: "error", message: anthropicError(err) };
        return;
      }

      messages.push({ role: "assistant", content: res.content });

      // Surface any prose Claude emitted alongside its tool calls.
      for (const block of res.content) {
        if (block.type === "text" && block.text.trim()) {
          yield { type: "text", text: block.text };
        }
      }

      if (res.stop_reason !== "tool_use") {
        yield { type: "done", reason: "end_turn" };
        return;
      }

      // Execute each requested tool and collect results for the next turn.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        const { result, event } = await this.dispatch(block, gate);
        if (event) yield event;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    yield { type: "done", reason: "max_steps" };
  }

  /** Route one tool_use block to the matching service call. */
  private async dispatch(
    block: Anthropic.ToolUseBlock,
    gate: AgentApproval | undefined,
  ): Promise<{ result: { content: string; isError?: boolean }; event?: AgentEvent }> {
    try {
      switch (block.name) {
        case "run_idel":
          return await this.runIdel(block.input as { command: string; dryRun?: boolean }, gate);
        case "complete_idel": {
          const { input } = block.input as { input: string };
          return { result: { content: JSON.stringify(this.service.complete({ input })) } };
        }
        case "explain_command": {
          const { commandId } = block.input as { commandId: string };
          return { result: { content: JSON.stringify(this.service.explain(commandId)) } };
        }
        case "read_logs": {
          const { limit } = block.input as { limit?: number };
          return { result: { content: JSON.stringify(await this.service.logs(limit ?? 20)) } };
        }
        default:
          return {
            result: { content: `Unknown tool: ${block.name}`, isError: true },
            event: { type: "tool_error", tool: block.name, message: "unknown tool" },
          };
      }
    } catch (err) {
      const message = err instanceof ServiceError ? err.message : String((err as Error)?.message ?? err);
      return {
        result: { content: `Tool error: ${message}`, isError: true },
        event: { type: "tool_error", tool: block.name, message },
      };
    }
  }

  /**
   * The core action. Always classifies first as a dry run, then — if the command
   * was not blocked and an approval gate exists and grants it — runs for real.
   * The outcome fed back to Claude is whichever one actually happened.
   */
  private async runIdel(
    input: { command: string; dryRun?: boolean },
    gate: AgentApproval | undefined,
  ): Promise<{ result: { content: string; isError?: boolean }; event?: AgentEvent }> {
    const command = input.command;
    if (isModelProposedNative(command)) {
      return {
        result: { content: MODEL_NATIVE_REJECTION, isError: true },
        event: {
          type: "tool_error",
          tool: "run_idel",
          message: MODEL_NATIVE_REJECTION,
        },
      };
    }
    // Propose-only by default: dry-run unless the caller explicitly opted into
    // real execution via an approval gate AND the model didn't force dryRun.
    const wantsReal = input.dryRun === false && gate !== undefined;

    const dry = await this.service.run({ command, origin: "agent", dryRun: true });

    if (dry.decision.action === "block") {
      return {
        result: { content: outcomeJson(dry) },
        event: { type: "blocked", command, outcome: dry },
      };
    }

    if (!wantsReal) {
      return {
        result: { content: outcomeJson(dry) },
        event: { type: "proposed", command, dryRun: true, outcome: dry },
      };
    }

    // Approval-gated real run.
    const approved = await gate!({ command, outcome: dry });
    if (!approved) {
      return {
        result: {
          content:
            outcomeJson(dry) +
            "\n\n[The user declined to run this command for real. The dry-run result above stands.]",
        },
        event: { type: "needs_approval", command, outcome: dry },
      };
    }

    const real = await this.service.run({ command, origin: "agent", dryRun: false, approve: true });
    return {
      result: { content: outcomeJson(real) },
      event: { type: "proposed", command, dryRun: false, outcome: real },
    };
  }
}

/** A trimmed, model-facing view of an outcome — enough for Claude to adapt. */
function outcomeJson(o: RuntimeOutcome): string {
  return JSON.stringify({
    command: o.record.command,
    risk: o.risk.level,
    findings: o.risk.findings,
    decision: o.decision,
    result: o.record.result,
    affectedPathsEstimate: o.record.affectedPathsEstimate,
    exitCode: o.result?.exitCode,
    stdout: o.result?.stdout,
    stderr: o.result?.stderr,
  });
}

function anthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic authentication failed — set ANTHROPIC_API_KEY.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status ?? ""}: ${err.message}`.trim();
  }
  return String((err as Error)?.message ?? err);
}
