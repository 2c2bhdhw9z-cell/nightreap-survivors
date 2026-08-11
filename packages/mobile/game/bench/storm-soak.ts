/**
 * Headless soak for QuadStorm — no GL, no React.
 *
 * Exists because "the sprites froze about 35 seconds in" is not something you debug by staring at a
 * phone. 35s at 60Hz is ~2,100 ticks; this runs 200,000 and reports the first tick at which the
 * population stops moving, plus any NaN or out-of-field escape. Run with:
 *   bun game/bench/storm-soak.ts
 */

import { QuadStorm } from "./quad-storm";
import type { Atlas, Frame } from "../render/atlas";

const frame = (name: string): Frame =>
  ({
    name,
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    w: 16,
    h: 16,
    ox: 8,
    oy: 8,
  }) as unknown as Frame;

const fakeAtlas = { need: (name: string) => frame(name) } as unknown as Atlas;

// Reached through globalThis because this file lives under `game/`, which is typed for the React
// Native runtime where `process` has no `argv`. It only ever runs under Bun.
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const TICKS = Number(argv[2] ?? 200_000);
const COUNT = Number(argv[3] ?? 5000);
const FIELD_W = 264;
const FIELD_H = 573;

const storm = new QuadStorm(fakeAtlas, 12000);
storm.setField(FIELD_W, FIELD_H);
storm.setCount(COUNT);

// Reach into the private typed arrays; this is a diagnostic, not production code.
const s = storm as unknown as {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  angle: Uint8Array;
};

const checksum = (): number => {
  let acc = 0;
  for (let i = 0; i < COUNT; i++) acc = (acc + s.x[i] * 1000 + s.y[i] * 7) % 1e9;
  return acc;
};

let prev = checksum();
let identicalRun = 0;
let firstFreeze = -1;
let firstNaN = -1;
let firstEscape = -1;
let stuckCount = 0;

for (let t = 1; t <= TICKS; t++) {
  storm.tick();

  if (firstNaN < 0) {
    for (let i = 0; i < COUNT; i++) {
      if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) {
        firstNaN = t;
        console.log(`NaN at tick ${t}, entity ${i}: x=${s.x[i]} y=${s.y[i]}`);
        break;
      }
    }
  }

  if (firstEscape < 0) {
    for (let i = 0; i < COUNT; i++) {
      if (s.x[i] < -1 || s.x[i] > FIELD_W + 1 || s.y[i] < -1 || s.y[i] > FIELD_H + 1) {
        firstEscape = t;
        console.log(
          `escaped field at tick ${t}, entity ${i}: x=${s.x[i]} y=${s.y[i]} vx=${s.vx[i]} vy=${s.vy[i]}`,
        );
        break;
      }
    }
  }

  const now = checksum();
  if (now === prev) {
    identicalRun++;
    if (identicalRun >= 3 && firstFreeze < 0) firstFreeze = t;
  } else {
    identicalRun = 0;
  }
  prev = now;
}

// How many entities are individually not moving at the end?
const beforeX = Float32Array.from(s.x);
const beforeY = Float32Array.from(s.y);
storm.tick();
for (let i = 0; i < COUNT; i++) {
  if (s.x[i] === beforeX[i] && s.y[i] === beforeY[i]) stuckCount++;
}

console.log(
  JSON.stringify(
    {
      ticks: TICKS,
      count: COUNT,
      field: [FIELD_W, FIELD_H],
      firstFreezeTick: firstFreeze,
      firstNaNTick: firstNaN,
      firstEscapeTick: firstEscape,
      stuckEntitiesAtEnd: stuckCount,
      sample: {
        x0: s.x[0],
        y0: s.y[0],
        vx0: s.vx[0],
        vy0: s.vy[0],
        angle0: s.angle[0],
      },
    },
    null,
    2,
  ),
);
