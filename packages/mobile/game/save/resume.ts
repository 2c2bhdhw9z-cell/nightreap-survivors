/**
 * Autosave for the run in progress: when to capture, where it goes, and how it comes back.
 *
 * `snapshot.ts` answers "how do I turn a living run into bytes". This file answers the three questions
 * that decide whether the player ever benefits from that:
 *
 *   WHEN — every thirty seconds of play, whenever a card screen opens, and the moment the app goes to
 *   the background. The background capture is the one that matters most, because that is the last
 *   moment we are guaranteed to get before the OS reclaims us, and it is also the only one that is
 *   worth waiting for.
 *
 *   WHERE — two alternating slots with a generation counter, written and then read straight back to
 *   confirm they landed, exactly like the profile save. A resume file is worthless if it is only
 *   probably there, and backends lie: a write can resolve without reaching storage.
 *
 *   WHETHER — a resume is offered only if its bytes still describe a run this build can simulate. The
 *   snapshot's own fingerprint decides that, and anything doubtful is discarded rather than repaired.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *   - It never runs inside a tick. `shouldCapture` is a comparison; everything that touches storage is
 *     async and is called between frames.
 *   - It never queues writes. If a write is still in flight when the next rolling autosave comes due,
 *     that autosave is skipped and counted. An unbounded queue of half-megabyte buffers on a 4GB phone
 *     is a worse failure than a missed autosave, and thirty seconds later there will be another one.
 *   - It never deletes the run's proof-of-play. Clearing a resume happens when a run *ends*, not when
 *     it is loaded, so a crash during the resume itself leaves the resume still there.
 */

import {
  SNAPSHOT_ERROR,
  inspectSnapshot,
  restoreRun,
  snapshotRun,
  verifySnapshot,
  type SnapshotError,
} from "./snapshot";
import type { SaveBackend } from "./store";
import type { Run } from "../run/run";

/** Two slots, alternating, so a failed write can never take the good copy with it. */
export const RESUME_SLOT_KEYS = ["nightreap.resume.0", "nightreap.resume.1"] as const;

/** Thirty seconds at 60Hz. Long enough to be cheap, short enough that losing it barely stings. */
export const AUTOSAVE_INTERVAL_TICKS = 1800;

/** "NRRC" — Nightreap resume container. */
const CONTAINER_MAGIC = 0x4e525243;
const CONTAINER_VERSION = 1;
const CONTAINER_BYTES = 16;
const CON = { magic: 0, version: 4, reserved: 6, generation: 8, payloadBytes: 12 } as const;

/** Why a capture happened. Kept for the dev menu and for telemetry about what actually saves runs. */
export const RESUME_REASON = {
  rolling: 0,
  cardScreen: 1,
  background: 2,
  manual: 3,
} as const;

export type ResumeReason = (typeof RESUME_REASON)[keyof typeof RESUME_REASON];

export const RESUME_REASON_LABELS: readonly string[] = [
  "rolling autosave",
  "level-up screen",
  "app backgrounded",
  "manual",
];

export interface ResumeCandidate {
  /** The snapshot itself, ready for `restore`. */
  readonly bytes: Uint8Array;
  readonly tick: number;
  readonly seed: number;
  readonly generation: number;
  readonly storedBytes: number;
  readonly rawBytes: number;
  readonly compressed: boolean;
}

export interface ResumeLookup {
  readonly candidate?: ResumeCandidate;
  /** Why there is nothing to offer. `NONE` with no candidate simply means no resume was stored. */
  readonly error: SnapshotError;
}

export interface ResumeStats {
  captures: number;
  writes: number;
  failures: number;
  /** Rolling autosaves dropped because a write was still in flight. Not an error; watch the ratio. */
  skipped: number;
  bytesWritten: number;
  lastCaptureTick: number;
  lastReason: ResumeReason;
}

export class ResumeStore {
  readonly stats: ResumeStats = {
    captures: 0,
    writes: 0,
    failures: 0,
    skipped: 0,
    bytesWritten: 0,
    lastCaptureTick: -1,
    lastReason: RESUME_REASON.manual,
  };

