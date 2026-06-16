// Vercel serverless function: K-Weather-only real-weather feed for the oracle.
//
// Source: K-Weather 세계날씨 (gateway) ONLY — `kw-world-r1` realtime + `kw-world-3d1` hourly
// forecast. We expose exactly the fields K-Weather provides for world cities: temperature,
// humidity, wind speed, wind direction, precipitation, and a derived discomfort index.
// (PM10/PM2.5, solar radiation and UV are NOT part of the K-Weather world feed → reported as 0.)
//
// A city must have a K-Weather world code (see lib/worldcodes.json, or ?worldcode=); cities
// outside K-Weather's world coverage return 404.
//
// Env: KWEATHER_API_KEY (required), KWEATHER_API_URL (optional override)

const WORLDCODES = require("../lib/worldcodes.json"); // GeoNames id -> K-Weather world city code
const KW_BASE = process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
  try {
    if (!process.env.KWEATHER_API_KEY) return res.status(503).json({ error: "K-Weather not configured" });

    // DOMESTIC (Korea) — a 10-digit 법정동코드 routes to the K-Weather domestic feed (incl. PM).
    const codeStr = req.query.code ? String(req.query.code) : "";
    if (/^\d{10}$/.test(codeStr)) {
      const current = await fetchKoreaDomestic(codeStr);
      if (!current) return res.status(502).json({ error: "no K-Weather domestic observation for this 법정동" });
      let series = [];
      try { series = await fetchKoreaForecast(codeStr, current); } catch { /* best-effort */ }
      if (!series.length) series = [current];
      else series[series.length - 1] = current;
      return res.status(200).json({ source: "kweather-domestic", current, series });
    }

    const worldCode = req.query.worldcode || (req.query.code && WORLDCODES[String(req.query.code)]);
    if (!worldCode) {
      return res.status(404).json({ error: "city not covered by K-Weather 세계날씨 (no world code)" });
    }

    const current = await fetchKWeatherWorld(String(worldCode));
    if (!current) return res.status(502).json({ error: "no K-Weather observation for this city" });

    let series = [];
    try { series = await fetchKWeatherWorldForecast(String(worldCode)); } catch { /* forecast is best-effort */ }
    // ensure the realtime current observation is the latest point of the series
    if (!series.length) series = [current];
    else series[series.length - 1] = current;

    return res.status(200).json({ source: "kweather-world", current, series });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};

