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
  await expect(pageB.locator(".trow", { hasText: "Trigonometry" })).toContainText("in progress");
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
