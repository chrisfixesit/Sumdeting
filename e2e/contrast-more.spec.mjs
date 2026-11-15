// Higher-contrast setting (#50): with prefers-contrast: more, the faint control
// edges and the copy icon reach 3:1 against what's behind them, in both themes.
// Without it, the default look is unchanged.
import { test, expect } from "@playwright/test";

const VIEWPORT = { width: 390, height: 844 };

// Today's default values, which must not change for people who haven't asked.
const DEFAULTS = {
  light: { soft: "rgb(207, 197, 172)", beadOff: "rgb(201, 190, 159)" },
  dark: { soft: "rgb(31, 54, 112)", beadOff: "rgb(46, 69, 128)" },
};

// WCAG 2.x relative luminance and contrast ratio.
const parseRgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function stubTutor(page) {
  await page.route("**/api/chat", (route) => route.fulfill({ json: { reply: "Here is a problem for you." } }));
}

async function open(page, theme, more) {
  await page.addInitScript((th) => localStorage.setItem("sumdeting.theme", th), theme);
  if (more) await page.emulateMedia({ contrast: "more" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

// An element's border colour, and the first opaque background behind it
// (its own, else its ancestors').
const edge = (locator) => locator.evaluate((el) => {
  const bgOf = (n) => {
    for (; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
    }
    return "rgb(255, 255, 255)";
  };
  return { border: getComputedStyle(el).borderTopColor, own: bgOf(el), behind: bgOf(el.parentElement) };
});

// The copy icon as seen: its colour blended by its opacity over the bubble.
const copySeen = (locator) => locator.evaluate((el) => {
  let bg = el.parentElement;
  while (bg && ["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(bg).backgroundColor)) bg = bg.parentElement;
  const s = getComputedStyle(el);
  return { color: s.color, opacity: Number(s.opacity), bubble: getComputedStyle(bg).backgroundColor };
});
const blend = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));

async function lastCopyButton(page) {
  await stubTutor(page);
  await page.locator("#home-ask-input").fill("2x + 3 = 11");
  await page.locator("#home-ask-input").press("Enter");
  const btn = page.locator(".msg .copy-btn").last();
  await expect(btn).toBeAttached();
  return btn;
}

test.use({ viewport: VIEWPORT });

for (const theme of ["light", "dark"]) {
  test.describe(`${theme}, prefers-contrast: more`, () => {
    test("outlined button edges reach 3:1 against their fill and the page", async ({ page }) => {
      await open(page, theme, true);
      for (const loc of [page.locator("#home-draw"), page.locator(".seg").first()]) {
        const { border, own, behind } = await edge(loc);
        expect(contrast(parseRgb(border), parseRgb(own))).toBeGreaterThanOrEqual(3);
        expect(contrast(parseRgb(border), parseRgb(behind))).toBeGreaterThanOrEqual(3);
      }
    });

    test("papers card edge reaches 3:1 against the page", async ({ page }) => {
      await open(page, theme, true);
      await page.locator("#nav-practice").click();
      const card = page.locator(".papers-card");
      await expect(card).toBeVisible();
      const { border, own } = await edge(card);
      expect(contrast(parseRgb(border), parseRgb(own))).toBeGreaterThanOrEqual(3);
    });

    test("copy button reaches 3:1 against its bubble", async ({ page }) => {
      await open(page, theme, true);
      const { color, opacity, bubble } = await copySeen(await lastCopyButton(page));
      const seen = blend(parseRgb(color), parseRgb(bubble), opacity);
      expect(contrast(seen, parseRgb(bubble))).toBeGreaterThanOrEqual(3);
    });
  });

  test(`${theme}, default contrast: the look is unchanged`, async ({ page }) => {
    await open(page, theme, false);
    expect((await edge(page.locator("#home-draw"))).border).toBe(DEFAULTS[theme].soft);
    expect((await edge(page.locator(".seg").first())).border).toBe(DEFAULTS[theme].soft);
    await page.locator("#nav-practice").click();
    expect((await edge(page.locator(".papers-card"))).border).toBe(DEFAULTS[theme].beadOff);
    await page.locator("#nav-home").click();
    const { opacity } = await copySeen(await lastCopyButton(page));
    expect(opacity).toBe(0.35);
  });
}
