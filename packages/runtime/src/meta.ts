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
  "registry.list",
  "registry.explain",
  "policy.check",
  "logs.list",
  "logs.show",
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
    case "registry.list":
      return registryList(deps);
    case "registry.explain":
      return registryExplain(ast, deps);
    case "policy.check":
      return policyCheck(deps);
    case "logs.list":
      return logsList(ast, deps);
    case "logs.show":
      return logsShow(ast, deps);
    default:
      return { stdout: "", stderr: `Unknown meta command ${ast.command}`, exitCode: 1 };
  }
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
    return { stdout: "", stderr: "registry.explain requires command=<id>", exitCode: 1 };
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
