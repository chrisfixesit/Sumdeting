// Repository: domain data layer over the single-table layout.
import { randomUUID } from "node:crypto";
import { ConditionFailed } from "./table.mjs";
import { emptyProgress } from "./progress.mjs";
import { newToken, newCode, hash } from "./tokens.mjs";

const DAY_MS = 86400e3;
const SESSION_MS = 90 * DAY_MS;
const INVITE_MS = 30 * DAY_MS;
const MAX_CODE_ATTEMPTS = 5;
const MAX_PROGRESS_TRIES = 5;

const sec = (ms) => Math.floor(ms / 1000);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The guarded account changed (signed in) before the first write committed. */
export class AccountChanged extends Error {
  constructor(message = "Account changed") {
    super(message);
    this.name = "AccountChanged";
  }
}

const isConditionFailed = (err) => err instanceof ConditionFailed || err?.name === "ConditionFailed";

/**
 * A table whose writes carry `guard` (a check op) until one commits. A failure while
 * the guard no longer holds becomes AccountChanged, so retry loops (update()) stop
 * instead of retrying unguarded. Then the guard is gone: the sweep has committed.
 */
function firstWriteGuarded(table, guard) {
  let armed = true;
  const { pk, sk } = guard.check;
  const withGuard = (ops) => {
    const same = ops.find((op) => {
      const key = op.put ?? op.delete ?? op.check;
      return key.pk === pk && key.sk === sk;
    });
    // DynamoDB allows one op per item in a transaction: fold the guard into it.
    if (!same) return [...ops, guard];
    if (same.ifNotExists || (same.ifVersion !== undefined && same.ifVersion !== guard.ifVersion)) {
      throw new ConditionFailed();
    }
    return ops.map((op) => (op === same ? { ...op, ifVersion: guard.ifVersion } : op));
  };
  const write = async (ops) => {
    try {
      await table.transact(withGuard(ops));
      armed = false;
    } catch (err) {
      if (isConditionFailed(err) && (await table.get(pk, sk))?.version !== guard.ifVersion) {
        throw new AccountChanged();
      }
      throw err;
    }
  };
  return {
    ...table,
    put: (item, conditions = {}) => (armed ? write([{ put: item, ...conditions }]) : table.put(item, conditions)),
    delete: (pk2, sk2, conditions = {}) =>
      armed ? write([{ delete: { pk: pk2, sk: sk2 }, ...conditions }]) : table.delete(pk2, sk2, conditions),
    transact: (ops) => (armed ? write(ops) : table.transact(ops)),
  };
}

