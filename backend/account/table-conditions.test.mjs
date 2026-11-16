import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTable, createDynamoTable, ConditionFailed } from "./table.mjs";

// Condition-only ops and conditional deletes (#21, #22, #23 share this shape).

const T0 = Date.UTC(2026, 0, 1);

async function seeded() {
  const clock = { t: T0 };
  const table = createMemoryTable({ now: () => clock.t });
  await table.put({ pk: "A", sk: "META", version: 3, state: "idle" });
  await table.put({ pk: "B", sk: "X", n: 1 });
  await table.put({ pk: "OLD", sk: "X", version: 1, state: "idle", ttl: T0 / 1000 + 60 });
  return { table, clock };
}

test("check ifVersion: passes on match, and a mismatch applies nothing", async () => {
  const { table } = await seeded();
  await table.transact([{ check: { pk: "A", sk: "META" }, ifVersion: 3 }, { delete: { pk: "B", sk: "X" } }]);
  assert.equal(await table.get("B", "X"), null);
  await table.put({ pk: "B", sk: "X", n: 1 });
  await assert.rejects(
    table.transact([{ check: { pk: "A", sk: "META" }, ifVersion: 2 }, { delete: { pk: "B", sk: "X" } }]),
    ConditionFailed
  );
  assert.ok(await table.get("B", "X"), "nothing applied");
  assert.equal((await table.get("A", "META")).version, 3, "a check never writes");
});

test("check ifExists: fails for a missing item and for an expired one", async () => {
  const { table, clock } = await seeded();
  await table.transact([{ check: { pk: "OLD", sk: "X" }, ifExists: true }]);
  await assert.rejects(table.transact([{ check: { pk: "NOPE", sk: "X" }, ifExists: true }]), ConditionFailed);
  clock.t += 61e3;
  await assert.rejects(table.transact([{ check: { pk: "OLD", sk: "X" }, ifExists: true }]), ConditionFailed);
});

test("check ifAttr: item[name] must equal the value; missing and expired items fail", async () => {
  const { table, clock } = await seeded();
  await table.transact([{ check: { pk: "A", sk: "META" }, ifAttr: { name: "state", equals: "idle" } }]);
  await assert.rejects(
    table.transact([{ check: { pk: "A", sk: "META" }, ifAttr: { name: "state", equals: "active" } }]),
    ConditionFailed
  );
  await assert.rejects(
    table.transact([{ check: { pk: "NOPE", sk: "X" }, ifAttr: { name: "state", equals: "idle" } }]),
    ConditionFailed
  );
  clock.t += 61e3;
  await assert.rejects(
    table.transact([{ check: { pk: "OLD", sk: "X" }, ifAttr: { name: "state", equals: "idle" } }]),
    ConditionFailed
  );
});

test("transact delete honours ifVersion, ifExists and ifAttr", async () => {
  const { table } = await seeded();
  await assert.rejects(table.transact([{ delete: { pk: "A", sk: "META" }, ifVersion: 2 }]), ConditionFailed);
  await assert.rejects(table.transact([{ delete: { pk: "NOPE", sk: "X" }, ifExists: true }]), ConditionFailed);
  await assert.rejects(
    table.transact([{ delete: { pk: "A", sk: "META" }, ifAttr: { name: "state", equals: "x" } }]),
    ConditionFailed
  );
  assert.ok(await table.get("A", "META"));
  await table.transact([{ delete: { pk: "A", sk: "META" }, ifVersion: 3 }]);
  assert.equal(await table.get("A", "META"), null);
});

test("delete(pk, sk, conditions) honours the same conditions", async () => {
  const { table } = await seeded();
  await assert.rejects(table.delete("A", "META", { ifVersion: 9 }), ConditionFailed);
  await assert.rejects(table.delete("NOPE", "X", { ifExists: true }), ConditionFailed);
  await assert.rejects(table.delete("A", "META", { ifAttr: { name: "state", equals: "x" } }), ConditionFailed);
  assert.ok(await table.get("A", "META"));
  await table.delete("A", "META", { ifAttr: { name: "state", equals: "idle" } });
  assert.equal(await table.get("A", "META"), null);
  await table.delete("NOPE", "X"); // unconditional delete of a missing item is fine
});

// ---- DynamoDB parity: the commands sent ----

function fakeDynamo() {
  const sent = [];
  const client = { send: async (cmd) => (sent.push(cmd), {}) };
  const table = createDynamoTable({ tableName: "t", client, now: () => T0 });
  return { table, sent };
}

test("dynamo: a check op becomes a ConditionCheck with the ttl-aware condition", async () => {
  const { table, sent } = fakeDynamo();
  await table.transact([
    { check: { pk: "A", sk: "META" }, ifVersion: 3 },
    { delete: { pk: "B", sk: "X" } },
  ]);
  const [check, del] = sent[0].input.TransactItems;
  assert.deepEqual(check.ConditionCheck.Key, { pk: "A", sk: "META" });
  assert.equal(check.ConditionCheck.TableName, "t");
  assert.equal(check.ConditionCheck.ConditionExpression, "#v = :v AND (attribute_not_exists(#t) OR #t > :now)");
  assert.deepEqual(check.ConditionCheck.ExpressionAttributeValues, { ":v": 3, ":now": T0 / 1000 });
  assert.deepEqual(del, { Delete: { TableName: "t", Key: { pk: "B", sk: "X" } } });
});

test("dynamo: ifExists and ifAttr conditions treat expired items as absent", async () => {
  const { table, sent } = fakeDynamo();
  await table.transact([
    { check: { pk: "A", sk: "META" }, ifExists: true },
    { delete: { pk: "B", sk: "X" }, ifAttr: { name: "state", equals: "idle" } },
  ]);
  const [check, del] = sent[0].input.TransactItems;
  assert.equal(
    check.ConditionCheck.ConditionExpression,
    "attribute_exists(pk) AND (attribute_not_exists(#t) OR #t > :now)"
  );
  assert.equal(del.Delete.ConditionExpression, "#a = :a AND (attribute_not_exists(#t) OR #t > :now)");
  assert.deepEqual(del.Delete.ExpressionAttributeNames, { "#a": "state", "#t": "ttl" });
  assert.deepEqual(del.Delete.ExpressionAttributeValues, { ":a": "idle", ":now": T0 / 1000 });
});

test("dynamo: a check op with no condition is refused", async () => {
  const { table } = fakeDynamo();
  await assert.rejects(table.transact([{ check: { pk: "A", sk: "META" } }]), TypeError);
});

test("dynamo: conditional delete sends the condition and maps its failure to ConditionFailed", async () => {
  const sent = [];
  const client = {
    send: async (cmd) => {
      sent.push(cmd);
      throw Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" });
    },
  };
  const table = createDynamoTable({ tableName: "t", client, now: () => T0 });
  await assert.rejects(table.delete("A", "META", { ifVersion: 3 }), ConditionFailed);
  assert.deepEqual(sent[0].input.Key, { pk: "A", sk: "META" });
  assert.equal(sent[0].input.ConditionExpression, "#v = :v AND (attribute_not_exists(#t) OR #t > :now)");
});

test("memory: a check op with no condition is refused, like DynamoDB, and nothing is applied", async () => {
  const { table } = await seeded();
  await assert.rejects(
    table.transact([{ delete: { pk: "B", sk: "X" } }, { check: { pk: "A", sk: "META" } }]),
    TypeError
  );
  assert.ok(await table.get("B", "X"), "nothing applied");
});
