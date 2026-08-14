/**
 * Chests — what opening one is worth, and the rule that turns a maxed weapon into its evolution.
 *
 * WHY THIS IS ITS OWN FILE
 * A chest is the only place in the game where the *game* chooses an upgrade instead of the player.
 * That makes it the one reward that can feel like a swindle, so the whole decision lives here in one
 * readable pass rather than being spread through the run loop: how many things a chest gives, what
 * those things are allowed to be, what happens when there is genuinely nothing left to give, and
 * above all when a chest is allowed to hand over an evolution.
 *
 * THE EVOLUTION RULE, IN FULL
 * A weapon evolves when three things are true at once:
 *   1. the player has taken it to its top level,
 *   2. the player is carrying the passive item that weapon asks for, and
 *   3. a chest is opened.
 * When that happens the chest is spent on the evolution and nothing else. That is deliberate: an
 * evolution is the biggest single jump in the game, and burying it in a list of four other rewards
 * would make the moment it arrives unreadable. It also means a player who wants an evolution can
 * plan for it — take the weapon up, hold the item, go and find a chest — rather than hoping.
 *
 * ONE EVOLUTION PER CHEST, LOWEST SLOT FIRST
 * If two weapons are both ready, the one in the earlier slot goes first and the other waits for the
 * next chest. Picking "the best one" would need the game to have an opinion about which weapon is
 * better, and it does not have one; slot order is at least something the player can see and control.
 *
 * THE EVOLUTION REPLACES THE WEAPON IN ITS OWN SLOT
 * It is not a seventh weapon. The base weapon is gone, the evolution stands where it stood, and the
 * passive it consumed is *not* taken away — losing an item as the price of an upgrade would punish
 * the player for the upgrade they just earned.
 *
 * A CHEST IS NEVER EMPTY
 * A player carrying six maxed weapons and six maxed passives has nothing left to be given, and an
 * empty chest reads as a bug every single time. When there is nothing to level, the chest pays gold
 * instead — a small amount per reward it could not give, so the reward that could not happen is
 * still visible on the screen rather than silently skipped.
 *
 * EVERY ROLL COMES OUT OF THE CHEST STREAM
 * Nothing in here touches `Math.random` or any other stream. Two phones opening the same chest in the
 * same co-op run get the same rewards, and a replay of a run opens the same chests it opened live.
 */

import { MAX_PASSIVE_LEVEL, PASSIVE_TYPES, type PassiveStore } from "./passives";
import type { Rng } from "../core/rng";
import { STAT, STAT_SCALE, type Stats } from "./stats";
import {
  MAX_WEAPON_LEVEL,
  WEAPON_BY_ID,
  WEAPON_TYPES,
  type WeaponStore,
} from "./weapons";
import { PASSIVE_BY_ID } from "./passives";

/** What one row of a chest's payout is. */
export const CHEST_REWARD = {
  /** A weapon became its evolution. `type` is the *evolved* weapon, `from` the one it replaced. */
  evolution: 0,
  /** A carried weapon gained a level. */
  weaponLevel: 1,
  /** A carried passive gained a level. */
  passiveLevel: 2,
  /** Nothing was left to give, so the chest paid coins. `value` carries the amount. */
  gold: 3,
} as const;

export type ChestRewardKind = (typeof CHEST_REWARD)[keyof typeof CHEST_REWARD];

/**
 * The most rows one chest can produce.
 *
 * Five is the largest number of items a chest is allowed to hand out, so the report is exactly big
 * enough and a row can never be dropped for want of space.
 */
export const MAX_CHEST_REWARDS = 5;

/** Gold paid per reward a chest could not fill because nothing was left to level. */
export const CHEST_CONSOLATION_GOLD = 60;

/**
 * How likely a chest is to be worth 1, 3 or 5 items, per 1024, before luck.
 *
 * The three-item chest is the one players remember, so it is common enough to be a real hope rather
 * than a rumour. Five is rare on purpose: it is the run-defining one.
 */
export const CHEST_ONE_PER_1024 = 700;
export const CHEST_THREE_PER_1024 = 268;
export const CHEST_FIVE_PER_1024 = 56;

/**
 * How much luck moves the odds, per 1024 of luck above the baseline.
 *
 * Luck is a permille stat where 1000 is "normal". Every full point of luck above normal shifts this
 * much weight out of the one-item chest and into the better two, so luck is worth taking for chests
 * without ever making a five-item chest the expected case.
 */
export const CHEST_LUCK_SHIFT = 220;

