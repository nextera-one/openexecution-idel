/**
 * Native command danger scanner.
 *
 * Native (passthrough) commands never go through the IDEL registry, so there is
 * no structured AST to classify. Instead we run a *deterministic pattern scan*
 * over the raw command line and emit findings for known-catastrophic shapes.
 *
 * This is a heuristic blocklist, NOT a shell parser. Native input therefore
 * always receives a HIGH untrusted-passthrough finding in addition to any
 * matched signatures. Missing a clever shell spelling can no longer turn a
 * native line into LOW/default-allow; production/hosted contexts should still
 * set `noNative` and remove the surface entirely.
 */

import type { RiskFinding, RiskLevel } from "@openexecution/types";

interface NativePattern {
  /** Stable finding code. */
  code: string;
  level: RiskLevel;
  /** Tested against the *normalized* (whitespace-collapsed) command line. */
  re: RegExp;
  message: string;
}

/**
 * Normalize a native command line for matching: collapse runs of whitespace to
 * a single space and trim. We keep the original for the message. We do NOT
 * lowercase, because most of these tokens are case-sensitive on POSIX; the
 * individual regexes opt into case-insensitivity where it is safe.
 */
function normalize(native: string): string {
  return native.replace(/\s+/g, " ").trim();
}

/**
 * Catastrophe patterns. Order matters only for readability — every pattern is
 * tested and all matches are reported. Patterns are intentionally explicit and
 * commented so the blocklist is auditable.
 */
const PATTERNS: readonly NativePattern[] = [
  // --- rm -rf against root / home / glob-of-root -------------------------
  {
    // rm with recursive+force flags (in any order, combined or separate)
    // targeting `/`, `/*`, `~`, `~/`, or `$HOME`.
    code: "native-rm-rf-root",
    level: "CRITICAL",
    re: /\brm\b(?=[^\n;&|]*(?:\s-r(?:\s|$)|\s-[a-z]*r[a-z]*(?:\s|$)|\s--recursive(?:\s|$|=)))(?=[^\n;&|]*(?:\s-f(?:\s|$)|\s-[a-z]*f[a-z]*(?:\s|$)|\s--force(?:\s|$|=)))/i,
    message: "native `rm` with recursive+force flags",
  },
  {
    code: "native-rm-rf-root-target",
    level: "CRITICAL",
    // The dangerous *target*: exactly / , /* , ~ , ~/ , ~/* , $HOME , /*
    re: /\brm\b[^\n]*\s(?:--no-preserve-root\s+)?(?:\/|\/\*|~\/?\*?|\$HOME\/?\*?)(?:\s|$)/i,
    message: "native `rm` targeting root or home directory",
  },
  {
    code: "native-posix-system-delete",
    level: "CRITICAL",
    re: /\b(?:rm|rmdir|shred)\b[^\n;&|]*(?:^|\s)["']?(?:\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib(?:64)?|\/var|\/System|\/Library)(?:[\/\s"']|$)/im,
    message: "native destructive command targeting an OS-managed POSIX/macOS tree",
  },
  {
    code: "native-no-preserve-root",
    level: "CRITICAL",
    re: /--no-preserve-root/i,
    message: "native `rm --no-preserve-root` defeats the root guard",
  },
  // --- dd writing to a device --------------------------------------------
  {
    code: "native-dd-device",
    level: "CRITICAL",
    re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|hd[a-z]\d*|vd[a-z]\d*|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|md\d+|dm-\d+|mapper\/[^\s;&|]+)/i,
    message: "native `dd` writing directly to a disk device",
  },
  // --- mkfs / format: reformatting a filesystem --------------------------
  {
    code: "native-mkfs",
    level: "CRITICAL",
    re: /\bmkfs(?:\.\w+)?\b|\bmke2fs\b|\bformat\b\s+[a-z]:/i,
    message: "native filesystem-format command (mkfs/format)",
  },
  // --- redirect over a device --------------------------------------------
  {
    code: "native-redirect-device",
    level: "CRITICAL",
    re: />\s*\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|hd[a-z]\d*|vd[a-z]\d*|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|md\d+|dm-\d+|mapper\/[^\s;&|]+)/i,
    message: "native output redirected onto a disk device",
  },
  // --- recursive chmod 777 on root ---------------------------------------
  {
    code: "native-chmod-777-root",
    level: "CRITICAL",
    re: /\bchmod\b[^\n]*\s-[a-z]*R[a-z]*\s[^\n]*\b777\b[^\n]*\s(?:\/|~\/?)(?:\s|$)|\bchmod\b[^\n]*\b777\b[^\n]*\s-[a-z]*R[a-z]*\s[^\n]*\s(?:\/|~\/?)(?:\s|$)/i,
    message: "native recursive `chmod 777` on root/home",
  },
  {
    code: "native-find-delete",
    level: "HIGH",
    re: /\bfind\b[^\n;&|]*\s-delete(?:\s|$)/i,
    message: "native `find -delete` recursively deletes matched paths",
  },
  {
    code: "native-chmod-recursive-broad",
    level: "HIGH",
    // Any recursive chmod 777 (target not necessarily root) — still risky.
    re: /\bchmod\b[^\n]*\s-[a-z]*R[a-z]*\s[^\n]*\b(?:777|a\+rwx)\b|\bchmod\b[^\n]*\b(?:777|a\+rwx)\b[^\n]*\s-[a-z]*R[a-z]*\s/i,
    message: "native recursive `chmod` to world-writable (777)",
  },
  // --- fork bomb ----------------------------------------------------------
  {
    code: "native-fork-bomb",
    level: "CRITICAL",
    // Classic bash fork bomb :(){ :|:& };:  — tolerate spacing variations.
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    message: "native shell fork bomb",
  },
  // --- piping the network into a shell -----------------------------------
  {
    code: "native-curl-pipe-shell",
    level: "HIGH",
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    message: "native download piped directly into a shell",
  },
  // --- Windows recursive delete of a drive root --------------------------
  {
    code: "native-windows-rd-root",
    level: "CRITICAL",
    // Remove-Item -Recurse -Force C:\  /  rd /s /q C:\  /  del /f /s /q C:\*
    re: /\b(?:Remove-Item|rd|rmdir|del)\b[^\n]*\s[a-zA-Z]:\\?(?:\*)?(?:\s|$)/i,
    message: "native recursive delete targeting a Windows drive root",
  },
  {
    code: "native-windows-system-delete",
    level: "CRITICAL",
    re: /\b(?:Remove-Item|rd|rmdir|del)\b(?=[^\n;&|]*(?:-Recurse|\/s)\b)(?=[^\n;&|]*["']?[a-z]:[\\/](?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:[\\/\s"']|$))[^\n;&|]*/i,
    message: "native recursive delete targeting a Windows system directory",
  },
];

const NATIVE_BASELINE: RiskFinding = {
  code: "native-passthrough-untrusted",
  level: "HIGH",
  message:
    "Native shell passthrough is not structurally classified; default execution is disabled.",
};

/**
 * Scan a raw native command line. The HIGH baseline is unconditional because
 * absence of a heuristic match is never evidence that arbitrary shell source
 * is safe.
 */
export function scanNative(native: string): RiskFinding[] {
  const line = normalize(native);
  const findings: RiskFinding[] = [{ ...NATIVE_BASELINE }];
  const seen = new Set<string>([NATIVE_BASELINE.code]);
  for (const p of PATTERNS) {
    if (p.re.test(line)) {
      if (seen.has(p.code)) continue;
      seen.add(p.code);
      findings.push({ code: p.code, level: p.level, message: p.message });
    }
  }
  return findings;
}
