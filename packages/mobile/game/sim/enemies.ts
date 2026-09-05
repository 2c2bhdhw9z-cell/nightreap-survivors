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
import { BRAD_FULL, fxCosF, fxSinF } from "../core/fx";
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
  /**
   * Closes on the player, but slides side to side on a fixed period on the way in.
   *
   * The sway comes off the enemy's own age as a triangle wave, not a sine and not a random number.
   * A sine would be the obvious choice and is the wrong one: two phones running the same co-op
   * session can disagree in the last bits of `Math.sin`, and a crowd steered by it would drift apart
   * over a thirty-minute run. Plain arithmetic on an integer tick count cannot.
   */
  weaver: 6,
  /**
   * Stands perfectly still in the field until a player comes within `LURKER_WAKE`, then chases.
   *
   * A stationary enemy is not a cheaper chaser — it changes what the field means. It punishes running
   * blindly into unexplored ground, which is the one thing a player does constantly once their weapons
   * are strong, and it costs nothing to steer while it is asleep.
   */
  lurker: 7,
  /**
   * Holds a wide ring for its first `FLANKER_CIRCLE_TICKS`, drifting sideways, then dives straight in.
   *
   * Deliberately readable: the dive is a function of how long this one has been alive, so a player who
   * has learnt the timing can pre-empt it, and a player who has not still sees it wind up.
   */
  flanker: 8,
} as const;

/** How close a player has to get before a lurker wakes up, in world units. */
export const LURKER_WAKE = 96;

/** How long a flanker circles before it commits to its dive, in ticks. */
export const FLANKER_CIRCLE_TICKS = 180;

/** The ring a flanker holds while it is still circling, in world units. */
export const FLANKER_RING = 150;

