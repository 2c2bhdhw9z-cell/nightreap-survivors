/**
 * Netcode self-check. Run headless: `bun packages/mobile/game/net/net.test.ts`
 *
 * No test framework — this file is a script that prints a table and exits non-zero on failure, the
 * same shape as `game/bench/soak.test.ts`. That keeps it runnable in CI, in the sandbox, and from the
 * dev menu without dragging a runner into the mobile package.
 *
 * WHAT IT PROVES
 *   1. Every message survives encode -> decode byte-identically.
 *   2. The codec refuses to overflow and refuses to over-read, rather than corrupting silently.
 *   3. Input quantisation is stable and circular (diagonals are not faster than cardinals).
 *   4. The state hash is order-sensitive, NaN-stable and -0-stable.
 *   5. The correction sweep starves nothing: worst age stays bounded over a long run.
 *   6. The net clock closes a drift smoothly and snaps only past the ceiling.
 *   7. The plausibility monitor tolerates a hard legitimate run and trips on a modded one.
 */

import { NetClock } from "./clock";
import { Reader, Writer } from "./codec";
import { STARVATION_TICKS, CorrectionSweep } from "./correction";
import { InputHistory, axisToFx, quantiseStick } from "./input";
import {
  BREACH,
  PLAUSIBILITY,
  PlausibilityMonitor,
} from "./plausibility";
import {
  EVT,
  beginHostEvents,
  createWelcome,
  decodeInputBatchHeader,
  decodeInputFrame,
  decodeWelcome,
  encodeCorrection,
  encodeHello,
  encodeInputBatch,
  encodeStateHash,
  encodeWelcome,
  readCorrectionEntity,
  readCorrectionHeader,
  readEventHeader,
  writeEventHeader,
} from "./messages";
import { decodeHello } from "./messages";
import { MAX_DRIFT_TICKS, MSG, PROTOCOL_VERSION } from "./protocol";
import { HASH_SEED, HashTrail, hashFloat, hashWord } from "./state-hash";

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

/* ---- 1/2. codec + message round trips ---------------------------------------------------------- */

