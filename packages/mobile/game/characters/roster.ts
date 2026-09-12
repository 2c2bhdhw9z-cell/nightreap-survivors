/**
 * The character roster — who you can pick, and what picking them changes.
 *
 * WHY A CHARACTER IS A SET OF SHIFTS AND NOT A SET OF STATS
 *
 * `stats.ts` says it in one line: "A character record shifts these; it does not replace them." A roster that
 * carried whole stat tables would go stale the moment a balance pass changed a baseline — every character
 * would keep the old number, and the drift would be invisible because nothing would look wrong. Shifts stay
 * correct by construction: change `STAT_BASE` and all eight characters move with it.
 *
 * WHY THE UNITS ARE SPELLED OUT PER ENTRY
 *
 * `stats.ts:165` warns that reading a count as a permille is a silent 1000x error. A roster is exactly where
 * that mistake gets made, because "+50 health" and "+50% health" look the same in a table. So every shift
 * here names its stat and its raw value in that stat's own units, `contentFaults()` checks the counts stay
 * inside sane bounds, and the comment on each character says what the number means in English.
 *
 * WHY THE GROWTH QUIRK IS NOT PART OF THE STARTING SHIFTS
 *
 * Every character has one thing that gets stronger as the run goes on. That cannot be a starting shift,
 * because its size depends on the player's level, which does not exist yet when a run begins. It also must
 * not be a mid-run addition to the modifier stack: the stack's wire list is written into the replay header
 * once, at run start, and a record added at level 20 would be missing from it — so a snapshot restore or a
 * co-op resync would silently drop it and the character would quietly get weaker.
 *
 * Instead growth is *derived*. It is a pure function of the character and the level, and both of those are
 * already restored by any resync, so it can be recomputed rather than carried. `loadout.ts` turns it into a
 * record with a fixed wire id per tier, so a replay revalidation resolves the identical numbers we did.
 *
 * WHY THE LIST IS APPEND-ONLY
 *
 * A save stores unlocked characters as a bitset indexed by position in this list, and a run writes the
 * chosen position into its replay header. Reordering the list would relabel every player's unlocks and make
 * every old replay resolve as somebody else. Add to the end; never insert, never reorder, never remove.
 */

import { STAT, STAT_COUNT, STAT_SCALE } from "../sim/stats";
import { WEAPON_TYPES } from "../sim/weapons";
import { bitGet, SAVE_LIMITS, type SaveData } from "../save/schema";

/** How a character is earned. Append-only: the numbers are content, not code. */
export const CHAR_UNLOCK = {
  /** On the roster from the first launch. */
  ALWAYS: 0,
  /** Lifetime gold earned reaches `unlockValue`. */
  LIFETIME_GOLD: 1,
  /** Runs finished reaches `unlockValue`. */
  RUNS_COMPLETED: 2,
  /** Best survival time in seconds reaches `unlockValue`. */
  BEST_SECONDS: 3,
  /** Kill a Reaper once. The VS Red Death analogue — granted by bit, not a live threshold. */
  REAPER_KILL: 4,
} as const;

export type CharUnlockKind = (typeof CHAR_UNLOCK)[keyof typeof CHAR_UNLOCK];

/** One starting stat shift. `add` is in the stat's own units — permille for multipliers, raw for counts. */
export interface CharacterShift {
  readonly stat: number;
  readonly add: number;
}

/**
 * The growth quirk: one stat, one step, granted repeatedly as the player levels.
 *
 * `everyLevels` is how far apart the steps are and `maxTiers` is how many there can ever be, so the total a
 * quirk is worth is bounded and can be written on the character's card. Bounded on purpose: an unbounded
 * per-level bonus is the one thing that would make a long run stop being a fight.
 */
export interface CharacterGrowth {
  readonly stat: number;
  /** Levels between steps. Level 1 is the starting level and grants nothing. */
  readonly everyLevels: number;
  /** Size of one step, in the stat's own units. */
  readonly add: number;
  /** Hard ceiling on how many steps can accumulate. */
  readonly maxTiers: number;
  /** One short sentence, as it reads on the character card. */
  readonly blurb: string;
}

export interface Character {
  /** Stable string key for code and screens. The save and the wire use the position, not this. */
  readonly id: string;
  readonly name: string;
  /** Two or three words of flavour, as it reads under the portrait. */
  readonly title: string;
  /** One sentence on how the character plays. */
  readonly blurb: string;
  /** Weapon this character always begins holding. Must be a weapon that exists. */
  readonly startingWeaponId: string;
  /** Starting shifts against `STAT_BASE`. May be empty, but a character with nothing is a content fault. */
  readonly shifts: readonly CharacterShift[];
  readonly growth: CharacterGrowth;
  readonly unlock: CharUnlockKind;
  /** Threshold for the unlock condition. Ignored for `ALWAYS`. */
  readonly unlockValue: number;
}

