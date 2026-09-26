// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title MockGameToken
/// @notice TESTS / LOCAL ONLY. Stand-in for the pons.family $GAME token: fixed 1B supply, `ERC20Burnable`
///         (like pons V2 tokens), all minted to the deployer.
contract MockGameToken is ERC20, ERC20Burnable {
    /// @notice Fixed total supply: 1,000,000,000 tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    constructor() ERC20("Stock Angler Game", "GAME") {
        _mint(msg.sender, TOTAL_SUPPLY);
    }
}
