// revertIfLastConsentGiver after a partial failure: the transition is marked
// with its first write, and a retry or the janitor finishes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { createRepo } from "./repo.mjs";
import { revertIfLastConsentGiver } from "./consent.mjs";
import { runJanitor } from "./deletion.mjs";

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
  const sync = await kid.call("/progress/sync", { profileId: pid, events: [{ id: "e1", type: "activity", topic: "Algebra", solved: true, d: "2026-01-01" }] });
  assert.equal(sync.status, 200);
  const mumAcct = await app.repo.findAccountByEmail("mum@x.com");
  return { app, mum, pid, mumAcct };
}

const WRITES = ["put", "delete", "transact", "add"];

/** The app's table, but write number `failAt` (1-based) throws once. */
function failingOnce(table, failAt) {
  let writes = 0;
  const wrapped = { ...table };
  for (const name of WRITES) {
    wrapped[name] = async (...args) => {
      writes++;
      if (writes === failAt) throw new Error(`injected failure on write ${failAt}`);
      return table[name](...args);
    };
  }
  return { table: wrapped, writes: () => writes };
}

const depsOver = (app, table) => ({
  repo: createRepo(table, { now: () => app.clock.t }),
  mailer: app.mailer,
  now: () => app.clock.t,
});

async function assertCleanEndState(app, pid, before) {
  const p = await app.repo.getProfile(pid);
  assert.equal(p.consentStatus, "awaiting_parent");
  assert.equal(p.awaitingSince, app.clock.t);
  assert.ok(!p.consentRevert, "no transition left pending");
  const { progress, version } = await app.repo.getProgress(pid);
  assert.equal(version, 0, "server-side progress is gone");
  assert.deepEqual(progress.topics, {});
  const mail = app.outbox.slice(before).filter((m) => m.to === "mum@x.com" && m.kind === "consent_request");
  assert.equal(mail.length, 1, "the parent is asked once");
  const invites = (await app.repo.listInvitesForEmail("mum@x.com")).filter((i) => i.kind === "consent");
  assert.deepEqual(invites.map((i) => i.profileIds), [[pid]]);
}

/** How many table writes a clean revert makes, measured on a fresh fixture. */
async function cleanWriteCount() {
  const { app, pid, mumAcct } = await approved();
  const counted = failingOnce(app.table, 0);
  assert.equal(await revertIfLastConsentGiver(depsOver(app, counted.table), mumAcct.id, pid), true);
  return counted.writes();
}

test("a clean revert behaves as before and leaves nothing pending", async () => {
  const { app, pid, mumAcct } = await approved();
  const before = app.outbox.length;
  assert.equal(await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid), true);
  await assertCleanEndState(app, pid, before);
  // Nothing left to do: a second call is a no-op.
  assert.equal(await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid), false);
  assert.equal(app.outbox.slice(before).filter((m) => m.kind === "consent_request").length, 1);
});

// Write 1 marks the transition (consent reverted). Each later write is a
// failure point after it: progress deletion, the invite swap, the sign-in token.
// The last write (clearing the marker) follows the email, so a failure there
// can only re-send it; that case has its own test below.
const failurePoints = async () => {
  const n = await cleanWriteCount();
  return Array.from({ length: n - 2 }, (_, i) => i + 2);
};

for (const resume of ["a retry of the same call", "the janitor"]) {
  test(`a revert that fails part-way is marked pending and ${resume} finishes it`, async () => {
    for (const failAt of await failurePoints()) {
      const { app, pid, mumAcct } = await approved();
      const before = app.outbox.length;
      const failing = failingOnce(app.table, failAt);
      await assert.rejects(revertIfLastConsentGiver(depsOver(app, failing.table), mumAcct.id, pid), /injected/);
      const mid = await app.repo.getProfile(pid);
      assert.equal(mid.consentStatus, "awaiting_parent", `write ${failAt}: consent is reverted at once`);
      assert.equal(mid.consentRevert, "pending", `write ${failAt}: the transition is marked`);
      if (resume === "the janitor") {
        await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
      } else {
        assert.equal(await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid), true);
      }
      await assertCleanEndState(app, pid, before);
    }
  });
}

