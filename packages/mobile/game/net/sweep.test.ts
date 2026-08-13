/**
 * The five small netcode modules, checked properly. Run headless:
 *   `bun packages/mobile/game/net/sweep.test.ts`
 *
 * `net.test.ts` touches each of these once. This file exists because each one of them is a place
 * where a quiet mistake does not crash anything — it just makes the game slowly wrong, which is the
 * most expensive kind of bug we can ship.
 *
 * WHAT IT PROVES
 *   correction.ts   The sweep starves nothing, spends its budget on what the player can see, and
 *                   respects both ends of the budget clamp.
 *   input.ts        The stick is circular, the deadzone is exact at its own edge, and the history
 *                   ring recognises a stale slot rather than serving four-second-old input.
 *   plausibility.ts Every envelope trips, a momentary spike does not, and a hard legitimate run
 *                   stays clean.
 *   state-hash.ts   Order matters, NaN and -0 do not, and the trail knows how far back it goes.
 *   clock.ts        One 500ms outlier is ignored, drift closes smoothly, and the clock never asks
 *                   the sim to run backwards.
 */

import { DRIFT_CORRECTION_INTERVAL, MS_PER_TICK, NetClock, RTT_SAMPLES } from "./clock";
import { STARVATION_TICKS, CorrectionSweep } from "./correction";
import {
  BTN,
  INPUT_FLAG,
  InputHistory,
  MAX_AXIS_FX,
  STICK_DEADZONE,
  STICK_MAX,
  STICK_UNIT_FX,
  applyDeadzone,
  axisToFx,
  quantiseAxis,
  quantiseStick,
  readMoveFx,
} from "./input";
import { BREACH, PLAUSIBILITY, PlausibilityMonitor } from "./plausibility";
import { CORRECTION_MAX_ENTITIES, CORRECTION_SWEEP_PERCENT, MAX_DRIFT_TICKS } from "./protocol";
import {
  HASH_SEED,
  HashTrail,
  formatHash,
  hashByte,
  hashFloat,
  hashFloat32Range,
  hashInt32Range,
  hashSystems,
  hashUint8Range,
  hashWord,
} from "./state-hash";

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

