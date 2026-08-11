/**
 * Atlas — every sprite, glyph, and 9-slice frame in one power-of-two texture.
 *
 * One texture is the whole reason the renderer can draw a layer in a single call: a texture swap
 * forces a flush, so the moment art lives in two textures the draw-call count follows the art
 * instead of the layer count. The build pipeline (ImageMagick, Phase 0) packs sheets into
 * `atlas.png` + `atlas.json`; this file only consumes that manifest.
 *
 * NO REACT NATIVE HERE
 * Decoding a PNG is platform work (`expo-asset` on device, `Image` on web), so it lives outside
 * `game/`. The glue calls `createAtlas(gl, texture, w, h, manifest)` with a texture it already
 * uploaded. `createDebugAtlas` exists so the Gate A benchmark can run before any art exists.
 *
 * UV PRECISION
 * UVs are uint16-normalised, i.e. 1/65535 of the texture — roughly 1/32nd of a texel on a 2048px
 * atlas. Frames are inset by half a texel so NEAREST sampling can never pick up a neighbour's
 * edge pixel, which is the classic "thin bright line on the side of every sprite" bug.
 */

import type { Frame } from "./batcher";

export type { Frame };

/** `atlas.json` shape. Pixel rects, top-left origin, matching what the packer emits. */
export interface AtlasManifest {
  width: number;
  height: number;
  frames: Record<string, AtlasFrameRect>;
  /** Named animations, referencing frame keys. Frame order is play order. */
  clips?: Record<string, AtlasClipDef>;
  /** 9-slice definitions for menu panels, referencing a frame key. */
  slices?: Record<string, AtlasSliceDef>;
}

export interface AtlasFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pivot in pixels from the frame's top-left. Defaults to bottom-centre (feet). */
  ox?: number;
  oy?: number;
}

export interface AtlasClipDef {
  frames: string[];
  /** Playback rate. 8-12 suits our 4-frame walk cycles. */
  fps: number;
  loop?: boolean;
}

export interface AtlasSliceDef {
  frame: string;
  /** Corner inset in pixels: left, top, right, bottom. */
  l: number;
  t: number;
  r: number;
  b: number;
}

/** Resolved animation, with frames already looked up so playback costs one array index. */
export interface Clip {
  readonly name: string;
  readonly frames: readonly Frame[];
  /** Sim ticks per frame, precomputed at 60Hz. Integer so animation is deterministic. */
  readonly ticksPerFrame: number;
  readonly loop: boolean;
}

/** Resolved 9-slice: nine frames in reading order, plus the pixel insets. */
export interface Slice {
  readonly name: string;
  readonly cells: readonly Frame[]; // tl, t, tr, l, c, r, bl, b, br
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

const UV_MAX = 65535;

export class Atlas {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  private readonly framesByName = new Map<string, Frame>();
  private readonly clipsByName = new Map<string, Clip>();
  private readonly slicesByName = new Map<string, Slice>();

  constructor(texture: WebGLTexture, width: number, height: number) {
    this.texture = texture;
    this.width = width;
    this.height = height;
  }

  /** Look up once at load time and hold the reference. Never call this inside a frame. */
  get(name: string): Frame | undefined {
    return this.framesByName.get(name);
  }

  /**
   * Same, but loud. Content code uses this so a typo'd sprite name fails at load rather than
   * silently drawing nothing thirty minutes into a run.
   */
  need(name: string): Frame {
    const f = this.framesByName.get(name);
    if (!f) throw new Error(`Atlas frame missing: "${name}"`);
    return f;
  }

  clip(name: string): Clip {
    const c = this.clipsByName.get(name);
    if (!c) throw new Error(`Atlas clip missing: "${name}"`);
    return c;
  }

  slice(name: string): Slice {
    const s = this.slicesByName.get(name);
    if (!s) throw new Error(`Atlas slice missing: "${name}"`);
    return s;
  }

  get frameCount(): number {
    return this.framesByName.size;
  }

  frameNames(): string[] {
    return [...this.framesByName.keys()].sort();
  }

  /** Register a pixel rect. Pivot defaults to bottom-centre, which is what our sprites want. */
  define(name: string, rect: AtlasFrameRect): Frame {
    const frame = makeFrame(rect, this.width, this.height);
    this.framesByName.set(name, frame);
    return frame;
  }

  defineClip(name: string, def: AtlasClipDef): Clip {
    const frames = def.frames.map((k) => this.need(k));
    const fps = def.fps > 0 ? def.fps : 10;
    const clip: Clip = {
      name,
      frames,
      ticksPerFrame: Math.max(1, Math.round(60 / fps)),
      loop: def.loop !== false,
    };
    this.clipsByName.set(name, clip);
    return clip;
  }

