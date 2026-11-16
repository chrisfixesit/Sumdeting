// Issue #21: a progress sync that passes authorise() must not write once the
// profile is deleted, consent is withdrawn or reverted, or the caller's access
// is revoked before the write lands. The race is made deterministic by wrapping
// the memory table so a hook runs just before the progress write, after
// authorise() and the progress read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { revertIfLastConsentGiver } from "./consent.mjs";

const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];

async function client(app, email, token) {
  if (!token) {
    await app.call("POST", "/signin/start", { email }, { cookie: {} });
    token = tokenFrom(app.outbox.at(-1));
  }
  const res = await app.call("POST", "/signin/verify", { token }, { cookie: {} });
  assert.equal(res.status, 200);
  const cookie = { sd_session: /sd_session=([^;]+)/.exec(res.setCookies[0])[1] };
  return {
    cookie,
    call: (path, body = {}) => app.call("POST", path, body, { cookie }),
    unlock: () => app.repo.setParentUnlocked(cookie.sd_session, app.clock.t + 15 * 60 * 1000),
  };
}

/** A parent who owns a consented profile (no prior progress). */
async function owned() {
  const app = makeApp();
  const parent = await client(app, "p@x.com");
  await parent.call("/setup", { type: "parent" });
  const made = await parent.call("/profiles/create", {
    firstName: "Ann", lastName: "Lee", level: "CSEC", colour: "#F4C143", consent: true,
  });
  assert.equal(made.status, 200);
  const account = await app.repo.findAccountByEmail("p@x.com");
  return { app, parent, pid: made.body.profile.id, accountId: account.id };
}

/** An under-13 student whose parent (mum@x.com) approved; one sync already stored unless synced is false. */
async function approved({ synced = true } = {}) {
  const app = makeApp();
  const kid = await client(app, "kid@x.com");
  await kid.call("/setup", { type: "student", holderOver13: false });
  const made = await kid.call("/profiles/create", {
    firstName: "Zoe", lastName: "Hall", level: "CSEC", colour: "#F4C143", over13: false, parentEmail: "mum@x.com",
  });
  const pid = made.body.profile.id;
  const mum = await client(app, "mum@x.com", tokenFrom(app.outbox.at(-1)));
  assert.equal((await mum.call("/consent/respond", { profileId: pid, approve: true })).status, 200);
  await mum.unlock();
  if (synced) {
    const first = await kid.call("/progress/sync", { profileId: pid, events: [activity("e0")] });
    assert.equal(first.status, 200);
  }
  const mumAcct = await app.repo.findAccountByEmail("mum@x.com");
  return { app, kid, mum, pid, mumAcct };
}

const activity = (id) => ({ id, type: "activity", topic: "Algebra", solved: true, d: "2026-01-01" });

/** Run `hook` once, right before the first write of pid's PROGRESS item. */
function beforeProgressWrite(app, pid, hook) {
  const { put, transact } = app.table;
  let fired = false;
  const isProgress = (item) => item?.pk === `PROFILE#${pid}` && item.sk === "PROGRESS";
  const once = async () => {
    if (!fired) {
      fired = true;
      await hook();
    }
  };
  app.table.put = async (item, conditions) => {
    if (isProgress(item)) await once();
    return put(item, conditions);
  };
  app.table.transact = async (ops) => {
    if (ops.some((op) => isProgress(op.put))) await once();
    return transact(ops);
  };
  return { fired: () => fired };
}

/** The stored PROGRESS item, read straight from the table (null when absent). */
const progressItem = (app, pid) => app.table.get(`PROFILE#${pid}`, "PROGRESS");

// The client queue drops its events on 404 or 403 ("gone"); see web/account-core.mjs.
const DROP = [403, 404];

test("profile deleted mid-sync: nothing is written and the client is told to drop", async () => {
  const { app, parent, pid } = await owned();
  const race = beforeProgressWrite(app, pid, () => app.repo.deleteProfile(pid));
  const res = await parent.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.ok(race.fired(), "the hook ran between authorise and the write");
  assert.equal(await app.repo.getProfile(pid), null);
  assert.equal(await progressItem(app, pid), null, "no progress for a deleted profile");
  assert.deepEqual([res.status, res.body.error], [404, "not_found"]);
});

