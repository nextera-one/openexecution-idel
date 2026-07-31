/**
 * Capability-scoped resource handles.
 *
 * This is where "effects are enforced by construction" stops being prose. The
 * executor never receives a store or an evidence sink directly: it receives a
 * handle map built *only* from the function's declared `allow.effect.*`
 * blocks. A function with no write effect has no write handle to call, so an
 * undeclared write is not a policy violation to detect — it is unrepresentable.
 *
 * The adapters behind the handles re-check the grant on every operation, so a
 * handle that leaks past its intended step still cannot exceed its grant.
 */

import { RefusalError, type IdelValue } from "./values.js";
import type { EffectGrant, FunctionDefinition } from "./model.js";

export interface EntityRow extends Record<string, unknown> {
  id: string;
}

/** The data adapter a handle set is built over. */
export interface DataStore {
  read(entity: string): EntityRow[];
  insert(entity: string, values: Record<string, unknown>): EntityRow;
}

export interface EvidenceRecord {
  event: string;
  subject: IdelValue;
  actor: string;
  resource: string;
  timestamp: string;
}

/** The evidence sink a handle set is built over. */
export interface EvidenceSink {
  append(record: EvidenceRecord): void | Promise<void>;
}

export interface ReadHandle {
  read(entity: string): EntityRow[];
}
export interface WriteHandle {
  insert(entity: string, values: Record<string, unknown>): EntityRow;
}
export interface AppendHandle {
  append(record: Omit<EvidenceRecord, "resource">): void | Promise<void>;
}

export interface HandleSet {
  /** Entity name -> read handle. Absent entity means "not granted". */
  read: Map<string, ReadHandle>;
  write: Map<string, WriteHandle>;
  /** At most one evidence destination in Phase 1. */
  append?: AppendHandle;
  /** Function identity (without @version) -> granted invoke. */
  invoke: Set<string>;
}

export interface HandleDependencies {
  store: DataStore;
  evidence: EvidenceSink;
}

/**
 * Build the handle set a function body is allowed to see. Only declared
 * effects produce handles; nothing else is reachable from the executor.
 */
export function buildHandles(
  definition: FunctionDefinition,
  dependencies: HandleDependencies,
): HandleSet {
  const handles: HandleSet = { read: new Map(), write: new Map(), invoke: new Set() };

  for (const effect of definition.effects) {
    switch (effect.kind) {
      case "read": {
        const entity = requireEntity(effect);
        handles.read.set(entity, {
          read: (requested) => {
            if (requested !== entity) throw new RefusalError("effect_not_declared", `read ${requested}`);
            return dependencies.store.read(entity);
          },
        });
        break;
      }
      case "write": {
        const entity = requireEntity(effect);
        handles.write.set(entity, {
          insert: (requested, values) => {
            if (requested !== entity) throw new RefusalError("effect_not_declared", `write ${requested}`);
            return dependencies.store.insert(entity, values);
          },
        });
        break;
      }
      case "append": {
        const resource = effect.resource;
        handles.append = {
          append: (record) => dependencies.evidence.append({ ...record, resource }),
        };
        break;
      }
      case "invoke": {
        handles.invoke.add(effect.resource.split("@")[0] as string);
        break;
      }
    }
  }
  return handles;
}

function requireEntity(effect: EffectGrant): string {
  if (!effect.entity) {
    throw new RefusalError("malformed_effect", `${effect.kind} "${effect.label}" names no entity`);
  }
  return effect.entity;
}
