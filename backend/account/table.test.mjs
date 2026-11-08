import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTable, ConditionFailed } from "./table.mjs";

function setup() {
  const clock = { t: 1_700_000_000_000 };
  const table = createMemoryTable({ now: () => clock.t });
  return { clock, table };
}

test("put/get round trip", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "1", name: "x" });
  assert.deepEqual(await table.get("A", "1"), { pk: "A", sk: "1", name: "x" });
  assert.equal(await table.get("A", "missing"), null);
});

test("stored items are isolated from caller mutation", async () => {
  const { table } = setup();
  const item = { pk: "A", sk: "1", nested: { n: 1 } };
  await table.put(item);
  item.nested.n = 2;
  const got = await table.get("A", "1");
  assert.equal(got.nested.n, 1);
  got.nested.n = 3;
  assert.equal((await table.get("A", "1")).nested.n, 1);
});

test("get hides expired ttl items", async () => {
  const { table, clock } = setup();
  await table.put({ pk: "A", sk: "1", ttl: clock.t / 1000 + 10 });
  assert.notEqual(await table.get("A", "1"), null);
  clock.t += 11_000;
  assert.equal(await table.get("A", "1"), null);
});

test("put ifNotExists throws ConditionFailed on existing item", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "1" }, { ifNotExists: true });
  await assert.rejects(
    table.put({ pk: "A", sk: "1" }, { ifNotExists: true }),
    ConditionFailed
  );
});

test("put ifVersion succeeds on match and throws on mismatch", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "1", version: 1 });
  await table.put({ pk: "A", sk: "1", version: 2 }, { ifVersion: 1 });
  await assert.rejects(
    table.put({ pk: "A", sk: "1", version: 3 }, { ifVersion: 1 }),
    ConditionFailed
  );
  assert.equal((await table.get("A", "1")).version, 2);
});

test("ifVersion 0 requires absence", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "1", version: 1 }, { ifVersion: 0 });
  await assert.rejects(
    table.put({ pk: "A", sk: "1", version: 1 }, { ifVersion: 0 }),
    ConditionFailed
  );
});

test("query returns items by sk prefix in sk order", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "b#2" });
  await table.put({ pk: "A", sk: "a#1" });
  await table.put({ pk: "A", sk: "b#1" });
  await table.put({ pk: "B", sk: "b#9" });
  const rows = await table.query("A", "b#");
  assert.deepEqual(rows.map((r) => r.sk), ["b#1", "b#2"]);
  const all = await table.query("A");
  assert.deepEqual(all.map((r) => r.sk), ["a#1", "b#1", "b#2"]);
});

test("add increments atomically and sets ttl on create", async () => {
  const { table, clock } = setup();
  const ttl = clock.t / 1000 + 100;
  assert.equal(await table.add("C", "k", "count", 1, ttl), 1);
  assert.equal(await table.add("C", "k", "count", 2, ttl + 999), 3);
  const item = await table.get("C", "k");
  assert.equal(item.count, 3);
  assert.equal(item.ttl, ttl);
});

test("delete removes an item and scan filters by pk prefix", async () => {
  const { table } = setup();
  await table.put({ pk: "user#1", sk: "p" });
  await table.put({ pk: "user#2", sk: "p" });
  await table.put({ pk: "other", sk: "p" });
  assert.equal((await table.scan("user#")).length, 2);
  await table.delete("user#1", "p");
  assert.equal(await table.get("user#1", "p"), null);
  assert.equal((await table.scan("user#")).length, 1);
});

test("transact applies nothing when one condition fails", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "exists" });
  await assert.rejects(
    table.transact([
      { put: { pk: "A", sk: "new" } },
      { put: { pk: "A", sk: "exists" }, ifNotExists: true },
    ]),
    ConditionFailed
  );
  assert.equal(await table.get("A", "new"), null);
});

test("transact applies puts and deletes together", async () => {
  const { table } = setup();
  await table.put({ pk: "A", sk: "old" });
  await table.transact([
    { put: { pk: "A", sk: "new" }, ifNotExists: true },
    { delete: { pk: "A", sk: "old" } },
  ]);
  assert.notEqual(await table.get("A", "new"), null);
  assert.equal(await table.get("A", "old"), null);
});

test("ifNotExists and ifVersion 0 succeed over an expired item", async () => {
  const { table, clock } = setup();
  const expire = () => ({ pk: "A", sk: "1", ttl: clock.t / 1000 + 5, version: 1 });
  await table.put(expire());
  clock.t += 6_000;
  await table.put({ pk: "A", sk: "1", version: 1 }, { ifNotExists: true });
  await table.put(expire());
  clock.t += 6_000;
  await table.put({ pk: "A", sk: "1", version: 1 }, { ifVersion: 0 });
});

test("ifVersion fails over an expired item and over a missing item", async () => {
  const { table, clock } = setup();
  await assert.rejects(
    table.put({ pk: "A", sk: "none", version: 2 }, { ifVersion: 1 }),
    ConditionFailed
  );
  await table.put({ pk: "A", sk: "1", version: 1, ttl: clock.t / 1000 + 5 });
  clock.t += 6_000;
  await assert.rejects(
    table.put({ pk: "A", sk: "1", version: 2 }, { ifVersion: 1 }),
    ConditionFailed
  );
});

test("add after expiry restarts at n with the new ttl", async () => {
  const { table, clock } = setup();
  const ttl1 = clock.t / 1000 + 10;
  assert.equal(await table.add("C", "k", "count", 5, ttl1), 5);
  clock.t += 11_000;
  const ttl2 = clock.t / 1000 + 10;
  assert.equal(await table.add("C", "k", "count", 2, ttl2), 2);
  const item = await table.get("C", "k");
  assert.equal(item.count, 2);
  assert.equal(item.ttl, ttl2);
});

test("add requires a numeric ttl", async () => {
  const { table } = setup();
  await assert.rejects(table.add("C", "k", "count", 1), TypeError);
  assert.equal(await table.get("C", "k"), null);
});

test("query and scan skip expired items", async () => {
  const { table, clock } = setup();
  await table.put({ pk: "u#1", sk: "a", ttl: clock.t / 1000 + 5 });
  await table.put({ pk: "u#1", sk: "b" });
  clock.t += 6_000;
  assert.deepEqual((await table.query("u#1")).map((r) => r.sk), ["b"]);
  assert.deepEqual((await table.scan("u#")).map((r) => r.sk), ["b"]);
});
