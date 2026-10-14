/**
 * Snapshot store on built-in `node:sqlite`. DRAFT.
 *
 * A *series* is (connector, scope): e.g. ("yad2", "saved-search:family-car").
 * Each snapshot is the full set of entities seen at one point in time. Entity
 * bodies are content-addressed (hash -> JSON) so polling an unchanged search
 * every hour costs one row per entity, not one JSON blob per entity.
 *
 * Default location for real use: `.local/data/omni.sqlite` (never shared).
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DiffOptions, Entity, EntityDiff } from "./diff.ts";
import { diffEntities, stableStringify } from "./diff.ts";

export type SnapshotInfo = {
  id: number;
  connector: string;
  scope: string;
  entityType: string;
  takenAt: string;
  count: number;
  meta?: unknown;
};

export type SaveSnapshotInput = {
  connector: string;
  scope: string;
  entityType: string;
  entities: Entity[];
  /** ISO timestamp; defaults to now. */
  takenAt?: string;
  meta?: unknown;
};

export type SnapshotDiff = {
  from: SnapshotInfo | null;
  to: SnapshotInfo;
  diff: EntityDiff;
};

export type EntityHistoryPoint = {
  snapshotId: number;
  takenAt: string;
  /** null when the entity was absent from that snapshot (e.g. listing removed). */
  data: unknown | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector TEXT NOT NULL,
  scope TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS snapshots_series ON snapshots (connector, scope, id);
CREATE TABLE IF NOT EXISTS entity_bodies (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_entities (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES entity_bodies(hash),
  PRIMARY KEY (snapshot_id, entity_id)
);
CREATE INDEX IF NOT EXISTS snapshot_entities_entity ON snapshot_entities (entity_id);
`;

type SnapshotRow = {
  id: number;
  connector: string;
  scope: string;
  entity_type: string;
  taken_at: string;
  count: number;
  meta: string | null;
};

function toInfo(row: SnapshotRow): SnapshotInfo {
  const info: SnapshotInfo = {
    id: Number(row.id),
    connector: row.connector,
    scope: row.scope,
    entityType: row.entity_type,
    takenAt: row.taken_at,
    count: Number(row.count),
  };
  if (row.meta !== null) info.meta = JSON.parse(row.meta);
  return info;
}

export class SnapshotStore {
  #db: DatabaseSync;

  /** `path` is a file path or ":memory:". */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  save(input: SaveSnapshotInput): SnapshotInfo {
    const db = this.#db;
    const takenAt = input.takenAt ?? new Date().toISOString();
    const seen = new Set<string>();
    for (const e of input.entities) {
      if (seen.has(e.id)) throw new Error(`Duplicate entity id in snapshot: ${e.id}`);
      seen.add(e.id);
    }
    db.exec("BEGIN");
    try {
      const { lastInsertRowid } = db
        .prepare(
          "INSERT INTO snapshots (connector, scope, entity_type, taken_at, count, meta) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.connector,
          input.scope,
          input.entityType,
          takenAt,
          input.entities.length,
          input.meta === undefined ? null : JSON.stringify(input.meta),
        );
      const snapshotId = Number(lastInsertRowid);
      const putBody = db.prepare("INSERT OR IGNORE INTO entity_bodies (hash, data) VALUES (?, ?)");
      const putMember = db.prepare(
        "INSERT INTO snapshot_entities (snapshot_id, entity_id, hash) VALUES (?, ?, ?)",
      );
      for (const e of input.entities) {
        const json = stableStringify(e.data);
        const hash = createHash("sha256").update(json).digest("hex");
        putBody.run(hash, json);
        putMember.run(snapshotId, e.id, hash);
      }
      db.exec("COMMIT");
      return this.get(snapshotId)!;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  get(id: number): SnapshotInfo | undefined {
    const row = this.#db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as
      | SnapshotRow
      | undefined;
    return row ? toInfo(row) : undefined;
  }

  /** Newest first. */
  list(connector: string, scope: string, limit = 50): SnapshotInfo[] {
    const rows = this.#db
      .prepare("SELECT * FROM snapshots WHERE connector = ? AND scope = ? ORDER BY id DESC LIMIT ?")
      .all(connector, scope, limit) as SnapshotRow[];
    return rows.map(toInfo);
  }

  latest(connector: string, scope: string): SnapshotInfo | undefined {
    return this.list(connector, scope, 1)[0];
  }

  entities(snapshotId: number): Entity[] {
    const rows = this.#db
      .prepare(
        `SELECT se.entity_id AS id, b.data AS data
         FROM snapshot_entities se JOIN entity_bodies b ON b.hash = se.hash
         WHERE se.snapshot_id = ? ORDER BY se.entity_id`,
      )
      .all(snapshotId) as { id: string; data: string }[];
    return rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
  }

  /** Diff two snapshots. `fromId` null means "compare against nothing" (all added). */
  diff(fromId: number | null, toId: number, options?: DiffOptions): SnapshotDiff {
    const to = this.get(toId);
    if (!to) throw new Error(`Unknown snapshot ${toId}`);
    const from = fromId === null ? null : (this.get(fromId) ?? null);
    const prev = from ? this.entities(from.id) : [];
    return { from, to, diff: diffEntities(prev, this.entities(to.id), options) };
  }

  /** Diff the newest snapshot of a series against the one before it. */
  diffLatest(connector: string, scope: string, options?: DiffOptions): SnapshotDiff | undefined {
    const [to, from] = this.list(connector, scope, 2);
    if (!to) return undefined;
    return this.diff(from ? from.id : null, to.id, options);
  }

  /** One point per snapshot in the series, oldest first: price history, removals, relists. */
  history(connector: string, scope: string, entityId: string): EntityHistoryPoint[] {
    const rows = this.#db
      .prepare(
        `SELECT s.id AS snapshotId, s.taken_at AS takenAt, b.data AS data
         FROM snapshots s
         LEFT JOIN snapshot_entities se ON se.snapshot_id = s.id AND se.entity_id = ?
         LEFT JOIN entity_bodies b ON b.hash = se.hash
         WHERE s.connector = ? AND s.scope = ?
         ORDER BY s.id ASC`,
      )
      .all(entityId, connector, scope) as {
      snapshotId: number;
      takenAt: string;
      data: string | null;
    }[];
    return rows.map((r) => ({
      snapshotId: Number(r.snapshotId),
      takenAt: r.takenAt,
      data: r.data === null ? null : JSON.parse(r.data),
    }));
  }
}
