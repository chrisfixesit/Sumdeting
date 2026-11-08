// Pure client helpers for cross-device progress. No browser globals at import
// time: storage and fetch are injected so everything is testable in Node.

const MASTERY_ANON = "mathmentor.mastery.v1";
const PREFS_ANON = "mathmentor.prefs.v1";
const SESSION_KEY = "mathmentor.session.v1";
const ACTIVE_PROFILE_KEY = "sumdeting.activeProfile";
const QUEUE_PREFIX = "sumdeting.queue.";
const BATCH = 100;

/** Build a POST helper: (path, body) -> { ok, status, data }. Never throws. */
export function createApi({ fetchImpl, sha256Hex, base = "/api/account" }) {
  return async (path, body = {}) => {
    try {
      const payload = JSON.stringify(body);
      const r = await fetchImpl(base + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-amz-content-sha256": await sha256Hex(payload) },
        body: payload,
      });
      let data = null;
      try { data = await r.json(); } catch { /* empty or non-JSON body */ }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  };
}

/** Persistent per-profile event queue stored at sumdeting.queue.<pid>. */
export function createQueue(storage, pid) {
  const key = QUEUE_PREFIX + pid;
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(key));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  };
  const write = (items) => {
    try {
      if (items.length) storage.setItem(key, JSON.stringify(items));
      else storage.removeItem(key);
    } catch { /* storage full or blocked: events stay in memory-less limbo, local state is unaffected */ }
  };
  return {
    push(event) { write([...read(), event]); },
    size() { return read().length; },
    /**
     * Send up to 100 events. 200 -> 'ok' (sent events removed); 401 -> 'signedOut'
     * (kept); 404/403 -> 'gone' (dropped); 0/429/5xx -> 'retry' (kept). A 400 means
     * the batch itself is bad: drop the sent batch, warn, and return 'retry' only
     * if items remain, else 'ok'.
     */
    async flush(api) {
      const items = read();
      if (!items.length) return "ok";
      const sent = items.slice(0, BATCH);
      const { ok, status } = await api("/progress/sync", { profileId: pid, events: sent });
      if (ok) { write(items.slice(sent.length)); return "ok"; }
      if (status === 401) return "signedOut";
      if (status === 404 || status === 403) { write([]); return "gone"; }
      if (status === 400) {
        console.warn("progress sync: dropping rejected batch of", sent.length);
        const rest = items.slice(sent.length);
        write(rest);
        return rest.length ? "retry" : "ok";
      }
      return "retry";
    },
  };
}

const readJson = (storage, key) => {
  try { return JSON.parse(storage.getItem(key)); } catch { return null; }
};

/** True if the signed-out mastery blob has any attempts, solves or a streak. */
export function hasAnonymousProgress(storage) {
  const m = readJson(storage, MASTERY_ANON);
  if (!m || typeof m !== "object") return false;
  if ((m.streak?.count ?? 0) > 0) return true;
  return Object.values(m.topics ?? {}).some((t) => (t?.attempted ?? 0) + (t?.solved ?? 0) > 0);
}

/** Read the signed-out mastery and prefs blobs (null when absent or corrupt). */
export function readAnonymous(storage) {
  return { mastery: readJson(storage, MASTERY_ANON), prefs: readJson(storage, PREFS_ANON) };
}

/** Remove the signed-out mastery and prefs blobs. */
export function clearAnonymous(storage) {
  storage.removeItem(MASTERY_ANON);
  storage.removeItem(PREFS_ANON);
}

/** Remove all per-profile caches, the chat session and the active-profile marker. */
export function clearProfileCaches(storage) {
  const doomed = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && (k.startsWith("mathmentor.mastery.") || k.startsWith("mathmentor.prefs.") || k.startsWith(QUEUE_PREFIX))
      && k !== MASTERY_ANON && k !== PREFS_ANON) doomed.push(k);
  }
  for (const k of doomed) storage.removeItem(k);
  storage.removeItem(SESSION_KEY);
  storage.removeItem(ACTIVE_PROFILE_KEY);
}

const LABELS = { hard: "Finding it hard", confident: "Confident", getting_there: "Getting there" };
/** Human label for a topic status. */
export const statusLabel = (status) => LABELS[status] ?? "";

/** Two upper-case initials from first and last name. */
export const initials = (first, last) =>
  ((first ?? "").trim()[0] ?? "").toUpperCase() + ((last ?? "").trim()[0] ?? "").toUpperCase();

/** Read the token from a "#signin=<token>" hash, else null. */
export function parseSigninFragment(hash) {
  const m = /^#signin=([^&]+)$/.exec(hash ?? "");
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** Fresh id for /progress/merge. */
export const newMergeId = () => crypto.randomUUID();
