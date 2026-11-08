// Account UI: profile icon, sign-in, setup, "Who's practising?", merge prompt,
// progress sync and the profile menu. Loaded as a module after the inline app
// script, so window.SumDeTing (the bridge) already exists. Signing in is
// optional: nothing here may block or slow down signed-out practice.
import {
  createApi, createQueue, hasAnonymousProgress, readAnonymous, clearAnonymous,
  clearProfileCaches, initials, parseSigninFragment, newMergeId,
} from "./account-core.mjs";
import { h, personIcon, openDialog, closeAllDialogs, closeFrom, showNotice, busy, errorLine, statusLine, confirmDanger } from "./account-dom.mjs";
import { createScreens } from "./account-screens.mjs";
import { createParentSection, DELETED_MSG } from "./account-parent.mjs";

const SD = window.SumDeTing;
const MASTERY = "mathmentor.mastery.v1";
const PREFS = "mathmentor.prefs.v1";
const ACTIVE = "sumdeting.activeProfile";
const MERGE_PREFIX = "sumdeting.mergeId.";
const QUEUE_PREFIX = "sumdeting.queue.";
const DECLINED_PREFIX = "sumdeting.mergeDeclined.";
const LAST_ACCOUNT = "sumdeting.lastAccount";
const AWAITING = "sumdeting.awaitingProfile";
const FLUSH_GAP_MS = 5000;
const UNLOCK_MS = 15 * 60 * 1000; // the server's parent unlock window
const RETRY_MS = 15000;

export const SIGNED_OUT_MSG = "You've been signed out. Your practice still works on this device.";
export const GONE_MSG = "This profile is no longer available.";
const WAITING_MSG = "Waiting for your parent to approve. Your progress is saved on this device for now.";

// localStorage can throw (private mode, blocked storage): never let that break the app.
const store = {
  get length() { try { return localStorage.length; } catch { return 0; } },
  key(i) { try { return localStorage.key(i); } catch { return null; } },
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* full or blocked */ } },
  removeItem(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

export const api = createApi({ fetchImpl: (u, o) => fetch(u, o), sha256Hex: SD.sha256Hex });
const keepaliveApi = createApi({ fetchImpl: (u, o) => fetch(u, { ...o, keepalive: true }), sha256Hex: SD.sha256Hex });

const MESSAGES = {
  network: "Couldn't reach SumDeTing. Check your connection and try again.",
  rate_limited: "Too many tries for now. Please wait a while and try again.",
  invalid_code: "That code didn't work. Check it and try again.",
  too_many_attempts: "Too many wrong codes. Ask for a new one.",
  bad_request: "Check the details and try again.",
  parent_email_is_student: "That email is set up as a student account. Use a parent's or guardian's email.",
  email_is_student: "That email is set up as a student account. Use a parent's or guardian's email.",
  email_is_parent: "That email is set up as a parent account.",
  awaiting_parent: "Your parent needs to approve your profile first.",
  forbidden: "This account can't do that.",
  not_found: GONE_MSG,
  parent_locked: "The parent section is locked. Enter the code we emailed you to continue.",
  not_signed_in: SIGNED_OUT_MSG,
  internal: "Something went wrong. Please try again.",
};
export const errorCode = (r) => r?.data?.error ?? (r?.status === 0 ? "network" : "internal");
export const messageFor = (r) => MESSAGES[errorCode(r)] ?? MESSAGES.internal;

/** "maya@example.com" -> "m•••@example.com" */
export function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return email;
  return `${user.slice(0, 1)}•••@${domain}`;
}

const state = {
  me: null, // /me response while signed in
  profile: null, // the active profile on this device (may be awaiting_parent)
  syncPid: null, // the profile whose progress is synced (null when signed-out storage)
  unlockedUntil: 0, // our estimate of when the parent unlock ends (ms); 0 = locked
};

/** A parent code was accepted (or setup unlocked the session): the window runs from now. */
function markUnlocked() {
  state.unlockedUntil = Date.now() + UNLOCK_MS;
  if (state.me) state.me.parentUnlocked = true;
}

