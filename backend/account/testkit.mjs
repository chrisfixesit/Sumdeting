import { createMemoryTable } from "./table.mjs";
import { createRepo } from "./repo.mjs";
import { createMailer } from "./email.mjs";
import { createAppRouter } from "./index.mjs";

export function makeApp({ now, dev = false, start = Date.UTC(2026, 0, 1, 12), signinIpLimit } = {}) {
  const clock = { t: start };
  const clockNow = now ?? (() => clock.t);
  const table = createMemoryTable({ now: clockNow });
  const repo = createRepo(table, { now: clockNow });
  const mailer = createMailer({ mode: "memory", from: "no-reply@example.com", siteUrl: "https://sumdeting.test" });
  const router = createAppRouter({
    repo,
    mailer,
    now: clockNow,
    siteUrl: "https://sumdeting.test",
    secureCookies: true,
    dev,
    ...(signinIpLimit ? { signinIpLimit } : {}),
  });
  const jar = {};
  async function call(method, path, body = {}, { cookie, ip = "203.0.113.1" } = {}) {
    const cookies = cookie !== undefined ? cookie : { ...jar };
    const res = await router({ method, path, headers: {}, cookies, body, ip });
    for (const line of res.setCookies ?? []) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (attrs.some((a) => /^Max-Age=0$/i.test(a)) || value === "") delete jar[name];
      else jar[name] = value;
    }
    return res;
  }
  return { call, outbox: mailer.outbox, repo, clock, jar, table, mailer, router };
}
