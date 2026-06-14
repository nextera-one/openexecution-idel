import { describe, it, expect, afterEach } from "vitest";

import { Registry } from "@openexecution/registry";
import { Runtime } from "@openexecution/runtime";
import { defaultPolicy } from "@openexecution/policy";
import type { CommandDef } from "@openexecution/types";

import { learnCli, captureHelp, type TestVerification } from "./learn.js";

/**
 * `learnCli` is exercised with an INJECTED help-capture (no real subprocess),
 * a local help parser, and a FAKE Anthropic client for the optional AI path. The
 * validation path is REAL — every proposed def is run through the registry's
 * actual `checkCommandDef`.
 */

/** A minimal Anthropic-shaped client whose one reply is a fenced JSON block. */
function fakeClient(reply: string): { messages: { create: () => Promise<unknown> } } {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
      }),
    },
  };
}

const VALID_DEF = {
  id: "show.demo.status",
  version: "0.1.0",
  summary: "Show status.",
  category: "demo",
  riskDefault: "LOW",
  params: {},
  adapters: {
    posix: { command: "demo", args: [{ kind: "literal", value: "status" }] },
  },
};

const INVALID_DEF = {
  // Missing required fields (no adapters, bad id) → must fail checkCommandDef.
  id: "Demo.BAD",
  summary: "nope",
};

const GIT_HELP = `
usage: git [--version] [--help] <command> [<args>]

These are common Git commands used in various situations:

start a working area
   clone     Clone a repository into a new directory
   init      Create an empty Git repository or reinitialize an existing one

work on the current change
   add       Add file contents to the index
   mv        Move or rename a file, a directory, or a symlink
   restore   Restore working tree files
   rm        Remove files from the working tree and from the index

examine the history and state
   diff      Show changes between commits, commit and working tree, etc
   grep      Print lines matching a pattern
   log       Show commit logs
   show      Show various types of objects
   status    Show the working tree status
`;

const savedApiKey = process.env["ANTHROPIC_API_KEY"];

afterEach(() => {
  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
});

describe("learnCli", () => {
  it("generates local draft defs from help without Claude or an API key", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const result = await learnCli("git", {
      capture: async () => GIT_HELP,
      maxCommands: 12,
    });
    const ids = result.accepted.map((def) => def.id);
    expect(ids).toContain("clone.git.repo");
    expect(ids).toContain("remove.git.file");
    expect(ids).toContain("show.git.status");
    expect(result.commands.every((cmd) => cmd.id.split(".")[0] !== "git")).toBe(true);
  });

  it("accepts a valid def and tags it as a custom draft", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([VALID_DEF]) + "\n```") as any,
      capture: async () => "demo — a demo CLI\n  status   show status",
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.id).toBe("show.demo.status");
    // Learned defs must live in the draft (custom) layer, never core.
    expect(result.accepted[0]!.source).toBe("custom");
    expect(result.commands.find((c) => c.id === "show.demo.status")?.def).not.toBeNull();
  });

  it("drops a def that fails schema validation (fail-closed) and reports why", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([VALID_DEF, INVALID_DEF]) + "\n```") as any,
      capture: async () => "help",
    });
    expect(result.accepted).toHaveLength(1); // only the valid one
    const bad = result.commands.find((c) => c.def === null);
    expect(bad).toBeDefined();
    expect(bad!.errors.length).toBeGreaterThan(0);
  });

  it("learns nothing when the model returns unparseable output", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("Sorry, I can't help with that.") as any,
      capture: async () => "help",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.commands).toHaveLength(0);
  });

  it("tolerates a single object (not wrapped in an array)", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify(VALID_DEF) + "\n```") as any,
      capture: async () => "help",
    });
    expect(result.accepted).toHaveLength(1);
  });

  it("uses the injected claude CLI generator when provided", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    let sawPrompt = false;
    const result = await learnCli("demo", {
      capture: async () => "demo help",
      runClaudeCli: async (args, stdin) => {
        expect(args).toContain("-p");
        expect(args).toContain("--append-system-prompt");
        expect(args).toContain("--tools");
        expect(stdin).toContain("--- demo help ---");
        sawPrompt = true;
        return "```json\n" + JSON.stringify([VALID_DEF]) + "\n```";
      },
    });
    expect(sawPrompt).toBe(true);
    expect(result.accepted[0]?.id).toBe("show.demo.status");
  });

  it("rejects learned ids that put the CLI namespace before the verb", async () => {
    const badNamespace = { ...VALID_DEF, id: "demo.status" };
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([badNamespace]) + "\n```") as any,
      capture: async () => "demo — a demo CLI\n  status   show status",
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.commands[0]!.errors.join("\n")).toMatch(/verb-first/);
  });
});

