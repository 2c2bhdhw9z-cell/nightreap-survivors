/**
 * The run modifier stack.
 *
 * WHY THIS EXISTS IN PHASE 1 RATHER THAN WHENEVER MODES SHIP
 * Every game mode in the plan — Hurry, Hyper, Endless, Inverse, Limit Break, daily seeds, the weekly
 * mutator, and all of Ascension — is a difficulty knob. The tempting shape is `if (mode === HYPER)`
 * sprinkled through the spawner and the enemy tick. That shape is a dead end: it makes modes
 * mutually exclusive, it makes Ascension (which is *dozens* of stacked knobs) unimplementable, and
 * it means the netcode and the replay validator have to agree on a mode enum that keeps growing.
 *
 * So the sim never learns what a mode is. It only reads stats. A mode is a `RunModifier` — a data
 * record listing stat operations — and a run carries a *stack* of them. Hurry and Hyper stack
 * because nothing in the sim knows they are different kinds of thing.
 *
 * WHY THREE TIERS
 * Resolution must be order-independent: the replay validator and four co-op clients may hold the
 * same modifiers in different insertion orders, and if the resolved stats differ by one permille the
 * state hashes diverge and a legitimate run gets rejected. So:
 *
 *   1. `add`   — flat integer sums. Commutative by construction.
 *   2. `mul`   — percent bonuses. Summed into one permille delta *before* being applied, so ten
 *                "+10%" are exactly "+100%" with no intermediate truncation to accumulate.
 *   3. `scale` — true compounding multipliers (Curse, Ascension tiers). Integer truncation makes
 *                these order-*dependent*, so they are sorted into a canonical order before applying
 *                rather than trusted to arrive consistently.
 *
 * Then, and only then, the caps and floors in `stats.ts` are applied once.
 */

import { STAT, STAT_BASE, STAT_COUNT, STAT_SCALE, type StatId, type Stats } from "./stats";

/** How a modifier operation combines with what is already there. */
export const OP = {
  /** Add a flat amount to the stat. `+1 amount`, `+50 maxHealth`. */
  add: 0,
  /** Add a percent bonus, in permille. Pooled additively with every other `mul` on the same stat. */
  mul: 1,
  /** Compounding multiplier, in permille. Applied after all `mul`, in canonical order. */
  scale: 2,
} as const;

export type OpKind = (typeof OP)[keyof typeof OP];

export interface ModifierOp {
  readonly stat: StatId;
  readonly kind: OpKind;
  /** Flat amount for `add`; permille delta for `mul` (+100 = +10%); permille factor for `scale`. */
  readonly value: number;
}

/**
 * Numeric modifier ids. Append-only, for the same reason `STAT` is: these travel over the wire
 * (`MAX_WIRE_MODIFIERS`) and sit in replay headers (`MAX_REPLAY_MODIFIERS`), so a reordering would
 * make every stored replay resolve to a different difficulty.
 */
export const MODIFIER = {
  hurry: 0,
  hyper: 1,
  endless: 2,
  inverse: 3,
  limitBreak: 4,
  /** Applied once per Endless wave-table cycle; stacks with itself. */
  curseCycle: 5,
  /** Dev-menu difficulty edits collapse into this, so the taint bit has an owner. */
  devEdit: 6,
} as const;

export type ModifierId = (typeof MODIFIER)[keyof typeof MODIFIER];

export interface RunModifier {
  readonly id: ModifierId;
  /** Internal name. Player-facing strings live in the content layer, not here. */
  readonly key: string;
  readonly ops: readonly ModifierOp[];
  /**
   * Taint bits this modifier contributes to the run header, if any. Legitimate modes contribute
   * nothing; only dev edits do. Kept on the modifier so a new mode cannot forget to declare itself.
   */
  readonly taint?: number;
  /** May this modifier appear more than once in a stack? Curse cycles can; Hurry cannot. */
  readonly stacksWithSelf?: boolean;
}

