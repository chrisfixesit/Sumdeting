// Under-13 consent withdrawal, and what happens when the approving parent leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { runJanitor } from "./deletion.mjs";

const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];
const DAY = 86400e3;

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

/** An under-13 student whose parent (mum@x.com) approved; progress synced. */
async function approved() {
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
  const sync = await kid.call("/progress/sync", { profileId: pid, events: [{ id: "e1", type: "activity", topic: "Algebra", solved: true, d: "2026-01-01" }] });
  assert.equal(sync.status, 200);
  const mumAcct = await app.repo.findAccountByEmail("mum@x.com");
  const kidAcct = await app.repo.findAccountByEmail("kid@x.com");
  return { app, kid, mum, pid, mumAcct, kidAcct };
}

function assertReverted(app, pid, before) {
  return (async () => {
    const p = await app.repo.getProfile(pid);
    assert.equal(p.consentStatus, "awaiting_parent");
    assert.equal(p.awaitingSince, app.clock.t);
    assert.equal(p.parentEmail, "mum@x.com");
    const { progress, version } = await app.repo.getProgress(pid);
    assert.equal(version, 0, "server-side progress is gone");
    assert.deepEqual(progress.topics, {});
    const mail = app.outbox.slice(before).filter((m) => m.to === "mum@x.com" && m.kind === "consent_request");
    assert.equal(mail.length, 1);
    const invites = (await app.repo.listInvitesForEmail("mum@x.com")).filter((i) => i.kind === "consent");
    assert.deepEqual(invites.map((i) => i.profileIds), [[pid]]);
  })();
}

test("overview marks the children this parent approved (consentGiver)", async () => {
  const { mum, pid } = await approved();
  const ov = await mum.call("/parent/overview");
  assert.equal(ov.status, 200);
  const row = ov.body.children.find((c) => c.profileId === pid);
  assert.equal(row.consentGiver, true);
  assert.equal(row.access, "view_only");
});

test("consent/withdraw deletes the profile, its progress and access, and the student account left empty", async () => {
  const { app, mum, pid, mumAcct, kidAcct } = await approved();
  const res = await mum.call("/consent/withdraw", { profileId: pid });
  assert.deepEqual([res.status, res.body], [200, { withdrawn: true }]);
  assert.equal(await app.repo.getProfile(pid), null);
  assert.equal((await app.repo.getProgress(pid)).version, 0);
  assert.equal(await app.repo.getAccess(mumAcct.id, pid), null);
  assert.equal(await app.repo.getAccount(kidAcct.id), null, "the student account owned nothing else");
  assert.ok(await app.repo.getAccount(mumAcct.id));
});

test("consent/withdraw keeps a student account that still owns other profiles", async () => {
  const { app, mum, pid, kidAcct } = await approved();
  await app.repo.createProfile(kidAcct.id, { firstName: "Sib", lastName: "Hall", level: "CSEC", colour: "#F4C143", under13: false, consentStatus: "active" });
  assert.equal((await mum.call("/consent/withdraw", { profileId: pid })).status, 200);
  assert.ok(await app.repo.getAccount(kidAcct.id));
});

test("consent/withdraw: only the consent-giver, only under-13, only unlocked", async () => {
  const { app, mum, pid, kidAcct } = await approved();
  const other = await client(app, "dad@x.com");
  await other.call("/setup", { type: "parent" });
  await other.unlock();
  const stranger = await other.call("/consent/withdraw", { profileId: pid });
  assert.deepEqual([stranger.status, stranger.body], [403, { error: "forbidden" }]);
  // A plain view-only link (not the approver) is refused too.
  const dadAcct = await app.repo.findAccountByEmail("dad@x.com");
  await app.repo.grantAccess(dadAcct.id, pid, "view_only");
  assert.equal((await other.call("/consent/withdraw", { profileId: pid })).status, 403);
  // Not under 13: refused.
  const older = await app.repo.createProfile(kidAcct.id, { firstName: "Big", lastName: "Hall", level: "CSEC", colour: "#F4C143", under13: false, consentStatus: "active" });
  const mumAcct = await app.repo.findAccountByEmail("mum@x.com");
  await app.repo.grantAccess(mumAcct.id, older.id, "view_only", { consentGiver: true });
  assert.equal((await mum.call("/consent/withdraw", { profileId: older.id })).status, 403);
  // Locked: refused.
  await app.repo.setParentUnlocked(mum.cookie.sd_session, 0);
  const locked = await mum.call("/consent/withdraw", { profileId: pid });
  assert.deepEqual([locked.status, locked.body], [403, { error: "parent_locked" }]);
  assert.ok(await app.repo.getProfile(pid));
});

test("consent-giver removing their own link reverts the profile to awaiting and asks again", async () => {
  const { app, mum, pid, mumAcct } = await approved();
  const before = app.outbox.length;
  const res = await mum.call("/links/remove", { profileId: pid, accountId: mumAcct.id });
  assert.equal(res.status, 200);
  await assertReverted(app, pid, before);
});

test("consent-giver deleting their account reverts the profile to awaiting", async () => {
  const { app, mum, pid, mumAcct } = await approved();
  const before = app.outbox.length;
  assert.equal((await mum.call("/account/delete")).status, 200);
  assert.equal(await app.repo.getAccount(mumAcct.id), null);
  await assertReverted(app, pid, before);
});

test("consent-giver retention-deleted reverts the profile to awaiting", async () => {
  const { app, pid, mumAcct } = await approved();
  await app.repo.updateAccount(mumAcct.id, { lastActiveAt: app.clock.t - 731 * DAY, warningSentAt: app.clock.t - 31 * DAY });
  const before = app.outbox.length;
  const r = await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
  assert.equal(r.deletedAccounts, 1);
  await assertReverted(app, pid, before);
});

test("a second consent-giver keeps the profile active", async () => {
  const { app, mum, pid, mumAcct } = await approved();
  const dad = await app.repo.createAccount("dad@x.com");
  await app.repo.updateAccount(dad.id, { type: "parent", setupComplete: true });
  await app.repo.grantAccess(dad.id, pid, "view_only", { consentGiver: true });
  await mum.call("/links/remove", { profileId: pid, accountId: mumAcct.id });
  const p = await app.repo.getProfile(pid);
  assert.equal(p.consentStatus, "active");
  assert.equal((await app.repo.getProgress(pid)).progress.topics.Algebra.solved, 1);
});

test("janitor's 7-day awaiting rule counts from awaitingSince", async () => {
  const { app, mum, pid, mumAcct, kidAcct } = await approved();
  app.clock.t += 30 * DAY; // the profile itself is old
  await mum.unlock();
  assert.equal((await mum.call("/links/remove", { profileId: pid, accountId: mumAcct.id })).status, 200);
  assert.equal((await app.repo.getProfile(pid)).consentStatus, "awaiting_parent");
  const run = () => runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
  app.clock.t += 6 * DAY;
  assert.equal((await run()).deletedAwaiting, 0);
  assert.ok(await app.repo.getProfile(pid));
  app.clock.t += 2 * DAY;
  await app.repo.touchActive(kidAcct.id);
  assert.equal((await run()).deletedAwaiting, 1);
  assert.equal(await app.repo.getProfile(pid), null);
});
