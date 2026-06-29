// x402 client demo: pay-per-call weather with a signed authorization (no API key).
// Multi-asset: pick the settlement asset by symbol or id from the 402 challenge.
//
//   node scripts/x402-client.mjs "Tokyo"                 # default asset (x402USD, gasless)
//   node scripts/x402-client.mjs "Tokyo" USDT            # pay with USDT (EIP-3009, gasless)
//   node scripts/x402-client.mjs "Tokyo" usdt-testnet-permit2   # pay USDT via Permit2
//
// EIP-3009 assets are gasless for the payer (just a signature). Permit2 assets need a
// ONE-TIME approve(Permit2) — this client sends it automatically if missing (needs gas
// once); every call after is signature-only. PAYER_KEY env overrides the wallet.
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const SITE = process.env.SITE_URL || "https://agent.kweather.co.kr";
let key = process.env.PAYER_KEY;
if (!key) key = JSON.parse(readFileSync(new URL("../.secrets/wallets.json", import.meta.url))).agent.privateKey;
const wallet = new ethers.Wallet(key);
const city = process.argv[2] || "Tokyo";
const want = (process.argv[3] || "").toLowerCase(); // symbol or id; empty = first asset
const url = `${SITE}/api/paid-weather?city=${encodeURIComponent(city)}`;
const chainIdFor = (n) => Number(String(n).split(":")[1]);

// 1) request without payment -> 402 challenge
const r1 = await fetch(url);
console.log("[1] GET", url, "->", r1.status);
const challenge = await r1.json();
if (r1.status !== 402) { console.log(challenge); process.exit(1); }
const accepts = challenge.accepts;
console.log("    402 offers", accepts.length, "asset(s):");
for (const a of accepts) console.log("      -", String(a.extra.id || "").padEnd(22), a.extra.symbol, a.extra.settlement, "|", a.network, "|", a.maxAmountRequired, "units");

const acc = accepts.find((a) => a.extra.id === want || String(a.extra.symbol || "").toLowerCase() === want) || accepts[0];
const chainId = chainIdFor(acc.network);
console.log("[*] selected:", acc.extra.id, "(" + acc.extra.symbol, acc.extra.settlement + ")");

const now = Math.floor(Date.now() / 1000);
let payload, settlement;

if (acc.extra.settlement === "permit2") {
  settlement = "permit2";
  // one-time approve(Permit2) so the relayer can pull via permitTransferFrom
  const rpc = process.env.RPC_URL || (chainId === 56 ? "https://bsc-dataseed.binance.org" : "https://bsc-testnet-rpc.publicnode.com");
  const provider = new ethers.JsonRpcProvider(rpc);
  const payer = wallet.connect(provider);
  const erc20 = new ethers.Contract(acc.asset, [
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], payer);
  const allowed = await erc20.allowance(wallet.address, acc.extra.permit2);
  if (allowed < BigInt(acc.maxAmountRequired)) {
    console.log("    approve(Permit2) once (payer pays gas this one time)…");
    const txa = await erc20.approve(acc.extra.permit2, ethers.MaxUint256);
    await txa.wait();
    console.log("    approved:", txa.hash);
  } else {
    console.log("    Permit2 already approved (no gas needed)");
  }
  const nonce = ethers.toBigInt(ethers.randomBytes(32)).toString();
  const deadline = now + 600;
  const authorization = { from: wallet.address, to: acc.payTo, value: acc.maxAmountRequired, nonce, deadline, token: acc.asset, spender: acc.extra.spender };
  const domain = { name: "Permit2", chainId, verifyingContract: acc.extra.permit2 };
  const types = {
    PermitTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const value = { permitted: { token: acc.asset, amount: acc.maxAmountRequired }, spender: acc.extra.spender, nonce, deadline };
  const signature = await wallet.signTypedData(domain, types, value);
  payload = { signature, authorization };
  console.log("[2] signed Permit2 SignatureTransfer as", wallet.address);
} else {
  settlement = "eip3009";
  const authorization = {
    from: wallet.address, to: acc.payTo, value: acc.maxAmountRequired,
    validAfter: 0, validBefore: now + 600, nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = { name: acc.extra.name, version: acc.extra.version, chainId, verifyingContract: acc.asset };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, authorization);
  payload = { signature, authorization };
  console.log("[2] signed EIP-3009 authorization as", wallet.address, "(no gas spent by payer)");
}

const xPayment = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: "exact", network: acc.network, asset: acc.asset, id: acc.extra.id, settlement, payload,
})).toString("base64");

// 3) retry with X-PAYMENT -> server settles on-chain and returns the data
const r2 = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
console.log("[3] GET with X-PAYMENT ->", r2.status);
const body = await r2.json();
console.log(JSON.stringify(body, null, 2));
const pr = r2.headers.get("x-payment-response");
if (pr) console.log("X-PAYMENT-RESPONSE:", JSON.parse(Buffer.from(pr, "base64").toString("utf8")));
