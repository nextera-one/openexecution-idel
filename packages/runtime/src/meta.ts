import type { Registry } from "@openexecution/registry";
import type { OpenLogWriter } from "@openexecution/openlogs";
import type {
  AdapterManifest,
  CommandAst,
  PolicyConfig,
  RuntimeContext,
} from "@openexecution/types";

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
  "list.adapters",
  "search.adapters",
  "check.adapter",
  "install.adapter",
  "remove.adapter",
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

const OFFICIAL_ADAPTER_REPO = "https://github.com/nextera-one/openexecution.git";
const OFFICIAL_ADAPTER_STORE_URL =
  "https://raw.githubusercontent.com/nextera-one/openexecution/main/adapters/metadata.json";
const ADAPTER_STORE_TIMEOUT_MS = 1_200;

const EMBEDDED_OFFICIAL_ADAPTERS: readonly AdapterManifest[] = [
  {
    id: "linux-nftables",
    name: "@openexecution/adapter-linux-nftables",
    version: "0.1.0",
    summary: "Linux nftables backend for firewall and network IDEL commands.",
    repo: OFFICIAL_ADAPTER_REPO,
    path: "adapters/linux-nftables",
    platforms: ["linux"],
    commands: [
      "list.firewall",
      "show.firewall.rule",
      "allow.network",
      "deny.network",
      "remove.firewall.rule",
      "enable.firewall",
      "disable.firewall",
      "flush.firewall",
      "simulate.network",
      "test.network",
      "list.network.interfaces",
      "show.network.routes",
      "add.network.route",
      "remove.network.route",
    ],
    capabilities: ["nft", "root-or-cap_net_admin"],
    riskDomains: ["network"],
    trust: "official",
    entry: "dist/index.js",
  },
  {
    id: "linux-iptables",
    name: "@openexecution/adapter-linux-iptables",
    version: "0.1.0",
    summary: "Linux iptables/ip6tables backend for firewall IDEL commands.",
    repo: OFFICIAL_ADAPTER_REPO,
    path: "adapters/linux-iptables",
    platforms: ["linux"],
    commands: [
      "list.firewall",
      "show.firewall.rule",
      "allow.network",
      "deny.network",
      "remove.firewall.rule",
      "flush.firewall",
      "simulate.network",
    ],
    capabilities: ["iptables", "ip6tables", "root-or-cap_net_admin"],
    riskDomains: ["network"],
    trust: "official",
    entry: "dist/index.js",
  },
  {
    id: "windows-firewall",
    name: "@openexecution/adapter-windows-firewall",
    version: "0.1.0",
    summary: "Windows Defender Firewall backend through PowerShell networking cmdlets.",
    repo: OFFICIAL_ADAPTER_REPO,
    path: "adapters/windows-firewall",
    platforms: ["windows"],
    commands: [
      "list.firewall",
      "show.firewall.rule",
      "allow.network",
      "deny.network",
      "remove.firewall.rule",
      "enable.firewall",
      "disable.firewall",
      "flush.firewall",
      "simulate.network",
      "test.network",
      "list.network.interfaces",
      "show.network.routes",
      "add.network.route",
      "remove.network.route",
    ],
    capabilities: ["administrator", "NetSecurity"],
    riskDomains: ["network"],
    trust: "official",
    entry: "dist/index.js",
  },
  {
    id: "macos-pf",
    name: "@openexecution/adapter-macos-pf",
    version: "0.1.0",
    summary: "macOS pfctl backend for firewall IDEL commands.",
    repo: OFFICIAL_ADAPTER_REPO,
    path: "adapters/macos-pf",
    platforms: ["macos"],
    commands: [
      "list.firewall",
      "show.firewall.rule",
      "allow.network",
      "deny.network",
      "remove.firewall.rule",
      "enable.firewall",
      "disable.firewall",
      "flush.firewall",
      "simulate.network",
      "test.network",
      "list.network.interfaces",
      "show.network.routes",
      "add.network.route",
      "remove.network.route",
    ],
    capabilities: ["pfctl", "root"],
    riskDomains: ["network"],
    trust: "official",
    entry: "dist/index.js",
  },
  {
    id: "unix-pf",
    name: "@openexecution/adapter-unix-pf",
    version: "0.1.0",
    summary: "BSD/Unix pfctl backend for firewall IDEL commands.",
    repo: OFFICIAL_ADAPTER_REPO,
    path: "adapters/unix-pf",
    platforms: ["unix-bsd", "openbsd", "freebsd", "netbsd"],
    commands: [
      "list.firewall",
      "show.firewall.rule",
      "allow.network",
      "deny.network",
      "remove.firewall.rule",
      "enable.firewall",
      "disable.firewall",
      "flush.firewall",
      "simulate.network",
      "test.network",
      "list.network.interfaces",
      "show.network.routes",
      "add.network.route",
      "remove.network.route",
    ],
    capabilities: ["pfctl", "root"],
    riskDomains: ["network"],
    trust: "official",
    entry: "dist/index.js",
  },
  {
    id: "android-shell",
    name: "@openexecution/adapter-android-shell",
    version: "0.1.0",
    summary: "Android rooted-shell backend for iptables/nft network operations.",
    repo: OFFICIAL_ADAPTER_REPO,
    path: "adapters/android-shell",
    platforms: ["android"],
    commands: [
      "list.firewall",
      "show.firewall.rule",
      "allow.network",
      "deny.network",
      "remove.firewall.rule",
      "enable.firewall",
      "disable.firewall",
      "flush.firewall",
      "simulate.network",
      "test.network",
      "list.network.interfaces",
      "show.network.routes",
      "add.network.route",
      "remove.network.route",
    ],
    capabilities: ["root", "iptables-or-nft"],
    riskDomains: ["network"],
    trust: "official",
    entry: "dist/index.js",
  },
];

