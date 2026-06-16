// Vercel serverless function: real-weather proxy for the oracle dashboard.
//
// Primary source: Open-Meteo (free, no key, real hourly data incl. solar radiation,
// PM10/PM2.5 and UV) — works out of the box on the public demo.
// Premium overlay: if KWEATHER_API_KEY is set in the Vercel project env, the latest
// observation is enriched from the K-Weather gateway (same contract as the oracle node).
//
// Returns 24h of normalized observations (human units) ending at the current hour, so the
// browser can drive the same fixed-point scaling + AI-agent logic with REAL data.

const OM_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OM_AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: "lat & lon query params required" });
    }

    const series = await fetchOpenMeteo(lat, lon);
    if (!series.length) return res.status(502).json({ error: "no data from upstream" });

    let source = "open-meteo";
    // K-Weather premium overlay only for Korean 법정동 codes (10 digits). Global cities
    // use a GeoNames id (<= 8 digits) and stay on Open-Meteo.
    if (process.env.KWEATHER_API_KEY && req.query.code && /^\d{10}$/.test(String(req.query.code))) {
      try {
        const kw = await kweatherFor(String(req.query.code));
        if (kw) {
          const last = series[series.length - 1];
          last.temperature = r1(kw.temperature);
          last.humidity = kw.humidity;
          last.precipitation = r1(kw.precipitation);
          last.windSpeed = r1(kw.windSpeed);
          last.windDirection = kw.windDirection;
          last.discomfortIndex = r1(discomfort(kw.temperature, kw.humidity));
          if (kw.wText) last.condition = kw.wText;
          source = "kweather+open-meteo";
        }
      } catch {
        /* premium overlay is best-effort */
      }
    }

    // K-Weather WORLD weather overlay (kw-world-r1) for global cities — activates when the
    // configured key has 세계날씨 entitlement and a K-Weather world city code is provided.
    // Falls back silently to Open-Meteo otherwise (e.g. demo keys return error 002).
    if (process.env.KWEATHER_API_KEY && req.query.worldcode) {
      try {
        const w = await fetchKWeatherWorld(String(req.query.worldcode));
        if (w) {
          const last = series[series.length - 1];
          last.temperature = r1(w.temperature);
          if (w.humidity != null) last.humidity = w.humidity;
          if (w.precipitation != null) last.precipitation = r1(w.precipitation);
          last.windSpeed = r1(w.windSpeed);
          if (w.windDirection != null) last.windDirection = w.windDirection;
          last.discomfortIndex = r1(discomfort(w.temperature, w.humidity != null ? w.humidity : last.humidity));
          if (w.condition) last.condition = w.condition;
          source = "kweather-world+open-meteo";
        }
      } catch {
        /* world overlay is best-effort */
      }
    }

    return res.status(200).json({ source, series });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};

async function fetchOpenMeteo(lat, lon) {
  const fUrl =
    `${OM_FORECAST}?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,shortwave_radiation` +
    `&wind_speed_unit=ms&past_days=1&forecast_days=1&timezone=auto`;
  const aUrl =
    `${OM_AIR}?latitude=${lat}&longitude=${lon}` +
    `&hourly=pm10,pm2_5,uv_index&past_days=1&forecast_days=1&timezone=auto`;

  const [fr, ar] = await Promise.all([fetch(fUrl), fetch(aUrl).catch(() => null)]);
  if (!fr.ok) throw new Error(`open-meteo ${fr.status}`);
  const f = await fr.json();
  const a = ar && ar.ok ? await ar.json() : null;

  const h = f.hourly || {};
  const times = h.time || [];
  const offset = f.utc_offset_seconds || 0;
  const nowUtc = Date.now() / 1000;

  // air-quality lookup by ISO time string
  const air = {};
  if (a && a.hourly && a.hourly.time) {
    a.hourly.time.forEach((t, i) => {
      air[t] = { pm10: a.hourly.pm10?.[i], pm25: a.hourly.pm2_5?.[i], uv: a.hourly.uv_index?.[i] };
    });
  }

  const toUtc = (iso) => Date.parse(iso + "Z") / 1000 - offset; // local wall-time -> true epoch

  // index of the current (most recent past-or-present) hour
  let cur = -1;
  for (let i = 0; i < times.length; i++) if (toUtc(times[i]) <= nowUtc) cur = i;
  if (cur < 0) cur = times.length - 1;

  const start = Math.max(0, cur - 23);
  const out = [];
  for (let i = start; i <= cur; i++) {
    const iso = times[i];
    const aq = air[iso] || {};
    const temperature = num(h.temperature_2m?.[i]);
    const humidity = num(h.relative_humidity_2m?.[i]);
    const swRad = num(h.shortwave_radiation?.[i]); // W/m²
    out.push({
      time: toUtc(iso),
      temperature: r1(temperature),
      humidity: Math.round(humidity),
      precipitation: r1(num(h.precipitation?.[i])),
      windSpeed: r1(num(h.wind_speed_10m?.[i])),
      windDirection: Math.round(num(h.wind_direction_10m?.[i])),
      pm10: Math.round(num(aq.pm10)),
      pm25: Math.round(num(aq.pm25)),
      solarRadiation: r2(swRad * 0.0036), // W/m² over 1h -> MJ/m²
      uvIndex: r1(num(aq.uv)),
      discomfortIndex: r1(discomfort(temperature, humidity)),
    });
  }
  return out;
}

