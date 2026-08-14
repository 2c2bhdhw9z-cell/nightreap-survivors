/**
 * Anti-cheat v1 — judging a run that arrived from a phone.
 *
 * A submitted run is two things stapled together: an input log, which is evidence, and a claimed
 * result, which is an assertion. This file is the part that never trusts the second one.
 *
 * THE TWO KINDS OF "NO", AND WHY THEY ARE NOT THE SAME THING
 *
 * A **refusal** is structural. It means the thing that arrived is not a run log at all, or is a run log
 * that does not match the result attached to it: wrong magic bytes, a truncated stream, a header that
 * claims more ticks than the stream can supply, a claimed seed that is not the seed the log was played
 * on. There is no judgement in a refusal and no threshold to argue about — the submission contradicts
 * itself, so there is nothing to store a verdict about.
 *
 * A **flag** is an opinion. It means the log is a real log, and the numbers attached to it are further
 * outside what the game can produce than anything honest should be. A flag never refuses anything, never
 * takes anything away, and never punishes anybody. It is a row in the event log that puts a run in front
 * of a person. The reason is simple: every threshold in here is a guess about the ceiling of a game that
 * is still being balanced, and a guess that can ban people is a guess that will ban honest players. The
 * only thing allowed to punish is an operator pressing a button, and that already leaves its own row.
 *
 * WHY THE THRESHOLDS CARRY A VERSION
 *
 * Every verdict records `SUBMIT_LIMITS_VERSION`. Balance passes move ceilings, and a ceiling that moves
 * without a version stamp means last month's runs quietly become "cheating" the day a weapon is nerfed —
 * or worse, this month's cheating quietly becomes fine. A stored verdict says which rulebook judged it,
 * so a rulebook change is a new judgement rather than a rewrite of an old one.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not re-simulate the run. Re-playing an input log tick for tick is the only way to *prove* a
 * result, and it needs the exact build the run was played on; that is a job with an archive behind it,
 * scheduled with the ladder, not something done inline while a phone waits. What it does do is keep every
 * fact that job will need — seed, stage, content version, build id, tick count, final state hash — so the
 * proof can be run later against a log nobody has been able to edit in the meantime.
 *
 * It also holds no opinion about *who* submitted. Identity is the route's problem.
 */

import {
  MAX_REPLAY_PLAYERS,
  REPLAY_ERROR,
  isLadderEligible,
} from "../../../../mobile/game/replay/format";
import { decodeReplay } from "../../../../mobile/game/replay/recorder";

/* ---------------------------------------------------------------------------------------------- */
/* Rulebook version                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Which set of ceilings judged a run. Bumped whenever any threshold below moves.
 *
 * Stored with every verdict. See the note at the top: this is what stops a balance pass from rewriting
 * history in either direction.
 */
export const SUBMIT_LIMITS_VERSION = 1;

/** Ticks per second the simulation runs at. Duplicated deliberately — see `submission.test.ts`. */
export const TICKS_PER_SECOND = 60;

/* ---------------------------------------------------------------------------------------------- */
/* Refusals — structural, never a judgement                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Why a submission was not stored as a run.
 *
 * APPEND ONLY, and the numbers are permanent: they end up in event rows and in operator screens, and
 * renumbering them would silently change what old rows mean.
 */
export const REFUSE_RUN = {
  NONE: 0,
  /** Nothing arrived, or a log with no bytes in it. */
  EMPTY: 1,
  /** Larger than any real run can be. Refused before it is parsed, not after. */
  TOO_LARGE: 2,
  /** Not a Nightreap replay at all. */
  NOT_A_REPLAY: 3,
  /** A replay format this server does not read. */
  WRONG_VERSION: 4,
  /** Ends mid-record, or the stream does not divide into whole records. */
  TRUNCATED: 5,
  /** The header claims a number of ticks the input stream cannot supply. */
  TICKS_DISAGREE: 6,
  /** A party size the game cannot have had. */
  BAD_PLAYER_COUNT: 7,
  /** A log of no length. There is nothing to judge and nothing to replay. */
  NO_TICKS: 8,
  /** Longer than the longest run anybody can sit through. An absurdity guard, not a balance rule. */
  TOO_LONG: 9,
  /** The result does not describe this log: different seed, stage, duration, party or dev-menu marks. */
  CLAIM_DISAGREES: 10,
  /** A run that is still running, or an ending this build does not have. */
  BAD_ENDING: 11,
  /** A content version of zero. Every real build stamps one. */
  NO_CONTENT_VERSION: 12,
  /** A negative or non-whole number where a count belongs. */
  BAD_CLAIM_SHAPE: 13,
} as const;

