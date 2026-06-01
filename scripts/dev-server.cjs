// Local dev server: serves the web/ dashboard AND the api/weather serverless function,
// so the real-data path can be exercised locally (Vercel `vercel dev` equivalent).
//   node scripts/dev-server.cjs   ->   http://localhost:4322
const http = require("http");
const fs = require("fs");
const path = require("path");
const weather = require("../api/weather.js");

const PORT = process.env.PORT || 4322;
const WEB = path.join(__dirname, "..", "web");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/weather") {
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    try { await weather(req, res); } catch (e) { res.statusCode = 500; res.end(String(e)); }
    return;
  }
  const rel = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB)) { res.statusCode = 403; return res.end("403"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end("404"); }
    res.setHeader("content-type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`dev server: http://localhost:${PORT}`));
