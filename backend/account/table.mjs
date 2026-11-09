// Table abstraction: in-memory (tests / local dev) and DynamoDB (production).
// An item is { pk, sk, ttl?: epoch seconds, version?: number, ...attrs }.

export class ConditionFailed extends Error {
  constructor(message = "Condition failed") {
    super(message);
    this.name = "ConditionFailed";
  }
}

const keyOf = (pk, sk) => `${pk}\u0000${sk}`;

const requireTtl = (ttl) => {
  if (typeof ttl !== "number") throw new TypeError("add() requires a numeric ttl");
};

/** True when the item's ttl (epoch seconds) has passed at `nowMs`. */
const isExpired = (item, nowMs) =>
  typeof item.ttl === "number" && item.ttl * 1000 <= nowMs;

/** In-memory Table. Stores deep clones so callers can't mutate stored items. */
export function createMemoryTable({ now = () => Date.now() } = {}) {
  const store = new Map();

  const live = (pk, sk) => {
    const item = store.get(keyOf(pk, sk));
    return item && !isExpired(item, now()) ? item : null;
  };

  const check = (item, { ifNotExists, ifVersion } = {}) => {
    const existing = live(item.pk, item.sk);
    if (ifNotExists && existing) throw new ConditionFailed();
    if (ifVersion === 0 && existing) throw new ConditionFailed();
    if (ifVersion > 0 && (!existing || existing.version !== ifVersion)) {
      throw new ConditionFailed();
    }
  };

  const collect = (predicate) =>
    [...store.values()]
      .filter((item) => !isExpired(item, now()) && predicate(item))
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))
      .map((item) => structuredClone(item));

  return {
    async get(pk, sk) {
      const item = live(pk, sk);
      return item ? structuredClone(item) : null;
    },
    async put(item, conditions = {}) {
      check(item, conditions);
      store.set(keyOf(item.pk, item.sk), structuredClone(item));
    },
    async delete(pk, sk) {
      store.delete(keyOf(pk, sk));
    },
    async query(pk, skPrefix = "") {
      return collect((i) => i.pk === pk && i.sk.startsWith(skPrefix));
    },
    async add(pk, sk, field, n, ttl) {
      requireTtl(ttl);
      const existing = live(pk, sk);
      const item = existing ?? { pk, sk, ttl };
      item[field] = (item[field] ?? 0) + n;
      store.set(keyOf(pk, sk), item);
      return item[field];
    },
    async scan(pkPrefix) {
      return collect((i) => i.pk.startsWith(pkPrefix));
    },
    async transact(ops) {
      for (const op of ops) if (op.put) check(op.put, op);
      for (const op of ops) {
        if (op.put) store.set(keyOf(op.put.pk, op.put.sk), structuredClone(op.put));
        else store.delete(keyOf(op.delete.pk, op.delete.sk));
      }
    },
  };
}

/**
 * DynamoDB Table. Needs the item key attributes to be named `pk` and `sk`.
 * The AWS SDK is imported lazily so tests never need it.
 */
