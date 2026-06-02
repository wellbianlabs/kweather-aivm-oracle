// Autonomous AI agent (renewable-energy forecaster). On each run it:
//   1. ensures an active subscription (approve + subscribe, paying KWT) — pays,
//   2. reads the region's 24h series on-chain (free peekHistory),
//   3. issues a METERED queryLatest tx (consumes quota / pays) — uses,
//   4. produces a generation forecast + on-chain action recommendation.
// Invoked by a Vercel cron (hourly) and viewable from the dApp.
//
// Env: RPC_URL, AGENT_PRIVATE_KEY, ORACLE_ADDRESS, SUBSCRIPTION_ADDRESS, TOKEN_ADDRESS

const { ethers } = require("ethers");

// Featured global cities (GeoNames id → label). The agent rotates through these.
const REGIONS = { 1796236: "Shanghai, CN", 745044: "Istanbul, TR", 2332459: "Lagos, NG", 1566083: "Ho Chi Minh City, VN", 1275339: "Mumbai, IN", 3448439: "São Paulo, BR", 3530597: "Mexico City, MX", 524901: "Moscow, RU", 1185241: "Dhaka, BD", 1835848: "Seoul, KR" };

const ORACLE_ABI = [
  "function queryLatest(uint256) returns (tuple(uint256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))",
  "function peekHistory(uint256,uint256) view returns (tuple(uint256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[])",
  "function observationCount(uint256) view returns (uint256)",
];
const SM_ABI = [
  "function quotaOf(address) view returns (uint256 expiry, uint256 allowance)",
  "function monthlyPrice() view returns (uint256)",
  "function subscribe(uint256 months)",
];
const TOKEN_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

let _cache = null;
let _last = 0;

function unscale(t) {
  return {
    time: Number(t[0]),
    temperature: Number(t[1]) / 100,
    humidity: Number(t[2]),
    precipitation: Number(t[3]) / 100,
    windSpeed: Number(t[4]) / 100,
    windDirection: Number(t[5]),
    pm10: Number(t[6]),
    pm25: Number(t[7]),
    solarRadiation: Number(t[8]) / 100,
    uvIndex: Number(t[9]) / 10,
    discomfortIndex: Number(t[10]) / 10,
  };
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function forecast(series) {
  const day = series.filter((o) => o.solarRadiation > 0);
  const ss = day.length ? day : series;
  const avgSolar = mean(ss.map((o) => o.solarRadiation));
  const avgWind = mean(series.map((o) => o.windSpeed));
  const solarKw = Math.min(1000, avgSolar * 0.2778 * 5000 * 0.2);
  const cutIn = 3, rated = 12;
  const windKw = avgWind < cutIn ? 0 : avgWind >= rated ? 500 : 500 * Math.pow((avgWind - cutIn) / (rated - cutIn), 3);
  const util = (solarKw + windKw) / 1500;
  const kwh = Math.round((solarKw + windKw) * 6);
  let action = util >= 0.6 ? "SELL_POWER (전력 판매 / PPA)" : util >= 0.3 ? "HOLD (포지션 유지)" : "BUY_HEDGE (DeFi 파생 헤지)";
  return { avgSolar: round2(avgSolar), avgWind: round2(avgWind), kwh, util: round2(util), action };
}
const round2 = (x) => Math.round(x * 100) / 100;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { RPC_URL, AGENT_PRIVATE_KEY, ORACLE_ADDRESS, SUBSCRIPTION_ADDRESS, TOKEN_ADDRESS } = process.env;
    if (!AGENT_PRIVATE_KEY || !ORACLE_ADDRESS) {
      return res.status(503).json({ error: "agent not configured" });
    }
    // serve cached activity if called again quickly (avoid draining quota/gas)
    if (_cache && Date.now() - _last < 60_000) {
      return res.status(200).json({ ..._cache, cached: true });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const wallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);
    const oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, wallet);
    const sm = new ethers.Contract(SUBSCRIPTION_ADDRESS, SM_ABI, wallet);
    const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, wallet);

    const codes = Object.keys(REGIONS).map(Number);
    const code = codes[new Date().getHours() % codes.length];

    // 1) ensure subscription — pay if needed
    let paid = null;
    const [expiry, allowance] = await sm.quotaOf(wallet.address);
    const active = BigInt(expiry) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(allowance) > 0n;
    if (!active) {
      const price = await sm.monthlyPrice();
      const cur = await token.allowance(wallet.address, SUBSCRIPTION_ADDRESS);
      if (cur < price) await (await token.approve(SUBSCRIPTION_ADDRESS, price)).wait();
      const sub = await sm.subscribe(1);
      await sub.wait();
      paid = { action: "subscribed", months: 1, txHash: sub.hash };
    }

    // 2) read 24h on-chain (free)
    const count = Number(await oracle.observationCount(code));
    if (count === 0) return res.status(503).json({ error: "no on-chain data yet — relayer must run first" });
    const hist = (await oracle.peekHistory(code, Math.min(24, count))).map(unscale);
    const f = forecast(hist);

    // 3) metered query — pay & use
    const q = await oracle.queryLatest(code);
    const receipt = await q.wait();
    const [, allowanceAfter] = await sm.quotaOf(wallet.address);

    _cache = {
      ok: true,
      agent: wallet.address,
      region: REGIONS[code],
      regionCode: code,
      samples: hist.length,
      forecast: f,
      decision: f.action,
      paidThisRun: paid,
      queryTxHash: q.hash,
      block: receipt.blockNumber,
      quotaRemaining: Number(allowanceAfter),
      at: new Date().toISOString(),
    };
    _last = Date.now();
    return res.status(200).json(_cache);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.shortMessage) || (e && e.message) || e) });
  }
};
