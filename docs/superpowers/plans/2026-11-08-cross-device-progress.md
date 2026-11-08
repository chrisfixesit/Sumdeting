# Cross-Device Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional magic-link sign-in so a student's progress follows them between devices, with several student profiles per email, under-13 parent approval, a code-locked parent view, view-only links to children's own accounts, and second guardians.

**Architecture:** A new account Lambda (`backend/account/`) is reached through a new CloudFront behaviour at `/api/account/*`. It uses a buffered (not streaming) Function URL with OAC and stores data in one DynamoDB table. Its logic sits behind a small `Table` interface with an in-memory implementation, so every rule is unit-tested with `node:test` and the docker server runs with no AWS at all. The frontend gains two ES modules, `web/account-core.mjs` (pure and unit-tested) and `web/account-ui.mjs` (DOM), which talk to the existing inline script in `web/index.html` through a small `window.SumDeTing` bridge and a `sumdeting:progress` DOM event.

**Tech Stack:** Node 20 ES modules, `node:test`, AWS SDK v3 (`@aws-sdk/lib-dynamodb`, `@aws-sdk/client-sesv2`, provided by the Lambda runtime), DynamoDB on-demand, SES v2, EventBridge Scheduler, OpenTofu, vanilla JS, `@playwright/test` for end-to-end tests.

**Spec:** `docs/superpowers/specs/2026-11-08-cross-device-progress-design.md`

## Before Task 1 (owner, day one: these have outside lead time)

These are manual AWS requests. The owner runs them, because they change a live account. Write them into `docs/launch-runbook.md` in Task 12, but **start them now**:
- SES production access: `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://sumdeting.246labs.cloud --use-case-description "<magic-link sign-in and parent consent emails>" --profile <sumdeting account profile>`
- Lambda concurrency quota increase from 10 to 100: `aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 100 --profile <…>`

## Global Constraints

- Signing in is optional. When signed out, the app must behave exactly as it does today, using the same localStorage keys: `mathmentor.mastery.v1`, `mathmentor.prefs.v1` and `mathmentor.session.v1`.
- Per student, store only first name, last name, level, colour, an under-13 flag and consent details. Never store date of birth, school, chat text, photos or tutor replies on the server.
- Levels are exactly `Common Entrance`, `CSEC`, `Additional Maths` and `CAPE` (the existing `LEVELS` array in `web/index.html:1902`). The UI shows "Add Maths" only where the existing UI already does.
- Colours are exactly `#F4C143`, `#BFD0FF`, `#C8E6C9`, `#F8C9B8`, `#E1C6F2` and `#FFE0A3`.
- **No emojis anywhere in the new UI or the emails.**
- Sign-in links and codes expire after **15 minutes** and work once. A parent-unlock code lasts **10 minutes**. The parent section stays unlocked for **15 minutes** on that device. A delete-confirmation code lasts **10 minutes**. Codes are **6 digits**, with at most **5 wrong attempts** per code.
- Sessions last **90 days** with sliding renewal (re-issued when fewer than 60 days remain), in a cookie: `sd_session`, `HttpOnly; Secure; SameSite=Lax; Path=/api/account`.
- Invites and link requests expire after **30 days**. An under-13 profile waiting for a parent, and a sign-up that never finished setup, are deleted after **7 days**. Accounts inactive for **2 years** are deleted, after a warning email **30 days** beforehand.
- Hard-coded rate limits: `signin/start` allows 5 per email per hour and 30 per IP per hour. Any code-sending endpoint allows 5 per account per hour.
- Store only SHA-256 hashes of tokens, codes and session ids.
- Everything is same-origin under the existing CSP (`'self'`). Every POST from the browser carries an `x-amz-content-sha256` header (OAC requirement), the same as `sha256Hex` in `web/index.html:994`.
- Every email links to `/privacy.html`. Sign-in links use a URL fragment, `https://<site>/#signin=<token>`, so the token never reaches a server or a link scanner.
- Copy must match the spec wording wherever the spec quotes it, for example "Keep your progress", "Who's practising?" and "Add the progress on this device to <name>'s profile?".

## Review Focus

1. **School email link scanners open sign-in links before the student does.** Opening the landing URL must change nothing. The token is in the fragment, and only the page's JavaScript POSTs it. Pinned in Task 5 (`GET with a signin fragment has no side effects`) and in Task 14's end-to-end test.
2. **The same email typed differently** (`" Mum@Gmail.COM "` versus `mum@gmail.com`) must reach the same account and the same rate-limit bucket. Pinned in Task 3 (`normaliseEmail`) and Task 5 (`signin with differently-cased email reaches same account`).
3. **Tapping "Email me a sign-in link" several times, then using an older email.** Every unexpired link still works, but only the newest code does. Pinned in Task 5 (`older link still valid, older code rejected`).
4. **Two devices recording progress for one student at the same moment** (school computer and phone). No outcome may be lost or double-counted. Pinned in Task 7 (`concurrent syncs both apply`, `replayed batch is not double-counted`).
5. **Session gone mid-practice** (expired cookie, a parent deleted the profile, or a guardian was removed). Practice must keep working on local data, queued events must not be lost while signed in, and the UI must drop to signed out with a gentle notice. Pinned in Task 13 (`401 on sync keeps queue and reports signedOut`) and Task 7 (`sync to deleted profile returns 404`).

---

## File Structure

```
backend/
  package.json                  add deps + "test" script
  account/
    table.mjs                   Table interface: memory + DynamoDB implementations
    progress.mjs                pure progress logic: apply events, merge, status, summary
    tokens.mjs                  tokens, hashes, codes, email normalisation
    email.mjs                   templates + SES / memory mailer
    repo.mjs                    domain data on top of Table
    http.mjs                    router, cookies, errors, session middleware
    auth.mjs                    signin/start, signin/verify, signout, me
    profiles.mjs                setup, profiles CRUD, under-13 consent
    sync.mjs                    progress get / sync / merge
    parent.mjs                  parent unlock + overview
    links.mjs                   share, request, respond, guardian invite, list, remove, apply-on-signin
    deletion.mjs                account deletion + janitor
    index.mjs                   Lambda entry (Function URL adapter + scheduled janitor)
    *.test.mjs                  node:test files next to each module
server.mjs                      mount the router at /api/account/* (memory store when no TABLE_NAME)
Dockerfile                      copy backend/account and the new web files
web/
  index.html                    bridge, storage-key indirection, progress events, profile icon slot
  account-core.mjs              pure client logic (keys, queue, api client, labels)
  account-core.test.mjs
  account-ui.mjs                all account screens
  account.css
  privacy.html
e2e/
  package.json                  @playwright/test 1.48.2
  playwright.config.mjs
  account.spec.mjs
infra/main.tf, variables.tf, outputs.tf   table, Lambda, URL+OAC, behaviour, SES, scheduler, new S3 objects
.github/workflows/pr.yml        add unit-test and e2e jobs
docs/launch-runbook.md
README.md
```

---

### Task 1: Test harness and the Table layer

**Files:**
- Modify: `backend/package.json`, `.github/workflows/pr.yml`
- Create: `backend/account/table.mjs`, `backend/account/table.test.mjs`

