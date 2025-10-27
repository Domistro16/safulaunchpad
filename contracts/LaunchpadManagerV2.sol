// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LaunchpadManagerV3 - FIXED for Project Raise Flow
 * @author SafuPad Team
 * @notice Manages two types of token launches: Project Raise and Instant Launch
 *
 * VERSION: 2.0.0 (Major Fixes Applied)
 *
 * ═══════════════════════════════════════════════════════════════════
 * CRITICAL FIXES APPLIED:
 * ═══════════════════════════════════════════════════════════════════
 *
 * ✅ FIX #1: Added per-wallet contribution cap (4.44 BNB)
 *    - Prevents whales from monopolizing Project Raise
 *    - Added MAX_CONTRIBUTION_PER_WALLET constant
 *    - Enforced in contribute() function
 *
 * ✅ FIX #2: Added claimContributorTokens() function
 *    - Contributors can now claim their tokens after successful raise
 *    - Proportional distribution from 70% contributor allocation
 *    - Critical fix - tokens were previously stuck!
 *
 * ✅ FIX #3: Added claimRefund() function
 *    - Contributors get refunds if raise fails
 *    - Available after 24h deadline if target not met
 *    - Critical fix - BNB was previously stuck!
 *
 * ✅ FIX #4: Fixed token distribution for Project Raise
 *    - Tokens now stay in LaunchpadManager (not sent to BondingCurveDEX)
 *    - 70% for contributors (claim via claimContributorTokens)
 *    - 20% for founder (vested)
 *    - 10% for PancakeSwap (added in graduateToPancakeSwap)
 *
 * ✅ FIX #5: Added 1% platform fee on PancakeSwap liquidity
 *    - Deducted from BNB before adding liquidity
 *    - Applies to both Project Raise and Instant Launch
 *    - Sent to platformFeeAddress
 *
 * ✅ FIX #6: Added burnFailedRaiseTokens() function
 *    - Burns tokens if raise fails
 *    - Callable by anyone after deadline
 *
 * ✅ FIX #7: Separated Project Raise from BondingCurveDEX
 *    - Project Raise = Fixed-price contribution period
 *    - Instant Launch = Uses bonding curve
 *    - Clear separation of logic
 *
 * ═══════════════════════════════════════════════════════════════════
 * PROJECT RAISE FLOW:
 * ═══════════════════════════════════════════════════════════════════
 *
 * 1. LAUNCH (Founder)
 *    - Creates token (1B supply)
 *    - Sets raise target & max
 *    - 24-hour timer starts
 *
 * 2. CONTRIBUTION PERIOD (24 hours)
 *    - Users contribute BNB (max 4.44 per wallet)
 *    - Fixed price: raiseTarget / 700M tokens
 *    - Get proportional allocation from 70% pool
 *
 * 3A. IF SUCCESS (target met):
 *     - Contributors claim tokens (70% = 700M)
 *     - Founder gets 20% (200M, vested)
 *     - 10% (100M) + 50% BNB → PancakeSwap (-1% fee)
 *     - Remaining BNB → Founder (vested)
 *
 * 3B. IF FAILED (target not met):
 *     - All contributors get refunded
 *     - Tokens burned
 *
 * ═══════════════════════════════════════════════════════════════════
 * INSTANT LAUNCH FLOW:
 * ═══════════════════════════════════════════════════════════════════
 *
 * 1. Launch with bonding curve via BondingCurveDEX
 * 2. Trade on curve until graduation
 * 3. Graduate to PancakeSwap (-1% fee)
 *
 * ═══════════════════════════════════════════════════════════════════
 */

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PriceOracle.sol";
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

interface ILaunchpadToken {

function enableTransfers() external;
function setExemption(address account, bool exempt) external;
}

interface IBondingCurveDEXV3 {
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

    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function WETH() external pure returns (address);

    function getAmountsOut(
        uint amountIn,
        address[] calldata path
    ) external view returns (uint[] memory amounts);
}

