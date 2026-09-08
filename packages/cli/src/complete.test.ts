import { describe, expect, it } from "vitest";

import { Registry } from "@openexecution/registry";

import { complete, completionFragment } from "./complete.js";

describe("completionFragment", () => {
  it("returns the command fragment while typing a command", () => {
    expect(completionFragment("create.")).toBe("create.");
  });

  it("returns the current param/value token for readline replacement", () => {
    expect(completionFragment("remove.folder name=./")).toBe("name=./");
    expect(completionFragment('create.file name="my file')).toBe('name="my file');
  });

  it("returns the native passthrough path token", () => {
    expect(completionFragment("! ./scr")).toBe("./scr");
  });
});

describe("complete", () => {
  it("completes the current command after a batch separator", async () => {
    const registry = await Registry.loadCore();
    expect(complete("create.file name=a && wai", registry, process.cwd())).toContain("wait.time");
  });
});
