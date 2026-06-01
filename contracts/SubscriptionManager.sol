// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC20.sol";

/// @title SubscriptionManager
/// @notice Monetization layer for the K-Weather oracle (PRD §5.3).
///         Two access models for AI agents:
///           (1) Subscription   — deposit tokens for a monthly query allowance (rate limit).
///           (2) Pay-per-query  — prepay tokens, debited per metered query.
///         The oracle contract is the only authorized caller of `consume`.
contract SubscriptionManager {
    IERC20 public immutable token;
    address public owner;
    address public treasury;
    address public oracle; // authorized consumer (KWeatherOracle)

    uint256 public constant PERIOD = 30 days;

    uint256 public monthlyPrice;    // token cost per 30-day period
    uint256 public queriesPerMonth; // query allowance granted per subscribed month
    uint256 public pricePerQuery;   // token cost of a single pay-per-query call

    struct Subscription {
        uint256 expiry;    // unix time the subscription is valid until
        uint256 allowance; // remaining metered queries
    }

    mapping(address => Subscription) public subscriptions;
    mapping(address => uint256) public prepaidBalance; // pay-per-query credit

    enum Mode { None, Subscription, PayPerQuery }

    event OracleUpdated(address indexed oracle);
    event PricingUpdated(uint256 monthlyPrice, uint256 queriesPerMonth, uint256 pricePerQuery);
    event Subscribed(address indexed agent, uint256 months, uint256 expiry, uint256 allowance);
    event PrepaidDeposited(address indexed agent, uint256 amount, uint256 balance);
    event Consumed(address indexed agent, Mode mode, uint256 remaining);

    modifier onlyOwner() {
        require(msg.sender == owner, "SM: not owner");
        _;
    }

    constructor(
        IERC20 _token,
        address _treasury,
        uint256 _monthlyPrice,
        uint256 _queriesPerMonth,
        uint256 _pricePerQuery
    ) {
        require(address(_token) != address(0) && _treasury != address(0), "SM: zero addr");
        owner = msg.sender;
        token = _token;
        treasury = _treasury;
        monthlyPrice = _monthlyPrice;
        queriesPerMonth = _queriesPerMonth;
        pricePerQuery = _pricePerQuery;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }

    function setPricing(
        uint256 _monthlyPrice,
        uint256 _queriesPerMonth,
        uint256 _pricePerQuery
    ) external onlyOwner {
        monthlyPrice = _monthlyPrice;
        queriesPerMonth = _queriesPerMonth;
        pricePerQuery = _pricePerQuery;
        emit PricingUpdated(_monthlyPrice, _queriesPerMonth, _pricePerQuery);
    }

    /// @notice Subscribe (or extend) for `months` periods. Grants a rolling query allowance.
    function subscribe(uint256 months) external {
        require(months > 0, "SM: months=0");
        uint256 cost = monthlyPrice * months;
        require(token.transferFrom(msg.sender, treasury, cost), "SM: payment failed");

        Subscription storage s = subscriptions[msg.sender];
        uint256 base = s.expiry > block.timestamp ? s.expiry : block.timestamp;
        s.expiry = base + (PERIOD * months);
        s.allowance += queriesPerMonth * months;

        emit Subscribed(msg.sender, months, s.expiry, s.allowance);
    }

    /// @notice Deposit prepaid credit for pay-per-query usage.
    function depositPrepaid(uint256 amount) external {
        require(amount > 0, "SM: amount=0");
        require(token.transferFrom(msg.sender, treasury, amount), "SM: payment failed");
        prepaidBalance[msg.sender] += amount;
        emit PrepaidDeposited(msg.sender, amount, prepaidBalance[msg.sender]);
    }

    /// @notice Meter one query for `agent`. Subscription is used first, then prepaid credit.
    /// @dev Only callable by the oracle contract.
    function consume(address agent) external returns (Mode mode) {
        require(msg.sender == oracle, "SM: only oracle");

        Subscription storage s = subscriptions[agent];
        if (block.timestamp <= s.expiry && s.allowance > 0) {
            s.allowance -= 1;
            emit Consumed(agent, Mode.Subscription, s.allowance);
            return Mode.Subscription;
        }

        uint256 bal = prepaidBalance[agent];
        if (bal >= pricePerQuery) {
            unchecked {
                prepaidBalance[agent] = bal - pricePerQuery;
            }
            emit Consumed(agent, Mode.PayPerQuery, prepaidBalance[agent]);
            return Mode.PayPerQuery;
        }

        revert("SM: no active quota or prepaid credit");
    }

    // --------- views ---------

    function isSubscriptionActive(address agent) external view returns (bool) {
        Subscription storage s = subscriptions[agent];
        return block.timestamp <= s.expiry && s.allowance > 0;
    }

    function quotaOf(address agent) external view returns (uint256 expiry, uint256 allowance) {
        Subscription storage s = subscriptions[agent];
        return (s.expiry, s.allowance);
    }
}
