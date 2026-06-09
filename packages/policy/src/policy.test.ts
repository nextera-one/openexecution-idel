import { describe, expect, it } from "vitest";

import type {
  PolicyConfig,
  RiskLevel,
} from "@openexecution/types";

import { evaluate } from "./evaluate.js";
import type { EvaluationInput } from "./match.js";
import { commandMatches } from "./match.js";
import {
  defaultPolicy,
  loadPolicy,
  loadPolicyJson,
  parseSimpleYaml,
  PolicyParseError,
} from "./load.js";

/** Build an EvaluationInput with sensible defaults that tests can override. */
function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    risk: "LOW",
    command: "list.files",
    source: "idel",
    params: {},
    ...overrides,
  };
}

describe("evaluate — first-match-wins ordering", () => {
  it("selects the FIRST matching rule, not the most specific", () => {
    const config: PolicyConfig = {
      rules: [
        { match: { source: "idel" }, action: "warn" }, // broad, comes first
        { match: { command: "list.files" }, action: "allow" }, // more specific
      ],
    };
    const decision = evaluate(input(), config);
    expect(decision.action).toBe("warn");
    expect(decision.matchedRule).toBe(0);
  });

  it("a later rule is honored only when earlier rules do not match", () => {
    const config: PolicyConfig = {
      rules: [
        { match: { command: "remove.folder" }, action: "block" },
        { match: { command: "list.files" }, action: "allow" },
      ],
    };
    const decision = evaluate(input({ command: "list.files" }), config);
    expect(decision.action).toBe("allow");
    expect(decision.matchedRule).toBe(1);
  });
});

describe("evaluate — CRITICAL hard floor", () => {
  it("overrides a matched 'allow' rule on CRITICAL to 'block'", () => {
    const config: PolicyConfig = {
      rules: [{ match: { command: "remove.folder" }, action: "allow" }],
    };
    const decision = evaluate(
      input({ risk: "CRITICAL", command: "remove.folder" }),
      config,
    );
    expect(decision.action).toBe("block");
    expect(decision.matchedRule).toBe(0);
    expect(decision.reason).toMatch(/CRITICAL/);
    expect(decision.reason).toMatch(/block/);
  });

  it("overrides 'warn' and 'require_dry_run' on CRITICAL to 'block'", () => {
    for (const weak of ["warn", "require_dry_run"] as const) {
      const config: PolicyConfig = { rules: [{ match: {}, action: weak }] };
      const decision = evaluate(input({ risk: "CRITICAL" }), config);
      expect(decision.action).toBe("block");
    }
  });

  it("honors an explicit approval_required rule on CRITICAL (team exception)", () => {
    const config: PolicyConfig = {
      rules: [
        {
          match: { risk: "CRITICAL", command: "remove.folder" },
          action: "approval_required",
          approvers: ["team-lead"],
        },
      ],
    };
    const decision = evaluate(
      input({ risk: "CRITICAL", command: "remove.folder" }),
      config,
    );
    expect(decision.action).toBe("approval_required");
    expect(decision.approvers).toEqual(["team-lead"]);
    expect(decision.matchedRule).toBe(0);
  });

  it("honors an explicit 'block' rule on CRITICAL without rewriting the reason as an override", () => {
    const config: PolicyConfig = {
      rules: [{ match: { risk: "CRITICAL" }, action: "block" }],
    };
    const decision = evaluate(input({ risk: "CRITICAL" }), config);
    expect(decision.action).toBe("block");
    expect(decision.reason).not.toMatch(/Overriding/);
  });

  it("does NOT touch non-CRITICAL risk (allow stays allow on HIGH)", () => {
    const config: PolicyConfig = {
      rules: [{ match: { risk: "HIGH" }, action: "allow" }],
    };
    const decision = evaluate(input({ risk: "HIGH" }), config);
    expect(decision.action).toBe("allow");
  });
});

