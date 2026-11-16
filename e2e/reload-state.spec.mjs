// A reload mid-practice keeps the practice (issue #71): the 24h conversation
// snapshot also carries the heading, the current topic and the active problem
// (with its hint and turn counts), so the heading stays and a correct answer
// after the reload still earns that topic's bead. Old-format and expired
// snapshots load as plain "Tutor"; New session clears it all. The tutor is stubbed.
import { test, expect } from "@playwright/test";

const SESSION = "mathmentor.session.v1";
const MASTERY = "mathmentor.mastery.v1";
const PROBLEM = "Here is a problem for you: solve 2x + 3 = 11.";
const HINT = "Hint: what could you subtract from both sides first?";
const CORRECT = "✅ Correct, x = 4. Nicely done.";

/** Practice requests get a problem, hint requests a hint, and any other answer is marked correct. */
async function stubTutor(page) {
  await page.route("**/api/chat", (route) => {
    const asked = JSON.stringify(route.request().postDataJSON().messages.at(-1));
    const reply = asked.includes("practice problem on") ? PROBLEM : asked.includes("small hint") ? HINT : CORRECT;
    route.fulfill({ json: { reply } });
  });
}

const title = (page) => page.locator("#view-chat .chat-top h2");
const lastTutor = (page) => page.locator("#chat .msg.tutor:not(.notice)").last();
const algebra = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}").topics?.Algebra ?? null, MASTERY);
const snapshot = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), SESSION);

async function startAlgebra(page) {
  await page.goto("/");
  await page.locator('#topic-list .trow-home[data-topic="Algebra"]').click();
  await expect(lastTutor(page)).toHaveText(PROBLEM);
  await expect(title(page)).toHaveText("Algebra · CSEC");
}

async function answer(page, text) {
  await page.locator("#input").fill(text);
  await page.locator("#input").press("Enter"); // as chips.spec.mjs does
}

/** A snapshot from before #71: only a timestamp and the messages. */
async function seedSnapshot(page, snap) {
  await page.addInitScript(([k, s]) => {
    if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, JSON.stringify(s)); sessionStorage.setItem("seeded", "1"); }
  }, [SESSION, snap]);
}
const oldMessages = [
  { role: "user", content: "Practice please: CSEC, Algebra" },
  { role: "assistant", content: PROBLEM },
];

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("the heading survives a reload mid-practice", async ({ page }) => {
      await stubTutor(page);
      await startAlgebra(page);
      await page.reload();
      await expect(lastTutor(page)).toHaveText(PROBLEM);
      await expect(title(page)).toHaveText("Algebra · CSEC");
    });

    test("a correct answer after a reload earns that topic's bead, with its hints", async ({ page }) => {
      await stubTutor(page);
      await startAlgebra(page);
      expect(await algebra(page)).toEqual({ attempted: 1, solved: 0 });
      await page.locator("#chips").getByRole("button", { name: "Give me a hint" }).click();
      await expect(lastTutor(page)).toHaveText(HINT);
      await page.reload();
      await expect(title(page)).toHaveText("Algebra · CSEC");

      await answer(page, "x = 4");
      await expect(lastTutor(page)).toHaveText(CORRECT);
      const t = await algebra(page);
      expect(t.solved).toBe(1);
      // The problem's outcome keeps the hint and both turns from before and after the reload.
      expect(t.hist.map(({ ok, hints, turns }) => ({ ok, hints, turns }))).toEqual([{ ok: 1, hints: 1, turns: 2 }]);

      // Solved closes the problem: another reload doesn't reopen it for a second outcome.
      await page.reload();
      await answer(page, "x = 4 again");
      await expect(lastTutor(page)).toHaveText(CORRECT);
      expect((await algebra(page)).hist).toHaveLength(1);
    });

    test("an old-format snapshot loads as Tutor with no active problem", async ({ page }) => {
      await stubTutor(page);
      await seedSnapshot(page, { t: Date.now(), messages: oldMessages });
      await page.goto("/");
      await expect(lastTutor(page)).toHaveText(PROBLEM);
      await expect(title(page)).toHaveText("Tutor");
      await answer(page, "x = 4");
      await expect(lastTutor(page)).toHaveText(CORRECT);
      expect(await algebra(page)).toBeNull();
    });

    test("an expired snapshot gives a fresh Tutor state", async ({ page }) => {
      await stubTutor(page);
      await seedSnapshot(page, {
        t: Date.now() - 25 * 60 * 60 * 1000,
        messages: oldMessages,
        practice: { title: "Algebra · CSEC", topic: "Algebra", problem: { topic: "Algebra", level: "CSEC", userTurns: 0, hints: 0 } },
      });
      await page.goto("/");
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText("Tutor");
      await expect(page.locator("#chat .msg")).toHaveCount(1); // just the greeting
      await answer(page, "x = 4");
      await expect(lastTutor(page)).toHaveText(CORRECT);
      expect(await algebra(page)).toBeNull();
    });

    test("New session after a reload clears the heading and the active problem", async ({ page }) => {
      await stubTutor(page);
      page.on("dialog", (d) => d.accept()); // "Start a fresh session?"
      await startAlgebra(page);
      await page.reload();
      await expect(title(page)).toHaveText("Algebra · CSEC");

      await page.locator("#menu-btn").click();
      await page.locator("#new-session").click();
      expect(await snapshot(page)).toBeNull();
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText("Tutor");
      await answer(page, "x = 4");
      await expect(lastTutor(page)).toHaveText(CORRECT);
      expect((await algebra(page)).solved).toBe(0);
    });

    test("a practice reply that lands after New session doesn't save its problem", async ({ page }) => {
      let release;
      const held = new Promise((r) => { release = r; });
      await page.route("**/api/chat", async (route) => {
        await held;
        route.fulfill({ json: { reply: PROBLEM } });
      });
      page.on("dialog", (d) => d.accept());
      await page.goto("/");
      await page.locator('#topic-list .trow-home[data-topic="Algebra"]').click();
      await page.locator("#menu-btn").click();
      await page.locator("#new-session").click();
      release();
      // New session removed the waiting bubble, so watch the snapshot for the late reply instead.
      await expect.poll(async () => (await snapshot(page))?.messages?.at(-1)?.content).toBe(PROBLEM);
      expect((await snapshot(page))?.practice?.problem ?? null).toBeNull();
      await page.reload();
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText("Tutor");
    });
  });
}