  private generation = 0;
  private slot = 0;
  private writing = false;
  private inFlight: Promise<boolean> = Promise.resolve(true);
  private nextDueTick = 0;

  constructor(
    private readonly backend: SaveBackend,
    private readonly intervalTicks: number = AUTOSAVE_INTERVAL_TICKS,
  ) {}

  /** Call when a run begins, so the first autosave is a full interval away rather than immediate. */
  armForNewRun(run: Run): void {
    this.nextDueTick = run.ticks + this.intervalTicks;
  }

  /**
   * Is a rolling autosave due? A comparison and nothing else, so it is safe to ask every frame.
   *
   * A run that is over is never due: the results screen owns what happens next, and capturing a
   * finished run would mean offering to resume a run that has already been scored.
   */
  shouldCapture(run: Run): boolean {
    if (run.over) return false;
    return run.ticks >= this.nextDueTick;
  }

  /** Capture if due. Returns whether anything was written. */
  async maybeCapture(run: Run): Promise<boolean> {
    if (!this.shouldCapture(run)) return false;
    return this.capture(run, RESUME_REASON.rolling);
  }

  /**
   * Capture now.
   *
   * A rolling autosave that arrives while the previous write is still going is dropped rather than
   * queued. A background capture is not: it waits its turn, because it is the last chance we get.
   */
  async capture(run: Run, reason: ResumeReason): Promise<boolean> {
    if (run.over) return false;

    if (this.writing) {
      if (reason === RESUME_REASON.rolling || reason === RESUME_REASON.cardScreen) {
        this.stats.skipped++;
        this.nextDueTick = run.ticks + this.intervalTicks;
        return false;
      }
      await this.inFlight;
    }

    const bytes = snapshotRun(run);
    this.stats.captures++;
    this.stats.lastCaptureTick = run.ticks;
    this.stats.lastReason = reason;
    this.nextDueTick = run.ticks + this.intervalTicks;

    this.writing = true;
    this.inFlight = this.write(bytes);
    const ok = await this.inFlight;
    this.writing = false;
    return ok;
  }

  /** True while a write is still in the air. The pause screen can use it to hold a "saving" line. */
  get busy(): boolean {
    return this.writing;
  }

  /** Wait for any in-flight write. For app shutdown, where finishing matters more than latency. */
  async settle(): Promise<void> {
    await this.inFlight;
  }

  /**
   * Find a run worth offering to resume.
   *
   * Both slots are read, anything that does not inspect cleanly is discarded, and the highest
   * generation of what is left wins — the same recovery ladder the profile save uses, so a torn write
   * costs one autosave rather than the run.
   */
  async loadCandidate(): Promise<ResumeLookup> {
    let best: ResumeCandidate | undefined;
    let lastError: SnapshotError = SNAPSHOT_ERROR.NONE;

    for (let i = 0; i < RESUME_SLOT_KEYS.length; i++) {
      const stored = await this.backend.read(RESUME_SLOT_KEYS[i]);
      if (stored === undefined) continue;
      const opened = openContainer(stored);
      if (opened === undefined) {
        lastError = SNAPSHOT_ERROR.TOO_SHORT;
        continue;
      }
      // Verified, not just inspected: a resume whose bytes do not add up is not offered at all,
      // because the alternative is telling the player their run is there and failing when they tap it.
      const verdict = verifySnapshot(opened.payload);
      if (verdict !== SNAPSHOT_ERROR.NONE) {
        lastError = verdict;
        continue;
      }
      const info = inspectSnapshot(opened.payload);
      if (best !== undefined && opened.generation <= best.generation) continue;
      best = {
        bytes: opened.payload,
        tick: info.tick,
        seed: info.seed,
        generation: opened.generation,
        storedBytes: info.storedBytes,
        rawBytes: info.rawBytes,
        compressed: info.compressed,
      };
    }

    if (best !== undefined) {
      // Keep writing forward of whatever we found, so a resumed session cannot overwrite the copy it
      // was restored from until it has written a newer one.
      this.generation = best.generation;
      return { candidate: best, error: SNAPSHOT_ERROR.NONE };
    }
    return { error: lastError };
  }

