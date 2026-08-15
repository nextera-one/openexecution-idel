import { describe, expect, it } from "vitest";

import { buildHandles } from "./handles.js";
import { executeFunction } from "./execute.js";
import { FunctionLoadError, loadFunction, loadRunRequest } from "./model.js";
import { FunctionResolver } from "./resolver.js";
import { MemoryEvidence, MemoryStore } from "./store.js";
import {
  MemoryNonceStore,
  StaticAuthority,
  renderReceipt,
  runRequest,
  runRequestSource,
  verifyReceipt,
} from "./run.js";
import { RefusalError, validateInputs } from "./values.js";

const CREATE_USER = `@idel 1.0

define.function.action "create_user" {
  identity = idel("idel://test/identity/create_user")
  version = semver("1.0.0")
  mode = function.action

  input.field.text "name" {
    required = true
    minimum_length = 2
    maximum_length = 100
  }
  input.field.email "email" {
    required = true
  }

  output.field.uuid "user_id" {
    required = true
  }

  require.authority.capability "user.create" {
    scope = dobase("dobase://identity/users")
  }

  allow.effect.read "users" {
    resource = dobase("dobase://identity/users")
  }
  allow.effect.write "users" {
    resource = dobase("dobase://identity/users")
  }
  allow.effect.append "evidence" {
    resource = evidence("openlogs://identity")
  }

  limit.execution.resources {
    memory = bytes("64mb")
    cpu = cores("0.25")
    timeout = duration("5s")
    maximum_retries = 0
  }

  execute.step.query "existing" {
    from = entity("users")
    where = equal(field("email"), input("email"))
    select = ["id"]
    limit = 1
  }

  execute.step.guard "user_must_not_exist" {
    require = empty(step("existing"))
    otherwise = refuse("user_exists")
  }

  execute.step.insert "user" {
    into = entity("users")

    bind.value.field "name" {
      value = input("name")
    }
    bind.value.field "email" {
      value = input("email")
    }
  }

  execute.step.evidence "user_created" {
    event = "user.created"
    subject = step("user").field("id")
    actor = execution.actor
  }

  execute.step.return "result" {
    bind.output.field "user_id" {
      value = step("user").field("id")
    }
  }
}
`;

const definition = loadFunction(CREATE_USER);

const runRequestSource_ = (overrides: Record<string, string> = {}): string => {
  const values = {
    digest: definition.digest,
    nonce: "018f3c6a-9d2e-7f41-b5aa-3e8d1c2b4a90",
    validUntil: "2999-01-01T00:00:00Z",
    email: "person@example.com",
    ...overrides,
  };
  return `@idel 1.0

define.run.request "create-user" {
  function = idel("idel://test/identity/create_user@1.0.0")
  resolved = digest("${values.digest}")

  bind.input.field "name" {
    value = "person"
  }
  bind.input.field "email" {
    value = "${values.email}"
  }

  require.authority.actor "requester" {
    actor = idelkey("user://tester")
    require = capability("user.create")
  }

  protect.request.replay {
    nonce = nonce("${values.nonce}")
    valid_until = timestamp("${values.validUntil}")
    single_use = true
  }

  configure.execution.target {
    runtime = nexrun("cluster://test")
    evidence = evidence.required
  }
}
`;
};

function dependencies(capabilities = ["user.create"]) {
  const resolver = new FunctionResolver();
  resolver.add(definition, "create_user.func.idel", CREATE_USER);
  return {
    resolver,
    store: new MemoryStore(),
    evidence: new MemoryEvidence(),
    audit: new MemoryEvidence(),
    authority: new StaticAuthority({ "user://tester": capabilities }),
    nonces: new MemoryNonceStore(),
  };
}

describe("loadFunction", () => {
  it("extracts identity, mode, fields, effects, limits, and steps", () => {
    expect(definition.identity).toBe("idel://test/identity/create_user");
    expect(definition.mode).toBe("action");
    expect(definition.inputs.map((f) => f.name)).toEqual(["name", "email"]);
    expect(definition.effects.map((e) => `${e.kind}:${e.entity ?? e.resource}`)).toEqual([
      "read:users",
      "write:users",
      "append:identity",
    ]);
    expect(definition.limits.timeoutMs).toBe(5000);
    expect(definition.limits.memoryBytes).toBe(64 * 1024 * 1024);
    expect(definition.steps.map((s) => s.kind)).toEqual([
      "query",
      "guard",
      "insert",
      "evidence",
      "return",
    ]);
  });

  it("rejects function.pure as reserved for Phase 2", () => {
    const source = CREATE_USER.replace("mode = function.action", "mode = function.pure").replace(
      "define.function.action",
      "define.function.pure",
    );
    expect(() => loadFunction(source)).toThrow(/function\.pure is reserved/);
  });

  it("enforces the mode effect ceiling at load time", () => {
    const source = CREATE_USER.replace("define.function.action", "define.function.query").replace(
      "mode = function.action",
      "mode = function.query",
    );
    expect(() => loadFunction(source)).toThrow(/may not declare an write effect/);
  });

  it("rejects expressions outside the Phase 1 composition set", () => {
    const source = CREATE_USER.replace('value = input("name")', 'value = multiply(input("name"), 2)');
    expect(() => loadFunction(source)).toThrow(FunctionLoadError);
  });
});