export type RunRefusal = (typeof REFUSE_RUN)[keyof typeof REFUSE_RUN];

export const REFUSE_RUN_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(REFUSE_RUN).map(([name, id]) => [id, name])),
);

export function describeRefusal(code: number): string {
  switch (code) {
    case REFUSE_RUN.NONE:
      return "accepted";
    case REFUSE_RUN.EMPTY:
      return "nothing was uploaded";
    case REFUSE_RUN.TOO_LARGE:
      return "bigger than any real run";
    case REFUSE_RUN.NOT_A_REPLAY:
      return "not a Nightreap run log";
    case REFUSE_RUN.WRONG_VERSION:
      return "a run log format this server does not read";
    case REFUSE_RUN.TRUNCATED:
      return "the run log is cut short";
    case REFUSE_RUN.TICKS_DISAGREE:
      return "the log claims more time than it contains";
    case REFUSE_RUN.BAD_PLAYER_COUNT:
      return "an impossible party size";
    case REFUSE_RUN.NO_TICKS:
      return "a run of no length";
    case REFUSE_RUN.TOO_LONG:
      return "longer than any run can be";
    case REFUSE_RUN.CLAIM_DISAGREES:
      return "the result does not match the log it came with";
    case REFUSE_RUN.BAD_ENDING:
      return "a run that has not ended";
    case REFUSE_RUN.NO_CONTENT_VERSION:
      return "no content version";
    case REFUSE_RUN.BAD_CLAIM_SHAPE:
      return "a result with impossible numbers in it";
    default:
      return `unknown refusal ${code}`;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Flags — opinions, advisory, never a punishment                                                  */
/* ---------------------------------------------------------------------------------------------- */

/** Why a run is worth a person looking at it. APPEND ONLY; the numbers are stored. */
export const RUN_FLAG = {
  /** More kills than the crowd can supply in the time played. */
  KILL_RATE: 1,
  /** More damage per second than every weapon in the game at once can deal. */
  DAMAGE_RATE: 2,
  /** More coins per minute than the floor pays out. */
  GOLD_RATE: 3,
  /** More experience per minute than the crowd can drop. */
  XP_RATE: 4,
  /** A level higher than the time played can pay for. */
  LEVEL_FOR_TIME: 5,
  /** Coins earned in a run that killed nothing and broke nothing. */
  GOLD_WITHOUT_KILLS: 6,
  /** A long run without taking a single hit, on a build with no godmode marks. */
  NEVER_TOUCHED: 7,
  /** A long run whose input log barely changes — a finger that never moved, or something holding it. */
  STOOD_STILL: 8,
  /** Started in the future according to this server's clock. Usually a wrong phone clock. */
  CLOCK_AHEAD: 9,
  /** Dev-menu marks are set. Known, expected, and not ladder-legal — recorded, never punished. */
  DEV_MARKS: 10,
  /** Claimed more card picks than card screens, or picks without screens. */
  PICKS_WITHOUT_SCREENS: 11,
  /** The damage breakdown does not add up to the damage claimed. */
  DAMAGE_BREAKDOWN: 12,
} as const;

export type RunFlag = (typeof RUN_FLAG)[keyof typeof RUN_FLAG];

export const RUN_FLAG_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(RUN_FLAG).map(([name, id]) => [id, name])),
);

