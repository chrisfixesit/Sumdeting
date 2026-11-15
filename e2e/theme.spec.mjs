// Appearance in the ☰ menu (issue #49): Light, Dark or Match device. A chosen
// theme survives a reload; Match device forgets the choice and follows the
// device again, live. The current choice is announced, and the browser's
// theme-color follows the theme in use.
import { test, expect } from "@playwright/test";

const THEME_KEY = "sumdeting.theme";
const COLORS = { light: "#F4EEE0", dark: "#0A1A3D" };

const html = (page) => page.locator("html");
const option = (page, name) => page.locator("#menu").getByRole("button", { name, exact: true });

async function choose(page, name) {
  await page.locator("#menu-btn").click();
  await option(page, name).click();
}

test("choosing Dark on a light device sticks after a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(html(page)).toHaveAttribute("data-theme", "light");

  await choose(page, "Dark");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
});

test("Match device forgets the choice and follows the device live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("seeded")) { localStorage.setItem(key, "dark"); sessionStorage.setItem("seeded", "1"); }
  }, THEME_KEY);
  await page.goto("/");
  await expect(html(page)).toHaveAttribute("data-theme", "dark");

  await choose(page, "Match device");
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBeNull();
  await expect(html(page)).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("the current appearance choice is announced and changes when picked", async ({ page }) => {
  await page.goto("/");
  await page.locator("#menu-btn").click();
  await expect(page.locator("#menu").getByRole("group", { name: "Appearance" })).toBeVisible();
  const pressed = async () => {
    const out = {};
    for (const name of ["Light", "Dark", "Match device"]) out[name] = await option(page, name).getAttribute("aria-pressed");
    return out;
  };
  expect(await pressed()).toEqual({ Light: "false", Dark: "false", "Match device": "true" });

  await option(page, "Dark").click();
  expect(await pressed()).toEqual({ Light: "false", Dark: "true", "Match device": "false" });

  await option(page, "Light").click();
  expect(await pressed()).toEqual({ Light: "true", Dark: "false", "Match device": "false" });

  await option(page, "Match device").click();
  expect(await pressed()).toEqual({ Light: "false", Dark: "false", "Match device": "true" });
});

test("the browser theme-color follows the theme in use", async ({ page }) => {
  const meta = page.locator('meta[name="theme-color"]');
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(meta).toHaveAttribute("content", COLORS.light);

  await choose(page, "Dark");
  await expect(meta).toHaveAttribute("content", COLORS.dark);

  await option(page, "Match device").click();
  await expect(meta).toHaveAttribute("content", COLORS.light);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(meta).toHaveAttribute("content", COLORS.dark);
});

test("each appearance button is at least 44px tall", async ({ page }) => {
  await page.goto("/");
  await page.locator("#menu-btn").click();
  for (const name of ["Light", "Dark", "Match device"]) {
    const box = await option(page, name).boundingBox();
    expect(box.height, name).toBeGreaterThanOrEqual(44);
  }
});
