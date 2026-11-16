import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { runJanitor } from "./deletion.mjs";

// #23: the janitor reads an account as idle, then a sign-in (touchActive) lands
// before it hands the children over or deletes the account.

const DAY = 86400e3;
const PROFILE = { firstName: "Zed", lastName: "Lee", level: "CSEC", colour: "#F4C143" };

async function aged(app, email, ageDays, extra = {}) {
  const a = await app.repo.createAccount(email);
  const t = app.clock.t - ageDays * DAY;
  await app.repo.updateAccount(a.id, { createdAt: t, lastActiveAt: t, setupComplete: true, type: "parent", ...extra });
  return a;
}

/** An idle, warned owner with a guarded child (would be handed over) and an unguarded one (would be deleted). */
async function idleOwner(app) {
  const idle = await aged(app, "idle@x.com", 731, { warningSentAt: app.clock.t - 31 * DAY });
  const guarded = await app.repo.createProfile(idle.id, { ...PROFILE, under13: false, consentStatus: "active" });
  const solo = await app.repo.createProfile(idle.id, { ...PROFILE, firstName: "Solo", under13: false, consentStatus: "active" });
  for (const p of [guarded, solo]) await app.repo.updateProgress(p.id, (progress) => ({ ...progress, seen: true }));
  const guardian = await aged(app, "g@x.com", 1);
  await app.repo.grantAccess(guardian.id, guarded.id, "guardian");
  return { idle, guarded, solo, guardian };
}

const run = (app, repo = app.repo) => runJanitor({ repo, mailer: app.mailer, now: () => app.clock.t });

/** Runs `hook` once, just before (or after) the first table write the janitor makes. */
function onFirstWrite(table, hook, { after = false } = {}) {
  let fired = false;
  for (const method of ["put", "transact", "delete"]) {
    const original = table[method];
    table[method] = async (...args) => {
      if (fired) return original(...args);
      fired = true;
      if (!after) await hook();
      const out = await original(...args);
      if (after) await hook();
      return out;
    };
  }
  return () => fired;
}

async function assertIntact(app, { idle, guarded, solo, guardian }) {
  const account = await app.repo.getAccount(idle.id);
  assert.ok(account, "the account still exists");
  assert.equal(account.email, "idle@x.com");
  assert.equal((await app.repo.findAccountByEmail("idle@x.com"))?.id, idle.id);
  for (const p of [guarded, solo]) {
    const profile = await app.repo.getProfile(p.id);
    assert.ok(profile, `profile ${p.firstName} still exists`);
    assert.equal(profile.ownerAccountId, idle.id, "no hand-over happened");
    assert.equal(await app.repo.getAccess(idle.id, p.id), "owner");
    assert.equal((await app.repo.getProgress(p.id)).progress.seen, true, "progress is kept");
  }
  assert.equal(await app.repo.getAccess(guardian.id, guarded.id), "guardian", "the guardian was not made owner");
}

test("sign-in between the janitor's idle read and its first write: account is skipped and left intact", async (t) => {
  const app = makeApp();
  const setup = await idleOwner(app);
  const info = t.mock.method(console, "info", () => {});
  const sent = app.outbox.length;
  const fired = onFirstWrite(app.table, () => app.repo.touchActive(setup.idle.id));

  const r = await run(app);

  assert.ok(fired(), "the race hook ran");
  assert.equal(r.deletedAccounts, 0);
  await assertIntact(app, setup);
  assert.equal(app.outbox.length, sent, "no email went out");
  assert.ok(
    info.mock.calls.some((c) => String(c.arguments[0]).includes(setup.idle.id)),
    "the skip is logged at info level"
  );
});

test("sign-in after the janitor listed accounts: the stale idle read is not acted on", async () => {
  const app = makeApp();
  const setup = await idleOwner(app);
  const sent = app.outbox.length;
  const repo = {
    ...app.repo,
    async listAccounts() {
      const accounts = await app.repo.listAccounts();
      await app.repo.touchActive(setup.idle.id);
      return accounts;
    },
  };
  const info = console.info;
  console.info = () => {};
  try {
    const r = await run(app, repo);
    assert.equal(r.deletedAccounts, 0);
  } finally {
    console.info = info;
  }
  await assertIntact(app, setup);
  assert.equal(app.outbox.length, sent, "no email went out");
});

test("guard: a truly idle account is still handed over and deleted", async () => {
  const app = makeApp();
  const { idle, guarded, solo, guardian } = await idleOwner(app);
  const r = await run(app);
  assert.equal(r.deletedAccounts, 1);
  assert.equal(await app.repo.getAccount(idle.id), null);
  assert.equal(await app.repo.findAccountByEmail("idle@x.com"), null);
  assert.equal((await app.repo.getProfile(guarded.id)).ownerAccountId, guardian.id);
  assert.equal(await app.repo.getAccess(guardian.id, guarded.id), "owner");
  assert.equal(await app.repo.getProfile(solo.id), null);
});

test("guard: a sign-in after the first write still ends fully deleted, not half-deleted", async () => {
  // Same outcome as before #23: once the janitor has committed, it finishes.
  const app = makeApp();
  const { idle, guarded, solo, guardian } = await idleOwner(app);
  onFirstWrite(app.table, () => app.repo.touchActive(idle.id), { after: true });
  const r = await run(app);
  assert.equal(r.deletedAccounts, 1);
  assert.equal(await app.repo.getAccount(idle.id), null);
  assert.equal(await app.repo.findAccountByEmail("idle@x.com"), null);
  assert.deepEqual(await app.table.query(`ACCOUNT#${idle.id}`), [], "no rows left under the account");
  assert.equal((await app.repo.getProfile(guarded.id)).ownerAccountId, guardian.id);
  assert.equal(await app.repo.getAccess(guardian.id, guarded.id), "owner");
  assert.equal(await app.repo.getProfile(solo.id), null);
  assert.equal(await app.repo.getProgress(solo.id).then((p) => p.version), 0);
});
