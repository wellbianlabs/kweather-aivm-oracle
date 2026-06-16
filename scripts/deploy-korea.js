"use strict";
// Deploy the Korea-domestic stack: a dedicated SubscriptionManager + KWeatherKoreaOracle
// (reusing the KWT token), wire them, authorize the relayer.
//   npx hardhat run scripts/deploy-korea.js --network bscTestnet
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ethers = hre.ethers;

async function main() {
  const [deployer] = await ethers.getSigners();
  const w = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".secrets", "wallets.json"), "utf8"));
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.bscTestnet.json"), "utf8"));
  const ONE = 10n ** 18n;

  const SM = await ethers.getContractFactory("SubscriptionManager");
  const sm = await SM.deploy(dep.token, deployer.address, 100n * ONE, 1000n, 1n * ONE);
  await sm.waitForDeployment();
  const smAddr = await sm.getAddress();
  console.log("Korea SubscriptionManager:", smAddr);

  const Oracle = await ethers.getContractFactory("KWeatherKoreaOracle");
  const oracle = await Oracle.deploy(smAddr);
  await oracle.waitForDeployment();
  const addr = await oracle.getAddress();
  console.log("KWeatherKoreaOracle:", addr);

  await (await oracle.setRelayer(w.relayer.address, true)).wait();
  await (await sm.setOracle(addr)).wait();
  console.log("authorized relayer + SM.setOracle done");

  const out = { network: hre.network.name, token: dep.token, koreaSubscriptionManager: smAddr, koreaOracle: addr, treasury: deployer.address };
  fs.writeFileSync(path.join(__dirname, "..", "deployments.korea.bscTestnet.json"), JSON.stringify(out, null, 2));
  console.log("wrote deployments.korea.bscTestnet.json");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
