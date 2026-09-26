/**
 * @file Stock Angler rules engine: a pure, dependency-free JavaScript port of docs/SPEC.md §1–§6.
 *
 * Shared by the Monte-Carlo simulator (`sim/simulate.mjs`) and the browser demo (`app/`), and parity-tested
 * against the Solidity contracts, so every on-chain rule uses the same integer arithmetic as the contracts:
 *   - basis points (bps, 10_000 = 100%) for chances and splits,
 *   - parts-per-million (ppm, 1_000_000 = 100%) for pool shares,
 *   - `multiplierX100` for reward multipliers (250 = 2.5x),
 *   - `bigint` for token amounts (wei) and random words, truncating division exactly like Solidity.
 *
 * Every function is pure: inputs are never mutated and new objects are returned. The only helpers that use
 * floating point are the analytics at the bottom (`catchOdds`, `expectedPoolShares`), which drive the
 * simulator's reports and the frontend's "expected value" display, never state transitions.
 *
 * Conventions:
 *   - Reward pools are keyed by symbol: `"GAME"` for the $GAME pool, the ticker (e.g. `"NVDA"`) for stock pools.
 *   - Species ids are their index in `params.species`; the jackpot species uses the reward symbol `"*"`.
 */

// ------------------------------------------------------------------------------------------------ constants

/** Basis-point denominator (10_000 = 100%). */
export const BPS = 10_000;
/** Parts-per-million denominator for pool shares (1_000_000 = 100% of a pool). */
export const PPM = 1_000_000;
/** Denominator of `multiplierX100` (100 = 1.0x). */
export const MULTIPLIER_DENOMINATOR = 100;

/** Rarity ids, as stored on-chain in `Species.rarity`. */
export const Rarity = Object.freeze({ Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4 });
/** Display names indexed by rarity id. */
export const RARITY_NAMES = Object.freeze(['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']);
/** Tournament points per catch before the rod multiplier, indexed by rarity id (SPEC §2.3). */
export const RARITY_POINTS = Object.freeze([1, 3, 10, 30, 150]);
/** Junk types indexed by `r_4 % 5` (SPEC §2.2). */
export const JUNK_NAMES = Object.freeze(['Worn Boot', 'Tin Can', 'Seaweed', 'Old Tire', 'Message in a Bottle']);

/** Reward symbol of the $GAME prize pool. */
export const GAME_SYMBOL = 'GAME';
/** Reward symbol used by the jackpot species ("pays every registered pool"). */
export const JACKPOT_SYMBOL = '*';
/** Maximum number of registered reward tokens in the PrizeVault (SPEC §5). */
export const MAX_REWARD_TOKENS = 16;

/** Admin-config bounds enforced on-chain (SPEC §4 and §7). */
export const BOUNDS = Object.freeze({
  tier: Object.freeze({
    minDurability: 1,
    maxDurability: 1000,
    minCatchBps: 500,
    maxCatchBps: 9000,
    minMultiplierX100: 100,
    maxMultiplierX100: 1000,
    minCooldown: 30,
    maxCooldown: 86_400,
  }),
  maxSpeciesSharePpm: 50_000,
  maxMaxSharePpm: 100_000,
  minPityThreshold: 2,
  maxPityThreshold: 20,
  maxBaitBonusBps: 2000,
  split: Object.freeze({ minStockBps: 2000, maxBurnPlusTreasuryBps: 3500, maxTreasuryBps: 2000 }),
});

const BPS_N = 10_000n;
const PPM_N = 1_000_000n;
const UINT256_MAX = (1n << 256n) - 1n;

// ------------------------------------------------------------------------------------------------ types

/**
 * A rod tier (SPEC §1). `price` is in wei of $GAME.
 * @typedef {Object} Tier
 * @property {string} name
 * @property {bigint} price
 * @property {number} durability      casts per new rod ("original durability")
 * @property {number} catchBps        base catch chance
 * @property {number} multiplierX100  reward multiplier (100 = 1.0x)
 * @property {number} cooldown        seconds between casts of the same rod
 */

/**
 * A catchable species (SPEC §2.3).
 * @typedef {Object} Species
 * @property {string} name
 * @property {number} rarity        0..4, see {@link Rarity}
 * @property {string} rewardSymbol  "GAME", a stock ticker, or "*" for the jackpot
 * @property {number} sharePpm      base share of the pool paid per catch (per pool for the jackpot)
 * @property {number} weight        relative pick weight inside its rarity
 * @property {boolean} enabled
 * @property {boolean} jackpot      true = pays `sharePpm` of every registered pool
 */

/**
 * Revenue split in bps; the five buckets sum to 10_000 (SPEC §4).
 * @typedef {Object} Split
 * @property {number} stockBps
 * @property {number} baitVaultBps
 * @property {number} burnBps
 * @property {number} tournamentBps
 * @property {number} treasuryBps
 */

