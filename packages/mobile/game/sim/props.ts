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

/** Does this cell carry a prop? */
export function cellHasProp(seed: number, cx: number, cy: number): boolean {
  return propHash(cx, cy, seed) % 1024 < PROP_CHANCE_PER_1024;
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

  /** Point the field at a stage. Clears everything, including what was broken on the last one. */
  setSeed(seed: number): void {
    this.seed = seed | 0;
    this.clear();
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
        if (!cellHasProp(this.seed, cx, cy)) continue;
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
