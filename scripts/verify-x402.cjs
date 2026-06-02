"use strict";
// End-to-end verification of the multi-asset x402 handler against BSC testnet.
// Settlement is REAL on-chain (relayer key); weather delivery hits the live /api/weather.
//   node scripts/verify-x402.cjs
const { ethers } = require("ethers");
const path = require("path");
const w = require("../.secrets/wallets.json");

const HOST = "kweather-aivm-oracle-wellbianlabs.vercel.app"; // delivery fetch -> live weather
const RPC = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
process.env.RPC_URL = RPC;
process.env.RELAYER_PRIVATE_KEY = w.relayer.privateKey; // settler (pays gas)
process.env.X402_PAYTO = w.deployer.address; // treasury / receiver

const handler = require("../api/paid-weather.js");
const x402 = require("../lib/x402.js");
let USDT;
try { USDT = require("../deployments.x402-usdt.bscTestnet.json").usdtToken; } catch { USDT = x402.DEFAULTS.usdtTestnet; }
const provider = new ethers.JsonRpcProvider(RPC);
const agent = new ethers.Wallet(w.agent.privateKey, provider);
const PERMIT2 = x402.PERMIT2;

function mockRes() {
  const res = { headers: {}, statusCode: 200 };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
async function call(headers, query) {
  const req = { headers: Object.assign({ host: HOST }, headers), query, url: `/api/paid-weather?city=${query.city}` };
  const res = mockRes();
  await handler(req, res);
  return res;
}
const erc = (addr) => new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
const bal = async (addr) => ethers.formatUnits(await erc(USDT).balanceOf(addr), 18);

async function sign(acc, settlement) {
  const chainId = Number(String(acc.network).split(":")[1]);
  const now = Math.floor(Date.now() / 1000);
  if (settlement === "permit2") {
    const token = new ethers.Contract(acc.asset, [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], agent);
    const allowed = await token.allowance(agent.address, acc.extra.permit2);
    if (allowed < BigInt(acc.maxAmountRequired)) {
      console.log("    approve(Permit2) once…");
      const txa = await token.approve(acc.extra.permit2, ethers.MaxUint256);
      await txa.wait();
      console.log("    approved:", txa.hash);
    }
    const nonce = ethers.toBigInt(ethers.randomBytes(32)).toString();
    const deadline = now + 600;
    const authorization = { from: agent.address, to: acc.payTo, value: acc.maxAmountRequired, nonce, deadline, token: acc.asset, spender: acc.extra.spender };
    const domain = { name: "Permit2", chainId, verifyingContract: acc.extra.permit2 };
    const types = {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ],
      TokenPermissions: [ { name: "token", type: "address" }, { name: "amount", type: "uint256" } ],
    };
    const value = { permitted: { token: acc.asset, amount: acc.maxAmountRequired }, spender: acc.extra.spender, nonce, deadline };
    const signature = await agent.signTypedData(domain, types, value);
    return { signature, authorization };
  }
  const authorization = { from: agent.address, to: acc.payTo, value: acc.maxAmountRequired, validAfter: 0, validBefore: now + 600, nonce: ethers.hexlify(ethers.randomBytes(32)) };
  const domain = { name: acc.extra.name, version: acc.extra.version, chainId, verifyingContract: acc.asset };
  const types = { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] };
  const signature = await agent.signTypedData(domain, types, authorization);
  return { signature, authorization };
}

async function pay(id, settlement, city) {
  const r1 = await call({}, { city });
  if (r1.statusCode !== 402) throw new Error(`expected 402, got ${r1.statusCode}: ${JSON.stringify(r1.body)}`);
  const acc = r1.body.accepts.find((a) => a.extra.id === id);
  if (!acc) throw new Error(`asset ${id} not offered`);
  const payload = await sign(acc, settlement);
  const xp = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: acc.network, asset: acc.asset, id, settlement, payload })).toString("base64");
  const r2 = await call({ "x-payment": xp }, { city });
  return r2;
}

(async () => {
  console.log("USDT:", USDT, "| payTo:", w.deployer.address, "| agent:", agent.address);

  // 0) show the 402 menu
  const menu = await call({}, { city: "Tokyo" });
  console.log("\n[402] assets offered:");
  for (const a of menu.body.accepts) console.log("   -", a.extra.id.padEnd(22), a.extra.symbol, a.extra.settlement, "|", a.network, "|", a.maxAmountRequired);

  for (const [id, settlement, city] of [["usdt-testnet", "eip3009", "Tokyo"], ["usdt-testnet-permit2", "permit2", "London"]]) {
    console.log(`\n=== pay ${id} (${settlement}) for ${city} ===`);
    const a0 = await bal(agent.address), p0 = await bal(w.deployer.address);
    const r = await pay(id, settlement, city);
    if (r.statusCode !== 200) throw new Error(`settlement failed (${r.statusCode}): ${JSON.stringify(r.body)}`);
    const a1 = await bal(agent.address), p1 = await bal(w.deployer.address);
    console.log("   ->", r.statusCode, "tx:", r.body.settlement.tx);
    console.log("   weather:", r.body.city, JSON.stringify(r.body.weather).slice(0, 90));
    console.log(`   agent USDT ${a0} -> ${a1}   payTo USDT ${p0} -> ${p1}`);
  }
  console.log("\nDONE");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
