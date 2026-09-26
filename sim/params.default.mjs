/**
 * @file Default Stock Angler parameters: the tuned launch values validated by `sim/simulate.mjs`.
 *
 * `DEFAULT_GAME_CONFIG` has exactly the shape of `config/game-params.json` (the simulator regenerates that
 * file from this object), so the deploy script, the simulator and the browser demo all read the same numbers.
 * Convert it with `paramsFromConfig` from `./engine.mjs` before calling engine functions.
 *
 * Tuning rationale (details and simulated evidence in docs/ECONOMY.md):
 *   - Rod prices equalize value per $GAME (catch × multiplier × durability / price, after pity) with a mild
 *     upgrade incentive: Beginner 1.00 : Pro ≈1.02 : Master ≈1.07.
 *   - Stock shares are sized so each stock pool pays out its whole balance every ~2,500–3,500 casts of the
 *     expected player mix, and so a Master (5x) catch never exceeds `maxSharePpm` (Epic 20,000 ppm × 5 = cap).
 *   - Repairs restore casts 15% cheaper than a new rod, which is worth ~+9% over a full rod life: attractive,
 *     not dominant.
 */

const WEI_PER_TOKEN = 10n ** 18n;

/** @param {number} tokens whole $GAME */
const wei = (tokens) => (BigInt(tokens) * WEI_PER_TOKEN).toString();

/** @type {import('./engine.mjs').GameConfig} */
export const DEFAULT_GAME_CONFIG = Object.freeze({
  tiers: [
    { name: 'Bamboo Rod (Beginner)', priceWei: wei(100_000), durability: 30, catchBps: 4500, multiplierX100: 100, cooldown: 300 },
    { name: 'Carbon Rod (Pro)', priceWei: wei(390_000), durability: 40, catchBps: 5500, multiplierX100: 250, cooldown: 240 },
    { name: 'Golden Rod (Master)', priceWei: wei(1_100_000), durability: 50, catchBps: 6500, multiplierX100: 500, cooldown: 180 },
  ],
  species: [
    { name: 'Minnow', rarity: 0, rewardSymbol: 'GAME', sharePpm: 150, weight: 100, enabled: true, jackpot: false },
    { name: 'Sardine', rarity: 0, rewardSymbol: 'GAME', sharePpm: 150, weight: 100, enabled: true, jackpot: false },
    { name: 'Perch', rarity: 0, rewardSymbol: 'GAME', sharePpm: 150, weight: 100, enabled: true, jackpot: false },
    { name: 'Bass', rarity: 1, rewardSymbol: 'GAME', sharePpm: 600, weight: 100, enabled: true, jackpot: false },
    { name: 'Trout', rarity: 1, rewardSymbol: 'GAME', sharePpm: 600, weight: 100, enabled: true, jackpot: false },
    { name: 'Catfish', rarity: 1, rewardSymbol: 'GAME', sharePpm: 600, weight: 100, enabled: true, jackpot: false },
    { name: 'Apple Snapper', rarity: 2, rewardSymbol: 'AAPL', sharePpm: 10_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Microsoft Marlin', rarity: 2, rewardSymbol: 'MSFT', sharePpm: 10_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Amazon Amberjack', rarity: 2, rewardSymbol: 'AMZN', sharePpm: 10_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Google Grouper', rarity: 2, rewardSymbol: 'GOOGL', sharePpm: 10_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Meta Mackerel', rarity: 2, rewardSymbol: 'META', sharePpm: 10_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Nvidia Neon Shark', rarity: 3, rewardSymbol: 'NVDA', sharePpm: 20_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Tesla Thunder Eel', rarity: 3, rewardSymbol: 'TSLA', sharePpm: 20_000, weight: 100, enabled: true, jackpot: false },
    { name: 'Golden Bull', rarity: 4, rewardSymbol: '*', sharePpm: 10_000, weight: 100, enabled: true, jackpot: true },
  ],
  rarityWeights: [6200, 2500, 1000, 280, 20],
  split: { stockBps: 3000, baitVaultBps: 3500, burnBps: 1500, tournamentBps: 1000, treasuryBps: 1000 },
  loot: { baitBonusBps: 1000, maxCatchBps: 9500, pityThreshold: 5, baitJunkCost: 6, maxSharePpm: 100_000 },
  repair: { repairCostBps: 8500, repairWearBps: 2000, maxRepairs: 2 },
  tournament: { seasonLength: 7 * 24 * 3600, payoutBps: [3000, 2000, 1300, 1000, 800, 600, 500, 400, 200, 200] },
  staleCastTimeout: 24 * 3600,
  basketTargetWeightBps: { AAPL: 1200, MSFT: 1200, AMZN: 1200, GOOGL: 1200, META: 1200, NVDA: 2000, TSLA: 2000 },
});

/**
 * Market assumptions used by the simulator and the demo (not on-chain parameters).
 * Prices only set the unit conversion between $GAME and stock tokens; all economy metrics are measured in
 * $GAME-equivalent value, so their absolute level does not matter.
 */
export const DEFAULT_MARKET = Object.freeze({
  /** USD per $GAME at launch (a 1B-supply token at a $100k market cap). */
  gamePriceUsd: 0.0001,
  /** USD per stock token (illustrative round numbers). */
  stockPriceUsd: Object.freeze({ AAPL: 230, MSFT: 500, AMZN: 220, GOOGL: 250, META: 750, NVDA: 180, TSLA: 400 }),
  /** All-in cost of a $GAME → WETH → stock recycle: 1% pons pool fee + 0.3% stock pool fee + slippage. */
  swapCostBps: 150,
  /** How often the keeper recycles the router's stock budget. */
  keeperIntervalSec: 15 * 60,
});

/**
 * Recommended launch seeding (docs/ECONOMY.md "Launch seeding"): roughly the equilibrium pool sizes, so
 * the first anglers are paid like later ones. $GAME pool in whole $GAME; stock pools as $GAME-equivalent
 * value, split across tickers by `basketTargetWeightBps`.
 */
export const LAUNCH_SEED = Object.freeze({
  gamePool: 9_000_000,
  stockValueInGame: 8_000_000,
});
