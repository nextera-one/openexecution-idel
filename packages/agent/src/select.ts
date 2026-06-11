import { spawn } from "node:child_process";

import type { TerminalService } from "@openexecution/server";

import { IdelAgent, type AgentApproval, type AgentEvent } from "./agent.js";
import { IdelCliAgent } from "./cli-agent.js";

/**
 * Picks how the embedded console reaches Claude, and builds the matching agent.
 *
 * Both agents expose the SAME `ask(intent, approve?)` event stream, so callers
 * (the CLI REPL, `idel ask`, the server) don't care which one they got.
 *
 * Precedence (chosen by the user): prefer the SUBSCRIPTION `claude` CLI over the
 * per-token API key. The CLI uses the user's Pro/Max plan and is the headline
 * "use the Claude console with IDEL" path. The API key is the fallback for
 * environments without the CLI (CI, servers). Order:
 *
 *   1. `IDEL_CLAUDE_PROVIDER=cli|api` forces a provider (explicit override).
 *   2. else if the `claude` CLI is installed → subscription CLI.
 *   3. else if ANTHROPIC_API_KEY is set → API.
 *   4. else → none (caller prints guidance).
 *
 * Note: when the CLI path is chosen, a stray ANTHROPIC_API_KEY is unset in the
 * spawned child (see provider.ts) so it never silently bills per-token.
 */

/** The common surface both agents satisfy. */
export interface AgentLike {
  ask(intent: string, approve?: AgentApproval): AsyncGenerator<AgentEvent, void, unknown>;
}

export type ProviderKind = "cli" | "api";

export interface SelectOptions {
  service: TerminalService;
  approve?: AgentApproval;
  model?: string;
  /** Override the claude binary name/path. */
  bin?: string;
  /** Force a provider, bypassing detection. */
  force?: ProviderKind;
}

export interface Selection {
  kind: ProviderKind;
  agent: AgentLike;
}

/**
 * Resolve which provider to use WITHOUT building an agent — useful for showing
 * the user what will happen (e.g. in `idel serve` startup output) and for the
 * "is Claude available at all?" check. Returns null when neither is available.
 */
export async function detectProvider(
  bin = "claude",
  force?: ProviderKind,
): Promise<ProviderKind | null> {
  const forced = force ?? envProvider();
  if (forced === "cli") return (await claudeCliAvailable(bin)) ? "cli" : null;
  if (forced === "api") return process.env["ANTHROPIC_API_KEY"] ? "api" : null;
  if (await claudeCliAvailable(bin)) return "cli";
  if (process.env["ANTHROPIC_API_KEY"]) return "api";
  return null;
}

/**
 * Build the agent for the detected/forced provider, or return null if Claude is
 * not reachable (no CLI installed and no API key).
 */
export async function createAgent(opts: SelectOptions): Promise<Selection | null> {
  const kind = await detectProvider(opts.bin, opts.force);
  if (!kind) return null;
  if (kind === "cli") {
    return {
      kind,
      agent: new IdelCliAgent({
        service: opts.service,
        approve: opts.approve,
        model: opts.model,
        bin: opts.bin,
      }),
    };
  }
  return {
    kind,
    agent: new IdelAgent({
      service: opts.service,
      approve: opts.approve,
      ...(opts.model ? { model: opts.model } : {}),
    }),
  };
}

function envProvider(): ProviderKind | undefined {
  const v = process.env["IDEL_CLAUDE_PROVIDER"]?.trim().toLowerCase();
  return v === "cli" || v === "api" ? v : undefined;
}

/** True if `<bin> --version` runs and exits 0 — i.e. Claude Code is installed. */
function claudeCliAvailable(bin: string): Promise<boolean> {
  return new Promise<boolean>((resolveAvail) => {
    let child;
    try {
      child = spawn(bin, ["--version"], { stdio: "ignore" });
    } catch {
      return resolveAvail(false);
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolveAvail(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 4000);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}
