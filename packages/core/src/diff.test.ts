import assert from "node:assert/strict";
import { test } from "node:test";
import { diffEntities, diffValues, stableStringify } from "./diff.ts";

test("stableStringify ignores key order and undefined", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: undefined } }),
    stableStringify({ a: { d: 2 }, b: 1 }),
  );
});

test("diffValues reports nested paths", () => {
  assert.deepEqual(
    diffValues({ price: 100, loc: { city: "Haifa" } }, { price: 90, loc: { city: "Haifa" } }),
    [{ path: "price", before: 100, after: 90 }],
  );
  assert.deepEqual(diffValues({ loc: { city: "Haifa" } }, { loc: { city: "Tel Aviv" } }), [
    { path: "loc.city", before: "Haifa", after: "Tel Aviv" },
  ]);
  assert.deepEqual(diffValues({ photos: ["a"] }, { photos: ["a", "b"] }), [
    { path: "photos", before: ["a"], after: ["a", "b"] },
  ]);
});

test("diffEntities: added, removed, changed, unchanged", () => {
  const prev = [
    { id: "1", data: { price: 100, km: 50 } },
    { id: "2", data: { price: 200 } },
    { id: "3", data: { price: 300 } },
  ];
  const next = [
    { id: "1", data: { price: 95, km: 50 } },
    { id: "3", data: { price: 300 } },
    { id: "4", data: { price: 400 } },
  ];
  const d = diffEntities(prev, next);
  assert.deepEqual(
    d.added.map((e) => e.id),
    ["4"],
  );
  assert.deepEqual(
    d.removed.map((e) => e.id),
    ["2"],
  );
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0]!.changes, [{ path: "price", before: 100, after: 95 }]);
  assert.equal(d.unchanged, 1);
});

test("diffEntities: fields / ignore filters", () => {
  const prev = [{ id: "1", data: { price: 100, seenAt: "a" } }];
  const next = [{ id: "1", data: { price: 100, seenAt: "b" } }];
  assert.equal(diffEntities(prev, next).changed.length, 1);
  assert.equal(diffEntities(prev, next, { ignore: ["seenAt"] }).changed.length, 0);
  assert.equal(diffEntities(prev, next, { fields: ["price"] }).unchanged, 1);
});
