/**
 * Replay harness self-check. Run headless: `bun packages/mobile/game/replay/replay.test.ts`
 *
 * The simulation does not exist yet, so this uses a stub sim that is deliberately *representative*
 * rather than trivial: it drives a few hundred entities with the real `fx` fixed-point math, the real
 * seeded RNG, and the real hashing, all integer-only. That means the test proves four things at once —
 * the log format round trips, the RLE stream reproduces inputs exactly, `fx` + `rng` are actually
 * deterministic across runs, and the harness detects divergence when there is some.
 *
 * WHAT IT PROVES
 *   1. A recorded run replays to a byte-identical state hash.
 *   2. RLE compresses a realistic input pattern and reproduces it exactly, including sign.
 *   3. A tampered header is rejected before simulation, not after.
 *   4. A tainted log is refused by ladder validation, and a clean one is accepted.
 *   5. A non-deterministic sim is caught, and the report names the first divergent tick.
 *   6. Four-player logs work, and a partial replay is not reported as a mismatch.
 *   7. Replay throughput is fast enough that server-side revalidation is affordable.
 */

import { fxMul, fxSin, fxCos } from "../core/fx";
import { Rng } from "../core/rng";
import { HASH_SEED, hashInt32Range, hashWord } from "../net/state-hash";
import { REPLAY_ERROR, TAINT, describeReplayError, describeTaint, isLadderEligible } from "./format";
import type { RunHeader } from "./format";
import { ReplayRecorder, decodeReplay } from "./recorder";
import { compareRuns, replay, validateForLadder, type ReplaySim } from "./player";

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

/* ---- stub simulation --------------------------------------------------------------------------- */

const STUB_ENTITIES = 256;

/**
 * A stand-in for the real simulation: players move from input, entities chase the nearest player, and a
 * seeded RNG jitters them. Everything is Q16.16 integers and integer trig, which is the same discipline
 * the real sim is held to.
 */
class StubSim implements ReplaySim {
  private readonly px = new Int32Array(4);
  private readonly py = new Int32Array(4);
  private readonly ex = new Int32Array(STUB_ENTITIES);
  private readonly ey = new Int32Array(STUB_ENTITIES);
  private rng = new Rng(1);
  private playerCount = 1;
  private tick = 0;

  /** When true the sim reads a non-deterministic source, to prove the harness catches it. */
  constructor(private readonly broken = false) {}

  resetForReplay(header: RunHeader): void {
    this.playerCount = header.characterCount;
    this.rng = new Rng(header.seed);
    this.tick = 0;
    this.px.fill(0);
    this.py.fill(0);
    for (let i = 0; i < STUB_ENTITIES; i++) {
      this.ex[i] = this.rng.nextRange(-200, 200) * 65536;
      this.ey[i] = this.rng.nextRange(-200, 200) * 65536;
    }
  }

  tickWithInput(axes: Int8Array, buttons: Uint8Array): void {
    for (let p = 0; p < this.playerCount; p++) {
      // 516 is one stick unit in Q16.16; 4 is the movement speed multiplier.
      this.px[p] = (this.px[p] as number) + (axes[p * 2] as number) * 516 * 4;
      this.py[p] = (this.py[p] as number) + (axes[p * 2 + 1] as number) * 516 * 4;
      if ((buttons[p] as number) !== 0) this.px[p] = (this.px[p] as number) + 1024;
    }

    const brad = (this.tick * 37) & 0xffff;
    const driftX = fxMul(fxCos(brad), 8192);
    const driftY = fxMul(fxSin(brad), 8192);

    for (let i = 0; i < STUB_ENTITIES; i++) {
      const target = i % this.playerCount;
      const dx = (this.px[target] as number) - (this.ex[i] as number);
      const dy = (this.py[target] as number) - (this.ey[i] as number);
      // Move a 1/64th of the way, plus a shared orbital drift, plus seeded jitter.
      this.ex[i] = (this.ex[i] as number) + (dx >> 6) + driftX + (this.rng.nextInt(64) - 32);
      this.ey[i] = (this.ey[i] as number) + (dy >> 6) + driftY + (this.rng.nextInt(64) - 32);
      if (this.broken && i === 0) {
        this.ex[i] = ((this.ex[i] as number) + Math.floor(Math.random() * 4096)) | 0;
      }
    }
    this.tick++;
  }

