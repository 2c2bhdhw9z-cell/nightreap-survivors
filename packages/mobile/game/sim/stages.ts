/**
 * The five places you can play, and what comes out of the dark on each of them.
 *
 * WHY A STAGE IS A TABLE AND NOT A LEVEL
 * There is no level geometry in this game. A stage is an endless floor, so the only things that make
 * one stage different from another are the pictures under your feet, the mix of monsters that walks
 * at you, when the named fights arrive, and how long the run lasts. All four of those are numbers, so
 * a stage is a row in a table — which means a new stage is a data change, not a code change, and the
 * dev menu can start any of them without a single branch anywhere in the simulation.
 *
 * WHY THE WAVE TABLE LIVES ON THE STAGE
 * The director already takes a wave table as an argument (`WaveDirector.begin`), precisely so that it
 * never has to know what a stage is. The stage owns the table; the director reads it. Nothing in the
 * simulation ever asks "which stage is this" to decide behaviour — if a stage wants different
 * behaviour, it says so in its numbers.
 *
 * WHY THE ART IS A KEY AND NOT A PICTURE
 * This file is simulation. It cannot import the art table, because the art table already imports the
 * simulation's tables to work out what needs a picture, and a cycle between them would be a real
 * problem at load time on a phone. So a stage carries the *name* of its art set, and a check on the
 * art side proves every one of those names exists. A missing set is a failed check, never a stage
 * that quietly loads with no floor.
 *
 * APPEND-ONLY, LIKE EVERY OTHER TABLE HERE
 * A stage's wire id travels in replay headers, co-op join messages and leaderboard rows. Reordering
 * this table would repoint every recording ever made at the wrong stage, so new stages go on the end
 * and nothing ever moves.
 */

import { ENEMY_FLAG, ENEMY_TYPE_BY_ID, ENEMY_TYPES, UNSCHEDULED_BOSS_IDS } from "./enemies";
import type { WaveEntry } from "./waves";

/** Ticks per simulated second. Mirrors the director's own constant; the check below proves they agree. */
const SECONDS = 60;

/** The longest a standard run goes before the Reaper arrives, in seconds. */
export const STANDARD_RUN_SECONDS = 30 * SECONDS;

/**
 * Hard ceiling on how many enemies a wave may ask to be alive at once.
 *
 * The engine's own gate is eight hundred bodies at sixty frames a second on the cheapest phone we
 * support. A wave table is the one place in the whole game that can quietly walk past that gate, so
 * the ceiling is restated here and a check refuses any row that crosses it. A stage that needs more
 * pressure gets tougher monsters, not more of them.
 */
export const MAX_LIVE_CAP = 800;

/** Ceiling on spawns per second in any one wave, for the same reason. */
export const MAX_PER_SECOND = 24;

/** How a stage is opened up. */
export const STAGE_UNLOCK = {
  /** Available from the first time the game is opened. */
  always: 0,
  /** Opened by surviving a named earlier stage for a number of seconds. */
  survive: 1,
} as const;

export interface StageUnlock {
  readonly kind: number;
  /** Stage that has to be survived. Empty for `always`. */
  readonly stage: string;
  /** How long it has to be survived for, in seconds. Zero for `always`. */
  readonly seconds: number;
}

export interface StageType {
  /** Stable name used in code, saves and tables. Never shown to a player. */
  readonly id: string;
  /** Position on the wire. Append-only, starts at 1, no gaps. */
  readonly wireId: number;
  /** What the stage select screen calls it. */
  readonly name: string;
  /** One line under the name. Says what the stage does to you, not what it looks like. */
  readonly blurb: string;
  /** Which set of floor and scenery pictures this stage draws. Resolved by the art table, not here. */
  readonly artKey: string;
  /** Everything that walks at you, and when. */
  readonly waves: readonly WaveEntry[];
  /** When the Reaper arrives and the run ends, in seconds. */
  readonly reaperSecond: number;
  /**
   * How often a scenery cell holds something, out of 1024.
   *
   * Scenery is derived from the seed rather than stored, so this is the only dial: a marsh that is
   * meant to feel choked sets it high, a bare gallows field sets it low. Props never block movement,
   * so this only ever changes how much there is to break, never where you can walk.
   */
  readonly propChance: number;
  /** How this stage is opened up. */
  readonly unlock: StageUnlock;
}

