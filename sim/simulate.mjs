#!/usr/bin/env node
/**
 * @file Stock Angler economy simulator (docs/SPEC.md §9).
 *
 * An event-driven Monte-Carlo of a player population over several tournament seasons. Every cast, rod
 * purchase, repair, bait craft, revenue split and tournament payout goes through the shared rules engine
 * (`./engine.mjs`) with the same integer math as the contracts; only the random words come from a fast
 * seeded PRNG instead of keccak(VRF word). Around the rules it models the off-chain world: player sessions
 * and cooldowns, the keeper recycling the router's stock budget into a stock basket through a lossy swap,
 * and $GAME price shocks that change the $GAME → stock conversion rate.
 *
 * Usage:  node sim/simulate.mjs [--seed N] [--days N] [--scale X] [--quick] [--no-write]
 *   --seed N     PRNG seed (default 4663, the Robinhood Chain id)
 *   --days N     simulated days per main scenario (default 56 = 8 tournament seasons)
 *   --scale X    population multiplier (default 1)
 *   --quick      21 days at 0.4x population, for fast iteration; never writes files
 *   --no-write   print the report without updating docs/ECONOMY.md, config/game-params.json, sim/out/
 *
 * Value is always measured in $GAME-equivalent at the conversion rate in force when a prize is paid.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BPS,
  GAME_SYMBOL,
  RARITY_NAMES,
  assertValidParams,
  beginCast,
  buyRod,
  catchOdds,
  craftBait,
  effectiveCatchBps,
  effectiveSharePpm,
  expectedPoolShares,
  newPlayer,
  newPools,
  paramsFromConfig,
  paramsToConfig,
  repairRod,
  resolveCast,
  seasonAt,
  seasonPayouts,
  settleRod,
  splitRevenue,
  updateTopScores,
  validateParams,
} from './engine.mjs';
import { DEFAULT_GAME_CONFIG, DEFAULT_MARKET, LAUNCH_SEED } from './params.default.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400;
const HOUR = 3_600;
const WEI = 1e18;
/** Simulation clock origin (unix seconds). Any realistic timestamp works; rods start with lastCastAt = 0. */
const EPOCH = 1_790_000_000;
/** How often the world is observed (EV index EMA for timing bots, pool samples every 4th tick). */
const OBSERVE_INTERVAL = 15 * 60;
/** Half-life of the EV-index moving average that timing bots compare against. */
const EV_EMA_HALF_LIFE = 12 * HOUR;
/** Players join uniformly over the first days (a launch ramp instead of everyone buying rods at once). */
const JOIN_RAMP_DAYS = 3;
/** Steady-state metrics (per-tier, strategies, rods, tournament) only count from this day on. */
const WARMUP_DAYS = 7;
/** Cumulative cast counts at which launch-phase RTP is recorded. */
const CAST_CHECKPOINTS = [1_000, 5_000, 10_000, 50_000, 100_000];
const RESULTS_BEGIN = '<!-- sim:results:begin -->';
const RESULTS_END = '<!-- sim:results:end -->';

// ============================================================================================ population

/**
 * @typedef {Object} GroupSpec
 * @property {string} group          group name used in reports
 * @property {number} count          agents (entities) in the group
 * @property {number[]} rods         tier id of each rod slot the agent keeps stocked
 * @property {number} sessions       play sessions per day
 * @property {number} sessionMinutes mean session length (actual length is uniform 0.5x..1.5x)
 * @property {number} bait           probability an agent crafts and uses bait
 * @property {number} repair         probability an agent repairs broken rods instead of buying new ones
 * @property {'normal'|'pitySwitch'|'timing'} [policy]
 * @property {number} [wallets]      wallets per entity; rods are dealt round-robin (sybil test)
 * @property {number} [timingThreshold] timing bots cast only when EV index >= threshold × its 12 h EMA
 * @property {string} [baseline]     group this strategy probe is compared against
 * @property {string} description
 */

/** @type {GroupSpec[]} */
const POPULATION = [
  // Main population: drives the pools. Mixed habits.
  { group: 'casual', count: 800, rods: [0, 0], sessions: 1, sessionMinutes: 40, bait: 0.5, repair: 0.3, description: 'Beginner rods, one short session a day' },
  { group: 'regular', count: 300, rods: [1, 1], sessions: 1, sessionMinutes: 60, bait: 0.5, repair: 0.5, description: 'Pro rods, one session a day' },
  { group: 'enthusiast', count: 100, rods: [2, 2], sessions: 1, sessionMinutes: 60, bait: 0.6, repair: 0.6, description: 'Master rods, one session a day' },
  { group: 'whale', count: 20, rods: [2, 2, 2, 2, 2, 2], sessions: 2, sessionMinutes: 120, bait: 1, repair: 1, description: 'six Master rods, two long sessions a day' },
  // Strategy probes: small cohorts that differ from a plain player in exactly one habit.
  { group: 'always-beginner', count: 60, rods: [0, 0], sessions: 1, sessionMinutes: 40, bait: 0, repair: 0, description: 'plain Beginner player (no bait, never repairs)' },
  { group: 'always-pro', count: 40, rods: [1, 1], sessions: 1, sessionMinutes: 60, bait: 0, repair: 0, description: 'plain Pro player' },
  { group: 'always-master', count: 40, rods: [2, 2], sessions: 1, sessionMinutes: 60, bait: 0, repair: 0, description: 'plain Master player' },
  { group: 'bait-beginner', count: 60, rods: [0, 0], sessions: 1, sessionMinutes: 40, bait: 1, repair: 0, baseline: 'always-beginner', description: 'crafts bait from junk and always uses it' },
  { group: 'bait-master', count: 40, rods: [2, 2], sessions: 1, sessionMinutes: 60, bait: 1, repair: 0, baseline: 'always-master', description: 'bait on a Master rod' },
  { group: 'repair-beginner', count: 60, rods: [0, 0], sessions: 1, sessionMinutes: 40, bait: 0, repair: 1, baseline: 'always-beginner', description: 'repairs twice before buying a new rod' },
  { group: 'repair-master', count: 40, rods: [2, 2], sessions: 1, sessionMinutes: 60, bait: 0, repair: 1, baseline: 'always-master', description: 'repairs Master rods twice' },
  { group: 'pity-switch', count: 40, rods: [0, 0, 2], sessions: 1, sessionMinutes: 60, bait: 0, repair: 0, policy: 'pitySwitch', baseline: 'tier-mix', description: 'fishes Beginner rods and casts the Master rod only when pity guarantees a catch' },
  { group: 'timing-master', count: 6, rods: [2, 2], sessions: 1, sessionMinutes: 0, bait: 0, repair: 0, policy: 'timing', timingThreshold: 1.05, baseline: 'always-master', description: 'bot online 24/7, casts Master rods only when pools are >= 5% fatter than their 12 h average' },
  { group: 'whale-single', count: 4, rods: Array(10).fill(2), sessions: 2, sessionMinutes: 120, bait: 1, repair: 1, wallets: 1, description: 'whale with 10 Master rods in one wallet' },
  { group: 'whale-sybil', count: 4, rods: Array(10).fill(2), sessions: 2, sessionMinutes: 120, bait: 1, repair: 1, wallets: 5, baseline: 'whale-single', description: 'same whale split across 5 wallets' },
];

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} title
 * @property {number} days
 * @property {boolean} seeded                 pools start at LAUNCH_SEED (else empty)
 * @property {{day: number, factor: number}} [shock]  $GAME price multiplied by `factor` at `day`
 * @property {number} [keeperIntervalSec]     overrides the market keeper interval
 */

