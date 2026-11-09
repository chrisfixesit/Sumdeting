import { askTutor, askTutorStream, assertThinkingModel, validateMessages } from "./tutor.mjs";

const MODEL_ID = process.env.MODEL_ID;
// Fail at cold start, not on every request, if the model cannot think.
assertThinkingModel(MODEL_ID);

const parseEvent = (event) => {
  if (event.requestContext?.http?.method !== "POST") {
    return { error: "Method not allowed", status: 405 };
  }
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : (event.body ?? "");
    const payload = JSON.parse(raw);
    const validationError = validateMessages(payload?.messages);
    if (validationError) return { error: validationError, status: 400 };
    return { messages: payload.messages };
  } catch {
    return { error: "Invalid JSON body", status: 400 };
  }
};

/**
 * Streaming handler (Function URL invoke_mode = RESPONSE_STREAM).
 * Falls back to a buffered JSON handler outside the Lambda runtime
 * (the `awslambda` global only exists inside Lambda).
 */
export const handler = globalThis.awslambda
  ? awslambda.streamifyResponse(async (event, responseStream) => {
      const parsed = parseEvent(event);

      if (parsed.error) {
        const stream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: parsed.status,
          headers: { "Content-Type": "application/json" },
        });
        stream.write(JSON.stringify({ error: parsed.error }));
        stream.end();
        return;
      }

      const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });

      try {
        await askTutorStream(parsed.messages, MODEL_ID, (text) => stream.write(text));
      } catch (err) {
        console.error("Bedrock invocation failed", err);
        stream.write("\n\n[MathMentor hit a snag; please send that again.]");
      }
      stream.end();
    })
  : async (event) => {
      const parsed = parseEvent(event);
      if (parsed.error) {
        return {
          statusCode: parsed.status,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: parsed.error }),
        };
      }
      try {
        const reply = await askTutor(parsed.messages, MODEL_ID);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply }),
        };
      } catch (err) {
        console.error("Bedrock invocation failed", err);
        return {
          statusCode: 502,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Model invocation failed" }),
        };
      }
    };
