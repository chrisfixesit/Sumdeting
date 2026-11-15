// The Tutor view's header (issue #53): no second logo or "SumDeTing" title under
// the app header. It shows what the student is working on: a plain "Tutor"
// heading with the one-line promise, or the topic and level while practising,
// however the practice was started. The tutor (POST /api/chat) is stubbed.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PROMISE = "Socratic tutor · I never hand the answer over";

/** Stub the tutor and collect the text of each student message sent. */
async function stubTutor(page) {
  const sent = [];
  await page.route("**/api/chat", async (route) => {
    const { messages } = route.request().postDataJSON();
    const last = messages.at(-1);
    const text = typeof last.content === "string"
      ? last.content
      : last.content.filter((c) => c.text).map((c) => c.text).join(" ");
    sent.push(text);
    await route.fulfill({ json: { reply: "Here is a problem for you." } });
  });
  return sent;
}

const header = (page) => page.locator("#view-chat .chat-top");
const title = (page) => header(page).getByRole("heading", { level: 2 });

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("the chat header shows no logo and no SumDeTing title", async ({ page }) => {
      await page.goto("/");
      await page.locator("#nav-chat").click();
      await expect(header(page)).toBeVisible();
      await expect(header(page).locator("img")).toHaveCount(0);
      await expect(header(page)).not.toContainText("SumDeTing");
    });

    test("with no practice running, the heading reads Tutor above the promise", async ({ page }) => {
      await page.goto("/");
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText("Tutor");
      await expect(header(page)).toContainText(PROMISE);
    });

    test("a topic row puts its topic and level in the heading", async ({ page }) => {
      await stubTutor(page);
      await page.goto("/");
      await page.locator('#topic-list .trow-home[data-topic="Algebra"]').click();
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText("Algebra · CSEC");
      await expect(header(page)).toContainText(PROMISE);
    });

    test("Give me a problem puts the chosen topic and level in the heading", async ({ page }) => {
      const sent = await stubTutor(page);
      await page.goto("/");
      await page.locator("#practice-btn").click();
      await expect.poll(() => sent.length).toBe(1);
      const topic = sent[0].match(/practice problem on (.+?)\. Wait/)[1];
      // The heading uses the app's short name for the topic, e.g. "Ratios" for "Ratio & Proportion".
      const short = await page.evaluate((t) => TOPIC_SHORT[t] || t, topic);
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText(`${short} · CSEC`);
    });

    test("a practice request that fails leaves the heading as it was", async ({ page }) => {
      let fail = true;
      await page.route("**/api/chat", (route) => (fail
        ? route.fulfill({ status: 500, json: { error: "Tutor unavailable" } })
        : route.fulfill({ json: { reply: "Here is a problem for you." } })));
      await page.goto("/");

      // Nothing running yet: a failed start goes back to "Tutor".
      await page.locator('#topic-list .trow-home[data-topic="Algebra"]').click();
      await expect(page.locator("#chat .msg.error")).toHaveCount(1);
      await expect(title(page)).toHaveText("Tutor");

      // Practising Algebra: a failed start on another topic keeps "Algebra · CSEC".
      fail = false;
      await page.locator("#nav-home").click();
      await page.locator('#topic-list .trow-home[data-topic="Algebra"]').click();
      await expect(title(page)).toHaveText("Algebra · CSEC");
      fail = true;
      await page.locator("#nav-home").click();
      await page.locator('#topic-list .trow-home[data-topic="Trigonometry"]').click();
      await expect(page.locator("#chat .msg.error")).toHaveCount(2);
      await expect(title(page)).toHaveText("Algebra · CSEC");
    });

    test("New session puts the heading back to Tutor", async ({ page }) => {
      await stubTutor(page);
      page.on("dialog", (d) => d.accept()); // "Start a fresh session?"
      await page.goto("/");
      await page.locator('#topic-list .trow-home[data-topic="Algebra"]').click();
      await expect(title(page)).toHaveText("Algebra · CSEC");

      await page.locator("#menu-btn").click();
      await page.locator("#new-session").click();
      await page.locator("#nav-chat").click();
      await expect(title(page)).toHaveText("Tutor");
    });

    for (const theme of ["light", "dark"]) {
      test(`the Tutor view has no axe violations in ${theme}`, async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem("sumdeting.theme", t), theme);
        await page.goto("/");
        await page.locator("#nav-chat").click();
        await expect(title(page)).toBeVisible();
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
      });
    }
  });
}
