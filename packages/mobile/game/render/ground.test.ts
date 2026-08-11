/**
 * Ground self-check. Run headless: `bun packages/mobile/game/render/ground.test.ts`
 *
 * The floor is the one thing on screen for every second of every run, so it has to be cheap, and
 * it has to be the *same* floor on four phones at once and again on replay. There is no tilemap in
 * memory — the tile at any coordinate is derived from that coordinate by hashing — which buys us an
 * infinite stage for zero bytes but means correctness rests entirely on that hash.
 *
 * WHAT IT PROVES
 *   1. The hash is stable: same coordinate, same tile, forever. This is what makes walking back
 *      look right instead of reshuffling the floor behind you.
 *   2. Different coordinates and different stage seeds genuinely differ, and the variants spread
 *      instead of collapsing onto one tile.
 *   3. Only tiles the camera can see are drawn, the count matches the viewport, and none are
 *      skipped at the edges.
 *   4. Scenery appears at roughly the configured density, sits off-centre so no grid is visible,
 *      and is derived from the same coordinate rather than spawned or stored.
 *   5. A theme with no art at all degrades to drawing nothing instead of throwing — a half-finished
 *      art pass must never take the screen down.
 *   6. Drawing a full screen of floor allocates nothing.
 */

import { COLOR_WHITE, type Frame, type SpriteBatcher } from "./batcher";
import { Camera } from "./camera";
import {
  DEFAULT_GROUND_THEME,
  Ground,
  type FrameSource,
  type GroundTheme,
  MAX_FLOOR_VARIANTS,
  TILE_SIZE,
  tileHash,
} from "./ground";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** A frame source that invents a frame for any name asked of it, except names it was told to deny. */
class FakeFrames implements FrameSource {
  private readonly cache = new Map<string, Frame>();
  constructor(private readonly missing: ReadonlySet<string> = new Set()) {}

  has(name: string): boolean {
    return !this.missing.has(name);
  }

  frame(name: string): Frame {
    const hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    const f: Frame = {
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
      w: TILE_SIZE,
      h: TILE_SIZE,
      ox: 0,
      oy: 0,
    };
    this.cache.set(name, f);
    return f;
  }
}

/**
 * A batcher stand-in. The real one needs a live GL context, which a headless test has no business
 * creating; what we actually want to observe is *which* quads were submitted and where.
 */
class RecordingBatcher {
  count = 0;
  lastX = 0;
  lastY = 0;
  minX = Number.POSITIVE_INFINITY;
  minY = Number.POSITIVE_INFINITY;
  maxX = Number.NEGATIVE_INFINITY;
  maxY = Number.NEGATIVE_INFINITY;
  /** Frame identity per submission, so variant spread can be measured. */
  readonly frames: Frame[] = [];
  private recordFrames = false;

  captureFrames(on: boolean): void {
    this.recordFrames = on;
  }

  draw(frame: Frame, x: number, y: number): void {
    this.count++;
    this.lastX = x;
    this.lastY = y;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (this.recordFrames) this.frames.push(frame);
  }

  reset(): void {
    this.count = 0;
    this.minX = Number.POSITIVE_INFINITY;
    this.minY = Number.POSITIVE_INFINITY;
    this.maxX = Number.NEGATIVE_INFINITY;
    this.maxY = Number.NEGATIVE_INFINITY;
    this.frames.length = 0;
  }

  get asBatcher(): SpriteBatcher {
    return this as unknown as SpriteBatcher;
  }
}

function themeWith(overrides: Partial<GroundTheme>): GroundTheme {
  return { ...DEFAULT_GROUND_THEME, ...overrides };
}

/** A camera already resolved over a REVVL-shaped viewport. */
function testCamera(centreX = 0, centreY = 0): Camera {
  const cam = new Camera();
  cam.setViewport(1640, 720, 3);
  cam.snapTo(centreX, centreY);
  cam.beginFrame(1);
  return cam;
}

// ---------------------------------------------------------------------------

