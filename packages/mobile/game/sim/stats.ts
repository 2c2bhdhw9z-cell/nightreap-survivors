/**
 * The stat table — every number the sim is allowed to ask about.
 *
 * WHY IT IS A FLAT TYPED ARRAY
 * Stats are read constantly: every projectile spawn asks for damage, area, speed and pierce; every
 * enemy tick asks for the enemy speed and health multipliers. An object-of-fields would mean a
 * megamorphic property lookup in the hottest loops we have, and worse, it would tempt systems into
 * caching individual fields and going stale when a level-up changes them mid-run. One `Int32Array`
 * indexed by a constant is a single bounds-checked load, and `Stats.get(STAT.damage)` stays honest
 * because it always reads the live table.
 *
 * WHY EVERYTHING IS AN INTEGER
 * Stats are stored as **permille** (1000 = 1.0x, or 1.0 unit) rather than floats. Two reasons, and
 * the second is the one that matters:
 *  1. Determinism. Co-op and replay revalidation both compare state hashes across devices, and
 *     float rounding differs between an A19 and a Dimensity 700 the moment we do anything more
 *     interesting than addition.
 *  2. Percent stacking is *defined* in permille. "+10% area" is +100, always, on every device, and
 *     ten of them is exactly +1000 with no accumulated drift.
 *
 * WHY THE CAPS LIVE HERE
 * `plan.md` fixes hard per-stat ceilings (amount 10, armor +50, pierce 10) and specifies that the
 * cap applies to the *base* stat, not to bonuses. Encoding that next to the stat definition keeps
 * the rule in one place instead of scattered across six weapon implementations that each remember
 * it differently.
 */

/** Fixed-point scale for every stat. 1000 = 1.0. */
export const STAT_SCALE = 1000;

/**
 * Stat indices. Append-only: these are written into save files and replay headers, so reordering
 * them would silently reinterpret old data. Never insert in the middle.
 */
export const STAT = {
  // --- Player character stats -------------------------------------------------------------
  /** Outgoing damage multiplier ("Might"). */
  damage: 0,
  /** Effect radius / projectile size multiplier. */
  area: 1,
  /** Projectile travel speed multiplier. */
  projectileSpeed: 2,
  /** Effect lifetime multiplier. */
  duration: 3,
  /** Extra simultaneous projectiles. Flat, not a multiplier. */
  amount: 4,
  /** Weapon cooldown multiplier. Lower is faster; floored so it can never reach zero. */
  cooldown: 5,
  /** Flat damage subtracted from each incoming hit. */
  armor: 6,
  /** Max health, in health units. */
  maxHealth: 7,
  /** Health regenerated per second. */
  regen: 8,
  /** Movement speed multiplier. */
  moveSpeed: 9,
  /** XP gain multiplier ("Growth"). */
  xpGain: 10,
  /** Gold gain multiplier ("Greed"). */
  goldGain: 11,
  /** Pickup attraction radius multiplier ("Magnet"). */
  magnet: 12,
  /** Luck multiplier — chest tiers, card rarity, drop rolls. */
  luck: 13,
  /** Extra times a projectile may pass through an enemy. Flat. */
  pierce: 14,
  /** Knockback force multiplier. */
  knockback: 15,
  /** Invulnerability window after taking a hit, in ticks. */
  iFrames: 16,
  /** Revives remaining. Flat. */
  revives: 17,
  /** Critical hit chance, permille (100 = 10%). */
  critChance: 18,
  /** Critical damage multiplier. */
  critDamage: 19,

  // --- Run-level knobs the modifier stack drives -------------------------------------------
  /** Enemy movement speed multiplier. */
  enemySpeed: 20,
  /** Enemy health multiplier. */
  enemyHealth: 21,
  /** Enemy damage multiplier. */
  enemyDamage: 22,
  /** Spawn-rate multiplier — how many enemies the wave table asks for. */
  spawnRate: 23,
  /** How fast run time advances relative to real ticks. Hurry lives here. */
  timeScale: 24,
  /** Curse — the omnibus difficulty multiplier applied to speed, health, count and quantity. */
  curse: 25,
  /** Gem XP value multiplier. */
  gemValue: 26,
  /** Reroll charges available at level-up. Flat. */
  rerolls: 27,
  /** Skip charges available at level-up. Flat. */
  skips: 28,
  /** Banish charges available at level-up. Flat. */
  banishes: 29,
} as const;

