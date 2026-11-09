// End-to-end tests for the 3A "String" home page: the stuck-student panel,
// the next-step line, the topic bead threads and the header stats. The tutor
// (POST /api/chat) is stubbed so the tests can read each request.
import { test, expect } from "@playwright/test";

const MASTERY = "mathmentor.mastery.v1";

/** Stub the tutor and collect the text of each student message sent. */
async function stubTutor(page) {
  const sent = [];
  await page.route("**/api/chat", async (route) => {
    const { messages } = route.request().postDataJSON();
    const last = messages.at(-1);
    const text = typeof last.content === "string"
      ? last.content
      : last.content.filter((c) => c.text).map((c) => c.text).join(" ");
    sent.push(text);
    await route.fulfill({ json: { reply: "Here is a problem for you." } });
  });
  return sent;
}

const levelTab = (page, name) => page.locator("#level-tabs").getByRole("button", { name, exact: true });
const topicRow = (page, topic) => page.locator(`#topic-list .trow-home[data-topic="${topic}"]`);
const today = () => new Date().toISOString().slice(0, 10);

test("fresh visitor sees the headline, snap button and new-student line", async ({ page }) => {
  await page.goto("/");
  const h1 = await page.locator("h1").innerText();
  expect(h1.replace(/\s+/g, " ").trim()).toBe("Stuck? I got you.");
  const snap = page.locator("#snap-btn");
  await expect(snap).toBeVisible();
  const box = await snap.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await expect(page.locator("#next-step-text")).toHaveText("New here? Pick a topic below, or let me choose.");
  await expect(page.locator("#pickup-btn")).toBeHidden();
  await expect(page.locator("#stat-beads")).toBeHidden();
  await expect(page.locator("#stat-streak")).toBeHidden();
});

test("progress shows beads, words and the pickup button", async ({ page }) => {
  const d = today();
  await page.addInitScript(([key, day]) => {
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 3, attempted: 4 }, "Statistics & Probability": { solved: 4, attempted: 4 } },
      streak: { count: 4, last: day },
      days: { [day]: 12 },
    }));
  }, [MASTERY, d]);
  await page.goto("/");
  const stats = topicRow(page, "Statistics & Probability");
  await expect(stats.locator(".beads i")).toHaveCount(5);
  await expect(stats.locator(".beads i.on")).toHaveCount(4);
  await expect(stats.locator(".mastery-word")).toHaveText("Familiar");
  await expect(stats.locator(".count")).toContainText("4 of 5");
  await expect(stats).toHaveAccessibleName("Statistics & Probability, Familiar, 4 of 5 beads, up next");
  await expect(topicRow(page, "Algebra")).toHaveAccessibleName("Algebra, Familiar, 3 of 5 beads");
  await expect(page.locator("#pickup-btn")).toHaveText("Pick up Statistics & Probability");
  await expect(page.locator("#next-step-text")).toHaveText("One more bead and Statistics & Probability is mastered.");
  await expect(page.locator("#stat-beads")).toContainText("12");
  await expect(page.locator("#stat-streak")).toContainText("4");
});

test("tapping a topic row asks the tutor for that topic", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.goto("/");
  await levelTab(page, "CSEC").click();
  await topicRow(page, "Trigonometry").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("ONE CSEC practice problem on Trigonometry");
  expect(await page.locator("#topic").inputValue()).toBe("Trigonometry");
});

test("Give me a problem picks a topic from the current level", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.goto("/");
  await levelTab(page, "Common Entrance").click();
  const topics = await page.locator("#topic-list .topic-name").allInnerTexts();
  await expect(page.locator("#practice-btn")).toHaveAttribute("title", "I'll pick a topic at your level");
  await page.locator("#practice-btn").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("ONE Common Entrance practice problem on ");
  expect(topics.some((t) => sent[0].includes(`practice problem on ${t}.`))).toBe(true);
});

test("Pick up practises the up-next topic", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 2, attempted: 3 } }, streak: { count: 1, last: "" }, days: {},
    }));
  }, [MASTERY]);
  await page.goto("/");
  await levelTab(page, "CSEC").click();
  await page.locator("#pickup-btn").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("ONE CSEC practice problem on Algebra");
});

test("empty type box does nothing", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.goto("/");
  await page.locator("#home-ask-input").fill("   ");
  await page.locator("#home-ask-input").press("Enter");
  await page.waitForTimeout(400);
  await expect(page.locator("#view-chat")).toBeHidden();
  await expect(page.locator("#view-home")).toBeVisible();
  expect(sent.length).toBe(0);
});

test("typing a question opens the tutor with it", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.goto("/");
  await page.locator("#home-ask-input").fill("  solve 2x=8 ");
  await page.locator("#home-ask button[type=submit]").click();
  await expect(page.locator("#view-chat")).toBeVisible();
  await expect(page.locator("#chat .msg.user")).toHaveText("solve 2x=8");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toBe("solve 2x=8");
  await expect(page.locator("#input")).toHaveValue("");
});

test("Draw it opens the tutor with the sketch pad", async ({ page }) => {
  await page.goto("/");
  await page.locator("#home-draw").click();
  await expect(page.locator("#view-chat")).toBeVisible();
  await expect(page.locator("#sketch-modal")).toBeVisible();
});

