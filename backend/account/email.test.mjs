import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailer } from "./email.mjs";

const SITE = "https://sumdeting.example";
const VARS = {
  signin: { token: "tok123", code: "042917" },
  parent_code: { code: "123456" },
  confirm_delete: { code: "654321" },
  consent_request: { token: "tok123", childFirstName: "Amara" },
  share: { token: "tok123", studentFirstName: "Amara" },
  access_request: { token: "tok123", parentEmail: "mum@example.com" },
  guardian_invite: { token: "tok123", childFirstName: "Amara", inviterEmail: "dad@example.com" },
  retention_warning: { token: "tok123" },
};

function mailer() {
  return createMailer({ mode: "memory", from: "SumDeTing <no-reply@x.example>", siteUrl: SITE + "/" });
}

test("signin email contains fragment link and code", async () => {
  const m = mailer();
  await m.send("signin", "a@b.com", VARS.signin);
  const e = m.outbox[0];
  assert.equal(e.to, "a@b.com");
  assert.ok(e.text.includes(`${SITE}/#signin=tok123`));
  assert.ok(e.text.includes("042917"));
  assert.ok(e.html.includes("042917"));
  assert.ok(e.text.includes("15 minutes"));
});

test("every kind includes privacy link and sign-off", async () => {
  const m = mailer();
  for (const [kind, vars] of Object.entries(VARS)) {
    await m.send(kind, "a@b.com", vars);
    const e = m.outbox.at(-1);
    assert.equal(e.kind, kind);
    assert.ok(e.text.includes(`${SITE}/privacy.html`), kind);
    assert.ok(e.html.includes(`${SITE}/privacy.html`), kind);
    assert.ok(e.text.includes("SumDeTing"), kind);
    if (vars.token) assert.ok(e.text.includes(`${SITE}/#signin=tok123`), kind);
  }
});

test("emails contain no emoji", async () => {
  const m = mailer();
  for (const [kind, vars] of Object.entries(VARS)) {
    await m.send(kind, "a@b.com", vars);
    const e = m.outbox.at(-1);
    for (const part of [e.subject, e.text, e.html]) {
      assert.doesNotMatch(part, /\p{Extended_Pictographic}/u, kind);
    }
  }
});

test("consent_request names the child", async () => {
  const m = mailer();
  await m.send("consent_request", "p@b.com", VARS.consent_request);
  const e = m.outbox[0];
  assert.ok(e.subject.includes("Amara"));
  assert.ok(e.text.includes("Amara wants to use SumDeTing. Approve saving their practice progress?"));
});

test("html escapes user-supplied values", async () => {
  const m = mailer();
  await m.send("share", "a@b.com", { token: "t", studentFirstName: "<script>x</script>" });
  assert.ok(!m.outbox[0].html.includes("<script>"));
  assert.ok(m.outbox[0].html.includes("&lt;script&gt;"));
});

test("unknown kind throws", async () => {
  await assert.rejects(() => mailer().send("nope", "a@b.com", {}));
});

test("ses mode sends via injected client with Content.Simple", async () => {
  const sent = [];
  const m = createMailer({
    mode: "ses",
    from: "x@y.com",
    siteUrl: SITE,
    sesClient: { send: async (cmd) => sent.push(cmd) },
  });
  await m.send("parent_code", "a@b.com", VARS.parent_code);
  assert.equal(sent.length, 1);
  const input = sent[0].input;
  assert.equal(input.FromEmailAddress, "x@y.com");
  assert.deepEqual(input.Destination.ToAddresses, ["a@b.com"]);
  assert.ok(input.Content.Simple.Body.Text.Data.includes("123456"));
  assert.ok(input.Content.Simple.Body.Html.Data.includes("123456"));
});
