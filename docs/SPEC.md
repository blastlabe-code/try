# Stock Angler: Game & Contract Specification

A fishing game on **Robinhood Chain** (Arbitrum Orbit L2, chainId `4663`, testnet `46630`, gas token ETH).
Players buy **Rod NFTs** with the game token (**$GAME**, launched on pons.family), cast them
(with cooldowns, until durability runs out), and catch either **junk** (worn boots, tin cans...),
**fish** (paid in $GAME), or **stock fish**, which are paid in real Robinhood **Stock Tokens**
(NVDA, AAPL, TSLA...: standard 18-decimal ERC-20s on Robinhood Chain).

This document is the single source of truth. Contracts, the simulator, tests and the frontend
MUST all follow it. Any deviation must be written back into this file.

---------------------------------------------------------------------------------------------------

## 0. Ground facts (verified)

| Item | Value |
|---|---|
| Robinhood Chain mainnet | chainId 4663, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com` |
| Robinhood Chain testnet | chainId 46630, RPC `https://rpc.testnet.chain.robinhood.com`, faucet `https://faucet.testnet.chain.robinhood.com` |
| WETH (mainnet) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (Uniswap sdk-core) |
| Uniswap V3 SwapRouter02 (mainnet) | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Uniswap V3 Factory (mainnet) | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| Uniswap V3 QuoterV2 (mainnet) | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| Pons V1 factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`: fixed-supply ERC-20 + locked Uniswap **V3** liquidity vs WETH |
| Pons V2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`: bonding curve → graduates to Uniswap **V4**; token is `ERC20Burnable` |
| Stock Tokens | one standard ERC-20 (18 decimals) per ticker; value = price × on-token `multiplier` (corporate actions); Chainlink tokenized-equity feeds exist per ticker |
| Randomness | Chain docs recommend **Chainlink VRF**; `block.prevrandao` is NOT usable on Arbitrum-based chains (constant) |
| Sequencer | centralized FCFS sequencer w/ compliance screening → no public mempool (sandwich risk is low but non-zero) |

Consequences:
* $GAME is **fixed supply**: the game can never mint rewards. Every reward must come from pools funded by
  player spending (or seeded by the team / creator fees). → payouts MUST be pool-bounded (see §3).
* Addresses of individual stock tokens, Chainlink feeds and the VRF coordinator are **not hard-coded**:
  they go in `config/networks.json` and must be verified on the official Robinhood Chain docs before
  mainnet deploy.

---------------------------------------------------------------------------------------------------

## 1. Rods (ERC-721 `RodNFT`)

Three tiers. All values are defaults that the admin can change within bounds (§7). $GAME amounts are in whole tokens (×1e18 on-chain).

| Tier id | Name | Price ($GAME) | Durability (casts) | Catch chance | Reward multiplier | Cooldown |
|---|---|---|---|---|---|---|
| 0 | Bamboo Rod (Beginner) | 100,000 | 30 | 45.00% | 1.0x | 300 s |
| 1 | Carbon Rod (Pro) | 400,000 | 40 | 55.00% | 2.5x | 240 s |
| 2 | Golden Rod (Master) | 1,100,000 | 50 | 65.00% | 5.0x | 180 s |

Price ratios come from equalizing "value per $GAME spent": value per rod ∝ durability × catch × multiplier
(13.5 : 55 : 162.5), and higher tiers get a small efficiency bonus (≈0.95 : 1.00 : 1.05) so upgrading is
rewarding but never dominant. The simulator (§9) validates and may retune these numbers.

On-chain rod state (per tokenId):
```
struct Rod {
  uint8  tier;
  uint16 durability;      // casts left
  uint16 maxDurability;   // current cap (shrinks with repairs)
  uint8  repairs;         // repairs used
  uint64 lastCastAt;      // timestamp of last cast (cooldown anchor)
  uint64 pendingCastId;   // 0 = none; non-zero = cast waiting for randomness
}
```
* Only the `FishingGame` contract (role `GAME_ROLE`) may mint rods or mutate rod state.
* Rods are freely transferable **except while a cast is pending** (`_update` reverts if `pendingCastId != 0`).
  Cooldown and durability travel with the rod, so transferring rods cannot bypass cooldowns.