/** Build one wave row. Compact on purpose: the shape of the curve should be readable at a glance. */
function wave(
  atSecond: number,
  perSecond: number,
  liveCap: number,
  mix: readonly (readonly [string, number])[],
  boss?: string,
): WaveEntry {
  const entry: WaveEntry = {
    atSecond,
    perSecond,
    liveCap,
    mix: mix.map(([id, weight]) => ({ id, weight })),
    ...(boss === undefined ? {} : { boss }),
  };
  return entry;
}

/**
 * Stage one. The tutorial that never says it is one.
 *
 * Thirty seconds of almost nothing so the stick is learned, one kind of monster until minute two, and
 * the first named fight at five. Everything here can be walked away from — this is the only stage
 * where that is true, and it is why it is the one the game starts you on.
 */
const CRYPT_WAVES: readonly WaveEntry[] = [
  wave(0, 1.2, 40, [["shambler", 100]]),
  wave(30, 2.4, 70, [
    ["shambler", 80],
    ["gnawer", 20],
  ]),
  wave(90, 4, 110, [
    ["shambler", 55],
    ["gnawer", 45],
  ]),
  wave(150, 6, 160, [
    ["shambler", 40],
    ["gnawer", 40],
    ["hound", 20],
  ]),
  wave(210, 8, 230, [
    ["gnawer", 45],
    ["hound", 25],
    ["bonepile", 15],
    ["wisp", 15],
  ]),
  wave(
    300,
    9,
    300,
    [
      ["gnawer", 40],
      ["shambler", 25],
      ["hound", 20],
      ["bonepile", 15],
    ],
    "gravewarden",
  ),
  wave(420, 12, 380, [
    ["gnawer", 50],
    ["hound", 25],
    ["wisp", 15],
    ["bonepile", 10],
  ]),
  wave(540, 14, 450, [
    ["graveling", 40],
    ["hound", 25],
    ["bonepile", 20],
    ["wisp", 15],
  ]),
  wave(
    720,
    15,
    520,
    [
      ["graveling", 35],
      ["gnawer", 30],
      ["hound", 20],
      ["pallbearer", 15],
    ],
    "bellmaster",
  ),
  wave(900, 16, 580, [
    ["graveling", 35],
    ["wightling", 25],
    ["hound", 20],
    ["pallbearer", 20],
  ]),
  wave(1140, 17, 640, [
    ["wightling", 35],
    ["graveling", 25],
    ["bonehound", 25],
    ["pallbearer", 15],
  ]),
  wave(
    1380,
    18,
    700,
    [
      ["wightling", 35],
      ["bonehound", 25],
      ["pallbearer", 20],
      ["nightcap", 20],
    ],
    "carrionKing",
  ),
  wave(1620, 19, 760, [
    ["wightling", 30],
    ["bonehound", 30],
    ["nightcap", 20],
    ["pallbearer", 20],
  ]),
];

/**
 * Stage two. Open floor and things that will not be shoved.
 *
 * The ossuary's answer to a player who has learned to walk backwards through a crowd is weight: brutes
 * early, and enough of them that a knockback build stops being a get-out clause and becomes one tool
 * among several.
 */
