// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BondingDEX.sol";
import "./MockPancakeRouter.sol";

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

interface IBondingCurveDEXV3 {
    function createPool(
        address token,
        uint256 tokenAmount,
        address creator,
        bool burnLP
    ) external payable;

    function createInstantLaunchPool(
        address token,
        uint256 tokenAmount,
        address creator,
        bool burnLP
    ) external payable;

    function setLPToken(address token) external;

    function withdrawGraduatedPool(
        address token
    )
        external
        returns (
            uint256 bnbAmount,
            uint256 tokenAmount,
            uint256 remainingTokens,
            address creator
        );

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
            uint256 reservedTokens,
            uint256 currentPrice,
            uint256 priceMultiplier,
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
 * @dev ✅ UPDATED: Uses only global InfoFi address - no per-project InfoFi wallets
 */
contract LaunchpadManagerV3 is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum LaunchType {
        PROJECT_RAISE,
        INSTANT_LAUNCH
    }

    struct LaunchBasics {
        address token;
        address founder;
        uint256 totalSupply;
        uint256 raiseTarget;
        uint256 raiseMax;
        uint256 raiseDeadline;
        uint256 totalRaised;
        LaunchType launchType;
        bool burnLP;
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

    uint256 public constant MIN_RAISE_BNB = 0.1 ether;
    uint256 public constant MAX_RAISE_BNB = 0.5 ether;
    uint256 public constant MAX_LIQUIDITY_BNB = 0.2 ether;
    uint256 public constant RAISE_DURATION = 24 hours;
    uint256 public constant FOUNDER_ALLOCATION = 20;
    uint256 public constant IMMEDIATE_FOUNDER_RELEASE = 50;
    uint256 public constant LIQUIDITY_PERCENT = 10;
    uint256 public constant LIQUIDITY_BNB_PERCENT = 50;
    uint256 public constant MIN_VESTING_DURATION = 90 days;
    uint256 public constant MAX_VESTING_DURATION = 180 days;
    uint256 public constant VESTING_RELEASE_INTERVAL = 30 days;

    address public constant LP_BURN_ADDRESS =
        0x000000000000000000000000000000000000dEaD;

    AggregatorV3Interface public priceFeed;
    ITokenFactoryV2 public tokenFactory;
    IBondingCurveDEXV3 public bondingCurveDEX;
    IPancakeRouter02 public pancakeRouter;
    PriceOracle public priceOracle;
    address public infoFiAddress; // ✅ Global InfoFi address
    ILPFeeHarvester public lpFeeHarvester;
    address public pancakeFactory;
    address public wbnbAddress;

    mapping(address => LaunchBasics) public launchBasics;
    mapping(address => LaunchVesting) public launchVesting;
    mapping(address => LaunchLiquidity) public launchLiquidity;
    mapping(address => LaunchStatus) public launchStatus;
    mapping(address => mapping(address => Contribution)) public contributions;
    address[] public allLaunches;

    uint256 public fallbackBNBPrice;
    bool public useOraclePrice;

