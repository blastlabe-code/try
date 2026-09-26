// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ITournament
/// @notice Weekly leaderboard fed by the FishingGame and funded by the RevenueRouter.
interface ITournament {
    /// @notice Adds `points` to `player`'s score in the current season.
    function recordScore(address player, uint256 points) external;

    /// @notice Pulls `amount` of $GAME from the caller into the current season's prize pool.
    function notifyReward(uint256 amount) external;

    /// @notice Index of the season in progress.
    function currentSeason() external view returns (uint256);
}
