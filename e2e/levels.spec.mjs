// End-to-end tests for level-aware practice: the chosen level decides the
// topic chips, the exam lengths and what the tutor is asked for. The tutor
// (POST /api/chat) is stubbed so the tests can read each request.
import { test, expect } from "@playwright/test";

const ANON_PREFS = "mathmentor.prefs.v1";

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
const topicChips = (page) => page.locator("#topic-grid button");
const durationRows = (page) => page.locator("#duration-rows button");

test("Common Entrance shows its own topics and exam lengths", async ({ page }) => {
  await page.goto("/");
  await levelTab(page, "Common Entrance").click();
  await expect(topicChips(page)).toHaveText([
    "Number", "Fractions", "Percentages", "Ratios", "Measurement", "Geometry", "Sets", "Statistics", "Algebra",
  ]);
  await page.locator("#nav-practice").click();
  await expect(page.locator("#exam-sub")).toContainText("Common Entrance");
  await expect(durationRows(page)).toHaveText([/^30 min/, /^1h 15m/]);
  await expect(durationRows(page).filter({ hasText: "1h 15m" })).toHaveClass(/\bon\b/);
  await expect(page.locator("#papers-open")).toBeHidden();
});

test("switching back to CSEC restores the CSEC topics, lengths and past papers", async ({ page }) => {
  await page.goto("/");
  await levelTab(page, "Common Entrance").click();
  await levelTab(page, "CSEC / CXC").click();
  await expect(topicChips(page)).toContainText(["Trigonometry"]);
  await expect(topicChips(page).filter({ hasText: "Measurement" })).toHaveCount(0);
  await page.locator("#nav-practice").click();
  await expect(page.locator("#exam-sub")).toContainText("CSEC");
  await expect(durationRows(page)).toHaveText([/^30 min/, /^60 min/, /^90 min/, /^2h 40m/]);
  await expect(page.locator("#papers-open")).toBeVisible();
});

test("a Common Entrance practice request names the level and topic, and the choice survives a reload", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.goto("/");
  await levelTab(page, "Common Entrance").click();
  await topicChips(page).filter({ hasText: "Measurement" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("ONE Common Entrance practice problem on Measurement & Time");

  await page.reload(); // reopens on the saved chat, so the home tabs are hidden
  await expect(page.locator("#level-tabs .seg.on")).toHaveText("Common Entrance");
  expect(await page.locator("#topic").inputValue()).toBe("Measurement & Time");
});

test("starting an exam tells the tutor the level", async ({ page }) => {
  const sent = await stubTutor(page);
  await page.goto("/");
  await levelTab(page, "Common Entrance").click();
  await page.locator("#nav-practice").click();
  await page.locator("#exam-btn").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("Common Entrance");
  expect(sent[0]).toContain("75 minutes");
});

test("saved choices that don't belong to the level fall back to that level's defaults", async ({ page }) => {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, JSON.stringify({ level: "Common Entrance", topic: "Trigonometry", duration: "160" }));
  }, [ANON_PREFS]);
  await page.goto("/");
  await expect(levelTab(page, "Common Entrance")).toHaveClass(/\bon\b/);
  expect(await page.locator("#topic").inputValue()).toBe("Number & Place Value");
  expect(await page.locator("#exam-duration").inputValue()).toBe("75");
});

test("tricky-topic chips only offer topics from the current level", async ({ page }) => {
  const day = new Date().toISOString().slice(0, 10);
  const hard = [{ ok: false, hints: 2, turns: 6, d: day }, { ok: false, hints: 1, turns: 5, d: day }];
  await page.addInitScript(([d, h]) => {
    localStorage.setItem("mathmentor.prefs.v1", JSON.stringify({ level: "Common Entrance", topic: "", duration: "" }));
    localStorage.setItem("mathmentor.mastery.v1", JSON.stringify({
      topics: {
        Trigonometry: { attempted: 2, solved: 0, hist: h },
        "Fractions & Decimals": { attempted: 2, solved: 0, hist: h },
      },
      streak: { count: 1, last: d },
      days: {},
    }));
  }, [day, hard]);
  await page.goto("/");
  await page.locator("#nav-string").click();
  await expect(page.getByRole("button", { name: "Practice Fractions & Decimals again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Practice Trigonometry again" })).toHaveCount(0);
});
