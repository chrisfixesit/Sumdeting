// Pure progress logic: mirrors the browser's recordOutcome / recordActivity /
// bumpStreak / struggledEntry rules (web/index.html) so the server can apply
// the same events. Dates are 'YYYY-MM-DD' strings supplied on each event.

const HIST_MAX = 15;
const EVENT_IDS_MAX = 200;

export function emptyProgress() {
  return {
    topics: {},
    streak: { count: 0, last: "" },
    days: {},
    prefs: null,
    appliedEventIds: [],
  };
}

function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

function cloneProgress(p) {
  const src = p ?? emptyProgress();
  const topics = {};
  for (const [name, t] of Object.entries(src.topics ?? {})) {
    topics[name] = {
      attempted: t.attempted ?? 0,
      solved: t.solved ?? 0,
      hist: (t.hist ?? []).map((e) => ({ ...e })),
    };
  }
  return {
    topics,
    streak: { count: src.streak?.count ?? 0, last: src.streak?.last ?? "" },
    days: { ...(src.days ?? {}) },
    prefs: src.prefs ? { ...src.prefs } : null,
    appliedEventIds: [...(src.appliedEventIds ?? [])],
  };
}

function topicEntry(p, name) {
  return (p.topics[name] ??= { attempted: 0, solved: 0, hist: [] });
}

function bumpStreak(streak, d) {
  if (streak.last === d) return;
  if (streak.last && d < streak.last) return; // out-of-order replay
  streak.count = streak.last && nextDay(streak.last) === d ? streak.count + 1 : 1;
  streak.last = d;
}

export function applyEvents(progress, events) {
  const p = cloneProgress(progress);
  const seen = new Set(p.appliedEventIds);
  for (const ev of events ?? []) {
    if (ev.id != null && seen.has(ev.id)) continue;
    if (ev.type === "activity") {
      if (ev.topic) {
        const t = topicEntry(p, ev.topic);
        if (ev.solved) t.solved += 1;
        else t.attempted += 1;
      }
      bumpStreak(p.streak, ev.d);
      if (ev.topic && ev.solved) p.days[ev.d] = (p.days[ev.d] || 0) + 1;
    } else if (ev.type === "outcome") {
      const t = topicEntry(p, ev.topic);
      t.hist.push({ d: ev.d, ok: ev.ok ? 1 : 0, hints: ev.hints, turns: ev.turns });
      if (t.hist.length > HIST_MAX) t.hist = t.hist.slice(-HIST_MAX);
    } else if (ev.type === "prefs") {
      p.prefs = { level: ev.level, topic: ev.topic, duration: ev.duration };
    } else {
      continue;
    }
    if (ev.id != null) {
      seen.add(ev.id);
      p.appliedEventIds.push(ev.id);
    }
  }
  if (p.appliedEventIds.length > EVENT_IDS_MAX) {
    p.appliedEventIds = p.appliedEventIds.slice(-EVENT_IDS_MAX);
  }
  return p;
}

export function mergeProgress(server, local) {
  const p = cloneProgress(server);
  const m = local?.mastery ?? {};
  for (const [name, lt] of Object.entries(m.topics ?? {})) {
    const t = topicEntry(p, name);
    t.attempted += lt.attempted ?? 0;
    t.solved += lt.solved ?? 0;
    const all = [...t.hist, ...(lt.hist ?? []).map((e) => ({ ...e }))];
    all.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)); // stable
    t.hist = all.slice(-HIST_MAX);
  }
  if ((m.streak?.count ?? 0) > p.streak.count) {
    p.streak = { count: m.streak.count, last: m.streak.last ?? "" };
  }
  for (const [d, n] of Object.entries(m.days ?? {})) {
    p.days[d] = (p.days[d] || 0) + n;
  }
  if (!p.prefs && local?.prefs) p.prefs = { ...local.prefs };
  return p;
}

const struggled = (h) => !h.ok || h.hints > 0 || h.turns >= 5;

export function topicStatus(topic) {
  const recent = (topic?.hist ?? []).slice(-3);
  if (recent.length < 2) return "getting_there";
  if (recent.filter(struggled).length >= 2) return "hard";
  if (recent.every((h) => h.ok && h.hints === 0 && h.turns <= 3)) return "confident";
  return "getting_there";
}

export function childSummary(progress) {
  const topics = Object.entries(progress?.topics ?? {});
  const rows = topics.map(([name, t]) => {
    const hist = t.hist ?? [];
    return {
      name,
      status: topicStatus(t),
      solved: t.solved ?? 0,
      attempted: t.attempted ?? 0,
      hintsOften: hist.length > 0 && hist.filter((h) => h.hints > 0).length > hist.length / 2,
    };
  });
  const dates = [
    ...Object.keys(progress?.days ?? {}),
    ...topics.flatMap(([, t]) => (t.hist ?? []).map((h) => h.d)),
  ].filter(Boolean);
  const confident = rows.filter((r) => r.status === "confident");
  const rest = rows.filter((r) => r.status === "getting_there");
  return {
    streak: progress?.streak?.count ?? 0,
    solved: rows.reduce((n, r) => n + r.solved, 0),
    topicsTried: rows.length,
    lastPractised: dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null,
    needsPractice: rows.filter((r) => r.status === "hard"),
    goingWell: [...confident, ...rest],
  };
}
