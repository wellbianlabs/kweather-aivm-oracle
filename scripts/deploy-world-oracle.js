"use strict";
// Deploy the K-Weather-native oracle (KWeatherWorldOracle) reusing the existing
// SubscriptionManager, authorize the relayer, and rewire SM -> new oracle.
//   npx hardhat run scripts/deploy-world-oracle.js --network bscTestnet
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ethers = hre.ethers;

async function main() {
  const [deployer] = await ethers.getSigners();
  const w = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".secrets", "wallets.json"), "utf8"));
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.bscTestnet.json"), "utf8"));
  console.log("Deployer:", deployer.address, "| SM:", dep.subscriptionManager);

  const Oracle = await ethers.getContractFactory("KWeatherWorldOracle");
  const oracle = await Oracle.deploy(dep.subscriptionManager);
  await oracle.waitForDeployment();
  const addr = await oracle.getAddress();
  console.log("KWeatherWorldOracle:", addr);

  // authorize the Vercel relayer wallet
  await (await oracle.setRelayer(w.relayer.address, true)).wait();
  console.log("authorized relayer:", w.relayer.address);

  // point SubscriptionManager at the new oracle (so metered queryLatest works)
  const sm = await ethers.getContractAt("SubscriptionManager", dep.subscriptionManager);
  await (await sm.setOracle(addr)).wait();
  console.log("SubscriptionManager.setOracle ->", addr);

  // update deployments file (keep previous oracle as oracleLegacy)
  dep.oracleLegacy = dep.oracle;
  dep.oracle = addr;
  fs.writeFileSync(path.join(__dirname, "..", "deployments.bscTestnet.json"), JSON.stringify(dep, null, 2));
  console.log("updated deployments.bscTestnet.json (oracle ->", addr + ", legacy", dep.oracleLegacy + ")");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