const OSSUARY_WAVES: readonly WaveEntry[] = [
  wave(0, 2, 60, [
    ["shambler", 60],
    ["marrowbeetle", 40],
  ]),
  wave(45, 4, 110, [
    ["marrowbeetle", 50],
    ["shambler", 30],
    ["bonepile", 20],
  ]),
  wave(120, 6.5, 170, [
    ["marrowbeetle", 45],
    ["bonepile", 30],
    ["graveling", 25],
  ]),
  wave(
    240,
    9,
    260,
    [
      ["marrowbeetle", 40],
      ["bonepile", 30],
      ["graveling", 20],
      ["tomblurker", 10],
    ],
    "bellmaster",
  ),
  wave(360, 11, 340, [
    ["marrowbeetle", 35],
    ["bonepile", 25],
    ["tomblurker", 20],
    ["wightling", 20],
  ]),
  wave(540, 13, 430, [
    ["wightling", 35],
    ["bonepile", 25],
    ["tomblurker", 20],
    ["pallbearer", 20],
  ]),
  wave(
    780,
    15,
    520,
    [
      ["wightling", 30],
      ["pallbearer", 30],
      ["tomblurker", 20],
      ["nightcap", 20],
    ],
    "ossuaryTitan",
  ),
  wave(1020, 17, 600, [
    ["pallbearer", 35],
    ["wightling", 25],
    ["nightcap", 20],
    ["rotswine", 20],
  ]),
  wave(1260, 18, 670, [
    ["rotswine", 30],
    ["pallbearer", 30],
    ["nightcap", 20],
    ["wightling", 20],
  ]),
  wave(
    1500,
    19,
    740,
    [
      ["rotswine", 35],
      ["pallbearer", 30],
      ["nightcap", 25],
      ["marrowbeetle", 10],
    ],
    "hollowMother",
  ),
  wave(1680, 20, 780, [
    ["rotswine", 35],
    ["nightcap", 30],
    ["pallbearer", 25],
    ["wightling", 10],
  ]),
];

/**
 * Stage three. Nothing comes at you in a straight line.
 *
 * Weavers, circlers and the things that sit still in the reeds until you touch them. A build that only
 * fires forward starves here, which is the entire point of the stage.
 */
const MARSH_WAVES: readonly WaveEntry[] = [
  wave(0, 2.2, 60, [
    ["crawler", 70],
    ["bloatfly", 30],
  ]),
  wave(45, 4.5, 120, [
    ["crawler", 45],
    ["bloatfly", 35],
    ["gravemoth", 20],
  ]),
  wave(120, 7, 190, [
    ["bloatfly", 35],
    ["gravemoth", 30],
    ["crawler", 20],
    ["wisp", 15],
  ]),
  wave(
    240,
    9.5,
    270,
    [
      ["gravemoth", 30],
      ["bloatfly", 25],
      ["wisp", 25],
      ["tomblurker", 20],
    ],
    "hollowMother",
  ),
  wave(390, 12, 360, [
    ["gravemoth", 30],
    ["shrieker", 25],
    ["tomblurker", 25],
    ["wisp", 20],
  ]),
  wave(570, 14, 450, [
    ["shrieker", 30],
    ["gravemoth", 25],
    ["tomblurker", 25],
    ["nightcap", 20],
  ]),
  wave(
    810,
    16,
    540,
    [
      ["shrieker", 30],
      ["nightcap", 25],
      ["tomblurker", 25],
      ["gravemoth", 20],
    ],
    "plagueChoir",
  ),
  wave(1050, 17.5, 620, [
    ["shrieker", 30],
    ["nightcap", 30],
    ["ripper", 20],
    ["tomblurker", 20],
  ]),
  wave(1290, 19, 700, [
    ["nightcap", 30],
    ["ripper", 25],
    ["shrieker", 25],
    ["rotswine", 20],
  ]),
  wave(
    1530,
    20,
    760,
    [
      ["ripper", 30],
      ["nightcap", 30],
      ["rotswine", 20],
      ["shrieker", 20],
    ],
    "dirgeWarden",
  ),
  wave(1680, 21, 790, [
    ["ripper", 35],
    ["nightcap", 30],
    ["rotswine", 20],
    ["shrieker", 15],
  ]),
];

/**
 * Stage four. Everything here is faster than you are.
 *
 * Chargers and flankers from the first minute. You cannot outrun anything on the gallows, so the stage
 * is about where you stand rather than where you run, and standing still is also fatal.
 */
