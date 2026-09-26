/**
 * Shared Hardhat fixture: deploys the whole Stock Angler system against mocks, wires every role and configures
 * SPEC defaults. Use it with `loadFixture` so each test starts from the same snapshot:
 *
 *   const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
 *   const { deployFixture } = require("./helpers/fixture");
 *   const f = await loadFixture(deployFixture);
 *
 * For a variant, define the fixture function once at module scope (loadFixture keys snapshots by function identity):
 *   const noBurnFixture = () => deploySystem({ burnableGameToken: false });
 *
 * Returned object (flat; every contract is an ethers v6 Contract connected to `deployer`):
 *
 *   Signers
 *     deployer                 DEFAULT_ADMIN_ROLE everywhere + CONFIG_ROLE/PAUSER_ROLE on game, CONFIG_ROLE on router,
 *                              owner of the mock randomness provider. Holds the remaining $GAME supply.
 *     treasury                 RevenueRouter treasury.
 *     keeper                   RevenueRouter KEEPER_ROLE.
 *     alice, bob, carol, dave  Players: PLAYER_GAME (20M $GAME) each, max-approved to `game`.
 *     others                   Remaining signers (no balances).
 *
 *   Contracts
 *     gameToken     MockGameToken (ERC20Burnable, 1B supply) — or MockGameTokenNoBurn with { burnableGameToken:false }.
 *     stocks        { AAPL, MSFT, AMZN, GOOGL, META, NVDA, TSLA } -> MockStockToken.
 *     stockTokens   Same 7 contracts as an array in registration order (AAPL..TSLA).
 *     weth          MockStockToken named "Wrapped Ether" (allowed recycle input on the router).
 *     vault         PrizeVault. Registered tokens, in order: [$GAME, AAPL, MSFT, AMZN, GOOGL, META, NVDA, TSLA].
 *                   Seeded: GAME_POOL_SEED $GAME and STOCK_POOL_SEED of each stock.
 *     rodNFT        RodNFT.
 *     randomness    MockRandomnessProvider (consumer = game).
 *     tournament    Tournament (genesis = deploy time, 7-day seasons).
 *     router        RevenueRouter (SPEC split; swap adapter = uniAdapter; maxRecycleIn: $GAME 5M, WETH 100;
 *                   minRecycleInterval 1 h).
 *     game          FishingGame (3 tiers + 14 species configured with SPEC defaults).
 *     swapRouter    MockSwapRouter02 (rate STOCK_RATE_E18 for every stock; pre-funded with SWAP_LIQUIDITY of each).
 *     uniAdapter    UniswapV3Adapter over swapRouter (the router's active adapter).
 *     mockAdapter   MockSwapAdapter (same rates and liquidity; not active — `router.setSwapAdapter` to use it).
 *
 *   DEFAULTS  { tiers, species, split, rarityWeights, params, rarityNames, junkNames, stockSymbols,
 *               GAME_POOL_SEED, STOCK_POOL_SEED, PLAYER_GAME, SWAP_LIQUIDITY, STOCK_RATE_E18, SEASON_LENGTH,
 *               NO_SPECIES }
 *             tiers[i] = { name, price, durability, catchBps, multiplierX100, cooldown } (price in wei)
 *             species[i] = { name, rarity, rewardToken, sharePpm, weight, enabled, jackpot } (resolved addresses)
 *
 *   Helpers
 *     castAndFulfill(player, rodId, word, useBait = false) -> Promise<CastOutcome>
 *         Casts `rodId` as `player`, delivers `word` through MockRandomnessProvider.fulfill and returns the parsed
 *         CastResolved event:
 *           { castId, requestId, rodId, randomWord: bigint; player: string; tier, speciesId, rarity, junkType,
 *             score: number; isFish: boolean; rewardTokens: string[]; rewardAmounts: bigint[];
 *             jackpotPaid: { token: string, amount: bigint }[]; event: ethers.LogDescription;
 *             castReceipt, fulfillReceipt: ethers.TransactionReceipt }
 *         For junk `speciesId === DEFAULTS.NO_SPECIES` and reward arrays are empty. It does not advance time: call
 *         waitCooldown(rodId) between casts of the same rod.
 *     buyRod(player, tier) -> Promise<bigint>            Buys a rod at the current price, returns its id.
 *     waitCooldown(rodId) -> Promise<void>               Advances time to the rod's cooldown end (no-op if ready).
 *     subRoll(word, i) -> bigint                         r_i = uint256(keccak256(abi.encode(word, i))).
 *     findWord(predicate, opts?) -> Promise<{ word: bigint, roll }>
 *         Searches deterministic candidate words with `game.previewRoll(word, tier, baitUsed, missStreak)` until
 *         `predicate(roll)` is true. roll = { isFish, rarity, speciesId, junkType, catchBps, sharePpm, score }
 *         (numbers/booleans). opts = { tier = 0, baitUsed = false, missStreak = 0, salt = "word", maxTries = 50000 }.
 *     encodePath(tokens, fees) -> string                 Packed Uniswap V3 path (address, uint24, address, ...).
 *     parseEvents(contract, receipt, name) -> LogDescription[]   Events `name` emitted by `contract` in `receipt`.
 */
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const e18 = (n) => ethers.parseEther(String(n));