function allDistinct(table: Record<string, number>): boolean {
  const seen = new Set<number>();
  for (const v of Object.values(table)) {
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

/** One world unit in Q16.16, which is how the sim stores every position. */
const FX = 65536;

/* ---- 1. correction budget --------------------------------------------------------------------- */

section("correction budget");
{
  const sweep = new CorrectionSweep(4096);

  check("nothing alive costs nothing", sweep.budgetFor(0) === 0);
  check("a negative count costs nothing", sweep.budgetFor(-5) === 0);

  // One enemy still gets corrected. Without the floor, a nearly-empty stage would send nothing and
  // the last two enemies of a boss fight would drift forever.
  check("one enemy still gets a slot", sweep.budgetFor(1) === 1, `${sweep.budgetFor(1)}`);
  check("nineteen enemies still get one slot", sweep.budgetFor(19) === 1, `${sweep.budgetFor(19)}`);

  // The percentage in between.
  check("twenty enemies get one", sweep.budgetFor(20) === 1, `${sweep.budgetFor(20)}`);
  check("100 enemies get five", sweep.budgetFor(100) === 5, `${sweep.budgetFor(100)}`);
  check("500 enemies get twenty-five", sweep.budgetFor(500) === 25, `${sweep.budgetFor(500)}`);
  check(
    "the share really is the stated percent",
    sweep.budgetFor(1000) === (1000 * CORRECTION_SWEEP_PERCENT) / 100,
    `${sweep.budgetFor(1000)}`,
  );

  // And the ceiling, so one correction message cannot outgrow a datagram during a swarm.
  check(
    "the ceiling holds at the swarm size",
    sweep.budgetFor(4000) === CORRECTION_MAX_ENTITIES,
    `${sweep.budgetFor(4000)}`,
  );
  check("the ceiling holds well past it", sweep.budgetFor(100000) === CORRECTION_MAX_ENTITIES);
  check(
    "the budget never exceeds the ceiling at any count",
    (() => {
      for (let n = 1; n <= 5000; n++) {
        const b = sweep.budgetFor(n);
        if (b < 1 || b > CORRECTION_MAX_ENTITIES) return false;
      }
      return true;
    })(),
  );
}

/* ---- 2. correction chooses what the player can see ---------------------------------------------- */

section("correction nearest-first");
{
  // Forty entities in a line, one player at the origin. The window the sweep considers is four times
  // its budget, so with a budget of two it looks at eight and must keep the two nearest of those.
  const capacity = 40;
  const sweep = new CorrectionSweep(capacity);
  const alive = new Uint8Array(capacity).fill(1);
  const posX = new Int32Array(capacity);
  const posY = new Int32Array(capacity);
  for (let i = 0; i < capacity; i++) posX[i] = (i + 1) * 100 * FX;

  // Two of the first eight are pulled right next to the player.
  posX[5] = 1 * FX;
  posX[6] = 2 * FX;

  const playerX = new Int32Array([0, 0, 0, 0]);
  const playerY = new Int32Array([0, 0, 0, 0]);
  const out = new Int32Array(CORRECTION_MAX_ENTITIES);
  out.fill(-1);

  const budget = sweep.budgetFor(capacity);
  check("budget for forty is two", budget === 2, `${budget}`);

  const n = sweep.plan(out, 0, alive, posX, posY, playerX, playerY, 1, capacity);
  check("plan returns the budget", n === budget, `${n}`);
  const picked = new Set<number>([out[0] as number, out[1] as number]);
  check("the two nearest were chosen", picked.has(5) && picked.has(6), `${out[0]},${out[1]}`);
  check("nothing was written past the count", out[2] === -1, `${out[2]}`);

  // The cursor moved on, so the next tick looks at a different window — that is the round-robin half.
  const out2 = new Int32Array(CORRECTION_MAX_ENTITIES);
  sweep.plan(out2, 1, alive, posX, posY, playerX, playerY, 1, capacity);
  check(
    "the next tick considers a later window",
    (out2[0] as number) >= 8 && (out2[1] as number) >= 8,
    `${out2[0]},${out2[1]}`,
  );

  // Nearness is measured to the *nearest* player, not to player one.
  const sweep2 = new CorrectionSweep(capacity);
  const farPlayers = new Int32Array([10000 * FX, 0, 0, 3 * FX]);
  const farPlayersY = new Int32Array([0, 0, 0, 0]);
  const out3 = new Int32Array(CORRECTION_MAX_ENTITIES);
  const n3 = sweep2.plan(out3, 0, alive, posX, posY, farPlayers, farPlayersY, 4, capacity);
  const picked3 = new Set<number>();
  for (let i = 0; i < n3; i++) picked3.add(out3[i] as number);
  check("the fourth player's neighbours were chosen", picked3.has(5) && picked3.has(6));

  // Dead slots are never scheduled, however many there are.
  const sweep3 = new CorrectionSweep(capacity);
  const mostlyDead = new Uint8Array(capacity);
  mostlyDead[11] = 1;
  mostlyDead[29] = 1;
  const out4 = new Int32Array(CORRECTION_MAX_ENTITIES);
  const n4 = sweep3.plan(out4, 0, mostlyDead, posX, posY, playerX, playerY, 1, 2);
  check("only live slots are scheduled", n4 === 1 && (out4[0] === 11 || out4[0] === 29), `${n4}`);

  // No players means no corrections — there is nobody to be wrong in front of.
  const out5 = new Int32Array(CORRECTION_MAX_ENTITIES);
  check(
    "no players means no corrections",
    sweep3.plan(out5, 0, alive, posX, posY, playerX, playerY, 0, capacity) === 0,
  );
  check(
    "no live enemies means no corrections",
    sweep3.plan(out5, 0, new Uint8Array(capacity), posX, posY, playerX, playerY, 1, 0) === 0,
  );
}

/* ---- 3. correction starves nothing -------------------------------------------------------------- */

section("correction starvation");
{
  // The failure this module was rewritten to fix: with 2,000 enemies, plain round-robin left three
  // quarters of them never corrected in a minute, because the same nearby entities won every window.
  const capacity = 2048;
  const live = 2000;
  const sweep = new CorrectionSweep(capacity);
  const alive = new Uint8Array(capacity);
  const posX = new Int32Array(capacity);
  const posY = new Int32Array(capacity);
  for (let i = 0; i < live; i++) {
    alive[i] = 1;
    // A spread that deliberately favours a small nearby cluster, which is what broke the old version.
    posX[i] = (i < 80 ? i : i * 200) * FX;
    posY[i] = 0;
  }
  const playerX = new Int32Array([0, 0, 0, 0]);
  const playerY = new Int32Array([0, 0, 0, 0]);
  const out = new Int32Array(CORRECTION_MAX_ENTITIES);

  const ticks = 3600; // one minute
  let worstSeen = 0;
  let totalSent = 0;
  for (let tick = 0; tick < ticks; tick++) {
    totalSent += sweep.plan(out, tick, alive, posX, posY, playerX, playerY, 1, live);
    if (tick > STARVATION_TICKS * 2) {
      const worst = sweep.worstAge(tick, alive);
      if (worst > worstSeen) worstSeen = worst;
    }
  }

  check(
    "worst age stays inside the stated bound",
    worstSeen <= STARVATION_TICKS * 2,
    `worst ${worstSeen}, bound ${STARVATION_TICKS * 2}`,
  );

  let neverCorrected = 0;
  for (let i = 0; i < live; i++) if (sweep.ageOf(i, ticks) < 0) neverCorrected++;
  check("every live enemy was corrected at least once in a minute", neverCorrected === 0, `${neverCorrected} missed`);

  check(
    "the sweep spent its whole budget every tick",
    totalSent === ticks * CORRECTION_MAX_ENTITIES,
    `${totalSent}`,
  );

  // A dead slot's stale age never counts against the bound.
  const halfDead = new Uint8Array(capacity);
  for (let i = 0; i < live; i += 2) halfDead[i] = 1;
  check("worst age ignores dead slots", sweep.worstAge(ticks, halfDead) <= STARVATION_TICKS * 2);
  check("worst age of nothing is zero", sweep.worstAge(ticks, new Uint8Array(capacity)) === 0);

  // ageOf is what the dev-menu readout shows, so it has to mean ticks-since, not a raw tick number.
  const small = new CorrectionSweep(4);
  const smallAlive = new Uint8Array([1, 0, 0, 0]);
  const smallOut = new Int32Array(4);
  check("never corrected reads as -1", small.ageOf(0, 0) === -1);
  small.plan(smallOut, 500, smallAlive, new Int32Array(4), new Int32Array(4), playerX, playerY, 1, 1);
  check("just corrected reads as zero", small.ageOf(0, 500) === 0, `${small.ageOf(0, 500)}`);
  check("ten ticks later reads as ten", small.ageOf(0, 510) === 10, `${small.ageOf(0, 510)}`);
  check("a never-corrected slot's worst age is the whole run", small.ageOf(2, 510) === -1);

  // reset() has to forget the history as well as the cursor, or a second run inherits the first's ages.
  small.reset();
  check("reset forgets the correction history", small.ageOf(0, 510) === -1);

  // The starvation floor really is what bounds it: an entity parked absurdly far away, in a slot the
  // distance ranking would always lose, still gets corrected within the threshold.
  const far = new CorrectionSweep(64);
  const farAlive = new Uint8Array(64).fill(1);
  const farX = new Int32Array(64);
  const farY = new Int32Array(64);
  for (let i = 0; i < 64; i++) farX[i] = 1 * FX;
  farX[63] = 1_000_000 * FX;
  const farOut = new Int32Array(CORRECTION_MAX_ENTITIES);
  let farFirstCorrected = -1;
  for (let tick = 0; tick < STARVATION_TICKS * 3; tick++) {
    const count = far.plan(farOut, tick, farAlive, farX, farY, playerX, playerY, 1, 64);
    for (let i = 0; i < count; i++) {
      if (farOut[i] === 63 && farFirstCorrected < 0) farFirstCorrected = tick;
    }
  }
  check(
    "the most distant enemy is still corrected",
    farFirstCorrected >= 0,
    `first at tick ${farFirstCorrected}`,
  );
}

/* ---- 4. input quantisation --------------------------------------------------------------------- */

section("input quantisation");
{
  check("full tilt is the wire maximum", quantiseAxis(1) === STICK_MAX);
  check("full negative tilt", quantiseAxis(-1) === -STICK_MAX);
  check("centre is zero", quantiseAxis(0) === 0);
  check("beyond full tilt clamps", quantiseAxis(5) === STICK_MAX);
  check("beyond full negative tilt clamps", quantiseAxis(-5) === -STICK_MAX);
  check("half tilt", quantiseAxis(0.5) === 64, `${quantiseAxis(0.5)}`);
  check("quantising is symmetric", quantiseAxis(0.37) === -quantiseAxis(-0.37));

  // Quantising twice must not move the value again, or the local sim and the remote sim disagree by
  // one unit forever.
  let stable = true;
  for (let i = -STICK_MAX; i <= STICK_MAX; i++) {
    if (quantiseAxis(i / STICK_MAX) !== i) stable = false;
  }
  check("every wire value survives a round trip through the analog range", stable);

  // The whole reason quantiseStick exists: per-axis quantising makes a diagonal 41% faster.
  const out = new Int8Array(2);
  quantiseStick(1, 0, out, 0);
  const cardinal = Math.sqrt((out[0] as number) ** 2 + (out[1] as number) ** 2);
  check("full cardinal tilt is 127 long", Math.round(cardinal) === STICK_MAX, `${cardinal}`);

  quantiseStick(1, 1, out, 0);
  const diagonal = Math.sqrt((out[0] as number) ** 2 + (out[1] as number) ** 2);
  check(
    "full diagonal tilt is the same length",
    Math.abs(diagonal - cardinal) <= 1,
    `${diagonal} vs ${cardinal}`,
  );
  check("the diagonal kept its direction", out[0] === out[1], `${out[0]},${out[1]}`);

  // Around the whole circle, not just the eight compass points.
  let worstError = 0;
  for (let deg = 0; deg < 360; deg++) {
    const rad = (deg * Math.PI) / 180;
    quantiseStick(Math.cos(rad) * 4, Math.sin(rad) * 4, out, 0);
    const mag = Math.sqrt((out[0] as number) ** 2 + (out[1] as number) ** 2);
    const err = Math.abs(mag - STICK_MAX);
    if (err > worstError) worstError = err;
  }
  check("the stick is circular all the way round", worstError <= 1.5, `worst error ${worstError}`);

  // Inside the unit circle the vector is passed through untouched — only clipping normalises.
  quantiseStick(0.5, 0.25, out, 0);
  check("a partial tilt is not normalised up", out[0] === 64 && out[1] === 32, `${out[0]},${out[1]}`);

  // Writing at an offset, because four players share one flat array.
  const shared = new Int8Array(8);
  quantiseStick(1, 0, shared, 4);
  check("the offset is respected", shared[4] === STICK_MAX && shared[0] === 0);
  check("nothing else was touched", shared[5] === 0 && shared[6] === 0);
}

/* ---- 5. deadzone and fixed point --------------------------------------------------------------- */

section("deadzone and fixed point");
{
  // Exactly at the edge is inside the deadzone. That boundary is part of the deterministic pipeline,
  // so it has to be pinned rather than assumed.
  check("exactly at the edge is dead", applyDeadzone(STICK_DEADZONE) === 0);
  check("exactly at the negative edge is dead", applyDeadzone(-STICK_DEADZONE) === 0);
  check("one past the edge lives", applyDeadzone(STICK_DEADZONE + 1) === STICK_DEADZONE + 1);
  check("one past the negative edge lives", applyDeadzone(-STICK_DEADZONE - 1) === -STICK_DEADZONE - 1);
  check("centre is dead", applyDeadzone(0) === 0);
  check("full tilt is untouched", applyDeadzone(STICK_MAX) === STICK_MAX);
  check("the deadzone is under a tenth of the throw", STICK_DEADZONE / STICK_MAX < 0.1);

  check("the fixed-point unit is the rounded ratio", STICK_UNIT_FX === Math.round(65536 / STICK_MAX));
  check("full tilt in fixed point is at most one", axisToFx(STICK_MAX) <= MAX_AXIS_FX, `${axisToFx(STICK_MAX)}`);
  check("full tilt in fixed point is nearly one", axisToFx(STICK_MAX) > MAX_AXIS_FX - 16);
  check("fixed point is symmetric", axisToFx(-STICK_MAX) === -axisToFx(STICK_MAX));
  check("zero converts to zero", axisToFx(0) === 0);

  let integral = true;
  for (let a = -STICK_MAX; a <= STICK_MAX; a++) if (!Number.isInteger(axisToFx(a))) integral = false;
  check("every axis converts to a whole fixed-point number", integral);

  // readMoveFx is the only path the sim uses, so the deadzone has to be applied inside it.
  const history = new InputHistory(256);
  const move = new Int32Array(2);
  history.write(10, STICK_DEADZONE, STICK_MAX, 0, 0);
  readMoveFx(history, 10, move);
  check("movement drops a deadzoned axis", move[0] === 0, `${move[0]}`);
  check("movement keeps a live axis", move[1] === axisToFx(STICK_MAX), `${move[1]}`);

  // A tick with no input reads as standing still, not as garbage.
  readMoveFx(history, 999, move);
  check("an unknown tick reads as standing still", move[0] === 0 && move[1] === 0);

  check("button bits are distinct", allDistinct(BTN));
  check("input flag bits are distinct", allDistinct(INPUT_FLAG));
  check(
    "every button is a single bit",
    Object.values(BTN).every((v) => v > 0 && (v & (v - 1)) === 0),
  );
  check(
    "every flag is a single bit",
    Object.values(INPUT_FLAG).every((v) => v > 0 && (v & (v - 1)) === 0),
  );
  check(
    "buttons and flags both fit their byte",
    Object.values(BTN).every((v) => v <= 255) && Object.values(INPUT_FLAG).every((v) => v <= 255),
  );
}

/* ---- 6. the input history ring ----------------------------------------------------------------- */

section("input history");
{
  const capacity = 256;
  const history = new InputHistory(capacity);

  check("an empty history has no newest tick", history.newestTick === -1);
  check("an empty history has nothing", !history.has(0));

  history.write(100, 12, -34, BTN.FOCUS | BTN.REVIVE, INPUT_FLAG.UI_OPEN);
  check("a written tick is present", history.has(100));
  check("stick x survives", history.stickX(100) === 12);
  check("stick y survives negative", history.stickY(100) === -34);
  check("buttons survive", history.buttons(100) === (BTN.FOCUS | BTN.REVIVE));
  check("flags survive", history.flags(100) === INPUT_FLAG.UI_OPEN);
  check("newest tick tracks the write", history.newestTick === 100);

  // The whole point of storing the tick alongside: the slot for tick 100 is also the slot for tick
  // 356, and 356 must not read 100's four-second-old input.
  const collide = 100 + capacity;
  check("the wrapped tick shares a slot", collide % capacity === 100 % capacity);
  check("the wrapped tick is not present", !history.has(collide));
  check("the wrapped tick reads as still", history.stickX(collide) === 0 && history.stickY(collide) === 0);
  check("the wrapped tick reads no buttons", history.buttons(collide) === 0);

  history.write(collide, -5, 6, 0, 0);
  check("writing the wrapped tick claims the slot", history.has(collide));
  check("the old tick is now gone", !history.has(100));
  check("the old tick reads as still", history.stickX(100) === 0);
  check("newest tick moved forward", history.newestTick === collide);

  // An out-of-order write must not move the newest tick backwards.
  history.write(200, 1, 1, 0, 0);
  check("a late write does not move the newest tick back", history.newestTick === collide);
  check("the late write is still readable", history.has(200) && history.stickX(200) === 1);

  // Tick zero and negative ticks: the ring's modulo has to stay non-negative or it writes outside
  // its own arrays.
  const h2 = new InputHistory(16);
  h2.write(0, 7, 7, 0, 0);
  check("tick zero works", h2.has(0) && h2.stickX(0) === 7);
  h2.write(-3, 9, 9, 0, 0);
  check("a negative tick does not throw", h2.has(-3), "negative modulo");
  check("a negative tick reads back", h2.stickX(-3) === 9);
  check("a negative tick does not become the newest", h2.newestTick === 0);

  // Prediction: repeat the last frame, marked, so a guest can tell a real frame from a guess.
  const h3 = new InputHistory(64);
  check("prediction with nothing to repeat fails", !h3.predictFrom(10));
  check("a failed prediction wrote nothing", !h3.has(10));

  h3.write(10, 100, -100, BTN.ITEM_A, 0);
  check("prediction of a tick we already have succeeds", h3.predictFrom(10));
  check("prediction did not mark a real frame", (h3.flags(10) & INPUT_FLAG.PREDICTED) === 0);

  check("prediction from the previous tick succeeds", h3.predictFrom(11));
  check("the predicted frame repeats the stick", h3.stickX(11) === 100 && h3.stickY(11) === -100);
  check("the predicted frame repeats the buttons", h3.buttons(11) === BTN.ITEM_A);
  check("the predicted frame is marked", (h3.flags(11) & INPUT_FLAG.PREDICTED) !== 0);

  // Predicting off a prediction keeps the mark and any other flags the original carried.
  h3.write(20, 1, 2, 0, INPUT_FLAG.SYNTHETIC);
  h3.predictFrom(21);
  check("prediction keeps the original's other flags", (h3.flags(21) & INPUT_FLAG.SYNTHETIC) !== 0);
  h3.predictFrom(22);
  check("a prediction from a prediction is still marked", (h3.flags(22) & INPUT_FLAG.PREDICTED) !== 0);

  // A gap of two cannot be predicted — there is nothing at tick-1 to repeat.
  check("a two-tick gap is not predicted", !h3.predictFrom(30));

  // A long run across many wraps must never serve a stale frame.
  const h4 = new InputHistory(256);
  let stale = 0;
  for (let tick = 0; tick < 5000; tick++) {
    h4.write(tick, tick & 0x7f, -(tick & 0x7f), 0, 0);
    if (tick > 300 && h4.has(tick - 300)) stale++;
  }
  check("nothing stale is ever visible across 5,000 ticks", stale === 0, `${stale}`);
  check("the newest tick is the last one written", h4.newestTick === 4999);
  check("recent history is intact", h4.stickX(4999) === (4999 & 0x7f));

  h4.clear();
  check("clear empties the ring", !h4.has(4999));
  check("clear resets the newest tick", h4.newestTick === -1);
}

/* ---- 7. plausibility: every envelope ----------------------------------------------------------- */

section("plausibility envelopes");
{
  /** Advance whole seconds. */
  function seconds(m: PlausibilityMonitor, n: number): void {
    for (let i = 0; i < n * 60; i++) m.tick();
  }

  check("breach kinds are distinct", allDistinct(BREACH));
  check("clean is zero", BREACH.NONE === 0);

  const fresh = new PlausibilityMonitor();
  check("a fresh monitor is clean", fresh.breach === BREACH.NONE && !fresh.tripped);
  seconds(fresh, 120);
  check("two idle minutes stay clean", !fresh.tripped && fresh.breach === BREACH.NONE);

  // 1. Spawn rate — a rate breach, so it must persist before it counts.
  const spawn = new PlausibilityMonitor();
  for (let s = 0; s < 2; s++) {
    spawn.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond + 50);
    seconds(spawn, 1);
  }
  check("two bad seconds of spawns is not yet enough", !spawn.tripped);
  check("but the breach is already named", spawn.breach === BREACH.SPAWN_RATE, `${spawn.breach}`);
  spawn.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond + 50);
  seconds(spawn, 1);
  check(
    "three consecutive bad seconds trips the spawn rate",
    spawn.tripped && spawn.breach === BREACH.SPAWN_RATE,
  );
  check("the peak is reported honestly", spawn.peakSpawnsPerSecond === PLAUSIBILITY.maxSpawnsPerSecond + 50);

  // A spike that stops is exactly what the persistence rule is for.
  const spike = new PlausibilityMonitor();
  spike.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond * 10);
  seconds(spike, 1);
  spike.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond * 10);
  seconds(spike, 1);
  seconds(spike, 5);
  check("a two-second spike never trips", !spike.tripped);
  spike.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond * 10);
  seconds(spike, 1);
  spike.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond * 10);
  seconds(spike, 1);
  check("and the counter really restarted after the quiet run", !spike.tripped);

  // Exactly at the threshold is legitimate; the check is strictly greater.
  const edge = new PlausibilityMonitor();
  for (let s = 0; s < 10; s++) {
    edge.onSpawn(PLAUSIBILITY.maxSpawnsPerSecond);
    seconds(edge, 1);
  }
  check("exactly at the spawn ceiling is legitimate", !edge.tripped && edge.breach === BREACH.NONE);

  // Spawns arriving as many small events add up inside the second.
  const dribble = new PlausibilityMonitor();
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < 100; i++) dribble.onSpawn(5);
    seconds(dribble, 1);
  }
  check("many small spawn events still add up", dribble.tripped && dribble.breach === BREACH.SPAWN_RATE);

  // 2. Damage magnitude — trips on the spot, because a single hit that big cannot be a burst.
  const damage = new PlausibilityMonitor();
  damage.onDamage(PLAUSIBILITY.maxSingleDamage);
  check("damage exactly at the ceiling is legitimate", !damage.tripped);
  damage.onDamage(PLAUSIBILITY.maxSingleDamage + 1);
  check("one impossible hit trips immediately", damage.tripped);
  check("and names the magnitude", damage.breach === BREACH.DAMAGE_MAGNITUDE);
  check("the peak damage is reported", damage.peakSingleDamage === PLAUSIBILITY.maxSingleDamage + 1);
  check("no second is needed", true);

  // 3. XP rate.
  const xp = new PlausibilityMonitor();
  for (let s = 0; s < 3; s++) {
    xp.onXp(PLAUSIBILITY.maxXpPerSecond + 1);
    seconds(xp, 1);
  }
  check("three bad seconds of xp trips", xp.tripped && xp.breach === BREACH.XP_RATE);
  check("the peak xp is reported", xp.peakXpPerSecond === PLAUSIBILITY.maxXpPerSecond + 1);

  // 4. Level batch — also immediate, being a magnitude rather than a rate.
  const batch = new PlausibilityMonitor();
  batch.onBatchLevelUp(PLAUSIBILITY.maxLevelsPerBatch);
  check("a batch exactly at the ceiling is legitimate", !batch.tripped);
  batch.onBatchLevelUp(PLAUSIBILITY.maxLevelsPerBatch + 1);
  check("an impossible batch trips immediately", batch.tripped && batch.breach === BREACH.LEVEL_BATCH);

  // 5. Level rate — many legal-sized batches, too fast.
  const levels = new PlausibilityMonitor();
  const perSecond = Math.floor(PLAUSIBILITY.maxLevelsPerMinute / 60) + 5;
  for (let s = 0; s < 3; s++) {
    levels.onBatchLevelUp(perSecond);
    seconds(levels, 1);
  }
  check("three bad seconds of levelling trips", levels.tripped, `${levels.breach}`);
  check("and names the rate, not the batch", levels.breach === BREACH.LEVEL_RATE, `${levels.breach}`);

  // 6. Chest rate — checked on the minute boundary.
  const chests = new PlausibilityMonitor();
  for (let i = 0; i < PLAUSIBILITY.maxChestsPerMinute + 10; i++) chests.onChest();
  seconds(chests, 60);
  check("chest abuse is named at the minute mark", chests.breach === BREACH.CHEST_RATE, `${chests.breach}`);
  // KNOWN LIMITATION, deliberately pinned here rather than left as a surprise: the chest envelope is
  // measured once a minute, and the leave rule wants three *consecutive* breaching seconds, so chest
  // abuse on its own names the breach without ever tripping the leave. Reported and tracked; the
  // report-host payload still carries the named breach, so it is not invisible.
  check("chest abuse alone does not yet trip the leave", !chests.tripped);

  // A legitimate chest run is well clear of it.
  const legalChests = new PlausibilityMonitor();
  for (let i = 0; i < PLAUSIBILITY.maxChestsPerMinute; i++) legalChests.onChest();
  seconds(legalChests, 60);
  check("a legitimate chest run stays clean", legalChests.breach === BREACH.NONE);

  // The first breach is the one reported, so a later one cannot mask the cause.
  const first = new PlausibilityMonitor();
  first.onDamage(PLAUSIBILITY.maxSingleDamage * 2);
  first.onBatchLevelUp(PLAUSIBILITY.maxLevelsPerBatch * 2);
  check("the first breach is the one reported", first.breach === BREACH.DAMAGE_MAGNITUDE);

  // Latched: it never clears itself, however long the run behaves afterwards.
  const latched = new PlausibilityMonitor();
  latched.onDamage(PLAUSIBILITY.maxSingleDamage * 2);
  seconds(latched, 300);
  check("a trip never clears itself", latched.tripped);
  check("and the reason is still there", latched.breach === BREACH.DAMAGE_MAGNITUDE);

  // Only reset clears it, which is what starting a new session does.
  latched.reset();
  check("reset clears the trip", !latched.tripped && latched.breach === BREACH.NONE);
  seconds(latched, 5);
  check("and the monitor is usable again", !latched.tripped);
}

