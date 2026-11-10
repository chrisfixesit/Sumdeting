import { test } from "node:test";
import assert from "node:assert/strict";
import {
  masteryState, masteryWord, beadCount, upNext, nextStep, nextStepLine, liveStreak, showStreak,
  randomTopic, PAD_LEVEL_KEYS, PAD_TOPIC_KEYS, padKeys, ALL_PAD_KEYS, keyInsert, keyLabel,
} from "./home-core.mjs";

test("masteryState thresholds", () => {
  assert.equal(masteryState(0), "not-started");
  assert.equal(masteryState(1), "attempted");
  assert.equal(masteryState(2), "attempted");
  assert.equal(masteryState(3), "familiar");
  assert.equal(masteryState(4), "familiar");
  assert.equal(masteryState(5), "mastered");
  assert.equal(masteryState(9), "mastered");
});

test("masteryState: attempted-only topics read attempted", () => {
  assert.equal(masteryState(0, 2), "attempted");
  assert.equal(masteryState(0, 0), "not-started");
  assert.equal(masteryState(0), "not-started");
  assert.equal(masteryState(0, undefined), "not-started");
  assert.equal(masteryState(3, 6), "familiar");
  assert.equal(masteryState(5, 9), "mastered");
});

test("masteryWord", () => {
  assert.equal(masteryWord("not-started"), "Not started");
  assert.equal(masteryWord("attempted"), "Attempted");
  assert.equal(masteryWord("familiar"), "Familiar");
  assert.equal(masteryWord("mastered"), "Mastered");
});

test("beadCount clamps", () => {
  assert.equal(beadCount(9), 5);
  assert.equal(beadCount(-1), 0);
  assert.equal(beadCount(undefined), 0);
  assert.equal(beadCount(3), 3);
});

test("upNext picks most solved under 5, ties to earlier", () => {
  const topics = ["Algebra", "Trigonometry", "Statistics & Probability"];
  assert.equal(upNext(topics, { Algebra: { solved: 3, attempted: 4 }, "Statistics & Probability": { solved: 4, attempted: 4 } }), "Statistics & Probability");
  assert.equal(upNext(topics, { Algebra: { solved: 3, attempted: 3 }, Trigonometry: { solved: 3, attempted: 3 } }), "Algebra");
  assert.equal(upNext(topics, { Algebra: { solved: 5, attempted: 5 }, Trigonometry: { solved: 5, attempted: 5 }, "Statistics & Probability": { solved: 5, attempted: 5 } }), null);
  assert.equal(upNext(topics, {}), null);
});

test("nextStep and nextStepLine", () => {
  const topics = ["Algebra", "Trigonometry"];
  assert.deepEqual(nextStep(topics, {}), { kind: "new" });
  assert.deepEqual(nextStep(topics, { Algebra: { solved: 5, attempted: 5 }, Trigonometry: { solved: 5, attempted: 5 } }), { kind: "done" });
  const step = nextStep(topics, { Algebra: { solved: 3, attempted: 3 } });
  assert.deepEqual(step, { kind: "pickup", topic: "Algebra", remaining: 2 });
  assert.equal(nextStepLine(step), "Two more beads and Algebra is mastered.");
  assert.equal(nextStepLine({ kind: "pickup", topic: "Algebra", remaining: 1 }), "One more bead and Algebra is mastered.");
  assert.equal(nextStepLine({ kind: "pickup", topic: "Algebra", remaining: 5 }), "Five more beads and Algebra is mastered.");
  assert.equal(nextStepLine({ kind: "new" }), "New here? Pick a topic below, or let me choose.");
  assert.equal(nextStepLine({ kind: "done" }), "Every topic mastered at this level. Try a timed exam?");
});

