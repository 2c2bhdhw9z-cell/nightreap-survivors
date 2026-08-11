/**
 * Sprite batcher — one dynamic vertex buffer, one draw call per layer.
 *
 * VERTEX LAYOUT: 16 bytes, four vertices per quad, indexed.
 *   offset 0  : vec2  position   float32 ×2   (world pixels)
 *   offset 8  : vec2  uv         uint16 ×2    (normalised — 1/65535 is far finer than any atlas texel)
 *   offset 12 : vec4  colour     uint8 ×4     (normalised RGBA multiply)
 *
 * Indexed drawing means 4 vertices per quad instead of 6, i.e. 33% less data to upload every
 * frame. At 5,000 sprites that is 320KB per frame rather than 480KB — and on a 4GB phone the bus
 * matters. The index buffer is static and uploaded once.
 *
 * WHY 8192 QUADS PER FLUSH
 * WebGL1 without the `OES_element_index_uint` extension only has 16-bit indices, so a single draw
 * can address 65,536 vertices = 16,384 quads. 8,192 leaves headroom and keeps the staging buffer
 * at a friendly 512KB. Exceeding it auto-flushes rather than dropping sprites.
 *
 * ZERO ALLOCATION
 * Every buffer is created in the constructor. `draw*` only writes into typed arrays. Nothing in
 * this file allocates during a frame — a GC pause here is a visible hitch.
 */

import type { SpriteProgram } from "./shader";

export const MAX_QUADS_PER_FLUSH = 8192;
const VERTS_PER_QUAD = 4;
const BYTES_PER_VERT = 16;
const F32_PER_VERT = BYTES_PER_VERT / 4;
const U16_PER_VERT = BYTES_PER_VERT / 2;

/** Packed RGBA, ready to write straight into the vertex buffer. */
export type PackedColor = number;