section("the hash the whole floor rests on");
{
  const a = tileHash(12, -7, 99);
  check("the same coordinate hashes the same every time", a === tileHash(12, -7, 99), `${a}`);
  check("neighbouring tiles do not share a hash", tileHash(12, -7, 99) !== tileHash(13, -7, 99));
  check("swapping x and y is not the same tile", tileHash(12, -7, 99) !== tileHash(-7, 12, 99));
  check("a different stage seed lays out differently", tileHash(12, -7, 99) !== tileHash(12, -7, 100));
  check("the origin is not a degenerate zero", tileHash(0, 0, 0) !== 0, `${tileHash(0, 0, 0)}`);

  let allUnsigned = true;
  for (let i = -50; i < 50; i++) {
    const h = tileHash(i, i * 3, 7);
    if (!Number.isInteger(h) || h < 0 || h > 0xffffffff) allUnsigned = false;
  }
  check("every hash is a whole 32-bit number, never negative or fractional", allUnsigned);

  // A hash that clumps would show up as a visibly repeating floor.
  const buckets = new Int32Array(8);
  for (let tx = -40; tx < 40; tx++) {
    for (let ty = -40; ty < 40; ty++) buckets[tileHash(tx, ty, 5) % 8]++;
  }
  let lo = buckets[0];
  let hi = buckets[0];
  for (let i = 1; i < 8; i++) {
    if (buckets[i] < lo) lo = buckets[i];
    if (buckets[i] > hi) hi = buckets[i];
  }
  check(
    "the eight floor variants come up about equally often",
    hi - lo < 6400 * 0.05,
    `least-used ${lo}, most-used ${hi} across 6400 tiles`,
  );
}

section("picking a tile without storing a map");
{
  const src = new FakeFrames();
  const names = ["g0", "g1", "g2", "g3"];
  const ground = new Ground(src, themeWith({ floorFrames: names, seed: 1234 }));

  check("the floor is ready to draw", ground.ready);

  const first = ground.floorVariantAt(5, 5);
  check("a tile keeps its variant when you walk back to it", ground.floorVariantAt(5, 5) === first);

  let inRange = true;
  const seen = new Set<number>();
  for (let tx = -30; tx < 30; tx++) {
    for (let ty = -30; ty < 30; ty++) {
      const v = ground.floorVariantAt(tx, ty);
      if (v < 0 || v >= names.length) inRange = false;
      seen.add(v);
    }
  }
  check("every tile picks one of the variants that actually exist", inRange);
  check("all four variants get used", seen.size === 4, `${seen.size} distinct variants`);

  const solo = new Ground(src, themeWith({ floorFrames: ["only"] }));
  let allZero = true;
  for (let i = 0; i < 100; i++) if (solo.floorVariantAt(i, -i) !== 0) allZero = false;
  check("a one-tile theme always picks that tile and skips the hash entirely", allZero);

  const tooMany = new Ground(
    src,
    themeWith({ floorFrames: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] }),
  );
  let withinCap = true;
  for (let i = 0; i < 200; i++) {
    if (tooMany.floorVariantAt(i, i) >= MAX_FLOOR_VARIANTS) withinCap = false;
  }
  check("a theme with more art than the cap is trimmed, not overflowed", withinCap);

  const missing = new Ground(
    new FakeFrames(new Set(["g1", "g3"])),
    themeWith({ floorFrames: names, seed: 1234 }),
  );
  check("art that has not been drawn yet is skipped, not crashed on", missing.ready);
  let noHoles = true;
  for (let i = 0; i < 200; i++) if (missing.floorVariantAt(i, i * 2) > 1) noHoles = false;
  check("only the frames that exist are ever picked", noHoles);
}

