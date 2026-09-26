// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRandomnessConsumer
/// @notice Callback interface a randomness provider uses to deliver a random word.
interface IRandomnessConsumer {
    /// @notice Delivers the random word for `requestId`.
    /// @dev Consumers should never revert for unknown or stale request ids so that a provider
    ///      retry or late delivery cannot wedge the pipeline.
    /// @param requestId Id previously returned by {IRandomnessProvider.requestRandomness}.
    /// @param randomWord The random value.
    function onRandomness(uint256 requestId, uint256 randomWord) external;
}
