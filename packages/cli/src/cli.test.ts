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
    expect(inv.arguments).toEqual(["create.file", "name=readme.md"]);
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

  it("maps help / version / terminal / connect / serve / completion subcommands", () => {
    expect(parseArgv([]).mode).toBe("help");
    expect(parseArgv(["help"]).mode).toBe("help");
    expect(parseArgv(["version"]).mode).toBe("version");
    expect(parseArgv(["terminal"]).mode).toBe("terminal");
    const remote = parseArgv(["connect", "http://127.0.0.1:8787"]);
    expect(remote.mode).toBe("connect");
    expect(remote.command).toBe("http://127.0.0.1:8787");
    expect(parseArgv(["serve"]).mode).toBe("serve");
    const c = parseArgv(["completion", "create."]);
    expect(c.mode).toBe("completion");
    expect(c.command).toBe("create.");
  });

  it("maps `ask` and `learn` subcommands", () => {
    const a = parseArgv(["ask", "delete", "the", "dist", "folder"]);
    expect(a.mode).toBe("ask");
    expect(a.command).toBe("delete the dist folder");

    const l = parseArgv(["learn", "gh"]);
    expect(l.mode).toBe("learn");
    expect(l.command).toBe("gh");
    expect(l.flags.write).toBeFalsy();

    const lw = parseArgv(["learn", "gh", "--write"]);
    expect(lw.mode).toBe("learn");
    expect(lw.command).toBe("gh");
    expect(lw.flags.write).toBe(true);
  });

  it("maps editor aliases to edit.file", () => {
    const simple = parseArgv(["editor", "README.md"]);
    expect(simple.mode).toBe("run");
    expect(simple.command).toBe("edit.file path=README.md");

    const withParams = parseArgv(["edit", "path=README.md", "editor=code"]);
    expect(withParams.command).toBe("edit.file path=README.md editor=code");

    const spaced = parseArgv(["editor", "my file.txt", "editor=nano"]);
    expect(spaced.command).toBe('edit.file path="my file.txt" editor=nano');
  });

  it("maps explicit and short-form IDEL workflow execution", () => {
    const explicit = parseArgv(["run", "intents/release.idel", "--dry-run"]);
    expect(explicit.mode).toBe("structure-run");
    expect(explicit.command).toBe("intents/release.idel");
    expect(explicit.flags.dryRun).toBe(true);

    const short = parseArgv(["release.idel"]);
    expect(short.mode).toBe("structure-run");
    expect(short.command).toBe("release.idel");
  });

  it("maps package and universal commands without sending them to the execution runtime", () => {
    const validate = parseArgv(["validate", "--manifest", "package/package.idel"]);
    expect(validate.mode).toBe("universal");
    expect(validate.command).toBe("validate");
    expect(validate.flags.manifestPath).toBe("package/package.idel");

    const lock = parseArgv(["lock", "verify", "--immutable"]);
    expect(lock.mode).toBe("package");
    expect(lock.arguments).toEqual(["verify"]);
    expect(lock.flags.immutable).toBe(true);

    const install = parseArgv([
      "install",
      "--registry",
      "https://packages.example",
      "--offline",
    ]);
    expect(install.mode).toBe("package");
    expect(install.flags.registryUrl).toBe("https://packages.example");
    expect(install.flags.offline).toBe(true);

    const add = parseArgv([
      "add",
      "pkg:npm/vue@3.5.17",
      "--file",
      "project.idel",
      "--repository",
      "global#npmjs",
      "--purpose",
      "runtime",
    ]);
    expect(add.mode).toBe("universal");
    expect(add.flags.filePath).toBe("project.idel");
    expect(add.flags.repositoryName).toBe("global#npmjs");
    expect(add.flags.purpose).toBe("runtime");

    const repository = parseArgv([
      "repo",
      "add",
      "pypi",
      "--kind",
      "pypi",
      "--endpoint",
      "https://pypi.org/simple",
    ]);
    expect(repository.mode).toBe("universal");
    expect(repository.command).toBe("repository");
    expect(repository.flags.repositoryKind).toBe("pypi");
  });

  it("handles --no-native and --yes", () => {
    const inv = parseArgv(["!", "echo hi", "--no-native", "--yes"]);
    expect(inv.flags.noNative).toBe(true);
    expect(inv.flags.yes).toBe(true);
    expect(inv.native).toBe(true);
  });

  it("parses serve flags (--port, --host, --static, --open)", () => {
    const inv = parseArgv([
      "serve",
      "--port",
      "9090",
      "--host",
      "0.0.0.0",
      "--static",
      "./www",
      "--open",
      "--enable-native-terminal",
    ]);
    expect(inv.mode).toBe("serve");
    expect(inv.flags.port).toBe(9090);
    expect(inv.flags.host).toBe("0.0.0.0");
    expect(inv.flags.staticDir).toBe("./www");
    expect(inv.flags.open).toBe(true);
    expect(inv.flags.enableNativeTerminal).toBe(true);
  });

  it("rejects an invalid --port", () => {
    expect(() => parseArgv(["serve", "--port", "notaport"])).toThrow(/valid port/);
    expect(() => parseArgv(["serve", "--port", "99999"])).toThrow(/valid port/);
  });
});
