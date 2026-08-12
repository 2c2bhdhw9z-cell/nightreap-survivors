/**
 * Pickups — everything an enemy leaves behind and the magnet that hoovers it up.
 *
 * WHAT THIS IS, IN PLAIN TERMS
 * Kill something, it drops a gem. The gem sits there. Walk near it and it flies to you and adds to
 * your experience bar. That's the loop the entire game hangs off, so it has to be exact and it has
 * to be free.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 * 1. NO LOST EXPERIENCE. Late in a run thousands of things die per minute and the ground is a
 *    carpet of gems. The pool has a hard ceiling (1024). Rather than refuse a drop when full —
 *    which would silently steal experience from the player and make late levelling feel broken —
 *    a refused gem MERGES into the nearest existing gem, adding its value. The gem count is capped;
 *    the experience in the world is not. This is also why a screen full of gems doesn't cost frames.
 *
 * 2. THE MAGNET IS A RANGE, NOT A SPEED. A gem is inert until a player comes inside the magnet
 *    radius. Then it locks onto that player and accelerates in, and it keeps chasing them even if
 *    they run out of range — once it's yours, it's yours. That "tail of gems streaming behind you"
 *    is the feel we're copying, and it comes out of lock-on, not out of the pull radius.
 *
 * 3. COLLECTION IS AN EVENT, NOT A SIDE EFFECT. This file never touches experience, gold, health,
 *    or the level-up queue. It writes what was collected into flat per-tick buffers and the run
 *    loop reads them. That keeps the ordering authoritative for online co-op (the host's collection
 *    order is the only order) and keeps a replay reproducible.
 */

import { NULL_HANDLE, EntityPool, POOL_BUDGETS } from '../core/pool';
import type { Rng } from '../core/rng';
import type { PlayerStore } from './player';
import { PLAYER_RADIUS } from './player';
import type { Stats } from './stats';
import { STAT, STAT_SCALE } from './stats';

/**
 * What a pickup is. Append-only — these ids go into replays and save-file drop statistics.
 *
 * The three gem tiers exist for readability at a glance, not for maths: a player should be able to
 * tell "that's a big one" from across the screen without reading a number.
 */
export const PICKUP = {
  /** Small experience gem. The overwhelming majority of drops. */
  gemSmall: 0,
  /** Medium experience gem. */
  gemMedium: 1,
  /** Large experience gem. Bosses and rare rolls. */
  gemLarge: 2,
  /** Coin. Spends in the between-runs shop, never on progression. */
  gold: 3,
  /** Food. Heals on pickup, does nothing at full health. */
  health: 4,
  /** Chest. Opening it is a separate authoritative event, so it is collected but not consumed here. */
  chest: 5,
  /** Sweeps every gem on the ground into the player at once. */
  vacuum: 6,
  /** Kills everything currently on screen. Drops are still generated for what it kills. */
  bomb: 7,
  /** Freezes every enemy in place for a few seconds. */
  freeze: 8,
} as const;

export type PickupKind = (typeof PICKUP)[keyof typeof PICKUP];

export const PICKUP_KIND_COUNT = 9;

if (Object.keys(PICKUP).length !== PICKUP_KIND_COUNT) {
  throw new Error(`PICKUP_KIND_COUNT is ${PICKUP_KIND_COUNT} but PICKUP has ${Object.keys(PICKUP).length} entries`);
}

/** Base experience per gem tier, before `gemValue` and `xpGain` are applied. */
export const GEM_VALUE: readonly number[] = (() => {
  const v: number[] = Array.from<number>({ length: PICKUP_KIND_COUNT }).fill(0);
  v[PICKUP.gemSmall] = 1;
  v[PICKUP.gemMedium] = 5;
  v[PICKUP.gemLarge] = 25;
  return v;
})();

/** True for the kinds that carry experience and therefore participate in merging. */
export const IS_GEM: readonly boolean[] = (() => {
  const g: boolean[] = Array.from<boolean>({ length: PICKUP_KIND_COUNT }).fill(false);
  g[PICKUP.gemSmall] = true;
  g[PICKUP.gemMedium] = true;
  g[PICKUP.gemLarge] = true;
  return g;
})();

/**
 * Pull radius at magnet 1.0, in world pixels.
 *
 * Deliberately small. A generous default magnet removes the reason to ever take a magnet upgrade,
 * and removes the tension of having to walk back through a horde to collect what you earned.
 */