/** A chest's payout. Fixed size, owned by the caller, refilled per chest. */
export interface ChestReport {
  /** How many rows this chest produced. Never more than `MAX_CHEST_REWARDS`. */
  count: number;
  /** How many items the chest was worth — 1, 3 or 5. */
  size: number;
  /**
   * Which player this chest opened for; -1 before any chest has been opened.
   *
   * A chest is not shared in co-op — it opens for whoever walked into it — so the report has to say
   * whose loadout just changed, or four players read one banner and three of them are wrong.
   */
  player: number;
  /** True when this chest was spent on an evolution and nothing else. */
  evolved: boolean;
  /** Gold this chest paid because it ran out of things to level. */
  goldPaid: number;
  readonly kind: Int32Array;
  /** Weapon or passive index the row is about; -1 for a gold row. */
  readonly type: Int32Array;
  /** For an evolution, the weapon that was replaced. -1 otherwise. */
  readonly from: Int32Array;
  /** New level after the row was applied, or the gold amount for a gold row. */
  readonly value: Int32Array;
}

export function createChestReport(): ChestReport {
  return {
    count: 0,
    size: 0,
    player: -1,
    evolved: false,
    goldPaid: 0,
    kind: new Int32Array(MAX_CHEST_REWARDS),
    type: new Int32Array(MAX_CHEST_REWARDS).fill(-1),
    from: new Int32Array(MAX_CHEST_REWARDS).fill(-1),
    value: new Int32Array(MAX_CHEST_REWARDS),
  };
}

export function resetChestReport(report: ChestReport): void {
  report.count = 0;
  report.size = 0;
  report.player = -1;
  report.evolved = false;
  report.goldPaid = 0;
  report.type.fill(-1);
  report.from.fill(-1);
  report.value.fill(0);
  report.kind.fill(0);
}

function push(
  report: ChestReport,
  kind: ChestRewardKind,
  type: number,
  from: number,
  value: number,
): void {
  if (report.count >= MAX_CHEST_REWARDS) return;
  const at = report.count++;
  report.kind[at] = kind;
  report.type[at] = type;
  report.from[at] = from;
  report.value[at] = value;
}

/**
 * Which weapon this player could evolve right now, or -1.
 *
 * Pure: it reads the loadout and answers. The chest code uses it to decide, and the dev menu and the
 * in-run HUD can use the same answer to hint at it without the two ever disagreeing.
 */
export function evolvableWeapon(
  player: number,
  weapons: WeaponStore,
  passives: PassiveStore,
): number {
  const base = player * 6;
  for (let slot = 0; slot < 6; slot++) {
    const typeIndex = weapons.typeIndex[base + slot];
    if (typeIndex < 0) continue;
    if (weapons.level[base + slot] < MAX_WEAPON_LEVEL) continue;
    const type = WEAPON_TYPES[typeIndex];
    if (type.evolvesTo === "") continue;
    const needed = PASSIVE_BY_ID.get(type.evolveRequires);
    if (needed === undefined) continue;
    if (passives.levelOf(player, needed) < 1) continue;
    if (WEAPON_BY_ID.get(type.evolvesTo) === undefined) continue;
    return typeIndex;
  }
  return -1;
}

/**
 * How many items this chest is worth: 1, 3 or 5.
 *
 * Luck moves weight out of the one-item chest and into the better two. Written as integer weights per
 * 1024 rather than as floating-point probabilities, because a float rolled on two different phones is
 * how a co-op run quietly stops agreeing about what was in a chest.
 */
export function chestSize(stats: Stats, rng: Rng): number {
  const luck = stats.values[STAT.luck];
  const above = luck > STAT_SCALE ? luck - STAT_SCALE : 0;
  let shift = Math.trunc((above * CHEST_LUCK_SHIFT) / STAT_SCALE);
  if (shift > CHEST_ONE_PER_1024) shift = CHEST_ONE_PER_1024;

  const one = CHEST_ONE_PER_1024 - shift;
  // Two thirds of what luck takes from the one-item chest goes to three, one third to five.
  const three = CHEST_THREE_PER_1024 + shift - Math.trunc(shift / 3);
  const roll = rng.nextInt(1024);
  if (roll < one) return 1;
  if (roll < one + three) return 3;
  return 5;
}

/**
 * Open one chest.
 *
 * Applies its rewards to the loadout, fills the report, and returns how many rows it wrote. The
 * caller owns the report and clears it, which is what keeps this allocation-free in a tick.
 *
 * Order of business, and it matters:
 *   1. An evolution, if one is owed. That is the whole chest.
 *   2. Otherwise, 1, 3 or 5 rewards, each a level on something already carried.
 *   3. Anything that could not be filled becomes gold, so no row is ever silently skipped.
 *
 * Levels only ever go to things the player already carries. A chest never hands over a brand new
 * weapon: the player chose the six they are carrying, and a chest that overwrites that choice — or
 * fills the last free slot with something they were saving it for — is a chest that ruined a run.
 */
