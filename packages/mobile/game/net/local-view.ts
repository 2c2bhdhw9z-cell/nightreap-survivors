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
 * BURST FEED-FORWARD IS RATE-LIMITED, NOT DUMPED IN ONE STEP
 * Decoupling the two clocks stops the sprite gliding *inside* `onTick`, but a subtler lurch survived:
 * `advance` fed the target's motion since the previous render step forward in full. On a frame where
 * `pump()` applied three confirmed ticks the target jumped ~3px, so that one `advance` drew ~3px of
 * feed-forward, and the next starved frame (zero applied ticks) drew ~0 — a fast-slow-fast stutter at
 * the confirm cadence even though the underlying walk is perfectly steady. The fix is to carry the
 * outstanding target motion in a small pending accumulator and release at most one sim-tick of motion
 * per render step: a three-tick burst is spread over the next three render steps instead of shown at
 * once. The per-step budget is a smoothed estimate of one render step's worth of target motion, so a
 * steady walk (one applied tick per step) still draws its full pixel with zero lag, and only bursts
 * are flattened. This is NOT per-applied-tick gliding — the glide still runs once per render step in
 * `advance`; only the *velocity* being fed into it is steadied so it stops tracking the bursty cadence.
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
  /**
   * How quickly the per-step feed-forward cap (`stepCap`) eases *down* toward a slower per-applied-tick
   * target speed. The cap rises instantly (fast attack) so a walk reaches full feed-forward at once and
   * never lags, but decays by this fraction per applied tick, so a single slow or downed tick does not
   * collapse the cap and make the next burst lurch again. Low enough to ride through the momentary
   * dips of a bursty confirm cadence, high enough that a genuine slow-down settles within a few ticks.
   */
  budgetSmoothing: 0.15,
} as const;

export interface LocalViewOptions {
  maxLeadTicks?: number;
  snapDistancePx?: number;
  catchUpPerTick?: number;
  deadzonePx?: number;
  budgetSmoothing?: number;
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
  readonly budgetSmoothing: number;

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
   * Target motion that has been confirmed but not yet fed into the drawn glide. A burst frame — where
   * `pump` applied several confirmed ticks at once — moves the target several sim-ticks in one lump;
   * only one sim-tick of that is drawn this render step and the rest is banked here and drawn over the
   * following steps, so the drawn feed-forward velocity is the target's steady average rather than the
   * bursty confirm cadence. This is *motion* owed, kept separate from the standing prediction *error*
   * the glide closes, so the two never double-count.
   */
  private pendingX = 0;
  private pendingY = 0;

  /**
   * Smoothed estimate of ONE SIM-TICK's worth of target motion, in world px — the per-render-step
   * feed-forward cap. Crucially this is an EMA of motion-per-*applied-tick* (`rawMag / appliedTicks`),
   * not motion-per-render-step: a three-tick burst and a one-tick step both report ~1px of per-tick
   * motion, so the cap holds steady at the true walk speed instead of being dragged up by bursts. One
   * applied tick maps to one render step on a matched clock, so releasing up to one tick's motion per
   * render step drains a steady walk's pending completely (zero lag) while spreading a burst over the
   * render steps that follow. Derived entirely on the render clock, so no move speed need be passed in.
   */
  private stepCap = 0;

