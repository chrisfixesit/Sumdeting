import { createRouter, parseBody } from "./http.mjs";
import { register as registerAuth } from "./auth.mjs";
import { createMemoryTable, createDynamoTable } from "./table.mjs";
import { createRepo } from "./repo.mjs";
import { createMailer } from "./email.mjs";

const PREFIX = "/api/account";
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

/** Feature modules register here; later tasks add theirs to this list. */
const MODULES = [registerAuth];

export function createAppRouter(deps) {
  const router = createRouter(deps);
  for (const register of MODULES) register(router);
  return router;
}

export function depsFromEnv(env = process.env) {
  const now = () => Date.now();
  const table = env.TABLE_NAME
    ? createDynamoTable({ tableName: env.TABLE_NAME, now })
    : createMemoryTable({ now });
  const siteUrl = env.SITE_URL ?? "";
  const dev = env.ACCOUNT_DEV === "1";
  const mailer = createMailer({
    mode: env.EMAIL_MODE ?? "memory",
    from: env.EMAIL_FROM,
    siteUrl,
  });
  return { repo: createRepo(table, { now }), mailer, now, siteUrl, secureCookies: !dev, dev };
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
      // Janitor arrives in a later task.
      const { runJanitor } = await import("./janitor.mjs");
      return runJanitor(depsFromEnv());
    }
    router ??= routerFactory();
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : event.body;
    const body = parseBody(raw);
    if (body === null) return respond(400, { error: "bad_request" });
    const rawPath = event.rawPath ?? "";
    const cookies = {};
    for (const c of event.cookies ?? []) {
      const i = c.indexOf("=");
      if (i > 0 && !(c.slice(0, i).trim() in cookies)) cookies[c.slice(0, i).trim()] = c.slice(i + 1).trim();
    }
    const res = await router({
      method: event.requestContext?.http?.method ?? "GET",
      path: rawPath.startsWith(PREFIX) ? rawPath.slice(PREFIX.length) : rawPath,
      headers: event.headers ?? {},
      cookies,
      body,
      ip: clientIp(event),
    });
    return respond(res.status, res.body, res.setCookies);
  };
}

export const handler = makeHandler(() => {
  const deps = depsFromEnv();
  deps.dev = false;
  deps.secureCookies = true;
  return createAppRouter(deps);
});
