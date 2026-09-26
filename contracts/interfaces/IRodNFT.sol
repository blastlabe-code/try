// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRodNFT
/// @notice Game-facing interface of the rod ERC-721. Only the FishingGame (GAME_ROLE) mutates rod state.
interface IRodNFT {
    /// @notice On-chain state of a rod; packs into a single storage slot.
    /// @param tier Tier id (0 Bamboo, 1 Carbon, 2 Golden).
    /// @param durability Casts left.
    /// @param maxDurability Current durability cap (shrinks with every repair).
    /// @param repairs Repairs used so far.
    /// @param lastCastAt Timestamp of the last cast (cooldown anchor).
    /// @param pendingCastId Cast waiting for randomness, 0 when idle. Transfers are blocked while non-zero.
    struct Rod {
        uint8 tier;
        uint16 durability;
        uint16 maxDurability;
        uint8 repairs;
        uint64 lastCastAt;
        uint64 pendingCastId;
    }

    /// @notice Mints a fresh rod of `tier` with `durability` casts to `to`.
    function mint(address to, uint8 tier, uint16 durability) external returns (uint256 rodId);

    /// @notice Consumes one durability point, stamps the cooldown anchor and locks the rod to `castId`.
    function beginCast(uint256 rodId, uint64 castId) external;

    /// @notice Unlocks the rod if it is locked to `castId`; a no-op otherwise. Never reverts for a valid caller.
    function clearPendingCast(uint256 rodId, uint64 castId) external;

    /// @notice Unlocks the rod from `castId` and gives the durability point back (stale cast cancelled).
    function refundCast(uint256 rodId, uint64 castId) external;

    /// @notice Sets the durability cap to `newMaxDurability`, refills durability to it and counts one repair.
    function applyRepair(uint256 rodId, uint16 newMaxDurability) external;

    /// @notice State of an existing rod (reverts for a non-existent id).
    function getRod(uint256 rodId) external view returns (Rod memory);

    /// @notice Owner and state of an existing rod in one call (reverts for a non-existent id).
    function getRodWithOwner(uint256 rodId) external view returns (address owner, Rod memory rod);
}