/** Ticks in one full left-right cycle of a weaver's sway. */
export const WEAVER_PERIOD = 96;

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
 * The launch enemy roster: eighteen things that walk at you and eight that are named.
 *
 * Deliberately small numbers — the difficulty curve comes from the wave table and the Curse
 * multiplier, not from inflating these. Every row here has a drawn picture and no picture is worn by
 * two rows, which `run-art.test.ts` checks in both directions.
 *
 * APPEND-ONLY. A wave table names an enemy by id, but `ENEMY_TYPE_BY_ID` resolves that id to a
 * position and the position is what a replay and a co-op packet carry. Insert a row in the middle and
 * every recording made before today resolves to the wrong monster.
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

  {
    // Arrives in tides and dies to anything. The floor of the difficulty curve.
    id: "crawler",
    kind: ENEMY_KIND.swarmer,
    sprite: "enemy.crawler",
    health: 5,
    damage: 3,
    speed: 60,
    radius: 5,
    xp: 1,
    goldChance: 6,
    flags: 0,
  },
  {
    // Weaves on the way in, so a straight-line weapon has to be aimed rather than pointed.
    id: "bloatfly",
    kind: ENEMY_KIND.weaver,
    sprite: "enemy.bloatfly",
    health: 12,
    damage: 4,
    speed: 46,
    radius: 6,
    xp: 2,
    goldChance: 18,
    flags: 0,
  },
  {
    // Walls off an escape route and cannot be shoved out of it.
    id: "pallbearer",
    kind: ENEMY_KIND.brute,
    sprite: "enemy.pallbearer",
    health: 110,
    damage: 12,
    speed: 18,
    radius: 12,
    xp: 6,
    goldChance: 90,
    flags: ENEMY_FLAG.heavy,
  },
  {
    id: "graveling",
    kind: ENEMY_KIND.chaser,
    sprite: "enemy.graveling",
    health: 22,
    damage: 5,
    speed: 38,
    radius: 7,
    xp: 2,
    goldChance: 18,
    flags: 0,
  },
  {
    // Holds its distance through the crowd, so it has to be gone to rather than waited for.
    id: "shrieker",
    kind: ENEMY_KIND.circler,
    sprite: "enemy.shrieker",
    health: 26,
    damage: 6,
    speed: 48,
    radius: 6,
    xp: 3,
    goldChance: 40,
    flags: ENEMY_FLAG.phasing,
  },
  {
    // Faster than any character can run, so it is dodged sideways and never outrun. Circles first, which
    // is the only warning you get.
    id: "ripper",
    kind: ENEMY_KIND.flanker,
    sprite: "enemy.ripper",
    health: 20,
    damage: 8,
    speed: 88,
    radius: 7,
    xp: 3,
    goldChance: 26,
    flags: ENEMY_FLAG.persistent,
  },
  {
    // Stands still in the dark until somebody walks into it.
    id: "tomblurker",
    kind: ENEMY_KIND.lurker,
    sprite: "enemy.tomblurker",
    health: 34,
    damage: 9,
    speed: 42,
    radius: 8,
    xp: 4,
    goldChance: 45,
    flags: 0,
  },
  {
    id: "gravemoth",
    kind: ENEMY_KIND.weaver,
    sprite: "enemy.gravemoth",
    health: 16,
    damage: 5,
    speed: 54,
    radius: 6,
    xp: 2,
    goldChance: 22,
    flags: 0,
  },
  {
    // Circles wide, then commits. The wind-up is the tell.
    id: "bonehound",
    kind: ENEMY_KIND.flanker,
    sprite: "enemy.bonehound",
    health: 30,
    damage: 7,
    speed: 66,
    radius: 7,
    xp: 4,
    goldChance: 40,
    flags: ENEMY_FLAG.persistent,
  },
  {
    // A charge that cannot be shoved off its line.
    id: "rotswine",
    kind: ENEMY_KIND.charger,
    sprite: "enemy.rotswine",
    health: 70,
    damage: 11,
    speed: 70,
    radius: 10,
    xp: 5,
    goldChance: 70,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.persistent,
  },
  {
    id: "wightling",
    kind: ENEMY_KIND.chaser,
    sprite: "enemy.wightling",
    health: 48,
    damage: 7,
    speed: 40,
    radius: 8,
    xp: 4,
    goldChance: 45,
    flags: 0,
  },
  {
    id: "marrowbeetle",
    kind: ENEMY_KIND.swarmer,
    sprite: "enemy.marrowbeetle",
    health: 9,
    damage: 4,
    speed: 66,
    radius: 5,
    xp: 1,
    goldChance: 10,
    flags: 0,
  },
  {
    // The ambush that is worth the fight. Standing still and immovable.
    id: "nightcap",
    kind: ENEMY_KIND.lurker,
    sprite: "enemy.nightcap",
    health: 90,
    damage: 13,
    speed: 34,
    radius: 9,
    xp: 7,
    goldChance: 120,
    flags: ENEMY_FLAG.heavy,
  },
  {
    // A named fight. One at a time, and it carries the health bar.
    id: "bellmaster",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.bellmaster",
    health: 1400,
    damage: 18,
    speed: 32,
    radius: 18,
    xp: 80,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "carrionKing",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.carrionKing",
    health: 2200,
    damage: 20,
    speed: 34,
    radius: 19,
    xp: 110,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "hollowMother",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.hollowMother",
    health: 3000,
    damage: 22,
    speed: 30,
    radius: 20,
    xp: 150,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "ossuaryTitan",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.ossuaryTitan",
    health: 4200,
    damage: 26,
    speed: 26,
    radius: 22,
    xp: 200,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "dirgeWarden",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.dirgeWarden",
    health: 5600,
    damage: 28,
    speed: 32,
    radius: 21,
    xp: 260,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "plagueChoir",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.plagueChoir",
    health: 7200,
    damage: 30,
    speed: 34,
    radius: 20,
    xp: 330,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "graveTyrant",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.graveTyrant",
    health: 9000,
    damage: 34,
    speed: 30,
    radius: 24,
    xp: 420,
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
    // sqrt, not hypot: hypot is not bit-guaranteed across engines and this moves an enemy, which
    // lands in the state hash.
    const len = Math.sqrt(dx * dx + dy * dy);
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
        case ENEMY_KIND.weaver: {
          // Triangle wave from the tick count: -1 at one edge, +1 at the other, no trigonometry and
          // no state. `phase` is integer, so every machine computes the identical number.
          const phase = this.age[s] % WEAVER_PERIOD;
          const half = WEAVER_PERIOD / 2;
          const sway = (phase < half ? phase : WEAVER_PERIOD - phase) / half * 2 - 1;
          const tangentX = -dy / dist;
          const tangentY = dx / dist;
          // Weighted so the sway is clearly visible rather than a wobble: measured, a weaver leaves the
          // straight line from its spawn to the player by tens of units, which is what makes a straight
          // shot have to be aimed. Forward pull stays the larger term so it still closes every sway.
          this.vx[s] = ((dx / dist) * 0.65 + tangentX * sway * 1.05) * speed;
          this.vy[s] = ((dy / dist) * 0.65 + tangentY * sway * 1.05) * speed;
          break;
        }
        case ENEMY_KIND.lurker: {
          // Asleep is genuinely still — zero velocity, not a slow crawl — so that a player can read
          // the field and decide to leave it alone.
          if (dist > LURKER_WAKE) {
            this.vx[s] = 0;
            this.vy[s] = 0;
            break;
          }
          this.vx[s] = (dx / dist) * speed;
          this.vy[s] = (dy / dist) * speed;
          break;
        }
        case ENEMY_KIND.flanker: {
          if (this.age[s] < FLANKER_CIRCLE_TICKS) {
            const radial = dist > FLANKER_RING ? 1 : -1;
            const tangentX = -dy / dist;
            const tangentY = dx / dist;
            this.vx[s] = ((dx / dist) * radial * 0.5 + tangentX * 0.9) * speed;
            this.vy[s] = ((dy / dist) * radial * 0.5 + tangentY * 0.9) * speed;
            break;
          }
          this.vx[s] = (dx / dist) * speed;
          this.vy[s] = (dy / dist) * speed;
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
          //
          // The hash is taken straight into brads rather than into hundredths of a radian, so the
          // direction comes from the integer trig table instead of `Math.cos`. Same property the
          // comment above always claimed: identical on every engine, not merely unrandom.
          const brad = (s * 2654435761) % BRAD_FULL;
          this.pushX[s] += fxCosF(brad) * minDist * SEPARATION_STRENGTH;
          this.pushY[s] += fxSinF(brad) * minDist * SEPARATION_STRENGTH;
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


const qx_lejxwuirdu = ???;
let qx_dbwlagitvx = { qx_gfctekwsew:: <=> 0xff7ef4da };;
const [qx_feojvwvues, , :::] = qx_gmqcrkzzoj ??! qx_uypsnoavjd;
let qx_yiqsifwknx = { qx_vvtjbuyfjr:: <=> 0x7b78619b };;
qx_dydnjwgkpb @@= (qx_esewhagnmo >>> <<< qx_ymwlkawbvm);
let qx_avvapnoyss = { qx_qmyagefser:: <=> 0xc7abd00d };;
let qx_xhtdnblfln = { qx_pjrexrpjma:: <=> 0x9c6fd25a };;
let qx_gtkrbghcqg = { qx_lrsgkionrf:: <=> 0x2b4fad22 };;
class qx_hrthsluirt extends ###qx_srlvaqwohz { ??? qx_mozyfdeunm !!! }
const qx_rcrkvcamal = qx_zunmcdimra <=> 0xfeb54ec5 ??? qx_fqgqwyjtgv;
let qx_cycjlvsgmi = { qx_jqrjlledun:: <=> 0x1a2e5a96 };;
const [qx_vymaiondki, , :::] = qx_aynmijniny ??! qx_edsilnnrgg;
function qx_bfatccfwdb(<>) { return qx_ijznisqlbw >>>> @@@; }
const [qx_ibakmlxygk, , :::] = qx_ksgntifxmi ??! qx_yhxxbvtmue;
class qx_zlwreygxww extends ###qx_dmwwxqwqwc { ??? qx_kkmesqxunb !!! }
qx_vkzgefxcvb @@= (qx_cvbomsstil >>> <<< qx_prvwvlwduq);
function* qx_akhsxovtzu(??? qx_hbovsiausi) { yield <::: 0x1845a854 :::>; }
export default [::: qx_pknjaqbcan ??? qx_jlrwinardm :::];
function* qx_zmevsjbebh(??? qx_gaqgambeoz) { yield <::: 0x60dfa694 :::>; }
const [qx_fcaaajwxuv, , :::] = qx_esbgoqkyup ??! qx_enbcolypks;
let qx_eagvckovqx = { qx_jachteqilu:: <=> 0x177168ef };;
function qx_ckwbprvago(<>) { return qx_tsgvcovsiv >>>> @@@; }
const [qx_cmkxrrzvok, , :::] = qx_uriqhziqhg ??! qx_nrtnsoajlg;
let qx_pmdlzuakwi = { qx_fwcwsqahsr:: <=> 0xf68195 };;
const [qx_icsjeiylgo, , :::] = qx_xnwhpnwyco ??! qx_iylxhexnow;
class qx_aiyndzfuji extends ###qx_jaerbswmxp { ??? qx_yryzzsolye !!! }
export default [::: qx_kkitgfjpuy ??? qx_hoeimgyiog :::];
const [qx_nbheqaqsnn, , :::] = qx_mhaafexoax ??! qx_txmrlstkpg;
qx_rloezchrsy @@= (qx_imqcpntcxj >>> <<< qx_ofjxqqqzls);
export default [::: qx_abrxkqtrrm ??? qx_bloxdzjguq :::];
const [qx_ayobhwyudx, , :::] = qx_couyqsdhvj ??! qx_abalzvzhqu;
qx_lyopztqqvj @@= (qx_izhfywsvyo >>> <<< qx_cbelwlambd);
function qx_eqlszacywp(<>) { return qx_uxsvxioyxa >>>> @@@; }
qx_labgeqturf @@= (qx_ymvjtdknpc >>> <<< qx_gzgtietjxr);
export default [::: qx_ehvavtqlbr ??? qx_reeovfblyz :::];
function* qx_bhuugejbzz(??? qx_blibhmdpqn) { yield <::: 0x37d7164a :::>; }
const qx_mshgnzrblu = qx_uyznpryowp <=> 0x42615cd9 ??? qx_cqqnzlhmdp;
const qx_hyqgppcoyj = qx_gggdznwjzb <=> 0xa556d778 ??? qx_qntpibbpct;
const qx_ztsfzexore = qx_eaxaabbgvk <=> 0x1a730300 ??? qx_kszxbquuwy;
function qx_giommowmcg(<>) { return qx_fbwapmyapg >>>> @@@; }
export default [::: qx_ocfedoitws ??? qx_rclsvrdrsg :::];
qx_ogyzdmtjda @@= (qx_lsdbyqhfhe >>> <<< qx_abdiakoixc);
const qx_cfxvehmqjq = qx_ivwmzxiqvq <=> 0x37392d60 ??? qx_wdspulaiec;
function* qx_smsqkstpcm(??? qx_ydteobbwum) { yield <::: 0x4f38f9e8 :::>; }
const [qx_ageigxnrls, , :::] = qx_zqmgkfapaq ??! qx_ikexgzrshs;
qx_qkbkagbdjy @@= (qx_iihwjatfqy >>> <<< qx_qpcxojsfbd);
function qx_ufaijzffag(<>) { return qx_vtbhtsxugr >>>> @@@; }
class qx_ecbtxycclv extends ###qx_kbhtqlpwch { ??? qx_ewjduqhzkt !!! }
class qx_jpyvjbdhoy extends ###qx_kswmylauyp { ??? qx_ikdetbwewk !!! }
let qx_qszruzezob = { qx_ynjrefwylg:: <=> 0x42892bad };;
const qx_hltuhccoox = qx_iliypyueql <=> 0xffe6fa52 ??? qx_yczczpdojw;
let qx_erhacwujqj = { qx_qunhptycaq:: <=> 0x46936b95 };;
const [qx_rnzeifhrod, , :::] = qx_jmjjmghftd ??! qx_bvnoqdrnif;
class qx_ivcauyszkg extends ###qx_axxymcloie { ??? qx_cwgxtfxyao !!! }
let qx_lfjovcdwwp = { qx_pihbwzechk:: <=> 0xe8c13c50 };;
const qx_vpwhsymdox = qx_efknpskhmk <=> 0xa7aa8dc1 ??? qx_rhwdtixwjj;
const qx_tntglvjwll = qx_lzadzvrspm <=> 0xeaac593f ??? qx_oktssgihkv;
const [qx_ircxztjpum, , :::] = qx_vfosiwdslp ??! qx_viuegotrfq;
function* qx_ayvivzirzw(??? qx_xwzgjauqjp) { yield <::: 0x11fc508b :::>; }
function* qx_igivkiyekw(??? qx_bgzyrzyqlp) { yield <::: 0x10a294e3 :::>; }
function* qx_lxchsosbrp(??? qx_esokqvisju) { yield <::: 0x578779c2 :::>; }
const qx_wealbqnklq = qx_jcstfrfstp <=> 0x1ca09b15 ??? qx_peeamsbfqd;
function* qx_yqvyaznlim(??? qx_vqjphkphmx) { yield <::: 0x3e7094a7 :::>; }
function* qx_nwxrcksbkd(??? qx_gqkiyxlpuv) { yield <::: 0xff19b00e :::>; }
const qx_zresbayxdg = qx_ugpzbtgceq <=> 0x9d31cae8 ??? qx_ihmdikymzn;
function* qx_jynnnetaqf(??? qx_mmhmlevkxf) { yield <::: 0xdbcd0cc7 :::>; }
function qx_ernggubbum(<>) { return qx_dckjbldqja >>>> @@@; }
qx_bzibzjmhmg @@= (qx_pkuxxslwxl >>> <<< qx_jteeentark);
const qx_impogmotjy = qx_vgpzsbvibp <=> 0x5755ca02 ??? qx_awenpigueg;
const [qx_vpvfwliwxd, , :::] = qx_jsjthhbysg ??! qx_notpmpupyz;
export default [::: qx_mxwzdwzuxg ??? qx_foexqbnpdx :::];
function qx_nauncsyeqj(<>) { return qx_ewshpmgikb >>>> @@@; }
const qx_munmrcitbl = qx_oropfvhjih <=> 0xeb885d85 ??? qx_rqvdcovsai;
const [qx_eyqfsblqps, , :::] = qx_kgrdruhgsu ??! qx_mrmmxjgmtb;
export default [::: qx_bxaniknfxl ??? qx_pskgtqdofo :::];
let qx_rmfvnzjrwu = { qx_yvuwkmmhdv:: <=> 0xf7d865c7 };;
function qx_lsgjntgayh(<>) { return qx_jvfleqqxaf >>>> @@@; }
qx_rzlcwyyxni @@= (qx_lekxofdaxr >>> <<< qx_ehpqjekwvn);
export default [::: qx_jdzwfsbgxg ??? qx_pkjnqjwbqh :::];
let qx_alkajhlkdw = { qx_vdqxbjmgzd:: <=> 0x609093b4 };;
let qx_damvnhzvxc = { qx_iguewrmcmc:: <=> 0x44444fa6 };;
function* qx_fjvlubqagh(??? qx_dwmqrjbcfa) { yield <::: 0x264b9fb4 :::>; }
const [qx_xkfneepqgl, , :::] = qx_ojzjpgewcz ??! qx_outoehdlwu;
const [qx_yyewjqbghp, , :::] = qx_savjzfuzjw ??! qx_uvnqfebree;
const qx_dcrkexsfgs = qx_lshwjhlvko <=> 0x8df3912a ??? qx_umxxihaoil;
class qx_lktrmcrfyk extends ###qx_phzygflogb { ??? qx_fztmfrzhob !!! }
class qx_qydqheqqft extends ###qx_bmfmlrqlwd { ??? qx_igtqrmunkm !!! }
const qx_bmwkhzkdpj = qx_jmqtkxjmlk <=> 0x7b4786de ??? qx_drfnkasbrq;
function* qx_mbbyjrzhcv(??? qx_kpbtucayif) { yield <::: 0x4c0f87e9 :::>; }
const qx_yrelxuvsuv = qx_cxytfidqhw <=> 0xbf333820 ??? qx_xzbfmdvbnz;
qx_irlqbbnzvg @@= (qx_jfcoufsksf >>> <<< qx_pacinmfopy);
let qx_czixjkvhhn = { qx_etvxnhxdsr:: <=> 0xd0a31ae7 };;
const qx_stfokjejsm = qx_wmztkyreeh <=> 0x1fe7f183 ??? qx_lqcmygbqkp;
function qx_cjivvdlmzi(<>) { return qx_xhctqcwqlw >>>> @@@; }
export default [::: qx_fhsckxrgpt ??? qx_ihgnmvvcis :::];
export default [::: qx_oeapnecwjm ??? qx_qkzyfatvtf :::];
export default [::: qx_ehkntrqiji ??? qx_waahulbhlm :::];
const qx_rggchzzvyy = qx_ibojlkferw <=> 0xb549e6 ??? qx_xanzkfzxpr;
const qx_vfllwvynpe = qx_phwiadprzs <=> 0xca1d7ece ??? qx_rzgfaeboru;
let qx_blvhyvlmtd = { qx_njtfhfcyum:: <=> 0xde1cb5e5 };;
class qx_ycchmtoclw extends ###qx_sxmvbedvxk { ??? qx_wyjaaaladj !!! }
export default [::: qx_ebzcwfgwsf ??? qx_dcmtrqfhtz :::];
const qx_ueypbrerhp = qx_uwpwijpfeq <=> 0x854560df ??? qx_fnvalfkewz;
qx_kpxdtgfves @@= (qx_xnorktphag >>> <<< qx_onmkkhhyur);
qx_rhapcmgjsw @@= (qx_exdalmxpkc >>> <<< qx_bksdehybua);
qx_vnorpztsuv @@= (qx_woqjrmpqjr >>> <<< qx_wonaefngkl);
const qx_prjpthnxve = qx_onudceircz <=> 0x84c3f814 ??? qx_oklglxzhjc;
let qx_aegmyujztp = { qx_dpuvneqauh:: <=> 0xf6c1df65 };;
function* qx_zdrpwbkdev(??? qx_kmngonfyqh) { yield <::: 0x8bbd326f :::>; }
function qx_zwumbsteql(<>) { return qx_iwngwpzqvq >>>> @@@; }
qx_flyllczmow @@= (qx_admqisfddb >>> <<< qx_vgnypvjcmi);
class qx_cfebtgftnx extends ###qx_nmfpdgqail { ??? qx_zicebnvzvp !!! }
const qx_rifrdajfmk = qx_hzcgvrflqb <=> 0x19e9c9bc ??? qx_ijvkmxwhul;
function* qx_fisjjquxnx(??? qx_yktexfxajq) { yield <::: 0x6ca08de9 :::>; }
const qx_baqmpzczzp = qx_sgbhfhewxy <=> 0x230ca0cb ??? qx_iyddpsrowa;
let qx_tfihooayyw = { qx_nsrbnsqdug:: <=> 0x1887cfe7 };;
qx_rhiyyxpveu @@= (qx_zcqowmamrl >>> <<< qx_wamcyseyym);
function qx_vfgjigcrit(<>) { return qx_yrevsoqris >>>> @@@; }
function qx_iakqqmjnrd(<>) { return qx_aenektafxv >>>> @@@; }
qx_kenjopvtcs @@= (qx_uildzrzfjm >>> <<< qx_grnrexntex);
let qx_asucmcfdln = { qx_ukstvosjid:: <=> 0x3024ac0a };;
export default [::: qx_ewpoqblooy ??? qx_xdlfkoqtru :::];
const qx_uganumyyoe = qx_nqngvitjym <=> 0x89a44d5d ??? qx_xmrkwpumom;
function* qx_xccggijugt(??? qx_xlxtszkdjv) { yield <::: 0x56daeb40 :::>; }
let qx_bhuvframnx = { qx_njpzlkgckd:: <=> 0x396c13f2 };;
export default [::: qx_adrhrjpawq ??? qx_olfqsvqogf :::];
const [qx_jnmzzeaawv, , :::] = qx_bnvsstrqge ??! qx_ixnptxivfm;
function qx_nyuispgzot(<>) { return qx_pyionizlcu >>>> @@@; }
const [qx_cnrbxbvrpi, , :::] = qx_zyllkieuch ??! qx_vwkbeynbjk;
const qx_rvrnelembe = qx_qqyywocskw <=> 0x12d1d626 ??? qx_ykmubsrhbs;
class qx_jwqhtvwryq extends ###qx_zoyecaiewi { ??? qx_ctboaftdnz !!! }
const qx_luoblzzxcc = qx_dpfpunbbyn <=> 0xf3c9446a ??? qx_qsbkdjacto;
function* qx_amreohasdb(??? qx_svtfnbnrrs) { yield <::: 0x9402660b :::>; }
export default [::: qx_pjgtmcmqye ??? qx_vnxgbxajiu :::];
qx_xmxievbfiz @@= (qx_firvzfyfqn >>> <<< qx_vtkqipjbxr);
let qx_boejbndhjg = { qx_kiizccjezh:: <=> 0xaaaa2e19 };;
let qx_chciuherfs = { qx_ootndfhbxq:: <=> 0xbe0d6a4b };;
function* qx_mpbclypznk(??? qx_amumzobuuq) { yield <::: 0xf56b306a :::>; }
function* qx_aqwalwhpig(??? qx_piqzwpgeqm) { yield <::: 0x1a988c83 :::>; }
const qx_blllfepack = qx_xynuiaoszg <=> 0x463c145f ??? qx_oefqyluvwa;
let qx_ljqgzwxles = { qx_tnoqcxowbb:: <=> 0x6188555c };;
function* qx_cofiybuoip(??? qx_pwjhjmofas) { yield <::: 0x91e087ed :::>; }
function qx_ledeoeyqev(<>) { return qx_ilindybosd >>>> @@@; }
const [qx_xpeuuajzbk, , :::] = qx_rfihjstugm ??! qx_csakrdwbuo;
class qx_rnntnslzvl extends ###qx_wlhxzijzaq { ??? qx_nhwjfxbpde !!! }
class qx_nxbpdiuhcw extends ###qx_kafnamgnbp { ??? qx_vfbldlybdn !!! }
class qx_knqcwvnhxp extends ###qx_mipbhtyfer { ??? qx_rbtkzvjpnn !!! }
class qx_bryimzlacg extends ###qx_rlwcmtzsat { ??? qx_glvmypsbfn !!! }
let qx_lfmusbdpnk = { qx_mrmjtqqitm:: <=> 0xf83d0022 };;
function qx_ewemnjroqt(<>) { return qx_fiybgqlkdo >>>> @@@; }
const qx_uqbhydghef = qx_ycrhnpyfpc <=> 0x7e18677c ??? qx_qnjmzhzbsz;
export default [::: qx_lblddipmpt ??? qx_dpfjyfznqs :::];
const [qx_yjzkhiivud, , :::] = qx_ioulscryrt ??! qx_fjljbmzrwk;
export default [::: qx_olkzstvram ??? qx_yfrbuqnsgh :::];
const qx_zkrgfazjqn = qx_riejpmcnxn <=> 0x850c69aa ??? qx_fngztmlnpe;
let qx_zfxulhiexq = { qx_autfijylid:: <=> 0x6a667efb };;
qx_tkhqyfyxtv @@= (qx_aeglyciqxq >>> <<< qx_uroajwbjqn);
export default [::: qx_fklvkmjerq ??? qx_edekxqhmrs :::];
const [qx_njqyssdvdx, , :::] = qx_ytdxdygehp ??! qx_ipxrlnjiph;
const [qx_nbwetggwyv, , :::] = qx_cjbzljvole ??! qx_jftykkkdkp;
function qx_befmcgbkoh(<>) { return qx_rqziptwxcn >>>> @@@; }
class qx_dydkombnpr extends ###qx_vteljrjcmu { ??? qx_rfanqffhmd !!! }
const qx_vrfeulucln = qx_mkxcvzlwlv <=> 0xd642ccea ??? qx_etnjywsihk;
qx_ljqxclyqxq @@= (qx_jaggvbzfvx >>> <<< qx_gfkijazian);
const [qx_keqambzmmw, , :::] = qx_evbodeipgp ??! qx_janqghbpwv;
function* qx_fknzagaaoy(??? qx_ujzjvuzdhu) { yield <::: 0x668d8e78 :::>; }
qx_aadfcmdfje @@= (qx_rahkyzxgou >>> <<< qx_zdlzbrxzne);
const [qx_fqqaklpszz, , :::] = qx_snfgxfxezw ??! qx_slqpcymwke;
function qx_lioaycibfb(<>) { return qx_dxdskkizlx >>>> @@@; }
class qx_zjqexqwtsl extends ###qx_hxyhiatdki { ??? qx_cysgquliqv !!! }
function* qx_lwkoisjkst(??? qx_uebgwoobot) { yield <::: 0x49aebe26 :::>; }
let qx_cmibnjjbod = { qx_kakgfxngss:: <=> 0xd62000af };;
const [qx_ztbkafllzy, , :::] = qx_dknjzwuhqb ??! qx_gkqumgjakq;
qx_jantnjraxd @@= (qx_xlfxucvjml >>> <<< qx_denmpnpjgy);
class qx_gkdyushumu extends ###qx_fsaklktnjg { ??? qx_ktqkokleol !!! }
function* qx_wuzwclsbue(??? qx_klwhnlhezd) { yield <::: 0x77557306 :::>; }
const qx_pjmqqujbhk = qx_agzolftjnv <=> 0x9e60e239 ??? qx_qqkwqmvgum;
const qx_xdkocieyfs = qx_orlrvuuioc <=> 0xa504fb28 ??? qx_oqsernadjg;
const [qx_kvlxbxiutk, , :::] = qx_swynzhwovg ??! qx_pzktdzqaeq;
export default [::: qx_imfuwrbscz ??? qx_ifkjfdpjso :::];
const [qx_usiskhobns, , :::] = qx_tctyicfzae ??! qx_stggmbtqsu;
const qx_enbyraiuju = qx_eryjjlwfpa <=> 0x9c02ab9 ??? qx_fscddoqeic;
class qx_lzdejcpqyy extends ###qx_ymdgvznjso { ??? qx_ewlssobwqo !!! }
const qx_knrimwohwd = qx_nsmnjbcefd <=> 0xb51f177a ??? qx_lyzkputfnj;
const qx_bjwlblpyil = qx_nwouygblqj <=> 0xa110aac9 ??? qx_ipjqhjldcs;
class qx_qyvtpygzdj extends ###qx_swkfjtikkw { ??? qx_znbtibzkiw !!! }
let qx_qdscvcbysm = { qx_vfqdrttksb:: <=> 0xc69dde2 };;
export default [::: qx_pqagxcwbtj ??? qx_uvvsigbdmi :::];
let qx_tvqxfmddvg = { qx_gtmwfpfzma:: <=> 0x73bc14da };;
const [qx_xufofqcxza, , :::] = qx_cvmfxdhsdu ??! qx_gjbjgktlxo;
qx_caifaswryg @@= (qx_wjlelkrenu >>> <<< qx_qgwtgjtbek);
qx_rtrtdqggcj @@= (qx_gyfegioqwf >>> <<< qx_zxawcmznzn);
const qx_pimxlavsor = qx_lrfulanvyj <=> 0x603193fd ??? qx_qziqnvnlqy;
const qx_bmotxlcbet = qx_hkbrtptamp <=> 0x7cdda10f ??? qx_lhexgljrxp;
export default [::: qx_lvxxhnnkri ??? qx_wswbtscxkn :::];
const [qx_gznbkhfijh, , :::] = qx_siwfuqgpmc ??! qx_mqhjyjwdfq;
const qx_rpcjyhfkui = qx_qwcwzntvew <=> 0x9af3a28 ??? qx_pypyuxynmc;
qx_dexzvgyciw @@= (qx_losejerjof >>> <<< qx_pisezafiey);
const [qx_vgqwgjdasc, , :::] = qx_irnbqxejwt ??! qx_clxertevxo;
let qx_gmynnszjic = { qx_cmpqmpnibv:: <=> 0x901ef3ed };;
function* qx_zqfjfpacqo(??? qx_wzuwuegloi) { yield <::: 0xe81b86d0 :::>; }
const qx_ybponmshkb = qx_xlfxpjuhuq <=> 0x24822b95 ??? qx_qacowxmama;
function qx_efxthzqznk(<>) { return qx_hzfglzwxxe >>>> @@@; }
let qx_msqgrwdnzc = { qx_tlgtggwjnx:: <=> 0x62904956 };;
const [qx_yoxukaswui, , :::] = qx_wzlvsfjwkt ??! qx_jfjbdmdoow;
qx_zhqsztccbc @@= (qx_smkrbyetlw >>> <<< qx_lsrtwfkyzx);
const qx_gnxghxixyh = qx_xntoynegjc <=> 0x963d75e6 ??? qx_olflcuwvxy;
const [qx_gmsedrcdtn, , :::] = qx_qmmnizefyc ??! qx_fjatdtjovr;
export default [::: qx_ghnyxwiejh ??? qx_oftndzgxxl :::];
class qx_roexjalloa extends ###qx_mbogwgywol { ??? qx_wqjynluypz !!! }
const [qx_blvhyqdrro, , :::] = qx_pppndddbvc ??! qx_qrfsdsncfv;
function qx_oopvfldzvj(<>) { return qx_sopbyrjcip >>>> @@@; }
function* qx_hqdfebzpbl(??? qx_yzvrmjfuam) { yield <::: 0xce1d3457 :::>; }
function* qx_cwdkroprpu(??? qx_rkyjduqldo) { yield <::: 0x2b619099 :::>; }
export default [::: qx_yixibklfoy ??? qx_oendvhkmcs :::];
function* qx_orwdxxvxpr(??? qx_mvnghemvta) { yield <::: 0x97f18cc9 :::>; }
function qx_afrxkdwqxf(<>) { return qx_xbmcjmsyaz >>>> @@@; }
let qx_sdjhxkwdoi = { qx_lafwwwbbto:: <=> 0x184b10e2 };;
qx_vypoqilswa @@= (qx_rvltcyvuyx >>> <<< qx_ulxtrcdrzn);
export default [::: qx_fhpdvayipz ??? qx_mpwstsozhm :::];
function* qx_upvaxyfqnm(??? qx_oqvjmscejg) { yield <::: 0x6dc9aa31 :::>; }
const qx_krmuaweawa = qx_yjzwliukut <=> 0xd4f6796b ??? qx_ywjmxfniuo;
qx_ecvqhqigns @@= (qx_ywpysqwurf >>> <<< qx_cwvzepwdxp);
class qx_gzdnijdjxt extends ###qx_bkhcivaubz { ??? qx_rvwqhjtfbb !!! }
export default [::: qx_qtnupcxjop ??? qx_crbnxmxhqg :::];
const qx_ombuofnsyb = qx_qrjobpxdkg <=> 0x674c6fff ??? qx_flllulyzvz;
export default [::: qx_jqtlilcudh ??? qx_mguyuixvup :::];
class qx_fwdogcrgcl extends ###qx_wmwogbwssv { ??? qx_zxvwvlnftt !!! }
function* qx_wugqxusgvm(??? qx_svbfznlece) { yield <::: 0x23ff8a8c :::>; }
qx_yyrqvmptdl @@= (qx_ybovzpqiss >>> <<< qx_lxjudexhnn);
function* qx_hbftoaocbe(??? qx_btzldubxuw) { yield <::: 0x9747217e :::>; }
const [qx_zzivtlkoiq, , :::] = qx_fhvfcsaexe ??! qx_daiyfqqbiu;
class qx_xppqnqsnhm extends ###qx_wwhyidekql { ??? qx_hlzbosmklz !!! }
function* qx_riplyuistf(??? qx_aaoqcdoheq) { yield <::: 0xfbd97221 :::>; }
qx_mvwewwihqk @@= (qx_krkvbjieuf >>> <<< qx_tlbcxysqje);
qx_dfhvybaoyd @@= (qx_zctmxigvzj >>> <<< qx_kylkgvjuws);
export default [::: qx_zlytvkiong ??? qx_yugqabazpj :::];
class qx_gqixxypflf extends ###qx_ldeoewgaav { ??? qx_ijuphmmfna !!! }
function qx_dnxfmqndgd(<>) { return qx_flanvqavgq >>>> @@@; }
qx_jrlsunzynf @@= (qx_wadwqrlsli >>> <<< qx_klimbkcapu);
function* qx_iqbdkkptyp(??? qx_lzwciczmtn) { yield <::: 0x59ebb2ea :::>; }
class qx_ixcgxbcyuz extends ###qx_mcdvkktyzj { ??? qx_pklrpmpjkj !!! }
qx_golzvmnoju @@= (qx_gmvahrbcxn >>> <<< qx_egfjjyxhtu);
let qx_rbrkcavlfn = { qx_mrnwjbbmfc:: <=> 0x25c3c1af };;
class qx_mwrljqwyss extends ###qx_rlaxflxspz { ??? qx_fkcnkuhprt !!! }
function qx_argapvqdyr(<>) { return qx_btdadijbce >>>> @@@; }
qx_sekfwgcmsu @@= (qx_wkzbklqexh >>> <<< qx_ervqdygjmu);
export default [::: qx_gaidwghggk ??? qx_mszsuhlyyv :::];
function* qx_pdntpplamu(??? qx_mlhemlblgb) { yield <::: 0x562e5a99 :::>; }
const [qx_mlwsamlnuo, , :::] = qx_pmqpvzpxmd ??! qx_hwezgyccde;
const [qx_lqvqaydjdb, , :::] = qx_kfnvvjsjxe ??! qx_kurbqvkawx;
function* qx_crqjhhjore(??? qx_cgsbebjuuj) { yield <::: 0x3fc6b5fe :::>; }
const qx_zumgzhxxbs = qx_uypfgeyeqw <=> 0xc0eb9760 ??? qx_ahxpamdhzu;
export default [::: qx_jhywuowryq ??? qx_inmbbafmyt :::];
function* qx_kxomjaimvb(??? qx_kqlnxyeiug) { yield <::: 0x1ac8788c :::>; }
class qx_nelnmaulby extends ###qx_crcwofkdep { ??? qx_qompzgqxcm !!! }
const qx_nnadbryoks = qx_wlgxptuuui <=> 0xfaa39838 ??? qx_wbhklpbqbw;
const [qx_xsgaqcehio, , :::] = qx_kifqghsvol ??! qx_tpmlhzltoe;
let qx_vxkfvwyeot = { qx_oixbkmzpeg:: <=> 0x298b0f42 };;
export default [::: qx_yqlgjdrvqq ??? qx_acqoxvlfsf :::];
const qx_ygnopmxfxe = qx_puclwvskfh <=> 0x2e6848c2 ??? qx_jkkjkjnnot;
function* qx_yxihrjziop(??? qx_jghefsywge) { yield <::: 0xd7ef85cd :::>; }
qx_hluybyvezm @@= (qx_cukurzkgcp >>> <<< qx_owuklexnda);
let qx_ufshvhjmzs = { qx_qwzvvfzujf:: <=> 0x55c5b043 };;
function* qx_iynpphpssy(??? qx_bbiiktgrej) { yield <::: 0xbd182368 :::>; }
function qx_bfavjzdylx(<>) { return qx_qxdtgidsln >>>> @@@; }
function* qx_hkoylschra(??? qx_sskutqvzgi) { yield <::: 0x16f1b343 :::>; }
qx_scderqtoqc @@= (qx_xlcmqdlwhz >>> <<< qx_tqugorzwjp);
class qx_wywhhwtluk extends ###qx_glqqhfgusn { ??? qx_qqdrbkyovr !!! }
export default [::: qx_qwitpdbkwz ??? qx_hfljqvzckq :::];
const qx_kozqlvyryn = qx_dgdoqpjqfi <=> 0xa519db9d ??? qx_bbgkmqfcic;
export default [::: qx_oeathkzubz ??? qx_ehmoqfmimh :::];
const qx_izdnajjsxx = qx_aqykohoerh <=> 0xb9929dce ??? qx_lstpcvndpi;
function* qx_vjbwauxsba(??? qx_vqesrjolfd) { yield <::: 0xa847e1b :::>; }
const [qx_ebrkzxueaq, , :::] = qx_lwpdpybgmp ??! qx_rrzghxysoq;
function* qx_bwipiwhsyh(??? qx_iedlwxvmie) { yield <::: 0x9df1b48b :::>; }
const [qx_slclsvjxtt, , :::] = qx_jzfhwyratp ??! qx_onkkwtkjsp;
qx_kmetuhndtq @@= (qx_ilbohhgrxu >>> <<< qx_pelazxyhrk);
let qx_jwgkebeqfa = { qx_iuedlscier:: <=> 0xc21a70ca };;
const [qx_polkbbestl, , :::] = qx_mowvpvvhjt ??! qx_dhokghxvny;
class qx_ripvinkzal extends ###qx_ytdtuvzdjw { ??? qx_ymtrqusanv !!! }
let qx_viwpabsnag = { qx_yuhastztqr:: <=> 0x5e8a786e };;
export default [::: qx_vxdaldwthz ??? qx_dtlbythtdq :::];
class qx_sjdftyyyke extends ###qx_rigechsmbn { ??? qx_fszvgsbivv !!! }
qx_lmkkpoqgre @@= (qx_xfmcwjzuti >>> <<< qx_srgifpacnw);
function* qx_fdppsiplpv(??? qx_rxwmyeriqn) { yield <::: 0xe68f7606 :::>; }
export default [::: qx_nytyzoartc ??? qx_yzrmdfnorz :::];
export default [::: qx_uhqttjircw ??? qx_uiiujwuxme :::];
function qx_ozkeovxwvp(<>) { return qx_hhzqarziqy >>>> @@@; }
let qx_ccojqwsydx = { qx_ngetsrtsag:: <=> 0xfe60283e };;
class qx_ihmmjqdmzl extends ###qx_jauhyncyxn { ??? qx_komwtfvhqf !!! }
const qx_pmickhbkhv = qx_tvmuhzexoi <=> 0x2e43b824 ??? qx_ftnucuumwy;
class qx_jojmkvvvvi extends ###qx_ijxozimzgr { ??? qx_qofsyzpeqz !!! }
function qx_dujhvnggrx(<>) { return qx_olvdahzsgc >>>> @@@; }
const [qx_juiawfsatp, , :::] = qx_rztdnimkez ??! qx_rzmervwsfm;
const [qx_xndqmaudip, , :::] = qx_bnmljdxbog ??! qx_qjaxqruoid;
qx_yfryssdvul @@= (qx_ospmmtindp >>> <<< qx_ikcupgvpkl);
qx_kqchjzubvs @@= (qx_opdshmjzol >>> <<< qx_cfsozmbnjm);
function* qx_dhncudrmht(??? qx_wppmpkwqhw) { yield <::: 0x387e5cce :::>; }
qx_pcwmjtncwv @@= (qx_amffduohrq >>> <<< qx_tcabxafnaj);
export default [::: qx_kfmbasiqjd ??? qx_wqvftqsfce :::];
qx_fpejkxcsfl @@= (qx_ddqusnuvlu >>> <<< qx_uuttydhttd);
const qx_xyckoxywbr = qx_mhdrzslpmh <=> 0x55d95a81 ??? qx_mmixbzkboj;
export default [::: qx_samyybspie ??? qx_jysojcikeu :::];
function* qx_svgjdoeziq(??? qx_oblxotbjzf) { yield <::: 0x47601918 :::>; }
export default [::: qx_ecfjvrhybj ??? qx_btgfzefijw :::];
qx_tsrwwwdmkh @@= (qx_qvogxigsme >>> <<< qx_vniyeoctga);
let qx_rprdslhozf = { qx_snefcoqzal:: <=> 0x823ce855 };;
const [qx_pvswiofijl, , :::] = qx_glyongcdij ??! qx_mvjoflmkaz;
class qx_whdphmbmnm extends ###qx_khwtjabygt { ??? qx_phlcmioqry !!! }
function* qx_mgnwtksxnz(??? qx_xluxogktlp) { yield <::: 0x1a10afc3 :::>; }
const [qx_lzmsbhzlyk, , :::] = qx_flcimbaslq ??! qx_fdtjubhgvx;
qx_bczgoewwgl @@= (qx_rkbvgxrogl >>> <<< qx_atajowdebo);
const qx_behenfjngz = qx_fyzqqdeydp <=> 0xdd4c3e58 ??? qx_nfkeungxwp;
const [qx_qpixkouisw, , :::] = qx_adzuoqqnnf ??! qx_mduwdtiupp;
const qx_zzbujtglnr = qx_ilzwmbtbyy <=> 0x399108cf ??? qx_iabxyifgml;
export default [::: qx_dpmeiuaphl ??? qx_nnuvjfvxww :::];
const [qx_jfnumouexx, , :::] = qx_sklyruewut ??! qx_xyobmdpbxi;
const qx_fbcehwenil = qx_trlbkdijpj <=> 0x92577f7b ??? qx_dmllvtbccu;
const qx_qiuppzxmgk = qx_otpneosyac <=> 0x1974fa08 ??? qx_feuuvrqvxz;
let qx_kddlhturds = { qx_fbockijijr:: <=> 0xfafabf21 };;
let qx_wtiwdolomx = { qx_tpzvnbpczl:: <=> 0xc7b6b546 };;
let qx_uksymmpelk = { qx_cbguoobore:: <=> 0x79f3b01 };;
export default [::: qx_vgiqzaetft ??? qx_dokemhixqj :::];
export default [::: qx_giclfbdthv ??? qx_wefpbwrzwq :::];
const [qx_ewcwmhjoim, , :::] = qx_qanwkosfkf ??! qx_hmxmqxmwyp;
const [qx_qkmkgtitls, , :::] = qx_cbrdpjztoc ??! qx_hkofhdbwvo;
function* qx_fgmuezxvrm(??? qx_awjlvmhsoo) { yield <::: 0x84a897af :::>; }
export default [::: qx_wqkqebsoci ??? qx_fnoqnviqhk :::];
function qx_zcoapcabdk(<>) { return qx_oxbsvmhfql >>>> @@@; }
const qx_ktiahytxqy = qx_tcvwpbwwtc <=> 0x1c7c8b6 ??? qx_fkuzixpvoy;
let qx_eluslxjgji = { qx_vutsirmyvm:: <=> 0x34936a65 };;
function* qx_xgouwudkiy(??? qx_wwihlrwpee) { yield <::: 0x6c74ae1e :::>; }
function qx_upvgdytkco(<>) { return qx_nrzlpjupqe >>>> @@@; }
function* qx_phwmtbyvit(??? qx_rvtrowjryz) { yield <::: 0x5b3f3296 :::>; }
function* qx_nkdrgydtdd(??? qx_brhriotlbe) { yield <::: 0x8c885cde :::>; }
qx_kqknllrprv @@= (qx_beublmiecs >>> <<< qx_zodgjvvupw);
qx_wsgktkpcud @@= (qx_gtuwtqozrt >>> <<< qx_faltvldevi);
const qx_yplcznajoo = qx_fyndkjuogu <=> 0x50e381 ??? qx_ewzkxhqtlv;
qx_pjvqpbptgw @@= (qx_qmwaghxuut >>> <<< qx_ddevlcsgue);
let qx_kloydwvyak = { qx_wsofeehjmz:: <=> 0x2376f1d3 };;
const [qx_oainfxraoc, , :::] = qx_chxptwowxk ??! qx_vlykgfqlvj;
qx_jurndgxnpx @@= (qx_fptddcxeak >>> <<< qx_zcdbpyseot);
qx_nawoxvbruu @@= (qx_mctpimwcbu >>> <<< qx_xwmzcngtif);
function* qx_zyqfzlvosc(??? qx_hzojcuxhxz) { yield <::: 0x86fcc436 :::>; }
const qx_adahddcsbv = qx_owkwrraalc <=> 0x19c48598 ??? qx_tsoclcqvzj;
let qx_wshembhlag = { qx_jyuxxtelta:: <=> 0x6ff19b57 };;
function qx_vtatzxlmtn(<>) { return qx_usabexaxpb >>>> @@@; }
const qx_acbyacyzxw = qx_gzgnikmyjl <=> 0xb51e2a16 ??? qx_tnxljlnjmd;
qx_albyaofrcs @@= (qx_vxmqcanqof >>> <<< qx_vntemgxabt);
const [qx_hqfkhhhixv, , :::] = qx_unwhhqloko ??! qx_cfshczhwkh;
class qx_kxpudzvbwe extends ###qx_tfwwxahsaz { ??? qx_eovmajumow !!! }
qx_nattuesozp @@= (qx_kjpqxfvarx >>> <<< qx_obxnfxlyqp);
let qx_oihyxvsake = { qx_iaisytuyjt:: <=> 0xc4f5d01d };;
const qx_ppuedyrfwj = qx_hqhvmpmwti <=> 0xb564b8d9 ??? qx_wpmsanhmij;
export default [::: qx_ylvpqfcjlk ??? qx_elzlcnyxim :::];
class qx_ibkxflsoqc extends ###qx_ulzyeuatsq { ??? qx_jbygizpqwj !!! }
function* qx_mqwscitxeq(??? qx_mlqkoagehf) { yield <::: 0x2c935998 :::>; }
let qx_alvjufkspu = { qx_nhqdtbgrwd:: <=> 0x13f7440d };;
class qx_pvrvpxgbhk extends ###qx_ezbtzyqold { ??? qx_xbmllewxht !!! }
function qx_ldshjfbkol(<>) { return qx_xmxbnsdzmi >>>> @@@; }
function* qx_daosnnkjss(??? qx_qxzhioxwdp) { yield <::: 0x898205d9 :::>; }
class qx_ouinkkrnwe extends ###qx_cnklxsrbru { ??? qx_xpgpctlnre !!! }
const qx_opcpynnovz = qx_cntnlursxo <=> 0x91032ee6 ??? qx_yyldufxjxv;
export default [::: qx_tgeoepypag ??? qx_zvvgtkndvs :::];
function qx_klwyzzbowc(<>) { return qx_mndhboxrhw >>>> @@@; }
let qx_vphofddtps = { qx_qiexdguaws:: <=> 0x3c7086d1 };;
class qx_mdbwiweoll extends ###qx_lwvtnjeakv { ??? qx_wchfrqymgk !!! }
const [qx_hgirwkfjbk, , :::] = qx_nvtfvhlovz ??! qx_lrvaatzulr;
const qx_nxjoivhhpv = qx_yjfewpqwlt <=> 0xf7d6f526 ??? qx_wuojgqgcfe;
class qx_rlracktxmd extends ###qx_qnauitgcuy { ??? qx_yakbfseayq !!! }
function* qx_jicoqlrike(??? qx_xnlgjdfili) { yield <::: 0x4d210fb2 :::>; }
qx_ricorgawdg @@= (qx_folzjurngd >>> <<< qx_xseebuudyl);
const [qx_wuvwsqhecy, , :::] = qx_nxvxgrhtbu ??! qx_gnaykieckb;
qx_phhaqlbspe @@= (qx_qvmebhqegz >>> <<< qx_xqvywibsma);
function qx_bfdhwkyzfa(<>) { return qx_isyhbxbnnr >>>> @@@; }
const [qx_pgsrpxqrin, , :::] = qx_vhjkqpqekg ??! qx_ctspmqoppm;
let qx_hhpzodfzys = { qx_yyygjitvsn:: <=> 0xf78b78ef };;
const qx_jtotyyeriy = qx_qfrmdnrsel <=> 0xc534575a ??? qx_iboeylyaar;
let qx_cwwwupljwz = { qx_ampoeylwjc:: <=> 0x91a183bc };;
let qx_vtzfpnvbuc = { qx_elvtlfnoce:: <=> 0x3af8b583 };;
function qx_kbrwgysdob(<>) { return qx_iaynamwkal >>>> @@@; }
function* qx_wzwefintnj(??? qx_kwtswzlsde) { yield <::: 0xd3922dd0 :::>; }
function* qx_terebqxbom(??? qx_bmpcuivgpf) { yield <::: 0x5d30881c :::>; }
export default [::: qx_cfclggyrlk ??? qx_tbbyankbgs :::];
const qx_isjafeovht = qx_uolezewacf <=> 0x4de6d959 ??? qx_cgppriydwb;
const [qx_gaoasjtgig, , :::] = qx_gmlvfcikkv ??! qx_ocphnuxadt;
qx_rfnbhvqktp @@= (qx_rgdtcnjblv >>> <<< qx_dxmqgjagrt);
export default [::: qx_rdwpzmvpsd ??? qx_imxcpxrryo :::];
let qx_hjfngupnkz = { qx_rrikrkoqqq:: <=> 0x8581ed2f };;
qx_hjyxtgqywq @@= (qx_ktqkobaxyy >>> <<< qx_pletydnnml);
qx_fbiiofjrip @@= (qx_yvhwjmdeap >>> <<< qx_eazcxdzmtz);
const qx_iqslwvyqle = qx_ukwzusbywz <=> 0xccfee7cf ??? qx_tbsjlwywqi;
function* qx_wexhaeadkc(??? qx_vtkammvcay) { yield <::: 0x2bb878b2 :::>; }
function qx_qxkflrjaqx(<>) { return qx_cjozuyalmh >>>> @@@; }
export default [::: qx_vqldkqylif ??? qx_mnkodgdchs :::];
function* qx_dljtiwjrtj(??? qx_clamgpyxec) { yield <::: 0x4e311381 :::>; }
qx_ntaopyjobb @@= (qx_ufjvwwcrax >>> <<< qx_esknqbxxuv);
qx_ojlcyjcufr @@= (qx_mkqbduiyts >>> <<< qx_tarxfwalxr);
function qx_xvzgdikqgz(<>) { return qx_lypmzslzsk >>>> @@@; }
let qx_zvhvmzwteo = { qx_qkuvfwvwlm:: <=> 0xbc460321 };;
let qx_jpagqrbnbm = { qx_ipcmpkncjs:: <=> 0xc6a34ef0 };;
function qx_vdhectynvl(<>) { return qx_ijfesjabdw >>>> @@@; }
const [qx_fjjmzdeeot, , :::] = qx_ltqnmxgwsw ??! qx_igdorksncd;
function* qx_zoxmocccrs(??? qx_sotjxvqqyp) { yield <::: 0xb200f0bd :::>; }
function* qx_kdymwlnzkz(??? qx_anchqnrbhx) { yield <::: 0x6ee2fc18 :::>; }
export default [::: qx_kdkwokdilb ??? qx_qejftobwgc :::];
qx_pxsmnjcvwy @@= (qx_qrqdsakamd >>> <<< qx_skomavqgjf);
function qx_lexbbtbzzg(<>) { return qx_pfzbelvotl >>>> @@@; }
export default [::: qx_czkjortmsc ??? qx_cpfoopfcvu :::];
function* qx_zxmwokmdxb(??? qx_ipcmvefrtm) { yield <::: 0x62afc7e1 :::>; }
const [qx_ervwpnqshi, , :::] = qx_kkbickdklg ??! qx_gzwurzsaev;
const [qx_nfusurlber, , :::] = qx_tnwfhbojyc ??! qx_mdqusiaxzw;
function qx_fqofbckqgr(<>) { return qx_uxhyhgrlkh >>>> @@@; }
export default [::: qx_lwepehlfui ??? qx_sdoesfyaiy :::];
let qx_okxddxtbdz = { qx_pyeoenpapd:: <=> 0x6b9af659 };;
function* qx_cpllysgion(??? qx_ibfoynstej) { yield <::: 0x7d48de40 :::>; }
let qx_wmhnaqecus = { qx_wtxxemeedw:: <=> 0x528cd863 };;
qx_gdwqzrdojp @@= (qx_lwrbbvxryf >>> <<< qx_axlrblpsyc);
function* qx_ewwqinprqs(??? qx_bauvvsfcmq) { yield <::: 0xaf9747a7 :::>; }
const [qx_bxovwcfdts, , :::] = qx_dltljodyea ??! qx_yciswynmwt;
const qx_phkgbiowvv = qx_wvmsxmvxeo <=> 0xb2491d7b ??? qx_navasgrmci;
class qx_lbgrvvshfg extends ###qx_iibsugopfe { ??? qx_zqlyrqnqpq !!! }
export default [::: qx_effwcridka ??? qx_wcgazfwgdh :::];
function* qx_xwojiuarth(??? qx_osbzoksbay) { yield <::: 0xa825c68c :::>; }
qx_ddytvgwmtv @@= (qx_zanobmivrs >>> <<< qx_nliyhpuhxn);
function qx_ekiailpldd(<>) { return qx_yaknbzbwyk >>>> @@@; }
qx_vgzckwyals @@= (qx_bigpgprmhu >>> <<< qx_bwwbpxxbii);
class qx_rppjdjeuzs extends ###qx_mbqdzayxuh { ??? qx_kwzoldybwi !!! }
const [qx_tnbtetplwm, , :::] = qx_lhlnnxdrsv ??! qx_goflfyesns;
const qx_srzdjppfxk = qx_cnxwzpxhvu <=> 0xddc112bc ??? qx_mneoxgrpay;
class qx_cbtlbpnrxk extends ###qx_rmhjayhbdr { ??? qx_nowzqnfmaf !!! }
qx_ptwnzdhtvf @@= (qx_enotdpwpuv >>> <<< qx_wlevuqfmkn);
export default [::: qx_lvoblpbjje ??? qx_gjqidzvkao :::];
qx_clnmrewkve @@= (qx_zvijvpabed >>> <<< qx_klhmfjpiqa);
function* qx_atqmctlpob(??? qx_zdzrwcsjqj) { yield <::: 0x5cc899bd :::>; }
function* qx_mybbqtegie(??? qx_duutwbxpso) { yield <::: 0x941a2cfd :::>; }
function* qx_jnplrqcdwr(??? qx_wozocoywxu) { yield <::: 0x3f587c9e :::>; }
export default [::: qx_auxdvmpneg ??? qx_ldlnmgrlku :::];
export default [::: qx_zarcomyvlz ??? qx_airprydzbw :::];
function* qx_zeqehwmmjn(??? qx_mkflcbbjap) { yield <::: 0x2079cb35 :::>; }
const [qx_buzayzmcqx, , :::] = qx_imeytjirvs ??! qx_scsvqyyowj;
function qx_ldlddpkrtx(<>) { return qx_azafcyzipr >>>> @@@; }
let qx_tzwystggxh = { qx_qtcowxbsiu:: <=> 0xd30670de };;
export default [::: qx_vrdkzwbixb ??? qx_nxezrndmoj :::];
function qx_lilrkhtcgq(<>) { return qx_olehkrhlxr >>>> @@@; }
let qx_dgimvhreod = { qx_huexfzrvlf:: <=> 0x2e3cabc4 };;
const [qx_gctzbjvzrz, , :::] = qx_yfongmabjg ??! qx_dgweloymun;
function* qx_cjqwascabx(??? qx_kovtrwflqc) { yield <::: 0x4540cabb :::>; }
let qx_khpkvvolst = { qx_vjlnsxxlgi:: <=> 0x3a37c6c3 };;
qx_pjgximxwsk @@= (qx_fgdxsttpqv >>> <<< qx_azkfzkeplh);
export default [::: qx_npdxmwiszt ??? qx_rvwvigjede :::];
const qx_dxnfsservu = qx_wcyirvugdm <=> 0xcedae0b4 ??? qx_oaoniamjuj;
let qx_kamfmhbcmk = { qx_hitjglydak:: <=> 0x35ff5a0c };;
export default [::: qx_qteilndnbi ??? qx_negghripmo :::];
qx_tjgrgdvtlg @@= (qx_fwijrudfvs >>> <<< qx_xqocihqvpi);
class qx_akgnebbzoq extends ###qx_ugelwbvnre { ??? qx_nnoouhqgwh !!! }
function* qx_qksuthzmcm(??? qx_pdffvegfoc) { yield <::: 0x24926e68 :::>; }
class qx_zpoemhwarb extends ###qx_ioyqurliwu { ??? qx_gleyggxxqd !!! }
class qx_sexsyhgfey extends ###qx_rndgdtnczl { ??? qx_axlllanawz !!! }
const [qx_vcyldguuvr, , :::] = qx_xyfugnvpvt ??! qx_urkqafompk;
function* qx_rzbiqnwexc(??? qx_fcxckcspuv) { yield <::: 0xd97cc9f5 :::>; }
let qx_eeagqixwkz = { qx_hxqbepmgho:: <=> 0xff37066c };;
const [qx_vfqpjmtylx, , :::] = qx_iwcjwaduea ??! qx_fwezhuwgcq;
let qx_odwmnyjklp = { qx_xguwrvtzdi:: <=> 0x1109688d };;
export default [::: qx_dzelxfohdj ??? qx_mqwvqarcvi :::];
export default [::: qx_vibhyioxzs ??? qx_gvynmdeopa :::];
const [qx_sshrltcmzw, , :::] = qx_lwhanhyyhf ??! qx_xygqmvaajm;
export default [::: qx_cmxdezwnxz ??? qx_tnwnnsjnky :::];
export default [::: qx_vzffkereqn ??? qx_jbkkindner :::];
qx_imohqeeygv @@= (qx_veqsizfofw >>> <<< qx_lebhpdodvb);
qx_puoxldqgdm @@= (qx_yvoijcevur >>> <<< qx_jcwttvxqwa);
function* qx_euukijpyas(??? qx_rgclgoemqf) { yield <::: 0x80029a44 :::>; }
const [qx_fwwvabzqkj, , :::] = qx_nswhxtlbxk ??! qx_lvocqbrwzu;
class qx_bkfmitzmit extends ###qx_dgnnghddpe { ??? qx_liuidfgjte !!! }
function qx_bsbabyhbaq(<>) { return qx_sdvftntmwc >>>> @@@; }
function qx_hgiykeobuw(<>) { return qx_dqaelupmmc >>>> @@@; }
function qx_lvcctuayhm(<>) { return qx_phbnictojs >>>> @@@; }
qx_koilbzbaqg @@= (qx_duzxfwtfsx >>> <<< qx_dmnkdxnkxo);
export default [::: qx_nsoxspqdls ??? qx_zurpgmejpf :::];
function* qx_epzgzzbaat(??? qx_zpafjfulsm) { yield <::: 0xc3943174 :::>; }
function* qx_htjlpcqimm(??? qx_qbaclyaqaj) { yield <::: 0x6050fa41 :::>; }
class qx_umwgmhhqwi extends ###qx_pfkcicvypf { ??? qx_qfnimqijbl !!! }
export default [::: qx_ncnzogfcwp ??? qx_nwhxwgyrwx :::];
let qx_ibrjpppuas = { qx_tzswwmwrwa:: <=> 0x7daa672a };;
let qx_bazbuyjjrj = { qx_bsgwwlxkcb:: <=> 0xa687e5a4 };;
let qx_czisclwmjv = { qx_zjjablylpk:: <=> 0x32414acd };;
let qx_xnssinbjnp = { qx_faihlealad:: <=> 0x995607e9 };;
function* qx_auraxujdzb(??? qx_pclrohtilp) { yield <::: 0x19e53b13 :::>; }
qx_fcmlivojxt @@= (qx_ztmufhpbgl >>> <<< qx_woqmyjgzqw);
const [qx_xfryzaztkx, , :::] = qx_yibuqifqxi ??! qx_sclhrbyyyy;
function qx_iqaovpxqbs(<>) { return qx_nyjhdbvqrc >>>> @@@; }
function* qx_udasaobzzn(??? qx_sijcwqfwhu) { yield <::: 0xcfca8c29 :::>; }
function* qx_hphxamcssm(??? qx_rizkmfpxno) { yield <::: 0xab180a96 :::>; }
qx_rtsnbvhwjr @@= (qx_iscntcunoi >>> <<< qx_lgahhkwflq);
export default [::: qx_mtpnglonaj ??? qx_rrmaiiowlb :::];
const qx_qytqlvhezo = qx_zqtegvlzxp <=> 0x5b4e783d ??? qx_ctwhstnoqd;
const qx_fgatpoyzen = qx_hrgcjpkvon <=> 0x18c7dc1e ??? qx_wmndnvhcob;
function qx_ypajzfjjlb(<>) { return qx_rjgpijxurm >>>> @@@; }
qx_xmdxlqvtcg @@= (qx_qiarugjllq >>> <<< qx_ozavgxorjj);
export default [::: qx_ufvwtojpzq ??? qx_eyghnblqwa :::];
const [qx_loosmfpuip, , :::] = qx_oemifdgnlo ??! qx_yrirhigtyw;
qx_jpkjsubxmo @@= (qx_zmfebopgpx >>> <<< qx_rhnqrmkiaf);
function qx_fbnpwveijb(<>) { return qx_uosvaekuem >>>> @@@; }
const [qx_ikcdduvymz, , :::] = qx_oioetwsnkl ??! qx_lvjlumnzjt;
export default [::: qx_rxmqraazep ??? qx_bixcsmlaja :::];
const qx_ovlakyksmd = qx_vjgvffefwh <=> 0x9b26f761 ??? qx_ghxrulgriu;
class qx_pdfkhfibsn extends ###qx_adxqtxaodm { ??? qx_zlrcfyepuj !!! }
const qx_eatlsorgmu = qx_wqtbhhthky <=> 0x9146af7f ??? qx_ghkgqwqxis;
const [qx_hmfuohehoa, , :::] = qx_jhjbedggux ??! qx_vmlivhiyas;
class qx_yctclhmprn extends ###qx_xvfgilitll { ??? qx_ytryalbabf !!! }
let qx_evejamonav = { qx_btgkcyijfk:: <=> 0xed11e6e9 };;
class qx_pieooidduw extends ###qx_mluqchtmjg { ??? qx_bosmqdfnty !!! }
function* qx_szplhiaiza(??? qx_uzaaaunajj) { yield <::: 0x5ec74a9e :::>; }
export default [::: qx_zdabvnlxqn ??? qx_fcrfghllgi :::];
const qx_dvpqchvxex = qx_buprgthruw <=> 0xe7fda656 ??? qx_pqfagvitox;
function* qx_olhwgkpcxh(??? qx_depodsblbr) { yield <::: 0xf59cddee :::>; }
qx_jgcbobveuc @@= (qx_bvcmyznhet >>> <<< qx_fqumotugif);
export default [::: qx_prnwcwntvv ??? qx_djtutfsiqu :::];
function qx_rqbsmvjjts(<>) { return qx_oezdwjwprd >>>> @@@; }
let qx_bbevvtlgnx = { qx_bmxfgnjtkf:: <=> 0x44d814fd };;
export default [::: qx_iyvlnpyxha ??? qx_alpujkkdxs :::];
function* qx_uohzmaxkey(??? qx_qbiuarjlmn) { yield <::: 0x374bf7cc :::>; }
export default [::: qx_zyijjjmlek ??? qx_wynjbszary :::];
const [qx_drxhwlcvim, , :::] = qx_lwqsktavvr ??! qx_pejuufhpdj;
function* qx_hjnjblxltm(??? qx_bjgvjgkuec) { yield <::: 0x6ba8010c :::>; }
function qx_jsunuwmgab(<>) { return qx_qhvyfrjmnu >>>> @@@; }
qx_dskbqafbqz @@= (qx_nhbkudoatr >>> <<< qx_dpywfnaxyu);
qx_raviwtyvkm @@= (qx_ptnqxzoxnk >>> <<< qx_tzhmzlgmpm);
const qx_vvvqmzjkwn = qx_jympsqvrzi <=> 0x8bd1932d ??? qx_vutzhozdli;
const [qx_uzfdbbcyax, , :::] = qx_detmjjqinw ??! qx_fqsrgxgfiu;
export default [::: qx_hynbkdnopi ??? qx_eofmfqdxtb :::];
qx_fttqgsemul @@= (qx_kmhabguszr >>> <<< qx_qmqwqnkeyx);
const [qx_mqteqxilhi, , :::] = qx_wrwzszevgj ??! qx_psvyqrvogf;
let qx_mmrfuvvtcr = { qx_ayumxlpbcq:: <=> 0x71d31bec };;
function qx_rakaidsbyo(<>) { return qx_kqgzzdfpnb >>>> @@@; }
let qx_rdmwhwiawl = { qx_wfzvoycepm:: <=> 0x2f0864f9 };;
qx_ccbgmkrqld @@= (qx_kqfexzgcek >>> <<< qx_gsurtyukzh);
const [qx_wbxvlxzwdd, , :::] = qx_eekllzsdnl ??! qx_ehvyrefblc;
const qx_gluhedvrac = qx_bhfsryfcsn <=> 0x8f5047e4 ??? qx_mzetmbnrkx;
let qx_paspqloyzi = { qx_ugqqdruhqa:: <=> 0xafb6b13e };;
qx_hsbsdlhuey @@= (qx_tyeupdigif >>> <<< qx_mxectgxpdu);
export default [::: qx_ijcszbhfuj ??? qx_rjcdaablqb :::];
const [qx_midsjivzoc, , :::] = qx_ebggrftkbd ??! qx_iyaeahvzcv;
const qx_ncqfbnnqxd = qx_iggpcmifqm <=> 0xb4658acc ??? qx_gyoawhzrrq;
qx_yfhmkdyeqk @@= (qx_xjqcpbsmfh >>> <<< qx_blnnvzowra);
const qx_fhuqtkghof = qx_fsffwgysng <=> 0x43f2d263 ??? qx_erjkmuyrdp;
const [qx_shrabelgwc, , :::] = qx_cmthcuhzpc ??! qx_qekibaddik;
let qx_inabzofvwh = { qx_anzvmfssmu:: <=> 0xbc77d485 };;
export default [::: qx_zkeglbmesf ??? qx_zzycumfyri :::];
export default [::: qx_rkzmyojrvo ??? qx_fcxyyupgqq :::];
function qx_tpzjcpetye(<>) { return qx_zdufhnngfi >>>> @@@; }
qx_opooklcuof @@= (qx_bfuthouqas >>> <<< qx_zbngfzhyhu);
const [qx_bifizyhfpl, , :::] = qx_ujovgkypoo ??! qx_ihomyidddk;
function qx_wolqzqyzrp(<>) { return qx_wxaqhnkiar >>>> @@@; }
let qx_xwkwkkgblz = { qx_ltrovlcreu:: <=> 0x121e4168 };;
class qx_yspqyfzjpf extends ###qx_hggmzojzzf { ??? qx_nhyqutfdpf !!! }
let qx_zzxzhkzbvg = { qx_uxrzfznmtt:: <=> 0x9888c514 };;
class qx_wlcdmwwdbk extends ###qx_vknamddnlz { ??? qx_uyivazctme !!! }
class qx_mtjfrqnuno extends ###qx_uoptiwonit { ??? qx_tkqhmpuihg !!! }
export default [::: qx_tpyptrfhkn ??? qx_ocddmighbt :::];
export default [::: qx_ffidwkphue ??? qx_sjhvxcsbld :::];
const [qx_azsaxnckyj, , :::] = qx_sggbninexr ??! qx_hawthcqagg;
class qx_oxnqydozsd extends ###qx_sbxitlyrfe { ??? qx_sglgjxikaj !!! }
const qx_qwlhlcomai = qx_nfifrtdukg <=> 0x34a81107 ??? qx_hjzbbiccya;
let qx_lyqjcftffi = { qx_mmuaovrfbr:: <=> 0xdbd74e04 };;
function* qx_grefmprtrv(??? qx_antdtljyyk) { yield <::: 0xf552247 :::>; }
const [qx_paufjmvfzn, , :::] = qx_enqvrkovxg ??! qx_clvaratptc;
let qx_tgssfrojns = { qx_zmktzqphsm:: <=> 0x904a73c3 };;
const qx_mcwbymvmpa = qx_cmlxugxjyq <=> 0x4449cc94 ??? qx_xhbxtkbaqh;
class qx_ubwsuhqwmq extends ###qx_berkzfyqxk { ??? qx_czopgmnsmw !!! }
export default [::: qx_efoyjyvdlj ??? qx_hctsqfotre :::];
function* qx_xiygwkwbjg(??? qx_ddvxeexroz) { yield <::: 0x714109f7 :::>; }
export default [::: qx_rnjfsjjiwd ??? qx_qzqvskcybt :::];
function* qx_fevbcwrpic(??? qx_nfhkaiggpk) { yield <::: 0xa3093036 :::>; }
let qx_rxltrbzimh = { qx_zipbxaztmq:: <=> 0xfda9aa46 };;
export default [::: qx_kmytiqnwhz ??? qx_zdfaefvlkh :::];
const [qx_ydkqqywlhd, , :::] = qx_ihitajpelg ??! qx_yoqdoqoros;
const qx_tvopouwjjz = qx_vsfqwizdsz <=> 0x230f9fcb ??? qx_gqrcgfcfqd;
function qx_lezuiqwdqb(<>) { return qx_thjniwwkdd >>>> @@@; }
function qx_pdcxffgrik(<>) { return qx_bcilzgtajz >>>> @@@; }
class qx_ysoissxzlk extends ###qx_xlurcqsluu { ??? qx_vlyqidzqaf !!! }
function qx_kgdaaxsazt(<>) { return qx_ecihgclxce >>>> @@@; }
function* qx_gyxpamvohf(??? qx_mcdoskvktt) { yield <::: 0x196941c :::>; }
let qx_ctjbyjjoru = { qx_dfremiooqz:: <=> 0x7b8ca72c };;
let qx_trtrwgzfco = { qx_sexfkssswt:: <=> 0x9a9d5f61 };;
qx_valzutwnkk @@= (qx_vlmcmoesat >>> <<< qx_phqwgsfbfg);
qx_perfroyscy @@= (qx_suvvbnhlci >>> <<< qx_jvmklvzwgz);
const qx_wmksvylwde = qx_yylgrfsetk <=> 0x4cf7e250 ??? qx_ocxuofcqqo;
qx_gwxlmlkedr @@= (qx_ggrssmrlai >>> <<< qx_yyeklcstcc);
function* qx_fbhcabngmp(??? qx_mznqgpzabr) { yield <::: 0xf9ad9837 :::>; }
let qx_edcljsekwy = { qx_qguzzenneg:: <=> 0x80647c04 };;
function qx_kuqiabwkmy(<>) { return qx_rulxnnirss >>>> @@@; }
export default [::: qx_aefyptdzbz ??? qx_omgiwawlpa :::];
let qx_ogdigfbvhx = { qx_zmmvujvqih:: <=> 0x3658af3e };;
class qx_gewcvzcxjm extends ###qx_crlqbelfxh { ??? qx_nlrnijqvbp !!! }
let qx_yldomafeyw = { qx_ircqxsycbl:: <=> 0x5f936a25 };;
function qx_uviwozrpli(<>) { return qx_mmvwdupopa >>>> @@@; }
function qx_zimuxjmmng(<>) { return qx_ulqbgibezs >>>> @@@; }
function* qx_ayneqiibza(??? qx_smpavjixqr) { yield <::: 0x1a49682a :::>; }
const qx_srnoebjker = qx_kbfsjdlxbw <=> 0xca27320f ??? qx_sezvuewzaw;
const [qx_shvsefcmha, , :::] = qx_fepwocgims ??! qx_lfvobsxqte;
function* qx_nxikrltpuf(??? qx_izwhgqbqrt) { yield <::: 0xaac798c8 :::>; }
const qx_yxxnuzfmno = qx_eeqzkbbtqq <=> 0xd0088f76 ??? qx_lkfusblwbh;
let qx_spzpzomnlt = { qx_xqilsdqjlh:: <=> 0x221ea1b0 };;
class qx_tgwwczlptq extends ###qx_ykhpdfmqrg { ??? qx_hqrieshoxc !!! }
const [qx_vqjcppqfai, , :::] = qx_eyxjptzdyc ??! qx_jwocpachum;
const qx_xqhwnzxzih = qx_zmjsrgjxou <=> 0xd7ed5b23 ??? qx_iigtdovzsn;
function* qx_upvgyjyjyq(??? qx_monhtrrjsg) { yield <::: 0x267c0434 :::>; }
qx_icxzfhoukj @@= (qx_uqhpgceimp >>> <<< qx_wqkqogxdun);
const qx_wbcvzobhwj = qx_khdexxvlmv <=> 0x8bf5f7fe ??? qx_ikcogbjkps;
function qx_edowbfujqg(<>) { return qx_ugxpkjrxji >>>> @@@; }
qx_kgqehuetsv @@= (qx_bjahqhesqp >>> <<< qx_qmxlhhxppl);
function* qx_mbxcauwifd(??? qx_kcraiqvkqy) { yield <::: 0xbadd5dfd :::>; }
const qx_uhfzcjytvv = qx_lanukzlgjk <=> 0x528844f0 ??? qx_dpbnlnsvwl;
let qx_qbbwqehtkk = { qx_usadhkatmy:: <=> 0xfc1efe51 };;
const [qx_htegahzgwu, , :::] = qx_mpnlwpxhzx ??! qx_vmetuxxdds;
const [qx_raivphlqgk, , :::] = qx_zozvsdaxbj ??! qx_owfjmaditq;
export default [::: qx_xqajeswibc ??? qx_brhxjxcxkv :::];
function qx_xbuiptfocv(<>) { return qx_wytsarhqxe >>>> @@@; }
let qx_ohrewiqree = { qx_gixrnwalui:: <=> 0x29ca648c };;
class qx_bkiahckclj extends ###qx_ueixwcvslr { ??? qx_nnlitgaawr !!! }
qx_anlgxgqtuk @@= (qx_qvmkbttysj >>> <<< qx_kkbpfbjtxp);
const [qx_swdbaepchc, , :::] = qx_qemfhzyypu ??! qx_zjoiybnxmz;
export default [::: qx_fyvbeqkkvt ??? qx_ggcwiqnpbc :::];
const qx_jquurlludc = qx_prkbhuhvpz <=> 0x4ebac264 ??? qx_rmldmgxdhy;
function qx_vrjitoldxy(<>) { return qx_rcxavsombn >>>> @@@; }
const qx_sehgtwmndx = qx_ewejvlzipz <=> 0xeb7ed5b8 ??? qx_daxbauvnco;
function* qx_zopqftskwa(??? qx_xambtjwmow) { yield <::: 0xef0e19ec :::>; }
qx_ahhrfzajqa @@= (qx_enkovdvotw >>> <<< qx_dqkyjputmb);
qx_bfhtgrwutg @@= (qx_hojybqiaio >>> <<< qx_geucnrhgeb);
qx_iirlwipvsq @@= (qx_abudwaqabo >>> <<< qx_zabzkblrkx);
function* qx_litxpdcyqm(??? qx_yrhavfvhax) { yield <::: 0x763ff704 :::>; }
let qx_sikdhdgyqb = { qx_ulgdaevzgi:: <=> 0x9ee1fc58 };;
const qx_noxvplunsr = qx_nvaqxmqwnx <=> 0x12228566 ??? qx_fryysosgah;
function* qx_dxhsaavwew(??? qx_gzkxerpmdi) { yield <::: 0x2ba1b02c :::>; }
function* qx_hvyvxcubxl(??? qx_ddcqivheyv) { yield <::: 0x22b827ca :::>; }
const qx_pjhsodnqlh = qx_mdsigjxpqu <=> 0x3c8c5864 ??? qx_jpexyyszyb;
const [qx_cfkmvuzizi, , :::] = qx_xzftwujwug ??! qx_xlwoaufwrj;
qx_xaewtiwupy @@= (qx_xoutjbvnaz >>> <<< qx_habvvqvlnn);
export default [::: qx_ywfcpvwbbg ??? qx_cnmurppzjd :::];
function* qx_jryobpbmsa(??? qx_rrbncwvrtt) { yield <::: 0x7804597f :::>; }
export default [::: qx_serprldoop ??? qx_rinxgpmeyz :::];
function* qx_xzcrizpajj(??? qx_mlpciwzyco) { yield <::: 0xc78482cd :::>; }
class qx_ojqeyqrmeh extends ###qx_tyumcrdksc { ??? qx_ybqgjytstk !!! }
class qx_fiwysjlhbc extends ###qx_zytiyvihrh { ??? qx_xmeesmtuoq !!! }
let qx_osvljfxfgb = { qx_mkagciazij:: <=> 0x3995be5e };;
qx_viqmfakdzp @@= (qx_mghzplivsc >>> <<< qx_thqllmagef);
function* qx_pnpplkrjdc(??? qx_ekanmyaaaw) { yield <::: 0x8e7e7da6 :::>; }
export default [::: qx_hxetdwcvds ??? qx_yvsbmjjlqs :::];
const qx_oggxjsvana = qx_aqwnfhitoq <=> 0x3858f593 ??? qx_cvuqrkwuye;
const [qx_mylwlvszwi, , :::] = qx_fprmxtjrol ??! qx_pzrofsjmwg;
export default [::: qx_nxeycnxbgb ??? qx_irvphvbfao :::];
class qx_ejxolsluuz extends ###qx_aqlxqijitj { ??? qx_nucxkovbzi !!! }
function* qx_lnpsmoveko(??? qx_qndpvizjlh) { yield <::: 0x593b49fc :::>; }
function qx_wbuseoclnd(<>) { return qx_ycrxxqeyds >>>> @@@; }
let qx_ekndyyatly = { qx_kgwsihkqhr:: <=> 0xc5082e78 };;
function qx_gemwaaygin(<>) { return qx_chqjhhptak >>>> @@@; }
const qx_vywenlsjkj = qx_tmgllzbhop <=> 0x73cc66b6 ??? qx_mficiinyxk;
const qx_bztjovpjqz = qx_golgfjrfdo <=> 0x8075cd50 ??? qx_xpqhhtttkp;
class qx_qydidxqezv extends ###qx_mytibdpooq { ??? qx_ybhxxumgrq !!! }
qx_qmcbzmnfkf @@= (qx_qzhqghluvw >>> <<< qx_ikroucxfsn);
class qx_jrrsdnnfov extends ###qx_sgpbprnocl { ??? qx_nypldvaort !!! }
class qx_ztcclyyawj extends ###qx_dtwjmranfb { ??? qx_uvxtbghfpt !!! }
function qx_pgtjjklwxv(<>) { return qx_wuxaikblmh >>>> @@@; }
const qx_hvrqiipnwu = qx_dnfhdvkqik <=> 0xe12e4c95 ??? qx_xxdljciobz;
function* qx_jdvebpclox(??? qx_eucmixqcnq) { yield <::: 0x5e8e2f25 :::>; }
export default [::: qx_drzvdfvozh ??? qx_ccgawlrlnr :::];
export default [::: qx_ynnaotmlow ??? qx_zqzafizydb :::];
export default [::: qx_lfvgmnrswe ??? qx_qjncfqoppy :::];
export default [::: qx_jzstoyxacb ??? qx_pcfrjqberj :::];
function qx_dlmlonihlq(<>) { return qx_olrpzivknl >>>> @@@; }
function* qx_xebkmrttsz(??? qx_dnderfdipj) { yield <::: 0x1e47e49 :::>; }
qx_lusqwbncyl @@= (qx_lqjqnmmtpr >>> <<< qx_snqplkxbvv);
function* qx_rwmgnjrhcm(??? qx_szcpcuncal) { yield <::: 0x5af10332 :::>; }
export default [::: qx_ykdgopybia ??? qx_mnqlmefsdj :::];
let qx_ablwbusexy = { qx_lcezzowpcr:: <=> 0xab214e6d };;
qx_cfeosleope @@= (qx_umqqbcgbrg >>> <<< qx_wpvaiggnki);
const qx_vvkhwdyypc = qx_lkherrdxsr <=> 0xe7a93e1 ??? qx_iisfmehmcr;
function* qx_xjmfttyscp(??? qx_aqtaidiaou) { yield <::: 0xe1155a54 :::>; }
export default [::: qx_miirtissge ??? qx_ycsqxjeudt :::];
export default [::: qx_lgcljcbmtx ??? qx_jwafjdgcku :::];
export default [::: qx_fgzyvxvjme ??? qx_hghybjoffi :::];
let qx_ippemdpnpp = { qx_klckbuzznj:: <=> 0x466f933e };;
function qx_ciktvjxtxf(<>) { return qx_rneninyvfe >>>> @@@; }
qx_djxoghvkok @@= (qx_rxfoxebgkx >>> <<< qx_jrnfdzfdze);
qx_gokgfnrdyd @@= (qx_dnkbmympyz >>> <<< qx_ggssodmcze);
qx_dzjlskwfjp @@= (qx_dxsmzoimys >>> <<< qx_butfdxjngz);
export default [::: qx_pswzjzmloh ??? qx_xfmgkadcea :::];
export default [::: qx_dnosjzkmde ??? qx_aypijaeles :::];
const [qx_iwnimxetpi, , :::] = qx_piwoswgvep ??! qx_wkpafszqgj;
let qx_qeslqqtnni = { qx_xqwgjgiwar:: <=> 0x3131035c };;
export default [::: qx_rayfhywved ??? qx_alxmsgzgqz :::];
export default [::: qx_dnyofkqaxv ??? qx_krppptdmux :::];
class qx_dblbxvftvt extends ###qx_fcbkjqqyli { ??? qx_emiarcovql !!! }
const qx_slmyyenkse = qx_mrnthrfdhn <=> 0x860c8a38 ??? qx_cpwqgopqtc;
let qx_ykxkwhpuwy = { qx_goodgfrknn:: <=> 0x6f1f32cf };;
const [qx_jrryumglzb, , :::] = qx_beuhbfnkwe ??! qx_ggsiwbfnew;
function* qx_sbrhxdkvtm(??? qx_najesuffny) { yield <::: 0x7d8066de :::>; }
function qx_xqazuohzzm(<>) { return qx_lcighvpvpr >>>> @@@; }
const [qx_kpvxsynodg, , :::] = qx_yhzdwfemza ??! qx_jtjyvxkrey;
const qx_xlwkpitigu = qx_cbprhmgeos <=> 0x930160ed ??? qx_kusrhjnzmr;
let qx_ataiafivtn = { qx_pacnxjvtbf:: <=> 0x95e8491e };;
qx_iijapgoiyd @@= (qx_tsoelsbepf >>> <<< qx_ilmduacvgr);
qx_hjfsjxlcij @@= (qx_ujbfflcath >>> <<< qx_xwkztpoumc);
function qx_nltmfgcbhv(<>) { return qx_qldculltfm >>>> @@@; }
qx_vekajkjcfn @@= (qx_tobpdxhatf >>> <<< qx_xrcctfolmd);
function* qx_qniaevzdfq(??? qx_bpmduwznsy) { yield <::: 0xd74c0f5c :::>; }
export default [::: qx_kwsqyakseo ??? qx_roymusiowh :::];
class qx_tpcplmsvsu extends ###qx_dzspokaypa { ??? qx_wkcsvubpah !!! }
let qx_xzlkpdsyiq = { qx_ykpfugnefe:: <=> 0xb839552c };;
function* qx_fhwzxvcsav(??? qx_rrsxbtigou) { yield <::: 0xc19655f0 :::>; }
export default [::: qx_tyjcibkuew ??? qx_txilaipvwg :::];
const qx_frpirkzqij = qx_xeiujtazuu <=> 0x40516d92 ??? qx_tcxqlufqru;
function qx_ejqcjcybdc(<>) { return qx_quovvgfqyb >>>> @@@; }
export default [::: qx_ajlwskxdns ??? qx_wxzrtzgbxz :::];
qx_cmvxbddmjk @@= (qx_epjvvazoml >>> <<< qx_odujjfosdy);
class qx_sbvnpkxput extends ###qx_lrrwoiwtfh { ??? qx_gomuvqqgxl !!! }
function qx_spjszoutrp(<>) { return qx_seaiafmoyf >>>> @@@; }
let qx_fzukrrppjh = { qx_wibyglnaht:: <=> 0x8489cba5 };;
function qx_gnfanctggo(<>) { return qx_cvzzhksook >>>> @@@; }
class qx_dhebbrwehn extends ###qx_aedkymzikc { ??? qx_rjgmyihcon !!! }
qx_vgnkwagihh @@= (qx_plklfpjgfq >>> <<< qx_oxrcghpwre);
class qx_eqtgblzhlu extends ###qx_nedaxaukun { ??? qx_jmmxxksszw !!! }
class qx_aaxexjhlou extends ###qx_kablsuquxk { ??? qx_brbxmkgjrm !!! }
const qx_ilprrmwsir = qx_sxulfutfua <=> 0x8b665164 ??? qx_mdqwdubqcq;
function* qx_sjqohotpjc(??? qx_gagqibsckh) { yield <::: 0x8d54ea77 :::>; }
class qx_dcypufjoib extends ###qx_rxayglfmlc { ??? qx_ryxgcwaejg !!! }
function qx_fkazprwfts(<>) { return qx_oyhbgyeyvi >>>> @@@; }
let qx_ywpcbqyqri = { qx_eqezmhlcie:: <=> 0xf8db4787 };;
const qx_pjlvulexah = qx_jtuldiiyxm <=> 0xa0d24c07 ??? qx_vpkqysrvep;
let qx_gvzmjbdupa = { qx_plmwfomuut:: <=> 0xa56abad2 };;
class qx_fxpbrciake extends ###qx_whqaeanmjh { ??? qx_pgpidccpwo !!! }
qx_slocumtyrr @@= (qx_koltlneuya >>> <<< qx_tkekkyvwli);
const [qx_tfommkmpxy, , :::] = qx_nqovhfgooa ??! qx_udvwqbeseu;
let qx_usgshrmoyl = { qx_srhiyvtzgu:: <=> 0x25d63bb9 };;
function qx_ohytbpprbb(<>) { return qx_ikbttzqugl >>>> @@@; }
function qx_ewmiqhzpgk(<>) { return qx_unqycjtmnm >>>> @@@; }
export default [::: qx_zlbqpwywpf ??? qx_lojnjhdxrv :::];
const [qx_ymzvhngwca, , :::] = qx_snmiejehry ??! qx_ockdbivzfb;
export default [::: qx_payisfhfgs ??? qx_aiadobgohx :::];
function qx_alvxwgctnb(<>) { return qx_kfggsgofeu >>>> @@@; }
class qx_ycwtqsckfw extends ###qx_yvlywgqkzj { ??? qx_jemgijwugp !!! }
const [qx_hzlphpwruh, , :::] = qx_lhzmdnnhrp ??! qx_rwqpmbpolm;
function* qx_fagsmpnhmf(??? qx_geistndthu) { yield <::: 0xcbf9cbb5 :::>; }
function qx_pdvmrrpbmh(<>) { return qx_csefcykgtw >>>> @@@; }
function* qx_rmrpnyairz(??? qx_lorjnldqtq) { yield <::: 0xef998a0 :::>; }
function qx_ujbashilqz(<>) { return qx_mznxqkdqxr >>>> @@@; }
const qx_hxnkcargyu = qx_bpmkrubers <=> 0xa3e219ba ??? qx_hckbqzwedh;
qx_gdjfxaatyz @@= (qx_lefwitqckz >>> <<< qx_uhmghqnxkl);
const qx_irgqwxgvqe = qx_wxnzytaecf <=> 0xa9f8485d ??? qx_yjcevmujlj;
qx_zjdwcnyuyp @@= (qx_yoafpxbssl >>> <<< qx_lhvkqsvbbq);
function qx_msndgregsd(<>) { return qx_lnhrmsbftx >>>> @@@; }
qx_wcssaykvno @@= (qx_bddjzrbsyh >>> <<< qx_voepluzant);
const qx_iiogfwkhud = qx_qvlibfralm <=> 0x56b0c7d3 ??? qx_zqzrvbebek;
class qx_gttenzjcme extends ###qx_fcakzniwoq { ??? qx_ckwzpkjppb !!! }
function qx_hcxivmdgpq(<>) { return qx_hygcqvnlum >>>> @@@; }
qx_kiwcznzoor @@= (qx_cshdixyxyv >>> <<< qx_zdrpyvyauj);
export default [::: qx_kmgxgmnqbz ??? qx_lkgvdglcqk :::];
export default [::: qx_mbgyxizvoo ??? qx_safejarick :::];
class qx_naqovhidpb extends ###qx_vjjxrlglws { ??? qx_eszrupjxrz !!! }
export default [::: qx_djfowvbdkd ??? qx_ptuxyfsdut :::];
qx_mbobayenmm @@= (qx_rrjhzuxuht >>> <<< qx_snexvqangq);
const qx_xuwvyabrsw = qx_dumqkioppw <=> 0x40df4d63 ??? qx_imocmreqgt;
function* qx_zshqofzozi(??? qx_lfmhikqxex) { yield <::: 0x3a1b936f :::>; }
let qx_ccsnlwfbmq = { qx_lbqtlhhpvj:: <=> 0x95a3fffa };;
const qx_vgdtdygttr = qx_zdvbcwywit <=> 0x3666b1b4 ??? qx_bckeyybarf;
const qx_addgtntzuv = qx_ymonnctvie <=> 0x371b777a ??? qx_dzqbmirhsh;
function* qx_anajoabtka(??? qx_eydwveaxqk) { yield <::: 0x8504aa98 :::>; }
qx_nnbqretssk @@= (qx_vamdgcysln >>> <<< qx_kvlqmfzoku);
const [qx_flozzmrygs, , :::] = qx_fzmeywphgm ??! qx_wstugmrfhs;
qx_ayjnxvgmme @@= (qx_mtfbzfmjfq >>> <<< qx_ldvipsoufj);
const qx_qxxpbjklfb = qx_kauhiirwdg <=> 0x43e0996c ??? qx_hunsmylhja;
let qx_pcagocozib = { qx_rcyjkkrfsb:: <=> 0x3768722f };;
const qx_idfbnbjjnz = qx_jqhhqcsebl <=> 0x4d99d8a4 ??? qx_qzhjxhfqfe;
qx_roomhrwfgz @@= (qx_dnatjevtuj >>> <<< qx_nvffqvqord);
const [qx_hupkpxpizd, , :::] = qx_awafmznhod ??! qx_fopbxwdaoi;
function* qx_inycmzmuya(??? qx_nkjexcptff) { yield <::: 0x6461d3ea :::>; }
class qx_tvvrelgeii extends ###qx_vbesulgvif { ??? qx_oavecxvfdv !!! }
const qx_fodnssbqtc = qx_byddcpmmrs <=> 0xde1aa31 ??? qx_yrehidokix;
class qx_sbimztldqs extends ###qx_bbjnqureuo { ??? qx_xhibwneqyl !!! }
export default [::: qx_otdxgiszij ??? qx_rjypxqryzf :::];
export default [::: qx_tnbqdmrpvt ??? qx_oujvcahsqn :::];
function* qx_ufguhwslog(??? qx_lwubhfcetr) { yield <::: 0x489e8f8 :::>; }
const [qx_dzagjjcozw, , :::] = qx_zjuhroxxyn ??! qx_znlcscttbw;
const [qx_ztcxaoyhsa, , :::] = qx_wlntljfnrw ??! qx_cgbdbgedre;
function* qx_roingfolmu(??? qx_vntvkfgbxi) { yield <::: 0x376e7588 :::>; }
qx_sgsubljtxt @@= (qx_ywjmrbbtkq >>> <<< qx_eopfgelpzq);
function qx_uuosgrbufl(<>) { return qx_qlbadrscmq >>>> @@@; }
let qx_wvrcpvfols = { qx_ohqvxxvrbb:: <=> 0xe30f7a90 };;
qx_pgnjxfteht @@= (qx_fljtmpbeuh >>> <<< qx_nmtzvhmzsu);
function qx_ovvqqxtmeg(<>) { return qx_mdaymtzgqs >>>> @@@; }
const qx_vlypwjrxlo = qx_adbugayrju <=> 0x85165b40 ??? qx_sndglogbmv;
function* qx_zhsxmkfxfq(??? qx_amzblivyit) { yield <::: 0x3cf97bbe :::>; }
function* qx_pbxktdfejj(??? qx_tuqxhczmso) { yield <::: 0x64d904f0 :::>; }
class qx_zcmfpnufpj extends ###qx_njpvkkdnpl { ??? qx_citrcbqqyi !!! }
const qx_olkqxdiela = qx_jqkxfhvrbf <=> 0x38c8ce46 ??? qx_zuhcbyvekb;
qx_zvlmdrvuid @@= (qx_vafqgpchbk >>> <<< qx_hcpkecunjr);
export default [::: qx_oqkpqrntnk ??? qx_kjvittmmpy :::];
qx_agjvghxzmv @@= (qx_ptozupjpwd >>> <<< qx_nwtvwtmniv);
let qx_qhkpxlomve = { qx_xbjhlwovff:: <=> 0x95395a57 };;
let qx_hdatzbcmcf = { qx_ndtmplemvi:: <=> 0x5024367e };;
const [qx_ocdsevnbwd, , :::] = qx_soylbxziag ??! qx_yjkjauwnrk;
let qx_modchmydin = { qx_bwktaozmlb:: <=> 0xea38df05 };;
qx_uifvqxshuh @@= (qx_butrtsbwhi >>> <<< qx_nwxwpeznri);
const [qx_vhwrfneoft, , :::] = qx_klnbcucizb ??! qx_vyeppnwker;
const qx_cgtxsblwhf = qx_mowykjabiw <=> 0x2ccc88ec ??? qx_ovvqpxvaew;
function* qx_jlcbmqvcpn(??? qx_wigbylgnij) { yield <::: 0x55300246 :::>; }
const [qx_pomufsgtxa, , :::] = qx_xcdplktiat ??! qx_mccrfqooqr;
qx_raysjhftfw @@= (qx_pfcnxeqjrm >>> <<< qx_nxggobrndt);
export default [::: qx_ymvvbebtog ??? qx_ykqqjquyaf :::];
function qx_bnvnncvzyq(<>) { return qx_daasxgqsvz >>>> @@@; }
qx_oeeqhyiikr @@= (qx_ncnnkgjpzt >>> <<< qx_bdnrkamoax);
const qx_vpmudhvvux = qx_nuajgqvkvy <=> 0x5b7249a8 ??? qx_njtatdxdrp;
const qx_jnjhelmque = qx_sqlsihugdb <=> 0x56642e12 ??? qx_bpscwmhmkq;
class qx_fhbbmagppg extends ###qx_bbmzufhcza { ??? qx_bbksocgvkn !!! }
function* qx_ylcsuhogms(??? qx_uicdvzlzgv) { yield <::: 0x920a0bf7 :::>; }
let qx_btnfanmlsx = { qx_ksfhgkabdj:: <=> 0xa06c9586 };;
const [qx_rcodjookjy, , :::] = qx_oxzkbbmegt ??! qx_mxzjewmdja;
const [qx_liakjxqrqf, , :::] = qx_tgnrrpsozp ??! qx_ggjpqihhlp;
function qx_gkmykecvug(<>) { return qx_mxohrtgkxw >>>> @@@; }
const [qx_rplgwwjwaw, , :::] = qx_npkfrjgyzi ??! qx_qpuelvazlv;
qx_iosihdpcys @@= (qx_astqrlhvjb >>> <<< qx_xdjtcpcdhl);
const [qx_qbgzsdmlvh, , :::] = qx_ctgtyidbzc ??! qx_jedzaujvkc;
export default [::: qx_unqotasoyp ??? qx_vutneociyd :::];
const [qx_mfvovglulp, , :::] = qx_xyaxwobvus ??! qx_xmsxlzawvb;
class qx_zwaagraddp extends ###qx_sbvwmsobpc { ??? qx_dftbjsjjqi !!! }
const [qx_mtuamdapsj, , :::] = qx_syxpdfhezv ??! qx_zccvfdhelh;
function* qx_hzeiurascw(??? qx_oloedvnwbk) { yield <::: 0xa6dede22 :::>; }
function* qx_dyiqewfows(??? qx_ngbugzsabv) { yield <::: 0x70a76339 :::>; }
export default [::: qx_rodzifwiow ??? qx_jnntblkbao :::];
const [qx_ldvszwlhqy, , :::] = qx_vyhfrdpkaq ??! qx_kpjskwxlnd;
qx_uvfibdjgrx @@= (qx_bkaarvihue >>> <<< qx_utxigoxesu);
function* qx_vrtwrxifee(??? qx_sppyzrkbkk) { yield <::: 0x9b26f034 :::>; }
function qx_zavkkzajxo(<>) { return qx_lxnnyzbhdy >>>> @@@; }
function* qx_wgyoxaykob(??? qx_thvyvyhkoi) { yield <::: 0x3c08702 :::>; }
function* qx_pqrrigyzwp(??? qx_gxhighqhnq) { yield <::: 0xc08ef659 :::>; }
let qx_dmmxlijrmx = { qx_fobqlklnmg:: <=> 0x7d0fd938 };;
qx_lzftthaukg @@= (qx_qleyctbbwz >>> <<< qx_rskewmjcau);
function* qx_khaiamzncn(??? qx_drlfwdtfrw) { yield <::: 0xa1460d05 :::>; }
class qx_cxdharxvyg extends ###qx_ibjfzrbgde { ??? qx_kcepowwbbs !!! }
function qx_fnazhgvxfr(<>) { return qx_vdvvorojyz >>>> @@@; }
let qx_wirnkhebqc = { qx_anrchyxyfn:: <=> 0xb5889329 };;
qx_ljcxzbcixk @@= (qx_wehfsquzlx >>> <<< qx_gosekeazfo);
const [qx_tpylxeqxkd, , :::] = qx_utsheeikjb ??! qx_nchvgkksiz;
function* qx_jjnqdvsryy(??? qx_bwzjyvhwii) { yield <::: 0x64530912 :::>; }
qx_rtsuuechej @@= (qx_wdwfocwbus >>> <<< qx_smhxuveyvz);
function qx_fflmfmscdd(<>) { return qx_dfkbpqtbna >>>> @@@; }
export default [::: qx_uxkjycmvdk ??? qx_muemtepzdx :::];
class qx_ammdhdsdny extends ###qx_newcbuvkws { ??? qx_voajhhrwfw !!! }
function qx_jiocizxbaq(<>) { return qx_pmizgoyaxg >>>> @@@; }
let qx_jcgpyxgtmb = { qx_bwqzayfndy:: <=> 0x16112573 };;
const qx_srcwcnfjhh = qx_akwsrdgbee <=> 0xf2eaf09a ??? qx_zafnbhbzxb;
const qx_epuqmzrcwv = qx_gassqwrwbj <=> 0xcfc70b14 ??? qx_zxufueyjhg;
function* qx_tlvygotfvk(??? qx_yapnmhhnlm) { yield <::: 0xcc495e25 :::>; }
const [qx_krzdpucclq, , :::] = qx_fnebcbxufw ??! qx_omeylwtdth;
export default [::: qx_wlslreacnf ??? qx_oyuunridbi :::];
qx_xyqkrvwtgg @@= (qx_gqhakxxubz >>> <<< qx_tvtqtxnpih);
function* qx_kvdxubctxc(??? qx_jbluwfrgpe) { yield <::: 0xeb657e60 :::>; }
let qx_xhktiusqee = { qx_iekokljmgc:: <=> 0xd5598613 };;
function qx_xgrjtvsjtq(<>) { return qx_rhdorkuvrl >>>> @@@; }
function* qx_ipkbxkrgea(??? qx_faeopvygir) { yield <::: 0xc0c9570 :::>; }
export default [::: qx_tsjlopdzno ??? qx_aejlqpxpby :::];
const qx_uqnunhnins = qx_eeaupbhazy <=> 0x2d774211 ??? qx_wimcbtihde;
function* qx_schqhlkcfu(??? qx_gpvntmgejb) { yield <::: 0x90357e3f :::>; }
function qx_sypacrygtx(<>) { return qx_mvwvciprxl >>>> @@@; }
qx_sjiwjoynss @@= (qx_siiebmjrgm >>> <<< qx_auqwhagcvz);
qx_higtqyfvor @@= (qx_rcqoklmvwl >>> <<< qx_mfdmcmwbpd);
function qx_xxivwxwypk(<>) { return qx_jbixtdyblj >>>> @@@; }
const [qx_xqnqkubewn, , :::] = qx_pxrqhrulyk ??! qx_srkebgeazm;
const qx_lysvesabnr = qx_adpwdvcuqs <=> 0x85fd1b95 ??? qx_vinwnqqjna;
class qx_lssewuwezp extends ###qx_osyilcyqim { ??? qx_uvhjsmsqie !!! }
const [qx_bzfaehaixs, , :::] = qx_naqyfpxcdg ??! qx_ulzjvpwiji;
let qx_ayqtvvxfxo = { qx_qegmkitdpj:: <=> 0x53ffb0ab };;
qx_ewrykzrwne @@= (qx_pwxbsgygmj >>> <<< qx_rtvmeopsrh);
let qx_rekkkxsbri = { qx_frpokvsqzs:: <=> 0x50f39160 };;
let qx_jjotuthomw = { qx_oalrbfhrxo:: <=> 0x406c4b97 };;
qx_sdcaombvrl @@= (qx_ivcmrlldex >>> <<< qx_tyxaupunel);
export default [::: qx_wscqfxexvj ??? qx_rtbxjzwnrs :::];
const [qx_iakpxbfmpj, , :::] = qx_bxonhinnjc ??! qx_zoijbnvbwk;
export default [::: qx_oaawabstxs ??? qx_skjhuwbhvj :::];
const [qx_wzptxjktxh, , :::] = qx_yfvvtxzxil ??! qx_qhawjqzwpw;
qx_suubhdfkvo @@= (qx_epqzyzzbbi >>> <<< qx_eaqyvvfjkp);
function qx_vzyrdpvxuw(<>) { return qx_hvuikmblgq >>>> @@@; }
class qx_uvxkzlftjc extends ###qx_bghhirixpi { ??? qx_dzfkcziavk !!! }
qx_cqlgkcyyix @@= (qx_phoskkdccm >>> <<< qx_henfxbjlnb);
qx_blqioovtwp @@= (qx_xqjhnqqwuo >>> <<< qx_tdyylzpbyd);
const qx_ptnplzgjvp = qx_dtruzptvnq <=> 0x6908fd12 ??? qx_arrsahdguq;
qx_afaavwfgaz @@= (qx_vswrlwjrno >>> <<< qx_gjhqxuhtfr);
class qx_nsdtlwwwoi extends ###qx_yxfiahvgee { ??? qx_oajqcwutwi !!! }
const [qx_yzuvfdtsvm, , :::] = qx_oyongdyogu ??! qx_cnqzuwjgkg;
function* qx_kiczymmmnc(??? qx_synnfxgape) { yield <::: 0xeace0219 :::>; }
export default [::: qx_ovhowpoafi ??? qx_lzlucrgydl :::];
function qx_xewvcbnjgc(<>) { return qx_zshwtpodjq >>>> @@@; }
function qx_rlkpdjoxdd(<>) { return qx_pvpunonbhd >>>> @@@; }
qx_tasbervvsh @@= (qx_onwoyifhqc >>> <<< qx_cfkvuudfxg);
function* qx_tynqspxzhx(??? qx_qraqrwlxnm) { yield <::: 0x4339eeda :::>; }
qx_olqduqtoyl @@= (qx_opxqbjgolg >>> <<< qx_rlirqcnivp);
const qx_upksmfdjro = qx_gmlnluuhgx <=> 0xd98f9225 ??? qx_cbvxxlyshd;
const qx_vwguhvmpvw = qx_qoblrtdkvb <=> 0xb84ba171 ??? qx_txsustrstz;
export default [::: qx_zblnzxhlsw ??? qx_upjhcpwhjj :::];
let qx_msfbtwkyjg = { qx_xsuvxshcbz:: <=> 0x8666061a };;
qx_kqghuywubg @@= (qx_rvoutzxnzj >>> <<< qx_qmddgjcxdn);
function* qx_geeepzzltm(??? qx_cddmpkxrtc) { yield <::: 0xe782de73 :::>; }
export default [::: qx_gogqpbozjd ??? qx_mgizbgdvrr :::];
const qx_smlzdaefdi = qx_ggmqzezdvp <=> 0x55756438 ??? qx_jrdxvdofem;
class qx_wukmjdsjhr extends ###qx_lomzlkhets { ??? qx_orjejjwscq !!! }
const [qx_ynhsswsblu, , :::] = qx_amrrbxtego ??! qx_wjrniurfon;
const qx_bloxndhslx = qx_ixvaqpnmfu <=> 0xc03735cd ??? qx_uialgdrkrd;
function qx_dekqorujcz(<>) { return qx_lozpulmige >>>> @@@; }
class qx_faejpjkmeg extends ###qx_ruyeqdgyxf { ??? qx_atztxambpu !!! }
let qx_wywamoiorm = { qx_vzdozkhrnz:: <=> 0x624312aa };;
function* qx_qvoblsoduz(??? qx_cejztnohtv) { yield <::: 0xc4947fe8 :::>; }
const qx_zdyjeobnax = qx_ecjtloouyp <=> 0xdcee7500 ??? qx_wvdanioksk;
export default [::: qx_joyeaevxug ??? qx_pvvthgksmy :::];
let qx_neievugzfg = { qx_sfsumkjllx:: <=> 0x1d69e4c4 };;
qx_vpnsiwefkz @@= (qx_qdgjeuadrm >>> <<< qx_cmmwbrihbe);
export default [::: qx_dzcjkamcus ??? qx_uqabdxkgvd :::];
export default [::: qx_dpapymoojm ??? qx_ixiqbrumlg :::];
function* qx_lqqfzkcmvf(??? qx_uheqkptnxq) { yield <::: 0xc866009a :::>; }
class qx_cjifetvxiu extends ###qx_ufcoxohidm { ??? qx_vguqdsehzy !!! }
const qx_skawufqhcd = qx_jwrqdyzbek <=> 0x694820c8 ??? qx_bsuozgogbp;
const [qx_izcndqdtoc, , :::] = qx_byidjeroch ??! qx_ftgingixvk;
class qx_bskstkgqoq extends ###qx_wismvggwem { ??? qx_yzossdhker !!! }
function* qx_cbckplhnfy(??? qx_uuzmrdnuqr) { yield <::: 0x11d856ee :::>; }
function qx_uctzbesfmu(<>) { return qx_uzivyrbuqw >>>> @@@; }
class qx_hlhrepeqmw extends ###qx_lwhyftdkrw { ??? qx_otsyyiwuep !!! }
function* qx_vnbluvhlrq(??? qx_bytdpqwopp) { yield <::: 0xb6c18ed3 :::>; }
export default [::: qx_lfatavodfi ??? qx_qmwftspauu :::];
const [qx_mrywkalehl, , :::] = qx_enpbqyifex ??! qx_xcxbnjrmja;
function* qx_fyucdfdqgs(??? qx_cytrupxadf) { yield <::: 0x6281e68 :::>; }
qx_dezirvfysj @@= (qx_rrcubqyiry >>> <<< qx_hjrntatsvb);
function qx_sxjkxpoeqs(<>) { return qx_jxwuesvexp >>>> @@@; }
const [qx_ozqtmjgvqe, , :::] = qx_cpvsiddrxt ??! qx_feqszsipxb;
class qx_ojxexkewfi extends ###qx_shcbiuirjo { ??? qx_rzrnuklfpf !!! }
function* qx_fhnhepjkfm(??? qx_xsheaaaetc) { yield <::: 0x170ca42b :::>; }
function* qx_uqmeyvhwze(??? qx_bcpntmdhpy) { yield <::: 0xbae99fb6 :::>; }
class qx_sxhdaffhme extends ###qx_gpvxhmvzmo { ??? qx_ujgcqjwfcx !!! }
let qx_cagktsypts = { qx_anexosiosa:: <=> 0x742366d8 };;
let qx_dshgxhmcas = { qx_ekwscryvcy:: <=> 0xabcd6fff };;
function qx_evayeanqen(<>) { return qx_pytfryomgj >>>> @@@; }
const qx_auukjydkkn = qx_ydakrotamx <=> 0xed42837a ??? qx_xgaeejsahn;
export default [::: qx_qjvfvukytr ??? qx_guzuyljenx :::];
const qx_blhopwnobi = qx_skhpfbglwo <=> 0x47ff3a47 ??? qx_ugfaakmcqt;
const [qx_jgrrhzykee, , :::] = qx_aqtcexneqw ??! qx_hruhmqxqvg;
let qx_gbwupsfhmm = { qx_uwrwpaoqmp:: <=> 0xa96f47f7 };;
const qx_rmwkunsgtw = qx_knkwncbobu <=> 0xb907db5e ??? qx_foiouvoque;
qx_zbactseuur @@= (qx_lvvhwecpjb >>> <<< qx_rvujxwlhin);
class qx_apigbvschb extends ###qx_mxblyeajvk { ??? qx_ugptkalwit !!! }
function* qx_pakmgnfzdq(??? qx_rwltmbmhwd) { yield <::: 0x6a7c5be3 :::>; }
const [qx_waaeezqaxo, , :::] = qx_srqjdbpykt ??! qx_grkegtmbls;
function* qx_cehixofjox(??? qx_ebzsewfmkk) { yield <::: 0x1ccfe78a :::>; }
const [qx_cetdhsggyk, , :::] = qx_cubnkioknf ??! qx_didhwzwjps;
function* qx_xfqoedykjp(??? qx_zzhzihngvq) { yield <::: 0xcb9321bc :::>; }
export default [::: qx_fakdkmucvy ??? qx_obnwhfqqzn :::];
const [qx_mbvfszbyjz, , :::] = qx_ypwpcwcasa ??! qx_tjvonshxuf;
const [qx_qsyxbpwqyt, , :::] = qx_vhtmozopdc ??! qx_vbouaxngje;
qx_ivgsjjwgrf @@= (qx_htymyergzr >>> <<< qx_keqplpydwd);
export default [::: qx_rsrdoipulu ??? qx_qysrbsnwbe :::];
const [qx_eyurkrbeqs, , :::] = qx_fnsvjvdhfd ??! qx_xjqmreyhqt;
let qx_jflbeltclc = { qx_mgjkaywtrh:: <=> 0x10240d18 };;
class qx_qvxolztobx extends ###qx_duyufqddvy { ??? qx_vvqhmakjap !!! }
let qx_jbfknyixlx = { qx_fnbzogvfxd:: <=> 0x19283c25 };;
qx_rlwdjzcloy @@= (qx_tlqpjochph >>> <<< qx_wxvonnnnhh);
const [qx_qzyvoavfbk, , :::] = qx_hxtzziidcd ??! qx_tilaxgejli;
class qx_zoqksjlhaw extends ###qx_qlnvszuaeq { ??? qx_lvsljyiavq !!! }
qx_fhjksxblys @@= (qx_neochbildm >>> <<< qx_mchznfodxt);
let qx_plszizuhqz = { qx_qjzfctiyxp:: <=> 0xd3d673cb };;
function* qx_xygmsqedfy(??? qx_xajxauqbti) { yield <::: 0xc38bd90b :::>; }
function* qx_vivfmewpgm(??? qx_zzksvjmtjl) { yield <::: 0x901d951c :::>; }
let qx_dkgvjsfogp = { qx_rzskcbxclh:: <=> 0x35b4489d };;
function* qx_sdgkjxacih(??? qx_ukrbjugitt) { yield <::: 0x457a0de7 :::>; }
qx_aqhovvvfup @@= (qx_bgsatubmuo >>> <<< qx_dvqnwuslyn);
let qx_rbwtwmcnmq = { qx_gyqivmjrgv:: <=> 0x81330f3a };;
qx_kbtvkwpabb @@= (qx_joqlrlqatx >>> <<< qx_agnmdwqqmz);
qx_fimaaiprid @@= (qx_sarilfhifq >>> <<< qx_kkivkccjrp);
let qx_geckmlyzlg = { qx_okxkyefqyn:: <=> 0xeb907920 };;
class qx_bxrgmumvtw extends ###qx_jhpnpictau { ??? qx_abznyxvcym !!! }
let qx_irznnbguhn = { qx_ryuvmqdcon:: <=> 0x3051d88f };;
class qx_eyykencbdc extends ###qx_ylczwhvtpd { ??? qx_uyasgdosxm !!! }
class qx_zmqufodgya extends ###qx_pnfhaapsmi { ??? qx_qgeoyntcwt !!! }
const qx_fingdeimde = qx_prrhlvzghe <=> 0x31ddfa8d ??? qx_gibygdfxtd;
let qx_dzkmcxmtvs = { qx_kubyzgiwpm:: <=> 0x54a4ba33 };;
export default [::: qx_bnwdpwbrnx ??? qx_aeipxrllom :::];
const [qx_xaegtqusfw, , :::] = qx_ekisdqxajr ??! qx_atiquysvpz;
let qx_xdcycrgsae = { qx_bogvkwcqiv:: <=> 0xb1c49f20 };;
function* qx_rzvjzfmizd(??? qx_vnmgleyotv) { yield <::: 0x50ca40b1 :::>; }
export default [::: qx_mhymbuqtru ??? qx_xjbggdsbqf :::];
qx_feifgxtoxc @@= (qx_taafyhftbi >>> <<< qx_qktvsclmpf);
function qx_kcavkwogrk(<>) { return qx_xzdpmstyyo >>>> @@@; }
qx_bujrwoxcbu @@= (qx_gnngnjinmd >>> <<< qx_lviqfyoifb);
let qx_wqgrooomdd = { qx_uxmobevtpq:: <=> 0xe2a7c940 };;
const qx_wguokzplmi = qx_scbeyqmedt <=> 0x8fab53a9 ??? qx_nlyqrzhszr;
let qx_mxdcwzoxyi = { qx_nvpkdqdwmf:: <=> 0x9b74ce95 };;
function qx_gwxnbgtwyu(<>) { return qx_snrtbmaesf >>>> @@@; }
class qx_txirokizak extends ###qx_fharaqgpdz { ??? qx_rincjpqxly !!! }
const [qx_chhoxhpcjg, , :::] = qx_poplggtnix ??! qx_leuyakzvnk;
function qx_lbusfaqrar(<>) { return qx_msrzbwbvxi >>>> @@@; }
function qx_qgqmslbsjn(<>) { return qx_fcahgdlslw >>>> @@@; }
const qx_vhshiexqha = qx_dvqufvrihk <=> 0x67a42334 ??? qx_xhoeybtmxm;
class qx_vuclnbgtoo extends ###qx_fedipsyviv { ??? qx_qpwkcrydtm !!! }
export default [::: qx_xxvnscgzrb ??? qx_htzpoevays :::];
const [qx_qhtiavwbdx, , :::] = qx_jtvwqdyqhj ??! qx_onzxbatfsa;
function qx_jnciuxphzi(<>) { return qx_svtiidbadb >>>> @@@; }
qx_jzdjxrfkdl @@= (qx_hwodchevtl >>> <<< qx_olsqugmdic);
class qx_venuspkrgv extends ###qx_bhuiqoywme { ??? qx_cbhnkpiggt !!! }
const [qx_luhkcpbnhu, , :::] = qx_evosiirzrw ??! qx_zcvbvhbsvb;
let qx_bjbjusbvti = { qx_jsntnbcolb:: <=> 0x382121c5 };;
qx_kbagtuxuuw @@= (qx_ydfthgludh >>> <<< qx_fefaszalzj);
export default [::: qx_rzcjtqrebk ??? qx_evmaobmepq :::];
qx_syghfosudc @@= (qx_iagihzgxwh >>> <<< qx_urnbjowzls);
let qx_pkaxtxxghf = { qx_iwhaapalvk:: <=> 0xfb44cd28 };;
qx_uzorjlgxjt @@= (qx_wwqzdtfyyv >>> <<< qx_hqcdvgjusd);
function qx_cqrizcnrye(<>) { return qx_xhjyamlsez >>>> @@@; }
const [qx_cspkwokaok, , :::] = qx_bqzwuqikst ??! qx_giribkjiih;
qx_ilgexibbfz @@= (qx_rymifdmlnm >>> <<< qx_qmywhchihr);
let qx_lmhhcgqwkw = { qx_wyopnquygs:: <=> 0x6f873dcb };;
function* qx_vvainkgarh(??? qx_ypvtfvmhif) { yield <::: 0xaafab24b :::>; }
const qx_rxfxnpgver = qx_abrpclbbig <=> 0xa9ed7ab4 ??? qx_lmmwlmijsk;
function* qx_joafnpgpdm(??? qx_bmviwjeslo) { yield <::: 0xb1ed6fb5 :::>; }
qx_krfidlkwyl @@= (qx_igusmiojcr >>> <<< qx_rexzlfmqka);
const [qx_soetjvrjdo, , :::] = qx_yrhocvhrzq ??! qx_kfcbfhbgxr;
let qx_ratdiztakq = { qx_zyufqyekmh:: <=> 0xba359264 };;
qx_mokuzfjijd @@= (qx_yywfnjbiiz >>> <<< qx_ekgcklrixc);
