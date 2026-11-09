// Layout at four sizes: the bottom bar on phones, the left rail from 768px,
// and the two-column home from 1024px. Each describe block sets its viewport.
import { test, expect } from "@playwright/test";

const SIZES = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1440, height: 900 },
];
const [PHONE, TABLET, LANDSCAPE] = SIZES;

test.describe("bottom bar on phone, rail from tablet", () => {
  test.describe("phone", () => {
    test.use({ viewport: PHONE });
    test("nav is a bottom bar at 390", async ({ page }) => {
      await page.goto("/");
      const box = await page.locator(".appnav").boundingBox();
      expect(box.y).toBeGreaterThan(700);
    });
  });
  test.describe("tablet", () => {
    test.use({ viewport: TABLET });
    test("nav is a left rail at 820", async ({ page }) => {
      await page.goto("/");
      const box = await page.locator(".appnav").boundingBox();
      expect(box.x).toBe(0);
      expect(box.height).toBeGreaterThan(700);
      expect(box.width).toBeLessThan(120);
    });
  });
});

test.describe("home is one column until 1024, two after", () => {
  test.describe("tablet", () => {
    test.use({ viewport: TABLET });
    test("snap button sits above the topic list at 820", async ({ page }) => {
      await page.goto("/");
      const snap = await page.locator("#snap-btn").boundingBox();
      const list = await page.locator("#topic-list").boundingBox();
      expect(snap.y + snap.height).toBeLessThanOrEqual(list.y);
    });
  });
  test.describe("landscape", () => {
    test.use({ viewport: LANDSCAPE });
    test("topic list sits right of the snap button at 1180", async ({ page }) => {
      await page.goto("/");
      const snap = await page.locator("#snap-btn").boundingBox();
      const list = await page.locator("#topic-list").boundingBox();
      expect(list.x).toBeGreaterThan(snap.x + snap.width);
    });
  });
});

for (const size of SIZES) {
  test.describe(`no horizontal scroll at ${size.width}`, () => {
    test.use({ viewport: size });
    test(`home and chat fit ${size.width}px`, async ({ page }) => {
      await page.goto("/");
      const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
      expect(await scrollWidth()).toBe(size.width);
      await page.locator("#nav-chat").click();
      await expect(page.locator("#view-chat")).toBeVisible();
      expect(await scrollWidth()).toBe(size.width);
    });
  });
}

test.describe("composer sits at the bottom when the rail is shown", () => {
  test.use({ viewport: TABLET });
  test("composer bottom is the viewport bottom at 820", async ({ page }) => {
    await page.goto("/");
    await page.locator("#nav-chat").click();
    const box = await page.locator("#composer").boundingBox();
    expect(Math.abs(box.y + box.height - TABLET.height)).toBeLessThanOrEqual(4);
  });
});

for (const size of SIZES) {
  test.describe(`menu and account slot reachable at ${size.width}`, () => {
    test.use({ viewport: size });
    test(`menu button and account slot are visible at ${size.width}px`, async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("#menu-btn")).toBeVisible();
      await expect(page.locator("#account-slot")).toBeVisible();
    });
  });
}
