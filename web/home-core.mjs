// Pure logic for the home screen: mastery beads, "up next", streaks and the
// maths pad keys. No browser globals at import time, so it is testable in Node.

const MAX_BEADS = 5;

export function masteryState(solved) {
  const n = beadCount(solved);
  if (n >= 5) return "mastered";
  if (n >= 3) return "familiar";
  if (n >= 1) return "attempted";
  return "not-started";
}

const WORDS = { "not-started": "Not started", attempted: "Attempted", familiar: "Familiar", mastered: "Mastered" };
export function masteryWord(state) { return WORDS[state] ?? WORDS["not-started"]; }

/** Beads to fill: `solved` clamped to 0-5; non-numbers count as 0. */
export function beadCount(solved) {
  const n = typeof solved === "number" && Number.isFinite(solved) ? Math.floor(solved) : 0;
  return Math.min(MAX_BEADS, Math.max(0, n));
}

const stat = (m, t) => m?.[t] ?? {};
const solvedOf = (m, t) => Number(stat(m, t).solved) || 0;
const startedOf = (m, t) => solvedOf(m, t) > 0 || (Number(stat(m, t).attempted) || 0) > 0;

/**
 * In-progress topic with the most solved (ties to topic order). If none is in
 * progress but something has activity, the first topic still under 5. Null when
 * nothing has activity or every topic is mastered.
 */
export function upNext(topics, masteryTopics) {
  const list = topics ?? [];
  if (!list.some((t) => startedOf(masteryTopics, t))) return null;
  let best = null, bestSolved = -1;
  for (const t of list) {
    if (!startedOf(masteryTopics, t)) continue;
    const s = solvedOf(masteryTopics, t);
    if (s >= MAX_BEADS) continue;
    if (s > bestSolved) { best = t; bestSolved = s; }
  }
  if (best !== null) return best;
  return list.find((t) => solvedOf(masteryTopics, t) < MAX_BEADS) ?? null;
}

export function nextStep(topics, masteryTopics) {
  const list = topics ?? [];
  if (!list.some((t) => startedOf(masteryTopics, t))) return { kind: "new" };
  const topic = upNext(list, masteryTopics);
  if (topic === null) return { kind: "done" };
  return { kind: "pickup", topic, remaining: MAX_BEADS - solvedOf(masteryTopics, topic) };
}

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five"];
export function nextStepLine(step) {
  if (step?.kind === "pickup") {
    if (step.remaining === 1) return `One more bead and ${step.topic} is mastered.`;
    return `${NUMBER_WORDS[step.remaining] ?? step.remaining} more beads and ${step.topic} is mastered.`;
  }
  if (step?.kind === "done") return "Every topic mastered at this level. Try a timed exam?";
  return "New here? Pick a topic below, or let me choose.";
}

function dayBefore(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Streak count if the last practice day is today or yesterday, else 0. */
export function liveStreak(streak, today) {
  const count = Number(streak?.count) || 0;
  const last = streak?.last;
  return last && (last === today || last === dayBefore(today)) ? count : 0;
}

export function showStreak(n) { return n >= 2; }

export function randomTopic(topics, rand = Math.random) {
  return topics[Math.min(topics.length - 1, Math.floor(rand() * topics.length))];
}

export const PAD_LEVEL_KEYS = {
  "Common Entrance": ["+", "−", "×", "÷", "=", "½", "%", "$", "(", ")", "°"],
  CSEC: ["x", "y", "x²", "√", "π", "=", "(", ")", "½", "°", "≤", "≥", "sin", "cos", "tan", "±"],
  "Additional Maths": ["x", "xⁿ", "√", "π", "θ", "=", "log", "ln", "sin", "cos", "tan", "e", "d/dx", "∫", "≤", "≥"],
  CAPE: ["xⁿ", "√", "π", "θ", "e", "i", "d/dx", "∫", "lim", "Σ", "∞", "→", "log", "ln", "∈", "≠"],
};

export const PAD_TOPIC_KEYS = {
  "Number & Place Value": ["×", "÷"],
  "Fractions & Decimals": ["½", "÷"],
  "Percentages & Money": ["%", "$"],
  "Ratio & Proportion": [":"],
  "Measurement & Time": ["°"],
  "Geometry & Mensuration": ["π", "°", "√"],
  "Sets & Venn Diagrams": ["∈", "∪", "∩"],
  "Statistics & Probability": ["x̄", "Σ"],
  Algebra: ["x", "y", "x²", "="],
  "Functions & Graphs": ["x", "y", "→"],
  Trigonometry: ["sin", "cos", "tan", "θ", "°"],
  "Vectors & Matrices": ["→"],
  "Coordinate Geometry & Vectors": ["√", "→"],
  "Sequences & Series": ["Σ", "xⁿ"],
  Calculus: ["d/dx", "∫", "xⁿ"],
  "Complex Numbers & Matrices": ["i", "θ"],
};

const dedupe = (keys) => [...new Set(keys)];

export function padKeys(level, topic) {
  const levelKeys = PAD_LEVEL_KEYS[level] ?? PAD_LEVEL_KEYS.CSEC;
  return dedupe([...(PAD_TOPIC_KEYS[topic] ?? []), ...levelKeys]);
}

export const ALL_PAD_KEYS = dedupe([
  ...Object.values(PAD_LEVEL_KEYS).flat(),
  ...Object.values(PAD_TOPIC_KEYS).flat(),
]);

const INSERTS = {
  "x²": "²", "xⁿ": "^", sin: "sin(", cos: "cos(", tan: "tan(", log: "log(", ln: "ln(",
  "√": "√(", "d/dx": "d/dx ", "∫": "∫ ", lim: "lim ", "½": "/",
};
export function keyInsert(label) { return INSERTS[label] ?? label; }

if (typeof window !== "undefined") {
  window.SumHome = {
    masteryState, masteryWord, beadCount, upNext, nextStep, nextStepLine, liveStreak, showStreak,
    randomTopic, PAD_LEVEL_KEYS, PAD_TOPIC_KEYS, padKeys, ALL_PAD_KEYS, keyInsert,
  };
}
