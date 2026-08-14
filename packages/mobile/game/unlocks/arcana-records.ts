/**
 * The bridge between what the profile has survived and which arcanas a run may offer.
 *
 * WHY THIS FILE EXISTS
 *
 * Same split as the places, for the same reasons. The arcana table states its rules in its own terms —
 * "survive twenty minutes anywhere", "survive fifteen minutes in the third place" — and knows nothing
 * about save files, because a simulation that imported the save layer would refuse to start a run on a
 * phone whose storage was busy. The save file stores best times as flat slots and unlock marks as bits,
 * because a save file cannot hold sentences without becoming a save file with a text encoder in it.
 *
 * This turns one into the other, and it is the only thing that does.
 *
 * WHY A MARK OUTRANKS THE TIME
 *
 * The promise this whole folder makes: a stored unlock mark is never cleared, so an arcana earned last
 * week is still earned today. The times can only ever *turn a mark on* — a rebalanced threshold, a cloud
 * merge from a phone with less history, or a save migrated up from a build that never recorded per-place
 * times must never take a card back off somebody.
 *
 * WHY THE POOL IS A LIST OF INDICES
 *
 * The run wants a pool to draw from, not a save file. Handing it indices keeps `run.ts` free of the save
 * layer and makes the offer path trivially testable: a pool is an array of small numbers, and a test can
 * write one by hand without constructing a profile.
 */

import { bitGet, type SaveData } from "../save/schema";
import {
  ARCANA_TYPES,
  arcanaAt,
  arcanaConditionMet,
  arcanaUnlockText,
  type ArcanaProgress,
} from "../sim/arcanas";
import { STAGE_TYPES } from "../sim/stages";

/** Stage names in catalog order, for the sentence on a locked card. */
function stageNames(): string[] {
  return STAGE_TYPES.map((s) => s.name);
}

/**
 * Reduce a save to the two facts an arcana rule may ask about.
 *
 * The header's best time is the "anywhere" figure and is deliberately not derived by taking the largest
 * per-place time: the per-place block did not exist before save version 3, so on a migrated profile every
 * per-place time is zero while the header still holds a real record. Deriving would quietly relock the
 * arcanas of every player who has been here since before that change.
 */
export function arcanaProgressOf(save: SaveData): ArcanaProgress {
  const slots = save.stageBestSeconds.length;
  const perStage: number[] = [];
  for (let i = 0; i < STAGE_TYPES.length && i < slots; i++) {
    perStage.push(save.stageBestSeconds[i] as number);
  }
  return { bestAnywhereSeconds: save.bestSurvivalSeconds, bestByStageIndex: perStage };
}

/**
 * Has the profile plainly earned this arcana, ignoring whatever mark is stored?
 *
 * Separate from `isArcanaOpen` for the same reason as everywhere else: this is the only thing allowed to
 * turn a mark on, so it must not be able to see the mark it is about to set, or the mark would justify
 * itself and a wrongly-set bit could never be found.
 */
export function arcanaConditionMetFor(save: SaveData, index: number): boolean {
  const i = index | 0;
  if (i < 0 || i >= ARCANA_TYPES.length) return false;
  return arcanaConditionMet(ARCANA_TYPES[i], arcanaProgressOf(save));
}

/** Is this arcana available to be offered? True if the mark is stored, or the times have earned it. */
export function isArcanaOpen(save: SaveData, index: number): boolean {
  const i = index | 0;
  if (i < 0 || i >= ARCANA_TYPES.length) return false;
  if (bitGet(save.unlockedArcanas, i)) return true;
  return arcanaConditionMetFor(save, i);
}

/**
 * Every arcana this profile may be offered, as indices, in catalog order.
 *
 * This is what `RunConfig.arcanaPool` wants. Order is catalog order rather than unlock order because the
 * deck shuffles anyway, and a stable order keeps a replay's draw reproducible from the profile alone.
 */
export function openArcanaPool(save: SaveData): number[] {
  const pool: number[] = [];
  for (let i = 0; i < ARCANA_TYPES.length; i++) {
    if (isArcanaOpen(save, i)) pool.push(i);
  }
  return pool;
}

/** How many arcanas are currently available. Drawn as "3/8" on the collection screen. */
export function openArcanaCount(save: SaveData): number {
  let open = 0;
  for (let i = 0; i < ARCANA_TYPES.length; i++) {
    if (isArcanaOpen(save, i)) open++;
  }
  return open;
}

/** What a locked arcana card says instead of its blurb. Empty when the arcana is available. */
export function arcanaLockLine(save: SaveData, index: number): string {
  if (isArcanaOpen(save, index)) return "";
  return arcanaUnlockText(arcanaAt(index), stageNames());
}

/** One line for the results screen when an arcana is earned. */
export function arcanaEarnedLine(index: number): string {
  return `${arcanaUnlockText(arcanaAt(index), stageNames())} — done`;
}