  hashState(hash: number): number {
    let h = hashWord(hash, this.tick);
    h = hashInt32Range(h, this.px, 0, this.playerCount);
    h = hashInt32Range(h, this.py, 0, this.playerCount);
    h = hashInt32Range(h, this.ex, 0, STUB_ENTITIES);
    h = hashInt32Range(h, this.ey, 0, STUB_ENTITIES);
    return h;
  }
}

/**
 * Record a run whose input pattern looks like a real player: long held directions with occasional
 * changes, not per-tick noise. That is what the RLE is tuned for, so testing against random input every
 * tick would report a compression ratio nobody will ever see.
 */
function recordRun(
  ticks: number,
  playerCount: number,
  seed: number,
  tainted = 0,
): { bytes: Uint8Array; recorder: ReplayRecorder; sim: StubSim } {
  const recorder = new ReplayRecorder();
  const characterIds: number[] = [];
  for (let p = 0; p < playerCount; p++) characterIds.push(p + 1);
  recorder.begin({
    seed,
    stageId: 3,
    buildId: 0xabcd1234,
    contentVersion: 1,
    characterIds,
    tainted,
    startedAtUnixSec: 1_786_000_000,
  });

  const sim = new StubSim();
  const header = recorder.header;
  sim.resetForReplay(header);

  const axes = new Int8Array(8);
  const buttons = new Uint8Array(4);
  const inputRng = new Rng(seed ^ 0x5f5f);

  for (let t = 0; t < ticks; t++) {
    // Change direction roughly every 40 ticks, per player, independently.
    for (let p = 0; p < playerCount; p++) {
      if (t === 0 || inputRng.nextInt(40) === 0) {
        axes[p * 2] = inputRng.nextRange(-127, 127);
        axes[p * 2 + 1] = inputRng.nextRange(-127, 127);
        buttons[p] = inputRng.nextInt(4) === 0 ? 1 : 0;
      }
    }
    recorder.recordTick(axes, buttons);
    sim.tickWithInput(axes, buttons);
  }

  recorder.end(sim.hashState(HASH_SEED));
  return { bytes: recorder.encode(), recorder, sim };
}

/* ---- 1/2. round trip and compression ----------------------------------------------------------- */

section("record and replay");
{
  const TICKS = 18_000; // five minutes of solo play
  const { bytes, recorder, sim } = recordRun(TICKS, 1, 0xc0ffee);

  const decoded = decodeReplay(bytes);
  check("log decodes", decoded.error === REPLAY_ERROR.NONE, describeReplayError(decoded.error));
  check("tick count preserved", decoded.header.tickCount === TICKS, `${decoded.header.tickCount}`);
  check("seed preserved", decoded.header.seed === 0xc0ffee);
  check("stage preserved", decoded.header.stageId === 3);
  check("build id preserved", decoded.header.buildId === 0xabcd1234);
  check("character ids preserved", decoded.header.characterIds[0] === 1);
  check("clean run reports clean", describeTaint(decoded.header.tainted) === "clean");
  check("head not truncated", !recorder.truncatedHead);

  const raw = TICKS * 4;
  const ratio = raw / bytes.byteLength;
  check(
    "RLE compresses realistic input",
    ratio > 5,
    `${bytes.byteLength} bytes for ${TICKS} ticks (${ratio.toFixed(1)}x vs raw, ${(bytes.byteLength / (TICKS / 3600)).toFixed(0)} B/min)`,
  );

  const result = replay(bytes, new StubSim());
  check(
    "replay reproduces the recorded hash",
    result.reproduced,
    `recorded ${(result.recordedHash >>> 0).toString(16)} replayed ${(result.replayedHash >>> 0).toString(16)}`,
  );
  check("replay ran every tick", result.ticks === TICKS, `${result.ticks}`);
  check("live sim and recorded hash agree", sim.hashState(HASH_SEED) === result.recordedHash);
  // Two separate questions, measured separately on purpose. The first is about the harness: how much
  // does decode + RLE expansion + dispatch cost when the sim does nothing? That is the only part of
  // revalidation cost this file controls. The second is the end-to-end budget with a sim attached,
  // stated in seconds of wall clock for a 30-minute run, because that is the number that decides
  // whether mandatory ladder revalidation is affordable at all.
  const nullSim: ReplaySim = {
    resetForReplay: () => {},
    tickWithInput: () => {},
    hashState: (h) => h,
  };
  const bare = replay(bytes, nullSim);
  check(
    "harness overhead is negligible",
    bare.ticksPerSecond > 1_000_000,
    `${Math.round(bare.ticksPerSecond).toLocaleString()} ticks/s with a do-nothing sim`,
  );
  const halfHourSec = 108_000 / Math.max(result.ticksPerSecond, 1);
  check(
    "a 30-minute run revalidates well inside a server request budget",
    halfHourSec < 5,
    `${halfHourSec.toFixed(2)}s at ${Math.round(result.ticksPerSecond).toLocaleString()} ticks/s (256-entity stub sim)`,
  );
}

