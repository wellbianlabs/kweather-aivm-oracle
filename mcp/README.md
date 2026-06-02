# KWeather × AIVM Oracle — MCP Server

Lets any MCP-capable AI agent (**Claude Desktop, Cursor, Gemini CLI, Cline, …**) discover,
**purchase**, and **consume** on-chain weather data for 5,400 world cities.

## Tools
| Tool | Wallet? | What it does |
|---|---|---|
| `search_cities(query)` | no | find a city + its on-chain id |
| `get_weather(city)` | no | free real-time preview |
| `get_pricing()` | no | subscription / per-query prices |
| `get_account(address?)` | no | KWT / gas / quota / prepaid status |
| `get_oracle_status()` | no | cities on-chain + treasury settlement total |
| `faucet_kwt(amount?)` | yes | mint test KWT |
| `subscribe(months)` | yes | **buy** a monthly query allowance (pays KWT) |
| `deposit_prepaid(amount)` | yes | **buy** pay-per-query credit (pays KWT) |
| `buy_weather(city)` | yes | **buy + consume** one metered query → weather + settlement (tx, mode, treasury) |

Read tools need nothing. Purchase tools need `AGENT_PRIVATE_KEY` — a funded **BNB Smart Chain
testnet** wallet (get tBNB from a faucet; mint KWT with `faucet_kwt`).

## Install
```bash
git clone https://github.com/wellbianlabs/kweather-aivm-oracle
cd kweather-aivm-oracle && npm install
```

## Connect

### Claude Desktop — `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "kweather-oracle": {
      "command": "node",
      "args": ["/ABS/PATH/kweather-aivm-oracle/mcp/server.mjs"],
      "env": { "AGENT_PRIVATE_KEY": "0xYOUR_TESTNET_KEY" }
    }
  }
}
```

### Cursor — `~/.cursor/mcp.json`  (same shape as above)

### Gemini CLI — `~/.gemini/settings.json`
```json
{ "mcpServers": { "kweather-oracle": { "command": "node", "args": ["/ABS/PATH/mcp/server.mjs"], "env": { "AGENT_PRIVATE_KEY": "0x..." } } } }
```

Omit `AGENT_PRIVATE_KEY` to expose read-only tools (search / preview / pricing / status).

## Defaults
Targets the live BSC-testnet deployment out of the box. Override with env:
`RPC_URL`, `ORACLE_ADDRESS`, `SUBSCRIPTION_ADDRESS`, `TOKEN_ADDRESS`, `SITE_URL`.

## Example agent flow
1. `faucet_kwt()` → get 1,000 test KWT
2. `subscribe(1)` → pay 100 KWT, get 1,000 queries
3. `buy_weather("Tokyo")` → metered on-chain query → real weather + settlement receipt (BscScan tx)

A quick read-only smoke test: `node mcp/test.mjs`.
