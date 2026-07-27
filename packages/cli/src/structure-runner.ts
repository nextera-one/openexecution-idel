import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  compileStructure,
  type StructureCommand,
  type StructureValue,
} from "@openexecution/structure";

const EXECUTABLE_ROOTS = new Set([
  "define.intent.workflow",
  "define.execution.plan",
  "define.workflow.execution",
]);

export interface StructureExecutionPlan {
  source: string;
  workflow: string;
  digest: string;
  commands: string[];
}

export async function loadStructureExecutionPlan(
  requestedPath: string,
  cwd = process.cwd(),
): Promise<StructureExecutionPlan> {
  const source = resolve(cwd, requestedPath);
  if (!basename(source).endsWith(".idel")) {
    throw executionError(
      "IDEL_RUN_FILE_REQUIRED",
      "idel run requires a .idel file",
    );
  }
  const compiled = compileStructure(await readFile(source, "utf8"));
  if (
    compiled.document.commands.length !== 1 ||
    !EXECUTABLE_ROOTS.has(compiled.document.commands[0]!.name)
  ) {
    throw executionError(
      "IDEL_RUN_DECLARATIVE_DOCUMENT",
      "only workflow or execution-plan roots can run; use idel validate or idel compile for declarative files",
    );
  }
  const root = compiled.document.commands[0]!;
  const commands = root.commands.flatMap(commandLines);
  if (commands.length === 0) {
    throw executionError(
      "IDEL_RUN_EMPTY_WORKFLOW",
      `${root.name} contains no executable commands`,
    );
  }
  return {
    source,
    workflow: root.label ?? basename(source, ".idel"),
    digest: compiled.digest,
    commands,
  };
}

/**
 * Resolve IDEL-native interactive terminal forms:
 *   run.workflow.idel -> ./workflow.idel
 *   run.workflow      -> ./workflow.idel, when that file exists
 *
 * The existence check on the short form preserves established runtime commands
 * such as `run.script`; a local `script.idel` opts into the workflow meaning.
 */
export async function terminalWorkflowPath(
  line: string,
  cwd = process.cwd(),
): Promise<string | undefined> {
  const explicit = /^run\.([a-z][a-z0-9_]*)\.idel$/u.exec(line);
  if (explicit) return `${explicit[1]!}.idel`;
  const short = /^run\.([a-z][a-z0-9_]*)$/u.exec(line);
  if (!short) return undefined;
  const candidate = `${short[1]!}.idel`;
  try {
    await access(resolve(cwd, candidate));
    return candidate;
  } catch {
    return undefined;
  }
}

function commandLines(command: StructureCommand): string[] {
  if (command.commands.length > 0) {
    return command.commands.flatMap(commandLines);
  }
  const parameters = command.assignments.map(
    (assignment) =>
      `${runtimeField(assignment.path)}=${runtimeValue(assignment.value)}`,
  );
  return [`${command.name}${parameters.length === 0 ? "" : ` ${parameters.join(" ")}`}`];
}

function runtimeField(path: string): string {
  if (path.includes(".")) {
    throw executionError(
      "IDEL_RUN_NESTED_FIELD_UNSUPPORTED",
      `runtime parameter ${path} must be a direct field`,
    );
  }
  return path.replace(/_([a-z0-9])/gu, (_, letter: string) =>
    letter.toUpperCase());
}

function runtimeValue(value: StructureValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(plainValue));
  }
  if (value.kind === "enum") return value.name;
  if (value.arguments.length === 1) return runtimeValue(value.arguments[0]!);
  return JSON.stringify({
    constructor: value.name,
    arguments: value.arguments.map(plainValue),
  });
}

function plainValue(value: StructureValue): unknown {
  if (Array.isArray(value)) return value.map(plainValue);
  if (typeof value !== "object" || value === null) return value;
  if (value.kind === "enum") return value.name;
  return {
    constructor: value.name,
    arguments: value.arguments.map(plainValue),
  };
}

function executionError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
