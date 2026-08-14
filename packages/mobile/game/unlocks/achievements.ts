/**
 * The achievement catalog and the one function that decides which of them a profile has earned.
 *
 * WHY THIS IS DATA AND NOT FIFTY LITTLE FUNCTIONS
 *
 * An achievement is a question about a number: "have you ever survived twenty minutes", "did this run
 * end with six weapons on the bar". Written as fifty closures it becomes fifty places a bug can hide,
 * none of which can be listed, counted, sorted or drawn on a screen without running them. Written as
 * rows — a kind, a threshold and at most one argument — the whole set can be checked for duplicates,
 * printed, and proved with one loop.
 *
 * WHY THERE ARE TWO KINDS OF QUESTION
 *
 * Some questions are about the profile ("lifetime gold", "runs finished") and can be asked at any time.
 * Others are about a single run ("killed three thousand things in one run") and can only be asked while
 * that run's summary still exists. The save file cannot answer the second kind — it stores totals, not
 * the best single run of every statistic, and adding fifty high-water marks to the save to avoid asking
 * at the right moment would be fifty more things to migrate.
 *
 * So the sweep takes the profile and, when there is one, the run that just ended. With no run in hand it
 * simply skips the run questions rather than answering them as false, because a false is written down
 * and a skip is not.
 *
 * WHY A MARK IS NEVER CLEARED
 *
 * Same promise the rest of this folder makes. Once earned, always earned — a rebalanced threshold, a
 * cloud merge from a phone with less history, or a save migrated up from an older build must never take
 * an achievement back off somebody.
 *
 * APPEND-ONLY
 *
 * A row's position is its bit in the save file. Inserting in the middle would hand every player the
 * wrong achievements. Add at the end, never reorder, never delete.
 */

import { bitGet, SAVE_LIMITS, type SaveData } from "../save/schema";
import { RUN_END, type RunSummary } from "../sim/results";
import { MAX_WEAPON_LEVEL } from "../sim/weapons";
import { STAGE_TYPES } from "../sim/stages";

/**
 * What kind of question a row asks.
 *
 * Append-only, like everything else here. `profile*` kinds read the save; `run*` kinds read the run that
 * just ended and are skipped entirely when there is no run in hand.
 */
export const ACH_KIND = {
  /** Lifetime gold earned, ever. */
  profileGold: 0,
  /** Runs finished, ever. */
  profileRuns: 1,
  /** Seconds played, ever. */
  profileSeconds: 2,
  /** Best survival time anywhere, in seconds. */
  profileBestAnywhere: 3,
  /** Best survival time in the place named by `arg`, in seconds. */
  profileBestInStage: 4,
  /** How many people are unlocked. */
  profilePeople: 5,
  /** How many places are unlocked. */
  profilePlaces: 6,
  /** How many arcanas are unlocked. */
  profileArcanas: 7,
  /** Seconds survived in the run that just ended. */
  runSeconds: 8,
  /** Things killed in the run that just ended. */
  runKills: 9,
  /** Level reached in the run that just ended. */
  runLevel: 10,
  /** Gold collected in the run that just ended. */
  runGold: 11,
  /** Damage dealt in the run that just ended. */
  runDamage: 12,
  /** Weapons carried when the run ended. */
  runWeapons: 13,
  /** Highest weapon level reached in the run that just ended. */
  runWeaponLevel: 14,
  /** The run ended a particular way — `arg` is a `RUN_END` value, `need` is ignored. */
  runEndedAs: 15,
  /** The run lasted at least `need` seconds and took no damage at all. */
  runUnhurtFor: 16,
  /** The run lasted at least `need` seconds with nobody ever going down. */
  runNoDownsFor: 17,
  /** Party members revived in the run that just ended. */
  runRevives: 18,
  /** The run had at least `need` people in the party. */
  runPartyOf: 19,
  /** The run was survived in the place named by `arg`. */
  runSurvivedStage: 20,
  /** How many weapons finished the run at the highest level a weapon goes to. */
  runMaxedWeapons: 21,
} as const;

