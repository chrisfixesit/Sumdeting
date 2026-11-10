// Automated WCAG 2.2 AA gate for the home page and the chat composer
// (pad and + menu open), across four viewports and both themes.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const MASTERY = "mathmentor.mastery.v1";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1440, height: 900 },
];
const today = () => new Date().toISOString().slice(0, 10);

async function seed(page, theme) {
  const d = today();
  await page.addInitScript(([key, day, th]) => {
    localStorage.setItem("sumdeting.theme", th);
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 3, attempted: 4 }, "Statistics & Probability": { solved: 4, attempted: 4 } },
      streak: { count: 4, last: day },
      days: { [day]: 12 },
    }));
  }, [MASTERY, d, theme]);
}

const scan = async (page) =>
  (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations;

for (const viewport of VIEWPORTS) {
  for (const theme of ["light", "dark"]) {
    test.describe(`${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport });

      test("home has no axe violations", async ({ page }) => {
        await seed(page, theme);
        await page.goto("/");
        await expect(page.locator("#topic-list .beads i.on").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        // Wait for the bead fill to finish so axe reads settled colours.
        await expect.poll(() => page.evaluate(() =>
          [...document.querySelectorAll("#topic-list .beads i.on")]
            .reduce((n, el) => n + el.getAnimations().filter((a) => a.playState === "running" || a.pending).length, 0))).toBe(0);
        expect(await scan(page)).toEqual([]);
      });

      test("chat with pad and + menu open has no axe violations", async ({ page }) => {
        await seed(page, theme);
        await page.goto("/");
        await page.locator("#nav-chat").click();
        await page.locator("#pad-toggle").click();
        await page.locator("#attach-btn").click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("#pad-toggle")).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#mathpad")).toBeVisible();
        await expect(page.locator("#attach-btn")).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#attach-menu")).toBeVisible();
        expect(await scan(page)).toEqual([]);
      });
    });
  }
}

const animName = (bead) => bead.evaluate((el) => getComputedStyle(el).animationName);

test.describe("reduced motion", () => {
  test.use({ viewport: VIEWPORTS[0], contextOptions: { reducedMotion: "reduce" } });
  test("earned beads do not animate", async ({ page }) => {
    await seed(page, "light");
    await page.goto("/");
    const bead = page.locator("#topic-list .beads i.on").first();
    await expect(bead).toBeVisible();
    expect(await animName(bead)).toBe("none");
  });
});

test("the CSS switches the fill off even when a bead carries .anim", async ({ page }) => {
  await seed(page, "light");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const bead = page.locator("#topic-list .beads i.on.anim").first();
  await expect(bead).toBeVisible();
  expect(await animName(bead)).toBe("bead-fill");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animName(bead)).toBe("none");
});
