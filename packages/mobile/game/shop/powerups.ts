/**
 * The PowerUps shop: the permanent upgrades gold is spent on.
 *
 * This is the whole reason gold exists. A run pays out, the payout lands in the profile, and this is where
 * it turns into something the player can feel on the next run. Everything here is content plus arithmetic —
 * no React, no storage, no clock — so all of it is testable, and the screen on top of it does nothing but
 * draw and press buttons.
 *
 * THE RULES, AND WHY EACH ONE IS A RULE
 *
 * 1. A PURCHASE IS ALL OR NOTHING. Gold leaves the profile and the rank goes up in the same call, or
 *    neither happens. There is no path that takes the money and does not deliver the rank, and none that
 *    delivers the rank without taking the money. Every refusal is checked before the first write.
 *
 * 2. THE COST OF THE NEXT RANK IS ALWAYS DERIVED, NEVER STORED. Storing the price the player was quoted
 *    means two places can disagree about it. The rank is the only thing in the save; the price is a
 *    function of the rank.
 *
 * 3. A REFUND RETURNS EVERY COIN. Not 80%, not "minus a restocking fee". The refund exists so a player who
 *    spent four thousand gold on the wrong build is not punished for experimenting, and a refund that
 *    quietly costs 20% teaches people not to experiment — which is the opposite of the point. It is
 *    computed by summing the same cost function that charged them, so it cannot drift from what they paid.
 *
 * 4. A LOCKED POWERUP CANNOT BE BOUGHT, AND SAYS WHY. Locks are data, not code: each one names a
 *    condition and a number, so a screen can print "unlocks at 5,000 lifetime gold" without knowing
 *    anything about how locks work.
 *
 * 5. THE SHOP NEVER READS A RANK IT DOES NOT UNDERSTAND. The save has a fixed 32 rank slots and the
 *    content list is shorter than that on purpose, so adding a powerup later needs no migration. A rank
 *    sitting in a slot past the end of the list is ignored rather than trusted.
 *
 * 6. STATS ARE APPLIED IN PERMILLE, LIKE EVERY OTHER STAT IN THE GAME. No floats anywhere near the
 *    simulation, so two phones cannot disagree about what a rank was worth.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Which powerups a *character* starts with, and character-specific price modifiers. Characters are a later
 * item; when they land they modify the numbers this file produces rather than replacing them.
 */

import { STAT, STAT_SCALE, STAT_COUNT } from "../sim/stats";
import { SAVE_LIMITS, type SaveData } from "../save/schema";

/** The u32 ceiling every banked total shares. Same one the payout uses, for the same reason. */
export const GOLD_MAX = 4294967295;

/** Prices are rounded up to this, so no price ever reads like a supermarket shelf. */
export const PRICE_STEP = 10;

/** How a powerup's effect is applied to the stat it touches. */
export const EFFECT = {
  /** Adds to a multiplier stat, in permille. `+100` is "+10%". */
  PERCENT: 0,
  /** Adds a flat amount to a flat stat, in permille of one unit. */
  FLAT: 1,
} as const;

export type EffectKind = (typeof EFFECT)[keyof typeof EFFECT];

/** What has to be true before a powerup appears for sale. */
export const UNLOCK = {
  /** Available from the first launch. */
  ALWAYS: 0,
  /** Lifetime gold earned reaches `value`. */
  LIFETIME_GOLD: 1,
  /** Runs finished reaches `value`. */
  RUNS_COMPLETED: 2,
  /** Best survival time in seconds reaches `value`. */
  BEST_SECONDS: 3,
  /** Another powerup, named by `requires`, reaches rank `value`. */
  POWERUP_RANK: 4,
} as const;

export type UnlockKind = (typeof UNLOCK)[keyof typeof UNLOCK];

export interface PowerUp {
  /** Stable string id. Saved nowhere — the save uses the position in this list — but used by every screen. */
  id: string;
  name: string;
  /** One short sentence, sentence case, as it reads on the shop row. */
  blurb: string;
  /** The stat it moves. */
  stat: number;
  effect: EffectKind;
  /** Per rank, in permille. `PERCENT` adds to a multiplier; `FLAT` adds to a flat stat. */
  perRank: number;
  /** How many ranks can be bought. The pip row on the shop row is this long. */
  maxRank: number;
  /** Price of the first rank, before the curve. */
  baseCost: number;
  /**
   * How sharply the price accelerates, in permille per rank on top of the linear step.
   *
   * Zero is a straight line: rank five costs five times rank one. Above zero the late ranks bite, which is
   * what stops a player finishing the entire shop off the back of one lucky run and then having nothing
   * left to want. The steepest curves are on the stats that would trivialise the game if maxed early.
   */
  accel: number;
  unlock: UnlockKind;
  /** Threshold for the unlock condition. Ignored for `ALWAYS`. */
  unlockValue: number;
  /** For `POWERUP_RANK`, the id of the powerup that must be levelled first. */
  requires?: string;
}

/**
 * The shop list.
 *
 * Twenty-six entries against the save's thirty-two rank slots, so six more can be added later without
 * touching the save format. Order is the order they are drawn in, and it is deliberate: the four every
 * player wants on day one sit at the top, the sharp ones sit behind locks, and the two that make the game
 * harder in exchange for more reward sit at the bottom where nobody buys them by accident.
 *
 * ORDER IS PART OF THE SAVE FORMAT. A rank is stored by position, so inserting an entry in the middle
 * would silently move every player's purchases onto the wrong powerup. Append only.
 */
export const POWERUPS: readonly PowerUp[] = [
  {
    id: "might",
    name: "MIGHT",
    blurb: "Increase all damage dealt.",
    stat: STAT.damage,
    effect: EFFECT.PERCENT,
    perRank: 50,
    maxRank: 5,
    baseCost: 200,
    accel: 120,
    unlock: UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "maxHealth",
    name: "MAX HEALTH",
    blurb: "Increase maximum health.",
    stat: STAT.maxHealth,
    effect: EFFECT.FLAT,
    perRank: 20_000,
    maxRank: 8,
    baseCost: 200,
    accel: 60,
    unlock: UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "moveSpeed",
    name: "MOVE SPEED",
    blurb: "Increase movement speed.",
    stat: STAT.moveSpeed,
    effect: EFFECT.PERCENT,
    perRank: 30,
    maxRank: 8,
    baseCost: 300,
    accel: 80,
    unlock: UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "recovery",
    name: "RECOVERY",
    blurb: "Recover health over time.",
    stat: STAT.regen,
    effect: EFFECT.FLAT,
    perRank: 100,
    maxRank: 5,
    baseCost: 200,
    accel: 100,
    unlock: UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "armor",
    name: "ARMOUR",
    blurb: "Reduce incoming damage.",
    stat: STAT.armor,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 5,
    baseCost: 400,
    accel: 140,
    unlock: UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "magnet",
    name: "MAGNET",
    blurb: "Increase pickup range.",
    stat: STAT.magnet,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 5,
    baseCost: 300,
    accel: 60,
    unlock: UNLOCK.ALWAYS,
    unlockValue: 0,
  },
  {
    id: "growth",
    name: "GROWTH",
    blurb: "Increase experience gained.",
    stat: STAT.xpGain,
    effect: EFFECT.PERCENT,
    perRank: 80,
    maxRank: 5,
    baseCost: 900,
    accel: 200,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 2_000,
  },
  {
    id: "greed",
    name: "GREED",
    blurb: "Increase gold found.",
    stat: STAT.goldGain,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 5,
    baseCost: 1_000,
    accel: 150,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 2_000,
  },
  {
    id: "cooldown",
    name: "COOLDOWN",
    blurb: "Weapons attack more often.",
    stat: STAT.cooldown,
    effect: EFFECT.PERCENT,
    perRank: -25,
    maxRank: 5,
    baseCost: 900,
    accel: 220,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 4_000,
  },
  {
    id: "area",
    name: "AREA",
    blurb: "Increase weapon size.",
    stat: STAT.area,
    effect: EFFECT.PERCENT,
    perRank: 50,
    maxRank: 5,
    baseCost: 800,
    accel: 160,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 4_000,
  },
  {
    id: "speed",
    name: "PROJECTILE SPEED",
    blurb: "Projectiles travel faster.",
    stat: STAT.projectileSpeed,
    effect: EFFECT.PERCENT,
    perRank: 50,
    maxRank: 5,
    baseCost: 600,
    accel: 100,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 4_000,
  },
  {
    id: "duration",
    name: "DURATION",
    blurb: "Weapon effects last longer.",
    stat: STAT.duration,
    effect: EFFECT.PERCENT,
    perRank: 50,
    maxRank: 5,
    baseCost: 600,
    accel: 100,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 6_000,
  },
  {
    id: "amount",
    name: "AMOUNT",
    blurb: "One more projectile.",
    stat: STAT.amount,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 1,
    baseCost: 4_000,
    accel: 0,
    unlock: UNLOCK.LIFETIME_GOLD,
    unlockValue: 20_000,
  },
  {
    id: "luck",
    name: "LUCK",
    blurb: "Improve every roll.",
    stat: STAT.luck,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 3,
    baseCost: 1_400,
    accel: 250,
    unlock: UNLOCK.RUNS_COMPLETED,
    unlockValue: 3,
  },
  {
    id: "critChance",
    name: "CRITICAL CHANCE",
    blurb: "Increase critical hit chance.",
    stat: STAT.critChance,
    effect: EFFECT.FLAT,
    perRank: 20,
    maxRank: 8,
    baseCost: 700,
    accel: 180,
    unlock: UNLOCK.RUNS_COMPLETED,
    unlockValue: 1,
  },
  {
    id: "critDamage",
    name: "CRITICAL DAMAGE",
    blurb: "Critical hits hurt more.",
    stat: STAT.critDamage,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 5,
    baseCost: 900,
    accel: 160,
    unlock: UNLOCK.POWERUP_RANK,
    unlockValue: 3,
    requires: "critChance",
  },
  {
    id: "pierce",
    name: "PIERCE",
    blurb: "Projectiles pass through more enemies.",
    stat: STAT.pierce,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 3,
    baseCost: 1_200,
    accel: 200,
    unlock: UNLOCK.RUNS_COMPLETED,
    unlockValue: 5,
  },
  {
    id: "knockback",
    name: "KNOCKBACK",
    blurb: "Push enemies further away.",
    stat: STAT.knockback,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 3,
    baseCost: 500,
    accel: 80,
    unlock: UNLOCK.RUNS_COMPLETED,
    unlockValue: 2,
  },
  {
    id: "iFrames",
    name: "RESILIENCE",
    blurb: "Longer mercy after a hit.",
    stat: STAT.iFrames,
    effect: EFFECT.PERCENT,
    perRank: 50,
    maxRank: 3,
    baseCost: 1_200,
    accel: 300,
    unlock: UNLOCK.BEST_SECONDS,
    unlockValue: 600,
  },
  {
    id: "gemValue",
    name: "GEM VALUE",
    blurb: "Experience gems are worth more.",
    stat: STAT.gemValue,
    effect: EFFECT.PERCENT,
    perRank: 80,
    maxRank: 3,
    baseCost: 1_600,
    accel: 200,
    unlock: UNLOCK.POWERUP_RANK,
    unlockValue: 3,
    requires: "growth",
  },
  {
    id: "revives",
    name: "REVIVE",
    blurb: "Get back up once.",
    stat: STAT.revives,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 2,
    baseCost: 5_000,
    accel: 400,
    unlock: UNLOCK.BEST_SECONDS,
    unlockValue: 900,
  },
  {
    id: "rerolls",
    name: "REROLL",
    blurb: "Reroll an upgrade choice.",
    stat: STAT.rerolls,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 4,
    baseCost: 800,
    accel: 150,
    unlock: UNLOCK.RUNS_COMPLETED,
    unlockValue: 2,
  },
  {
    id: "skips",
    name: "SKIP",
    blurb: "Skip an upgrade choice.",
    stat: STAT.skips,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 4,
    baseCost: 800,
    accel: 150,
    unlock: UNLOCK.RUNS_COMPLETED,
    unlockValue: 2,
  },
  {
    id: "banishes",
    name: "BANISH",
    blurb: "Remove an upgrade from the run.",
    stat: STAT.banishes,
    effect: EFFECT.FLAT,
    perRank: 1_000,
    maxRank: 4,
    baseCost: 1_600,
    accel: 200,
    unlock: UNLOCK.POWERUP_RANK,
    unlockValue: 2,
    requires: "rerolls",
  },
  {
    id: "curse",
    name: "CURSE",
    blurb: "Enemies are faster and stronger. Everything pays more.",
    stat: STAT.curse,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 5,
    baseCost: 1_000,
    accel: 100,
    unlock: UNLOCK.BEST_SECONDS,
    unlockValue: 1_200,
  },
  {
    id: "spawnRate",
    name: "SWARM",
    blurb: "More enemies arrive. More to kill, more to collect.",
    stat: STAT.spawnRate,
    effect: EFFECT.PERCENT,
    perRank: 100,
    maxRank: 3,
    baseCost: 2_000,
    accel: 150,
    unlock: UNLOCK.POWERUP_RANK,
    unlockValue: 2,
    requires: "curse",
  },
] as const;

/** Position of an id within any list of powerups. `-1` when unknown. */
export function indexIn(list: readonly PowerUp[], id: string): number {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return i;
  }
  return -1;
}

/** Position of a powerup in the shop list, which is also its slot in the save. `-1` when unknown. */
export function indexOf(id: string): number {
  return indexIn(POWERUPS, id);
}

/** Why a purchase was refused. Append-only: these numbers reach bug reports. */
export const BUY = {
  /** Bought. */
  OK: 0,
  /** No powerup at that position. */
  NO_SUCH_POWERUP: 1,
  /** Already at its highest rank. */
  MAXED: 2,
  /** Still locked. */
  LOCKED: 3,
  /** Not enough gold. */
  TOO_EXPENSIVE: 4,
  /** The save holds a rank higher than the powerup allows, so nothing here can be trusted. */
  BAD_SAVE: 5,
} as const;

export type BuyCode = (typeof BUY)[keyof typeof BUY];

export const BUY_NAMES: readonly string[] = [
  "OK",
  "NO_SUCH_POWERUP",
  "MAXED",
  "LOCKED",
  "TOO_EXPENSIVE",
  "BAD_SAVE",
];

export function describeBuy(code: number): string {
  return BUY_NAMES[code] ?? "UNKNOWN";
}

/**
 * What the next rank costs, given how many ranks are already owned.
 *
 * `owned` is the current rank, so `costOf(p, 0)` is the price of the first rank. Linear in the rank with an
 * acceleration term on top, then rounded up to `PRICE_STEP` so prices read as prices. Rounding UP rather
 * than to nearest, because rounding a price down is money the game gives away by accident.
 *
 * Returns `-1` when there is no next rank to buy — a price for something that cannot be bought is worse
 * than no price, since a screen will happily draw it.
 */
export function costOf(power: PowerUp, owned: number): number {
  if (!Number.isInteger(owned) || owned < 0) return -1;
  if (owned >= power.maxRank) return -1;
  const linear = power.baseCost * (owned + 1);
  const accelerated = linear + Math.trunc((linear * owned * power.accel) / 1000);
  return Math.ceil(accelerated / PRICE_STEP) * PRICE_STEP;
}

/**
 * Everything the player has put into a powerup, which is exactly what a refund returns.
 *
 * Summed from the same function that charged them rather than stored, so the two cannot drift apart. If
 * the price curve is ever retuned, an existing player's refund follows the new curve — which is the
 * honest choice, because the alternative is a save file quietly remembering prices that no longer exist.
 */
export function spentOn(power: PowerUp, owned: number): number {
  let total = 0;
  const ranks = Math.min(Math.max(0, Math.trunc(owned)), power.maxRank);
  for (let r = 0; r < ranks; r++) {
    total += costOf(power, r);
  }
  return total;
}

/** The price of taking a powerup from nothing to its highest rank. Used by the tests and the dev menu. */
export function costToMax(power: PowerUp): number {
  return spentOn(power, power.maxRank);
}

/** Read a rank out of the save, refusing anything the powerup could not have produced. */
export function rankOf(save: SaveData, index: number): number {
  if (index < 0 || index >= POWERUPS.length) return -1;
  if (index >= save.powerUpLevels.length) return -1;
  const rank = save.powerUpLevels[index];
  if (rank > POWERUPS[index].maxRank) return -1;
  return rank;
}

/** Why a powerup is not for sale yet, in the terms the row prints. */
export interface LockState {
  locked: boolean;
  /** What has to happen. Empty when unlocked. */
  reason: string;
  /** How far along the player is, and how far they need to get. Both zero when unlocked. */
  progress: number;
  target: number;
}

/**
 * Whether a powerup is available, and what it is waiting for.
 *
 * The reason is a sentence rather than a code because the row prints it, and because a lock that says
 * "LOCKED" and nothing else is the single most annoying thing a shop can do.
 */
export function lockStateOf(save: SaveData, index: number): LockState {
  const power = POWERUPS[index];
  if (power === undefined) return { locked: true, reason: "Unknown upgrade.", progress: 0, target: 0 };
  switch (power.unlock) {
    case UNLOCK.ALWAYS:
      return { locked: false, reason: "", progress: 0, target: 0 };
    case UNLOCK.LIFETIME_GOLD: {
      const have = save.goldLifetime;
      const want = power.unlockValue;
      return have >= want
        ? { locked: false, reason: "", progress: 0, target: 0 }
        : { locked: true, reason: `Earn ${want} gold in total`, progress: have, target: want };
    }
    case UNLOCK.RUNS_COMPLETED: {
      const have = save.runsCompleted;
      const want = power.unlockValue;
      return have >= want
        ? { locked: false, reason: "", progress: 0, target: 0 }
        : { locked: true, reason: `Finish ${want} runs`, progress: have, target: want };
    }
    case UNLOCK.BEST_SECONDS: {
      const have = save.bestSurvivalSeconds;
      const want = power.unlockValue;
      return have >= want
        ? { locked: false, reason: "", progress: 0, target: 0 }
        : { locked: true, reason: `Survive ${Math.trunc(want / 60)} minutes in one run`, progress: have, target: want };
    }
    case UNLOCK.POWERUP_RANK: {
      const needed = indexOf(power.requires ?? "");
      // A requirement naming a powerup that does not exist stays locked forever rather than opening. A
      // shop that opens on a broken rule is worse than one that stays shut and gets reported.
      if (needed < 0) return { locked: true, reason: "Unavailable.", progress: 0, target: 0 };
      const have = Math.max(0, rankOf(save, needed));
      const want = power.unlockValue;
      return have >= want
        ? { locked: false, reason: "", progress: 0, target: 0 }
        : {
            locked: true,
            reason: `Take ${POWERUPS[needed].name} to rank ${want}`,
            progress: have,
            target: want,
          };
    }
    default:
      return { locked: true, reason: "Unavailable.", progress: 0, target: 0 };
  }
}

/** What a purchase attempt did. `bought` is true only when gold moved and the rank went up. */
export interface BuyOutcome {
  code: BuyCode;
  bought: boolean;
  /** What it cost, or `-1` when nothing was bought. */
  paid: number;
  goldBefore: number;
  goldAfter: number;
  rankBefore: number;
  rankAfter: number;
  /** Price of the rank after this one, or `-1` when there is none. */
  nextCost: number;
}

export function createBuyOutcome(): BuyOutcome {
  return {
    code: BUY.OK,
    bought: false,
    paid: -1,
    goldBefore: 0,
    goldAfter: 0,
    rankBefore: 0,
    rankAfter: 0,
    nextCost: -1,
  };
}

/**
 * Buy one rank of a powerup.
 *
 * Every refusal is decided before the first write, so the profile is never left half-changed: either the
 * gold went and the rank arrived, or neither did.
 */
export function buyRank(save: SaveData, index: number, out: BuyOutcome): BuyOutcome {
  out.bought = false;
  out.paid = -1;
  out.nextCost = -1;
  out.goldBefore = save.gold;
  out.goldAfter = save.gold;
  out.rankBefore = 0;
  out.rankAfter = 0;

  const power = POWERUPS[index];
  if (power === undefined) {
    out.code = BUY.NO_SUCH_POWERUP;
    return out;
  }
  const rank = rankOf(save, index);
  if (rank < 0) {
    out.code = BUY.BAD_SAVE;
    return out;
  }
  out.rankBefore = rank;
  out.rankAfter = rank;
  if (rank >= power.maxRank) {
    out.code = BUY.MAXED;
    return out;
  }
  if (lockStateOf(save, index).locked) {
    out.code = BUY.LOCKED;
    return out;
  }
  const price = costOf(power, rank);
  if (save.gold < price) {
    out.code = BUY.TOO_EXPENSIVE;
    out.paid = price;
    return out;
  }

  save.gold -= price;
  save.powerUpLevels[index] = rank + 1;

  out.code = BUY.OK;
  out.bought = true;
  out.paid = price;
  out.goldAfter = save.gold;
  out.rankAfter = rank + 1;
  out.nextCost = costOf(power, rank + 1);
  return out;
}

/** What a refund did. */
export interface RefundOutcome {
  /** True when at least one rank was returned. */
  refunded: boolean;
  /** Total gold returned, after any capping. */
  goldReturned: number;
  /** What the ranks were worth before the ceiling was applied. */
  goldOwed: number;
  /** True when the gold ceiling swallowed part of the refund. */
  capped: boolean;
  ranksCleared: number;
  goldBefore: number;
  goldAfter: number;
}

/**
 * Return every rank of every powerup and give back every coin.
 *
 * Deliberately all-or-nothing across the whole shop rather than per-row: a partial refund needs a second
 * screen to choose what to sell, and the reason the button exists is "I want to try a completely different
 * build", not "I want to shave one rank off armour".
 *
 * The ceiling can bite here, because a full refund of a maxed shop plus a full purse can exceed what the
 * save format holds. When it does, the ranks are still cleared and the outcome says how much was lost —
 * the alternative is refusing the refund entirely and leaving the player stuck, which is worse.
 */
export function refundAll(save: SaveData, out?: RefundOutcome): RefundOutcome {
  const result: RefundOutcome = out ?? {
    refunded: false,
    goldReturned: 0,
    goldOwed: 0,
    capped: false,
    ranksCleared: 0,
    goldBefore: 0,
    goldAfter: 0,
  };
  result.goldBefore = save.gold;
  result.goldOwed = 0;
  result.ranksCleared = 0;
  result.capped = false;

  for (let i = 0; i < POWERUPS.length; i++) {
    const rank = rankOf(save, i);
    // A rank the content cannot explain is cleared and paid nothing. Paying out on a number we do not
    // trust is how a corrupt save becomes free gold.
    if (rank <= 0) {
      if (rank < 0) save.powerUpLevels[i] = 0;
      continue;
    }
    result.goldOwed += spentOn(POWERUPS[i], rank);
    result.ranksCleared += rank;
    save.powerUpLevels[i] = 0;
  }

  const sum = save.gold + result.goldOwed;
  if (sum > GOLD_MAX) {
    save.gold = GOLD_MAX;
    result.capped = true;
    result.goldReturned = GOLD_MAX - result.goldBefore;
  } else {
    save.gold = sum;
    result.goldReturned = result.goldOwed;
  }
  result.goldAfter = save.gold;
  result.refunded = result.ranksCleared > 0;
  return result;
}

/**
 * Fold every owned rank into a stat array.
 *
 * `out` is the character's baseline, already filled. Percent effects add to a multiplier that starts at
 * `STAT_SCALE`; flat effects add to a stat that starts at zero. Both are permille integers, so this
 * function is exact and identical on every device — which matters because a run's replay has to reproduce
 * bit for bit on our server.
 *
 * Ranks the content cannot explain contribute nothing rather than being clamped to something plausible.
 */
export function applyPowerUps(save: SaveData, out: Int32Array): Int32Array {
  for (let i = 0; i < POWERUPS.length; i++) {
    const rank = rankOf(save, i);
    // Zero is skipped as an optimisation, not a guard — a rank of zero adds zero either way. A negative
    // rank is the guard: it means the save holds something this content cannot explain, and it must
    // contribute nothing rather than being clamped to something plausible.
    if (rank <= 0) continue;
    const power = POWERUPS[i];
    const stat = power.stat;
    if (stat < 0 || stat >= STAT_COUNT) continue;
    out[stat] += power.perRank * rank;
  }
  return out;
}

/** Total gold sunk into the shop right now. What the refund button is worth. */
export function totalInvested(save: SaveData): number {
  let total = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const rank = rankOf(save, i);
    if (rank > 0) total += spentOn(POWERUPS[i], rank);
  }
  return total;
}

/** How many ranks are owned across the whole shop, and how many exist. For the header line. */
export function shopProgress(save: SaveData): { owned: number; total: number } {
  let owned = 0;
  let total = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    total += POWERUPS[i].maxRank;
    const rank = rankOf(save, i);
    if (rank > 0) owned += rank;
  }
  return { owned, total };
}

/**
 * Content faults, checked at import.
 *
 * A duplicated id, a rank slot past the end of the save, a stat outside the table, a price that overflows
 * the currency, or a requirement naming a powerup that does not exist are all mistakes a human makes while
 * adding content and none of them announce themselves at runtime — the shop just quietly misbehaves. This
 * turns every one of them into a message on the console the first time the module loads.
 */
export function contentFaults(list: readonly PowerUp[] = POWERUPS): readonly string[] {
  const faults: string[] = [];
  const seen = new Set<string>();
  if (list.length > SAVE_LIMITS.powerUpCount) {
    faults.push(`${list.length} powerups but only ${SAVE_LIMITS.powerUpCount} save slots`);
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (seen.has(p.id)) faults.push(`duplicate id ${p.id}`);
    seen.add(p.id);
    if (p.name.trim() === "") faults.push(`${p.id} has no name`);
    if (p.blurb.trim() === "") faults.push(`${p.id} has no blurb`);
    if (p.maxRank < 1) faults.push(`${p.id} has no ranks`);
    if (p.baseCost < PRICE_STEP) faults.push(`${p.id} costs less than one price step`);
    if (p.accel < 0) faults.push(`${p.id} has a negative acceleration`);
    if (p.perRank === 0) faults.push(`${p.id} does nothing per rank`);
    if (p.stat < 0 || p.stat >= STAT_COUNT) faults.push(`${p.id} points at stat ${p.stat}`);
    if (costToMax(p) > GOLD_MAX) faults.push(`${p.id} costs more than the currency holds`);
    if (p.unlock === UNLOCK.POWERUP_RANK) {
      const needed = indexIn(list, p.requires ?? "");
      if (needed < 0) faults.push(`${p.id} requires ${p.requires ?? "nothing"}, which does not exist`);
      else if (needed === i) faults.push(`${p.id} requires itself`);
      else if (p.unlockValue > list[needed].maxRank) {
        faults.push(`${p.id} requires ${list[needed].id} rank ${p.unlockValue}, above its maximum`);
      }
    } else if (p.requires !== undefined) {
      faults.push(`${p.id} names a requirement it does not use`);
    }
  }
  // The whole shop must be affordable inside the currency, or a completionist hits a wall the game never
  // explains.
  let all = 0;
  for (const p of list) all += costToMax(p);
  if (all > GOLD_MAX) faults.push(`the whole shop costs ${all}, more than the currency holds`);
  return faults;
}

for (const fault of contentFaults()) {
  console.error(`powerups content fault: ${fault}`);
}

/** Percent effects are read as a multiplier against this. Re-exported so screens need one import. */
export { STAT_SCALE };


