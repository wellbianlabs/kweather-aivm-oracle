// Agent-facing city catalog search (no wallet needed). GET /api/catalog?q=Tokyo&limit=20
const CITIES = require("../lib/cities.json");
const fmt = ([id, name, cc, lat, lon]) => ({ id, name, country: cc, lat, lon });

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=86400");
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  if (!q) {
    return res.status(200).json({ total: CITIES.length, note: "5,400 purchasable world cities — add ?q= to search; id = on-chain region code", sample: CITIES.slice(0, limit).map(fmt) });
  }
  const hits = [];
  for (const c of CITIES) {
    if (c[1].toLowerCase().startsWith(q) || `${c[1]}, ${c[2]}`.toLowerCase().includes(q)) {
      hits.push(fmt(c));
      if (hits.length >= limit) break;
    }
  }
  return res.status(200).json({ query: q, count: hits.length, cities: hits });
};
