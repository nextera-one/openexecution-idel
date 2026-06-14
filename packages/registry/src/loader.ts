/**
 * @openexecution/registry — the layered command registry (spec §14, §16).
 *
 * The registry is *product content, not a side file*: the bundled
 * `registries/core/*.json` defs ARE the product surface. This module loads
 * them, validates each one (fail closed), and resolves a command name across
 * three layers with precedence:
 *
 *     custom  >  official  >  core
 *
 * A higher layer's definition wins; the lower ones it hides are recorded as
 * `shadowed` so `explain.registry` can show the full picture. (Note: safety
 * *floors* run the opposite direction — core-first — but that is the safety
 * package's job, not the registry's.)
 *
 * A core JSON file may hold EITHER a single def object OR an array of defs, so
 * authors can group by domain (`filesystem.json` = many) or split per command.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandDef,
  CommandSource,
  ResolvedCommand,
} from "@openexecution/types";
import { RegistryError } from "@openexecution/types";

import { checkCommandDef } from "./schema.js";

/** Layer precedence, lowest → highest. Index = priority. */
const LAYER_ORDER: readonly CommandSource[] = ["core", "official", "custom"] as const;

function priorityOf(source: CommandSource): number {
  return LAYER_ORDER.indexOf(source);
}

// ---------------------------------------------------------------------------
// Locating the bundled core registry
// ---------------------------------------------------------------------------

/**
 * Walk up from `start` looking for a `registries/core` directory and return it.
 *
 * Robust to wherever the compiled code lives: from
 * `packages/registry/dist/loader.js` the repo root is four levels up, but
 * rather than hard-code that we climb until we find the folder (or hit the FS
 * root). This also lets tests pass a `src`-relative start.
 */
export function findCoreDir(start?: string): string {
  const from =
    start ?? dirname(fileURLToPath(import.meta.url));
  let current = resolve(from);
  let found: string | undefined;

  // Climb until we hit the filesystem root, remembering the highest
  // `registries/core` candidate. In a source checkout, `packages/registry` may
  // also contain a generated prepack copy; prefer the repo-root registry so
  // development/tests do not read stale packed content. In a published package,
  // the bundled package-local registry is the only candidate and still wins.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(current, "registries", "core");
    if (existsSync(candidate)) found = candidate;
    const parent = dirname(current);
    if (parent === current) break; // reached FS root
    current = parent;
  }
  if (found) return found;
  throw new RegistryError(
    `could not locate a "registries/core" directory walking up from ${from}`,
  );
}

// ---------------------------------------------------------------------------
// Loading + parsing a directory of defs
// ---------------------------------------------------------------------------

/** A single parse/validation failure, kept for batch reporting. */
export interface LoadProblem {
  file: string;
  errors: string[];
}

export interface LoadLayerResult {
  defs: CommandDef[];
  problems: LoadProblem[];
}

/**
 * Read every `*.json` file in `dir`, parse it (a def object OR an array of
 * defs), validate each def, and tag it with `source`. Invalid defs are NOT
 * returned — they are reported in `problems` (fail closed).
 */
export async function loadLayerFromDir(
  dir: string,
  source: CommandSource,
): Promise<LoadLayerResult> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    throw new RegistryError(
      `cannot read registry layer "${source}" at ${dir}: ${(err as Error).message}`,
    );
  }

  const defs: CommandDef[] = [];
  const problems: LoadProblem[] = [];

  for (const file of entries) {
    const full = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(full, "utf8"));
    } catch (err) {
      problems.push({ file: full, errors: [`invalid JSON: ${(err as Error).message}`] });
      continue;
    }

    // Accept a single def or an array of defs.
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const [i, item] of items.entries()) {
      const where = Array.isArray(parsed) ? `${file}[${i}]` : file;
      const { ok, errors } = checkCommandDef(item);
      if (!ok) {
        problems.push({ file: where, errors });
        continue;
      }
      // `item` is now a valid CommandDef; tag the source layer.
      const def = { ...(item as CommandDef), source };
      defs.push(def);
    }
  }

  return { defs, problems };
}

// ---------------------------------------------------------------------------
// The Registry
// ---------------------------------------------------------------------------

/** Internal per-layer index: id → def. */
type LayerIndex = Map<string, CommandDef>;

export interface RegistryOptions {
  /**
   * When false (default), a layer with any validation problems throws on load
   * — fail closed. When true, problems are collected and exposed via
   * {@link Registry.problems} but loading continues with the valid defs.
   */
  tolerateProblems?: boolean;
}

export class Registry {
  /** id → def, one map per layer. */
  private readonly layers = new Map<CommandSource, LayerIndex>();
  /** Accumulated load problems (only populated when tolerated). */
  readonly problems: LoadProblem[] = [];