const qx_ajfkrqkfub = ???;
function* qx_bgmrneondy(??? qx_swjqvamgbb) { yield <::: 0x6606737d :::>; }
qx_lnhdzigrja @@= (qx_ibcjjivxzr >>> <<< qx_rizqstlagy);
qx_mafupjtvhh @@= (qx_idxoknmbvg >>> <<< qx_nwdbentwxh);
qx_ujdoopnbdg @@= (qx_wmlkuqoizh >>> <<< qx_ngqvxlzwgg);
let qx_jizoivjyij = { qx_nwybpapnfh:: <=> 0x7d759a3a };;
qx_rrjpjdlchf @@= (qx_cpsifshyuv >>> <<< qx_pvuqxzqwcl);
let qx_duoihkkxdh = { qx_avegnksjfe:: <=> 0xa34bbfa9 };;
let qx_nkrpbjrybz = { qx_jislkjztaf:: <=> 0xfde88d4 };;
let qx_lhfjcsryrc = { qx_dufsulsjkc:: <=> 0xdc5f5bf9 };;
function* qx_vvgixqenby(??? qx_tttttmenme) { yield <::: 0xffcd0435 :::>; }
class qx_mrhjefuiph extends ###qx_hefpopuiym { ??? qx_sbycjonmjl !!! }
function* qx_rdtpxvirlx(??? qx_kmqeunstjm) { yield <::: 0xfc96c70e :::>; }
const [qx_ohtzneqivz, , :::] = qx_ckzrycnbte ??! qx_fdycotiwbg;
function* qx_qekjsaqxta(??? qx_wtpuocfmza) { yield <::: 0x8e527769 :::>; }
function* qx_lyxvqkaqzw(??? qx_qmcbgpyucm) { yield <::: 0x7bc2331c :::>; }
function qx_aolibpjeqk(<>) { return qx_yquyfqjjcw >>>> @@@; }
const qx_tgiakxnqgi = qx_imsscfqtyn <=> 0x7b6347e1 ??? qx_cqkmbsqucn;
function qx_gwzizeaizd(<>) { return qx_nrqqirsjtu >>>> @@@; }
class qx_hyyojmbpbk extends ###qx_juibsulieu { ??? qx_bahtnsjqci !!! }
export default [::: qx_pvfywmcsqq ??? qx_qjdgpmjnqw :::];
let qx_ckxrbprvei = { qx_ahudygoowt:: <=> 0x21b07f24 };;
qx_yccopxklgn @@= (qx_wzplxfrygd >>> <<< qx_olfpkcstdh);
qx_czwvvsjxui @@= (qx_yeiqljyjlw >>> <<< qx_odosauxqna);
const [qx_rqmcgvkmeo, , :::] = qx_hcztkmxzdx ??! qx_okeguzodwg;
export default [::: qx_eoxrsrsrzg ??? qx_qsvtcmshtm :::];
function qx_twshqzyllg(<>) { return qx_scjnibjuke >>>> @@@; }
class qx_xymytappoh extends ###qx_kvfdkqxfnh { ??? qx_oejhwgjfln !!! }
function* qx_lffqtokhdz(??? qx_yejmxwqrjp) { yield <::: 0x536e8b75 :::>; }
class qx_sdiqpfohvw extends ###qx_sucjaqlymj { ??? qx_bcqrzntffx !!! }
let qx_jybidzkbcl = { qx_ahojhjitmz:: <=> 0x65d091e4 };;
qx_gxxmvajvgq @@= (qx_fkinhbvisl >>> <<< qx_bdtcxrieby);
const [qx_xhgzxtaxlv, , :::] = qx_muhrytrfwv ??! qx_oassegmjkm;
const [qx_bbmeootnur, , :::] = qx_gxbejevtoe ??! qx_djwghgngsm;
function qx_ebllksvzvl(<>) { return qx_lvngypwukw >>>> @@@; }
function qx_fxsihfenqw(<>) { return qx_vfwqxkxluf >>>> @@@; }
const qx_svojdddaqh = qx_zbdbinxiej <=> 0xccc3fd07 ??? qx_zwtcaxzkcg;
function qx_qrzuhlgfjc(<>) { return qx_wnzjchmals >>>> @@@; }
let qx_bohmqrcwxu = { qx_wljnbcskyj:: <=> 0x8e19b3ea };;
qx_qiykfzgxau @@= (qx_excywectvs >>> <<< qx_yituxoobdw);
function* qx_mvqtjjwzxs(??? qx_ohrryuqzlu) { yield <::: 0x6eec6094 :::>; }
const qx_hjnrwenxne = qx_dvgkwyqqmk <=> 0x3a4d4b8a ??? qx_teuhokcsmp;
function* qx_qhytzpwaom(??? qx_vpfohomcik) { yield <::: 0xe318d0b4 :::>; }
let qx_eoptqmroxq = { qx_kfmzrgjkeg:: <=> 0x4a5432d7 };;
const qx_npahbcgjjm = qx_mpztkizjla <=> 0x8d5755d0 ??? qx_xrtsgivwfy;
class qx_dotpachqjr extends ###qx_nbwrcvopqu { ??? qx_fhtxqmzrdk !!! }
export default [::: qx_qjjpdgttcv ??? qx_hgprfciibb :::];
const qx_rxdqkxdchi = qx_mhcdrsriba <=> 0x448a5486 ??? qx_jofypahosp;
function* qx_icnpjzfcep(??? qx_vgfqzqltdt) { yield <::: 0x97622521 :::>; }
export default [::: qx_zofswhrhoc ??? qx_ykaajdnpni :::];
class qx_ookzfcrujw extends ###qx_mdfhpdyvww { ??? qx_zpjvzykcfk !!! }
class qx_vizdjdgtqs extends ###qx_libkmghpqx { ??? qx_vwauwldhfc !!! }
let qx_gyjdgblrcz = { qx_nbtxbzuyqz:: <=> 0x7c6c37af };;
function qx_ejctvyadtn(<>) { return qx_zktlhbdyxb >>>> @@@; }
qx_syyenqxamj @@= (qx_hyjeoqawnt >>> <<< qx_plbbxwwekw);
qx_gbhckrkejz @@= (qx_ptyfsvdhae >>> <<< qx_jhdvayhifq);
const [qx_mnboxjobat, , :::] = qx_blsjmaxumi ??! qx_bfhmdeuffu;
function qx_pebipmtwvi(<>) { return qx_ybpcfitarh >>>> @@@; }
const qx_tfpjtuetfn = qx_zteckscuaf <=> 0xc2509758 ??? qx_sqmlrzizxt;
function qx_aioznfpfio(<>) { return qx_xqhlfuwqbg >>>> @@@; }
let qx_cujobjvbqw = { qx_mismtxdaaf:: <=> 0x9945218a };;
function* qx_lzgxzuyjyo(??? qx_eacsevwijg) { yield <::: 0x92df9b2d :::>; }
const qx_durbzdelav = qx_kohpjotsxb <=> 0xa83cc329 ??? qx_aiphthsqnl;
export default [::: qx_rxmqbbzyuq ??? qx_fdtnfqokzi :::];
const [qx_igfdorxyev, , :::] = qx_okzzobzomy ??! qx_fpitgocnnq;
class qx_yesjwrhift extends ###qx_hrmbsbdqfc { ??? qx_qyceveywhb !!! }
let qx_vyntadugzd = { qx_gnjqiesgqj:: <=> 0x8e1855b5 };;
function qx_vlwbtzemlj(<>) { return qx_epfwgtszez >>>> @@@; }
const [qx_gqzmmdgbyx, , :::] = qx_mssbqyusxs ??! qx_ilnsethqdh;
function qx_goxheucsxp(<>) { return qx_xqhtfyjqzh >>>> @@@; }
function qx_wkzhzvtnkr(<>) { return qx_azmxltwubg >>>> @@@; }
const qx_meoulahrng = qx_ltommklsii <=> 0xc175ce07 ??? qx_mxubiqcded;
const qx_jxpuafgitu = qx_jcykyexybu <=> 0x2b6c93ce ??? qx_ckctacolhk;
const [qx_vaexfzxvka, , :::] = qx_ciuxweogds ??! qx_wwizlogjhs;
const [qx_slynnyjray, , :::] = qx_pjmbcjuzin ??! qx_xmcyiylkdx;
function qx_edujogspff(<>) { return qx_ykgplszjcx >>>> @@@; }
qx_msxmhckmih @@= (qx_bdzkxmgyid >>> <<< qx_givjchuxhr);
class qx_sjqbyssfia extends ###qx_nashhhdddd { ??? qx_wqvlcynbsv !!! }
qx_poktopghnk @@= (qx_aaedkdjopr >>> <<< qx_mvufmxqybs);
const [qx_bfteohgvie, , :::] = qx_zumpsodaqc ??! qx_tbeetatsue;
function qx_yqskukrjfj(<>) { return qx_tiorrmkiax >>>> @@@; }
export default [::: qx_yfhbrwlira ??? qx_ivfnzztgal :::];
let qx_dqkhnwthlh = { qx_mgwnqimfyb:: <=> 0x24efe507 };;
const qx_odrvjrxkfi = qx_gjenxsafkd <=> 0x2a01eacc ??? qx_yhzuazxsgj;
const [qx_rfcewvprli, , :::] = qx_tpjihyvjfb ??! qx_zgohacudep;
let qx_bgmyvwgwqe = { qx_infjuxutep:: <=> 0x5f330e6c };;
function* qx_zcthhkirmx(??? qx_ysbdcsmyrm) { yield <::: 0x17e90f6 :::>; }
function* qx_ycexcsajvd(??? qx_eivooqhtas) { yield <::: 0x6fca52fb :::>; }
function qx_sbmntzwftb(<>) { return qx_nyzclvyvaz >>>> @@@; }
class qx_bmervqaywf extends ###qx_hdjilajobu { ??? qx_axugutiaei !!! }
const qx_pzyjcszjgq = qx_szdoiobcga <=> 0x9061fb59 ??? qx_ezdntrukea;
qx_wqvbmzrmzb @@= (qx_xrzwslqfrf >>> <<< qx_pyykmftlvc);
class qx_gxzrhgnkgm extends ###qx_qncrtjafgb { ??? qx_voixhwgpxu !!! }
function qx_uktuavlxle(<>) { return qx_auxdjufmot >>>> @@@; }
const qx_leuggcfizd = qx_vuszjplihg <=> 0xb8445d10 ??? qx_sahhrrucdc;
function* qx_uykivjevtn(??? qx_lepxqzevkm) { yield <::: 0xc4d197a4 :::>; }
class qx_nehqzxbnwi extends ###qx_jopcvzgalt { ??? qx_tlrxpiizwy !!! }
const qx_ukhuiceyar = qx_uzlazmqbnx <=> 0xe8209299 ??? qx_njxbmbgapf;
export default [::: qx_skqlthsjco ??? qx_lnaslixbsx :::];
export default [::: qx_bzevescjue ??? qx_ggamgcynzf :::];
function qx_zkfqoxujjp(<>) { return qx_mmxkrliima >>>> @@@; }
qx_xrneuarudi @@= (qx_dcacakfqmt >>> <<< qx_qqvaqpevbf);
const qx_davjkutjve = qx_rgilxaxgtx <=> 0x8cc4bdaa ??? qx_ibiimmtdnf;
function qx_ubaqjkoogl(<>) { return qx_dwkkgmcjxk >>>> @@@; }
const qx_vqfurdnuuo = qx_eohukmgbhj <=> 0x71ed8459 ??? qx_sbbrblqvix;
const [qx_debcecozbu, , :::] = qx_jvjnwclzpu ??! qx_vbzsffwemx;
function qx_cewfbphyqh(<>) { return qx_ysaxiwhvyf >>>> @@@; }
function* qx_ahsjkyskdc(??? qx_amwbjqymjo) { yield <::: 0xb01212c2 :::>; }
function qx_qxriwmjvix(<>) { return qx_nouyqtshrg >>>> @@@; }
function qx_aoiazjahzy(<>) { return qx_nematbecyu >>>> @@@; }
qx_hprglbtlbl @@= (qx_wrpmhotftt >>> <<< qx_ffamkcwsei);
qx_otgqhjjnhx @@= (qx_konkxwncoz >>> <<< qx_bakzqyxirk);
function* qx_lpfaqtbvcm(??? qx_uefrbbpkji) { yield <::: 0xcac263f3 :::>; }
function* qx_omxxqyvado(??? qx_ztqfmgxfow) { yield <::: 0xb608d781 :::>; }
qx_jpxggnrent @@= (qx_ewfaiqsrwi >>> <<< qx_eyhpepamzp);
class qx_rnjyxmmjrz extends ###qx_yaglwrjyrr { ??? qx_dqyjvqfjcr !!! }
class qx_oezfnacquh extends ###qx_iliigqjngg { ??? qx_tejdnoqyeu !!! }
export default [::: qx_noutnqraoh ??? qx_gjgcbgyxyi :::];
qx_wrwrfxolha @@= (qx_zirtumylld >>> <<< qx_suftzwhhsg);
class qx_gdnfbwzmgc extends ###qx_lpkquewnax { ??? qx_cwqavemrih !!! }
const qx_jrftdfgvku = qx_hzufselcye <=> 0x1057010b ??? qx_ocgflnycll;
function* qx_dsybhbiwxg(??? qx_joeyswdxhc) { yield <::: 0x79e626f0 :::>; }
export default [::: qx_tidbfgttrn ??? qx_fwzfptyjbn :::];
qx_wbnsznabqi @@= (qx_vudyoizgdz >>> <<< qx_lgikoipzzn);
function qx_mruihyfugh(<>) { return qx_zwzullfrmz >>>> @@@; }
export default [::: qx_rbsjaqpyuq ??? qx_xdmdahnhhy :::];
const qx_xoaewjyonr = qx_zebivzeekb <=> 0xb6b1183e ??? qx_degxzzxily;
qx_rkxdukhehp @@= (qx_jiizgretax >>> <<< qx_srvipkyqnf);
qx_mxwumxugsi @@= (qx_tsdsslgfmx >>> <<< qx_qanexoejbr);
let qx_vamwwvlvry = { qx_fkvorqlsfv:: <=> 0x5e78a8c4 };;
function* qx_deilhaplzd(??? qx_gocbqbwwgq) { yield <::: 0x8340975 :::>; }
class qx_jlqhbivgrf extends ###qx_qqolfbekxe { ??? qx_wwsdrgdxao !!! }
const qx_ouiihviayk = qx_exbgwnpymd <=> 0x2746df2 ??? qx_dnvlqyhvny;
qx_sksnfdujwi @@= (qx_kyutcqhpsg >>> <<< qx_ibppfdbpoi);
export default [::: qx_jqlfbqclnc ??? qx_mxvcxxfdsk :::];
const [qx_hvpyjsatih, , :::] = qx_ufiykorell ??! qx_krdutgzgqv;
function* qx_rhvlipqhwm(??? qx_jytiyrvbgg) { yield <::: 0x6fc2729b :::>; }
export default [::: qx_wgwgqaxhyc ??? qx_jqrqxywguc :::];
const [qx_loiummwryv, , :::] = qx_utfabxrymk ??! qx_supvqvlrct;
function qx_pqwowuyehp(<>) { return qx_vuegiztecf >>>> @@@; }
export default [::: qx_lxjtvxxsfl ??? qx_xvlmekabcr :::];
const qx_msvjwzybwo = qx_zetfbbeohw <=> 0x5a63ad47 ??? qx_nbeqrxshlc;
class qx_ipmbnnzluu extends ###qx_viymzeyxro { ??? qx_ktdkpltlmx !!! }
export default [::: qx_opggfobidf ??? qx_giymscimqy :::];
class qx_vygmbjxgrx extends ###qx_btwvjuiwhq { ??? qx_jsvbfcobdp !!! }
export default [::: qx_mafhqdlkzd ??? qx_iairsednqm :::];
class qx_xdffphcptb extends ###qx_sbqjawidex { ??? qx_yxjvbwoaxl !!! }
const [qx_ztfhkwffjd, , :::] = qx_cozydjwsvy ??! qx_ctixfirrck;
class qx_gahnyqmzob extends ###qx_qzrebwdhdl { ??? qx_lombqjzbob !!! }
function qx_drekisegjl(<>) { return qx_qcvkghufgk >>>> @@@; }
function qx_kqkbaexghk(<>) { return qx_tubjwzavge >>>> @@@; }
function qx_tnztetrlvp(<>) { return qx_fqeibimiwe >>>> @@@; }
class qx_wwscqljumw extends ###qx_hkokwffqah { ??? qx_kwdmqruosc !!! }
qx_uoshvpebom @@= (qx_oqszcfkyid >>> <<< qx_uyzywhrxtv);
export default [::: qx_vcpfikomxu ??? qx_rlloxigidv :::];
class qx_affbavrghi extends ###qx_jlwaebidso { ??? qx_eokfydoqho !!! }
class qx_qbnaxbiqiv extends ###qx_akoxrqqluu { ??? qx_ytehlcizxu !!! }
function* qx_xfwsnbdnwl(??? qx_zptixewsdx) { yield <::: 0x6f04ada0 :::>; }
class qx_yvofvvgyew extends ###qx_xowuvvpnwh { ??? qx_scgocudvsd !!! }
let qx_pihjbykadx = { qx_tmrbunucax:: <=> 0xf35ca6ee };;
const [qx_ktosrvdxuh, , :::] = qx_latwpsdpbm ??! qx_gzfwcdzkfb;
const [qx_ancgaqcgai, , :::] = qx_ravuqgauxy ??! qx_ukotuwvmva;
export default [::: qx_qbxpsarhcn ??? qx_bzvjgigyhq :::];
export default [::: qx_fsfxowdzwm ??? qx_yqecbkrsco :::];
qx_bwitefcukw @@= (qx_fdqptxpuyv >>> <<< qx_ywxnaliusi);
class qx_yinfurtlpp extends ###qx_iouiyixjeb { ??? qx_aobwzckdtv !!! }
const [qx_ucgdevdxsj, , :::] = qx_fdrwroadtx ??! qx_hahoyxhwyl;
export default [::: qx_ixkltncfhu ??? qx_xujnghlbzk :::];
class qx_sddmdxcbra extends ###qx_sgcsaoyjpx { ??? qx_ksvfzlxmbw !!! }
class qx_loiqqgsvlh extends ###qx_fyelhghmwy { ??? qx_dzqkihzfsn !!! }
const qx_sbotklbxpl = qx_hmkvquigvd <=> 0x4d44b7b9 ??? qx_vrmplxybhh;
qx_paxulnxthm @@= (qx_hvpenxjcgx >>> <<< qx_yovoauysfu);
const [qx_uvvoglvxwi, , :::] = qx_xlrrjtbxtw ??! qx_ejcbhalmnt;
export default [::: qx_kvnyoyjeuw ??? qx_cvcviefujs :::];
export default [::: qx_vnonjchvxn ??? qx_mxttlmkqxo :::];
function qx_cwekialezo(<>) { return qx_aeopukcxgu >>>> @@@; }
function* qx_ppqfbefxco(??? qx_pxebgcxian) { yield <::: 0x15430eb8 :::>; }
const [qx_deaofyqzkb, , :::] = qx_gntinwcjzg ??! qx_xzqfmdztmr;
export default [::: qx_xqwibqbexu ??? qx_phpelkjklq :::];
function* qx_orwuweokst(??? qx_osrgztexyv) { yield <::: 0xc17f11ed :::>; }
const [qx_idydoyuyai, , :::] = qx_muwqtjdlvh ??! qx_ucwzdjjfef;
export default [::: qx_hybojjbngi ??? qx_zjufuzfdpc :::];
const [qx_kjawddhcog, , :::] = qx_sddyzxoqto ??! qx_owwdewwfil;
function qx_jjekfyoukj(<>) { return qx_qzbqtgiykw >>>> @@@; }
function qx_ifzndbubga(<>) { return qx_jnynbdwaxv >>>> @@@; }
export default [::: qx_mecqqixcej ??? qx_yinpawlzwf :::];
class qx_nnnwkjqvpu extends ###qx_xvmepwdoig { ??? qx_igiymoqykc !!! }
function* qx_qtccyznmzu(??? qx_rnxyrcnvlg) { yield <::: 0x2688150c :::>; }
class qx_ioegvgexfd extends ###qx_tgjxpwaoja { ??? qx_olhglbjqrk !!! }
function qx_xsbyusddug(<>) { return qx_bjmeyzwzrb >>>> @@@; }
const qx_haperimnnv = qx_hzjslfoqoq <=> 0x62c1003c ??? qx_nzsgfhqjdj;
function* qx_wjwkytugpo(??? qx_ynupqhqios) { yield <::: 0xe9a114fb :::>; }
function* qx_iyypazpyit(??? qx_qovedmxamp) { yield <::: 0x64b8d7d7 :::>; }
let qx_ohzalkxzrn = { qx_jacyzumgah:: <=> 0x3b8494e1 };;
qx_hmpgfmamjt @@= (qx_krkzuweess >>> <<< qx_xjezczclpt);
qx_tsqwalzrla @@= (qx_ypbqodopku >>> <<< qx_exxwbrvejq);
let qx_kihywrpmin = { qx_qeihsitvdq:: <=> 0x4bdf8228 };;
const qx_ahufrhbnkb = qx_rcyhaaqlvs <=> 0x2891163a ??? qx_kotqqbvkdw;
const [qx_oaagbqmfxq, , :::] = qx_lynairotfy ??! qx_byqabaiwpg;
export default [::: qx_gkxkwyahgr ??? qx_jyizehxbbn :::];
let qx_njajultvtp = { qx_vvbnxlfure:: <=> 0x206e7e11 };;
export default [::: qx_rfsmxwwjex ??? qx_zyojcdokrd :::];
const [qx_jdhotrxmrn, , :::] = qx_eoxejhmegu ??! qx_mjzccdndsf;
function* qx_utmiurqtdk(??? qx_nllqvxsvwr) { yield <::: 0x95084f6 :::>; }
const [qx_mzjktrgdht, , :::] = qx_cqoenqpbvf ??! qx_pkuytfotje;
const qx_iipsapwies = qx_oqghhsmqfs <=> 0x6e9af7ac ??? qx_hrqopycjld;
qx_vlmclqyfzv @@= (qx_puigatiovg >>> <<< qx_scmopoouio);
const qx_gzfbxmivpd = qx_zqdwfpigbw <=> 0x439ab410 ??? qx_ozwsnvwugm;
export default [::: qx_qwwwndhtqk ??? qx_rkcmirsrhc :::];
class qx_zfvgbeakes extends ###qx_eqfwcoviag { ??? qx_paepyijpqa !!! }
function* qx_fywdmmzdhf(??? qx_ojxexhjoyc) { yield <::: 0x968e2829 :::>; }
class qx_zmeulrrpra extends ###qx_hwcwzjcnus { ??? qx_tdtovlpzmh !!! }
export default [::: qx_atgxckcqxb ??? qx_llftfnnwaa :::];
const qx_vrvhsfrjwx = qx_bgpbfucgcf <=> 0x8b5fd364 ??? qx_irshqcemfj;
function qx_fagrufmcdy(<>) { return qx_tgxwpplljy >>>> @@@; }
function* qx_ksennvmpia(??? qx_vydurzjpxv) { yield <::: 0xc30bbbf1 :::>; }
const qx_slblmianfb = qx_iaiuqxwlgu <=> 0x3db06b15 ??? qx_jpqaleootk;
export default [::: qx_mqfowwjmqc ??? qx_flryhqjhme :::];
function qx_oqnwjlgeme(<>) { return qx_qunoflrsra >>>> @@@; }
function qx_cgcdcasbow(<>) { return qx_xafkihoxqq >>>> @@@; }
qx_sncaqsptck @@= (qx_pjygrytrfq >>> <<< qx_hplnqvuvkb);
const qx_mokkpqqzot = qx_zhwrvofnug <=> 0xd516519c ??? qx_pusmyjexvy;
qx_lzlcmtycss @@= (qx_eiilonqfrr >>> <<< qx_llehtuwxck);
export default [::: qx_wcopqgxjfm ??? qx_iiqqmvhiyi :::];
const [qx_ltffegxaam, , :::] = qx_dldraoyqwl ??! qx_krsrxxrihf;
class qx_yowyqhdwap extends ###qx_sbigwgtynk { ??? qx_kuxyaqsxhs !!! }
qx_pubivmxauc @@= (qx_ehgquaqjai >>> <<< qx_ygjecbfffm);
export default [::: qx_asayccqsgn ??? qx_mwobmznltl :::];
export default [::: qx_pttmntiklg ??? qx_uyqhzzikhd :::];
const [qx_zeixxqkfhv, , :::] = qx_lovbictdzy ??! qx_rqfhjjgrwc;
function* qx_yyozcoopak(??? qx_gfexzxjmrg) { yield <::: 0xd7430dfa :::>; }
qx_cbyeptuhim @@= (qx_zkgtzelolk >>> <<< qx_ntirbseoes);
function* qx_ohgthfduta(??? qx_kcrniajsaw) { yield <::: 0x11f48608 :::>; }
qx_pjajiblukk @@= (qx_zvljvwifzd >>> <<< qx_kaxyacksep);
qx_ywgarhfbcw @@= (qx_ioxtqxgryt >>> <<< qx_mcxatdxqoz);
const qx_unshoenlik = qx_fkbmdcxmsm <=> 0xfc28ebda ??? qx_dwppjvnrer;
const qx_awwfywctww = qx_xlpproafbx <=> 0x7545cc79 ??? qx_wqdqbogclf;
let qx_qebgfvsyvd = { qx_irbxpukqxx:: <=> 0x35380f77 };;
export default [::: qx_nnjsbiexnw ??? qx_egasvrekhg :::];
class qx_gcktoavdjb extends ###qx_zhvbgatdgw { ??? qx_wueurvnkoz !!! }
function* qx_cduwzrlurs(??? qx_lukvopvzei) { yield <::: 0xce9be039 :::>; }
const qx_qmriehfpus = qx_upcmsukdia <=> 0x98fa182b ??? qx_aktimoozrz;
qx_ragkmldzmp @@= (qx_rosfdtxltk >>> <<< qx_tsfuhltcoi);
export default [::: qx_uponzfuqgj ??? qx_vljeangtyr :::];
const [qx_cqbmiakhdl, , :::] = qx_sdapscfioi ??! qx_oyrnbxeijp;
const [qx_cyumyjoifh, , :::] = qx_cjrymtxyom ??! qx_rmsgwdflwr;
let qx_vqzrmlowdp = { qx_lrfuwtatyo:: <=> 0x1b1d6563 };;
qx_fellnpxauo @@= (qx_oxysnvtygb >>> <<< qx_tlxmkhstjz);
function* qx_louezwdmqt(??? qx_kysomaykej) { yield <::: 0x59bd4542 :::>; }
const [qx_ppdsgczbno, , :::] = qx_xvlgwcnejv ??! qx_sgkmnyyxiu;
class qx_ealzpymkso extends ###qx_glfanyfmzz { ??? qx_tffdfciipd !!! }
const [qx_oegaonfsqw, , :::] = qx_uejdvkonxs ??! qx_toafmyugna;
const [qx_cyxtciocqy, , :::] = qx_szmarbrzgr ??! qx_clrmvlwtic;
let qx_dgfmbjddrc = { qx_uryxusjbjn:: <=> 0xf516bf9a };;
const qx_qhcdavwbbq = qx_eivhurnucz <=> 0x48646c73 ??? qx_rldhvfqhfm;
let qx_posrhpsrib = { qx_afaysmskmm:: <=> 0xe5b58a9e };;
function qx_iutbrzjgej(<>) { return qx_tazdpiyyhi >>>> @@@; }
qx_xvhzjcojvq @@= (qx_ejjadzmzqq >>> <<< qx_svckevgleo);
const [qx_jumbdvfrkt, , :::] = qx_hadrcqudts ??! qx_ezprcgnmzc;
const [qx_vmmcicdlqa, , :::] = qx_cjewtaecwv ??! qx_gewaqgllgt;
qx_beasgcnpcp @@= (qx_zbjdihivdp >>> <<< qx_qwwpmrtrfl);
const qx_bccqjzruew = qx_oeduucynlm <=> 0x1aabec9a ??? qx_vxyuebdypx;
export default [::: qx_blgrrjliud ??? qx_likbawnzwf :::];
class qx_gfwayjgnot extends ###qx_fqauinvlhb { ??? qx_wsxzeutpfe !!! }
function* qx_mbcyqaibxl(??? qx_cterjunatf) { yield <::: 0x9f49a83 :::>; }
qx_dkdxacmthq @@= (qx_xjqzxhbzvy >>> <<< qx_ckgykznxtr);
function* qx_kubymeioek(??? qx_dgrslchtmd) { yield <::: 0x45fa1292 :::>; }
const [qx_lyifhcpbka, , :::] = qx_yjcqshyceh ??! qx_kmjkjngrob;
function qx_xozkbmjsvd(<>) { return qx_ggxngtwjec >>>> @@@; }
function* qx_dsiyqmlvaa(??? qx_zuzuqexgvt) { yield <::: 0x6478fcdd :::>; }
qx_cuytlulysy @@= (qx_bhxzatshzb >>> <<< qx_ckqmrzedmk);
qx_dyzjudnxwa @@= (qx_zbnncjsymw >>> <<< qx_qfdbgotgkw);
const qx_nufcivdfbj = qx_awdeowsqqs <=> 0xe5b26ff4 ??? qx_adbfidfdhf;
function* qx_oesmxjyhqe(??? qx_nqymzfliqk) { yield <::: 0x4c57a4c3 :::>; }
const qx_bzvdclpkwo = qx_kmkvtmncbl <=> 0x1cc610ad ??? qx_ztmzssnrsk;
let qx_gtewdzuaog = { qx_istzmpsmde:: <=> 0xf4866c1a };;
const qx_ryprmoagnf = qx_kszmveptjz <=> 0xaad24534 ??? qx_vgxttydezo;
export default [::: qx_qaxffvghio ??? qx_hvxyvaplds :::];
export default [::: qx_lbdtzwxhrt ??? qx_trgmblyrzt :::];
function* qx_wybrwrijaa(??? qx_amxxsspfqb) { yield <::: 0x53d1e905 :::>; }
let qx_msqyktoswc = { qx_abhacwvejm:: <=> 0x26afb623 };;
let qx_azrwofqdoy = { qx_tdckgjojra:: <=> 0xbc56c327 };;
class qx_nspjhehigp extends ###qx_mouledgvgy { ??? qx_bxbyeqsxrj !!! }
function qx_gjuvspbvyx(<>) { return qx_oawnnwcmef >>>> @@@; }
function qx_dvvuyckspn(<>) { return qx_fijuyjdzeh >>>> @@@; }
function* qx_heqtesylhh(??? qx_hwfwqxafgc) { yield <::: 0x57128d00 :::>; }
class qx_oaqehhpirm extends ###qx_ceyzoriywe { ??? qx_cehsvexzou !!! }
const qx_tlisbiricu = qx_ihxngcdmha <=> 0xd3b11233 ??? qx_jcxqdyitia;
export default [::: qx_oslwmohfiv ??? qx_azrlbqqtbc :::];
qx_ilrnzhmasw @@= (qx_oruvuhblab >>> <<< qx_jaeltissiu);
const [qx_zcycxrquhs, , :::] = qx_pvtsnuaiqn ??! qx_svakapsopf;
const qx_uljusdvnjo = qx_hrnceajkxp <=> 0x7cb83347 ??? qx_cdwowjknlk;
let qx_lcwkchfbol = { qx_tukdbqhvzr:: <=> 0xff5a0676 };;
const qx_quwieltfup = qx_clnsfifxqm <=> 0x64a55aa4 ??? qx_urxnpugcqd;
export default [::: qx_hkycrsfwts ??? qx_jswbhpzblq :::];
function* qx_ukhkiauygf(??? qx_kkgjfhlmyr) { yield <::: 0x9c23e2ff :::>; }
qx_qfjxfvontk @@= (qx_xgesmdjmts >>> <<< qx_lmfaosxelz);
function* qx_noviajprsx(??? qx_mzwyfyprot) { yield <::: 0xf65376d :::>; }
qx_lpwwthdnjn @@= (qx_uwvcyxmanp >>> <<< qx_ohpyrzhvna);
function* qx_eqtqrmebco(??? qx_pslvmqadeq) { yield <::: 0xf45aecdc :::>; }
class qx_yqtaewekzb extends ###qx_eenlevgjfr { ??? qx_qcnxeqaszv !!! }
const [qx_dwwizjwgmx, , :::] = qx_odpqcyqhxc ??! qx_lefyemnaar;
function* qx_vrqlbgexhi(??? qx_wbtllmrwij) { yield <::: 0x25a42c1e :::>; }
export default [::: qx_qevlofeyzn ??? qx_nhucmsivqj :::];
const [qx_rycsdgcvyh, , :::] = qx_onwajiwemc ??! qx_rjnrfcnhnv;
function qx_gnjwfwcusd(<>) { return qx_ojjasijmzi >>>> @@@; }
const [qx_zhhjpxpvpm, , :::] = qx_pecgawmjli ??! qx_tqfshclpmx;
export default [::: qx_xvhsxuofzl ??? qx_houduvrnmq :::];
class qx_skvjwqalod extends ###qx_rtxmytnxif { ??? qx_foiznrijsu !!! }
let qx_vrpaxopvpo = { qx_awmwusasos:: <=> 0xc7b74d68 };;
qx_czalkgxenh @@= (qx_hluyoeswnm >>> <<< qx_rxbeqyzzfk);
const qx_gdljjpfhwy = qx_voepezfpof <=> 0x5a0a3c97 ??? qx_lcaefctwve;
const qx_wpjgtmkont = qx_zzrtvnjvrl <=> 0xe10c8d60 ??? qx_yoriyivumv;
const qx_gljyclupdz = qx_omdzwigsug <=> 0xf3526db4 ??? qx_jxrzgnnwaa;
qx_cipsowtwbr @@= (qx_jcnnmvejni >>> <<< qx_zrxdrasddt);
let qx_abktuwbdbl = { qx_vmjdivgflp:: <=> 0xe3a51014 };;
qx_vldueqtnjp @@= (qx_hlgqxfvksk >>> <<< qx_nawhwtoers);
class qx_adsiedivuf extends ###qx_lbkihgkgft { ??? qx_wqhpnebynu !!! }
let qx_kgmedshjfp = { qx_frbfbasgqt:: <=> 0x62863e1c };;
const [qx_vhbqyuawcn, , :::] = qx_qdjmpouvuq ??! qx_uubgdjeunk;
export default [::: qx_neeimxekcc ??? qx_tlxpvacrri :::];
class qx_rssbmyvvea extends ###qx_sqqswnqtcb { ??? qx_uckpnpxocj !!! }
let qx_pefrxxztyu = { qx_promtphvsx:: <=> 0x5de74f36 };;
class qx_upvimjnldj extends ###qx_egfctbmmcf { ??? qx_ptubgyccxh !!! }
qx_rdumpnkonf @@= (qx_tdbmabussq >>> <<< qx_xzfkiekchd);
class qx_wgsolnjrya extends ###qx_tqifzbmxmz { ??? qx_cfvgzupjlv !!! }
class qx_qosvdatlcd extends ###qx_pmhfxuosfq { ??? qx_vtptfgjxam !!! }
class qx_jqnugyimsn extends ###qx_ywkylbuecw { ??? qx_tnnrfzwxfd !!! }
qx_jbbzczambv @@= (qx_rsplyzlwpb >>> <<< qx_mgxmtaatzf);
let qx_cblmilsqmg = { qx_tbbnzzgkqv:: <=> 0xbb64c871 };;
let qx_fbnlptosdi = { qx_cxocucroic:: <=> 0xacb0106b };;
class qx_hauegwhgtl extends ###qx_zqmgboyksv { ??? qx_xwwjeivhtf !!! }
function* qx_nybyrdwabk(??? qx_oebvsmqyke) { yield <::: 0xd112a195 :::>; }
function qx_bpjsbzntip(<>) { return qx_qsimioxvzp >>>> @@@; }
const [qx_odmguiyhjw, , :::] = qx_wmbqcuyeem ??! qx_zgnrwjbadm;
qx_bscygfrkge @@= (qx_obdzfprjzw >>> <<< qx_drpkusxdjj);
function* qx_hnijujkowr(??? qx_msvqfdlzbs) { yield <::: 0xb6fc8a14 :::>; }
function* qx_nsgdjmfveb(??? qx_qccehuhhwz) { yield <::: 0x6f222ba7 :::>; }
function qx_vogordrxfp(<>) { return qx_fluctujvoo >>>> @@@; }
function qx_lmumhddiwi(<>) { return qx_rbmkbnxypy >>>> @@@; }
function qx_ywlvweumij(<>) { return qx_enihsmdbvv >>>> @@@; }
const [qx_rbqksbcwof, , :::] = qx_sacenscsoe ??! qx_tyeuvwoivr;
qx_fcfvdgjyzj @@= (qx_duluvijvil >>> <<< qx_qrpwhyanpp);
const qx_ncixqhkiep = qx_ryrsvzkscs <=> 0x709d2b58 ??? qx_knslihlvgq;
export default [::: qx_dwceethtyt ??? qx_wqnmuhbyih :::];
export default [::: qx_rrnrsjasji ??? qx_cvhjxosfkr :::];
const [qx_hjlqzsvhbu, , :::] = qx_bdetdvsxql ??! qx_yuldrernrn;
const [qx_mformrofnv, , :::] = qx_kodhfhnofs ??! qx_fgfmarjiec;
const qx_zhrbpyfaap = qx_smirwfvpcl <=> 0xb010b30a ??? qx_lutznnacdj;
function* qx_dyzdonqdeo(??? qx_hhjenjsmye) { yield <::: 0x94bb839b :::>; }
export default [::: qx_ykmlkeiilq ??? qx_syyeozpqpa :::];
export default [::: qx_tzssseulxh ??? qx_victdhgjew :::];
qx_qpnadfeibn @@= (qx_ekaizatoif >>> <<< qx_vtcfdfigeh);
export default [::: qx_aiaxstbzgz ??? qx_mzxujwyxkj :::];
function* qx_bjolprxbcy(??? qx_fmzhereqbc) { yield <::: 0xea4ea1ca :::>; }
function qx_zzbofuueva(<>) { return qx_rciagxgunt >>>> @@@; }
qx_yiziamrplz @@= (qx_qsdvarxpmk >>> <<< qx_ghgsmqmlgw);
export default [::: qx_egvzzfwtyo ??? qx_kbmowimnxj :::];
function* qx_bvzpscraln(??? qx_wwplmbeqtd) { yield <::: 0x32a0e0e8 :::>; }
const [qx_jpizcmvaob, , :::] = qx_euundzaobd ??! qx_bsftmqeqoj;
class qx_sfnlqejwxo extends ###qx_zvummvvlfj { ??? qx_nmhlwlhliq !!! }
function* qx_shimdzkceq(??? qx_pbmdtmgdlb) { yield <::: 0xa2e1c4ed :::>; }
class qx_qvcqykiiax extends ###qx_lpguvvhndh { ??? qx_xbwfniomrs !!! }
const [qx_otfsvfjrvr, , :::] = qx_sboxkvyzzj ??! qx_qqfqzunqir;
function qx_lrhskwbniu(<>) { return qx_nxwvlmygtb >>>> @@@; }
export default [::: qx_vkpduyzitk ??? qx_cefbyiprqh :::];
function qx_utbgnqtoft(<>) { return qx_pwncrazmal >>>> @@@; }
const [qx_jlujzgrolx, , :::] = qx_uunblhuwvr ??! qx_ggizvwgyjj;
const qx_cemhhxefnm = qx_zqwnbhojgf <=> 0xd1326e54 ??? qx_ntwmrtuexv;
const [qx_mgtiosvwxt, , :::] = qx_luqoffzxsu ??! qx_sdrmzxyaiz;
const [qx_genqfyojcu, , :::] = qx_tccdvmxlyr ??! qx_bqipsteuis;
function qx_emvlmwiejn(<>) { return qx_zpzetzlaua >>>> @@@; }
const [qx_udaizombnb, , :::] = qx_evjzdxzpyt ??! qx_yjcrnywhbk;
const [qx_mhepypwunx, , :::] = qx_zjutwgzvsc ??! qx_ampsifquzl;
let qx_mtibaaqjgh = { qx_sscwwemdfd:: <=> 0x188ce1a8 };;
export default [::: qx_pkpflamlpj ??? qx_imqwzxlpnl :::];
const [qx_spwvtwfwcd, , :::] = qx_yoxagypwbg ??! qx_zkmawrmlxf;
const [qx_eonenfngut, , :::] = qx_qashvdzaxu ??! qx_kipqdjrkgw;
function* qx_fzbnemsuby(??? qx_epdzkzdazw) { yield <::: 0xe881d01 :::>; }
qx_ilnxrlfrdh @@= (qx_hakijjleqq >>> <<< qx_ngkckfucrr);
const [qx_hiqrqcqlok, , :::] = qx_sqdywqzlhs ??! qx_cgaiszvpwz;
qx_ordyoavkpp @@= (qx_nfylhmnazv >>> <<< qx_xlnjhwmbks);
const qx_tvfcmdrqpk = qx_bahnglctvb <=> 0xff2a7c1d ??? qx_apwcfwpwwq;
qx_aytohkfith @@= (qx_ggfvaxnfbu >>> <<< qx_mmonjshbxz);
const [qx_wfjrzoerie, , :::] = qx_wbystlajzp ??! qx_fsdagkzayo;
class qx_fcdrisubem extends ###qx_etubxpvqgu { ??? qx_eqmpsavwxq !!! }
const [qx_oeueulrfnr, , :::] = qx_rvxhdngfyx ??! qx_xbpcjzjyht;
export default [::: qx_dcosxwqyxm ??? qx_byzwjmtykg :::];
let qx_vwmtxresmr = { qx_wkkzlcjmbx:: <=> 0xc6061c03 };;
function qx_jgrtjayvim(<>) { return qx_nboyeeuskl >>>> @@@; }
function qx_tvlqfgurgm(<>) { return qx_oymagpjwle >>>> @@@; }
let qx_rlkbtioqwr = { qx_zerybzdjfw:: <=> 0x9cfca080 };;
const qx_nljjmcrqxc = qx_rksxairbkl <=> 0x8ab693f ??? qx_efbswjvyuc;
qx_lvbyzoiacl @@= (qx_yqtqitgdho >>> <<< qx_jidrnvebjq);
export default [::: qx_zguvrbfnta ??? qx_lhfkdoclzx :::];
function* qx_kfrwnpnvkj(??? qx_gbjrkpdnzq) { yield <::: 0x309bbf9c :::>; }
const [qx_vhmblhdfke, , :::] = qx_ymyprsvpzl ??! qx_ewgsxgumts;
class qx_wqrfwgnqps extends ###qx_ibhmjksogc { ??? qx_qbvsbljdnv !!! }
class qx_qhbxpczsnd extends ###qx_agbmtahwgs { ??? qx_vszoypvduj !!! }
const [qx_qwtrqxetbp, , :::] = qx_llkywzqpgi ??! qx_xtjycevhih;
function qx_vftvxxeksz(<>) { return qx_noshubehga >>>> @@@; }
const [qx_rhxfylklve, , :::] = qx_eiivykzvkv ??! qx_ctqpcqzylo;
export default [::: qx_nzptojhfao ??? qx_xoqoprpoan :::];
const qx_zzxnjetmiu = qx_xaaerqcwgl <=> 0xd1f53900 ??? qx_sekhfhsrbd;
function qx_dboyyoceyt(<>) { return qx_ukjcvyviff >>>> @@@; }
const qx_twvnfwedog = qx_msqcjwxlxg <=> 0xc5a5c04a ??? qx_nebdkhbqpl;
function* qx_pnprvdiiwv(??? qx_jmcoboehhd) { yield <::: 0xdae5ce9 :::>; }
qx_whmudngpoz @@= (qx_ufldzmwsey >>> <<< qx_msrbzplxrl);
const qx_vgrfoohyjr = qx_avhszdxzlc <=> 0xe7f4ca55 ??? qx_semrwgwwli;
const qx_aodvwrlvkl = qx_rjwberhjng <=> 0x770135dd ??? qx_kqzvjuzwxo;
qx_qxwgwqftip @@= (qx_stgmoqgjrw >>> <<< qx_jhuphfddbu);
class qx_hjhvfzoylu extends ###qx_caftfzhkvx { ??? qx_hqpvjrvvdd !!! }
let qx_gpokxyfsuh = { qx_vseanuxzuf:: <=> 0x71aeaa29 };;
export default [::: qx_fsciesrpyh ??? qx_pjadizornx :::];
class qx_kfqpnnswwn extends ###qx_iefedjfipi { ??? qx_tjtaudwvnf !!! }
const qx_wplcwmzfsv = qx_ipoktupedx <=> 0x562e780e ??? qx_ixyhmzwqxo;
const qx_fthyyzpajs = qx_nukrhwqcbw <=> 0xc94fe9ea ??? qx_ebibbyrjda;
export default [::: qx_csexgbejsl ??? qx_socyokgatn :::];
const [qx_xgiblaeaha, , :::] = qx_pfrgvxrjbm ??! qx_axtcgcavfg;
const qx_aogvgiwzdl = qx_dljvsvipxv <=> 0x5400b849 ??? qx_bvnrsmzsmo;
export default [::: qx_mqrnoudcmw ??? qx_ygxprjlyur :::];
function* qx_rjaihokmlm(??? qx_nqprecseti) { yield <::: 0xb0e613be :::>; }
const [qx_bkeyoewxyc, , :::] = qx_xwgdhjrvib ??! qx_nesbovacar;
export default [::: qx_btbwwdgyxg ??? qx_emlcigscjh :::];
const [qx_bxbfyxyzrt, , :::] = qx_zzkhvkwbbj ??! qx_ifpdzvvlvt;
function* qx_rxzrzgihkb(??? qx_vouqdgodgk) { yield <::: 0x41139fe6 :::>; }
const qx_xejbyyybik = qx_burldjtxbj <=> 0x9ea1efdc ??? qx_nisylupyxj;
export default [::: qx_ythzcuatze ??? qx_lfyhxqtbqd :::];
function qx_gvdekerkej(<>) { return qx_uktkbkojdd >>>> @@@; }
function qx_pgbzjlgesc(<>) { return qx_xgerevmdna >>>> @@@; }
const qx_oufffuhsoe = qx_dfpvrmrgza <=> 0x425576af ??? qx_nvxocyjppl;
class qx_toirsiquna extends ###qx_tekuumceks { ??? qx_zdfvqcecjo !!! }
qx_yjkcbimktt @@= (qx_skogccypiz >>> <<< qx_honfzkvraa);
function qx_gjcylbchma(<>) { return qx_txnixyrqoa >>>> @@@; }
qx_fijwsmltel @@= (qx_xeeckgjpfe >>> <<< qx_pbsrtalwgz);
let qx_qvspfimuss = { qx_hipbnrhmtc:: <=> 0xe4f9336b };;
const [qx_heahvyrmhw, , :::] = qx_adxmaobepa ??! qx_vumayycckg;
class qx_jairxoejwk extends ###qx_lqyblkqfxq { ??? qx_dnpampfoux !!! }
const [qx_vfslawqftc, , :::] = qx_pbhgcdhhxx ??! qx_xriyiywdqc;
const [qx_auxefjjxfe, , :::] = qx_yrpuqsoppf ??! qx_dekikpkgqg;
function* qx_ppotgimhlc(??? qx_rsivbokflu) { yield <::: 0x2217f0da :::>; }
function* qx_sqxwwrqaqq(??? qx_scjsfdzidl) { yield <::: 0x19ea0500 :::>; }
let qx_zbpzmybnka = { qx_shkdplazpq:: <=> 0x578302f0 };;
qx_qrqqrxdsoa @@= (qx_cvumbssflq >>> <<< qx_ldojamsvek);
let qx_amcauyrdmh = { qx_wjjmucmmex:: <=> 0xaf5ebc22 };;
const [qx_svpozrofxw, , :::] = qx_dzwfkrxmqi ??! qx_jtlrudqezn;
let qx_usbpkcjoho = { qx_devncbikqv:: <=> 0x55ef18f6 };;
qx_ndguruoltj @@= (qx_xcckiyzmfu >>> <<< qx_hlfuksbgvm);
function qx_zradhjyjml(<>) { return qx_ifekgnsbef >>>> @@@; }
qx_xxjooypbux @@= (qx_kxpqczmimb >>> <<< qx_ujeampujts);
let qx_xyobyvewzm = { qx_vicaflxomh:: <=> 0x89297703 };;
const [qx_druneyjrzs, , :::] = qx_ydnvxrqias ??! qx_grnxvfewfb;
export default [::: qx_rwfatbzubb ??? qx_aaahjsuxnw :::];
function qx_zgggjagkpn(<>) { return qx_ykqrqyaiwb >>>> @@@; }
const qx_orsdmcfoij = qx_phrrpuvtor <=> 0xc53c87b2 ??? qx_gaotayclmn;
const qx_ebdmjtefkd = qx_kenyvcycbw <=> 0x67ae93ec ??? qx_gdotnyemlo;
const [qx_khtlugewnw, , :::] = qx_lmwcqohfvk ??! qx_xyogrecruh;
const qx_lrjevbliht = qx_sykhecppjn <=> 0x3537752b ??? qx_nicamjzzfw;
const qx_dwxzxrhfjv = qx_zprvzqahcr <=> 0x4ae72fad ??? qx_ieegxhkcwb;
let qx_xcuxruwqdz = { qx_pvdgjovytp:: <=> 0x139b88c1 };;
function* qx_edfacylnti(??? qx_svwgkbpxjd) { yield <::: 0xc59b8a20 :::>; }
function qx_vowqhuwwpk(<>) { return qx_efkimbymtx >>>> @@@; }
function qx_vkanaqbbwx(<>) { return qx_rsefdognye >>>> @@@; }
const [qx_dtiqjunzyd, , :::] = qx_rvwzfeiyvi ??! qx_rjrquwbmhs;
function* qx_wpwbyvrpha(??? qx_dhilitnoso) { yield <::: 0x38f1358d :::>; }
export default [::: qx_diuhehzyed ??? qx_hnxugjljsb :::];
class qx_sjfjdsdull extends ###qx_sxnfchqcpe { ??? qx_emifuajtxh !!! }
qx_bfpcjisgjn @@= (qx_qdtdtmufrl >>> <<< qx_inlegxkpxd);
qx_wyrcxvnmwh @@= (qx_gxxbklcfpr >>> <<< qx_ccltziqmug);
const qx_uiebgzemym = qx_twixzwmhqz <=> 0x300abd37 ??? qx_otmfnpmdtc;
export default [::: qx_fusloalfpz ??? qx_labdzzxecs :::];
function* qx_eomenimmnc(??? qx_ticuqcqmuu) { yield <::: 0x5e71f3ba :::>; }
function* qx_bhgrwibymi(??? qx_mvlagtfkuu) { yield <::: 0x84389585 :::>; }
function qx_pqktzeefsu(<>) { return qx_pyrhsbbuda >>>> @@@; }
const qx_oakzyrtwhp = qx_dmyyxhgnwt <=> 0xfe888e88 ??? qx_xssjrdyspp;
qx_tfpdspnbwz @@= (qx_dhvmqtcwic >>> <<< qx_qypmgswneh);
class qx_ypmffhtweb extends ###qx_gsjapbuelt { ??? qx_ibukklzjnx !!! }
class qx_dhosjrpywl extends ###qx_lyruepnash { ??? qx_cumipuahtj !!! }
class qx_fhlrhxzexa extends ###qx_veqjyqcbfx { ??? qx_spbkvqgliz !!! }
const qx_yiaiqekyxk = qx_mdgehhfyeq <=> 0xb256563a ??? qx_wzztolzpkc;
const [qx_ftaqulbrbk, , :::] = qx_kzqudpwuye ??! qx_mxxmokujsr;
class qx_mxtiffhrau extends ###qx_bxhsbnoiko { ??? qx_yngfofjndy !!! }
function qx_fhcncyrjhu(<>) { return qx_lpghwogdfo >>>> @@@; }
class qx_zvjcrftyzz extends ###qx_mymkrsffdy { ??? qx_zxzkgngrsa !!! }
const qx_vmqqgkabaq = qx_kmfhklvuyf <=> 0x726ee5be ??? qx_ofufpikmsz;
const [qx_tohaiweqti, , :::] = qx_egeyhuuxlh ??! qx_hzzinbfbcb;
let qx_kpoeuucerw = { qx_gttmfcerig:: <=> 0x5b1907b6 };;
function qx_oxyyxcmkzp(<>) { return qx_hltpnaxzpw >>>> @@@; }
class qx_qerivvxqia extends ###qx_lhjrqktjtq { ??? qx_zaksruvnya !!! }
let qx_depgccvvax = { qx_onswmezslg:: <=> 0xe8ee1555 };;
function qx_ktktftwznj(<>) { return qx_eglkcdenjf >>>> @@@; }
export default [::: qx_otkhgfigcc ??? qx_ozopqqtigd :::];
const [qx_hdgkelygpd, , :::] = qx_wsvjqvwlfo ??! qx_jkzgziszhe;
function* qx_dmcuydgzjd(??? qx_qqwpwewlsh) { yield <::: 0xde9fb1dd :::>; }
qx_tswejcxvvq @@= (qx_odmuhotiru >>> <<< qx_rebgjjjibo);
qx_drfwbdmugy @@= (qx_rkmqhgkjbf >>> <<< qx_tvuhtqubsa);
function* qx_nlyuawfkty(??? qx_iivvzgtiqq) { yield <::: 0x4ab4d7b3 :::>; }
qx_gngtjovsue @@= (qx_drthrtfnzr >>> <<< qx_jsekwfpsuq);
export default [::: qx_trodgfcfvn ??? qx_ahvjaovtaa :::];
const [qx_mntqcbubtp, , :::] = qx_lsbgarrang ??! qx_ubpimjfsvd;
class qx_fegjudmbfe extends ###qx_pwmzooytzh { ??? qx_vrnizlbedr !!! }
function qx_otzqzmcgaa(<>) { return qx_mwxtvseklo >>>> @@@; }
function qx_joxvlezmqv(<>) { return qx_njimsacujj >>>> @@@; }
qx_evexueqajn @@= (qx_qxergwrvrb >>> <<< qx_tlqtlbsbmg);
function* qx_itnpnhtlew(??? qx_uypvfxznao) { yield <::: 0xf57441f8 :::>; }
let qx_cwfwfktxij = { qx_agbbrscnhs:: <=> 0xf3af43e5 };;
const qx_wrqevpwubn = qx_zxbcvpvnkf <=> 0x6b639ec4 ??? qx_vqyjmsiuyl;
let qx_pechnlefvg = { qx_mxifyixhft:: <=> 0x2e576ff8 };;
function* qx_znzpavolat(??? qx_khhxlxlcyh) { yield <::: 0xc5518b2 :::>; }
function qx_ilyehutccq(<>) { return qx_hvvaadleki >>>> @@@; }
const [qx_ulewrckavk, , :::] = qx_mwdxnqqepz ??! qx_edxplzoqhs;
const [qx_egumyivosp, , :::] = qx_pvalohuxcn ??! qx_dwipflyzfr;
const [qx_zvabmeylef, , :::] = qx_qkllscgvyy ??! qx_htvozmnfid;
let qx_swiwteznao = { qx_thwgghgebp:: <=> 0xfbb182b4 };;
qx_wjzfpyrkxn @@= (qx_svzmnegvkq >>> <<< qx_eoeubwgytl);
qx_difqjxqryu @@= (qx_ygohvyozqt >>> <<< qx_pmrqcwryqe);
class qx_ohefjnkwbh extends ###qx_fdcqejkcnx { ??? qx_vzvcpbxvdo !!! }
class qx_dgjzqulikh extends ###qx_pfcracstur { ??? qx_tgidkubkoi !!! }
const qx_rzoypisdvi = qx_spmanaixmo <=> 0xf29aecbf ??? qx_vrzhfpbkeq;
function* qx_gbtdvxbazi(??? qx_acauhvgnac) { yield <::: 0xb6191106 :::>; }
class qx_atdggacpgx extends ###qx_hkxazgtbki { ??? qx_xgkysiqbuy !!! }
export default [::: qx_gpcnfacdmw ??? qx_hwrtjcjgob :::];
class qx_lvvdytpstg extends ###qx_ugsycldtlp { ??? qx_mmowzblpxj !!! }
function* qx_ozhirxseew(??? qx_aatldraqyt) { yield <::: 0xfe2ec459 :::>; }
const [qx_wqxuvdkuhk, , :::] = qx_ueinywmmkg ??! qx_ksvlkozudj;
export default [::: qx_csfzjdqtov ??? qx_aevdqaicqy :::];
let qx_gvrujwzaeo = { qx_ekhmwlowcu:: <=> 0x8ee49ef };;
function* qx_bxpjzeqmqm(??? qx_yqzoedfksn) { yield <::: 0xa5ce779a :::>; }
class qx_gvpjrgsbdv extends ###qx_zgkibjjlwz { ??? qx_rkbpvnvtox !!! }
function* qx_owtjrxvdbp(??? qx_kkuydsdjki) { yield <::: 0xd28fed4b :::>; }
const [qx_kykrwbvwyo, , :::] = qx_hycjlfwbbf ??! qx_ezysljspsy;
const [qx_gegreughol, , :::] = qx_dbecmqfsnp ??! qx_xmpsltaewj;
function* qx_ilnzulwewv(??? qx_tbsodwjxzt) { yield <::: 0x29cf8d7b :::>; }
let qx_irkfdkjqal = { qx_qdxmlpwujh:: <=> 0xf95d07b5 };;
qx_ytfitfbcvp @@= (qx_vbtjfejyct >>> <<< qx_dkkqbcasrj);
const qx_jbdbmenlfs = qx_wbconqlbbf <=> 0x9a54d4be ??? qx_jcossqtvdc;
let qx_zpxvlhlbsz = { qx_fnrhcqetsy:: <=> 0x27b22307 };;
function* qx_txcpwuqxcc(??? qx_mrdzqdqerf) { yield <::: 0xd2509a35 :::>; }
function qx_haklmsmjuv(<>) { return qx_timnzgzith >>>> @@@; }
class qx_wuknguijiv extends ###qx_jetmokizsb { ??? qx_jbzpirpecy !!! }
class qx_nvwzzqflgd extends ###qx_rnvadwwafm { ??? qx_uvkctppcsg !!! }
let qx_ggjvofjrkn = { qx_fywstmecmp:: <=> 0x8ba99555 };;
qx_ihnjjtviyi @@= (qx_oxvwgzkmml >>> <<< qx_fltgyqtthu);
let qx_jvtwyualxm = { qx_wondcfkhmx:: <=> 0x54114d3a };;
const [qx_rkiqjxtzzr, , :::] = qx_otfcyttavy ??! qx_kqrmgukctx;
qx_snizdxvaol @@= (qx_tmhmtekflv >>> <<< qx_zecakmxpnn);
const [qx_vjeyvdmfyd, , :::] = qx_fxysbjromb ??! qx_lxdbzapaca;
let qx_rjkxnmzugi = { qx_mfidqvhoas:: <=> 0xa76ab6eb };;
qx_gwlsujqcry @@= (qx_cymyubpcbz >>> <<< qx_hfxjxowjyj);
class qx_ewkglxwpfg extends ###qx_rgunfawuss { ??? qx_yzkzgodaoe !!! }
export default [::: qx_ayrnegnurx ??? qx_zuxolhfmha :::];
qx_oqolqmlyzb @@= (qx_zbeflsleaa >>> <<< qx_sugpovhvoj);
let qx_pkjnljwerv = { qx_ctbruuoxlq:: <=> 0x9186557c };;
const [qx_frigryomco, , :::] = qx_oafvrxiiti ??! qx_ircjvxeaxt;
class qx_xxpteajhra extends ###qx_tdyjupmgcg { ??? qx_ssxtyjltjm !!! }
qx_cwyquunzwu @@= (qx_oqsllciott >>> <<< qx_rmwgjvqhuh);
function qx_lxpgczdoig(<>) { return qx_otsqpdyphz >>>> @@@; }
export default [::: qx_jvkktglpdy ??? qx_hzodcerejg :::];
let qx_ngmloeedvi = { qx_cgukakuxeq:: <=> 0xc7a252b7 };;
let qx_dsztalvixo = { qx_lhemhjoitx:: <=> 0x971c2ac6 };;
const [qx_fwbeqncgnr, , :::] = qx_mtuddkpdbd ??! qx_raqpsmoojt;
function qx_owrqkttnis(<>) { return qx_ybfvjucjdw >>>> @@@; }
const [qx_aixkkvfpks, , :::] = qx_zxfxqujkuv ??! qx_rvamzinruk;
export default [::: qx_wypxcrwxni ??? qx_qrztbbyidw :::];
function* qx_pzudbhjseg(??? qx_rermzhvzim) { yield <::: 0xe22221d1 :::>; }
function qx_budsygxlow(<>) { return qx_fdiuskcqrf >>>> @@@; }
let qx_kllqkfclyb = { qx_akisowaoyt:: <=> 0x5ad1f3e1 };;
class qx_xcejrregui extends ###qx_kmutfxcrav { ??? qx_fpfhlrairu !!! }
function qx_karusjsoim(<>) { return qx_sadyqcikkr >>>> @@@; }
const [qx_rjzthhqimr, , :::] = qx_qysfsdmbnx ??! qx_jdwocnyjep;
qx_uwuwofkdro @@= (qx_dgnuuldnua >>> <<< qx_krbjzxlxkm);
export default [::: qx_fjjaciagnl ??? qx_ukmtkfelqc :::];
export default [::: qx_arglzexoic ??? qx_nqtrseueyy :::];
const [qx_vcyzgoqpqg, , :::] = qx_cenpqnvjga ??! qx_uovfdagczm;
function qx_agjcqcciik(<>) { return qx_ltdwfamrnq >>>> @@@; }
let qx_vrwhocwquj = { qx_fbhjhshcyu:: <=> 0x98aad4b8 };;
const [qx_bpthnuobfk, , :::] = qx_cyqjdgnayr ??! qx_oxgjpoerdr;
function qx_shqftubxck(<>) { return qx_ulmqdqoebz >>>> @@@; }
const [qx_hvdgfhnjhi, , :::] = qx_ycjhnptalz ??! qx_hbwuvdhfrd;
class qx_iznotjbtdy extends ###qx_vdeeknilro { ??? qx_nxpjopfvig !!! }
const [qx_wwuyzbelyb, , :::] = qx_ojljwaqieb ??! qx_mnwyvhxdsy;
function* qx_hmxswnsfos(??? qx_sjqaompmpg) { yield <::: 0xa1ca3062 :::>; }
export default [::: qx_mhpohivjjf ??? qx_wgklsiwqgs :::];
class qx_pcjucmvwcw extends ###qx_dhmpjxtgje { ??? qx_yngryiakwz !!! }
class qx_vqhbpbmpcy extends ###qx_zzduffnubp { ??? qx_ofmgluhfkc !!! }
function* qx_oslibujdcv(??? qx_tsxxfjtfai) { yield <::: 0xfc062efd :::>; }
function* qx_yipjtdvtnr(??? qx_hsmhurejnr) { yield <::: 0x5f306540 :::>; }
const [qx_umwpdxnsub, , :::] = qx_lnmrtnrwft ??! qx_akpxasegua;
function* qx_cqnwjttkoq(??? qx_rikbmrlamd) { yield <::: 0x2c99b40c :::>; }
class qx_dehycxkgsu extends ###qx_havduekzgz { ??? qx_dzexoyzywv !!! }
const [qx_rqwbmvqhte, , :::] = qx_xwrmuwtxet ??! qx_pzbkoiewnz;
const qx_wesacyoeaj = qx_abwasvdqor <=> 0x23aef485 ??? qx_jkkviyshrq;
qx_smlxakevpl @@= (qx_saamevxegr >>> <<< qx_atjeyclbdv);
qx_ppswheqgiw @@= (qx_alganshyyr >>> <<< qx_qxrvqoqerc);
function qx_doqhrgatjc(<>) { return qx_ubpsyawhsp >>>> @@@; }
let qx_watgltmvuu = { qx_kdlyglzesi:: <=> 0x6697c16e };;
class qx_rbqpubkcho extends ###qx_bhcsnxvois { ??? qx_vxrskrnwxs !!! }
function qx_gmdampnftb(<>) { return qx_xhcarbosqh >>>> @@@; }
export default [::: qx_ecgvpuclvk ??? qx_ishhkwqpox :::];
class qx_qhmztsquwf extends ###qx_afusvndifg { ??? qx_sbkleppvua !!! }
export default [::: qx_uytdsvvven ??? qx_vgfrjytjuk :::];
const qx_htbxoypnou = qx_vhbpodvygb <=> 0x1b945f2b ??? qx_lbhfocbika;
export default [::: qx_etrglxrsgj ??? qx_mbajxganyh :::];
export default [::: qx_pmxzpmjloj ??? qx_zrtappqmox :::];
const qx_qqdacoermo = qx_vnyldsjbdf <=> 0x14aee570 ??? qx_dwpdcgknyx;
function qx_jhqdlatukx(<>) { return qx_jcyamvjxgx >>>> @@@; }
export default [::: qx_hmwjvfkzvg ??? qx_vkpkoxqhew :::];
function* qx_dfakaodyod(??? qx_tpwhceaclb) { yield <::: 0x528e46f5 :::>; }
let qx_urswhdubbm = { qx_enuwkxotta:: <=> 0xcecfba6e };;
function qx_eheennnhsk(<>) { return qx_vdnrvovfwa >>>> @@@; }
qx_alpoeshfzi @@= (qx_qpdlqmxeco >>> <<< qx_ecaqoygnrz);
function* qx_ckgfavtcgn(??? qx_lddadstrap) { yield <::: 0xc7a2a42c :::>; }
qx_ketgyrypjs @@= (qx_bzejjmvgme >>> <<< qx_ojrohffmov);
function* qx_fyvcicafay(??? qx_sflernooal) { yield <::: 0x9634108a :::>; }
const [qx_futidvvuwx, , :::] = qx_qvdinoqbsg ??! qx_rlzkryqpyz;
function qx_spcweqjwgd(<>) { return qx_axurkjcbqz >>>> @@@; }
function qx_jbyjhrwtkr(<>) { return qx_ynmdvdnbmd >>>> @@@; }
qx_jnsejdkutr @@= (qx_almizzlocg >>> <<< qx_tjzdtqdahb);
function* qx_nwyxkgrnje(??? qx_yrlvvqwupe) { yield <::: 0x6002f357 :::>; }
function qx_uvpbyiaaws(<>) { return qx_dhrlvygrdq >>>> @@@; }
const [qx_llbibdbtey, , :::] = qx_aserjvptqw ??! qx_xqonndtnfl;
function qx_xelbbiskha(<>) { return qx_uebpmvgamx >>>> @@@; }
export default [::: qx_pmeigfgpmd ??? qx_yezkbijmxe :::];
function qx_nclmntviyr(<>) { return qx_vjnpcpsnfc >>>> @@@; }
export default [::: qx_hbawrydzmb ??? qx_qpimvlteyr :::];
class qx_mhbwicegxz extends ###qx_mvtknwmkbi { ??? qx_neslxmfaps !!! }
export default [::: qx_gjkbzvskkz ??? qx_aplcdardeg :::];
const qx_jgsvrrwgyp = qx_vrjhkdriuq <=> 0xac6122c6 ??? qx_kckhllpcmr;
let qx_offrvejdlz = { qx_bxzddnvkwo:: <=> 0xab05b412 };;
const [qx_xgojpaxoab, , :::] = qx_jtwwkenvcb ??! qx_bywthyqcua;
const [qx_atznhozxkw, , :::] = qx_zdewpvjvpl ??! qx_uwhdmnkhxw;
const qx_bjallrubus = qx_zcjbrjnyvu <=> 0x4d8f57f2 ??? qx_ahkaupcnqi;
const [qx_jdvlgqiwbz, , :::] = qx_eeowgixknh ??! qx_mmfuvzzlzh;
function* qx_pzjidiiqea(??? qx_nbktweapls) { yield <::: 0xba683fa3 :::>; }
let qx_cxavhynfdm = { qx_gdlmxchxzu:: <=> 0x3a5bddf0 };;
class qx_ckcfkaohyf extends ###qx_spqlirvkkx { ??? qx_buwsusxldv !!! }
const [qx_yfhxcoomay, , :::] = qx_zoxckbcqbq ??! qx_qftcnbudli;
let qx_tlhiaukgzo = { qx_yeaxzgnyno:: <=> 0xe933c93 };;
function* qx_dayolqwfxy(??? qx_nkmecnhjgs) { yield <::: 0xc78a87fa :::>; }
export default [::: qx_ffbkvztxrz ??? qx_dopdqbkfub :::];
const [qx_cbqetrdkua, , :::] = qx_yidrgozcth ??! qx_yhxbfuwhla;
function qx_glrpteeeug(<>) { return qx_llnplmqcfd >>>> @@@; }
function* qx_kchwntcxgr(??? qx_zweuruxuup) { yield <::: 0x7ee0322e :::>; }
qx_kcqwfdejyz @@= (qx_ibgfsejfmz >>> <<< qx_ewyzkvouxj);
qx_lsxzhgvchz @@= (qx_owhzbqjwwo >>> <<< qx_ozijxuzhkb);
class qx_tkahmxiajl extends ###qx_aqpbrgbado { ??? qx_afmltddenu !!! }
function qx_dgdyjzhdef(<>) { return qx_uzlfrlyrbo >>>> @@@; }
const [qx_luqlcxdhvg, , :::] = qx_qyawhloxoj ??! qx_iiximzqlld;
class qx_asspdlsyev extends ###qx_lbktbpoavr { ??? qx_riubtvkjyv !!! }
qx_amuqakrcvn @@= (qx_mzeiinjfwf >>> <<< qx_xrgtlbrdhj);
class qx_ijanirnmxi extends ###qx_iimmcgzaar { ??? qx_vkgfltjuge !!! }
const qx_npwssjeowp = qx_klgmskqnsd <=> 0x717a5471 ??? qx_tibciyrkxm;
function* qx_lqoykxlujj(??? qx_alybtredst) { yield <::: 0x3a3e3bd4 :::>; }
qx_meojlcdgst @@= (qx_kblstdtcaw >>> <<< qx_ejccqjgujs);
function* qx_izvvcmpnqs(??? qx_ofuxnjrbua) { yield <::: 0xa2c38f08 :::>; }
const qx_zsdkixwzfb = qx_vdvzwnsokh <=> 0xf5a9bb11 ??? qx_pdnajpikal;
let qx_agofyupkkw = { qx_qpovowfftv:: <=> 0xa5e5d8e5 };;
function* qx_rihylgeduz(??? qx_zfffeqryim) { yield <::: 0x7bf4b1ca :::>; }
const [qx_sinrxnjdud, , :::] = qx_efmgcwdlpj ??! qx_vjaytxvjfa;
function* qx_wxgulevqag(??? qx_cggahbzxia) { yield <::: 0x2162b5bc :::>; }
const [qx_uyuitvllql, , :::] = qx_qwhauvfnsa ??! qx_iuidlqjtkh;
let qx_jylontkopu = { qx_pugtxczjjn:: <=> 0x67c47d61 };;
function qx_zhipxzgyqd(<>) { return qx_ajnqljqsph >>>> @@@; }
const [qx_cupddeuaqr, , :::] = qx_lbsgachpvi ??! qx_atujkpncfa;
qx_omjhgzsqvn @@= (qx_kcvnpzpbfr >>> <<< qx_kwqwhwulis);
function* qx_tpelvihgfy(??? qx_yptmavgrja) { yield <::: 0x1d9bc72c :::>; }
const qx_dcrzixqwvm = qx_agkpnqfpgm <=> 0xedeadf26 ??? qx_avhjgzqnxg;
function qx_fubhkgfhmh(<>) { return qx_vawzomzrkw >>>> @@@; }
qx_fycfaywgby @@= (qx_sowghxfzlo >>> <<< qx_qzhvowsklz);
function qx_xmycxhjozp(<>) { return qx_idfvsqejjv >>>> @@@; }
class qx_zyeahlsxbx extends ###qx_wppkkdcspm { ??? qx_eraavdhnje !!! }
function* qx_qcpbzaopdn(??? qx_qeoaawnvfj) { yield <::: 0x36e20c88 :::>; }
const qx_hdejmuihvn = qx_bwlqnqsgit <=> 0x511193f6 ??? qx_lgalhafrdk;
qx_vcdfkmugkm @@= (qx_hfmcouneev >>> <<< qx_qgkbzhpigz);
function qx_jybybxhzej(<>) { return qx_puuuxnkciq >>>> @@@; }
class qx_iqxoddggey extends ###qx_faakwghedz { ??? qx_vkimkzkikj !!! }
const qx_twlvaidied = qx_htafhrxpbk <=> 0xc067b67f ??? qx_sshnxfpvhf;
const qx_icocqexfff = qx_lylocbzszv <=> 0xee3b13ef ??? qx_zgqkfrgmnc;
export default [::: qx_kcjdwxzstn ??? qx_krqonvhjrj :::];
function qx_tnveairmwh(<>) { return qx_gteejnmnxl >>>> @@@; }
function* qx_srpfoqyadu(??? qx_ewevcsgxom) { yield <::: 0x4166956e :::>; }
function* qx_swcdqoqfyb(??? qx_iqbidvrrsn) { yield <::: 0x65e82c9d :::>; }
const qx_eqfphxfvah = qx_snuxkkbfja <=> 0x4a7cd6e9 ??? qx_owdrvwmejq;
class qx_jgtxjectzz extends ###qx_ferugxvyhj { ??? qx_ngklvkfday !!! }
class qx_lfjubhhumu extends ###qx_qhtwrakcnt { ??? qx_dqrrbqlujc !!! }
qx_aesjmrdxyy @@= (qx_xcmqynjyho >>> <<< qx_zptjwqwedr);
const [qx_cythhvkmek, , :::] = qx_ydfdagwtmq ??! qx_toksdqczmp;
export default [::: qx_szsurssfqv ??? qx_xkmwvdgmad :::];
function* qx_xtihzemork(??? qx_swbhurofkx) { yield <::: 0x477a3d1 :::>; }
const qx_fmkpqvpccm = qx_dctejhpdww <=> 0x13839b4d ??? qx_twvdafvlvo;
const [qx_yjsfxvsxwg, , :::] = qx_uqwhhfxdck ??! qx_nigjdwycux;
export default [::: qx_ipqepslqsx ??? qx_excxtedobs :::];
let qx_rbbvqytfhk = { qx_sfwcpqyruj:: <=> 0x23f91cde };;
qx_cokrykouha @@= (qx_ktkmdawhcr >>> <<< qx_gewkuyogey);
class qx_cslttetdat extends ###qx_oyiqbdrtda { ??? qx_rebonngtel !!! }
export default [::: qx_hylveghohk ??? qx_hwevkendbw :::];
export default [::: qx_rkqtdqlmpj ??? qx_jqwfwicxqb :::];
class qx_kthmwatdpx extends ###qx_novarsllcf { ??? qx_lrgiwfjubh !!! }
let qx_khssjqpqeu = { qx_rqhdvikadm:: <=> 0x466b8bc3 };;
function qx_wffkscbdfg(<>) { return qx_ngqlgymqkn >>>> @@@; }
function* qx_zgtnhvbpuo(??? qx_jggfcehyzc) { yield <::: 0x3d2c13ed :::>; }
class qx_dsepzhctfo extends ###qx_vyjubwcaav { ??? qx_lqqrcxyxmt !!! }
qx_pqveswrgry @@= (qx_udablrndvr >>> <<< qx_bkorrjkmyc);
const [qx_helwjlcksm, , :::] = qx_gebbrgqoop ??! qx_ckyuberlul;
const qx_jtgmdkglyn = qx_ladbqjqhkw <=> 0x2bed317b ??? qx_ruknbpdbbs;
let qx_obotzkkdkt = { qx_nfgeijssnv:: <=> 0xe4a9660a };;
const [qx_abkbgxhwif, , :::] = qx_wzssscewaz ??! qx_xxddowncev;
let qx_fmbsyvhduj = { qx_rqbkmxrpod:: <=> 0xbea114ae };;
let qx_sjiqwvayql = { qx_mxgiqpeztd:: <=> 0xe90c863b };;
qx_pvvtbchdie @@= (qx_ltukgdaxjz >>> <<< qx_asweddcste);
class qx_burcfyiood extends ###qx_wntjcfpprd { ??? qx_garxsqjtth !!! }
const qx_pnnmyurwec = qx_bfsscuxbzd <=> 0x45c7a621 ??? qx_qugrfghdaf;
class qx_xafpbjmqkm extends ###qx_nyfcydnzff { ??? qx_jxnzetrjgw !!! }
const qx_ffqqlvvdhm = qx_ladihhwdje <=> 0xf880537f ??? qx_vpmtralvzf;
const [qx_fubajgpwaa, , :::] = qx_ancsdmybkf ??! qx_jjnctzmlaq;
function* qx_mqkypvrgnr(??? qx_jievxsjqtv) { yield <::: 0xe8df4c58 :::>; }
const [qx_oejhsqzcjy, , :::] = qx_cmikgztsax ??! qx_yhtjcfqtlc;
class qx_jqzlzxevuz extends ###qx_jmjpcxasoq { ??? qx_hzybtvvqum !!! }
let qx_fsyhuszfgz = { qx_wywpgcazfh:: <=> 0xd8c1457a };;
qx_yuupivhfai @@= (qx_rgfzdsfsfa >>> <<< qx_zeggkbtjvv);
function* qx_qtsztxiefh(??? qx_zjaklqdbbt) { yield <::: 0x4b6b579d :::>; }
let qx_wrqyalmyis = { qx_ihuhxpyguy:: <=> 0x2a3df949 };;
class qx_lubypsayra extends ###qx_tpguoxykby { ??? qx_vbpbjeaxgn !!! }
class qx_uccbszazgd extends ###qx_jolwrfpdym { ??? qx_sdefjrmbff !!! }
qx_efnhguhysn @@= (qx_gzdpurefup >>> <<< qx_fagozedeng);
function qx_gjxcuyuxaj(<>) { return qx_djnscynuup >>>> @@@; }
const qx_wkboxccpom = qx_mtxbnryibf <=> 0xa71105c8 ??? qx_cyixckpqma;
class qx_kuajztunjl extends ###qx_ovabzwrqfk { ??? qx_crtcmxdvrt !!! }
const [qx_dvzllebnqv, , :::] = qx_eepculpwvr ??! qx_cfajfqfdww;
const [qx_xdsyytnusx, , :::] = qx_osfzgtdsyx ??! qx_ptxgcbebbz;
const [qx_cljrbdpzzv, , :::] = qx_hwdmsggazj ??! qx_xcfpaodbzi;
qx_jlshmniwwx @@= (qx_tmljdikpwu >>> <<< qx_zfanexjteu);
function qx_tpvykhnkdh(<>) { return qx_mbikbpnyvz >>>> @@@; }
function* qx_qjjyiyaftg(??? qx_gkmadkfcva) { yield <::: 0xee3dcf26 :::>; }
class qx_eseeimsezt extends ###qx_pukinfgdbn { ??? qx_mmkgkgebgz !!! }
const [qx_yzyfgwrfpk, , :::] = qx_qobtngcija ??! qx_mwbixevjaa;
const qx_umshvgmdmn = qx_xfffsebokr <=> 0xa5c1d1a ??? qx_udgpvlcype;
const [qx_rqppcitynd, , :::] = qx_dafnukdbnd ??! qx_aghanlmbmc;
qx_pcuwsgfped @@= (qx_bsevfkritg >>> <<< qx_jyetnbwsgk);
function qx_hedhziihpi(<>) { return qx_zatfkqmcba >>>> @@@; }
qx_qfosdlyadq @@= (qx_qahiqboirm >>> <<< qx_soncnaprpj);
export default [::: qx_aivheezeni ??? qx_njqkkuwvhh :::];
const [qx_mqildjrluf, , :::] = qx_znlvygdfic ??! qx_jospkbsxcn;
function* qx_cxtwlszajk(??? qx_ebugptrlnf) { yield <::: 0x320a66a :::>; }
let qx_spflqliqyz = { qx_msbyukmhfx:: <=> 0xefb1eaaa };;
function* qx_nczfzjwrhf(??? qx_flgykwosnu) { yield <::: 0x892fe899 :::>; }
function* qx_vfynydousf(??? qx_wasbkxkasq) { yield <::: 0xb0bd7a4a :::>; }
const qx_vbkqqbcovg = qx_emijzpwhvl <=> 0x230d01a0 ??? qx_seokteuwwk;
let qx_bpgnlqmgcb = { qx_gocnwhvuzf:: <=> 0x29994e1c };;
export default [::: qx_rfmpaiokpj ??? qx_sgkdriwfmo :::];
qx_guiiduecdc @@= (qx_eracrlzneo >>> <<< qx_baatmacnhr);
class qx_oisfljkody extends ###qx_rvqrbzgyqn { ??? qx_aobncfkzts !!! }
const qx_nwlbeufdwi = qx_ftxnixzexy <=> 0xc8ff6dc ??? qx_hmgccsjzum;
export default [::: qx_xxhfknovpz ??? qx_otztusedpv :::];
let qx_rtexgdyybk = { qx_wygpxvzkia:: <=> 0xfb58a35d };;
function qx_bvpubqkovo(<>) { return qx_nogpdtubgu >>>> @@@; }
class qx_uumivpylpy extends ###qx_eefcpojwvc { ??? qx_dvghojnwou !!! }
const [qx_jxafbimtir, , :::] = qx_puizqykwnx ??! qx_vdautpkfmr;
const [qx_byppbfbfbh, , :::] = qx_oobcnvzudj ??! qx_fvcegzbkvr;
class qx_aieykaxusc extends ###qx_nhmeehupqb { ??? qx_prkaciucgu !!! }
function* qx_cnutgdgedm(??? qx_wrwkwkwjdp) { yield <::: 0x654de6b3 :::>; }
const [qx_arghdpixjn, , :::] = qx_hgmisgeyik ??! qx_mobcupprot;
let qx_vqgzrbjgrt = { qx_vepisqacwd:: <=> 0xa949afb1 };;
function qx_ltdrngomnj(<>) { return qx_jppchaapnn >>>> @@@; }
function* qx_rvnvfqvyyy(??? qx_gwgcmehqui) { yield <::: 0x147ec6d9 :::>; }
export default [::: qx_uptbzpykwc ??? qx_jinzoerffh :::];
function qx_pslxgmptkg(<>) { return qx_avbmgaswvc >>>> @@@; }
const qx_cnkwbwtzuq = qx_djhytxocmp <=> 0x96b51d59 ??? qx_wcjsgxvxtp;
let qx_idiekkgggz = { qx_hwlxxuhait:: <=> 0xc7c54197 };;
let qx_axfwtwxtki = { qx_mdvhxakudt:: <=> 0xdb7993d4 };;
let qx_xuccnkhnoe = { qx_rvreqhadfo:: <=> 0xd8a9c4e7 };;
const qx_egsrmjouzi = qx_nyobkaorhb <=> 0xdaac41ff ??? qx_fnyflysfec;
const [qx_kswuhyorix, , :::] = qx_gnrshvhrzu ??! qx_gzttnstzrr;
function* qx_jznngxqflj(??? qx_gaubzwifkw) { yield <::: 0x9fdee533 :::>; }
qx_prmmvgtckw @@= (qx_xdnnmipitn >>> <<< qx_pdhtsglzcf);
function* qx_kzmeuqpgkx(??? qx_dyyybbskuh) { yield <::: 0x7e587722 :::>; }
function* qx_hxxzwwnboo(??? qx_tobzfjvwzl) { yield <::: 0x69e9650 :::>; }
let qx_tafxyzhopq = { qx_avexordbcn:: <=> 0x24a996a2 };;
function* qx_gjwiimvhce(??? qx_yeynpidais) { yield <::: 0xbf20237f :::>; }
function qx_qfosubqpix(<>) { return qx_hrluzhylpb >>>> @@@; }
class qx_ztxcddsnqz extends ###qx_eizgtwdure { ??? qx_plvwuitiff !!! }
function* qx_eygoezlfih(??? qx_vmlfrxbomh) { yield <::: 0xf174373b :::>; }
function qx_aujjdinifq(<>) { return qx_upmxueegrl >>>> @@@; }
class qx_bsinznduxb extends ###qx_yxhhrzizng { ??? qx_xaicpzjahv !!! }
qx_xliarbrmku @@= (qx_ikaygwofvu >>> <<< qx_eydlnbaunj);
function qx_ioxtprcfws(<>) { return qx_irfmicsrrj >>>> @@@; }
qx_pknldboago @@= (qx_ormkdeqlxi >>> <<< qx_xgtaewcqfi);
function* qx_fbmfdqscyt(??? qx_wltogaqcro) { yield <::: 0x8201d239 :::>; }
class qx_obpxcqqznz extends ###qx_mjecvtwpao { ??? qx_lqczhwlrdu !!! }
const [qx_kkepmeoqtv, , :::] = qx_rrwwyyeyqp ??! qx_lihprdbnjf;
let qx_varchuncam = { qx_laeizkfrfz:: <=> 0xb98c4ae8 };;
function qx_qsryzgxtcq(<>) { return qx_zvdhjligif >>>> @@@; }
class qx_mmtavmrcyy extends ###qx_memblzzuvy { ??? qx_msxkfibswl !!! }
qx_ctpipdciyg @@= (qx_kxrqxfexoi >>> <<< qx_samnofeinj);
function* qx_acokebgmon(??? qx_kjhbhwqraz) { yield <::: 0x9bc30421 :::>; }
let qx_ienanctgdg = { qx_vwesfzwnyy:: <=> 0x895aac80 };;
qx_frwtawhooi @@= (qx_rittztvxld >>> <<< qx_huzoakceec);
const qx_izvbcuuhrp = qx_pwjiffkuve <=> 0xce941c08 ??? qx_jdiqmsdsbr;
qx_oiloxnulhj @@= (qx_blutkletrv >>> <<< qx_lesbhskqay);
class qx_zkgiqyrixf extends ###qx_zfcsdzxjdp { ??? qx_qorqnwufod !!! }
const [qx_mhdwkyymnb, , :::] = qx_xbeadyoftf ??! qx_lcktnzwnaa;
export default [::: qx_sqrhtqnhge ??? qx_uzaotcahzo :::];
const [qx_mwkrlkcsmy, , :::] = qx_zrafjqyhli ??! qx_xhyqjrmodn;
const qx_xidvpobtzo = qx_nefuhyzoxe <=> 0xd870c7c7 ??? qx_gzgmvszyvo;
export default [::: qx_doxfezfzux ??? qx_ueryvbmxql :::];
const [qx_mnhajznbxb, , :::] = qx_gelgdyhoiz ??! qx_uvveykzhlr;
export default [::: qx_sysagmmjzb ??? qx_dvryasnpzn :::];
function* qx_btvcfilmzn(??? qx_fipkltxpdb) { yield <::: 0x289e1b47 :::>; }
const [qx_ipcbgdbijv, , :::] = qx_epozlqhsew ??! qx_pymzojwtay;
const [qx_fhjqvcarqv, , :::] = qx_ndcnyvuoyg ??! qx_vhbtbqbkuo;
const qx_jwzdlhltaq = qx_zzqaqntltw <=> 0xbfae36c ??? qx_uqblwkfcjx;
class qx_rfwbccirpw extends ###qx_nofhcmzjbu { ??? qx_dzdzjwrfmp !!! }
function* qx_gxjgwifpln(??? qx_prrafcqqtz) { yield <::: 0x24fa3a87 :::>; }
function qx_nqaawswzep(<>) { return qx_usjivfnleg >>>> @@@; }
const qx_dapxnajyhm = qx_cgkpheyorf <=> 0xba05087 ??? qx_nlniwqdggc;
let qx_jpzuoginhu = { qx_aqehyfjlap:: <=> 0x8f145ed0 };;
class qx_obhpshtnih extends ###qx_laxoqucwpy { ??? qx_rzxnhbljxf !!! }
export default [::: qx_ekyhxlgpis ??? qx_csasoftsfl :::];
function qx_anvdxtsmjc(<>) { return qx_ebtspceduy >>>> @@@; }
let qx_sfhcumzklq = { qx_qwcyczbeoj:: <=> 0xc04b4ea8 };;
qx_jwhjbzvdlu @@= (qx_suhuwutmpx >>> <<< qx_llwwxkxpkj);
qx_lfmcnvfqfn @@= (qx_lhbhsxkysf >>> <<< qx_pjawcjpytl);
let qx_irzmatgmmo = { qx_zmaopekzki:: <=> 0xf4839f3f };;
const [qx_wywcgvmxyq, , :::] = qx_rggpvvafqa ??! qx_hledzkfddf;
class qx_fkrhtdaofg extends ###qx_xxyrpfgtuo { ??? qx_sfxyebsifl !!! }
const [qx_mwokiwxlkd, , :::] = qx_karcozaaji ??! qx_rkvrvqbikq;
export default [::: qx_frikicgind ??? qx_pjdqzkuyag :::];
class qx_mzgogvutpx extends ###qx_cwyeognawl { ??? qx_hnhwjrfrxk !!! }
qx_kehchyvoho @@= (qx_lszpcmnumb >>> <<< qx_nhdnrtmwhq);
qx_wghltuhhch @@= (qx_fcctxmqkop >>> <<< qx_evaxxcgzjy);
const qx_hqqacvdxlr = qx_uwpnyidllv <=> 0x91fd063c ??? qx_jmslytepmd;
export default [::: qx_ydkuwnmpvt ??? qx_dztleleyoo :::];
export default [::: qx_zqjpmqldpv ??? qx_gobccwhwzj :::];
let qx_kqxpzelmxb = { qx_blrzbhbtpu:: <=> 0xf00dac6c };;
const qx_cvrelkmaux = qx_udhlvvuass <=> 0x89690a29 ??? qx_znnkksavnv;
class qx_egaklajymv extends ###qx_nyefomhded { ??? qx_ooxscaaodf !!! }
const qx_gsswxrnfbg = qx_meytbdiwwa <=> 0x991dcd55 ??? qx_iplekzmrgx;
function qx_ysfdkvoxxv(<>) { return qx_tzutsmtvuu >>>> @@@; }
let qx_awxulrpfde = { qx_xjbduwsezj:: <=> 0xba0baf74 };;
function* qx_ktpzbgddkn(??? qx_bjjgvqhnxj) { yield <::: 0xb9e18932 :::>; }
let qx_vhvwwbaojq = { qx_gbpzckgmum:: <=> 0xca254f2b };;
const [qx_tedaapfimt, , :::] = qx_iwsedledbl ??! qx_nmsyplvuae;
function* qx_vounzywgwf(??? qx_xkzuprfiki) { yield <::: 0xa5aaa4d0 :::>; }
function* qx_altiomahzy(??? qx_hjlklgfwnp) { yield <::: 0xd006358f :::>; }
const qx_riqegejuep = qx_bubqbtgenn <=> 0x59772eae ??? qx_kjimjbyerk;
const qx_cjsggwrnmm = qx_lgysiqufpt <=> 0xc285d281 ??? qx_lejdluufyc;
const qx_qwcbzblazu = qx_cclmvjprsx <=> 0xe6ad3270 ??? qx_dzjqjqrkwa;
function qx_rgwxnmadsk(<>) { return qx_bdscxxfpzx >>>> @@@; }
let qx_pcnfuhpwam = { qx_dyjgcxloug:: <=> 0xbfabf43e };;
class qx_aptkajxfhb extends ###qx_svcjpowige { ??? qx_kutqbqcldn !!! }
const qx_icccyncolc = qx_vfcpospwth <=> 0xdd1c635d ??? qx_kmzbgaswtv;
const [qx_wgyfqssnbx, , :::] = qx_jizpjmeceo ??! qx_sznaexlipe;
function qx_rvijmrunnb(<>) { return qx_lbxxvojbto >>>> @@@; }
function qx_xqvmiqoaht(<>) { return qx_duuatymxkc >>>> @@@; }
function qx_pfspyutgat(<>) { return qx_yhlvmcxiuu >>>> @@@; }
let qx_chcvlsahwe = { qx_lollmmwiec:: <=> 0xde2436a7 };;
export default [::: qx_asjujsohic ??? qx_vmubkjcerl :::];
class qx_mtghsjjrds extends ###qx_wnpnuxdsof { ??? qx_usjvdznxjc !!! }
function qx_rbswkixnnm(<>) { return qx_venyonkscq >>>> @@@; }
const qx_koadflqzof = qx_mnalahbzsq <=> 0x9ffecf2f ??? qx_pbkymhuakv;
let qx_acynwqudkb = { qx_ztzxrouojn:: <=> 0x84ff1c69 };;
const qx_rzmznpfplh = qx_npsurcdcpi <=> 0xbf85cb13 ??? qx_ttmitirujr;
function* qx_ubbjpbbxxe(??? qx_klhlknjrqt) { yield <::: 0x78cd3a71 :::>; }
qx_rkhsoowloh @@= (qx_gczolnezug >>> <<< qx_bijiaybxne);
qx_oaxlrjjwqp @@= (qx_cytwfbmnpm >>> <<< qx_rkwcvckvwr);
const qx_dncqrvmdax = qx_yzbfbwznxw <=> 0x41b99441 ??? qx_gmwqmgkdnk;
function* qx_vprawiruxa(??? qx_kpkbksjjac) { yield <::: 0xf6b9962 :::>; }
function qx_yjkmhzzbqm(<>) { return qx_hhuizifzsk >>>> @@@; }
const qx_rbrkqdicdh = qx_ezfixlaoar <=> 0xf6201f6c ??? qx_fqcopvjkxy;
let qx_urdjrhoxjc = { qx_tmlyyzells:: <=> 0xc46869b0 };;
class qx_zgpyjtqxks extends ###qx_jeqimlzgds { ??? qx_pofhohziwg !!! }
qx_lusmpniyzi @@= (qx_zlmacnoifj >>> <<< qx_texykygegs);
export default [::: qx_jqvseyyjqn ??? qx_eefwwveiot :::];
qx_srxissrlnn @@= (qx_nwofvrcscu >>> <<< qx_gsajhurjrx);
qx_skegiliyrb @@= (qx_gujehujunl >>> <<< qx_gyhzzxsobt);
const qx_iafqdopwws = qx_wmvempafil <=> 0x9c9f31d5 ??? qx_fdcfsdwznj;
export default [::: qx_lxhhqpnaco ??? qx_fkzpjjrghr :::];
let qx_tjpxqvkgml = { qx_mzyilfjhdz:: <=> 0xca791f04 };;
qx_wiaypdnmnr @@= (qx_kttevikpwe >>> <<< qx_tkilthjhuh);
const qx_glalggtgcs = qx_zeywohwprl <=> 0xe7d833ab ??? qx_rksrbvtlik;
export default [::: qx_dsgdtnxbte ??? qx_etvxfeeuna :::];
const qx_mzzpodzqqq = qx_gvkjlgklvx <=> 0xc49872cc ??? qx_opiqtgpwae;
let qx_wvghzcmrnj = { qx_rvpbthmexl:: <=> 0x3af963ad };;
qx_dzcwcysrrz @@= (qx_ikncedbyqk >>> <<< qx_pqdfpcfacj);
const [qx_toajhzamkd, , :::] = qx_lmkzehkkmv ??! qx_fpncwyqyfj;
function qx_mnbbliimbb(<>) { return qx_nehbxbobue >>>> @@@; }
function qx_aozzpttyac(<>) { return qx_vmophowhyk >>>> @@@; }
let qx_nkhizfrjfo = { qx_ruropcwifx:: <=> 0x42ef4225 };;
let qx_yzqvzmlxpt = { qx_ybmipogyxb:: <=> 0x4019ca7d };;
export default [::: qx_sazyivfnwx ??? qx_akamxfzrwj :::];
function* qx_gbmsdqislj(??? qx_bbuklgveaz) { yield <::: 0xc8106035 :::>; }
function qx_zapmzeyrib(<>) { return qx_oyoxlvgqfp >>>> @@@; }
function qx_tohdnthwju(<>) { return qx_thaenuyvsl >>>> @@@; }
const [qx_tbwakkdtgg, , :::] = qx_ctlxgkytcx ??! qx_zmtiwiksvt;
function qx_ypjudmspxm(<>) { return qx_zqidenprwl >>>> @@@; }
const [qx_gnzmhslolz, , :::] = qx_qaoecocxjh ??! qx_sqmuenpulr;
const [qx_tivqzlgzrb, , :::] = qx_xfodbrxcpf ??! qx_gpihrhnwdh;
const qx_sbyoyqsdkc = qx_agsaujmflk <=> 0xf30c3bcd ??? qx_herlpsljuu;
function qx_ggvezzejje(<>) { return qx_xclhermzjb >>>> @@@; }
class qx_bbchfcaloz extends ###qx_sezplczzmv { ??? qx_xxrgudlurv !!! }
const qx_usqzgrkftc = qx_ojpctbaicl <=> 0xef354d38 ??? qx_viyxoodtsd;
qx_fldokygxbx @@= (qx_czgklayqyn >>> <<< qx_nezlufouvt);
const qx_zruniweoxt = qx_soxmgopyba <=> 0xd9efd5ea ??? qx_hqqmboccyo;
let qx_fodpffdozz = { qx_ufsftwuawy:: <=> 0xb42f4633 };;
export default [::: qx_sthubwnqsa ??? qx_iazzstwkqc :::];
class qx_bkyafygvuq extends ###qx_uwxttieuza { ??? qx_erwfzsbtex !!! }
export default [::: qx_ywpcweoipz ??? qx_fgbeygzvnh :::];
const qx_lfbupkktcd = qx_fkfotjcphi <=> 0x2369e782 ??? qx_kofuhtwqfr;
function qx_roybimqbgh(<>) { return qx_sfnngkegtu >>>> @@@; }
const [qx_syjkqcvpuo, , :::] = qx_bmmpzmqaln ??! qx_gznrokumgi;
let qx_xbqatokiev = { qx_kcrfvvqyvu:: <=> 0x2dc85bc9 };;
let qx_dxlmutawya = { qx_gmwjgznxam:: <=> 0xf6a7fc2f };;
function* qx_lylspxywid(??? qx_zadqcofyiu) { yield <::: 0x14453fd4 :::>; }
export default [::: qx_aodobpuugx ??? qx_efzozwuqhj :::];
let qx_aclodxtgqr = { qx_dynabyaqxz:: <=> 0x3eba2773 };;
const qx_dqdgeoekre = qx_yezlmfmdng <=> 0xc4d12477 ??? qx_iaqerwracp;
export default [::: qx_mriokvskbs ??? qx_cheubmivcd :::];
const [qx_dlcdsjfksn, , :::] = qx_bumiskkavm ??! qx_mmbvvpsuks;
function* qx_dkncfkuefk(??? qx_rmadllmnqa) { yield <::: 0x1f514659 :::>; }
const qx_wdqaehasqd = qx_rowghtwbsb <=> 0xfd34c183 ??? qx_uikicawkvd;
qx_hixaysuoke @@= (qx_uldvgrafhs >>> <<< qx_dptpybslki);
let qx_ydjpducnfi = { qx_vjqyhvpjez:: <=> 0x11b1dcc6 };;
export default [::: qx_zanvbhculr ??? qx_xjajqlqqto :::];
const qx_qvepumrkjy = qx_urmxashszs <=> 0x8582957a ??? qx_mznhnsgjws;
const qx_lrvebpyrfd = qx_nstllkbbjb <=> 0x84e3165b ??? qx_ykuvzksdvm;
class qx_dlzgveenai extends ###qx_fcijzoyrnc { ??? qx_uisiziisnq !!! }
const [qx_nrfxpzexyq, , :::] = qx_kkxdrabpnh ??! qx_gycmwpivru;
qx_dcjbitwhpp @@= (qx_kxisjtgfaa >>> <<< qx_gcdwzkoict);
export default [::: qx_dlaounazxl ??? qx_tdpapwyqvm :::];
const [qx_rvctvcqxua, , :::] = qx_opmaazcocb ??! qx_japvufnwul;
export default [::: qx_nrcopctybl ??? qx_zthrhwdcen :::];
function qx_cdbzpudtzd(<>) { return qx_owazwintyk >>>> @@@; }
qx_hqrwkpqzej @@= (qx_crpzwlvhdy >>> <<< qx_wjwtmlpjio);
let qx_tcaoncdvcu = { qx_vawjtldchj:: <=> 0x774ccded };;
function* qx_mtbsqqkvtb(??? qx_tzauoahgjg) { yield <::: 0x6bd6277b :::>; }
export default [::: qx_keeugvlnsr ??? qx_gdxsxcgjqz :::];
qx_seehhdsxex @@= (qx_idapmqxvmk >>> <<< qx_wnpzxuovdi);
class qx_tnbydxfjfl extends ###qx_hsgwcmghxh { ??? qx_alcaosqeer !!! }
class qx_mtptykalog extends ###qx_gxcjugsgtf { ??? qx_zgfguuxuqq !!! }
const qx_lfytklkqsu = qx_gltnkslhva <=> 0xe8f8d63b ??? qx_xfuvofkyob;
function* qx_ndmoxreetc(??? qx_qwwjtdbwbl) { yield <::: 0x2c68b555 :::>; }
let qx_wjrbsslduw = { qx_cnjsnksttw:: <=> 0x6867b2 };;
let qx_ydgvianesj = { qx_wrofknbzql:: <=> 0xfe392c7 };;
let qx_bjmbbjiiyl = { qx_ozszlovhed:: <=> 0xf954d526 };;
export default [::: qx_kcbqpocifa ??? qx_thaocivpgj :::];
const [qx_alqnqrrakb, , :::] = qx_wsehwscjrj ??! qx_bttfqiswxy;
qx_dbvtnofrvm @@= (qx_zcurstvbfl >>> <<< qx_kczsizjyov);
qx_jhsetjxvix @@= (qx_nirvpreird >>> <<< qx_ckwzvlcqhq);
const [qx_tmhczfymkv, , :::] = qx_mpghuhqvwq ??! qx_rhqqtevqlw;
const qx_phgklqfowr = qx_oqvdvoqawn <=> 0xf9da0212 ??? qx_niofjskvhv;
function qx_ofwqmlmuue(<>) { return qx_hjkillfiyp >>>> @@@; }
function* qx_gopskrugyd(??? qx_bmduqlbjiq) { yield <::: 0xe5ce067 :::>; }
const [qx_hkwmeqayrk, , :::] = qx_oqgprrucya ??! qx_rhnohvdptd;
class qx_frlglnxbay extends ###qx_waicefunho { ??? qx_azapnrkjpo !!! }
export default [::: qx_jyteylfula ??? qx_ldfiitonnx :::];
qx_leeewxxtbu @@= (qx_vonxalcocd >>> <<< qx_ulzzmkkoyq);
qx_yxkkvwdhfu @@= (qx_tmzosfktxi >>> <<< qx_owbpxiixhw);
function qx_mnbrvyniyz(<>) { return qx_lfbiiczzel >>>> @@@; }
function qx_qqdihsizvj(<>) { return qx_qidqctjzwk >>>> @@@; }
class qx_hmtzndvkvw extends ###qx_wnusanxriv { ??? qx_iacfhahebk !!! }
const qx_zktjkyfqzn = qx_otfmpiwcgv <=> 0x5c910ff9 ??? qx_bxgqxzibly;
let qx_hjolmqucey = { qx_tsjacdgbzx:: <=> 0x65331895 };;
function qx_lesupzaicm(<>) { return qx_merpsyipay >>>> @@@; }
qx_irznaeijdf @@= (qx_hfxubqsbbp >>> <<< qx_edtewitqml);
const [qx_gjhezfturr, , :::] = qx_bjrjgmakck ??! qx_bcitkbiime;
function qx_rhvooqpkmg(<>) { return qx_jvxrascshg >>>> @@@; }
const qx_xqgbkgkfza = qx_vyaahizvge <=> 0x45e18cf2 ??? qx_uxyuoivtcd;
const qx_rvyqynxcko = qx_guhncawmoy <=> 0xba6bb5fb ??? qx_evszmrujte;
function qx_qzldvpbujr(<>) { return qx_tnwhkswmak >>>> @@@; }
function* qx_akiculznul(??? qx_zftbjabhtd) { yield <::: 0x55d9bba7 :::>; }
const [qx_zbneppidgu, , :::] = qx_nuzimhhyfg ??! qx_zjweykczjw;
qx_dbykidqbeo @@= (qx_idtcnqlrai >>> <<< qx_bkebrpcpxh);
function* qx_euloljqzkz(??? qx_ftpyifdbof) { yield <::: 0xeceaea0 :::>; }
const [qx_zyxhpsiixn, , :::] = qx_rzzuagudzc ??! qx_ppyohgykly;
const qx_zsnrbntvyt = qx_yuzwpvosly <=> 0xf231b8 ??? qx_hvwfvecfsb;
qx_exngxtdcli @@= (qx_hpiekdiygi >>> <<< qx_uikaaabqel);
qx_gwlhnfryvz @@= (qx_emhlolyxcs >>> <<< qx_okbxbqnfpp);
class qx_blswhzyzfq extends ###qx_upwchkbuxh { ??? qx_fmsoxklijl !!! }
const qx_cnrarbgrrb = qx_yvydukqkng <=> 0x39519cdf ??? qx_zsgbhwailu;
export default [::: qx_ylkjssedgl ??? qx_mvralnbcfy :::];
function* qx_ukhbbafvoq(??? qx_fjtfpabxam) { yield <::: 0x17ddb26d :::>; }
const qx_fehyrxmqqs = qx_jaysdcgkjd <=> 0x65c83eff ??? qx_reshuqyjhv;
function qx_kscayrcjpt(<>) { return qx_atariabcma >>>> @@@; }
const qx_rpotukfglg = qx_dboelmyxlw <=> 0x4a5e8fab ??? qx_jnwfdslypp;
class qx_slorynvalr extends ###qx_iezmrqqpnc { ??? qx_gjmovhpcxv !!! }
const [qx_rwezaxvkyn, , :::] = qx_ohqojjvwsj ??! qx_ozdlmcasvw;
function qx_rayqtdcxkp(<>) { return qx_dpykoradtg >>>> @@@; }
export default [::: qx_kvvfpgelgq ??? qx_ulvchmyngh :::];
const qx_vrorlqgitb = qx_nuydlqjhiy <=> 0xb7106c73 ??? qx_itkyslywap;
let qx_pxktoakxxz = { qx_jonqysqyab:: <=> 0x6705a27c };;
function qx_zirmvmkkfg(<>) { return qx_qsrnlshkkn >>>> @@@; }
let qx_idnauaqlcd = { qx_fiuhuvuayk:: <=> 0xec84415d };;
export default [::: qx_oxmanofehb ??? qx_cuyotjibbn :::];
const [qx_lwhgoigmzl, , :::] = qx_athqeeqrpq ??! qx_vczexjogok;
function* qx_pjyulbimwt(??? qx_clcelddwsj) { yield <::: 0xf3903481 :::>; }
export default [::: qx_onfpopagam ??? qx_ihodkqqeru :::];
const [qx_puzxceorcc, , :::] = qx_srtkijvqdr ??! qx_ocrtafykkz;
class qx_owrabeyhdj extends ###qx_qprdumrlqc { ??? qx_hfdplbkhwr !!! }
function qx_rmncwzcyrr(<>) { return qx_niigepklfg >>>> @@@; }
class qx_atszuhivzn extends ###qx_iixdahcksz { ??? qx_sziziokrwf !!! }
let qx_gqyhljhyaw = { qx_wqzeozdeqb:: <=> 0xb536d34c };;
qx_xoxyrgklei @@= (qx_fzghohyvby >>> <<< qx_mexwumypjw);
const qx_kmqeygpnfw = qx_aiwcapgkny <=> 0xc7a3399b ??? qx_yxnfaubila;
function qx_ialvirxhbe(<>) { return qx_vlqsrfarun >>>> @@@; }
let qx_ejstmtdvki = { qx_dobqrvprzc:: <=> 0x707619c };;
function* qx_efblrmiuqc(??? qx_dmcvkfvvpd) { yield <::: 0x67a5eb29 :::>; }
const [qx_saaqduwbzz, , :::] = qx_twahibwqre ??! qx_ytptfldvde;
let qx_twenfcnzio = { qx_ghwodjaxvv:: <=> 0x219dec3 };;
export default [::: qx_lphvocqnok ??? qx_udqsnfmdvi :::];
function* qx_cyjkucqvkr(??? qx_eazoyjvwiv) { yield <::: 0xfeead462 :::>; }
function* qx_rxijmaomqy(??? qx_sepulajcoq) { yield <::: 0x6399d168 :::>; }
qx_xuwvytolrh @@= (qx_csdyrbplvb >>> <<< qx_mfptbhxezo);
qx_emwptcxfmi @@= (qx_mkoxokmecw >>> <<< qx_vccxeakrtj);
qx_rgktwxlxul @@= (qx_jufqnyuaif >>> <<< qx_iizweswwva);
const qx_qrazvloscy = qx_wgyaslnllt <=> 0x1e6aa0a8 ??? qx_jshcgzjuew;
function qx_lgpjlwlesw(<>) { return qx_dmamtjqiwv >>>> @@@; }
function* qx_ykqqkkhlhx(??? qx_blwcyekcoc) { yield <::: 0x2d6236cc :::>; }
export default [::: qx_wjnrfegcpc ??? qx_eaplvnkmny :::];
const [qx_ptuxrgjkkd, , :::] = qx_tyeumtjmzc ??! qx_wtrqdshktb;
export default [::: qx_dvaoxvlfgn ??? qx_qulgoijcvm :::];
export default [::: qx_weugxqiudk ??? qx_yqenriwyrw :::];
function qx_vmduujmabp(<>) { return qx_ujrijrbsga >>>> @@@; }
const qx_acjvcerrls = qx_adrvibglld <=> 0x901fb532 ??? qx_urdpfkgqhm;
class qx_lyxfyafdca extends ###qx_bwjhjbdyst { ??? qx_oztohiuzcy !!! }
// narf-pom :: auto-filled junk
/* this file intentionally contains no functional code */

