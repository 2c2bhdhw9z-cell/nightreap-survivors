/**
 * The wave director — what shows up, when, and how much of it.
 *
 * WHY IT IS A TABLE AND NOT CODE
 * The pacing of a run is the game. It needs to be tuneable in minutes, by editing numbers, without
 * touching a single line of logic — because we will tune it hundreds of times, and because the live
 * ops plan has the server shipping new wave tables for weekly events. A table also means the dev
 * menu can jump to minute 27 by asking the director for minute 27, instead of fast-forwarding
 * through 27 minutes of simulation.
 *
 * WHY THE CLOCK IS SEPARATE FROM REAL TIME
 * The director runs off *run time*, which advances at a rate set by the run's time-scale stat. That
 * one indirection is what makes the Hurry mode exist: Hurry doubles the time scale, and every wave,
 * every boss and the Reaper all arrive twice as fast without the director knowing Hurry exists.
 *
 * WHY ENEMIES SPAWN ON A RING
 * Off-screen, just past the edge of what the player can see, at a distance that accounts for the
 * widest phone we support. Spawning on-screen is unfair; spawning too far out wastes entities on
 * enemies that get culled before they ever threaten anyone.
 */

import { Rng } from "../core/rng";
import { ENEMY_TYPE_BY_ID, EnemyStore } from "./enemies";
import { STAT, STAT_SCALE, type Stats } from "./stats";

/** Ticks per simulated second. The sim is fixed-step; rendering interpolates on top. */
export const TICKS_PER_SECOND = 60;

/**
 * Ring radius for spawning, in world units.
 *
 * Comfortably outside the diagonal of the widest supported viewport, so an enemy is never seen
 * appearing out of nothing. Culling sits far outside this, so an enemy that spawns behind the
 * player and gets left behind still gets a fair chance to catch up before being recycled.
 */
export const SPAWN_RING = 340;

/** One entry in the wave schedule. */
export interface WaveEntry {
  /** Run time in seconds when this wave becomes active. */
  readonly atSecond: number;
  /** Enemy type ids and their relative weight in the spawn draw. */
  readonly mix: readonly { readonly id: string; readonly weight: number }[];
  /** Enemies per second this wave asks for, before the run's spawn-rate multiplier. */
  readonly perSecond: number;
  /** Cap on live enemies while this wave is active. The pool is a backstop; this is the design. */
  readonly liveCap: number;
  /** Optional boss to spawn once when this wave begins. */
  readonly boss?: string;
}

/**
 * The first ten minutes of the default stage.
 *
 * Shape of the curve, deliberately: a near-empty first thirty seconds so the player learns the
 * stick, a slow thickening through minute three, the first real crowd at four, the first boss at
 * five, then a step change so that surviving to ten feels earned. Numbers here are the starting
 * point for tuning, not the finished pacing.
 */
export const DEFAULT_WAVES: readonly WaveEntry[] = [
  { atSecond: 0, mix: [{ id: "shambler", weight: 100 }], perSecond: 1.2, liveCap: 40 },
  {
    atSecond: 30,
    mix: [
      { id: "shambler", weight: 80 },
      { id: "gnawer", weight: 20 },
    ],
    perSecond: 2.4,
    liveCap: 70,
  },
  {
    atSecond: 90,
    mix: [
      { id: "shambler", weight: 55 },
      { id: "gnawer", weight: 45 },
    ],
    perSecond: 4,
    liveCap: 110,
  },
  {
    atSecond: 150,
    mix: [
      { id: "shambler", weight: 40 },
      { id: "gnawer", weight: 40 },
      { id: "hound", weight: 20 },
    ],
    perSecond: 6,
    liveCap: 160,
  },
  {
    atSecond: 210,
    mix: [
      { id: "gnawer", weight: 45 },
      { id: "hound", weight: 25 },
      { id: "bonepile", weight: 15 },
      { id: "wisp", weight: 15 },
    ],
    perSecond: 8,
    liveCap: 230,
  },
  {
    atSecond: 300,
    mix: [
      { id: "gnawer", weight: 40 },
      { id: "shambler", weight: 25 },
      { id: "hound", weight: 20 },
      { id: "bonepile", weight: 15 },
    ],
    perSecond: 9,
    liveCap: 300,
    boss: "gravewarden",
  },
  {
    atSecond: 420,
    mix: [
      { id: "gnawer", weight: 50 },
      { id: "hound", weight: 25 },
      { id: "wisp", weight: 15 },
      { id: "bonepile", weight: 10 },
    ],
    perSecond: 12,
    liveCap: 420,
  },
  {
    atSecond: 540,
    mix: [
      { id: "gnawer", weight: 45 },
      { id: "hound", weight: 25 },
      { id: "bonepile", weight: 20 },
      { id: "wisp", weight: 10 },
    ],
    perSecond: 15,
    liveCap: 560,
  },
];