export type StatId = (typeof STAT)[keyof typeof STAT];

export const STAT_COUNT = 30;

/**
 * Guard against the one mistake that would corrupt save files: appending to `STAT` and forgetting to
 * widen `STAT_COUNT`, which would leave the new stat outside every table below and silently read 0.
 */
if (Object.keys(STAT).length !== STAT_COUNT) {
  throw new Error(`STAT_COUNT is ${STAT_COUNT} but STAT has ${Object.keys(STAT).length} entries`);
}

/**
 * Human names, for the dev menu and nothing else. Never shown to players verbatim.
 *
 * Derived from `STAT` rather than written out by hand. A hand-written parallel list is exactly the
 * kind of thing that silently falls out of alignment the first time a stat is appended, and a dev
 * menu that mislabels which stat you are editing is worse than one with no labels at all.
 */
export const STAT_NAMES: readonly string[] = (() => {
  const names = Array.from<string>({ length: STAT_COUNT }).fill("");
  for (const [name, id] of Object.entries(STAT)) names[id] = name;
  return names;
})();

/**
 * Baseline for a character with nothing equipped. Multiplier stats sit at `STAT_SCALE`; flat stats
 * sit at their natural zero. A character record shifts these; it does not replace them.
 */
export const STAT_BASE: readonly number[] = (() => {
  const b = Array.from<number>({ length: STAT_COUNT }).fill(0);
  b[STAT.damage] = STAT_SCALE;
  b[STAT.area] = STAT_SCALE;
  b[STAT.projectileSpeed] = STAT_SCALE;
  b[STAT.duration] = STAT_SCALE;
  b[STAT.amount] = 0;
  b[STAT.cooldown] = STAT_SCALE;
  b[STAT.armor] = 0;
  b[STAT.maxHealth] = 100 * STAT_SCALE;
  b[STAT.regen] = 0;
  b[STAT.moveSpeed] = STAT_SCALE;
  b[STAT.xpGain] = STAT_SCALE;
  b[STAT.goldGain] = STAT_SCALE;
  b[STAT.magnet] = STAT_SCALE;
  b[STAT.luck] = STAT_SCALE;
  b[STAT.pierce] = 0;
  b[STAT.knockback] = STAT_SCALE;
  b[STAT.iFrames] = 30; // half a second at 60Hz
  b[STAT.revives] = 0;
  b[STAT.critChance] = 0;
  b[STAT.critDamage] = 2 * STAT_SCALE;
  b[STAT.enemySpeed] = STAT_SCALE;
  b[STAT.enemyHealth] = STAT_SCALE;
  b[STAT.enemyDamage] = STAT_SCALE;
  b[STAT.spawnRate] = STAT_SCALE;
  b[STAT.timeScale] = STAT_SCALE;
  b[STAT.curse] = STAT_SCALE;
  b[STAT.gemValue] = STAT_SCALE;
  b[STAT.rerolls] = 0;
  b[STAT.skips] = 0;
  b[STAT.banishes] = 0;
  return b;
})();

