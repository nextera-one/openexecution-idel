import { describe, it, expect, afterEach } from "vitest";

import { detectProvider } from "./select.js";

/**
 * Provider selection is environment-driven, so these tests manipulate
 * ANTHROPIC_API_KEY / IDEL_CLAUDE_PROVIDER and use a bogus `claude` binary name
 * (so the CLI-availability probe always fails) to assert the precedence:
 * forced-override > claude CLI > API key > none. The "claude is installed" case
 * can't be asserted hermetically here (no real binary), so we cover it by
 * forcing `force:"cli"` against a missing bin → null (probe fails).
 */

const BOGUS_BIN = "idel-no-such-claude-binary-xyz";

const savedKey = process.env["ANTHROPIC_API_KEY"];
const savedForce = process.env["IDEL_CLAUDE_PROVIDER"];
afterEach(() => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedKey;
  if (savedForce === undefined) delete process.env["IDEL_CLAUDE_PROVIDER"];
  else process.env["IDEL_CLAUDE_PROVIDER"] = savedForce;
});

describe("detectProvider", () => {
  it("falls back to API when claude CLI is absent and a key is set", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    delete process.env["IDEL_CLAUDE_PROVIDER"];
    expect(await detectProvider(BOGUS_BIN)).toBe("api");
  });

  it("returns null when neither the CLI nor a key is available", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["IDEL_CLAUDE_PROVIDER"];
    expect(await detectProvider(BOGUS_BIN)).toBeNull();
  });

  it("force=cli with no installed CLI → null (does not fall back to API)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test"; // present, but cli is forced
    expect(await detectProvider(BOGUS_BIN, "cli")).toBeNull();
  });

  it("force=api uses the key when present, null when absent", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    expect(await detectProvider(BOGUS_BIN, "api")).toBe("api");
    delete process.env["ANTHROPIC_API_KEY"];
    expect(await detectProvider(BOGUS_BIN, "api")).toBeNull();
  });

  it("IDEL_CLAUDE_PROVIDER=api env forces the API path", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["IDEL_CLAUDE_PROVIDER"] = "api";
    expect(await detectProvider(BOGUS_BIN)).toBe("api");
  });
});
