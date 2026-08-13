/**
 * Run modifiers — the only mechanism by which a "game mode" exists.
 *
 * WHY THE SIM HAS NO MODE ENUM
 * Every mode in the catalog (Hurry, Hyper, Endless, Inverse, Limit Break, Ascension tiers, the
 * Chaos Sandbox event, daily mutators shipped from remote config) is expressible as "these stats
 * are different for this run". The moment the sim asks `if (mode === HYPER)`, every future mode
 * costs another branch in the hottest loops and every combination of modes becomes a new bug
 * surface. So modes are *data*: a list of `RunModifier` records that resolve into the flat `Stats`
 * table once, at run start and at each level-up, and the sim only ever reads `Stats`.
 *
 * That is what makes stacking free. Hurry + Hyper + Ascension 7 + a weekly mutator is a
 * four-element array, not sixteen code paths.
 *
 * WHY RESOLUTION IS TWO TIERS
 * Additive first, then multiplicative. If they interleaved, "+10 armor" would be worth more or less
 * depending on where in the list it happened to sit, and card-draw order would leak into the final
 * numbers. Two tiers means a modifier author can reason about their record in isolation.
 *
 * WHY THE MULTIPLICATIVE TIER IS SORTED
 * Integer permille multiplication truncates, and truncation is not commutative:
 * `trunc(trunc(1000 * 1500/1000) * 1333/1000)` is not always `trunc(trunc(1000 * 1333/1000) *
 * 1500/1000)`. Rather than accept float accumulation (which breaks cross-device state hashing) or a
 * single wide product (which overflows past a handful of modifiers), the factors for each stat are
 * sorted into a canonical ascending order before being applied. Insertion order then cannot change
 * the result, which is exactly the property replay revalidation and co-op state hashing need.
 */

import { STAT, STAT_SCALE, STAT_COUNT, type StatId, type Stats } from "./stats";

/** One stat change from one modifier. Exactly one of `add` / `mul` is meaningful per delta. */
export interface StatDelta {
  readonly stat: StatId;
  /** Flat addition, applied in the additive tier. Permille for multiplier stats. */
  readonly add?: number;
  /** Multiplicative factor in permille, applied in the multiplicative tier. 1500 = x1.5. */
  readonly mul?: number;
}

/**
 * Behaviour bits for the things a modifier changes that are *not* a stat.
 *
 * Kept as a bitfield on the resolved result rather than as sim branches per modifier: the sim reads
 * one integer, and a new mode that reuses an existing bit costs nothing.
 */
export const RUN_FLAG = {
  /** Wave table restarts instead of ending the run — Endless. */
  endless: 1 << 0,
  /** Weapons and passives arrive pre-maxed — for testing and for the Chaos event. */
  preMaxed: 1 << 1,
  /** Level-up cards are drawn from the full pool, ignoring unlock state. */
  ignoreUnlocks: 1 << 2,
  /** No card draw at all; level-ups grant a flat stat bump. */
  noCardDraw: 1 << 3,
  /** Reaper cannot be outrun: spawns at half the usual timestamp. */
  earlyReaper: 1 << 4,
  /** Treasure chests never drop. */
  noChests: 1 << 5,
  /** Hide the minute timer — used by the seeded race mode's blind variant. */
  hideTimer: 1 << 6,
} as const;

export type RunFlag = (typeof RUN_FLAG)[keyof typeof RUN_FLAG];

/**
 * Where a modifier came from. Only used for presentation and for deciding what a run is eligible
 * for — the resolve step treats every source identically.
 */
export const MODIFIER_SOURCE = {
  /** Player-selected mode toggle on the stage select screen. */
  mode: 0,
  /** Ascension tier, stacked one record per tier. */
  ascension: 1,
  /** Stage-intrinsic rule (a stage that is always hyper, for instance). */
  stage: 2,
  /** Character-intrinsic rule. */
  character: 3,
  /** Server-driven daily or weekly mutator. */
  liveOps: 4,
  /** Applied by a dev-menu toggle. Always taints the run. */
  dev: 5,
  /** Chaos Sandbox event. */
  chaos: 6,
  /** One level of a passive item the player picked up in-run. */
  passive: 7,
  /** Ranks bought in the PowerUps shop, carried into every run the account starts. */
  powerUp: 8,
} as const;

