import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyProgress,
  applyEvents,
  mergeProgress,
  topicStatus,
  childSummary,
} from "./progress.mjs";

const act = (id, d, topic = "Fractions", solved = true) => ({ id, type: "activity", topic, solved, d });
const out = (id, d, ok = true, hints = 0, turns = 2, topic = "Fractions") => ({
  id, type: "outcome", topic, ok, hints, turns, d,
});
const h = (ok = 1, hints = 0, turns = 2, d = "2026-01-01") => ({ d, ok, hints, turns });

test("activity on consecutive days grows streak, gap resets to 1", () => {
  let p = applyEvents(emptyProgress(), [act("a", "2026-03-01")]);
  assert.deepEqual(p.streak, { count: 1, last: "2026-03-01" });
  p = applyEvents(p, [act("b", "2026-03-01")]);
  assert.equal(p.streak.count, 1);
  p = applyEvents(p, [act("c", "2026-03-02")]);
  assert.deepEqual(p.streak, { count: 2, last: "2026-03-02" });
  p = applyEvents(p, [act("d", "2026-03-05")]);
  assert.deepEqual(p.streak, { count: 1, last: "2026-03-05" });
});

test("streak crosses month boundary and ignores out-of-order dates", () => {
  let p = applyEvents(emptyProgress(), [act("a", "2026-02-28"), act("b", "2026-03-01")]);
  assert.equal(p.streak.count, 2);
  p = applyEvents(p, [act("c", "2026-02-20")]);
  assert.deepEqual(p.streak, { count: 2, last: "2026-03-01" });
});

test("activity solved increments solved and days[d]", () => {
  const p = applyEvents(emptyProgress(), [act("a", "2026-03-01")]);
  assert.equal(p.topics.Fractions.solved, 1);
  assert.equal(p.topics.Fractions.attempted, 0);
  assert.equal(p.days["2026-03-01"], 1);
});

test("activity unsolved increments attempted only", () => {
  const p = applyEvents(emptyProgress(), [act("a", "2026-03-01", "Fractions", false)]);
  assert.equal(p.topics.Fractions.attempted, 1);
  assert.equal(p.topics.Fractions.solved, 0);
  assert.deepEqual(p.days, {});
});

test("activity without topic only bumps streak", () => {
  const p = applyEvents(emptyProgress(), [act("a", "2026-03-01", null, true)]);
  assert.deepEqual(p.topics, {});
  assert.deepEqual(p.days, {});
  assert.equal(p.streak.count, 1);
});

test("outcome caps hist at 15", () => {
  const events = Array.from({ length: 20 }, (_, i) => out(`o${i}`, "2026-03-01", true, 0, i));
  const p = applyEvents(emptyProgress(), events);
  assert.equal(p.topics.Fractions.hist.length, 15);
  assert.equal(p.topics.Fractions.hist[0].turns, 5);
  assert.equal(p.topics.Fractions.hist[14].turns, 19);
  assert.equal(p.topics.Fractions.hist[0].ok, 1);
});

test("prefs event replaces prefs", () => {
  const p = applyEvents(emptyProgress(), [
    { id: "p1", type: "prefs", level: "CSEC", topic: "Algebra", duration: 30 },
  ]);
  assert.deepEqual(p.prefs, { level: "CSEC", topic: "Algebra", duration: 30 });
});

test("duplicate event id is applied once, and input is not mutated", () => {
  const base = emptyProgress();
  const p = applyEvents(base, [act("a", "2026-03-01"), act("a", "2026-03-01")]);
  assert.equal(p.topics.Fractions.solved, 1);
  const p2 = applyEvents(p, [act("a", "2026-03-01")]);
  assert.equal(p2.topics.Fractions.solved, 1);
  assert.deepEqual(base, emptyProgress());
});

test("appliedEventIds keeps last 200", () => {
  const events = Array.from({ length: 250 }, (_, i) => act(`e${i}`, "2026-03-01"));
  const p = applyEvents(emptyProgress(), events);
  assert.equal(p.appliedEventIds.length, 200);
  assert.equal(p.appliedEventIds[0], "e50");
  assert.equal(p.appliedEventIds[199], "e249");
});

test("merge sums counts, interleaves hist by date capped at 15, keeps longer streak, sums days", () => {
  const server = emptyProgress();
  server.topics.Fractions = {
    attempted: 2, solved: 3,
    hist: Array.from({ length: 10 }, (_, i) => h(1, 0, 2, `2026-01-${String(2 * i + 1).padStart(2, "0")}`)),
  };
  server.streak = { count: 3, last: "2026-02-01" };
  server.days = { "2026-02-01": 2 };
  const local = {
    mastery: {
      topics: {
        Fractions: {
          attempted: 1, solved: 4,
          hist: Array.from({ length: 10 }, (_, i) => h(0, 1, 6, `2026-01-${String(2 * i + 2).padStart(2, "0")}`)),
        },
        Algebra: { attempted: 1, solved: 0 },
      },
      streak: { count: 5, last: "2026-02-03" },
      days: { "2026-02-01": 1, "2026-02-03": 4 },
    },
    prefs: null,
  };
  const m = mergeProgress(server, local);
  assert.equal(m.topics.Fractions.attempted, 3);
  assert.equal(m.topics.Fractions.solved, 7);
  assert.equal(m.topics.Fractions.hist.length, 15);
  const ds = m.topics.Fractions.hist.map((e) => e.d);
  assert.deepEqual(ds, [...ds].sort());
  assert.equal(ds[14], "2026-01-20");
  assert.deepEqual(m.topics.Algebra, { attempted: 1, solved: 0, hist: [] });
  assert.deepEqual(m.streak, { count: 5, last: "2026-02-03" });
  assert.deepEqual(m.days, { "2026-02-01": 3, "2026-02-03": 4 });
});

