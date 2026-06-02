"use strict";

// Deploy the EIP-3009 settlement token for x402 keyless payments to the testnet,
// mint test balances. Run: npx hardhat run scripts/deploy-x402.js --network bscTestnet

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ethers = hre.ethers;

function loadWallets() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".secrets", "wallets.json"), "utf8"));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const w = loadWallets();
  const UNIT = 10n ** 6n; // 6 decimals (USDC-style)

  console.log("Deployer:", deployer.address);
  const Token = await ethers.getContractFactory("EIP3009Token");
  const token = await Token.deploy("x402 USD", "x402USD", 6);
  await token.waitForDeployment();
  const addr = await token.getAddress();

  // mint test balances: agent (consumer) + deployer
  await (await token.mint(w.agent.address, 100n * UNIT)).wait(); // 100 x402USD
  await (await token.mint(deployer.address, 1000n * UNIT)).wait();
  console.log("x402USD:", addr, "| minted 100 to agent, 1000 to deployer");

  const out = {
    network: hre.network.name,
    chainId: w.chainId,
    explorer: "https://testnet.bscscan.com",
    x402Token: addr,
    decimals: 6,
    payTo: deployer.address, // treasury / receiver
    settler: w.relayer.address, // submits transferWithAuthorization (has gas)
  };
  fs.writeFileSync(path.join(__dirname, "..", `deployments.x402.${hre.network.name}.json`), JSON.stringify(out, null, 2));
  console.log("wrote deployments.x402." + hre.network.name + ".json");
  console.log("payTo (receiver):", out.payTo, "| settler:", out.settler);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
