// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IRodNFT} from "./interfaces/IRodNFT.sol";
import {IPrizeVault} from "./interfaces/IPrizeVault.sol";
import {IRevenueRouter} from "./interfaces/IRevenueRouter.sol";
import {ITournament} from "./interfaces/ITournament.sol";
import {IRandomnessProvider} from "./interfaces/IRandomnessProvider.sol";
import {IRandomnessConsumer} from "./interfaces/IRandomnessConsumer.sol";

/// @title FishingGame
/// @notice Stock Angler game logic: rod shop, casting (commit -> randomness -> resolve), loot tables, pity, junk,
///         bait crafting and repairs. Rewards are pool-bounded fractions credited through the PrizeVault.
/// @dev Loot resolution (SPEC §2.2), with `r_i = uint256(keccak256(abi.encode(word, i)))` for i = 1..4:
///      1. `catchBps = min(tier.catchBps + (baitUsed ? baitBonusBps : 0), maxCatchBps)`;
///         if `missStreak >= pityThreshold` then `catchBps = 10_000`.
///      2. `r_1 % 10_000 >= catchBps` -> JUNK with `junkType = r_4 % 5`.
///      3. Otherwise FISH: rarity = first bucket `k` with `r_2 % 10_000 < w_0 + ... + w_k` (rarity weights).
///      4. Downgrade: while the rarity has no enabled species (total enabled weight 0) and rarity > Common,
///         rarity -= 1. Common always has an enabled species once configured (enforced on config; casting is
///         blocked before). Should no species exist at all, the cast resolves as junk (unreachable by invariant).
///      5. Species: `t = r_3 % totalWeight[rarity]`; walk species in ascending id order, skipping disabled species
///         and other rarities; pick the first with `t < weight`, else `t -= weight`.
///      6. `effectiveSharePpm = min(sharePpm * multiplierX100 / 100, maxSharePpm)`; payout =
///         `poolAvailable * effectiveSharePpm / 1e6` of the species' pool (jackpot: of every registered pool).
///      7. `score = rarityPoints[rarity] * multiplierX100 / 100`, rarityPoints = {1, 3, 10, 30, 150}; junk = 0.
///      Tier and parameter values are read at resolution time. {previewRoll} exposes steps 1-7 for parity tests.
contract FishingGame is AccessControl, Pausable, ReentrancyGuardTransient, IRandomnessConsumer {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------------------------
    // Roles & constants
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Role allowed to configure tiers, species, rarity weights and parameters.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    /// @notice Role allowed to pause buying, casting and repairing.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Basis-point denominator (100%).
    uint256 public constant BPS = 10_000;
    /// @notice Parts-per-million denominator.
    uint256 public constant PPM = 1_000_000;
    /// @notice Number of rod tiers.
    uint8 public constant TIER_COUNT = 3;
    /// @notice Number of rarities (0 Common, 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary).
    uint8 public constant RARITY_COUNT = 5;
    /// @notice Number of junk types (0 Worn Boot, 1 Tin Can, 2 Seaweed, 3 Old Tire, 4 Message in a Bottle).
    uint8 public constant JUNK_TYPE_COUNT = 5;
    /// @notice Maximum number of species (bounds the loop in the randomness callback).
    uint256 public constant MAX_SPECIES = 32;
    /// @notice `speciesId` reported for junk catches.
    uint16 public constant NO_SPECIES = type(uint16).max;

    uint8 private constant COMMON = 0;
    /// @dev Tournament points per rarity, 16 bits each (Common in the lowest bits): 1, 3, 10, 30, 150.
    uint256 private constant RARITY_POINTS_PACKED = 1 | (3 << 16) | (10 << 32) | (30 << 48) | (150 << 64);

    uint256 private constant MIN_TIER_DURABILITY = 1;
    uint256 private constant MAX_TIER_DURABILITY = 1000;
    uint256 private constant MIN_TIER_CATCH_BPS = 500;
    uint256 private constant MAX_TIER_CATCH_BPS = 9000;
    uint256 private constant MIN_MULTIPLIER_X100 = 100;
    uint256 private constant MAX_MULTIPLIER_X100 = 1000;
    uint256 private constant MIN_COOLDOWN = 30 seconds;
    uint256 private constant MAX_COOLDOWN = 1 days;
    uint256 private constant MAX_PRICE_CHANGE_BPS = 2500;
    uint256 private constant PRICE_CHANGE_INTERVAL = 24 hours;
    uint256 private constant MAX_SPECIES_SHARE_PPM = 50_000;
    uint256 private constant MAX_SHARE_PPM_LIMIT = 100_000;
    uint256 private constant MAX_SPECIES_NAME_LENGTH = 64;

    // ------------------------------------------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Lifecycle of a cast.
    enum CastStatus {
        None,
        Pending,
        Resolved,
        Cancelled
    }

    /// @notice Admin input for a tier.
    struct TierConfig {
        uint128 price;
        uint16 durability;
        uint16 catchBps;
        uint16 multiplierX100;
        uint32 cooldown;
    }

    /// @notice Stored tier (one slot). `lastPriceChangeAt` is 0 until the first price change after configuration.
    struct Tier {
        uint128 price;
        uint16 durability;
        uint16 catchBps;
        uint16 multiplierX100;
        uint32 cooldown;
        uint40 lastPriceChangeAt;
        bool configured;
    }

    /// @notice A catchable species. `jackpot = true` pays `sharePpm` of every registered pool (`rewardToken` = 0).
    struct Species {
        string name;
        uint8 rarity;
        address rewardToken;
        uint32 sharePpm;
        uint16 weight;
        bool enabled;
        bool jackpot;
    }

    /// @notice Tunable game parameters (one slot).
    struct GameParams {
        uint16 baitBonusBps;
        uint16 maxCatchBps;
        uint8 pityThreshold;
        uint32 maxSharePpm;
        uint16 baitJunkCost;
        uint32 staleCastTimeout;
        uint16 repairCostBps;
        uint16 repairWearBps;
        uint8 maxRepairs;
    }

    /// @notice Per-player counters. `totalCasts` counts resolved casts; `junkCaught` is the lifetime collection.
    struct PlayerStats {
        uint32 missStreak;
        uint32 junk;
        uint32 bait;
        uint64 totalCasts;
        uint64 totalFish;
        uint32[5] junkCaught;
    }

    /// @notice A cast and, once resolved, its outcome (for junk `speciesId == NO_SPECIES`; for fish `junkType == 0`).
    struct Cast {
        address player;
        uint64 rodId;
        uint8 tier;
        bool baitUsed;
        CastStatus status;
        uint64 requestedAt;
        uint64 resolvedAt;
        bool isFish;
        uint8 rarity;
        uint8 junkType;
        uint16 speciesId;
        uint32 score;
    }

    /// @notice Pure loot outcome for a random word (see contract docs).
    struct RollResult {
        bool isFish;
        uint8 rarity;
        uint16 speciesId;
        uint8 junkType;
        uint16 catchBps;
        uint32 sharePpm;
        uint32 score;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The $GAME token used to buy and repair rods.
    IERC20 public immutable gameToken;
    /// @notice Rod NFT collection.
    IRodNFT public immutable rodNFT;
    /// @notice Prize vault crediting rewards.
    IPrizeVault public immutable prizeVault;
    /// @notice Revenue router receiving every payment.
    IRevenueRouter public immutable revenueRouter;

    /// @notice Source of randomness for casts.
    IRandomnessProvider public randomnessProvider;
    /// @notice Tournament receiving catch scores (zero = disabled).
    ITournament public tournament;

    /// @notice Number of casts ever started (= last cast id; ids start at 1).
    uint64 public castCount;

    Tier[3] private _tiers;
    Species[] private _species;
    uint16[5] private _rarityWeights;
    uint32[5] private _rarityTotalWeight;
    GameParams private _params;

    mapping(uint256 castId => Cast) private _casts;
    mapping(address provider => mapping(uint256 requestId => uint256 castId)) private _castIdByRequest;
    mapping(address player => PlayerStats) private _stats;

    // ------------------------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------------------------

    event RodPurchased(address indexed buyer, uint256 indexed rodId, uint8 indexed tier, uint256 price);
    event RodRepaired(
        address indexed owner, uint256 indexed rodId, uint256 cost, uint16 newMaxDurability, uint8 repairs
    );
    event CastStarted(
        address indexed player, uint256 indexed rodId, uint256 indexed castId, uint256 requestId, uint8 tier, bool baitUsed
    );
    /// @notice A cast was resolved. `rewardTokens`/`rewardAmounts` are empty for junk, one entry for a regular fish
    ///         and one entry per registered pool for a jackpot.
    event CastResolved(
        address indexed player,
        uint256 indexed rodId,
        uint256 indexed castId,
        uint8 tier,
        bool isFish,
        uint16 speciesId,
        uint8 rarity,
        uint8 junkType,
        address[] rewardTokens,
        uint256[] rewardAmounts,
        uint32 score,
        uint256 randomWord
    );
    /// @notice One event per non-zero pool paid by a jackpot species (in addition to {CastResolved}).
    event JackpotPaid(address indexed player, uint256 indexed castId, address indexed token, uint256 amount);
    event CastCancelled(address indexed player, uint256 indexed rodId, uint256 indexed castId, address caller);
    event RandomnessIgnored(uint256 indexed requestId, uint256 indexed castId);
    event TournamentRecordFailed(uint256 indexed castId, address indexed player, uint256 score);
    event BaitCrafted(address indexed player, uint256 amount, uint256 junkSpent);
    event TierConfigured(
        uint8 indexed tier, uint128 price, uint16 durability, uint16 catchBps, uint16 multiplierX100, uint32 cooldown
    );
    event SpeciesConfigured(
        uint256 indexed speciesId,
        string name,
        uint8 rarity,
        address rewardToken,
        uint32 sharePpm,
        uint16 weight,
        bool enabled,
        bool jackpot
    );
    event RarityWeightsUpdated(uint16[5] weights);
    event ParamsUpdated(GameParams params);
    event RandomnessProviderUpdated(address indexed provider);
    event TournamentUpdated(address indexed tournament);

    // ------------------------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotAContract(address account);
    error InvalidTier(uint8 tier);
    error TierNotConfigured(uint8 tier);
    error InvalidTierConfig();
    error PriceChangeTooLarge(uint256 oldPrice, uint256 newPrice);
    error PriceChangeTooSoon(uint256 nextChangeAt);
    error InvalidSpecies();
    error UnknownSpecies(uint256 speciesId);
    error TooManySpecies();
    error CommonSpeciesRequired();
    error InvalidRarityWeights();
    error InvalidParams();
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error NotRodOwner(uint256 rodId);
    error SpeciesNotConfigured();
    error CastPending(uint256 rodId, uint256 castId);
    error RodBroken(uint256 rodId);
    error RodOnCooldown(uint256 rodId, uint256 readyAt);
    error NoBait();
    error NotEnoughJunk(uint256 available, uint256 required);
    error NotRandomnessProvider(address caller);
    error CastNotPending(uint256 castId);
    error CastNotStale(uint256 castId, uint256 staleAt);
    error RepairLimitReached(uint256 rodId);
    error RodWornOut(uint256 rodId);
    error NothingToRepair(uint256 rodId);

    // ------------------------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Deploys the game with SPEC default parameters and rarity weights. Tiers and species must be configured
    ///         before rods can be bought or cast.
    /// @param admin Receives `DEFAULT_ADMIN_ROLE` (intended: a TimelockController owned by a multisig).
    /// @param gameToken_ The $GAME token.
    /// @param rodNFT_ Rod collection (this contract needs its `GAME_ROLE`).
    /// @param prizeVault_ Prize vault (this contract needs its `GAME_ROLE`).
    /// @param revenueRouter_ Revenue router (this contract needs its `GAME_ROLE`).
    /// @param randomnessProvider_ Randomness provider (must accept requests from this contract).
    /// @param tournament_ Tournament (this contract needs its `GAME_ROLE`), or zero to disable scoring.
    constructor(
        address admin,
        IERC20 gameToken_,
        IRodNFT rodNFT_,
        IPrizeVault prizeVault_,
        IRevenueRouter revenueRouter_,
        IRandomnessProvider randomnessProvider_,
        ITournament tournament_
    ) {
        if (
            admin == address(0) || address(gameToken_) == address(0) || address(rodNFT_) == address(0)
                || address(prizeVault_) == address(0) || address(revenueRouter_) == address(0)
        ) revert ZeroAddress();
        gameToken = gameToken_;
        rodNFT = rodNFT_;
        prizeVault = prizeVault_;
        revenueRouter = revenueRouter_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setRandomnessProvider(randomnessProvider_);
        _setTournament(tournament_);
        _setParams(
            GameParams({
                baitBonusBps: 1000,
                maxCatchBps: 9500,
                pityThreshold: 5,
                maxSharePpm: 50_000,
                baitJunkCost: 6,
                staleCastTimeout: 1 days,
                repairCostBps: 7500,
                repairWearBps: 2000,
                maxRepairs: 2
            })
        );
        _setRarityWeights([uint16(6200), 2500, 1000, 280, 20]);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Player actions
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Buys a new rod of `tierId`, paying its price in $GAME (requires allowance to this contract).
    /// @param tierId Tier to buy (0 Bamboo, 1 Carbon, 2 Golden).
    /// @param maxPrice Slippage guard: reverts if the current price is above it.
    /// @return rodId The minted rod.
    function buyRod(uint8 tierId, uint256 maxPrice) external whenNotPaused nonReentrant returns (uint256 rodId) {
        Tier memory tier = _configuredTier(tierId);
        if (tier.price > maxPrice) revert PriceAboveMax(tier.price, maxPrice);
        _collect(msg.sender, tier.price);
        rodId = rodNFT.mint(msg.sender, tierId, tier.durability);
        emit RodPurchased(msg.sender, rodId, tierId, tier.price);
    }

    /// @notice Casts `rodId`: consumes one durability point (and one bait if `useBait`) and requests randomness.
    ///         The reward always goes to the caster, even if the rod is transferred later.
    /// @return castId Id of the new cast.
    function cast(uint256 rodId, bool useBait) external whenNotPaused nonReentrant returns (uint256 castId) {
        (address owner, IRodNFT.Rod memory rod) = rodNFT.getRodWithOwner(rodId);
        if (owner != msg.sender) revert NotRodOwner(rodId);
        if (_rarityTotalWeight[COMMON] == 0) revert SpeciesNotConfigured();
        if (rod.pendingCastId != 0) revert CastPending(rodId, rod.pendingCastId);
        if (rod.durability == 0) revert RodBroken(rodId);
        uint256 readyAt = uint256(rod.lastCastAt) + _tiers[rod.tier].cooldown;
        if (block.timestamp < readyAt) revert RodOnCooldown(rodId, readyAt);
        if (useBait) {
            PlayerStats storage stats = _stats[msg.sender];
            if (stats.bait == 0) revert NoBait();
            stats.bait -= 1;
        }

        uint64 id = ++castCount;
        castId = id;
        Cast storage c = _casts[id];
        c.player = msg.sender;
        c.rodId = uint64(rodId);
        c.tier = rod.tier;
        c.baitUsed = useBait;
        c.status = CastStatus.Pending;
        c.requestedAt = uint64(block.timestamp);

        rodNFT.beginCast(rodId, id);
        IRandomnessProvider provider = randomnessProvider;
        uint256 requestId = provider.requestRandomness();
        _castIdByRequest[address(provider)][requestId] = id;
        emit CastStarted(msg.sender, rodId, id, requestId, rod.tier, useBait);
    }

    /// @notice Cancels a cast whose randomness never arrived within `staleCastTimeout`. Callable by anyone, also
    ///         while paused. Refunds the durability point and the bait; a late delivery is then ignored.
    function cancelStaleCast(uint256 castId) external {
        Cast storage c = _casts[castId];
        if (c.status != CastStatus.Pending) revert CastNotPending(castId);
        uint256 staleAt = uint256(c.requestedAt) + _params.staleCastTimeout;
        if (block.timestamp < staleAt) revert CastNotStale(castId, staleAt);
        c.status = CastStatus.Cancelled;
        address player = c.player;
        if (c.baitUsed) _stats[player].bait += 1;
        rodNFT.refundCast(c.rodId, uint64(castId));
        emit CastCancelled(player, c.rodId, castId, msg.sender);
    }

    /// @notice Repairs `rodId`: lowers its cap by `repairWearBps` of the tier durability, then refills to the new cap.
    ///         Cost = `price * repairCostBps / 10_000 * restoredCasts / tierDurability`, split like a purchase.
    /// @return cost $GAME paid.
    function repairRod(uint256 rodId) external whenNotPaused nonReentrant returns (uint256 cost) {
        (address owner, IRodNFT.Rod memory rod) = rodNFT.getRodWithOwner(rodId);
        if (owner != msg.sender) revert NotRodOwner(rodId);
        if (rod.pendingCastId != 0) revert CastPending(rodId, rod.pendingCastId);
        uint16 newMax;
        (cost, newMax,) = _repairQuote(rodId, rod);
        _collect(msg.sender, cost);
        rodNFT.applyRepair(rodId, newMax);
        emit RodRepaired(msg.sender, rodId, cost, newMax, rod.repairs + 1);
    }

    /// @notice Turns `amount * baitJunkCost` junk points into `amount` bait.
    function craftBait(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        PlayerStats storage stats = _stats[msg.sender];
        uint256 junkCost = amount * _params.baitJunkCost;
        if (stats.junk < junkCost) revert NotEnoughJunk(stats.junk, junkCost);
        // Both casts are lossless: junkCost <= stats.junk (uint32) and amount <= junkCost (baitJunkCost >= 1).
        stats.junk -= uint32(junkCost);
        stats.bait += uint32(amount);
        emit BaitCrafted(msg.sender, amount, junkCost);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Randomness callback
    // ------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IRandomnessConsumer
    /// @dev Only the current provider may call. Never reverts for unknown, resolved or cancelled requests (they are
    ///      ignored) and makes no untrusted external calls: rewards are credited in the trusted PrizeVault, the rod is
    ///      unlocked in the trusted RodNFT and the tournament score is recorded inside try/catch.
    function onRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomnessProvider)) revert NotRandomnessProvider(msg.sender);
        uint256 castId = _castIdByRequest[msg.sender][requestId];
        Cast storage c = _casts[castId];
        if (castId == 0 || c.status != CastStatus.Pending) {
            emit RandomnessIgnored(requestId, castId);
            return;
        }
        delete _castIdByRequest[msg.sender][requestId];
        _resolve(castId, c, randomWord);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Configures a tier. Bounds: price > 0, durability 1..1000, catchBps 500..9000, multiplierX100 100..1000,
    ///         cooldown 30 s..1 day. Once configured, a price change must stay within ±25% of the current price and
    ///         at most one price change per tier per 24 h is allowed. The first configuration of a tier is exempt and
    ///         does not start the 24 h clock. Existing rods keep their stored durability.
    function configureTier(uint8 tierId, TierConfig calldata cfg) external onlyRole(CONFIG_ROLE) {
        if (tierId >= TIER_COUNT) revert InvalidTier(tierId);
        if (
            cfg.price == 0 || cfg.durability < MIN_TIER_DURABILITY || cfg.durability > MAX_TIER_DURABILITY
                || cfg.catchBps < MIN_TIER_CATCH_BPS || cfg.catchBps > MAX_TIER_CATCH_BPS
                || cfg.multiplierX100 < MIN_MULTIPLIER_X100 || cfg.multiplierX100 > MAX_MULTIPLIER_X100
                || cfg.cooldown < MIN_COOLDOWN || cfg.cooldown > MAX_COOLDOWN
        ) revert InvalidTierConfig();

        Tier storage tier = _tiers[tierId];
        uint40 lastPriceChangeAt = tier.lastPriceChangeAt;
        if (tier.configured && cfg.price != tier.price) {
            uint256 nextChangeAt = uint256(lastPriceChangeAt) + PRICE_CHANGE_INTERVAL;
            if (lastPriceChangeAt != 0 && block.timestamp < nextChangeAt) revert PriceChangeTooSoon(nextChangeAt);
            uint256 oldPrice = tier.price;
            if (
                cfg.price > (oldPrice * (BPS + MAX_PRICE_CHANGE_BPS)) / BPS
                    || cfg.price < (oldPrice * (BPS - MAX_PRICE_CHANGE_BPS)) / BPS
            ) revert PriceChangeTooLarge(oldPrice, cfg.price);
            lastPriceChangeAt = uint40(block.timestamp);
        }
        _tiers[tierId] = Tier({
            price: cfg.price,
            durability: cfg.durability,
            catchBps: cfg.catchBps,
            multiplierX100: cfg.multiplierX100,
            cooldown: cfg.cooldown,
            lastPriceChangeAt: lastPriceChangeAt,
            configured: true
        });
        emit TierConfigured(tierId, cfg.price, cfg.durability, cfg.catchBps, cfg.multiplierX100, cfg.cooldown);
    }

    /// @notice Appends a species (see {updateSpecies} for validation).
    /// @return speciesId Id of the new species.
    function addSpecies(Species memory species) external onlyRole(CONFIG_ROLE) returns (uint256 speciesId) {
        if (_species.length >= MAX_SPECIES) revert TooManySpecies();
        speciesId = _species.length;
        _species.push();
        _writeSpecies(speciesId, species);
    }

    /// @notice Replaces species `speciesId`. Validation: name 1..64 bytes, rarity < 5, weight > 0,
    ///         sharePpm <= 50_000; regular species need a registered `rewardToken`, jackpot species need
    ///         `rewardToken == address(0)`. Once Common has an enabled species it must always keep one.
    function updateSpecies(uint256 speciesId, Species memory species) external onlyRole(CONFIG_ROLE) {
        if (speciesId >= _species.length) revert UnknownSpecies(speciesId);
        _writeSpecies(speciesId, species);
    }

    /// @notice Sets the rarity weights (bps, must sum to 10_000).
    function setRarityWeights(uint16[5] calldata weights) external onlyRole(CONFIG_ROLE) {
        _setRarityWeights(weights);
    }

    /// @notice Updates the game parameters. Bounds: baitBonusBps <= 2000; 9000 <= maxCatchBps <= 10_000;
    ///         pityThreshold 2..20; 0 < maxSharePpm <= 100_000; baitJunkCost 1..100; staleCastTimeout 1 h..7 days;
    ///         repairCostBps 1000..20_000; repairWearBps <= 5000; maxRepairs <= 5 and
    ///         maxRepairs * repairWearBps <= 8000 (a rod always keeps >= 20% of its original durability).
    function setParams(GameParams calldata params_) external onlyRole(CONFIG_ROLE) {
        _setParams(params_);
    }

    /// @notice Replaces the randomness provider. Casts pending on the old provider can only be cancelled when stale.
    function setRandomnessProvider(IRandomnessProvider provider) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRandomnessProvider(provider);
    }

    /// @notice Replaces (or disables, with zero) the tournament receiving catch scores.
    function setTournament(ITournament tournament_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTournament(tournament_);
    }

    /// @notice Pauses buying, casting and repairing. Claims, stale-cast cancellation and randomness keep working.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Lifts the pause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Stored tier `tierId`.
    function getTier(uint8 tierId) external view returns (Tier memory) {
        if (tierId >= TIER_COUNT) revert InvalidTier(tierId);
        return _tiers[tierId];
    }

    /// @notice All tiers.
    function getTiers() external view returns (Tier[3] memory) {
        return _tiers;
    }

    /// @notice Species `speciesId`.
    function getSpecies(uint256 speciesId) external view returns (Species memory) {
        if (speciesId >= _species.length) revert UnknownSpecies(speciesId);
        return _species[speciesId];
    }

    /// @notice All species, by id.
    function getAllSpecies() external view returns (Species[] memory) {
        return _species;
    }

    /// @notice Number of species.
    function speciesCount() external view returns (uint256) {
        return _species.length;
    }

    /// @notice Rarity weights in bps (Common..Legendary).
    function rarityWeights() external view returns (uint16[5] memory) {
        return _rarityWeights;
    }

    /// @notice Total weight of enabled species per rarity (0 = rarity has no species and is downgraded).
    function rarityTotalWeights() external view returns (uint32[5] memory) {
        return _rarityTotalWeight;
    }

    /// @notice Current game parameters.
    function params() external view returns (GameParams memory) {
        return _params;
    }

    /// @notice Cast `castId` (status `None` if it does not exist).
    function getCast(uint256 castId) external view returns (Cast memory) {
        return _casts[castId];
    }

    /// @notice Cast waiting for randomness on `rodId` (0 if none).
    function pendingCastOf(uint256 rodId) external view returns (uint256) {
        return rodNFT.getRod(rodId).pendingCastId;
    }

    /// @notice Timestamp from which `rodId` can be cast again (cooldown end).
    function cooldownEndsAt(uint256 rodId) external view returns (uint256) {
        IRodNFT.Rod memory rod = rodNFT.getRod(rodId);
        return uint256(rod.lastCastAt) + _tiers[rod.tier].cooldown;
    }

    /// @notice Counters of `player` (miss streak, junk points, bait, junk collection, casts, fish).
    function playerStats(address player) external view returns (PlayerStats memory) {
        return _stats[player];
    }

    /// @notice Price and new cap of repairing `rodId` now (reverts with the same errors as {repairRod}).
    /// @return cost $GAME cost.
    /// @return newMaxDurability Cap (and durability) after the repair.
    /// @return restoredCasts Casts restored by the repair.
    function repairQuote(uint256 rodId)
        external
        view
        returns (uint256 cost, uint16 newMaxDurability, uint16 restoredCasts)
    {
        return _repairQuote(rodId, rodNFT.getRod(rodId));
    }

    /// @notice Loot outcome the current configuration assigns to `randomWord` (exact callback logic, no side effects).
    /// @param randomWord Random word delivered by the provider.
    /// @param tierId Rod tier.
    /// @param baitUsed Whether bait was used.
    /// @param missStreak Player's junk streak before the cast.
    function previewRoll(uint256 randomWord, uint8 tierId, bool baitUsed, uint256 missStreak)
        external
        view
        returns (RollResult memory)
    {
        if (tierId >= TIER_COUNT) revert InvalidTier(tierId);
        return _roll(randomWord, _tiers[tierId], baitUsed, missStreak);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals: resolution
    // ------------------------------------------------------------------------------------------------------------

    function _resolve(uint256 castId, Cast storage c, uint256 randomWord) private {
        address player = c.player;
        PlayerStats storage stats = _stats[player];
        RollResult memory r = _roll(randomWord, _tiers[c.tier], c.baitUsed, stats.missStreak);

        c.status = CastStatus.Resolved;
        c.resolvedAt = uint64(block.timestamp);
        c.isFish = r.isFish;
        c.rarity = r.rarity;
        c.junkType = r.junkType;
        c.speciesId = r.speciesId;
        c.score = r.score;

        stats.totalCasts += 1;
        address[] memory tokens;
        uint256[] memory amounts;
        if (r.isFish) {
            stats.missStreak = 0;
            stats.totalFish += 1;
            (tokens, amounts) = _payout(castId, player, r);
        } else {
            stats.missStreak += 1;
            stats.junk += 1;
            stats.junkCaught[r.junkType] += 1;
        }

        rodNFT.clearPendingCast(c.rodId, uint64(castId));
        _emitResolved(castId, c, tokens, amounts, randomWord);

        ITournament t = tournament;
        if (r.score != 0 && address(t) != address(0)) {
            try t.recordScore(player, r.score) {}
            catch {
                emit TournamentRecordFailed(castId, player, r.score);
            }
        }
    }

    /// @dev Separate frame so the 12-field event fits the legacy code generator's stack; reads the stored outcome.
    function _emitResolved(
        uint256 castId,
        Cast storage c,
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 randomWord
    ) private {
        emit CastResolved(
            c.player,
            c.rodId,
            castId,
            c.tier,
            c.isFish,
            c.speciesId,
            c.rarity,
            c.junkType,
            tokens,
            amounts,
            c.score,
            randomWord
        );
    }

    function _payout(uint256 castId, address player, RollResult memory r)
        private
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        Species storage species = _species[r.speciesId];
        if (species.jackpot) {
            (tokens, amounts) = prizeVault.creditAll(player, r.sharePpm);
            for (uint256 i; i < tokens.length; ++i) {
                if (amounts[i] != 0) emit JackpotPaid(player, castId, tokens[i], amounts[i]);
            }
        } else {
            tokens = new address[](1);
            amounts = new uint256[](1);
            address token = species.rewardToken;
            tokens[0] = token;
            amounts[0] = prizeVault.credit(player, token, r.sharePpm);
        }
    }

    /// @dev Pure function of (word, tier, bait, missStreak, configuration); see the contract-level docs.
    function _roll(uint256 randomWord, Tier memory tier, bool baitUsed, uint256 missStreak)
        private
        view
        returns (RollResult memory r)
    {
        GameParams memory p = _params;
        uint256 catchBps = uint256(tier.catchBps) + (baitUsed ? p.baitBonusBps : 0);
        if (catchBps > p.maxCatchBps) catchBps = p.maxCatchBps;
        if (missStreak >= p.pityThreshold) catchBps = BPS;
        r.catchBps = uint16(catchBps);
        r.speciesId = NO_SPECIES;

        if (_subRoll(randomWord, 1) % BPS >= catchBps) {
            r.junkType = uint8(_subRoll(randomWord, 4) % JUNK_TYPE_COUNT);
            return r;
        }

        uint256 rarity = _rarityFor(_subRoll(randomWord, 2) % BPS);
        uint256 totalWeight = _rarityTotalWeight[rarity];
        while (totalWeight == 0 && rarity != COMMON) {
            --rarity;
            totalWeight = _rarityTotalWeight[rarity];
        }
        if (totalWeight == 0) {
            // Unreachable while the Common-species invariant holds; resolve as junk rather than revert.
            r.junkType = uint8(_subRoll(randomWord, 4) % JUNK_TYPE_COUNT);
            return r;
        }

        uint256 target = _subRoll(randomWord, 3) % totalWeight;
        uint256 count = _species.length;
        for (uint256 id; id < count; ++id) {
            Species storage species = _species[id];
            if (!species.enabled || species.rarity != rarity) continue;
            uint256 weight = species.weight;
            if (target < weight) {
                uint256 share = (uint256(species.sharePpm) * tier.multiplierX100) / 100;
                if (share > p.maxSharePpm) share = p.maxSharePpm;
                r.isFish = true;
                r.rarity = uint8(rarity);
                r.speciesId = uint16(id);
                r.sharePpm = uint32(share);
                r.score = uint32((_rarityPoints(rarity) * tier.multiplierX100) / 100);
                return r;
            }
            target -= weight;
        }
    }

    /// @dev `r_i = uint256(keccak256(abi.encode(word, i)))`.
    function _subRoll(uint256 randomWord, uint256 index) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(randomWord, index)));
    }

    function _rarityFor(uint256 roll) private view returns (uint256) {
        uint256 cumulative;
        for (uint256 rarity; rarity < RARITY_COUNT - 1; ++rarity) {
            cumulative += _rarityWeights[rarity];
            if (roll < cumulative) return rarity;
        }
        return RARITY_COUNT - 1;
    }

    function _rarityPoints(uint256 rarity) private pure returns (uint256) {
        return (RARITY_POINTS_PACKED >> (16 * rarity)) & 0xFFFF;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals: shop & configuration
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Pulls `amount` of $GAME from `payer` straight into the router, then lets the router split it.
    function _collect(address payer, uint256 amount) private {
        gameToken.safeTransferFrom(payer, address(revenueRouter), amount);
        revenueRouter.distribute(amount);
    }

    function _configuredTier(uint8 tierId) private view returns (Tier memory tier) {
        if (tierId >= TIER_COUNT) revert InvalidTier(tierId);
        tier = _tiers[tierId];
        if (!tier.configured) revert TierNotConfigured(tierId);
    }

    function _repairQuote(uint256 rodId, IRodNFT.Rod memory rod)
        private
        view
        returns (uint256 cost, uint16 newMaxDurability, uint16 restoredCasts)
    {
        GameParams memory p = _params;
        if (rod.repairs >= p.maxRepairs) revert RepairLimitReached(rodId);
        Tier memory tier = _tiers[rod.tier];
        uint256 wear = (uint256(tier.durability) * p.repairWearBps) / BPS;
        if (wear >= rod.maxDurability) revert RodWornOut(rodId);
        newMaxDurability = uint16(rod.maxDurability - wear);
        if (rod.durability >= newMaxDurability) revert NothingToRepair(rodId);
        restoredCasts = newMaxDurability - rod.durability;
        cost = (uint256(tier.price) * p.repairCostBps) / BPS * restoredCasts / tier.durability;
    }

    function _writeSpecies(uint256 speciesId, Species memory s) private {
        uint256 nameLength = bytes(s.name).length;
        if (
            nameLength == 0 || nameLength > MAX_SPECIES_NAME_LENGTH || s.rarity >= RARITY_COUNT || s.weight == 0
                || s.sharePpm > MAX_SPECIES_SHARE_PPM
        ) revert InvalidSpecies();
        if (s.jackpot ? s.rewardToken != address(0) : !prizeVault.isRegistered(s.rewardToken)) {
            revert InvalidSpecies();
        }

        bool commonWasStocked = _rarityTotalWeight[COMMON] != 0;
        Species storage current = _species[speciesId];
        if (current.enabled) _rarityTotalWeight[current.rarity] -= current.weight;
        if (s.enabled) _rarityTotalWeight[s.rarity] += s.weight;
        if (commonWasStocked && _rarityTotalWeight[COMMON] == 0) revert CommonSpeciesRequired();

        _species[speciesId] = s;
        emit SpeciesConfigured(speciesId, s.name, s.rarity, s.rewardToken, s.sharePpm, s.weight, s.enabled, s.jackpot);
    }

    function _setRarityWeights(uint16[5] memory weights) private {
        uint256 sum;
        for (uint256 i; i < RARITY_COUNT; ++i) {
            sum += weights[i];
        }
        if (sum != BPS) revert InvalidRarityWeights();
        _rarityWeights = weights;
        emit RarityWeightsUpdated(weights);
    }

    function _setParams(GameParams memory p) private {
        if (
            p.baitBonusBps > 2000 || p.maxCatchBps < MAX_TIER_CATCH_BPS || p.maxCatchBps > BPS || p.pityThreshold < 2
                || p.pityThreshold > 20 || p.maxSharePpm == 0 || p.maxSharePpm > MAX_SHARE_PPM_LIMIT
                || p.baitJunkCost == 0 || p.baitJunkCost > 100 || p.staleCastTimeout < 1 hours
                || p.staleCastTimeout > 7 days || p.repairCostBps < 1000 || p.repairCostBps > 20_000
                || p.repairWearBps > 5000 || p.maxRepairs > 5 || uint256(p.maxRepairs) * p.repairWearBps > 8000
        ) revert InvalidParams();
        _params = p;
        emit ParamsUpdated(p);
    }

    function _setRandomnessProvider(IRandomnessProvider provider) private {
        if (address(provider).code.length == 0) revert NotAContract(address(provider));
        randomnessProvider = provider;
        emit RandomnessProviderUpdated(address(provider));
    }

    /// @dev The code-size check matters: try/catch cannot catch the revert of a call to a codeless address.
    function _setTournament(ITournament tournament_) private {
        if (address(tournament_) != address(0) && address(tournament_).code.length == 0) {
            revert NotAContract(address(tournament_));
        }
        tournament = tournament_;
        emit TournamentUpdated(address(tournament_));
    }
}
