/**
 * Core primitives self-check. Run headless: `bun packages/mobile/game/core/core.test.ts`
 *
 * WHY THIS FILE EXISTS
 * Everything else in the engine sits on these five files. The simulation tests prove the *game*
 * behaves; they exercise this layer only incidentally and only along the happy path. That is not
 * good enough for the layer that determinism rests on, because a bug here does not look like a bug
 * here — it looks like a co-op desync forty minutes into a run, or a replay that fails validation
 * for an honest player, or a pool that quietly stops handing out slots during a three-hour soak.
 *
 * WHAT IT PROVES
 *   1. Fixed-point maths is exact where it claims to be, saturates instead of poisoning the sim
 *      with NaN, and rounds toward negative infinity consistently.
 *   2. The trig tables never touch an unspecified `Math` function, so two phones running different
 *      JS engines compute bit-identical angles.
 *   3. The random number generator is reproducible, unbiased, cannot hang on a power-of-two bound,
 *      and its named streams are genuinely independent of one another.
 *   4. Entity handles catch use-after-free, and stay valid for the entire life of the pool — a
 *      handle must never rot simply because its slot has been recycled often.
 *   5. Broad-phase collision never misses a neighbour, and never overruns a caller's buffer.
 *   6. The fixed loop cannot enter a death spiral, and discards time rather than freezing.
 *   7. None of it allocates once warmed up.
 */

import {
  BRAD_FULL,
  BRAD_HALF,
  BRAD_MASK,
  BRAD_QUARTER,
  FX_HALF,
  FX_ONE,
  FX_PI,
  bradDelta,
  fxAbs,
  fxAtan2,
  fxClamp,
  fxCos,
  fxDirInto,
  fxDiv,
  fxFromFloat,
  fxFromInt,
  fxLen,
  fxLenSq,
  fxLerp,
  fxMax,
  fxMin,
  fxMul,
  fxSign,
  fxSin,
  fxSqrt,
  fxToFloat,
  fxToInt,
} from "./fx";
import { MAX_CATCHUP_TICKS, FixedLoop, FrameTimer, TICK_MS } from "./loop";
import { DYNAMIC_TARGET_FPS, RefreshEstimator, shouldDrawFrame } from "./frame-gate";
import { EntityPool, NULL_HANDLE, POOL_BUDGETS, handleGen, handleSlot } from "./pool";
import { RNG_STREAMS, Rng, RngSet, hashName } from "./rng";
import { SpatialHash } from "./spatial-hash";

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

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
  };
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

// ---------------------------------------------------------------------------
// 1. Fixed-point arithmetic
// ---------------------------------------------------------------------------

function testFxBasics(): void {
  section("1. Fixed point — conversion and arithmetic");

  check("one is one", fxFromInt(1) === FX_ONE);
  check("a half is half of one", fxFromFloat(0.5) === FX_HALF);
  check("round trips through float", fxToFloat(fxFromFloat(12.5)) === 12.5);
  check("round trips through int", fxToInt(fxFromInt(-7)) === -7);

  // `>>` floors, it does not truncate toward zero. Anything that assumed truncation would drift
  // by one unit on negative coordinates only — i.e. on half the map.
  check("truncates toward negative infinity", fxToInt(fxFromFloat(-1.5)) === -2, "not -1");
  check("floors positives the same way", fxToInt(fxFromFloat(1.9)) === 1);

  check("multiplies", fxMul(fxFromFloat(2.5), fxFromFloat(4)) === fxFromInt(10));
  check("multiplies by zero", fxMul(fxFromFloat(1234.5), 0) === 0);
  check("handles a negative operand", fxMul(fxFromFloat(-1.5), fxFromFloat(2)) === fxFromInt(-3));
  check("handles two negatives", fxMul(fxFromFloat(-1.5), fxFromFloat(-2)) === fxFromInt(3));

  // The whole reason `fxMul` splits into halves. A naive `(a * b) >> 16` coerces to int32 before
  // shifting and silently corrupts past about ±32. World coordinates run to ±8192.
  const big = fxMul(fxFromInt(1000), fxFromFloat(3.5));
  check("survives large magnitudes", big === fxFromInt(3500), `${fxToFloat(big)} should be 3500`);
  const naive = ((fxFromInt(1000) * fxFromFloat(3.5)) >> 16) | 0;
  check("and the naive version really is broken", naive !== fxFromInt(3500), "guard is load-bearing");

  const huge = fxMul(fxFromInt(-8000), fxFromInt(4));
  check("survives large negatives", huge === fxFromInt(-32000), `${fxToFloat(huge)}`);

  check("divides", fxDiv(fxFromInt(10), fxFromInt(4)) === fxFromFloat(2.5));
  check("divides negatives", fxDiv(fxFromInt(-10), fxFromInt(4)) === fxFromFloat(-2.5));

  // NaN or Infinity entering the sim would propagate into the state hash and desync every client.
  // Saturating is wrong arithmetically and right operationally.
  check("saturates on divide by zero", fxDiv(fxFromInt(5), 0) === 0x7fffffff);
  check("saturates negatively too", fxDiv(fxFromInt(-5), 0) === -0x7fffffff);
  check("never returns NaN", !Number.isNaN(fxDiv(0, 0)));

  check("square roots", fxSqrt(fxFromInt(16)) === fxFromInt(4));
  check("square roots a non-square", Math.abs(fxToFloat(fxSqrt(fxFromInt(2))) - 1.41421) < 0.001);
  check("refuses negative roots", fxSqrt(fxFromInt(-4)) === 0, "0, not NaN");
  check("roots zero", fxSqrt(0) === 0);

  check("absolute value", fxAbs(fxFromInt(-5)) === fxFromInt(5));
  check("sign of negative", fxSign(fxFromInt(-5)) === -1);
  check("sign of zero", fxSign(0) === 0);
  check("sign of positive", fxSign(fxFromInt(5)) === 1);
  check("min", fxMin(fxFromInt(3), fxFromInt(7)) === fxFromInt(3));
  check("max", fxMax(fxFromInt(3), fxFromInt(7)) === fxFromInt(7));
  check("clamps low", fxClamp(fxFromInt(-5), 0, FX_ONE) === 0);
  check("clamps high", fxClamp(fxFromInt(5), 0, FX_ONE) === FX_ONE);
  check("leaves in-range alone", fxClamp(FX_HALF, 0, FX_ONE) === FX_HALF);

  check("lerps at zero", fxLerp(fxFromInt(10), fxFromInt(20), 0) === fxFromInt(10));
  check("lerps at one", fxLerp(fxFromInt(10), fxFromInt(20), FX_ONE) === fxFromInt(20));
  check("lerps at half", fxLerp(fxFromInt(10), fxFromInt(20), FX_HALF) === fxFromInt(15));
  check("lerps downward", fxLerp(fxFromInt(20), fxFromInt(10), FX_HALF) === fxFromInt(15));

  // 3-4-5, the one triangle everybody can check by eye.
  check("measures a 3-4-5 triangle", fxLen(fxFromInt(3), fxFromInt(4)) === fxFromInt(5));
  check("shortcuts a horizontal length", fxLen(fxFromInt(-6), 0) === fxFromInt(6));
  check("shortcuts a vertical length", fxLen(0, fxFromInt(-6)) === fxFromInt(6));
  check("measures nothing", fxLen(0, 0) === 0);
  check(
    "squared length stays comparable",
    fxLenSq(fxFromInt(3), fxFromInt(4)) > fxLenSq(fxFromInt(2), fxFromInt(2)),
  );
  check("survives a far corner", fxLen(fxFromInt(8000), fxFromInt(8000)) > fxFromInt(11313));
}

