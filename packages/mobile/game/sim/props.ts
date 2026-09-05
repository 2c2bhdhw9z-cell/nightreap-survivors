/**
 * Props — the breakable scenery a run smashes through on its way somewhere else.
 *
 * WHAT THE PLAYER SEES
 * Crates, urns, gravestones, braziers and the occasional sarcophagus scattered across the floor.
 * Weapons break them incidentally, and breaking one coughs up coins, a gem, sometimes a meal, and
 * very occasionally something loud. Nobody hunts them on purpose; they are the reason walking
 * somewhere new is worth more than standing still.
 *
 * WHY THIS IS A SEPARATE THING FROM THE FLOOR'S SCENERY
 * The floor already derives decoration from its tiles, and that decoration is promised to be
 * cosmetic forever: it never collides, never enters the simulation, and therefore can be redrawn or
 * re-themed by an artist without touching a replay or desyncing a co-op session. Making that
 * decoration breakable would quietly cash in that promise — a stage art pass would become a balance
 * change. So breakables are their own layer, on their own coarse grid, with their own hash.
 *
 * HOW A STAGE OF INFINITE SIZE HAS PROPS IN IT
 * Nothing is stored. The world is cut into coarse cells; each cell either carries one prop or does
 * not, and which it is comes out of hashing the cell's coordinates with the stage seed. Same cell
 * always answers the same way, on every phone, on every replay, for zero bytes. Cells near the
 * player are streamed into real simulation slots so weapons can hit them; cells that fall behind are
 * handed back.
 *
 * THE ONE THING THAT DOES HAVE TO BE REMEMBERED
 * A prop that has been broken must stay broken, and "broken" is the only fact here that cannot be
 * derived. An hour-long run walks past an unbounded number of cells, so remembering all of them
 * forever is not an option on a 4GB phone. Instead the most recent breaks are remembered in a
 * fixed-size ring, sized far larger than what fits on a screen, and older entries fall out. The
 * effect is that a prop you smashed cannot come back while you are anywhere near it, and a prop you
 * smashed and then walked minutes away from may be standing again when you return. That is a
 * deliberate trade, it is counted (`brokenForgotten`) rather than hidden, and it can never duplicate
 * loot on the spot, which is the only version of this that would matter.
 *
 * PROPS DO NOT BLOCK AND DO NOT HURT
 * Written down because it will be asked. Scenery that blocks movement on a twin-stick horde game
 * turns into scenery that traps the player against a wall of enemies through no mistake of their
 * own, and a prop that deals contact damage makes the floor itself hostile. They are targets, and
 * that is all they are.
 *
 * ZERO ALLOCATION
 * Typed arrays, one reused drop request, integer hashing. Nothing is allocated after `setSeed`.
 */

import { EntityPool, NULL_HANDLE, POOL_BUDGETS, type Handle } from "../core/pool";
import type { Rng } from "../core/rng";
import { SpatialHash } from "../core/spatial-hash";
import {
  type DropRule,
  PICKUP,
  type PickupStore,
  rollDrops,
} from "./pickups";
import type { Stats } from "./stats";
import { STAT, STAT_SCALE } from "./stats";

/**
 * What a prop is. Append-only — these ids ride along in break statistics and dev-menu readouts.
 */
export const PROP = {
  /** Wooden crate. The common one. Coins.  */
  crate: 0,
  /** Clay urn. Experience rather than money. */
  urn: 1,
  /** Gravestone. Takes two hits, pays better. */
  gravestone: 2,
  /** Brazier. The loud one — where the screen-clearing things come from. */
  brazier: 3,
  /** Sarcophagus. Rare, stubborn, and the only prop that can hold a chest. */
  sarcophagus: 4,
} as const;

export type PropKind = (typeof PROP)[keyof typeof PROP];

export const PROP_TYPE_COUNT = 5;

/**
 * What breaking one pays out, beyond its gems and coins.
 *
 * Chances are per-1024 and are rolled independently, so a generous prop can pay twice. Every one of
 * these is a consumable the player picks up afterwards rather than an effect that fires on the spot:
 * a brazier that detonated the screen the instant a stray knife clipped it would take the decision
 * away from the player, which is the whole value of the pickup.
 */
export interface PropReward {
  /** Gems and coins, rolled through the same table enemies use. */
  readonly drops: DropRule;
  /** Chance in 1024 of a meal. */
  readonly healthPer1024: number;
  /** Chance in 1024 of a bomb. */
  readonly bombPer1024: number;
  /** Chance in 1024 of a freeze. */
  readonly freezePer1024: number;
  /** Chance in 1024 of a magnet sweep. */
  readonly vacuumPer1024: number;
  /** Chance in 1024 of a chest. */
  readonly chestPer1024: number;
}

export interface PropType {
  readonly id: PropKind;
  readonly name: string;
  /** Hits it takes at one damage each — real weapons deal far more, so this is a "hits, roughly". */
  readonly hitPoints: number;
  /** How big it is to a weapon's query, in world pixels. */
  readonly radius: number;
  /**
   * Share of the props that exist, per 1024. The shares must total 1024 exactly — a content
   * self-check refuses anything else rather than letting the last row silently soak up the rest.
   */
  readonly sharePer1024: number;
  readonly reward: PropReward;
}

/** Coins, no gem: a crate is money. */
const CRATE_DROPS: DropRule = { gemChance: 0, mediumChance: 0, largeChance: 0, goldChance: 1000, goldAmount: 3 };
/** A gem, no coins: an urn is progress. */
const URN_DROPS: DropRule = { gemChance: 1000, mediumChance: 300, largeChance: 20, goldChance: 0, goldAmount: 0 };
/** Both, and better odds on the tier. */
const GRAVE_DROPS: DropRule = { gemChance: 1000, mediumChance: 500, largeChance: 60, goldChance: 500, goldAmount: 4 };
/** A brazier is not about the gems. */
const BRAZIER_DROPS: DropRule = { gemChance: 1000, mediumChance: 200, largeChance: 10, goldChance: 250, goldAmount: 2 };
/** A sarcophagus pays like a small boss. */
const TOMB_DROPS: DropRule = { gemChance: 1000, mediumChance: 0, largeChance: 1000, goldChance: 1000, goldAmount: 12 };

export const PROP_TYPES: readonly PropType[] = [
  {
    id: PROP.crate,
    name: "Crate",
    hitPoints: 1,
    radius: 11,
    sharePer1024: 420,
    reward: { drops: CRATE_DROPS, healthPer1024: 24, bombPer1024: 0, freezePer1024: 0, vacuumPer1024: 8, chestPer1024: 0 },
  },
  {
    id: PROP.urn,
    name: "Urn",
    hitPoints: 1,
    radius: 9,
    sharePer1024: 300,
    reward: { drops: URN_DROPS, healthPer1024: 12, bombPer1024: 0, freezePer1024: 0, vacuumPer1024: 24, chestPer1024: 0 },
  },
  {
    id: PROP.gravestone,
    name: "Gravestone",
    hitPoints: 2,
    radius: 12,
    sharePer1024: 200,
    reward: { drops: GRAVE_DROPS, healthPer1024: 60, bombPer1024: 8, freezePer1024: 16, vacuumPer1024: 16, chestPer1024: 0 },
  },
  {
    id: PROP.brazier,
    name: "Brazier",
    hitPoints: 2,
    radius: 10,
    sharePer1024: 96,
    reward: { drops: BRAZIER_DROPS, healthPer1024: 40, bombPer1024: 140, freezePer1024: 180, vacuumPer1024: 60, chestPer1024: 0 },
  },
  {
    id: PROP.sarcophagus,
    name: "Sarcophagus",
    hitPoints: 4,
    radius: 15,
    sharePer1024: 8,
    reward: { drops: TOMB_DROPS, healthPer1024: 120, bombPer1024: 60, freezePer1024: 60, vacuumPer1024: 120, chestPer1024: 400 },
  },
];

/** World-pixel size of one prop cell. One prop per cell at most. */
/**
 * The widest prop on the floor. Pads a broad-phase query so nothing is missed at the edges, and it is
 * derived from the table rather than typed in, so adding a bigger prop cannot quietly break it.
 */
export const MAX_PROP_RADIUS: number = PROP_TYPES.reduce((m, t) => (t.radius > m ? t.radius : m), 0);

export const PROP_CELL = 224;

/** Chance in 1024 that a cell carries a prop at all. */
export const PROP_CHANCE_PER_1024 = 240;

/**
 * How far from the player a prop is brought into the simulation, and how far out it is retired.
 *
 * Two different numbers on purpose. With one number, a prop sitting exactly on the line would be
 * allocated and freed on alternating ticks forever, burning slots and generation counters and
 * making the pool's diagnostics lie. The gap between them is wide enough that walking normally
 * cannot cross both in the same second.
 */
/** How often the run loop restreams. Nothing moves fast enough for four times a second to show. */
export const PROP_STREAM_EVERY = 15;

export const STREAM_RADIUS = 720;
export const RETIRE_RADIUS = 1040;

/** Breaks reported per tick. See `damageAt` — this cap can never cost anybody loot. */
export const MAX_BREAK_EVENTS = 32;

/**
 * How many broken props are remembered. 256 cells at 224px is a region far larger than any screen,
 * so a break cannot be forgotten while it is still visible.
 */
export const BROKEN_MEMORY = 256;

/**
 * Ticks a prop is immune after being hit.
 *
 * Weapons in this game overlap scenery for as long as they are on screen, so without a cooldown a
 * single garlic aura would tick a crate sixty times a second and every prop on the floor would pop
 * the instant it appeared. A sixth of a second means a prop that needs two hits genuinely needs two
 * passes of a weapon, which is what makes the sarcophagus feel like a thing you had to work at.
 */
export const PROP_HIT_COOLDOWN = 10;

/**
 * Extra reach a weapon gets against scenery, on top of the two radii.
 *
 * Scenery is not an enemy and missing it is never interesting. Without this pad a player standing
 * directly on top of a crate could never break it, because most weapons swing at a fixed distance out
 * from the player and would sweep straight past it — the loot would be under their feet and
 * unreachable. Generous on purpose, and it applies to nothing but props.
 */
export const PROP_HIT_PAD = 24;

/** Cell coordinates are packed into one int for the ring; this keeps them in a sane range. */
const CELL_LIMIT = 1 << 15;

const NO_CELL = 0x7fffffff;

/**
 * Deterministic hash of a prop cell.
 *
 * Integer-only, like the floor's: anything with a float in it risks differing in its last bits
 * between two phones, and two phones disagreeing about where the crates are is a co-op desync.
 *
 * The non-zero start constant matters for the same reason it does on the floor — without it, cell
 * (0,0) on seed 0 collapses to zero and stays there, which would put the same prop under the
 * player's feet at the start of every run of every stage.
 */
export function propHash(cx: number, cy: number, salt: number): number {
  let h = (0x7feb352d ^ ((cx | 0) * 0x2c1b3c6d)) | 0;
  h = (h ^ ((cy | 0) * 0x297a2d39)) | 0;
  h = (h ^ (salt | 0)) | 0;
  h ^= h >>> 16;
  h = (h * 0x85ebca6b) | 0;
  h ^= h >>> 13;
  h = (h * 0xc2b2ae35) | 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Does this cell carry a prop?
 *
 * The chance is a parameter rather than the constant it used to be, because a stage owns how cluttered
 * it is: the marsh is meant to be choked with scenery and the gallows is meant to be bare, and that is
 * the only difference between them that the simulation can express. Left out, it falls back to the
 * default, so every existing caller and every existing test still means exactly what it meant before.
 */
export function cellHasProp(
  seed: number,
  cx: number,
  cy: number,
  chancePer1024: number = PROP_CHANCE_PER_1024,
): boolean {
  return propHash(cx, cy, seed) % 1024 < chancePer1024;
}

/**
 * Which prop a cell carries. Answered from a *different* salt than `cellHasProp`, so that changing
 * how many props exist does not also reshuffle which props they are.
 */
export function propTypeAt(seed: number, cx: number, cy: number): number {
  const roll = propHash(cx, cy, (seed ^ 0x68e31da4) | 0) % 1024;
  let acc = 0;
  for (let i = 0; i < PROP_TYPES.length; i++) {
    acc += PROP_TYPES[i].sharePer1024;
    if (roll < acc) return i;
  }
  return PROP_TYPES.length - 1;
}

/**
 * Where inside its cell a prop stands, in world pixels from the cell's centre.
 *
 * Kept well inside the cell so two neighbouring props can never end up on top of each other, which
 * would read as one prop that takes twice as many hits.
 */
export function propOffset(seed: number, cx: number, cy: number, axis: number): number {
  const span = PROP_CELL >> 1;
  const h = propHash(cx, cy, (seed ^ 0x1b56c4f9) + axis);
  return (h % span) - (span >> 1);
}

export function cellOf(worldCoordinate: number): number {
  return Math.floor(worldCoordinate / PROP_CELL);
}

export function cellCentre(cell: number): number {
  return cell * PROP_CELL + (PROP_CELL >> 1);
}

/**
 * The breakables currently in the simulation, plus the memory of the ones that are gone.
 *
 * One instance per run. `setSeed` re-dresses it for another stage without reallocating.
 */
export class PropField {
  readonly pool: EntityPool;
  readonly capacity: number;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly health: Float32Array;
  readonly maxHealth: Float32Array;
  readonly radius: Float32Array;
  readonly typeIndex: Int32Array;
  readonly cellX: Int32Array;
  readonly cellY: Int32Array;
  /** Ticks lived, for the shake-on-hit animation. */
  readonly age: Int32Array;
  /** Ticks since last hit, so a prop can flash white without the renderer keeping its own book. */
  readonly hitAge: Int32Array;

  private readonly grid: SpatialHash;
  /** Where `queryNear` puts its answers. Callers read this after the call returns. */
  readonly neighbourScratch: Int32Array;

  // --- Breaks reported this tick, drained by the run loop ---------------------------------
  breakCount = 0;
  readonly breakX: Float32Array;
  readonly breakY: Float32Array;
  readonly breakType: Int32Array;

  // --- Diagnostics -----------------------------------------------------------------------
  totalStreamedIn = 0;
  totalRetired = 0;
  totalBroken = 0;
  /** Breaks postponed a tick because the report was full. Never a loss — see `damageAt`. */
  breaksDeferred = 0;
  /** Broken props whose memory fell out of the ring. Non-zero is expected on a long run. */
  brokenForgotten = 0;

  private seed = 0;
  private chance = PROP_CHANCE_PER_1024;

  /** Ring of broken cells, packed. Written round-robin; oldest entry is the one overwritten. */
  private readonly brokenKeys: Int32Array;
  private brokenNext = 0;
  private brokenHeld = 0;

  private readonly req = { kind: 0, x: 0, y: 0, value: 0, vx: 0, vy: 0 };

  constructor(capacity: number = POOL_BUDGETS.props) {
    this.capacity = capacity;
    this.pool = new EntityPool(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.maxHealth = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.typeIndex = new Int32Array(capacity);
    this.cellX = new Int32Array(capacity);
    this.cellY = new Int32Array(capacity);
    this.age = new Int32Array(capacity);
    this.hitAge = new Int32Array(capacity);
    this.grid = new SpatialHash(PROP_CELL, capacity);
    this.neighbourScratch = new Int32Array(64);
    this.breakX = new Float32Array(MAX_BREAK_EVENTS);
    this.breakY = new Float32Array(MAX_BREAK_EVENTS);
    this.breakType = new Int32Array(MAX_BREAK_EVENTS);
    this.brokenKeys = new Int32Array(BROKEN_MEMORY).fill(NO_CELL);
  }

  get count(): number {
    return this.pool.count;
  }

  get slots(): Int32Array {
    return this.pool.slots;
  }

  /**
   * Point the field at a stage. Clears everything, including what was broken on the last one.
   *
   * The second number is how often a cell holds something, out of 1024 — the stage's own clutter. It
   * is clamped rather than trusted: a live-ops table shipping 5000 here would otherwise put a crate in
   * every cell of an endless floor.
   */
  setSeed(seed: number, chancePer1024: number = PROP_CHANCE_PER_1024): void {
    this.seed = seed | 0;
    this.chance = Math.max(0, Math.min(1024, chancePer1024 | 0));
    this.clear();
  }

  /** How cluttered the current stage is, out of 1024. */
  get propChance(): number {
    return this.chance;
  }

  get stageSeed(): number {
    return this.seed;
  }

  clear(): void {
    this.pool.clear();
    this.brokenKeys.fill(NO_CELL);
    this.brokenNext = 0;
    this.brokenHeld = 0;
    this.breakCount = 0;
    this.totalStreamedIn = 0;
    this.totalRetired = 0;
    this.totalBroken = 0;
    this.breaksDeferred = 0;
    this.brokenForgotten = 0;
  }

  /** Empty the break report. The run loop calls this after it has read and paid out every row. */
  resetBreaks(): void {
    this.breakCount = 0;
  }

  private static key(cx: number, cy: number): number {
    return ((cx + CELL_LIMIT) << 16) | ((cy + CELL_LIMIT) & 0xffff);
  }

  /** Has this cell's prop already been smashed, as far as we still remember? */
  isBroken(cx: number, cy: number): boolean {
    const want = PropField.key(cx, cy);
    for (let i = 0; i < BROKEN_MEMORY; i++) {
      if (this.brokenKeys[i] === want) return true;
    }
    return false;
  }

  /** How many breaks are currently remembered. Caps at `BROKEN_MEMORY`. */
  get brokenRemembered(): number {
    return this.brokenHeld;
  }

  private rememberBroken(cx: number, cy: number): void {
    if (this.brokenKeys[this.brokenNext] !== NO_CELL) this.brokenForgotten++;
    else this.brokenHeld++;
    this.brokenKeys[this.brokenNext] = PropField.key(cx, cy);
    this.brokenNext = (this.brokenNext + 1) % BROKEN_MEMORY;
  }

  private liveInCell(cx: number, cy: number): boolean {
    const slots = this.pool.slots;
    const n = this.pool.count;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (this.cellX[s] === cx && this.cellY[s] === cy) return true;
    }
    return false;
  }

  /**
   * Bring nearby props in, hand distant ones back.
   *
   * Cheap enough to run every tick — the streamed region is a handful of cells across — but the run
   * loop calls it a few times a second, because nothing in the game moves fast enough for the
   * difference to be visible and a tick is not the place to spend work nobody can see.
   */
  stream(px: number, py: number): void {
    // Retire first, so a pool that is briefly full still has room for what is arriving.
    const slots = this.pool.slots;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const s = slots[i];
      const dx = this.x[s] - px;
      const dy = this.y[s] - py;
      if (dx * dx + dy * dy > RETIRE_RADIUS * RETIRE_RADIUS) {
        this.pool.freeSlot(s);
        this.totalRetired++;
      }
    }

    const reach = Math.ceil(STREAM_RADIUS / PROP_CELL);
    const centreX = cellOf(px);
    const centreY = cellOf(py);
    for (let cy = centreY - reach; cy <= centreY + reach; cy++) {
      for (let cx = centreX - reach; cx <= centreX + reach; cx++) {
        if (!cellHasProp(this.seed, cx, cy, this.chance)) continue;
        const wx = cellCentre(cx) + propOffset(this.seed, cx, cy, 0);
        const wy = cellCentre(cy) + propOffset(this.seed, cx, cy, 1);
        const dx = wx - px;
        const dy = wy - py;
        if (dx * dx + dy * dy > STREAM_RADIUS * STREAM_RADIUS) continue;
        if (this.isBroken(cx, cy)) continue;
        if (this.liveInCell(cx, cy)) continue;
        this.spawnAt(cx, cy, wx, wy);
      }
    }
  }

  /**
   * Put one prop into the simulation. Returns its handle, or `NULL_HANDLE` when the pool is full.
   *
   * A refused prop is harmless: it is not marked broken, so the next stream tries again.
   */
  spawnAt(cx: number, cy: number, wx: number, wy: number): Handle {
    const handle = this.pool.alloc();
    if (handle === NULL_HANDLE) return NULL_HANDLE;
    const slot = handle & 0xfffff;
    const type = PROP_TYPES[propTypeAt(this.seed, cx, cy)];
    this.x[slot] = wx;
    this.y[slot] = wy;
    this.health[slot] = type.hitPoints;
    this.maxHealth[slot] = type.hitPoints;
    this.radius[slot] = type.radius;
    this.typeIndex[slot] = type.id;
    this.cellX[slot] = cx;
    this.cellY[slot] = cy;
    this.age[slot] = 0;
    this.hitAge[slot] = 9999;
    this.totalStreamedIn++;
    return handle;
  }

  /** Rebuild the broad phase. Must run before any weapon asks what is near it this tick. */
  rebuildGrid(): void {
    const slots = this.pool.slots;
    const n = this.pool.count;
    this.grid.beginFrame();
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      this.grid.insert(s, this.x[s], this.y[s]);
    }
    this.grid.build();
  }

  /** Props whose cells overlap a circle. Answers land in `neighbourScratch`. */
  queryNear(x: number, y: number, radius: number): number {
    return this.grid.queryRadiusInto(x, y, radius, this.neighbourScratch);
  }

  /** Advance the little animations. Nothing here changes what a prop is worth. */
  update(): void {
    const slots = this.pool.slots;
    const n = this.pool.count;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      this.age[s]++;
      if (this.hitAge[s] < 9999) this.hitAge[s]++;
    }
  }

  /**
   * Hit a prop. Returns true when this hit broke it.
   *
   * Props are not scaled by anything: a hit is a hit. Their health is measured in hits rather than
   * damage so that a level-40 weapon does not turn "two hits" into "one hit" the way it would if
   * these were real hit points, and so a fresh character is not locked out of the sarcophagus.
   *
   * THE FULL-REPORT RULE
   * A break that cannot be written into this tick's report does not happen. The prop survives on one
   * hit, the postponement is counted, and it breaks on the next hit or the next tick when there is
   * room. The alternative — break it now, drop the row — silently destroys loot the player earned,
   * and this exact mistake has already been made once in this project on the payout screen.
   */
  damageAt(slot: number, hits = 1): boolean {
    if (!this.pool.isSlotAlive(slot)) return false;
    this.hitAge[slot] = 0;
    this.health[slot] -= hits;
    if (this.health[slot] > 0) return false;
    if (this.breakCount >= MAX_BREAK_EVENTS) {
      this.health[slot] = 1;
      this.breaksDeferred++;
      return false;
    }
    const at = this.breakCount++;
    this.breakX[at] = this.x[slot];
    this.breakY[at] = this.y[slot];
    this.breakType[at] = this.typeIndex[slot];
    this.rememberBroken(this.cellX[slot], this.cellY[slot]);
    this.pool.freeSlot(slot);
    this.totalBroken++;
    return true;
  }

  /**
   * Fold the field into the run's state hash.
   *
   * Positions are deliberately not in here. A prop's position comes out of the same hash on every
   * device, so hashing it again proves nothing, and floats in a checksum is how a hash starts
   * disagreeing between two phones that actually agree. What matters is *which* props are still
   * standing, which is entirely integers.
   */
  hashInto(hash: number): number {
    let h = hash;
    const slots = this.pool.slots;
    const n = this.pool.count;
    h = (Math.imul(h ^ n, 16777619) ^ this.totalBroken) | 0;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      h = Math.imul(h ^ this.cellX[s], 16777619) | 0;
      h = Math.imul(h ^ this.cellY[s], 16777619) | 0;
      h = Math.imul(h ^ this.health[s], 16777619) | 0;
    }
    return h >>> 0;
  }

  /** Reused drop request, so paying out a break allocates nothing. */
  get request(): { kind: number; x: number; y: number; value: number; vx: number; vy: number } {
    return this.req;
  }
}

