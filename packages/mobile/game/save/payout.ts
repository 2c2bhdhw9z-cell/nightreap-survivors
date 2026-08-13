/**
 * Banking a finished run into the profile.
 *
 * WHY THIS IS ITS OWN FILE
 * `results.ts` decides what a run *was*; the save store decides how bytes reach the disk. Neither should
 * decide what a run *earns*, because that answer is read by three different things that must agree: the
 * results screen the player is looking at, the numbers the shop will spend, and the server's replay
 * revalidation. One function, one receipt, everybody reads the receipt.
 *
 * WHY EVERY FIELD IS CLAMPED TO u32
 * The save writes these with `setUint32`, so a total past 4,294,967,295 does not error — it silently
 * wraps to nearly nothing. A player with a huge lifetime total would open the game to find their gold
 * reset, and nothing in the save would show why. So the ceiling is enforced *here*, in daylight, and the
 * receipt says out loud when a total was pinned at the top rather than added to.
 *
 * WHY A REFUSAL RATHER THAN A REPAIR
 * A delta carrying a negative or fractional or non-finite number is a bug upstream, not a rounding
 * question. Repairing it quietly would bank a wrong number and destroy the evidence; the save is the one
 * place in the game where a plausible wrong answer is worse than a visible refusal. So a bad delta banks
 * nothing at all and says which field was bad.
 *
 * WHY BANKING IS ALL-OR-NOTHING
 * Half a payout is unexplainable: gold up but the run not counted, or time counted twice. The save is
 * only touched after every field has been checked and every new total computed, so a refusal leaves the
 * profile byte-identical.
 *
 * WHY IDEMPOTENCE IS THE CALLER'S JOB, STATED HERE
 * There is no "already banked this run" field in the save layout, and adding one would be a codec change.
 * So the rule lives at the door instead: `bankRun` is called exactly once per run, by the results screen,
 * before it navigates away. `PayoutReceipt.banked` exists so a screen that re-renders can tell whether it
 * has already paid without calling again.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * It does not write to storage, does not bump `generation`, does not touch unlocks, and does not decide
 * ladder eligibility. It mutates a `SaveData` in memory and hands back a receipt; persisting is the
 * store's job, and one save write per run end is the store's rule, not this file's.
 */

import type { ProfileDelta } from "../sim/results";
import type { SaveData } from "./schema";

/**
 * The ceiling every banked total shares, because the codec writes all of them as u32.
 *
 * Deliberately the true type limit rather than a friendlier round number: a cap exists to stop a silent
 * wrap, and inventing a lower one would take gold away from a player who genuinely earned it.
 */
export const U32_MAX = 4294967295;

/** Why a payout was refused. Append-only: the numbers reach bug reports. */
export const PAYOUT = {
  /** Banked. */
  OK: 0,
  /** A field was negative. Runs do not take gold away. */
  NEGATIVE: 1,
  /** A field was fractional. Currency and seconds are whole here. */
  FRACTIONAL: 2,
  /** A field was NaN or Infinity. */
  NOT_FINITE: 3,
  /** A field was larger than the ceiling before any addition. */
  ABSURD: 4,
  /** The profile itself already held an impossible value, so adding to it is meaningless. */
  BAD_PROFILE: 5,
} as const;

export type PayoutCode = (typeof PAYOUT)[keyof typeof PAYOUT];

export const PAYOUT_NAMES: readonly string[] = [
  "OK",
  "NEGATIVE",
  "FRACTIONAL",
  "NOT_FINITE",
  "ABSURD",
  "BAD_PROFILE",
];

export function describePayout(code: number): string {
  return PAYOUT_NAMES[code] ?? "UNKNOWN";
}

/**
 * What the payout did, in the terms the screen shows.
 *
 * The screen reads every number from here rather than recomputing any of it, so "the screen said 340 gold
 * but the shop has 338" cannot happen. `goldBefore`/`goldAfter` are both present because the payout screen
 * counts up from one to the other, and a screen that has to subtract to find its own start drifts.
 */
