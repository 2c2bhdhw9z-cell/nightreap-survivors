/**
 * Q16.16 fixed-point math.
 *
 * WHY THIS EXISTS
 * Co-op correctness does NOT depend on this file — the netcode is host-authoritative with a
 * rolling correction sweep, so divergence is corrected rather than prevented. Fixed point is an
 * *optimization*: the closer two clients simulate, the less correction bandwidth we spend and the
 * less visible snapping players see. It also makes replay validation (anti-cheat) and the CI soak
 * test exactly reproducible across iOS, Android, and Node.
 *
 * DETERMINISM NOTES
 * JS guarantees `+ - * /` and `Math.sqrt` are IEEE-754 correctly rounded, so those are safe to use
 * across engines. `Math.sin`, `cos`, `tan`, `exp`, `log`, `pow` are NOT specified and differ
 * between JSC, Hermes, and V8 — so this file never calls them, not even to build its own tables.
 * The trig table below is generated with integer-only Taylor terms at module load.
 *
 * RANGE
 * Values are int32. That gives ±32768.0 with a resolution of 1/65536. World coordinates are kept
 * well inside ±8192 so that intermediate products in `mul` cannot overflow. `dist` uses doubles
 * internally (still deterministic) because squared distances exceed int32 quickly.
 */

/** A Q16.16 fixed-point number. Nominally an int32. */
export type Fx = number;

export const FX_SHIFT = 16;
export const FX_ONE = 1 << FX_SHIFT;
export const FX_HALF = FX_ONE >> 1;
export const FX_FRAC_MASK = FX_ONE - 1;

/** π and friends, pre-rounded so no `Math.PI` multiply is needed at runtime. */
export const FX_PI = 205887; // round(π * 65536)
export const FX_HALF_PI = 102944; // round(π/2 * 65536)
export const FX_TWO_PI = 411775; // round(2π * 65536)

export function fxFromInt(n: number): Fx {
  return (n * FX_ONE) | 0;
}

/** Truncates toward negative infinity, matching `>>`. */
export function fxToInt(a: Fx): number {
  return a >> FX_SHIFT;
}

export function fxFromFloat(f: number): Fx {
  return Math.round(f * FX_ONE) | 0;
}

export function fxToFloat(a: Fx): number {
  return a / FX_ONE;
}

/**
 * Multiply. Split into high/low halves so the intermediate product stays inside the 2^53 range
 * where doubles represent integers exactly — a plain `(a * b) >> 16` silently corrupts above
 * ~±32.0 because `>>` coerces to int32 first.
 */
export function fxMul(a: Fx, b: Fx): Fx {
  const ah = a >> FX_SHIFT;
  const al = a & FX_FRAC_MASK;
  return (ah * b + Math.floor((al * b) / FX_ONE)) | 0;
}

/** Divide. Saturates instead of returning Infinity/NaN, which would poison the whole sim. */
export function fxDiv(a: Fx, b: Fx): Fx {
  if (b === 0) return a < 0 ? -0x7fffffff : 0x7fffffff;
  return Math.floor((a * FX_ONE) / b) | 0;
}

/** Square root. `Math.sqrt` is correctly rounded by spec, so this is cross-engine stable. */
export function fxSqrt(a: Fx): Fx {
  if (a <= 0) return 0;
  return Math.floor(Math.sqrt(a * FX_ONE)) | 0;
}

export function fxAbs(a: Fx): Fx {
  return a < 0 ? -a : a;
}

export function fxSign(a: Fx): number {
  return a < 0 ? -1 : a > 0 ? 1 : 0;
}

export function fxMin(a: Fx, b: Fx): Fx {
  return a < b ? a : b;
}

export function fxMax(a: Fx, b: Fx): Fx {
  return a > b ? a : b;
}

export function fxClamp(a: Fx, lo: Fx, hi: Fx): Fx {
  return a < lo ? lo : a > hi ? hi : a;
}

/** Linear interpolate. `t` is Q16.16 in [0, FX_ONE]. */
export function fxLerp(a: Fx, b: Fx, t: Fx): Fx {
  return (a + fxMul(b - a, t)) | 0;
}

/**
 * Euclidean length of a fixed-point vector.
 *
 * Uses doubles internally: squared distances blow past int32 almost immediately (a 4096-unit
 * offset squared is already 7.2e16). Determinism is preserved because `*`, `+`, and `Math.sqrt`
 * are all exactly specified — only the transcendentals are unsafe.
 */
export function fxLen(x: Fx, y: Fx): Fx {
  if (x === 0) return fxAbs(y);
  if (y === 0) return fxAbs(x);
  return Math.round(Math.sqrt(x * x + y * y)) | 0;
}

/** Squared length as a double. For comparisons only — never store this as an Fx. */
export function fxLenSq(x: Fx, y: Fx): number {
  return x * x + y * y;
}

// ---------------------------------------------------------------------------
// Angles
//
// Angles are "brads": 4096 units per full turn, stored as plain integers. Integer angles wrap for
// free with `& BRAD_MASK`, index the table directly, and never accumulate drift the way a
// fixed-point radian would.
// ---------------------------------------------------------------------------

export const BRAD_FULL = 4096;
export const BRAD_MASK = BRAD_FULL - 1;
export const BRAD_QUARTER = BRAD_FULL >> 2; // 1024
export const BRAD_HALF = BRAD_FULL >> 1; // 2048

/**
 * sin over the first quadrant, 1025 entries (inclusive of π/2), Q16.16.
 *
 * Built with integer-only Taylor terms through x^11 so the table is bit-identical on every engine.
 * Truncation error is under 1e-5, i.e. inside Q16.16's own resolution of 1.5e-5.
 */
