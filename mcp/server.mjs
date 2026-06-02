#!/usr/bin/env node
/**
 * KWeather × AIVM Oracle — MCP server.
 *
 * Lets any MCP-capable AI agent (Claude Desktop, Cursor, Gemini CLI, …) discover,
 * PURCHASE and CONSUME on-chain weather data for 5,400 world cities.
 *
 * Settlement model (BNB Smart Chain testnet):
 *   - KWT (ERC-20) is the settlement token; tBNB pays gas.
 *   - subscribe(months): pay monthlyPrice KWT -> query allowance (rate limit) for the period.
 *   - deposit_prepaid(amount): pay KWT -> prepaid credit (pay-per-query).
 *   - buy_weather(city): metered queryLatest tx -> consumes 1 subscription quota OR debits
 *     pricePerQuery from prepaid; KWT accrues in the treasury. Returns weather + settlement.
 *
 * Read tools need no wallet. Purchase tools need AGENT_PRIVATE_KEY (a funded testnet wallet).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- config (public BSC-testnet deployment; override via env) ----
const CFG = {
  rpc: process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
  chainId: 97,
  explorer: "https://testnet.bscscan.com",
  token: process.env.TOKEN_ADDRESS || "0x04090599Dbaa990eabC37fFBDE223A4eD02e5b20",
  sm: process.env.SUBSCRIPTION_ADDRESS || "0xA34D6B699f16ed574A574a3E2b18ce063da4d911",
  oracle: process.env.ORACLE_ADDRESS || "0x62FFc95E32052B7Fdd6E969fc645e3F134Fd2F3C",
  treasury: process.env.TREASURY || "0x77AC0aa9bE15b6272D54Df10Dc24EECAAc77f9db",
  site: process.env.SITE_URL || "https://kweather-aivm-oracle-wellbianlabs.vercel.app",
  agentKey: process.env.AGENT_PRIVATE_KEY || null,
};

// K-Weather world city codes for select cities (overlay activates with an entitled key)
const WORLDCODE = {
  1796236: 15107, 745044: 15127, 2332459: 16089, 1566083: 17963, 1275339: 15098,
  3448439: 15063, 3530597: 15033, 524901: 15010, 1185241: 15055, 1850147: 15104,
  2643743: 15082, 2988507: 15134, 5128581: 15039, 1816670: 15106, 292223: 15071,
};

// ---- city catalog ----
function loadCities() {
  const txt = readFileSync(join(__dirname, "..", "web", "cities.js"), "utf8");
  const start = txt.indexOf("[", txt.indexOf("window.CITIES"));
  const arr = JSON.parse(txt.slice(start, txt.lastIndexOf("]") + 1));
  return arr.map(([id, name, cc, lat, lon]) => ({ id, name, cc, lat, lon }));
}
const CITIES = loadCities();
function findCity(query) {
  const q = String(query).trim().toLowerCase();
  if (/^\d+$/.test(q)) {
    const byId = CITIES.find((c) => c.id === Number(q));
    if (byId) return byId;
  }
  return (
    CITIES.find((c) => c.name.toLowerCase() === q) ||
    CITIES.find((c) => c.name.toLowerCase().startsWith(q)) ||
    CITIES.find((c) => `${c.name}, ${c.cc}`.toLowerCase().includes(q)) ||
    null
  );
}

// ---- chain ----
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];
const SM_ABI = [
  "function subscribe(uint256 months)",
  "function depositPrepaid(uint256 amount)",
  "function quotaOf(address) view returns (uint256 expiry, uint256 allowance)",
  "function prepaidBalance(address) view returns (uint256)",
  "function monthlyPrice() view returns (uint256)",
  "function pricePerQuery() view returns (uint256)",
  "function queriesPerMonth() view returns (uint256)",
];
const ORACLE_ABI = [
  "function peekLatest(uint256) view returns (tuple(uint256 timestamp,int256 temperature,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pm10,uint256 pm25,uint256 solarRadiation,uint256 uvIndex,uint256 discomfortIndex))",
  "function observationCount(uint256) view returns (uint256)",
  "function getRegions() view returns (uint256[])",
  "function queryLatest(uint256) returns (tuple(uint256 timestamp,int256 temperature,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pm10,uint256 pm25,uint256 solarRadiation,uint256 uvIndex,uint256 discomfortIndex))",
];

const provider = new ethers.JsonRpcProvider(CFG.rpc);
const roToken = new ethers.Contract(CFG.token, TOKEN_ABI, provider);
const roSm = new ethers.Contract(CFG.sm, SM_ABI, provider);
const roOracle = new ethers.Contract(CFG.oracle, ORACLE_ABI, provider);
const signer = CFG.agentKey ? new ethers.Wallet(CFG.agentKey, provider) : null;

const ONE = 10n ** 18n;
const fmt = (wei) => Number(ethers.formatUnits(wei, 18));
const txUrl = (h) => `${CFG.explorer}/tx/${h}`;
function unscale(d) {
  return {
    timestamp: Number(d.timestamp),
    temperature: Number(d.temperature) / 100,
    humidity: Number(d.humidity),
    precipitation: Number(d.precipitation) / 100,
    windSpeed: Number(d.windSpeed) / 100,
    windDirection: Number(d.windDirection),
    pm10: Number(d.pm10),
    pm25: Number(d.pm25),
    solarRadiation: Number(d.solarRadiation) / 100,
    uvIndex: Number(d.uvIndex) / 10,
    discomfortIndex: Number(d.discomfortIndex) / 10,
  };
}
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true });
const need = (n) => `Set AGENT_PRIVATE_KEY (a funded BSC-testnet wallet) to ${n}.`;

// ---- server ----
const server = new McpServer({ name: "kweather-aivm-oracle", version: "1.0.0" });

server.tool(
  "search_cities",
  "Search the catalog of 5,400 purchasable world weather cities by name. Returns id (on-chain code), name, country, coordinates.",
  { query: z.string().describe("city name fragment, e.g. 'Tokyo'"), limit: z.number().optional() },
  async ({ query, limit }) => {
    const q = String(query).trim().toLowerCase();
    const hits = CITIES.filter((c) => c.name.toLowerCase().startsWith(q) || `${c.name}, ${c.cc}`.toLowerCase().includes(q)).slice(0, limit || 10);
    return ok({ count: hits.length, cities: hits });
  }
);

server.tool(
  "get_weather",
  "Free real-time weather preview for a city (Open-Meteo worldwide; K-Weather premium overlay where entitled). No payment. Use buy_weather for the metered on-chain feed.",
  { city: z.string().describe("city name or id") },
  async ({ city }) => {
    const c = findCity(city);
    if (!c) return err(`city not found: ${city}`);
    const wc = WORLDCODE[c.id] ? `&worldcode=${WORLDCODE[c.id]}` : "";
    const r = await fetch(`${CFG.site}/api/weather?lat=${c.lat}&lon=${c.lon}&code=${c.id}${wc}`);
    const j = await r.json();
    const latest = j.series?.[j.series.length - 1];
    return ok({ city: `${c.name}, ${c.cc}`, id: c.id, source: j.source, current: latest });
  }
);

server.tool(
  "get_pricing",
  "Get the on-chain price list: subscription (monthly), per-query rate, monthly query allowance, settlement token.",
  {},
  async () => {
    const [mp, ppq, qpm] = await Promise.all([roSm.monthlyPrice(), roSm.pricePerQuery(), roSm.queriesPerMonth()]);
    return ok({
      token: "KWT", chain: "BNB Smart Chain Testnet (97)",
      subscription: { price: `${fmt(mp)} KWT / month`, allowance: `${qpm} queries / month` },
      payPerQuery: { price: `${fmt(ppq)} KWT / query` },
      contracts: { oracle: CFG.oracle, subscriptionManager: CFG.sm, token: CFG.token, explorer: CFG.explorer },
    });
  }
);

server.tool(
  "get_account",
  "Read an account's settlement status: KWT balance, gas (tBNB), subscription quota, prepaid credit. Defaults to the configured agent wallet.",
  { address: z.string().optional() },
  async ({ address }) => {
    const a = address || signer?.address;
    if (!a) return err("provide address or set AGENT_PRIVATE_KEY");
    const [kwt, gas, sub, prepaid] = await Promise.all([
      roToken.balanceOf(a), provider.getBalance(a), roSm.quotaOf(a), roSm.prepaidBalance(a),
    ]);
    const active = BigInt(sub[0]) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(sub[1]) > 0n;
    return ok({ address: a, kwt: fmt(kwt), gas_tBNB: Number(ethers.formatEther(gas)), subscription: { active, remainingQueries: Number(sub[1]) }, prepaidKWT: fmt(prepaid) });
  }
);

server.tool(
  "get_oracle_status",
  "List cities currently published on-chain with their latest temperature, plus treasury settlement total.",
  {},
  async () => {
    const regions = await roOracle.getRegions();
    const rows = [];
    for (const code of regions) {
      const cnt = await roOracle.observationCount(code);
      let temp = null;
      if (cnt > 0n) temp = unscale(await roOracle.peekLatest(code)).temperature;
      const c = CITIES.find((x) => x.id === Number(code));
      rows.push({ id: Number(code), city: c ? `${c.name}, ${c.cc}` : `region ${code}`, observations: Number(cnt), temperatureC: temp });
    }
    const treasury = await roToken.balanceOf(CFG.treasury);
    return ok({ onChainCities: rows.length, treasuryKWT: fmt(treasury), regions: rows });
  }
);

server.tool(
  "faucet_kwt",
  "Mint test KWT to the agent wallet (testnet only). " + need("mint"),
  { amount: z.number().optional().describe("KWT, default 1000") },
  async ({ amount }) => {
    if (!signer) return err(need("mint KWT"));
    const t = new ethers.Contract(CFG.token, TOKEN_ABI, signer);
    const tx = await t.mint(signer.address, BigInt(amount || 1000) * ONE);
    await tx.wait();
    return ok({ minted: `${amount || 1000} KWT`, to: signer.address, txHash: tx.hash, tx: txUrl(tx.hash) });
  }
);

server.tool(
  "subscribe",
  "PURCHASE a subscription: pay monthlyPrice KWT for a monthly query allowance. Approves + subscribes on-chain. " + need("pay"),
  { months: z.number().optional().describe("number of months, default 1") },
  async ({ months }) => {
    if (!signer) return err(need("subscribe"));
    const m = BigInt(months || 1);
    const price = (await roSm.monthlyPrice()) * m;
    const t = new ethers.Contract(CFG.token, TOKEN_ABI, signer);
    const sm = new ethers.Contract(CFG.sm, SM_ABI, signer);
    if ((await roToken.allowance(signer.address, CFG.sm)) < price) await (await t.approve(CFG.sm, price)).wait();
    const tx = await sm.subscribe(m);
    await tx.wait();
    const q = await roSm.quotaOf(signer.address);
    return ok({ purchased: "subscription", months: Number(m), paidKWT: fmt(price), remainingQueries: Number(q[1]), txHash: tx.hash, tx: txUrl(tx.hash) });
  }
);

server.tool(
  "deposit_prepaid",
  "PURCHASE pay-per-query credit: deposit KWT as prepaid balance, debited pricePerQuery per query. " + need("pay"),
  { amount: z.number().describe("KWT to deposit") },
  async ({ amount }) => {
    if (!signer) return err(need("deposit prepaid"));
    const amt = BigInt(amount) * ONE;
    const t = new ethers.Contract(CFG.token, TOKEN_ABI, signer);
    const sm = new ethers.Contract(CFG.sm, SM_ABI, signer);
    if ((await roToken.allowance(signer.address, CFG.sm)) < amt) await (await t.approve(CFG.sm, amt)).wait();
    const tx = await sm.depositPrepaid(amt);
    await tx.wait();
    return ok({ purchased: "prepaid credit", depositedKWT: amount, prepaidKWT: fmt(await roSm.prepaidBalance(signer.address)), txHash: tx.hash, tx: txUrl(tx.hash) });
  }
);

server.tool(
  "buy_weather",
  "BUY + CONSUME: metered on-chain weather query for a city. Settles 1 subscription quota or pricePerQuery from prepaid, returns the verified on-chain weather and full settlement detail. Auto-publishes the city on-chain if missing. " + need("pay"),
  { city: z.string().describe("city name or id") },
  async ({ city }) => {
    if (!signer) return err(need("buy weather"));
    const c = findCity(city);
    if (!c) return err(`city not found: ${city}`);

    // publish on-demand if not yet on-chain
    if ((await roOracle.observationCount(c.id)) === 0n) {
      const wc = WORLDCODE[c.id] ? `&worldcode=${WORLDCODE[c.id]}` : "";
      const rj = await (await fetch(`${CFG.site}/api/relay?id=${c.id}&lat=${c.lat}&lon=${c.lon}${wc}`)).json();
      if (rj.error) return err(`could not publish on-chain: ${rj.error}`);
    }

    // settlement snapshot before
    const [subBefore, preBefore] = await Promise.all([roSm.quotaOf(signer.address), roSm.prepaidBalance(signer.address)]);
    const activeSub = BigInt(subBefore[0]) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(subBefore[1]) > 0n;
    if (!activeSub && preBefore < (await roSm.pricePerQuery())) {
      return err("no active subscription and insufficient prepaid credit — call subscribe or deposit_prepaid first.");
    }

    const oracle = new ethers.Contract(CFG.oracle, ORACLE_ABI, signer);
    const data = unscale(await oracle.queryLatest.staticCall(c.id));
    const tx = await oracle.queryLatest(c.id);
    const receipt = await tx.wait();

    const [subAfter, preAfter, treasury] = await Promise.all([
      roSm.quotaOf(signer.address), roSm.prepaidBalance(signer.address), roToken.balanceOf(CFG.treasury),
    ]);
    const mode = Number(subAfter[1]) < Number(subBefore[1]) ? "subscription" : "pay-per-query";
    const settledKWT = mode === "pay-per-query" ? fmt(preBefore - preAfter) : 0;

    return ok({
      city: `${c.name}, ${c.cc}`, id: c.id,
      weather: data,
      settlement: {
        mode, settledKWT, remainingQueries: Number(subAfter[1]), prepaidKWT: fmt(preAfter),
        treasuryTotalKWT: fmt(treasury), txHash: tx.hash, tx: txUrl(tx.hash), block: receipt.blockNumber,
      },
    });
  }
);

server.tool(
  "pay_x402",
  "Keyless HTTP-402 pay-per-call: pay 0.01 x402USD by SIGNING an authorization (no gas, no API key) and receive real-time weather for a city. The server settles on-chain. Needs AGENT_PRIVATE_KEY (holding x402USD).",
  { city: z.string().describe("city name or id") },
  async ({ city }) => {
    if (!signer) return err(need("pay via x402"));
    const url = `${CFG.site}/api/paid-weather?city=${encodeURIComponent(city)}`;
    const r1 = await fetch(url);
    if (r1.status !== 402) return err(`expected 402 challenge, got ${r1.status}`);
    const acc = (await r1.json()).accepts[0];
    const now = Math.floor(Date.now() / 1000);
    const authorization = { from: signer.address, to: acc.payTo, value: acc.maxAmountRequired, validAfter: 0, validBefore: now + 600, nonce: ethers.hexlify(ethers.randomBytes(32)) };
    const domain = { name: acc.extra.name, version: acc.extra.version, chainId: 97, verifyingContract: acc.asset };
    const types = { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] };
    const signature = await signer.signTypedData(domain, types, authorization);
    const xPayment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: acc.network, payload: { signature, authorization } })).toString("base64");
    const r2 = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
    return ok(await r2.json());
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("kweather-aivm-oracle MCP server ready (stdio)");