const STOCK_SYMBOLS = ["AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA"];
const STOCK_NAMES = {
  AAPL: "Apple Stock Token",
  MSFT: "Microsoft Stock Token",
  AMZN: "Amazon Stock Token",
  GOOGL: "Alphabet Stock Token",
  META: "Meta Stock Token",
  NVDA: "NVIDIA Stock Token",
  TSLA: "Tesla Stock Token",
};

const RARITY = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4 };
const NO_SPECIES = 65535;
const SPECIES_WEIGHT = 100;

const TIERS = [
  { name: "Bamboo Rod", price: e18(100_000), durability: 30, catchBps: 4500, multiplierX100: 100, cooldown: 300 },
  { name: "Carbon Rod", price: e18(400_000), durability: 40, catchBps: 5500, multiplierX100: 250, cooldown: 240 },
  { name: "Golden Rod", price: e18(1_100_000), durability: 50, catchBps: 6500, multiplierX100: 500, cooldown: 180 },
];

// [name, rarity, reward ("GAME" | stock symbol | null for jackpot), sharePpm]
const SPECIES_TABLE = [
  ["Minnow", RARITY.COMMON, "GAME", 150],
  ["Sardine", RARITY.COMMON, "GAME", 150],
  ["Perch", RARITY.COMMON, "GAME", 150],
  ["Bass", RARITY.UNCOMMON, "GAME", 600],
  ["Trout", RARITY.UNCOMMON, "GAME", 600],
  ["Catfish", RARITY.UNCOMMON, "GAME", 600],
  ["Apple Snapper", RARITY.RARE, "AAPL", 4000],
  ["Microsoft Marlin", RARITY.RARE, "MSFT", 4000],
  ["Amazon Amberjack", RARITY.RARE, "AMZN", 4000],
  ["Google Grouper", RARITY.RARE, "GOOGL", 4000],
  ["Meta Mackerel", RARITY.RARE, "META", 4000],
  ["Nvidia Neon Shark", RARITY.EPIC, "NVDA", 12000],
  ["Tesla Thunder Eel", RARITY.EPIC, "TSLA", 12000],
  ["Golden Bull", RARITY.LEGENDARY, null, 10000],
];

const SPLIT = { stockBps: 3000, vaultBps: 3500, burnBps: 1500, tournamentBps: 1000, treasuryBps: 1000 };
const RARITY_WEIGHTS = [6200, 2500, 1000, 280, 20];
const PARAMS = {
  baitBonusBps: 1000,
  maxCatchBps: 9500,
  pityThreshold: 5,
  maxSharePpm: 50_000,
  baitJunkCost: 6,
  staleCastTimeout: 86_400,
  repairCostBps: 7500,
  repairWearBps: 2000,
  maxRepairs: 2,
};

const GAME_POOL_SEED = e18(10_000_000);
const STOCK_POOL_SEED = e18(1_000);
const PLAYER_GAME = e18(20_000_000);
const SWAP_LIQUIDITY = e18(1_000_000);
const STOCK_RATE_E18 = 10n ** 13n; // 1 input token -> 0.00001 stock token
const SEASON_LENGTH = 7 * 24 * 60 * 60;

/** Events `name` emitted by `contract` in `receipt`, parsed with the contract's interface. */
function parseEvents(contract, receipt, name) {
  const address = contract.target.toLowerCase();
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    const parsed = contract.interface.parseLog(log);
    if (parsed && parsed.name === name) out.push(parsed);
  }
  return out;
}

/** r_i = uint256(keccak256(abi.encode(word, i))) — SPEC §2.1. */
function subRoll(word, i) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [word, i]);
  return BigInt(ethers.keccak256(encoded));
}

/** Packed Uniswap V3 path: token0, fee0, token1, fee1, ..., tokenN. */
function encodePath(tokens, fees) {
  if (tokens.length !== fees.length + 1) throw new Error("encodePath: tokens.length must be fees.length + 1");
  const types = [];
  const values = [];
  tokens.forEach((token, i) => {
    types.push("address");
    values.push(token);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  });
  return ethers.solidityPacked(types, values);
}

