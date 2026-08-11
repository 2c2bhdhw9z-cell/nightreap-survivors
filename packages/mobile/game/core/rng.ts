/**
 * Seeded random, split into named streams.
 *
 * WHY NAMED STREAMS
 * A single shared RNG makes replays brittle in a way that bites late and hurts: add one
 * `random()` call for a spark particle and every subsequent enemy spawn, chest roll, and card draw
 * shifts. Replay validation then rejects honest runs, and the anti-cheat becomes untrustworthy.
 *
 * So each concern draws from its own independent stream, derived from the run seed. Adding a VFX
 * roll cannot perturb the spawn table. Streams are addressed by name, and the name is hashed into
 * the stream's seed, so a new stream can be introduced in a later version without disturbing the
 * existing ones.
 *
 * `Math.random` is never used anywhere in `game/` — CI greps for it.
 */

/** Every stream the simulation is allowed to draw from. Add here, never inline. */
export const RNG_STREAMS = [
  "spawn", // enemy wave composition and positions
  "drop", // pickups, gold, chicken
  "chest", // chest tier and contents
  "cardDraw", // level-up card offers, rerolls, banishes
  "crit", // critical hits
  "damageVariance", // per-hit damage spread
  "ai", // enemy steering jitter, elite behaviour choices
  "arcana", // arcana offers
  "vfx", // cosmetic only — never affects sim state
  "audio", // cosmetic only — variant selection
] as const;

export type RngStreamName = (typeof RNG_STREAMS)[number];

/**
 * xoshiro128** — small state, passes the usual statistical batteries, and uses only uint32 ops so
 * it is bit-identical on every JS engine. (A Mersenne Twister would be overkill and a plain LCG
 * shows visible patterns in spawn positions.)
 */
export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    // SplitMix32 to spread a single 32-bit seed across the 128-bit state. Seeding all four words
    // from the raw seed would correlate the first few outputs.
    let z = seed >>> 0;
    const next = () => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1; // all-zero state is a fixed point
  }

  /** Raw uint32. */
  nextU32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11) >>> 0;
    return result;
  }

  /** Uniform integer in [0, bound). Rejection-sampled, so no modulo bias. */
  nextInt(bound: number): number {
    if (bound <= 1) return 0;
    const limit = (0x100000000 - (0x100000000 % bound)) >>> 0;
    let r = this.nextU32();
    while (r >= limit) r = this.nextU32();
    return r % bound;
  }

  /** Uniform integer in [lo, hi], inclusive both ends. */
  nextRange(lo: number, hi: number): number {
    return lo + this.nextInt(hi - lo + 1);
  }

  /** Q16.16 fixed-point value in [0, 1). */
  nextFx(): number {
    return this.nextU32() >>> 16;
  }

  /** True with probability `pctQ16` expressed as Q16.16 (FX_ONE === always). */
  chanceFx(pctQ16: number): boolean {
    return this.nextFx() < pctQ16;
  }

  /** Angle in brads. */
  nextBrad(): number {
    return this.nextU32() & 4095;
  }

  /** Uniform pick. Does not allocate. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }

  /**
   * Fisher-Yates, in place. Used for card offers, so it must be the same shuffle on host and
   * guest given the same stream position.
   */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
  }

  /** Snapshot for state hashing and mid-run save. */
  saveState(out: Int32Array, offset: number): void {
    out[offset] = this.s0 | 0;
    out[offset + 1] = this.s1 | 0;
    out[offset + 2] = this.s2 | 0;
    out[offset + 3] = this.s3 | 0;
  }

  loadState(src: Int32Array, offset: number): void {
    this.s0 = src[offset] >>> 0;
    this.s1 = src[offset + 1] >>> 0;
    this.s2 = src[offset + 2] >>> 0;
    this.s3 = src[offset + 3] >>> 0;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** FNV-1a. Turns a stream name into a stable 32-bit salt — same value on every platform, forever. */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * All streams for one run, keyed by name.
 *
 * Built once at run start and never reallocated. `get()` is a plain property read so systems can
 * call it in hot loops without a Map lookup.
 */
export class RngSet {
  readonly seed: number;
  private streams: Record<string, Rng> = Object.create(null);

  constructor(seed: number) {
    this.seed = seed >>> 0;
    for (const name of RNG_STREAMS) {
      this.streams[name] = new Rng((this.seed ^ hashName(name)) >>> 0);
    }
  }

  get(name: RngStreamName): Rng {
    return this.streams[name];
  }

  /** Reset every stream to its run-start position. Used by "restart same seed" in the dev menu. */
  resetAll(): void {
    for (const name of RNG_STREAMS) {
      this.streams[name].reseed((this.seed ^ hashName(name)) >>> 0);
    }
  }

  /** 4 int32 words per stream, in declaration order. */
  saveState(out: Int32Array, offset: number): void {
    let o = offset;
    for (const name of RNG_STREAMS) {
      this.streams[name].saveState(out, o);
      o += 4;
    }
  }

  loadState(src: Int32Array, offset: number): void {
    let o = offset;
    for (const name of RNG_STREAMS) {
      this.streams[name].loadState(src, o);
      o += 4;
    }
  }

  static get stateWords(): number {
    return RNG_STREAMS.length * 4;
  }
}