**Interfaces:**
- Produces:
  - `class ConditionFailed extends Error`
  - `createMemoryTable({ now = () => Date.now() } = {}) → Table`
  - `createDynamoTable({ tableName, client? }) → Table` (dynamic-imports `@aws-sdk/lib-dynamodb` so tests never need the SDK)
  - `Table` methods (all async). An item is `{ pk: string, sk: string, ttl?: number /* epoch s */, version?: number, ...attrs }`:
    - `get(pk, sk) → item | null`. Returns null for items whose `ttl` has passed, the same as DynamoDB TTL lag being hidden.
    - `put(item, { ifNotExists?: boolean, ifVersion?: number } = {})` throws `ConditionFailed`. `ifVersion: 0` means the item must not exist.
    - `delete(pk, sk)`
    - `query(pk, skPrefix = "") → item[]`, sorted by `sk`, skipping expired items
    - `add(pk, sk, field, n, ttl) → number`, an atomic counter that creates the item with `ttl` if it's missing
    - `scan(pkPrefix) → item[]`
    - `transact(ops: Array<{ put: item, ifNotExists?, ifVersion? } | { delete: { pk, sk } }>)`, all or nothing; throws `ConditionFailed`

- [ ] **Step 1:** Add to `backend/package.json`: `"scripts": { "test": "node --test account/" }` and dependencies `@aws-sdk/lib-dynamodb` and `@aws-sdk/client-dynamodb` (`^3.0.0`) and `@aws-sdk/client-sesv2` (`^3.0.0`). Run `cd backend && npm install`.
- [ ] **Step 2: Write the failing tests** in `table.test.mjs`. Every test uses `createMemoryTable` with a controllable `now`:
  - `put/get round trip`
  - `get hides expired ttl items`: put with `ttl = now/1000 + 10`, advance `now` by 11 s, expect `null`
  - `put ifNotExists throws ConditionFailed on existing item`
  - `put ifVersion succeeds on match and throws on mismatch`, and `ifVersion 0 requires absence`
  - `query returns items by sk prefix in sk order`
  - `add increments atomically and sets ttl on create`
  - `transact applies nothing when one condition fails`
- [ ] **Step 3:** Run `cd backend && npm test`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement `table.mjs`.** The memory version is a `Map` keyed by `` `${pk}\u0000${sk}` ``, and it stores deep clones (`structuredClone`) so callers can't change stored items. The DynamoDB version maps conditions to `attribute_not_exists(pk)` and `#v = :v`, uses `TransactWriteCommand` for `transact` (rethrowing `TransactionCanceledException` with a `ConditionalCheckFailed` reason as `ConditionFailed`), `UpdateCommand ADD` for `add`, and paginated `QueryCommand`/`ScanCommand`. The DynamoDB adapter has no unit tests. Task 12's deploy check covers it.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** In `pr.yml`, add a job `unit` (Node 20) that runs `cd backend && npm ci || npm install && npm test`, and change the existing `backend` syntax check to also check `account/*.mjs`.
- [ ] **Step 7: Commit:** `feat(account): table abstraction with memory and DynamoDB backends`

### Task 2: Progress logic (pure)

**Files:**
- Create: `backend/account/progress.mjs`, `backend/account/progress.test.mjs`

**Interfaces:**
- Produces:
  - `Progress = { topics: { [name]: { attempted: number, solved: number, hist: Array<{ d: 'YYYY-MM-DD', ok: 0|1, hints: number, turns: number }> } }, streak: { count: number, last: string }, days: { [date]: number }, prefs: { level, topic, duration } | null, appliedEventIds: string[] }`
  - `ProgressEvent`, one of:
    - `{ id, type: 'outcome', topic, ok: boolean, hints, turns, d }`
    - `{ id, type: 'activity', topic: string|null, solved: boolean, d }`
    - `{ id, type: 'prefs', level, topic, duration }`
  - `emptyProgress() → Progress`
  - `applyEvents(progress, events) → Progress` (pure; returns a new object)
  - `mergeProgress(server: Progress, local: { mastery, prefs }) → Progress`, where `mastery` is the exact shape of today's `mathmentor.mastery.v1`
  - `topicStatus(topic) → 'hard' | 'confident' | 'getting_there'`
  - `childSummary(progress) → { streak: number, solved: number, topicsTried: number, lastPractised: string|null, needsPractice: TopicRow[], goingWell: TopicRow[] }`, where `TopicRow = { name, status, solved, attempted, hintsOften: boolean }`

Rules, mirroring `web/index.html:1300-1360` exactly:
- An **activity** event bumps the streak using the event's `d`: the same day changes nothing, the next day adds 1, and any other gap resets the streak to 1. If it has a topic, it adds to `solved` when `solved` is true, otherwise to `attempted`. When it has a topic and `solved` is true, it also adds 1 to `days[d]`.
- An **outcome** event pushes onto `hist`, keeping the last 15 entries.
- A **prefs** event replaces `prefs`.
- Every event id is remembered, keeping the last **200**. An event whose id was already applied is skipped.
- Struggled means `!ok || hints > 0 || turns >= 5`. **Hard** means 2 or more struggled in the last 3. **Confident** means at least 2 recent entries, with all of the last 3 being `ok`, `hints === 0` and `turns <= 3`. Anything else is **getting_there**.
- **Merge:** add `attempted` and `solved` together; combine both `hist` lists, sort by date (stable), and keep the last 15; keep whichever streak has the higher count; add `days` together per date; use the local `prefs` only when the server's `prefs` is null.
- In `childSummary`, `needsPractice` holds the `hard` topics. `goingWell` holds the rest, `confident` first. `hintsOften` is true when more than half of `hist` has `hints > 0`.

- [ ] **Step 1: Write the failing tests:**
  - `activity on consecutive days grows streak, gap resets to 1`
  - `activity solved increments solved and days[d]`, `activity unsolved increments attempted only`
  - `outcome caps hist at 15`
  - `duplicate event id is applied once`
  - `appliedEventIds keeps last 200`
  - `merge sums counts, interleaves hist by date capped at 15, keeps longer streak, sums days`
  - `merge keeps server prefs when set`
  - `topicStatus hard / confident / getting_there`, with one case each built from the rules above, plus `fewer than 2 entries is getting_there`
  - `childSummary groups and orders topics`, `lastPractised is latest date across days and hist`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `progress.mjs`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): pure progress apply/merge/status logic`

### Task 3: Tokens, codes and the mailer

**Files:**
- Create: `backend/account/tokens.mjs`, `backend/account/email.mjs`, `backend/account/tokens.test.mjs`, `backend/account/email.test.mjs`

**Interfaces:**
- Produces:
  - `newToken() → string`: 32 random bytes, base64url
  - `newCode() → string`: 6 digits from `crypto.randomInt(0, 1e6)`, zero-padded
  - `hash(value) → string`: SHA-256 hex
  - `normaliseEmail(raw) → string | null`: trims and lower-cases; returns null if it doesn't match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` or is over 254 characters
  - `createMailer({ mode: 'ses' | 'memory', from, siteUrl, sesClient? }) → { send(kind, to, vars) → Promise<void>, outbox?: Array<{ kind, to, subject, text, html }> }`
  - Email kinds and their `vars`:
    - `signin` `{ token, code }`
    - `parent_code` `{ code }`
    - `confirm_delete` `{ code }`
    - `consent_request` `{ token, childFirstName }`
    - `share` `{ token, studentFirstName }`
    - `access_request` `{ token, parentEmail }`
    - `guardian_invite` `{ token, childFirstName, inviterEmail }`
    - `retention_warning` `{ token }`
  - Every email with a `token` links to `${siteUrl}/#signin=${token}`. Every email includes `${siteUrl}/privacy.html` and one plain sentence saying why it was sent. There are no emojis.