// K-Weather gateway snapshot (premium overlay). The `apps-odam` sensor returns the
// current observation for the major 시/도 regions in one call. We index it by the first
// two digits of the 법정동코드 (시/도) and overlay the authoritative current values.
let _kwCache = { t: 0, byProvince: null };

async function kweatherSnapshot() {
  if (_kwCache.byProvince && Date.now() - _kwCache.t < 5 * 60 * 1000) return _kwCache.byProvince;
  const base = process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr/weather/w3/v2/kw-sensors";
  const key = process.env.KWEATHER_API_KEY;
  const r = await fetch(`${base}/apps-odam?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`kweather ${r.status}`);
  const j = await r.json();
  if (String(j.error) !== "0" || !j.data) throw new Error(`kweather ${j.message || j.error}`);
  const byProvince = {};
  for (const [code, v] of Object.entries(j.data)) {
    const d = v && v.data;
    if (!d || d.t1h == null) continue;
    byProvince[code.substring(0, 2)] = {
      code,
      state: d.state,
      temperature: num(d.t1h),
      humidity: Math.round(num(d.reh)),
      precipitation: num(d.rn1),
      windSpeed: num(d.wsd),
      windDirection: Math.round(num(d.vec)),
      wText: d.wText,
      ts: v.service && v.service.timestamp,
    };
  }
  _kwCache = { t: Date.now(), byProvince };
  return byProvince;
}

async function kweatherFor(code) {
  const snap = await kweatherSnapshot();
  return snap[String(code).substring(0, 2)] || null;
}

// K-Weather WORLD realtime (kw-world-r1) for a given K-Weather world city code (15000+).
// Requires a key with 세계날씨 entitlement; returns null otherwise (gateway error 002).
// Maps the OpenAPI world schema (temp/humi/ws/wd/rainF) to our normalized fields.
async function fetchKWeatherWorld(worldCode) {
  const base = process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";
  const key = process.env.KWEATHER_API_KEY;
  // kw-world-r1 = world realtime for one city code (15000+). Per the OpenAPI spec the payload
  // is { data: { service, data: { temp, senseTemp, humi, ws, wd(compass), rainF, wIcon, ... } } }.
  const r = await fetch(`${base}/kw-world-r1/${encodeURIComponent(worldCode)}?api_key=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (String(j.error) !== "0" || !j.data) return null;
  let d = j.data.data; // single-city shape
  if (!d && typeof j.data === "object") { const f = Object.values(j.data).find((v) => v && v.data); d = f && f.data; }
  if (!d || (d.temp == null && d.senseTemp == null)) return null;
  return {
    temperature: num(d.temp, d.senseTemp),
    humidity: d.humi != null && d.humi !== "" ? Math.round(num(d.humi)) : null,
    precipitation: d.rainF != null && d.rainF !== "" ? num(d.rainF) : null, // mm; often null -> keep Open-Meteo
    windSpeed: num(d.ws),
    windDirection: compassToDeg(d.wd), // wd is a compass string ("SW"); convert to degrees
  };
}

// 16-point compass label -> degrees (kw-world-r1 returns wind direction as text)
const COMPASS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const compassToDeg = (wd) => {
  if (wd == null || wd === "") return null;
  if (typeof wd === "number" || /^\d+(\.\d+)?$/.test(String(wd))) return Math.round(Number(wd));
  const k = String(wd).toUpperCase().trim();
  return COMPASS[k] != null ? Math.round(COMPASS[k]) : null;
};

// coalescing numeric parse: returns the first usable value (supports fallback field names)
const num = (...xs) => {
  for (const v of xs) {
    if (v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
};
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const discomfort = (t, h) => 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
