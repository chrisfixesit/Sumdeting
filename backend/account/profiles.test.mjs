import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";
import { LEVELS, COLOURS } from "./profiles.mjs";

const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];
const MIN = 60 * 1000;

async function signIn(app, email) {
  await app.call("POST", "/signin/start", { email });
  const res = await app.call("POST", "/signin/verify", { token: tokenFrom(app.outbox.at(-1)) });
  assert.equal(res.status, 200);
  return res;
}

const child = (over = {}) => ({
  firstName: "Ann",
  lastName: "Lee",
  level: "CSEC",
  colour: "#F4C143",
  consent: true,
  ...over,
});

async function parentApp(email = "p@x.com") {
  const app = makeApp();
  await signIn(app, email);
  const s = await app.call("POST", "/setup", { type: "parent" });
  assert.equal(s.status, 200);
  return app;
}

// Under-13 student signs up; returns app, the awaiting profile id and the emailed token.
async function under13(app, parentEmail = "mum@x.com", email = "kid@x.com") {
  await signIn(app, email);
  await app.call("POST", "/setup", { type: "student", holderOver13: false });
  const res = await app.call("POST", "/profiles/create", child({ over13: false, parentEmail, consent: undefined }));
  return res;
}

test("exports the allowed levels and colours", () => {
  assert.deepEqual(LEVELS, ["Common Entrance", "CSEC", "Additional Maths", "CAPE"]);
  assert.deepEqual(COLOURS, ["#F4C143", "#BFD0FF", "#C8E6C9", "#F8C9B8", "#E1C6F2", "#FFE0A3"]);
});

test("setup parent grants 15-minute unlock; setup twice -> 400", async () => {
  const app = makeApp();
  await signIn(app, "p@x.com");
  const res = await app.call("POST", "/setup", { type: "parent" });
  assert.equal(res.status, 200);
  const me = await app.call("POST", "/me");
  assert.equal(me.body.account.type, "parent");
  assert.equal(me.body.parentUnlocked, true);
  app.clock.t += 14 * MIN;
  assert.equal((await app.call("POST", "/me")).body.parentUnlocked, true);
  app.clock.t += 2 * MIN;
  assert.equal((await app.call("POST", "/me")).body.parentUnlocked, false);
  const again = await app.call("POST", "/setup", { type: "parent" });
  assert.deepEqual([again.status, again.body], [400, { error: "bad_request" }]);
});

test("setup validates type and holderOver13 and needs a session", async () => {
  const app = makeApp();
  assert.equal((await app.call("POST", "/setup", { type: "parent" })).status, 401);
  await signIn(app, "s@x.com");
  assert.equal((await app.call("POST", "/setup", { type: "teacher" })).status, 400);
  assert.equal((await app.call("POST", "/setup", { type: "student" })).status, 400);
  assert.equal((await app.call("POST", "/setup", { type: "student", holderOver13: "yes" })).status, 400);
  const ok = await app.call("POST", "/setup", { type: "student", holderOver13: true });
  assert.equal(ok.status, 200);
  const acct = await app.repo.findAccountByEmail("s@x.com");
  assert.equal(acct.holderOver13, true);
  assert.equal(acct.type, "student");
});

test("parent creates child with consent; without consent -> 400", async () => {
  const app = await parentApp();
  const bad = await app.call("POST", "/profiles/create", child({ consent: false }));
  assert.deepEqual([bad.status, bad.body], [400, { error: "bad_request" }]);
  const missing = await app.call("POST", "/profiles/create", child({ consent: undefined }));
  assert.equal(missing.status, 400);
  const ok = await app.call("POST", "/profiles/create", child());
  assert.equal(ok.status, 200);
  const p = await app.repo.getProfile(ok.body.profile.id);
  const acct = await app.repo.findAccountByEmail("p@x.com");
  assert.equal(p.consentStatus, "active");
  assert.equal(p.under13, null);
  assert.equal(p.consentBy, acct.id);
  assert.equal(acct.setupComplete, true);
  assert.equal(await app.repo.getAccess(acct.id, p.id), "owner");
});

test("parent create after unlock window -> parent_locked", async () => {
  const app = await parentApp();
  app.clock.t += 16 * MIN;
  const res = await app.call("POST", "/profiles/create", child());
  assert.deepEqual([res.status, res.body], [403, { error: "parent_locked" }]);
});