// --- K-Weather world realtime (kw-world-r1): one current observation ---
async function fetchKWeatherWorld(worldCode) {
  const key = process.env.KWEATHER_API_KEY;
  const r = await fetch(`${KW_BASE}/kw-world-r1/${encodeURIComponent(worldCode)}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (String(j.error) !== "0" || !j.data) return null;
  let d = j.data.data;
  if (!d && typeof j.data === "object") { const f = Object.values(j.data).find((v) => v && v.data); d = f && f.data; }
  if (!d || (d.temp == null && d.senseTemp == null)) return null;
  return obs({ time: Math.floor(Date.now() / 1000), temp: d.temp, senseTemp: d.senseTemp, humi: d.humi, rainF: d.rainF, ws: d.ws, wd: d.wd, pa: d.pa, vs: d.vs, snowF: d.snowF, wIcon: d.wIcon, daylight: d.daylight, cityKo: d.cityKo, cityEn: d.cityEn, countryEn: d.countryEn });
}

// --- K-Weather world 3-day hourly forecast (kw-world-3d1): builds an hourly series (+0h..) ---
// Forecast arrays carry temp/humi/wind/precip/snow only (no senseTemp/pressure/visibility).
async function fetchKWeatherWorldForecast(worldCode) {
  const key = process.env.KWEATHER_API_KEY;
  const r = await fetch(`${KW_BASE}/kw-world-3d1/${encodeURIComponent(worldCode)}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return [];
  const j = await r.json();
  if (String(j.error) !== "0" || !j.data) return [];
  let d = j.data.data;
  if (!d && typeof j.data === "object") { const f = Object.values(j.data).find((v) => v && v.data); d = f && f.data; }
  if (!d || !Array.isArray(d.date) || !Array.isArray(d.temp)) return [];
  const n = Math.min(24, d.date.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(obs({ time: kstHour(d.date[i], d.nHour && d.nHour[i]), temp: d.temp[i], humi: d.humi && d.humi[i], rainF: d.rainF && d.rainF[i], ws: d.ws && d.ws[i], wd: d.wd && d.wd[i], snowF: d.snowF && d.snowF[i], wIcon: d.wIcon && d.wIcon[i] }));
  }
  return out;
}

const WICON = { "1": "맑음", "2": "구름조금", "3": "구름많음", "4": "흐림", "5": "비", "6": "비/눈", "7": "눈", "8": "소나기" };

// Build a normalized K-Weather world observation (all fields the world feed provides).
function obs(x) {
  const temperature = num(x.temp, x.senseTemp);
  const humidity = x.humi != null && x.humi !== "" ? Math.round(num(x.humi)) : 0;
  const o = {
    time: x.time,
    temperature: r1(temperature),
    senseTemp: x.senseTemp != null && x.senseTemp !== "" ? r1(num(x.senseTemp)) : r1(temperature),
    humidity,
    precipitation: x.rainF != null && x.rainF !== "" ? r1(num(x.rainF)) : 0,
    windSpeed: r1(num(x.ws)),
    windDirection: compassToDeg(x.wd) || 0,
    pressure: x.pa != null && x.pa !== "" ? r1(num(x.pa)) : 0,
    visibility: x.vs != null && x.vs !== "" ? Math.round(num(x.vs)) : 0,
    snowfall: x.snowF != null && x.snowF !== "" ? r1(num(x.snowF)) : 0,
    discomfortIndex: r1(discomfort(temperature, humidity)),
  };
  if (x.wIcon != null && x.wIcon !== "") o.condition = WICON[String(x.wIcon)] || "";
  if (x.daylight) o.daylight = x.daylight === "N" ? "야간" : "주간";
  if (x.cityKo) o.cityKo = x.cityKo;
  if (x.cityEn) o.cityEn = x.cityEn;
  if (x.countryEn) o.country = x.countryEn;
  return o;
}

// --- DOMESTIC Korea (법정동) : kw-odam1 (현재날씨) + kw-dust-r1 (미세먼지) merged ---
async function kwGet(pathSeg) {
  const key = process.env.KWEATHER_API_KEY;
  const r = await fetch(`${KW_BASE}/${pathSeg}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const j = await r.json();
  return String(j.error) === "0" ? j : null;
}
function firstData(j) {
  if (!j || !j.data) return null;
  if (j.data.data) return j.data.data;
  const f = Object.values(j.data).find((v) => v && v.data);
  return f ? f.data : (typeof j.data === "object" ? j.data : null);
}
async function fetchKoreaDomestic(code) {
  const [odam, dust] = await Promise.all([kwGet(`kw-odam1/${code}`).catch(() => null), kwGet(`kw-dust-r1/${code}`).catch(() => null)]);
  const d = firstData(odam), a = firstData(dust);
  if (!d && !a) return null;
  const temp = num(d && d.t1h, a && a.temp);
  return korObs(Math.floor(Date.now() / 1000), {
    temp, senseTemp: d && d.senseTemp, humidity: Math.round(num(d && d.reh, a && a.humi)),
    rn1: d && d.rn1, wsd: num(d && d.wsd, a && a.ws), vec: num(d && d.vec, a && a.wd),
    pm10: a && a.pm10, pm25: a && a.pm25, wText: d && d.wText, wIcon: d && d.wIcon,
  });
}
async function fetchKoreaForecast(code, current) {
  const j = firstData(await kwGet(`kw-vsrt1/${code}`).catch(() => null));
  if (!j || !Array.isArray(j.tmp)) return [];
  const n = Math.min(6, j.tmp.length), now = Math.floor(Date.now() / 1000), out = [];
  for (let i = 0; i < n; i++) {
    out.push(korObs(now + i * 3600, {
      temp: j.tmp[i], senseTemp: j.tmp[i], humidity: Math.round(num(j.reh && j.reh[i])),
      rn1: j.pcp && j.pcp[i], wsd: num(j.wsd && j.wsd[i]), vec: num(j.vec && j.vec[i]),
      pm10: current.pm10, pm25: current.pm25, wIcon: j.wIcon && j.wIcon[i],
    }));
  }
  return out;
}
function korObs(time, x) {
  const temperature = num(x.temp), humidity = x.humidity || 0;
  const o = {
    time,
    temperature: r1(temperature),
    senseTemp: x.senseTemp != null && x.senseTemp !== "" ? r1(num(x.senseTemp)) : r1(temperature),
    humidity,
    precipitation: x.rn1 != null && x.rn1 !== "" ? r1(num(x.rn1)) : 0,
    windSpeed: r1(num(x.wsd)),
    windDirection: Math.round(num(x.vec)),
    pm10: x.pm10 != null && x.pm10 !== "" ? r1(num(x.pm10)) : 0,
    pm25: x.pm25 != null && x.pm25 !== "" ? r1(num(x.pm25)) : 0,
    discomfortIndex: r1(discomfort(temperature, humidity)),
  };
  if (x.wText) o.condition = x.wText;
  else if (x.wIcon != null && x.wIcon !== "") o.condition = WICON[String(x.wIcon)] || "";
  return o;
}

// "YYYYMMDD" + hour -> epoch seconds (treated as UTC; chart x-axis only)
function kstHour(ymd, hour) {
  const s = String(ymd || "");
  if (s.length < 8) return Math.floor(Date.now() / 1000);
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, day = +s.slice(6, 8);
  return Math.floor(Date.UTC(y, m, day, Number(hour) || 0) / 1000);
}

// 16-point compass label -> degrees (kw-world returns wind direction as text)
const COMPASS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const compassToDeg = (wd) => {
  if (wd == null || wd === "") return null;
  if (typeof wd === "number" || /^\d+(\.\d+)?$/.test(String(wd))) return Math.round(Number(wd));
  const k = String(wd).toUpperCase().trim();
  return COMPASS[k] != null ? Math.round(COMPASS[k]) : null;
};

const num = (...xs) => {
  for (const v of xs) {
    if (v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
};
const r1 = (x) => Math.round(x * 10) / 10;
const discomfort = (t, h) => 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
