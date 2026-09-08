import { describe, expect, it } from "vitest";
import type {
  AdapterSpec,
  CommandAst,
  CommandDef,
  ParamValue,
  ResolvedCommand,
} from "@openexecution/types";
import {
  buildPowerShellHostInvocation,
  PowerShellAdapter,
} from "./powershell.js";
import { renderArgv } from "./render.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function def(id: string, adapters: CommandDef["adapters"]): CommandDef {
  return {
    id,
    version: "1.0.0",
    summary: id,
    category: "test",
    riskDefault: "LOW",
    params: {},
    adapters,
  };
}

function resolved(d: CommandDef): ResolvedCommand {
  return { def: d, source: "core", shadowed: [] };
}

function ast(
  command: string,
  params: Record<string, ParamValue>,
  cwd: string,
): CommandAst {
  return { command, params, rawParams: {}, source: "idel", cwd };
}

/** Remove-Item -Path <path> [-Recurse] [-Force] */
const removeItemSpec: AdapterSpec = {
  command: "Remove-Item",
  args: [
    { kind: "option", flag: "-Path", param: "path" },
    { kind: "flag", flag: "-Recurse", when: "recursive" },
    { kind: "flag", flag: "-Force", when: "force" },
  ],
  semanticNotes:
    "Remove-Item -Recurse differs from rm -r in glob and prompt behavior.",
};

// ---------------------------------------------------------------------------
// renderArgv (runs on every platform)
// ---------------------------------------------------------------------------

