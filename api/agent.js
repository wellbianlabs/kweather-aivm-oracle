// Autonomous weather agent runner. Buy an autonomous service = pick a region (weather data)
// + an agent (decision product); the agent bot then, on-chain:
//   1. ensures an active subscription on the region's market (world / Korea 동) — pays KWT,
//   2. publishes the region on-chain if missing (relayer), reads its 24h series (free peekHistory),
//   3. issues a METERED queryLatest tx (consumes quota) — pays & uses,
//   4. runs the agent algorithm (perceive → trend/analysis → decide with confidence) and returns it.
//
// Query: ?product=<id>&city=<name|code>  (10-digit code ⇒ Korea 동 market). No params ⇒ rotates featured.
// Env: RPC_URL, AGENT_PRIVATE_KEY, ORACLE_ADDRESS, SUBSCRIPTION_ADDRESS, TOKEN_ADDRESS,
//      KOREA_ORACLE_ADDRESS, KOREA_SUBSCRIPTION_ADDRESS, SELF_URL

const { ethers } = require("ethers");
const DP = require("../lib/decision-products");
const world = require("../lib/world-scale");
const korea = require("../lib/korea-scale");
const WORLD_CITIES = require("../lib/cities.json");
const KOREA_CITIES = require("../lib/korea-cities.json");

const REGIONS = { 1796236: "Shanghai, CN", 745044: "Istanbul, TR", 2332459: "Lagos, NG", 1566083: "Ho Chi Minh City, VN", 1275339: "Mumbai, IN", 3448439: "São Paulo, BR", 3530597: "Mexico City, MX", 524901: "Moscow, RU", 1185241: "Dhaka, BD", 1642911: "Jakarta, ID" };

const isDong = (c) => String(c).length === 10;
const worldById = new Map(WORLD_CITIES.map((c) => [String(c[0]), c]));
const koreaById = new Map(KOREA_CITIES.map((c) => [String(c[0]), c]));

const SM_ABI = [
  "function quotaOf(address) view returns (uint256 expiry, uint256 allowance)",
  "function monthlyPrice() view returns (uint256)",
  "function subscribe(uint256 months)",
];
const TOKEN_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const oracleAbi = (tuple) => [
  `function queryLatest(uint256) returns (${tuple})`,
  `function peekHistory(uint256,uint256) view returns (${tuple}[])`,
  "function observationCount(uint256) view returns (uint256)",
];

function marketOf(code) {
  return isDong(code)
    ? { kr: true, oracleAddr: process.env.KOREA_ORACLE_ADDRESS || "0xb303D062e079365479513a951777a35a353b32de", smAddr: process.env.KOREA_SUBSCRIPTION_ADDRESS || "0x17AE51B67daFcC4845A60918F541DEBBBD73feA7", tuple: korea.KOREA_TUPLE, unscale: korea.unscale }
    : { kr: false, oracleAddr: process.env.ORACLE_ADDRESS, smAddr: process.env.SUBSCRIPTION_ADDRESS, tuple: world.ORACLE_TUPLE, unscale: world.unscale };
}

// resolve the target region from ?code / ?city, else rotate the featured world set
function resolveRegion(q) {
  const raw = (q.code || q.city || "").toString().trim();
  if (raw) {
    if (/^\d{10}$/.test(raw)) { const c = koreaById.get(raw); return { code: Number(raw), label: c ? c[1] + " (KR)" : `dong ${raw}` }; }
    if (/^\d+$/.test(raw)) { const c = worldById.get(raw); return { code: Number(raw), label: c ? `${c[1]}, ${c[2]}` : `region ${raw}`, lat: c && c[3], lon: c && c[4] }; }
    const ql = raw.toLowerCase();
    const w = WORLD_CITIES.find((c) => c[1].toLowerCase() === ql) || WORLD_CITIES.find((c) => c[1].toLowerCase().startsWith(ql));
    if (w) return { code: Number(w[0]), label: `${w[1]}, ${w[2]}`, lat: w[3], lon: w[4] };
    const k = KOREA_CITIES.find((c) => c[1].toLowerCase().includes(ql));
    if (k) return { code: Number(k[0]), label: `${k[1]} (KR)`, lat: k[3], lon: k[4] };
  }
  const codes = Object.keys(REGIONS).map(Number);
  const code = codes[new Date().getHours() % codes.length];
  return { code, label: REGIONS[code] };
}

