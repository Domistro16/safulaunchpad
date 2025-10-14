// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BondingDEX.sol";
import "./PriceOracle.sol";

interface ITokenFactoryV2 {
    struct TokenMetadata {
        string logoURI;
        string description;
        string website;
        string twitter;
        string telegram;
        string discord;
    }

    function createToken(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 decimals,
        address owner,
        TokenMetadata memory metadata
    ) external returns (address);

    function createTokenWithSalt(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 decimals,
        address owner,
        TokenMetadata memory metadata,
        bytes32 salt
    ) external returns (address);
}

interface IPancakeRouter02 {
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    )
        external
        payable
        returns (uint amountToken, uint amountETH, uint liquidity);
}

interface IBondingCurveDEXV3 {
    function createPool(address token, uint256 tokenAmount) external payable;

    function createInstantLaunchPool(
        address token,
        uint256 tokenAmount,
        address creator
    ) external payable;

    function withdrawGraduatedPool(
        address token
    ) external returns (uint256 bnbAmount, uint256 tokenAmount);

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
        );

    function getBuyQuote(
        address token,
        uint256 bnbAmount
    ) external view returns (uint256 tokensOut, uint256 pricePerToken);

    function buyTokens(address token, uint256 minTokensOut) external payable;
}

/**
 * @title LaunchpadManagerV3
 * @dev Standard version - Supports both Option 1 (project raise) and Option 2 (instant launch)
 */