- [ ] **Step 1: Write the failing tests:**
  - `normaliseEmail trims and lowercases " Mum@Gmail.COM "` gives `mum@gmail.com`
  - `normaliseEmail rejects "not-an-email" and 255-char input`
  - `newCode is 6 digits`
  - `newToken values are unique and url-safe`
  - `signin email contains fragment link and code`
  - `every kind includes privacy link`
  - `emails contain no emoji`, using `/\p{Extended_Pictographic}/u` against subject, text and html for every kind
  - `consent_request names the child`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement both modules. Each email has a plain-text and a simple HTML part. In `ses` mode, call `SendEmailCommand` from `@aws-sdk/client-sesv2` (dynamic import), using `Content.Simple`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): tokens, codes and email templates`

### Task 4: Repository

**Files:**
- Create: `backend/account/repo.mjs`, `backend/account/repo.test.mjs`

**Interfaces:**
- Consumes: `Table` (Task 1), `emptyProgress` and `applyEvents` (Task 2), `hash` (Task 3)
- Produces: `createRepo(table, { now = () => Date.now() } = {}) → Repo`. Item layout (single table):

| pk | sk | attrs |
|---|---|---|
| `EMAIL#<email>` | `ACCOUNT` | `accountId` |
| `ACCOUNT#<id>` | `META` | `email, type: null\|'parent'\|'student', setupComplete, holderOver13, createdAt, lastActiveAt, warningSentAt?` |
| `ACCOUNT#<id>` | `ACCESS#<profileId>` | `kind: 'owner'\|'guardian'\|'view_only', consentGiver?: boolean` |
| `PROFILE#<pid>` | `META` | `firstName, lastName, level, colour, under13, consentStatus: 'active'\|'awaiting_parent', consentBy, consentAt, ownerAccountId, parentEmail?, createdAt` |
| `PROFILE#<pid>` | `ACCESS#<accountId>` | mirror of the account-side access item |
| `PROFILE#<pid>` | `PROGRESS` | `progress, version` |
| `TOKEN#<hash>` | `T` | `purpose, email, ttl` |
| `CODE#<purpose>#<subject>` | `C` | `codeHash, attempts, ttl` (one live code per purpose and subject, so a newer code replaces an older one) |
| `SESSION#<hash>` | `S` | `accountId, expiresAt, parentUnlockedUntil, ttl` |
| `INVITE#<id>` | `I` | `kind: 'share'\|'request'\|'guardian'\|'consent', fromAccountId, toEmail, profileIds, ttl` |
| `EMAIL#<email>` | `INVITE#<id>` | `kind, ttl` (lookup by target email) |
| `RATE#<key>` | `<window>` | `n, ttl` |

  Repo methods (all async):
  - Accounts: `findAccountByEmail(email)`, `getAccount(id)`, `createAccount(email)` (transact with `ifNotExists` on `EMAIL#`; creating the same email at the same time returns the existing account), `updateAccount(id, patch)`, `touchActive(id)` (writes at most once per UTC day), `listAccounts()`
  - Profiles and access: `createProfile(ownerAccountId, fields) → profile` (writes the profile and owner access in both directions in one transaction), `getProfile(pid)`, `updateProfile(pid, patch)`, `deleteProfile(pid)` (deletes the profile, progress and every access item in both directions), `grantAccess(accountId, pid, kind, { consentGiver } = {})`, `revokeAccess(accountId, pid)`, `getAccess(accountId, pid) → kind | null`, `listAccessForAccount(id) → [{ profileId, kind, consentGiver }]`, `listAccessForProfile(pid) → [{ accountId, kind, consentGiver }]`
  - Progress: `getProgress(pid) → { progress, version }` (`emptyProgress()` and version 0 when missing), `updateProgress(pid, fn: (Progress) → Progress) → Progress` (optimistic loop using `ifVersion`, up to 5 retries, then throws)
  - Tokens and codes: `issueToken(purpose, email, ttlSec) → token`, `consumeToken(token, purpose) → { email } | null` (deletes on use), `issueCode(purpose, subject, ttlSec) → code`, `checkCode(purpose, subject, code) → 'ok' | 'invalid' | 'locked'` (deletes on `ok`; at the 5th failure deletes and returns `'locked'`)
  - Sessions: `createSession(accountId) → { id, expiresAt }`, `getSession(id) → session | null`, `renewSession(id)`, `setParentUnlocked(id, untilMs)`, `deleteSession(id)`
  - Invites: `createInvite({ kind, fromAccountId, toEmail, profileIds }) → invite` (30-day ttl), `getInvite(id)`, `listInvitesForEmail(email)`, `deleteInvite(id)`
  - Rate limits: `hitRate(key, windowSec, limit) → boolean` (true means allowed)