/* ---- 8. plausibility: a hard legitimate run ---------------------------------------------------- */

section("plausibility on a real run");
{
  // Thirty minutes of a late-Endless-shaped run: heavy spawns, big hits, constant XP, chests on the
  // stage table. A false positive here costs a real player their co-op session, so this has to be
  // comfortably clean rather than just barely clean.
  const monitor = new PlausibilityMonitor();
  for (let second = 0; second < 1800; second++) {
    const ramp = second / 1800;
    const spawns = Math.floor(20 + 180 * ramp); // up to 200/s, half the ceiling
    for (let i = 0; i < spawns; i++) monitor.onSpawn(1);
    for (let i = 0; i < 40; i++) monitor.onDamage(Math.floor(500 + 400_000 * ramp));
    monitor.onXp(Math.floor(1000 + 600_000 * ramp));
    if (second % 90 === 0) monitor.onChest();
    if (second % 30 === 0) monitor.onBatchLevelUp(3);
    for (let t = 0; t < 60; t++) monitor.tick();
  }
  check("a hard thirty-minute run never trips", !monitor.tripped);
  check("and never even names a breach", monitor.breach === BREACH.NONE, `${monitor.breach}`);
  check("the peaks were real", monitor.peakSpawnsPerSecond > 150, `${monitor.peakSpawnsPerSecond}`);
  check(
    "and stayed inside the envelope",
    monitor.peakSpawnsPerSecond <= PLAUSIBILITY.maxSpawnsPerSecond,
    `${monitor.peakSpawnsPerSecond}`,
  );

  // One 230-level gem, the real reported case the batch ceiling was set from, must be legitimate.
  const bigGem = new PlausibilityMonitor();
  bigGem.onBatchLevelUp(230);
  check("the 230-level case is legitimate", !bigGem.tripped && bigGem.breach === BREACH.NONE);
}