export interface PayoutReceipt {
  code: PayoutCode;
  /** Which field caused a refusal. Empty when banked. */
  badField: string;
  /** True only when the profile was actually changed. */
  banked: boolean;

  goldEarned: number;
  goldBefore: number;
  goldAfter: number;
  goldLifetimeAfter: number;

  /** True when a total hit the ceiling and could not take the whole earning. */
  goldCapped: boolean;
  lifetimeCapped: boolean;
  timeCapped: boolean;

  /** True when this run set a new best survival time. */
  newBestTime: boolean;
  bestSecondsBefore: number;
  bestSecondsAfter: number;

  runsStartedAfter: number;
  runsCompletedAfter: number;
  secondsPlayedAfter: number;
}

export function createPayoutReceipt(): PayoutReceipt {
  return {
    code: PAYOUT.OK,
    badField: "",
    banked: false,
    goldEarned: 0,
    goldBefore: 0,
    goldAfter: 0,
    goldLifetimeAfter: 0,
    goldCapped: false,
    lifetimeCapped: false,
    timeCapped: false,
    newBestTime: false,
    bestSecondsBefore: 0,
    bestSecondsAfter: 0,
    runsStartedAfter: 0,
    runsCompletedAfter: 0,
    secondsPlayedAfter: 0,
  };
}

/** Reset a receipt to refuse, without having touched the save. */
function refuse(out: PayoutReceipt, code: PayoutCode, field: string): PayoutReceipt {
  out.code = code;
  out.badField = field;
  out.banked = false;
  return out;
}

/**
 * A whole, finite, non-negative number no larger than the ceiling.
 *
 * Order matters: finiteness is tested before wholeness, because `Number.isInteger(NaN)` is false and
 * would otherwise report a NaN as "fractional", sending a bug report down the wrong path.
 */
function faultIn(value: number): PayoutCode {
  if (!Number.isFinite(value)) return PAYOUT.NOT_FINITE;
  if (value < 0) return PAYOUT.NEGATIVE;
  if (!Number.isInteger(value)) return PAYOUT.FRACTIONAL;
  if (value > U32_MAX) return PAYOUT.ABSURD;
  return PAYOUT.OK;
}

/** Add without wrapping. Reports whether the ceiling swallowed part of the addition. */
function addCapped(base: number, add: number): { total: number; capped: boolean } {
  const sum = base + add;
  if (sum > U32_MAX) return { total: U32_MAX, capped: true };
  return { total: sum, capped: false };
}

/** The delta fields that must each be a sane whole number, named for the receipt. */
const DELTA_FIELDS: readonly (keyof ProfileDelta)[] = [
  "gold",
  "runsStarted",
  "runsCompleted",
  "secondsPlayed",
  "bestSurvivalSeconds",
];

/** The profile fields banking adds to. Checked before use: garbage in the save poisons the sum. */
const PROFILE_FIELDS: readonly (keyof SaveData)[] = [
  "gold",
  "goldLifetime",
  "runsStarted",
  "runsCompleted",
  "secondsPlayed",
  "bestSurvivalSeconds",
];

/**
 * Bank a finished run into the profile in memory.
 *
 * On `PAYOUT.OK` the save has been changed and `banked` is true. On anything else the save is untouched
 * and `badField` names what was wrong. The caller persists the save; this never does.
 */
