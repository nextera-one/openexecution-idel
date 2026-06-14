import { describe, expect, it } from "vitest";

import { completionFragment } from "./complete.js";

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
