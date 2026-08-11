/**
 * Quad storm — the Gate A benchmark scene.
 *
 * GATE A: 5,000 textured quads at 60fps with a HUD overlay, measured warm, on the REVVL.
 * Fail and the render layer pivots to native Skia immediately, which is contained to `game/render/`
 * because nothing outside it knows how a sprite reaches the screen.
 *
 * This is deliberately a *pessimistic* stand-in for a real run:
 *  - every quad is on screen, so nothing is culled;
 *  - quads are spread across four world layers, so we pay the real layer-switch cost;
 *  - a fifth of them are rotated, which skips pixel snapping and costs four extra multiplies;
 *  - alpha varies, so the blend stage never gets a free ride;
 *  - a synthetic HUD adds ~200 screen-space quads on top, as the real one will.
 *
 * A real 800-enemy moment draws fewer quads than 5,000, but also runs collision, weapon, and
 * damage-number logic in the same frame. The margin between "5,000 quads render" and "60fps with
 * the sim attached" is exactly the budget Phase 1 gets to spend.
 *
 * ZERO ALLOCATION: every array is sized in the constructor. `setCount` only moves a cursor.
 */

import type { Atlas, Frame } from "../render/atlas";
import { packColor, packHex, type PackedColor } from "../render/batcher";
import { Renderer, type LayerId } from "../render/renderer";

/** World layers the storm spreads across, in submission order. */
const STORM_LAYERS: LayerId[] = ["pickups", "enemies", "player", "projectiles"];

const TRIG_STEPS = 256;

/**
 * Packed once at module scope, not per frame. `Renderer.color()` calls `packHex()`, which does
 * `hex.slice(1)` — a fresh string every call. Seven calls per frame across the heartbeat and the
 * synthetic HUD is ~420 short-lived strings a second. Too small to explain an OOM, but the
 * zero-allocation contract says `new` inside a tick is a bug, and that includes strings.
 */
const HUD_TRACK = packHex("#2a2740", 220);
const HUD_GOLD = packHex("#e0be5a");
const HUD_CYAN = packHex("#5ad4e0");
const HUD_INK = packHex("#0b0a12", 200);
const HUD_BONE = packHex("#e6e3d6");
const HUD_CRIMSON = packHex("#c8384a");

export class QuadStorm {
  readonly capacity: number;
  private count = 0;

  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array; // previous tick, for interpolation
  private readonly py: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly angle: Uint8Array; // index into the trig table
  private readonly spin: Int8Array;
  private readonly frameIdx: Uint8Array;
  private readonly color: Uint32Array;

  private readonly frames: Frame[];
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  private fieldW = 320;
  private fieldH = 240;

  /** Share of quads drawn rotated. 0.2 matches a heavy projectile build. */
  rotatedShare = 0.2;
  drawHud = true;

  /**
   * Multiplies every quad's on-screen size without changing how many are submitted.
   *
   * This is the bisection that makes a bad frame time attributable. Two very different problems
   * produce the same slow number: the GPU shading too many blended pixels (fill-rate bound), or
   * the cost of pushing each quad through JS and the driver (per-quad bound). Halving the size
   * quarters the pixels and leaves the quad count untouched:
   *   - frame time drops roughly 4x  -> fill-rate bound, and the fix is overdraw, not quad count
   *   - frame time barely moves      -> per-quad bound, and shrinking sprites will not save us
   * Without this the only honest report is "it is slow", which does not point anywhere.
   */
  sizeScale = 1;

  /**
   * Total quad area submitted last draw, in world pixels. Multiply by the camera scale squared to
   * get blended device pixels, then divide by the buffer to read overdraw as a multiple of the
   * screen. Accumulated during draw because only draw knows what was actually submitted.
   */
  submittedArea = 0;

  constructor(atlas: Atlas, capacity: number) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.angle = new Uint8Array(capacity);
    this.spin = new Int8Array(capacity);
    this.frameIdx = new Uint8Array(capacity);
    this.color = new Uint32Array(capacity);

    this.frames = [
      atlas.need("debug/blob"),
      atlas.need("debug/bat"),
      atlas.need("debug/skull"),
      atlas.need("debug/gem"),
      atlas.need("debug/spark"),
      atlas.need("debug/diamond"),
      atlas.need("debug/ring"),
      atlas.need("debug/cross"),
    ];

