// K-Weather Korea (domestic, 동단위) on-chain scaling. Tuple order matches
// KWeatherKoreaOracle.KWeatherKoreaData.
function scaleObs(o) {
  return [
    BigInt(Math.trunc(o.time != null ? o.time : o.timestamp)),
    BigInt(Math.round(o.temperature * 100)),
    BigInt(Math.round((o.senseTemp != null ? o.senseTemp : o.temperature) * 100)),
    BigInt(Math.round(o.humidity)),
    BigInt(Math.round((o.precipitation || 0) * 100)),
    BigInt(Math.round((o.windSpeed || 0) * 100)),
    BigInt(Math.round(o.windDirection || 0)),
    BigInt(Math.round((o.pm10 || 0) * 10)),
    BigInt(Math.round((o.pm25 || 0) * 10)),
    BigInt(Math.round((o.discomfortIndex || 0) * 10)),
  ];
}
function unscale(d) {
  return {
    timestamp: Number(d[0]),
    temperature: Number(d[1]) / 100,
    senseTemp: Number(d[2]) / 100,
    humidity: Number(d[3]),
    precipitation: Number(d[4]) / 100,
    windSpeed: Number(d[5]) / 100,
    windDirection: Number(d[6]),
    pm10: Number(d[7]) / 10,
    pm25: Number(d[8]) / 10,
    discomfortIndex: Number(d[9]) / 10,
  };
}
const KOREA_TUPLE = "tuple(uint256 timestamp,int256 temperature,int256 senseTemp,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pm10,uint256 pm25,uint256 discomfortIndex)";
module.exports = { scaleObs, unscale, KOREA_TUPLE };
