import { normaliseEmail } from "./tokens.mjs";
import { httpError } from "./http.mjs";

const SIGNIN_TTL_SEC = 7 * 24 * 3600;
const HOUR_SEC = 3600;
const RANK = { view_only: 1, guardian: 2, owner: 3 };

const bad = () => httpError("bad_request");
const forbidden = () => httpError("forbidden");
const notFound = () => httpError("not_found");

const isUnlocked = (ctx) => (ctx.session?.parentUnlockedUntil ?? 0) > ctx.deps.now();

function requireUnlockedParent(ctx) {
  if (ctx.account.type === "parent" && !isUnlocked(ctx)) throw httpError("parent_locked");
}

function cleanId(v) {
  if (typeof v !== "string" || !v) throw bad();
  return v;
}

function cleanTarget(ctx, raw) {
  const email = normaliseEmail(raw);
  if (!email || email === ctx.account.email) throw bad();
  return email;
}

async function limitSends(ctx) {
  if (!(await ctx.deps.repo.hitRate(`links:send:${ctx.account.id}`, HOUR_SEC, 5))) {
    throw httpError("rate_limited");
  }
}

async function sendWithToken(ctx, template, email, vars) {
  const token = await ctx.deps.repo.issueToken("signin", email, SIGNIN_TTL_SEC);
  await ctx.deps.mailer.send(template, email, { token, ...vars });
}

/** The single removal rule, shared by links/list (removable flag) and links/remove. */
export function canRemove({ callerId, callerKind, targetId, target, profile }) {
  if (callerId === targetId) return target.kind === "guardian" || target.kind === "view_only";
  if (callerKind !== "owner") return false;
  if (target.kind === "guardian") return true;
  if (target.kind === "view_only") return !(target.consentGiver === true && profile.under13 === true);
  return false;
}

/** Apply share/guardian invites addressed to this account's email. Idempotent. */
export async function applyInvitesForAccount(ctx, account) {
  const { repo } = ctx.deps;
  const invites = await repo.listInvitesForEmail(account.email);
  let current = account;
  for (const invite of invites) {
    if (invite.kind !== "share" && invite.kind !== "guardian") continue;
    if (current.type === "student") continue;
    if (current.type === null) {
      await repo.updateAccount(current.id, { type: "parent", setupComplete: true });
      current = { ...current, type: "parent", setupComplete: true };
    }
    const kind = invite.kind === "share" ? "view_only" : "guardian";
    for (const pid of invite.profileIds ?? []) {
      if (!(await repo.getProfile(pid))) continue;
      const existing = await repo.getAccess(current.id, pid);
      if (existing && RANK[existing] >= RANK[kind]) continue;
      await repo.grantAccess(current.id, pid, kind);
    }
    await repo.deleteInvite(invite.id);
  }
  return current;
}

async function loadProfileAccess(ctx, profileId) {
  const kind = await ctx.deps.repo.getAccess(ctx.account.id, profileId);
  if (!kind) throw notFound();
  const profile = await ctx.deps.repo.getProfile(profileId);
  if (!profile) throw notFound();
  return { kind, profile };
}

