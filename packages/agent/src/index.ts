/**
 * @openexecution/agent — exposes IDEL to Claude as a small tool surface, with
 * the OpenExecution runtime kept as the enforcement boundary.
 *
 * The design principle: do not wrap Claude around the runtime; put the runtime
 * in front of Claude. The model PROPOSES commands via the `run_idel` tool; the
 * runtime parses, classifies (two-phase safety), applies policy, executes (or
 * refuses), and signs an OpenLogs record — identical to a human-typed command,
 * but attributed `source: "agent"`. A CRITICAL command the model hallucinates is
 * blocked by the same non-overridable floor that catches a human typo.
 *
 * This is the one package that depends on `@anthropic-ai/sdk`. The runtime,
 * safety, policy, and server packages stay dependency-free. The Anthropic API
 * key lives only in the host process (CLI or `idel serve`), never the browser.
 *
 * It reuses {@link @openexecution/server#TerminalService} as its transport —
 * the same service the CLI REPL and the HTTP server already call — so there is
 * exactly one enforcement path.
 */

export { IdelAgent } from "./agent.js";
export type { AgentEvent, AgentApproval, AgentOptions } from "./agent.js";
export { AGENT_TOOLS, systemPrompt } from "./tools.js";
