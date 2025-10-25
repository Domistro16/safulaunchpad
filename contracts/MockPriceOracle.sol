// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockPriceOracle
 * @dev Mock oracle for testing - allows setting arbitrary prices
 * Do NOT use in production!
 */
contract MockPriceOracle {
    uint256 public price = 50 * 10**18; // Default: $580/BNB
    
    event PriceUpdated(uint256 newPrice);

    /**
     * @dev Set BNB price (owner or anyone in tests)
     */
    function setBNBPrice(uint256 _price) external {
        require(_price > 0, "Invalid price");
        price = _price;
        emit PriceUpdated(_price);
    }

    /**
     * @dev Get BNB price
     */
    function getBNBPrice() external view returns (uint256) {
        return price;
    }

    /**
     * @dev Convert USD to BNB
     */
    function usdToBNB(uint256 usdAmount) external view returns (uint256) {
        require(price > 0, "Price not set");
        return (usdAmount * 10**18) / price;
    }

    /**
     * @dev Convert BNB to USD
     */
    function bnbToUSD(uint256 bnbAmount) external view returns (uint256) {
        require(price > 0, "Price not set");
        return (bnbAmount * price) / 10**18;
    }

    /**
     * @dev Check minimum USD
     */
    function meetsMinimumUSD(uint256 bnbAmount, uint256 minUSD) 
        external 
        view 
        returns (bool) 
    {
        uint256 usdValue = (bnbAmount * price) / 10**18;
        return usdValue >= minUSD;
    }

    /**
     * @dev Check maximum USD
     */
    function exceedsMaximumUSD(uint256 bnbAmount, uint256 maxUSD) 
        external 
        view 
        returns (bool) 
    {
        uint256 usdValue = (bnbAmount * price) / 10**18;
        return usdValue > maxUSD;
    }

    /**
     * @dev Simulate price volatility (for advanced tests)
     */
    function simulatePriceChange(int256 percentChange) external {
        require(percentChange >= -100 && percentChange <= 100, "Invalid %");
        
        if (percentChange >= 0) {
            price = price + (price * uint256(percentChange)) / 100;
        } else {
            price = price - (price * uint256(-percentChange)) / 100;
        }
        
        emit PriceUpdated(price);
    }
}