/** The window ended, or the server said parent_locked. */
function markLocked() {
  state.unlockedUntil = 0;
  if (state.me) state.me.parentUnlocked = false;
}

/**
 * /me says the session is unlocked but we never saw the unlock (page reload):
 * assume at most a full window from now. Only a real unlock refreshes the estimate.
 */
function adoptUnlock(me) {
  if (!me?.parentUnlocked) { state.unlockedUntil = 0; return; }
  if (state.unlockedUntil <= Date.now()) state.unlockedUntil = Date.now() + UNLOCK_MS;
}

const usable = (p) => p.access === "owner" || p.access === "guardian";
const selectable = () => (state.me?.profiles ?? []).filter(usable);
const isParent = () => state.me?.account?.type === "parent";

// ---- Header icon, "this device only" tag, waiting banner ----

const slot = document.getElementById("account-slot");
const iconBtn = h("button", { id: "account-btn", type: "button", class: "acct-btn", "aria-haspopup": "dialog" });
slot?.append(iconBtn);

const tag = h("span", { class: "acct-device-tag" }, "this device only");
document.getElementById("mastery")?.after(tag);

const bannerStatus = statusLine();
const resendBtn = h("button", { type: "button", class: "acct-link" }, "Resend");
const banner = h("div", { class: "acct-banner", hidden: true },
  h("p", { class: "acct-banner-text" }, WAITING_MSG),
  h("div", { class: "acct-banner-row" }, resendBtn, bannerStatus));
document.querySelector("main")?.prepend(banner);

resendBtn.addEventListener("click", () => busy(resendBtn, async () => {
  if (!state.profile) return;
  const r = await api("/consent/resend", { profileId: state.profile.id });
  if (r.ok) bannerStatus.show("We sent the email to your parent again.");
  else if (!handleAuthFailure(r)) bannerStatus.show(messageFor(r));
}));

function renderIcon() {
  const p = state.profile;
  iconBtn.replaceChildren();
  iconBtn.classList.remove("out", "in", "blank");
  iconBtn.style.removeProperty("--acct-colour");
  if (!state.me) {
    iconBtn.classList.add("out");
    iconBtn.setAttribute("aria-label", "Sign in to keep your progress");
    iconBtn.append(h("span", { class: "acct-av" }, personIcon()));
  } else if (p) {
    iconBtn.classList.add("in");
    iconBtn.style.setProperty("--acct-colour", p.colour);
    iconBtn.setAttribute("aria-label", `Profile menu, ${p.firstName} ${p.lastName}`);
    iconBtn.append(h("span", { class: "acct-av" }, initials(p.firstName, p.lastName)));
  } else {
    iconBtn.classList.add("in", "blank");
    iconBtn.setAttribute("aria-label", "Choose who's practising");
    iconBtn.append(h("span", { class: "acct-av" }, personIcon()));
  }
}

function render() {
  renderIcon();
  const synced = Boolean(state.syncPid);
  tag.textContent = synced ? "synced" : "this device only";
  tag.classList.toggle("synced", synced);
  const waiting = Boolean(state.me && state.profile?.consentStatus === "awaiting_parent");
  if (banner.hidden === waiting) bannerStatus.show("");
  banner.hidden = !waiting;
}

iconBtn.addEventListener("click", () => {
  if (!state.me) screens.openSignin();
  else if (!state.me.account.setupComplete || state.me.pendingConsents?.length) route({ showPicker: true });
  else if (!state.profile) screens.openPicker();
  else screens.openProfileMenu();
});

// ---- Local cache ----

function writeCache(p, progress) {
  const mastery = {
    topics: progress?.topics ?? {},
    streak: progress?.streak ?? { count: 0, last: "" },
    days: progress?.days ?? {},
  };
  store.setItem(SD.storageKey(MASTERY, p.id), JSON.stringify(mastery));
  const prefs = progress?.prefs ? { ...progress.prefs } : { level: "", topic: "", duration: "" };
  if (!prefs.level) prefs.level = p.level; // the profile's level is the default
  store.setItem(SD.storageKey(PREFS, p.id), JSON.stringify(prefs));
}

