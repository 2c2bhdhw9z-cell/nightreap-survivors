import {
  type AwardReport,
  createAwardReport,
  grantReaperKillUnlock,
  resetAwardReport,
  sweepAchievements,
  sweepUnlocks,
} from "../unlocks/awards";
import { runFactsOf } from "../unlocks/achievements";
import { type ProfileDelta, type RunSummary, createProfileDelta, profileDeltaFor } from "../sim/results";
import { type PayoutReceipt, bankRun, createPayoutReceipt } from "./payout";
import type { SaveData } from "./schema";
import { bankEggs } from "../sim/eggs";

export const HANDOFF = {
  OK: 0,
  ALREADY_STAGED: 1,
  PAYOUT_REFUSED: 2,
  SLOT_BUSY: 3,
} as const;

export type HandoffCode = (typeof HANDOFF)[keyof typeof HANDOFF];

export const HANDOFF_NAMES: readonly string[] = ["OK", "ALREADY_STAGED", "PAYOUT_REFUSED", "SLOT_BUSY"];

export function describeHandoff(code: number): string {
  return HANDOFF_NAMES[code] ?? "UNKNOWN";
}

export interface ResultWeaponRow {
  name: string;
  level: number;
  damage: number;
  sharePermille: number;
}

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

export interface StagedResult {
  runId: string;
  view: ResultView;
  receipt: PayoutReceipt;
  awards: AwardReport;
}

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

export interface StageOutcome {
  code: HandoffCode;
  staged: boolean;
  receipt: PayoutReceipt;
  unlocked: number;
}

export class RunHandoff {
  private slot: StagedResult | null = null;
  private readonly banked = new Set<string>();
  private readonly delta: ProfileDelta = createProfileDelta();
  private readonly report: AwardReport = createAwardReport();

  stage(runId: string, summary: RunSummary, save: SaveData): StageOutcome {
    const receipt = createPayoutReceipt();
    if (this.banked.has(runId)) {
      resetAwardReport(this.report);
      return { code: HANDOFF.ALREADY_STAGED, staged: false, receipt, unlocked: 0 };
    }
    if (this.slot !== null) {
      return { code: HANDOFF.SLOT_BUSY, staged: false, receipt, unlocked: 0 };
    }
    const view = viewOf(summary);
    bankRun(save, profileDeltaFor(summary, this.delta), receipt);
    if (!receipt.banked) {
      resetAwardReport(this.report);
      return { code: HANDOFF.PAYOUT_REFUSED, staged: false, receipt, unlocked: 0 };
    }
    if (summary.eggsEarned > 0) {
      bankEggs(save, summary.characterId, summary.eggsEarned);
    }
    let unlocked = sweepUnlocks(save, this.report);
    if (summary.reaperKills > 0) {
      unlocked += grantReaperKillUnlock(save, this.report);
    }
    unlocked += sweepAchievements(save, this.report, runFactsOf(summary));
    this.banked.add(runId);
    this.slot = { runId, view, receipt, awards: this.report };
    return { code: HANDOFF.OK, staged: true, receipt, unlocked };
  }

  peek(): StagedResult | null {
    return this.slot;
  }

  take(): StagedResult | null {
    const held = this.slot;
    this.slot = null;
    return held;
  }

  wasBanked(runId: string): boolean {
    return this.banked.has(runId);
  }

  reset(): void {
    this.slot = null;
    this.banked.clear();
    resetAwardReport(this.report);
  }
}

export function runIdOf(summary: RunSummary): string {
  return `${summary.stageId}:${summary.seed}:${summary.ticks}:${summary.end}`;
}

export const runHandoff = new RunHandoff();
