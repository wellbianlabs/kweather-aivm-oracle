// Autonomous AI agent (renewable-energy forecaster). On each run it:
//   1. ensures an active subscription (approve + subscribe, paying KWT) — pays,
//   2. reads the region's 24h series on-chain (free peekHistory),
//   3. issues a METERED queryLatest tx (consumes quota / pays) — uses,
//   4. produces a generation forecast + on-chain action recommendation.
// Invoked by a Vercel cron (hourly) and viewable from the dApp.
//
// Env: RPC_URL, AGENT_PRIVATE_KEY, ORACLE_ADDRESS, SUBSCRIPTION_ADDRESS, TOKEN_ADDRESS

const { ethers } = require("ethers");
const DP = require("../lib/decision-products");

// Featured global cities (GeoNames id → label). The agent rotates through these.
const REGIONS = { 1796236: "Shanghai, CN", 745044: "Istanbul, TR", 2332459: "Lagos, NG", 1566083: "Ho Chi Minh City, VN", 1275339: "Mumbai, IN", 3448439: "São Paulo, BR", 3530597: "Mexico City, MX", 524901: "Moscow, RU", 1185241: "Dhaka, BD", 1642911: "Jakarta, ID" };

const { unscale, ORACLE_TUPLE } = require("../lib/world-scale");
const ORACLE_ABI = [
  `function queryLatest(uint256) returns (${ORACLE_TUPLE})`,
  `function peekHistory(uint256,uint256) view returns (${ORACLE_TUPLE}[])`,
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { RPC_URL, AGENT_PRIVATE_KEY, ORACLE_ADDRESS, SUBSCRIPTION_ADDRESS, TOKEN_ADDRESS } = process.env;
    if (!AGENT_PRIVATE_KEY || !ORACLE_ADDRESS) {
      return res.status(503).json({ error: "agent not configured" });
    }
    // which decision product to run (default: solar energy trading)
    const product = req.query.product && DP.get(req.query.product) ? String(req.query.product) : "heat-demand-response";

    // serve cached activity if called again quickly (avoid draining quota/gas)
    if (_cache && _cache.product === product && Date.now() - _last < 60_000) {
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
    const dec = DP.decide(product, hist[hist.length - 1], hist); // chosen decision product

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
      product,
      observation: hist[hist.length - 1],
      decision: dec.action,
      decisionDetail: dec,
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
