/**
 * Projectiles — everything a weapon puts on screen, and every hit it lands.
 *
 * WHAT THIS IS, IN PLAIN TERMS
 * A whip crack, a homing knife, a spinning bible, a thrown axe and a garlic aura are the same thing
 * to the engine: a shape that exists for a while, moves in one of six ways, and hurts enemies it
 * overlaps. Building it once means a new weapon is a row of numbers, not new code — which is how we
 * get to forty weapons without forty bugs.
 *
 * THE SIX WAYS A THING CAN MOVE
 *  - sweep   — a slash pinned to the player that arcs through a short swing. Whips, swords.
 *  - homing  — flies at the nearest enemy and keeps correcting. Knives, magic missiles.
 *  - straight— fired in a direction and keeps going. Volleys, bolts.
 *  - arcing  — thrown, pulled down by gravity, lands. Axes, bottles.
 *  - orbiting— circles the player at a fixed distance forever. Bibles, halos.
 *  - aura    — sits on the player and ticks damage on everything inside it. Garlic, holy water pools.
 *
 * WHY IT LOOKS LIKE THIS
 *  - Fixed pools, parallel arrays, zero allocation. A Limit-Break screen has well over a thousand
 *    of these alive at once on a 4GB phone; allocating even one object per projectile per tick is
 *    what turns a 60fps game into a stuttering one.
 *  - Every projectile remembers the last few enemies it hit, so a piercing knife cannot hit the same
 *    shambler eight times as it passes through, while an aura deliberately forgets on a timer so it
 *    re-ticks. That memory is a fixed-size ring per projectile, not a list.
 *  - Hits are written into a flat event buffer rather than reported through callbacks. Damage
 *    numbers, XP gems, screen shake and sound all read the same buffer once per tick. Callbacks
 *    would mean closures, and closures mean allocation.
 *  - Randomness (crits, damage variance) comes only from the seeded streams, never `Math.random`,
 *    because co-op and replay both resimulate this exact code and must land on the same numbers.
 */

import { EntityPool, handleSlot, NULL_HANDLE, POOL_BUDGETS, type Handle } from "../core/pool";
import type { Rng } from "../core/rng";
import { ENEMY_FLAG, type EnemyStore } from "./enemies";
import { STAT, STAT_SCALE, type Stats } from "./stats";

/** How a projectile moves. Append-only: written into replay and co-op event streams. */
export const MOVE = {
  /** Pinned to the owner, swinging through an arc. Whips, swords, claws. */
  sweep: 0,
  /** Steers toward the nearest enemy. Knives, missiles. */
  homing: 1,
  /** Fired once in a direction and never turns. Volleys, bolts. */
  straight: 2,
  /** Thrown, with gravity. Axes, bottles. */
  arcing: 3,
  /** Circles the owner at a fixed distance. Bibles, halos. */
  orbiting: 4,
  /** Sits on the owner and ticks. Garlic, pools. */
  aura: 5,
} as const;

export type MoveKind = (typeof MOVE)[keyof typeof MOVE];

/** Behaviour switches on a single projectile. */
export const PROJ_FLAG = {
  /** Dies the instant it lands a hit, regardless of pierce. */
  fragile: 1 << 0,
  /** Forgets what it has hit on a timer, so it damages the same enemy again. Auras, orbiters. */
  reticks: 1 << 1,
  /** Cannot crit. Used by chip-damage auras so the damage numbers stay readable. */
  noCrit: 1 << 2,
  /** Does not knock enemies back. Keeps aura weapons from shoving the horde out of their own range. */
  noKnockback: 1 << 3,
  /** Passes through walls and props. Reserved for stages with blocking geometry. */
  ghost: 1 << 4,
  /** Bounces off the arena edge instead of expiring. */
  bouncy: 1 << 5,
  /** Turns around at the halfway point of its life and comes back. Boomerangs, crosses. */
  returns: 1 << 6,
  /** Belongs to an enemy, not a player. Enemy bullets share this whole system. */
  hostile: 1 << 7,
} as const;

/** World units per second, per second, applied to arcing throws. */
export const GRAVITY = 260;

/**
 * How many recent victims one projectile remembers.
 *
 * Eight is deliberate. A piercing knife realistically touches three or four enemies on its way
 * through a crowd; eight covers the tail without turning the store into a memory hog (1536
 * projectiles x 8 slots is 48KB, allocated once). If a projectile does overflow its memory it
 * simply forgets its oldest victim, which at worst re-damages an enemy it hit long ago — a far
 * better failure than allocating a list mid-frame.
 */