const GALLOWS_WAVES: readonly WaveEntry[] = [
  wave(0, 2.6, 70, [
    ["hound", 60],
    ["crawler", 40],
  ]),
  wave(40, 5, 130, [
    ["hound", 45],
    ["bonehound", 30],
    ["crawler", 25],
  ]),
  wave(110, 8, 200, [
    ["bonehound", 35],
    ["hound", 30],
    ["ripper", 20],
    ["rotswine", 15],
  ]),
  wave(
    210,
    10.5,
    290,
    [
      ["bonehound", 30],
      ["ripper", 25],
      ["hound", 25],
      ["rotswine", 20],
    ],
    "carrionKing",
  ),
  wave(360, 13, 380, [
    ["ripper", 30],
    ["bonehound", 30],
    ["rotswine", 25],
    ["wightling", 15],
  ]),
  wave(540, 15, 470, [
    ["ripper", 35],
    ["rotswine", 25],
    ["bonehound", 25],
    ["pallbearer", 15],
  ]),
  wave(
    750,
    17,
    560,
    [
      ["ripper", 35],
      ["rotswine", 30],
      ["bonehound", 20],
      ["pallbearer", 15],
    ],
    "dirgeWarden",
  ),
  wave(990, 18.5, 640, [
    ["ripper", 35],
    ["rotswine", 30],
    ["nightcap", 20],
    ["pallbearer", 15],
  ]),
  wave(1230, 20, 710, [
    ["ripper", 35],
    ["rotswine", 30],
    ["bonehound", 20],
    ["nightcap", 15],
  ]),
  wave(
    1470,
    21,
    770,
    [
      ["ripper", 40],
      ["rotswine", 30],
      ["nightcap", 20],
      ["pallbearer", 10],
    ],
    "graveTyrant",
  ),
  wave(1680, 22, 795, [
    ["ripper", 40],
    ["rotswine", 30],
    ["nightcap", 20],
    ["bonehound", 10],
  ]),
];

/**
 * Stage five. The whole game at once.
 *
 * Every archetype from minute one, four named fights, and a first wave heavier than stage one's last.
 * This is the stage the numbers are balanced against — if a build survives the belfry to thirty
 * minutes it is a build, and if it only survives the crypt it is a preference.
 */
const BELFRY_WAVES: readonly WaveEntry[] = [
  wave(0, 3.5, 90, [
    ["gnawer", 40],
    ["hound", 30],
    ["bloatfly", 30],
  ]),
  wave(40, 6.5, 160, [
    ["gnawer", 30],
    ["hound", 25],
    ["gravemoth", 25],
    ["bonepile", 20],
  ]),
  wave(
    120,
    9.5,
    250,
    [
      ["bonehound", 30],
      ["gravemoth", 25],
      ["bonepile", 25],
      ["shrieker", 20],
    ],
    "ossuaryTitan",
  ),
  wave(260, 12, 340, [
    ["bonehound", 30],
    ["shrieker", 25],
    ["wightling", 25],
    ["pallbearer", 20],
  ]),
  wave(
    420,
    14.5,
    440,
    [
      ["wightling", 30],
      ["bonehound", 25],
      ["pallbearer", 25],
      ["ripper", 20],
    ],
    "plagueChoir",
  ),
  wave(600, 16.5, 530, [
    ["ripper", 30],
    ["wightling", 25],
    ["pallbearer", 25],
    ["nightcap", 20],
  ]),
  wave(
    840,
    18,
    610,
    [
      ["ripper", 30],
      ["rotswine", 25],
      ["nightcap", 25],
      ["pallbearer", 20],
    ],
    "dirgeWarden",
  ),
  wave(1080, 19.5, 680, [
    ["rotswine", 30],
    ["ripper", 30],
    ["nightcap", 25],
    ["wightling", 15],
  ]),
  wave(1320, 21, 740, [
    ["rotswine", 30],
    ["nightcap", 30],
    ["ripper", 25],
    ["pallbearer", 15],
  ]),
  wave(
    1560,
    22,
    790,
    [
      ["nightcap", 35],
      ["rotswine", 30],
      ["ripper", 25],
      ["pallbearer", 10],
    ],
    "graveTyrant",
  ),
  wave(1680, 23, 800, [
    ["nightcap", 35],
    ["rotswine", 30],
    ["ripper", 25],
    ["wightling", 10],
  ]),
];