/**
 * Deploys and wires the full system.
 * @param {{ burnableGameToken?: boolean }} [options]
 */
async function deploySystem({ burnableGameToken = true } = {}) {
  const signers = await ethers.getSigners();
  const [deployer, treasury, keeper, alice, bob, carol, dave, ...others] = signers;
  const players = [alice, bob, carol, dave];

  // --- Tokens -------------------------------------------------------------------------------------------------
  const gameToken = await ethers.deployContract(burnableGameToken ? "MockGameToken" : "MockGameTokenNoBurn");
  const stocks = {};
  const stockTokens = [];
  for (const symbol of STOCK_SYMBOLS) {
    const token = await ethers.deployContract("MockStockToken", [STOCK_NAMES[symbol], symbol]);
    stocks[symbol] = token;
    stockTokens.push(token);
  }
  const weth = await ethers.deployContract("MockStockToken", ["Wrapped Ether", "WETH"]);

  // --- Core -----------------------------------------------------------------------------------------------------
  const vault = await ethers.deployContract("PrizeVault", [deployer.address]);
  const rodNFT = await ethers.deployContract("RodNFT", [deployer.address]);
  const randomness = await ethers.deployContract("MockRandomnessProvider");
  const tournament = await ethers.deployContract("Tournament", [deployer.address, gameToken.target, 0, SEASON_LENGTH]);
  const router = await ethers.deployContract("RevenueRouter", [
    deployer.address,
    gameToken.target,
    vault.target,
    tournament.target,
    treasury.address,
  ]);
  const game = await ethers.deployContract("FishingGame", [
    deployer.address,
    gameToken.target,
    rodNFT.target,
    vault.target,
    router.target,
    randomness.target,
    tournament.target,
  ]);

  // --- Swap venues ----------------------------------------------------------------------------------------------
  const swapRouter = await ethers.deployContract("MockSwapRouter02");
  const uniAdapter = await ethers.deployContract("UniswapV3Adapter", [swapRouter.target]);
  const mockAdapter = await ethers.deployContract("MockSwapAdapter");
  for (const token of stockTokens) {
    await token.mint(swapRouter.target, SWAP_LIQUIDITY);
    await token.mint(mockAdapter.target, SWAP_LIQUIDITY);
    await swapRouter.setRate(token.target, STOCK_RATE_E18);
    await mockAdapter.setRate(token.target, STOCK_RATE_E18);
  }

  // --- Roles ----------------------------------------------------------------------------------------------------
  const GAME_ROLE = await rodNFT.GAME_ROLE();
  await rodNFT.grantRole(GAME_ROLE, game.target);
  await vault.grantRole(GAME_ROLE, game.target);
  await tournament.grantRole(GAME_ROLE, game.target);
  await router.grantRole(GAME_ROLE, game.target);
  await router.grantRole(await router.KEEPER_ROLE(), keeper.address);
  await router.grantRole(await router.CONFIG_ROLE(), deployer.address);
  await game.grantRole(await game.CONFIG_ROLE(), deployer.address);
  await game.grantRole(await game.PAUSER_ROLE(), deployer.address);
  await randomness.setConsumer(game.target);

  // --- Vault tokens & seeding -----------------------------------------------------------------------------------
  await vault.registerToken(gameToken.target);
  for (const token of stockTokens) await vault.registerToken(token.target);

  await gameToken.approve(vault.target, GAME_POOL_SEED);
  await vault.fund(gameToken.target, GAME_POOL_SEED);
  for (const token of stockTokens) {
    await token.mint(deployer.address, STOCK_POOL_SEED);
    await token.approve(vault.target, STOCK_POOL_SEED);
    await vault.fund(token.target, STOCK_POOL_SEED);
  }

  // --- Router config --------------------------------------------------------------------------------------------
  await router.setSplit(SPLIT);
  await router.setSwapAdapter(uniAdapter.target);
  await router.setRecycleInput(weth.target, true);
  await router.setMaxRecycleIn(gameToken.target, e18(5_000_000));
  await router.setMaxRecycleIn(weth.target, e18(100));

  // --- Game config ----------------------------------------------------------------------------------------------
  for (let i = 0; i < TIERS.length; i++) {
    const { price, durability, catchBps, multiplierX100, cooldown } = TIERS[i];
    await game.configureTier(i, { price, durability, catchBps, multiplierX100, cooldown });
  }
  await game.setRarityWeights(RARITY_WEIGHTS);
  await game.setParams(PARAMS);
  const species = SPECIES_TABLE.map(([name, rarity, reward, sharePpm]) => ({
    name,
    rarity,
    rewardToken: reward === null ? ethers.ZeroAddress : reward === "GAME" ? gameToken.target : stocks[reward].target,
    sharePpm,
    weight: SPECIES_WEIGHT,
    enabled: true,
    jackpot: reward === null,
  }));
  for (const s of species) await game.addSpecies(s);

  // --- Players --------------------------------------------------------------------------------------------------
  for (const player of players) {
    await gameToken.transfer(player.address, PLAYER_GAME);
    await gameToken.connect(player).approve(game.target, ethers.MaxUint256);
  }

  // --- Helpers --------------------------------------------------------------------------------------------------
  async function castAndFulfill(player, rodId, word, useBait = false) {
    const castReceipt = await (await game.connect(player).cast(rodId, useBait)).wait();
    const [started] = parseEvents(game, castReceipt, "CastStarted");
    const { castId, requestId } = started.args;
    const fulfillReceipt = await (await randomness.fulfill(requestId, word)).wait();
    const [event] = parseEvents(game, fulfillReceipt, "CastResolved");
    if (!event) throw new Error(`castAndFulfill: cast ${castId} did not resolve`);
    const a = event.args;
    return {
      castId,
      requestId,
      player: a.player,
      rodId: a.rodId,
      tier: Number(a.tier),
      isFish: a.isFish,
      speciesId: Number(a.speciesId),
      rarity: Number(a.rarity),
      junkType: Number(a.junkType),
      rewardTokens: [...a.rewardTokens],
      rewardAmounts: [...a.rewardAmounts],
      score: Number(a.score),
      randomWord: a.randomWord,
      jackpotPaid: parseEvents(game, fulfillReceipt, "JackpotPaid").map((j) => ({
        token: j.args.token,
        amount: j.args.amount,
      })),
      event,
      castReceipt,
      fulfillReceipt,
    };
  }

  async function buyRod(player, tier) {
    const t = await game.getTier(tier);
    const receipt = await (await game.connect(player).buyRod(tier, t.price)).wait();
    const [purchased] = parseEvents(game, receipt, "RodPurchased");
    return purchased.args.rodId;
  }

  async function waitCooldown(rodId) {
    const readyAt = await game.cooldownEndsAt(rodId);
    if (readyAt > BigInt(await time.latest())) await time.increaseTo(readyAt);
  }

  async function findWord(predicate, { tier = 0, baitUsed = false, missStreak = 0, salt = "word", maxTries = 50_000 } = {}) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const batch = 250;
    for (let start = 0; start < maxTries; start += batch) {
      const words = [];
      for (let n = start; n < Math.min(start + batch, maxTries); n++) {
        words.push(BigInt(ethers.keccak256(coder.encode(["string", "uint256"], [salt, n]))));
      }
      const rolls = await Promise.all(words.map((w) => game.previewRoll(w, tier, baitUsed, missStreak)));
      for (let i = 0; i < words.length; i++) {
        const r = rolls[i];
        const roll = {
          isFish: r.isFish,
          rarity: Number(r.rarity),
          speciesId: Number(r.speciesId),
          junkType: Number(r.junkType),
          catchBps: Number(r.catchBps),
          sharePpm: Number(r.sharePpm),
          score: Number(r.score),
        };
        if (predicate(roll)) return { word: words[i], roll };
      }
    }
    throw new Error(`findWord: no matching word in ${maxTries} tries`);
  }

  const DEFAULTS = {
    tiers: TIERS,
    species,
    split: SPLIT,
    rarityWeights: RARITY_WEIGHTS,
    params: PARAMS,
    rarityNames: ["Common", "Uncommon", "Rare", "Epic", "Legendary"],
    junkNames: ["Worn Boot", "Tin Can", "Seaweed", "Old Tire", "Message in a Bottle"],
    stockSymbols: STOCK_SYMBOLS,
    GAME_POOL_SEED,
    STOCK_POOL_SEED,
    PLAYER_GAME,
    SWAP_LIQUIDITY,
    STOCK_RATE_E18,
    SEASON_LENGTH,
    NO_SPECIES,
  };

  return {
    deployer,
    treasury,
    keeper,
    alice,
    bob,
    carol,
    dave,
    others,
    gameToken,
    stocks,
    stockTokens,
    weth,
    vault,
    rodNFT,
    randomness,
    tournament,
    router,
    game,
    swapRouter,
    uniAdapter,
    mockAdapter,
    DEFAULTS,
    castAndFulfill,
    buyRod,
    waitCooldown,
    subRoll,
    findWord,
    encodePath,
    parseEvents,
  };
}

/** Default fixture for `loadFixture`. */
async function deployFixture() {
  return deploySystem();
}

module.exports = { deployFixture, deploySystem, subRoll, encodePath, parseEvents, e18, RARITY, NO_SPECIES };
