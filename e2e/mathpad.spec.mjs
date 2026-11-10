// End-to-end tests for the chat composer: the + menu (photo, draw, voice) and
// the maths pad whose keys follow the level and the topic in progress.
import { test, expect } from "@playwright/test";

/** Open the tutor view with a level (and optionally a topic) chosen. */
async function openChat(page, level = "CSEC", topic = null) {
  await page.goto("/");
  await page.evaluate(([lv, tp]) => {
    const levelSel = document.getElementById("level");
    levelSel.value = lv;
    levelSel.dispatchEvent(new Event("change"));
    if (tp) {
      const topicSel = document.getElementById("topic");
      topicSel.value = tp;
      topicSel.dispatchEvent(new Event("change"));
    }
  }, [level, topic]);
  await page.locator("#nav-chat").click();
  await expect(page.locator("#view-chat")).toBeVisible();
}

const padKey = (page, label) => page.locator(`#pad-keys button[data-ins]:text-is("${label}")`);
const keyLabels = (page) => page.locator("#pad-keys button[data-ins]").allInnerTexts();

test("pad is closed by default and opens on ∑", async ({ page }) => {
  await openChat(page);
  const toggle = page.locator("#pad-toggle");
  await expect(page.locator("#mathpad")).toBeHidden();
  await expect(toggle).toHaveText("∑");
  await expect(toggle).toHaveAttribute("aria-label", "Maths keys");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator("#mathpad")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(page.locator("#mathpad")).toBeHidden();
});

test("pad keys follow the level", async ({ page }) => {
  await openChat(page, "Common Entrance");
  await page.locator("#pad-toggle").click();
  await expect(padKey(page, "$")).toHaveCount(1);
  await expect(padKey(page, "sin")).toHaveCount(0);

  // Changing the level while the pad is open re-renders it.
  await page.evaluate(() => {
    const levelSel = document.getElementById("level");
    levelSel.value = "CAPE";
    levelSel.dispatchEvent(new Event("change"));
  });
  await expect(padKey(page, "lim")).toHaveCount(1);
  await expect(padKey(page, "$")).toHaveCount(0);
});

test("topic keys come first", async ({ page }) => {
  await openChat(page, "CSEC", "Trigonometry");
  await page.locator("#pad-toggle").click();
  const labels = await keyLabels(page);
  expect(labels.slice(0, 3)).toEqual(["sin", "cos", "tan"]);
});

test("keys insert at the cursor", async ({ page }) => {
  await openChat(page);
  await page.locator("#pad-toggle").click();
  await page.locator("#input").fill("2");
  await padKey(page, "sin").click();
  await padKey(page, "π").click();
  await expect(page.locator("#input")).toHaveValue("2sin(π");
  await expect(page.locator("#input")).toBeFocused();
});

test("More shows every key", async ({ page }) => {
  await openChat(page);
  await page.locator("#pad-toggle").click();
  const more = page.locator("#pad-more");
  await expect(more).toHaveText(/More/);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  const all = await page.evaluate(() => SumHome.ALL_PAD_KEYS.length);
  expect(await page.locator("#pad-keys button[data-ins]").count()).toBeLessThan(all);
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#pad-keys button[data-ins]")).toHaveCount(all);
});

test("attach menu holds photo, draw and voice and closes on Escape", async ({ page }) => {
  await openChat(page);
  const btn = page.locator("#attach-btn");
  await expect(btn).toHaveAttribute("aria-label", "Add a photo, drawing or voice");
  await expect(page.locator("#attach-menu")).toBeHidden();
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#photo")).toBeVisible();
  await expect(page.locator("#sketch")).toBeVisible();
  await expect(page.locator("#mic")).toBeVisible();
  await expect(page.locator("#photo")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#attach-menu")).toBeHidden();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await expect(btn).toBeFocused();
});

test("attach menu closes on an outside click and after a choice", async ({ page }) => {
  await openChat(page);
  const btn = page.locator("#attach-btn");
  await btn.click();
  await page.locator("#chat").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#attach-menu")).toBeHidden();

  await btn.click();
  await page.locator("#sketch").click();
  await expect(page.locator("#attach-menu")).toBeHidden();
  await expect(page.locator("#sketch-modal")).toBeVisible();
});

test("drawing on the sketch pad never selects page text", async ({ page }) => {
  await openChat(page);
  await page.locator("#attach-btn").click();
  await page.locator("#sketch").click();
  const box = await page.locator("#sk-canvas").boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
  await page.mouse.move(box.x + 200, 5, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection().toString())).toBe("");
  const userSelect = (sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).userSelect);
  expect(await userSelect("#sketch-modal")).toBe("none");
  expect(await userSelect("body")).toBe("none");
  await page.locator("#sk-cancel").click();
  expect(await userSelect("body")).not.toBe("none");
});

