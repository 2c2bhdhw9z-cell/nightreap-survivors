/**
 * Camera — world pixels to screen pixels, and the only place that decides what is on screen.
 *
 * THREE JOBS
 *  1. Follow a target smoothly without sub-pixel shimmer.
 *  2. Interpolate between the last two sim ticks so a 60Hz sim renders cleanly at 120fps.
 *  3. Report a culling rectangle, because at 800 enemies the cheapest sprite is the one we skip.
 *
 * PIXEL SNAPPING
 * The camera's top-left is snapped so that `(world - camera) * scale` lands on a whole device
 * pixel. Snapping in *screen* space rather than world space matters: at scale 3 a world-space
 * snap still leaves the camera a third of a pixel off and the whole scene crawls as you walk.
 *
 * ZERO ALLOCATION
 * No vectors, no objects, no closures. Values are read off fields. This runs once per frame, but
 * the same discipline as the batcher applies — `new` inside a frame is a bug.
 */

/** Camera follow feel. Tuned per stage later; these are the defaults. */
export const CAMERA_DEFAULTS = {
  /** Fraction of the remaining distance closed per 60Hz tick. 1 = rigid lock. */
  follow: 0.22,
  /** Target can drift this far from centre before the camera reacts at all, in world px. */
  deadzone: 4,
  /** Extra world px kept in the cull rect so sprites do not pop at the edge. */
  cullMargin: 48,
} as const;

export class Camera {
  /** Drawing-buffer size in device pixels. */
  viewW = 1;
  viewH = 1;
  /** Integer pixel scale. Set by `chooseScale`, never fractional. */
  scale = 1;

  /** Sim-space camera centre, in world pixels. Updated once per tick. */
  private curX = 0;
  private curY = 0;
  /** Previous tick's centre, for render interpolation. */
  private prevX = 0;
  private prevY = 0;

  /** Screen-shake offset in world px, decayed per tick. Visual only — never feeds the sim. */
  private shakeX = 0;
  private shakeY = 0;
  private shakeMag = 0;
  private shakeDecay = 0.86;
  private shakeSeed = 1;

  /** Interpolated, snapped top-left in world px. Read by the batcher. Recomputed in `beginFrame`. */
  topLeftX = 0;
  topLeftY = 0;

  follow = CAMERA_DEFAULTS.follow;
  deadzone = CAMERA_DEFAULTS.deadzone;
  cullMargin = CAMERA_DEFAULTS.cullMargin;

  /** Visible world rect including margin. Valid after `beginFrame`. */
  cullLeft = 0;
  cullTop = 0;
  cullRight = 0;
  cullBottom = 0;

  /**
   * Pick an integer pixel scale for a drawing buffer.
   *
   * Non-integer scales are the fastest way to make pixel art look broken — a 1.5x sprite has some
   * rows two pixels tall and some one. We always take the floor and accept a slightly larger view
   * on odd screens. `minVisible` is the shortest world-pixel span the design needs on screen; the
   * REVVL at 1640x720 and a 1290x2796 iPhone both resolve to sane scales from this.
   */
  static chooseScale(bufferW: number, bufferH: number, minVisibleShortSide: number): number {
    const shortSide = Math.min(bufferW, bufferH);
    const s = Math.floor(shortSide / minVisibleShortSide);
    return s < 1 ? 1 : s > 8 ? 8 : s;
  }

  setViewport(bufferW: number, bufferH: number, scale: number): void {
    this.viewW = bufferW > 0 ? bufferW : 1;
    this.viewH = bufferH > 0 ? bufferH : 1;
    this.scale = scale >= 1 ? scale | 0 : 1;
  }

  /** World-pixel size of the visible area at the current scale. */
  get worldViewW(): number {
    return this.viewW / this.scale;
  }

  get worldViewH(): number {
    return this.viewH / this.scale;
  }

  /** Hard cut — spawn, teleport, stage load. Kills interpolation so there is no smear. */
  snapTo(x: number, y: number): void {
    this.curX = x;
    this.curY = y;
    this.prevX = x;
    this.prevY = y;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeMag = 0;
    this.beginFrame(1);
  }

