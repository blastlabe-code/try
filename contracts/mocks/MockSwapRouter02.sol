// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IV3SwapRouter} from "../interfaces/IV3SwapRouter.sol";

/// @title MockSwapRouter02
/// @notice TESTS / LOCAL ONLY. SwapRouter02 `exactInput` stand-in: parses a V3 packed path, charges the first token and
///         pays the last one out of its own balance at a fixed rate per output token (pre-fund it).
contract MockSwapRouter02 is IV3SwapRouter {
    using SafeERC20 for IERC20;

    /// @notice Output per 1e18 input units, by output (last path) token.
    mapping(address tokenOut => uint256) public rateE18;
    /// @notice Path of the last swap (for assertions).
    bytes public lastPath;
    /// @notice Recipient of the last swap (for assertions).
    address public lastRecipient;

    error InvalidPath();
    error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);

    /// @notice Sets the fixed rate for `tokenOut`.
    function setRate(address tokenOut, uint256 rate) external {
        rateE18[tokenOut] = rate;
    }

    /// @inheritdoc IV3SwapRouter
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        bytes calldata path = params.path;
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert InvalidPath();
        address tokenIn = address(bytes20(path[:20]));
        address tokenOut = address(bytes20(path[path.length - 20:]));
        amountOut = (params.amountIn * rateE18[tokenOut]) / 1e18;
        if (amountOut < params.amountOutMinimum) revert TooLittleReceived(amountOut, params.amountOutMinimum);
        lastPath = path;
        lastRecipient = params.recipient;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
