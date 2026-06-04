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

const ORACLE_ABI = [
  "function observationCount(uint256) view returns (uint256)",
  "function peekLatest(uint256) view returns (tuple(uint256 timestamp,int256 temperature,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pm10,uint256 pm25,uint256 solarRadiation,uint256 uvIndex,uint256 discomfortIndex))",
  "function peekHistory(uint256,uint256) view returns (tuple(uint256 timestamp,int256 temperature,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pm10,uint256 pm25,uint256 solarRadiation,uint256 uvIndex,uint256 discomfortIndex)[])",
];

function unscale(d) {
  return {
    timestamp: Number(d.timestamp),
    temperature: Number(d.temperature) / 100,
    humidity: Number(d.humidity),
    precipitation: Number(d.precipitation) / 100,
    windSpeed: Number(d.windSpeed) / 100,
    windDirection: Number(d.windDirection),
    pm10: Number(d.pm10),
    pm25: Number(d.pm25),
    solarRadiation: Number(d.solarRadiation) / 100,
    uvIndex: Number(d.uvIndex) / 10,
    discomfortIndex: Number(d.discomfortIndex) / 10,
  };
}

function resolveCity(req) {
  if (req.query.code && req.query.lat && req.query.lon) {
    return { code: Number(req.query.code), lat: +req.query.lat, lon: +req.query.lon, label: req.query.city || "" };
  }
  const q = String(req.query.city || "").trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    const byId = CITIES.find((c) => c[0] === Number(q));
    if (byId) return { code: byId[0], lat: byId[3], lon: byId[4], label: `${byId[1]}, ${byId[2]}` };
  }
  const c = CITIES.find((x) => x[1].toLowerCase() === q) || CITIES.find((x) => x[1].toLowerCase().startsWith(q));
  return c ? { code: c[0], lat: c[3], lon: c[4], label: `${c[1]}, ${c[2]}` } : null;
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
    const oracleAddr = process.env.ORACLE_ADDRESS || "0x62FFc95E32052B7Fdd6E969fc645e3F134Fd2F3C";
    const provider = new ethers.JsonRpcProvider(rpc);
    const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, provider);

    const count = Number(await oracle.observationCount(BigInt(city.code)));
    if (count > 0) {
      const raw = await oracle.peekHistory(BigInt(city.code), BigInt(Math.min(168, count)));
      history = raw.map(unscale);
      latest = history[history.length - 1];
      source = "onchain";
      block = await provider.getBlockNumber();
    } else {
      // fall back to live feed for cities not yet published on-chain
      const base = process.env.SELF_URL || `https://${req.headers.host}`;
      const wj = await (await fetch(`${base}/api/weather?lat=${city.lat}&lon=${city.lon}&code=${city.code}`)).json();
      // /api/weather uses `time`; normalize to `timestamp` to match the on-chain shape
      history = (wj.series || []).map((o) => ({ ...o, timestamp: o.timestamp != null ? o.timestamp : o.time }));
      latest = history[history.length - 1];
      source = wj.source || "open-meteo";
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
