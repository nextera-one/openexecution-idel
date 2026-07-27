import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  canonicalCborBytes,
  compileStructure,
  formatStructure,
  parseStructure,
  type StructureCommand,
  type StructureDocument,
  type StructureValue,
} from "@openexecution/structure";
import {
  canonicalManifest,
  createBundleTar,
  loadManifest,
  manifestDigest,
} from "@openexecution/package";

import type { CliInvocation } from "./argv.js";
import { runPackageCommand } from "./package-command.js";

const DEPENDENCY_COMMANDS = new Set([
  "depend.package.external",
  "depend.source.repository",
  "depend.package.idel",
  "use.container.image",
]);
const REPOSITORY_KINDS = new Set([
  "npm",
  "maven",
  "pypi",
  "cargo",
  "nuget",
  "composer",
  "go",
  "git",
  "oci",
  "idel",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idel",
  "build",
  "dist",
  "node_modules",
  "target",
]);

export interface UniversalCommandOutput {
  exitCode: number;
  text: string;
}

export async function runUniversalCommand(
  invocation: CliInvocation,
  cwd = process.cwd(),
): Promise<UniversalCommandOutput> {
  try {
    if (
      invocation.command === "resolve" &&
      await exists(resolve(cwd, invocation.flags.manifestPath ?? "package.idel"))
    ) {
      return runPackageCommand(
        { ...invocation, mode: "package", command: "resolve" },
        cwd,
      );
    }
    const result = await execute(invocation, resolve(cwd));
    return success(invocation, result);
  } catch (error) {
    return failure(invocation, error);
  }
}

async function execute(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  switch (invocation.command) {
    case "new":
      return newProject(invocation, root);
    case "world":
      return worldCommand();
    case "validate":
      return validateCommand(invocation, root);
    case "format":
      return formatCommand(invocation, root);
    case "compile":
      return compileCommand(invocation, root);
    case "resolve":
      return resolveProject(invocation, root);
    case "add":
      return addDependency(invocation, root);
    case "remove":
      return removeDependency(invocation, root);
    case "why":
      return whyDependency(invocation, root);
    case "outdated":
      return outdatedCommand(invocation, root);
    case "update":
      throw universalError(
        "IDEL_UPDATE_REQUIRES_ADAPTER",
        "update requires a repository adapter resolution pass; run idel resolve after the adapter is installed",
      );
    case "repository":
    case "repo":
      return repositoryCommand(invocation, root);
    case "permissions":
      return permissionsCommand(invocation, root);
    default:
      throw universalError(
        "IDEL_UNIVERSAL_UNKNOWN_COMMAND",
        `unknown universal command ${invocation.command}`,
      );
  }
}

function worldCommand(): Record<string, unknown> {
  return {
    command: "world",
    ecosystem: "idel world",
    client: "idel",
    services: {
      packages: "https://packages.idel.world",
      identity: "idel key",
      evidence: "openlogs",
      runtime: "nexrun",
    },
    repositoryKinds: [...REPOSITORY_KINDS].sort(compareText),
  };
}

async function newProject(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const kind = invocation.arguments[0];
  const requestedName = invocation.arguments[1];
  if (kind !== "application" || requestedName === undefined) {
    throw universalError(
      "IDEL_NEW_USAGE",
      "usage: idel new application <name>",
    );
  }
  const name = safeSegment(requestedName);
  const directory = resolve(root, name);
  ensureChild(root, directory);
  const projectPath = join(directory, "project.idel");
  const repositoriesPath = join(directory, "repositories.idel");
  await mkdir(directory, { recursive: true });
  await writeFile(projectPath, applicationTemplate(name), {
    encoding: "utf8",
    flag: invocation.flags.force ? "w" : "wx",
    mode: 0o644,
  });
  await writeFile(repositoriesPath, repositoryTemplate(), {
    encoding: "utf8",
    flag: invocation.flags.force ? "w" : "wx",
    mode: 0o644,
  });
  return {
    command: "new application",
    application: name,
    directory,
    project: projectPath,
    repositories: repositoriesPath,
  };
}