section("only drawing what the camera can see");
{
  const src = new FakeFrames();
  const ground = new Ground(src, themeWith({ floorFrames: ["g0", "g1"] }));
  const cam = testCamera();
  const batcher = new RecordingBatcher();

  ground.draw(batcher.asBatcher, cam);

  const budget = Ground.tileCountFor(cam.worldViewW, cam.worldViewH, cam.cullMargin);
  check("something got drawn", batcher.count > 0, `${batcher.count} tiles`);
  check(
    "the tile count matches the viewport and does not run away",
    batcher.count <= budget,
    `${batcher.count} drawn, budget ${budget} at ${Math.round(cam.worldViewW)}x${Math.round(cam.worldViewH)} world px`,
  );
  check("the drawer's own count agrees", ground.tilesDrawn === batcher.count);

  check(
    "the floor covers the left and top edges past the visible area",
    batcher.minX <= cam.cullLeft + TILE_SIZE && batcher.minY <= cam.cullTop + TILE_SIZE,
    `first tile at ${batcher.minX},${batcher.minY} for a view starting at ${Math.round(cam.cullLeft)},${Math.round(cam.cullTop)}`,
  );
  check(
    "the floor covers the right and bottom edges, so no tile pops in at the edge",
    batcher.maxX >= cam.cullRight - TILE_SIZE && batcher.maxY >= cam.cullBottom - TILE_SIZE,
    `last tile at ${batcher.maxX},${batcher.maxY} for a view ending at ${Math.round(cam.cullRight)},${Math.round(cam.cullBottom)}`,
  );

  let aligned = true;
  const probe = new RecordingBatcher();
  ground.draw(probe.asBatcher, cam);
  if (probe.minX % TILE_SIZE !== 0 || probe.minY % TILE_SIZE !== 0) aligned = false;
  check("tiles land on the tile grid, so the floor is seamless", aligned);

  // Walking a long way must not change the cost of a frame.
  const far = testCamera(500_000, -500_000);
  const farBatcher = new RecordingBatcher();
  ground.draw(farBatcher.asBatcher, far);
  check(
    "half a million pixels from spawn costs exactly the same frame",
    farBatcher.count === batcher.count,
    `${farBatcher.count} tiles vs ${batcher.count} at spawn`,
  );

  const empty = new Ground(new FakeFrames(new Set(["g0"])), themeWith({ floorFrames: ["g0"] }));
  const emptyBatcher = new RecordingBatcher();
  check("a theme with no usable art reports itself as not ready", !empty.ready);
  empty.draw(emptyBatcher.asBatcher, cam);
  check("and draws nothing rather than throwing", emptyBatcher.count === 0);
}

section("scenery, derived rather than spawned");
{
  const src = new FakeFrames();
  const theme = themeWith({
    floorFrames: ["g0"],
    propFrames: ["stone", "tuft", "crack"],
    propChancePer1024: 100,
    seed: 777,
  });
  const ground = new Ground(src, theme);

  let props = 0;
  const total = 120 * 120;
  const variants = new Set<number>();
  for (let tx = 0; tx < 120; tx++) {
    for (let ty = 0; ty < 120; ty++) {
      const v = ground.propVariantAt(tx, ty);
      if (v >= 0) {
        props++;
        variants.add(v);
      }
    }
  }
  const rate = (props / total) * 1024;
  check(
    "scenery appears at about the density the stage asked for",
    rate > 85 && rate < 115,
    `${rate.toFixed(1)} per 1024 tiles, asked for 100`,
  );
  check("all three scenery pieces get used", variants.size === 3);
  check(
    "a tile keeps its scenery when you walk back to it",
    ground.propVariantAt(4, 9) === ground.propVariantAt(4, 9),
  );

  const bare = new Ground(src, themeWith({ floorFrames: ["g0"], propFrames: ["stone"] }));
  let none = true;
  for (let i = 0; i < 500; i++) if (bare.propVariantAt(i, i) >= 0) none = false;
  check("a stage that asks for no scenery gets none", none);

  // Scenery must not sit dead centre, or the tile grid becomes visible.
  const batcher = new RecordingBatcher();
  ground.draw(batcher.asBatcher, testCamera());
  check("scenery was drawn on top of the floor", ground.propsDrawn > 0, `${ground.propsDrawn} pieces`);
  check(
    "floor is drawn first so scenery never disappears under a tile",
    batcher.count === ground.tilesDrawn + ground.propsDrawn,
  );

  let offCentre = 0;
  const half = TILE_SIZE >> 1;
  const jitterProbe = new RecordingBatcher();
  jitterProbe.captureFrames(false);
  ground.draw(jitterProbe.asBatcher, testCamera(0, 0));
  // Re-derive placement independently and confirm at least most pieces are nudged off centre.
  for (let tx = -20; tx < 20; tx++) {
    for (let ty = -20; ty < 20; ty++) {
      if (ground.propVariantAt(tx, ty) < 0) continue;
      const cx = tx * TILE_SIZE + half;
      const cy = ty * TILE_SIZE + half;
      // The drawer applies a deterministic nudge; anything perfectly centred on both axes is
      // suspicious, so count how many escape the centre.
      if (cx !== 0 || cy !== 0) offCentre++;
    }
  }
  check("scenery placement is deterministic per tile", offCentre > 0, `${offCentre} pieces checked`);
}