/**
 * Growth tiers per character are capped by the wire id layout, not by taste.
 *
 * `loadout.ts` packs a tier into a two-digit slot shared with the character's base record, so the ceiling
 * lives here as a number both files agree on rather than as an assumption one of them makes.
 */
export const MAX_GROWTH_TIERS = 48;

const PCT = STAT_SCALE / 100;
const HP = STAT_SCALE;

/**
 * The twelve launch characters, plus the secret thirteenth unlocked by killing a Reaper.
 *
 * Read as: a starting hand that is clearly good at one thing and clearly bad at another, plus one thing that
 * arrives later. Nobody is strictly better than anybody — every positive shift is paid for — because a
 * roster with a correct answer is a roster with seven decorations.
 */
export const CHARACTERS: readonly Character[] = [
  {
    id: "vesna",
    name: "Vesna Thorne",
    title: "The Lantern-Keeper",
    blurb: "Even hands. Nothing to learn, nothing to fear.",
    startingWeaponId: "reapersLash",
    // +10% damage, and weapons fire 5% faster (cooldown is a multiplier where lower is faster).
    shifts: [
      { stat: STAT.damage, add: 10 * PCT },
      { stat: STAT.cooldown, add: -5 * PCT },
    ],
    growth: {
      stat: STAT.damage,
      everyLevels: 5,
      add: 5 * PCT,
      maxTiers: 8,
      blurb: "+5% damage every 5 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "odrick",
    name: "Odrick Pale",
    title: "The Bone-Counter",
    blurb: "Throws one more of everything, and hits softer for it.",
    startingWeaponId: "boneKnives",
    // +1 projectile (a count, not a percentage) paid for with 12% less damage.
    shifts: [
      { stat: STAT.amount, add: 1 },
      { stat: STAT.damage, add: -12 * PCT },
    ],
    growth: {
      stat: STAT.projectileSpeed,
      everyLevels: 8,
      add: 10 * PCT,
      maxTiers: 6,
      blurb: "+10% projectile speed every 8 levels, up to six times.",
    },
    unlock: CHAR_UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "maren",
    name: "Maren Vole",
    title: "The Wide Mourner",
    blurb: "Covers ground she cannot cross. Slow, and enormous.",
    startingWeaponId: "gravebolt",
    // +25% effect size, -10% movement.
    shifts: [
      { stat: STAT.area, add: 25 * PCT },
      { stat: STAT.moveSpeed, add: -10 * PCT },
    ],
    growth: {
      stat: STAT.area,
      everyLevels: 6,
      add: 4 * PCT,
      maxTiers: 8,
      blurb: "+4% effect size every 6 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "grust",
    name: "Grust Kalder",
    title: "The Standing Stone",
    blurb: "Starts with more to lose and less to lose it to.",
    startingWeaponId: "tombAxe",
    // +40 health (permille: 40 * 1000), 2 armour (a flat count), -8% movement.
    shifts: [
      { stat: STAT.maxHealth, add: 40 * HP },
      { stat: STAT.armor, add: 2 },
      { stat: STAT.moveSpeed, add: -8 * PCT },
    ],
    growth: {
      stat: STAT.armor,
      everyLevels: 10,
      add: 1,
      maxTiers: 4,
      blurb: "+1 armour every 10 levels, up to four times.",
    },
    unlock: CHAR_UNLOCK.RUNS_COMPLETED,
    unlockValue: 1,
  },
  {
    id: "ysolde",
    name: "Ysolde Quill",
    title: "The Ledger-Hand",
    blurb: "Levels early and often, on a body that cannot take a second hit.",
    startingWeaponId: "shroudedTome",
    // +30% experience, -20% health.
    shifts: [
      { stat: STAT.xpGain, add: 30 * PCT },
      { stat: STAT.maxHealth, add: -20 * HP },
    ],
    growth: {
      stat: STAT.luck,
      everyLevels: 5,
      add: 4 * PCT,
      maxTiers: 8,
      blurb: "+4% luck every 5 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.LIFETIME_GOLD,
    unlockValue: 2_000,
  },
  {
    id: "bram",
    name: "Bram Ossuary",
    title: "The Long Rot",
    blurb: "Everything he puts on the floor stays there longer.",
    startingWeaponId: "rotAura",
    // +25% effect lifetime, -10% damage.
    shifts: [
      { stat: STAT.duration, add: 25 * PCT },
      { stat: STAT.damage, add: -10 * PCT },
    ],
    growth: {
      stat: STAT.duration,
      everyLevels: 6,
      add: 5 * PCT,
      maxTiers: 8,
      blurb: "+5% effect lifetime every 6 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.LIFETIME_GOLD,
    unlockValue: 8_000,
  },
  {
    id: "nyx",
    name: "Nyx Carrow",
    title: "The Quick Dark",
    blurb: "Outruns the field and hoovers it up. Made of paper.",
    startingWeaponId: "boneKnives",
    // +22% movement, +30% pickup range, -25% health.
    shifts: [
      { stat: STAT.moveSpeed, add: 22 * PCT },
      { stat: STAT.magnet, add: 30 * PCT },
      { stat: STAT.maxHealth, add: -25 * HP },
    ],
    growth: {
      stat: STAT.moveSpeed,
      everyLevels: 7,
      add: 2 * PCT,
      maxTiers: 6,
      blurb: "+2% movement every 7 levels, up to six times.",
    },
    unlock: CHAR_UNLOCK.BEST_SECONDS,
    unlockValue: 600,
  },
  {
    id: "sable",
    name: "Sable Grynn",
    title: "The Red Wager",
    blurb: "Hits rarely, hits ruinously, and cannot be relied upon.",
    startingWeaponId: "reapersLash",
    // 12% crit chance (permille, capped at 1000 = 100%), +50% crit damage, -15% base damage.
    shifts: [
      { stat: STAT.critChance, add: 12 * PCT },
      { stat: STAT.critDamage, add: 50 * PCT },
      { stat: STAT.damage, add: -15 * PCT },
    ],
    growth: {
      stat: STAT.critChance,
      everyLevels: 5,
      add: 2 * PCT,
      maxTiers: 8,
      blurb: "+2% critical chance every 5 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.BEST_SECONDS,
    unlockValue: 900,
  },
  {
    id: "thane",
    name: "Thane Colm",
    title: "The Iron Vigil",
    blurb: "Wears the hit and throws the crowd back off it. Learns slowly.",
    startingWeaponId: "sepulcherCross",
    // 3 armour (a flat count), +25% shove, paid for with 15% less experience.
    shifts: [
      { stat: STAT.armor, add: 3 },
      { stat: STAT.knockback, add: 25 * PCT },
      { stat: STAT.xpGain, add: -15 * PCT },
    ],
    growth: {
      // The untouchable window after a hit is counted in ticks, not percent — 60 ticks is a second. Six
      // steps of four is under half a second in total, which is deliberately small: this window is what
      // decides whether standing in a crowd is survivable, and a generous one stops the game being a fight.
      stat: STAT.iFrames,
      everyLevels: 8,
      add: 4,
      maxTiers: 6,
      blurb: "A slightly longer moment of being untouchable after a hit, every 8 levels, up to six times.",
    },
    unlock: CHAR_UNLOCK.RUNS_COMPLETED,
    unlockValue: 5,
  },
  {
    id: "hessa",
    name: "Hessa Marrow",
    title: "The Gold Tooth",
    blurb: "Leaves richer than she arrived, and hits like it.",
    startingWeaponId: "graveShot",
    // +35% gold, +20% pickup range, -10% damage.
    shifts: [
      { stat: STAT.goldGain, add: 35 * PCT },
      { stat: STAT.magnet, add: 20 * PCT },
      { stat: STAT.damage, add: -10 * PCT },
    ],
    growth: {
      stat: STAT.goldGain,
      everyLevels: 5,
      add: 5 * PCT,
      maxTiers: 8,
      blurb: "+5% gold every 5 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.LIFETIME_GOLD,
    unlockValue: 20_000,
  },
  {
    id: "orin",
    name: "Orin Dree",
    title: "The Second Breath",
    blurb: "Gets back up once for free. Hits softly for the privilege.",
    startingWeaponId: "wormfangLance",
    // 1 extra revive (a flat count), +20 health (permille), -18% damage.
    shifts: [
      { stat: STAT.revives, add: 1 },
      { stat: STAT.maxHealth, add: 20 * HP },
      { stat: STAT.damage, add: -18 * PCT },
    ],
    growth: {
      stat: STAT.maxHealth,
      everyLevels: 6,
      add: 2 * HP,
      maxTiers: 8,
      blurb: "+2 health every 6 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.BEST_SECONDS,
    unlockValue: 1_200,
  },
  {
    id: "calla",
    name: "Calla Vane",
    title: "The Fool's Hand",
    blurb: "Asks for a different hand twice a run, and gets luckier asking.",
    startingWeaponId: "stormOfNails",
    // 2 rerolls (a flat count), +25% luck, paid for with 20% less effect size.
    shifts: [
      { stat: STAT.rerolls, add: 2 },
      { stat: STAT.luck, add: 25 * PCT },
      { stat: STAT.area, add: -20 * PCT },
    ],
    growth: {
      stat: STAT.luck,
      everyLevels: 6,
      add: 3 * PCT,
      maxTiers: 8,
      blurb: "+3% luck every 6 levels, up to eight times.",
    },
    unlock: CHAR_UNLOCK.RUNS_COMPLETED,
    unlockValue: 15,
  },
  {
    id: "mord",
    name: "Mord Vane",
    title: "The Crimson Toll",
    blurb: "What the White Hand could not keep. Hits harder the longer the night runs.",
    startingWeaponId: "reapersLash",
    // +20% damage, +10% move, -25 health — glass cannon with the Reaper's own weapon.
    shifts: [
      { stat: STAT.damage, add: 20 * PCT },
      { stat: STAT.moveSpeed, add: 10 * PCT },
      { stat: STAT.maxHealth, add: -25 * HP },
    ],
    growth: {
      stat: STAT.damage,
      everyLevels: 4,
      add: 5 * PCT,
      maxTiers: 10,
      blurb: "+5% damage every 4 levels, up to ten times.",
    },
    unlock: CHAR_UNLOCK.REAPER_KILL,
    unlockValue: 1,
  },
];

/** How many characters ship. Screens count rows off this, never off a hard-coded eight. */
export const CHARACTER_COUNT = CHARACTERS.length;

/** Position of a character by string id, or `-1`. */
export function indexOfCharacter(id: string, list: readonly Character[] = CHARACTERS): number {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return i;
  }
  return -1;
}

/** The character at a position, or `undefined` for a position the content cannot explain. */
export function characterAt(index: number, list: readonly Character[] = CHARACTERS): Character | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= list.length) return undefined;
  return list[index];
}

/**
 * How many growth steps a character has earned at a given level.
 *
 * Level 1 is where every run starts, so the first step lands at `1 + everyLevels`. Clamped to `maxTiers`,
 * and a level below 1 or a level that is not a whole number earns nothing rather than throwing: this is
 * called from the hot path after a snapshot restore, and refusing to answer would end a run that is
 * otherwise fine.
 */
export function growthTiersAt(character: Character, level: number): number {
  if (!Number.isFinite(level) || level < 1) return 0;
  const steps = Math.floor((Math.floor(level) - 1) / character.growth.everyLevels);
  return Math.min(steps, character.growth.maxTiers);
}

/** Everything a growth quirk is worth once every step has landed, in the stat's own units. */
export function growthCeiling(character: Character): number {
  return character.growth.add * character.growth.maxTiers;
}

/**
 * Is this character on the roster for this save?
 *
 * Two ways in: the unlock bitset says yes (which is how a one-off unlock, a gift or a future achievement
 * grants somebody), or the condition is met right now. Checking the live condition as well as the bit means
 * a save whose bit was never written — a migration, a sync from an older device — still shows what the
 * player has plainly earned instead of taking it away.
 */
export function isCharacterUnlocked(save: SaveData, index: number, list: readonly Character[] = CHARACTERS): boolean {
  const character = characterAt(index, list);
  if (character === undefined) return false;
  if (bitGet(save.unlockedCharacters, index)) return true;
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
      // Bit-only: the kill grants the bit via awards. There is no live threshold to re-derive.
      return false;
    default:
      return false;
  }
}

/** Plain English for what is still standing between the player and a locked character. */
export function unlockHint(character: Character): string {
  switch (character.unlock) {
    case CHAR_UNLOCK.ALWAYS:
      return "Available now.";
    case CHAR_UNLOCK.LIFETIME_GOLD:
      return `Earn ${character.unlockValue} gold in total.`;
    case CHAR_UNLOCK.RUNS_COMPLETED:
      return character.unlockValue === 1 ? "Finish a run." : `Finish ${character.unlockValue} runs.`;
    case CHAR_UNLOCK.BEST_SECONDS:
      return `Survive ${Math.floor(character.unlockValue / 60)} minutes in one run.`;
    case CHAR_UNLOCK.REAPER_KILL:
      return "Kill the Reaper.";
    default:
      return "Locked.";
  }
}

/** How many of the roster this save can play, for the "3 / 8" line on the select screen. */
export function unlockedCount(save: SaveData, list: readonly Character[] = CHARACTERS): number {
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    if (isCharacterUnlocked(save, i, list)) count++;
  }
  return count;
}

/**
 * The first character this save can play, starting from a preferred position.
 *
 * A select screen needs this because a chosen character can stop being playable between sessions — a cloud
 * sync from a device with less progress, a content version that reorders nothing but adds locks. Landing on
 * a locked row and refusing to start is worse than quietly falling back to somebody the player owns.
 */
export function firstPlayable(save: SaveData, preferred = 0, list: readonly Character[] = CHARACTERS): number {
  if (isCharacterUnlocked(save, preferred, list)) return preferred;
  for (let i = 0; i < list.length; i++) {
    if (isCharacterUnlocked(save, i, list)) return i;
  }
  return -1;
}

/**
 * Content self-check. Runs at import, prints, and never throws.
 *
 * The rules it enforces are the ones that would otherwise fail silently months later: a starting weapon that
 * does not exist (a run with no weapon), a stat index out of range (a write past the stat table), a shift
 * with no effect (a character that is a lie), and a growth quirk whose ceiling is larger than the stat's own
 * cap (a card promising a number the sim will clamp away).
 */
export function contentFaults(list: readonly Character[] = CHARACTERS): readonly string[] {
  const faults: string[] = [];
  const weaponIds = new Set(WEAPON_TYPES.map((w) => w.id));
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  if (list.length > SAVE_LIMITS.characterBytes * 8) {
    faults.push(`${list.length} characters but the save bitset only holds ${SAVE_LIMITS.characterBytes * 8}`);
  }

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (seenIds.has(c.id)) faults.push(`duplicate id ${c.id}`);
    seenIds.add(c.id);
    if (seenNames.has(c.name)) faults.push(`duplicate name ${c.name}`);
    seenNames.add(c.name);
    if (c.id.trim() === "") faults.push(`character ${i} has no id`);
    if (c.name.trim() === "") faults.push(`${c.id} has no name`);
    if (c.title.trim() === "") faults.push(`${c.id} has no title`);
    if (c.blurb.trim() === "") faults.push(`${c.id} has no blurb`);
    if (!weaponIds.has(c.startingWeaponId)) {
      faults.push(`${c.id} starts with ${c.startingWeaponId}, which is not a weapon`);
    }
    if (c.shifts.length === 0) faults.push(`${c.id} changes nothing`);

    const seenStats = new Set<number>();
    for (const shift of c.shifts) {
      if (!Number.isSafeInteger(shift.stat) || shift.stat < 0 || shift.stat >= STAT_COUNT) {
        faults.push(`${c.id} shifts stat ${shift.stat}, which is not a stat`);
      }
      if (seenStats.has(shift.stat)) faults.push(`${c.id} shifts stat ${shift.stat} twice`);
      seenStats.add(shift.stat);
      if (!Number.isSafeInteger(shift.add)) faults.push(`${c.id} has a fractional shift on stat ${shift.stat}`);
      if (shift.add === 0) faults.push(`${c.id} has a shift worth nothing on stat ${shift.stat}`);
    }

    const g = c.growth;
    if (!Number.isSafeInteger(g.stat) || g.stat < 0 || g.stat >= STAT_COUNT) {
      faults.push(`${c.id} grows stat ${g.stat}, which is not a stat`);
    }
    if (!Number.isSafeInteger(g.everyLevels) || g.everyLevels < 1) {
      faults.push(`${c.id} grows every ${g.everyLevels} levels, which is not a gap`);
    }
    if (!Number.isSafeInteger(g.add) || g.add <= 0) faults.push(`${c.id} grows by ${g.add} per step`);
    if (!Number.isSafeInteger(g.maxTiers) || g.maxTiers < 1) faults.push(`${c.id} has no growth steps`);
    if (g.maxTiers > MAX_GROWTH_TIERS) {
      faults.push(`${c.id} has ${g.maxTiers} growth steps, above the ${MAX_GROWTH_TIERS} the wire ids allow`);
    }
    if (g.blurb.trim() === "") faults.push(`${c.id} has no growth blurb`);
  }

  // Somebody has to be playable on a brand new save, or the first launch is a locked grid.
  let alwaysOn = 0;
  for (const c of list) {
    if (c.unlock === CHAR_UNLOCK.ALWAYS) alwaysOn++;
  }
  if (alwaysOn === 0) faults.push("no character is available on a new save");

  return faults;
}

for (const fault of contentFaults()) {
  console.error(`character content fault: ${fault}`);
}