// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PriceOracle
 * @dev Provides USD price conversions using Chainlink price feeds
 * Encapsulates all oracle logic to keep main contracts clean
 */

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

contract PriceOracle is Ownable {
    AggregatorV3Interface public priceFeed;

    // Price staleness threshold (1 hour)
    uint256 public constant PRICE_STALENESS_THRESHOLD = 1 hours;

    // Cached price (gas optimization)
    struct PriceCache {
        uint256 price;
        uint256 timestamp;
    }
    PriceCache public cachedPrice;
    uint256 public constant CACHE_DURATION = 5 minutes;

    event PriceFeedUpdated(address indexed newPriceFeed);
    event PriceCacheUpdated(uint256 price, uint256 timestamp);

    /**
     * @dev Constructor
     * @param _priceFeed Address of Chainlink BNB/USD price feed
     * BSC Mainnet: 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE
     * BSC Testnet: 0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526
     */
    constructor(address _priceFeed) Ownable(msg.sender) {
        require(_priceFeed != address(0), "Invalid price feed");
        priceFeed = AggregatorV3Interface(_priceFeed);
    }

    /**
     * @dev Get current BNB price in USD (with 18 decimals)
     * Uses cache if fresh, otherwise fetches from Chainlink
     */
    function getBNBPrice() public view returns (uint256) {
        // Return cached price if still fresh
        if (block.timestamp - cachedPrice.timestamp < CACHE_DURATION) {
            return cachedPrice.price;
        }

        // Fetch fresh price from Chainlink
        return _fetchPrice();
    }

    /**
     * @dev Update cached price (can be called by anyone to refresh)
     */
    function updateCachedPrice() external {
        uint256 newPrice = _fetchPrice();
        cachedPrice = PriceCache({price: newPrice, timestamp: block.timestamp});

        emit PriceCacheUpdated(newPrice, block.timestamp);
    }

    /**
     * @dev Convert USD amount to BNB
     * @param usdAmount Amount in USD (with 18 decimals)
     * @return bnbAmount Amount in BNB (with 18 decimals)
     */
    function usdToBNB(uint256 usdAmount) external view returns (uint256) {
        uint256 bnbPrice = getBNBPrice();
        require(bnbPrice > 0, "Invalid BNB price");

        // usdAmount * 10^18 / bnbPrice = bnbAmount
        return (usdAmount * 10 ** 18) / bnbPrice;
    }

    /**
     * @dev Convert BNB amount to USD
     * @param bnbAmount Amount in BNB (with 18 decimals)
     * @return usdAmount Amount in USD (with 18 decimals)
     */
    function bnbToUSD(uint256 bnbAmount) external view returns (uint256) {
        uint256 bnbPrice = getBNBPrice();
        require(bnbPrice > 0, "Invalid BNB price");

        // bnbAmount * bnbPrice / 10^18 = usdAmount
        return (bnbAmount * bnbPrice) / 10 ** 18;
    }

    /**
     * @dev Check if USD amount meets minimum in BNB terms
     * @param bnbAmount BNB amount to check
     * @param minUSD Minimum USD amount required
     * @return bool True if BNB amount meets USD minimum
     */
    function meetsMinimumUSD(
        uint256 bnbAmount,
        uint256 minUSD
    ) external view returns (bool) {
        uint256 bnbPrice = getBNBPrice();
        uint256 usdValue = (bnbAmount * bnbPrice) / 10 ** 18;
        return usdValue >= minUSD;
    }

    /**
     * @dev Check if USD amount exceeds maximum in BNB terms
     * @param bnbAmount BNB amount to check
     * @param maxUSD Maximum USD amount allowed
     * @return bool True if BNB amount exceeds USD maximum
     */
    function exceedsMaximumUSD(
        uint256 bnbAmount,
        uint256 maxUSD
    ) external view returns (bool) {
        uint256 bnbPrice = getBNBPrice();
        uint256 usdValue = (bnbAmount * bnbPrice) / 10 ** 18;
        return usdValue > maxUSD;
    }

    /**
     * @dev Internal function to fetch price from Chainlink
     */
    function _fetchPrice() internal view returns (uint256) {
        (
            uint80 roundId,
            int256 price,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        // Validate price data
        require(price > 0, "Invalid price");
        require(answeredInRound >= roundId, "Stale price");
        require(
            block.timestamp - updatedAt < PRICE_STALENESS_THRESHOLD,
            "Price too old"
        );

        // Chainlink returns price with 8 decimals, convert to 18 decimals
        // BNB/USD price feed returns price like 58000000000 (8 decimals) = $580
        uint8 decimals = priceFeed.decimals();
        uint256 priceWith18Decimals = uint256(price) * 10 ** (18 - decimals);

        return priceWith18Decimals;
    }

    /**
     * @dev Owner can update price feed address (for upgrades)
     */
    function updatePriceFeed(address _priceFeed) external onlyOwner {
        require(_priceFeed != address(0), "Invalid price feed");
        priceFeed = AggregatorV3Interface(_priceFeed);

        // Clear cache to force fresh fetch
        delete cachedPrice;

        emit PriceFeedUpdated(_priceFeed);
    }

    /**
     * @dev Get price feed info (for verification)
     */
    function getPriceFeedInfo()
        external
        view
        returns (
            address feedAddress,
            string memory description,
            uint8 decimals,
            uint256 version
        )
    {
        return (
            address(priceFeed),
            priceFeed.description(),
            priceFeed.decimals(),
            priceFeed.version()
        );
    }

    /**
     * @dev Get latest round data (for debugging)
     */
    function getLatestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 price,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return priceFeed.latestRoundData();
    }
}