const add = (stat: StatId, value: number): ModifierOp => ({ stat, kind: OP.add, value });
const mul = (stat: StatId, value: number): ModifierOp => ({ stat, kind: OP.mul, value });
const scale = (stat: StatId, value: number): ModifierOp => ({ stat, kind: OP.scale, value });

/**
 * Hurry: run time advances at double rate. Everything downstream — the wave table, weapon cooldowns
 * measured in run time, the Reaper clock — follows from `timeScale` without knowing why.
 */
export const MOD_HURRY: RunModifier = {
  id: MODIFIER.hurry,
  key: "hurry",
  ops: [scale(STAT.timeScale, 2 * STAT_SCALE)],
};

/**
 * Hyper: faster, tougher, more numerous enemies, with a gold bonus as compensation. Note it touches
 * a completely disjoint set of stats from Hurry — which is the whole point of the exercise. The two
 * compose with no code aware that both are active.
 */
export const MOD_HYPER: RunModifier = {
  id: MODIFIER.hyper,
  key: "hyper",
  ops: [
    scale(STAT.enemySpeed, 1200),
    scale(STAT.enemyHealth, 1200),
    scale(STAT.spawnRate, 1200),
    mul(STAT.goldGain, 500),
  ],
};

/** One Endless cycle's worth of Curse. Stacks with itself, once per wave-table restart. */
export const MOD_CURSE_CYCLE: RunModifier = {
  id: MODIFIER.curseCycle,
  key: "curseCycle",
  stacksWithSelf: true,
  ops: [scale(STAT.curse, 1100)],
};

/** Every shipped modifier, keyed by id, for wire and replay decoding. */
export const MODIFIER_TABLE: Readonly<Record<number, RunModifier>> = {
  [MODIFIER.hurry]: MOD_HURRY,
  [MODIFIER.hyper]: MOD_HYPER,
  [MODIFIER.curseCycle]: MOD_CURSE_CYCLE,
};

/**
 * A run's modifier stack.
 *
 * Holds modifiers, resolves them into a `Stats` table, and nothing else. It allocates its scratch
 * buffers once in the constructor: `resolve` runs on level-up and on every arcana pickup, which is
 * not per-tick, but it *is* inside a run, and `new` inside a run is how we lose the frame budget in
 * a 40-minute session.
 */
export class ModifierStack {
  private readonly mods: RunModifier[] = [];

  /** Pooled `add` totals per stat. */
  private readonly addAcc = new Int32Array(STAT_COUNT);
  /** Pooled `mul` permille deltas per stat. */
  private readonly mulAcc = new Int32Array(STAT_COUNT);
  /** `scale` factors, flattened as (stat, value) pairs and sorted before use. */
  private scaleStat = new Int32Array(64);
  private scaleValue = new Int32Array(64);
  private scaleCount = 0;

  get size(): number {
    return this.mods.length;
  }

  /** Read-only view for the dev menu and the replay header writer. */
  list(): readonly RunModifier[] {
    return this.mods;
  }

  has(id: ModifierId): boolean {
    for (let i = 0; i < this.mods.length; i++) if (this.mods[i].id === id) return true;
    return false;
  }

  /** Returns false if the modifier is already present and does not stack with itself. */
  push(mod: RunModifier): boolean {
    if (!mod.stacksWithSelf && this.has(mod.id)) return false;
    this.mods.push(mod);
    return true;
  }

