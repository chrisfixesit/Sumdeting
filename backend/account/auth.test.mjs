import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { makeApp } from "./testkit.mjs";
import { makeHandler } from "./index.mjs";
import { createAppServer } from "../../server.mjs";

const DAY = 24 * 3600 * 1000;
const tokenFrom = (mail) => /#signin=([\w-]+)/.exec(mail.text)[1];
const codeFrom = (mail) => /\b(\d{6})\b/.exec(mail.text)[1];

async function start(app, email = "a@x.com") {
  const res = await app.call("POST", "/signin/start", { email });
  assert.equal(res.status, 200);
  return app.outbox.at(-1);
}

test("signin/start returns 200 for unknown and known emails alike", async () => {
  const app = makeApp();
  const a = await app.call("POST", "/signin/start", { email: "new@x.com" });
  await app.repo.createAccount("known@x.com");
  const b = await app.call("POST", "/signin/start", { email: "known@x.com" });
  assert.deepEqual([a.status, a.body], [200, {}]);
  assert.deepEqual([b.status, b.body], [200, {}]);
  assert.equal((await app.repo.listAccounts()).length, 1);
});

test("signin/start with an invalid email is 400 bad_request", async () => {
  const app = makeApp();
  const res = await app.call("POST", "/signin/start", { email: "nope" });
  assert.deepEqual([res.status, res.body], [400, { error: "bad_request" }]);
});

