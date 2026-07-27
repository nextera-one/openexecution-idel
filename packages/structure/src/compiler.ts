import { createHash } from "node:crypto";

import { canonicalCborBytes } from "./canonical-cbor.js";
import {
  parseStructure,
  type StructureCommand,
  type StructureDocument,
  type StructureValue,
} from "./parser.js";

export interface CompiledStructure {
  document: StructureDocument;
  canonical: Record<string, unknown>;
  bytes: Buffer;
  digest: string;
}

export function compileStructure(
  source: string | StructureDocument,
): CompiledStructure {
  const document =
    typeof source === "string" ? parseStructure(source) : source;
  const canonical = canonicalDocument(document);
  const bytes = canonicalCborBytes(canonical);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { document, canonical, bytes, digest };
}

export function compileStructureBytes(
  source: string | StructureDocument,
): Buffer {
  return compileStructure(source).bytes;
}

export function compileStructureDigest(
  source: string | StructureDocument,
): string {
  return compileStructure(source).digest;
}

export function canonicalDocument(
  document: StructureDocument,
): Record<string, unknown> {
  const uses = document.uses
    .map((entry) => canonicalValue(entry.source))
    .sort(compareCanonical);
  const commands = document.commands
    .map(canonicalCommand)
    .sort(compareCanonical);
  return {
    language: `idel/${document.languageVersion}`,
    uses,
    commands,
  };
}

function canonicalCommand(command: StructureCommand): Record<string, unknown> {
  const fields = Object.fromEntries(
    [...command.assignments]
      .sort((left, right) => compareText(left.path, right.path))
      .map((assignment) => [
        assignment.path,
        canonicalValue(assignment.value),
      ]),
  );
  return {
    command: command.name,
    ...(command.label === undefined ? {} : { label: command.label }),
    fields,
    commands: command.commands.map(canonicalCommand).sort(compareCanonical),
  };
}

function canonicalValue(value: StructureValue): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (
    typeof value === "object" &&
    value !== null &&
    value.kind === "constructor"
  ) {
    return {
      constructor: value.name,
      arguments: value.arguments.map(canonicalValue),
    };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    value.kind === "enum"
  ) {
    return { enum: value.name };
  }
  return value;
}

function compareCanonical(left: unknown, right: unknown): number {
  return Buffer.compare(canonicalCborBytes(left), canonicalCborBytes(right));
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