section("codec and message round trips");
{
  const w = new Writer();

  const helloBytes = encodeHello(w, 0xdeadbeef, "Brett", 0b1011);
  const hello = decodeHello(new Reader(helloBytes), {
    version: 0,
    buildId: 0,
    name: "",
    capabilities: 0,
  });
  check("HELLO type", new Reader(helloBytes).type === MSG.HELLO);
  check("HELLO version", hello.version === PROTOCOL_VERSION, `${hello.version}`);
  check("HELLO buildId", hello.buildId === 0xdeadbeef, hello.buildId.toString(16));
  check("HELLO name", hello.name === "Brett", hello.name);
  check("HELLO capabilities", hello.capabilities === 0b1011);

  // Multi-byte UTF-8 must survive, because generated names include non-ASCII glyphs.
  const utf8Bytes = encodeHello(w, 1, "Nachtläufer—漢", 0);
  const utf8 = decodeHello(new Reader(utf8Bytes), {
    version: 0,
    buildId: 0,
    name: "",
    capabilities: 0,
  });
  check("HELLO utf-8 round trip", utf8.name === "Nachtläufer—漢", utf8.name);

  const mods = new Int32Array([7, -3, 42]);
  const welcomeBytes = encodeWelcome(w, 2, 4, 0x1234abcd, 0b101, 9, mods, 3, 40_000);
  const welcome = decodeWelcome(new Reader(welcomeBytes), createWelcome());
  check("WELCOME slot", welcome.slot === 2);
  check("WELCOME playerCount", welcome.playerCount === 4);
  check("WELCOME seed", welcome.seed === 0x1234abcd, welcome.seed.toString(16));
  check("WELCOME tainted", welcome.tainted === 0b101);
  check("WELCOME stageId", welcome.stageId === 9);
  check("WELCOME tick", welcome.tick === 40_000);
  check(
    "WELCOME modifiers",
    welcome.modifierCount === 3 &&
      welcome.modifiers[0] === 7 &&
      welcome.modifiers[1] === -3 &&
      welcome.modifiers[2] === 42,
  );

  const axes = new Int8Array([127, 0, -127, 64, 0, -1]);
  const bits = new Uint8Array([1, 0, 3, 2, 5, 4]);
  const batchBytes = encodeInputBatch(w, 1, 12_345, 3, axes, bits);
  const reader = new Reader(batchBytes);
  const header = decodeInputBatchHeader(reader, { slot: 0, firstTick: 0, count: 0 });
  check("INPUT_BATCH header", header.slot === 1 && header.firstTick === 12_345 && header.count === 3);
  const frame = new Int32Array(4);
  let framesOk = true;
  for (let i = 0; i < header.count; i++) {
    decodeInputFrame(reader, frame);
    if (
      frame[0] !== axes[i * 2] ||
      frame[1] !== axes[i * 2 + 1] ||
      frame[2] !== bits[i * 2] ||
      frame[3] !== bits[i * 2 + 1]
    ) {
      framesOk = false;
    }
  }
  check("INPUT_BATCH frames", framesOk);
  check("INPUT_BATCH not truncated", !reader.truncated);

  const hashBytes = encodeStateHash(w, 0, 999, -12345);
  const hashReader = new Reader(hashBytes);
  check("STATE_HASH", hashReader.u32() === 999 && hashReader.i32() === -12345);

  // Negative hashes are the common case (FNV-1a fills the sign bit), so i32 must round trip signed.
  const negBytes = encodeStateHash(w, 0, 1, -1);
  const negReader = new Reader(negBytes);
  negReader.u32();
  check("STATE_HASH signed", negReader.i32() === -1);

  const indices = new Int32Array([5, 9]);
  const generations = new Uint16Array(16);
  generations[5] = 3;
  generations[9] = 700;
  const px = new Int32Array(16);
  const py = new Int32Array(16);
  px[5] = 1 << 20;
  py[5] = -(1 << 20);
  px[9] = 12345;
  py[9] = -12345;
  const corrBytes = encodeCorrection(w, 0, 77, indices, 2, generations, px, py);
  const corrReader = new Reader(corrBytes);
  const corrHeader = readCorrectionHeader(corrReader, { tick: 0, count: 0 });
  const ent = new Int32Array(4);
  readCorrectionEntity(corrReader, ent);
  const first = ent[0] === 5 && ent[1] === 3 && ent[2] === 1 << 20 && ent[3] === -(1 << 20);
  readCorrectionEntity(corrReader, ent);
  const second = ent[0] === 9 && ent[1] === 700 && ent[2] === 12345 && ent[3] === -12345;
  check("CORRECTION", corrHeader.tick === 77 && corrHeader.count === 2 && first && second);

  beginHostEvents(w, 0, 500);
  const wrote = writeEventHeader(w, EVT.SPAWN, 4, 500);
  w.u16(11).u16(22);
  const evtBytes = w.finish();
  const evtReader = new Reader(evtBytes);
  evtReader.u32();
  evtReader.u8();
  const evtHeader = readEventHeader(evtReader, { kind: 0, byteLength: 0, tick: 0 });
  check(
    "HOST_EVENTS event header",
    wrote && evtHeader.kind === EVT.SPAWN && evtHeader.byteLength === 4 && evtHeader.tick === 500,
  );
}

section("codec safety");
{
  // 4-byte header + two u32 bodies == 12, so this writer fills exactly.
  const small = new Writer(12);
  small.begin(MSG.PING, 0).u32(1).u32(2);
  check("writer fills to capacity without flagging", !small.overflowed && small.length === 12);
  small.u8(3);
  check("writer flags overflow instead of corrupting", small.overflowed && small.length === 12);

  // A Reader starts its cursor past the 4-byte header, so 8 bytes hold exactly one u32 body.
  const shortReader = new Reader(new Uint8Array(8));
  shortReader.u32();
  check("reader reads within bounds", !shortReader.truncated);
  shortReader.u32();
  check("reader flags truncation instead of reading garbage", shortReader.truncated);

  // A string longer than 255 bytes must truncate, not overflow the u8 length prefix.
  const strWriter = new Writer(512);
  strWriter.begin(MSG.HELLO, 0).str("x".repeat(400));
  const strReader = new Reader(strWriter.finish());
  check("over-long string truncates to 255", strReader.str().length === 255);
}

/* ---- 3. input quantisation --------------------------------------------------------------------- */