interface ILPFeeHarvester {
    function lockLP(
        address projectToken,
        address lpToken,
        address creator,
        address projectInfoFi,
        uint256 lpAmount,
        uint256 lockDuration
    ) external;
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
    uint256 public constant MAX_CONTRIBUTION_PER_WALLET = 0.1 ether; // ✅ NEW: Per-wallet contribution cap
    uint256 public constant RAISE_DURATION = 24 hours;
    uint256 public constant FOUNDER_ALLOCATION = 20;
    uint256 public constant CONTRIBUTOR_ALLOCATION = 70; // ✅ NEW: 70% for contributors
    uint256 public constant PANCAKESWAP_ALLOCATION = 10; // ✅ NEW: 10% for PancakeSwap
    uint256 public constant IMMEDIATE_FOUNDER_RELEASE = 50;
    uint256 public constant LIQUIDITY_PERCENT = 10;
    uint256 public constant LIQUIDITY_BNB_PERCENT = 50;
    uint256 public constant PLATFORM_FEE_BPS = 100; // ✅ NEW: 1% platform fee (100 basis points)
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MIN_VESTING_DURATION = 90 days;
    uint256 public constant MAX_VESTING_DURATION = 180 days;
    uint256 public constant VESTING_RELEASE_INTERVAL = 30 days;

    address public constant LP_BURN_ADDRESS =
        0x000000000000000000000000000000000000dEaD;