export type AchKind = (typeof ACH_KIND)[keyof typeof ACH_KIND];

export interface Achievement {
  /** Stable id. Never reused, never renamed — it is what a bug report and a support ticket say. */
  readonly id: string;
  readonly name: string;
  /** One line of plain English saying exactly how it is earned. Shown locked and unlocked alike. */
  readonly blurb: string;
  /** Atlas frame for the badge. */
  readonly icon: string;
  /**
   * A hidden achievement shows as "???" with its line withheld until it is earned.
   *
   * Reserved for the ones that would spoil something — the endings, mostly. A hidden grind target is
   * just a grind target nobody can plan for, which is annoying rather than mysterious.
   */
  readonly hidden: boolean;
  readonly kind: AchKind;
  /** The threshold. Meaningless for the kinds that only read `arg`. */
  readonly need: number;
  /** Stage index, run ending, or -1 where the kind does not take one. */
  readonly arg: number;
}

/** Badges available on the sheet. Eighteen were drawn; a badge is shared by a family of rows. */
const ICON = {
  time: "achievements/icon-01",
  kills: "achievements/icon-02",
  gold: "achievements/icon-03",
  level: "achievements/icon-04",
  weapon: "achievements/icon-05",
  crypt: "achievements/icon-06",
  ossuary: "achievements/icon-07",
  marsh: "achievements/icon-08",
  gallows: "achievements/icon-09",
  belfry: "achievements/icon-10",
  party: "achievements/icon-11",
  unhurt: "achievements/icon-12",
  people: "achievements/icon-13",
  places: "achievements/icon-14",
  arcana: "achievements/icon-15",
  damage: "achievements/icon-16",
  ending: "achievements/icon-17",
  grind: "achievements/icon-18",
} as const;

const STAGE_ICONS: readonly string[] = [
  ICON.crypt,
  ICON.ossuary,
  ICON.marsh,
  ICON.gallows,
  ICON.belfry,
];

/**
 * The launch set. Fifty rows.
 *
 * The shape of the set matters more than any one row: about half are ladders a player climbs without
 * trying (time, kills, gold, levels), a quarter are "have you been everywhere and met everyone", and
 * the rest are things you have to actually decide to do — finish unhurt, finish a party run, take an
 * ending. A set that is all ladders is a progress bar wearing a hat.
 */
