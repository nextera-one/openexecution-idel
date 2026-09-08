import { describe, it, expect } from "vitest";

import { LEARN_USAGE, parseLearnCommand } from "./learn-command.js";

describe("learn command helper", () => {
  it("parses terminal learn aliases", () => {
    expect(parseLearnCommand("learn git")).toEqual({ cli: "git", write: false });
    expect(parseLearnCommand("idel learn git")).toEqual({ cli: "git", write: false });
  });

  it("parses write flags", () => {
    expect(parseLearnCommand("learn git --write")).toEqual({ cli: "git", write: true });
    expect(parseLearnCommand("learn.cli cli=git write=true")).toEqual({
      cli: "git",
      write: true,
    });
  });

  it("parses named cli aliases", () => {
    expect(parseLearnCommand("learn.cli name=git")).toEqual({ cli: "git", write: false });
    expect(parseLearnCommand("learn.cli tool=gh")).toEqual({ cli: "gh", write: false });
  });

  it("ignores unrelated commands", () => {
    expect(parseLearnCommand("create.file name=x")).toBeUndefined();
    expect(LEARN_USAGE).toContain("<cli>");
  });
});
