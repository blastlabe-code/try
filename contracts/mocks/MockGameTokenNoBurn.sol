// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockGameTokenNoBurn
/// @notice TESTS / LOCAL ONLY. $GAME variant without a `burn` function (like a pons V1 token), used to test the
///         RevenueRouter's fallback of sending the burn bucket to 0x...dEaD.
contract MockGameTokenNoBurn is ERC20 {
    /// @notice Fixed total supply: 1,000,000,000 tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    constructor() ERC20("Stock Angler Game (no burn)", "GAMENB") {
        _mint(msg.sender, TOTAL_SUPPLY);
    }
}