section("input quantisation");
{
  const out = new Int8Array(2);

  quantiseStick(1, 0, out, 0);
  const cardinal = Math.hypot(out[0] as number, out[1] as number);
  quantiseStick(1, 1, out, 0);
  const diagonal = Math.hypot(out[0] as number, out[1] as number);
  check(
    "stick is circular, not square",
    Math.abs(cardinal - diagonal) <= 1,
    `cardinal=${cardinal.toFixed(1)} diagonal=${diagonal.toFixed(1)}`,
  );

  quantiseStick(5, -5, out, 0);
  check("clipped magnitude keeps direction", (out[0] as number) === -(out[1] as number));

  check("full tilt maps to <= 1.0 in Q16.16", axisToFx(127) <= 65536, `${axisToFx(127)}`);

  const history = new InputHistory(256);
  history.write(100, 50, -20, 3, 0);
  check("history reads back", history.stickX(100) === 50 && history.stickY(100) === -20);
  check("history rejects stale slot", history.stickX(100 + 256) === 0);
  check("prediction repeats last frame", history.predictFrom(101) && history.stickX(101) === 50);
  check("prediction fails with nothing to repeat", !history.predictFrom(5000));

  // Negative ticks must not index out of the ring — a joining guest can legitimately compute one.
  history.write(-3, 10, 10, 0, 0);
  check("negative tick is addressable", history.stickX(-3) === 10);
}

/* ---- 4. state hash ----------------------------------------------------------------------------- */

section("state hash");
{
  const a = hashWord(hashWord(HASH_SEED, 1), 2);
  const b = hashWord(hashWord(HASH_SEED, 2), 1);
  check("hash is order sensitive", a !== b, `${a >>> 0} vs ${b >>> 0}`);

  check(
    "NaN payloads normalise",
    hashFloat(HASH_SEED, Number.NaN) === hashFloat(HASH_SEED, 0 / 0),
  );
  check("negative zero normalises", hashFloat(HASH_SEED, -0) === hashFloat(HASH_SEED, 0));
  check("distinct floats differ", hashFloat(HASH_SEED, 1.5) !== hashFloat(HASH_SEED, 1.5000001));

  const trail = new HashTrail(8);
  for (let t = 0; t < 12; t++) trail.record(t, t * 7);
  check("trail keeps recent", trail.at(11) === 77 && trail.has(11));
  check("trail drops oldest", !trail.has(0));
  check("trail reports oldest retained", trail.oldestTick() === 4, `${trail.oldestTick()}`);
}

/* ---- 5. correction sweep ----------------------------------------------------------------------- */

section("correction sweep");
{
  const capacity = 2000;
  const sweep = new CorrectionSweep(capacity);
  const alive = new Uint8Array(capacity).fill(1);
  const posX = new Int32Array(capacity);
  const posY = new Int32Array(capacity);
  for (let i = 0; i < capacity; i++) {
    posX[i] = ((i % 50) - 25) * 65536 * 4;
    posY[i] = (Math.floor(i / 50) - 20) * 65536 * 4;
  }
  const playerX = new Int32Array([0, 0, 0, 0]);
  const playerY = new Int32Array([0, 0, 0, 0]);
  const out = new Int32Array(64);

  check("budget is 5% of live", sweep.budgetFor(1000) === 50, `${sweep.budgetFor(1000)}`);
  check("budget clamps to message ceiling", sweep.budgetFor(100_000) === 64);
  check("budget is at least one", sweep.budgetFor(3) === 1);
  check("budget is zero when empty", sweep.budgetFor(0) === 0);

  let totalSent = 0;
  for (let tick = 0; tick < 3600; tick++) {
    totalSent += sweep.plan(out, tick, alive, posX, posY, playerX, playerY, 1, capacity);
  }
  const worst = sweep.worstAge(3600, alive);
  // The regression this guards: before the starvation rule, 75% of entities were never swept at all
  // and this read 3600. The bound is STARVATION_TICKS plus however long the backlog takes to drain.
  check(
    "sweep starves nothing over 60s",
    worst < STARVATION_TICKS * 3,
    `worst age ${worst} ticks, ${(totalSent / 3600).toFixed(1)} entities/tick`,
  );

  let neverSwept = 0;
  for (let i = 0; i < capacity; i++) {
    if (sweep.ageOf(i, 3600) < 0) neverSwept++;
  }
  check("every entity was corrected at least once", neverSwept === 0, `${neverSwept} never swept`);

  // Nearest-first must actually bias toward the player, or the whole design premise is wrong.
  sweep.reset();
  const count = sweep.plan(out, 0, alive, posX, posY, playerX, playerY, 1, capacity);
  let maxDist = 0;
  for (let i = 0; i < count; i++) {
    const idx = out[i] as number;
    const d = Math.hypot((posX[idx] as number) / 65536, (posY[idx] as number) / 65536);
    if (d > maxDist) maxDist = d;
  }
  check("sweep prefers nearby entities", maxDist < 400, `furthest chosen ${maxDist.toFixed(0)} units`);

  const empty = new Uint8Array(capacity);
  check("sweep handles an empty world", sweep.plan(out, 1, empty, posX, posY, playerX, playerY, 1, 0) === 0);
  check("sweep handles zero players", sweep.plan(out, 1, alive, posX, posY, playerX, playerY, 0, capacity) === 0);
}

