require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

// Deployer key: env var first, else the local (gitignored) testnet wallet file.
function deployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  try {
    const f = path.join(__dirname, ".secrets", "wallets.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).deployer.privateKey;
  } catch {}
  return null;
}
const DEPLOYER_KEY = deployerKey();
const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Base Sepolia public testnet (chainId 84532)
    baseSepolia: {
      url: process.env.RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    // BNB Smart Chain testnet (chainId 97)
    bscTestnet: {
      url: process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts,
    },
    // Any EVM/AIVM-compatible network: set RPC_URL + DEPLOYER_PRIVATE_KEY in .env
    custom: {
      url: RPC_URL,
      accounts,
    },
  },
};
