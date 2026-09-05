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