/**
 * Loot parameters (SPEC §2.2, §3, §6).
 * @typedef {Object} Loot
 * @property {number} baitBonusBps
 * @property {number} maxCatchBps
 * @property {number} pityThreshold
 * @property {number} baitJunkCost
 * @property {number} maxSharePpm
 */

/**
 * Repair parameters (SPEC §1).
 * @typedef {Object} RepairParams
 * @property {number} repairCostBps
 * @property {number} repairWearBps
 * @property {number} maxRepairs
 */

/**
 * Tournament parameters (SPEC §6).
 * @typedef {Object} TournamentParams
 * @property {number} seasonLength  seconds
 * @property {number[]} payoutBps   payout per rank 1..10
 */

/**
 * Normalized game parameters used by every engine function.
 * @typedef {Object} Params
 * @property {Tier[]} tiers
 * @property {Species[]} species
 * @property {number[]} rarityWeights           5 weights summing to 10_000
 * @property {Split} split
 * @property {Loot} loot
 * @property {RepairParams} repair
 * @property {TournamentParams} tournament
 * @property {number} staleCastTimeout          seconds
 * @property {Record<string, number>} basketTargetWeightBps  keeper target weight per stock ticker
 * @property {string[]} rewardTokens            registered pools in registration order ("GAME" first)
 */

/**
 * Game parameters in the JSON shape of `config/game-params.json` (prices as decimal wei strings).
 * @typedef {Object} GameConfig
 * @property {{name: string, priceWei: string, durability: number, catchBps: number, multiplierX100: number, cooldown: number}[]} tiers
 * @property {Species[]} species
 * @property {number[]} rarityWeights
 * @property {Split} split
 * @property {Loot} loot
 * @property {RepairParams} repair
 * @property {TournamentParams} tournament
 * @property {number} staleCastTimeout
 * @property {Record<string, number>} basketTargetWeightBps
 */

/**
 * On-chain rod state (SPEC §1).
 * @typedef {Object} Rod
 * @property {number} tier
 * @property {number} durability     casts left
 * @property {number} maxDurability  current cap (shrinks with repairs)
 * @property {number} repairs        repairs used
 * @property {number} lastCastAt     unix seconds of the last cast (cooldown anchor)
 * @property {number} pendingCastId  0 = none
 */

/**
 * Per-player state kept by FishingGame and PrizeVault.
 * @typedef {Object} PlayerState
 * @property {number} missStreak           consecutive junk catches (pity counter, across rods)
 * @property {number} junk                 spendable junk points
 * @property {number[]} junkCaught         lifetime junk per type (length 5)
 * @property {number} bait                 bait inventory
 * @property {Record<string, bigint>} owed claimable balances per reward symbol
 */

/**
 * The slice of global state a cast resolution touches.
 * @typedef {Object} CastState
 * @property {Record<string, bigint>} pools  PrizeVault `poolAvailable` per reward symbol (wei)
 * @property {PlayerState} player            the casting player
 */

/**
 * The four independent rolls derived from one random word (SPEC §2.1).
 * @typedef {Object} Rolls
 * @property {bigint} r1  catch roll
 * @property {bigint} r2  rarity roll
 * @property {bigint} r3  species roll
 * @property {bigint} r4  junk-type roll
 */

/**
 * @typedef {Object} Payout
 * @property {string} symbol  reward pool symbol
 * @property {bigint} amount  wei credited to the player
 */

/**
 * Result of resolving one cast.
 * @typedef {Object} CastOutcome
 * @property {'junk'|'fish'} kind
 * @property {number} catchBps            effective catch chance used (10_000 when pity applied)
 * @property {boolean} pity               true if the pity rule forced the catch chance to 100%
 * @property {number} roll1               r_1 % 10_000
 * @property {number|null} junkType       0..4 for junk, else null
 * @property {number|null} rolledRarity   rarity from r_2 before any downgrade (fish only)
 * @property {number|null} rarity         rarity of the species caught (fish only)
 * @property {number|null} speciesId      index into `params.species` (fish only)
 * @property {number} effectiveSharePpm   min(sharePpm × multiplierX100 / 100, maxSharePpm); 0 for junk
 * @property {Payout[]} payouts           one entry per pool paid (all registered pools for the jackpot)
 * @property {number} score               tournament points (0 for junk)
 */

// ------------------------------------------------------------------------------------------------ errors

/** Error thrown when an action would revert on-chain. `code` mirrors the contract's custom error name. */
export class EngineError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

// ------------------------------------------------------------------------------------------------ params

/**
 * Converts a JSON config (`config/game-params.json` shape) into engine {@link Params}.
 * Registered reward tokens are `"GAME"` followed by the basket tickers in their JSON order, then any other
 * ticker referenced by a species.
 * @param {GameConfig} config
 * @returns {Params}
 */