describe("renderArgv (powershell copy)", () => {
  it("emits option as two elements and flags only when true", () => {
    const argv = renderArgv(removeItemSpec, {
      path: "dist",
      recursive: true,
      force: false,
    });
    expect(argv).toEqual(["-Path", "dist", "-Recurse"]);
    expect(argv.every((a) => a.length > 0)).toBe(true);
  });

  it("omits the option entirely when path is empty (no empty string)", () => {
    const argv = renderArgv(removeItemSpec, { path: "" });
    expect(argv).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PowerShellAdapter
// ---------------------------------------------------------------------------

describe("PowerShellAdapter", () => {
  const adapter = new PowerShellAdapter();

  it("has the expected name/availability", () => {
    expect(adapter.name).toBe("powershell");
    expect(adapter.available).toBe(process.platform === "win32");
  });

  it("supportsResolved is true for a cmdlet spec, false for @node/@runtime", () => {
    expect(
      adapter.supportsResolved(
        resolved(def("remove.folder", { powershell: removeItemSpec })),
      ),
    ).toBe(true);
    expect(
      adapter.supportsResolved(
        resolved(
          def("create.file", { powershell: { command: "@node", args: [] } }),
        ),
      ),
    ).toBe(false);
    expect(
      adapter.supportsResolved(
        resolved(def("x", { powershell: { command: "@runtime", args: [] } })),
      ),
    ).toBe(false);
    expect(adapter.supportsResolved(resolved(def("y", {})))).toBe(false);
  });

  it("supports uses an injected resolver", () => {
    const d = resolved(def("remove.folder", { powershell: removeItemSpec }));
    const withResolver = new PowerShellAdapter((id) =>
      id === "remove.folder" ? d : undefined,
    );
    expect(withResolver.supports("remove.folder")).toBe(true);
    expect(withResolver.supports("nope")).toBe(false);
    expect(adapter.supports("remove.folder")).toBe(false);
  });

  it("plan() for Remove-Item contains -Path/dist and -Recurse when recursive", () => {
    const d = resolved(def("remove.folder", { powershell: removeItemSpec }));
    const plan = adapter.plan(
      d,
      ast("remove.folder", { path: "dist", recursive: true }, "C:\\tmp"),
    );
    expect(plan.adapter).toBe("powershell");
    expect(plan.command).toBe("Remove-Item");
    expect(plan.argv).toContain("-Path");
    expect(plan.argv).toContain("dist");
    expect(plan.argv).toContain("-Recurse");
    expect(plan.argv).not.toContain("-Force");
    expect(plan.describe).toBe("Remove-Item -Path dist -Recurse");
  });

  it("execute() dryRun returns a simulated result and does NOT spawn", async () => {
    const plan = {
      adapter: "powershell" as const,
      command: "Remove-Item",
      argv: ["-Path", "dist", "-Recurse"],
      describe: "Remove-Item -Path dist -Recurse",
    };
    const result = await adapter.execute(plan, { dryRun: true, cwd: "C:\\tmp" });
    expect(result.simulated).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[dry-run]");
  });

  it("keeps parameter values out of executable PowerShell source", () => {
    const payloads = [
      "x; Start-Process calc.exe",
      "$(Start-Process calc.exe)",
      "x' ; Write-Output injected; #",
      "x\nStart-Process calc.exe",
    ];
    const injectedPath = payloads.join(" | ");
    const plan = adapter.plan(
      resolved(def("remove.folder", { powershell: removeItemSpec })),
      ast(
        "remove.folder",
        { path: injectedPath, recursive: true, force: true },
        "C:\\tmp",
      ),
    );
    const invocation = buildPowerShellHostInvocation(plan);

    expect(invocation.argv.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(invocation.argv).toHaveLength(4);
    for (const payload of payloads) {
      expect(invocation.argv.join(" ")).not.toContain(payload);
    }

    const dispatcher = Buffer.from(invocation.argv[3]!, "base64").toString(
      "utf16le",
    );
    expect(dispatcher).toContain("[Console]::In.ReadToEnd()");
    expect(dispatcher).toContain("$runner.AddCommand($command)");
    expect(dispatcher).toContain("$runner.AddParameter");
    expect(dispatcher).toContain("$runner.AddArgument");
    expect(dispatcher).not.toContain("Start-Process calc.exe");
    expect(JSON.parse(invocation.stdin)).toEqual({
      command: "Remove-Item",
      bindings: [
        { kind: "parameter", name: "Path", value: injectedPath },
        { kind: "parameter", name: "Recurse" },
        { kind: "parameter", name: "Force" },
      ],
    });
  });

  it("converts trusted literal cmdlet syntax into named parameter bindings", () => {
    const spec: AdapterSpec = {
      command: "New-Item",
      args: [
        { kind: "literal", value: "-ItemType" },
        { kind: "literal", value: "File" },
        { kind: "literal", value: "-Path" },
        { kind: "value", param: "name" },
      ],
    };
    const plan = adapter.plan(
      resolved(def("create.file", { powershell: spec })),
      ast("create.file", { name: "-literal-path; still-data" }, "C:\\tmp"),
    );
    expect(JSON.parse(buildPowerShellHostInvocation(plan).stdin)).toEqual({
      command: "New-Item",
      bindings: [
        { kind: "parameter", name: "ItemType", value: "File" },
        {
          kind: "parameter",
          name: "Path",
          value: "-literal-path; still-data",
        },
      ],
    });
  });

  it("refuses to execute an unbound/reconstructed plan", () => {
    expect(() =>
      buildPowerShellHostInvocation({ command: "Write-Output", argv: ["hello"] }),
    ).toThrow(/requires a plan produced/);
  });

  // Real spawn only makes sense on Windows where powershell exists.
  it.skipIf(process.platform !== "win32")(
    "execute() really runs a harmless cmdlet (exit 0)",
    async () => {
      const plan = adapter.plan(
        resolved(
          def("write.output", {
            powershell: {
              command: "Write-Output",
              args: [{ kind: "value", param: "message" }],
            },
          }),
        ),
        ast("write.output", { message: "hello" }, process.cwd()),
      );
      const result = await adapter.execute(plan, {
        dryRun: false,
        cwd: process.cwd(),
      });
      expect(result.simulated).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello");
    },
  );
});