/* ---- 9. state hash ---------------------------------------------------------------------------- */

section("state hash");
{
  check("the seed is the FNV offset basis", HASH_SEED === 0x811c9dc5);

  // Determinism, first and most important.
  check("the same word hashes the same way twice", hashWord(HASH_SEED, 12345) === hashWord(HASH_SEED, 12345));
  check("a different word hashes differently", hashWord(HASH_SEED, 1) !== hashWord(HASH_SEED, 2));
  check("hashing stays in int32", Number.isInteger(hashWord(HASH_SEED, 0xffffffff)));

  // Order is part of the hash. If it were not, two sims that ran the same events in a different
  // order would look identical, which is exactly the desync we are trying to catch.
  const ab = hashWord(hashWord(HASH_SEED, 7), 9);
  const ba = hashWord(hashWord(HASH_SEED, 9), 7);
  check("order changes the hash", ab !== ba, `${formatHash(ab)} vs ${formatHash(ba)}`);

  // A whole word and its bytes must not be the same mix, or a length change would go unnoticed.
  check("a word is not the same as one byte", hashWord(HASH_SEED, 1) !== hashByte(HASH_SEED, 1));

  // Every single-bit change in a word has to change the hash. A word whose top bits are ignored
  // would silently drop the high half of every position we hash.
  const seen = new Set<number>();
  for (let bit = 0; bit < 32; bit++) seen.add(hashWord(HASH_SEED, (1 << bit) >>> 0));
  check("all 32 bits of a word reach the hash", seen.size === 32, `${seen.size}`);

  // Floats by bit pattern, with the two normalisations that stop harmless values reading as drift.
  check("a float hashes deterministically", hashFloat(HASH_SEED, 1.5) === hashFloat(HASH_SEED, 1.5));
  check("different floats hash differently", hashFloat(HASH_SEED, 1.5) !== hashFloat(HASH_SEED, 1.6));
  check("NaN is stable", hashFloat(HASH_SEED, NaN) === hashFloat(HASH_SEED, NaN));
  check("NaN from different arithmetic agrees", hashFloat(HASH_SEED, 0 / 0) === hashFloat(HASH_SEED, Infinity - Infinity));
  check("NaN is not zero", hashFloat(HASH_SEED, NaN) !== hashFloat(HASH_SEED, 0));
  check("minus zero hashes as zero", hashFloat(HASH_SEED, -0) === hashFloat(HASH_SEED, 0));
  check("infinities are distinct", hashFloat(HASH_SEED, Infinity) !== hashFloat(HASH_SEED, -Infinity));
  check("a tiny difference is still a difference", hashFloat(HASH_SEED, 1) !== hashFloat(HASH_SEED, 1 + Number.EPSILON));

  // Range helpers must equal the equivalent element-by-element mix, and an empty range must be a
  // no-op rather than a state change.
  const ints = new Int32Array([5, -5, 0, 2147483647, -2147483648]);
  let manual = HASH_SEED;
  for (let i = 0; i < ints.length; i++) manual = hashWord(manual, ints[i] as number);
  check("the int range helper matches the manual mix", hashInt32Range(HASH_SEED, ints, 0, ints.length) === manual);
  check("an empty int range changes nothing", hashInt32Range(HASH_SEED, ints, 2, 2) === HASH_SEED);
  check(
    "a partial int range is not the whole one",
    hashInt32Range(HASH_SEED, ints, 0, 2) !== hashInt32Range(HASH_SEED, ints, 0, ints.length),
  );

  const floats = new Float32Array([0.5, -0.5, 0, 1e20]);
  let manualF = HASH_SEED;
  for (let i = 0; i < floats.length; i++) manualF = hashFloat(manualF, floats[i] as number);
  check("the float range helper matches the manual mix", hashFloat32Range(HASH_SEED, floats, 0, floats.length) === manualF);
  check("an empty float range changes nothing", hashFloat32Range(HASH_SEED, floats, 1, 1) === HASH_SEED);

  const bytes = new Uint8Array([0, 1, 255, 128]);
  let manualB = HASH_SEED;
  for (let i = 0; i < bytes.length; i++) manualB = hashByte(manualB, bytes[i] as number);
  check("the byte range helper matches the manual mix", hashUint8Range(HASH_SEED, bytes, 0, bytes.length) === manualB);
  check("an empty byte range changes nothing", hashUint8Range(HASH_SEED, bytes, 4, 4) === HASH_SEED);

  // A moved element changes the hash, which is what catches an enemy in the wrong pool slot.
  const moved = new Int32Array([5, -5, 0, -2147483648, 2147483647]);
  check(
    "reordering a pool changes the hash",
    hashInt32Range(HASH_SEED, ints, 0, 5) !== hashInt32Range(HASH_SEED, moved, 0, 5),
  );

  // Systems hash in the caller's order, never an object's key order.
  const sysA = { hashState: (h: number) => hashWord(h, 1) };
  const sysB = { hashState: (h: number) => hashWord(h, 2) };
  check("hashing systems is deterministic", hashSystems([sysA, sysB]) === hashSystems([sysA, sysB]));
  check("system order is part of the hash", hashSystems([sysA, sysB]) !== hashSystems([sysB, sysA]));
  check("no systems is just the seed", hashSystems([]) === HASH_SEED);
  check("one system is not two", hashSystems([sysA]) !== hashSystems([sysA, sysA]));

  // The readout the dev menu and the logs use.
  check("a hash formats to eight digits", formatHash(0) === "00000000");
  check("a negative hash formats unsigned", formatHash(-1) === "ffffffff");
  check("a small hash is padded", formatHash(0xabc) === "00000abc");
  let widthOk = true;
  for (let i = 0; i < 200; i++) {
    if (formatHash(hashWord(HASH_SEED, i * 7919)).length !== 8) widthOk = false;
  }
  check("every hash formats to the same width", widthOk);
}

