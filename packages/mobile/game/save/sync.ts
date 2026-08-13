/**
 * Merging two copies of one profile — the phone's and the cloud's — into one that loses nothing.
 *
 * WHY A MERGE AND NOT "NEWEST WINS"
 *
 * "Newest wins" is what most games do and it is why people lose progress. The device clock is not evidence
 * (`savedAtUnixSec` is advisory, as the schema says so in its own comment), two phones are often both offline,
 * and a tablet opened once a month is *older* while still holding an unlock the phone never earned. Picking a
 * side means throwing the other side's history away, and a player cannot tell the difference between that and
 * a bug.
 *
 * So this merges. Every field in a profile is one of three shapes, and each shape has exactly one safe rule:
 *
 *   - a promise that only ever grows: unlock bits, achievement bits. Rule: OR the two together.
 *   - a high-water mark: lifetime gold, runs started, runs finished, seconds played, best time, powerup ranks,
 *     mastery levels, ascension tiers. Rule: take the larger.
 *   - a balance that goes down when it is spent: gold. There is no safe max() for this one, which is the whole
 *     difficulty, and it is handled below.
 *
 * Nothing in a profile is a free-form value where two devices could hold different, equally valid answers —
 * except settings, which are handled as a block, also below.
 *
 * WHY GOLD IS RECONSTRUCTED INSTEAD OF COMPARED
 *
 * Taking the larger balance duplicates currency: buy a rank on the phone, sync from the tablet, and the phone
 * gets its money back while keeping the rank. Taking the smaller punishes the player for owning two devices.
 * Both are wrong, so the balance is not merged at all — it is *derived* from two things that are safe to merge:
 *
 *     gold = merged lifetime gold - gold invested in the merged shop ranks
 *
 * Lifetime gold is a high-water mark, and the merged ranks are the merged ranks, so the answer is the balance
 * the player would have if they had done everything on one device. Refunds fit this without a special case,
 * because a refund lowers what is invested and leaves lifetime alone.
 *
 * TWO THINGS THAT WOULD BREAK THAT, WRITTEN DOWN BEFORE THEY HAPPEN:
 *
 *   1. A SECOND GOLD SINK. The shop is the only thing gold is spent on today. The moment gold buys anything
 *      else — a cosmetic, a re-roll, a revive — that spend has to be recorded in the save as its own total and
 *      subtracted here too, or this merge will hand the money back every time a device syncs. `sinkFaults`
 *      exists to make that a loud failure rather than an economy exploit.
 *   2. A SATURATED LIFETIME. Lifetime gold is a u32 and the payout code pins it at the ceiling rather than
 *      wrapping. Once it is pinned, it is no longer a true total and the subtraction above is meaningless. A
 *      profile that far along keeps the larger of the two balances instead, and the report says the balance
 *      was not reconstructed, so a support conversation can tell the two cases apart. Four billion gold is
 *      unreachable in practice; behaving strangely there is fine, behaving *silently* strangely is not.
 *
 * WHY SETTINGS ARE COPIED WHOLE
 *
 * Settings are the one part of a profile where merging field by field produces a state neither device chose:
 * the phone's joystick position with the tablet's HUD scale is a layout nobody laid out. So the settings block
 * is taken whole from one side — the one with the higher generation counter, which is the closest thing to
 * "the copy that was written more recently" that does not trust a clock. Ties go to the local side, because
 * the player is holding that device right now.
 *
 * WHY THE RESULT IS A THIRD PROFILE
 *
 * Neither input is written to. A merge that failed halfway through the local save would leave a player with a
 * profile that is part theirs and part somebody else's, and there is no way back from that. The caller writes
 * the result only after the report says `SYNC.OK`, which is the same rule the codec follows when it migrates a
 * v1 slot forward rather than in place.
 */

import { bitCount, SAVE_LIMITS, SAVE_VERSION, type SaveData, type SaveSettings } from "./schema";
import { U32_MAX } from "./payout";
import { POWERUPS, spentOn, totalInvested } from "../shop/powerups";