export const ACHIEVEMENT_TYPES: readonly Achievement[] = [
  /* ---- first steps -------------------------------------------------------------------------- */
  { id: "firstBlood", name: "First Blood", blurb: "Kill a hundred things in one run.", icon: ICON.kills, hidden: false, kind: ACH_KIND.runKills, need: 100, arg: -1 },
  { id: "firstRun", name: "One Down", blurb: "Finish a run, however it ends.", icon: ICON.grind, hidden: false, kind: ACH_KIND.profileRuns, need: 1, arg: -1 },
  { id: "fiveMinutes", name: "Five Minutes", blurb: "Last five minutes in a single run.", icon: ICON.time, hidden: false, kind: ACH_KIND.runSeconds, need: 300, arg: -1 },
  { id: "levelTen", name: "Getting Somewhere", blurb: "Reach level ten in a single run.", icon: ICON.level, hidden: false, kind: ACH_KIND.runLevel, need: 10, arg: -1 },
  { id: "firstGold", name: "Pocket Change", blurb: "Collect five hundred gold in a single run.", icon: ICON.gold, hidden: false, kind: ACH_KIND.runGold, need: 500, arg: -1 },

  /* ---- the time ladder ---------------------------------------------------------------------- */
  { id: "tenMinutes", name: "Ten Minutes", blurb: "Last ten minutes in a single run.", icon: ICON.time, hidden: false, kind: ACH_KIND.runSeconds, need: 600, arg: -1 },
  { id: "fifteenMinutes", name: "Fifteen Minutes", blurb: "Last fifteen minutes in a single run.", icon: ICON.time, hidden: false, kind: ACH_KIND.runSeconds, need: 900, arg: -1 },
  { id: "twentyMinutes", name: "Twenty Minutes", blurb: "Last twenty minutes in a single run.", icon: ICON.time, hidden: false, kind: ACH_KIND.runSeconds, need: 1200, arg: -1 },
  { id: "twentyFiveMinutes", name: "Twenty-Five Minutes", blurb: "Last twenty-five minutes in a single run.", icon: ICON.time, hidden: false, kind: ACH_KIND.runSeconds, need: 1500, arg: -1 },
  { id: "theFullHalfHour", name: "The Full Half Hour", blurb: "Last the whole thirty minutes in a single run.", icon: ICON.time, hidden: false, kind: ACH_KIND.runSeconds, need: 1800, arg: -1 },

  /* ---- the kill ladder ---------------------------------------------------------------------- */
  { id: "killsThousand", name: "Thinning Them Out", blurb: "Kill a thousand things in one run.", icon: ICON.kills, hidden: false, kind: ACH_KIND.runKills, need: 1000, arg: -1 },
  { id: "killsThreeThousand", name: "Crowd Control", blurb: "Kill three thousand things in one run.", icon: ICON.kills, hidden: false, kind: ACH_KIND.runKills, need: 3000, arg: -1 },
  { id: "killsSixThousand", name: "Gravedigger", blurb: "Kill six thousand things in one run.", icon: ICON.kills, hidden: false, kind: ACH_KIND.runKills, need: 6000, arg: -1 },
  { id: "killsTenThousand", name: "Harvest", blurb: "Kill ten thousand things in one run.", icon: ICON.kills, hidden: false, kind: ACH_KIND.runKills, need: 10000, arg: -1 },

  /* ---- the damage ladder -------------------------------------------------------------------- */
  { id: "damageMillion", name: "Heavy Hand", blurb: "Deal a million damage in one run.", icon: ICON.damage, hidden: false, kind: ACH_KIND.runDamage, need: 1000000, arg: -1 },
  { id: "damageFiveMillion", name: "Ruinous", blurb: "Deal five million damage in one run.", icon: ICON.damage, hidden: false, kind: ACH_KIND.runDamage, need: 5000000, arg: -1 },

  /* ---- levels and loadout ------------------------------------------------------------------- */
  { id: "levelTwentyFive", name: "Well Read", blurb: "Reach level twenty-five in a single run.", icon: ICON.level, hidden: false, kind: ACH_KIND.runLevel, need: 25, arg: -1 },
  { id: "levelFifty", name: "Scholar Of The Dark", blurb: "Reach level fifty in a single run.", icon: ICON.level, hidden: false, kind: ACH_KIND.runLevel, need: 50, arg: -1 },
  { id: "levelSeventyFive", name: "Beyond Sense", blurb: "Reach level seventy-five in a single run.", icon: ICON.level, hidden: false, kind: ACH_KIND.runLevel, need: 75, arg: -1 },
  { id: "fullBar", name: "No Room Left", blurb: "End a run carrying six weapons.", icon: ICON.weapon, hidden: false, kind: ACH_KIND.runWeapons, need: 6, arg: -1 },
  { id: "maxedWeapon", name: "Mastered", blurb: `Take a weapon all the way to level ${MAX_WEAPON_LEVEL} in one run.`, icon: ICON.weapon, hidden: false, kind: ACH_KIND.runWeaponLevel, need: MAX_WEAPON_LEVEL, arg: -1 },
  { id: "twoMaxedWeapons", name: "Both Hands", blurb: `End a run with two weapons at level ${MAX_WEAPON_LEVEL}.`, icon: ICON.weapon, hidden: false, kind: ACH_KIND.runMaxedWeapons, need: 2, arg: -1 },

  /* ---- gold --------------------------------------------------------------------------------- */
  { id: "goldRunFive", name: "Grave Robber", blurb: "Collect five thousand gold in a single run.", icon: ICON.gold, hidden: false, kind: ACH_KIND.runGold, need: 5000, arg: -1 },
  { id: "goldLifetimeTen", name: "Saving Up", blurb: "Earn ten thousand gold across every run.", icon: ICON.gold, hidden: false, kind: ACH_KIND.profileGold, need: 10000, arg: -1 },
  { id: "goldLifetimeFifty", name: "Comfortable", blurb: "Earn fifty thousand gold across every run.", icon: ICON.gold, hidden: false, kind: ACH_KIND.profileGold, need: 50000, arg: -1 },
  { id: "goldLifetimeTwoFifty", name: "Rich Beyond Use", blurb: "Earn two hundred and fifty thousand gold across every run.", icon: ICON.gold, hidden: false, kind: ACH_KIND.profileGold, need: 250000, arg: -1 },

  /* ---- persistence -------------------------------------------------------------------------- */
  { id: "runsTen", name: "Regular", blurb: "Finish ten runs.", icon: ICON.grind, hidden: false, kind: ACH_KIND.profileRuns, need: 10, arg: -1 },
  { id: "runsFifty", name: "Committed", blurb: "Finish fifty runs.", icon: ICON.grind, hidden: false, kind: ACH_KIND.profileRuns, need: 50, arg: -1 },
  { id: "runsTwoHundred", name: "This Is A Habit Now", blurb: "Finish two hundred runs.", icon: ICON.grind, hidden: false, kind: ACH_KIND.profileRuns, need: 200, arg: -1 },
  { id: "playedTenHours", name: "Ten Hours Gone", blurb: "Play for ten hours in total.", icon: ICON.grind, hidden: false, kind: ACH_KIND.profileSeconds, need: 36000, arg: -1 },
  { id: "playedFiftyHours", name: "Fifty Hours Gone", blurb: "Play for fifty hours in total.", icon: ICON.grind, hidden: false, kind: ACH_KIND.profileSeconds, need: 180000, arg: -1 },

  /* ---- the five places ---------------------------------------------------------------------- */
  { id: "clearCrypt", name: "Out Of The Crypt", blurb: `Survive the full run in ${STAGE_TYPES[0].name}.`, icon: STAGE_ICONS[0], hidden: false, kind: ACH_KIND.runSurvivedStage, need: 0, arg: 0 },
  { id: "clearOssuary", name: "Out Of The Ossuary", blurb: `Survive the full run in ${STAGE_TYPES[1].name}.`, icon: STAGE_ICONS[1], hidden: false, kind: ACH_KIND.runSurvivedStage, need: 0, arg: 1 },
  { id: "clearMarsh", name: "Out Of The Marsh", blurb: `Survive the full run in ${STAGE_TYPES[2].name}.`, icon: STAGE_ICONS[2], hidden: false, kind: ACH_KIND.runSurvivedStage, need: 0, arg: 2 },
  { id: "clearGallows", name: "Off The Row", blurb: `Survive the full run in ${STAGE_TYPES[3].name}.`, icon: STAGE_ICONS[3], hidden: false, kind: ACH_KIND.runSurvivedStage, need: 0, arg: 3 },
  { id: "clearBelfry", name: "Down From The Belfry", blurb: `Survive the full run in ${STAGE_TYPES[4].name}.`, icon: STAGE_ICONS[4], hidden: false, kind: ACH_KIND.runSurvivedStage, need: 0, arg: 4 },
  { id: "tenInCrypt", name: "At Home Down There", blurb: `Last ten minutes in ${STAGE_TYPES[0].name}.`, icon: STAGE_ICONS[0], hidden: false, kind: ACH_KIND.profileBestInStage, need: 600, arg: 0 },
  { id: "fifteenInMarsh", name: "Wet Boots", blurb: `Last fifteen minutes in ${STAGE_TYPES[2].name}.`, icon: STAGE_ICONS[2], hidden: false, kind: ACH_KIND.profileBestInStage, need: 900, arg: 2 },
  { id: "twentyInBelfry", name: "Ears Ringing", blurb: `Last twenty minutes in ${STAGE_TYPES[4].name}.`, icon: STAGE_ICONS[4], hidden: false, kind: ACH_KIND.profileBestInStage, need: 1200, arg: 4 },
  { id: "everywhere", name: "Everywhere", blurb: "Unlock every place there is.", icon: ICON.places, hidden: false, kind: ACH_KIND.profilePlaces, need: STAGE_TYPES.length, arg: -1 },

  /* ---- the roster and the cards ------------------------------------------------------------- */
  { id: "peopleFive", name: "Company", blurb: "Unlock five people.", icon: ICON.people, hidden: false, kind: ACH_KIND.profilePeople, need: 5, arg: -1 },
  { id: "peopleTen", name: "A Whole Crowd", blurb: "Unlock ten people.", icon: ICON.people, hidden: false, kind: ACH_KIND.profilePeople, need: 10, arg: -1 },
  { id: "arcanaThree", name: "Reading The Cards", blurb: "Unlock three arcanas.", icon: ICON.arcana, hidden: false, kind: ACH_KIND.profileArcanas, need: 3, arg: -1 },
  { id: "arcanaAll", name: "The Whole Deck", blurb: "Unlock every arcana.", icon: ICON.arcana, hidden: false, kind: ACH_KIND.profileArcanas, need: 8, arg: -1 },

  /* ---- things you have to mean to do -------------------------------------------------------- */
  { id: "unhurtFive", name: "Untouched", blurb: "Last five minutes without taking a single hit.", icon: ICON.unhurt, hidden: false, kind: ACH_KIND.runUnhurtFor, need: 300, arg: -1 },
  { id: "unhurtTen", name: "Not A Scratch", blurb: "Last ten minutes without taking a single hit.", icon: ICON.unhurt, hidden: false, kind: ACH_KIND.runUnhurtFor, need: 600, arg: -1 },
  { id: "noDownsTwenty", name: "Still Standing", blurb: "Last twenty minutes with nobody going down.", icon: ICON.unhurt, hidden: false, kind: ACH_KIND.runNoDownsFor, need: 1200, arg: -1 },
  { id: "partyOfFour", name: "Crypt Party", blurb: "Play a run with four people in the party.", icon: ICON.party, hidden: false, kind: ACH_KIND.runPartyOf, need: 4, arg: -1 },
  { id: "reviveFive", name: "Get Up", blurb: "Pick your party up five times in one run.", icon: ICON.party, hidden: false, kind: ACH_KIND.runRevives, need: 5, arg: -1 },

  /* ---- endings ------------------------------------------------------------------------------ */
  { id: "takenByTheHand", name: "The White Hand", blurb: "Meet what comes for you at the end.", icon: ICON.ending, hidden: true, kind: ACH_KIND.runEndedAs, need: 0, arg: RUN_END.whiteHand },
  { id: "bestHalfHour", name: "Long Night", blurb: "Hold a best time of thirty minutes.", icon: ICON.time, hidden: false, kind: ACH_KIND.profileBestAnywhere, need: 1800, arg: -1 },
];