let adapterStoreCache: readonly AdapterManifest[] | undefined;
let adapterStoreLoad: Promise<readonly AdapterManifest[]> | undefined;

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
    case "list.adapters":
      return listAdapters(ast);
    case "search.adapters":
      return searchAdapters(ast);
    case "check.adapter":
      return checkAdapter(ast);
    case "install.adapter":
      return installAdapter(ast);
    case "remove.adapter":
      return removeAdapter(ast);
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

async function listAdapters(ast: CommandAst): Promise<MetaOutput> {
  const domain = lower(ast.params["domain"]);
  const platform = lower(ast.params["platform"]);
  const adapters = (await officialAdapters()).filter((adapter) => {
    const domainOk = !domain || adapter.riskDomains.some((d) => d.toLowerCase() === domain);
    const platformOk = !platform || adapter.platforms.some((p) => p.toLowerCase() === platform);
    return domainOk && platformOk;
  });
  const lines = adapters.map((adapter) =>
    `${adapter.id.padEnd(18)} ${adapter.platforms.join(",").padEnd(20)} ${adapter.riskDomains.join(",").padEnd(10)} ${adapter.summary}`,
  );
  return {
    stdout: lines.length ? `${lines.length} adapters\n${lines.join("\n")}` : "(no matching adapters)",
    stderr: "",
    exitCode: 0,
  };
}

async function searchAdapters(ast: CommandAst): Promise<MetaOutput> {
  const query = lower(ast.params["query"]);
  if (!query) {
    return { stdout: "", stderr: "search.adapters requires query=<text>", exitCode: 1 };
  }
  const adapters = (await officialAdapters()).filter((adapter) =>
    adapterMatchesQuery(adapter, query),
  );
  const lines = adapters.map((adapter) =>
    `${adapter.id.padEnd(18)} ${adapter.commands.length} commands  ${adapter.repo}`,
  );
  return {
    stdout: lines.length ? `${lines.length} adapters\n${lines.join("\n")}` : "(no matching adapters)",
    stderr: "",
    exitCode: 0,
  };
}