test("student 13+ creates own profile active", async () => {
  const app = makeApp();
  await signIn(app, "s@x.com");
  await app.call("POST", "/setup", { type: "student", holderOver13: true });
  const noConsent = await app.call("POST", "/profiles/create", child({ over13: true, consent: false }));
  assert.equal(noConsent.status, 400);
  const res = await app.call("POST", "/profiles/create", child({ over13: true }));
  assert.equal(res.status, 200);
  const p = await app.repo.getProfile(res.body.profile.id);
  assert.equal(p.consentStatus, "active");
  assert.equal(p.under13, false);
  assert.equal((await app.repo.findAccountByEmail("s@x.com")).setupComplete, true);
});

test("under-13 student creates awaiting_parent profile and parent gets consent_request", async () => {
  const app = makeApp();
  const res = await under13(app, "Mum@X.com");
  assert.equal(res.status, 200);
  const p = await app.repo.getProfile(res.body.profile.id);
  assert.equal(p.consentStatus, "awaiting_parent");
  assert.equal(p.under13, true);
  assert.equal(p.parentEmail, "mum@x.com");
  const mail = app.outbox.at(-1);
  assert.equal(mail.kind, "consent_request");
  assert.equal(mail.to, "mum@x.com");
  const invites = await app.repo.listInvitesForEmail("mum@x.com");
  assert.equal(invites.length, 1);
  assert.equal(invites[0].kind, "consent");
  assert.deepEqual(invites[0].profileIds, [p.id]);
  assert.equal((await app.repo.findAccountByEmail("kid@x.com")).setupComplete, true);
});

test("under-13 with parentEmail equal to own email, missing or invalid -> 400", async () => {
  const app = makeApp();
  await signIn(app, "kid@x.com");
  await app.call("POST", "/setup", { type: "student", holderOver13: false });
  for (const parentEmail of ["KID@x.com", undefined, "nope"]) {
    const res = await app.call("POST", "/profiles/create", child({ over13: false, parentEmail }));
    assert.deepEqual([res.status, res.body], [400, { error: "bad_request" }]);
  }
});

test("parentEmail of a student account -> parent_email_is_student", async () => {
  const app = makeApp();
  await app.repo.updateAccount((await app.repo.createAccount("other@x.com")).id, { type: "student" });
  const res = await under13(app, "other@x.com");
  assert.deepEqual([res.status, res.body], [400, { error: "parent_email_is_student" }]);
});

test("under-13 holder cannot add a sibling -> forbidden", async () => {
  const app = makeApp();
  await under13(app);
  const res = await app.call("POST", "/profiles/create", child({ firstName: "Bo", over13: false, parentEmail: "mum@x.com" }));
  assert.deepEqual([res.status, res.body], [403, { error: "forbidden" }]);
  const res2 = await app.call("POST", "/profiles/create", child({ over13: true }));
  assert.equal(res2.status, 403);
});

test("profile create before setup is forbidden", async () => {
  const app = makeApp();
  await signIn(app, "x@x.com");
  const res = await app.call("POST", "/profiles/create", child());
  assert.equal(res.status, 403);
});

test("invalid level or colour -> 400", async () => {
  const app = await parentApp();
  assert.equal((await app.call("POST", "/profiles/create", child({ level: "Grade 5" }))).status, 400);
  assert.equal((await app.call("POST", "/profiles/create", child({ colour: "#000000" }))).status, 400);
  for (const level of LEVELS) {
    assert.equal((await app.call("POST", "/profiles/create", child({ level }))).status, 200);
  }
});

test("names trimmed and length-checked", async () => {
  const app = await parentApp();
  const ok = await app.call("POST", "/profiles/create", child({ firstName: "  Ann  ", lastName: " Lee " }));
  assert.equal(ok.status, 200);
  const p = await app.repo.getProfile(ok.body.profile.id);
  assert.deepEqual([p.firstName, p.lastName], ["Ann", "Lee"]);
  for (const bad of ["", "   ", "x".repeat(41), "a\nb", "a\u0000b", 5, undefined]) {
    assert.equal((await app.call("POST", "/profiles/create", child({ firstName: bad }))).status, 400, String(bad));
    assert.equal((await app.call("POST", "/profiles/create", child({ lastName: bad }))).status, 400, String(bad));
  }
  assert.equal((await app.call("POST", "/profiles/create", child({ firstName: "x".repeat(40) }))).status, 200);
});

