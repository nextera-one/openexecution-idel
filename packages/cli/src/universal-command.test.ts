import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseStructure } from "@openexecution/structure";

import { parseArgv } from "./argv.js";
import { runUniversalCommand } from "./universal-command.js";
import {
  loadStructureExecutionPlan,
  terminalWorkflowPath,
} from "./structure-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "idel-cli-"));
  temporaryDirectories.push(path);
  return path;
}

async function run(arguments_: string[], cwd: string) {
  return runUniversalCommand(parseArgv([...arguments_, "--json"]), cwd);
}

function result(output: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
  expect(output.exitCode).toBe(0);
  return JSON.parse(output.text).result as Record<string, unknown>;
}

describe("universal IDEL CLI", () => {
  it("creates, validates, compiles, and describes an application", async () => {
    const root = await workspace();
    const created = result(await run(["new", "application", "Customer-Portal"], root));
    const application = created.directory as string;

    expect(await readFile(join(application, "project.idel"), "utf8"))
      .toContain('define.project.application "customer-portal"');
    expect(await readFile(join(application, "repositories.idel"), "utf8"))
      .toContain('register.repository.provider "idel-world"');

    const validation = result(await run(["validate"], application));
    expect(validation.valid).toBe(true);
    expect(validation.profile).toBe("structure");

    const compilation = result(
      await run(["compile", "--file", "project.idel"], application),
    );
    expect(compilation.profile).toBe("structure");
    expect((compilation.digest as string).startsWith("sha256:")).toBe(true);
    expect((await stat(compilation.output as string)).size).toBeGreaterThan(0);
  });

  it("adds universal dependencies and writes a deterministic IDEL lock", async () => {
    const root = await workspace();
    const application = (
      result(await run(["new", "application", "portal"], root)).directory
    ) as string;
    const commit = "a3dd0344e925f4cfd82b2c4cb29e02cc8d39212b";

    result(await run(["add", "pkg:npm/vue@3.5.17"], application));
    result(await run([
      "add",
      `git+https://github.com/nextera/custom-adapter.git#${commit}`,
    ], application));
    result(await run([
      "add",
      "idel://packages.idel.world/@openexecution/evidence@1.1.3",
    ], application));

    const why = result(await run(["why", "vue"], application));
    expect(why.reason).toBe("declared directly by the project");

    const resolution = result(await run(["resolve"], application));
    expect(resolution.dependencies).toBe(3);
    const lock = await readFile(join(application, "idel.lock"), "utf8");
    expect(() => parseStructure(lock)).not.toThrow();
    expect(lock).toContain("project_digest = digest(");
    expect(lock).toContain('lock.dependency.entry "vue"');

    result(await run(["remove", "vue"], application));
    expect(await readFile(join(application, "project.idel"), "utf8"))
      .not.toContain('depend.package.external "vue"');
  });

  it("manages repository providers with the repo alias", async () => {
    const root = await workspace();
    const application = (
      result(await run(["new", "application", "portal"], root)).directory
    ) as string;

    result(await run([
      "repo",
      "add",
      "pypi",
      "--kind",
      "pypi",
      "--endpoint",
      "https://pypi.org/simple",
    ], application));
    const listed = result(await run(["repository", "list"], application));
    expect((listed.repositories as Array<{ name: string }>).some(
      (repository) => repository.name === "pypi",
    )).toBe(true);

    const verified = result(await run(["repo", "verify"], application));
    expect(verified.verified).toBe(true);

    result(await run(["repo", "remove", "pypi"], application));
    const source = await readFile(join(application, "repositories.idel"), "utf8");
    expect(source).not.toContain('"pypi"');
  });

  it("reports IDEL World service discovery", async () => {
    const output = result(await run(["world"], await workspace()));
    expect(output.client).toBe("idel");
    expect(output.services).toMatchObject({
      packages: "https://packages.idel.world",
      runtime: "nexrun",
    });
  });

  it("compiles executable IDEL workflows into governed runtime commands", async () => {
    const root = await workspace();
    await writeFile(
      join(root, "release.idel"),
      `@idel 1.0

define.intent.workflow "release" {
  create.file "release-marker" {
    name = "release.txt"
    overwrite = false
  }
}
`,
      "utf8",
    );
    const plan = await loadStructureExecutionPlan("release.idel", root);
    expect(plan.workflow).toBe("release");
    expect(plan.digest).toMatch(/^sha256:/u);
    expect(plan.commands).toEqual([
      'create.file name="release.txt" overwrite=false',
    ]);
    expect(await terminalWorkflowPath("run.release.idel", root))
      .toBe("release.idel");
    expect(await terminalWorkflowPath("run.release", root))
      .toBe("release.idel");
    expect(await terminalWorkflowPath("run.script", root)).toBeUndefined();

    await writeFile(
      join(root, "project.idel"),
      '@idel 1.0\n\ndefine.project.application "portal" {\n}\n',
      "utf8",
    );
    await expect(loadStructureExecutionPlan("project.idel", root))
      .rejects.toMatchObject({ code: "IDEL_RUN_DECLARATIVE_DOCUMENT" });
  });
});