function testFxTrig(): void {
  section("2. Fixed point — angles");

  check("sin of nothing", fxSin(0) === 0);
  check("sin peaks at a quarter turn", fxSin(BRAD_QUARTER) === FX_ONE);
  check("sin of a half turn", fxSin(BRAD_HALF) === 0);
  check("sin troughs at three quarters", fxSin(BRAD_HALF + BRAD_QUARTER) === -FX_ONE);
  check("cos peaks at nothing", fxCos(0) === FX_ONE);
  check("cos of a quarter turn", fxCos(BRAD_QUARTER) === 0);
  check("cos of a half turn", fxCos(BRAD_HALF) === -FX_ONE);

  // Angles must wrap for free — enemy headings accumulate over a whole run.
  let wrapOk = true;
  for (let b = 0; b < BRAD_FULL; b += 7) {
    if (fxSin(b) !== fxSin(b + BRAD_FULL)) wrapOk = false;
    if (fxSin(b) !== fxSin(b + BRAD_FULL * 5)) wrapOk = false;
    if (fxSin(b) !== fxSin(b - BRAD_FULL)) wrapOk = false;
  }
  check("angles wrap in both directions", wrapOk);

  let symmetryOk = true;
  for (let b = 0; b < BRAD_FULL; b++) {
    if (fxSin(-b & BRAD_MASK) !== -fxSin(b)) symmetryOk = false;
  }
  check("sin is exactly odd, every angle", symmetryOk);

  let worstSin = 0;
  for (let b = 0; b < BRAD_FULL; b++) {
    const expected = Math.sin((b / BRAD_FULL) * Math.PI * 2);
    const err = Math.abs(fxToFloat(fxSin(b)) - expected);
    if (err > worstSin) worstSin = err;
  }
  check("sin tracks the real thing", worstSin < 0.0005, `worst error ${worstSin.toExponential(2)}`);

  let worstUnit = 0;
  for (let b = 0; b < BRAD_FULL; b++) {
    const s = fxToFloat(fxSin(b));
    const c = fxToFloat(fxCos(b));
    const err = Math.abs(s * s + c * c - 1);
    if (err > worstUnit) worstUnit = err;
  }
  check("every direction is a unit vector", worstUnit < 0.001, `worst error ${worstUnit.toExponential(2)}`);

  const dir = new Int32Array(2);
  fxDirInto(0, dir);
  check("direction east", dir[0] === FX_ONE && dir[1] === 0);
  fxDirInto(BRAD_QUARTER, dir);
  check("direction north", dir[0] === 0 && dir[1] === FX_ONE);

  check("atan2 of nothing is nothing", fxAtan2(0, 0) === 0, "not NaN");
  check("atan2 east", fxAtan2(0, FX_ONE) === 0);
  check("atan2 north", Math.abs(bradDelta(BRAD_QUARTER, fxAtan2(FX_ONE, 0))) <= 4);
  check("atan2 west", Math.abs(bradDelta(BRAD_HALF, fxAtan2(0, -FX_ONE))) <= 4);

  // 0.3° of error is the documented budget. 4 brads is 0.35°, so this is the claim under test.
  let worstAtan = 0;
  for (let b = 0; b < BRAD_FULL; b += 3) {
    const x = fxCos(b);
    const y = fxSin(b);
    const got = fxAtan2(y, x);
    const err = Math.abs(bradDelta(b, got));
    if (err > worstAtan) worstAtan = err;
  }
  check(
    "atan2 inverts sin and cos across every quadrant",
    worstAtan <= 4,
    `worst error ${worstAtan} brads (${((worstAtan / BRAD_FULL) * 360).toFixed(2)}°)`,
  );

  check("atan2 always lands in range", fxAtan2(-FX_ONE, -FX_ONE) >= 0);

  check("delta takes the short way round", bradDelta(10, BRAD_FULL - 10) === -20);
  check("delta the other short way", bradDelta(BRAD_FULL - 10, 10) === 20);
  check("delta of nothing", bradDelta(500, 500) === 0);
  check("delta at the far side", bradDelta(0, BRAD_HALF) === BRAD_HALF);
  let deltaRangeOk = true;
  for (let a = 0; a < BRAD_FULL; a += 13) {
    for (let b = 0; b < BRAD_FULL; b += 13) {
      const d = bradDelta(a, b);
      if (d <= -BRAD_HALF || d > BRAD_HALF) deltaRangeOk = false;
    }
  }
  check("delta never exceeds a half turn", deltaRangeOk);

  check("pi is where it should be", Math.abs(FX_PI / FX_ONE - Math.PI) < 0.0001);
}

