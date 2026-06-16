// TEMP: returns the K-Weather world city catalog (kw-code-world1) — code -> {city_en,
// country_en, lat, lon} for ~5,400 cities. Public coordinates only; key not echoed.
// Used once to build lib/worldcodes.json, then removed.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const base = process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";
  const key = process.env.KWEATHER_API_KEY;
  if (!key) return res.status(503).json({ error: "no KWEATHER_API_KEY" });
  try {
    const r = await fetch(`${base}/kw-code-world1?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).json({ error: `gateway ${r.status}` });
    const j = await r.json();
    if (String(j.error) !== "0" || !j.data) return res.status(502).json({ error: `kw ${j.message || j.error}` });
    const out = {};
    for (const [code, v] of Object.entries(j.data)) {
      const d = v && v.data;
      if (!d || d.lat == null || d.lon == null) continue;
      out[code] = { city: d.cityEn || d.city_en || d.city || "", country: d.countryEn || d.country_en || d.country || "", lat: Number(d.lat), lon: Number(d.lon) };
    }
    return res.status(200).json({ count: Object.keys(out).length, cities: out });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