/** The five stages that ship. Append-only. */
export const STAGE_TYPES: readonly StageType[] = [
  {
    id: "paupersCrypt",
    wireId: 1,
    name: "Pauper's Crypt",
    blurb: "Slow, shallow, and forgiving. The only floor here that lets you make a mistake.",
    artKey: "crypt",
    waves: CRYPT_WAVES,
    reaperSecond: STANDARD_RUN_SECONDS,
    propChance: 240,
    unlock: { kind: STAGE_UNLOCK.always, stage: "", seconds: 0 },
  },
  {
    id: "theOssuary",
    wireId: 2,
    name: "The Ossuary",
    blurb: "Bone floors and bodies that will not be shoved. Knockback stops saving you here.",
    artKey: "ossuary",
    waves: OSSUARY_WAVES,
    reaperSecond: STANDARD_RUN_SECONDS,
    propChance: 200,
    unlock: { kind: STAGE_UNLOCK.survive, stage: "paupersCrypt", seconds: 15 * SECONDS },
  },
  {
    id: "mournersMarsh",
    wireId: 3,
    name: "Mourner's Marsh",
    blurb: "Nothing walks at you in a straight line, and some of it is not walking yet.",
    artKey: "marsh",
    waves: MARSH_WAVES,
    reaperSecond: STANDARD_RUN_SECONDS,
    propChance: 320,
    unlock: { kind: STAGE_UNLOCK.survive, stage: "theOssuary", seconds: 15 * SECONDS },
  },
  {
    id: "gallowsRow",
    wireId: 4,
    name: "Gallows Row",
    blurb: "Everything out here is faster than you. Standing still is also fatal.",
    artKey: "gallows",
    waves: GALLOWS_WAVES,
    reaperSecond: STANDARD_RUN_SECONDS,
    propChance: 150,
    unlock: { kind: STAGE_UNLOCK.survive, stage: "mournersMarsh", seconds: 20 * SECONDS },
  },
  {
    id: "hollowBelfry",
    wireId: 5,
    name: "The Hollow Belfry",
    blurb: "Every kind of thing, from the first minute, until the bell stops.",
    artKey: "belfry",
    waves: BELFRY_WAVES,
    reaperSecond: STANDARD_RUN_SECONDS,
    propChance: 260,
    unlock: { kind: STAGE_UNLOCK.survive, stage: "gallowsRow", seconds: 20 * SECONDS },
  },
];

export const STAGE_BY_ID: ReadonlyMap<string, number> = new Map(STAGE_TYPES.map((s, i) => [s.id, i]));

export const STAGE_BY_WIRE: ReadonlyMap<number, number> = new Map(
  STAGE_TYPES.map((s, i) => [s.wireId, i]),
);

/**
 * The stage a run index means.
 *
 * Out of range answers stage one rather than throwing. A run started with a stage that does not exist
 * is a bug in a menu, and the honest failure for that is the player getting the first stage — not the
 * game closing itself on a phone.
 */
export function stageAt(index: number): StageType {
  const i = index | 0;
  return STAGE_TYPES[i >= 0 && i < STAGE_TYPES.length ? i : 0];
}

/** The wave table a run index should be played with. */
export function wavesForStage(index: number): readonly WaveEntry[] {
  return stageAt(index).waves;
}

/**
 * Whether a stage is open, given how long the account has survived on each stage.
 *
 * The best-times record is passed in rather than read from a save, because this file knows nothing
 * about saves and because the same rule has to answer for a real profile, for a fresh profile, and
 * for the dev menu's "everything unlocked" switch without any of them being a special case.
 */
export function stageUnlocked(stage: StageType, bestSeconds: Readonly<Record<string, number>>): boolean {
  if (stage.unlock.kind === STAGE_UNLOCK.always) return true;
  const best = bestSeconds[stage.unlock.stage] ?? 0;
  return best >= stage.unlock.seconds;
}

/** Every stage currently open, in table order. */
export function unlockedStages(bestSeconds: Readonly<Record<string, number>>): StageType[] {
  return STAGE_TYPES.filter((s) => stageUnlocked(s, bestSeconds));
}