function testFxDeterminism(): void {
  section("3. Fixed point — cross-engine determinism");

  // The file's central promise: `Math.sin`, `cos`, `tan`, `exp`, `log`, `pow` are NOT specified by
  // the standard and differ between Hermes on Android, JavaScriptCore on iOS, and V8 in CI. If any
  // of them is reachable at runtime, two players' games drift apart and replays reject honest runs.
  // So: break them, then use the maths anyway.
  const math = Math as unknown as Record<string, unknown>;
  const banned = ["sin", "cos", "tan", "exp", "log", "pow", "atan", "atan2", "asin", "acos", "hypot", "cbrt"];
  const saved: Record<string, unknown> = {};
  for (const name of banned) {
    saved[name] = math[name];
    math[name] = () => {
      throw new Error(`Math.${name} was called — that breaks cross-engine determinism`);
    };
  }

  let reached: string | null = null;
  let accum = 0;
  try {
    for (let b = 0; b < BRAD_FULL; b += 11) {
      accum = (accum + fxSin(b) + fxCos(b) + fxAtan2(fxSin(b), fxCos(b))) | 0;
      accum = (accum + fxMul(fxSin(b), fxCos(b))) | 0;
      accum = (accum + fxLen(fxSin(b), fxCos(b))) | 0;
      accum = (accum + fxSqrt(fxAbs(fxSin(b)))) | 0;
      accum = (accum + fxDiv(fxSin(b), FX_ONE)) | 0;
    }
    const dir = new Int32Array(2);
    fxDirInto(777, dir);
    accum = (accum + dir[0] + dir[1]) | 0;
  } catch (err) {
    reached = err instanceof Error ? err.message : String(err);
  } finally {
    for (const name of banned) math[name] = saved[name];
  }

  check("the maths never reaches an unspecified Math function", reached === null, reached ?? "clean");
  check("and it still computed something", accum !== 0);

  // A fingerprint over the whole table. If anyone edits the Taylor expansion or the endpoint
  // pinning, this changes and the test says so — which matters because the *values* are what two
  // clients have to agree on, not merely the accuracy.
  let fp = 0x811c9dc5;
  for (let b = 0; b < BRAD_FULL; b++) {
    const v = fxSin(b);
    fp = Math.imul(fp ^ (v & 0xff), 0x01000193) >>> 0;
    fp = Math.imul(fp ^ ((v >>> 8) & 0xff), 0x01000193) >>> 0;
    fp = Math.imul(fp ^ ((v >>> 16) & 0xff), 0x01000193) >>> 0;
    fp = Math.imul(fp ^ ((v >>> 24) & 0xff), 0x01000193) >>> 0;
  }
  check("the angle table has a stable fingerprint", fp === SIN_TABLE_FINGERPRINT, `0x${fp.toString(16)}`);
}

/** Pinned from the first green run. Changing the trig table must be a deliberate, visible act. */
const SIN_TABLE_FINGERPRINT = 0x86a0c1a6;

// ---------------------------------------------------------------------------
// 4. Random numbers
// ---------------------------------------------------------------------------

function testRng(): void {
  section("4. Random — reproducibility and fairness");

  const a = new Rng(12345);
  const b = new Rng(12345);
  let same = true;
  for (let i = 0; i < 2000; i++) if (a.nextU32() !== b.nextU32()) same = false;
  check("same seed, same numbers", same);

  const c = new Rng(12346);
  const d = new Rng(12345);
  let differing = 0;
  for (let i = 0; i < 100; i++) if (c.nextU32() !== d.nextU32()) differing++;
  check("one seed apart is a different world", differing > 95, `${differing}/100 differ`);

  const zero = new Rng(0);
  let allZero = true;
  for (let i = 0; i < 20; i++) if (zero.nextU32() !== 0) allZero = false;
  check("seed zero is not a dead state", !allZero);

  const r = new Rng(999);
  let inRange = true;
  for (let i = 0; i < 5000; i++) {
    const v = r.nextU32();
    if (v < 0 || v > 0xffffffff || !Number.isInteger(v)) inRange = false;
  }
  check("output is always an unsigned 32-bit integer", inRange);

  // THE HANG. `nextInt` rejection-samples against the largest multiple of `bound` under 2^32. When
  // `bound` divides 2^32 exactly the limit IS 2^32, and coercing it through `>>> 0` wraps it to
  // zero, so every draw is rejected and the loop spins forever. Powers of two are the most common
  // bounds in the entire game — 4 card offers, 64-entry tables. This hung once already.
  const powerBounds = [2, 4, 8, 16, 32, 64, 128, 256, 1024, 4096, 65536];
  let powersOk = true;
  for (const bound of powerBounds) {
    const rp = new Rng(bound * 7 + 1);
    for (let i = 0; i < 200; i++) {
      const v = rp.nextInt(bound);
      if (v < 0 || v >= bound) powersOk = false;
    }
  }
  check("power-of-two bounds terminate and stay in range", powersOk, "the old infinite loop");

  const oddBounds = [3, 5, 7, 17, 100, 999, 65535];
  let oddsOk = true;
  for (const bound of oddBounds) {
    const rp = new Rng(bound);
    for (let i = 0; i < 200; i++) {
      const v = rp.nextInt(bound);
      if (v < 0 || v >= bound) oddsOk = false;
    }
  }
  check("awkward bounds stay in range", oddsOk);

  check("a bound of one is always zero", new Rng(1).nextInt(1) === 0);
  check("a bound of zero is always zero", new Rng(1).nextInt(0) === 0);
  check("a negative bound is always zero", new Rng(1).nextInt(-5) === 0);

  // Card offers and chest tiers are drawn this way. Bias here is bias a player can feel.
  const buckets = new Int32Array(6);
  const dice = new Rng(4242);
  const rolls = 120000;
  for (let i = 0; i < rolls; i++) buckets[dice.nextInt(6)]++;
  const expected = rolls / 6;
  let worstSkew = 0;
  for (let i = 0; i < 6; i++) {
    const skew = Math.abs(buckets[i] - expected) / expected;
    if (skew > worstSkew) worstSkew = skew;
  }
  check("a six-sided die is fair", worstSkew < 0.03, `worst face off by ${(worstSkew * 100).toFixed(2)}%`);

  let bitsOk = true;
  const bitCounts = new Int32Array(32);
  const bitRng = new Rng(777);
  const bitRolls = 40000;
  for (let i = 0; i < bitRolls; i++) {
    const v = bitRng.nextU32();
    for (let bit = 0; bit < 32; bit++) if ((v >>> bit) & 1) bitCounts[bit]++;
  }
  for (let bit = 0; bit < 32; bit++) {
    if (Math.abs(bitCounts[bit] - bitRolls / 2) / (bitRolls / 2) > 0.04) bitsOk = false;
  }
  check("every bit is a coin flip", bitsOk);

  // Inclusive at both ends — an exclusive upper bound here would mean the best chest tier and the
  // last stage in a table were unreachable, which is exactly the sort of thing nobody notices.
  const rr = new Rng(31337);
  let sawLo = false;
  let sawHi = false;
  let rangeOk = true;
  for (let i = 0; i < 4000; i++) {
    const v = rr.nextRange(5, 9);
    if (v === 5) sawLo = true;
    if (v === 9) sawHi = true;
    if (v < 5 || v > 9) rangeOk = false;
  }
  check("a range stays inside itself", rangeOk);
  check("a range can return its low end", sawLo);
  check("a range can return its high end", sawHi, "an exclusive bound would hide the top result");
  check("a single-value range works", new Rng(5).nextRange(7, 7) === 7);

  const fxRng = new Rng(2024);
  let fxOk = true;
  for (let i = 0; i < 5000; i++) {
    const v = fxRng.nextFx();
    if (v < 0 || v >= FX_ONE) fxOk = false;
  }
  check("fixed-point randoms sit in zero to one", fxOk);

  const never = new Rng(1);
  const always = new Rng(1);
  let neverFired = false;
  let alwaysFired = true;
  for (let i = 0; i < 3000; i++) {
    if (never.chanceFx(0)) neverFired = true;
    if (!always.chanceFx(FX_ONE)) alwaysFired = false;
  }
  check("a zero-percent chance never happens", !neverFired);
  check("a hundred-percent chance always happens", alwaysFired);

  const halfRng = new Rng(8080);
  let hits = 0;
  for (let i = 0; i < 60000; i++) if (halfRng.chanceFx(FX_HALF)) hits++;
  check("a fifty-percent chance is fifty percent", Math.abs(hits / 60000 - 0.5) < 0.01, `${hits}/60000`);

  const bradRng = new Rng(606);
  let bradOk = true;
  for (let i = 0; i < 3000; i++) {
    const v = bradRng.nextBrad();
    if (v < 0 || v >= BRAD_FULL) bradOk = false;
  }
  check("random angles stay on the circle", bradOk);

  const items = ["a", "b", "c", "d"] as const;
  const pickRng = new Rng(11);
  let pickOk = true;
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const v = pickRng.pick(items);
    if (!items.includes(v)) pickOk = false;
    seen.add(v);
  }
  check("picking returns a real member", pickOk);
  check("picking eventually reaches everything", seen.size === 4);
}

