import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTable } from "./table.mjs";
import { createRepo } from "./repo.mjs";

const setup = (start = Date.UTC(2026, 0, 1, 12)) => {
  const clock = { t: start };
  const now = () => clock.t;
  const table = createMemoryTable({ now });
  const repo = createRepo(table, { now });
  return { clock, table, repo };
};

const profileFields = {
  firstName: "Ann",
  lastName: "Lee",
  level: 3,
  colour: "blue",
  under13: true,
  consentStatus: "active",
  consentBy: "a@x.com",
  consentAt: 1,
};

test("createAccount is idempotent per email", async () => {
  const { repo } = setup();
  const [a, b] = await Promise.all([
    repo.createAccount("a@x.com"),
    repo.createAccount("a@x.com"),
  ]);
  assert.equal(a.id, b.id);
  assert.equal((await repo.findAccountByEmail("a@x.com")).id, a.id);
  assert.equal((await repo.listAccounts()).length, 1);
  assert.equal((await repo.getAccount(a.id)).email, "a@x.com");
});

test("createProfile writes owner access both ways", async () => {
  const { repo } = setup();
  const acc = await repo.createAccount("a@x.com");
  const p = await repo.createProfile(acc.id, profileFields);
  assert.ok(p.id);
  assert.equal(p.ownerAccountId, acc.id);
  assert.equal((await repo.getProfile(p.id)).firstName, "Ann");
  assert.equal(await repo.getAccess(acc.id, p.id), "owner");
  assert.deepEqual(
    (await repo.listAccessForAccount(acc.id)).map((x) => [x.profileId, x.kind]),
    [[p.id, "owner"]]
  );
  assert.deepEqual(
    (await repo.listAccessForProfile(p.id)).map((x) => [x.accountId, x.kind]),
    [[acc.id, "owner"]]
  );
});

test("grantAccess and revokeAccess work both ways", async () => {
  const { repo } = setup();
  const o = await repo.createAccount("o@x.com");
  const g = await repo.createAccount("g@x.com");
  const p = await repo.createProfile(o.id, profileFields);
  await repo.grantAccess(g.id, p.id, "guardian", { consentGiver: true });
  const list = await repo.listAccessForProfile(p.id);
  assert.equal(list.find((x) => x.accountId === g.id).consentGiver, true);
  await repo.revokeAccess(g.id, p.id);
  assert.equal(await repo.getAccess(g.id, p.id), null);
  assert.equal((await repo.listAccessForProfile(p.id)).length, 1);
});

test("deleteProfile removes progress and all access items", async () => {
  const { repo, table } = setup();
  const o = await repo.createAccount("o@x.com");
  const g = await repo.createAccount("g@x.com");
  const p = await repo.createProfile(o.id, profileFields);
  await repo.grantAccess(g.id, p.id, "guardian");
  await repo.updateProgress(p.id, (x) => x);
  await repo.deleteProfile(p.id);
  assert.equal(await repo.getProfile(p.id), null);
  assert.deepEqual(await repo.listAccessForAccount(o.id), []);
  assert.deepEqual(await repo.listAccessForAccount(g.id), []);
  assert.deepEqual(await table.query(`PROFILE#${p.id}`, ""), []);
  assert.equal((await repo.getProgress(p.id)).version, 0);
});

test("updateProgress retries on version conflict and keeps both changes", async () => {
  const { repo } = setup();
  const [a, b] = await Promise.all([
    repo.updateProgress("p1", (pr) => ({ ...pr, ea: 1 })),
    repo.updateProgress("p1", (pr) => ({ ...pr, eb: 2 })),
  ]);
  const { progress, version } = await repo.getProgress("p1");
  assert.equal(progress.ea, 1);
  assert.equal(progress.eb, 2);
  assert.equal(version, 2);
  assert.ok(a && b);
});

test("updateProgress throws after 5 conflicts", async () => {
  const { table } = setup();
  const clash = {
    ...table,
    put: async (item, cond) => {
      if (item.sk === "PROGRESS") {
        const cur = await table.get(item.pk, item.sk);
        await table.put({ ...item, version: (cur?.version ?? 0) + 1 });
      }
      return table.put(item, cond);
    },
  };
  const repo = createRepo(clash, { now: () => 0 });
  let calls = 0;
  await assert.rejects(
    repo.updateProgress("p1", (pr) => (calls++, pr)),
    /conflict/i
  );
  assert.equal(calls, 5);
});

test("consumeToken works once and not after 15 minutes", async () => {
  const { repo, clock } = setup();
  const t = await repo.issueToken("signin", "a@x.com", 900);
  assert.equal(await repo.consumeToken(t, "other"), null);
  assert.deepEqual(await repo.consumeToken(t, "signin"), { email: "a@x.com" });
  assert.equal(await repo.consumeToken(t, "signin"), null);
  const t2 = await repo.issueToken("signin", "a@x.com", 900);
  clock.t += 900 * 1000;
  assert.equal(await repo.consumeToken(t2, "signin"), null);
});