export function paramsFromConfig(config) {
  const tiers = config.tiers.map((t) => ({
    name: t.name,
    price: BigInt(t.priceWei),
    durability: t.durability,
    catchBps: t.catchBps,
    multiplierX100: t.multiplierX100,
    cooldown: t.cooldown,
  }));
  const species = config.species.map((s) => ({ ...s }));
  const rewardTokens = [GAME_SYMBOL];
  const register = (symbol) => {
    if (symbol !== JACKPOT_SYMBOL && !rewardTokens.includes(symbol)) rewardTokens.push(symbol);
  };
  Object.keys(config.basketTargetWeightBps).forEach(register);
  species.forEach((s) => register(s.rewardSymbol));
  return {
    tiers,
    species,
    rarityWeights: [...config.rarityWeights],
    split: { ...config.split },
    loot: { ...config.loot },
    repair: { ...config.repair },
    tournament: { seasonLength: config.tournament.seasonLength, payoutBps: [...config.tournament.payoutBps] },
    staleCastTimeout: config.staleCastTimeout,
    basketTargetWeightBps: { ...config.basketTargetWeightBps },
    rewardTokens,
  };
}

/**
 * Converts engine {@link Params} back to the JSON config shape (prices as decimal wei strings).
 * @param {Params} params
 * @returns {GameConfig}
 */
export function paramsToConfig(params) {
  return {
    tiers: params.tiers.map((t) => ({
      name: t.name,
      priceWei: t.price.toString(),
      durability: t.durability,
      catchBps: t.catchBps,
      multiplierX100: t.multiplierX100,
      cooldown: t.cooldown,
    })),
    species: params.species.map((s) => ({
      name: s.name,
      rarity: s.rarity,
      rewardSymbol: s.rewardSymbol,
      sharePpm: s.sharePpm,
      weight: s.weight,
      enabled: s.enabled,
      jackpot: s.jackpot,
    })),
    rarityWeights: [...params.rarityWeights],
    split: { ...params.split },
    loot: { ...params.loot },
    repair: { ...params.repair },
    tournament: { seasonLength: params.tournament.seasonLength, payoutBps: [...params.tournament.payoutBps] },
    staleCastTimeout: params.staleCastTimeout,
    basketTargetWeightBps: { ...params.basketTargetWeightBps },
  };
}

/**
 * Checks parameters against the on-chain bounds (SPEC §4, §7) plus structural consistency (array lengths,
 * integer ranges that must fit their Solidity types, registered reward symbols).
 * @param {Params} params
 * @returns {string[]} human-readable problems; empty when the parameters are valid
 */
