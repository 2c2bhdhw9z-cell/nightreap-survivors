/**
 * Flight recorder — survives the crash so we don't need the user to catch a screenshot.
 *
 * WHY THIS EXISTS
 * On a real iPhone the bench froze at ~1:15 and the app vanished straight to the home screen at
 * ~9:30 with no error screen. That signature is iOS jetsam: the OS killed the process for memory.
 * A jetsam kill gives the app no notification, no unwind, and no chance to render anything — so
 * asking someone to screenshot the panel "just before it dies" is asking for the impossible.
 *
 * Instead we write a compact snapshot to disk every couple of seconds during the run. If the
 * process dies, the last snapshot is still there on next launch: it tells us the memory trend, the
 * bytes-per-frame, and how far the sim got, which is exactly the evidence needed to separate a
 * memory leak from a GL stall.
 *
 * The writes are deliberately small and infrequent. This is an instrument, not a save system — the
 * real save path (atomic write plus backup slot) is a separate thing and does not use this.
 */

import type { LifecycleSnapshot } from "./lifecycle";
import { explainDeath, explainStop } from "./lifecycle";

export interface FlightSample {
  /** Seconds since the run started. */
  t: number;
  quads: number;
  /** Sim ticks completed. Should track t*60 closely; a gap means the loop stalled. */
  tick: number;
  /** Rendered frames issued by the JS loop. */
  frames: number;
  p50: number;
  p99: number;
  droppedTicks: number;
  /** Vertex bytes handed to GL on the last frame. Constant if nothing is leaking upward. */
  uploadBytes: number;
  /** JS heap in MB where the engine exposes it, else -1. A climbing value is the smoking gun. */
  heapMb: number;
  /** ms since the sim tick counter last moved. */
  simStaleMs: number;
  frameErrors: number;
  lastError: string | null;
  /**
   * App state and memory-warning counters at this sample. Optional because trials recorded before
   * the probe existed have to keep decoding.
   */
  life?: LifecycleSnapshot;
}

export interface FlightLog {
  /** Wall-clock ms when the run began, so we can tell an old log from a fresh one. */
  startedAt: number;
  /** Whether the run was closed down cleanly. False after a crash or an OS kill. */
  cleanExit: boolean;
  device: string;
  /** Rolling window of samples; oldest dropped. */
  samples: FlightSample[];
}

/** Keep the tail, not the whole flight — enough to see a trend, small enough to write often. */
export const MAX_SAMPLES = 90;

export const FLIGHT_KEY = "nightreap.bench.flight.v1";

/**
 * Minimal storage surface so `game/` stays free of React Native imports. The host passes in
 * AsyncStorage (or anything with the same two methods).
 */
export interface FlightStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export class FlightRecorder {
  private readonly log: FlightLog;
  private writing = false;
  private dirty = false;

  constructor(
    private readonly store: FlightStore,
    device: string,
    startedAt: number,
    /** Separate slot per experiment, so a leak trial cannot overwrite the Gate A log. */
    private readonly key: string = FLIGHT_KEY,
  ) {
    this.log = { startedAt, cleanExit: false, device, samples: [] };
  }

  /** Read whatever the previous run left behind, before starting a new one. */
  static async readPrevious(store: FlightStore, key: string = FLIGHT_KEY): Promise<FlightLog | null> {
    try {
      const raw = await store.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as FlightLog;
      return Array.isArray(parsed.samples) ? parsed : null;
    } catch {
      return null;
    }
  }

  push(sample: FlightSample): void {
    this.log.samples.push(sample);
    if (this.log.samples.length > MAX_SAMPLES) this.log.samples.shift();
    this.dirty = true;
  }

  /**
   * Persist the current tail. Overlapping writes are dropped rather than queued — a backed-up write
   * queue is itself a memory leak, and losing one sample of a 90-sample window costs nothing.
   */
  async persist(cleanExit = false): Promise<void> {
    if (cleanExit) this.log.cleanExit = true;
    if (this.writing || (!this.dirty && !cleanExit)) return;
    this.writing = true;
    this.dirty = false;
    try {
      await this.store.setItem(this.key, JSON.stringify(this.log));
    } catch {
      // A failed instrument write must never take down the thing being measured.
    } finally {
      this.writing = false;
    }
  }

  get sampleCount(): number {
    return this.log.samples.length;
  }
}

/**
 * Turn a recovered log into a verdict a human can read at a glance.
 *
 * The three questions it answers, in the order they matter:
 *  1. Did the process die? (`cleanExit === false` with samples present)
 *  2. Was memory climbing when it died? (heap slope across the window)
 *  3. Did the sim stall before the process died? (tick falling behind wall time)
 */
export function summariseFlight(log: FlightLog): string[] {
  const s = log.samples;
  if (s.length === 0) return ["previous run recorded no samples"];

  const first = s[0];
  const last = s[s.length - 1];
  const lines: string[] = [];

  lines.push(
    log.cleanExit
      ? `previous run exited cleanly after ${last.t}s`
      : `PREVIOUS RUN DIED at ${last.t}s — no clean exit (OS kill or hard crash)`,
  );
  lines.push(`device ${log.device} · ${last.quads} quads · ${s.length} samples`);
  // Both endings get a verdict now. Printing one only on death is what made four stopped trials
  // worthless: the run ended, the log said nothing, and the evidence went in the bin.
  for (const line of log.cleanExit
    ? explainStop(last.life ?? null, last.t)
    : explainDeath(last.life ?? null)) {
    lines.push(line);
  }

  if (first.heapMb >= 0 && last.heapMb >= 0) {
    const dt = Math.max(1, last.t - first.t);
    const slope = (last.heapMb - first.heapMb) / dt;
    lines.push(
      `heap ${first.heapMb.toFixed(1)}MB -> ${last.heapMb.toFixed(1)}MB (${slope >= 0 ? "+" : ""}${(slope * 60).toFixed(1)}MB/min)`,
    );
    if (slope * 60 > 2) lines.push("MEMORY IS CLIMBING — consistent with an OOM kill");
  } else {
    lines.push("heap not reported by this engine (JS heap unavailable)");
  }

  const expectedTicks = last.t * 60;
  const behind = expectedTicks - last.tick;
  lines.push(
    `sim tick ${last.tick} vs ${expectedTicks} expected (${behind > 0 ? `${(behind / 60).toFixed(1)}s behind` : "on time"})`,
  );

  // Find the first sample where the sim had clearly stopped advancing, which is the freeze moment.
  for (let i = 1; i < s.length; i++) {
    if (s[i].tick === s[i - 1].tick) {
      lines.push(`sim froze between ${s[i - 1].t}s and ${s[i].t}s (tick stuck at ${s[i].tick})`);
      break;
    }
  }

  lines.push(`p50 ${last.p50.toFixed(1)}ms · p99 ${last.p99.toFixed(1)}ms · upload ${(last.uploadBytes / 1024).toFixed(0)}KB/frame`);
  if (last.frameErrors > 0) lines.push(`frame errors ${last.frameErrors}: ${last.lastError ?? "?"}`);
  return lines;
}