- [ ] **Step 1: Write the failing tests:**
  - `createAccount is idempotent per email`
  - `createProfile writes owner access both ways`
  - `deleteProfile removes progress and all access items`
  - `updateProgress retries on version conflict and keeps both changes`: two interleaved `updateProgress` calls each add an event, and both events end up present
  - `consumeToken works once and not after 15 minutes`
  - `issueCode replaces previous code for same purpose+subject`
  - `checkCode locks after 5 wrong attempts`
  - `hitRate allows limit then blocks within window, resets next window`
  - `touchActive writes at most once per day`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `repo.mjs`. Ids come from `crypto.randomUUID()`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): repository over single-table layout`

### Task 5: HTTP layer, sign-in endpoints, Lambda entry and local server

**Files:**
- Create: `backend/account/http.mjs`, `backend/account/auth.mjs`, `backend/account/index.mjs`, `backend/account/auth.test.mjs`, and `backend/account/testkit.mjs` (test helper)
- Modify: `server.mjs`, `Dockerfile`

**Interfaces:**
- Consumes: the Repo (Task 4), the mailer and tokens (Task 3)
- Produces:
  - `Request = { method, path /* after /api/account */, headers, cookies: Record<string,string>, body: object, ip: string }`
  - `Response = { status, body, setCookies?: string[] }`
  - `createRouter(deps) → (req: Request) => Promise<Response>`, where `deps = { repo, mailer, now, siteUrl, secureCookies: boolean, dev?: boolean }`
  - `route(method, path, handler, { auth?: 'none' | 'session' | 'parentUnlocked' })`, used by each feature module through `register(router)`. Each feature module exports `register(router)`.
  - Handler context: `ctx = { req, deps, session?, account? }`. Throw `new HttpError(status, code)` for errors. Error codes are `bad_request` 400, `invalid_code` 400, `not_signed_in` 401, `forbidden` 403, `parent_locked` 403, `awaiting_parent` 403, `not_found` 404, `too_many_attempts` 429 and `rate_limited` 429. The body is `{ error: code }`.
  - `buildMe(ctx) → MeResponse`, which later tasks extend:
    `{ signedIn: true, account: { email, type, setupComplete, holderOver13 }, parentUnlocked: boolean, profiles: [{ id, firstName, lastName, level, colour, access, consentStatus, under13 }], pendingRequests: [], pendingConsents: [] }`
  - `testkit.mjs`: `makeApp({ now }) → { call(method, path, body, { cookie, ip }) → Response, outbox, repo, clock }`, using the memory table and the memory mailer. It parses `setCookies` into a cookie jar for the next call.
  - Endpoints:
    - `POST /signin/start {email}` → `200 {}` every time (it never reveals whether the email exists). Rate-limited. It issues a token and a code (purpose `signin`, subject = email, 15 minutes) and sends `signin`.
    - `POST /signin/verify {token} | {email, code}` → creates the account if it's missing, creates a session, sets the cookie, calls `touchActive`, then calls the `onSignIn` hooks (Task 9 registers one), and returns `buildMe`.
    - `POST /signout` → deletes the session and clears the cookie.
    - `POST /me` → `buildMe`, or `401 not_signed_in`.
    - Dev only (`deps.dev`): `GET /_dev/outbox` → the memory outbox.
  - `index.mjs` exports `handler(event)`. A Function URL event goes to a `Request` (`path` from `rawPath` with `/api/account` removed; `ip` from the `cloudfront-viewer-address` header without its port, falling back to `requestContext.http.sourceIp`; cookies from `event.cookies`). It returns `{ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, cookies, body }`. If `event.source === 'aws.scheduler'` or `event.janitor === true`, it runs the janitor instead (Task 10). Deps are built from env: `TABLE_NAME`, `EMAIL_FROM`, `SITE_URL`, `EMAIL_MODE` (`ses`). `dev` is never true here.
  - `server.mjs` mounts `/api/account/*`. If `TABLE_NAME` is set it uses DynamoDB, otherwise memory. `EMAIL_MODE` defaults to `memory`. `dev` is true only when `ACCOUNT_DEV=1`. `secureCookies` is false only when `ACCOUNT_DEV=1`. Body limit 64 KB.
- **Session cookie:** `sd_session=<id>; HttpOnly; Secure; SameSite=Lax; Path=/api/account; Max-Age=7776000`. Drop `Secure` only when `secureCookies` is false.

- [ ] **Step 1: Write the failing tests** in `auth.test.mjs` using `makeApp`:
  - `signin/start returns 200 for unknown and known emails alike`
  - `signin/start sends a signin email with fragment link and code`
  - `verify with token sets session cookie and returns me`
  - `verify with email+code works; wrong code → invalid_code; 6th try → too_many_attempts`
  - `older link still valid, older code rejected`: start twice, then the first token verifies and the first code returns `invalid_code`
  - `token cannot be used twice`, `token expires after 15 minutes`
  - `signin with differently-cased email reaches same account`
  - `signin/start rate-limits at 6th request per email per hour → rate_limited`
  - `me without cookie → 401 not_signed_in`
  - `signout clears session`
  - `session renews when fewer than 60 days remain`
  - `dev outbox route absent unless deps.dev`
  - `lambda adapter maps rawPath, cookies and viewer address`: call `handler` with a synthetic Function URL event and a stubbed deps factory (export `makeHandler(depsFactory)` from `index.mjs`; `handler` is `makeHandler(fromEnv)`)
  - `GET with a signin fragment has no side effects`: start the local `server.mjs` on a random port (export `createAppServer(opts)` from `server.mjs`, so `listen` only runs when the file is executed directly), GET `/` and check that `repo.listAccounts()` is still empty and every issued token is still valid.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `http.mjs`, `auth.mjs`, `index.mjs` and `testkit.mjs`, and the `server.mjs` changes.
- [ ] **Step 4:** Update the `Dockerfile` to also copy `backend/account/` (excluding `*.test.mjs`), `web/account-core.mjs`, `web/account-ui.mjs`, `web/account.css` and `web/privacy.html`. Add `.html` to the MIME map in `server.mjs`.
- [ ] **Step 5:** Run `npm test`. Expected: PASS. Then run `ACCOUNT_DEV=1 node server.mjs` and `curl -s -XPOST localhost:8080/api/account/me`. Expected: `{"error":"not_signed_in"}` with status 401.
- [ ] **Step 6: Commit:** `feat(account): router, magic-link sign-in, Lambda and local server wiring`

### Task 6: Setup, profiles and under-13 consent

**Files:**
- Create: `backend/account/profiles.mjs`, `backend/account/profiles.test.mjs`
- Modify: `backend/account/auth.mjs` (fill in `pendingConsents` in `buildMe`)

**Interfaces:**
- Consumes: the router, `buildMe` and `HttpError` (Task 5); the Repo (Task 4)
- Produces these endpoints, which all need a session:
  - `POST /setup { type: 'parent' | 'student', holderOver13?: boolean }`. Allowed once, while `setupComplete` is false. `holderOver13` is required for `student`. For `parent`, it calls `setParentUnlocked(session, now + 15 min)`, so the first children can be added without a code.
  - `POST /profiles/create { firstName, lastName, level, colour, consent: true, over13?: boolean, parentEmail?: string }`. Names are trimmed, 1–40 characters each. `level` and `colour` must be from the Global Constraints lists.
    - **Parent account:** requires `parentUnlocked` and `consent === true`. Creates an `active` profile with `under13` unknown (`null`) and `consentBy = accountId`.
    - **Student account:** requires `holderOver13` (otherwise `403 forbidden`). `over13` is required.
      - `over13 === true`: requires `consent === true` and creates an `active` profile.
      - `over13 === false`: requires a valid `parentEmail` that differs from the account email. If `parentEmail` belongs to a `student` account, it returns `400 { error: 'parent_email_is_student' }`. Otherwise it creates an `awaiting_parent` profile, a `consent` invite to `parentEmail` with `profileIds: [pid]`, and sends `consent_request` with a fresh sign-in token for `parentEmail`.
    - Marks `setupComplete = true` after the first profile on the account.
  - The first student-path setup creates the holder's own profile through this same endpoint. The `holderOver13` answer from `/setup` decides whether that first profile is `over13`.
    - **Sign-up for an under-13 holder:** `/setup { type: 'student', holderOver13: false }` followed by `/profiles/create { …, over13: false, parentEmail }`. This is the only profile such an account can create.
  - `POST /profiles/update { profileId, firstName?, lastName?, level?, colour? }`: the owner or a guardian. On parent accounts it needs to be unlocked.
  - `POST /consent/respond { profileId, approve: boolean }`: the caller's email must match the profile's `parentEmail` and have a matching `consent` invite.
    - **Approve:** if the caller's type is `null`, set it to `parent` and `setupComplete = true`. Set the profile to `active` with `consentBy` and `consentAt`, grant the caller `view_only` access with `consentGiver: true`, and delete the invite.
    - **Decline:** delete the profile and the invite. If the student account now has no profiles, delete that account (Task 10 provides `deleteAccountCascade`; until then, stub it and add a TODO that Task 10 removes).
  - `POST /consent/resend { profileId }`: the owner of an `awaiting_parent` profile. Rate-limited to 5 per hour per account. Sends `consent_request` again.
  - `buildMe.pendingConsents` = the `consent` invites addressed to the caller's email → `[{ profileId, firstName, lastName }]`.

- [ ] **Step 1: Write the failing tests:**
  - `setup parent grants 15-minute unlock; setup twice → 400`
  - `parent creates child with consent; without consent → 400`
  - `parent create after unlock window → parent_locked`
  - `student 13+ creates own profile active`
  - `under-13 student creates awaiting_parent profile and parent gets consent_request`
  - `under-13 with parentEmail equal to own email → 400`
  - `parentEmail of a student account → parent_email_is_student`
  - `under-13 holder cannot add a sibling → forbidden`
  - `invalid level or colour → 400`, `names trimmed and length-checked`
  - `parent signs in from consent email and sees pendingConsents`
  - `approve activates profile, makes caller a parent with view_only consentGiver access`
  - `decline deletes profile and the now-empty student account`
  - `consent/respond by an unrelated account → forbidden`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `profiles.mjs` and register it in `index.mjs`, `server.mjs` and `testkit.mjs`. Use one shared `registerAll(router)` in `http.mjs` so all three stay in sync.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): setup, student profiles and under-13 parent consent`

### Task 7: Progress endpoints

**Files:**
- Create: `backend/account/sync.mjs`, `backend/account/sync.test.mjs`

**Interfaces:**
- Consumes: `repo.updateProgress` and `getProgress` (Task 4); `applyEvents` and `mergeProgress` (Task 2)
- Produces these endpoints. Each needs a session with `owner` or `guardian` access to `profileId`; anything else is `403 forbidden`. A missing profile is `404 not_found`, and an `awaiting_parent` profile is `403 awaiting_parent`.
  - `POST /progress/get { profileId }` → `{ progress }`
  - `POST /progress/sync { profileId, events: ProgressEvent[] }` → `{ progress }`. At most 100 events per call. The event shape is validated (unknown `type` → 400; `d` must match `^\d{4}-\d{2}-\d{2}$`; `hints` and `turns` must be integers from 0 to 99).
  - `POST /progress/merge { profileId, local: { mastery, prefs } }` → `{ progress }`. The `mastery` JSON must be under 32 KB and must parse to the expected shape, otherwise 400.

- [ ] **Step 1: Write the failing tests:**
  - `sync applies events and returns progress`
  - `replayed batch is not double-counted`
  - `concurrent syncs both apply`: two `sync` calls started with `Promise.all`, each with distinct events, and both sets end up present
  - `merge adds device progress`
  - `view_only access cannot read via progress/get → forbidden`
  - `guardian can sync`
  - `sync to deleted profile returns 404`
  - `awaiting_parent profile → awaiting_parent`
  - `more than 100 events → 400`, `malformed event → 400`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `sync.mjs` and register it in `registerAll`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): progress get/sync/merge with dedupe and conflict retry`

### Task 8: Parent unlock and overview

**Files:**
- Create: `backend/account/parent.mjs`, `backend/account/parent.test.mjs`

**Interfaces:**
- Consumes: `repo.issueCode`, `checkCode` and `setParentUnlocked`; `childSummary` (Task 2)
- Produces these endpoints, which require a session and an account of type `parent` (otherwise `403 forbidden`):
  - `POST /parent/unlock/start` → `200 {}`. Issues a code (purpose `parent_unlock`, subject = accountId, 10 minutes) and sends `parent_code`. Rate-limited to 5 per hour.
  - `POST /parent/unlock/verify { code }` → `{ parentUnlocked: true }`. Unlocks for 15 minutes. Returns `invalid_code` or `too_many_attempts` on failure.
  - `POST /parent/overview` (`auth: 'parentUnlocked'`) → `{ children: [{ profileId, firstName, lastName, level, colour, access: 'owner' | 'guardian' | 'view_only', consentGiver: boolean (true when this account approved the under-13 profile; used for "Withdraw approval"), summary: childSummary(progress) }] }`, covering every profile the account has any access to, excluding `awaiting_parent`.
  - The router's `parentUnlocked` guard returns `403 parent_locked` when `session.parentUnlockedUntil < now`.

- [ ] **Step 1: Write the failing tests:**
  - `overview without unlock → parent_locked`
  - `unlock code emailed; verify unlocks; overview lists own and view_only children with summaries`
  - `unlock expires after 15 minutes`
  - `student account cannot use parent endpoints → forbidden`
  - `wrong unlock code 5 times → too_many_attempts`
  - `overview never includes chat or message fields`: assert the response keys are exactly the documented set
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `parent.mjs` and register it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): emailed-code parent lock and child overview`

### Task 9: Links (share, request, guardian)

**Files:**
- Create: `backend/account/links.mjs`, `backend/account/links.test.mjs`
- Modify: `backend/account/auth.mjs` (an `onSignIn` hook list, and `pendingRequests` in `buildMe`)

**Interfaces:**
- Consumes: the invites, `grantAccess` and `revokeAccess` in the Repo; `parentUnlocked` auth
- Produces:
  - `applyInvitesForAccount(ctx, account)`, registered as an `onSignIn` hook and also called from `/me`. For each invite addressed to the account's email:
    - `share`: if the account's type is `student`, skip it and leave it pending. Otherwise set a `null` type to `parent` with `setupComplete = true`, grant `view_only` on `profileIds`, and delete the invite.
    - `guardian`: the same rule, but grant `guardian`.
    - `request`: left for the student to answer.
    - `consent`: handled in Task 6.
  - Endpoints:
    - `POST /links/share { profileId, parentEmail }`: student account, `owner` of the profile. If the target is a student account → `400 email_is_student`; if it's the caller's own email → 400. Creates a `share` invite and sends `share` with a sign-in token for `parentEmail`.
    - `POST /links/request { childEmail }` (`parentUnlocked`): creates a `request` invite and sends `access_request` with a sign-in token for `childEmail`. If the target account is a `parent` account → `400 email_is_parent` ("That email is set up as a parent account.").
    - `POST /links/respond { inviteId, allow: boolean, profileIds: string[] }`: the caller must be the invite's target and a `student` account. On allow, `profileIds` must be non-empty and all owned by the caller; it grants the requester `view_only` on each. Either way, it deletes the invite.
    - `POST /links/invite-guardian { profileId, email }` (`parentUnlocked`, `owner` or `guardian`): if the target is a student account → `400 email_is_student`. Creates a `guardian` invite and sends `guardian_invite`.
    - `POST /links/list { profileId }` (`owner` or `guardian`; on parent accounts, `parentUnlocked`) → `{ people: [{ accountId, email, kind, removable: boolean }] }`, excluding the caller.
    - `POST /links/remove { profileId, accountId }`. A removal is allowed when:
      - the owner removes a `guardian` or `view_only` link, **except** a `view_only` link with `consentGiver: true` while the profile is `under13`;
      - a guardian removes themselves;
      - a `view_only` holder removes themselves.
      Anything else is `403 forbidden`. On parent accounts, removal requires `parentUnlocked`.
  - `buildMe.pendingRequests`: for student accounts, the `request` invites addressed to the caller's email → `[{ inviteId, parentEmail }]`.

- [ ] **Step 1: Write the failing tests:**
  - `student shares; new parent signs in and sees child as view_only`
  - `share to existing parent applies on their next /me`
  - `share to student email → email_is_student`
  - `parent request appears in student's pendingRequests; allow with chosen profiles grants view_only to those only`
  - `decline deletes request without access`
  - `request to a parent account → email_is_parent`
  - `request to an email with no account waits; after student signs up it appears`
  - `guardian invite: guardian sees child in me.profiles with access guardian and can sync progress`
  - `guardian cannot delete the profile`: deferred to Task 10's tests, with the assertion recorded there
  - `owner removes guardian; guardian removes self; view_only removes self`
  - `student cannot remove under-13 consent-giver parent → forbidden`
  - `links/list marks removable correctly and excludes caller`
  - `invite expires after 30 days`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `links.mjs` and register it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): share, request, guardian links and removal rules`

### Task 10: Deletion and retention janitor

**Files:**
- Create: `backend/account/deletion.mjs`, `backend/account/deletion.test.mjs`
- Modify: `backend/account/profiles.mjs` (replace the Task 6 stub)

**Interfaces:**
- Produces:
  - `deleteAccountCascade(repo, accountId)`: deletes every profile the account **owns** (`deleteProfile`), revokes the account's own guardian and view_only access, deletes the invites it sent, and deletes the `EMAIL#` item and the account meta. Its sessions then fail because `/me` returns 401 once the account is missing.
  - Endpoints:
    - `POST /profiles/delete { profileId, code? }`: owner only (a guardian gets `403 forbidden`). On a parent account it needs `parentUnlocked`. On a student account it needs a `code` from `/delete/start`.
    - `POST /delete/start`: student accounts only. Issues a code (purpose `confirm_delete`, subject = accountId, 10 minutes) and sends `confirm_delete`.
    - `POST /account/delete { code? }`: the same lock rules. Calls `deleteAccountCascade`, deletes the session and clears the cookie.
  - `runJanitor({ repo, mailer, now })` → `{ warned, deletedAccounts, deletedAwaiting, deletedUnfinished }`:
    - an account whose `lastActiveAt` is older than 2 years minus 30 days, with no `warningSentAt`, gets a `retention_warning` (with a sign-in token) and `warningSentAt` is set;
    - an account whose `lastActiveAt` is older than 2 years gets `deleteAccountCascade`;
    - `touchActive` clears `warningSentAt`;
    - an `awaiting_parent` profile older than 7 days is deleted, and so is its account if no profiles remain;
    - an account with `setupComplete: false` that is older than 7 days is deleted.

- [ ] **Step 1: Write the failing tests:**
  - `parent deletes child after unlock; without unlock → parent_locked`
  - `guardian cannot delete the profile → forbidden`
  - `student account delete requires emailed code`
  - `child on parent's login cannot delete account without code → parent_locked`
  - `account delete removes owned profiles and progress but leaves guardian's other children intact`
  - `janitor warns at 2y-30d, deletes at 2y, not before`
  - `activity after warning prevents deletion`
  - `janitor deletes 8-day-old awaiting_parent profile and its empty account, keeps 6-day-old`
  - `janitor deletes 8-day-old unfinished setup`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `deletion.mjs`, wire up the decline path in `profiles.mjs`, and hook the janitor into `index.mjs`.
- [ ] **Step 4:** Run the full suite with `npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(account): deletion with locks and data-retention janitor`

### Task 11: Infrastructure

**Files:**
- Modify: `infra/main.tf`, `infra/variables.tf`, `infra/outputs.tf`

**Interfaces:**
- Produces: the Lambda env `TABLE_NAME`, `EMAIL_FROM`, `SITE_URL` and `EMAIL_MODE=ses`, and the routes `/api/account/*` → account Lambda.

- [ ] **Step 1:** Add `aws_dynamodb_table.accounts`: `${var.project}-accounts`, `PAY_PER_REQUEST`, hash key `pk` (S), range key `sk` (S), TTL on `ttl`, point-in-time recovery on, server-side encryption on (AWS-owned key).
- [ ] **Step 2:** Add `aws_iam_role.account_lambda` with basic execution, plus an inline policy for `dynamodb:GetItem, PutItem, DeleteItem, UpdateItem, Query, Scan` and `TransactWriteItems`/`ConditionCheckItem` on the table ARN, and `ses:SendEmail` on the SES identity ARN.
- [ ] **Step 3:** Change `data.archive_file.handler` `excludes` to also drop `**/*.test.mjs` and `account/testkit.mjs`. Add `aws_lambda_function.account`: `${var.project}-account`, handler `account/index.handler`, nodejs20.x, the same zip, 256 MB, timeout 10, with the env above. `EMAIL_FROM` is `var.email_from`, which defaults to `"SumDeTing <no-reply@${var.domain_name}>"` through a local when it's empty.
- [ ] **Step 4:** Add `aws_lambda_function_url.account` (`AWS_IAM`, `BUFFERED`), `aws_cloudfront_origin_access_control` reuse (the existing `api` OAC is fine), a new CloudFront origin `lambda-account`, and an `ordered_cache_behavior` with `path_pattern = "/api/account/*"`, all methods, CachingDisabled, and origin request policy **Managed-AllViewerAndCloudFrontHeaders-2022-06**. Look up the id with `aws cloudfront list-origin-request-policies --type managed` and use the id itself, with a comment. Add both `aws_lambda_permission` resources, mirroring the tutor's.
- [ ] **Step 5:** Add `aws_sesv2_email_identity` for `var.domain_name` (guarded with `count = var.domain_name == "" ? 0 : 1`), and three DKIM CNAME `aws_route53_record`s with `provider = aws.dns` in `var.dns_zone_id`.
- [ ] **Step 6:** Add `aws_scheduler_schedule.janitor`: `rate(1 day)`, target = the account Lambda, input `{"janitor":true}`, with a scheduler role allowed `lambda:InvokeFunction` on it.
- [ ] **Step 7:** Add `aws_s3_object`s for `account-core.mjs` (`text/javascript`), `account-ui.mjs` (`text/javascript`), `account.css` (`text/css`) and `privacy.html` (`text/html`), each with `cache_control = "public, max-age=300"`.
- [ ] **Step 8:** Add outputs `accounts_table` and `account_function`.
- [ ] **Step 9:** Run `cd infra && tofu fmt -recursive && tofu init -backend=false && tofu validate`. Expected: `Success! The configuration is valid.`
- [ ] **Step 10: Commit:** `feat(infra): accounts table, account Lambda, SES identity, janitor schedule`

**Do not run `tofu apply`.** The owner applies it after review. Production applies need confirmation.

### Task 12: Launch runbook

**Files:**
- Create: `docs/launch-runbook.md`

- [ ] **Step 1:** Write the runbook:
  1. The two lead-time requests from "Before Task 1", with the commands and how to check their status (`aws sesv2 get-account`; `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384`).
  2. `tofu apply`, then wait for the DKIM status to read `SUCCESS` (`aws sesv2 get-email-identity --email-identity <domain>`).
  3. Post-deploy checks: `curl -s -XPOST https://<site>/api/account/me -H 'x-amz-content-sha256: <sha of empty body>'` should return 401 `not_signed_in`, and a real sign-in to a test inbox should succeed. This also confirms that the runtime-provided `@aws-sdk/lib-dynamodb` exists. If it doesn't, bundle `backend/node_modules` for the account Lambda only.
  4. A privacy notice review against the Barbados Data Protection Act 2019, signed off by the owner.
