/**
 * The results screen — what a run *was*, once it is over.
 *
 * WHY THIS IS A SIM FILE AND NOT A UI FILE
 * The numbers on the results screen are also the numbers that go into the save, into achievement
 * checks, into a leaderboard submission and into a bug report. If the screen computed them itself,
 * "the screen said 12:04 but the save recorded 11:58" becomes possible, and that is the kind of
 * discrepancy players screenshot. So a run summary is produced once, from the stores, and everything
 * downstream reads that one record.
 *
 * WHY IT IS A PREALLOCATED RECORD FILLED IN PLACE
 * Summarising happens once per run, so allocation would be harmless here — except that the same
 * function runs at 60Hz inside replay revalidation on the server, where a fresh object and a fresh
 * sorted array per run would be the whole cost. Fill-in-place costs nothing and forces the harder
 * question anyway: what exactly is in a summary?
 *
 * WHY THE WEAPON BREAKDOWN IS SORTED HERE
 * "Which of my weapons was actually doing the work" is the single most-read thing on the screen, and
 * it drives what the player builds next run. Sorting in the summary means the screen, the replay
 * validator and the co-op end-of-run panel all rank it identically.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * It does not write the save, does not submit anything, and does not decide ladder eligibility. Taint
 * comes in as a value it copies; `isLadderEligible` in `replay/format.ts` remains the only judge.
 */

import { MAX_PLAYERS } from "./player";
import type { PlayerStore } from "./player";
import type { Progression } from "./progression";
import { MAX_WEAPONS, WEAPON_TYPES } from "./weapons";
import type { WeaponStore } from "./weapons";

/** Ticks per second, so a summary can talk in seconds without importing the loop. */
const TICKS_PER_SECOND = 60;

/** How a run ended. Append-only: written into saves and replay footers. */
export const RUN_END = {
  /** Still going. A summary in this state is a mid-run snapshot for the dev menu. */
  running: 0,
  /** Every player died. The ordinary ending. */
  defeat: 1,
  /** The White Hand arrived and ended it. Counts as a completed run, not a death. */
  whiteHand: 2,
  /** The player survived the whole wave table. */
  survived: 3,
  /** The player quit to the menu on purpose. */
  quit: 4,
  /** Connection lost in co-op with no host to migrate to. */
  disconnected: 5,
} as const;

export type RunEnd = (typeof RUN_END)[keyof typeof RUN_END];

/**
 * Player-facing wording per ending.
 *
 * The distinction that matters: the White Hand is not a death. A player who reached 30 minutes and got
 * erased by an unkillable Reaper did not fail, and telling them they did is the fastest way to make
 * the best run of their week feel bad.
 */
export const RUN_END_LABELS: readonly string[] = [
  "In progress",
  "Overwhelmed",
  "Taken by the White Hand",
  "Survived the night",
  "Abandoned",
  "Connection lost",
];

export function describeRunEnd(end: number): string {
  return RUN_END_LABELS[end] ?? "Unknown";
}

/** True when the ending counts as finishing the run rather than losing it. */
export function isCompletion(end: number): boolean {
  return end === RUN_END.whiteHand || end === RUN_END.survived;
}

/** One row of the damage breakdown. */
export interface WeaponResult {
  /** Index into `WEAPON_TYPES`, or -1 for an unused row. */
  typeIndex: number;
  level: number;
  damage: number;
  /** Share of this player's total damage, in permille. */
  sharePermille: number;
  /** Weapon name, by reference from content. */
  name: string;
}

/** Everything a run was, for one player and for the party. */
export class RunSummary {
  end: RunEnd = RUN_END.running;
  /** Run ticks elapsed. The authoritative duration; seconds are derived. */
  ticks = 0;
  /** Stage and seed, so a run can be replayed or shared. */
  stageId = 0;
  seed = 0;
  /** Taint bits copied from the run header. Informational here. */
  tainted = 0;
  /** How many players were in the party. */
  playerCount = 1;

  levelReached = 0;
  totalXp = 0;
  gold = 0;
  kills = 0;
  damageDealt = 0;
  damageTaken = 0;
  /** Times any player went down, and times a down was reversed. */
  downs = 0;
  revives = 0;
  /** Card screens shown and picks made, for the "what did I actually choose" line. */
  screensShown = 0;
  picksMade = 0;

  /** Damage breakdown for the summarised player, sorted highest first. */
  readonly weapons: WeaponResult[] = Array.from({ length: MAX_WEAPONS }, () => ({
    typeIndex: -1,
    level: 0,
    damage: 0,
    sharePermille: 0,
    name: "",
  }));
  /** Populated rows in `weapons`. */
  weaponCount = 0;

  /** Per-player survival, so a co-op screen can say who fell and when. */
  readonly playerAlive = new Uint8Array(MAX_PLAYERS);
  readonly playerDownTick = new Int32Array(MAX_PLAYERS).fill(-1);

  get seconds(): number {
    return Math.floor(this.ticks / TICKS_PER_SECOND);
  }

  /** Whole minutes and seconds, for the clock on the screen. */
  get minutes(): number {
    return Math.floor(this.seconds / 60);
  }

