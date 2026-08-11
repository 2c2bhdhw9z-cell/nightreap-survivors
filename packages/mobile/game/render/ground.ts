/**
 * Ground — the endless floor the whole run walks across.
 *
 * WHAT THE PLAYER SEES
 * A seamless, slightly varied floor that scrolls under them forever, with scattered scenery
 * (gravestones, tufts, cracks) so movement reads as movement. Walk in one direction for an hour
 * and it never repeats in an obvious grid and never runs out.
 *
 * HOW IT WORKS, AND WHY THIS WAY
 *  - There is no tilemap in memory. A stage of infinite size cannot be stored, so the tile at any
 *    coordinate is *derived* from its coordinate by hashing. Same coordinate always hashes to the
 *    same tile, so the floor is stable when you walk back, identical on every player's screen in
 *    co-op, and identical on replay — with zero bytes of level data.
 *  - We only ever touch tiles inside the camera's cull rect. At scale 3 on a 1640x720 phone that
 *    is roughly 250 tiles, not the millions a real map would imply.
 *  - Scenery is derived the same way, from a second hash of the same tile, so props never need
 *    storing or spawning either. Scenery is decoration only: it never collides and never enters
 *    the simulation, so it cannot desync co-op or change a replay.
 *
 * ZERO ALLOCATION
 * Integer hashing, field reads, one loop. No arrays built per frame, no closures, no `new`.
 * The variant tables are frame references resolved once at construction.
 */

import type { Frame } from "./batcher";
import type { SpriteBatcher } from "./batcher";
import { COLOR_WHITE, type PackedColor } from "./batcher";
import type { Camera } from "./camera";

/** World-pixel size of one floor tile. Matches the art grid; do not change without new art. */
export const TILE_SIZE = 32;

/** How many distinct floor tiles a stage theme provides. */
export const MAX_FLOOR_VARIANTS = 8;

/** How many distinct scenery pieces a stage theme provides. */
export const MAX_PROP_VARIANTS = 8;

/**
 * Deterministic 32-bit hash of a tile coordinate plus a salt.
 *
 * Integer-only on purpose. Any floating-point or transcendental step here would risk differing in
 * its last bits across devices, and the floor is drawn from this on every player's phone.
 *
 * The non-zero starting constant is not decoration. Without it, tile (0,0) with seed 0 multiplies
 * out to exactly zero and stays there through every mixing step — meaning the tile the player spawns
 * on, in every run of every stage, would always be the same one. A self-test caught it.
 */