export const BASE_MAGNET_RADIUS = 26;

/** Radius at which a locked-on pickup counts as collected. Generous so nothing orbits forever. */
export const COLLECT_RADIUS = PLAYER_RADIUS + 4;

/** How hard a locked pickup accelerates, world px/s². */
export const PULL_ACCEL = 900;

/** Ceiling on pull speed, world px/s. Fast enough to feel snappy, slow enough to read as motion. */
export const MAX_PULL_SPEED = 420;

/**
 * How long a gem survives if never collected, in ticks. Zero would mean forever.
 *
 * Gems do NOT expire — stealing experience the player earned is never acceptable. Consumables do,
 * so that the floor doesn't slowly fill with un-taken chickens across a 90-minute Endless run.
 */
export const CONSUMABLE_TTL = 60 * 60;

/** Health restored by one food pickup, in health units. */
export const HEALTH_PICKUP_AMOUNT = 30;

/** Ticks enemies stay frozen when a freeze pickup is taken. */
export const FREEZE_TICKS = 60 * 4;

/** Per-tick collection buffer ceiling. Overflow is cosmetic-only: the value is still banked. */
export const MAX_COLLECT_EVENTS = 256;

/** How far a merge will reach to find a host gem, in world pixels. */
const MERGE_RADIUS = 240;
const MERGE_RADIUS_SQ = MERGE_RADIUS * MERGE_RADIUS;

const TICK_SECONDS = 1 / 60;

/** No lock-on yet. */
const NO_OWNER = -1;

/**
 * A drop request. One reused instance, filled and handed to `spawn`, exactly like weapon firing.
 * Allocating a small object per kill would mean tens of thousands of allocations a minute.
 */
export interface DropRequest {
  kind: number;
  x: number;
  y: number;
  /** Experience or gold carried. Ignored for kinds that carry neither. */
  value: number;
  /** Initial outward scatter, world px/s. Makes a big kill spray instead of stacking on one point. */
  vx: number;
  vy: number;
}

export function createDropRequest(): DropRequest {
  return { kind: PICKUP.gemSmall, x: 0, y: 0, value: 1, vx: 0, vy: 0 };
}

export class PickupStore {
  readonly pool: EntityPool;
  readonly capacity: number;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Experience for gems, coins for gold, unused otherwise. */
  readonly value: Float32Array;
  readonly kind: Int32Array;
  /** Player index this pickup has locked onto, or -1. */
  readonly lockedTo: Int32Array;
  /** Ticks lived, for bob animation and expiry. */
  readonly age: Int32Array;
  /** Ticks until expiry, or 0 for never. */
  readonly ttl: Int32Array;

  // --- Per-tick collection buffers, read by the run loop -----------------------------------
  collectCount = 0;
  readonly collectKind: Int32Array;
  readonly collectValue: Float32Array;
  readonly collectPlayer: Int32Array;
  readonly collectX: Float32Array;
  readonly collectY: Float32Array;

  /**
   * Totals banked this tick, already summed so the run loop doesn't have to walk the buffer.
   * These are exact even when the event buffer overflows.
   */
  xpBanked = 0;
  goldBanked = 0;
  healBanked = 0;
  chestsTaken = 0;
  vacuumsTaken = 0;
  bombsTaken = 0;
  freezesTaken = 0;

  // --- Run totals, for the results screen and the dev menu --------------------------------
  totalSpawned = 0;
  totalCollected = 0;
  totalMerged = 0;
  totalExpired = 0;
  /** Experience that arrived while the pool was full and was folded into an existing gem. */
  totalMergedValue = 0;

  /** Ticks of vacuum remaining. While non-zero every gem is locked to its nearest player. */
  private vacuumTicks = 0;

  private readonly req: DropRequest = createDropRequest();

