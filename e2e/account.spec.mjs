// End-to-end tests for the account UI (sign-in, setup, profiles, merge, sync).
// The server runs with ACCOUNT_DEV=1, so accounts live in memory and emails
// are readable from GET /api/account/_dev/outbox. The tutor chat (Bedrock) is
// never called: progress is driven by dispatching `sumdeting:progress` events
// and by seeding localStorage.
import { test, expect } from "@playwright/test";

const ANON_MASTERY = "mathmentor.mastery.v1";
const ANON_PREFS = "mathmentor.prefs.v1";
const SESSION_KEY = "mathmentor.session.v1";
const EMOJI = /\p{Extended_Pictographic}/u;

let seq = 0;
const uniqueEmail = (name) => `${name}-${Date.now().toString(36)}-${seq++}@example.com`;
const today = () => new Date().toISOString().slice(0, 10);

async function outbox(request) {
  const r = await request.get("/api/account/_dev/outbox");
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function lastMail(request, to, kind) {
  let mail;
  await expect.poll(async () => {
    mail = (await outbox(request)).filter((m) => m.to === to && m.kind === kind).at(-1);
    return Boolean(mail);
  }).toBe(true);
  return mail;
}

const tokenOf = (mail) => /#signin=([^\s]+)/.exec(mail.text)[1];
const codeOf = (mail) => /Your code: (\d{6})/.exec(mail.text)[1];

const accountBtn = (page) => page.locator("#account-btn");
const dialog = (page) => page.getByRole("dialog").last();

/** Open the sign-in sheet and request an email. Returns the sign-in email. */
async function requestSignin(page, request, email) {
  await accountBtn(page).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "Keep your progress" })).toBeVisible();
  await sheet.getByLabel("Email").fill(email);
  await sheet.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Check your email" })).toBeVisible();
  return lastMail(request, email, "signin");
}

/** Full magic-link sign-in in a fresh page load. */
async function signIn(page, request, email) {
  await page.goto("/");
  const mail = await requestSignin(page, request, email);
  await page.goto("about:blank");
  await page.goto(`/#signin=${tokenOf(mail)}`);
}

/** Fill the shared profile form. */
async function fillProfile(scope, { first, last, level = "CSEC" }) {
  await scope.getByLabel(/first name/i).fill(first);
  await scope.getByLabel(/last name/i).fill(last);
  await scope.getByRole("radio", { name: level, exact: true }).check();
}

