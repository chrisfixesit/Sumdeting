// Copy button on tutor replies (#70): it never sits on the reply text, it has
// a 44x44 tap target, it still copies, and the chat stays axe-clean.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];
const SHORT = "What do you notice first?";
const LONG = [
  "Good start. Let's look at the equation together before we move anything around.",
  "",
  "What happens to both sides if you take 3 away from each? Try it, then tell me what you get on the left and on the right.",
].join("\n");

// Open the tutor with one stubbed reply, rendered the way the app renders it.
async function reply(page, theme, text) {
  await page.addInitScript((th) => {
    localStorage.setItem("sumdeting.theme", th);
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t) => { window.__copied.push(t); } },
    });
  }, theme);
  await page.route("**/api/chat", (route) => route.fulfill({ json: { reply: text } }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.locator("#home-ask-input").fill("2x + 3 = 11");
  await page.locator("#home-ask-input").press("Enter");
  const bubble = page.locator(".msg.tutor").filter({ has: page.locator(".copy-btn") }).last();
  await expect(bubble).toBeVisible();
  return bubble;
}

// The copy button's box and every line box of the reply text (button excluded).
const boxes = (bubble) => bubble.evaluate((el) => {
  const btn = el.querySelector(".copy-btn");
  const lines = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (btn.contains(n) || !n.textContent.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  const b = btn.getBoundingClientRect();
  return { button: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }, lines };
});
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const viewport of VIEWPORTS) {
  for (const theme of ["light", "dark"]) {
    test.describe(`${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport });

      for (const [name, text] of [["one-line", SHORT], ["long", LONG]]) {
        test(`${name} reply: the copy button doesn't cover the text and is at least 44x44`, async ({ page }) => {
          const { button, lines } = await boxes(await reply(page, theme, text));
          expect(lines.length).toBeGreaterThan(0);
          expect(lines.filter((l) => overlaps(l, button))).toEqual([]);
          expect(button.width).toBeGreaterThanOrEqual(44);
          expect(button.height).toBeGreaterThanOrEqual(44);
        });
      }

      test("the copy button copies the reply", async ({ page }) => {
        const bubble = await reply(page, theme, SHORT);
        await bubble.locator(".copy-btn").click();
        await expect.poll(() => page.evaluate(() => window.__copied)).toEqual([SHORT]);
      });

      test("the chat with a reply has no axe violations", async ({ page }) => {
        await reply(page, theme, LONG);
        expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([]);
      });
    });
  }
}