test("a failure before the first write leaves the profile untouched for a plain retry", async () => {
  const { app, pid, mumAcct } = await approved();
  const before = app.outbox.length;
  await assert.rejects(revertIfLastConsentGiver(depsOver(app, failingOnce(app.table, 1).table), mumAcct.id, pid), /injected/);
  const p = await app.repo.getProfile(pid);
  assert.equal(p.consentStatus, "active");
  assert.ok(!p.consentRevert);
  assert.equal(await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid), true);
  await assertCleanEndState(app, pid, before);
});

test("a failure clearing the marker re-sends the request at most once more, and ends clean", async () => {
  const n = await cleanWriteCount();
  const { app, pid, mumAcct } = await approved();
  const before = app.outbox.length;
  await assert.rejects(revertIfLastConsentGiver(depsOver(app, failingOnce(app.table, n).table), mumAcct.id, pid), /injected/);
  assert.equal((await app.repo.getProfile(pid)).consentRevert, "pending");
  assert.equal(await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid), true);
  const p = await app.repo.getProfile(pid);
  assert.ok(!p.consentRevert);
  // Email can't share a transaction with the table: asking twice beats never asking.
  const mail = app.outbox.slice(before).filter((m) => m.kind === "consent_request");
  assert.equal(mail.length, 2);
  const invites = (await app.repo.listInvitesForEmail("mum@x.com")).filter((i) => i.kind === "consent");
  assert.equal(invites.length, 1);
});

test("a parent who re-approves while a revert is pending keeps consent; finishing only clears the marker", async () => {
  const { app, mum, pid, mumAcct } = await approved();
  // Fail on the progress delete: consent is reverted and marked, nothing else done yet.
  await assert.rejects(revertIfLastConsentGiver(depsOver(app, failingOnce(app.table, 2).table), mumAcct.id, pid), /injected/);
  // The parent is asked again through a fresh invite from the owner, and approves.
  const p = await app.repo.getProfile(pid);
  await app.repo.createInvite({ kind: "consent", fromAccountId: p.ownerAccountId, toEmail: "mum@x.com", profileIds: [pid] });
  await mum.unlock();
  assert.equal((await mum.call("/consent/respond", { profileId: pid, approve: true })).status, 200);
  const before = app.outbox.length;
  await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
  const after = await app.repo.getProfile(pid);
  assert.equal(after.consentStatus, "active");
  assert.ok(!after.consentRevert);
  assert.equal(app.outbox.slice(before).filter((m) => m.kind === "consent_request").length, 0);
});

test("a parent who re-approves just after the marker is written keeps the child's progress", async () => {
  const { app, pid, mumAcct } = await approved();
  const before = app.outbox.length;
  // Approval lands right after the revert's first write, before progress is deleted.
  let approvedOnce = false;
  const racing = {
    ...app.table,
    async put(item, conditions) {
      await app.table.put(item, conditions);
      if (!approvedOnce && item.sk === "META" && item.consentRevert === "pending") {
        approvedOnce = true;
        await app.repo.updateProfile(pid, { consentStatus: "active" });
      }
    },
  };
  await revertIfLastConsentGiver(depsOver(app, racing), mumAcct.id, pid);
  assert.ok(approvedOnce);
  const p = await app.repo.getProfile(pid);
  assert.equal(p.consentStatus, "active");
  assert.ok(!p.consentRevert);
  assert.equal((await app.repo.getProgress(pid)).progress.topics.Algebra?.solved, 1, "progress kept");
  assert.equal(app.outbox.slice(before).filter((m) => m.kind === "consent_request").length, 0);
});