/** What a locked stage's card should say instead of "play". Empty when the stage is open. */
export function unlockText(stage: StageType, bestSeconds: Readonly<Record<string, number>>): string {
  if (stageUnlocked(stage, bestSeconds)) return "";
  const required = STAGE_TYPES[STAGE_BY_ID.get(stage.unlock.stage) ?? 0];
  const minutes = Math.round(stage.unlock.seconds / SECONDS);
  return `Survive ${minutes} minutes on ${required.name}`;
}

/** Every named fight a stage holds, in the order they arrive. */
export function bossesOf(stage: StageType): string[] {
  const out: string[] = [];
  for (const w of stage.waves) {
    if (w.boss !== undefined) out.push(w.boss);
  }
  return out;
}

/**
 * Everything wrong with the stage table, in plain words.
 *
 * The same shape as the weapon and enemy content checks: this returns the faults, the test prints
 * them and fails. Keeping it here rather than in the test means the dev menu can run it on a real
 * device against the shipped tables, which is where a bad live-ops table would actually show up.
 */
export function stageContentFaults(list: readonly StageType[] = STAGE_TYPES): readonly string[] {
  const faults: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const artKeys = new Set<string>();
  const bossesSeen = new Set<string>();
  const enemiesSeen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const where = `stage ${s.id}`;

    if (s.id.length === 0) faults.push(`stage ${i} has no id`);
    if (ids.has(s.id)) faults.push(`${where}: two stages share an id`);
    ids.add(s.id);
    if (s.name.length === 0) faults.push(`${where}: has no name`);
    if (names.has(s.name)) faults.push(`${where}: two stages share the name "${s.name}"`);
    names.add(s.name);
    if (s.blurb.length === 0) faults.push(`${where}: has no blurb`);
    if (s.artKey.length === 0) faults.push(`${where}: has no art set`);
    if (artKeys.has(s.artKey)) faults.push(`${where}: shares an art set with an earlier stage`);
    artKeys.add(s.artKey);

    if (s.wireId !== i + 1) faults.push(`${where}: wire id is ${s.wireId}, expected ${i + 1}`);
    if (s.wireId > 255) faults.push(`${where}: wire id does not fit in a byte`);
    if (s.propChance < 0 || s.propChance > 1024) {
      faults.push(`${where}: scenery chance ${s.propChance} is not between 0 and 1024`);
    }
    if (s.reaperSecond < 10 * SECONDS) faults.push(`${where}: the run ends before it starts`);

    // Unlocks
    if (s.unlock.kind === STAGE_UNLOCK.always) {
      if (i !== 0) faults.push(`${where}: only the first stage may be open from the start`);
      if (s.unlock.stage.length > 0 || s.unlock.seconds !== 0) {
        faults.push(`${where}: an always-open stage must not name a requirement`);
      }
    } else {
      if (i === 0) faults.push(`${where}: the first stage must be open from the start`);
      const req = STAGE_BY_ID.get(s.unlock.stage);
      if (req === undefined) faults.push(`${where}: needs "${s.unlock.stage}", which is not a stage`);
      else {
        if (req >= i) faults.push(`${where}: needs a stage that is not open before it`);
        // The threshold is time survived on the REQUIRED stage, so it has to be reachable on THAT
        // stage's clock, not this one's. `>=` and not `>`: a run on the required stage ends the
        // instant its Reaper arrives (tickReaper, run.ts:598), and whether a survival time exactly
        // equal to that second is credited before or after the run ends depends on tick ordering.
        // Rather than lean on that ordering, equality is forbidden outright — a threshold that can
        // only be met on the very frame the run ends is not a threshold anyone should ship.
        const required = list.find((r) => r.id === s.unlock.stage);
        if (required !== undefined && s.unlock.seconds >= required.reaperSecond) {
          faults.push(
            `${where}: needs ${s.unlock.seconds}s survived on ${required.id}, but a run there ends at ${required.reaperSecond}s`,
          );
        }
      }
      if (s.unlock.seconds <= 0) faults.push(`${where}: asks for a survival time of zero`);
      if (s.unlock.seconds > s.reaperSecond) {
        faults.push(`${where}: asks for longer than a run on that stage can last`);
      }
    }

    // The wave table
    const waves = s.waves;
    if (waves.length === 0) {
      faults.push(`${where}: has no waves`);
      continue;
    }
    if (waves[0].atSecond !== 0) faults.push(`${where}: does not start at second zero`);
    const last = waves[waves.length - 1];
    if (last.atSecond > s.reaperSecond - 60) {
      faults.push(`${where}: the last wave lands too near the Reaper to be played`);
    }
    if (last.atSecond < s.reaperSecond - 300) {
      faults.push(`${where}: stops changing more than five minutes before the Reaper`);
    }

    const stageBosses = new Set<string>();
    for (let w = 0; w < waves.length; w++) {
      const entry = waves[w];
      const at = `${where} wave ${w}`;
      if (w > 0 && entry.atSecond <= waves[w - 1].atSecond) {
        faults.push(`${at}: arrives before the wave in front of it`);
      }
      if (w > 0 && entry.perSecond < waves[w - 1].perSecond) {
        faults.push(`${at}: the pressure drops instead of building`);
      }
      if (w > 0 && entry.liveCap < waves[w - 1].liveCap) {
        faults.push(`${at}: the crowd limit drops instead of building`);
      }
      if (entry.perSecond <= 0) faults.push(`${at}: spawns nothing`);
      if (entry.perSecond > MAX_PER_SECOND) faults.push(`${at}: spawns faster than the engine budget`);
      if (entry.liveCap <= 0) faults.push(`${at}: allows nothing to be alive`);
      if (entry.liveCap > MAX_LIVE_CAP) faults.push(`${at}: allows more bodies than the engine gate`);

      if (entry.mix.length === 0) faults.push(`${at}: has an empty mix`);
      if (entry.mix.length > 8) faults.push(`${at}: mixes more kinds than a wave can read as one idea`);
      const seen = new Set<string>();
      let total = 0;
      for (const m of entry.mix) {
        const index = ENEMY_TYPE_BY_ID.get(m.id);
        if (index === undefined) {
          faults.push(`${at}: mixes in "${m.id}", which is not an enemy`);
          continue;
        }
        if ((ENEMY_TYPES[index].flags & ENEMY_FLAG.boss) !== 0) {
          faults.push(`${at}: mixes a named fight into the crowd`);
        }
        if (seen.has(m.id)) faults.push(`${at}: names "${m.id}" twice`);
        seen.add(m.id);
        enemiesSeen.add(m.id);
        if (m.weight <= 0) faults.push(`${at}: "${m.id}" is in the mix with no chance of appearing`);
        total += m.weight;
      }
      if (total <= 0) faults.push(`${at}: every weight in the mix is zero`);

      if (entry.boss !== undefined) {
        const index = ENEMY_TYPE_BY_ID.get(entry.boss);
        if (index === undefined) faults.push(`${at}: names "${entry.boss}", which is not an enemy`);
        else if ((ENEMY_TYPES[index].flags & ENEMY_FLAG.boss) === 0) {
          faults.push(`${at}: sends "${entry.boss}" as a named fight, but it is ordinary`);
        }
        if (stageBosses.has(entry.boss)) faults.push(`${at}: fights "${entry.boss}" twice on one stage`);
        stageBosses.add(entry.boss);
        bossesSeen.add(entry.boss);
        if (entry.atSecond >= s.reaperSecond) faults.push(`${at}: a named fight arrives after the Reaper`);
      }
    }
    if (stageBosses.size < 2) faults.push(`${where}: fewer than two named fights in a whole run`);
  }

  // Coverage: content nobody can see is content that was not made. The exception is a named fight
  // that something other than the wave director spawns — the Reaper arrives on the run's own timer,
  // so demanding a stage schedule for it would report a fault against working content.
  for (const e of ENEMY_TYPES) {
    const isBoss = (e.flags & ENEMY_FLAG.boss) !== 0;
    if (isBoss) {
      if (UNSCHEDULED_BOSS_IDS.includes(e.id)) continue;
      if (!bossesSeen.has(e.id)) faults.push(`the named fight "${e.id}" is never scheduled on any stage`);
    } else if (!enemiesSeen.has(e.id)) {
      faults.push(`the enemy "${e.id}" never appears on any stage`);
    }
  }

  return faults;
}
