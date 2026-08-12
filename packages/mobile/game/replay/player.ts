/**
 * Replays a tick log against a simulation and reports whether it reproduced.
 *
 * WHY THE SIM IS AN INTERFACE
 * This file must run in three places that share no runtime: on a phone (dev menu, bug repro), in Node
 * or Bun (CI soak, server-side ladder revalidation), and in a browser (web build, replay sharing). So it
 * knows nothing about the simulation beyond `ReplaySim` below. That also means the replay harness exists
 * and is tested *before* the simulation does — which is the right order, because a determinism harness
 * bolted on after the sim is written only ever tells you which of the last six months of code broke it.
 *
 * WHAT "REPRODUCED" MEANS
 * The recorded final state hash matches the replayed one. When it does not, the interesting question is
 * not *that* it diverged but *when*, so the player samples hashes at a fixed interval and reports the
 * first sample that disagreed. That turns "this replay is broken" into "tick 4,201, and here are the 51
 * ticks of input before it".
 */

import { HashTrail, HASH_SEED, type Hashable } from "../net/state-hash";
import {
  MAX_REPLAY_PLAYERS,
  REPLAY_ERROR,
  type ReplayError,
  type RunHeader,
  rleRecordBytes,
} from "./format";
import { decodeReplay } from "./recorder";

/**
 * What the replay harness needs from a simulation. Deliberately tiny.
 *
 * `hashState` comes from the same `Hashable` contract the co-op state hash uses, so there is exactly one
 * definition of "the state" in the codebase. If replay validation and co-op resync could disagree about
 * what counts as state, one of them would be silently wrong.
 */
export interface ReplaySim extends Hashable {
  /** Restore to the exact start-of-run state described by the header. Must allocate nothing per call. */
  resetForReplay(header: RunHeader): void;
  /**
   * Advance one tick with the given quantised inputs. `axes` is `playerCount * 2` int8s, `buttons` is
   * `playerCount` u8s — byte-for-byte what the recorder captured.
   */
  tickWithInput(axes: Int8Array, buttons: Uint8Array): void;
}

/** How often hashes are sampled during a replay, in ticks. One second at 60Hz. */
export const HASH_SAMPLE_INTERVAL = 60;

export interface ReplayResult {
  error: ReplayError;
  /** Ticks actually simulated. */
  ticks: number;
  recordedHash: number;
  replayedHash: number;
  /** True when the log reproduced exactly. The only thing a ladder validator cares about. */
  reproduced: boolean;
  /** First sampled tick whose hash disagreed with a reference trail, or -1. */
  firstDivergentTick: number;
  /** Wall-clock milliseconds spent replaying. Informational; never hashed. */
  elapsedMs: number;
  /** Ticks replayed per second of wall clock — how affordable server-side revalidation actually is. */
  ticksPerSecond: number;
}

/**
 * Replay a log.
 *
 * `reference` is optional: pass the trail from a previous replay (on another device, say) and the result
 * reports the first tick where the two parted company. Pass nothing and it only checks the final hash,
 * which is the server-side revalidation case.
 *
 * Allocates two small typed arrays and nothing else — no per-tick garbage, because the CI soak replays
 * for three hours and a per-tick allocation would turn a determinism test into a GC test.
 */
/**
 * Sub-millisecond clock. `Date.now()` only resolves to whole milliseconds, which is far too coarse
 * to time work that finishes in microseconds.
 */
function nowMs(): number {
  const host = globalThis as unknown as { performance?: { now?: () => number } };
  return host.performance?.now?.() ?? Date.now();
}

