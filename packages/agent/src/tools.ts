import type Anthropic from "@anthropic-ai/sdk";
import type { RegistryEntry, TerminalService } from "@openexecution/server";

/**
 * The fixed tool surface IDEL exposes to Claude. It is deliberately small — four
 * tools, not one-per-command — because the runtime, not the model, is the
 * enforcement boundary. Claude *proposes* a command via {@link run_idel}; the
 * runtime parses, classifies, applies policy, executes (or refuses), and returns
 * the structured {@link RuntimeOutcome} as the tool result. Claude reads the
 * outcome — risk, findings, decision — and adapts. A CRITICAL command the model
 * hallucinates is blocked by the policy floor exactly like a human typo.
 *
 * The full command vocabulary lives in the system prompt (see {@link systemPrompt}),
 * not in 29 separate tool schemas, so the model knows the verbs up front and the
 * tool list stays a stable, cacheable prefix.
 */
export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "run_idel",
    description:
      "Execute one IDEL command line through the OpenExecution runtime. " +
      "The command flows through the full pipeline: parse → two-phase safety " +
      "classification → policy → execute → signed OpenLogs. Returns the " +
      "RuntimeOutcome as JSON, including the effective risk level, the list of " +
      "risk findings, the policy decision (allow / warn / require_dry_run / " +
      "approval_required / block), and any stdout/stderr.\n\n" +
      "Use this to act on the user's intent. The command MUST be valid IDEL " +
      "syntax (verb.scope param=value), e.g. `create.file name=notes.md` or " +
      "`remove.folder name=dist recursive=true`. If you are unsure a command " +
      "exists or what params it takes, call explain_command or complete_idel " +
      "first.\n\n" +
      "If the returned decision is BLOCK, the command did NOT run and nothing " +
      "was changed — do not retry the same command; the CRITICAL safety floor " +
      "cannot be bypassed. Adjust your approach or explain the block to the user.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The IDEL command line to run, e.g. 'move.file from=a.txt to=b.txt'.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Plan and classify the command without touching the filesystem. " +
            "Defaults to true for the agent path — prefer a dry run first so the " +
            "user can see the risk and blast-radius estimate before a real run.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_idel",
    description:
      "Registry-driven autocomplete for a partial IDEL command line. Returns the " +
      "list of completions (matching command names, or param keys/values for the " +
      "command being typed). Use this to discover the exact verb or parameter " +
      "names instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The partial command line being completed, e.g. 'remove.' or 'create.file '.",
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_command",
    description:
      "Return the resolved definition of one command id (its summary, category, " +
      "default risk, source layer, and full parameter list with types and " +
      "required-ness), plus any shadowed layers. Use this to confirm a command's " +
      "exact parameter schema before calling run_idel.",
    input_schema: {
      type: "object",
      properties: {
        commandId: {
          type: "string",
          description: "The dotted command id, e.g. 'remove.folder'.",
        },
      },
      required: ["commandId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_logs",
    description:
      "Read the most recent OpenLogs audit records (already secret-redacted). " +
      "Use this to answer questions about what was run, what was blocked, or to " +
      "review the recent history before proposing a destructive action.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "How many recent records to return (default 20, max 1000).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** Render one registry entry as a compact one-liner for the system prompt. */
function renderEntry(e: RegistryEntry): string {
  const params = e.params
    .map((p) => {
      const enumPart = p.enum ? `=${p.enum.join("|")}` : "";
      return p.required ? `${p.name}:${p.type}${enumPart}` : `[${p.name}:${p.type}${enumPart}]`;
    })
    .join(" ");
  return `- ${e.id} (${e.risk}) — ${e.summary}${params ? `  ::  ${params}` : ""}`;
}

/**
 * Build the system prompt: the safety contract plus the full command catalog.
 *
 * The catalog is large, static, and identical across requests in a session, so
 * the caller should attach a `cache_control` breakpoint to the returned block —
 * it is the frozen prefix. Never interpolate per-request data (cwd, timestamps)
 * into it, or the cache is invalidated every turn.
 */
export function systemPrompt(service: TerminalService): string {
  const catalog = service
    .registry()
    .map(renderEntry)
    .join("\n");

  return [
    "You are the IDEL agent — an assistant embedded in the OpenExecution terminal.",
    "You turn a user's natural-language intent into safe IDEL commands and run them",
    "through the runtime on the user's behalf.",
    "",
    "How the runtime works (this is load-bearing — internalize it):",
    "- You do not execute anything directly. You PROPOSE a command via the run_idel",
    "  tool. The runtime parses it, classifies its risk in two phases (string-level",
    "  and real-filesystem), applies the active policy, and only then executes —",
    "  recording every decision to a signed, append-only audit log.",
    "- The runtime is the enforcement boundary, not you. A CRITICAL command (root or",
    "  home delete, raw-device write, recursive 777 on a broad tree) is BLOCKED by a",
    "  non-overridable floor. You cannot clear it, and you should not try.",
    "- Risk levels: LOW / MEDIUM / HIGH / CRITICAL. Policy actions: allow, warn,",
    "  require_dry_run, approval_required, block.",
    "",
    "Operating rules:",
    "1. Default to a dry run first (dryRun:true) for anything that writes, moves, or",
    "   deletes. Show the user the risk and the affected-path estimate, then do the",
    "   real run only after they confirm. Pure reads (read.file, list.folder, path.*,",
    "   registry.*, logs.*) can run directly.",
    "2. Use the exact command vocabulary below. If a verb or parameter is not in the",
    "   catalog, call complete_idel / explain_command rather than inventing syntax.",
    "3. Never wrap a command in native passthrough (`! ...`) to dodge classification.",
    "   If an IDEL command exists for the task, use it.",
    "4. If a command comes back BLOCKED or approval_required, explain why in plain",
    "   language and stop — do not retry the identical command.",
    "5. Be concise. State what you are about to do, do it, and report the outcome.",
    "",
    "Available commands (id (default risk) — summary :: params; [optional] params in brackets):",
    catalog,
  ].join("\n");
}