/** Positions available in the save file's achievement bitset. */
export const ACHIEVEMENT_CAPACITY = SAVE_LIMITS.achievementBytes * 8;

/** Row lookup by id, for anything that names one in text rather than by position. */
export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, number> = new Map(
  ACHIEVEMENT_TYPES.map((a, i) => [a.id, i]),
);

/** The row at `index`, clamped into the catalog so a bad index draws something rather than crashing. */
export function achievementAt(index: number): Achievement {
  const i = index | 0;
  if (i < 0) return ACHIEVEMENT_TYPES[0];
  if (i >= ACHIEVEMENT_TYPES.length) return ACHIEVEMENT_TYPES[ACHIEVEMENT_TYPES.length - 1];
  return ACHIEVEMENT_TYPES[i];
}

/** Is this a question about a single run rather than about the profile? */
export function isRunKind(kind: number): boolean {
  return kind >= ACH_KIND.runSeconds;
}

/**
 * What one run was, reduced to the numbers an achievement may ask about.
 *
 * A flat record rather than the summary itself so a test can write one by hand, and so nothing here
 * holds a live reference into a simulation that is about to be reused for the next run.
 */
export interface RunFacts {
  readonly end: number;
  readonly seconds: number;
  readonly stageId: number;
  readonly playerCount: number;
  readonly level: number;
  readonly gold: number;
  readonly kills: number;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly downs: number;
  readonly revives: number;
  readonly weaponCount: number;
  readonly bestWeaponLevel: number;
  /** How many of those weapons finished at `MAX_WEAPON_LEVEL`. */
  readonly maxedWeaponCount: number;
}

