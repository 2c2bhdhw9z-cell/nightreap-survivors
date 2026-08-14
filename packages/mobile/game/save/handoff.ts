/**
 * The hand-off between a finished run and the results screen.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The run owns one `RunSummary` object and refills it in place every run, because allocating a fresh one
 * mid-frame is exactly the sort of thing that causes a hitch on a cheap phone. That is correct for the
 * simulation and useless for a screen: a React screen renders whenever it feels like it, and by the time
 * it renders the object underneath it may already have been reset for the next run. So the run does not
 * hand the screen its live object. It hands over a flat, copied snapshot, once, and the screen reads only
 * that.
 *
 * THE ONE HARD RULE: A RUN IS BANKED EXACTLY ONCE
 *
 * Banking is the moment gold becomes real. Doing it twice pays a player twice, which sounds harmless
 * until it is the thing every cheater does on purpose. `bankRun` itself is deliberately dumb about this —
 * called twice, it pays twice — so the once-only guarantee lives here instead of being spread across
 * whichever screens happen to call it:
 *
 *   - staging is the ONLY path that banks, so a screen cannot bank by accident;
 *   - each stage carries a run id, and an id that has already been staged is refused;
 *   - the refusal is reported, not thrown, because a duplicate stage is a bug in the caller and crashing
 *     the app on the results screen would destroy the run the player just finished.
 *
 * WHAT IS NOT HERE
 *
 * Persisting the save. Staging changes the profile in memory and says so; writing it to storage is the
 * caller's job, because the caller is the only thing that knows whether it is safe to await a write at
 * that moment. A staged result whose save never reached storage is still the honest thing to show the
 * player: it is what their profile says right now.
 */

import {
  type AwardReport,
  createAwardReport,
  resetAwardReport,
  sweepAchievements,
  sweepUnlocks,
} from "../unlocks/awards";
import { runFactsOf } from "../unlocks/achievements";
import { type ProfileDelta, type RunSummary, createProfileDelta, profileDeltaFor } from "../sim/results";
import { type PayoutReceipt, bankRun, createPayoutReceipt } from "./payout";
import type { SaveData } from "./schema";

/** Why a stage was refused. Append-only: these numbers reach bug reports. */
export const HANDOFF = {
  /** Staged, and the profile was changed. */
  OK: 0,
  /** This run id was already staged. Nothing was changed. */
  ALREADY_STAGED: 1,
  /** The payout itself refused. `receipt.badField` says what was wrong. Nothing was changed. */
  PAYOUT_REFUSED: 2,
  /** A result is still waiting to be read. Nothing was changed. */
  SLOT_BUSY: 3,
} as const;

export type HandoffCode = (typeof HANDOFF)[keyof typeof HANDOFF];

export const HANDOFF_NAMES: readonly string[] = ["OK", "ALREADY_STAGED", "PAYOUT_REFUSED", "SLOT_BUSY"];

export function describeHandoff(code: number): string {
  return HANDOFF_NAMES[code] ?? "UNKNOWN";
}

/** One weapon's line on the results screen. A copy — never a reference into the live summary. */
export interface ResultWeaponRow {
  name: string;
  level: number;
  damage: number;
  sharePermille: number;
}

/**
 * Everything the results screen draws, flat and copied.
 *
 * No getters, no class, no live arrays. If a number is not on this object the screen does not get to show
 * it, which is the point: it stops a screen from reaching back into the simulation for "just one more"
 * figure and reading it a frame too late.
 */
export interface ResultView {
  end: number;
  seconds: number;
  stageId: number;
  playerCount: number;
  levelReached: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  downs: number;
  revives: number;
  picksMade: number;
  tainted: number;
  weapons: ResultWeaponRow[];
}

/**
 * A staged result: what happened, what it paid, and what it unlocked.
 *
 * `awards` is the live report the handoff owns, not a copy. It is safe to hand out because the only thing
 * that ever writes it is the next `stage` call, and a `stage` call cannot happen while a result is still
 * sitting unread in the slot.
 */
export interface StagedResult {
  runId: string;
  view: ResultView;
  receipt: PayoutReceipt;
  awards: AwardReport;
}

