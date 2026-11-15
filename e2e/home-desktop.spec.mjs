// Desktop home layout (#54): at 1024px and wider, the hero column and the
// "Practise a topic" column start on the same line. Phone and tablet layouts
// keep their existing hero alignment.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const MASTERY = "mathmentor.mastery.v1";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const today = () => new Date().toISOString().slice(0, 10);

async function seed(page, theme = "light") {
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

const measure = (page) => page.evaluate(() => ({
  alignSelf: getComputedStyle(document.querySelector(".ask")).alignSelf,
  h1Top: Math.round(document.querySelector(".ask h1").getBoundingClientRect().top),
  h2Top: Math.round(document.querySelector(".practise-sec h2").getBoundingClientRect().top),
}));

async function open(page, theme) {
  await seed(page, theme);
  await page.goto("/");
  await expect(page.locator("#topic-list .beads i.on").first()).toBeVisible();
}

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test("hero h1 starts level with Practise a topic h2", async ({ page }) => {
      await open(page);
      const m = await measure(page);
      expect(Math.abs(m.h1Top - m.h2Top), JSON.stringify(m)).toBeLessThanOrEqual(24);
    });
  });
}

// Guard: under 1024px the layout is unchanged (values recorded from main).
const GUARD = [
  { width: 390, height: 844, alignSelf: "auto", h1Top: 102 },
  { width: 820, height: 1180, alignSelf: "auto", h1Top: 115 },
];
for (const g of GUARD) {
  test.describe(`${g.width}x${g.height} unchanged`, () => {
    test.use({ viewport: { width: g.width, height: g.height } });
    test("hero alignment unchanged below 1024px", async ({ page }) => {
      await open(page);
      const m = await measure(page);
      expect(m.alignSelf, JSON.stringify(m)).toBe(g.alignSelf);
      expect(m.h1Top, JSON.stringify(m)).toBe(g.h1Top);
    });
  });
}

for (const theme of ["light", "dark"]) {
  test.describe(`1440x900 ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test("desktop home has no axe violations", async ({ page }) => {
      await open(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect.poll(() => page.evaluate(() =>
        [...document.querySelectorAll("#topic-list .beads i.on")]
          .reduce((n, el) => n + el.getAnimations().filter((a) => a.playState === "running" || a.pending).length, 0))).toBe(0);
      expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);
    });
  });
}
