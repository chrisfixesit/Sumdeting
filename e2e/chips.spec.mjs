// The tutor's quick-reply chips: one row of short labels on a phone, full
// labels on wider screens, the full label as each accessible name. Issue #64.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FULL = ["Give me a hint", "Show a similar example", "Explain it simpler"];
const SHORT = ["Hint", "Similar example", "Simpler"];

/** Ask the (stubbed) tutor something so its reply brings up the chips. */
async function showChips(page, theme = "light") {
  await page.addInitScript((th) => localStorage.setItem("sumdeting.theme", th), theme);
  await page.route("**/api/chat", (route) => route.fulfill({ json: { reply: "What do you notice first?" } }));
  await page.goto("/");
  await page.locator("#nav-chat").click();
  await page.locator("#input").fill("Solve 2x + 3 = 11");
  await page.locator("#input").press("Enter");
  await expect(page.locator("#chat .msg.tutor").last()).toContainText("What do you notice first?");
  await expect(page.locator("#chips")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  return page.locator("#chips button");
}

test.describe("390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the three chips sit on one row, each at least 44px tall, with no page scroll", async ({ page }) => {
    const chips = await showChips(page);
    await expect(chips).toHaveCount(3);
    const boxes = await chips.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    for (const b of boxes) {
      expect(b.top).toBeCloseTo(boxes[0].top, 0);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    expect(await chips.evaluateAll((els) => els.map((el) => el.innerText.trim()))).toEqual(SHORT);
    const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth }));
    expect(scroll).toBeLessThanOrEqual(inner);
  });
});

test.describe("1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the full labels show", async ({ page }) => {
    const chips = await showChips(page);
    expect(await chips.evaluateAll((els) => els.map((el) => el.innerText.trim()))).toEqual(FULL);
  });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}x${viewport.height} names`, () => {
    test.use({ viewport });

    test("each chip's accessible name is its full label", async ({ page }) => {
      await showChips(page);
      for (const name of FULL) await expect(page.locator("#chips").getByRole("button", { name, exact: true })).toBeVisible();
    });
  });
}

for (const theme of ["light", "dark"]) {
  test.describe(`390x844 ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("chat with the chips showing has no axe violations", async ({ page }) => {
      await showChips(page, theme);
      expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);
    });
  });
}