/** Copy the display fields out of the live summary. Weapon rows are copied element by element. */
export function viewOf(summary: RunSummary): ResultView {
  const weapons: ResultWeaponRow[] = [];
  for (let i = 0; i < summary.weaponCount; i++) {
    const row = summary.weapons[i];
    weapons.push({
      name: row.name,
      level: row.level,
      damage: row.damage,
      sharePermille: row.sharePermille,
    });
  }
  return {
    end: summary.end,
    seconds: summary.seconds,
    stageId: summary.stageId,
    playerCount: summary.playerCount,
    levelReached: summary.levelReached,
    kills: summary.kills,
    damageDealt: summary.damageDealt,
    damageTaken: summary.damageTaken,
    downs: summary.downs,
    revives: summary.revives,
    picksMade: summary.picksMade,
    tainted: summary.tainted,
    weapons,
  };
}

/** What a stage attempt did. `staged` is true only when the profile actually changed. */
export interface StageOutcome {
  code: HandoffCode;
  staged: boolean;
  receipt: PayoutReceipt;
  /** How many unlocks the banked profile just earned. Zero on every refusal. */
  unlocked: number;
}

/**
 * The single slot between the run and the results screen.
 *
 * One instance, module-level, because there is only ever one run finishing at a time. It is a class
 * rather than loose module state so the tests can make as many as they like without one test's staged
 * result leaking into the next.
 */
export class RunHandoff {
  private slot: StagedResult | null = null;
  /** Every run id banked in this process. Small: a session is tens of runs, not thousands. */
  private readonly banked = new Set<string>();
  /** Reused so a normal run end allocates nothing beyond the view. */
  private readonly delta: ProfileDelta = createProfileDelta();
  /** Reused for the same reason. Wiped at the start of every sweep, and on every refusal. */
  private readonly report: AwardReport = createAwardReport();

  /**
   * Bank a finished run and put its result in the slot.
   *
   * Refuses without touching anything if this run was already banked, if a previous result has not been
   * read yet, or if the payout itself refuses.
   */
  stage(runId: string, summary: RunSummary, save: SaveData): StageOutcome {
    const receipt = createPayoutReceipt();
    if (this.banked.has(runId)) {
      resetAwardReport(this.report);
      return { code: HANDOFF.ALREADY_STAGED, staged: false, receipt, unlocked: 0 };
    }
    if (this.slot !== null) {
      return { code: HANDOFF.SLOT_BUSY, staged: false, receipt, unlocked: 0 };
    }
    // The view is built before banking so a payout refusal leaves nothing half-made behind.
    const view = viewOf(summary);
    bankRun(save, profileDeltaFor(summary, this.delta), receipt);
    if (!receipt.banked) {
      // Wipe the rows as well as the numbers. A refused run must not leave last run's unlocks sitting in a
      // report for a screen to draw, which is the same bug the payout receipt already had once.
      resetAwardReport(this.report);
      return { code: HANDOFF.PAYOUT_REFUSED, staged: false, receipt, unlocked: 0 };
    }
    // The sweep runs *after* banking, so it reads the profile this run just changed. Running it first
    // would hand out last run's unlocks and announce them a second time.
    // Two sweeps, one report. The character/place/card sweep empties the report and fills it; the badge
    // sweep adds to it, and is handed the run that just ended so it can answer the questions that only a
    // finished run can answer.
    const unlocked =
      sweepUnlocks(save, this.report) + sweepAchievements(save, this.report, runFactsOf(summary));
    this.banked.add(runId);
    this.slot = { runId, view, receipt, awards: this.report };
    return { code: HANDOFF.OK, staged: true, receipt, unlocked };
  }

  /** Read the staged result without consuming it, so a screen can re-render freely. */
  peek(): StagedResult | null {
    return this.slot;
  }

  /** Read and clear. Called when the results screen is left. */
  take(): StagedResult | null {
    const held = this.slot;
    this.slot = null;
    return held;
  }

  /** True when this run has already been paid, whether or not its result is still in the slot. */
  wasBanked(runId: string): boolean {
    return this.banked.has(runId);
  }

  /**
   * Forget everything. Tests and the dev menu only.
   *
   * Deliberately not called anywhere in normal play: clearing the banked set is precisely how a run gets
   * paid twice.
   */
  reset(): void {
    this.slot = null;
    this.banked.clear();
    resetAwardReport(this.report);
  }
}

/**
 * A run id that is stable for one run and different for the next.
 *
 * Stage and seed identify the run; the tick it ended on separates two attempts at the same stage with the
 * same seed, which happens constantly in testing and would otherwise make the second attempt unpayable.
 */
export function runIdOf(summary: RunSummary): string {
  return `${summary.stageId}:${summary.seed}:${summary.ticks}:${summary.end}`;
}

/** The one slot the app uses. */
export const runHandoff = new RunHandoff();