export function createDynamoTable({
  tableName,
  client,
  now = () => Date.now(),
} = {}) {
  let sdkPromise;
  const sdk = () => {
    sdkPromise ??= (async () => {
      const lib = await import("@aws-sdk/lib-dynamodb");
      let doc = client;
      if (!doc) {
        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), {
          marshallOptions: { removeUndefinedValues: true },
        });
      }
      return { lib, doc };
    })();
    return sdkPromise;
  };

  // Expired-but-unswept items (DynamoDB TTL lag) count as absent, matching
  // the memory table.
  const conditionOf = ({ ifNotExists, ifVersion } = {}) => {
    if (ifNotExists || ifVersion === 0) {
      return {
        ConditionExpression: "attribute_not_exists(pk) OR #t <= :now",
        ExpressionAttributeNames: { "#t": "ttl" },
        ExpressionAttributeValues: { ":now": now() / 1000 },
      };
    }
    if (ifVersion > 0) {
      return {
        ConditionExpression:
          "#v = :v AND (attribute_not_exists(#t) OR #t > :now)",
        ExpressionAttributeNames: { "#v": "version", "#t": "ttl" },
        ExpressionAttributeValues: { ":v": ifVersion, ":now": now() / 1000 },
      };
    }
    return {};
  };

  const isConditionError = (err) =>
    err?.name === "ConditionalCheckFailedException" ||
    (err?.name === "TransactionCanceledException" &&
      (err.CancellationReasons ?? []).some(
        (r) => r?.Code === "ConditionalCheckFailed"
      ));

  const fresh = (items) => {
    const nowSec = now() / 1000;
    return items.filter((i) => typeof i.ttl !== "number" || i.ttl > nowSec);
  };

  /** Runs a Query/Scan command to completion, following pagination. */
  const paginate = async (Command, input) => {
    const { lib, doc } = await sdk();
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await doc.send(
        new lib[Command]({ TableName: tableName, ...input, ExclusiveStartKey })
      );
      items.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };

  return {
    async get(pk, sk) {
      const { lib, doc } = await sdk();
      const res = await doc.send(
        new lib.GetCommand({
          TableName: tableName,
          Key: { pk, sk },
          ConsistentRead: true,
        })
      );
      return res.Item && fresh([res.Item]).length ? res.Item : null;
    },
    async put(item, conditions = {}) {
      const { lib, doc } = await sdk();
      try {
        await doc.send(
          new lib.PutCommand({
            TableName: tableName,
            Item: item,
            ...conditionOf(conditions),
          })
        );
      } catch (err) {
        if (isConditionError(err)) throw new ConditionFailed();
        throw err;
      }
    },
    async delete(pk, sk) {
      const { lib, doc } = await sdk();
      await doc.send(
        new lib.DeleteCommand({ TableName: tableName, Key: { pk, sk } })
      );
    },
    async query(pk, skPrefix = "") {
      const items = await paginate("QueryCommand", {
        ConsistentRead: true,
        KeyConditionExpression: skPrefix
          ? "pk = :pk AND begins_with(sk, :p)"
          : "pk = :pk",
        ExpressionAttributeValues: skPrefix
          ? { ":pk": pk, ":p": skPrefix }
          : { ":pk": pk },
      });
      return fresh(items);
    },
    async add(pk, sk, field, n, ttl) {
      requireTtl(ttl);
      const { lib, doc } = await sdk();
      const increment = async () => {
        const res = await doc.send(
          new lib.UpdateCommand({
            TableName: tableName,
            Key: { pk, sk },
            UpdateExpression: "ADD #f :n SET #t = if_not_exists(#t, :ttl)",
            ConditionExpression: "attribute_not_exists(#t) OR #t > :now",
            ExpressionAttributeNames: { "#f": field, "#t": "ttl" },
            ExpressionAttributeValues: { ":n": n, ":ttl": ttl, ":now": now() / 1000 },
            ReturnValues: "ALL_NEW",
          })
        );
        return res.Attributes[field];
      };
      // The stored item has expired but isn't swept yet: restart the counter.
      const reset = () =>
        doc.send(
          new lib.PutCommand({
            TableName: tableName,
            Item: { pk, sk, [field]: n, ttl },
            ConditionExpression: "#t <= :now",
            ExpressionAttributeNames: { "#t": "ttl" },
            ExpressionAttributeValues: { ":now": now() / 1000 },
          })
        );
      try {
        return await increment();
      } catch (err) {
        if (!isConditionError(err)) throw err;
      }
      try {
        await reset();
        return n;
      } catch (err) {
        if (!isConditionError(err)) throw err;
      }
      // Lost a race to another reset; the item is live now, so increment it.
      return increment();
    },
    async scan(pkPrefix) {
      const items = await paginate("ScanCommand", {
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": pkPrefix },
      });
      return fresh(items);
    },
    async transact(ops) {
      const { lib, doc } = await sdk();
      const TransactItems = ops.map((op) =>
        op.put
          ? { Put: { TableName: tableName, Item: op.put, ...conditionOf(op) } }
          : { Delete: { TableName: tableName, Key: op.delete } }
      );
      try {
        await doc.send(new lib.TransactWriteCommand({ TransactItems }));
      } catch (err) {
        if (isConditionError(err)) throw new ConditionFailed();
        throw err;
      }
    },
  };
}
