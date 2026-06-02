"use strict";

// Deploy a USDT settlement asset for x402 keyless payments to BSC testnet.
// We reuse EIP3009Token so the same token can settle two ways:
//   - EIP-3009 transferWithAuthorization (gasless for payer), and
//   - Uniswap Permit2 permitTransferFrom (the rail real BSC USDT must use,
//     since mainnet USDT supports neither EIP-3009 nor EIP-2612 permit).
// BSC USDT uses 18 decimals (unlike Ethereum USDT's 6), so we match that here.
//   Run: npx hardhat run scripts/deploy-x402-usdt.js --network bscTestnet

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
  const UNIT = 10n ** 18n; // 18 decimals (BSC USDT style)

  console.log("Deployer:", deployer.address);
  const Token = await ethers.getContractFactory("EIP3009Token");
  const token = await Token.deploy("Tether USD", "USDT", 18);
  await token.waitForDeployment();
  const addr = await token.getAddress();

  // mint test balances: agent (consumer) + deployer
  await (await token.mint(w.agent.address, 100n * UNIT)).wait(); // 100 USDT
  await (await token.mint(deployer.address, 1000n * UNIT)).wait();
  console.log("USDT:", addr, "| minted 100 to agent, 1000 to deployer");

  const out = {
    network: hre.network.name,
    chainId: w.chainId,
    explorer: "https://testnet.bscscan.com",
    usdtToken: addr,
    decimals: 18,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", // canonical Permit2 (same address every chain)
    payTo: deployer.address, // treasury / receiver
    settler: w.relayer.address, // submits settlement tx (has gas)
  };
  fs.writeFileSync(path.join(__dirname, "..", `deployments.x402-usdt.${hre.network.name}.json`), JSON.stringify(out, null, 2));
  console.log("wrote deployments.x402-usdt." + hre.network.name + ".json");
  console.log("payTo (receiver):", out.payTo, "| settler:", out.settler);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
