"use strict";
// Publish REAL weather for the major Southeast-Asian cities to the on-chain oracle.
// Pulls each city's latest observation from the live /api/weather (Open-Meteo real data),
// scales floats -> fixed-point ints (same convention as api/relay.js), and pushBatch()es
// them to KWeatherOracle in chunks. Signed by the deployer key (an authorized relayer).
//
//   node scripts/relay-sea-cities.cjs [count] [chunk]
//   count = how many top SE-Asia cities (default 50), chunk = regions per tx (default 10)
const { ethers } = require("ethers");
const CITIES = require("../lib/cities.json");
const w = require("../.secrets/wallets.json");
const dep = require("../deployments.bscTestnet.json");

const SITE = process.env.SITE_URL || "https://kweather-aivm-oracle-wellbianlabs.vercel.app";
const RPC = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const COUNT = Number(process.argv[2] || 50);
const CHUNK = Number(process.argv[3] || 10);
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
  const o = j.series && j.series[j.series.length - 1];
  return o ? { code, name, cc, tuple: scale(o), temp: o.temperature } : null;
}

(async () => {
  const cities = CITIES.filter((x) => SEA.includes(x[2])).slice(0, COUNT);
  console.log(`Selected ${cities.length} SE-Asia cities; fetching real weather from ${SITE} …`);

  const rows = [];
  for (const c of cities) {
    try {
      const o = await fetchObs(c);
      if (o) { rows.push(o); process.stdout.write("."); }
      else process.stdout.write("x");
    } catch { process.stdout.write("x"); }
  }
  console.log(`\nfetched ${rows.length}/${cities.length} observations`);
  if (!rows.length) { console.error("no data"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(w.deployer.privateKey, provider);
  const oracle = new ethers.Contract(dep.oracle, ORACLE_ABI, signer);
  if (!(await oracle.relayers(signer.address))) { console.error("signer is not an authorized relayer"); process.exit(1); }

  const before = Number(await oracle.regionCount());
  console.log(`oracle ${dep.oracle} | regionCount before: ${before} | signer ${signer.address}`);

  let pushed = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const codes = part.map((p) => BigInt(p.code));
    const data = part.map((p) => p.tuple);
    const tx = await oracle.pushBatch(codes, data);
    const rc = await tx.wait();
    pushed += part.length;
    console.log(`  chunk ${i / CHUNK + 1}: ${part.length} regions -> ${tx.hash} (gas ${rc.gasUsed}) [${part.map((p) => p.name).join(", ")}]`);
  }

  const after = Number(await oracle.regionCount());
  console.log(`\nregionCount after: ${after} (was ${before}); pushed ${pushed} observations`);

  // spot-check a few on-chain
  for (const p of rows.slice(0, 3)) {
    const d = await oracle.peekLatest(BigInt(p.code));
    console.log(`  on-chain ${p.name}: temp ${Number(d[1]) / 100}°C (sent ${p.temp}°C), ts ${Number(d[0])}`);
  }
  console.log("DONE");
})().catch((e) => { console.error("FAIL:", (e && e.shortMessage) || (e && e.message) || e); process.exit(1); });