/** Sign up a 13+ student with one profile; ends on the active profile. */
async function signUpStudent(page, request, email, profile = { first: "Jaden", last: "Clarke" }) {
  await signIn(page, request, email);
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
  await d.getByRole("button", { name: /I'm a student/ }).click();
  await expect(dialog(page).getByRole("heading", { name: "Tell us about you" })).toBeVisible();
  await fillProfile(dialog(page), profile);
  await dialog(page).getByRole("radio", { name: "Yes" }).check();
  await dialog(page).getByLabel("I agree to SumDeTing saving my practice progress.").check();
  await dialog(page).getByRole("button", { name: "Start practising" }).click();
}

const activePid = (page) => page.evaluate(() => localStorage.getItem("sumdeting.activeProfile"));

async function seedAnonymous(page) {
  await page.evaluate(({ ANON_MASTERY, ANON_PREFS, d }) => {
    localStorage.setItem(ANON_MASTERY, JSON.stringify({
      topics: { Fractions: { attempted: 2, solved: 3, hist: [{ d, ok: 1, hints: 0, turns: 2 }] } },
      streak: { count: 2, last: d },
      days: { [d]: 3 },
    }));
    localStorage.setItem(ANON_PREFS, JSON.stringify({ level: "CSEC", topic: "Algebra", duration: "60" }));
  }, { ANON_MASTERY, ANON_PREFS, d: today() });
}

test("signed-out app unchanged: no account calls block practice and the \"this device only\" tag shows", async ({ page }) => {
  // Account calls never answer: the app must still be fully usable.
  await page.route("**/api/account/**", () => { /* hang forever */ });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Give me a problem" })).toBeEnabled();
  await expect(accountBtn(page)).toBeVisible();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("#nav-string").click();
  await expect(page.getByText("this device only")).toBeVisible();
  // Level tabs still work.
  await page.locator("#nav-home").click();
  await page.locator("#level-tabs .seg").first().click();
  await expect(page.locator("#level-tabs .seg").first()).toHaveClass(/on/);
});

test("magic link signs in: open /#signin=<token> from outbox, fragment removed, setup appears", async ({ page, request }) => {
  const email = uniqueEmail("magic");
  await signIn(page, request, email);
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await expect(dialog(page).getByRole("button", { name: /I'm a parent or guardian/ })).toBeVisible();
});

test("code fallback signs in", async ({ page, request }) => {
  const email = uniqueEmail("code");
  await page.goto("/");
  const mail = await requestSignin(page, request, email);
  const d = dialog(page);
  await expect(d.getByText(/c•••@example\.com/)).toBeVisible();
  await d.getByLabel("6-digit code").fill("000000");
  await d.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText(/didn't work/);
  await d.getByLabel("6-digit code").fill(codeOf(mail));
  await d.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
});

test("parent adds two children and sees Who's practising tiles", async ({ page, request }) => {
  await signIn(page, request, uniqueEmail("parent"));
  await dialog(page).getByRole("button", { name: /I'm a parent or guardian/ }).click();
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "Add your child" })).toBeVisible();
  await fillProfile(d, { first: "Aaliyah", last: "Best", level: "Common Entrance" });
  const consent = "I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress.";
  // Consent is required.
  await d.getByRole("button", { name: "Save and add another" }).click();
  await expect(d.getByRole("alert")).toBeVisible();
  await d.getByLabel(consent).check();
  await d.getByRole("button", { name: "Save and add another" }).click();
  await expect(d.getByLabel(/first name/i)).toHaveValue("");
  await fillProfile(d, { first: "Jaden", last: "Best", level: "Add Maths" });
  await d.getByLabel(consent).check();
  await d.getByRole("button", { name: "Done, start practising" }).click();
  const picker = dialog(page);
  await expect(picker.getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await expect(picker.getByRole("button", { name: /Aaliyah Best.*Common Entrance/ })).toBeVisible();
  await expect(picker.getByRole("button", { name: /Jaden Best.*Add Maths/ })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Add a student" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "See how everyone is doing" })).toBeVisible();
  await picker.getByRole("button", { name: /Jaden Best/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(accountBtn(page)).toHaveText("JB");
  await expect(page.locator("#level")).toHaveValue("Additional Maths");
});

test("merge prompt: Add moves device progress into profile; Not mine leaves it", async ({ page, request }) => {
  const email = uniqueEmail("merge");
  await page.goto("/");
  await seedAnonymous(page);
  await signUpStudent(page, request, email, { first: "Maya", last: "King" });
  const prompt = dialog(page);
  await expect(prompt.getByText("Add the progress on this device to Maya's profile?")).toBeVisible();
  await prompt.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Progress on this device was added to Maya's profile.")).toBeVisible();
  const pid = await activePid(page);
  const after = await page.evaluate(({ ANON_MASTERY, pid }) => ({
    anon: localStorage.getItem(ANON_MASTERY),
    cached: JSON.parse(localStorage.getItem(`${ANON_MASTERY}.${pid}`)),
    mergeId: localStorage.getItem(`sumdeting.mergeId.${pid}`),
  }), { ANON_MASTERY, pid });
  expect(after.anon).toBeNull();
  expect(after.cached.topics.Fractions.solved).toBe(3);
  expect(after.mergeId).toBeNull();

  // Sign out, practise anonymously again, sign back in and refuse the merge.
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Sign out" }).click();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
  await seedAnonymous(page);
  await signIn(page, request, email);
  await dialog(page).getByRole("button", { name: /Maya King/ }).click();
  await expect(dialog(page).getByText("Add the progress on this device to Maya's profile?")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Not mine" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const left = await page.evaluate(({ ANON_MASTERY, pid }) => ({
    anon: JSON.parse(localStorage.getItem(ANON_MASTERY)),
    cached: JSON.parse(localStorage.getItem(`${ANON_MASTERY}.${pid}`)),
  }), { ANON_MASTERY, pid });
  expect(left.anon.topics.Fractions.solved).toBe(3);
  expect(left.cached.topics.Fractions.solved).toBe(3); // not added twice

  // The decline is remembered: no prompt on reload, nor on choosing again with the same data.
  await page.reload();
  await expect(accountBtn(page)).toHaveText("MK");
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Switch student" }).click();
  await dialog(page).getByRole("button", { name: /Maya King/ }).click();
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // New signed-out practice changes the blob, so an explicit choice asks again.
  await page.evaluate(({ ANON_MASTERY }) => {
    const m = JSON.parse(localStorage.getItem(ANON_MASTERY));
    m.topics.Fractions.solved += 1;
    localStorage.setItem(ANON_MASTERY, JSON.stringify(m));
  }, { ANON_MASTERY });
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Switch student" }).click();
  await dialog(page).getByRole("button", { name: /Maya King/ }).click();
  await expect(dialog(page).getByText("Add the progress on this device to Maya's profile?")).toBeVisible();
});

test("involuntary sign-out drops cached progress, keeps the queue, and the next account clears it", async ({ page, context, request }) => {
  await signUpStudent(page, request, uniqueEmail("expired"), { first: "Ava", last: "Hope" });
  await expect(accountBtn(page)).toHaveText("AH");
  const pid = await activePid(page);
  await page.evaluate((pid) => localStorage.setItem(`mathmentor.mastery.v1.${pid}`, JSON.stringify({ topics: { Algebra: { attempted: 1, solved: 0 } }, streak: { count: 0, last: "" }, days: {} })), pid);
  await context.clearCookies(); // the session ends server-side as far as this browser knows
  await page.evaluate((d) => window.dispatchEvent(new CustomEvent("sumdeting:progress", {
    detail: { id: crypto.randomUUID(), type: "activity", topic: "Algebra", solved: true, d },
  })), today());
  await expect(page.getByText("You've been signed out. Your practice still works on this device.")).toBeVisible();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
  const after = await page.evaluate((pid) => ({
    mastery: localStorage.getItem(`mathmentor.mastery.v1.${pid}`),
    prefs: localStorage.getItem(`mathmentor.prefs.v1.${pid}`),
    queue: JSON.parse(localStorage.getItem(`sumdeting.queue.${pid}`) ?? "[]").length,
    last: localStorage.getItem("sumdeting.lastAccount"),
  }), pid);
  expect(after.mastery).toBeNull();
  expect(after.prefs).toBeNull();
  expect(after.queue).toBe(1);
  expect(after.last).toBeTruthy();

  // Someone else signs in on this device: the previous account's leftovers go.
  await signIn(page, request, uniqueEmail("next-person"));
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.includes(pid))).toEqual([]);
});

test("sign out clears profile caches and chat", async ({ page, request }) => {
  await signUpStudent(page, request, uniqueEmail("signout"), { first: "Ria", last: "Ward" });
  await expect(accountBtn(page)).toHaveText("RW");
  const pid = await activePid(page);
  expect(pid).toBeTruthy();
  await page.evaluate(({ SESSION_KEY }) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      t: Date.now(),
      messages: [{ role: "user", content: "Secret question about ratios" }, { role: "assistant", content: "What do you notice first?" }],
    }));
  }, { SESSION_KEY });
  await page.reload();
  await expect(page.getByText("Secret question about ratios")).toBeVisible();
  await expect(accountBtn(page)).toHaveText("RW");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Sign out" }).click();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
  await expect(page.getByText("Secret question about ratios")).toHaveCount(0);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.includes(pid))).toEqual([]);
  expect(keys).not.toContain(SESSION_KEY);
  expect(keys).not.toContain("sumdeting.activeProfile");
  await page.reload();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
});

test("progress follows student to a second browser context", async ({ browser, page, request }) => {
  const email = uniqueEmail("follow");
  await signUpStudent(page, request, email, { first: "Kai", last: "Moore" });
  await expect(accountBtn(page)).toHaveText("KM");
  const synced = page.waitForResponse((r) => r.url().endsWith("/api/account/progress/sync") && r.ok());
  await page.evaluate((d) => {
    const fire = (detail) => window.dispatchEvent(new CustomEvent("sumdeting:progress", { detail }));
    fire({ id: crypto.randomUUID(), type: "activity", topic: "Trigonometry", solved: true, d });
    fire({ id: crypto.randomUUID(), type: "outcome", topic: "Trigonometry", ok: true, hints: 0, turns: 2, d });
  }, today());
  await synced;

  const other = await browser.newContext();
  const pageB = await other.newPage();
  await signIn(pageB, request, email);
  await dialog(pageB).getByRole("button", { name: /Kai Moore/ }).click();
  await expect(pageB.getByRole("dialog")).toHaveCount(0);
  await pageB.locator("#nav-string").click();
  await expect(pageB.locator("#string-count")).toHaveText("1");
  await expect(pageB.locator(".trow", { hasText: "Trigonometry" })).toContainText("Attempted");
  await expect(pageB.getByText("this device only")).toBeHidden();
  await other.close();
});

