// x402 (HTTP 402) keyless pay-per-call weather. No API key: the caller pays each request
// with a signed EIP-3009 authorization (gasless for the payer); this server settles it
// on-chain and returns the data. Compatible with the x402 "exact" EVM scheme shape.
//
//   1. GET without X-PAYMENT      -> 402 + { x402Version, accepts:[paymentRequirements] }
//   2. caller signs TransferWithAuthorization, base64-encodes the payload
//   3. GET with X-PAYMENT header   -> verify + settle on-chain -> 200 + weather
//                                     (+ X-PAYMENT-RESPONSE header with the settlement tx)
//
// Env: X402_TOKEN, X402_PAYTO, RELAYER_PRIVATE_KEY (settler, pays gas), RPC_URL
const { ethers } = require("ethers");
const CITIES = require("../lib/cities.json");

const TOKEN_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function authorizationState(address,bytes32) view returns (bool)",
];
const PRICE = "10000"; // 0.01 x402USD (6 decimals)
const NETWORK = "eip155:97"; // BNB Smart Chain testnet
const ASSET_NAME = "x402 USD";

function resolveCity(req) {
  if (req.query.lat && req.query.lon) return { lat: +req.query.lat, lon: +req.query.lon, code: req.query.code || "", label: req.query.city || "" };
  const q = String(req.query.city || "").trim().toLowerCase();
  if (!q) return null;
  const c = CITIES.find((x) => x[1].toLowerCase() === q) || CITIES.find((x) => x[1].toLowerCase().startsWith(q));
  return c ? { lat: c[3], lon: c[4], code: String(c[0]), label: `${c[1]}, ${c[2]}` } : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  res.setHeader("Access-Control-Allow-Headers", "X-PAYMENT, Content-Type");

  const token = process.env.X402_TOKEN, payTo = process.env.X402_PAYTO;
  if (!token || !payTo || !process.env.RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: "x402 not configured" });
  }
  const city = resolveCity(req);
  if (!city) return res.status(400).json({ error: "provide ?city=<name> or ?lat=&lon=" });

  const resource = `https://${req.headers.host}${req.url}`;
  const requirements = {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: PRICE,
    resource,
    description: `Real-time weather${city.label ? " for " + city.label : ""}`,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 120,
    asset: token,
    extra: { name: ASSET_NAME, version: "1" },
  };

  const header = req.headers["x-payment"];
  if (!header) {
    return res.status(402).json({ x402Version: 1, error: "X-PAYMENT required", accepts: [requirements] });
  }

  // decode payment payload
  let payment;
  try { payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")); }
  catch { return res.status(400).json({ error: "invalid X-PAYMENT base64/JSON" }); }
  const auth = payment && payment.payload && payment.payload.authorization;
  const sig = payment && payment.payload && payment.payload.signature;
  if (!auth || !sig) return res.status(400).json({ error: "missing payload.authorization/signature" });
  if (String(auth.to).toLowerCase() !== payTo.toLowerCase()) return res.status(402).json({ error: "wrong payTo", accepts: [requirements] });
  if (BigInt(auth.value) < BigInt(PRICE)) return res.status(402).json({ error: "insufficient amount", accepts: [requirements] });

  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const settler = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    const t = new ethers.Contract(token, TOKEN_ABI, settler);
    if (await t.authorizationState(auth.from, auth.nonce)) return res.status(402).json({ error: "authorization already used" });

    const s = ethers.Signature.from(sig);
    const tx = await t.transferWithAuthorization(auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, s.v, s.r, s.s);
    const receipt = await tx.wait();

    // deliver the resource (real weather) after settlement
    const base = `https://${req.headers.host}`;
    const wj = await (await fetch(`${base}/api/weather?lat=${city.lat}&lon=${city.lon}&code=${city.code}`)).json();
    const latest = wj.series ? wj.series[wj.series.length - 1] : wj;

    const payResp = Buffer.from(JSON.stringify({ success: true, transaction: tx.hash, network: NETWORK, payer: auth.from })).toString("base64");
    res.setHeader("X-PAYMENT-RESPONSE", payResp);
    return res.status(200).json({
      paid: true,
      city: city.label || `${city.lat},${city.lon}`,
      source: wj.source,
      weather: latest,
      settlement: { asset: token, amount: auth.value, payTo, txHash: tx.hash, tx: `https://testnet.bscscan.com/tx/${tx.hash}`, block: receipt.blockNumber },
    });
  } catch (e) {
    return res.status(402).json({ error: "settlement failed: " + String((e && (e.shortMessage || e.message)) || e), accepts: [requirements] });
  }
};