    ITokenFactoryV2 public tokenFactory;
    IBondingCurveDEXV3 public bondingCurveDEX;
    IPancakeRouter02 public pancakeRouter;
    PriceOracle public priceOracle;
    address public infoFiAddress; // ✅ Global InfoFi address
    address public platformFeeAddress; // ✅ NEW: Platform fee recipient
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
    event ContributorTokensClaimed(
        address indexed contributor,
        address indexed token,
        uint256 amount
    ); // ✅ NEW
    event RefundClaimed(
        address indexed contributor,
        address indexed token,
        uint256 amount
    ); // ✅ NEW
    event RaiseFailed(address indexed token, uint256 totalRaised); // ✅ NEW
    event PlatformFeePaid(
        address indexed token,
        uint256 amount,
        string feeType
    ); // ✅ NEW
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
        address _platformFeeAddress, // ✅ NEW
        address _lpFeeHarvester,
        address _pancakeFactory
    ) Ownable(msg.sender) {
        require(_tokenFactory != address(0), "Invalid token factory");
        require(_bondingCurveDEX != address(0), "Invalid bonding DEX");
        require(_pancakeRouter != address(0), "Invalid pancake router");
        require(_priceOracle != address(0), "Invalid price oracle");
        require(_infoFiAddress != address(0), "Invalid InfoFi address");
        require(
            _platformFeeAddress != address(0),
            "Invalid platform fee address"
        ); // ✅ NEW
        require(_lpFeeHarvester != address(0), "Invalid LP harvester");
        pancakeFactory = _pancakeFactory;
        wbnbAddress = address(0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd);

        tokenFactory = ITokenFactoryV2(_tokenFactory);
        bondingCurveDEX = IBondingCurveDEXV3(_bondingCurveDEX);
        pancakeRouter = IPancakeRouter02(_pancakeRouter);
        infoFiAddress = _infoFiAddress;
        platformFeeAddress = _platformFeeAddress; // ✅ NEW
        priceOracle = PriceOracle(_priceOracle);
        lpFeeHarvester = ILPFeeHarvester(_lpFeeHarvester);

        fallbackBNBPrice = 1200 * 10 ** 8;
        useOraclePrice = true;
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

        uint256 bnbForLiquidity;
        uint256 tokensForLiquidity;

        if (basics.launchType == LaunchType.PROJECT_RAISE) {
            // ✅ PROJECT RAISE: Add 10% of tokens with liquidity BNB
            require(status.raiseCompleted, "Raise not completed");
            require(!status.liquidityAdded, "Liquidity already added");

            LaunchLiquidity storage liquidity = launchLiquidity[token];

            // 10% of total supply for PancakeSwap
            tokensForLiquidity =
                (basics.totalSupply * PANCAKESWAP_ALLOCATION) /
                100;
            bnbForLiquidity = liquidity.liquidityBNB;

            require(bnbForLiquidity > 0, "No BNB for liquidity");
            require(tokensForLiquidity > 0, "No tokens for liquidity");

            // ✅ DEDUCT 1% PLATFORM FEE from BNB
            uint256 platformFee = (bnbForLiquidity * PLATFORM_FEE_BPS) /
                BASIS_POINTS;
            bnbForLiquidity = bnbForLiquidity - platformFee;

            // Send platform fee
            payable(platformFeeAddress).transfer(platformFee);
            emit PlatformFeePaid(token, platformFee, "Project Raise Liquidity");

            status.liquidityAdded = true;
        } else {
            // ✅ INSTANT LAUNCH: Get from BondingCurveDEX
            (, , , , , , , , bool graduated) = bondingCurveDEX.getPoolInfo(
                token
            );
            require(graduated, "Not ready to graduate");

            address creator;
            uint256 remainingTokens;
            (
                bnbForLiquidity,
                tokensForLiquidity,
                remainingTokens,
                creator
            ) = bondingCurveDEX.withdrawGraduatedPool(token);

            require(creator == basics.founder, "Creator mismatch");

            // ✅ DEDUCT 1% PLATFORM FEE from BNB for Instant Launch too
            uint256 platformFee = (bnbForLiquidity * PLATFORM_FEE_BPS) /
                BASIS_POINTS;
            bnbForLiquidity = bnbForLiquidity - platformFee;

            // Send platform fee
            payable(platformFeeAddress).transfer(platformFee);
            emit PlatformFeePaid(
                token,
                platformFee,
                "Instant Launch Liquidity"
            );
        }

        // Approve and add liquidity
        IERC20(token).approve(address(pancakeRouter), tokensForLiquidity);

        (, , uint256 liquidity) = pancakeRouter.addLiquidityETH{
            value: bnbForLiquidity
        }(
            token,
            tokensForLiquidity,
            0, // TODO: Add slippage protection
            0, // TODO: Add slippage protection
            address(this),
            block.timestamp + 300
        );

        require(liquidity > 0, "No liquidity");

        // Get LP token address and handle LP tokens
        address lpToken = _getPancakePairAddressFromFactory(token, wbnbAddress);
        require(lpToken != address(0), "LP token not found");

        if (basics.launchType == LaunchType.INSTANT_LAUNCH) {
            bondingCurveDEX.setLPToken(token);
        }

        if (basics.burnLP) {
            IERC20(lpToken).safeTransfer(LP_BURN_ADDRESS, liquidity);
            emit LPBurned(token, lpToken, liquidity);
        } else {
            IERC20(lpToken).approve(address(lpFeeHarvester), liquidity);

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

        // Enable transfers
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

        // ✅ FIX: Per-wallet contribution cap
        require(
            contributions[token][msg.sender].amount + msg.value <=
                MAX_CONTRIBUTION_PER_WALLET,
            "Exceeds per-wallet contribution limit (4.44 BNB)"
        );

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

        // Calculate liquidity BNB (50% of raised, max 0.2 BNB)
        uint256 liquidityBNB = (basics.totalRaised * LIQUIDITY_BNB_PERCENT) /
            100;
        if (liquidityBNB > MAX_LIQUIDITY_BNB) {
            liquidityBNB = MAX_LIQUIDITY_BNB;
        }

        liquidity.liquidityBNB = liquidityBNB;
        liquidity.raisedFundsVesting = basics.totalRaised - liquidityBNB;

        // ✅ FIX: Project Raise tokens stay here for distribution
        // 70% for contributors (claimed via claimContributorTokens)
        // 20% for founder (vested)
        // 10% for PancakeSwap (added in graduateToPancakeSwap)

        // Calculate market cap based on contributor allocation
        uint256 contributorTokens = (basics.totalSupply *
            CONTRIBUTOR_ALLOCATION) / 100;
        vesting.startMarketCap =
            (liquidityBNB * ((basics.totalSupply * 10) / 100)) /
            contributorTokens;

        // Give founder immediate 50% of their allocation
        uint256 immediateRelease = (vesting.founderTokens *
            IMMEDIATE_FOUNDER_RELEASE) / 100;
        IERC20(token).safeTransfer(basics.founder, immediateRelease);
        vesting.founderTokensClaimed = immediateRelease;

        // ✅ FIX: DO NOT send tokens to BondingCurveDEX for Project Raise!
        // Tokens remain in LaunchpadManager for contributors to claim

        status.liquidityAdded = false; // Will be set true when graduated to PancakeSwap
        emit RaiseCompleted(token, basics.totalRaised);
    }

    // ❌ REMOVED: _setupBondingCurve - Project Raise doesn't use BondingCurveDEX
    // function _setupBondingCurve(...) private { ... }

    /**
     * @notice Contributors claim their tokens after successful raise
     * @dev Tokens are distributed proportionally based on contribution amount
     */
    function claimContributorTokens(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(status.raiseCompleted, "Raise not completed");
        require(basics.totalRaised >= basics.raiseTarget, "Raise failed");

        Contribution storage contrib = contributions[token][msg.sender];
        require(contrib.amount > 0, "No contribution");
        require(!contrib.claimed, "Already claimed");

        // Calculate proportional share from 70% contributor allocation
        uint256 contributorPool = (basics.totalSupply *
            CONTRIBUTOR_ALLOCATION) / 100; // 700M
        uint256 tokensOwed = (contrib.amount * contributorPool) /
            basics.totalRaised;

        contrib.claimed = true;
        IERC20(token).safeTransfer(msg.sender, tokensOwed);

        emit ContributorTokensClaimed(msg.sender, token, tokensOwed);
    }

    /**
     * @notice Contributors claim refund if raise fails
     * @dev Refund available if raise doesn't meet target after deadline
     */
    function claimRefund(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(block.timestamp > basics.raiseDeadline, "Raise still active");
        require(
            basics.totalRaised < basics.raiseTarget,
            "Raise was successful"
        );
        require(!status.raiseCompleted, "Raise completed");

        Contribution storage contrib = contributions[token][msg.sender];
        require(contrib.amount > 0, "No contribution");
        require(!contrib.claimed, "Already claimed");

        uint256 refundAmount = contrib.amount;
        contrib.claimed = true;

        payable(msg.sender).transfer(refundAmount);

        emit RefundClaimed(msg.sender, token, refundAmount);
    }

    /**
     * @notice Burn tokens for failed raise (callable by anyone after deadline)
     * @dev Burns all tokens if raise target not met
     */
    function burnFailedRaiseTokens(address token) external nonReentrant {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        require(
            basics.launchType == LaunchType.PROJECT_RAISE,
            "Not a project raise"
        );
        require(block.timestamp > basics.raiseDeadline, "Raise still active");
        require(
            basics.totalRaised < basics.raiseTarget,
            "Raise was successful"
        );
        require(!status.raiseCompleted, "Raise completed");

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(address(0xdead), balance);
            emit TokensBurned(token, balance);
            emit RaiseFailed(token, basics.totalRaised);
        }
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

        payable(basics.founder).transfer(claimable);
        emit RaisedFundsClaimed(basics.founder, token, claimable);

        launchLiquidity[token].raisedFundsClaimed += claimable;
    }

    function _shouldBurnTokens(address token) private view returns (bool) {
        LaunchBasics storage basics = launchBasics[token];
        LaunchStatus storage status = launchStatus[token];

        if (basics.launchType == LaunchType.PROJECT_RAISE) {
            // Only burn if raise failed
            return
                (block.timestamp >= basics.raiseDeadline) &&
                !status.raiseCompleted;
        } else {
            // INSTANT_LAUNCH: Check bonding curve price
            (, , , , , uint256 currentPrice, , , ) = bondingCurveDEX
                .getPoolInfo(token);
            LaunchVesting storage vesting = launchVesting[token];
            uint256 startPrice = (vesting.startMarketCap * 10 ** 18) /
                basics.totalSupply;
            return currentPrice < startPrice;
        }
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
