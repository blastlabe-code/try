// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessConsumer.sol";
import {IVRFCoordinatorV2Plus, IVRFConsumerV2Plus} from "../interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "./VRFV2PlusClient.sol";

/// @title ChainlinkVRFProvider
/// @notice Chainlink VRF v2.5 subscription consumer that serves randomness to the FishingGame.
/// @dev Add this contract as a consumer of the VRF subscription. Only the configured consumer (the game) may request.
///      Each request asks for one word; on fulfilment `randomWords[0]` is forwarded to the contract that requested
///      it, inside try/catch so a consumer failure can never make the coordinator's callback revert.
///      `callbackGasLimit` must cover the game's worst case (a Golden Bull jackpot over 16 pools); measure it on the
///      target chain and keep a margin (the local test suite reports the gas used).
contract ChainlinkVRFProvider is AccessControl, IRandomnessProvider, IVRFConsumerV2Plus {
    /// @notice Role allowed to tune the VRF request parameters.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    uint16 private constant MAX_REQUEST_CONFIRMATIONS = 200;
    uint32 private constant MIN_CALLBACK_GAS_LIMIT = 100_000;
    uint32 private constant MAX_CALLBACK_GAS_LIMIT = 2_500_000;

    /// @notice VRF request parameters.
    struct VRFConfig {
        bytes32 keyHash;
        uint256 subscriptionId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        bool nativePayment;
    }

    /// @notice The VRF v2.5 coordinator.
    IVRFCoordinatorV2Plus public coordinator;
    /// @notice The only contract allowed to request randomness.
    address public consumer;
    /// @notice Requester of each in-flight request (cleared once delivered).
    mapping(uint256 requestId => address) public requesterOf;

    VRFConfig private _config;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessForwarded(uint256 indexed requestId, address indexed consumer, bool success);
    event UnknownRequestIgnored(uint256 indexed requestId);
    event CoordinatorUpdated(address indexed coordinator);
    event ConsumerUpdated(address indexed consumer);
    event VRFConfigUpdated(VRFConfig config);

    /// @dev Same error as Chainlink's `VRFConsumerBaseV2Plus`.
    error OnlyCoordinatorCanFulfill(address have, address want);
    error NotConsumer(address caller);
    error NotAContract(address account);
    error InvalidVRFConfig();

    /// @param admin Receives `DEFAULT_ADMIN_ROLE`.
    /// @param coordinator_ VRF v2.5 coordinator of the chain.
    /// @param config_ Initial request parameters.
    constructor(address admin, IVRFCoordinatorV2Plus coordinator_, VRFConfig memory config_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setCoordinator(coordinator_);
        _setConfig(config_);
    }

    /// @inheritdoc IRandomnessProvider
    function requestRandomness() external returns (uint256 requestId) {
        if (msg.sender != consumer) revert NotConsumer(msg.sender);
        VRFConfig memory cfg = _config;
        requestId = coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: cfg.keyHash,
                subId: cfg.subscriptionId,
                requestConfirmations: cfg.requestConfirmations,
                callbackGasLimit: cfg.callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: cfg.nativePayment}))
            })
        );
        requesterOf[requestId] = msg.sender;
        emit RandomnessRequested(requestId, msg.sender);
    }

    /// @notice Coordinator callback; forwards the first word to the requester.
    /// @dev Unknown or already-delivered request ids are ignored rather than reverted.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert OnlyCoordinatorCanFulfill(msg.sender, address(coordinator));
        address requester = requesterOf[requestId];
        if (requester == address(0) || randomWords.length == 0) {
            emit UnknownRequestIgnored(requestId);
            return;
        }
        delete requesterOf[requestId];
        try IRandomnessConsumer(requester).onRandomness(requestId, randomWords[0]) {
            emit RandomnessForwarded(requestId, requester, true);
        } catch {
            emit RandomnessForwarded(requestId, requester, false);
        }
    }

    /// @notice Sets the contract allowed to request randomness (must be a contract).
    function setConsumer(address consumer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (consumer_.code.length == 0) revert NotAContract(consumer_);
        consumer = consumer_;
        emit ConsumerUpdated(consumer_);
    }

    /// @notice Points the provider at a new coordinator (Chainlink coordinator migration).
    function setCoordinator(IVRFCoordinatorV2Plus coordinator_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCoordinator(coordinator_);
    }

    /// @notice Updates the request parameters. Bounds: non-zero keyHash and subscription, 1..200 confirmations,
    ///         100_000..2_500_000 callback gas.
    function setVRFConfig(VRFConfig calldata config_) external onlyRole(CONFIG_ROLE) {
        _setConfig(config_);
    }

    /// @notice Current request parameters.
    function vrfConfig() external view returns (VRFConfig memory) {
        return _config;
    }

    function _setCoordinator(IVRFCoordinatorV2Plus coordinator_) private {
        if (address(coordinator_).code.length == 0) revert NotAContract(address(coordinator_));
        coordinator = coordinator_;
        emit CoordinatorUpdated(address(coordinator_));
    }

    function _setConfig(VRFConfig memory cfg) private {
        if (
            cfg.keyHash == bytes32(0) || cfg.subscriptionId == 0 || cfg.requestConfirmations == 0
                || cfg.requestConfirmations > MAX_REQUEST_CONFIRMATIONS || cfg.callbackGasLimit < MIN_CALLBACK_GAS_LIMIT
                || cfg.callbackGasLimit > MAX_CALLBACK_GAS_LIMIT
        ) revert InvalidVRFConfig();
        _config = cfg;
        emit VRFConfigUpdated(cfg);
    }
}