    event LaunchCreated(
        address indexed token,
        address indexed founder,
        uint256 totalSupply,
        LaunchType launchType,
        uint256 raiseTargetBNB,
        uint256 raiseMaxBNB,
        uint256 deadline,
        bool hasVanitySalt,
        bool burnLP
    );
    event InstantLaunchCreated(
        address indexed token,
        address indexed founder,
        uint256 totalSupply,
        uint256 initialBuyAmount,
        uint256 tokensReceived,
        bool burnLP
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
    event GraduatedToPancakeSwap(
        address indexed token,
        uint256 bnbForLiquidity,
        uint256 tokensForLiquidity
    );
    event LPBurned(
        address indexed token,
        address indexed lpToken,
        uint256 amount
    );
    event LPLocked(
        address indexed token,
        address indexed lpToken,
        uint256 amount
    );
    event TransfersEnabled(address indexed token, uint256 timestamp);
    event PriceFeedUpdated(address indexed newPriceFeed);
    event FallbackPriceUpdated(uint256 newPrice);
    event OracleModeChanged(bool useOracle);
    event InfoFiAddressUpdated(address indexed newInfoFiAddress);

    constructor(
        address _tokenFactory,
        address _bondingCurveDEX,
        address _pancakeRouter,
        address _priceOracle,
        address _infoFiAddress,
        address _lpFeeHarvester,
        address _pancakeFactory
    ) Ownable(msg.sender) {
        require(_tokenFactory != address(0), "Invalid token factory");
        require(_bondingCurveDEX != address(0), "Invalid bonding DEX");
        require(_pancakeRouter != address(0), "Invalid pancake router");
        require(_priceOracle != address(0), "Invalid price oracle");
        require(_infoFiAddress != address(0), "Invalid InfoFi address");
        require(_lpFeeHarvester != address(0), "Invalid LP harvester");
        pancakeFactory = _pancakeFactory;
        wbnbAddress = address(0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd);

        tokenFactory = ITokenFactoryV2(_tokenFactory);
        bondingCurveDEX = IBondingCurveDEXV3(_bondingCurveDEX);
        pancakeRouter = IPancakeRouter02(_pancakeRouter);
        infoFiAddress = _infoFiAddress;
        priceOracle = PriceOracle(_priceOracle);
        lpFeeHarvester = ILPFeeHarvester(_lpFeeHarvester);

        fallbackBNBPrice = 1200 * 10 ** 8;
        useOraclePrice = true;
    }

    function getBNBPrice() public view returns (uint256) {
        if (!useOraclePrice) return fallbackBNBPrice;
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

    // ✅ UPDATED: Removed projectInfoFiWallet parameter
    function createLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint256 raiseTargetBNB,
        uint256 raiseMaxBNB,
        uint256 vestingDuration,
        ITokenFactoryV2.TokenMetadata memory metadata,
        bool burnLP
    ) external nonReentrant returns (address) {
        return
            _createLaunch(
                name,
                symbol,
                totalSupply,
                raiseTargetBNB,
                raiseMaxBNB,
                vestingDuration,
                metadata,
                false,
                bytes32(0),
                burnLP
            );
    }

    // ✅ UPDATED: Removed projectInfoFiWallet parameter
    function createLaunchWithVanity(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint256 raiseTargetBNB,
        uint256 raiseMaxBNB,
        uint256 vestingDuration,
        ITokenFactoryV2.TokenMetadata memory metadata,
        bytes32 vanitySalt,
        bool burnLP
    ) external nonReentrant returns (address) {
        return
            _createLaunch(
                name,
                symbol,
                totalSupply,
                raiseTargetBNB,
                raiseMaxBNB,
                vestingDuration,
                metadata,
                true,
                vanitySalt,
                burnLP
            );
    }

    function _createLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint256 raiseTargetBNB,
        uint256 raiseMaxBNB,
        uint256 vestingDuration,
        ITokenFactoryV2.TokenMetadata memory metadata,
        bool useVanity,
        bytes32 vanitySalt,
        bool burnLP
    ) private returns (address) {
        _validateLaunchParams(raiseTargetBNB, raiseMaxBNB, vestingDuration);

        address token = _deployToken(
            name,
            symbol,
            totalSupply,
            metadata,
            useVanity,
            vanitySalt
        );

        ILaunchpadToken(token).setExemption(address(bondingCurveDEX), true);
        ILaunchpadToken(token).setExemption(address(pancakeRouter), true);
        ILaunchpadToken(token).setExemption(address(lpFeeHarvester), true);

        _initializeLaunch(
            token,
            totalSupply,
            raiseTargetBNB,
            raiseMaxBNB,
            vestingDuration,
            LaunchType.PROJECT_RAISE,
            burnLP
        );

        emit LaunchCreated(
            token,
            msg.sender,
            totalSupply * 10 ** 18,
            LaunchType.PROJECT_RAISE,
            raiseTargetBNB,
            raiseMaxBNB,
            block.timestamp + RAISE_DURATION,
            useVanity,
            burnLP
        );

        return token;
    }

    function createInstantLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        uint256 initialBuyBNB,
        bool burnLP
    ) external payable nonReentrant returns (address) {
        return
            _createInstantLaunch(
                name,
                symbol,
                totalSupply,
                metadata,
                initialBuyBNB,
                false,
                bytes32(0),
                burnLP
            );
    }

    function createInstantLaunchWithVanity(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        uint256 initialBuyBNB,
        bytes32 vanitySalt,
        bool burnLP
    ) external payable nonReentrant returns (address) {
        return
            _createInstantLaunch(
                name,
                symbol,
                totalSupply,
                metadata,
                initialBuyBNB,
                true,
                vanitySalt,
                burnLP
            );
    }

