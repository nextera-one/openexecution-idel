import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { canonicalBytes, compareUtf8, sha256 } from "./canonical.js";
import { manifestDigest, validatePackagePath } from "./manifest.js";
import {
  IDEL_BUNDLE_MEDIA_TYPE,
  type BundleFile,
  type BundleIndex,
  type IdelManifest,
} from "./model.js";

const DEFAULT_IGNORES = new Set([
  ".git",
  ".idel",
  "node_modules",
  "dist",
  "target",
]);
const SENSITIVE_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "firebase-adminsdk.json",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);
const BLOCK = 512;

export interface BundleOptions {
  root: string;
  manifest: IdelManifest;
  manifestPath?: string;
  outputPath?: string;
}

export interface BundleResult {
  outputPath: string;
  digest: string;
  size: number;
  index: BundleIndex;
}

export class BundleError extends Error {
  override readonly name = "BundleError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function createBundleTar(
  options: BundleOptions,
): Promise<{ bytes: Buffer; index: BundleIndex }> {
  const root = resolve(options.root);
  const output = options.outputPath ? resolve(options.outputPath) : undefined;
  const manifestPath = resolve(options.manifestPath ?? join(root, "package.idel"));
  ensureInside(root, manifestPath);
  const paths = await collectFiles(root, output);
  const manifestRelative = toPackagePath(relative(root, manifestPath));
  if (!paths.includes(manifestRelative)) {
    throw new BundleError(
      "IDEL_BUNDLE_MANIFEST_MISSING",
      `${manifestRelative} is not included in the package`,
    );
  }
  validateExports(options.manifest, paths);

  const entries: Array<{ path: string; bytes: Buffer; executable: boolean }> = [];
  const files: BundleFile[] = [];
  for (const path of paths) {
    const absolute = join(root, ...path.split("/"));
    const info = await lstat(absolute);
    if (!info.isFile()) {
      throw new BundleError(
        "IDEL_BUNDLE_UNSAFE_FILE",
        `only regular files may be packed: ${path}`,
      );
    }
    const bytes = await readFile(absolute);
    const executable = (info.mode & 0o111) !== 0;
    entries.push({ path, bytes, executable });
    files.push({
      path,
      size: bytes.length,
      mode: executable ? "executable" : "file",
      mediaType: mediaTypeFor(path),
      digest: sha256(bytes),
    });
  }

  const index: BundleIndex = {
    spec: "openexecution.org/idel-bundle/v1",
    mediaType: IDEL_BUNDLE_MEDIA_TYPE,
    package: {
      name: options.manifest.name,
      version: options.manifest.version,
    },
    manifestDigest: manifestDigest(options.manifest),
    files,
  };
  const indexBytes = canonicalBytes(index);
  const tarEntries = [
    {
      path: "IDEL-BUNDLE.json",
      bytes: indexBytes,
      executable: false,
    },
    ...entries,
  ];
  return { bytes: createTar(tarEntries), index };
}

export async function packBundle(options: BundleOptions): Promise<BundleResult> {
  const root = resolve(options.root);
  const defaultName = `${options.manifest.name.slice(1).replace("/", "-")}-${options.manifest.version}.idelb`;
  const outputPath = resolve(options.outputPath ?? join(root, "dist", defaultName));
  const { bytes: tar, index } = await createBundleTar({
    ...options,
    outputPath,
  });
  const compressed = await compressZstd(tar);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, compressed, { mode: 0o644 });
  await chmod(outputPath, 0o644);
  return {
    outputPath,
    digest: sha256(compressed),
    size: compressed.length,
    index,
  };
}