export type ModifierSource = (typeof MODIFIER_SOURCE)[keyof typeof MODIFIER_SOURCE];

/**
 * A run modifier record.
 *
 * `wireId` is append-only and permanent: it is written into replay headers and co-op join messages,
 * so renumbering it would make old replays resolve to a different set of rules and fail
 * revalidation. `id` is the code-facing key; `wireId` is the on-disk one.
 */
export interface RunModifier {
  readonly id: string;
  readonly wireId: number;
  readonly name: string;
  readonly description: string;
  readonly source: ModifierSource;
  readonly deltas: readonly StatDelta[];
  /** Bits from `RUN_FLAG`. */
  readonly flags?: number;
  /** Gold/XP payout multiplier in permille, for modes that pay extra for the added difficulty. */
  readonly payout?: number;
  /** True when selecting this modifier makes the run ineligible for ladders. */
  readonly taints?: boolean;
}

/** The resolved non-stat outcome of a stack. */
export interface ResolvedRun {
  /** OR of every modifier's `RUN_FLAG` bits. */
  flags: number;
  /** Product of every `payout`, in permille. */
  payout: number;
  /** True if any modifier in the stack taints. */
  tainted: boolean;
}

// ---------------------------------------------------------------------------------------------
// The launch modifier catalog. Content, not logic — every entry is pure data.
// ---------------------------------------------------------------------------------------------

/**
 * Hurry. Run time advances at 2x, so every wave, every boss and the Reaper all arrive twice as
 * fast. Note what this record does *not* contain: no reference to the wave table, no spawn logic,
 * no timer code. It moves one number and the rest of the sim follows.
 */
export const MOD_HURRY: RunModifier = {
  id: "hurry",
  wireId: 1,
  name: "Hurry",
  description: "Time passes twice as fast.",
  source: MODIFIER_SOURCE.mode,
  deltas: [{ stat: STAT.timeScale, mul: 2000 }],
  payout: 1000,
};

/**
 * Hyper. Enemies are faster, tougher and more numerous, and the run pays more for it. Again: pure
 * data, and it composes with Hurry without either record knowing the other exists.
 */
export const MOD_HYPER: RunModifier = {
  id: "hyper",
  wireId: 2,
  name: "Hyper",
  description: "Enemies are faster and arrive in greater numbers. Gold is worth more.",
  source: MODIFIER_SOURCE.mode,
  deltas: [
    { stat: STAT.enemySpeed, mul: 1500 },
    { stat: STAT.enemyHealth, mul: 1300 },
    { stat: STAT.spawnRate, mul: 1300 },
    { stat: STAT.goldGain, mul: 1200 },
  ],
  payout: 1200,
};

/** Endless. The wave table loops with a Curse increment each cycle instead of the run ending. */
export const MOD_ENDLESS: RunModifier = {
  id: "endless",
  wireId: 3,
  name: "Endless",
  description: "The night never ends. Each cycle raises Curse.",
  source: MODIFIER_SOURCE.mode,
  deltas: [],
  flags: RUN_FLAG.endless,
  payout: 1000,
};

/** Inverse. Health and damage swap sides of the difficulty curve, and payout follows. */
export const MOD_INVERSE: RunModifier = {
  id: "inverse",
  wireId: 4,
  name: "Inverse",
  description: "Enemies hit far harder. Your weapons reach further.",
  source: MODIFIER_SOURCE.mode,
  deltas: [
    { stat: STAT.enemyDamage, mul: 3000 },
    { stat: STAT.enemyHealth, mul: 1500 },
    { stat: STAT.area, mul: 1250 },
    { stat: STAT.xpGain, mul: 1500 },
  ],
  payout: 1500,
};

/**
 * One Ascension tier. Ascension is the long-tail endgame ladder, and it is *nothing but* a stack of
 * these — tier 7 is seven records, not a seventh special case.
 */
export const MOD_ASCENSION_TIER: RunModifier = {
  id: "ascension.tier",
  wireId: 5,
  name: "Ascension",
  description: "Enemies grow stronger with each tier. Rewards scale to match.",
  source: MODIFIER_SOURCE.ascension,
  deltas: [
    { stat: STAT.enemyHealth, mul: 1200 },
    { stat: STAT.enemySpeed, mul: 1050 },
    { stat: STAT.curse, mul: 1100 },
  ],
  payout: 1150,
};

