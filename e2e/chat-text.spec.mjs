// Tutor chat text is body size (16 px), and long display maths still fits a
// small phone by scrolling inside its own box. Issue #48.
import { test, expect } from "@playwright/test";

const SESSION = "mathmentor.session.v1";
const LONG_FORMULA = "\\[" + Array.from({ length: 14 }, (_, i) => `\\frac{${i + 1}x^2}{${i + 2}}`).join(" + ") + " = 0\\]";

/** A saved session: restoring it draws a user bubble, a KaTeX tutor bubble and the "Continuing" notice. */
async function seedSession(page, tutorText) {
  await page.addInitScript(([key, reply]) => {
    localStorage.setItem(key, JSON.stringify({
      t: Date.now(),
      messages: [
        { role: "user", content: "Solve x^2 + 10x + 40 = 0" },
        { role: "assistant", content: reply },
      ],
    }));
  }, [SESSION, tutorText]);
}

const fontPx = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("tutor, user and notice bubbles are at least 16px", async ({ page }) => {
      await seedSession(page, "What do you notice about \\(b^2 - 4ac\\)?");
      await page.goto("/");
      const tutor = page.locator("#chat .msg.tutor.rich").last();
      const user = page.locator("#chat .msg.user").last();
      const notice = page.locator("#chat .msg.notice").last();
      await expect(tutor.locator(".katex").first()).toBeVisible();
      await expect(user).toBeVisible();
      await expect(notice).toBeVisible();
      expect(await fontPx(tutor)).toBeGreaterThanOrEqual(16);
      expect(await fontPx(user)).toBeGreaterThanOrEqual(16);
      expect(await fontPx(notice)).toBeGreaterThanOrEqual(16);
    });
  });
}

test.describe("320x640", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("a long display formula scrolls inside its box, not the page", async ({ page }) => {
    await seedSession(page, `Look at this:\n\n${LONG_FORMULA}`);
    await page.goto("/");
    const display = page.locator("#chat .msg.tutor.rich .katex-display").last();
    await expect(display).toBeVisible();
    // The formula really is wider than its box, so this checks something.
    const { scroll, client } = await display.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(scroll).toBeGreaterThan(client);
    expect(await display.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth }));
    expect(page_.scroll).toBeLessThanOrEqual(page_.inner);
  });
});