  /**
   * One sim tick of follow. Called from the fixed-step update, never from render, so camera feel
   * is identical at 30, 60, and 120fps.
   */
  tick(targetX: number, targetY: number): void {
    this.prevX = this.curX;
    this.prevY = this.curY;

    let dx = targetX - this.curX;
    let dy = targetY - this.curY;
    const dz = this.deadzone;
    if (dx > -dz && dx < dz) dx = 0;
    if (dy > -dz && dy < dz) dy = 0;

    this.curX += dx * this.follow;
    this.curY += dy * this.follow;

    if (this.shakeMag > 0.05) {
      // xorshift on an integer seed: deterministic per camera, no Math.random, no allocation.
      let s = this.shakeSeed | 0;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      this.shakeSeed = s | 0;
      const a = ((s >>> 8) & 1023) / 1023;
      const b = ((s >>> 20) & 1023) / 1023;
      this.shakeX = (a * 2 - 1) * this.shakeMag;
      this.shakeY = (b * 2 - 1) * this.shakeMag;
      this.shakeMag *= this.shakeDecay;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeMag = 0;
    }
  }

  /**
   * Co-op leash. Each player has their own camera; this clamps it inside `maxDist` world px of the
   * party centroid so four screens never show four unrelated places. Call after `tick`.
   */
  applyLeash(centroidX: number, centroidY: number, maxDist: number): void {
    const dx = this.curX - centroidX;
    const dy = this.curY - centroidY;
    const d2 = dx * dx + dy * dy;
    const max2 = maxDist * maxDist;
    if (d2 <= max2 || d2 === 0) return;
    const k = maxDist / Math.sqrt(d2);
    this.curX = centroidX + dx * k;
    this.curY = centroidY + dy * k;
  }

  /** Clamp to stage bounds. Open-field stages skip this; arena stages call it after `tick`. */
  clampToBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    const hw = this.worldViewW * 0.5;
    const hh = this.worldViewH * 0.5;
    if (maxX - minX <= this.worldViewW) {
      this.curX = (minX + maxX) * 0.5;
    } else {
      this.curX = this.curX < minX + hw ? minX + hw : this.curX > maxX - hw ? maxX - hw : this.curX;
    }
    if (maxY - minY <= this.worldViewH) {
      this.curY = (minY + maxY) * 0.5;
    } else {
      this.curY = this.curY < minY + hh ? minY + hh : this.curY > maxY - hh ? maxY - hh : this.curY;
    }
  }

  /** Queue a shake. `mag` is world px of initial offset; hits use 1-2, boss slams 6-10. */
  shake(mag: number): void {
    if (mag > this.shakeMag) this.shakeMag = mag;
  }

  /** Accessibility: reduced-motion turns shake off without touching call sites. */
  setShakeEnabled(enabled: boolean): void {
    this.shakeDecay = enabled ? 0.86 : 0;
    if (!enabled) {
      this.shakeMag = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /**
   * Resolve the camera for this frame. `alpha` is the 0..1 position between the previous and
   * current sim tick. Must be called before any `batcher.setCamera`.
   */
  beginFrame(alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const cx = this.prevX + (this.curX - this.prevX) * a + this.shakeX;
    const cy = this.prevY + (this.curY - this.prevY) * a + this.shakeY;

    const s = this.scale;
    // Snap in device pixels, then convert back to world px so the shader's multiply is exact.
    this.topLeftX = Math.round((cx - this.worldViewW * 0.5) * s) / s;
    this.topLeftY = Math.round((cy - this.worldViewH * 0.5) * s) / s;

    const m = this.cullMargin;
    this.cullLeft = this.topLeftX - m;
    this.cullTop = this.topLeftY - m;
    this.cullRight = this.topLeftX + this.worldViewW + m;
    this.cullBottom = this.topLeftY + this.worldViewH + m;
  }

  /** Cheap per-entity cull. Inlined by hot call sites; kept here for clarity elsewhere. */
  isVisible(x: number, y: number): boolean {
    return x >= this.cullLeft && x <= this.cullRight && y >= this.cullTop && y <= this.cullBottom;
  }

  /** Interpolated centre — for minimap, off-screen arrows, spawn ring placement. */
  centerX(alpha: number): number {
    return this.prevX + (this.curX - this.prevX) * alpha;
  }

  centerY(alpha: number): number {
    return this.prevY + (this.curY - this.prevY) * alpha;
  }

  /** Touch point (device px, top-left origin) to world px. Used by tap-targeting and the dev menu. */
  screenToWorldX(px: number): number {
    return this.topLeftX + px / this.scale;
  }

  screenToWorldY(py: number): number {
    return this.topLeftY + py / this.scale;
  }

  worldToScreenX(wx: number): number {
    return (wx - this.topLeftX) * this.scale;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.topLeftY) * this.scale;
  }
}
