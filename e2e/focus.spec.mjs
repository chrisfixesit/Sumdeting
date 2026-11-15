// Keyboard and screen reader handling for the dialogs, the header menu and the
// nav (issue #46): focus moves into what opens, Escape closes it, focus goes back
// to the button that opened it, and the active tab is announced.
import { test, expect } from "@playwright/test";

const focusedId = (page) => page.evaluate(() => document.activeElement?.id ?? "");
const focusInside = (page, sel) => page.evaluate((s) => document.querySelector(s).contains(document.activeElement), sel);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sumdeting.theme", "light"));
  await page.goto("/");
});

test("papers sheet takes focus, closes on Escape and returns focus to its button", async ({ page }) => {
  await page.locator("#nav-practice").click();
  await page.locator("#papers-open").click();
  await expect(page.locator("#papers-sheet")).toBeVisible();
  expect(await focusInside(page, "#papers-sheet")).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#papers-sheet")).toBeHidden();
  expect(await focusedId(page)).toBe("papers-open");
});

test("sketch dialog takes focus, closes on Escape and returns focus to the + button", async ({ page }) => {
  await page.locator("#nav-chat").click();
  await page.locator("#attach-btn").click();
  await page.locator("#sketch").click();
  await expect(page.locator("#sketch-modal")).toBeVisible();
  expect(await focusInside(page, "#sketch-modal")).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#sketch-modal")).toBeHidden();
  expect(await focusedId(page)).toBe("attach-btn");
});

test("header menu sets aria-expanded, takes focus, closes on Escape and returns focus", async ({ page }) => {
  const btn = page.locator("#menu-btn");
  await expect(btn).toHaveAttribute("aria-expanded", "false");

  await btn.click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  expect(await focusInside(page, "#menu")).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#menu")).toBeHidden();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  expect(await focusedId(page)).toBe("menu-btn");
});

test("the active nav tab has aria-current=page and the others have none", async ({ page }) => {
  const tabs = ["home", "chat", "string", "practice"];
  await expect(page.locator("#nav-home")).toHaveAttribute("aria-current", "page");
  for (const tab of tabs) {
    await page.locator(`#nav-${tab}`).click();
    for (const other of tabs) {
      const nav = page.locator(`#nav-${other}`);
      if (other === tab) await expect(nav).toHaveAttribute("aria-current", "page");
      else await expect(nav).not.toHaveAttribute("aria-current", /.*/);
    }
  }
});
