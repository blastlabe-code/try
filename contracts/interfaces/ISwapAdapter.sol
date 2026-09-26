// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISwapAdapter
/// @notice Pluggable exact-input swap venue used by the RevenueRouter to recycle revenue into stock tokens.
interface ISwapAdapter {
    /// @notice Pulls `amountIn` of `tokenIn` from the caller and swaps it for at least `minAmountOut` of `tokenOut`,
    ///         sent to `recipient`.
    /// @dev The caller must have approved the adapter for `amountIn`. Callers MUST still verify the balance
    ///      they actually received; the returned value is informational.
    /// @param tokenIn Token sold.
    /// @param tokenOut Token bought.
    /// @param amountIn Exact amount of `tokenIn` sold.
    /// @param minAmountOut Minimum acceptable amount of `tokenOut` (slippage bound).
    /// @param recipient Receiver of `tokenOut`.
    /// @param data Venue-specific routing data (for {UniswapV3Adapter}: the packed V3 path).
    /// @return amountOut Amount of `tokenOut` the venue reports as delivered.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external returns (uint256 amountOut);
}