  /** Removes the last instance of a modifier. Returns false if it was not there. */
  remove(id: ModifierId): boolean {
    for (let i = this.mods.length - 1; i >= 0; i--) {
      if (this.mods[i].id === id) {
        this.mods.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.mods.length = 0;
  }

  /** OR of every taint bit the stack contributes. The run header reads this, never the modifiers. */
  taintBits(): number {
    let bits = 0;
    for (let i = 0; i < this.mods.length; i++) bits |= this.mods[i].taint ?? 0;
    return bits;
  }

  /**
   * Write the resolved stats into `out`, starting from the character baseline.
   *
   * `characterBase` is the character's own stat table (already `STAT_BASE` plus its own record); pass
   * `null` for a plain baseline. It is read, never written.
   */
  resolve(out: Stats, characterBase: Int32Array | readonly number[] | null): void {
    const v = out.values;
    const base = characterBase ?? STAT_BASE;
    for (let i = 0; i < STAT_COUNT; i++) v[i] = base[i];

    this.addAcc.fill(0);
    this.mulAcc.fill(0);
    this.scaleCount = 0;

    for (let m = 0; m < this.mods.length; m++) {
      const ops = this.mods[m].ops;
      for (let o = 0; o < ops.length; o++) {
        const op = ops[o];
        if (op.kind === OP.add) {
          this.addAcc[op.stat] += op.value;
        } else if (op.kind === OP.mul) {
          this.mulAcc[op.stat] += op.value;
        } else {
          this.pushScale(op.stat, op.value);
        }
      }
    }

    // Tier 1: flat sums.
    for (let i = 0; i < STAT_COUNT; i++) {
      if (this.addAcc[i] !== 0) v[i] += this.addAcc[i];
    }

    // Tier 2: pooled percent, applied once per stat so truncation happens exactly once.
    for (let i = 0; i < STAT_COUNT; i++) {
      const delta = this.mulAcc[i];
      if (delta !== 0) v[i] = Math.trunc((v[i] * (STAT_SCALE + delta)) / STAT_SCALE);
    }

    // Tier 3: compounding factors, in canonical order.
    this.sortScales();
    for (let i = 0; i < this.scaleCount; i++) {
      const s = this.scaleStat[i];
      v[s] = Math.trunc((v[s] * this.scaleValue[i]) / STAT_SCALE);
    }

    out.clampAll();
  }

  private pushScale(stat: number, value: number): void {
    if (this.scaleCount === this.scaleStat.length) {
      const stats = new Int32Array(this.scaleStat.length * 2);
      const values = new Int32Array(this.scaleValue.length * 2);
      stats.set(this.scaleStat);
      values.set(this.scaleValue);
      this.scaleStat = stats;
      this.scaleValue = values;
    }
    this.scaleStat[this.scaleCount] = stat;
    this.scaleValue[this.scaleCount] = value;
    this.scaleCount++;
  }

  /**
   * Insertion sort by (stat, value). Insertion sort rather than `Array.prototype.sort` because the
   * data is in typed arrays and the count is small — a stack of 40 Ascension modifiers is maybe 60
   * scale ops — and because it avoids allocating the object array a comparator sort would need.
   *
   * The canonical order is what makes tier 3 order-independent. Integer truncation means
   * `trunc(trunc(x*a)*b)` is not always `trunc(trunc(x*b)*a)`, so "sorted" is doing real work here,
   * not tidying.
   */
  private sortScales(): void {
    for (let i = 1; i < this.scaleCount; i++) {
      const s = this.scaleStat[i];
      const val = this.scaleValue[i];
      let j = i - 1;
      while (j >= 0 && (this.scaleStat[j] > s || (this.scaleStat[j] === s && this.scaleValue[j] > val))) {
        this.scaleStat[j + 1] = this.scaleStat[j];
        this.scaleValue[j + 1] = this.scaleValue[j];
        j--;
      }
      this.scaleStat[j + 1] = s;
      this.scaleValue[j + 1] = val;
    }
  }
}

/** Convenience for tests and the dev menu: build a one-off modifier without a content record. */
export function makeModifier(
  id: ModifierId,
  key: string,
  ops: readonly ModifierOp[],
  taint?: number,
): RunModifier {
  return { id, key, ops, taint, stacksWithSelf: true };
}

export const modifierOps = { add, mul, scale };
