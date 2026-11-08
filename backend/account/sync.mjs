import { applyEvents, mergeProgress } from "./progress.mjs";
import { LEVELS } from "./profiles.mjs";
import { httpError } from "./http.mjs";

const MAX_EVENTS = 100;
const MAX_TOPICS = 100;
const MAX_HIST = 50;
const MAX_MASTERY_BYTES = 32768;
const MAX_STR = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = () => httpError("bad_request");

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isNameStr = (v) => isStr(v, MAX_STR) && v.length >= 1;
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isSmall = (v) => Number.isInteger(v) && v >= 0 && v <= 99;

function isDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

function cleanEvent(ev) {
  if (!isObject(ev) || !isStr(ev.id, 64) || ev.id.length < 1) throw bad();
  const { id, type } = ev;
  if (type === "outcome") {
    if (!isNameStr(ev.topic) || typeof ev.ok !== "boolean") throw bad();
    if (!isSmall(ev.hints) || !isSmall(ev.turns) || !isDate(ev.d)) throw bad();
    return { id, type, topic: ev.topic, ok: ev.ok, hints: ev.hints, turns: ev.turns, d: ev.d };
  }
  if (type === "activity") {
    if (ev.topic !== null && !isNameStr(ev.topic)) throw bad();
    if (typeof ev.solved !== "boolean" || !isDate(ev.d)) throw bad();
    return { id, type, topic: ev.topic, solved: ev.solved, d: ev.d };
  }
  if (type === "prefs") {
    if (!isStr(ev.level, MAX_STR) || !isStr(ev.topic, MAX_STR) || !isStr(ev.duration, MAX_STR)) throw bad();
    if (ev.level !== "" && !LEVELS.includes(ev.level)) throw bad();
    return { id, type, level: ev.level, topic: ev.topic, duration: ev.duration };
  }
  throw bad();
}

function cleanHistEntry(h) {
  if (!isObject(h) || !isDate(h.d) || !isSmall(h.hints) || !isSmall(h.turns)) throw bad();
  if (!(h.ok === 0 || h.ok === 1 || typeof h.ok === "boolean")) throw bad();
  return { d: h.d, ok: h.ok ? 1 : 0, hints: h.hints, turns: h.turns };
}

function cleanMastery(m) {
  if (m === null || m === undefined) return null;
  if (!isObject(m)) throw bad();
  let json;
  try {
    json = JSON.stringify(m);
  } catch {
    throw bad();
  }
  if (json.length >= MAX_MASTERY_BYTES || Buffer.byteLength(json) >= MAX_MASTERY_BYTES) throw bad();
  if (!isObject(m.topics) || !isObject(m.streak) || !isObject(m.days)) throw bad();
  const names = Object.keys(m.topics);
  if (names.length > MAX_TOPICS) throw bad();
  const topics = {};
  for (const name of names) {
    const t = m.topics[name];
    if (!isNameStr(name) || !isObject(t) || !isCount(t.attempted) || !isCount(t.solved)) throw bad();
    if (t.hist !== undefined && (!Array.isArray(t.hist) || t.hist.length > MAX_HIST)) throw bad();
    topics[name] = {
      attempted: t.attempted,
      solved: t.solved,
      hist: (t.hist ?? []).map(cleanHistEntry),
    };
  }
  if (!isCount(m.streak.count)) throw bad();
  if (m.streak.last !== "" && !isDate(m.streak.last)) throw bad();
  const days = {};
  for (const [d, n] of Object.entries(m.days)) {
    if (!isDate(d) || !isCount(n)) throw bad();
    days[d] = n;
  }
  return { topics, streak: { count: m.streak.count, last: m.streak.last }, days };
}

function cleanPrefs(p) {
  if (p === null || p === undefined) return null;
  if (!isObject(p)) throw bad();
  if (!isStr(p.level, MAX_STR) || !isStr(p.topic, MAX_STR) || !isStr(p.duration, MAX_STR)) throw bad();
  if (p.level !== "" && !LEVELS.includes(p.level)) throw bad();
  return { level: p.level, topic: p.topic, duration: p.duration };
}

const publicProgress = ({ appliedEventIds, ...rest }) => rest; // eslint-disable-line no-unused-vars

// Access check order is deliberate: strangers always see 404 so existence never leaks.
async function authorise(ctx) {
  const { repo } = ctx.deps;
  const { profileId } = ctx.req.body;
  if (typeof profileId !== "string" || !profileId) throw bad();
  const kind = await repo.getAccess(ctx.account.id, profileId);
  if (!kind) throw httpError("not_found");
  if (kind !== "owner" && kind !== "guardian") throw httpError("forbidden");
  const profile = await repo.getProfile(profileId);
  if (!profile) throw httpError("not_found");
  if (profile.consentStatus === "awaiting_parent") throw httpError("awaiting_parent");
  return profileId;
}

export function register(router) {
  router.route("POST", "/progress/get", async (ctx) => {
    const pid = await authorise(ctx);
    const { progress } = await ctx.deps.repo.getProgress(pid);
    return { progress: publicProgress(progress) };
  });

  router.route("POST", "/progress/sync", async (ctx) => {
    const { events } = ctx.req.body;
    if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS) throw bad();
    const clean = events.map(cleanEvent);
    const pid = await authorise(ctx);
    const next = await ctx.deps.repo.updateProgress(pid, (p) => applyEvents(p, clean));
    return { progress: publicProgress(next) };
  });

  router.route("POST", "/progress/merge", async (ctx) => {
    const { local } = ctx.req.body;
    if (!isObject(local)) throw bad();
    const clean = { mastery: cleanMastery(local.mastery), prefs: cleanPrefs(local.prefs) };
    const pid = await authorise(ctx);
    const next = await ctx.deps.repo.updateProgress(pid, (p) => mergeProgress(p, clean));
    return { progress: publicProgress(next) };
  });
}
