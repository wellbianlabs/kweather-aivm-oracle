// x402 client demo: pay-per-call weather with a signed EIP-3009 authorization (no API key,
// no gas for the payer). Usage: node scripts/x402-client.mjs "Tokyo"
//   PAYER_KEY env overrides the wallet (defaults to the local test agent wallet).
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const SITE = process.env.SITE_URL || "https://kweather-aivm-oracle-wellbianlabs.vercel.app";
let key = process.env.PAYER_KEY;
if (!key) key = JSON.parse(readFileSync(new URL("../.secrets/wallets.json", import.meta.url))).agent.privateKey;
const wallet = new ethers.Wallet(key);
const city = process.argv[2] || "Tokyo";
const url = `${SITE}/api/paid-weather?city=${encodeURIComponent(city)}`;

// 1) request without payment -> 402 challenge
const r1 = await fetch(url);
console.log("[1] GET", url, "->", r1.status);
const challenge = await r1.json();
if (r1.status !== 402) { console.log(challenge); process.exit(1); }
const acc = challenge.accepts[0];
console.log("    402 Payment Required:", acc.maxAmountRequired, "units of", acc.asset, "-> payTo", acc.payTo, "(" + acc.network + ")");

// 2) sign EIP-3009 TransferWithAuthorization (off-chain, gasless, keyless)
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: wallet.address,
  to: acc.payTo,
  value: acc.maxAmountRequired,
  validAfter: 0,
  validBefore: now + 600,
  nonce: ethers.hexlify(ethers.randomBytes(32)),
};
const domain = { name: acc.extra.name, version: acc.extra.version, chainId: 97, verifyingContract: acc.asset };
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
const signature = await wallet.signTypedData(domain, types, authorization);
const xPayment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: acc.network, payload: { signature, authorization } })).toString("base64");
console.log("[2] signed authorization as", wallet.address, "(no gas spent by payer)");

// 3) retry with X-PAYMENT -> server settles on-chain and returns the data
const r2 = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
console.log("[3] GET with X-PAYMENT ->", r2.status);
const body = await r2.json();
console.log(JSON.stringify(body, null, 2));
const pr = r2.headers.get("x-payment-response");
if (pr) console.log("X-PAYMENT-RESPONSE:", JSON.parse(Buffer.from(pr, "base64").toString("utf8")));
