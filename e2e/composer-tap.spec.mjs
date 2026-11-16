// Tapping the composer's buttons while typing on a phone. Focus leaving the
// text box brings the tab bar back and moves the composer, so a tap must not
// let it leave mid-tap. Issue #69.
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Open the chat with the (stubbed) tutor and start typing. */
async function typing(page, text = "2x + 3 = 11") {
  await page.route("**/api/chat", (route) => route.fulfill({ json: { reply: "What do you notice first?" } }));
  await page.goto("/");
  await page.locator("#nav-chat").tap();
  await page.locator("#input").tap();
  await page.locator("#input").pressSequentially(text);
  await expect(page.locator("#input")).toBeFocused();
  await expect(page.locator(".appnav")).toBeHidden(); // the tabs have stepped aside
}

test("tapping Send while typing sends the message", async ({ page }) => {
  await typing(page);
  await page.locator("#send").tap();
  await expect(page.locator("#chat .msg.user").last()).toHaveText("2x + 3 = 11");
  await expect(page.locator("#chat .msg.tutor").last()).toContainText("What do you notice first?");
});

test("tapping the maths keys toggle while typing opens the pad", async ({ page }) => {
  await typing(page);
  await page.locator("#pad-toggle").tap();
  await expect(page.locator("#mathpad")).toBeVisible();
  await expect(page.locator("#pad-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("tapping a maths key while typing inserts it", async ({ page }) => {
  await page.route("**/api/chat", (route) => route.fulfill({ json: { reply: "ok" } }));
  await page.goto("/");
  await page.locator("#nav-chat").tap();
  await page.locator("#pad-toggle").tap(); // open the pad before typing
  await page.locator("#input").tap();
  await page.locator("#input").pressSequentially("x");
  await page.locator("#pad-keys button[data-ins]").first().tap();
  const key = await page.locator("#pad-keys button[data-ins]").first().getAttribute("data-ins");
  await expect(page.locator("#input")).toHaveValue("x" + key);
});

test("tapping + while typing opens the attach menu", async ({ page }) => {
  await typing(page);
  await page.locator("#attach-btn").tap();
  await expect(page.locator("#attach-menu")).toBeVisible();
});

// Keyboard use is unchanged: no pointer press is involved.
test("Enter in the text box still sends", async ({ page }) => {
  await typing(page);
  await page.locator("#input").press("Enter");
  await expect(page.locator("#chat .msg.user").last()).toHaveText("2x + 3 = 11");
});

for (const key of ["Enter", "Space"]) {
  test(`Tab to Send, then ${key}, still sends`, async ({ page }) => {
    await typing(page);
    await page.locator("#send").focus();
    await expect(page.locator("#send")).toBeFocused();
    await page.keyboard.press(key);
    await expect(page.locator("#chat .msg.user").last()).toHaveText("2x + 3 = 11");
  });
}
