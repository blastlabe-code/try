// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IClaimGate
/// @notice Optional compliance hook consulted by the PrizeVault before a player withdraws prizes.
interface IClaimGate {
    /// @notice Whether `player` may withdraw owed prizes right now.
    function canClaim(address player) external view returns (bool);
}
