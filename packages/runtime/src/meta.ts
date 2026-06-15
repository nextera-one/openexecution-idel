import type { Registry } from "@openexecution/registry";
import type { OpenLogWriter } from "@openexecution/openlogs";
import type { CommandAst, PolicyConfig, RuntimeContext } from "@openexecution/types";

/**
 * Meta commands are runtime-internal: they introspect the registry, policy, and
 * logs rather than execute anything against the OS. They are recognized by id
 * and handled here instead of by an execution adapter (their registry defs
 * carry an empty `adapters` map and category "meta").
 */
const META_COMMANDS = new Set<string>([
  "list.registry",
  "explain.registry",
  "check.policy",
  "ask.ai",
  "learn.cli",
  "wait.time",
  "list.history",
  "clear.all",
  "clear.last",
  "clear.first",
  "clear.range",
  "save.workflow",
  "list.workflows",
  "run.workflow",
  "remove.workflow",
  "open.workflows",
  "list.logs",
  "show.logs",
]);

export function isMetaCommand(command: string): boolean {
  return META_COMMANDS.has(command);
}

export interface MetaOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MetaDeps {
  registry: Registry;
  policy: PolicyConfig;
  logWriter: OpenLogWriter | undefined;
  ctx: RuntimeContext;
}

export async function runMeta(
  ast: CommandAst,
  deps: MetaDeps,
): Promise<MetaOutput> {
  switch (ast.command) {
    case "list.registry":
      return registryList(deps);
    case "explain.registry":
      return registryExplain(ast, deps);
    case "check.policy":
      return policyCheck(deps);
    case "ask.ai":
      return askAi();
    case "learn.cli":
      return learnCli();
    case "wait.time":
      return waitTime(ast);
    case "list.history":
      return listHistory(ast, deps);
    case "clear.all":
    case "clear.last":
    case "clear.first":
    case "clear.range":
      return clearScrollback(ast);
    case "save.workflow":
    case "list.workflows":
    case "run.workflow":
    case "remove.workflow":
    case "open.workflows":
      return workflowHostCommand(ast);
    case "list.logs":
      return logsList(ast, deps);
    case "show.logs":
      return logsShow(ast, deps);
    default:
      return { stdout: "", stderr: `Unknown meta command ${ast.command}`, exitCode: 1 };
  }
}

function clearScrollback(ast: CommandAst): MetaOutput {
  return {
    stdout:
      `${ast.command} is handled by the terminal UI. ` +
      "Use it in the web terminal to clear visible scrollback rows.",
    stderr: "",
    exitCode: 0,
  };
}

function workflowHostCommand(ast: CommandAst): MetaOutput {
  return {
    stdout:
      `${ast.command} is handled by the web terminal. ` +
      "Use the Workflows panel there to save, list, run, and remove local workflows.",
    stderr: "",
    exitCode: 0,
  };
}

function registryList(deps: MetaDeps): MetaOutput {
  const defs = deps.registry.list();
  const lines = defs.map(
    (d) => `${d.id.padEnd(24)} ${d.riskDefault.padEnd(8)} ${d.summary}`,
  );
  return {
    stdout: `${defs.length} commands\n${lines.join("\n")}`,
    stderr: "",
    exitCode: 0,
  };
}

function registryExplain(ast: CommandAst, deps: MetaDeps): MetaOutput {
  const name = String(ast.params["command"] ?? ast.params["name"] ?? "");
  if (!name) {
    return { stdout: "", stderr: "explain.registry requires command=<id>", exitCode: 1 };
  }
  const { resolved, allLayers } = deps.registry.explain(name);
  if (!resolved) {
    return { stdout: "", stderr: `No such command: ${name}`, exitCode: 1 };
  }
  const d = resolved.def;
  const out: string[] = [];
  out.push(`${d.id}  (v${d.version})  [${resolved.source}]`);
  out.push(`  ${d.summary}`);
  out.push(`  category: ${d.category}    riskDefault: ${d.riskDefault}`);
  out.push("  params:");
  for (const [pname, p] of Object.entries(d.params)) {
    const req = p.required ? "required" : `default=${String(p.default ?? "—")}`;
    out.push(`    ${pname}: ${p.type} (${req})`);
  }
  if (d.safety) {
    out.push(`  safety: ${JSON.stringify(d.safety)}`);
  }
  out.push("  adapters:");
  for (const [aname, spec] of Object.entries(d.adapters)) {
    if (!spec) continue;
    out.push(`    ${aname}: ${spec.command}`);
    if (spec.semanticNotes) out.push(`      note: ${spec.semanticNotes}`);
  }
  // Show shadowed layers so overrides are visible (spec §15).
  if (allLayers.length > 1) {
    out.push("  layers (winner first):");
    for (const layer of allLayers) {
      out.push(`    [${layer.source}] v${layer.def.version}`);
    }
  }
  return { stdout: out.join("\n"), stderr: "", exitCode: 0 };
}

