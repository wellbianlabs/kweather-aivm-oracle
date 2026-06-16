/* KWeather × AIVM Oracle — global weather explorer (4,255 sellable cities).
   Real data via /api/weather — K-Weather 세계날씨 only (world realtime + hourly forecast).
   Deterministic mock fallback when offline. */
"use strict";

const GH_URL = "https://github.com/wellbianlabs/kweather-aivm-oracle";

const CITIES = (window.CITIES || []).map(([id, name, cc, lat, lon]) => ({ id, name, cc, lat, lon }));
const CITY_BY_ID = new Map(CITIES.map((c) => [c.id, c]));
const FEATURED = (window.FEATURED || []).map((f) => ({ id: f.id, name: f.name, cc: f.country, lat: f.lat, lon: f.lon }));

// GeoNames id -> K-Weather world city code (kw-world-r1). The /api/weather feed resolves
// the world code from the GeoNames id automatically (see lib/worldcodes.json).
const WORLDCODE = {
  1796236: 15107, 745044: 15127, 2332459: 16089, 1566083: 17963, 1275339: 15098,
  3448439: 15063, 3530597: 15033, 524901: 15010, 1185241: 15055, 1850147: 15104,
  2643743: 15082, 2988507: 15134, 5128581: 15039, 1816670: 15106, 292223: 15071,
};

const SCALE = { temperature: 100, humidity: 1, precipitation: 100, windSpeed: 100, windDirection: 1, pm10: 1, pm25: 1, solarRadiation: 100, uvIndex: 10, discomfortIndex: 10 };
const VEC_DIRS_KO = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
const VEC_DIRS_EN = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const dirOf = (deg) => (window.KW && window.KW.lang === "en" ? VEC_DIRS_EN : VEC_DIRS_KO)[Math.round((deg % 360) / 45) % 8];
const scaleField = (v, f) => Math.round(v * f);

// ---- mock fallback ----
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
function mockHour(city, hour) {
  const seed = (Number(city.id) % 9973) + hour * 131;
  const rnd = mulberry32(seed);
  const solar = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
  const bias = Math.round((Math.abs(city.lat) - 25) * -0.3);
  const temperature = r1(14 + 12 * solar + bias + (rnd() - 0.5) * 2);
  const humidity = clamp(Math.round(80 - 40 * solar + (rnd() - 0.5) * 10), 10, 100);
  return {
    time: 1735689600 + hour * 3600, temperature, humidity,
    precipitation: rnd() > 0.85 ? r1(rnd() * 6) : 0,
    windSpeed: r1(1 + rnd() * 6.5), windDirection: Math.round(rnd() * 360),
    pm10: Math.round(15 + rnd() * 60), pm25: Math.round(8 + rnd() * 32),
    solarRadiation: r2(solar * (2.8 + rnd() * 0.6)), uvIndex: r1(solar * (8 + rnd() * 2)),
    discomfortIndex: r1(computeDiscomfort(temperature, humidity)),
  };
}
const mockSeries = (city) => Array.from({ length: 24 }, (_, h) => mockHour(city, h));

// i18n helper for dynamic strings (re-renders on toggle via KW.onLang below)
const t = (ko, en) => (window.KW ? window.KW.t(ko, en) : ko);

// ---- data store ----
const DATA = { source: "…", real: false, byId: {} };
let WORKING = FEATURED.slice();
let SELECTED = WORKING[0] ? WORKING[0].id : null;
let IDX = 12;

async function loadCity(city) {
  const wc = WORLDCODE[city.id] ? `&worldcode=${WORLDCODE[city.id]}` : "";
  const r = await fetch(`/api/weather?lat=${city.lat}&lon=${city.lon}&code=${city.id}${wc}`);
  if (!r.ok) throw new Error("api " + r.status);
  const j = await r.json();
  if (!j.series || !j.series.length) throw new Error("empty");
  DATA.byId[city.id] = j.series;
  return j.source;
}
async function loadReal() {
  const sources = await Promise.all(WORKING.map((c) => loadCity(c).catch(() => null)));
  const got = sources.filter(Boolean);
  if (!got.length) throw new Error("no data");
  DATA.real = true;
  DATA.source = t("케이웨더 세계날씨", "K-Weather world weather");
}