async function validateCommand(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const target = await discoverSource(invocation, root);
  if (basename(target) === "package.idel") {
    const manifest = await loadManifest(target);
    const bundle = await createBundleTar({
      root: dirname(target),
      manifest,
      manifestPath: target,
    });
    return {
      command: "validate",
      source: target,
      profile: "package",
      package: manifest.name,
      version: manifest.version,
      digest: manifestDigest(manifest),
      files: bundle.index.files.length,
      valid: true,
    };
  }

  const info = await stat(target);
  const files =
    info.isDirectory()
      ? await structureFiles(target)
      : basename(target) === "world.idel"
        ? await structureFiles(dirname(target))
        : [target];
  let commands = 0;
  for (const path of files) {
    const document = parseStructure(await readFile(path, "utf8"));
    commands += document.commands.length;
  }
  return {
    command: "validate",
    source: target,
    profile: basename(target) === "world.idel" ? "world" : "structure",
    documents: files.length,
    commands,
    valid: true,
  };
}

async function formatCommand(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const target = await discoverSource(invocation, root, true);
  const info = await stat(target);
  const files = info.isDirectory() ? await structureFiles(target) : [target];
  let changed = 0;
  for (const path of files) {
    const source = await readFile(path, "utf8");
    const formatted = formatStructure(source);
    if (formatted !== source) {
      await writeAtomic(path, formatted);
      changed++;
    }
  }
  return {
    command: "format",
    target,
    documents: files.length,
    changed,
  };
}

async function compileCommand(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const sourcePath = await discoverSource(invocation, root);
  const source = await readFile(sourcePath, "utf8");
  let bytes: Buffer;
  let digest: string;
  let profile = "structure";
  if (basename(sourcePath) === "package.idel") {
    const manifest = await loadManifest(sourcePath);
    bytes = canonicalCborBytes(canonicalManifest(manifest));
    digest = manifestDigest(manifest);
    profile = "package";
  } else {
    const compiled = compileStructure(source);
    bytes = compiled.bytes;
    digest = compiled.digest;
    if (basename(sourcePath) === "world.idel") profile = "world";
  }
  const sourceName = basename(sourcePath).replace(/\.idel$/u, "");
  const outputPath = resolve(
    root,
    invocation.flags.outputPath ?? join("build", `${sourceName}.idelc`),
  );
  ensureChild(root, outputPath);
  await writeAtomicBytes(outputPath, bytes);
  return {
    command: "compile",
    source: sourcePath,
    output: outputPath,
    profile,
    digest,
    bytes: bytes.length,
  };
}

async function resolveProject(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const projectPath = resolve(root, invocation.flags.filePath ?? "project.idel");
  ensureChild(root, projectPath);
  const source = await readFile(projectPath, "utf8");
  const document = projectDocument(source);
  const dependencies = document.commands[0]!.commands
    .filter((command) => DEPENDENCY_COMMANDS.has(command.name))
    .map((command) => {
      const coordinate = coordinateOf(command);
      if (command.label === undefined || coordinate === undefined) {
        throw universalError(
          "IDEL_DEPENDENCY_COORDINATE_REQUIRED",
          `${command.name} must have a label and coordinate`,
        );
      }
      const repository = command.assignments.find(
        (assignment) => assignment.path === "repository",
      );
      return {
        name: command.label,
        declaration: command.name,
        coordinate,
        repository:
          repository === undefined
            ? undefined
            : constructorText(repository.value),
      };
    })
    .sort((left, right) => compareText(left.name, right.name));
  const projectDigest = compileStructure(source).digest;
  const lockPath = resolve(
    root,
    invocation.flags.lockfilePath ?? "idel.lock",
  );
  ensureChild(root, lockPath);
  await writeAtomic(
    lockPath,
    formatStructure(
      universalLockSource(
        document.commands[0]!.label ?? basename(root),
        projectDigest,
        dependencies,
      ),
    ),
  );
  return {
    command: "resolve",
    project: projectPath,
    lockfile: lockPath,
    projectDigest,
    dependencies: dependencies.length,
    immutable: true,
  };
}

