/**
 * Entity pools — the thing the whole performance contract rests on.
 *
 * WHY THIS MATTERS MORE THAN THE RENDERER
 * The perf target is a 4GB REVVL at 720p. At that resolution fill rate is not the bottleneck;
 * CPU and allocation are. Allocating an object per enemy, per projectile, per damage number means
 * thousands of short-lived objects per second, which means the garbage collector runs during
 * gameplay, which means a 30-80ms pause, which means a visibly dropped frame in the exact moment
 * the screen is fullest. No amount of render optimisation recovers from that.
 *
 * So: every entity lives in a pre-allocated slot. Systems store their data in typed arrays indexed
 * by slot. Nothing is allocated after the run starts — no objects, no arrays, no closures in hot
 * paths, no string concatenation. `new` inside a tick is a bug.
 *
 * HANDLES vs SLOTS
 * A slot is reused the moment it's freed, so holding a raw slot index is unsafe: a projectile
 * chasing "enemy in slot 412" can end up chasing a completely different enemy that got spawned
 * into the same slot on a later tick. Handles pack a generation counter alongside the slot, and
 * `isAlive(handle)` catches that class of bug outright.
 */

/** Slot index packed with a generation counter. Never store a bare slot across ticks. */
export type Handle = number;

const SLOT_BITS = 20;
const SLOT_MASK = (1 << SLOT_BITS) - 1; // 1,048,575 slots max

/**
 * 11 bits — 2048 generations before wraparound.
 *
 * WHY NOT 12, WHICH WOULD FIT THE WORD
 * A handle is `slot | (generation << 20)`. Twelve generation bits reach bit 31, which is the sign
 * bit, so every handle issued once a slot had been recycled 2048 times came out NEGATIVE. `isAlive`
 * rejects anything negative on sight, so those handles were dead the moment they were created, and
 * `free(handle)` — which checks `isAlive` first — silently did nothing and leaked the slot forever.
 * Slots recycle constantly (a projectile lives about a second), so a long session would slowly
 * starve its own pool, and the only symptom would be enemies quietly failing to spawn hours in.
 * Caught by `core.test.ts` section 8, which churns one slot 20,000 times.
 *
 * Eleven bits keeps every handle a positive int32. 2048 generations is far more than enough: a
 * handle is only held for the lifetime of the thing holding it — a projectile tracking a target for
 * a second or two — and one specific slot cannot recycle 2048 times inside that window.
 */
const GEN_BITS = 11;
const GEN_MASK = (1 << GEN_BITS) - 1;

export function handleSlot(h: Handle): number {
  return h & SLOT_MASK;
}

export function handleGen(h: Handle): number {
  return (h >>> SLOT_BITS) & GEN_MASK;
}

export const NULL_HANDLE: Handle = -1;

export class EntityPool {
  readonly capacity: number;

  /** Generation per slot, bumped on free so stale handles stop validating. */
  private readonly generations: Uint16Array;
  /** Free slots, used as a stack. LIFO keeps recently-touched memory hot in cache. */
  private readonly freeStack: Int32Array;
  private freeCount: number;

  /**
   * Dense list of live slots. Systems iterate this instead of scanning all `capacity` slots —
   * with 800 alive out of a 4000-slot pool that is a 5× difference in a loop that runs every tick.
   */
  private readonly dense: Int32Array;
  /** slot → its index inside `dense`, so removal is O(1) swap-remove. */
  private readonly denseIndex: Int32Array;
  private aliveCount = 0;

  /** Peak simultaneous alive count. Feeds the dev-menu perf panel and pool-sizing decisions. */
  peakAlive = 0;
  /** Times `alloc` was refused because the pool was full. Non-zero = the pool is undersized. */
  exhaustedCount = 0;

