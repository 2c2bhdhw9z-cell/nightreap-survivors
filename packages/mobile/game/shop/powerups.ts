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