  reset(): void {
    this.end = RUN_END.running;
    this.ticks = 0;
    this.stageId = 0;
    this.seed = 0;
    this.tainted = 0;
    this.playerCount = 1;
    this.levelReached = 0;
    this.totalXp = 0;
    this.gold = 0;
    this.kills = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.downs = 0;
    this.revives = 0;
    this.screensShown = 0;
    this.picksMade = 0;
    this.weaponCount = 0;
    for (const w of this.weapons) {
      w.typeIndex = -1;
      w.level = 0;
      w.damage = 0;
      w.sharePermille = 0;
      w.name = "";
    }
    this.playerAlive.fill(0);
    this.playerDownTick.fill(-1);
  }
}

/** The counters a summary needs that live outside the stores it reads. */
export interface RunTotals {
  kills: number;
  damageDealt: number;
  downs: number;
  revives: number;
  screensShown: number;
  picksMade: number;
  stageId: number;
  seed: number;
  tainted: number;
}

/** Formats run ticks as `M:SS`. The one place the run clock is turned into words. */
export function formatRunTime(ticks: number): string {
  const total = Math.floor(Math.max(0, ticks) / TICKS_PER_SECOND);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * Fill `out` from the live stores.
 *
 * `player` selects whose weapon breakdown is reported; the party-wide figures (kills, gold, level) are
 * shared by design, because experience and gold are shared in co-op.
 */
export function summariseRun(
  out: RunSummary,
  end: RunEnd,
  ticks: number,
  player: number,
  players: PlayerStore,
  weapons: WeaponStore,
  prog: Progression,
  totals: RunTotals,
): RunSummary {
  out.reset();
  out.end = end;
  out.ticks = ticks;
  out.stageId = totals.stageId;
  out.seed = totals.seed;
  out.tainted = totals.tainted;
  out.playerCount = players.count;

  out.levelReached = prog.peakLevel;
  out.totalXp = prog.totalXp;
  out.gold = prog.gold;
  out.kills = totals.kills;
  out.damageDealt = totals.damageDealt;
  out.damageTaken = players.damageTaken;
  out.downs = totals.downs;
  out.revives = totals.revives;
  out.screensShown = totals.screensShown;
  out.picksMade = totals.picksMade;

  for (let i = 0; i < players.count; i++) {
    out.playerAlive[i] = players.upright[i];
  }

  // Weapon rows, then a descending insertion sort. `MAX_WEAPONS` is 6: anything cleverer than
  // insertion sort would be slower and would allocate a comparator.
  const base = player * MAX_WEAPONS;
  let n = 0;
  let sum = 0;
  for (let i = 0; i < MAX_WEAPONS; i++) {
    const type = weapons.typeIndex[base + i];
    if (type < 0) continue;
    const row = out.weapons[n];
    row.typeIndex = type;
    row.level = weapons.level[base + i];
    row.damage = weapons.dealt[base + i];
    row.name = WEAPON_TYPES[type].name;
    sum += row.damage;
    n++;
  }
  out.weaponCount = n;

  for (let i = 1; i < n; i++) {
    const row = out.weapons[i];
    const damage = row.damage;
    const type = row.typeIndex;
    const level = row.level;
    const name = row.name;
    let j = i - 1;
    while (j >= 0 && out.weapons[j].damage < damage) {
      out.weapons[j + 1].damage = out.weapons[j].damage;
      out.weapons[j + 1].typeIndex = out.weapons[j].typeIndex;
      out.weapons[j + 1].level = out.weapons[j].level;
      out.weapons[j + 1].name = out.weapons[j].name;
      j--;
    }
    out.weapons[j + 1].damage = damage;
    out.weapons[j + 1].typeIndex = type;
    out.weapons[j + 1].level = level;
    out.weapons[j + 1].name = name;
  }

  // Shares, in permille of this player's own damage. Truncated, so they can sum to slightly under
  // 1000 — which is honest, where rounding one row up to make the total look tidy would not be.
  for (let i = 0; i < n; i++) {
    const row = out.weapons[i];
    row.sharePermille = sum > 0 ? Math.trunc((row.damage * 1000) / sum) : 0;
  }

  return out;
}

/** What a finished run contributes to the profile. Applied by the save layer, not here. */
export interface ProfileDelta {
  gold: number;
  runsStarted: number;
  runsCompleted: number;
  secondsPlayed: number;
  bestSurvivalSeconds: number;
  everTainted: number;
}

/**
 * Turn a summary into the profile changes it earns.
 *
 * Deliberately counts a *quit* run's gold and time: a player who bailed at 20 minutes still played 20
 * minutes, and confiscating that is the sort of thing that makes people stop opening the game. Only
 * `runsCompleted` is reserved for real endings.
 */
export function profileDeltaFor(summary: RunSummary, out: ProfileDelta): ProfileDelta {
  out.gold = summary.gold;
  out.runsStarted = 1;
  out.runsCompleted = isCompletion(summary.end) ? 1 : 0;
  out.secondsPlayed = summary.seconds;
  out.bestSurvivalSeconds = summary.seconds;
  out.everTainted = summary.tainted;
  return out;
}

export function createProfileDelta(): ProfileDelta {
  return {
    gold: 0,
    runsStarted: 0,
    runsCompleted: 0,
    secondsPlayed: 0,
    bestSurvivalSeconds: 0,
    everTainted: 0,
  };
}
