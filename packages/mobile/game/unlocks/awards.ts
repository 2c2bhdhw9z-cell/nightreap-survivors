import { bitGet, bitSet, SAVE_LIMITS, type SaveData } from "../save/schema";
import { CHAR_UNLOCK, CHARACTERS, type Character } from "../characters/roster";
import { ARCANA_TYPES } from "../sim/arcanas";
import { STAGE_TYPES } from "../sim/stages";
import {
  ACHIEVEMENT_TYPES,
  type Achievement,
  achievementContentFaults,
  achievementEarnedLine,
  achievementMet,
  isRunKind,
  type RunFacts,
} from "./achievements";
import { arcanaConditionMetFor, arcanaEarnedLine } from "./arcana-records";
import { stageConditionMet, stageEarnedLine } from "./stage-records";

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

export const AWARD_LIMIT = 16;

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

export function isHeld(save: SaveData, track: number, index: number): boolean {
  const set = setFor(save, track);
  if (set === undefined) return false;
  if (!Number.isSafeInteger(index) || index < 0 || index >= capacityOf(track)) return false;
  return bitGet(set, index);
}

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
    case CHAR_UNLOCK.REAPER_KILL:
      return false;
    default:
      return false;
  }
}

export function seedStarters(save: SaveData, list: readonly Character[] = CHARACTERS): number {
  let written = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].unlock !== CHAR_UNLOCK.ALWAYS) continue;
    if (grant(save, TRACK.CHARACTER, i, list[i].name, "") === AWARD.OK) written++;
  }
  return written;
}

export function earnedLine(character: Character): string {
  switch (character.unlock) {
    case CHAR_UNLOCK.LIFETIME_GOLD:
      return `Earned ${character.unlockValue} gold in total.`;
    case CHAR_UNLOCK.RUNS_COMPLETED:
      return character.unlockValue === 1 ? "Finished a run." : `Finished ${character.unlockValue} runs.`;
    case CHAR_UNLOCK.BEST_SECONDS:
      return `Survived ${Math.floor(character.unlockValue / 60)} minutes in one run.`;
    case CHAR_UNLOCK.REAPER_KILL:
      return "Killed the Reaper.";
    default:
      return "Unlocked.";
  }
}

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
  for (let i = 1; i < STAGE_TYPES.length; i++) {
    if (!stageConditionMet(save, i)) continue;
    const code = grant(save, TRACK.STAGE, i, STAGE_TYPES[i].name, stageEarnedLine(i), report);
    if (code === AWARD.OK) granted++;
  }
  for (let i = 1; i < ARCANA_TYPES.length; i++) {
    if (!arcanaConditionMetFor(save, i)) continue;
    const code = grant(save, TRACK.ARCANA, i, ARCANA_TYPES[i].name, arcanaEarnedLine(i), report);
    if (code === AWARD.OK) granted++;
  }
  return granted;
}

export function sweepAchievements(
  save: SaveData,
  report: AwardReport,
  run: RunFacts | null,
  list: readonly Achievement[] = ACHIEVEMENT_TYPES,
): number {
  let granted = 0;
  for (let i = 0; i < list.length; i++) {
    const achievement = list[i];
    if (run === null && isRunKind(achievement.kind)) continue;
    if (isHeld(save, TRACK.ACHIEVEMENT, i)) continue;
    if (!achievementMet(achievement, save, run)) continue;
    const code = grant(
      save,
      TRACK.ACHIEVEMENT,
      i,
      achievement.name,
      achievementEarnedLine(i),
      report,
    );
    if (code === AWARD.OK) granted++;
  }
  return granted;
}

export function grantReaperKillUnlock(save: SaveData, report: AwardReport): number {
  let granted = 0;
  for (let i = 0; i < CHARACTERS.length; i++) {
    const character = CHARACTERS[i];
    if (character.unlock !== CHAR_UNLOCK.REAPER_KILL) continue;
    const code = grant(save, TRACK.CHARACTER, i, character.name, earnedLine(character), report);
    if (code === AWARD.OK) granted++;
  }
  return granted;
}

export function reportRows(report: AwardReport): number {
  return Math.min(report.count, AWARD_LIMIT);
}

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

  if (ACHIEVEMENT_TYPES.length > capacityOf(TRACK.ACHIEVEMENT)) {
    faults.push(
      `${ACHIEVEMENT_TYPES.length} achievements but the save only stores ${capacityOf(TRACK.ACHIEVEMENT)} bits`,
    );
  }
  for (const fault of achievementContentFaults()) faults.push(fault);

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