- [ ] **Step 2: Commit:** `docs: launch runbook for accounts`

### Task 13: Frontend core and index.html bridge

**Files:**
- Create: `web/account-core.mjs`, `web/account-core.test.mjs`
- Modify: `web/index.html` (`:1212-1230` prefs, `:1292-1360` mastery, `:1380-1395` afterReply, `:1443-1490` session, `:654-664` header), `backend/package.json` (test script becomes `node --test account/ ../web/`)

**Interfaces:**
- Produces in `index.html` (classic script):
  - `let activeProfileId = null;` and `function storageKey(base, pid = activeProfileId) → string`, which returns `base` when `pid` is null and `` `${base}.${pid}` `` otherwise. `loadMastery`, `saveMastery` and the prefs read/write use `storageKey(MASTERY_KEY)` and `storageKey(PREFS_KEY)`. The chat session key stays global.
  - `emitProgress(event)`: adds `id: crypto.randomUUID()` and dispatches `new CustomEvent('sumdeting:progress', { detail: event })` on `window`. It's called from `recordOutcome` (`type: 'outcome'`), `recordActivity` (`type: 'activity'`) and the prefs change handler (`type: 'prefs'`), each with the same values written locally.
  - `window.SumDeTing = { storageKey, setActiveProfile(pid | null), clearChat(), reloadLocalState(), sha256Hex, levels: LEVELS }`. `clearChat` contains the "New session" logic without the `confirm()` and is reused by that button. `reloadLocalState` re-reads prefs into the selects and calls `renderMastery()`.
  - The header gets `<div id="account-slot"></div>` before `.menu-wrap`, plus `<link rel="stylesheet" href="account.css">` and `<script type="module" src="account-ui.mjs"></script>`.
