# AGENTS.md — how AI agents buy & use this weather oracle

This repo is an **on-chain weather data marketplace for autonomous AI agents**. Weather for
4,255 world cities is published on-chain; agents pay an ERC-20 token (KWT) to query it.

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
- **HTTP REST**: discovery at [`/llms.txt`](https://agent.kweather.co.kr/llms.txt)
  and [`/openapi.json`]; `GET /api/catalog?q=`, `GET /api/quote`, `GET /api/weather`.

## Keyless pay-per-call (x402 / HTTP 402)

For agents that don't want to manage subscriptions or API keys, `GET /api/paid-weather?city=`
implements the **x402** flow: the first call returns **HTTP 402** with a **multi-asset** `accepts[]`
menu; the caller picks an asset and **signs** it, then retries with an `X-PAYMENT` header; the server
settles on-chain (0.01/call) and returns the data plus an `X-PAYMENT-RESPONSE` receipt.

Two settlement rails are offered (each `accepts` entry carries `extra.id / symbol / settlement`):
- **EIP-3009** (`x402USD`, `USDT` on BSC testnet) — sign `TransferWithAuthorization`; fully gasless/keyless.
- **Permit2** (`USDT`) — real BSC USDT (`0x55d398…`) supports neither EIP-3009 nor EIP-2612 permit, so
  the payer signs a **Uniswap Permit2 `SignatureTransfer`**. Needs a one-time `approve(Permit2)` (one
  gas tx); every call after is signature-only. This is the rail that settles **real mainnet USDT**
  (advertised when the server runs with `X402_ENABLE_MAINNET=true`).

Reference client: `scripts/x402-client.mjs "Tokyo" [asset]`; MCP tool: `pay_x402(city, asset?)`.

## On-chain decision products

The oracle's weather is turned into actionable, domain-specific decisions by a catalog of
**decision products** — `GET /api/decision?city=<name|id>` runs them all for a city (or
`&product=<id>` for one); `GET /api/decision` returns the catalog. Each product reads the
**on-chain** oracle data (free peek) and returns `{ signal, action, score(0..1), rationale, metrics }`:

| id | sector | decides |
|---|---|---|
| `wind-dispatch` | Energy | turbine power → DISPATCH / PARTIAL / CURTAIL |
| `crop-irrigation` | Agriculture | water deficit → IRRIGATE_NOW / SKIP / drought alert |
| `flood-watch` | Insurance/Safety | rain accumulation → CLEAR / WATCH / WARNING |
| `heat-demand-response` | Utilities | cooling load → NORMAL / PEAK_SHAVE / EMERGENCY_DR |
| `cold-chain` | Logistics | transport temp → OK / MONITOR / REROUTE |
| `construction-safety` | Construction | wind/rain/heat → WORK / CAUTION / STOP |
| `event-hedge` | Insurance/Events | rain/wind → CONFIRM / HEDGE / POSTPONE-PAYOUT |
| `tourism-comfort` | Travel | comfort score → dynamic pricing |
| `wildfire-risk` | Insurance/Safety | fire weather → LOW / ELEVATED / RED_FLAG |
| `heat-stress` | HSE/Health | felt temp(체감) → STOP / LIMIT / cold guard |
| `storm-pressure` | Insurance/Marine | pressure(기압)+wind → STORM / WATCH / STABLE |
| `visibility-ops` | Transport | visibility(가시거리) → HALT / CAUTION / GO |
| `snow-ops` | Logistics/Public | snowfall(적설) → DEPLOY / PREP / CLEAR |
| `air-quality-ops` | HSE (KR) | PM10/PM2.5 → GO / LIMIT / HALT |
| `marine-ops` | Marine | wind/visibility/pressure → SAIL / CAUTION / PORT_HOLD |
| `drone-ops` | UAV/Delivery | wind/precip/visibility → FLY / RESTRICT / NO_FLY |
| `road-frost` | Transport | temp/precip/humidity → CLEAR / WATCH / ICE |
| `autonomous-driving` | Mobility | visibility/precip/snow/temp/wind → FULL / DEGRADED / DISENGAGE |
| `heating-demand` | Utilities | felt-temp (HDD) → NORMAL / HIGH / PEAK |
| `crop-disease` | Agriculture | temp/humidity → LOW / ELEVATED / spray |
| `frost-alert` | Agriculture | low-temp/humidity/wind → SAFE / RISK / FROST |
| `retail-footfall` | Retail | precip/temp/discomfort → GOOD / SOFT / LOW |
| `vector-risk` | Public Health | temp/humidity/precip → LOW / ELEVATED / HIGH |
| `powerline-icing` | Grid | snowfall/temp/wind → LOW / WATCH / ICING |
| `water-demand` | Utilities | temp/discomfort → NORMAL / HIGH / PEAK |

All inputs come from the K-Weather world feed: temperature, senseTemp(체감), humidity,
precipitation, wind speed/direction, pressure(기압), visibility(가시거리), snowfall(적설),
discomfort index. (No PM/solar/UV — not part of the K-Weather world feed.)

The autonomous agent (`GET /api/agent?product=<id>`) pays on-chain (subscribe + metered
`queryLatest`) and returns the chosen product's decision. MCP tools: `list_decision_products()`,
`decide(city, product?)`. Decisions are derived from on-chain data; consuming the underlying feed
settles via metered `queryLatest` or x402.

## Live
- App: https://agent.kweather.co.kr
- dApp: https://agent.kweather.co.kr/dapp
- Chain: BNB Smart Chain testnet (97), explorer https://testnet.bscscan.com
- Prices & contract addresses: `GET /api/quote`