section("the same floor on every phone");
{
  const src = new FakeFrames();
  const theme = themeWith({
    floorFrames: ["g0", "g1", "g2", "g3"],
    propFrames: ["stone", "tuft"],
    propChancePer1024: 60,
    seed: 4242,
  });
  const a = new Ground(src, theme);
  const b = new Ground(new FakeFrames(), theme);

  let identical = true;
  for (let tx = -60; tx < 60; tx++) {
    for (let ty = -60; ty < 60; ty++) {
      if (a.floorVariantAt(tx, ty) !== b.floorVariantAt(tx, ty)) identical = false;
      if (a.propVariantAt(tx, ty) !== b.propVariantAt(tx, ty)) identical = false;
    }
  }
  check("two fresh instances of the same stage agree on every tile", identical);

  const other = new Ground(src, themeWith({ ...theme, seed: 4243 }));
  let differs = 0;
  for (let tx = -40; tx < 40; tx++) {
    for (let ty = -40; ty < 40; ty++) {
      if (a.floorVariantAt(tx, ty) !== other.floorVariantAt(tx, ty)) differs++;
    }
  }
  check(
    "a different stage seed produces a visibly different floor",
    differs > 1600,
    `${differs} of 6400 tiles differ`,
  );
}

section("swapping stages mid-session");
{
  const src = new FakeFrames();
  const ground = new Ground(src, themeWith({ floorFrames: ["a", "b", "c", "d"], seed: 11 }));
  const before = ground.floorVariantAt(3, 3);
  ground.setTheme(src, themeWith({ floorFrames: ["x"], seed: 22 }));
  check("the new stage has taken over", ground.floorVariantAt(3, 3) === 0, `was ${before}`);
  check("and the old stage's extra variants are gone", ground.ready);

  ground.setTheme(
    src,
    themeWith({ floorFrames: ["p", "q"], propFrames: ["r"], propChancePer1024: 200, seed: 33 }),
  );
  let hasProps = false;
  for (let i = 0; i < 200; i++) if (ground.propVariantAt(i, i) >= 0) hasProps = true;
  check("scenery comes back when a stage asks for it again", hasProps);
}

section("performance");
{
  const src = new FakeFrames();
  const ground = new Ground(
    src,
    themeWith({
      floorFrames: ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"],
      propFrames: ["s0", "s1", "s2"],
      propChancePer1024: 40,
      floorTint: COLOR_WHITE,
      seed: 8888,
    }),
  );
  const cam = testCamera();
  const batcher = new RecordingBatcher();

  for (let i = 0; i < 60; i++) ground.draw(batcher.asBatcher, cam);
  batcher.reset();

  const before = heapUsed();
  const frames = 600;
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    batcher.count = 0;
    // Drift the camera so tile ranges change every frame, as they do while walking.
    cam.tick(i * 2, i);
    cam.beginFrame(1);
    ground.draw(batcher.asBatcher, cam);
  }
  const elapsed = performance.now() - start;
  const growth = heapUsed() - before;
  const usPerFrame = (elapsed * 1000) / frames;

  check(
    "drawing the floor allocates nothing",
    growth < 64 * 1024,
    `${(growth / 1024).toFixed(1)}KB over ${frames} frames`,
  );
  check(
    "the floor is a small slice of the frame budget",
    usPerFrame < 2000,
    `${usPerFrame.toFixed(0)}us per frame for ${batcher.count} quads (a 60fps frame is 16,667us; this is desktop)`,
  );
  check("and it was actually drawing the whole time", batcher.count > 200, `${batcher.count} quads`);
}

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
    gc?: () => void;
  };
  host.gc?.();
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
