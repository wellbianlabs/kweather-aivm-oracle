/* KWeather × AIVM Oracle — dashboard driven by REAL weather (Open-Meteo / K-Weather
   premium via /api/weather), with a deterministic mock fallback when offline.
   Mirrors oracle-node/{kweatherClient,scaler}.js + agent/energyAgent.js in the browser. */
"use strict";

const GH_URL = "https://github.com/wellbianlabs/kweather-aivm-oracle";

const REGIONS = [
  { code: 1168000000, name: "서울 강남구", lat: 37.5172, lon: 127.0473 },
  { code: 2611000000, name: "부산 중구", lat: 35.1064, lon: 129.0323 },
  { code: 4617000000, name: "전남 나주시", lat: 35.0158, lon: 126.7108 },
  { code: 4380000000, name: "충북 영동군", lat: 36.175, lon: 127.7765 },
  { code: 5011000000, name: "제주 제주시", lat: 33.4996, lon: 126.5312 },
];

const SCALE = { temperature: 100, humidity: 1, precipitation: 100, windSpeed: 100, windDirection: 1, pm10: 1, pm25: 1, solarRadiation: 100, uvIndex: 10, discomfortIndex: 10 };
const VEC_DIRS = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
const dirOf = (deg) => VEC_DIRS[Math.round((deg % 360) / 45) % 8];
const scaleField = (v, f) => Math.round(v * f);

// ---- deterministic mock fallback (mirrors kweatherClient._mock) ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const computeDiscomfort = (t, h) => 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function mockHour(region, hour) {
  const seed = (Number(region.code) % 9973) + hour * 131;
  const rnd = mulberry32(seed);
  const solarCurve = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
  const bias = (Number(region.code) % 7) - 3;
  const temperature = r1(12 + 13 * solarCurve + bias + (rnd() - 0.5) * 2);
  const humidity = clamp(Math.round(85 - 45 * solarCurve + (rnd() - 0.5) * 10), 10, 100);
  return {
    time: 1735689600 + hour * 3600,
    temperature,
    humidity,
    precipitation: rnd() > 0.85 ? r1(rnd() * 6) : 0,
    windSpeed: r1(1 + rnd() * 6.5),
    windDirection: Math.round(rnd() * 360),
    pm10: Math.round(20 + rnd() * 65),
    pm25: Math.round(10 + rnd() * 35),
    solarRadiation: r2(solarCurve * (2.8 + rnd() * 0.6)),
    uvIndex: r1(solarCurve * (8 + rnd() * 2)),
    discomfortIndex: r1(computeDiscomfort(temperature, humidity)),
  };
}
function mockSeries(region) {
  return Array.from({ length: 24 }, (_, h) => mockHour(region, h));
}

// ---- data store: real series per region, with mock fallback ----
const DATA = { source: "MOCK", real: false, byCode: {} };

async function loadReal() {
  const results = await Promise.all(
    REGIONS.map(async (rg) => {
      const r = await fetch(`/api/weather?lat=${rg.lat}&lon=${rg.lon}&code=${rg.code}`);
      if (!r.ok) throw new Error(`api ${r.status}`);
      const j = await r.json();
      if (!j.series || !j.series.length) throw new Error("empty");
      return { code: rg.code, series: j.series, source: j.source };
    })
  );
  for (const x of results) DATA.byCode[x.code] = x.series;
  DATA.real = true;
  DATA.source = results[0].source === "kweather+open-meteo" ? "KWEATHER 실시간" : "OPEN-METEO 실시간";
}

function seriesOf(region) {
  return DATA.real && DATA.byCode[region.code] ? DATA.byCode[region.code] : mockSeries(region);
}
const lenOf = (region) => seriesOf(region).length;
// observation window from start up to the selected index (inclusive)
function windowOf(region, idx) {
  return seriesOf(region).slice(0, idx + 1);
}
function obsAt(region, idx) {
  const s = seriesOf(region);
  return s[Math.min(idx, s.length - 1)];
}

