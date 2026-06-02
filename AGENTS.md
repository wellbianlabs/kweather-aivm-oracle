# AGENTS.md — how AI agents buy & use this weather oracle

This repo is an **on-chain weather data marketplace for autonomous AI agents**. Weather for
5,400 world cities is published on-chain; agents pay an ERC-20 token (KWT) to query it.

## The purchase → settlement → consume flow

```
                      KWT (ERC-20)            metered query (tx)
  AI agent wallet ───────────────▶ SubscriptionManager ◀─── KWeatherOracle.queryLatest(cityId)
   (KWT + tBNB gas)                   │  consume(agent)            │ returns fixed-point weather
                                      ▼                            ▼
                                  treasury (KWT)             WeatherQueried event (audit)
```

1. **Fund**: agent holds KWT (settlement) + tBNB (gas). `faucet_kwt` mints test KWT.
2. **Purchase access** — one of:
   - **Subscription**: `approve(SubscriptionManager, monthlyPrice)` → `subscribe(months)`.
     KWT → treasury; agent gets a monthly query allowance (rate limit).
   - **Pay-per-query**: `approve` → `depositPrepaid(amount)`. KWT → treasury; agent gets
     prepaid credit.
3. **Consume**: `KWeatherOracle.queryLatest(cityId)` (a transaction). The oracle calls
   `SubscriptionManager.consume(agent)`, which decrements one subscription quota, or debits
   `pricePerQuery` from prepaid, or reverts if neither is available. Returns the on-chain
   `KWeatherPremiumData` struct and emits `WeatherQueried` — an auditable settlement record.
4. **Free read**: `peekLatest(cityId)` returns the latest data with no payment (transparency);
   the *paid* path is what dependent contracts (e.g. parametric insurance) trust and meter.

## Two ways for agents to connect

- **MCP** (Claude / Cursor / Gemini): `mcp/server.mjs` — see [mcp/README.md](mcp/README.md).
  `buy_weather(city)` does the whole purchase+consume and returns the settlement receipt.
- **HTTP REST**: discovery at [`/llms.txt`](https://kweather-aivm-oracle-wellbianlabs.vercel.app/llms.txt)
  and [`/openapi.json`]; `GET /api/catalog?q=`, `GET /api/quote`, `GET /api/weather`.

## Keyless pay-per-call (x402 / HTTP 402)

For agents that don't want to manage subscriptions or API keys, `GET /api/paid-weather?city=`
implements the **x402** flow: the first call returns **HTTP 402** with payment requirements; the
caller **signs an EIP-3009 `TransferWithAuthorization`** (no gas, no key) and retries with an
`X-PAYMENT` header; the server settles the micropayment on-chain (x402USD, 0.01/call) and returns
the data plus an `X-PAYMENT-RESPONSE` receipt. Reference client: `scripts/x402-client.mjs`;
MCP tool: `pay_x402(city)`. This is keyless and gasless for the payer.

## Live
- App: https://kweather-aivm-oracle-wellbianlabs.vercel.app
- dApp: https://kweather-aivm-oracle-wellbianlabs.vercel.app/dapp
- Chain: BNB Smart Chain testnet (97), explorer https://testnet.bscscan.com
- Prices & contract addresses: `GET /api/quote`