* `tokenURI` returns fully on-chain JSON + SVG (tier name, colour, durability bar, repairs).
* `ERC721Enumerable` so the frontend can list a wallet's rods.

**Repair** (`FishingGame.repairRod(rodId)`): restores durability to the current `maxDurability`.
* cost = `tierPrice × repairCostBps (7500) / 10000 × (missing casts) / originalDurability`
* max 2 repairs per rod; each repair first lowers `maxDurability` by `repairWearBps` (2000 = 20%) of the
  tier's original durability (so 100% → 80% → 60%), then refills.
* Repair payments go through the same revenue split as rod purchases (§4).

---------------------------------------------------------------------------------------------------

## 2. Casting flow (commit → randomness → resolve)

```
cast(rodId, useBait)            // player tx
  require owner, !paused, durability > 0, pendingCastId == 0,
          block.timestamp >= lastCastAt + tier.cooldown
  durability -= 1; lastCastAt = now; consume 1 bait if useBait
  castId = ++castCount; store Cast{player, rodId, tier, baitUsed, requestedAt, status=Pending}
  requestId = randomness.requestRandomness()   → castIdByRequest[requestId] = castId
  emit CastStarted

onRandomness(requestId, word)   // called by the randomness provider ONLY
  resolves the cast fully inside the callback. MUST NOT revert and MUST NOT make untrusted external
  calls: rewards are *credited* to the player's claimable balance in PrizeVault (trusted),
  tournament score is recorded via try/catch. Unknown / already-resolved / cancelled requestIds are ignored.
  clears rod.pendingCastId, emits CastResolved

cancelStaleCast(castId)         // player (or anyone) after `staleCastTimeout` (default 1 day)
  if randomness never arrived: refund the durability point and the bait, clear the pending lock,
  status = Cancelled. A late randomness delivery for it is ignored.
```
The reward always goes to the address that **cast** (stored in the Cast), even if the rod is later transferred.

### 2.1 Randomness providers (`IRandomnessProvider`)
```
interface IRandomnessProvider { function requestRandomness() external returns (uint256 requestId); }
interface IRandomnessConsumer { function onRandomness(uint256 requestId, uint256 randomWord) external; }
```
* `ChainlinkVRFProvider`: Chainlink **VRF v2.5** subscription consumer (keyHash, subId, confirmations,
  callbackGasLimit, nativePayment configurable). Only the configured consumer (the game) can request. On
  `fulfillRandomWords` it forwards `randomWords[0]` to the game.
* `MockRandomnessProvider` (tests/local only): records requests; `fulfill(requestId, word)` and
  `fulfillPseudo(requestId)` callable by anyone (NEVER deploy on mainnet; the deploy script refuses).
* The game derives independent rolls from the single word: `r_i = uint256(keccak256(abi.encode(word, i)))`.

### 2.2 Loot resolution (all in basis points, 10_000 = 100%)
```
catchBps = tier.catchBps + (baitUsed ? baitBonusBps (1000) : 0), capped at maxCatchBps (9500)
if player.missStreak >= pityThreshold (5): catchBps = 10000     // pity: 6th cast after 5 misses always catches

roll1 = r_1 % 10000
if roll1 >= catchBps  → JUNK:
     junkType = r_4 % 5  → {0 Worn Boot, 1 Tin Can, 2 Seaweed, 3 Old Tire, 4 Message in a Bottle}
     junk[player] += 1; junkCaught[player][junkType] += 1; missStreak += 1; score 0
else → FISH: missStreak = 0
     roll2 = r_2 % 10000 → rarity by cumulative weights:
        Common 6200 | Uncommon 2500 | Rare 1000 | Epic 280 | Legendary 20   (sum 10000)
     species = the enabled species of that rarity picked with r_3 (weighted by species.weight)
     payout: see §3
```