describe("match — command matching", () => {
  it("matches exact command names", () => {
    expect(commandMatches("remove.folder", "remove.folder")).toBe(true);
    expect(commandMatches("remove.folder", "remove.file")).toBe(false);
  });

  it("supports trailing prefix-glob 'remove.*'", () => {
    expect(commandMatches("remove.*", "remove.folder")).toBe(true);
    expect(commandMatches("remove.*", "remove.file")).toBe(true);
    expect(commandMatches("remove.*", "list.files")).toBe(false);
    // The literal dot prevents partial-token matches.
    expect(commandMatches("remove.*", "removed.x")).toBe(false);
  });

  it("drives evaluate via a prefix-glob rule", () => {
    const config: PolicyConfig = {
      rules: [{ match: { command: "remove.*" }, action: "require_dry_run" }],
    };
    const decision = evaluate(input({ command: "remove.folder" }), config);
    expect(decision.action).toBe("require_dry_run");
    expect(decision.matchedRule).toBe(0);
  });
});

describe("match — param and environment matching", () => {
  it("matches when every match.param equals the input param", () => {
    const config: PolicyConfig = {
      rules: [
        { match: { params: { recursive: true } }, action: "block" },
        { match: {}, action: "allow" },
      ],
    };
    expect(evaluate(input({ params: { recursive: true } }), config).action).toBe("block");
    // Wrong value -> falls through to the catch-all.
    expect(evaluate(input({ params: { recursive: false } }), config).action).toBe("allow");
    // Missing param -> falls through.
    expect(evaluate(input({ params: {} }), config).action).toBe("allow");
  });

  it("matches on environment equality and treats absent environment as non-matching", () => {
    const config: PolicyConfig = {
      rules: [
        { match: { environment: "production" }, action: "approval_required", approvers: ["a"] },
        { match: {}, action: "allow" },
      ],
    };
    expect(evaluate(input({ environment: "production" }), config).action).toBe("approval_required");
    expect(evaluate(input({ environment: "staging" }), config).action).toBe("allow");
    expect(evaluate(input({}), config).action).toBe("allow");
  });

  it("requires ALL match fields to match together (AND semantics)", () => {
    const config: PolicyConfig = {
      rules: [
        {
          match: {
            command: "remove.folder",
            params: { recursive: true },
            environment: "production",
          },
          action: "approval_required",
          approvers: ["team-lead"],
        },
        { match: {}, action: "allow" },
      ],
    };
    const matching = input({
      command: "remove.folder",
      params: { recursive: true },
      environment: "production",
    });
    expect(evaluate(matching, config).action).toBe("approval_required");
    // Drop one field -> no match -> catch-all.
    expect(evaluate({ ...matching, environment: "staging" }, config).action).toBe("allow");
  });
});

describe("evaluate — implicit risk-based defaults (no rule matches)", () => {
  const cases: Array<[RiskLevel, string]> = [
    ["LOW", "allow"],
    ["MEDIUM", "allow"],
    ["HIGH", "require_dry_run"],
    ["CRITICAL", "block"],
  ];
  for (const [risk, expected] of cases) {
    it(`${risk} -> ${expected}`, () => {
      const decision = evaluate(input({ risk }), { rules: [] });
      expect(decision.action).toBe(expected);
      expect(decision.matchedRule).toBe(-1);
      expect(decision.reason).toMatch(/default/i);
    });
  }
});

