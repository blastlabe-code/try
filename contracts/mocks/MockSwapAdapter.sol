// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @title MockSwapAdapter
/// @notice TESTS / LOCAL ONLY. Fixed-rate {ISwapAdapter} paying out of its own balance (pre-fund it with output tokens).
/// @dev `amountOut = amountIn * rateE18[tokenOut] / 1e18`. A non-zero `payoutHaircutBps` makes the adapter deliver less
///      than it reports, to test that callers verify the balance they actually received.
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    /// @notice Output per 1e18 input units, by output token.
    mapping(address tokenOut => uint256) public rateE18;
    /// @notice Share of the reported output withheld from the recipient (bps).
    uint16 public payoutHaircutBps;

    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error InvalidHaircut();

    /// @notice Sets the fixed rate for `tokenOut`.
    function setRate(address tokenOut, uint256 rate) external {
        rateE18[tokenOut] = rate;
    }

    /// @notice Makes the adapter under-deliver by `bps` of the reported amount.
    function setPayoutHaircutBps(uint16 bps) external {
        if (bps > 10_000) revert InvalidHaircut();
        payoutHaircutBps = bps;
    }

    /// @inheritdoc ISwapAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, bytes calldata)
        external
        returns (uint256 amountOut)
    {
        amountOut = (amountIn * rateE18[tokenOut]) / 1e18;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, (amountOut * (10_000 - payoutHaircutBps)) / 10_000);
    }
}