/** Reduce a finished run to those numbers. */
export function runFactsOf(summary: RunSummary): RunFacts {
  let best = 0;
  let maxed = 0;
  for (let i = 0; i < summary.weaponCount && i < summary.weapons.length; i++) {
    const level = summary.weapons[i].level;
    if (level > best) best = level;
    if (level >= MAX_WEAPON_LEVEL) maxed++;
  }
  return {
    end: summary.end,
    seconds: summary.seconds,
    stageId: summary.stageId,
    playerCount: summary.playerCount,
    level: summary.levelReached,
    gold: summary.gold,
    kills: summary.kills,
    damageDealt: summary.damageDealt,
    damageTaken: summary.damageTaken,
    downs: summary.downs,
    revives: summary.revives,
    weaponCount: summary.weaponCount,
    bestWeaponLevel: best,
    maxedWeaponCount: maxed,
  };
}

/** How many bits are set in a bitset, up to `limit` positions. */
function countBits(bytes: Uint8Array, limit: number): number {
  let n = 0;
  for (let i = 0; i < limit; i++) if (bitGet(bytes, i)) n++;
  return n;
}

/** A stage's best time, or zero when the save is too short to hold that slot. */
function stageBest(save: SaveData, index: number): number {
  if (index < 0 || index >= save.stageBestSeconds.length) return 0;
  return save.stageBestSeconds[index];
}