async function addDependency(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const coordinate = invocation.arguments[0];
  if (coordinate === undefined) {
    throw universalError("IDEL_ADD_USAGE", "usage: idel add <coordinate>");
  }
  const projectPath = resolve(
    root,
    invocation.flags.filePath ?? "project.idel",
  );
  const source = await readFile(projectPath, "utf8");
  const document = projectDocument(source);
  const dependency = dependencySource(
    coordinate,
    invocation.flags.repositoryName,
    invocation.flags.purpose,
  );
  const duplicate = document.commands[0]!.commands.find(
    (command) =>
      DEPENDENCY_COMMANDS.has(command.name) &&
      command.label === dependency.label,
  );
  if (duplicate !== undefined) {
    throw universalError(
      "IDEL_DEPENDENCY_EXISTS",
      `dependency ${dependency.label} already exists as ${duplicate.name}`,
    );
  }
  const updated = insertRootCommand(source, dependency.source);
  await writeAtomic(projectPath, formatStructure(updated));
  return {
    command: "add",
    project: projectPath,
    dependency: dependency.label,
    coordinate,
    kind: dependency.kind,
  };
}

async function removeDependency(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const target = invocation.arguments[0];
  if (target === undefined) {
    throw universalError("IDEL_REMOVE_USAGE", "usage: idel remove <dependency>");
  }
  const projectPath = resolve(
    root,
    invocation.flags.filePath ?? "project.idel",
  );
  const source = await readFile(projectPath, "utf8");
  const document = projectDocument(source);
  const command = findDependency(document, target);
  if (command === undefined || command.label === undefined) {
    throw universalError(
      "IDEL_DEPENDENCY_NOT_FOUND",
      `dependency ${target} was not found`,
    );
  }
  const updated = removeLabeledCommand(source, command.name, command.label);
  await writeAtomic(projectPath, formatStructure(updated));
  return {
    command: "remove",
    project: projectPath,
    dependency: command.label,
    removed: true,
  };
}

async function whyDependency(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const target = invocation.arguments[0];
  if (target === undefined) {
    throw universalError("IDEL_WHY_USAGE", "usage: idel why <dependency>");
  }
  const projectPath = resolve(
    root,
    invocation.flags.filePath ?? "project.idel",
  );
  const document = projectDocument(await readFile(projectPath, "utf8"));
  const command = findDependency(document, target);
  if (command === undefined) {
    throw universalError(
      "IDEL_DEPENDENCY_NOT_FOUND",
      `dependency ${target} was not found`,
    );
  }
  return {
    command: "why",
    project: projectPath,
    dependency: command.label,
    declaration: command.name,
    fields: Object.fromEntries(
      command.assignments.map((assignment) => [
        assignment.path,
        displayValue(assignment.value),
      ]),
    ),
    reason: "declared directly by the project",
  };
}

async function outdatedCommand(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const projectPath = resolve(
    root,
    invocation.flags.filePath ?? "project.idel",
  );
  const document = projectDocument(await readFile(projectPath, "utf8"));
  const dependencies = document.commands[0]!.commands
    .filter((command) => DEPENDENCY_COMMANDS.has(command.name))
    .map((command) => ({
      name: command.label,
      declaration: command.name,
      coordinate: coordinateOf(command),
      status: "adapter-check-required",
    }));
  return {
    command: "outdated",
    project: projectPath,
    dependencies,
    checked: false,
    message: "install the applicable repository adapters, then run idel resolve",
  };
}