### 2.3 Species (admin-configurable list; defaults)

| id | Species | Rarity | Reward pool | Base share (ppm of pool) |
|---|---|---|---|---|
| 0 | Minnow | Common | $GAME | 150 |
| 1 | Sardine | Common | $GAME | 150 |
| 2 | Perch | Common | $GAME | 150 |
| 3 | Bass | Uncommon | $GAME | 600 |
| 4 | Trout | Uncommon | $GAME | 600 |
| 5 | Catfish | Uncommon | $GAME | 600 |
| 6 | Apple Snapper | Rare | AAPL | 4,000 |
| 7 | Microsoft Marlin | Rare | MSFT | 4,000 |
| 8 | Amazon Amberjack | Rare | AMZN | 4,000 |
| 9 | Google Grouper | Rare | GOOGL | 4,000 |
| 10 | Meta Mackerel | Rare | META | 4,000 |
| 11 | Nvidia Neon Shark | Epic | NVDA | 12,000 |
| 12 | Tesla Thunder Eel | Epic | TSLA | 12,000 |
| 13 | Golden Bull | Legendary | **every** stock pool + $GAME pool | 10,000 each |

```
struct Species { string name; uint8 rarity; address rewardToken; uint32 sharePpm; uint16 weight; bool enabled; bool jackpot; }
```
`jackpot = true` means "pay sharePpm of every registered reward pool" (Golden Bull).
If a rarity has no enabled species, the catch is downgraded to the next lower rarity with species.

Score (tournament) per catch = `rarityPoints × multiplierX100 / 100`, rarityPoints = {Common 1, Uncommon 3, Rare 10, Epic 30, Legendary 150}, junk = 0.

---------------------------------------------------------------------------------------------------

## 3. Pool-bounded payouts: why the game can't go insolvent

Every payout is a **fraction of the live pool** of that token, never a fixed amount:
```
amount = poolAvailable[token] × min(sharePpm × multiplierX100 / 100, maxSharePpm (50_000 = 5%)) / 1e6
```
* The game can never owe more than it holds. Pools shrink geometrically, so they never hit zero.
* **Long-run return-to-player (RTP) = the share of spending routed into prize pools**, whatever the odds.
  At equilibrium, inflow per cast = outflow per cast, so the pool settles at
  `P* = inflowPerCast / k`, where `k = Σ p(species) × effectiveShare` is the expected fraction of the pool paid per cast.
  The odds and shares therefore set the *size and variance* of prizes and how fast pools react, not the RTP.
* Stock-token corporate actions (the token `multiplier`) and price moves don't matter: payouts are denominated
  in token units as a share of the pool.
* Tier fairness: expected value per $GAME spent ∝ `catch × multiplier × durability / price`, which is equalized via rod prices.
* The frontend shows the *current* expected value of each species in USD (pool × share × Chainlink price).

---------------------------------------------------------------------------------------------------

## 4. Revenue router & recycling (`RevenueRouter`)

Every rod purchase / repair payment in $GAME is split **immediately** (bps, admin-adjustable within bounds):

| Bucket | Default | What happens |
|---|---|---|
| Stock pool | **30%** | stays in the router as `stockBudget`; keepers swap it into stock tokens (`recycle`) which are deposited into the PrizeVault stock pools |
| Bait vault ($GAME prize pool) | 35% | sent to PrizeVault, credited to the $GAME pool |
| Burn | 15% | burned (`ERC20Burnable.burn` if supported, else transfer to `0x000…dEaD`) |
| Tournament | 10% | sent to `Tournament` and credited to the current season prize pool |
| Treasury | 10% | sent to the treasury (ops, audits, VRF/keeper gas, pool seeding) |

Bounds (enforced on-chain): the five buckets sum to 10_000; `stock ≥ 2000`; `burn + treasury ≤ 3500`
(guarantees ≥ 65% of all spending returns to players through pools); `treasury ≤ 2000`.

