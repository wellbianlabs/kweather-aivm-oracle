"use strict";

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ethers = hre.ethers;

/**
 * Deploy the full stack: KWT token -> SubscriptionManager -> KWeatherOracle, then wire
 * the oracle as the subscription manager's authorized consumer. Writes addresses to
 * deployments.<network>.json.
 */
async function main() {
  const [deployer, treasury] = await ethers.getSigners();
  const treasuryAddr = treasury ? treasury.address : deployer.address;

  const DEC = 18n;
  const ONE = 10n ** DEC;
  const monthlyPrice = 100n * ONE; // 100 KWT / month
  const queriesPerMonth = 1000n; // rate limit per subscribed month
  const pricePerQuery = 1n * ONE; // 1 KWT / query (pay-per-query)

  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Treasury:  ${treasuryAddr}`);

  const Token = await ethers.getContractFactory("MockERC20");
  const token = await Token.deploy("KWeather Token", "KWT");
  await token.waitForDeployment();

  const SM = await ethers.getContractFactory("SubscriptionManager");
  const sm = await SM.deploy(
    await token.getAddress(),
    treasuryAddr,
    monthlyPrice,
    queriesPerMonth,
    pricePerQuery
  );
  await sm.waitForDeployment();

  const Oracle = await ethers.getContractFactory("KWeatherOracle");
  const oracle = await Oracle.deploy(await sm.getAddress());
  await oracle.waitForDeployment();

  await (await sm.setOracle(await oracle.getAddress())).wait();

  const out = {
    network: hre.network.name,
    token: await token.getAddress(),
    subscriptionManager: await sm.getAddress(),
    oracle: await oracle.getAddress(),
    treasury: treasuryAddr,
    pricing: {
      monthlyPrice: monthlyPrice.toString(),
      queriesPerMonth: queriesPerMonth.toString(),
      pricePerQuery: pricePerQuery.toString(),
    },
  };

  const file = path.join(__dirname, "..", `deployments.${hre.network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log("\nDeployed:");
  console.log(`  KWT token            ${out.token}`);
  console.log(`  SubscriptionManager  ${out.subscriptionManager}`);
  console.log(`  KWeatherOracle       ${out.oracle}`);
  console.log(`\nSaved -> ${path.relative(process.cwd(), file)}`);
  return out;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { main };
