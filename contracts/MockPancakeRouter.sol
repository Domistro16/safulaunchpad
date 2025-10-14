// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPancakeRouter
 * @notice Minimal mock of PancakeRouter's addLiquidityETH for local testing.
 *         - Transfers the provided token amount from caller to `to`.
 *         - Accepts ETH via `msg.value` and returns amounts in the same shape
 *           as the real router: (amountToken, amountETH, liquidity).
 *         - Does NOT create real LP tokens. Liquidity is represented as a
 *           simple number (amountETH) for testing purposes.
 */
contract MockPancakeRouter {
    using SafeERC20 for IERC20;

    event LiquidityAdded(
        address indexed token,
        address indexed sender,
        address indexed to,
        uint256 amountToken,
        uint256 amountETH,
        uint256 liquidity
    );

    /**
     * @dev Mocks addLiquidityETH. Caller must approve this contract to spend token.
     * @param token The ERC20 token address
     * @param amountTokenDesired Token amount caller wants to add
     * @param amountTokenMin Minimum token amount (ignored in mock but checked against 0)
     * @param amountETHMin Minimum ETH amount (compared with msg.value)
     * @param to Recipient of the "LP" (in real router this is LP token receiver). In your Launchpad you pass 0xdead.
     * @param deadline Block timestamp after which the call reverts
     * @return amountToken The token amount actually used (equal to amountTokenDesired)
     * @return amountETH The ETH amount actually used (equal to msg.value)
     * @return liquidity A simple liquidity metric (here equal to amountETH)
     */
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        require(block.timestamp <= deadline, "MockRouter: deadline passed");
        require(msg.value >= amountETHMin, "MockRouter: insufficient ETH");
        require(amountTokenDesired > 0, "MockRouter: zero token amount");
        require(to != address(0), "MockRouter: bad recipient");

        // Pull tokens from sender into the recipient `to` (mimics router behaviour)
        IERC20(token).safeTransferFrom(msg.sender, to, amountTokenDesired);

        amountToken = amountTokenDesired;
        amountETH = msg.value;

        // This mock does not mint LP tokens. We return a simple liquidity number
        // (amountETH) to let callers observe something deterministic.
        liquidity = amountETH;

        emit LiquidityAdded(
            token,
            msg.sender,
            to,
            amountToken,
            amountETH,
            liquidity
        );
        return (amountToken, amountETH, liquidity);
    }

    // Allow contract to receive ETH
    receive() external payable {}
}