const seriesOf = (city) => (DATA.real && DATA.byId[city.id] ? DATA.byId[city.id] : mockSeries(city));
const lenOf = (city) => seriesOf(city).length;
const windowOf = (city, idx) => seriesOf(city).slice(0, idx + 1);
const obsAt = (city, idx) => { const s = seriesOf(city); return s[Math.min(idx, s.length - 1)]; };
const selCity = () => CITY_BY_ID.get(SELECTED) || WORKING.find((c) => c.id === SELECTED) || WORKING[0];

// ---- agents ----
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function energyForecast(series, cap = { solar: 1000, wind: 500 }) {
  const day = series.filter((o) => o.solarRadiation > 0);
  const ss = day.length ? day : series;
  const avgSolar = mean(ss.map((o) => o.solarRadiation));
  const avgWind = mean(series.map((o) => o.windSpeed));
  const solarKw = Math.min(cap.solar, avgSolar * 0.2778 * 5000 * 0.2);
  const windKw = windPower(avgWind, cap.wind);
  const util = (solarKw + windKw) / (cap.solar + cap.wind);
  const kwh = Math.round((solarKw + windKw) * 6);
  let action = util >= 0.6 ? { type: "SELL_POWER", label: t("전력 판매 / PPA 체결", "Sell power / sign PPA"), cls: "d-sell" }
    : util >= 0.3 ? { type: "HOLD", label: t("포지션 유지", "Hold position"), cls: "d-hold" }
    : { type: "BUY_HEDGE", label: t("DeFi 파생 헤지", "DeFi derivative hedge"), cls: "d-buy" };
  return { avgSolar: r2(avgSolar), avgWind: r2(avgWind), kwh, util: r2(util), action };
}
function windPower(ws, cap) {
  const cutIn = 3, rated = 12;
  if (ws < cutIn) return 0; if (ws >= rated) return cap;
  return cap * Math.pow((ws - cutIn) / (rated - cutIn), 3);
}
function agritech(series) {
  const cumRain = series.reduce((s, o) => s + o.precipitation, 0);
  const avgTemp = mean(series.map((o) => o.temperature));
  let risk, cls, pos;
  if (cumRain > 30) { risk = t("HIGH (침수·병충해)", "HIGH (flood/pest)"); cls = "d-buy"; pos = t("선도계약 매도 (SELL)", "Sell forward (SELL)"); }
  else if (cumRain > 10) { risk = "MODERATE"; cls = "d-hold"; pos = t("포지션 유지 (HOLD)", "Hold (HOLD)"); }
  else { risk = "LOW"; cls = "d-ok"; pos = t("매수 우호 (BUY)", "Buy-favorable (BUY)"); }
  return { cumRain: r1(cumRain), avgTemp: r1(avgTemp), risk, cls, pos };
}
function logistics(o) {
  const events = [];
  if (o.windSpeed >= 5.5) events.push(t("돌풍", "Gusts"));
  if (o.pm10 >= 70) events.push(t("고농도 미세먼지", "High PM"));
  if (o.precipitation > 0 && o.temperature <= 2) events.push(t("기습 강설", "Sudden snow"));
  if (o.precipitation >= 3) events.push(t("강우", "Rain"));
  if (events.length) {
    const payout = events.some((e) => e === t("기습 강설", "Sudden snow") || e === t("돌풍", "Gusts"));
    return { events, cls: payout ? "d-alert" : "d-hold", action: payout ? t("경로 재탐색 + 배송지연 보험 자동 청구·지급", "Reroute + auto delay-insurance payout") : t("경로 재탐색 (감속 운행)", "Reroute (slow down)") };
  }
  return { events: [t("정상", "Normal")], cls: "d-ok", action: t("정상 운행 · 청구 없음", "Normal ops · no claim") };
}