/**
 * WHICH STATS ARE MULTIPLIERS AND WHICH ARE COUNTS
 *
 * Everything is an integer, but not everything is permille. Reading a count as a permille (or the
 * reverse) is a silent 1000x error, so the split is written down here rather than inferred:
 *
 *   COUNTS — read raw, no division. `amount`, `armor`, `pierce`, `iFrames` (ticks), `revives`,
 *   `rerolls`, `skips`, `banishes`. A base of 0 or a small integer is the tell.
 *
 *   PERMILLE — divide by `STAT_SCALE` to use. Everything else, including `maxHealth` (100_000 is
 *   100hp), `regen` (5000 is 5hp/sec) and `critChance` (1000 is 100%). A base of `STAT_SCALE` or a
 *   multiple of it is the tell.
 *
 * Caps and floors are written in the same units as the stat they guard: `armor` caps at 50 because
 * armor is a count, `critChance` caps at `STAT_SCALE` because it is a permille.
 */

/**
 * Hard ceilings. **Every stat is capped — `-1` (uncapped) is no longer a legal value here, and a
 * test in `sim.test.ts` fails the build if any entry is `-1`.** That invariant is what stops the
 * `Int32Array` from ever wrapping negative: a stored value past 2,147,483,647 does not saturate, it
 * flips sign, and a negative `maxHealth` or `damage` corrupts the run *and* the state hash silently.
 *
 * These exist so the endgame stays a game: unbounded `amount` turns the screen into a solid wall of
 * projectiles and unbounded `armor` makes damage stop existing. Limit Break pushes stats *toward*
 * these, and the caps are what make Golden Eggs a long tail rather than an off switch.
 *
 * TWO KINDS OF CAP, AND THE HEADROOM RULE
 * A handful of caps are true *balance* ceilings picked on purpose (amount 10, armor 50, pierce 10,
 * critChance 100%, revives) — those are the game design, and they bite reachable play by intent.
 * The rest are *hazard* ceilings: high enough that no currently reachable stack ever reaches them,
 * so they change nothing at normal play, but low enough to leave real headroom below 2^31.
 *
 * The realistic overflow site is `scale()`: `value * values[id]` is evaluated as a JS number before
 * the divide. `value` is a live game quantity (a hit's damage, a lifetime in ticks); a permille cap
 * of a few million multiplied by a value in the thousands stays comfortably inside 2^53 there, and
 * the *stored* value stays ~1000x below 2^31. Hence millions, not billions: `MULT_CAP` below is
 * 1000x base, which is far past anything the modifier stack can compound to yet leaves ~2100x of
 * headroom under the Int32 limit.
 */
