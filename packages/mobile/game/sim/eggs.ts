/**
 * Golden Eggs — permanent per-character meta progression from killing a Reaper.
 *
 * WHY A CURVE AND A HARD CAP
 * The archived plan wanted uncapped +1% per egg. Stats live in an `Int32Array`, so compounding past
 * ~2^31 wraps negative and silently corrupts the run *and* the state hash. Caps on every stat already
 * exist (`stats.ts`); this file adds a second rail so eggs themselves cannot walk up to that wall.
 *
 * The bonus is additive permille on a small set of player-facing multipliers, with diminishing returns
 * toward an asymptote. Integer-only maths, order-independent with the rest of the modifier stack.
 *
 * Eggs are permanent per character, stored on the save, and enter a run as one `RunModifier` so they
 * travel with replays and co-op joins the same way shop powerups do.
 */

import { MODIFIER_SOURCE, type RunModifier, type StatDelta } from "./modifiers";
import { STAT, STAT_SCALE, type StatId } from "./stats";
import type { SaveData } from "../save/schema";

/** How many Golden Eggs a Reaper kill drops. Genre-standard. */
export const EGGS_PER_REAPER_KILL = 5;

/**
 * Hard ceiling per character.
 *
 * Far below the Int32 hazard, and far past what a normal player can farm without Endless. Raising this
 * without revisiting `eggBonusPermille` is how the off-switch comes back.
 */
export const MAX_GOLDEN_EGGS = 100;

/**
 * Wire id base for egg modifiers. Powerups take 200_000+; eggs take 400_000+ so the ranges never meet.
 * Layout: `400_000 + characterIndex * 200 + eggCount` — one record per character naming both who and how
 * many, so a replay header still decodes to exactly one set of numbers.
 */
export const EGG_WIRE_BASE = 400_000;

/** Stats each egg nudges. Kept small and player-facing — never enemy/difficulty knobs. */
const EGG_STATS: readonly StatId[] = [
  STAT.damage,
  STAT.maxHealth,
  STAT.moveSpeed,
  STAT.armor,
  STAT.cooldown,
  STAT.area,
  STAT.duration,
  STAT.projectileSpeed,
];

/**
 * Total additive permille from `count` eggs on one multiplier stat.
 *
 * First eggs are worth ~10‰ (+1%); each next egg is worth a little less, asymptoting so 100 eggs total
 * about +40% rather than +100%. Armor (a count) gets a truncated share so it cannot outrun its cap.
 *
 * Pure integer arithmetic — no floats on a hashed path.
 */
export function eggBonusPermille(count: number): number {
  const n = clampEggs(count);
  if (n <= 0) return 0;
  // Sum of 1000/(100+10*i) for i in 0..n-1, truncated per term.
  // i=0 → 10, i=9 → ~5, i=99 → ~1. Total at 100 ≈ 370‰.
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += Math.trunc(1000 / (100 + 10 * i));
  }
  return total;
}

/** Armor is a flat count; eggs grant a much smaller step so 100 eggs cannot max the 50-cap alone. */
export function eggArmorBonus(count: number): number {
  const n = clampEggs(count);
  // One armor every 20 eggs, truncated. Cap contribution at 5.
  const gained = Math.trunc(n / 20);
  return gained > 5 ? 5 : gained;
}

/** Cooldown is "lower is faster"; eggs subtract a few percent, floored so they cannot zero it. */
export function eggCooldownBonus(count: number): number {
  // Negative add on the cooldown multiplier. Half the damage curve, capped at -200‰.
  const raw = -Math.trunc(eggBonusPermille(count) / 2);
  return raw < -200 ? -200 : raw;
}

export function clampEggs(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const n = Math.trunc(count);
  return n > MAX_GOLDEN_EGGS ? MAX_GOLDEN_EGGS : n;
}

/**
 * How many eggs this character has banked on the save.
 *
 * Stored in `save.masteryLevels` — those bytes were reserved for per-character mastery that has not
 * shipped yet. Eggs need a home before mastery does; a SAVE_VERSION bump solely to rename an unused
 * array is not worth the migration risk. When mastery lands it gets its own block.
 */
