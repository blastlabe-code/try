// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IRodNFT} from "./interfaces/IRodNFT.sol";

/// @title RodNFT
/// @notice ERC-721 fishing rods for Stock Angler with fully on-chain JSON + SVG metadata.
/// @dev Rod state (durability, cooldown anchor, pending cast lock, repairs) lives here but is mutated only by the
///      FishingGame through `GAME_ROLE`. Rods cannot be transferred while a cast is pending, and cooldown/durability
///      travel with the token, so transfers cannot be used to bypass cooldowns.
contract RodNFT is ERC721Enumerable, AccessControl, IRodNFT {
    using Strings for uint256;

    /// @notice Role allowed to mint rods and mutate rod state (the FishingGame).
    bytes32 public constant GAME_ROLE = keccak256("GAME_ROLE");
    /// @notice Number of rod tiers (0 Bamboo, 1 Carbon, 2 Golden).
    uint8 public constant TIER_COUNT = 3;

    /// @dev ERC-4906 interface id.
    bytes4 private constant ERC4906_INTERFACE_ID = 0x49064906;

    uint256 private _nextRodId = 1;
    mapping(uint256 rodId => Rod) private _rods;

    /// @notice ERC-4906: metadata of `_tokenId` changed (durability, lock, repairs).
    event MetadataUpdate(uint256 _tokenId);
    /// @notice A rod was minted.
    event RodMinted(uint256 indexed rodId, address indexed owner, uint8 indexed tier, uint16 durability);

    error RodLocked(uint256 rodId, uint64 pendingCastId);
    error InvalidTier(uint8 tier);
    error InvalidDurability();
    error RodNotCastable(uint256 rodId);
    error CastMismatch(uint256 rodId, uint64 expected, uint64 actual);

    /// @param admin Receives `DEFAULT_ADMIN_ROLE` (intended: a TimelockController owned by a multisig).
    constructor(address admin) ERC721("Stock Angler Rod", "ROD") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Game-only mutations
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IRodNFT
    /// @dev Uses `_mint` (no receiver callback): the recipient is always the buyer who initiated the purchase.
    function mint(address to, uint8 tier, uint16 durability) external onlyRole(GAME_ROLE) returns (uint256 rodId) {
        if (tier >= TIER_COUNT) revert InvalidTier(tier);
        if (durability == 0) revert InvalidDurability();
        rodId = _nextRodId++;
        _rods[rodId] = Rod({
            tier: tier,
            durability: durability,
            maxDurability: durability,
            repairs: 0,
            lastCastAt: 0,
            pendingCastId: 0
        });
        _mint(to, rodId);
        emit RodMinted(rodId, to, tier, durability);
    }

    /// @inheritdoc IRodNFT
    function beginCast(uint256 rodId, uint64 castId) external onlyRole(GAME_ROLE) {
        Rod storage rod = _existingRod(rodId);
        if (rod.durability == 0 || rod.pendingCastId != 0 || castId == 0) revert RodNotCastable(rodId);
        rod.durability -= 1;
        rod.lastCastAt = uint64(block.timestamp);
        rod.pendingCastId = castId;
        emit MetadataUpdate(rodId);
    }

    /// @inheritdoc IRodNFT
    function clearPendingCast(uint256 rodId, uint64 castId) external onlyRole(GAME_ROLE) {
        Rod storage rod = _rods[rodId];
        if (castId != 0 && rod.pendingCastId == castId) {
            rod.pendingCastId = 0;
            emit MetadataUpdate(rodId);
        }
    }

    /// @inheritdoc IRodNFT
    function refundCast(uint256 rodId, uint64 castId) external onlyRole(GAME_ROLE) {
        Rod storage rod = _existingRod(rodId);
        if (castId == 0 || rod.pendingCastId != castId) revert CastMismatch(rodId, castId, rod.pendingCastId);
        rod.pendingCastId = 0;
        if (rod.durability < rod.maxDurability) rod.durability += 1;
        emit MetadataUpdate(rodId);
    }

    /// @inheritdoc IRodNFT
    function applyRepair(uint256 rodId, uint16 newMaxDurability) external onlyRole(GAME_ROLE) {
        Rod storage rod = _existingRod(rodId);
        if (rod.pendingCastId != 0) revert RodLocked(rodId, rod.pendingCastId);
        if (newMaxDurability == 0) revert InvalidDurability();
        rod.maxDurability = newMaxDurability;
        rod.durability = newMaxDurability;
        rod.repairs += 1;
        emit MetadataUpdate(rodId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IRodNFT
    function getRod(uint256 rodId) external view returns (Rod memory) {
        _requireOwned(rodId);
        return _rods[rodId];
    }

    /// @inheritdoc IRodNFT
    function getRodWithOwner(uint256 rodId) external view returns (address owner, Rod memory rod) {
        owner = _requireOwned(rodId);
        rod = _rods[rodId];
    }

    /// @notice All rods held by `owner` (ids in enumeration order, with their state).
    /// @param owner Wallet to list.
    /// @return ids Rod token ids.
    /// @return rods Rod state for each id.
    function rodsOf(address owner) external view returns (uint256[] memory ids, Rod[] memory rods) {
        uint256 count = balanceOf(owner);
        ids = new uint256[](count);
        rods = new Rod[](count);
        for (uint256 i; i < count; ++i) {
            uint256 rodId = tokenOfOwnerByIndex(owner, i);
            ids[i] = rodId;
            rods[i] = _rods[rodId];
        }
    }

    /// @notice Display name of a tier.
    function tierName(uint8 tier) public pure returns (string memory) {
        if (tier == 0) return "Bamboo Rod";
        if (tier == 1) return "Carbon Rod";
        if (tier == 2) return "Golden Rod";
        revert InvalidTier(tier);
    }

    /// @notice Fully on-chain metadata: base64 JSON with an embedded base64 SVG image.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Rod memory rod = _rods[tokenId];
        string memory name = string.concat(tierName(rod.tier), " #", tokenId.toString());
        string memory json = string.concat(
            '{"name":"',
            name,
            '","description":"A Stock Angler fishing rod. Cast it on Robinhood Chain to catch fish and stock-token prizes.",',
            '"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(tokenId, rod))),
            '","attributes":',
            _attributes(rod),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @inheritdoc ERC721Enumerable
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Enumerable, AccessControl)
        returns (bool)
    {
        return interfaceId == ERC4906_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Blocks every transfer of a rod whose cast is still waiting for randomness.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Enumerable)
        returns (address)
    {
        uint64 pending = _rods[tokenId].pendingCastId;
        if (pending != 0) revert RodLocked(tokenId, pending);
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 amount) internal override(ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }

    function _existingRod(uint256 rodId) private view returns (Rod storage) {
        _requireOwned(rodId);
        return _rods[rodId];
    }

    function _status(Rod memory rod) private pure returns (string memory) {
        if (rod.pendingCastId != 0) return "Casting";
        if (rod.durability == 0) return "Broken";
        return "Ready";
    }

    function _tierColor(uint8 tier) private pure returns (string memory) {
        if (tier == 0) return "#9CB85C";
        if (tier == 1) return "#8FA3B8";
        return "#F2C230";
    }

    function _barColor(Rod memory rod) private pure returns (string memory) {
        uint256 pct = (uint256(rod.durability) * 100) / rod.maxDurability;
        if (pct >= 50) return "#3FB950";
        if (pct >= 20) return "#D29922";
        return "#F85149";
    }

    function _attributes(Rod memory rod) private pure returns (string memory) {
        return string.concat(
            '[{"trait_type":"Tier","value":"',
            tierName(rod.tier),
            '"},{"trait_type":"Durability","display_type":"number","value":',
            uint256(rod.durability).toString(),
            ',"max_value":',
            uint256(rod.maxDurability).toString(),
            '},{"trait_type":"Max Durability","display_type":"number","value":',
            uint256(rod.maxDurability).toString(),
            '},{"trait_type":"Repairs","display_type":"number","value":',
            uint256(rod.repairs).toString(),
            '},{"trait_type":"Status","value":"',
            _status(rod),
            '"}]'
        );
    }

    function _svg(uint256 tokenId, Rod memory rod) private pure returns (string memory) {
        string memory color = _tierColor(rod.tier);
        uint256 barWidth = (uint256(rod.durability) * 360) / rod.maxDurability;
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="monospace">'
            '<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#0B3D5C"/><stop offset="1" stop-color="#041A29"/></linearGradient></defs>'
            '<rect width="400" height="400" fill="url(#w)"/>'
            '<path d="M0 262q50-14 100 0t100 0 100 0 100 0V400H0z" fill="#0E5A80" opacity=".55"/>',
            _rodDrawing(color),
            '<text x="20" y="42" fill="#FFF" font-size="24" font-weight="bold">',
            tierName(rod.tier),
            '</text><text x="20" y="66" fill="#9BC6DB" font-size="15">#',
            tokenId.toString(),
            " \xC2\xB7 ",
            _status(rod),
            "</text>",
            _durabilityBar(rod, barWidth),
            "</svg>"
        );
    }

    function _rodDrawing(string memory color) private pure returns (string memory) {
        return string.concat(
            '<line x1="60" y1="340" x2="300" y2="80" stroke="',
            color,
            '" stroke-width="9" stroke-linecap="round"/>'
            '<line x1="60" y1="340" x2="104" y2="292" stroke="#3B2A1A" stroke-width="13" stroke-linecap="round"/>'
            '<circle cx="118" cy="288" r="17" fill="#1C252C" stroke="',
            color,
            '" stroke-width="4"/><circle cx="118" cy="288" r="4" fill="',
            color,
            '"/><path d="M300 80q42 90 30 186" stroke="#E6EEF2" stroke-width="1.5" fill="none"/>'
            '<path d="M330 266v12a7 7 0 0 1-14 0" stroke="#C9D3D9" stroke-width="2.5" fill="none"/>'
        );
    }

    function _durabilityBar(Rod memory rod, uint256 barWidth) private pure returns (string memory) {
        return string.concat(
            '<text x="20" y="350" fill="#E6EEF2" font-size="14">Durability ',
            uint256(rod.durability).toString(),
            "/",
            uint256(rod.maxDurability).toString(),
            " \xC2\xB7 Repairs ",
            uint256(rod.repairs).toString(),
            '</text><rect x="20" y="362" width="360" height="14" rx="7" fill="#1B2B36"/>'
            '<rect x="20" y="362" width="',
            barWidth.toString(),
            '" height="14" rx="7" fill="',
            _barColor(rod),
            '"/>'
        );
    }
}
