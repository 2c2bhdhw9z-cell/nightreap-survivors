/**
 * The save store: double-buffered slots, verified writes, and a load path that cannot lose a profile to
 * a single bad byte.
 *
 * THE WRITE
 *   1. Encode into the *other* slot than the one we last loaded or wrote — never overwrite the good copy.
 *   2. Write it.
 *   3. Read it straight back and decode it. If the readback does not validate, the write is treated as
 *      failed and the slot is abandoned; the previous slot is still intact and still wins on generation.
 *
 * Step 3 is the whole point. Backends lie: AsyncStorage can resolve a write that never hit disk, and the
 * OS can kill us between the two. Verifying by reading is the only way to know, and at ~1KB it costs
 * nothing worth measuring.
 *
 * THE LOAD
 * Decode both slots, discard the invalid ones, take the highest generation of what remains. So the
 * recovery ladder is: current save → previous save → fresh profile, and the middle rung is the one that
 * turns "I lost everything" into "I lost my last run".
 *
 * GENERATION AND WRAPAROUND
 * `generation` is u32 and increments once per save. At one save per run that is out of reach, and the
 * comparison is a plain `>` rather than modular, so even a hand-edited generation cannot make a stale
 * slot win — it can only make a stale slot the newest, which is indistinguishable from the player having
 * edited their own save, which is allowed.
 *
 * BLOCKING RULE
 * Nothing here runs during a run. Writes happen at run end, on settings change, and on app background.
 * The store never allocates on a tick.
 */

import { SAVE_ERROR, decodeSave, describeSaveError, encodeSave, saveBytes } from "./codec";
import { SAVE_SLOTS, createSaveData, type SaveData } from "./schema";

/**
 * Storage the store needs. Deliberately tiny and synchronous-agnostic so the RN implementation
 * (`expo-file-system`) and the web one (`localStorage`) and the test double all satisfy it, and so no
 * React Native import ever reaches `game/`.
 */
export interface SaveBackend {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}

export const SLOT_KEYS = ["nightreap.save.0", "nightreap.save.1"] as const;

export const LOAD_SOURCE = {
  /** Highest-generation slot validated. Normal path. */
  PRIMARY: 0,
  /** Primary was unreadable, the other slot was good. One run of progress may be missing. */
  BACKUP: 1,
  /** Both slots unreadable or absent. Fresh profile. */
  FRESH: 2,
} as const;

export type LoadSource = (typeof LOAD_SOURCE)[keyof typeof LOAD_SOURCE];

export interface LoadResult {
  readonly save: SaveData;
  readonly source: LoadSource;
  /** Which slot won, or -1 for a fresh profile. */
  readonly slot: number;
  /** Per-slot decode outcome, for the dev menu's save inspector and for bug reports. */
  readonly slotErrors: readonly number[];
  /** True when a slot existed but could not be used. Worth surfacing to the player once. */
  readonly recovered: boolean;
}

export interface SaveResult {
  readonly ok: boolean;
  readonly slot: number;
  readonly generation: number;
  /** Set when the readback failed, so the caller can log why rather than just "save failed". */
  readonly detail: string;
}

export class SaveStore {
  /** Slot last known good. -1 until a load or a successful write. */
  private currentSlot = -1;
  private scratch = new Uint8Array(saveBytes());
  private writes = 0;
  private failedWrites = 0;

  constructor(private readonly backend: SaveBackend) {}

  get stats(): { writes: number; failedWrites: number; slot: number } {
    return { writes: this.writes, failedWrites: this.failedWrites, slot: this.currentSlot };
  }

  /** Read both slots and pick a winner. Never throws; a backend that rejects counts as an empty slot. */
  async load(): Promise<LoadResult> {
    const errors: number[] = [];
    const decoded: { slot: number; save: SaveData; generation: number }[] = [];

    for (let slot = 0; slot < SAVE_SLOTS; slot++) {
      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.backend.read(SLOT_KEYS[slot] as string);
      } catch {
        bytes = undefined;
      }
      const result = decodeSave(bytes);
      errors.push(result.error);
      if (result.error === SAVE_ERROR.NONE) {
        decoded.push({ slot, save: result.save, generation: result.generation });
      }
    }

    if (decoded.length === 0) {
      this.currentSlot = -1;
      const anySlotExisted = errors.some((e) => e !== SAVE_ERROR.EMPTY);
      return {
        save: createSaveData(),
        source: LOAD_SOURCE.FRESH,
        slot: -1,
        slotErrors: errors,
        recovered: anySlotExisted,
      };
    }

