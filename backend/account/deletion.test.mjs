import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { runJanitor } from "./deletion.mjs";

const DAY = 86400e3;
const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];
const codeFrom = (mail) => /\b(\d{6})\b/.exec(mail.text)[1];
const PROFILE = { firstName: "Zed", lastName: "Lee", level: "CSEC", colour: "#F4C143" };

async function signIn(app, email) {
  await app.call("POST", "/signin/start", { email });
  await app.call("POST", "/signin/verify", { token: tokenFrom(app.outbox.at(-1)) });
}

async function parentWithChild(app, email = "p@x.com") {
  await signIn(app, email);
  await app.call("POST", "/setup", { type: "parent" });
  const made = await app.call("POST", "/profiles/create", { ...PROFILE, consent: true });
  return made.body.profile.id;
}

async function unlock(app) {
  await app.call("POST", "/parent/unlock/start");
  return app.call("POST", "/parent/unlock/verify", { code: codeFrom(app.outbox.at(-1)) });
}

async function studentWithProfile(app, email = "s@x.com") {
  await signIn(app, email);
  await app.call("POST", "/setup", { type: "student", holderOver13: true });
  const made = await app.call("POST", "/profiles/create", { ...PROFILE, consent: true });
  return made.body.profile.id;
}

test("parent deletes child after unlock; without unlock -> parent_locked", async () => {
  const app = makeApp();
  const pid = await parentWithChild(app);
  const acct = await app.repo.findAccountByEmail("p@x.com");
  await app.repo.setParentUnlocked(Object.values(app.jar)[0], 0);
  const locked = await app.call("POST", "/profiles/delete", { profileId: pid });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.error, "parent_locked");
  assert.ok(await app.repo.getProfile(pid));
  await unlock(app);
  const ok = await app.call("POST", "/profiles/delete", { profileId: pid });
  assert.equal(ok.status, 200);
  assert.equal(await app.repo.getProfile(pid), null);
  assert.equal(await app.repo.getAccess(acct.id, pid), null);
});

