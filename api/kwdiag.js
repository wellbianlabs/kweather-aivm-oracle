// TEMP diagnostic: probe the K-Weather gateway with the live server-side key.
// Does NOT echo the key. Remove after debugging.
//   GET /api/kwdiag?sensor=kw-world-rt1&code=15107[&base=...]
//   GET /api/kwdiag?sensor=apps-odam            (domestic snapshot, no code)
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const base = req.query.base ? String(req.query.base) : (process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr/weather/w3/v2/kw-sensors");
  const key = process.env.KWEATHER_API_KEY;
  const sensor = String(req.query.sensor || "kw-world-rt1");
  const code = req.query.code != null ? String(req.query.code) : (req.query.worldcode != null ? String(req.query.worldcode) : "");
  if (!key) return res.status(503).json({ error: "no KWEATHER_API_KEY on server" });
  const out = { base, sensor, code, keyLen: key.length };
  try {
    const url = code
      ? `${base}/${sensor}/${encodeURIComponent(code)}?api_key=${encodeURIComponent(key)}`
      : `${base}/${sensor}?api_key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    out.httpStatus = r.status;
    out.ok = r.ok;
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (j) {
      out.error = j.error;
      out.message = j.message;
      if (j.data && typeof j.data === "object") {
        out.dataKeys = Object.keys(j.data).slice(0, 3);
        const first = Object.values(j.data)[0];
        out.sampleEntry = first;
        out.innerDataKeys = first && first.data ? Object.keys(first.data) : (first ? Object.keys(first) : null);
      } else {
        out.dataType = typeof j.data;
      }
    } else {
      out.rawBody = text.slice(0, 400);
    }
  } catch (e) {
    out.fetchError = String((e && e.message) || e);
  }
  return res.status(200).json(out);
};