function ensurePrefs(p) {
  const key = SD.storageKey(PREFS, p.id);
  if (!store.getItem(key)) store.setItem(key, JSON.stringify({ level: p.level, topic: "", duration: "" }));
}

function forgetProfile(pid) {
  for (const k of [SD.storageKey(MASTERY, pid), SD.storageKey(PREFS, pid), QUEUE_PREFIX + pid, MERGE_PREFIX + pid, DECLINED_PREFIX + pid]) {
    store.removeItem(k);
  }
}

/** Remove merge ids, merge declines and the awaiting marker (the extras clearProfileCaches doesn't know). */
function removeMergeIds() {
  const doomed = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(MERGE_PREFIX) || k?.startsWith(DECLINED_PREFIX)) doomed.push(k);
  }
  doomed.forEach((k) => store.removeItem(k));
  store.removeItem(AWAITING);
}

/** Everything a previous account left on this device. Bumps the session generation first. */
function wipeAccountData() {
  generation += 1;
  clearProfileCaches(store);
  removeMergeIds();
  store.removeItem(LAST_ACCOUNT);
}

/** Cheap fingerprint of the signed-out mastery blob: length plus a 32-bit string hash. */
export function anonFingerprint(raw) {
  const text = raw ?? "";
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${hash.toString(36)}`;
}

/** Offer the merge unless the person said "Not mine" to this exact signed-out blob. */
async function maybeOfferMerge(p) {
  if (!hasAnonymousProgress(store)) return;
  const fp = anonFingerprint(store.getItem(MASTERY));
  if (store.getItem(DECLINED_PREFIX + p.id) === fp) return;
  const result = await screens.offerMerge(p);
  if (result === "declined") store.setItem(DECLINED_PREFIX + p.id, fp);
}

async function rememberAccount(me) {
  try { store.setItem(LAST_ACCOUNT, await SD.sha256Hex(`sumdeting:${me.account.email}`)); } catch { /* no crypto */ }
}

// ---- Choosing a profile ----

/**
 * Make `p` the active profile on this device and load its progress. The merge
 * prompt is offered only on an explicit choice (picker, after sign-in or setup),
 * never on the silent restore at page load.
 */
async function chooseProfile(p, { explicit = true } = {}) {
  if (state.syncPid && state.syncPid !== p.id) await flushNow();
  if (!state.me) return; // the flush found we were signed out (and already said so)
  if (store.getItem(ACTIVE) !== p.id) SD.clearChat();
  store.setItem(ACTIVE, p.id);
  state.profile = p;

  if (p.consentStatus === "awaiting_parent") {
    // Until a parent approves, the app keeps using signed-out storage.
    store.setItem(AWAITING, p.id);
    state.syncPid = null;
    SD.setActiveProfile(null);
    SD.reloadLocalState();
    render();
    return;
  }

  // A profile that was waiting for approval and is now active gets the merge offer once, as on approval.
  const justApproved = store.getItem(AWAITING) === p.id;
  store.removeItem(AWAITING);
  state.syncPid = p.id;
  SD.setActiveProfile(p.id);
  render();
  const queue = createQueue(store, p.id);
  if (queue.size() && (await flushNow()) !== "ok" && state.syncPid !== p.id) return;
  const r = await api("/progress/get", { profileId: p.id });
  if (state.syncPid !== p.id) return; // switched away meanwhile
  if (r.ok) {
    if (!queue.size()) writeCache(p, r.data?.progress);
    else ensurePrefs(p);
  } else if (handleAuthFailure(r, p.id)) {
    return;
  } else {
    ensurePrefs(p); // offline: keep the local copy usable
  }
  SD.reloadLocalState();
  render();
  if (explicit || justApproved) await maybeOfferMerge(p);
}

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const small = (v) => Math.min(99, count(Math.trunc(Number(v)) || 0));
const plainObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Shape the signed-out blobs into what /progress/merge accepts. */
export function normaliseLocal({ mastery, prefs }) {
  let m = null;
  if (mastery && typeof mastery === "object") {
    const topics = {};
    for (const [name, t] of Object.entries(plainObject(mastery.topics)).slice(0, 100)) {
      if (!name || name.length > 60 || ["__proto__", "constructor", "prototype"].includes(name)) continue;
      const hist = (Array.isArray(t?.hist) ? t.hist : [])
        .filter((e) => e && isDate(e.d))
        .slice(-50)
        .map((e) => ({ d: e.d, ok: e.ok ? 1 : 0, hints: small(e.hints), turns: small(e.turns) }));
      topics[name] = { attempted: count(t?.attempted), solved: count(t?.solved), hist };
    }
    const days = {};
    for (const [d, n] of Object.entries(plainObject(mastery.days))) if (isDate(d)) days[d] = count(n);
    const last = isDate(mastery.streak?.last) ? mastery.streak.last : "";
    m = { topics, streak: { count: last ? count(mastery.streak?.count) : 0, last }, days };
  }
  const okStr = (v) => typeof v === "string" && v.length <= 60;
  const p = prefs && okStr(prefs.level) && okStr(prefs.topic) && okStr(prefs.duration)
    && (prefs.level === "" || SD.levels.includes(prefs.level))
    ? { level: prefs.level, topic: prefs.topic, duration: prefs.duration }
    : null;
  return { mastery: m, prefs: p };
}

/** Merge the signed-out progress into `p`. The mergeId survives retries so the server applies it once. */
async function mergeInto(p) {
  const key = MERGE_PREFIX + p.id;
  let mergeId = store.getItem(key);
  if (!mergeId) {
    mergeId = newMergeId();
    store.setItem(key, mergeId);
  }
  const r = await api("/progress/merge", { profileId: p.id, mergeId, local: normaliseLocal(readAnonymous(store)) });
  if (!r.ok) return r;
  clearAnonymous(store);
  store.removeItem(key);
  store.removeItem(DECLINED_PREFIX + p.id);
  if (state.syncPid === p.id && !createQueue(store, p.id).size()) writeCache(p, r.data?.progress);
  SD.reloadLocalState();
  return r;
}

// ---- Sync ----

let flushTimer = null;
let lastFlush = 0;
let inflight = null;
// Bumped whenever a session ends on this device, so a flush still in flight
// can't write a queue back after the caches were cleared.
let generation = 0;
const guardedStore = (gen) => ({
  getItem: (k) => store.getItem(k),
  setItem: (k, v) => { if (gen === generation) store.setItem(k, v); },
  removeItem: (k) => { if (gen === generation) store.removeItem(k); },
});

window.addEventListener("sumdeting:progress", (e) => {
  const pid = state.syncPid;
  if (!pid || !e.detail || typeof e.detail !== "object") return;
  createQueue(store, pid).push(e.detail);
  scheduleFlush();
});

function scheduleFlush(delay) {
  if (flushTimer || !state.syncPid) return;
  const wait = delay ?? Math.max(250, lastFlush + FLUSH_GAP_MS - Date.now());
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, wait);
}

/** Send queued events for the synced profile. Returns the queue's flush result. */
async function flushNow({ keepalive = false } = {}) {
  const pid = state.syncPid;
  if (!pid) return "ok";
  if (inflight) return inflight;
  clearTimeout(flushTimer);
  flushTimer = null;
  inflight = (async () => {
    lastFlush = Date.now();
    const queue = createQueue(guardedStore(generation), pid);
    let res = await queue.flush(keepalive ? keepaliveApi : api);
    while (!keepalive && res === "ok" && queue.size()) res = await queue.flush(api);
    return res;
  })();
  let res;
  try { res = await inflight; } finally { inflight = null; }
  if (state.syncPid !== pid) return res;
  if (res === "signedOut") dropToSignedOut(SIGNED_OUT_MSG);
  else if (res === "gone") profileGone(pid);
  else if (res === "retry") scheduleFlush(RETRY_MS);
  return res;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.syncPid && createQueue(store, state.syncPid).size()) {
    flushNow({ keepalive: true });
  } else if (document.visibilityState === "visible") {
    screens.checkSignedInElsewhere();
  }
});
window.addEventListener("focus", () => screens.checkSignedInElsewhere());

/** 401 -> signed out; 404/403 on a profile -> profile gone. Returns true when handled. */
function handleAuthFailure(r, pid = state.profile?.id) {
  const code = errorCode(r);
  if (r.status === 401 || code === "not_signed_in") {
    dropToSignedOut(SIGNED_OUT_MSG);
    return true;
  }
  if (pid && (code === "not_found" || code === "forbidden")) {
    profileGone(pid);
    return true;
  }
  return false;
}

function deactivate() {
  clearTimeout(flushTimer);
  flushTimer = null;
  state.profile = null;
  state.syncPid = null;
  store.removeItem(ACTIVE);
  SD.setActiveProfile(null);
  SD.clearChat();
  SD.reloadLocalState();
}

/**
 * The server no longer knows us: back to signed-out storage. The profile's
 * cached progress is removed (shared computers), but its queue stays so unsent
 * events reach the server at the next sign-in. sumdeting.lastAccount stays so
 * the next person's sign-in still clears whatever is left.
 */
function dropToSignedOut(message) {
  const pid = state.profile?.id ?? store.getItem(ACTIVE);
  if (pid) {
    store.removeItem(SD.storageKey(MASTERY, pid));
    store.removeItem(SD.storageKey(PREFS, pid));
  }
  state.me = null;
  deactivate();
  closeAllDialogs();
  render();
  showNotice(message);
}

/** The active profile was deleted or access removed: forget it and fall back to signed-out storage. */
function profileGone(pid) {
  forgetProfile(pid);
  if (state.me) state.me.profiles = state.me.profiles.filter((p) => p.id !== pid);
  deactivate();
  closeAllDialogs();
  render();
  showNotice(GONE_MSG);
}

// ---- Sign-in, routing and sign-out ----

async function refreshMe() {
  const r = await api("/me");
  if (r.ok) { state.me = r.data; adoptUnlock(r.data); }
  else if (r.status === 401) state.me = null;
  return r;
}

/** Called with the /me-shaped body after a successful /signin/verify. */
async function afterSignIn(me) {
  const marker = store.getItem(ACTIVE);
  const last = store.getItem(LAST_ACCOUNT);
  let mine = null;
  try { mine = await SD.sha256Hex(`sumdeting:${me.account.email}`); } catch { /* no crypto */ }
  const otherAccount = (last && mine && last !== mine) || (marker && !me.profiles.some((p) => p.id === marker));
  if (otherAccount) {
    // A different account was signed in on this device before: send what it
    // can still send (bounded), then drop its copies.
    if (state.syncPid) await Promise.race([flushNow(), new Promise((r) => setTimeout(r, 3000))]);
    wipeAccountData();
    state.profile = null;
    state.syncPid = null;
    SD.setActiveProfile(null);
    SD.clearChat();
    SD.reloadLocalState();
  }
  state.me = me;
  state.unlockedUntil = 0;
  adoptUnlock(me);
  await rememberAccount(me);
  render();
  await route({ showPicker: true });
}

/** Decide what a signed-in person sees next. */
async function route({ showPicker }) {
  const me = state.me;
  if (!me) return;
  if (me.pendingConsents?.length) return screens.showConsent(me.pendingConsents[0]);
  if (!me.account.setupComplete) {
    if (me.account.type === null) return screens.showSetup();
    return screens.openProfileForm(me.account.type === "parent" ? "parent" : "student-self");
  }
  for (const req of [...(me.pendingRequests ?? [])]) await screens.showRequest(req);
  const list = selectable();
  const marker = store.getItem(ACTIVE);
  const remembered = list.find((p) => p.id === marker);
  if (marker && !remembered) {
    forgetProfile(marker);
    deactivate();
    showNotice(GONE_MSG);
  }
  render();
  if (!showPicker && remembered) return chooseProfile(remembered, { explicit: false });
  if (showPicker || list.length) return screens.openPicker();
}

async function signInWithFragment() {
  const token = parseSigninFragment(location.hash);
  if (!token) return false;
  // Strip the token from the address bar before anything else can see or reuse it.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  const r = await api("/signin/verify", { token });
  if (r.ok && r.data?.signedIn) {
    closeAllDialogs();
    await afterSignIn(r.data);
    return true;
  }
  showNotice(r.status === 0
    ? MESSAGES.network
    : "That sign-in link has expired or was already used. Tap the profile icon to get a new one.");
  return false;
}

async function signOut() {
  if (state.syncPid) await Promise.race([flushNow(), new Promise((r) => setTimeout(r, 3000))]);
  await api("/signout");
  endSessionLocally();
}

/** The local half of an explicit sign-out: drop every cache this account left and close the UI. */
function endSessionLocally() {
  wipeAccountData();
  state.unlockedUntil = 0;
  state.me = null;
  state.profile = null;
  state.syncPid = null;
  clearTimeout(flushTimer);
  flushTimer = null;
  SD.setActiveProfile(null);
  SD.clearChat();
  SD.reloadLocalState();
  closeAllDialogs();
  render();
}

/**
 * Run `action` (which returns an api result). If it fails with parent_locked,
 * email a parent code, ask for it, and retry once it is accepted.
 */
export async function withParentUnlock(action) {
  const first = await action();
  if (errorCode(first) !== "parent_locked") return first;
  const unlocked = await screens.runParentUnlock();
  if (!unlocked) return first;
  return action();
}

async function openParentSection() {
  const r = await withParentUnlock(() => api("/parent/overview"));
  if (!r.ok) {
    if (errorCode(r) !== "parent_locked" && !handleAuthFailure(r, null)) showNotice(messageFor(r));
    return undefined;
  }
  if (state.unlockedUntil <= Date.now()) state.unlockedUntil = Date.now() + UNLOCK_MS;
  return parent.showOverview(r.data);
}

/** A profile's name, level or colour changed (parent section edit). */
function profileChanged(updated) {
  if (!updated?.id || !state.me) return;
  state.me.profiles = state.me.profiles.map((p) => (p.id === updated.id ? { ...p, ...updated } : p));
  if (state.profile?.id === updated.id) state.profile = { ...state.profile, ...updated };
  render();
}

/** A profile was deleted on purpose from this device: forget it quietly. */
function profileRemoved(pid) {
  forgetProfile(pid);
  if (state.me) state.me.profiles = state.me.profiles.filter((p) => p.id !== pid);
  if (state.profile?.id === pid || store.getItem(ACTIVE) === pid) deactivate();
  render();
}

/** The server deleted the account and cleared the cookie: same cleanup as signing out. */
function accountDeleted() {
  endSessionLocally();
  showNotice(DELETED_MSG);
}

const screens = createScreens({
  api, store, state, SD,
  messageFor, errorCode, maskEmail, selectable, isParent,
  h, openDialog, showNotice, busy, errorLine, statusLine,
  afterSignIn, refreshMe, route, chooseProfile, mergeInto, signOut,
  withParentUnlock, openParentSection, handleAuthFailure, confirmDanger, markUnlocked,
  openDeleteAccount: () => parent.openDeleteAccount(),
  openRemoveProfile: (p) => parent.openRemoveProfile(p),
});

const parent = createParentSection({
  api, state, SD, h, openDialog, closeFrom, showNotice, busy, errorLine, statusLine, confirmDanger,
  markLocked, unlockedUntil: () => state.unlockedUntil,
  messageFor, errorCode, maskEmail, withParentUnlock, handleAuthFailure,
  forms: () => screens.forms, profileChanged, profileRemoved, accountDeleted,
});

// ---- Start-up: never blocks practice ----

async function init() {
  render();
  window.addEventListener("hashchange", () => { signInWithFragment(); });
  if (await signInWithFragment()) return;
  const r = await api("/me");
  if (r.ok && r.data?.signedIn) {
    state.me = r.data;
    adoptUnlock(r.data);
    await rememberAccount(r.data);
    await route({ showPicker: false });
  } else if (r.status === 401 && store.getItem(ACTIVE)) {
    dropToSignedOut(SIGNED_OUT_MSG);
  }
}

window.SumDeTingAccount = {
  api, withParentUnlock, refreshMe,
  get me() { return state.me; },
  get profile() { return state.profile; },
};

init().catch((err) => console.error("account start-up failed", err));
