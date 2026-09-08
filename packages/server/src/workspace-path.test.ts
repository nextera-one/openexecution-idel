import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorkspaceRoot, resolveWorkspaceCwd } from "./workspace-path.js";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("accepts an absolute workspace alias while rejecting real escapes", () => {
  const temp = mkdtempSync(join(tmpdir(), "idel-workspace-"));
  temporary.push(temp);
  const workspace = join(temp, "workspace");
  const outside = join(temp, "outside");
  const alias = join(temp, "alias");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "child"));
  mkdirSync(outside);
  symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  const root = canonicalWorkspaceRoot(alias);
  expect(resolveWorkspaceCwd(root, alias)).toBe(root);
  expect(resolveWorkspaceCwd(root, join(alias, "child"))).toBe(join(root, "child"));
  expect(() => resolveWorkspaceCwd(root, outside)).toThrow(/outside/);
  expect(() => resolveWorkspaceCwd(root, "../outside")).toThrow(/escapes/);
  expect(() => resolveWorkspaceCwd(root, join(alias, "escape"))).toThrow(/outside/);
});
