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
 * Returns true when the profile was reverted, or a pending revert was finished.
 */
export async function revertIfLastConsentGiver(deps, accountId, pid) {
  const { repo, now } = deps;
  const profile = await repo.getProfile(pid);
  if (profile?.consentRevert === "pending") return finishConsentRevert(deps, profile);
  if (!profile || profile.under13 !== true || profile.consentStatus !== "active") return false;
  const rows = await repo.listAccessForProfile(pid);
  const mine = rows.find((r) => r.accountId === accountId);
  if (mine?.consentGiver !== true) return false;
  if (rows.some((r) => r.accountId !== accountId && r.consentGiver === true)) return false;
  // One write reverts consent and marks the transition, so a failure in any
  // later step leaves it for a retry or the janitor to finish.
  const marked = await repo.updateProfile(pid, {
    consentStatus: "awaiting_parent",
    awaitingSince: now(),
    consentRevert: "pending",
  });
  return finishConsentRevert(deps, marked);
}

/**
 * The steps after the marker. Each is safe to repeat: progress deletion is a
 * no-op once gone, and the consent invite is replaced, not added to. Only the
 * email can repeat, if clearing the marker fails after it was sent.
 */
async function finishConsentRevert(deps, profile) {
  const { repo } = deps;
  const pid = profile.id;
  // Skipped when the parent approved again before this finished.
  if (profile.consentStatus === "awaiting_parent") {
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
  }
  await repo.updateProfile(pid, { consentRevert: null });
  return profile.consentStatus === "awaiting_parent";
}

/** Janitor step: finish any revert a failure left part-done. */
export async function finishPendingConsentReverts(deps, onError) {
  let finished = 0;
  for (const listed of await deps.repo.listProfiles()) {
    if (listed.consentRevert !== "pending") continue;
    try {
      // The scan can be stale; act only on a consistent read.
      const profile = await deps.repo.getProfile(listed.id);
      if (profile?.consentRevert !== "pending") continue;
      await finishConsentRevert(deps, profile);
      finished++;
    } catch (err) {
      onError(listed, err);
    }
  }
  return finished;
}
