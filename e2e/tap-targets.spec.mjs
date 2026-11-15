// Tap-target size gate (#47): the papers sheet Close button and the header
// menu button must be at least 44x44 px, at phone and desktop widths.
import { test, expect } from "@playwright/test";

const MIN = 44;
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height, mid: r.top + r.height / 2 };
});

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("papers sheet Close is at least 44x44", async ({ page }) => {
      await page.goto("/");
      await page.locator("#nav-practice").click();
      await page.locator("#papers-open").click();
      const close = page.locator("#papers-close");
      await expect(close).toBeVisible();
      const { width, height } = await box(close);
      expect(width).toBeGreaterThanOrEqual(MIN);
      expect(height).toBeGreaterThanOrEqual(MIN);
    });

    test("header menu button is at least 44x44 and lines up with the account button", async ({ page }) => {
      await page.goto("/");
      const menu = page.locator("#menu-btn");
      const account = page.locator("#account-slot button");
      await expect(menu).toBeVisible();
      await expect(account).toBeVisible();
      const m = await box(menu);
      const a = await box(account);
      expect(m.width).toBeGreaterThanOrEqual(MIN);
      expect(m.height).toBeGreaterThanOrEqual(MIN);
      expect(Math.abs(m.mid - a.mid)).toBeLessThanOrEqual(1);
    });
  });
}
