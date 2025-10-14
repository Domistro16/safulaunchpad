// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PriceOracle.sol";

/**
 * @title BondingCurveDEXV3
 * @dev Standard version - Supports both Option 1 (project raise) and Option 2 (instant launch)
 */

contract BondingCurveDEX is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum LaunchType {
        PROJECT_RAISE,    // Option 1: Traditional raise model
        INSTANT_LAUNCH    // Option 2: Instant buy and trade
    }

    struct Pool {
        address token;
        uint256 bnbReserve;
        uint256 tokenReserve;
        uint256 totalTokenSupply;
        uint256 marketCap;
        uint256 graduationMarketCap;
        bool graduated;
        bool active;
        LaunchType launchType;
        address creator;
    }

    struct FeeDistribution {
        uint256 platformFee;
        uint256 academyFee;
        uint256 infoFiFee;
    }

    struct CreatorFees {
        uint256 accumulatedFees;
        uint256 lastClaimTime;
        uint256 graduationMarketCap;
        uint256 weekStartTime;
        uint256 totalPurchaseVolume;  // Track total BNB purchases for graduation
    }

    // Constants for Option 1 (Project Raise)
    uint256 public constant GRADUATION_MARKET_CAP_USD = 500_000 * 10 ** 18;
    uint256 public constant OPTION1_FEE_BASIS_POINTS = 100; // 1%
    
    // Constants for Option 2 (Instant Launch)
    uint256 public constant OPTION2_FEE_BASIS_POINTS = 200; // 2%
    uint256 public constant GRADUATION_BNB_THRESHOLD = 15 ether; // 15 BNB
    
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant CLAIM_COOLDOWN = 24 hours;
    uint256 public constant REDISTRIBUTION_PERIOD = 7 days;

    FeeDistribution public option1FeeDistribution;
    FeeDistribution public option2FeeDistribution;

    address public platformFeeAddress;
    address public academyFeeAddress;
    address public infoFiFeeAddress;
    PriceOracle public priceOracle;

    mapping(address => Pool) public pools;
    mapping(address => CreatorFees) public creatorFees;
    address[] public activeTokens;

    event PoolCreated(
        address indexed token, 
        uint256 initialLiquidity, 
        LaunchType launchType
    );
    event TokensBought(
        address indexed buyer,
        address indexed token,
        uint256 bnbAmount,
        uint256 tokensReceived
    );
    event TokensSold(
        address indexed seller,
        address indexed token,
        uint256 tokensAmount,
        uint256 bnbReceived
    );
    event PoolGraduated(address indexed token, uint256 finalMarketCap);
    event FeesCollected(
        address indexed token,
        uint256 platformFee,
        uint256 academyOrCreatorFee,
        uint256 infoFiFee
    );
    event CreatorFeesClaimed(
        address indexed creator,
        address indexed token,
        uint256 amount
    );
    event CreatorFeesRedirectedToInfoFi(
        address indexed token,
        uint256 amount
    );

    constructor(
        address _platformFeeAddress,
        address _academyFeeAddress,
        address _infoFiFeeAddress,
        address _priceOracle
    ) Ownable(msg.sender) {
        require(_platformFeeAddress != address(0), "Invalid platform address");
        require(_academyFeeAddress != address(0), "Invalid academy address");
        require(_infoFiFeeAddress != address(0), "Invalid InfoFi address");
        require(_priceOracle != address(0), "Invalid price oracle");

        platformFeeAddress = _platformFeeAddress;
        academyFeeAddress = _academyFeeAddress;
        infoFiFeeAddress = _infoFiFeeAddress;
        priceOracle = PriceOracle(_priceOracle);

        // Option 1 fee distribution: 0.1% platform, 0.3% academy, 0.6% InfoFi
        option1FeeDistribution = FeeDistribution({
            platformFee: 10,
            academyFee: 30,
            infoFiFee: 60
        });

        // Option 2 fee distribution: 0.1% platform, 1% creator, 0.9% InfoFi
        option2FeeDistribution = FeeDistribution({
            platformFee: 5,   // 5% of 2% = 0.1%
            academyFee: 50,   // 50% of 2% = 1% (repurposed as creator fee)
            infoFiFee: 45     // 45% of 2% = 0.9%
        });
    }

    /**
     * @dev Create pool for Option 1 (Project Raise)
     */
    function createPool(
        address token,
        uint256 tokenAmount
    ) external payable onlyOwner {
        _createPool(token, tokenAmount, LaunchType.PROJECT_RAISE, msg.sender);
    }

    /**
     * @dev Create pool for Option 2 (Instant Launch)
     */
    function createInstantLaunchPool(
        address token,
        uint256 tokenAmount,
        address creator
    ) external payable onlyOwner {
        _createPool(token, tokenAmount, LaunchType.INSTANT_LAUNCH, creator);
    }

    function _createPool(
        address token,
        uint256 tokenAmount,
        LaunchType launchType,
        address creator
    ) private {
        require(!pools[token].active, "Pool already exists");
        require(tokenAmount > 0, "Token amount must be > 0");
        require(msg.value > 0, "Must send BNB");

        IERC20(token).safeTransferFrom(
            msg.sender,
            address(this),
            tokenAmount
        );

        uint256 totalSupply = IERC20(token).totalSupply();
        uint256 bnbReserve = msg.value;
        uint256 initialMarketCap = (bnbReserve * totalSupply) / tokenAmount;

        uint256 graduationMarketCapBNB;
        if (launchType == LaunchType.PROJECT_RAISE) {
            graduationMarketCapBNB = priceOracle.usdToBNB(GRADUATION_MARKET_CAP_USD);
        } else {
            // For instant launch, we track by BNB volume, not market cap
            graduationMarketCapBNB = 0;
        }

        pools[token] = Pool({
            token: token,
            bnbReserve: bnbReserve,
            tokenReserve: tokenAmount,
            totalTokenSupply: totalSupply,
            marketCap: initialMarketCap,
            graduationMarketCap: graduationMarketCapBNB,
            graduated: false,
            active: true,
            launchType: launchType,
            creator: creator
        });

        if (launchType == LaunchType.INSTANT_LAUNCH) {
            creatorFees[token] = CreatorFees({
                accumulatedFees: 0,
                lastClaimTime: block.timestamp,
                graduationMarketCap: 0,
                weekStartTime: block.timestamp,
                totalPurchaseVolume: 0
            });
        }

        activeTokens.push(token);

        emit PoolCreated(token, msg.value, launchType);
    }

    /**
     * @dev Buy tokens - handles both launch types
     */
    function buyTokens(
        address token,
        uint256 minTokensOut
    ) external payable nonReentrant {
        Pool storage pool = pools[token];

        require(!pool.graduated || pool.launchType == LaunchType.INSTANT_LAUNCH, "Pool has graduated");
        require(pool.active, "Pool not active");
        require(msg.value > 0, "Must send BNB");

        uint256 feeRate = pool.launchType == LaunchType.PROJECT_RAISE 
            ? OPTION1_FEE_BASIS_POINTS 
            : OPTION2_FEE_BASIS_POINTS;

        uint256 totalFee = (msg.value * feeRate) / BASIS_POINTS;
        uint256 bnbAfterFee = msg.value - totalFee;

        uint256 tokensOut = (bnbAfterFee * pool.tokenReserve) /
            (pool.bnbReserve + bnbAfterFee);

        require(tokensOut >= minTokensOut, "Slippage too high");
        require(tokensOut <= pool.tokenReserve, "Insufficient liquidity");

        pool.bnbReserve += bnbAfterFee;
        pool.tokenReserve -= tokensOut;

        pool.marketCap =
            (pool.bnbReserve * pool.totalTokenSupply) /
            pool.tokenReserve;

        // Track purchase volume for instant launches
        if (pool.launchType == LaunchType.INSTANT_LAUNCH) {
            creatorFees[token].totalPurchaseVolume += msg.value;
        }

        // FIXED: Pass buyer address to prevent self-fee accumulation
        _distributeFees(totalFee, token, msg.sender);

        IERC20(token).safeTransfer(msg.sender, tokensOut);

        emit TokensBought(msg.sender, token, msg.value, tokensOut);

        _checkGraduation(token);
    }

    /**
     * @dev Sell tokens to the bonding curve
     */
    function sellTokens(
        address token,
        uint256 tokenAmount,
        uint256 minBNBOut
    ) external nonReentrant {
        Pool storage pool = pools[token];

        require(!pool.graduated || pool.launchType == LaunchType.INSTANT_LAUNCH, "Pool has graduated");
        require(pool.active, "Pool not active");
        require(tokenAmount > 0, "Must sell tokens");

        uint256 bnbOut = (tokenAmount * pool.bnbReserve) /
            (pool.tokenReserve + tokenAmount);

        uint256 feeRate = pool.launchType == LaunchType.PROJECT_RAISE 
            ? OPTION1_FEE_BASIS_POINTS 
            : OPTION2_FEE_BASIS_POINTS;

        uint256 totalFee = (bnbOut * feeRate) / BASIS_POINTS;
        uint256 bnbAfterFee = bnbOut - totalFee;

        require(bnbAfterFee >= minBNBOut, "Slippage too high");
        require(bnbAfterFee <= pool.bnbReserve, "Insufficient BNB liquidity");

        IERC20(token).safeTransferFrom(
            msg.sender,
            address(this),
            tokenAmount
        );

        pool.bnbReserve -= bnbOut;
        pool.tokenReserve += tokenAmount;

        pool.marketCap =
            (pool.bnbReserve * pool.totalTokenSupply) /
            pool.tokenReserve;

        // FIXED: Pass seller address to prevent self-fee accumulation
        _distributeFees(totalFee, token, msg.sender);

        payable(msg.sender).transfer(bnbAfterFee);

        emit TokensSold(msg.sender, token, tokenAmount, bnbAfterFee);
    }

    /**
     * @dev Check if pool should graduate based on launch type
     */
    function _checkGraduation(address token) private {
        Pool storage pool = pools[token];

        if (pool.launchType == LaunchType.PROJECT_RAISE) {
            // Option 1: Graduate at $500k market cap
            uint256 marketCapUSD = priceOracle.bnbToUSD(pool.marketCap);
            if (marketCapUSD >= GRADUATION_MARKET_CAP_USD) {
                _graduatePool(token);
            }
        } else {
            // Option 2: Graduate after 15 BNB in purchases
            if (creatorFees[token].totalPurchaseVolume >= GRADUATION_BNB_THRESHOLD) {
                pool.graduated = true;
                creatorFees[token].graduationMarketCap = pool.marketCap;
                emit PoolGraduated(token, pool.marketCap);
                // Note: pool stays active for continued trading
            }
        }
    }

    /**
     * @dev Distribute fees based on launch type
     * @param totalFee The total fee amount to distribute
     * @param token The token address
     * @param buyer The address of the buyer/seller (to prevent self-fee accumulation)
     */
    function _distributeFees(uint256 totalFee, address token, address buyer) private {
        Pool memory pool = pools[token];

        if (pool.launchType == LaunchType.PROJECT_RAISE) {
            // Option 1: 1% split - 0.1% platform, 0.3% academy, 0.6% InfoFi
            uint256 platformAmount = (totalFee * option1FeeDistribution.platformFee) / 100;
            uint256 academyAmount = (totalFee * option1FeeDistribution.academyFee) / 100;
            uint256 infoFiAmount = (totalFee * option1FeeDistribution.infoFiFee) / 100;

            payable(platformFeeAddress).transfer(platformAmount);
            payable(academyFeeAddress).transfer(academyAmount);
            payable(infoFiFeeAddress).transfer(infoFiAmount);

            emit FeesCollected(token, platformAmount, academyAmount, infoFiAmount);
        } else {
            // Option 2: 2% split - 0.1% platform, 1% creator, 0.9% InfoFi
            uint256 platformAmount = (totalFee * option2FeeDistribution.platformFee) / 100;
            uint256 creatorAmount = (totalFee * option2FeeDistribution.academyFee) / 100;
            uint256 infoFiAmount = (totalFee * option2FeeDistribution.infoFiFee) / 100;

            // FIXED: Only accumulate creator fees if buyer is NOT the creator
            // This prevents creators from earning fees on their own purchases
            if (buyer != pool.creator) {
                creatorFees[token].accumulatedFees += creatorAmount;
            } else {
                // If creator is buying/selling their own token, redirect their fee to InfoFi
                infoFiAmount += creatorAmount;
            }

            payable(platformFeeAddress).transfer(platformAmount);
            payable(infoFiFeeAddress).transfer(infoFiAmount);

            emit FeesCollected(token, platformAmount, creatorAmount, infoFiAmount);
        }
    }

    /**
     * @dev Claim creator fees (Option 2 only)
     */
    function claimCreatorFees(address token) external nonReentrant {
        Pool memory pool = pools[token];
        require(pool.launchType == LaunchType.INSTANT_LAUNCH, "Not instant launch");
        require(msg.sender == pool.creator, "Not creator");

        CreatorFees storage fees = creatorFees[token];
        require(fees.accumulatedFees > 0, "No fees to claim");
        require(
            block.timestamp >= fees.lastClaimTime + CLAIM_COOLDOWN,
            "Claim cooldown active"
        );

        // Check if token has graduated and market cap requirement
        if (pool.graduated && pool.marketCap >= fees.graduationMarketCap) {
            // Market cap is above graduation level - pay creator
            uint256 amount = fees.accumulatedFees;
            fees.accumulatedFees = 0;
            fees.lastClaimTime = block.timestamp;
            fees.weekStartTime = block.timestamp; // Reset week timer

            payable(pool.creator).transfer(amount);
            emit CreatorFeesClaimed(pool.creator, token, amount);
        } else if (pool.graduated && block.timestamp >= fees.weekStartTime + REDISTRIBUTION_PERIOD) {
            // Market cap below graduation level and week has passed - redirect to InfoFi
            uint256 amount = fees.accumulatedFees;
            fees.accumulatedFees = 0;
            fees.lastClaimTime = block.timestamp;
            fees.weekStartTime = block.timestamp;

            payable(infoFiFeeAddress).transfer(amount);
            emit CreatorFeesRedirectedToInfoFi(token, amount);
        } else {
            revert("Conditions not met for claiming");
        }
    }

    /**
     * @dev Get buy quote
     */
    function getBuyQuote(
        address token,
        uint256 bnbAmount
    ) external view returns (uint256 tokensOut, uint256 pricePerToken) {
        Pool memory pool = pools[token];
        require(pool.active, "Pool not active");

        uint256 feeRate = pool.launchType == LaunchType.PROJECT_RAISE 
            ? OPTION1_FEE_BASIS_POINTS 
            : OPTION2_FEE_BASIS_POINTS;

        uint256 bnbAfterFee = bnbAmount - ((bnbAmount * feeRate) / BASIS_POINTS);
        tokensOut = (bnbAfterFee * pool.tokenReserve) / (pool.bnbReserve + bnbAfterFee);

        pricePerToken = (bnbAmount * 10 ** 18) / tokensOut;
    }

    /**
     * @dev Get sell quote
     */
    function getSellQuote(
        address token,
        uint256 tokenAmount
    ) external view returns (uint256 bnbOut, uint256 pricePerToken) {
        Pool memory pool = pools[token];
        require(pool.active, "Pool not active");

        uint256 bnbBeforeFee = (tokenAmount * pool.bnbReserve) /
            (pool.tokenReserve + tokenAmount);

        uint256 feeRate = pool.launchType == LaunchType.PROJECT_RAISE 
            ? OPTION1_FEE_BASIS_POINTS 
            : OPTION2_FEE_BASIS_POINTS;

        bnbOut = bnbBeforeFee - ((bnbBeforeFee * feeRate) / BASIS_POINTS);
        pricePerToken = (bnbOut * 10 ** 18) / tokenAmount;
    }

    /**
     * @dev Get pool info with USD values
     */
    function getPoolInfo(
        address token
    )
        external
        view
        returns (
            uint256 marketCapBNB,
            uint256 marketCapUSD,
            uint256 bnbReserve,
            uint256 tokenReserve,
            uint256 currentPrice,
            uint256 graduationProgress,
            bool graduated
        )
    {
        Pool memory pool = pools[token];
        marketCapBNB = pool.marketCap;
        marketCapUSD = priceOracle.bnbToUSD(pool.marketCap);
        bnbReserve = pool.bnbReserve;
        tokenReserve = pool.tokenReserve;
        currentPrice = pool.tokenReserve > 0
            ? (pool.bnbReserve * 10 ** 18) / pool.tokenReserve
            : 0;

        if (pool.launchType == LaunchType.PROJECT_RAISE) {
            graduationProgress = marketCapUSD > 0
                ? (marketCapUSD * 100) / GRADUATION_MARKET_CAP_USD
                : 0;
        } else {
            graduationProgress = creatorFees[token].totalPurchaseVolume > 0
                ? (creatorFees[token].totalPurchaseVolume * 100) / GRADUATION_BNB_THRESHOLD
                : 0;
        }
        
        graduated = pool.graduated;
    }

    /**
     * @dev Get creator fee info (Option 2 only)
     */
    function getCreatorFeeInfo(
        address token
    )
        external
        view
        returns (
            uint256 accumulatedFees,
            uint256 lastClaimTime,
            uint256 graduationMarketCap,
            uint256 currentMarketCap,
            uint256 totalPurchaseVolume,
            bool canClaim
        )
    {
        Pool memory pool = pools[token];
        require(pool.launchType == LaunchType.INSTANT_LAUNCH, "Not instant launch");

        CreatorFees memory fees = creatorFees[token];
        accumulatedFees = fees.accumulatedFees;
        lastClaimTime = fees.lastClaimTime;
        graduationMarketCap = fees.graduationMarketCap;
        currentMarketCap = pool.marketCap;
        totalPurchaseVolume = fees.totalPurchaseVolume;

        // Can claim if cooldown passed and either:
        // 1. Graduated and market cap >= graduation market cap, OR
        // 2. Graduated and week has passed (for InfoFi redirect)
        bool cooldownPassed = block.timestamp >= fees.lastClaimTime + CLAIM_COOLDOWN;
        bool aboveGraduationCap = pool.graduated && pool.marketCap >= fees.graduationMarketCap;
        bool weekPassed = pool.graduated && block.timestamp >= fees.weekStartTime + REDISTRIBUTION_PERIOD;

        canClaim = fees.accumulatedFees > 0 && cooldownPassed && (aboveGraduationCap || weekPassed);
    }

    /**
     * @dev Graduate pool to PancakeSwap (Option 1 only)
     */
    function _graduatePool(address token) private {
        Pool storage pool = pools[token];
        pool.graduated = true;
        pool.active = false;

        emit PoolGraduated(token, pool.marketCap);
    }

    /**
     * @dev Withdraw graduated pool reserves to LaunchpadManager (Option 1 only)
     */
    function withdrawGraduatedPool(
        address token
    ) external onlyOwner returns (uint256 bnbAmount, uint256 tokenAmount) {
        Pool storage pool = pools[token];
        require(pool.graduated, "Pool not graduated");
        require(pool.launchType == LaunchType.PROJECT_RAISE, "Only for project raise");
        require(pool.active == false, "Pool still active");

        bnbAmount = pool.bnbReserve;
        tokenAmount = pool.tokenReserve;

        pool.bnbReserve = 0;
        pool.tokenReserve = 0;

        IERC20(token).safeTransfer(msg.sender, tokenAmount);

        (bool success, ) = payable(msg.sender).call{value: bnbAmount}("");
        require(success, "Transfer Failed");
        
        return (bnbAmount, tokenAmount);
    }

    function graduatePool(address token) external onlyOwner {
        _graduatePool(token);
    }

    function updateFeeAddresses(
        address _platformFeeAddress,
        address _academyFeeAddress,
        address _infoFiFeeAddress
    ) external onlyOwner {
        platformFeeAddress = _platformFeeAddress;
        academyFeeAddress = _academyFeeAddress;
        infoFiFeeAddress = _infoFiFeeAddress;
    }

    function getActiveTokens() external view returns (address[] memory) {
        return activeTokens;
    }

    receive() external payable {}
}