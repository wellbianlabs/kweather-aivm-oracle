// x402 (HTTP 402) keyless pay-per-call weather. No API key: the caller pays each request
// with a signed authorization; this server settles it on-chain and returns the data.
// Multi-asset / multi-scheme — the 402 advertises several settlement options:
//
//   - x402USD (EIP-3009, gasless)         — eip155:97 BSC testnet
//   - USDT    (EIP-3009, gasless)         — eip155:97 BSC testnet
//   - USDT    (Permit2, 1x approve)       — eip155:97 BSC testnet (the real-USDT rail)
//   - USDT    (Permit2, real Binance-Peg) — eip155:56 BSC mainnet (when X402_ENABLE_MAINNET=true)
//
//   1. GET without X-PAYMENT      -> 402 + { x402Version, accepts:[paymentRequirements...] }
//   2. caller picks one asset, signs it (EIP-3009 or Permit2), base64-encodes the payload
//   3. GET with X-PAYMENT header   -> verify + settle on-chain -> 200 + weather
//                                     (+ X-PAYMENT-RESPONSE header with the settlement tx)
//
// Env: X402_PAYTO, RELAYER_PRIVATE_KEY (settler, pays gas), RPC_URL[, RPC_URL_MAINNET,
//      X402_ENABLE_MAINNET, X402_TOKEN, X402_USDT_TESTNET, X402_USDT_MAINNET]
const x402 = require("../lib/x402");
const CITIES = require("../lib/cities.json");

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

  const payTo = process.env.X402_PAYTO;
  if (!payTo || !process.env.RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: "x402 not configured" });
  }
  const city = resolveCity(req);
  if (!city) return res.status(400).json({ error: "provide ?city=<name> or ?lat=&lon=" });

  const resource = `https://${req.headers.host}${req.url}`;
  const description = `Real-time weather${city.label ? " for " + city.label : ""}`;
  const accepts = x402.buildAccepts({ env: process.env, payTo, resource, description });

  const header = req.headers["x-payment"];
  if (!header) {
    return res.status(402).json({ x402Version: 1, error: "X-PAYMENT required", accepts });
  }

  // decode payment payload
  let payment;
  try { payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")); }
  catch { return res.status(400).json({ error: "invalid X-PAYMENT base64/JSON" }); }

  const requirement = x402.matchRequirement(accepts, payment);
  const auth = payment && payment.payload && payment.payload.authorization;
  if (!auth || !(payment.payload && payment.payload.signature)) return res.status(400).json({ error: "missing payload.authorization/signature" });
  if (String(auth.to).toLowerCase() !== payTo.toLowerCase()) return res.status(402).json({ error: "wrong payTo", accepts });
  if (BigInt(auth.value) < BigInt(requirement.maxAmountRequired)) return res.status(402).json({ error: "insufficient amount", accepts });

  try {
    const s = await x402.settle({ env: process.env, requirement, payment });

    // deliver the resource (real weather) after settlement
    const base = `https://${req.headers.host}`;
    const wj = await (await fetch(`${base}/api/weather?lat=${city.lat}&lon=${city.lon}&code=${city.code}`)).json();
    const latest = wj.series ? wj.series[wj.series.length - 1] : wj;

    const payResp = Buffer.from(JSON.stringify({ success: true, transaction: s.txHash, network: requirement.network, payer: s.payer })).toString("base64");
    res.setHeader("X-PAYMENT-RESPONSE", payResp);
    return res.status(200).json({
      paid: true,
      city: city.label || `${city.lat},${city.lon}`,
      source: wj.source,
      weather: latest,
      settlement: {
        asset: requirement.asset, scheme: requirement.extra.settlement, symbol: requirement.extra.symbol,
        network: requirement.network, amount: auth.value, payTo,
        txHash: s.txHash, tx: s.tx, block: s.block,
      },
    });
  } catch (e) {
    return res.status(402).json({ error: "settlement failed: " + String((e && (e.shortMessage || e.message)) || e), accepts });
  }
};
