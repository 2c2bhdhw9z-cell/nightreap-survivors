/**
 * Player input: the only thing a guest is ever trusted to author.
 *
 * WHY int8 STICK AXES
 * The stick is quantised to -127..127 before it ever reaches the simulation, on the local client
 * too. That matters more than the 4 bytes it saves: if the local sim consumed full-precision floats
 * and the remote sim consumed quantised bytes, the two would diverge immediately and permanently.
 * Quantise once, at the input boundary, and every machine simulates the identical number.
 *
 * LAYOUT — 8 bytes per frame, fixed
 *   0  u32  tick
 *   4  i8   stickX   (-127..127)
 *   5  i8   stickY   (-127..127)
 *   6  u8   buttons  (bitfield)
 *   7  u8   flags    (bitfield)
 *
 * Fixed width means an input history is a flat Int32Array/Int8Array pair with no per-frame objects.
 */

import { FX_ONE } from "../core/fx";

export const INPUT_FRAME_BYTES = 8;

/** Maximum magnitude of a quantised axis. */
export const STICK_MAX = 127;

/**
 * Q16.16 value of one stick unit. `round(65536 / 127)`. Multiplying the int8 axis by this converts
 * to fixed point with integer math only, so it is identical on every engine.
 */
export const STICK_UNIT_FX = 516;

/** Button bits. Never renumber. */
export const BTN = {
  /** Held to auto-aim at the nearest enemy where a weapon supports it. */
  FOCUS: 1 << 0,
  /** Consumable / active item slot 1. */
  ITEM_A: 1 << 1,
  /** Consumable / active item slot 2. */
  ITEM_B: 1 << 2,
  /** Revive-assist hold while standing on a downed ally. */
  REVIVE: 1 << 3,
  /** Pause request. Advisory in co-op — only the host actually pauses the sim. */
  PAUSE: 1 << 4,
} as const;

/** Frame flag bits. Never renumber. */
export const INPUT_FLAG = {
  /** This frame was synthesised because the real one never arrived. */
  PREDICTED: 1 << 0,
  /** Client believes it is in a menu / card draw and is intentionally not moving. */
  UI_OPEN: 1 << 1,
  /** Produced by the dev menu's input playback, not a human. Taints the run. */
  SYNTHETIC: 1 << 2,
} as const;

/**
 * Quantise a raw analog axis in -1..1 to the wire representation.
 * Uses `Math.round` (correctly rounded per spec) and clamps, so it is engine-independent.
 */
export function quantiseAxis(value: number): number {
  const scaled = Math.round(value * STICK_MAX);
  if (scaled > STICK_MAX) return STICK_MAX;
  if (scaled < -STICK_MAX) return -STICK_MAX;
  return scaled | 0;
}

/**
 * Quantise a joystick vector, preserving direction when the magnitude clips.
 *
 * Quantising each axis independently makes a full-tilt diagonal read (127,127), a vector of length
 * 180 — so diagonal movement would be 41% faster than cardinal. Normalising first keeps the stick
 * circular. `Math.sqrt` is IEEE-754 correctly rounded, so this stays deterministic.
 */
export function quantiseStick(x: number, y: number, out: Int8Array, offset: number): void {
  const mag = Math.sqrt(x * x + y * y);
  let nx = x;
  let ny = y;
  if (mag > 1) {
    nx = x / mag;
    ny = y / mag;
  }
  out[offset] = quantiseAxis(nx);
  out[offset + 1] = quantiseAxis(ny);
}

/** Convert a quantised axis to Q16.16 with integer math only. */
export function axisToFx(axis: number): number {
  return (axis * STICK_UNIT_FX) | 0;
}

/**
 * Deadzone applied to the *quantised* axis, so the deadzone itself is part of the deterministic
 * pipeline rather than a per-device UI detail. 12/127 is about 9%.
 */
export const STICK_DEADZONE = 12;

export function applyDeadzone(axis: number): number {
  return axis > STICK_DEADZONE || axis < -STICK_DEADZONE ? axis : 0;
}

/**
 * One player's input history, as a flat ring. No objects, no allocation after construction.
 *
 * `tickOf` is stored alongside so a slot can be recognised as stale rather than silently reused —
 * at 60Hz a 256-entry ring wraps every 4.3 seconds, which is longer than any correction window but
 * short enough that an unchecked read would be plausible-looking garbage.
 */
export class InputHistory {
  readonly capacity: number;
  private readonly ticks: Int32Array;
  private readonly axes: Int8Array;
  private readonly bits: Uint8Array;
  /** Highest tick ever written. -1 when empty. */
  newestTick = -1;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ticks = new Int32Array(capacity).fill(-1);
    this.axes = new Int8Array(capacity * 2);
    this.bits = new Uint8Array(capacity * 2);
  }

  private slot(tick: number): number {
    // Non-negative modulo without a branch on the common path.
    const m = tick % this.capacity;
    return m < 0 ? m + this.capacity : m;
  }

  write(tick: number, stickX: number, stickY: number, buttons: number, flags: number): void {
    const i = this.slot(tick);
    this.ticks[i] = tick;
    this.axes[i * 2] = stickX;
    this.axes[i * 2 + 1] = stickY;
    this.bits[i * 2] = buttons;
    this.bits[i * 2 + 1] = flags;
    if (tick > this.newestTick) this.newestTick = tick;
  }

  has(tick: number): boolean {
    return this.ticks[this.slot(tick)] === tick;
  }

  stickX(tick: number): number {
    const i = this.slot(tick);
    return this.ticks[i] === tick ? (this.axes[i * 2] as number) : 0;
  }

  stickY(tick: number): number {
    const i = this.slot(tick);
    return this.ticks[i] === tick ? (this.axes[i * 2 + 1] as number) : 0;
  }

  buttons(tick: number): number {
    const i = this.slot(tick);
    return this.ticks[i] === tick ? (this.bits[i * 2] as number) : 0;
  }

  flags(tick: number): number {
    const i = this.slot(tick);
    return this.ticks[i] === tick ? (this.bits[i * 2 + 1] as number) : 0;
  }

  /**
   * Fill a missing tick by repeating the previous one, marked PREDICTED.
   *
   * Repeat-last is the right guess for a twin-stick survivors game: players hold a direction for
   * long stretches, so the previous frame is almost always correct, and when it isn't the error is
   * one frame of movement — well inside what the correction sweep absorbs. Returns false when there
   * is nothing to repeat, so the caller can treat the player as idle instead.
   */
  predictFrom(tick: number): boolean {
    if (this.has(tick)) return true;
    const prev = tick - 1;
    if (!this.has(prev)) return false;
    this.write(
      tick,
      this.stickX(prev),
      this.stickY(prev),
      this.buttons(prev),
      this.flags(prev) | INPUT_FLAG.PREDICTED,
    );
    return true;
  }

  clear(): void {
    this.ticks.fill(-1);
    this.newestTick = -1;
  }
}

/** Movement direction for a tick, as Q16.16, deadzoned. Written into `out[0]`, `out[1]`. */
export function readMoveFx(history: InputHistory, tick: number, out: Int32Array): void {
  const x = applyDeadzone(history.stickX(tick));
  const y = applyDeadzone(history.stickY(tick));
  out[0] = axisToFx(x);
  out[1] = axisToFx(y);
}

/** Sanity ceiling used by tests: a deadzoned full-tilt axis must not exceed 1.0 in Q16.16. */
export const MAX_AXIS_FX = FX_ONE;
