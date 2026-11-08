import { newToken, newCode, normaliseEmail } from "./tokens.mjs";
import { applyInvitesForAccount } from "./links.mjs";
import { httpError, buildMe, sessionCookie, clearCookie, COOKIE_NAME } from "./http.mjs";

const SIGNIN_TTL_SEC = 900;
const HOUR_SEC = 3600;

export function register(router) {
  router.route("POST", "/signin/start", async (ctx) => {
    const { repo, mailer } = ctx.deps;
    const email = normaliseEmail(ctx.req.body.email);
    if (!email) throw httpError("bad_request");
    const ipLimit = ctx.deps.signinIpLimit ?? 30;
    if (!(await repo.hitRate(`signin:ip:${ctx.req.ip}`, HOUR_SEC, ipLimit))) throw httpError("rate_limited");
    if (!(await repo.hitRate(`signin:email:${email}`, HOUR_SEC, 5))) throw httpError("rate_limited");
    const token = await repo.issueToken("signin", email, SIGNIN_TTL_SEC);
    const code = await repo.issueCode("signin", email, SIGNIN_TTL_SEC);
    await mailer.send("signin", email, { token, code });
    return {};
  }, { auth: "none" });

  router.route("POST", "/signin/verify", async (ctx) => {
    const { repo } = ctx.deps;
    const { token, email: rawEmail, code } = ctx.req.body;
    let email;
    if (typeof token === "string" && token) {
      const consumed = await repo.consumeToken(token, "signin");
      if (!consumed) throw httpError("invalid_code");
      email = consumed.email;
    } else if (typeof code === "string" && code && rawEmail !== undefined) {
      email = normaliseEmail(rawEmail);
      if (!email) throw httpError("bad_request");
      const result = await repo.checkCode("signin", email, code);
      if (result === "locked") throw httpError("too_many_attempts");
      if (result !== "ok") throw httpError("invalid_code");
    } else {
      throw httpError("bad_request");
    }
    const account = (await repo.findAccountByEmail(email)) ?? (await repo.createAccount(email));
    const session = await repo.createSession(account.id);
    await repo.touchActive(account.id);
    ctx.res.setCookies.push(sessionCookie(session.id, ctx.deps));
    const fresh = await repo.getSession(session.id);
    const inner = { ...ctx, session: fresh, account: (await repo.getAccount(account.id)) ?? account };
    for (const hook of ctx.router?.signInHooks ?? []) {
      try {
        await hook(inner, inner.account);
      } catch (err) {
        console.error("onSignIn hook failed", err);
      }
    }
    inner.account = (await repo.getAccount(account.id)) ?? inner.account;
    return buildMe(inner);
  }, { auth: "none" });

  router.route(
    "POST",
    "/signout",
    async (ctx) => {
      const sid = ctx.req.cookies?.[COOKIE_NAME];
      if (sid) await ctx.deps.repo.deleteSession(sid);
      ctx.res.setCookies.push(clearCookie(ctx.deps));
      return {};
    },
    { auth: "none" }
  );

  router.route("POST", "/me", async (ctx) => {
    let account = ctx.account;
    try {
      account = await applyInvitesForAccount(ctx, account);
    } catch (err) {
      console.error("applyInvites failed", err);
    }
    return buildMe({ ...ctx, account });
  }, { auth: "session" });

  if (router.deps.dev) {
    router.route("GET", "/_dev/outbox", (ctx) => ctx.deps.mailer.outbox ?? [], { auth: "none" });
  }
}