export function bankRun(save: SaveData, delta: ProfileDelta, out: PayoutReceipt): PayoutReceipt {
  out.badField = "";
  out.banked = false;
  out.goldCapped = false;
  out.lifetimeCapped = false;
  out.timeCapped = false;
  out.newBestTime = false;

  // Check the incoming run first: it is the thing most likely to be wrong.
  for (let i = 0; i < DELTA_FIELDS.length; i++) {
    const name = DELTA_FIELDS[i];
    const fault = faultIn(delta[name]);
    if (fault !== PAYOUT.OK) return refuse(out, fault, String(name));
  }

  // Then the profile being added to. A save that already holds nonsense cannot be extended sensibly, and
  // pretending otherwise turns one corrupt field into a corrupt total.
  for (let i = 0; i < PROFILE_FIELDS.length; i++) {
    const name = PROFILE_FIELDS[i];
    const value = save[name] as number;
    if (faultIn(value) !== PAYOUT.OK) return refuse(out, PAYOUT.BAD_PROFILE, String(name));
  }

  // `everTainted` is a bitfield rather than a total, so it gets its own check and an OR below.
  if (faultIn(save.everTainted) !== PAYOUT.OK) {
    return refuse(out, PAYOUT.BAD_PROFILE, "everTainted");
  }
  if (faultIn(delta.everTainted) !== PAYOUT.OK) {
    return refuse(out, faultIn(delta.everTainted), "everTainted");
  }

  // Everything is sane. Compute every new total before writing any of them, so a surprise cannot leave
  // the profile half-paid.
  const goldBefore = save.gold;
  const gold = addCapped(goldBefore, delta.gold);
  const lifetime = addCapped(save.goldLifetime, delta.gold);
  const started = addCapped(save.runsStarted, delta.runsStarted);
  const completed = addCapped(save.runsCompleted, delta.runsCompleted);
  const seconds = addCapped(save.secondsPlayed, delta.secondsPlayed);

  // Best time is a high-water mark, not a total. Strictly greater, so replaying the same run does not
  // announce a new record.
  const bestBefore = save.bestSurvivalSeconds;
  const beatIt = delta.bestSurvivalSeconds > bestBefore;
  const bestAfter = beatIt ? delta.bestSurvivalSeconds : bestBefore;

  save.gold = gold.total;
  save.goldLifetime = lifetime.total;
  save.runsStarted = started.total;
  save.runsCompleted = completed.total;
  save.secondsPlayed = seconds.total;
  save.bestSurvivalSeconds = bestAfter;
  // Taint accumulates and never clears: it describes the profile's history, not its current state.
  save.everTainted = (save.everTainted | delta.everTainted) >>> 0;

  out.code = PAYOUT.OK;
  out.banked = true;
  out.goldEarned = delta.gold;
  out.goldBefore = goldBefore;
  out.goldAfter = gold.total;
  out.goldLifetimeAfter = lifetime.total;
  out.goldCapped = gold.capped;
  out.lifetimeCapped = lifetime.capped;
  out.timeCapped = seconds.capped;
  out.newBestTime = beatIt;
  out.bestSecondsBefore = bestBefore;
  out.bestSecondsAfter = bestAfter;
  out.runsStartedAfter = started.total;
  out.runsCompletedAfter = completed.total;
  out.secondsPlayedAfter = seconds.total;
  return out;
}

/**
 * Seconds as `M:SS`, or `H:MM:SS` past an hour.
 *
 * Lives here rather than in the screen because the results screen, the records list and a co-op end panel
 * must not disagree about whether 90 seconds is "1:30" or "90s".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.trunc(seconds);
  const hours = Math.trunc(whole / 3600);
  const minutes = Math.trunc((whole % 3600) / 60);
  const secs = whole % 60;
  const two = (n: number): string => (n < 10 ? `0${n}` : String(n));
  if (hours > 0) return `${hours}:${two(minutes)}:${two(secs)}`;
  return `${minutes}:${two(secs)}`;
}

/**
 * Gold with thousands separators, grouped from the right.
 *
 * Hand-rolled rather than `toLocaleString` on purpose: the locale build of Hermes is not guaranteed on
 * every Android device we target, and a currency that renders differently on two phones is a support
 * ticket.
 */
export function formatGold(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  const whole = Math.trunc(Math.abs(amount));
  const sign = amount < 0 ? "-" : "";
  const digits = String(whole);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const fromRight = digits.length - i;
    out += digits[i];
    if (fromRight > 1 && fromRight % 3 === 1) out += ",";
  }
  return sign + out;
}