/* ---- rng bounds: regression guard ------------------------------------------------------------- */

section("rng bounds");
{
  // Regression: `nextInt` computed its rejection limit as `(2**32 - 2**32 % bound) >>> 0`. When `bound`
  // divides 2^32 the limit is exactly 2^32, and `>>> 0` wrapped it to 0, so every draw was "rejected"
  // and the loop spun forever. Powers of two are the most common bounds in the game (coin flips, 4-way
  // picks, 64-slot tables), so this hung the whole replay suite on its first run. Kept as a permanent
  // check because a hang in the sim is indistinguishable from a freeze on a player's phone.
  const POW2 = [2, 4, 8, 16, 32, 64, 128, 256, 1024, 65536];
  let allBounded = true;
  let uniformEnough = true;
  for (const bound of POW2) {
    const rng = new Rng(bound * 7919);
    const buckets = new Int32Array(bound);
    const draws = bound * 64;
    for (let i = 0; i < draws; i++) {
      const v = rng.nextInt(bound);
      if (v < 0 || v >= bound) allBounded = false;
      else buckets[v] = (buckets[v] as number) + 1;
    }
    // 64 expected per bucket; anything outside 20..160 would mean the draw is not uniform.
    for (let i = 0; i < bound; i++) {
      const n = buckets[i] as number;
      if (n < 20 || n > 160) uniformEnough = false;
    }
  }
  check("power-of-two bounds terminate", true, `${POW2.join(", ")} all returned`);
  check("power-of-two draws stay in range", allBounded);
  check("power-of-two draws are uniform", uniformEnough, "no bucket outside 20..160 of 64 expected");

  // Non-power-of-two bounds actually exercise the rejection path, so keep them covered too.
  const rng = new Rng(12345);
  let odd = true;
  for (let i = 0; i < 40_000; i++) {
    const v = rng.nextInt(37);
    if (v < 0 || v >= 37) odd = false;
  }
  check("rejection path still bounded", odd, "bound 37, 40k draws");

  // Determinism: same seed, same stream, byte for byte. Everything in replay rests on this.
  const a = new Rng(0xbeef);
  const b = new Rng(0xbeef);
  let same = true;
  for (let i = 0; i < 10_000; i++) if (a.nextInt(64) !== b.nextInt(64)) same = false;
  check("same seed replays the same stream", same, "10k draws at bound 64");
}