export function eggsOf(save: SaveData, characterIndex: number): number {
  if (characterIndex < 0 || characterIndex >= save.masteryLevels.length) return 0;
  return clampEggs(save.masteryLevels[characterIndex] as number);
}

/**
 * Bank eggs onto a character. Returns how many were actually added (0 if already at the cap).
 *
 * Never clears, never takes away — same promise unlocks make.
 */
export function bankEggs(save: SaveData, characterIndex: number, earned: number): number {
  if (characterIndex < 0 || characterIndex >= save.masteryLevels.length) return 0;
  if (!Number.isFinite(earned) || earned <= 0) return 0;
  const have = clampEggs(save.masteryLevels[characterIndex] as number);
  const next = clampEggs(have + Math.trunc(earned));
  const added = next - have;
  save.masteryLevels[characterIndex] = next;
  return added;
}

/** Build the deltas one egg-count produces. */
export function eggDeltas(count: number): readonly StatDelta[] {
  const n = clampEggs(count);
  if (n <= 0) return [];
  const bonus = eggBonusPermille(n);
  const deltas: StatDelta[] = [];
  for (const stat of EGG_STATS) {
    if (stat === STAT.armor) {
      const a = eggArmorBonus(n);
      if (a !== 0) deltas.push({ stat, add: a });
    } else if (stat === STAT.cooldown) {
      const c = eggCooldownBonus(n);
      if (c !== 0) deltas.push({ stat, add: c });
    } else if (stat === STAT.maxHealth) {
      // maxHealth is permille health units; scale like powerups: bonus * (STAT_SCALE/10) health units
      // so +10‰ → +10hp (= 10*STAT_SCALE).
      deltas.push({ stat, add: Math.trunc((bonus * STAT_SCALE) / 10) });
    } else {
      deltas.push({ stat, add: bonus });
    }
  }
  return deltas;
}

/** Wire id for a character's egg count. */
export function eggWireId(characterIndex: number, count: number): number {
  return EGG_WIRE_BASE + characterIndex * 200 + clampEggs(count);
}

/**
 * One modifier record for a character's eggs, or `undefined` when they have none.
 *
 * Built per call rather than cached: egg counts change between runs, and a run must not allocate in the
 * tick — `begin` is allowed to be expensive.
 */
export function eggModifier(characterIndex: number, count: number): RunModifier | undefined {
  const n = clampEggs(count);
  if (n <= 0) return undefined;
  const deltas = eggDeltas(n);
  if (deltas.length === 0) return undefined;
  return {
    id: `eggs.character.${characterIndex}.${n}`,
    wireId: eggWireId(characterIndex, n),
    name: "Golden Eggs",
    description: `${n} Golden Egg${n === 1 ? "" : "s"}.`,
    source: MODIFIER_SOURCE.powerUp,
    deltas,
  };
}

/**
 * Fill `out` with one egg modifier per character that has eggs. Returns how many were written.
 *
 * Same contract as `powerUpLoadout`: caller-owned array, allocates nothing beyond what the caller passed.
 */
export function eggLoadout(save: SaveData, characterIds: readonly number[], out: RunModifier[]): number {
  let count = 0;
  const seen = new Set<number>();
  for (let i = 0; i < characterIds.length; i++) {
    const who = characterIds[i] as number;
    if (seen.has(who)) continue;
    seen.add(who);
    const mod = eggModifier(who, eggsOf(save, who));
    if (mod === undefined) continue;
    out[count++] = mod;
  }
  out.length = count;
  return count;
}

/**
 * Rebuild an egg modifier from a wire id (replay / snapshot restore).
 * Returns undefined when the id is outside the egg range or names an impossible egg count.
 */
export function eggModifierFromWire(wireId: number): RunModifier | undefined {
  if (!Number.isSafeInteger(wireId) || wireId < EGG_WIRE_BASE) return undefined;
  const offset = wireId - EGG_WIRE_BASE;
  const characterIndex = Math.trunc(offset / 200);
  const eggCount = offset - characterIndex * 200;
  if (characterIndex < 0 || eggCount < 0 || eggCount > MAX_GOLDEN_EGGS) return undefined;
  return eggModifier(characterIndex, eggCount);
}
