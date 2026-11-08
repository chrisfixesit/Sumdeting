import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";

const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];
const DAY = 24 * 3600 * 1000;

// A signed-in client with its own cookie, sharing the app's repo and outbox.
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
    me: res.body,
    call: (path, body = {}) => app.call("POST", path, body, { cookie }),
    unlock: () => app.repo.setParentUnlocked(cookie.sd_session, app.clock.t + 15 * 60 * 1000),
  };
}

async function student(app, email = "kid@x.com") {
  const c = await client(app, email);
  await c.call("/setup", { type: "student", holderOver13: true });
  const p = await c.call("/profiles/create", {
    firstName: "Kid", lastName: "One", level: "CSEC", colour: "#F4C143", consent: true,
  });
  assert.equal(p.status, 200);
  return { c, pid: p.body.profile.id };
}

async function parent(app, email = "p@x.com") {
  const c = await client(app, email);
  await c.call("/setup", { type: "parent" });
  return c;
}

test("student shares; new parent signs in and sees child as view_only", async () => {
  const app = makeApp();
  const { c, pid } = await student(app);
  const r = await c.call("/links/share", { profileId: pid, parentEmail: " Mum@X.com " });
  assert.equal(r.status, 200);
  const mail = app.outbox.at(-1);
  assert.equal(mail.to, "mum@x.com");
  const mum = await client(app, "mum@x.com", tokenFrom(mail));
  assert.equal(mum.me.account.type, "parent");
  assert.equal(mum.me.account.setupComplete, true);
  assert.deepEqual(mum.me.profiles.map((p) => [p.id, p.access]), [[pid, "view_only"]]);
  assert.deepEqual(await app.repo.listInvitesForEmail("mum@x.com"), []);
});

test("share to existing parent applies on their next /me", async () => {
  const app = makeApp();
  const mum = await parent(app, "mum@x.com");
  const { c, pid } = await student(app);
  await c.call("/links/share", { profileId: pid, parentEmail: "mum@x.com" });
  const me = await mum.call("/me");
  assert.deepEqual(me.body.profiles.map((p) => p.access), ["view_only"]);
  assert.equal((await mum.call("/me")).status, 200);
});

test("share validation: student target, own email, ownership, awaiting, non-student, rate limit", async () => {
  const app = makeApp();
  const { c, pid } = await student(app);
  await client(app, "other@x.com").then((o) => o.call("/setup", { type: "student", holderOver13: true }));
  const t = await c.call("/links/share", { profileId: pid, parentEmail: "other@x.com" });
  assert.deepEqual([t.status, t.body], [400, { error: "email_is_student" }]);
  assert.equal((await c.call("/links/share", { profileId: pid, parentEmail: "kid@x.com" })).status, 400);
  assert.equal((await c.call("/links/share", { profileId: pid, parentEmail: "nope" })).status, 400);
  const o = await client(app, "o2@x.com");
  assert.equal((await o.call("/links/share", { profileId: pid, parentEmail: "m@x.com" })).status, 403);
  const mum = await parent(app, "pp@x.com");
  const pc = await mum.call("/profiles/create", {
    firstName: "A", lastName: "B", level: "CSEC", colour: "#F4C143", consent: true,
  });
  assert.equal((await mum.call("/links/share", { profileId: pc.body.profile.id, parentEmail: "m@x.com" })).status, 403);
  // awaiting_parent profile
  const u = await client(app, "u13@x.com");
  await u.call("/setup", { type: "student", holderOver13: false });
  const up = await u.call("/profiles/create", {
    firstName: "Y", lastName: "Z", level: "CSEC", colour: "#F4C143", over13: false, parentEmail: "g@x.com",
  });
  const aw = await u.call("/links/share", { profileId: up.body.profile.id, parentEmail: "m@x.com" });
  assert.deepEqual([aw.status, aw.body], [403, { error: "awaiting_parent" }]);
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.call("/links/share", { profileId: pid, parentEmail: `m${i}@x.com` })).status, 200);
  }
  const lim = await c.call("/links/share", { profileId: pid, parentEmail: "m9@x.com" });
  assert.deepEqual([lim.status, lim.body], [429, { error: "rate_limited" }]);
});