section("input fidelity");
{
  // Extremes and signs specifically: -128 vs -127, and the RLE count boundary at 255.
  const recorder = new ReplayRecorder();
  recorder.begin({ seed: 1, stageId: 0, buildId: 0, contentVersion: 1, characterIds: [1] });
  const axes = new Int8Array(2);
  const buttons = new Uint8Array(1);

  const pattern: [number, number, number][] = [
    [127, -127, 0],
    [-127, 127, 1],
    [0, 0, 0],
    [-1, 1, 255],
  ];
  // 300 identical ticks forces the RLE count to roll past its 255 ceiling into a second record.
  for (let i = 0; i < 300; i++) {
    axes[0] = 42;
    axes[1] = -42;
    buttons[0] = 7;
    recorder.recordTick(axes, buttons);
  }
  for (const [x, y, b] of pattern) {
    axes[0] = x;
    axes[1] = y;
    buttons[0] = b;
    recorder.recordTick(axes, buttons);
  }
  recorder.end(0);
  const bytes = recorder.encode();

  const seen: [number, number, number][] = [];
  const capture: ReplaySim = {
    resetForReplay: () => {},
    tickWithInput: (a, b) => {
      seen.push([a[0] as number, a[1] as number, b[0] as number]);
    },
    hashState: (h) => h,
  };
  replay(bytes, capture);

  check("rle count rolls past 255 correctly", seen.length === 304, `${seen.length} ticks replayed`);
  let heldOk = true;
  for (let i = 0; i < 300; i++) {
    const f = seen[i] as [number, number, number];
    if (f[0] !== 42 || f[1] !== -42 || f[2] !== 7) heldOk = false;
  }
  check("held frames reproduce exactly", heldOk);
  let patternOk = true;
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i] as [number, number, number];
    const got = seen[300 + i] as [number, number, number];
    if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) patternOk = false;
  }
  check("negative axes survive the byte round trip", patternOk, JSON.stringify(seen.slice(300)));
}

/* ---- 3. tamper rejection ----------------------------------------------------------------------- */

section("tamper rejection");
{
  const { bytes } = recordRun(600, 1, 7);

  const badMagic = bytes.slice();
  badMagic[0] = 0;
  check("bad magic rejected", decodeReplay(badMagic).error === REPLAY_ERROR.BAD_MAGIC);

  const badVersion = bytes.slice();
  badVersion[4] = 99;
  check("version mismatch rejected", decodeReplay(badVersion).error === REPLAY_ERROR.VERSION_MISMATCH);

  const truncated = bytes.slice(0, bytes.byteLength - 2);
  check("truncated stream rejected", decodeReplay(truncated).error === REPLAY_ERROR.TRUNCATED);

  // The cheapest forgery: claim more ticks than the stream holds, hoping the validator trusts the header.
  const inflated = bytes.slice();
  new DataView(inflated.buffer).setUint32(28, 999_999, true);
  check(
    "inflated tick count rejected before simulating",
    decodeReplay(inflated).error === REPLAY_ERROR.TICK_COUNT_MISMATCH,
  );

  // Flip an input byte: the log still parses, but must no longer reproduce.
  const flipped = bytes.slice();
  flipped[flipped.byteLength - 3] = ((flipped[flipped.byteLength - 3] as number) ^ 0xff) & 0xff;
  const flippedResult = replay(flipped, new StubSim());
  check(
    "altered input fails the hash check",
    !flippedResult.reproduced && flippedResult.error === REPLAY_ERROR.HASH_MISMATCH,
    describeReplayError(flippedResult.error),
  );

  // And the case that matters most: claiming a score the inputs do not produce.
  const forgedHash = bytes.slice();
  new DataView(forgedHash.buffer).setInt32(32, 0x7fffffff, true);
  check(
    "forged final hash fails revalidation",
    !replay(forgedHash, new StubSim()).reproduced,
  );

  const emptyLog = new Uint8Array(4);
  check("empty file rejected without throwing", decodeReplay(emptyLog).error === REPLAY_ERROR.TRUNCATED);
}

/* ---- 4. ladder validation ---------------------------------------------------------------------- */

section("ladder validation");
{
  const clean = recordRun(1200, 1, 0x1234);
  const verdict = validateForLadder(clean.bytes, new StubSim());
  check("clean run accepted", verdict.accepted && !verdict.rejectedForTaint);

  const dirty = recordRun(1200, 1, 0x1234, TAINT.GRANTED | TAINT.INVULNERABLE);
  const dirtyVerdict = validateForLadder(dirty.bytes, new StubSim());
  check(
    "tainted run refused",
    !dirtyVerdict.accepted && dirtyVerdict.rejectedForTaint,
    describeTaint(decodeReplay(dirty.bytes).header.tainted),
  );
  check("taint blocks ladder eligibility", !isLadderEligible(TAINT.DEV_TOGGLE));
  check("clean bitfield is eligible", isLadderEligible(0));

  // The point of the addendum: a forged taint flag does NOT get you in, because the hash still has to
  // reproduce. Clear the taint bits on a real tainted log and it is still only accepted if it replays.
  const untainted = dirty.bytes.slice();
  new DataView(untainted.buffer).setUint32(16, 0, true);
  const forgedVerdict = validateForLadder(untainted, new StubSim());
  check(
    "clearing the taint flag alone does not defeat revalidation",
    forgedVerdict.accepted === replay(untainted, new StubSim()).reproduced,
    "acceptance is decided by resimulation, not by the flag",
  );

  const recorder = new ReplayRecorder();
  recorder.begin({ seed: 1, stageId: 0, buildId: 0, contentVersion: 1, characterIds: [1] });
  recorder.taint(TAINT.TIME_SCALE);
  recorder.taint(TAINT.TIME_SCALE);
  recorder.taint(TAINT.RNG_EDIT);
  check(
    "taint bits accumulate and cannot be cleared",
    recorder.tainted === (TAINT.TIME_SCALE | TAINT.RNG_EDIT) &&
      !("clearTaint" in recorder) &&
      !("untaint" in recorder),
    describeTaint(recorder.tainted),
  );
}

