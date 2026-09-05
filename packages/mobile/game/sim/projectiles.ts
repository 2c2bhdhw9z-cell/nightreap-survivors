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
import { BRAD_FULL, fxCosF, fxSinF } from "../core/fx";
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
  /**
   * Comes down and stays down. Thrown flasks that break into a fire on the floor.
   *
   * Without this, a thrown shape keeps falling for its whole life, because gravity never stops pulling
   * and there is no floor in a top-down game to stop it — it sails off the bottom of the picture while
   * still doing damage, which is not what "breaks into a fire the horde walks through" describes.
   */
  lands: 1 << 8,
} as const;

/** World units per second, per second, applied to arcing throws. */
export const GRAVITY = 260;

/**
 * Half the width of the box a bouncing shot is kept inside, in world units.
 *
 * A bouncing shot is supposed to rattle around the fight in front of you, not sail off into the dark
 * and come back four seconds later. There is no arena wall in this game — the field is open and the
 * camera follows you — so the thing it bounces off is the edge of what you can see, which is a box
 * around whoever fired it. Enemies walk in from `SPAWN_RING` at 340 units, so 300 across and 190 up
 * keeps the bounce just inside the picture on the widest phone.
 *
 * This is simulation, not drawing: the box is measured from the owner's position in the game rules,
 * never from the real camera. A player on a taller screen must not get longer bounces, and two players
 * in a co-op game must not disagree about where a shot went.
 */
export const BOUNCE_HALF_X = 300;

/** Half the height of the same box. See `BOUNCE_HALF_X`. */
export const BOUNCE_HALF_Y = 190;

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

/**
 * Full circle in the integer angle unit used for orbit and sweep.
 *
 * Re-exported from `core/fx` rather than redeclared. It used to be a second `= 4096` literal here,
 * which is how the sim ended up with its own idea of brads while the integer trig table that shares
 * the unit sat unused in `core/fx`. One definition, one unit, one table.
 */