  /**
   * Applied ticks since the last `advance`. `onTick` bumps it (each confirmed tick that moves the
   * target), `advance` reads it to turn this step's lumped target motion into a per-tick figure for the
   * cap, then clears it. Zero on a starved render frame, several on a burst frame.
   */
  private appliedTicks = 0;

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
    this.budgetSmoothing = options.budgetSmoothing ?? LOCAL_VIEW_DEFAULTS.budgetSmoothing;
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
    this.pendingX = 0;
    this.pendingY = 0;
    this.stepCap = 0;
    this.appliedTicks = 0;
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
    // Count this applied tick so the next `advance` can turn its lumped target motion into a per-tick
    // figure for the feed-forward cap. Counted whether alive or downed: a downed tick still consumed a
    // render step's worth of the confirm cadence, and its zero motion should pull the cap toward a stop.
    this.appliedTicks++;

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
   * modes that read as the local player jittering while the rest of the scene glides. The feed-forward
   * itself is rate-limited too: the target's motion since the last step is banked and only one sim-tick's
   * worth (`stepCap`) is released per render step, so a three-tick burst is spread over the next three
   * steps rather than shown as one lurch, while a steady walk still draws its full step per step.
   *
   * A gap above `snapDistancePx` cuts (a revive, a stage load, a boss yank); a gap below `deadzonePx`
   * is left untouched, so a prediction that already agrees to a fraction of a pixel is not chased into
   * a shimmer; anything between glides by `catchUpPerTick`.
   */
  advance(): void {
    this.prevX = this.curX;
    this.prevY = this.curY;

    // How far the dead-reckoned target moved since the previous render step. On a steady walk this is
    // one tick of motion; on a burst frame where `pump` applied several confirmed ticks at once it is
    // several ticks in one lump, and on a starved frame it is zero. A corpse's target does not walk —
    // it jumps back to where the world stopped it — so its motion is not banked or fed forward.
    const rawX = this.alive ? this.predX - this.lastPredX : 0;
    const rawY = this.alive ? this.predY - this.lastPredY : 0;
    this.lastPredX = this.predX;
    this.lastPredY = this.predY;

    // Bank every pixel of target motion owed, and grow the per-step cap toward one sim-tick's motion.
    // The cap tracks motion-per-*applied-tick*, not per render step, so a burst (three ticks of motion
    // at once) reports the same ~1px/tick as a lone step and does not drag the cap up: the cap stays at
    // the true walk speed. A render step that applied ticks contributes its per-tick motion to the EMA;
    // a starved step (no applied tick) leaves the cap where it is, so the sprite keeps coasting at the
    // established speed while it drains the pending a burst left behind rather than stalling.
    this.pendingX += rawX;
    this.pendingY += rawY;
    const applied = this.appliedTicks;
    this.appliedTicks = 0;
    if (applied > 0) {
      const perTickMag = Math.sqrt(rawX * rawX + rawY * rawY) / applied;
      // Fast attack, slow decay. The cap rises to a faster per-tick speed at once — so a steady walk
      // reaches full feed-forward on its very first applied tick and tracks with zero lag, and a real
      // speed-up (a boot upgrade) is followed immediately rather than lagged. It only eases *down*
      // gently, so a momentary slow tick or a downed frame does not collapse the cap and re-lurch the
      // sprite on the next burst. A burst reports the same per-tick motion as a lone step, so it never
      // inflates the cap: only genuine per-tick speed does.
      this.stepCap =
        perTickMag >= this.stepCap
          ? perTickMag
          : this.stepCap + (perTickMag - this.stepCap) * this.budgetSmoothing;
    }

    // Release at most one step's cap of the banked motion this render step, along the pending vector.
    // What is left stays banked for the next steps — this is the whole rate limiter: a three-tick burst
    // is paid out over the three steps that follow instead of lurching the sprite in one.
    const pendMag = Math.sqrt(this.pendingX * this.pendingX + this.pendingY * this.pendingY);
    let deltaX = this.pendingX;
    let deltaY = this.pendingY;
    if (pendMag > this.stepCap && pendMag > 1e-9) {
      const scale = this.stepCap / pendMag;
      deltaX = this.pendingX * scale;
      deltaY = this.pendingY * scale;
    }
    this.pendingX -= deltaX;
    this.pendingY -= deltaY;

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
      this.pendingX = 0;
      this.pendingY = 0;
      return;
    }

    // The standing prediction error, once this step's feed-forward AND the motion still banked for the
    // steps to come are both accounted for. Subtracting `pending` is what keeps the rate limiter from
    // fighting the glide: banked motion is valid target motion that will be drawn shortly, not a
    // disagreement to be chased now, so folding it in would let `catchUpPerTick` yank it forward this
    // step and undo the smoothing (and double-count it). So a steady walk (pending empty, sprite pacing
    // `deltaX`) has zero error and sits exactly on the truth, while a burst leaves only its banked
    // remainder behind, not an error. For a corpse `deltaX` and `pending` are both zero, so this is the
    // whole standing gap and the sprite eases back onto the body.
    const errX = this.predX - (this.curX + deltaX + this.pendingX);
    const errY = this.predY - (this.curY + deltaY + this.pendingY);
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