/**
 * @param {number} days
 * @returns {Scenario[]}
 */
function buildScenarios(days) {
  const shockDay = Math.floor(days / 2);
  return [
    { id: 'baseline', title: 'Constant prices', days, seeded: true },
    { id: 'crash', title: `$GAME -60% on day ${shockDay}`, days, seeded: true, shock: { day: shockDay, factor: 0.4 } },
    { id: 'pump', title: `$GAME +200% on day ${shockDay}`, days, seeded: true, shock: { day: shockDay, factor: 3 } },
    { id: 'unseeded', title: 'Unseeded launch (empty pools)', days: Math.min(days, 14), seeded: false },
    { id: 'keeperDaily', title: 'Keeper recycles once a day', days: Math.min(days, 28), seeded: true, keeperIntervalSec: DAY },
  ];
}

// ============================================================================================ utilities

/** sfc32 PRNG seeded through splitmix32; `stream` gives independent sequences for the same seed. */
class Rng {
  /**
   * @param {number} seed
   * @param {number} stream
   */
  constructor(seed, stream) {
    let s = (seed ^ Math.imul(stream + 1, 0x632be5ab)) >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 16; i++) this.u32();
  }

  /** @returns {number} uniform uint32 */
  u32() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** @returns {number} uniform in [0, 1) */
  float() {
    return this.u32() / 4_294_967_296;
  }

  /**
   * @param {number} lo
   * @param {number} hi
   * @returns {number} uniform in [lo, hi)
   */
  between(lo, hi) {
    return lo + (hi - lo) * this.float();
  }
}

/** Binary min-heap of events ordered by (time, insertion order). */
class EventQueue {
  constructor() {
    /** @type {{time: number, seq: number}[]} */
    this.heap = [];
    this.seq = 0;
  }

  get size() {
    return this.heap.length;
  }

