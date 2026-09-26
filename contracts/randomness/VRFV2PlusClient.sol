// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VRFV2PlusClient
/// @notice Byte-for-byte equivalent of Chainlink's `VRFV2PlusClient` library (VRF v2.5 request encoding).
/// @dev Vendored to avoid pulling the whole `@chainlink/contracts` dependency tree for two structs and a tag.
library VRFV2PlusClient {
    /// @dev bytes4(keccak256("VRF ExtraArgsV1")) = 0x92fd1338
    bytes4 internal constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    struct ExtraArgsV1 {
        bool nativePayment;
    }

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    /// @notice Encodes `extraArgs` exactly as the coordinator expects.
    function _argsToBytes(ExtraArgsV1 memory extraArgs) internal pure returns (bytes memory bts) {
        return abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, extraArgs);
    }
}
