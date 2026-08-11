/**
 * Guest-side plausibility checks on host events.
 *
 * WHY THIS EXISTS (plan.md §5b addendum)
 * The host is authoritative, and the host is a player's phone. A patched binary running as host can
 * therefore hand every guest a corrupted run — infinite chests, 1000x damage, absurd XP — and the
 * guests will faithfully simulate it because "the host said so" is the whole design.
 *
 * We cannot fix that by trusting the host less; host authority is what makes the netcode cheap and
 * cheat-resistant in the normal case. What we can do is bound the damage: a guest watches the *rate*
 * and *magnitude* of the events it receives and, when they leave the envelope any legitimate run
 * could produce, leaves the session and marks it non-counting. The modded host gets to cheat alone.
 *
 * WHAT THIS IS NOT
 * Not a security boundary and not an accusation. It is a smoke alarm with generous thresholds. False
 * positives cost a player one co-op session, so every threshold below is set well above the worst
 * legitimate case (a maxed Limit Break loadout in late Endless), not near the average one.
 *
 * SCOPE
 * Private room codes are explicitly out of scope — if you hand a friend a code you have chosen to
 * trust them. This runs in public matchmaking only.
 */

/**
 * Thresholds. Every one of these is a *ceiling on a legitimate run*, derived from the content caps in
 * plan.md, not a guess at what a cheater does.
 */
export const PLAUSIBILITY = {
  /**
   * Enemies spawned per second. Late Endless with a full Curse stack is the reference point; the
   * spawn director's own hard cap is well under this, so anything above means the director was not
   * the thing that produced these spawns.
   */
  maxSpawnsPerSecond: 400,
  /**
   * Single damage instance. The theoretical ceiling of a fully-evolved, fully-limit-broken build
   * against a Curse-inflated enemy, with a wide margin.
   */
  maxSingleDamage: 5_000_000,
  /** XP granted in one second. A gem-heavy sweep with maximum Growth is far below this. */
  maxXpPerSecond: 2_000_000,
  /** Chests opened per minute. Legitimately bounded by the stage's chest table. */
  maxChestsPerMinute: 30,
  /** Level-ups in one batch. Reference: the reported 230-levels-from-one-gem case, doubled. */
  maxLevelsPerBatch: 500,
  /** Player levels gained per minute. */
  maxLevelsPerMinute: 3_000,
  /**
   * Consecutive seconds any single threshold may be exceeded before we act.
   *
   * A momentary spike can be a legitimate burst, a resync artefact, or our own clock being briefly
   * wrong. Requiring the breach to persist removes essentially all of that noise while still catching
   * a real modded host within a few seconds.
   */
  breachSecondsBeforeLeave: 3,
} as const;

/** Which envelope was breached, for the leave reason and the report-host payload. */
export const BREACH = {
  NONE: 0,
  SPAWN_RATE: 1,
  DAMAGE_MAGNITUDE: 2,
  XP_RATE: 3,
  CHEST_RATE: 4,
  LEVEL_BATCH: 5,
  LEVEL_RATE: 6,
} as const;

export type BreachKind = (typeof BREACH)[keyof typeof BREACH];

/**
 * Rolling one-second windows over the incoming host event stream.
 *
 * Counters are integers reset on a tick boundary rather than a true sliding window: a sliding window
 * needs per-event timestamps, which means storage proportional to event volume, and event volume is
 * precisely what we are trying to bound. Fixed one-second buckets cost four integers and are accurate
 * enough for thresholds this loose.
 */
export class PlausibilityMonitor {
  private spawnsThisSecond = 0;
  private xpThisSecond = 0;
  private levelsThisSecond = 0;
  private chestsThisMinute = 0;
  private tickInSecond = 0;
  private secondInMinute = 0;

  /** Consecutive seconds currently in breach. */
  private breachSeconds = 0;
  /** What tripped it. `BREACH.NONE` when clean. */
  breach: BreachKind = BREACH.NONE;
  /** True once the breach has persisted long enough to act on. Latched — never clears itself. */
  tripped = false;

