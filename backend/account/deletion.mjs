import { httpError, clearCookie, COOKIE_NAME } from "./http.mjs";

const DAY_MS = 86400e3;
const RETENTION_DAYS = 730;
const WARN_DAYS = RETENTION_DAYS - 30;
const GRACE_DAYS = 7;
const CODE_TTL_SEC = 600;
const HOUR_SEC = 3600;
const WARNING_TOKEN_SEC = 30 * 24 * 3600;

/** Delete an account and everything it owns. Safe to call again after a partial failure. */
export async function deleteAccountCascade(repo, accountId) {
  const account = await repo.getAccount(accountId);
  for (const a of await repo.listAccessForAccount(accountId)) {
    if (a.kind === "owner") await repo.deleteProfile(a.profileId);
    else await repo.revokeAccess(accountId, a.profileId);
  }
  for (const invite of await repo.listInvitesFromAccount(accountId)) {
    await repo.deleteInvite(invite.id);
  }
  if (account) {
    for (const invite of await repo.listInvitesForEmail(account.email)) {
      await repo.deleteInvite(invite.id);
    }
  }
  await repo.deleteAccountRecord(accountId);
}

const isUnlocked = (ctx) => (ctx.session?.parentUnlockedUntil ?? 0) > ctx.deps.now();

/** Parents need an unlocked session; students need an emailed code; unset accounts need nothing. */
async function requireDeleteLock(ctx, code) {
  const { account } = ctx;
  if (account.type === "parent") {
    if (!isUnlocked(ctx)) throw httpError("parent_locked");
  } else if (account.type === "student") {
    if (typeof code !== "string" || !code) throw httpError("invalid_code");
    const result = await ctx.deps.repo.checkCode("confirm_delete", account.id, code);
    if (result === "locked") throw httpError("too_many_attempts");
    if (result !== "ok") throw httpError("invalid_code");
  }
}

export function register(router) {
  router.route("POST", "/delete/start", async (ctx) => {
    if (ctx.account.type !== "student") throw httpError("forbidden");
    const { repo, mailer } = ctx.deps;
    const id = ctx.account.id;
    if (!(await repo.hitRate(`delete:start:${id}`, HOUR_SEC, 5))) throw httpError("rate_limited");
    const code = await repo.issueCode("confirm_delete", id, CODE_TTL_SEC);
    await mailer.send("confirm_delete", ctx.account.email, { code });
    return {};
  });

  router.route("POST", "/profiles/delete", async (ctx) => {
    const { repo } = ctx.deps;
    const { profileId, code } = ctx.req.body;
    if (typeof profileId !== "string" || !profileId) throw httpError("bad_request");
    const kind = await repo.getAccess(ctx.account.id, profileId);
    if (!kind) throw httpError("not_found");
    if (kind !== "owner") throw httpError("forbidden");
    await requireDeleteLock(ctx, code);
    await repo.deleteProfile(profileId);
    return {};
  });

  router.route("POST", "/account/delete", async (ctx) => {
    const { repo } = ctx.deps;
    await requireDeleteLock(ctx, ctx.req.body.code);
    await deleteAccountCascade(repo, ctx.account.id);
    const sid = ctx.req.cookies?.[COOKIE_NAME];
    if (sid) await repo.deleteSession(sid);
    ctx.res.setCookies.push(clearCookie(ctx.deps));
    return {};
  });
}

/** Scheduled retention sweep. Idempotent; a failure on one record is logged and skipped. */
export async function runJanitor({ repo, mailer, now = () => Date.now() }) {
  const result = { warned: 0, deletedAccounts: 0, deletedAwaiting: 0, deletedUnfinished: 0 };
  const t = now();
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`Janitor: ${label} failed`, err);
      return false;
    }
  };

  // Consent never given within the grace period.
  for (const profile of await repo.listProfiles()) {
    if (profile.consentStatus !== "awaiting_parent") continue;
    if (!(typeof profile.createdAt === "number" && t - profile.createdAt > GRACE_DAYS * DAY_MS)) continue;
    const ok = await safe(`awaiting profile ${profile.id}`, async () => {
      const invites = [
        ...(await repo.listInvitesFromAccount(profile.ownerAccountId)),
        ...(profile.parentEmail ? await repo.listInvitesForEmail(profile.parentEmail) : []),
      ];
      await repo.deleteProfile(profile.id);
      const seen = new Set();
      for (const i of invites) {
        if (seen.has(i.id) || i.kind !== "consent" || !i.profileIds?.includes(profile.id)) continue;
        seen.add(i.id);
        await repo.deleteInvite(i.id);
      }
      const owner = await repo.getAccount(profile.ownerAccountId);
      if (owner?.type === "student") {
        const owned = (await repo.listAccessForAccount(owner.id)).filter((a) => a.kind === "owner");
        if (owned.length === 0) await deleteAccountCascade(repo, owner.id);
      }
      return true;
    });
    if (ok) result.deletedAwaiting++;
  }

  for (const account of await repo.listAccounts()) {
    await safe(`account ${account.id}`, async () => {
      const lastActive = account.lastActiveAt ?? account.createdAt;
      const idleDays = typeof lastActive === "number" ? (t - lastActive) / DAY_MS : 0;
      if (idleDays > RETENTION_DAYS) {
        await deleteAccountCascade(repo, account.id);
        result.deletedAccounts++;
      } else if (account.setupComplete !== true && t - account.createdAt > GRACE_DAYS * DAY_MS) {
        await deleteAccountCascade(repo, account.id);
        result.deletedUnfinished++;
      } else if (idleDays > WARN_DAYS && !account.warningSentAt) {
        const token = await repo.issueToken("signin", account.email, WARNING_TOKEN_SEC);
        await mailer.send("retention_warning", account.email, { token });
        await repo.updateAccount(account.id, { warningSentAt: t });
        result.warned++;
      }
    });
  }
  return result;
}