  constructor(capacity: number = POOL_BUDGETS.pickups) {
    this.capacity = capacity;
    this.pool = new EntityPool(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.value = new Float32Array(capacity);
    this.kind = new Int32Array(capacity);
    this.lockedTo = new Int32Array(capacity).fill(NO_OWNER);
    this.age = new Int32Array(capacity);
    this.ttl = new Int32Array(capacity);

    this.collectKind = new Int32Array(MAX_COLLECT_EVENTS);
    this.collectValue = new Float32Array(MAX_COLLECT_EVENTS);
    this.collectPlayer = new Int32Array(MAX_COLLECT_EVENTS);
    this.collectX = new Float32Array(MAX_COLLECT_EVENTS);
    this.collectY = new Float32Array(MAX_COLLECT_EVENTS);
  }

  get count(): number {
    return this.pool.count;
  }

  /** A scratch request to fill and pass straight to `spawn`. Never held across calls. */
  get request(): DropRequest {
    return this.req;
  }

  /**
   * Put a pickup in the world.
   *
   * Returns the slot, or -1 when the pool was full AND the value could not be merged. Callers do
   * not need to care: no experience is lost either way.
   */
  spawn(r: DropRequest): number {
    const handle = this.pool.alloc();
    if (handle === NULL_HANDLE) {
      // Pool full. Fold the value into a nearby gem rather than dropping it on the floor.
      if (IS_GEM[r.kind] === true && r.value > 0) {
        const host = this.nearestGem(r.x, r.y);
        if (host >= 0) {
          this.value[host] += r.value;
          // A merged gem reads as the next tier up so the player can see the ground is valuable.
          if (this.value[host] >= GEM_VALUE[PICKUP.gemLarge]) this.kind[host] = PICKUP.gemLarge;
          else if (this.value[host] >= GEM_VALUE[PICKUP.gemMedium]) this.kind[host] = PICKUP.gemMedium;
          this.totalMerged++;
          this.totalMergedValue += r.value;
        }
      }
      return -1;
    }

    const slot = handle & 0xfffff;
    this.x[slot] = r.x;
    this.y[slot] = r.y;
    this.vx[slot] = r.vx;
    this.vy[slot] = r.vy;
    this.value[slot] = r.value;
    this.kind[slot] = r.kind;
    this.lockedTo[slot] = NO_OWNER;
    this.age[slot] = 0;
    this.ttl[slot] = IS_GEM[r.kind] === true || r.kind === PICKUP.chest ? 0 : CONSUMABLE_TTL;
    this.totalSpawned++;
    return slot;
  }

  /** Convenience for the common case: one gem of a tier at a point. */
  dropGem(kind: number, x: number, y: number, value: number, vx = 0, vy = 0): number {
    const r = this.req;
    r.kind = kind;
    r.x = x;
    r.y = y;
    r.value = value;
    r.vx = vx;
    r.vy = vy;
    return this.spawn(r);
  }

  remove(slot: number): void {
    if (!this.pool.isSlotAlive(slot)) return;
    this.pool.freeSlot(slot);
    this.lockedTo[slot] = NO_OWNER;
  }

  /** Start (or extend) a vacuum sweep. */
  startVacuum(ticks: number = 30): void {
    if (ticks > this.vacuumTicks) this.vacuumTicks = ticks;
  }

  get vacuumActive(): boolean {
    return this.vacuumTicks > 0;
  }

  clear(): void {
    this.pool.clear();
    this.vacuumTicks = 0;
    this.collectCount = 0;
    this.xpBanked = 0;
    this.goldBanked = 0;
    this.healBanked = 0;
    this.chestsTaken = 0;
    this.vacuumsTaken = 0;
    this.bombsTaken = 0;
    this.freezesTaken = 0;
    this.totalSpawned = 0;
    this.totalCollected = 0;
    this.totalMerged = 0;
    this.totalExpired = 0;
    this.totalMergedValue = 0;
  }

  /** Total experience sitting on the ground. For the dev menu and the "gems left" readout. */
  xpOnGround(): number {
    const slots = this.pool.slots;
    const n = this.pool.count;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (IS_GEM[this.kind[s]] === true) sum += this.value[s];
    }
    return sum;
  }

