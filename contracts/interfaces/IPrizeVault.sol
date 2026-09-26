// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPrizeVault
/// @notice Prize pools and owed (claimable) balances for every reward token.
interface IPrizeVault {
    /// @notice Pulls `amount` of a registered `token` from the caller into that token's prize pool.
    function fund(address token, uint256 amount) external;

    /// @notice Moves `poolAvailable[token] * sharePpm / 1e6` from the pool to `player`'s owed balance.
    /// @dev Never reverts on a zero result or an unregistered token (returns 0 instead).
    /// @return amount Amount credited.
    function credit(address player, address token, uint256 sharePpm) external returns (uint256 amount);

    /// @notice Applies {credit} with the same `sharePpm` to every registered token (jackpot).
    /// @return tokens Registered tokens, in registration order.
    /// @return amounts Amount credited per token (may contain zeros).
    function creditAll(address player, uint256 sharePpm)
        external
        returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Whether `token` is a registered reward token.
    function isRegistered(address token) external view returns (bool);

    /// @notice Current prize pool of `token` (excludes owed balances).
    function poolAvailable(address token) external view returns (uint256);
}