export function validateParams(params) {
  const problems = [];
  const b = BOUNDS;
  const isInt = (v) => Number.isInteger(v);
  const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;

  if (params.tiers.length === 0) problems.push('at least one tier is required');
  params.tiers.forEach((t, i) => {
    if (t.price <= 0n) problems.push(`tier ${i}: price must be > 0`);
    if (!inRange(t.durability, b.tier.minDurability, b.tier.maxDurability)) problems.push(`tier ${i}: durability out of bounds`);
    if (!inRange(t.catchBps, b.tier.minCatchBps, b.tier.maxCatchBps)) problems.push(`tier ${i}: catchBps out of bounds`);
    if (!inRange(t.multiplierX100, b.tier.minMultiplierX100, b.tier.maxMultiplierX100)) problems.push(`tier ${i}: multiplierX100 out of bounds`);
    if (!inRange(t.cooldown, b.tier.minCooldown, b.tier.maxCooldown)) problems.push(`tier ${i}: cooldown out of bounds`);
  });

  if (params.rewardTokens.length > MAX_REWARD_TOKENS) problems.push(`more than ${MAX_REWARD_TOKENS} reward tokens`);
  params.species.forEach((s, i) => {
    if (!inRange(s.rarity, 0, RARITY_NAMES.length - 1)) problems.push(`species ${i}: rarity out of range`);
    if (!inRange(s.sharePpm, 0, b.maxSpeciesSharePpm)) problems.push(`species ${i}: sharePpm out of bounds`);
    if (!inRange(s.weight, 0, 0xffff)) problems.push(`species ${i}: weight must fit uint16`);
    if (s.jackpot !== (s.rewardSymbol === JACKPOT_SYMBOL)) problems.push(`species ${i}: jackpot species must use reward symbol "${JACKPOT_SYMBOL}"`);
    if (!s.jackpot && !params.rewardTokens.includes(s.rewardSymbol)) problems.push(`species ${i}: reward symbol ${s.rewardSymbol} not registered`);
  });

  const rw = params.rarityWeights;
  if (rw.length !== RARITY_NAMES.length || !rw.every((w) => inRange(w, 0, BPS)) || sum(rw) !== BPS) {
    problems.push('rarityWeights must be 5 integers summing to 10000');
  }

  const { loot } = params;
  if (!inRange(loot.maxSharePpm, 1, b.maxMaxSharePpm)) problems.push('maxSharePpm out of bounds');
  if (!inRange(loot.pityThreshold, b.minPityThreshold, b.maxPityThreshold)) problems.push('pityThreshold out of bounds');
  if (!inRange(loot.baitBonusBps, 0, b.maxBaitBonusBps)) problems.push('baitBonusBps out of bounds');
  if (!inRange(loot.maxCatchBps, 0, BPS)) problems.push('maxCatchBps out of bounds');
  if (!inRange(loot.baitJunkCost, 1, 0xffff)) problems.push('baitJunkCost must be >= 1');

  const s = params.split;
  const buckets = [s.stockBps, s.baitVaultBps, s.burnBps, s.tournamentBps, s.treasuryBps];
  if (!buckets.every((v) => inRange(v, 0, BPS)) || sum(buckets) !== BPS) problems.push('split buckets must sum to 10000');
  if (s.stockBps < b.split.minStockBps) problems.push('split: stockBps below 2000');
  if (s.burnBps + s.treasuryBps > b.split.maxBurnPlusTreasuryBps) problems.push('split: burn + treasury above 3500');
  if (s.treasuryBps > b.split.maxTreasuryBps) problems.push('split: treasury above 2000');

  const r = params.repair;
  if (!inRange(r.repairCostBps, 0, BPS)) problems.push('repairCostBps must be 0..10000');
  if (!inRange(r.repairWearBps, 0, BPS)) problems.push('repairWearBps must be 0..10000');
  if (!inRange(r.maxRepairs, 0, 255)) problems.push('maxRepairs must fit uint8');

  const t = params.tournament;
  if (!(t.seasonLength > 0)) problems.push('seasonLength must be > 0');
  if (t.payoutBps.length !== 10 || !t.payoutBps.every((v) => inRange(v, 0, BPS)) || sum(t.payoutBps) > BPS) {
    problems.push('tournament payoutBps must be 10 values summing to at most 10000');
  }
  if (!(params.staleCastTimeout > 0)) problems.push('staleCastTimeout must be > 0');

  const basket = Object.entries(params.basketTargetWeightBps);
  if (basket.length > 0 && sum(basket.map(([, w]) => w)) !== BPS) problems.push('basketTargetWeightBps must sum to 10000');
  basket.forEach(([ticker]) => {
    if (ticker === GAME_SYMBOL) problems.push('basketTargetWeightBps must only list stock tickers');
  });
  return problems;
}

/**
 * Throws if {@link validateParams} reports any problem.
 * @param {Params} params
 * @returns {Params} the same params, for chaining
 */
export function assertValidParams(params) {
  const problems = validateParams(params);
  if (problems.length > 0) throw new EngineError('InvalidParams', `invalid game params:\n  - ${problems.join('\n  - ')}`);
  return params;
}

// ------------------------------------------------------------------------------------------------ state constructors

/**
 * A fresh player with no junk, bait, streak or owed balances.
 * @returns {PlayerState}
 */
export function newPlayer() {
  return { missStreak: 0, junk: 0, junkCaught: [0, 0, 0, 0, 0], bait: 0, owed: {} };
}

/**
 * Empty pools for every registered reward token, optionally pre-funded.
 * @param {Params} params
 * @param {Record<string, bigint>} [funding] wei per symbol
 * @returns {Record<string, bigint>}
 */
export function newPools(params, funding = {}) {
  const pools = {};
  for (const symbol of params.rewardTokens) pools[symbol] = funding[symbol] ?? 0n;
  return pools;
}

/**
 * The rod minted by `buyRod(tierId, maxPrice)` together with its price.
 * @param {Params} params
 * @param {number} tierId
 * @param {bigint} [maxPrice] slippage guard; reverts when the tier price is higher
 * @returns {{rod: Rod, cost: bigint}}
 */
export function buyRod(params, tierId, maxPrice) {
  const tier = tierOf(params, tierId);
  if (maxPrice !== undefined && tier.price > maxPrice) throw new EngineError('PriceAboveMax', 'rod price is above maxPrice');
  return {
    rod: { tier: tierId, durability: tier.durability, maxDurability: tier.durability, repairs: 0, lastCastAt: 0, pendingCastId: 0 },
    cost: tier.price,
  };
}

// ------------------------------------------------------------------------------------------------ randomness

/**
 * ABI-encodes `(uint256 word, uint256 index)`: two 32-byte big-endian words.
 * @param {bigint} word
 * @param {bigint} index
 * @returns {Uint8Array} 64 bytes
 */
export function encodeWordIndex(word, index) {
  const out = new Uint8Array(64);
  writeUint256(out, 0, word);
  writeUint256(out, 32, index);
  return out;
}