test("composer row runs +, text box, ∑, send", async ({ page }) => {
  await openChat(page);
  const ids = ["#attach-btn", "#input", "#pad-toggle", "#send"];
  const xs = [];
  for (const id of ids) xs.push((await page.locator(id).boundingBox()).x);
  expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  const order = await page.locator("#composer .composer-row").evaluate((row) =>
    [...row.querySelectorAll("#attach-btn, #input, #pad-toggle, #send")].map((e) => e.id));
  expect(order).toEqual(["attach-btn", "input", "pad-toggle", "send"]);
  await expect(page.locator("#mathbar")).toHaveCount(0);
});

test("composer fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page);
  const box = await page.locator("#input").boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(180);
});

test("composer field and buttons have a 3:1 border in light theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sumdeting.theme", "light"));
  await openChat(page);
  for (const id of ["#input", "#attach-btn", "#pad-toggle"]) {
    const color = await page.locator(id).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(color, id).toBe("rgb(133, 126, 108)"); // #857E6C
  }
});

test("an open pad follows a new practice topic", async ({ page }) => {
  await page.route("**/api/chat", (route) => route.fulfill({ json: { reply: "Here is a problem for you." } }));
  const practise = async (topic) => {
    await page.locator("#nav-home").click();
    await page.locator(`#topic-list .trow-home[data-topic="${topic}"]`).click();
    await expect(page.locator("#chat .msg.tutor").last()).toContainText("Here is a problem");
    await expect(page.locator("#send")).toBeEnabled();
  };
  await openChat(page, "CSEC", "Algebra");
  await practise("Algebra");
  await page.locator("#pad-toggle").click();
  expect((await keyLabels(page))[0]).toBe("x");
  await practise("Trigonometry");
  await expect(page.locator("#mathpad")).toBeVisible();
  await expect.poll(async () => (await keyLabels(page))[0]).toBe("sin");
});

test("pad keys have spoken names", async ({ page }) => {
  await openChat(page, "CSEC", "Fractions & Decimals");
  await page.locator("#pad-toggle").click();
  await page.locator("#pad-more").click();
  await expect(padKey(page, "½")).toHaveAccessibleName("fraction slash");
  await expect(padKey(page, "x²")).toHaveAccessibleName("x squared");
  await expect(padKey(page, "√")).toHaveAccessibleName("square root");
  const missing = await page.locator("#pad-keys button[data-ins]").evaluateAll((bs) =>
    bs.filter((b) => !b.getAttribute("aria-label")).map((b) => b.textContent));
  expect(missing).toEqual([]);
});

test("a key pressed from the keyboard keeps focus and inserts", async ({ page }) => {
  await openChat(page);
  await page.locator("#pad-toggle").click();
  await page.locator("#input").fill("2");
  await page.locator("#pad-toggle").focus();
  let onKey = false;
  for (let i = 0; i < 6 && !onKey; i++) {
    await page.keyboard.press("Tab");
    onKey = await page.evaluate(() => !!document.activeElement?.closest("#pad-keys button[data-ins]"));
  }
  expect(onKey).toBe(true);
  const label = await page.evaluate(() => document.activeElement.textContent);
  const ins = await page.evaluate(() => document.activeElement.dataset.ins);
  await page.keyboard.press("Enter");
  await expect(page.locator("#input")).toHaveValue("2" + ins);
  expect(await page.evaluate(() => document.activeElement.textContent)).toBe(label);
  expect(await page.evaluate(() => !!document.activeElement.closest("#pad-keys"))).toBe(true);
});