  /** Split one frame into the nine 9-slice cells. Done at load time, not per panel draw. */
  defineSlice(name: string, def: AtlasSliceDef): Slice {
    const base = this.need(def.frame);
    const px = uvToPixelRect(base, this.width, this.height);
    const { l, t, r, b } = def;
    const midW = px.w - l - r;
    const midH = px.h - t - b;
    if (midW <= 0 || midH <= 0) {
      throw new Error(`Slice "${name}" insets exceed frame size ${px.w}x${px.h}`);
    }
    const cols: Array<[number, number]> = [
      [px.x, l],
      [px.x + l, midW],
      [px.x + l + midW, r],
    ];
    const rows: Array<[number, number]> = [
      [px.y, t],
      [px.y + t, midH],
      [px.y + t + midH, b],
    ];
    const cells: Frame[] = [];
    for (const [cy, ch] of rows) {
      for (const [cx, cw] of cols) {
        cells.push(makeFrame({ x: cx, y: cy, w: cw, h: ch, ox: 0, oy: 0 }, this.width, this.height));
      }
    }
    const slice: Slice = { name, cells, l, t, r, b };
    this.slicesByName.set(name, slice);
    return slice;
  }
}

/** Build UVs for a pixel rect, inset by half a texel on every side. */
function makeFrame(rect: AtlasFrameRect, texW: number, texH: number): Frame {
  const halfU = 0.5 / texW;
  const halfV = 0.5 / texH;
  const u0 = rect.x / texW + halfU;
  const v0 = rect.y / texH + halfV;
  const u1 = (rect.x + rect.w) / texW - halfU;
  const v1 = (rect.y + rect.h) / texH - halfV;
  return {
    u0: Math.round(u0 * UV_MAX),
    v0: Math.round(v0 * UV_MAX),
    u1: Math.round(u1 * UV_MAX),
    v1: Math.round(v1 * UV_MAX),
    w: rect.w,
    h: rect.h,
    ox: rect.ox ?? rect.w / 2,
    oy: rect.oy ?? rect.h,
  };
}

/** Inverse of `makeFrame`'s UV maths, tolerant of the half-texel inset. */
function uvToPixelRect(f: Frame, texW: number, texH: number) {
  return {
    x: Math.round((f.u0 / UV_MAX) * texW - 0.5),
    y: Math.round((f.v0 / UV_MAX) * texH - 0.5),
    w: f.w,
    h: f.h,
  };
}

/**
 * Standard sampler state for pixel art: NEAREST both ways, no mipmaps, clamp to edge.
 *
 * LINEAR would blur every sprite; mipmaps would need a full pyramid we never sample since our
 * scale is always an integer >= 1. CLAMP_TO_EDGE is required anyway — WebGL1 only allows REPEAT on
 * power-of-two textures and we do not want repeat on an atlas.
 */
export function configureAtlasTexture(gl: WebGLRenderingContext, tex: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Upload raw RGBA bytes as an atlas texture. Used by the debug atlas and by generated glyphs. */
export function uploadRgbaTexture(
  gl: WebGLRenderingContext,
  pixels: Uint8Array,
  width: number,
  height: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("gl.createTexture returned null");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels as unknown as ArrayBufferView,
  );
  configureAtlasTexture(gl, tex);
  return tex;
}

/** Wrap an already-uploaded texture with a manifest. The normal production path. */
export function createAtlas(
  gl: WebGLRenderingContext,
  texture: WebGLTexture,
  manifest: AtlasManifest,
): Atlas {
  configureAtlasTexture(gl, texture);
  const atlas = new Atlas(texture, manifest.width, manifest.height);
  for (const [name, rect] of Object.entries(manifest.frames)) atlas.define(name, rect);
  if (manifest.clips) {
    for (const [name, def] of Object.entries(manifest.clips)) atlas.defineClip(name, def);
  }
  if (manifest.slices) {
    for (const [name, def] of Object.entries(manifest.slices)) atlas.defineSlice(name, def);
  }
  return atlas;
}

/* ------------------------------------------------------------------------------------------------
 * Debug atlas
 *
 * Gate A has to answer "can this device push 5,000 textured quads at 60fps" before a single sprite
 * is drawn, so the benchmark generates its own texture. These are deliberately varied shapes with
 * different alpha coverage — a texture of solid squares would flatter the blend stage and give a
 * number we could not trust.
 * ---------------------------------------------------------------------------------------------- */

const DEBUG_SIZE = 256;
const DEBUG_CELL = 32;
const DEBUG_COLS = DEBUG_SIZE / DEBUG_CELL;

export const DEBUG_FRAME_NAMES = [
  "debug/blob",
  "debug/ring",
  "debug/diamond",
  "debug/cross",
  "debug/bat",
  "debug/skull",
  "debug/gem",
  "debug/spark",
  "debug/panel",
  "debug/white",
] as const;

export function createDebugAtlas(gl: WebGLRenderingContext): Atlas {
  const px = new Uint8Array(DEBUG_SIZE * DEBUG_SIZE * 4);
  for (let i = 0; i < DEBUG_FRAME_NAMES.length; i++) {
    const cx = (i % DEBUG_COLS) * DEBUG_CELL;
    const cy = Math.floor(i / DEBUG_COLS) * DEBUG_CELL;
    paintDebugCell(px, cx, cy, i);
  }

  const tex = uploadRgbaTexture(gl, px, DEBUG_SIZE, DEBUG_SIZE);
  const atlas = new Atlas(tex, DEBUG_SIZE, DEBUG_SIZE);
  for (let i = 0; i < DEBUG_FRAME_NAMES.length; i++) {
    const name = DEBUG_FRAME_NAMES[i];
    const isWhite = name === "debug/white";
    atlas.define(name, {
      x: (i % DEBUG_COLS) * DEBUG_CELL + (isWhite ? 14 : 0),
      y: Math.floor(i / DEBUG_COLS) * DEBUG_CELL + (isWhite ? 14 : 0),
      w: isWhite ? 4 : DEBUG_CELL,
      h: isWhite ? 4 : DEBUG_CELL,
      ox: isWhite ? 2 : DEBUG_CELL / 2,
      oy: isWhite ? 2 : DEBUG_CELL / 2,
    });
  }
  return atlas;
}

/** Write one 32x32 shape. Plain integer maths — runs once, at load. */
function paintDebugCell(px: Uint8Array, ox: number, oy: number, kind: number): void {
  const n = DEBUG_CELL;
  const half = n / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - half + 0.5;
      const dy = y - half + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      let r = 220;
      let g = 220;
      let b = 235;

      switch (kind % 10) {
        case 0: // blob — soft-edged disc
          a = dist < half - 2 ? 255 : dist < half - 1 ? 140 : 0;
          r = 200;
          g = 60;
          b = 70;
          break;
        case 1: // ring
          a = dist < half - 2 && dist > half - 8 ? 255 : 0;
          r = 90;
          g = 200;
          b = 220;
          break;
        case 2: // diamond
          a = Math.abs(dx) + Math.abs(dy) < half - 2 ? 255 : 0;
          r = 230;
          g = 190;
          b = 90;
          break;
        case 3: // cross
          a = Math.abs(dx) < 3 || Math.abs(dy) < 3 ? 255 : 0;
          r = 180;
          g = 180;
          b = 200;
          break;
        case 4: // bat — two wings and a body, mostly transparent
          a = Math.abs(dy) < 3 && Math.abs(dx) < half - 3 ? 255 : dist < 5 ? 255 : 0;
          r = 120;
          g = 90;
          b = 160;
          break;
        case 5: // skull — square with two holes
          a = Math.abs(dx) < half - 5 && Math.abs(dy) < half - 4 ? 255 : 0;
          if (a > 0 && dy < 0 && Math.abs(Math.abs(dx) - 4) < 2) a = 0;
          r = 235;
          g = 232;
          b = 215;
          break;
        case 6: // gem — narrow diamond
          a = Math.abs(dx) * 2 + Math.abs(dy) < half + 2 ? 255 : 0;
          r = 90;
          g = 210;
          b = 150;
          break;
        case 7: // spark — thin four-point star
          a = Math.abs(dx) * Math.abs(dy) < 12 && dist < half - 1 ? 255 : 0;
          r = 255;
          g = 250;
          b = 220;
          break;
        case 8: // panel — 1px border box, for 9-slice smoke tests
          a = Math.abs(dx) > half - 2 || Math.abs(dy) > half - 2 ? 255 : 24;
          r = 60;
          g = 58;
          b = 80;
          break;
        default: // white — solid, used for bars and fills
          a = 255;
          r = 255;
          g = 255;
          b = 255;
          break;
      }

      const o = ((oy + y) * DEBUG_SIZE + (ox + x)) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a;
    }
  }
}