test("switching level re-renders topics and the next step", async ({ page }) => {
  await page.goto("/");
  await levelTab(page, "CAPE").click();
  await expect(levelTab(page, "CAPE")).toHaveAttribute("aria-pressed", "true");
  await expect(levelTab(page, "CSEC")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#topic-list .topic-name")).toContainText(["Complex Numbers & Matrices"]);
  await expect(page.locator("#paper-pick")).toBeHidden();
  await expect(page.locator("#next-step-text")).toHaveText("New here? Pick a topic below, or let me choose.");
});

test("when every topic is mastered the next step links to the exam", async ({ page }) => {
  await page.addInitScript(([key]) => {
    const names = ["Algebra", "Functions & Graphs", "Coordinate Geometry & Vectors", "Trigonometry",
      "Sequences & Series", "Calculus", "Statistics & Probability"];
    const topics = Object.fromEntries(names.map((n) => [n, { solved: 5, attempted: 5 }]));
    localStorage.setItem(key, JSON.stringify({ topics, streak: { count: 0, last: "" }, days: {} }));
    localStorage.setItem("mathmentor.prefs.v1", JSON.stringify({ level: "Additional Maths", topic: "", duration: "" }));
  }, [MASTERY]);
  await page.goto("/");
  await expect(page.locator("#pickup-btn")).toBeHidden();
  const link = page.locator("#next-step-text a");
  await expect(link).toHaveText(/timed exam/);
  await link.click();
  await expect(page.locator("#view-practice")).toBeVisible();
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("long topic names stay on one row at 390px", async ({ page }) => {
    await page.goto("/");
    for (const level of ["Common Entrance", "CSEC", "Additional Maths", "CAPE"]) {
      await levelTab(page, level).click();
      const heights = await page.locator("#topic-list .trow-home").evaluateAll(
        (rows) => rows.map((r) => r.getBoundingClientRect().height));
      expect(heights.length).toBeGreaterThan(0);
      for (const h of heights) expect(h, level).toBeLessThanOrEqual(72);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    }
  });
});

test("earned beads fill once on load, and not at all under reduced motion", async ({ page }) => {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 3, attempted: 3 } }, streak: { count: 1, last: "" }, days: {},
    }));
  }, [MASTERY]);
  await page.goto("/");
  await expect(topicRow(page, "Algebra").locator(".beads i.on.anim")).toHaveCount(3);
  await levelTab(page, "CAPE").click(); // re-render: no second fill
  await expect(topicRow(page, "Algebra").locator(".beads i.on")).toHaveCount(3);
  await expect(page.locator("#topic-list .beads i.anim")).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(topicRow(page, "Algebra").locator(".beads i.on")).toHaveCount(3);
  await expect(page.locator("#topic-list .beads i.anim")).toHaveCount(0);
});

test("a stale streak is hidden on home and String", async ({ page }) => {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, JSON.stringify({ topics: {}, streak: { count: 9, last: "2026-01-01" }, days: {} }));
  }, [MASTERY]);
  await page.goto("/");
  await expect(page.locator("#stat-streak")).toBeHidden();
  await page.locator("#nav-string").click();
  await expect(page.locator("#string-streak")).toHaveText("0");
});

test("String view uses the four mastery words", async ({ page }) => {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, JSON.stringify({
      topics: { Algebra: { solved: 3, attempted: 3 }, Trigonometry: { solved: 1, attempted: 2 } },
      streak: { count: 0, last: "" }, days: {},
    }));
  }, [MASTERY]);
  await page.goto("/");
  await page.locator("#nav-string").click();
  const row = (name) => page.locator("#string-topics .trow", { hasText: name }).first();
  await expect(row("Algebra").locator("b")).toHaveText("Familiar");
  await expect(row("Trigonometry").locator("b")).toHaveText("Attempted");
});

test("a topic tried but never solved reads Attempted on home and String", async ({ page }) => {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, JSON.stringify({
      topics: { Trigonometry: { solved: 0, attempted: 2 } }, streak: { count: 0, last: "" }, days: {},
    }));
  }, [MASTERY]);
  await page.goto("/");
  await levelTab(page, "CSEC").click();
  const trig = topicRow(page, "Trigonometry");
  await expect(trig.locator(".mastery-word")).toHaveText("Attempted");
  await expect(trig).toHaveAccessibleName("Trigonometry, Attempted, 0 of 5 beads, up next");
  await expect(topicRow(page, "Algebra").locator(".mastery-word")).toHaveText("Not started");
  await page.locator("#nav-string").click();
  const row = (name) => page.locator("#string-topics .trow", { hasText: name }).first();
  await expect(row("Trigonometry").locator("b")).toHaveText("Attempted");
  await expect(row("Algebra").locator("b")).toHaveText("Not started");
});

test("a home question typed while a reply streams is kept, not lost", async ({ page }) => {
  const sent = [];
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/chat", async (route) => {
    sent.push(route.request().postDataJSON().messages.at(-1).content);
    await held; // the first reply stays in flight until the test lets it go
    await route.fulfill({ json: { reply: "Here is a problem for you." } });
  });
  await page.goto("/");
  await levelTab(page, "CSEC").click();
  await topicRow(page, "Algebra").click();
  await expect.poll(() => sent.length).toBe(1);
  await page.locator("#nav-home").click();
  await page.locator("#home-ask-input").fill("solve 2x=8");
  await page.locator("#home-ask-input").press("Enter");
  await page.waitForTimeout(300);
  await expect(page.locator("#home-ask-input")).toHaveValue("solve 2x=8");
  await expect(page.locator("#view-home")).toBeVisible();
  release();
  await expect(page.locator("#chat .msg.tutor").last()).toContainText("Here is a problem");
  await page.waitForTimeout(300);
  expect(sent.length).toBe(1);
});

test("keyboard focus keeps the shape of pill buttons", async ({ page }) => {
  await page.goto("/");
  const btn = page.locator("#practice-btn");
  const before = await btn.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  await page.keyboard.press("Tab"); // keyboard modality, so focus() below is :focus-visible
  await btn.focus();
  expect(await btn.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  expect(await btn.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(before);
});
