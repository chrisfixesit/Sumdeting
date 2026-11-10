# SumDeTing home redesign and level-aware maths pad: design

Date: 2026-11-09
Status: approved by the owner on 2026-11-09
Reference mockups (open in a browser): `docs/design/home-3a-string.html` (home page, dark theme), `docs/design/home-3a-string-light.html` (the same page, light theme) and `docs/design/maths-pad-by-level.html` (maths pad key sets). Both home mockups are responsive. Screenshots: `docs/design/3a-string-{phone,landscape}.png` and `docs/design/3a-string-light-{phone,landscape}.png`.

## Why

SumDeTing is about to be shown publicly (the owner's LinkedIn) and used by Barbadian students aged 10–18 on cheap Android phones, school tablets (often landscape on a desk) and family laptops. Today the home page is a phone column centred on a large empty screen on tablets and laptops. It leads with the tagline and a steps card, and puts the level picker at the bottom, even though the level decides the problems and the maths keys. The chat's symbol bar shows the same nine symbols to an 11+ student and a CAPE student, at uneven sizes.

The owner went through about twenty mockups and chose one direction ("3A, String"). This document records what was chosen so it can be built without the conversation.

## Goals

1. **Home page in the 3A layout:** a stuck student reaches help in one tap, practice is one tap away, and progress is visible but secondary.
2. **Works well on every device:**
   - phone: bottom tab bar;
   - tablet portrait: left navigation rail, single column;
   - tablet landscape and laptop: rail plus two columns.
3. **Maths pad by level and topic in the tutor chat:** the keys match the student's level, the current topic's symbols come first, and **More** shows every key.
4. **WCAG 2.2 AA in both themes,** checked with axe-core (`wcag2a`, `wcag2aa`, `wcag21aa` and `wcag22aa` tags), as PR #20 was.

## Non-goals

- No changes to the String, Exam or account screens beyond what's needed so they sit correctly beside the new rail. Their content and layout stay as they are.
- No changes to the backend, prompts or tutoring behaviour.
- No new progress mechanics. Beads, streaks and per-topic counts keep coming from today's mastery store (`mathmentor.mastery.v1` via `storageKey`).

## Anti-goals (would be a failure even if it works)

- Any third-party runtime asset. The CSP is `'self'`-only, and the deploy smoke test fails on anything else. Fonts and scripts must stay self-hosted under `web/vendor/`.
- Breaking the accounts feature (#19): `#account-slot`, the profile-scoped storage keys, and the bridge used by `account-ui.mjs`.
- Generic AI-looking UI:
  - uppercase tracked eyebrow labels;
  - "→" appended to button text;
  - identical rounded cards with soft shadows;
  - decorative gradients;
  - fade-in animation on every section.
- A first phone screen (390×844) that doesn't show "Snap a photo" and the question box.

## Constraints

- **Everything lives in `web/index.html`:** vanilla JS and inline CSS. The accounts module adds `account.css` and `account-ui.mjs`.
- **Existing element IDs used by the scripts must keep working,** or the scripts must be updated in the same change:
  - `practice-btn`, `snap-btn`, `level-tabs`, `topic-grid`, `paper-pick`/`paper-tabs`;
  - the hidden `#level`/`#topic`/`#exam-duration` selects, which are the source of truth;
  - `mathbar`, `nav-*`, `menu`, `theme`, `account-slot`.
- **The paper picker (#28) must still appear for levels that have papers.** It is `#paper-pick`, shown when `levelSetup().papers` exists. In 3A it sits under the level picker in the practice column.
- **Self-hosted fonts:** Fraunces (variable weight 100–900 and opsz) and Space Grotesk (300–700). The mockup asks for Fraunces's `SOFT` axis, which the vendored file may not include. If it doesn't, drop `SOFT` and don't add a font file just for it.
- **The light theme exists** (menu, "Dark mode"/"Light mode" toggle) and must keep working. The home page and the maths pad are designed for both themes (see Colours and type).

## What was decided (owner's choices)

### Home page: layout 3A "String"

Build it to match `docs/design/home-3a-string.html`.

**Left column (the stuck-student panel, first on phone)**
1. **Headline in Fraunces, two lines:** "Stuck?" / "I got you." (owner's wording). Large: about 50px on phone, 68px on tablet portrait, 62px on tablet landscape and 76px on laptop.
2. **Sub-line:** "I guide you to the answer, bead by bead. I never hand it over."
3. **Snap a photo:** a full-width gold button with a camera icon, label "Snap a photo" and a second line "of the question in your book". It's the only solid gold button on the page. It does what `#snap-btn` does today, opening the camera/file picker into the tutor.
4. **Type box:** placeholder "Or type it, like 3/4 of 120", with a submit button. Submitting goes to the tutor with that text, the same as typing in the chat composer.
5. **Draw it and Say it buttons:** the same actions as the chat's sketch and mic buttons, opening the tutor.

**Right column (practice; below the panel on phone)**
1. **"Practise a topic" heading.**
2. **Level picker:** Common Entrance, CSEC, Additional Maths, CAPE. A 2×2 grid on phone (all four visible, no sideways scrolling) and one row from tablet up.
3. **Paper picker** (only for levels that have papers).
4. **Next-step line,** for example "Two more beads and Algebra is mastered.", with a gold-outlined "Pick up Algebra" button and a "Give me a problem" button (today's `#practice-btn`).
5. **Topic list, one row per topic of the selected level:**
   - the topic name;
   - a thread of five small beads (gold for earned, outlined for still to earn);
   - the mastery word;
   - the count, "3 of 5".
   - Rows are separated by hairlines, with no boxes. Tapping a row starts practice in that topic, as tapping a topic chip does today. The "up next" topic gets a gold left edge and an "Up next" tag.
   - On load, earned beads fill gold along each thread once. This is the page's only animation, and it's off under `prefers-reduced-motion`.
   - The mastery word must not wrap onto two lines on tablet. The reference mockup wraps "Not started" at 1180px wide; fix this.

**Header:** the wordmark, then "12 beads this week" and "4-day streak" from real data. Hide each stat when it's zero or there's no data.

**Footer:** "Made in Barbados. Built with Claude on Amazon Bedrock. Source on GitHub" (link to https://github.com/chrisfixesit/Sumdeting).

**Removed from the home page:** the floating logo, the old tagline h1, the steps card and the topic chips. The topic list replaces the chips.

### Navigation by screen width

- **Below 768px:** the bottom tab bar, as today.
- **768px and up:** a left rail with the same four destinations (Home, Tutor, String, Exam), the same IDs and the same behaviour; the bottom bar is hidden. The menu (read aloud, session recap, new session, theme) and `#account-slot` stay reachable from the header at every width.
- **Below 1024px:** the home page is one column.
- **1024px and up:** two columns (the stuck-student panel left, practice right), with content held to a comfortable maximum width on large screens.
- **Other views (Tutor, String, Exam):** use the rail at 768px and up, with their content in a readable centred column. They need no redesign, just no stretching.

### Colours and type

Both themes follow the operating-system setting, and the student can switch in the menu, as today. The owner chose to have both themes designed rather than force dark.

- **Dark theme:** the tokens already on `main` (#20): navy `#0A1A3D`, raised navy `#112554`, line `#1F3670`, cream text `#F4EEE0`, muted `#A9B3CF`, gold `#F4C143` with navy text on it.
  - Beads: resting outline `#5B6D9E` (at least 3:1 on navy); earned bead gold.
  - Selected level: cream with navy text.
  - Pick up and the Up next edge/tag: gold.
- **Light theme** (matches `home-3a-string-light.html`, measured):
  - Surfaces:
    - page cream `#F4EEE0`;
    - raised `#FBF7EC`;
    - line `#E1D8C1`;
    - wash `#EAE2CF`.
  - Text:
    - ink `#15181E` (15.4:1 on the page);
    - body `#3A3A34`;
    - muted `#5E5A4C` (6.0:1 on the page, 5.35:1 on wash).
  - Royal blue `#0B39A8`, with white text on it (9.7:1). It's used for Pick up (outlined), the Up next edge and tag, links and focus rings.
  - Snap a photo: a gold `#F4A900` fill with ink text (8.9:1) and a `#C98A00` bottom edge. It's the one solid gold button in both themes.
  - Earned bead: deep amber `#A86B00` (3.8:1 on the page) with a decorative `#FFE9AE` highlight.
  - Resting bead outline and field border: `#857E6C` (3.5:1).
  - Selected level: an ink chip with cream text.
  - Soft borders on secondary buttons: `#CFC5AC`. These are decorative; the button text carries the meaning.
- **Type:**
  - Fraunces for the headline, section titles and counts;
  - Space Grotesk for the UI.

### Maths pad in the tutor chat

This replaces today's always-visible `#mathbar` row. The full sets are in `docs/design/maths-pad-by-level.html`.

- **Composer:** the text box gets a **∑** toggle beside it. It opens a pad of keys under the composer and closes it again. The pad is closed by default, so the chat keeps its space.
- **Base keys by level (in this order):**
  - **Common Entrance:** + − × ÷ = ½ % $ ( ) °
  - **CSEC:** x y x² √ π = ( ) ½ ° ≤ ≥ sin cos tan ±
  - **Additional Maths:** x xⁿ √ π θ = log ln sin cos tan e d/dx ∫ ≤ ≥
  - **CAPE:** xⁿ √ π θ e i d/dx ∫ lim Σ ∞ → log ln ∈ ≠
- **Topic first:** the current topic's keys move to the front of the base set. Examples:
  - Trigonometry: sin cos tan θ °;
  - Ratio & Proportion: : (colon);
  - Statistics & Probability: x̄ Σ;
  - Geometry & Mensuration: π ° √.
- **More:** opens every key from all levels in a grid.
- **Behaviour:** keys insert their text at the cursor in the chat text box, as `data-ins` does today. Every key is the same size, and the symbols render at one consistent optical size.

### Settled after the builder check (designer's calls, marked so the owner can check them)

- **Composer row (from the approved pad mockup):** the chat row becomes **+ / text box / ∑ / send**.
  - **+** opens a small menu with Snap a photo, Draw it and Say it. It keeps today's `#photo`, `#sketch` and `#mic` behaviour, has proper focus handling and closes on Escape.
  - The home page's Draw it and Say it buttons open the tutor and trigger the same actions directly, without going through the menu.
- **Home buttons:**
  - **"Pick up <topic>"** practises the up-next topic.
  - **"Give me a problem"** practises a topic chosen at random from the selected level. Its sub-text or tooltip says so ("I'll pick a topic at your level").
  - **Topic row:** tapping a row sets `#topic` and practises that topic. `#topic` stays the saved source of truth, as today.
- **Empty and edge states:**
  - *No progress at this level (including first visits):* hide the next-step line and the Pick up button, and show "New here? Pick a topic below, or let me choose." beside Give me a problem.
  - *Every topic mastered:* the line reads "Every topic mastered at this level. Try a timed exam?" and links to Exam.
  - The header stats hide when there's no data.
- **Streak:** count it as live only when the last activity was today or yesterday; otherwise treat it as 0. Show it only when it's 2 or more, matching today's in-chat summary. Apply the same rule in the String view, which fixes the stale-streak display there too.
- **Maths pad topic:** the current topic is the topic of the practice problem in progress (`currentTopic`) when there is one, otherwise the saved `#topic`.
- **Maths pad inserted text:**
  - most keys insert their own symbol;
  - x² → "²", xⁿ → "^";
  - sin, cos, tan, log, ln → the name plus "(";
  - √ → "√(";
  - d/dx → "d/dx ", ∫ → "∫ ", lim → "lim ";
  - x̄ → "x̄";
  - ½ → "/" (a fraction slash).

## Left to the builder

- Exact pixel spacing, and the type scale between the sizes given above.
- How the rail looks, within the 3A style.
- Mastery words: today's code has three states (`mastered` at 5 solved, `in progress`, `not started`). The design uses four: Not started (0), Attempted (1–2), Familiar (3–4) and Mastered (5), based on solved count capped at 5. *Builder's call (the designer proposed this).* Keep the String view consistent with it.
- The "up next" rule: suggested as the started topic closest to mastery (most solved under 5, ties go to the most recent), falling back to the first topic. *Builder's call.*
- Whether the old steps card returns anywhere (for example a first-visit hint). Default: drop it.
- Full topic-first key sets for the topics not listed above.

## Open questions for the owner

None. The builder check raised one owner question, about light mode; the owner chose a matching light design, recorded above. The other four answers are marked as designer's calls under "Settled after the builder check".