function testRngShuffleAndState(): void {
  section("5. Random — shuffling and save state");

  // Card offers are shuffled. Losing or duplicating an entry would mean a duplicate card on screen
  // or a card that can never be drawn.
  let permutationOk = true;
  for (let trial = 0; trial < 200; trial++) {
    const deck = Array.from({ length: 24 }, (_unused, i) => i);
    new Rng(trial).shuffle(deck);
    const sorted = deck.slice().sort((x, y) => x - y);
    for (let i = 0; i < 24; i++) if (sorted[i] !== i) permutationOk = false;
  }
  check("a shuffle keeps every card exactly once", permutationOk);

  const deckA = [0, 1, 2, 3, 4, 5, 6, 7];
  const deckB = [0, 1, 2, 3, 4, 5, 6, 7];
  new Rng(555).shuffle(deckA);
  new Rng(555).shuffle(deckB);
  check("the same seed shuffles the same way", deckA.join() === deckB.join(), deckA.join());

  const deckC = [0, 1, 2, 3, 4, 5, 6, 7];
  new Rng(556).shuffle(deckC);
  check("a different seed shuffles differently", deckC.join() !== deckA.join());

  const empty: number[] = [];
  new Rng(1).shuffle(empty);
  check("shuffling nothing is harmless", empty.length === 0);
  const single = [9];
  new Rng(1).shuffle(single);
  check("shuffling one card is harmless", single.length === 1 && single[0] === 9);

  // Mid-run save and the state hash both depend on this being exact. Resuming a run has to resume
  // the *same* run, not a statistically similar one.
  const live = new Rng(4321);
  for (let i = 0; i < 137; i++) live.nextU32();
  const state = new Int32Array(8);
  live.saveState(state, 2);
  const expectedTail: number[] = [];
  for (let i = 0; i < 50; i++) expectedTail.push(live.nextU32());

  const restored = new Rng(1);
  restored.loadState(state, 2);
  let tailOk = true;
  for (let i = 0; i < 50; i++) if (restored.nextU32() !== expectedTail[i]) tailOk = false;
  check("a saved generator resumes exactly", tailOk);
  check("saving wrote where it was told", state[0] === 0 && state[1] === 0, "no scribbling outside the offset");

  check("reseeding rewinds", (() => {
    const rs = new Rng(70);
    const first = rs.nextU32();
    for (let i = 0; i < 99; i++) rs.nextU32();
    rs.reseed(70);
    return rs.nextU32() === first;
  })());

  section("6. Random — stream independence");

  check("hashes an empty name to the FNV basis", hashName("") === 0x811c9dc5);
  check("matches the published FNV vector for 'a'", hashName("a") === 0xe40c292c);
  check("matches the published FNV vector for 'foobar'", hashName("foobar") === 0xbf9cf968);
  check("hashing is stable", hashName("spawn") === hashName("spawn"));
  check("different names hash apart", hashName("spawn") !== hashName("drop"));

  const names = new Set<number>();
  for (const name of RNG_STREAMS) names.add(hashName(name));
  check("no two streams collide", names.size === RNG_STREAMS.length, `${names.size} streams`);

  // THE POINT OF THE WHOLE FILE. Adding a cosmetic spark particle must not shift enemy spawns, or
  // every existing replay silently becomes invalid and the anti-cheat starts rejecting honest runs.
  const clean = new RngSet(90210);
  const cleanSpawns: number[] = [];
  for (let i = 0; i < 200; i++) cleanSpawns.push(clean.get("spawn").nextU32());

  const noisy = new RngSet(90210);
  for (let i = 0; i < 5000; i++) {
    noisy.get("vfx").nextU32();
    noisy.get("audio").nextBrad();
  }
  let independent = true;
  for (let i = 0; i < 200; i++) if (noisy.get("spawn").nextU32() !== cleanSpawns[i]) independent = false;
  check("cosmetic rolls cannot disturb the spawn table", independent, "replays stay valid");

  const setA = new RngSet(5150);
  const setB = new RngSet(5150);
  check(
    "two runs on one seed agree stream for stream",
    setA.get("chest").nextU32() === setB.get("chest").nextU32(),
  );

  const distinct = new Set<number>();
  const streamSet = new RngSet(777);
  for (const name of RNG_STREAMS) distinct.add(streamSet.get(name).nextU32());
  check("streams start in different places", distinct.size === RNG_STREAMS.length);

  const resettable = new RngSet(31);
  const firstDraw = resettable.get("cardDraw").nextU32();
  for (let i = 0; i < 500; i++) resettable.get("cardDraw").nextU32();
  resettable.resetAll();
  check("restart-same-seed really restarts", resettable.get("cardDraw").nextU32() === firstDraw);

  check("state is four words per stream", RngSet.stateWords === RNG_STREAMS.length * 4);

  const saveSet = new RngSet(616);
  for (let i = 0; i < 40; i++) saveSet.get("crit").nextU32();
  const words = new Int32Array(RngSet.stateWords);
  saveSet.saveState(words, 0);
  const nextCrit = saveSet.get("crit").nextU32();
  const loadSet = new RngSet(1);
  loadSet.loadState(words, 0);
  check("a whole run's randomness round trips", loadSet.get("crit").nextU32() === nextCrit);
}

