import { spawn } from "node:child_process";

import type { TerminalService } from "@openexecution/server";

import { IdelAgent, type AgentApproval, type AgentEvent } from "./agent.js";
import { GeminiApiProvider, OpenAiApiProvider } from "./api-providers.js";
import { IdelCliAgent } from "./cli-agent.js";
import { cliSystemPrompt } from "./tools.js";

/** The common surface every hosted AI provider satisfies. */
export interface AgentLike {
  ask(intent: string, approve?: AgentApproval): AsyncGenerator<AgentEvent, void, unknown>;
}

/** Legacy names `cli` and `api` mean Claude CLI and Anthropic API. */
export type ProviderKind = "cli" | "api" | "openai" | "gemini";

export const PROVIDER_LABELS: Readonly<Record<ProviderKind, string>> = {
  cli: "Claude Code subscription",
  api: "Anthropic Claude API",
  openai: "OpenAI API",
  gemini: "Google Gemini API",
};

export interface SelectOptions {
  service: TerminalService;
  approve?: AgentApproval;
  model?: string;
  /** Explicit in-memory API credential supplied by an authenticated host UI. */
  apiKey?: string;
  /** Override the claude binary name/path. */
  bin?: string;
  /** Force a provider, bypassing detection. */
  force?: ProviderKind;
}

export interface Selection {
  kind: ProviderKind;
  agent: AgentLike;
}

/** Return every provider that is configured on this host. */
export async function detectProviders(bin = "claude"): Promise<ProviderKind[]> {
  const providers: ProviderKind[] = [];
  if (await claudeCliAvailable(bin)) providers.push("cli");
  if (process.env["ANTHROPIC_API_KEY"]) providers.push("api");
  if (process.env["OPENAI_API_KEY"]) providers.push("openai");
  if (process.env["GEMINI_API_KEY"] || process.env["GOOGLE_API_KEY"]) providers.push("gemini");
  return providers;
}

/** Resolve the selected provider, respecting IDEL_AI_PROVIDER when present. */
export async function detectProvider(
  bin = "claude",
  force?: ProviderKind,
): Promise<ProviderKind | null> {
  const selected = force ?? envProvider();
  const available = await detectProviders(bin);
  if (selected) return available.includes(selected) ? selected : null;
  return available[0] ?? null;
}

/** Build an agent for a specific configured provider. */
export function createAgentForProvider(opts: SelectOptions & { force: ProviderKind }): AgentLike | null {
  const { force: kind } = opts;
  if (!providerHasCredentials(kind, opts.bin ?? "claude", opts.apiKey)) return null;
  if (kind === "cli") {
    return new IdelCliAgent({
      service: opts.service,
      approve: opts.approve,
      model: opts.model,
      bin: opts.bin,
    });
  }
  if (kind === "api") {
    return new IdelAgent({
      service: opts.service,
      approve: opts.approve,
      apiKey: opts.apiKey,
      ...(opts.model ? { model: opts.model } : {}),
    });
  }
  const system = cliSystemPrompt(opts.service);
  const providerFactory = () => kind === "openai"
    ? new OpenAiApiProvider({ system, model: opts.model, apiKey: opts.apiKey })
    : new GeminiApiProvider({
        system,
        model: opts.model,
        apiKey: opts.apiKey ?? process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"],
      });
  return new IdelCliAgent({ service: opts.service, approve: opts.approve, providerFactory });
}

/** Build the selected agent, or return null when its credentials are unavailable. */
export async function createAgent(opts: SelectOptions): Promise<Selection | null> {
  const kind = await detectProvider(opts.bin, opts.force);
  if (!kind) return null;
  const agent = createAgentForProvider({ ...opts, force: kind });
  return agent ? { kind, agent } : null;
}

function envProvider(): ProviderKind | undefined {
  const current = process.env["IDEL_AI_PROVIDER"]?.trim().toLowerCase();
  if (current === "openai" || current === "chatgpt") return "openai";
  if (current === "gemini" || current === "google") return "gemini";
  if (current === "anthropic" || current === "claude-api" || current === "api") return "api";
  if (current === "claude-cli" || current === "claude-code" || current === "cli") return "cli";

  const legacy = process.env["IDEL_CLAUDE_PROVIDER"]?.trim().toLowerCase();
  return legacy === "cli" || legacy === "api" ? legacy : undefined;
}

function providerHasCredentials(kind: ProviderKind, bin: string, apiKey?: string): boolean {
  if (kind === "cli") return bin.length > 0;
  if (apiKey) return true;
  if (kind === "api") return Boolean(process.env["ANTHROPIC_API_KEY"]);
  if (kind === "openai") return Boolean(process.env["OPENAI_API_KEY"]);
  return Boolean(process.env["GEMINI_API_KEY"] || process.env["GOOGLE_API_KEY"]);
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
