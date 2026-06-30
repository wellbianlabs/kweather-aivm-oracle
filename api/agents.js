// AI-agent activity, read straight from the OPEN contracts. Aggregates the public
// `WeatherQueried(agent, regionCode, mode)` events from both oracles over the last 24h:
// how many distinct AI agents bought data, which regions, how much, and how they paid.
//
// Source priority: a block-explorer logs API (Etherscan v2, chainId 97 — needs a free
// ETHERSCAN_API_KEY) because free public RPCs block historical eth_getLogs ("archive"
// requests). Falls back to RPC getLogs (best-effort, recent window). Cached 60s.
// Env: ETHERSCAN_API_KEY (or BSCSCAN_API_KEY), RPC_URL, ORACLE_ADDRESS, KOREA_ORACLE_ADDRESS.

const { ethers } = require("ethers");
const WORLD = require("../lib/cities.json");
const KOREA = require("../lib/korea-cities.json");

const wName = new Map(WORLD.map((c) => [String(c[0]), `${c[1]}, ${c[2]}`]));
const kName = new Map(KOREA.map((c) => [String(c[0]), `${c[1]} (KR)`]));
const isDong = (c) => String(c).length === 10;
const nameOf = (c) => (isDong(c) ? kName.get(String(c)) : wName.get(String(c))) || `region ${c}`;

const ABI = ["event WeatherQueried(address indexed agent, uint256 indexed regionCode, uint8 mode)"];
const TOPIC0 = ethers.id("WeatherQueried(address,uint256,uint8)");
const MODE = { 0: "none", 1: "subscription", 2: "prepaid" };

async function fetchExplorer(addr, fromBlock, key) {
  const url = `https://api.etherscan.io/v2/api?chainid=97&module=logs&action=getLogs&address=${addr}&topic0=${TOPIC0}&fromBlock=${fromBlock}&toBlock=latest&page=1&offset=1000&apikey=${key}`;
  const j = await (await fetch(url)).json();
  if (!Array.isArray(j.result)) {
    if (j.message && /no records/i.test(j.message)) return [];
    throw new Error(String(j.result || j.message || "explorer error"));
  }
  return j.result.map((l) => ({
    agent: "0x" + String(l.topics[1]).slice(-40),
    code: BigInt(l.topics[2]).toString(),
    mode: Number(BigInt(l.data || "0x0")),
    block: parseInt(l.blockNumber, 16),
    at: parseInt(l.timeStamp, 16),
    tx: l.transactionHash,
  }));
}

let _cache = null, _t = 0;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (_cache && Date.now() - _t < 60_000) return res.status(200).json({ ..._cache, cached: true });

    const KEY = process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "";
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const oracles = [
      { addr: process.env.ORACLE_ADDRESS || "0x2A2b4B6530ef062c80fCeEc23ae0d6167eAe9630", market: "world" },
      { addr: process.env.KOREA_ORACLE_ADDRESS || "0xb303D062e079365479513a951777a35a353b32de", market: "korea" },
    ];
    const tip = await provider.getBlockNumber();
    const fromBlock = Math.max(0, tip - 300000); // > 24h at any plausible block time
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;

    let events = [], source = "none", note = "";

    if (KEY) {
      try {
        for (const o of oracles) {
          const ls = await fetchExplorer(o.addr, fromBlock, KEY);
          for (const e of ls) events.push({ ...e, market: o.market });
        }
        source = "explorer";
      } catch (e) { note = "explorer error: " + e.message; }
    }

    if (source !== "explorer") {
      // best-effort RPC fallback — free public nodes usually reject historical getLogs
      try {
        const span = Math.min(tip - 1, 5000);
        const [bN, bO] = await Promise.all([provider.getBlock(tip), provider.getBlock(tip - span)]);
        const SECS = bN && bO && span > 0 ? Math.max(0.1, (bN.timestamp - bO.timestamp) / span) : 0.5;
        for (const o of oracles) {
          const c = new ethers.Contract(o.addr, ABI, provider);
          for (let b = fromBlock; b <= tip; b += 9001) {
            try {
              const lg = await c.queryFilter("WeatherQueried", b, Math.min(tip, b + 9000));
              for (const l of lg) events.push({ agent: l.args.agent, code: l.args.regionCode.toString(), mode: Number(l.args.mode), block: l.blockNumber, at: Math.floor(Date.now() / 1000 - (tip - l.blockNumber) * SECS), tx: l.transactionHash, market: o.market });
            } catch (_) { /* skip chunk */ }
          }
        }
        source = events.length ? "rpc" : "none";
      } catch (_) { /* ignore */ }
      if (source === "none" && !note) note = KEY ? "" : "set ETHERSCAN_API_KEY (free, etherscan.io) for full 24h history — public RPC blocks historical logs";
    }

    events = events.filter((e) => e.at >= cutoff).sort((a, b) => b.at - a.at);

    const agents = {}, regions = {}, modes = { subscription: 0, prepaid: 0, none: 0 };
    const hourly = new Array(24).fill(0); // index 0 = most recent hour
    const nowS = Math.floor(Date.now() / 1000);
    for (const e of events) {
      agents[e.agent] = (agents[e.agent] || 0) + 1;
      regions[e.code] = regions[e.code] || { code: e.code, name: nameOf(e.code), market: e.market, count: 0 };
      regions[e.code].count++;
      modes[MODE[e.mode] || "none"]++;
      hourly[Math.min(23, Math.floor((nowS - e.at) / 3600))]++;
    }

    const out = {
      ok: true, windowHours: 24, source, note, generatedAt: new Date().toISOString(),
      uniqueAgents: Object.keys(agents).length,
      totalQueries: events.length,
      modes,
      topAgents: Object.entries(agents).map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      topRegions: Object.values(regions).sort((a, b) => b.count - a.count).slice(0, 12),
      hourly,
      recent: events.slice(0, 30).map((e) => ({ agent: e.agent, code: e.code, name: nameOf(e.code), market: e.market, mode: MODE[e.mode] || "none", tx: e.tx, at: e.at })),
    };
    _cache = out; _t = Date.now();
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
