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
 * the lag it fixes, so the drawn position closes a fraction of the remaining gap toward the
 * dead-reckoned target each render step. Small errors dissolve invisibly over a few frames. Large
 * ones — a full resync, a stage load, a revive somewhere else — are a cut, because gliding 400
 * pixels reads as the sprite sliding across the floor on ice. A tiny sub-pixel gap is left alone
 * entirely (`deadzonePx`): chasing a jittering-by-a-fraction target is itself the jitter.
 *
 * TWO CLOCKS, AND WHY THEY MUST NOT BE THE SAME ONE
 * A guest does not advance the world every render frame. It applies whatever the host has confirmed
 * when `pump()` runs, which is zero applied ticks on one frame and two or three on the next. So the
 * dead-reckoned *target* (`predX/predY`) is recomputed on the AUTHORITATIVE clock — once per applied
 * tick, in `onTick` — because that is when a new confirmed position and a new pending span exist.
 * But the drawn glide (`prevX/curX`) is stepped on the RENDER clock — once per fixed-loop tick, in
 * `advance` — the exact same 60Hz cadence and the same `alpha` the camera and `EntityView` draw with.
 * Gliding on the authoritative clock instead (a `curX` that lurches two steps on a burst frame and
 * freezes on a starved one, then read back by a render-clock `alpha`) is precisely the constant local
 * jitter this file exists to remove: the crowd was already fixed this way, and the one sprite left
 * shimmering was the local player, still gliding per applied tick.
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
  /**
   * Fraction of the remaining error closed per render step. 1 = snap always, 0 = never correct.
   * Gentle on purpose: the glide now runs on the render clock (once per fixed-loop tick) and the
   * dead-reckoned target it chases still wobbles by a fraction of a pixel as `lead` breathes with the
   * confirm cadence. A hard 0.35 chased that wobble hard enough to see; a softer close smears it out
   * across a handful of frames, which reads as steady motion instead of a shimmer.
   */
  catchUpPerTick: 0.2,
  /**
   * World px of gap below which the glide does not correct at all. A confirmed position that agrees
   * with the prediction to within a fraction of a pixel is not an error worth chasing — closing it
   * only trades a still sprite for one that hunts around the truth by sub-pixel amounts every frame,
   * which is exactly the constant jitter. Kept under a pixel so a real, visible standing error still
   * glides closed.
   */
  deadzonePx: 0.5,
} as const;

export interface LocalViewOptions {
  maxLeadTicks?: number;
  snapDistancePx?: number;
  catchUpPerTick?: number;
  deadzonePx?: number;
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
  readonly deadzonePx: number;

  /** Recorded local intents, unit-clamped, indexed by `tick & RING_MASK`. */
  private readonly intentX = new Float32Array(RING);
  private readonly intentY = new Float32Array(RING);
  /** Which tick each slot actually holds. -1 means never written. Guards against stale wrap-around. */
  private readonly intentTick = new Int32Array(RING);

  /** Newest tick handed to `record`. -1 before the first one. */
  private latestTick = -1;

  /** Dead-reckoned position: the world's truth plus every pending intent. Updated on the auth clock. */
  private predX = 0;
  private predY = 0;

  /**
   * The dead-reckoned target at the previous render step. While the player is alive the glide feeds the
   * target's own motion since then forward before correcting the standing error, so a steady walk does
   * not trail the target by a fixed lag — a pure proportional follower always sits `step / catchUp`
   * behind a moving target, which on a guest is exactly the lag `LocalView` exists to erase.
   */
  private lastPredX = 0;
  private lastPredY = 0;

