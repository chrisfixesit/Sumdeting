import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./testkit.mjs";

const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];
const codeFrom = (mail) => /\b(\d{6})\b/.exec(mail.text)[1];

async function signIn(app, email) {
  await app.call("POST", "/signin/start", { email });
  await app.call("POST", "/signin/verify", { token: tokenFrom(app.outbox.at(-1)) });
}

async function setup() {
  const app = makeApp();
  await signIn(app, "p@x.com");
  await app.call("POST", "/setup", { type: "parent" });
  const made = await app.call("POST", "/profiles/create", {
    firstName: "Zed", lastName: "Lee", level: "CSEC", colour: "#F4C143", consent: true,
  });
  const account = await app.repo.findAccountByEmail("p@x.com");
  // Setup leaves the session unlocked; lock it so tests exercise the code flow.
  const sid = Object.values(app.jar)[0];
  await app.repo.setParentUnlocked(sid, 0);
  return { app, pid: made.body.profile.id, accountId: account.id, sid };
}

async function unlock(app) {
  const start = await app.call("POST", "/parent/unlock/start");
  assert.equal(start.status, 200);
  const code = codeFrom(app.outbox.at(-1));
  return app.call("POST", "/parent/unlock/verify", { code });
}

test("overview without unlock -> parent_locked", async () => {
  const { app } = await setup();
  const res = await app.call("POST", "/parent/overview");
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "parent_locked");
});

test("unlock code emailed; verify unlocks; overview lists own and view_only children with summaries", async () => {
  const { app, pid, accountId } = await setup();
  // A second child the parent only has view_only access to, plus an awaiting_parent one.
  const owner = await app.repo.createAccount("kid@x.com");
  const other = await app.repo.createProfile(owner.id, {
    firstName: "Abe", lastName: "Kay", level: "CAPE", colour: "#BFD0FF",
    under13: false, consentStatus: "active",
  });
  await app.repo.grantAccess(accountId, other.id, "view_only", { consentGiver: true });
  const waiting = await app.repo.createProfile(owner.id, {
    firstName: "Wai", lastName: "Ting", level: "CSEC", colour: "#BFD0FF",
    under13: true, consentStatus: "awaiting_parent", parentEmail: "p@x.com",
  });
  await app.repo.grantAccess(accountId, waiting.id, "view_only", { consentGiver: false });
  await app.repo.updateProgress(pid, (p) => ({ ...p }));

  const res = await unlock(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { parentUnlocked: true });
  const ov = await app.call("POST", "/parent/overview");
  assert.equal(ov.status, 200);
  assert.deepEqual(Object.keys(ov.body), ["children"]);
  assert.deepEqual(ov.body.children.map((c) => [c.firstName, c.access]), [
    ["Abe", "view_only"],
    ["Zed", "owner"],
  ]);
  assert.ok(ov.body.children.every((c) => c.summary && typeof c.summary === "object"));
});

test("overview never includes chat or message fields", async () => {
  const { app } = await setup();
  await unlock(app);
  const ov = await app.call("POST", "/parent/overview");
  assert.deepEqual(Object.keys(ov.body.children[0]).sort(), [
    "access", "colour", "firstName", "lastName", "level", "profileId", "summary",
  ]);
});

test("unlock expires after 15 minutes", async () => {
  const { app } = await setup();
  await unlock(app);
  app.clock.t += 14 * 60 * 1000;
  assert.equal((await app.call("POST", "/parent/overview")).status, 200);
  app.clock.t += 2 * 60 * 1000;
  const res = await app.call("POST", "/parent/overview");
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "parent_locked");
});

test("student account cannot use parent endpoints -> forbidden", async () => {
  const app = makeApp();
  await signIn(app, "s@x.com");
  await app.call("POST", "/setup", { type: "student", holderOver13: true });
  for (const path of ["/parent/unlock/start", "/parent/unlock/verify", "/parent/overview"]) {
    const res = await app.call("POST", path, { code: "123456" });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error, "forbidden", path);
  }
});

test("account with no type cannot use parent endpoints", async () => {
  const app = makeApp();
  await signIn(app, "n@x.com");
  const res = await app.call("POST", "/parent/unlock/start");
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});

test("wrong unlock code 5 times -> too_many_attempts", async () => {
  const { app } = await setup();
  await app.call("POST", "/parent/unlock/start");
  const real = codeFrom(app.outbox.at(-1));
  const wrong = real === "000000" ? "111111" : "000000";
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await app.call("POST", "/parent/unlock/verify", { code: wrong })).body.error);
  }
  assert.deepEqual(statuses.slice(0, 4), Array(4).fill("invalid_code"));
  assert.equal(statuses[4], "too_many_attempts");
  const after = await app.call("POST", "/parent/unlock/verify", { code: real });
  assert.notEqual(after.status, 200);
});

test("unlock start is rate limited to 5 per hour", async () => {
  const { app } = await setup();
  for (let i = 0; i < 5; i++) {
    assert.equal((await app.call("POST", "/parent/unlock/start")).status, 200);
  }
  const res = await app.call("POST", "/parent/unlock/start");
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "rate_limited");
});

test("verify with missing code -> bad_request", async () => {
  const { app } = await setup();
  const res = await app.call("POST", "/parent/unlock/verify", {});
  assert.equal(res.status, 400);
});

test("parent/lock ends the unlock window for this session", async () => {
  const { app } = await setup();
  assert.equal((await unlock(app)).status, 200);
  assert.equal((await app.call("POST", "/parent/overview")).status, 200);
  const res = await app.call("POST", "/parent/lock");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { parentUnlocked: false });
  const ov = await app.call("POST", "/parent/overview");
  assert.deepEqual([ov.status, ov.body.error], [403, "parent_locked"]);
  assert.equal((await app.call("POST", "/me")).body.parentUnlocked, false);
});

test("parent/lock right after setup locks the setup window", async () => {
  const app = makeApp();
  await signIn(app, "q@x.com");
  await app.call("POST", "/setup", { type: "parent" });
  assert.equal((await app.call("POST", "/me")).body.parentUnlocked, true);
  assert.equal((await app.call("POST", "/parent/lock")).status, 200);
  assert.equal((await app.call("POST", "/me")).body.parentUnlocked, false);
});

test("parent/lock needs a session and a parent account", async () => {
  const app = makeApp();
  assert.equal((await app.call("POST", "/parent/lock")).status, 401);
  await signIn(app, "s@x.com");
  await app.call("POST", "/setup", { type: "student", holderOver13: true });
  const res = await app.call("POST", "/parent/lock");
  assert.deepEqual([res.status, res.body.error], [403, "forbidden"]);
});
