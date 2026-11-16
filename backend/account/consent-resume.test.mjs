// revertIfLastConsentGiver after a partial failure: the transition is marked
// with its first write, and a retry or the janitor finishes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { createRepo } from "./repo.mjs";
import { revertIfLastConsentGiver } from "./consent.mjs";
import { runJanitor, deleteAccountCascade } from "./deletion.mjs";

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
  test(`a revert that fails part-way is marked and ${resume} finishes it`, async () => {
    for (const failAt of await failurePoints()) {
      const { app, pid, mumAcct } = await approved();
      const before = app.outbox.length;
      const failing = failingOnce(app.table, failAt);
      await assert.rejects(revertIfLastConsentGiver(depsOver(app, failing.table), mumAcct.id, pid), /injected/);
      const mid = await app.repo.getProfile(pid);
      assert.equal(mid.consentStatus, "awaiting_parent", `write ${failAt}: consent is reverted at once`);
      assert.ok(mid.consentRevert, `write ${failAt}: the transition is marked`);
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
  assert.ok((await app.repo.getProfile(pid)).consentRevert);
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
      if (!approvedOnce && item.sk === "META" && item.consentRevert) {
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

/** Fail the revert on its progress delete (after the marker), once. */
function failOnProgressDelete(table) {
  let failed = false;
  return {
    ...table,
    async delete(pk, sk, conditions) {
      if (!failed && sk === "PROGRESS") {
        failed = true;
        throw new Error("injected failure on progress delete");
      }
      return table.delete(pk, sk, conditions);
    },
  };
}

async function reapprove(app, mum, pid) {
  const p = await app.repo.getProfile(pid);
  await app.repo.createInvite({ kind: "consent", fromAccountId: p.ownerAccountId, toEmail: "mum@x.com", profileIds: [pid] });
  await mum.unlock();
  assert.equal((await mum.call("/consent/respond", { profileId: pid, approve: true })).status, 200);
}

test("a re-approved parent leaving again while the old marker remains still reverts the profile", async () => {
  const { app, mum, pid, mumAcct } = await approved();
  await assert.rejects(revertIfLastConsentGiver(depsOver(app, failOnProgressDelete(app.table)), mumAcct.id, pid), /injected/);
  await reapprove(app, mum, pid);
  const before = app.outbox.length;
  // The parent removes their link again: they are the last consent-giver of an active profile.
  assert.equal(await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid), true);
  await assertCleanEndState(app, pid, before);
});

test("a stale finisher doesn't clear the marker of a newer revert", async () => {
  const { app, mum, pid, mumAcct } = await approved();
  // Revert A pauses at its progress delete. Meanwhile the parent re-approves, the
  // old marker is finished, and revert B starts and fails after marking.
  let paused = false;
  const slowA = {
    ...app.table,
    async delete(pk, sk, conditions) {
      if (!paused && sk === "PROGRESS") {
        paused = true;
        await reapprove(app, mum, pid);
        await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
        await assert.rejects(revertIfLastConsentGiver(depsOver(app, failOnProgressDelete(app.table)), mumAcct.id, pid), /injected/);
      }
      return app.table.delete(pk, sk, conditions);
    },
  };
  await revertIfLastConsentGiver(depsOver(app, slowA), mumAcct.id, pid);
  assert.ok(paused);
  const p = await app.repo.getProfile(pid);
  assert.equal(p.consentStatus, "awaiting_parent");
  assert.ok(p.consentRevert, "revert B is still marked, so it will be finished");
});

test("a cascade retried after the janitor finished its revert keeps the new consent invite", async () => {
  const { app, pid, mumAcct } = await approved();
  const failing = depsOver(app, failOnProgressDelete(app.table));
  await assert.rejects(deleteAccountCascade(failing.repo, mumAcct.id, failing), /injected/);
  await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
  await deleteAccountCascade(app.repo, mumAcct.id, depsOver(app, app.table));
  assert.equal(await app.repo.getAccount(mumAcct.id), null);
  assert.equal((await app.repo.getProfile(pid)).consentStatus, "awaiting_parent");
  const invites = (await app.repo.listInvitesForEmail("mum@x.com")).filter((i) => i.kind === "consent");
  assert.deepEqual(invites.map((i) => i.profileIds), [[pid]], "the parent can still approve");
});

test("two workers finishing the same revert leave the parent an invite", async () => {
  const { app, pid, mumAcct } = await approved();
  await assert.rejects(revertIfLastConsentGiver(depsOver(app, failOnProgressDelete(app.table)), mumAcct.id, pid), /injected/);
  // Worker B fails while creating its invite, once.
  let failedCreate = false;
  const failingCreate = {
    ...app.table,
    async transact(ops) {
      if (!failedCreate && ops.some((op) => op.put?.sk === "I" && op.put.kind === "consent")) {
        failedCreate = true;
        throw new Error("injected failure on invite create");
      }
      return app.table.transact(ops);
    },
  };
  // Worker A has created its invite and is sending the email when B runs.
  let ranB = false;
  const pausingMailer = {
    async send(...args) {
      if (!ranB) {
        ranB = true;
        await assert.rejects(revertIfLastConsentGiver(depsOver(app, failingCreate), mumAcct.id, pid), /injected/);
      }
      return app.mailer.send(...args);
    },
  };
  await revertIfLastConsentGiver({ ...depsOver(app, app.table), mailer: pausingMailer }, mumAcct.id, pid);
  assert.ok(ranB && failedCreate);
  const invites = (await app.repo.listInvitesForEmail("mum@x.com")).filter((i) => i.kind === "consent");
  assert.deepEqual(invites.map((i) => i.profileIds), [[pid]], "the parent can still approve");
});

test("a retention deletion that fails mid-revert inside the guarded cascade is finished by the next janitor run", async () => {
  const { app, pid, mumAcct } = await approved();
  const DAY = 86400e3;
  await app.repo.updateAccount(mumAcct.id, { lastActiveAt: app.clock.t - 731 * DAY, warningSentAt: app.clock.t - 31 * DAY });
  const before = app.outbox.length;
  // Run 1: the revert's marker is the guarded cascade's first write; the progress delete after it fails.
  const failingRepo = createRepo(failOnProgressDelete(app.table), { now: () => app.clock.t });
  const first = await runJanitor({ repo: failingRepo, mailer: app.mailer, now: () => app.clock.t });
  assert.equal(first.deletedAccounts, 0);
  assert.ok((await app.repo.getProfile(pid)).consentRevert, "the guarded first write committed the marker");
  // Run 2 finishes the revert, then retries the retention deletion.
  const second = await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
  assert.equal(second.deletedAccounts, 1);
  assert.equal(await app.repo.getAccount(mumAcct.id), null);
  await assertCleanEndState(app, pid, before);
});

for (const resume of ["a retry", "the janitor"]) {
  test(`two overlapping departures never leave the profile without an invite or a marker (${resume} finishes)`, async () => {
    const { app, pid, mumAcct } = await approved();
    const before = app.outbox.length;
    const gate = () => {
      let open;
      const p = new Promise((r) => (open = r));
      return { p, open };
    };
    const bRead = gate(), aMarked = gate(), bInvited = gate(), aFailed = gate();
    const isConsentInvite = (ops) => ops.some((op) => op.put?.sk === "I" && op.put.kind === "consent");
    // B passed the active check before A marked; its first write waits for A's marker.
    let bFirst = true;
    const firstB = async () => {
      if (!bFirst) return;
      bFirst = false;
      bRead.open();
      await aMarked.p;
    };
    const tableB = {
      ...app.table,
      async put(item, c) {
        await firstB();
        // B clears its marker only after A has failed.
        if (item.sk === "META" && item.consentRevert === null) await aFailed.p;
        return app.table.put(item, c);
      },
      async delete(pk, sk, c) {
        await firstB();
        return app.table.delete(pk, sk, c);
      },
      async transact(ops) {
        await firstB();
        await app.table.transact(ops);
        if (isConsentInvite(ops)) bInvited.open();
      },
    };
    // A marks, waits for B's invite, then fails creating its own, once.
    let aCreateFailed = false;
    const tableA = {
      ...app.table,
      async put(item, c) {
        await app.table.put(item, c);
        if (item.sk === "META" && item.consentRevert) aMarked.open();
      },
      async delete(pk, sk, c) {
        if (sk === "PROGRESS") await bInvited.p;
        return app.table.delete(pk, sk, c);
      },
      async transact(ops) {
        if (!aCreateFailed && isConsentInvite(ops)) {
          aCreateFailed = true;
          throw new Error("injected failure on invite create");
        }
        return app.table.transact(ops);
      },
    };
    const b = revertIfLastConsentGiver(depsOver(app, tableB), mumAcct.id, pid).finally(() => bInvited.open());
    await bRead.p;
    const a = revertIfLastConsentGiver(depsOver(app, tableA), mumAcct.id, pid).finally(() => aFailed.open());
    const [ra] = await Promise.allSettled([a, b]);
    assert.equal(ra.status, "rejected");
    assert.ok(aCreateFailed);
    if (resume === "the janitor") {
      await runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });
    } else {
      await revertIfLastConsentGiver(depsOver(app, app.table), mumAcct.id, pid);
    }
    await assertCleanEndState(app, pid, before);
  });
}