export function tileHash(tx: number, ty: number, salt: number): number {
  let h = (0x9e3779b9 ^ ((tx | 0) * 0x27d4eb2d)) | 0;
  h = (h ^ ((ty | 0) * 0x165667b1)) | 0;
  h = (h ^ (salt | 0)) | 0;
  h ^= h >>> 15;
  h = (h * 0x2545f491) | 0;
  h ^= h >>> 13;
  h = (h * 0x27d4eb2d) | 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Look of one stage's floor. Pure data — stages are content, not code. */
export interface GroundTheme {
  /** Stage salt. Two stages with the same art still lay out differently. */
  readonly seed: number;
  /** Floor tile frame names, in the atlas. 1 to MAX_FLOOR_VARIANTS. */
  readonly floorFrames: readonly string[];
  /** Scenery frame names. May be empty for a bare arena. */
  readonly propFrames: readonly string[];
  /**
   * Chance in 1024 that any given tile carries a prop. 24 reads as sparse scattering; above ~200
   * the floor starts to look like clutter and costs draw calls for nothing.
   */
  readonly propChancePer1024: number;
  /** Tint applied to floor tiles. Lets one grey tile set dress several stages. */
  readonly floorTint: PackedColor;
  /** Tint applied to scenery. */
  readonly propTint: PackedColor;
}

export const DEFAULT_GROUND_THEME: GroundTheme = {
  seed: 0x1a2b3c,
  floorFrames: ["ground"],
  propFrames: [],
  propChancePer1024: 0,
  floorTint: COLOR_WHITE,
  propTint: COLOR_WHITE,
};

/** Resolved-frame lookup, so the drawer never does string work in a frame. */
export interface FrameSource {
  frame(name: string): Frame;
  has(name: string): boolean;
}

/**
 * Draws the floor and its scenery for whatever the camera can currently see.
 *
 * One instance per stage. `setTheme` swaps stages without reallocating.
 */
export class Ground {
  /** Frames resolved at theme time. Fixed-length so swapping a theme allocates nothing. */
  private readonly floor: (Frame | null)[] = Array.from<Frame | null>({
    length: MAX_FLOOR_VARIANTS,
  }).fill(null);
  private readonly props: (Frame | null)[] = Array.from<Frame | null>({
    length: MAX_PROP_VARIANTS,
  }).fill(null);

  private floorCount = 0;
  private propCount = 0;
  private seed = 0;
  private propChance = 0;
  private floorTint: PackedColor = COLOR_WHITE;
  private propTint: PackedColor = COLOR_WHITE;

  /** Diagnostics for the bench readout. */
  tilesDrawn = 0;
  propsDrawn = 0;

  constructor(source: FrameSource, theme: GroundTheme = DEFAULT_GROUND_THEME) {
    this.setTheme(source, theme);
  }

  /**
   * Point the ground at a stage theme. Missing frames are skipped rather than thrown on, so a
   * half-finished art pass still renders something walkable instead of a black screen.
   */
  setTheme(source: FrameSource, theme: GroundTheme): void {
    this.seed = theme.seed | 0;
    this.propChance = clampChance(theme.propChancePer1024);
    this.floorTint = theme.floorTint;
    this.propTint = theme.propTint;

    this.floorCount = 0;
    for (let i = 0; i < theme.floorFrames.length && this.floorCount < MAX_FLOOR_VARIANTS; i++) {
      const name = theme.floorFrames[i];
      if (!source.has(name)) continue;
      this.floor[this.floorCount] = source.frame(name);
      this.floorCount++;
    }
    for (let i = this.floorCount; i < MAX_FLOOR_VARIANTS; i++) this.floor[i] = null;

    this.propCount = 0;
    for (let i = 0; i < theme.propFrames.length && this.propCount < MAX_PROP_VARIANTS; i++) {
      const name = theme.propFrames[i];
      if (!source.has(name)) continue;
      this.props[this.propCount] = source.frame(name);
      this.propCount++;
    }
    for (let i = this.propCount; i < MAX_PROP_VARIANTS; i++) this.props[i] = null;
  }

  /** True when there is at least one floor tile to draw with. */
  get ready(): boolean {
    return this.floorCount > 0;
  }

  /**
   * Which floor variant sits at a tile. Exposed so tests and the dev menu can ask without
   * rendering, and so co-op desync checks can compare a coordinate directly.
   */
  floorVariantAt(tx: number, ty: number): number {
    if (this.floorCount <= 1) return 0;
    return tileHash(tx, ty, this.seed) % this.floorCount;
  }

  /** Which scenery piece sits at a tile, or -1 for bare floor. */
  propVariantAt(tx: number, ty: number): number {
    if (this.propCount === 0 || this.propChance === 0) return -1;
    const h = tileHash(tx, ty, this.seed ^ 0x5bf03635);
    if (h % 1024 >= this.propChance) return -1;
    return (h >>> 10) % this.propCount;
  }

  /**
   * Sub-tile offset for a prop, so scenery does not sit dead-centre in a visible grid. Returns
   * world pixels in the range -TILE_SIZE/4 .. TILE_SIZE/4.
   */
  private propJitter(tx: number, ty: number, axis: number): number {
    const h = tileHash(tx, ty, (this.seed ^ 0x1b873593) + axis);
    return ((h % (TILE_SIZE >> 1)) | 0) - (TILE_SIZE >> 2);
  }

  /**
   * Draw every visible tile. Call with the batcher already bound to the `background` layer and the
   * camera already resolved for this frame.
   */
  draw(batcher: SpriteBatcher, camera: Camera): void {
    this.tilesDrawn = 0;
    this.propsDrawn = 0;
    if (this.floorCount === 0) return;

    // The cull rect already carries a margin, so tiles never pop in at the edge.
    const x0 = Math.floor(camera.cullLeft / TILE_SIZE);
    const y0 = Math.floor(camera.cullTop / TILE_SIZE);
    const x1 = Math.floor(camera.cullRight / TILE_SIZE);
    const y1 = Math.floor(camera.cullBottom / TILE_SIZE);

    const floorTint = this.floorTint;
    const single = this.floorCount === 1 ? this.floor[0] : null;

    for (let ty = y0; ty <= y1; ty++) {
      const wy = ty * TILE_SIZE;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = tx * TILE_SIZE;
        const frame = single ?? this.floor[this.floorVariantAt(tx, ty)];
        if (frame === null) continue;
        batcher.draw(frame, wx, wy, floorTint);
        this.tilesDrawn++;
      }
    }

    if (this.propCount === 0 || this.propChance === 0) return;

    // Second pass so all scenery sorts above all floor without a per-tile draw-order dance.
    const propTint = this.propTint;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const v = this.propVariantAt(tx, ty);
        if (v < 0) continue;
        const frame = this.props[v];
        if (frame === null) continue;
        const wx = tx * TILE_SIZE + (TILE_SIZE >> 1) + this.propJitter(tx, ty, 0);
        const wy = ty * TILE_SIZE + (TILE_SIZE >> 1) + this.propJitter(tx, ty, 1);
        batcher.draw(frame, wx, wy, propTint);
        this.propsDrawn++;
      }
    }
  }

  /** How many tiles a viewport of this size will submit. For budgeting, not for drawing. */
  static tileCountFor(worldViewW: number, worldViewH: number, cullMargin: number): number {
    const w = Math.ceil((worldViewW + cullMargin * 2) / TILE_SIZE) + 1;
    const h = Math.ceil((worldViewH + cullMargin * 2) / TILE_SIZE) + 1;
    return w * h;
  }
}

function clampChance(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 1024 ? 1024 : n;
}
