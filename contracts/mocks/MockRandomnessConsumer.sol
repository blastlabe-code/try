// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessConsumer.sol";

/// @title MockRandomnessConsumer
/// @notice TESTS / LOCAL ONLY. Minimal consumer for testing randomness providers; can be told to revert.
contract MockRandomnessConsumer is IRandomnessConsumer {
    /// @notice Provider requests are sent to.
    IRandomnessProvider public immutable provider;
    /// @notice When true, {onRandomness} reverts.
    bool public shouldRevert;
    /// @notice Last delivered request id.
    uint256 public lastRequestId;
    /// @notice Last delivered word.
    uint256 public lastWord;
    /// @notice Number of successful deliveries.
    uint256 public deliveries;

    error DeliveryRejected();

    constructor(IRandomnessProvider provider_) {
        provider = provider_;
    }

    /// @notice Requests randomness from the provider.
    function request() external returns (uint256 requestId) {
        return provider.requestRandomness();
    }

    /// @notice Toggles reverting on delivery.
    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    /// @inheritdoc IRandomnessConsumer
    function onRandomness(uint256 requestId, uint256 randomWord) external {
        if (shouldRevert) revert DeliveryRejected();
        lastRequestId = requestId;
        lastWord = randomWord;
        deliveries += 1;
    }
}