export function register(router) {
  router.onSignIn(applyInvitesForAccount);

  router.route("POST", "/links/share", async (ctx) => {
    const { repo } = ctx.deps;
    const profileId = cleanId(ctx.req.body.profileId);
    const email = cleanTarget(ctx, ctx.req.body.parentEmail);
    if (ctx.account.type !== "student") throw forbidden();
    if ((await repo.getAccess(ctx.account.id, profileId)) !== "owner") throw forbidden();
    const profile = await repo.getProfile(profileId);
    if (!profile) throw notFound();
    if (profile.consentStatus !== "active") throw httpError("awaiting_parent");
    if ((await repo.findAccountByEmail(email))?.type === "student") throw httpError("email_is_student");
    await limitSends(ctx);
    await repo.createInvite({
      kind: "share",
      fromAccountId: ctx.account.id,
      toEmail: email,
      profileIds: [profileId],
    });
    await sendWithToken(ctx, "share", email, { studentFirstName: profile.firstName });
    return {};
  });

  router.route("POST", "/links/request", async (ctx) => {
    const { repo } = ctx.deps;
    const email = cleanTarget(ctx, ctx.req.body.childEmail);
    if ((await repo.findAccountByEmail(email))?.type === "parent") throw httpError("email_is_parent");
    await limitSends(ctx);
    for (const i of await repo.listInvitesForEmail(email)) {
      if (i.kind === "request" && i.fromAccountId === ctx.account.id) await repo.deleteInvite(i.id);
    }
    await repo.createInvite({
      kind: "request",
      fromAccountId: ctx.account.id,
      toEmail: email,
      profileIds: [],
    });
    await sendWithToken(ctx, "access_request", email, { parentEmail: ctx.account.email });
    return {};
  }, { auth: "parentUnlocked" });

  router.route("POST", "/links/respond", async (ctx) => {
    const { repo } = ctx.deps;
    const { account } = ctx;
    const { inviteId, allow, profileIds } = ctx.req.body;
    if (typeof inviteId !== "string" || !inviteId || typeof allow !== "boolean") throw bad();
    const invite = (await repo.listInvitesForEmail(account.email)).find(
      (i) => i.id === inviteId && i.kind === "request"
    );
    if (!invite) throw notFound();
    if (account.type !== "student") throw forbidden();
    const requester = await repo.getAccount(invite.fromAccountId);
    if (!requester || requester.type !== "parent") {
      await repo.deleteInvite(invite.id);
      throw notFound();
    }
    if (allow) {
      if (!Array.isArray(profileIds) || profileIds.length < 1) throw bad();
      const ids = [...new Set(profileIds)];
      for (const pid of ids) {
        if (typeof pid !== "string") throw bad();
        if ((await repo.getAccess(account.id, pid)) !== "owner") throw forbidden();
        if ((await repo.getProfile(pid))?.consentStatus !== "active") throw forbidden();
      }
      for (const pid of ids) {
        if (!(await repo.getAccess(requester.id, pid))) await repo.grantAccess(requester.id, pid, "view_only");
      }
    }
    await repo.deleteInvite(invite.id);
    return {};
  });

  router.route("POST", "/links/invite-guardian", async (ctx) => {
    const { repo } = ctx.deps;
    const profileId = cleanId(ctx.req.body.profileId);
    const email = cleanTarget(ctx, ctx.req.body.email);
    const kind = await repo.getAccess(ctx.account.id, profileId);
    if (kind !== "owner" && kind !== "guardian") throw forbidden();
    const profile = await repo.getProfile(profileId);
    if (!profile) throw notFound();
    const target = await repo.findAccountByEmail(email);
    if (target?.type === "student") throw httpError("email_is_student");
    if (target && (await repo.getAccess(target.id, profileId))) throw httpError("already_linked");
    await limitSends(ctx);
    for (const i of await repo.listInvitesForEmail(email)) {
      if (i.kind === "guardian" && i.fromAccountId === ctx.account.id && i.profileIds?.includes(profileId)) {
        await repo.deleteInvite(i.id);
      }
    }
    await repo.createInvite({
      kind: "guardian",
      fromAccountId: ctx.account.id,
      toEmail: email,
      profileIds: [profileId],
    });
    await sendWithToken(ctx, "guardian_invite", email, {
      childFirstName: profile.firstName,
      inviterEmail: ctx.account.email,
    });
    return {};
  }, { auth: "parentUnlocked" });

  router.route("POST", "/links/list", async (ctx) => {
    const { repo } = ctx.deps;
    const profileId = cleanId(ctx.req.body.profileId);
    const kind = await repo.getAccess(ctx.account.id, profileId);
    if (kind !== "owner" && kind !== "guardian") throw forbidden();
    requireUnlockedParent(ctx);
    const profile = await repo.getProfile(profileId);
    if (!profile) throw notFound();
    const people = [];
    for (const a of await repo.listAccessForProfile(profileId)) {
      if (a.accountId === ctx.account.id) continue;
      const acct = await repo.getAccount(a.accountId);
      if (!acct) continue;
      people.push({
        accountId: a.accountId,
        email: acct.email,
        kind: a.kind,
        removable: canRemove({
          callerId: ctx.account.id,
          callerKind: kind,
          targetId: a.accountId,
          target: a,
          profile,
        }),
      });
    }
    return { people };
  });

  router.route("POST", "/links/remove", async (ctx) => {
    const { repo } = ctx.deps;
    const profileId = cleanId(ctx.req.body.profileId);
    const accountId = cleanId(ctx.req.body.accountId);
    const { kind, profile } = await loadProfileAccess(ctx, profileId);
    requireUnlockedParent(ctx);
    const rows = await repo.listAccessForProfile(profileId);
    const target = rows.find((a) => a.accountId === accountId);
    if (!target) throw notFound();
    if (!canRemove({ callerId: ctx.account.id, callerKind: kind, targetId: accountId, target, profile })) {
      throw forbidden();
    }
    await repo.revokeAccess(accountId, profileId);
    return {};
  });
}
