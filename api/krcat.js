// TEMP: returns the K-Weather domestic 법정동(읍면동) catalog (kw-code-city2) —
// code -> {state, city, city2, lat, lon} for ~3,561 동. Used once to build
// lib/korea-cities.json, then removed.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const base = process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";
  const key = process.env.KWEATHER_API_KEY;
  if (!key) return res.status(503).json({ error: "no key" });
  try {
    const r = await fetch(`${base}/kw-code-city2?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (String(j.error) !== "0" || !j.data) return res.status(502).json({ error: `kw ${j.message || j.error}` });
    const out = {};
    for (const [code, v] of Object.entries(j.data)) {
      const d = v && v.data ? v.data : v;
      if (!d || d.lat == null || d.lon == null) continue;
      out[code] = { state: d.state, city: d.city, dong: d.city2, lat: Number(d.lat), lon: Number(d.lon) };
    }
    return res.status(200).json({ count: Object.keys(out).length, cities: out });
  } catch (e) { return res.status(502).json({ error: String((e && e.message) || e) }); }
};
