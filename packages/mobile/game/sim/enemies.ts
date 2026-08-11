/**
 * The crowd.
 *
 * This is the file the whole performance contract rests on. 800 enemies, every one of them moving,
 * pushing on its neighbours and being tested against the player, sixty times a second, on a 4GB
 * phone. Three rules make that possible and all three are unforgiving:
 *
 *  1. NO OBJECTS. There is no `Enemy` class and there never will be. Each attribute is its own
 *     typed array and an enemy is an index shared across them. 800 objects means 800 headers to
 *     chase through memory and 800 things for the garbage collector to think about; 800 indices
 *     into a flat array is one contiguous block the CPU can stream. This is the single biggest
 *     difference between a smooth crowd and a slideshow.
 *  2. NO ALLOCATION IN A TICK. Every buffer here is created once. `new` inside the update loop is
 *     a bug, not a style preference — an earlier version of the render batcher created one small
 *     array per frame and it starved the collector badly enough to freeze the game after 75
 *     seconds. That lesson is why the scratch buffers are fields.
 *  3. SEPARATION IS APPROXIMATE ON PURPOSE. Enemies push apart so the horde reads as a crowd
 *     rather than a single stacked sprite, but a true all-pairs push is 320,000 comparisons at 800
 *     enemies. We ask the spatial grid for nearby candidates and cap how many neighbours any one
 *     enemy will resolve against per tick. A slightly imperfect push that holds 60fps beats a
 *     perfect one that doesn't, and nobody can see the difference in motion.
 */

import { SpatialHash } from "../core/spatial-hash";
import { EntityPool, NULL_HANDLE, POOL_BUDGETS, type Handle } from "../core/pool";
import { STAT, STAT_SCALE, type Stats } from "./stats";

/** Enemy behaviour archetypes. Append-only: written into replay and co-op event streams. */
export const ENEMY_KIND = {
  /** Walks straight at the nearest player. The bread and butter of the horde. */
  chaser: 0,
  /** Faster, frailer. Arrives in tides. */
  swarmer: 1,
  /** Slow, heavy, high health. Used to wall off escape routes. */
  brute: 2,
  /** Picks a heading at the player and commits to it, passing straight through. */
  charger: 3,
  /** Orbits at a distance rather than closing. Forces the player to come to it. */
  circler: 4,
  /** Named wave boss. One at a time, carries a health bar. */
  boss: 5,
} as const;

export type EnemyKind = (typeof ENEMY_KIND)[keyof typeof ENEMY_KIND];

/** Per-enemy flag bits. */
export const ENEMY_FLAG = {
  /** Currently in knockback; steering is suppressed while this is set. */
  knocked: 1 << 0,
  /** Immune to knockback entirely (brutes, bosses). */
  heavy: 1 << 1,
  /** Ignores the separation push, so it can walk through the crowd. */
  phasing: 1 << 2,
  /** Counts toward the boss health bar and blocks other bosses from spawning. */
  boss: 1 << 3,
  /** Will not be culled for being off-screen. Bosses and chargers mid-charge. */
  persistent: 1 << 4,
} as const;

/**
 * Enemy type definition. Content, not code — every number a designer would want to turn lives here,
 * and adding a new enemy is adding a record to the table below.
 *
 * `health`, `damage` and `speed` are base values before the run's stat multipliers apply, so a
 * Hyper run does not need its own copy of this table.
 */
export interface EnemyType {
  readonly id: string;
  readonly kind: EnemyKind;
  /** Frame name in the sprite atlas. */
  readonly sprite: string;
  readonly health: number;
  /** Contact damage per hit. */
  readonly damage: number;
  /** World units per second before multipliers. */
  readonly speed: number;
  /** Collision radius in world units. Also the separation radius. */
  readonly radius: number;
  /** XP dropped, before the run's gem-value multiplier. */
  readonly xp: number;
  /** Chance in permille of dropping gold on death. */
  readonly goldChance: number;
  /** Default flags for this type. */
  readonly flags: number;
}

