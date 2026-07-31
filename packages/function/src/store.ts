/**
 * Reference adapters for local development: an in-memory entity store and an
 * in-memory evidence sink with a SHA-256 hash chain.
 *
 * These are development stand-ins for dobase and OpenLogs. They implement the
 * same interfaces the real adapters must, so a function that runs here runs
 * unchanged against the governed engines; only durability and signing differ.
 */

import { createHash, randomUUID } from "node:crypto";

import type { DataStore, EntityRow, EvidenceRecord, EvidenceSink } from "./handles.js";

export interface MemoryStoreOptions {
  /** Seed rows per entity, e.g. { users: [{ id: "u1", email: "a@b.c" }] }. */
  seed?: Record<string, EntityRow[]>;
  /** Injected for deterministic tests. */
  now?: () => string;
  newId?: () => string;
}

export class MemoryStore implements DataStore {
  private readonly entities = new Map<string, EntityRow[]>();
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    for (const [entity, rows] of Object.entries(options.seed ?? {})) {
      this.entities.set(entity, rows.map((row) => ({ ...row })));
    }
  }

  read(entity: string): EntityRow[] {
    return (this.entities.get(entity) ?? []).map((row) => ({ ...row }));
  }

  insert(entity: string, values: Record<string, unknown>): EntityRow {
    const rows = this.entities.get(entity) ?? [];
    const row: EntityRow = { id: this.newId(), created_at: this.now(), ...values };
    rows.push(row);
    this.entities.set(entity, rows);
    return { ...row };
  }

  /** All rows, for assertions and for persisting a development snapshot. */
  snapshot(): Record<string, EntityRow[]> {
    return Object.fromEntries([...this.entities].map(([key, rows]) => [key, rows.map((r) => ({ ...r }))]));
  }
}

export interface ChainedEvidenceRecord extends EvidenceRecord {
  index: number;
  previous: string | null;
  hash: string;
}

/** Hash-chained evidence sink: tamper-evident without a signing key. */
export class MemoryEvidence implements EvidenceSink {
  private readonly records: ChainedEvidenceRecord[] = [];

  append(record: EvidenceRecord): void {
    const previous = this.records.at(-1)?.hash ?? null;
    const index = this.records.length;
    const hash = createHash("sha256")
      .update(JSON.stringify({ ...record, index, previous }), "utf8")
      .digest("hex");
    this.records.push({ ...record, index, previous, hash });
  }

  all(): ChainedEvidenceRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Recompute the chain; returns the first broken index, or null when intact. */
  verify(): number | null {
    let previous: string | null = null;
    for (const [index, record] of this.records.entries()) {
      const { hash, ...payload } = record;
      const expected: string = createHash("sha256")
        .update(JSON.stringify({ ...payload, index, previous }), "utf8")
        .digest("hex");
      if (expected !== hash || record.previous !== previous) return index;
      previous = hash;
    }
    return null;
  }
}
