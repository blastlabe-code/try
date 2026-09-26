// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IClaimGate} from "../interfaces/IClaimGate.sol";

/// @title MockClaimGate
/// @notice TESTS / LOCAL ONLY. Claim gate with an open block list.
contract MockClaimGate is IClaimGate {
    /// @notice Players currently not allowed to claim.
    mapping(address player => bool) public blocked;

    /// @notice Blocks or unblocks `player`.
    function setBlocked(address player, bool isBlocked) external {
        blocked[player] = isBlocked;
    }

    /// @inheritdoc IClaimGate
    function canClaim(address player) external view returns (bool) {
        return !blocked[player];
    }
}
