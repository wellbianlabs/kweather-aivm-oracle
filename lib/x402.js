// Shared x402 (HTTP 402) settlement layer — multi-asset, multi-scheme.
//
// Two settlement rails so the same pay-per-call flow works for tokens that
// support gasless authorization AND for real-world tokens that don't:
//
//   - "eip3009": payer signs an EIP-712 TransferWithAuthorization; the resource
//                server submits transferWithAuthorization(). Fully gasless/keyless
//                for the payer. Used by our x402USD and the testnet USDT.
//
//   - "permit2": payer signs a Uniswap Permit2 SignatureTransfer; the server
//                submits permitTransferFrom(). Real BSC USDT (0x55d398…) supports
//                neither EIP-3009 nor EIP-2612 permit, so Permit2 is the only way
//                to settle it from an off-chain signature. Requires a ONE-TIME
//                approve(Permit2) by the payer (one gas tx); every call after is
//                just a signature.
//
// Addresses are baked as defaults (public) and overridable via env, so the same
// code serves testnet and mainnet.
const { ethers } = require("ethers");

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // canonical Permit2 (same address on every chain)

// Default on-chain deployments (public addresses; secrets stay in env).
const DEFAULTS = {
  x402usd: "0x3D9A26DA712e528124301c91e0aCAec049802C29", // EIP-3009 demo dollar, 6 dec (BSC testnet)
  usdtTestnet: "0x53B6E33b316bA39DC81572055706aDeD33D04405", // EIP-3009 "Tether USD", 18 dec (BSC testnet)
  usdtMainnet: "0x55d398326f99059fF775485246999027B3197955", // real Binance-Peg USDT (BSC-USD), 18 dec (BSC mainnet)
};

const UNIT6 = "10000"; // 0.01 with 6 decimals
const UNIT18 = "10000000000000000"; // 0.01 with 18 decimals

// Per-network plumbing. The settler (relayer) account is the same on both chains;
// it just needs gas on whichever chain it settles on.
function chainIdFor(network) { return Number(String(network).split(":")[1]); }
function explorerFor(network) { return network === "eip155:56" ? "https://bscscan.com" : "https://testnet.bscscan.com"; }
function rpcFor(network, env) {
  if (network === "eip155:56") return env.RPC_URL_MAINNET || "https://bsc-dataseed.binance.org";
  return env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
}

// The catalogue of sellable settlement assets. `enableMainnet` is off by default
// so a testnet deployment never advertises an asset it has no RPC/gas to settle.
function assetCatalogue(env) {
  const enableMainnet = String(env.X402_ENABLE_MAINNET || "").toLowerCase() === "true";
  const list = [
    {
      id: "x402usd", network: "eip155:97", settlement: "eip3009",
      asset: env.X402_TOKEN || DEFAULTS.x402usd, decimals: 6, price: env.X402_PRICE || UNIT6,
      name: "x402 USD", version: "1", symbol: "x402USD",
      label: "x402 USD — gasless EIP-3009 demo dollar (BSC testnet)",
    },
    {
      id: "usdt-testnet", network: "eip155:97", settlement: "eip3009",
      asset: env.X402_USDT_TESTNET || DEFAULTS.usdtTestnet, decimals: 18, price: env.X402_PRICE_USDT || UNIT18,
      name: "Tether USD", version: "1", symbol: "USDT",
      label: "USDT — gasless EIP-3009 (BSC testnet)",
    },
    {
      id: "usdt-testnet-permit2", network: "eip155:97", settlement: "permit2",
      asset: env.X402_USDT_TESTNET || DEFAULTS.usdtTestnet, decimals: 18, price: env.X402_PRICE_USDT || UNIT18,
      name: "Tether USD", symbol: "USDT", permit2: PERMIT2,
      label: "USDT via Permit2 (BSC testnet) — proves the real-USDT rail",
    },
  ];
  if (enableMainnet) {
    list.push({
      id: "usdt-mainnet", network: "eip155:56", settlement: "permit2",
      asset: env.X402_USDT_MAINNET || DEFAULTS.usdtMainnet, decimals: 18, price: env.X402_PRICE_USDT_MAINNET || UNIT18,
      name: "Tether USD", symbol: "USDT", permit2: PERMIT2,
      label: "USDT via Permit2 (BSC mainnet) — real Binance-Peg USDT",
    });
  }
  return list;
}

// The settler/relayer address (payment recipient's gas payer). Derivable from the
// key without a provider; used as the Permit2 `spender` the payer signs over.
function settlerAddress(env) {
  return env.RELAYER_PRIVATE_KEY ? new ethers.Wallet(env.RELAYER_PRIVATE_KEY).address : null;
}

// Build the x402 `accepts` array (one paymentRequirements per asset).
function buildAccepts({ env, payTo, resource, description }) {
  const spender = settlerAddress(env);
  return assetCatalogue(env).map((a) => {
    const extra = a.settlement === "permit2"
      ? { settlement: "permit2", name: a.name, decimals: a.decimals, symbol: a.symbol, id: a.id, label: a.label, permit2: a.permit2, spender }
      : { settlement: "eip3009", name: a.name, version: a.version, decimals: a.decimals, symbol: a.symbol, id: a.id, label: a.label };
    return {
      scheme: "exact",
      network: a.network,
      maxAmountRequired: a.price,
      resource,
      description,
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: 120,
      asset: a.asset,
      extra,
    };
  });
}

