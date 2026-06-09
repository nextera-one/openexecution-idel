import { describe, it, expect } from "vitest";

import { parseArgv } from "./argv.js";

/**
 * CLI argv-parsing tests. The full pipeline is covered by the runtime
 * integration suite; here we lock the thin custom argv layer (spec §10) that
 * separates runtime flags from the IDEL command line.
 */

describe("parseArgv", () => {
  it("treats a bare command as run mode", () => {
    const inv = parseArgv(["create.file", "name=readme.md"]);
    expect(inv.mode).toBe("run");
    expect(inv.command).toBe("create.file name=readme.md");
    expect(inv.native).toBe(false);
  });

  it("recognizes native passthrough via !", () => {
    const inv = parseArgv(["!", "rm -rf dist"]);
    expect(inv.mode).toBe("run");
    expect(inv.native).toBe(true);
    expect(inv.command).toBe("rm -rf dist");
  });

  it("pulls runtime flags out of the command stream", () => {
    const inv = parseArgv([
      "remove.folder",
      "name=dist",
      "recursive=true",
      "--dry-run",
      "--ci",
    ]);
    expect(inv.command).toBe("remove.folder name=dist recursive=true");
    expect(inv.flags.dryRun).toBe(true);
    expect(inv.flags.ci).toBe(true);
  });

  it("reads value flags --policy and --env", () => {
    const inv = parseArgv(["create.file", "name=x", "--policy", "p.yml", "--env", "production"]);
    expect(inv.flags.policyPath).toBe("p.yml");
    expect(inv.flags.environment).toBe("production");
    expect(inv.command).toBe("create.file name=x");
  });

  it("throws when a value flag has no value", () => {
    expect(() => parseArgv(["create.file", "--policy"])).toThrow(/requires a value/);
  });

  it("maps help / version / terminal / completion subcommands", () => {
    expect(parseArgv([]).mode).toBe("help");
    expect(parseArgv(["help"]).mode).toBe("help");
    expect(parseArgv(["version"]).mode).toBe("version");
    expect(parseArgv(["terminal"]).mode).toBe("terminal");
    const c = parseArgv(["completion", "create."]);
    expect(c.mode).toBe("completion");
    expect(c.command).toBe("create.");
  });

  it("handles --no-native and --yes", () => {
    const inv = parseArgv(["!", "echo hi", "--no-native", "--yes"]);
    expect(inv.flags.noNative).toBe(true);
    expect(inv.flags.yes).toBe(true);
    expect(inv.native).toBe(true);
  });
});