describe("loadPolicy — §19 YAML example", () => {
  const yaml = `rules:
  - match:
      risk: CRITICAL
    action: block
  - match:
      command: remove.folder
      params:
        recursive: true
      environment: production
    action: approval
    approvers: ["team-lead", "platform-admin"]
  - match:
      risk: HIGH
    action: require_dry_run
  - match:
      source: native
    action: scan_then_warn
`;

  it("parses all four rules with normalized action names", () => {
    const config = loadPolicy(yaml);
    expect(config.rules).toHaveLength(4);

    expect(config.rules[0]).toEqual({ match: { risk: "CRITICAL" }, action: "block" });

    // `approval` normalizes to `approval_required`.
    expect(config.rules[1]).toEqual({
      match: {
        command: "remove.folder",
        params: { recursive: true },
        environment: "production",
      },
      action: "approval_required",
      approvers: ["team-lead", "platform-admin"],
    });

    expect(config.rules[2]).toEqual({ match: { risk: "HIGH" }, action: "require_dry_run" });

    // `scan_then_warn` normalizes to `warn`.
    expect(config.rules[3]).toEqual({ match: { source: "native" }, action: "warn" });
  });

  it("the parsed YAML config drives evaluate end-to-end", () => {
    const config = loadPolicy(yaml);

    // CRITICAL -> rule 0 block.
    expect(evaluate(input({ risk: "CRITICAL" }), config).matchedRule).toBe(0);

    // The production recursive remove.folder -> rule 1 approval_required.
    const prodRemove = evaluate(
      input({
        command: "remove.folder",
        params: { recursive: true },
        environment: "production",
      }),
      config,
    );
    expect(prodRemove.action).toBe("approval_required");
    expect(prodRemove.approvers).toEqual(["team-lead", "platform-admin"]);

    // native source -> rule 3 warn.
    expect(evaluate(input({ source: "native" }), config).action).toBe("warn");
  });

  it("parseSimpleYaml returns booleans and arrays with correct types", () => {
    const parsed = parseSimpleYaml(yaml) as {
      rules: Array<{ match: Record<string, unknown>; action: string; approvers?: unknown }>;
    };
    expect(parsed.rules[1]!.match.params).toEqual({ recursive: true });
    expect(typeof (parsed.rules[1]!.match.params as Record<string, unknown>).recursive).toBe(
      "boolean",
    );
    expect(parsed.rules[1]!.approvers).toEqual(["team-lead", "platform-admin"]);
  });

  // Regression: a `match: {}` catch-all (idiomatic "match anything") must parse
  // to an empty object, not the string "{}". This shipped broken in the example
  // policy file and silently disabled the whole policy via CLI fallback.
  it("parses an empty flow-mapping `match: {}` as a catch-all rule", () => {
    const withCatchAll = `rules:
  - match:
      risk: CRITICAL
    action: block
  - match: {}
    action: allow
`;
    const config = loadPolicy(withCatchAll);
    expect(config.rules).toHaveLength(2);
    expect(config.rules[1]).toEqual({ match: {}, action: "allow" });
  });
});

describe("loadPolicy — JSON round-trip", () => {
  it("loads JSON and produces the same config as defaultPolicy()", () => {
    const original = defaultPolicy();
    const json = JSON.stringify(original);
    const reloaded = loadPolicy(json);
    expect(reloaded).toEqual(original);
  });

  it("loadPolicyJson normalizes alias action names too", () => {
    const json = JSON.stringify({
      rules: [{ match: { source: "native" }, action: "scan_then_warn" }],
    });
    expect(loadPolicyJson(json).rules[0]!.action).toBe("warn");
  });

  it("a config survives a YAML/JSON -> evaluate -> JSON round-trip unchanged", () => {
    const config = defaultPolicy();
    const roundTripped = loadPolicyJson(JSON.stringify(config));
    expect(roundTripped).toEqual(config);
    // And it still behaves identically.
    expect(evaluate(input({ risk: "CRITICAL" }), roundTripped).action).toBe("block");
    expect(evaluate(input({ source: "native" }), roundTripped).action).toBe("warn");
  });
});

describe("loadPolicy — error handling", () => {
  it("throws PolicyParseError on an unknown action name", () => {
    expect(() => loadPolicy("rules:\n  - action: nuke\n")).toThrow(PolicyParseError);
  });

  it("throws PolicyParseError on a document without a rules array", () => {
    expect(() => loadPolicy('{"foo": 1}')).toThrow(PolicyParseError);
  });

  it("throws PolicyParseError on invalid JSON", () => {
    expect(() => loadPolicy("{ this is not json")).toThrow(PolicyParseError);
  });
});

describe("defaultPolicy", () => {
  it("blocks CRITICAL, dry-runs HIGH, warns native, allows the rest", () => {
    const config = defaultPolicy();
    expect(evaluate(input({ risk: "CRITICAL" }), config).action).toBe("block");
    expect(evaluate(input({ risk: "HIGH" }), config).action).toBe("require_dry_run");
    expect(evaluate(input({ source: "native" }), config).action).toBe("warn");
    expect(evaluate(input({ risk: "LOW" }), config).action).toBe("allow");
  });
});
