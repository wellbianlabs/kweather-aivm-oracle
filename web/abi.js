// Minimal ABIs for the dApp.
window.ABI = {
  token: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function mint(address,uint256)",
  ],
  sm: [
    "function subscribe(uint256 months)",
    "function depositPrepaid(uint256 amount)",
    "function quotaOf(address) view returns (uint256 expiry, uint256 allowance)",
    "function isSubscriptionActive(address) view returns (bool)",
    "function prepaidBalance(address) view returns (uint256)",
    "function monthlyPrice() view returns (uint256)",
    "function pricePerQuery() view returns (uint256)",
    "function queriesPerMonth() view returns (uint256)",
  ],
  oracle: [
    "function peekLatest(uint256) view returns (tuple(uint256 timestamp,int256 temperature,int256 senseTemp,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pressure,uint256 visibility,uint256 snowfall,uint256 discomfortIndex))",
    "function observationCount(uint256) view returns (uint256)",
    "function getRegions() view returns (uint256[])",
    "function queryLatest(uint256) returns (tuple(uint256 timestamp,int256 temperature,int256 senseTemp,uint256 humidity,uint256 precipitation,uint256 windSpeed,uint256 windDirection,uint256 pressure,uint256 visibility,uint256 snowfall,uint256 discomfortIndex))",
    "event WeatherQueried(address indexed agent, uint256 indexed regionCode, uint8 mode)",
  ],
};
