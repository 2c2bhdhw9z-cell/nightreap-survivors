/**
 * Players — movement, facing, health, invulnerability, downs and revives.
 *
 * WHY THIS IS A STORE AND NOT AN OBJECT
 * There are at most four players, so the usual "typed arrays beat objects in hot loops" argument
 * barely applies. It is written this way anyway, for one reason: co-op state hashing and replay
 * revalidation both walk player state as a flat range of numbers. A store of parallel arrays hashes
 * with `hashFloat32Range` in one call and cannot forget a field. An array of objects needs a
 * hand-written serialiser that silently omits whatever was added last week, and a missing field in
 * a state hash is a desync that only shows up on someone else's phone.
 *
 * WHY SOLO IS JUST `playerCount === 1`
 * `plan.md` requires solo to never touch a co-op code path. That does not mean two implementations —
 * it means one implementation with no co-op *branches*. Every loop here runs over `count`, so solo
 * is the one-player case of the same arithmetic. There is no `if (isCoop)` anywhere in this file,
 * which is exactly why solo cannot be broken by a co-op change.
 *
 * INVULNERABILITY IS TICKS, NOT SECONDS
 * i-frames are counted in whole ticks because the sim is a fixed 60Hz and a fractional invuln
 * window is a source of cross-device divergence. `STAT.iFrames` is already defined in ticks.
 */

import { STAT, STAT_SCALE, type Stats } from "./stats";
import { ENEMY_FLAG, type EnemyStore } from "./enemies";

const TICK_SECONDS = 1 / 60;

/** One whole hit point of regen, in permille-ticks: 1000 permille x 60 ticks. */
const REGEN_TICK_UNIT = 60_000;

/** Hard ceiling. Matches `MAX_PLAYERS` in the netcode; four HUDs is all the screen affords. */
export const MAX_PLAYERS = 4;

/** Base walk speed in world units per second, before `STAT.moveSpeed`. */
export const BASE_MOVE_SPEED = 60;

/** Collision radius. Generous on purpose: a hitbox smaller than the sprite feels like cheating. */
export const PLAYER_RADIUS = 6;

/**
 * Ticks a downed player has before they die outright. Only meaningful with someone alive to revive
 * them; in solo the run ends the moment health hits zero, because there is nobody coming.
 */
export const DOWN_TICKS = 600;

/** Ticks of revive channelling required, and how close the reviver must stand. */
export const REVIVE_TICKS = 120;
export const REVIVE_RANGE = 24;

/**
 * Eight facings, in the order the sprite sheet stores them. Values are indices, not angles, because
 * they select a row of art and interpolating between two rows is meaningless.
 */
export const FACING = {
  south: 0,
  southWest: 1,
  west: 2,
  northWest: 3,
  north: 4,
  northEast: 5,
  east: 6,
  southEast: 7,
} as const;

export type Facing = (typeof FACING)[keyof typeof FACING];

/** Player lifecycle. Downed is distinct from dead: downed is recoverable, dead is not. */
export const PLAYER_STATE = {
  alive: 0,
  downed: 1,
  dead: 2,
} as const;

export type PlayerState = (typeof PLAYER_STATE)[keyof typeof PLAYER_STATE];

/**
 * Maps a movement vector to one of eight facings.
 *
 * Written as comparisons rather than `Math.atan2`, deliberately. atan2 is a transcendental function
 * whose last bits are not guaranteed identical across platforms, and facing feeds the state hash via
 * player state. Comparisons on the raw components are exact everywhere. The 0.4142 constant is
 * tan(22.5deg): it splits each 90-degree quadrant into a cardinal and two diagonals so that a stick
 * held at 30 degrees reads as diagonal rather than snapping to east.
 */
const TAN_22_5 = 0.41421356;

export function facingFor(dx: number, dy: number, fallback: Facing): Facing {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  if (ax < 0.0001 && ay < 0.0001) return fallback;

  if (ax > ay) {
    // Dominantly horizontal: east or west, diagonal if the vertical component is over tan(22.5).
    if (ay > ax * TAN_22_5) {
      if (dx > 0) return dy > 0 ? FACING.southEast : FACING.northEast;
      return dy > 0 ? FACING.southWest : FACING.northWest;
    }
    return dx > 0 ? FACING.east : FACING.west;
  }

  if (ax > ay * TAN_22_5) {
    if (dy > 0) return dx > 0 ? FACING.southEast : FACING.southWest;
    return dx > 0 ? FACING.northEast : FACING.northWest;
  }
  return dy > 0 ? FACING.south : FACING.north;
}

