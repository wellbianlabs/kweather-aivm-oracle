"use strict";
// Publish REAL weather for Southeast-Asian cities to the on-chain oracle.
// Pulls each city's latest observation from the live /api/weather (Open-Meteo real data),
// scales floats -> fixed-point ints (same convention as api/relay.js), and pushBatch()es
// them to KWeatherOracle in chunks. Signed by the deployer key (an authorized relayer).
//
//   node scripts/relay-sea-cities.cjs [count|all] [chunk] [fetchConcurrency]
//   count = how many top SE-Asia cities (default 50; "all" = every SE-Asia city)
//   chunk = regions per pushBatch tx (default 15), fetchConcurrency = parallel fetches (default 8)
const { ethers } = require("ethers");
const CITIES = require("../lib/cities.json");
const w = require("../.secrets/wallets.json");
const dep = require("../deployments.bscTestnet.json");

const SITE = process.env.SITE_URL || "https://kweather-aivm-oracle-wellbianlabs.vercel.app";
const RPC = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const ARG = process.argv[2] || "50";
const COUNT = ARG === "all" ? Infinity : Number(ARG);
const CHUNK = Number(process.argv[3] || 15);
const POOL = Number(process.argv[4] || 8);
const SEA = ["ID", "TH", "VN", "PH", "MY", "SG", "KH", "LA", "MM", "BN", "TL"];

const ORACLE_ABI = [
  "function pushBatch(uint256[] regionCodes, (uint256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[] data) external",
  "function regionCount() view returns (uint256)",
  "function peekLatest(uint256) view returns (uint256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function relayers(address) view returns (bool)",
];

const scale = (o) => [
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
];

async function fetchObs(city) {
  const [code, name, cc, lat, lon] = city;
  const r = await fetch(`${SITE}/api/weather?lat=${lat}&lon=${lon}&code=${code}`);
  if (!r.ok) return null;
  const j = await r.json();
  const o = j.current || (j.series && j.series[j.series.length - 1]);
  return o ? { code, name, cc, tuple: scale(o), temp: o.temperature } : null;
}

// bounded-concurrency map that preserves input order
async function mapPool(items, size, fn, onTick) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
      if (onTick) onTick(++done, items.length, out[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

(async () => {
  const cities = CITIES.filter((x) => SEA.includes(x[2])).slice(0, COUNT === Infinity ? undefined : COUNT);
  console.log(`Selected ${cities.length} SE-Asia cities; fetching real weather (pool ${POOL}) from ${SITE} …`);

  const fetched = await mapPool(cities, POOL, fetchObs, (d, t) => {
    if (d % 25 === 0 || d === t) process.stdout.write(`\r  fetched ${d}/${t}`);
  });
  const rows = fetched.filter(Boolean);
  console.log(`\nfetched ${rows.length}/${cities.length} observations`);
  if (!rows.length) { console.error("no data"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(w.deployer.privateKey, provider);
  const oracle = new ethers.Contract(dep.oracle, ORACLE_ABI, signer);
  if (!(await oracle.relayers(signer.address))) { console.error("signer is not an authorized relayer"); process.exit(1); }

  const before = Number(await oracle.regionCount());
  console.log(`oracle ${dep.oracle} | regionCount before: ${before} | signer ${signer.address}`);

  let pushed = 0, failed = [];
  const nChunks = Math.ceil(rows.length / CHUNK);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const codes = part.map((p) => BigInt(p.code));
    const data = part.map((p) => p.tuple);
    const n = i / CHUNK + 1;
    try {
      const tx = await oracle.pushBatch(codes, data);
      const rc = await tx.wait();
      pushed += part.length;
      console.log(`  chunk ${n}/${nChunks}: ${part.length} regions -> ${tx.hash} (gas ${rc.gasUsed})`);
    } catch (e) {
      failed.push(...part.map((p) => p.code));
      console.log(`  chunk ${n}/${nChunks}: FAILED (${(e && e.shortMessage) || (e && e.message) || e})`);
    }
  }

  const after = Number(await oracle.regionCount());
  console.log(`\nregionCount after: ${after} (was ${before}); pushed ${pushed} observations` + (failed.length ? `; ${failed.length} failed` : ""));
  for (const p of rows.slice(0, 3)) {
    const d = await oracle.peekLatest(BigInt(p.code));
    console.log(`  on-chain ${p.name}: temp ${Number(d[1]) / 100}°C (sent ${p.temp}°C)`);
  }
  console.log("DONE");
})().catch((e) => { console.error("FAIL:", (e && e.shortMessage) || (e && e.message) || e); process.exit(1); });