test("concurrent consumeToken succeeds exactly once", async () => {
  const { repo } = setup();
  const t = await repo.issueToken("signin", "a@x.com", 900);
  const results = await Promise.all([
    repo.consumeToken(t, "signin"),
    repo.consumeToken(t, "signin"),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("issueCode replaces previous code for same purpose+subject", async () => {
  const { repo } = setup();
  const c1 = await repo.issueCode("signin", "a@x.com", 600);
  const c2 = await repo.issueCode("signin", "a@x.com", 600);
  if (c1 !== c2) assert.equal(await repo.checkCode("signin", "a@x.com", c1), "invalid");
  assert.equal(await repo.checkCode("signin", "a@x.com", c2), "ok");
  assert.equal(await repo.checkCode("signin", "a@x.com", c2), "invalid");
});

test("checkCode locks after 5 wrong attempts", async () => {
  const { repo } = setup();
  const code = await repo.issueCode("signin", "a@x.com", 600);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) {
    assert.equal(await repo.checkCode("signin", "a@x.com", wrong), "invalid");
  }
  assert.equal(await repo.checkCode("signin", "a@x.com", wrong), "locked");
  assert.equal(await repo.checkCode("signin", "a@x.com", code), "invalid");
});

test("sessions: create, expire, renew, parent unlock, delete", async () => {
  const { repo, clock } = setup();
  const acc = await repo.createAccount("a@x.com");
  const s = await repo.createSession(acc.id);
  assert.equal(s.expiresAt, clock.t + 90 * 86400e3);
  assert.equal((await repo.getSession(s.id)).accountId, acc.id);
  await repo.setParentUnlocked(s.id, clock.t + 5000);
  assert.equal((await repo.getSession(s.id)).parentUnlockedUntil, clock.t + 5000);
  clock.t += 60 * 86400e3;
  await repo.renewSession(s.id);
  clock.t += 60 * 86400e3;
  assert.ok(await repo.getSession(s.id));
  clock.t += 31 * 86400e3;
  assert.equal(await repo.getSession(s.id), null);
  const s2 = await repo.createSession(acc.id);
  await repo.deleteSession(s2.id);
  assert.equal(await repo.getSession(s2.id), null);
});

test("invites: create, list by email, delete", async () => {
  const { repo, clock } = setup();
  const inv = await repo.createInvite({
    kind: "share",
    fromAccountId: "acc1",
    toEmail: "b@x.com",
    profileIds: ["p1"],
  });
  assert.deepEqual((await repo.getInvite(inv.id)).profileIds, ["p1"]);
  assert.equal((await repo.listInvitesForEmail("b@x.com")).length, 1);
  await repo.deleteInvite(inv.id);
  assert.equal(await repo.getInvite(inv.id), null);
  assert.deepEqual(await repo.listInvitesForEmail("b@x.com"), []);
  const inv2 = await repo.createInvite({ kind: "share", fromAccountId: "a", toEmail: "b@x.com", profileIds: [] });
  clock.t += 31 * 86400e3;
  assert.equal(await repo.getInvite(inv2.id), null);
  assert.deepEqual(await repo.listInvitesForEmail("b@x.com"), []);
});

test("listInvitesFromAccount uses a keyed lookup, not a table scan", async () => {
  const { repo, table, clock } = setup();
  const mine = await repo.createInvite({ kind: "share", fromAccountId: "acc1", toEmail: "b@x.com", profileIds: ["p1"] });
  await repo.createInvite({ kind: "request", fromAccountId: "acc2", toEmail: "c@x.com", profileIds: [] });
  table.scan = async () => { throw new Error("scan on a request path"); };
  assert.deepEqual((await repo.listInvitesFromAccount("acc1")).map((i) => i.id), [mine.id]);
  assert.deepEqual((await repo.listInvitesFromAccount("acc1"))[0].profileIds, ["p1"]);
  await repo.deleteInvite(mine.id);
  assert.deepEqual(await repo.listInvitesFromAccount("acc1"), []);
  assert.deepEqual(await table.query("ACCOUNT#acc1", "INVITE#"), []);
  await repo.createInvite({ kind: "share", fromAccountId: "acc1", toEmail: "d@x.com", profileIds: [] });
  clock.t += 31 * 86400e3;
  assert.deepEqual(await repo.listInvitesFromAccount("acc1"), []);
});

test("hitRate allows limit then blocks within window, resets next window", async () => {
  const { repo, clock } = setup(Date.UTC(2026, 0, 1, 12, 0, 0));
  assert.equal(await repo.hitRate("k", 60, 2), true);
  assert.equal(await repo.hitRate("k", 60, 2), true);
  assert.equal(await repo.hitRate("k", 60, 2), false);
  clock.t += 60 * 1000;
  assert.equal(await repo.hitRate("k", 60, 2), true);
});

test("touchActive writes at most once per day", async () => {
  const { repo, clock } = setup(Date.UTC(2026, 0, 1, 10));
  const acc = await repo.createAccount("a@x.com");
  await repo.updateAccount(acc.id, { warningSentAt: 5 });
  const first = acc.lastActiveAt;
  clock.t += 3600e3;
  await repo.touchActive(acc.id);
  let a = await repo.getAccount(acc.id);
  assert.equal(a.lastActiveAt, first);
  assert.equal(a.warningSentAt, 5);
  clock.t = Date.UTC(2026, 0, 2, 1);
  await repo.touchActive(acc.id);
  a = await repo.getAccount(acc.id);
  assert.equal(a.lastActiveAt, clock.t);
  assert.equal(a.warningSentAt, undefined);
});

test("checkCode: parallel guesses cannot exceed 5 attempts", async () => {
  const { repo } = setup();
  const code = await repo.issueCode("signin", "a@x.com", 600);
  const wrong = code === "000000" ? "111111" : "000000";
  const results = await Promise.all([
    ...Array.from({ length: 10 }, () => repo.checkCode("signin", "a@x.com", wrong)),
    repo.checkCode("signin", "a@x.com", code),
  ]);
  assert.equal(results.filter((r) => r === "invalid").length, 4);
  assert.equal(results.filter((r) => r === "ok").length, 0);
  assert.equal(results.at(-1), "locked");
});

test("checkCode: two concurrent correct submissions give one ok", async () => {
  const { repo } = setup();
  const code = await repo.issueCode("signin", "a@x.com", 600);
  const results = await Promise.all([
    repo.checkCode("signin", "a@x.com", code),
    repo.checkCode("signin", "a@x.com", code),
  ]);
  assert.equal(results.filter((r) => r === "ok").length, 1);
});

test("consumeToken deletes the token", async () => {
  const { repo, table } = setup();
  const t = await repo.issueToken("signin", "a@x.com", 900);
  await repo.consumeToken(t, "signin");
  assert.deepEqual(await table.scan("TOKEN#"), []);
});

test("createAccount re-checks on non-condition transact error", async () => {
  const { table, repo } = setup();
  const acc = await repo.createAccount("a@x.com");
  const flaky = createRepo(
    { ...table, transact: async () => { throw new Error("TransactionConflict"); } },
    { now: () => 0 }
  );
  assert.equal((await flaky.createAccount("a@x.com")).id, acc.id);
  await assert.rejects(flaky.createAccount("new@x.com"), /TransactionConflict/);
});

test("caller input cannot overwrite key fields", async () => {
  const { repo, table } = setup();
  const o = await repo.createAccount("o@x.com");
  const p = await repo.createProfile(o.id, { ...profileFields, pk: "X", sk: "Y", id: "z", ownerAccountId: "evil" });
  assert.equal(p.ownerAccountId, o.id);
  assert.notEqual(p.id, "z");
  const victim = await repo.createProfile(o.id, profileFields);
  await repo.updateProfile(p.id, { pk: `PROFILE#${victim.id}`, sk: "META", firstName: "Zed", ownerAccountId: "evil" });
  assert.equal((await repo.getProfile(victim.id)).firstName, "Ann");
  assert.equal((await repo.getProfile(p.id)).firstName, "Zed");
  assert.equal((await repo.getProfile(p.id)).ownerAccountId, o.id);
  assert.equal(await table.get("X", "Y"), null);
});

test("concurrent renewSession and setParentUnlocked both persist", async () => {
  const { repo, clock } = setup();
  const acc = await repo.createAccount("a@x.com");
  const s = await repo.createSession(acc.id);
  clock.t += 10 * 86400e3;
  await Promise.all([repo.renewSession(s.id), repo.setParentUnlocked(s.id, 777)]);
  const got = await repo.getSession(s.id);
  assert.equal(got.parentUnlockedUntil, 777);
  assert.equal(got.expiresAt, clock.t + 90 * 86400e3);
});

test("concurrent updateAccount and touchActive both persist", async () => {
  const { repo, clock } = setup(Date.UTC(2026, 0, 1, 10));
  const acc = await repo.createAccount("a@x.com");
  await repo.updateAccount(acc.id, { warningSentAt: 5 });
  clock.t = Date.UTC(2026, 0, 3, 1);
  await Promise.all([repo.touchActive(acc.id), repo.updateAccount(acc.id, { type: "parent" })]);
  const a = await repo.getAccount(acc.id);
  assert.equal(a.type, "parent");
  assert.equal(a.lastActiveAt, clock.t);
  assert.equal(a.warningSentAt, undefined);
});

test("setProfileOwner records the new owner id (updateProfile can't change it)", async () => {
  const table = createMemoryTable({ now: () => 1 });
  const repo = createRepo(table, { now: () => 1 });
  const p = await repo.createProfile("a1", { firstName: "A", lastName: "B", level: "CSEC", colour: "#F4C143" });
  await repo.updateProfile(p.id, { ownerAccountId: "evil" });
  assert.equal((await repo.getProfile(p.id)).ownerAccountId, "a1");
  const out = await repo.setProfileOwner(p.id, "a2");
  assert.equal(out.ownerAccountId, "a2");
  assert.equal((await repo.getProfile(p.id)).ownerAccountId, "a2");
  assert.equal(await repo.setProfileOwner("missing", "a2"), null);
});