**Recycling** (`recycle(tokenIn, stockOut, amountIn, minAmountOut, swapData)`, `KEEPER_ROLE`):
* `tokenIn` ∈ {$GAME (limited to `stockBudget`), WETH (e.g. donated pons creator fees)}; `stockOut` must be a registered stock pool.
* Swaps via a pluggable `ISwapAdapter` (default `UniswapV3Adapter` → SwapRouter02 `exactInput` multihop, path e.g.
  `GAME →(1%) WETH →(fee) STOCK`). The adapter validates that the path starts with `tokenIn` and ends with `stockOut`.
* Guards: `amountIn ≤ maxRecycleIn[tokenIn]`, `minRecycleInterval` between recycles, `minAmountOut > 0` and checked
  against the actual stock-token balance delta; the output goes straight into `PrizeVault.fund(stock, out)`.
* Keeper chooses the most under-weight stock vs `targetWeightBps` (computed off-chain with Chainlink prices;
  see `scripts/keeper.js`).
* `donate` path: anyone can top up any pool directly via `PrizeVault.fund` (e.g. team seeds, pons creator-fee
  flywheel buys stocks and deposits them).

---------------------------------------------------------------------------------------------------

## 5. PrizeVault

Holds all prize tokens with strict accounting:
```
poolAvailable[token]          // prize pool, source of payouts
owed[player][token]           // credited, claimable, NEVER touchable by admin
totalOwed[token]
invariant: token.balanceOf(vault) >= poolAvailable[token] + totalOwed[token]
```
* `fund(token, amount)`: transferFrom caller → poolAvailable (registered tokens only).
* `sync(token)`: adds unaccounted balance (`balance - available - owed`) to the pool (donations by plain transfer).
* `credit(player, token, sharePpmEffective) → amount` (`GAME_ROLE` only): moves `available × share / 1e6` from pool to owed. Never reverts on zero.
* `claim(tokens[])` / `claimAll()`: player withdraws owed balances (nonReentrant, SafeERC20). **Claims are never pausable.**
  Optional `claimGate` (address, default 0) hook for jurisdiction compliance; if set, `claimGate.canClaim(player)` must be true.
* Admin cannot withdraw owed funds, ever. Admin can withdraw **available** (not owed) funds only via a
  2-step, **7-day timelocked** `scheduleEmergencyWithdraw` / `executeEmergencyWithdraw` (events announce it publicly).
* Registered reward tokens: $GAME + each stock. `registerToken(token)` admin-only; max 16 tokens.

---------------------------------------------------------------------------------------------------

## 6. Junk, Bait, Pity, Tournament

* **Junk** is non-transferable, stored in `FishingGame` (`junk[player]` spendable points +
  `junkCaught[player][type]` lifetime collection). No external calls in the randomness callback.
* **Bait**: `craftBait(n)` burns `baitJunkCost (6)` junk per bait. Using bait adds +10% catch chance to one cast.
  Turns bad luck into a comeback mechanic.
* **Pity**: after `pityThreshold (5)` junk catches in a row (per player, across rods), the next cast is a guaranteed fish.
* **Tournament** (`Tournament` contract): weekly seasons (`seasonLength 7 days`, from `genesis`).
  * `recordScore(player, points)` (`GAME_ROLE`), keeps a sorted on-chain **top-10** per season (O(10) insertion; ties keep earlier player).
  * Season prize = $GAME credited to that season via the router (`notifyReward`), plus rollover.
  * After a season ends anyone calls `finalize(season)`: payouts `[3000,2000,1300,1000,800,600,500,400,200,200]` bps
    to ranks 1..10; unfilled ranks roll over to the next *unfinalized* season. Winners `claim(season)`.

---------------------------------------------------------------------------------------------------

## 7. Admin, safety & bounds

* `AccessControl` everywhere: `DEFAULT_ADMIN_ROLE` (intended: a `TimelockController` owned by a multisig),
  `CONFIG_ROLE`, `KEEPER_ROLE`, `PAUSER_ROLE`, `GAME_ROLE` (contract-to-contract).