describe("loadRunRequest", () => {
  it("requires replay protection", () => {
    const source = runRequestSource_().replace(
      /  protect\.request\.replay \{[\s\S]*?\n  \}\n/,
      "",
    );
    expect(() => loadRunRequest(source)).toThrow(/protect\.request\.replay is required/);
  });

  it("parses nonce, expiry, actor, and capabilities", () => {
    const request = loadRunRequest(runRequestSource_());
    expect(request.nonce).toBe("018f3c6a-9d2e-7f41-b5aa-3e8d1c2b4a90");
    expect(request.actor).toBe("user://tester");
    expect(request.requiredCapabilities).toEqual(["user.create"]);
    expect(request.evidenceRequired).toBe(true);
  });
});

describe("validateInputs", () => {
  it("rejects unknown inputs rather than ignoring them", () => {
    expect(() => validateInputs(definition.inputs, { name: "ok", email: "a@b.co", extra: "x" })).toThrow(
      /unknown_input/,
    );
  });

  it("enforces declared length bounds and formats", () => {
    expect(() => validateInputs(definition.inputs, { name: "a", email: "a@b.co" })).toThrow(/shorter/);
    expect(() => validateInputs(definition.inputs, { name: "ok", email: "nope" })).toThrow(/email/);
  });
});

describe("effects are enforced by construction", () => {
  it("gives a function handles only for its declared effects", () => {
    const handles = buildHandles(definition, {
      store: new MemoryStore(),
      evidence: new MemoryEvidence(),
    });
    expect([...handles.read.keys()]).toEqual(["users"]);
    expect([...handles.write.keys()]).toEqual(["users"]);
    expect(handles.append).toBeDefined();
  });

  it("refuses an insert when the write effect is removed", async () => {
    const source = CREATE_USER.replace(/ *allow\.effect\.write "users" \{[\s\S]*?\n *\}\n/, "");
    const stripped = loadFunction(source);
    await expect(
      executeFunction({
        definition: stripped,
        handles: buildHandles(stripped, { store: new MemoryStore(), evidence: new MemoryEvidence() }),
        inputs: { name: "person", email: "p@example.com" },
        actor: "user://tester",
      }),
    ).rejects.toThrow(/effect_not_declared/);
  });

  it("refuses evidence append when the append effect is removed", async () => {
    const source = CREATE_USER.replace(/ *allow\.effect\.append "evidence" \{[\s\S]*?\n *\}\n/, "");
    const stripped = loadFunction(source);
    await expect(
      executeFunction({
        definition: stripped,
        handles: buildHandles(stripped, { store: new MemoryStore(), evidence: new MemoryEvidence() }),
        inputs: { name: "person", email: "p@example.com" },
        actor: "user://tester",
      }),
    ).rejects.toThrow(/effect_not_declared/);
  });
});

