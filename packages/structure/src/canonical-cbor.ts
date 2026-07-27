import { createHash } from "node:crypto";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class CanonicalCborError extends Error {
  override readonly name = "CanonicalCborError";
}

export function canonicalCborBytes(value: unknown): Buffer {
  return encode(value, "$");
}

export function canonicalCborDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalCborBytes(value))
    .digest("hex")}`;
}

function encode(value: unknown, path: string): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === "number") return number(value, path);
  if (Array.isArray(value)) {
    return Buffer.concat([
      head(4, value.length),
      ...value.map((item, index) => encode(item, `${path}[${index}]`)),
    ]);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => {
        if (child === undefined) {
          throw new CanonicalCborError(`${path}.${key}: undefined is forbidden`);
        }
        const encodedKey = encode(key, `${path}.[key]`);
        return {
          key,
          encodedKey,
          encodedValue: encode(child, `${path}.${key}`),
        };
      },
    );
    entries.sort((left, right) =>
      left.encodedKey.length - right.encodedKey.length ||
      Buffer.compare(left.encodedKey, right.encodedKey),
    );
    return Buffer.concat([
      head(5, entries.length),
      ...entries.flatMap(({ encodedKey, encodedValue }) => [
        encodedKey,
        encodedValue,
      ]),
    ]);
  }
  throw new CanonicalCborError(`${path}: unsupported ${typeof value} value`);
}

function number(value: number, path: string): Buffer {
  if (!Number.isFinite(value)) {
    throw new CanonicalCborError(`${path}: non-finite numbers are forbidden`);
  }
  if (Object.is(value, -0)) return Buffer.from([0x00]);
  if (Number.isSafeInteger(value)) {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }

  const single = Buffer.alloc(5);
  single[0] = 0xfa;
  single.writeFloatBE(value, 1);
  if (single.readFloatBE(1) === value) return single;

  const double = Buffer.alloc(9);
  double[0] = 0xfb;
  double.writeDoubleBE(value, 1);
  return double;
}

function head(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanonicalCborError(`invalid CBOR length or integer ${value}`);
  }
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value <= 0xff) return Buffer.from([(major << 5) | 24, value]);
  if (value <= 0xffff) {
    const output = Buffer.alloc(3);
    output[0] = (major << 5) | 25;
    output.writeUInt16BE(value, 1);
    return output;
  }
  if (value <= 0xffffffff) {
    const output = Buffer.alloc(5);
    output[0] = (major << 5) | 26;
    output.writeUInt32BE(value, 1);
    return output;
  }
  const output = Buffer.alloc(9);
  output[0] = (major << 5) | 27;
  output.writeBigUInt64BE(BigInt(value), 1);
  return output;
}
