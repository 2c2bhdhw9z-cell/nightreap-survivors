/**
 * LocalView — makes the local player's own movement feel instant on a guest phone.
 *
 * THE PROBLEM
 * A guest does not own the world. It sends its thumb to the host, the host seals that tick, and the
 * guest only simulates a tick once it is confirmed. That is correct and it is what keeps four phones
 * agreeing, but it means the authoritative position of the local player is always half a round trip
 * plus the input delay behind the thumb. At 150ms that is a visible, horrible lag on the one thing
 * the player is most sensitive to: their own feet.
 *
 * THE FIX — DEAD RECKONING, DISPLAY ONLY
 * The guest already knows every input it has sent that the host has not sealed yet. So the drawn
 * position is the authoritative position plus those pending intents replayed forward. Nothing here
 * touches the simulation, nothing here enters `hashState`, and nothing here is ever sent anywhere.
 * If this file were deleted the game would still be correct — only laggier.
 *
 * WHY IT CANNOT DESYNC
 * `LocalView` is written to by the presentation layer and read by the presentation layer. It has no
 * reference to `Run`, no reference to a session, and no way to write a stat, a position or an input.
 * Being wrong here is a cosmetic error that self-corrects on the next tick.
 *
 * SOLO AND HOST ARE THE SAME CODE PATH
 * A host (and a solo run) simulates the tick it is given immediately, so there are no pending
 * intents, the replay loop runs zero times, and the drawn position is the simulated position exactly.
 * One path, no branch, no second thing to keep working.
 *
 * ERROR IS GLIDED, NOT SNAPPED
 * Prediction is wrong whenever the world disagrees with dead reckoning: a wall, a knockback, a
 * slowing aura, a stat change mid-flight. Correcting that by teleporting the sprite is worse than
 * the lag it fixes, so the drawn position keeps the prediction's *delta* each tick and closes a
 * fraction of the remaining gap. Small errors dissolve invisibly over a few frames. Large ones — a
 * full resync, a stage load, a revive somewhere else — are a cut, because gliding 400 pixels reads
 * as the sprite sliding across the floor on ice.
 *
 * ZERO ALLOCATION
 * A fixed intent ring of `RING` ticks, all typed arrays, no objects returned. `new` inside a frame
 * is a bug here as much as anywhere else in the engine.
 */

/** Intent ring length in ticks. Power of two so the index is a mask, not a modulo. */
const RING = 64;
const RING_MASK = RING - 1;

/** Sim rate. Matches the simulation exactly — prediction that steps at a different rate drifts. */
const TICK_SECONDS = 1 / 60;

export const LOCAL_VIEW_DEFAULTS = {
  /**
   * Never dead-reckon further ahead than this. Beyond ~0.3s of guessing the prediction is further
   * from the truth than the lag it was hiding, and on a bad connection it would rubber-band hard.
   */
  maxLeadTicks: 20,
  /** World px of disagreement above which the sprite cuts to the truth instead of gliding to it. */
  snapDistancePx: 48,
  /** Fraction of the remaining error closed per tick. 1 = snap always, 0 = never correct. */
  catchUpPerTick: 0.35,
} as const;

export interface LocalViewOptions {
  maxLeadTicks?: number;
  snapDistancePx?: number;
  catchUpPerTick?: number;
}

export interface LocalViewStats {
  /** Times the error was large enough to cut rather than glide. */
  snaps: number;
  /** Intents replayed on the most recent tick — i.e. how far ahead of the sim we are drawing. */
  lead: number;
  /** Largest gap seen between the drawn position and the dead-reckoned one, in world px. */
  maxErrorPx: number;
  /** Ticks whose intent was missing from the ring and were filled with the previous one. */
  filledTicks: number;
}

export class LocalView {
  readonly maxLeadTicks: number;
  readonly snapDistancePx: number;
  readonly catchUpPerTick: number;

  /** Recorded local intents, unit-clamped, indexed by `tick & RING_MASK`. */
  private readonly intentX = new Float32Array(RING);
  private readonly intentY = new Float32Array(RING);
  /** Which tick each slot actually holds. -1 means never written. Guards against stale wrap-around. */
  private readonly intentTick = new Int32Array(RING);

  /** Newest tick handed to `record`. -1 before the first one. */
  private latestTick = -1;

  /** Dead-reckoned position: the world's truth plus every pending intent. */
  private predX = 0;
  private predY = 0;

  /** What we actually draw. Chases `pred`. Two copies so a 120fps frame can interpolate. */
  private curX = 0;
  private curY = 0;
  private prevX = 0;
  private prevY = 0;

  readonly stats: LocalViewStats = { snaps: 0, lead: 0, maxErrorPx: 0, filledTicks: 0 };

  constructor(options: LocalViewOptions = {}) {
    this.maxLeadTicks = options.maxLeadTicks ?? LOCAL_VIEW_DEFAULTS.maxLeadTicks;
    this.snapDistancePx = options.snapDistancePx ?? LOCAL_VIEW_DEFAULTS.snapDistancePx;
    this.catchUpPerTick = options.catchUpPerTick ?? LOCAL_VIEW_DEFAULTS.catchUpPerTick;
    this.intentTick.fill(-1);
  }

