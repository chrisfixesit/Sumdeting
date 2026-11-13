# Home redesign (3A String) and level-aware maths pad: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For every UI task, also load the `frontend-design:frontend-design` skill: the owner rejected generic-looking UI.

**Goal:** Replace the SumDeTing home page with the approved 3A "String" design (light and dark), add a navigation rail and two-column layout for tablets and laptops, and replace the chat's fixed symbol bar with a maths pad chosen by level and topic.

**Architecture:**
- **Pure logic in a new module.** Mastery words, the up-next rule, the live streak, and the pad's key sets and inserted text go in `web/home-core.mjs`. It's an ES module unit-tested with `node --test`, and it also publishes `window.SumHome` for the page.
- **`web/index.html` stays the app.** Its classic inline script uses `window.SumHome` only inside event handlers and from `DOMContentLoaded` onward. Module scripts run before `DOMContentLoaded`, so they're available by then. The existing `renderMastery` already runs at that point.
- **Behaviour is proven with Playwright end-to-end tests** in `e2e/`.

**Tech stack:**
- Vanilla JS, with HTML and CSS inline in `web/index.html`.
- `node:test` for unit tests; `@playwright/test` 1.48.2 for e2e.
- `@axe-core/playwright` for the accessibility gate.
- Fonts are self-hosted under `web/vendor/fonts/`.

**Spec:** `docs/superpowers/specs/2026-11-09-home-redesign-design.md` (approved). Visual references:
- `docs/design/home-3a-string.html` (dark)
- `docs/design/home-3a-string-light.html` (light)
- `docs/design/maths-pad-by-level.html`

Copy the reference CSS and markup freely; it's the approved design.

## Global constraints

- **CSP is `'self'` only.** No third-party runtime assets: fonts, scripts and styles come from `web/` or `web/vendor/`. Fraunces (weight 100–900, opsz) and Space Grotesk (300–700) are already vendored. Drop the mockup's `SOFT` axis if the vendored Fraunces lacks it.
- **WCAG 2.2 AA in both themes, checked by axe with exactly these tags:** `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`.
  - Text needs at least 4.5:1, and beads and field borders at least 3:1.
  - Focus must be visible, tap targets at least 24px (aim for 44px), and `prefers-reduced-motion` must turn the bead fill animation off.
- **Keep the IDs and contracts these depend on:**
  - accounts: `#account-slot`, `storageKey`, `window.SumDeTing`;
  - `#level`, `#topic` and `#exam-duration` (the hidden selects stay the source of truth);
  - `#level-tabs` buttons with class `seg`, plus `on` when selected (`e2e/account.spec.mjs` relies on these);
  - `#paper-pick`/`#paper-tabs`, `#practice-btn`, `#snap-btn`, `#photo`, `#sketch`, `#mic`, `#input`, the `#nav-*` buttons, `#menu`, `#theme` and `#chips`.
- **Copy, verbatim from the spec:**
  - Headline: "Stuck?" / "I got you."
  - Sub-line: "I guide you to the answer, bead by bead. I never hand it over."
  - Snap button: "Snap a photo", second line "of the question in your book".
  - Type box placeholder: "Or type it, like 3/4 of 120".
  - Practice: heading "Practise a topic", and the buttons "Pick up <topic>" and "Give me a problem".
  - New-student line: "New here? Pick a topic below, or let me choose."
  - Footer: "Made in Barbados. Built with Claude on Amazon Bedrock. Source on GitHub", linking to https://github.com/chrisfixesit/Sumdeting.
