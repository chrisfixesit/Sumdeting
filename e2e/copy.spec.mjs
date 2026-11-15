// Copy checks: nothing may point at a camera button (photo, drawing and voice
// live in the + menu), and the welcome message must point to +.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sumdeting.theme", "light"));
});

test("welcome message points to the + menu, not a camera button", async ({ page }) => {
  await page.goto("/");
  await page.locator("#nav-chat").click();
  const text = await page.locator("#chat .msg.tutor").first().innerText();
  expect(text).not.toMatch(/camera button/i);
  expect(text).toContain("tap +");
});

test("papers card and sheet tip do not mention a camera button", async ({ page }) => {
  await page.goto("/");
  await page.locator("#nav-practice").click();
  await expect(page.locator(".papers-card")).toBeVisible();
  expect(await page.locator(".papers-card").innerText()).not.toMatch(/camera button/i);
  await page.locator("#papers-open").click();
  await expect(page.locator(".sheet-tip")).toBeVisible();
  expect(await page.locator(".sheet-tip").innerText()).not.toMatch(/camera button/i);
});

test("about page does not mention a camera button", async ({ page }) => {
  await page.goto("/about.html");
  expect(await page.locator("body").innerText()).not.toMatch(/camera button/i);
});