  /**
   * One tick.
   *
   * Order matters and is fixed: scatter decays, lock-on is decided, locked pickups accelerate in,
   * collection is tested, then expiry. Any other order produces a different collection sequence on
   * a co-op guest and a replay, which is a desync.
   */
  update(players: PlayerStore, stats: Stats, _rng: Rng): void {
    this.collectCount = 0;
    this.xpBanked = 0;
    this.goldBanked = 0;
    this.healBanked = 0;
    this.chestsTaken = 0;
    this.vacuumsTaken = 0;
    this.bombsTaken = 0;
    this.freezesTaken = 0;

    const vacuum = this.vacuumTicks > 0;
    if (this.vacuumTicks > 0) this.vacuumTicks--;

    // Hoisted once per tick: reading a stat per pickup would be thousands of lookups a frame.
    const magnetRadius = BASE_MAGNET_RADIUS * (stats.get(STAT.magnet) / STAT_SCALE);
    const magnetSq = magnetRadius * magnetRadius;
    const collectSq = COLLECT_RADIUS * COLLECT_RADIUS;

    const slots = this.pool.slots;
    // Backwards: collecting swap-removes the last live slot into the current index.
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const s = slots[i];
      this.age[s]++;

      let px = 0;
      let py = 0;
      let owner = this.lockedTo[s];

      // A locked owner who goes down or dies releases the pickup back to the floor.
      if (owner >= 0 && players.upright[owner] !== 1) {
        owner = NO_OWNER;
        this.lockedTo[s] = NO_OWNER;
      }

      if (owner < 0) {
        const nearest = players.nearestAlive(this.x[s], this.y[s]);
        // `upright` is checked as well as `nearestAlive` on purpose: it is the single flag every
        // system agrees on for "can this player interact", and a pickup re-locking onto someone who
        // just went down would undo the release two lines above.
        if (nearest >= 0 && players.upright[nearest] === 1) {
          px = players.x[nearest];
          py = players.y[nearest];
          const dx = px - this.x[s];
          const dy = py - this.y[s];
          const d2 = dx * dx + dy * dy;
          const inRange = d2 <= magnetSq;
          const swept = vacuum && IS_GEM[this.kind[s]] === true;
          if (inRange || swept) {
            owner = nearest;
            this.lockedTo[s] = nearest;
          }
        }
      } else {
        px = players.x[owner];
        py = players.y[owner];
      }

      if (owner >= 0) {
        // Locked on: accelerate straight at the owner, capped, then integrate.
        const dx = px - this.x[s];
        const dy = py - this.y[s];
        const d2 = dx * dx + dy * dy;

        if (d2 <= collectSq) {
          this.collect(s, owner);
          continue;
        }

        const d = Math.sqrt(d2);
        const inv = d > 0 ? 1 / d : 0;
        this.vx[s] += dx * inv * PULL_ACCEL * TICK_SECONDS;
        this.vy[s] += dy * inv * PULL_ACCEL * TICK_SECONDS;

        const sp2 = this.vx[s] * this.vx[s] + this.vy[s] * this.vy[s];
        if (sp2 > MAX_PULL_SPEED * MAX_PULL_SPEED) {
          const scale = MAX_PULL_SPEED / Math.sqrt(sp2);
          this.vx[s] *= scale;
          this.vy[s] *= scale;
        }
      } else {
        // Free on the floor: bleed off the spawn scatter so drops settle instead of sliding away.
        this.vx[s] *= 0.86;
        this.vy[s] *= 0.86;
        if (this.vx[s] * this.vx[s] + this.vy[s] * this.vy[s] < 0.25) {
          this.vx[s] = 0;
          this.vy[s] = 0;
        }
      }

      this.x[s] += this.vx[s] * TICK_SECONDS;
      this.y[s] += this.vy[s] * TICK_SECONDS;

      if (this.ttl[s] > 0) {
        this.ttl[s]--;
        if (this.ttl[s] === 0) {
          this.totalExpired++;
          this.remove(s);
        }
      }
    }
  }

  /** Bank a pickup and report it. Never applies anything itself. */
  private collect(slot: number, player: number): void {
    const kind = this.kind[slot];
    const value = this.value[slot];

    switch (kind) {
      case PICKUP.gemSmall:
      case PICKUP.gemMedium:
      case PICKUP.gemLarge:
        this.xpBanked += value;
        break;
      case PICKUP.gold:
        this.goldBanked += value;
        break;
      case PICKUP.health:
        this.healBanked += value > 0 ? value : HEALTH_PICKUP_AMOUNT;
        break;
      case PICKUP.chest:
        this.chestsTaken++;
        break;
      case PICKUP.vacuum:
        this.vacuumsTaken++;
        this.startVacuum(45);
        break;
      case PICKUP.bomb:
        this.bombsTaken++;
        break;
      case PICKUP.freeze:
        this.freezesTaken++;
        break;
      default:
        break;
    }

    if (this.collectCount < MAX_COLLECT_EVENTS) {
      const e = this.collectCount++;
      this.collectKind[e] = kind;
      this.collectValue[e] = value;
      this.collectPlayer[e] = player;
      this.collectX[e] = this.x[slot];
      this.collectY[e] = this.y[slot];
    }

    this.totalCollected++;
    this.remove(slot);
  }

  /**
   * Closest gem to a point, for merging. Linear over live pickups.
   *
   * This only runs when the pool is already full, i.e. at most once per refused drop, and the pool
   * is 1024 entries. That is cheap enough, and the alternative — a second spatial grid maintained
   * every tick for a path that fires rarely — costs more in the common case.
   */
  private nearestGem(x: number, y: number): number {
    const slots = this.pool.slots;
    const n = this.pool.count;
    let best = -1;
    let bestD2 = MERGE_RADIUS_SQ;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (IS_GEM[this.kind[s]] !== true) continue;
      const dx = this.x[s] - x;
      const dy = this.y[s] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = s;
      }
    }
    // Nothing within reach: fold into any gem at all rather than lose the experience.
    if (best < 0) {
      for (let i = 0; i < n; i++) {
        const s = slots[i];
        if (IS_GEM[this.kind[s]] === true) return s;
      }
    }
    return best;
  }
}