    this.cos = new Float32Array(TRIG_STEPS);
    this.sin = new Float32Array(TRIG_STEPS);
    for (let i = 0; i < TRIG_STEPS; i++) {
      const a = (i / TRIG_STEPS) * Math.PI * 2;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
  }

  get activeCount(): number {
    return this.count;
  }

  /** Visible world area. Every quad lives inside it, so nothing is culled away. */
  setField(w: number, h: number): void {
    this.fieldW = w;
    this.fieldH = h;
  }

  /**
   * Populate up to `n` quads. Seeded by index rather than a PRNG so two runs of the benchmark on
   * two devices measure the identical scene — a benchmark that varies is not a benchmark.
   */
  setCount(n: number): void {
    const target = n > this.capacity ? this.capacity : n < 0 ? 0 : n | 0;
    for (let i = this.count; i < target; i++) this.spawn(i);
    this.count = target;
  }

  private spawn(i: number): void {
    // Cheap integer hash for spread-out but reproducible placement.
    let h = (i * 2654435761) >>> 0;
    const nx = ((h >>> 8) & 4095) / 4095;
    h = (h * 1103515245 + 12345) >>> 0;
    const ny = ((h >>> 8) & 4095) / 4095;
    h = (h * 1103515245 + 12345) >>> 0;
    const na = ((h >>> 8) & 255) / 255;
    h = (h * 1103515245 + 12345) >>> 0;
    const nb = ((h >>> 8) & 255) / 255;

    this.x[i] = nx * this.fieldW;
    this.y[i] = ny * this.fieldH;
    this.px[i] = this.x[i];
    this.py[i] = this.y[i];
    const speed = 0.3 + na * 1.1;
    const dir = nb * Math.PI * 2;
    this.vx[i] = Math.cos(dir) * speed;
    this.vy[i] = Math.sin(dir) * speed;
    this.angle[i] = (na * 255) | 0;
    this.spin[i] = ((nb * 8) | 0) - 4;
    this.frameIdx[i] = i % this.frames.length;
    // Varying alpha keeps the blend stage honest; varying tint mimics hit flashes.
    const alpha = 150 + ((i * 37) % 106);
    this.color[i] = packColor(
      160 + ((i * 53) % 96),
      140 + ((i * 29) % 116),
      150 + ((i * 71) % 106),
      alpha,
    );
  }

  /** One 60Hz tick. Bounces off the field edges so the population never drifts off screen. */
  tick(): void {
    const n = this.count;
    const w = this.fieldW;
    const h = this.fieldH;
    for (let i = 0; i < n; i++) {
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      let nx = this.x[i] + this.vx[i];
      let ny = this.y[i] + this.vy[i];
      if (nx < 0) {
        nx = -nx;
        this.vx[i] = -this.vx[i];
        this.px[i] = nx;
      } else if (nx > w) {
        nx = w - (nx - w);
        this.vx[i] = -this.vx[i];
        this.px[i] = nx;
      }
      if (ny < 0) {
        ny = -ny;
        this.vy[i] = -this.vy[i];
        this.py[i] = ny;
      } else if (ny > h) {
        ny = h - (ny - h);
        this.vy[i] = -this.vy[i];
        this.py[i] = ny;
      }
      this.x[i] = nx;
      this.y[i] = ny;
      this.angle[i] = (this.angle[i] + this.spin[i]) & 255;
    }
  }

  /** Submit every layer. `alpha` interpolates between the last two ticks. */
  draw(r: Renderer, alpha: number): void {
    const n = this.count;
    this.submittedArea = 0;
    if (n === 0) return;

    const size = this.sizeScale;
    const scaled = size !== 1;
    const rotatedFrom = n - Math.floor(n * this.rotatedShare);
    const perLayer = Math.ceil(n / STORM_LAYERS.length);

    for (let l = 0; l < STORM_LAYERS.length; l++) {
      const start = l * perLayer;
      if (start >= n) break;
      const end = Math.min(n, start + perLayer);
      const b = r.layer(STORM_LAYERS[l]);

      for (let i = start; i < end; i++) {
        const ix = this.px[i] + (this.x[i] - this.px[i]) * alpha;
        const iy = this.py[i] + (this.y[i] - this.py[i]) * alpha;
        const frame = this.frames[this.frameIdx[i]];
        this.submittedArea += frame.w * frame.h * size * size;
        if (scaled) {
          // Scaled path skips the rotated variant on purpose: mixing two changes at once would
          // make the fill-rate reading unattributable, which is the whole point of the toggle.
          b.drawScaled(frame, ix, iy, size, size, this.color[i]);
        } else if (i >= rotatedFrom) {
          const a = this.angle[i];
          b.drawRotated(frame, ix, iy, this.cos[a], this.sin[a], this.color[i]);
        } else {
          b.draw(frame, ix, iy, this.color[i], (i & 1) === 1);
        }
      }
    }

    if (this.drawHud) this.drawSyntheticHud(r);
  }

