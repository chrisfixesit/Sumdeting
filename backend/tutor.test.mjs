import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPromptFor, SYSTEM_PROMPT } from "./tutor.mjs";

const STYLE = "Question style by level";
const asked = (content) => [{ role: "user", content }];

test("practice requests carry the question-style rules", () => {
  const p = systemPromptFor(asked("Practice mode: please give me ONE CSEC practice problem on Algebra."));
  assert.ok(p.includes(STYLE));
  assert.ok(p.startsWith(SYSTEM_PROMPT.slice(0, 200)));
});

test("other turns leave the question-style rules out", () => {
  // The long style section crowded out answer checking: with it, a wrong answer
  // followed by "give me the next one" was confirmed with ✅ in 8 of 8 runs.
  for (const content of ["3x-6+5=2x+9, so x=7. Give me the next one.", "", "practice mode please"]) {
    assert.ok(!systemPromptFor(asked(content)).includes(STYLE), content);
  }
  assert.equal(systemPromptFor(asked("x = 7")), SYSTEM_PROMPT);
});

test("only the latest message decides", () => {
  const msgs = [
    { role: "user", content: "Practice mode: please give me ONE CSEC practice problem on Algebra." },
    { role: "assistant", content: "Solve 2x + 3 = 11." },
    { role: "user", content: "x = 5, next one please" },
  ];
  assert.ok(!systemPromptFor(msgs).includes(STYLE));
});
