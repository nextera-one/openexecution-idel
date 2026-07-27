import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  override readonly name = "CanonicalizationError";
}

export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

export function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(`${path}: non-finite numbers are forbidden`);
    }
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareUtf8);
    const entries: string[] = [];
    for (const key of keys) {
      const child = object[key];
      if (child === undefined) {
        throw new CanonicalizationError(`${path}.${key}: undefined is forbidden`);
      }
      entries.push(`${JSON.stringify(key)}:${encode(child, `${path}.${key}`)}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new CanonicalizationError(`${path}: unsupported ${typeof value} value`);
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