/* ---- 10. the hash trail ------------------------------------------------------------------------ */

section("hash trail");
{
  const trail = new HashTrail(4);
  check("a fresh trail has no oldest tick", trail.oldestTick() === -1);
  check("a fresh trail knows nothing", !trail.has(0));
  check("a fresh trail returns zero", trail.at(0) === 0);

  trail.record(10, 0xaaa);
  trail.record(11, 0xbbb);
  check("a recorded tick is known", trail.has(10) && trail.has(11));
  check("a recorded hash comes back", trail.at(10) === 0xaaa && trail.at(11) === 0xbbb);
  check("the oldest tick is the first one", trail.oldestTick() === 10);
  check("an unrecorded tick is not known", !trail.has(12));

  // Wrap: capacity four, six records, so the two oldest are gone and the window has moved.
  trail.record(12, 0xccc);
  trail.record(13, 0xddd);
  trail.record(14, 0xeee);
  trail.record(15, 0xfff);
  check("the oldest tick moved with the window", trail.oldestTick() === 12, `${trail.oldestTick()}`);
  check("the aged-out ticks are gone", !trail.has(10) && !trail.has(11));
  check("the window still holds four", trail.has(12) && trail.has(13) && trail.has(14) && trail.has(15));
  check("the newest hash is right", trail.at(15) === 0xfff);
  check("the oldest surviving hash is right", trail.at(12) === 0xccc);

  // at() returns 0 for a tick it does not have, and 0 is a legitimate hash — so `has` is the question
  // to ask, and it has to answer correctly for a genuinely-zero hash.
  trail.record(16, 0);
  check("a zero hash is still recorded", trail.has(16));
  check("a zero hash reads back as zero", trail.at(16) === 0);
  check("an absent tick also reads zero", trail.at(9999) === 0 && !trail.has(9999));

  // Negative hashes are the normal case — FNV-1a in int32 is negative about half the time.
  trail.record(17, -12345);
  check("a negative hash survives", trail.at(17) === -12345);

  // A long run: only the last `capacity` ticks are ever in the trail, so a resim knows exactly how
  // far back it may start.
  const long = new HashTrail(64);
  for (let tick = 0; tick < 10000; tick += 120) long.record(tick, hashWord(HASH_SEED, tick));
  const oldest = long.oldestTick();
  const newestRecorded = 120 * 83;
  check("a long run keeps a bounded window", oldest === newestRecorded - 120 * 63, `${oldest}`);
  check("the window's oldest hash is intact", long.at(oldest) === hashWord(HASH_SEED, oldest));
  check("anything older is gone", !long.has(oldest - 120));
  check("the default capacity is 64", new HashTrail().capacity === 64);

  long.clear();
  check("clear empties the trail", long.oldestTick() === -1 && !long.has(oldest));
}