export function describeFlag(code: number): string {
  switch (code) {
    case RUN_FLAG.KILL_RATE:
      return "killed faster than the crowd arrives";
    case RUN_FLAG.DAMAGE_RATE:
      return "dealt more damage per second than the game can";
    case RUN_FLAG.GOLD_RATE:
      return "earned coins faster than the floor pays";
    case RUN_FLAG.XP_RATE:
      return "earned experience faster than the crowd drops it";
    case RUN_FLAG.LEVEL_FOR_TIME:
      return "reached a level the clock cannot pay for";
    case RUN_FLAG.GOLD_WITHOUT_KILLS:
      return "earned coins without killing anything";
    case RUN_FLAG.NEVER_TOUCHED:
      return "was never hit once in a long run";
    case RUN_FLAG.STOOD_STILL:
      return "barely moved for the whole run";
    case RUN_FLAG.CLOCK_AHEAD:
      return "was started in the future";
    case RUN_FLAG.DEV_MARKS:
      return "carries dev-menu marks";
    case RUN_FLAG.PICKS_WITHOUT_SCREENS:
      return "took more upgrades than it was offered";
    case RUN_FLAG.DAMAGE_BREAKDOWN:
      return "a damage breakdown that does not add up";
    default:
      return `unknown flag ${code}`;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Ceilings                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The ceilings, all per second or per minute of *logged* time — never of claimed time.
 *
 * Every one is set well above what the game can actually produce, on purpose. These are not balance
 * numbers and they are not meant to catch somebody who is 15% ahead of the curve; they are meant to
 * catch a value that could not have come out of the simulation at all. A tight threshold here does not
 * catch more cheats, it catches more good players.
 */
export const CEILING = {
  /** Kills per second. The crowd cap is a few hundred on screen and they do not respawn instantly. */
  KILLS_PER_SECOND: 120,
  /** Damage per second across the whole party. */
  DAMAGE_PER_SECOND: 2_000_000,
  /** Coins per minute. */
  GOLD_PER_MINUTE: 20_000,
  /** Experience per minute. */
  XP_PER_MINUTE: 400_000,
  /** Levels per minute of play, plus the allowance below. */
  LEVELS_PER_MINUTE: 12,
  /** Levels a run may reach regardless of length, so a one-minute run is not flagged for level 5. */
  LEVEL_ALLOWANCE: 10,
  /** A run this long with no damage taken is worth a look. */
  UNTOUCHED_SECONDS: 600,
  /** A run this long whose input log holds fewer records than the floor below is worth a look. */
  STILLNESS_SECONDS: 300,
  /** Input records per minute under which a long run counts as "barely moved". */
  RECORDS_PER_MINUTE_FLOOR: 30,
  /** How far ahead of this server a phone's clock may be before it is worth noting, in seconds. */
  CLOCK_AHEAD_SECONDS: 900,
  /** Permille the weapon breakdown may miss the claimed total by before it is worth a look. */
  BREAKDOWN_SLACK_PERMILLE: 50,
} as const;

/** Nothing bigger than this is parsed. Worst case is a four-player half-hour with input every tick. */
export const MAX_SUBMISSION_BYTES = 4 * 1024 * 1024;

/** An absurdity guard, not a mode rule: eight hours of ticks. */
export const MAX_RUN_TICKS = TICKS_PER_SECOND * 60 * 60 * 8;

/** How many distinct flags one verdict can carry. */
export const MAX_RUN_FLAGS = 16;

/* ---------------------------------------------------------------------------------------------- */
/* The claim                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the phone says happened. Every field here is an assertion, and the ones that can be read out of
 * the log are checked against it rather than believed.
 */
export interface RunClaim {
  end: number;
  ticks: number;
  seed: number;
  stageId: number;
  playerCount: number;
  tainted: number;
  levelReached: number;
  totalXp: number;
  gold: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  screensShown: number;
  picksMade: number;
  /** Per-weapon damage, highest first. May be empty; a run can end before a weapon fires. */
  weaponDamage: readonly number[];
}

/** Endings a submitted run may claim. `running` is not one of them. */
export const CLAIMABLE_END = { defeat: 1, survival: 2, quit: 3, whiteHand: 4 } as const;

/* ---------------------------------------------------------------------------------------------- */
/* The verdict                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** Everything worth storing about one submission. Fixed shape: a refused run still gets a row. */
export interface RunVerdict {
  refusal: number;
  limitsVersion: number;
  /** Ticks read out of the log, not out of the claim. 0 when refused before parsing. */
  ticks: number;
  seconds: number;
  seed: number;
  stageId: number;
  playerCount: number;
  tainted: number;
  contentVersion: number;
  buildId: number;
  startedAtUnixSec: number;
  finalStateHash: number;
  /** How many run-length records the input stream holds. A cheap shape measure of how much was played. */
  inputRecords: number;
  flags: number[];
  /** True when nothing in the log bars it from a leaderboard. Independent of flags. */
  ladderEligible: boolean;
}

export function emptyVerdict(): RunVerdict {
  return {
    refusal: REFUSE_RUN.NONE,
    limitsVersion: SUBMIT_LIMITS_VERSION,
    ticks: 0,
    seconds: 0,
    seed: 0,
    stageId: 0,
    playerCount: 0,
    tainted: 0,
    contentVersion: 0,
    buildId: 0,
    startedAtUnixSec: 0,
    finalStateHash: 0,
    inputRecords: 0,
    flags: [],
    ladderEligible: false,
  };
}

function refuse(reason: RunRefusal, v: RunVerdict): RunVerdict {
  v.refusal = reason;
  // A refused submission carries no flags. Flags are opinions about a run, and there is no run here.
  v.flags = [];
  v.ladderEligible = false;
  return v;
}

/** Structural refusal for a decode failure, mapped one for one so nothing collapses into "bad log". */
function refusalForDecode(error: number): RunRefusal {
  switch (error) {
    case REPLAY_ERROR.BAD_MAGIC:
      return REFUSE_RUN.NOT_A_REPLAY;
    case REPLAY_ERROR.VERSION_MISMATCH:
      return REFUSE_RUN.WRONG_VERSION;
    case REPLAY_ERROR.TICK_COUNT_MISMATCH:
      return REFUSE_RUN.TICKS_DISAGREE;
    case REPLAY_ERROR.BAD_PLAYER_COUNT:
      return REFUSE_RUN.BAD_PLAYER_COUNT;
    default:
      return REFUSE_RUN.TRUNCATED;
  }
}

function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/* ---------------------------------------------------------------------------------------------- */
/* Judgement                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Judge one submission.
 *
 * Pure, and never throws: a malformed upload is a value. Order matters — size before parsing, structure
 * before comparison, comparison before opinion — so that a hostile upload is refused as early and as
 * cheaply as possible, and so that a flag is never attached to something that was never a run.
 */
export function judge(
  bytes: Uint8Array,
  claim: RunClaim,
  nowUnixSec: number,
  out: RunVerdict = emptyVerdict(),
): RunVerdict {
  const v = out;
  v.refusal = REFUSE_RUN.NONE;
  v.limitsVersion = SUBMIT_LIMITS_VERSION;
  v.ticks = 0;
  v.seconds = 0;
  v.seed = 0;
  v.stageId = 0;
  v.playerCount = 0;
  v.tainted = 0;
  v.contentVersion = 0;
  v.buildId = 0;
  v.startedAtUnixSec = 0;
  v.finalStateHash = 0;
  v.inputRecords = 0;
  v.flags = [];
  v.ladderEligible = false;

  if (bytes.byteLength === 0) return refuse(REFUSE_RUN.EMPTY, v);
  if (bytes.byteLength > MAX_SUBMISSION_BYTES) return refuse(REFUSE_RUN.TOO_LARGE, v);

  // Shape of the claim first: comparing against a claim containing NaN would let every comparison pass.
  const counts = [
    claim.ticks,
    claim.seed,
    claim.stageId,
    claim.playerCount,
    claim.tainted,
    claim.levelReached,
    claim.totalXp,
    claim.gold,
    claim.kills,
    claim.damageDealt,
    claim.damageTaken,
    claim.screensShown,
    claim.picksMade,
  ];
  for (const n of counts) if (!isCount(n)) return refuse(REFUSE_RUN.BAD_CLAIM_SHAPE, v);
  for (const d of claim.weaponDamage) {
    if (!Number.isFinite(d) || d < 0) return refuse(REFUSE_RUN.BAD_CLAIM_SHAPE, v);
  }
  if (claim.playerCount < 1 || claim.playerCount > MAX_REPLAY_PLAYERS) {
    return refuse(REFUSE_RUN.BAD_PLAYER_COUNT, v);
  }

  const decoded = decodeReplay(bytes);
  if (decoded.error !== REPLAY_ERROR.NONE) return refuse(refusalForDecode(decoded.error), v);

  const h = decoded.header;
  v.ticks = h.tickCount;
  v.seconds = Math.floor(h.tickCount / TICKS_PER_SECOND);
  v.seed = h.seed;
  v.stageId = h.stageId;
  v.playerCount = h.characterCount;
  v.tainted = h.tainted;
  v.contentVersion = h.contentVersion;
  v.buildId = h.buildId;
  v.startedAtUnixSec = h.startedAtUnixSec;
  v.finalStateHash = h.finalStateHash;
  v.inputRecords = Math.floor(decoded.stream.byteLength / (1 + h.characterCount * 3));

  if (h.tickCount === 0) return refuse(REFUSE_RUN.NO_TICKS, v);
  if (h.tickCount > MAX_RUN_TICKS) return refuse(REFUSE_RUN.TOO_LONG, v);
  if (h.contentVersion === 0) return refuse(REFUSE_RUN.NO_CONTENT_VERSION, v);

  // The ending is the one part of the result the log cannot confirm, so the only thing checked is that
  // it is an ending at all. A run still running has no business being submitted.
  const endings: number[] = Object.values(CLAIMABLE_END);
  if (!endings.includes(claim.end)) return refuse(REFUSE_RUN.BAD_ENDING, v);

  // Everything the log already knows is read from the log. A claim that disagrees about any of it is not
  // a claim about this log, and no amount of judgement makes it one.
  if (
    claim.ticks !== h.tickCount ||
    claim.seed !== h.seed ||
    claim.stageId !== h.stageId ||
    claim.playerCount !== h.characterCount ||
    claim.tainted !== h.tainted
  ) {
    return refuse(REFUSE_RUN.CLAIM_DISAGREES, v);
  }

  v.ladderEligible = isLadderEligible(h.tainted);
  addFlags(v, claim, nowUnixSec);
  return v;
}

/** Push a flag, once, up to the cap. Duplicates are meaningless and a full list is not an error. */
function raise(v: RunVerdict, flag: RunFlag): void {
  if (v.flags.length >= MAX_RUN_FLAGS) return;
  if (v.flags.includes(flag)) return;
  v.flags.push(flag);
}

/**
 * The opinions. Every rate is measured against the logged duration, never the claimed one, because the
 * claimed one has already been checked against the log and the log is the thing nobody can forge without
 * also forging the input stream.
 */
function addFlags(v: RunVerdict, claim: RunClaim, nowUnixSec: number): void {
  const seconds = v.seconds;
  // A run shorter than a second still played some ticks; treat it as one second rather than dividing by
  // zero and flagging every short run for an infinite rate.
  const perSecond = seconds > 0 ? seconds : 1;
  const minutes = perSecond / 60;

  if (claim.kills / perSecond > CEILING.KILLS_PER_SECOND) raise(v, RUN_FLAG.KILL_RATE);
  if (claim.damageDealt / perSecond > CEILING.DAMAGE_PER_SECOND) raise(v, RUN_FLAG.DAMAGE_RATE);
  if (claim.gold / minutes > CEILING.GOLD_PER_MINUTE) raise(v, RUN_FLAG.GOLD_RATE);
  if (claim.totalXp / minutes > CEILING.XP_PER_MINUTE) raise(v, RUN_FLAG.XP_RATE);
  if (claim.levelReached > CEILING.LEVEL_ALLOWANCE + minutes * CEILING.LEVELS_PER_MINUTE) {
    raise(v, RUN_FLAG.LEVEL_FOR_TIME);
  }
  if (claim.gold > 0 && claim.kills === 0) raise(v, RUN_FLAG.GOLD_WITHOUT_KILLS);
  if (seconds >= CEILING.UNTOUCHED_SECONDS && claim.damageTaken === 0 && v.tainted === 0) {
    raise(v, RUN_FLAG.NEVER_TOUCHED);
  }
  if (
    seconds >= CEILING.STILLNESS_SECONDS &&
    v.inputRecords / minutes < CEILING.RECORDS_PER_MINUTE_FLOOR
  ) {
    raise(v, RUN_FLAG.STOOD_STILL);
  }
  if (v.startedAtUnixSec > nowUnixSec + CEILING.CLOCK_AHEAD_SECONDS) raise(v, RUN_FLAG.CLOCK_AHEAD);
  if (v.tainted !== 0) raise(v, RUN_FLAG.DEV_MARKS);
  if (claim.picksMade > claim.screensShown) raise(v, RUN_FLAG.PICKS_WITHOUT_SCREENS);

  // The breakdown is allowed to be short — a weapon list is capped at six and a party can carry more —
  // but it must never claim more than the total, and a total with nothing behind it is worth a look.
  let breakdown = 0;
  for (const d of claim.weaponDamage) breakdown += d;
  if (claim.damageDealt > 0) {
    const overPermille = Math.trunc(((breakdown - claim.damageDealt) * 1000) / claim.damageDealt);
    if (overPermille > CEILING.BREAKDOWN_SLACK_PERMILLE) raise(v, RUN_FLAG.DAMAGE_BREAKDOWN);
  } else if (breakdown > 0) {
    raise(v, RUN_FLAG.DAMAGE_BREAKDOWN);
  }
}

/** One line per flag, for an operator screen. Never empty, so a row can never render blank. */
export function flagLines(v: RunVerdict): string[] {
  return v.flags.map((f) => describeFlag(f));
}

/**
 * A one-line summary an operator can scan.
 *
 * Deliberately says "worth a look" rather than anything that reads like a conclusion, because a flagged
 * run is a question and the screen that shows it should not answer it.
 */
export function verdictLine(v: RunVerdict): string {
  if (v.refusal !== REFUSE_RUN.NONE) return `refused: ${describeRefusal(v.refusal)}`;
  const mins = Math.floor(v.seconds / 60);
  const secs = v.seconds % 60;
  const clock = `${mins}:${String(secs).padStart(2, "0")}`;
  if (v.flags.length === 0) return `accepted, ${clock}, nothing unusual`;
  const word = v.flags.length === 1 ? "thing" : "things";
  return `accepted, ${clock}, ${v.flags.length} ${word} worth a look`;
}

/** Every refusal and flag code, for a self-check that the tables have no holes. */
export function tableFaults(): string[] {
  const faults: string[] = [];
  const refusals: number[] = Object.values(REFUSE_RUN);
  if (new Set(refusals).size !== refusals.length) faults.push("two refusals share a number");
  for (const r of refusals) {
    if (describeRefusal(r).startsWith("unknown")) faults.push(`refusal ${r} has no wording`);
  }
  const flags: number[] = Object.values(RUN_FLAG);
  if (new Set(flags).size !== flags.length) faults.push("two flags share a number");
  if (flags.includes(0)) faults.push("a flag numbered zero cannot be told from no flag");
  for (const f of flags) {
    if (describeFlag(f).startsWith("unknown")) faults.push(`flag ${f} has no wording`);
  }
  if (flags.length > MAX_RUN_FLAGS) faults.push("more flags exist than a verdict can carry");
  const ends: number[] = Object.values(CLAIMABLE_END);
  if (ends.includes(0)) faults.push("a run that is still running must not be claimable");
  return faults;
}

const FAULTS = tableFaults();
if (FAULTS.length > 0) throw new Error(`anti-cheat tables: ${FAULTS.join("; ")}`);
