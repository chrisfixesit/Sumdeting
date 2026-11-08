import { normaliseEmail } from "./tokens.mjs";
import { HttpError, httpError } from "./http.mjs";
import { deleteAccountCascade } from "./deletion.mjs";
import { limitRecipient } from "./links.mjs";

export const LEVELS = ["Common Entrance", "CSEC", "Additional Maths", "CAPE"];
export const COLOURS = ["#F4C143", "#BFD0FF", "#C8E6C9", "#F8C9B8", "#E1C6F2", "#FFE0A3"];

const UNLOCK_MS = 15 * 60 * 1000;
const CONSENT_TOKEN_SEC = 7 * 24 * 3600;
const HOUR_SEC = 3600;
const MAX_PROFILES = 10;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const bad = () => httpError("bad_request");
const forbidden = () => httpError("forbidden");

function cleanName(value) {
  if (typeof value !== "string") throw bad();
  const v = value.trim();
  if (v.length < 1 || v.length > 40 || CONTROL.test(v)) throw bad();
  return v;
}

function cleanLevel(v) {
  if (!LEVELS.includes(v)) throw bad();
  return v;
}

function cleanColour(v) {
  if (!COLOURS.includes(v)) throw bad();
  return v;
}

const isUnlocked = (ctx) => (ctx.session?.parentUnlockedUntil ?? 0) > ctx.deps.now();

async function sendConsentRequest(deps, parentEmail, childFirstName) {
  const token = await deps.repo.issueToken("signin", parentEmail, CONSENT_TOKEN_SEC);
  await deps.mailer.send("consent_request", parentEmail, { token, childFirstName });
}

