const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, e18, RARITY } = require("./helpers/fixture");

const PPM = 1_000_000n;
const BPS = 10_000n;

describe("Smoke: end-to-end happy paths", function () {
  it("buy rod -> cast -> fulfill -> claim a $GAME fish", async function () {
    const { game, gameToken, vault, rodNFT, router, tournament, treasury, alice, buyRod, findWord, castAndFulfill, DEFAULTS } =
      await loadFixture(deployFixture);
    const price = DEFAULTS.tiers[0].price;
    const aliceBefore = await gameToken.balanceOf(alice.address);
    const poolBeforeBuy = await vault.poolAvailable(gameToken.target);
    const supplyBefore = await gameToken.totalSupply();

    const rodId = await buyRod(alice, 0);
    expect(await rodNFT.ownerOf(rodId)).to.equal(alice.address);
    expect(await gameToken.balanceOf(alice.address)).to.equal(aliceBefore - price);

    // Revenue split: 30% stock budget, 35% $GAME pool, 15% burn, 10% tournament, 10% treasury.
    expect(await router.stockBudget()).to.equal((price * 3000n) / BPS);
    expect(await vault.poolAvailable(gameToken.target)).to.equal(poolBeforeBuy + (price * 3500n) / BPS);
    expect(await gameToken.totalSupply()).to.equal(supplyBefore - (price * 1500n) / BPS);
    expect(await gameToken.balanceOf(tournament.target)).to.equal((price * 1000n) / BPS);
    expect(await gameToken.balanceOf(treasury.address)).to.equal((price * 1000n) / BPS);

    const { word, roll } = await findWord((r) => r.isFish && r.rarity === RARITY.COMMON);
    const pool = await vault.poolAvailable(gameToken.target);
    const res = await castAndFulfill(alice, rodId, word);

    expect(res.isFish).to.equal(true);
    expect(res.speciesId).to.equal(roll.speciesId);
    expect(res.score).to.equal(1);
    const expected = (pool * BigInt(roll.sharePpm)) / PPM;
    expect(roll.sharePpm).to.equal(150);
    expect(res.rewardTokens).to.deep.equal([gameToken.target]);
    expect(res.rewardAmounts).to.deep.equal([expected]);
    expect(await vault.owed(alice.address, gameToken.target)).to.equal(expected);

    const rod = await rodNFT.getRod(rodId);
    expect(rod.durability).to.equal(DEFAULTS.tiers[0].durability - 1);
    expect(rod.pendingCastId).to.equal(0n);
    const stats = await game.playerStats(alice.address);
    expect(stats.totalCasts).to.equal(1n);
    expect(stats.totalFish).to.equal(1n);

    const balance = await gameToken.balanceOf(alice.address);
    await expect(vault.connect(alice).claimAll())
      .to.emit(vault, "Claimed")
      .withArgs(alice.address, gameToken.target, expected);
    expect(await gameToken.balanceOf(alice.address)).to.equal(balance + expected);
    expect(await vault.totalOwed(gameToken.target)).to.equal(0n);
  });

  it("junk streak triggers pity, junk crafts into bait", async function () {
    const { game, alice, buyRod, findWord, castAndFulfill, waitCooldown, DEFAULTS } = await loadFixture(deployFixture);
    const rodId = await buyRod(alice, 0);
    const { word: junkWord, roll } = await findWord((r) => !r.isFish);
    expect(roll.speciesId).to.equal(DEFAULTS.NO_SPECIES);

    for (let i = 0; i < DEFAULTS.params.pityThreshold; i++) {
      await waitCooldown(rodId);
      const res = await castAndFulfill(alice, rodId, junkWord);
      expect(res.isFish).to.equal(false);
      expect(res.junkType).to.equal(roll.junkType);
      expect(res.rewardTokens).to.deep.equal([]);
    }
    let stats = await game.playerStats(alice.address);
    expect(stats.missStreak).to.equal(5n);
    expect(stats.junk).to.equal(5n);
    expect(stats.junkCaught[roll.junkType]).to.equal(5n);

    // Same junk word, but the 6th cast after 5 misses is a guaranteed catch.
    await waitCooldown(rodId);
    const pity = await castAndFulfill(alice, rodId, junkWord);
    expect(pity.isFish).to.equal(true);
    stats = await game.playerStats(alice.address);
    expect(stats.missStreak).to.equal(0n);

    await waitCooldown(rodId);
    await castAndFulfill(alice, rodId, junkWord);
    await expect(game.connect(alice).craftBait(1)).to.emit(game, "BaitCrafted").withArgs(alice.address, 1n, 6n);
    stats = await game.playerStats(alice.address);
    expect(stats.bait).to.equal(1n);
    expect(stats.junk).to.equal(0n);
  });

  it("recycles the stock budget ($GAME) and donated WETH into stock pools", async function () {
    const { gameToken, weth, stocks, vault, router, swapRouter, keeper, alice, bob, buyRod, encodePath, DEFAULTS } =
      await loadFixture(deployFixture);
    await buyRod(alice, 2);
    await buyRod(bob, 1);
    const budget = await router.stockBudget();
    expect(budget).to.equal(((DEFAULTS.tiers[2].price + DEFAULTS.tiers[1].price) * 3000n) / BPS);

    const aapl = stocks.AAPL;
    const path = encodePath([gameToken.target, weth.target, aapl.target], [10_000, 3_000]);
    const expectedOut = (budget * DEFAULTS.STOCK_RATE_E18) / e18(1);
    const aaplPool = await vault.poolAvailable(aapl.target);
    await expect(router.connect(keeper).recycle(gameToken.target, aapl.target, budget, expectedOut, path))
      .to.emit(router, "Recycled")
      .withArgs(keeper.address, gameToken.target, aapl.target, budget, expectedOut);
    expect(await router.stockBudget()).to.equal(0n);
    expect(await vault.poolAvailable(aapl.target)).to.equal(aaplPool + expectedOut);
    expect(await swapRouter.lastPath()).to.equal(path);

    // Donated WETH (e.g. pons creator fees) can be recycled too, after the minimum interval.
    await weth.mint(router.target, e18(2));
    const nvda = stocks.NVDA;
    const wethPath = encodePath([weth.target, nvda.target], [3_000]);
    await expect(
      router.connect(keeper).recycle(weth.target, nvda.target, e18(2), 1n, wethPath)
    ).to.be.revertedWithCustomError(router, "RecycleTooSoon");
    await time.increase(3600);
    const nvdaPool = await vault.poolAvailable(nvda.target);
    await router.connect(keeper).recycle(weth.target, nvda.target, e18(2), 1n, wethPath);
    expect(await vault.poolAvailable(nvda.target)).to.equal(nvdaPool + (e18(2) * DEFAULTS.STOCK_RATE_E18) / e18(1));
  });

  it("Golden Bull jackpot pays a share of every pool", async function () {
    const { game, vault, gameToken, alice, buyRod, findWord, castAndFulfill, DEFAULTS } =
      await loadFixture(deployFixture);
    const rodId = await buyRod(alice, 2);
    const { word, roll } = await findWord((r) => r.speciesId === 13, { tier: 2 });
    expect(roll.rarity).to.equal(RARITY.LEGENDARY);
    // 10_000 ppm x 5.0x = 50_000 ppm, exactly the maxSharePpm cap.
    expect(roll.sharePpm).to.equal(DEFAULTS.params.maxSharePpm);

    const [tokens, pools] = await vault.poolBalances();
    const res = await castAndFulfill(alice, rodId, word);
    expect(res.speciesId).to.equal(13);
    expect(res.score).to.equal(750);
    expect(res.rewardTokens).to.deep.equal([...tokens]);
    expect(res.jackpotPaid).to.have.length(tokens.length);
    tokens.forEach((token, i) => {
      const expected = (pools[i] * BigInt(roll.sharePpm)) / PPM;
      expect(res.rewardAmounts[i]).to.equal(expected);
      expect(res.jackpotPaid[i]).to.deep.equal({ token, amount: expected });
    });
    const [, owed] = await vault.owedBalances(alice.address);
    expect(owed).to.deep.equal(res.rewardAmounts);
    expect(await vault.owed(alice.address, gameToken.target)).to.equal(res.rewardAmounts[0]);
    console.log(`      jackpot fulfil gas (8 pools, MockRandomnessProvider): ${res.fulfillReceipt.gasUsed}`);
  });

  it("tournament: records scores, finalizes a season and pays winners", async function () {
    const { game, tournament, gameToken, alice, bob, buyRod, findWord, castAndFulfill, DEFAULTS } =
      await loadFixture(deployFixture);
    const aliceRod = await buyRod(alice, 1); // 2.5x
    const bobRod = await buyRod(bob, 0); // 1.0x
    const prize = ((DEFAULTS.tiers[1].price + DEFAULTS.tiers[0].price) * 1000n) / BPS;

    const rare = await findWord((r) => r.rarity === RARITY.RARE, { tier: 1 });
    const common = await findWord((r) => r.isFish && r.rarity === RARITY.COMMON, { tier: 0 });
    const a = await castAndFulfill(alice, aliceRod, rare.word);
    const b = await castAndFulfill(bob, bobRod, common.word);
    expect(a.score).to.equal(25); // 10 x 250 / 100
    expect(b.score).to.equal(1);

    const [season, , pool, players, scores] = await tournament.currentLeaderboard();
    expect(season).to.equal(0n);
    expect(pool).to.equal(prize);
    expect(players).to.deep.equal([alice.address, bob.address]);
    expect(scores).to.deep.equal([25n, 1n]);

    await expect(tournament.finalize(0)).to.be.revertedWithCustomError(tournament, "SeasonNotEnded");
    await time.increase(DEFAULTS.SEASON_LENGTH);
    const first = (prize * 3000n) / BPS;
    const second = (prize * 2000n) / BPS;
    await expect(tournament.finalize(0))
      .to.emit(tournament, "SeasonFinalized")
      .withArgs(0n, prize, first + second, prize - first - second, 1n);
    const [, , season1Pool] = await tournament.seasonInfo(1);
    expect(season1Pool).to.equal(prize - first - second);

    const before = await gameToken.balanceOf(alice.address);
    await tournament.connect(alice).claim(0);
    expect(await gameToken.balanceOf(alice.address)).to.equal(before + first);
    await tournament.connect(bob).claim(0);
    await expect(tournament.connect(bob).claim(0)).to.be.revertedWithCustomError(tournament, "NothingToClaim");
    expect(await game.castCount()).to.equal(2n);
  });

  it("serves casts through ChainlinkVRFProvider + VRF v2.5 coordinator", async function () {
    const { game, deployer, alice, buyRod, findWord, parseEvents, DEFAULTS } = await loadFixture(deployFixture);
    const coordinator = await ethers.deployContract("MockVRFCoordinatorV2Plus");
    const config = {
      keyHash: ethers.id("key-hash"),
      subscriptionId: 42n,
      requestConfirmations: 1,
      callbackGasLimit: 1_500_000,
      nativePayment: true,
    };
    const provider = await ethers.deployContract("ChainlinkVRFProvider", [deployer.address, coordinator.target, config]);
    await provider.setConsumer(game.target);
    await game.setRandomnessProvider(provider.target);

    const rodId = await buyRod(alice, 2);
    await game.connect(alice).cast(rodId, false);
    const request = await coordinator.getRequest(1);
    expect(request.sender).to.equal(provider.target);
    expect(request.subId).to.equal(42n);
    expect(request.numWords).to.equal(1n);
    // extraArgs = VRFV2PlusClient._argsToBytes(ExtraArgsV1{nativePayment: true})
    expect(request.extraArgs).to.equal("0x92fd1338" + ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]).slice(2));

    const { word } = await findWord((r) => r.speciesId === 13, { tier: 2 });
    const receipt = await (await coordinator.fulfillRandomWords(1, [word])).wait();
    const [fulfilled] = parseEvents(coordinator, receipt, "RandomWordsFulfilled");
    expect(fulfilled.args.success).to.equal(true);
    const [resolved] = parseEvents(game, receipt, "CastResolved");
    expect(resolved.args.speciesId).to.equal(13n);
    expect(receipt.gasUsed).to.be.lessThan(BigInt(config.callbackGasLimit));
    console.log(`      jackpot fulfil gas via VRF coordinator: ${receipt.gasUsed}`);
    expect((await game.getCast(1)).status).to.equal(2n); // Resolved
    expect(DEFAULTS.species[13].jackpot).to.equal(true);
  });

  it("rod tokenURI is on-chain base64 JSON with an SVG image", async function () {
    const { rodNFT, alice, buyRod } = await loadFixture(deployFixture);
    const rodId = await buyRod(alice, 2);
    const uri = await rodNFT.tokenURI(rodId);
    expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    expect(json.name).to.equal(`Golden Rod #${rodId}`);
    const svg = Buffer.from(json.image.split(",")[1], "base64").toString("utf8");
    expect(svg).to.contain("<svg").and.to.contain("Durability 50/50");
    expect(json.attributes.find((t) => t.trait_type === "Status").value).to.equal("Ready");
  });
});