test("parent request appears in pendingRequests; allow with chosen profiles grants view_only to those only", async () => {
  const app = makeApp();
  const { c, pid } = await student(app);
  const second = await c.call("/profiles/create", {
    firstName: "Two", lastName: "T", level: "CSEC", colour: "#F4C143", over13: true, consent: true,
  });
  assert.equal(second.status, 200);
  const mum = await parent(app, "mum@x.com");
  assert.equal((await mum.call("/links/request", { childEmail: "kid@x.com" })).status, 200);
  assert.equal((await mum.call("/links/request", { childEmail: "kid@x.com" })).status, 200);
  const me = await c.call("/me");
  assert.equal(me.body.pendingRequests.length, 1);
  assert.equal(me.body.pendingRequests[0].parentEmail, "mum@x.com");
  const { inviteId } = me.body.pendingRequests[0];
  assert.equal((await c.call("/links/respond", { inviteId, allow: true, profileIds: [] })).status, 400);
  assert.equal((await c.call("/links/respond", { inviteId, allow: true, profileIds: ["nope"] })).status, 403);
  assert.equal((await c.call("/links/respond", { inviteId, allow: true, profileIds: [pid] })).status, 200);
  const mm = await mum.call("/me");
  assert.deepEqual(mm.body.profiles.map((p) => [p.id, p.access]), [[pid, "view_only"]]);
  assert.deepEqual((await c.call("/me")).body.pendingRequests, []);
  assert.equal((await c.call("/links/respond", { inviteId, allow: true, profileIds: [pid] })).status, 404);
});

test("decline deletes request without access", async () => {
  const app = makeApp();
  const { c } = await student(app);
  const mum = await parent(app, "mum@x.com");
  await mum.call("/links/request", { childEmail: "kid@x.com" });
  const { inviteId } = (await c.call("/me")).body.pendingRequests[0];
  assert.equal((await c.call("/links/respond", { inviteId, allow: false })).status, 200);
  assert.deepEqual((await mum.call("/me")).body.profiles, []);
  assert.deepEqual((await c.call("/me")).body.pendingRequests, []);
});

test("respond: invite is only visible to the addressed email", async () => {
  const app = makeApp();
  const { c, pid } = await student(app);
  const mum = await parent(app, "mum@x.com");
  await mum.call("/links/request", { childEmail: "kid@x.com" });
  const { inviteId } = (await c.call("/me")).body.pendingRequests[0];
  assert.equal((await mum.call("/links/respond", { inviteId, allow: true, profileIds: [pid] })).status, 404);
  const other = await student(app, "o@x.com");
  assert.equal((await other.c.call("/links/respond", { inviteId, allow: false })).status, 404);
});

test("request to a parent account → email_is_parent; own email and locked parent refused", async () => {
  const app = makeApp();
  const mum = await parent(app, "mum@x.com");
  await parent(app, "dad@x.com");
  const r = await mum.call("/links/request", { childEmail: "dad@x.com" });
  assert.deepEqual([r.status, r.body], [400, { error: "email_is_parent" }]);
  assert.equal((await mum.call("/links/request", { childEmail: "mum@x.com" })).status, 400);
  assert.equal((await mum.call("/links/request", { childEmail: "bad" })).status, 400);
  app.clock.t += 20 * 60 * 1000;
  assert.equal((await mum.call("/links/request", { childEmail: "k@x.com" })).body.error, "parent_locked");
});

test("request to an email with no account waits; after student signs up it appears", async () => {
  const app = makeApp();
  const mum = await parent(app, "mum@x.com");
  assert.equal((await mum.call("/links/request", { childEmail: "later@x.com" })).status, 200);
  const mail = app.outbox.at(-1);
  assert.equal(mail.to, "later@x.com");
  const kid = await client(app, "later@x.com", tokenFrom(mail));
  await kid.call("/setup", { type: "student", holderOver13: true });
  const me = await kid.call("/me");
  assert.equal(me.body.pendingRequests.length, 1);
});

