import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Registry } from "@openexecution/registry";
import { defaultPolicy } from "@openexecution/policy";
import { OpenLogWriter } from "@openexecution/openlogs";
import { Runtime } from "@openexecution/runtime";
import { TerminalService } from "@openexecution/server";

import { IdelAgent, type AgentEvent } from "./agent.js";

/**
 * The agent loop is exercised against a REAL Runtime + core registry (so the
 * full safety/policy/OpenLogs pipeline runs) but a FAKE Anthropic client (so no
 * network, deterministic). The fake scripts a tool_use turn, then an end_turn —
 * the shape the real API produces — and the test asserts the runtime, not the
 * model, stays the enforcement boundary.
 */

let registry: Registry;
beforeAll(async () => {
  registry = await Registry.loadCore();
});

const tmpDirs: string[] = [];
async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "idel-agent-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * A minimal stand-in for the Anthropic client. `script` is a queue of responses;
 * each `messages.create` call shifts one off. Structurally compatible with the
 * one method IdelAgent calls.
 */
function fakeClient(script: unknown[]): { messages: { create: () => Promise<unknown> } } {
  const queue = [...script];
  return {
    messages: {
      create: async () => {
        const next = queue.shift();
        if (!next) throw new Error("fake client: script exhausted");
        return next;
      },
    },
  };
}

/** A response that asks to run one IDEL command via the run_idel tool. */
function toolUseTurn(command: string, dryRun?: boolean): unknown {
  return {
    stop_reason: "tool_use",
    content: [
      { type: "text", text: `Running ${command}.` },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "run_idel",
        input: dryRun === undefined ? { command } : { command, dryRun },
      },
    ],
  };
}

/** A terminal response with no tool calls. */
function endTurn(text: string): unknown {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

async function makeAgent(
  cwd: string,
  script: unknown[],
  opts: { logPath?: string; keyPath?: string; approve?: boolean } = {},
): Promise<IdelAgent> {
  const logWriter =
    opts.logPath && opts.keyPath
      ? new OpenLogWriter({ path: opts.logPath, keyPath: opts.keyPath })
      : undefined;
  const runtime = new Runtime({ registry, policy: defaultPolicy(), logWriter });
  const service = new TerminalService({ runtime, cwd });
  return new IdelAgent({
    service,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: fakeClient(script) as any,
    approve: opts.approve === undefined ? undefined : async () => opts.approve!,
  });
}

async function collect(agent: IdelAgent, intent: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of agent.ask(intent)) out.push(ev);
  return out;
}

describe("IdelAgent", () => {
  it("proposes a command as a dry-run by default and does not touch disk", async () => {
    const cwd = await sandbox();
    const agent = await makeAgent(cwd, [
      toolUseTurn("create.file name=notes.md"),
      endTurn("Done — that was a dry run."),
    ]);

    const events = await collect(agent, "make a notes file");
    const proposed = events.find((e) => e.type === "proposed");
    expect(proposed).toBeDefined();
    if (proposed?.type === "proposed") {
      expect(proposed.dryRun).toBe(true);
      expect(proposed.outcome.record.result).toBe("dry_run");
    }
    // No approval gate → nothing real ran; the file must not exist.
    await expect(readFile(join(cwd, "notes.md"))).rejects.toThrow();
  });

  it("surfaces a BLOCKED outcome and the runtime refuses the command", async () => {
    const cwd = await sandbox();
    // The model proposes a catastrophic delete; the CRITICAL floor blocks it,
    // regardless of what the model wanted.
    const agent = await makeAgent(cwd, [
      toolUseTurn("remove.folder name=/ recursive=true force=true"),
      endTurn("That was blocked by policy."),
    ]);

    const events = await collect(agent, "delete everything");
    const blocked = events.find((e) => e.type === "blocked");
    expect(blocked).toBeDefined();
    if (blocked?.type === "blocked") {
      expect(blocked.outcome.decision.action).toBe("block");
      expect(blocked.outcome.risk.level).toBe("CRITICAL");
    }
  });

  it("records agent-run commands with source: \"agent\" in OpenLogs", async () => {
    const cwd = await sandbox();
    const logPath = join(cwd, "openlogs.jsonl");
    const keyPath = join(cwd, "key.json");
    // Approve the real run so the command actually executes and is logged.
    const agent = await makeAgent(
      cwd,
      [toolUseTurn("create.file name=hello.txt", false), endTurn("Created it.")],
      { logPath, keyPath, approve: true },
    );

    await collect(agent, "create hello.txt");

    const raw = await readFile(logPath, "utf8");
    // OpenLogs v2 wraps each record under entry.data (signed envelope).
    const records = raw
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { entry: { data: { source: string; command: string; result: string } } }).entry.data);
    // The agent dry-runs first, then runs for real on approval — both are logged.
    const real = records.find((r) => r.command === "create.file" && r.result === "success");
    expect(real).toBeDefined();
    expect(real!.source).toBe("agent");
    // And the real run took effect.
    await expect(readFile(join(cwd, "hello.txt"), "utf8")).resolves.toBeDefined();
  });

  it("stops at end_turn and emits a done event", async () => {
    const cwd = await sandbox();
    const agent = await makeAgent(cwd, [endTurn("Nothing to do.")]);
    const events = await collect(agent, "say hi");
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", reason: "end_turn" });
  });
});
