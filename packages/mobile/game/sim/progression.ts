/**
 * Levelling — the experience bar, the level curve, and the queue of unspent level-ups.
 *
 * THE CURVE
 * 5 experience to reach level 2, then 10 more per level than the last, flattening at level 20.
 * So: 5, 15, 25, 35 … 195, and 195 forever after. Early levels come in seconds, which is what makes
 * the first minute of a run feel generous; the flat tail is what makes a 90-minute Endless run keep
 * paying out instead of grinding to a halt.
 *
 * THERE IS NO LEVEL CAP
 * Players reach level 14,000 in runs like this. That has two consequences this file has to handle:
 *
 * 1. ONE GEM CAN BE WORTH HUNDREDS OF LEVELS. Walking a naive loop one level at a time is fine for
 *    230 levels and catastrophic for a million, so once the curve goes flat the number of levels is
 *    computed with a single division instead of a loop. A gem worth a billion costs the same as a
 *    gem worth five.
 *
 * 2. LEVEL-UPS MUST QUEUE, NOT INTERRUPT. Showing 230 card screens back to back is not a game. The
 *    level-ups pile up in a counter and the card system drains them, several at a time once the
 *    queue is deep. This file owns the counter; it does not know what a card is.
 *
 * WHOLE NUMBERS ONLY
 * Experience is an integer. The `xpGain` multiplier is applied and then truncated, minimum 1, so
 * two devices replaying the same run reach the same level on the same tick. A fractional experience
 * bar that rounds differently on an iPhone than on the REVVL is a co-op desync.
 */

import type { Stats } from './stats';
import { STAT, STAT_SCALE } from './stats';

/** Experience to leave level 1. */
export const FIRST_LEVEL_COST = 5;

/** Added to the requirement for each level, up to the flatten point. */
export const LEVEL_COST_STEP = 10;

/** The level at which the requirement stops growing. */
export const FLATTEN_LEVEL = 20;

/** Requirement from `FLATTEN_LEVEL` onwards: 5 + 19 × 10 = 195. */
export const FLAT_LEVEL_COST = FIRST_LEVEL_COST + (FLATTEN_LEVEL - 1) * LEVEL_COST_STEP;

/**
 * Ceiling on how many level-ups may sit unspent.
 *
 * Not a limit on levels — a limit on the queue. Past this, levels still count and stats still apply;
 * the player simply cannot be owed more than this many card screens. Without it, a single Limit
 * Break gem could owe someone a five-figure number of card draws.
 */
export const MAX_PENDING_LEVELS = 4096;

/**
 * Experience needed to leave the given level.
 *
 * Level 1 → 5, level 2 → 15, level 3 → 25 … level 20 and beyond → 195.
 */
export function xpForLevel(level: number): number {
  if (level < 1) return FIRST_LEVEL_COST;
  if (level >= FLATTEN_LEVEL) return FLAT_LEVEL_COST;
  return FIRST_LEVEL_COST + (level - 1) * LEVEL_COST_STEP;
}

/**
 * Total experience needed to reach a level from scratch. Closed form, no loop — the dev menu's
 * "set level" jump and the results screen both need this for arbitrary levels.
 */
export function totalXpForLevel(level: number): number {
  if (level <= 1) return 0;
  const ramped = Math.min(level, FLATTEN_LEVEL) - 1;
  // Sum of the arithmetic run 5, 15, 25 … for `ramped` terms.
  let total = ramped * FIRST_LEVEL_COST + LEVEL_COST_STEP * ((ramped * (ramped - 1)) / 2);
  if (level > FLATTEN_LEVEL) total += (level - FLATTEN_LEVEL) * FLAT_LEVEL_COST;
  return total;
}

export class Progression {
  /** Current level. Starts at 1. */
  level = 1;
  /** Experience banked toward the next level. */
  xp = 0;
  /** Experience required to leave the current level. Cached so the HUD never recomputes it. */
  xpToNext = FIRST_LEVEL_COST;
  /** Every point of experience earned this run, after multipliers. */
  totalXp = 0;
  /** Coins earned this run. Never spent in-run. */
  gold = 0;

  /** Level-ups earned but not yet spent on a card. */
  pending = 0;
  /** Level-ups that were earned while the queue was already at its ceiling. Dev-menu only. */
  droppedPending = 0;

  /** Levels gained this tick. The HUD reads this to fire the flash and the sound. */
  gainedThisTick = 0;
  /** Experience gained this tick, after multipliers. */
  xpThisTick = 0;