export const STAT_CAPS: readonly number[] = (() => {
  const c = Array.from<number>({ length: STAT_COUNT }).fill(-1);

  // A generous permille ceiling for multiplier stats: 1000x base. No reachable modifier stack gets
  // near this (the largest catalog multipliers compound to low single-digit x), so it is a pure
  // hazard rail and does not touch balance. Leaves ~2100x headroom under 2^31 for the stored value.
  const MULT_CAP = 1_000_000; // 1000.0x in permille

  // --- Balance ceilings (deliberate, bite reachable play by design) ------------------------
  c[STAT.amount] = 10; // wall-of-projectiles ceiling
  c[STAT.armor] = 50; // above this, damage stops existing
  c[STAT.pierce] = 10; // per-hit passes through
  c[STAT.critChance] = STAT_SCALE; // 100% — a probability, cannot exceed its own space

  // --- Player multiplier stats (hazard rails at 1000x base) --------------------------------
  c[STAT.damage] = MULT_CAP;
  c[STAT.area] = MULT_CAP;
  c[STAT.projectileSpeed] = MULT_CAP;
  c[STAT.duration] = MULT_CAP;
  c[STAT.moveSpeed] = MULT_CAP;
  c[STAT.xpGain] = MULT_CAP;
  c[STAT.goldGain] = MULT_CAP;
  c[STAT.magnet] = MULT_CAP;
  c[STAT.luck] = MULT_CAP;
  c[STAT.knockback] = MULT_CAP;
  c[STAT.critDamage] = MULT_CAP; // base is 2000; 1_000_000 is far above it
  c[STAT.gemValue] = MULT_CAP;

  // cooldown is a multiplier floored at 100 (0.1x) and only ever driven *down*; nothing pushes it
  // up past base, but it still needs a ceiling to satisfy the "no -1" invariant. 1000x base.
  c[STAT.cooldown] = MULT_CAP;

  // maxHealth is permille health units (100_000 == 100hp). Base is 100_000, so its 1000x ceiling is
  // 100_000_000 (== 100k hp) — still ~21x below 2^31, generous headroom. Guess: tune down if a
  // 100k-hp wall ever becomes reachable, but nothing today approaches it.
  c[STAT.maxHealth] = 100 * MULT_CAP; // 100_000_000 permille == 100_000 hp
  c[STAT.regen] = MULT_CAP; // permille hp/sec (1000 == 1hp/sec); 1000hp/sec ceiling

  // --- Run-level multiplier knobs (hazard rails at 1000x base) -----------------------------
  c[STAT.enemySpeed] = MULT_CAP;
  c[STAT.enemyHealth] = MULT_CAP;
  c[STAT.enemyDamage] = MULT_CAP;
  c[STAT.spawnRate] = MULT_CAP;
  c[STAT.timeScale] = MULT_CAP;
  c[STAT.curse] = MULT_CAP;

  // --- Count stats (small integer ceilings) ------------------------------------------------
  // iFrames is in ticks (base 30 == 0.5s). Passives/powerups grant tens; 6000 ticks == 100s of
  // invulnerability is far past anything reachable, so it is a hazard rail, not a balance change.
  c[STAT.iFrames] = 6000;
  // revives: a deliberate balance ceiling. 99 is more than any run can spend and keeps the HUD sane.
  c[STAT.revives] = 99;
  // level-up charges. Guesses at generous ceilings — nothing reachable grants this many, so they do
  // not bite; lower them if a build ever wants fewer.
  c[STAT.rerolls] = 999;
  c[STAT.skips] = 999;
  c[STAT.banishes] = 999;

  return c;
})();

/** Floors, for the stats where zero or negative would break the sim rather than be interesting. */
export const STAT_FLOORS: readonly number[] = (() => {
  const f = Array.from<number>({ length: STAT_COUNT }).fill(0);
  f[STAT.cooldown] = 100; // 0.1x — never zero, never negative
  f[STAT.maxHealth] = 1;
  f[STAT.timeScale] = 1;
  f[STAT.area] = 50;
  f[STAT.moveSpeed] = 0;
  f[STAT.enemyHealth] = 1;
  f[STAT.spawnRate] = 0;
  return f;
})();

/**
 * Live stat table for one player.
 *
 * Deliberately dumb: it owns the numbers and the clamping rule, and knows nothing about where the
 * numbers came from. `Modifiers.resolve` is what fills it.
 */
export class Stats {
  readonly values: Int32Array;
  /** Bumped on every resolve, so systems can cheaply detect "did my stats change". */
  version = 0;

  constructor() {
    this.values = new Int32Array(STAT_COUNT);
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < STAT_COUNT; i++) this.values[i] = STAT_BASE[i];
    this.version++;
  }

  get(id: StatId): number {
    return this.values[id];
  }

  /** Multiplier stats as a permille-scaled integer applied to a value: `scale(base, STAT.damage)`. */
  scale(value: number, id: StatId): number {
    return Math.trunc((value * this.values[id]) / STAT_SCALE);
  }

  /** Clamp every stat into its legal window. Called once at the end of a resolve, never per-read. */
  clampAll(): void {
    for (let i = 0; i < STAT_COUNT; i++) {
      const floor = STAT_FLOORS[i];
      if (this.values[i] < floor) this.values[i] = floor;
      const cap = STAT_CAPS[i];
      if (cap >= 0 && this.values[i] > cap) this.values[i] = cap;
    }
    this.version++;
  }
}