// Match an incoming X-PAYMENT to one advertised requirement. Prefer the explicit
// id; then (network, asset); only fall back to the first asset for legacy clients
// that send neither. Returns null when a specified asset isn't on offer (e.g. a
// mainnet asset that the liveness gate has hidden) so the caller can 402 cleanly.
function matchRequirement(accepts, payment) {
  if (payment.id) {
    return accepts.find((r) => r.extra && r.extra.id === payment.id) || null;
  }
  if (payment.network && payment.asset) {
    const settlement = payment.settlement || (payment.payload && payment.payload.authorization && payment.payload.authorization.deadline ? "permit2" : "eip3009");
    return accepts.find((r) =>
      r.network === payment.network &&
      r.asset.toLowerCase() === String(payment.asset).toLowerCase() &&
      r.extra.settlement === settlement) || null;
  }
  return accepts[0] || null;
}

// Liveness gate for real-money (mainnet) assets: only advertise an asset the settler
// can actually settle. If the relayer lacks mainnet gas (can't submit the settlement
// tx), drop mainnet assets so consumers never burn gas on an approve for a payment
// that would fail. Testnet assets are always offered. Cached ~60s; fails closed.
const MIN_SETTLER_GAS = 2000000000000000n; // 0.002 BNB
const _gateCache = new Map();
async function gateLive(accepts, env) {
  if (!accepts.some((a) => a.network === "eip155:56")) return accepts;
  const settler = settlerAddress(env);
  const dropMainnet = () => accepts.filter((a) => a.network !== "eip155:56");
  if (!settler) return dropMainnet();
  const key = `56:${settler}`;
  const now = Date.now();
  let entry = _gateCache.get(key);
  if (!entry || now - entry.ts > 60000) {
    let ok = false;
    try {
      const provider = new ethers.JsonRpcProvider(rpcFor("eip155:56", env));
      ok = (await provider.getBalance(settler)) >= MIN_SETTLER_GAS;
    } catch { ok = false; }
    entry = { ts: now, ok };
    _gateCache.set(key, entry);
  }
  return entry.ok ? accepts : dropMainnet();
}

const EIP3009_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function authorizationState(address,bytes32) view returns (bool)",
];
const PERMIT2_ABI = [
  "function permitTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes signature)",
  "function nonceBitmap(address,uint256) view returns (uint256)",
];
const ERC20_ALLOWANCE_ABI = ["function allowance(address,address) view returns (uint256)"];

// Settle a matched payment on-chain. Returns { txHash, block, explorer, payer }.
// Throws on replay / bad signature / insufficient approval — caller maps to 402.
async function settle({ env, requirement, payment }) {
  const a = payment.payload && payment.payload.authorization;
  const sig = payment.payload && payment.payload.signature;
  if (!a || !sig) throw new Error("missing payload.authorization/signature");

  const provider = new ethers.JsonRpcProvider(rpcFor(requirement.network, env));
  const settler = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, provider);
  const explorer = explorerFor(requirement.network);

  let tx;
  if (requirement.extra.settlement === "permit2") {
    const p2 = new ethers.Contract(requirement.extra.permit2, PERMIT2_ABI, settler);
    // unordered-nonce replay guard (Permit2 stores a bitmap per word)
    const word = BigInt(a.nonce) >> 8n, bitPos = BigInt(a.nonce) & 0xffn;
    const bitmap = await p2.nonceBitmap(a.from, word);
    if (((bitmap >> bitPos) & 1n) === 1n) throw new Error("permit2 nonce already used");
    // one-time approve(Permit2) must be in place
    const erc20 = new ethers.Contract(requirement.asset, ERC20_ALLOWANCE_ABI, provider);
    const allowed = await erc20.allowance(a.from, requirement.extra.permit2);
    if (allowed < BigInt(a.value)) throw new Error("payer has not approved Permit2 (one-time approve required)");
    const permit = [[requirement.asset, a.value], a.nonce, a.deadline];
    const transferDetails = [a.to, a.value];
    tx = await p2.permitTransferFrom(permit, transferDetails, a.from, sig);
  } else {
    const t = new ethers.Contract(requirement.asset, EIP3009_ABI, settler);
    if (await t.authorizationState(a.from, a.nonce)) throw new Error("authorization already used");
    const s = ethers.Signature.from(sig);
    tx = await t.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, s.v, s.r, s.s);
  }
  const receipt = await tx.wait();
  return { txHash: tx.hash, block: receipt.blockNumber, explorer, payer: a.from, tx: `${explorer}/tx/${tx.hash}` };
}

module.exports = { PERMIT2, DEFAULTS, assetCatalogue, settlerAddress, buildAccepts, gateLive, matchRequirement, settle, chainIdFor, explorerFor, rpcFor };