test("consent withdrawn mid-sync (/consent/withdraw): nothing is written", async () => {
  const { app, kid, mum, pid } = await approved();
  const race = beforeProgressWrite(app, pid, async () => {
    const w = await mum.call("/consent/withdraw", { profileId: pid });
    assert.equal(w.status, 200);
  });
  const res = await kid.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.ok(race.fired());
  assert.equal(await progressItem(app, pid), null, "no progress after consent is withdrawn");
  assert.ok(DROP.includes(res.status), `drop code, got ${res.status}`);
});

test("consent reverted mid-sync (approving parent left): nothing is written", async () => {
  const { app, kid, pid, mumAcct } = await approved();
  const race = beforeProgressWrite(app, pid, async () => {
    assert.equal(await revertIfLastConsentGiver({ repo: app.repo, now: () => app.clock.t }, mumAcct.id, pid), true);
  });
  const res = await kid.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.ok(race.fired());
  assert.equal((await app.repo.getProfile(pid)).consentStatus, "awaiting_parent");
  assert.equal(await progressItem(app, pid), null, "no progress while awaiting a parent");
  assert.deepEqual([res.status, res.body.error], [403, "awaiting_parent"]);
});

test("consent reverted mid-sync before any progress was stored: nothing is written", async () => {
  // With no progress yet, the revert's deleteProgress changes nothing, so only the
  // profile's own change (consentStatus, hence its version) can stop this write.
  const { app, kid, pid, mumAcct } = await approved({ synced: false });
  const race = beforeProgressWrite(app, pid, async () => {
    assert.equal(await revertIfLastConsentGiver({ repo: app.repo, now: () => app.clock.t }, mumAcct.id, pid), true);
  });
  const res = await kid.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.ok(race.fired());
  assert.equal(await progressItem(app, pid), null, "no progress while awaiting a parent");
  assert.deepEqual([res.status, res.body.error], [403, "awaiting_parent"]);
});

test("access revoked mid-sync: the caller can't write", async () => {
  const { app, parent, pid, accountId } = await owned();
  const race = beforeProgressWrite(app, pid, () => app.repo.revokeAccess(accountId, pid));
  const res = await parent.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.ok(race.fired());
  assert.equal(await progressItem(app, pid), null);
  assert.deepEqual([res.status, res.body.error], [404, "not_found"]);
});

test("profile deleted mid-merge: /progress/merge writes nothing either", async () => {
  const { app, parent, pid } = await owned();
  const race = beforeProgressWrite(app, pid, () => app.repo.deleteProfile(pid));
  const res = await parent.call("/progress/merge", {
    profileId: pid, mergeId: "m1",
    local: { mastery: { topics: { Algebra: { attempted: 1, solved: 1 } }, streak: { count: 1, last: "2026-01-01" }, days: { "2026-01-01": 1 } }, prefs: null },
  });
  assert.ok(race.fired());
  assert.equal(await progressItem(app, pid), null);
  assert.deepEqual([res.status, res.body.error], [404, "not_found"]);
});

test("a harmless profile change mid-sync (colour) still saves the progress", async () => {
  const { app, parent, pid } = await owned();
  const race = beforeProgressWrite(app, pid, () => app.repo.updateProfile(pid, { colour: "#0B39A8" }));
  const res = await parent.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.ok(race.fired());
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.topics.Algebra.solved, 1);
  assert.equal((await progressItem(app, pid)).progress.topics.Algebra.solved, 1);
});

test("a normal sync still writes", async () => {
  const { app, parent, pid } = await owned();
  const res = await parent.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.equal(res.status, 200);
  assert.equal((await progressItem(app, pid)).progress.topics.Algebra.solved, 1);
});

test("an under-13 profile still awaiting a parent is refused as before", async () => {
  const app = makeApp();
  const kid = await client(app, "kid@x.com");
  await kid.call("/setup", { type: "student", holderOver13: false });
  const made = await kid.call("/profiles/create", {
    firstName: "Zoe", lastName: "Hall", level: "CSEC", colour: "#F4C143", over13: false, parentEmail: "mum@x.com",
  });
  const pid = made.body.profile.id;
  const res = await kid.call("/progress/sync", { profileId: pid, events: [activity("e1")] });
  assert.deepEqual([res.status, res.body.error], [403, "awaiting_parent"]);
  assert.equal(await progressItem(app, pid), null);
});
