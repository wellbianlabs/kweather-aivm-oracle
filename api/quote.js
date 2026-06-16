// Agent-facing price quote + how-to-consume (no wallet needed). GET /api/quote
const { ethers } = require("ethers");
const SM_ABI = [
  "function monthlyPrice() view returns (uint256)",
  "function pricePerQuery() view returns (uint256)",
  "function queriesPerMonth() view returns (uint256)",
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600");
  try {
    const { RPC_URL, SUBSCRIPTION_ADDRESS, ORACLE_ADDRESS, TOKEN_ADDRESS } = process.env;
    const p = new ethers.JsonRpcProvider(RPC_URL || "https://bsc-testnet-rpc.publicnode.com");
    const sm = new ethers.Contract(SUBSCRIPTION_ADDRESS, SM_ABI, p);
    const [mp, ppq, qpm] = await Promise.all([sm.monthlyPrice(), sm.pricePerQuery(), sm.queriesPerMonth()]);
    const f = (w) => Number(ethers.formatUnits(w, 18));
    return res.status(200).json({
      product: "K-Weather × AIVM on-chain weather oracle",
      coverage: "4,255 world cities, K-Weather 세계날씨 real-time (temperature, humidity, precipitation, wind speed/direction, discomfort index)",
      chain: { name: "BNB Smart Chain Testnet", chainId: 97, explorer: "https://testnet.bscscan.com" },
      settlementToken: { symbol: "KWT", address: TOKEN_ADDRESS, note: "testnet ERC-20; gas paid in tBNB" },
      pricing: {
        subscription: { price_KWT: f(mp), period_days: 30, includedQueries: Number(qpm) },
        payPerQuery: { price_KWT: f(ppq) },
      },
      contracts: { oracle: ORACLE_ADDRESS, subscriptionManager: SUBSCRIPTION_ADDRESS, token: TOKEN_ADDRESS },
      howToConsume: {
        mcp: "Add the 'kweather-aivm-oracle' MCP server (mcp/server.mjs). Tools: search_cities, get_weather, get_pricing, get_account, subscribe, deposit_prepaid, buy_weather.",
        rest: "GET /api/catalog?q=<city> to find a city; GET /api/weather?code=<id> for a free K-Weather preview; metered on-chain purchase via the contracts (see /llms.txt).",
      },
      discovery: "/llms.txt , /openapi.json",
    });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