/** Why a merge was refused. A refused merge writes nothing anywhere. */
export const SYNC = {
  OK: 0,
  /** A field on the local copy is not a whole, non-negative, in-range number. */
  BAD_LOCAL: 1,
  /** Same, on the incoming copy. */
  BAD_REMOTE: 2,
  /** A bitset or level array is the wrong length, so a position would mean two different things. */
  SIZE_MISMATCH: 3,
  /** One side was written by a newer build than this one understands. */
  VERSION_TOO_NEW: 4,
  /** The destination profile is not shaped like a profile this build writes. */
  BAD_DESTINATION: 5,
} as const;

export type SyncCode = (typeof SYNC)[keyof typeof SYNC];

export const SYNC_NAMES: Readonly<Record<SyncCode, string>> = {
  [SYNC.OK]: "merged",
  [SYNC.BAD_LOCAL]: "this device's save has a value that cannot be trusted",
  [SYNC.BAD_REMOTE]: "the cloud save has a value that cannot be trusted",
  [SYNC.SIZE_MISMATCH]: "the two saves do not agree on how long a list is",
  [SYNC.VERSION_TOO_NEW]: "one save was written by a newer version of the game",
  [SYNC.BAD_DESTINATION]: "the profile being written into is the wrong shape",
};

export function describeSync(code: number): string {
  return SYNC_NAMES[code as SyncCode] ?? `unknown sync code ${code}`;
}

/**
 * What a merge did, in numbers a support screen can print.
 *
 * Reused between merges, so `reset` wipes every field: a stale figure sitting behind a refusal is the bug the
 * payout receipt already had once, and it is not being repeated here.
 */
export interface MergeReport {
  code: SyncCode;
  /** Which field was refused. Empty when the merge succeeded. */
  badField: string;
  /** True when gold was derived from lifetime minus invested; false when the ceiling forced a fallback. */
  goldReconstructed: boolean;
  goldLocal: number;
  goldRemote: number;
  goldMerged: number;
  invested: number;
  unlocksLocal: number;
  unlocksRemote: number;
  unlocksMerged: number;
  /** How many unlock bits the merged profile has that this device did not. The interesting number. */
  unlocksGained: number;
  /** Whose settings block was used. */
  settingsFrom: "local" | "remote";
  generation: number;
}

export function createMergeReport(): MergeReport {
  return {
    code: SYNC.OK,
    badField: "",
    goldReconstructed: false,
    goldLocal: 0,
    goldRemote: 0,
    goldMerged: 0,
    invested: 0,
    unlocksLocal: 0,
    unlocksRemote: 0,
    unlocksMerged: 0,
    unlocksGained: 0,
    settingsFrom: "local",
    generation: 0,
  };
}

export function resetMergeReport(report: MergeReport): void {
  report.code = SYNC.OK;
  report.badField = "";
  report.goldReconstructed = false;
  report.goldLocal = 0;
  report.goldRemote = 0;
  report.goldMerged = 0;
  report.invested = 0;
  report.unlocksLocal = 0;
  report.unlocksRemote = 0;
  report.unlocksMerged = 0;
  report.unlocksGained = 0;
  report.settingsFrom = "local";
  report.generation = 0;
}

/* ---- validation --------------------------------------------------------------------------------- */

/** Every counter a merge reads, with the field name it would be refused under. */
const COUNTERS = [
  "gold",
  "goldLifetime",
  "runsStarted",
  "runsCompleted",
  "secondsPlayed",
  "bestSurvivalSeconds",
  "everTainted",
  "generation",
] as const;

/**
 * Is a profile safe to merge?
 *
 * Returns the offending field name, or an empty string. Checked before anything is written, because a merge
 * that discovers a bad number halfway through has already corrupted its destination. `NaN`, a fraction and a
 * negative are all rejected the same way: a number nobody can explain must not become progress.
 */
export function faultIn(save: SaveData): string {
  for (const field of COUNTERS) {
    const value = save[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) return field;
  }
  if (save.unlockedCharacters.length !== SAVE_LIMITS.characterBytes) return "unlockedCharacters";
  if (save.unlockedWeapons.length !== SAVE_LIMITS.weaponBytes) return "unlockedWeapons";
  if (save.unlockedStages.length !== SAVE_LIMITS.stageBytes) return "unlockedStages";
  if (save.unlockedArcanas.length !== SAVE_LIMITS.arcanaBytes) return "unlockedArcanas";
  if (save.achievements.length !== SAVE_LIMITS.achievementBytes) return "achievements";
  if (save.powerUpLevels.length !== SAVE_LIMITS.powerUpCount) return "powerUpLevels";
  if (save.masteryLevels.length !== SAVE_LIMITS.masteryCount) return "masteryLevels";
  if (save.ascensionTiers.length !== SAVE_LIMITS.ascensionCount) return "ascensionTiers";
  return "";
}

