// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SubscriptionManager.sol";

/// @title KWeatherWorldOracle
/// @notice AIVM-optimized on-chain registry for K-Weather 세계날씨 (world) observations.
///         Schema mirrors exactly what the K-Weather world feed (kw-world-r1) provides —
///         no Open-Meteo, no empty fields.
///           - Region/grid-code indexed for O(1) latest lookup.
///           - Per-region ring buffer keeps a rolling time-series for AI inputs.
///           - All float observations are pre-scaled to fixed-point integers off-chain.
///           - Metered reads (`queryLatest`, `queryHistory`) consume subscription / prepaid quota.
contract KWeatherWorldOracle {
    /// @dev Fixed-point K-Weather world record. Scaling is enforced by the off-chain relayer.
    struct KWeatherWorldData {
        uint256 timestamp;       // observation unix timestamp (seconds)
        int256  temperature;     // °C * 100
        int256  senseTemp;       // 체감온도 °C * 100 (can be negative)
        uint256 humidity;        // %  (0-100)
        uint256 precipitation;   // mm * 100
        uint256 windSpeed;       // m/s * 100
        uint256 windDirection;   // degrees 0-360
        uint256 pressure;        // 기압 hPa * 100
        uint256 visibility;      // 가시거리 m
        uint256 snowfall;        // 적설 cm * 100
        uint256 discomfortIndex; // 불쾌지수 * 10
    }

    /// @dev 7 days of hourly observations per region.
    uint256 public constant HISTORY_SIZE = 168;

    address public owner;
    SubscriptionManager public subscription;

    mapping(address => bool) public relayers;

    mapping(uint256 => KWeatherWorldData[HISTORY_SIZE]) private _ring;
    mapping(uint256 => uint256) private _count;

    mapping(uint256 => bool) public regionRegistered;
    uint256[] public regions;

    event RelayerUpdated(address indexed relayer, bool enabled);
    event RegionRegistered(uint256 indexed regionCode);
    event WeatherUpdated(uint256 indexed regionCode, uint256 timestamp, int256 temperature, uint256 count);
    event WeatherQueried(address indexed agent, uint256 indexed regionCode, SubscriptionManager.Mode mode);

    modifier onlyOwner() {
        require(msg.sender == owner, "KW: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "KW: not relayer");
        _;
    }

    constructor(SubscriptionManager _subscription) {
        owner = msg.sender;
        subscription = _subscription;
        relayers[msg.sender] = true;
    }

    // --------- admin ---------

    function setRelayer(address relayer, bool enabled) external onlyOwner {
        relayers[relayer] = enabled;
        emit RelayerUpdated(relayer, enabled);
    }

    function setSubscription(SubscriptionManager _subscription) external onlyOwner {
        subscription = _subscription;
    }

    // --------- ingestion (relayer / TEE oracle node) ---------

    function pushWeather(uint256 regionCode, KWeatherWorldData calldata d) external onlyRelayer {
        _push(regionCode, d);
    }

    function pushBatch(uint256[] calldata regionCodes, KWeatherWorldData[] calldata data) external onlyRelayer {
        require(regionCodes.length == data.length, "KW: length mismatch");
        for (uint256 i = 0; i < regionCodes.length; i++) {
            _push(regionCodes[i], data[i]);
        }
    }

    function _push(uint256 regionCode, KWeatherWorldData calldata d) internal {
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

    // --------- metered reads (AI agents) ---------

    function queryLatest(uint256 regionCode) external returns (KWeatherWorldData memory) {
        SubscriptionManager.Mode mode = subscription.consume(msg.sender);
        emit WeatherQueried(msg.sender, regionCode, mode);
        return _ring[regionCode][_latestIndex(regionCode)];
    }

    function queryHistory(uint256 regionCode, uint256 count) external returns (KWeatherWorldData[] memory) {
        SubscriptionManager.Mode mode = subscription.consume(msg.sender);
        emit WeatherQueried(msg.sender, regionCode, mode);
        return _readHistory(regionCode, count);
    }

    // --------- public views (free, unmetered) ---------

    function peekLatest(uint256 regionCode) external view returns (KWeatherWorldData memory) {
        return _ring[regionCode][_latestIndex(regionCode)];
    }

    function peekHistory(uint256 regionCode, uint256 count) external view returns (KWeatherWorldData[] memory) {
        return _readHistory(regionCode, count);
    }

    function observationCount(uint256 regionCode) external view returns (uint256) {
        return _count[regionCode];
    }

    function getRegions() external view returns (uint256[] memory) {
        return regions;
    }

    function regionCount() external view returns (uint256) {
        return regions.length;
    }

    // --------- internal ---------

    function _latestIndex(uint256 regionCode) internal view returns (uint256) {
        uint256 total = _count[regionCode];
        require(total > 0, "KW: no data");
        return (total - 1) % HISTORY_SIZE;
    }

    function _readHistory(uint256 regionCode, uint256 count) internal view returns (KWeatherWorldData[] memory out) {
        uint256 total = _count[regionCode];
        require(total > 0, "KW: no data");
        if (count > total) count = total;
        if (count > HISTORY_SIZE) count = HISTORY_SIZE;
        out = new KWeatherWorldData[](count);
        uint256 start = total - count;
        for (uint256 i = 0; i < count; i++) {
            out[i] = _ring[regionCode][(start + i) % HISTORY_SIZE];
        }
    }
}
