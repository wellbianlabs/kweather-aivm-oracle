"use strict";

/**
 * Fixed-point scaling layer (PRD §5.1).
 *
 * K-Weather Premium API returns Web2 JSON floats. EVM/AIVM has no native floats, so
 * every value is converted to an integer with a documented scaling factor. These
 * factors MUST match the on-chain struct comments in contracts/KWeatherOracle.sol.
 */

const SCALE = Object.freeze({
  temperature: 100, // °C * 100
  humidity: 1, // %
  precipitation: 100, // mm * 100
  windSpeed: 100, // m/s * 100
  windDirection: 1, // degrees
  pm10: 1, // ㎍/㎥
  pm25: 1, // ㎍/㎥
  solarRadiation: 100, // MJ/m² * 100
  uvIndex: 10, // index * 10
  discomfortIndex: 10, // index * 10
});

/**
 * Ordered field list — MUST match the Solidity struct member order so the value can
 * be passed to ethers as a tuple.
 */
const FIELD_ORDER = Object.freeze([
  "timestamp",
  "temperature",
  "humidity",
  "precipitation",
  "windSpeed",
  "windDirection",
  "pm10",
  "pm25",
  "solarRadiation",
  "uvIndex",
  "discomfortIndex",
]);

function toFixed(value, factor) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 0n;
  }
  // Math.round handles negatives correctly (e.g. temperature below 0 °C).
  return BigInt(Math.round(Number(value) * factor));
}

/**
 * @param {object} obs human-unit observation, see kweatherClient.js normalizeObservation
 * @returns {object} struct keyed by field name, values as BigInt
 */
function scaleObservation(obs) {
  return {
    timestamp: BigInt(Math.trunc(Number(obs.timestamp))),
    temperature: toFixed(obs.temperature, SCALE.temperature),
    humidity: toFixed(obs.humidity, SCALE.humidity),
    precipitation: toFixed(obs.precipitation, SCALE.precipitation),
    windSpeed: toFixed(obs.windSpeed, SCALE.windSpeed),
    windDirection: toFixed(obs.windDirection, SCALE.windDirection),
    pm10: toFixed(obs.pm10, SCALE.pm10),
    pm25: toFixed(obs.pm25, SCALE.pm25),
    solarRadiation: toFixed(obs.solarRadiation, SCALE.solarRadiation),
    uvIndex: toFixed(obs.uvIndex, SCALE.uvIndex),
    discomfortIndex: toFixed(obs.discomfortIndex, SCALE.discomfortIndex),
  };
}

/** Convert a scaled struct into the ordered tuple ethers expects. */
function toTuple(scaled) {
  return FIELD_ORDER.map((f) => scaled[f]);
}

/** Inverse of scaleObservation — turn an on-chain record back into human units. */
function unscale(record) {
  return {
    timestamp: Number(record.timestamp),
    temperature: Number(record.temperature) / SCALE.temperature,
    humidity: Number(record.humidity) / SCALE.humidity,
    precipitation: Number(record.precipitation) / SCALE.precipitation,
    windSpeed: Number(record.windSpeed) / SCALE.windSpeed,
    windDirection: Number(record.windDirection) / SCALE.windDirection,
    pm10: Number(record.pm10) / SCALE.pm10,
    pm25: Number(record.pm25) / SCALE.pm25,
    solarRadiation: Number(record.solarRadiation) / SCALE.solarRadiation,
    uvIndex: Number(record.uvIndex) / SCALE.uvIndex,
    discomfortIndex: Number(record.discomfortIndex) / SCALE.discomfortIndex,
  };
}

module.exports = { SCALE, FIELD_ORDER, scaleObservation, toTuple, unscale, toFixed };
