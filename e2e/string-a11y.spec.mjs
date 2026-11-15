// The String page status labels must meet WCAG AA contrast (issue #44):
// the gold "In progress" label failed 4.5:1 on the card in the light theme.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const MASTERY = "mathmentor.mastery.v1";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];
const today = () => new Date().toISOString().slice(0, 10);

async function seed(page, theme) {
  const d = today();
  await page.addInitScript(([key, day, th]) => {
    localStorage.setItem("sumdeting.theme", th);
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 2, attempted: 4 } },
      streak: { count: 1, last: day },
      days: { [day]: 2 },
    }));
  }, [MASTERY, d, theme]);
}

// WCAG 2.x relative luminance and contrast ratio.
const parseRgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const viewport of VIEWPORTS) {
  for (const theme of ["light", "dark"]) {
    test.describe(`String ${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport });

      async function openString(page) {
        await seed(page, theme);
        await page.goto("/");
        await page.locator("#nav-string").click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("#string-topics .trow .s-mid", { hasText: "Attempted" })).toBeVisible();
      }

      test("string page has no axe violations", async ({ page }) => {
        await openString(page);
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(violations).toEqual([]);
      });

      test("in-progress status label (.s-mid) has at least 4.5:1 contrast on its row", async ({ page }) => {
        await openString(page);
        const { fg, bg } = await page.locator("#string-topics .trow .s-mid").first().evaluate((el) => ({
          fg: getComputedStyle(el).color,
          bg: getComputedStyle(el.closest(".trow")).backgroundColor,
        }));
        expect(contrast(parseRgb(fg), parseRgb(bg))).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
}