/* ---- 6. net clock ------------------------------------------------------------------------------ */

section("net clock");
{
  const clock = new NetClock();
  for (let i = 0; i < 9; i++) clock.sample(i === 4 ? 900 : 60, 1000, 1000);
  check("median ignores an outlier", clock.rttMs === 60, `${clock.rttMs}ms`);
  check("healthy at 60ms", clock.healthy);

  const drift = new NetClock();
  drift.sample(0, 1010, 1000);
  const startOffset = drift.offsetTicks;
  let extra = 0;
  for (let t = 0; t < 24 * 12; t++) extra += drift.adjust(1) - 1;
  check(
    "drift closes smoothly without snapping",
    startOffset === 10 && drift.offsetTicks === 0 && extra === 10 && drift.totalSnaps === 0,
    `closed ${extra} ticks over ${24 * 10} ticks`,
  );

  const snap = new NetClock();
  snap.sample(0, 1000 + MAX_DRIFT_TICKS + 5, 1000);
  const ticks = snap.adjust(1);
  check(
    "large drift snaps",
    snap.snapped && snap.totalSnaps === 1 && ticks === 1 + MAX_DRIFT_TICKS + 5,
    `ran ${ticks} ticks`,
  );

  const ahead = new NetClock();
  ahead.sample(0, 1000 - (MAX_DRIFT_TICKS + 5), 1000);
  check("guest ahead stalls, never rewinds", ahead.adjust(1) === 0);
}

/* ---- 7. plausibility monitor ------------------------------------------------------------------- */

section("plausibility monitor");
{
  // A brutal but legitimate late-Endless second: heavy spawns, big hits, lots of XP.
  const legit = new PlausibilityMonitor();
  for (let s = 0; s < 120; s++) {
    for (let t = 0; t < 60; t++) {
      if (t % 2 === 0) legit.onSpawn(5);
      legit.onDamage(250_000);
      legit.onXp(20_000);
      legit.tick();
    }
    if (s % 10 === 0) legit.onChest();
  }
  check(
    "tolerates a hard legitimate run",
    !legit.tripped && legit.breach === BREACH.NONE,
    `peak spawns/s ${legit.peakSpawnsPerSecond}, peak xp/s ${legit.peakXpPerSecond}`,
  );

  const bigHit = new PlausibilityMonitor();
  bigHit.onDamage(PLAUSIBILITY.maxSingleDamage + 1);
  check("trips instantly on absurd damage", bigHit.tripped && bigHit.breach === BREACH.DAMAGE_MAGNITUDE);

  const spike = new PlausibilityMonitor();
  for (let t = 0; t < 60; t++) {
    spike.onSpawn(20);
    spike.tick();
  }
  check("a one-second spawn spike alone does not trip", !spike.tripped);

  const flood = new PlausibilityMonitor();
  for (let s = 0; s < PLAUSIBILITY.breachSecondsBeforeLeave; s++) {
    for (let t = 0; t < 60; t++) {
      flood.onSpawn(20);
      flood.tick();
    }
  }
  check(
    "sustained spawn flood trips",
    flood.tripped && flood.breach === BREACH.SPAWN_RATE,
    `after ${PLAUSIBILITY.breachSecondsBeforeLeave}s`,
  );

  const levels = new PlausibilityMonitor();
  levels.onBatchLevelUp(PLAUSIBILITY.maxLevelsPerBatch + 1);
  check("impossible level batch trips", levels.tripped && levels.breach === BREACH.LEVEL_BATCH);

  const bigBatch = new PlausibilityMonitor();
  bigBatch.onBatchLevelUp(230);
  bigBatch.tick();
  check("the real 230-level batch does not trip", !bigBatch.tripped);
}

console.log(
  `\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`,
);
/**
 * Exit non-zero so CI can gate on this, without pulling `@types/node` into the mobile package — the
 * engine deliberately has no Node or React Native types, and this script is the only thing in it that
 * ever wants a process. Reached through `globalThis` so it is simply absent when run in a browser or
 * from the dev menu.
 */
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
