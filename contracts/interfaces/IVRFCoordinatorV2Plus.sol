// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFV2PlusClient} from "../randomness/VRFV2PlusClient.sol";

/// @title IVRFCoordinatorV2Plus
/// @notice Minimal, ABI-exact subset of Chainlink's VRF v2.5 coordinator used by {ChainlinkVRFProvider}.
/// @dev Mirrors `@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol`.
interface IVRFCoordinatorV2Plus {
    /// @notice Requests random words against a subscription.
    /// @param req Request parameters; `extraArgs` = `VRFV2PlusClient._argsToBytes(ExtraArgsV1{nativePayment})`.
    /// @return requestId Coordinator-assigned request id.
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/// @title IVRFConsumerV2Plus
/// @notice Entry point the VRF v2.5 coordinator calls to deliver random words
///         (same selector as `VRFConsumerBaseV2Plus.rawFulfillRandomWords`).
interface IVRFConsumerV2Plus {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