/**
 * Drop table.
 *
 * Every enemy kind gets a chance of each tier plus a chance of gold, in permille, scaled by luck.
 * Rolled from the seeded `drop` stream so a replay lands the same gems in the same places.
 *
 * Rows, not code: a new enemy is a new row here and nothing else changes.
 */
export interface DropRule {
  /** Chance in permille that this enemy drops any gem at all, before luck. */
  gemChance: number;
  /** Chance in permille, given a gem drops, that it is the medium tier. */
  mediumChance: number;
  /** Chance in permille, given a gem drops, that it is the large tier. Tested before medium. */
  largeChance: number;
  /** Chance in permille of a coin, independent of the gem roll. */
  goldChance: number;
  /** Coins granted when the gold roll passes. */
  goldAmount: number;
}

export const DEFAULT_DROP_RULE: DropRule = {
  gemChance: 1000,
  mediumChance: 40,
  largeChance: 4,
  goldChance: 15,
  goldAmount: 1,
};

/** A boss is worth stopping for. */
export const BOSS_DROP_RULE: DropRule = {
  gemChance: 1000,
  mediumChance: 0,
  largeChance: 1000,
  goldChance: 1000,
  goldAmount: 25,
};

/**
 * Roll one enemy's drops into the store.
 *
 * `luck` shifts gem tier and coin odds but never the "did anything drop" roll — a run where kills
 * sometimes produce literally nothing feels broken regardless of what the numbers say.
 */
export function rollDrops(
  store: PickupStore,
  rule: DropRule,
  x: number,
  y: number,
  stats: Stats,
  rng: Rng,
): void {
  const luck = stats.get(STAT.luck) / STAT_SCALE;
  const gemMul = stats.get(STAT.gemValue) / STAT_SCALE;

  if (rule.gemChance >= 1000 || rng.nextInt(1000) < rule.gemChance) {
    const largeRoll = Math.min(1000, Math.round(rule.largeChance * luck));
    const mediumRoll = Math.min(1000, Math.round(rule.mediumChance * luck));
    let kind: number = PICKUP.gemSmall;
    if (rng.nextInt(1000) < largeRoll) kind = PICKUP.gemLarge;
    else if (rng.nextInt(1000) < mediumRoll) kind = PICKUP.gemMedium;

    // Whole numbers only: gem values are summed into experience, which is hashed for co-op.
    const value = Math.max(1, Math.trunc(GEM_VALUE[kind] * gemMul));
    store.dropGem(kind, x, y, value);
  }

  const goldRoll = Math.min(1000, Math.round(rule.goldChance * luck));
  if (goldRoll > 0 && rng.nextInt(1000) < goldRoll) {
    const r = store.request;
    r.kind = PICKUP.gold;
    r.x = x;
    r.y = y;
    r.value = rule.goldAmount;
    // Scatter the coin off the gem so they don't sit on the same pixel.
    r.vx = (rng.nextInt(41) - 20) * 2;
    r.vy = (rng.nextInt(41) - 20) * 2;
    store.spawn(r);
  }
}