async function checkAdapter(ast: CommandAst): Promise<MetaOutput> {
  const adapter = findAdapter(await officialAdapters(), ast.params["name"]);
  if (!adapter) return noSuchAdapter(ast.params["name"]);
  return {
    stdout: renderAdapter(adapter),
    stderr: "",
    exitCode: 0,
  };
}

async function installAdapter(ast: CommandAst): Promise<MetaOutput> {
  const adapter = findAdapter(await officialAdapters(), ast.params["name"]);
  if (!adapter) return noSuchAdapter(ast.params["name"]);
  const dryRun = ast.params["dryRun"] !== false;
  const lines = [
    `adapter: ${adapter.id}`,
    `repo: ${adapter.repo}`,
    `target: ~/.idel/adapters/${adapter.id}/${adapter.version}`,
    `commands: ${adapter.commands.join(", ")}`,
    `capabilities: ${adapter.capabilities.join(", ")}`,
  ];
  if (!adapter.release) {
    lines.push(
      "release: pending",
      "status: refusing real install until the adapter has a signed GitHub release with sha256 metadata",
    );
    return {
      stdout: `${lines.join("\n")}\n`,
      stderr: dryRun ? "" : "install.adapter requires signed release metadata before writing files.\n",
      exitCode: dryRun ? 0 : 1,
    };
  }
  lines.push(
    `tarball: ${adapter.release.tarballUrl}`,
    `sha256: ${adapter.release.sha256}`,
    `signature: ${adapter.release.signature ?? "(missing)"}`,
  );
  return {
    stdout: `${lines.join("\n")}\n`,
    stderr: dryRun
      ? ""
      : "install.adapter signed download/extract is not enabled in this runtime build.\n",
    exitCode: dryRun ? 0 : 1,
  };
}

async function removeAdapter(ast: CommandAst): Promise<MetaOutput> {
  const adapter = findAdapter(await officialAdapters(), ast.params["name"]);
  if (!adapter) return noSuchAdapter(ast.params["name"]);
  const dryRun = ast.params["dryRun"] !== false;
  const stdout =
    `adapter: ${adapter.id}\n` +
    `target: ~/.idel/adapters/${adapter.id}\n` +
    "status: local adapter removal is planned but not enabled in this runtime build\n";
  return {
    stdout,
    stderr: dryRun ? "" : "remove.adapter real deletion is not enabled in this runtime build.\n",
    exitCode: dryRun ? 0 : 1,
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

function lower(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

async function officialAdapters(): Promise<readonly AdapterManifest[]> {
  if (adapterStoreCache) return adapterStoreCache;
  if (!adapterStoreLoad) {
    adapterStoreLoad = loadAdapterStore().catch(() => EMBEDDED_OFFICIAL_ADAPTERS);
  }
  adapterStoreCache = await adapterStoreLoad;
  return adapterStoreCache;
}

async function loadAdapterStore(): Promise<readonly AdapterManifest[]> {
  const url = adapterStoreUrl();
  if (!url) return EMBEDDED_OFFICIAL_ADAPTERS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADAPTER_STORE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`adapter store HTTP ${res.status}`);
    const adapters = parseAdapterStore(await res.json());
    return adapters.length ? adapters : EMBEDDED_OFFICIAL_ADAPTERS;
  } finally {
    clearTimeout(timeout);
  }
}

function adapterStoreUrl(): string | undefined {
  const override = process.env["IDEL_ADAPTER_STORE_URL"]?.trim();
  if (override && /^(0|false|off|none)$/i.test(override)) return undefined;
  return override || OFFICIAL_ADAPTER_STORE_URL;
}

function parseAdapterStore(raw: unknown): AdapterManifest[] {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw["adapters"])
      ? raw["adapters"]
      : [];
  return source
    .map(normalizeAdapterManifest)
    .filter((adapter): adapter is AdapterManifest => adapter !== undefined);
}

