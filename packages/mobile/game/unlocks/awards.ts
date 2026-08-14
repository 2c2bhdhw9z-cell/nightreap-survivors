/**
 * Handing out unlocks, in one place, so nothing can be earned twice and nothing can be taken back.
 *
 * WHY THIS IS A SEPARATE LAYER
 *
 * Every content list already knows how to answer "is this thing available to this save" — `roster.ts` does
 * it for characters, `powerups.ts` does it for shop rows. Those answers are *derived*: they look at lifetime
 * gold, runs finished and best time, and say yes or no on the spot. Derived answers are the right default
 * because they survive a broken save, a migration and a sync from a device with a shorter history.
 *
 * What a derived answer cannot do is tell the player *when* something happened. "Unlocked" is a moment: it
 * belongs on the results screen right after the run that earned it, with a name and a line of text. That
 * moment only exists if somebody writes it down. This file is where it gets written down: it walks the
 * content, compares what the profile has plainly earned against the bits already stored, sets the missing
 * bits, and reports what it just set.
 *
 * WHY BITS ARE ONLY EVER SET
 *
 * A stored bit outranks the condition (see `isCharacterUnlocked`), which means a bit is a promise: whatever
 * happens to the numbers later, the player keeps the thing. So nothing in this file clears a bit, and there
 * is no function that can. That rules out a whole family of bugs whose shape is always the same — a rebalance
 * moves a threshold, or a sync arrives from a phone with less progress, and a player who unlocked somebody
 * last month opens the game to find them locked. Gold can go down. Unlocks cannot.
 *
 * WHY THE STARTERS ARE SEEDED SILENTLY
 *
 * Three characters are available on a brand new save. If the sweep reported those as "newly unlocked", the
 * first results screen a player ever sees would announce three unlocks they had before they pressed play.
 * `seedStarters` writes those bits without reporting them, so the bitset is honest — `bitCount` means
 * something — while the report only ever carries things the player actually just earned.
 *
 * WHY THE REPORT IS A FIXED-SIZE, CALLER-OWNED RECORD
 *
 * Same reason as the payout receipt: the results screen must be able to draw without doing arithmetic, and
 * the sweep must be safe to call from anywhere without allocating. A report holds up to `AWARD_LIMIT` rows;
 * if more than that lands at once, the extra ones are *counted* in `overflow` and their bits are still set.
 * Losing an unlock because a screen ran out of rows would be unforgivable; not listing it is merely untidy,
 * and the screen can say "and 3 more".
 */

import { bitGet, bitSet, SAVE_LIMITS, type SaveData } from "../save/schema";
import { CHAR_UNLOCK, CHARACTERS, type Character } from "../characters/roster";
import { ARCANA_TYPES } from "../sim/arcanas";
import { STAGE_TYPES } from "../sim/stages";
import { arcanaConditionMetFor, arcanaEarnedLine } from "./arcana-records";
import { stageConditionMet, stageEarnedLine } from "./stage-records";

/**
 * The lists a save keeps unlock bits for.
 *
 * These numbers are stored nowhere, so they are free to change; they exist so one function can be told which
 * bitset to write, instead of four near-identical functions drifting apart.
 */
export const TRACK = {
  CHARACTER: 0,
  WEAPON: 1,
  STAGE: 2,
  ARCANA: 3,
  ACHIEVEMENT: 4,
} as const;

export type TrackId = (typeof TRACK)[keyof typeof TRACK];

export const TRACK_NAMES: Readonly<Record<TrackId, string>> = {
  [TRACK.CHARACTER]: "character",
  [TRACK.WEAPON]: "weapon",
  [TRACK.STAGE]: "stage",
  [TRACK.ARCANA]: "arcana",
  [TRACK.ACHIEVEMENT]: "achievement",
};

/**
 * Why a grant did not happen.
 *
 * `ALREADY_HELD` is not a failure and deliberately has its own code rather than sharing `OK`: a caller that
 * wants to know whether it just changed anything — a screen deciding whether to play a sound — must be able
 * to tell "I gave them this" from "they had it". Codes are internal, so this list may be reordered.
 */
