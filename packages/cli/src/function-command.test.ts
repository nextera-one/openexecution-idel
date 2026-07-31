import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runFunction, verifyExecution } from "./function-command.js";

const FUNCTION = `@idel 1.0

define.function.action "create_user" {
  identity = idel("idel://test/identity/create_user")
  version = semver("1.0.0")
  mode = function.action

  input.field.text "name" {
    required = true
    minimum_length = 2
  }

  output.field.uuid "user_id" {
    required = true
  }

  require.authority.capability "user.create" {
    scope = dobase("dobase://identity/users")
  }

  allow.effect.write "users" {
    resource = dobase("dobase://identity/users")
  }

  limit.execution.resources {
    timeout = duration("5s")
    maximum_retries = 0
  }

  execute.step.insert "user" {
    into = entity("users")

    bind.value.field "name" {
      value = input("name")
    }
  }

  execute.step.return "result" {
    bind.output.field "user_id" {
      value = step("user").field("id")
    }
  }
}
`;

const request = (digest: string, nonce = "n-1"): string => `@idel 1.0

define.run.request "create-user" {
  function = idel("idel://test/identity/create_user@1.0.0")
  resolved = digest("${digest}")

  bind.input.field "name" {
    value = "person"
  }

  require.authority.actor "requester" {
    actor = idelkey("user://tester")
    require = capability("user.create")
  }

  protect.request.replay {
    nonce = nonce("${nonce}")
    valid_until = timestamp("2999-01-01T00:00:00Z")
    single_use = true
  }

  configure.execution.target {
    runtime = nexrun("cluster://test")
    evidence = evidence.required
  }
}
`;

let root: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "idel-fn-"));
  writeFileSync(join(root, "create_user.func.idel"), FUNCTION);
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const digestOfFunction = async (): Promise<string> => {
  const { loadFunction } = await import("@openexecution/function");
  return loadFunction(FUNCTION).digest;
};

const grant = (capabilities: string[]): void => {
  mkdirSync(join(root, ".idel"), { recursive: true });
  writeFileSync(
    join(root, ".idel", "authority.json"),
    JSON.stringify({ "user://tester": capabilities }),
  );
};

describe("idel run.function", () => {
  it("fails closed when no capability grants exist", async () => {
    const path = join(root, "r.run.idel");
    writeFileSync(path, request(await digestOfFunction()));
    const code = await runFunction(path, { json: true, root });
    expect(code).toBe(4);
    expect(JSON.parse(out.join("")).refusal).toBe("capability_denied:user.create");
  });

  it("executes and persists the store when the actor is authorized", async () => {
    grant(["user.create"]);
    const path = join(root, "r.run.idel");
    writeFileSync(path, request(await digestOfFunction()));
    const code = await runFunction(path, { json: true, root });
    expect(code).toBe(0);
    const receipt = JSON.parse(out.join(""));
    expect(receipt.outcome).toBe("success");
    const store = JSON.parse(readFileSync(join(root, ".idel", "function-store.json"), "utf8"));
    expect(store.users).toHaveLength(1);
    expect(store.users[0].name).toBe("person");
  });

  it("persists nonces so replay protection survives a restart", async () => {
    grant(["user.create"]);
    const path = join(root, "r.run.idel");
    writeFileSync(path, request(await digestOfFunction()));
    expect(await runFunction(path, { json: true, root })).toBe(0);
    out.length = 0;
    expect(await runFunction(path, { json: true, root })).toBe(4);
    expect(JSON.parse(out.join("")).refusal).toBe("nonce_replayed");
  });

  it("refuses a digest that does not match published content", async () => {
    grant(["user.create"]);
    const path = join(root, "r.run.idel");
    writeFileSync(path, request(`sha256:${"c".repeat(64)}`));
    expect(await runFunction(path, { json: true, root })).toBe(4);
    expect(JSON.parse(out.join("")).refusal).toMatch(/digest mismatch/);
  });

  it("dry runs without touching the store or evidence", async () => {
    grant(["user.create"]);
    const path = join(root, "r.run.idel");
    writeFileSync(path, request(await digestOfFunction()));
    expect(await runFunction(path, { json: true, root, dryRun: true })).toBe(0);
    expect(JSON.parse(out.join("")).dryRun).toBe(true);
    expect(existsSync(join(root, ".idel", "function-store.json"))).toBe(false);
    expect(existsSync(join(root, ".idel", "function-evidence.jsonl"))).toBe(false);
  });

  it("writes and verifies a receipt round-trip", async () => {
    grant(["user.create"]);
    const path = join(root, "r.run.idel");
    const receiptPath = join(root, "receipt.idel");
    writeFileSync(path, request(await digestOfFunction()));
    await runFunction(path, { json: true, root, receiptPath });
    out.length = 0;
    expect(verifyExecution(receiptPath, { json: true })).toBe(0);
    expect(JSON.parse(out.join("")).valid).toBe(true);

    const tampered = join(root, "tampered.idel");
    writeFileSync(tampered, readFileSync(receiptPath, "utf8").replace("outcome.success", "outcome.refused"));
    out.length = 0;
    expect(verifyExecution(tampered, { json: true })).toBe(1);
    expect(JSON.parse(out.join("")).valid).toBe(false);
  });

  it("reports a missing request file rather than throwing", async () => {
    expect(await runFunction(join(root, "nope.run.idel"), { json: true, root })).toBe(1);
    expect(err.join("")).toMatch(/No such run request/);
  });
});
