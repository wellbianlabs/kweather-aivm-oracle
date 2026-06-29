"use strict";
// Register Korea 법정동(읍면동) weather on the Korea-domestic oracle.
//   node scripts/relay-korea.cjs [sidoPrefix|all] [chunk] [pool]
//   sidoPrefix: first 2 digits of 법정동코드 (11=서울, 26=부산, 27=대구 …) or "all".
const { ethers } = require("ethers");
const KR = require("../lib/korea-cities.json"); // [code, name, "KR", lat, lon]
const w = require("../.secrets/wallets.json");
const dep = require("../deployments.korea.bscTestnet.json");
const { scaleObs, KOREA_TUPLE } = require("../lib/korea-scale");

const SITE = process.env.SITE_URL || "https://agent.kweather.co.kr";
const RPC = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const ARG = String(process.argv[2] || "11");
const CHUNK = Number(process.argv[3] || 15);
const POOL = Number(process.argv[4] || 8);

const ORACLE_ABI = [
  `function pushBatch(uint256[] regionCodes, ${KOREA_TUPLE}[] data) external`,
  "function regionCount() view returns (uint256)",
  `function peekLatest(uint256) view returns (${KOREA_TUPLE})`,
  "function relayers(address) view returns (bool)",
];

async function fetchObs(row) {
  const [code, name] = row;
  const r = await fetch(`${SITE}/api/weather?code=${code}`);
  if (!r.ok) return null;
  const j = await r.json();
  const o = j.current || (j.series && j.series[j.series.length - 1]);
  return o ? { code, name, tuple: scaleObs(o), temp: o.temperature, pm25: o.pm25 } : null;
}
async function mapPool(items, size, fn, onTick) {
  const out = new Array(items.length); let next = 0, done = 0;
  async function worker() { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i]); } catch { out[i] = null; } if (onTick) onTick(++done, items.length); } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

(async () => {
  const rows = ARG === "all" ? KR : KR.filter((x) => String(x[0]).startsWith(ARG));
  console.log(`Korea 동 selected: ${rows.length} (prefix ${ARG}); fetching domestic weather (pool ${POOL})…`);
  const fetched = await mapPool(rows, POOL, fetchObs, (d, t) => { if (d % 50 === 0 || d === t) process.stdout.write(`\r  fetched ${d}/${t}`); });
  const obs = fetched.filter(Boolean);
  console.log(`\nfetched ${obs.length}/${rows.length}`);
  if (!obs.length) { console.error("no data"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(w.relayer.privateKey, provider);
  const oracle = new ethers.Contract(dep.koreaOracle, ORACLE_ABI, signer);
  if (!(await oracle.relayers(signer.address))) { console.error("signer not authorized relayer"); process.exit(1); }
  const before = Number(await oracle.regionCount());
  console.log(`koreaOracle ${dep.koreaOracle} | regionCount before: ${before} | signer ${signer.address}`);

  let pushed = 0; const nChunks = Math.ceil(obs.length / CHUNK);
  for (let i = 0; i < obs.length; i += CHUNK) {
    const part = obs.slice(i, i + CHUNK);
    try {
      const tx = await oracle.pushBatch(part.map((p) => BigInt(p.code)), part.map((p) => p.tuple));
      const rc = await tx.wait(); pushed += part.length;
      console.log(`  chunk ${i / CHUNK + 1}/${nChunks}: ${part.length} 동 -> ${tx.hash} (gas ${rc.gasUsed})`);
    } catch (e) { console.log(`  chunk ${i / CHUNK + 1}/${nChunks}: FAILED ${(e && e.shortMessage) || e.message}`); }
  }
  const after = Number(await oracle.regionCount());
  console.log(`\nregionCount after: ${after} (was ${before}); pushed ${pushed}`);
  for (const p of obs.slice(0, 3)) { const d = await oracle.peekLatest(BigInt(p.code)); console.log(`  on-chain ${p.name}: ${Number(d[1]) / 100}℃ PM2.5 ${Number(d[8]) / 10}`); }
  console.log("DONE");
})().catch((e) => { console.error("FAIL:", (e && e.shortMessage) || e.message); process.exit(1); });