// ---- helpers ----
const cityLabel = (c) => `${c.name}, ${c.cc}`;
const hhmm = (u) => { const d = new Date(u * 1000); return String(d.getHours()).padStart(2, "0") + ":00"; };
const labelAt = (c, idx) => (DATA.real ? hhmm(obsAt(c, idx).time) : String(idx).padStart(2, "0") + ":00");
function condOf(o) {
  if (o.precipitation > 0 && o.temperature <= 2) return t("눈", "Snow");
  if (o.precipitation >= 3) return t("비", "Rain"); if (o.precipitation > 0) return t("약한 비", "Light rain");
  if (o.solarRadiation > 1.5) return t("맑음", "Clear"); if (o.solarRadiation > 0.3) return t("구름 조금", "Partly cloudy"); return t("구름 많음", "Cloudy");
}
function pmBadge(v) {
  if (v <= 30) return `<span class="badge b-good">${t("좋음", "Good")}</span>`;
  if (v <= 80) return `<span class="badge b-warn">${t("보통", "Moderate")}</span>`;
  return `<span class="badge b-bad">${t("나쁨", "Bad")}</span>`;
}

// ---- render ----
function renderCities() {
  const grid = document.getElementById("regionGrid");
  grid.innerHTML = WORKING.map((c) => {
    const o = obsAt(c, IDX);
    const sel = c.id === SELECTED ? " sel" : "";
    const removable = !FEATURED.some((f) => f.id === c.id);
    return `
    <div class="rcard${sel}" data-id="${c.id}">
      <div class="rcard-top">
        <div>
          <div class="rcard-name">${c.name} <span class="rcard-code">${c.cc}</span></div>
          <div class="rcard-code">geonameid ${c.id}${removable ? ` · <span class="rm" data-rm="${c.id}">✕ ${t("제거", "remove")}</span>` : ""}</div>
        </div>
        <div style="text-align:right">
          <div class="rcard-temp">${o.temperature.toFixed(1)}<small>℃</small></div>
          <div class="rcard-cond">${condOf(o)}</div>
        </div>
      </div>
      <div class="rcard-rows">
        <div class="rrow"><span class="k">${t("습도", "Humidity")}</span><span class="v">${o.humidity}%</span></div>
        <div class="rrow"><span class="k">${t("강수량", "Precipitation")}</span><span class="v">${o.precipitation.toFixed(1)} mm<span class="raw">×100 ${scaleField(o.precipitation, 100)}</span></span></div>
        <div class="rrow"><span class="k">${t("풍속 · 풍향", "Wind · dir")}</span><span class="v">${o.windSpeed.toFixed(1)} m/s ${dirOf(o.windDirection)}</span></div>
        <div class="rrow"><span class="k">${t("체감온도", "Feels-like")}</span><span class="v">${(o.senseTemp ?? o.temperature).toFixed(1)} ℃</span></div>
        <div class="rrow"><span class="k">${t("기압", "Pressure")}</span><span class="v">${o.pressure ? o.pressure.toFixed(0) : "—"} hPa</span></div>
        <div class="rrow"><span class="k">${t("가시거리", "Visibility")}</span><span class="v">${o.visibility || "—"} m</span></div>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".rcard").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target.dataset.rm) { removeCity(Number(ev.target.dataset.rm)); return; }
      SELECTED = Number(el.dataset.id); IDX = lenOf(selCity()) - 1; renderAll();
    })
  );
}

function renderStruct() {
  const c = selCity();
  const o = obsAt(c, IDX);
  document.getElementById("structRegion").textContent = `${cityLabel(c)} @ ${labelAt(c, IDX)}`;
  const line = (ty, nm, vl, cm) => `    <span class="ty">${ty}</span> <span class="nm">${nm}</span> = <span class="vl">${vl}</span>; <span class="cm">// ${cm}</span>`;
  const st = o.senseTemp ?? o.temperature;
  document.getElementById("structCode").innerHTML =
`<span class="cm">// KWeatherWorldData — region(geonameid) ${c.id}</span>
KWeatherWorldData({
${line("uint256", "timestamp", o.time, t("관측 유닉스", "obs unix"))}
${line("int256 ", "temperature", scaleField(o.temperature, 100), `${o.temperature}℃ × 100`)}
${line("int256 ", "senseTemp", scaleField(st, 100), `${t("체감", "feels")} ${st}℃ × 100`)}
${line("uint256", "humidity", o.humidity, "%")}
${line("uint256", "precipitation", scaleField(o.precipitation, 100), `${o.precipitation}mm × 100`)}
${line("uint256", "windSpeed", scaleField(o.windSpeed, 100), `${o.windSpeed}m/s × 100`)}
${line("uint256", "windDirection", o.windDirection, t("도", "deg"))}
${line("uint256", "pressure", scaleField(o.pressure || 0, 100), `${t("기압", "pressure")} hPa × 100`)}
${line("uint256", "visibility", o.visibility || 0, "m")}
${line("uint256", "snowfall", scaleField(o.snowfall || 0, 100), `${t("적설", "snow")} cm × 100`)}
${line("uint256", "discomfortIndex", scaleField(o.discomfortIndex, 10), `${t("불쾌지수", "discomfort")} × 10`)}
})`;
  const fields = [[t("기온", "Temp"), o.temperature, "℃", 100], [t("체감온도", "Feels"), st, "℃", 100], [t("강수량", "Precip"), o.precipitation, "mm", 100], [t("풍속", "Wind"), o.windSpeed, "m/s", 100], [t("기압", "Pressure"), o.pressure || 0, "hPa", 100], [t("불쾌지수", "Discomfort"), o.discomfortIndex, "idx", 10]];
  document.getElementById("scaleTable").innerHTML = fields.map(([f, v, u, fac]) =>
    `<div class="srow"><span class="f">${f}</span><span class="fl">${v} ${u}</span><span class="op">× ${fac}</span><span class="it">${scaleField(v, fac)}</span></div>`).join("");
}

function renderAgents() {
  const c = selCity();
  const win = windowOf(c, IDX);
  const latest = win[win.length - 1];
  const e = energyForecast(win);
  document.getElementById("energyBody").innerHTML = `
    <div class="metric"><span class="k">${t("대상 도시", "City")}</span><span class="v">${cityLabel(c)}</span></div>
    <div><div class="big-num">${e.kwh.toLocaleString()} <small>kWh / 6h</small></div></div>
    <div class="metric"><span class="k">${t("평균 풍속", "Avg wind")}</span><span class="v">${e.avgWind} m/s</span></div>
    <div class="metric"><span class="k">${t("예측 가동률", "Est. capacity factor")}</span><span class="v">${(e.util * 100).toFixed(0)}%</span></div>
    <div class="decision ${e.action.cls}"><span class="lbl">${t("결정", "Decision")}</span> ${e.action.label} <b>(${e.action.type})</b></div>
    <div class="q-meter">${t("구독 쿼리 1회 차감 · 잔여 한도 998/1000", "1 subscription query used · 998/1000 left")}</div>`;
  const a = agritech(win);
  document.getElementById("agriBody").innerHTML = `
    <div class="metric"><span class="k">${t("대상 지역", "Region")}</span><span class="v">${cityLabel(c)}</span></div>
    <div><div class="big-num">${a.cumRain} <small>${t(`mm 누적강수 (${win.length}h)`, `mm cum. rain (${win.length}h)`)}</small></div></div>
    <div class="metric"><span class="k">${t("평균 기온", "Avg temp")}</span><span class="v">${a.avgTemp} ℃</span></div>
    <div class="metric"><span class="k">${t("최신 습도", "Latest humidity")}</span><span class="v">${latest.humidity}%</span></div>
    <div class="decision ${a.cls}"><span class="lbl">${t("리스크", "Risk")}</span> ${a.risk}</div>
    <div class="decision ${a.cls}"><span class="lbl">${t("포지션", "Position")}</span> ${a.pos}</div>
    <div class="q-meter">${t("종량제 1 KWT 차감 · 선불 잔액 8 KWT", "1 KWT pay-per-query · 8 KWT prepaid left")}</div>`;
  const l = logistics(latest);
  document.getElementById("logiBody").innerHTML = `
    <div class="metric"><span class="k">${t("감지 도시", "City")}</span><span class="v">${cityLabel(c)}</span></div>
    <div class="metric"><span class="k">${t("풍속", "Wind")}</span><span class="v">${latest.windSpeed} m/s</span></div>
    <div class="metric"><span class="k">${t("체감온도", "Feels-like")}</span><span class="v">${(latest.senseTemp ?? latest.temperature).toFixed(1)} ℃</span></div>
    <div class="metric"><span class="k">${t("강수 · 기온", "Precip · temp")}</span><span class="v">${latest.precipitation} mm · ${latest.temperature}℃</span></div>
    <div class="metric"><span class="k">${t("기상 이벤트", "Weather events")}</span><span class="v">${l.events.join(", ")}</span></div>
    <div class="decision ${l.cls}"><span class="lbl">${t("자율 조치", "Autonomous action")}</span> ${l.action}</div>
    <div class="q-meter">${t("종량제 1 KWT 차감 · 온체인 보험 트리거", "1 KWT pay-per-query · on-chain insurance trigger")}</div>`;
}

function renderFlow() {
  const o = obsAt(selCity(), IDX);
  document.getElementById("flowRaw").textContent = `temp ${o.temperature.toFixed(2)} ℃`;
  document.getElementById("flowScaled").textContent = `×100 → ${scaleField(o.temperature, 100)}`;
}
function renderAll() {
  const hl = document.getElementById("hourLabel"); if (hl) hl.textContent = labelAt(selCity(), IDX);
  const sp = document.getElementById("srcPill"); if (sp) sp.textContent = DATA.source;
  renderFlow(); renderCities(); renderStruct(); renderAgents();
}

// ---- search / working set ----
async function addCity(city) {
  if (WORKING.some((c) => c.id === city.id)) { SELECTED = city.id; renderAll(); return; }
  WORKING.push(city);
  SELECTED = city.id;
  renderAll();
  if (DATA.real) { try { await loadCity(city); } catch {} renderAll(); }
}
function removeCity(id) {
  WORKING = WORKING.filter((c) => c.id !== id);
  if (SELECTED === id) SELECTED = WORKING[0] && WORKING[0].id;
  renderAll();
}
function wireSearch() {
  const box = document.getElementById("citySearch");
  const list = document.getElementById("searchResults");
  if (!box) return;
  const render = (q) => {
    q = q.trim().toLowerCase();
    if (!q) { list.innerHTML = ""; list.style.display = "none"; return; }
    const hits = [];
    for (const c of CITIES) {
      if (c.name.toLowerCase().startsWith(q) || (c.name + ", " + c.cc).toLowerCase().includes(q)) {
        hits.push(c); if (hits.length >= 12) break;
      }
    }
    list.innerHTML = hits.map((c) => `<div class="sres" data-id="${c.id}">${c.name} <span class="cc">${c.cc}</span></div>`).join("");
    list.style.display = hits.length ? "block" : "none";
    list.querySelectorAll(".sres").forEach((el) => el.addEventListener("click", () => {
      addCity(CITY_BY_ID.get(Number(el.dataset.id)));
      box.value = ""; list.innerHTML = ""; list.style.display = "none";
    }));
  };
  box.addEventListener("input", () => render(box.value));
  box.addEventListener("blur", () => setTimeout(() => (list.style.display = "none"), 200));
  box.addEventListener("focus", () => box.value && render(box.value));
}

// ---- init ----
async function init() {
  document.getElementById("ghLink").href = GH_URL;
  document.getElementById("ghLinkFoot").href = GH_URL;
  wireSearch();

  try {
    await loadReal();
    IDX = lenOf(selCity()) - 1; // always show the latest observation
  } catch (e) {
    DATA.real = false; DATA.source = t("MOCK (오프라인)", "MOCK (offline)"); IDX = lenOf(selCity()) - 1;
  }
  if (window.KW) window.KW.onLang(() => {
    DATA.source = DATA.real ? t("케이웨더 세계날씨", "K-Weather world weather") : t("MOCK (오프라인)", "MOCK (offline)");
    renderAll();
  });
  renderAll();
}
document.addEventListener("DOMContentLoaded", init);