  /** Peak values seen, purely so the dev menu and the report payload can show real numbers. */
  peakSpawnsPerSecond = 0;
  peakSingleDamage = 0;
  peakXpPerSecond = 0;

  onSpawn(count: number): void {
    this.spawnsThisSecond += count;
  }

  onDamage(amount: number): void {
    if (amount > this.peakSingleDamage) this.peakSingleDamage = amount;
    if (amount > PLAUSIBILITY.maxSingleDamage) this.flag(BREACH.DAMAGE_MAGNITUDE);
  }

  onXp(amount: number): void {
    this.xpThisSecond += amount;
  }

  onChest(): void {
    this.chestsThisMinute += 1;
  }

  onBatchLevelUp(levels: number): void {
    this.levelsThisSecond += levels;
    if (levels > PLAUSIBILITY.maxLevelsPerBatch) this.flag(BREACH.LEVEL_BATCH);
  }

  /**
   * Advance the windows. Called once per simulated tick.
   *
   * Driven by sim ticks rather than wall time on purpose: if the host is feeding us events faster than
   * real time, wall-clock buckets would spread them across more buckets and hide exactly the abuse we
   * are looking for.
   */
  tick(): void {
    this.tickInSecond++;
    if (this.tickInSecond < 60) return;
    this.tickInSecond = 0;

    if (this.spawnsThisSecond > this.peakSpawnsPerSecond) {
      this.peakSpawnsPerSecond = this.spawnsThisSecond;
    }
    if (this.xpThisSecond > this.peakXpPerSecond) this.peakXpPerSecond = this.xpThisSecond;

    let breachedThisSecond = false;
    if (this.spawnsThisSecond > PLAUSIBILITY.maxSpawnsPerSecond) {
      this.flag(BREACH.SPAWN_RATE);
      breachedThisSecond = true;
    }
    if (this.xpThisSecond > PLAUSIBILITY.maxXpPerSecond) {
      this.flag(BREACH.XP_RATE);
      breachedThisSecond = true;
    }
    if (this.levelsThisSecond * 60 > PLAUSIBILITY.maxLevelsPerMinute) {
      this.flag(BREACH.LEVEL_RATE);
      breachedThisSecond = true;
    }

    this.spawnsThisSecond = 0;
    this.xpThisSecond = 0;
    this.levelsThisSecond = 0;

    this.secondInMinute++;
    if (this.secondInMinute >= 60) {
      this.secondInMinute = 0;
      if (this.chestsThisMinute > PLAUSIBILITY.maxChestsPerMinute) {
        this.flag(BREACH.CHEST_RATE);
        breachedThisSecond = true;
      }
      this.chestsThisMinute = 0;
    }

    if (breachedThisSecond) {
      this.breachSeconds++;
      if (this.breachSeconds >= PLAUSIBILITY.breachSecondsBeforeLeave) this.tripped = true;
    } else {
      this.breachSeconds = 0;
    }
  }

  /**
   * Magnitude breaches trip immediately rather than accumulating a rate.
   *
   * A single five-million-damage hit cannot be a legitimate burst the way a spawn spike can, so there
   * is nothing to wait for. It still only latches `breach`; whether to leave is the caller's call.
   */
  private flag(kind: BreachKind): void {
    if (this.breach === BREACH.NONE) this.breach = kind;
    if (kind === BREACH.DAMAGE_MAGNITUDE || kind === BREACH.LEVEL_BATCH) this.tripped = true;
  }

  reset(): void {
    this.spawnsThisSecond = 0;
    this.xpThisSecond = 0;
    this.levelsThisSecond = 0;
    this.chestsThisMinute = 0;
    this.tickInSecond = 0;
    this.secondInMinute = 0;
    this.breachSeconds = 0;
    this.breach = BREACH.NONE;
    this.tripped = false;
  }
}
