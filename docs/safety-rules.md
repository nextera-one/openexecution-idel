# Safety Rules

The safety engine is the heart of OpenExecution. It is **deterministic and local** — it never calls an AI, never makes a network request, and produces the same classification every time for the same inputs. This document is the reference for how it works, what it detects, and what it cannot promise.

Source: `packages/safety/src/` (`ast.ts`, `resolved.ts`, `native.ts`, `paths.ts`, `risk.ts`, `floors.ts`).

---

## Table of Contents

- [The two-phase model](#the-two-phase-model)
- [Risk levels](#risk-levels)
- [Finding codes](#finding-codes)
- [Non-overridable safety floors](#non-overridable-safety-floors)
- [The native command scanner](#the-native-command-scanner)
- [Path normalization](#path-normalization)
- [Affected-path estimation](#affected-path-estimation)
- [Precedence reconciliation](#precedence-reconciliation)

---

## The two-phase model

A destructive command is classified **twice**, by two passes that share the same core classification logic but feed it different inputs.

### Phase 1 — AST (string-level)

`assessAst(ast, def)` runs early and cheaply. It works purely from the parsed command and parameters:

- It reads the target parameter (`def.safety.targetParam`, or a fallback of `name` / `path` / `target` / `to` / `destination`).
- It **normalizes the target as a string only** — expands a leading `~`, makes it absolute against the issuing `cwd`, and collapses `.`/`..`. It does **not** touch the filesystem.
- It applies the deterministic location rules (root, home, drive root, device, recursive+force, chmod 777, globs, cwd-escape, hidden).
- The result's level is the max of all findings, floored by the command's declared `riskDefault` (a command declared HIGH never reports LOW).

### Phase 2 — Resolved (real-path)

`assessResolved(ast, def)` runs **immediately before execution**, against live filesystem state. It does what the string phase structurally cannot:

- `fs.realpath` the target, **following symlinks** to their true location. (If the leaf doesn't exist yet — e.g. a `create` — it resolves the nearest existing ancestor.)
- Re-applies the **same** classification rules against the real path.
- Emits a `symlink-target` finding when the target is or routes through a symlink, classified CRITICAL if it points at a protected location.
- For destructive ops, estimates the blast radius (paths + bytes) via a capped directory walk.

### Why both

The string phase is fast and catches the obvious (`name=/`). The resolved phase catches what the string hides — the canonical example:

```text
remove.folder name=dist        # string says "dist" (looks local and harmless)
                               # realpath says "/" (dist is a symlink to root)
```

The AST phase sees `dist` and shrugs. The resolved phase follows the symlink, sees `/`, and emits `symlink-target` at CRITICAL plus `root-delete`.

### The MAX rule

The runtime combines the two with `maxRisk(astRisk, resolvedRisk)` — **effective risk is the higher of the two phases.** Findings from both are merged (de-duplicated by `code:message`). A phase can only ever escalate the result; neither can soften the other.

### CRITICAL short-circuit

If the AST phase already returns CRITICAL, **the resolved phase is skipped entirely** (`runtime.ts`):

```ts
let resolvedRisk;
if (astRisk.level !== "CRITICAL") {
  resolvedRisk = await assessResolved(typedAst, resolved.def);
}
```

Two reasons:

1. **CRITICAL is terminal.** Nothing is higher, and the resolved phase can only escalate. Running it would change nothing.
2. **We must not walk the target we refuse to touch.** The resolved phase estimates the blast radius with a directory walk. For `remove.folder name=/`, that walk would mean traversing `/`. The block decision must never depend on a filesystem traversal of the very path the runtime is about to refuse.

So a CRITICAL-on-string command is blocked without ever reading the filesystem.

### The TOCTOU gap (acknowledged)

There is an unavoidable time-of-check-to-time-of-use window between the resolved assessment and execution. The runtime takes the higher of the two phases, but a path that is swapped for a symlink-to-root *after* the resolved check still slips through. This is a documented, accepted limitation (spec §18), not an oversight. The mitigation is that the resolved check runs as late as possible — immediately before execution — to keep the window small.

---

## Risk levels

A total order, ascending (`risk.ts`):

```text
LOW  <  MEDIUM  <  HIGH  <  CRITICAL
```

- An assessment's level is the **maximum** level among its findings. A clean assessment (no findings) is LOW, never undefined.
- `riskDefault` on a command definition is a **floor, not a ceiling**: findings can push a `riskDefault: LOW` command up to HIGH, but a `riskDefault: HIGH` command can never report LOW.

| Level | What it means | Example |
| --- | --- | --- |
| **LOW** | No dangerous shape detected. | `read.file name=package.json` |
| **MEDIUM** | Reversible-but-noteworthy: overwrites, moves outside cwd, non-broad globs. | `move.file from=a to=../b`, `remove.folder name='build/*'` |
| **HIGH** | Recursive deletion, recursive-force, recursive permission change, empty destructive target. | `remove.folder name=dist recursive=true force=true` |
| **CRITICAL** | Catastrophic and irreversible: root/home/drive-root delete, raw-device write, recursive `777` on a broad tree, dangerous symlink target. | `remove.folder name=/ recursive=true force=true` |

---

## Finding codes

Every finding carries a stable machine `code`, a `level`, and a human `message`. These are the codes the engine actually emits, drawn from `ast.ts`, `resolved.ts`, `native.ts`, and the floor declarations in `floors.ts`.

### IDEL command findings (AST + resolved phases)

| Code | Level | Meaning |
| --- | --- | --- |
| `root-delete` | CRITICAL | Destructive target resolves to the filesystem root `/`. |
| `drive-root-delete` | CRITICAL | Destructive target resolves to a drive root (`C:\`) or UNC share root. |
| `home-delete` | CRITICAL | Destructive target resolves to the user's home directory. |
| `device-write` | CRITICAL | Target is a raw device path (`/dev/sd*`, `/dev/nvme*`, `\\.\PhysicalDrive*`); writing destroys the disk. Flagged for any op, not only declared-destructive ones. |
| `symlink-target` | CRITICAL / MEDIUM | Target is (or routes through) a symlink. CRITICAL when it points at root/home/drive-root/device; MEDIUM otherwise. *Resolved phase only.* |
| `recursive-chmod-777-broad` | CRITICAL | Recursive permission change to `777` on a broad target (root, home, drive root). |
| `recursive-chmod-777` | HIGH | Recursive permission change to `777` on a non-broad target. |
| `recursive-permission` | HIGH | Recursive permission change (not `777`) on a real tree. |
| `recursive-force` | HIGH | Destructive op uses `recursive` and `force` together. |
| `recursive-delete` | HIGH | Recursive deletion of a directory (no `force`). |
| `empty-target` | HIGH | Destructive verb invoked with an empty or missing target. Fully decided at the string level; blocks the rest of classification. |
| `parent-traversal` | HIGH | Destructive target uses `..` to escape the issuing cwd. |
| `broad-glob` | HIGH | Destructive glob whose wildcard sits at/near root, drive root, or home (e.g. `/*`, `~/*`). |
| `glob-target` | MEDIUM | Destructive target contains a wildcard/glob that is *not* broad. |
| `outside-cwd` | MEDIUM | Destructive target is outside the working directory (but not root/home/drive-root). |
| `hidden-target` | LOW | Target is a hidden (dot) path. Informational — does not escalate. |
| `estimate-capped` | LOW | The affected-path walk hit the entry cap; the reported count is a lower bound. *Resolved phase only.* |
| `risk-default` | (varies) | Synthetic finding that injects the command's `riskDefault` as a floor during finalization. |

### Native passthrough findings (`scanNative`)

These come from the deterministic scanner; see [the native scanner section](#the-native-command-scanner) for the patterns.

| Code | Level | Meaning |
| --- | --- | --- |
| `native-passthrough` | MEDIUM | Baseline for any native command — passthrough is inherently less audited. |
| `native-rm-rf-root` | CRITICAL | `rm` with recursive + force flags. |
| `native-rm-rf-root-target` | CRITICAL | `rm` targeting `/`, `/*`, `~`, `~/`, or `$HOME`. |
| `native-no-preserve-root` | CRITICAL | `rm --no-preserve-root` — defeats the root guard. |
| `native-dd-device` | CRITICAL | `dd of=/dev/…` writing directly to a disk device. |
| `native-mkfs` | CRITICAL | Filesystem-format command (`mkfs`, `mke2fs`, `format X:`). |
| `native-redirect-device` | CRITICAL | Output redirected onto a disk device (`> /dev/sda`). |
| `native-chmod-777-root` | CRITICAL | Recursive `chmod 777` on root/home. |
| `native-chmod-recursive-broad` | HIGH | Any recursive `chmod 777` / `a+rwx` (target not necessarily root). |
| `native-fork-bomb` | CRITICAL | Classic shell fork bomb `:(){ :|:& };:`. |
| `native-curl-pipe-shell` | HIGH | Network download piped directly into a shell (`curl … | sh`). |
| `native-windows-rd-root` | CRITICAL | Recursive delete targeting a Windows drive root (`Remove-Item`/`rd`/`del C:\`). |

### Non-classification findings (runtime)

| Code | Level | Meaning |
| --- | --- | --- |
| `native-disabled` | HIGH | Native passthrough attempted while `--no-native` is set; blocked. |
| `parse-error` | LOW | Input could not be parsed; recorded then failed. |
| `usage-error` | LOW | Resolution/coercion failed (unknown command, bad params); recorded then failed. |

---

## Non-overridable safety floors

`SAFETY_FLOORS` in `floors.ts` is the declarative, auditable statement of the minimum risk classifications that **no custom or official registry, and no policy file, may weaken.** The detection rules in `ast.ts` / `resolved.ts` are the *enforcement*; this list is the *contract*. Each floor's `code` matches the finding code the engine emits, so the runtime can cross-check that an assessment never came back softer than the floor it triggered.

| Code | Floor level | Description |
| --- | --- | --- |
| `root-delete` | CRITICAL | Destructive op whose target resolves to filesystem root `/`. Always CRITICAL. |
| `home-delete` | CRITICAL | Destructive op whose target resolves to the user's home directory. Always CRITICAL. |
| `drive-root-delete` | CRITICAL | Destructive op whose target resolves to a drive root (`C:\`), UNC share root, or `/`. Always CRITICAL. |
| `device-write` | CRITICAL | Write/disk op targeting a raw device (`/dev/sd*`, `/dev/nvme*`, `\\.\PhysicalDrive*`). Always CRITICAL. |
| `recursive-chmod-777-broad` | CRITICAL | Recursive permission change to `777` on a broad target. Always CRITICAL. |
| `empty-target` | HIGH | Destructive verb with an empty/missing target. At least HIGH. |

These floors resolve **core-first** — the opposite direction from registry content (see [precedence reconciliation](#precedence-reconciliation)).

---

## The native command scanner

Native (passthrough) commands never go through the registry, so there is no structured AST to classify. Instead, `scanNative` (`native.ts`) runs a **deterministic pattern scan** over the raw command line.

It is a **heuristic blocklist, not a shell parser.** It deliberately errs toward flagging. A clean scan does **not** prove a native command is safe — it only means none of the listed catastrophe patterns matched. The policy layer is expected to gate native execution further (e.g. `--no-native` in CI/production).

The command line is normalized first (runs of whitespace collapsed to a single space, trimmed). It is **not** lowercased, because most of these tokens are case-sensitive on POSIX; individual patterns opt into case-insensitivity where safe. Every pattern is tested and all matches are reported (de-duplicated by code).

The patterns (with their finding codes) are listed in the [native findings table](#native-passthrough-findings-scannative) above. In summary, the scanner catches:

- **Destructive `rm`** — recursive+force flags in any order, targets of `/`, `/*`, `~`, `$HOME`, and the `--no-preserve-root` guard-defeat.
- **Device destruction** — `dd of=/dev/sd*`, redirection onto a device (`> /dev/sda`), filesystem formatting (`mkfs`, `mke2fs`, `format X:`).
- **Permission catastrophe** — recursive `chmod 777` (CRITICAL on root/home, HIGH otherwise).
- **Shell catastrophe** — the classic fork bomb, and `curl|wget … | sh` (network piped into a shell).
- **Windows** — recursive delete of a drive root via `Remove-Item` / `rd` / `rmdir` / `del`.

In addition to any pattern hits, `assessAst` adds a baseline `native-passthrough` finding at MEDIUM, so even an unmatched native command is at least MEDIUM — passthrough is inherently less audited than a registry command.

---

## Path normalization

All of this happens in `paths.ts` and is **pure string/path math** in the AST phase; the resolved phase layers real fs calls on top.

- **`~` expansion** — a *leading* `~` or `~/…` expands to the user's home directory (`expandHome`). A tilde in the middle of a path is left untouched, matching shell semantics.
- **Absolute resolution & `..` collapse** — `normalizeTarget` runs `path.resolve(cwd, expanded)`, which makes a relative target absolute against the issuing cwd and collapses `.`/`..` segments.
- **No env-var expansion** — `$VAR` / `%VAR%` are treated as opaque and **not** expanded. The runtime never shells out, so there is nothing to expand; an unexpanded variable stays a literal string.
- **Symlink resolution** — only in the **resolved phase** (`fs.realpath` / `fs.readlink`). This is what turns `dist` into `/` when `dist` is a symlink.
- **Cross-platform awareness** — both POSIX (`/x`) and Windows (`C:\x`, `\\server\share`) absolute forms are recognized regardless of the host, because a command authored on one platform may be classified on another, and `C:\` is just as dangerous as `/`.

Detection helpers worth knowing: `isRoot`, `isDriveRoot` (covers bare `C:`, `C:\`, and UNC share roots), `isHome`, `isDevicePath` (block/char devices and Windows physical drives), `hasGlob` / `isBroadGlob`, `hasParentTraversal`, `isOutsideCwd`, `isHidden`.

---

## Affected-path estimation

For destructive ops on a directory that actually exists, the resolved phase estimates the blast radius with `walkCapped` (`resolved.ts`):

- It walks the target tree **iteratively** (explicit stack, no recursion-depth blow-ups on deep trees), accumulating an entry count and total byte size.
- **Symlinks are not followed** during the walk (`lstat` each entry), so the estimate never escapes the target subtree.
- The walk stops at **`WALK_ENTRY_CAP = 5000` entries.** Walking an unbounded tree (think `node_modules`, or `/`) would hang the pre-execution check.
- When the cap is hit, the count is reported as a **lower bound** and an `estimate-capped` finding (LOW) is added so the user knows the real count is higher. A single-file target reports `1` path and its size.

The estimate is surfaced as `affectedPathsEstimate` in the outcome and the OpenLog record, and shown in the CLI as `affected paths (estimate): N`. **It is an estimate and a lower bound, never an exact guarantee.**

---

## Precedence reconciliation

Two precedence systems run in **opposite directions**, and conflating them is the most common source of confusion:

| System | Direction | Who enforces it |
| --- | --- | --- |
| **Registry content** | `custom > official > core` | `packages/registry` resolver |
| **Safety floors** | `core > everything` (non-overridable) | `packages/safety` floors + `packages/policy` |

A team can override the *content* of a command — its summary, its adapters, even its `riskDefault` upward — by shipping a custom definition that shadows core. But they **cannot** weaken a core safety floor: no custom or official def can classify a root delete below CRITICAL, and no policy rule can clear it.

The enforcement point is the policy engine (`evaluate.ts`). On a CRITICAL command, if the first matching rule says `allow`, `warn`, or `require_dry_run`, the engine **rewrites the action to `block`** and records the override in the decision reason:

```text
Matched rule N (action: allow), but CRITICAL risk enforces a hard 'block'
floor — only an explicit approval_required rule may permit a CRITICAL
command. Overriding 'allow' to 'block'.
```

The only sanctioned way past a CRITICAL is an explicit `approval_required` rule — a deliberate, logged team exception. `--yes` auto-approves *approval prompts*; it is not a CRITICAL bypass, because the floor is applied before approval is ever asked for.