    function _createInstantLaunch(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        ITokenFactoryV2.TokenMetadata memory metadata,
        uint256 initialBuyBNB,
        bool useVanity,
        bytes32 vanitySalt,
        bool burnLP
    ) private returns (address) {
        require(msg.value >= initialBuyBNB, "Insufficient BNB sent");

        address token = _deployToken(
            name,
            symbol,
            totalSupply,
            metadata,
            useVanity,
            vanitySalt
        );

        ILaunchpadToken(token).setExemption(address(bondingCurveDEX), true);
        ILaunchpadToken(token).setExemption(address(pancakeRouter), true);
        ILaunchpadToken(token).setExemption(address(lpFeeHarvester), true);

        uint256 totalSupplyWei = 1_000_000_000 * 10 ** 18;
        require(totalSupply == 1_000_000_000, "Total supply must be 1 billion");

        launchBasics[token] = LaunchBasics({
            token: token,
            founder: msg.sender,
            totalSupply: totalSupplyWei,
            raiseTarget: 0,
            raiseMax: 0,
            raiseDeadline: 0,
            totalRaised: 0,
            launchType: LaunchType.INSTANT_LAUNCH,
            burnLP: burnLP
        });

        launchStatus[token] = LaunchStatus({
            raiseCompleted: true,
            liquidityAdded: true,
            graduatedToPancakeSwap: false
        });

        allLaunches.push(token);

        uint256 initialLiquidityBNB = 0;
        if (msg.value > initialBuyBNB) {
            initialLiquidityBNB = msg.value - initialBuyBNB;
        }

        IERC20(token).approve(address(bondingCurveDEX), totalSupplyWei);
        bondingCurveDEX.createInstantLaunchPool{value: initialLiquidityBNB}(
            token,
            totalSupplyWei,
            msg.sender,
            burnLP
        );
        uint256 tokensReceived = 0;
        if (initialBuyBNB > 0) {
            tokensReceived = _executeInitialBuy(token, initialBuyBNB);
        }

        emit InstantLaunchCreated(
            token,
            msg.sender,
            totalSupplyWei,
            initialBuyBNB,
            tokensReceived,
            burnLP
        );

        return token;
    }

    function _executeInitialBuy(
        address token,
        uint256 buyAmount
    ) private returns (uint256) {
        (uint256 tokensOut, ) = bondingCurveDEX.getBuyQuote(token, buyAmount);

        bondingCurveDEX.buyTokens{value: buyAmount}(token, tokensOut);

        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(msg.sender, balance);

        return balance;
    }

    function graduateToPancakeSwap(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            !status.graduatedToPancakeSwap,
            "Already graduated to PancakeSwap"
        );

        (, , , , , , , , bool graduated) = bondingCurveDEX.getPoolInfo(token);
        require(graduated, "Not ready to graduate");

        (
            uint256 bnbForLiquidity,
            uint256 tokensForLiquidity,
            uint256 remainingTokens,
            address creator
        ) = bondingCurveDEX.withdrawGraduatedPool(token);

        require(creator == basics.founder, "Creator mismatch");

        IERC20(token).approve(address(pancakeRouter), tokensForLiquidity);

        (, , uint256 liquidity) = pancakeRouter.addLiquidityETH{
            value: bnbForLiquidity
        }(
            token,
            tokensForLiquidity,
            0,
            0,
            address(this),
            block.timestamp + 300
        );

        require(liquidity > 0, "No liquidity");

        address lpToken = _getPancakePairAddressFromFactory(token, wbnbAddress);
        require(lpToken != address(0), "LP token not found");
        bondingCurveDEX.setLPToken(token);
        if (basics.burnLP) {
            IERC20(lpToken).safeTransfer(LP_BURN_ADDRESS, liquidity);
            emit LPBurned(token, lpToken, liquidity);
        } else {
            IERC20(lpToken).approve(address(lpFeeHarvester), liquidity);

            // ✅ UPDATED: Always use global infoFiAddress
            lpFeeHarvester.lockLP(
                token,
                lpToken,
                basics.founder,
                infoFiAddress,
                liquidity,
                0
            );

            emit LPLocked(token, lpToken, liquidity);
        }

        ILaunchpadToken(token).enableTransfers();

        status.graduatedToPancakeSwap = true;