export function openChest(
  player: number,
  weapons: WeaponStore,
  passives: PassiveStore,
  stats: Stats,
  rng: Rng,
  report: ChestReport,
): number {
  resetChestReport(report);
  report.player = player;

  const evolving = evolvableWeapon(player, weapons, passives);
  if (evolving >= 0) {
    const into = WEAPON_BY_ID.get(WEAPON_TYPES[evolving].evolvesTo);
    if (into !== undefined && weapons.evolveInPlace(player, evolving, into)) {
      report.size = 1;
      report.evolved = true;
      push(report, CHEST_REWARD.evolution, into, evolving, MAX_WEAPON_LEVEL);
      return report.count;
    }
  }

  const size = chestSize(stats, rng);
  report.size = size;

  for (let i = 0; i < size; i++) {
    if (!grantOne(player, weapons, passives, rng, report)) {
      report.goldPaid += CHEST_CONSOLATION_GOLD;
      push(report, CHEST_REWARD.gold, -1, -1, CHEST_CONSOLATION_GOLD);
    }
  }
  return report.count;
}

/**
 * Level one thing the player already carries. Returns false when there is nothing left to level.
 *
 * Chosen uniformly across everything eligible, weapons and passives together in one pool, so a player
 * carrying five weapons and one passive is far more likely to get a weapon level — which is what they
 * built, and what they would have picked themselves.
 */
function grantOne(
  player: number,
  weapons: WeaponStore,
  passives: PassiveStore,
  rng: Rng,
  report: ChestReport,
): boolean {
  // Count first, then pick, then walk to the pick. Two cheap passes and no scratch array, so this
  // costs nothing per chest and cannot allocate inside a tick.
  let eligible = 0;
  const wBase = player * 6;
  for (let slot = 0; slot < 6; slot++) {
    const t = weapons.typeIndex[wBase + slot];
    if (t >= 0 && weapons.level[wBase + slot] < MAX_WEAPON_LEVEL) eligible++;
  }
  for (let i = 0; i < PASSIVE_TYPES.length; i++) {
    const level = passives.levelOf(player, i);
    if (level > 0 && level < MAX_PASSIVE_LEVEL) eligible++;
  }
  if (eligible === 0) return false;

  let pick = rng.nextInt(eligible);
  for (let slot = 0; slot < 6; slot++) {
    const t = weapons.typeIndex[wBase + slot];
    if (t < 0 || weapons.level[wBase + slot] >= MAX_WEAPON_LEVEL) continue;
    if (pick === 0) {
      const level = weapons.grant(player, t);
      push(report, CHEST_REWARD.weaponLevel, t, -1, level);
      return true;
    }
    pick--;
  }
  for (let i = 0; i < PASSIVE_TYPES.length; i++) {
    const level = passives.levelOf(player, i);
    if (level <= 0 || level >= MAX_PASSIVE_LEVEL) continue;
    if (pick === 0) {
      const next = passives.grant(player, i);
      push(report, CHEST_REWARD.passiveLevel, i, -1, next);
      return true;
    }
    pick--;
  }
  return false;
}

/** One line per row, for the results screen and the dev menu. Never used for a decision. */
export function rewardLine(report: ChestReport, row: number): string {
  if (row < 0 || row >= report.count) return "";
  const kind = report.kind[row];
  if (kind === CHEST_REWARD.evolution) {
    const from = report.from[row];
    const into = report.type[row];
    return `${WEAPON_TYPES[from].name} became ${WEAPON_TYPES[into].name}`;
  }
  if (kind === CHEST_REWARD.weaponLevel) {
    return `${WEAPON_TYPES[report.type[row]].name} to level ${report.value[row]}`;
  }
  if (kind === CHEST_REWARD.passiveLevel) {
    return `${PASSIVE_TYPES[report.type[row]].name} to level ${report.value[row]}`;
  }
  return `${report.value[row]} gold`;
}

/**
 * Content self-check, run at import.
 *
 * The chest sizes have to be the only three sizes there are and the weights have to total exactly
 * 1024, or a roll would fall off the end of the table and quietly return the last entry every time.
 */
export function contentFaults(): readonly string[] {
  const faults: string[] = [];
  const total = CHEST_ONE_PER_1024 + CHEST_THREE_PER_1024 + CHEST_FIVE_PER_1024;
  if (total !== 1024) faults.push(`chest size weights total ${total}, not 1024`);
  if (MAX_CHEST_REWARDS < 5) faults.push("a five-item chest cannot fit in the report");
  if (CHEST_CONSOLATION_GOLD < 1) faults.push("a chest that runs out of upgrades would pay nothing");
  if (CHEST_LUCK_SHIFT < 1) faults.push("luck would not affect chests at all");
  return faults;
}

const faults = contentFaults();
if (faults.length > 0) {
  throw new Error(`chests.ts content faults:\n  ${faults.join("\n  ")}`);
}
