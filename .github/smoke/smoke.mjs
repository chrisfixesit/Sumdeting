/**
 * Post-deploy smoke test for SumDeTing (https://sumdeting.246labs.cloud).
 *
 * Catches the class of failure that has bitten this site twice: frontend
 * assets silently failing to load (CDN 503s, bad SRI hashes, CSP blocks),
 * which breaks math rendering with no server-side error to alarm on.
 *
 * Run after every `tofu apply` (and nightly via cron):
 *   BASE_URL=https://sumdeting.246labs.cloud node .github/smoke/smoke.mjs
 *
 * Requires: npm i playwright && npx playwright install --with-deps chromium
 */
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const BASE_URL = (process.env.BASE_URL ?? "https://sumdeting.246labs.cloud").replace(/\/$/, "");
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const failedRequests = [];
  page.on("requestfailed", (r) => failedRequests.push(`${r.url()} (${r.failure()?.errorText})`));
  const badResponses = [];
  page.on("response", (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

  const resp = await page.goto(BASE_URL + "/", { waitUntil: "networkidle", timeout: 45000 });

  // 1. Page + security headers
  check("page loads (200)", resp.status() === 200, `status ${resp.status()}`);
  const headers = resp.headers();
  check("CSP header present", !!headers["content-security-policy"]);
  // Every fetch directive must allow only 'self' (plus the inline/data/blob
  // allowances the page needs); any host, scheme or wildcard source fails.
  const csp = headers["content-security-policy"] ?? "";
  const ALLOWED = new Set(["'self'", "'unsafe-inline'", "'none'", "data:", "blob:"]);
  const badSources = csp.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0])
    .flatMap(([, ...srcs]) => srcs.filter((src) => !ALLOWED.has(src)));
  check("CSP allows only 'self'", /(^|;)\s*default-src 'self'\s*(;|$)/.test(csp) && badSources.length === 0,
    badSources.join(" ") || csp.slice(0, 80));
  check("HSTS header present", !!headers["strict-transport-security"]);
  check("nosniff header present", headers["x-content-type-options"] === "nosniff");

  // 2. Libraries actually executed (SRI/CSP/404 failures leave these undefined)
  const libs = await page.evaluate(() => ({
    katex: typeof katex !== "undefined" ? katex.version : null,
    autoRender: typeof renderMathInElement === "function",
    marked: typeof marked !== "undefined",
    dompurify: typeof DOMPurify !== "undefined",
  }));
  check("KaTeX loaded", !!libs.katex, `version ${libs.katex}`);
  check("KaTeX auto-render loaded", libs.autoRender);
  check("marked loaded", libs.marked);
  check("DOMPurify loaded", libs.dompurify);

  // 3. Math really renders
  const mathRenders = await page.evaluate(() => {
    try { return katex.renderToString("x^2 + \\frac{1}{2}").includes("katex"); } catch { return false; }
  });
  check("KaTeX renders an expression", mathRenders);

  // 4. Brand fonts really loaded (document.fonts has real FontFace entries)
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const fams = new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/['"]/g, "")));
    return [...fams];
  });
  check("Fraunces font loaded", fonts.includes("Fraunces"), `loaded: ${fonts.join(", ") || "none"}`);
  check("Space Grotesk font loaded", fonts.includes("Space Grotesk"));

  // 5. Fresh-session UI state
  const chipsHidden = await page.evaluate(() => {
    const c = document.getElementById("chips");
    return !c || getComputedStyle(c).display === "none";
  });
  check("quick-reply chips hidden on fresh session", chipsHidden);

  // 6. API end-to-end (one tiny Bedrock call; also exercises the OAC sha256 path)
  const api = await page.evaluate(async (base) => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "What is 2 + 2? (smoke test — reply in one short sentence)" }] });
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await fetch(base + "/api", {
      method: "POST",
      headers: { "content-type": "application/json", "x-amz-content-sha256": digest },
      body,
    });
    const text = await r.text();
    // The backend reports Bedrock failures in-stream with HTTP 200
    return { status: r.status, len: text.length, snag: /hit a snag/i.test(text) };
  }, BASE_URL);
  check("/api streams a reply", api.status === 200 && api.len > 0 && !api.snag,
    `status ${api.status}, ${api.len} chars${api.snag ? ", model error in stream" : ""}`);

  // 6b. Accounts: privacy page, account endpoint, account UI module
  const priv = await page.request.get(BASE_URL + "/privacy.html");
  check("privacy page loads (200)", priv.status() === 200, `status ${priv.status()}`);

  const acctBody = "{}";
  const acctRes = await page.request.post(BASE_URL + "/api/account/me", {
    headers: {
      "content-type": "application/json",
      "x-amz-content-sha256": createHash("sha256").update(acctBody).digest("hex"),
    },
    data: acctBody,
  });
  const acctJson = await acctRes.json().catch(() => null);
  check("account endpoint reachable", acctRes.status() === 401 && acctJson?.error === "not_signed_in",
    `status ${acctRes.status()} ${JSON.stringify(acctJson)}`);

  const slotHasButton = await page.waitForSelector("#account-slot button", { timeout: 10000 }).then(() => true, () => false);
  check("account-ui.mjs loaded", slotHasButton);

  // 7. No asset failures during load
  // An anonymous visit probes /api/account/me and gets an expected 401; ignore it here.
  const relevantBad = badResponses.filter((u) => !u.includes("favicon") && !/^401 .*\/api\/account\/me$/.test(u));
  check("no failed asset requests", failedRequests.length === 0 && relevantBad.length === 0,
    [...failedRequests, ...relevantBad].slice(0, 3).join(" | "));
  const realErrors = consoleErrors.filter((m) => !/status of 401/.test(m));
  check("no console errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