* `Pausable` on buying/casting/repairing only. Claims, `cancelStaleCast` and randomness callbacks keep working while paused.
* `ReentrancyGuard` + `SafeERC20` on every external token movement. CEI ordering.
* Config bounds (reverts otherwise):
  * tier: price > 0, 1 ≤ durability ≤ 1000, 500 ≤ catchBps ≤ 9000, 100 ≤ multiplierX100 ≤ 1000, 30 s ≤ cooldown ≤ 1 day
  * tier price changes limited to ±25% per call and one change per tier per 24 h (players can't be rugged by price spikes)
  * `buyRod(tier, maxPrice)` has slippage protection: reverts if the price > `maxPrice`
  * species sharePpm ≤ 50_000; maxSharePpm ≤ 100_000; rarity weights sum to 10_000; pityThreshold 2..20; baitBonusBps ≤ 2000
* Events for every state change and config change (the frontend indexes them).

---------------------------------------------------------------------------------------------------

## 8. Contract list

| File | Purpose |
|---|---|
| `contracts/RodNFT.sol` | ERC-721 rods + on-chain metadata |
| `contracts/FishingGame.sol` | shop, casting, loot, pity, junk, bait, repair; randomness consumer |
| `contracts/PrizeVault.sol` | prize pools, owed balances, claims, timelocked emergency withdraw |
| `contracts/RevenueRouter.sol` | revenue split, burn, recycling via swap adapters |
| `contracts/Tournament.sol` | weekly on-chain top-10 leaderboard + prizes |
| `contracts/randomness/ChainlinkVRFProvider.sol` | VRF v2.5 adapter |
| `contracts/randomness/MockRandomnessProvider.sol` | tests/local only |
| `contracts/swap/UniswapV3Adapter.sol` | SwapRouter02 exactInput adapter |
| `contracts/interfaces/*.sol` | IRandomnessProvider, IRandomnessConsumer, ISwapAdapter, IPrizeVault, ITournament, IClaimGate, IRodNFT |
| `contracts/mocks/*.sol` | MockGameToken (ERC20Burnable, 1B fixed supply), MockStockToken (18 dec, `multiplier()`), MockSwapAdapter (fixed-rate), MockVRFCoordinatorV2Plus, MockSwapRouter02 |

Solidity `0.8.28`, EVM `cancun`, OpenZeppelin `5.6.1`. Build: `npx hardhat compile` (uses the solcjs build from the
`solc` npm package; see hardhat.config.js). Tests: `npx hardhat test`.

---------------------------------------------------------------------------------------------------

## 9. Economy simulator (`sim/`)

Monte-Carlo in plain Node (ESM, no deps) that mirrors §1–§6 exactly (same bps/ppm integer math) and reports:
per-tier RTP and EV per $GAME, distribution of outcomes per rod (median/p10/p90 return), probability of ≥1 stock
catch per rod, pool equilibrium & turnover, time-to-equilibrium from seed, tournament concentration,
whale/sybil/bait/pity/repair strategy comparisons, and sensitivity to token price shocks. Writes
`docs/ECONOMY.md` and `config/game-params.json` (the params the deploy script uses).

---------------------------------------------------------------------------------------------------

## 10. Frontend (`app/`)

Vite + React + TypeScript + viem/wagmi. Robinhood Chain / testnet / local Hardhat chains. Screens: Lake (animated
cast → bite → reel reveal), Tackle Shop (3 rods), Tackle Box (my rods: durability, cooldown timers, repair),
Claims (owed balances with USD estimates from Chainlink feeds), Pools & Economy (live pool sizes, splits,
burns, recycle history), Leaderboard (season top-10 + countdown), Junkyard (collection + bait crafting).
**Demo mode**: when no deployment is configured, the whole game runs in-browser against a JS port of the
same rules (shared with the simulator) so it can be tried without a wallet.
