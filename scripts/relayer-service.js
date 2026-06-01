"use strict";

/**
 * Standalone relayer service for a live network (run: npm run relayer).
 *
 * Reads the deployment file, connects with a relayer key over RPC, and pushes a fresh
 * batch of K-Weather observations on a fixed interval. This is the process that would
 * run inside the TEE / enclave node in production (PRD §5.1).
 *
 * Env:
 *   RPC_URL                  EVM/AIVM RPC endpoint
 *   RELAYER_PRIVATE_KEY      key of an address authorized via oracle.setRelayer(...)
 *   DEPLOYMENT_FILE          path to deployments.<network>.json (default: deployments.custom.json)
 *   RELAY_INTERVAL_MS        push cadence (default: 3600000 = 1h)
 *   KWEATHER_API_KEY / URL   if set, pulls real premium data; otherwise mock
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const { KWeatherClient } = require("../oracle-node/kweatherClient");
const { KWeatherRelayer } = require("../oracle-node/relayer");
const { REGIONS } = require("../oracle-node/regions");

// Minimal ABI — just what the relayer calls.
const ORACLE_ABI = [
  "function pushBatch(uint256[] regionCodes, (uint256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[] data) external",
  "function getRegions() view returns (uint256[])",
  "function observationCount(uint256) view returns (uint256)",
];

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!rpcUrl || !key) {
    throw new Error("Set RPC_URL and RELAYER_PRIVATE_KEY in .env");
  }

  const deploymentFile = path.resolve(
    process.env.DEPLOYMENT_FILE || path.join(__dirname, "..", "deployments.custom.json")
  );
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile} (run deploy first)`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const oracle = new ethers.Contract(deployment.oracle, ORACLE_ABI, wallet);

  const client = new KWeatherClient();
  const relayer = new KWeatherRelayer(oracle, client, (m) => console.log(m));

  const intervalMs = Number(process.env.RELAY_INTERVAL_MS || 3600000);
  console.log(`Relayer up. oracle=${deployment.oracle} mode=${client.mode} interval=${intervalMs}ms`);

  const tick = async () => {
    try {
      await relayer.relayOnce(REGIONS);
    } catch (e) {
      console.error("[relayer] tick failed:", e.message);
    }
  };

  await tick();
  setInterval(tick, intervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