describe("learnCli — test verification (round-tripping)", () => {
  // A def carrying a test whose expectation we control, so we can assert that a
  // passing test keeps the def and a failing test rejects it. The verifier is a
  // stub here (the CLI wires the real runtime-backed one); these tests prove the
  // accept/reject wiring inside learnCli, not the runtime classification itself.
  const DEF_WITH_TEST = {
    ...VALID_DEF,
    id: "remove.demo",
    riskDefault: "HIGH",
    tests: [{ input: "remove.demo name=x", expectRisk: "HIGH" }],
  };

  it("accepts a def whose declared tests pass", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([DEF_WITH_TEST]) + "\n```") as any,
      capture: async () => "help",
      verify: async () => ({ "remove.demo": { ran: 1, passed: 1, failures: [] } }),
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.commands[0]!.verification).toEqual({ ran: 1, passed: 1, failures: [] });
  });

  it("rejects a schema-valid def whose tests misclassify (fail-closed)", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([DEF_WITH_TEST]) + "\n```") as any,
      capture: async () => "help",
      verify: async () => ({
        "remove.demo": {
          ran: 1,
          passed: 0,
          failures: ["expected risk HIGH, runtime classified LOW"],
        },
      }),
    });
    // Schema-valid, but the test failed → not accepted, yet still reported.
    expect(result.accepted).toHaveLength(0);
    const cmd = result.commands.find((c) => c.id === "remove.demo");
    expect(cmd!.def).not.toBeNull();
    expect(cmd!.verification!.failures).toHaveLength(1);
  });

  it("accepts a def with no tests (nothing to disprove)", async () => {
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([VALID_DEF]) + "\n```") as any,
      capture: async () => "help",
      verify: async () => ({ "show.demo.status": { ran: 0, passed: 0, failures: [] } }),
    });
    expect(result.accepted).toHaveLength(1);
  });

  it("round-trips a def's tests through a REAL runtime (end to end)", async () => {
    // This mirrors what the CLI's verifyDefs does: load the learned def as a
    // custom layer, dry-run its test input, compare actual vs expected risk.
    // The def below maps to the @node fs adapter so it resolves; its test asserts
    // a LOW classification, which the runtime should confirm.
    const realVerify = async (defs: CommandDef[]): Promise<Record<string, TestVerification>> => {
      const registry = await Registry.loadCore();
      registry.addLayer("custom", defs);
      const runtime = new Runtime({ registry, policy: defaultPolicy() });
      const out: Record<string, TestVerification> = {};
      for (const def of defs) {
        const v: TestVerification = { ran: 0, passed: 0, failures: [] };
        for (const t of def.tests ?? []) {
          v.ran++;
          const outcome = await runtime.run(t.input, {
            cwd: process.cwd(),
            user: "t",
            host: "h",
            os: "linux",
            sessionId: "s",
            dryRun: true,
          });
          if (t.expectRisk && t.expectRisk !== outcome.risk.level) {
            v.failures.push(`expected ${t.expectRisk}, got ${outcome.risk.level}`);
          } else {
            v.passed++;
          }
        }
        out[def.id] = v;
      }
      return out;
    };

    const def = {
      id: "create.demo.file",
      version: "0.1.0",
      summary: "Make a file.",
      category: "demo",
      riskDefault: "LOW",
      params: { name: { type: "path", required: true } },
      adapters: { node: { command: "@node", args: [{ kind: "value", param: "name" }] } },
      tests: [{ input: "create.demo.file name=a.txt", expectRisk: "LOW" }],
    };
    const result = await learnCli("demo", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient("```json\n" + JSON.stringify([def]) + "\n```") as any,
      capture: async () => "help",
      verify: realVerify,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.commands[0]!.verification).toEqual({ ran: 1, passed: 1, failures: [] });
  });
});

describe("captureHelp", () => {
  it("rejects a CLI name with shell metacharacters before any spawn", async () => {
    await expect(captureHelp("rm -rf /; echo")).rejects.toThrow(/refusing to introspect/);
    await expect(captureHelp("../evil")).rejects.toThrow(/refusing to introspect/);
    await expect(captureHelp("foo|bar")).rejects.toThrow(/refusing to introspect/);
  });

  it("accepts a normal CLI name shape (but fails cleanly if not installed)", async () => {
    // A plausible name that is virtually certainly not installed: the spawn
    // fails on each help variant and we get the "could not capture" message,
    // NOT the "refusing" guard — proving the name passed the shape check.
    await expect(captureHelp("idel-nonexistent-cli-xyz")).rejects.toThrow(/could not capture help/);
  });
});
