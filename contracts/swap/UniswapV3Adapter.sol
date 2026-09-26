// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IV3SwapRouter} from "../interfaces/IV3SwapRouter.sol";

/// @title UniswapV3Adapter
/// @notice {ISwapAdapter} over Uniswap V3 SwapRouter02 `exactInput` (multihop), e.g. `GAME -(1%)-> WETH -(fee)-> STOCK`.
/// @dev `data` is the raw packed V3 path `abi.encodePacked(tokenIn, uint24 fee, hop, uint24 fee, ..., tokenOut)`; it
///      must start with `tokenIn` and end with `tokenOut`. Stateless: holds no funds between calls, so it is safe to be
///      permissionless (callers can only swap their own tokens).
contract UniswapV3Adapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant ADDR_SIZE = 20;
    uint256 private constant HOP_SIZE = 23; // uint24 fee + address

    /// @notice Uniswap V3 SwapRouter02.
    IV3SwapRouter public immutable swapRouter;

    event Swapped(
        address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    error ZeroAddress();
    error InvalidPath();

    /// @param swapRouter_ SwapRouter02 address (Robinhood Chain: see config/networks.json).
    constructor(IV3SwapRouter swapRouter_) {
        if (address(swapRouter_) == address(0)) revert ZeroAddress();
        swapRouter = swapRouter_;
    }

    /// @inheritdoc ISwapAdapter
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external returns (uint256 amountOut) {
        if (recipient == address(0)) revert ZeroAddress();
        _validatePath(data, tokenIn, tokenOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        amountOut = swapRouter.exactInput(
            IV3SwapRouter.ExactInputParams({
                path: data,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            })
        );
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    function _validatePath(bytes calldata path, address tokenIn, address tokenOut) private pure {
        uint256 length = path.length;
        if (length < ADDR_SIZE + HOP_SIZE || (length - ADDR_SIZE) % HOP_SIZE != 0) revert InvalidPath();
        if (address(bytes20(path[:ADDR_SIZE])) != tokenIn) revert InvalidPath();
        if (address(bytes20(path[length - ADDR_SIZE:])) != tokenOut) revert InvalidPath();
    }
}
