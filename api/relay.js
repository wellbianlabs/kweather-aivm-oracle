// Serverless relayer: pulls the latest real observation for each region from this site's
// /api/weather endpoint, scales floats -> fixed-point ints, and publishes them on-chain
// via pushBatch (signed by RELAYER_PRIVATE_KEY). Invoked hourly by a Vercel cron, and can
// be triggered manually from the dApp ("지금 갱신").
//
// Env: RPC_URL, RELAYER_PRIVATE_KEY, ORACLE_ADDRESS

const { ethers } = require("ethers");
const { scaleObs } = require("../lib/world-scale");
// catalog lookup so ?id=<world id> alone resolves its coordinates
const worldById = new Map(require("../lib/cities.json").map((c) => [String(c[0]), c]));

// Featured global cities (GeoNames id = on-chain code). `wc` = K-Weather world city code;
// the /api/weather feed also auto-resolves it from the GeoNames id (lib/worldcodes.json).
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
  "function pushBatch(uint256[] regionCodes, (uint256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[] data) external",
];
const KOREA_ABI = [
  "function pushBatch(uint256[] regionCodes, (uint256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[] data) external",
];
const { scaleObs: krScaleObs } = require("../lib/korea-scale");
const KOREA_ORACLE = process.env.KOREA_ORACLE_ADDRESS || "0xb303D062e079365479513a951777a35a353b32de";

// Featured Korea 법정동(동) — refreshed hourly alongside the world set (domestic feed needs code only).
const KOREA_FEATURED = [1111051500, 1168064000, 1156054000, 1171062000, 1114055000, 2635051000, 5011025300, 5176038000];

let _last = 0; // simple throttle across warm invocations

// fetch the live obs for each target + scale to fixed-point tuples for its market
async function buildBatch(targets, isKR, base, scaler) {
  const codes = [], tuples = [];
  for (const rg of targets) {
    const url = isKR
      ? `${base}/api/weather?code=${rg.code}`
      : `${base}/api/weather?lat=${rg.lat}&lon=${rg.lon}&code=${rg.code}${rg.wc ? `&worldcode=${rg.wc}` : ""}`;
    try {
      const r = await fetch(url); if (!r.ok) continue;
      const j = await r.json();
      const o = j.current || (j.series && j.series[j.series.length - 1]);
      if (!o) continue;
      codes.push(rg.code); tuples.push(scaler(o));
    } catch (_) { /* skip a region that fails to fetch */ }
  }
  return { codes, tuples };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { RPC_URL, RELAYER_PRIVATE_KEY, ORACLE_ADDRESS } = process.env;
    if (!RELAYER_PRIVATE_KEY || !ORACLE_ADDRESS) {
      return res.status(503).json({ error: "relayer not configured (set RELAYER_PRIVATE_KEY, ORACLE_ADDRESS)" });
    }
    const base = process.env.SELF_URL || `https://${req.headers.host}`;
    const provider = new ethers.JsonRpcProvider(RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
    const worldOracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);
    const koreaOracle = new ethers.Contract(KOREA_ORACLE, KOREA_ABI, wallet);

    // On-demand single city: ?id=<world id | 10-digit 법정동> (lat/lon optional).
    const qid = req.query.id, qlat = req.query.lat, qlon = req.query.lon;
    if (qid) {
      const id = String(qid).trim();
      const isKR = /^\d{10}$/.test(id);
      let target;
      if (isKR) target = { code: Number(id) };
      else if (qlat && qlon) target = { code: Number(id), lat: Number(qlat), lon: Number(qlon) };
      else { const c = worldById.get(id); if (!c) return res.status(404).json({ error: `unknown city id ${id} — pass &lat=&lon=` }); target = { code: Number(id), lat: c[3], lon: c[4] }; }
      const { codes, tuples } = await buildBatch([target], isKR, base, isKR ? krScaleObs : scaleObs);
      if (!codes.length) return res.status(502).json({ error: "no weather data to relay" });
      const tx = await (isKR ? koreaOracle : worldOracle).pushBatch(codes, tuples);
      const receipt = await tx.wait();
      return res.status(200).json({ ok: true, regions: codes.length, market: isKR ? "korea" : "world", txHash: tx.hash, block: receipt.blockNumber, at: new Date().toISOString() });
    }

    // Featured run (hourly cron): publish BOTH the world set AND the Korea 동 set.
    const now = Date.now();
    if (now - _last < 60_000) return res.status(429).json({ error: "throttled — try again in a minute" });
    _last = now;

    const w = await buildBatch(FEATURED, false, base, scaleObs);
    const k = await buildBatch(KOREA_FEATURED.map((code) => ({ code })), true, base, krScaleObs);
    if (!w.codes.length && !k.codes.length) return res.status(502).json({ error: "no weather data to relay" });

    const out = { ok: true, world: 0, korea: 0, regions: 0, txHashes: {}, at: new Date().toISOString() };
    if (w.codes.length) { const tx = await worldOracle.pushBatch(w.codes, w.tuples); await tx.wait(); out.world = w.codes.length; out.txHashes.world = tx.hash; }
    if (k.codes.length) { const tx = await koreaOracle.pushBatch(k.codes, k.tuples); await tx.wait(); out.korea = k.codes.length; out.txHashes.korea = tx.hash; }
    out.regions = out.world + out.korea;
    out.txHash = out.txHashes.world || out.txHashes.korea; // back-compat for the dApp
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.shortMessage) || (e && e.message) || e) });
  }
};