test("under-13 sign-up shows waiting banner; parent approves from consent email; banner gone after reload", async ({ browser, page, request }) => {
  const parentEmail = uniqueEmail("guardian");
  await signIn(page, request, uniqueEmail("young"));
  await dialog(page).getByRole("button", { name: /I'm a student/ }).click();
  const d = dialog(page);
  await fillProfile(d, { first: "Zara", last: "Small", level: "Common Entrance" });
  await d.getByRole("radio", { name: "No" }).check();
  await d.getByLabel(/parent's or guardian's email/i).fill(parentEmail);
  await d.getByRole("button", { name: "Start practising" }).click();
  const banner = page.getByText("Waiting for your parent to approve. Your progress is saved on this device for now.");
  await expect(banner).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend" })).toBeVisible();
  // Still signed-out storage: practice lands in the anonymous key.
  expect(await page.evaluate(() => window.SumDeTing.storageKey("mathmentor.mastery.v1"))).toBe("mathmentor.mastery.v1");

  const mail = await lastMail(request, parentEmail, "consent_request");
  const parentCtx = await browser.newContext();
  const pp = await parentCtx.newPage();
  await pp.goto(`/#signin=${tokenOf(mail)}`);
  const c = dialog(pp);
  await expect(c.getByText(/Zara Small wants to use SumDeTing/)).toBeVisible();
  await c.getByLabel("I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress.").check();
  await c.getByRole("button", { name: "Approve" }).click();
  await expect(pp.getByText(/Zara Small wants to use SumDeTing/)).toHaveCount(0);
  await parentCtx.close();

  await page.reload();
  await expect(banner).toBeHidden();
  await expect(accountBtn(page)).toHaveText("ZS");
});

test("link scanner GET of the sign-in URL does not consume the token", async ({ page, request }) => {
  const email = uniqueEmail("scanner");
  await page.goto("/");
  const mail = await requestSignin(page, request, email);
  const url = `/#signin=${tokenOf(mail)}`;
  const scanned = await request.get(url);
  expect(scanned.ok()).toBeTruthy();
  await page.goto("about:blank");
  await page.goto(url);
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
});

test("no emoji in account UI", async ({ page, request }) => {
  const seen = [];
  const snap = async (label) => seen.push([label, await page.evaluate(() => document.body.innerText)]);
  await page.goto("/");
  await snap("signed out");
  const email = uniqueEmail("emoji");
  await accountBtn(page).click();
  await snap("sign-in sheet");
  await dialog(page).getByLabel("Email").fill(email);
  await dialog(page).getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Check your email" })).toBeVisible();
  await snap("check email");
  const mail = await lastMail(request, email, "signin");
  await page.goto("about:blank");
  await page.goto(`/#signin=${tokenOf(mail)}`);
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
  await snap("setup");
  await dialog(page).getByRole("button", { name: /I'm a student/ }).click();
  await dialog(page).getByRole("radio", { name: "No" }).check();
  await snap("student form");
  await dialog(page).getByRole("radio", { name: "Yes" }).check();
  await fillProfile(dialog(page), { first: "Theo", last: "Lane" });
  await dialog(page).getByLabel("I agree to SumDeTing saving my practice progress.").check();
  await dialog(page).getByRole("button", { name: "Start practising" }).click();
  await expect(accountBtn(page)).toHaveText("TL");
  await snap("signed in");
  await accountBtn(page).click();
  await snap("profile menu");
  await dialog(page).getByRole("button", { name: "Switch student" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await snap("picker");
  for (const [label, text] of seen) {
    expect(text.match(EMOJI), `emoji on screen: ${label}`).toBeNull();
  }
});

test("existing parent approves a consent after the parent code unlock", async ({ browser, page, request }) => {
  const parentEmail = uniqueEmail("existing-parent");
  // The parent sets up first (setup unlocks only that session).
  const parentCtx = await browser.newContext();
  const pp = await parentCtx.newPage();
  await signIn(pp, request, parentEmail);
  await dialog(pp).getByRole("button", { name: /I'm a parent or guardian/ }).click();
  await fillProfile(dialog(pp), { first: "Omar", last: "Gill" });
  await dialog(pp).getByLabel("I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress.").check();
  await dialog(pp).getByRole("button", { name: "Done, start practising" }).click();
  await expect(dialog(pp).getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await parentCtx.close();

  // A child signs up under 13 with that parent's email.
  await signIn(page, request, uniqueEmail("sibling"));
  await dialog(page).getByRole("button", { name: /I'm a student/ }).click();
  await fillProfile(dialog(page), { first: "Lia", last: "Gill", level: "Common Entrance" });
  await dialog(page).getByRole("radio", { name: "No" }).check();
  await dialog(page).getByLabel(/parent's or guardian's email/i).fill(parentEmail);
  await dialog(page).getByRole("button", { name: "Start practising" }).click();
  await expect(page.getByText("Waiting for your parent to approve. Your progress is saved on this device for now.")).toBeVisible();

  // The parent opens the consent link in a fresh session: approving needs the parent code.
  const consentMail = await lastMail(request, parentEmail, "consent_request");
  const freshCtx = await browser.newContext();
  const fp = await freshCtx.newPage();
  await fp.goto(`/#signin=${tokenOf(consentMail)}`);
  await expect(dialog(fp).getByText(/Lia Gill wants to use SumDeTing/)).toBeVisible();
  await dialog(fp).getByLabel("I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress.").check();
  await dialog(fp).getByRole("button", { name: "Approve" }).click();
  const unlock = dialog(fp);
  await expect(unlock.getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  const codeMail = await lastMail(request, parentEmail, "parent_code");
  await unlock.getByLabel("6-digit code").fill(codeOf(codeMail));
  await unlock.getByRole("button", { name: "Unlock" }).click();
  const picker = dialog(fp);
  await expect(picker.getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await expect(fp.getByText("You approved Lia. Their practice progress will be saved.")).toBeVisible();
  // Still unlocked: the parent section link opens without another code.
  await picker.getByRole("button", { name: "See how everyone is doing" }).click();
  await expect(dialog(fp).getByRole("heading", { name: "See how everyone is doing" })).toBeVisible();
  await freshCtx.close();

  await page.reload();
  await expect(page.getByText("Waiting for your parent to approve.", { exact: false })).toBeHidden();
  await expect(accountBtn(page)).toHaveText("LG");
});

// ---- Parent section (Task 15) ----

const PARENT_CONSENT = "I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress.";

/** Wait for a mail newer than the `before` count for this address and kind. */
async function nextMail(request, to, kind, before) {
  let mail;
  await expect.poll(async () => {
    const list = (await outbox(request)).filter((m) => m.to === to && m.kind === kind);
    mail = list.length > before ? list.at(-1) : null;
    return Boolean(mail);
  }).toBe(true);
  return mail;
}
const mailCount = async (request, to, kind) =>
  (await outbox(request)).filter((m) => m.to === to && m.kind === kind).length;

/** Parent setup with the given children; ends on "Who's practising?" (this session is unlocked). */
async function setUpParent(page, request, email, children) {
  await signIn(page, request, email);
  await dialog(page).getByRole("button", { name: /I'm a parent or guardian/ }).click();
  for (const [i, child] of children.entries()) {
    const d = dialog(page);
    await expect(d.getByRole("heading", { name: "Add your child" })).toBeVisible();
    await fillProfile(d, child);
    await d.getByLabel(PARENT_CONSENT).check();
    if (i < children.length - 1) {
      await d.getByRole("button", { name: "Save and add another" }).click();
      await expect(d.getByLabel(/first name/i)).toHaveValue("");
    } else {
      await d.getByRole("button", { name: "Done, start practising" }).click();
    }
  }
  await expect(dialog(page).getByRole("heading", { name: "Who's practising?" })).toBeVisible();
}

/** A new browser context signed in as `email` (a fresh, locked session). Ends on whatever route shows. */
async function freshSession(browser, request, email) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await signIn(p, request, email);
  return { ctx, page: p };
}

/** Answer the parent unlock screen with the newest code emailed after `before`. */
async function unlock(page, request, email, before) {
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  const mail = await nextMail(request, email, "parent_code", before);
  await d.getByLabel("6-digit code").fill(codeOf(mail));
  await d.getByRole("button", { name: "Unlock" }).click();
}

/** From the picker after setup (Done locks the section): open the parent section with the emailed code. */
async function openSectionWithCode(page, request, email) {
  const before = await mailCount(request, email, "parent_code");
  await dialog(page).getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(page, request, email, before);
  await expect(overviewHeading(page)).toBeVisible();
}

const overviewHeading = (page) => dialog(page).getByRole("heading", { name: "See how everyone is doing" });
const childRow = (page, name) => dialog(page).getByRole("button", { name: new RegExp(name) });

/** Dispatch progress events and wait until the server has them. */
async function practise(page, events) {
  const synced = page.waitForResponse((r) => r.url().endsWith("/api/account/progress/sync") && r.ok());
  await page.evaluate(({ events, d }) => {
    for (const e of events) window.dispatchEvent(new CustomEvent("sumdeting:progress", { detail: { id: crypto.randomUUID(), d, ...e } }));
  }, { events, d: today() });
  await synced;
}

test("parent section asks for emailed code; wrong code shows error; right code opens overview", async ({ browser, page, request }) => {
  const email = uniqueEmail("lock");
  await setUpParent(page, request, email, [{ first: "Aaliyah", last: "Best", level: "Common Entrance" }]);
  const { ctx, page: p } = await freshSession(browser, request, email);
  await expect(dialog(p).getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  const before = await mailCount(request, email, "parent_code");
  await dialog(p).getByRole("button", { name: "See how everyone is doing" }).click();
  const d = dialog(p);
  await expect(d.getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await nextMail(request, email, "parent_code", before);
  await d.getByLabel("6-digit code").fill("000000");
  await d.getByRole("button", { name: "Unlock" }).click();
  await expect(d.getByRole("alert")).toContainText(/didn't work/);
  await expect(overviewHeading(p)).toHaveCount(0);
  await unlock(p, request, email, before);
  await expect(overviewHeading(p)).toBeVisible();
  await expect(childRow(p, "Aaliyah Best")).toContainText("Owner");
  await expect(childRow(p, "Aaliyah Best")).toContainText("Common Entrance");
  await ctx.close();
});

test("child on parent's login cannot open parent section without code", async ({ browser, page, request }) => {
  const email = uniqueEmail("shared-login");
  await setUpParent(page, request, email, [{ first: "Noah", last: "Reid" }]);
  const { ctx, page: p } = await freshSession(browser, request, email);
  // The child picks themselves and practises on the parent's login.
  await dialog(p).getByRole("button", { name: /Noah Reid/ }).click();
  await expect(accountBtn(p)).toHaveText("NR");
  const direct = await p.evaluate(async () => {
    const r = await window.SumDeTingAccount.api("/parent/overview");
    return { status: r.status, error: r.data?.error };
  });
  expect(direct).toEqual({ status: 403, error: "parent_locked" });
  await accountBtn(p).click();
  await dialog(p).getByRole("button", { name: "See how everyone is doing" }).click();
  await expect(dialog(p).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await dialog(p).getByRole("button", { name: "Cancel" }).click();
  await expect(overviewHeading(p)).toHaveCount(0);
  // Deleting the account is behind the same lock.
  await accountBtn(p).click();
  await dialog(p).getByRole("button", { name: "Delete account" }).click();
  await dialog(p).getByRole("button", { name: "Delete account" }).click();
  await expect(dialog(p).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await dialog(p).getByRole("button", { name: "Cancel" }).click();
  await expect(p.getByText("Your account has been deleted.")).toHaveCount(0);
  await expect(accountBtn(p)).toHaveText("NR");
  await ctx.close();
});

test("overview shows Needs practice / Going well with correct labels", async ({ page, request }) => {
  const email = uniqueEmail("overview");
  await setUpParent(page, request, email, [{ first: "Jaden", last: "Best" }]);
  await dialog(page).getByRole("button", { name: /Jaden Best/ }).click();
  await expect(accountBtn(page)).toHaveText("JB");
  await practise(page, [
    { type: "activity", topic: "Matrices", solved: false },
    { type: "activity", topic: "Matrices", solved: false },
    { type: "activity", topic: "Matrices", solved: false },
    { type: "activity", topic: "Matrices", solved: true },
    { type: "outcome", topic: "Matrices", ok: false, hints: 2, turns: 6 },
    { type: "outcome", topic: "Matrices", ok: false, hints: 1, turns: 5 },
    { type: "activity", topic: "Quadratics", solved: false },
    { type: "activity", topic: "Quadratics", solved: false },
    { type: "activity", topic: "Quadratics", solved: true },
    { type: "activity", topic: "Quadratics", solved: true },
    { type: "outcome", topic: "Quadratics", ok: true, hints: 0, turns: 2 },
    { type: "outcome", topic: "Quadratics", ok: true, hints: 0, turns: 3 },
  ]);
  const before = await mailCount(request, email, "parent_code");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "See how everyone is doing" }).click();
  // Choosing Jaden locked the parent section again (the device may have been handed over).
  await unlock(page, request, email, before);
  await expect(overviewHeading(page)).toBeVisible();
  await childRow(page, "Jaden Best").click();
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "Jaden Best" })).toBeVisible();
  await expect(d.getByText("last practised today")).toBeVisible();
  await expect(d.locator(".acct-stat", { hasText: "day streak" })).toContainText("1");
  await expect(d.locator(".acct-stat", { hasText: "problems solved" })).toContainText("3");
  await expect(d.locator(".acct-stat", { hasText: "topics tried" })).toContainText("2");
  const needs = d.getByRole("region", { name: "Needs practice" });
  const going = d.getByRole("region", { name: "Going well" });
  await expect(needs).toContainText("Matrices");
  await expect(needs).toContainText("Finding it hard");
  await expect(needs).toContainText("1 of 3 solved");
  await expect(needs).toContainText("often needed hints");
  await expect(needs).not.toContainText("Quadratics");
  await expect(going).toContainText("Quadratics");
  await expect(going).toContainText("Confident");
  await expect(going).toContainText("2 of 2 solved");
  await expect(going).not.toContainText("often needed hints");
  for (const name of ["Edit", "Add another parent or guardian", "Who can see this child's progress", "Remove child"]) {
    await expect(d.getByRole("button", { name })).toBeVisible();
  }
  const text = await page.evaluate(() => document.body.innerText);
  expect(text.match(EMOJI)).toBeNull();
  // Back to the list.
  await d.getByRole("button", { name: "All students" }).click();
  await expect(overviewHeading(page)).toBeVisible();
});

test("guardian invite: second email signs in, practises as the child, progress visible to both", async ({ browser, page, request }) => {
  const first = uniqueEmail("mum");
  const second = uniqueEmail("dad");
  await setUpParent(page, request, first, [{ first: "Omar", last: "Gill" }]);
  await openSectionWithCode(page, request, first);
  await childRow(page, "Omar Gill").click();
  await dialog(page).getByRole("button", { name: "Add another parent or guardian" }).click();
  await dialog(page).getByLabel("Email").fill(second);
  await dialog(page).getByRole("button", { name: "Send invite" }).click();
  await expect(dialog(page).getByRole("status")).toContainText(second);
  const invite = await lastMail(request, second, "guardian_invite");

  const other = await browser.newContext();
  const pb = await other.newPage();
  await pb.goto(`/#signin=${tokenOf(invite)}`);
  await expect(dialog(pb).getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await dialog(pb).getByRole("button", { name: /Omar Gill/ }).click();
  await expect(accountBtn(pb)).toHaveText("OG");
  await practise(pb, [
    { type: "activity", topic: "Fractions", solved: false },
    { type: "activity", topic: "Fractions", solved: true },
  ]);
  const before = await mailCount(request, second, "parent_code");
  await accountBtn(pb).click();
  await dialog(pb).getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(pb, request, second, before);
  await expect(childRow(pb, "Omar Gill")).toContainText("Guardian");
  await childRow(pb, "Omar Gill").click();
  await expect(dialog(pb).locator(".acct-stat", { hasText: "problems solved" })).toContainText("1");
  await expect(dialog(pb).getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(dialog(pb).getByRole("button", { name: "Remove child" })).toHaveCount(0);

  // The first parent sees the same progress and the second guardian in the list.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const firstBefore = await mailCount(request, first, "parent_code");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(page, request, first, firstBefore); // closing the section locked it
  await expect(childRow(page, "Omar Gill")).toContainText("Owner");
  await childRow(page, "Omar Gill").click();
  await expect(dialog(page).locator(".acct-stat", { hasText: "problems solved" })).toContainText("1");
  await dialog(page).getByRole("button", { name: "Who can see this child's progress" }).click();
  const people = dialog(page).getByRole("listitem").filter({ hasText: second });
  await expect(people).toContainText("Guardian");
  await expect(people.getByRole("button", { name: /Remove/ })).toBeVisible();

  // The second guardian removes themselves.
  await dialog(pb).getByRole("button", { name: "Stop seeing Omar's progress" }).click();
  const sure = dialog(pb);
  await expect(sure.getByRole("heading", { name: "Stop seeing Omar's progress?" })).toBeVisible();
  await expect(sure).not.toContainText("can't be undone");
  await sure.getByRole("button", { name: "Stop seeing", exact: true }).click();
  await expect(overviewHeading(pb)).toBeVisible();
  await expect(dialog(pb).getByRole("status")).toContainText("You no longer see Omar's progress.");
  await expect(childRow(pb, "Omar Gill")).toHaveCount(0);
  await expect(accountBtn(pb)).not.toHaveText("OG");
  await other.close();
  await dialog(page).getByRole("button", { name: "Back" }).click();
  await dialog(page).getByRole("button", { name: "Who can see this child's progress" }).click();
  await expect(dialog(page).getByText("Only you can see Omar's progress.")).toBeVisible();
});

test("parent requests access to a student account; student allows; child appears as View only", async ({ browser, page, request }) => {
  const parentEmail = uniqueEmail("asker");
  const otherParent = uniqueEmail("other-parent");
  const studentEmail = uniqueEmail("own-account");
  // Another parent account exists, to show the parent-email message.
  const op = await browser.newContext();
  await setUpParent(await op.newPage(), request, otherParent, [{ first: "Mia", last: "Cox" }]);
  await op.close();
  const sc = await browser.newContext();
  const sp = await sc.newPage();
  await signUpStudent(sp, request, studentEmail, { first: "Jaden", last: "Clarke" });
  await expect(accountBtn(sp)).toHaveText("JC");

  await setUpParent(page, request, parentEmail, [{ first: "Ella", last: "Ross" }]);
  await openSectionWithCode(page, request, parentEmail);
  await dialog(page).getByRole("button", { name: "Add a child who has their own account" }).click();
  const d = dialog(page);
  await d.getByLabel("Child's email").fill(otherParent);
  await d.getByRole("button", { name: "Send request" }).click();
  await expect(d.getByRole("alert")).toHaveText("That email is set up as a parent account.");
  await d.getByLabel("Child's email").fill(studentEmail);
  await d.getByRole("button", { name: "Send request" }).click();
  await expect(d.getByRole("status")).toContainText(studentEmail);

  await sp.reload();
  const req = dialog(sp);
  await expect(req.getByRole("heading", { name: `${parentEmail} wants to see your progress` })).toBeVisible();
  await req.getByRole("button", { name: "Allow" }).click();
  await expect(sp.getByText(`${parentEmail} can now see your progress.`)).toBeVisible();
  await sc.close();

  await dialog(page).getByRole("button", { name: "Back" }).click();
  await expect(overviewHeading(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const before = await mailCount(request, parentEmail, "parent_code");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(page, request, parentEmail, before); // closing the section locked it
  await expect(overviewHeading(page)).toBeVisible();
  await expect(childRow(page, "Jaden Clarke")).toContainText("View only");
  await childRow(page, "Jaden Clarke").click();
  await expect(dialog(page).getByRole("heading", { name: "Jaden Clarke" })).toBeVisible();
  await expect(dialog(page).getByText("No practice yet.")).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Remove child" })).toHaveCount(0);
  // A view-only parent can end the link themselves.
  await dialog(page).getByRole("button", { name: "Stop seeing Jaden's progress" }).click();
  await dialog(page).getByRole("button", { name: "Stop seeing", exact: true }).click();
  await expect(dialog(page).getByRole("status")).toContainText("You no longer see Jaden's progress.");
  await expect(childRow(page, "Jaden Clarke")).toHaveCount(0);
});

test("open parent section re-locks when the unlock window ends", async ({ page, request }) => {
  await page.clock.install();
  const email = uniqueEmail("relock");
  await setUpParent(page, request, email, [{ first: "Ivy", last: "Lane" }]);
  await openSectionWithCode(page, request, email);
  await childRow(page, "Ivy Lane").click();
  await dialog(page).getByRole("button", { name: "Remove child" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Remove Ivy Lane?" })).toBeVisible();
  await page.clock.fastForward("16:00");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("The parent section locked.")).toBeVisible();
  await expect(page.getByText("Ivy Lane")).toHaveCount(0);
});

test("parent section closes when a call comes back locked and the unlock is cancelled", async ({ page, request }) => {
  const email = uniqueEmail("locked-call");
  await setUpParent(page, request, email, [{ first: "Remy", last: "Vale" }]);
  await openSectionWithCode(page, request, email);
  await childRow(page, "Remy Vale").click();
  // The server's window ended early (another device, clock skew): it answers parent_locked.
  await page.route("**/api/account/links/list", (route) => route.fulfill({
    status: 403, contentType: "application/json", body: JSON.stringify({ error: "parent_locked" }),
  }));
  await dialog(page).getByRole("button", { name: "Who can see this child's progress" }).click();
  await expect(dialog(page).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("The parent section locked.")).toBeVisible();
});

test("student cannot remove under-13 consent-giver parent (no Remove button)", async ({ browser, page, request }) => {
  const parentEmail = uniqueEmail("consent-giver");
  await signIn(page, request, uniqueEmail("under13"));
  await dialog(page).getByRole("button", { name: /I'm a student/ }).click();
  await fillProfile(dialog(page), { first: "Zoe", last: "Hall", level: "Common Entrance" });
  await dialog(page).getByRole("radio", { name: "No" }).check();
  await dialog(page).getByLabel(/parent's or guardian's email/i).fill(parentEmail);
  await dialog(page).getByRole("button", { name: "Start practising" }).click();
  const mail = await lastMail(request, parentEmail, "consent_request");
  const pc = await browser.newContext();
  const pp = await pc.newPage();
  await pp.goto(`/#signin=${tokenOf(mail)}`);
  await dialog(pp).getByLabel(PARENT_CONSENT).check();
  await dialog(pp).getByRole("button", { name: "Approve" }).click();
  await expect(pp.getByText("You approved Zoe. Their practice progress will be saved.")).toBeVisible();
  await pc.close();

  await page.reload();
  await expect(accountBtn(page)).toHaveText("ZH");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Who can see my progress" }).click();
  const row = dialog(page).getByRole("listitem").filter({ hasText: parentEmail });
  await expect(row).toContainText("View only");
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("delete account behind lock removes everything; signing in again starts setup", async ({ browser, page, request }) => {
  const email = uniqueEmail("delete-me");
  await setUpParent(page, request, email, [{ first: "Ella", last: "Ross" }, { first: "Finn", last: "Ross" }]);
  const { ctx, page: p } = await freshSession(browser, request, email);
  await dialog(p).getByRole("button", { name: /Ella Ross/ }).click();
  await expect(accountBtn(p)).toHaveText("ER");
  await practise(p, [{ type: "activity", topic: "Algebra", solved: true }]);
  const pid = await activePid(p);
  await accountBtn(p).click();
  await dialog(p).getByRole("button", { name: "Delete account" }).click();
  const confirm = dialog(p);
  await expect(confirm.getByRole("heading", { name: "Delete your account?" })).toBeVisible();
  await expect(confirm).toContainText("Ella Ross");
  await expect(confirm).toContainText("Finn Ross");
  const before = await mailCount(request, email, "parent_code");
  await confirm.getByRole("button", { name: "Delete account" }).click();
  await unlock(p, request, email, before);
  await expect(p.getByText("Your account has been deleted.")).toBeVisible();
  await expect(accountBtn(p)).toHaveAttribute("aria-label", /sign in/i);
  const keys = await p.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.includes(pid))).toEqual([]);
  expect(keys).not.toContain("sumdeting.activeProfile");
  const me = await p.evaluate(async () => (await window.SumDeTingAccount.api("/me")).status);
  expect(me).toBe(401);
  await ctx.close();

  // The same email starts over from setup.
  await signIn(page, request, email);
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
});

test("student deletes their account with an emailed code", async ({ page, request }) => {
  const email = uniqueEmail("student-delete");
  await signUpStudent(page, request, email, { first: "Kemar", last: "Lowe" });
  await expect(accountBtn(page)).toHaveText("KL");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Delete account" }).click();
  await expect(dialog(page)).toContainText("Kemar Lowe");
  await dialog(page).getByRole("button", { name: "Delete account" }).click();
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  const mail = await lastMail(request, email, "confirm_delete");
  await d.getByLabel("6-digit code").fill("000000");
  await d.getByRole("button", { name: "Delete account" }).click();
  await expect(d.getByRole("alert")).toContainText(/didn't work/);
  await d.getByLabel("6-digit code").fill(codeOf(mail));
  await d.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByText("Your account has been deleted.")).toBeVisible();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
});

test("privacy notice page is served and linked from the sign-in sheet", async ({ page }) => {
  await page.goto("/privacy.html");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).toContain("Data Protection Act");
  expect(text).not.toContain("DRAFT");
  expect(text).not.toMatch(EMOJI);
  await expect(page.getByRole("link", { name: "Back to SumDeTing" })).toHaveAttribute("href", "/");

  await page.goto("/");
  await accountBtn(page).click();
  await expect(dialog(page).getByRole("link", { name: /How SumDeTing uses your information/ }))
    .toHaveAttribute("href", "/privacy.html");
});

test("anonymous load makes no account requests; signed-in reload restores the profile", async ({ page, request }) => {
  const hits = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/account")) hits.push(r.url()); });
  await page.goto("/");
  await expect(accountBtn(page)).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(hits).toEqual([]);

  const email = uniqueEmail("hint");
  await signUpStudent(page, request, email, { first: "Ria", last: "Best" });
  await expect(accountBtn(page)).toHaveText("RB");
  expect(await page.evaluate(() => localStorage.getItem("sumdeting.signedIn"))).toBe("1");
  await page.reload();
  await expect(accountBtn(page)).toHaveText("RB");

  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: /sign out/i }).click();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
  expect(await page.evaluate(() => localStorage.getItem("sumdeting.signedIn"))).toBeNull();
});

// ---- Final review fixes ----

const serverUnlocked = (page) => page.evaluate(async () => (await window.SumDeTingAccount.api("/me")).data?.parentUnlocked);

test("handing the device to a child after setup locks the parent section (R19)", async ({ page, request }) => {
  const email = uniqueEmail("handover");
  await setUpParent(page, request, email, [{ first: "Noah", last: "Reid" }]);
  // Done already locked it; unlock the session again behind the UI's back, then choose a child.
  const before = await mailCount(request, email, "parent_code");
  await page.evaluate(() => window.SumDeTingAccount.api("/parent/unlock/start"));
  const code = codeOf(await nextMail(request, email, "parent_code", before));
  await page.evaluate((code) => window.SumDeTingAccount.api("/parent/unlock/verify", { code }), code);
  expect(await serverUnlocked(page)).toBe(true);
  await dialog(page).getByRole("button", { name: /Noah Reid/ }).click();
  await expect(accountBtn(page)).toHaveText("NR");
  await expect.poll(() => serverUnlocked(page)).toBe(false);
  const direct = await page.evaluate(async () => (await window.SumDeTingAccount.api("/parent/overview")).data?.error);
  expect(direct).toBe("parent_locked");
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "See how everyone is doing" }).click();
  await expect(dialog(page).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(overviewHeading(page)).toHaveCount(0);
  // Delete account is behind the same lock.
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Delete account" }).click();
  await dialog(page).getByRole("button", { name: "Delete account" }).click();
  await expect(dialog(page).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(accountBtn(page)).toHaveText("NR");
});

test("Done on the parent setup form locks the section before the picker shows", async ({ page, request }) => {
  const email = uniqueEmail("done-lock");
  await signIn(page, request, email);
  await dialog(page).getByRole("button", { name: /I'm a parent or guardian/ }).click();
  const d = dialog(page);
  await fillProfile(d, { first: "Mae", last: "Hart" });
  await d.getByLabel(PARENT_CONSENT).check();
  await d.getByRole("button", { name: "Done, start practising" }).click();
  const picker = dialog(page);
  await expect(picker.getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  expect(await serverUnlocked(page)).toBe(false);
  // Without choosing a child, the parent section already needs a code.
  await picker.getByRole("button", { name: "See how everyone is doing" }).click();
  await expect(dialog(page).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(overviewHeading(page)).toHaveCount(0);
  // "Add a student" is behind the same lock.
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Add a student" }).click();
  await expect(dialog(page).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
});

test("closing the parent setup form without Done also locks the section", async ({ page, request }) => {
  await signIn(page, request, uniqueEmail("close-form"));
  await dialog(page).getByRole("button", { name: /I'm a parent or guardian/ }).click();
  await expect(dialog(page).getByRole("heading", { name: "Add your child" })).toBeVisible();
  expect(await serverUnlocked(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => serverUnlocked(page)).toBe(false);
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "See how everyone is doing" }).click();
  await expect(dialog(page).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
});

test("closing the parent section locks it; reopening asks for a code", async ({ browser, page, request }) => {
  const email = uniqueEmail("close-lock");
  await setUpParent(page, request, email, [{ first: "Ada", last: "Moss" }]);
  const { ctx, page: p } = await freshSession(browser, request, email);
  const before = await mailCount(request, email, "parent_code");
  await dialog(p).getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(p, request, email, before);
  await expect(overviewHeading(p)).toBeVisible();
  await dialog(p).getByRole("button", { name: "Close" }).click();
  await expect(p.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => serverUnlocked(p)).toBe(false);
  await accountBtn(p).click();
  await dialog(p).getByRole("button", { name: "See how everyone is doing" }).click();
  await expect(dialog(p).getByRole("heading", { name: "We've emailed you a code" })).toBeVisible();
  await ctx.close();
});

test("leaving the page locks the parent section", async ({ page, request }) => {
  const email = uniqueEmail("pagehide");
  await setUpParent(page, request, email, [{ first: "Eli", last: "Ward" }]);
  await openSectionWithCode(page, request, email); // leave with the section open
  expect(await serverUnlocked(page)).toBe(true);
  const locked = page.waitForRequest((r) => r.url().endsWith("/api/account/parent/lock"));
  await page.goto("about:blank");
  await locked;
  await page.goto("/");
  await expect(dialog(page).getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await expect.poll(() => serverUnlocked(page)).toBe(false);
});

test("a parent whose only child has their own account can finish setup and ask to see it", async ({ browser, page, request }) => {
  const parentEmail = uniqueEmail("no-own-child");
  const studentEmail = uniqueEmail("own-kid");
  const sc = await browser.newContext();
  const sp = await sc.newPage();
  await signUpStudent(sp, request, studentEmail, { first: "Jaden", last: "Clarke" });
  await expect(accountBtn(sp)).toHaveText("JC");

  await signIn(page, request, parentEmail);
  await dialog(page).getByRole("button", { name: /I'm a parent or guardian/ }).click();
  await expect(dialog(page).getByRole("heading", { name: "Add your child" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "My child already has their own account" }).click();
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "Add a child who has their own account" })).toBeVisible();
  await d.getByLabel("Child's email").fill(studentEmail);
  await d.getByRole("button", { name: "Send request" }).click();
  await expect(d.getByRole("status")).toContainText(studentEmail);

  await sp.reload();
  await dialog(sp).getByRole("button", { name: "Allow" }).click();
  await expect(sp.getByText(`${parentEmail} can now see your progress.`)).toBeVisible();
  await sc.close();

  // Setup counts as finished: a reload lands on the picker, not the "Add your child" form.
  await page.reload();
  const picker = dialog(page);
  await expect(picker.getByRole("heading", { name: "Who's practising?" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Add a student" })).toBeVisible();
  const before = await mailCount(request, parentEmail, "parent_code");
  await picker.getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(page, request, parentEmail, before);
  await expect(childRow(page, "Jaden Clarke")).toContainText("View only");
});

test("a sign-in link opened while signed in asks first; Cancel keeps the current account", async ({ page, request }) => {
  await signUpStudent(page, request, uniqueEmail("current"), { first: "Kira", last: "Bell" });
  await expect(accountBtn(page)).toHaveText("KB");
  const other = uniqueEmail("other");
  const start = await request.post("/api/account/signin/start", { data: { email: other } });
  expect(start.ok()).toBeTruthy();
  const mail = await lastMail(request, other, "signin");
  const verifies = [];
  page.on("request", (r) => { if (r.url().endsWith("/signin/verify")) verifies.push(r.url()); });
  // A fresh page load (the link opened in a new tab), so /me hasn't been asked yet.
  await page.goto("about:blank");
  await page.goto(`/#signin=${tokenOf(mail)}`);
  const ask = dialog(page);
  await expect(ask.getByRole("heading", { name: "A sign-in link was opened" })).toBeVisible();
  await expect(ask).toContainText("Sign out of the current account and use the link?");
  expect(new URL(page.url()).hash).toBe("");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(accountBtn(page)).toHaveText("KB");
  expect(verifies).toEqual([]);
  expect(await page.evaluate(async () => (await window.SumDeTingAccount.api("/me")).data?.account?.email)).not.toBe(other);
});

test("a sign-in link opened while signed in switches accounts on Continue", async ({ page, request }) => {
  await signUpStudent(page, request, uniqueEmail("switch-from"), { first: "Kira", last: "Bell" });
  await expect(accountBtn(page)).toHaveText("KB");
  const other = uniqueEmail("switch-to");
  await request.post("/api/account/signin/start", { data: { email: other } });
  const mail = await lastMail(request, other, "signin");
  // Same tab, fragment change only: the hashchange path.
  await page.goto(`/#signin=${tokenOf(mail)}`);
  await dialog(page).getByRole("button", { name: "Continue" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Who's setting this up?" })).toBeVisible();
});

test("signing out with unsaved practice asks first", async ({ page, request }) => {
  await signUpStudent(page, request, uniqueEmail("unsaved"), { first: "Lou", last: "Gray" });
  await expect(accountBtn(page)).toHaveText("LG");
  const pid = await activePid(page);
  await page.route("**/api/account/progress/sync", (route) => route.abort());
  await page.evaluate((d) => window.dispatchEvent(new CustomEvent("sumdeting:progress", {
    detail: { id: crypto.randomUUID(), type: "activity", topic: "Algebra", solved: true, d },
  })), today());
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Sign out" }).click();
  const ask = dialog(page);
  await expect(ask.getByText("Some practice hasn't been saved to your account yet. Sign out anyway?")).toBeVisible();
  await ask.getByRole("button", { name: "Stay" }).click();
  await expect(accountBtn(page)).toHaveText("LG");
  expect(await page.evaluate((pid) => JSON.parse(localStorage.getItem(`sumdeting.queue.${pid}`) ?? "[]").length, pid)).toBe(1);
  await accountBtn(page).click();
  await dialog(page).getByRole("button", { name: "Sign out" }).click();
  await dialog(page).getByRole("button", { name: "Sign out" }).click();
  await expect(accountBtn(page)).toHaveAttribute("aria-label", /sign in/i);
});

test("the approving parent withdraws an under-13 child's approval; the child disappears", async ({ browser, page, request }) => {
  const parentEmail = uniqueEmail("withdraw");
  await signIn(page, request, uniqueEmail("withdraw-kid"));
  await dialog(page).getByRole("button", { name: /I'm a student/ }).click();
  await fillProfile(dialog(page), { first: "Tia", last: "Rowe", level: "Common Entrance" });
  await dialog(page).getByRole("radio", { name: "No" }).check();
  await dialog(page).getByLabel(/parent's or guardian's email/i).fill(parentEmail);
  await dialog(page).getByRole("button", { name: "Start practising" }).click();
  const mail = await lastMail(request, parentEmail, "consent_request");
  const pc = await browser.newContext();
  const pp = await pc.newPage();
  await pp.goto(`/#signin=${tokenOf(mail)}`);
  await dialog(pp).getByLabel(PARENT_CONSENT).check();
  await dialog(pp).getByRole("button", { name: "Approve" }).click();
  await expect(pp.getByText("You approved Tia. Their practice progress will be saved.")).toBeVisible();
  const before = await mailCount(request, parentEmail, "parent_code");
  await dialog(pp).getByRole("button", { name: "See how everyone is doing" }).click();
  await unlock(pp, request, parentEmail, before);
  await childRow(pp, "Tia Rowe").click();
  await dialog(pp).getByRole("button", { name: "Withdraw approval and delete Tia's data" }).click();
  const sure = dialog(pp);
  await expect(sure.getByRole("heading", { name: "Withdraw approval for Tia Rowe?" })).toBeVisible();
  await expect(sure).toContainText("can keep practising on their device");
  await expect(sure).toContainText("can't be undone");
  await sure.getByRole("button", { name: "Withdraw approval" }).click();
  await expect(overviewHeading(pp)).toBeVisible();
  await expect(dialog(pp).getByRole("status")).toContainText("Approval withdrawn. Tia's data has been deleted.");
  await expect(childRow(pp, "Tia Rowe")).toHaveCount(0);
  await pc.close();
});
