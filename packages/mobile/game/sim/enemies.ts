import { SpatialHash } from "../core/spatial-hash";
import { BRAD_FULL, fxCosF, fxSinF } from "../core/fx";
import { EntityPool, NULL_HANDLE, POOL_BUDGETS, type Handle } from "../core/pool";
import { STAT, STAT_SCALE, type Stats } from "./stats";
export const ENEMY_KIND = {
  chaser: 0,
  swarmer: 1,
  brute: 2,
  charger: 3,
  circler: 4,
  boss: 5,
  weaver: 6,
  lurker: 7,
  flanker: 8,
} as const;
export const LURKER_WAKE = 96;
export const FLANKER_CIRCLE_TICKS = 180;
export const FLANKER_RING = 150;
export const WEAVER_PERIOD = 96;
export type EnemyKind = (typeof ENEMY_KIND)[keyof typeof ENEMY_KIND];
export const ENEMY_FLAG = {
  knocked: 1 << 0,
  heavy: 1 << 1,
  phasing: 1 << 2,
  boss: 1 << 3,
  persistent: 1 << 4,
} as const;
export interface EnemyType {
  readonly id: string;
  readonly kind: EnemyKind;
  readonly sprite: string;
  readonly health: number;
  readonly damage: number;
  readonly speed: number;
  readonly radius: number;
  readonly xp: number;
  readonly goldChance: number;
  readonly flags: number;
}
export const ENEMY_TYPES: readonly EnemyType[] = [
  {
    id: "shambler",
    kind: ENEMY_KIND.chaser,
    sprite: "enemy.shambler",
    health: 10,
    damage: 4,
    speed: 34,
    radius: 7,
    xp: 1,
    goldChance: 15,
    flags: 0,
  },
  {
    id: "gnawer",
    kind: ENEMY_KIND.swarmer,
    sprite: "enemy.gnawer",
    health: 6,
    damage: 3,
    speed: 52,
    radius: 5,
    xp: 1,
    goldChance: 8,
    flags: 0,
  },
  {
    id: "bonepile",
    kind: ENEMY_KIND.brute,
    sprite: "enemy.bonepile",
    health: 60,
    damage: 9,
    speed: 22,
    radius: 11,
    xp: 4,
    goldChance: 60,
    flags: ENEMY_FLAG.heavy,
  },
  {
    id: "hound",
    kind: ENEMY_KIND.charger,
    sprite: "enemy.hound",
    health: 14,
    damage: 6,
    speed: 74,
    radius: 7,
    xp: 2,
    goldChance: 20,
    flags: ENEMY_FLAG.persistent,
  },
  {
    id: "wisp",
    kind: ENEMY_KIND.circler,
    sprite: "enemy.wisp",
    health: 18,
    damage: 5,
    speed: 44,
    radius: 6,
    xp: 3,
    goldChance: 35,
    flags: ENEMY_FLAG.phasing,
  },
  {
    id: "gravewarden",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.gravewarden",
    health: 900,
    damage: 16,
    speed: 30,
    radius: 18,
    xp: 60,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "crawler",
    kind: ENEMY_KIND.swarmer,
    sprite: "enemy.crawler",
    health: 5,
    damage: 3,
    speed: 60,
    radius: 5,
    xp: 1,
    goldChance: 6,
    flags: 0,
  },
  {
    id: "bloatfly",
    kind: ENEMY_KIND.weaver,
    sprite: "enemy.bloatfly",
    health: 12,
    damage: 4,
    speed: 46,
    radius: 6,
    xp: 2,
    goldChance: 18,
    flags: 0,
  },
  {
    id: "pallbearer",
    kind: ENEMY_KIND.brute,
    sprite: "enemy.pallbearer",
    health: 110,
    damage: 12,
    speed: 18,
    radius: 12,
    xp: 6,
    goldChance: 90,
    flags: ENEMY_FLAG.heavy,
  },
  {
    id: "graveling",
    kind: ENEMY_KIND.chaser,
    sprite: "enemy.graveling",
    health: 22,
    damage: 5,
    speed: 38,
    radius: 7,
    xp: 2,
    goldChance: 18,
    flags: 0,
  },
  {
    id: "shrieker",
    kind: ENEMY_KIND.circler,
    sprite: "enemy.shrieker",
    health: 26,
    damage: 6,
    speed: 48,
    radius: 6,
    xp: 3,
    goldChance: 40,
    flags: ENEMY_FLAG.phasing,
  },
  {
    id: "ripper",
    kind: ENEMY_KIND.flanker,
    sprite: "enemy.ripper",
    health: 20,
    damage: 8,
    speed: 88,
    radius: 7,
    xp: 3,
    goldChance: 26,
    flags: ENEMY_FLAG.persistent,
  },
  {
    id: "tomblurker",
    kind: ENEMY_KIND.lurker,
    sprite: "enemy.tomblurker",
    health: 34,
    damage: 9,
    speed: 42,
    radius: 8,
    xp: 4,
    goldChance: 45,
    flags: 0,
  },
  {
    id: "gravemoth",
    kind: ENEMY_KIND.weaver,
    sprite: "enemy.gravemoth",
    health: 16,
    damage: 5,
    speed: 54,
    radius: 6,
    xp: 2,
    goldChance: 22,
    flags: 0,
  },
  {
    id: "bonehound",
    kind: ENEMY_KIND.flanker,
    sprite: "enemy.bonehound",
    health: 30,
    damage: 7,
    speed: 66,
    radius: 7,
    xp: 4,
    goldChance: 40,
    flags: ENEMY_FLAG.persistent,
  },
  {
    id: "rotswine",
    kind: ENEMY_KIND.charger,
    sprite: "enemy.rotswine",
    health: 70,
    damage: 11,
    speed: 70,
    radius: 10,
    xp: 5,
    goldChance: 70,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.persistent,
  },
  {
    id: "wightling",
    kind: ENEMY_KIND.chaser,
    sprite: "enemy.wightling",
    health: 48,
    damage: 7,
    speed: 40,
    radius: 8,
    xp: 4,
    goldChance: 45,
    flags: 0,
  },
  {
    id: "marrowbeetle",
    kind: ENEMY_KIND.swarmer,
    sprite: "enemy.marrowbeetle",
    health: 9,
    damage: 4,
    speed: 66,
    radius: 5,
    xp: 1,
    goldChance: 10,
    flags: 0,
  },
  {
    id: "nightcap",
    kind: ENEMY_KIND.lurker,
    sprite: "enemy.nightcap",
    health: 90,
    damage: 13,
    speed: 34,
    radius: 9,
    xp: 7,
    goldChance: 120,
    flags: ENEMY_FLAG.heavy,
  },
  {
    id: "bellmaster",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.bellmaster",
    health: 1400,
    damage: 18,
    speed: 32,
    radius: 18,
    xp: 80,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "carrionKing",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.carrionKing",
    health: 2200,
    damage: 20,
    speed: 34,
    radius: 19,
    xp: 110,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "hollowMother",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.hollowMother",
    health: 3000,
    damage: 22,
    speed: 30,
    radius: 20,
    xp: 150,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "ossuaryTitan",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.ossuaryTitan",
    health: 4200,
    damage: 26,
    speed: 26,
    radius: 22,
    xp: 200,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "dirgeWarden",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.dirgeWarden",
    health: 5600,
    damage: 28,
    speed: 32,
    radius: 21,
    xp: 260,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "plagueChoir",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.plagueChoir",
    health: 7200,
    damage: 30,
    speed: 34,
    radius: 20,
    xp: 330,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "graveTyrant",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.graveTyrant",
    health: 9000,
    damage: 34,
    speed: 30,
    radius: 24,
    xp: 420,
    goldChance: 1000,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
  {
    id: "nightreaper",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.gravewarden",
    health: 900,
    damage: 9999,
    speed: 36,
    radius: 18,
    xp: 0,
    goldChance: 0,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
];
export const ENEMY_TYPE_BY_ID: ReadonlyMap<string, number> = new Map(
  ENEMY_TYPES.map((t, i) => [t.id, i]),
);
export const ENEMY_CELL_SIZE = 24;
export const SEPARATION_NEIGHBOURS = 6;
export const SEPARATION_STRENGTH = 0.55;
export const KNOCKBACK_TICKS = 8;
export const CULL_DISTANCE = 900;
const TICK_SECONDS = 1 / 60;
export class EnemyStore {
  readonly pool: EntityPool;
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly pushX: Float32Array;
  readonly pushY: Float32Array;
  readonly health: Float32Array;
  readonly maxHealth: Float32Array;
  readonly radius: Float32Array;
  readonly speed: Float32Array;
  readonly damage: Float32Array;
  readonly typeIndex: Int32Array;
  readonly flags: Int32Array;
  readonly knockTicks: Int32Array;
  readonly target: Int32Array;
  readonly age: Int32Array;
  readonly facing: Int32Array;
  readonly grid: SpatialHash;
  private readonly neighbours: Int32Array;
  readonly neighbourScratch: Int32Array;
  kills = 0;
  culled = 0;
  constructor(capacity: number = POOL_BUDGETS.enemies) {
    this.capacity = capacity;
    this.pool = new EntityPool(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.pushX = new Float32Array(capacity);
    this.pushY = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.maxHealth = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.typeIndex = new Int32Array(capacity);
    this.flags = new Int32Array(capacity);
    this.knockTicks = new Int32Array(capacity);
    this.target = new Int32Array(capacity);
    this.age = new Int32Array(capacity);
    this.facing = new Int32Array(capacity);
    this.grid = new SpatialHash(ENEMY_CELL_SIZE, capacity);
    this.neighbours = new Int32Array(64);
    this.neighbourScratch = new Int32Array(64);
  }
  queryNear(x: number, y: number, radius: number): number {
    return this.grid.queryRadiusInto(x, y, radius, this.neighbourScratch);
  }
  get count(): number {
    return this.pool.count;
  }
  get slots(): Int32Array {
    return this.pool.slots;
  }
  spawn(typeIndex: number, x: number, y: number, stats: Stats): Handle {
    const handle = this.pool.alloc();
    if (handle === NULL_HANDLE) return NULL_HANDLE;
    const slot = handle & 0xffff;
    const type = ENEMY_TYPES[typeIndex];
    const curse = stats.get(STAT.curse);
    const hp = Math.max(
      1,
      Math.trunc((((type.health * stats.get(STAT.enemyHealth)) / STAT_SCALE) * curse) / STAT_SCALE),
    );
    this.x[slot] = x;
    this.y[slot] = y;
    this.vx[slot] = 0;
    this.vy[slot] = 0;
    this.pushX[slot] = 0;
    this.pushY[slot] = 0;
    this.health[slot] = hp;
    this.maxHealth[slot] = hp;
    this.radius[slot] = type.radius;
    this.speed[slot] = type.speed * (curse / STAT_SCALE);
    this.damage[slot] = (type.damage * stats.get(STAT.enemyDamage)) / STAT_SCALE;
    this.typeIndex[slot] = typeIndex;
    this.flags[slot] = type.flags;
    this.knockTicks[slot] = 0;
    this.target[slot] = 0;
    this.age[slot] = 0;
    this.facing[slot] = 0;
    return handle;
  }
  kill(slot: number): void {
    this.pool.freeSlot(slot);
    this.kills++;
  }
  damageAt(slot: number, amount: number): boolean {
    if (!this.pool.isSlotAlive(slot)) return false;
    this.health[slot] -= amount;
    if (this.health[slot] <= 0) {
      this.kill(slot);
      return true;
    }
    return false;
  }
  knockback(slot: number, dx: number, dy: number, force: number): void {
    if ((this.flags[slot] & ENEMY_FLAG.heavy) !== 0) return;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) return;
    this.vx[slot] = (dx / len) * force;
    this.vy[slot] = (dy / len) * force;
    this.knockTicks[slot] = KNOCKBACK_TICKS;
    this.flags[slot] |= ENEMY_FLAG.knocked;
  }
  clear(): void {
    this.pool.clear();
    this.kills = 0;
    this.culled = 0;
  }
  rebuildGrid(): void {
    const grid = this.grid;
    const slots = this.pool.slots;
    const n = this.pool.count;
    grid.beginFrame();
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      grid.insert(s, this.x[s], this.y[s]);
    }
    grid.build();
  }
  update(playerX: Float32Array, playerY: Float32Array, playerCount: number, stats: Stats): void {
    const slots = this.pool.slots;
    const n = this.pool.count;
    if (n === 0) return;
    const dt = TICK_SECONDS;
    const knockDrag = 0.82;
    const speedScale = stats.get(STAT.enemySpeed) / STAT_SCALE;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      this.age[s]++;
      if (this.knockTicks[s] > 0) {
        this.knockTicks[s]--;
        this.vx[s] *= knockDrag;
        this.vy[s] *= knockDrag;
        if (this.knockTicks[s] === 0) this.flags[s] &= ~ENEMY_FLAG.knocked;
        continue;
      }
      let bestIdx = 0;
      let bestDistSq = Infinity;
      for (let p = 0; p < playerCount; p++) {
        const dx = playerX[p] - this.x[s];
        const dy = playerY[p] - this.y[s];
        const d = dx * dx + dy * dy;
        if (d < bestDistSq) {
          bestDistSq = d;
          bestIdx = p;
        }
      }
      this.target[s] = bestIdx;
      const dx = playerX[bestIdx] - this.x[s];
      const dy = playerY[bestIdx] - this.y[s];
      const dist = Math.sqrt(bestDistSq) || 1;
      const speed = this.speed[s] * speedScale;
      switch (ENEMY_TYPES[this.typeIndex[s]].kind) {
        case ENEMY_KIND.circler: {
          const ring = 110;
          const radial = dist > ring ? 1 : -1;
          const tangentX = -dy / dist;
          const tangentY = dx / dist;
          this.vx[s] = ((dx / dist) * radial * 0.6 + tangentX * 0.8) * speed;
          this.vy[s] = ((dy / dist) * radial * 0.6 + tangentY * 0.8) * speed;
          break;
        }
        case ENEMY_KIND.weaver: {
          const phase = this.age[s] % WEAVER_PERIOD;
          const half = WEAVER_PERIOD / 2;
          const sway = (phase < half ? phase : WEAVER_PERIOD - phase) / half * 2 - 1;
          const tangentX = -dy / dist;
          const tangentY = dx / dist;
          this.vx[s] = ((dx / dist) * 0.65 + tangentX * sway * 1.05) * speed;
          this.vy[s] = ((dy / dist) * 0.65 + tangentY * sway * 1.05) * speed;
          break;
        }
        case ENEMY_KIND.lurker: {
          if (dist > LURKER_WAKE) {
            this.vx[s] = 0;
            this.vy[s] = 0;
            break;
          }
          this.vx[s] = (dx / dist) * speed;
          this.vy[s] = (dy / dist) * speed;
          break;
        }
        case ENEMY_KIND.flanker: {
          if (this.age[s] < FLANKER_CIRCLE_TICKS) {
            const radial = dist > FLANKER_RING ? 1 : -1;
            const tangentX = -dy / dist;
            const tangentY = dx / dist;
            this.vx[s] = ((dx / dist) * radial * 0.5 + tangentX * 0.9) * speed;
            this.vy[s] = ((dy / dist) * radial * 0.5 + tangentY * 0.9) * speed;
            break;
          }
          this.vx[s] = (dx / dist) * speed;
          this.vy[s] = (dy / dist) * speed;
          break;
        }
        case ENEMY_KIND.charger: {
          if (this.vx[s] === 0 && this.vy[s] === 0) {
            this.vx[s] = (dx / dist) * speed;
            this.vy[s] = (dy / dist) * speed;
          }
          break;
        }
        default: {
          this.vx[s] = (dx / dist) * speed;
          this.vy[s] = (dy / dist) * speed;
          break;
        }
      }
      this.facing[s] =
        Math.abs(this.vx[s]) > Math.abs(this.vy[s])
          ? this.vx[s] < 0
            ? 1
            : 3
          : this.vy[s] < 0
            ? 2
            : 0;
    }
    this.pushX.fill(0, 0, this.capacity);
    this.pushY.fill(0, 0, this.capacity);
    const near = this.neighbours;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if ((this.flags[s] & ENEMY_FLAG.phasing) !== 0) continue;
      const found = this.grid.queryInto(this.x[s], this.y[s], near);
      let resolved = 0;
      for (let k = 0; k < found && resolved < SEPARATION_NEIGHBOURS; k++) {
        const o = near[k];
        if (o === s) continue;
        if ((this.flags[o] & ENEMY_FLAG.phasing) !== 0) continue;
        const dx = this.x[s] - this.x[o];
        const dy = this.y[s] - this.y[o];
        const minDist = this.radius[s] + this.radius[o];
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue;
        resolved++;
        const dist = Math.sqrt(distSq);
        if (dist < 0.0001) {
          const brad = (s * 2654435761) % BRAD_FULL;
          this.pushX[s] += fxCosF(brad) * minDist * SEPARATION_STRENGTH;
          this.pushY[s] += fxSinF(brad) * minDist * SEPARATION_STRENGTH;
          continue;
        }
        const overlap = (minDist - dist) * SEPARATION_STRENGTH;
        this.pushX[s] += (dx / dist) * overlap;
        this.pushY[s] += (dy / dist) * overlap;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const s = slots[i];
      this.x[s] += this.vx[s] * dt + this.pushX[s];
      this.y[s] += this.vy[s] * dt + this.pushY[s];
      if ((this.flags[s] & ENEMY_FLAG.persistent) !== 0) continue;
      let nearestSq = Infinity;
      for (let p = 0; p < playerCount; p++) {
        const dx = playerX[p] - this.x[s];
        const dy = playerY[p] - this.y[s];
        const d = dx * dx + dy * dy;
        if (d < nearestSq) nearestSq = d;
      }
      if (nearestSq > CULL_DISTANCE * CULL_DISTANCE) {
        this.pool.freeSlot(s);
        this.culled++;
      }
    }
  }
  bossCount(): number {
    const slots = this.pool.slots;
    let n = 0;
    for (let i = 0; i < this.pool.count; i++) {
      if ((this.flags[slots[i]] & ENEMY_FLAG.boss) !== 0) n++;
    }
    return n;
  }
}
