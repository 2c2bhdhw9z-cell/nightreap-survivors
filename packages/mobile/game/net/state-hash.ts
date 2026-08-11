/**
 * State hashing — one 32-bit number that answers "are we still simulating the same game?"
 *
 * THREE JOBS, ONE FUNCTION
 *   1. Co-op:        host broadcasts its hash every ~2s; a guest that disagrees asks for a resync
 *                    instead of trying to work out what drifted.
 *   2. Anti-cheat:   ladder submissions are re-simulated server-side from the tick log and the final
 *                    hash must match. This is the ONLY real integrity boundary — the client-side
 *                    `tainted` flag is a courtesy signal and a patched binary can forge it.
 *   3. Determinism:  the replay harness hashes every N ticks across iOS, Android and Node and reports
 *                    the first tick where they part company.
 *
 * WHY FNV-1a
 * We need cheap, incremental, and byte-identical on every engine — not cryptographic. FNV-1a is a
 * handful of int32 ops per word with no tables and no allocation. Collisions do not matter here: a
 * collision means one missed resync opportunity two seconds before the next hash catches it.
 *
 * WHAT MUST NOT GO IN
 * Only simulation state. Never frame timing, never render state, never anything read from
 * `Date.now()` or device metrics — those legitimately differ per device and would make every session
 * look desynced. Floats must be hashed via their bit pattern, and NaN must be normalised, or a
 * harmless `-0` vs `0` will read as divergence.
 */

/** FNV-1a 32-bit offset basis. */
export const HASH_SEED = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

/** Scratch used to read a float's bit pattern without allocating. */
const floatBits = new Float64Array(1);
const floatWords = new Int32Array(floatBits.buffer);

/** Mix one 32-bit word. `Math.imul` keeps the multiply exact in int32 on every engine. */
export function hashWord(hash: number, word: number): number {
  let h = hash;
  h = Math.imul(h ^ (word & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((word >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((word >>> 16) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((word >>> 24) & 0xff), FNV_PRIME);
  return h;
}

export function hashByte(hash: number, byte: number): number {
  return Math.imul(hash ^ (byte & 0xff), FNV_PRIME);
}

/**
 * Mix a double by its bit pattern.
 *
 * NaN is normalised to a single canonical word pair because IEEE-754 permits many NaN payloads and
 * engines do not agree on which one they produce. `-0` is normalised to `+0` for the same reason it
 * matters in the sim: the two are `===` equal and no gameplay logic distinguishes them, so they must
 * not hash differently.
 */
export function hashFloat(hash: number, value: number): number {
  let v = value;
  if (Number.isNaN(v)) return hashWord(hashWord(hash, 0x7ff80000), 0);
  if (v === 0) v = 0;
  floatBits[0] = v;
  return hashWord(hashWord(hash, floatWords[0] as number), floatWords[1] as number);
}

/** Mix a typed-array range. Handles the common case — a pool's backing store — with no per-element cost beyond the mix. */
export function hashInt32Range(hash: number, src: Int32Array, from: number, to: number): number {
  let h = hash;
  for (let i = from; i < to; i++) h = hashWord(h, src[i] as number);
  return h;
}

export function hashFloat32Range(hash: number, src: Float32Array, from: number, to: number): number {
  let h = hash;
  for (let i = from; i < to; i++) h = hashFloat(h, src[i] as number);
  return h;
}

export function hashUint8Range(hash: number, src: Uint8Array, from: number, to: number): number {
  let h = hash;
  for (let i = from; i < to; i++) h = hashByte(h, src[i] as number);
  return h;
}

/**
 * Contributes its simulation state to a running hash.
 *
 * Every sim system implements this. The contract is deliberately narrow — a system may only mix
 * values, never read the clock and never allocate — so that adding a new system cannot accidentally
 * make sessions look desynced.
 */
export interface Hashable {
  hashState(hash: number): number;
}

/**
 * Hash a set of systems in a fixed order.
 *
 * Order is part of the hash: the same systems mixed in a different order produce a different number.
 * The caller therefore owns a stable array, never an object's key iteration order.
 */
export function hashSystems(systems: readonly Hashable[]): number {
  let h = HASH_SEED;
  for (let i = 0; i < systems.length; i++) h = (systems[i] as Hashable).hashState(h);
  return h;
}

/** Format for logs and the dev menu. Unsigned, zero-padded, always 8 hex digits. */
export function formatHash(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A short window of recent hashes, so a divergence report can say *when* rather than just *that*.
 *
 * The replay harness and the co-op guest both need this: knowing the hash disagreed at tick 4,320
 * is nearly useless, knowing it first disagreed at 4,201 and the log holds the inputs from 4,150
 * onward is a reproducible bug.
 */
export class HashTrail {
  private readonly ticks: Int32Array;
  private readonly hashes: Int32Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity: number = 64) {
    this.ticks = new Int32Array(capacity).fill(-1);
    this.hashes = new Int32Array(capacity);
  }

  record(tick: number, hash: number): void {
    this.ticks[this.writeIndex] = tick;
    this.hashes[this.writeIndex] = hash | 0;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Hash recorded at `tick`, or 0 if it has aged out of the trail. */
  at(tick: number): number {
    for (let i = 0; i < this.filled; i++) {
      if (this.ticks[i] === tick) return this.hashes[i] as number;
    }
    return 0;
  }

  has(tick: number): boolean {
    for (let i = 0; i < this.filled; i++) {
      if (this.ticks[i] === tick) return true;
    }
    return false;
  }

  /** Oldest tick still in the trail, or -1 when empty. Bounds how far back a resim can start. */
  oldestTick(): number {
    let oldest = -1;
    for (let i = 0; i < this.filled; i++) {
      const t = this.ticks[i] as number;
      if (t >= 0 && (oldest === -1 || t < oldest)) oldest = t;
    }
    return oldest;
  }

  clear(): void {
    this.ticks.fill(-1);
    this.writeIndex = 0;
    this.filled = 0;
  }
}