test("mastered topic with others untouched falls back to first unmastered", () => {
  const topics = ["Algebra", "Trigonometry"];
  const m = { Algebra: { solved: 5, attempted: 5 } };
  assert.equal(upNext(topics, m), "Trigonometry");
  const step = nextStep(topics, m);
  assert.deepEqual(step, { kind: "pickup", topic: "Trigonometry", remaining: 5 });
  assert.equal(nextStepLine(step), "Five more beads and Trigonometry is mastered.");
});

test("liveStreak and showStreak", () => {
  assert.equal(liveStreak({ count: 4, last: "2026-11-09" }, "2026-11-09"), 4);
  assert.equal(liveStreak({ count: 4, last: "2026-11-08" }, "2026-11-09"), 4);
  assert.equal(liveStreak({ count: 4, last: "2026-10-20" }, "2026-11-09"), 0);
  assert.equal(showStreak(1), false);
  assert.equal(showStreak(2), true);
});

test("randomTopic", () => {
  assert.equal(randomTopic(["a", "b", "c"], () => 0.99), "c");
  assert.equal(randomTopic(["a", "b", "c"], () => 0), "a");
});

test("padKeys", () => {
  const k = padKeys("CSEC", "Trigonometry");
  assert.deepEqual(k.slice(0, 5), ["sin", "cos", "tan", "θ", "°"]);
  assert.equal(k.filter((x) => x === "x²").length, 1);
  assert.equal(padKeys("Common Entrance", "Ratio & Proportion")[0], ":");
  assert.deepEqual(padKeys("Nope", "Algebra"), padKeys("CSEC", "Algebra"));
  assert.deepEqual(padKeys("CSEC", "Unknown topic"), PAD_LEVEL_KEYS.CSEC);
});

test("every level topic has a pad entry", () => {
  for (const t of [
    "Number & Place Value", "Fractions & Decimals", "Percentages & Money", "Ratio & Proportion",
    "Measurement & Time", "Geometry & Mensuration", "Sets & Venn Diagrams", "Statistics & Probability",
    "Algebra", "Functions & Graphs", "Trigonometry", "Vectors & Matrices", "Coordinate Geometry & Vectors",
    "Sequences & Series", "Calculus", "Complex Numbers & Matrices",
    "Logic & Proof", "Complex Numbers", "Further Calculus", "Counting & Probability", "Matrices",
    "Differential Equations",
  ]) assert.ok(Array.isArray(PAD_TOPIC_KEYS[t]), t);
});

test("keyInsert", () => {
  assert.equal(keyInsert("sin"), "sin(");
  assert.equal(keyInsert("x²"), "²");
  assert.equal(keyInsert("xⁿ"), "^");
  assert.equal(keyInsert("√"), "√(");
  assert.equal(keyInsert("∫"), "∫ ");
  assert.equal(keyInsert("d/dx"), "d/dx ");
  assert.equal(keyInsert("lim"), "lim ");
  assert.equal(keyInsert("½"), "/");
  assert.equal(keyInsert("π"), "π");
});

test("ALL_PAD_KEYS", () => {
  assert.equal(new Set(ALL_PAD_KEYS).size, ALL_PAD_KEYS.length);
  for (const k of ["lim", "$", "x̄"]) assert.ok(ALL_PAD_KEYS.includes(k), k);
});

test("keyLabel gives every pad key a spoken name", () => {
  for (const k of ALL_PAD_KEYS) {
    const name = keyLabel(k);
    assert.equal(typeof name, "string", k);
    assert.ok(name.trim().length > 0, k);
    // Only plain letters and "log" may read as themselves; every symbol needs a spoken name.
    if (!/^[a-z]$/i.test(k) && k !== "log") assert.notEqual(name, k, `${k} has no spoken name`);
  }
  assert.equal(keyLabel("½"), "fraction slash");
  assert.equal(keyLabel("x²"), "x squared");
  assert.equal(keyLabel("√"), "square root");
  assert.equal(keyLabel("d/dx"), "derivative d by d x");
  assert.equal(keyLabel("≤"), "less than or equal to");
  assert.equal(keyLabel("zz"), "zz"); // unknown keys fall back to the label
});