/**
 * Has this row been earned?
 *
 * `run` is null when nothing just finished — the collection screen asking "what have I got" rather than
 * a run ending. Run questions answer false in that case and are never written down, which is the whole
 * reason `sweepAchievements` skips them instead of granting on them.
 */
export function achievementMet(
  achievement: Achievement,
  save: SaveData,
  run: RunFacts | null,
): boolean {
  const need = achievement.need;
  switch (achievement.kind) {
    case ACH_KIND.profileGold:
      return save.goldLifetime >= need;
    case ACH_KIND.profileRuns:
      return save.runsCompleted >= need;
    case ACH_KIND.profileSeconds:
      return save.secondsPlayed >= need;
    case ACH_KIND.profileBestAnywhere:
      return save.bestSurvivalSeconds >= need;
    case ACH_KIND.profileBestInStage:
      return stageBest(save, achievement.arg) >= need;
    case ACH_KIND.profilePeople:
      return countBits(save.unlockedCharacters, save.unlockedCharacters.length * 8) >= need;
    case ACH_KIND.profilePlaces:
      return countBits(save.unlockedStages, STAGE_TYPES.length) >= need;
    case ACH_KIND.profileArcanas:
      return countBits(save.unlockedArcanas, save.unlockedArcanas.length * 8) >= need;
    default:
      break;
  }

  if (run === null) return false;

  switch (achievement.kind) {
    case ACH_KIND.runSeconds:
      return run.seconds >= need;
    case ACH_KIND.runKills:
      return run.kills >= need;
    case ACH_KIND.runLevel:
      return run.level >= need;
    case ACH_KIND.runGold:
      return run.gold >= need;
    case ACH_KIND.runDamage:
      return run.damageDealt >= need;
    case ACH_KIND.runWeapons:
      return run.weaponCount >= need;
    case ACH_KIND.runWeaponLevel:
      return run.bestWeaponLevel >= need;
    case ACH_KIND.runMaxedWeapons:
      return run.maxedWeaponCount >= need;
    case ACH_KIND.runEndedAs:
      return run.end === achievement.arg;
    case ACH_KIND.runUnhurtFor:
      return run.damageTaken <= 0 && run.seconds >= need;
    case ACH_KIND.runNoDownsFor:
      return run.downs <= 0 && run.seconds >= need;
    case ACH_KIND.runRevives:
      return run.revives >= need;
    case ACH_KIND.runPartyOf:
      return run.playerCount >= need;
    case ACH_KIND.runSurvivedStage:
      return run.end === RUN_END.survived && run.stageId === achievement.arg;
    default:
      return false;
  }
}