  /**
   * Put a candidate back into a run.
   *
   * The run must already have been begun with the same configuration the snapshot was taken under —
   * seed, player count, modifiers — because a snapshot restores state, not identity. Mismatched
   * identity shows up as a schema mismatch or a refused restore rather than a wrong world.
   */
  restore(run: Run, candidate: ResumeCandidate): SnapshotError {
    const code = restoreRun(run, candidate.bytes);
    if (code === SNAPSHOT_ERROR.NONE) this.nextDueTick = run.ticks + this.intervalTicks;
    return code;
  }

  /** Forget the stored run. Called when a run *ends*, never when one is loaded. */
  async clear(): Promise<void> {
    for (let i = 0; i < RESUME_SLOT_KEYS.length; i++) {
      await this.backend.remove(RESUME_SLOT_KEYS[i]);
    }
    this.generation = 0;
    this.slot = 0;
  }

  /** Remove a slot whose write we could not trust. Failing to remove it is not itself a failure. */
  private async discard(key: string): Promise<void> {
    try {
      await this.backend.remove(key);
    } catch (error) {
      // Storage that cannot even delete is storage we have already stopped trusting; the slot stays
      // unreadable either way, and the other slot is what a resume will be offered from.
      void error;
    }
  }

  /**
   * Write to the slot we did not last write, then read it back and confirm it is really there.
   *
   * The readback is the whole reason this is not a one-liner. A backend that resolves a write it never
   * performed leaves us believing we have a resume and discovering otherwise at the worst moment. The
   * comparison is byte for byte rather than a header check, because storage that mangles one byte in
   * the middle of the payload is a real failure mode and a header check sails straight past it.
   */
  private async write(payload: Uint8Array): Promise<boolean> {
    const target = this.slot;
    const generation = this.generation + 1;
    const framed = new Uint8Array(CONTAINER_BYTES + payload.byteLength);
    const view = new DataView(framed.buffer);
    view.setUint32(CON.magic, CONTAINER_MAGIC, true);
    view.setUint16(CON.version, CONTAINER_VERSION, true);
    view.setUint16(CON.reserved, 0, true);
    view.setUint32(CON.generation, generation, true);
    view.setUint32(CON.payloadBytes, payload.byteLength, true);
    framed.set(payload, CONTAINER_BYTES);

    try {
      await this.backend.write(RESUME_SLOT_KEYS[target], framed);
      const back = await this.backend.read(RESUME_SLOT_KEYS[target]);
      if (back === undefined || !sameBytes(back, framed)) {
        await this.discard(RESUME_SLOT_KEYS[target]);
        this.stats.failures++;
        return false;
      }
      const opened = openContainer(back);
      if (
        opened === undefined ||
        opened.generation !== generation ||
        verifySnapshot(opened.payload) !== SNAPSHOT_ERROR.NONE
      ) {
        await this.discard(RESUME_SLOT_KEYS[target]);
        this.stats.failures++;
        return false;
      }
    } catch {
      // A backend that throws is a full disk or a revoked permission. Either way the other slot still
      // holds the previous autosave, so the run is not lost — this one attempt is.
      await this.discard(RESUME_SLOT_KEYS[target]);
      this.stats.failures++;
      return false;
    }

    this.generation = generation;
    this.slot = target === 0 ? 1 : 0;
    this.stats.writes++;
    this.stats.bytesWritten += framed.byteLength;
    return true;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function openContainer(
  bytes: Uint8Array,
): { generation: number; payload: Uint8Array } | undefined {
  if (bytes.byteLength < CONTAINER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(CON.magic, true) !== CONTAINER_MAGIC) return undefined;
  if (view.getUint16(CON.version, true) !== CONTAINER_VERSION) return undefined;
  const payloadBytes = view.getUint32(CON.payloadBytes, true);
  if (CONTAINER_BYTES + payloadBytes > bytes.byteLength) return undefined;
  return {
    generation: view.getUint32(CON.generation, true),
    payload: bytes.subarray(CONTAINER_BYTES, CONTAINER_BYTES + payloadBytes),
  };
}