    let best = decoded[0] as { slot: number; save: SaveData; generation: number };
    for (const candidate of decoded) if (candidate.generation > best.generation) best = candidate;

    this.currentSlot = best.slot;
    // "Recovered" means a slot we would have preferred was unusable: either the other slot failed to
    // decode, or it decoded with a higher generation but was rejected. Only the first is observable here.
    const otherSlot = 1 - best.slot;
    const otherError = errors[otherSlot] as number;
    const recovered = otherError !== SAVE_ERROR.NONE && otherError !== SAVE_ERROR.EMPTY;

    return {
      save: best.save,
      source: recovered ? LOAD_SOURCE.BACKUP : LOAD_SOURCE.PRIMARY,
      slot: best.slot,
      slotErrors: errors,
      recovered,
    };
  }

  /**
   * Write into the slot we are not currently relying on, then verify by reading it back.
   *
   * `nowUnixSec` is passed in rather than read from a clock, for the same reason as everywhere else in
   * the engine: no ambient dependencies, and deterministic tests.
   */
  async save(save: SaveData, nowUnixSec = 0): Promise<SaveResult> {
    const target = this.currentSlot === 0 ? 1 : 0;
    const key = SLOT_KEYS[target] as string;

    save.generation = (save.generation + 1) >>> 0;
    save.savedAtUnixSec = nowUnixSec;
    const bytes = encodeSave(save, this.scratch);

    this.writes++;
    try {
      await this.backend.write(key, bytes);
    } catch (err) {
      this.failedWrites++;
      save.generation = (save.generation - 1) >>> 0;
      return { ok: false, slot: target, generation: save.generation, detail: `write threw: ${String(err)}` };
    }

    let readback: Uint8Array | undefined;
    try {
      readback = await this.backend.read(key);
    } catch {
      readback = undefined;
    }
    const verified = decodeSave(readback);
    if (verified.error !== SAVE_ERROR.NONE || verified.generation !== save.generation) {
      this.failedWrites++;
      // Abandon the slot. The other one is untouched and still wins on generation, so the profile is
      // exactly as safe as it was a moment ago. Do not roll `generation` back on the in-memory copy: the
      // next attempt must not reuse a number this slot may already hold.
      return {
        ok: false,
        slot: target,
        generation: save.generation,
        detail:
          verified.error !== SAVE_ERROR.NONE
            ? `readback ${describeSaveError(verified.error)}`
            : `readback generation ${verified.generation} != ${save.generation}`,
      };
    }

    this.currentSlot = target;
    return { ok: true, slot: target, generation: save.generation, detail: "verified" };
  }

  /**
   * Wipe both slots. Only reachable from a confirmed "delete my data" flow — which also has to exist for
   * the store listings' data-deletion requirement, so it is a compliance feature, not a dev toy.
   */
  async eraseEverything(): Promise<void> {
    for (const key of SLOT_KEYS) {
      try {
        await this.backend.remove(key);
      } catch {
        // A slot that refuses to be removed is still overwritten by the next save.
      }
    }
    this.currentSlot = -1;
  }
}

/** In-memory backend. Used by tests and by the dev menu's "sandbox profile" mode. */
export class MemoryBackend implements SaveBackend {
  private readonly map = new Map<string, Uint8Array>();

  /** Set to a positive count to make the next N writes fail, simulating a full or dying device. */
  failNextWrites = 0;
  /** Set to a byte count to truncate the next write, simulating a torn write or an OS kill mid-flush. */
  truncateNextWriteTo = -1;

  async read(key: string): Promise<Uint8Array | undefined> {
    const found = this.map.get(key);
    return found ? found.slice() : undefined;
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new Error("backend full");
    }
    if (this.truncateNextWriteTo >= 0) {
      const cut = this.truncateNextWriteTo;
      this.truncateNextWriteTo = -1;
      this.map.set(key, bytes.slice(0, cut));
      return;
    }
    this.map.set(key, bytes.slice());
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Test-only: corrupt a stored slot in place, the way a filesystem does. */
  corrupt(key: string, at: number, value: number): boolean {
    const found = this.map.get(key);
    if (!found || at >= found.length) return false;
    found[at] = value & 0xff;
    return true;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  sizeOf(key: string): number {
    return this.map.get(key)?.length ?? 0;
  }
}