export const HIT_MEMORY = 8;

/** Default ticks between re-ticks for a `reticks` projectile. Half a second. */
export const DEFAULT_RETICK_TICKS = 30;

/** Broad-phase candidates examined per projectile per tick. */
const QUERY_LIMIT = 64;

/** Hit events surfaced per tick. Beyond this, damage still lands but stops being narrated. */
export const MAX_HIT_EVENTS = 512;

/** Kills surfaced per tick, for gem drops. */
export const MAX_KILL_EVENTS = 512;

const TICK_SECONDS = 1 / 60;

/** Full circle in the integer angle unit used for orbit and sweep. */
export const BRAD_FULL = 4096;

/**
 * Everything needed to put one projectile into the world.
 *
 * A plain interface, reused as a single scratch object by the weapon code rather than constructed
 * per shot — see `SpawnRequest` usage in `weapons.ts`.
 */
export interface SpawnRequest {
  move: MoveKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  radius: number;
  ttl: number;
  pierce: number;
  owner: number;
  weapon: number;
  flags: number;
  knockback: number;
  /** Orbit/sweep angle, in 4096ths of a turn. */
  angle: number;
  /** Angle change per tick, in 4096ths of a turn. Signed. */
  angularVel: number;
  /** Distance from the owner for orbiting and sweeping shapes. */
  anchorDist: number;
  gravity: number;
  retick: number;
  /** Atlas frame index. Purely visual; the sim never reads it. */
  sprite: number;
}

/** A fresh spawn request with every field at a harmless default. */
export function createSpawnRequest(): SpawnRequest {
  return {
    move: MOVE.straight,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    damage: 1,
    radius: 8,
    ttl: 60,
    pierce: 0,
    owner: 0,
    weapon: 0,
    flags: 0,
    knockback: 0,
    angle: 0,
    angularVel: 0,
    anchorDist: 0,
    gravity: 0,
    retick: DEFAULT_RETICK_TICKS,
    sprite: 0,
  };
}

/**
 * The owner's position, supplied per tick. Anything pinned to a player (sweeps, orbiters, auras)
 * needs to follow them, and the projectile store must not import the player store — the dependency
 * runs the other way for co-op, where positions may come off the wire instead.
 */
export interface OwnerPositions {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

export class ProjectileStore {
  readonly pool: EntityPool;
  readonly capacity: number;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Damage per hit, already scaled by the owner's might when the shot was fired. */
  readonly damage: Float32Array;
  readonly radius: Float32Array;
  readonly ttl: Int32Array;
  readonly pierceLeft: Int32Array;
  readonly owner: Uint8Array;
  readonly weapon: Uint8Array;
  readonly move: Uint8Array;
  readonly flags: Int32Array;
  readonly knockback: Float32Array;
  readonly angle: Int32Array;
  readonly angularVel: Int32Array;
  readonly anchorDist: Float32Array;
  readonly gravity: Float32Array;
  readonly retick: Int32Array;
  readonly retickTimer: Int32Array;
  readonly sprite: Uint8Array;
  /** Ticks lived. Drives sweep progress, return timing and animation. */
  readonly age: Int32Array;
  /** Life at spawn, kept so a sweep knows where it is in its swing. */
  readonly life: Int32Array;

  /** Ring of recently-hit enemy handles, HIT_MEMORY per projectile. */
  private readonly hitMarks: Int32Array;
  private readonly hitCursor: Uint8Array;

  private readonly candidates = new Int32Array(QUERY_LIMIT);

  // --- Per-tick event buffers, consumed by damage numbers, gems, sound and shake -------------
  hitCount = 0;
  readonly hitX = new Float32Array(MAX_HIT_EVENTS);
  readonly hitY = new Float32Array(MAX_HIT_EVENTS);
  readonly hitAmount = new Float32Array(MAX_HIT_EVENTS);
  readonly hitCrit = new Uint8Array(MAX_HIT_EVENTS);
  readonly hitWeapon = new Uint8Array(MAX_HIT_EVENTS);

  killCount = 0;
  readonly killX = new Float32Array(MAX_KILL_EVENTS);
  readonly killY = new Float32Array(MAX_KILL_EVENTS);
  readonly killType = new Uint8Array(MAX_KILL_EVENTS);

  /** Run totals for the results screen. */
  totalDamage = 0;
  totalHits = 0;
  totalKills = 0;
  /** Shots the pool refused. Non-zero late in a Limit Break run is expected, not a bug. */
  refused = 0;

