// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMockPancakeFactory {
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address);

    function createPair(
        address tokenA,
        address tokenB
    ) external returns (address);
}

interface IMockPancakePair {
    function mint(address to, uint256 amount) external;

    function getReserves()
        external
        view
        returns (
            uint112 _reserve0,
            uint112 _reserve1,
            uint32 _blockTimestampLast
        );
}

contract MockPancakeRouter {
    address public immutable WETH;
    address public factory;

    // ✅ Store created pairs for easy lookup
    mapping(address => mapping(address => address)) public pairFor;

    constructor() {
        WETH = address(0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd); // Mock WBNB
    }

    function setFactory(address _factory) external {
        factory = _factory;
    }

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
        returns (uint amountToken, uint amountETH, uint liquidity)
    {
        require(factory != address(0), "Factory not set");

        // Transfer tokens from sender
        IERC20(token).transferFrom(
            msg.sender,
            address(this),
            amountTokenDesired
        );

        // Get or create pair
        address pair = IMockPancakeFactory(factory).getPair(token, WETH);
        if (pair == address(0)) {
            pair = IMockPancakeFactory(factory).createPair(token, WETH);
        }

        // ✅ Store for easy lookup
        pairFor[token][WETH] = pair;
        pairFor[WETH][token] = pair;

        // Calculate liquidity (simplified)
        liquidity = amountTokenDesired + msg.value;

        // Mint LP tokens to recipient
        IMockPancakePair(pair).mint(to, liquidity);

        return (amountTokenDesired, msg.value, liquidity);
    }

    // Add this to MockPancakeRouter
    function removeLiquidityETH(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external returns (uint amountToken, uint amountETH) {
        address pair = IMockPancakeFactory(factory).getPair(token, WETH);
        require(pair != address(0), "Pair not found");

        // Transfer LP tokens from sender to router
        IERC20(pair).transferFrom(msg.sender, address(this), liquidity);

        // Calculate ETH amount (simplified - liquidity represents value in Wei)
        amountETH = liquidity / 2; // Half the liquidity as ETH
        amountToken = liquidity / 2; // Other half (but we won't transfer)

        // ✅ ONLY send ETH back, DON'T transfer project tokens
        // (The harvester only needs ETH for fee distribution anyway)
        if (amountETH > 0) {
            (bool success, ) = payable(to).call{value: amountETH}("");
            require(success, "ETH transfer to harvester failed");
        }

        // Note: We don't transfer project tokens because:
        // 1. Router doesn't hold them (pair does in real Pancake)
        // 2. Harvester only needs ETH
        // 3. Simplifies testing

        return (amountToken, amountETH);
    }

    // Fund the router with ETH for testing
    receive() external payable {}

    // ✅ SIMPLIFIED - Just send ETH, don't transfer tokens
    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(path[path.length - 1] == WETH, "Path must end with WETH");

        // Calculate output (simplified 1:1 for testing)
        uint amountOut = amountIn;

        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountOut;

        // Fill intermediate amounts
        for (uint i = 1; i < path.length - 1; i++) {
            amounts[i] = amountIn;
        }

        require(amountOut >= amountOutMin, "Insufficient output amount");

        // ✅ Just send ETH - don't try to transfer tokens in mock
        if (address(this).balance >= amountOut) {
            (bool success, ) = to.call{value: amountOut}("");
            require(success, "ETH transfer failed");
        }

        return amounts;
    }

    // ✅ Add helper function to get pair
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address) {
        address pair = pairFor[tokenA][tokenB];
        if (pair == address(0)) {
            pair = pairFor[tokenB][tokenA];
        }
        return pair;
    }

    function getAmountsOut(
        uint amountIn,
        address[] calldata path
    ) external view returns (uint[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        amounts = new uint[](path.length);
        amounts[0] = amountIn;

        // Simple mock: For token -> WBNB, assume 1:1 ratio for testing
        // In production, this would calculate based on reserves
        for (uint i = 0; i < path.length - 1; i++) {
            address pair = IMockPancakeFactory(factory).getPair(
                path[i],
                path[i + 1]
            );

            if (pair != address(0)) {
                // Try to get reserves and calculate proper price
                try IMockPancakePair(pair).getReserves() returns (
                    uint112 reserve0,
                    uint112 reserve1,
                    uint32
                ) {
                    address token0 = path[i] < path[i + 1]
                        ? path[i]
                        : path[i + 1];
                    bool isToken0 = path[i] == token0;

                    uint reserveIn = isToken0 ? uint(reserve0) : uint(reserve1);
                    uint reserveOut = isToken0
                        ? uint(reserve1)
                        : uint(reserve0);

                    if (reserveIn > 0 && reserveOut > 0) {
                        // Use constant product formula: amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
                        // Simplified without fees for testing
                        amounts[i + 1] =
                            (amounts[i] * reserveOut) /
                            (reserveIn + amounts[i]);
                    } else {
                        // Fallback: 1:1 ratio
                        amounts[i + 1] = amounts[i];
                    }
                } catch {
                    // Fallback: 1:1 ratio
                    amounts[i + 1] = amounts[i];
                }
            } else {
                // No pair exists, assume 1:1 for testing
                amounts[i + 1] = amounts[i];
            }
        }

        return amounts;
    }
}