/* ---- the merge ---------------------------------------------------------------------------------- */

/** OR two bitsets into a destination. Lengths are equal by the time this runs — `faultIn` saw to that. */
function orInto(out: Uint8Array, a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < out.length; i++) out[i] = (a[i] as number) | (b[i] as number);
}

/** Take the larger of two byte arrays, position by position. Levels only ever go up. */
function maxIntoBytes(out: Uint8Array, a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < out.length; i++) {
    const left = a[i] as number;
    const right = b[i] as number;
    out[i] = left > right ? left : right;
  }
}

function maxIntoWords(out: Uint16Array, a: Uint16Array, b: Uint16Array): void {
  for (let i = 0; i < out.length; i++) {
    const left = a[i] as number;
    const right = b[i] as number;
    out[i] = left > right ? left : right;
  }
}

function copySettings(from: SaveSettings, into: SaveSettings): void {
  for (const key of Object.keys(from) as (keyof SaveSettings)[]) {
    // Settings are flat numbers and booleans by design; a nested value here would need its own rule.
    (into as unknown as Record<string, unknown>)[key as string] = from[key];
  }
}

/** Cap at the currency ceiling rather than wrapping. Wrapping a total turns a rich player into a poor one. */
function capped(value: number): number {
  return value > U32_MAX ? U32_MAX : value;
}

/**
 * Merge `local` and `remote` into `out`, and describe what happened in `report`.
 *
 * `out` may be the same object as neither input; passing one of the inputs as the destination is refused,
 * because the merge reads both sides throughout and a destination that is also a source would answer with
 * half-merged values. Returns the code, which is also on the report.
 */
export function mergeSaves(local: SaveData, remote: SaveData, out: SaveData, report: MergeReport): SyncCode {
  resetMergeReport(report);

  if (out === local || out === remote) {
    report.code = SYNC.BAD_DESTINATION;
    report.badField = "out";
    return report.code;
  }

  if (local.version > SAVE_VERSION || remote.version > SAVE_VERSION) {
    report.code = SYNC.VERSION_TOO_NEW;
    report.badField = local.version > SAVE_VERSION ? "local.version" : "remote.version";
    return report.code;
  }

  const localFault = faultIn(local);
  if (localFault !== "") {
    report.code = SYNC.BAD_LOCAL;
    report.badField = localFault;
    return report.code;
  }
  const remoteFault = faultIn(remote);
  if (remoteFault !== "") {
    report.code = SYNC.BAD_REMOTE;
    report.badField = remoteFault;
    return report.code;
  }
  const outFault = faultIn(out);
  if (outFault !== "") {
    report.code = SYNC.BAD_DESTINATION;
    report.badField = outFault;
    return report.code;
  }

  /* Promises: union. */
  orInto(out.unlockedCharacters, local.unlockedCharacters, remote.unlockedCharacters);
  orInto(out.unlockedWeapons, local.unlockedWeapons, remote.unlockedWeapons);
  orInto(out.unlockedStages, local.unlockedStages, remote.unlockedStages);
  orInto(out.unlockedArcanas, local.unlockedArcanas, remote.unlockedArcanas);
  orInto(out.achievements, local.achievements, remote.achievements);

  /* High-water marks. */
  maxIntoBytes(out.powerUpLevels, local.powerUpLevels, remote.powerUpLevels);
  maxIntoBytes(out.masteryLevels, local.masteryLevels, remote.masteryLevels);
  maxIntoWords(out.ascensionTiers, local.ascensionTiers, remote.ascensionTiers);

  out.goldLifetime = capped(Math.max(local.goldLifetime, remote.goldLifetime));
  out.runsStarted = capped(Math.max(local.runsStarted, remote.runsStarted));
  out.runsCompleted = capped(Math.max(local.runsCompleted, remote.runsCompleted));
  out.secondsPlayed = capped(Math.max(local.secondsPlayed, remote.secondsPlayed));
  out.bestSurvivalSeconds = capped(Math.max(local.bestSurvivalSeconds, remote.bestSurvivalSeconds));

  /* Taint is informational and only ever accumulates, so it unions like a bitset. */
  out.everTainted = (local.everTainted | remote.everTainted) >>> 0;

  /* The balance. See the file header for why this is not a max(). */
  report.goldLocal = local.gold;
  report.goldRemote = remote.gold;
  const invested = totalInvested(out);
  report.invested = invested;
  if (out.goldLifetime >= U32_MAX) {
    // Lifetime is pinned at the ceiling, so it is no longer a total and the subtraction means nothing.
    out.gold = Math.max(local.gold, remote.gold);
    report.goldReconstructed = false;
  } else {
    out.gold = Math.max(0, out.goldLifetime - invested);
    report.goldReconstructed = true;
  }
  report.goldMerged = out.gold;

  /* Identity and bookkeeping. */
  out.version = SAVE_VERSION;
  out.contentVersion = Math.max(local.contentVersion, remote.contentVersion);
  out.buildId = local.generation >= remote.generation ? local.buildId : remote.buildId;
  out.savedAtUnixSec = Math.max(local.savedAtUnixSec, remote.savedAtUnixSec);

  /**
   * The merged copy has to outrank both inputs or the slot loader would keep choosing an unmerged one, and
   * the same merge would happen again on every launch.
   */
  out.generation = capped(Math.max(local.generation, remote.generation) + 1);
  report.generation = out.generation;

  const takeLocal = local.generation >= remote.generation;
  copySettings(takeLocal ? local.settings : remote.settings, out.settings);
  report.settingsFrom = takeLocal ? "local" : "remote";

  report.unlocksLocal = unlockBits(local);
  report.unlocksRemote = unlockBits(remote);
  report.unlocksMerged = unlockBits(out);
  report.unlocksGained = report.unlocksMerged - report.unlocksLocal;

  report.code = SYNC.OK;
  return report.code;
}

