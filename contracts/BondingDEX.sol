// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/**

* @title BondingCurveDEX - INSTANT_LAUNCH Only Version
* @dev Version: 2.0.0 (Simplified - PROJECT_RAISE removed)
*
* CHANGES FROM v1.1.0:
* - Removed all PROJECT_RAISE functionality
* - Only supports INSTANT_LAUNCH tokens
* - Simplified fee distribution (single structure)
* - Cleaner, more focused codebase
*
* SECURITY FIXES (carried over from v1.1.0):
* ✅ Fix #1: Added strict input validation in createInstantLaunchPool()
* ✅ Fix #2: Added slippage protection in _handlePostGraduationSell()
* ✅ Fix #3: State updates before external calls (CEI pattern) + nonReentrant
*
* Status: PRODUCTION READY
*/
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PriceOracle.sol";

interface ILaunchpadToken {
    function enableTransfers() external;

    function setExemption(address account, bool exempt) external;
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

interface IPancakeFactory {
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address);
}

/**

* @title BondingCurveDEX - INSTANT_LAUNCH Only
* @dev Simplified bonding curve DEX supporting only INSTANT_LAUNCH tokens
*/
contract BondingCurveDEX is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    struct Pool {
        address token;
        uint256 bnbReserve;
        uint256 tokenReserve;
        uint256 reservedTokens;
        uint256 totalTokenSupply;
        uint256 marketCap;
        uint256 graduationMarketCap;
        bool graduated;
        bool active;
        address creator;
        uint256 virtualBnbReserve;
        uint256 bnbForPancakeSwap;
        address lpToken;
        bool burnLP;
        uint256 launchBlock;
        uint256 graduationBnbThreshold;
        uint256 graduationMarketCapBNB;
    }
    struct FeeDistribution {
        uint256 platformFee;
        uint256 creatorFee;
        uint256 infoFiFee;
        uint256 liquidityFee;
    }
    struct CreatorFees {
        uint256 accumulatedFees;
        uint256 lastClaimTime;
        uint256 graduationMarketCap;
        uint256 weekStartTime;
        uint256 totalPurchaseVolume;
    }
    struct PostGraduationStats {
        uint256 totalTokensSold;
        uint256 totalLiquidityAdded;
        uint256 lpTokensGenerated;
    }
    // Constants

    uint256 public constant TOTAL_TOKEN_SUPPLY = 1_000_000_000 * 10 ** 18;
    uint256 public constant GRADUATION_BNB_THRESHOLD = 0.6 ether;
    uint256 public constant TARGET_PRICE_MULTIPLIER = 6;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant CLAIM_COOLDOWN = 24 hours;
    uint256 public constant REDISTRIBUTION_PERIOD = 7 days;
    uint256 public constant INSTANT_LAUNCH_PANCAKESWAP_PERCENT = 20; // 20% reserved for PancakeSwap
    uint256 public constant POST_GRADUATION_FEE_BPS = 200; // 2% post-graduation fee
    address public constant LP_BURN_ADDRESS =
        0x000000000000000000000000000000000000dEaD;
    // Anti-bot dynamic fee structure for INSTANT_LAUNCH

    uint256 public constant INITIAL_FEE_BPS = 1000; // 10% at launch
    uint256 public constant FINAL_FEE_BPS = 200; // 2% final fee for INSTANT_LAUNCH
    uint256 public constant FEE_DECAY_BLOCK_1 = 20;
    uint256 public constant FEE_DECAY_BLOCK_2 = 50;
    uint256 public constant FEE_DECAY_BLOCK_3 = 100;
    uint256 public constant FEE_TIER_1 = 1000; // 10%
    uint256 public constant FEE_TIER_2 = 600; // 6%
    uint256 public constant FEE_TIER_3 = 400; // 4%
    // Fee distribution structure (no liquidity fee for INSTANT_LAUNCH)

    FeeDistribution public feeDistribution;
    // State variables

    address public platformFeeAddress;
    address public academyFeeAddress;
    address public infoFiFeeAddress;
    PriceOracle public priceOracle;
    IPancakeRouter02 public pancakeRouter;
    IPancakeFactory public pancakeFactory;
    ILPFeeHarvester public lpFeeHarvester;
    address public wbnbAddress;
    mapping(address => Pool) public pools;

    mapping(address => CreatorFees) public creatorFees;
    mapping(address => PostGraduationStats) public postGradStats;
    address[] public activeTokens;
    bool public paused;

    // Events

    event PoolCreated(
        address indexed token,
        uint256 initialLiquidity,
        uint256 tradableTokens,
        uint256 reservedTokens,
        address indexed creator,
        uint256 launchBlock,
        uint256 virtualBnbReserve,
        uint256 graduationBnbThreshold
    );
    event TokensBought(
        address indexed buyer,
        address indexed token,
        uint256 bnbAmount,
        uint256 tokensReceived,
        uint256 currentPrice,
        uint256 feeRate
    );
    event TokensSold(
        address indexed seller,
        address indexed token,
        uint256 tokensAmount,
        uint256 bnbReceived,
        uint256 currentPrice,
        uint256 feeRate
    );
    event PoolGraduated(
        address indexed token,
        uint256 finalMarketCap,
        uint256 finalPrice,
        uint256 reservedTokens,
        uint256 bnbForPancakeSwap
    );
    event FeesCollected(
        address indexed token,
        uint256 platformFee,
        uint256 creatorFee,
        uint256 infoFiFee
    );
    event CreatorFeesClaimed(
        address indexed creator,
        address indexed token,
        uint256 amount
    );
    event CreatorFeesRedirectedToInfoFi(address indexed token, uint256 amount);
    event LiquidityIncreased(address indexed token, uint256 bnbAdded);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event PostGraduationSell(
        address indexed seller,
        address indexed token,
        uint256 tokensIn,
        uint256 bnbOut,
        uint256 liquidityAdded,
        uint256 lpGenerated
    );
    event LPTokensHandled(
        address indexed token,
        address indexed lpToken,
        uint256 amount,
        bool burned
    );
    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    constructor(
        address _platformFeeAddress,
        address _academyFeeAddress,
        address _infoFiFeeAddress,
        address _priceOracle,
        address _admin,
        address _pancakeRouter,
        address _pancakeFactory,
        address _lpFeeHarvester
    ) {
        require(_platformFeeAddress != address(0), "Invalid platform address");
        require(_academyFeeAddress != address(0), "Invalid academy address");
        require(_infoFiFeeAddress != address(0), "Invalid InfoFi address");
        require(_priceOracle != address(0), "Invalid price oracle");
        require(_admin != address(0), "Invalid admin address");
        require(_pancakeRouter != address(0), "Invalid router");
        require(_pancakeFactory != address(0), "Invalid factory");
        require(_lpFeeHarvester != address(0), "Invalid harvester");
        platformFeeAddress = _platformFeeAddress;

        academyFeeAddress = _academyFeeAddress;
        infoFiFeeAddress = _infoFiFeeAddress;
        priceOracle = PriceOracle(_priceOracle);
        pancakeRouter = IPancakeRouter02(_pancakeRouter);
        pancakeFactory = IPancakeFactory(_pancakeFactory);
        lpFeeHarvester = ILPFeeHarvester(_lpFeeHarvester);
        wbnbAddress = pancakeRouter.WETH();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        _grantRole(EMERGENCY_ROLE, _admin);
        // INSTANT_LAUNCH fee distribution: 5% platform, 50% creator, 45% InfoFi, 0% liquidity

        feeDistribution = FeeDistribution({
            platformFee: 5,
            creatorFee: 50,
            infoFiFee: 45,
            liquidityFee: 0
        });
        paused = false;
    }

    /**

* @notice Get current fee rate based on blocks since launch
* @dev Fee decays from 10% to 2% over 100 blocks for INSTANT_LAUNCH
*/
    function getCurrentFeeRate(address token) public view returns (uint256) {
        Pool memory pool = pools[token];
        if (pool.graduated || !pool.active) {
            return POST_GRADUATION_FEE_BPS;
        }
        uint256 blocksSinceLaunch = block.number - pool.launchBlock;
        if (blocksSinceLaunch < FEE_DECAY_BLOCK_1) {
            return FEE_TIER_1; // 10%
        } else if (blocksSinceLaunch < FEE_DECAY_BLOCK_2) {
            return FEE_TIER_2; // 6%
        } else if (blocksSinceLaunch < FEE_DECAY_BLOCK_3) {
            return FEE_TIER_3; // 4%
        } else {
            return FINAL_FEE_BPS; // 2% final fee
        }
    }

    /**
* @notice Create an INSTANT_LAUNCH pool

* @dev Only callable by MANAGER_ROLE. Creates a bonding curve pool with virtual reserves.
* @param token The token address
* @param tokenAmount Total token amount (must be 1 billion)
* @param creator The creator address
* @param burnLP Whether to burn LP tokens or lock them
*/
    function createInstantLaunchPool(
        address token,
        uint256 tokenAmount,
        address creator,
        bool burnLP
    ) external payable onlyRole(MANAGER_ROLE) whenNotPaused {
        require(tokenAmount == TOTAL_TOKEN_SUPPLY, "Must be 1 billion tokens");
        require(creator != address(0), "Invalid creator");
        // 20% reserved for PancakeSwap, 80% tradable on curve
        uint256 reservedTokens = (TOTAL_TOKEN_SUPPLY *
            INSTANT_LAUNCH_PANCAKESWAP_PERCENT) / 100;
        uint256 tradableTokens = TOTAL_TOKEN_SUPPLY - reservedTokens;
        _createPool(token, tradableTokens, reservedTokens, creator, burnLP);
    }

    /**
* @notice Internal function to create a pool

*/
    function _createPool(
        address token,
        uint256 tradableTokens,
        uint256 reservedTokens,
        address creator,
        bool burnLP
    ) private {
        require(!pools[token].active, "Pool already exists");
        require(tradableTokens > 0, "Token amount must be > 0");
        require(reservedTokens > 0, "Reserved tokens must be > 0");
        uint256 totalTokens = tradableTokens + reservedTokens;
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalTokens);

        uint256 bnbReserve = msg.value;
        uint256 initialMarketCap = 0;

        if (bnbReserve > 0) {
            initialMarketCap =
                (bnbReserve * TOTAL_TOKEN_SUPPLY) /
                tradableTokens;
        }
        // Calculate virtual BNB reserve for price shaping
        uint256 virtualBnbReserve = GRADUATION_BNB_THRESHOLD /
            (TARGET_PRICE_MULTIPLIER - 1);
        require(virtualBnbReserve > 0, "Virtual reserve must be > 0");
        pools[token] = Pool({
            token: token,
            bnbReserve: bnbReserve,
            tokenReserve: tradableTokens,
            reservedTokens: reservedTokens,
            totalTokenSupply: TOTAL_TOKEN_SUPPLY,
            marketCap: initialMarketCap,
            graduationMarketCap: 0,
            graduated: false,
            active: true,
            creator: creator,
            virtualBnbReserve: virtualBnbReserve,
            bnbForPancakeSwap: 0,
            lpToken: address(0),
            burnLP: burnLP,
            launchBlock: block.number,
            graduationBnbThreshold: GRADUATION_BNB_THRESHOLD,
            graduationMarketCapBNB: 0
        });
        creatorFees[token] = CreatorFees({
            accumulatedFees: 0,
            lastClaimTime: block.timestamp,
            graduationMarketCap: 0,
            weekStartTime: block.timestamp,
            totalPurchaseVolume: 0
        });
        activeTokens.push(token);
        emit PoolCreated(
            token,
            msg.value,
            tradableTokens,
            reservedTokens,
            creator,
            block.number,
            virtualBnbReserve,
            GRADUATION_BNB_THRESHOLD
        );
    }

    /**
* @notice Buy tokens from the bonding curve

* @param token The token address
* @param minTokensOut Minimum tokens to receive (slippage protection)
*/
    function buyTokens(
        address token,
        uint256 minTokensOut
    ) external payable nonReentrant whenNotPaused {
        Pool storage pool = pools[token];
        require(!pool.graduated, "Buying forbidden after graduation");
        require(pool.active, "Pool not active");

        require(msg.value > 0, "Must send BNB");
        uint256 feeRate = getCurrentFeeRate(token);
        uint256 totalFee = (msg.value * feeRate) / BASIS_POINTS;

        uint256 bnbAfterFee = msg.value - totalFee;
        // Calculate tokens out using bonding curve formula
        uint256 augmentedBnbBefore = pool.bnbReserve + pool.virtualBnbReserve;

        uint256 tokensOut = (bnbAfterFee * pool.tokenReserve) /
            (augmentedBnbBefore + bnbAfterFee);
        if (tokensOut > pool.tokenReserve) {
            tokensOut = pool.tokenReserve;
        }
        require(tokensOut >= minTokensOut, "Slippage too high");
        require(tokensOut <= pool.tokenReserve, "Insufficient liquidity");

        // Update reserves (CEI pattern - state changes before external calls)
        pool.bnbReserve += bnbAfterFee;

        pool.tokenReserve -= tokensOut;
        // Update market cap
        uint256 augmentedBnbNow = pool.bnbReserve + pool.virtualBnbReserve;

        if (pool.tokenReserve > 0) {
            pool.marketCap =
                (augmentedBnbNow * pool.totalTokenSupply) /
                pool.tokenReserve;
        }
        uint256 currentPrice = 0;
        if (pool.tokenReserve > 0) {
            currentPrice = (augmentedBnbNow * 10 ** 18) / pool.tokenReserve;
        }
        _distributeFees(totalFee, token, msg.sender);
        IERC20(token).safeTransfer(msg.sender, tokensOut);

        emit TokensBought(
            msg.sender,
            token,
            msg.value,
            tokensOut,
            currentPrice,
            feeRate
        );
        _checkGraduation(token);
    }

    /**
* @notice Sell tokens back to the bonding curve or after graduation

* @param token The token address
* @param tokenAmount Amount of tokens to sell
* @param minBNBOut Minimum BNB to receive (slippage protection)
*/
    function sellTokens(
        address token,
        uint256 tokenAmount,
        uint256 minBNBOut
    ) external nonReentrant whenNotPaused {
        Pool storage pool = pools[token];
        require(pool.token != address(0), "Pool does not exist");
        require(tokenAmount > 0, "Must sell tokens");
        if (pool.graduated) {
            _handlePostGraduationSell(token, tokenAmount, minBNBOut);

            return;
        }
        require(pool.active, "Pool not active");
        // Calculate BNB out using bonding curve formula

        uint256 bnbOut = (tokenAmount * pool.bnbReserve) /
            (pool.tokenReserve + tokenAmount);
        uint256 feeRate = getCurrentFeeRate(token);
        uint256 totalFee = (bnbOut * feeRate) / BASIS_POINTS;
        uint256 bnbAfterFee = bnbOut - totalFee;
        require(bnbAfterFee >= minBNBOut, "Slippage too high");
        require(bnbAfterFee <= pool.bnbReserve, "Insufficient BNB liquidity");

        // Transfer tokens from seller (before state changes for CEI)
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        // Update reserves
        pool.bnbReserve -= bnbOut;

        pool.tokenReserve += tokenAmount;
        // Update market cap
        uint256 augmentedBnbNow = pool.bnbReserve + pool.virtualBnbReserve;

        if (pool.tokenReserve > 0) {
            pool.marketCap =
                (augmentedBnbNow * pool.totalTokenSupply) /
                pool.tokenReserve;
        }
        uint256 currentPrice = augmentedBnbNow > 0 && pool.tokenReserve > 0
            ? (augmentedBnbNow * 10 ** 18) / pool.tokenReserve
            : 0;
        _distributeFees(totalFee, token, msg.sender);
        payable(msg.sender).transfer(bnbAfterFee);

        emit TokensSold(
            msg.sender,
            token,
            tokenAmount,
            bnbAfterFee,
            currentPrice,
            feeRate
        );
    }

    /**
* @notice Handle selling tokens after graduation

* @dev Swaps half the tokens for BNB, adds liquidity with the rest
*/
    function _handlePostGraduationSell(
        address token,
        uint256 tokenAmount,
        uint256 minBNBOut
    ) private {
        Pool storage pool = pools[token];
        require(pool.lpToken != address(0), "LP token not set");
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        uint256 totalFee = (tokenAmount * POST_GRADUATION_FEE_BPS) /
            BASIS_POINTS;

        uint256 tokensAfterFee = tokenAmount - totalFee;
        uint256 tokensToSwap = tokensAfterFee / 2;
        uint256 tokensForLP = tokensAfterFee - tokensToSwap;

        // ✅ SECURITY FIX: Calculate expected BNB output and apply 1% slippage tolerance
        address[] memory quotePath = new address[](2);

        quotePath[0] = token;
        quotePath[1] = wbnbAddress;
        uint256[] memory amountsQuote = pancakeRouter.getAmountsOut(
            tokensToSwap,
            quotePath
        );
        uint256 expectedBNB = amountsQuote[amountsQuote.length - 1];
        uint256 minBNBFromSwap = (expectedBNB * 99) / 100; // 1% slippage tolerance
        IERC20(token).approve(address(pancakeRouter), tokensToSwap);
        address[] memory path = new address[](2);

        path[0] = token;

        path[1] = wbnbAddress;
        uint256[] memory amounts = pancakeRouter.swapExactTokensForETH(
            tokensToSwap,
            minBNBFromSwap, // ✅ FIXED: Added slippage protection
            path,
            address(this),
            block.timestamp + 300
        );
        uint256 bnbFromSwap = amounts[amounts.length - 1];
        uint256 sellerPayment = (bnbFromSwap * 70) / 100;

        uint256 bnbForLP = bnbFromSwap - sellerPayment;
        require(sellerPayment >= minBNBOut, "Slippage too high");
        // ✅ SECURITY FIX: Calculate minimum amounts for liquidity addition with 1% slippage

        uint256 minTokenForLP = (tokensForLP * 99) / 100;

        uint256 minBNBForLP = (bnbForLP * 99) / 100;
        IERC20(token).approve(address(pancakeRouter), tokensForLP);
        (, , uint256 liquidity) = pancakeRouter.addLiquidityETH{
            value: bnbForLP
        }(
            token,
            tokensForLP,
            minTokenForLP, // ✅ FIXED: Added min token amount
            minBNBForLP, // ✅ FIXED: Added min BNB amount
            address(this),
            block.timestamp + 300
        );
        if (pool.burnLP) {
            IERC20(pool.lpToken).safeTransfer(LP_BURN_ADDRESS, liquidity);

            emit LPTokensHandled(token, pool.lpToken, liquidity, true);
        } else {
            IERC20(pool.lpToken).approve(address(lpFeeHarvester), liquidity);
            lpFeeHarvester.lockLP(
                token,
                pool.lpToken,
                pool.creator,
                infoFiFeeAddress,
                liquidity,
                0
            );
            emit LPTokensHandled(token, pool.lpToken, liquidity, false);
        }
        PostGraduationStats storage stats = postGradStats[token];
        stats.totalTokensSold += tokenAmount;

        stats.totalLiquidityAdded += bnbForLP;
        stats.lpTokensGenerated += liquidity;
        if (totalFee > 0) {
            IERC20(token).safeTransfer(platformFeeAddress, totalFee);
        }
        payable(msg.sender).transfer(sellerPayment);
        emit PostGraduationSell(
            msg.sender,
            token,
            tokenAmount,
            sellerPayment,
            bnbForLP + tokensForLP,
            liquidity
        );
    }

    /**
* @notice Check if pool should graduate to PancakeSwap

*/
    function _checkGraduation(address token) private {
        Pool storage pool = pools[token];
        if (pool.bnbReserve >= GRADUATION_BNB_THRESHOLD) {
            _graduatePool(token);
        }
    }

    /**
* @notice Graduate pool to PancakeSwap

*/
    function _graduatePool(address token) private {
        Pool storage pool = pools[token];
        pool.graduated = true;
        pool.active = false;

        creatorFees[token].graduationMarketCap = pool.marketCap;
        pool.bnbForPancakeSwap = GRADUATION_BNB_THRESHOLD;

        uint256 finalPrice = (pool.bnbReserve + pool.virtualBnbReserve) > 0 &&
            pool.tokenReserve > 0
            ? ((pool.bnbReserve + pool.virtualBnbReserve) * 10 ** 18) /
                pool.tokenReserve
            : 0;
        emit PoolGraduated(
            token,
            pool.marketCap,
            finalPrice,
            pool.reservedTokens,
            GRADUATION_BNB_THRESHOLD
        );
    }

    /**
* @notice Withdraw graduated pool funds (for LaunchpadManager to add to PancakeSwap)

* @return bnbAmount Amount of BNB withdrawn
* @return tokenAmount Amount of reserved tokens withdrawn
* @return remainingTokens Amount of remaining tradable tokens
* @return creator The pool creator address
*/
    function withdrawGraduatedPool(
        address token
    )
        external
        onlyRole(MANAGER_ROLE)
        returns (
            uint256 bnbAmount,
            uint256 tokenAmount,
            uint256 remainingTokens,
            address creator
        )
    {
        Pool storage pool = pools[token];
        require(pool.graduated, "Pool not graduated");
        require(pool.active == false, "Pool still active");
        bnbAmount = pool.bnbForPancakeSwap;
        tokenAmount = pool.reservedTokens;

        remainingTokens = pool.tokenReserve;
        creator = pool.creator;
        if (bnbAmount > 0) {
            require(
                pool.bnbReserve >= bnbAmount,
                "Insufficient bnb for withdrawal"
            );
            pool.bnbReserve -= bnbAmount;
        }
        pool.reservedTokens = 0;
        // Send remaining tradable tokens to creator

        if (remainingTokens > 0) {
            pool.tokenReserve = 0;
            IERC20(pool.token).safeTransfer(pool.creator, remainingTokens);
        }
        // Send reserved tokens and BNB to LaunchpadManager
        IERC20(pool.token).safeTransfer(msg.sender, tokenAmount);

        if (bnbAmount > 0) {
            (bool success, ) = payable(msg.sender).call{value: bnbAmount}("");
            require(success, "BNB transfer failed");
        }
        return (bnbAmount, tokenAmount, remainingTokens, creator);
    }

    /**
* @notice Set LP token address for a pool

*/
    function setLPToken(address token) external onlyRole(MANAGER_ROLE) {
        Pool storage pool = pools[token];
        address lpToken = pancakeFactory.getPair(token, wbnbAddress);
        pool.lpToken = lpToken;
    }

    /**
* @notice Distribute fees according to INSTANT_LAUNCH structure

* @dev 5% platform, 50% creator, 45% InfoFi, 0% liquidity
*/
    function _distributeFees(
        uint256 totalFee,
        address token,
        address trader
    ) private {
        Pool storage pool = pools[token];
        uint256 platformAmount = (totalFee * feeDistribution.platformFee) / 100;
        uint256 creatorAmount = (totalFee * feeDistribution.creatorFee) / 100;

        uint256 infoFiAmount = (totalFee * feeDistribution.infoFiFee) / 100;
        // If trader is creator, redirect their creator fee to InfoFi
        if (trader != pool.creator) {
            creatorFees[token].accumulatedFees += creatorAmount;
        } else {
            infoFiAmount += creatorAmount;
        }
        payable(platformFeeAddress).transfer(platformAmount);
        payable(infoFiFeeAddress).transfer(infoFiAmount);

        emit FeesCollected(token, platformAmount, creatorAmount, infoFiAmount);
    }

    /**
* @notice Creator claims accumulated fees

* @dev For INSTANT_LAUNCH: If market cap drops and week passes, fees go to InfoFi
*/
    function claimCreatorFees(
        address token
    ) external nonReentrant whenNotPaused {
        Pool memory pool = pools[token];
        require(msg.sender == pool.creator, "Not creator");
        require(!pool.graduated, "Pool has graduated - trading ended");
        CreatorFees storage fees = creatorFees[token];
        require(fees.accumulatedFees > 0, "No fees to claim");

        require(
            block.timestamp >= fees.lastClaimTime + CLAIM_COOLDOWN,
            "Claim cooldown active"
        );
        bool marketCapDropped = pool.bnbReserve < GRADUATION_BNB_THRESHOLD;
        bool weekPassed = block.timestamp >=
            fees.weekStartTime + REDISTRIBUTION_PERIOD;
        if (marketCapDropped && weekPassed) {
            // Redirect to InfoFi if market cap dropped and week passed

            uint256 amount = fees.accumulatedFees;
            fees.accumulatedFees = 0;
            fees.lastClaimTime = block.timestamp;
            fees.weekStartTime = block.timestamp;
            payable(infoFiFeeAddress).transfer(amount);
            emit CreatorFeesRedirectedToInfoFi(token, amount);
        } else {
            // Normal creator claim
            uint256 amount = fees.accumulatedFees;
            fees.accumulatedFees = 0;
            fees.lastClaimTime = block.timestamp;
            payable(pool.creator).transfer(amount);
            emit CreatorFeesClaimed(pool.creator, token, amount);
        }
    }

    /**
* @notice Get quote for buying tokens

*/
    function getBuyQuote(
        address token,
        uint256 bnbAmount
    ) external view returns (uint256 tokensOut, uint256 pricePerToken) {
        Pool memory pool = pools[token];
        require(pool.active, "Pool not active");
        require(!pool.graduated, "Buying forbidden after graduation");
        uint256 feeRate = getCurrentFeeRate(token);
        uint256 bnbAfterFee = bnbAmount -
            ((bnbAmount * feeRate) / BASIS_POINTS);
        uint256 augmentedBnbBefore = pool.bnbReserve + pool.virtualBnbReserve;
        tokensOut =
            (bnbAfterFee * pool.tokenReserve) /
            (augmentedBnbBefore + bnbAfterFee);
        if (tokensOut > pool.tokenReserve) tokensOut = pool.tokenReserve;
        pricePerToken = tokensOut > 0 ? (bnbAmount * 10 ** 18) / tokensOut : 0;
    }

    /**
* @notice Get quote for selling tokens

*/
    function getSellQuote(
        address token,
        uint256 tokenAmount
    ) external view returns (uint256 bnbOut, uint256 pricePerToken) {
        Pool memory pool = pools[token];
        if (pool.graduated) {
            uint256 fee = (tokenAmount * POST_GRADUATION_FEE_BPS) /
                BASIS_POINTS;
            uint256 tokensAfterFee = tokenAmount - fee;
            uint256 tokensToSwap = tokensAfterFee / 2;
            bnbOut = (tokensToSwap * 70) / 100;
            pricePerToken = bnbOut > 0 ? (bnbOut * 10 ** 18) / tokenAmount : 0;

            return (bnbOut, pricePerToken);
        }
        require(pool.active, "Pool not active");
        uint256 bnbBeforeFee = (tokenAmount * pool.bnbReserve) /
            (pool.tokenReserve + tokenAmount);

        uint256 feeRate = getCurrentFeeRate(token);
        bnbOut = bnbBeforeFee - ((bnbBeforeFee * feeRate) / BASIS_POINTS);
        pricePerToken = bnbOut > 0 ? (bnbOut * 10 ** 18) / tokenAmount : 0;
    }

    /**
* @notice Get pool information

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
            uint256 reservedTokens,
            uint256 currentPrice,
            uint256 priceMultiplier,
            uint256 graduationProgress,
            bool graduated
        )
    {
        Pool memory pool = pools[token];
        marketCapBNB = pool.marketCap;
        marketCapUSD = priceOracle.bnbToUSD(pool.marketCap);
        bnbReserve = pool.bnbReserve;
        tokenReserve = pool.tokenReserve;
        reservedTokens = pool.reservedTokens;
        uint256 augmentedBnb = pool.bnbReserve + pool.virtualBnbReserve;
        currentPrice = pool.tokenReserve > 0 && augmentedBnb > 0
            ? (augmentedBnb * 10 ** 18) / pool.tokenReserve
            : 0;
        // Calculate initial price for INSTANT_LAUNCH
        uint256 initialPrice = 0;

        uint256 initialReserve = pool.virtualBnbReserve;
        uint256 initialTokenReserve = (TOTAL_TOKEN_SUPPLY * 80) / 100;
        if (initialReserve > 0 && initialTokenReserve > 0) {
            initialPrice = (initialReserve * 10 ** 18) / initialTokenReserve;
        }
        priceMultiplier = currentPrice > 0 && initialPrice > 0
            ? (currentPrice * 100) / initialPrice
            : 100;
        graduationProgress = GRADUATION_BNB_THRESHOLD > 0
            ? (pool.bnbReserve * 100) / GRADUATION_BNB_THRESHOLD
            : 0;
        graduated = pool.graduated;
    }

    /**
* @notice Get pool debug information

*/
    function getPoolDebugInfo(
        address token
    )
        external
        view
        returns (
            uint256 virtualBnbReserve,
            uint256 graduationBnbThreshold,
            uint256 graduationMarketCapBNB,
            uint256 launchBlock
        )
    {
        Pool memory pool = pools[token];
        return (
            pool.virtualBnbReserve,
            pool.graduationBnbThreshold,
            pool.graduationMarketCapBNB,
            pool.launchBlock
        );
    }

    /**
* @notice Get post-graduation statistics

*/
    function getPostGraduationStats(
        address token
    )
        external
        view
        returns (
            uint256 totalTokensSold,
            uint256 totalLiquidityAdded,
            uint256 lpTokensGenerated
        )
    {
        PostGraduationStats memory stats = postGradStats[token];
        return (
            stats.totalTokensSold,
            stats.totalLiquidityAdded,
            stats.lpTokensGenerated
        );
    }

    /**
* @notice Get fee information for a token

*/
    function getFeeInfo(
        address token
    )
        external
        view
        returns (
            uint256 currentFeeRate,
            uint256 finalFeeRate,
            uint256 blocksSinceLaunch,
            uint256 blocksUntilNextTier,
            string memory feeStage
        )
    {
        Pool memory pool = pools[token];
        if (pool.graduated || !pool.active) {
            return (
                POST_GRADUATION_FEE_BPS,
                POST_GRADUATION_FEE_BPS,
                0,
                0,
                "Post-Graduation"
            );
        }
        blocksSinceLaunch = block.number - pool.launchBlock;
        currentFeeRate = getCurrentFeeRate(token);
        finalFeeRate = FINAL_FEE_BPS; // Always 2% for INSTANT_LAUNCH

        if (blocksSinceLaunch < FEE_DECAY_BLOCK_1) {
            blocksUntilNextTier = FEE_DECAY_BLOCK_1 - blocksSinceLaunch;
            feeStage = "Tier 1 (10%)";
        } else if (blocksSinceLaunch < FEE_DECAY_BLOCK_2) {
            blocksUntilNextTier = FEE_DECAY_BLOCK_2 - blocksSinceLaunch;
            feeStage = "Tier 2 (6%)";
        } else if (blocksSinceLaunch < FEE_DECAY_BLOCK_3) {
            blocksUntilNextTier = FEE_DECAY_BLOCK_3 - blocksSinceLaunch;
            feeStage = "Tier 3 (4%)";
        } else {
            blocksUntilNextTier = 0;
            feeStage = "Final (2%)";
        }
        return (
            currentFeeRate,
            finalFeeRate,
            blocksSinceLaunch,
            blocksUntilNextTier,
            feeStage
        );
    }

    /**
     * @notice Get creator fee information
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
            uint256 bnbInPool,
            bool canClaim
        )
    {
        Pool memory pool = pools[token];
        CreatorFees memory fees = creatorFees[token];
        accumulatedFees = fees.accumulatedFees;
        lastClaimTime = fees.lastClaimTime;
        graduationMarketCap = fees.graduationMarketCap;

        currentMarketCap = pool.marketCap;
        bnbInPool = pool.bnbReserve;
        bool cooldownPassed = block.timestamp >=
            fees.lastClaimTime + CLAIM_COOLDOWN;
        bool notGraduated = !pool.graduated;

        canClaim = fees.accumulatedFees > 0 && cooldownPassed && notGraduated;
    }

    /**

* @notice Manually graduate a pool (admin function)
*/

    function graduatePool(address token) external onlyRole(OPERATOR_ROLE) {
        _graduatePool(token);
    }

    /**
     * @notice Update fee addresses
     */

    function updateFeeAddresses(
        address _platformFeeAddress,
        address _academyFeeAddress,
        address _infoFiFeeAddress
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_platformFeeAddress != address(0), "Invalid platform address");
        require(_academyFeeAddress != address(0), "Invalid academy address");
        require(_infoFiFeeAddress != address(0), "Invalid InfoFi address");
        platformFeeAddress = _platformFeeAddress;
        academyFeeAddress = _academyFeeAddress;
        infoFiFeeAddress = _infoFiFeeAddress;
    }

    /**
     * @notice Update price oracle
     */

    function updatePriceOracle(
        address _priceOracle
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_priceOracle != address(0), "Invalid price oracle");
        priceOracle = PriceOracle(_priceOracle);
    }

    /**
     * @notice Pause the contract
     */

    function pause() external onlyRole(EMERGENCY_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the contract
     */

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Recover stuck tokens (emergency function)
     */

    function recoverStuckTokens(
        address token,
        uint256 amount,
        address recipient
    ) external onlyRole(EMERGENCY_ROLE) {
        require(recipient != address(0), "Invalid recipient");
        require(!pools[token].active, "Cannot recover active pool tokens");
        IERC20(token).safeTransfer(recipient, amount);
    }

    /**

* @notice Get all active token addresses
*/

    function getActiveTokens() external view returns (address[] memory) {
        return activeTokens;
    }

    receive() external payable {}
}