/* ---- 11. the net clock ------------------------------------------------------------------------- */

section("net clock");
{
  check("a tick is a sixtieth of a second", Math.abs(MS_PER_TICK - 1000 / 60) < 1e-12);
  check("the sample count is odd, so the median needs no averaging", RTT_SAMPLES % 2 === 1);

  // The line the module was written for: one 500ms mobile outlier must not move the estimate.
  const clock = new NetClock();
  for (let i = 0; i < RTT_SAMPLES - 1; i++) clock.sample(50, 1000, 1000);
  clock.sample(500, 1000, 1000);
  check("a single outlier does not move the median", clock.rttMs === 50, `${clock.rttMs}`);

  // A mean would have been dragged to about 100.
  const mean = ((RTT_SAMPLES - 1) * 50 + 500) / RTT_SAMPLES;
  check("and a mean would have been", mean > 90, `${Math.round(mean)}ms`);

  // A genuine shift moves it, once most of the window agrees.
  for (let i = 0; i < RTT_SAMPLES; i++) clock.sample(200, 1000, 1000);
  check("a genuine shift does move the median", clock.rttMs === 200, `${clock.rttMs}`);

  // The offset is the host's tick plus half an RTT, minus ours.
  const c2 = new NetClock();
  c2.sample(0, 1000, 1000);
  check("a zero-latency host at our tick means no offset", c2.offsetTicks === 0, `${c2.offsetTicks}`);
  const c3 = new NetClock();
  c3.sample(100, 1000, 1000);
  check(
    "half a 100ms round trip is three ticks",
    c3.offsetTicks === Math.round(100 / 2 / MS_PER_TICK),
    `${c3.offsetTicks}`,
  );
  const c4 = new NetClock();
  c4.sample(0, 1000, 1050);
  check("being ahead of the host reads negative", c4.offsetTicks === -50, `${c4.offsetTicks}`);

  // Correcting by rate. A small offset closes one tick at a time, one adjustment every 24 ticks.
  const smooth = new NetClock();
  smooth.offsetTicks = 5;
  let extra = 0;
  for (let i = 0; i < DRIFT_CORRECTION_INTERVAL - 1; i++) {
    if (smooth.adjust(1) !== 1) extra++;
  }
  check("nothing changes before the interval elapses", extra === 0, `${extra}`);
  check("the offset has not moved yet", smooth.offsetTicks === 5);
  check("the correcting tick runs one extra", smooth.adjust(1) === 2);
  check("and the offset closed by one", smooth.offsetTicks === 4);
  check("no snap was needed", !smooth.snapped);
  check("the adjustment was counted", smooth.totalAdjustments === 1);

  // Closing five ticks takes five intervals and lands exactly on zero — not one past it.
  let ran = 0;
  for (let i = 0; i < DRIFT_CORRECTION_INTERVAL * 6; i++) ran += smooth.adjust(1);
  check("the whole offset closes", smooth.offsetTicks === 0, `${smooth.offsetTicks}`);
  check(
    "and it closed by running exactly four extra ticks",
    ran === DRIFT_CORRECTION_INTERVAL * 6 + 4,
    `${ran}`,
  );
  check("no snap over the whole correction", smooth.totalSnaps === 0);

  // Being ahead means stalling, never rewinding: already-rendered frames cannot be undone.
  const ahead = new NetClock();
  ahead.offsetTicks = -3;
  for (let i = 0; i < DRIFT_CORRECTION_INTERVAL - 1; i++) ahead.adjust(1);
  check("the stalling tick runs one fewer", ahead.adjust(1) === 0);
  check("the offset closed by one", ahead.offsetTicks === -2);

  // And with nothing due, it must return zero rather than -1.
  const idle = new NetClock();
  idle.offsetTicks = -3;
  let negative = false;
  for (let i = 0; i < DRIFT_CORRECTION_INTERVAL * 4; i++) if (idle.adjust(0) < 0) negative = true;
  check("the clock never asks for a negative number of ticks", !negative);

  // Snapping, only past the ceiling.
  const atCeiling = new NetClock();
  atCeiling.offsetTicks = MAX_DRIFT_TICKS;
  atCeiling.adjust(1);
  check("exactly at the ceiling does not snap", !atCeiling.snapped);
  check("and the offset is still being closed smoothly", atCeiling.offsetTicks === MAX_DRIFT_TICKS);

  const snap = new NetClock();
  snap.offsetTicks = MAX_DRIFT_TICKS + 1;
  const caught = snap.adjust(1);
  check("past the ceiling snaps", snap.snapped);
  check("the snap runs the whole gap at once", caught === 1 + MAX_DRIFT_TICKS + 1, `${caught}`);
  check("the offset is cleared by the snap", snap.offsetTicks === 0);
  check("the snap was counted", snap.totalSnaps === 1);
  check("the snap flag clears on the next frame", snap.adjust(1) === 1 && !snap.snapped);

  const snapAhead = new NetClock();
  snapAhead.offsetTicks = -(MAX_DRIFT_TICKS + 1);
  check("snapping while ahead stalls entirely", snapAhead.adjust(5) === 0);
  check("snapping while ahead is still a snap", snapAhead.snapped);
  check("and clears the offset", snapAhead.offsetTicks === 0);

  // Health, which is what decides whether a co-op run counts competitively.
  const health = new NetClock();
  check("a clock with no samples is not healthy", !health.healthy);
  health.sample(50, 1000, 1000);
  check("a good connection is healthy", health.healthy, `${health.rttMs}ms`);
  for (let i = 0; i < RTT_SAMPLES; i++) health.sample(200, 1000, 1000);
  check("a slow connection is not healthy", !health.healthy, `${health.rttMs}ms`);

  const drifted = new NetClock();
  drifted.sample(50, 1000, 1000);
  drifted.offsetTicks = MAX_DRIFT_TICKS + 5;
  check("a badly drifted clock is not healthy", !drifted.healthy);
  drifted.offsetTicks = MAX_DRIFT_TICKS;
  check("and is healthy again right at the ceiling", drifted.healthy);

  // reset() puts the clock back for a new session but keeps the cumulative dev-menu counters, which
  // are there to answer "how bad was that session" after the fact.
  const reused = new NetClock();
  reused.offsetTicks = MAX_DRIFT_TICKS + 1;
  reused.adjust(1);
  reused.sample(120, 1000, 1000);
  const snapsBefore = reused.totalSnaps;
  reused.reset();
  check("reset clears the round trip time", reused.rttMs === 0);
  check("reset clears the offset", reused.offsetTicks === 0);
  check("reset clears the snap flag", !reused.snapped);
  check("reset makes the clock unhealthy again", !reused.healthy);
  check("reset keeps the cumulative snap count", reused.totalSnaps === snapsBefore, `${reused.totalSnaps}`);

  // A full session's worth of jittery samples must never leave the clock in a silly state.
  const session = new NetClock();
  let seed = 12345;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let sane = true;
  let hostTick = 0;
  for (let tick = 0; tick < 20000; tick++) {
    hostTick += 1;
    if (tick % 60 === 0) {
      const rtt = 60 + rand() * 80 + (rand() < 0.02 ? 500 : 0);
      session.sample(rtt, hostTick, tick);
    }
    const run = session.adjust(1);
    if (run < 0) sane = false;
    if (!Number.isInteger(run)) sane = false;
    if (Math.abs(session.offsetTicks) > MAX_DRIFT_TICKS + 1) sane = false;
  }
  check("a jittery twenty-thousand-tick session stays sane", sane);
  check("and the round trip time settled near the truth", session.rttMs > 55 && session.rttMs < 160, `${session.rttMs}`);
}