describe("admission", () => {
  it("executes a well-formed request and returns outputs", async () => {
    const deps = dependencies();
    const receipt = await runRequestSource(runRequestSource_(), deps);
    expect(receipt.outcome).toBe("success");
    expect(receipt.outputs.user_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.trace.map((t) => t.kind)).toEqual(["query", "guard", "insert", "evidence", "return"]);
    expect(deps.store.snapshot().users).toHaveLength(1);
    expect(deps.evidence.all()).toHaveLength(1);
    expect(deps.evidence.verify()).toBeNull();
  });

  it("refuses a replayed nonce", async () => {
    const deps = dependencies();
    await runRequestSource(runRequestSource_(), deps);
    const replay = await runRequestSource(runRequestSource_({ email: "other@example.com" }), deps);
    expect(replay.outcome).toBe("refused");
    expect(replay.refusal).toBe("nonce_replayed");
  });

  it("atomically admits only one concurrent use of a nonce", async () => {
    const deps = dependencies();
    const source = runRequestSource_();
    const [first, second] = await Promise.all([
      runRequestSource(source, deps),
      runRequestSource(source, deps),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["refused", "success"]);
    expect([first.refusal, second.refusal]).toContain("nonce_replayed");
  });

  it("refuses an expired request", async () => {
    const receipt = await runRequestSource(
      runRequestSource_({ validUntil: "2000-01-01T00:00:00Z" }),
      dependencies(),
    );
    expect(receipt.refusal).toBe("request_expired");
  });

  it("refuses a digest that does not match the published content", async () => {
    const receipt = await runRequestSource(
      runRequestSource_({ digest: `sha256:${"b".repeat(64)}` }),
      dependencies(),
    );
    expect(receipt.outcome).toBe("refused");
    expect(receipt.refusal).toMatch(/digest mismatch/);
  });

  it("refuses an actor lacking a required capability", async () => {
    const deps = dependencies([]);
    const receipt = await runRequestSource(runRequestSource_(), deps);
    expect(receipt.refusal).toBe("capability_denied:user.create");
    expect(deps.audit.all()).toHaveLength(1);
    expect(deps.audit.all()[0]).toMatchObject({
      event: "function.request.refused",
      subject: receipt.receiptDigest,
      actor: "user://tester",
    });
  });

  it("surfaces a guard refusal as a receipt, not an exception", async () => {
    const deps = dependencies();
    await runRequestSource(runRequestSource_(), deps);
    const second = await runRequestSource(
      runRequestSource_({ nonce: "11111111-1111-1111-1111-111111111111" }),
      deps,
    );
    expect(second.outcome).toBe("refused");
    expect(second.refusal).toBe("user_exists");
  });

  it("does not consume a nonce when admission fails before execution", async () => {
    const deps = dependencies([]);
    const denied = await runRequestSource(runRequestSource_(), deps);
    expect(denied.refusal).toBe("capability_denied:user.create");
    expect(await deps.nonces.seen("018f3c6a-9d2e-7f41-b5aa-3e8d1c2b4a90")).toBe(false);
  });
});

describe("receipts", () => {
  it("round-trips through render and verify", async () => {
    const receipt = await runRequestSource(runRequestSource_(), dependencies());
    const rendered = renderReceipt(receipt);
    const verification = verifyReceipt(rendered);
    expect(verification.valid).toBe(true);
    expect(verification.outcome).toBe("success");
  });

  it("detects a tampered receipt", async () => {
    const receipt = await runRequestSource(runRequestSource_(), dependencies());
    const tampered = renderReceipt(receipt).replace("outcome.success", "outcome.refused");
    expect(verifyReceipt(tampered)).toMatchObject({ valid: false, reason: "digest_mismatch" });
  });

  it("keeps attacker-controlled receipt strings inside their original fields", async () => {
    const request = loadRunRequest(runRequestSource_({ validUntil: "2000-01-01T00:00:00Z" }));
    request.actor = 'user://attacker")\n  outcome = outcome.success\n  record.output.field "forged';
    const receipt = await runRequest(request, { ...dependencies(), now: () => Date.now() });
    expect(receipt.outcome).toBe("refused");

    const rendered = renderReceipt(receipt);
    const verification = verifyReceipt(rendered);
    expect(verification).toMatchObject({ valid: true, outcome: "refused" });
    expect(rendered).not.toContain("\n  outcome = outcome.success\n");
  });
});

describe("resolver", () => {
  it("rejects two different functions claiming one identity", () => {
    const resolver = new FunctionResolver();
    resolver.add(definition, "a.func.idel", CREATE_USER);
    const other = loadFunction(CREATE_USER.replace('timeout = duration("5s")', 'timeout = duration("6s")'));
    expect(() => resolver.add(other, "b.func.idel", CREATE_USER)).toThrow(/claim identity/);
  });

  it("rejects a version that does not match the published function", () => {
    const resolver = new FunctionResolver();
    resolver.add(definition, "a.func.idel", CREATE_USER);
    expect(() => resolver.resolve("idel://test/identity/create_user@2.0.0")).toThrow(/requested version/);
  });
});

describe("timeouts", () => {
  it("refuses when the declared timeout is exceeded mid-composition", async () => {
    let clock = 0;
    await expect(
      executeFunction({
        definition,
        handles: buildHandles(definition, { store: new MemoryStore(), evidence: new MemoryEvidence() }),
        inputs: { name: "person", email: "p@example.com" },
        actor: "user://tester",
        now: () => (clock += 4000),
      }),
    ).rejects.toThrow(RefusalError);
  });
});