const SIN_QUADRANT: Int32Array = (() => {
  const table = new Int32Array(BRAD_QUARTER + 1);
  for (let i = 0; i <= BRAD_QUARTER; i++) {
    // x = (i / 1024) * π/2, in Q16.16
    const x = Math.floor((i * FX_HALF_PI) / BRAD_QUARTER) | 0;
    const x2 = fxMul(x, x);
    let term = x; // x^1 / 1!
    let acc = term;
    // Each step multiplies by x² and divides by the next two odd factors, alternating sign.
    term = Math.floor(fxMul(term, x2) / 6); // x^3 / 3!
    acc -= term;
    term = Math.floor(fxMul(term, x2) / 20); // x^5 / 5!
    acc += term;
    term = Math.floor(fxMul(term, x2) / 42); // x^7 / 7!
    acc -= term;
    term = Math.floor(fxMul(term, x2) / 72); // x^9 / 9!
    acc += term;
    term = Math.floor(fxMul(term, x2) / 110); // x^11 / 11!
    acc -= term;
    table[i] = acc | 0;
  }
  // Pin the endpoints exactly; Taylor lands a unit or two short at π/2.
  table[0] = 0;
  table[BRAD_QUARTER] = FX_ONE;
  return table;
})();

/**
 * sin of an angle in brads, returned as Q16.16.
 *
 * Every index here is already inside the table by construction — `b` is masked to one turn and each
 * branch folds it into the first quadrant — but the reads are asserted anyway so this file typechecks
 * under the strictest indexing rules. The relay compiles against it, and a shared module that only
 * builds under the loosest of its consumers' settings is a trap waiting for whoever imports it next.
 */
export function fxSin(brad: number): Fx {
  const b = brad & BRAD_MASK;
  if (b <= BRAD_QUARTER) return SIN_QUADRANT[b] as number;
  if (b <= BRAD_HALF) return SIN_QUADRANT[BRAD_HALF - b] as number;
  if (b <= BRAD_HALF + BRAD_QUARTER) return -(SIN_QUADRANT[b - BRAD_HALF] as number);
  return -(SIN_QUADRANT[BRAD_FULL - b] as number);
}

/** cos of an angle in brads, returned as Q16.16. */
export function fxCos(brad: number): Fx {
  return fxSin(brad + BRAD_QUARTER);
}

/**
 * atan2 in brads. Rational approximation, max error ~0.3° — well below what anyone can perceive
 * in a projectile's aim, and integer-only so it stays deterministic.
 */
export function fxAtan2(y: Fx, x: Fx): number {
  if (x === 0 && y === 0) return 0;
  const ax = fxAbs(x);
  const ay = fxAbs(y);
  let angle: number;
  if (ax >= ay) {
    const z = fxDiv(ay, ax); // 0..1
    angle = atanUnit(z);
  } else {
    const z = fxDiv(ax, ay);
    angle = BRAD_QUARTER - atanUnit(z);
  }
  if (x < 0) angle = BRAD_HALF - angle;
  if (y < 0) angle = -angle;
  return angle & BRAD_MASK;
}

/** atan for z in [0, 1], returned in brads. z/(1 + 0.28 z²), scaled to the octant. */
function atanUnit(z: Fx): number {
  const k = 18350; // 0.28 in Q16.16
  const denom = FX_ONE + fxMul(k, fxMul(z, z));
  const t = fxDiv(z, denom); // ≈ atan(z) in radians, Q16.16
  // radians → brads: brad = rad * 4096 / 2π = rad * 651.898…
  return Math.round((t * 651.8986469044033) / FX_ONE) | 0;
}

/** Shortest signed difference from `from` to `to`, in brads, in (-2048, 2048]. */
export function bradDelta(from: number, to: number): number {
  let d = (to - from) & BRAD_MASK;
  if (d > BRAD_HALF) d -= BRAD_FULL;
  return d;
}

/**
 * Unit vector for an angle, written into a caller-supplied 2-slot array.
 *
 * Takes an output array rather than returning a tuple because this runs thousands of times per
 * tick and allocating there is what causes GC pauses — which on a 4GB REVVL is a dropped frame.
 */
export function fxDirInto(brad: number, out: Int32Array | number[]): void {
  out[0] = fxCos(brad);
  out[1] = fxSin(brad);
}

// ---------------------------------------------------------------------------
// Float bridge
//
// The simulation stores positions and velocities as `Float32Array`, not fixed point, and converting
// it wholesale would be a rewrite. These two functions are the narrow bridge that lets float code
// get a cross-engine-stable sine and cosine.
//
// WHY THE RESULT IS STILL BIT-IDENTICAL EVERYWHERE
// `fxSin` is an integer table lookup — same integer on every engine. `FX_ONE` is 65536, a power of
// two, and IEEE-754 division by a power of two is exact: no rounding, no error, no engine-specific
// last bit. So an integer that is identical everywhere divided by 65536 is a double that is
// identical everywhere. That is the whole trick, and it is why these must never be reimplemented
// as `Math.sin(brad * SOMETHING)`.
//
// Angles are accepted as possibly-fractional brads and rounded here rather than at each call site,
// because `&` on a non-integer truncates toward zero and would quietly bias every negative angle.
// `Math.round` is fully specified, so the rounding itself is deterministic.
// ---------------------------------------------------------------------------

/** sin of an angle in brads, as a float in [-1, 1]. Deterministic across JS engines. */
export function fxSinF(brad: number): number {
  return fxSin(Math.round(brad)) / FX_ONE;
}

/** cos of an angle in brads, as a float in [-1, 1]. Deterministic across JS engines. */
export function fxCosF(brad: number): number {
  return fxCos(Math.round(brad)) / FX_ONE;
}