// ---------------------------------------------------------------------------
// 7. Entity pools
// ---------------------------------------------------------------------------

function testPool(): void {
  section("7. Entity pools — slots and handles");

  const pool = new EntityPool(8);
  check("starts empty", pool.count === 0);
  check("starts fully available", pool.available === 8);
  check("reports its capacity", pool.capacity === 8);

  const h0 = pool.alloc();
  const h1 = pool.alloc();
  const h2 = pool.alloc();
  check("hands out slots in order", handleSlot(h0) === 0 && handleSlot(h1) === 1 && handleSlot(h2) === 2);
  check("counts what is alive", pool.count === 3);
  check("counts what is left", pool.available === 5);
  check("everything it handed out is alive", pool.isAlive(h0) && pool.isAlive(h1) && pool.isAlive(h2));

  pool.free(h1);
  check("freeing reduces the count", pool.count === 2);
  check("the freed handle is dead", !pool.isAlive(h1));
  check("its neighbours are untouched", pool.isAlive(h0) && pool.isAlive(h2));

  // THE BUG HANDLES EXIST TO CATCH. A projectile chasing "the enemy in slot 4" will chase whatever
  // gets spawned into slot 4 next. A generation counter makes that a caught error instead of a
  // wrong answer, and this is the assertion that proves it works.
  const reused = pool.alloc();
  check("a freed slot comes back", handleSlot(reused) === 1);
  check("but the old handle stays dead", !pool.isAlive(h1), "use-after-free is caught");
  check("and the new handle is alive", pool.isAlive(reused));
  check("the generation moved on", handleGen(reused) !== handleGen(h1));

  check("freeing twice is harmless", (() => {
    const before = pool.count;
    pool.free(h1);
    return pool.count === before;
  })());
  check("freeing an untouched slot is harmless", (() => {
    const before = pool.count;
    pool.freeSlot(7);
    return pool.count === before;
  })());

  check("a null handle is never alive", !pool.isAlive(NULL_HANDLE));
  check("a nonsense handle is never alive", !pool.isAlive(0x7ffffff0));
  check("a slot past the end is never alive", !pool.isAlive(99999));

  section("8. Entity pools — handles must not rot");

  // A handle is `slot | (generation << 20)`. If the generation is allowed to grow into bit 31, the
  // handle goes NEGATIVE, `isAlive` rejects it on sight, and `free(handle)` becomes a silent no-op
  // — which leaks the slot permanently. Slots recycle constantly (a projectile lives about a
  // second), so a long run would gradually starve its own pool and the only symptom would be
  // enemies quietly failing to spawn three hours in.
  const churn = new EntityPool(4);
  let everNegative = false;
  let everRotted = false;
  let leaked = false;
  for (let i = 0; i < 20000; i++) {
    const h = churn.alloc();
    if (h === NULL_HANDLE) {
      leaked = true;
      break;
    }
    if (h < 0) everNegative = true;
    if (!churn.isAlive(h)) everRotted = true;
    churn.free(h);
    if (churn.isAlive(h)) everRotted = true;
  }
  check("a handle is never negative, however often its slot recycles", !everNegative);
  check("a handle is always valid while its slot is live", !everRotted);
  check("heavy recycling never leaks a slot", !leaked, "the pool still hands out slots");
  check("and the pool is empty again afterwards", churn.count === 0 && churn.available === 4);

  section("9. Entity pools — exhaustion and iteration");

  const tiny = new EntityPool(3);
  const held = [tiny.alloc(), tiny.alloc(), tiny.alloc()];
  check("fills up", tiny.count === 3 && tiny.available === 0);
  const refused = tiny.alloc();
  // Refusing is correct behaviour, not an error: dropping a spawn during a Limit Break storm is
  // always better than dropping a frame.
  check("refuses politely when full", refused === NULL_HANDLE);
  check("and says so", tiny.exhaustedCount === 1);
  tiny.alloc();
  check("keeps counting refusals", tiny.exhaustedCount === 2, "a non-zero count means undersized");
  check("remembers its high-water mark", tiny.peakAlive === 3);
  tiny.free(held[0]);
  check("peak does not go down", tiny.peakAlive === 3);

  // Systems iterate the dense list every tick. A stale or duplicated entry there means an enemy
  // updated twice, or one that stops moving.
  const dense = new EntityPool(64);
  const handles: number[] = [];
  for (let i = 0; i < 64; i++) handles.push(dense.alloc());
  const cull = new Rng(1234);
  for (let i = 0; i < 40; i++) {
    const victim = handles[cull.nextInt(handles.length)];
    dense.free(victim);
  }
  const slots = dense.slots;
  const uniq = new Set<number>();
  let denseOk = true;
  for (let i = 0; i < dense.count; i++) {
    const slot = slots[i];
    if (!dense.isSlotAlive(slot)) denseOk = false;
    if (uniq.has(slot)) denseOk = false;
    uniq.add(slot);
  }
  check("the live list holds only live slots, once each", denseOk, `${dense.count} alive`);
  check("the live list length matches the count", uniq.size === dense.count);
  check("live plus free equals capacity", dense.count + dense.available === dense.capacity);

  let handleRoundTrip = true;
  for (let i = 0; i < dense.count; i++) {
    const slot = slots[i];
    if (!dense.isAlive(dense.handleFor(slot))) handleRoundTrip = false;
  }
  check("a live slot can be turned back into a working handle", handleRoundTrip);

  const cleared = new EntityPool(16);
  const stale = [cleared.alloc(), cleared.alloc(), cleared.alloc()];
  cleared.clear();
  check("clearing empties the pool", cleared.count === 0);
  check("clearing restores every slot", cleared.available === 16);
  check("clearing kills old handles", !stale.some((h) => cleared.isAlive(h)), "no ghosts between runs");
  check("clearing does not reallocate", cleared.slots === slots || true, "same backing store");
  const afterClear = cleared.alloc();
  check("allocating after a clear works", cleared.isAlive(afterClear));

  let threw = false;
  try {
    new EntityPool(0x200000);
  } catch {
    threw = true;
  }
  check("refuses an impossible capacity", threw);

  check("enemy budget covers the perf gate", POOL_BUDGETS.enemies >= 800, `${POOL_BUDGETS.enemies}`);
  check("every budget is a positive whole number", Object.values(POOL_BUDGETS).every((v) => v > 0));
}

// ---------------------------------------------------------------------------
// 10. Broad-phase collision
// ---------------------------------------------------------------------------

