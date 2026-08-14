/**
 * The bridge between "how long you survived in each place" and "which places you may play".
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Two halves of the game keep the same fact in two different shapes and neither may learn the other's.
 * The stage table (`sim/stages.ts`) states the rule — the marsh opens once you have survived fifteen
 * minutes in the ossuary — and it states it in terms of stage *ids*, because a table that talked about
 * save-file slot numbers would break the moment stages were reordered. The save file stores best times
 * as a flat array of slots, because a save file cannot hold strings without becoming a save file with a
 * text encoder in it.
 *
 * Something has to turn one into the other. If that something lived in the stage table, the simulation
 * would import the save layer, and a run would refuse to start on a phone whose storage was busy. If it
 * lived in the save layer, the save would have to know what a stage is. So it lives here, in the unlock
 * layer, which is already the place that turns "what the profile has earned" into "what the player may
 * have".
 *
 * WHY A BIT OUTRANKS THE TIME
 *
 * Same promise as everywhere else in this folder: a stored unlock bit is never cleared, so once a place
 * has been opened it stays open. The time rule can only ever *turn a bit on*. That matters because times
 * can effectively move — a rebalance changes a threshold, a cloud merge arrives from a phone with less
 * history, a save is migrated forward from a version that never recorded per-place times at all. In every
 * one of those cases a player who opened the belfry last week must still find it open today.
 *
 * WHICH IS ALSO WHY THE MIGRATION IS SAFE
 *
 * A save written before per-place times existed arrives here with every time at zero. On its own that
 * would relock everything past the first place. It does not, because those saves already carry their
 * stage bits, and a bit outranks the time. The times simply start filling in from the next run onwards.
 */

import { bitGet, type SaveData } from "../save/schema";
import { STAGE_TYPES, stageAt, stageUnlocked, unlockText } from "../sim/stages";

/** A record with nothing in it, for the callers that have no save to read. Frozen so nobody fills it in. */
const NO_TIMES: Readonly<Record<string, number>> = Object.freeze({});

/**
 * The save's per-place best times, keyed the way the stage rules want them.
 *
 * Only the stages this build actually has are read. A slot past the end of the stage table belongs to a
 * place that does not exist here — a live-ops stage from a newer build, arriving by cloud sync — and it is
 * left alone rather than guessed at, which is the same thing the payout does at the other end.
 */
export function bestByStageId(save: SaveData): Readonly<Record<string, number>> {
  const times: Record<string, number> = {};
  const slots = save.stageBestSeconds.length;
  for (let i = 0; i < STAGE_TYPES.length && i < slots; i++) {
    times[STAGE_TYPES[i].id] = save.stageBestSeconds[i] as number;
  }
  return times;
}

/** The best time on one place, in seconds. Zero for a place never played, or one the save cannot hold. */
export function stageBestOf(save: SaveData, index: number): number {
  const i = index | 0;
  if (i < 0 || i >= STAGE_TYPES.length || i >= save.stageBestSeconds.length) return 0;
  return save.stageBestSeconds[i] as number;
}

/**
 * Has the profile plainly earned this place, ignoring whatever bit is stored?
 *
 * The counterpart of `characterConditionMet`, and separate from `isStageOpen` for exactly the same reason:
 * this is the only thing allowed to turn a bit on, so it must not be able to see the bit it is about to set.
 */
export function stageConditionMet(save: SaveData, index: number): boolean {
  const i = index | 0;
  if (i < 0 || i >= STAGE_TYPES.length) return false;
  return stageUnlocked(STAGE_TYPES[i], bestByStageId(save));
}

/** May this place be played? True if the bit is stored, or if the times say it has been earned. */
export function isStageOpen(save: SaveData, index: number): boolean {
  const i = index | 0;
  if (i < 0 || i >= STAGE_TYPES.length) return false;
  if (bitGet(save.unlockedStages, i)) return true;
  return stageConditionMet(save, i);
}

/** How many places are currently playable. Drawn as "2/5" at the top of the select screen. */
export function openStageCount(save: SaveData): number {
  let open = 0;
  for (let i = 0; i < STAGE_TYPES.length; i++) {
    if (isStageOpen(save, i)) open++;
  }
  return open;
}

/**
 * The place a run should actually start in, given the one that was asked for.
 *
 * Nothing downstream of this may start a run in a locked place, and the first place is always open, so an
 * unreadable, out-of-range or locked request falls back to the first rather than refusing. A player who
 * taps play should get a run.
 */
export function firstOpenStage(save: SaveData, wanted: number): number {
  const i = Number.isSafeInteger(wanted) ? wanted | 0 : 0;
  if (i > 0 && i < STAGE_TYPES.length && isStageOpen(save, i)) return i;
  return 0;
}

/** What a locked card says instead of a play button. Empty when the place is open. */
export function stageLockLine(save: SaveData, index: number): string {
  if (isStageOpen(save, index)) return "";
  return unlockText(stageAt(index), bestByStageId(save));
}

/**
 * A best time as `M:SS`, or an empty string for a place never played.
 *
 * Deliberately empty rather than "0:00": a card reading zero looks like a record of a run that ended
 * instantly, and "never played" is a different thing that deserves different words on the card.
 */
export function bestTimeLine(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total <= 0) return "";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/** One line for the results screen when a place opens up. */
export function stageEarnedLine(index: number): string {
  const stage = stageAt(index);
  const text = unlockText(stage, NO_TIMES);
  return text === "" ? "Open from the start" : `${text} — done`;
}