/**
 * Derives the four rolls from one VRF word: `r_i = uint256(keccak256(abi.encode(word, i)))` for i = 1..4.
 * The hash is injected so the engine stays dependency-free (viem's or ethers' `keccak256` both work: they
 * accept a `Uint8Array` and return a `0x` hex string; a function returning 32 raw bytes also works).
 * @param {bigint|string|number} word  uint256 random word (bigint, decimal/hex string or safe integer)
 * @param {(data: Uint8Array) => (string|Uint8Array)} keccak256
 * @returns {Rolls}
 */
export function deriveRolls(word, keccak256) {
  const w = toUint256(word);
  const roll = (i) => hashToBigInt(keccak256(encodeWordIndex(w, BigInt(i))));
  return { r1: roll(1), r2: roll(2), r3: roll(3), r4: roll(4) };
}

// ------------------------------------------------------------------------------------------------ loot primitives

/**
 * Effective catch chance of a cast (SPEC §2.2): tier chance plus bait bonus, capped at `maxCatchBps`;
 * 10_000 when the player's miss streak has reached the pity threshold.
 * @param {Params} params
 * @param {number} tierId
 * @param {boolean} baitUsed
 * @param {number} missStreak
 * @returns {number} bps
 */
export function effectiveCatchBps(params, tierId, baitUsed, missStreak) {
  const { loot } = params;
  if (missStreak >= loot.pityThreshold) return BPS;
  const raw = tierOf(params, tierId).catchBps + (baitUsed ? loot.baitBonusBps : 0);
  return Math.min(raw, loot.maxCatchBps);
}

/**
 * Maps `r_2 % 10_000` to a rarity using cumulative rarity weights (SPEC §2.2).
 * @param {number} roll2  0..9999
 * @param {number[]} rarityWeights  5 weights summing to 10_000
 * @returns {number} rarity id
 */
export function rarityFromRoll(roll2, rarityWeights) {
  let cumulative = 0;
  for (let rarity = 0; rarity < rarityWeights.length - 1; rarity++) {
    cumulative += rarityWeights[rarity];
    if (roll2 < cumulative) return rarity;
  }
  return rarityWeights.length - 1;
}

/**
 * Picks the species of a catch (SPEC §2.2/§2.3). Walks the enabled species of `rarity` in id order using
 * `r3 % totalWeight`; if that rarity has no enabled weight, downgrades to the next lower rarity that has some.
 * @param {Species[]} species
 * @param {number} rarity  rolled rarity
 * @param {bigint} r3
 * @returns {{speciesId: number, rarity: number} | null} null only if no enabled species exists at or below `rarity`
 */
export function pickSpecies(species, rarity, r3) {
  for (let r = rarity; r >= 0; r--) {
    let totalWeight = 0;
    for (const s of species) if (s.enabled && s.rarity === r) totalWeight += s.weight;
    if (totalWeight === 0) continue;
    let x = Number(r3 % BigInt(totalWeight));
    for (let id = 0; id < species.length; id++) {
      const s = species[id];
      if (!s.enabled || s.rarity !== r) continue;
      if (x < s.weight) return { speciesId: id, rarity: r };
      x -= s.weight;
    }
  }
  return null;
}

/**
 * `min(sharePpm × multiplierX100 / 100, maxSharePpm)` with Solidity truncation (SPEC §3).
 * @param {number} sharePpm
 * @param {number} multiplierX100
 * @param {number} maxSharePpm
 * @returns {number} ppm
 */
export function effectiveSharePpm(sharePpm, multiplierX100, maxSharePpm) {
  return Math.min(Math.floor((sharePpm * multiplierX100) / MULTIPLIER_DENOMINATOR), maxSharePpm);
}

/**
 * Amount credited from a pool: `poolAvailable × sharePpm / 1e6`, truncated (PrizeVault.credit).
 * @param {bigint} poolAvailable  wei
 * @param {number} sharePpm       effective share
 * @returns {bigint} wei
 */
export function poolPayout(poolAvailable, sharePpm) {
  return (poolAvailable * BigInt(sharePpm)) / PPM_N;
}

/**
 * Tournament points of a catch: `rarityPoints × multiplierX100 / 100`, truncated (SPEC §2.3).
 * @param {number} rarity
 * @param {number} multiplierX100
 * @returns {number}
 */
export function catchScore(rarity, multiplierX100) {
  return Math.floor((RARITY_POINTS[rarity] * multiplierX100) / MULTIPLIER_DENOMINATOR);
}

// ------------------------------------------------------------------------------------------------ casting

/**
 * Validates and applies the player-side part of `cast(rodId, useBait)` (SPEC §2): consumes one durability
 * point and (optionally) one bait, anchors the cooldown and sets the pending lock.
 * @param {Params} params
 * @param {Rod} rod
 * @param {PlayerState} player
 * @param {{now: number, useBait?: boolean, castId?: number}} options  `castId` defaults to 1 (any non-zero id)
 * @returns {{rod: Rod, player: PlayerState}}
 */
