/**
 * Headless soak of the Gate A scene's *simulation* half.
 *
 * WHY: on a real iPhone the storm visibly froze around the 75-90 second mark while the readout
 * panel kept reporting 58.8fps, and the app died outright at ~9m30s. Both symptoms are consistent
 * with the sim, not the GPU, so this drives `QuadStorm.tick()` for well past that point with no GL
 * involved. If positions stop changing or go non-finite here, the bug is arithmetic and has nothing
 * to do with the renderer.
 *
 * Run: bun packages/mobile/game/bench/soak.test.ts
 */

import { QuadStorm } from "./quad-storm";
import type { Atlas, Frame } from "../render/atlas";

function stubFrame(name: string): Frame {
  return {
    name,
    x: 0,
    y: 0,
    w: 16,
    h: 16,
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    ox: 8,
    oy: 8,
  } as unknown as Frame;
}

const atlas = { need: (n: string) => stubFrame(n) } as unknown as Atlas;

const COUNT = 5000;
const TICKS = 60 * 60 * 20; // 20 minutes of sim
const storm = new QuadStorm(atlas, 12000);
// Same field the bench uses at iPhone 17 Pro Max scale (1320x2868 @5x -> 264x574 world units).
storm.setField(264, 574);
storm.setCount(COUNT);

interface Snapshot {
  tick: number;
  moved: number;
  nonFinite: number;
  zeroVel: number;
  outOfField: number;
  maxAbs: number;
}

const anyStorm = storm as unknown as {
  x: Float32Array;
  y: Float32Array;
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
};

function snapshot(tick: number): Snapshot {
  let moved = 0;
  let nonFinite = 0;
  let zeroVel = 0;
  let outOfField = 0;
  let maxAbs = 0;
  for (let i = 0; i < COUNT; i++) {
    const x = anyStorm.x[i];
    const y = anyStorm.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) nonFinite++;
    if (x !== anyStorm.px[i] || y !== anyStorm.py[i]) moved++;
    if (anyStorm.vx[i] === 0 && anyStorm.vy[i] === 0) zeroVel++;
    if (x < 0 || x > 264 || y < 0 || y > 574) outOfField++;
    const a = Math.max(Math.abs(x), Math.abs(y));
    if (a > maxAbs) maxAbs = a;
  }
  return { tick, moved, nonFinite, zeroVel, outOfField, maxAbs };
}

const rows: Snapshot[] = [];
// Typed locally: this file runs under Bun, but the package's tsconfig targets React Native, where
// Node's `process` shape is not declared.
const proc = process as unknown as { memoryUsage(): { heapUsed: number } };
const startHeap = proc.memoryUsage().heapUsed;
const t0 = performance.now();
for (let t = 1; t <= TICKS; t++) {
  storm.tick();
  if (t % 900 === 0 || t === 1) rows.push(snapshot(t));
}
const elapsed = performance.now() - t0;
const heapGrowth = proc.memoryUsage().heapUsed - startHeap;

let firstBad = -1;
for (const r of rows) {
  const bad = r.moved < COUNT || r.nonFinite > 0 || r.outOfField > 0;
  if (bad && firstBad < 0) firstBad = r.tick;
}

for (const r of rows) {
  if (r.tick <= 5400 || r.moved < COUNT || r.nonFinite > 0 || r.outOfField > 0 || r.tick === TICKS) {
    console.log(
      `t=${String(r.tick).padStart(6)} (${(r.tick / 60).toFixed(0)}s)  moving=${r.moved}/${COUNT}  nonFinite=${r.nonFinite}  zeroVel=${r.zeroVel}  outside=${r.outOfField}  maxAbs=${r.maxAbs.toFixed(1)}`,
    );
  }
}

console.log(
  `\n${TICKS} ticks in ${elapsed.toFixed(0)}ms (${((elapsed / TICKS) * 1000).toFixed(1)}us/tick)  heapGrowth=${(heapGrowth / 1024).toFixed(0)}KB`,
);
console.log(firstBad < 0 ? "SIM CLEAN — no freeze, no NaN, nothing escaped the field" : `SIM BROKE at tick ${firstBad}`);