  constructor(capacity: number = POOL_BUDGETS.projectiles) {
    this.capacity = capacity;
    this.pool = new EntityPool(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.ttl = new Int32Array(capacity);
    this.pierceLeft = new Int32Array(capacity);
    this.owner = new Uint8Array(capacity);
    this.weapon = new Uint8Array(capacity);
    this.move = new Uint8Array(capacity);
    this.flags = new Int32Array(capacity);
    this.knockback = new Float32Array(capacity);
    this.angle = new Int32Array(capacity);
    this.angularVel = new Int32Array(capacity);
    this.anchorDist = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.retick = new Int32Array(capacity);
    this.retickTimer = new Int32Array(capacity);
    this.sprite = new Uint8Array(capacity);
    this.age = new Int32Array(capacity);
    this.life = new Int32Array(capacity);
    this.hitMarks = new Int32Array(capacity * HIT_MEMORY);
    this.hitCursor = new Uint8Array(capacity);
  }

  get count(): number {
    return this.pool.count;
  }

  /** Put a projectile in the world. Returns its handle, or NULL_HANDLE when the pool is full. */
  spawn(req: SpawnRequest): Handle {
    const handle = this.pool.alloc();
    if (handle === NULL_HANDLE) {
      this.refused++;
      return NULL_HANDLE;
    }
    const s = handleSlot(handle);
    this.x[s] = req.x;
    this.y[s] = req.y;
    this.vx[s] = req.vx;
    this.vy[s] = req.vy;
    this.damage[s] = req.damage;
    this.radius[s] = req.radius;
    this.ttl[s] = req.ttl > 0 ? req.ttl : 1;
    this.life[s] = this.ttl[s];
    this.pierceLeft[s] = req.pierce;
    this.owner[s] = req.owner & 0xff;
    this.weapon[s] = req.weapon & 0xff;
    this.move[s] = req.move;
    this.flags[s] = req.flags;
    this.knockback[s] = req.knockback;
    this.angle[s] = req.angle & (BRAD_FULL - 1);
    this.angularVel[s] = req.angularVel;
    this.anchorDist[s] = req.anchorDist;
    this.gravity[s] = req.gravity;
    this.retick[s] = req.retick > 0 ? req.retick : DEFAULT_RETICK_TICKS;
    // Starts at 1, not at the full interval: a re-ticking shape must damage on the very first tick
    // it exists. Starting at the interval meant a whip — which lives for exactly as long as its
    // interval — expired before it ever got a turn, so it did nothing at all.
    this.retickTimer[s] = 1;
    this.sprite[s] = req.sprite & 0xff;
    this.age[s] = 0;
    this.clearHits(s);
    return handle;
  }

  /** Retire a projectile early — expired aura, weapon swapped, enemy that owned it died. */
  kill(slot: number): void {
    this.pool.freeSlot(slot);
  }

  /** Wipe between runs and for "restart same seed". Keeps the memory, drops the contents. */
  clear(): void {
    this.pool.clear();
    this.hitCount = 0;
    this.killCount = 0;
    this.totalDamage = 0;
    this.totalHits = 0;
    this.totalKills = 0;
    this.refused = 0;
  }

  /** How many of a given weapon's projectiles this owner currently has alive. */
  countOf(owner: number, weapon: number): number {
    const slots = this.pool.slots;
    const n = this.pool.count;
    let found = 0;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (this.owner[s] === owner && this.weapon[s] === weapon) found++;
    }
    return found;
  }

  /**
   * Keep a persistent shape alive instead of respawning it. Auras exist for the whole run; letting
   * them expire and respawn each second would flicker the sprite and reset their damage timer, so
   * the weapon refreshes the existing one whenever its stats change.
   */
  refresh(owner: number, weapon: number, damage: number, radius: number, retick: number): boolean {
    const slots = this.pool.slots;
    const n = this.pool.count;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (this.owner[s] !== owner || this.weapon[s] !== weapon) continue;
      this.damage[s] = damage;
      this.radius[s] = radius;
      this.retick[s] = retick > 0 ? retick : DEFAULT_RETICK_TICKS;
      if (this.retickTimer[s] > this.retick[s]) this.retickTimer[s] = this.retick[s];
      this.ttl[s] = this.life[s]; // auras do not age out
      return true;
    }
    return false;
  }

  private clearHits(slot: number): void {
    const base = slot * HIT_MEMORY;
    for (let i = 0; i < HIT_MEMORY; i++) this.hitMarks[base + i] = NULL_HANDLE;
    this.hitCursor[slot] = 0;
  }