  /**
   * Hard cut. Spawn, stage load, resync, revive — anywhere the sprite is allowed to be somewhere
   * else without walking there. Clears pending intents: they belong to a world that no longer
   * applies, and replaying them would drag the sprite off the new position.
   */
  reset(x: number, y: number): void {
    this.predX = x;
    this.predY = y;
    this.curX = x;
    this.curY = y;
    this.prevX = x;
    this.prevY = y;
    this.latestTick = -1;
    this.intentTick.fill(-1);
    this.stats.lead = 0;
  }

  /**
   * Record the movement intent the local phone is sending for `tick`. Call this at the moment the
   * input is captured, before it goes anywhere — that is the whole point: we know our own thumb
   * long before the world does.
   *
   * Clamped to the unit circle here as well as in the simulation. Prediction that lets diagonals run
   * 1.41x faster would disagree with the world every single frame the player walks north-east.
   */
  record(tick: number, dx: number, dy: number): void {
    if (tick < 0) return;
    // An intent for a tick older than the ring can hold is not just useless, it would overwrite a
    // live slot with an ancient value and be replayed as if current.
    if (this.latestTick >= 0 && tick <= this.latestTick - RING) return;

    let nx = dx;
    let ny = dy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
      nx = dx / len;
      ny = dy / len;
    }

    const slot = tick & RING_MASK;
    this.intentX[slot] = nx;
    this.intentY[slot] = ny;
    this.intentTick[slot] = tick;
    if (tick > this.latestTick) this.latestTick = tick;
  }

  /**
   * One call per simulated tick, after the simulation has run, with the authoritative local player
   * position for that tick.
   *
   * `speedPxPerSec` is the player's *current* move speed including stats — passing the base speed
   * would under-predict for anyone who has taken a single boot upgrade, and the error grows with
   * every pending tick.
   *
   * `alive` false — downed or dead — stops prediction dead. A corpse does not walk, and continuing
   * to dead-reckon a body that the world has stopped moving is the one case that produces a large,
   * obvious, sliding error.
   */
  onTick(tick: number, authX: number, authY: number, speedPxPerSec: number, alive: boolean): void {
    this.prevX = this.curX;
    this.prevY = this.curY;

    if (!alive) {
      this.predX = authX;
      this.predY = authY;
      this.stats.lead = 0;
      this.curX += (authX - this.curX) * this.catchUpPerTick;
      this.curY += (authY - this.curY) * this.catchUpPerTick;
      return;
    }

    const beforeX = this.predX;
    const beforeY = this.predY;

    // Replay every intent the host has not sealed yet, starting from the truth.
    const step = speedPxPerSec * TICK_SECONDS;
    let px = authX;
    let py = authY;
    let lead = 0;
    let lastX = 0;
    let lastY = 0;
    const end = Math.min(this.latestTick, tick + this.maxLeadTicks);
    for (let t = tick + 1; t <= end; t++) {
      const slot = t & RING_MASK;
      if (this.intentTick[slot] === t) {
        lastX = this.intentX[slot] as number;
        lastY = this.intentY[slot] as number;
      } else {
        // Missing intent. Repeat the previous one, which is exactly what the host does with a late
        // input, so the guess and the eventual truth agree instead of fighting.
        this.stats.filledTicks++;
      }
      px += lastX * step;
      py += lastY * step;
      lead++;
    }
    this.predX = px;
    this.predY = py;
    this.stats.lead = lead;

    // Keep the prediction's own movement for this tick, then close part of the standing error. Doing
    // it in that order means a steady walk converges to zero error instead of trailing forever.
    const deltaX = px - beforeX;
    const deltaY = py - beforeY;
    const errX = px - (this.curX + deltaX);
    const errY = py - (this.curY + deltaY);

    // The snap decision is made on the whole gap between where we draw the player and where we now
    // believe they are — not on the leftover after this tick's movement. A revive across the map or a
    // boss that yanks the player 300px arrives as a single enormous gap, and gliding that would read
    // as the sprite skating over the floor.
    const gapX = px - this.curX;
    const gapY = py - this.curY;
    const gap = Math.sqrt(gapX * gapX + gapY * gapY);
    if (gap > this.stats.maxErrorPx) this.stats.maxErrorPx = gap;

    if (gap > this.snapDistancePx) {
      this.stats.snaps++;
      this.curX = px;
      this.curY = py;
      this.prevX = px;
      this.prevY = py;
      return;
    }

    this.curX += deltaX + errX * this.catchUpPerTick;
    this.curY += deltaY + errY * this.catchUpPerTick;
  }

  /**
   * Drawn position. `alpha` is the same 0..1 interpolation factor the camera and the batcher use, so
   * the player, the camera and every enemy are interpolated on the same clock.
   */
  renderX(alpha: number): number {
    return this.prevX + (this.curX - this.prevX) * alpha;
  }

  renderY(alpha: number): number {
    return this.prevY + (this.curY - this.prevY) * alpha;
  }

  /** Dead-reckoned position with no smoothing. For the layout editor and the dev menu overlay. */
  get predictedX(): number {
    return this.predX;
  }

  get predictedY(): number {
    return this.predY;
  }

  /** Newest tick we have an intent for. -1 when there is nothing pending. */
  get newestIntentTick(): number {
    return this.latestTick;
  }
}
