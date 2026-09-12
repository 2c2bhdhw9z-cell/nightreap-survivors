import { MAX_PLAYERS } from "./player";
import type { PlayerStore } from "./player";
import type { Progression } from "./progression";
import { MAX_WEAPONS, WEAPON_TYPES } from "./weapons";
import type { WeaponStore } from "./weapons";

/** Ticks per second, so a summary can talk in seconds without importing the loop. */
const TICKS_PER_SECOND = 60;

/** How a run ended. Append-only: written into saves and replay footers. */
export const RUN_END = {
  running: 0,
  defeat: 1,
  whiteHand: 2,
  survived: 3,
  quit: 4,
  disconnected: 5,
} as const;

export type RunEnd = (typeof RUN_END)[keyof typeof RUN_END];

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

export function isCompletion(end: number): boolean {
  return end === RUN_END.whiteHand || end === RUN_END.survived;
}

export interface WeaponResult {
  typeIndex: number;
  level: number;
  damage: number;
  sharePermille: number;
  name: string;
}

export class RunSummary {
  end: RunEnd = RUN_END.running;
  ticks = 0;
  stageId = 0;
  seed = 0;
  tainted = 0;
  playerCount = 1;

  levelReached = 0;
  totalXp = 0;
  gold = 0;
  kills = 0;
  damageDealt = 0;
  damageTaken = 0;
  downs = 0;
  revives = 0;
  screensShown = 0;
  picksMade = 0;

  /** Golden Eggs earned this run by killing Reapers. Banked onto characterId at handoff. */
  eggsEarned = 0;
  /** How many Reapers this run killed. First kill unlocks Mord Vane. */
  reaperKills = 0;
  /** Seat-0 character index — eggs and the secret unlock attach here. */
  characterId = 0;

  readonly weapons: WeaponResult[] = Array.from({ length: MAX_WEAPONS }, () => ({
    typeIndex: -1,
    level: 0,
    damage: 0,
    sharePermille: 0,
    name: "",
  }));
  weaponCount = 0;

  readonly playerAlive = new Uint8Array(MAX_PLAYERS);
  readonly playerDownTick = new Int32Array(MAX_PLAYERS).fill(-1);

  get seconds(): number {
    return Math.floor(this.ticks / TICKS_PER_SECOND);
  }

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
    this.eggsEarned = 0;
    this.reaperKills = 0;
    this.characterId = 0;
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

export function formatRunTime(ticks: number): string {
  const total = Math.floor(Math.max(0, ticks) / TICKS_PER_SECOND);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

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

  for (let i = 0; i < n; i++) {
    const row = out.weapons[i];
    row.sharePermille = sum > 0 ? Math.trunc((row.damage * 1000) / sum) : 0;
  }

  return out;
}

export interface ProfileDelta {
  stageId: number;
  gold: number;
  runsStarted: number;
  runsCompleted: number;
  secondsPlayed: number;
  bestSurvivalSeconds: number;
  everTainted: number;
}

export function profileDeltaFor(summary: RunSummary, out: ProfileDelta): ProfileDelta {
  out.stageId = summary.stageId;
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
    stageId: 0,
    gold: 0,
    runsStarted: 0,
    runsCompleted: 0,
    secondsPlayed: 0,
    bestSurvivalSeconds: 0,
    everTainted: 0,
  };
}