test("guardian cannot delete the profile -> forbidden; stranger -> not_found", async () => {
  const app = makeApp();
  const pid = await parentWithChild(app);
  const g = await app.repo.createAccount("g@x.com");
  await app.repo.updateAccount(g.id, { type: "parent", setupComplete: true });
  await app.repo.grantAccess(g.id, pid, "guardian");
  const stranger = await app.repo.createAccount("n@x.com");
  const gs = await app.repo.createSession(g.id);
  await app.repo.setParentUnlocked(gs.id, Date.now() + 1e12);
  const res = await app.call("POST", "/profiles/delete", { profileId: pid }, { cookie: { sd_session: gs.id } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
  const ss = await app.repo.createSession(stranger.id);
  const res2 = await app.call("POST", "/profiles/delete", { profileId: pid }, { cookie: { sd_session: ss.id } });
  assert.equal(res2.status, 404);
  assert.ok(await app.repo.getProfile(pid));
});

test("student account delete requires emailed code", async () => {
  const app = makeApp();
  const pid = await studentWithProfile(app);
  const acct = await app.repo.findAccountByEmail("s@x.com");
  const no = await app.call("POST", "/profiles/delete", { profileId: pid });
  assert.equal(no.status, 400);
  assert.equal(no.body.error, "invalid_code");
  const noAcct = await app.call("POST", "/account/delete", {});
  assert.equal(noAcct.status, 400);
  const start = await app.call("POST", "/delete/start");
  assert.equal(start.status, 200);
  const mail = app.outbox.at(-1);
  assert.equal(mail.template ?? "confirm_delete", "confirm_delete");
  const code = codeFrom(mail);
  const wrong = await app.call("POST", "/account/delete", { code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  const ok = await app.call("POST", "/account/delete", { code });
  assert.equal(ok.status, 200);
  assert.equal(await app.repo.getAccount(acct.id), null);
  assert.equal(await app.repo.getProfile(pid), null);
  assert.equal(app.jar.sd_session, undefined);
  const me = await app.call("POST", "/me");
  assert.equal(me.status, 401);
});

test("student can delete a profile with a code and keeps the account", async () => {
  const app = makeApp();
  const pid = await studentWithProfile(app);
  const acct = await app.repo.findAccountByEmail("s@x.com");
  await app.call("POST", "/delete/start");
  const res = await app.call("POST", "/profiles/delete", { profileId: pid, code: codeFrom(app.outbox.at(-1)) });
  assert.equal(res.status, 200);
  assert.equal(await app.repo.getProfile(pid), null);
  assert.ok(await app.repo.getAccount(acct.id));
});

test("delete/start is for student accounts only", async () => {
  const app = makeApp();
  await parentWithChild(app);
  const res = await app.call("POST", "/delete/start");
  assert.equal(res.status, 403);
});

test("student code locks after repeated wrong attempts", async () => {
  const app = makeApp();
  await studentWithProfile(app);
  await app.call("POST", "/delete/start");
  let last;
  for (let i = 0; i < 5; i++) last = await app.call("POST", "/account/delete", { code: "000000" });
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "too_many_attempts");
});

test("child on parent's login cannot delete account without code -> parent_locked", async () => {
  const app = makeApp();
  await parentWithChild(app);
  const acct = await app.repo.findAccountByEmail("p@x.com");
  await app.repo.setParentUnlocked(Object.values(app.jar)[0], 0);
  const res = await app.call("POST", "/account/delete", {});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "parent_locked");
  assert.ok(await app.repo.getAccount(acct.id));
});

test("account with no type can delete itself", async () => {
  const app = makeApp();
  await signIn(app, "new@x.com");
  const res = await app.call("POST", "/account/delete", {});
  assert.equal(res.status, 200);
  assert.equal(await app.repo.findAccountByEmail("new@x.com"), null);
});

test("account delete removes owned profiles and progress but leaves guardian's other children intact", async () => {
  const app = makeApp();
  const pid = await studentWithProfile(app);
  const student = await app.repo.findAccountByEmail("s@x.com");
  await app.repo.updateProgress(pid, (p) => ({ ...p }));
  const g = await app.repo.createAccount("g@x.com");
  await app.repo.updateAccount(g.id, { type: "parent", setupComplete: true });
  const other = await app.repo.createProfile(g.id, { ...PROFILE, firstName: "Other", under13: null, consentStatus: "active" });
  await app.repo.grantAccess(g.id, pid, "view_only");
  await app.repo.grantAccess(student.id, other.id, "view_only");
  await app.repo.createInvite({ kind: "share", fromAccountId: student.id, toEmail: "t@x.com", profileIds: [pid] });
  await app.repo.createInvite({ kind: "request", fromAccountId: g.id, toEmail: "s@x.com", profileIds: [] });

  await app.call("POST", "/delete/start");
  const res = await app.call("POST", "/account/delete", { code: codeFrom(app.outbox.at(-1)) });
  assert.equal(res.status, 200);
  assert.equal(await app.repo.getProfile(pid), null);
  assert.equal((await app.repo.getProgress(pid)).version, 0);
  assert.equal(await app.repo.getAccess(g.id, pid), null);
  assert.ok(await app.repo.getProfile(other.id));
  assert.equal(await app.repo.getAccess(student.id, other.id), null);
  assert.equal((await app.repo.listAccessForProfile(other.id)).some((a) => a.accountId === student.id), false);
  assert.equal((await app.repo.listInvitesFromAccount(student.id)).length, 0);
  assert.equal((await app.repo.listInvitesForEmail("s@x.com")).length, 0);
  assert.ok(await app.repo.getAccount(g.id));
});

async function aged(app, email, ageDays, extra = {}) {
  const a = await app.repo.createAccount(email);
  const t = app.clock.t - ageDays * DAY;
  await app.repo.updateAccount(a.id, { createdAt: t, lastActiveAt: t, setupComplete: true, type: "parent", ...extra });
  return a;
}

const run = (app) => runJanitor({ repo: app.repo, mailer: app.mailer, now: () => app.clock.t });

test("janitor warns at 2y-30d, deletes at 2y, not before", async () => {
  const app = makeApp();
  const young = await aged(app, "young@x.com", 699);
  const mid = await aged(app, "mid@x.com", 701);
  const old = await aged(app, "old@x.com", 731);
  const before = app.outbox.length;
  const r1 = await run(app);
  assert.deepEqual(r1, { warned: 2, deletedAccounts: 0, deletedAwaiting: 0, deletedUnfinished: 0 });
  assert.ok(await app.repo.getAccount(young.id));
  assert.ok(await app.repo.getAccount(mid.id));
  assert.ok(await app.repo.getAccount(old.id), "never-warned account is warned, not deleted");
  const mails = app.outbox.slice(before);
  assert.equal(mails.length, 2);
  assert.deepEqual(mails.map((m) => m.to).sort(), ["mid@x.com", "old@x.com"]);
  assert.match(mails[0].text, /#signin=/);
  assert.ok((await app.repo.getAccount(mid.id)).warningSentAt);
  const r2 = await run(app);
  assert.deepEqual(r2, { warned: 0, deletedAccounts: 0, deletedAwaiting: 0, deletedUnfinished: 0 });
  assert.equal(app.outbox.length, before + 2);
  app.clock.t += 30 * DAY;
  const r3 = await run(app);
  assert.equal(r3.deletedAccounts, 2);
  assert.equal(await app.repo.getAccount(mid.id), null);
  assert.equal(await app.repo.getAccount(old.id), null);
});

test("accounts without lastActiveAt fall back to createdAt", async () => {
  const app = makeApp();
  const a = await app.repo.createAccount("f@x.com");
  await app.repo.updateAccount(a.id, { createdAt: app.clock.t - 800 * DAY, setupComplete: true, type: "parent" });
  const item = await app.table.get(`ACCOUNT#${a.id}`, "META");
  const { lastActiveAt, ...rest } = item;
  await app.table.put(rest);
  assert.equal((await run(app)).deletedAccounts, 0);
  assert.equal((await run(app)).warned, 0);
  app.clock.t += 30 * DAY;
  assert.equal((await run(app)).deletedAccounts, 1);
});

test("activity after warning prevents deletion", async () => {
  const app = makeApp();
  const a = await aged(app, "mid@x.com", 701);
  await run(app);
  assert.ok((await app.repo.getAccount(a.id)).warningSentAt);
  app.clock.t += 31 * DAY;
  await app.repo.touchActive(a.id);
  const fresh = await app.repo.getAccount(a.id);
  assert.equal(fresh.warningSentAt, undefined);
  const r = await run(app);
  assert.equal(r.deletedAccounts, 0);
  assert.ok(await app.repo.getAccount(a.id));
});

test("janitor deletes 8-day-old awaiting_parent profile and its empty account, keeps 6-day-old", async () => {
  const app = makeApp();
  const mk = async (email, ageDays) => {
    const s = await app.repo.createAccount(email);
    await app.repo.updateAccount(s.id, { type: "student", setupComplete: true, holderOver13: false });
    const p = await app.repo.createProfile(s.id, {
      ...PROFILE, under13: true, consentStatus: "awaiting_parent", parentEmail: "par@x.com",
    });
    await app.table.put({ ...(await app.table.get(`PROFILE#${p.id}`, "META")), createdAt: app.clock.t - ageDays * DAY });
    await app.repo.createInvite({ kind: "consent", fromAccountId: s.id, toEmail: "par@x.com", profileIds: [p.id] });
    return { s, p };
  };
  const oldOne = await mk("old@x.com", 8);
  const newOne = await mk("new@x.com", 6);
  const r = await run(app);
  assert.equal(r.deletedAwaiting, 1);
  assert.equal(await app.repo.getProfile(oldOne.p.id), null);
  assert.equal(await app.repo.getAccount(oldOne.s.id), null);
  assert.ok(await app.repo.getProfile(newOne.p.id));
  assert.ok(await app.repo.getAccount(newOne.s.id));
  const invites = await app.repo.listInvitesForEmail("par@x.com");
  assert.deepEqual(invites.map((i) => i.profileIds[0]), [newOne.p.id]);
});

test("janitor deletes 8-day-old unfinished setup, keeps 6-day-old and finished", async () => {
  const app = makeApp();
  const mk = async (email, ageDays, setupComplete) => {
    const a = await app.repo.createAccount(email);
    const t = app.clock.t - ageDays * DAY;
    await app.repo.updateAccount(a.id, { createdAt: t, lastActiveAt: app.clock.t, setupComplete });
    return a;
  };
  const oldA = await mk("a@x.com", 8, false);
  const newA = await mk("b@x.com", 6, false);
  const done = await mk("c@x.com", 8, true);
  const r = await run(app);
  assert.equal(r.deletedUnfinished, 1);
  assert.equal(await app.repo.getAccount(oldA.id), null);
  assert.ok(await app.repo.getAccount(newA.id));
  assert.ok(await app.repo.getAccount(done.id));
  assert.deepEqual(await run(app), { warned: 0, deletedAccounts: 0, deletedAwaiting: 0, deletedUnfinished: 0 });
});

test("late warning: warned on day 725, kept on day 731, deleted on day 756", async () => {
  const app = makeApp();
  const base = app.clock.t;
  const a = await app.repo.createAccount("late@x.com");
  await app.repo.updateAccount(a.id, { createdAt: base, lastActiveAt: base, setupComplete: true, type: "parent" });
  app.clock.t = base + 725 * DAY;
  assert.equal((await run(app)).warned, 1);
  app.clock.t = base + 731 * DAY;
  assert.equal((await run(app)).deletedAccounts, 0);
  assert.ok(await app.repo.getAccount(a.id));
  app.clock.t = base + 756 * DAY;
  assert.equal((await run(app)).deletedAccounts, 1);
  assert.equal(await app.repo.getAccount(a.id), null);
});

test("decline deletes a student account that owns nothing even with a view_only link", async () => {
  const app = makeApp();
  const s = await app.repo.createAccount("kid@x.com");
  await app.repo.updateAccount(s.id, { type: "student", setupComplete: true, holderOver13: false });
  const p = await app.repo.createProfile(s.id, {
    ...PROFILE, under13: true, consentStatus: "awaiting_parent", parentEmail: "par@x.com",
  });
  await app.repo.createInvite({ kind: "consent", fromAccountId: s.id, toEmail: "par@x.com", profileIds: [p.id] });
  const other = await app.repo.createAccount("o@x.com");
  const op = await app.repo.createProfile(other.id, { ...PROFILE, under13: false, consentStatus: "active" });
  await app.repo.grantAccess(s.id, op.id, "view_only");
  await signIn(app, "par@x.com");
  await app.call("POST", "/setup", { type: "parent" });
  const res = await app.call("POST", "/consent/respond", { profileId: p.id, approve: false });
  assert.equal(res.status, 200);
  assert.equal(await app.repo.getAccount(s.id), null);
  assert.ok(await app.repo.getProfile(op.id));
});

test("janitor deletes an old student account that owns no profiles, keeps a new one", async () => {
  const app = makeApp();
  const mk = async (email, ageDays) => {
    const a = await app.repo.createAccount(email);
    await app.repo.updateAccount(a.id, {
      type: "student", setupComplete: true, createdAt: app.clock.t - ageDays * DAY, lastActiveAt: app.clock.t,
    });
    return a;
  };
  const oldA = await mk("o@x.com", 8);
  const newA = await mk("n@x.com", 6);
  await run(app);
  assert.equal(await app.repo.getAccount(oldA.id), null);
  assert.ok(await app.repo.getAccount(newA.id));
});

test("one failing account does not stop the janitor and the failure is logged", async () => {
  const app = makeApp();
  const bad = await aged(app, "bad@x.com", 701);
  const good = await aged(app, "good@x.com", 701);
  const mailer = {
    send: async (tpl, to, data) => {
      if (to === "bad@x.com") throw new Error("ses down");
      return app.mailer.send(tpl, to, data);
    },
  };
  const logged = [];
  const orig = console.error;
  console.error = (...args) => logged.push(args);
  let r;
  try {
    r = await runJanitor({ repo: app.repo, mailer, now: () => app.clock.t });
  } finally {
    console.error = orig;
  }
  assert.equal(r.warned, 1);
  assert.ok((await app.repo.getAccount(good.id)).warningSentAt);
  assert.equal((await app.repo.getAccount(bad.id)).warningSentAt, undefined);
  assert.ok(logged.some((l) => String(l[0]).includes(bad.id)));
});
