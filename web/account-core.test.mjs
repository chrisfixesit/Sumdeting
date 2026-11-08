import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createApi, sendKeepalive, createQueue, hasAnonymousProgress, readAnonymous, clearAnonymous,
  clearProfileCaches, statusLabel, initials, parseSigninFragment, newMergeId, clampCount,
  isoDay, lastPractisedText,
} from "./account-core.mjs";

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    has: (k) => m.has(k),
  };
}
const res = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const apiReturning = (r) => async () => r;
const ev = (n) => ({ id: `e${n}`, type: "activity", topic: null, solved: false, d: "2026-11-08" });

test("api sends sha header and same-origin credentials", async () => {
  let seen;
  const api = createApi({
    fetchImpl: async (url, init) => { seen = { url, init }; return res(200, { hi: 1 }); },
    sha256Hex: async (s) => "sha:" + s,
  });
  const out = await api("/me", { a: 1 });
  assert.equal(seen.url, "/api/account/me");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(seen.init.body, '{"a":1}');
  assert.equal(seen.init.headers["x-amz-content-sha256"], 'sha:{"a":1}');
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.deepEqual(out, { ok: true, status: 200, data: { hi: 1 } });
});

test("api never throws on network error or bad json", async () => {
  const bad = createApi({ fetchImpl: async () => { throw new Error("x"); }, sha256Hex: async () => "h" });
  assert.deepEqual(await bad("/me"), { ok: false, status: 0, data: null });
  const nojson = createApi({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error("no"); } }),
    sha256Hex: async () => "h",
  });
  assert.deepEqual(await nojson("/me"), { ok: false, status: 502, data: null });
});

test("queue persists across instances", () => {
  const s = fakeStorage();
  const q = createQueue(s, "p1");
  q.push(ev(1)); q.push(ev(2));
  assert.equal(createQueue(s, "p1").size(), 2);
  assert.equal(createQueue(s, "p2").size(), 0);
  assert.ok(s.has("sumdeting.queue.p1"));
});

test("flush 200 empties queue", async () => {
  const s = fakeStorage();
  const q = createQueue(s, "p1");
  q.push(ev(1));
  let body;
  const api = async (path, b) => { body = { path, b }; return { ok: true, status: 200, data: {} }; };
  assert.equal(await q.flush(api), "ok");
  assert.equal(q.size(), 0);
  assert.equal(body.path, "/progress/sync");
  assert.equal(body.b.profileId, "p1");
  assert.equal(body.b.events.length, 1);
});

test("flush on empty queue sends nothing", async () => {
  const q = createQueue(fakeStorage(), "p1");
  let called = false;
  assert.equal(await q.flush(async () => { called = true; }), "ok");
  assert.equal(called, false);
});

test("401 on sync keeps queue and reports signedOut", async () => {
  const q = createQueue(fakeStorage(), "p1");
  q.push(ev(1));
  assert.equal(await q.flush(async () => ({ ok: false, status: 401, data: { error: "not_signed_in" } })), "signedOut");
  assert.equal(q.size(), 1);
});

test("404 and 403 drop queue and report gone", async () => {
  for (const status of [404, 403]) {
    const s = fakeStorage();
    const q = createQueue(s, "p1");
    q.push(ev(1));
    assert.equal(await q.flush(async () => ({ ok: false, status, data: null })), "gone");
    assert.equal(q.size(), 0);
    assert.equal(createQueue(s, "p1").size(), 0);
  }
});

test("network error, 429 and 5xx report retry and keep queue", async () => {
  for (const status of [0, 429, 500, 503]) {
    const q = createQueue(fakeStorage(), "p1");
    q.push(ev(1));
    assert.equal(await q.flush(async () => ({ ok: false, status, data: null })), "retry");
    assert.equal(q.size(), 1);
  }
});

test("400 drops the sent batch; retry only if items remain", async () => {
  const q = createQueue(fakeStorage(), "p1");
  q.push(ev(1));
  const bad = async () => ({ ok: false, status: 400, data: { error: "bad_request" } });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await q.flush(bad), "ok");
    assert.equal(q.size(), 0);
    for (let i = 0; i < 101; i++) q.push(ev(i));
    assert.equal(await q.flush(bad), "retry");
    assert.equal(q.size(), 1);
  } finally { console.warn = warn; }
});

test("flush sends at most 100 per call", async () => {
  const q = createQueue(fakeStorage(), "p1");
  for (let i = 0; i < 250; i++) q.push(ev(i));
  const sizes = [];
  const api = async (_p, b) => { sizes.push(b.events.length); return { ok: true, status: 200, data: {} }; };
  assert.equal(await q.flush(api), "ok");
  assert.deepEqual(sizes, [100]);
  assert.equal(q.size(), 150);
});

test("queue tolerates corrupt storage", () => {
  const s = fakeStorage({ "sumdeting.queue.p1": "{not json" });
  assert.equal(createQueue(s, "p1").size(), 0);
});