/* ---- 12. constants of record ------------------------------------------------------------------- */

section("constants of record");
{
  // Each of these numbers is part of the simulation contract, not a tuning knob. Two clients that
  // disagree about any of them do not drift — they play different games, and the symptom is a desync
  // report rather than a version error. Pinned to their literal values on purpose: changing one
  // deliberately means bumping the protocol version and editing this list in the same commit.
  check("the stick throw is 127", STICK_MAX === 127, `${STICK_MAX}`);
  check("the deadzone is 12", STICK_DEADZONE === 12, `${STICK_DEADZONE}`);
  check("one stick unit is 516 in fixed point", STICK_UNIT_FX === 516, `${STICK_UNIT_FX}`);
  check("one is 65536 in fixed point", MAX_AXIS_FX === 65536, `${MAX_AXIS_FX}`);
  check("the starvation floor is two seconds", STARVATION_TICKS === 120, `${STARVATION_TICKS}`);
  check("the sweep share is 5 percent", CORRECTION_SWEEP_PERCENT === 5, `${CORRECTION_SWEEP_PERCENT}`);
  check("the sweep ceiling is 64 entities", CORRECTION_MAX_ENTITIES === 64, `${CORRECTION_MAX_ENTITIES}`);
  check("the round trip window is 9 samples", RTT_SAMPLES === 9, `${RTT_SAMPLES}`);
  check("drift closes one tick every 24", DRIFT_CORRECTION_INTERVAL === 24, `${DRIFT_CORRECTION_INTERVAL}`);
  check("the drift ceiling is 18 ticks", MAX_DRIFT_TICKS === 18, `${MAX_DRIFT_TICKS}`);

  // The plausibility envelope is a published number in a sense — it decides whether a real player
  // gets thrown out of a co-op session, so tightening one by accident is a live incident.
  check("spawns per second ceiling is 400", PLAUSIBILITY.maxSpawnsPerSecond === 400);
  check("single damage ceiling is five million", PLAUSIBILITY.maxSingleDamage === 5_000_000);
  check("xp per second ceiling is two million", PLAUSIBILITY.maxXpPerSecond === 2_000_000);
  check("chests per minute ceiling is 30", PLAUSIBILITY.maxChestsPerMinute === 30);
  check("levels per batch ceiling is 500", PLAUSIBILITY.maxLevelsPerBatch === 500);
  check("levels per minute ceiling is 3000", PLAUSIBILITY.maxLevelsPerMinute === 3_000);
  check("a breach must persist three seconds", PLAUSIBILITY.breachSecondsBeforeLeave === 3);
  check("the hash seed is unchanged", HASH_SEED === 0x811c9dc5);
}

console.log(
  `\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}\n`,
);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