/**
 * How many owed named fights are remembered while the floor is busy.
 *
 * Deliberately small. If three bosses have stacked up, the player is so far behind the table that
 * queueing a fourth would mean a wall of named fights the moment they finally win one, which is a
 * worse outcome than quietly dropping the oldest of them.
 */
export const MAX_QUEUED_BOSSES = 3;

/** Run-time seconds at which the Reaper arrives on a standard stage. */
export const REAPER_SECOND = 30 * 60;

/**
 * Drives spawning for one run.
 *
 * Holds the run clock, the current wave, and a fractional spawn accumulator. The accumulator is the
 * detail that matters: at 1.2 enemies per second we owe the player one enemy every fifty ticks, and
 * rounding that per tick would either spawn nothing or spawn sixty times too many.
 */
export class WaveDirector {
  private waves: readonly WaveEntry[] = DEFAULT_WAVES;
  private waveIndex = 0;
  /** Fractional enemies owed but not yet spawned. */
  private spawnDebt = 0;
  /** Resolved type indices for the active wave's mix, and their cumulative weights. */
  private readonly mixTypes = new Int32Array(16);
  private readonly mixCumulative = new Int32Array(16);
  private mixLength = 0;
  private mixTotalWeight = 0;

  /** Run time in ticks. Advanced by the time-scale stat, not by wall clock. */
  runTicks = 0;
  /** Fractional tick carry, so a 1.5x time scale does not lose half a tick every tick. */
  private tickCarry = 0;
  /** How many Endless cycles have completed. Each one raises Curse. */
  cycle = 0;
  /** Whether the Reaper has been triggered this cycle. */
  reaperSpawned = false;
  /** Total spawned this run. Dev-menu diagnostic. */
  spawnedTotal = 0;
  /** Spawns refused because the live cap or the pool was full. */
  refusedTotal = 0;

  /**
   * Named fights that were due but could not be sent in, oldest first.
   *
   * Only one boss is ever on the floor at a time — the health bar belongs to one fight, and two of
   * them at once is unreadable. The first version of this simply skipped a boss whose slot was busy,
   * and playing the tables headless showed what that really means: a player who is still grinding the
   * five-minute boss at minute twelve never sees the twelve-minute boss at all. The fight does not
   * arrive late, it silently never happened, and the run they played is not the run the table
   * describes.
   *
   * So a boss that cannot come in now waits here and comes in the moment the floor is clear. It is a
   * queue rather than a single slot because a long enough stall can stack two of them, and it is
   * oldest-first because the fights are meant to be met in the order the stage lists them.
   */
  private readonly bossQueue: string[] = [];

  /**
   * The second the Reaper is due on the stage being played.
   *
   * A stage owns this rather than the director, because "how long is a full run here" is part of
   * what a place is. It is still the same number on all five stages today, deliberately: a time on
   * one floor has to mean the same thing as a time on another.
   */
  private reaperAt = REAPER_SECOND;

  get runSeconds(): number {
    return this.runTicks / TICKS_PER_SECOND;
  }

  get currentWave(): WaveEntry {
    return this.waves[this.waveIndex];
  }

  /** Reset for a new run. Reused between runs so "restart same seed" allocates nothing. */
  begin(waves: readonly WaveEntry[] = DEFAULT_WAVES, reaperSecond: number = REAPER_SECOND): void {
    this.waves = waves;
    this.reaperAt = reaperSecond > 0 ? reaperSecond : REAPER_SECOND;
    this.waveIndex = 0;
    this.spawnDebt = 0;
    this.runTicks = 0;
    this.tickCarry = 0;
    this.cycle = 0;
    this.reaperSpawned = false;
    this.spawnedTotal = 0;
    this.refusedTotal = 0;
    this.bossQueue.length = 0;
    this.resolveMix();
  }

  /** Cache the active wave's mix as indices, so the spawn draw never touches a string. */
  private resolveMix(): void {
    const mix = this.waves[this.waveIndex].mix;
    this.mixLength = Math.min(mix.length, this.mixTypes.length);
    let total = 0;
    for (let i = 0; i < this.mixLength; i++) {
      this.mixTypes[i] = ENEMY_TYPE_BY_ID.get(mix[i].id) ?? 0;
      total += mix[i].weight;
      this.mixCumulative[i] = total;
    }
    this.mixTotalWeight = total;
  }

  /**
   * Jump the clock. Used by the dev menu's "jump to timestamp" and by Endless when the table loops.
   *
   * Note what it does *not* do: it does not simulate the skipped time. Jumping to minute 25 gives
   * you minute 25's waves, not the crowd that twenty-five minutes of play would have produced. That
   * is the honest behaviour for a testing tool, and it is instant.
   */
  jumpToSecond(second: number): void {
    this.runTicks = Math.max(0, Math.trunc(second * TICKS_PER_SECOND));
    this.tickCarry = 0;
    this.spawnDebt = 0;
    this.waveIndex = 0;
    for (let i = 0; i < this.waves.length; i++) {
      if (this.waves[i].atSecond <= second) this.waveIndex = i;
    }
    this.reaperSpawned = second < this.reaperAt ? false : this.reaperSpawned;
    // A jump does not simulate the skipped time, so it must not carry a fight that was owed before
    // the jump into a minute that never asked for it.
    this.bossQueue.length = 0;
    this.resolveMix();
  }