        emit GraduatedToPancakeSwap(token, bnbForLiquidity, tokensForLiquidity);
        emit TransfersEnabled(token, block.timestamp);
    }

    function _getPancakePairAddressFromFactory(
        address tokenA,
        address tokenB
    ) private view returns (address) {
        (bool success, bytes memory data) = pancakeFactory.staticcall(
            abi.encodeWithSignature("getPair(address,address)", tokenA, tokenB)
        );

        if (success && data.length >= 32) {
            address pair = abi.decode(data, (address));
            if (pair != address(0)) {
                return pair;
            }
        }

        (success, data) = pancakeFactory.staticcall(
            abi.encodeWithSignature("getPair(address,address)", tokenB, tokenA)
        );

        if (success && data.length >= 32) {
            return abi.decode(data, (address));
        }

        return address(0);
    }

    function _getPancakePairAddress(
        address token
    ) private view returns (address) {
        return _getPancakePairAddressFromFactory(token, wbnbAddress);
    }

    function _validateLaunchParams(
        uint256 raiseTargetBNB,
        uint256 raiseMaxBNB,
        uint256 vestingDuration
    ) private pure {
        require(
            raiseTargetBNB >= MIN_RAISE_BNB && raiseTargetBNB <= MAX_RAISE_BNB,
            "Invalid raise target"
        );
        require(
            raiseMaxBNB >= raiseTargetBNB && raiseMaxBNB <= MAX_RAISE_BNB,
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
        LaunchType launchType,
        bool burnLP
    ) private {
        uint256 totalSupplyWei = totalSupply * 10 ** 18;
        uint256 founderTokens = (totalSupplyWei * FOUNDER_ALLOCATION) / 100;

        launchBasics[token] = LaunchBasics({
            token: token,
            founder: msg.sender,
            totalSupply: totalSupplyWei,
            raiseTarget: raiseTarget,
            raiseMax: raiseMax,
            raiseDeadline: block.timestamp + RAISE_DURATION,
            totalRaised: 0,
            launchType: launchType,
            burnLP: burnLP
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
            liquidityTokens: 0,
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

        if (liquidityBNB > MAX_LIQUIDITY_BNB) {
            liquidityBNB = MAX_LIQUIDITY_BNB;
        }

        liquidity.liquidityBNB = liquidityBNB;
        liquidity.raisedFundsVesting = basics.totalRaised - liquidityBNB;

        uint256 tradingTokens = (basics.totalSupply * 70) / 100;

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
            liquidityBNB
        );

        status.liquidityAdded = true;
        emit RaiseCompleted(token, basics.totalRaised);
    }

    function _setupBondingCurve(
        address token,
        uint256 totalSupply,
        uint256 founderTokens,
        uint256 liquidityBNB
    ) private {
        LaunchBasics storage basics = launchBasics[token];
        uint256 tokensForDEX = totalSupply - founderTokens;

        IERC20(token).approve(address(bondingCurveDEX), tokensForDEX);
        bondingCurveDEX.createPool{value: liquidityBNB}(
            token,
            tokensForDEX,
            basics.founder,
            basics.burnLP
        );
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
            // ✅ UPDATED: Use global infoFiAddress
            payable(infoFiAddress).transfer(claimable);
            emit RaisedFundsSentToInfoFi(token, claimable);
        } else {
            payable(basics.founder).transfer(claimable);
            emit RaisedFundsClaimed(basics.founder, token, claimable);
        }

        launchLiquidity[token].raisedFundsClaimed += claimable;
    }

    function _shouldBurnTokens(address token) private view returns (bool) {
        (, , , , , uint256 currentPrice, , , ) = bondingCurveDEX.getPoolInfo(
            token
        );
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

        // ✅ MONTHLY VESTING (same as founder tokens)
        uint256 monthsPassed = timePassed / VESTING_RELEASE_INTERVAL;
        uint256 totalMonths = vesting.vestingDuration /
            VESTING_RELEASE_INTERVAL;

        uint256 totalVested = (liquidity.raisedFundsVesting * monthsPassed) /
            totalMonths;

        if (totalVested <= liquidity.raisedFundsClaimed) {
            return 0;
        }
        return totalVested - liquidity.raisedFundsClaimed;
    }

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

    function updateLPFeeHarvester(address _lpFeeHarvester) external onlyOwner {
        require(_lpFeeHarvester != address(0), "Invalid address");
        lpFeeHarvester = ILPFeeHarvester(_lpFeeHarvester);
    }

    // ✅ NEW: Function to update global InfoFi address
    function updateInfoFiAddress(address _infoFiAddress) external onlyOwner {
        require(_infoFiAddress != address(0), "Invalid address");
        infoFiAddress = _infoFiAddress;
        emit InfoFiAddressUpdated(_infoFiAddress);
    }

    // ✅ UPDATED: Removed projectInfoFiWallet from return values
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
            LaunchType launchType,
            bool burnLP
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
            basics.launchType,
            basics.burnLP
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
            LaunchType launchType,
            bool burnLP
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
            basics.launchType,
            basics.burnLP
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