export function createRepo(table, { now = () => Date.now() } = {}) {
  const accountKey = (id) => `ACCOUNT#${id}`;
  const profileKey = (pid) => `PROFILE#${pid}`;
  const emailKey = (email) => `EMAIL#${email}`;

  const accessItems = (accountId, pid, kind, consentGiver) => {
    const extra = consentGiver === undefined ? {} : { consentGiver };
    return [
      { pk: accountKey(accountId), sk: `ACCESS#${pid}`, kind, ...extra },
      { pk: profileKey(pid), sk: `ACCESS#${accountId}`, kind, ...extra },
    ];
  };

  const strip = ({ pk, sk, ttl, version, ...rest }) => rest;
  const isConflict = (err) =>
    err instanceof ConditionFailed || err?.name === "ConditionFailed";
  const RESERVED = ["pk", "sk", "ttl", "version", "id", "ownerAccountId"];
  const clean = (input = {}) =>
    Object.fromEntries(Object.entries(input).filter(([k]) => !RESERVED.includes(k)));

  // Optimistic read-modify-write. fn(item) returns the next item, or null to skip.
  // Returns the written item, the unchanged item when skipped, or null if missing.
  const update = async (pk, sk, fn) => {
    for (let attempt = 0; attempt < MAX_PROGRESS_TRIES; attempt++) {
      const item = await table.get(pk, sk);
      if (!item) return null;
      const next = fn(item);
      if (!next) return item;
      const version = item.version ?? 0;
      const written = { ...next, pk, sk, version: version + 1 };
      try {
        await table.put(written, { ifVersion: version });
        return written;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    throw new Error("Update conflict: too many concurrent writes");
  };
  const merge = (pk, sk, patch) =>
    update(pk, sk, (item) => ({ ...item, ...clean(patch) }));

  const repo = {
    // ---- Accounts ----
    async findAccountByEmail(email) {
      const link = await table.get(emailKey(email), "ACCOUNT");
      return link ? repo.getAccount(link.accountId) : null;
    },
    async getAccount(id) {
      const item = await table.get(accountKey(id), "META");
      return item ? { id, ...strip(item) } : null;
    },
    async createAccount(email) {
      const id = randomUUID();
      const t = now();
      try {
        await table.transact([
          { put: { pk: emailKey(email), sk: "ACCOUNT", accountId: id }, ifNotExists: true },
          {
            put: {
              pk: accountKey(id),
              sk: "META",
              email,
              type: null,
              setupComplete: false,
              holderOver13: null,
              createdAt: t,
              lastActiveAt: t,
              version: 1,
            },
          },
        ]);
      } catch (err) {
        const existing = await repo.findAccountByEmail(email);
        if (existing) return existing;
        throw err;
      }
      return repo.getAccount(id);
    },
    async updateAccount(id, patch) {
      const item = await merge(accountKey(id), "META", patch);
      return item ? { id, ...strip(item) } : null;
    },
    // Minimal removal of the account item and its email link (no data cascade).
    async deleteAccountRecord(id) {
      const item = await table.get(accountKey(id), "META");
      const ops = [{ delete: { pk: accountKey(id), sk: "META" } }];
      if (item) ops.push({ delete: { pk: emailKey(item.email), sk: "ACCOUNT" } });
      await table.transact(ops);
    },
    async touchActive(id) {
      const t = now();
      await update(accountKey(id), "META", (item) => {
        if (item.lastActiveAt && utcDay(item.lastActiveAt) === utcDay(t)) return null;
        const { warningSentAt, ...rest } = item;
        return { ...rest, lastActiveAt: t };
      });
    },
    /**
     * Retention sweep's recheck: the account's version if its last activity is still
     * `lastActive`, else null. Every account is created versioned; one without a
     * version gets null (never deleted) rather than a guess.
     */
    async recheckIdleAccount(id, lastActive) {
      const item = await table.get(accountKey(id), "META");
      if (!item || (item.lastActiveAt ?? item.createdAt) !== lastActive) return null;
      return typeof item.version === "number" ? item.version : null;
    },
    /**
     * This repo, but the first write that commits also requires the account to still
     * be at `version`, in the same transaction. A sign-in (touchActive) bumps the
     * version, so the write fails and AccountChanged is thrown before anything changed.
     */
    guardedByAccount(id, version) {
      return createRepo(firstWriteGuarded(table, { check: { pk: accountKey(id), sk: "META" }, ifVersion: version }), { now });
    },
    async listAccounts() {
      const items = await table.scan("ACCOUNT#");
      return items
        .filter((i) => i.sk === "META")
        .map((i) => ({ id: i.pk.slice("ACCOUNT#".length), ...strip(i) }));
    },

    // ---- Profiles and access ----
    async listProfiles() {
      const items = await table.scan("PROFILE#");
      return items
        .filter((i) => i.sk === "META")
        .map((i) => ({ id: i.pk.slice("PROFILE#".length), ...strip(i) }));
    },
    async createProfile(ownerAccountId, fields) {
      const id = randomUUID();
      const profile = { ...clean(fields), ownerAccountId, createdAt: now() };
      await table.transact([
        {
          put: { ...profile, pk: profileKey(id), sk: "META", version: 1 },
          ifNotExists: true,
        },
        ...accessItems(ownerAccountId, id, "owner").map((put) => ({ put })),
      ]);
      return { id, ...profile };
    },
    async getProfile(pid) {
      const item = await table.get(profileKey(pid), "META");
      return item ? { id: pid, ...strip(item) } : null;
    },
    /** The profile plus its META version, for a write that must still find it unchanged. */
    async getProfileWithVersion(pid) {
      const item = await table.get(profileKey(pid), "META");
      return item ? { profile: { id: pid, ...strip(item) }, version: item.version ?? 0 } : null;
    },
    async updateProfile(pid, patch) {
      const item = await merge(profileKey(pid), "META", patch);
      return item ? { id: pid, ...strip(item) } : null;
    },
    /** Record a new owner on the profile (access rows are changed separately). */
    async setProfileOwner(pid, accountId) {
      const item = await update(profileKey(pid), "META", (i) => ({ ...i, ownerAccountId: accountId }));
      return item ? { id: pid, ...strip(item) } : null;
    },
    /** Clear a consent revert's marker, only if it is still the one given (see consent.mjs). */
    async clearConsentRevert(pid, marker) {
      await update(profileKey(pid), "META", (i) =>
        i.consentRevert === marker ? { ...i, consentRevert: null } : null
      );
    },
    /** Remove a profile's server-side progress (consent ended). */
    async deleteProgress(pid) {
      await table.delete(profileKey(pid), "PROGRESS");
    },
    async deleteProfile(pid) {
      const access = await table.query(profileKey(pid), "ACCESS#");
      const ops = [
        { delete: { pk: profileKey(pid), sk: "META" } },
        { delete: { pk: profileKey(pid), sk: "PROGRESS" } },
      ];
      for (const a of access) {
        const accountId = a.sk.slice("ACCESS#".length);
        ops.push({ delete: { pk: profileKey(pid), sk: a.sk } });
        ops.push({ delete: { pk: accountKey(accountId), sk: `ACCESS#${pid}` } });
      }
      await table.transact(ops);
    },
    async grantAccess(accountId, pid, kind, { consentGiver } = {}) {
      await table.transact(
        accessItems(accountId, pid, kind, consentGiver).map((put) => ({ put }))
      );
    },
    async revokeAccess(accountId, pid) {
      await table.transact([
        { delete: { pk: accountKey(accountId), sk: `ACCESS#${pid}` } },
        { delete: { pk: profileKey(pid), sk: `ACCESS#${accountId}` } },
      ]);
    },
    async getAccess(accountId, pid) {
      const item = await table.get(accountKey(accountId), `ACCESS#${pid}`);
      return item ? item.kind : null;
    },
    async listAccessForAccount(id) {
      const items = await table.query(accountKey(id), "ACCESS#");
      return items.map((i) => ({
        profileId: i.sk.slice("ACCESS#".length),
        kind: i.kind,
        consentGiver: i.consentGiver,
      }));
    },
    async listAccessForProfile(pid) {
      const items = await table.query(profileKey(pid), "ACCESS#");
      return items.map((i) => ({
        accountId: i.sk.slice("ACCESS#".length),
        kind: i.kind,
        consentGiver: i.consentGiver,
      }));
    },

    // ---- Progress ----
    async getProgress(pid) {
      const item = await table.get(profileKey(pid), "PROGRESS");
      return item
        ? { progress: item.progress, version: item.version }
        : { progress: emptyProgress(), version: 0 };
    },
    /**
     * Read-modify-write the profile's progress. With `guard` ({ accountId, kind,
     * profileVersion }, from the caller's access check), the write commits only if,
     * in the same transaction, the profile's META is still at that version (not
     * deleted, consent not changed) and the caller's ACCESS row still has that kind.
     * A guarded write is tried once and throws ConditionFailed, so the caller can
     * check access again: the profile may be gone, or only renamed.
     */
    async updateProgress(pid, fn, guard) {
      const tries = guard ? 1 : MAX_PROGRESS_TRIES;
      for (let attempt = 0; attempt < tries; attempt++) {
        const { progress, version } = await repo.getProgress(pid);
        const next = fn(progress);
        const item = { pk: profileKey(pid), sk: "PROGRESS", progress: next, version: version + 1 };
        try {
          if (guard) {
            // Every META update bumps its version; one without a version can only be held to existing.
            const meta = guard.profileVersion > 0 ? { ifVersion: guard.profileVersion } : { ifExists: true };
            await table.transact([
              { check: { pk: profileKey(pid), sk: "META" }, ...meta },
              { check: { pk: accountKey(guard.accountId), sk: `ACCESS#${pid}` }, ifAttr: { name: "kind", equals: guard.kind } },
              { put: item, ifVersion: version },
            ]);
          } else {
            await table.put(item, { ifVersion: version });
          }
          return next;
        } catch (err) {
          if (!isConflict(err) || guard) throw err;
        }
      }
      throw new Error("Progress update conflict: too many concurrent writes");
    },

    // ---- Tokens and codes ----
    async issueToken(purpose, email, ttlSec) {
      const token = newToken();
      await table.put({
        pk: `TOKEN#${hash(token)}`,
        sk: "T",
        purpose,
        email,
        used: false,
        version: 1,
        ttl: sec(now()) + ttlSec,
      });
      return token;
    },
    async consumeToken(token, purpose) {
      const pk = `TOKEN#${hash(token)}`;
      const item = await table.get(pk, "T");
      if (!item || item.used || item.purpose !== purpose) return null;
      try {
        // Conditional on version: exactly one concurrent consumer wins.
        await table.put({ ...item, used: true, version: item.version + 1 }, { ifVersion: item.version });
      } catch (err) {
        if (isConflict(err)) return null;
        throw err;
      }
      await table.delete(pk, "T");
      return { email: item.email };
    },
    async issueCode(purpose, subject, ttlSec) {
      const code = newCode();
      await table.put({
        pk: `CODE#${purpose}#${subject}`,
        sk: "C",
        codeHash: hash(code),
        attempts: 0,
        used: false,
        version: 1,
        ttl: sec(now()) + ttlSec,
      });
      return code;
    },
    async checkCode(purpose, subject, code) {
      const pk = `CODE#${purpose}#${subject}`;
      const item = await table.get(pk, "C");
      if (!item || item.used) return "invalid";
      // Count the attempt before comparing so parallel guesses can't bypass the limit.
      const n = await table.add(pk, "C", "attempts", 1, item.ttl);
      if (n > MAX_CODE_ATTEMPTS) {
        await table.delete(pk, "C");
        return "locked";
      }
      if (item.codeHash === hash(code)) {
        try {
          await table.put(
            { ...item, used: true, version: item.version + 1 },
            { ifVersion: item.version }
          );
        } catch (err) {
          if (isConflict(err)) return "invalid";
          throw err;
        }
        await table.delete(pk, "C");
        return "ok";
      }
      if (n >= MAX_CODE_ATTEMPTS) {
        await table.delete(pk, "C");
        return "locked";
      }
      return "invalid";
    },

    // ---- Sessions ----
    async createSession(accountId) {
      const id = newToken();
      const expiresAt = now() + SESSION_MS;
      await table.put({
        pk: `SESSION#${hash(id)}`,
        sk: "S",
        accountId,
        expiresAt,
        parentUnlockedUntil: 0,
        version: 1,
        ttl: sec(expiresAt),
      });
      return { id, expiresAt };
    },
    async getSession(id) {
      const item = await table.get(`SESSION#${hash(id)}`, "S");
      if (!item || item.expiresAt <= now()) return null;
      return { id, ...strip(item) };
    },
    async renewSession(id) {
      const session = await repo.getSession(id);
      if (!session) return null;
      const expiresAt = now() + SESSION_MS;
      await update(`SESSION#${hash(id)}`, "S", (item) => ({
        ...item,
        expiresAt,
        ttl: sec(expiresAt),
      }));
      return { ...session, expiresAt };
    },
    async setParentUnlocked(id, untilMs) {
      await merge(`SESSION#${hash(id)}`, "S", { parentUnlockedUntil: untilMs });
    },
    async deleteSession(id) {
      await table.delete(`SESSION#${hash(id)}`, "S");
    },

    // ---- Invites ----
    /** `id` is optional: a caller that may repeat the creation passes a fixed one. */
    async createInvite({ id = randomUUID(), kind, fromAccountId, toEmail, profileIds }) {
      const ttl = sec(now() + INVITE_MS);
      const invite = { kind, fromAccountId, toEmail, profileIds, ttl };
      await table.transact([
        { put: { pk: `INVITE#${id}`, sk: "I", ...invite } },
        { put: { pk: emailKey(toEmail), sk: `INVITE#${id}`, kind, ttl } },
        { put: { pk: accountKey(fromAccountId), sk: `INVITE#${id}`, kind, ttl } },
      ]);
      return { id, ...invite };
    },
    async getInvite(id) {
      const item = await table.get(`INVITE#${id}`, "I");
      return item ? { id, ...strip(item), ttl: item.ttl } : null;
    },
    async listInvitesForEmail(email) {
      const links = await table.query(emailKey(email), "INVITE#");
      const invites = await Promise.all(
        links.map((l) => repo.getInvite(l.sk.slice("INVITE#".length)))
      );
      const nowSec = now() / 1000;
      return invites.filter((i) => i && !(typeof i.ttl === "number" && i.ttl <= nowSec));
    },
    /** Invites created by one account, via the sender's INVITE# link rows (no scan). */
    async listInvitesFromAccount(accountId) {
      const links = await table.query(accountKey(accountId), "INVITE#");
      const invites = await Promise.all(
        links.map((l) => repo.getInvite(l.sk.slice("INVITE#".length)))
      );
      const nowSec = now() / 1000;
      return invites.filter(
        (i) => i && i.fromAccountId === accountId && !(typeof i.ttl === "number" && i.ttl <= nowSec)
      );
    },
    async deleteInvite(id) {
      const invite = await table.get(`INVITE#${id}`, "I");
      const ops = [{ delete: { pk: `INVITE#${id}`, sk: "I" } }];
      if (invite) {
        ops.push({ delete: { pk: emailKey(invite.toEmail), sk: `INVITE#${id}` } });
        ops.push({ delete: { pk: accountKey(invite.fromAccountId), sk: `INVITE#${id}` } });
      }
      await table.transact(ops);
    },

    // ---- Rate limits ----
    async hitRate(key, windowSec, limit) {
      const windowId = Math.floor(sec(now()) / windowSec);
      const n = await table.add(
        `RATE#${key}`,
        String(windowId),
        "n",
        1,
        (windowId + 1) * windowSec
      );
      return n <= limit;
    },
  };
  return repo;
}