/**
 * The launch enemy roster's first tier. Sixteen sprites exist in the first art sheet; these are the
 * behaviours those sprites hang off. Deliberately small numbers — the difficulty curve comes from
 * the wave table and the Curse multiplier, not from inflating these.
 */
export const ENEMY_TYPES: readonly EnemyType[] = [
  {
    id: "shambler",
    kind: ENEMY_KIND.chaser,
    sprite: "enemy.shambler",
    health: 10,
    damage: 4,
    speed: 34,
    radius: 7,
    xp: 1,
    goldChance: 15,
    flags: 0,
  },
  {
    id: "gnawer",
    kind: ENEMY_KIND.swarmer,
    sprite: "enemy.gnawer",
    health: 6,
    damage: 3,
    speed: 52,
    radius: 5,
    xp: 1,
    goldChance: 8,
    flags: 0,
  },
  {
    id: "bonepile",
    kind: ENEMY_KIND.brute,
    sprite: "enemy.bonepile",
    health: 60,
    damage: 9,
    speed: 22,
    radius: 11,
    xp: 4,
    goldChance: 60,
    flags: ENEMY_FLAG.heavy,
  },
  {
    id: "hound",
    kind: ENEMY_KIND.charger,
    sprite: "enemy.hound",
    health: 14,
    damage: 6,
    speed: 74,
    radius: 7,
    xp: 2,
    goldChance: 20,
    flags: ENEMY_FLAG.persistent,
  },
  {
    id: "wisp",
    kind: ENEMY_KIND.circler,
    sprite: "enemy.wisp",
    health: 18,
    damage: 5,
    speed: 44,
    radius: 6,
    xp: 3,
    goldChance: 35,
    flags: ENEMY_FLAG.phasing,
  },
  {
    id: "gravewarden",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.gravewarden",
    health: 900,
    damage: 16,
    speed: 30,
    radius: 18,
    xp: 60,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
];

export const ENEMY_TYPE_BY_ID: ReadonlyMap<string, number> = new Map(
  ENEMY_TYPES.map((t, i) => [t.id, i]),
);

/** Grid cell size for the enemy broad phase, in world units. */
export const ENEMY_CELL_SIZE = 24;

/**
 * How many neighbours one enemy will push against per tick.
 *
 * Six is the number where a crowd stops visibly overlapping. Raising it does almost nothing for
 * appearance and costs linearly, because it multiplies against the entity count in the hottest
 * loop in the game.
 */
export const SEPARATION_NEIGHBOURS = 6;

/** How hard enemies push apart, relative to their overlap depth. */
export const SEPARATION_STRENGTH = 0.55;

/** Ticks a knocked-back enemy stays under knockback control before steering resumes. */
export const KNOCKBACK_TICKS = 8;

/** Distance past which a non-persistent enemy is recycled, in world units from the nearest player. */
export const CULL_DISTANCE = 900;

const TICK_SECONDS = 1 / 60;

/**
 * Storage for the entire crowd.
 *
 * The pool hands out slots; these arrays hold what lives in them. Iteration goes through the pool's
 * dense list so an empty screen costs nothing even though the arrays stay at full size.
 */
export class EnemyStore {
  readonly pool: EntityPool;
  readonly capacity: number;

  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Current velocity, world units per second. Written by steering, read by movement. */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Accumulated separation push for this tick, applied after every enemy has been considered. */
  readonly pushX: Float32Array;
  readonly pushY: Float32Array;
  readonly health: Float32Array;
  readonly maxHealth: Float32Array;
  readonly radius: Float32Array;
  readonly speed: Float32Array;
  readonly damage: Float32Array;
  readonly typeIndex: Int32Array;
  readonly flags: Int32Array;
  /** Ticks remaining of knockback control. */
  readonly knockTicks: Int32Array;
  /** Which player this enemy is currently hunting. Recomputed periodically, not every tick. */
  readonly target: Int32Array;
  /** Animation clock, ticks since spawn. Render-only; never affects the sim. */
  readonly age: Int32Array;
  /** Facing, for sprite selection: 0 south, 1 west, 2 north, 3 east. */
  readonly facing: Int32Array;

  readonly grid: SpatialHash;

  /** Scratch for broad-phase results. Owned here so queries never allocate. */
  private readonly neighbours: Int32Array;

  /**
   * Where `queryNear` writes its results. Deliberately a different buffer from the internal
   * separation scratch: callers outside this file read it after their query returns, and sharing
   * one buffer would mean an enemy tick could quietly overwrite results someone else still holds.
   */
  readonly neighbourScratch: Int32Array;

  /** Enemies killed this run. Drives the results screen and achievement checks. */
  kills = 0;
  /** Enemies recycled for wandering too far. Dev-menu diagnostic. */
  culled = 0;

  constructor(capacity: number = POOL_BUDGETS.enemies) {
    this.capacity = capacity;
    this.pool = new EntityPool(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.pushX = new Float32Array(capacity);
    this.pushY = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.maxHealth = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.typeIndex = new Int32Array(capacity);
    this.flags = new Int32Array(capacity);
    this.knockTicks = new Int32Array(capacity);
    this.target = new Int32Array(capacity);
    this.age = new Int32Array(capacity);
    this.facing = new Int32Array(capacity);
    this.grid = new SpatialHash(ENEMY_CELL_SIZE, capacity);
    this.neighbours = new Int32Array(64);
    this.neighbourScratch = new Int32Array(64);
  }

  /**
   * Enemies whose cells overlap a circle. Results land in `neighbourScratch`; the return value is
   * how many of them are valid. Broad phase only — the caller still checks real distances.
   *
   * Capped at the scratch length, which is fine: nothing in the game needs to hit more than 64
   * enemies from one point in one tick, and a hard cap is what keeps a Limit Break pile-up from
   * turning one query into a frame drop.
   */
  queryNear(x: number, y: number, radius: number): number {
    return this.grid.queryRadiusInto(x, y, radius, this.neighbourScratch);
  }

  get count(): number {
    return this.pool.count;
  }

  /** Live slots. Read `count` first — everything past it is stale. */
  get slots(): Int32Array {
    return this.pool.slots;
  }

  /**
   * Spawn one enemy. Returns its handle, or `NULL_HANDLE` if the pool is full.
   *
   * A refused spawn is a normal outcome during a Limit Break storm, and dropping one enemy is
   * always the right call over dropping a frame.
   */
  spawn(typeIndex: number, x: number, y: number, stats: Stats): Handle {
    const handle = this.pool.alloc();
    if (handle === NULL_HANDLE) return NULL_HANDLE;
    const slot = handle & 0xffff;
    const type = ENEMY_TYPES[typeIndex];

    // Curse multiplies health, speed and count together — it is the single knob that makes the
    // late game and Endless cycles escalate without touching the wave table.
    const curse = stats.get(STAT.curse);
    const hp = Math.max(
      1,
      Math.trunc((((type.health * stats.get(STAT.enemyHealth)) / STAT_SCALE) * curse) / STAT_SCALE),
    );

    this.x[slot] = x;
    this.y[slot] = y;
    this.vx[slot] = 0;
    this.vy[slot] = 0;
    this.pushX[slot] = 0;
    this.pushY[slot] = 0;
    this.health[slot] = hp;
    this.maxHealth[slot] = hp;
    this.radius[slot] = type.radius;
    // Curse is baked in here because it is a property of the cycle the enemy was born into.
    // enemySpeed is NOT baked in: it is applied live in update() so that a modifier arriving
    // mid-run (an Arcana, a dev-menu slider) speeds up the crowd already on screen instead of
    // only the next spawns. Freezing it at spawn is the same bug the wave cap had.
    this.speed[slot] = type.speed * (curse / STAT_SCALE);
    this.damage[slot] = (type.damage * stats.get(STAT.enemyDamage)) / STAT_SCALE;
    this.typeIndex[slot] = typeIndex;
    this.flags[slot] = type.flags;
    this.knockTicks[slot] = 0;
    this.target[slot] = 0;
    this.age[slot] = 0;
    this.facing[slot] = 0;
    return handle;
  }

  kill(slot: number): void {
    this.pool.freeSlot(slot);
    this.kills++;
  }

  /**
   * Apply damage. Returns true if this hit killed it.
   *
   * Kept here rather than in a weapon file so that every damage source — weapon, aura, burn,
   * reflected contact — goes through exactly one death path. Two death paths is how you get a
   * boss that drops loot twice.
   */
  damageAt(slot: number, amount: number): boolean {
    if (!this.pool.isSlotAlive(slot)) return false;
    this.health[slot] -= amount;
    if (this.health[slot] <= 0) {
      this.kill(slot);
      return true;
    }
    return false;
  }

  /** Shove an enemy. Heavy enemies ignore it, which is what makes brutes feel like walls. */
  knockback(slot: number, dx: number, dy: number, force: number): void {
    if ((this.flags[slot] & ENEMY_FLAG.heavy) !== 0) return;
    const len = Math.hypot(dx, dy);
    if (len < 0.0001) return;
    this.vx[slot] = (dx / len) * force;
    this.vy[slot] = (dy / len) * force;
    this.knockTicks[slot] = KNOCKBACK_TICKS;
    this.flags[slot] |= ENEMY_FLAG.knocked;
  }

  clear(): void {
    this.pool.clear();
    this.kills = 0;
    this.culled = 0;
  }

  /** Rebuild the broad phase. Must run before steering or any weapon query this tick. */
  rebuildGrid(): void {
    const grid = this.grid;
    const slots = this.pool.slots;
    const n = this.pool.count;
    grid.beginFrame();
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      grid.insert(s, this.x[s], this.y[s]);
    }
    grid.build();
  }

  /**
   * Move the crowd one tick.
   *
   * `playerX`/`playerY` are parallel arrays, one entry per live player, so co-op needs no separate
   * code path — solo is simply the one-player case of the same loop.
   */
  update(playerX: Float32Array, playerY: Float32Array, playerCount: number, stats: Stats): void {
    const slots = this.pool.slots;
    const n = this.pool.count;
    if (n === 0) return;

    const dt = TICK_SECONDS;
    const knockDrag = 0.82;
    // Hoisted once per tick, not once per enemy: enemySpeed is a live multiplier so mid-run
    // modifiers reach the crowd already on screen.
    const speedScale = stats.get(STAT.enemySpeed) / STAT_SCALE;

    // --- Pass 1: steering -----------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      this.age[s]++;

      if (this.knockTicks[s] > 0) {
        // Under knockback the enemy is not driving; it is sliding. Bleed the velocity off so it
        // eases back into the chase instead of snapping, which reads as weight.
        this.knockTicks[s]--;
        this.vx[s] *= knockDrag;
        this.vy[s] *= knockDrag;
        if (this.knockTicks[s] === 0) this.flags[s] &= ~ENEMY_FLAG.knocked;
        continue;
      }

      // Nearest player. With four players this is four distance checks, cheaper than caching and
      // far cheaper than being wrong when a player goes down.
      let bestIdx = 0;
      let bestDistSq = Infinity;
      for (let p = 0; p < playerCount; p++) {
        const dx = playerX[p] - this.x[s];
        const dy = playerY[p] - this.y[s];
        const d = dx * dx + dy * dy;
        if (d < bestDistSq) {
          bestDistSq = d;
          bestIdx = p;
        }
      }
      this.target[s] = bestIdx;

      const dx = playerX[bestIdx] - this.x[s];
      const dy = playerY[bestIdx] - this.y[s];
      const dist = Math.sqrt(bestDistSq) || 1;
      const speed = this.speed[s] * speedScale;

      switch (ENEMY_TYPES[this.typeIndex[s]].kind) {
        case ENEMY_KIND.circler: {
          // Hold a ring at 110 units: close if outside it, back off if inside, and always drift
          // sideways so it circles rather than jittering on the boundary.
          const ring = 110;
          const radial = dist > ring ? 1 : -1;
          const tangentX = -dy / dist;
          const tangentY = dx / dist;
          this.vx[s] = ((dx / dist) * radial * 0.6 + tangentX * 0.8) * speed;
          this.vy[s] = ((dy / dist) * radial * 0.6 + tangentY * 0.8) * speed;
          break;
        }
        case ENEMY_KIND.charger: {
          // Commits to a heading and keeps it until it is well past, so the player can dodge by
          // stepping aside instead of by out-running it.
          if (this.vx[s] === 0 && this.vy[s] === 0) {
            this.vx[s] = (dx / dist) * speed;
            this.vy[s] = (dy / dist) * speed;
          }
          break;
        }
        default: {
          this.vx[s] = (dx / dist) * speed;
          this.vy[s] = (dy / dist) * speed;
          break;
        }
      }

      // Facing for the sprite. Whichever axis dominates wins, which is what keeps a diagonal
      // walker from flickering between two frames.
      this.facing[s] =
        Math.abs(this.vx[s]) > Math.abs(this.vy[s])
          ? this.vx[s] < 0
            ? 1
            : 3
          : this.vy[s] < 0
            ? 2
            : 0;
    }

    // --- Pass 2: separation ---------------------------------------------------------------
    // Accumulated into a separate buffer rather than applied inline, because applying inline makes
    // the result depend on iteration order — and iteration order changes as the pool recycles
    // slots, which would mean two machines running the same co-op session drift apart.
    this.pushX.fill(0, 0, this.capacity);
    this.pushY.fill(0, 0, this.capacity);
    const near = this.neighbours;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if ((this.flags[s] & ENEMY_FLAG.phasing) !== 0) continue;
      const found = this.grid.queryInto(this.x[s], this.y[s], near);
      let resolved = 0;
      for (let k = 0; k < found && resolved < SEPARATION_NEIGHBOURS; k++) {
        const o = near[k];
        if (o === s) continue;
        if ((this.flags[o] & ENEMY_FLAG.phasing) !== 0) continue;
        const dx = this.x[s] - this.x[o];
        const dy = this.y[s] - this.y[o];
        const minDist = this.radius[s] + this.radius[o];
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue;
        resolved++;
        const dist = Math.sqrt(distSq);
        if (dist < 0.0001) {
          // Exactly stacked. Push along a deterministic direction derived from the slot numbers,
          // never a random one — a random nudge here would desync co-op and break replays.
          const angle = ((s * 2654435761) % 628) / 100;
          this.pushX[s] += Math.cos(angle) * minDist * SEPARATION_STRENGTH;
          this.pushY[s] += Math.sin(angle) * minDist * SEPARATION_STRENGTH;
          continue;
        }
        const overlap = (minDist - dist) * SEPARATION_STRENGTH;
        this.pushX[s] += (dx / dist) * overlap;
        this.pushY[s] += (dy / dist) * overlap;
      }
    }

    // --- Pass 3: integrate and cull -------------------------------------------------------
    // Backwards, because culling frees slots and the dense list swap-removes into the position we
    // just passed. Forwards iteration would silently skip an enemy every time one is culled.
    for (let i = n - 1; i >= 0; i--) {
      const s = slots[i];
      this.x[s] += this.vx[s] * dt + this.pushX[s];
      this.y[s] += this.vy[s] * dt + this.pushY[s];

      if ((this.flags[s] & ENEMY_FLAG.persistent) !== 0) continue;

      let nearestSq = Infinity;
      for (let p = 0; p < playerCount; p++) {
        const dx = playerX[p] - this.x[s];
        const dy = playerY[p] - this.y[s];
        const d = dx * dx + dy * dy;
        if (d < nearestSq) nearestSq = d;
      }
      if (nearestSq > CULL_DISTANCE * CULL_DISTANCE) {
        // Recycled, not killed: no XP, no gold, no kill credit. An enemy that wandered off was
        // never defeated, and counting it would let a player farm the counter by running away.
        this.pool.freeSlot(s);
        this.culled++;
      }
    }
  }

  /** Total live boss count. Used to stop two bosses sharing one health bar. */
  bossCount(): number {
    const slots = this.pool.slots;
    let n = 0;
    for (let i = 0; i < this.pool.count; i++) {
      if ((this.flags[slots[i]] & ENEMY_FLAG.boss) !== 0) n++;
    }
    return n;
  }
}
