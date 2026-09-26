// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IV3SwapRouter
/// @notice Minimal, ABI-exact subset of Uniswap's SwapRouter02 (`IV3SwapRouter`) used for multihop exact-input swaps.
/// @dev SwapRouter02's `ExactInputParams` has no `deadline` field (unlike the original SwapRouter).
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` of the first path token for as much as possible of the last path token.
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