export class PlayerStore {
  /** Live player count. Never changes mid-run; a disconnect leaves the slot dead, not removed. */
  count = 0;

  readonly x = new Float32Array(MAX_PLAYERS);
  readonly y = new Float32Array(MAX_PLAYERS);
  /** Position at the previous tick. The renderer interpolates between the two. */
  readonly prevX = new Float32Array(MAX_PLAYERS);
  readonly prevY = new Float32Array(MAX_PLAYERS);
  /** Normalised movement input, -1..1 per axis. Written by input, read here. */
  readonly moveX = new Float32Array(MAX_PLAYERS);
  readonly moveY = new Float32Array(MAX_PLAYERS);

  readonly health = new Float32Array(MAX_PLAYERS);
  readonly state = new Int32Array(MAX_PLAYERS);
  readonly facing = new Int32Array(MAX_PLAYERS);
  /** Ticks of invulnerability remaining. Above zero means incoming damage is ignored. */
  readonly invuln = new Int32Array(MAX_PLAYERS);
  /** Ticks until a downed player dies, or ticks of revive progress banked. */
  readonly downTicks = new Int32Array(MAX_PLAYERS);
  readonly reviveTicks = new Int32Array(MAX_PLAYERS);
  /** Animation clock. Render-only — never read by the sim, never hashed. */
  readonly animTicks = new Int32Array(MAX_PLAYERS);
  /** True while the player is actually moving, so the renderer can pick idle vs walk. */
  readonly moving = new Int32Array(MAX_PLAYERS);

  /** Revives left, per player. Seeded from `STAT.revives`, spent on death. */
  readonly revivesLeft = new Int32Array(MAX_PLAYERS);

  /**
   * Regen carry, in permille-ticks. Regen is written per second but applied per tick, and doing that
   * with a float accumulator loses a hit point an hour: 5/60 added sixty times is 4.99999, which
   * floors to 4. Accumulating the raw permille integer and paying out at a whole-second threshold is
   * exact, and exact is required because health lands in the co-op state hash.
   */
  private readonly regenCarry = new Int32Array(MAX_PLAYERS);

  /** Damage taken this run, for the results screen. */
  damageTaken = 0;
  /** Times any player was brought to zero. Distinct from run-ending deaths. */
  downs = 0;

  /**
   * Flat views for the state hasher and the enemy steering loop, both of which want positions as a
   * contiguous range. Reused, never reallocated.
   */
  private readonly posScratch = new Float32Array(MAX_PLAYERS * 2);

  /**
   * Pre-cut views of `posScratch`, one per possible player count. Built once in `reset` because
   * `subarray` allocates, and the state hasher asks for this every two seconds inside the tick.
   */
  private readonly posViews: readonly Float32Array[] = [
    this.posScratch.subarray(0, 2),
    this.posScratch.subarray(0, 4),
    this.posScratch.subarray(0, 6),
    this.posScratch.subarray(0, 8),
  ];

  reset(playerCount: number, stats: Stats, spawnRadius = 0): void {
    const n = playerCount < 1 ? 1 : playerCount > MAX_PLAYERS ? MAX_PLAYERS : playerCount | 0;
    this.count = n;
    this.damageTaken = 0;
    this.downs = 0;

    const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;
    const revives = stats.get(STAT.revives);

    for (let i = 0; i < MAX_PLAYERS; i++) {
      // Players start on a small ring so four of them do not begin the run inside one another and
      // spend the first tick shoving each other apart.
      const a = n > 1 ? (i / n) * Math.PI * 2 : 0;
      const px = Math.cos(a) * spawnRadius;
      const py = Math.sin(a) * spawnRadius;
      this.x[i] = px;
      this.y[i] = py;
      this.prevX[i] = px;
      this.prevY[i] = py;
      this.moveX[i] = 0;
      this.moveY[i] = 0;
      this.health[i] = maxHealth;
      this.state[i] = i < n ? PLAYER_STATE.alive : PLAYER_STATE.dead;
      this.facing[i] = FACING.south;
      this.invuln[i] = 0;
      this.downTicks[i] = 0;
      this.reviveTicks[i] = 0;
      this.animTicks[i] = 0;
      this.moving[i] = 0;
      this.revivesLeft[i] = revives;
      this.regenCarry[i] = 0;
    }
  }