export function beginCast(params, rod, player, { now, useBait = false, castId = 1 }) {
  const tier = tierOf(params, rod.tier);
  if (rod.durability === 0) throw new EngineError('RodBroken', 'rod has no durability left');
  if (rod.pendingCastId !== 0) throw new EngineError('CastPending', 'rod already has a pending cast');
  if (now < rod.lastCastAt + tier.cooldown) throw new EngineError('RodOnCooldown', 'rod is on cooldown');
  if (useBait && player.bait < 1) throw new EngineError('NoBait', 'no bait left');
  if (castId === 0) throw new EngineError('InvalidCastId', 'castId must be non-zero');
  return {
    rod: { ...rod, durability: rod.durability - 1, lastCastAt: now, pendingCastId: castId },
    player: useBait ? { ...player, bait: player.bait - 1 } : player,
  };
}

/**
 * Resolves a cast from its rolls (the body of `onRandomness`, SPEC §2.2 and §3). Credits payouts from the
 * pools to `player.owed`, updates junk / miss streak, and returns the outcome. Durability and bait are
 * consumed by {@link beginCast}, not here; the rod's pending lock is released with {@link settleRod}.
 * @param {CastState} state
 * @param {Params} params
 * @param {Pick<Rod, 'tier'>} rod   only the tier is read (the tier's current config applies)
 * @param {Rolls} rolls
 * @param {boolean} useBait         whether bait was consumed for this cast
 * @returns {{outcome: CastOutcome, state: CastState}}
 */
export function resolveCast(state, params, rod, rolls, useBait) {
  const { player, pools } = state;
  const tier = tierOf(params, rod.tier);
  const pity = player.missStreak >= params.loot.pityThreshold;
  const catchBps = effectiveCatchBps(params, rod.tier, useBait, player.missStreak);
  const roll1 = Number(rolls.r1 % BPS_N);

  let rolledRarity = null;
  let picked = null;
  if (roll1 < catchBps) {
    rolledRarity = rarityFromRoll(Number(rolls.r2 % BPS_N), params.rarityWeights);
    picked = pickSpecies(params.species, rolledRarity, rolls.r3);
  }

  if (picked === null) {
    // Junk: the roll missed, or (degenerate config only) no enabled species exists at or below the rolled rarity.
    const junkType = Number(rolls.r4 % BigInt(JUNK_NAMES.length));
    const junkCaught = [...player.junkCaught];
    junkCaught[junkType] += 1;
    return {
      outcome: {
        kind: 'junk', catchBps, pity, roll1, junkType,
        rolledRarity: null, rarity: null, speciesId: null, effectiveSharePpm: 0, payouts: [], score: 0,
      },
      state: { pools, player: { ...player, junk: player.junk + 1, junkCaught, missStreak: player.missStreak + 1 } },
    };
  }

  const species = params.species[picked.speciesId];
  const share = effectiveSharePpm(species.sharePpm, tier.multiplierX100, params.loot.maxSharePpm);
  const symbols = species.jackpot ? params.rewardTokens : [species.rewardSymbol];

  const nextPools = { ...pools };
  const owed = { ...player.owed };
  const payouts = [];
  for (const symbol of symbols) {
    const amount = poolPayout(nextPools[symbol] ?? 0n, share);
    nextPools[symbol] = (nextPools[symbol] ?? 0n) - amount;
    owed[symbol] = (owed[symbol] ?? 0n) + amount;
    payouts.push({ symbol, amount });
  }

  return {
    outcome: {
      kind: 'fish', catchBps, pity, roll1, junkType: null,
      rolledRarity, rarity: picked.rarity, speciesId: picked.speciesId,
      effectiveSharePpm: share, payouts, score: catchScore(picked.rarity, tier.multiplierX100),
    },
    state: { pools: nextPools, player: { ...player, missStreak: 0, owed } },
  };
}

/**
 * Clears a rod's pending lock after its cast resolved.
 * @param {Rod} rod
 * @returns {Rod}
 */
export function settleRod(rod) {
  return { ...rod, pendingCastId: 0 };
}

/**
 * `cancelStaleCast(castId)` (SPEC §2): after `staleCastTimeout` without randomness, refunds the durability
 * point and the bait and clears the pending lock.
 * @param {Params} params
 * @param {Rod} rod
 * @param {PlayerState} player  the player who cast (receives the bait refund)
 * @param {{requestedAt: number, now: number, baitUsed: boolean}} cast
 * @returns {{rod: Rod, player: PlayerState}}
 */
