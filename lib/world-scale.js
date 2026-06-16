// K-Weather world on-chain scaling. Tuple order matches
// KWeatherWorldOracle.KWeatherWorldData: timestamp, temperature, senseTemp, humidity,
// precipitation, windSpeed, windDirection, pressure, visibility, snowfall, discomfortIndex.

// off-chain observation (human units) -> fixed-point tuple for pushBatch
function scaleObs(o) {
  return [
    BigInt(Math.trunc(o.time != null ? o.time : o.timestamp)),
    BigInt(Math.round(o.temperature * 100)),
    BigInt(Math.round((o.senseTemp != null ? o.senseTemp : o.temperature) * 100)),
    BigInt(Math.round(o.humidity)),
    BigInt(Math.round((o.precipitation || 0) * 100)),
    BigInt(Math.round((o.windSpeed || 0) * 100)),
    BigInt(Math.round(o.windDirection || 0)),
    BigInt(Math.round((o.pressure || 0) * 100)),
    BigInt(Math.round(o.visibility || 0)),
    BigInt(Math.round((o.snowfall || 0) * 100)),
    BigInt(Math.round((o.discomfortIndex || 0) * 10)),
  ];
}

// on-chain tuple (ethers Result, indexable) -> observation in human units
function unscale(d) {
  return {
    timestamp: Number(d[0]),
    temperature: Number(d[1]) / 100,
    senseTemp: Number(d[2]) / 100,
    humidity: Number(d[3]),
    precipitation: Number(d[4]) / 100,
    windSpeed: Number(d[5]) / 100,
    windDirection: Number(d[6]),
    pressure: Number(d[7]) / 100,
    visibility: Number(d[8]),
    snowfall: Number(d[9]) / 100,
    discomfortIndex: Number(d[10]) / 10,
  };
}

const ORACLE_TUPLE = "tuple(uint256 timestamp,int256 temperature,int256 senseTemp,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pressure,uint256 visibility,uint256 snowfall,uint256 discomfortIndex)";

module.exports = { scaleObs, unscale, ORACLE_TUPLE };