async function collectFiles(root: string, outputPath?: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (outputPath && resolve(absolute) === outputPath) continue;
      const path = toPackagePath(relative(root, absolute));
      validatePackagePath(path);
      rejectSensitivePath(path);
      if (entry.isSymbolicLink()) {
        throw new BundleError(
          "IDEL_BUNDLE_UNSAFE_LINK",
          `symbolic links are not allowed in v1 bundles: ${path}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        if (!path.endsWith(".idelb") && path !== "idel.lock") {
          result.push(path);
        }
      } else {
        throw new BundleError(
          "IDEL_BUNDLE_UNSAFE_FILE",
          `device and special files are not allowed: ${path}`,
        );
      }
    }
  }

  await visit(root);
  return result.sort(compareUtf8);
}

function rejectSensitivePath(path: string): void {
  const name = basename(path).toLowerCase();
  const sensitiveName =
    SENSITIVE_BASENAMES.has(name) ||
    name.startsWith(".env.") ||
    name.startsWith("firebase-adminsdk");
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot);
  if (sensitiveName || SENSITIVE_EXTENSIONS.has(extension)) {
    throw new BundleError(
      "IDEL_BUNDLE_SENSITIVE_FILE",
      `refusing to package credential-like file ${path}; use a declared secret reference instead`,
    );
  }
}

function validateExports(manifest: IdelManifest, paths: string[]): void {
  for (const [kind, patterns] of Object.entries(manifest.exports)) {
    for (const pattern of patterns) {
      const matcher = glob(pattern);
      if (!paths.some((path) => matcher.test(path))) {
        throw new BundleError(
          "IDEL_BUNDLE_EXPORT_MISSING",
          `exports.${kind} pattern ${pattern} does not match a packaged file`,
        );
      }
    }
  }
}

function glob(pattern: string): RegExp {
  validatePackagePath(pattern);
  let output = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        output += ".*";
        index++;
      } else {
        output += "[^/]*";
      }
    } else if (char === "?") {
      output += "[^/]";
    } else {
      output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`, "u");
}

function createTar(
  entries: Array<{ path: string; bytes: Buffer; executable: boolean }>,
): Buffer {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new BundleError(
        "IDEL_BUNDLE_DUPLICATE_PATH",
        `duplicate bundle path ${entry.path}`,
      );
    }
    seen.add(entry.path);
    const header = tarHeader(entry.path, entry.bytes.length, entry.executable);
    chunks.push(header, entry.bytes);
    const remainder = entry.bytes.length % BLOCK;
    if (remainder !== 0) chunks.push(Buffer.alloc(BLOCK - remainder));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function tarHeader(path: string, size: number, executable: boolean): Buffer {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const value = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 6, value);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let index = parts.length - 1; index > 0; index--) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new BundleError(
    "IDEL_BUNDLE_PATH_TOO_LONG",
    `path cannot be represented safely in ustar: ${path}`,
  );
}

function writeString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new BundleError(
      "IDEL_BUNDLE_PATH_TOO_LONG",
      `tar field exceeds ${length} bytes`,
    );
  }
  bytes.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) {
    throw new BundleError("IDEL_BUNDLE_VALUE_TOO_LARGE", "tar numeric field overflow");
  }
  writeString(target, offset, length - 1, text);
  target[offset + length - 1] = 0;
}

function compressZstd(input: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const command = spawn(
      process.env["IDEL_ZSTD"] ?? "zstd",
      ["--compress", "--stdout", "--quiet", "-19", "--threads=1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    command.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    command.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    command.on("error", (error) => {
      reject(
        new BundleError(
          "IDEL_BUNDLE_ZSTD_UNAVAILABLE",
          `zstd is required to create .idelb files: ${error.message}`,
        ),
      );
    });
    command.on("close", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
      } else {
        reject(
          new BundleError(
            "IDEL_BUNDLE_ZSTD_FAILED",
            Buffer.concat(stderr).toString("utf8").trim() ||
              `zstd exited with code ${String(code)}`,
          ),
        );
      }
    });
    command.stdin.end(input);
  });
}

function ensureInside(root: string, child: string): void {
  const rel = relative(root, child);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) {
    throw new BundleError(
      "IDEL_BUNDLE_MANIFEST_OUTSIDE_ROOT",
      "manifest must be inside the package root",
    );
  }
}

function toPackagePath(path: string): string {
  return path.split(sep).join("/");
}

function mediaTypeFor(path: string): string {
  const extension = basename(path).toLowerCase();
  if (path.endsWith(".idel")) return "text/vnd.idel.structure;version=1";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
