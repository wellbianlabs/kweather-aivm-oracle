// Quick MCP client test: spawn the server over stdio, list tools, call read tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: "node", args: [join(__dirname, "server.mjs")], env: { ...process.env } });
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args || {} });
  console.log(`\n# ${name}(${JSON.stringify(args || {})})\n` + r.content[0].text.slice(0, 700));
};

await call("search_cities", { query: "Tokyo" });
await call("get_pricing", {});
await call("get_account", { address: "0x7654dbB95565eb569e4a2aEBa822402338aaB67E" });
await call("get_oracle_status", {});
await call("get_weather", { city: "Paris" });

await client.close();
process.exit(0);