test("signin/start sends a signin email with fragment link and code", async () => {
  const app = makeApp();
  const mail = await start(app);
  assert.equal(mail.kind, "signin");
  assert.equal(mail.to, "a@x.com");
  assert.match(mail.text, /https:\/\/sumdeting\.test\/#signin=[\w-]+/);
  assert.match(codeFrom(mail), /^\d{6}$/);
});

test("verify with token sets session cookie and returns me", async () => {
  const app = makeApp();
  const mail = await start(app);
  const res = await app.call("POST", "/signin/verify", { token: tokenFrom(mail) });
  assert.equal(res.status, 200);
  assert.equal(res.body.signedIn, true);
  assert.equal(res.body.account.email, "a@x.com");
  assert.deepEqual(res.body.profiles, []);
  assert.deepEqual(res.body.pendingRequests, []);
  assert.deepEqual(res.body.pendingConsents, []);
  assert.equal(res.body.parentUnlocked, false);
  const cookie = res.setCookies[0];
  assert.match(cookie, /^sd_session=[\w-]+; HttpOnly; Secure; SameSite=Lax; Path=\/api\/account; Max-Age=7776000$/);
  const me = await app.call("POST", "/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.account.email, "a@x.com");
});

test("verify with email+code works; wrong code is invalid_code; 5th wrong try is too_many_attempts and burns the code", async () => {
  const app = makeApp();
  const mail = await start(app);
  const code = codeFrom(mail);
  const ok = await app.call("POST", "/signin/verify", { email: "A@X.com", code });
  assert.equal(ok.status, 200);

  const app2 = makeApp();
  const mail2 = await start(app2);
  const wrong = codeFrom(mail2) === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) {
    const r = await app2.call("POST", "/signin/verify", { email: "a@x.com", code: wrong });
    assert.deepEqual([r.status, r.body], [400, { error: "invalid_code" }]);
  }
  const fifth = await app2.call("POST", "/signin/verify", { email: "a@x.com", code: wrong });
  assert.deepEqual([fifth.status, fifth.body], [429, { error: "too_many_attempts" }]);
  const after = await app2.call("POST", "/signin/verify", { email: "a@x.com", code: codeFrom(mail2) });
  assert.equal(after.status, 400);
});

test("verify with neither token nor email+code is bad_request", async () => {
  const app = makeApp();
  const res = await app.call("POST", "/signin/verify", {});
  assert.deepEqual([res.status, res.body], [400, { error: "bad_request" }]);
});

test("older link still valid, older code rejected", async () => {
  const app = makeApp();
  const first = await start(app);
  const second = await start(app);
  const badCode = await app.call("POST", "/signin/verify", { email: "a@x.com", code: codeFrom(first) });
  if (codeFrom(first) !== codeFrom(second)) {
    assert.deepEqual([badCode.status, badCode.body], [400, { error: "invalid_code" }]);
  }
  const res = await app.call("POST", "/signin/verify", { token: tokenFrom(first) });
  assert.equal(res.status, 200);
});

test("token cannot be used twice", async () => {
  const app = makeApp();
  const mail = await start(app);
  const t = tokenFrom(mail);
  assert.equal((await app.call("POST", "/signin/verify", { token: t })).status, 200);
  const again = await app.call("POST", "/signin/verify", { token: t });
  assert.deepEqual([again.status, again.body], [400, { error: "invalid_code" }]);
});

test("token expires after 15 minutes", async () => {
  const app = makeApp();
  const mail = await start(app);
  app.clock.t += 15 * 60 * 1000 + 1000;
  const res = await app.call("POST", "/signin/verify", { token: tokenFrom(mail) });
  assert.deepEqual([res.status, res.body], [400, { error: "invalid_code" }]);
});

test("signin with differently-cased email reaches same account", async () => {
  const app = makeApp();
  const m1 = await start(app, "Kid@Example.com");
  const r1 = await app.call("POST", "/signin/verify", { token: tokenFrom(m1) });
  await app.call("POST", "/signout");
  const m2 = await start(app, " kid@example.COM ");
  const r2 = await app.call("POST", "/signin/verify", { token: tokenFrom(m2) });
  assert.equal(r1.body.account.email, "kid@example.com");
  assert.equal((await app.repo.listAccounts()).length, 1);
  assert.equal(r2.body.account.email, "kid@example.com");
});

test("signin/start rate-limits at 6th request per email per hour", async () => {
  const app = makeApp();
  for (let i = 0; i < 5; i++) assert.equal((await app.call("POST", "/signin/start", { email: "a@x.com" })).status, 200);
  const res = await app.call("POST", "/signin/start", { email: "a@x.com" });
  assert.deepEqual([res.status, res.body], [429, { error: "rate_limited" }]);
  assert.equal(app.outbox.length, 5);
});

test("signin/start rate-limits per IP at 30 per hour", async () => {
  const app = makeApp();
  for (let i = 0; i < 30; i++) {
    assert.equal((await app.call("POST", "/signin/start", { email: `u${i}@x.com` }, { ip: "9.9.9.9" })).status, 200);
  }
  const res = await app.call("POST", "/signin/start", { email: "u99@x.com" }, { ip: "9.9.9.9" });
  assert.equal(res.status, 429);
});

test("me without cookie is 401 not_signed_in", async () => {
  const app = makeApp();
  const res = await app.call("POST", "/me");
  assert.deepEqual([res.status, res.body], [401, { error: "not_signed_in" }]);
});

test("signout clears session", async () => {
  const app = makeApp();
  const mail = await start(app);
  await app.call("POST", "/signin/verify", { token: tokenFrom(mail) });
  const sid = app.jar.sd_session;
  const out = await app.call("POST", "/signout");
  assert.equal(out.status, 200);
  assert.match(out.setCookies[0], /Max-Age=0/);
  assert.equal(await app.repo.getSession(sid), null);
  const me = await app.call("POST", "/me", {}, { cookie: { sd_session: sid } });
  assert.equal(me.status, 401);
});

test("session whose account is gone is 401 and clears cookie", async () => {
  const app = makeApp();
  const session = await app.repo.createSession("missing-account");
  const me = await app.call("POST", "/me", {}, { cookie: { sd_session: session.id } });
  assert.equal(me.status, 401);
  assert.match(me.setCookies[0], /Max-Age=0/);
});

test("session renews when fewer than 60 days remain", async () => {
  const app = makeApp();
  const mail = await start(app);
  await app.call("POST", "/signin/verify", { token: tokenFrom(mail) });
  const sid = app.jar.sd_session;
  app.clock.t += 20 * DAY; // 70 days left: no renewal
  const early = await app.call("POST", "/me");
  assert.equal(early.setCookies, undefined);
  app.clock.t += 20 * DAY; // 50 days left: renew
  const late = await app.call("POST", "/me");
  assert.match(late.setCookies[0], /^sd_session=/);
  const s = await app.repo.getSession(sid);
  assert.equal(s.expiresAt, app.clock.t + 90 * DAY);
});

test("onSignIn hooks run after verify with ctx and account", async () => {
  const app = makeApp();
  const seen = [];
  app.router.onSignIn((ctx, account) => seen.push(account.email));
  const mail = await start(app);
  await app.call("POST", "/signin/verify", { token: tokenFrom(mail) });
  assert.deepEqual(seen, ["a@x.com"]);
});

test("unknown route and method mismatch are 404 not_found", async () => {
  const app = makeApp();
  const a = await app.call("POST", "/nope");
  const b = await app.call("GET", "/me");
  assert.deepEqual([a.status, a.body], [404, { error: "not_found" }]);
  assert.equal(b.status, 404);
});

test("dev outbox route absent unless deps.dev", async () => {
  const off = makeApp();
  await start(off);
  assert.equal((await off.call("GET", "/_dev/outbox")).status, 404);
  const on = makeApp({ dev: true });
  await start(on);
  const res = await on.call("GET", "/_dev/outbox");
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test("lambda adapter maps rawPath, cookies and viewer address", async () => {
  const app = makeApp();
  const mail = await start(app);
  const handler = makeHandler(() => app.router);
  const event = (path, body, extra = {}) => ({
    rawPath: `/api/account${path}`,
    headers: { "cloudfront-viewer-address": "2001:db8::1:54321" },
    requestContext: { http: { method: "POST", sourceIp: "10.0.0.1" } },
    cookies: [],
    body: JSON.stringify(body),
    ...extra,
  });
  const res = await handler(event("/signin/verify", { token: tokenFrom(mail) }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.cookies.length, 1);
  assert.equal(JSON.parse(res.body).account.email, "a@x.com");
  const sid = /sd_session=([^;]+)/.exec(res.cookies[0])[1];
  const me = await handler(event("/me", {}, { cookies: [`sd_session=${sid}`, "other=1"] }));
  assert.equal(me.statusCode, 200);

  let seen;
  const spy = makeHandler(() => async (req) => { seen = req; return { status: 200, body: {} }; });
  await spy(event("/x", {}));
  assert.equal(seen.ip, "2001:db8::1");
  assert.equal(seen.path, "/x");
  await spy(event("/x", {}, { headers: {} }));
  assert.equal(seen.ip, "10.0.0.1");
  const bad = await spy(event("/x", {}, { body: "{nope" }));
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(JSON.parse(bad.body), { error: "bad_request" });
});

test("GET with a signin fragment has no side effects", async () => {
  const app = makeApp();
  const mail = await start(app);
  const server = createAppServer({ accountRouter: app.router });
  server.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/#signin=${tokenFrom(mail)}`);
    assert.equal(res.status, 200);
    const api = await fetch(`http://127.0.0.1:${port}/api/account/me`, { method: "POST" });
    assert.equal(api.status, 401);
    assert.equal(api.headers.get("cache-control"), "no-store");
    assert.equal((await app.repo.listAccounts()).length, 0);
    assert.notEqual(await app.repo.consumeToken(tokenFrom(mail), "signin"), null);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
