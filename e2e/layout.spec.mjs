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
    test("rail scrolls rather than clips on a short screen", async ({ page }) => {
      await page.setViewportSize({ width: 820, height: 420 });
      await page.goto("/");
      expect(await page.locator(".appnav").evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
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

// iPhone Safari zooms the whole page when a focused field's text is under
// 16px, pushing Send and the last tab off screen.
test("every text field is at least 16px so iPhone Safari doesn't zoom", async ({ page }) => {
  await page.goto("/");
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll("textarea, input[type=text], input:not([type]), input[type=email]")]
      .map((el) => [el.id || el.name, parseFloat(getComputedStyle(el).fontSize)]));
  expect(sizes.length).toBeGreaterThan(1);
  for (const [id, px] of sizes) expect(px, id).toBeGreaterThanOrEqual(16);
});

test.describe("typing on a phone", () => {
  test.use({ viewport: PHONE });
  test("the tabs step aside while the chat box has focus", async ({ page }) => {
    await page.goto("/");
    await page.locator("#nav-chat").click();
    await expect(page.locator(".appnav")).toBeVisible();
    await page.locator("#input").focus();
    await expect(page.locator(".appnav")).toBeHidden();
    const box = await page.locator("#composer").boundingBox();
    expect(Math.abs(box.y + box.height - PHONE.height)).toBeLessThanOrEqual(4);
    await page.locator("#input").blur();
    await expect(page.locator(".appnav")).toBeVisible();
  });
  test("the hint chips fit on one row and keep their full names", async ({ page }) => {
    await page.goto("/");
    await page.locator("#nav-chat").click();
    await page.evaluate(() => { document.getElementById("chips").hidden = false; });
    const chips = page.locator("#chips button");
    await expect(chips).toHaveCount(3);
    const boxes = await chips.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    for (const b of boxes) {
      expect(b.top).toBe(boxes[0].top);
      expect(b.right).toBeLessThanOrEqual(PHONE.width);
    }
    expect((await chips.first().innerText()).trim()).toBe("Hint");
    await expect(chips.first()).toHaveAccessibleName("Give me a hint");
  });
});

test("a one-line answer keeps the chat box the height of its buttons", async ({ page }) => {
  await page.goto("/");
  await page.locator("#nav-chat").click();
  await page.fill("#input", "I cant find them");
  const box = await page.locator("#input").boundingBox();
  expect(box.height).toBeLessThanOrEqual(48);
  await page.fill("#input", "line one\nline two\nline three");
  expect((await page.locator("#input").boundingBox()).height).toBeGreaterThan(60);
});
