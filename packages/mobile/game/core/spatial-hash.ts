/**
 * Uniform spatial hash for broad-phase collision.
 *
 * WHY
 * 800 enemies against 200 projectiles is 160,000 pair checks per tick if done naively — at 60Hz
 * that is 9.6M checks a second and the REVVL will not do it. Bucketing by cell drops it to the
 * handful of entities actually nearby.
 *
 * WHY A HASH AND NOT A FIXED GRID
 * The world scrolls without bound, so a fixed grid sized to the world is either enormous or
 * clamped. Hashing cell coordinates into a fixed bucket table keeps memory constant regardless of
 * how far the player wanders, and the whole structure is typed arrays allocated once.
 *
 * REBUILD, DON'T UPDATE
 * The table is rebuilt from scratch every tick with a counting sort. That sounds wasteful and is
 * in fact much faster than incrementally moving entities between buckets: two linear passes over
 * contiguous typed arrays, no branching on cell transitions, no per-cell arrays, zero allocation.
 *
 * COLLISIONS ARE FINE
 * Two distant cells can hash to the same bucket. Callers already do an exact distance check on
 * every candidate, so a collision costs a few wasted comparisons and never a wrong answer.
 */

export class SpatialHash {
  /** Power of two, so the modulo is a mask. */
  private readonly bucketCount: number;
  private readonly bucketMask: number;
  private readonly cellSize: number;
  private readonly capacity: number;

  /** Start offset of each bucket inside `entries`, plus a terminator. */
  private readonly bucketStart: Int32Array;
  /** Scratch used during the fill pass. */
  private readonly cursor: Int32Array;
  /** Entity slots, grouped by bucket. */
  private readonly entries: Int32Array;
  /** Bucket each inserted item landed in, kept so the second pass doesn't recompute the hash. */
  private readonly itemBucket: Int32Array;
  private readonly itemSlot: Int32Array;
  private itemCount = 0;
  /**
   * True once `build` has run this tick. Queries against an unbuilt table return nothing rather
   * than stale results, and callers check this before doing collision work at all.
   */
  built = false;

  constructor(cellSize: number, capacity: number, bucketCount = 4096) {
    this.cellSize = cellSize;
    this.capacity = capacity;
    this.bucketCount = nextPowerOfTwo(bucketCount);
    this.bucketMask = this.bucketCount - 1;
    this.bucketStart = new Int32Array(this.bucketCount + 1);
    this.cursor = new Int32Array(this.bucketCount);
    this.entries = new Int32Array(capacity);
    this.itemBucket = new Int32Array(capacity);
    this.itemSlot = new Int32Array(capacity);
  }

  /** Cell coordinate for a world coordinate. Floor division, correct for negatives. */
  cellOf(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  /**
   * Hash a cell coordinate pair to a bucket. Large odd primes so that neighbouring cells — which
   * are queried together — spread across the table instead of clumping.
   */
  private bucketOf(cx: number, cy: number): number {
    return (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca6b)) & this.bucketMask;
  }

  /** Start a rebuild. Call once per tick before inserting. */
  beginFrame(): void {
    this.itemCount = 0;
    this.built = false;
    this.bucketStart.fill(0);
  }

  /** Queue one entity. Cheap — the real work happens in `build`. */
  insert(slot: number, x: number, y: number): void {
    if (this.itemCount >= this.capacity) return; // silently ignore overflow; caps are enforced upstream
    const bucket = this.bucketOf(this.cellOf(x), this.cellOf(y));
    const i = this.itemCount++;
    this.itemSlot[i] = slot;
    this.itemBucket[i] = bucket;
    // bucketStart doubles as the per-bucket count until the prefix sum below turns it into offsets.
    this.bucketStart[bucket + 1]++;
  }

  /** Finish the rebuild: prefix sum, then place each item. Two linear passes, no allocation. */
  build(): void {
    const starts = this.bucketStart;
    for (let b = 0; b < this.bucketCount; b++) {
      starts[b + 1] += starts[b];
    }
    this.cursor.set(starts.subarray(0, this.bucketCount));
    for (let i = 0; i < this.itemCount; i++) {
      const bucket = this.itemBucket[i];
      this.entries[this.cursor[bucket]++] = this.itemSlot[i];
    }
    this.built = true;
  }

  /**
   * Collect slots in the 3×3 cell block around a point into `out`.
   *
   * Returns how many were written. The caller supplies the buffer and must still do an exact
   * distance test — this is broad phase only. `out` is expected to be a long-lived scratch array
   * owned by the calling system, never allocated per call.
   */
  queryInto(x: number, y: number, out: Int32Array): number {
    if (!this.built) return 0;
    const cx = this.cellOf(x);
    const cy = this.cellOf(y);
    const limit = out.length;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.bucketOf(cx + dx, cy + dy);
        const start = this.bucketStart[bucket];
        const end = this.bucketStart[bucket + 1];
        for (let i = start; i < end; i++) {
          if (n >= limit) return n; // truncation beats overrunning the caller's buffer
          out[n++] = this.entries[i];
        }
      }
    }
    return n;
  }

  /**
   * Query a radius larger than one cell. Falls back to sweeping every covered cell, so keep the
   * radius modest — area growth is quadratic. Big-radius effects (Garlic-likes, screen nukes)
   * should iterate the dense entity list instead; past a few cells that is genuinely cheaper.
   */
  queryRadiusInto(x: number, y: number, radius: number, out: Int32Array): number {
    if (!this.built) return 0;
    const minX = this.cellOf(x - radius);
    const maxX = this.cellOf(x + radius);
    const minY = this.cellOf(y - radius);
    const maxY = this.cellOf(y + radius);
    const limit = out.length;
    let n = 0;
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.bucketOf(cx, cy);
        const start = this.bucketStart[bucket];
        const end = this.bucketStart[bucket + 1];
        for (let i = start; i < end; i++) {
          if (n >= limit) return n;
          out[n++] = this.entries[i];
        }
      }
    }
    return n;
  }

  get size(): number {
    return this.itemCount;
  }

  /**
   * Longest bucket chain. Surfaced in the dev-menu perf panel: if this climbs, the cell size is
   * wrong for current enemy density and broad phase is quietly degrading toward brute force.
   */
  get maxBucketLoad(): number {
    if (!this.built) return 0;
    let max = 0;
    for (let b = 0; b < this.bucketCount; b++) {
      const load = this.bucketStart[b + 1] - this.bucketStart[b];
      if (load > max) max = load;
    }
    return max;
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
