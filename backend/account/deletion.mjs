import { httpError, clearCookie, COOKIE_NAME } from "./http.mjs";
import { revertIfLastConsentGiver } from "./consent.mjs";

const DAY_MS = 86400e3;
const RETENTION_DAYS = 730;
const WARN_DAYS = RETENTION_DAYS - 30;
const WARN_LEAD_DAYS = 30;
const GRACE_DAYS = 7;
const CODE_TTL_SEC = 600;
const HOUR_SEC = 3600;
const WARNING_TOKEN_SEC = 30 * 24 * 3600;

/**
 * Delete an account and everything it owns. Safe to call again after a partial
 * failure. `deps` ({ repo, mailer, now }) lets an under-13 profile this account
 * approved go back to waiting for a parent (see consent.mjs).
 */
export async function deleteAccountCascade(repo, accountId, deps = { repo, now: () => Date.now() }) {
  const account = await repo.getAccount(accountId);
  // Invites first: a consent-giver leaving below creates a fresh consent invite
  // to the parent's email, which must survive.
  for (const invite of await repo.listInvitesFromAccount(accountId)) {
    await repo.deleteInvite(invite.id);
  }
  if (account) {
    for (const invite of await repo.listInvitesForEmail(account.email)) {
      await repo.deleteInvite(invite.id);
    }
  }
  for (const a of await repo.listAccessForAccount(accountId)) {
    if (a.kind === "owner") {
      await repo.deleteProfile(a.profileId);
    } else {
      if (a.consentGiver === true) await revertIfLastConsentGiver({ ...deps, repo }, accountId, a.profileId);
      await repo.revokeAccess(accountId, a.profileId);
    }
  }
  await repo.deleteAccountRecord(accountId);
}

const lastActiveOf = (account) => account.lastActiveAt ?? account.createdAt;

/**
 * Before an idle account is deleted, each child it owns that still has an active
 * guardian (signed in within the retention period) moves to the most recently
 * active one, so the child keeps their progress.
 */
export async function handOverToActiveGuardians(repo, accountId, t) {
  for (const a of await repo.listAccessForAccount(accountId)) {
    if (a.kind !== "owner") continue;
    let best = null;
    const rows = await repo.listAccessForProfile(a.profileId);
    if (rows.some((row) => row.kind === "owner" && row.accountId !== accountId)) {
      // A previous run already handed this child over and stopped part-way.
      await repo.revokeAccess(accountId, a.profileId);
      continue;
    }
    for (const row of rows) {
      if (row.kind !== "guardian" || row.accountId === accountId) continue;
      const g = await repo.getAccount(row.accountId);
      const last = g ? lastActiveOf(g) : undefined;
      if (typeof last !== "number" || t - last > RETENTION_DAYS * DAY_MS) continue;
      if (!best || last > best.last) best = { row, last };
    }
    if (!best) continue;
    // Granting owner replaces the guardian row (same key); then the idle owner's row goes.
    await repo.grantAccess(best.row.accountId, a.profileId, "owner", { consentGiver: best.row.consentGiver });
    await repo.setProfileOwner(a.profileId, best.row.accountId);
    await repo.revokeAccess(accountId, a.profileId);
  }
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
    await deleteAccountCascade(repo, ctx.account.id, ctx.deps);
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
  const deps = { repo, mailer, now };
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
    // A profile that went back to waiting (its approving parent left) counts from then.
    const since = profile.awaitingSince ?? profile.createdAt;
    if (!(typeof since === "number" && t - since > GRACE_DAYS * DAY_MS)) continue;
    const ok = await safe(`awaiting profile ${profile.id}`, async () => {
      // Consent invites are addressed to the parent's email: a keyed query, not a table scan.
      const invites = (profile.parentEmail ? await repo.listInvitesForEmail(profile.parentEmail) : [])
        .filter((i) => i.kind === "consent" && i.profileIds?.includes(profile.id));
      const owner = await repo.getAccount(profile.ownerAccountId);
      const ownerIsStudent = owner?.type === "student";
      // Flag first so a failed cascade is finished by the next run.
      if (ownerIsStudent) await repo.updateAccount(owner.id, { pendingCascade: true });
      await repo.deleteProfile(profile.id);
      for (const i of invites) await repo.deleteInvite(i.id);
      if (ownerIsStudent) {
        const owned = (await repo.listAccessForAccount(owner.id)).filter((a) => a.kind === "owner");
        if (owned.length === 0) await deleteAccountCascade(repo, owner.id, deps);
        else await repo.updateAccount(owner.id, { pendingCascade: false });
      }
      return true;
    });
    if (ok) result.deletedAwaiting++;
  }

  for (const account of await repo.listAccounts()) {
    await safe(`account ${account.id}`, async () => {
      const lastActive = lastActiveOf(account);
      const idleDays = typeof lastActive === "number" ? (t - lastActive) / DAY_MS : 0;
      const warnedLongEnough =
        typeof account.warningSentAt === "number" && t - account.warningSentAt >= WARN_LEAD_DAYS * DAY_MS;
      if (idleDays > RETENTION_DAYS && warnedLongEnough) {
        await handOverToActiveGuardians(repo, account.id, t);
        await deleteAccountCascade(repo, account.id, deps);
        result.deletedAccounts++;
      } else if (account.setupComplete !== true && t - account.createdAt > GRACE_DAYS * DAY_MS) {
        await deleteAccountCascade(repo, account.id, deps);
        result.deletedUnfinished++;
      } else if (
        account.type === "student" &&
        account.pendingCascade === true &&
        !(await repo.listAccessForAccount(account.id)).some((a) => a.kind === "owner")
      ) {
        // Flagged by an awaiting sweep whose cascade failed part-way.
        await deleteAccountCascade(repo, account.id, deps);
        result.deletedAwaiting++;
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
