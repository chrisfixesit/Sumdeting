import { httpError } from "./http.mjs";
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const IGNORE = "If you didn't ask for this, you can ignore this email.";

// Each template returns { subject, why, body: string[], link?: string, linkLabel?, code?, ignore }
const TEMPLATES = {
  signin: ({ code }) => ({
    subject: "Your SumDeTing sign-in link",
    why: "You're getting this because someone asked to sign in to SumDeTing with this email.",
    body: ["Use the link below to sign in, or enter the code on the sign-in screen. Both are valid for 15 minutes."],
    linkLabel: "Sign in to SumDeTing",
    code,
    ignore: true,
  }),
  parent_code: ({ code }) => ({
    subject: "Your SumDeTing parent section code",
    why: "You're getting this because someone asked to open the parent section of SumDeTing with this email.",
    body: ["Enter this code to open the parent section. It is valid for 10 minutes."],
    code,
    ignore: true,
  }),
  confirm_delete: ({ code }) => ({
    subject: "Confirm deleting your SumDeTing data",
    why: "You're getting this because someone asked to delete a SumDeTing account or its progress with this email.",
    body: ["Enter this code to confirm the deletion. It is valid for 10 minutes. Deleting cannot be undone."],
    code,
    ignore: true,
  }),
  consent_request: ({ childFirstName }, sv) => ({
    subject: `${sv.childFirstName} wants to use SumDeTing`,
    why: "You're getting this because a child entered your email as their parent or guardian.",
    body: [
      `${childFirstName} wants to use SumDeTing. Approve saving their practice progress?`,
      `SumDeTing asks a parent or guardian to approve because ${childFirstName} said they are under 13. The link below signs you in so you can approve or decline.`,
    ],
    linkLabel: "Review and decide",
    ignore: true,
  }),
  share: ({ studentFirstName }, sv) => ({
    subject: `${sv.studentFirstName} wants to share their SumDeTing progress with you`,
    why: "You're getting this because a student chose to share their practice progress with this email.",
    body: [`${studentFirstName} wants to share their SumDeTing progress with you. Use the link below to sign in and see it.`],
    linkLabel: "Sign in to see progress",
    ignore: true,
  }),
  access_request: ({ parentEmail }, sv) => ({
    subject: "Someone would like to see your SumDeTing progress",
    why: "You're getting this because someone asked for access to your SumDeTing practice progress.",
    body: [
      `${parentEmail} would like to see your SumDeTing practice progress.`,
      "You can allow or decline this in the app. Use the link below to sign in.",
    ],
    linkLabel: "Sign in to respond",
    ignore: true,
  }),
  guardian_invite: ({ childFirstName, inviterEmail }, sv) => ({
    subject: `You've been added as a parent or guardian for ${sv.childFirstName}`,
    why: "You're getting this because someone added this email as a parent or guardian on SumDeTing.",
    body: [
      `${inviterEmail} has added you as a parent or guardian for ${childFirstName} on SumDeTing.`,
      "Use the link below to sign in and see their practice progress.",
    ],
    linkLabel: "Sign in to SumDeTing",
    ignore: true,
  }),
  retention_warning: () => ({
    subject: "Your SumDeTing account will be deleted in 30 days",
    why: "You're getting this because your SumDeTing account has not been used for nearly two years.",
    body: [
      "Your account will be deleted in 30 days. Signing in keeps it. Use the link below to sign in.",
    ],
    linkLabel: "Sign in to keep my account",
    ignore: false,
  }),
};

const LINK_VALIDITY = {
  consent_request: "7 days",
  share: "7 days",
  access_request: "7 days",
  guardian_invite: "7 days",
  retention_warning: "30 days",
};

const REQUIRED = {
  signin: ["token", "code"],
  parent_code: ["code"],
  confirm_delete: ["code"],
  consent_request: ["token"],
  share: ["token"],
  access_request: ["token"],
  guardian_invite: ["token"],
  retention_warning: ["token"],
};

// Collapse control characters (incl. CR/LF) to a space and cap length, for subject lines.
const subjectSafe = (v) =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 80);

function render(kind, vars, siteUrl) {
  const make = TEMPLATES[kind];
  if (!make) throw new Error(`Unknown email kind: ${kind}`);
  for (const key of REQUIRED[kind]) {
    if (typeof vars[key] !== "string" || !vars[key]) {
      throw new Error(`Email kind ${kind} requires ${key}`);
    }
  }
  const sv = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, subjectSafe(v)]));
  const t = make(vars, sv);
  if (LINK_VALIDITY[kind]) {
    t.body = [...t.body, `This link works for ${LINK_VALIDITY[kind]} and can only be used once.`];
  }
  const link = vars.token ? `${siteUrl}/#signin=${vars.token}` : null;
  const privacy = `${siteUrl}/privacy.html`;

  const text = [
    ...t.body,
    ...(link ? [`${t.linkLabel}: ${link}`] : []),
    ...(t.code ? [`Your code: ${t.code}`] : []),
    t.why,
    ...(t.ignore ? [IGNORE] : []),
    `Privacy: ${privacy}`,
    "— SumDeTing",
  ].join("\n\n");

  const p = (s) => `<p style="margin:0 0 16px">${esc(s)}</p>`;
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:480px">',
    ...t.body.map(p),
    ...(link
      ? [`<p style="margin:0 0 16px"><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#1a5fb4;color:#fff;text-decoration:none;border-radius:6px">${esc(t.linkLabel)}</a></p>`]
      : []),
    ...(t.code
      ? [`<p style="margin:0 0 16px;font-size:28px;letter-spacing:4px;font-weight:bold">${esc(t.code)}</p>`]
      : []),
    `<p style="margin:0 0 8px;font-size:14px;color:#555">${esc(t.why)}${t.ignore ? " " + esc(IGNORE) : ""}</p>`,
    `<p style="margin:0 0 16px;font-size:14px;color:#555"><a href="${esc(privacy)}">Privacy</a></p>`,
    `<p style="margin:0">&mdash; SumDeTing</p>`,
    "</div>",
  ].join("\n");

  return { subject: t.subject, text, html };
}

function checkTo(to) {
  if (typeof to !== "string" || !to || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(to)) {
    throw new Error("Invalid recipient address");
  }
}

export function createMailer({ mode, from, siteUrl, sesClient } = {}) {
  const base = String(siteUrl ?? "").replace(/\/+$/, "");
  if (mode === "ses") {
    let client = sesClient;
    let Command;
    return {
      async send(kind, to, vars = {}) {
        checkTo(to);
        const { subject, text, html } = render(kind, vars, base);
        if (!Command) {
          ({ SendEmailCommand: Command } = await import("@aws-sdk/client-sesv2"));
        }
        if (!client) {
          const { SESv2Client } = await import("@aws-sdk/client-sesv2");
          client = new SESv2Client({});
        }
        await client.send(
          new Command({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
              Simple: {
                Subject: { Data: subject, Charset: "UTF-8" },
                Body: {
                  Text: { Data: text, Charset: "UTF-8" },
                  Html: { Data: html, Charset: "UTF-8" },
                },
              },
            },
          })
        );
      },
    };
  }
  if (mode === "off") {
    return {
      async send() {
        throw httpError("email_unavailable");
      },
    };
  }
  const outbox = [];
  return {
    outbox,
    async send(kind, to, vars = {}) {
      checkTo(to);
      const { subject, text, html } = render(kind, vars, base);
      outbox.push({ kind, to, subject, text, html });
    },
  };
}
