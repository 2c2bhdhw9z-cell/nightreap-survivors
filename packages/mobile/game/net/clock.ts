/**
 * Tick clock synchronisation and drift management.
 *
 * THE PROBLEM
 * Host and guest both run a 60Hz fixed-step sim, but they started at different wall-clock moments and
 * their crystals are not identical. Left alone a guest ends up simulating tick 40,000 while the host
 * is at 40,050 — inputs then arrive for ticks the guest has already passed, and the game feels like it
 * is fighting the player.
 *
 * THE APPROACH
 * Estimate the offset between our tick and the host's from PING/PONG round trips, then correct by
 * *rate*, not by jumping: run the sim slightly fast or slightly slow until the offset closes. A
 * 1-in-16 tick adjustment is invisible; a 50-tick jump is a visible teleport. Only past
 * `MAX_DRIFT_TICKS` do we give up and snap, because beyond ~0.3s the smooth path takes longer than
 * the player's patience.
 *
 * WHY MEDIAN AND NOT MEAN
 * Mobile networks produce occasional 500ms outliers. A mean drags the whole estimate toward them for
 * seconds; a median of the last several samples ignores them entirely. This is the single highest-
 * value line of code in the file.
 */

import { MAX_DRIFT_TICKS } from "./protocol";

/** Milliseconds per simulation tick at 60Hz. */
export const MS_PER_TICK = 1000 / 60;

/** RTT samples retained for the median. Odd, so the median needs no averaging. */
export const RTT_SAMPLES = 9;

/** Offset closes at one tick per this many ticks — about 4% speed change, below perception. */
export const DRIFT_CORRECTION_INTERVAL = 24;

export class NetClock {
  private readonly rtt = new Float64Array(RTT_SAMPLES);
  private readonly sorted = new Float64Array(RTT_SAMPLES);
  private rttWrite = 0;
  private rttFilled = 0;

  /** Estimated host tick minus our tick. Positive means the host is ahead and we should speed up. */
  offsetTicks = 0;
  /** Median round-trip time in ms. */
  rttMs = 0;
  /** Ticks since we last applied a rate adjustment. */
  private sinceAdjust = 0;
  /** Set for one tick after a hard snap, so the renderer can suppress interpolation across the cut. */
  snapped = false;
  /** Cumulative counters for the dev menu's netcode panel. */
  totalSnaps = 0;
  totalAdjustments = 0;

  /**
   * Fold in one completed round trip.
   *
   * `hostTick` is the host's tick at the moment it replied, so the host's tick *now* is
   * approximately that plus half an RTT worth of ticks. Using half rather than full RTT assumes a
   * symmetric path, which is wrong on mobile often enough that we do not chase the residual — the
   * correction sweep and input delay absorb a tick or two of bias without anyone noticing.
   */
  sample(rttMs: number, hostTick: number, ourTick: number): void {
    this.rtt[this.rttWrite] = rttMs;
    this.rttWrite = (this.rttWrite + 1) % RTT_SAMPLES;
    if (this.rttFilled < RTT_SAMPLES) this.rttFilled++;
    this.rttMs = this.medianRtt();

    const oneWayTicks = Math.round(this.rttMs / 2 / MS_PER_TICK);
    this.offsetTicks = hostTick + oneWayTicks - ourTick;
  }

  private medianRtt(): number {
    const n = this.rttFilled;
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) this.sorted[i] = this.rtt[i] as number;
    // Insertion sort: n is 9.
    for (let i = 1; i < n; i++) {
      const v = this.sorted[i] as number;
      let j = i - 1;
      while (j >= 0 && (this.sorted[j] as number) > v) {
        this.sorted[j + 1] = this.sorted[j] as number;
        j--;
      }
      this.sorted[j + 1] = v;
    }
    return this.sorted[n >> 1] as number;
  }

  /**
   * How many ticks to run this frame, given how many the frame timer says are due.
   *
   * Returns `dueTicks` most of the time, one more or one fewer when closing an offset, and the whole
   * offset at once after a snap. Never returns a negative number — a guest that is ahead stalls for a
   * tick rather than rewinding, because rewinding would undo already-rendered frames.
   */
  adjust(dueTicks: number): number {
    this.snapped = false;
    const offset = this.offsetTicks;

    if (offset > MAX_DRIFT_TICKS || offset < -MAX_DRIFT_TICKS) {
      this.snapped = true;
      this.totalSnaps++;
      this.offsetTicks = 0;
      // Fast-forward when behind; when ahead, stall this frame and let the host catch up.
      return offset > 0 ? dueTicks + offset : 0;
    }

    if (offset === 0) return dueTicks;

    this.sinceAdjust++;
    if (this.sinceAdjust < DRIFT_CORRECTION_INTERVAL) return dueTicks;
    this.sinceAdjust = 0;
    this.totalAdjustments++;

    if (offset > 0) {
      this.offsetTicks = offset - 1;
      return dueTicks + 1;
    }
    this.offsetTicks = offset + 1;
    return dueTicks > 0 ? dueTicks - 1 : 0;
  }

  /** True when the connection is healthy enough for the run to count competitively. */
  get healthy(): boolean {
    return this.rttFilled > 0 && this.rttMs < 150 && Math.abs(this.offsetTicks) <= MAX_DRIFT_TICKS;
  }

  reset(): void {
    this.rtt.fill(0);
    this.rttWrite = 0;
    this.rttFilled = 0;
    this.offsetTicks = 0;
    this.rttMs = 0;
    this.sinceAdjust = 0;
    this.snapped = false;
  }
}
