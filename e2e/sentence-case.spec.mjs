// Sentence case (#52): headings, buttons, tabs and level pills capitalise only
// the first word of each sentence, plus proper nouns and acronyms.
import { test, expect } from "@playwright/test";

// Proper nouns and acronyms that keep their capitals. Matched as whole words.
const ALLOW = [
  "SumDeTing", "CSEC", "CAPE", "BSSEE", "CXC", "Common Entrance", "Additional Maths",
  "Paper 1", "Paper 2", "Barbados", "Bajan", "GitHub", "Claude", "Amazon Bedrock",
  "I", "I'm", "I'll", "I’m", "I’ll",
];
// Syllabus topic names (LEVEL_SETUP). They are the keys of saved progress
// (mathmentor.mastery.v1, synced to accounts), so renaming them would orphan
// students' progress. They stay as they are; see #52.
const TOPICS = [
  "Number & Place Value", "Fractions & Decimals", "Percentages & Money", "Ratio & Proportion",
  "Measurement & Time", "Geometry & Mensuration", "Sets & Venn Diagrams", "Statistics & Probability",
  "Functions & Graphs", "Vectors & Matrices", "Coordinate Geometry & Vectors", "Sequences & Series",
  "Logic & Proof", "Complex Numbers", "Further Calculus", "Counting & Probability", "Differential Equations",
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMES = [...TOPICS, ...ALLOW].sort((a, b) => b.length - a.length);
const ALLOW_RE = new RegExp(`(^|[^\\p{L}])(${NAMES.map(escape).join("|")})(?![\\p{L}])`, "gu");

// Capitalised words after the first word of each sentence, once allowed names are removed.
function offenders(text) {
  const out = [];
  for (const line of text.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?:])\s+/)) {
      // Swap each allowed name for a lowercase placeholder, so word positions don't move.
      const words = sentence.replace(ALLOW_RE, "$1x").trim().split(/\s+/).slice(1);
      if (words.some((w) => /^[^\p{L}]*\p{Lu}/u.test(w))) out.push(sentence.trim());
    }
  }
  return out;
}

const SELECTOR = "h1, h2, h3, button, [role=tab], .seg";
// The text as written, so CSS text-transform (the uppercase kicker) doesn't count.
async function collect(page, scope = "body") {
  return page.locator(scope).locator(SELECTOR).evaluateAll((els) => {
    const off = document.createElement("style");
    off.textContent = "* { text-transform: none !important; }";
    document.head.append(off);
    const texts = els.filter((el) => el.checkVisibility()).map((el) => el.innerText.trim()).filter(Boolean);
    off.remove();
    return texts;
  });
}
const bad = (texts) => [...new Set(texts.flatMap(offenders))];

test.use({ viewport: { width: 390, height: 844 } });

test("the allow-list check flags title case and passes proper nouns", () => {
  expect(offenders("Exam Mode")).toEqual(["Exam Mode"]);
  expect(offenders("CSEC Past Papers 2004–2025")).toEqual(["CSEC Past Papers 2004–2025"]);
  expect(offenders("Practise for Common Entrance with SumDeTing")).toEqual([]);
  expect(offenders("Exam mode. Pick a paper")).toEqual([]);
  // An allowed name in first place must not shift the next word into first place.
  expect(offenders("CSEC Past papers 2004–2025")).toEqual(["CSEC Past papers 2004–2025"]);
  expect(offenders("Common Entrance Topics")).toEqual(["Common Entrance Topics"]);
});

test("Home, Tutor, String and Exam use sentence case at every level", async ({ page }) => {
  await page.goto("/");
  const texts = [];
  const levels = await page.locator("#level-tabs .seg").allInnerTexts();
  expect(levels.length).toBeGreaterThan(1);
  for (const level of levels) {
    await page.locator("#nav-home").click();
    await page.locator("#level-tabs .seg", { hasText: level }).click();
    texts.push(...await collect(page));
    await page.locator("#nav-practice").click();
    texts.push(...await collect(page));
  }
  await page.locator("#nav-chat").click();
  await page.locator("#attach-btn").click();
  texts.push(...await collect(page));
  await page.keyboard.press("Escape");
  await page.locator("#nav-string").click();
  texts.push(...await collect(page));
  await page.locator("#nav-practice").click();
  texts.push(...await collect(page));
  expect(bad(texts)).toEqual([]);
});

test("the papers sheet, sketch dialog and menu use sentence case", async ({ page }) => {
  await page.goto("/");
  await page.locator("#menu-btn").click();
  await expect(page.locator("#menu")).toBeVisible();
  const texts = await collect(page, "#menu");
  await page.keyboard.press("Escape");
  await page.locator("#nav-practice").click();
  await page.locator("#papers-open").click();
  texts.push(...await collect(page, "#papers-sheet"));
  await page.keyboard.press("Escape");
  await page.locator("#nav-chat").click();
  await page.locator("#attach-btn").click();
  await page.locator("#sketch").click();
  await expect(page.locator("#sketch-modal")).toBeVisible();
  texts.push(...await collect(page, "#sketch-modal"));
  expect(bad(texts)).toEqual([]);
});

test("the About page uses sentence case", async ({ page }) => {
  await page.goto("/about.html");
  expect(bad(await collect(page))).toEqual([]);
});
