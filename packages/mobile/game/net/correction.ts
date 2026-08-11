/**
 * The rolling correction sweep — why desync is designed not to matter.
 *
 * THE IDEA
 * A survivors game has hundreds to thousands of enemies alive. Sending all of them every tick is
 * impossible on a phone connection, and sending none of them means guests slowly drift into a
 * different game. So we send a *slice*: roughly 5% of live enemies per tick, chosen nearest-first
 * round-robin, at 60Hz. Every enemy is therefore refreshed about three times a second, and anything
 * within a player's view — which is what they can actually see being wrong — is refreshed far more
 * often than that because nearness biases the order.
 *
 * WHY NEAREST-FIRST
 * Drift is only a bug when a player perceives it. An enemy 40 metres off-screen can be a metre out of
 * position for a second with zero consequence. An enemy about to touch the player must be right now.
 * Weighting the sweep by distance spends the entire correction budget on the part of the screen
 * anyone is looking at.
 *
 * WHY ROUND-ROBIN IS NOT ENOUGH ON ITS OWN
 * Advancing a cursor through the entity set and keeping the nearest few of each window sounds like it
 * fairly rotates, and it does not. The first version of this file did exactly that and the self-test
 * caught it: with 2,000 enemies, 75% of them were *never* corrected in 60 seconds. The reason is that
 * the window is much larger than the budget, so within any given window the same nearby entities win
 * every single time the cursor passes over them, and their distant neighbours lose every single time.
 * Round-robin decides which entities are *considered*; it does nothing about which are *chosen*.
 *
 * So starvation is bounded explicitly: any entity that has gone `STARVATION_TICKS` without a
 * correction jumps the queue ahead of every distance-ranked candidate. Distance still governs the
 * normal case — which is the whole point — but the worst case is now a stated number instead of an
 * assumption. `worstAge()` exists to keep it honest, and the self-test asserts on it.
 *
 * WHAT THIS FILE IS
 * Scheduling only — which handles to send this tick. Applying a correction belongs to the entity
 * systems (they own their storage), and encoding belongs to `messages.ts`. Keeping the policy here
 * and alone means the 5% figure, the distance weighting and the cycle guarantee can be tuned and
 * unit-tested without touching the sim.
 */

import { CORRECTION_MAX_ENTITIES, CORRECTION_SWEEP_PERCENT } from "./protocol";

/**
 * How a corrected entity arrives on the wire. 12 bytes:
 *   0  u16  handle index
 *   2  u16  handle generation
 *   4  i32  x  (Q16.16)
 *   8  i32  y  (Q16.16)
 *
 * Velocity is deliberately absent. Enemy velocity in this game is a pure function of position
 * relative to its target and its archetype, so a guest recomputes it correctly from the corrected
 * position — sending it would double the bandwidth for nothing. Health is not here either: damage is
 * a host event, so health is already authoritative by a different path.
 */
/**
 * Ticks an entity may go uncorrected before it outranks every nearby candidate.
 *
 * Two seconds. At the 5% budget a 2,000-enemy stage rotates fully in about 31 ticks when the sweep is
 * behaving, so this threshold almost never fires — it is a floor under the worst case, not a scheduler.
 * If the dev menu shows it firing constantly, the budget is too small for the entity count, which is a
 * real signal worth surfacing rather than hiding.
 */
export const STARVATION_TICKS = 120;

/** Sort key given to a starved entity so it precedes every distance-ranked one. */
const STARVED_KEY = -1;

export interface CorrectionSlot {
  index: number;
  generation: number;
  x: number;
  y: number;
}

/**
 * Round-robin sweep cursor with distance biasing.
 *
 * Allocates its arrays once at construction and never again. `plan()` writes handle indices into a
 * caller-owned output array and returns the count, so a tick produces no garbage.
 */
export class CorrectionSweep {
  /** Candidate indices considered this tick. */
  private readonly candidates: Int32Array;
  /** Sort key per candidate — squared distance to the nearest player, in world units. */
  private readonly keys: Float64Array;
  /** Tick each index was last corrected, so the cycle guarantee is measurable rather than assumed. */
  private readonly lastSwept: Int32Array;
  /** Where the next round-robin pass resumes. */
  private cursor = 0;

  constructor(readonly capacity: number) {
    this.candidates = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.lastSwept = new Int32Array(capacity).fill(-1);
  }

