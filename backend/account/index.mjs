import { createRouter, parseBody, parseCookies } from "./http.mjs";
import { register as registerAuth } from "./auth.mjs";
import { register as registerProfiles } from "./profiles.mjs";
import { register as registerSync } from "./sync.mjs";
import { register as registerParent } from "./parent.mjs";
import { register as registerLinks } from "./links.mjs";
import { register as registerDeletion } from "./deletion.mjs";
import { createMemoryTable, createDynamoTable } from "./table.mjs";
import { createRepo } from "./repo.mjs";
import { createMailer } from "./email.mjs";

const PREFIX = "/api/account";
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

/** Feature modules register here; later tasks add theirs to this list. */
const MODULES = [registerAuth, registerProfiles, registerSync, registerParent, registerLinks, registerDeletion];

export function createAppRouter(deps) {
  const router = createRouter(deps);
  for (const register of MODULES) register(router);
  return router;
}

// Per hour per client IP. Schools and families share one address behind NAT (ruling R20).
const SIGNIN_IP_LIMIT = 300;

export function depsFromEnv(env = process.env) {
  const now = () => Date.now();
  const table = env.TABLE_NAME
    ? createDynamoTable({ tableName: env.TABLE_NAME, now })
    : createMemoryTable({ now });
  const siteUrl = env.SITE_URL ?? "";
  const dev = env.ACCOUNT_DEV === "1";
  // Without SES, only dev mode may "send" (to the readable outbox). Otherwise mail is off and
  // sign-in says so (503 email_unavailable) rather than claiming an email went out.
  const mailer = createMailer({
    mode: env.EMAIL_MODE || (dev ? "memory" : "off"),
    from: env.EMAIL_FROM,
    siteUrl,
  });
  // The e2e dev server can raise it further; production ignores SIGNIN_IP_LIMIT.
  const raised = Number.parseInt(env.SIGNIN_IP_LIMIT ?? "", 10);
  const signinIpLimit = dev && raised > 0 ? raised : SIGNIN_IP_LIMIT;
  return { repo: createRepo(table, { now }), mailer, now, siteUrl, secureCookies: !dev, dev, signinIpLimit };
}

/** Client IP from CloudFront's viewer address (ip:port, IPv6 allowed), else the Function URL source IP. */
export function clientIp(event) {
  const viewer = event.headers?.["cloudfront-viewer-address"];
  if (viewer) {
    const stripped = viewer.replace(/:\d+$/, "");
    if (stripped) return stripped;
  }
  return event.requestContext?.http?.sourceIp ?? "unknown";
}

const respond = (statusCode, body, cookies) => ({
  statusCode,
  headers: { ...JSON_HEADERS },
  ...(cookies?.length ? { cookies } : {}),
  body: JSON.stringify(body),
});

export function makeHandler(routerFactory) {
  let router;
  return async function handler(event) {
    if (event.source === "aws.scheduler" || event.janitor === true) {
      const { runJanitor } = await import("./deletion.mjs");
      const result = await runJanitor(lambdaDepsFromEnv());
      // Counts only (no ids or emails), so a restore can be checked against the history.
      console.log("Janitor finished", JSON.stringify(result));
      return result;
    }
    router ??= routerFactory();
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : event.body;
    const body = parseBody(raw);
    if (body === null) return respond(400, { error: "bad_request" });
    const rawPath = event.rawPath ?? "";
    const cookies = parseCookies((event.cookies ?? []).join("; "));
    const res = await router({
      method: event.requestContext?.http?.method ?? "GET",
      path: rawPath.startsWith(PREFIX) ? rawPath.slice(PREFIX.length) : rawPath,
      headers: event.headers ?? {},
      cookies,
      body,
      hasBody: typeof raw === "string" && raw.length > 0,
      ip: clientIp(event),
    });
    return respond(res.status, res.body, res.setCookies);
  };
}

export function lambdaDepsFromEnv(env = process.env) {
  for (const name of ["TABLE_NAME", "SITE_URL", "EMAIL_FROM"]) {
    if (!env[name]) throw new Error(`Missing required environment variable ${name}`);
  }
  if (env.EMAIL_MODE !== "ses") throw new Error("EMAIL_MODE must be 'ses' in Lambda");
  const deps = depsFromEnv({ ...env, ACCOUNT_DEV: "0" });
  deps.dev = false;
  deps.signinIpLimit = SIGNIN_IP_LIMIT;
  deps.secureCookies = true;
  return deps;
}

export const handler = makeHandler(() => createAppRouter(lambdaDepsFromEnv()));
