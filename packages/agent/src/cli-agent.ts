import type { TerminalService } from "@openexecution/server";
import type { RuntimeOutcome } from "@openexecution/types";

import type { AgentApproval, AgentEvent } from "./agent.js";
import { ClaudeCliProvider, type ProviderTurn } from "./provider.js";
import { cliSystemPrompt } from "./tools.js";

/**
 * The subscription-backed IDEL agent: same event stream and same enforcement as
 * {@link IdelAgent}, but Claude is reached through the installed `claude` CLI
 * (Pro/Max login) instead of the developer API.
 *
 * Because `claude -p` returns a final answer rather than a live tool-call loop,
 * the contract is inverted: Claude emits IDEL command lines as structured text
 * ({ commands, explanation, done }), this loop runs each through the runtime
 * (dry-run first, real only on approval), then feeds the outcomes back via the
 * provider's `--resume` so Claude adapts — repeating until Claude says done or
 * proposes nothing. Every command still flows through `service.run(...,
 * origin:"agent")`, so safety/policy/OpenLogs are byte-identical to the API path.
 */
export interface CliAgentOptions {
  service: TerminalService;
  /** Override the claude binary name/path. Default "claude". */
  bin?: string;
  /** Model alias/id for --model (e.g. "opus"). */
  model?: string;
  /** Real-run gate (constructor default; ask() may override per call). */
  approve?: AgentApproval;
  /** Cap on round-trips per ask(). Default 12. */
  maxSteps?: number;
  /** Injectable provider (tests pass a fake). Defaults to a real ClaudeCliProvider. */
  provider?: ClaudeCliProvider;
}

export class IdelCliAgent {
  private readonly service: TerminalService;
  private readonly approve: AgentApproval | undefined;
  private readonly maxSteps: number;
  private readonly provider: ClaudeCliProvider;

  constructor(opts: CliAgentOptions) {
    this.service = opts.service;
    this.approve = opts.approve;
    this.maxSteps = opts.maxSteps ?? 12;
    this.provider =
      opts.provider ??
      new ClaudeCliProvider({
        bin: opts.bin,
        model: opts.model,
        system: cliSystemPrompt(opts.service),
      });
  }

  /** Same signature/semantics as {@link IdelAgent.ask}. */
  async *ask(
    userIntent: string,
    approve?: AgentApproval,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const gate = approve ?? this.approve;
    let priorOutcomes: { command: string; outcomeJson: string }[] = [];
    let intent = userIntent;

    for (let step = 0; step < this.maxSteps; step++) {
      let turn: ProviderTurn;
      try {
        turn = await this.provider.next({ userIntent: intent, priorOutcomes });
      } catch (err) {
        yield { type: "error", message: (err as Error).message };
        return;
      }
      // After the first turn the model drives from the fed-back outcomes.
      intent = "";

      if (turn.text.trim()) yield { type: "text", text: turn.text };

      if (turn.done || turn.commands.length === 0) {
        yield { type: "done", reason: "end_turn" };
        return;
      }

      // Run each proposed command through the runtime, collecting outcomes to
      // feed back next turn — exactly the SDK loop's classify-before-execute.
      priorOutcomes = [];
      for (const c of turn.commands) {
        const { outcome, event } = await this.runOne(c.command, c.dryRun, gate);
        if (event) yield event;
        priorOutcomes.push({ command: c.command, outcomeJson: outcomeJson(outcome) });
      }
    }

    yield { type: "done", reason: "max_steps" };
  }

  /** Dry-run, then (if not blocked and approved) real-run one command. */
  private async runOne(
    command: string,
    dryRun: boolean | undefined,
    gate: AgentApproval | undefined,
  ): Promise<{ outcome: RuntimeOutcome; event?: AgentEvent }> {
    const wantsReal = dryRun === false && gate !== undefined;
    const dry = await this.service.run({ command, origin: "agent", dryRun: true });

    if (dry.decision.action === "block") {
      return { outcome: dry, event: { type: "blocked", command, outcome: dry } };
    }
    if (!wantsReal) {
      return { outcome: dry, event: { type: "proposed", command, dryRun: true, outcome: dry } };
    }
    const approved = await gate!({ command, outcome: dry });
    if (!approved) {
      return { outcome: dry, event: { type: "needs_approval", command, outcome: dry } };
    }
    const real = await this.service.run({ command, origin: "agent", dryRun: false, approve: true });
    return { outcome: real, event: { type: "proposed", command, dryRun: false, outcome: real } };
  }
}

/** Same trimmed outcome view the SDK loop feeds the model. */
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