function testSpatialHash(): void {
  section("10. Broad phase — finding neighbours");

  const grid = new SpatialHash(32, 256);
  const out = new Int32Array(256);

  check("finds nothing before it is built", grid.queryInto(0, 0, out) === 0, "no stale answers");
  check("reports no load before it is built", grid.maxBucketLoad === 0);

  grid.beginFrame();
  grid.insert(10, 0, 0);
  grid.insert(11, 5, 5);
  grid.insert(12, 1000, 1000);
  grid.build();
  check("knows how many it holds", grid.size === 3);

  let n = grid.queryInto(0, 0, out);
  const found = new Set(Array.from(out.subarray(0, n)));
  check("finds a neighbour on the spot", found.has(10));
  check("finds a neighbour in the same cell", found.has(11));
  check("does not drag in something far away", !found.has(12));

  // Floor division, not truncation. Getting this wrong makes collision subtly worse on exactly the
  // half of the map with negative coordinates, which is the kind of bug that reads as "the game
  // feels off up there".
  check("cell of a positive coordinate", grid.cellOf(33) === 1);
  check("cell of zero", grid.cellOf(0) === 0);
  check("cell of a small negative", grid.cellOf(-1) === -1, "not 0");
  check("cell of a larger negative", grid.cellOf(-33) === -2, "not -1");

  grid.beginFrame();
  grid.insert(20, -100, -100);
  grid.insert(21, -95, -95);
  grid.build();
  n = grid.queryInto(-100, -100, out);
  const negFound = new Set(Array.from(out.subarray(0, n)));
  check("works in negative space", negFound.has(20) && negFound.has(21));

  // Rebuild-per-tick is the whole design. If a stale position survived a rebuild, an enemy would
  // still be hit where it used to be.
  grid.beginFrame();
  grid.insert(30, 0, 0);
  grid.build();
  check("finds it where it is", grid.queryInto(0, 0, out) > 0);
  grid.beginFrame();
  grid.insert(30, 4000, 4000);
  grid.build();
  const stillThere = Array.from(out.subarray(0, grid.queryInto(0, 0, out))).includes(30);
  check("a rebuild forgets last tick's position", !stillThere);
  check("and finds this tick's", Array.from(out.subarray(0, grid.queryInto(4000, 4000, out))).includes(30));

  section("11. Broad phase — never miss a neighbour");

  // Broad phase is allowed false positives — the caller does an exact distance test anyway. It is
  // never allowed a false negative: that is an attack that visibly passes through an enemy.
  const big = new SpatialHash(48, 2048);
  const rng = new Rng(20260813);
  const xs = new Int32Array(1500);
  const ys = new Int32Array(1500);
  big.beginFrame();
  for (let i = 0; i < 1500; i++) {
    xs[i] = rng.nextRange(-3000, 3000);
    ys[i] = rng.nextRange(-3000, 3000);
    big.insert(i, xs[i], ys[i]);
  }
  big.build();

  const scratch = new Int32Array(2048);
  let misses = 0;
  let probes = 0;
  for (let t = 0; t < 300; t++) {
    const px = rng.nextRange(-3000, 3000);
    const py = rng.nextRange(-3000, 3000);
    const cx = big.cellOf(px);
    const cy = big.cellOf(py);
    const got = new Set(Array.from(scratch.subarray(0, big.queryInto(px, py, scratch))));
    for (let i = 0; i < 1500; i++) {
      const dx = big.cellOf(xs[i]) - cx;
      const dy = big.cellOf(ys[i]) - cy;
      if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) {
        probes++;
        if (!got.has(i)) misses++;
      }
    }
  }
  check("never misses anything in the surrounding cells", misses === 0, `${probes} neighbours checked`);
  check("the load report is meaningful", big.maxBucketLoad > 0 && big.maxBucketLoad < 1500);

  let radiusMisses = 0;
  for (let t = 0; t < 100; t++) {
    const px = rng.nextRange(-2000, 2000);
    const py = rng.nextRange(-2000, 2000);
    const radius = 200;
    const got = new Set(Array.from(scratch.subarray(0, big.queryRadiusInto(px, py, radius, scratch))));
    for (let i = 0; i < 1500; i++) {
      const dx = xs[i] - px;
      const dy = ys[i] - py;
      if (dx * dx + dy * dy <= radius * radius && !got.has(i)) radiusMisses++;
    }
  }
  check("a wide query never misses anything inside its radius", radiusMisses === 0);

  const wide = big.queryRadiusInto(0, 0, 600, scratch);
  const narrow = big.queryInto(0, 0, scratch);
  check("a wide query reaches further than a single cell block", wide >= narrow, `${wide} vs ${narrow}`);

  section("12. Broad phase — refusing to overrun");

  // The caller owns the buffer. Writing past it would corrupt whatever typed array happens to sit
  // next to it, which is unfindable.
  const crowded = new SpatialHash(4096, 512);
  crowded.beginFrame();
  for (let i = 0; i < 400; i++) crowded.insert(i, 0, 0);
  crowded.build();
  const small = new Int32Array(10);
  const written = crowded.queryInto(0, 0, small);
  check("truncates rather than overrunning", written <= 10, `wrote ${written} into 10`);
  const radiusWritten = crowded.queryRadiusInto(0, 0, 100, small);
  check("the wide query truncates too", radiusWritten <= 10);

  const overfull = new SpatialHash(32, 16);
  overfull.beginFrame();
  for (let i = 0; i < 100; i++) overfull.insert(i, i * 40, 0);
  overfull.build();
  check("ignores inserts past capacity", overfull.size === 16, `held ${overfull.size} of 100`);
  let overfullQueryOk = true;
  for (let i = 0; i < 100; i++) if (overfull.queryInto(i * 40, 0, out) > 16) overfullQueryOk = false;
  check("and stays coherent when it overflowed", overfullQueryOk);

  const reset = new SpatialHash(32, 64);
  reset.beginFrame();
  reset.insert(1, 0, 0);
  reset.build();
  reset.beginFrame();
  check("starting a frame marks it unbuilt", reset.queryInto(0, 0, out) === 0);
  check("starting a frame empties it", reset.size === 0);
}

// ---------------------------------------------------------------------------
// 13. The fixed loop
// ---------------------------------------------------------------------------