- **No generic UI:**
  - no uppercase tracked eyebrow labels;
  - no "→" in button text (the type box's arrow icon button is fine);
  - no identical rounded cards with soft shadows;
  - only one animation (the bead fill).
- **Breakpoints:**
  - Below 768px: bottom tab bar.
  - 768px and up: left rail, bottom bar hidden.
  - 1024px and up: home in two columns.
- **Level button labels:** Common Entrance, CSEC, Additional Maths, CAPE. CSEC's label changes from "CSEC / CXC" to "CSEC".
- **Run the tests:**
  - Unit: `cd backend && npm test`, which runs `../web/*.test.mjs`.
  - e2e: `cd e2e && npx playwright test`.
- **Work on branch `feat/home-redesign` in the worktree `../sumdeting-redesign`.** It's branched from `origin/main` and already holds the spec, the plan and `docs/design/`. Never work in the shared checkout. Rebase on `origin/main` before starting, because other sessions merge often. Check `git branch --show-current` before every commit. Each task ends in a commit, and the PR comes at the end.

## Review focus

The input classes the spec implies, and which test pins each one:

1. **A level with more topics than the mockup.** CSEC has 10 and Common Entrance 9. Every topic must show, and long names like "Coordinate Geometry & Vectors" must not break the row on a phone. *Pinned in Task 2:* `long topic names stay on one row at 390px`.
2. **Old saved data.** Topics solved more than 5 times, `streak.last` weeks ago, or a missing `days` map must show a capped "5 of 5", no streak, and no crash. *Pinned in Task 1:* unit tests for `beadCount` and `liveStreak`. *Task 4:* `a stale streak is hidden on home and String`.
3. **Switching level mid-page.** The topic list, the next-step line, the paper picker and the pad's keys all follow the new level without a reload. *Pinned in Task 2:* `switching level re-renders topics and the next step`. *Task 5:* `pad keys follow the level`.
4. **The type box submitted empty, or with only spaces.** It must not send a blank message to the tutor. *Pinned in Task 2:* `empty type box does nothing`.
5. **Theme switch while on home.** Both themes keep contrast: beads amber `#A86B00` on light, gold on dark. *Pinned in Task 6:* the axe matrix runs both themes.

---

### Task 1: `web/home-core.mjs`, the pure logic

**Files:**
- Create: `web/home-core.mjs`
- Test: `web/home-core.test.mjs` (picked up by `backend/package.json`'s `npm test` glob)
- Modify: `web/index.html`. Add `<script type="module" src="home-core.mjs"></script>` just before the existing `account-ui.mjs` script tag.

**Interfaces (Produces), all named exports, and the same functions on `window.SumHome` when `window` exists:**
- `masteryState(solved: number) => "not-started" | "attempted" | "familiar" | "mastered"`: 0 is not started; 1–2 attempted; 3–4 familiar; 5 or more mastered.
- `masteryWord(state) => string`: "Not started", "Attempted", "Familiar", "Mastered".
- `beadCount(solved: number) => number`: `solved` clamped to the range 0–5. Non-numbers count as 0.
- `upNext(topics: string[], masteryTopics: Record<string,{solved:number,attempted:number}>) => string | null`. Returns the topic with the most solved that is still under 5, among topics with solved or attempted above 0. Ties go to the order in `topics`. Returns `null` when nothing is started or everything is mastered.
- `nextStep(topics, masteryTopics) => { kind: "new" } | { kind: "pickup", topic: string, remaining: number } | { kind: "done" }`:
  - `"new"`: no topic at this level has activity.
  - `"done"`: every topic is mastered.
  - otherwise `"pickup"`, where `remaining` is 5 minus the solved count.
- `nextStepLine(step) => string`:
  - pickup with remaining 1: "One more bead and <topic> is mastered.";
  - pickup with more than 1: "<N in words> more beads and <topic> is mastered." Words go up to five ("Two", "Three", "Four", "Five");
  - new: "New here? Pick a topic below, or let me choose.";
  - done: "Every topic mastered at this level. Try a timed exam?"
- `liveStreak(streak: {count:number,last:string}, today: string /* YYYY-MM-DD */) => number`. Returns `count` when `last` is today or yesterday, otherwise 0.
- `showStreak(n) => boolean`: true when n is 2 or more.
- `randomTopic(topics: string[], rand = Math.random) => string`
- `PAD_LEVEL_KEYS: Record<level, string[]>`. The labels for each level, in exactly the spec's order:
  - `Common Entrance`: ["+","−","×","÷","=","½","%","$","(",")","°"]
  - `CSEC`: ["x","y","x²","√","π","=","(",")","½","°","≤","≥","sin","cos","tan","±"]
  - `Additional Maths`: ["x","xⁿ","√","π","θ","=","log","ln","sin","cos","tan","e","d/dx","∫","≤","≥"]
  - `CAPE`: ["xⁿ","√","π","θ","e","i","d/dx","∫","lim","Σ","∞","→","log","ln","∈","≠"]
- `PAD_TOPIC_KEYS: Record<topic, string[]>`. Trigonometry: ["sin","cos","tan","θ","°"]; Ratio & Proportion: [":"]; Statistics & Probability: ["x̄","Σ"]; Geometry & Mensuration: ["π","°","√"]. The builder fills in sensible sets for every other topic in `LEVEL_SETUP`; every topic must have an entry, which may be `[]`.
- `padKeys(level, topic) => string[]`: the topic's keys first, then the level's keys, with duplicates removed and the first occurrence kept. Unknown levels fall back to CSEC.
- `ALL_PAD_KEYS: string[]`: every key from every level and topic, with duplicates removed.
- `keyInsert(label) => string`:
  - "x²" → "²", "xⁿ" → "^";
  - "sin", "cos", "tan", "log", "ln" → the label plus "(";
  - "√" → "√(";
  - "d/dx" → "d/dx ", "∫" → "∫ ", "lim" → "lim ";
  - "½" → "/";
  - anything else → the label itself.

- [ ] **Step 1: Write the failing tests** in `web/home-core.test.mjs` with `node:test` and `node:assert/strict`. They must assert:
  - `masteryState`: 0 is "not-started", 1 and 2 are "attempted", 3 and 4 are "familiar", 5 and 9 are "mastered".
  - `beadCount`: 9 gives 5, -1 gives 0, `undefined` gives 0.
  - `upNext(["Algebra","Trigonometry","Statistics & Probability"], {Algebra:{solved:3,attempted:4}, "Statistics & Probability":{solved:4,attempted:4}})` is "Statistics & Probability".
  - A tie at 3 solved returns the earlier topic. Everything at 5 solved returns `null`. An empty map returns `null`.
  - `nextStep` returns `{kind:"new"}` for an empty map and `{kind:"done"}` when everything is at 5. With Algebra at 3 solved it returns `{kind:"pickup",topic:"Algebra",remaining:2}`.
  - `nextStepLine` of that step is exactly "Two more beads and Algebra is mastered."; remaining 1 gives "One more bead and Algebra is mastered."
  - `liveStreak({count:4,last:"2026-11-09"},"2026-11-09")` is 4; with last "2026-11-08" it's 4; with "2026-10-20" it's 0.
  - `showStreak`: 1 is false and 2 is true.
  - `randomTopic(["a","b","c"], () => 0.99)` is "c".
  - `padKeys("CSEC","Trigonometry")` starts with ["sin","cos","tan","θ","°"] and contains "x²" once.
  - `padKeys("Common Entrance","Ratio & Proportion")[0]` is ":".
  - `padKeys("Nope","Algebra")` equals `padKeys("CSEC","Algebra")`.
  - `keyInsert`: "sin" gives "sin(", "x²" gives "²", "xⁿ" gives "^", "√" gives "√(", "∫" gives "∫ ", "½" gives "/", "π" gives "π".
  - `ALL_PAD_KEYS` has no duplicates and includes "lim", "$" and "x̄".
- [ ] **Step 2: Run** `cd backend && npm test`. Expected: the home-core tests FAIL (cannot find module); the other suites pass.
- [ ] **Step 3: Implement** `web/home-core.mjs` with the interfaces above. End it with `if (typeof window !== "undefined") window.SumHome = { ...all exports };`. Add the script tag to `web/index.html`.
- [ ] **Step 4: Run** `cd backend && npm test`. Expected: all suites PASS.
- [ ] **Step 5: Commit:** `git add web/home-core.mjs web/home-core.test.mjs web/index.html && git commit -m "feat(home): pure logic for mastery, up next, live streak and maths pad keys"`

### Task 2: The home page in 3A layout (single column; both themes)

**Files:**
- Modify: `web/index.html`:
  - the home section markup (`#view-home`, currently lines ~688–737);
  - home CSS;
  - the `renderTopicChips` region (~2068–2090) becomes `renderTopicList`;
  - the `practiceBtn` handler (~1857);
  - `renderLevel` (~2112);
  - the level tab labels (~2006).
- Create: `e2e/home.spec.mjs`
- Modify: `e2e/levels.spec.mjs`:
  - `topicChips` becomes `page.locator("#topic-list .topic-name")`;
  - "CSEC / CXC" becomes "CSEC";
  - expectations use full topic names (e.g. "Number & Place Value", not "Number").

**Interfaces:**
- Consumes (Task 1): `window.SumHome.masteryState`, `masteryWord`, `beadCount`, `nextStep`, `nextStepLine`, `randomTopic`, `liveStreak` and `showStreak`.
- Produces:
  - `practise(topic: string): Promise<void>`. The existing practice flow (abandon the active problem, `converse(...)`, set `currentTopic`/`activeProblem`, `recordActivity`) moves into this function, given a topic. It sets `#topic` to that topic and dispatches `change` so the prefs persist.
  - `renderHome()`. It renders the header stats, next-step line, topic list and paper picker for the current level. It's called from `renderLevel()`, from `renderMastery()` and on `DOMContentLoaded`.
  - DOM:
    - `#home-stats` (with `#stat-beads` and `#stat-streak`);
    - `#home-ask` (the type form, input `#home-ask-input`);
    - `#home-draw`, `#home-say`;
    - `#next-step` (the line `#next-step-text`, and the buttons `#pickup-btn` and `#practice-btn`);
    - `#topic-list` (one `<button class="trow-home" data-topic>` per topic, containing `.topic-name`, `.beads` with 5 `<i>` elements of which earned ones have class `on`, `.mastery-word` and `.count`).

**What to build:**
- **Markup and styles:** the reference `docs/design/home-3a-string.html`, dark and light, single column at every width for now (Task 3 adds the columns and rail).
- **Removed:** the floating logo, the old h1, the steps card and the topic chips.
- **Bead fill animation:** runs once on render and is skipped when `matchMedia("(prefers-reduced-motion: reduce)")` matches.
- **Wiring:**
  - **Snap a photo:** `#snap-btn` keeps its handler.
  - **`#home-ask`:** on submit, put the trimmed text in `#input`, `goView("chat")` and submit the composer. Empty or whitespace-only text does nothing.
  - **`#home-draw`, `#home-say`:** `goView("chat")`, then `.click()` on `#sketch` or `#mic`.
  - **`#pickup-btn`:** `practise(step.topic)`. It's hidden unless the step is pickup, and its label is "Pick up <topic>".
  - **`#practice-btn`:** `practise(randomTopic(levelSetup().topics))`, with `title="I'll pick a topic at your level"`.
  - **Next step "done":** the line links to the Exam view (`#nav-practice`).
  - **Topic rows:** set `chatContext` as the chip handler did, then `practise(topic)`.
  - **Header stats:**
    - `#stat-beads` is hidden when `beadsThisWeek` is 0;
    - `#stat-streak` is hidden unless `showStreak(liveStreak(m.streak, today))`;
    - the stats themselves are real data.
- **Accessible names:** each topic row is "<topic>, <mastery word>, <n> of 5 beads". Level tabs set `aria-pressed`.

- [ ] **Step 1: Write the failing e2e tests** in `e2e/home.spec.mjs`, using the `stubTutor` helper pattern from `levels.spec.mjs`:
  - `fresh visitor sees the headline, snap button and new-student line`:
    - `h1` reads "Stuck? I got you." (whitespace-normalised);
    - `#snap-btn` is visible inside the first 844px;
    - `#next-step-text` reads "New here? Pick a topic below, or let me choose.";
    - `#pickup-btn` is hidden.
  - `progress shows beads, words and the pickup button`:
    - seed `localStorage["mathmentor.mastery.v1"]` with `{topics:{Algebra:{solved:3,attempted:4},"Statistics & Probability":{solved:4,attempted:4}},streak:{count:4,last:<today>},days:{<today>:12}}`;
    - the Statistics row has 4 `.beads i.on` and the word "Familiar";
    - `#pickup-btn` reads "Pick up Statistics & Probability";
    - `#next-step-text` reads "One more bead and Statistics & Probability is mastered.";
    - `#stat-beads` contains "12" and `#stat-streak` contains "4".
  - `tapping a topic row asks the tutor for that topic`: the stub receives a message containing "ONE CSEC practice problem on Trigonometry".
  - `Give me a problem picks a topic from the current level`: under Common Entrance, the sent message names one of that level's topics.
  - `empty type box does nothing`: submit "   ", then the chat view isn't shown and the stub received 0 messages.
  - `typing a question opens the tutor with it`: "solve 2x=8" appears as the student's message in `#chat`.
  - `switching level re-renders topics and the next step`: click CAPE, then `#topic-list .topic-name` includes "Complex Numbers & Matrices" and `#paper-pick` is hidden.
  - `long topic names stay on one row at 390px` (this test sets `viewport: {width:390,height:844}`; the config's default is Pixel 7): every `.trow-home` is no taller than 72px, and `document.documentElement.scrollWidth` equals 390.
- [ ] **Step 2: Run** `cd e2e && npx playwright test home.spec.mjs`. Expected: FAIL (elements not found).
- [ ] **Step 3: Implement** the markup, CSS, `practise`, `renderHome`, `renderTopicList` and the wiring above. Update `e2e/levels.spec.mjs` as listed under Files.
- [ ] **Step 4: Run** `cd e2e && npx playwright test`. Expected: all specs PASS, including `account.spec.mjs` and `levels.spec.mjs`.
- [ ] **Step 5: Commit:** `git add web/index.html e2e/home.spec.mjs e2e/levels.spec.mjs && git commit -m "feat(home): 3A String home page with topic bead threads and next step"`

### Task 3: Navigation rail and two-column layout

**Files:**
- Modify: `web/index.html`: header, `.appnav` CSS and markup, and layout CSS for `main`/views.
- Create: `e2e/layout.spec.mjs`

**Interfaces:**
- Consumes: the Task 2 DOM.
- Produces: the same `#nav-home`, `#nav-chat`, `#nav-string` and `#nav-practice` buttons, presented as a left rail from 768px (one nav element restyled by media query, not a duplicate). The menu and `#account-slot` stay in the header at every width.

**What to build:**
- **Rail at 768px and up:** the bottom bar is hidden.
- **Home at 1024px and up:** two columns, the stuck-student panel on the left and practice on the right, as in the reference at 1180 and 1440. Content has a max width, so it doesn't stretch on 1440px and up.
- **Tutor, String and Exam:** a readable centred column beside the rail. No other changes to those views.
- **Exam bar:** the sticky exam bar and the composer's sticky offset (`bottom: 76px`) must follow the bar: 0 when the rail is shown.

- [ ] **Step 1: Write the failing e2e tests** in `e2e/layout.spec.mjs`. Use `test.use({ viewport })` per describe block and check four sizes: 390×844, 820×1180, 1180×820 and 1440×900.
  - `bottom bar on phone, rail from tablet`:
    - at 390, `.appnav` sits at the bottom (its `boundingBox().y` is greater than 700);
    - at 820, it's at the left edge (`x` is 0, height greater than 700, width under 120).
  - `home is one column until 1024, two after`: at 820, `#snap-btn` is above `#topic-list`; at 1180, the left edge of `#topic-list` is to the right of the right edge of `#snap-btn`.
  - `no horizontal scroll at any size`: `scrollWidth` equals the viewport width at all four sizes, on home and on the chat view.
  - `composer sits at the bottom when the rail is shown`: at 820 in the chat view, the bottom of `#composer` is within 4px of 1180.
  - `menu and account slot reachable at every size`: `#menu-btn` and `#account-slot` are visible at all four sizes.
- [ ] **Step 2: Run** `cd e2e && npx playwright test layout.spec.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the media-query CSS and any needed markup wrappers (e.g. `.home-ask-col` and `.home-practice-col`).
- [ ] **Step 4: Run** `cd e2e && npx playwright test`. Expected: all PASS.
- [ ] **Step 5: Commit:** `git add web/index.html e2e/layout.spec.mjs && git commit -m "feat(layout): navigation rail from 768px and two-column home from 1024px"`

### Task 4: Live streak and four mastery words in the String view

**Files:**
- Modify: `web/index.html`: `renderString` (~2146) and the in-chat `renderMastery` streak text (~1465).
- Modify: `e2e/home.spec.mjs` (add tests).

**Interfaces:**
- Consumes (Task 1): `liveStreak`, `showStreak`, `masteryState` and `masteryWord`.

**What to build:**
- **`#string-streak`:** shows `liveStreak(m.streak, today)`.
- **String topic rows:** use `masteryWord(masteryState(t?.solved ?? 0))` instead of "mastered"/"in progress"/"not started", keeping their colour classes:
  - mastered → `s-done`;
  - attempted or familiar → `s-mid`;
  - not started → `s-new`.
- **The in-chat summary** uses `showStreak(liveStreak(...))` in place of the existing `count > 1` check.
- **`bumpStreak` is unchanged.** It already restarts at 1 on the next activity.

- [ ] **Step 1: Write the failing e2e tests:**
  - `a stale streak is hidden on home and String`: seed `streak:{count:9,last:"2026-01-01"}`; `#stat-streak` is hidden and `#string-streak` reads "0".
  - `String view uses the four mastery words`: seed Algebra with 3 solved and Trigonometry with 1 solved; String rows read "Familiar" and "Attempted".
- [ ] **Step 2: Run** `cd e2e && npx playwright test home.spec.mjs`. Expected: the 2 new tests FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run** `cd e2e && npx playwright test`. Expected: all PASS.
- [ ] **Step 5: Commit:** `git add web/index.html e2e/home.spec.mjs && git commit -m "fix(progress): streak only counts when active today or yesterday; four mastery words"`

### Task 5: Chat composer with a + menu and the level-aware maths pad

**Files:**
- Modify: `web/index.html`:
  - composer markup (`#composer`, ~781–816): remove `#mathbar`, add `#attach-btn`, `#attach-menu`, `#pad-toggle` and `#mathpad`;
  - composer CSS;
  - replace the `#mathbar` click handler (~1198).
- Create: `e2e/mathpad.spec.mjs`

**Interfaces:**
- Consumes (Task 1): `padKeys`, `ALL_PAD_KEYS` and `keyInsert`. Also `currentTopic` and `#topic`/`#level`.
- Produces, in the DOM:
  - `#attach-btn` (aria-label "Add a photo, drawing or voice", `aria-expanded`). It opens `#attach-menu`, which contains the existing `#photo`, `#sketch` and `#mic` buttons, moved inside it with their labels shown.
  - `#pad-toggle` (label "∑", aria-label "Maths keys", `aria-expanded`).
  - `#mathpad` (hidden by default). It contains `#pad-keys` (buttons with `data-ins`) and `#pad-more`, labelled "More" with `aria-expanded`, which expands to show `ALL_PAD_KEYS`.

**What to build:**
- **Composer row:** `#attach-btn`, then `#input`, then `#pad-toggle`, then `#send`.
- **`#attach-menu`:**
  - closes on Escape, on an outside click and after a choice;
  - moves focus to its first item on open, and back to `#attach-btn` on close.
- **Pad keys:**
  - `padKeys(levelSel.value, currentTopic || topicSel.value)`, re-rendered whenever the pad opens and when the level or topic changes;
  - all keys the same size, with symbols in Newsreader at one optical size;
  - clicking a key inserts `keyInsert(label)` at the cursor, the same way the old handler did, and keeps focus in `#input`.
- **Exam:** the pad stays usable during an exam.

- [ ] **Step 1: Write the failing e2e tests** in `e2e/mathpad.spec.mjs`:
  - `pad is closed by default and opens on ∑`: `#mathpad` is hidden; after clicking `#pad-toggle` it's visible and `aria-expanded` is "true".
  - `pad keys follow the level`: Common Entrance shows "$" and no "sin"; CAPE shows "lim".
  - `topic keys come first`: set the topic to Trigonometry under CSEC; the first 3 keys are "sin", "cos" and "tan".
  - `keys insert at the cursor`: type "2", click "sin", then "π"; `#input` reads "2sin(π".
  - `More shows every key`: after clicking `#pad-more`, the key count equals the length of `ALL_PAD_KEYS`, read through `page.evaluate(() => SumHome.ALL_PAD_KEYS.length)`.
  - `attach menu holds photo, draw and voice and closes on Escape`: open `#attach-btn`; `#photo`, `#sketch` and `#mic` are visible; press Escape; the menu is hidden and focus is on `#attach-btn`.
  - `composer fits a phone`: at 390px, `#input` is at least 180px wide.
- [ ] **Step 2: Run** `cd e2e && npx playwright test mathpad.spec.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** it. Search `e2e/*.spec.mjs` and `.github/smoke/smoke.mjs` for `#mathbar`, `#photo`, `#sketch` and `#mic`, and update any test that clicks them directly so it opens `#attach-btn` first.
- [ ] **Step 4: Run** `cd e2e && npx playwright test`. Expected: all PASS.
- [ ] **Step 5: Commit:** `git add web/index.html e2e/mathpad.spec.mjs e2e/*.spec.mjs && git commit -m "feat(chat): + menu and maths pad chosen by level and topic"`

### Task 6: Accessibility gate, and the PR

**Files:**
- Modify: `e2e/package.json`. Add `"@axe-core/playwright": "4.10.2"` to devDependencies, then run `npm install` so `package-lock.json` updates.
- Create: `e2e/a11y.spec.mjs`

**What to build:** one test per combination of 4 viewports (390×844, 820×1180, 1180×820, 1440×900), 2 themes and 2 states:
- **Themes:** set `localStorage["sumdeting.theme"]` to "light" or "dark" with `page.addInitScript` before load.
- **States:**
  - home, seeded with the Task 2 progress fixture;
  - chat, with the pad and the + menu open.
- **Each test** runs `new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]).analyze()` and expects `violations` to equal `[]`.
- **Plus one reduced-motion test:** with `reducedMotion: "reduce"`, the earned bead `i.on` has a computed `animation-name` of "none".

- [ ] **Step 1: Write** `e2e/a11y.spec.mjs` as above.
- [ ] **Step 2: Run** `cd e2e && npx playwright test a11y.spec.mjs`. Expected: PASS. If anything fails, fix the CSS or markup in `web/index.html` (not the test) and re-run until it passes.
- [ ] **Step 3: Run the full suites:** `cd backend && npm test` and `cd e2e && npx playwright test`. Expected: all PASS.
- [ ] **Step 4: Visual check against the references.** Run `cd e2e && npx playwright test --headed`, or take screenshots at the four sizes in both themes, and compare them with `docs/design/3a-string*.png`. Note any drift in the PR description.
- [ ] **Step 5: Commit:** `git add e2e/package.json e2e/package-lock.json e2e/a11y.spec.mjs web/index.html && git commit -m "test(a11y): axe WCAG 2.2 AA gate for home and chat in both themes"`
- [ ] **Step 6: Open the PR.**
  1. Run `gh auth status` and confirm the active account is `chrisfixesit`.
  2. Push the branch.
  3. Run `gh pr create --repo chrisfixesit/Sumdeting --base main`, with a description that covers what changed, the test evidence, and screenshots at phone and laptop size in both themes.
  4. The owner merges. Production deploys need the owner's approval.