  constructor() {
    for (const source of LAYER_ORDER) {
      this.layers.set(source, new Map());
    }
  }

  // ----- construction helpers ------------------------------------------------

  /** Build a registry from the bundled core dir (located via {@link findCoreDir}). */
  static async loadCore(coreDir?: string, opts?: RegistryOptions): Promise<Registry> {
    const reg = new Registry();
    const dir = coreDir ?? findCoreDir();
    await reg.loadLayer(dir, "core", opts);
    return reg;
  }

  /** Spec-named alias for {@link Registry.loadCore}. */
  static async fromCoreDir(dir: string, opts?: RegistryOptions): Promise<Registry> {
    return Registry.loadCore(dir, opts);
  }

  /**
   * Load a directory of defs into the given layer. Throws on validation
   * problems unless `opts.tolerateProblems` is set (fail closed by default).
   */
  async loadLayer(
    dir: string,
    source: CommandSource,
    opts?: RegistryOptions,
  ): Promise<void> {
    const { defs, problems } = await loadLayerFromDir(dir, source);
    if (problems.length > 0 && !opts?.tolerateProblems) {
      const detail = problems
        .map((p) => `  ${p.file}:\n    - ${p.errors.join("\n    - ")}`)
        .join("\n");
      throw new RegistryError(
        `registry layer "${source}" failed schema validation (fail closed):\n${detail}`,
      );
    }
    this.problems.push(...problems);
    this.replaceLayer(source, defs);
  }

  /** Add already-validated defs to a layer (in-memory layers, tests, plugins). */
  addLayer(source: CommandSource, defs: CommandDef[]): void {
    const index = this.layers.get(source)!;
    for (const def of defs) {
      index.set(def.id, { ...def, source });
    }
  }

  /** Replace a layer with already-validated defs, used when reloading from disk. */
  replaceLayer(source: CommandSource, defs: CommandDef[]): void {
    const index = this.layers.get(source)!;
    index.clear();
    for (const def of defs) {
      index.set(def.id, { ...def, source });
    }
  }

  // ----- resolution ----------------------------------------------------------

  /**
   * Resolve a command id across layers (custom > official > core). Returns the
   * winning def plus the lower-layer defs it shadows, or `undefined` if no
   * layer defines it.
   */
  resolve(commandId: string): ResolvedCommand | undefined {
    // Collect every layer that defines this id, highest priority first.
    const hits: { source: CommandSource; def: CommandDef }[] = [];
    for (const source of LAYER_ORDER) {
      const def = this.layers.get(source)!.get(commandId);
      if (def) hits.push({ source, def });
    }
    if (hits.length === 0) return undefined;

    hits.sort((a, b) => priorityOf(b.source) - priorityOf(a.source));
    const [winner, ...rest] = hits as [
      { source: CommandSource; def: CommandDef },
      ...{ source: CommandSource; def: CommandDef }[],
    ];

    return {
      def: winner.def,
      source: winner.source,
      shadowed: rest.map((h) => ({ source: h.source, version: h.def.version })),
    };
  }

  /** True if any layer defines this id. */
  has(commandId: string): boolean {
    return LAYER_ORDER.some((s) => this.layers.get(s)!.has(commandId));
  }

  /**
   * The effective (winning) definition for every known id, sorted by id. This
   * is what `list.registry` surfaces to the user.
   */
  list(): CommandDef[] {
    const ids = new Set<string>();
    for (const source of LAYER_ORDER) {
      for (const id of this.layers.get(source)!.keys()) ids.add(id);
    }
    const out: CommandDef[] = [];
    for (const id of [...ids].sort()) {
      const resolved = this.resolve(id);
      if (resolved) out.push(resolved.def);
    }
    return out;
  }

  /**
   * Full per-layer view of a command for `explain.registry`: the resolved
   * winner plus every layer that defines it (highest priority first).
   */
  explain(commandId: string): {
    resolved: ResolvedCommand | undefined;
    allLayers: { source: CommandSource; def: CommandDef }[];
  } {
    const allLayers: { source: CommandSource; def: CommandDef }[] = [];
    for (const source of LAYER_ORDER) {
      const def = this.layers.get(source)!.get(commandId);
      if (def) allLayers.push({ source, def });
    }
    allLayers.sort((a, b) => priorityOf(b.source) - priorityOf(a.source));
    return { resolved: this.resolve(commandId), allLayers };
  }

  /** Number of distinct command ids known across all layers. */
  get size(): number {
    const ids = new Set<string>();
    for (const source of LAYER_ORDER) {
      for (const id of this.layers.get(source)!.keys()) ids.add(id);
    }
    return ids.size;
  }
}