export function cancelStaleCast(params, rod, player, { requestedAt, now, baitUsed }) {
  if (rod.pendingCastId === 0) throw new EngineError('NoPendingCast', 'rod has no pending cast');
  if (now < requestedAt + params.staleCastTimeout) throw new EngineError('CastNotStale', 'cast is not stale yet');
  return {
    rod: { ...rod, durability: rod.durability + 1, pendingCastId: 0 },
    player: baitUsed ? { ...player, bait: player.bait + 1 } : player,
  };
}

// ------------------------------------------------------------------------------------------------ bait & repair

/**
 * `craftBait(n)` (SPEC §6): burns `baitJunkCost` junk per bait.
 * @param {Params} params
 * @param {PlayerState} player
 * @param {number} count  bait to craft (>= 1)
 * @returns {PlayerState}
 */
export function craftBait(params, player, count) {
  if (!Number.isInteger(count) || count < 1) throw new EngineError('InvalidAmount', 'bait count must be >= 1');
  const cost = count * params.loot.baitJunkCost;
  if (player.junk < cost) throw new EngineError('NotEnoughJunk', 'not enough junk');
  return { ...player, junk: player.junk - cost, bait: player.bait + count };
}

/**
 * Quote for `repairRod(rodId)` (SPEC §1). The repair first lowers `maxDurability` by
 * `tier.durability × repairWearBps / 10_000`, then refills to the new cap. The cost covers the casts
 * restored: `tierPrice × repairCostBps / 10_000 × restored / tier.durability`, evaluated left to right with
 * truncation.
 * @param {Params} params
 * @param {Rod} rod
 * @returns {{cost: bigint, restored: number, newMaxDurability: number}}
 */
export function quoteRepair(params, rod) {
  const tier = tierOf(params, rod.tier);
  const { repairCostBps, repairWearBps, maxRepairs } = params.repair;
  if (rod.pendingCastId !== 0) throw new EngineError('CastPending', 'rod has a pending cast');
  if (rod.repairs >= maxRepairs) throw new EngineError('MaxRepairsReached', 'rod cannot be repaired again');
  const wear = Math.floor((tier.durability * repairWearBps) / BPS);
  const newMaxDurability = Math.max(rod.maxDurability - wear, 0);
  if (rod.durability >= newMaxDurability) throw new EngineError('NothingToRepair', 'repair would not restore any cast');
  const restored = newMaxDurability - rod.durability;
  const cost = ((tier.price * BigInt(repairCostBps)) / BPS_N) * BigInt(restored) / BigInt(tier.durability);
  return { cost, restored, newMaxDurability };
}

/**
 * Applies `repairRod(rodId)`; the returned `cost` must be routed through {@link splitRevenue}.
 * @param {Params} params
 * @param {Rod} rod
 * @returns {{rod: Rod, cost: bigint, restored: number}}
 */
export function repairRod(params, rod) {
  const quote = quoteRepair(params, rod);
  return {
    rod: { ...rod, durability: quote.newMaxDurability, maxDurability: quote.newMaxDurability, repairs: rod.repairs + 1 },
    cost: quote.cost,
    restored: quote.restored,
  };
}

// ------------------------------------------------------------------------------------------------ revenue

/**
 * Splits a rod purchase / repair payment (SPEC §4). Each bucket is `amount × bps / 10_000` truncated; the
 * rounding remainder (at most 4 wei) goes to the burn bucket.
 * @param {bigint} amount  wei
 * @param {Split} split
 * @returns {{stock: bigint, baitVault: bigint, burn: bigint, tournament: bigint, treasury: bigint}}
 */
export function splitRevenue(amount, split) {
  const part = (bps) => (amount * BigInt(bps)) / BPS_N;
  const stock = part(split.stockBps);
  const baitVault = part(split.baitVaultBps);
  const tournament = part(split.tournamentBps);
  const treasury = part(split.treasuryBps);
  return { stock, baitVault, burn: amount - stock - baitVault - tournament - treasury, tournament, treasury };
}

// ------------------------------------------------------------------------------------------------ tournament

/**
 * One leaderboard row.
 * @typedef {Object} TopEntry
 * @property {string} player
 * @property {number} score  the player's season total
 */

/**
 * Season index of a timestamp: `(timestamp - genesis) / seasonLength`, truncated.
 * @param {number} timestamp
 * @param {number} genesis
 * @param {number} seasonLength
 * @returns {number}
 */
export function seasonAt(timestamp, genesis, seasonLength) {
  if (timestamp < genesis) throw new EngineError('BeforeGenesis', 'timestamp before tournament genesis');
  return Math.floor((timestamp - genesis) / seasonLength);
}

/**
 * Updates a sorted top-N after `player`'s season total became `total` (Tournament.recordScore, SPEC §6).
 * A player moves above another only with a strictly higher score, so ties keep the earlier player; a
 * newcomer enters a full board only by beating the last entry.
 * @param {TopEntry[]} top  sorted by score, descending
 * @param {string} player
 * @param {number} total    the player's new season total
 * @param {number} [size]   board size (10 on-chain)
 * @returns {TopEntry[]} a new board (the same array when nothing changes)
 */
