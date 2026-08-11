/**
 * Fixed-timestep simulation loop with interpolated rendering.
 *
 * THE CONTRACT
 * - Simulation runs at exactly 60Hz. Every tick advances the world by the same amount, always.
 * - Rendering runs as fast as the display allows (120Hz on the good phones) and interpolates
 *   between the last two sim states, so motion is smooth without the sim being frame-rate coupled.
 * - The simulation never reads a clock. Time enters only through `advance(nowMs)`, which the host
 *   shell calls. That is what makes headless replay and CI soak tests possible: feed the same tick
 *   count and you get the same world, with no wall clock involved.
 *
 * SPIRAL OF DEATH
 * If a frame takes longer than the accumulated budget (app backgrounded, a GC pause, thermal
 * throttle on the REVVL), catching up tick-for-tick makes it worse: more ticks, longer frame,
 * more debt. `MAX_CATCHUP_TICKS` caps the work and the surplus is discarded — the run slows for a
 * moment instead of freezing outright. In co-op, the host's authoritative events plus the
 * correction sweep pull a lagging client back into line, so dropped local time self-heals.
 */

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * Ceiling on ticks simulated in one frame. Six is ~100ms of catch-up: enough to absorb a GC pause
 * or a dropped frame, small enough that it can't cascade.
 */
export const MAX_CATCHUP_TICKS = 6;

/** Beyond this the app was almost certainly backgrounded — throw the debt away entirely. */
const BACKGROUND_GAP_MS = 1000;

export interface LoopStats {
  /** Sim ticks completed since the run started. The sim's only notion of time. */
  tick: number;
  /** Ticks executed on the most recent `advance` call. */
  ticksThisFrame: number;
  /** Ticks discarded because of the catch-up cap. Non-zero means we are losing to the hardware. */
  droppedTicks: number;
  /** 0..1 progress between the previous and current sim state, for render interpolation. */
  alpha: number;
  /** Frames observed, for FPS reporting. */
  frames: number;
}

export class FixedLoop {
  private accumulatorMs = 0;
  private lastMs = -1;

  readonly stats: LoopStats = {
    tick: 0,
    ticksThisFrame: 0,
    droppedTicks: 0,
    alpha: 0,
    frames: 0,
  };

  constructor(private readonly onTick: (tick: number) => void) {}

  /** Call once when the run starts or after a pause, so the first frame doesn't see a huge gap. */
  reset(nowMs: number, startTick = 0): void {
    this.accumulatorMs = 0;
    this.lastMs = nowMs;
    this.stats.tick = startTick;
    this.stats.ticksThisFrame = 0;
    this.stats.droppedTicks = 0;
    this.stats.alpha = 0;
  }

  /**
   * Advance the simulation to catch up with `nowMs`, then report how far between ticks we landed.
   * Returns the number of ticks executed.
   */
  advance(nowMs: number): number {
    if (this.lastMs < 0) {
      this.reset(nowMs, this.stats.tick);
      return 0;
    }

    let deltaMs = nowMs - this.lastMs;
    this.lastMs = nowMs;
    this.stats.frames++;

    // A clock that went backwards (or a suspended app) is not real elapsed time.
    if (deltaMs < 0) deltaMs = 0;
    if (deltaMs > BACKGROUND_GAP_MS) deltaMs = TICK_MS;

    this.accumulatorMs += deltaMs;

    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      this.stats.tick++;
      this.onTick(this.stats.tick);
      ticks++;
    }

    if (this.accumulatorMs >= TICK_MS) {
      const dropped = Math.floor(this.accumulatorMs / TICK_MS);
      this.stats.droppedTicks += dropped;
      this.accumulatorMs -= dropped * TICK_MS;
    }

    this.stats.ticksThisFrame = ticks;
    this.stats.alpha = this.accumulatorMs / TICK_MS;
    return ticks;
  }

  /**
   * Run exactly N ticks with no clock involved. This is the headless path: replay validation,
   * determinism comparison, and the 3-hour soak test all drive the sim through here.
   */
  runTicks(count: number): void {
    for (let i = 0; i < count; i++) {
      this.stats.tick++;
      this.onTick(this.stats.tick);
    }
    this.stats.alpha = 0;
  }
}

/**
 * Rolling frame-time tracker.
 *
 * Reports p50/p95/p99 rather than an average, because average FPS hides exactly the thing that
 * ruins a bullet-heaven game: one 40ms hitch per second reads as broken while still averaging 55.
 * Fixed-size ring buffer, zero allocation after construction.
 */
export class FrameTimer {
  private readonly samples: Float64Array;
  private readonly sorted: Float64Array;
  private index = 0;
  private count = 0;

  constructor(capacity = 240) {
    this.samples = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  push(frameMs: number): void {
    this.samples[this.index] = frameMs;
    this.index = (this.index + 1) % this.samples.length;
    if (this.count < this.samples.length) this.count++;
  }

  /** Percentile of recorded frame times in ms. `p` is 0..1. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    this.sorted.set(this.samples.subarray(0, this.count));
    const view = this.sorted.subarray(0, this.count);
    view.sort();
    const i = Math.min(this.count - 1, Math.max(0, Math.round(p * (this.count - 1))));
    return view[i];
  }

  get average(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.samples[i];
    return sum / this.count;
  }

  /** Frames slower than 16.7ms, i.e. anything that missed 60fps. */
  countAbove(ms: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.samples[i] > ms) n++;
    return n;
  }

  get samplesRecorded(): number {
    return this.count;
  }

  clear(): void {
    this.index = 0;
    this.count = 0;
  }
}