test("respond when the requester is gone → 404 and the invite is deleted", async () => {
  const app = makeApp();
  const { c, pid } = await student(app);
  const mum = await parent(app, "mum@x.com");
  await mum.call("/links/request", { childEmail: "kid@x.com" });
  const invite = (await app.repo.listInvitesForEmail("kid@x.com"))[0];
  await app.repo.deleteAccountRecord(invite.fromAccountId);
  assert.deepEqual((await c.call("/me")).body.pendingRequests, []);
  const r = await c.call("/links/respond", { inviteId: invite.id, allow: true, profileIds: [pid] });
  assert.equal(r.status, 404);
  assert.deepEqual(await app.repo.listInvitesForEmail("kid@x.com"), []);
});

async function guardianSetup() {
  const app = makeApp();
  const mum = await parent(app, "mum@x.com");
  const made = await mum.call("/profiles/create", {
    firstName: "Ann", lastName: "Lee", level: "CSEC", colour: "#F4C143", consent: true,
  });
  const pid = made.body.profile.id;
  return { app, mum, pid };
}

test("guardian invite: guardian sees child as guardian and can sync progress", async () => {
  const { app, mum, pid } = await guardianSetup();
  const r = await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  assert.equal(r.status, 200);
  const mail = app.outbox.at(-1);
  assert.equal(mail.to, "dad@x.com");
  const dad = await client(app, "dad@x.com", tokenFrom(mail));
  assert.deepEqual(dad.me.profiles.map((p) => [p.id, p.access]), [[pid, "guardian"]]);
  const sync = await dad.call("/progress/sync", {
    profileId: pid,
    events: [{ id: "e1", type: "outcome", topic: "Fractions", ok: true, hints: 0, turns: 2, d: "2026-01-01" }],
  });
  assert.equal(sync.status, 200);
  assert.equal((await dad.call("/progress/get", { profileId: pid })).status, 200);
});

test("invite-guardian validation", async () => {
  const { app, mum, pid } = await guardianSetup();
  await student(app, "kid@x.com");
  const s = await mum.call("/links/invite-guardian", { profileId: pid, email: "kid@x.com" });
  assert.deepEqual([s.status, s.body], [400, { error: "email_is_student" }]);
  assert.equal((await mum.call("/links/invite-guardian", { profileId: pid, email: "mum@x.com" })).status, 400);
  assert.equal((await mum.call("/links/invite-guardian", { profileId: pid, email: "x" })).status, 400);
  const other = await parent(app, "o@x.com");
  assert.equal((await other.call("/links/invite-guardian", { profileId: pid, email: "z@x.com" })).status, 403);
  await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  await client(app, "dad@x.com", tokenFrom(app.outbox.at(-1)));
  const again = await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  assert.deepEqual([again.status, again.body], [400, { error: "already_linked" }]);
});

test("invite-guardian is rate limited before sending", async () => {
  const { app, mum, pid } = await guardianSetup();
  for (let i = 0; i < 5; i++) {
    assert.equal((await mum.call("/links/invite-guardian", { profileId: pid, email: `g${i}@x.com` })).status, 200);
  }
  const n = app.outbox.length;
  assert.equal((await mum.call("/links/invite-guardian", { profileId: pid, email: "g9@x.com" })).status, 429);
  assert.equal(app.outbox.length, n);
});

test("owner removes guardian; guardian removes self; view_only removes self", async () => {
  const { app, mum, pid } = await guardianSetup();
  await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  const dad = await client(app, "dad@x.com", tokenFrom(app.outbox.at(-1)));
  const dadId = (await app.repo.findAccountByEmail("dad@x.com")).id;
  assert.equal((await mum.call("/links/remove", { profileId: pid, accountId: dadId })).status, 200);
  assert.equal(await app.repo.getAccess(dadId, pid), null);

  await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  await dad.call("/me");
  assert.equal(await app.repo.getAccess(dadId, pid), "guardian");
  await dad.unlock();
  assert.equal((await dad.call("/links/remove", { profileId: pid, accountId: dadId })).status, 200);
  assert.equal(await app.repo.getAccess(dadId, pid), null);

  const { c, pid: spid } = await student(app, "kid@x.com");
  await c.call("/links/share", { profileId: spid, parentEmail: "gran@x.com" });
  const gran = await client(app, "gran@x.com", tokenFrom(app.outbox.at(-1)));
  const granId = (await app.repo.findAccountByEmail("gran@x.com")).id;
  await gran.unlock();
  assert.equal((await gran.call("/links/remove", { profileId: spid, accountId: granId })).status, 200);
  assert.equal(await app.repo.getAccess(granId, spid), null);
});

