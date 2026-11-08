// What happens to an under-13 profile when the parent who approved it leaves.
// Kept free of other feature imports so links, profiles and deletion can all use it.

const CONSENT_TOKEN_SEC = 7 * 24 * 3600;

/** Email a parent a consent request with a 7-day sign-in link. */
export async function sendConsentRequest(deps, parentEmail, childFirstName) {
  const token = await deps.repo.issueToken("signin", parentEmail, CONSENT_TOKEN_SEC);
  await deps.mailer.send("consent_request", parentEmail, { token, childFirstName });
}

/**
 * Call before `accountId` loses its access to `pid` without withdrawing
 * consent (removing their own link, deleting their account, retention). If they
 * were the only remaining consent-giver on an active under-13 profile, the
 * profile goes back to waiting for a parent: server-side progress is deleted
 * (nothing may be stored without consent), and the parent is asked again.
 * Returns true when the profile was reverted.
 */
export async function revertIfLastConsentGiver(deps, accountId, pid) {
  const { repo, now } = deps;
  const profile = await repo.getProfile(pid);
  if (!profile || profile.under13 !== true || profile.consentStatus !== "active") return false;
  const rows = await repo.listAccessForProfile(pid);
  const mine = rows.find((r) => r.accountId === accountId);
  if (mine?.consentGiver !== true) return false;
  if (rows.some((r) => r.accountId !== accountId && r.consentGiver === true)) return false;
  await repo.updateProfile(pid, { consentStatus: "awaiting_parent", awaitingSince: now() });
  await repo.deleteProgress(pid);
  if (profile.parentEmail) {
    for (const i of await repo.listInvitesForEmail(profile.parentEmail)) {
      if (i.kind === "consent" && i.profileIds?.includes(pid)) await repo.deleteInvite(i.id);
    }
    await repo.createInvite({
      kind: "consent",
      fromAccountId: profile.ownerAccountId,
      toEmail: profile.parentEmail,
      profileIds: [pid],
    });
    if (deps.mailer) await sendConsentRequest(deps, profile.parentEmail, profile.firstName);
  }
  return true;
}