  /** @param {{time: number}} event */
  push(event) {
    event.seq = this.seq++;
    const h = this.heap;
    h.push(event);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i], h[parent])) break;
      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }

  /** @returns {any} the earliest event */
  pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l], h[m])) m = l;
        if (r < h.length && before(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  /** @returns {number} time of the earliest event */
  peekTime() {
    return this.heap[0].time;
  }
}

function before(a, b) {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

function newTally() {
  return { casts: 0, cost: 0, ev: 0, realized: 0, catches: 0, stockCatches: 0, jackpots: 0 };
}

function addTally(into, from) {
  for (const key of Object.keys(into)) into[key] += from[key];
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values) {
  return values.length === 0 ? NaN : values.reduce((a, v) => a + v, 0) / values.length;
}

function gini(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const total = v.reduce((a, x) => a + x, 0);
  if (n === 0 || total === 0) return 0;
  let weighted = 0;
  v.forEach((x, i) => {
    weighted += (i + 1) * x;
  });
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

// ============================================================================================ simulation

/**
 * One run of the population model under a scenario.
 */
class Simulation {
  /**
   * @param {{params: import('./engine.mjs').Params, market: typeof DEFAULT_MARKET, scenario: Scenario, seed: number, scale: number, population?: GroupSpec[]}} options
   */
  constructor({ params, market, scenario, seed, scale, population = POPULATION }) {
    this.params = params;
    this.scenario = scenario;
    this.gamePriceUsd = market.gamePriceUsd;
    this.stockPriceUsd = { ...market.stockPriceUsd };
    this.swapCostBps = market.swapCostBps;
    this.keeperIntervalSec = scenario.keeperIntervalSec ?? market.keeperIntervalSec;
    this.castRng = new Rng(seed, 1);
    this.behaviorRng = new Rng(seed, 2);
    this.queue = new EventQueue();
    this.now = EPOCH;
    this.endTime = EPOCH + scenario.days * DAY;
    this.measureFrom = EPOCH + Math.min(WARMUP_DAYS, scenario.days / 2) * DAY;
    this.firstMeasuredSeason = Math.ceil((this.measureFrom - EPOCH) / params.tournament.seasonLength);

    this.symbols = params.rewardTokens;
    this.stocks = this.symbols.filter((s) => s !== GAME_SYMBOL);
    this.symbolIndex = Object.fromEntries(this.symbols.map((s, i) => [s, i]));
    this.jackpotIds = new Set(params.species.flatMap((s, id) => (s.jackpot ? [id] : [])));
    this.stockSpeciesIds = new Set(params.species.flatMap((s, id) => (s.rewardSymbol !== GAME_SYMBOL ? [id] : [])));
    /** Expected fraction of each pool paid per *catch*, per tier, aligned with `symbols`. */
    this.coefPerCatch = params.tiers.map((_, t) => {
      const shares = expectedPoolShares(params, t, BPS);
      return this.symbols.map((s) => shares[s]);
    });
    this.plainCostPerCast = params.tiers.map((t) => Number(t.price) / WEI / t.durability);
    this.updateRates();

    this.pools = newPools(params, scenario.seeded ? this.launchFunding() : {});
    this.seedValue = this.poolValues().reduce((a, v) => a + v, 0);
    this.stockBudget = 0n;
    this.flows = { spent: 0, stock: 0, baitVault: 0, burn: 0, tournament: 0, treasury: 0, recycled: 0, swapLoss: 0, tournamentPaid: 0 };

    this.seasons = new Map();
    this.seasonStats = [];
    this.walletById = new Map();
    this.groups = new Map();
    this.agents = [];
    this.buildPopulation(population, scale);

    this.totalCasts = 0;
    this.daily = Array.from({ length: scenario.days + 1 }, () => ({ casts: 0, cost: 0, ev: 0, realized: 0 }));
    this.paidUnits = this.symbols.map(() => new Float64Array(scenario.days + 1));
    this.samples = [];
    this.checkpoints = [];
    this.jackpots = [];
    this.lives = params.tiers.map(() => ({ plain: [], plainStock: 0, baited: [], baitedStock: 0 }));
    this.evEma = this.masterEvIndex();
    this.observations = 0;
  }

  // ------------------------------------------------------------------------------------------ setup

  /** Converts LAUNCH_SEED into wei per pool at the launch conversion rate. */
  launchFunding() {
    const funding = { [GAME_SYMBOL]: BigInt(LAUNCH_SEED.gamePool) * 10n ** 18n };
    for (const ticker of this.stocks) {
      const valueInGame = (LAUNCH_SEED.stockValueInGame * (this.params.basketTargetWeightBps[ticker] ?? 0)) / BPS;
      funding[ticker] = BigInt(Math.round((valueInGame / (this.stockPriceUsd[ticker] / this.gamePriceUsd)) * WEI));
    }
    return funding;
  }

  /**
   * @param {GroupSpec[]} population
   * @param {number} scale
   */
  buildPopulation(population, scale) {
    const rng = this.behaviorRng;
    for (const spec of population) {
      const group = {
        spec,
        agents: 0,
        wallets: 0,
        spent: 0,
        total: newTally(),
        byTier: this.params.tiers.map(() => newTally()),
        tournament: 0,
        tournamentPrizes: 0,
      };
      this.groups.set(spec.group, group);
      const count = Math.max(1, Math.round(spec.count * scale));
      for (let n = 0; n < count; n++) {
        const walletCount = spec.wallets ?? 1;
        const wallets = [];
        for (let w = 0; w < walletCount; w++) {
          const wallet = { id: `${spec.group}#${n}.${w}`, group, player: newPlayer() };
          this.walletById.set(wallet.id, wallet);
          wallets.push(wallet);
        }
        const agent = {
          group,
          policy: spec.policy ?? 'normal',
          useBait: rng.float() < spec.bait,
          repairs: rng.float() < spec.repair,
          timingThreshold: spec.timingThreshold ?? 0,
          joinTime: EPOCH + rng.between(0, JOIN_RAMP_DAYS) * DAY,
          sessionEnd: spec.policy === 'timing' ? Infinity : 0,
          slots: spec.rods.map((tierId, i) => ({
            tierId,
            wallet: wallets[i % walletCount],
            rod: null,
            scheduled: false,
            costPerCast: 0,
            life: null,
          })),
        };
        agent.masterSlot = agent.policy === 'pitySwitch' ? agent.slots.findIndex((s) => s.tierId === this.params.tiers.length - 1) : -1;
        group.agents += 1;
        group.wallets += walletCount;
        this.agents.push(agent);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ market

  updateRates() {
    /** $GAME-equivalent value of one wei of each reward token. */
    this.rateWei = this.symbols.map((s) => (s === GAME_SYMBOL ? 1 : this.stockPriceUsd[s] / this.gamePriceUsd) / WEI);
  }

  /** @returns {number[]} $GAME-equivalent value of each pool, aligned with `symbols` */
  poolValues() {
    return this.symbols.map((s, i) => Number(this.pools[s]) * this.rateWei[i]);
  }

  /**
   * Expected value of one catch for a tier at the current pools.
   * @param {number} tierId
   */
  evPerCatch(tierId) {
    const coef = this.coefPerCatch[tierId];
    let ev = 0;
    for (let i = 0; i < this.symbols.length; i++) ev += coef[i] * Number(this.pools[this.symbols[i]]) * this.rateWei[i];
    return ev;
  }

  /** Expected pool value per $GAME of a plain (no bait, no pity) cast of the top tier: the "lake is fat" index. */
  masterEvIndex() {
    const top = this.params.tiers.length - 1;
    return ((this.params.tiers[top].catchBps / BPS) * this.evPerCatch(top)) / this.plainCostPerCast[top];
  }

  // ------------------------------------------------------------------------------------------ run loop

  run() {
    const q = this.queue;
    for (const agent of this.agents) {
      if (agent.policy === 'timing') {
        for (const slot of agent.slots) this.ensureScheduled(agent, slot);
      } else {
        const joinDay = Math.floor((agent.joinTime - EPOCH) / DAY);
        for (let chain = 0; chain < agent.group.spec.sessions; chain++) this.scheduleSession(agent, joinDay);
      }
    }
    q.push({ time: EPOCH + this.keeperIntervalSec, kind: 'keeper' });
    q.push({ time: EPOCH, kind: 'observe' });
    const seasonLength = this.params.tournament.seasonLength;
    for (let k = 1; EPOCH + k * seasonLength <= this.endTime; k++) q.push({ time: EPOCH + k * seasonLength, kind: 'season', index: k - 1 });
    if (this.scenario.shock) q.push({ time: EPOCH + this.scenario.shock.day * DAY, kind: 'shock' });

    while (q.size > 0 && q.peekTime() <= this.endTime) {
      const event = q.pop();
      this.now = event.time;
      switch (event.kind) {
        case 'cast': this.onCast(event.agent, event.slot); break;
        case 'session': this.onSession(event.agent, event.day, event.length); break;
        case 'keeper': this.recycle(); q.push({ time: this.now + this.keeperIntervalSec, kind: 'keeper' }); break;
        case 'observe': this.observe(); q.push({ time: this.now + OBSERVE_INTERVAL, kind: 'observe' }); break;
        case 'season': this.finalizeSeason(event.index); break;
        case 'shock': this.gamePriceUsd *= this.scenario.shock.factor; this.updateRates(); break;
        default: throw new Error(`unknown event ${event.kind}`);
      }
    }
    this.now = this.endTime;
    const openSeason = seasonAt(this.endTime - 1, EPOCH, seasonLength);
    if (!this.season(openSeason).finalized) this.finalizeSeason(openSeason);
    return this;
  }

  /**
   * @param {object} agent
   * @param {number} day
   */
  scheduleSession(agent, day) {
    const spec = agent.group.spec;
    const length = spec.sessionMinutes * 60 * this.behaviorRng.between(0.5, 1.5);
    const dayStart = Math.max(EPOCH + day * DAY, agent.joinTime);
    const start = dayStart + this.behaviorRng.between(0, Math.max(0, EPOCH + (day + 1) * DAY - length - dayStart));
    this.queue.push({ time: start, kind: 'session', agent, day, length });
  }

  onSession(agent, day, length) {
    agent.sessionEnd = Math.max(agent.sessionEnd, this.now + length);
    for (const [i, slot] of agent.slots.entries()) {
      if (i === agent.masterSlot && !this.isPrimed(slot.wallet)) continue;
      this.ensureScheduled(agent, slot);
    }
    this.scheduleSession(agent, day + 1);
  }

  isPrimed(wallet) {
    return wallet.player.missStreak >= this.params.loot.pityThreshold;
  }

  readyAt(slot) {
    return slot.rod === null || slot.rod.durability === 0 ? this.now : slot.rod.lastCastAt + this.params.tiers[slot.tierId].cooldown;
  }

  scheduleCast(agent, slot, time) {
    slot.scheduled = true;
    this.queue.push({ time, kind: 'cast', agent, slot });
  }

  ensureScheduled(agent, slot) {
    if (!slot.scheduled) this.scheduleCast(agent, slot, Math.max(this.now, this.readyAt(slot)) + this.behaviorRng.between(0, 20));
  }

  onCast(agent, slot) {
    if (this.now >= agent.sessionEnd) {
      slot.scheduled = false;
      return;
    }
    const isMasterSlot = agent.masterSlot !== -1 && slot === agent.slots[agent.masterSlot];
    if (agent.policy === 'pitySwitch') {
      const primed = this.isPrimed(slot.wallet);
      if (isMasterSlot && !primed) {
        slot.scheduled = false;
        return;
      }
      if (!isMasterSlot && primed) {
        const master = agent.slots[agent.masterSlot];
        this.ensureScheduled(agent, master);
        this.scheduleCast(agent, slot, Math.max(this.now, this.readyAt(master)) + 5);
        return;
      }
    } else if (agent.policy === 'timing' && this.masterEvIndex() < agent.timingThreshold * this.evEma) {
      this.scheduleCast(agent, slot, this.now + 60);
      return;
    }

    this.ensureRod(agent, slot);
    const readyAt = this.readyAt(slot);
    if (this.now < readyAt) {
      this.scheduleCast(agent, slot, readyAt + this.behaviorRng.between(0, 20));
      return;
    }
    this.castOnce(agent, slot);

    if (isMasterSlot) {
      slot.scheduled = false;
      return;
    }
    const cooldown = this.params.tiers[slot.tierId].cooldown;
    this.scheduleCast(agent, slot, this.now + cooldown + this.behaviorRng.between(0, 20));
    if (agent.policy === 'pitySwitch' && this.isPrimed(slot.wallet)) this.ensureScheduled(agent, agent.slots[agent.masterSlot]);
  }

  /** Buys or repairs the rod in a slot when it is missing or broken. */
  ensureRod(agent, slot) {
    if (slot.rod !== null && slot.rod.durability > 0) return;
    if (slot.rod !== null && agent.repairs && slot.rod.repairs < this.params.repair.maxRepairs) {
      const repaired = repairRod(this.params, slot.rod);
      slot.rod = repaired.rod;
      this.charge(agent, repaired.cost);
      slot.costPerCast = Number(repaired.cost) / WEI / repaired.restored;
      slot.life = { kind: 'repair', startedAt: this.now, cost: Number(repaired.cost) / WEI, value: 0, stock: false };
      return;
    }
    const bought = buyRod(this.params, slot.tierId);
    slot.rod = bought.rod;
    this.charge(agent, bought.cost);
    slot.costPerCast = Number(bought.cost) / WEI / bought.rod.durability;
    slot.life = { kind: 'new', startedAt: this.now, cost: Number(bought.cost) / WEI, value: 0, stock: false };
  }

  /**
   * Routes a rod purchase / repair payment through the revenue split (SPEC §4).
   * @param {object} agent
   * @param {bigint} amount
   */
  charge(agent, amount) {
    const s = splitRevenue(amount, this.params.split);
    this.pools[GAME_SYMBOL] += s.baitVault;
    this.stockBudget += s.stock;
    this.season(this.currentSeason()).pot += s.tournament;
    const f = this.flows;
    const value = Number(amount) / WEI;
    f.spent += value;
    f.stock += Number(s.stock) / WEI;
    f.baitVault += Number(s.baitVault) / WEI;
    f.burn += Number(s.burn) / WEI;
    f.tournament += Number(s.tournament) / WEI;
    f.treasury += Number(s.treasury) / WEI;
    agent.group.spent += value;
  }

  /** Casts one rod through the engine and books the outcome. */
  castOnce(agent, slot) {
    const { params } = this;
    const { loot } = params;
    const wallet = slot.wallet;
    const tierId = slot.tierId;
    let player = wallet.player;

    let useBait = false;
    if (agent.useBait && player.missStreak < loot.pityThreshold) {
      if (player.bait === 0 && player.junk >= loot.baitJunkCost) player = craftBait(params, player, Math.floor(player.junk / loot.baitJunkCost));
      useBait = player.bait > 0;
    }
    const catchBps = effectiveCatchBps(params, tierId, useBait, player.missStreak);
    const ev = (catchBps / BPS) * this.evPerCatch(tierId);

    const begun = beginCast(params, slot.rod, player, { now: this.now, useBait });
    const rolls = { r1: BigInt(this.castRng.u32()), r2: BigInt(this.castRng.u32()), r3: BigInt(this.castRng.u32()), r4: BigInt(this.castRng.u32()) };
    const { outcome, state } = resolveCast({ pools: this.pools, player: begun.player }, params, begun.rod, rolls, useBait);
    this.pools = state.pools;
    // Prizes are booked as realized value right away (as if claimed), so wallets need no owed balances.
    wallet.player = { ...state.player, owed: {} };
    slot.rod = settleRod(begun.rod);

    const day = Math.floor((this.now - EPOCH) / DAY);
    let value = 0;
    for (const payout of outcome.payouts) {
      const i = this.symbolIndex[payout.symbol];
      const units = Number(payout.amount);
      value += units * this.rateWei[i];
      this.paidUnits[i][day] += units / WEI;
    }
    const isFish = outcome.kind === 'fish';
    const isStock = isFish && this.stockSpeciesIds.has(outcome.speciesId);
    const isJackpot = isFish && this.jackpotIds.has(outcome.speciesId);

    const measuring = this.now >= this.measureFrom;
    for (const tally of measuring ? [agent.group.total, agent.group.byTier[tierId]] : []) {
      tally.casts += 1;
      tally.cost += slot.costPerCast;
      tally.ev += ev;
      tally.realized += value;
      if (isFish) tally.catches += 1;
      if (isStock) tally.stockCatches += 1;
      if (isJackpot) tally.jackpots += 1;
    }
    const daily = this.daily[day];
    daily.casts += 1;
    daily.cost += slot.costPerCast;
    daily.ev += ev;
    daily.realized += value;
    this.totalCasts += 1;
    if (this.totalCasts === CAST_CHECKPOINTS[this.checkpoints.length]) this.recordCheckpoint();

    if (isJackpot && measuring) this.jackpots.push({ day, tierId, value, rodPrices: value / (Number(params.tiers[tierId].price) / WEI) });
    if (outcome.score > 0) this.recordScore(wallet, outcome.score);

    const life = slot.life;
    life.value += value;
    if (isStock) life.stock = true;
    if (slot.rod.durability === 0 && life.kind === 'new' && life.startedAt >= this.measureFrom) {
      const bucket = this.lives[tierId];
      const ret = life.value / life.cost;
      if (agent.useBait) {
        bucket.baited.push(ret);
        if (life.stock) bucket.baitedStock += 1;
      } else {
        bucket.plain.push(ret);
        if (life.stock) bucket.plainStock += 1;
      }
    }
  }

  recordCheckpoint() {
    let cost = 0;
    let realized = 0;
    let ev = 0;
    for (const d of this.daily) {
      cost += d.cost;
      realized += d.realized;
      ev += d.ev;
    }
    this.checkpoints.push({ casts: this.totalCasts, hours: (this.now - EPOCH) / HOUR, evRtp: ev / cost, realizedRtp: realized / cost });
  }

  // ------------------------------------------------------------------------------------------ keeper

  /**
   * Keeper: swaps the whole stock budget into the basket, filling the stocks furthest below their target
   * value weight first (equivalent to a burst of `recycle` calls on the most under-weight stock).
   */
  recycle() {
    if (this.stockBudget === 0n) return;
    const budget = Number(this.stockBudget) / WEI;
    this.stockBudget = 0n;
    const netValue = budget * (1 - this.swapCostBps / BPS);
    const values = this.stocks.map((s) => Number(this.pools[s]) * this.rateWei[this.symbolIndex[s]]);
    const total = values.reduce((a, v) => a + v, 0) + netValue;
    const deficits = this.stocks.map((s, i) => Math.max(0, ((this.params.basketTargetWeightBps[s] ?? 0) / BPS) * total - values[i]));
    const deficitSum = deficits.reduce((a, v) => a + v, 0);
    this.stocks.forEach((s, i) => {
      if (deficits[i] === 0) return;
      const valueIn = (netValue * deficits[i]) / deficitSum;
      this.pools[s] += BigInt(Math.floor(valueIn / (this.rateWei[this.symbolIndex[s]] * WEI) * WEI));
    });
    this.flows.recycled += budget;
    this.flows.swapLoss += budget - netValue;
  }

  // ------------------------------------------------------------------------------------------ observation

  observe() {
    const index = this.masterEvIndex();
    const alpha = 1 - 2 ** (-OBSERVE_INTERVAL / EV_EMA_HALF_LIFE);
    this.evEma += alpha * (index - this.evEma);
    if (this.observations++ % (HOUR / OBSERVE_INTERVAL) !== 0) return;
    const values = this.poolValues();
    this.samples.push({
      hour: (this.now - EPOCH) / HOUR,
      casts: this.totalCasts,
      units: this.symbols.map((s) => Number(this.pools[s]) / WEI),
      values,
      stockValue: values.reduce((a, v, i) => (this.symbols[i] === GAME_SYMBOL ? a : a + v), 0),
      evIndex: index,
    });
  }

  // ------------------------------------------------------------------------------------------ tournament

  currentSeason() {
    return seasonAt(this.now, EPOCH, this.params.tournament.seasonLength);
  }

  season(index) {
    let s = this.seasons.get(index);
    if (!s) {
      s = { pot: 0n, top: [], totals: new Map(), finalized: false };
      this.seasons.set(index, s);
    }
    return s;
  }

  recordScore(wallet, points) {
    const s = this.season(this.currentSeason());
    const total = (s.totals.get(wallet.id) ?? 0) + points;
    s.totals.set(wallet.id, total);
    s.top = updateTopScores(s.top, wallet.id, total);
  }

  finalizeSeason(index) {
    const s = this.season(index);
    const { payouts, rollover } = seasonPayouts(s.pot, s.top, this.params.tournament.payoutBps);
    s.finalized = true;
    this.season(index + 1).pot += rollover;
    if (index < this.firstMeasuredSeason) return;
    const pot = Number(s.pot) / WEI;
    const byGroup = {};
    for (const p of payouts) {
      const wallet = this.walletById.get(p.player);
      const amount = Number(p.amount) / WEI;
      wallet.group.tournament += amount;
      wallet.group.tournamentPrizes += 1;
      byGroup[wallet.group.spec.group] = (byGroup[wallet.group.spec.group] ?? 0) + amount;
      this.flows.tournamentPaid += amount;
    }
    this.seasonStats.push({
      index,
      pot,
      participants: s.totals.size,
      top1Share: payouts.length ? Number(payouts[0].amount) / WEI / pot : 0,
      byGroup,
      topScores: s.top.map((e) => e.score),
      winners: payouts.map((p) => p.player),
    });
  }
}

// ============================================================================================ analysis

/**
 * Stationary catch rate with pity: the chance of a catch after the streak reached the threshold is 1, so the
 * expected catches per cast is p / (1 - q^(T+1)).
 * @param {number} catchBps
 * @param {number} pityThreshold
 */
function pityCatchRate(catchBps, pityThreshold) {
  const p = catchBps / BPS;
  return p / (1 - (1 - p) ** (pityThreshold + 1));
}

/** Analytic properties of the parameters (no randomness). */
function analyze(params, market) {
  const top = params.tiers.length - 1;
  const tiers = params.tiers.map((t, id) => {
    const price = Number(t.price) / WEI;
    const pityCatch = pityCatchRate(t.catchBps, params.loot.pityThreshold);
    const shares = expectedPoolShares(params, id, BPS);
    return {
      id,
      name: t.name,
      price,
      durability: t.durability,
      costPerCast: price / t.durability,
      catchBps: t.catchBps,
      pityCatch,
      multiplier: t.multiplierX100 / 100,
      cooldown: t.cooldown,
      valueIndex: (pityCatch * t.multiplierX100 * t.durability) / price,
      shares,
    };
  });
  const beginnerIndex = tiers[0].valueIndex;
  tiers.forEach((t) => {
    t.relativeValue = t.valueIndex / beginnerIndex;
  });

  const capChecks = [];
  params.tiers.forEach((t, tierId) => {
    params.species.forEach((s, speciesId) => {
      const raw = Math.floor((s.sharePpm * t.multiplierX100) / 100);
      const eff = effectiveSharePpm(s.sharePpm, t.multiplierX100, params.loot.maxSharePpm);
      if (raw > eff) capChecks.push({ tier: t.name, species: s.name, raw, eff });
    });
  });
  const maxEffective = Math.max(...params.species.map((s) => effectiveSharePpm(s.sharePpm, params.tiers[top].multiplierX100, params.loot.maxSharePpm)));

  const odds = catchOdds(params);
  const stockPerCatch = params.species.reduce((a, s, id) => (s.rewardSymbol !== GAME_SYMBOL ? a + odds[id] : a), 0);
  const stockRodChance = tiers.map((t) => 1 - (1 - t.pityCatch * stockPerCatch) ** t.durability);
  return { tiers, capChecks, maxEffective, odds, stockPerCatch, stockRodChance, market };
}

/** Summarizes a finished simulation into plain numbers. */
function summarize(sim, params) {
  const groups = {};
  for (const [name, g] of sim.groups) groups[name] = g;
  const tiers = params.tiers.map(() => newTally());
  for (const g of Object.values(groups)) g.byTier.forEach((t, i) => addTally(tiers[i], t));
  const total = newTally();
  tiers.forEach((t) => addTally(total, t));

  const days = sim.scenario.days;
  const eqStartHour = Math.min(WARMUP_DAYS, days / 2) * 24;
  const eqSamples = sim.samples.filter((s) => s.hour >= eqStartHour);
  const eqUnits = sim.symbols.map((_, i) => mean(eqSamples.map((s) => s.units[i])));
  const eqValues = sim.symbols.map((_, i) => mean(eqSamples.map((s) => s.values[i])));
  const eqStockValue = mean(eqSamples.map((s) => s.stockValue));
  const eqStartDay = Math.floor(eqStartHour / 24);
  const castsInEq = sim.daily.slice(eqStartDay, days).reduce((a, d) => a + d.casts, 0);
  const pools = sim.symbols.map((symbol, i) => {
    const paid = sim.paidUnits[i].slice(eqStartDay, days).reduce((a, v) => a + v, 0);
    const series = eqSamples.map((s) => s.units[i]);
    const sd = Math.sqrt(mean(series.map((v) => (v - eqUnits[i]) ** 2)));
    return {
      symbol,
      meanUnits: eqUnits[i],
      meanValue: eqValues[i],
      cv: sd / eqUnits[i],
      turnoverCasts: paid > 0 ? eqUnits[i] / (paid / castsInEq) : Infinity,
    };
  });

  const lives = sim.lives.map((b, tierId) => {
    const plain = [...b.plain].sort((x, y) => x - y);
    const all = [...b.plain, ...b.baited].sort((x, y) => x - y);
    return {
      tierId,
      rods: plain.length,
      mean: mean(plain),
      p10: quantile(plain, 0.1),
      median: quantile(plain, 0.5),
      p90: quantile(plain, 0.9),
      pStock: b.plainStock / plain.length,
      pProfit: plain.filter((r) => r >= 1).length / plain.length,
      allRods: all.length,
      allPStock: (b.plainStock + b.baitedStock) / all.length,
    };
  });

  return {
    scenario: sim.scenario,
    agents: sim.agents.length,
    wallets: sim.walletById.size,
    totalCasts: sim.totalCasts,
    flows: sim.flows,
    seedValue: sim.seedValue,
    endPoolValue: sim.poolValues().reduce((a, v) => a + v, 0) + Number(sim.stockBudget) / WEI,
    total,
    tiers,
    groups,
    lives,
    pools,
    eqStockValue,
    eqGamePool: eqValues[sim.symbolIndex[GAME_SYMBOL]],
    samples: sim.samples,
    daily: sim.daily,
    checkpoints: sim.checkpoints,
    jackpots: sim.jackpots,
    seasonStats: sim.seasonStats,
    symbols: sim.symbols,
  };
}

function evPerGame(tally) {
  return tally.ev / tally.cost;
}

/** Strategy comparisons against their baselines (expected value, so luck is averaged out). */
function strategyTable(result) {
  const g = result.groups;
  const tierEv = [g['always-beginner'], g['always-pro'], g['always-master']].map((x, i) => evPerGame(x.byTier[i]));
  const rows = [];
  for (const [name, group] of Object.entries(g)) {
    const spec = group.spec;
    if (!spec.baseline) continue;
    let baselineEv;
    let baselineTotal = null;
    if (spec.baseline === 'tier-mix') {
      const expected = group.byTier.reduce((a, t, i) => a + t.cost * tierEv[i], 0);
      baselineEv = expected / group.total.cost;
    } else {
      const base = g[spec.baseline];
      baselineEv = evPerGame(base.total);
      baselineTotal = (base.total.ev + base.tournament) / base.total.cost;
    }
    const ev = evPerGame(group.total);
    const total = (group.total.ev + group.tournament) / group.total.cost;
    rows.push({
      name,
      description: spec.description,
      baseline: spec.baseline === 'tier-mix' ? 'same tiers, plain play' : spec.baseline,
      casts: group.total.casts,
      spent: group.total.cost,
      ev,
      realized: group.total.realized / group.total.cost,
      tournament: group.tournament / group.total.cost,
      edge: ev / baselineEv - 1,
      edgeWithTournament: baselineTotal === null ? null : total / baselineTotal - 1,
    });
  }
  return { rows, tierEv };
}

/** Hours after launch until the 6 h rolling means of the $GAME pool and stock value are within `band` of the targets. */
function hoursToEquilibrium(samples, gameTarget, stockTarget, band, gameIndex) {
  const window = 6;
  for (let i = window - 1; i < samples.length; i++) {
    const slice = samples.slice(i - window + 1, i + 1);
    const game = mean(slice.map((s) => s.values[gameIndex]));
    const stock = mean(slice.map((s) => s.stockValue));
    if (Math.abs(game / gameTarget - 1) <= band && Math.abs(stock / stockTarget - 1) <= band) return { hours: samples[i].hour, casts: samples[i].casts };
  }
  return { hours: Infinity, casts: Infinity };
}

/** Pool RTP (payouts / cost of the casts) over a window of days. */
function windowRtp(daily, from, to) {
  const slice = daily.slice(from, to);
  const cost = slice.reduce((a, d) => a + d.cost, 0);
  return { ev: slice.reduce((a, d) => a + d.ev, 0) / cost, realized: slice.reduce((a, d) => a + d.realized, 0) / cost };
}

function shockAnalysis(result, baseline) {
  const shock = result.scenario.shock;
  const gameIndex = result.symbols.indexOf(GAME_SYMBOL);
  const target = baseline.eqStockValue;
  const after = result.samples.filter((s) => s.hour >= shock.day * 24);
  const recovered = after.find((s, i) => i >= 1 && Math.abs(s.stockValue / target - 1) <= 0.1);
  return {
    title: result.scenario.title,
    factor: shock.factor,
    pre: windowRtp(result.daily, Math.max(0, shock.day - 7), shock.day),
    firstDay: windowRtp(result.daily, shock.day, shock.day + 1),
    firstWeek: windowRtp(result.daily, shock.day, shock.day + 7),
    late: windowRtp(result.daily, result.scenario.days - 7, result.scenario.days),
    stockValueAtShock: after.length ? after[0].stockValue / target : NaN,
    recoveryHours: recovered ? recovered.hour - shock.day * 24 : Infinity,
    recoveryCasts: recovered ? recovered.casts - after[0].casts : Infinity,
    gamePoolRatio: mean(after.map((s) => s.values[gameIndex])) / baseline.eqGamePool,
  };
}

// ============================================================================================ targets

/**
 * The tuning targets of the economy and whether the simulated results meet them.
 * @returns {{name: string, target: string, value: string, pass: boolean}[]}
 */
function checkTargets(params, analytic, base, strategies, problems) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const totalRtp = (base.total.realized + base.flows.tournamentPaid) / base.total.cost;
  const tierEv = strategies.tierEv;
  const evSpread = Math.max(...tierEv) / Math.min(...tierEv) - 1;
  const stockTurnovers = base.pools.filter((p) => p.symbol !== GAME_SYMBOL).map((p) => p.turnoverCasts);
  const beginnerStock = base.lives[0].pStock;
  const rows = strategies.rows;
  const repairEdges = rows.filter((r) => r.name.startsWith('repair-')).map((r) => r.edge);
  const worst = rows.reduce((m, r) => (r.edge > m.edge ? r : m), { edge: -Infinity, name: '' });
  const sybil = rows.find((r) => r.name === 'whale-sybil');
  return [
    { name: 'Long-run total RTP (pools + tournament)', target: '≈ 75% (73–77%)', value: pct(totalRtp), pass: totalRtp >= 0.73 && totalRtp <= 0.77 },
    { name: 'Per-tier EV per $GAME spread (plain play)', target: '≤ 10%', value: pct(evSpread), pass: evSpread <= 0.1 },
    { name: 'Upgrade incentive (EV Master ≥ Pro ≥ Beginner)', target: 'monotonic', value: tierEv.map((v) => pct(v)).join(' / '), pass: tierEv[2] >= tierEv[1] && tierEv[1] >= tierEv[0] },
    { name: 'P(≥1 stock catch per Beginner rod)', target: '70–90%', value: pct(beginnerStock), pass: beginnerStock >= 0.7 && beginnerStock <= 0.9 },
    { name: 'Stock pool turnover (casts to pay out one pool)', target: '1,500–4,000', value: `${fmtInt(Math.min(...stockTurnovers))}–${fmtInt(Math.max(...stockTurnovers))}`, pass: Math.min(...stockTurnovers) >= 1500 && Math.max(...stockTurnovers) <= 4000 },
    { name: 'Best strategy edge over its baseline (EV)', target: '≤ ~10%', value: `${pct(worst.edge)} (${worst.name})`, pass: worst.edge <= 0.105 },
    { name: 'Sybil vs single wallet (incl. tournament)', target: 'no gain', value: pct(sybil.edgeWithTournament), pass: sybil.edgeWithTournament <= 0.02 },
    { name: 'Repairs: attractive but not dominant', target: '0% < edge ≤ 10%', value: repairEdges.map(pct).join(' / '), pass: repairEdges.every((e) => e > 0 && e <= 0.105) },
    { name: 'maxSharePpm cap never truncates a default catch', target: 'no binding cap', value: analytic.capChecks.length === 0 ? `max ${fmtInt(analytic.maxEffective)} ppm vs cap ${fmtInt(params.loot.maxSharePpm)}` : `${analytic.capChecks.length} capped`, pass: analytic.capChecks.length === 0 },
    { name: 'All parameters inside SPEC §7 bounds', target: 'valid', value: problems.length === 0 ? 'valid' : problems.join('; '), pass: problems.length === 0 },
  ];
}

// ============================================================================================ report

function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞';
}

function fmtPct(x, digits = 1) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : 'n/a';
}

function fmtSigned(x) {
  return Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%` : 'n/a';
}

function fmtX(x) {
  return `${x.toFixed(2)}x`;
}

function fmtGame(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/** Builds the Markdown results block (also printed to stdout). */
function buildReport({ params, analytic, results, strategies, targets, options, elapsedSec }) {
  const base = results.baseline;
  const out = [];
  const push = (...lines) => out.push(...lines, '');
  const tierNames = params.tiers.map((t) => t.name);
  const castDays = base.scenario.days;

  push(
    `_Generated by \`npm run sim\` (seed ${options.seed}, ${castDays} days, ${fmtInt(base.agents)} anglers / ${fmtInt(base.wallets)} wallets, ` +
      `${fmtInt(base.totalCasts)} casts in the baseline; ${Object.keys(results).length} scenarios in ${elapsedSec.toFixed(0)} s). ` +
      'Values are in $GAME-equivalent at the conversion rate in force when a prize is paid. EV = expected value of each cast given the pools at that moment (luck averaged out); realized = what was actually paid._',
  );

  push('### Tuning targets', table(['Target', 'Goal', 'Simulated', 'Status'], targets.map((t) => [t.name, t.target, t.value, t.pass ? 'PASS' : 'FAIL'])));

  push(
    '### Rods (analytic)',
    table(
      ['Tier', 'Price', 'Casts', 'Cost / cast', 'Catch', 'Catch incl. pity', 'Multiplier', 'Cooldown', 'Value per $GAME vs Beginner', 'P(≥1 stock) per rod'],
      analytic.tiers.map((t, i) => [
        t.name, fmtInt(t.price), t.durability, fmtInt(t.costPerCast), fmtPct(t.catchBps / BPS), fmtPct(t.pityCatch), fmtX(t.multiplier), `${t.cooldown} s`, fmtX(t.relativeValue), fmtPct(analytic.stockRodChance[i]),
      ]),
    ),
    `Largest effective share on a default catch: ${fmtInt(analytic.maxEffective)} ppm (cap ${fmtInt(params.loot.maxSharePpm)} ppm): ` +
      (analytic.capChecks.length === 0 ? 'the cap never truncates a Master catch.' : `${analytic.capChecks.length} catches are truncated by the cap.`),
  );

  const flows = base.flows;
  const totalRtp = (base.total.realized + flows.tournamentPaid) / base.total.cost;
  push(
    '### Where every $GAME goes (baseline)',
    table(
      ['Flow', 'Share of spending'],
      [
        ['Stock prizes (after swap costs)', fmtPct((flows.stock - flows.swapLoss) / flows.spent)],
        ['Swap costs on recycling', fmtPct(flows.swapLoss / flows.spent)],
        ['$GAME prizes (bait vault)', fmtPct(flows.baitVault / flows.spent)],
        ['Tournament prizes', fmtPct(flows.tournament / flows.spent)],
        ['Burned', fmtPct(flows.burn / flows.spent)],
        ['Treasury', fmtPct(flows.treasury / flows.spent)],
      ],
    ),
    `Simulated long-run RTP: pools ${fmtPct(base.total.realized / base.total.cost)} realized (${fmtPct(base.total.ev / base.total.cost)} expected) + tournament ${fmtPct(flows.tournamentPaid / base.total.cost)} = **${fmtPct(totalRtp)}** of spending returned to players.`,
  );

  const popTiers = base.tiers.map((t, i) => [
    tierNames[i], fmtInt(t.casts), fmtPct(t.casts / base.total.casts), fmtPct(t.cost / base.total.cost), fmtPct(t.ev / t.cost), fmtPct(t.realized / t.cost), fmtPct(t.stockCatches / t.casts, 2), fmtInt(t.jackpots),
  ]);
  push(
    '### Per tier (whole population, baseline)',
    table(['Tier', 'Casts', 'Share of casts', 'Share of spend', 'EV per $GAME', 'Realized RTP', 'Stock catch / cast', 'Golden Bulls'], popTiers),
    'Population EV includes bait and pity as players actually used them; the plain-play comparison is in the strategy table.',
  );

  push(
    '### Outcome of one rod (plain play, new rods, baseline)',
    table(
      ['Tier', 'Rods', 'Mean return', 'p10', 'Median', 'p90', 'P(≥1 stock catch)', 'P(return ≥ cost)'],
      base.lives.map((l, i) => [tierNames[i], fmtInt(l.rods), fmtPct(l.mean), fmtPct(l.p10), fmtPct(l.median), fmtPct(l.p90), fmtPct(l.pStock), fmtPct(l.pProfit)]),
    ),
    'Return = value of everything the rod caught / rod price (tournament prizes excluded). Most rods return less than they cost; a minority hit an Epic or the Golden Bull and return several times their price. That skew is what the prize pools pay for.',
  );

  const gameIndex = base.symbols.indexOf(GAME_SYMBOL);
  const unseeded = results.unseeded;
  const toEqSeeded = hoursToEquilibrium(base.samples, base.eqGamePool, base.eqStockValue, 0.1, gameIndex);
  const toEqUnseeded = hoursToEquilibrium(unseeded.samples, base.eqGamePool, base.eqStockValue, 0.1, gameIndex);
  push(
    '### Pools at equilibrium (baseline, after week 1)',
    table(
      ['Pool', 'Mean size (tokens)', 'Mean value ($GAME-eq)', 'Turnover (casts to pay out one pool)', 'Fluctuation (CV)'],
      base.pools.map((p) => [p.symbol, p.symbol === GAME_SYMBOL ? fmtGame(p.meanUnits) : p.meanUnits.toFixed(3), fmtGame(p.meanValue), fmtInt(p.turnoverCasts), fmtPct(p.cv)]),
    ),
    `Equilibrium: $GAME pool ≈ ${fmtGame(base.eqGamePool)} $GAME, stock pools ≈ ${fmtGame(base.eqStockValue)} $GAME-eq in total. ` +
      `Seeded launch: within ±10% of equilibrium after ${fmtInt(toEqSeeded.hours)} h. Unseeded launch: ${Number.isFinite(toEqUnseeded.hours) ? `${fmtInt(toEqUnseeded.hours)} h (${fmtInt(toEqUnseeded.casts)} casts)` : `not reached in ${unseeded.scenario.days} days`}.`,
  );

  push(
    '### Launch: seeded vs unseeded pools',
    table(
      ['After', 'Seeded: pool RTP (EV)', 'Unseeded: pool RTP (EV)'],
      unseeded.checkpoints.map((c, i) => [`${fmtInt(c.casts)} casts`, base.checkpoints[i] ? fmtPct(base.checkpoints[i].evRtp) : 'n/a', fmtPct(c.evRtp)]),
    ),
    `Cumulative expected pool RTP of all casts so far. Recommended seed: ${fmtGame(LAUNCH_SEED.gamePool)} $GAME in the $GAME pool and ${fmtGame(LAUNCH_SEED.stockValueInGame)} $GAME-equivalent of stocks split by basket weight.`,
  );

  const jackpots = base.jackpots;
  const byTier = params.tiers.map((_, i) => jackpots.filter((j) => j.tierId === i));
  push(
    '### Golden Bull jackpots (baseline)',
    table(
      ['Tier', 'Count', 'Median value', 'Max value', 'Median in rod prices'],
      byTier.map((list, i) => {
        const values = list.map((j) => j.value).sort((a, b) => a - b);
        const rods = list.map((j) => j.rodPrices).sort((a, b) => a - b);
        return [tierNames[i], fmtInt(list.length), fmtGame(quantile(values, 0.5)), fmtGame(values[values.length - 1] ?? NaN), fmtX(quantile(rods, 0.5) || 0)];
      }),
    ),
  );

  const seasons = base.seasonStats;
  const prizeByGroup = {};
  seasons.forEach((s) => Object.entries(s.byGroup).forEach(([g, v]) => { prizeByGroup[g] = (prizeByGroup[g] ?? 0) + v; }));
  const totalPrizes = Object.values(prizeByGroup).reduce((a, v) => a + v, 0);
  const winnerCounts = new Map();
  seasons.forEach((s) => s.winners.forEach((w) => winnerCounts.set(w, (winnerCounts.get(w) ?? 0) + 1)));
  const allWallets = [...Object.values(base.groups)].reduce((a, g) => a + g.wallets, 0);
  const walletPrizes = new Map();
  seasons.forEach((s) => s.winners.forEach((w, rank) => walletPrizes.set(w, (walletPrizes.get(w) ?? 0) + (s.pot * params.tournament.payoutBps[rank]) / BPS)));
  const prizeValues = [...walletPrizes.values(), ...Array(Math.max(0, allWallets - walletPrizes.size)).fill(0)];
  push(
    '### Tournament concentration (baseline)',
    `${seasons.length} weekly seasons, average prize pool ${fmtGame(mean(seasons.map((s) => s.pot)))} $GAME, ${fmtInt(mean(seasons.map((s) => s.participants)))} scoring wallets per season, ` +
      `${winnerCounts.size} distinct prize winners, rank 1 takes ${fmtPct(mean(seasons.map((s) => s.top1Share)))} of a season. Gini of tournament winnings across all wallets: ${gini(prizeValues).toFixed(3)}.`,
    table(
      ['Group', 'Share of spend', 'Share of tournament prizes', 'Tournament return per $GAME'],
      Object.entries(base.groups)
        .filter(([, g]) => g.total.cost > 0)
        .sort((a, b) => b[1].tournament - a[1].tournament)
        .map(([name, g]) => [name, fmtPct(g.total.cost / base.total.cost), fmtPct(totalPrizes ? g.tournament / totalPrizes : 0), fmtPct(g.tournament / g.total.cost)]),
    ),
    'The weekly top-10 is a volume competition, so it is the one intentionally non-proportional part of the economy: it rebates the biggest spenders. Everything else pays the same expected value per $GAME to everyone.',
  );

  push(
    '### Strategies (baseline)',
    table(
      ['Strategy', 'What it does', 'Compared with', 'Casts', 'EV per $GAME', 'Realized RTP', 'Edge (EV)', 'Edge incl. tournament'],
      strategies.rows.map((r) => [r.name, r.description, r.baseline, fmtInt(r.casts), fmtPct(r.ev), fmtPct(r.realized), fmtSigned(r.edge), r.edgeWithTournament === null ? 'n/a' : fmtSigned(r.edgeWithTournament)]),
    ),
    `Plain-play EV per $GAME by tier: ${strategies.tierEv.map((v, i) => `${tierNames[i]} ${fmtPct(v)}`).join(', ')}.`,
  );

  const daily = results.keeperDaily;
  const dailyStrategies = strategyTable(daily);
  const timingDaily = dailyStrategies.rows.find((r) => r.name === 'timing-master');
  const timingBase = strategies.rows.find((r) => r.name === 'timing-master');
  push(
    '### Keeper cadence and the timing attack',
    `Timing bot edge with the keeper recycling every ${DEFAULT_MARKET.keeperIntervalSec / 60} min: ${fmtSigned(timingBase.edge)}; with one recycle per day: ${fmtSigned(timingDaily.edge)}. ` +
      'Frequent, small recycles keep stock pools smooth, which is what keeps waiting for a fat lake from paying.',
  );

  const shocks = ['crash', 'pump'].map((id) => shockAnalysis(results[id], base));
  push(
    '### $GAME price shocks',
    table(
      ['Scenario', 'Pool RTP week before', 'First 24 h after', 'First week after', 'Last week', 'Stock value right after (vs eq.)', 'Back within ±10%'],
      shocks.map((s) => [s.title, fmtPct(s.pre.realized), fmtPct(s.firstDay.realized), fmtPct(s.firstWeek.realized), fmtPct(s.late.realized), fmtX(s.stockValueAtShock), Number.isFinite(s.recoveryHours) ? `${s.recoveryHours.toFixed(0)} h (${fmtInt(s.recoveryCasts)} casts)` : 'not within run']),
    ),
    'Stock pools hold stock tokens, so a $GAME crash makes them worth more $GAME: players are paid more until the pools drain back to equilibrium. A pump does the opposite, and the keeper refills them from new spending. Neither can make the vault insolvent, because every prize is a fraction of what is in the pool.',
  );
  return out.join('\n').trimEnd();
}

// ============================================================================================ main

function parseArgs(argv) {
  const options = { seed: 4663, days: 56, scale: 1, write: true, quick: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${arg} needs a positive number`);
      return v;
    };
    if (arg === '--seed') options.seed = value();
    else if (arg === '--days') options.days = Math.round(value());
    else if (arg === '--scale') options.scale = value();
    else if (arg === '--quick') options.quick = true;
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option ${arg} (try --help)`);
  }
  if (options.quick) {
    options.days = 21;
    options.scale = 0.4;
    options.write = false;
  }
  return options;
}

function writeOutputs(params, report, summary) {
  const configPath = path.join(ROOT, 'config', 'game-params.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(paramsToConfig(params), null, 2)}\n`);

  const outDir = path.join(ROOT, 'sim', 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const economyPath = path.join(ROOT, 'docs', 'ECONOMY.md');
  let doc;
  try {
    doc = readFileSync(economyPath, 'utf8');
  } catch {
    console.warn(`warning: ${path.relative(ROOT, economyPath)} not found; results block not written`);
    return [configPath, path.join(outDir, 'results.json')];
  }
  const begin = doc.indexOf(RESULTS_BEGIN);
  const end = doc.indexOf(RESULTS_END);
  if (begin === -1 || end < begin) {
    console.warn(`warning: ${path.relative(ROOT, economyPath)} has no ${RESULTS_BEGIN} … ${RESULTS_END} block; results not written`);
    return [configPath, path.join(outDir, 'results.json')];
  }
  writeFileSync(economyPath, `${doc.slice(0, begin + RESULTS_BEGIN.length)}\n${report}\n${doc.slice(end)}`);
  return [configPath, path.join(outDir, 'results.json'), economyPath];
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(10, 17).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return;
  }
  const started = Date.now();
  const params = assertValidParams(paramsFromConfig(DEFAULT_GAME_CONFIG));
  const analytic = analyze(params, DEFAULT_MARKET);

  const results = {};
  for (const scenario of buildScenarios(options.days)) {
    const t0 = Date.now();
    const sim = new Simulation({ params, market: DEFAULT_MARKET, scenario, seed: options.seed, scale: options.scale }).run();
    results[scenario.id] = summarize(sim, params);
    console.error(`[sim] ${scenario.id.padEnd(12)} ${fmtInt(sim.totalCasts).padStart(10)} casts  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const strategies = strategyTable(results.baseline);
  const targets = checkTargets(params, analytic, results.baseline, strategies, validateParams(params));
  const elapsedSec = (Date.now() - started) / 1000;
  const report = buildReport({ params, analytic, results, strategies, targets, options, elapsedSec });
  console.log(report);

  if (options.write) {
    const summary = {
      options,
      params: paramsToConfig(params),
      market: DEFAULT_MARKET,
      launchSeed: LAUNCH_SEED,
      targets,
      strategies,
      scenarios: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, compactResult(r)])),
    };
    const written = writeOutputs(params, report, summary);
    console.error(`[sim] wrote ${written.map((p) => path.relative(ROOT, p)).join(', ')}`);
  }
  const failed = targets.filter((t) => !t.pass);
  if (failed.length > 0) {
    console.error(`[sim] ${failed.length} tuning target(s) not met: ${failed.map((t) => t.name).join('; ')}`);
    process.exitCode = 1;
  }
}

/** Drops per-sample series and group internals from a result so results.json stays small. */
function compactResult(r) {
  return {
    scenario: r.scenario,
    totalCasts: r.totalCasts,
    flows: r.flows,
    total: r.total,
    tiers: r.tiers,
    lives: r.lives,
    pools: r.pools,
    eqGamePool: r.eqGamePool,
    eqStockValue: r.eqStockValue,
    checkpoints: r.checkpoints,
    seasons: r.seasonStats.map(({ index, pot, participants, top1Share, byGroup }) => ({ index, pot, participants, top1Share, byGroup })),
    groups: Object.fromEntries(Object.entries(r.groups).map(([name, g]) => [name, { agents: g.agents, wallets: g.wallets, spent: g.spent, total: g.total, byTier: g.byTier, tournament: g.tournament }])),
    daily: r.daily,
  };
}

export { POPULATION, Simulation, analyze, buildScenarios, checkTargets, strategyTable, summarize };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
