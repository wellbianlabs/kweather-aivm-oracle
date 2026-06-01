"use strict";

/**
 * K-Weather Premium API client (PRD §5.1).
 *
 * REAL mode (when KWEATHER_API_KEY is set) talks to the production K-Weather gateway
 * using the same contract as the Wellbian frontend reference
 * (see reference/kweather-frontend.reference.jsx):
 *
 *   GET {BASE}/{sensor}/{code}?api_key=KEY
 *   BASE = https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors
 *   envelope = { error:"0", message, data: { "<법정동코드>": { data:{...fields} } } }
 *
 * A full observation is assembled from several sensors:
 *   - kw-odam1 / kw-odam2  → 현재 기상 실황 (t1h, reh, rn1, wsd, vec, senseTemp, pty)
 *   - kw-dust-r1 / kw-dust-r2 → 미세먼지 실황 (pm10, pm25)
 *   - kw-fct-idx-uv1       → 시간별 자외선 지수 (uv[])
 *
 * MOCK mode (no key) generates deterministic, physically-plausible data so the whole
 * pipeline runs end-to-end with no external dependency.
 *
 * The API key is the trust boundary (PRD §5.1, TEE/enclave): nothing downstream sees it.
 */

const DEFAULT_BASE_URL = "https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";

const SENSORS = Object.freeze({
  weatherDong: "kw-odam1", // 읍면동 실황
  weatherSigungu: "kw-odam2", // 시군구 실황 (폴백)
  dustDong: "kw-dust-r1",
  dustSigungu: "kw-dust-r2",
  uvDong: "kw-fct-idx-uv1",
});

/**
 * Normalized observation in HUMAN units (floats). The scaler converts these to
 * fixed-point integers before they touch the chain.
 * @typedef {Object} Observation
 * @property {number} timestamp unix seconds
 * @property {number} temperature °C
 * @property {number} humidity %
 * @property {number} precipitation mm
 * @property {number} windSpeed m/s
 * @property {number} windDirection degrees 0-360
 * @property {number} pm10 ㎍/㎥
 * @property {number} pm25 ㎍/㎥
 * @property {number} solarRadiation MJ/m²
 * @property {number} uvIndex index
 * @property {number} discomfortIndex index
 */

class KWeatherClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]  defaults to process.env.KWEATHER_API_KEY
   * @param {string} [opts.baseUrl] defaults to process.env.KWEATHER_API_URL || gateway
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey ?? process.env.KWEATHER_API_KEY ?? null;
    this.baseUrl = (opts.baseUrl ?? process.env.KWEATHER_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Number(opts.timeoutMs ?? process.env.KWEATHER_TIMEOUT_MS ?? 8000);
    this.mode = this.apiKey ? "REAL" : "MOCK";
  }

  /**
   * Fetch a single observation for a region.
   * @param {object} region entry from oracle-node/regions.js
   * @param {number} [atUnix] observation time (defaults to now); used for mock series + UV hour
   * @returns {Promise<Observation>}
   */
  async fetchObservation(region, atUnix) {
    if (this.mode === "REAL") {
      return this._fetchReal(region, atUnix ?? Math.floor(Date.now() / 1000));
    }
    return this._mock(region, atUnix ?? Math.floor(Date.now() / 1000));
  }

  // ---------------- REAL ----------------

  /** Low-level single-sensor call. Returns the inner field object, or null. */
  async _kw(sensor, code) {
    const url = `${this.baseUrl}/${sensor}/${encodeURIComponent(code)}?api_key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`K-Weather ${sensor} HTTP ${res.status}`);
    const j = await res.json();
    if (j.error !== undefined && String(j.error) !== "0") {
      throw new Error(`K-Weather ${sensor} error: ${j.message || j.error}`);
    }
    const payload = j.data ?? j;
    const first = payload && typeof payload === "object" ? Object.values(payload)[0] : null;
    return first?.data ?? first ?? null;
  }

  async _kwSafe(sensor, code) {
    try {
      return await this._kw(sensor, code);
    } catch {
      return null;
    }
  }

  async _fetchReal(region, atUnix) {
    const dc = String(region.code);
    const sg = dc.substring(0, 5) + "00000"; // 시군구 폴백 코드

    // 현재 기상 실황 (읍면동 → 시군구 폴백). 핵심 데이터이므로 둘 다 실패하면 에러.
    let wx = await this._kwSafe(SENSORS.weatherDong, dc);
    if (!wx) wx = await this._kwSafe(SENSORS.weatherSigungu, sg);
    if (!wx || wx.t1h == null) {
      throw new Error(`K-Weather: no 실황 for ${region.name || dc} (${dc}/${sg})`);
    }

    // 미세먼지 + 자외선은 베스트에포트(없으면 0).
    const dust =
      (await this._kwSafe(SENSORS.dustDong, dc)) || (await this._kwSafe(SENSORS.dustSigungu, sg)) || {};
    const uvData = await this._kwSafe(SENSORS.uvDong, dc);

    const hour = new Date(atUnix * 1000).getHours();
    const uvIndex = Array.isArray(uvData?.uv) ? num(uvData.uv[hour]) : num(uvData?.uv, uvData?.v);

    const num0 = (...c) => num(...c);
    const temperature = num0(wx.t1h, wx.ta, wx.temp);
    const humidity = num0(wx.reh, wx.humidity);
    const precipitation = num0(wx.rn1, wx.rain, wx.pcp);
    const windSpeed = num0(wx.wsd, wx.ws);
    const windDirection = num0(wx.vec, wx.wd);
    const pm10 = num0(dust.pm10, dust.PM10);
    const pm25 = num0(dust.pm25, dust.PM25);
    // 일사량(solar radiation)은 이 게이트웨이 센서셋에 노출되지 않음. 프리미엄 일사 센서가
    // 포함된 플랜이면 아래 후보 필드명을 실제 응답에 맞게 추가하세요.
    const solarRadiation = num0(wx.icsr, wx.si, wx.solar, wx.solarRadiation);

    return {
      timestamp: num0(wx.tm, wx.obsTime, atUnix),
      temperature,
      humidity,
      precipitation,
      windSpeed,
      windDirection,
      pm10,
      pm25,
      solarRadiation,
      uvIndex,
      discomfortIndex: num0(wx.di, wx.discomfortIndex) || computeDiscomfort(temperature, humidity),
    };
  }

  // ---------------- MOCK ----------------

  /**
   * Deterministic mock: stable for a given (region, hour) so demos/tests are
   * reproducible. Models a diurnal solar/temperature curve and region-specific bias.
   */
  _mock(region, atUnix) {
    const hour = Math.floor(atUnix / 3600) % 24;
    const seed = (Number(region.code) % 9973) + hour * 131;
    const rnd = mulberry32(seed);

    const solarCurve = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)); // peaks ~13:00
    const regionTempBias = (Number(region.code) % 7) - 3;

    const temperature = round1(12 + 13 * solarCurve + regionTempBias + (rnd() - 0.5) * 2);
    const humidity = clamp(Math.round(85 - 45 * solarCurve + (rnd() - 0.5) * 10), 10, 100);
    const precipitation = rnd() > 0.85 ? round1(rnd() * 6) : 0;
    const windSpeed = round1(1 + rnd() * 6);
    const windDirection = Math.round(rnd() * 360);
    const pm10 = Math.round(20 + rnd() * 60);
    const pm25 = Math.round(10 + rnd() * 35);
    const solarRadiation = round2(solarCurve * (2.8 + rnd() * 0.6));
    const uvIndex = round1(solarCurve * (8 + rnd() * 2));
    const discomfortIndex = round1(computeDiscomfort(temperature, humidity));

    return {
      timestamp: atUnix,
      temperature,
      humidity,
      precipitation,
      windSpeed,
      windDirection,
      pm10,
      pm25,
      solarRadiation,
      uvIndex,
      discomfortIndex,
    };
  }
}

// Discomfort index (불쾌지수), standard Korean formula.
function computeDiscomfort(tempC, humidityPct) {
  return 0.81 * tempC + 0.01 * humidityPct * (0.99 * tempC - 14.3) + 46.3;
}

function num(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== "" && !Number.isNaN(Number(c))) {
      return Number(c);
    }
  }
  return 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

module.exports = { KWeatherClient, computeDiscomfort };