test("merge keeps server prefs when set, uses local when server null", () => {
  const sp = { level: "CSEC", topic: "A", duration: 10 };
  const lp = { level: "CAPE", topic: "B", duration: 20 };
  const s = { ...emptyProgress(), prefs: sp };
  assert.deepEqual(mergeProgress(s, { mastery: null, prefs: lp }).prefs, sp);
  assert.deepEqual(mergeProgress(emptyProgress(), { mastery: null, prefs: lp }).prefs, lp);
});

test("merge tolerates null or partial local mastery and unions event ids", () => {
  const s = { ...emptyProgress(), appliedEventIds: ["x"] };
  const a = mergeProgress(s, { mastery: null, prefs: null });
  assert.deepEqual(a.appliedEventIds, ["x"]);
  const b = mergeProgress(s, { mastery: { streak: { count: 2, last: "2026-01-01" } }, prefs: null });
  assert.deepEqual(b.topics, {});
  assert.equal(b.streak.count, 2);
  const c = mergeProgress(s, { mastery: { topics: { T: { attempted: 1, solved: 1 } } } });
  assert.equal(c.topics.T.solved, 1);
  const many = { ...emptyProgress(), appliedEventIds: Array.from({ length: 200 }, (_, i) => `s${i}`) };
  assert.equal(mergeProgress(many, { mastery: null, prefs: null }).appliedEventIds.length, 200);
});

test("topicStatus hard / confident / getting_there", () => {
  assert.equal(topicStatus({ hist: [h(1), h(0), h(1, 2)] }), "hard");
  assert.equal(topicStatus({ hist: [h(1, 0, 5), h(1), h(1, 0, 6)] }), "hard");
  assert.equal(topicStatus({ hist: [h(1), h(1, 0, 3), h(1, 0, 1)] }), "confident");
  assert.equal(topicStatus({ hist: [h(0), h(1), h(1)] }), "getting_there");
  assert.equal(topicStatus({ hist: [h(1, 0, 4), h(1), h(1)] }), "getting_there");
});

test("topicStatus fewer than 2 entries is getting_there", () => {
  assert.equal(topicStatus({ hist: [h(0)] }), "getting_there");
  assert.equal(topicStatus({ hist: [h(1)] }), "getting_there");
  assert.equal(topicStatus({}), "getting_there");
});

test("childSummary groups and orders topics", () => {
  const p = emptyProgress();
  p.streak = { count: 4, last: "2026-03-02" };
  p.topics = {
    Okay: { attempted: 1, solved: 1, hist: [h(0), h(1), h(1)] },
    Hardy: { attempted: 3, solved: 1, hist: [h(0), h(0), h(1, 1)] },
    Ace: { attempted: 0, solved: 5, hist: [h(1), h(1), h(1)] },
  };
  const s = childSummary(p);
  assert.equal(s.streak, 4);
  assert.equal(s.solved, 7);
  assert.equal(s.topicsTried, 3);
  assert.deepEqual(s.needsPractice.map((t) => t.name), ["Hardy"]);
  assert.deepEqual(s.goingWell.map((t) => t.name), ["Ace", "Okay"]);
  assert.deepEqual(s.needsPractice[0], {
    name: "Hardy", status: "hard", solved: 1, attempted: 3, hintsOften: false,
  });
  assert.equal(s.goingWell[0].status, "confident");
});

test("childSummary hintsOften when more than half of hist has hints", () => {
  const p = emptyProgress();
  p.topics.A = { attempted: 0, solved: 1, hist: [h(1, 1), h(1, 2), h(1, 0)] };
  p.topics.B = { attempted: 0, solved: 1, hist: [h(1, 1), h(1, 0)] };
  const s = childSummary(p);
  const byName = Object.fromEntries([...s.goingWell, ...s.needsPractice].map((t) => [t.name, t]));
  assert.equal(byName.A.hintsOften, true);
  assert.equal(byName.B.hintsOften, false);
});

test("childSummary lastPractised is latest date across days and hist", () => {
  const p = emptyProgress();
  assert.equal(childSummary(p).lastPractised, null);
  p.days = { "2026-03-01": 1 };
  p.topics.A = { attempted: 0, solved: 1, hist: [h(1, 0, 2, "2026-03-09")] };
  assert.equal(childSummary(p).lastPractised, "2026-03-09");
  p.days["2026-04-01"] = 2;
  assert.equal(childSummary(p).lastPractised, "2026-04-01");
});