export function register(router) {
  router.route("POST", "/setup", async (ctx) => {
    const { repo, now } = ctx.deps;
    const { type, holderOver13 } = ctx.req.body;
    if (type !== "parent" && type !== "student") throw bad();
    if (ctx.account.type !== null || ctx.account.setupComplete) throw bad();
    if (type === "student" && typeof holderOver13 !== "boolean") throw bad();
    // A parent's setup is complete at once: their only child may already have
    // their own account, so they may never add a profile here.
    await repo.updateAccount(
      ctx.account.id,
      type === "student" ? { type, holderOver13 } : { type, setupComplete: true }
    );
    if (type === "parent") await repo.setParentUnlocked(ctx.session.id, now() + UNLOCK_MS);
    return {};
  });

  router.route("POST", "/profiles/create", async (ctx) => {
    const { repo } = ctx.deps;
    const { account } = ctx;
    const b = ctx.req.body;
    const firstName = cleanName(b.firstName);
    const lastName = cleanName(b.lastName);
    const level = cleanLevel(b.level);
    const colour = cleanColour(b.colour);

    const owned = (await repo.listAccessForAccount(account.id)).filter((a) => a.kind === "owner");
    if (owned.length >= MAX_PROFILES) throw forbidden();
    let fields;
    let invitee = null;

    if (account.type === "parent") {
      if (!isUnlocked(ctx)) throw httpError("parent_locked");
      if (b.consent !== true) throw bad();
      fields = { under13: null, consentStatus: "active", consentBy: account.id, consentAt: ctx.deps.now() };
    } else if (account.type === "student") {
      if (typeof account.holderOver13 !== "boolean") throw forbidden();
      // The first profile is the holder's own, so the /setup answer decides over13.
      const first = owned.length === 0;
      if (!first && account.holderOver13 === false) throw forbidden();
      const over13 = first ? account.holderOver13 : b.over13;
      if (typeof over13 !== "boolean") throw bad();
      if (over13) {
        if (b.consent !== true) throw bad();
        fields = { under13: false, consentStatus: "active", consentBy: account.id, consentAt: ctx.deps.now() };
      } else {
        const parentEmail = normaliseEmail(b.parentEmail);
        if (!parentEmail || parentEmail === account.email) throw bad();
        if (!(await repo.hitRate(`consent:create:${account.id}`, HOUR_SEC, 5))) {
          throw httpError("rate_limited");
        }
        const existing = await repo.findAccountByEmail(parentEmail);
        if (existing?.type === "student") throw new HttpError(400, "parent_email_is_student");
        await limitRecipient(ctx, parentEmail);
        fields = { under13: true, consentStatus: "awaiting_parent", parentEmail };
        invitee = parentEmail;
      }
    } else {
      throw forbidden();
    }

    const profile = await repo.createProfile(account.id, { firstName, lastName, level, colour, ...fields });
    if (invitee) {
      await repo.createInvite({
        kind: "consent",
        fromAccountId: account.id,
        toEmail: invitee,
        profileIds: [profile.id],
      });
      await sendConsentRequest(ctx.deps, invitee, firstName);
    }
    if (!account.setupComplete) await repo.updateAccount(account.id, { setupComplete: true });
    return {
      profile: {
        id: profile.id,
        firstName,
        lastName,
        level,
        colour,
        consentStatus: profile.consentStatus,
        under13: profile.under13,
      },
    };
  });

  router.route("POST", "/profiles/update", async (ctx) => {
    const { repo } = ctx.deps;
    const b = ctx.req.body;
    if (typeof b.profileId !== "string" || !b.profileId) throw bad();
    const kind = await repo.getAccess(ctx.account.id, b.profileId);
    if (kind !== "owner" && kind !== "guardian") throw forbidden();
    if (ctx.account.type === "parent" && !isUnlocked(ctx)) throw httpError("parent_locked");
    const patch = {};
    if (b.firstName !== undefined) patch.firstName = cleanName(b.firstName);
    if (b.lastName !== undefined) patch.lastName = cleanName(b.lastName);
    if (b.level !== undefined) patch.level = cleanLevel(b.level);
    if (b.colour !== undefined) patch.colour = cleanColour(b.colour);
    const updated = await repo.updateProfile(b.profileId, patch);
    if (!updated) throw httpError("not_found");
    return {
      profile: {
        id: updated.id,
        firstName: updated.firstName,
        lastName: updated.lastName,
        level: updated.level,
        colour: updated.colour,
      },
    };
  });

  router.route("POST", "/consent/respond", async (ctx) => {
    const { repo, now } = ctx.deps;
    const { profileId, approve } = ctx.req.body;
    if (typeof profileId !== "string" || !profileId || typeof approve !== "boolean") throw bad();
    const { account } = ctx;
    if (account.type === "student") throw new HttpError(400, "parent_email_is_student");
    if (account.type === "parent" && !isUnlocked(ctx)) throw httpError("parent_locked");
    const invite = (await repo.listInvitesForEmail(account.email)).find(
      (i) => i.kind === "consent" && i.profileIds?.includes(profileId)
    );
    const profile = invite ? await repo.getProfile(profileId) : null;
    if (!invite || !profile || profile.parentEmail !== account.email) throw forbidden();
    if (profile.consentStatus !== "awaiting_parent") throw forbidden();

    if (approve) {
      await repo.grantAccess(account.id, profileId, "view_only", { consentGiver: true });
      await repo.updateProfile(profileId, {
        consentStatus: "active",
        consentBy: account.id,
        consentAt: now(),
      });
      if (account.type === null) {
        await repo.updateAccount(account.id, { type: "parent", setupComplete: true });
      }
      await repo.deleteInvite(invite.id);
    } else {
      const ownerId = profile.ownerAccountId;
      await repo.deleteProfile(profileId);
      await repo.deleteInvite(invite.id);
      const owner = await repo.getAccount(ownerId);
      if (owner?.type === "student" && !(await repo.listAccessForAccount(ownerId)).some((a) => a.kind === "owner")) {
        await deleteAccountCascade(repo, ownerId);
      }
    }
    return {};
  });

  router.route("POST", "/consent/resend", async (ctx) => {
    const { repo } = ctx.deps;
    const { profileId } = ctx.req.body;
    if (typeof profileId !== "string" || !profileId) throw bad();
    const profile = await repo.getProfile(profileId);
    if (
      !profile ||
      profile.consentStatus !== "awaiting_parent" ||
      (await repo.getAccess(ctx.account.id, profileId)) !== "owner"
    ) {
      throw forbidden();
    }
    if (!(await repo.hitRate(`consent:resend:${ctx.account.id}`, HOUR_SEC, 5))) {
      throw httpError("rate_limited");
    }
    await limitRecipient(ctx, profile.parentEmail);
    // Replace the invite so it gets a fresh 30-day ttl.
    const invites = await repo.listInvitesForEmail(profile.parentEmail);
    for (const i of invites) {
      if (i.kind === "consent" && i.profileIds?.includes(profileId)) await repo.deleteInvite(i.id);
    }
    await repo.createInvite({
      kind: "consent",
      fromAccountId: ctx.account.id,
      toEmail: profile.parentEmail,
      profileIds: [profileId],
    });
    await sendConsentRequest(ctx.deps, profile.parentEmail, profile.firstName);
    return {};
  });
}