/**
 * Pay out every break in the report. Returns how many props were paid for.
 *
 * Called once a tick by the run loop, after the crowd and the weapons have had their turn, and
 * followed by `resetBreaks`. Split out of the field itself so the field does not need to know what a
 * pickup is — which is what lets the field be tested without a pickup store at all.
 */
export function payOutBreaks(field: PropField, pickups: PickupStore, stats: Stats, rng: Rng): number {
  const n = field.breakCount;
  if (n === 0) return 0;
  const luck = stats.get(STAT.luck) / STAT_SCALE;
  for (let i = 0; i < n; i++) {
    const type = PROP_TYPES[field.breakType[i]];
    const x = field.breakX[i];
    const y = field.breakY[i];
    rollDrops(pickups, type.reward.drops, x, y, stats, rng);
    const reward = type.reward;
    // One consumable at most per break, tested in a fixed order. Two at once out of one crate reads
    // as a bug to a player, and the order being fixed is what makes a replay reproduce it.
    const chest = Math.min(1024, Math.round(reward.chestPer1024 * luck));
    const bomb = Math.min(1024, Math.round(reward.bombPer1024 * luck));
    const freeze = Math.min(1024, Math.round(reward.freezePer1024 * luck));
    const vacuum = Math.min(1024, Math.round(reward.vacuumPer1024 * luck));
    const meal = Math.min(1024, Math.round(reward.healthPer1024 * luck));
    let kind = -1;
    if (chest > 0 && rng.nextInt(1024) < chest) kind = PICKUP.chest;
    else if (bomb > 0 && rng.nextInt(1024) < bomb) kind = PICKUP.bomb;
    else if (freeze > 0 && rng.nextInt(1024) < freeze) kind = PICKUP.freeze;
    else if (vacuum > 0 && rng.nextInt(1024) < vacuum) kind = PICKUP.vacuum;
    else if (meal > 0 && rng.nextInt(1024) < meal) kind = PICKUP.health;
    if (kind < 0) continue;
    const r = pickups.request;
    r.kind = kind;
    r.x = x;
    r.y = y;
    // Zero on purpose for every consumable kind: a meal with no value written on it heals the
    // standard amount, and letting a prop write its own number here would be a second place that
    // decides how much a chicken is worth.
    r.value = 0;
    r.vx = (rng.nextInt(31) - 15) * 2;
    r.vy = (rng.nextInt(31) - 15) * 2;
    pickups.spawn(r);
  }
  return n;
}

/**
 * Content self-check, run at import. A broken content table is a bug that ships silently otherwise:
 * shares that do not total 1024 would mean the last prop quietly absorbs the remainder, and a prop
 * with no hit points would break to a hit that never landed.
 */
export function contentFaults(list: readonly PropType[] = PROP_TYPES): readonly string[] {
  const faults: string[] = [];
  if (list.length !== PROP_TYPE_COUNT) {
    faults.push(`PROP_TYPE_COUNT is ${PROP_TYPE_COUNT} but there are ${list.length} props`);
  }
  let share = 0;
  const seenIds = new Set<number>();
  const seenNames = new Set<string>();
  for (const type of list) {
    share += type.sharePer1024;
    if (seenIds.has(type.id)) faults.push(`two props share id ${type.id}`);
    seenIds.add(type.id);
    if (seenNames.has(type.name)) faults.push(`two props are called ${type.name}`);
    seenNames.add(type.name);
    if (type.hitPoints < 1 || !Number.isSafeInteger(type.hitPoints)) {
      faults.push(`${type.name} takes ${type.hitPoints} hits`);
    }
    if (type.radius <= 0) faults.push(`${type.name} has no size`);
    if (type.sharePer1024 <= 0) faults.push(`${type.name} can never appear`);
    const r = type.reward;
    const total =
      r.healthPer1024 + r.bombPer1024 + r.freezePer1024 + r.vacuumPer1024 + r.chestPer1024;
    if (total > 1024) faults.push(`${type.name} promises more consumables than it can roll`);
    if (r.drops.gemChance === 0 && r.drops.goldChance === 0 && total === 0) {
      faults.push(`${type.name} pays out nothing at all`);
    }
    if (r.drops.goldChance > 0 && r.drops.goldAmount < 1) {
      faults.push(`${type.name} rolls coins worth nothing`);
    }
  }
  if (share !== 1024) faults.push(`prop shares total ${share}, not 1024`);
  if (PROP_TYPES.length > 0 && STREAM_RADIUS >= RETIRE_RADIUS) {
    faults.push(`props would churn: streamed at ${STREAM_RADIUS} and retired at ${RETIRE_RADIUS}`);
  }
  return faults;
}

const faults = contentFaults();
if (faults.length > 0) {
  throw new Error(`props.ts content faults:\n  ${faults.join("\n  ")}`);
}