contract LaunchpadManagerV3 is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum LaunchType {
        PROJECT_RAISE, // Option 1
        INSTANT_LAUNCH // Option 2
    }

    // Split Launch struct into smaller parts
    struct LaunchBasics {
        address token;
        address founder;
        uint256 totalSupply;
        uint256 raiseTarget;
        uint256 raiseMax;
        uint256 raiseDeadline;
        uint256 totalRaised;
        LaunchType launchType;
    }

    struct LaunchVesting {
        uint256 startMarketCap;
        uint256 vestingDuration;
        uint256 vestingStartTime;
        uint256 founderTokens;
        uint256 founderTokensClaimed;
    }

    struct LaunchLiquidity {
        uint256 liquidityBNB;
        uint256 liquidityTokens;
        uint256 raisedFundsVesting;
        uint256 raisedFundsClaimed;
    }

    struct LaunchStatus {
        bool raiseCompleted;
        bool liquidityAdded;
        bool graduatedToPancakeSwap;
    }

    struct Contribution {
        uint256 amount;
        bool claimed;
    }

    // Constants for Option 1 (Project Raise)
    uint256 public constant MIN_RAISE_USD = 50_000 * 10 ** 18;
    uint256 public constant MAX_RAISE_USD = 500_000 * 10 ** 18;
    uint256 public constant MAX_LIQUIDITY_USD = 100_000 * 10 ** 18;
    uint256 public constant RAISE_DURATION = 24 hours;
    uint256 public constant FOUNDER_ALLOCATION = 20;
    uint256 public constant IMMEDIATE_FOUNDER_RELEASE = 50;
    uint256 public constant LIQUIDITY_PERCENT = 10;
    uint256 public constant LIQUIDITY_BNB_PERCENT = 50;
    uint256 public constant MIN_VESTING_DURATION = 90 days;
    uint256 public constant MAX_VESTING_DURATION = 180 days;
    uint256 public constant VESTING_RELEASE_INTERVAL = 30 days;

    // Storage variables
    AggregatorV3Interface public priceFeed;
    ITokenFactoryV2 public tokenFactory;
    IBondingCurveDEXV3 public bondingCurveDEX;
    IPancakeRouter02 public pancakeRouter;
    PriceOracle public priceOracle;
    address public infoFiAddress;

    // State mappings
    mapping(address => LaunchBasics) public launchBasics;
    mapping(address => LaunchVesting) public launchVesting;
    mapping(address => LaunchLiquidity) public launchLiquidity;
    mapping(address => LaunchStatus) public launchStatus;
    mapping(address => mapping(address => Contribution)) public contributions;
    address[] public allLaunches;

    uint256 public fallbackBNBPrice;
    bool public useOraclePrice;

    // Events
    event LaunchCreated(
        address indexed token,
        address indexed founder,
        uint256 totalSupply,
        LaunchType launchType,
        uint256 raiseTargetUSD,
        uint256 raiseTargetBNB,
        uint256 deadline,
        bool hasVanitySalt
    );
    event InstantLaunchCreated(
        address indexed token,
        address indexed founder,
        uint256 totalSupply,
        uint256 initialBuyAmount,
        uint256 tokensReceived
    );
    event ContributionMade(
        address indexed contributor,
        address indexed token,
        uint256 amount
    );
    event RaiseCompleted(address indexed token, uint256 totalRaised);
    event FounderTokensClaimed(
        address indexed founder,
        address indexed token,
        uint256 amount
    );
    event RaisedFundsClaimed(
        address indexed founder,
        address indexed token,
        uint256 amount
    );
    event RaisedFundsSentToInfoFi(address indexed token, uint256 amount);
    event TokensBurned(address indexed token, uint256 amount);
    event GraduatedToPancakeSwap(address indexed token, uint256 liquidityAdded);
    event PriceFeedUpdated(address indexed newPriceFeed);
    event FallbackPriceUpdated(uint256 newPrice);
    event OracleModeChanged(bool useOracle);

    constructor(
        address _tokenFactory,
        address _bondingCurveDEX,
        address _pancakeRouter,
        address _priceOracle,
        address _infoFiAddress
    ) Ownable(msg.sender) {
        require(_tokenFactory != address(0), "Invalid token factory");
        require(_bondingCurveDEX != address(0), "Invalid bonding DEX");
        require(_pancakeRouter != address(0), "Invalid pancake router");
        require(_priceOracle != address(0), "Invalid price oracle");
        require(_infoFiAddress != address(0), "Invalid InfoFi address");

        tokenFactory = ITokenFactoryV2(_tokenFactory);
        bondingCurveDEX = IBondingCurveDEXV3(_bondingCurveDEX);
        pancakeRouter = IPancakeRouter02(_pancakeRouter);
        infoFiAddress = _infoFiAddress;
        priceOracle = PriceOracle(_priceOracle);

        fallbackBNBPrice = 1200 * 10 ** 8;
        useOraclePrice = true;
    }

    /**
     * @dev Get latest BNB/USD price from Chainlink
     */
    function getBNBPrice() public view returns (uint256) {
        if (!useOraclePrice) {
            return fallbackBNBPrice;
        }

        try priceFeed.latestRoundData() returns (
            uint80,
            int256 price,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            require(block.timestamp - updatedAt <= 3600, "Stale price");
            require(price > 0, "Invalid price");
            return uint256(price);
        } catch {
            return fallbackBNBPrice;
        }
    }

    // ============================================
    // OPTION 1: PROJECT RAISE (Existing functionality)
    // ============================================

    function createLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint256 raiseTargetUSD,
        uint256 raiseMaxUSD,
        uint256 vestingDuration,
        ITokenFactoryV2.TokenMetadata memory metadata
    ) external nonReentrant returns (address) {
        return
            _createLaunch(
                name,
                symbol,
                totalSupply,
                raiseTargetUSD,
                raiseMaxUSD,
                vestingDuration,
                metadata,
                false,
                bytes32(0)
            );
    }

    function createLaunchWithVanity(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint256 raiseTargetUSD,
        uint256 raiseMaxUSD,
        uint256 vestingDuration,
        ITokenFactoryV2.TokenMetadata memory metadata,
        bytes32 vanitySalt
    ) external nonReentrant returns (address) {
        return
            _createLaunch(
                name,
                symbol,
                totalSupply,
                raiseTargetUSD,
                raiseMaxUSD,
                vestingDuration,
                metadata,
                true,
                vanitySalt
            );
    }

    function _createLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint256 raiseTargetUSD,
        uint256 raiseMaxUSD,
        uint256 vestingDuration,
        ITokenFactoryV2.TokenMetadata memory metadata,
        bool useVanity,
        bytes32 vanitySalt
    ) private returns (address) {
        _validateLaunchParams(raiseTargetUSD, raiseMaxUSD, vestingDuration);

        uint256 raiseTargetBNB = priceOracle.usdToBNB(raiseTargetUSD);
        uint256 raiseMaxBNB = priceOracle.usdToBNB(raiseMaxUSD);

        address token = _deployToken(
            name,
            symbol,
            totalSupply,
            metadata,
            useVanity,
            vanitySalt
        );
        _initializeLaunch(
            token,
            totalSupply,
            raiseTargetBNB,
            raiseMaxBNB,
            vestingDuration,
            LaunchType.PROJECT_RAISE
        );

        emit LaunchCreated(
            token,
            msg.sender,
            totalSupply * 10 ** 18,
            LaunchType.PROJECT_RAISE,
            raiseTargetUSD,
            raiseTargetBNB,
            block.timestamp + RAISE_DURATION,
            useVanity
        );

        return token;
    }

    // ============================================
    // OPTION 2: INSTANT LAUNCH (New functionality)
    // ============================================

    /**
     * @dev Create instant launch token - buy immediately and start trading
     * @param initialBuyBNB Amount of BNB creator wants to use for initial purchase
     */
    function createInstantLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        uint256 initialBuyBNB
    ) external payable nonReentrant returns (address) {
        return
            _createInstantLaunch(
                name,
                symbol,
                totalSupply,
                metadata,
                initialBuyBNB,
                false,
                bytes32(0)
            );
    }

    function createInstantLaunchWithVanity(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        uint256 initialBuyBNB,
        bytes32 vanitySalt
    ) external payable nonReentrant returns (address) {
        return
            _createInstantLaunch(
                name,
                symbol,
                totalSupply,
                metadata,
                initialBuyBNB,
                true,
                vanitySalt
            );
    }

    function _createInstantLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        uint256 initialBuyBNB,
        bool useVanity,
        bytes32 vanitySalt
    ) private returns (address) {
        require(initialBuyBNB > 0, "Initial buy must be > 0");
        require(msg.value >= initialBuyBNB, "Insufficient BNB sent");

        // Deploy token
        address token = _deployToken(
            name,
            symbol,
            totalSupply,
            metadata,
            useVanity,
            vanitySalt
        );

        uint256 totalSupplyWei = totalSupply * 10 ** 18;

        // For instant launch, all tokens go to bonding curve
        // No founder allocation, no liquidity reservation
        uint256 tradingTokens = totalSupplyWei;

        // Initialize launch basics
        launchBasics[token] = LaunchBasics({
            token: token,
            founder: msg.sender,
            totalSupply: totalSupplyWei,
            raiseTarget: 0,
            raiseMax: 0,
            raiseDeadline: 0,
            totalRaised: 0,
            launchType: LaunchType.INSTANT_LAUNCH
        });

        // No vesting for instant launches
        launchStatus[token] = LaunchStatus({
            raiseCompleted: true, // Instant launch is always "completed"
            liquidityAdded: true, // No separate liquidity step
            graduatedToPancakeSwap: false
        });

        allLaunches.push(token);

        // Setup bonding curve with small initial liquidity
        // Use 0.01 BNB as initial liquidity for price discovery
        uint256 initialLiquidityBNB = 0.1 ether;
        IERC20(token).approve(address(bondingCurveDEX), tradingTokens);
        bondingCurveDEX.createInstantLaunchPool{value: initialLiquidityBNB}(
            token,
            tradingTokens,
            msg.sender
        );

        // Execute initial buy from creator
        uint256 tokensReceived = _executeInitialBuy(token, initialBuyBNB);

        emit InstantLaunchCreated(
            token,
            msg.sender,
            totalSupplyWei,
            initialBuyBNB,
            tokensReceived
        );

        // Return any excess BNB
        if (msg.value > initialBuyBNB + initialLiquidityBNB) {
            payable(msg.sender).transfer(
                msg.value - initialBuyBNB - initialLiquidityBNB
            );
        }

        return token;
    }

    function _executeInitialBuy(
        address token,
        uint256 buyAmount
    ) private returns (uint256) {
        // Get quote for initial buy
        (uint256 tokensOut, ) = bondingCurveDEX.getBuyQuote(token, buyAmount);

        // Execute buy through bonding curve
        bondingCurveDEX.buyTokens{value: buyAmount}(token, tokensOut);

        // Transfer tokens to creator
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(msg.sender, balance);

        return balance;
    }

    // ============================================
    // SHARED FUNCTIONS
    // ============================================

    function _validateLaunchParams(
        uint256 raiseTargetUSD,
        uint256 raiseMaxUSD,
        uint256 vestingDuration
    ) private pure {
        require(
            raiseTargetUSD >= MIN_RAISE_USD && raiseTargetUSD <= MAX_RAISE_USD,
            "Invalid raise target"
        );
        require(
            raiseMaxUSD >= raiseTargetUSD && raiseMaxUSD <= MAX_RAISE_USD,
            "Invalid raise max"
        );
        require(
            vestingDuration >= MIN_VESTING_DURATION &&
                vestingDuration <= MAX_VESTING_DURATION,
            "Invalid vesting duration"
        );
    }

    function _deployToken(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        bool useVanity,
        bytes32 vanitySalt
    ) private returns (address) {
        if (useVanity) {
            return
                tokenFactory.createTokenWithSalt(
                    name,
                    symbol,
                    totalSupply,
                    18,
                    address(this),
                    metadata,
                    vanitySalt
                );
        } else {
            return
                tokenFactory.createToken(
                    name,
                    symbol,
                    totalSupply,
                    18,
                    address(this),
                    metadata
                );
        }
    }

    function _initializeLaunch(
        address token,
        uint256 totalSupply,
        uint256 raiseTarget,
        uint256 raiseMax,
        uint256 vestingDuration,
        LaunchType launchType
    ) private {
        uint256 totalSupplyWei = totalSupply * 10 ** 18;
        uint256 founderTokens = (totalSupplyWei * FOUNDER_ALLOCATION) / 100;
        uint256 liquidityTokens = (totalSupplyWei * LIQUIDITY_PERCENT) / 100;

        launchBasics[token] = LaunchBasics({
            token: token,
            founder: msg.sender,
            totalSupply: totalSupplyWei,
            raiseTarget: raiseTarget,
            raiseMax: raiseMax,
            raiseDeadline: block.timestamp + RAISE_DURATION,
            totalRaised: 0,
            launchType: launchType
        });

        launchVesting[token] = LaunchVesting({
            startMarketCap: 0,
            vestingDuration: vestingDuration,
            vestingStartTime: 0,
            founderTokens: founderTokens,
            founderTokensClaimed: 0
        });

        launchLiquidity[token] = LaunchLiquidity({
            liquidityBNB: 0,
            liquidityTokens: liquidityTokens,
            raisedFundsVesting: 0,
            raisedFundsClaimed: 0
        });

        launchStatus[token] = LaunchStatus({
            raiseCompleted: false,
            liquidityAdded: false,
            graduatedToPancakeSwap: false
        });

        allLaunches.push(token);
    }

    // ============================================
    // OPTION 1 SPECIFIC FUNCTIONS (Unchanged)
    // ============================================

    function contribute(address token) external payable nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(basics.token != address(0), "Launch does not exist");
        require(block.timestamp < basics.raiseDeadline, "Raise ended");
        require(!status.raiseCompleted, "Raise already completed");
        require(msg.value > 0, "Must contribute BNB");

        require(
            basics.totalRaised + msg.value <= basics.raiseMax,
            "Exceeds max raise"
        );

        contributions[token][msg.sender].amount += msg.value;
        basics.totalRaised += msg.value;

        emit ContributionMade(msg.sender, token, msg.value);

        if (basics.totalRaised >= basics.raiseTarget) {
            _completeRaise(token);
        }
    }

    function _completeRaise(address token) private {
        LaunchStatus storage status = launchStatus[token];
        require(!status.raiseCompleted, "Already completed");

        LaunchBasics storage basics = launchBasics[token];
        LaunchVesting storage vesting = launchVesting[token];
        LaunchLiquidity storage liquidity = launchLiquidity[token];

        status.raiseCompleted = true;
        vesting.vestingStartTime = block.timestamp;

        uint256 liquidityBNB = (basics.totalRaised * LIQUIDITY_BNB_PERCENT) /
            100;

        uint256 maxLiquidityBNB = priceOracle.usdToBNB(MAX_LIQUIDITY_USD);
        if (liquidityBNB > maxLiquidityBNB) {
            liquidityBNB = maxLiquidityBNB;
        }

        liquidity.liquidityBNB = liquidityBNB;
        liquidity.raisedFundsVesting = basics.totalRaised - liquidityBNB;

        uint256 tradingTokens = basics.totalSupply -
            vesting.founderTokens -
            liquidity.liquidityTokens;

        vesting.startMarketCap =
            (liquidityBNB * basics.totalSupply) /
            tradingTokens;

        uint256 immediateRelease = (vesting.founderTokens *
            IMMEDIATE_FOUNDER_RELEASE) / 100;
        IERC20(token).safeTransfer(basics.founder, immediateRelease);
        vesting.founderTokensClaimed = immediateRelease;

        _setupBondingCurve(
            token,
            basics.totalSupply,
            vesting.founderTokens,
            liquidity.liquidityTokens,
            liquidityBNB
        );

        status.liquidityAdded = true;
        emit RaiseCompleted(token, basics.totalRaised);
    }

    function _setupBondingCurve(
        address token,
        uint256 totalSupply,
        uint256 founderTokens,
        uint256 liquidityTokens,
        uint256 liquidityBNB
    ) private {
        uint256 tradingTokens = totalSupply - founderTokens - liquidityTokens;
        IERC20(token).approve(address(bondingCurveDEX), tradingTokens);
        bondingCurveDEX.createPool{value: liquidityBNB}(token, tradingTokens);
    }

    function claimFounderTokens(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(msg.sender == basics.founder, "Not founder");
        require(launchStatus[token].raiseCompleted, "Raise not completed");

        uint256 claimable = _calculateClaimableFounderTokens(token);
        require(claimable > 0, "No tokens to claim");

        bool shouldBurn = _shouldBurnTokens(token);

        if (shouldBurn) {
            IERC20(token).safeTransfer(address(0xdead), claimable);
            emit TokensBurned(token, claimable);
        } else {
            IERC20(token).safeTransfer(basics.founder, claimable);
            emit FounderTokensClaimed(basics.founder, token, claimable);
        }

        launchVesting[token].founderTokensClaimed += claimable;
    }

    function claimRaisedFunds(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(msg.sender == basics.founder, "Not founder");
        require(launchStatus[token].raiseCompleted, "Raise not completed");

        uint256 claimable = _calculateClaimableRaisedFunds(token);
        require(claimable > 0, "No funds to claim");

        bool shouldRedirect = _shouldBurnTokens(token);

        if (shouldRedirect) {
            payable(infoFiAddress).transfer(claimable);
            emit RaisedFundsSentToInfoFi(token, claimable);
        } else {
            payable(basics.founder).transfer(claimable);
            emit RaisedFundsClaimed(basics.founder, token, claimable);
        }

        launchLiquidity[token].raisedFundsClaimed += claimable;
    }

    function _shouldBurnTokens(address token) private view returns (bool) {
        (, , , , uint256 currentPrice, , ) = bondingCurveDEX.getPoolInfo(token);
        LaunchBasics storage basics = launchBasics[token];
        LaunchVesting storage vesting = launchVesting[token];
        uint256 startPrice = (vesting.startMarketCap * 10 ** 18) /
            basics.totalSupply;
        return currentPrice < startPrice;
    }

    function _calculateClaimableFounderTokens(
        address token
    ) private view returns (uint256) {
        LaunchVesting storage vesting = launchVesting[token];

        if (!launchStatus[token].raiseCompleted) return 0;

        uint256 immediateRelease = (vesting.founderTokens *
            IMMEDIATE_FOUNDER_RELEASE) / 100;
        uint256 vestedTokens = vesting.founderTokens - immediateRelease;

        uint256 timePassed = block.timestamp - vesting.vestingStartTime;

        if (timePassed >= vesting.vestingDuration) {
            return vesting.founderTokens - vesting.founderTokensClaimed;
        }

        uint256 monthsPassed = timePassed / VESTING_RELEASE_INTERVAL;
        uint256 totalMonths = vesting.vestingDuration /
            VESTING_RELEASE_INTERVAL;

        uint256 totalVested = immediateRelease +
            ((vestedTokens * monthsPassed) / totalMonths);

        if (totalVested <= vesting.founderTokensClaimed) {
            return 0;
        }
        return totalVested - vesting.founderTokensClaimed;
    }

    function _calculateClaimableRaisedFunds(
        address token
    ) private view returns (uint256) {
        LaunchVesting storage vesting = launchVesting[token];
        LaunchLiquidity storage liquidity = launchLiquidity[token];

        if (!launchStatus[token].raiseCompleted) return 0;

        uint256 timePassed = block.timestamp - vesting.vestingStartTime;

        if (timePassed >= vesting.vestingDuration) {
            return liquidity.raisedFundsVesting - liquidity.raisedFundsClaimed;
        }

        uint256 totalVested = (liquidity.raisedFundsVesting * timePassed) /
            vesting.vestingDuration;

        if (totalVested <= liquidity.raisedFundsClaimed) {
            return 0;
        }
        return totalVested - liquidity.raisedFundsClaimed;
    }

    function graduateToPancakeSwap(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(status.raiseCompleted, "Raise not completed");
        require(!status.graduatedToPancakeSwap, "Already graduated");

        (, , , , , , bool graduated) = bondingCurveDEX.getPoolInfo(token);
        require(graduated, "Not ready to graduate");

        (uint256 bnbFromPool, uint256 tokensFromPool) = bondingCurveDEX
            .withdrawGraduatedPool(token);

        LaunchLiquidity storage liquidity = launchLiquidity[token];

        uint256 bnbForPancake = bnbFromPool;
        uint256 tokensForPancake = liquidity.liquidityTokens;

        if (tokensFromPool > 0) {
            IERC20(token).safeTransfer(address(0xdead), tokensFromPool);
        }

        IERC20(token).approve(address(pancakeRouter), tokensForPancake);

        pancakeRouter.addLiquidityETH{value: bnbForPancake}(
            token,
            tokensForPancake,
            0,
            0,
            address(0xdead),
            block.timestamp + 300
        );

        status.graduatedToPancakeSwap = true;
        emit GraduatedToPancakeSwap(token, bnbForPancake);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    function updatePriceFeed(address _priceFeed) external onlyOwner {
        require(_priceFeed != address(0), "Invalid address");
        priceFeed = AggregatorV3Interface(_priceFeed);
        emit PriceFeedUpdated(_priceFeed);
    }

    function updateFallbackPrice(uint256 _price) external onlyOwner {
        require(_price > 0, "Invalid price");
        fallbackBNBPrice = _price;
        emit FallbackPriceUpdated(_price);
    }

    function getLaunchInfo(
        address token
    )
        external
        view
        returns (
            address founder,
            uint256 raiseTarget,
            uint256 raiseMax,
            uint256 totalRaised,
            uint256 raiseDeadline,
            bool raiseCompleted,
            bool graduatedToPancakeSwap,
            uint256 raisedFundsVesting,
            uint256 raisedFundsClaimed,
            LaunchType launchType
        )
    {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];
        LaunchLiquidity storage liquidity = launchLiquidity[token];

        return (
            basics.founder,
            basics.raiseTarget,
            basics.raiseMax,
            basics.totalRaised,
            basics.raiseDeadline,
            status.raiseCompleted,
            status.graduatedToPancakeSwap,
            liquidity.raisedFundsVesting,
            liquidity.raisedFundsClaimed,
            basics.launchType
        );
    }

    function getLaunchInfoWithUSD(
        address token
    )
        external
        view
        returns (
            address founder,
            uint256 raiseTargetBNB,
            uint256 raiseTargetUSD,
            uint256 raiseMaxBNB,
            uint256 raiseMaxUSD,
            uint256 totalRaisedBNB,
            uint256 totalRaisedUSD,
            uint256 raiseDeadline,
            bool raiseCompleted,
            LaunchType launchType
        )
    {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        return (
            basics.founder,
            basics.raiseTarget,
            priceOracle.bnbToUSD(basics.raiseTarget),
            basics.raiseMax,
            priceOracle.bnbToUSD(basics.raiseMax),
            basics.totalRaised,
            priceOracle.bnbToUSD(basics.totalRaised),
            basics.raiseDeadline,
            status.raiseCompleted,
            basics.launchType
        );
    }

    function getClaimableAmounts(
        address token
    ) external view returns (uint256 claimableTokens, uint256 claimableFunds) {
        LaunchBasics storage basics = launchBasics[token];

        if (basics.launchType == LaunchType.PROJECT_RAISE) {
            return (
                _calculateClaimableFounderTokens(token),
                _calculateClaimableRaisedFunds(token)
            );
        } else {
            // Instant launches have no vesting
            return (0, 0);
        }
    }

    function getContribution(
        address token,
        address contributor
    ) external view returns (uint256 amount, bool claimed) {
        Contribution storage contrib = contributions[token][contributor];
        return (contrib.amount, contrib.claimed);
    }

    function getAllLaunches() external view returns (address[] memory) {
        return allLaunches;
    }

    function emergencyWithdraw(address token) external onlyOwner {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(!status.raiseCompleted, "Raise completed");
        require(block.timestamp > basics.raiseDeadline, "Raise still active");
        require(basics.totalRaised < basics.raiseTarget, "Raise target met");

        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), balance);
    }

    receive() external payable {}
}