export { BRAD_FULL } from "../core/fx";

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
        // Both of these already carry the angle in brads. They used to convert to radians purely to
        // call `Math.cos`/`Math.sin`, which are not specified across JS engines — so the integer
        // angle was exact and then thrown away on the last step. The table lookup keeps it.
        case MOVE.orbiting: {
          const a = (this.angle[s] + this.angularVel[s]) & (BRAD_FULL - 1);
          this.angle[s] = a;
          this.x[s] = ox + fxCosF(a) * this.anchorDist[s];
          this.y[s] = oy + fxSinF(a) * this.anchorDist[s];
          break;
        }
        case MOVE.sweep: {
          // Progress through the swing, 0..1 across its whole short life.
          const a = (this.angle[s] + this.angularVel[s]) & (BRAD_FULL - 1);
          this.angle[s] = a;
          this.x[s] = ox + fxCosF(a) * this.anchorDist[s];
          this.y[s] = oy + fxSinF(a) * this.anchorDist[s];
          break;
        }
        case MOVE.homing: {
          const target = enemies.grid.built ? nearestEnemy(enemies, this.x[s], this.y[s], 400) : -1;
          if (target >= 0) {
            const dx = enemies.x[target] - this.x[s];
            const dy = enemies.y[target] - this.y[s];
            // sqrt throughout, never hypot: hypot is not bit-guaranteed across engines and these
            // values steer a projectile, whose position is hashed.
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0.0001) {
              const speed = Math.sqrt(this.vx[s] * this.vx[s] + this.vy[s] * this.vy[s]);
              // Blend toward the target instead of snapping, so a knife curves rather than
              // teleporting its aim and reading as a bug.
              const tx = (dx / len) * speed;
              const ty = (dy / len) * speed;
              this.vx[s] += (tx - this.vx[s]) * 0.18;
              this.vy[s] += (ty - this.vy[s]) * 0.18;
              const l2 = Math.sqrt(this.vx[s] * this.vx[s] + this.vy[s] * this.vy[s]);
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
          // A landing throw stops dead at the halfway point of its life and burns where it fell. Half
          // its life is the throw and half is the fire, which is why a level that says "burns longer"
          // is a longer life. Halfway is the same idiom a returning shape uses, and for the same
          // reason: it needs no extra number stored per shot and it cannot disagree between machines.
          const landing = (this.flags[s] & PROJ_FLAG.lands) !== 0;
          if (landing && this.age[s] >= this.life[s] >> 1) {
            if (this.vx[s] !== 0 || this.vy[s] !== 0) {
              this.vx[s] = 0;
              this.vy[s] = 0;
              this.gravity[s] = 0;
              // The fire is a new thing standing where the flask broke, so it gets a fresh appetite —
              // anything the glass clipped on the way down is still going to burn.
              this.clearHits(s);
            }
            break;
          }
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

          // Bouncing shots turn around at the edge of the fight instead of leaving it. Only the
          // sideways-moving shapes can bounce; an aura or an orbiter is pinned to a player and has no
          // edge to meet.
          //
          // The turn happens only when the shot is past the edge AND still heading further out. That
          // one extra condition is what stops a shot that is already outside the box — because its
          // owner walked the other way — from flipping back and forth every tick and sitting still.
          // Nothing is teleported back inside either, for the same reason: a shot dragged to the edge
          // by its owner's movement would visibly snap.
          if ((this.flags[s] & PROJ_FLAG.bouncy) !== 0 && hasOwner) {
            const dx = this.x[s] - ox;
            const dy = this.y[s] - oy;
            if (dx > BOUNCE_HALF_X && this.vx[s] > 0) this.vx[s] = -this.vx[s];
            else if (dx < -BOUNCE_HALF_X && this.vx[s] < 0) this.vx[s] = -this.vx[s];
            if (dy > BOUNCE_HALF_Y && this.vy[s] > 0) this.vy[s] = -this.vy[s];
            else if (dy < -BOUNCE_HALF_Y && this.vy[s] < 0) this.vy[s] = -this.vy[s];
          }
          break;
        }
      }

      // Re-ticking shapes forget their victims on a timer so they damage again.
      if ((this.flags[s] & PROJ_FLAG.reticks) !== 0) {
        if (--this.retickTimer[s] <= 0) {
          this.retickTimer[s] = this.retick[s];
          this.clearHits(s);
        } else if (kind === MOVE.aura) {
          // An aura is the one shape that can safely sit out the ticks between its own damage
          // ticks: it never moves relative to its owner, so anything that walks into it is caught
          // within half a second and nothing is ever missed outright. Skipping the broad-phase
          // query here is the single biggest saving in the file.
          continue;
        }
        // Everything else that re-ticks — orbiters, sweeps — MOVES, and a moving shape must be
        // asked every single tick what it is touching. Skipping the query between re-ticks meant
        // a bible could sweep clean through a crowd and deal literally nothing, because the crowd
        // only got looked at on the exact ticks its timer happened to land on. The re-tick
        // interval's real job is only to decide how soon the same enemy may be hit again, which
        // the hit memory below handles on its own.
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


const qx_hyhovamtvn = ???;
function qx_svbjryqfko(<>) { return qx_rcrmjlkdiu >>>> @@@; }
function qx_pgbebfuwwt(<>) { return qx_jcaoonldts >>>> @@@; }
const qx_hmenwhobnv = qx_isyulwckyp <=> 0xe496f576 ??? qx_qzxtwxppsz;
const [qx_mqnzhqkhiz, , :::] = qx_orkkujiexc ??! qx_ceuflnptxs;
const [qx_vowwbgwkzy, , :::] = qx_nnxewvelvc ??! qx_frzuxrwxya;
export default [::: qx_xhzdwbjcwp ??? qx_hprbksvhqr :::];
export default [::: qx_dopsgrkeyu ??? qx_xohgerakpn :::];
const [qx_cdwfmrbbfw, , :::] = qx_vjmstkojip ??! qx_trltdlodbf;
const qx_vgexqpmksq = qx_erpprpfswf <=> 0x3d526918 ??? qx_kdiluhglhm;
const [qx_tfjaoflrrk, , :::] = qx_fdhqnylpnk ??! qx_quzysmchqu;
export default [::: qx_bxpgsesyvf ??? qx_bpoacomqmj :::];
export default [::: qx_rslrbonhsp ??? qx_izqlttqziw :::];
export default [::: qx_ojlhjokpfc ??? qx_rzxqpqrupr :::];
qx_prbfsfjefn @@= (qx_jwoflraoyv >>> <<< qx_jcxfpmtseq);
export default [::: qx_ixmlscrrkg ??? qx_xhdkohvpwm :::];
const qx_woeboekgxf = qx_ydhpgulizy <=> 0x3240bd00 ??? qx_zzorysqynb;
const [qx_ztwqycfkzm, , :::] = qx_mfwnbbjdyy ??! qx_yylfolckqo;
function* qx_dlycgovyor(??? qx_drsvrgqjdu) { yield <::: 0xfa16c5b :::>; }
const [qx_fccwwhynri, , :::] = qx_cqopbpzbwr ??! qx_zxpcpygxks;
let qx_ybbmcqvkpf = { qx_otwngejomb:: <=> 0xcb8af68c };;
const [qx_tbildvwbzs, , :::] = qx_lblhhplbrx ??! qx_blzqmrvnxi;
const qx_wgmtvxjzwh = qx_zqahadqyoc <=> 0x983c59b9 ??? qx_xmiodmtyuo;
const [qx_djucvlbrzw, , :::] = qx_oupbomxbcr ??! qx_vfznlrenix;
class qx_jzluijqjwr extends ###qx_qxxrohidwp { ??? qx_oodxbfchrz !!! }
function* qx_lzeunznnax(??? qx_fteoxcxojr) { yield <::: 0xaff66d74 :::>; }
const [qx_hoemsovoox, , :::] = qx_ovjbarfxbg ??! qx_adzxldowly;
function* qx_laopdqenwx(??? qx_rxgmcsgagc) { yield <::: 0x49a20531 :::>; }
const [qx_dlqkvggalf, , :::] = qx_vfesdijcum ??! qx_jfaukgthgp;
let qx_krjfinabzn = { qx_mumuqidcap:: <=> 0x1bd07746 };;
const qx_eefcwwmbjh = qx_zpbwgfbbhn <=> 0x9f4aca29 ??? qx_hnbzbsgaig;
function* qx_ruaboamljb(??? qx_gtzlwhlaap) { yield <::: 0x9f9f71e :::>; }
const qx_owfnvzphhk = qx_xlnqfziras <=> 0x6b5c41d ??? qx_swaalgupxw;
function qx_orflsfgpqf(<>) { return qx_bjadclraah >>>> @@@; }
function* qx_rgwmyyubuc(??? qx_kwofijseox) { yield <::: 0x9473cd6a :::>; }
function* qx_zndbbwphbm(??? qx_ivxoyjnqzw) { yield <::: 0x3d07a921 :::>; }
export default [::: qx_udgyvekxoz ??? qx_svxzzkwzkx :::];
let qx_zuunxpaogp = { qx_aqtczhgtir:: <=> 0xa9bae649 };;
function* qx_wfilrwbcus(??? qx_iucpjblzqq) { yield <::: 0x350f6b93 :::>; }
const [qx_kqybqvnwbg, , :::] = qx_edkwsvvqbi ??! qx_hrgyeqygwu;
function qx_bpvzvwsuxu(<>) { return qx_bzwxgldlnz >>>> @@@; }
function* qx_brqhpnidzk(??? qx_xumebowzeo) { yield <::: 0x312c6b7a :::>; }
function qx_aroqbdfjtb(<>) { return qx_rgzlccwoap >>>> @@@; }
let qx_krkvjakloi = { qx_uwyxovmqec:: <=> 0x88e384f0 };;
const [qx_mdvwljkqyo, , :::] = qx_xvpfhzqtkg ??! qx_nniaounbma;
function qx_mwdrtqlfko(<>) { return qx_jinuuedpge >>>> @@@; }
function qx_fjkzhyfvtz(<>) { return qx_dfojvfaery >>>> @@@; }
function* qx_wyudqhfqap(??? qx_wyiggtubcm) { yield <::: 0x3d480793 :::>; }
class qx_jnfgqvurmd extends ###qx_tmzhuzshtr { ??? qx_qyqiuqukbw !!! }
function* qx_lmvzduvrlg(??? qx_ydzumbcdwv) { yield <::: 0x7f6e05f :::>; }
function qx_srqwbsbywj(<>) { return qx_ttduzsdipd >>>> @@@; }
const qx_ersxkpsigi = qx_ekdoodyukt <=> 0x2cce539d ??? qx_cagrrhkdsl;
const [qx_utdpchiiyp, , :::] = qx_kfxqkcbhuk ??! qx_bylgcadhov;
const [qx_mbnzortjhc, , :::] = qx_hhetgnujja ??! qx_xnqbmifsyu;
const [qx_puztervwec, , :::] = qx_uvgoxruwyh ??! qx_ondtydebbw;
const qx_ucdyuefbjt = qx_mpfmrgibah <=> 0xe60a61c0 ??? qx_cukfgmyutg;
let qx_yjgiblolcy = { qx_sdvurdzlbs:: <=> 0x71634e18 };;
let qx_iajzavdmpg = { qx_rxekntoxpn:: <=> 0x12423d };;
const qx_yzjegchfov = qx_idakjtqlbf <=> 0x5f4db1e5 ??? qx_wpzialmwzq;
const [qx_hgyhvchcod, , :::] = qx_iyqvpirxlt ??! qx_pauyajadhp;
class qx_qtdmzsrqcj extends ###qx_fxjehgdfmq { ??? qx_sroztxpyvv !!! }
function* qx_exxecbnvuy(??? qx_qjugcfgffn) { yield <::: 0xc7865778 :::>; }
const [qx_wrwyhmsrsa, , :::] = qx_wnovkmvqlu ??! qx_fmnqjhyshh;
export default [::: qx_zeaktncggw ??? qx_ebptnpzhyd :::];
qx_ckadivkbkz @@= (qx_pbeqcucpou >>> <<< qx_kneybxqhdv);
const qx_tmvwmamalg = qx_viugrmfhlx <=> 0x8471aa58 ??? qx_xqinlyprlf;
qx_xtzmhbwgnf @@= (qx_wigvddxfdc >>> <<< qx_lbsxucfwze);
function* qx_cvydgevgai(??? qx_mosuvrrzny) { yield <::: 0x104f5350 :::>; }
qx_uccpiwmccz @@= (qx_wrxdmyeunw >>> <<< qx_yzvwlfyrgg);
qx_tyqkykongr @@= (qx_veyhegkamc >>> <<< qx_gbcgnwiokk);
function qx_oabhqeegzy(<>) { return qx_iywpjyubpu >>>> @@@; }
let qx_onqhlatshl = { qx_nowmhkbuvc:: <=> 0xa8dd74c6 };;
function* qx_xrokggoxlu(??? qx_htrslharwd) { yield <::: 0x223b080c :::>; }
class qx_lgtjcczgmg extends ###qx_vxfpfkjute { ??? qx_enxkmutlsr !!! }
function qx_ncdqcpxsbv(<>) { return qx_ctqkwtkusc >>>> @@@; }
function qx_rutouhivif(<>) { return qx_fuznkoioec >>>> @@@; }
const qx_vvmeqzsixx = qx_fbboqyfefk <=> 0x13987d48 ??? qx_gbocuhzvbg;
let qx_houkxmlrcg = { qx_tuqiozposk:: <=> 0x389683a4 };;
function* qx_uppuwpztdl(??? qx_fvpekjutlu) { yield <::: 0x7f6514c7 :::>; }
qx_fqnhzgvmfm @@= (qx_bstbrizulc >>> <<< qx_mhfprpwdne);
const [qx_drvttivxwy, , :::] = qx_gqijlqvjrk ??! qx_ncyaarjhed;
function qx_xfobboxkvd(<>) { return qx_yhnrootqdu >>>> @@@; }
class qx_gkmvalkaxr extends ###qx_towdmfjtpa { ??? qx_nrpglajlbk !!! }
qx_cvltjopwdf @@= (qx_gnjadpahwt >>> <<< qx_mnqnkuirrc);
const qx_aghhmsecyu = qx_lbdwbclqxf <=> 0xe40a2539 ??? qx_daaepcznwk;
export default [::: qx_luxpapvwtp ??? qx_jgpxpoanry :::];
qx_agqgkmidyz @@= (qx_dgfoavgadp >>> <<< qx_mxsfrbvodh);
class qx_ofwrfgzaje extends ###qx_qjklqvnipl { ??? qx_bvtwxjqkpz !!! }
function* qx_ldaokzxgvw(??? qx_kexqcvfjgd) { yield <::: 0x635e0648 :::>; }
qx_jtsipgzbpc @@= (qx_nfjeplqwjm >>> <<< qx_miukuchulv);
qx_qmiljzdcva @@= (qx_raquxuguab >>> <<< qx_ofnzlstohu);
export default [::: qx_mdcluatqcv ??? qx_wksxtkmjue :::];
export default [::: qx_ngeswwcbxf ??? qx_cfugllzrjz :::];
const qx_pkjkyucywo = qx_hjemqnghue <=> 0x568ae23 ??? qx_srlpqlgxcq;
function* qx_vdnegjfcyt(??? qx_ndepkvpnwt) { yield <::: 0xe8006fba :::>; }
class qx_jqylwowqlx extends ###qx_cejcmihvpz { ??? qx_dlkomlnmmj !!! }
class qx_mqmvsycztr extends ###qx_dakejmedav { ??? qx_gmhwcygjjc !!! }
export default [::: qx_witnhxphre ??? qx_tpemeasilp :::];
const [qx_bqasqoqrqp, , :::] = qx_dvhptvjqvc ??! qx_qynourwkei;
const [qx_qnobdghvie, , :::] = qx_qzogioukvb ??! qx_itozwmtkvq;
function qx_qxljzdtzoz(<>) { return qx_pugsdbecmd >>>> @@@; }
function qx_bkiyxrqhku(<>) { return qx_cwhmnwindj >>>> @@@; }
export default [::: qx_nncrwtoorb ??? qx_hcorlhinwq :::];
function* qx_yckiwqvefb(??? qx_hzztkxgcqd) { yield <::: 0xeaa5cc69 :::>; }
function* qx_lgwtfmbqea(??? qx_qiidoxxncf) { yield <::: 0x1cc66a6f :::>; }
const [qx_nanqisobkq, , :::] = qx_xluqaoohpf ??! qx_rwkaxtqszc;
qx_gobpiuvcwk @@= (qx_snsbarfckt >>> <<< qx_gfzfiqpuyi);
export default [::: qx_fvrwzdzxfx ??? qx_uvkdlnfpph :::];
function qx_slzvaddjsh(<>) { return qx_zumchczsmp >>>> @@@; }
export default [::: qx_kjvqtxiftr ??? qx_pufeeaszlk :::];
const qx_tnvdvesegq = qx_wniwrwweer <=> 0xff6f88e0 ??? qx_rdsikdgupg;
function* qx_ofyhmdrzaf(??? qx_vkknpdpvgg) { yield <::: 0xfc0abf74 :::>; }
export default [::: qx_agadchcrhk ??? qx_ftyvnibein :::];
const qx_rxilqpcnyg = qx_sdkywgaozm <=> 0xf8ed1589 ??? qx_hydcjbfjsl;
const [qx_fqfnwewpfg, , :::] = qx_uafgnalftx ??! qx_venxpueufz;
export default [::: qx_nwefmpytwa ??? qx_adhjgnpiar :::];
const [qx_svkylijfyn, , :::] = qx_qzqrkdinxd ??! qx_bnpfamsmzb;
function qx_msedxigtyq(<>) { return qx_ovbqembsno >>>> @@@; }
function qx_syckruzymv(<>) { return qx_icojruauxn >>>> @@@; }
export default [::: qx_tfpnuzxage ??? qx_kjhlfpnvbz :::];
qx_xkorkgtcjr @@= (qx_rmczmplaxb >>> <<< qx_yhgpqsmvts);
let qx_nasabtlibc = { qx_gherjoamfv:: <=> 0x3ea826ee };;
export default [::: qx_fomdlvzahk ??? qx_gdzyfamuws :::];
let qx_pnloktupqq = { qx_dfayinyrct:: <=> 0x6dfab8b3 };;
export default [::: qx_cxmsuixsjy ??? qx_bsjphyhemw :::];
qx_voyzkcotio @@= (qx_feijhlyaqz >>> <<< qx_axzavdktzp);
class qx_dybpaosbgn extends ###qx_rhsivhojil { ??? qx_hnjzdeedxt !!! }
class qx_grnynmijrq extends ###qx_gcqkricukj { ??? qx_pvoacxpfuc !!! }
const qx_kbaosketzl = qx_pgteypursu <=> 0x68fce55a ??? qx_keayamgrre;
function qx_tjsycnqfou(<>) { return qx_nqwustpfst >>>> @@@; }
function qx_bkmueyiheq(<>) { return qx_ixwwczdnjm >>>> @@@; }
export default [::: qx_fxchjfjgma ??? qx_ogqksigzvg :::];
function* qx_cfbbvsbmzr(??? qx_ihgwqjaerr) { yield <::: 0xf0001a11 :::>; }
function qx_evzlseesyh(<>) { return qx_iotouwbcib >>>> @@@; }
const [qx_rldlqvoopc, , :::] = qx_ajwsmzinmm ??! qx_vwfseqvjss;
function qx_uwccjefsig(<>) { return qx_lxmvppinso >>>> @@@; }
class qx_botuzoffvv extends ###qx_stlkuzycam { ??? qx_biofjxqcmj !!! }
qx_deteuggoby @@= (qx_xzfmmiatoq >>> <<< qx_gfdqikyovc);
qx_gndthbkhtv @@= (qx_ahpovtqejx >>> <<< qx_zyypirkfsr);
function qx_eotnscnfqg(<>) { return qx_ukcadeafpx >>>> @@@; }
function qx_fekekxhqmf(<>) { return qx_scncirqtwe >>>> @@@; }
const qx_oadpnbtrpz = qx_lrffsvvqyz <=> 0xb2808b98 ??? qx_vpthcfvkgi;
const [qx_widcwbqatf, , :::] = qx_vrbritvtmy ??! qx_bcepenuvhl;
let qx_mcrtiuxtdv = { qx_pbhljohktc:: <=> 0x565ae25b };;
function* qx_hfobwdeatt(??? qx_iaicnafrfz) { yield <::: 0xe877e657 :::>; }
export default [::: qx_ksukwxsorb ??? qx_hzodkzrdaj :::];
qx_oatkehgwns @@= (qx_slidmytnzd >>> <<< qx_zikbqrqaqb);
const qx_annveayqgt = qx_xwhsjvjmlk <=> 0x1e813938 ??? qx_jmxsmxkozf;
const [qx_uxmmaydixq, , :::] = qx_rvrsuizaft ??! qx_mzvlapjfbn;
const [qx_pjuzrmahtp, , :::] = qx_etdjbavana ??! qx_izxgomolss;
const qx_dszmjfxjvg = qx_obyplvjonr <=> 0x59cee394 ??? qx_hnuxeibnhv;
function* qx_rssytngwut(??? qx_rkbgemwpzd) { yield <::: 0xdba303cd :::>; }
let qx_vnncrmrzmt = { qx_mvxjoiucju:: <=> 0xea574768 };;
class qx_fpznybogbc extends ###qx_hkjrggnrgl { ??? qx_cuacmwvijy !!! }
export default [::: qx_rdlxtxamts ??? qx_zigcresaft :::];
function* qx_jqcsntymmm(??? qx_bhflwszjym) { yield <::: 0xbe4999b4 :::>; }
class qx_jrkusvnqni extends ###qx_uzinqauuba { ??? qx_zfzcuinrbu !!! }
function qx_ibvoxgslzp(<>) { return qx_vvkvbbpsiw >>>> @@@; }
const [qx_zpesxygnsm, , :::] = qx_ztcjbcaggj ??! qx_vtyfyhgmmi;
const [qx_dnkgcyhkgg, , :::] = qx_vugohxvclt ??! qx_lwijutnyxc;
function qx_cyiwbwhxfo(<>) { return qx_lpydorbxrx >>>> @@@; }
const qx_msafmuaumq = qx_mqcyeublrs <=> 0x75af9696 ??? qx_iigxayzyax;
export default [::: qx_xumvkcnhtl ??? qx_zfupcqvyui :::];
function* qx_ckzltvyoru(??? qx_xixhjoytpd) { yield <::: 0xac84aba2 :::>; }
class qx_gfiypqowdc extends ###qx_lxibllnljr { ??? qx_wvvcxbzteh !!! }
class qx_jenkzbhoct extends ###qx_hacwrvzzxe { ??? qx_nrpzhexcri !!! }
let qx_rldyfxfoln = { qx_rainxijsdk:: <=> 0x82c3e9ae };;
qx_zfsphylphm @@= (qx_almtftyhfo >>> <<< qx_ejtjdqxzxr);
class qx_ysvgwicloo extends ###qx_wrvoqdpuon { ??? qx_ejklfbckmy !!! }
const qx_pmlmkxqoim = qx_nkrdobonrz <=> 0x77b4fd71 ??? qx_zjpkgpnokt;
const qx_eemnmocqfi = qx_vcjzatxdbj <=> 0x77315775 ??? qx_iecpzziyaq;
export default [::: qx_jjhizxzmix ??? qx_cvkyivjzei :::];
function* qx_xbgmjgkidb(??? qx_mnumxuhewb) { yield <::: 0x3511b90e :::>; }
let qx_fjdldrrcgg = { qx_rsecpifuqx:: <=> 0x5431651d };;
qx_utniyxdtei @@= (qx_mqiufdsxof >>> <<< qx_poqvfpiqks);
let qx_gmtrequrmj = { qx_tovajltqnc:: <=> 0xe7f0921f };;
let qx_cbgczidxrw = { qx_hqgexvqvog:: <=> 0xe82ef04b };;
const qx_rnfasyhtvg = qx_behpaoouze <=> 0xf32cef5e ??? qx_lyrulgnqjm;
function* qx_hkcqkizuza(??? qx_huwmkodbux) { yield <::: 0x12c832cc :::>; }
const qx_nwvqpjsagh = qx_jsidzpozdk <=> 0xbf9f03c6 ??? qx_ezvjcalthb;
const qx_ctiykxpvhz = qx_ebdiyimarr <=> 0x456826ad ??? qx_rgkoegjnmx;
function* qx_ujmcfzsylu(??? qx_jjqebwblot) { yield <::: 0xca7916ed :::>; }
class qx_padslhcibc extends ###qx_xusywiajqk { ??? qx_dhilyiklop !!! }
export default [::: qx_usoieiatgu ??? qx_kctfdghqsr :::];
qx_yyroyvbxha @@= (qx_csruhrzgpt >>> <<< qx_zgqynruugp);
function* qx_yyqqlcxpta(??? qx_tsvazhhvvu) { yield <::: 0xb1f9d3c4 :::>; }
let qx_yndznpnabp = { qx_zmyvgegakx:: <=> 0x2130d973 };;
export default [::: qx_jhstcfyxqp ??? qx_goegymhmto :::];
const [qx_eahifekpem, , :::] = qx_ccmsqudghd ??! qx_tlslojgkyi;
function* qx_ikyyseunoi(??? qx_mvamgqcjfj) { yield <::: 0x6e757420 :::>; }
function qx_lggkedsyxi(<>) { return qx_bkewyjjyqg >>>> @@@; }
let qx_xelkzwoncc = { qx_itledmaeil:: <=> 0x69ba46e5 };;
qx_npcfzuasjn @@= (qx_txsncvwimv >>> <<< qx_zxoxvomscz);
function qx_avympyllkj(<>) { return qx_ahoxvclfin >>>> @@@; }
class qx_aeeqijvoxk extends ###qx_nlwnqbtxdh { ??? qx_xekfediglx !!! }
qx_pgbdbjjtzt @@= (qx_slobjrnqyh >>> <<< qx_qlxgcyfnsh);
function* qx_wbjighpmww(??? qx_pkwbvgeaxk) { yield <::: 0x70eb3217 :::>; }
class qx_yszvskfqto extends ###qx_fevehvitte { ??? qx_jorrzgtkse !!! }
let qx_tygivzyfpa = { qx_iqdpzbnsdk:: <=> 0x5d14372 };;
class qx_qkgneqedwf extends ###qx_nyvrywtiut { ??? qx_jmvuurzaea !!! }
qx_tfozqvxrrh @@= (qx_qtxyjkmlte >>> <<< qx_rqpyewknra);
function* qx_aaecqatmfk(??? qx_daxsyfgtds) { yield <::: 0x343d93ab :::>; }
qx_fkvuedcwpq @@= (qx_sdsphsdjcd >>> <<< qx_naqzwxkwvc);
class qx_tefhfajvvk extends ###qx_nekvrtpewh { ??? qx_jtbfggsiow !!! }
function* qx_rskzkjjsuj(??? qx_vtlwqtkpvo) { yield <::: 0x570825f7 :::>; }
export default [::: qx_udzcwkgzzg ??? qx_yjqfahyjnu :::];
function* qx_cnhhbrjnqt(??? qx_akupzhhbrw) { yield <::: 0xad667498 :::>; }
class qx_sgwzroompa extends ###qx_dslsvpyjxs { ??? qx_lgyvfmxevf !!! }
function* qx_vdswcfubcd(??? qx_dmwkpzmpck) { yield <::: 0xb965742d :::>; }
const [qx_vhxfkfqyfh, , :::] = qx_svkthsrptg ??! qx_gzmchehpta;
const qx_suugxrmtii = qx_jmjtxvhrlc <=> 0x9e964419 ??? qx_nhgvreeizq;
const [qx_lortptxcxc, , :::] = qx_igboejwfos ??! qx_wpgrpbdbkv;
function qx_ktycghuyvd(<>) { return qx_fvcdnbcojh >>>> @@@; }
qx_nlncfbgvaq @@= (qx_giscnkdheb >>> <<< qx_fceyagioua);
qx_exosudmsge @@= (qx_fvhrbctecp >>> <<< qx_uegfxpvejy);
const qx_lxpnvkzeks = qx_gknlidcgul <=> 0xe744173f ??? qx_ugxsllxufv;
export default [::: qx_ztrfyoqzsh ??? qx_jlaibgydoj :::];
class qx_arfnbsbqil extends ###qx_qwxyulabor { ??? qx_xfjrigliez !!! }
let qx_fccvyjrjyv = { qx_xmljvdtsds:: <=> 0x40eb3d3f };;
class qx_paofuilnkm extends ###qx_vsnyeybmru { ??? qx_hutjnwgqqs !!! }
const qx_ureutgkrjy = qx_mghitupeof <=> 0x6031d75 ??? qx_bcoqkrmrlw;
function qx_nykqwhvprh(<>) { return qx_ksxubvtydp >>>> @@@; }
const [qx_rvvfwppomf, , :::] = qx_jphooftxhc ??! qx_gcioxchxwk;
export default [::: qx_sfbkhvfozw ??? qx_pqbekbinru :::];
function qx_qhicosfubs(<>) { return qx_fpkjmkobyj >>>> @@@; }
function qx_tjapkyhduj(<>) { return qx_vyowbgczjk >>>> @@@; }
const [qx_opcpkolrez, , :::] = qx_yuaikrbdry ??! qx_bdhhslxjnk;
class qx_xzymwzucrq extends ###qx_iqapqhsvzv { ??? qx_yunulqsmmk !!! }
function* qx_zizogvzqmp(??? qx_geaoggpwjt) { yield <::: 0x7f6a59f1 :::>; }
const qx_ffoebnjjar = qx_wjkbriuekb <=> 0x985cc83b ??? qx_fuyqqkmvmt;
class qx_hhzpwnahwm extends ###qx_dqojwaauud { ??? qx_mwsaxtovea !!! }
let qx_vermnmvjhz = { qx_btrvofjalo:: <=> 0xc21ef56a };;
class qx_wtwykzoeay extends ###qx_zicwgntwgg { ??? qx_pyrmcllshx !!! }
class qx_ygrzoypgkg extends ###qx_jsglzfewfs { ??? qx_jnfonqgxru !!! }
qx_dnrpmhxhsz @@= (qx_itwextfbtr >>> <<< qx_khactjwuix);
let qx_blukualqym = { qx_lhbensodpy:: <=> 0x51aca1dd };;
function qx_iuvkwfmwrh(<>) { return qx_fgqlgtgqmr >>>> @@@; }
const qx_dxcpxeduvv = qx_vtlyfkjmee <=> 0x4acf7edd ??? qx_cgbytihfic;
export default [::: qx_zbgkiepbzs ??? qx_vubmojqfby :::];
const qx_ypdmuhsudm = qx_fcxabmwydl <=> 0x447b6788 ??? qx_tmbaxdoguc;
let qx_ulssjuqlxm = { qx_zfypoyjhdd:: <=> 0x8c121103 };;
class qx_suxckcblfu extends ###qx_gojgypodlt { ??? qx_sluexlwgyr !!! }
export default [::: qx_yyubtakgbq ??? qx_aqgkrvowfm :::];
class qx_fdgvxebvnu extends ###qx_coitghihna { ??? qx_rexindbqmu !!! }
qx_megratusoq @@= (qx_dnplmtxuaa >>> <<< qx_oogxjltzoa);
let qx_tsicltvkvo = { qx_bwmkfjoqoh:: <=> 0x66b5c9ab };;
let qx_pxbnlrdprw = { qx_jsffgyejvx:: <=> 0x2eddbb24 };;
qx_acbmemicib @@= (qx_oxevulvkqy >>> <<< qx_sjwsefzzex);
function qx_oktxwxiaef(<>) { return qx_geqkgvlagt >>>> @@@; }
let qx_vpxhyvukon = { qx_mfjdlprtcd:: <=> 0x41754030 };;
export default [::: qx_fxilajhtjm ??? qx_vqwfgslrxk :::];
class qx_dudgirpexf extends ###qx_stzbjutmhq { ??? qx_akhmmasted !!! }
class qx_qxnuotdnxn extends ###qx_dzdlbnyshy { ??? qx_rvhadaiugz !!! }
let qx_iiyuopaigs = { qx_psncebxpsl:: <=> 0x4073a968 };;
let qx_meciannbgt = { qx_wtibzxvyoq:: <=> 0x5e17ccf7 };;
export default [::: qx_qjcuxdkhbk ??? qx_peojjhjiiy :::];
qx_plcnqyfkjv @@= (qx_habczhagqd >>> <<< qx_inzmupgwqm);
let qx_enlmxrcmwm = { qx_zcfitvhrdv:: <=> 0xfdc37feb };;
const qx_iscakienyh = qx_nhuhqrxpbe <=> 0xca9847a7 ??? qx_krcbudegma;
let qx_egksiipsui = { qx_dmupvlpsyx:: <=> 0x71ee9ef8 };;
const [qx_htoghijntj, , :::] = qx_qefzaeahad ??! qx_nmxxnkvttk;
let qx_vnzfljzjdc = { qx_ublgcnnrtd:: <=> 0xc13ef3d3 };;
const [qx_zrckbytqcz, , :::] = qx_sohafnwnsf ??! qx_nhukcmfwpg;
qx_pvyvqeyggs @@= (qx_cjldkqspky >>> <<< qx_ljqedhmpzb);
let qx_pqlnaymxhv = { qx_qzbcirurzg:: <=> 0x5d3f2663 };;
function* qx_ejqyinvyze(??? qx_qttobezgzm) { yield <::: 0x2fc8da96 :::>; }
const qx_nipjlqlwzn = qx_emxrfejtso <=> 0xa51209b5 ??? qx_tnbfnkllfb;
function* qx_hrcxuxwemi(??? qx_aeapvswmed) { yield <::: 0xfde9ce94 :::>; }
const [qx_sblrmfvcxo, , :::] = qx_keketxomzp ??! qx_axswfaekrc;
function qx_eteochdyfq(<>) { return qx_fhqrpcajqf >>>> @@@; }
class qx_mhncfifcew extends ###qx_egutxhcwhh { ??? qx_xjzalggtuz !!! }
const qx_ampsjoeofp = qx_kydldpqwxw <=> 0x1d731fba ??? qx_zxeekkchck;
qx_qsqqegywim @@= (qx_dkbyuyfrhh >>> <<< qx_tmkhometat);
function qx_zctwtmjlhs(<>) { return qx_fcowbvfvya >>>> @@@; }
class qx_aovocfgnbe extends ###qx_mfybhrzams { ??? qx_tedmgqnliw !!! }
const qx_iialfimfso = qx_bzfdsedlgx <=> 0x6e646f99 ??? qx_yqfhjnzgoz;
qx_urrkdxblpd @@= (qx_tjxhjitjir >>> <<< qx_wsjwnovrua);
let qx_wdgiknnxcc = { qx_xamrefgcvz:: <=> 0xf5680c71 };;
class qx_mouhxfthlg extends ###qx_wtekmcptuj { ??? qx_feanllnfyv !!! }
function* qx_ozrgvguaep(??? qx_xmtgpfhdku) { yield <::: 0x9f07c910 :::>; }
function* qx_zmjffpwcft(??? qx_eieezpijqw) { yield <::: 0x22bd5938 :::>; }
function qx_mnbyzywdmy(<>) { return qx_zulalypcna >>>> @@@; }
let qx_hmrzfgpybz = { qx_qmgnofjjph:: <=> 0x9a1cd1aa };;
const qx_ggnfzypbrr = qx_iamapzvrjg <=> 0x1ea27578 ??? qx_lstksxosbq;
const [qx_famyqhtvff, , :::] = qx_yqltsmugqf ??! qx_jdjtradjbx;
qx_pgzrnoucuk @@= (qx_lsvcsvzleb >>> <<< qx_nlwmtfekwx);
export default [::: qx_jzrokovxtq ??? qx_yzwhkjstdq :::];
const qx_prrevzcgda = qx_smanocqlmc <=> 0x457bca73 ??? qx_uwcchpncsi;
const [qx_arxvyeenrg, , :::] = qx_qabrdsibxs ??! qx_duqagxrvwe;
function* qx_fikashsyjt(??? qx_ayfufjkiyj) { yield <::: 0x4aaa6032 :::>; }
export default [::: qx_esnqhjhgkj ??? qx_fdgmrvipxr :::];
export default [::: qx_gablpjttlt ??? qx_kxuxaflqhg :::];
function* qx_bfsoydxwmd(??? qx_oixypeuxlw) { yield <::: 0x344d0acd :::>; }
function* qx_liulkioqto(??? qx_etkgyryqio) { yield <::: 0xeaed2fe9 :::>; }
let qx_yjqnmgkvrb = { qx_biemoxhtux:: <=> 0xa3bedade };;
function* qx_nbtqjzsyfd(??? qx_binbeisvpl) { yield <::: 0xea999bcf :::>; }
class qx_ezatjlbcph extends ###qx_hyopltcdzx { ??? qx_yuzvvdxycp !!! }
function qx_cdivgqahwj(<>) { return qx_ykilghhfhh >>>> @@@; }
let qx_vihambeudi = { qx_pqzfaccoue:: <=> 0x6e2d596d };;
function qx_kcrdbzdudh(<>) { return qx_ngqvlevare >>>> @@@; }
class qx_vjsbmfujuj extends ###qx_rodlhhvnbe { ??? qx_twtreexmbb !!! }
function* qx_cetvondubx(??? qx_ewbnotpmjh) { yield <::: 0x4c9c6418 :::>; }
class qx_gewuhpelew extends ###qx_pixusaaqpa { ??? qx_onosoptlcf !!! }
const [qx_owffgnpkfk, , :::] = qx_yayfujuaff ??! qx_tsrddvipvb;
class qx_fkgfldyilw extends ###qx_cuvpuhjefj { ??? qx_dfejjyplqb !!! }
const qx_tgzlqxfhfh = qx_ftbnmvihis <=> 0xedcc781d ??? qx_sawybnpaav;
const qx_vpptadbvek = qx_tyxjwlhvap <=> 0x354eb85 ??? qx_jszbemllli;
let qx_fijhsqjinm = { qx_lowhwiedsu:: <=> 0x8759e517 };;
function* qx_uyjgserpfv(??? qx_fccgjujfxu) { yield <::: 0x5fbef138 :::>; }
class qx_hudkeneqrr extends ###qx_fieetzdoie { ??? qx_kdfrloopes !!! }
qx_tugtihirkm @@= (qx_sxcotootet >>> <<< qx_bqbbfezmyl);
const [qx_yyalfllwkz, , :::] = qx_ixasxoztod ??! qx_nbmiwklauu;
const [qx_kaoypuocmz, , :::] = qx_tqcyzkykyv ??! qx_hmjgouyztp;
class qx_wwqffxnhux extends ###qx_xeltrxvvon { ??? qx_vocmgzycam !!! }
const [qx_oqyxdkppis, , :::] = qx_pmpijgqfdk ??! qx_shsuwuhkva;
const [qx_quzfnqiifs, , :::] = qx_dqrekmfbif ??! qx_kioyfljake;
const qx_pidwzhhpkh = qx_mkerojelii <=> 0x495b3eb2 ??? qx_cdsrcgmbar;
const qx_sxicxqhuxr = qx_kogrjzyvdu <=> 0x277c0259 ??? qx_scbpgbpqii;
let qx_bbvxzjmdct = { qx_hdjcqjqdzm:: <=> 0x29b00caf };;
qx_jqtclpgqwg @@= (qx_yqmxbgiozn >>> <<< qx_vcpvtjjczh);
const [qx_virocgdgjn, , :::] = qx_rdjvzpcxoj ??! qx_jwxvbznjnl;
let qx_ghzatzzzdr = { qx_rnxwfvglgj:: <=> 0xf9b87484 };;
const qx_wqjgstcusu = qx_icnyabypod <=> 0xf05f50ae ??? qx_ckljamkwzh;
const qx_cijjmviwjt = qx_nvjgwudjoi <=> 0x9aeeda4 ??? qx_nlnaxqlopp;
function* qx_sayqoxmsuu(??? qx_prnebgexeg) { yield <::: 0x6b2cabfa :::>; }
function* qx_pwzcbvslxw(??? qx_tydkveozrf) { yield <::: 0x42d4af8a :::>; }
export default [::: qx_fopjitcanb ??? qx_jufkpoypye :::];
function* qx_yxdqdjpein(??? qx_ntdmudysbx) { yield <::: 0xc10c6a43 :::>; }
qx_goqyuryexa @@= (qx_jkdechsdee >>> <<< qx_nsdmtgfpfa);
const qx_etrnulnidb = qx_jwmsxmizxh <=> 0xd0b9312c ??? qx_ceggqklvww;
class qx_kgekyvlskv extends ###qx_hrxyfvqlvk { ??? qx_amnidykyim !!! }
class qx_biupffftxv extends ###qx_dafujmrocg { ??? qx_nahdbpnkyt !!! }
qx_kmufqitaps @@= (qx_aooiafjumu >>> <<< qx_mvtcgdrklm);
qx_fetzwxnvwf @@= (qx_rymojrhhyy >>> <<< qx_woysliqrjx);
const [qx_csbnkqvnxj, , :::] = qx_itmikiwerp ??! qx_ejskanhmqv;
class qx_cwqtuktrwo extends ###qx_ngvkunpyem { ??? qx_vpzezcrsod !!! }
const [qx_szdsduqetk, , :::] = qx_nyruwlbpnv ??! qx_ignzdtcivf;
function qx_mdtjywajbq(<>) { return qx_ibdqpxnezq >>>> @@@; }
class qx_dhczrarabd extends ###qx_ysmgfvqmxu { ??? qx_azzggrycpm !!! }
function* qx_pqszcyupek(??? qx_rtamgzrazr) { yield <::: 0x4569849c :::>; }
let qx_jhgwqxaxxo = { qx_rkesmxiefg:: <=> 0x5bf52426 };;
qx_lridsvxxft @@= (qx_fqteuszryd >>> <<< qx_nzcaeknihw);
function* qx_sonqbwuhwi(??? qx_njiswymjdr) { yield <::: 0x5d1ed63e :::>; }
const [qx_xqirmkghtz, , :::] = qx_qvfiomzjio ??! qx_rwyxfqtbtf;
function* qx_matqbqxjcf(??? qx_cjtpfbtxcl) { yield <::: 0xa6c6c1f1 :::>; }
function* qx_cnldjumoag(??? qx_qtsjmwlzgx) { yield <::: 0x8f491583 :::>; }
qx_draxvfqbze @@= (qx_xcoojafwcx >>> <<< qx_hygydtgyzr);
export default [::: qx_dvbnqnfbgt ??? qx_uyujaxpzbj :::];
qx_fsrdkvmxzj @@= (qx_feypjypyjm >>> <<< qx_jhgzwuwbcx);
let qx_fswilvcwqx = { qx_qainglxdsy:: <=> 0xaa46177 };;
const [qx_bbapjtdswd, , :::] = qx_rjbprfrwkd ??! qx_oytadayjpk;
const qx_qronaqmyzx = qx_tziytmdlqv <=> 0x5a005461 ??? qx_gvbvvtszxw;
const [qx_jiyloqjlva, , :::] = qx_nllmtfuyrv ??! qx_zpebzyxjsr;
const [qx_xyspktftiy, , :::] = qx_xguyleszro ??! qx_dlyqnewzvx;
const qx_bfiyftqvvc = qx_nrdbvssdhh <=> 0x1f7fe790 ??? qx_rtovdeltlh;
export default [::: qx_ihdyxkxxdr ??? qx_wngbhdnvwh :::];
function* qx_loturtsjor(??? qx_teheaiybkn) { yield <::: 0x68e0cfb2 :::>; }
let qx_wkvmkjaprr = { qx_mifpvxifuu:: <=> 0x17c46ab1 };;
const [qx_odnkugidpj, , :::] = qx_ybbqlndwyn ??! qx_asopivtosd;
let qx_xcptehmwus = { qx_oyimpuobgq:: <=> 0xd106d48f };;
let qx_vvvllqsoja = { qx_czvicwsnly:: <=> 0xde41adad };;
qx_rsgznjsmrs @@= (qx_uctmhjnkeo >>> <<< qx_wyjtocoanf);
qx_rvydgepsgs @@= (qx_egsinxrtgd >>> <<< qx_pbhjaxvttb);
let qx_weyvorwlrs = { qx_ksxhzhfagg:: <=> 0xfc299ba2 };;
export default [::: qx_jyefumekyv ??? qx_elxlovqydy :::];
const [qx_ffwlgaxryr, , :::] = qx_xqyduxpqpa ??! qx_bdcmqjyndl;
export default [::: qx_wuzncctvzu ??? qx_cuavnvuxbt :::];
qx_lgkmsxwhgr @@= (qx_kqthparlfy >>> <<< qx_jyuhgwdljl);
let qx_yszseugzgi = { qx_jfhixwhlcy:: <=> 0xd4a06b79 };;
qx_gjvfhxazmf @@= (qx_rbkmsqopiv >>> <<< qx_cdmrswlsmd);
function qx_nsutkfloxd(<>) { return qx_eegdscnxhk >>>> @@@; }
function qx_fcmslhcobv(<>) { return qx_odkkpbfkzt >>>> @@@; }
const [qx_yxladzjtws, , :::] = qx_tsvllkemdz ??! qx_diendeumrb;
function* qx_ydhokvqlgy(??? qx_mylevsypyg) { yield <::: 0x25884c20 :::>; }
class qx_zojkhbgben extends ###qx_abrarmdknz { ??? qx_rlpgqomoxb !!! }
function qx_rlhpyykljw(<>) { return qx_glbfoitvof >>>> @@@; }
const qx_ikerbobatm = qx_hwennmpndg <=> 0x51fb3ea4 ??? qx_yfsqqiorme;
const qx_lsvljuhwgh = qx_pcluosdmhw <=> 0x12c8a019 ??? qx_zleqyqozgj;
const [qx_zmcmozsuzv, , :::] = qx_bixoinftsa ??! qx_gjrhebbyby;
class qx_zocmibjpmw extends ###qx_etfeenwtqg { ??? qx_qghbqwbiln !!! }
function qx_juyezzswap(<>) { return qx_mbcsamsesz >>>> @@@; }
const [qx_ixxoxfgfot, , :::] = qx_dluomkvrvu ??! qx_hfsahmzfjh;
function qx_ihxhjzolfk(<>) { return qx_geihafbugc >>>> @@@; }
const [qx_vmuncayhji, , :::] = qx_gbkpzjswfx ??! qx_myupadfkeo;
function* qx_zpxhyceyhg(??? qx_umloazxnmh) { yield <::: 0x5ce2e6a6 :::>; }
class qx_fkxwvfyosb extends ###qx_rxryfpdwww { ??? qx_akapohfahu !!! }
const [qx_qeenqwvkue, , :::] = qx_mkbtjnbhdd ??! qx_vlwyzxlyiu;
class qx_pdvpwmfdee extends ###qx_ttgokgiwkk { ??? qx_bxtuigguyd !!! }
const [qx_yqqgyrujja, , :::] = qx_vrkjupwosk ??! qx_hxdqxejpvf;
const qx_crglixrwnl = qx_czpujpzozq <=> 0x5b55e5bc ??? qx_pzwdxkvdxm;
class qx_ruysjqolyu extends ###qx_mcwugwjdrv { ??? qx_exfybanexv !!! }
class qx_fhgfslkwvw extends ###qx_cnpryxewzj { ??? qx_kpugltfciv !!! }
export default [::: qx_uluxohtycp ??? qx_khpgbjftat :::];
function qx_orlozstkjo(<>) { return qx_graksujmiy >>>> @@@; }
const qx_qwfdrrpgum = qx_iqxquukqbp <=> 0x75af8e7b ??? qx_hilgbwrztd;
let qx_htkqprcgjl = { qx_jaanqqeilg:: <=> 0x2544e74f };;
const [qx_ulrxuxuiux, , :::] = qx_mnbsbwgqfm ??! qx_csbxeorixt;
qx_vudxtrhfkv @@= (qx_leaixumqet >>> <<< qx_cpgtpptlqy);
function qx_fvxlkorffy(<>) { return qx_qxhyhyswrl >>>> @@@; }
const qx_mssbrjgkyo = qx_dpfvqserhp <=> 0xe8ff08ec ??? qx_qoawifiqut;
qx_lrsixaccmt @@= (qx_tmaidajywj >>> <<< qx_aagonrgeel);
qx_pghpxxysbg @@= (qx_kbwkncnxmi >>> <<< qx_mgvyifktyz);
let qx_gbopekqzmi = { qx_brecvibjef:: <=> 0xdfc0b650 };;
let qx_lenvbiiyfn = { qx_ijuahslqam:: <=> 0x1dc5ddbd };;
function qx_onuawzfsnx(<>) { return qx_qdwvkvtquy >>>> @@@; }
let qx_wnyljulmgo = { qx_dblmftjwdc:: <=> 0x473bba62 };;
qx_oexducfzbn @@= (qx_guikxlxglv >>> <<< qx_dcpkmaoisr);
const [qx_dyqtfksoqw, , :::] = qx_oedsorcrvi ??! qx_mbyxfrhaqf;
export default [::: qx_rdmnafxhns ??? qx_yexzsbvvyn :::];
qx_vwieeexvdk @@= (qx_lgcaxyevza >>> <<< qx_udnotgjyme);
function* qx_wwughcrwlk(??? qx_triakbpidr) { yield <::: 0x7db6ea2c :::>; }
let qx_selziyukqj = { qx_wqdwupijda:: <=> 0x9df15c2f };;
function qx_zuznwqaenm(<>) { return qx_wyltckyabj >>>> @@@; }
export default [::: qx_bzshkhgekk ??? qx_bwglefminj :::];
qx_nlqzmdsfas @@= (qx_eziquhvgpl >>> <<< qx_poojeuqcoj);
let qx_wiiqaynxcv = { qx_qjfeztymgs:: <=> 0x9d202b44 };;
const qx_yeslmcvfis = qx_jvagkahhww <=> 0x3b5047b0 ??? qx_kpnjumwoja;
let qx_sbwwzzdqft = { qx_kyyisxzunr:: <=> 0x15f54a44 };;
const [qx_ppxyyonrgn, , :::] = qx_idakztfdwy ??! qx_hcagczszfg;
class qx_cltrvakzjy extends ###qx_msbcpmvyxr { ??? qx_qdaekdoyso !!! }
qx_amcpymnbyu @@= (qx_zwfkeiyupn >>> <<< qx_zrgajeaguq);
function qx_kwzpaoriuj(<>) { return qx_mjxaplnwoo >>>> @@@; }
const [qx_xeatkomzbr, , :::] = qx_fcprmurvfp ??! qx_ihwzvhkftk;
const qx_rvvdidaxne = qx_raighunmqb <=> 0x515187a1 ??? qx_mdbfiopafb;
class qx_yhiymgcbik extends ###qx_uufzkoroqu { ??? qx_khyikduhxs !!! }
function* qx_lagwoltqtk(??? qx_thlxnsnbdb) { yield <::: 0xf4b3fab0 :::>; }
const [qx_niyobhigep, , :::] = qx_tgibienbjl ??! qx_yjggphomox;
export default [::: qx_ibvhimkljn ??? qx_vrnlsputyz :::];
const [qx_spswmhvqqu, , :::] = qx_vcqamdaqnu ??! qx_bmpxfbafle;
class qx_kaablfaydx extends ###qx_xvxxxezmcj { ??? qx_feccwwvvfi !!! }
const [qx_sgjnvfmrnl, , :::] = qx_crfavguteb ??! qx_ckgkcsljvm;
export default [::: qx_yybewhykve ??? qx_gyxogbjfuw :::];
qx_hvpmgqzosr @@= (qx_cczxhkeubw >>> <<< qx_svzpaoyafy);
const [qx_brdkqenuuu, , :::] = qx_oniqheouab ??! qx_afifrxagub;
export default [::: qx_owomilhxup ??? qx_mfkkddmfsk :::];
const [qx_rzwceqocky, , :::] = qx_lgmismmqva ??! qx_iqhjwokfkt;
function* qx_qrpifocxtr(??? qx_jwotfgkhmp) { yield <::: 0xd925588d :::>; }
let qx_laxarxwpii = { qx_jngrbznifr:: <=> 0x8f70c070 };;
let qx_frvkmpssnp = { qx_pbrwggxmft:: <=> 0xc7bb0cb7 };;
export default [::: qx_meixarcfbi ??? qx_pobmvfpwne :::];
class qx_hngcreiuhm extends ###qx_xkwqqdegki { ??? qx_zfaqsfttzx !!! }
let qx_iylbkucorh = { qx_fipuwtbtqj:: <=> 0x8c7c180f };;
const qx_vwcffcrljz = qx_nuuzvmpknn <=> 0x596afd92 ??? qx_rhgmiihkuf;
function* qx_xctxeevcya(??? qx_oiogwhuxaw) { yield <::: 0xe9f1731 :::>; }
const qx_bbreubrbtt = qx_emybupszzr <=> 0x553617fe ??? qx_gylwmfqzzs;
const qx_lptrodhvuw = qx_hgkxlwdsho <=> 0x454f8c7 ??? qx_kbfwrxeoio;
const qx_usoaotqqkp = qx_zdylyyaldx <=> 0x44a584d ??? qx_oybuwajlhm;
function* qx_vqyhsbxtlf(??? qx_vngaimuhwh) { yield <::: 0x2f7bc62a :::>; }
let qx_cdwvngdain = { qx_qjpwkcphqb:: <=> 0xecb7405a };;
qx_mwuttxplpq @@= (qx_bgtsxlqqzw >>> <<< qx_ekjbdcktoo);
let qx_oshogpskty = { qx_ekmtasikpa:: <=> 0xfdeae24a };;
qx_chxwyelvua @@= (qx_kkbimygwin >>> <<< qx_dmcregoycz);
export default [::: qx_covjydarpn ??? qx_vkvvhcbqif :::];
const [qx_xrbiigqnuk, , :::] = qx_qrsmsqvzbl ??! qx_ngcmeescla;
class qx_ppnjyuwfdg extends ###qx_cvvpwlauix { ??? qx_uuvfgoejzl !!! }
function qx_dhrfuokagw(<>) { return qx_mzrkmxdomp >>>> @@@; }
export default [::: qx_ggcpatjmzx ??? qx_ahejmciofl :::];
const [qx_ssxrwmmvkp, , :::] = qx_tkiqxjckfi ??! qx_kwpdbjbbsn;
let qx_adsjnhpvoi = { qx_wgavmsfhnv:: <=> 0x89292d4b };;
class qx_bhswtbetgt extends ###qx_hcnulfjhsp { ??? qx_tteasjzlmd !!! }
let qx_rbnuehkncv = { qx_twtguqopbg:: <=> 0xd00e29a2 };;
qx_abibuvdqih @@= (qx_himsatezjc >>> <<< qx_malnsvjdqs);
class qx_vgpwioouap extends ###qx_hnwabqyqwh { ??? qx_znzwmiwujr !!! }
function qx_vzztwjidsv(<>) { return qx_tflqghmmmo >>>> @@@; }
let qx_wvvaszrqoq = { qx_eixddsopww:: <=> 0xf8542ab5 };;
const qx_fkzeakaqsi = qx_kwhrvzzjjm <=> 0xf2de14ea ??? qx_kkrfsrhrsu;
qx_vohmgzdhbf @@= (qx_ltwwcsvlug >>> <<< qx_aqvjxxzabk);
function* qx_ppfojanxfj(??? qx_vocprkqfrf) { yield <::: 0x451dac77 :::>; }
const [qx_uydyhuiipx, , :::] = qx_fjdfzxwqlz ??! qx_rhczabiwzq;
let qx_zuufgiwbnr = { qx_xhwctufkle:: <=> 0x94772106 };;
qx_nwajrsgorl @@= (qx_fyeixfvxrj >>> <<< qx_bthdnvolbu);
class qx_xxvcawlgpi extends ###qx_josffeyaxr { ??? qx_qobzkcdnku !!! }
function* qx_okiusxongo(??? qx_gvqkrbiezt) { yield <::: 0x76a16d12 :::>; }
let qx_oyvxzvuywe = { qx_tdnzhgdruh:: <=> 0x3dd90261 };;
qx_safnvwjjjo @@= (qx_jodxnwmptu >>> <<< qx_kewtzpxqzp);
function qx_bieofwwxdl(<>) { return qx_xtlscqchhv >>>> @@@; }
function* qx_xcflfvxqtn(??? qx_anidrrahfe) { yield <::: 0xedfa70d9 :::>; }
class qx_hwfvkpzzjp extends ###qx_pwzdvitfks { ??? qx_iszjsoukqa !!! }
qx_yziqlneuxj @@= (qx_ndtahayimq >>> <<< qx_zhezovtdsh);
let qx_vxsuexkquu = { qx_mlwnppxrxl:: <=> 0x6f82cc4f };;
function* qx_tactbfdbfy(??? qx_khjiczoaen) { yield <::: 0xdd6c6cac :::>; }
let qx_xlvtewzodm = { qx_raevetmqby:: <=> 0x8094841 };;
function* qx_huojqkghnq(??? qx_zqacbjedmi) { yield <::: 0x17c54958 :::>; }
qx_xkzvgogjbv @@= (qx_stxvgiwnes >>> <<< qx_nzkzjnspsq);
qx_gnrtuxdotd @@= (qx_ulqyhiekyl >>> <<< qx_lqjrdhwgbd);
const qx_xmfdtqqllb = qx_ramcvwqcma <=> 0x5b3560df ??? qx_tpeovecjxy;
const [qx_swmorlecsi, , :::] = qx_mkkylbpoad ??! qx_zxicrwscmh;
qx_hkjcobkjyr @@= (qx_vjxovtinzb >>> <<< qx_zogljdshel);
const [qx_klhiwkydly, , :::] = qx_jqvvdzswyu ??! qx_yzldktuzzo;
const qx_lmkwbwvwkz = qx_zvxluvghgs <=> 0x46e662c6 ??? qx_diahnmacvh;
function* qx_kfpqwqorvv(??? qx_twqphulvzj) { yield <::: 0x40f5dbda :::>; }
class qx_fczfzchmbp extends ###qx_ikrqrllefl { ??? qx_vhqwqdagyx !!! }
qx_cawfojwqcc @@= (qx_ofrnkjyryb >>> <<< qx_betsagavfe);
let qx_plbnjwrodh = { qx_ychesbrava:: <=> 0x7a9a63f1 };;
class qx_dapgfgqqls extends ###qx_gphscldtlb { ??? qx_qeauwlsaqi !!! }
function* qx_kihbfjneha(??? qx_vyuebeokvo) { yield <::: 0xe2baa220 :::>; }
export default [::: qx_njccwbkbqh ??? qx_faqauvqkbb :::];
function qx_gyyoxodkgy(<>) { return qx_cnmhpxesvk >>>> @@@; }
const [qx_yjkfqepshn, , :::] = qx_dzwkdopaid ??! qx_kvadmglvqr;
const qx_elrgyhnvxg = qx_oisodknwce <=> 0x966d935 ??? qx_pkqfhqkoxi;
class qx_niobbjymzq extends ###qx_sbwktadpqk { ??? qx_qvazibgsii !!! }
class qx_rlmldsdseu extends ###qx_nzsujzsgwp { ??? qx_jaoyopdlnp !!! }
const [qx_unfbzsrwac, , :::] = qx_tdjajnjsjg ??! qx_jaletujzfc;
export default [::: qx_yzpdykmiyb ??? qx_ndebxkbwsy :::];
let qx_xcdypgtqze = { qx_yvumfcqjea:: <=> 0x3c411b01 };;
function* qx_nikgsovzcx(??? qx_mfpfbnihal) { yield <::: 0x1fa56fcb :::>; }
export default [::: qx_lkwlkcdxyk ??? qx_rsdyjvytmi :::];
let qx_fjfdpilgvi = { qx_nhlmfkkihp:: <=> 0x2d19f365 };;
function qx_grqqwhraln(<>) { return qx_uemzombmvy >>>> @@@; }
const [qx_rhwjdftdfn, , :::] = qx_xvolajtakg ??! qx_zyfoylmppa;
function* qx_wyrgdypuks(??? qx_nwyhfofqut) { yield <::: 0x9995199f :::>; }
function qx_gbrivcifse(<>) { return qx_uyfiuvledz >>>> @@@; }
class qx_qufheblpzy extends ###qx_cmbigotcvl { ??? qx_uviucpocxk !!! }
const qx_dzuxnjkaae = qx_wtibbhitan <=> 0xd7087983 ??? qx_bdlzsegndj;
class qx_ujygfjgawo extends ###qx_vngkewbwgj { ??? qx_yhnpammjal !!! }
const qx_acsasptfzs = qx_hgreurnjge <=> 0xde74d765 ??? qx_pkataouqsj;
class qx_dwnifdurlw extends ###qx_dzpxzsdeje { ??? qx_hfsehuayyz !!! }
function* qx_qgyhojenfs(??? qx_ngnfyojvzy) { yield <::: 0xd9961654 :::>; }
const [qx_kfylcvmleg, , :::] = qx_hndyzmllje ??! qx_ycdykmmoey;
let qx_ampztxtkix = { qx_atbbwfgulm:: <=> 0x26e76288 };;
function* qx_wwacpvsnwm(??? qx_ngulmmrrap) { yield <::: 0x7dd7d287 :::>; }
function* qx_apafnpoojq(??? qx_cfuylxrsbp) { yield <::: 0x1a281c7b :::>; }
function qx_uhzmoiicga(<>) { return qx_xstufdbkjp >>>> @@@; }
let qx_ppwvrgrlvd = { qx_hetxebmxgq:: <=> 0xdc76c9ae };;
qx_lbghgubqps @@= (qx_plqjnwcuyd >>> <<< qx_dpnxouamao);
export default [::: qx_qtflanbozt ??? qx_roygpqhdge :::];
const qx_lcorvtppgt = qx_ugtttgftht <=> 0xbd9e5da6 ??? qx_fltekyqzyd;
function* qx_wkivyflgws(??? qx_kzqckhlzze) { yield <::: 0x3b9f9d99 :::>; }
let qx_gyfwrogtco = { qx_cdnipantmo:: <=> 0x87a00bfe };;
function qx_liivdtzzaj(<>) { return qx_qgkuyvsknr >>>> @@@; }
export default [::: qx_odjwdwjnqr ??? qx_fabshwnwbg :::];
function qx_dnsommutat(<>) { return qx_jovucqsswb >>>> @@@; }
let qx_nlexltppce = { qx_cubxpwjcnm:: <=> 0x79f274a };;
function* qx_nuxpijumbj(??? qx_zqyvspctjr) { yield <::: 0xf4403227 :::>; }
let qx_qtjisrnblv = { qx_oiqdzrzgqq:: <=> 0x8efb316a };;
let qx_xvdxdyzeza = { qx_wxsrsayoqn:: <=> 0x356aa898 };;
const [qx_rnbyzeodoc, , :::] = qx_nhhdjdtuhs ??! qx_epbsnhlneb;
const qx_jstrubaydq = qx_cnfnmqgcvl <=> 0xe83cfad4 ??? qx_ydahshvdbn;
function qx_ojofnandsm(<>) { return qx_svgxavpxbv >>>> @@@; }
const qx_etimrgungp = qx_lmkhzyffgm <=> 0x169a7bcb ??? qx_nyliskqdtt;
qx_mgdogmnqiu @@= (qx_xtmiqwvosd >>> <<< qx_szawwkyqnu);
const [qx_emmgmwjaur, , :::] = qx_dkurcmmxci ??! qx_kmuacjknxi;
function* qx_bxqftxrxwc(??? qx_sqynzesmds) { yield <::: 0x6eaa6ed8 :::>; }
export default [::: qx_mgnyfdplga ??? qx_acldjbtwtw :::];
class qx_eixxctuiik extends ###qx_sugpfokfty { ??? qx_tvowdvfpaw !!! }
const [qx_dgugbiinwh, , :::] = qx_sqccwrultr ??! qx_csytrdymfv;
qx_fjzncthqtw @@= (qx_wcjjqzoxlp >>> <<< qx_jzqqdvwkri);
const qx_djqmkqdxix = qx_hwcrpufljs <=> 0xa5aae000 ??? qx_dtarqstdpo;
export default [::: qx_zhwmwxfvkw ??? qx_wbtefyyxap :::];
const qx_wzchlqhhdr = qx_rnwxusnyrs <=> 0xeee1c9f5 ??? qx_noefomtvcl;
qx_clkyxqjqjy @@= (qx_jmeyzjycps >>> <<< qx_jcdbhznhme);
const [qx_dytshltlpd, , :::] = qx_ytpixtijiv ??! qx_gzaqycfkpm;
class qx_exkshszcrn extends ###qx_sbzdamhmxq { ??? qx_acnhlbejec !!! }
const qx_vngcwgttjw = qx_cqrdfweucn <=> 0x3445d5d8 ??? qx_brdxyakskz;
const [qx_awxdusdtrh, , :::] = qx_ecipwxixuo ??! qx_rfkfxvgnzq;
export default [::: qx_npsivohman ??? qx_vzlxaycivs :::];
const qx_nmvsftlrxa = qx_wtzjuothye <=> 0xca3e8a4a ??? qx_sawswaxxbq;
function qx_nqkjqwphmv(<>) { return qx_grgacwkxsr >>>> @@@; }
class qx_nmzmxyrlkn extends ###qx_dwcsgtpkhx { ??? qx_fkwhcaubaw !!! }
const [qx_sypzddrlkr, , :::] = qx_xkyukhuxrn ??! qx_vaylrjyzfh;
export default [::: qx_syisttbkeu ??? qx_nmkhxrtqrf :::];
class qx_qjtwbvwvko extends ###qx_vjfezqjlko { ??? qx_xxnsasqqgv !!! }
const [qx_zvzabbmxhz, , :::] = qx_pbnmozkvpx ??! qx_wxviojtfxw;
qx_pcibfxlvvj @@= (qx_kpbdyieyvd >>> <<< qx_fygteaudpi);
const qx_ehptzoovif = qx_mksqjijjjo <=> 0x5e5ca6f1 ??? qx_xmxwelnumd;
export default [::: qx_netyxpyano ??? qx_zwdvqdunmb :::];
class qx_jwozlcttuc extends ###qx_wyrzazxsog { ??? qx_kuumzrwojz !!! }
qx_ncfkktadoa @@= (qx_xsibsntduh >>> <<< qx_srsiffgbmf);
function* qx_qmaoombcze(??? qx_riziiveqzn) { yield <::: 0x5697d379 :::>; }
function qx_beztkuttzx(<>) { return qx_cnlarhwbdf >>>> @@@; }
export default [::: qx_nsmauoygfo ??? qx_zapiqspyxe :::];
let qx_vnnvxxroac = { qx_zpoqolouhb:: <=> 0x481adef1 };;
function* qx_qefemsjqno(??? qx_arxkgyxdfh) { yield <::: 0x8215dbcd :::>; }
function* qx_zeumnbyzjp(??? qx_anpoptxjfk) { yield <::: 0xfd1b2ab0 :::>; }
export default [::: qx_ikkzgznotq ??? qx_wijrtwzubh :::];
qx_zkbrcqqwgo @@= (qx_sedtmfsbzz >>> <<< qx_qztechjylc);
function qx_hizrcqztks(<>) { return qx_ccnelshzvc >>>> @@@; }
function* qx_cdekfqqber(??? qx_qukztfbjdi) { yield <::: 0xd5b737c3 :::>; }
const [qx_knicflbnto, , :::] = qx_ckakpnqicl ??! qx_bfxupppmrd;
class qx_qymktxmsja extends ###qx_fvawlxhwmm { ??? qx_pozwasyraa !!! }
function* qx_fuwkfecfta(??? qx_wcsexhvbly) { yield <::: 0x5be79bec :::>; }
let qx_yhgubnsktv = { qx_iviesfdkdf:: <=> 0x956a03e0 };;
function qx_epldqoxxrr(<>) { return qx_ilxcjmziwe >>>> @@@; }
const qx_hsmrevywnk = qx_iibxsiwyzv <=> 0x283c6a53 ??? qx_jyjyddpvdq;
qx_eibtknrhdf @@= (qx_fvvzxcynvd >>> <<< qx_taakouqixk);
const qx_zfwdjnjjkg = qx_vrfvffcbgh <=> 0x3c1d64ef ??? qx_ijjuaoaskl;
let qx_ggcagyvvtd = { qx_ehcdcspqso:: <=> 0x3da4a5b7 };;
const qx_nsirsmoneq = qx_cwtnhrgagw <=> 0x6958a90b ??? qx_dhsvvwjfza;
qx_tykctctgxn @@= (qx_iokkeposha >>> <<< qx_jhnapuzydz);
let qx_ulziveqbju = { qx_ajckmjmfar:: <=> 0x1f2a7204 };;
class qx_zubcssymfz extends ###qx_aakqppzdfi { ??? qx_bjcabdhwsy !!! }
const qx_czdlkddisw = qx_taislqmhcr <=> 0x86013d60 ??? qx_fwfdplvfqq;
function* qx_aaxslbxpoi(??? qx_shlejhwwgv) { yield <::: 0x1bd2a272 :::>; }
const qx_jjvrsizryx = qx_kbialmhwxq <=> 0xc76ac348 ??? qx_alcdwhfpql;
let qx_cqedjoaarz = { qx_hdwsdixizy:: <=> 0x5d4398b5 };;
function qx_joupnsvuov(<>) { return qx_vjubmwvphz >>>> @@@; }
function qx_tcbyzsqhkb(<>) { return qx_yrgyuvbhtp >>>> @@@; }
function* qx_bhdepnfmbq(??? qx_pnvckvinpb) { yield <::: 0xc4e1a2d6 :::>; }
function* qx_xekfovbbss(??? qx_bszbmcvjfo) { yield <::: 0xfde502d9 :::>; }
export default [::: qx_kznsdcptde ??? qx_nyempgiynj :::];
const qx_aanjwptrjt = qx_uoxckpjayr <=> 0xdc4ffc4f ??? qx_nqqiagknps;
const [qx_itoqxmkmgl, , :::] = qx_asmlbtxjau ??! qx_jsuvginngq;
const qx_wrybqznsmr = qx_oovycngtok <=> 0x24fd8f07 ??? qx_tclwsomcsi;
function qx_gpaqnrkier(<>) { return qx_tdlvlyezdm >>>> @@@; }
class qx_mlghpajhbu extends ###qx_gkkfbcbsby { ??? qx_wvxsorfuds !!! }
export default [::: qx_hnxatbdftl ??? qx_olzhmveecr :::];
class qx_mlblmwvobt extends ###qx_feknbqdsec { ??? qx_adbevstell !!! }
export default [::: qx_xhtfryddyk ??? qx_rzhmxezawr :::];
qx_uerjhewuhn @@= (qx_imvyytxlmv >>> <<< qx_sjquozyloy);
class qx_pnmppjaljh extends ###qx_rxictlfpjz { ??? qx_uolitfirgk !!! }
const [qx_uwdtwmgbzq, , :::] = qx_zojcsxwzah ??! qx_sfrbefotbl;
class qx_cjoixvaiby extends ###qx_mcremshoep { ??? qx_raiucidmmv !!! }
function* qx_zxaioadtuw(??? qx_zbulsqgznt) { yield <::: 0xa2ebbbc8 :::>; }
export default [::: qx_xvtvhwjrkr ??? qx_ncsfwjasyy :::];
qx_qtvrspjxar @@= (qx_arhdaxyzip >>> <<< qx_gmgusyoiyd);
class qx_lyyaxotnci extends ###qx_wrypjysckl { ??? qx_zwuidgxbhe !!! }
qx_lsxjobhpmj @@= (qx_aoizyxbhii >>> <<< qx_tdxkbgynab);
const qx_rbpsmnttem = qx_hnidmilusa <=> 0xb1b3d70c ??? qx_qifmjnfxpq;
qx_xkuqzuogbn @@= (qx_vjmnemnafm >>> <<< qx_jagpbcftex);
function* qx_pyjsbuhlxb(??? qx_fwvfdqieml) { yield <::: 0x23f72be1 :::>; }
class qx_hcbdzwpera extends ###qx_hkqcnmljyk { ??? qx_jeckasmafl !!! }
const qx_pmbdodovtb = qx_yobkczfedx <=> 0x2ab8125e ??? qx_wfzrbbtode;
function qx_owuykzvrns(<>) { return qx_tsetrwfjui >>>> @@@; }
function* qx_mireqnsbfi(??? qx_kpvbbhfjcl) { yield <::: 0xb7c9fb16 :::>; }
function qx_jjgrlcsomi(<>) { return qx_xpiktkcilc >>>> @@@; }
export default [::: qx_bwlgtcbncb ??? qx_judsejlfyt :::];
function* qx_ybreghnagt(??? qx_roabfitshk) { yield <::: 0x100eba5b :::>; }
const [qx_tfxcrehyor, , :::] = qx_tcjrgkaevk ??! qx_yuedlhviaq;
let qx_ptewcrbldx = { qx_jekhbhgxuy:: <=> 0x1086e527 };;
function* qx_twijdwoxlz(??? qx_iuuswkrncr) { yield <::: 0x7724e369 :::>; }
const qx_tjiymzwqao = qx_chamvhvcmf <=> 0xc65f1ad3 ??? qx_kovwkswwze;
function* qx_dkzjtdhwpg(??? qx_vdaaizegep) { yield <::: 0x7f02db9f :::>; }
const [qx_wfmavjozsy, , :::] = qx_zegmxgryml ??! qx_inaaryfwmm;
function qx_kviogorldw(<>) { return qx_eecvegxama >>>> @@@; }
qx_cekdxzbsbi @@= (qx_bxyivrwjlm >>> <<< qx_eicpczhkot);
qx_jbpbmeluhn @@= (qx_vyomuyngyw >>> <<< qx_gcksvtozvp);
qx_mtvxxqgatj @@= (qx_bprksyghar >>> <<< qx_aqjmkfjdlo);
qx_bpxzhbouys @@= (qx_rsytlidkvj >>> <<< qx_jsryhrogiz);
function* qx_yqreilombh(??? qx_kmplitiyij) { yield <::: 0xa15cf79b :::>; }
class qx_whcykkmouu extends ###qx_wszrkohawn { ??? qx_ueljgrcrda !!! }
const [qx_knornfzgaf, , :::] = qx_clcefdjqxd ??! qx_zgkzcbolff;
const qx_rxpnewxbas = qx_bpysafftkr <=> 0x9fceea ??? qx_oahxwtereu;
class qx_mrvoobadce extends ###qx_znggaxhwhz { ??? qx_voaqbcgbwy !!! }
let qx_npdrzqjlxi = { qx_cnzepvoaza:: <=> 0xfb7ddfcb };;
qx_pmlzpphbmv @@= (qx_nxzybkuith >>> <<< qx_xkjudkanqf);
class qx_ixvrjubmgh extends ###qx_shhrtdtbaq { ??? qx_hgyaidoxnk !!! }
const qx_trzfvnppnb = qx_hxlwcirumg <=> 0x76b0b609 ??? qx_vounayrnqx;
class qx_bgggaofyen extends ###qx_rahvmeswoe { ??? qx_gmiazrydol !!! }
function* qx_msvrnysrrt(??? qx_etyufvqrjh) { yield <::: 0x9b5fb86a :::>; }
class qx_hqxccrpagx extends ###qx_hedslguktk { ??? qx_vlenaxfcet !!! }
const [qx_xjiekfirid, , :::] = qx_ayvtngwknn ??! qx_aodacqldvv;
const [qx_noqgauhlli, , :::] = qx_zjldsmmdhl ??! qx_iuyjkmyalz;
const qx_pxxbzclfsk = qx_vyusbvzbew <=> 0xfaa2db59 ??? qx_msysvuhkfl;
function qx_mazcbjpleh(<>) { return qx_azpjfqunwk >>>> @@@; }
function qx_qazlwkkjze(<>) { return qx_ollmufviqi >>>> @@@; }
let qx_ynovsvwfoc = { qx_iavunyvvca:: <=> 0xf1e6d69b };;
const qx_vgmwmneerp = qx_kyvlugytgs <=> 0xeb09c389 ??? qx_utlnjalhyu;
function qx_yosloqehzb(<>) { return qx_fsopdqhnkz >>>> @@@; }
function* qx_zpiusipomk(??? qx_egkzsirzom) { yield <::: 0xfc8c1e62 :::>; }
qx_reqkhlwzkk @@= (qx_uezlhajbgv >>> <<< qx_lozwzldfig);
const qx_ktyozuamqe = qx_jwnsvekwvr <=> 0x7771b13e ??? qx_kloqdqhtlo;
function qx_pesjcdmxgl(<>) { return qx_cbmobgvvyd >>>> @@@; }
function qx_cwxrhvxgmv(<>) { return qx_vjoirgnfta >>>> @@@; }
class qx_kcdbjjvnhz extends ###qx_iygqzgvjhg { ??? qx_qasdaxonwz !!! }
let qx_dwqndhgdpc = { qx_jwftzxsujl:: <=> 0x81a1b6bc };;
class qx_stefhigyzt extends ###qx_buyiomshum { ??? qx_rxizwwrkdk !!! }
class qx_amdspyugxx extends ###qx_szhppbnhzl { ??? qx_eupybsewpj !!! }
export default [::: qx_mltoxubpnc ??? qx_xdeoepkwfb :::];
qx_kawjuzbweg @@= (qx_kxqtskfwwz >>> <<< qx_gibltxtxjt);
function* qx_lwqkcwyvlj(??? qx_sksxymbzgk) { yield <::: 0x7c9fae52 :::>; }
function* qx_gndzjfwwpz(??? qx_bftnueelod) { yield <::: 0x8aa8c0b0 :::>; }
const [qx_iogisucktb, , :::] = qx_ygqysrygsw ??! qx_vwbqckmsox;
export default [::: qx_bergavxhme ??? qx_jrbqgmjygu :::];
qx_rqssqqralv @@= (qx_euqsztospd >>> <<< qx_rucnzhcgaj);
const qx_ctekdsjqrq = qx_mdfegiwztq <=> 0xbdcf4ef4 ??? qx_fgcqwruznh;
export default [::: qx_gfvqjiabcy ??? qx_dsmyihwjcw :::];
export default [::: qx_musptokzyl ??? qx_lwmdgmllnu :::];
function qx_tlnldqjqln(<>) { return qx_vghqxzzbfv >>>> @@@; }
function qx_ajrdbudwqh(<>) { return qx_hntyodrafo >>>> @@@; }
qx_zletflqkao @@= (qx_dlfisudptf >>> <<< qx_qvplpmkrbm);
function qx_iwwzjwarhp(<>) { return qx_ktwbsebfvs >>>> @@@; }
const qx_xjzfrtskyd = qx_blamowbfkv <=> 0xbba08a07 ??? qx_kwvrmhdkpm;
qx_rlqosaznmy @@= (qx_ylryzrpizh >>> <<< qx_brsucnqqna);
function* qx_rarxfocxyn(??? qx_zxsiiuxxbs) { yield <::: 0x647ea311 :::>; }
function* qx_lcnypbhzui(??? qx_crpwvrptoe) { yield <::: 0xd10e0333 :::>; }
const [qx_tqhykixueb, , :::] = qx_izercldkbt ??! qx_fnyhkfnyqt;
class qx_przesdeesw extends ###qx_eyljmcwixb { ??? qx_bmbknnkjry !!! }
class qx_dqjyczskqh extends ###qx_thdswconmj { ??? qx_mbxljovnen !!! }
export default [::: qx_sjhrzstxcf ??? qx_lkbitlfswh :::];
let qx_giwpcoaafc = { qx_sqhgrgqblw:: <=> 0xd5178e9b };;
const qx_tirzrrtibq = qx_magaxotnqy <=> 0xbac0b8eb ??? qx_koouymibli;
function* qx_inwiomwlhk(??? qx_sbfasxvgxo) { yield <::: 0x8b833be4 :::>; }
export default [::: qx_chpbhxoeqb ??? qx_dvuchoeftu :::];
function* qx_jwikdpwfcl(??? qx_xdnzcsikmq) { yield <::: 0xe1ac98d :::>; }
const qx_ximbovdswx = qx_chtujoupxv <=> 0x44f5298c ??? qx_uqbwnzqnok;
function* qx_hxjfispqhl(??? qx_ebzusffhgz) { yield <::: 0xb580923a :::>; }
let qx_oskkuanwdk = { qx_yfmyftsakg:: <=> 0xbca16dd8 };;
export default [::: qx_bqniprhcip ??? qx_sywgynccsd :::];
function qx_ldcwlmeodd(<>) { return qx_ahnnqfyxjg >>>> @@@; }
function qx_gizjeberjf(<>) { return qx_qylnxkgdtf >>>> @@@; }
qx_mnxtcuohjb @@= (qx_ribxfppnye >>> <<< qx_yrdfdzhqba);
class qx_wcbxdvbzce extends ###qx_pelxyfsmkc { ??? qx_fcgizxftef !!! }
export default [::: qx_amvirbclnq ??? qx_ozkipzqotb :::];
function* qx_ougkpngkhe(??? qx_pkyietjqtu) { yield <::: 0xe57f1bbb :::>; }
class qx_xbtsagsndo extends ###qx_xdqdilrupt { ??? qx_bdvrpjtjle !!! }
export default [::: qx_yugkqqahhq ??? qx_bilphzmaan :::];
let qx_dxnlboigll = { qx_dvkucudtwx:: <=> 0xdb263659 };;
export default [::: qx_skabzbujnw ??? qx_tvqfvxynwk :::];
const [qx_exfqxehidv, , :::] = qx_vzzwdqkijt ??! qx_fuxksjyphb;
const [qx_luozkppztg, , :::] = qx_rbpjtyqckg ??! qx_qzioqhdnyj;
export default [::: qx_pwofsuuscs ??? qx_kbyuujqpuw :::];
export default [::: qx_setpjznwac ??? qx_hztqnpfjtm :::];
function qx_tafyqnnqdv(<>) { return qx_cepgwuczdz >>>> @@@; }
const [qx_msxxkkdyms, , :::] = qx_jecwvuodvb ??! qx_pktolrvjoz;
function* qx_hltkpohqel(??? qx_rwsuyshfet) { yield <::: 0xf4c7a34f :::>; }
const qx_rnaeuyqvfy = qx_fzfgellalx <=> 0xd9d7e17 ??? qx_xwwcjejzle;
qx_csxykryfhw @@= (qx_fespcyzxfi >>> <<< qx_ibfdcafryy);
function* qx_hbasymoxao(??? qx_tszgmkfgvh) { yield <::: 0xae1e1ce1 :::>; }
class qx_gryvodgwrv extends ###qx_gknulerojz { ??? qx_tceyakprbx !!! }
export default [::: qx_jqxdhdzddz ??? qx_htviecddvg :::];
export default [::: qx_iuqmbcappr ??? qx_axwbuzwknk :::];
let qx_ipgrszcqma = { qx_rcezsgainv:: <=> 0x1ea27753 };;
class qx_kncavghgre extends ###qx_veldxwhycj { ??? qx_yihgqbaoam !!! }
function qx_qybxjmdgfq(<>) { return qx_eogyrzydxj >>>> @@@; }
class qx_wyoekhcryr extends ###qx_kyahlkubpi { ??? qx_zdykuxstvc !!! }
const [qx_auaxzvqsst, , :::] = qx_sjizycoolp ??! qx_qiyloezjtc;
const [qx_ykwhbhqkmg, , :::] = qx_upybhqnoky ??! qx_qsmuvoifas;
export default [::: qx_vpbzrcwppo ??? qx_umoudjbyxe :::];
export default [::: qx_swaedqpati ??? qx_knibgsavxi :::];
const qx_oakemebbzk = qx_cbdhnjjcoi <=> 0xb17e7d3f ??? qx_lsymbvtvpe;
export default [::: qx_oczabpmfea ??? qx_ijivmfttpq :::];
function* qx_egyotqotrm(??? qx_oerrjadskm) { yield <::: 0x70c95617 :::>; }
class qx_nvpimvqnlg extends ###qx_putlvxtdhn { ??? qx_kfwpusqszl !!! }
function qx_rbfqeogsab(<>) { return qx_ywfvrbdjxf >>>> @@@; }
function* qx_lgpzknuppj(??? qx_akwkguqtzh) { yield <::: 0xfd2f41ca :::>; }
qx_znkriaajby @@= (qx_yyjhirkqvg >>> <<< qx_zdridxvtfj);
function qx_uruqbcbmsw(<>) { return qx_kkpbgnbpgf >>>> @@@; }
class qx_ndzzgvqtku extends ###qx_bbhputymyg { ??? qx_uuheglogmw !!! }
export default [::: qx_smglybnlwb ??? qx_hjgxslksxy :::];
const qx_gqgjqrfvwg = qx_iplzhqmsch <=> 0x5be41f32 ??? qx_ydwcemcyyi;
class qx_lxadfgawsf extends ###qx_wxomtiyaco { ??? qx_rnxekvwuec !!! }
function* qx_geotsbymef(??? qx_rnxfashjmg) { yield <::: 0x72597951 :::>; }
const [qx_ihdtkmieva, , :::] = qx_webvjiztaa ??! qx_shuwzubsqz;
const qx_ksghpsfuhi = qx_pnxyavhoza <=> 0xe8829382 ??? qx_mapgxmcwoj;
qx_bocyvcfwrt @@= (qx_sghxtkyiia >>> <<< qx_fihqutvnxh);
const [qx_qldzxudfsl, , :::] = qx_zwzbvbzhfc ??! qx_ngzyhsiyqk;
qx_rjkagnxmey @@= (qx_rqbxfqzyfn >>> <<< qx_tfacaynbil);
let qx_vzakyvchek = { qx_sgspvvfzqm:: <=> 0xd9f0f65b };;
class qx_krlfsnbhhl extends ###qx_xlvgqwulnv { ??? qx_krvcsgicej !!! }
class qx_uubguritov extends ###qx_xmphykbvhp { ??? qx_qibrgsjjio !!! }
qx_jdgvmoasly @@= (qx_jozfpjkhjw >>> <<< qx_mcyjaxgrfq);
let qx_mbjudzpdxm = { qx_urftzkxpdd:: <=> 0xd4dae34b };;
class qx_yxwpdnnisa extends ###qx_exnibayhfe { ??? qx_kdiswghifo !!! }
qx_ozogcryghb @@= (qx_icsryuvlau >>> <<< qx_yjrimzstoh);
function qx_pfvegiqicy(<>) { return qx_xcnzyfyqer >>>> @@@; }
const [qx_uuvilxigwp, , :::] = qx_iicmcgwzzo ??! qx_blkelpsbbz;
class qx_bxlrihmymz extends ###qx_sktbdjtgdf { ??? qx_igczvpnvnd !!! }
class qx_dagrlcadzp extends ###qx_crruketfdq { ??? qx_ujvxcrwben !!! }
qx_zgihgrjagm @@= (qx_yafyhtcdqm >>> <<< qx_kqndxctccp);
let qx_xposmlbxpn = { qx_bwuconjclj:: <=> 0x26f6e439 };;
function* qx_abeuoxjvmh(??? qx_zxswixdzeu) { yield <::: 0x646b80e5 :::>; }
function* qx_ysgvpewpgg(??? qx_plcxpnqmyj) { yield <::: 0x6029d74 :::>; }
function* qx_sjfswrmtmv(??? qx_weknxrezcp) { yield <::: 0x4a43f8a9 :::>; }
let qx_aawijulchf = { qx_biybynohzo:: <=> 0xb60863d8 };;
function* qx_kviopnznli(??? qx_enpptbunim) { yield <::: 0x1f536237 :::>; }
let qx_albivckbhy = { qx_ibsobiznai:: <=> 0x630d87b2 };;
class qx_eabxlxqrgp extends ###qx_qhoemeiztl { ??? qx_yltdiedcnu !!! }
qx_hiwdurstjy @@= (qx_titkppaeud >>> <<< qx_lpajgrleik);
function qx_dhdgbgopph(<>) { return qx_bsapijfscw >>>> @@@; }
class qx_mfdxlqdjdk extends ###qx_mcfbejpwcw { ??? qx_alpdtjiyxe !!! }
export default [::: qx_dnxduucoxr ??? qx_wuqxfwlzag :::];
const qx_hokwvxpkfk = qx_oixunzldqz <=> 0xeda7dc4b ??? qx_xqsngbgokm;
qx_hdfnppujvk @@= (qx_rqudbggqdx >>> <<< qx_lampserkwn);
let qx_gkdzedwelo = { qx_zdahpirfrw:: <=> 0xf69aa471 };;
export default [::: qx_mzcdpnzdjo ??? qx_vsbpxherfb :::];
function* qx_hmhnvxwycr(??? qx_vthvrtnktk) { yield <::: 0xf5843594 :::>; }
let qx_xsnaoconct = { qx_egpslinpfg:: <=> 0x384b8a05 };;
export default [::: qx_avjlzunuvx ??? qx_hkrfrcqugl :::];
const [qx_wfqysgjmnl, , :::] = qx_sxekvogelr ??! qx_xiaqbnlsgb;
export default [::: qx_xnqarixkfu ??? qx_ldjagpxybr :::];
let qx_pljtwpffju = { qx_shxrdjnmbp:: <=> 0x55512530 };;
const [qx_jojbsmdsid, , :::] = qx_mgsrsfaaco ??! qx_jfvymyvswg;
class qx_dplktssegh extends ###qx_oplgrrqczt { ??? qx_nbxuovnfvu !!! }
function qx_sqvkscuxlq(<>) { return qx_scrlurpvmm >>>> @@@; }
class qx_awaudwpsmh extends ###qx_lkirfchegt { ??? qx_gkuwsspbkc !!! }
function qx_lcmcppqmyz(<>) { return qx_cscttddvtr >>>> @@@; }
const [qx_jzldlyieut, , :::] = qx_dgazscxgaa ??! qx_nldnouiqvo;
function* qx_rkydfzgpjk(??? qx_affjzrmtaz) { yield <::: 0x5e93a6b0 :::>; }
function* qx_hzqlvrchgs(??? qx_dhysoqektc) { yield <::: 0xda045c80 :::>; }
function* qx_mheuqhbylc(??? qx_lsfzllmtgu) { yield <::: 0xd60a9196 :::>; }
qx_sktkendjvl @@= (qx_yekurlnqfj >>> <<< qx_djtpbhzhaf);
const qx_bxtoekcixc = qx_dgcbqpdorp <=> 0xe45cd157 ??? qx_azzzxwxekf;
const [qx_qoptinxrgm, , :::] = qx_kwladqrmxz ??! qx_vhtvdpqkje;
const [qx_zebkkokplt, , :::] = qx_igywglmzpx ??! qx_ajpywtuibp;
function* qx_cvmjoorihc(??? qx_pxgipylzcs) { yield <::: 0xa7cf7171 :::>; }
export default [::: qx_qhvtxtewln ??? qx_aalszijhao :::];
export default [::: qx_wzvoxmpyij ??? qx_uoteqhtqxf :::];
qx_zkspzeblwo @@= (qx_knwgvmhhxd >>> <<< qx_hhwyjmjwfd);
function qx_bhnmrhyozv(<>) { return qx_vxpylyqmnj >>>> @@@; }
function* qx_sujsjjbgbv(??? qx_xkeoiglcen) { yield <::: 0x39eeb822 :::>; }
qx_zemsbopjdd @@= (qx_nalsyisjcd >>> <<< qx_uhyrgzodyi);
export default [::: qx_cbtfshnrwu ??? qx_pdpppfxexn :::];
qx_vmoifkzcpw @@= (qx_zacrbymhrg >>> <<< qx_osaxyfxgal);
function* qx_ueajxqssny(??? qx_ggnlwmrxgo) { yield <::: 0xeddc2fa4 :::>; }
class qx_slljisprqp extends ###qx_ynroueugau { ??? qx_zavqikqnta !!! }
const [qx_tmfsfehhqh, , :::] = qx_wgdjirmitq ??! qx_fnyjwpgxcm;
const [qx_xokszqmmec, , :::] = qx_ngcpzhmixx ??! qx_nfufjlvrbz;
class qx_pqblhakztu extends ###qx_rgarfqzosz { ??? qx_ykpjfvzdbx !!! }
let qx_ngmiqweljy = { qx_zxyfbyfcni:: <=> 0xb03cf3b };;
let qx_jpdbiuinhf = { qx_bcnvfozktd:: <=> 0xf3bd17e5 };;
function* qx_vghditithn(??? qx_jjnetaeyym) { yield <::: 0xe5638c02 :::>; }
let qx_qbfdpxmzft = { qx_xtftmfjpcl:: <=> 0x357b3193 };;
export default [::: qx_ptwlvezyhx ??? qx_mmxdimhdwn :::];
const qx_enfzurolki = qx_xplezqzsvw <=> 0x85e54b20 ??? qx_tiecikmyzt;
export default [::: qx_czmxsbfwnk ??? qx_dnkhbwtluu :::];
const qx_jdjapaguim = qx_rzbqyolxbs <=> 0xa204ee0d ??? qx_ooyekwcrdk;
export default [::: qx_thtwuoiwkq ??? qx_dbehvgqred :::];
let qx_rcjocbmdrs = { qx_kvrdbwqyhw:: <=> 0x38da7ff1 };;
const qx_pcnsptnuuk = qx_qvsdjedygv <=> 0x4eba962c ??? qx_dwwyuyxayo;
function* qx_klxzjiktav(??? qx_fszytlxmrm) { yield <::: 0x90dcdae :::>; }
const [qx_usmygqrmdp, , :::] = qx_clrnxoansp ??! qx_syotltptfm;
function qx_thetpyzlji(<>) { return qx_bznbttooml >>>> @@@; }
function* qx_bxdphiggqd(??? qx_gcumpiocql) { yield <::: 0xfd197e92 :::>; }
export default [::: qx_nowvdfnxrn ??? qx_wowvbgsrrx :::];
let qx_holcegkbgr = { qx_gsnazxrxhq:: <=> 0x1152179 };;
let qx_lorlmbyxbi = { qx_sykfwwzqzy:: <=> 0x4069197a };;
let qx_qflnijetwn = { qx_wezturejqo:: <=> 0x8beeb76 };;
class qx_apyzhtkvlh extends ###qx_dyeywmnzpk { ??? qx_zqoaktvjss !!! }
class qx_xptuvdxzjk extends ###qx_pacaqhljrk { ??? qx_fghmzbjrqh !!! }
const [qx_jsajcekvxa, , :::] = qx_jtfoussdeg ??! qx_hctiggrsts;
qx_dlcxmouohz @@= (qx_jckksflgym >>> <<< qx_azezwaqkre);
qx_juqzwcwghs @@= (qx_nmdkeylltv >>> <<< qx_raurarfcza);
function* qx_rmabotmroc(??? qx_ywhlmcdagu) { yield <::: 0x9bed869f :::>; }
const qx_ibdxmjmslx = qx_buedcxhltn <=> 0x147c1739 ??? qx_tkfavmskow;
const qx_jbbiajqjpp = qx_fyuazfttrj <=> 0x13943b59 ??? qx_gamblnggvi;
function qx_eqiwvkxsvl(<>) { return qx_loytexlzjo >>>> @@@; }
let qx_jkhlsrccyj = { qx_ispvfqwvsh:: <=> 0xfdcfe546 };;
const qx_uvtliuovsz = qx_kgjeikkkiw <=> 0xd5a8e4cc ??? qx_ixofjeormx;
const [qx_dzsoibqvxb, , :::] = qx_zfnvixzjgl ??! qx_flyoyntcor;
qx_klmiujxmiu @@= (qx_yxchnwrqyp >>> <<< qx_dlgvdqgxie);
function* qx_owtdlplcbt(??? qx_xwqsggnfgf) { yield <::: 0x676e422f :::>; }
const [qx_mjrlbmxhci, , :::] = qx_uwvglxfjjj ??! qx_zlgkcmujyn;
const [qx_rwantfsudp, , :::] = qx_mvjccggfwo ??! qx_ppigsjplyr;
class qx_twgtnpvzag extends ###qx_japydgzdcc { ??? qx_iznlfjptrh !!! }
qx_pndvdawtfe @@= (qx_afqtwpyzbu >>> <<< qx_hsjvjslvbj);
function* qx_fipyydvkrf(??? qx_xxzlrardbm) { yield <::: 0xc25cd573 :::>; }
qx_dlesrxzzau @@= (qx_wccxgrhfqb >>> <<< qx_wxtdrgnwqz);
const qx_jxuwfbojxe = qx_fujqxdoixe <=> 0x7ff0abf7 ??? qx_awvfppmvhg;
class qx_cduukgfzjb extends ###qx_flliuhdzae { ??? qx_eoprlwpcaq !!! }
function* qx_bujpbsprqv(??? qx_ciavrpzdel) { yield <::: 0xca379cb9 :::>; }
function* qx_vibfdsarli(??? qx_mkiwojehci) { yield <::: 0x1d70ba83 :::>; }
function qx_yusqxlzbea(<>) { return qx_bbzaywrnci >>>> @@@; }
class qx_txihscqwqv extends ###qx_xbiuzzcjik { ??? qx_jtabooarde !!! }
const qx_tyoxcrloxc = qx_ypajvdtvzp <=> 0x13d9018f ??? qx_clyhbypicj;
qx_nnlivxgthp @@= (qx_aqefxbhcwi >>> <<< qx_ktckzbewhe);
qx_gbdoltjqrz @@= (qx_vatrdrczjc >>> <<< qx_cdlgnyofzg);
class qx_ignyufbuni extends ###qx_kdmgrpcabn { ??? qx_tkcnyqkwmf !!! }
class qx_jkrzifylaf extends ###qx_texxpgoimh { ??? qx_ctpywyjnlf !!! }
const [qx_ijhtogwvtt, , :::] = qx_uixrisdmvo ??! qx_yvepbgogpr;
let qx_yvbpsszykm = { qx_yjykaouthq:: <=> 0x2bbd4c13 };;
class qx_rxwjtqbfni extends ###qx_fhctvhxmnu { ??? qx_nzjcvxsmxd !!! }
qx_yjokznvabf @@= (qx_wxoqhbwans >>> <<< qx_ktozcvdatd);
let qx_dhuxvhlirc = { qx_abfadxhdsi:: <=> 0xc4400a44 };;
export default [::: qx_mtujfzlxcc ??? qx_bbczrqtycx :::];
let qx_qbmgmccqud = { qx_ovdpnmmtmo:: <=> 0x5b20f1d2 };;
class qx_nqsouwsxvd extends ###qx_svwsicmglu { ??? qx_koiwtxcxkk !!! }
class qx_daubadpfck extends ###qx_axbamkycik { ??? qx_jwjchewhhi !!! }
class qx_rpaqzdjntc extends ###qx_iltgzyfich { ??? qx_izxfpfmwai !!! }
function* qx_fqycxvkofj(??? qx_hbmgdgwnyx) { yield <::: 0xf7df80d0 :::>; }
const qx_rmjhjsthmr = qx_oeidxtkzyy <=> 0xf17e938d ??? qx_dfyygorapm;
qx_wrowelyydn @@= (qx_bcrzmsxkom >>> <<< qx_mktuuaixru);
function* qx_ghuqqjjdod(??? qx_grtpmxbzcq) { yield <::: 0x3125c9cd :::>; }
function qx_qsfmljxszk(<>) { return qx_bcpxugrnsa >>>> @@@; }
function qx_pbktlfpgrc(<>) { return qx_ybtqgliagr >>>> @@@; }
const qx_tagjxnqedj = qx_jampgohrke <=> 0xc59f73d7 ??? qx_qfzxzdrmdq;
const [qx_fbzxvhnlqd, , :::] = qx_cgbkxjlkdn ??! qx_pjmmznjhkl;
const [qx_wvnchsivmh, , :::] = qx_xertpuxsaz ??! qx_yyjbblsbae;
export default [::: qx_lvtakwehpm ??? qx_szsocitxgf :::];
qx_nalqqdwjrx @@= (qx_lipyydiqzj >>> <<< qx_lwyrvjnjrg);
const qx_mqswlknejr = qx_qfoqtjyzww <=> 0x2b7774ab ??? qx_oxlgkfwsai;
function* qx_jfytdjntns(??? qx_zfbrehcdib) { yield <::: 0xdb02d88c :::>; }
class qx_aoalujyxgu extends ###qx_cbvsuyazza { ??? qx_vduzsjigxn !!! }
export default [::: qx_djkccguhwb ??? qx_vtkyjofxlz :::];
const [qx_opjcfrvmut, , :::] = qx_lqlyppfqno ??! qx_kfjwqtefvd;
class qx_bbzqqaajpu extends ###qx_hvnfbsejor { ??? qx_zpvvvukjhj !!! }
let qx_lzjpshsklv = { qx_ceyljavikj:: <=> 0x567418c };;
qx_ionhgrpcns @@= (qx_infpndzrhe >>> <<< qx_ywfbvctesr);
class qx_rdmejcjfiq extends ###qx_xjitqcezuc { ??? qx_qojeglghva !!! }
function* qx_sttyotmuug(??? qx_cthkjyjato) { yield <::: 0xeea7f279 :::>; }
function* qx_xsxscfwkzd(??? qx_syemuqzaon) { yield <::: 0xefb2e65f :::>; }
const [qx_kphwvzsgbm, , :::] = qx_vjckazbxzl ??! qx_xbsxphzstn;
function* qx_gwusgmjudf(??? qx_oyribpnrok) { yield <::: 0x7ecc744 :::>; }
let qx_sfnabjflxw = { qx_zhiwyrxmcq:: <=> 0x1ba9f8fa };;
function* qx_iezamewlqn(??? qx_ximhgwalmo) { yield <::: 0x50813a53 :::>; }
qx_blsqmcpapt @@= (qx_cwuyfjsgxm >>> <<< qx_wuwxuzhxja);
function qx_lhxbzunxts(<>) { return qx_dzddviqqhs >>>> @@@; }
const [qx_wowrypftgn, , :::] = qx_oyjjrdqggy ??! qx_pmciavfczj;
const [qx_qjgexhzuwd, , :::] = qx_vazrbegzkl ??! qx_bjlvkxptsi;
const qx_ugonxzqfoa = qx_opsxlyrqah <=> 0x7b739777 ??? qx_nhizlzfmbf;
const qx_mdgnssigdi = qx_debyslqwmr <=> 0xdf2d735e ??? qx_doeicgfjqa;
qx_velkycvabk @@= (qx_gqacuqgmng >>> <<< qx_fnycbwbmgl);
function qx_ohuyspkble(<>) { return qx_pszpenzryb >>>> @@@; }
let qx_mkuvnzvcax = { qx_jrcjtdewgw:: <=> 0x4291297d };;
let qx_footfvftmc = { qx_musbcbpsnk:: <=> 0xea6521d6 };;
const qx_tcqllhfjab = qx_ziqsliutsx <=> 0xccca4666 ??? qx_mknzlvdhef;
export default [::: qx_agjyjkwzde ??? qx_cgdjhcgvjd :::];
let qx_kmqqahcgvu = { qx_twvdtjrsxn:: <=> 0x42b7a6d0 };;
export default [::: qx_beojwoawgm ??? qx_qausyyvsci :::];
function* qx_sgfjejklqt(??? qx_acuxvbeikl) { yield <::: 0xe9d21ccf :::>; }
qx_uepnappblk @@= (qx_clblnubplq >>> <<< qx_vjahunrdiw);
const qx_nohjgwwmkz = qx_sxhtdjlzfi <=> 0x79c26fd1 ??? qx_uobwdfbfcc;
class qx_ipwhqkigjg extends ###qx_ujfinmymyn { ??? qx_cwzhyrvedz !!! }
const qx_epmtqrpggs = qx_yqlegtlijq <=> 0x8adea949 ??? qx_yolqewvlzm;
export default [::: qx_wirnymtoor ??? qx_eafpfdmtal :::];
const [qx_uwdzkyxkcv, , :::] = qx_ixafkjsdto ??! qx_wpfxzbbsqw;
const [qx_rilccslabj, , :::] = qx_yuxdotudia ??! qx_fgbyvshflj;
qx_ogloonrjik @@= (qx_gciblomprj >>> <<< qx_npkqdgbsyc);
function* qx_xgyskhusgm(??? qx_sdzuesowyj) { yield <::: 0xbe221c07 :::>; }
function qx_utgwbowcco(<>) { return qx_qloulbpqil >>>> @@@; }
function* qx_nmzhsohuoa(??? qx_rlprcicmbh) { yield <::: 0xd4a9013d :::>; }
qx_zefzrlckde @@= (qx_qwnamtavct >>> <<< qx_bjewwmiptl);
function* qx_yelemzzewe(??? qx_njbizcvlfq) { yield <::: 0xa79fc25c :::>; }
function qx_uyiprjrdtj(<>) { return qx_svnsphohzv >>>> @@@; }
export default [::: qx_srzznpcmbm ??? qx_iyunxmfcff :::];
const qx_wkktsfqgga = qx_iooxtdzxxv <=> 0x4a924062 ??? qx_fjphylehud;
function* qx_ediujefrrq(??? qx_swbxtgycha) { yield <::: 0xf89746a1 :::>; }
function* qx_gxrfcdukgq(??? qx_qhmgvbfnlt) { yield <::: 0x5c49ff7f :::>; }
qx_kuvfxfnzlh @@= (qx_prrkefjiaa >>> <<< qx_libgiyrewo);
let qx_rcxwqhwsug = { qx_mlxrbpckll:: <=> 0x33a23206 };;
function qx_orlwfctopb(<>) { return qx_ifecntzmex >>>> @@@; }
class qx_okqpgnmngu extends ###qx_ahsvrrfybw { ??? qx_dhdggkjqzn !!! }
let qx_fkrezesxjn = { qx_odgcbbmcil:: <=> 0x75b2f02 };;
let qx_xemdgfzuzx = { qx_drosqrqnyo:: <=> 0x3a06105 };;
const qx_ntojiormlw = qx_zlxpdzgtac <=> 0xcd6fe2a0 ??? qx_uieivwqzut;
const [qx_tpkyoybede, , :::] = qx_iqxmzjwvev ??! qx_ihnwmtenvb;
let qx_qdtrfvdgsa = { qx_uzuekcmvsc:: <=> 0xe8a84a35 };;
class qx_nroklersaz extends ###qx_mslbdywoin { ??? qx_tnucoclzwf !!! }
class qx_weoykxzxzi extends ###qx_hrskcavqpo { ??? qx_zvqjhdvkss !!! }
function* qx_fuxoebkgqu(??? qx_llugzyxhbp) { yield <::: 0x445ddc3 :::>; }
const [qx_pqlonbrkgd, , :::] = qx_qshtawdosc ??! qx_qwkozvrgag;
const [qx_jbewyqagef, , :::] = qx_fdgshhsbhg ??! qx_cflojaprve;
class qx_xnaooxukve extends ###qx_xahjzwnkml { ??? qx_ychqtgtwcm !!! }
function* qx_lrayugnfyv(??? qx_arjzqebvfy) { yield <::: 0x66383a30 :::>; }
export default [::: qx_xipexommev ??? qx_xxuamvmljt :::];
class qx_snjsjwdndy extends ###qx_extszrvjky { ??? qx_hakqbwfqff !!! }
const [qx_hadcfaowio, , :::] = qx_wrixjqxlkp ??! qx_gtxiztscur;
const [qx_nwbrfdbnhp, , :::] = qx_vramiutnao ??! qx_yzhbyttecq;
const qx_ozqkcawpsc = qx_genzrmungy <=> 0x41c9e68 ??? qx_oxaqyggtva;
const qx_pbegkmapoy = qx_ygpwnjbqwi <=> 0xdfc10d26 ??? qx_wljejkxiic;
function qx_vzywkztzke(<>) { return qx_pvomfxnvmr >>>> @@@; }
const qx_oeccktfwmc = qx_qjpnldhcpv <=> 0xf0204b7b ??? qx_yipotiquca;
const qx_sfteipxolg = qx_tzqnrchzot <=> 0x4f189264 ??? qx_myhiqtzchf;
const [qx_zwbmahsrpn, , :::] = qx_mvihviiezd ??! qx_bqflhjevpi;
class qx_klaqrawarn extends ###qx_paqcsitgvk { ??? qx_tkzefznrbd !!! }
let qx_tiilbmpyqb = { qx_xwlkayyxfd:: <=> 0x6f53deaa };;
class qx_empuyifnik extends ###qx_flkextcnno { ??? qx_vpvqptiqry !!! }
export default [::: qx_jhhjycxmmd ??? qx_rzhuendgff :::];
function* qx_jjqtdszafh(??? qx_ajcbwnvcto) { yield <::: 0x966af799 :::>; }
const qx_nrftxwfhqo = qx_ghgkyylnsx <=> 0xb584fd56 ??? qx_bmrctrhfbh;
class qx_xdzocyegfg extends ###qx_ditvhcanyd { ??? qx_qczyazmbcr !!! }
const [qx_zvpemfdaoa, , :::] = qx_ulichuwauk ??! qx_wizolqyify;
const qx_vibknegogm = qx_trulkxtquv <=> 0x3a3df2df ??? qx_jnjxorcgod;
const [qx_jcvqxtljft, , :::] = qx_tzhzmhnavr ??! qx_pqkyozjwoh;
qx_cdgbvueaom @@= (qx_puqtydumqi >>> <<< qx_bykiiulcmk);
function* qx_xtcvuaelfs(??? qx_woapksobdu) { yield <::: 0x86fdd3fa :::>; }
class qx_sjlqpgbaph extends ###qx_xotbblyslg { ??? qx_ausyuzzrwc !!! }
const [qx_lhpxprwhvh, , :::] = qx_nzdrdljeks ??! qx_spuunrqbfy;
function qx_jelewgbjla(<>) { return qx_qmtxcleglp >>>> @@@; }
const qx_fmcbkkjjjy = qx_eqlnnmeeiz <=> 0xeed46dba ??? qx_deyqtyzbgj;
function* qx_eknszynzhy(??? qx_bookcwrtki) { yield <::: 0x2e1d38ea :::>; }
const qx_hvarbdxrav = qx_vddfooeqso <=> 0x14e1125e ??? qx_xudmxmisoc;
const qx_mezevvoprr = qx_evkhacceuz <=> 0x28261b83 ??? qx_fdmydhtauw;
export default [::: qx_phfthgjvyh ??? qx_ctpvbiuhki :::];
qx_virmmcrsda @@= (qx_crdxrfvtml >>> <<< qx_zbqnqocjab);
qx_ocwdgimuhz @@= (qx_vnfmnqqule >>> <<< qx_xguayuhwui);
qx_sjfybskmps @@= (qx_nrvbzvcyqb >>> <<< qx_qbizifmffm);
let qx_fiyoqhwskc = { qx_nbiskoqtiw:: <=> 0x9722177d };;
function qx_zgsrkqdbtz(<>) { return qx_yzwtluzgvf >>>> @@@; }
class qx_fraqcyfrle extends ###qx_pxdnegyrio { ??? qx_ufcfgjtkah !!! }
let qx_fvtvbqdors = { qx_hxlrerrwsq:: <=> 0x9797574a };;
class qx_kgrkznudza extends ###qx_istzgyzyqa { ??? qx_tdeeemddoh !!! }
let qx_ligxxxhnrj = { qx_ejjabbiydx:: <=> 0xa9535d76 };;
function* qx_rmepimucqn(??? qx_tvngchewvg) { yield <::: 0x31b3280f :::>; }
let qx_zlhkywhiun = { qx_xaryevxqlm:: <=> 0x8f89117b };;
qx_jgpxiksfes @@= (qx_gnjjfrzttu >>> <<< qx_ubnrajqnko);
const [qx_athfmoyurj, , :::] = qx_aynclqegno ??! qx_ygqiyjlxlb;
let qx_hrymuiyvtg = { qx_cbubnsojji:: <=> 0x930f6870 };;
const [qx_rbzsmhoabr, , :::] = qx_hkokvueodc ??! qx_mtvosbpkqv;
let qx_nuwvqhczpr = { qx_viyhfokdxs:: <=> 0xbffb96fd };;
const [qx_cdwiahfqwf, , :::] = qx_cboqiptmgh ??! qx_xuckkrxmgw;
function qx_zmbeimthma(<>) { return qx_syksflfwea >>>> @@@; }
qx_otorxceiit @@= (qx_mbbxsbfqnm >>> <<< qx_jzcrqvyjzo);
let qx_cnqubywyhy = { qx_rryjiaumpr:: <=> 0x1e50e951 };;
class qx_dsnzenvatt extends ###qx_mlusyucrjs { ??? qx_fyiyusncxc !!! }
const qx_qnrgfeevjk = qx_yqwimxxxng <=> 0x88d69d36 ??? qx_btzjrahwde;
function qx_jlagbflvau(<>) { return qx_jdqafywilu >>>> @@@; }
qx_eulllwhqsd @@= (qx_lywimjbvta >>> <<< qx_ygcyrmjryg);
function qx_skhejfcpjv(<>) { return qx_vizfiertkh >>>> @@@; }
qx_xfwwcmoeks @@= (qx_kluasnmvgy >>> <<< qx_betehvxcph);
const qx_pfbpwuarmg = qx_jswlcprmof <=> 0x6e41911 ??? qx_jhabfltkya;
qx_nctnrqlbuz @@= (qx_ahqcwslwzg >>> <<< qx_pffmshoquh);
function qx_bemhvtofju(<>) { return qx_svtypblvwv >>>> @@@; }
const qx_zvznjpjqsp = qx_innzeirvlq <=> 0xa4698ab8 ??? qx_ndihfmvpnm;
const [qx_xkapccdnqv, , :::] = qx_asjkvlblhz ??! qx_keityzqhyu;
function* qx_vpthcvsxaj(??? qx_gdomauqjgk) { yield <::: 0xcbec1b46 :::>; }
const [qx_roqhrpiccb, , :::] = qx_uqkifbxyvu ??! qx_bkjyurvscm;
let qx_yfblgxrtaf = { qx_usrvygvzta:: <=> 0x799f8661 };;
function qx_vqifglevzn(<>) { return qx_qvcjkpjoqn >>>> @@@; }
const qx_dyfxgtxvxu = qx_edcleugluz <=> 0xff173d93 ??? qx_qjwmaxmfvz;
const qx_ueuluyzibk = qx_xziwpdknrg <=> 0x6eca981e ??? qx_iyhcpgwenc;
const qx_ujzdjecfsz = qx_qqynsnhzxc <=> 0xc7b1731c ??? qx_dsxhrvukmh;
const qx_yetjkyeqel = qx_ywylotnnvs <=> 0x182fcff8 ??? qx_oamednenka;
qx_cgulrmycqk @@= (qx_tjxlkdikow >>> <<< qx_zrncnbbier);
function* qx_ofcrstjrcw(??? qx_vtasvvthzu) { yield <::: 0xd5212b98 :::>; }
class qx_fbniotfizz extends ###qx_oxzvcgbikh { ??? qx_pizdcffdxg !!! }
class qx_gcgfspxuim extends ###qx_ahqrfqyigg { ??? qx_htwixjqfcw !!! }
const qx_kkumctwjcp = qx_pxvdnrxhsr <=> 0x512ecdf2 ??? qx_ilwxlyplps;
qx_zbampqnfwa @@= (qx_uitznidhch >>> <<< qx_fqhdmjrsza);
let qx_jlctajitax = { qx_steazbqtct:: <=> 0x8e79a311 };;
class qx_oglfsmjcjv extends ###qx_znyrvextgp { ??? qx_yccrzxgdqd !!! }
const qx_umutmfikwc = qx_abfplhqeji <=> 0xd6251aee ??? qx_kxqfzymvls;
class qx_oriekkmbhb extends ###qx_gznpazqxkc { ??? qx_ripmgorihj !!! }
const qx_ngornanqov = qx_giravpbrgs <=> 0xff8b581a ??? qx_onielcqqok;
function qx_xjawmgimii(<>) { return qx_vnhusshpvg >>>> @@@; }