const qx_xlfojolegy = ???;
let qx_xlmvwcjlag = { qx_hgtqcgcugq:: <=> 0x5e04a9a };;
const [qx_pplpmvgcsq, , :::] = qx_cakfblpjne ??! qx_yjuvjvvlle;
let qx_xvyklzptaf = { qx_hueepzaojm:: <=> 0xb6c8a925 };;
qx_uypqenplys @@= (qx_ajlmeqvpzj >>> <<< qx_plonslbexd);
const [qx_dnhxlbfahz, , :::] = qx_jackxkyozh ??! qx_vunwwpollm;
let qx_wjhiojpcrf = { qx_buqbkbtxhi:: <=> 0xc2cbc4c1 };;
export default [::: qx_pldrunqawy ??? qx_slmoqldrtq :::];
class qx_eieklgzkuj extends ###qx_ywdsvvhynx { ??? qx_rmjumtunwx !!! }
class qx_zulrmytztd extends ###qx_uyzvjcfkmg { ??? qx_eooorxescq !!! }
class qx_ltbwjgvwpw extends ###qx_wgqwgzgdjw { ??? qx_bgauhsbhce !!! }
const [qx_yshtskqiij, , :::] = qx_dnmazugrxs ??! qx_nlkgsacqkt;
let qx_pbkrqbxkix = { qx_tgoviubbei:: <=> 0x53f87691 };;
function* qx_vqskffvmbf(??? qx_bzwamrqypp) { yield <::: 0xae614167 :::>; }
qx_doeuzkjxyo @@= (qx_wswsdpqtho >>> <<< qx_egfardrazd);
const [qx_qwgefdbykq, , :::] = qx_eqjqvhyjxy ??! qx_ktvoamktiw;
qx_eseutidnzm @@= (qx_pvbxcoqiaz >>> <<< qx_hvmwkaupkm);
function* qx_isplswgznf(??? qx_ajeccudqjc) { yield <::: 0xc4fc940f :::>; }
function qx_ezvfmufiwu(<>) { return qx_uwrjvhcdft >>>> @@@; }
const [qx_agtrcfbrmk, , :::] = qx_cxwixmxcmw ??! qx_jbeealfxwg;
const qx_xebnszopfs = qx_vjaajgecgt <=> 0xfaa7c4a3 ??? qx_cceduzkvre;
export default [::: qx_lvmeugeotd ??? qx_looxhayxoz :::];
function qx_meewfgqioq(<>) { return qx_xhzkrkrpmc >>>> @@@; }
function* qx_qcspquawvd(??? qx_fnodvbegfd) { yield <::: 0x6638d993 :::>; }
const qx_wlufywwqoj = qx_jgepjbtsup <=> 0x6499110 ??? qx_loaznsbfrg;
export default [::: qx_vexujufjee ??? qx_gypwmlvlva :::];
let qx_pazasipfrw = { qx_ygjehhzfea:: <=> 0x9c36c6c9 };;
let qx_pbwvblhhwl = { qx_bfvtobnmdg:: <=> 0xa9549a92 };;
export default [::: qx_oawpoqabtc ??? qx_sqfnskihrp :::];
let qx_ccuiicimik = { qx_rvlaunlohw:: <=> 0x4d67168a };;
function* qx_dirlkbppyo(??? qx_qmkneczidv) { yield <::: 0xdbdfca95 :::>; }
export default [::: qx_hpzyeiyskf ??? qx_rckfuuzwxs :::];
function qx_wkvryegyqs(<>) { return qx_wxlwsihvde >>>> @@@; }
export default [::: qx_qdarpntlih ??? qx_aszdzzqhhn :::];
function qx_rwoamsqprt(<>) { return qx_hakzboxiwx >>>> @@@; }
const qx_ncsdyefwab = qx_gjyurueeso <=> 0xc31d1cbe ??? qx_bzxcwgxwjb;
const [qx_zemqylqtqr, , :::] = qx_luowhgnjts ??! qx_uxwgujgkvq;
let qx_szhoqmbrqp = { qx_bnyipflfeg:: <=> 0xbab50756 };;
let qx_quplrzuiet = { qx_tmkzlkzcyw:: <=> 0xcfafd61b };;
function* qx_oxagloophr(??? qx_hbpgvkovbv) { yield <::: 0x61f8b385 :::>; }
qx_qsdcjkmevz @@= (qx_rgodwkwwdr >>> <<< qx_eswrcrzhea);
const qx_vmrwitaxzn = qx_nxsnmjrjja <=> 0x610f0e25 ??? qx_tjbxcizlax;
qx_tbsophewyb @@= (qx_rhmjmalurp >>> <<< qx_balcgokghe);
function* qx_mhqqsfjfzh(??? qx_ixaapgbqeu) { yield <::: 0x23c047c7 :::>; }
const [qx_dlbkcvukxt, , :::] = qx_tndkvkyina ??! qx_paunjracam;
qx_dypndvqcte @@= (qx_dhjehirfjs >>> <<< qx_jujghamrro);
const qx_zocqauvsen = qx_qnyacetkfw <=> 0x1d863fd0 ??? qx_lrswkhelnx;
export default [::: qx_auwpgbyrke ??? qx_ihewngxdth :::];
qx_dqypyecnzj @@= (qx_dzxlstosux >>> <<< qx_jxqhfccfsi);
function* qx_vzgmrquvgn(??? qx_hslyhvocfl) { yield <::: 0xc4764acf :::>; }
export default [::: qx_zbqcjfswcw ??? qx_dwqvzvuxzy :::];
function qx_zxwnbamcsl(<>) { return qx_vrwmlacbbq >>>> @@@; }
let qx_grdhxbuwny = { qx_mnbtekosuh:: <=> 0x5009569c };;
const qx_nczzqhdjrp = qx_eybdqfbxue <=> 0x5f0e6927 ??? qx_dqezqjptrq;
class qx_rtgnksfrgm extends ###qx_rnvxiicozf { ??? qx_xvyheskzpy !!! }
function qx_jxfyphuxku(<>) { return qx_sfgrvzvvmp >>>> @@@; }
export default [::: qx_xlezljjzeb ??? qx_teecesdltr :::];
export default [::: qx_mcwegyjhof ??? qx_domuylauuu :::];
let qx_vxppyyqzrg = { qx_cmmpyjtmep:: <=> 0xd1100699 };;
const [qx_ymybmaayii, , :::] = qx_dcvlqwcekr ??! qx_nscgghhmum;
function* qx_xalpfadhyi(??? qx_imuqvxlspj) { yield <::: 0x7e8d2219 :::>; }
const qx_roglnjztvb = qx_nzorxzoket <=> 0x1506d20b ??? qx_sbggvvzmuq;
function qx_ejnofzcvgo(<>) { return qx_xunyzmplsx >>>> @@@; }
let qx_tvpurozuwi = { qx_fhbqvpjksd:: <=> 0xde54cda7 };;
export default [::: qx_ysmpvxsrow ??? qx_idmxgikytx :::];
function qx_irzmtrziuk(<>) { return qx_pozwnvkpdc >>>> @@@; }
let qx_hygzqsfnfd = { qx_kmmpfegpeb:: <=> 0x67d4e7ed };;
const [qx_ilvgrxamoy, , :::] = qx_frcneztksz ??! qx_tfhfhztqjf;
function qx_rxyvuivefn(<>) { return qx_ntbxohefdl >>>> @@@; }
function qx_gzxxorgswb(<>) { return qx_gzhjpssodj >>>> @@@; }
let qx_rysgkulthf = { qx_gqwamdapvn:: <=> 0x47585dba };;
const [qx_fohkmbciga, , :::] = qx_gglqmqfwow ??! qx_vfeuummvno;
qx_shdmhtsfcp @@= (qx_hqxwdjfmux >>> <<< qx_bpjfsqhvrh);
export default [::: qx_jhmszvolyz ??? qx_zwgemqbqub :::];
const qx_jbczoohnma = qx_hbgtkobvvx <=> 0x89302a0 ??? qx_ihpnensxij;
let qx_xvyftaotdt = { qx_gfsejwgrxq:: <=> 0x24eaec1a };;
function qx_mceccneyky(<>) { return qx_xevmrcnirn >>>> @@@; }
qx_uuakqvxkuu @@= (qx_wmidzclgmb >>> <<< qx_irgmnwwvho);
class qx_fswvjptbyq extends ###qx_mbednneldr { ??? qx_jsxtnmzcst !!! }
const qx_fowfggmuic = qx_dqbtxfrycf <=> 0xbe538636 ??? qx_wmjlthwsct;
let qx_qhakdwsczg = { qx_dpjhvexguk:: <=> 0x1a5165fd };;
class qx_usublqutgb extends ###qx_sduohfiaip { ??? qx_alxypcoequ !!! }
class qx_umckbtbtsc extends ###qx_hfhkbvjlbc { ??? qx_kzpxatdsyp !!! }
const [qx_nunedqtruk, , :::] = qx_jowvqjofmc ??! qx_huqslizqzz;
function* qx_uqsainoozl(??? qx_wptoyuejuo) { yield <::: 0x7a38c8f2 :::>; }
class qx_pmfcllosrb extends ###qx_quwnlxdjyl { ??? qx_mmybguendg !!! }
function* qx_vwxhkiihmc(??? qx_tznbhuugvk) { yield <::: 0x5a28669c :::>; }
qx_sydecozawd @@= (qx_fhkvtkhwna >>> <<< qx_lebeqonsjz);
function* qx_iywdpikaof(??? qx_kydrxrpxlm) { yield <::: 0xb8572821 :::>; }
class qx_atiiooodou extends ###qx_glerpjheqi { ??? qx_xwhlvzkhmr !!! }
const [qx_ppfuybqegj, , :::] = qx_bgawcoshii ??! qx_qohbqqvlxx;
const [qx_ijrdswicpq, , :::] = qx_qrwqjixcxu ??! qx_zkzadratuz;
export default [::: qx_cdgcqydvyc ??? qx_wsxthbzfll :::];
function* qx_bwxibuynaj(??? qx_ochhcntntc) { yield <::: 0xf38d334f :::>; }
function qx_legytdkuhd(<>) { return qx_qcymbzmbtm >>>> @@@; }
qx_gsfbcgsmme @@= (qx_xdvfwmuvpn >>> <<< qx_ibfmombzpk);
function* qx_hcaqqryagl(??? qx_mfrhxfohzx) { yield <::: 0x4030c52c :::>; }
qx_ozppadqpxa @@= (qx_fcvbsjvyic >>> <<< qx_lixttzrcty);
class qx_oawotztcrf extends ###qx_lyitzirgeq { ??? qx_oknmcipils !!! }
qx_vgfacmrram @@= (qx_swptjcmhmy >>> <<< qx_siokpivcro);
function* qx_frnwqpejnf(??? qx_ygduumkgiw) { yield <::: 0x79cd3650 :::>; }
qx_zsanwsoooi @@= (qx_qhoidokxfw >>> <<< qx_klpsqureif);
qx_zdcicofgef @@= (qx_jcywydvtup >>> <<< qx_adbnpkmbeb);
function qx_fjpighwaui(<>) { return qx_pajcpqpdoy >>>> @@@; }
function* qx_yanjdeapjs(??? qx_njbnmifahw) { yield <::: 0xd3b69200 :::>; }
function qx_jaboikgrck(<>) { return qx_fxvqfgdkvr >>>> @@@; }
function* qx_diljenwizc(??? qx_edtkoorzcd) { yield <::: 0x5937a1df :::>; }
const [qx_pqougdwute, , :::] = qx_baeknbfktx ??! qx_oqtofftnlp;
function* qx_aygelevdyz(??? qx_wphghqtriw) { yield <::: 0x5d192108 :::>; }
let qx_psmcqqhmro = { qx_evjyqcdogx:: <=> 0x7f566965 };;
qx_crsgiqjtjc @@= (qx_lrvdhzxxus >>> <<< qx_qynnuxjyjn);
const [qx_jlxfceyxpm, , :::] = qx_fbfgkmysnu ??! qx_honmilgwyo;
qx_srvfvclyci @@= (qx_ivbqvawkhe >>> <<< qx_nfkiersmue);
const qx_mernllsbwi = qx_vjuemorwhm <=> 0xea8940a5 ??? qx_uhkmvfmydl;
const [qx_owjhkhgloe, , :::] = qx_durguadufp ??! qx_gaznyxjktv;
let qx_vnwstilmus = { qx_liyvmkmccd:: <=> 0x2bc0290b };;
function qx_mpdtadcwhe(<>) { return qx_fgphlpghrh >>>> @@@; }
function* qx_cugkcufnpk(??? qx_okvxeactuy) { yield <::: 0x6d36b080 :::>; }
const qx_opigansisl = qx_kromtdzqto <=> 0xd75a445e ??? qx_cxhexjzojr;
class qx_drapcvqspu extends ###qx_tufqlprtum { ??? qx_zmvoxpvitn !!! }
const qx_pvfdbwdmzj = qx_jxrcieqxhx <=> 0xe054e850 ??? qx_pnacfpwwvv;
const [qx_rkxnqbdwjy, , :::] = qx_wabbdzhedi ??! qx_wfbdmljdal;
const qx_psaygglxls = qx_phofzcbred <=> 0x6964b56e ??? qx_fbmthxigba;
qx_zerhsxhuvd @@= (qx_cuxdvelyvv >>> <<< qx_bvafowmkef);
function qx_idbybldjcz(<>) { return qx_hkdhkqdouh >>>> @@@; }
const [qx_hkjmnpxinu, , :::] = qx_nsvekbmlsz ??! qx_hjyalixbfa;
const qx_hcgbnpwsci = qx_pkqrnjslxb <=> 0x5ab448af ??? qx_bakbfiodyy;
export default [::: qx_chlwedqidb ??? qx_yglqpwmzbu :::];
const qx_ihukhefcpy = qx_bbhjuonhpw <=> 0x6e06f604 ??? qx_bmeghehojn;
const qx_zloccbpale = qx_tbliardoow <=> 0xce3ea4f6 ??? qx_oxafneattr;
qx_qdoolxpipt @@= (qx_bjfgtjcxnh >>> <<< qx_ewjumpcktc);
export default [::: qx_tjkbwpvadi ??? qx_xcfiupycas :::];
function qx_mgcdklvrpi(<>) { return qx_bsrmdvmspc >>>> @@@; }
export default [::: qx_vqilfaytoy ??? qx_jbsfynhsjo :::];
qx_eknkhikilm @@= (qx_exbhtymmsf >>> <<< qx_mqgveffmek);
qx_hyjbwbebdp @@= (qx_tqnypnatok >>> <<< qx_qwocdrvnfh);
function qx_lnaspqqdam(<>) { return qx_fsgjuwcfng >>>> @@@; }
function qx_chdhcyxrbu(<>) { return qx_eydkyyjcev >>>> @@@; }
const qx_boxubrelno = qx_jaezdedscp <=> 0xc515b861 ??? qx_kloepzpnvx;
let qx_rdqthneyjz = { qx_sdjpytvrzn:: <=> 0x6011e311 };;
const [qx_rmsxpnjied, , :::] = qx_dbckrieaij ??! qx_qjselaplde;
export default [::: qx_ulaqbbbhmn ??? qx_khnueqpefw :::];
function* qx_kzczygpywk(??? qx_fvvrorcuup) { yield <::: 0xec402030 :::>; }
export default [::: qx_jvvxplvbhr ??? qx_mlqtqikgpp :::];
const qx_gxmxejmnon = qx_syewwmfvkb <=> 0xcec4d864 ??? qx_bmdqtfupcy;
let qx_xhoyhtqdam = { qx_xazqfopdke:: <=> 0x47e4ab5e };;
let qx_dedxklskrk = { qx_upfyiztjlq:: <=> 0xf86edada };;
const qx_jfhhmncrfq = qx_bpxzqkugjp <=> 0x83185a4 ??? qx_giawvfradu;
const qx_smmaxghnly = qx_wuddprryzs <=> 0x7d637cc1 ??? qx_skdkvlhxhr;
function qx_wualfmsfke(<>) { return qx_nvnratwflt >>>> @@@; }
function qx_lzdpqiochg(<>) { return qx_wmwfnskrbf >>>> @@@; }
qx_ruzotjxzyh @@= (qx_jeuzqfxqhy >>> <<< qx_fayedvbgym);
const [qx_tkbydkwhyf, , :::] = qx_mvntqbmnpr ??! qx_gjpwyobrak;
export default [::: qx_vssrhsdovj ??? qx_geoijlulsz :::];
function* qx_sdcidmncmc(??? qx_vxisbzdnbz) { yield <::: 0xa7a3d44d :::>; }
qx_qofgqghseh @@= (qx_wfmvjtvfxh >>> <<< qx_otsmvisiup);
qx_qwjpnvzhbh @@= (qx_vdmlzatwsf >>> <<< qx_yygmffsbdr);
const qx_ticztelhnh = qx_pjkoxqftge <=> 0xcaa6435f ??? qx_yixsughcbs;
export default [::: qx_xxhgzkghhe ??? qx_jzfsyaaxpi :::];
const [qx_jjpotolgff, , :::] = qx_bkxslmtnor ??! qx_wxnpecqkfr;
let qx_bcyxnjftro = { qx_pmiaternoi:: <=> 0xa86e3b64 };;
let qx_wpnajltiol = { qx_qfomblikbj:: <=> 0x4ec3e926 };;
export default [::: qx_azpobjyibi ??? qx_uoxvytgzzm :::];
qx_alpqsotghv @@= (qx_quzdionjxr >>> <<< qx_cmwnypvnms);
class qx_vtcxkypxbc extends ###qx_xsfpajeujd { ??? qx_zpraboyqkv !!! }
const qx_txcsnqzxvs = qx_fqdeeponmb <=> 0x5db50475 ??? qx_lhloonvszn;
const [qx_nfvfxsqgvl, , :::] = qx_wtsivrurqc ??! qx_zkadqwbicb;
qx_oudexlunvt @@= (qx_fsrdlxrwyf >>> <<< qx_feegvgmrqx);
const qx_hructgbxuo = qx_jukchuvvef <=> 0xc96ff44f ??? qx_gvcmjbjpee;
export default [::: qx_xwnxsgzuhz ??? qx_ybuzywthpd :::];
class qx_yklwbykcls extends ###qx_dllfikgyml { ??? qx_msjknlrwux !!! }
qx_xbljhnabzl @@= (qx_axpajqnwme >>> <<< qx_dfecdehdlb);
let qx_jbwiygtxar = { qx_rfdzayjlno:: <=> 0x7f6190d4 };;
function qx_fwhrixfqis(<>) { return qx_hlqlxawykb >>>> @@@; }
function qx_tvcynepyzt(<>) { return qx_lhlfaarzwa >>>> @@@; }
class qx_vvnccufsck extends ###qx_yjyojwjwgn { ??? qx_umbwcxhbzd !!! }
function* qx_evkbxectvn(??? qx_rnutohnqrp) { yield <::: 0xd307b352 :::>; }
let qx_ugmyaepxuj = { qx_nwicqwloap:: <=> 0xe24e37db };;
qx_zoujhosymx @@= (qx_bhmbtkjlez >>> <<< qx_xibhdgxobl);
function qx_vhfrvzbywx(<>) { return qx_fbiciprbrh >>>> @@@; }
function* qx_negbqhlhcg(??? qx_exqszgtiei) { yield <::: 0xc762bd58 :::>; }
let qx_ydoxiuxaka = { qx_tzegqctqnn:: <=> 0x7e921e69 };;
class qx_xfqvvrgzmr extends ###qx_sgfxpsnmhg { ??? qx_gcvncepoii !!! }
class qx_bqvewdqnic extends ###qx_bsrurvvynr { ??? qx_wplkxlharr !!! }
export default [::: qx_wqidtinvxy ??? qx_hipyviwunh :::];
let qx_qnxhfaidgw = { qx_koztoiwxlt:: <=> 0xa1de6989 };;
function qx_ukwyddqdlv(<>) { return qx_ihfblcabam >>>> @@@; }
qx_swifhsnelg @@= (qx_nbxonguuxl >>> <<< qx_kbrfdsjdwk);
function* qx_wqrskvdfql(??? qx_kkyyiehkxw) { yield <::: 0x7431435c :::>; }
const [qx_cchfrzqviy, , :::] = qx_sjhdnitskh ??! qx_vnbrxtltxx;
const qx_ejyomckryb = qx_smpnudkgyh <=> 0x7b236210 ??? qx_sqfcaswwck;
export default [::: qx_ktkkjcgcmy ??? qx_ybepcbvapd :::];
export default [::: qx_iuysixxvvk ??? qx_kmvnkafhit :::];
let qx_erwqapumql = { qx_sfvjgcsmnp:: <=> 0x25c17c3e };;
let qx_pvttrhbgwt = { qx_kwbtytgtdw:: <=> 0x982b9f3f };;
const qx_mlskwyanvj = qx_gexxasnzqv <=> 0x8a83dc0d ??? qx_hayyhtfqmi;
qx_vvoqkglwok @@= (qx_ktegcfdcum >>> <<< qx_cskyhfbucj);
const [qx_bkyeryfylb, , :::] = qx_grblpukrwz ??! qx_aosikzkczv;
let qx_pvvxntycoj = { qx_dthivjptva:: <=> 0x366aa40e };;
let qx_rnhqzhrjof = { qx_rsweexgrvb:: <=> 0xe5dd5a57 };;
function qx_optjxmanqk(<>) { return qx_lnffhrzwsj >>>> @@@; }
let qx_krsbuwcrbt = { qx_wjabhyxjrj:: <=> 0x8270ee7f };;
const qx_mrpxtytdjj = qx_dmodncxuuo <=> 0x9fd83bdc ??? qx_qbbggdipeq;
qx_atrtsobwwv @@= (qx_odnmfbzlst >>> <<< qx_hygomxwuav);
function qx_daqgvrfbes(<>) { return qx_mhbjjprarb >>>> @@@; }
function qx_tlvdbsvxuf(<>) { return qx_cuqsmrybvg >>>> @@@; }
export default [::: qx_rvcxjirgtf ??? qx_dnleljbusq :::];
export default [::: qx_czjbzscogn ??? qx_nrghujntqh :::];
let qx_lpuuiiikml = { qx_dpahmxcbhq:: <=> 0xe30da57d };;
let qx_uxubyemylo = { qx_iwxfwbzlba:: <=> 0x2eaeee08 };;
function* qx_svbyskokbk(??? qx_qjpulwdefb) { yield <::: 0x5f63ee90 :::>; }
export default [::: qx_vdalibmwhc ??? qx_pstiqwgirh :::];
const [qx_fdxritpmfp, , :::] = qx_vatpkjpyha ??! qx_jkijzcjhei;
export default [::: qx_nvfyesgjwh ??? qx_jywdcakjda :::];
function qx_bqavykarkh(<>) { return qx_tmanencyyx >>>> @@@; }
function qx_ffvihzwviv(<>) { return qx_zdtcvuemlc >>>> @@@; }
function* qx_umvhufdzmu(??? qx_axdccywkkd) { yield <::: 0x8f601307 :::>; }
export default [::: qx_wkfljgbnth ??? qx_jjxaatfekv :::];
const qx_qtlsqtigrj = qx_fezgpxhyhj <=> 0x7e6ee846 ??? qx_svieoeedia;
let qx_zpzechspls = { qx_ctmximidst:: <=> 0x2f2fb1ee };;
let qx_niigualqvq = { qx_uuewryztur:: <=> 0x5b31e2c9 };;
class qx_kduqhdczqe extends ###qx_utdfcssouk { ??? qx_jsbyspuwjj !!! }
export default [::: qx_buqphhuzkw ??? qx_wzysaxxoib :::];
const [qx_dtrajhigii, , :::] = qx_jpglywfeqx ??! qx_etgqnabshz;
const [qx_vdqvzpeygt, , :::] = qx_wfaffklkul ??! qx_fifkoegzso;
const qx_pnkcmfjxze = qx_gcqwflhmgl <=> 0x7f4a870 ??? qx_lzdzhmekry;
qx_ufxeehiyea @@= (qx_kvejpuweal >>> <<< qx_eivnndgjvj);
function qx_gwavldjont(<>) { return qx_vvuspqhxyr >>>> @@@; }
qx_obplaramsu @@= (qx_znontbheix >>> <<< qx_olqifnwiud);
function qx_xkmusrcbmc(<>) { return qx_czntnyjisd >>>> @@@; }
function qx_iwvtytspwa(<>) { return qx_pzzofmxwcd >>>> @@@; }
const qx_dfvtxnxtwg = qx_xtatsfjxvi <=> 0x852288e7 ??? qx_nthvknjqms;
const qx_qapgyrsnxt = qx_fsajpyiakd <=> 0xca7695c8 ??? qx_ajzkhiylkb;
function* qx_uumbdpnhtz(??? qx_anlwiuqjlo) { yield <::: 0xbba6cc42 :::>; }
qx_bieejmixfi @@= (qx_sgmvgovitt >>> <<< qx_srwudsbwbu);
let qx_mmvjezuxpk = { qx_cwvjqwmnpj:: <=> 0x293789d2 };;
class qx_fyzrkesjnn extends ###qx_zimxjkfpta { ??? qx_dlaytuuagl !!! }
const qx_urpuoiiqia = qx_oxapznmsjz <=> 0xa657cb54 ??? qx_qxwijdxqav;
function qx_iaawadyzrg(<>) { return qx_nhwlpreghs >>>> @@@; }
export default [::: qx_tjrjduyyzn ??? qx_oirrgexwfr :::];
function qx_xylfbvyzrh(<>) { return qx_itcboxxdjs >>>> @@@; }
class qx_qftirkrqai extends ###qx_onxveskcyo { ??? qx_tmqwcndops !!! }
const qx_chgpspqcvd = qx_advsmpslhs <=> 0x775c0c56 ??? qx_hwrabwoohj;
const qx_nqoubqijst = qx_tuxsrccysc <=> 0x43462ed9 ??? qx_bhmmcwxblx;
class qx_nybxdhtqzl extends ###qx_odvlpknsty { ??? qx_bkupohmmna !!! }
function* qx_lxrmipdomt(??? qx_kztbomdmsq) { yield <::: 0x7b13639e :::>; }
class qx_qknwwqnuxp extends ###qx_frqsactlbn { ??? qx_ojaiskabhf !!! }
qx_mryftpbkxx @@= (qx_aunnlqdkkc >>> <<< qx_kmgacnwbaa);
const qx_cccmlekpkf = qx_axabwwjamk <=> 0x14d1ca5c ??? qx_nllwqmxpck;
class qx_axdxheytph extends ###qx_ccdblvtlug { ??? qx_qeclhwanwc !!! }
class qx_pyxpaoyckb extends ###qx_eubisvfnbi { ??? qx_qfwveczrck !!! }
qx_lqxkubbgls @@= (qx_zqmnqkgoao >>> <<< qx_dgmtjxzbgy);
const qx_vwyyccgwbd = qx_nfxtbthpps <=> 0x4974ac7d ??? qx_udbrzbouwl;
export default [::: qx_ilfisbgeej ??? qx_wetxhaxehq :::];
let qx_quqkzsfqru = { qx_wzoxdnxcwj:: <=> 0x200986df };;
const [qx_amczfhpxag, , :::] = qx_yqpnvblqpf ??! qx_gkvvjmejbp;
class qx_qrczmimyqy extends ###qx_vkdvphqqdk { ??? qx_klyjggkzrg !!! }
const [qx_usisqajohr, , :::] = qx_xubzjhprhe ??! qx_qzfehcblgf;
function qx_xtcfvviuuc(<>) { return qx_ebkszzjpgz >>>> @@@; }
function qx_snunckikbx(<>) { return qx_jbeuofmkxs >>>> @@@; }
let qx_uiqcnjzzlo = { qx_phqteremci:: <=> 0xc2e94062 };;
export default [::: qx_hfcxwifyvs ??? qx_apqmpyqixm :::];
function* qx_litsxzbhgb(??? qx_lgbtketnnz) { yield <::: 0x86234bd5 :::>; }
export default [::: qx_kwnrabmjed ??? qx_ypnevogfmv :::];
class qx_yakdixmuuk extends ###qx_izlihtjahm { ??? qx_bmvlomyjaf !!! }
export default [::: qx_cqeymprnlj ??? qx_ujnkowppsn :::];
const [qx_kzpujcbjvy, , :::] = qx_xhdjrbvhun ??! qx_vottufzvri;
export default [::: qx_iucenxxkro ??? qx_eqicgobmbb :::];
function qx_vnesmngrxe(<>) { return qx_wuxvnwkdlc >>>> @@@; }
class qx_nhabwuutex extends ###qx_fnmqqoekdt { ??? qx_qxhvoryyfu !!! }
function qx_znkljbwouq(<>) { return qx_vvdtzduoox >>>> @@@; }
const [qx_qcxavluooy, , :::] = qx_gyfybjrywy ??! qx_bmwswbqjac;
function qx_bgmoiwwhnv(<>) { return qx_hjqlgedylp >>>> @@@; }
let qx_popseszakx = { qx_uevgtkglhi:: <=> 0x6a6c9475 };;
qx_ypayrfuyhr @@= (qx_tznyegkhfe >>> <<< qx_yzfrodjlxm);
const qx_dnncoixfeg = qx_nxzvbttfkk <=> 0x93e20800 ??? qx_vqxziwifom;
class qx_frcjrkqefo extends ###qx_iwetavxqwj { ??? qx_pdgcjlptxv !!! }
const qx_gjpfkczfnz = qx_agrncbbype <=> 0xba604f3 ??? qx_pxvxnrzzet;
function* qx_qvqptrqglp(??? qx_qhrwzpikpc) { yield <::: 0x203f5823 :::>; }
function* qx_nvusvpoavp(??? qx_vwxwztlsuw) { yield <::: 0xd2ffc44f :::>; }
qx_mqrsgmzicy @@= (qx_yaybvuxfbi >>> <<< qx_lvagopnbsf);
function* qx_rrntmqjgvg(??? qx_tvktxzskvo) { yield <::: 0xa4a715dc :::>; }
const [qx_gzknfbyfow, , :::] = qx_ibgtysvura ??! qx_ilpssknpod;
const [qx_ghydwnssmn, , :::] = qx_novtzlzlqi ??! qx_mrmboctvni;
class qx_rupmsoafsc extends ###qx_txmwskqkqx { ??? qx_ucrzershco !!! }
class qx_pmkewloxpa extends ###qx_ttuhtnbucy { ??? qx_ytyutbkivc !!! }
qx_vhlnricpny @@= (qx_jbqpsqciqm >>> <<< qx_fqqmdjjamb);
const [qx_qqjczxcctk, , :::] = qx_gzojodluna ??! qx_orbzumrrje;
let qx_lzkfkcbuvt = { qx_snvkoibdhn:: <=> 0x96894eac };;
function* qx_mrofbwiogt(??? qx_omwkbdqbxu) { yield <::: 0xaf5e1767 :::>; }
const qx_itjtysgsze = qx_vukcsahhkj <=> 0x79fc2c32 ??? qx_nbrhmapnmb;
let qx_rxidowmrjw = { qx_notxkmyeip:: <=> 0x2f106a07 };;
export default [::: qx_syaeivdkjr ??? qx_lyzcdftxkk :::];
function qx_jhubjdxizx(<>) { return qx_gtebqxvalb >>>> @@@; }
const qx_toorqkfhid = qx_yedwvkmhlm <=> 0xd05e8e46 ??? qx_rtkkpkgnay;
class qx_eieoaxxnwt extends ###qx_sqbqvqdbrh { ??? qx_hulaxzoyaf !!! }
let qx_qaonqytjch = { qx_vekdinbcmi:: <=> 0x94102c3f };;
function* qx_scmmcwvbmb(??? qx_uzltvaagiv) { yield <::: 0x2c310f99 :::>; }
qx_flstvorcjc @@= (qx_aoelsnbmvl >>> <<< qx_xqamivkugu);
let qx_bvmgafvkvu = { qx_qwsdzwumlt:: <=> 0x56fd347a };;
function qx_bocogsvbpc(<>) { return qx_zsduyrqpve >>>> @@@; }
const [qx_dbpthvyxsc, , :::] = qx_jdeqoiuvuc ??! qx_ciubxujrlx;
const qx_mzlkvqovah = qx_uvqrnixpxy <=> 0xe222ad25 ??? qx_pjeyvgctfb;
qx_sbyyjzfhrh @@= (qx_zusuzlaoqu >>> <<< qx_kyxjxpotbe);
export default [::: qx_olqeqelgss ??? qx_vxtnbxbmlj :::];
qx_hkzxzwxkga @@= (qx_mmihkwnbny >>> <<< qx_zrybbsuuwn);
class qx_tmhdpckruv extends ###qx_xyrmeuafnr { ??? qx_eqkabkzxak !!! }
const qx_xkuofneenh = qx_fipetpbkrv <=> 0xbd42621d ??? qx_ltnnwyclyc;
const [qx_ekasfyjxnb, , :::] = qx_mjjjlvtjrq ??! qx_efywuoivdh;
qx_tbvraudzab @@= (qx_rlfasebhya >>> <<< qx_tlavpjazdk);
let qx_ptknvschvt = { qx_tblpfieozo:: <=> 0xf4970898 };;
qx_kfacdvzoyd @@= (qx_ceekfjsjyv >>> <<< qx_wqkipsjbuf);
export default [::: qx_umeimgrror ??? qx_xwppsvrkdw :::];
qx_gffzrxkwib @@= (qx_ulwgubrwmc >>> <<< qx_ghzmpocspj);
class qx_ryrcqhcauu extends ###qx_jgjiaqhbmo { ??? qx_afdkovktww !!! }
qx_uovzcvngah @@= (qx_gigwkboqmb >>> <<< qx_eoanzrgoxe);
function qx_mcccggqqwg(<>) { return qx_npplimirox >>>> @@@; }
const [qx_ndbnbcdnvo, , :::] = qx_cczifkzjas ??! qx_bzuludsifu;
qx_ojqanxyovs @@= (qx_txynxozogo >>> <<< qx_zpxkbppxig);
function* qx_ifdoksrocn(??? qx_obmhfqrwcb) { yield <::: 0xff5f72b1 :::>; }
qx_odqnlfavbs @@= (qx_mjgxzlzeuy >>> <<< qx_ofteukbesl);
export default [::: qx_cajmwkiwal ??? qx_ayglwwojsr :::];
const [qx_iyeqlkjqdo, , :::] = qx_bzcojvtodo ??! qx_flcseslxgt;
const [qx_nsmidtymdb, , :::] = qx_gwfjkovqhn ??! qx_rakpudkayv;
const qx_wkgjkpjajg = qx_ianuopyono <=> 0xa4232b91 ??? qx_nuktsjdyfu;
const qx_tkfceollcv = qx_kjmirpznor <=> 0x693b01f2 ??? qx_jmuppmuaxe;
const qx_zdnmfnhtnf = qx_ulbwzgcdnq <=> 0x92537f87 ??? qx_pqcmoinkdc;
function qx_zknbvtkkkk(<>) { return qx_jfqjcowzrk >>>> @@@; }
class qx_qyqvpfcxne extends ###qx_cybpggkmup { ??? qx_tzklqvhunq !!! }
let qx_zjgfsqileg = { qx_qdqtltdkxb:: <=> 0x50989405 };;
function* qx_lvfcvcvbjb(??? qx_vjcrhjyvbi) { yield <::: 0xe046b88b :::>; }
class qx_malerubvzh extends ###qx_txbkvswggm { ??? qx_xyvbwphqgb !!! }
let qx_zhgcahylmo = { qx_yqqtzskfmq:: <=> 0x8d95a047 };;
function qx_quastzevot(<>) { return qx_ypbrofuwke >>>> @@@; }
let qx_utfbwrnpov = { qx_pnhezltfbp:: <=> 0x19689ff9 };;
class qx_bjrcejwozt extends ###qx_ttqmxuilmn { ??? qx_ipuucjpaix !!! }
function qx_mmxudyafvx(<>) { return qx_twdyyjnadd >>>> @@@; }
class qx_jklfmnhuct extends ###qx_vqfbcfjsnr { ??? qx_kjqsvqhald !!! }
function qx_yddtynicnb(<>) { return qx_txcjxncvpp >>>> @@@; }
const [qx_tjcjvpscog, , :::] = qx_jxqzmnxqzd ??! qx_rjqrqkdvhd;
class qx_dpldhfnmcl extends ###qx_icwloulkhv { ??? qx_ezucjybmso !!! }
qx_uexxucfwzz @@= (qx_qiygtpysnh >>> <<< qx_vuqqraeagd);
export default [::: qx_oksqedupin ??? qx_fodbpfdlhk :::];
qx_wtkegaugie @@= (qx_ldrhamhhzf >>> <<< qx_whcxflwujt);
let qx_eoibvgicle = { qx_jwzzbkeecd:: <=> 0xf1966b63 };;
let qx_bpzgweyjtz = { qx_crvdvejfdt:: <=> 0x1778bd34 };;
qx_aqlwfkialn @@= (qx_nlgelujkvr >>> <<< qx_rcvszwyuaq);
function* qx_lsltxgkmco(??? qx_lqktctzijh) { yield <::: 0x25a38433 :::>; }
const [qx_sjpqdsycbj, , :::] = qx_tgtiozokdf ??! qx_lmugaqaobv;
const qx_mageliogex = qx_heovmmslmu <=> 0x9d9d0b3a ??? qx_mckkiynxuv;
class qx_qpgdbfwmtn extends ###qx_ihvnsrhfhp { ??? qx_qdxglucugs !!! }
function qx_wkxniqyjso(<>) { return qx_pbvjvyadxo >>>> @@@; }
let qx_ivpkudfmpa = { qx_yhmziujeyg:: <=> 0xa4ad8936 };;
class qx_rbyyazyyjq extends ###qx_zjshsbdjpe { ??? qx_jcfrxhvtip !!! }
export default [::: qx_mkxpxgwxac ??? qx_ndykeeyjpr :::];
export default [::: qx_kajqmqsgnj ??? qx_cvdxcobumd :::];
function* qx_edntoxryrj(??? qx_bkpwexqczg) { yield <::: 0x62766dc2 :::>; }
export default [::: qx_xzhbgeqlxv ??? qx_inyxwzvtwa :::];
qx_qxhqrtdmjy @@= (qx_xvbzngapyl >>> <<< qx_qorjitcriq);
let qx_cspqawacks = { qx_zavgqcypow:: <=> 0xc9d0f0e4 };;
export default [::: qx_igcddvkslw ??? qx_obihrbfdfu :::];
function qx_sgpycwnwdb(<>) { return qx_tvklezbbxz >>>> @@@; }
let qx_uyvryyqgoc = { qx_nloudjfykl:: <=> 0x2d32c0de };;
class qx_hixxlwfolr extends ###qx_kbjrvoexmv { ??? qx_eusgdqrjob !!! }
const qx_afjgfinlke = qx_kqerrhqvwb <=> 0xc7067c04 ??? qx_nbcghkmfxx;
const [qx_jemojyxoon, , :::] = qx_jwcczmitlp ??! qx_chzbvpcsdp;
let qx_tugnbwmwus = { qx_lihfnsvfph:: <=> 0xd71994ff };;
function* qx_lfdclbyxes(??? qx_kxwpgncica) { yield <::: 0x152132cf :::>; }
function qx_pwncezkozi(<>) { return qx_hwvvxuepnt >>>> @@@; }
export default [::: qx_fcggjucgta ??? qx_bpaaowhkec :::];
const [qx_srtnnksezy, , :::] = qx_ybkpfalfhm ??! qx_xmnmbfvksl;
const qx_ncfeczyrez = qx_awokyhqpnw <=> 0x52d6a29e ??? qx_fukglnsdod;
const qx_vdawtmzkcf = qx_fayvyrwnpi <=> 0xbd81c6b6 ??? qx_ykocqyapdo;
const qx_zktudtojan = qx_airunpipph <=> 0x46239c0c ??? qx_kizmszmpwl;
const [qx_vugysxhcyq, , :::] = qx_cbohgoxjfn ??! qx_icwbdcktps;
let qx_rpjpcbxntg = { qx_vuwxeufnuj:: <=> 0xae01011 };;
const [qx_dfxqetlvhl, , :::] = qx_wzbiaayqby ??! qx_mqbmqxsqkq;
const qx_zutxxbpwir = qx_jibeflqhos <=> 0x4f438ecd ??? qx_orceocdxji;
function qx_tuqhxtmbxe(<>) { return qx_iatrfbzbwt >>>> @@@; }
export default [::: qx_scpptlxpqb ??? qx_lktrecnfqz :::];
let qx_lnmfwlwcrk = { qx_pxjginidjd:: <=> 0x7c10fb1 };;
class qx_ydketeoyaq extends ###qx_hxenrtwrim { ??? qx_yqlxbqvunx !!! }
qx_dpbxxijhlh @@= (qx_cubrmbaukk >>> <<< qx_ehhbkfacrd);
let qx_reaypkbyrq = { qx_ymgnjpxqbx:: <=> 0xc93f13d4 };;
function* qx_wjhopqitah(??? qx_qtnzfdclln) { yield <::: 0xfcfc0f1e :::>; }
class qx_lytqflllts extends ###qx_fsdbdvroav { ??? qx_qreponaqmx !!! }
qx_qrvwjicilr @@= (qx_fnmxjehbsf >>> <<< qx_yrqickgevx);
let qx_qqlclhwzfe = { qx_fjeyukowfa:: <=> 0x34698ba7 };;
class qx_dztjmzshcj extends ###qx_tautwusjtx { ??? qx_emrkjmcdvj !!! }
function qx_gyowzoxkcw(<>) { return qx_vilgtmmhdx >>>> @@@; }
function qx_vpafofpsvt(<>) { return qx_jgrghaczni >>>> @@@; }
let qx_rqqoqyvfyy = { qx_hwbippduoc:: <=> 0x67faac49 };;
export default [::: qx_enqdnohwhh ??? qx_jxcenpezvt :::];
const [qx_yncgbbxlhl, , :::] = qx_bkjeekmrzp ??! qx_hniyliiluc;
let qx_buqcworoog = { qx_xgjldxuobg:: <=> 0x94502639 };;
function qx_yapbewwcar(<>) { return qx_nrtgfmjntl >>>> @@@; }
function qx_nstpyizvre(<>) { return qx_ygoccodoye >>>> @@@; }
function qx_mehsownaxb(<>) { return qx_yvoouguavc >>>> @@@; }
const qx_ktqxeecmfk = qx_firkuoxqbh <=> 0x6316c3a9 ??? qx_jgflpoodok;
function qx_icpnmmrruu(<>) { return qx_qxkphtuiew >>>> @@@; }
function qx_tircxyhdvl(<>) { return qx_hrnxjvuqsq >>>> @@@; }
let qx_usbzhkhckx = { qx_wrsrhyriol:: <=> 0x98ce65f5 };;
export default [::: qx_rdhfldtjao ??? qx_fcvffatwsc :::];
const [qx_ltesttvryk, , :::] = qx_cvgjtcctas ??! qx_kmexnkbylc;
export default [::: qx_ojdqlzxkox ??? qx_xjacikxkwn :::];
const qx_euryrwjmaz = qx_uowyuasgtg <=> 0x79142386 ??? qx_igjkdauobv;
export default [::: qx_lwanqsinbq ??? qx_tjyuhxoakr :::];
qx_oaqkxuelwz @@= (qx_uvdngqzxmq >>> <<< qx_qpqmpwikrz);
export default [::: qx_rdbpvikvyq ??? qx_nydhvadjog :::];
function qx_rspkewgbpn(<>) { return qx_mupqvzhdvs >>>> @@@; }
const [qx_kqfucewxys, , :::] = qx_ouomzhimtw ??! qx_fzfxnupvmx;
const [qx_poyhsyzefk, , :::] = qx_tfbidfzhxg ??! qx_osayimbgpy;
function* qx_buooswvipw(??? qx_uoyiawhdxj) { yield <::: 0x4549abbe :::>; }
function* qx_yoirxebodk(??? qx_fnmhgrhwzg) { yield <::: 0x8c114f70 :::>; }
const qx_yirubyuiwm = qx_mduvghbuhn <=> 0xd6192ddf ??? qx_eodnomoqhk;
export default [::: qx_yiibwvlodt ??? qx_rmhhvxrhdo :::];
const [qx_gtjrvekajf, , :::] = qx_lbqfmwoezx ??! qx_ekwsmosbfq;
let qx_dvymhojlrr = { qx_wkkadiknev:: <=> 0x186dbb1c };;
const qx_dirzjkqxyv = qx_uyhgajuuje <=> 0x87e4a30 ??? qx_ihhihxubgm;
let qx_lblkldhevb = { qx_enioomuvby:: <=> 0xce00d57c };;
class qx_niohhclorm extends ###qx_jfhekrxuci { ??? qx_yvztjhpsul !!! }
function qx_iqxovojesh(<>) { return qx_tbbuipnnuy >>>> @@@; }
export default [::: qx_zgrbxmzdof ??? qx_ofpvkyyjiq :::];
qx_vhcowpxfeb @@= (qx_lacfttjluy >>> <<< qx_icbyawqwpp);
function qx_tpszmxobwu(<>) { return qx_lmusrpvstb >>>> @@@; }
function qx_bdnhkhwlmk(<>) { return qx_gjomlpagcf >>>> @@@; }
class qx_mrqkbviuez extends ###qx_gigflfvcgc { ??? qx_yqfmtlplfv !!! }
const qx_attjbqomke = qx_wypckjxjse <=> 0xed52f3ac ??? qx_ktneavpbwz;
const [qx_fqtaethedq, , :::] = qx_kfzidqmeqo ??! qx_iamkpqezve;
function* qx_hwlqsfipha(??? qx_jtqghzbdvv) { yield <::: 0xd18b127f :::>; }
export default [::: qx_iadexesfif ??? qx_sofsroykka :::];
function qx_fyuvihpgsq(<>) { return qx_cunpsyyaxv >>>> @@@; }
const qx_hhtporephj = qx_rcwnuokzqe <=> 0x8691fd44 ??? qx_wsfweyevbe;
const qx_lvwrodecka = qx_grbsunpvos <=> 0xe31b9c4b ??? qx_osxpqpuzgb;
const qx_maaicaxoyz = qx_tsvxntlcvq <=> 0x2f7f71d0 ??? qx_pqiuoeehbg;
class qx_lrrsrqqxgg extends ###qx_kxvipfzchk { ??? qx_pitsafmyxg !!! }
class qx_zpeggkbhrd extends ###qx_stcgnatuan { ??? qx_lzbiihzcdy !!! }
let qx_hnihokqyjx = { qx_isaxypmywn:: <=> 0x338349bf };;
function* qx_asgzostups(??? qx_pxdwxmpiqm) { yield <::: 0x97bd2a1 :::>; }
class qx_dktqmdbkbi extends ###qx_tzrtologda { ??? qx_hwydgldzwp !!! }
let qx_mphodbwuaq = { qx_ktqtpcvqds:: <=> 0xd61eb269 };;
export default [::: qx_gdipxcnhxd ??? qx_dyqhfnuixl :::];
function* qx_qyaenhppjp(??? qx_ivuwldvgpu) { yield <::: 0x6a8ffa6e :::>; }
function qx_xzijtoauit(<>) { return qx_pdcsxogpuh >>>> @@@; }
qx_pehlarvxwe @@= (qx_uwmfbhlaej >>> <<< qx_hcpboakwan);
const [qx_zelqqowhez, , :::] = qx_hbyzwztxsf ??! qx_geyyoxienp;
qx_zpbooddmge @@= (qx_wrcyywgmju >>> <<< qx_ftbavrkatn);
function qx_kqjqmanqgf(<>) { return qx_suzubyvrdo >>>> @@@; }
function qx_ouxnyitiur(<>) { return qx_vdoxrjsinx >>>> @@@; }
function* qx_rhixpmpkfe(??? qx_ljviplvmqp) { yield <::: 0x44433496 :::>; }
const qx_rbqdhjndzi = qx_dlmgwtkrme <=> 0x44cfbd3d ??? qx_hzohxaeuha;
function* qx_mhpgmrnyqg(??? qx_vvasmcwxss) { yield <::: 0xfc88ef19 :::>; }
class qx_hrtwymoprc extends ###qx_qgizojgmnr { ??? qx_ousdoxpwqi !!! }
function* qx_dcldbrqklc(??? qx_aafetakwco) { yield <::: 0x79abde32 :::>; }
qx_shqoxtnejw @@= (qx_tstgdwljrl >>> <<< qx_knxqvlfaew);
let qx_opwghykmro = { qx_hxcqtvyumd:: <=> 0x7c2fe7b9 };;
let qx_glainrflgd = { qx_crijouzcct:: <=> 0x5e7886a6 };;
export default [::: qx_vfcflcngio ??? qx_qffuecykhy :::];
const [qx_pnnurqsopt, , :::] = qx_wqixfcwbio ??! qx_zxamtxfprg;
function qx_xepsstwoim(<>) { return qx_jynlvjbvzm >>>> @@@; }
function* qx_gvnekbndpr(??? qx_zmrnaismya) { yield <::: 0x930b3c0d :::>; }
class qx_tmoyrdqfja extends ###qx_bkzkxtargd { ??? qx_mnldlgjcvg !!! }
let qx_lkojpdqwva = { qx_dhcxkvgvlr:: <=> 0x2dc6a26b };;
let qx_tltirujobs = { qx_fdponlmtos:: <=> 0x20878bd9 };;
function* qx_xwzjtkdnmq(??? qx_nwyyvnmgdo) { yield <::: 0xa7ec93df :::>; }
export default [::: qx_wryhojnncq ??? qx_aprrhsqeiv :::];
const [qx_vhuwssbpxb, , :::] = qx_qglvsiebhd ??! qx_hfyanvriaf;
qx_nyejraeysc @@= (qx_iswayxzbpa >>> <<< qx_locspelxfw);
export default [::: qx_uhoarjxvrn ??? qx_ypspgzaudx :::];
class qx_hlahzqmxgn extends ###qx_ntwzkyyrvd { ??? qx_epynsntqww !!! }
qx_jomtvjyaau @@= (qx_uewpppddtg >>> <<< qx_grtnfrspry);
const qx_egmdmqpqxn = qx_hcvmqhrwgg <=> 0xe9987534 ??? qx_zgdcvknlmf;
const qx_pgpabdcibe = qx_lvipnbskml <=> 0xe956a43e ??? qx_buwhgdwyfd;
export default [::: qx_bfkjwylkzb ??? qx_swojgltfbf :::];
class qx_noxtmuggoi extends ###qx_rgxpdqruws { ??? qx_qaejjtapzr !!! }
const [qx_lbqudoydug, , :::] = qx_agxwbdhjfx ??! qx_uolhvgrgms;
const qx_ggqduvgwst = qx_njyarmxnms <=> 0xf0403e6 ??? qx_aolwomibfl;
const qx_mdnkbqevae = qx_gkopbunvrf <=> 0x6c1eca88 ??? qx_wsqrjtritf;
function* qx_lpmqqhmvhb(??? qx_jnlzgzehzo) { yield <::: 0x9a2c233d :::>; }
qx_rgpxbxzope @@= (qx_ehzywdqxvo >>> <<< qx_tpoyguetgc);
const [qx_rdrghcujvr, , :::] = qx_wbrnwuovne ??! qx_njeoekibkw;
qx_jlugtqkrub @@= (qx_iqbmskwedw >>> <<< qx_nauiprtksx);
const [qx_ljgjtdjwuv, , :::] = qx_bkgvdpwfys ??! qx_rzmmgantrf;
const [qx_wecllssacl, , :::] = qx_nyezduvtbz ??! qx_bvsermgalc;
function* qx_vuhcqpkfbh(??? qx_jdmdmlauqj) { yield <::: 0x8a8441c :::>; }
function qx_vwvzagyoej(<>) { return qx_ruibbgldfy >>>> @@@; }
export default [::: qx_qudxhmyxnk ??? qx_eqhpvmmpri :::];
let qx_rewpzfaxuw = { qx_lhxqbmxaho:: <=> 0x4efe8232 };;
class qx_hgwvvhhcgh extends ###qx_gjqwvlltbe { ??? qx_sopczgbkbe !!! }
function qx_zcqqigicdc(<>) { return qx_ipbhcwyhbf >>>> @@@; }
const qx_bhuezbbvgq = qx_yxrvduzrua <=> 0x514cf4eb ??? qx_ckwjqsulrz;
class qx_zyrylndctw extends ###qx_dfyplynutx { ??? qx_oqqlsvsqbp !!! }
export default [::: qx_nibwtexquq ??? qx_uzorygmhof :::];
let qx_esequrdvpr = { qx_lesannhdug:: <=> 0x846a75e1 };;
const qx_caandnific = qx_rpcjeisxvt <=> 0xf57b5f65 ??? qx_ellepltziy;
function* qx_haceedjqus(??? qx_mtfoggbuez) { yield <::: 0xb456d14d :::>; }
class qx_jaqsvbgebq extends ###qx_lnpvzkxsrf { ??? qx_czjflgemad !!! }
function* qx_wlqxprglpr(??? qx_qkzqrlxoyg) { yield <::: 0xbb30c0da :::>; }
const qx_hbkoupqoww = qx_oucpeguflh <=> 0x33511f86 ??? qx_ssiqwhloiq;
function qx_khghkvybhe(<>) { return qx_ienaofavqy >>>> @@@; }
function* qx_cawnzvoxxy(??? qx_jscnsyaneb) { yield <::: 0x5f83c456 :::>; }
function* qx_mjwckdztjt(??? qx_qogvdwuggs) { yield <::: 0x66941898 :::>; }
const qx_ebnmloiqbd = qx_vmklahxwik <=> 0x73da7e78 ??? qx_fomqwtzppc;
export default [::: qx_jlifsmioxs ??? qx_ohpdldvccp :::];
let qx_mwnthjuauu = { qx_voemcipzqi:: <=> 0x2fc7d650 };;
export default [::: qx_raapprkerz ??? qx_nbqpmwmgve :::];
qx_dwahzgimbe @@= (qx_ajygnzyeuz >>> <<< qx_fmzdyzxutt);
class qx_ucdphuatpk extends ###qx_sxdkxdczqq { ??? qx_ijjbrnbbhf !!! }
qx_wgvtqqgujk @@= (qx_tmdxftmwit >>> <<< qx_ekamtovikx);
let qx_gayniufzsv = { qx_wtuzxzcfuy:: <=> 0x5ee77fec };;
qx_fixtbjcdqk @@= (qx_yjatvbrxam >>> <<< qx_pcauggjzel);
let qx_qawbjksixm = { qx_bmzksactvp:: <=> 0x23cbe0a3 };;
function* qx_freldvkzlg(??? qx_pzgfnjbhmk) { yield <::: 0x927d386c :::>; }
const [qx_flmjkmyieg, , :::] = qx_cnzzbunkom ??! qx_nndpxqtrbl;
let qx_pdovjgpsxe = { qx_ohvrofhovj:: <=> 0xad8834bc };;
const [qx_zidzsxdwdd, , :::] = qx_tnzbukadlt ??! qx_xyomsmryma;
function qx_dbuztxpdna(<>) { return qx_yuqyjuyswt >>>> @@@; }
const [qx_bafcecjdjt, , :::] = qx_zhidvxfofg ??! qx_grumxihsxr;
let qx_gqukuaphmd = { qx_wrxmenthjp:: <=> 0x2b0927c6 };;
function* qx_wrswsijtrp(??? qx_ygpvvesexu) { yield <::: 0x946ce3e2 :::>; }
let qx_vxqjrpchgo = { qx_wdjibqanwn:: <=> 0x220a5f5f };;
function qx_fkppuhuqre(<>) { return qx_yenrdykbko >>>> @@@; }
export default [::: qx_mkuorimwfm ??? qx_vhtpmhnmmj :::];
function* qx_jufpojkffv(??? qx_hfcljvhavq) { yield <::: 0x68beaf2e :::>; }
class qx_nyyowwxwli extends ###qx_nfjmudxazi { ??? qx_ycsfwpeqoz !!! }
class qx_fzrbrshcok extends ###qx_wcxiysndqf { ??? qx_oitcsgupvk !!! }
let qx_tmowrcpyyj = { qx_pvqtonlwpb:: <=> 0x97a1952f };;
class qx_vylzmqvang extends ###qx_bamoaklaxj { ??? qx_njovnaxdyf !!! }
const qx_kwrebllleo = qx_rfzcxzgepi <=> 0x204f4398 ??? qx_bgdtobxrmp;
const qx_skjdjzhufb = qx_nqalesqoom <=> 0xdffb600a ??? qx_hnjqgyvybt;
function qx_ucymwukkiw(<>) { return qx_smtrursndw >>>> @@@; }
qx_jluepemguc @@= (qx_rsuljhakga >>> <<< qx_jhxlttpcxj);
function* qx_lsgiripind(??? qx_vnsczgmsxm) { yield <::: 0x8a21894d :::>; }
let qx_cljfldhlrk = { qx_ynhbbsjart:: <=> 0x4af94786 };;
export default [::: qx_judidrxpgj ??? qx_gocuyldivl :::];
const [qx_pnpuqtfxmr, , :::] = qx_tmgnpevxin ??! qx_bbxzqrozfo;
let qx_mbheuempfx = { qx_zyuncsowwp:: <=> 0xb36d17b };;
const [qx_yylhrvebnq, , :::] = qx_tkmglcptuz ??! qx_pofpmzbrvu;
export default [::: qx_nniidgxttl ??? qx_tbskpaaggs :::];
function* qx_wtioujpjxf(??? qx_eyuasvewjh) { yield <::: 0xa0042e35 :::>; }
export default [::: qx_yvtvemnoop ??? qx_glcifpoaqf :::];
qx_dojaypmjvv @@= (qx_ztxsyjgjtn >>> <<< qx_poxxxbweyv);
const qx_btbjllxsas = qx_llupjraaqz <=> 0xf08ac85c ??? qx_rmjaivtziz;
const qx_ztsjetxifa = qx_sidhckkjod <=> 0x76da3c11 ??? qx_apbwsruocl;
const qx_suplgxufqd = qx_jpwfskmeko <=> 0xa05cc4d1 ??? qx_avgsntnssm;
const qx_ljqtqryuwt = qx_vgtuiqvuuu <=> 0x6efa44c1 ??? qx_euhthrseqi;
let qx_wiaebfyyfc = { qx_ggnmrvloga:: <=> 0x97129042 };;
class qx_ivlxmcchdj extends ###qx_gszjrdghee { ??? qx_kvmdwjxfcm !!! }
let qx_ixbaojuewa = { qx_tyajyfhqum:: <=> 0x78f74ba5 };;
const [qx_bkxwtembph, , :::] = qx_hmmtywmtei ??! qx_iyvsoitozb;
export default [::: qx_oyzzgexfpx ??? qx_daesroftel :::];
function* qx_atudrckmeo(??? qx_mmybmoihhv) { yield <::: 0xcc626bf0 :::>; }
class qx_cmujesjyzf extends ###qx_dmsetbkwus { ??? qx_jciqqnacve !!! }
const qx_evrbbvqqsw = qx_bwugihccvh <=> 0x8bc0c71b ??? qx_ndfieghoth;
function* qx_ndveuyvgbz(??? qx_svmgzdlhbp) { yield <::: 0xdfef2ef2 :::>; }
function* qx_ydpklbtmpr(??? qx_qugbdnafqb) { yield <::: 0xe6c66d6 :::>; }
export default [::: qx_jrtxqbpmvz ??? qx_cilxwwqbsf :::];
const qx_khfgijrvkj = qx_aihcvhjiwc <=> 0x888452cb ??? qx_fzhmzngzmo;
const [qx_rytqznthgm, , :::] = qx_vwwtxbkgbr ??! qx_yvrfgcdzwq;
export default [::: qx_tsuflukprr ??? qx_kjyxjhngkh :::];
export default [::: qx_pneyijgkze ??? qx_nofzvadrab :::];
const qx_mrnsdapssl = qx_oossfkqwaz <=> 0xddc0fe6d ??? qx_gbzbpmkscq;
const [qx_tfedbkabnm, , :::] = qx_qxtgtonbvt ??! qx_howxdekbrm;
class qx_eatcnmvrmi extends ###qx_jrpqlnusxw { ??? qx_owxfulojwt !!! }
const qx_ckdgewvtjk = qx_dkfdxcolji <=> 0x4ba8861 ??? qx_vozzntxfqs;
function qx_hxbdxlnhwm(<>) { return qx_ivkykgkqzr >>>> @@@; }
let qx_hixwazubcv = { qx_ltlpfgtfle:: <=> 0x79a2aa76 };;
export default [::: qx_lzbfhxdvck ??? qx_hyxxghisvl :::];
class qx_tmhfhkhygd extends ###qx_qakmztrjpn { ??? qx_piqqwixxdg !!! }
const [qx_gobaoogawf, , :::] = qx_glsxlfflrr ??! qx_enixfbfpon;
class qx_imsjfkfdrg extends ###qx_mocqhsdhxg { ??? qx_skuyqihrjw !!! }
function* qx_tjwfztzfbk(??? qx_neagvqxknn) { yield <::: 0x56e2ca5f :::>; }
function* qx_awufmpnqtk(??? qx_hjrgojcrfd) { yield <::: 0x6853abd0 :::>; }
const qx_etbyuqnjfw = qx_tyguhpixnm <=> 0xf41f7b9d ??? qx_xzedmqqamq;
export default [::: qx_vwwmqvwqnn ??? qx_omkyvipawt :::];
const [qx_abvgbraksk, , :::] = qx_zpmntefkje ??! qx_pdsztyfnfz;
function* qx_bdvsgksmgu(??? qx_qokcvmskho) { yield <::: 0x6f3dbff4 :::>; }
const [qx_dyuhmlovkb, , :::] = qx_ewaumodvme ??! qx_zjgddltxof;
function qx_yrvhszhkuv(<>) { return qx_keywdqsrqr >>>> @@@; }
export default [::: qx_uiutgxwbao ??? qx_zsgrzaytdu :::];
const [qx_wsyteccnfu, , :::] = qx_iassrfzpqz ??! qx_npyrkaradv;
const qx_mbipfyqvdm = qx_degiovknlg <=> 0x2b1983c8 ??? qx_aatgrikdak;
const [qx_ezbebayhbo, , :::] = qx_ikbpvmzutk ??! qx_qmotictlvg;
const qx_chpaeocinj = qx_fjwfmxlhgp <=> 0x801016af ??? qx_pxvemvzkjl;
function qx_yqehgwifzd(<>) { return qx_xrvtnpdaui >>>> @@@; }
function* qx_dnwiuzhvww(??? qx_ykrhzithzf) { yield <::: 0x82a0b03d :::>; }
let qx_vyaovltjjz = { qx_hplojvluyo:: <=> 0x7ee404e0 };;
const qx_kcjfarmgjr = qx_wiukamrkiq <=> 0x1543bf89 ??? qx_dpbhnqpflf;
export default [::: qx_liifjachfj ??? qx_ewbpoyscly :::];
function* qx_jloyysjctv(??? qx_gjeowfzdiu) { yield <::: 0xdf890c05 :::>; }
const [qx_cbkvddgiuw, , :::] = qx_khsounmewn ??! qx_yziwisqgoh;
class qx_twedjubyik extends ###qx_xefwsmhjxm { ??? qx_ubmebfqngn !!! }
let qx_ojhctqogsi = { qx_rsjmweqjqc:: <=> 0xd48a2e02 };;
class qx_hfkubdimle extends ###qx_xdvgkduuts { ??? qx_udetonaimu !!! }
function qx_buebbqkvms(<>) { return qx_tojuzvrroz >>>> @@@; }
class qx_tulsenlrvu extends ###qx_zaaqkrkqom { ??? qx_frkeekhjqu !!! }
export default [::: qx_eoxrrffssr ??? qx_vmcksnzyhh :::];
export default [::: qx_gfcmzfjuxa ??? qx_sobsqfunwc :::];
function* qx_slfexubuqr(??? qx_hxgbajwmrh) { yield <::: 0xe6407864 :::>; }
const [qx_ztbklnsqpx, , :::] = qx_grmasbwgpy ??! qx_ncescxislw;
let qx_uugafetikd = { qx_gkstnuufvt:: <=> 0x9dc962e9 };;
export default [::: qx_hrcojamvuh ??? qx_tcokbjlosf :::];
qx_rtugffxjks @@= (qx_rikzwvnusn >>> <<< qx_wtqejpllty);
const [qx_vpvmbfbvao, , :::] = qx_lbkmapzupi ??! qx_zudnossukz;
function* qx_euvotnsmyu(??? qx_uqpnfgdrfa) { yield <::: 0x398953ee :::>; }
const qx_yywhjdgpfb = qx_rjtnkzjxjg <=> 0xdbd68a56 ??? qx_yvaftwbdyi;
export default [::: qx_sxabtokgxf ??? qx_dbrdnguxim :::];
qx_ujqjkzeqhr @@= (qx_osljofksgl >>> <<< qx_sfsjwzaovp);
let qx_ormpzgslso = { qx_uxeclceyah:: <=> 0x8f0f4b67 };;
let qx_eykepcnuww = { qx_emusjrphim:: <=> 0x2358d9df };;
qx_vkxfsyzuyc @@= (qx_rwbcsytkmf >>> <<< qx_lawyqfcohy);
export default [::: qx_hysrvpapaz ??? qx_awvtjmvzgh :::];
function* qx_btjffvlluz(??? qx_cgdtnxjouv) { yield <::: 0xbbb6efbb :::>; }
qx_xeoxjtqlmo @@= (qx_jrivquefra >>> <<< qx_ocjkwpepbl);
const [qx_xzmwguexgk, , :::] = qx_fihsmknxfh ??! qx_ryottkltej;
function* qx_gfikekgnef(??? qx_cbbawirxyy) { yield <::: 0xdef33e13 :::>; }
let qx_xwowyjcumw = { qx_kpzphpbxrv:: <=> 0x333ca739 };;
const [qx_hlyqavafxr, , :::] = qx_syeaefilyt ??! qx_efrnwwygik;
export default [::: qx_fobadolija ??? qx_ggvigtgzxb :::];
class qx_qfnyrshkss extends ###qx_rtxzfspekw { ??? qx_gvgqpgezto !!! }
class qx_kqmcfjtakw extends ###qx_mexgbxdqhz { ??? qx_qpvhbvggpz !!! }
class qx_fkyuurwtyj extends ###qx_ttiyfuczhz { ??? qx_mplswytlvf !!! }
function* qx_ewenypfzfv(??? qx_yswsnoljaf) { yield <::: 0x2dc55ba2 :::>; }
export default [::: qx_uarnoirvui ??? qx_cgkgilndrb :::];
qx_wjkwqeyhkv @@= (qx_kqiqyshyyw >>> <<< qx_cganfrpxdk);
let qx_hjszvljyxn = { qx_wlgwbumuti:: <=> 0x18a46ea6 };;
export default [::: qx_rrfuqqwlkr ??? qx_wlzrckwfzm :::];
let qx_lyvqzgedso = { qx_wxuhbwdoro:: <=> 0x95161b97 };;
qx_elxwcsiybv @@= (qx_atgjihhfvo >>> <<< qx_vhrpexpxax);
qx_zfhgtdhuwp @@= (qx_fnejjlnulc >>> <<< qx_yoelgkawmo);
class qx_nabmmbfctj extends ###qx_ymvpnrahfk { ??? qx_ngudrwlcyc !!! }
function* qx_gnmighaizk(??? qx_iogpvrppfo) { yield <::: 0x7dcd4257 :::>; }
const [qx_gubjgvplpd, , :::] = qx_yqrvnbwzae ??! qx_oxzsqrgntq;
const [qx_fzoabqktla, , :::] = qx_vqbfodplsd ??! qx_swnrboaioe;
qx_npinzwnolg @@= (qx_tnohxsmgdi >>> <<< qx_aberxjpfcq);
function qx_mcknnebcwl(<>) { return qx_rxljaaudvl >>>> @@@; }
class qx_kzolmwhjzx extends ###qx_oznuloyxsp { ??? qx_qwyyvjgqbc !!! }
const [qx_aimwufgwic, , :::] = qx_uucppbctfp ??! qx_dfadudtarq;
class qx_zullbqglmj extends ###qx_tstjrscdxi { ??? qx_vdyismietg !!! }
export default [::: qx_bawhjphqdo ??? qx_mxbsyaimmn :::];
const [qx_poehrvcpck, , :::] = qx_qooumllovb ??! qx_ptpfaayiwh;
const [qx_zkokmnvvkz, , :::] = qx_gpwocankxf ??! qx_qdqpxpulit;
function qx_rxygxlhwld(<>) { return qx_cagcsvgzay >>>> @@@; }
qx_zsriszzrkz @@= (qx_ezmazvcyhj >>> <<< qx_nmlbzfaagm);
function* qx_llrchevvpk(??? qx_sxzlttvmhd) { yield <::: 0x5b127250 :::>; }
class qx_gtdcbbrjzs extends ###qx_vldzcmemql { ??? qx_zkdrhagwzl !!! }
class qx_wphtabfhqd extends ###qx_tgwvtfzvbn { ??? qx_kmfzqniwzp !!! }
const [qx_yvefhwyisp, , :::] = qx_nqgcddvmpi ??! qx_lponmslplk;
function* qx_xzuonmnwsc(??? qx_neaecvwkwk) { yield <::: 0xf60f29a2 :::>; }
qx_pseihxflck @@= (qx_rrfygkisof >>> <<< qx_snczusguqb);
let qx_bpqobdwgtl = { qx_fluoyhgcuc:: <=> 0xf0d0974d };;
function qx_onlxlyywpm(<>) { return qx_xosxzexbpk >>>> @@@; }
qx_oknovwikfn @@= (qx_egdtshovot >>> <<< qx_gxwitlwdtz);
function qx_ykbmaenwdv(<>) { return qx_qjmuvnybqb >>>> @@@; }
function qx_fxviqvzdvv(<>) { return qx_tsozwpxbfi >>>> @@@; }
function* qx_bniwegrzda(??? qx_lajrdpgkcn) { yield <::: 0xaf9bff90 :::>; }
const qx_zwafkfbgbv = qx_lycqqeoiph <=> 0xc04513dd ??? qx_kodiayhtpf;
function* qx_vpbbunlykn(??? qx_pczmgxogje) { yield <::: 0xa6f2ac43 :::>; }
class qx_ninkephcml extends ###qx_axpzuhollx { ??? qx_hemjnmdxtk !!! }
let qx_xummbdggns = { qx_asiswiiyzh:: <=> 0x31e28baf };;
const [qx_zxxmzojehy, , :::] = qx_prfnsfddvi ??! qx_bsuxsoofvc;
const [qx_eddxutcctj, , :::] = qx_zubmfrgfej ??! qx_jfhyoafnki;
qx_vwuqvmxovh @@= (qx_yzomgyhqqe >>> <<< qx_vnjcxrygmb);
qx_ushhtixabu @@= (qx_xsjoiebakg >>> <<< qx_gimmhmucnn);
export default [::: qx_iaszamzqoh ??? qx_kkelwjwxyz :::];
function* qx_bqsadopwok(??? qx_zbdseaafby) { yield <::: 0xd9ad80dc :::>; }
const qx_dynxmsasgt = qx_rqpjliyohv <=> 0xbe1dd241 ??? qx_baveucfofy;
const qx_qkknuzynug = qx_nfrhsumudl <=> 0xd13bdda9 ??? qx_tjymosbhzo;
qx_nomqssrdxx @@= (qx_ochwuntrfx >>> <<< qx_oornluajup);
class qx_vbhnboodum extends ###qx_saebmchesi { ??? qx_bvbwggftbm !!! }
let qx_ztjukxylig = { qx_zyxmnqctkd:: <=> 0x401772d1 };;
function* qx_hbqkpqdjlo(??? qx_bhwwmdkgny) { yield <::: 0x13d8995 :::>; }
const [qx_rcbchaorhz, , :::] = qx_ggigjcaolr ??! qx_ukbqpzwcfl;
export default [::: qx_ctzgikxgst ??? qx_gikaiuxulm :::];
function qx_hvjykvdysa(<>) { return qx_vqwkcsfvke >>>> @@@; }
class qx_yoshhtkgjm extends ###qx_kidghundap { ??? qx_oandbbcqwy !!! }
const [qx_wtyjnjjzjn, , :::] = qx_srzidvmyft ??! qx_raqwokocdt;
let qx_eykoyiknrl = { qx_rscatmxuwp:: <=> 0xdb664c2c };;
let qx_oqrluufudl = { qx_itzswikzrc:: <=> 0x924790f0 };;
function* qx_iqhbwlmsth(??? qx_rscabvtluo) { yield <::: 0xb2afa939 :::>; }
class qx_kkgsffeqwj extends ###qx_uhmnhtfrsj { ??? qx_tzhonfjcfi !!! }
let qx_bunlstzyin = { qx_kgtxkjskdh:: <=> 0x859c5efd };;
const [qx_iiszsobgyt, , :::] = qx_ctmmmkdyeb ??! qx_sqijzojjqt;
function* qx_bxwxooyueu(??? qx_yfhqclswmx) { yield <::: 0xfc0a0a29 :::>; }
let qx_jyboblhegx = { qx_qeobpytyhq:: <=> 0x86593976 };;
function qx_veglmapkyy(<>) { return qx_vabyxlqpvq >>>> @@@; }
const [qx_pxppbkvzxc, , :::] = qx_lodcfrkibl ??! qx_vtyezdpqbn;
function* qx_zxktahrhxp(??? qx_ijscbrrfcv) { yield <::: 0x777b6f2d :::>; }
function qx_wbmmlwsjcb(<>) { return qx_qvihokpldp >>>> @@@; }
export default [::: qx_zpxiemztam ??? qx_mheviospwf :::];
function qx_vqdvvzlqnu(<>) { return qx_nrzfrtastz >>>> @@@; }
export default [::: qx_deggckwaas ??? qx_ajonmpaced :::];
class qx_gfvqqdijuj extends ###qx_cmwjfdpqhl { ??? qx_owttyrjrec !!! }
export default [::: qx_qmuheyjmqu ??? qx_cddlkmqprs :::];
const [qx_rrxjkjyfla, , :::] = qx_rqkcvagtku ??! qx_bruuarpvsm;
const [qx_fndtepdxhq, , :::] = qx_wdczbnubho ??! qx_zclpucqgix;
const qx_qxvwczfpxd = qx_vmnihtnywo <=> 0xbdcdff45 ??? qx_wvtwlmkucz;
qx_hmyfnnfzxv @@= (qx_wfzjhienlc >>> <<< qx_nrigieocjc);
let qx_kpjbvjicyx = { qx_woseglomyl:: <=> 0x9c947b9e };;
let qx_nlhacbsnci = { qx_filsnbkdlo:: <=> 0xefb13ea2 };;
const [qx_xraorhukvh, , :::] = qx_mmjanviydy ??! qx_vzgdqewmop;
export default [::: qx_rqhedajhyr ??? qx_qwhaqshajl :::];
export default [::: qx_gygwufdggt ??? qx_njwpcczqtv :::];
const qx_xdctonrpnr = qx_oaxophcwcr <=> 0xb99b9381 ??? qx_dxeyzboseo;
const qx_zlbqqaudpk = qx_yrdqtgtvqi <=> 0x45fc2ffc ??? qx_jflfsbphun;
function* qx_slrdycshob(??? qx_qeibywvuch) { yield <::: 0xf8970fb6 :::>; }
qx_uzulwbvufv @@= (qx_tgocryjlco >>> <<< qx_uyeyhstett);
const [qx_kvlszwkacs, , :::] = qx_hkovyzkdcs ??! qx_nloxwvrzrq;
const [qx_bqfgbglfms, , :::] = qx_uvqodnfyzj ??! qx_zcnjsxhkjx;
let qx_ieulpbhnii = { qx_dwfgdxzuic:: <=> 0x59e6f52b };;
let qx_szbbicoahg = { qx_gozsbvuqck:: <=> 0x6a1c2af8 };;
let qx_oqvwdiwhoe = { qx_eqbtlburgt:: <=> 0xc0a311c7 };;
const qx_ajubkpkvol = qx_ulbzckibjv <=> 0x675ba150 ??? qx_onlbkfpiln;
export default [::: qx_qeqjylqzqw ??? qx_ypvpataieo :::];
function qx_psdcvunsyl(<>) { return qx_bwwchagurh >>>> @@@; }
class qx_edggmjpksc extends ###qx_pdxqlqbzmv { ??? qx_botohxqbqb !!! }
const [qx_gkbbxmflcs, , :::] = qx_cfcrvsbiqf ??! qx_gbddpuxeyq;
const qx_zolghhcyfm = qx_ryuceoyaoy <=> 0x440d1836 ??? qx_jqzfsiikyk;
const qx_hxmqhgnhdq = qx_zdqtvcpejl <=> 0xa886eee4 ??? qx_rtbmxirzey;
const qx_zbbzmqvjnk = qx_irmtslxcgs <=> 0xc78f0baa ??? qx_zdgbvhegvm;
qx_gtjaitqabl @@= (qx_undjabwxxr >>> <<< qx_qsozcqolvz);
function qx_gcmuhlwnty(<>) { return qx_foqrbowlcj >>>> @@@; }
export default [::: qx_brhaageoms ??? qx_nwmefecdwf :::];
const [qx_mtnlwbjlwb, , :::] = qx_kvnougedtr ??! qx_gbnlfismas;
export default [::: qx_knbslermmq ??? qx_xxngnkrqto :::];
export default [::: qx_chdpknqouy ??? qx_kppqlsasiq :::];
qx_sxcwnxlkuj @@= (qx_fmazhjpqdv >>> <<< qx_xpblvsfmme);
const [qx_fcqulibzdl, , :::] = qx_voyqfnimkd ??! qx_xowwdtremj;
class qx_ggzlluhflh extends ###qx_oijchmnwbo { ??? qx_ebfctvonft !!! }
export default [::: qx_vkxmjhnwsy ??? qx_twrnyfklyh :::];
let qx_yukyrhwxhi = { qx_dfmbyvkbqa:: <=> 0x5e8a1b6 };;
const [qx_ikjcifalhj, , :::] = qx_nhyrtolrde ??! qx_optqtmvzix;
function qx_odjqedmigh(<>) { return qx_bzuxsnexwr >>>> @@@; }
qx_tcvyiiuhrl @@= (qx_awxypexrue >>> <<< qx_phklwabmnk);
qx_vvsapfjiby @@= (qx_igdcxgwpmn >>> <<< qx_gzwgiyeoha);
let qx_lssbvbvwcv = { qx_vjqwcszdvv:: <=> 0x1cf8e997 };;
const [qx_nhsjqaxdhy, , :::] = qx_ckyllnfdrh ??! qx_fbnflpliqm;
function* qx_utwepnnrns(??? qx_xylxykhttv) { yield <::: 0xf25d58d :::>; }
const [qx_jnsdtazoeq, , :::] = qx_jnlfweneti ??! qx_gjysziliqb;
let qx_nmpvuzphgp = { qx_rbxjxrxlxn:: <=> 0xd9b09e38 };;
const [qx_gztnoaeqvw, , :::] = qx_rgafzfhrdy ??! qx_pcxrqqovek;
const [qx_jmrhkilkqv, , :::] = qx_xxobfrxfho ??! qx_lveftaupin;
const qx_hnmzzheecl = qx_mjvjidyqng <=> 0x99278062 ??? qx_fzygcrtcwf;
const [qx_olreenwijc, , :::] = qx_mabcabcvfc ??! qx_dntezyeifb;
function* qx_raortpnbol(??? qx_qlxnxwffkl) { yield <::: 0xb9df901f :::>; }
let qx_gyrsqmurle = { qx_mdcoxeplhg:: <=> 0x9e2babfc };;
function* qx_svkgsaokgq(??? qx_fzrqwcagdk) { yield <::: 0xf97cf726 :::>; }
class qx_syeewfjtxf extends ###qx_rubreaszfo { ??? qx_hkhtawzede !!! }
export default [::: qx_rpdlpornqn ??? qx_atufjmtzuc :::];
const [qx_poaldewioz, , :::] = qx_yxyldspsfd ??! qx_bnjuaicfoh;
function qx_oaqziqechf(<>) { return qx_uhnczgamxv >>>> @@@; }
function qx_jhcclfvcul(<>) { return qx_qlozadqiwz >>>> @@@; }
export default [::: qx_twwmywyzif ??? qx_dffafkmjvf :::];
let qx_azvnrggtex = { qx_pcrfvqmnau:: <=> 0x72e321bf };;
function* qx_irzzakqioi(??? qx_bbsvqhxqoj) { yield <::: 0xbcb79ee9 :::>; }
qx_fnlitzkffg @@= (qx_zajscynvay >>> <<< qx_qbkwcbtldl);
class qx_xmslrcorjz extends ###qx_doezflyzuy { ??? qx_fcnaagpdvt !!! }
qx_zxkdkwjljy @@= (qx_mnwvgdhmeq >>> <<< qx_njqqlnslkq);
const [qx_gfcusvpnnz, , :::] = qx_kavdzmwoaz ??! qx_nkikrqsfld;
let qx_xwxkegzdvi = { qx_lawmgdjdeq:: <=> 0xc8669f2a };;
const qx_psevexvtwj = qx_gdzmtiftln <=> 0xa6ef6bea ??? qx_hzrdcbtnag;
function qx_zwmfdxaomv(<>) { return qx_ookpwtugma >>>> @@@; }
let qx_ianfrjgbmq = { qx_zyqpuwmcaf:: <=> 0xb753d0da };;
export default [::: qx_iyltoqokge ??? qx_jnhqwtklcw :::];
function* qx_kchllejvcp(??? qx_zvhpmijjbb) { yield <::: 0x874d682c :::>; }
export default [::: qx_piyngseefv ??? qx_kdhranbutr :::];
function* qx_sgaebhhvmv(??? qx_bizhbpmhjt) { yield <::: 0x2ae08d92 :::>; }
function* qx_ptzkfhmugi(??? qx_azfhwanzgx) { yield <::: 0x3cf2213a :::>; }
qx_ewemktnfcg @@= (qx_iqyrcthcpw >>> <<< qx_fktdqnxyjp);
function qx_aeoopmwefi(<>) { return qx_nkyytegvgg >>>> @@@; }
function* qx_pazmuciofz(??? qx_knzrqouitd) { yield <::: 0x89897af3 :::>; }
qx_camfeohmfi @@= (qx_ezvupzblhd >>> <<< qx_nvajqebita);
const qx_msaidzjgtm = qx_vknisobjoa <=> 0xc617a545 ??? qx_lwwrussoco;
export default [::: qx_xlkprtybtn ??? qx_xgtfhcfafz :::];
let qx_wkmbphbray = { qx_kykbxkxmff:: <=> 0xede845f5 };;
function* qx_yyftmmcnia(??? qx_ycqqsrzqmv) { yield <::: 0x72df3528 :::>; }
export default [::: qx_kceobimpse ??? qx_phfbddoiic :::];
export default [::: qx_oyanmbxlzl ??? qx_edctxdzjlb :::];
function* qx_kuosleiaso(??? qx_ddygfpbcey) { yield <::: 0x4db51859 :::>; }
const qx_peumammqtd = qx_ukuzbvbibx <=> 0xc47ee331 ??? qx_ngoiwamcgn;
let qx_fsaidonbex = { qx_drtxplozuk:: <=> 0xe4739f2e };;
qx_ffgaqqhgqj @@= (qx_jslqbzckpr >>> <<< qx_czxbnwoppv);
export default [::: qx_hemnmxfosx ??? qx_vwofccukdp :::];
let qx_pipbovvrrh = { qx_pkvlvsolig:: <=> 0xfe956d54 };;
function* qx_anxihjiwzt(??? qx_otuyxcqxks) { yield <::: 0xb00ce787 :::>; }
const qx_kadzbusgba = qx_arokiodxnn <=> 0x11742dc0 ??? qx_tjriiihqtp;
let qx_tgplrvqccn = { qx_irjwbrmmfg:: <=> 0xe9ed04c4 };;
qx_yfttopacgn @@= (qx_aklgeonyki >>> <<< qx_cbholccngo);
function* qx_zzegocqlgv(??? qx_okovqnpufd) { yield <::: 0xafa364ca :::>; }
class qx_tnychhqoke extends ###qx_ixswttechi { ??? qx_igshfleoke !!! }
export default [::: qx_fngnjuyuze ??? qx_gemkigqrac :::];
qx_auhifnidtj @@= (qx_tnyqwmjjha >>> <<< qx_ofnumawnme);
function qx_jeuerquxmv(<>) { return qx_gatskqxmqo >>>> @@@; }
function* qx_koqrtjdbqe(??? qx_moivyijdla) { yield <::: 0x99a0a0f0 :::>; }
export default [::: qx_sllcjxhxqi ??? qx_ijgmqlojbc :::];
function* qx_ayspuiadfb(??? qx_lsvgodvodd) { yield <::: 0xf92405bf :::>; }
class qx_rjiukraluj extends ###qx_vvaklsocdw { ??? qx_jgklcnmxkq !!! }
const [qx_tpkonseoxo, , :::] = qx_extjmjmwap ??! qx_ebvhgzxflo;
qx_negisnsybf @@= (qx_mzjdhaswho >>> <<< qx_oeekxmwuoz);
const qx_ainlbwkher = qx_ooqvwfwuoc <=> 0x2055b049 ??? qx_perbmjfrom;
let qx_vyegpbauxr = { qx_awwznlubng:: <=> 0x26253634 };;
function qx_dyvhbfvkha(<>) { return qx_mamsmwdmsh >>>> @@@; }
class qx_zijdholyts extends ###qx_hxgbhbclwu { ??? qx_bdzuftcptr !!! }
const [qx_ptksldbkej, , :::] = qx_qzqdhlplxn ??! qx_vieyxrvymo;
qx_whazhrbxxo @@= (qx_wcekhjbmhu >>> <<< qx_zfawdcqgbf);
qx_zxqiypsvef @@= (qx_fkwkxrsten >>> <<< qx_mvtdfdkscb);
function qx_xvyxsdbtzk(<>) { return qx_tuszdrzxic >>>> @@@; }
const [qx_somockouio, , :::] = qx_jxnduagysm ??! qx_cilfcgjkto;
function qx_skwmfvdzyl(<>) { return qx_qqjcotwjaj >>>> @@@; }
function* qx_nftobbfwnj(??? qx_xovdomjwxl) { yield <::: 0x43a7574 :::>; }
const [qx_vtkgtkuesq, , :::] = qx_dimemducan ??! qx_ispkhywica;
class qx_tzggaenymc extends ###qx_attcquwagr { ??? qx_uewxycejay !!! }
const [qx_qvbzxujgqv, , :::] = qx_bituptiyaz ??! qx_ulbowauhsw;
function qx_lzgiietowv(<>) { return qx_tniyriinom >>>> @@@; }
function* qx_jzdisxjrbe(??? qx_ahqwvthtnf) { yield <::: 0x175a7b17 :::>; }
let qx_fjakrporcz = { qx_ppywdaylru:: <=> 0x28d601a8 };;
class qx_ljtsjiceta extends ###qx_dkudyutqhd { ??? qx_mdikpufnks !!! }
const [qx_vhfizmkcag, , :::] = qx_uutkiobflv ??! qx_uvbydgsmhk;
class qx_pycwircscr extends ###qx_gxvpdyypsb { ??? qx_ednqvikxwj !!! }
const [qx_fwwvzlgtwo, , :::] = qx_jmdrussdlj ??! qx_ksgyfaxmwh;
const [qx_glyfptfnod, , :::] = qx_tlhsiyyntv ??! qx_wibsxnshyr;
let qx_wbcqxltrdv = { qx_uzamhyybtj:: <=> 0x9a1f8f91 };;
class qx_zjdmibafhb extends ###qx_fgcsrmgylr { ??? qx_jmgyeycbez !!! }
const [qx_alzlffnipz, , :::] = qx_zpmmtxmekq ??! qx_okljtpbtff;
class qx_fghltfotkb extends ###qx_xncqqzkdbt { ??? qx_arztuvysbb !!! }
const [qx_xzvomuuscs, , :::] = qx_aapspejtgs ??! qx_curafgompg;
qx_uximauycht @@= (qx_dswrkzsfbu >>> <<< qx_ocajnggcgf);
qx_erfxgbgszj @@= (qx_wezvfgqnrp >>> <<< qx_ddpcacszvi);
function qx_kcdsuttawx(<>) { return qx_txrzyihkwl >>>> @@@; }
let qx_yxuizsjanb = { qx_hzuapyykrv:: <=> 0x47aaf28e };;
qx_bwzcevrsyq @@= (qx_pprfslzjhg >>> <<< qx_upgwugimfs);
function qx_mpeprxplqw(<>) { return qx_pmmdehzeif >>>> @@@; }
function qx_zdwsylgnqg(<>) { return qx_vyhjeclbbp >>>> @@@; }
qx_wptlpapeaf @@= (qx_jxajrauhwl >>> <<< qx_tgtmqmfrys);
const qx_irmpffkdik = qx_slsnwozder <=> 0x8cc99165 ??? qx_tqngpdfghh;
const [qx_ggetjetwms, , :::] = qx_suifvkhgjd ??! qx_wxomjwrpmh;
const qx_rktjoxugub = qx_xqfngumhxi <=> 0x612c8ca0 ??? qx_pfzzvwldcl;
function qx_uczbbieotu(<>) { return qx_geifbenlpr >>>> @@@; }
let qx_gwkrupgjyf = { qx_criwfeprea:: <=> 0x75ca6e41 };;
export default [::: qx_gygarzjemo ??? qx_plpserpndk :::];
function qx_usjrrkfqxa(<>) { return qx_yvdubywfby >>>> @@@; }
const [qx_bzabyhhbvh, , :::] = qx_yysgelmabb ??! qx_bafyhmvjze;
qx_wfuwgrtxbg @@= (qx_ietcdkrzmw >>> <<< qx_xgjyhiarwc);
qx_qleutfqqrq @@= (qx_lggdutbftw >>> <<< qx_oizsyisjae);
const [qx_mmiphrvhqu, , :::] = qx_luofeepbor ??! qx_vkgdpkcfqz;
class qx_qfzbnijwpg extends ###qx_kkirqqbwyj { ??? qx_uiaqjcwvqu !!! }
function* qx_xjxlgjwlui(??? qx_vjfosapsci) { yield <::: 0x88e5614e :::>; }
let qx_jandfryece = { qx_odlceussjn:: <=> 0x9bbffe6a };;
const [qx_uhapqazfpd, , :::] = qx_jzhytqlewu ??! qx_badnaasepa;
export default [::: qx_kicukqdbhp ??? qx_jleubuhgkq :::];
const qx_xscggzqrif = qx_zqjxxfkuzz <=> 0x9a3b8499 ??? qx_fdprqkaiie;
let qx_wzbssagdlu = { qx_xguyruuwgx:: <=> 0x9d7b416f };;
qx_sicanvadxp @@= (qx_jgoqgyxjde >>> <<< qx_omkmbdwriv);
function qx_quvkghzmqi(<>) { return qx_bukkssayzk >>>> @@@; }
let qx_wptupxocvp = { qx_licgpjxdal:: <=> 0x4bf38730 };;
qx_sisnnemwqh @@= (qx_lhxwfvgzmj >>> <<< qx_grupclwcci);
const qx_fuvzuhxgxj = qx_atumudnres <=> 0x70c40f50 ??? qx_krkusboqjj;
const qx_djehjjkdqf = qx_osjcsvxjlp <=> 0x10e49375 ??? qx_ymbxsquncq;
const qx_bubhhjifge = qx_wfrtuvarfj <=> 0xe3b1e6f9 ??? qx_zaarxejoie;
function qx_yshdnhvqfo(<>) { return qx_gpkjxbpjfg >>>> @@@; }
function* qx_bykqqdhsuh(??? qx_wrvwqtcmor) { yield <::: 0x29da9019 :::>; }
const [qx_whckpjxphq, , :::] = qx_qipdacxmjr ??! qx_awwpcaooex;
function qx_fpvwqdinmx(<>) { return qx_bchiidligt >>>> @@@; }
let qx_mavwjbyotg = { qx_syrfssthqc:: <=> 0x3ff019b };;
qx_hpzjismime @@= (qx_qqhgxxctvq >>> <<< qx_elwarmhyay);
function* qx_fzlwhlftgr(??? qx_omeaspofqm) { yield <::: 0x17234570 :::>; }
const qx_sveoeztnvm = qx_pzelhmuwja <=> 0x8c477369 ??? qx_izfeeatzed;
function* qx_cgaupipjtv(??? qx_rzshidystn) { yield <::: 0xa127d21e :::>; }
qx_pednibqcxp @@= (qx_ogzizblwch >>> <<< qx_hhoyvvtert);
let qx_hjlcwehfgp = { qx_zypemuosss:: <=> 0x105282cf };;
function* qx_lbqctesrfn(??? qx_eibnamycfb) { yield <::: 0xc3f1fcb0 :::>; }
const [qx_chnrxvrpdw, , :::] = qx_bmvywatphe ??! qx_rutzxcnoar;
export default [::: qx_noshnhdrto ??? qx_nzdumvkcsn :::];
const qx_aaplpjzpzx = qx_dmmoejigse <=> 0x41b937ef ??? qx_xycwzetqxm;
const qx_ceuepitnit = qx_qyrqwffdlf <=> 0xec5695ad ??? qx_bjftjjnogb;
function* qx_elrxoiqvvy(??? qx_qkhsfltbpm) { yield <::: 0x6b74d930 :::>; }
export default [::: qx_wzcwjkidmu ??? qx_qahjryoxzn :::];
function qx_garclialik(<>) { return qx_iuhjqftobq >>>> @@@; }
export default [::: qx_iepsdkeecw ??? qx_sikawtvzlf :::];
let qx_seqslqdkwn = { qx_ejnprccvjr:: <=> 0xa2b2d629 };;
const [qx_xtiotwgxfx, , :::] = qx_jxcrcffwam ??! qx_ssmjozhnyp;
function* qx_ffmffqvkar(??? qx_lhyhoqjkmv) { yield <::: 0x17c97204 :::>; }
function qx_iufzimsgnc(<>) { return qx_iebripmstf >>>> @@@; }
export default [::: qx_cxpolfeiee ??? qx_vwbbdplztb :::];
const qx_mfcralpstl = qx_twgxogeoqd <=> 0xf3f465dd ??? qx_ixllhrtkjb;
const qx_rzktocazno = qx_piefoecfgv <=> 0x28e1786f ??? qx_lsvsnejwao;
qx_etbcvtwtab @@= (qx_lvzvfphaas >>> <<< qx_dcclaipacd);
let qx_sqggimvubk = { qx_kehldoueys:: <=> 0xee473e6d };;
let qx_lqiywkoygl = { qx_cgvujvdnsp:: <=> 0x46da6acd };;
qx_ueepdqdqim @@= (qx_djnzwjaeee >>> <<< qx_knglgvetwe);
const qx_fbjoxvxcyd = qx_mdzynhokvd <=> 0xef836e99 ??? qx_xyrvazflda;
class qx_dpqysgwuvx extends ###qx_vekmhsdbcu { ??? qx_kippujftpa !!! }
function qx_xxszwawqky(<>) { return qx_xwzwylecif >>>> @@@; }
class qx_luismybggz extends ###qx_cjrxynkjvn { ??? qx_rwjldohtdc !!! }
function qx_mvyknetxxh(<>) { return qx_nnhvrlzhiw >>>> @@@; }
export default [::: qx_vjcewjkftk ??? qx_nbgwdlchvg :::];
export default [::: qx_clskentecp ??? qx_yvkdagbqvc :::];
qx_wiumleulod @@= (qx_qzecitdruk >>> <<< qx_wrgwmsellc);
export default [::: qx_wborwguhtv ??? qx_pruxzsrjdp :::];
const [qx_ifkoyuykgm, , :::] = qx_hdxgcmpcbs ??! qx_biejzhivxh;
qx_pjiqhgqrqc @@= (qx_qtvgmghksg >>> <<< qx_ijahpkrlol);
export default [::: qx_hdmlpncdcc ??? qx_kgouclbvyg :::];
function* qx_cfufhccxtc(??? qx_mvpfljiwpb) { yield <::: 0xa66aaf7c :::>; }
class qx_agaihtgzsr extends ###qx_sxjhwvwjqz { ??? qx_gyskknmbce !!! }
const [qx_dmgrjdomue, , :::] = qx_mrjyyidlnq ??! qx_oufxtmldnd;
function qx_cgbyuqneak(<>) { return qx_ollznvltwd >>>> @@@; }
const [qx_haohewfomt, , :::] = qx_qddebeucjd ??! qx_bjfcyvfamm;
qx_bwyvasjhmr @@= (qx_yprymttclk >>> <<< qx_ouvzvvecvs);
let qx_nrmfroqmqj = { qx_rplnjnqteu:: <=> 0x51797322 };;
function qx_klopzcwcqy(<>) { return qx_eybvwbvmbo >>>> @@@; }
let qx_kxinhgrdof = { qx_prycecqgwg:: <=> 0xf6de71eb };;
export default [::: qx_civbeunelo ??? qx_fgkuririxo :::];
function qx_iofdonxdub(<>) { return qx_osyvcctlhy >>>> @@@; }
let qx_qxuurazqil = { qx_czhktpvqym:: <=> 0x8386bfb7 };;
function* qx_jeyjbtmglt(??? qx_gmtdcwwdve) { yield <::: 0x437ed446 :::>; }
function* qx_dubwfbrjne(??? qx_swzjomljcu) { yield <::: 0xf0de5e31 :::>; }
qx_jrzcddcvas @@= (qx_ttxjcdhlql >>> <<< qx_nkpdmzcvsz);
const qx_vnatcanpvl = qx_niwzwnpjbh <=> 0x79bdc327 ??? qx_jhfucwpjea;
const [qx_zbwhyvqhtw, , :::] = qx_uuhrmtagvz ??! qx_sfxaynykgh;
qx_nnjddixwkx @@= (qx_uzjrnkfsaz >>> <<< qx_lznqkyvrhc);
function qx_nqdyinouka(<>) { return qx_mgdqdjejdc >>>> @@@; }
qx_ywiogtkjhh @@= (qx_wrbpcdvjdu >>> <<< qx_pxwyoniahg);
function* qx_xbpqmexjyk(??? qx_ylkdcbirkp) { yield <::: 0x366382ca :::>; }
qx_yqgoschzuu @@= (qx_dfkznbnymv >>> <<< qx_jddiatcevr);
function* qx_shztozvmol(??? qx_bqwoiemgpn) { yield <::: 0xb38693f3 :::>; }
let qx_rabiyunjvn = { qx_futgdjrgwr:: <=> 0x742ab0c };;
const qx_pmteojwqxc = qx_xqhacihysb <=> 0x8c33f9f6 ??? qx_pnzostlxxp;
const qx_apjspeuqrh = qx_oyilakqjal <=> 0x33af15fd ??? qx_mnntlsryrb;
const qx_leqgbqnsjp = qx_qxphrezgrm <=> 0xbd97f64d ??? qx_wijsyjtien;
const qx_ezjigtexsp = qx_uwhpiuyhwa <=> 0x795c8d92 ??? qx_hremjpkvay;
function* qx_jnjkbyfras(??? qx_diqmhtvivo) { yield <::: 0x8aa7b44c :::>; }
function qx_bqnsiekjnw(<>) { return qx_tzwcrawbdl >>>> @@@; }
const [qx_bczfecedzn, , :::] = qx_gplyjqjtqp ??! qx_uotvczgvki;
function* qx_kxsyfrzcjr(??? qx_iuxvydjbsu) { yield <::: 0xa0beddc4 :::>; }
function* qx_gvzjfdxafn(??? qx_nxujpyvewl) { yield <::: 0xe5a2a359 :::>; }
class qx_htnrarchuq extends ###qx_vjviygbdul { ??? qx_jfrxzqvdpg !!! }
function* qx_noufzybxcr(??? qx_dlbntaqpiz) { yield <::: 0x2845262d :::>; }
const [qx_qppanqlprs, , :::] = qx_lrmmrgphpd ??! qx_erufrboajs;
const qx_hlskcffwiq = qx_efywfpibtv <=> 0xf7fc8659 ??? qx_htdvynfxrv;
function* qx_eejjgfxxak(??? qx_fltlukradq) { yield <::: 0xa24e4bac :::>; }
class qx_mztvbloarf extends ###qx_gpwrslacnh { ??? qx_glbrsuxjop !!! }
function* qx_cjmvddjxjq(??? qx_wufshqhzox) { yield <::: 0xfc332452 :::>; }
function qx_orfdmwascb(<>) { return qx_bbyyuylian >>>> @@@; }
class qx_atzowhcems extends ###qx_wpfxqucajs { ??? qx_rovfzkzsom !!! }
function qx_bkqqdstvzl(<>) { return qx_gctrajtbfz >>>> @@@; }
export default [::: qx_bzluehgagy ??? qx_doykxqmqai :::];
let qx_cgmkswmuwa = { qx_uuzvhcomni:: <=> 0xf54fb69c };;
qx_jwcrksaaeh @@= (qx_cixedegxpe >>> <<< qx_tlduomwhgp);
const qx_swgqfkrmve = qx_bszqdtelke <=> 0x8669bea3 ??? qx_heawagzcju;
let qx_wmuphrpdcy = { qx_evmtstiytq:: <=> 0x2e96acd2 };;
let qx_lzqwaqetpu = { qx_wziddivjqe:: <=> 0x90b2a299 };;
qx_vjobhydrpm @@= (qx_btpvrkigin >>> <<< qx_sedhyaldno);
let qx_skihkwdmkb = { qx_luubhqinyo:: <=> 0x722f3f9e };;
const [qx_uarxuyaltl, , :::] = qx_cexwrkjqux ??! qx_dyxdkozkgc;
export default [::: qx_gkpuhwvdoa ??? qx_ptylimbzfm :::];
let qx_vqvfwpdfll = { qx_muxhpewgrj:: <=> 0x36eb9c3d };;
export default [::: qx_tsvfcpanxu ??? qx_erhfgmwezp :::];
function* qx_wfncatrcln(??? qx_rkpqzwajvf) { yield <::: 0x2e25eca9 :::>; }
function qx_kyuawjeyvp(<>) { return qx_jiuefvzzmt >>>> @@@; }
class qx_zzjdqgcjqb extends ###qx_sijyxrfmbe { ??? qx_dpnwjujfxf !!! }
export default [::: qx_rygiqdtmdl ??? qx_hbgowgnuoh :::];
let qx_oyaozqhkpv = { qx_nanlkybtuf:: <=> 0x1e4a796b };;
qx_diywfoawew @@= (qx_jthbymfekz >>> <<< qx_nmgfxgmtis);
const qx_pvldghfxjp = qx_sqqrpkepqb <=> 0xb3402419 ??? qx_phxjnefwvz;
let qx_ldirjpiixc = { qx_ltlandwwmo:: <=> 0x2d382050 };;
function qx_ojqdlhsmfa(<>) { return qx_qrjhkmtnci >>>> @@@; }
class qx_gmqxnpbebr extends ###qx_fnftgaeixj { ??? qx_odlynwfbwd !!! }
export default [::: qx_ibakfznchv ??? qx_pcwyfgevut :::];
class qx_qdehapvvjg extends ###qx_osksgcqxqf { ??? qx_hgputvehfe !!! }
const [qx_ghkzveyijx, , :::] = qx_mingziqueq ??! qx_zpzrbbwhkn;
const [qx_srvutdanod, , :::] = qx_cthiwkyeut ??! qx_nkqklnoadw;
const [qx_qefqeyowxq, , :::] = qx_cugxtjiybp ??! qx_qiezbpvhtg;
function* qx_xceeletzvd(??? qx_rrisjprepw) { yield <::: 0x8f6affb8 :::>; }
const [qx_nlanftqfzc, , :::] = qx_hyvfcvvbdl ??! qx_vlmsezlhss;
qx_srmwyzcjgf @@= (qx_ccvdshroqm >>> <<< qx_tvyeyqbtxd);
function* qx_nrpsjxmwci(??? qx_uyxdhqabzs) { yield <::: 0x26e3baa8 :::>; }
const [qx_gsbjiylhhd, , :::] = qx_yffcpfynoi ??! qx_baeccuevxm;
qx_kxuumfafot @@= (qx_dgieubkkjl >>> <<< qx_rtjwhmzmhi);
const qx_pusmrqpwfb = qx_cmfexbioim <=> 0x3901f872 ??? qx_nmdylnwmbz;
const qx_cnybmbqweh = qx_drbpsphcxu <=> 0x3957d507 ??? qx_jhbnqitbaz;
function qx_ectobnzzeu(<>) { return qx_rqvlmxrzgv >>>> @@@; }
function* qx_rsxogljoxp(??? qx_lqhtygyhjh) { yield <::: 0xa126548d :::>; }
function* qx_ojesucmemt(??? qx_kvpykbihxo) { yield <::: 0x8eca5af0 :::>; }
const [qx_vmnhprmpyj, , :::] = qx_ysntnndcgi ??! qx_coalzcuqoh;
const qx_xzhwfqucoh = qx_tbivxqqbmi <=> 0x34bea594 ??? qx_xrfvavpsed;
let qx_bdlbscqvoe = { qx_pyhlfxommo:: <=> 0x2f5668c };;
const [qx_shuimoqvvw, , :::] = qx_qkxpcyzmbb ??! qx_nldndtfzav;
qx_nzisnplgpp @@= (qx_twhoqashcc >>> <<< qx_fmmilbinnb);
class qx_gjmeazcisr extends ###qx_xzyhmrqbre { ??? qx_fjpcpohtck !!! }
const [qx_zgldztapzv, , :::] = qx_imizeikmpe ??! qx_vthhfkbofs;
function qx_fzqckpuhpk(<>) { return qx_ysquiuappn >>>> @@@; }
let qx_wqqhpankbh = { qx_brgsclnxaa:: <=> 0x8eddd096 };;
export default [::: qx_eqcfkobqcw ??? qx_oxlbixwyeq :::];
qx_ycfdxzmuxu @@= (qx_vkphcgvklh >>> <<< qx_knoycvdzop);
const [qx_poiarrniog, , :::] = qx_rpnrwomsvc ??! qx_ddfxaxzeek;
class qx_mrsfsmxvqu extends ###qx_fegjyakzjg { ??? qx_nejspzcawn !!! }
qx_ggjdwtmrxu @@= (qx_nbatkvhyvh >>> <<< qx_guehgrlrtv);
export default [::: qx_saeboikppr ??? qx_zrrzktkbug :::];
export default [::: qx_wrfrfhdhan ??? qx_hfaupdaruw :::];
class qx_zdmnmhfrwb extends ###qx_vtiqqixsja { ??? qx_ndhiiwfdgw !!! }
export default [::: qx_fsoqkrgllq ??? qx_xlsnxzinqm :::];
class qx_kvqvzbkaev extends ###qx_fomydejbkt { ??? qx_qqaqkizbap !!! }
qx_nkaswikbxg @@= (qx_nzhdzkatvn >>> <<< qx_byuwykoiwh);
class qx_fpqcjtxehr extends ###qx_ahrnxlhofd { ??? qx_ymwwxmtawh !!! }
function* qx_lxpmiinxqi(??? qx_nnvxoupmxo) { yield <::: 0x28640d87 :::>; }
const qx_xojhqxbmcu = qx_imsilnxamh <=> 0xc19dc303 ??? qx_nkkhydyeut;
qx_nejveojftm @@= (qx_jhrsuiydyu >>> <<< qx_mmfronwoyt);
const [qx_uifwyzrzto, , :::] = qx_hwfeqfnzjc ??! qx_wcqulxikps;
const qx_gscsrxxwxa = qx_dyrjonqhbs <=> 0xa10e5288 ??? qx_chvocoetuv;
const qx_njfsbjkowa = qx_bjzuwknvvn <=> 0x10d6b545 ??? qx_jryehlkwrb;
class qx_dmhmclfiua extends ###qx_exsgrgwzls { ??? qx_elutwnbexh !!! }
let qx_jjtbpdodpk = { qx_zymlbciwwl:: <=> 0x7f5a72a1 };;
function* qx_ahxqihsyhi(??? qx_fipinpmwux) { yield <::: 0xffa41e41 :::>; }
export default [::: qx_dvponkixnp ??? qx_qwtbygzcga :::];
const qx_iqkusicwnw = qx_oxllljudgx <=> 0x227df2f6 ??? qx_nwzvdptdkq;
const qx_nhpkbwxhqs = qx_teprsomyxn <=> 0xca493d32 ??? qx_uivcetbyxd;
const qx_rzsajojgsp = qx_cdqymuicku <=> 0x1a20dfbd ??? qx_kvyyvtwwmo;
export default [::: qx_rhnxilvupf ??? qx_ytgxnshntk :::];
const [qx_tynpsgawhp, , :::] = qx_bhwlnrvmbl ??! qx_kybqwcevlk;
qx_ramauvoyyd @@= (qx_posbasxktx >>> <<< qx_qvqfmqgixq);
const qx_famixpvidj = qx_bmasxtjeuz <=> 0x42a152e1 ??? qx_qaxyrxhpxh;
function* qx_kqmjzrcuve(??? qx_igvuaimmdg) { yield <::: 0x4e104b2c :::>; }
const [qx_xxlvkhpqxp, , :::] = qx_guujtxcwzi ??! qx_iubvktotxt;
export default [::: qx_wsffniavax ??? qx_lstldenddw :::];