  /** Highest level reached. Survives `spend` and is what the results screen reports. */
  peakLevel = 1;

  reset(): void {
    this.level = 1;
    this.xp = 0;
    this.xpToNext = FIRST_LEVEL_COST;
    this.totalXp = 0;
    this.gold = 0;
    this.pending = 0;
    this.droppedPending = 0;
    this.gainedThisTick = 0;
    this.xpThisTick = 0;
    this.peakLevel = 1;
  }

  /** Call once at the top of every tick, before pickups run. */
  beginTick(): void {
    this.gainedThisTick = 0;
    this.xpThisTick = 0;
  }

  /**
   * Bank raw experience. Applies `xpGain`, truncates, and levels up as many times as it earns.
   *
   * `raw` is the gem's face value. Returns the number of levels gained.
   */
  addXp(raw: number, stats: Stats): number {
    if (raw <= 0) return 0;
    const mul = stats.get(STAT.xpGain) / STAT_SCALE;
    // Truncate, floor at 1: a heavy Curse penalty must never zero out a gem entirely.
    const amount = Math.max(1, Math.trunc(raw * mul));
    this.xp += amount;
    this.totalXp += amount;
    this.xpThisTick += amount;

    let gained = 0;
    while (this.xp >= this.xpToNext) {
      if (this.level >= FLATTEN_LEVEL) {
        // Past the flatten point every level costs the same, so take them all in one division
        // instead of looping. This is what makes a gem worth a billion cost the same as one worth 5.
        const levels = Math.trunc(this.xp / FLAT_LEVEL_COST);
        if (levels <= 0) break;
        this.xp -= levels * FLAT_LEVEL_COST;
        this.level += levels;
        gained += levels;
        this.xpToNext = FLAT_LEVEL_COST;
        break;
      }
      this.xp -= this.xpToNext;
      this.level++;
      gained++;
      this.xpToNext = xpForLevel(this.level);
    }

    if (gained > 0) {
      this.gainedThisTick += gained;
      if (this.level > this.peakLevel) this.peakLevel = this.level;
      const room = MAX_PENDING_LEVELS - this.pending;
      if (gained <= room) {
        this.pending += gained;
      } else {
        this.pending = MAX_PENDING_LEVELS;
        this.droppedPending += gained - room;
      }
    }
    return gained;
  }

  /** Bank coins. Applies `goldGain`, truncates, floors at 1 so a coin is never worth nothing. */
  addGold(raw: number, stats: Stats): number {
    if (raw <= 0) return 0;
    const mul = stats.get(STAT.goldGain) / STAT_SCALE;
    const amount = Math.max(1, Math.trunc(raw * mul));
    this.gold += amount;
    return amount;
  }

  /**
   * Take level-ups off the queue, up to `count`. Returns how many were actually taken.
   *
   * The card system calls this when it has decided how many choices to present at once.
   */
  spend(count: number): number {
    const taken = Math.min(count, this.pending);
    this.pending -= taken;
    return taken;
  }

  /** True when the player is owed a card screen. */
  get owesCards(): boolean {
    return this.pending > 0;
  }

  /** Progress through the current level, 0…1. For the HUD bar only — never for logic. */
  get barFraction(): number {
    return this.xpToNext > 0 ? Math.min(1, this.xp / this.xpToNext) : 1;
  }

  /**
   * Jump straight to a level. Dev menu only, and it taints the run.
   *
   * Deliberately does NOT queue card draws for the levels skipped — a dev jumping to level 200 wants
   * to be at level 200, not to sit through 199 card screens.
   */
  devSetLevel(level: number): void {
    const target = Math.max(1, Math.trunc(level));
    this.level = target;
    this.xp = 0;
    this.xpToNext = xpForLevel(target);
    this.totalXp = totalXpForLevel(target);
    if (target > this.peakLevel) this.peakLevel = target;
  }
}

/**
 * How many card choices to present for a queue this deep.
 *
 * One at a time feels right for the first few. Once someone is owed dozens, presenting them one by
 * one is a chore, so the batch grows — but it never grows without bound, because a card screen
 * showing forty simultaneous upgrades is unreadable.
 */
export const BATCH_THRESHOLDS: readonly number[] = [1, 2, 4, 8, 16];

export function batchSizeFor(pending: number): number {
  if (pending <= 2) return 1;
  if (pending <= 6) return 2;
  if (pending <= 20) return 4;
  if (pending <= 80) return 8;
  return 16;
}