  /**
   * How many entities to send this tick.
   *
   * Clamped at both ends: at least one so a nearly-empty stage still converges, and never more than
   * `CORRECTION_MAX_ENTITIES` so a single message cannot exceed the datagram budget during a swarm.
   */
  budgetFor(liveCount: number): number {
    if (liveCount <= 0) return 0;
    const share = Math.floor((liveCount * CORRECTION_SWEEP_PERCENT) / 100);
    const n = share < 1 ? 1 : share;
    return n > CORRECTION_MAX_ENTITIES ? CORRECTION_MAX_ENTITIES : n;
  }

  /**
   * Choose this tick's slice.
   *
   * `alive` marks which slots are live, `posX`/`posY` are the sim's flat position arrays in Q16.16,
   * and `playerX`/`playerY` hold up to four player positions. Results land in `out`; the return value
   * is how many were written.
   *
   * The scan starts at the round-robin cursor and walks forward, collecting live slots until it has
   * gathered a pool a few times larger than the budget, then keeps only the nearest ones. That two-
   * stage approach is why this is cheap: it never sorts the whole enemy set, only a small window,
   * and the window advances every tick so nothing is starved.
   */
  plan(
    out: Int32Array,
    tick: number,
    alive: Uint8Array,
    posX: Int32Array,
    posY: Int32Array,
    playerX: Int32Array,
    playerY: Int32Array,
    playerCount: number,
    liveCount: number,
  ): number {
    const budget = this.budgetFor(liveCount);
    if (budget === 0 || playerCount === 0) return 0;

    // Gather a window of live candidates, four times the budget, starting from the cursor.
    const windowTarget = Math.min(this.capacity, budget * 4);
    let gathered = 0;
    let scanned = 0;
    let i = this.cursor;
    while (gathered < windowTarget && scanned < this.capacity) {
      if (alive[i] === 1) {
        const last = this.lastSwept[i] as number;
        const starved = last < 0 ? tick >= STARVATION_TICKS : tick - last >= STARVATION_TICKS;
        this.candidates[gathered] = i;
        this.keys[gathered] = starved
          ? STARVED_KEY
          : nearestPlayerDistSq(
              posX[i] as number,
              posY[i] as number,
              playerX,
              playerY,
              playerCount,
            );
        gathered++;
      }
      i = i + 1 === this.capacity ? 0 : i + 1;
      scanned++;
    }
    this.cursor = i;
    if (gathered === 0) return 0;

    const take = gathered < budget ? gathered : budget;
    // Partial selection sort: only `take` passes, so this is O(gathered * budget) on a small window
    // rather than a full sort of the enemy set.
    for (let a = 0; a < take; a++) {
      let best = a;
      for (let b = a + 1; b < gathered; b++) {
        if ((this.keys[b] as number) < (this.keys[best] as number)) best = b;
      }
      if (best !== a) {
        const tk = this.keys[a] as number;
        this.keys[a] = this.keys[best] as number;
        this.keys[best] = tk;
        const tc = this.candidates[a] as number;
        this.candidates[a] = this.candidates[best] as number;
        this.candidates[best] = tc;
      }
      const chosen = this.candidates[a] as number;
      out[a] = chosen;
      this.lastSwept[chosen] = tick;
    }
    return take;
  }

  /** Ticks since a slot was last corrected, or -1 if never. Used by the dev menu's netcode panel. */
  ageOf(index: number, tick: number): number {
    const last = this.lastSwept[index] as number;
    return last < 0 ? -1 : tick - last;
  }

  /**
   * Worst age across live slots — the number that proves the cycle guarantee holds.
   *
   * If this climbs without bound the sweep is starving, which is the one failure mode that turns
   * "drift is corrected" back into "drift accumulates". It gets a dev-menu readout for that reason.
   */
  worstAge(tick: number, alive: Uint8Array): number {
    let worst = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (alive[i] !== 1) continue;
      const last = this.lastSwept[i] as number;
      const age = last < 0 ? tick : tick - last;
      if (age > worst) worst = age;
    }
    return worst;
  }

  reset(): void {
    this.lastSwept.fill(-1);
    this.cursor = 0;
  }
}

/** Squared distance from a point to the nearest player, in Q16.16 world units converted to doubles. */
function nearestPlayerDistSq(
  x: number,
  y: number,
  playerX: Int32Array,
  playerY: Int32Array,
  playerCount: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let p = 0; p < playerCount; p++) {
    // Shift out the fractional bits before squaring: full Q16.16 products overflow the exact-integer
    // range of a double, and sub-pixel precision is irrelevant to a distance *ranking*.
    const dx = (x - (playerX[p] as number)) / 65536;
    const dy = (y - (playerY[p] as number)) / 65536;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}
