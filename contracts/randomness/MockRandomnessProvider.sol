// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessConsumer.sol";

/// @title MockRandomnessProvider
/// @notice TESTS / LOCAL ONLY. Records requests and lets anyone deliver any word for any request id.
/// @dev Deliberately does not police request ids (unknown, duplicate or cancelled ids can be delivered) so tests can
///      exercise the consumer's own guards. Refuses to deploy on Robinhood Chain mainnet (chainId 4663).
contract MockRandomnessProvider is Ownable, IRandomnessProvider {
    /// @notice Robinhood Chain mainnet chain id, where this contract must never exist.
    uint256 public constant MAINNET_CHAIN_ID = 4663;

    /// @notice Contract allowed to request randomness and receiving every delivery.
    address public consumer;
    /// @notice Number of requests made (= last request id; ids start at 1).
    uint256 public requestCount;
    /// @notice Whether a request id was issued.
    mapping(uint256 requestId => bool) public isRequested;
    /// @notice Last word delivered for a request id.
    mapping(uint256 requestId => uint256) public deliveredWord;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);
    event ConsumerUpdated(address indexed consumer);

    error MockOnMainnet();
    error NotConsumer(address caller);
    error ConsumerNotSet();

    constructor() Ownable(msg.sender) {
        if (block.chainid == MAINNET_CHAIN_ID) revert MockOnMainnet();
    }

    /// @notice Sets the consumer (the game).
    function setConsumer(address consumer_) external onlyOwner {
        consumer = consumer_;
        emit ConsumerUpdated(consumer_);
    }

    /// @inheritdoc IRandomnessProvider
    function requestRandomness() external returns (uint256 requestId) {
        if (msg.sender != consumer) revert NotConsumer(msg.sender);
        requestId = ++requestCount;
        isRequested[requestId] = true;
        emit RandomnessRequested(requestId, msg.sender);
    }

    /// @notice Delivers `randomWord` for `requestId` to the consumer; reverts bubble up (useful in tests).
    function fulfill(uint256 requestId, uint256 randomWord) external {
        _deliver(requestId, randomWord);
    }

    /// @notice Delivers a pseudo-random word derived from the request id and the previous block.
    /// @return randomWord The delivered word.
    function fulfillPseudo(uint256 requestId) external returns (uint256 randomWord) {
        randomWord = uint256(keccak256(abi.encode(requestId, blockhash(block.number - 1), block.timestamp)));
        _deliver(requestId, randomWord);
    }

    function _deliver(uint256 requestId, uint256 randomWord) private {
        address target = consumer;
        if (target == address(0)) revert ConsumerNotSet();
        deliveredWord[requestId] = randomWord;
        emit RandomnessFulfilled(requestId, randomWord);
        IRandomnessConsumer(target).onRandomness(requestId, randomWord);
    }
}
