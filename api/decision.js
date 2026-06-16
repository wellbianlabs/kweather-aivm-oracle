// On-chain weather decision products. Reads the oracle's stored observations for a
// city (free peek) and runs one or all decision products on them. Falls back to the
// live /api/weather feed when a city has no on-chain data yet.
//
//   GET /api/decision                         -> product catalog
//   GET /api/decision?city=Jakarta            -> all products for the city
//   GET /api/decision?city=Jakarta&product=flood-watch
//   GET /api/decision?code=&lat=&lon=         -> by coordinates
//
// Decisions are derived from the on-chain oracle data; settling/consuming the
// underlying feed is metered on-chain (KWeatherOracle.queryLatest) or via x402.
const { ethers } = require("ethers");
const DP = require("../lib/decision-products");
const CITIES = require("../lib/cities.json");
const KR = require("../lib/korea-cities.json"); // [법정동코드, name, "KR", lat, lon]
const { unscale, ORACLE_TUPLE } = require("../lib/world-scale");
const { unscale: krUnscale, KOREA_TUPLE } = require("../lib/korea-scale");

const KOREA_ORACLE = process.env.KOREA_ORACLE_ADDRESS || "0xb303D062e079365479513a951777a35a353b32de";
const WORLD_ABI = (T) => [
  "function observationCount(uint256) view returns (uint256)",
  `function peekLatest(uint256) view returns (${T})`,
  `function peekHistory(uint256,uint256) view returns (${T}[])`,
];

function resolveCity(req) {
  const isKR = (v) => /^\d{10}$/.test(String(v));
  if (req.query.code && req.query.lat && req.query.lon) {
    return { code: Number(req.query.code), lat: +req.query.lat, lon: +req.query.lon, label: req.query.city || "", kr: isKR(req.query.code) };
  }
  const q = String(req.query.city || "").trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    if (isKR(q)) { const k = KR.find((c) => c[0] === Number(q)); if (k) return { code: k[0], lat: k[3], lon: k[4], label: `${k[1]}`, kr: true }; }
    const byId = CITIES.find((c) => c[0] === Number(q));
    if (byId) return { code: byId[0], lat: byId[3], lon: byId[4], label: `${byId[1]}, ${byId[2]}` };
  }
  const c = CITIES.find((x) => x[1].toLowerCase() === q) || CITIES.find((x) => x[1].toLowerCase().startsWith(q));
  if (c) return { code: c[0], lat: c[3], lon: c[4], label: `${c[1]}, ${c[2]}` };
  const k = KR.find((x) => x[1].toLowerCase() === q) || KR.find((x) => x[1].toLowerCase().includes(q));
  return k ? { code: k[0], lat: k[3], lon: k[4], label: `${k[1]}`, kr: true } : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300");

  const productId = req.query.product ? String(req.query.product) : null;
  if (productId && !DP.get(productId)) {
    return res.status(400).json({ error: `unknown product '${productId}'`, products: DP.list().map((p) => p.id) });
  }

  const city = resolveCity(req);
  if (!city) {
    // discovery: list the decision-product catalog
    return res.status(200).json({
      service: "On-chain weather decision products",
      note: "Add ?city=<name|id> to run all products, or &product=<id> for one. Decisions read the on-chain oracle (peek); settle via metered queryLatest or x402.",
      count: DP.list().length,
      products: DP.list(),
    });
  }

  try {
    let latest, history, source, block = null;
    const rpc = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
    const oracleAddr = city.kr ? KOREA_ORACLE : (process.env.ORACLE_ADDRESS || "0x2A2b4B6530ef062c80fCeEc23ae0d6167eAe9630");
    const decode = city.kr ? krUnscale : unscale;
    const provider = new ethers.JsonRpcProvider(rpc);
    const oracle = new ethers.Contract(oracleAddr, WORLD_ABI(city.kr ? KOREA_TUPLE : ORACLE_TUPLE), provider);

    const count = Number(await oracle.observationCount(BigInt(city.code)));
    if (count > 0) {
      const raw = await oracle.peekHistory(BigInt(city.code), BigInt(Math.min(168, count)));
      history = raw.map(decode);
      latest = history[history.length - 1];
      source = "onchain";
      block = await provider.getBlockNumber();
    } else {
      // fall back to live feed for cities not yet published on-chain
      const base = process.env.SELF_URL || `https://${req.headers.host}`;
      const wj = await (await fetch(`${base}/api/weather?code=${city.code}`)).json();
      // /api/weather uses `time`; normalize to `timestamp` to match the on-chain shape
      history = (wj.series || []).map((o) => ({ ...o, timestamp: o.timestamp != null ? o.timestamp : o.time }));
      const cur = wj.current ? { ...wj.current, timestamp: wj.current.time } : null;
      latest = cur || history[history.length - 1];
      source = wj.source || "kweather-world";
    }
    if (!latest) return res.status(502).json({ error: "no observation available for this city" });

    const products = productId ? [DP.decide(productId, latest, history)] : DP.decideAll(latest, history);

    return res.status(200).json({
      city: city.label || `${city.lat},${city.lon}`,
      regionCode: city.code,
      source, // "onchain" = decided from on-chain oracle data
      onchain: source === "onchain",
      block,
      observedAt: new Date(latest.timestamp * 1000).toISOString(),
      samples: history.length,
      observation: latest,
      decisions: products,
      settlement: { feed: "KWeatherOracle.queryLatest (metered) or x402 /api/paid-weather", oracle: oracleAddr },
    });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.shortMessage) || (e && e.message) || e) });
  }
};
