import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  UnsafeArchiveError,
  preflightArchiveExtraction,
  validateArchiveEntryNames,
} from "./archive-safety.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("archive extraction safety", () => {
  it("accepts ordinary relative archive entries", () => {
    expect(() => validateArchiveEntryNames("dist/\ndist/app.js\n./README.md\n")).not.toThrow();
  });

  it.each([
    "../secret\n",
    "safe/../../secret\n",
    "/etc/passwd\n",
    "C:\\Windows\\System32\\config\n",
    "\\\\server\\share\\secret\n",
  ])("rejects an escaping entry: %s", (listing) => {
    expect(() => validateArchiveEntryNames(listing)).toThrow(UnsafeArchiveError);
  });

  it("rejects control characters in entry names", () => {
    expect(() => validateArchiveEntryNames("safe/evil\u0000name\n")).toThrow(/control/i);
  });

  it("preflights a real tar.gz and rejects traversal before extraction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idel-archive-test-"));
    tempDirs.push(dir);
    const archive = join(dir, "escape.tar.gz");
    await writeFile(archive, gzipSync(tarEntry("../escape.txt", "owned")));
    await expect(preflightArchiveExtraction(archive, dir)).rejects.toThrow(/escapes/i);
  });

  it("rejects symbolic links even when the link entry name is relative", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idel-archive-test-"));
    tempDirs.push(dir);
    const archive = join(dir, "link.tar.gz");
    await writeFile(archive, gzipSync(tarEntry("safe-link", "", "2", "../../outside")));
    await expect(preflightArchiveExtraction(archive, dir)).rejects.toThrow(/link/i);
  });
});

function tarEntry(name: string, content: string, type = "0", link = ""): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  if (link) header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

function writeOctal(buffer: Buffer, offset: number, width: number, value: number): void {
  const octal = value.toString(8).padStart(width - 2, "0");
  buffer.write(`${octal}\0 `, offset, width, "ascii");
}