async function repositoryCommand(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const action = invocation.arguments[0] ?? "list";
  const path = resolve(
    root,
    invocation.flags.filePath ?? "repositories.idel",
  );
  if (action === "add") {
    const name = invocation.arguments[1];
    const kind = invocation.flags.repositoryKind;
    const endpoint = invocation.flags.endpoint;
    if (name === undefined || kind === undefined || endpoint === undefined) {
      throw universalError(
        "IDEL_REPOSITORY_ADD_USAGE",
        "usage: idel repository add <name> --kind <kind> --endpoint <url>",
      );
    }
    if (!REPOSITORY_KINDS.has(kind)) {
      throw universalError(
        "IDEL_REPOSITORY_KIND_INVALID",
        `unsupported repository kind ${kind}`,
      );
    }
    const endpointUrl = new URL(endpoint);
    if (!["http:", "https:"].includes(endpointUrl.protocol)) {
      throw universalError(
        "IDEL_REPOSITORY_ENDPOINT_INVALID",
        "repository endpoint must use HTTP or HTTPS",
      );
    }
    const source = await readOptional(path) ?? emptyRepositoryCatalog();
    const document = repositoryDocument(source);
    if (
      document.commands[0]!.commands.some(
        (command) => command.label === name,
      )
    ) {
      throw universalError(
        "IDEL_REPOSITORY_EXISTS",
        `repository ${name} already exists`,
      );
    }
    const adapter =
      invocation.flags.adapter ?? defaultAdapter(kind);
    const command = repositoryProviderSource(name, kind, endpoint, adapter);
    await writeAtomic(path, formatStructure(insertRootCommand(source, command)));
    return {
      command: "repository add",
      repository: name,
      kind,
      endpoint,
      adapter,
      source: path,
    };
  }

  const source = await readFile(path, "utf8");
  const document = repositoryDocument(source);
  if (action === "list" || action === "verify") {
    const repositories = document.commands[0]!.commands.map((command) => {
      const fields = Object.fromEntries(
        command.assignments.map((assignment) => [
          assignment.path,
          displayValue(assignment.value),
        ]),
      );
      return { name: command.label, ...fields };
    });
    return {
      command: `repository ${action}`,
      source: path,
      repositories,
      verified: action === "verify" ? true : undefined,
    };
  }
  if (action === "remove") {
    const name = invocation.arguments[1];
    if (name === undefined) {
      throw universalError(
        "IDEL_REPOSITORY_REMOVE_USAGE",
        "usage: idel repository remove <name>",
      );
    }
    const command = document.commands[0]!.commands.find(
      (candidate) => candidate.label === name,
    );
    if (command === undefined) {
      throw universalError(
        "IDEL_REPOSITORY_NOT_FOUND",
        `repository ${name} was not found`,
      );
    }
    await writeAtomic(
      path,
      formatStructure(removeLabeledCommand(source, command.name, name)),
    );
    return {
      command: "repository remove",
      repository: name,
      source: path,
      removed: true,
    };
  }
  throw universalError(
    "IDEL_REPOSITORY_UNKNOWN_COMMAND",
    `unknown repository command ${action}`,
  );
}

async function permissionsCommand(
  invocation: CliInvocation,
  root: string,
): Promise<Record<string, unknown>> {
  const path = resolve(
    root,
    invocation.flags.manifestPath ?? "package.idel",
  );
  const manifest = await loadManifest(path);
  return {
    command: "permissions",
    package: manifest.name,
    trust: manifest.runtime.trustLevel.toLowerCase(),
    permissions: manifest.permissions,
  };
}

async function discoverSource(
  invocation: CliInvocation,
  root: string,
  allowDirectory = false,
): Promise<string> {
  const requested =
    invocation.flags.filePath ??
    invocation.arguments.find((argument) => argument.endsWith(".idel") || argument === ".");
  if (requested !== undefined) {
    const target = resolve(root, requested);
    ensureChild(root, target);
    if (!allowDirectory && (await stat(target)).isDirectory()) {
      throw universalError(
        "IDEL_SOURCE_FILE_REQUIRED",
        `${target} is a directory; select an IDEL source file`,
      );
    }
    return target;
  }
  if (allowDirectory) return root;
  for (const name of [
    "world.idel",
    "project.idel",
    "package.idel",
    "workspace.idel",
    "container.idel",
    "deployment.idel",
    "idel.lock",
  ]) {
    const path = join(root, name);
    if (await exists(path)) return path;
  }
  throw universalError(
    "IDEL_SOURCE_NOT_FOUND",
    "no world.idel, project.idel, package.idel, workspace.idel, container.idel, deployment.idel, or idel.lock was found",
  );
}

function projectDocument(source: string): StructureDocument {
  const document = parseStructure(source);
  if (
    document.commands.length !== 1 ||
    document.commands[0]!.name !== "define.project.application"
  ) {
    throw universalError(
      "IDEL_PROJECT_ROOT_INVALID",
      "project.idel must contain exactly one define.project.application root",
    );
  }
  return document;
}

