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

test("every request reasons privately with extended thinking", async () => {
  const { requestFor } = await import("./tutor.mjs");
  const req = requestFor(asked("x = 12"), "model-id");
  // The tutor checks answers in hidden reasoning: told to keep its working out
  // of the reply without it, Haiku 4.5 called a correct bare answer wrong 10/10.
  assert.deepEqual(req.additionalModelRequestFields, { thinking: { type: "enabled", budget_tokens: 1024 } });
  // Thinking can run past its budget, and maxTokens caps thinking and reply together:
  // at 1024 + 1500 a CSEC Section II question stopped at max_tokens with an empty reply.
  assert.ok(req.inferenceConfig.maxTokens >= 1024 + 4000, "room for the reply after the thinking budget");
  assert.equal(req.inferenceConfig.temperature, undefined, "thinking requires the default temperature");
  assert.equal(req.modelId, "model-id");
});

test("only models confirmed to accept thinking are allowed", async () => {
  const { assertThinkingModel } = await import("./tutor.mjs");
  for (const ok of [
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-opus-4-5-20251101-v1:0",
  ]) assert.doesNotThrow(() => assertThinkingModel(ok), ok);
  for (const bad of [undefined, "", "us.anthropic.claude-opus-4-7", "us.anthropic.claude-3-haiku-20240307-v1:0", "amazon.nova-pro-v1:0"]) {
    assert.throws(() => assertThinkingModel(bad), /MODEL_ID/, String(bad));
  }
});

// A fake Bedrock: each call takes the next scripted reply and records its request.
function fakeBedrock(replies) {
  const requests = [];
  const send = async (command) => {
    requests.push(command.input);
    const { text, stop } = replies.shift();
    if (command.constructor.name === "ConverseStreamCommand") {
      const events = [...(text ? [{ contentBlockDelta: { delta: { text } } }] : []), { messageStop: { stopReason: stop } }];
      return { stream: (async function* () { yield* events; })() };
    }
    return { stopReason: stop, output: { message: { content: text ? [{ text }] : [] } } };
  };
  return { send, requests };
}

const CUT_OFF = { text: "", stop: "max_tokens" };

test("a reply cut off before any text is asked again without thinking", async () => {
  // Thinking can use the whole token cap on a long question and leave the student a blank reply.
  const { askTutor } = await import("./tutor.mjs");
  const { send, requests } = fakeBedrock([CUT_OFF, { text: "Solve 2x + 3 = 11.", stop: "end_turn" }]);
  assert.equal(await askTutor(asked("Practice mode: one please"), "model-id", send), "Solve 2x + 3 = 11.");
  assert.equal(requests.length, 2);
  assert.ok(requests[0].additionalModelRequestFields?.thinking);
  assert.equal(requests[1].additionalModelRequestFields, undefined);
  assert.equal(requests[1].inferenceConfig.maxTokens, 4000, "the retry has the whole cap for its reply");
});

test("a streamed reply cut off before any text is streamed again without thinking", async () => {
  const { askTutorStream } = await import("./tutor.mjs");
  const { send, requests } = fakeBedrock([CUT_OFF, { text: "Solve 2x + 3 = 11.", stop: "end_turn" }]);
  const chunks = [];
  await askTutorStream(asked("Practice mode: one please"), "model-id", (t) => chunks.push(t), send);
  assert.deepEqual(chunks, ["Solve 2x + 3 = 11."]);
  assert.equal(requests[1].additionalModelRequestFields, undefined);
  assert.equal(requests[1].inferenceConfig.maxTokens, 4000, "the retry has the whole cap for its reply");
});

test("complete replies, and replies that already have text, are not asked again", async () => {
  const { askTutor, askTutorStream } = await import("./tutor.mjs");
  for (const reply of [{ text: "Nice work ✅", stop: "end_turn" }, { text: "Partly written", stop: "max_tokens" }]) {
    const buffered = fakeBedrock([reply]);
    assert.equal(await askTutor(asked("x = 4"), "model-id", buffered.send), reply.text);
    const streamed = fakeBedrock([reply]);
    await askTutorStream(asked("x = 4"), "model-id", () => {}, streamed.send);
    assert.equal(buffered.requests.length + streamed.requests.length, 2, reply.stop);
  }
});

test("if the retry is blank too, the student gets a message instead of an empty reply", async () => {
  // An empty assistant turn would fail validation ("Empty message") on every later request.
  const { askTutor, askTutorStream, BLANK_REPLY } = await import("./tutor.mjs");
  assert.equal(await askTutor(asked("Practice mode: one please"), "model-id", fakeBedrock([CUT_OFF, CUT_OFF]).send), BLANK_REPLY);
  const chunks = [];
  await askTutorStream(asked("Practice mode: one please"), "model-id", (t) => chunks.push(t), fakeBedrock([CUT_OFF, CUT_OFF]).send);
  assert.deepEqual(chunks, [BLANK_REPLY]);
});
