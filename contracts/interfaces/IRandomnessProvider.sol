// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRandomnessProvider
/// @notice Source of verifiable randomness for the game.
/// @dev Implementations MUST deliver the word asynchronously (in a later transaction) by calling
///      {IRandomnessConsumer.onRandomness} on the requester; a synchronous callback from inside
///      `requestRandomness` would reach the consumer before it recorded the request id.
interface IRandomnessProvider {
    /// @notice Requests one random word for the caller.
    /// @return requestId Provider-unique id that will be passed back to the consumer.
    function requestRandomness() external returns (uint256 requestId);
}
