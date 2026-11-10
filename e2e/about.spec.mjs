// The "About SumDeTing" page: reachable from the menu and the home footer,
// follows the saved theme, and meets WCAG 2.2 AA in both themes.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("menu links to the how-to page", async ({ page }) => {
  await page.goto("/");
  await page.locator("#menu-btn").click();
  await page.locator("#menu").getByRole("link", { name: "About SumDeTing" }).click();
  await expect(page).toHaveURL(/\/about\.html$/);
  await expect(page.locator("h1")).toHaveText("How SumDeTing works");
  await page.getByRole("link", { name: "Back to SumDeTing" }).click();
  await expect(page.locator("#home-h")).toBeVisible();
});

test("home footer links to the how-to page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".home-foot a[href='/about.html']")).toHaveText("About SumDeTing");
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  for (const theme of ["light", "dark"]) {
    test(`about page has no axe violations at ${viewport.width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((th) => localStorage.setItem("sumdeting.theme", th), theme);
      await page.goto("/about.html");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Open every question so their answers are checked too.
      for (const d of await page.locator("details").all()) await d.locator("summary").click();
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
      // No sideways scrolling on a phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