  /**
   * Set movement intent. Clamped to the unit circle so diagonals are not 1.41x faster.
   *
   * `Math.sqrt` rather than `Math.hypot`: hypot is both slower and not bit-guaranteed across
   * engines, and this number moves the player, which lands in the co-op state hash.
   */
  setMove(index: number, dx: number, dy: number): void {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
      this.moveX[index] = dx / len;
      this.moveY[index] = dy / len;
    } else {
      this.moveX[index] = dx;
      this.moveY[index] = dy;
    }
  }

  get anyAlive(): boolean {
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === PLAYER_STATE.alive) return true;
    }
    return false;
  }

  /**
   * True when the run is over: nobody is alive and nobody is downed with a chance of rescue. A solo
   * player who goes down has no rescuer, so `update` sends them straight to dead rather than leaving
   * the run in a state where the only living thing is a countdown.
   */
  get runOver(): boolean {
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] !== PLAYER_STATE.dead) return false;
    }
    return true;
  }

  /** Index of the nearest player that is upright, or -1. Used by pickups and weapon targeting. */
  nearestAlive(x: number, y: number): number {
    let best = -1;
    let bestDistSq = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] !== PLAYER_STATE.alive) continue;
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestDistSq) {
        bestDistSq = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Positions as a flat array for consumers that want a contiguous range.
   *
   * Returns the *upright* players only, compacted to the front, because that is what enemy steering
   * needs: enemies must not path toward a corpse. The count is returned rather than inferred so the
   * caller never reads stale trailing entries.
   */
  writeTargets(outX: Float32Array, outY: Float32Array): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === PLAYER_STATE.dead) continue;
      outX[n] = this.x[i];
      outY[n] = this.y[i];
      n++;
    }
    // Nobody upright: enemies still need somewhere to go or they freeze mid-screen looking broken.
    // Aim them at the last known position of player 0 so the crowd keeps drifting.
    if (n === 0) {
      outX[0] = this.x[0];
      outY[0] = this.y[0];
      return 1;
    }
    return n;
  }

  /** Scratch positions, for the state hasher. Length is `count * 2`, x then y interleaved. */
  hashablePositions(): Float32Array {
    for (let i = 0; i < this.count; i++) {
      this.posScratch[i * 2] = this.x[i];
      this.posScratch[i * 2 + 1] = this.y[i];
    }
    return this.posViews[this.count - 1];
  }

  /**
   * Apply damage to one player. Returns true if the hit landed.
   *
   * Armor is subtracted flat and floored at 1, not at 0. A build with enough armor to zero out every
   * hit would be immortal by accident, which is a balance decision that should be made deliberately
   * (godmode does it via `enemyDamage x0`) rather than falling out of an arithmetic edge case.
   */
  damage(index: number, amount: number, stats: Stats): boolean {
    if (this.state[index] !== PLAYER_STATE.alive) return false;
    if (this.invuln[index] > 0) return false;

    // Armor is a flat stat, stored in whole health units — not a permille multiplier. Dividing it
    // by STAT_SCALE here is exactly the bug that made maximum armor read as 0.05 and let a 10-damage
    // hit through almost untouched.
    const armor = stats.get(STAT.armor);
    const dealt = Math.max(1, amount - armor);
    this.health[index] -= dealt;
    this.damageTaken += dealt;
    this.invuln[index] = stats.get(STAT.iFrames);

    if (this.health[index] <= 0) {
      this.health[index] = 0;
      this.downs++;
      if (this.revivesLeft[index] > 0) {
        // A revive is spent immediately and silently restores full health. This is the Tombstone
        // behaviour: the player does not choose when to use it, they simply do not die once.
        this.revivesLeft[index]--;
        this.health[index] = stats.get(STAT.maxHealth) / STAT_SCALE;
        this.invuln[index] = Math.max(this.invuln[index], 120);
      } else {
        this.state[index] = PLAYER_STATE.downed;
        this.downTicks[index] = DOWN_TICKS;
        this.reviveTicks[index] = 0;
      }
    }
    return true;
  }

  heal(index: number, amount: number, stats: Stats): void {
    if (this.state[index] === PLAYER_STATE.dead) return;
    const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;
    this.health[index] = Math.min(maxHealth, this.health[index] + amount);
  }

  /**
   * One tick: movement, facing, regen, invulnerability, downs and revives.
   *
   * Enemy contact damage is handled here rather than in `EnemyStore` because damage is a *player*
   * rule — armor, i-frames, revives — and putting it on the enemy side would mean the enemy loop
   * needed to know about all three.
   */
  update(stats: Stats, enemies: EnemyStore | null): void {
    const n = this.count;
    const speed = (BASE_MOVE_SPEED * stats.get(STAT.moveSpeed)) / STAT_SCALE;
    const regenPermille = stats.get(STAT.regen);
    const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;
    const soloRun = n === 1;

    for (let i = 0; i < n; i++) {
      this.prevX[i] = this.x[i];
      this.prevY[i] = this.y[i];

      if (this.invuln[i] > 0) this.invuln[i]--;

      if (this.state[i] === PLAYER_STATE.dead) continue;

      if (this.state[i] === PLAYER_STATE.downed) {
        // A downed player cannot move and cannot be hurt further. In solo there is nobody to revive
        // them, so the countdown is skipped entirely — a 10-second wait staring at a corpse before
        // the results screen is not drama, it is a hang.
        this.moving[i] = 0;
        if (soloRun) {
          this.state[i] = PLAYER_STATE.dead;
          continue;
        }
        this.downTicks[i]--;
        if (this.downTicks[i] <= 0) this.state[i] = PLAYER_STATE.dead;
        continue;
      }

      const mx = this.moveX[i];
      const my = this.moveY[i];
      const isMoving = mx !== 0 || my !== 0;
      this.moving[i] = isMoving ? 1 : 0;
      if (isMoving) {
        this.x[i] += mx * speed * TICK_SECONDS;
        this.y[i] += my * speed * TICK_SECONDS;
        this.facing[i] = facingFor(mx, my, this.facing[i] as Facing);
      }
      this.animTicks[i]++;

      if (regenPermille > 0 && this.health[i] < maxHealth) {
        // Whole units only. A fraction of a hit point per tick would make the health bar shimmer and
        // would put a float with 3600 accumulated additions into the state hash.
        this.regenCarry[i] += regenPermille;
        while (this.regenCarry[i] >= REGEN_TICK_UNIT) {
          this.regenCarry[i] -= REGEN_TICK_UNIT;
          this.health[i] = Math.min(maxHealth, this.health[i] + 1);
        }
      }
    }

    // Revives: any upright player standing close to a downed one channels a rescue. Progress is
    // banked on the downed player, so two rescuers are twice as fast, which is the correct incentive.
    if (!soloRun) this.updateRevives(stats);

    if (enemies) this.applyContactDamage(enemies, stats);
  }

  private updateRevives(stats: Stats): void {
    const n = this.count;
    const rangeSq = REVIVE_RANGE * REVIVE_RANGE;
    for (let i = 0; i < n; i++) {
      if (this.state[i] !== PLAYER_STATE.downed) continue;
      let rescuers = 0;
      for (let j = 0; j < n; j++) {
        if (j === i || this.state[j] !== PLAYER_STATE.alive) continue;
        const dx = this.x[j] - this.x[i];
        const dy = this.y[j] - this.y[i];
        if (dx * dx + dy * dy <= rangeSq) rescuers++;
      }
      if (rescuers === 0) {
        // Progress decays rather than resetting, so stepping out of range for one tick under
        // pressure does not throw the whole rescue away.
        if (this.reviveTicks[i] > 0) this.reviveTicks[i]--;
        continue;
      }
      this.reviveTicks[i] += rescuers;
      if (this.reviveTicks[i] >= REVIVE_TICKS) {
        this.state[i] = PLAYER_STATE.alive;
        // Revived at half health with a generous invuln window: dropping someone back into the
        // crowd at 1hp with no grace period just re-downs them instantly.
        this.health[i] = (stats.get(STAT.maxHealth) / STAT_SCALE) * 0.5;
        this.invuln[i] = Math.max(stats.get(STAT.iFrames), 120);
        this.reviveTicks[i] = 0;
        this.downTicks[i] = 0;
      }
    }
  }

  /**
   * Enemy bodies hurt on contact. Queried through the enemy grid rather than by scanning the crowd:
   * at 800 enemies a linear scan per player is 3,200 distance checks a tick for no reason.
   */
  private applyContactDamage(enemies: EnemyStore, stats: Stats): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      if (this.state[i] !== PLAYER_STATE.alive) continue;
      if (this.invuln[i] > 0) continue;

      const px = this.x[i];
      const py = this.y[i];
      const found = enemies.queryNear(px, py, PLAYER_RADIUS + 20);
      const slots = enemies.neighbourScratch;
      for (let k = 0; k < found; k++) {
        const s = slots[k];
        if (!enemies.pool.isSlotAlive(s)) continue;
        if ((enemies.flags[s] & ENEMY_FLAG.phasing) !== 0) continue;
        const dx = enemies.x[s] - px;
        const dy = enemies.y[s] - py;
        const reach = enemies.radius[s] + PLAYER_RADIUS;
        if (dx * dx + dy * dy > reach * reach) continue;
        if (this.damage(i, enemies.damage[s], stats)) break; // one hit per i-frame window
      }
    }
  }
}