function normalizeAdapterManifest(raw: unknown): AdapterManifest | undefined {
  if (!isRecord(raw)) return undefined;
  const id = nonEmptyString(raw["id"]);
  const name = nonEmptyString(raw["name"]);
  const version = nonEmptyString(raw["version"]);
  const summary = nonEmptyString(raw["summary"]);
  const repo = nonEmptyString(raw["repo"]) ?? OFFICIAL_ADAPTER_REPO;
  const platforms = stringList(raw["platforms"]);
  const commands = stringList(raw["commands"]);
  const capabilities = stringList(raw["capabilities"]);
  const riskDomains = stringList(raw["riskDomains"]);
  const entry = nonEmptyString(raw["entry"]) ?? "dist/index.js";
  if (!id || !name || !version || !summary || !platforms.length || !commands.length) {
    return undefined;
  }
  const trustRaw = nonEmptyString(raw["trust"]);
  const trust =
    trustRaw === "community" || trustRaw === "local" || trustRaw === "official"
      ? trustRaw
      : "official";
  const description = nonEmptyString(raw["description"]);
  const path = nonEmptyString(raw["path"]);
  const release = normalizeAdapterRelease(raw["release"]);
  return {
    id,
    name,
    version,
    summary,
    ...(description ? { description } : {}),
    repo,
    ...(path ? { path } : {}),
    platforms,
    commands,
    capabilities,
    riskDomains,
    trust,
    entry,
    ...(release ? { release } : {}),
  };
}

function normalizeAdapterRelease(raw: unknown): AdapterManifest["release"] | undefined {
  if (!isRecord(raw)) return undefined;
  const tarballUrl = nonEmptyString(raw["tarballUrl"]);
  const sha256 = nonEmptyString(raw["sha256"]);
  if (!tarballUrl || !sha256) return undefined;
  const signature = nonEmptyString(raw["signature"]);
  return {
    tarballUrl,
    sha256,
    ...(signature ? { signature } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function adapterMatchesQuery(adapter: AdapterManifest, query: string): boolean {
  const haystack = [
    adapter.id,
    adapter.name,
    adapter.summary,
    adapter.description ?? "",
    adapter.repo,
    adapter.path ?? "",
    ...adapter.platforms,
    ...adapter.commands,
    ...adapter.capabilities,
    ...adapter.riskDomains,
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function findAdapter(adapters: readonly AdapterManifest[], name: unknown): AdapterManifest | undefined {
  const id = lower(name);
  return adapters.find(
    (adapter) => adapter.id === id || adapter.name.toLowerCase() === id,
  );
}

function noSuchAdapter(name: unknown): MetaOutput {
  return {
    stdout: "",
    stderr:
      `No such adapter: ${String(name ?? "")}. ` +
      "Use list.adapters or search.adapters query=<text>.",
    exitCode: 1,
  };
}

function renderAdapter(adapter: AdapterManifest): string {
  const release = adapter.release
    ? [
        `release.tarball: ${adapter.release.tarballUrl}`,
        `release.sha256: ${adapter.release.sha256}`,
        `release.signature: ${adapter.release.signature ?? "(missing)"}`,
      ]
    : ["release: pending signed GitHub release"];
  return [
    `${adapter.id}  v${adapter.version}  [${adapter.trust}]`,
    `  package: ${adapter.name}`,
    ...(adapter.description ? [`  description: ${adapter.description}`] : []),
    `  repo: ${adapter.repo}`,
    ...(adapter.path ? [`  path: ${adapter.path}`] : []),
    `  platforms: ${adapter.platforms.join(", ")}`,
    `  domains: ${adapter.riskDomains.join(", ")}`,
    `  capabilities: ${adapter.capabilities.join(", ")}`,
    `  entry: ${adapter.entry}`,
    `  commands: ${adapter.commands.join(", ")}`,
    ...release.map((line) => `  ${line}`),
  ].join("\n");
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