/** Is this achievement held on this profile? */
export function achievementHeld(save: SaveData, index: number): boolean {
  if (index < 0 || index >= ACHIEVEMENT_TYPES.length) return false;
  return bitGet(save.achievements, index);
}

/** How many are held. Drawn as "12/50" at the top of the collection screen. */
export function achievementsHeld(save: SaveData): number {
  let n = 0;
  for (let i = 0; i < ACHIEVEMENT_TYPES.length; i++) if (achievementHeld(save, i)) n++;
  return n;
}

/**
 * What a row says on the collection screen.
 *
 * A hidden row keeps its name and its line until it is earned. Everything else says exactly what it
 * wants, earned or not — an achievement you cannot read is not a goal, it is a surprise.
 */
export function achievementLine(save: SaveData, index: number): string {
  const a = achievementAt(index);
  if (a.hidden && !achievementHeld(save, index)) return "???";
  return a.blurb;
}

/** The name to draw, with the same rule about hidden rows. */
export function achievementName(save: SaveData, index: number): string {
  const a = achievementAt(index);
  if (a.hidden && !achievementHeld(save, index)) return "???";
  return a.name;
}

/** One line for the results screen when one is earned. */
export function achievementEarnedLine(index: number): string {
  return achievementAt(index).blurb;
}

/**
 * Everything wrong with the catalog itself, as sentences. Empty is the passing answer.
 *
 * Content faults are found here rather than by a test so the dev menu can show them on a real device
 * after a content edit, which is where a typo in a stage index actually gets made.
 */
export function achievementContentFaults(): string[] {
  const faults: string[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();

  if (ACHIEVEMENT_TYPES.length > ACHIEVEMENT_CAPACITY) {
    faults.push(
      `${ACHIEVEMENT_TYPES.length} achievements but the save only stores ${ACHIEVEMENT_CAPACITY}`,
    );
  }

  for (const a of ACHIEVEMENT_TYPES) {
    if (seen.has(a.id)) faults.push(`two achievements share the id ${a.id}`);
    seen.add(a.id);
    if (names.has(a.name)) faults.push(`two achievements share the name ${a.name}`);
    names.add(a.name);
    if (a.name.trim() === "") faults.push(`${a.id} has no name`);
    if (a.blurb.trim() === "") faults.push(`${a.id} has no line saying how it is earned`);
    if (!a.icon.startsWith("achievements/")) faults.push(`${a.id} has no badge`);
    if (a.kind === ACH_KIND.profileBestInStage || a.kind === ACH_KIND.runSurvivedStage) {
      if (a.arg < 0 || a.arg >= STAGE_TYPES.length) {
        faults.push(`${a.id} names a place this build does not have`);
      }
    }
    if (a.kind === ACH_KIND.runEndedAs && a.arg < 0) faults.push(`${a.id} names no ending`);
    if (isRunKind(a.kind)) continue;
    if (a.need <= 0) faults.push(`${a.id} asks for nothing`);
  }

  return faults;
}