  /**
   * Advance one sim tick and spawn whatever this tick owes.
   *
   * `endless` loops the table instead of letting it run out, raising Curse each cycle. It arrives as
   * a parameter rather than being read from a mode flag inside here, so the director stays ignorant
   * of what a "mode" is.
   */
  update(
    enemies: EnemyStore,
    stats: Stats,
    rng: Rng,
    playerX: number,
    playerY: number,
    endless: boolean,
  ): void {
    // Run time advances at the rate the modifier stack decided. Hurry lives entirely in this line.
    const scale = stats.get(STAT.timeScale) / STAT_SCALE;
    this.tickCarry += scale;
    while (this.tickCarry >= 1) {
      this.runTicks++;
      this.tickCarry -= 1;
    }

    const seconds = this.runSeconds;

    // Advance the wave, possibly by more than one step if the clock jumped.
    while (this.waveIndex + 1 < this.waves.length && this.waves[this.waveIndex + 1].atSecond <= seconds) {
      this.waveIndex++;
      this.resolveMix();
      const boss = this.waves[this.waveIndex].boss;
      if (boss !== undefined && this.bossQueue.length < MAX_QUEUED_BOSSES) this.bossQueue.push(boss);
    }

    // Whatever fight is owed comes in as soon as the floor is clear, however late that is.
    if (this.bossQueue.length > 0 && enemies.bossCount() === 0) {
      const due = this.bossQueue.shift() as string;
      this.spawnAtRing(enemies, stats, rng, playerX, playerY, ENEMY_TYPE_BY_ID.get(due) ?? 0);
    }

    // End of the table. In Endless, loop and raise Curse; otherwise hold on the final wave.
    if (endless && this.waveIndex === this.waves.length - 1) {
      const last = this.waves[this.waves.length - 1];
      if (seconds >= last.atSecond + 120) {
        this.cycle++;
        this.waveIndex = 0;
        this.resolveMix();
        this.runTicks = 0;
        this.reaperSpawned = false;
      }
    }

    const wave = this.waves[this.waveIndex];

    // Spawn rate is the wave's number times the run's multiplier. A Hyper run raises the multiplier;
    // the wave table is untouched.
    const spawnRate = stats.get(STAT.spawnRate);
    const rate = (wave.perSecond * spawnRate) / STAT_SCALE;
    this.spawnDebt += rate / TICKS_PER_SECOND;

    // The live cap scales with the same multiplier. With a fixed cap, the crowd test showed a Hyper
    // run producing an identical horde whenever the cap was the binding constraint, which made the
    // modifier a no-op. The pool budget is still the hard backstop above this.
    const liveCap = Math.trunc((wave.liveCap * spawnRate) / STAT_SCALE);

    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      if (enemies.count >= liveCap) {
        // At the cap we throw the debt away instead of banking it. Banking it would mean that
        // killing the crowd releases a stored-up flood, which reads as a bug rather than a wave.
        this.spawnDebt = 0;
        this.refusedTotal++;
        break;
      }
      this.spawnAtRing(enemies, stats, rng, playerX, playerY, this.drawType(rng));
    }
  }

  /** Weighted pick from the active mix. */
  private drawType(rng: Rng): number {
    if (this.mixLength === 1 || this.mixTotalWeight <= 0) return this.mixTypes[0];
    const roll = rng.nextInt(this.mixTotalWeight);
    for (let i = 0; i < this.mixLength; i++) {
      if (roll < this.mixCumulative[i]) return this.mixTypes[i];
    }
    return this.mixTypes[this.mixLength - 1];
  }

  /** Place one enemy on the spawn ring around a point. */
  private spawnAtRing(
    enemies: EnemyStore,
    stats: Stats,
    rng: Rng,
    px: number,
    py: number,
    typeIndex: number,
  ): void {
    // 4096 steps of a turn — plenty of angular resolution, and an integer draw keeps the spawn
    // position reproducible from the seed alone, which is what replay revalidation needs.
    const step = rng.nextInt(4096);
    const angle = (step / 4096) * Math.PI * 2;
    const x = px + Math.cos(angle) * SPAWN_RING;
    const y = py + Math.sin(angle) * SPAWN_RING;
    if (enemies.spawn(typeIndex, x, y, stats) < 0) {
      this.refusedTotal++;
      return;
    }
    this.spawnedTotal++;
  }

  /** The second the Reaper is due on the stage currently being played. */
  get reaperSecond(): number {
    return this.reaperAt;
  }

  /** Whether the Reaper is due. The caller owns the actual sequence. */
  reaperDue(stats: Stats, earlyReaper: boolean): boolean {
    if (this.reaperSpawned) return false;
    void stats;
    const at = earlyReaper ? this.reaperAt / 2 : this.reaperAt;
    return this.runSeconds >= at;
  }
}