- Produces in `account-core.mjs` (pure, with `storage` and `fetch` injected):
  - `createApi({ fetchImpl, sha256Hex, base = '/api/account' }) → (path, body = {}) → Promise<{ ok, status, data }>`, with `credentials: 'same-origin'` and the `x-amz-content-sha256` header
  - `createQueue(storage, pid) → { push(event), size(), flush(api) → Promise<'ok' | 'signedOut' | 'retry' | 'gone'> }`, persisted at `sumdeting.queue.<pid>`. Each flush sends up to 100 events; a 200 removes the sent events. `401` → `'signedOut'` (queue kept). `404` or `403` → `'gone'` (queue dropped). Network errors and 429 or 5xx → `'retry'`.
  - `hasAnonymousProgress(storage) → boolean`: true if `mathmentor.mastery.v1` has any topic with `attempted + solved > 0`, or a streak count above 0
  - `readAnonymous(storage) → { mastery, prefs }`; `clearAnonymous(storage)` removes `mathmentor.mastery.v1` and `mathmentor.prefs.v1`
  - `clearProfileCaches(storage)` removes every `mathmentor.mastery.<id>`, `mathmentor.prefs.<id>` and `sumdeting.queue.<id>`, plus `mathmentor.session.v1` and `sumdeting.activeProfile`
  - `statusLabel(status)`: `hard` → "Finding it hard", `confident` → "Confident", `getting_there` → "Getting there"
  - `initials(first, last) → string` (two upper-case letters)
  - `parseSigninFragment(hash) → string | null`, which reads `#signin=<token>`