export const AWARD = {
  OK: 0,
  UNKNOWN_TRACK: 1,
  INDEX_NOT_SAFE: 2,
  INDEX_OUT_OF_RANGE: 3,
  ALREADY_HELD: 4,
  NO_NAME: 5,
} as const;

export type AwardCode = (typeof AWARD)[keyof typeof AWARD];

export const AWARD_NAMES: Readonly<Record<AwardCode, string>> = {
  [AWARD.OK]: "granted",
  [AWARD.UNKNOWN_TRACK]: "that is not a list this save tracks",
  [AWARD.INDEX_NOT_SAFE]: "that is not a whole position",
  [AWARD.INDEX_OUT_OF_RANGE]: "that position is past the end of the list",
  [AWARD.ALREADY_HELD]: "already unlocked",
  [AWARD.NO_NAME]: "an unlock with no name would draw as a blank row",
};

export function describeAward(code: number): string {
  return AWARD_NAMES[code as AwardCode] ?? `unknown award code ${code}`;
}

/** How many rows a single report can carry. A results screen has no room for more than a handful anyway. */
export const AWARD_LIMIT = 16;

/**
 * What a sweep just handed out.
 *
 * Parallel arrays rather than an array of objects, because a report is reused between runs and an array of
 * objects would allocate on every sweep. `count` is how many rows are filled; `overflow` is how many further
 * unlocks were granted but had nowhere to be listed.
 */
export interface AwardReport {
  count: number;
  overflow: number;
  tracks: Int32Array;
  indices: Int32Array;
  names: string[];
  lines: string[];
}

export function createAwardReport(): AwardReport {
  return {
    count: 0,
    overflow: 0,
    tracks: new Int32Array(AWARD_LIMIT),
    indices: new Int32Array(AWARD_LIMIT),
    names: Array.from<string>({ length: AWARD_LIMIT }).fill(""),
    lines: Array.from<string>({ length: AWARD_LIMIT }).fill(""),
  };
}

/**
 * Empty a report.
 *
 * Wipes the text as well as the counters. A report is reused between runs, and a stale name left behind a
 * lowered `count` is exactly the bug the payout receipt already had once: the numbers say nothing happened
 * and the strings still describe last time.
 */
export function resetAwardReport(report: AwardReport): void {
  report.count = 0;
  report.overflow = 0;
  for (let i = 0; i < AWARD_LIMIT; i++) {
    report.tracks[i] = -1;
    report.indices[i] = -1;
    report.names[i] = "";
    report.lines[i] = "";
  }
}

/** The bitset a track lives in, or `undefined` for a track this save does not keep. */
export function setFor(save: SaveData, track: number): Uint8Array | undefined {
  switch (track) {
    case TRACK.CHARACTER:
      return save.unlockedCharacters;
    case TRACK.WEAPON:
      return save.unlockedWeapons;
    case TRACK.STAGE:
      return save.unlockedStages;
    case TRACK.ARCANA:
      return save.unlockedArcanas;
    case TRACK.ACHIEVEMENT:
      return save.achievements;
    default:
      return undefined;
  }
}

/** How many positions a track's bitset can hold. Bytes are fixed by `SAVE_LIMITS`, so this is a constant. */
export function capacityOf(track: number): number {
  switch (track) {
    case TRACK.CHARACTER:
      return SAVE_LIMITS.characterBytes * 8;
    case TRACK.WEAPON:
      return SAVE_LIMITS.weaponBytes * 8;
    case TRACK.STAGE:
      return SAVE_LIMITS.stageBytes * 8;
    case TRACK.ARCANA:
      return SAVE_LIMITS.arcanaBytes * 8;
    case TRACK.ACHIEVEMENT:
      return SAVE_LIMITS.achievementBytes * 8;
    default:
      return 0;
  }
}

/** Does this save already hold a position on a track? A position it cannot describe is not held. */
export function isHeld(save: SaveData, track: number, index: number): boolean {
  const set = setFor(save, track);
  if (set === undefined) return false;
  if (!Number.isSafeInteger(index) || index < 0 || index >= capacityOf(track)) return false;
  return bitGet(set, index);
}

