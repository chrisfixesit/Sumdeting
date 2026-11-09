import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";

const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];

async function setup() {
  const app = makeApp();
  await app.call("POST", "/signin/start", { email: "p@x.com" });
  await app.call("POST", "/signin/verify", { token: tokenFrom(app.outbox.at(-1)) });
  await app.call("POST", "/setup", { type: "parent" });
  const res = await app.call("POST", "/profiles/create", {
    firstName: "Ann", lastName: "Lee", level: "CSEC", colour: "#F4C143", consent: true,
  });
  assert.equal(res.status, 200);
  const account = await app.repo.findAccountByEmail("p@x.com");
  return { app, pid: res.body.profile.id, accountId: account.id };
}

const outcome = (id, over = {}) => ({
  id, type: "outcome", topic: "Fractions", ok: true, hints: 0, turns: 2, d: "2026-01-01", ...over,
});
const activity = (id, over = {}) => ({
  id, type: "activity", topic: "Fractions", solved: true, d: "2026-01-01", ...over,
});

test("sync applies events and returns progress without appliedEventIds", async () => {
  const { app, pid } = await setup();
  const res = await app.call("POST", "/progress/sync", {
    profileId: pid, events: [outcome("e1"), activity("e2")],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.topics.Fractions.solved, 1);
  assert.equal(res.body.progress.topics.Fractions.hist.length, 1);
  assert.equal(res.body.progress.streak.count, 1);
  assert.equal("appliedEventIds" in res.body.progress, false);
  const got = await app.call("POST", "/progress/get", { profileId: pid });
  assert.equal(got.status, 200);
  assert.equal(got.body.progress.topics.Fractions.solved, 1);
  assert.equal("appliedEventIds" in got.body.progress, false);
});

test("replayed batch is not double-counted", async () => {
  const { app, pid } = await setup();
  const events = [activity("e1"), outcome("e2")];
  await app.call("POST", "/progress/sync", { profileId: pid, events });
  const res = await app.call("POST", "/progress/sync", { profileId: pid, events });
  assert.equal(res.body.progress.topics.Fractions.solved, 1);
  assert.equal(res.body.progress.topics.Fractions.hist.length, 1);
});

test("concurrent syncs both apply", async () => {
  const { app, pid } = await setup();
  const [a, b] = await Promise.all([
    app.call("POST", "/progress/sync", { profileId: pid, events: [outcome("a1", { topic: "A" })] }),
    app.call("POST", "/progress/sync", { profileId: pid, events: [outcome("b1", { topic: "B" })] }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const got = await app.call("POST", "/progress/get", { profileId: pid });
  assert.deepEqual(Object.keys(got.body.progress.topics).sort(), ["A", "B"]);
});

test("prefs event stores prefs", async () => {
  const { app, pid } = await setup();
  const res = await app.call("POST", "/progress/sync", {
    profileId: pid,
    events: [{ id: "p1", type: "prefs", level: "CSEC", topic: "Algebra", duration: "10", extra: 1 }],
  });
  assert.deepEqual(res.body.progress.prefs, { level: "CSEC", topic: "Algebra", duration: "10" });
});

test("merge adds device progress", async () => {
  const { app, pid } = await setup();
  const res = await app.call("POST", "/progress/merge", {
    profileId: pid,
    mergeId: "m1",
    local: {
      mastery: {
        topics: { Fractions: { attempted: 3, solved: 2, hist: [{ d: "2026-01-01", ok: 1, hints: 0, turns: 2 }] } },
        streak: { count: 4, last: "2026-01-01" },
        days: { "2026-01-01": 2 },
      },
      prefs: { level: "CSEC", topic: "", duration: "" },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.topics.Fractions.solved, 2);
  assert.equal(res.body.progress.streak.count, 4);
  assert.equal("appliedEventIds" in res.body.progress, false);
  const again = await app.call("POST", "/progress/get", { profileId: pid });
  assert.equal(again.body.progress.topics.Fractions.attempted, 3);
});

test("merge accepts null mastery and prefs", async () => {
  const { app, pid } = await setup();
  const res = await app.call("POST", "/progress/merge", { profileId: pid, mergeId: "m0", local: { mastery: null, prefs: null } });
  assert.equal(res.status, 200);
});

test("merge rejects bad mastery shape and oversize", async () => {
  const { app, pid } = await setup();
  const bad = async (mastery) => {
    const res = await app.call("POST", "/progress/merge", { profileId: pid, mergeId: "mb", local: { mastery, prefs: null } });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_request" }]);
  };
  await bad({ topics: { F: { attempted: -1, solved: 0 } }, streak: { count: 0, last: "" }, days: {} });
  await bad({ topics: { F: { attempted: 1.5, solved: 0 } }, streak: { count: 0, last: "" }, days: {} });
  await bad({ topics: [], streak: { count: 0, last: "" }, days: {} });
  await bad({ topics: {}, streak: { count: 0, last: "nope" }, days: {} });
  await bad({ topics: {}, streak: { count: 0, last: "" }, days: { "2026-01-01": -1 } });
  await bad({ topics: {}, streak: { count: 0, last: "" }, days: { bad: 1 } });
  await bad({ topics: { ["x".repeat(61)]: { attempted: 0, solved: 0 } }, streak: { count: 0, last: "" }, days: {} });
  const hist = Array.from({ length: 51 }, () => ({ d: "2026-01-01", ok: 1, hints: 0, turns: 1 }));
  await bad({ topics: { F: { attempted: 0, solved: 0, hist } }, streak: { count: 0, last: "" }, days: {} });
  await bad({ topics: { F: { attempted: 0, solved: 0, hist: [{ d: "x", ok: 1, hints: 0, turns: 1 }] } }, streak: { count: 0, last: "" }, days: {} });
  const many = {};
  for (let i = 0; i < 101; i++) many[`t${i}`] = { attempted: 0, solved: 0 };
  await bad({ topics: many, streak: { count: 0, last: "" }, days: {} });
  const big = { topics: {}, streak: { count: 0, last: "" }, days: {} };
  for (let i = 0; i < 100; i++) big.topics[`t${i}`] = { attempted: 0, solved: 0, hist: Array.from({ length: 50 }, () => ({ d: "2026-01-01", ok: 1, hints: 0, turns: 1 })) };
  await bad(big);
});

test("view_only access cannot read via progress/get -> forbidden", async () => {
  const { app, pid, accountId } = await setup();
  await app.repo.grantAccess(accountId, pid, "view_only");
  const res = await app.call("POST", "/progress/get", { profileId: pid });
  assert.deepEqual([res.status, res.body], [403, { error: "forbidden" }]);
});

test("no access row -> 404 not_found, even for unknown profile", async () => {
  const { app, pid, accountId } = await setup();
  await app.repo.revokeAccess(accountId, pid);
  for (const profileId of [pid, "nope"]) {
    const res = await app.call("POST", "/progress/get", { profileId });
    assert.deepEqual([res.status, res.body], [404, { error: "not_found" }]);
  }
});

test("guardian can sync", async () => {
  const { app, pid, accountId } = await setup();
  await app.repo.grantAccess(accountId, pid, "guardian");
  const res = await app.call("POST", "/progress/sync", { profileId: pid, events: [outcome("g1")] });
  assert.equal(res.status, 200);
});

test("sync to deleted profile returns 404", async () => {
  const { app, pid } = await setup();
  await app.repo.deleteProfile(pid);
  const res = await app.call("POST", "/progress/sync", { profileId: pid, events: [outcome("e1")] });
  assert.deepEqual([res.status, res.body], [404, { error: "not_found" }]);
});

test("owner access row but profile record missing -> 404", async () => {
  const { app, pid } = await setup();
  await app.table.delete(`PROFILE#${pid}`, "META");
  assert.equal(await app.repo.getProfile(pid), null);
  const res = await app.call("POST", "/progress/get", { profileId: pid });
  assert.deepEqual([res.status, res.body], [404, { error: "not_found" }]);
});

test("awaiting_parent profile -> awaiting_parent", async () => {
  const { app, pid } = await setup();
  await app.repo.updateProfile(pid, { consentStatus: "awaiting_parent" });
  const res = await app.call("POST", "/progress/sync", { profileId: pid, events: [outcome("e1")] });
  assert.deepEqual([res.status, res.body], [403, { error: "awaiting_parent" }]);
});

test("more than 100 events, zero events, non-array -> 400", async () => {
  const { app, pid } = await setup();
  const many = Array.from({ length: 101 }, (_, i) => outcome(`e${i}`));
  for (const events of [many, [], "x", undefined]) {
    const res = await app.call("POST", "/progress/sync", { profileId: pid, events });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_request" }]);
  }
  const hundred = await app.call("POST", "/progress/sync", { profileId: pid, events: many.slice(0, 100) });
  assert.equal(hundred.status, 200);
});

test("malformed events are skipped; valid events in the same batch are kept", async () => {
  const { app, pid } = await setup();
  const cases = [
    { ...outcome("e"), type: "bogus" },
    { ...outcome("e"), id: "" },
    { ...outcome("e"), id: "x".repeat(65) },
    { ...outcome("e"), id: 5 },
    { ...outcome("e"), d: "2026-1-1" },
    { ...outcome("e"), d: "2026-02-30" },
    { ...outcome("e"), d: "2026-13-01" },
    { ...outcome("e"), hints: 100 },
    { ...outcome("e"), hints: -1 },
    { ...outcome("e"), turns: 1.5 },
    { ...outcome("e"), ok: "yes" },
    { ...outcome("e"), topic: "" },
    { ...outcome("e"), topic: "x".repeat(61) },
    { ...activity("e"), solved: 1 },
    { ...activity("e"), topic: "" },
    { ...activity("e"), topic: 7 },
    { id: "e", type: "prefs", level: "Grade 9", topic: "", duration: "" },
    { id: "e", type: "prefs", level: "CSEC", topic: 1, duration: "" },
    null,
    "str",
  ];
  for (const [i, ev] of cases.entries()) {
    const res = await app.call("POST", "/progress/sync", { profileId: pid, events: [ev, activity(`keep${i}`, { topic: "K" })] });
    assert.equal(res.status, 200, JSON.stringify(ev));
    assert.equal(res.body.skipped, 1, JSON.stringify(ev));
  }
  const got = await app.call("POST", "/progress/get", { profileId: pid });
  assert.equal(got.body.progress.topics.K.solved, cases.length);
  const ok = await app.call("POST", "/progress/sync", {
    profileId: pid,
    events: [activity("a", { topic: null }), { id: "p", type: "prefs", level: "", topic: "", duration: "" }],
  });
  assert.equal(ok.status, 200);
});

test("progress endpoints require a session and a profileId", async () => {
  const { app } = await setup();
  const res = await app.call("POST", "/progress/get", { profileId: "" });
  assert.equal(res.status, 400);
  const anon = await app.call("POST", "/progress/get", { profileId: "x" }, { cookie: {} });
  assert.equal(anon.status, 401);
});

test("replayed merge with same mergeId is not double-counted; mergeId required", async () => {
  const { app, pid } = await setup();
  const local = {
    mastery: { topics: { F: { attempted: 3, solved: 2 } }, streak: { count: 0, last: "" }, days: { "2026-01-01": 2 } },
    prefs: null,
  };
  const first = await app.call("POST", "/progress/merge", { profileId: pid, mergeId: "same", local });
  const second = await app.call("POST", "/progress/merge", { profileId: pid, mergeId: "same", local });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.body.progress.topics.F.attempted, 3);
  assert.equal(second.body.progress.days["2026-01-01"], 2);
  const other = await app.call("POST", "/progress/merge", { profileId: pid, mergeId: "diff", local });
  assert.equal(other.body.progress.topics.F.attempted, 6);
  for (const mergeId of [undefined, "", "x".repeat(65), 5]) {
    const res = await app.call("POST", "/progress/merge", { profileId: pid, mergeId, local });
    assert.equal(res.status, 400);
  }
});

test("reserved topic names: sync skips the event, merge -> 400, Object.prototype untouched", async () => {
  const { app, pid } = await setup();
  for (const topic of ["__proto__", "constructor", "prototype"]) {
    for (const ev of [activity("e", { topic }), outcome("e", { topic })]) {
      const res = await app.call("POST", "/progress/sync", { profileId: pid, events: [ev] });
      assert.deepEqual([res.status, res.body.skipped, Object.keys(res.body.progress.topics)], [200, 1, []]);
    }
    const mastery = { topics: JSON.parse(`{"${topic}":{"attempted":1,"solved":1}}`), streak: { count: 0, last: "" }, days: {} };
    const res = await app.call("POST", "/progress/merge", { profileId: pid, mergeId: "mr", local: { mastery, prefs: null } });
    assert.deepEqual([res.status, res.body], [400, { error: "bad_request" }]);
  }
  assert.equal(Object.prototype.solved, undefined);
  assert.equal({}.attempted, undefined);
});

test("topics named toString/hasOwnProperty work through the endpoints", async () => {
  const { app, pid } = await setup();
  const res = await app.call("POST", "/progress/sync", {
    profileId: pid,
    events: [activity("a", { topic: "toString" }), outcome("b", { topic: "hasOwnProperty" })],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.topics.toString.solved, 1);
  assert.equal(res.body.progress.topics.hasOwnProperty.hist.length, 1);
});

// ---- Caps (the test clock is 2026-01-01 12:00 UTC) ----

const dayAfter = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

test("sync accepts tomorrow (time zones) and clamps later dates to tomorrow (clock ahead)", async () => {
  const { app, pid } = await setup();
  assert.equal((await app.call("POST", "/progress/sync", { profileId: pid, events: [activity("t1", { d: "2026-01-02" })] })).status, 200);
  const res = await app.call("POST", "/progress/sync", {
    profileId: pid,
    events: [activity("t2", { d: "2026-01-03" }), outcome("t3", { d: "2027-06-01" }), activity("t4", { d: "2026-01-01" })],
  });
  assert.deepEqual([res.status, res.body.skipped], [200, 0]);
  assert.deepEqual(Object.keys(res.body.progress.days).sort(), ["2026-01-01", "2026-01-02"]);
  assert.equal(res.body.progress.days["2026-01-02"], 2);
  assert.equal(res.body.progress.topics.Fractions.hist[0].d, "2026-01-02");
});

test("sync skips events that would take a profile past 100 topics; the rest of the batch applies", async () => {
  const { app, pid } = await setup();
  const fill = Array.from({ length: 100 }, (_, i) => activity(`f${i}`, { topic: `T${i}` }));
  assert.equal((await app.call("POST", "/progress/sync", { profileId: pid, events: fill })).status, 200);
  const extra = await app.call("POST", "/progress/sync", { profileId: pid, events: [activity("x1", { topic: "New" }), activity("x0", { topic: "T1" })] });
  assert.deepEqual([extra.status, extra.body.skipped, "New" in extra.body.progress.topics], [200, 1, false]);
  assert.equal(extra.body.progress.topics.T1.solved, 2);
  const same = await app.call("POST", "/progress/sync", { profileId: pid, events: [activity("x2", { topic: "T5" })] });
  assert.equal(same.status, 200);
  assert.equal(Object.keys(same.body.progress.topics).length, 100);
  assert.equal(same.body.progress.topics.T5.solved, 2);
  assert.equal(same.body.skipped, 0);
});

test("sync keeps at most 800 days, dropping the oldest", async () => {
  const { app, pid } = await setup();
  const days = {};
  for (let i = 0; i < 800; i++) days[dayAfter("2023-01-01", i)] = 1;
  await app.repo.updateProgress(pid, (p) => ({ ...p, days }));
  const res = await app.call("POST", "/progress/sync", { profileId: pid, events: [activity("d1", { d: "2026-01-01" })] });
  assert.equal(res.status, 200);
  const keys = Object.keys(res.body.progress.days).sort();
  assert.equal(keys.length, 800);
  assert.equal(keys.includes("2023-01-01"), false);
  assert.equal(keys.includes("2026-01-01"), true);
});

test("merge applies the same caps: future dates rejected, 100 topics, 800 days", async () => {
  const { app, pid } = await setup();
  const mastery = (over) => ({ topics: {}, streak: { count: 0, last: "" }, days: {}, ...over });
  const merge = (local, mergeId) => app.call("POST", "/progress/merge", { profileId: pid, mergeId, local: { mastery: local, prefs: null } });
  assert.equal((await merge(mastery({ days: { "2026-01-05": 1 } }), "m1")).status, 400);
  assert.equal((await merge(mastery({ streak: { count: 1, last: "2026-02-01" } }), "m2")).status, 400);
  assert.equal((await merge(mastery({ topics: { A: { attempted: 1, solved: 0, hist: [{ d: "2026-03-01", ok: 1, hints: 0, turns: 1 }] } } }), "m3")).status, 400);

  const fill = Array.from({ length: 60 }, (_, i) => activity(`f${i}`, { topic: `S${i}` }));
  await app.call("POST", "/progress/sync", { profileId: pid, events: fill });
  const topics = {};
  for (let i = 0; i < 60; i++) topics[`L${i}`] = { attempted: 1, solved: 0, hist: [] };
  const tooMany = await merge(mastery({ topics }), "m4");
  assert.deepEqual([tooMany.status, tooMany.body], [400, { error: "bad_request" }]);

  const days = {};
  for (let i = 0; i < 900; i++) days[dayAfter("2023-06-01", i)] = 1;
  const big = await merge(mastery({ days }), "m5");
  assert.equal(big.status, 200);
  const keys = Object.keys(big.body.progress.days).sort();
  assert.equal(keys.length, 800);
  // 900 merged days plus today's from the sync above: the oldest 101 go.
  assert.equal(keys[0], dayAfter("2023-06-01", 101));
  assert.equal(keys.at(-1), "2026-01-01");
});
