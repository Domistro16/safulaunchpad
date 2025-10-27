// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LPFeeHarvester
 * @author SafuPad Team (patched)
 * @notice LP token locker with fee-harvesting (WBNB pairs only)
 *
 * Key fixes:
 * - store initial pair reserves and totalSupply on lock
 * - compute fee-only amounts attributable to locked LP (estimate)
 * - remove minimal LP required to extract those fees
 * - checks-effects-interactions ordering
 * - safe approvals, use call() for BNB transfers (pull preferable but kept push for parity)
 * - validate pair belongs to project <> WBNB via factory
 *
 * Limitations:
 * - still supports only pairs where one side is WBNB (same as original)
 * - estimates rely on PancakeRouter.getAmountsOut for pricing; tests needed
 */

interface IPancakePair {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    function totalSupply() external view returns (uint256);

    function balanceOf(address owner) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);

    function approve(address spender, uint256 value) external returns (bool);
}

interface IPancakeRouter02 {
    function removeLiquidityETH(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external returns (uint amountToken, uint amountETH);

    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(
        uint amountIn,
        address[] calldata path
    ) external view returns (uint[] memory amounts);

    function WETH() external pure returns (address);
}

interface IPancakeFactory {
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address pair);
}

contract LPFeeHarvester is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Role definitions
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    /// @notice Fee distribution percentages (basis points out of 10000)
    uint256 public constant CREATOR_FEE_BPS = 7000; // 70%
    uint256 public constant PROJECT_INFOFI_BPS = 0; // 0%
    uint256 public constant PLATFORM_FEE_BPS = 3000; // 10%
    uint256 public constant BASIS_POINTS = 10000;

    /// @notice Lock duration constraints
    uint256 public constant DEFAULT_LOCK_DURATION = 365 days;
    uint256 public constant MIN_LOCK_DURATION = 90 days;
    uint256 public constant MAX_LOCK_DURATION = 1460 days;

    /// @notice Harvest constraints
    uint256 public constant HARVEST_COOLDOWN = 24 hours;
    uint256 public constant MIN_HARVEST_AMOUNT = 0.01 ether; // Minimum BNB to harvest
    uint256 public constant HARVEST_LP_PERCENT = 5; // 5 basis points = 0.1% (fallback cap)

    struct LPLock {
        address lpToken;
        address projectToken;
        address creator;
        address projectInfoFi;
        uint256 lpAmount; // current locked LP in contract
        uint256 initialLPAmount; // initial locked LP (for computing locked share)
        uint256 lockTime;
        uint256 unlockTime;
        bool active;
        uint256 totalFeesHarvestedBNB;
        uint256 lastHarvestTime;
        // store raw reserves and totalSupply at lock time for fee-only calculation
        uint256 initialReserve0;
        uint256 initialReserve1;
        uint256 initialTotalSupply;
        uint256 harvestCount;
    }

    struct HarvestStats {
        uint256 bnbAmount;
        uint256 token0Amount;
        uint256 token1Amount;
        uint256 timestamp;
        uint256 lpBurned;
    }

    IPancakeRouter02 public pancakeRouter;
    IPancakeFactory public pancakeFactory;
    address public platformFeeAddress;
    address public wbnbAddress;

    mapping(address => LPLock) public lpLocks;
    mapping(address => HarvestStats[]) public harvestHistory;
    address[] public allLockedProjects;

    uint256 public totalValueLocked;
    uint256 public totalFeesDistributed;
    uint256 public totalHarvests;

    event LPLocked(
        address indexed projectToken,
        address indexed lpToken,
        address indexed creator,
        uint256 lpAmount,
        uint256 unlockTime,
        uint256 initialValue
    );

    event FeesHarvested(
        address indexed projectToken,
        uint256 bnbAmount,
        uint256 token0Amount,
        uint256 token1Amount,
        uint256 lpBurned,
        uint256 harvestNumber
    );

    event FeesDistributed(
        address indexed projectToken,
        address indexed creator,
        uint256 creatorAmount,
        uint256 projectInfoFiAmount,
        uint256 platformAmount
    );

    event LPUnlocked(
        address indexed projectToken,
        address indexed recipient,
        uint256 lpAmount,
        uint256 totalFeesEarned
    );

    event EmergencyUnlock(
        address indexed projectToken,
        address indexed recipient,
        uint256 lpAmount,
        string reason
    );

    event LockExtended(
        address indexed projectToken,
        uint256 oldUnlockTime,
        uint256 newUnlockTime
    );

    constructor(
        address _pancakeRouter,
        address _pancakeFactory,
        address _platformFeeAddress,
        address _admin
    ) {
        require(_pancakeRouter != address(0), "Invalid router");
        require(_pancakeFactory != address(0), "Invalid factory");
        require(_platformFeeAddress != address(0), "Invalid platform address");
        require(_admin != address(0), "Invalid admin");

        pancakeRouter = IPancakeRouter02(_pancakeRouter);
        pancakeFactory = IPancakeFactory(_pancakeFactory);
        platformFeeAddress = _platformFeeAddress;
        wbnbAddress = pancakeRouter.WETH();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
        _grantRole(HARVESTER_ROLE, _admin);
        _grantRole(EMERGENCY_ROLE, _admin);
    }

    /**
     * @notice Lock LP tokens for a project
     */
    function lockLP(
        address projectToken,
        address lpToken,
        address creator,
        address projectInfoFi,
        uint256 lpAmount,
        uint256 lockDuration
    ) external onlyRole(MANAGER_ROLE) whenNotPaused nonReentrant {
        require(projectToken != address(0), "Invalid project token");
        require(lpToken != address(0), "Invalid LP token");
        require(creator != address(0), "Invalid creator");
        require(projectInfoFi != address(0), "Invalid InfoFi wallet");
        require(lpAmount > 0, "LP amount must be > 0");
        require(!lpLocks[projectToken].active, "LP already locked");

        if (lockDuration == 0) {
            lockDuration = DEFAULT_LOCK_DURATION;
        }
        require(
            lockDuration >= MIN_LOCK_DURATION &&
                lockDuration <= MAX_LOCK_DURATION,
            "Invalid lock duration"
        );

        // Validate pair is projectToken <> WBNB
        address expectedPair = pancakeFactory.getPair(
            projectToken,
            wbnbAddress
        );
        require(
            expectedPair == lpToken,
            "LP token mismatch (expected project<>WBNB pair)"
        );

        // Transfer LP tokens from sender to this contract
        IERC20(lpToken).transferFrom(msg.sender, address(this), lpAmount);

        // Snapshot reserves & totalSupply for later fee-only calculations
        IPancakePair pair = IPancakePair(lpToken);
        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();

        uint256 totalSupply = pair.totalSupply();
        // Calculate initial value in BNB (estimate)
        uint256 initialValue = _estimateLPValueInBNB(lpToken, lpAmount);

        uint256 unlockTime = block.timestamp + lockDuration;
        lpLocks[projectToken] = LPLock({
            lpToken: lpToken,
            projectToken: projectToken,
            creator: creator,
            projectInfoFi: projectInfoFi,
            lpAmount: lpAmount,
            initialLPAmount: lpAmount,
            lockTime: block.timestamp,
            unlockTime: unlockTime,
            active: true,
            totalFeesHarvestedBNB: 0,
            lastHarvestTime: block.timestamp,
            initialReserve0: uint256(reserve0),
            initialReserve1: uint256(reserve1),
            initialTotalSupply: totalSupply,
            harvestCount: 0
        });

        allLockedProjects.push(projectToken);
        totalValueLocked += initialValue;

        emit LPLocked(
            projectToken,
            lpToken,
            creator,
            lpAmount,
            unlockTime,
            initialValue
        );
    }

    /**
     * @notice Harvest accumulated fees from LP position
     * @dev Anyone can call this after cooldown period
     */
    function harvestFees(
        address projectToken
    ) external whenNotPaused nonReentrant {
        LPLock storage lock = lpLocks[projectToken];
        require(lock.active, "No active lock");
        require(lock.lpAmount > 0, "No LP to harvest");
        require(
            block.timestamp >= lock.lastHarvestTime + HARVEST_COOLDOWN,
            "Harvest cooldown active"
        );

        IPancakePair pair = IPancakePair(lock.lpToken);
        address token0 = pair.token0();
        address token1 = pair.token1();

        require(
            token0 == wbnbAddress || token1 == wbnbAddress,
            "Only WBNB pairs supported"
        );

        // Current pool state
        (uint112 curRes0_u, uint112 curRes1_u, ) = pair.getReserves();

        uint256 curRes0 = uint256(curRes0_u);
        uint256 curRes1 = uint256(curRes1_u);
        uint256 curTotalSupply = pair.totalSupply();
        require(curTotalSupply > 0, "Pair totalSupply is zero");

        // Compute expected reserves for the pool if no fees accrued
        uint256 expectedRes0 = (lock.initialReserve0 * curTotalSupply) /
            (lock.initialTotalSupply == 0 ? 1 : lock.initialTotalSupply);
        uint256 expectedRes1 = (lock.initialReserve1 * curTotalSupply) /
            (lock.initialTotalSupply == 0 ? 1 : lock.initialTotalSupply);

        // Fees for entire pool since lock time
        uint256 feesPool0 = curRes0 > expectedRes0 ? curRes0 - expectedRes0 : 0;
        uint256 feesPool1 = curRes1 > expectedRes1 ? curRes1 - expectedRes1 : 0;

        // Locked share of pool fees
        uint256 myFee0 = 0;
        uint256 myFee1 = 0;
        if (feesPool0 > 0) {
            myFee0 = (feesPool0 * lock.initialLPAmount) / curTotalSupply;
        }
        if (feesPool1 > 0) {
            myFee1 = (feesPool1 * lock.initialLPAmount) / curTotalSupply;
        }

        // Estimate BNB value of these fee tokens
        uint256 bnbFrom0 = 0;
        uint256 bnbFrom1 = 0;

        bool token0IsWBNB = token0 == wbnbAddress;
        bool token1IsWBNB = token1 == wbnbAddress;

        if (token0IsWBNB) {
            bnbFrom0 = myFee0;
        } else if (myFee0 > 0) {
            address[] memory path0 = new address[](2);
            path0[0] = token0;
            path0[1] = wbnbAddress;
            uint[] memory out0 = pancakeRouter.getAmountsOut(myFee0, path0);
            bnbFrom0 = out0[out0.length - 1];
        }

        if (token1IsWBNB) {
            bnbFrom1 = myFee1;
        } else if (myFee1 > 0) {
            address[] memory path1 = new address[](2);
            path1[0] = token1;
            path1[1] = wbnbAddress;
            uint[] memory out1 = pancakeRouter.getAmountsOut(myFee1, path1);
            bnbFrom1 = out1[out1.length - 1];
        }

        uint256 estimatedFeeBNB = bnbFrom0 + bnbFrom1;

        require(
            estimatedFeeBNB >= MIN_HARVEST_AMOUNT,
            "Harvest amount too small"
        );

        // Estimate total pool value in BNB
        uint256 poolValueBNB = 0;
        if (token0IsWBNB) {
            uint256 reserveWBNB = curRes0;
            uint256 tokenReservePriceBNB = 0;
            if (curRes1 > 0) {
                address[] memory path = new address[](2);
                path[0] = token1;
                path[1] = wbnbAddress;
                uint[] memory out = pancakeRouter.getAmountsOut(curRes1, path);
                tokenReservePriceBNB = out[out.length - 1];
            }
            poolValueBNB = reserveWBNB + tokenReservePriceBNB;
        } else {
            uint256 reserveWBNB = curRes1;
            uint256 tokenReservePriceBNB = 0;
            if (curRes0 > 0) {
                address[] memory path = new address[](2);
                path[0] = token0;
                path[1] = wbnbAddress;
                uint[] memory out = pancakeRouter.getAmountsOut(curRes0, path);
                tokenReservePriceBNB = out[out.length - 1];
            }
            poolValueBNB = reserveWBNB + tokenReservePriceBNB;
        }
        require(poolValueBNB > 0, "Pool value is zero");

        // Calculate LP to remove
        uint256 numerator = estimatedFeeBNB * curTotalSupply;
        uint256 lpToRemove = numerator / poolValueBNB;
        if (lpToRemove == 0) {
            lpToRemove = 1;
        }

        // Cap to current locked LP
        if (lpToRemove > lock.lpAmount) {
            lpToRemove = lock.lpAmount;
        }

        // ✅ FIX #3: Add safety cap - max 5% of locked LP per harvest
        uint256 maxLPToRemove = (lock.lpAmount * 500) / BASIS_POINTS; // 5% max
        if (lpToRemove > maxLPToRemove) {
            lpToRemove = maxLPToRemove;
        }

        // Approve router to spend LP tokens
        IERC20(lock.lpToken).approve(address(pancakeRouter), 0);
        IERC20(lock.lpToken).approve(address(pancakeRouter), lpToRemove);

        // Update state before external calls
        lock.lpAmount = lock.lpAmount - lpToRemove;
        lock.totalFeesHarvestedBNB += estimatedFeeBNB;
        lock.lastHarvestTime = block.timestamp;
        lock.harvestCount += 1;
        totalHarvests += 1;
        totalFeesDistributed += estimatedFeeBNB;

        uint256 removedLPValueBNB = (poolValueBNB * lpToRemove) /
            curTotalSupply;
        if (removedLPValueBNB > totalValueLocked) {
            totalValueLocked = 0;
        } else {
            totalValueLocked -= removedLPValueBNB;
        }

        // Remove liquidity
        (uint256 tokenAmountOut, uint256 bnbAmountOut) = pancakeRouter
            .removeLiquidityETH(
                token0IsWBNB ? token1 : token0,
                lpToRemove,
                0,
                0,
                address(this),
                block.timestamp + 300
            );

        // Convert non-WBNB token to BNB
        uint256 bnbFromSwappedToken = 0;
        address nonWBNB = token0IsWBNB ? token1 : token0;

        if (tokenAmountOut > 0) {

            IERC20(nonWBNB).approve(address(pancakeRouter), 0);
            IERC20(nonWBNB).approve(address(pancakeRouter), tokenAmountOut);

            address[] memory swapPath = new address[](2);
            swapPath[0] = nonWBNB;
            swapPath[1] = wbnbAddress;

            uint256[] memory swapOut = pancakeRouter.swapExactTokensForETH(
                tokenAmountOut,
                0,
                swapPath,
                address(this),
                block.timestamp + 300
            );
            bnbFromSwappedToken = swapOut[swapOut.length - 1];
        }

        uint256 totalBNBReceived = bnbAmountOut + bnbFromSwappedToken;

        require(
            totalBNBReceived >= MIN_HARVEST_AMOUNT,
            "Received too little BNB"
        );

        // Record harvest history
        harvestHistory[projectToken].push(
            HarvestStats({
                bnbAmount: totalBNBReceived,
                token0Amount: token0IsWBNB ? bnbAmountOut : tokenAmountOut,
                token1Amount: token0IsWBNB ? tokenAmountOut : bnbAmountOut,
                timestamp: block.timestamp,
                lpBurned: lpToRemove
            })
        );

        emit FeesHarvested(
            projectToken,
            totalBNBReceived,
            token0IsWBNB ? bnbAmountOut : tokenAmountOut,
            token0IsWBNB ? tokenAmountOut : bnbAmountOut,
            lpToRemove,
            lock.harvestCount
        );

        _distributeFees(projectToken, totalBNBReceived);
    }

    /**
     * @notice Distribute fees according to 70/20/10 split
     */
    function _distributeFees(address projectToken, uint256 totalBNB) private {
        LPLock storage lock = lpLocks[projectToken];
        require(lock.active || lock.initialLPAmount > 0, "Lock not active");
        require(totalBNB > 0, "No fees to distribute");

        uint256 creatorAmount = (totalBNB * CREATOR_FEE_BPS) / BASIS_POINTS;
        uint256 projectInfoFiAmount = (totalBNB * PROJECT_INFOFI_BPS) /
            BASIS_POINTS;
        uint256 platformAmount = (totalBNB * PLATFORM_FEE_BPS) / BASIS_POINTS;

        // Handle rounding remainder
        uint256 distributed = creatorAmount +
            projectInfoFiAmount +
            platformAmount;
        if (distributed < totalBNB) {
            creatorAmount += (totalBNB - distributed);
        }

        // Use call to transfer BNB and bubble revert if fails
        (bool ok1, ) = payable(lock.creator).call{value: creatorAmount}("");
        require(ok1, "creator transfer failed");
        (bool ok2, ) = payable(lock.projectInfoFi).call{
            value: projectInfoFiAmount
        }("");
        require(ok2, "projectInfoFi transfer failed");
        (bool ok3, ) = payable(platformFeeAddress).call{value: platformAmount}(
            ""
        );
        require(ok3, "platform transfer failed");

        emit FeesDistributed(
            projectToken,
            lock.creator,
            creatorAmount,
            projectInfoFiAmount,
            platformAmount
        );
    }

    /**
     * @notice Unlock LP tokens after lock period expires
     */
    function unlockLP(address projectToken) external nonReentrant {
        LPLock storage lock = lpLocks[projectToken];
        require(lock.active, "Lock not active");
        require(block.timestamp >= lock.unlockTime, "Lock period not expired");

        uint256 lpAmount = lock.lpAmount;
        address recipient = lock.creator;
        address lpToken = lock.lpToken;
        uint256 totalFees = lock.totalFeesHarvestedBNB;

        // Deactivate lock
        lock.active = false;
        lock.lpAmount = 0;

        // Transfer remaining LP tokens to creator
        if (lpAmount > 0) {
            IERC20(lpToken).safeTransfer(recipient, lpAmount);
        }

        // Update totalValueLocked conservatively (we can't perfectly know value now)
        // We will set to 0 if unlock reduces it below zero
        // For a safer accounting, front-end should recalc platform stats

        emit LPUnlocked(projectToken, recipient, lpAmount, totalFees);
    }

    /**
     * @notice Emergency unlock by admin
     */
    function emergencyUnlock(
        address projectToken,
        address recipient,
        string calldata reason
    ) external onlyRole(EMERGENCY_ROLE) nonReentrant {
        LPLock storage lock = lpLocks[projectToken];
        require(lock.active, "Lock not active");
        require(recipient != address(0), "Invalid recipient");

        uint256 lpAmount = lock.lpAmount;
        address lpToken = lock.lpToken;

        // Deactivate lock
        lock.active = false;
        lock.lpAmount = 0;

        if (lpAmount > 0) {
            IERC20(lpToken).safeTransfer(recipient, lpAmount);
        }

        emit EmergencyUnlock(projectToken, recipient, lpAmount, reason);
    }

    /**
     * @notice Extend lock period for a project
     */
    function extendLock(
        address projectToken,
        uint256 additionalDuration
    ) external nonReentrant {
        LPLock storage lock = lpLocks[projectToken];
        require(lock.active, "Lock not active");
        require(msg.sender == lock.creator, "Only creator can extend");
        require(additionalDuration > 0, "Duration must be > 0");

        uint256 oldUnlockTime = lock.unlockTime;
        uint256 newUnlockTime = oldUnlockTime + additionalDuration;

        require(
            newUnlockTime - lock.lockTime <= MAX_LOCK_DURATION,
            "Exceeds max lock duration"
        );

        lock.unlockTime = newUnlockTime;
        emit LockExtended(projectToken, oldUnlockTime, newUnlockTime);
    }

    /**
     * @notice Estimate LP value in BNB of a given lpAmount
     */
    function _estimateLPValueInBNB(
        address lpToken,
        uint256 lpAmount
    ) private view returns (uint256) {
        IPancakePair pair = IPancakePair(lpToken);
        address token0 = pair.token0();
        address token1 = pair.token1();

        (uint112 reserve0_u, uint112 reserve1_u, ) = pair.getReserves();

        uint256 reserve0 = uint256(reserve0_u);
        uint256 reserve1 = uint256(reserve1_u);
        uint256 totalSupply = pair.totalSupply();
        if (totalSupply == 0 || lpAmount == 0) return 0;

        // Determine which side is WBNB and price the other side to WBNB
        uint256 poolValueBNB = 0;
        if (token0 == wbnbAddress) {
            // reserve0 is WBNB, reserve1 priced to WBNB
            uint256 token1PriceInBNB = 0;
            if (reserve1 > 0) {
                address[] memory path = new address[](2);
                path[0] = token1;
                path[1] = wbnbAddress;
                uint[] memory out = pancakeRouter.getAmountsOut(reserve1, path);

                token1PriceInBNB = out[out.length - 1];
            }
            poolValueBNB = reserve0 + token1PriceInBNB;
        } else if (token1 == wbnbAddress) {
            uint256 token0PriceInBNB = 0;
            if (reserve0 > 0) {
                address[] memory path = new address[](2);
                path[0] = token0;
                path[1] = wbnbAddress;
                uint[] memory out = pancakeRouter.getAmountsOut(reserve0, path);
                token0PriceInBNB = out[out.length - 1];
            }
            poolValueBNB = reserve1 + token0PriceInBNB;
        } else {
            // can't price non-WBNB pairs in this contract
            return 0;
        }

        // LP share value = poolValueBNB * lpAmount / totalSupply
        return (poolValueBNB * lpAmount) / totalSupply;
    }

    // VIEW FUNCTIONS

    function getLockInfo(
        address projectToken
    )
        external
        view
        returns (
            address lpToken,
            address creator,
            address projectInfoFi,
            uint256 lpAmount,
            uint256 initialLPAmount,
            uint256 lockTime,
            uint256 unlockTime,
            bool active,
            uint256 totalFeesHarvested,
            uint256 harvestCount,
            uint256 timeUntilUnlock,
            uint256 estimatedValue,
            uint256 lastHarvestTime
        )
    {
        LPLock memory lock = lpLocks[projectToken];
        uint256 timeLeft = lock.unlockTime > block.timestamp
            ? lock.unlockTime - block.timestamp
            : 0;
        uint256 value = lock.active
            ? _estimateLPValueInBNB(lock.lpToken, lock.lpAmount)
            : 0;

        return (
            lock.lpToken,
            lock.creator,
            lock.projectInfoFi,
            lock.lpAmount,
            lock.initialLPAmount,
            lock.lockTime,
            lock.unlockTime,
            lock.active,
            lock.totalFeesHarvestedBNB,
            lock.harvestCount,
            timeLeft,
            value,
            lock.lastHarvestTime
        );
    }

    function getLPValue(
        address projectToken
    )
        external
        view
        returns (
            uint256 token0Amount,
            uint256 token1Amount,
            address token0,
            address token1
        )
    {
        LPLock memory lock = lpLocks[projectToken];
        require(lock.active, "Lock not active");

        IPancakePair pair = IPancakePair(lock.lpToken);
        token0 = pair.token0();
        token1 = pair.token1();

        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
        uint256 totalSupply = pair.totalSupply();

        token0Amount = (uint256(reserve0) * lock.lpAmount) / totalSupply;
        token1Amount = (uint256(reserve1) * lock.lpAmount) / totalSupply;
    }

    function getHarvestHistory(
        address projectToken
    ) external view returns (HarvestStats[] memory) {
        return harvestHistory[projectToken];
    }

    function getAllLockedProjects() external view returns (address[] memory) {
        return allLockedProjects;
    }

    function getActiveLocksCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < allLockedProjects.length; i++) {
            if (lpLocks[allLockedProjects[i]].active) {
                count++;
            }
        }
    }

    function canHarvest(
        address projectToken
    ) external view returns (bool ready, uint256 timeRemaining) {
        LPLock memory lock = lpLocks[projectToken];
        if (!lock.active) return (false, 0);

        uint256 nextHarvestTime = lock.lastHarvestTime + HARVEST_COOLDOWN;
        if (block.timestamp >= nextHarvestTime) {
            return (true, 0);
        } else {
            return (false, nextHarvestTime - block.timestamp);
        }
    }

    function getPlatformStats()
        external
        view
        returns (
            uint256 _totalValueLocked,
            uint256 _totalFeesDistributed,
            uint256 _totalHarvests,
            uint256 _activeLocksCount
        )
    {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < allLockedProjects.length; i++) {
            if (lpLocks[allLockedProjects[i]].active) {
                activeCount++;
            }
        }

        return (
            totalValueLocked,
            totalFeesDistributed,
            totalHarvests,
            activeCount
        );
    }

    // ADMIN FUNCTIONS

    function updatePlatformFeeAddress(
        address _platformFeeAddress
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_platformFeeAddress != address(0), "Invalid address");
        platformFeeAddress = _platformFeeAddress;
    }

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function recoverStuckTokens(
        address token,
        uint256 amount
    ) external onlyRole(EMERGENCY_ROLE) {
        // Ensure we're not taking locked LP tokens
        for (uint256 i = 0; i < allLockedProjects.length; i++) {
            address project = allLockedProjects[i];
            if (lpLocks[project].active) {
                require(
                    token != lpLocks[project].lpToken,
                    "Cannot withdraw locked LP"
                );
            }
        }

        IERC20(token).safeTransfer(msg.sender, amount);
    }

    receive() external payable {}

    function version() external pure returns (string memory) {
        return "1.0.0-patched";
    }
}