  /**
   * Two moving blocks at the bottom of the screen, drawn *inside* GL.
   *
   * WHY THIS EXISTS: the readout panel is a React Native view composited on top of the GL surface,
   * so a climbing frame counter proves only that JavaScript is alive — not that anything reached
   * the display. When the sprites appeared to freeze mid-run, the panel kept updating, which left
   * three indistinguishable suspects: a stalled sim, a thrown exception, or a GL surface that
   * stopped presenting. These two markers separate them at a glance:
   *
   *  - gold block advances once per *rendered frame*. Frozen while the panel still counts frames
   *    means GL stopped presenting.
   *  - cyan block advances once per *sim tick*. Frozen while gold moves means the fixed loop
   *    stopped ticking.
   *  - both moving while sprites sit still would mean the bug is in the storm itself.
   */
  drawHeartbeat(r: Renderer, frames: number, tick: number): void {
    const b = r.layer("hud");
    const white = r.currentAtlas.need("debug/white");
    const vw = r.camera.worldViewW;
    const vh = r.camera.worldViewH;

    const slots = 24;
    const slotW = vw / slots;

    b.drawRect(white, 0, vh - 22, vw, 4, HUD_TRACK);
    b.drawRect(white, (frames % slots) * slotW, vh - 22, slotW, 4, HUD_GOLD);

    b.drawRect(white, 0, vh - 16, vw, 4, HUD_TRACK);
    b.drawRect(white, (tick % slots) * slotW, vh - 16, slotW, 4, HUD_CYAN);
  }

  /**
   * ~200 screen-space quads standing in for the real HUD: a frame, an XP bar, weapon slots, and a
   * scatter of damage numbers. Gate A is specified "with overlay" because a HUD is not free — it is
   * a camera-uniform change plus a fresh flush at minimum.
   */
  private drawSyntheticHud(r: Renderer): void {
    const b = r.layer("hud");
    const white = r.currentAtlas.need("debug/white");
    const panel = r.currentAtlas.need("debug/panel");
    const gem = r.currentAtlas.need("debug/gem");
    const vw = r.camera.worldViewW;
    const vh = r.camera.worldViewH;


    // XP bar: track plus fill.
    b.drawRect(white, 0, 0, vw, 6, HUD_INK);
    b.drawRect(white, 0, 0, vw * 0.42, 6, HUD_GOLD);

    // Weapon and passive slots — twelve panels, the real HUD's worst case.
    for (let i = 0; i < 12; i++) {
      const sx = 4 + (i % 6) * 20;
      const sy = 10 + Math.floor(i / 6) * 20;
      b.drawRect(panel, sx, sy, 18, 18, HUD_BONE);
      b.draw(gem, sx + 9, sy + 14, HUD_GOLD);
    }

    // Boss bar.
    b.drawRect(white, vw * 0.2, vh - 10, vw * 0.6, 4, HUD_INK);
    b.drawRect(white, vw * 0.2, vh - 10, vw * 0.6 * 0.73, 4, HUD_CRIMSON);

    // Damage numbers: 3 quads each, since a bitmap glyph is one quad per character.
    for (let i = 0; i < 48; i++) {
      const hx = ((i * 61) % 100) / 100;
      const hy = ((i * 37) % 100) / 100;
      const dx = 8 + hx * (vw - 24);
      const dy = 24 + hy * (vh - 60);
      const tint = i % 7 === 0 ? HUD_CRIMSON : HUD_BONE;
      b.draw(white, dx, dy, tint);
      b.draw(white, dx + 5, dy, tint);
      b.draw(white, dx + 10, dy, tint);
    }
  }
}

export type { PackedColor };