  /**
   * Whether the last applied tick reported the player alive. A downed or dead player's target does not
   * *move* — it jumps back to the truth the world stopped it at — so its velocity must not be fed
   * forward (that would teleport the sprite onto the corpse). Instead the sprite glides back with a
   * pure proportional close, the same easing the original per-tick code used for a corpse.
   */
  private alive = true;

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
    this.deadzonePx = options.deadzonePx ?? LOCAL_VIEW_DEFAULTS.deadzonePx;
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
    this.lastPredX = x;
    this.lastPredY = y;
    this.curX = x;
    this.curY = y;
    this.prevX = x;
    this.prevY = y;
    this.alive = true;
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
   * One call per APPLIED simulation tick, after the world has advanced, with the authoritative local
   * player position for that tick. This updates the dead-reckoned *target* only — it does not move the
   * drawn sprite. On a guest a single render frame can apply zero, one or several confirmed ticks; the
   * target is refreshed on each of them because each carries a new confirmed position and a new pending
   * span, but the drawn glide toward it is stepped separately in `advance`, on the render clock.
   *
   * `speedPxPerSec` is the player's *current* move speed including stats — passing the base speed would
   * under-predict for anyone who has taken a single boot upgrade, and the error grows with every
   * pending tick.
   *
   * `alive` false — downed or dead — stops prediction dead. A corpse does not walk, and continuing to
   * dead-reckon a body the world has stopped moving is the one case that produces a large, obvious,
   * sliding error. The drawn sprite still eases onto the corpse's position in `advance`.
   */
  onTick(tick: number, authX: number, authY: number, speedPxPerSec: number, alive: boolean): void {
    this.alive = alive;

    if (!alive) {
      this.predX = authX;
      this.predY = authY;
      this.stats.lead = 0;
      return;
    }

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
  }

  /**
   * One call per RENDER tick (the fixed-loop's 60Hz cadence), before the frame draws. Rolls the drawn
   * position into `prev` and glides `cur` a fraction of the way toward the dead-reckoned target, so the
   * sprite moves on the exact clock and `alpha` the camera and the crowd interpolate with. Because it
   * is decoupled from how many authoritative ticks `onTick` applied this frame, a burst of confirmed
   * ticks no longer lurches the sprite two steps while a starved frame freezes it — the two failure
   * modes that read as the local player jittering while the rest of the scene glides.
   *
   * A gap above `snapDistancePx` cuts (a revive, a stage load, a boss yank); a gap below `deadzonePx`
   * is left untouched, so a prediction that already agrees to a fraction of a pixel is not chased into
   * a shimmer; anything between glides by `catchUpPerTick`.
   */
  advance(): void {
    this.prevX = this.curX;
    this.prevY = this.curY;

    // How far the dead-reckoned target moved since the previous render step. While alive this is the
    // walk velocity and is fed forward in full so a steady walk tracks with zero lag; a corpse's target
    // does not walk, it jumps back to where the world stopped it, so its "velocity" is not fed forward.
    const deltaX = this.alive ? this.predX - this.lastPredX : 0;
    const deltaY = this.alive ? this.predY - this.lastPredY : 0;
    this.lastPredX = this.predX;
    this.lastPredY = this.predY;

    // The whole gap between where the sprite is drawn and where the world now says it is. The snap
    // decision reads this, not the residual after velocity — a revive across the map or a boss yank
    // arrives as one enormous gap and gliding it would read as skating across the floor.
    const gapX = this.predX - this.curX;
    const gapY = this.predY - this.curY;
    const gap = Math.sqrt(gapX * gapX + gapY * gapY);
    if (gap > this.stats.maxErrorPx) this.stats.maxErrorPx = gap;

    if (gap > this.snapDistancePx) {
      this.stats.snaps++;
      this.curX = this.predX;
      this.curY = this.predY;
      this.prevX = this.predX;
      this.prevY = this.predY;
      return;
    }

    // The standing error that remains once this step's velocity is applied. This — not the whole gap —
    // is what the glide closes, so a steady walk (where the sprite already keeps pace with `deltaX`) has
    // zero error to chase and sits exactly on the truth rather than hunting around it. For a corpse
    // `deltaX` is zero, so this is the whole standing gap and the sprite eases back onto the body.
    const errX = this.predX - (this.curX + deltaX);
    const errY = this.predY - (this.curY + deltaY);
    const err = Math.sqrt(errX * errX + errY * errY);

    // A sub-pixel standing error is not worth chasing: closing it only makes the sprite hunt around the
    // truth every frame as the target breathes with the confirm cadence, which is the jitter itself.
    // Ride the velocity through so motion stays smooth, and leave the residual alone.
    if (err <= this.deadzonePx) {
      this.curX += deltaX;
      this.curY += deltaY;
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