test("remove: other forbidden cases; locked parent refused", async () => {
  const { app, mum, pid } = await guardianSetup();
  const mumId = (await app.repo.findAccountByEmail("mum@x.com")).id;
  assert.equal((await mum.call("/links/remove", { profileId: pid, accountId: mumId })).status, 403);
  await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  const dad = await client(app, "dad@x.com", tokenFrom(app.outbox.at(-1)));
  await mum.call("/links/invite-guardian", { profileId: pid, email: "nan@x.com" });
  const nan = await client(app, "nan@x.com", tokenFrom(app.outbox.at(-1)));
  const nanId = (await app.repo.findAccountByEmail("nan@x.com")).id;
  await dad.unlock();
  assert.equal((await dad.call("/links/remove", { profileId: pid, accountId: nanId })).status, 403);
  assert.equal((await dad.call("/links/remove", { profileId: pid, accountId: mumId })).status, 403);
  void nan;
  app.clock.t += 20 * 60 * 1000;
  assert.equal((await mum.call("/links/remove", { profileId: pid, accountId: nanId })).body.error, "parent_locked");
  const stranger = await parent(app, "s@x.com");
  assert.equal((await stranger.call("/links/remove", { profileId: pid, accountId: nanId })).status, 404);
});

test("student cannot remove under-13 consent-giver parent → forbidden", async () => {
  const app = makeApp();
  const u = await client(app, "u13@x.com");
  await u.call("/setup", { type: "student", holderOver13: false });
  const made = await u.call("/profiles/create", {
    firstName: "Y", lastName: "Z", level: "CSEC", colour: "#F4C143", over13: false, parentEmail: "mum@x.com",
  });
  const pid = made.body.profile.id;
  const mum = await client(app, "mum@x.com", tokenFrom(app.outbox.at(-1)));
  mum.unlock();
  assert.equal((await mum.call("/consent/respond", { profileId: pid, approve: true })).status, 200);
  const mumId = (await app.repo.findAccountByEmail("mum@x.com")).id;
  const r = await u.call("/links/remove", { profileId: pid, accountId: mumId });
  assert.deepEqual([r.status, r.body], [403, { error: "forbidden" }]);
  const list = await u.call("/links/list", { profileId: pid });
  assert.deepEqual(list.body.people, [
    { accountId: mumId, email: "mum@x.com", kind: "view_only", removable: false },
  ]);
});

test("links/list marks removable correctly and excludes caller", async () => {
  const { app, mum, pid } = await guardianSetup();
  const mumId = (await app.repo.findAccountByEmail("mum@x.com")).id;
  await mum.call("/links/invite-guardian", { profileId: pid, email: "dad@x.com" });
  const dad = await client(app, "dad@x.com", tokenFrom(app.outbox.at(-1)));
  const dadId = (await app.repo.findAccountByEmail("dad@x.com")).id;
  const ml = await mum.call("/links/list", { profileId: pid });
  assert.deepEqual(ml.body.people, [{ accountId: dadId, email: "dad@x.com", kind: "guardian", removable: true }]);
  await dad.unlock();
  const dl = await dad.call("/links/list", { profileId: pid });
  assert.deepEqual(dl.body.people, [{ accountId: mumId, email: "mum@x.com", kind: "owner", removable: false }]);
  const stranger = await parent(app, "s@x.com");
  assert.equal((await stranger.call("/links/list", { profileId: pid })).status, 403);
  app.clock.t += 20 * 60 * 1000;
  assert.equal((await mum.call("/links/list", { profileId: pid })).body.error, "parent_locked");
});

test("invite expires after 30 days", async () => {
  const app = makeApp();
  const { c, pid } = await student(app);
  await c.call("/links/share", { profileId: pid, parentEmail: "mum@x.com" });
  app.clock.t += 31 * DAY;
  const fresh = await client(app, "mum@x.com");
  assert.deepEqual(fresh.me.profiles, []);
  assert.equal(fresh.me.account.type, null);
});