export function replay(
  bytes: Uint8Array,
  sim: ReplaySim,
  options?: {
    reference?: HashTrail;
    trail?: HashTrail;
    /** Called at each hash sample. Lets the dev menu draw progress without owning the loop. */
    onSample?: (tick: number, hash: number) => void;
    /** Stop early. Used by "jump to timestamp" in the dev menu and by bisecting a divergence. */
    stopAtTick?: number;
  },
): ReplayResult {
  const startedAt = nowMs();
  const decoded = decodeReplay(bytes);
  const result: ReplayResult = {
    error: decoded.error,
    ticks: 0,
    recordedHash: decoded.header.finalStateHash,
    replayedHash: 0,
    reproduced: false,
    firstDivergentTick: -1,
    elapsedMs: 0,
    ticksPerSecond: 0,
  };
  if (decoded.error !== REPLAY_ERROR.NONE) return result;

  const header = decoded.header;
  const playerCount = header.characterCount;
  const axes = new Int8Array(MAX_REPLAY_PLAYERS * 2);
  const buttons = new Uint8Array(MAX_REPLAY_PLAYERS);
  const recordBytes = rleRecordBytes(playerCount);
  const stopAt = options?.stopAtTick ?? Number.MAX_SAFE_INTEGER;

  sim.resetForReplay(header);

  const stream = decoded.stream;
  let tick = 0;
  let cursor = 0;
  let done = false;

  while (cursor + recordBytes <= stream.byteLength && !done) {
    const count = stream[cursor] as number;
    let at = cursor + 1;
    for (let p = 0; p < playerCount; p++) {
      // Stored as two's-complement bytes; sign-extend back to the int8 the sim consumed.
      axes[p * 2] = (stream[at] as number) << 24 >> 24;
      axes[p * 2 + 1] = (stream[at + 1] as number) << 24 >> 24;
      buttons[p] = stream[at + 2] as number;
      at += 3;
    }
    cursor += recordBytes;

    for (let i = 0; i < count; i++) {
      sim.tickWithInput(axes, buttons);
      tick++;

      if (tick % HASH_SAMPLE_INTERVAL === 0) {
        const hash = sim.hashState(HASH_SEED);
        options?.trail?.record(tick, hash);
        options?.onSample?.(tick, hash);
        if (
          options?.reference &&
          result.firstDivergentTick < 0 &&
          options.reference.has(tick) &&
          options.reference.at(tick) !== hash
        ) {
          result.firstDivergentTick = tick;
        }
      }

      if (tick >= stopAt) {
        done = true;
        break;
      }
    }
  }

  result.ticks = tick;
  result.replayedHash = sim.hashState(HASH_SEED);
  result.elapsedMs = nowMs() - startedAt;
  // Guarded, but the guard should never fire now that the clock is sub-millisecond: a whole-
  // millisecond clock reports 0ms for fast work, which reads as "infinitely slow" and made this
  // measurement useless. Same trap that flattened the on-device frame-time percentiles.
  result.ticksPerSecond = result.elapsedMs > 0 ? Math.round((tick / result.elapsedMs) * 1000) : 0;

  // A partial replay is never "reproduced" — the recorded hash describes the end of the run, so
  // comparing it against a stopped-early state would report a false mismatch on every dev-menu seek.
  const completed = tick === header.tickCount;
  result.reproduced = completed && result.replayedHash === header.finalStateHash;
  if (completed && !result.reproduced) result.error = REPLAY_ERROR.HASH_MISMATCH;

  return result;
}

/**
 * Server-side ladder revalidation.
 *
 * MANDATORY for every competitive submission (plan.md §5b addendum), not sampled. Rejects on three
 * independent grounds, in this order:
 *
 *   1. The log is structurally invalid — cheapest check, so it runs first.
 *   2. The log self-reports as tainted. Honest clients tell on themselves here; dishonest ones do not,
 *      which is exactly why this is not the check we rely on.
 *   3. The log does not reproduce. This is the real boundary. A forged score has to survive resimulation
 *      by our own simulation from inputs alone, which means producing an input sequence that actually
 *      achieves the score — at which point it is not a forgery, it is a run.
 */
export interface ValidationVerdict {
  accepted: boolean;
  error: ReplayError;
  /** Set when rejected specifically for self-reported taint, which is worth telemetry of its own. */
  rejectedForTaint: boolean;
  result: ReplayResult;
}

export function validateForLadder(bytes: Uint8Array, sim: ReplaySim): ValidationVerdict {
  const result = replay(bytes, sim);
  if (result.error !== REPLAY_ERROR.NONE) {
    return { accepted: false, error: result.error, rejectedForTaint: false, result };
  }
  const decoded = decodeReplay(bytes);
  if (decoded.header.tainted !== 0) {
    return { accepted: false, error: REPLAY_ERROR.NONE, rejectedForTaint: true, result };
  }
  return { accepted: result.reproduced, error: result.error, rejectedForTaint: false, result };
}

/**
 * Cross-platform determinism report: replay the same log twice against two sims and say where they part.
 *
 * This is measurement, not a gate (plan.md Phase 0). Perfect agreement across Hermes on iOS, Hermes on
 * Android and V8 in Node would be a bonus; what we actually need is the *number*, because it tells us
 * how much correction bandwidth co-op has to budget for. A divergence at tick 200,000 and a divergence
 * at tick 12 imply completely different netcode work.
 */
export interface DivergenceReport {
  ticksCompared: number;
  firstDivergentTick: number;
  hashA: number;
  hashB: number;
  agreed: boolean;
}

export function compareRuns(bytes: Uint8Array, simA: ReplaySim, simB: ReplaySim): DivergenceReport {
  const trailA = new HashTrail(4096);
  const a = replay(bytes, simA, { trail: trailA });
  const b = replay(bytes, simB, { reference: trailA });
  return {
    ticksCompared: Math.min(a.ticks, b.ticks),
    firstDivergentTick: b.firstDivergentTick,
    hashA: a.replayedHash,
    hashB: b.replayedHash,
    agreed: a.replayedHash === b.replayedHash && b.firstDivergentTick < 0,
  };
}