/** Dev-menu godmode, expressed as a modifier so it lands in the replay header like anything else. */
export const MOD_DEV_GODMODE: RunModifier = {
  id: "dev.godmode",
  wireId: 6,
  name: "Godmode",
  description: "Incoming damage is nullified.",
  source: MODIFIER_SOURCE.dev,
  deltas: [
    { stat: STAT.armor, add: 1_000_000 },
    { stat: STAT.enemyDamage, mul: 0 },
  ],
  taints: true,
};

export const MODIFIER_CATALOG: readonly RunModifier[] = [
  MOD_HURRY,
  MOD_HYPER,
  MOD_ENDLESS,
  MOD_INVERSE,
  MOD_ASCENSION_TIER,
  MOD_DEV_GODMODE,
];

/** Wire-id lookup, for decoding replay headers and co-op join messages. */
export const MODIFIERS_BY_WIRE_ID: ReadonlyMap<number, RunModifier> = new Map(
  MODIFIER_CATALOG.map((m) => [m.wireId, m]),
);

/** Guard: a duplicated wire id would make one modifier silently decode as another. */
if (MODIFIERS_BY_WIRE_ID.size !== MODIFIER_CATALOG.length) {
  throw new Error("MODIFIER_CATALOG contains duplicate wireId values");
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/** Cap on stacked modifiers, matching `MAX_REPLAY_MODIFIERS` so a legal stack is always recordable. */
export const MAX_STACK = 64;

/**
 * Cap on *loadout* records — the passive items a player is carrying, expressed as modifiers.
 *
 * WHY LOADOUT IS A SECOND LIST AND NOT JUST MORE STACK
 * Passives fold into stats through exactly the same two-tier, order-independent resolution as run
 * modifiers, which is what stops "I took Might before Boots and got different numbers" bugs. But
 * only *run* modifiers belong in the replay header and the co-op join packet — a passive is already
 * reconstructed by replaying the card picks. So the records live in a separate list that `resolve`
 * walks and `wireIds` ignores.
 *
 * 6 passive slots x 5 levels = 30 records worst case; 48 leaves room for a wider loadout later.
 */
export const MAX_LOADOUT = 48;

/** Max multiplicative factors per stat we can resolve without allocating during a resolve. */
const MAX_FACTORS_PER_STAT = MAX_STACK + MAX_LOADOUT;

/**
 * A stack of modifiers plus the machinery to fold it into a `Stats` table.
 *
 * All scratch space is allocated once in the constructor. `resolve` runs on run start, on every
 * level-up and on every co-op resync, and `new` inside those is the allocation pressure that the
 * 500-enemies-at-60fps contract on a 4GB device cannot afford.
 */
export class ModifierStack {
  private readonly list: RunModifier[] = [];
  /** Loadout records (passive items). Resolved alongside `list`, never written to the wire. */
  private readonly loadout: RunModifier[] = [];

  /** Additive accumulator, one slot per stat. */
  private readonly adds = new Int32Array(STAT_COUNT);
  /** Multiplicative factors, `MAX_FACTORS_PER_STAT` per stat, flattened. */
  private readonly factors = new Int32Array(STAT_COUNT * MAX_FACTORS_PER_STAT);
  /** How many factors each stat currently has. */
  private readonly factorCount = new Int32Array(STAT_COUNT);
  /** Scratch for sorting one stat's factors. */
  private readonly sortScratch = new Int32Array(MAX_FACTORS_PER_STAT);

  readonly resolved: ResolvedRun = { flags: 0, payout: STAT_SCALE, tainted: false };

  get size(): number {
    return this.list.length;
  }

  /** The stack in insertion order. Read-only to callers; resolve does not depend on the order. */
  entries(): readonly RunModifier[] {
    return this.list;
  }

  /**
   * Add a modifier. Duplicates are allowed on purpose — Ascension tier 7 is the same record seven
   * times, and a mutator that stacks with itself should not need a separate record per level.
   */
  add(mod: RunModifier): boolean {
    if (this.list.length >= MAX_STACK) return false;
    this.list.push(mod);
    return true;
  }

  /** Add the same modifier `n` times. Used by Ascension and by Curse cycles in Endless. */
  addTimes(mod: RunModifier, n: number): number {
    let added = 0;
    for (let i = 0; i < n; i++) {
      if (!this.add(mod)) break;
      added++;
    }
    return added;
  }

  /** Remove the first instance matching `id`. Returns whether anything was removed. */
  remove(id: string): boolean {
    const i = this.list.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  has(id: string): boolean {
    return this.list.some((m) => m.id === id);
  }

  count(id: string): number {
    let n = 0;
    for (const m of this.list) if (m.id === id) n++;
    return n;
  }

  clear(): void {
    this.list.length = 0;
  }

  /** How many loadout records are folded in. */
  get loadoutSize(): number {
    return this.loadout.length;
  }

  /**
   * Add one loadout record. Returns false when the loadout is full, which the caller treats as an
   * ordinary outcome rather than an error — same contract as `WeaponStore.grant` on a full loadout.
   */
  addLoadout(mod: RunModifier): boolean {
    if (this.loadout.length >= MAX_LOADOUT) return false;
    this.loadout.push(mod);
    return true;
  }

  /**
   * Drop every loadout record.
   *
   * The loadout is rebuilt from the owned passives on every change rather than patched, for the same
   * reason `resolve` re-resolves from base instead of undoing: undo paths are where stat corruption
   * lives.
   */
  clearLoadout(): void {
    this.loadout.length = 0;
  }

  /**
   * Fold the whole stack into `stats`.
   *
   * Order of operations, and none of it is negotiable:
   *  1. `stats.reset()` — resolve is idempotent, so a level-up can re-resolve from scratch instead
   *     of trying to undo the previous pass. Undo-based stat systems are where "I removed a passive
   *     and my damage went up" bugs come from.
   *  2. additive tier, summed (commutative, so insertion order is irrelevant by construction).
   *  3. multiplicative tier, factors sorted ascending then applied (see the file header for why).
   *  4. `clampAll()` once, at the end.
   */
  resolve(stats: Stats): ResolvedRun {
    stats.reset();
    this.adds.fill(0);
    this.factorCount.fill(0);

    let flags = 0;
    let payout = STAT_SCALE;
    let tainted = false;

    // Run modifiers first, then the loadout. The order of these two passes cannot matter: the
    // additive tier is a sum and the multiplicative tier is sorted before it is applied.
    for (let pass = 0; pass < 2; pass++) {
      const source = pass === 0 ? this.list : this.loadout;
      for (const mod of source) {
        flags |= mod.flags ?? 0;
        if (mod.payout !== undefined) payout = Math.trunc((payout * mod.payout) / STAT_SCALE);
        if (mod.taints) tainted = true;

        for (const d of mod.deltas) {
          if (d.add !== undefined) this.adds[d.stat] += d.add;
          if (d.mul !== undefined) {
            const n = this.factorCount[d.stat];
            if (n < MAX_FACTORS_PER_STAT) {
              this.factors[d.stat * MAX_FACTORS_PER_STAT + n] = d.mul;
              this.factorCount[d.stat] = n + 1;
            }
          }
        }
      }
    }

    const values = stats.values;
    for (let stat = 0; stat < STAT_COUNT; stat++) {
      let v = values[stat] + this.adds[stat];

      const n = this.factorCount[stat];
      if (n > 0) {
        const base = stat * MAX_FACTORS_PER_STAT;
        for (let i = 0; i < n; i++) this.sortScratch[i] = this.factors[base + i];
        insertionSortAscending(this.sortScratch, n);
        for (let i = 0; i < n; i++) {
          v = Math.trunc((v * this.sortScratch[i]) / STAT_SCALE);
        }
      }

      values[stat] = v;
    }

    stats.clampAll();

    this.resolved.flags = flags;
    this.resolved.payout = payout;
    this.resolved.tainted = tainted;
    return this.resolved;
  }

  /** Wire ids in canonical (ascending) order, for the replay header and co-op join message. */
  wireIds(out: Int32Array): number {
    const n = Math.min(this.list.length, out.length);
    for (let i = 0; i < n; i++) out[i] = this.list[i].wireId;
    insertionSortAscending(out, n);
    return n;
  }
}

/**
 * Insertion sort over the first `n` slots.
 *
 * Chosen over `Array.prototype.sort` because it works in place on a typed array with no allocation
 * and no comparator closure, and because `n` here is the number of modifiers touching one stat —
 * realistically under ten, where insertion sort beats anything asymptotically smarter.
 */
function insertionSortAscending(a: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const x = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > x) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = x;
  }
}