function policyCheck(deps: MetaDeps): MetaOutput {
  const lines = deps.policy.rules.map((r, i) => {
    const m = JSON.stringify(r.match);
    const approvers = r.approvers ? ` approvers=${r.approvers.join(",")}` : "";
    return `  [${i}] match=${m} -> ${r.action}${approvers}`;
  });
  return {
    stdout: `policy: ${deps.policy.rules.length} rules\n${lines.join("\n")}`,
    stderr: "",
    exitCode: 0,
  };
}

function askAi(): MetaOutput {
  return {
    stdout: "",
    stderr:
      "ask.ai is handled by the CLI or web terminal agent host. Use `idel ask.ai prompt=\"...\"`, `idel ask \"...\"`, or the web Ask mode.",
    exitCode: 1,
  };
}

function learnCli(): MetaOutput {
  return {
    stdout: "",
    stderr:
      "learn.cli is handled by the CLI or web terminal host. Use `idel learn <cli>`, `learn <cli>` inside the terminal, or `learn.cli cli=<cli>` in the web terminal.",
    exitCode: 1,
  };
}

async function waitTime(ast: CommandAst): Promise<MetaOutput> {
  const secondsRaw = ast.params["seconds"];
  const msRaw = ast.params["ms"];
  const seconds = secondsRaw === undefined ? undefined : Number(secondsRaw);
  const ms = msRaw === undefined ? undefined : Number(msRaw);
  const durationMs = ms !== undefined ? ms : (seconds ?? 1) * 1000;

  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60_000) {
    return {
      stdout: "",
      stderr: "wait.time requires seconds/ms between 0 and 60000ms",
      exitCode: 1,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  return {
    stdout: `waited ${durationMs}ms\n`,
    stderr: "",
    exitCode: 0,
  };
}

async function listHistory(ast: CommandAst, deps: MetaDeps): Promise<MetaOutput> {
  if (!deps.logWriter) {
    return { stdout: "", stderr: "No command history configured.", exitCode: 1 };
  }
  const limit = clampHistoryLimit(ast.params["limit"]);
  const records = await deps.logWriter.read(limit);
  const lines = records.map((r, i) => {
    const n = String(i + 1).padStart(4, " ");
    return `${n}  ${r.timestamp}  ${r.result.padEnd(26)} ${r.risk.padEnd(8)} ${formatHistoryCommand(r)}`;
  });
  return {
    stdout: lines.length ? lines.join("\n") : "(no command history)",
    stderr: "",
    exitCode: 0,
  };
}

async function logsList(ast: CommandAst, deps: MetaDeps): Promise<MetaOutput> {
  if (!deps.logWriter) {
    return { stdout: "", stderr: "No log writer configured.", exitCode: 1 };
  }
  const limit = Number(ast.params["limit"] ?? 20);
  const records = await deps.logWriter.read(limit);
  const lines = records.map(
    (r) =>
      `${r.timestamp}  ${r.risk.padEnd(8)} ${r.policyDecision.padEnd(18)} ${r.result.padEnd(26)} ${r.command}`,
  );
  return {
    stdout: lines.length ? lines.join("\n") : "(no log records)",
    stderr: "",
    exitCode: 0,
  };
}

function clampHistoryLimit(raw: unknown): number {
  const n = Number(raw ?? 1000);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.min(Math.trunc(n), 1000);
}

function formatHistoryCommand(record: {
  command: string;
  source: string;
  ast?: { command?: string; params?: Record<string, unknown> };
}): string {
  if (record.source === "native") return record.command;
  const command = record.ast?.command || record.command;
  const params = record.ast?.params ?? {};
  const rendered = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${quoteHistoryValue(value)}`);
  return rendered.length ? `${command} ${rendered.join(" ")}` : command;
}

function quoteHistoryValue(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (!/[\s"'\\&=]/.test(text)) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function logsShow(ast: CommandAst, deps: MetaDeps): Promise<MetaOutput> {
  if (!deps.logWriter) {
    return { stdout: "", stderr: "No log writer configured.", exitCode: 1 };
  }
  const limit = Number(ast.params["limit"] ?? 1);
  const records = await deps.logWriter.read(limit);
  return {
    stdout: records.map((r) => JSON.stringify(r, null, 2)).join("\n"),
    stderr: "",
    exitCode: 0,
  };
}
