"use strict";
/*
 * Standalone server — runs the K-Weather × AIVM Oracle WITHOUT Vercel, on any Node 18+ host
 * (e.g. K-Weather's own server behind nginx at https://agent.kweather.co.kr).
 *
 *   npm ci --omit=dev && node server.js     # serves web/ (static) + /api/* on $PORT (default 8080)
 *
 * It mounts every api/<name>.js (the same handlers Vercel runs) with a Vercel-compatible
 * req/res shim, and serves web/ with cleanUrls (/dapp -> dapp.html). Internal self-calls
 * (relay/decision -> /api/weather) stay on localhost via SELF_URL. See DEPLOY.md.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

const PORT = Number(process.env.PORT || 8080);
const WEB = path.join(__dirname, "web");
const API = path.join(__dirname, "api");
// internal self-calls (e.g. /api/relay -> /api/weather) resolve to this origin (no TLS needed)
process.env.SELF_URL = process.env.SELF_URL || `http://127.0.0.1:${PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".map": "application/json",
};

const apiCache = {};
function loadApi(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  if (name in apiCache) return apiCache[name];
  const f = path.join(API, name + ".js");
  apiCache[name] = fs.existsSync(f) ? require(f) : null;
  return apiCache[name];
}

function shim(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); return res; };
  res.send = (s) => { res.end(typeof s === "string" ? s : String(s)); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch { res.statusCode = 400; return res.end("Bad request"); }
  const pathname = decodeURIComponent(u.pathname);

  // ---- API ----
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const name = pathname.slice(5).replace(/\/.*$/, "");
    const handler = loadApi(name);
    if (!handler) { res.statusCode = 404; res.setHeader("Content-Type", "application/json"); return res.end('{"error":"unknown api route"}'); }
    req.query = Object.fromEntries(u.searchParams);
    shim(res);
    try { await handler(req, res); }
    catch (e) { if (!res.headersSent) { res.statusCode = 500; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: String((e && e.message) || e) })); } }
    return;
  }

  // ---- static (cleanUrls: /dapp -> dapp.html, / -> index.html) ----
  let rel = pathname === "/" ? "/index.html" : pathname;
  let file = path.join(WEB, path.normalize(rel));
  if (path.relative(WEB, file).startsWith("..")) { res.statusCode = 403; return res.end("Forbidden"); }
  if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.end("404 Not Found"); }
    const ext = path.extname(file);
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    // code/markup must revalidate so deploys reflect immediately; cache static assets (fonts/images/json)
    const revalidate = ext === ".html" || ext === ".js" || ext === ".css";
    res.setHeader("Cache-Control", revalidate ? "no-cache" : "public, max-age=600");
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`KWeather × AIVM Oracle listening on http://0.0.0.0:${PORT}  (SELF_URL=${process.env.SELF_URL})`);
  // Optional built-in scheduler (replaces Vercel crons). Prefer system cron; enable with ENABLE_CRON=true.
  if (String(process.env.ENABLE_CRON || "").toLowerCase() === "true") {
    const hit = (p) => fetch(`${process.env.SELF_URL}${p}`).then((r) => r.json()).then((j) => console.log(`[cron] ${p}`, JSON.stringify(j).slice(0, 120))).catch((e) => console.log(`[cron] ${p} err`, e.message));
    setInterval(() => hit("/api/relay"), 60 * 60 * 1000); // hourly: publish featured weather
    setInterval(() => hit("/api/agent"), 60 * 60 * 1000); // hourly: autonomous agent
    console.log("[cron] internal scheduler enabled (hourly relay + agent)");
  }
});
