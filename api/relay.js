// Serverless relayer: pulls the latest real observation for each region from this site's
// /api/weather endpoint, scales floats -> fixed-point ints, and publishes them on-chain
// via pushBatch (signed by RELAYER_PRIVATE_KEY). Invoked hourly by a Vercel cron, and can
// be triggered manually from the dApp ("지금 갱신").
//
// Env: RPC_URL, RELAYER_PRIVATE_KEY, ORACLE_ADDRESS

const { ethers } = require("ethers");

const REGIONS = [
  { code: 1168000000, lat: 37.5172, lon: 127.0473 },
  { code: 2611000000, lat: 35.1064, lon: 129.0323 },
  { code: 4617000000, lat: 35.0158, lon: 126.7108 },
  { code: 4380000000, lat: 36.175, lon: 127.7765 },
  { code: 5011000000, lat: 33.4996, lon: 126.5312 },
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
    const now = Date.now();
    if (now - _last < 60_000) {
      return res.status(429).json({ error: "throttled — try again in a minute" });
    }

    const base = process.env.SELF_URL || `https://${req.headers.host}`;
    const codes = [];
    const tuples = [];
    for (const rg of REGIONS) {
      const r = await fetch(`${base}/api/weather?lat=${rg.lat}&lon=${rg.lon}&code=${rg.code}`);
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