// ---- agents (operate on real or mock series identically) ----
function energyForecast(series, cap = { solar: 1000, wind: 500 }) {
  const day = series.filter((o) => o.solarRadiation > 0);
  const ss = day.length ? day : series;
  const avgSolar = mean(ss.map((o) => o.solarRadiation));
  const avgWind = mean(series.map((o) => o.windSpeed));
  const solarKw = Math.min(cap.solar, avgSolar * 0.2778 * 5000 * 0.2);
  const windKw = windPower(avgWind, cap.wind);
  const util = (solarKw + windKw) / (cap.solar + cap.wind);
  const kwh = Math.round((solarKw + windKw) * 6);
  let action;
  if (util >= 0.6) action = { type: "SELL_POWER", label: "전력 판매 / PPA 체결", cls: "d-sell" };
  else if (util >= 0.3) action = { type: "HOLD", label: "포지션 유지", cls: "d-hold" };
  else action = { type: "BUY_HEDGE", label: "DeFi 파생 헤지", cls: "d-buy" };
  return { avgSolar: r2(avgSolar), avgWind: r2(avgWind), kwh, util: r2(util), action };
}
function windPower(ws, cap) {
  const cutIn = 3, rated = 12;
  if (ws < cutIn) return 0;
  if (ws >= rated) return cap;
  return cap * Math.pow((ws - cutIn) / (rated - cutIn), 3);
}
function agritech(series) {
  const cumRain = series.reduce((s, o) => s + o.precipitation, 0);
  const avgTemp = mean(series.map((o) => o.temperature));
  let risk, cls, pos;
  if (cumRain > 30) { risk = "HIGH (침수·병충해)"; cls = "d-buy"; pos = "선도계약 매도 (SELL)"; }
  else if (cumRain > 10) { risk = "MODERATE"; cls = "d-hold"; pos = "포지션 유지 (HOLD)"; }
  else { risk = "LOW"; cls = "d-ok"; pos = "매수 우호 (BUY)"; }
  return { cumRain: r1(cumRain), avgTemp: r1(avgTemp), risk, cls, pos };
}
function logistics(o) {
  const events = [];
  if (o.windSpeed >= 5.5) events.push("돌풍");
  if (o.pm10 >= 70) events.push("고농도 미세먼지");
  if (o.precipitation > 0 && o.temperature <= 2) events.push("기습 강설");
  if (o.precipitation >= 3) events.push("강우");
  if (events.length) {
    const payout = events.some((e) => e === "기습 강설" || e === "돌풍");
    return { events, cls: payout ? "d-alert" : "d-hold",
      action: payout ? "경로 재탐색 + 배송지연 보험 자동 청구·지급" : "경로 재탐색 (감속 운행)" };
  }
  return { events: ["정상"], cls: "d-ok", action: "정상 운행 · 청구 없음" };
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ---- state ----
let IDX = 12;
let SELECTED = REGIONS[0].code;
let playTimer = null;

// ---- helpers ----
function hhmm(unix) {
  const d = new Date(unix * 1000);
  return String(d.getHours()).padStart(2, "0") + ":00";
}
function labelAt(region, idx) {
  return DATA.real ? hhmm(obsAt(region, idx).time) : String(idx).padStart(2, "0") + ":00";
}
function condOf(o) {
  if (o.precipitation > 0 && o.temperature <= 2) return "눈";
  if (o.precipitation >= 3) return "비";
  if (o.precipitation > 0) return "약한 비";
  if (o.solarRadiation > 1.5) return "맑음";
  if (o.solarRadiation > 0.3) return "구름 조금";
  return "구름 많음";
}
function pmBadge(v) {
  if (v <= 30) return `<span class="badge b-good">좋음</span>`;
  if (v <= 80) return `<span class="badge b-warn">보통</span>`;
  return `<span class="badge b-bad">나쁨</span>`;
}

// ---- render ----
function renderRegions() {
  const grid = document.getElementById("regionGrid");
  grid.innerHTML = REGIONS.map((rg) => {
    const o = obsAt(rg, IDX);
    const sel = rg.code === SELECTED ? " sel" : "";
    return `
    <div class="rcard${sel}" data-code="${rg.code}">
      <div class="rcard-top">
        <div>
          <div class="rcard-name">${rg.name}</div>
          <div class="rcard-code">code ${rg.code}</div>
        </div>
        <div style="text-align:right">
          <div class="rcard-temp">${o.temperature.toFixed(1)}<small>℃</small></div>
          <div class="rcard-cond">${condOf(o)}</div>
        </div>
      </div>
      <div class="rcard-rows">
        <div class="rrow"><span class="k">습도</span><span class="v">${o.humidity}%<span class="raw">int ${o.humidity}</span></span></div>
        <div class="rrow"><span class="k">강수량</span><span class="v">${o.precipitation.toFixed(1)} mm<span class="raw">×100 ${scaleField(o.precipitation, 100)}</span></span></div>
        <div class="rrow"><span class="k">풍속 · 풍향</span><span class="v">${o.windSpeed.toFixed(1)} m/s ${dirOf(o.windDirection)}<span class="raw">×100 ${scaleField(o.windSpeed, 100)}</span></span></div>
        <div class="rrow"><span class="k">미세먼지 PM10</span><span class="v">${o.pm10} ${pmBadge(o.pm10)}</span></div>
        <div class="rrow"><span class="k">초미세 PM2.5</span><span class="v">${o.pm25} ${pmBadge(o.pm25 * 1.6)}</span></div>
        <div class="rrow"><span class="k">일사량</span><span class="v">${o.solarRadiation.toFixed(2)} MJ/m²<span class="raw">×100 ${scaleField(o.solarRadiation, 100)}</span></span></div>
        <div class="rrow"><span class="k">자외선</span><span class="v">UV ${o.uvIndex.toFixed(1)}<span class="raw">×10 ${scaleField(o.uvIndex, 10)}</span></span></div>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".rcard").forEach((el) =>
    el.addEventListener("click", () => { SELECTED = Number(el.dataset.code); renderAll(); })
  );
}

function renderStruct() {
  const rg = REGIONS.find((r) => r.code === SELECTED);
  const o = obsAt(rg, IDX);
  document.getElementById("structRegion").textContent = `${rg.name} @ ${labelAt(rg, IDX)}`;
  const line = (ty, nm, vl, cm) =>
    `    <span class="ty">${ty}</span> <span class="nm">${nm}</span> = <span class="vl">${vl}</span>; <span class="cm">// ${cm}</span>`;
  document.getElementById("structCode").innerHTML =
`<span class="cm">// KWeatherPremiumData — region ${rg.code}</span>
KWeatherPremiumData({
${line("uint256", "timestamp", o.time, "관측 유닉스")}
${line("int256 ", "temperature", scaleField(o.temperature, 100), `${o.temperature}℃ × 100`)}
${line("uint256", "humidity", o.humidity, "%")}
${line("uint256", "precipitation", scaleField(o.precipitation, 100), `${o.precipitation}mm × 100`)}
${line("uint256", "windSpeed", scaleField(o.windSpeed, 100), `${o.windSpeed}m/s × 100`)}
${line("uint256", "windDirection", o.windDirection, "도")}
${line("uint256", "pm10", o.pm10, "㎍/㎥")}
${line("uint256", "pm25", o.pm25, "㎍/㎥")}
${line("uint256", "solarRadiation", scaleField(o.solarRadiation, 100), `${o.solarRadiation} × 100`)}
${line("uint256", "uvIndex", scaleField(o.uvIndex, 10), `${o.uvIndex} × 10`)}
${line("uint256", "discomfortIndex", scaleField(o.discomfortIndex, 10), `불쾌지수 × 10`)}
})`;

  const fields = [
    ["기온", o.temperature, "℃", 100],
    ["강수량", o.precipitation, "mm", 100],
    ["풍속", o.windSpeed, "m/s", 100],
    ["일사량", o.solarRadiation, "MJ/m²", 100],
    ["자외선", o.uvIndex, "idx", 10],
    ["불쾌지수", o.discomfortIndex, "idx", 10],
  ];
  document.getElementById("scaleTable").innerHTML = fields.map(([f, v, u, fac]) =>
    `<div class="srow"><span class="f">${f}</span><span class="fl">${v} ${u}</span><span class="op">× ${fac}</span><span class="it">${scaleField(v, fac)}</span></div>`
  ).join("");
}

function renderAgents() {
  const rg = REGIONS.find((r) => r.code === SELECTED);
  const win = windowOf(rg, IDX);
  const latest = win[win.length - 1];

  const e = energyForecast(win);
  document.getElementById("energyBody").innerHTML = `
    <div class="metric"><span class="k">대상 지역</span><span class="v">${rg.name}</span></div>
    <div><div class="big-num">${e.kwh.toLocaleString()} <small>kWh / 6h</small></div></div>
    <div class="metric"><span class="k">주간 평균 일사량</span><span class="v">${e.avgSolar} MJ/m²</span></div>
    <div class="metric"><span class="k">평균 풍속</span><span class="v">${e.avgWind} m/s</span></div>
    <div class="metric"><span class="k">예측 가동률</span><span class="v">${(e.util * 100).toFixed(0)}%</span></div>
    <div class="decision ${e.action.cls}"><span class="lbl">결정</span> ${e.action.label} <b>(${e.action.type})</b></div>
    <div class="q-meter">구독 쿼리 1회 차감 · 잔여 한도 998/1000</div>`;

  const a = agritech(win);
  document.getElementById("agriBody").innerHTML = `
    <div class="metric"><span class="k">대상 작물</span><span class="v">나주 배</span></div>
    <div><div class="big-num">${a.cumRain} <small>mm 누적강수 (${win.length}h)</small></div></div>
    <div class="metric"><span class="k">평균 기온</span><span class="v">${a.avgTemp} ℃</span></div>
    <div class="metric"><span class="k">최신 습도</span><span class="v">${latest.humidity}%</span></div>
    <div class="decision ${a.cls}"><span class="lbl">리스크</span> ${a.risk}</div>
    <div class="decision ${a.cls}"><span class="lbl">포지션</span> ${a.pos}</div>
    <div class="q-meter">종량제 1 KWT 차감 · 선불 잔액 8 KWT</div>`;

  const l = logistics(latest);
  document.getElementById("logiBody").innerHTML = `
    <div class="metric"><span class="k">감지 지역</span><span class="v">${rg.name}</span></div>
    <div class="metric"><span class="k">풍속</span><span class="v">${latest.windSpeed} m/s</span></div>
    <div class="metric"><span class="k">미세먼지 PM10</span><span class="v">${latest.pm10} ㎍/㎥</span></div>
    <div class="metric"><span class="k">강수 · 기온</span><span class="v">${latest.precipitation} mm · ${latest.temperature}℃</span></div>
    <div class="metric"><span class="k">기상 이벤트</span><span class="v">${l.events.join(", ")}</span></div>
    <div class="decision ${l.cls}"><span class="lbl">자율 조치</span> ${l.action}</div>
    <div class="q-meter">종량제 1 KWT 차감 · 온체인 보험 트리거</div>`;
}

function renderFlow() {
  const rg = REGIONS.find((r) => r.code === SELECTED);
  const o = obsAt(rg, IDX);
  document.getElementById("flowRaw").textContent = `temp ${o.temperature.toFixed(2)} ℃`;
  document.getElementById("flowScaled").textContent = `×100 → ${scaleField(o.temperature, 100)}`;
}

function renderAll() {
  const rg = REGIONS.find((r) => r.code === SELECTED);
  document.getElementById("hourLabel").textContent = labelAt(rg, IDX);
  document.getElementById("srcPill").textContent = DATA.source;
  renderFlow(); renderRegions(); renderStruct(); renderAgents();
}

// ---- wire up ----
async function init() {
  document.getElementById("ghLink").href = GH_URL;
  document.getElementById("ghLinkFoot").href = GH_URL;

  const slider = document.getElementById("hourSlider");
  const play = document.getElementById("playBtn");

  try {
    await loadReal();
    // default to the most recent real hour
    const maxIdx = lenOf(REGIONS[0]) - 1;
    slider.max = String(maxIdx);
    IDX = maxIdx;
  } catch (e) {
    DATA.real = false;
    DATA.source = "MOCK (오프라인)";
    slider.max = "23";
    IDX = 12;
  }
  slider.value = IDX;
  slider.addEventListener("input", () => { IDX = Number(slider.value); renderAll(); });

  play.addEventListener("click", () => {
    if (playTimer) {
      clearInterval(playTimer); playTimer = null;
      play.textContent = "▶ 자동 재생"; play.classList.remove("on");
    } else {
      play.textContent = "⏸ 일시정지"; play.classList.add("on");
      const maxIdx = Number(slider.max);
      playTimer = setInterval(() => {
        IDX = IDX >= maxIdx ? 0 : IDX + 1; slider.value = IDX; renderAll();
      }, 1100);
    }
  });

  renderAll();
}
document.addEventListener("DOMContentLoaded", init);
