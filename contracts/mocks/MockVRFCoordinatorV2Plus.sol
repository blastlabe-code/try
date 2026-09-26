// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVRFCoordinatorV2Plus, IVRFConsumerV2Plus} from "../interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../randomness/VRFV2PlusClient.sol";

/// @title MockVRFCoordinatorV2Plus
/// @notice TESTS / LOCAL ONLY. Records VRF v2.5 requests and delivers words like the real coordinator: a low-level call
///         to `rawFulfillRandomWords` with the request's `callbackGasLimit`, never reverting on consumer failure.
contract MockVRFCoordinatorV2Plus is IVRFCoordinatorV2Plus {
    /// @notice A recorded request.
    struct Request {
        address sender;
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    /// @notice Number of requests made (= last request id; ids start at 1).
    uint256 public requestCount;
    mapping(uint256 requestId => Request) private _requests;

    event RandomWordsRequested(uint256 indexed requestId, address indexed sender, uint32 callbackGasLimit);
    event RandomWordsFulfilled(uint256 indexed requestId, bool success);

    error UnknownRequest(uint256 requestId);

    /// @inheritdoc IVRFCoordinatorV2Plus
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId) {
        requestId = ++requestCount;
        _requests[requestId] = Request({
            sender: msg.sender,
            keyHash: req.keyHash,
            subId: req.subId,
            requestConfirmations: req.requestConfirmations,
            callbackGasLimit: req.callbackGasLimit,
            numWords: req.numWords,
            extraArgs: req.extraArgs
        });
        emit RandomWordsRequested(requestId, msg.sender, req.callbackGasLimit);
    }

    /// @notice Recorded request `requestId` (zeroed once fulfilled).
    function getRequest(uint256 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    /// @notice Fulfils a pending request with `randomWords`, forwarding exactly `callbackGasLimit` gas.
    /// @return success Whether the consumer callback succeeded.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external returns (bool success) {
        Request storage request = _requests[requestId];
        address sender = request.sender;
        if (sender == address(0)) revert UnknownRequest(requestId);
        uint32 gasLimit = request.callbackGasLimit;
        delete _requests[requestId];
        (success,) = sender.call{gas: gasLimit}(
            abi.encodeCall(IVRFConsumerV2Plus.rawFulfillRandomWords, (requestId, randomWords))
        );
        emit RandomWordsFulfilled(requestId, success);
    }

    /// @notice Delivers arbitrary words for an arbitrary id to `consumer`, bubbling reverts (edge-case tests).
    function rawFulfill(address consumer, uint256 requestId, uint256[] calldata randomWords) external {
        IVRFConsumerV2Plus(consumer).rawFulfillRandomWords(requestId, randomWords);
    }
}