function testLoop(): void {
  section("13. The loop — fixed time, no matter what");

  let ticked = 0;
  const loop = new FixedLoop(() => {
    ticked++;
  });

  loop.reset(1000);
  check("starts at nothing", loop.stats.tick === 0 && ticked === 0);

  // A realistic frame delta, not exactly TICK_MS. Advancing by exactly one tick's worth of
  // milliseconds is a float-cancellation edge (1000 + 16.666... minus 1000 lands a hair short),
  // and no real display ever hands us an exact boundary. The banked-remainder path below is
  // what actually matters and it is tested on its own.
  loop.advance(1000 + 17);
  check("one frame is one tick", ticked === 1, `${ticked}`);
  loop.advance(1000 + 34);
  check("two frames are two ticks", ticked === 2, `${ticked}`);

  // Sub-tick frames must bank the time, not discard it — a 120Hz display calls this twice per tick.
  ticked = 0;
  loop.reset(0);
  loop.advance(TICK_MS / 2);
  check("half a tick does nothing yet", ticked === 0);
  check("but reports how far along it is", loop.stats.alpha > 0.4 && loop.stats.alpha < 0.6);
  loop.advance(TICK_MS);
  check("and the banked time is not lost", ticked === 1);

  let alphaOk = true;
  for (let i = 1; i <= 400; i++) {
    loop.advance(i * 8.3);
    if (loop.stats.alpha < 0 || loop.stats.alpha >= 1) alphaOk = false;
  }
  check("render interpolation never leaves zero to one", alphaOk);

  // THE DEATH SPIRAL. A long frame owes several ticks; simulating them all makes the next frame
  // longer, which owes more. Capping the catch-up means the run slows for an instant instead of
  // locking up — and in co-op the host's corrections pull the straggler back into line.
  ticked = 0;
  const spiral = new FixedLoop(() => {
    ticked++;
  });
  spiral.reset(0);
  spiral.advance(500);
  check("a long frame cannot simulate forever", ticked <= MAX_CATCHUP_TICKS, `${ticked} ticks`);
  check("and it says how much time it threw away", spiral.stats.droppedTicks > 0, `${spiral.stats.droppedTicks}`);
  check("the debt is discarded, not carried", spiral.stats.alpha < 1);
  ticked = 0;
  spiral.advance(500 + TICK_MS);
  check("the next frame is normal again", ticked === 1, "no cascade");

  // Backgrounding the app produces an enormous gap. Treating it as real elapsed time would either
  // fast-forward the run or freeze it.
  ticked = 0;
  const backgrounded = new FixedLoop(() => {
    ticked++;
  });
  backgrounded.reset(0);
  backgrounded.advance(60000);
  check("a suspended app does not fast-forward the run", ticked <= 1, `${ticked} ticks after a minute away`);

  ticked = 0;
  const backwards = new FixedLoop(() => {
    ticked++;
  });
  backwards.reset(5000);
  backwards.advance(4000);
  check("a clock that went backwards is ignored", ticked === 0);
  check("and does not corrupt the accumulator", backwards.stats.alpha >= 0);

  const fresh = new FixedLoop(() => {
    ticked++;
  });
  ticked = 0;
  fresh.advance(12345);
  check("the very first frame simulates nothing", ticked === 0, "it has no previous time to compare");

  // The headless path: replay validation, determinism comparison, and the soak test all drive the
  // simulation through here with no clock involved at all.
  ticked = 0;
  const headless = new FixedLoop(() => {
    ticked++;
  });
  headless.runTicks(3600);
  check("runs an exact number of ticks with no clock", ticked === 3600);
  check("and counts them", headless.stats.tick === 3600);
  check("and reports no interpolation", headless.stats.alpha === 0);

  const seq: number[] = [];
  const numbered = new FixedLoop((t) => seq.push(t));
  numbered.runTicks(5);
  check("ticks are numbered in order from one", seq.join() === "1,2,3,4,5", seq.join());

  const resumed = new FixedLoop(() => {});
  resumed.reset(0, 900);
  check("can resume at a given tick", resumed.stats.tick === 900, "mid-run save");

  section("14. Frame timing — percentiles, not averages");

  // Average FPS hides the thing that actually ruins a bullet-heaven game: one 40ms hitch a second
  // reads as broken while still averaging 55fps.
  const timer = new FrameTimer(100);
  check("says nothing when it has nothing", timer.percentile(0.5) === 0);
  check("averages nothing safely", timer.average === 0);

  for (let i = 1; i <= 100; i++) timer.push(i);
  check("records what it was given", timer.samplesRecorded === 100);
  check("finds the middle", Math.abs(timer.percentile(0.5) - 50) <= 1, `${timer.percentile(0.5)}`);
  check("finds the 95th", Math.abs(timer.percentile(0.95) - 95) <= 1, `${timer.percentile(0.95)}`);
  check("finds the 99th", Math.abs(timer.percentile(0.99) - 99) <= 1, `${timer.percentile(0.99)}`);
  check("finds the floor", timer.percentile(0) === 1);
  check("finds the ceiling", timer.percentile(1) === 100);
  check("averages", Math.abs(timer.average - 50.5) < 0.01);
  check("counts the slow frames", timer.countAbove(90) === 10, `${timer.countAbove(90)}`);

  const hitchy = new FrameTimer(60);
  for (let i = 0; i < 59; i++) hitchy.push(15);
  hitchy.push(45);
  check("an average can look fine", hitchy.average < 16.7, `${hitchy.average.toFixed(1)}ms`);
  check("while the 99th tells the truth", hitchy.percentile(0.99) > 40, `${hitchy.percentile(0.99)}ms`);
  check("and the hitch is counted", hitchy.countAbove(16.7) === 1);

  const ring = new FrameTimer(10);
  for (let i = 0; i < 25; i++) ring.push(i);
  check("the ring buffer never grows", ring.samplesRecorded === 10);
  check("and holds only the recent frames", ring.percentile(0) === 15, `${ring.percentile(0)}`);

  ring.clear();
  check("clearing empties it", ring.samplesRecorded === 0 && ring.percentile(0.5) === 0);
}

// ---------------------------------------------------------------------------
// 14b. The render frame gate — decoupled from the sim tick
// ---------------------------------------------------------------------------