export function updateTopScores(top, player, total, size = 10) {
  const existing = top.findIndex((e) => e.player === player);
  if (existing === -1 && top.length >= size && total <= top[top.length - 1].score) return top;
  const rest = existing === -1 ? top : top.filter((_, i) => i !== existing);
  let position = rest.findIndex((e) => e.score < total);
  if (position === -1) position = rest.length;
  const next = [...rest.slice(0, position), { player, score: total }, ...rest.slice(position)];
  return next.length > size ? next.slice(0, size) : next;
}

/**
 * Season payouts on `finalize(season)` (SPEC §6): `pot × payoutBps[rank] / 10_000` for each filled rank;
 * everything not paid (unfilled ranks and rounding) rolls over to the next unfinalized season.
 * @param {bigint} pot  season prize (credited rewards plus rollover received), wei
 * @param {TopEntry[]} top
 * @param {number[]} payoutBps
 * @returns {{payouts: {player: string, rank: number, amount: bigint}[], rollover: bigint}}
 */
export function seasonPayouts(pot, top, payoutBps) {
  const payouts = [];
  let paid = 0n;
  for (let i = 0; i < Math.min(top.length, payoutBps.length); i++) {
    const amount = (pot * BigInt(payoutBps[i])) / BPS_N;
    payouts.push({ player: top[i].player, rank: i + 1, amount });
    paid += amount;
  }
  return { payouts, rollover: pot - paid };
}

// ------------------------------------------------------------------------------------------------ analytics

/**
 * Probability of each species given that a cast catches a fish, including rarity downgrades.
 * @param {Params} params
 * @returns {number[]} one probability per species id (disabled species get 0)
 */
export function catchOdds(params) {
  const odds = params.species.map(() => 0);
  params.rarityWeights.forEach((weight, rolled) => {
    if (weight === 0) return;
    for (let r = rolled; r >= 0; r--) {
      const members = params.species
        .map((s, id) => ({ s, id }))
        .filter(({ s }) => s.enabled && s.rarity === r && s.weight > 0);
      const total = sum(members.map(({ s }) => s.weight));
      if (total === 0) continue;
      for (const { s, id } of members) odds[id] += (weight / BPS) * (s.weight / total);
      return;
    }
  });
  return odds;
}

/**
 * Expected fraction of each pool paid by one cast of `tierId` with catch chance `catchBps` (the `k` of
 * SPEC §3). Multiply by a pool's size for the expected payout from that pool.
 * @param {Params} params
 * @param {number} tierId
 * @param {number} catchBps  e.g. from {@link effectiveCatchBps}
 * @returns {Record<string, number>} fraction of pool per reward symbol
 */
export function expectedPoolShares(params, tierId, catchBps) {
  const { multiplierX100 } = tierOf(params, tierId);
  const odds = catchOdds(params);
  const shares = Object.fromEntries(params.rewardTokens.map((symbol) => [symbol, 0]));
  params.species.forEach((s, id) => {
    if (odds[id] === 0) return;
    const fraction = (catchBps / BPS) * odds[id] * (effectiveSharePpm(s.sharePpm, multiplierX100, params.loot.maxSharePpm) / PPM);
    for (const symbol of s.jackpot ? params.rewardTokens : [s.rewardSymbol]) shares[symbol] += fraction;
  });
  return shares;
}

// ------------------------------------------------------------------------------------------------ internals

/**
 * @param {Params} params
 * @param {number} tierId
 * @returns {Tier}
 */
function tierOf(params, tierId) {
  const tier = params.tiers[tierId];
  if (!tier) throw new EngineError('InvalidTier', `unknown tier ${tierId}`);
  return tier;
}

/** @param {number[]} values */
function sum(values) {
  return values.reduce((a, v) => a + v, 0);
}

/**
 * @param {bigint|string|number} value
 * @returns {bigint}
 */
function toUint256(value) {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n || v > UINT256_MAX) throw new EngineError('InvalidWord', 'random word must be a uint256');
  return v;
}

/**
 * @param {Uint8Array} out
 * @param {number} offset
 * @param {bigint} value
 */
function writeUint256(out, offset, value) {
  let v = toUint256(value);
  for (let i = 31; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/**
 * @param {string|Uint8Array} hash  0x-prefixed hex or 32 raw bytes
 * @returns {bigint}
 */
function hashToBigInt(hash) {
  if (typeof hash === 'string') return BigInt(hash.startsWith('0x') ? hash : `0x${hash}`);
  let v = 0n;
  for (const byte of hash) v = (v << 8n) | BigInt(byte);
  return v;
}
