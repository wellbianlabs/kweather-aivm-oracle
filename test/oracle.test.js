"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { scaleObservation, toTuple, unscale } = require("../oracle-node/scaler");
const { KWeatherClient } = require("../oracle-node/kweatherClient");
const { REGIONS } = require("../oracle-node/regions");

const ONE = 10n ** 18n;
const SEOUL = 1168000000;

async function deployFixture() {
  const [deployer, treasury, agent, agent2] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockERC20")).deploy("KWeather Token", "KWT");
  const sm = await (await ethers.getContractFactory("SubscriptionManager")).deploy(
    await token.getAddress(),
    treasury.address,
    100n * ONE,
    5n, // small allowance to test rate limiting
    1n * ONE
  );
  const oracle = await (await ethers.getContractFactory("KWeatherOracle")).deploy(await sm.getAddress());
  await sm.setOracle(await oracle.getAddress());

  await token.mint(agent.address, 1000n * ONE);
  await token.mint(agent2.address, 1000n * ONE);

  return { deployer, treasury, agent, agent2, token, sm, oracle };
}

function sampleTuple(ts) {
  const client = new KWeatherClient(); // mock
  const obs = client._mock(REGIONS[0], ts);
  return { obs, tuple: toTuple(scaleObservation(obs)) };
}

describe("KWeatherOracle", () => {
  it("scales floats to fixed-point and round-trips", () => {
    const scaled = scaleObservation({
      timestamp: 1735689600,
      temperature: -3.27,
      humidity: 58,
      precipitation: 4.25,
      windSpeed: 2.5,
      windDirection: 180,
      pm10: 41,
      pm25: 22,
      solarRadiation: 4.25,
      uvIndex: 7.3,
      discomfortIndex: 65.1,
    });
    expect(scaled.temperature).to.equal(-327n);
    expect(scaled.solarRadiation).to.equal(425n); // PRD example: 4.25 MJ/m² -> 425
    expect(scaled.uvIndex).to.equal(73n);

    const back = unscale({
      timestamp: 1735689600n,
      temperature: -327n,
      humidity: 58n,
      precipitation: 425n,
      windSpeed: 250n,
      windDirection: 180n,
      pm10: 41n,
      pm25: 22n,
      solarRadiation: 425n,
      uvIndex: 73n,
      discomfortIndex: 651n,
    });
    expect(back.temperature).to.be.closeTo(-3.27, 1e-9);
    expect(back.solarRadiation).to.be.closeTo(4.25, 1e-9);
  });

  it("only authorized relayers can push", async () => {
    const { oracle, agent } = await deployFixture();
    const { tuple } = sampleTuple(1735689600);
    await expect(oracle.connect(agent).pushWeather(SEOUL, tuple)).to.be.revertedWith("KW: not relayer");
    await expect(oracle.pushWeather(SEOUL, tuple)).to.not.be.reverted; // deployer is relayer
  });

  it("registers regions once and indexes them", async () => {
    const { oracle } = await deployFixture();
    const codes = REGIONS.map((r) => r.code);
    const tuples = REGIONS.map((r) => toTuple(scaleObservation(new KWeatherClient()._mock(r, 1735689600))));
    await oracle.pushBatch(codes, tuples);
    await oracle.pushBatch(codes, tuples); // second round must not duplicate registrations
    expect(await oracle.regionCount()).to.equal(BigInt(REGIONS.length));
    expect(await oracle.observationCount(SEOUL)).to.equal(2n);
  });

  it("returns history in chronological order", async () => {
    const { oracle, agent, token, sm } = await deployFixture();
    for (let h = 0; h < 5; h++) {
      const { tuple } = sampleTuple(1735689600 + h * 3600);
      await oracle.pushWeather(SEOUL, tuple);
    }
    await token.connect(agent).approve(await sm.getAddress(), 100n * ONE);
    await sm.connect(agent).subscribe(1);

    const hist = await oracle.connect(agent).queryHistory.staticCall(SEOUL, 3);
    expect(hist.length).to.equal(3);
    // timestamps strictly increasing (oldest first)
    expect(hist[0].timestamp).to.be.lessThan(hist[1].timestamp);
    expect(hist[1].timestamp).to.be.lessThan(hist[2].timestamp);
    // last entry is the most recent push
    expect(hist[2].timestamp).to.equal(1735689600n + 4n * 3600n);
  });

  it("meters subscription quota and enforces the rate limit", async () => {
    const { oracle, agent, token, sm } = await deployFixture();
    const { tuple } = sampleTuple(1735689600);
    await oracle.pushWeather(SEOUL, tuple);

    await token.connect(agent).approve(await sm.getAddress(), 100n * ONE);
    await sm.connect(agent).subscribe(1); // allowance = 5

    for (let i = 0; i < 5; i++) {
      await oracle.connect(agent).queryLatest(SEOUL);
    }
    const q = await sm.quotaOf(agent.address);
    expect(q.allowance).to.equal(0n);
    // 6th call: no subscription quota and no prepaid -> revert
    await expect(oracle.connect(agent).queryLatest(SEOUL)).to.be.revertedWith(
      "SM: no active quota or prepaid credit"
    );
  });

  it("falls back to pay-per-query when subscription is exhausted", async () => {
    const { oracle, agent2, token, sm } = await deployFixture();
    const { tuple } = sampleTuple(1735689600);
    await oracle.pushWeather(SEOUL, tuple);

    await token.connect(agent2).approve(await sm.getAddress(), 10n * ONE);
    await sm.connect(agent2).depositPrepaid(3n * ONE); // 3 queries worth

    // no subscription -> uses prepaid
    await oracle.connect(agent2).queryLatest(SEOUL);
    expect(await sm.prepaidBalance(agent2.address)).to.equal(2n * ONE);
  });

  it("unauthorized caller cannot consume quota directly", async () => {
    const { sm, agent } = await deployFixture();
    await expect(sm.connect(agent).consume(agent.address)).to.be.revertedWith("SM: only oracle");
  });
});
