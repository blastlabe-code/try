// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockStockToken
/// @notice TESTS / LOCAL ONLY. Stand-in for a Robinhood Chain stock token: plain 18-decimal ERC-20 with an on-token
///         `multiplier()` (corporate-action factor, 1e18 = 1.0). Minting and the multiplier are open to anyone.
contract MockStockToken is ERC20 {
    /// @notice Corporate-action multiplier, 1e18-scaled (token value = price x multiplier).
    uint256 public multiplier = 1e18;

    event MultiplierUpdated(uint256 multiplier);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Mints `amount` to `to` (test helper).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Sets the corporate-action multiplier (test helper).
    function setMultiplier(uint256 multiplier_) external {
        multiplier = multiplier_;
        emit MultiplierUpdated(multiplier_);
    }
}