/**
 * Add a row to a report, or count it as overflow. Never refuses — the bit is already set by the time this
 * runs, and a report that quietly disagreed with the save would be worse than a report that says "and more".
 */
function note(report: AwardReport, track: number, index: number, name: string, line: string): void {
  if (report.count >= AWARD_LIMIT) {
    report.overflow++;
    return;
  }
  const at = report.count;
  report.tracks[at] = track;
  report.indices[at] = index;
  report.names[at] = name;
  report.lines[at] = line;
  report.count++;
}

/**
 * Grant one position on one track.
 *
 * Refuses a position the save cannot store rather than writing nothing and claiming success: an out-of-range
 * bit is how a content list that outgrew its bitset would fail, and it must be loud. `report` may be omitted
 * for a grant nobody needs to be told about.
 *
 * A grant is idempotent by construction: the bit is set, and setting a set bit changes nothing, so a caller
 * that runs twice hands out one unlock and reports it once.
 */
export function grant(
  save: SaveData,
  track: number,
  index: number,
  name: string,
  line: string,
  report?: AwardReport,
): AwardCode {
  const set = setFor(save, track);
  if (set === undefined) return AWARD.UNKNOWN_TRACK;
  if (!Number.isSafeInteger(index) || index < 0) return AWARD.INDEX_NOT_SAFE;
  if (index >= capacityOf(track)) return AWARD.INDEX_OUT_OF_RANGE;
  if (name.trim() === "") return AWARD.NO_NAME;
  if (bitGet(set, index)) return AWARD.ALREADY_HELD;
  bitSet(set, index, true);
  if (report !== undefined) note(report, track, index, name, line);
  return AWARD.OK;
}

/* ---- what the profile has earned ---------------------------------------------------------------- */

/**
 * Has this save plainly earned a character, ignoring whatever bit is stored?
 *
 * Deliberately not `isCharacterUnlocked`: that one answers "can they play this", which is true the moment the
 * bit is set. Here the question is "have the numbers reached the bar", which is the only thing that can turn a
 * bit on. Keeping the two apart is what stops the sweep from congratulating a player for an unlock that was
 * granted some other way — a gift, an achievement, a future promotion.
 */
export function characterConditionMet(save: SaveData, character: Character): boolean {
  switch (character.unlock) {
    case CHAR_UNLOCK.ALWAYS:
      return true;
    case CHAR_UNLOCK.LIFETIME_GOLD:
      return save.goldLifetime >= character.unlockValue;
    case CHAR_UNLOCK.RUNS_COMPLETED:
      return save.runsCompleted >= character.unlockValue;
    case CHAR_UNLOCK.BEST_SECONDS:
      return save.bestSurvivalSeconds >= character.unlockValue;
    default:
      return false;
  }
}

/**
 * Write the bits for everybody who is available on a brand new save, without reporting them.
 *
 * Called once when a profile is created and again after a migration, because a v1 save has no character bits
 * at all. Returns how many bits it had to write, which is zero on every call after the first — a non-zero
 * answer on an established save means something arrived with bits missing, which is worth a log line.
 */
export function seedStarters(save: SaveData, list: readonly Character[] = CHARACTERS): number {
  let written = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].unlock !== CHAR_UNLOCK.ALWAYS) continue;
    if (grant(save, TRACK.CHARACTER, i, list[i].name, "") === AWARD.OK) written++;
  }
  return written;
}

/** One line of plain English for why a character just showed up. Drawn under the name on the results screen. */
export function earnedLine(character: Character): string {
  switch (character.unlock) {
    case CHAR_UNLOCK.LIFETIME_GOLD:
      return `Earned ${character.unlockValue} gold in total.`;
    case CHAR_UNLOCK.RUNS_COMPLETED:
      return character.unlockValue === 1 ? "Finished a run." : `Finished ${character.unlockValue} runs.`;
    case CHAR_UNLOCK.BEST_SECONDS:
      return `Survived ${Math.floor(character.unlockValue / 60)} minutes in one run.`;
    default:
      return "Unlocked.";
  }
}