/** Every unlock and achievement bit a profile holds. The one number that says "how much have I got". */
export function unlockBits(save: SaveData): number {
  return (
    bitCount(save.unlockedCharacters) +
    bitCount(save.unlockedWeapons) +
    bitCount(save.unlockedStages) +
    bitCount(save.unlockedArcanas) +
    bitCount(save.achievements)
  );
}

/**
 * Would a merge lose anything the local copy has? Answers before the merge runs, for the "sync?" prompt.
 *
 * The only thing a merge can lower is the balance — everything else is a union or a maximum — so this is
 * really "will the player see less gold afterwards", which is the one thing worth warning about.
 */
export function goldWouldDrop(local: SaveData, remote: SaveData): boolean {
  const lifetime = Math.max(local.goldLifetime, remote.goldLifetime);
  if (lifetime >= U32_MAX) return false;
  let invested = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const rank = Math.max(local.powerUpLevels[i] ?? 0, remote.powerUpLevels[i] ?? 0);
    if (rank > 0) invested += spentOn(POWERUPS[i], rank);
  }
  return Math.max(0, lifetime - invested) < local.gold;
}

/**
 * Self-check for the assumption the balance rule stands on: the shop is the only place gold goes.
 *
 * Prints at import. If a second sink is ever added, whoever adds it has to add its total to the save and to
 * `mergeSaves`, and this is the note that will be waiting for them.
 */
export function sinkFaults(): readonly string[] {
  const faults: string[] = [];
  if (POWERUPS.length > SAVE_LIMITS.powerUpCount) {
    faults.push(`${POWERUPS.length} powerups but the save stores ${SAVE_LIMITS.powerUpCount} ranks`);
  }
  for (const power of POWERUPS) {
    if (!Number.isSafeInteger(power.baseCost) || power.baseCost <= 0) {
      faults.push(`${power.id} has no price, so gold spent on it cannot be reconstructed`);
    }
    if (!Number.isSafeInteger(power.accel) || power.accel < 0) {
      faults.push(`${power.id} has a price curve of ${power.accel}, which no merge can undo`);
    }
  }
  return faults;
}

for (const fault of sinkFaults()) {
  console.error(`sync sink fault: ${fault}`);
}
