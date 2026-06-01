"use strict";

const { unscale } = require("../oracle-node/scaler");

/**
 * Example autonomous AI agent (PRD §4.1): renewable-energy generation forecaster.
 *
 * It consumes the oracle's metered time-series feed and turns recent solar/wind
 * observations into a short-horizon generation forecast and an on-chain action
 * recommendation (e.g. sell power / supply DeFi liquidity).
 *
 * The "model" here is a transparent heuristic standing in for an LSTM/Transformer;
 * the point is the data path, not the ML. `queryHistory` returns exactly the array
 * shape such a model would take as input.
 */
class EnergyForecastAgent {
  /**
   * @param {object} oracle  KWeatherOracle contract connected to the agent's signer
   * @param {object} [plant] asset parameters
   */
  constructor(oracle, plant = {}) {
    this.oracle = oracle;
    this.solarCapacityKw = plant.solarCapacityKw ?? 1000; // 1 MW array
    this.windCapacityKw = plant.windCapacityKw ?? 500; // 0.5 MW turbine
    this.panelEfficiency = plant.panelEfficiency ?? 0.2;
    this.panelAreaM2 = plant.panelAreaM2 ?? 5000;
  }

  /**
   * Pull the last `hours` observations for a region (one metered query) and forecast.
   * @returns {Promise<object>} forecast + recommended action
   */
  async forecast(regionCode, hours = 24) {
    // Single metered call returns the whole window — ideal time-series model input.
    const raw = await this.oracle.queryHistory.staticCall(regionCode, hours);
    // Also send the real (state-changing) tx so quota is actually consumed + logged.
    await (await this.oracle.queryHistory(regionCode, hours)).wait();

    const series = raw.map(unscale);
    return this._predict(regionCode, series);
  }

  _predict(regionCode, series) {
    // Solar generation is forecast over the next PRODUCTIVE (daylight) window, so we
    // average irradiance over the daytime samples in the series rather than the trailing
    // hours (which may be night). This is the diurnal-persistence input an LSTM would learn.
    const daytime = series.filter((o) => o.solarRadiation > 0);
    const solarSamples = daytime.length ? daytime : series;
    const avgSolar = mean(solarSamples.map((o) => o.solarRadiation));
    const avgWind = mean(series.map((o) => o.windSpeed));

    // Solar: MJ/m² → kWh, times area & efficiency. 1 MJ = 0.2778 kWh.
    const solarKwhPerHour = avgSolar * 0.2778 * this.panelAreaM2 * this.panelEfficiency;
    const solarKw = Math.min(this.solarCapacityKw, solarKwhPerHour);

    // Wind: simple cubic curve clamped to capacity, cut-in 3 m/s, rated ~12 m/s.
    const windKw = this._windPower(avgWind);

    const horizonHours = 6;
    const forecastKwh = Math.round((solarKw + windKw) * horizonHours);

    const utilization = (solarKw + windKw) / (this.solarCapacityKw + this.windCapacityKw);
    let action;
    if (utilization >= 0.6) {
      action = { type: "SELL_POWER", reason: "high projected output; lock in PPA / sell surplus", utilization };
    } else if (utilization >= 0.3) {
      action = { type: "HOLD", reason: "moderate output; keep balanced position", utilization };
    } else {
      action = { type: "BUY_HEDGE", reason: "low output; hedge shortfall via energy derivative DeFi", utilization };
    }

    return {
      regionCode: Number(regionCode),
      samples: series.length,
      avgSolarMJ: round2(avgSolar),
      avgWindMs: round2(avgWind),
      forecastKwhProductive6h: forecastKwh,
      utilization: round2(utilization),
      action,
    };
  }

  _windPower(ws) {
    const cutIn = 3,
      rated = 12;
    if (ws < cutIn) return 0;
    if (ws >= rated) return this.windCapacityKw;
    const frac = Math.pow((ws - cutIn) / (rated - cutIn), 3);
    return this.windCapacityKw * frac;
  }
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const round2 = (x) => Math.round(x * 100) / 100;

module.exports = { EnergyForecastAgent };
