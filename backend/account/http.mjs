export const COOKIE_NAME = "sd_session";
const SESSION_MAX_AGE = 90 * 24 * 3600;
const RENEW_BELOW_MS = 60 * 24 * 3600 * 1000;

const STATUS = {
  bad_request: 400,
  invalid_code: 400,
  not_signed_in: 401,
  forbidden: 403,
  parent_locked: 403,
  awaiting_parent: 403,
  not_found: 404,
  too_many_attempts: 429,
  rate_limited: 429,
  email_is_student: 400,
  email_is_parent: 400,
  already_linked: 400,
};

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const httpError = (code) => new HttpError(STATUS[code] ?? 400, code);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** Parse a raw request body into an object; null when it is not a JSON object. */
export function parseBody(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export const sessionCookie = (id, { secureCookies }) =>
  `${COOKIE_NAME}=${id}; HttpOnly;${secureCookies ? " Secure;" : ""} SameSite=Lax; Path=/api/account; Max-Age=${SESSION_MAX_AGE}`;

export const clearCookie = ({ secureCookies }) =>
  `${COOKIE_NAME}=; HttpOnly;${secureCookies ? " Secure;" : ""} SameSite=Lax; Path=/api/account; Max-Age=0`;

/** Case-insensitive header lookup (Node and Function URLs lower-case names; tests may not). */
export function header(headers, name) {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

function originOf(url) {
  try { return url ? new URL(url).origin : null; } catch { return null; }
}

/**
 * CSRF defence in depth on top of SameSite=Lax: a POST that names another
 * origin is refused, and a POST with a body must be JSON (a plain HTML form
 * can't send application/json without a CORS preflight).
 */
function checkPost(req, deps) {
  if (req.method !== "POST") return null;
  const origin = header(req.headers, "origin");
  const allowed = req.allowedOrigins ?? [originOf(deps.siteUrl)].filter(Boolean);
  if (origin !== undefined && allowed.length && !allowed.includes(origin)) {
    return { status: 403, body: { error: "forbidden" } };
  }
  if (req.hasBody) {
    const type = String(header(req.headers, "content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json")) return { status: 415, body: { error: "bad_request" } };
  }
  return null;
}

export async function buildMe(ctx) {
  const { repo, now } = ctx.deps;
  const { account, session } = ctx;
  const access = await repo.listAccessForAccount(account.id);
  const profiles = [];
  for (const a of access) {
    const p = await repo.getProfile(a.profileId);
    if (!p) continue;
    profiles.push({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      level: p.level,
      colour: p.colour,
      access: a.kind,
      consentStatus: p.consentStatus,
      under13: p.under13,
    });
  }
  const pendingConsents = [];
  for (const invite of await repo.listInvitesForEmail(account.email)) {
    if (invite.kind !== "consent") continue;
    for (const pid of invite.profileIds ?? []) {
      const p = await repo.getProfile(pid);
      if (p && p.consentStatus === "awaiting_parent" && p.parentEmail === account.email) {
        pendingConsents.push({ profileId: p.id, firstName: p.firstName, lastName: p.lastName });
      }
    }
  }
  const pendingRequests = [];
  if (account.type === "student") {
    for (const invite of await repo.listInvitesForEmail(account.email)) {
      if (invite.kind !== "request") continue;
      const requester = await repo.getAccount(invite.fromAccountId);
      if (requester?.type === "parent") pendingRequests.push({ inviteId: invite.id, parentEmail: requester.email });
    }
  }
  return {
    signedIn: true,
    account: {
      id: account.id,
      email: account.email,
      type: account.type,
      setupComplete: account.setupComplete,
      holderOver13: account.holderOver13,
    },
    parentUnlocked: (session?.parentUnlockedUntil ?? 0) > now(),
    profiles,
    pendingRequests,
    pendingConsents,
  };
}

export function createRouter(deps) {
  const routes = [];
  const signInHooks = [];

  async function authenticate(req, auth, res) {
    const sid = req.cookies?.[COOKIE_NAME];
    const fail = () => {
      res.setCookies.push(clearCookie(deps));
      return httpError("not_signed_in");
    };
    if (!sid) throw httpError("not_signed_in");
    let session = await deps.repo.getSession(sid);
    if (!session) throw fail();
    const account = await deps.repo.getAccount(session.accountId);
    if (!account) throw fail();
    await deps.repo.touchActive(account.id);
    if (session.expiresAt - deps.now() < RENEW_BELOW_MS) {
      const renewed = await deps.repo.renewSession(sid);
      if (renewed) {
        session = renewed;
        res.setCookies.push(sessionCookie(sid, deps));
      }
    }
    if (auth === "parentUnlocked" && account.type !== "parent") throw httpError("forbidden");
    if (auth === "parentUnlocked" && !((session.parentUnlockedUntil ?? 0) > deps.now())) {
      throw httpError("parent_locked");
    }
    return { session, account };
  }

  async function dispatch(req) {
    const res = { status: 200, setCookies: [] };
    const out = () => ({
      status: res.status,
      body: res.body,
      ...(res.setCookies.length ? { setCookies: res.setCookies } : {}),
    });
    const refused = checkPost(req, deps);
    if (refused) return refused;
    try {
      const route = routes.find((r) => r.method === req.method && r.path === req.path);
      if (!route) throw httpError("not_found");
      const ctx = { req: { ...req, body: req.body ?? {} }, deps, res, router: dispatch };
      if (route.auth !== "none") Object.assign(ctx, await authenticate(req, route.auth, res));
      res.body = await route.handler(ctx);
      return out();
    } catch (err) {
      if (err instanceof HttpError) {
        res.status = err.status;
        res.body = { error: err.code };
        return out();
      }
      console.error("Account request failed", err);
      res.status = 500;
      res.body = { error: "internal" };
      return out();
    }
  }

  dispatch.deps = deps;
  dispatch.route = (method, path, handler, { auth = "session" } = {}) => {
    routes.push({ method, path, handler, auth });
  };
  dispatch.onSignIn = (fn) => {
    signInHooks.push(fn);
  };
  dispatch.signInHooks = signInHooks;
  return dispatch;
}
