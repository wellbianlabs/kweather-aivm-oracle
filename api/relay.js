// Serverless relayer: pulls the latest real observation for each region from this site's
// /api/weather endpoint, scales floats -> fixed-point ints, and publishes them on-chain
// via pushBatch (signed by RELAYER_PRIVATE_KEY). Invoked hourly by a Vercel cron, and can
// be triggered manually from the dApp ("지금 갱신").
//
// Env: RPC_URL, RELAYER_PRIVATE_KEY, ORACLE_ADDRESS

const { ethers } = require("ethers");

// Featured global cities (GeoNames id = on-chain code). `wc` = K-Weather world city code
// (kw-world-rt1) used when the key has 세계날씨 entitlement; otherwise Open-Meteo.
const FEATURED = [
  { code: 1796236, lat: 31.2222, lon: 121.4581, wc: 15107 }, // Shanghai
  { code: 745044, lat: 41.0138, lon: 28.9497, wc: 15127 }, // Istanbul
  { code: 2332459, lat: 6.4541, lon: 3.3947, wc: 16089 }, // Lagos
  { code: 1566083, lat: 10.823, lon: 106.6297, wc: 17963 }, // Ho Chi Minh City
  { code: 1275339, lat: 19.0728, lon: 72.8826, wc: 15098 }, // Mumbai
  { code: 3448439, lat: -23.5475, lon: -46.6361, wc: 15063 }, // São Paulo
  { code: 3530597, lat: 19.4285, lon: -99.1277, wc: 15033 }, // Mexico City
  { code: 524901, lat: 55.752, lon: 37.6178, wc: 15010 }, // Moscow
  { code: 1185241, lat: 23.7104, lon: 90.4074, wc: 15055 }, // Dhaka
  { code: 1642911, lat: -6.2146, lon: 106.8451 }, // Jakarta
];

const ORACLE_ABI = [
  "function pushBatch(uint256[] regionCodes, (uint256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[] data) external",
];

let _last = 0; // simple throttle across warm invocations

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { RPC_URL, RELAYER_PRIVATE_KEY, ORACLE_ADDRESS } = process.env;
    if (!RELAYER_PRIVATE_KEY || !ORACLE_ADDRESS) {
      return res.status(503).json({ error: "relayer not configured (set RELAYER_PRIVATE_KEY, ORACLE_ADDRESS)" });
    }
    // On-demand: publish a single arbitrary city (?id=&lat=&lon=). Else the featured set.
    const qid = req.query.id, qlat = req.query.lat, qlon = req.query.lon;
    const single = qid && qlat && qlon;
    const targets = single ? [{ code: Number(qid), lat: Number(qlat), lon: Number(qlon) }] : FEATURED;

    const now = Date.now();
    if (!single && now - _last < 60_000) {
      return res.status(429).json({ error: "throttled — try again in a minute" });
    }

    const base = process.env.SELF_URL || `https://${req.headers.host}`;
    const codes = [];
    const tuples = [];
    for (const rg of targets) {
      const wc = rg.wc ? `&worldcode=${rg.wc}` : "";
      const r = await fetch(`${base}/api/weather?lat=${rg.lat}&lon=${rg.lon}&code=${rg.code}${wc}`);
      if (!r.ok) continue;
      const j = await r.json();
      const o = j.series && j.series[j.series.length - 1];
      if (!o) continue;
      codes.push(rg.code);
      tuples.push([
        BigInt(Math.trunc(o.time)),
        BigInt(Math.round(o.temperature * 100)),
        BigInt(Math.round(o.humidity)),
        BigInt(Math.round(o.precipitation * 100)),
        BigInt(Math.round(o.windSpeed * 100)),
        BigInt(Math.round(o.windDirection)),
        BigInt(Math.round(o.pm10)),
        BigInt(Math.round(o.pm25)),
        BigInt(Math.round(o.solarRadiation * 100)),
        BigInt(Math.round(o.uvIndex * 10)),
        BigInt(Math.round(o.discomfortIndex * 10)),
      ]);
    }
    if (!codes.length) return res.status(502).json({ error: "no weather data to relay" });

    const provider = new ethers.JsonRpcProvider(RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
    const oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);

    const tx = await oracle.pushBatch(codes, tuples);
    _last = now;
    const receipt = await tx.wait();

    return res.status(200).json({
      ok: true,
      regions: codes.length,
      txHash: tx.hash,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.shortMessage) || (e && e.message) || e) });
  }
};
