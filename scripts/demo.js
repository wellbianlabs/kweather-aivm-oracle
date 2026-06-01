"use strict";

/**
 * End-to-end demo of the K-Weather AIVM oracle (run: npm run demo).
 *
 * Pipeline:
 *   1. Deploy KWT token, SubscriptionManager, KWeatherOracle and wire them.
 *   2. Off-chain relayer ingests 24h of (mock or real) K-Weather data for 5 regions,
 *      scaling floats -> fixed-point ints, and pushes them on-chain.
 *   3. Energy agent SUBSCRIBES, pulls the 24h time-series (one metered query) and
 *      produces a 6h generation forecast + on-chain action (PRD §4.1).
 *   4. Agritech agent uses PAY-PER-QUERY to read 나주 latest + history and computes a
 *      cumulative-rainfall / harvest-risk signal (PRD §4.2).
 */

const hre = require("hardhat");
const ethers = hre.ethers;

const { KWeatherClient } = require("../oracle-node/kweatherClient");
const { KWeatherRelayer } = require("../oracle-node/relayer");
const { REGIONS, getRegion } = require("../oracle-node/regions");
const { unscale } = require("../oracle-node/scaler");
const { EnergyForecastAgent } = require("../agent/energyAgent");

const ONE = 10n ** 18n;
const SEOUL = 1168000000;
const JEJU = 5011000000;
const NAJU = 4617000000;

function hr(title) {
  console.log("\n" + "═".repeat(72) + `\n  ${title}\n` + "═".repeat(72));
}

async function main() {
  const [deployer, treasury, energySigner, agriSigner] = await ethers.getSigners();

  // ---- 1. deploy + wire ----
  hr("1. 컨트랙트 배포 및 연결 (Deploy & wire)");
  const token = await (await ethers.getContractFactory("MockERC20")).deploy("KWeather Token", "KWT");
  await token.waitForDeployment();
  const sm = await (await ethers.getContractFactory("SubscriptionManager")).deploy(
    await token.getAddress(),
    treasury.address,
    100n * ONE, // monthlyPrice
    1000n, // queriesPerMonth
    1n * ONE // pricePerQuery
  );
  await sm.waitForDeployment();
  const oracle = await (await ethers.getContractFactory("KWeatherOracle")).deploy(await sm.getAddress());
  await oracle.waitForDeployment();
  await (await sm.setOracle(await oracle.getAddress())).wait();

  console.log(`  KWT token            ${await token.getAddress()}`);
  console.log(`  SubscriptionManager  ${await sm.getAddress()}`);
  console.log(`  KWeatherOracle       ${await oracle.getAddress()}`);

  // fund the two agents with KWT
  await (await token.mint(energySigner.address, 1000n * ONE)).wait();
  await (await token.mint(agriSigner.address, 50n * ONE)).wait();

  // ---- 2. off-chain ingestion: 24h time-series ----
  hr("2. 오라클 노드 인게스천 (K-Weather → 온체인, 24시간 시계열)");
  const client = new KWeatherClient();
  console.log(`  데이터 소스 모드: ${client.mode}${client.mode === "MOCK" ? "  (KWEATHER_API_KEY 미설정 → 결정론적 모의 데이터)" : ""}`);

  const relayer = new KWeatherRelayer(oracle, client, (m) => console.log("  " + m));
  const BASE = 1735689600; // 2025-01-01T00:00:00Z, deterministic
  for (let h = 0; h < 24; h++) {
    await relayer.relayOnce(REGIONS, BASE + h * 3600);
  }
  const regionsOnChain = await oracle.getRegions();
  console.log(`  온체인 등록 지역 수: ${regionsOnChain.length}, 서울 관측 누적: ${await oracle.observationCount(SEOUL)}건`);

  // ---- 3. energy agent: subscription + time-series forecast ----
  hr("3. 신재생 에너지 예측 에이전트 (구독 모델, PRD §4.1)");
  const cost = 100n * ONE; // 1 month
  await (await token.connect(energySigner).approve(await sm.getAddress(), cost)).wait();
  await (await sm.connect(energySigner).subscribe(1)).wait();
  const q0 = await sm.quotaOf(energySigner.address);
  console.log(`  구독 완료 — 잔여 쿼리 한도: ${q0.allowance}, 만료(unix): ${q0.expiry}`);

  const agent = new EnergyForecastAgent(oracle.connect(energySigner), {
    solarCapacityKw: 1000,
    windCapacityKw: 500,
  });

  for (const code of [SEOUL, JEJU]) {
    const f = await agent.forecast(code, 24);
    const region = getRegion(code);
    console.log(
      `\n  [${region.name}] 표본 ${f.samples}h · 주간 평균 일사량 ${f.avgSolarMJ} MJ/m² · 평균 풍속 ${f.avgWindMs} m/s`
    );
    console.log(`     → 주간 6시간 예측 발전량: ${f.forecastKwhProductive6h.toLocaleString()} kWh (가동률 ${f.utilization})`);
    console.log(`     → 자율 결정: ${f.action.type}  (${f.action.reason})`);
  }
  const q1 = await sm.quotaOf(energySigner.address);
  console.log(`\n  구독 쿼리 2회 소비 후 잔여 한도: ${q1.allowance}`);

  // ---- 4. agritech agent: pay-per-query ----
  hr("4. 애그리테크 자율 트레이딩 에이전트 (종량제, PRD §4.2)");
  await (await token.connect(agriSigner).approve(await sm.getAddress(), 10n * ONE)).wait();
  await (await sm.connect(agriSigner).depositPrepaid(10n * ONE)).wait();
  console.log(`  종량제 선불 예치: 10 KWT (호출당 1 KWT 차감)`);

  const agriOracle = oracle.connect(agriSigner);
  // one metered query for the latest observation...
  const latest = unscale(await agriOracle.queryLatest.staticCall(NAJU));
  await (await agriOracle.queryLatest(NAJU)).wait();
  // ...and the 24h history to accumulate rainfall.
  const hist = (await agriOracle.queryHistory.staticCall(NAJU, 24)).map(unscale);
  await (await agriOracle.queryHistory(NAJU, 24)).wait();

  const cumRain = hist.reduce((s, o) => s + o.precipitation, 0);
  const avgTemp = hist.reduce((s, o) => s + o.temperature, 0) / hist.length;
  const risk = cumRain > 30 ? "HIGH (침수/병충해)" : cumRain > 10 ? "MODERATE" : "LOW";
  const position = risk.startsWith("HIGH") ? "SELL (선도계약 매도 — 수확 리스크 헤지)" : "HOLD";

  console.log(`\n  [전남 나주시] 최신 기온 ${latest.temperature.toFixed(1)}℃ · 습도 ${latest.humidity}%`);
  console.log(`     24h 누적 강수량 ${cumRain.toFixed(1)} mm · 평균기온 ${avgTemp.toFixed(1)}℃`);
  console.log(`     → 수확/병충해 리스크: ${risk}`);
  console.log(`     → 자율 결정: 배 선도계약 포지션 ${position}`);

  console.log(`  종량제 잔여 선불금: ${(await sm.prepaidBalance(agriSigner.address)) / ONE} KWT (2회 차감)`);

  // ---- summary ----
  hr("요약 (Summary)");
  console.log(`  Treasury 누적 수익: ${(await token.balanceOf(treasury.address)) / ONE} KWT`);
  console.log(`  (구독 100 KWT + 종량제 선불 10 KWT)`);
  console.log("\n  ✅ 케이웨더 → 오라클 → AI 에이전트 풀 파이프라인 정상 동작\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
