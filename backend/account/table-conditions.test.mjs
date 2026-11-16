// Condition-only transaction ops (issue #21, shared with #22 and #23):
// { check: { pk, sk }, ifExists?: true, ifVersion?: number, ifAttr?: { name, equals } }
// ifExists: the item exists and isn't expired. ifAttr: item[name] === equals.
// The memory and DynamoDB tables must agree; DynamoDB is checked against the
// TransactItems it would send, through a fake document client (no AWS calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTable, createDynamoTable, ConditionFailed } from "./table.mjs";

const T0 = Date.UTC(2026, 0, 1, 12);

async function seeded() {
  const table = createMemoryTable({ now: () => T0 });
  await table.put({ pk: "P#1", sk: "META", version: 3, status: "active" });
  await table.put({ pk: "A#1", sk: "ACCESS#1", kind: "owner" });
  await table.put({ pk: "X#1", sk: "OLD", version: 1, ttl: T0 / 1000 - 1 }); // expired
  return table;
}
const write = { put: { pk: "P#1", sk: "PROGRESS", n: 1 } };
const progress = (table) => table.get("P#1", "PROGRESS");

test("memory: a check op that holds lets the transaction write", async () => {
  const table = await seeded();
  await table.transact([
    { check: { pk: "P#1", sk: "META" }, ifVersion: 3 },
    { check: { pk: "A#1", sk: "ACCESS#1" }, ifAttr: { name: "kind", equals: "owner" } },
    { check: { pk: "P#1", sk: "META" }, ifExists: true },
    write,
  ]);
  assert.equal((await progress(table)).n, 1);
  assert.equal((await table.get("P#1", "META")).version, 3, "a check op writes nothing itself");
});

for (const [name, check] of [
  ["ifVersion mismatch", { check: { pk: "P#1", sk: "META" }, ifVersion: 2 }],
  ["ifVersion on a missing item", { check: { pk: "P#9", sk: "META" }, ifVersion: 1 }],
  ["ifExists on a missing item", { check: { pk: "P#9", sk: "META" }, ifExists: true }],
  ["ifExists on an expired item", { check: { pk: "X#1", sk: "OLD" }, ifExists: true }],
  ["ifAttr with another value", { check: { pk: "A#1", sk: "ACCESS#1" }, ifAttr: { name: "kind", equals: "guardian" } }],
  ["ifAttr on a missing item", { check: { pk: "A#9", sk: "ACCESS#1" }, ifAttr: { name: "kind", equals: "owner" } }],
]) {
  test(`memory: ${name} fails the whole transaction`, async () => {
    const table = await seeded();
    await assert.rejects(table.transact([check, write]), ConditionFailed);
    assert.equal(await progress(table), null, "nothing written");
  });
}

test("memory: a check op needs a condition", async () => {
  const table = await seeded();
  await assert.rejects(table.transact([{ check: { pk: "P#1", sk: "META" } }, write]), TypeError);
  assert.equal(await progress(table), null);
});

/** A DynamoDB table over a fake document client that records each command's input. */
function fakeDynamo(reply = async () => ({})) {
  const sent = [];
  const client = { send: async (cmd) => { sent.push({ name: cmd.constructor.name, input: cmd.input }); return reply(cmd); } };
  return { table: createDynamoTable({ tableName: "t", client, now: () => T0 }), sent };
}

test("dynamo: check ops become ConditionCheck TransactItems with matching conditions", async () => {
  const { table, sent } = fakeDynamo();
  await table.transact([
    { check: { pk: "P#1", sk: "META" }, ifVersion: 3 },
    { check: { pk: "A#1", sk: "ACCESS#1" }, ifAttr: { name: "kind", equals: "owner" } },
    { check: { pk: "P#1", sk: "META" }, ifExists: true },
    { ...write, ifVersion: 0 },
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, "TransactWriteCommand");
  const [ver, attr, exists, put] = sent[0].input.TransactItems;
  const now = T0 / 1000;
  const live = "(attribute_not_exists(#t) OR #t > :now)";
  assert.deepEqual(ver, { ConditionCheck: {
    TableName: "t", Key: { pk: "P#1", sk: "META" },
    ConditionExpression: `#v = :v AND ${live}`,
    ExpressionAttributeNames: { "#v": "version", "#t": "ttl" },
    ExpressionAttributeValues: { ":v": 3, ":now": now },
  } });
  assert.deepEqual(attr, { ConditionCheck: {
    TableName: "t", Key: { pk: "A#1", sk: "ACCESS#1" },
    ConditionExpression: `#a = :a AND ${live}`,
    ExpressionAttributeNames: { "#a": "kind", "#t": "ttl" },
    ExpressionAttributeValues: { ":a": "owner", ":now": now },
  } });
  assert.deepEqual(exists, { ConditionCheck: {
    TableName: "t", Key: { pk: "P#1", sk: "META" },
    ConditionExpression: `attribute_exists(pk) AND ${live}`,
    ExpressionAttributeNames: { "#t": "ttl" },
    ExpressionAttributeValues: { ":now": now },
  } });
  assert.deepEqual(put.Put.Item, write.put);
  assert.equal(put.Put.ConditionExpression, "attribute_not_exists(pk) OR #t <= :now");
});

test("dynamo: ifVersion alone keeps the existing condition string", async () => {
  const { table, sent } = fakeDynamo();
  await table.put({ pk: "P#1", sk: "PROGRESS", version: 2 }, { ifVersion: 1 });
  assert.equal(sent[0].input.ConditionExpression, "#v = :v AND (attribute_not_exists(#t) OR #t > :now)");
});

test("dynamo: a cancelled transaction from a failed check is a ConditionFailed", async () => {
  const cancelled = Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
  const { table } = fakeDynamo(async () => { throw cancelled; });
  await assert.rejects(table.transact([{ check: { pk: "P#1", sk: "META" }, ifVersion: 3 }, write]), ConditionFailed);
});

test("dynamo: a check op needs a condition", async () => {
  const { table, sent } = fakeDynamo();
  await assert.rejects(table.transact([{ check: { pk: "P#1", sk: "META" } }, write]), TypeError);
  assert.equal(sent.length, 0, "nothing sent");
});