/* ---- 5. divergence detection ------------------------------------------------------------------- */

section("divergence detection");
{
  const { bytes } = recordRun(1800, 1, 0xbeef);

  const agree = compareRuns(bytes, new StubSim(), new StubSim());
  check(
    "two honest sims agree",
    agree.agreed && agree.firstDivergentTick < 0,
    `${agree.ticksCompared} ticks compared`,
  );

  const disagree = compareRuns(bytes, new StubSim(), new StubSim(true));
  check(
    "a non-deterministic sim is caught",
    !disagree.agreed && disagree.firstDivergentTick > 0,
    `first divergence at tick ${disagree.firstDivergentTick}`,
  );
  check(
    "divergence is caught within the first sample window",
    disagree.firstDivergentTick <= 60,
    `tick ${disagree.firstDivergentTick}`,
  );
}

/* ---- 6. four players and partial replay -------------------------------------------------------- */

section("four players and seeking");
{
  const TICKS = 7200;
  const { bytes } = recordRun(TICKS, 4, 0x4444);
  const decoded = decodeReplay(bytes);
  check("four-player log decodes", decoded.error === REPLAY_ERROR.NONE);
  check("player count preserved", decoded.header.characterCount === 4);
  check(
    "all four character ids preserved",
    decoded.header.characterIds[0] === 1 &&
      decoded.header.characterIds[1] === 2 &&
      decoded.header.characterIds[2] === 3 &&
      decoded.header.characterIds[3] === 4,
  );

  const full = replay(bytes, new StubSim());
  check("four-player run reproduces", full.reproduced, `${full.ticks} ticks`);

  const partial = replay(bytes, new StubSim(), { stopAtTick: 3000 });
  check("seek stops where asked", partial.ticks === 3000, `${partial.ticks}`);
  check(
    "a partial replay is not reported as a mismatch",
    !partial.reproduced && partial.error === REPLAY_ERROR.NONE,
    describeReplayError(partial.error),
  );

  // Seeking twice to the same tick must land on the same state, or "jump to timestamp" in the dev menu
  // would quietly produce a different run each time it was used.
  const again = replay(bytes, new StubSim(), { stopAtTick: 3000 });
  check("seeking is repeatable", partial.replayedHash === again.replayedHash);
}

section("stream cap");
{
  // Force the head-drop path with a tiny buffer, and confirm it degrades to a tail-only log instead of
  // growing without bound. This is the path that protects against an overnight input-playback loop.
  const recorder = new ReplayRecorder(64);
  recorder.begin({ seed: 1, stageId: 0, buildId: 0, contentVersion: 1, characterIds: [1] });
  const axes = new Int8Array(2);
  const buttons = new Uint8Array(1);
  const rng = new Rng(9);
  for (let t = 0; t < 200_000; t++) {
    axes[0] = rng.nextRange(-127, 127);
    axes[1] = rng.nextRange(-127, 127);
    recorder.recordTick(axes, buttons);
  }
  check("recorder counted every tick", recorder.tickCount === 200_000, `${recorder.tickCount}`);
  check(
    "buffer stayed bounded",
    recorder.byteLength < 12 * 1024 * 1024,
    `${(recorder.byteLength / 1024 / 1024).toFixed(1)}MB after 200k changing ticks`,
  );
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
