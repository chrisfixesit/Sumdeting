import { httpError } from "./http.mjs";
import { childSummary } from "./progress.mjs";

const UNLOCK_MS = 15 * 60 * 1000;
const CODE_TTL_SEC = 600;
const HOUR_SEC = 3600;

function requireParent(ctx) {
  if (ctx.account.type !== "parent") throw httpError("forbidden");
}

export function register(router) {
  router.route("POST", "/parent/unlock/start", async (ctx) => {
    requireParent(ctx);
    const { repo, mailer } = ctx.deps;
    const id = ctx.account.id;
    if (!(await repo.hitRate(`parent:unlock:${id}`, HOUR_SEC, 5))) throw httpError("rate_limited");
    const code = await repo.issueCode("parent_unlock", id, CODE_TTL_SEC);
    await mailer.send("parent_code", ctx.account.email, { code });
    return {};
  });

  router.route("POST", "/parent/unlock/verify", async (ctx) => {
    requireParent(ctx);
    const { repo, now } = ctx.deps;
    const { code } = ctx.req.body;
    if (typeof code !== "string" || !code) throw httpError("bad_request");
    const result = await repo.checkCode("parent_unlock", ctx.account.id, code);
    if (result === "locked") throw httpError("too_many_attempts");
    if (result !== "ok") throw httpError("invalid_code");
    await repo.setParentUnlocked(ctx.session.id, now() + UNLOCK_MS);
    return { parentUnlocked: true };
  });

  // Closing the parent section, handing the device to a child, or closing the app re-locks it.
  router.route("POST", "/parent/lock", async (ctx) => {
    requireParent(ctx);
    await ctx.deps.repo.setParentUnlocked(ctx.session.id, 0);
    return { parentUnlocked: false };
  });

  router.route(
    "POST",
    "/parent/overview",
    async (ctx) => {
      requireParent(ctx);
      const { repo } = ctx.deps;
      const children = [];
      for (const a of await repo.listAccessForAccount(ctx.account.id)) {
        const p = await repo.getProfile(a.profileId);
        if (!p || p.consentStatus === "awaiting_parent") continue;
        const { progress } = await repo.getProgress(p.id);
        children.push({
          profileId: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          level: p.level,
          colour: p.colour,
          access: a.kind,
          summary: childSummary(progress),
        });
      }
      children.sort(
        (x, y) => x.firstName.localeCompare(y.firstName) || x.lastName.localeCompare(y.lastName)
      );
      return { children };
    },
    { auth: "parentUnlocked" }
  );
}