let _cache = {}; // key product|code -> result (short TTL to spare quota/gas)

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const { RPC_URL, AGENT_PRIVATE_KEY, TOKEN_ADDRESS } = process.env;
    if (!AGENT_PRIVATE_KEY || !process.env.ORACLE_ADDRESS) return res.status(503).json({ error: "agent not configured" });

    const product = req.query.product && DP.get(req.query.product) ? String(req.query.product) : "heat-demand-response";
    const region = resolveRegion(req.query);
    const code = region.code;
    const mk = marketOf(code);
    if (mk.kr && (product === "storm-pressure" || product === "visibility-ops" || product === "snow-ops" || product === "marine-ops" || product === "powerline-icing")) {
      // these agents need pressure/visibility/snowfall, which the Korea feed doesn't carry
      return res.status(400).json({ error: `agent '${product}' needs world fields (pressure/visibility/snow) — use a world city` });
    }

    const ckey = product + "|" + code;
    if (_cache[ckey] && Date.now() - _cache[ckey]._t < 60_000) return res.status(200).json({ ..._cache[ckey], cached: true });

    const provider = new ethers.JsonRpcProvider(RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const wallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);
    const oracle = new ethers.Contract(mk.oracleAddr, oracleAbi(mk.tuple), wallet);
    const sm = new ethers.Contract(mk.smAddr, SM_ABI, wallet);
    const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, wallet);

    // 1) ensure subscription on this market — pay if needed
    let paid = null;
    const [expiry, allowance] = await sm.quotaOf(wallet.address);
    const active = BigInt(expiry) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(allowance) > 0n;
    if (!active) {
      const price = await sm.monthlyPrice();
      if ((await token.allowance(wallet.address, mk.smAddr)) < price) await (await token.approve(mk.smAddr, price)).wait();
      const sub = await sm.subscribe(1); await sub.wait();
      paid = { action: "subscribed", months: 1, market: mk.kr ? "korea" : "world", txHash: sub.hash };
    }

    // 2) publish on-chain if missing, then read 24h (free)
    let count = Number(await oracle.observationCount(code));
    if (count === 0) {
      const base = process.env.SELF_URL || `https://${req.headers.host}`;
      const url = `${base}/api/relay?id=${code}${!mk.kr && region.lat != null ? `&lat=${region.lat}&lon=${region.lon}` : ""}`;
      const rj = await (await fetch(url)).json().catch(() => ({}));
      if (rj.error) return res.status(503).json({ error: "no on-chain data and relay failed: " + rj.error });
      count = Number(await oracle.observationCount(code));
    }
    if (count === 0) return res.status(503).json({ error: "no on-chain data yet — relayer must run first" });
    const hist = (await oracle.peekHistory(code, Math.min(24, count))).map(mk.unscale);
    const dec = DP.decide(product, hist[hist.length - 1], hist);

    // 3) metered query — pay & use
    const q = await oracle.queryLatest(code);
    const receipt = await q.wait();
    const [, allowanceAfter] = await sm.quotaOf(wallet.address);

    const out = {
      ok: true, agent: wallet.address, market: mk.kr ? "korea" : "world",
      region: region.label, regionCode: code, samples: hist.length, product,
      observation: hist[hist.length - 1],
      decision: dec.action, decisionDetail: dec,
      paidThisRun: paid, queryTxHash: q.hash, block: receipt.blockNumber,
      quotaRemaining: Number(allowanceAfter), at: new Date().toISOString(), _t: Date.now(),
    };
    _cache[ckey] = out;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.shortMessage) || (e && e.message) || e) });
  }
};
