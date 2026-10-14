import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotStore } from "./snapshot-store.ts";

function store() {
  return new SnapshotStore(":memory:");
}

test("save, list, latest and entities round-trip", () => {
  const s = store();
  const a = s.save({
    connector: "yad2",
    scope: "search:x",
    entityType: "listing",
    entities: [
      { id: "1", data: { price: 100 } },
      { id: "2", data: { price: 200 } },
    ],
    takenAt: "2026-09-19T10:00:00.000Z",
    meta: { pages: 1 },
  });
  assert.equal(a.count, 2);
  assert.deepEqual(a.meta, { pages: 1 });
  assert.equal(s.latest("yad2", "search:x")?.id, a.id);
  assert.deepEqual(s.entities(a.id), [
    { id: "1", data: { price: 100 } },
    { id: "2", data: { price: 200 } },
  ]);
  assert.equal(s.latest("yad2", "search:other"), undefined);
  s.close();
});

test("diffLatest: first snapshot is all added, then new/removed/price-changed", () => {
  const s = store();
  const series = { connector: "yad2", scope: "search:family", entityType: "listing" };
  s.save({
    ...series,
    entities: [
      { id: "a", data: { price: 50_000 } },
      { id: "b", data: { price: 60_000 } },
    ],
  });
  const first = s.diffLatest("yad2", "search:family")!;
  assert.equal(first.from, null);
  assert.equal(first.diff.added.length, 2);

  s.save({
    ...series,
    entities: [
      { id: "a", data: { price: 48_000 } },
      { id: "c", data: { price: 70_000 } },
    ],
  });
  const { diff } = s.diffLatest("yad2", "search:family")!;
  assert.deepEqual(
    diff.added.map((e) => e.id),
    ["c"],
  );
  assert.deepEqual(
    diff.removed.map((e) => e.id),
    ["b"],
  );
  assert.deepEqual(
    diff.changed.map((c) => [c.id, c.changes]),
    [["a", [{ path: "price", before: 50_000, after: 48_000 }]]],
  );
  s.close();
});

test("history shows an entity across snapshots, including absence", () => {
  const s = store();
  const series = { connector: "yad2", scope: "s", entityType: "listing" };
  s.save({ ...series, entities: [{ id: "a", data: { price: 1 } }] });
  s.save({ ...series, entities: [] });
  s.save({ ...series, entities: [{ id: "a", data: { price: 2 } }] });
  assert.deepEqual(
    s.history("yad2", "s", "a").map((p) => p.data),
    [{ price: 1 }, null, { price: 2 }],
  );
  s.close();
});

test("identical bodies are stored once; duplicate ids are rejected", () => {
  const s = store();
  const series = { connector: "c", scope: "s", entityType: "t" };
  s.save({ ...series, entities: [{ id: "a", data: { x: 1 } }] });
  s.save({ ...series, entities: [{ id: "a", data: { x: 1 } }] });
  assert.equal(s.diffLatest("c", "s")!.diff.unchanged, 1);
  assert.throws(
    () =>
      s.save({
        ...series,
        entities: [
          { id: "a", data: 1 },
          { id: "a", data: 2 },
        ],
      }),
    /Duplicate/,
  );
  assert.equal(s.list("c", "s").length, 2, "failed save is rolled back");
  s.close();
});
