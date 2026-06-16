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
  const temperature = num(d.temp, d.senseTemp);
  const humidity = d.humi != null && d.humi !== "" ? Math.round(num(d.humi)) : 0;
  return obs(Math.floor(Date.now() / 1000), temperature, humidity, d.rainF, d.ws, d.wd);
}

// --- K-Weather world 3-day hourly forecast (kw-world-3d1): builds an hourly series (+0h..) ---
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
    const t = kstHour(d.date[i], d.nHour && d.nHour[i]);
    out.push(obs(t, num(d.temp[i]), Math.round(num(d.humi && d.humi[i])), d.rainF && d.rainF[i], d.ws && d.ws[i], d.wd && d.wd[i]));
  }
  return out;
}

// build a normalized 11-field observation; K-Weather world has no PM/solar/UV -> 0
function obs(time, temperature, humidity, rainF, ws, wd) {
  return {
    time,
    temperature: r1(temperature),
    humidity,
    precipitation: rainF != null && rainF !== "" ? r1(num(rainF)) : 0,
    windSpeed: r1(num(ws)),
    windDirection: compassToDeg(wd) || 0,
    pm10: 0,
    pm25: 0,
    solarRadiation: 0,
    uvIndex: 0,
    discomfortIndex: r1(discomfort(temperature, humidity)),
  };
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