  /** True when this projectile has already hit that enemy and should not hit it again yet. */
  private hasHit(slot: number, handle: Handle): boolean {
    const base = slot * HIT_MEMORY;
    for (let i = 0; i < HIT_MEMORY; i++) {
      if (this.hitMarks[base + i] === handle) return true;
    }
    return false;
  }

  private markHit(slot: number, handle: Handle): void {
    const c = this.hitCursor[slot] % HIT_MEMORY;
    this.hitMarks[slot * HIT_MEMORY + c] = handle;
    this.hitCursor[slot] = (c + 1) % HIT_MEMORY;
  }

  /** Clear the per-tick event buffers. Called at the top of `update`. */
  private beginTick(): void {
    this.hitCount = 0;
    this.killCount = 0;
  }

  private recordHit(x: number, y: number, amount: number, crit: boolean, weapon: number): void {
    this.totalHits++;
    this.totalDamage += amount;
    if (this.hitCount >= MAX_HIT_EVENTS) return;
    const i = this.hitCount++;
    this.hitX[i] = x;
    this.hitY[i] = y;
    this.hitAmount[i] = amount;
    this.hitCrit[i] = crit ? 1 : 0;
    this.hitWeapon[i] = weapon & 0xff;
  }

  private recordKill(x: number, y: number, typeIndex: number): void {
    this.totalKills++;
    if (this.killCount >= MAX_KILL_EVENTS) return;
    const i = this.killCount++;
    this.killX[i] = x;
    this.killY[i] = y;
    this.killType[i] = typeIndex & 0xff;
  }

