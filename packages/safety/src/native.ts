/**
 * Native command danger scanner.
 *
 * Native (passthrough) commands never go through the IDEL registry, so there is
 * no structured AST to classify. Instead we run a *deterministic pattern scan*
 * over the raw command line and emit findings for known-catastrophic shapes.
 *
 * This is a heuristic blocklist, NOT a shell parser — it deliberately errs on
 * the side of flagging. A clean scan does not prove a native command is safe;
 * it only means none of the listed catastrophe patterns matched. The runtime's
 * policy layer is expected to gate native execution further (e.g. noNative in
 * CI/production).
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
    re: /\brm\b[^\n]*?\s-[a-z]*r[a-z]*f|\brm\b[^\n]*?\s-[a-z]*f[a-z]*r|\brm\b[^\n]*?(?:\s-r\b[^\n]*\s-f\b|\s-f\b[^\n]*\s-r\b)/i,
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
    code: "native-no-preserve-root",
    level: "CRITICAL",
    re: /--no-preserve-root/i,
    message: "native `rm --no-preserve-root` defeats the root guard",
  },
  // --- dd writing to a device --------------------------------------------
  {
    code: "native-dd-device",
    level: "CRITICAL",
    re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d|disk\d)/i,
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
    re: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d|disk\d)/i,
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
];

/**
 * Scan a raw native command line and return any catastrophe findings. An empty
 * array means no listed pattern matched (NOT a safety guarantee).
 */
export function scanNative(native: string): RiskFinding[] {
  const line = normalize(native);
  const findings: RiskFinding[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    if (p.re.test(line)) {
      if (seen.has(p.code)) continue;
      seen.add(p.code);
      findings.push({ code: p.code, level: p.level, message: p.message });
    }
  }
  return findings;
}
