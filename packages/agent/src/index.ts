/**
 * @openexecution/agent — exposes IDEL to Claude as a small tool surface, with
 * the OpenExecution runtime kept as the enforcement boundary.
 *
 * The design principle: do not wrap Claude around the runtime; put the runtime
 * in front of Claude. The model PROPOSES commands; the runtime parses, classifies
 * (two-phase safety), applies policy, executes (or refuses), and signs an
 * OpenLogs record — identical to a human-typed command, but attributed
 * `source: "agent"`. A CRITICAL command the model hallucinates is blocked by the
 * same non-overridable floor that catches a human typo.
 *
 * Two ways to reach Claude, behind one selection (see {@link createAgent}):
 *   - the user's Pro/Max SUBSCRIPTION via the installed `claude` CLI (preferred;
 *     no API key — uses the Claude Code login), and
 *   - the developer API via `@anthropic-ai/sdk` (fallback; ANTHROPIC_API_KEY).
 * Both expose the same `ask()` event stream and the same enforcement path. The
 * Anthropic credential lives only in the host process (CLI or `idel serve`),
 * never the browser.
 */

export { IdelAgent } from "./agent.js";
export type { AgentEvent, AgentApproval, AgentOptions } from "./agent.js";
export { IdelCliAgent } from "./cli-agent.js";
export type { CliAgentOptions } from "./cli-agent.js";
export { createAgent, detectProvider } from "./select.js";
export type { AgentLike, ProviderKind, Selection, SelectOptions } from "./select.js";
export {
  ClaudeCliProvider,
  AnthropicApiProvider,
} from "./provider.js";
export type {
  ClaudeProvider,
  ClaudeCliOptions,
  ProviderTurn,
  ProviderCommand,
  ProviderStep,
} from "./provider.js";
export { AGENT_TOOLS, systemPrompt, cliSystemPrompt } from "./tools.js";
export { learnCli, captureHelp } from "./learn.js";
export type {
  LearnOptions,
  LearnResult,
  LearnedCommand,
  TestVerification,
} from "./learn.js";
