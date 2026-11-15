// No visible text below the 11 px minimum (HIG typography), on every tab,
// at phone and tablet widths. Issue #45.
import { test, expect } from "@playwright/test";

const MASTERY = "mathmentor.mastery.v1";
const MIN_PX = 11;
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
];
const TABS = [
  ["Home", "#nav-home"],
  ["Tutor", "#nav-chat"],
  ["String", "#nav-string"],
  ["Exam", "#nav-practice"],
];
const today = () => new Date().toISOString().slice(0, 10);

async function seed(page) {
  const d = today();
  await page.addInitScript(([key, day]) => {
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 3, attempted: 4 }, "Statistics & Probability": { solved: 4, attempted: 4 } },
      streak: { count: 4, last: day },
      days: { [day]: 12 },
    }));
  }, [MASTERY, d]);
}

// Every visible text node smaller than the minimum, as "selector: size 'text'".
const smallText = (page) => page.evaluate((min) => {
  const out = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size >= min) continue;
    const name = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") +
      [...el.classList].map((c) => `.${c}`).join("");
    const parent = el.parentElement;
    const where = parent ? parent.tagName.toLowerCase() + (parent.id ? `#${parent.id}` : "") + [...parent.classList].map((c) => `.${c}`).join("") + " > " : "";
    out.add(`${where}${name}: ${size}px '${n.textContent.trim().slice(0, 30)}'`);
  }
  return [...out];
}, MIN_PX);

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const [tab, nav] of TABS) {
      test(`${tab} has no visible text below ${MIN_PX}px`, async ({ page }) => {
        await seed(page);
        await page.goto("/");
        await page.locator(nav).click();
        await expect(page.locator(nav)).toHaveClass(/\bon\b/);
        expect(await smallText(page)).toEqual([]);
      });
    }
  });
}

test.describe("320x640", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the four tab labels fit without clipping or overlap", async ({ page }) => {
    await page.goto("/");
    const boxes = await page.locator(".appnav button span:not(.bar)").evaluateAll((spans) =>
      spans.map((s) => {
        const r = s.getBoundingClientRect(), b = s.closest("button").getBoundingClientRect();
        return { text: s.textContent, left: r.left, right: r.right, inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5, clipped: s.scrollWidth > s.clientWidth + 0.5 };
      }));
    expect(boxes.map((b) => b.text)).toEqual(["Home", "Tutor", "String", "Exam"]);
    for (const b of boxes) expect(b, b.text).toMatchObject({ inside: true, clipped: false });
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
  });
});
