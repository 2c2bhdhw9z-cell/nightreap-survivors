import { Rng } from "../core/rng";
import { BRAD_FULL, fxCosF, fxSinF } from "../core/fx";
import { ENEMY_TYPE_BY_ID, EnemyStore } from "./enemies";
import { STAT, STAT_SCALE, type Stats } from "./stats";

export const TICKS_PER_SECOND = 60;

export const SPAWN_RING = 340;

export interface WaveEntry {
  readonly atSecond: number;
  readonly mix: readonly { readonly id: string; readonly weight: number }[];
  readonly perSecond: number;
  readonly liveCap: number;
  readonly boss?: string;
}

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

export const MAX_QUEUED_BOSSES = 3;

export const REAPER_SECOND = 30 * 60;

/** Seconds between additional Reapers after the first. Genre-standard: one more every minute. */
export const REAPER_INTERVAL_SECONDS = 60;

export class WaveDirector {
  private waves: readonly WaveEntry[] = DEFAULT_WAVES;
  private waveIndex = 0;
  private spawnDebt = 0;
  private readonly mixTypes = new Int32Array(16);
  private readonly mixCumulative = new Int32Array(16);
  private mixLength = 0;
  private mixTotalWeight = 0;

  runTicks = 0;
  private tickCarry = 0;
  cycle = 0;
  reaperSpawned = false;
  reaperCount = 0;
  private nextReaperAt = REAPER_SECOND;
  spawnedTotal = 0;
  refusedTotal = 0;

  private readonly bossQueue: string[] = [];
  private reaperAt = REAPER_SECOND;

  get runSeconds(): number {
    return this.runTicks / TICKS_PER_SECOND;
  }

  get currentWave(): WaveEntry {
    return this.waves[this.waveIndex];
  }

  begin(waves: readonly WaveEntry[] = DEFAULT_WAVES, reaperSecond: number = REAPER_SECOND): void {
    this.waves = waves;
    this.reaperAt = reaperSecond > 0 ? reaperSecond : REAPER_SECOND;
    this.waveIndex = 0;
    this.spawnDebt = 0;
    this.runTicks = 0;
    this.tickCarry = 0;
    this.cycle = 0;
    this.reaperSpawned = false;
    this.reaperCount = 0;
    this.nextReaperAt = this.reaperAt;
    this.spawnedTotal = 0;
    this.refusedTotal = 0;
    this.bossQueue.length = 0;
    this.resolveMix();
  }

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

  jumpToSecond(second: number): void {
    this.runTicks = Math.max(0, Math.trunc(second * TICKS_PER_SECOND));
    this.tickCarry = 0;
    this.spawnDebt = 0;
    this.waveIndex = 0;
    for (let i = 0; i < this.waves.length; i++) {
      if (this.waves[i].atSecond <= second) this.waveIndex = i;
    }
    if (second < this.reaperAt) {
      this.reaperSpawned = false;
      this.reaperCount = 0;
      this.nextReaperAt = this.reaperAt;
    } else if (this.reaperCount === 0) {
      this.nextReaperAt = this.reaperAt;
    } else {
      this.nextReaperAt = second + REAPER_INTERVAL_SECONDS;
    }
    this.bossQueue.length = 0;
    this.resolveMix();
  }

  update(
    enemies: EnemyStore,
    stats: Stats,
    rng: Rng,
    playerX: number,
    playerY: number,
    endless: boolean,
  ): void {
    const scale = stats.get(STAT.timeScale) / STAT_SCALE;
    this.tickCarry += scale;
    while (this.tickCarry >= 1) {
      this.runTicks++;
      this.tickCarry -= 1;
    }

    const seconds = this.runSeconds;

    while (this.waveIndex + 1 < this.waves.length && this.waves[this.waveIndex + 1].atSecond <= seconds) {
      this.waveIndex++;
      this.resolveMix();
      const boss = this.waves[this.waveIndex].boss;
      if (boss !== undefined && this.bossQueue.length < MAX_QUEUED_BOSSES) this.bossQueue.push(boss);
    }

    if (this.bossQueue.length > 0 && enemies.bossCount() === 0) {
      const due = this.bossQueue.shift() as string;
      this.spawnAtRing(enemies, stats, rng, playerX, playerY, ENEMY_TYPE_BY_ID.get(due) ?? 0);
    }

    if (endless && this.waveIndex === this.waves.length - 1) {
      const last = this.waves[this.waves.length - 1];
      if (seconds >= last.atSecond + 120) {
        this.cycle++;
        this.waveIndex = 0;
        this.resolveMix();
        this.runTicks = 0;
        this.reaperSpawned = false;
        this.reaperCount = 0;
        this.nextReaperAt = this.reaperAt;
      }
    }

    const wave = this.waves[this.waveIndex];

    const spawnRate = stats.get(STAT.spawnRate);
    const rate = (wave.perSecond * spawnRate) / STAT_SCALE;
    this.spawnDebt += rate / TICKS_PER_SECOND;

    const liveCap = Math.trunc((wave.liveCap * spawnRate) / STAT_SCALE);

    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      if (enemies.count >= liveCap) {
        this.spawnDebt = 0;
        this.refusedTotal++;
        break;
      }
      this.spawnAtRing(enemies, stats, rng, playerX, playerY, this.drawType(rng));
    }
  }

  private drawType(rng: Rng): number {
    if (this.mixLength === 1 || this.mixTotalWeight <= 0) return this.mixTypes[0];
    const roll = rng.nextInt(this.mixTotalWeight);
    for (let i = 0; i < this.mixLength; i++) {
      if (roll < this.mixCumulative[i]) return this.mixTypes[i];
    }
    return this.mixTypes[this.mixLength - 1];
  }

  private spawnAtRing(
    enemies: EnemyStore,
    stats: Stats,
    rng: Rng,
    px: number,
    py: number,
    typeIndex: number,
  ): void {
    const step = rng.nextInt(BRAD_FULL);
    const x = px + fxCosF(step) * SPAWN_RING;
    const y = py + fxSinF(step) * SPAWN_RING;
    if (enemies.spawn(typeIndex, x, y, stats) < 0) {
      this.refusedTotal++;
      return;
    }
    this.spawnedTotal++;
  }

  get reaperSecond(): number {
    return this.reaperAt;
  }

  reaperDue(stats: Stats, earlyReaper: boolean): boolean {
    void stats;
    if (this.reaperCount === 0) {
      const at = earlyReaper ? this.reaperAt / 2 : this.reaperAt;
      return this.runSeconds >= at;
    }
    return this.runSeconds >= this.nextReaperAt;
  }

  noteReaperSpawned(): void {
    this.reaperSpawned = true;
    this.reaperCount++;
    const base = this.reaperCount === 1
      ? (this.runSeconds < this.reaperAt ? this.reaperAt : this.runSeconds)
      : this.nextReaperAt;
    this.nextReaperAt = base + REAPER_INTERVAL_SECONDS;
  }
}
