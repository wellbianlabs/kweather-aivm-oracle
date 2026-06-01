// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SubscriptionManager.sol";

/// @title KWeatherOracle
/// @notice AIVM-optimized on-chain registry for K-Weather Premium data (PRD §5.2, §6.1).
///         - Region/grid-code indexed for O(1) latest lookup.
///         - Per-region ring buffer keeps a rolling time-series for LSTM/Transformer inputs.
///         - All float observations are pre-scaled to fixed-point integers off-chain.
///         - Metered reads (`queryLatest`, `queryHistory`) consume subscription / prepaid quota.
contract KWeatherOracle {
    /// @dev Fixed-point weather record. Scaling factors are documented per field and
    ///      enforced by the off-chain relayer (see oracle-node/scaler.js).
    struct KWeatherPremiumData {
        uint256 timestamp;       // observation unix timestamp (seconds)
        int256  temperature;     // °C * 100      (e.g. 23.45 -> 2345)
        uint256 humidity;        // %             (0-100)
        uint256 precipitation;   // mm * 100
        uint256 windSpeed;       // m/s * 100
        uint256 windDirection;   // degrees 0-360
        uint256 pm10;            // ㎍/㎥
        uint256 pm25;            // ㎍/㎥
        uint256 solarRadiation;  // MJ/m² * 100
        uint256 uvIndex;         // index * 10
        uint256 discomfortIndex; // index * 10
    }

    /// @dev 7 days of hourly observations per region.
    uint256 public constant HISTORY_SIZE = 168;

    address public owner;
    SubscriptionManager public subscription;

    mapping(address => bool) public relayers;

    // regionCode => fixed-size ring buffer of observations
    mapping(uint256 => KWeatherPremiumData[HISTORY_SIZE]) private _ring;
    // regionCode => total observations ever written (ring head = (count-1) % HISTORY_SIZE)
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
        relayers[msg.sender] = true; // deployer can relay by default
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

    /// @notice Push one observation for a region.
    function pushWeather(uint256 regionCode, KWeatherPremiumData calldata d) external onlyRelayer {
        _push(regionCode, d);
    }

    /// @notice Push observations for many regions in a single transaction.
    function pushBatch(uint256[] calldata regionCodes, KWeatherPremiumData[] calldata data)
        external
        onlyRelayer
    {
        require(regionCodes.length == data.length, "KW: length mismatch");
        for (uint256 i = 0; i < regionCodes.length; i++) {
            _push(regionCodes[i], data[i]);
        }
    }

    function _push(uint256 regionCode, KWeatherPremiumData calldata d) internal {
        if (!regionRegistered[regionCode]) {
            regionRegistered[regionCode] = true;
            regions.push(regionCode);
            emit RegionRegistered(regionCode);
        }
        uint256 idx = _count[regionCode] % HISTORY_SIZE;
        _ring[regionCode][idx] = d;
        unchecked {
            _count[regionCode] += 1;
        }
        emit WeatherUpdated(regionCode, d.timestamp, d.temperature, _count[regionCode]);
    }

    // --------- metered reads (AI agents) ---------

    /// @notice Latest observation for a region. Consumes one unit of quota.
    function queryLatest(uint256 regionCode) external returns (KWeatherPremiumData memory) {
        SubscriptionManager.Mode mode = subscription.consume(msg.sender);
        emit WeatherQueried(msg.sender, regionCode, mode);
        return _ring[regionCode][_latestIndex(regionCode)];
    }

    /// @notice Last `count` observations (chronological order) for time-series models.
    ///         Consumes one unit of quota regardless of `count`.
    function queryHistory(uint256 regionCode, uint256 count)
        external
        returns (KWeatherPremiumData[] memory)
    {
        SubscriptionManager.Mode mode = subscription.consume(msg.sender);
        emit WeatherQueried(msg.sender, regionCode, mode);
        return _readHistory(regionCode, count);
    }

    // --------- ops views (owner / relayer only, unmetered) ---------

    function peekLatest(uint256 regionCode) external view returns (KWeatherPremiumData memory) {
        require(relayers[msg.sender] || msg.sender == owner, "KW: ops only");
        return _ring[regionCode][_latestIndex(regionCode)];
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

    function _readHistory(uint256 regionCode, uint256 count)
        internal
        view
        returns (KWeatherPremiumData[] memory out)
    {
        uint256 total = _count[regionCode];
        require(total > 0, "KW: no data");
        if (count > total) count = total;
        if (count > HISTORY_SIZE) count = HISTORY_SIZE;

        out = new KWeatherPremiumData[](count);
        uint256 start = total - count; // logical index of the oldest returned entry
        for (uint256 i = 0; i < count; i++) {
            out[i] = _ring[regionCode][(start + i) % HISTORY_SIZE];
        }
    }
}
