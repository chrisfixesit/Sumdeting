/**
 * Container entrypoint: serves the static web app and exposes the tutor API
 * at POST /api/chat, reusing the exact same logic as the Lambda handler.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { askTutorStream, assertThinkingModel, validateMessages } from "./backend/tutor.mjs";
import { createAppRouter, depsFromEnv } from "./backend/account/index.mjs";
import { parseBody, parseCookies } from "./backend/account/http.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const MODEL_ID = process.env.MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
assertThinkingModel(MODEL_ID);

const root = path.dirname(fileURLToPath(import.meta.url));
// Point the frontend at the container's own API route
const indexHtml = readFileSync(path.join(root, "web/index.html"), "utf-8").replace(
  "%%API_URL%%",
  "/api/chat"
);

const json = (res, statusCode, body) => {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const ACCOUNT_PREFIX = "/api/account";
const ACCOUNT_BODY_LIMIT = 64 * 1024;

const accountJson = (res, status, body, setCookies) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (setCookies?.length) headers["Set-Cookie"] = setCookies;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
};

function handleAccount(accountRouter, req, res) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > ACCOUNT_BODY_LIMIT) {
      tooLarge = true;
      chunks.length = 0;
      res.setHeader("Connection", "close");
      res.on("finish", () => req.destroy());
      accountJson(res, 413, { error: "bad_request" });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", async () => {
    if (tooLarge) return;
    try {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body = parseBody(raw);
      if (body === null) return accountJson(res, 400, { error: "bad_request" });
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
      } catch {
        return accountJson(res, 400, { error: "bad_request" });
      }
      const out = await accountRouter({
        method: req.method,
        path: pathname.slice(ACCOUNT_PREFIX.length),
        headers: req.headers,
        cookies: parseCookies(req.headers.cookie),
        body,
        hasBody: raw.length > 0,
        // The container serves the page itself, so its own host is the only allowed origin.
        allowedOrigins: req.headers.host ? [`http://${req.headers.host}`, `https://${req.headers.host}`] : undefined,
        ip: req.socket.remoteAddress ?? "unknown",
      });
      accountJson(res, out.status, out.body, out.setCookies);
    } catch (err) {
      console.error("Account request failed", err);
      if (!res.headersSent) accountJson(res, 500, { error: "internal" });
      else res.end();
    }
  });
}

export function createAppServer(opts = {}) {
  const accountRouter = opts.accountRouter ?? createAppRouter(opts.accountDeps ?? depsFromEnv());
  return createServer(async (req, res) => {
    if (req.url === ACCOUNT_PREFIX || req.url.startsWith(ACCOUNT_PREFIX + "/") || req.url.startsWith(ACCOUNT_PREFIX + "?")) {
      handleAccount(accountRouter, req, res);
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }

    if (req.method === "GET" && req.url === "/healthz") {
      json(res, 200, { status: "ok" });
      return;
    }

    // Static assets (self-hosted vendor libs/fonts, brand images, manifest),
    // mirroring what S3/CloudFront serves in production.
    if (req.method === "GET") {
      const MIME = {
        ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
        ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
        ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json", ".json": "application/json",
      };
      const webRoot = path.join(root, "web");
      let urlPath;
      try {
        urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      } catch {
        // Malformed percent-encoding: reject this request, don't crash the process
        json(res, 400, { error: "Bad request" });
        return;
      }
      const filePath = path.normalize(path.join(webRoot, urlPath));
      const ext = path.extname(filePath);
      if (
        filePath.startsWith(webRoot + path.sep) && // no traversal out of web/
        MIME[ext] &&
        existsSync(filePath) && statSync(filePath).isFile()
      ) {
        res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=3600" });
        res.end(readFileSync(filePath));
        return;
      }
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      // Count bytes, not characters, and decode once at the end so multi-byte
      // characters split across chunks survive. 5 MB fits 4 photos + history.
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > 5_000_000) {
          tooLarge = true;
          json(res, 413, { error: "Request too large" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", async () => {
        if (tooLarge) return;
        const raw = Buffer.concat(chunks).toString("utf-8");
        // An exception escaping this async listener would be an unhandled
        // rejection, which terminates the whole server process.
        try {
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return;
          }

          const validationError = validateMessages(payload?.messages);
          if (validationError) {
            json(res, 400, { error: validationError });
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          try {
            await askTutorStream(payload.messages, MODEL_ID, (text) => res.write(text));
          } catch (err) {
            console.error("Bedrock invocation failed", err);
            res.write("\n\n[SumDeTing hit a snag; please send that again.]");
          }
          res.end();
        } catch (err) {
          console.error("Chat request failed", err);
          if (!res.headersSent) json(res, 500, { error: "Internal error" });
          else res.end();
        }
      });
      return;
    }

    json(res, 404, { error: "Not found" });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  createAppServer().listen(PORT, () => {
    console.log(`SumDeTing listening on http://localhost:${PORT} (model: ${MODEL_ID})`);
  });
}
