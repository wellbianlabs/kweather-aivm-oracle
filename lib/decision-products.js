// Decision-products engine for the K-Weather on-chain oracle.
//
// Each product is a pure function over an observation + recent history (the same
// fixed-point fields the oracle stores, already unscaled to human units):
//   o / history item = { timestamp, temperature(°C), humidity(%), precipitation(mm),
//     windSpeed(m/s), windDirection(°), pm10, pm25, solarRadiation(MJ/m²),
//     uvIndex, discomfortIndex }
//
// decide(latest, history) -> { signal, action, score(0..1), rationale, metrics }
// These are weather-driven business decisions that are genuinely computable from the
// oracle's data — built so an autonomous agent (or a contract) can act on them.

const r2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sumLast = (h, k, n) => h.slice(-n).reduce((s, o) => s + (o[k] || 0), 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const PRODUCTS = [
  {
    id: "wind-dispatch", name: "Wind Farm Dispatch", emoji: "🌬️", sector: "Energy",
    inputs: ["windSpeed", "history"],
    decide(o, h) {
      const w = mean(h.map((x) => x.windSpeed));
      const cutIn = 3, rated = 12, cutOut = 25;
      const kw = w < cutIn || w >= cutOut ? 0 : w >= rated ? 500 : 500 * Math.pow((w - cutIn) / (rated - cutIn), 3);
      const cf = clamp01(kw / 500);
      const storm = w >= cutOut;
      const signal = storm ? "CUTOUT" : cf >= 0.6 ? "HIGH" : cf >= 0.25 ? "MODERATE" : "LOW";
      const action = storm ? "CURTAIL (강풍 차단 — 안전 정지)" : cf >= 0.6 ? "DISPATCH (최대 송전)" : cf >= 0.25 ? "PARTIAL (부분 가동)" : "STANDBY (대기)";
      return { signal, action, score: r2(cf), rationale: `평균 풍속 ${r2(w)} m/s → 추정 출력 ${Math.round(kw)} kW${storm ? " (컷아웃 25 m/s 초과)" : ""}.`, metrics: { avgWind: r2(w), estKw: Math.round(kw), capacityFactor: r2(cf) } };
    },
  },
  {
    id: "crop-irrigation", name: "Smart Irrigation (Agritech)", emoji: "🌾", sector: "Agriculture",
    inputs: ["precipitation", "temperature", "humidity", "history"],
    decide(o, h) {
      const p24 = sumLast(h, "precipitation", 24);
      const p72 = sumLast(h, "precipitation", 72);
      const et0 = Math.max(0, (o.temperature - 5) * 0.2 + (o.solarRadiation || 0) * 0.1 + (100 - o.humidity) * 0.02); // crude ET proxy (mm/day)
      const deficit = r2(et0 * 1 - p24);
      let signal, action;
      if (p72 < 3 && o.temperature > 28) { signal = "DROUGHT"; action = "IRRIGATE_NOW + 가뭄 경보"; }
      else if (deficit > 2) { signal = "DRY"; action = "IRRIGATE_NOW (관개 실행)"; }
      else if (p24 >= 10) { signal = "WET"; action = "SKIP (관개 중단 — 충분한 강수)"; }
      else { signal = "OK"; action = "SCHEDULE (예정대로/소량)"; }
      return { signal, action, score: clamp01(deficit / 5), rationale: `24h 강수 ${r2(p24)}mm, 증발산 추정 ${r2(et0)}mm → 수분수지 ${deficit}mm (72h 강수 ${r2(p72)}mm).`, metrics: { precip24h: r2(p24), precip72h: r2(p72), et0: r2(et0), waterDeficit: deficit } };
    },
  },
  {
    id: "flood-watch", name: "Flood / Heavy-Rain Watch", emoji: "🌊", sector: "Insurance / Public Safety",
    inputs: ["precipitation", "history"],
    decide(o, h) {
      const p1 = o.precipitation || 0;
      const p6 = sumLast(h, "precipitation", 6);
      const p24 = sumLast(h, "precipitation", 24);
      let signal, action, score;
      if (p6 >= 30 || p24 >= 80) { signal = "WARNING"; action = "EVACUATE_PREP (대피·펌프 가동 / 파라메트릭 지급 트리거)"; score = 1; }
      else if (p6 >= 15 || p24 >= 40) { signal = "WATCH"; action = "MONITOR (배수 점검·경계)"; score = 0.6; }
      else { signal = "CLEAR"; action = "CLEAR (정상)"; score = clamp01(p24 / 80); }
      return { signal, action, score: r2(score), rationale: `시간당 ${r2(p1)}mm · 6h ${r2(p6)}mm · 24h ${r2(p24)}mm 누적.`, metrics: { precip1h: r2(p1), precip6h: r2(p6), precip24h: r2(p24) } };
    },
  },
  {
    id: "heat-demand-response", name: "Cooling Demand Response (Grid)", emoji: "🔥", sector: "Energy / Utilities",
    inputs: ["temperature", "discomfortIndex"],
    decide(o) {
      const t = o.temperature, di = o.discomfortIndex;
      const cdd = Math.max(0, t - 24); // cooling degrees over base 24°C
      let signal, action, score;
      if (t >= 35 || di >= 80) { signal = "EMERGENCY"; action = "EMERGENCY_DR (긴급 수요반응 발동)"; score = 1; }
      else if (t >= 32 || di >= 75) { signal = "PEAK"; action = "PEAK_SHAVE (피크 저감·ESS 방전)"; score = 0.7; }
      else { signal = "NORMAL"; action = "NORMAL (정상 운영)"; score = clamp01(cdd / 11); }
      return { signal, action, score: r2(score), rationale: `기온 ${r2(t)}℃ · 불쾌지수 ${r2(di)} → 냉방도일 ${r2(cdd)}.`, metrics: { temperature: r2(t), discomfortIndex: r2(di), coolingDegrees: r2(cdd) } };
    },
  },
  {
    id: "cold-chain", name: "Cold-Chain Logistics Risk", emoji: "🧊", sector: "Logistics",
    inputs: ["temperature"],
    decide(o) {
      const t = o.temperature;
      let signal, action, score;
      if (t >= 35) { signal = "HEAT_RISK"; action = "REROUTE/REFRIGERATE (적재 냉방 강화·경로 변경)"; score = 1; }
      else if (t >= 30) { signal = "MONITOR"; action = "MONITOR (온도 모니터링 강화)"; score = 0.6; }
      else if (t <= 0) { signal = "FREEZE_RISK"; action = "FREEZE_GUARD (동결 방지)"; score = 0.6; }
      else { signal = "OK"; action = "OK (정상 운송)"; score = clamp01((t - 20) / 15); }
      return { signal, action, score: r2(score), rationale: `외기 ${r2(t)}℃ — 신선/냉장 화물 ${t >= 30 ? "고온 변질 위험" : t <= 0 ? "동결 위험" : "정상"}.`, metrics: { temperature: r2(t) } };
    },
  },
  {
    id: "construction-safety", name: "Construction Site Safety", emoji: "🏗️", sector: "Construction / HSE",
    inputs: ["windSpeed", "precipitation", "temperature"],
    decide(o) {
      const w = o.windSpeed, p = o.precipitation || 0, t = o.temperature;
      let signal, action, score;
      if (w >= 15 || p >= 10) { signal = "STOP"; action = "STOP (크레인·고소작업 중단)"; score = 1; }
      else if (w >= 10 || p >= 2 || t >= 35) { signal = "CAUTION"; action = "CAUTION (작업 제한·폭염/강풍 주의)"; score = 0.6; }
      else { signal = "WORK"; action = "WORK (정상 작업)"; score = clamp01(Math.max(w / 15, p / 10)); }
      return { signal, action, score: r2(score), rationale: `풍속 ${r2(w)} m/s · 시간당 강수 ${r2(p)}mm · 기온 ${r2(t)}℃.`, metrics: { windSpeed: r2(w), precip1h: r2(p), temperature: r2(t) } };
    },
  },
  {
    id: "event-hedge", name: "Outdoor Event Weather Hedge", emoji: "🎪", sector: "Insurance / Events",
    inputs: ["precipitation", "windSpeed", "discomfortIndex", "history"],
    decide(o, h) {
      const p24 = sumLast(h, "precipitation", 24);
      const w = o.windSpeed, di = o.discomfortIndex, p = o.precipitation || 0;
      let signal, action, score;
      if (p >= 5 || p24 >= 20 || w >= 14) { signal = "ADVERSE"; action = "POSTPONE/PAYOUT (연기 또는 파라메트릭 지급)"; score = 1; }
      else if (p24 >= 5 || w >= 9 || di >= 80) { signal = "RISK"; action = "HEDGE (날씨 헤지·우천 대비)"; score = 0.6; }
      else { signal = "FAVORABLE"; action = "CONFIRM (정상 개최)"; score = clamp01(Math.max(p24 / 20, w / 14)); }
      return { signal, action, score: r2(score), rationale: `현재 강수 ${r2(p)}mm/h · 24h ${r2(p24)}mm · 풍속 ${r2(w)} m/s · 불쾌지수 ${r2(di)}.`, metrics: { precip1h: r2(p), precip24h: r2(p24), windSpeed: r2(w), discomfortIndex: r2(di) } };
    },
  },
  {
    id: "tourism-comfort", name: "Tourism Comfort & Dynamic Pricing", emoji: "🏖️", sector: "Travel / Retail",
    inputs: ["temperature", "discomfortIndex", "precipitation"],
    decide(o) {
      const t = o.temperature, di = o.discomfortIndex, p = o.precipitation || 0;
      // comfort 100 best: penalize temp away from 23°C, high discomfort, rain
      let c = 100 - Math.abs(t - 23) * 3 - Math.max(0, di - 70) * 2 - Math.min(40, p * 8);
      c = Math.max(0, Math.min(100, Math.round(c)));
      const signal = c >= 70 ? "EXCELLENT" : c >= 45 ? "FAIR" : "POOR";
      const action = c >= 70 ? "PEAK_PRICING (성수 가격·프로모션)" : c >= 45 ? "NORMAL (정상 가격)" : "DISCOUNT (실내대안·할인)";
      return { signal, action, score: r2(c / 100), rationale: `쾌적도 ${c}/100 (기온 ${r2(t)}℃·불쾌 ${r2(di)}·강수 ${r2(p)}mm).`, metrics: { comfortScore: c, temperature: r2(t), discomfortIndex: r2(di) } };
    },
  },
  {
    id: "wildfire-risk", name: "Wildfire / Fire-Weather Risk", emoji: "🔥", sector: "Insurance / Public Safety",
    inputs: ["humidity", "temperature", "windSpeed", "precipitation", "history"],
    decide(o, h) {
      const rh = o.humidity, t = o.temperature, w = o.windSpeed;
      const p168 = sumLast(h, "precipitation", Math.min(168, h.length));
      // simple fire-weather proxy
      const dry = rh < 30 && p168 < 5;
      let signal, action, score;
      if (dry && t > 30 && w > 5) { signal = "EXTREME"; action = "RED_FLAG (화재경보·통제 / 파라메트릭 트리거)"; score = 1; }
      else if (rh < 40 && w > 3 && p168 < 10) { signal = "ELEVATED"; action = "ELEVATED (예방순찰·발화원 관리)"; score = 0.6; }
      else { signal = "LOW"; action = "LOW (정상)"; score = clamp01((40 - rh) / 40); }
      return { signal, action, score: r2(score), rationale: `습도 ${r2(rh)}% · 기온 ${r2(t)}℃ · 풍속 ${r2(w)} m/s · 7일 강수 ${r2(p168)}mm.`, metrics: { humidity: r2(rh), temperature: r2(t), windSpeed: r2(w), precip7d: r2(p168) } };
    },
  },
  {
    id: "heat-stress", name: "Heat / Cold Stress (Felt Temp)", emoji: "🌡️", sector: "HSE / Health",
    inputs: ["senseTemp"],
    decide(o) {
      const st = o.senseTemp != null ? o.senseTemp : o.temperature;
      let signal, action, score;
      if (st >= 38) { signal = "EXTREME_HEAT"; action = "STOP (옥외작업 중단·온열질환 경보)"; score = 1; }
      else if (st >= 33) { signal = "HIGH_HEAT"; action = "LIMIT (휴식주기 단축·수분공급)"; score = 0.7; }
      else if (st <= -10) { signal = "EXTREME_COLD"; action = "COLD_GUARD (한랭질환 경보)"; score = 1; }
      else if (st <= 0) { signal = "COLD"; action = "WARM (방한·동상 주의)"; score = 0.6; }
      else { signal = "NORMAL"; action = "OK (정상)"; score = clamp01((st - 26) / 12); }
      return { signal, action, score: r2(score), rationale: `체감온도 ${r2(st)}℃ (기온 ${r2(o.temperature)}℃).`, metrics: { senseTemp: r2(st), airTemp: r2(o.temperature) } };
    },
  },
  {
    id: "storm-pressure", name: "Storm / Low-Pressure Watch", emoji: "🌀", sector: "Insurance / Marine",
    inputs: ["pressure", "windSpeed"],
    decide(o) {
      const pa = o.pressure || 0, w = o.windSpeed;
      let signal, action, score;
      if ((pa > 0 && pa < 990) || w >= 17) { signal = "STORM"; action = "ALERT (폭풍·저기압 경보 / 운항 통제)"; score = 1; }
      else if ((pa > 0 && pa < 1000) || w >= 11) { signal = "UNSETTLED"; action = "WATCH (기상 악화 대비)"; score = 0.6; }
      else { signal = "STABLE"; action = "OK (안정)"; score = pa ? clamp01((1013 - pa) / 23) : clamp01(w / 17); }
      return { signal, action, score: r2(score), rationale: `기압 ${r2(pa)}hPa · 풍속 ${r2(w)} m/s.`, metrics: { pressure: r2(pa), windSpeed: r2(w) } };
    },
  },
  {
    id: "visibility-ops", name: "Visibility Operations (Aviation/Road/Marine)", emoji: "🌫️", sector: "Transport",
    inputs: ["visibility"],
    decide(o) {
      const v = o.visibility || 0;
      let signal, action, score;
      if (v > 0 && v < 1000) { signal = "FOG"; action = "HALT/DELAY (저시정 — 운항 지연·서행)"; score = 1; }
      else if (v > 0 && v < 4000) { signal = "LOW"; action = "CAUTION (감속·등화 점등)"; score = 0.6; }
      else { signal = "CLEAR"; action = "GO (정상)"; score = v ? clamp01((6000 - v) / 6000) : 0; }
      return { signal, action, score: r2(score), rationale: `가시거리 ${v} m.`, metrics: { visibility: v } };
    },
  },
  {
    id: "snow-ops", name: "Snow Removal / Winter Logistics", emoji: "❄️", sector: "Logistics / Public",
    inputs: ["snowfall", "temperature"],
    decide(o) {
      const s = o.snowfall || 0, t = o.temperature;
      let signal, action, score;
      if (s >= 5) { signal = "HEAVY_SNOW"; action = "DEPLOY (제설차 투입·도로 통제)"; score = 1; }
      else if (s >= 1) { signal = "SNOW"; action = "PREP (제설 준비·염화칼슘 살포)"; score = 0.6; }
      else if (t <= 0) { signal = "FREEZE"; action = "ANTI_ICE (결빙 대비)"; score = 0.4; }
      else { signal = "CLEAR"; action = "OK (정상)"; score = clamp01(s / 5); }
      return { signal, action, score: r2(score), rationale: `적설 ${r2(s)}cm · 기온 ${r2(t)}℃.`, metrics: { snowfall: r2(s), temperature: r2(t) } };
    },
  },
  {
    id: "air-quality-ops", name: "Air-Quality Operations Gate", emoji: "😷", sector: "HSE / Logistics (KR)",
    inputs: ["pm25", "pm10"],
    decide(o) {
      const pm25 = o.pm25 || 0, pm10 = o.pm10 || 0;
      let signal, action, score;
      if (pm25 >= 75 || pm10 >= 150) { signal = "HAZARD"; action = "HALT (실외작업 중단·마스크 의무)"; score = 1; }
      else if (pm25 >= 35 || pm10 >= 80) { signal = "UNHEALTHY"; action = "LIMIT (노출 제한·민감군 보호)"; score = 0.6; }
      else { signal = "GOOD"; action = "GO (정상)"; score = clamp01(pm25 / 75); }
      return { signal, action, score: r2(score), rationale: `PM2.5 ${pm25} ㎍/㎥ · PM10 ${pm10} ㎍/㎥.`, metrics: { pm25, pm10 } };
    },
  },
];

const BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

function list() {
  return PRODUCTS.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, sector: p.sector, inputs: p.inputs }));
}
function get(id) { return BY_ID.get(String(id)); }
function decide(id, latest, history) {
  const p = BY_ID.get(String(id));
  if (!p) return null;
  const out = p.decide(latest, history || []);
  return { product: p.id, name: p.name, emoji: p.emoji, sector: p.sector, ...out };
}
function decideAll(latest, history) {
  return PRODUCTS.map((p) => ({ product: p.id, name: p.name, emoji: p.emoji, sector: p.sector, ...p.decide(latest, history || []) }));
}

module.exports = { PRODUCTS, list, get, decide, decideAll };
