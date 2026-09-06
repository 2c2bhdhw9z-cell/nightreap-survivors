/**
 * The render frame gate — the one rule that decides whether a given requestAnimationFrame callback
 * draws a frame or skips it.
 *
 * WHY THIS IS ITS OWN FILE
 * The simulation is a fixed 60Hz tick with interpolated rendering (see `loop.ts`), so the RENDER rate
 * is free: it can run at 60, 120, or as fast as the display allows without touching determinism. The
 * player picks 60, 120, or DYNAMIC (follow the display), which resolves to a `targetFps` cap. The rule
 * for turning that cap into a per-frame "draw or skip" decision is arithmetic over three numbers, and
 * it belongs here — pure, allocation-free, and unit-tested — rather than buried in the play screen where
 * it can only be checked on a phone.
 *
 * WHAT DYNAMIC MEANS
 * A `targetFps` of zero (or anything <= 0, or non-finite) is the DYNAMIC sentinel: draw every frame the
 * display offers. That is exactly "follow the panel's natural cadence", which is what auto-detect is —
 * a 60Hz panel calls rAF 60 times a second, a 120Hz panel 120, and a 144/165Hz panel more still, and
 * drawing on every callback tracks all of them for free. `DYNAMIC_TARGET_FPS` names the sentinel.
 *
 * THE DECOUPLING GUARANTEE
 * This helper decides only whether to DRAW. It never touches the sim. `FixedLoop.advance(now)` must
 * still be called with the true `now` on every rAF callback so the 60Hz sim keeps its exact tick count
 * regardless of how many frames are drawn — skipping a draw must never starve the sim. The play screen
 * calls `advance` unconditionally and calls this helper only to gate the drawing work.
 */

/** The DYNAMIC sentinel for `ResolvedSettings.targetFps`: uncapped, follow the display's own cadence. */
export const DYNAMIC_TARGET_FPS = 0;

/**
 * A small slice of a frame's budget that a drawn frame is allowed to arrive early by, in fractions of
 * the target interval. Real displays never hand rAF an exact boundary — a 60Hz callback lands a hair
 * before or after 16.667ms — so gating on the interval exactly would drop every other frame at 60Hz on
 * a 60Hz panel (the classic beat-frequency stutter). Allowing a frame through when it is within this
 * fraction of the target keeps a 60Hz cap running at a steady ~60 on a 60Hz display instead of ~30.
 */
export const FRAME_GATE_TOLERANCE = 0.5;

/**
 * Whether this rAF callback should draw, given the monotonic clock now, when the last frame was actually
 * drawn, and the resolved target frame rate.
 *
 * - DYNAMIC (`targetFps` <= 0 or non-finite): always draws — the display's cadence is the cap.
 * - 60 / 120 / any positive cap: draws only once at least `1000/targetFps` ms, minus a small tolerance,
 *   has elapsed since the last DRAWN frame. Otherwise the caller skips the draw but still reschedules
 *   rAF (and still advances the sim), so the next callback gets another chance.
 *
 * `lastDrawnMs < 0` means "nothing drawn yet" — always draw the first frame. Pure and allocation-free.
 */
export function shouldDrawFrame(nowMs: number, lastDrawnMs: number, targetFps: number): boolean {
  // DYNAMIC, or a nonsensical cap: follow the display and draw every frame.
  if (!Number.isFinite(targetFps) || targetFps <= 0) return true;
  // First frame of the run, or a clock that has not started: draw it.
  if (lastDrawnMs < 0) return true;
  const elapsed = nowMs - lastDrawnMs;
  // A clock that stood still or went backwards is not a reason to draw twice in an instant, but it is
  // also not a reason to freeze: treat a non-positive gap as "not yet" so the cap holds.
  if (elapsed <= 0) return false;
  const targetInterval = 1000 / targetFps;
  return elapsed >= targetInterval - FRAME_GATE_TOLERANCE;
}

/**
 * A rolling estimate of the display's real refresh rate, in Hz, from the intervals between drawn frames.
 *
 * This exists for DYNAMIC: the player asked for "detect 60, 120, and higher", and the only honest way to
 * know a panel's rate is to measure how often it actually calls us. It keeps a small ring of recent
 * frame intervals and reports the refresh implied by their MEDIAN — the median rather than the mean so a
 * single GC hitch or a backgrounded gap does not drag the estimate down. Fixed-size, allocates once, and
 * reads no clock of its own: the caller feeds it the same `now` it uses for everything else.
 */
export class RefreshEstimator {
  private readonly intervals: Float64Array;
  private readonly sorted: Float64Array;
  private index = 0;
  private count = 0;
  private lastMs = -1;

  /** Sixteen frames is a fraction of a second at any real rate — long enough to be steady, short enough to react. */
  constructor(capacity = 16) {
    this.intervals = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  /** Record a drawn frame at `nowMs`. Ignores the first sample (no interval yet) and any absurd gap. */
  sample(nowMs: number): void {
    if (this.lastMs >= 0) {
      const delta = nowMs - this.lastMs;
      // A backgrounded app or a paused clock produces a huge or non-positive gap that is not a refresh
      // interval. Drop it rather than let it poison the median.
      if (delta > 0 && delta < 1000) {
        this.intervals[this.index] = delta;
        this.index = (this.index + 1) % this.intervals.length;
        if (this.count < this.intervals.length) this.count++;
      }
    }
    this.lastMs = nowMs;
  }

  /** Reset after a background gap or a pause, so the next interval is not measured across the gap. */
  reset(): void {
    this.lastMs = -1;
  }

  /**
   * The estimated refresh in Hz, or zero until enough frames have been seen. Uses the median interval,
   * so 60Hz reports ~60, 120Hz ~120, and a 144/165Hz panel reports the higher figure honestly.
   */
  get hz(): number {
    if (this.count < 2) return 0;
    this.sorted.set(this.intervals.subarray(0, this.count));
    const view = this.sorted.subarray(0, this.count);
    view.sort();
    const mid =
      this.count % 2 === 1
        ? view[(this.count - 1) >> 1]
        : (view[this.count >> 1] + view[(this.count >> 1) - 1]) / 2;
    if (mid <= 0) return 0;
    return 1000 / mid;
  }
}