  /**
   * One tick: move everything, then hurt whatever it overlaps.
   *
   * Movement and collision are one pass rather than two. Two passes would read every projectile's
   * position twice and at 1500 projectiles that is a measurable amount of cache traffic for no
   * behavioural gain — nothing here reacts to another projectile.
   *
   * Iterating the live list backwards matters: killing a projectile swap-removes the last live slot
   * into the current index, so a forward loop would skip whatever got swapped in.
   */
  update(owners: OwnerPositions, enemies: EnemyStore, stats: Stats, rng: Rng): void {
    this.beginTick();

    const critChance = stats.get(STAT.critChance);
    const critMul = stats.get(STAT.critDamage) / STAT_SCALE;
    const knockScale = stats.get(STAT.knockback) / STAT_SCALE;

    const slots = this.pool.slots;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      const s = slots[i];

      this.age[s]++;
      if (--this.ttl[s] <= 0) {
        this.kill(s);
        continue;
      }

      const kind = this.move[s];
      const own = this.owner[s];
      const hasOwner = own < owners.count;
      const ox = hasOwner ? owners.x[own] : this.x[s];
      const oy = hasOwner ? owners.y[own] : this.y[s];

      switch (kind) {
        case MOVE.aura: {
          // Sits on the player. No motion of its own at all.
          this.x[s] = ox;
          this.y[s] = oy;
          break;
        }
        case MOVE.orbiting: {
          const a = (this.angle[s] + this.angularVel[s]) & (BRAD_FULL - 1);
          this.angle[s] = a;
          const rad = (a * Math.PI * 2) / BRAD_FULL;
          this.x[s] = ox + Math.cos(rad) * this.anchorDist[s];
          this.y[s] = oy + Math.sin(rad) * this.anchorDist[s];
          break;
        }
        case MOVE.sweep: {
          // Progress through the swing, 0..1 across its whole short life.
          const a = (this.angle[s] + this.angularVel[s]) & (BRAD_FULL - 1);
          this.angle[s] = a;
          const rad = (a * Math.PI * 2) / BRAD_FULL;
          this.x[s] = ox + Math.cos(rad) * this.anchorDist[s];
          this.y[s] = oy + Math.sin(rad) * this.anchorDist[s];
          break;
        }
        case MOVE.homing: {
          const target = enemies.grid.built ? nearestEnemy(enemies, this.x[s], this.y[s], 400) : -1;
          if (target >= 0) {
            const dx = enemies.x[target] - this.x[s];
            const dy = enemies.y[target] - this.y[s];
            const len = Math.hypot(dx, dy);
            if (len > 0.0001) {
              const speed = Math.hypot(this.vx[s], this.vy[s]);
              // Blend toward the target instead of snapping, so a knife curves rather than
              // teleporting its aim and reading as a bug.
              const tx = (dx / len) * speed;
              const ty = (dy / len) * speed;
              this.vx[s] += (tx - this.vx[s]) * 0.18;
              this.vy[s] += (ty - this.vy[s]) * 0.18;
              const l2 = Math.hypot(this.vx[s], this.vy[s]);
              if (l2 > 0.0001 && speed > 0.0001) {
                this.vx[s] = (this.vx[s] / l2) * speed;
                this.vy[s] = (this.vy[s] / l2) * speed;
              }
            }
          }
          this.x[s] += this.vx[s] * TICK_SECONDS;
          this.y[s] += this.vy[s] * TICK_SECONDS;
          break;
        }
        case MOVE.arcing: {
          this.vy[s] += this.gravity[s] * TICK_SECONDS;
          this.x[s] += this.vx[s] * TICK_SECONDS;
          this.y[s] += this.vy[s] * TICK_SECONDS;
          break;
        }
        default: {
          if ((this.flags[s] & PROJ_FLAG.returns) !== 0 && this.age[s] === this.life[s] >> 1) {
            this.vx[s] = -this.vx[s];
            this.vy[s] = -this.vy[s];
            // A returning shape gets a fresh appetite on the way back, which is the whole appeal.
            this.clearHits(s);
          }
          this.x[s] += this.vx[s] * TICK_SECONDS;
          this.y[s] += this.vy[s] * TICK_SECONDS;
          break;
        }
      }

      // Re-ticking shapes forget their victims on a timer so they damage again.
      if ((this.flags[s] & PROJ_FLAG.reticks) !== 0) {
        if (--this.retickTimer[s] <= 0) {
          this.retickTimer[s] = this.retick[s];
          this.clearHits(s);
        } else {
          // Between ticks an aura does no work at all. This is the single biggest saving in the
          // file: garlic would otherwise run a broad-phase query every tick for nothing.
          continue;
        }
      }

      if ((this.flags[s] & PROJ_FLAG.hostile) !== 0) continue;
      if (!enemies.grid.built) continue;

      // --- Collision -----------------------------------------------------------------------
      const px = this.x[s];
      const py = this.y[s];
      const pr = this.radius[s];
      const found = enemies.grid.queryRadiusInto(px, py, pr + 24, this.candidates);
      let dead = false;

      for (let c = 0; c < found && !dead; c++) {
        const e = this.candidates[c];
        if (!enemies.pool.isSlotAlive(e)) continue;

        const reach = pr + enemies.radius[e];
        const dx = enemies.x[e] - px;
        const dy = enemies.y[e] - py;
        if (dx * dx + dy * dy > reach * reach) continue;

        const handle = enemies.pool.handleFor(e);
        if (this.hasHit(s, handle)) continue;
        this.markHit(s, handle);

        let dmg = this.damage[s];
        let crit = false;
        if ((this.flags[s] & PROJ_FLAG.noCrit) === 0 && critChance > 0) {
          if (rng.nextInt(1000) < critChance) {
            crit = true;
            dmg *= critMul;
          }
        }
        // Whole numbers only: a floating-point health pool would drift apart across devices, and
        // co-op compares a hash of exactly these values.
        dmg = Math.max(1, Math.trunc(dmg));

        const ex = enemies.x[e];
        const ey = enemies.y[e];
        const etype = enemies.typeIndex[e];
        const killed = enemies.damageAt(e, dmg);
        this.recordHit(ex, ey, dmg, crit, this.weapon[s]);

        if (killed) {
          this.recordKill(ex, ey, etype);
        } else if (
          (this.flags[s] & PROJ_FLAG.noKnockback) === 0 &&
          this.knockback[s] > 0 &&
          (enemies.flags[e] & ENEMY_FLAG.heavy) === 0
        ) {
          enemies.knockback(e, dx, dy, this.knockback[s] * knockScale);
        }

        if ((this.flags[s] & PROJ_FLAG.fragile) !== 0) {
          dead = true;
        } else if (this.pierceLeft[s] <= 0) {
          dead = true;
        } else {
          this.pierceLeft[s]--;
        }
      }

      if (dead) this.kill(s);
    }
  }
}

/**
 * Nearest live enemy within a radius, or -1.
 *
 * Uses the crowd's own broad-phase grid and its scratch buffer, so homing costs one grid query per
 * projectile rather than a scan of eight hundred enemies.
 */
export function nearestEnemy(
  enemies: EnemyStore,
  x: number,
  y: number,
  maxRange: number,
): number {
  const found = enemies.queryNear(x, y, maxRange);
  const list = enemies.neighbourScratch;
  let best = -1;
  let bestD2 = maxRange * maxRange;
  for (let i = 0; i < found; i++) {
    const e = list[i];
    if (!enemies.pool.isSlotAlive(e)) continue;
    const dx = enemies.x[e] - x;
    const dy = enemies.y[e] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = e;
    }
  }
  return best;
}
