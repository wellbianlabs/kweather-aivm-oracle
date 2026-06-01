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
    if (process.env.KWEATHER_API_KEY && req.query.code) {
      try {
        const kw = await fetchKWeatherLatest(String(req.query.code));
        if (kw) {
          Object.assign(series[series.length - 1], kw);
          source = "kweather+open-meteo";
        }
      } catch {
        /* premium overlay is best-effort */
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

// K-Weather gateway latest observation (premium overlay). Mirrors oracle-node/kweatherClient.js.
async function fetchKWeatherLatest(code) {
  const base = process.env.KWEATHER_API_URL || "https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";
  const key = process.env.KWEATHER_API_KEY;
  const dc = code;
  const sg = dc.substring(0, 5) + "00000";
  const kw = async (sensor, c) => {
    const r = await fetch(`${base}/${sensor}/${encodeURIComponent(c)}?api_key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.error !== undefined && String(j.error) !== "0") return null;
    const payload = j.data ?? j;
    const first = payload && typeof payload === "object" ? Object.values(payload)[0] : null;
    return (first && first.data) || first || null;
  };
  const wx = (await kw("kw-odam1", dc).catch(() => null)) || (await kw("kw-odam2", sg).catch(() => null));
  if (!wx || wx.t1h == null) return null;
  const dust = (await kw("kw-dust-r1", dc).catch(() => null)) || (await kw("kw-dust-r2", sg).catch(() => null)) || {};
  return {
    temperature: r1(num(wx.t1h)),
    humidity: Math.round(num(wx.reh)),
    precipitation: r1(num(wx.rn1)),
    windSpeed: r1(num(wx.wsd)),
    windDirection: Math.round(num(wx.vec)),
    pm10: Math.round(num(dust.pm10)) || undefined,
    pm25: Math.round(num(dust.pm25)) || undefined,
  };
}

const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const discomfort = (t, h) => 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