test("profiles/update: owner updates; parent must be unlocked; strangers forbidden", async () => {
  const app = await parentApp();
  const { body } = await app.call("POST", "/profiles/create", child());
  const id = body.profile.id;
  const ok = await app.call("POST", "/profiles/update", { profileId: id, firstName: " Zed ", level: "CAPE" });
  assert.equal(ok.status, 200);
  const p = await app.repo.getProfile(id);
  assert.deepEqual([p.firstName, p.level, p.lastName], ["Zed", "CAPE", "Lee"]);
  assert.equal((await app.call("POST", "/profiles/update", { profileId: id, colour: "nope" })).status, 400);
  assert.equal((await app.call("POST", "/profiles/update", { profileId: "missing", firstName: "A" })).status, 403);
  app.clock.t += 16 * MIN;
  const locked = await app.call("POST", "/profiles/update", { profileId: id, firstName: "Q" });
  assert.deepEqual([locked.status, locked.body], [403, { error: "parent_locked" }]);
  // stranger
  const other = makeApp();
  await signIn(other, "o@x.com");
  await other.call("POST", "/setup", { type: "student", holderOver13: true });
  const mine = await other.call("POST", "/profiles/create", child({ over13: true }));
  const stranger = await app.repo.createAccount("z@x.com");
  const s = await app.repo.createSession(stranger.id);
  const res = await app.call("POST", "/profiles/update", { profileId: id, firstName: "Hax" }, { cookie: { sd_session: s.id } });
  assert.equal(res.status, 403);
  assert.ok(mine.body.profile.id);
});

test("parent signs in from consent email and sees pendingConsents", async () => {
  const app = makeApp();
  const created = await under13(app, "mum@x.com");
  const mail = app.outbox.at(-1);
  app.clock.t += 6 * 24 * 3600 * 1000; // still valid inside 7 days
  const parent = await app.call(
    "POST",
    "/signin/verify",
    { token: tokenFrom(mail) },
    { cookie: {} }
  );
  assert.equal(parent.status, 200);
  assert.deepEqual(parent.body.pendingConsents, [
    { profileId: created.body.profile.id, firstName: "Ann", lastName: "Lee" },
  ]);
});

async function consentFlow() {
  const app = makeApp();
  const created = await under13(app, "mum@x.com");
  const profileId = created.body.profile.id;
  const mail = app.outbox.at(-1);
  const parent = await app.call("POST", "/signin/verify", { token: tokenFrom(mail) }, { cookie: {} });
  const cookie = { sd_session: /sd_session=([\w-]+)/.exec(parent.setCookies[0])[1] };
  return { app, profileId, cookie };
}

test("approve activates profile, makes caller a parent with view_only consentGiver access", async () => {
  const { app, profileId, cookie } = await consentFlow();
  const res = await app.call("POST", "/consent/respond", { profileId, approve: true }, { cookie });
  assert.equal(res.status, 200);
  const p = await app.repo.getProfile(profileId);
  const mum = await app.repo.findAccountByEmail("mum@x.com");
  assert.equal(p.consentStatus, "active");
  assert.equal(p.consentBy, mum.id);
  assert.equal(p.consentAt, app.clock.t);
  assert.equal(mum.type, "parent");
  assert.equal(mum.setupComplete, true);
  assert.equal(await app.repo.getAccess(mum.id, profileId), "view_only");
  const grants = await app.repo.listAccessForAccount(mum.id);
  assert.equal(grants[0].consentGiver, true);
  assert.deepEqual(await app.repo.listInvitesForEmail("mum@x.com"), []);
  const me = await app.call("POST", "/me", {}, { cookie });
  assert.deepEqual(me.body.pendingConsents, []);
  assert.equal(me.body.profiles[0].access, "view_only");
  // second response is forbidden (invite gone)
  assert.equal((await app.call("POST", "/consent/respond", { profileId, approve: true }, { cookie })).status, 403);
});

test("approve keeps an existing account type", async () => {
  const app = makeApp();
  await app.repo.updateAccount((await app.repo.createAccount("mum@x.com")).id, { type: "parent", setupComplete: true });
  const created = await under13(app, "mum@x.com");
  const parent = await app.call("POST", "/signin/verify", { token: tokenFrom(app.outbox.at(-1)) }, { cookie: {} });
  const cookie = { sd_session: /sd_session=([\w-]+)/.exec(parent.setCookies[0])[1] };
  await app.call("POST", "/consent/respond", { profileId: created.body.profile.id, approve: true }, { cookie });
  assert.equal((await app.repo.findAccountByEmail("mum@x.com")).type, "parent");
});