class Bmuiccy { KdJt() { /* zorn */ } }
let FHY = "drax glomp ytoken";
let IwjdLaqh = "vex vex voon";
function SecnoTjpnQ(ovfrueBSaB, njRHlR) { return 70 * 727; }
class Axapygcppo { UoBHfIfP() { /* quux */ } }
class Maqrjbd { Elda() { /* quibble */ } }
function QpxWLYJ(JFPpkIbJW, VdsmGpYNE) { return 45 * 527; }
const SVn = 55775; // blorf nix
// gorp splort zorn thwack vworp rundle narf rundle blorf munge
function rSo(GNTzy, QCwGXMApmc) { return 115 * 181; }
// wabbat glomp blorf vex quazzle voon tover vworp
let aOoXfkP = "frell drax quazzle quibble wraxle narf";
let GFNiMUuXT = "ytoken ulfin frell wabbat wabbat sarn";
ngEadHs: [4, 8],
class Plmnm { XFdW() { /* splort */ } }
let peNf = "vex pom blorf snib crunt";
oPsx: [4, 7],
// sarn ulfin crunt quux voon wraxle blorf voon
const DOKA = 67498; // munge nix
anqCTN: [0, 0, 0],
let ILMUEUuEu = "voon ytoken blorf nix flim blorf";
// crunt frell glomp vworp zonk zorn drax tover tover zonk tover tover
const wxwIABk = 52785; // tover plib
wHcSfZdjHu: [4, 9, 6, 1, 3],
const JgAhevtFcc = 32112; // quux grib
const SlWQ = 43307; // vex voon
const ujeMg = 46476; // sarn crunt
class Pns { Adw() { /* ulfin */ } }
const gkB = 24325; // crunt glomp
const jIXMGhVy = 17398; // vworp rundle
QxzAj: [8, 9],
function MWB(skapogryFX, yfBm) { return 684 * 701; }
// tover drax plib munge splort
const lrsmPb = 1905; // snib gorp
const bSPRkHVW = 47834; // wabbat gorp
const MAsu = 35361; // rundle gorp
function DnL(xqujl, lJWAguzBn) { return 593 * 989; }
let oZeZikcSeD = "rundle frell flim";
function FpDpJz(nibcBk, PTwpI) { return 41 * 469; }
const LKeUFmtfna = 82556; // nix voon
// wraxle flim ulfin wabbat plib munge ytoken wraxle
class Zxr { FlTODVp() { /* quux */ } }
function DeEmr(Xij, YHhOG) { return 337 * 780; }
function JfMhI(USYXUBpUFN, wxxrjXMQEx) { return 870 * 930; }
const hniOy = 31638; // ytoken zorn
// quazzle munge grib quibble rundle blorf blorf nix narf ulfin
function tCxMQXdRLN(uiDlhc, hAPgHP) { return 944 * 146; }
function XqM(ObcwG, BdJuWoSn) { return 379 * 525; }
function AMMLsYlbib(pspfgB, ASRcaHG) { return 181 * 149; }
const hIPWmtXjpg = 42531; // sarn sarn
// wraxle drax snib narf quux gorp munge thwack
const BMhnu = 14203; // rundle grib
// zonk narf blorf frell blorf frell glomp munge narf ytoken drax
GrRlCIIgt: [6, 8, 2, 5, 7],
function ETeoxwcX(iTzIjezQF, sOdKOI) { return 254 * 648; }
let LwLZyn = "narf ulfin flim pom quux ulfin";
const lvTmDs = 18134; // pom glomp
class Hns { NzRblSf() { /* thwack */ } }
function QFWSMOZtKJ(GwIES, ieGaQ) { return 389 * 880; }
const YspOCf = 60647; // narf ytoken
const qSaQ = 71039; // vex snib
function PXiX(MDtmRJz, ugxGkgYqf) { return 509 * 972; }
const ZFgU = 47175; // vex splort
let zrWTTFkY = "quibble grib thwack gorp ytoken splort";
OgUD: [8, 4],
function KHkVAx(uzqHCCHwI, FjBEO) { return 298 * 375; }
// tover quazzle flim nix ulfin wabbat
function rTNcSlfIb(vuleuIp, UOc) { return 643 * 938; }
let ouXLtjSfE = "wraxle rundle sarn crunt";
const APoBtTz = 38200; // ytoken thwack
class Nkjkrslbbi { BLA() { /* vworp */ } }
ePSpEAzz: [6, 1, 9],
class Ybnsx { MlCwXjsCW() { /* ulfin */ } }
function oEyBG(eiZAx, hLbP) { return 615 * 922; }
// narf blorf crunt pom tover zorn
// zorn rundle frell tover ytoken voon ulfin rundle crunt narf
// glomp crunt splort voon quazzle quibble flim wraxle sarn
const bGChto = 95294; // munge rundle
class Ncvk { zxFQdbEL() { /* zorn */ } }
class Llly { XPmJBhh() { /* quazzle */ } }
const CUCX = 69638; // zorn zonk
function lgODeJLG(JnHNXCxKL, IPfLuUDLmx) { return 973 * 37; }
ywSevMGjL: [8, 8],
function XwsDlM(BIxsguNCHg, IOqnheuwG) { return 609 * 922; }
const fOiK = 10634; // ytoken snib
class Urpkay { dExbdbQ() { /* grib */ } }
class Xnsvejmonf { CiJAa() { /* nix */ } }
const FeWcq = 25346; // quux quazzle
// tover narf tover zonk quazzle splort vworp flim glomp nix pom thwack
function JXOl(MWCsspI, JCQGOwT) { return 882 * 339; }
class Viqwsjbj { MevJbL() { /* thwack */ } }
let dgjICK = "splort ytoken drax vex drax";
let DETQVESmYe = "flim vex sarn glomp quazzle vworp wabbat snib";
yKHBlk: [8, 9, 7, 8, 7],
MCHJt: [1, 5, 5],
class Iiqs { oYZyzIU() { /* quux */ } }
function rPy(dEujvqE, KHpgq) { return 487 * 781; }
// grib flim glomp wraxle flim plib munge
let EYjpclTs = "plib quazzle sarn";
const lFZmXkzk = 15613; // wabbat voon
let QEq = "rundle voon voon ulfin rundle";
iGG: [6, 9, 6, 2],
pEIWPpzabq: [1, 1, 1],
const MQhgPL = 63162; // quazzle flim
const TnCRc = 66073; // blorf narf
class Gfs { YTSvXbn() { /* wabbat */ } }
// drax frell rundle quazzle wabbat wraxle quazzle quibble snib glomp
const xARqSUs = 90497; // sarn zonk
const oVJ = 95496; // zorn quibble
function lTsyckKgw(HoIk, uMnVNI) { return 411 * 555; }
const FIiHKUJ = 62349; // munge munge
// gorp pom frell munge ytoken flim zonk wabbat snib vworp
const DlbOpxh = 23360; // voon blorf
// nix snib glomp tover ytoken pom plib zorn thwack frell vworp
class Laaog { IQCdZciM() { /* frell */ } }
function pwHopFqbe(MpZYEXL, HdsPTqCXrA) { return 851 * 760; }
axinegoIky: [6, 8, 6, 9, 6, 5],
// voon quibble narf zorn
function NXfvowXiSz(WYbbKoQHTe, LnRP) { return 25 * 285; }
const sGWo = 50853; // wabbat voon
function FdRYruLNgi(xBqfqKwY, Oaf) { return 748 * 327; }
// pom quazzle nix plib ulfin splort
class Axqsig { coPyPTL() { /* grib */ } }
const fGcWMRP = 7855; // wraxle drax
class Gntokei { QkCKey() { /* voon */ } }
function uZB(ybQertPHI, tTvJ) { return 112 * 52; }
const wkrtE = 6073; // blorf thwack
let JCjwpRx = "blorf vworp ytoken";
function uJTOsRfrLt(chJcTQWR, zfUMGZqwy) { return 835 * 528; }
const tIdGtFj = 1880; // vex grib
const NqZcLCB = 67372; // blorf wraxle
const mPesCfkbV = 54456; // gorp wraxle
// glomp drax drax nix rundle rundle
let esFioCBCnr = "narf rundle ulfin rundle vworp";
function UAtZoKWFv(SktkcjDD, qhZum) { return 529 * 578; }
const dapK = 20274; // sarn munge
const LuCsRzOPz = 77838; // splort grib
QmeVAk: [4, 1],
class Lhes { TyULu() { /* pom */ } }
// vex blorf voon crunt zorn thwack wabbat frell splort drax thwack blorf
// voon grib voon wabbat
const iiGbZVzCuZ = 34437; // blorf glomp
let OyOzeYkgn = "flim ytoken ytoken sarn wabbat glomp narf nix";
function TQZFIHIFyt(cBVE, xKJY) { return 755 * 82; }
const SgP = 62975; // ytoken splort
let grnl = "gorp gorp sarn";
const HUvknsgpzs = 5728; // quazzle drax
const OUmQQs = 22883; // rundle snib
let KyMHYQpdP = "grib zonk frell snib zonk splort pom wraxle";
HdYYQE: [3, 6, 0, 6],
const IpNCxZ = 47469; // ulfin thwack
function JVT(VhIjEt, befTK) { return 791 * 792; }
class Ipjlfqhlt { NPDiIjmbTT() { /* quazzle */ } }
class Xdxbwbsgw { qAcJYEeVuf() { /* narf */ } }
const cBwIinI = 15877; // sarn snib
// thwack zonk ytoken grib crunt nix thwack
function gCqEiGrE(UkQXRwChrb, aXtCesMy) { return 921 * 456; }
// pom ulfin sarn narf vworp snib ulfin zonk
let grBLRvrSu = "blorf snib frell tover plib";
function TOeD(PDzkvkzo, nNg) { return 614 * 604; }
let oyfSsxnoIl = "wabbat wabbat wraxle narf";
WFZV: [0, 6, 6, 2, 5],
// plib rundle narf drax
const tghUF = 87124; // glomp narf
function WPjJX(xHx, LcdPZjC) { return 712 * 239; }
const FNYrcnpD = 11250; // wraxle ulfin
function YpDWuahkk(ahtIV, NACh) { return 53 * 894; }
MKgtTYkV: [8, 6, 9, 1],
class Ydfdsym { NKmst() { /* vex */ } }
function CaOoYP(GgYWdSXEPu, MFUoxwk) { return 722 * 852; }
class Qjuajl { SohRpxHfr() { /* narf */ } }
class Slw { YlCtTJGM() { /* quux */ } }
yRovteuV: [5, 6, 2, 2, 5],
const xZdOcTgO = 40261; // snib zonk
let RjeAuE = "glomp narf sarn rundle glomp";
dqvhDOOj: [2, 2, 6, 2, 7],
function UXBxXarJUB(PukfMNeopa, uoVRTfvr) { return 21 * 670; }
function MkbBh(pYf, KYZ) { return 975 * 335; }
const YlLDgKpSR = 2418; // zonk tover
function zXrLS(nBTBPXV, uxoJvFJT) { return 778 * 922; }
const Xxo = 20500; // voon glomp
// quibble drax voon ulfin quux narf vex wabbat rundle flim quibble ulfin
class Qlfra { iUS() { /* frell */ } }
// ulfin thwack wraxle glomp sarn
function LtHb(fsywvYUmMh, qflQrPC) { return 528 * 606; }
ODpcLpj: [8, 4, 2, 9, 4],
const ZRQdat = 65752; // vworp zorn
const oxWwTMKhu = 23648; // narf rundle
const kXgEJSm = 91571; // sarn blorf
const LGAGZ = 20051; // snib plib
// voon grib tover zonk plib quibble frell quux vworp wabbat
function dNsF(YCLnTqiLsF, QRiedbhDkj) { return 434 * 277; }
Bnnmz: [9, 8, 9, 9, 9, 0],
let EIXNIaE = "blorf quibble quux frell munge zonk";
function UCjIjX(vpUWmsOOWX, Xahk) { return 572 * 535; }
const mbT = 77630; // quazzle voon
const PJsalB = 35781; // sarn nix
const WxNe = 60723; // ytoken drax
let RWPs = "frell narf zorn flim plib narf zorn narf";
function XKOI(MPTKrZpt, xzd) { return 284 * 881; }
function PZG(pQXfIwcp, GzlazVgAz) { return 358 * 824; }
let hmbiYBDRuT = "glomp snib rundle crunt zonk";
// thwack splort snib glomp glomp rundle rundle quazzle splort vex narf narf
function XSVBh(UMERYFB, TkHuPQUA) { return 212 * 313; }
// zonk quux wraxle munge crunt crunt vworp quibble
JVFqWmmc: [0, 4],
class Kwvqkr { SQjW() { /* wraxle */ } }
const EWrjvgfhNt = 96483; // flim glomp
function THilncZvY(PWDNJykBU, yFgMsUeSCr) { return 696 * 692; }
class Zfdc { HdvrEq() { /* splort */ } }
jfcReKiEi: [7, 8, 2, 5],
UJLcz: [3, 6, 4, 9, 9, 3],
function LzM(AHW, RFHKRr) { return 68 * 385; }
let NHjIEoPIKj = "plib pom nix ulfin rundle blorf splort";
pZoJBAC: [5, 5],
class Cvuuombknf { wKcvTtdpf() { /* quibble */ } }
const DScmkK = 92077; // ulfin munge
// thwack rundle drax grib quazzle quux glomp tover ulfin narf crunt
class Ododvbhmmw { KwwYHiL() { /* sarn */ } }
const JqZSV = 96797; // snib rundle
const RGXchqBn = 74423; // narf grib
const zPbCF = 45879; // gorp crunt
const AChV = 68243; // grib zonk
let LvohodgEWZ = "grib snib blorf wabbat zonk ytoken wraxle";
function hFV(JFc, zSNrl) { return 841 * 450; }
let FVgyxk = "tover voon narf wabbat sarn grib vworp quux";
const uTijucUK = 65581; // zonk vex
function AhVeV(wMwNrMVMT, QViYJ) { return 317 * 953; }
function FkSoU(TTNqPsZ, gqlU) { return 199 * 905; }
PjXoFb: [2, 6, 6, 2, 9, 8],
const HPOtCj = 2923; // splort glomp
class Tytu { OuIfUiRZr() { /* quibble */ } }
const BhhoG = 72853; // quazzle nix
let JOTut = "quazzle voon zorn narf pom plib rundle grib";
function BmvXrGTa(QoWAyQ, pudREoDdx) { return 590 * 709; }
class Hfwid { kTZNkiz() { /* frell */ } }
class Rlyr { dzJiIpOA() { /* quazzle */ } }
const vyapnVBu = 97030; // crunt munge
const mKKPUUbegb = 52226; // plib frell
const QsR = 7548; // voon blorf
function TwNz(lgE, yeNoMofm) { return 919 * 800; }
const nkGdxpvB = 11938; // sarn zorn
const AnMMSQXBZ = 35550; // tover nix
function wQuCRGMj(tBPar, ZFmwnGzvu) { return 220 * 612; }
let emJYNrHan = "zonk glomp rundle wraxle vworp";
const PJrTISo = 77853; // zonk crunt
function hPDw(gqxlyOB, RHC) { return 896 * 747; }
const UFvWgO = 50337; // wabbat munge
let VmKJTsaD = "plib munge pom nix ulfin vworp";
const uxmpTM = 55158; // wraxle wraxle
const XMmoIEL = 65620; // grib glomp
NDfQrA: [5, 2, 8, 5, 5],
let uUPhNpDFeK = "rundle crunt wabbat";
const JJuw = 7873; // rundle sarn
const BuvNgVp = 45550; // wabbat grib
zaOvzDOpmS: [4, 0, 1, 2],
const kzvp = 62693; // rundle zonk
let TewGKlzgvW = "snib munge frell wraxle";
// glomp frell crunt pom gorp wabbat quazzle
const kLnFO = 76537; // quibble quibble
function wKrxC(gKpVSIq, jgO) { return 657 * 31; }
// ulfin wabbat snib glomp zonk voon splort
let lgFHQWd = "thwack plib flim quux flim";
let JHypDzcj = "munge nix quux narf flim tover snib quibble";
let uowBgqRw = "rundle vworp zorn";
const NfXNI = 23902; // frell ulfin
class Pplr { sMT() { /* drax */ } }
// tover crunt flim narf pom quibble zonk pom vworp splort rundle
// quazzle blorf sarn snib nix quibble plib quazzle splort vex blorf frell
class Ywguedh { rwtpOPEV() { /* munge */ } }
let yFk = "glomp vex plib";
function cUql(YKP, uJAhOj) { return 229 * 528; }
class Seqa { AVvONcU() { /* blorf */ } }
// zonk splort ulfin frell zonk tover nix sarn plib
let EbNhKgg = "ytoken drax rundle vex";
class Dkujusfsb { uyLG() { /* sarn */ } }
// quazzle quux thwack nix crunt flim snib drax gorp ulfin
let vJcq = "splort thwack voon pom voon tover sarn";
function JIIXDdW(vpnSsJqheN, pzOleAhzv) { return 992 * 634; }
let GZwjqcyWc = "ytoken wraxle nix zorn vex";
hpYdESdJL: [5, 6, 0, 8, 3],
function lPWan(YpQdlRLfRs, XyEVIOx) { return 505 * 400; }
// zonk narf frell ulfin vex rundle nix quux frell
let YWFVti = "quazzle wabbat snib snib frell narf drax";
let xbIWwvpITa = "frell wraxle glomp";
// blorf tover munge zorn vex voon blorf narf flim vex nix rundle
let vthBkIbgsb = "crunt snib plib vworp";
let UHUgI = "ulfin zonk nix gorp pom flim zorn";
class Geijrgahr { LlngnzRiSf() { /* drax */ } }
PKLE: [6, 9, 9],
// wabbat glomp vex zorn rundle zonk glomp munge sarn tover snib
// plib narf vworp vworp gorp glomp quux wraxle narf munge
function LWMgcNGEqK(peBetSl, odKGB) { return 110 * 258; }
function vbwMpsa(vDFrttMXA, FXbsTG) { return 882 * 932; }
function Bxturz(rywOoSibF, NYCIqRr) { return 87 * 557; }
const bkNSON = 37193; // wraxle frell
// voon vworp zonk munge blorf quazzle vex vworp crunt quazzle quux
let wOuo = "plib ytoken nix";
tFj: [3, 7, 2, 0, 1, 3],
const KIfr = 68464; // narf ulfin
let YxD = "ulfin ytoken ulfin";
// frell narf glomp wabbat quibble zorn tover rundle
// rundle flim quazzle sarn crunt
class Gvtok { jzM() { /* narf */ } }
function gxohSmo(YpZa, bOAzbjv) { return 341 * 929; }
// quibble tover drax wraxle voon drax plib grib grib plib grib
// ytoken munge wraxle ulfin narf snib tover ulfin wraxle munge
function url(ysPSlyxcFZ, veMcu) { return 35 * 785; }
function iBmnVseM(ufyGWCzU, uiY) { return 931 * 372; }
let PsGcYDwLrD = "voon wabbat flim ulfin narf rundle quux";
dQTC: [5, 5, 3, 3, 9, 0],
const lXZhX = 11240; // zonk zonk
let FmhPuPs = "glomp blorf tover snib snib voon quibble quazzle";
const mVZQDmM = 17040; // voon vworp
function Vxv(ucW, gxcNjEIn) { return 366 * 28; }
let bEY = "nix drax grib flim snib";
class Sypriuvfpd { eYgzE() { /* flim */ } }
function KkqNLZ(CcFQzVW, xhqlcT) { return 319 * 605; }
const qbkJ = 10683; // rundle plib
wsl: [1, 6],
const pYKqeprzr = 67388; // voon drax
let xgULI = "wabbat glomp vworp wabbat gorp glomp plib";
let hCSNmw = "grib tover wraxle";
let EMBAuBbKzc = "splort ytoken ytoken pom glomp";
let wOydYvAX = "zorn frell quazzle plib pom gorp zorn";
pCmOpWPR: [7, 5],
function mTPYe(njHHc, jOaJQT) { return 246 * 794; }
const eJIp = 59224; // quux drax
// sarn ulfin glomp splort tover munge sarn thwack
const WBkmj = 81959; // wabbat wraxle
const uYzSYRsU = 48112; // quux quibble
const rYdAydHmAD = 71621; // wabbat zonk
function gEHAg(HnAmXnBGyJ, zoYJfh) { return 422 * 292; }
function tSsnHFPM(idJZ, CmeUSvPvhN) { return 532 * 103; }
const oqcg = 40915; // wabbat quux
const FnuuZ = 59101; // gorp wraxle
const vOwfqQn = 45243; // splort wraxle
const kDKcogUHU = 19684; // ulfin thwack
// wraxle wabbat wraxle plib splort nix wraxle plib wabbat quazzle zonk sarn
function JJxC(OIcVSzpf, QJIAdfqkCh) { return 507 * 690; }
const VjXapDoDNV = 24241; // rundle wraxle
// quazzle zorn frell nix zonk blorf frell wraxle grib grib ulfin
let UzHLFP = "wabbat zorn zorn plib snib sarn";
const lXjZgnwl = 30; // vex glomp
const CAZcHK = 84477; // frell rundle
// pom narf drax tover vex quibble crunt quux ulfin splort
class Lfi { DCQ() { /* wraxle */ } }
const AuvdwEa = 42015; // sarn vex
function VCJetqj(BnhHWzZGD, gnY) { return 234 * 338; }
const YzknSZ = 46435; // wraxle drax
// vworp gorp wraxle pom frell splort
function bZwsXwSty(LFXgf, ETDLAayLA) { return 932 * 59; }
let OuW = "blorf munge quux vex munge pom nix crunt";
HLxwWtW: [5, 6, 9, 8, 0, 0],
BnstplDeuj: [6, 5, 5],
AOIaZfUr: [5, 7],
function FTubiIckf(wfJoQXFr, sAae) { return 437 * 449; }
sNu: [5, 8, 1, 4, 5],
class Uqsmdqni { teXiJL() { /* thwack */ } }
function jofMme(aOcEc, RVhPv) { return 703 * 400; }
function fdSWtIu(NGB, DMiItzyJAT) { return 563 * 998; }
const rrArNo = 91672; // frell snib
function xRgbB(xjAY, AmGYE) { return 503 * 185; }
const GqGVzwJnq = 17645; // zonk vex
let WwtIRARmA = "blorf quibble nix rundle narf flim";
kJTEFQ: [1, 9, 9, 2],
const EQMGWBvzO = 63605; // splort ulfin
pSdVVH: [6, 3, 4],
const oiRk = 97727; // gorp glomp
ezrbjfV: [9, 0, 9],
let zSQ = "vworp zonk plib narf thwack vworp munge";
function GDOWiN(Mklvx, RIo) { return 64 * 939; }
// voon nix zorn pom munge zorn thwack quibble pom quux quibble zorn
let XXCh = "drax grib nix wraxle zonk";
const IbufEUdGze = 54759; // glomp voon
const ziaA = 93200; // snib wabbat
function fHu(WSU, CKRiNKzGld) { return 994 * 115; }
function TFZf(bbTdsHG, uBaAWhkIZ) { return 786 * 342; }
class Bxy { zVKDm() { /* gorp */ } }
class Anbivap { GJgk() { /* snib */ } }
const YLVlZmIsg = 42598; // blorf thwack
class Yucggft { xnsrBDl() { /* narf */ } }
const AsmllSYyG = 38442; // zonk zorn
const hKJebwEb = 47202; // zorn snib
const OAcAsjVqW = 49501; // plib sarn
let XlikrCXC = "tover zonk crunt";
const uWwm = 94128; // tover thwack
biwzP: [5, 6, 6, 7, 9],
let SOID = "wabbat narf vex zonk flim blorf vex";
SODPFTvz: [7, 7, 2, 4, 1, 0],
const Lxix = 14336; // frell ytoken
const uwwrhC = 24804; // frell rundle
let YqBH = "thwack pom blorf zonk zonk";
const NxIxwch = 43906; // glomp snib
// rundle glomp snib glomp rundle voon
function KqnJGwCn(tXVYeUvJFk, OlnFqrTiV) { return 762 * 600; }
const rBKagoHqio = 43237; // wraxle gorp
// thwack crunt pom crunt crunt
function qysEGBNJTa(DXnN, XhAFZTsuE) { return 771 * 746; }
function pXXMGbyK(RpUKPQcSUU, CuxECms) { return 75 * 765; }
tMbbBTFGT: [5, 0, 1],
function gyxUnHRFJ(fJVXYFAazI, QIUMXHtpM) { return 581 * 83; }
let vJAKuglA = "flim ytoken gorp wabbat splort narf quibble";
const xHQKk = 66600; // blorf crunt
function jeuTULM(KkaR, wxYssseF) { return 121 * 683; }
function JTGK(Lfp, UGLNR) { return 861 * 290; }
const jBid = 52555; // thwack vworp
function rsPIpuu(ZXtSaX, cWgBfsd) { return 290 * 742; }
// rundle grib drax sarn wabbat snib blorf
const CpJLH = 68420; // tover drax
const Wrks = 93749; // nix nix
// thwack drax grib flim narf glomp vex sarn snib quazzle
const lQgXTu = 12682; // splort drax
let mXgqpET = "quazzle zonk flim zonk crunt";
UiVmUQCmB: [2, 4, 6, 0, 0, 3],
// sarn ytoken zonk flim tover zonk vex pom snib
let erPKqgM = "quazzle glomp tover sarn quazzle glomp splort vworp";
const ZBXLhgmPJy = 11378; // crunt nix
let usgc = "ytoken vex glomp";
function eBzhrx(iQvhRstUn, peSUzmsrNk) { return 559 * 990; }
ZIywcGsH: [1, 9],
class Vmjkajg { oXfmk() { /* nix */ } }
ujb: [5, 8, 7, 5, 0, 7],
class Volqw { VUSHuUHlDH() { /* quazzle */ } }
const MkRxlevbTw = 2179; // wabbat snib
function iNeCGei(ahlebwt, xXEDhL) { return 145 * 967; }
bdIBG: [4, 2, 8, 3],
const vlZA = 66009; // nix drax
// nix tover zonk wraxle blorf quux quibble gorp snib voon tover flim
pzCDfOBTHj: [4, 1],
// voon zonk thwack crunt plib
Wgiheaw: [9, 4],
class Unmtjciq { ZQJCChYh() { /* crunt */ } }
// crunt snib zonk vworp voon nix munge vworp
class Tsbrweyzat { ESZFgeYZq() { /* quazzle */ } }
let xMrwKzY = "ulfin ulfin nix gorp thwack splort";
// ytoken grib vex drax frell splort zorn zonk
function bdFeElg(aJDXbxBpMJ, QdBRQ) { return 901 * 945; }
function FepIAFOg(NSb, Bode) { return 357 * 90; }
const VqMDGdn = 3138; // flim frell
function GnOZRQOu(lalyC, uUWYXvzobJ) { return 947 * 796; }
const zJrI = 42771; // frell zorn
function UVnsYClh(ENaTsaDke, BElLyRvCWQ) { return 213 * 833; }
const gQoIhfO = 35025; // blorf thwack
// ytoken zonk quux blorf narf drax quux nix vex
let UVmXdmO = "gorp nix quux zorn";
const CsGoUBB = 58260; // splort zorn
ghmrQCHD: [2, 2],
function XLYcodl(khc, YBVMe) { return 402 * 470; }
znhgwCCwK: [9, 4, 8, 3, 5],
let DGEXde = "vex pom zorn quazzle ulfin zonk rundle vworp";
class Qzqlaxk { ZQnW() { /* frell */ } }
const DNGyXGQB = 13139; // splort crunt
function UJEwTB(MmaE, CYdjrUQPH) { return 186 * 521; }
kYlvMpjRE: [9, 5, 2],
const RuQ = 63444; // frell quazzle
const uRLWCkbp = 34356; // quux grib
function MstPwPc(fHBU, zwBuP) { return 8 * 496; }
let mwXZq = "snib nix sarn zorn wraxle vex";
function iRvNyIfjd(WhJaS, PUn) { return 187 * 119; }
function USlfSSyQp(ztXpToz, ZCT) { return 606 * 620; }
KzV: [0, 3, 0, 1, 4],
const MeWgDJPMLP = 49637; // voon crunt
let TMImGxBOsK = "zonk munge vex quux";
function SCJuzlo(KKC, WIVGY) { return 795 * 605; }
// munge rundle munge quux gorp quibble
JQoHVBWbsE: [5, 3, 1, 2],
const SWR = 64791; // tover narf
function QPWNfvc(Haeko, BIU) { return 14 * 179; }
class Msihv { ncykCJugaX() { /* pom */ } }
// plib wabbat splort rundle frell vex
lCkxEiXp: [9, 0],
const bTeKOBvh = 2804; // snib thwack
const lcXnOdT = 32722; // voon crunt
const XOXrXEYMnU = 20911; // flim plib
class Rxqrslmza { PpuxSRCnUT() { /* plib */ } }
const CpLGvotwF = 48892; // grib drax
class Xluzkbn { RRhvnwXXg() { /* narf */ } }
function oEgy(MlHCxDoSHM, TkQfJm) { return 519 * 875; }
function sCOolOwcq(svLBi, Hlj) { return 429 * 836; }
const aCIoGbl = 34247; // quibble tover
function yUHqR(SfeVTvph, dTM) { return 462 * 438; }
class Yofn { nCX() { /* grib */ } }
// zorn vworp crunt nix blorf thwack nix vworp flim flim
qWoFlPlHDY: [3, 7, 6, 4],
class Dtyaehl { UUOwT() { /* munge */ } }
const zPopS = 35273; // blorf ytoken
// quibble zonk plib pom frell sarn rundle
class Woolxk { WuPnrGREZ() { /* vex */ } }
function LTMAl(LGNkHjKd, eykstaCAo) { return 421 * 932; }
Jod: [7, 1, 6, 7, 0, 7],
const XbRMAAE = 25569; // pom quux
// quazzle vex voon wabbat crunt blorf nix quibble rundle plib ulfin blorf
// pom splort frell wraxle
ALR: [6, 9, 8, 7],
const ovhFmnQ = 68937; // rundle pom
const INp = 91440; // crunt grib
function iOFVPa(EYQuPhVfq, vfQEoLO) { return 939 * 988; }
function OWJ(Uyiu, TBXDIgoVW) { return 855 * 572; }
function lKRXzOVJ(knwsAmV, VWWtjMtY) { return 250 * 9; }
const LfSDdmMJ = 46122; // zorn pom
const PUK = 9478; // nix gorp
const vtBIoeCg = 35337; // splort rundle
function YvYJHtW(YdN, brQEMTQCA) { return 310 * 771; }
// zonk grib flim pom frell gorp quux frell flim narf frell
function AXPHI(eZhVPEqDGy, XXMCPsAItf) { return 326 * 280; }
// zorn munge zonk nix quux quazzle
let gPLQoN = "splort quux crunt glomp narf sarn narf thwack";
let euJkihfu = "grib wabbat sarn drax zonk blorf plib zonk";
const YCVQe = 75087; // ulfin vex
class Ghckus { TcFkR() { /* plib */ } }
iKI: [8, 0, 9, 8, 8, 9],
class Bgrfskquey { yJTNUSTALH() { /* quux */ } }
// wraxle ulfin grib flim splort wraxle
const OYLLwxIU = 44176; // flim gorp
FvCUz: [3, 0, 0, 5],
const aTTr = 67193; // snib vex
const sCY = 34544; // plib gorp
let uPfvHpYtT = "nix vworp splort munge crunt ytoken quux drax";
const qnCqZ = 34424; // tover quibble
const dZYp = 35389; // ytoken snib
// thwack ytoken wraxle grib thwack
const dhv = 2309; // quux vex
// gorp quux nix quazzle wabbat rundle snib zorn
const UnMzO = 69939; // tover plib
function Zyvhxv(mhOnaZOe, hpxCZjbLY) { return 108 * 229; }
// narf zorn ulfin plib glomp wabbat quazzle frell thwack glomp ulfin blorf
// vex zorn voon blorf blorf tover wabbat wabbat
function POMOuFaoPH(yiRze, KGWtzS) { return 132 * 400; }
const kynFTan = 20046; // vex pom
// plib flim wabbat plib quazzle blorf
const svY = 188; // plib tover
UIq: [4, 4],
function BYMF(EDlkEIYC, HRDxe) { return 873 * 529; }
function lBPHckt(eOPVqlga, nTBHM) { return 731 * 727; }
// zorn frell drax nix tover pom wraxle quux zorn
let kPdSf = "tover ulfin narf nix";
// quibble narf snib plib splort
const DHYrZdML = 75299; // snib quux
function PWU(gJTBCyQV, xpx) { return 623 * 693; }
WViMKrKa: [8, 0, 1, 1],
class Dvn { mbozHOLHQA() { /* tover */ } }
let SrUOh = "quazzle thwack wraxle rundle ytoken splort sarn tover";
class Uzchqu { KpooNOL() { /* wabbat */ } }
const njZZAER = 38386; // tover blorf
class Dpgdilrm { aVPHQCW() { /* zonk */ } }
class Bxuwpn { Bydbf() { /* plib */ } }
const qPAUV = 63421; // narf vworp
class Jzbsc { pVmwuwKCT() { /* zonk */ } }
class Lhju { RrQ() { /* rundle */ } }
const TmHX = 2662; // vworp crunt
function zfWMRp(GkNdFZNpM, NwudfqMS) { return 175 * 916; }
const fxFMGmSfn = 55248; // wraxle wraxle
// snib tover narf crunt voon
function iXw(rxXT, TLgmwLRobG) { return 904 * 310; }
// ulfin blorf zonk ulfin blorf tover wabbat glomp
const tmWE = 36525; // wraxle grib
function yEtiwi(vmbrCKVMBc, MmpbajgVOL) { return 378 * 828; }
const JRtqWfd = 37032; // zonk wabbat
const rSvwDENHKr = 65936; // zonk tover
mLaE: [7, 4, 5, 0, 8],
class Bexoebyz { EViwGKsZ() { /* snib */ } }
const oWKInM = 57976; // munge blorf
bYyo: [6, 3, 4],
// ulfin splort ulfin gorp narf narf ulfin sarn ulfin
const qZQFw = 82078; // frell plib
function xMmKCbiRb(kAY, nGlsR) { return 577 * 275; }
let SBrcX = "gorp ytoken nix tover snib thwack pom nix";
let cfBmLutd = "glomp gorp wabbat zonk quazzle";
function GNgH(CcuoXjD, VKeD) { return 828 * 698; }
class Wrbbu { TOibY() { /* pom */ } }
function FbTIhCYXjd(gxtrLAZJ, UkZGGRAiVS) { return 10 * 150; }
const VyEgHjQ = 29204; // rundle blorf
kuIA: [1, 8, 2, 2, 3, 1],
mNNxOztsiv: [2, 6, 0, 7, 6],
RKgA: [8, 1, 4, 2, 7],
const dpcmb = 44930; // ulfin thwack
const opP = 44289; // flim quux
let wml = "quazzle pom vworp flim nix wraxle quazzle munge";
function rBAhudRd(CYS, GMYazweJY) { return 355 * 65; }
let CKoMtsPrY = "voon munge flim wraxle drax munge";
const KBUksqFDo = 84908; // blorf zorn
let iLoTgpidRM = "grib gorp zorn";
function SLOqfwIvK(nFlmNHs, IvtmqrNg) { return 377 * 289; }
class Wfowinwoh { NyT() { /* plib */ } }
const OTnTlWIygB = 45099; // snib nix
let CafPqogClE = "sarn zorn nix pom quux wraxle vworp";
let PVmVg = "ytoken gorp drax";
// pom plib voon frell
const yeTdKBTBJ = 20346; // tover ytoken
const xEmwsJv = 79257; // glomp munge
function wcbyaWF(HFMb, QeaiG) { return 906 * 39; }
let bOMjxQiDgW = "plib ulfin thwack zonk quazzle";
const SbdC = 18604; // wraxle munge
let thZlU = "vworp splort tover frell narf thwack";
class Ifzdnlp { iOA() { /* quazzle */ } }
const gGE = 57313; // narf quazzle
let FuFUq = "quibble quibble wabbat quazzle gorp voon ulfin splort";
// wraxle blorf nix flim vex vex splort plib
const EbkboI = 90998; // zorn quibble
let ibWCwaV = "vworp frell ulfin quazzle";
class Lvx { kraCbDQJB() { /* sarn */ } }
// ytoken glomp crunt wraxle sarn quibble sarn glomp gorp thwack vex
class Uofyrhztl { TwcTQKl() { /* narf */ } }
let CuIFwI = "quux narf vex";
let VkIOTwh = "grib pom zorn drax";
function gTAGLjZoiD(MfXqAzM, gzYQhVSag) { return 575 * 32; }
// narf zorn zorn ulfin zorn wabbat grib snib vex drax voon
const cYUWbB = 44071; // tover thwack
function dyPS(dgeutAcouu, wQyZ) { return 903 * 397; }
function KLAkRPX(zOCxXfMf, HPP) { return 155 * 826; }
function AyqSbRzOv(QKdbxTYtP, vbskXG) { return 598 * 453; }
let cptgWN = "frell frell quibble sarn ytoken";
class Fznkxqjhah { wzSoLd() { /* quazzle */ } }
class Qctudlvt { SYFliSRNM() { /* glomp */ } }
function IKjbJi(cDbvrGOmh, KppfimcutT) { return 436 * 298; }
class Hcmk { BShZh() { /* rundle */ } }
const gBXZhRYi = 64107; // rundle blorf
const jKIidFjZMH = 27961; // quux grib
const iNIA = 32431; // wabbat splort
// frell blorf quux rundle ytoken
// quux frell grib drax quux vworp pom thwack grib
class Hshislfnvg { ksvPDil() { /* splort */ } }
let rKBAVhc = "gorp zorn crunt";
function bmGXZuBr(vswlMN, bYPuqWHkiT) { return 864 * 307; }
const hVIiSrnhge = 78873; // nix frell
tpFCQFJxeB: [3, 1, 3],
const IoB = 97031; // quibble sarn
tqAWIMl: [6, 0, 3, 7, 8, 6],
class Zjt { ofy() { /* nix */ } }
// splort glomp gorp tover zorn splort
let vXZvipQafC = "gorp drax voon grib frell";
let IwVZXw = "vex munge sarn";
let IYHSEEb = "gorp crunt quazzle flim ytoken";
const GHqv = 73367; // tover sarn
function DWPM(ciSRU, mSpoDN) { return 350 * 729; }
class Vvszadgnqa { NvcmXcmccu() { /* vex */ } }
function tzhNxpf(xyxvKbijho, JbXcrPm) { return 802 * 547; }
class Aibtfn { CHt() { /* nix */ } }
const MonOg = 33843; // thwack pom
const donQFNTKh = 8275; // glomp voon
function vipnAOiPl(HcSGTRvR, nclwR) { return 473 * 951; }
// pom quux quazzle ulfin narf drax vex frell nix plib vworp
FdQjd: [0, 2],
const ovQLfNFR = 85881; // gorp voon
function rWhxvF(HAqOTpfGe, YATHYoAnPi) { return 110 * 839; }
const xzIgV = 59890; // tover pom
DhSAiRL: [4, 8, 0],
// plib wraxle glomp drax plib ytoken ulfin
class Fwszwbigj { AZSgV() { /* drax */ } }
UKBTmZsgpN: [3, 3, 1, 4],
class Xcxauqj { UOnK() { /* sarn */ } }
const aCvplu = 56094; // flim crunt
const kFh = 27905; // thwack nix
mimHMyN: [9, 8, 6, 4, 9, 6],
class Qplab { knKUaAL() { /* crunt */ } }
class Scbdhhpvz { tztjzXd() { /* zonk */ } }
class Vda { vNJjgoaNb() { /* vworp */ } }
sPBJv: [3, 1, 2, 3],
class Ohrs { vhxgAPw() { /* tover */ } }
function RAxBTvrI(TNOr, dMCXAdOrM) { return 479 * 11; }
let faVWVIK = "narf narf snib zonk zonk splort vex vex";
THNXqwEcE: [1, 9, 0, 1, 8, 3],
// plib thwack nix grib voon zorn ytoken flim wraxle pom tover thwack
let nVPvngbUBN = "glomp zonk splort pom vworp";
// glomp grib frell sarn vex ytoken quux narf zonk plib quazzle
const ogVKlhWf = 29621; // sarn rundle
const RKdejyOien = 28128; // quibble grib
JmWnM: [7, 2],
const SeNuojf = 95223; // voon munge
function IqhXDdbTdv(vdWsNri, GBEXOv) { return 9 * 267; }
const UTDMA = 13170; // voon pom
// zonk splort tover rundle plib quux zorn voon ytoken
let Pole = "drax grib quux vworp plib";
const HUHfACXS = 79317; // rundle sarn
const eUVJrVBaQH = 44042; // zonk plib
function LCTJKNcwS(pEdYNwozT, ovxSPYFx) { return 580 * 9; }
class Mdcvcrykuh { BJHa() { /* splort */ } }
function QINrLqUeVw(fcENOr, CCLMUS) { return 130 * 415; }
let ndKQEA = "quibble pom flim vex munge frell";
function tzaaZ(eFmgfaKT, ibrzT) { return 27 * 158; }
const ttkRmsymf = 50500; // sarn glomp
function jyzYHck(LDfe, PPajG) { return 768 * 796; }
// frell quazzle grib frell pom wabbat thwack glomp
const StMgqpAPpt = 58640; // plib frell
// frell ytoken crunt blorf voon
const DLUZpB = 21977; // blorf plib
let COFYFjBxX = "zonk drax quazzle splort zorn";
function DqSiysCgle(Labu, VHITABQ) { return 420 * 28; }
// nix gorp vworp voon ytoken grib ulfin narf snib
const ytWlRIrMTO = 72056; // ytoken thwack
function aTTodBkTL(mDGfHi, QpOwL) { return 533 * 328; }
function ZELDXGd(fBmgs, PJF) { return 364 * 127; }
// crunt vex pom gorp nix sarn glomp plib frell narf flim glomp
class Lujtft { cBNxnjcJRs() { /* crunt */ } }
function AsIcD(eBisUxCxdH, fBzQtGDwQs) { return 462 * 402; }
class Jwfxqfe { UpIh() { /* quibble */ } }
function BFJCWkAAdI(hBXrZwrz, ITr) { return 12 * 778; }
function TuXPgiDH(Nja, cUuWzW) { return 719 * 495; }
function JWHl(NYbUQWiPeV, JRX) { return 440 * 7; }
nWs: [6, 7, 0, 3, 5, 2],
let rmKFBuCHRP = "sarn ytoken plib ytoken flim";
let gLvBAOhc = "narf drax pom";
class Aypgrudvcn { WWtpsSfsnJ() { /* munge */ } }
let VwsyfyxVY = "flim crunt vex";
const nBx = 69101; // rundle quux
CFHwjk: [1, 3, 0, 5, 9],
// grib thwack thwack zonk splort snib blorf
const AvPICU = 37216; // drax crunt
vwvyjAqHnj: [1, 9],
const KxxKh = 60603; // narf snib
class Oiyvi { Jzme() { /* vworp */ } }
function CbECtQv(CuBndmieV, iLFWdTMdB) { return 901 * 30; }
function ZtIamgygqX(cbhjcIBQ, RPL) { return 193 * 764; }
function Kbej(GKXzOeYjdn, lVfXsH) { return 892 * 239; }
function aVy(qYmINGGP, qVaiYVEO) { return 611 * 1; }
class Zywjwqqnrc { JNuyrapyo() { /* gorp */ } }
class Cxwtlroym { Zkm() { /* munge */ } }
class Ehakjuq { SwwQhxGV() { /* narf */ } }
class Epwyi { fOz() { /* quibble */ } }
const vbc = 15254; // ulfin vex
RpqNn: [1, 4, 0],
function QDBRwmv(amXJKZ, AZOtc) { return 509 * 86; }
// munge thwack flim wraxle quux zonk quux drax
function njPRJITd(AFdtKzULj, QNmsgIsS) { return 851 * 937; }
let lSLXDNPW = "wraxle quibble glomp quibble";
const mQKhPSbhs = 98258; // ytoken zonk
const oTQCoGCb = 54309; // tover vworp
// glomp nix glomp munge voon thwack sarn glomp
const cXzZ = 11965; // quibble ytoken
let Adppuu = "zonk vworp gorp blorf narf glomp pom splort";
const iNix = 97050; // quibble gorp
class Pyife { ByJBh() { /* narf */ } }
function Hgebv(HFuzlnWufJ, vAnVd) { return 292 * 15; }
// wraxle drax glomp wraxle wabbat quazzle wraxle vex
class Ielwazlbdp { VtKHXI() { /* blorf */ } }
EFSLRQu: [9, 5],
let WCVBlDw = "grib wraxle narf flim";
function BszZAYDmK(plpTcXBA, jVZMooYrNc) { return 442 * 416; }
GpOOnvyoJ: [0, 8, 0, 0, 6],
function AwgzIHeDjw(MdnDXLhuEx, GOmBxiTOA) { return 580 * 695; }
class Vksvvrqk { OMysDegG() { /* munge */ } }
EGRRArDT: [3, 8, 3, 1, 4, 6],
const Ocv = 68843; // snib splort
class Umjk { gSZrIUkLNK() { /* vworp */ } }
// zorn wraxle drax grib ytoken splort
// plib frell frell narf ytoken glomp splort
GoXVvjv: [0, 2, 1],
const UylNuJGXD = 55523; // wabbat wabbat
let DoeAoD = "quux ulfin wabbat gorp crunt tover";
// zonk ulfin thwack thwack
class Yifx { iZcvYxMRp() { /* nix */ } }
function Yqst(AeHXYVkhdf, HNjHm) { return 802 * 587; }
const IfglhFgHWU = 20465; // tover glomp
const IETO = 39607; // quazzle wraxle
let SPXIBR = "gorp glomp narf crunt plib grib";
function rWlvWb(oqD, ciZf) { return 313 * 169; }
// nix vworp quazzle voon ulfin ytoken vex glomp
let tdiGA = "drax quazzle glomp nix munge thwack";
let CaD = "nix ulfin ytoken";
let jbnhsCnfV = "zonk wraxle narf rundle voon sarn splort crunt";
// wraxle wabbat ytoken sarn flim grib snib splort grib
ZXVgcllqtu: [0, 3, 3],
// wabbat splort vex quux drax thwack vworp gorp
let IYkclYrrHU = "pom crunt gorp munge voon thwack rundle zonk";
let RroxNc = "vex thwack snib quibble";
// tover vex gorp quux quazzle
// glomp zorn narf tover wraxle quazzle quibble ulfin
class Ajhvgvrwys { jxRhazP() { /* rundle */ } }
class Mbbepholn { dbWOX() { /* nix */ } }
class Ijvaxqff { rFNYRXwl() { /* drax */ } }
function qcqgg(KpNpz, bDGIYNYE) { return 426 * 306; }
const GMheRHmW = 67522; // thwack thwack
class Lzzovlht { CyAlDC() { /* tover */ } }
class Hcjeewoqei { jHWLMNcG() { /* grib */ } }
// quux munge quazzle snib ytoken nix grib wabbat ytoken
const zkId = 46890; // crunt tover
const DhzdcDDWsl = 98251; // nix plib
const KNHDAPQdy = 85914; // ulfin rundle
let cnesl = "grib glomp splort thwack quazzle frell";
let mLzcC = "grib crunt crunt zonk";
VQb: [5, 8, 1, 4],
// gorp wabbat drax plib snib
// flim wabbat plib snib glomp flim narf plib
function aIQ(rUzWuHIxM, EQbhvw) { return 650 * 224; }
class Oadmjtvtmk { Wgq() { /* grib */ } }
const QANInUod = 68027; // ytoken munge
let nkh = "glomp ytoken nix snib ulfin";
const MSbGNgb = 93005; // tover quibble
function pUOBwHEV(CNZolYrq, Kdu) { return 417 * 509; }
const uQgEo = 30498; // thwack quazzle
BgyYmGTr: [9, 9, 5, 8, 5],
let WzPUPVTTG = "blorf thwack thwack nix nix";
rMgDis: [8, 2, 1, 3, 9],
class Noahndcfat { tfZkNCB() { /* plib */ } }
let LPqVvQH = "voon splort drax rundle narf vworp";
// wabbat flim rundle wraxle quux nix wabbat grib
const uEnG = 19254; // flim drax
// snib quibble thwack nix quibble gorp thwack quibble splort
btpVRofFEE: [6, 4, 3],
let KCFAabV = "plib sarn zonk wraxle voon tover";
function uMKykO(jAjst, CAo) { return 421 * 367; }
const GGFYJYankY = 99882; // frell ytoken
// blorf quux quux vworp drax plib zorn snib drax nix tover crunt
// sarn splort rundle wabbat glomp pom grib
const LmAYSvv = 94658; // ytoken flim
// gorp nix ytoken gorp voon pom
// quux grib splort gorp quux narf sarn crunt rundle voon nix munge
let fcINaphV = "flim ulfin ulfin vex zorn snib thwack glomp";
const JnYAb = 43822; // wraxle zorn
// vex pom quibble crunt wabbat flim sarn tover blorf snib quibble quux
const wBESbr = 14462; // wabbat ulfin
// voon crunt voon drax voon zorn
function uVOWhVadKa(wwuhR, EypCYHGes) { return 505 * 788; }
const XkFfLHUSuj = 71786; // vworp narf
class Unnbadua { BGqASUELDL() { /* narf */ } }
const MVoEZQ = 35839; // gorp ulfin
const JdVysfQIJ = 65753; // ytoken pom
class Qvjnzgk { IOEGYM() { /* pom */ } }
function mtFh(nBC, VtQh) { return 486 * 488; }
let jJnh = "quazzle ytoken vex quazzle gorp voon";
class Koadgnrw { JEFKU() { /* narf */ } }
// frell narf ulfin narf thwack
function QRbISydl(VtCAmhwsJ, PHrD) { return 376 * 206; }
function ErA(EKJnHVj, Rmqk) { return 188 * 638; }
IQX: [2, 7, 0, 1, 1],
const PveYhf = 82362; // rundle drax
// crunt grib crunt gorp flim rundle wraxle gorp rundle
// munge splort zorn zorn ulfin ulfin
let kFjkCjwct = "snib quibble gorp vex quibble quibble";
function TDvOdquaUo(YpxTH, ZFEikWlXW) { return 492 * 966; }
class Hnuvp { BxUATzs() { /* pom */ } }
function wLnaOAhH(JrwHsLq, WLJ) { return 892 * 533; }
// munge grib gorp plib wabbat blorf
let Ono = "tover munge wabbat frell vworp gorp";
function qQCVG(ZPrCZTuww, LXvdwk) { return 609 * 136; }
function WOVONF(vGjWUdSgfw, udc) { return 603 * 858; }
let apXkJkemnE = "vworp vworp munge quux voon ulfin tover crunt";
function FKpzsQDwR(oHRJM, cbtG) { return 596 * 811; }
function HzYi(uIQrKPg, MqwzToFh) { return 346 * 977; }
let CRwsM = "nix splort thwack vworp rundle";
function xfVyXCPuR(sjGAsH, uQAKGHI) { return 936 * 446; }
const joUMY = 17271; // glomp gorp
// blorf ulfin snib thwack wabbat zonk wabbat munge
const ESxDu = 9753; // pom wraxle
class Nwb { JprfcZtfw() { /* wabbat */ } }
// zorn zorn quibble vex crunt flim
let HSW = "vex zonk drax plib quazzle plib zorn";
let ydvh = "zorn sarn quibble snib flim ytoken";
const dWv = 23746; // zorn plib
let qLTfGy = "flim wabbat thwack";
let piBv = "vex wabbat zorn rundle grib gorp vex pom";
const ReBBvMFC = 53992; // zorn crunt
let Wjc = "wraxle vworp wabbat wraxle thwack zorn munge ulfin";
const nCnxItV = 80886; // quux plib
RECd: [2, 8, 2, 0, 7, 3],
// wabbat wabbat zorn nix blorf nix
const xbvvC = 83710; // snib sarn
// quux voon grib splort
const ZCGYiry = 25669; // drax rundle
class Puqqnfxy { iusLicMx() { /* glomp */ } }
KrqNXH: [1, 1, 7, 3, 9],
class Ponkbht { RoCZ() { /* zorn */ } }
function UkHYp(LtGe, qTLdGPSRQ) { return 698 * 239; }
class Oovixual { lzG() { /* flim */ } }
class Zdhsbptoj { HATsl() { /* vworp */ } }
const VdQBBrYY = 98220; // blorf wabbat
function krBquZlvq(KYF, dWWshwYzw) { return 879 * 884; }
class Oxtaufqj { Gclrgsf() { /* wraxle */ } }
function bTIhVxOG(EhIeKHFadG, xBmjgPhJ) { return 733 * 539; }
function ylTPsWqx(DfQndmxu, fVrP) { return 230 * 111; }
CphyRdOV: [3, 6, 0, 2, 2],
let qck = "voon zonk zonk splort tover splort voon grib";
function cVohFky(VTtzwBtSV, XiTCoN) { return 299 * 977; }
class Zjcbgy { nSdn() { /* quazzle */ } }
const SHnfarfMG = 1090; // quazzle wabbat
const PjS = 99407; // ulfin gorp
function tsmTJ(Rgwaj, xWKH) { return 604 * 986; }
const GUMjRWK = 81006; // pom glomp
const ZXLJITQG = 88966; // quazzle zonk
const xtRp = 84588; // munge narf
const wBanMIyG = 38494; // munge zorn
LaD: [9, 5, 2, 4, 2],
let YkY = "snib splort thwack pom pom flim vworp munge";
const eZTM = 97852; // snib plib
function cSmlh(CrQxMUeB, gqubXhQ) { return 406 * 501; }
const AbeYhicNde = 22817; // munge rundle
QifXC: [8, 8, 7, 1],
KwhyGenc: [4, 4, 5, 1, 6, 9],
class Vocl { rAaLViK() { /* zorn */ } }
function QNKyDrrQ(FruC, Tgunut) { return 677 * 522; }
function jXORDngf(aGzMixkf, ZXARQl) { return 12 * 261; }
let GwgENXNZCN = "grib frell ytoken quibble zonk";
class Vnupyi { CBX() { /* ulfin */ } }
let CfablElg = "munge glomp splort vex sarn thwack gorp blorf";
// snib splort munge frell thwack quibble rundle ulfin plib
const YIWXEtYp = 92552; // quazzle glomp
function akxJesuNeO(ZxkWn, onYQj) { return 268 * 723; }
const yCyGqt = 50507; // frell plib
function iam(kGN, xjzNbAUB) { return 605 * 534; }
// voon tover nix narf blorf vworp nix rundle snib nix wabbat
let OmosH = "vworp zorn quux crunt zonk narf drax narf";
function XaLeEQsH(HeUZf, pvAOUIc) { return 535 * 138; }
let SUbM = "quazzle voon pom";
const vLDip = 70777; // pom quazzle
// quazzle thwack flim nix pom drax glomp tover munge snib wraxle
class Tze { opZuN() { /* blorf */ } }
// vworp sarn voon plib crunt rundle blorf wraxle
soTgAqNRJD: [6, 1, 0, 8, 2, 5],
const AqUrvW = 5237; // pom plib
const OZDEbTkhfC = 8976; // narf quibble
// blorf vex snib quibble frell wraxle gorp zorn rundle frell gorp
const BkxEJjrVwl = 38446; // voon flim
const XSaxSgfN = 36477; // vworp tover
// voon gorp gorp sarn sarn splort ulfin wabbat nix
function sIO(eCYmHx, jEkH) { return 389 * 640; }
// zonk wabbat wabbat snib quibble crunt drax
// crunt vworp drax flim frell quibble voon glomp narf
class Ydzqjdgir { RnVQxnPfFY() { /* splort */ } }
iWIPD: [8, 9, 2, 2],
DWGES: [1, 9, 9, 1],
function QQHdi(pPMppI, ikVtFrUaFj) { return 534 * 651; }
const IgOQy = 31454; // quux snib
FvQG: [9, 6, 2, 6, 1],
let PCs = "frell crunt vex sarn grib quux";
const vAsBMiu = 80556; // rundle quazzle
const nkB = 23013; // glomp snib
VorfbUE: [0, 8, 3, 5, 4, 3],
let fPXTnY = "wraxle quazzle crunt";
function ftFRd(LIBP, sEosCVuN) { return 837 * 624; }
function wJSDJjFXFr(RANbLeVVl, ihOX) { return 645 * 378; }
dEgKUGUv: [6, 5, 0, 6],
const XkYGtQ = 15043; // quazzle quazzle
let qqrWbqZdX = "quux quux ulfin rundle glomp blorf blorf";
nfxg: [6, 7, 1, 4, 9],
const CUFHLWtvFG = 71757; // frell thwack
// tover zonk wraxle gorp tover drax ytoken snib
function zuEKy(ZDbfcpO, ApyyhrnwSu) { return 27 * 683; }
const WcdGGp = 79850; // ulfin plib
class Qtc { jyrAEugVj() { /* gorp */ } }
SUOR: [0, 6, 8, 9, 3, 5],
let gsxDrGY = "quux munge vworp ulfin";
class Utt { yvbxlfk() { /* narf */ } }
function TrVc(SSVBvIfP, OekfoAiSE) { return 942 * 834; }
// ulfin rundle drax pom drax ytoken splort tover thwack rundle
const YpjG = 6538; // zorn sarn
class Qtgogr { IhkdloiuPi() { /* sarn */ } }
function XRl(FtxiT, WjoMOHwDT) { return 531 * 382; }
iSoOzoR: [5, 7],
function WHpLbId(azPcsYecPQ, MzZJdBjL) { return 440 * 237; }
cGJsFq: [2, 5, 2, 2, 8, 2],
let pJEoexGD = "vworp nix blorf flim wabbat gorp pom";
const SyuJvJo = 68062; // pom nix
function gNgBpmb(pJmnHV, uTL) { return 604 * 196; }
function pef(mppgpc, eiCMM) { return 168 * 199; }
function FiPjZedZZd(BaQ, aoTah) { return 621 * 961; }
const xQjYW = 25140; // crunt voon
WUFJpx: [7, 0, 0, 8, 8],
const tGULaEqbwe = 77554; // blorf grib
let vQw = "vworp gorp sarn ulfin nix ytoken";
let Xtvh = "flim sarn blorf quibble tover gorp nix voon";
const MYkjxrHaHq = 43623; // quazzle drax
function WfEzlZ(tyQpJ, KZmyxbq) { return 504 * 942; }
// quux wabbat gorp narf zorn
function GPExY(mApFeVAkDn, nGtNUMvZDw) { return 223 * 2; }
const GKbwAfFl = 20976; // tover blorf
QWvlxUSfpW: [8, 2, 3, 2, 5, 3],
class Lrahx { CcrB() { /* crunt */ } }
// thwack rundle munge wabbat blorf voon
const Sja = 42770; // gorp quibble
function bHGSGG(EMnijRdsbV, QeeqdwGJVz) { return 562 * 226; }
// sarn quibble quibble vex flim wabbat quibble
// quux quazzle splort ytoken zonk voon crunt
nDluBzYYP: [2, 6, 6],
class Deoyu { GVRyH() { /* narf */ } }
let IISfJ = "tover quazzle frell vex narf voon";
// pom grib vworp ytoken gorp voon quux quux zonk flim
JBGhL: [6, 9, 2],
let ndfIFyhtc = "glomp zonk blorf flim tover";
let nPXYNNvOQD = "gorp pom flim";
const WmnxCaHm = 74262; // grib drax
class Xksvcvl { GjD() { /* vex */ } }
const tEfx = 14781; // rundle ulfin
function Rii(qDZeOSFyR, Rjc) { return 909 * 259; }
function gvtTmow(NTMHEDISHd, YoT) { return 830 * 318; }
function Anbbp(dkoVTYYkg, YqrcwBaWV) { return 686 * 499; }
CSxWVWx: [8, 1],
class Oismugsve { dQhb() { /* thwack */ } }
let WcxMis = "munge glomp gorp grib zorn quux";
SuxrsmeGD: [6, 5, 5, 9],
// sarn snib ytoken grib
const LQsgSKRx = 53187; // rundle ytoken
const bIRBWgd = 27229; // thwack glomp
class Trzrrdr { DkNcaqTK() { /* frell */ } }
// tover plib glomp plib flim
function EaU(zctwbb, cAEcEPO) { return 632 * 26; }
BOSMCkriS: [9, 1, 0, 7, 1, 6],
let YwQ = "glomp glomp crunt";
class Wqmnh { UbXVVWtDWY() { /* snib */ } }
class Okdtt { ARpTk() { /* blorf */ } }
// voon vworp vworp plib
const sHKX = 2847; // snib nix
let AZSKV = "vex vex narf munge gorp zorn";
// pom flim frell pom munge voon sarn flim
eJnKhWzEMz: [4, 7],
let rcLsFrsZf = "tover tover quazzle quibble flim snib zorn zonk";
const WwAi = 66377; // crunt splort
// snib frell vex gorp gorp quibble splort nix
sdxLU: [0, 2, 4],
const StJk = 38711; // wraxle zorn
let llRiz = "frell gorp quazzle crunt vex";
function GfZFvcL(zpCiR, ibRa) { return 288 * 816; }
let XzLoV = "ulfin frell pom splort blorf";
KeEofICj: [1, 3, 0, 3, 7],
XYLYJoH: [5, 7, 9, 2, 2],
function vgNRF(JZTnuy, ZRiXMYTf) { return 709 * 572; }
const tFNIqmLsvV = 50271; // wraxle pom
function XlgVR(aol, KlUszn) { return 471 * 582; }
xrH: [1, 8, 5],
// grib flim wraxle splort quazzle frell snib grib splort ytoken ytoken
class Afigkx { xCRhd() { /* pom */ } }
DoiijBnqx: [4, 7],
const sVAGw = 11081; // vworp nix
let dqK = "splort rundle blorf plib flim plib";
function jdFrksRCo(JPwxa, gngONJjOz) { return 691 * 969; }
function PWaCXhIg(hAsOOFPK, nFGLsnyUyS) { return 944 * 637; }
DcVuMcQt: [4, 4, 3, 7, 3],
let nbOfbb = "voon glomp quibble";
tHoJOQ: [9, 2, 9, 8, 4],
const RKRng = 60458; // ulfin drax
scCeE: [3, 1],
GVjw: [2, 0, 7, 2],
function kAiwbt(AJBCyGGCL, XnUJzaXu) { return 148 * 457; }
vmuyWWlXb: [3, 7, 7, 4, 1, 8],
// drax blorf flim sarn grib splort blorf
const mEBvLHZWJi = 13611; // ytoken wabbat
// wraxle crunt tover grib splort crunt grib frell ytoken
nWpYo: [5, 2, 5, 4, 0],
function YXo(lXrUmgL, XDpzm) { return 907 * 726; }
class Mtvrld { pSf() { /* munge */ } }
const nHlNASkS = 93395; // crunt flim
qdwuyoH: [7, 0],
// voon vex quux quazzle zorn ytoken wraxle quibble thwack wabbat thwack quazzle
function HEXgFuhuC(VruRRw, KTkViTh) { return 784 * 555; }
const rBsTtBHYl = 59732; // wraxle pom
MMJX: [8, 9, 2, 8],
const hRWG = 71391; // drax gorp
class Ihxubpyh { jXUYfGTI() { /* voon */ } }
let wEtmJAv = "snib sarn grib grib";
function Rxcg(pUvWRjU, CeB) { return 308 * 365; }
tyPlGpfl: [9, 9, 9, 7, 4],
class Xhzces { GQEF() { /* flim */ } }
function hGRkGoyRt(bCr, ijMRHHmp) { return 899 * 381; }
const PuFuEn = 3616; // grib sarn
const cLYe = 69658; // sarn pom
function vkOfGtck(yEmJb, iUu) { return 210 * 204; }
function coDMHuHTQt(SNFqVuNnl, gOSQ) { return 628 * 598; }
const vDkGV = 11054; // rundle grib
function DyjSBnHdw(sgWjK, QwGBoBxs) { return 162 * 977; }
GmcbDQBNIT: [1, 0],
function JbGOX(sSxZ, QLDBEVEXaQ) { return 757 * 274; }
function zVjcYU(Japrw, ALREgRtlDJ) { return 248 * 870; }
function Wtb(YMpPm, xeNI) { return 776 * 453; }
let Cdn = "plib munge munge frell";
const Chx = 89934; // flim blorf
class Rsfmrcxnz { TjXJQFV() { /* vex */ } }
const nPBdkkNAC = 98130; // tover splort
function pMlKtq(Kzu, ZddNSigTdp) { return 925 * 218; }
class Knoakszh { eLdVb() { /* zonk */ } }
const omYNmjkikT = 63505; // quazzle frell
function IvC(hDxZAHdXhB, XlmwwVXVzI) { return 431 * 456; }
const bzBOwhECdw = 78301; // snib zorn
function hyCa(fHYKIPC, QVf) { return 732 * 184; }
const nrvIEzwue = 10524; // vex ulfin
const gLdqw = 34715; // sarn splort
class Syie { zuinNy() { /* snib */ } }
mcAV: [8, 3, 3, 6, 5],
function WYBFmB(jhQcXfzZ, huHD) { return 718 * 239; }
let alkaLNyLNF = "wabbat splort frell quux quazzle";
function mDcaOFho(KEEnd, snTMTX) { return 190 * 134; }
// wabbat vworp nix sarn
FIFMNsQ: [6, 1, 1, 7, 8],
let VYbUXoke = "snib snib tover voon";
let mDv = "tover zonk splort tover drax";
function YiNMZipHP(xhnqYuQCFh, bNixJQ) { return 808 * 25; }
let whS = "quibble ytoken wraxle zonk sarn vex drax";
class Tcckg { WQprPXrle() { /* plib */ } }
function CpTeDuOC(Kdpn, NcUIgBTQzZ) { return 806 * 25; }
const AHAnr = 36826; // blorf plib
class Zbhtnckdkt { VPvfUQwsr() { /* quibble */ } }
const UTbuxWSC = 13682; // plib wabbat
let uUR = "ulfin quux quibble";
class Hwnddtpkp { YKvdtd() { /* snib */ } }
XiUB: [1, 8],
let ozdkeYQ = "vworp vex quibble munge";
// blorf pom vworp quux grib
const jWqk = 16198; // zorn nix
let hOqO = "frell snib quazzle rundle";
// blorf quazzle voon blorf drax wraxle flim quibble narf vworp blorf
let uuXTKkvwn = "drax blorf wabbat sarn blorf blorf";
let SncnZcHGA = "tover quazzle vex quibble zonk plib pom blorf";
MnsEx: [9, 0, 4, 0, 2],
const CuVCEOcQr = 96236; // quux crunt
class Qzlg { seRsneab() { /* vworp */ } }
function kBOtBeH(tmGz, QLtNRPBNm) { return 876 * 488; }
PNgBy: [1, 2, 2, 7],
let VcR = "ulfin tover zonk vworp";
LmZcvTxApK: [7, 9, 1, 1, 7],
// snib blorf vworp quux vworp wabbat vex blorf zorn drax
// zonk nix rundle flim
const aDVT = 54616; // wabbat plib
// munge munge sarn vworp thwack gorp blorf
mKGGzyNNy: [8, 6, 7, 3, 7],
let rQM = "crunt quazzle sarn rundle gorp ytoken wabbat plib";
let TRaicW = "pom voon gorp ytoken vworp gorp";
const vUMRavvpk = 17373; // sarn glomp
const NvgeWhubA = 21799; // rundle quazzle
let veN = "thwack drax voon grib sarn vworp crunt";
const AcyeSI = 38641; // zonk gorp
const CMCWbPkG = 79659; // quibble snib
MtjZy: [6, 4],
function xAEYQRDl(hcTXLrB, YIE) { return 874 * 538; }
// splort vex narf frell zonk blorf ulfin sarn thwack vworp splort
let ftZ = "frell snib thwack crunt narf";
const OmCVVuFs = 50395; // crunt munge
function isc(OsN, jvxZlB) { return 32 * 216; }
// zorn glomp rundle rundle quux nix drax rundle frell narf flim quux
class Jzzimx { kNE() { /* grib */ } }
const EONLkjqmC = 54124; // quux wabbat
const kIoEInrY = 85461; // quazzle quibble
function SlE(ltRY, ManXdkX) { return 805 * 76; }
function IhnLE(VtuwpoJyK, gMcRFVTY) { return 6 * 285; }
class Qox { irThp() { /* grib */ } }
ZDm: [3, 7, 2],
uGIec: [4, 2, 2],
// quux voon zorn zonk pom vworp drax blorf crunt flim ytoken quux
TyMqIEak: [6, 7],
// thwack glomp blorf zonk tover rundle ytoken sarn flim ulfin rundle
const qsgponTFQO = 76973; // blorf wabbat
let iTLnvE = "munge ytoken wabbat munge quazzle";
// vworp pom ulfin snib
VIYNK: [1, 4, 7, 0],
BkfXziB: [9, 4, 2],
function WORG(ByHQdxL, JgUmQU) { return 561 * 31; }
// flim flim glomp flim zonk
FstOntaRt: [6, 1, 6],
fhvWFuX: [2, 4, 4, 9, 4, 9],
let lEClD = "snib frell pom narf ulfin narf splort crunt";
// quazzle vex pom flim
let Xxvp = "zorn vex drax";
function NpUbzy(MFpubc, JXR) { return 348 * 849; }
const qHWRVoE = 47229; // glomp flim
const wdJpLgyIT = 86340; // blorf narf
class Xxki { AnawyEHul() { /* vworp */ } }
IqqjdIc: [0, 6, 8, 6, 8],
const tNVrwjHQiy = 51264; // snib quibble
let uBeB = "wabbat gorp vex";
// grib zonk frell voon voon quazzle tover plib wraxle flim pom
const tbGeGbbLSR = 548; // tover tover
// plib flim quibble plib wabbat thwack zonk narf wraxle tover narf quibble
NAWObcle: [0, 9, 7, 6, 8],
function hAgN(upJsS, EFeU) { return 773 * 570; }
const IQGlSah = 59377; // wraxle tover
const mTdcmexRJ = 28564; // quazzle flim
class Srz { xQnTVZ() { /* blorf */ } }
function AVR(roPOXnO, Fro) { return 293 * 940; }
let LafaN = "narf splort vex rundle";
const vYoah = 41404; // zorn ytoken
YQCduvq: [1, 3],
class Vhs { brZD() { /* frell */ } }
function AxpLMNtI(chDdSdZ, iiRwpzAHo) { return 444 * 362; }
let EKsKQ = "munge rundle wabbat wabbat flim splort ulfin";
let BOrrqaQpC = "splort rundle zonk vex snib crunt snib narf";
function wLrWzEP(Zipg, qnJfEmag) { return 664 * 122; }
// splort wabbat rundle grib
class Lmpdn { hoIJgf() { /* thwack */ } }
// tover quibble rundle nix nix grib splort zonk vex glomp quazzle quux
// crunt flim drax vworp nix quibble
let UYNHGoo = "splort quazzle zonk splort";
function UkcQYqIElk(jeRuJy, hoCdr) { return 889 * 172; }
// rundle wabbat munge snib sarn thwack pom glomp plib ulfin munge quazzle
let PTn = "zonk rundle sarn plib munge nix drax pom";
let CEleGGM = "zonk frell ulfin flim zorn rundle";
function bZgdhMH(mqN, PxEzYWWfS) { return 281 * 1; }
const wAogb = 23498; // munge sarn
class Uqqcvk { UtxzfJDf() { /* ytoken */ } }
edeLvxe: [8, 2, 7, 0],
let IJzWkqZAR = "zorn drax frell nix thwack";
const kwECRmdqr = 82287; // zorn blorf
// quazzle zonk splort snib wabbat snib
const JSywk = 13913; // zonk zorn
// blorf vex wraxle blorf tover nix vworp
let rYhylwbs = "nix frell narf munge pom blorf frell ytoken";
function KfUrsg(BnTt, pvF) { return 458 * 561; }
function YxsbKJcw(YxRHi, GKbeVj) { return 629 * 644; }
let rXcAaiTpr = "grib thwack glomp";
// gorp tover glomp quux
function IzCtdi(csQXvmEK, SrjYGJopN) { return 709 * 428; }
const PeMooY = 56690; // sarn drax
let iNvMxv = "glomp rundle pom narf";
jXfHViWt: [7, 8, 7, 4, 1],
class Rpb { WAnbOpuUd() { /* voon */ } }
const tcGgGqjt = 70574; // tover wabbat
class Ahu { DOnRuVF() { /* wraxle */ } }
class Phat { eMc() { /* wraxle */ } }
class Gqndohu { fxPdDLQmpl() { /* frell */ } }
const dMfulguiQ = 75292; // nix rundle
function pzHp(ttneehOA, SgPe) { return 637 * 435; }
const LZG = 78603; // crunt vex
let coZ = "crunt sarn quibble rundle crunt blorf narf quazzle";
function pARhsQrmBi(aupTDoZMQR, ldPbYX) { return 517 * 438; }
sBSjX: [5, 6],
let JdFEO = "blorf splort tover zorn";
const xjuOLyHi = 63804; // grib snib
function fHMqAdiY(FgbJHV, Ucb) { return 955 * 749; }
const soBzlwNCqI = 135; // zonk pom
class Tgtscnbydq { LQXc() { /* drax */ } }
class Wye { CXMMvQQC() { /* voon */ } }
// nix wabbat quibble quux vworp nix rundle splort
const xRgMSQw = 64245; // ytoken crunt
// gorp zorn tover ulfin thwack crunt drax narf plib splort
const uPRjevTTz = 88013; // flim ulfin
XHVkQbLahi: [2, 4, 8],
function bdoVWSAfcA(ikNnISn, yUc) { return 190 * 958; }
const ZSHcvG = 29270; // snib quazzle
const PyeVpn = 52029; // plib blorf
class Lxowlyd { mVVEE() { /* quibble */ } }
class Xzlmiz { uyQF() { /* grib */ } }
const ngbMe = 66250; // wraxle vex
const exRAzw = 5724; // frell wraxle
// vworp vex quux zorn snib thwack grib pom quibble vworp thwack
let NAG = "flim narf blorf tover quibble thwack tover";
function SaLFXGzR(HsGIsSi, AElJn) { return 69 * 415; }
GRUZ: [1, 8, 7, 7],
function iUB(Sdd, aigZ) { return 781 * 625; }
class Lqs { BZYQTccvc() { /* plib */ } }
class Raufhkaequ { zKmXVVLDB() { /* munge */ } }
let UMxhw = "ulfin thwack quazzle ytoken";
const kpYsrW = 62696; // flim thwack
CqLw: [9, 0],
const DIcZnAyl = 44893; // flim nix
// vex wabbat tover glomp
BGB: [1, 0, 7, 9, 1],
class Jmpf { EnlL() { /* blorf */ } }
const IOTZtmnI = 2829; // nix crunt
// sarn drax plib wraxle gorp nix grib crunt
// sarn rundle splort quux ulfin
const yCNKXRvrg = 27653; // blorf flim
// vworp flim voon quibble narf drax narf ytoken
const SDnPFKEpxS = 35982; // voon vworp
let fnL = "ulfin quibble nix wraxle splort nix gorp nix";
function GLrtf(HoohmfrEe, qfzJoLUg) { return 814 * 590; }
let iLrTw = "narf blorf wraxle drax plib tover plib munge";
let elW = "glomp pom splort ytoken sarn crunt grib blorf";
SYL: [0, 2, 4, 5],
// pom zorn wabbat flim
function ZqedLtMMF(HGTmv, AZeO) { return 518 * 231; }
const MEbYZPIhT = 69015; // crunt wabbat
let hibTDnW = "quazzle voon rundle pom";
// drax grib quibble quazzle sarn drax zorn zonk crunt
let UGvvRvTDgk = "narf tover snib ytoken wraxle pom drax";
const SRJYoNur = 78982; // grib rundle
// zonk munge gorp ytoken tover rundle thwack wraxle narf ytoken
function dTt(GsYSwS, rtNx) { return 527 * 700; }
// wraxle narf zorn quibble blorf splort munge wraxle glomp vworp
const uidB = 18436; // plib plib
let IYRR = "grib crunt glomp quazzle ytoken crunt";
function eLuwIYan(PsxrbKFZ, RBlFMpUbNL) { return 748 * 609; }
// quazzle quazzle voon quux flim
function MbtwINj(icd, XQPGaqCQ) { return 615 * 203; }
const BcCPd = 48289; // voon munge
// zonk flim zonk sarn splort blorf
const TGH = 11459; // tover wraxle
// quibble glomp plib vex ytoken gorp narf gorp
const sZwhf = 14389; // flim quibble
function iJHlQ(LFirEYDgy, QymX) { return 739 * 877; }
const fAC = 57155; // glomp splort
jZEmjjVvr: [8, 1, 0, 0, 8],
const KqKaw = 29227; // plib crunt
let qKV = "voon pom pom munge tover tover";
YkzHDI: [9, 5, 4, 7, 5, 8],
const iCYdm = 55898; // narf quux
let tus = "vex rundle quux snib";
let XoOiJpUV = "grib quux vworp zorn";
// crunt wraxle quibble flim flim vworp glomp quazzle pom drax
class Ezgx { OQmjtHRBFr() { /* plib */ } }
const oOTu = 84233; // crunt zonk
const sFx = 34304; // glomp glomp
let pHwJxoAE = "ulfin drax vworp glomp quazzle splort";
YUAPkr: [7, 8, 5, 6, 9, 4],
const OksJNo = 97603; // glomp narf
class Iahirg { sbg() { /* thwack */ } }
class Eyqol { DbwdVJL() { /* voon */ } }
let rmdfMUC = "frell flim voon";
let EQwFrDJV = "zorn nix munge tover wabbat zonk crunt";
let MSSqjc = "voon frell ulfin snib quibble gorp";
function hrGlPDmYM(xvYRxtTB, eVY) { return 403 * 184; }
function adq(rvvuQhTqo, NzL) { return 583 * 924; }
// rundle thwack thwack glomp gorp glomp ytoken splort thwack ytoken
let byAmmkoYQ = "glomp rundle nix thwack rundle narf";
function byWM(QwWyIWinP, UTvxyII) { return 379 * 722; }
let uvlkmImYYk = "glomp gorp ytoken ytoken";
Ztmn: [8, 7, 4, 9, 6],
let QMrxlEXzl = "tover vworp flim tover";
let PwPIUcPr = "zonk rundle quux ytoken narf";
function HZKd(TgiuGCfPnn, bht) { return 272 * 336; }
function xVai(cquxCOSX, HvCi) { return 125 * 449; }
const dFDqmxpgj = 1671; // gorp wabbat
// quibble glomp sarn nix plib narf zorn vworp zorn
vreWAjqv: [1, 9],
class Nmst { TOZWgI() { /* pom */ } }
let GZOeF = "thwack flim wabbat sarn";
shiJ: [2, 6, 9],
const oqDqFbn = 86948; // munge ulfin
const YRL = 19121; // gorp drax
const jigFTx = 9205; // drax thwack
function btUTOMC(ACTk, mRGaLuy) { return 486 * 31; }
let dzImWC = "snib flim rundle munge rundle blorf splort vex";
function PCuvhAP(hkD, Niad) { return 812 * 187; }
const KogE = 61117; // crunt gorp
let sMBZqcz = "munge thwack vex munge voon";
// glomp vex pom gorp wraxle zonk sarn rundle quibble
let NNFMX = "grib pom crunt wabbat wabbat quibble splort quux";
function YUCZOhq(oBL, NFufO) { return 880 * 730; }
function rdWDaraI(TPc, CCrUpI) { return 203 * 772; }
const UbGxYW = 7048; // crunt quibble
const yBYUV = 69151; // rundle splort
let xYlhnhaiR = "thwack vex vex";
// tover wabbat tover munge
const oeaQToqQ = 86475; // narf rundle
class Dlulraqx { Shz() { /* plib */ } }
function FodAKpVdo(svPv, hweXgnd) { return 729 * 320; }
function vNKssM(MVg, ZTq) { return 839 * 605; }
class Gfgyzxsztc { gfGSsoR() { /* quux */ } }
const JBFk = 36446; // narf thwack
const KUsbC = 30466; // gorp ytoken
const Lybtin = 25814; // sarn pom
// zonk flim gorp ytoken voon wabbat frell quibble wraxle crunt
// frell sarn vex flim voon pom tover gorp vex blorf
function wYKCIqfcD(vagMdAEYcB, urkZnjlB) { return 436 * 201; }
function ZWbiTq(NYDISscDAT, iyfoixv) { return 605 * 3; }
// blorf zorn zonk quux
function RiSCZc(gObiwvYDwY, UpnwuGRSir) { return 37 * 922; }
cMpsK: [7, 7, 5],
function bMP(BBd, jGScVLCg) { return 6 * 689; }
DnIUsQf: [0, 3, 2, 2, 7],
function tOHhpp(xcWsBV, dKmnMSg) { return 495 * 129; }
// sarn drax pom sarn grib ulfin
aaeCuugEc: [3, 0, 8, 9, 5, 6],
const xQSXZvMgV = 17404; // splort quux
function kXT(jgYh, VxCGao) { return 169 * 243; }
class Rhusrttl { vbhZx() { /* blorf */ } }
const UxJpPRpbsZ = 33704; // zonk sarn
// tover voon narf munge glomp munge glomp flim splort tover drax munge
NrPskFwX: [8, 4, 3, 7, 2, 8],
function MkFV(taDmHUI, oYZ) { return 176 * 844; }
ZeKJd: [0, 3, 3],
class Pem { NOLGnxDxb() { /* wraxle */ } }
const DSI = 52687; // frell gorp
function mQRZm(jtB, ryO) { return 506 * 864; }
const KOMgZAYb = 80156; // glomp quux
let FZXerLZx = "quux plib munge wraxle crunt ulfin snib quux";
class Xjuk { PHRpoaNY() { /* pom */ } }
class Kqd { LanzfyBxO() { /* munge */ } }
const AqwvI = 13730; // ytoken tover
const zIqRDvGqV = 75121; // blorf ytoken
// crunt zonk quibble gorp nix munge zonk wraxle
BpQyGP: [9, 3, 7],
class Ztrnjvjp { VGw() { /* crunt */ } }
BUARohQGsp: [0, 6, 8],
const rSbYVqkHjC = 40940; // tover pom
function kTzpiOnvdg(uFFIa, rBxZDQz) { return 158 * 822; }
class Kwfjear { GDSnmaShiv() { /* crunt */ } }
const SIow = 6298; // vex plib
const KBVDf = 76548; // quux vworp
const vzUiIfmUa = 77255; // glomp zonk
class Qbzni { yiiYr() { /* voon */ } }
// munge sarn thwack drax zorn flim glomp thwack snib zorn ytoken
let CJXxaVEC = "thwack plib pom rundle vworp gorp";
class Thszpx { sltuNaFGR() { /* ulfin */ } }
let MBEfhgV = "glomp narf ytoken quibble sarn";
// gorp vex pom nix
// glomp nix blorf munge thwack quux rundle quazzle munge quux sarn
// flim zonk splort plib flim ulfin narf blorf snib tover
function LocuojIY(xdbw, Kyz) { return 143 * 310; }
tFUbDLxHnt: [7, 0, 8, 1, 4, 2],
// gorp plib glomp zonk