/** Pack 0-255 channels into the little-endian uint32 the shader expects. */
export function packColor(r: number, g: number, b: number, a = 255): PackedColor {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export const COLOR_WHITE: PackedColor = packColor(255, 255, 255, 255);

/** Pack a `#rrggbb` design token. Parsed at load time, never in a frame. */
export function packHex(hex: string, alpha = 255): PackedColor {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const n = parseInt(h, 16);
  return packColor((n >> 16) & 255, (n >> 8) & 255, n & 255, alpha);
}

/** Multiply a packed colour's alpha, for fades. Cheap enough for per-sprite use. */
export function withAlpha(color: PackedColor, alpha: number): PackedColor {
  const a = alpha < 0 ? 0 : alpha > 255 ? 255 : alpha | 0;
  return ((color & 0x00ffffff) | (a << 24)) >>> 0;
}

/** An atlas cell in normalised uint16 UV space, plus its pixel size and pivot. */
export interface Frame {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  w: number;
  h: number;
  /** Pivot offset in pixels — sprites are positioned by their feet/centre, not their corner. */
  ox: number;
  oy: number;
}

export class SpriteBatcher {
  private readonly gl: WebGLRenderingContext;
  private readonly prog: SpriteProgram;

  private readonly staging: ArrayBuffer;
  private readonly f32: Float32Array;
  private readonly u16: Uint16Array;
  private readonly u32: Uint32Array;
  private readonly bytes: Uint8Array;

  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;

  private quadCount = 0;
  private boundTexture: WebGLTexture | null = null;

  /** Per-frame counters for the dev-menu overlay. */
  readonly stats = { quads: 0, drawCalls: 0, flushes: 0, textureSwaps: 0 };

  constructor(gl: WebGLRenderingContext, prog: SpriteProgram) {
    this.gl = gl;
    this.prog = prog;

    const vertexCount = MAX_QUADS_PER_FLUSH * VERTS_PER_QUAD;
    this.staging = new ArrayBuffer(vertexCount * BYTES_PER_VERT);
    this.f32 = new Float32Array(this.staging);
    this.u16 = new Uint16Array(this.staging);
    this.u32 = new Uint32Array(this.staging);
    this.bytes = new Uint8Array(this.staging);

    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vbo || !ibo) throw new Error("gl.createBuffer returned null");
    this.vbo = vbo;
    this.ibo = ibo;

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.staging.byteLength, gl.DYNAMIC_DRAW);

    // Static index pattern: 0,1,2, 2,3,0 per quad. Uploaded once, never touched again.
    const indices = new Uint16Array(MAX_QUADS_PER_FLUSH * 6);
    for (let q = 0; q < MAX_QUADS_PER_FLUSH; q++) {
      const v = q * 4;
      const i = q * 6;
      indices[i] = v;
      indices[i + 1] = v + 1;
      indices[i + 2] = v + 2;
      indices[i + 3] = v + 2;
      indices[i + 4] = v + 3;
      indices[i + 5] = v;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  /** Bind program, buffers, and attribute pointers. Once per frame, not per layer. */
  begin(viewportW: number, viewportH: number, scale: number): void {
    const gl = this.gl;
    const p = this.prog;

    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);

    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, BYTES_PER_VERT, 0);
    gl.enableVertexAttribArray(p.aUv);
    gl.vertexAttribPointer(p.aUv, 2, gl.UNSIGNED_SHORT, true, BYTES_PER_VERT, 8);
    gl.enableVertexAttribArray(p.aColor);
    gl.vertexAttribPointer(p.aColor, 4, gl.UNSIGNED_BYTE, true, BYTES_PER_VERT, 12);

    gl.uniform2f(p.uViewport, viewportW, viewportH);
    gl.uniform1f(p.uScale, scale);
    gl.uniform1i(p.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    // Straight alpha, no depth. Layer order is submission order, which is all a 2D game needs and
    // avoids a depth buffer we'd otherwise pay for on every fragment.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this.stats.quads = 0;
    this.stats.drawCalls = 0;
    this.stats.flushes = 0;
    this.stats.textureSwaps = 0;
    this.boundTexture = null;
  }

  /** Camera position for the next layer. Pass (0,0) for screen-space UI. */
  setCamera(x: number, y: number): void {
    this.flush();
    this.gl.uniform2f(this.prog.uCamera, x, y);
  }

  setScale(scale: number): void {
    this.flush();
    this.gl.uniform1f(this.prog.uScale, scale);
  }

  /** Switching texture forces a flush, which is exactly why the whole game lives in one atlas. */
  setTexture(tex: WebGLTexture): void {
    if (this.boundTexture === tex) return;
    this.flush();
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    this.boundTexture = tex;
    this.stats.textureSwaps++;
  }

  /**
   * Axis-aligned sprite. `x`/`y` is the pivot, in world pixels.
   *
   * Coordinates are floored so sprites land on whole pixels — a pixel-art sprite drawn at x=12.4
   * samples between texels and reads as blurry, which is the single most common way a pixel game
   * looks cheap.
   */
  draw(frame: Frame, x: number, y: number, color: PackedColor = COLOR_WHITE, flipX = false): void {
    if (this.quadCount >= MAX_QUADS_PER_FLUSH) this.flush();

    const x0 = Math.floor(x - frame.ox);
    const y0 = Math.floor(y - frame.oy);
    const x1 = x0 + frame.w;
    const y1 = y0 + frame.h;

    const uL = flipX ? frame.u1 : frame.u0;
    const uR = flipX ? frame.u0 : frame.u1;

    this.writeQuad(x0, y0, x1, y0, x1, y1, x0, y1, uL, frame.v0, uR, frame.v1, color);
  }

  /** Explicit rectangle, ignoring the frame's pivot. Bars, panels, 9-slice edges. */
  drawRect(
    frame: Frame,
    x: number,
    y: number,
    w: number,
    h: number,
    color: PackedColor = COLOR_WHITE,
  ): void {
    if (this.quadCount >= MAX_QUADS_PER_FLUSH) this.flush();
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + Math.floor(w);
    const y1 = y0 + Math.floor(h);
    this.writeQuad(x0, y0, x1, y0, x1, y1, x0, y1, frame.u0, frame.v0, frame.u1, frame.v1, color);
  }

  /**
   * Rotated sprite. Projectiles, orbiting weapons, knockback spin.
   *
   * Takes cos/sin rather than an angle so the caller can pull them from the fixed-point trig table
   * and avoid a `Math.cos` per sprite — both faster and deterministic.
   */
  drawRotated(
    frame: Frame,
    x: number,
    y: number,
    cos: number,
    sin: number,
    color: PackedColor = COLOR_WHITE,
  ): void {
    if (this.quadCount >= MAX_QUADS_PER_FLUSH) this.flush();

    const lx = -frame.ox;
    const ly = -frame.oy;
    const rx = lx + frame.w;
    const ry = ly + frame.h;

    // Rotated quads are intentionally not pixel-snapped: snapping a rotating sprite makes it
    // visibly judder as it turns, which looks worse than the slight softness.
    this.writeQuad(
      x + lx * cos - ly * sin,
      y + lx * sin + ly * cos,
      x + rx * cos - ly * sin,
      y + rx * sin + ly * cos,
      x + rx * cos - ry * sin,
      y + rx * sin + ry * cos,
      x + lx * cos - ry * sin,
      y + lx * sin + ry * cos,
      frame.u0,
      frame.v0,
      frame.u1,
      frame.v1,
      color,
    );
  }

  /** Scaled sprite, pivot-anchored. Pickup pops, boss telegraphs, card-draw slams. */
  drawScaled(
    frame: Frame,
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    color: PackedColor = COLOR_WHITE,
  ): void {
    if (this.quadCount >= MAX_QUADS_PER_FLUSH) this.flush();
    const x0 = x - frame.ox * scaleX;
    const y0 = y - frame.oy * scaleY;
    const x1 = x0 + frame.w * scaleX;
    const y1 = y0 + frame.h * scaleY;
    this.writeQuad(x0, y0, x1, y0, x1, y1, x0, y1, frame.u0, frame.v0, frame.u1, frame.v1, color);
  }

  private writeQuad(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: PackedColor,
  ): void {
    const base = this.quadCount * VERTS_PER_QUAD;
    const f = this.f32;
    const s = this.u16;
    const c = this.u32;

    let fi = base * F32_PER_VERT;
    let si = base * U16_PER_VERT;
    let ci = base * F32_PER_VERT;

    f[fi] = ax; f[fi + 1] = ay; s[si + 4] = u0; s[si + 5] = v0; c[ci + 3] = color;
    fi += F32_PER_VERT; si += U16_PER_VERT; ci += F32_PER_VERT;
    f[fi] = bx; f[fi + 1] = by; s[si + 4] = u1; s[si + 5] = v0; c[ci + 3] = color;
    fi += F32_PER_VERT; si += U16_PER_VERT; ci += F32_PER_VERT;
    f[fi] = cx; f[fi + 1] = cy; s[si + 4] = u1; s[si + 5] = v1; c[ci + 3] = color;
    fi += F32_PER_VERT; si += U16_PER_VERT; ci += F32_PER_VERT;
    f[fi] = dx; f[fi + 1] = dy; s[si + 4] = u0; s[si + 5] = v1; c[ci + 3] = color;

    this.quadCount++;
  }

  /** Upload and draw whatever is queued. Called between layers and at frame end. */
  flush(): void {
    if (this.quadCount === 0) return;
    const gl = this.gl;
    const byteCount = this.quadCount * VERTS_PER_QUAD * BYTES_PER_VERT;
    // subarray is a view, not a copy — no allocation.
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.bytes.subarray(0, byteCount));
    gl.drawElements(gl.TRIANGLES, this.quadCount * 6, gl.UNSIGNED_SHORT, 0);

    this.stats.quads += this.quadCount;
    this.stats.drawCalls++;
    this.stats.flushes++;
    this.quadCount = 0;
  }

  get pending(): number {
    return this.quadCount;
  }

  dispose(): void {
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteBuffer(this.ibo);
  }
}
