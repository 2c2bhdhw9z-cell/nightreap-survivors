/**
 * Lifecycle probe — separates "iOS killed us for memory" from "iOS suspended a backgrounded app".
 *
 * WHY THIS EXISTS
 * Every leak trial so far ends the same ambiguous way: the flight log says the process died with no
 * clean exit. That is exactly what a jetsam OOM looks like — and also exactly what a routine
 * suspension looks like when the screen locks and the app is discarded twenty minutes later. The
 * three trials that "survived" 32-35 minutes were watched by a human; the ones that died were left
 * alone. Which means the deaths and the survivals differ in a way that has nothing to do with GL.
 *
 * Two facts settle it, and both are observable from JS:
 *
 *   1. App state at death. If the last recorded state is `background`, the kill is uninformative:
 *      iOS reclaims suspended apps on its own schedule and no amount of leak-fixing prevents it.
 *   2. Memory warnings. iOS delivers a low-memory notification before it starts killing. React
 *      Native surfaces it as an AppState `memoryWarning` event. Warnings before a death is real
 *      memory pressure; a death with zero warnings while foregrounded is *not* an OOM — it points
 *      at the GPU watchdog, a driver fault, or a native crash instead.
 *
 * The probe is deliberately dumb: the host feeds it events, it accumulates counters, and the flight
 * recorder samples it. It holds no RN import so `game/` stays platform-free.
 */

/** Numeric app states, small enough to write into every flight sample without bloating it. */
export const APP_STATE = {
  active: 0,
  inactive: 1,
  background: 2,
} as const;

export type AppStateCode = (typeof APP_STATE)[keyof typeof APP_STATE];

export const APP_STATE_LABEL: Record<AppStateCode, string> = {
  0: "foreground",
  1: "inactive",
  2: "background",
};

/** Snapshot handed to the flight recorder each sample. */
export interface LifecycleSnapshot {
  state: AppStateCode;
  /** Cumulative ms spent anywhere other than `active`. */
  bgMs: number;
  /** Times the app left `active`. Screen locks, notification pulls, app switches. */
  bgCount: number;
  /** iOS low-memory notifications received this run. */
  memWarn: number;
  /** Seconds into the run when the first memory warning arrived, or -1 if none. */
  firstMemWarnS: number;
}

export class LifecycleProbe {
  private state: AppStateCode = APP_STATE.active;
  private bgSinceMs = -1;
  private bgMs = 0;
  private bgCount = 0;
  private memWarn = 0;
  private firstMemWarnMs = -1;

  constructor(private readonly startedAtMs: number) {}

  /**
   * Record a state transition. Repeated identical states are ignored so a host that re-emits the
   * current state on mount cannot inflate the background counter.
   */
  setState(next: AppStateCode, atMs: number): void {
    if (next === this.state) return;
    const wasActive = this.state === APP_STATE.active;
    const isActive = next === APP_STATE.active;
    if (wasActive && !isActive) {
      this.bgSinceMs = atMs;
      this.bgCount++;
    } else if (!wasActive && isActive && this.bgSinceMs >= 0) {
      this.bgMs += Math.max(0, atMs - this.bgSinceMs);
      this.bgSinceMs = -1;
    }
    this.state = next;
  }

  noteMemoryWarning(atMs: number): void {
    this.memWarn++;
    if (this.firstMemWarnMs < 0) this.firstMemWarnMs = atMs;
  }

  snapshot(atMs: number): LifecycleSnapshot {
    // Count the in-progress background stretch too, otherwise a sample taken while suspended
    // reports zero background time — the one case where the number matters most.
    const pending = this.bgSinceMs >= 0 ? Math.max(0, atMs - this.bgSinceMs) : 0;
    return {
      state: this.state,
      bgMs: this.bgMs + pending,
      bgCount: this.bgCount,
      memWarn: this.memWarn,
      firstMemWarnS:
        this.firstMemWarnMs < 0 ? -1 : Math.round((this.firstMemWarnMs - this.startedAtMs) / 1000),
    };
  }
}

/**
 * Turn the lifecycle tail of a dead run into a verdict. Returned separately from the frame stats
 * because this is the line that decides whether the trial counts at all.
 */
export function explainDeath(last: LifecycleSnapshot | null): string[] {
  if (!last) return ["lifecycle not recorded (older trial) — foreground/background unknown"];
  const lines: string[] = [];
  lines.push(
    `app was ${APP_STATE_LABEL[last.state]} at the last sample · left foreground ${last.bgCount}× · ${(last.bgMs / 1000).toFixed(0)}s not-foreground`,
  );
  if (last.memWarn > 0) {
    lines.push(
      `iOS issued ${last.memWarn} low-memory warning${last.memWarn === 1 ? "" : "s"}, first at ${last.firstMemWarnS}s — REAL MEMORY PRESSURE`,
    );
  } else {
    lines.push("no low-memory warning was ever delivered");
  }
  if (last.state !== APP_STATE.active) {
    lines.push("TRIAL INCONCLUSIVE — died while not foregrounded; iOS discards suspended apps");
  } else if (last.memWarn === 0) {
    lines.push("died FOREGROUND with zero memory warnings — this is not a jetsam OOM");
  } else {
    lines.push("died FOREGROUND after memory warnings — jetsam OOM confirmed");
  }
  return lines;
}