- [ ] **Step 1: Write the failing tests** in `web/account-core.test.mjs`, using a `Map`-backed fake storage and a fake fetch:
  - `api sends sha header and same-origin credentials`
  - `queue persists across instances`
  - `flush 200 empties queue`
  - `401 on sync keeps queue and reports signedOut`
  - `404 drops queue and reports gone`
  - `network error reports retry and keeps queue`
  - `flush sends at most 100 per call`
  - `hasAnonymousProgress false for empty and true for streak or topics`
  - `clearProfileCaches removes profile keys but not mathmentor.mastery.v1`
  - `statusLabel maps all three`
  - `parseSigninFragment reads token and ignores other hashes`
- [ ] **Step 2:** Run `cd backend && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `account-core.mjs` and the `index.html` changes above.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Then run `node server.mjs`, open the app signed out, solve a problem, and confirm `mathmentor.mastery.v1` updates exactly as before (no regression for signed-out users).
- [ ] **Step 5: Commit:** `feat(web): account core module and index.html bridge`

### Task 14: Sign-in, setup and profile UI

**Files:**
- Create: `web/account-ui.mjs`, `web/account.css`, `e2e/package.json`, `e2e/playwright.config.mjs`, `e2e/account.spec.mjs`
- Modify: `.github/workflows/pr.yml` (e2e job)

**Interfaces:**
- Consumes: everything in Task 13, plus `/me`, `/signin/*`, `/setup`, `/profiles/*`, `/consent/*`, `/progress/*` and `/links/respond`
- Screens. Layout and copy follow `.superpowers/brainstorm/70060-1794155028/content/signin-flow.html` and `signup-v2.html`, **without emojis**, styled with the existing CSS tokens so both themes work:
  1. **Profile icon** in `#account-slot`: an outline person SVG when signed out; the initials in the profile colour when signed in.
  2. **The "this device only" tag** next to the existing progress line (`#mastery`) when signed out.
  3. **The "Keep your progress" bottom sheet**: an email field (placeholder "Your email, or a parent's"), "Email me a sign-in link", "Not now", and a link to the privacy notice.
  4. **"Check your email"**: the masked email, a 6-digit code field, "Resend" and "Use a different email".
  5. **On load**: if `parseSigninFragment(location.hash)` returns a token, POST `/signin/verify`, then `history.replaceState` to remove the fragment.
  6. **"Who's setting this up?"**, then **Add your child** (parent) or **Tell us about you** (student, with the "Are you 13 or older?" Yes/No; No shows the parent email field). The copy is from the spec.
  7. **"Who's practising?"**: tiles for `owner` and `guardian` profiles, plus an "Add a student" tile (on parent accounts it starts the parent unlock from Task 15), and the "See how everyone is doing" link (parent accounts only).
  8. **Choosing a profile**: `SumDeTing.setActiveProfile(pid)` and `clearChat()`; `/progress/get` writes the local cache under `storageKey`; `reloadLocalState()`; the level select defaults to the profile's level. If `hasAnonymousProgress`, show "Add the progress on this device to <name>'s profile?" with **Add** (`/progress/merge`, then `clearAnonymous`, then the notice "Progress on this device was added to <name>'s profile.") or **Not mine**.
  9. **Syncing**: listen for `sumdeting:progress` → `queue.push`; flush at most once every 5 s, on `visibilitychange` to hidden (`fetch` with `keepalive`), and on profile switch. `'signedOut'` → drop to signed-out mode and show "You've been signed out. Your practice still works on this device." `'gone'` → the same, but the notice reads "This profile is no longer available."
  10. **The "Waiting for your parent to approve" banner** with a Resend button, shown for an `awaiting_parent` profile. The app stays in signed-out storage mode.
  11. **"<Parent email> wants to see your progress"** notice for `pendingRequests`: Allow (with a tick list of the student's profiles when there's more than one) and Decline.
  12. **Parent consent screen** for `pendingConsents`: the spec's parent consent wording, plus Approve and Decline.
  13. **Profile menu**: Switch student, Share my progress with a parent (student accounts), Who can see my progress, Sign out (`/signout`, `clearProfileCaches`, `clearChat`, `setActiveProfile(null)`, `reloadLocalState`).
  - Remember the active profile per device at `sumdeting.activeProfile`.

- [ ] **Step 1: Write the failing e2e tests** in `account.spec.mjs`. The config's `webServer` runs `ACCOUNT_DEV=1 node ../server.mjs` on port 8099. Read emails from `/api/account/_dev/outbox`.
  - `signed-out app unchanged: no account calls block practice and the "this device only" tag shows`
  - `magic link signs in: open /#signin=<token> from outbox, fragment removed, setup appears`
  - `code fallback signs in`
  - `parent adds two children and sees Who's practising tiles`
  - `merge prompt: Add moves device progress into profile; Not mine leaves it`
  - `sign out clears profile caches and chat`
  - `progress follows student to a second browser context`: dispatch a `sumdeting:progress` outcome in context A, sign in as the same email in context B, and check that the topic count shows
  - `under-13 sign-up shows waiting banner; parent approves from consent email; banner gone after reload`
  - `link scanner GET of the sign-in URL does not consume the token`: `request.get('/')` with the URL, then the browser still signs in with that token
  - `no emoji in account UI`: scan `document.body.innerText` for `\p{Extended_Pictographic}` across the screens visited
- [ ] **Step 2:** Run `cd e2e && npm install && npx playwright install chromium && npx playwright test`. Expected: FAIL.
- [ ] **Step 3:** Implement `account-ui.mjs` and `account.css`.
- [ ] **Step 4:** Run the e2e tests. Expected: PASS.
- [ ] **Step 5:** Add a `pr.yml` job named `e2e` that installs backend deps, then e2e deps and chromium, and runs `npx playwright test`.
- [ ] **Step 6: Commit:** `feat(web): sign-in, setup, profiles, merge and sync UI`

### Task 15: Parent section UI

**Files:**
- Modify: `web/account-ui.mjs`, `web/account.css`, `e2e/account.spec.mjs`

**Interfaces:**
- Consumes: `/parent/*`, `/links/*`, `/profiles/update`, `/profiles/delete`, `/delete/start` and `/account/delete`; `statusLabel` and `initials` (Task 13)
- Screens. Layout follows `parent-view.html`, without emojis:
  1. **Unlock**: "We've emailed you a code" with a 6-digit field. It's triggered by any parent-only action when the server returns `parent_locked`, then the original action is retried.
  2. **"See how everyone is doing"**: a list of children, each with an "Owner", "Guardian" or "View only" label.
  3. **One child's progress**: name and level, "last practised", three stat boxes (day streak, problems solved, topics tried), and the "Needs practice" and "Going well" groups. Each topic row shows a bar (`solved / attempted`), "X of Y solved", "often needed hints" when `hintsOften`, and the `statusLabel` pill.
  4. **Per-child actions** (owner or guardian): Edit, Add another parent or guardian, Who can see this child's progress (with Remove buttons where `removable`), and Remove child (owner only).
  5. **"Add a child who has their own account"** (email) → `/links/request`, showing the `email_is_parent` copy from the spec.
  6. **Delete account**: on parent accounts behind the lock; on student accounts with the `/delete/start` code screen.

- [ ] **Step 1: Write the failing e2e tests:**
  - `parent section asks for emailed code; wrong code shows error; right code opens overview`
  - `child on parent's login cannot open parent section without code`
  - `overview shows Needs practice / Going well with correct labels`: seed with progress events producing one `hard` and one `confident` topic
  - `guardian invite: second email signs in, practises as the child, progress visible to both`
  - `parent requests access to a student account; student allows; child appears as View only`
  - `student cannot remove under-13 consent-giver parent (no Remove button)`
  - `delete account behind lock removes everything; signing in again starts setup`
- [ ] **Step 2:** Run `npx playwright test`. Expected: FAIL.
- [ ] **Step 3:** Implement the screens.
- [ ] **Step 4:** Run `npx playwright test` and `cd backend && npm test`. Expected: all PASS.
- [ ] **Step 5: Commit:** `feat(web): locked parent section, guardians and view-only links`

### Task 16: Privacy notice, README and smoke check

**Files:**
- Create: `web/privacy.html`
- Modify: `README.md`, `.github/smoke/smoke.mjs`

- [ ] **Step 1:** Write `web/privacy.html` as a standalone page in the site's style (with the theme tokens copied from `index.html:44-100`). It's written in plain language for parents and covers:
  - what's stored (the profile fields, practice progress, email);
  - what's never stored (chats, photos, date of birth, school);
  - why it's stored;
  - who can see it (owner, guardians, view-only parents);
  - how under-13 approval works;
  - how long data is kept (the Global Constraints values);
  - how to delete data (profile menu or parent section);
  - a contact address.
  Mark it as a draft for the owner's review in an HTML comment at the top.
- [ ] **Step 2:** Update the README. Replace "Nothing is stored server-side…" with an accurate description, add the account Lambda and DynamoDB to the architecture mermaid diagram, and document `ACCOUNT_DEV=1 node server.mjs` and `npm test`.
- [ ] **Step 3:** Add smoke checks:
  - `privacy page loads (200)`
  - `account endpoint reachable`: POST `/api/account/me` with the sha header → 401 with `{"error":"not_signed_in"}`
  - `account-ui.mjs loaded`: `#account-slot` contains a button
- [ ] **Step 4:** Run `BASE_URL=http://localhost:8080 node .github/smoke/smoke.mjs` against `ACCOUNT_DEV=1 node server.mjs`. Expected: the new checks PASS. Ignore CSP/HSTS failures that only apply to CloudFront.
- [ ] **Step 5: Commit:** `docs: privacy notice draft, README and smoke checks for accounts`
