// Agent-facing city catalog search (no wallet needed). GET /api/catalog?q=Tokyo&limit=20
// Includes both the world catalog (GeoNames) and Korea 법정동(읍면동) entries (10-digit code).
const CITIES = require("../lib/cities.json");
const KR = require("../lib/korea-cities.json"); // [법정동코드, name, "KR", lat, lon]
const fmt = ([id, name, cc, lat, lon]) => ({ id, name, country: cc, lat, lon, scope: String(id).length === 10 ? "KR-dong" : "world" });

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=86400");
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  if (!q) {
    return res.status(200).json({
      total: CITIES.length + KR.length,
      worldCities: CITIES.length,
      koreaDong: KR.length,
      note: `${CITIES.length} world cities + ${KR.length} Korea 동 (법정동) — add ?q= to search; id = on-chain region code`,
      sample: CITIES.slice(0, limit).map(fmt),
    });
  }
  const hits = [];
  for (const c of [...CITIES, ...KR]) {
    if (c[1].toLowerCase().startsWith(q) || `${c[1]}, ${c[2]}`.toLowerCase().includes(q)) {
      hits.push(fmt(c));
      if (hits.length >= limit) break;
    }
  }
  return res.status(200).json({ query: q, count: hits.length, cities: hits });
};