test("decline deletes profile and the now-empty student account", async () => {
  const { app, profileId, cookie } = await consentFlow();
  const res = await app.call("POST", "/consent/respond", { profileId, approve: false }, { cookie });
  assert.equal(res.status, 200);
  assert.equal(await app.repo.getProfile(profileId), null);
  assert.deepEqual(await app.repo.listInvitesForEmail("mum@x.com"), []);
  assert.equal(await app.repo.findAccountByEmail("kid@x.com"), null);
});

test("decline keeps a student account that still has profiles", async () => {
  const app = makeApp();
  await signIn(app, "s@x.com");
  await app.call("POST", "/setup", { type: "student", holderOver13: true });
  await app.call("POST", "/profiles/create", child({ over13: true }));
  const acct = await app.repo.findAccountByEmail("s@x.com");
  const p = await app.repo.createProfile(acct.id, { firstName: "A", lastName: "B", level: "CSEC", colour: "#F4C143", consentStatus: "awaiting_parent", parentEmail: "m@x.com" });
  await app.repo.createInvite({ kind: "consent", fromAccountId: acct.id, toEmail: "m@x.com", profileIds: [p.id] });
  await signIn(app, "m@x.com");
  await app.call("POST", "/consent/respond", { profileId: p.id, approve: false });
  assert.ok(await app.repo.findAccountByEmail("s@x.com"));
});

test("consent/respond by an unrelated account -> forbidden", async () => {
  const { app, profileId } = await consentFlow();
  const other = await app.repo.createAccount("evil@x.com");
  const s = await app.repo.createSession(other.id);
  const cookie = { sd_session: s.id };
  const res = await app.call("POST", "/consent/respond", { profileId, approve: true }, { cookie });
  assert.deepEqual([res.status, res.body], [403, { error: "forbidden" }]);
  // invite for the right email but profile.parentEmail differs
  await app.repo.updateProfile(profileId, { parentEmail: "someone@x.com" });
  const parent = await app.call("POST", "/signin/verify", { token: await app.repo.issueToken("signin", "mum@x.com", 60) }, { cookie: {} });
  const pc = { sd_session: /sd_session=([\w-]+)/.exec(parent.setCookies[0])[1] };
  assert.equal((await app.call("POST", "/consent/respond", { profileId, approve: true }, { cookie: pc })).status, 403);
  assert.equal((await app.call("POST", "/consent/respond", { profileId, approve: "yes" }, { cookie: pc })).status, 400);
});

test("consent/resend: owner only, awaiting_parent only, rate limited 5/hour, new token", async () => {
  const app = makeApp();
  const created = await under13(app, "mum@x.com");
  const profileId = created.body.profile.id;
  const before = app.outbox.length;
  for (let i = 0; i < 5; i++) {
    const r = await app.call("POST", "/consent/resend", { profileId });
    assert.equal(r.status, 200);
  }
  assert.equal(app.outbox.length, before + 5);
  assert.equal(app.outbox.at(-1).kind, "consent_request");
  assert.notEqual(tokenFrom(app.outbox.at(-1)), tokenFrom(app.outbox.at(-2)));
  const limited = await app.call("POST", "/consent/resend", { profileId });
  assert.deepEqual([limited.status, limited.body], [429, { error: "rate_limited" }]);
  // someone else cannot resend
  const other = await app.repo.createAccount("evil@x.com");
  const s = await app.repo.createSession(other.id);
  assert.equal((await app.call("POST", "/consent/resend", { profileId }, { cookie: { sd_session: s.id } })).status, 403);
  // active profile cannot be resent
  await app.repo.updateProfile(profileId, { consentStatus: "active" });
  app.clock.t += 2 * 3600 * 1000;
  assert.equal((await app.call("POST", "/consent/resend", { profileId })).status, 403);
});

test("consent token in the email is valid for 7 days", async () => {
  const app = makeApp();
  await under13(app, "mum@x.com");
  const mail = app.outbox.at(-1);
  app.clock.t += 7 * 24 * 3600 * 1000 + 1000;
  const res = await app.call("POST", "/signin/verify", { token: tokenFrom(mail) }, { cookie: {} });
  assert.equal(res.status, 400);
});