  constructor(capacity: number) {
    if (capacity > SLOT_MASK) {
      throw new Error(`EntityPool capacity ${capacity} exceeds slot limit ${SLOT_MASK}`);
    }
    this.capacity = capacity;
    this.generations = new Uint16Array(capacity);
    this.freeStack = new Int32Array(capacity);
    this.dense = new Int32Array(capacity);
    this.denseIndex = new Int32Array(capacity).fill(-1);
    for (let i = 0; i < capacity; i++) {
      // Reversed so the first allocations come out as slot 0, 1, 2… which makes debugging and
      // replay diffing far easier to read.
      this.freeStack[i] = capacity - 1 - i;
    }
    this.freeCount = capacity;
  }

  /**
   * Take a slot. Returns `NULL_HANDLE` when full.
   *
   * Full is a normal condition, not an error: hitting the projectile cap during a Limit Break
   * storm is exactly when we want to refuse gracefully rather than allocate. Callers must handle
   * `NULL_HANDLE` — dropping a spawn is always better than dropping a frame.
   */
  alloc(): Handle {
    if (this.freeCount === 0) {
      this.exhaustedCount++;
      return NULL_HANDLE;
    }
    const slot = this.freeStack[--this.freeCount];
    this.denseIndex[slot] = this.aliveCount;
    this.dense[this.aliveCount++] = slot;
    if (this.aliveCount > this.peakAlive) this.peakAlive = this.aliveCount;
    return slot | (this.generations[slot] << SLOT_BITS);
  }

  /** Release a slot by index. Safe to call on an already-free slot (no-op). */
  freeSlot(slot: number): void {
    const di = this.denseIndex[slot];
    if (di < 0) return;

    // Swap-remove from the dense list. Order is not meaningful, so this is free.
    const last = this.dense[--this.aliveCount];
    this.dense[di] = last;
    this.denseIndex[last] = di;
    this.denseIndex[slot] = -1;

    this.generations[slot] = (this.generations[slot] + 1) & GEN_MASK;
    this.freeStack[this.freeCount++] = slot;
  }

  free(handle: Handle): void {
    if (this.isAlive(handle)) this.freeSlot(handleSlot(handle));
  }

  isAlive(handle: Handle): boolean {
    if (handle < 0) return false;
    const slot = handle & SLOT_MASK;
    if (slot >= this.capacity) return false;
    return this.denseIndex[slot] >= 0 && this.generations[slot] === ((handle >>> SLOT_BITS) & GEN_MASK);
  }

  isSlotAlive(slot: number): boolean {
    return this.denseIndex[slot] >= 0;
  }

  handleFor(slot: number): Handle {
    return slot | (this.generations[slot] << SLOT_BITS);
  }

  /**
   * Live slots. Read `count` first; the array is the full-capacity backing store and everything
   * past `count` is stale. Returned by reference on purpose — copying it every tick would defeat
   * the point of the whole file.
   */
  get slots(): Int32Array {
    return this.dense;
  }

  get count(): number {
    return this.aliveCount;
  }

  get available(): number {
    return this.freeCount;
  }

  /** Wipe without reallocating. Used between runs and by "restart same seed". */
  clear(): void {
    for (let i = 0; i < this.aliveCount; i++) {
      const slot = this.dense[i];
      this.denseIndex[slot] = -1;
      this.generations[slot] = (this.generations[slot] + 1) & GEN_MASK;
    }
    this.aliveCount = 0;
    this.freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i++) {
      this.freeStack[i] = this.capacity - 1 - i;
    }
  }
}

/**
 * Pool budgets.
 *
 * These are hard ceilings, deliberately chosen so that a maxed-out screen still fits the frame
 * budget on the REVVL. When a cap is reached the game degrades cosmetically (fewer damage numbers,
 * fewer particles) rather than dropping frames. Enemies and projectiles are gated by the spawn
 * logic long before they reach these numbers; the pool is the backstop.
 *
 * Tuned against the perf contract: 500 enemies is the floor, 800 is the gate.
 */
export const POOL_BUDGETS = {
  enemies: 2048,
  projectiles: 1536,
  pickups: 1024,
  damageNumbers: 256,
  particles: 1024,
  props: 512,
} as const;