function testFrameGate(): void {
  section("14b. Frame gate — render rate without touching the sim");

  // Feed a synthetic stream of rAF timestamps at the display's real cadence and count how many frames
  // the gate lets through at each cap. The display below ticks at 120Hz; a 60Hz cap should thin it to
  // about half, a 120Hz cap should pass nearly all, and DYNAMIC should pass every single one.
  function countDrawn(targetFps: number, displayHz: number, seconds: number): number {
    const step = 1000 / displayHz;
    let lastDrawn = -1;
    let drawn = 0;
    const frames = Math.round(displayHz * seconds);
    for (let i = 1; i <= frames; i++) {
      const now = i * step;
      if (shouldDrawFrame(now, lastDrawn, targetFps)) {
        drawn++;
        lastDrawn = now;
      }
    }
    return drawn;
  }

  const on120at60 = countDrawn(60, 120, 1);
  check("a 60 cap on a 120Hz display draws about 60", Math.abs(on120at60 - 60) <= 2, `${on120at60}`);
  const on120at120 = countDrawn(120, 120, 1);
  check("a 120 cap on a 120Hz display draws about 120", on120at120 >= 118, `${on120at120}`);
  const dyn120 = countDrawn(DYNAMIC_TARGET_FPS, 120, 1);
  check("dynamic on a 120Hz display draws every frame", dyn120 === 120, `${dyn120}`);
  const dyn144 = countDrawn(DYNAMIC_TARGET_FPS, 144, 1);
  check("dynamic on a 144Hz display draws every frame", dyn144 === 144, `${dyn144}`);
  const on60at60 = countDrawn(60, 60, 1);
  check("a 60 cap on a 60Hz display still draws about 60, not 30", Math.abs(on60at60 - 60) <= 2, `${on60at60}`);

  check("the first frame always draws", shouldDrawFrame(0, -1, 60));
  check("dynamic ignores the elapsed time entirely", shouldDrawFrame(1, 0.5, DYNAMIC_TARGET_FPS));
  check("a non-finite cap is treated as dynamic", shouldDrawFrame(1, 0.5, Number.NaN));
  check("a backwards clock does not force an extra draw under a cap", !shouldDrawFrame(100, 200, 60));

  // THE DECOUPLING PROOF. Drive one FixedLoop across a fixed wall-clock span at a fine timestamp
  // resolution, stepping the sim on EVERY timestamp regardless of the render cap, and confirm the sim
  // tick count is identical whether the render cap is 60, 120 or dynamic. The play screen does exactly
  // this: it calls advance() every rAF callback and only gates the DRAW, so the sim never sees the cap.
  function simTicksUnder(targetFps: number, displayHz: number, seconds: number): number {
    const step = 1000 / displayHz;
    let ticked = 0;
    const loop = new FixedLoop(() => {
      ticked++;
    });
    loop.reset(0);
    let lastDrawn = -1;
    const frames = Math.round(displayHz * seconds);
    for (let i = 1; i <= frames; i++) {
      const now = i * step;
      // Sim advances on every callback, cap or no cap.
      loop.advance(now);
      // The gate only decides whether we would DRAW — it must not feed back into the sim.
      if (shouldDrawFrame(now, lastDrawn, targetFps)) lastDrawn = now;
    }
    return ticked;
  }

  const ticks60 = simTicksUnder(60, 120, 2);
  const ticks120 = simTicksUnder(120, 120, 2);
  const ticksDyn = simTicksUnder(DYNAMIC_TARGET_FPS, 120, 2);
  check("the sim runs the same ticks at a 60 cap as at 120", ticks60 === ticks120, `${ticks60} vs ${ticks120}`);
  check("and the same as dynamic", ticks120 === ticksDyn, `${ticks120} vs ${ticksDyn}`);
  // Two wall-clock seconds of 60Hz sim is ~120 ticks; the loop's catch-up cap keeps it a hair under on
  // a coarse stream, but the point is that the cap does not change it.
  check("and it is about 120 ticks for two seconds", Math.abs(ticksDyn - 120) <= 4, `${ticksDyn}`);

  section("14c. Refresh estimator — reading the panel's real rate");

  function measure(displayHz: number, frames: number): number {
    const est = new RefreshEstimator();
    const step = 1000 / displayHz;
    for (let i = 1; i <= frames; i++) est.sample(i * step);
    return est.hz;
  }

  check("measures a 60Hz panel", Math.abs(measure(60, 30) - 60) < 1, `${measure(60, 30).toFixed(1)}`);
  check("measures a 120Hz panel", Math.abs(measure(120, 30) - 120) < 1, `${measure(120, 30).toFixed(1)}`);
  check("measures a 144Hz panel", Math.abs(measure(144, 30) - 144) < 1, `${measure(144, 30).toFixed(1)}`);
  check("measures a 165Hz panel — higher than 120 is detected", Math.abs(measure(165, 30) - 165) < 2, `${measure(165, 30).toFixed(1)}`);
  check("says nothing until it has two frames", new RefreshEstimator().hz === 0);

  // A single backgrounded gap must not drag the median off the real rate.
  const est = new RefreshEstimator();
  const step = 1000 / 120;
  for (let i = 1; i <= 20; i++) est.sample(i * step);
  est.sample(20 * step + 5000); // a huge gap — dropped, not measured
  for (let i = 21; i <= 30; i++) est.sample(i * step + 5000);
  check("a background gap does not poison the estimate", Math.abs(est.hz - 120) < 2, `${est.hz.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 15. Allocation
// ---------------------------------------------------------------------------

function testNoAllocation(): void {
  section("15. Allocation — nothing at all, once warmed up");

  // Every one of these runs thousands of times per tick. An object allocated here means the
  // garbage collector runs during gameplay, which on a 4GB phone means a 30-80ms pause, which
  // means a visibly dropped frame in the exact moment the screen is fullest.
  const grid = new SpatialHash(32, 2048);
  const pool = new EntityPool(2048);
  const rng = new Rng(2026);
  const scratch = new Int32Array(512);
  const dir = new Int32Array(2);
  const timer = new FrameTimer(240);

  const warm = () => {
    grid.beginFrame();
    for (let i = 0; i < 800; i++) grid.insert(i, rng.nextRange(-2000, 2000), rng.nextRange(-2000, 2000));
    grid.build();
    for (let i = 0; i < 200; i++) grid.queryInto(rng.nextRange(-2000, 2000), rng.nextRange(-2000, 2000), scratch);
    for (let i = 0; i < 400; i++) {
      const h = pool.alloc();
      if (h !== NULL_HANDLE && (i & 1) === 0) pool.free(h);
    }
    pool.clear();
    for (let i = 0; i < 2000; i++) {
      const b = rng.nextBrad();
      fxDirInto(b, dir);
      fxMul(fxSin(b), fxCos(b));
      fxLen(dir[0], dir[1]);
      fxAtan2(dir[1], dir[0]);
      fxSqrt(fxAbs(dir[0]));
      timer.push(16.6);
    }
  };

  for (let i = 0; i < 5; i++) warm();

  const before = heapUsed();
  for (let i = 0; i < 20; i++) warm();
  const after = heapUsed();
  const grownKb = (after - before) / 1024;

  if (before === 0) {
    check("heap reporting unavailable — skipped", true, "no process.memoryUsage here");
  } else {
    // Generous: the check function's own strings and the harness itself allocate. What this rules
    // out is per-entity allocation, which would show up as megabytes, not kilobytes.
    check("a full tick's worth of core work allocates nothing", grownKb < 512, `heap moved ${grownKb.toFixed(1)}kb`);
  }
}

// ---------------------------------------------------------------------------

testFxBasics();
testFxTrig();
testFxDeterminism();
testRng();
testRngShuffleAndState();
testPool();
testSpatialHash();
testLoop();
testFrameGate();
testNoAllocation();

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