function repositoryDocument(source: string): StructureDocument {
  const document = parseStructure(source);
  if (
    document.commands.length !== 1 ||
    document.commands[0]!.name !== "define.repository.catalog"
  ) {
    throw universalError(
      "IDEL_REPOSITORY_ROOT_INVALID",
      "repositories.idel must contain exactly one define.repository.catalog root",
    );
  }
  for (const command of document.commands[0]!.commands) {
    if (command.name !== "register.repository.provider") {
      throw universalError(
        "IDEL_REPOSITORY_COMMAND_INVALID",
        `unsupported repository catalog command ${command.name}`,
      );
    }
  }
  return document;
}

function dependencySource(
  coordinate: string,
  repositoryOverride?: string,
  purposeOverride?: string,
): { label: string; kind: string; source: string } {
  if (coordinate.startsWith("pkg:")) {
    const parsed = parsePurl(coordinate);
    const repository =
      repositoryOverride ?? defaultRepository(parsed.ecosystem);
    const purpose = purposeOverride ?? "runtime";
    return {
      label: parsed.name,
      kind: `package.${parsed.ecosystem}`,
      source: `depend.package.external ${quote(parsed.name)} {
  ecosystem = ecosystem.${nativeSegment(parsed.ecosystem)}
  coordinate = purl(${quote(coordinate)})
  repository = repository(${quote(repository)})
  purpose = dependency.${nativeSegment(purpose)}
}`,
    };
  }
  if (coordinate.startsWith("git+")) {
    const separator = coordinate.lastIndexOf("#");
    if (separator < 0) {
      throw universalError(
        "IDEL_GIT_COMMIT_REQUIRED",
        "Git dependencies must include an immutable #<commit>",
      );
    }
    const repository = coordinate.slice(4, separator);
    const revision = coordinate.slice(separator + 1);
    if (!/^[0-9a-fA-F]{40,64}$/.test(revision)) {
      throw universalError(
        "IDEL_GIT_COMMIT_INVALID",
        "Git dependency revision must be a 40-64 character hexadecimal commit",
      );
    }
    const name = safeSegment(
      repository.split("/").at(-1)?.replace(/\.git$/u, "") ?? "source",
    );
    return {
      label: name,
      kind: "source.git",
      source: `depend.source.repository ${quote(name)} {
  coordinate = git(${quote(repository)})
  revision = commit(${quote(revision)})
}`,
    };
  }
  if (coordinate.startsWith("idel://")) {
    const match = /\/@([a-z0-9-]+)\/([a-z0-9-]+)@([^#]+)(?:#(sha256:[0-9a-f]{64}))?$/u.exec(
      coordinate,
    );
    if (!match) {
      throw universalError(
        "IDEL_COORDINATE_INVALID",
        `invalid IDEL package coordinate ${coordinate}`,
      );
    }
    const name = match[2]!;
    return {
      label: name,
      kind: "package.idel",
      source: `depend.package.idel ${quote(name)} {
  coordinate = idel(${quote(coordinate)})
${match[4] === undefined ? "" : `  integrity = digest(${quote(match[4])})\n`}}`,
    };
  }
  throw universalError(
    "IDEL_COORDINATE_UNSUPPORTED",
    "coordinate must be a pkg: URL, immutable git+ URL, or idel:// coordinate",
  );
}

function parsePurl(value: string): { ecosystem: string; name: string } {
  const match = /^pkg:([a-z0-9.+-]+)\/(.+)$/u.exec(value);
  if (!match) {
    throw universalError("IDEL_PURL_INVALID", `invalid package URL ${value}`);
  }
  const ecosystem = match[1]!;
  const withoutQualifiers = match[2]!.split(/[?#]/u, 1)[0]!;
  const versionSeparator = withoutQualifiers.lastIndexOf("@");
  const packagePath =
    versionSeparator > 0
      ? withoutQualifiers.slice(0, versionSeparator)
      : withoutQualifiers;
  const rawName = packagePath.split("/").at(-1);
  if (rawName === undefined || rawName.length === 0) {
    throw universalError("IDEL_PURL_INVALID", `invalid package URL ${value}`);
  }
  return {
    ecosystem,
    name: safeSegment(decodeURIComponent(rawName)),
  };
}

function findDependency(
  document: StructureDocument,
  target: string,
): StructureCommand | undefined {
  return document.commands[0]!.commands.find(
    (command) =>
      DEPENDENCY_COMMANDS.has(command.name) &&
      (command.label === target || coordinateOf(command) === target),
  );
}

function coordinateOf(command: StructureCommand): string | undefined {
  const assignment = command.assignments.find(
    (candidate) => candidate.path === "coordinate",
  );
  if (assignment === undefined) return undefined;
  return constructorText(assignment.value);
}

function constructorText(value: StructureValue): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "constructor" &&
    typeof value.arguments[0] === "string"
  ) {
    return value.arguments[0];
  }
  return undefined;
}

function displayValue(value: StructureValue): unknown {
  if (Array.isArray(value)) return value.map(displayValue);
  if (
    typeof value === "object" &&
    value !== null &&
    value.kind === "constructor"
  ) {
    return `${value.name}(${value.arguments
      .map((argument) => JSON.stringify(displayValue(argument)))
      .join(", ")})`;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    value.kind === "enum"
  ) {
    return value.name;
  }
  return value;
}

function insertRootCommand(source: string, command: string): string {
  const document = parseStructure(source);
  if (document.commands.length !== 1) {
    throw universalError(
      "IDEL_EDIT_ROOT_COUNT",
      "source editing requires exactly one root command",
    );
  }
  const closing = source.lastIndexOf("}");
  if (closing < 0) {
    throw universalError("IDEL_EDIT_ROOT_INVALID", "root closing brace not found");
  }
  const indented = command
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${source.slice(0, closing).trimEnd()}\n\n${indented}\n}\n`;
}

function removeLabeledCommand(
  source: string,
  command: string,
  label: string,
): string {
  const needle = `${command} ${quote(label)}`;
  const commandIndex = source.indexOf(needle);
  if (commandIndex < 0) {
    throw universalError(
      "IDEL_EDIT_COMMAND_NOT_FOUND",
      `${command} ${quote(label)} was not found in source`,
    );
  }
  const open = source.indexOf("{", commandIndex + needle.length);
  if (open < 0) {
    throw universalError("IDEL_EDIT_BLOCK_INVALID", "command block is missing {");
  }
  const close = matchingBrace(source, open);
  let start = source.lastIndexOf("\n", commandIndex);
  start = start < 0 ? 0 : start + 1;
  let end = close + 1;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\n") end++;
  if (source[end] === "\n") end++;
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index]!;
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (!inString && character === "#") {
      lineComment = true;
      continue;
    }
    if (!inString && character === "/" && source[index + 1] === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "\"" && !escaped) {
      inString = !inString;
      continue;
    }
    if (inString) {
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === "{") depth++;
    if (character === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw universalError("IDEL_EDIT_BLOCK_INVALID", "command block is missing }");
}

async function structureFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await structureFiles(path));
    else if (entry.name.endsWith(".idel") || entry.name === "idel.lock") {
      result.push(path);
    }
  }
  return result.sort(compareText);
}

function applicationTemplate(name: string): string {
  return `@idel 1.0

define.project.application ${quote(name)} {
  require.evidence.release {
    signature = required
    provenance = required
    sbom = required
  }
}
`;
}

function repositoryTemplate(): string {
  return `@idel 1.0

define.repository.catalog "global" {
  register.repository.provider "npmjs" {
    kind = repository.npm
    endpoint = uri("https://registry.npmjs.org")
    adapter = package("@openexecution/adapter-npm", range("^1.0"))
  }

  register.repository.provider "maven-central" {
    kind = repository.maven
    endpoint = uri("https://repo.maven.apache.org/maven2")
    adapter = package("@openexecution/adapter-maven", range("^1.0"))
  }

  register.repository.provider "github" {
    kind = repository.git
    endpoint = uri("https://github.com")
    adapter = package("@openexecution/adapter-git", range("^1.0"))
  }

  register.repository.provider "nexrun" {
    kind = repository.oci
    endpoint = uri("https://registry.idel.world")
    adapter = package("@nexrun/adapter-oci", range("^1.0"))
  }

  register.repository.provider "idel-world" {
    kind = repository.idel
    endpoint = uri("https://packages.idel.world")
    adapter = builtin
  }
}
`;
}

function emptyRepositoryCatalog(): string {
  return `@idel 1.0

define.repository.catalog "global" {
}
`;
}

function repositoryProviderSource(
  name: string,
  kind: string,
  endpoint: string,
  adapter: string,
): string {
  const adapterExpression =
    adapter === "builtin"
      ? "builtin"
      : `package(${quote(adapter)}, range("^1.0"))`;
  return `register.repository.provider ${quote(name)} {
  kind = repository.${nativeSegment(kind)}
  endpoint = uri(${quote(endpoint)})
  adapter = ${adapterExpression}
}`;
}

function universalLockSource(
  project: string,
  projectDigest: string,
  dependencies: Array<{
    name: string;
    declaration: string;
    coordinate: string;
    repository?: string;
  }>,
): string {
  const entries = dependencies
    .map((dependency) => {
      const coordinateConstructor =
        dependency.declaration === "depend.source.repository"
          ? "git"
          : dependency.declaration === "depend.package.idel"
            ? "idel"
            : dependency.declaration === "use.container.image"
              ? "oci"
              : "purl";
      return `  lock.dependency.entry ${quote(dependency.name)} {
    declaration = ${dependency.declaration}
    coordinate = ${coordinateConstructor}(${quote(dependency.coordinate)})
${dependency.repository === undefined
  ? ""
  : `    repository = repository(${quote(dependency.repository)})\n`}  }`;
    })
    .join("\n\n");
  return `@idel 1.0

define.dependency.lock ${quote(project)} {
  language = semver("1.0")
  project_digest = digest(${quote(projectDigest)})
${entries.length === 0 ? "" : `\n${entries}\n`} }
`;
}

function defaultAdapter(kind: string): string {
  if (kind === "idel") return "builtin";
  if (kind === "oci") return "@nexrun/adapter-oci";
  return `@openexecution/adapter-${kind}`;
}

function defaultRepository(ecosystem: string): string {
  return {
    npm: "npmjs",
    maven: "maven-central",
    pypi: "pypi",
    cargo: "crates-io",
    nuget: "nuget",
    composer: "packagist",
    golang: "go-proxy",
  }[ecosystem] ?? ecosystem;
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, path);
}

async function writeAtomicBytes(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function ensureChild(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.includes("\0") || pathFromRoot === ".." ||
      pathFromRoot.startsWith("../") || isAbsolute(pathFromRoot)) {
    throw universalError(
      "IDEL_PATH_OUTSIDE_WORKSPACE",
      `${target} is outside workspace ${root}`,
    );
  }
}

function safeSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (normalized.length === 0) {
    throw universalError("IDEL_NAME_INVALID", `invalid name ${quote(value)}`);
  }
  return normalized;
}

function nativeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  if (!/^[a-z][a-z0-9_]*$/u.test(normalized)) {
    throw universalError(
      "IDEL_NATIVE_IDENTIFIER_INVALID",
      `invalid native identifier ${value}`,
    );
  }
  return normalized;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function success(
  invocation: CliInvocation,
  result: Record<string, unknown>,
): UniversalCommandOutput {
  return {
    exitCode: 0,
    text: invocation.flags.json
      ? `${JSON.stringify({ ok: true, result })}\n`
      : `${render(result)}\n`,
  };
}

function failure(
  invocation: CliInvocation,
  error: unknown,
): UniversalCommandOutput {
  const typed = error as Error & { code?: string; path?: string };
  const envelope = {
    ok: false,
    error: {
      code: typed.code ?? "IDEL_UNIVERSAL_FAILED",
      message: typed.message,
      retryable: false,
      ...(typed.path === undefined ? {} : { path: typed.path }),
    },
  };
  return {
    exitCode: 1,
    text: invocation.flags.json
      ? `${JSON.stringify(envelope)}\n`
      : `${envelope.error.code}: ${envelope.error.message}\n`,
  };
}

function render(value: unknown, prefix = ""): string {
  if (Array.isArray(value)) {
    return value
      .map((child, index) => render(child, `${prefix}[${index}]`))
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof child === "object" && child !== null
          ? render(child, path)
          : `${path}: ${String(child)}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return `${prefix}: ${String(value)}`;
}

function universalError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
