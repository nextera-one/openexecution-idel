import type {
  CommandAst,
  CommandDef,
  ParamValue,
  RiskFinding,
  RiskLevel,
} from "@openexecution/types";

const ADMIN_PORTS = new Set(["22", "3389", "5985", "5986", "5900"]);
const SENSITIVE_PORTS = new Set([
  "22",
  "3389",
  "5985",
  "5986",
  "5900",
  "5432",
  "3306",
  "6379",
  "9200",
  "27017",
]);

export function isNetworkCommand(ast: CommandAst, def?: CommandDef): boolean {
  if (def?.category === "network" || def?.category === "firewall") return true;
  return (
    ast.command.endsWith(".network") ||
    ast.command.includes(".network.") ||
    ast.command.endsWith(".firewall") ||
    ast.command.includes(".firewall.")
  );
}

export function classifyNetworkIntent(
  ast: CommandAst,
  def?: CommandDef,
): RiskFinding[] {
  if (!isNetworkCommand(ast, def)) return [];

  const findings: RiskFinding[] = [];
  const command = ast.command;
  const from = readText(ast.params["from"] ?? ast.params["source"]);
  const to = readText(ast.params["to"] ?? ast.params["destination"]);
  const port = readText(ast.params["port"]);
  const protocol = readText(ast.params["protocol"]);
  const direction = readText(ast.params["direction"]);

  if (command === "flush.firewall" || command === "disable.firewall") {
    findings.push({
      code: command === "flush.firewall" ? "firewall-flush" : "firewall-disable",
      level: "CRITICAL",
      message:
        command === "flush.firewall"
          ? "Flushing firewall rules can remove all network protection."
          : "Disabling the firewall can expose every reachable service.",
    });
  }

  if (command === "allow.network") {
    classifyAllow({ findings, from, to, port, protocol });
  }

  if (command === "deny.network") {
    classifyDeny({ findings, from, to, port, direction });
  }

  if (command === "remove.firewall.rule") {
    findings.push({
      code: "firewall-rule-removal",
      level: "HIGH",
      message: "Removing a firewall rule can expose or break network access depending on rule order.",
    });
  }

  if (command === "add.network.route" || command === "remove.network.route") {
    classifyRoute({ findings, command, destination: to || readText(ast.params["destination"]) });
  }

  if (command === "allow.network" || command === "deny.network") {
    classifyBroadEndpoints(findings, from, to);
    classifyBroadPort(findings, port, protocol);
  }

  return findings;
}

function classifyAllow(input: {
  findings: RiskFinding[];
  from: string;
  to: string;
  port: string;
  protocol: string;
}): void {
  const { findings, from, to, port, protocol } = input;

  if (isAnySourceAddress(from) && isAnyAddress(to) && isAnyPort(port)) {
    findings.push({
      code: "network-allow-any-any-any",
      level: "CRITICAL",
      message: "Allowing any source to any destination on any port opens the firewall completely.",
    });
    return;
  }

  if (isAnySourceAddress(from) && ADMIN_PORTS.has(normalizePort(port))) {
    findings.push({
      code: "network-allow-public-admin-port",
      level: "CRITICAL",
      message: `Allowing public access to administrative port ${port} is CRITICAL.`,
    });
  } else if (isAnySourceAddress(from) && SENSITIVE_PORTS.has(normalizePort(port))) {
    findings.push({
      code: "network-allow-public-sensitive-port",
      level: "HIGH",
      message: `Allowing public access to sensitive port ${port} requires review.`,
    });
  }

  if (isAnySourceAddress(from) && isAnyProtocol(protocol)) {
    findings.push({
      code: "network-allow-public-any-protocol",
      level: "HIGH",
      message: "Allowing public access for any protocol is broad and should be approved.",
    });
  }
}

function classifyDeny(input: {
  findings: RiskFinding[];
  from: string;
  to: string;
  port: string;
  direction: string;
}): void {
  const { findings, from, to, port, direction } = input;
  if (isAnySourceAddress(from) && isAnyAddress(to) && isAnyPort(port)) {
    findings.push({
      code: "network-deny-any-any-any",
      level: "CRITICAL",
      message: "Denying all traffic can blackhole the host or network.",
    });
    return;
  }

  if (ADMIN_PORTS.has(normalizePort(port))) {
    findings.push({
      code: "network-deny-admin-port",
      level: direction === "out" ? "MEDIUM" : "HIGH",
      message: `Denying administrative port ${port} can lock out remote access.`,
    });
  }
}

function classifyRoute(input: {
  findings: RiskFinding[];
  command: string;
  destination: string;
}): void {
  const { findings, command, destination } = input;
  if (isAnyAddress(destination)) {
    findings.push({
      code: command === "add.network.route" ? "network-add-default-route" : "network-remove-default-route",
      level: "HIGH",
      message:
        command === "add.network.route"
          ? "Adding a default route can redirect broad network traffic."
          : "Removing a default route can cut off network connectivity.",
    });
  }
}

function classifyBroadEndpoints(
  findings: RiskFinding[],
  from: string,
  to: string,
): void {
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    const broad = broadCidrLevel(value);
    if (!broad) continue;
    findings.push({
      code: `network-broad-${name}-cidr`,
      level: broad.level,
      message: `${name}= uses a broad CIDR (${value}).`,
    });
  }
}

function classifyBroadPort(
  findings: RiskFinding[],
  port: string,
  protocol: string,
): void {
  if (isAnyPort(port)) {
    findings.push({
      code: "network-any-port",
      level: "HIGH",
      message: "port=any affects every port.",
    });
  }
  if (isAnyProtocol(protocol)) {
    findings.push({
      code: "network-any-protocol",
      level: "MEDIUM",
      message: "protocol=any affects every protocol.",
    });
  }
}

function readText(value: ParamValue | undefined): string {
  if (value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function normalizePort(port: string): string {
  return port.trim().toLowerCase();
}

function isAnyAddress(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    v === "" ||
    v === "any" ||
    v === "*" ||
    v === "all" ||
    v === "0/0" ||
    v === "0.0.0.0/0" ||
    v === "::/0"
  );
}

/**
 * Firewall source selectors commonly use the bare unspecified addresses as
 * aliases for every remote source. Keep that interpretation scoped to `from=`:
 * a bare 0.0.0.0 destination is not automatically a default route or an
 * any-destination selector, and over-classifying it would hide malformed rule
 * input behind the wrong safety explanation.
 */
function isAnySourceAddress(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "0.0.0.0" || v === "::" || isAnyAddress(v);
}

function isAnyPort(port: string): boolean {
  const v = normalizePort(port);
  return v === "" || v === "any" || v === "*" || v === "all" || v === "0-65535";
}

function isAnyProtocol(protocol: string): boolean {
  const v = protocol.trim().toLowerCase();
  return v === "" || v === "any" || v === "*" || v === "all";
}

function broadCidrLevel(value: string): { level: RiskLevel } | undefined {
  const match = /^([0-9a-f:.]+)\/(\d{1,3})$/i.exec(value.trim());
  if (!match) return undefined;
  const prefix = Number(match[2]);
  if (!Number.isFinite(prefix)) return undefined;
  if (value.includes(":")) {
    if (prefix <= 0) return { level: "CRITICAL" };
    if (prefix <= 32) return { level: "HIGH" };
    if (prefix <= 48) return { level: "MEDIUM" };
    return undefined;
  }
  if (prefix <= 0) return { level: "CRITICAL" };
  if (prefix <= 8) return { level: "HIGH" };
  if (prefix <= 16) return { level: "MEDIUM" };
  return undefined;
}