/**
 * Compare the whole roster against the profile, set every bit that has been earned, and report the new ones.
 *
 * Call this *after* the run's gold and time have been banked, never before: the sweep reads the profile and
 * nothing else, so running it first would hand out last run's unlocks and then announce them again next time.
 *
 * Starters are skipped rather than reported, for the reason at the top of this file. The return value is how
 * many bits were newly set, which includes any that overflowed the report's rows.
 */
export function sweepUnlocks(
  save: SaveData,
  report: AwardReport,
  list: readonly Character[] = CHARACTERS,
): number {
  resetAwardReport(report);
  let granted = 0;
  for (let i = 0; i < list.length; i++) {
    const character = list[i];
    if (character.unlock === CHAR_UNLOCK.ALWAYS) continue;
    if (!characterConditionMet(save, character)) continue;
    const code = grant(save, TRACK.CHARACTER, i, character.name, earnedLine(character), report);
    if (code === AWARD.OK) granted++;
  }
  // Places open the same way people do: the profile has plainly earned it, so the bit goes on and the
  // results screen gets to say so. The first place is skipped for the same reason the starting characters
  // are — nobody wants to be congratulated for something they had before they pressed play.
  for (let i = 1; i < STAGE_TYPES.length; i++) {
    if (!stageConditionMet(save, i)) continue;
    const code = grant(save, TRACK.STAGE, i, STAGE_TYPES[i].name, stageEarnedLine(i), report);
    if (code === AWARD.OK) granted++;
  }
  // Arcanas, the same way again. The first one is skipped because it is there from the start, and being
  // congratulated for a card you already had reads as a bug.
  for (let i = 1; i < ARCANA_TYPES.length; i++) {
    if (!arcanaConditionMetFor(save, i)) continue;
    const code = grant(save, TRACK.ARCANA, i, ARCANA_TYPES[i].name, arcanaEarnedLine(i), report);
    if (code === AWARD.OK) granted++;
  }
  return granted;
}

/** How many rows a screen can draw, and how many it has to summarise as "and N more". */
export function reportRows(report: AwardReport): number {
  return Math.min(report.count, AWARD_LIMIT);
}

/**
 * Self-check, run at import. Prints and never throws, like the other content checks.
 *
 * What it is really guarding is the pair of assumptions the rest of the file rests on: that every track's
 * content fits inside the bitset the save reserved for it, and that a brand new profile is not a wall of
 * locked rows.
 */
export function contentFaults(list: readonly Character[] = CHARACTERS): readonly string[] {
  const faults: string[] = [];

  if (list.length > capacityOf(TRACK.CHARACTER)) {
    faults.push(`${list.length} characters but the save only stores ${capacityOf(TRACK.CHARACTER)} bits`);
  }

  if (STAGE_TYPES.length > capacityOf(TRACK.STAGE)) {
    faults.push(`${STAGE_TYPES.length} stages but the save only stores ${capacityOf(TRACK.STAGE)} bits`);
  }

  if (ARCANA_TYPES.length > capacityOf(TRACK.ARCANA)) {
    faults.push(
      `${ARCANA_TYPES.length} arcanas but the save only stores ${capacityOf(TRACK.ARCANA)} bits`,
    );
  }

  let starters = 0;
  for (const character of list) {
    if (character.unlock === CHAR_UNLOCK.ALWAYS) starters++;
    else if (!Number.isSafeInteger(character.unlockValue) || character.unlockValue <= 0) {
      faults.push(`${character.id} unlocks at ${character.unlockValue}, which is not a bar anybody can clear`);
    }
    if (earnedLine(character).trim() === "") faults.push(`${character.id} has no unlock line to draw`);
  }
  if (starters === 0) faults.push("no character is unlocked on a new save");

  for (const track of Object.values(TRACK)) {
    if (capacityOf(track) <= 0) faults.push(`track ${TRACK_NAMES[track]} has no room in the save`);
  }

  return faults;
}

for (const fault of contentFaults()) {
  console.error(`unlock content fault: ${fault}`);
}