test("hasAnonymousProgress false for empty and true for streak or topics", () => {
  assert.equal(hasAnonymousProgress(fakeStorage()), false);
  assert.equal(hasAnonymousProgress(fakeStorage({ "mathmentor.mastery.v1": "garbage" })), false);
  assert.equal(hasAnonymousProgress(fakeStorage({
    "mathmentor.mastery.v1": JSON.stringify({ topics: { A: { attempted: 0, solved: 0 } }, streak: { count: 0, last: "" } }),
  })), false);
  assert.equal(hasAnonymousProgress(fakeStorage({
    "mathmentor.mastery.v1": JSON.stringify({ topics: { A: { attempted: 1, solved: 0 } }, streak: { count: 0 } }),
  })), true);
  assert.equal(hasAnonymousProgress(fakeStorage({
    "mathmentor.mastery.v1": JSON.stringify({ topics: {}, streak: { count: 2, last: "x" } }),
  })), true);
});

test("readAnonymous and clearAnonymous", () => {
  const s = fakeStorage({
    "mathmentor.mastery.v1": '{"topics":{}}', "mathmentor.prefs.v1": '{"level":"CSEC"}', "mathmentor.session.v1": "x",
  });
  assert.deepEqual(readAnonymous(s), { mastery: { topics: {} }, prefs: { level: "CSEC" } });
  clearAnonymous(s);
  assert.equal(s.has("mathmentor.mastery.v1"), false);
  assert.equal(s.has("mathmentor.prefs.v1"), false);
  assert.equal(s.has("mathmentor.session.v1"), true);
  assert.deepEqual(readAnonymous(s), { mastery: null, prefs: null });
});

test("clearProfileCaches removes profile keys but not mathmentor.mastery.v1", () => {
  const s = fakeStorage({
    "mathmentor.mastery.v1": "a", "mathmentor.prefs.v1": "b",
    "mathmentor.mastery.p1": "c", "mathmentor.prefs.p1": "d", "sumdeting.queue.p1": "e",
    "mathmentor.mastery.p2": "c", "sumdeting.queue.p2": "e",
    "mathmentor.session.v1": "f", "sumdeting.activeProfile": "p1", "other": "keep",
  });
  clearProfileCaches(s);
  assert.deepEqual(
    [...Array(s.length).keys()].map((i) => s.key(i)).sort(),
    ["mathmentor.mastery.v1", "mathmentor.prefs.v1", "other"],
  );
});

test("statusLabel maps all three", () => {
  assert.equal(statusLabel("hard"), "Finding it hard");
  assert.equal(statusLabel("confident"), "Confident");
  assert.equal(statusLabel("getting_there"), "Getting there");
});

test("initials gives two upper-case letters", () => {
  assert.equal(initials("ada", "lovelace"), "AL");
  assert.equal(initials("", ""), "");
  assert.equal(initials("zed"), "Z");
});

test("parseSigninFragment reads token and ignores other hashes", () => {
  assert.equal(parseSigninFragment("#signin=abc123"), "abc123");
  assert.equal(parseSigninFragment("#signin="), null);
  assert.equal(parseSigninFragment("#other=abc"), null);
  assert.equal(parseSigninFragment(""), null);
  assert.equal(parseSigninFragment(undefined), null);
});

test("newMergeId returns distinct uuids", () => {
  assert.match(newMergeId(), /^[0-9a-f-]{36}$/);
  assert.notEqual(newMergeId(), newMergeId());
});

test("clampCount caps at 99 and floors at 0", () => {
  assert.equal(clampCount(150), 99);
  assert.equal(clampCount(3), 3);
  assert.equal(clampCount(-2), 0);
  assert.equal(clampCount(NaN), 0);
  assert.equal(clampCount(2.9), 2);
});

test("isoDay gives the UTC day, optionally days earlier", () => {
  const now = Date.parse("2026-03-01T01:00:00Z");
  assert.equal(isoDay(0, now), "2026-03-01");
  assert.equal(isoDay(1, now), "2026-02-28");
});

test("lastPractisedText: today, yesterday, a date, and invalid values", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(lastPractisedText("2026-11-08", now), "last practised today");
  assert.equal(lastPractisedText("2026-11-07", now), "last practised yesterday");
  const older = lastPractisedText("2026-10-03", now);
  assert.match(older, /^last practised /);
  assert.match(older, /2026/);
  assert.match(older, /3/);
  assert.doesNotMatch(older, /today|yesterday/);
  for (const bad of [null, undefined, "", "yesterday", "2026-1-3", 20261108, {}]) {
    assert.equal(lastPractisedText(bad, now), "not practised yet");
  }
});

test("sendKeepalive starts a keepalive JSON POST synchronously and never throws", () => {
  const calls = [];
  const ok = sendKeepalive({
    fetchImpl: (url, opts) => { calls.push([url, opts]); return Promise.reject(new Error("offline")); },
    path: "/parent/lock", payload: "{}", sha: "abc",
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const [url, opts] = calls[0];
  assert.equal(url, "/api/account/parent/lock");
  assert.equal(opts.method, "POST");
  assert.equal(opts.keepalive, true);
  assert.equal(opts.credentials, "same-origin");
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.equal(opts.headers["x-amz-content-sha256"], "abc");
  assert.equal(opts.body, "{}");
  assert.equal(sendKeepalive({ fetchImpl: () => { throw new Error("x"); }, path: "/p", payload: "{}", sha: "h" }), false);
});
