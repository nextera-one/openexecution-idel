# Registry & Command-Definition Schema

The registry is product content, not a side file — the bundled `registries/core/*.json` definitions *are* the runtime's command surface. This document is the reference for the `CommandDef` shape, the structured adapter-argument model, the three resolution layers, and how to add a custom command.

Source of truth for the types: `packages/types/src/index.ts`. Loader and resolver: `packages/registry/src/`.

---

## Table of Contents

- [The CommandDef shape](#the-commanddef-shape)
- [ParamSchema and the five param types](#paramschema-and-the-five-param-types)
- [AdapterArgSpec — structured, not templated](#adapterargspec--structured-not-templated)
- [The three layers and resolution order](#the-three-layers-and-resolution-order)
- [The extraArgs rule](#the-extraargs-rule)
- [The semanticNotes honesty principle](#the-semanticnotes-honesty-principle)
- [A fully annotated command: remove.folder](#a-fully-annotated-command-removefolder)
- [Adding a custom command](#adding-a-custom-command)

---

## The CommandDef shape

A command definition is a single JSON object (a `*.json` file may hold one object or an array of them). The full shape, from `types/src/index.ts`:

```ts
interface CommandDef {
  id: string;                 // dotted command name, e.g. "remove.folder"
  version: string;            // semver of this definition
  summary: string;            // one-line description
  category: string;           // grouping, e.g. "filesystem"
  riskDefault: RiskLevel;     // LOW | MEDIUM | HIGH | CRITICAL — a floor, not a ceiling
  params: Record<string, ParamSchema>;
  allowExtraArgs?: boolean;   // permit unknown params (LOW/MEDIUM, non-destructive only)
  safety?: CommandSafety;     // static safety hints
  adapters: Partial<Record<AdapterName, AdapterSpec>>; // posix | powershell | node
  examples?: string[];
  tests?: RegistryTest[];
  source?: CommandSource;     // set by the loader at load time, NOT present on disk
}
```

The `safety` block (`CommandSafety`) carries the static hints the safety engine reads:

```ts
interface CommandSafety {
  destructive?: boolean;                  // can destroy/overwrite data
  blockTargets?: string[];                // targets that must always be blocked, e.g. ["/", "C:\\", "~"]
  requiresAffectedPathEstimate?: boolean; // require a blast-radius estimate before HIGH+ execution
  targetParam?: string;                   // which param holds the primary filesystem target
}
```

`riskDefault` is a **floor**: findings can raise a command above it, but it can never report below it. `targetParam` tells the safety engine which parameter to normalize and classify; without it, the engine falls back to `name` / `path` / `target` / `to` / `destination`.

### Validation is fail-closed

Every def is checked against the schema at load time (`schema.ts` via `checkCommandDef`). An invalid def is **not loaded** — it is reported as a problem and, by default, the whole layer load throws (`fail closed`). A typo in a custom def fails loudly rather than silently producing a wrong mapping.

---

## ParamSchema and the five param types

```ts
interface ParamSchema {
  type: ParamType;       // "string" | "boolean" | "number" | "path" | "mode"
  required?: boolean;
  default?: ParamValue;  // string | number | boolean
  enum?: ParamValue[];   // closed set of allowed values
  description?: string;
}
```

The parser leaves every value as a raw string (except bare `true`/`false`, which become real booleans). `coerce.ts` finishes the job per the declared type:

| Type | Coercion | Notes |
| --- | --- | --- |
| `string` | kept as-is | |
| `boolean` | `"true"` / `"false"` (case-insensitive) → real boolean | |
| `number` | `parseFloat`, error on `NaN` | |
| `path` | kept as a string | no filesystem touch here; safety resolves it later |
| `mode` | validated against `^0?[0-7]{3,4}$` (e.g. `755`, `0644`, `1777`), kept as the **original string** | preserved as a string so the adapter emits exactly what was typed (a leading `0` survives) |

Coercion also applies defaults to missing optional params, errors on missing required params, and validates `enum` membership.

---

## AdapterArgSpec — structured, not templated

This is a deliberate, load-bearing design decision. An adapter does **not** build its argv from string templates. The registry describes each argument **declaratively**, and the adapter renders it to a real `string[]` in code by *conditional array construction* (`renderArgv` in `adapters-posix/src/render.ts`, mirrored in the PowerShell package).

The original spec sketched handlebars-style argv strings like:

```jsonc
// REJECTED — the original spec's approach
"args": ["{{#if recursive}}-r{{/if}}", "{{#if force}}-f{{/if}}", "{{name}}"]
```

Those were replaced because they are quote-unsafe, produce empty-string argv elements when a condition is false, and invite shell injection. The structured form cannot do any of that.

`AdapterArgSpec` is a discriminated union with four kinds:

```ts
type AdapterArgSpec =
  | { kind: "flag"; flag: string; when: string }   // emit `flag` only when boolean param `when` is true
  | { kind: "option"; flag: string; param: string } // emit `flag` then the value of `param` (two argv elements)
  | { kind: "value"; param: string }                // emit the value of `param` as one positional
  | { kind: "literal"; value: string };             // emit a fixed literal
```

| Kind | When it emits | Renders to | Example def | Example argv |
| --- | --- | --- | --- | --- |
| `flag` | param `when` is strictly `true` | `[flag]` | `{ "kind": "flag", "flag": "-r", "when": "recursive" }` | `["-r"]` (or nothing) |
| `option` | param `param` is present (defined, non-empty) | `[flag, String(value)]` | `{ "kind": "option", "flag": "-Path", "param": "name" }` | `["-Path", "dist"]` |
| `value` | param `param` is present | `[String(value)]` | `{ "kind": "value", "param": "name" }` | `["dist"]` |
| `literal` | always | `[value]` | `{ "kind": "literal", "value": "-czf" }` | `["-czf"]` |

The renderer **never pushes an empty-string argv element.** A missing or empty parameter means "omit this argument entirely," not "pass an empty positional." A `flag` only fires on strict boolean `true`; an `option`/`value` is skipped when its param is absent or `""`.

Execution itself uses `spawn` with `shell: false` and the rendered argv array — no shell, no interpolation. (The single exception is native passthrough, which is the user's explicit, logged, risk-scanned escape hatch and passes the command line through verbatim.)

---

## The three layers and resolution order

A command id can be defined in up to three layers. Content resolution is **highest-priority-wins**:

```text
custom  >  official  >  core
```

| Layer | Location | Purpose |
| --- | --- | --- |
| **custom** | `~/.idel/registries/custom` | User/team-specific mappings. |
| **official** | installed package / `~/.idel/registries/official` | Maintained dictionaries for known tools, after review. |
| **core** | bundled with the runtime (`registries/core/`) | The small, safety-first command set that ships with the CLI. |

A higher layer's definition wins; the lower ones it hides are recorded as `shadowed`. Overrides are **visible** via `explain.registry`, which prints the winning layer and every shadowed layer beneath it:

```text
$ idel explain.registry command=remove.folder

remove.folder  (v1.0.0)  [core]
  Delete a directory, optionally recursively and forcibly.
  category: filesystem    riskDefault: HIGH
  params:
    name: path (required)
    recursive: boolean (default=false)
    force: boolean (default=false)
    dryRun: boolean (default=false)
  safety: {"destructive":true,"targetParam":"name","blockTargets":["/","C:\\","~"],"requiresAffectedPathEstimate":true}
  adapters:
    posix: rm
    powershell: Remove-Item
      note: Remove-Item -Recurse has historically had quirks with reparse points/symlinks…
```

When a custom or official def shadows a core one, `explain.registry` additionally prints a `layers (winner first)` block so the override is never silent.

> **Important:** registry-content precedence (`custom > official > core`) is the *opposite* direction from the safety floors (`core > everything`, non-overridable). A custom def can change a command's content, but it can never weaken a core CRITICAL classification. See [docs/safety-rules.md](safety-rules.md#precedence-reconciliation).

---

## The extraArgs rule

The long tail of CLI flags cannot all be modeled in V1. The escape valve (spec §21) is `allowExtraArgs`, but it is deliberately narrow. Unknown params pass through **only when all of these hold** (`coerce.ts`):

1. `allowExtraArgs: true` is set on the def, **and**
2. the command's `riskDefault` is `LOW` or `MEDIUM`, **and**
3. the command is **not** destructive (`safety.destructive` is not `true`).

A `HIGH`/`CRITICAL` or destructive command with `allowExtraArgs: true` **still rejects** unknown params — it fails closed. You can never smuggle an un-modeled flag into a dangerous command. When extras are rejected, the error explains why:

```text
param "foo": unknown parameter (extra args are not permitted on HIGH/destructive commands — spec §21)
```

---

## The semanticNotes honesty principle

Where POSIX and PowerShell genuinely differ — different binaries, different overwrite behavior, different container formats, different permission models — the registry does **not** fake parity. The `AdapterSpec.semanticNotes` field states the divergence honestly so the difference is auditable, and the adapter emits only what is faithful.

Real examples from the core defs:

- **`set.file.permission` / `set.folder.permission`** — POSIX uses `chmod` with an octal `mode`. PowerShell uses `icacls`, and **the octal `mode` is intentionally not mapped**: Windows ACLs are not POSIX modes, and a faithful translation is non-trivial and lossy. The note says so and marks the PowerShell adapter best-effort.

  ```jsonc
  "powershell": {
    "command": "icacls",
    "args": [{ "kind": "value", "param": "path" }],
    "semanticNotes": "DIVERGES: Windows ACLs are not POSIX modes. icacls cannot consume an octal `mode`… intentionally NOT mapped here."
  }
  ```

- **`create.archive`** — POSIX `tar -czf` produces a gzip tar. PowerShell `Compress-Archive` produces a **ZIP**. The note: *"DIVERGES: Compress-Archive produces a ZIP, not a gzip tar. The container format differs, so an archive produced on one platform is not byte-compatible with the other."*

- **`extract.archive`** — `tar -xzf` overwrites existing files silently; `Expand-Archive` **errors** on existing files without `-Force`. Both the container format and the overwrite behavior diverge, and the note records both.

- **`move.file`** — `mv` overwrites the destination by default; `Move-Item` **refuses** to overwrite without `-Force`. Destructiveness is real on POSIX, blocked-by-default on PowerShell.

When there is no faithful shell form at all (writing file content, appending, `cd`, reading env), the def provides only a `@node` adapter and explains why — e.g. a child process cannot mutate the parent's cwd or environment, so those are handled in-process.

---

## A fully annotated command: remove.folder

The real definition from `registries/core/filesystem.json`, annotated:

```jsonc
{
  "id": "remove.folder",
  "version": "1.0.0",
  "summary": "Delete a directory, optionally recursively and forcibly.",
  "category": "filesystem",
  "riskDefault": "HIGH",                 // floor: this command is never below HIGH
  "params": {
    "name":      { "type": "path",    "required": true, "description": "Directory to delete." },
    "recursive": { "type": "boolean", "default": false, "description": "Delete contents recursively." },
    "force":     { "type": "boolean", "default": false, "description": "Ignore nonexistent paths; never prompt." },
    "dryRun":    { "type": "boolean", "default": false, "description": "Plan the deletion without performing it." }
  },
  "safety": {
    "destructive": true,                 // engine treats this as data-destroying
    "targetParam": "name",               // `name` is the path to normalize and classify
    "blockTargets": ["/", "C:\\", "~"],  // always-blocked targets
    "requiresAffectedPathEstimate": true // run the blast-radius walk before HIGH+ execution
  },
  "adapters": {
    "posix": {
      "command": "rm",
      "args": [
        { "kind": "flag",  "flag": "-r", "when": "recursive" },  // -r only if recursive=true
        { "kind": "flag",  "flag": "-f", "when": "force" },      // -f only if force=true
        { "kind": "value", "param": "name" }                     // the target, as one positional
      ]
    },
    "powershell": {
      "command": "Remove-Item",
      "args": [
        { "kind": "option", "flag": "-Path",    "param": "name" },
        { "kind": "flag",   "flag": "-Recurse", "when": "recursive" },
        { "kind": "flag",   "flag": "-Force",   "when": "force" }
      ],
      "semanticNotes": "Remove-Item -Recurse has historically had quirks with reparse points/symlinks (it may traverse them); rm -rf does not follow symlinked dirs into their targets. Treat recursive removal as equally destructive but audit symlink handling per platform."
    }
  },
  "examples": [
    "remove.folder name=dist recursive=true",
    "remove.folder name=node_modules recursive=true force=true"
  ],
  "tests": [
    { "input": "remove.folder name=dist recursive=true force=true", "expectRisk": "HIGH" },
    { "input": "remove.folder name=/ recursive=true force=true",     "expectPolicy": "block" }
  ]
}
```

For `remove.folder name=dist recursive=true force=true`, the POSIX renderer produces `["-r", "-f", "dist"]` → `rm -r -f dist`. With `force=false`, the `-f` flag simply isn't emitted (no empty placeholder). The `tests` array is what the registry test suite runs: each `input` is classified and its `expectRisk` / `expectPolicy` asserted.

---

## Adding a custom command

Custom commands live in `~/.idel/registries/custom`. Drop a `*.json` file there containing one `CommandDef` object (or an array of them) and it resolves at the **custom** layer — shadowing any official or core def of the same id.

A minimal LOW-risk example:

```jsonc
// ~/.idel/registries/custom/disk-usage.json
{
  "id": "disk.usage",
  "version": "1.0.0",
  "summary": "Report disk usage for a path.",
  "category": "custom",
  "riskDefault": "LOW",
  "params": {
    "path": { "type": "path", "default": ".", "description": "Path to measure." }
  },
  "safety": { "targetParam": "path" },
  "adapters": {
    "posix": {
      "command": "du",
      "args": [
        { "kind": "literal", "value": "-sh" },
        { "kind": "value",   "param": "path" }
      ]
    },
    "powershell": {
      "command": "Get-ChildItem",
      "args": [
        { "kind": "option", "flag": "-Path", "param": "path" },
        { "kind": "literal", "value": "-Recurse" }
      ],
      "semanticNotes": "DIVERGES: there is no single du-equivalent; Get-ChildItem -Recurse must be piped to Measure-Object on Length for a real total. This is a best-effort listing, not a summed size."
    }
  },
  "examples": ["disk.usage path=node_modules"],
  "tests": [{ "input": "disk.usage path=.", "expectRisk": "LOW" }]
}
```

Guidance for authoring:

- **Build argv structurally** — `flag` / `option` / `value` / `literal` only. Never embed a value into a `literal`, and never rely on a shell to expand anything.
- **Declare safety honestly** — set `safety.destructive` and `safety.targetParam` if the command can destroy or overwrite data. The safety floors still apply on top of whatever you declare; you cannot define your way under a CRITICAL.
- **Be honest about divergence** — if POSIX and PowerShell differ, say so in `semanticNotes` and only emit faithful argv. Prefer a `@node` adapter when there is no faithful shell form.
- **Validation is fail-closed** — a malformed def is rejected at load time, so test with `idel explain.registry command=<id>` to confirm it resolves from the `custom` layer and reports the params/adapters you expect.

> The registry **API** (`Registry.loadLayer` / `Registry.addLayer`) and bundled CLI load custom and official layers, and resolution honors `custom > official > core`. Learned definitions are available after `idel learn --write`; signed official definitions are accepted only through the configured trust store.
