/**
 * Generic entity diff. DRAFT.
 *
 * Compares two lists of entities keyed by a stable id and reports
 * added / removed / changed, with field-level changes. Works on plain JSON data,
 * so it is connector-agnostic: Yad2 listings, bank transactions, AC state…
 */

export type Entity = { id: string; data: unknown };

export type FieldChange = {
  /** Dotted path, e.g. "price" or "location.city" or "photos.2". */
  path: string;
  before: unknown;
  after: unknown;
};

export type ChangedEntity = {
  id: string;
  before: unknown;
  after: unknown;
  changes: FieldChange[];
};

export type EntityDiff = {
  added: Entity[];
  removed: Entity[];
  changed: ChangedEntity[];
  unchanged: number;
};

export type DiffOptions = {
  /** Only report changes under these top-level fields (e.g. ["price"]). */
  fields?: string[];
  /** Ignore changes under these top-level fields (e.g. ["seenAt", "bumpedAt"]). */
  ignore?: string[];
};

/** Deterministic JSON: object keys sorted. Used for hashing and equality. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Field-level deep diff of two JSON values. */
export function diffValues(before: unknown, after: unknown, path = ""): FieldChange[] {
  if (stableStringify(before) === stableStringify(after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes: FieldChange[] = [];
    for (const key of [...keys].sort()) {
      changes.push(...diffValues(before[key], after[key], path ? `${path}.${key}` : key));
    }
    return changes;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    const changes: FieldChange[] = [];
    for (let i = 0; i < before.length; i++) {
      changes.push(...diffValues(before[i], after[i], path ? `${path}.${i}` : String(i)));
    }
    return changes;
  }
  return [{ path, before, after }];
}

function topLevel(path: string): string {
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

export function diffEntities(
  previous: Entity[],
  current: Entity[],
  options: DiffOptions = {},
): EntityDiff {
  const prev = new Map(previous.map((e) => [e.id, e]));
  const curr = new Map(current.map((e) => [e.id, e]));
  const result: EntityDiff = { added: [], removed: [], changed: [], unchanged: 0 };

  for (const [id, entity] of curr) {
    const old = prev.get(id);
    if (!old) {
      result.added.push(entity);
      continue;
    }
    let changes = diffValues(old.data, entity.data);
    if (options.fields) changes = changes.filter((c) => options.fields!.includes(topLevel(c.path)));
    if (options.ignore)
      changes = changes.filter((c) => !options.ignore!.includes(topLevel(c.path)));
    if (changes.length) result.changed.push({ id, before: old.data, after: entity.data, changes });
    else result.unchanged++;
  }
  for (const [id, entity] of prev) {
    if (!curr.has(id)) result.removed.push(entity);
  }
  return result;
}
