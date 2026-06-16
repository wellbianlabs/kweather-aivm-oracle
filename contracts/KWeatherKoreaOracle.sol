// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SubscriptionManager.sol";

/// @title KWeatherKoreaOracle
/// @notice On-chain registry for K-Weather DOMESTIC (Korea) observations at 법정동(읍면동) level.
///         Region code = 법정동코드 (10 digits). Schema matches the domestic feed (kw-odam +
///         kw-dust): includes PM10/PM2.5 (Korea's air-quality strength), which the world feed lacks.
contract KWeatherKoreaOracle {
    /// @dev Fixed-point K-Weather domestic record (법정동 단위).
    struct KWeatherKoreaData {
        uint256 timestamp;       // observation unix timestamp (seconds)
        int256  temperature;     // 기온 °C * 100
        int256  senseTemp;       // 체감온도 °C * 100
        uint256 humidity;        // 습도 %
        uint256 precipitation;   // 강수 mm * 100
        uint256 windSpeed;       // 풍속 m/s * 100
        uint256 windDirection;   // 풍향 degrees 0-360
        uint256 pm10;            // 미세먼지 ㎍/㎥ * 10
        uint256 pm25;            // 초미세먼지 ㎍/㎥ * 10
        uint256 discomfortIndex; // 불쾌지수 * 10
    }

    uint256 public constant HISTORY_SIZE = 168;

    address public owner;
    SubscriptionManager public subscription;
    mapping(address => bool) public relayers;

    mapping(uint256 => KWeatherKoreaData[HISTORY_SIZE]) private _ring;
    mapping(uint256 => uint256) private _count;
    mapping(uint256 => bool) public regionRegistered;
    uint256[] public regions;

    event RelayerUpdated(address indexed relayer, bool enabled);
    event RegionRegistered(uint256 indexed regionCode);
    event WeatherUpdated(uint256 indexed regionCode, uint256 timestamp, int256 temperature, uint256 count);
    event WeatherQueried(address indexed agent, uint256 indexed regionCode, SubscriptionManager.Mode mode);

    modifier onlyOwner() { require(msg.sender == owner, "KW: not owner"); _; }
    modifier onlyRelayer() { require(relayers[msg.sender], "KW: not relayer"); _; }

    constructor(SubscriptionManager _subscription) {
        owner = msg.sender;
        subscription = _subscription;
        relayers[msg.sender] = true;
    }

    function setRelayer(address relayer, bool enabled) external onlyOwner {
        relayers[relayer] = enabled;
        emit RelayerUpdated(relayer, enabled);
    }
    function setSubscription(SubscriptionManager _subscription) external onlyOwner { subscription = _subscription; }

    function pushWeather(uint256 regionCode, KWeatherKoreaData calldata d) external onlyRelayer { _push(regionCode, d); }
    function pushBatch(uint256[] calldata regionCodes, KWeatherKoreaData[] calldata data) external onlyRelayer {
        require(regionCodes.length == data.length, "KW: length mismatch");
        for (uint256 i = 0; i < regionCodes.length; i++) _push(regionCodes[i], data[i]);
    }
    function _push(uint256 regionCode, KWeatherKoreaData calldata d) internal {
        if (!regionRegistered[regionCode]) {
            regionRegistered[regionCode] = true;
            regions.push(regionCode);
            emit RegionRegistered(regionCode);
        }
        uint256 idx = _count[regionCode] % HISTORY_SIZE;
        _ring[regionCode][idx] = d;
        unchecked { _count[regionCode] += 1; }
        emit WeatherUpdated(regionCode, d.timestamp, d.temperature, _count[regionCode]);
    }

    function queryLatest(uint256 regionCode) external returns (KWeatherKoreaData memory) {
        SubscriptionManager.Mode mode = subscription.consume(msg.sender);
        emit WeatherQueried(msg.sender, regionCode, mode);
        return _ring[regionCode][_latestIndex(regionCode)];
    }
    function queryHistory(uint256 regionCode, uint256 count) external returns (KWeatherKoreaData[] memory) {
        SubscriptionManager.Mode mode = subscription.consume(msg.sender);
        emit WeatherQueried(msg.sender, regionCode, mode);
        return _readHistory(regionCode, count);
    }

    function peekLatest(uint256 regionCode) external view returns (KWeatherKoreaData memory) {
        return _ring[regionCode][_latestIndex(regionCode)];
    }
    function peekHistory(uint256 regionCode, uint256 count) external view returns (KWeatherKoreaData[] memory) {
        return _readHistory(regionCode, count);
    }
    function observationCount(uint256 regionCode) external view returns (uint256) { return _count[regionCode]; }
    function getRegions() external view returns (uint256[] memory) { return regions; }
    function regionCount() external view returns (uint256) { return regions.length; }

    function _latestIndex(uint256 regionCode) internal view returns (uint256) {
        uint256 total = _count[regionCode];
        require(total > 0, "KW: no data");
        return (total - 1) % HISTORY_SIZE;
    }
    function _readHistory(uint256 regionCode, uint256 count) internal view returns (KWeatherKoreaData[] memory out) {
        uint256 total = _count[regionCode];
        require(total > 0, "KW: no data");
        if (count > total) count = total;
        if (count > HISTORY_SIZE) count = HISTORY_SIZE;
        out = new KWeatherKoreaData[](count);
        uint256 start = total - count;
        for (uint256 i = 0; i < count; i++) out[i] = _ring[regionCode][(start + i) % HISTORY_SIZE];
    }
}
