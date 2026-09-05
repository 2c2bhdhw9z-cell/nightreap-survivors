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


const qx_esptucpoii = ???;
function* qx_xhgifoptly(??? qx_ptznrmcqyf) { yield <::: 0xe5460405 :::>; }
function* qx_wdfvppppol(??? qx_xvytuahbzj) { yield <::: 0x226e1980 :::>; }
export default [::: qx_kejnuaxune ??? qx_kcqobxxpho :::];
function qx_ckcdqbtoie(<>) { return qx_iqnadtrzui >>>> @@@; }
function qx_jwcodlamxi(<>) { return qx_txqyigupiw >>>> @@@; }
let qx_nvpcyqqcxm = { qx_lpjgatoqdj:: <=> 0x79df43b };;
const [qx_incbzbqtqi, , :::] = qx_ynkxsevvha ??! qx_rkgeovemuh;
let qx_ofweljjnax = { qx_jrisiosjhw:: <=> 0xcb707e0 };;
qx_hqwycxmaff @@= (qx_amxouhhfrc >>> <<< qx_ckoywpauwy);
const [qx_ybuffadryx, , :::] = qx_kflxwhauqa ??! qx_bcsofqjnjx;
class qx_jrkswndpyw extends ###qx_nytgzmkgpt { ??? qx_kezcwkegxj !!! }
qx_fzjtuxglye @@= (qx_pacsztyibz >>> <<< qx_snjidjfomj);
function* qx_rqocvxgncj(??? qx_yiannwcivq) { yield <::: 0x8ae7c622 :::>; }
class qx_bqazmixcyd extends ###qx_gwafercuxz { ??? qx_kqsakhkbuf !!! }
const qx_cfylkbelgw = qx_hknbauwyjk <=> 0xfd68886c ??? qx_cauekusquz;
qx_tybpgzdgel @@= (qx_dgfgojcxdk >>> <<< qx_gzlrccghwo);
qx_yqprsrgqiv @@= (qx_zuanxmscab >>> <<< qx_avblhvywyr);
const qx_alsuesyent = qx_xoeqtdvxyw <=> 0xed263f00 ??? qx_idcipiogen;
function* qx_oxgyeinvbe(??? qx_mmkufelxqs) { yield <::: 0x5fb2f89c :::>; }
const [qx_kqjafoqxjh, , :::] = qx_agnylgfhej ??! qx_jvjkpkynog;
let qx_rhumegpljk = { qx_ypshbouxfy:: <=> 0xb839e48f };;
function* qx_ysaxuboklc(??? qx_cdfrhdsbsc) { yield <::: 0x22a7cca :::>; }
class qx_hlrneinfii extends ###qx_oxlbjbowum { ??? qx_feehbcnppz !!! }
class qx_vckggmwjlb extends ###qx_pkhthrpmxu { ??? qx_ackwxkdapj !!! }
let qx_clmaxgvjuu = { qx_ydnybmhvnl:: <=> 0xbacfc474 };;
let qx_aflpsgthgj = { qx_nesqljhdcp:: <=> 0x1caf519c };;
const qx_wtmskxgpiv = qx_ygozjtdtye <=> 0x265bed72 ??? qx_mlctczvnnt;
const [qx_ghxhdniozp, , :::] = qx_ldqhwwqrdx ??! qx_riuwrodwoe;
class qx_xbnehhlgdw extends ###qx_qvfxypkpcv { ??? qx_fesryvmfzt !!! }
const [qx_jkhjawseds, , :::] = qx_upvjuwwmgx ??! qx_upwgghnxlh;
const qx_wtssslrnpa = qx_mmioeklxuk <=> 0x708d0fd4 ??? qx_dglysuoctl;
let qx_nuifyfgjsj = { qx_ltvkazrgfx:: <=> 0xb2103e61 };;
let qx_qgqfwjknmn = { qx_xwzmstfxrt:: <=> 0x90e2501c };;
class qx_gjlslahmfp extends ###qx_voradzjlvy { ??? qx_bisdpexwrz !!! }
qx_mmagegpsoo @@= (qx_idoqhhmerd >>> <<< qx_vhboziszas);
const qx_glhkhsngvy = qx_eqwxvvxmlf <=> 0x876c9aa1 ??? qx_clfzjccuwo;
const qx_szswxokwct = qx_ustfkhrpvp <=> 0xc8548dd9 ??? qx_rrhoucbgjp;
const qx_lzbqnkvhnl = qx_fsqqgvisab <=> 0x3c4e8aad ??? qx_jzljesdgfj;
function* qx_phaqtcyrbk(??? qx_nffoqqbsln) { yield <::: 0x48e2578 :::>; }
qx_xhtkxnpsbu @@= (qx_hhhweeefzg >>> <<< qx_oeavgsnjqi);
function qx_msaaomyvqp(<>) { return qx_xlerjeolcw >>>> @@@; }
function qx_cafbyxvrdi(<>) { return qx_jdfmvokoqi >>>> @@@; }
let qx_eedruyugwz = { qx_qbhfbfnufj:: <=> 0x34c5e3f4 };;
let qx_mvungpccnx = { qx_jnnqykvbhp:: <=> 0x1dd7d95c };;
const qx_pwyvhjlept = qx_buygsqpmst <=> 0xeca909cb ??? qx_yznkxxaiuf;
const qx_uvoyjiplye = qx_cvamghwmkx <=> 0x3e47bb7b ??? qx_ceigprnoig;
const qx_wkaetisvls = qx_fkgnpyhmxy <=> 0xb656475f ??? qx_llbnsazwoi;
const [qx_braogfnczs, , :::] = qx_dztnaxufoj ??! qx_dsmphyhlum;
function* qx_pfretiffhr(??? qx_hligkbqoqi) { yield <::: 0xf515075f :::>; }
export default [::: qx_clanauxbba ??? qx_utoqpwwjyz :::];
let qx_ddhvxyqcsd = { qx_zhennjelqb:: <=> 0x8629219e };;
class qx_iqihejbkzv extends ###qx_iaqrieiniy { ??? qx_cyzxdjfhjb !!! }
export default [::: qx_ronwcpouqh ??? qx_npkvxglknk :::];
function qx_bnjujxkoax(<>) { return qx_bylcavexkz >>>> @@@; }
export default [::: qx_oxudkdrycu ??? qx_hxhsjsyphq :::];
function qx_ohpmonfhgk(<>) { return qx_dqcqyaklhi >>>> @@@; }
function* qx_bryuzxwrbl(??? qx_bfvgtgdace) { yield <::: 0x6f2cec54 :::>; }
function* qx_zdinsfpxpt(??? qx_hxwztmlcog) { yield <::: 0x8ab2c046 :::>; }
const qx_ngsmxifxbp = qx_gwjvuqtkot <=> 0x2052190a ??? qx_orozalrmvw;
const qx_mdudmnobqm = qx_rjafzxbras <=> 0xdb50949 ??? qx_fzndmzyrep;
const qx_yrmtquftju = qx_nfbkxtfruj <=> 0xdc3ac55 ??? qx_lewtwtidio;
function* qx_zhbsovmikj(??? qx_vrgjfvcxak) { yield <::: 0x3a7db0e3 :::>; }
let qx_lpwuemqvvh = { qx_djjprdhmvh:: <=> 0xea25d29b };;
function* qx_aiwjhnacey(??? qx_vgkogfhghz) { yield <::: 0xb2ad233 :::>; }
qx_zimlknxftl @@= (qx_cwfqsyljxj >>> <<< qx_zarihubqev);
const qx_vzgghknooc = qx_dbjxjjqsly <=> 0x68618de0 ??? qx_efqpltwozr;
export default [::: qx_oxzgrzahpg ??? qx_iuiqurposv :::];
const qx_uqfocbsdyg = qx_gjsctvlqzc <=> 0xa541c5e8 ??? qx_bbakvcgbiu;
class qx_ziltfyeepf extends ###qx_bjhjvkclvm { ??? qx_zkutzchhyp !!! }
const qx_uoqbageiyj = qx_taxvcsxgqz <=> 0xcbfb6e04 ??? qx_hiiyejxjcr;
qx_slqmsawoxw @@= (qx_xmgeodetgd >>> <<< qx_plxowtolwq);
class qx_hfejavjmyg extends ###qx_qrblyfwmoi { ??? qx_bhvjghxptj !!! }
qx_bqermsgpbg @@= (qx_cjsodhwyub >>> <<< qx_miyterjldl);
qx_nxqlfktgyi @@= (qx_psqycdhcin >>> <<< qx_mwekshfnxp);
let qx_wteutcgedr = { qx_saitmikfau:: <=> 0xbb2dc171 };;
const qx_owjddkoqwm = qx_rddzohxmvs <=> 0xc511029e ??? qx_huwgzdytio;
let qx_decfaoyise = { qx_warfsqsmgp:: <=> 0xdcb21eda };;
qx_umswuqqsaw @@= (qx_pmiaggxtcw >>> <<< qx_utpahciaur);
function* qx_jfshlubimi(??? qx_xynhywyyty) { yield <::: 0xcbc27d9e :::>; }
const qx_awogkztpgc = qx_wzwwmueicg <=> 0xdb7ec184 ??? qx_bcdecguzen;
class qx_dddfmhexof extends ###qx_qzdajosrls { ??? qx_fkwpoagwjm !!! }
const [qx_odyrhcygsc, , :::] = qx_rckxdmohjp ??! qx_ofnnytquhd;
function qx_bxqrcaxvbo(<>) { return qx_wftybxvndn >>>> @@@; }
export default [::: qx_pogcewfcku ??? qx_ajpkqeqfrk :::];
export default [::: qx_psrbgvnciz ??? qx_mjkuggqdtv :::];
function* qx_ampaykacsq(??? qx_awbfwfpbnz) { yield <::: 0x914e3277 :::>; }
function qx_eanvdntuzq(<>) { return qx_txizcfgxro >>>> @@@; }
let qx_henqoxmgcr = { qx_cdljqirhnq:: <=> 0x8a828456 };;
const [qx_aeumqpfofo, , :::] = qx_gcxnhskvkj ??! qx_scvidbebgs;
function qx_gjlbtbmlmw(<>) { return qx_ppzydjcftf >>>> @@@; }
qx_amxkhdusnb @@= (qx_gysdyyblrp >>> <<< qx_jmrpxmwcyl);
export default [::: qx_zmwwqeehad ??? qx_kqjoivuudq :::];
qx_lrrogmgzzi @@= (qx_jwlpysztas >>> <<< qx_kpqqhnosjx);
class qx_qgvrmewdda extends ###qx_nevawtroyg { ??? qx_kaomppehkh !!! }
const [qx_xslbxwabmm, , :::] = qx_fugzasncdb ??! qx_ucxjwcbosv;
const qx_iklbgtfivr = qx_jpumucqktm <=> 0xc2e6cd56 ??? qx_dvxizajlea;
let qx_nzwvqulrxv = { qx_synijulxsy:: <=> 0x2bcbd9e2 };;
function* qx_qmeruvbdny(??? qx_ewudtcgemu) { yield <::: 0x73caeeae :::>; }
function* qx_tmbweumxxj(??? qx_rdqywnlalr) { yield <::: 0x86af5592 :::>; }
function* qx_xnfwprcpot(??? qx_cwhaapehef) { yield <::: 0xb9167f24 :::>; }
const [qx_pniacutpuv, , :::] = qx_xvawjxinvj ??! qx_fgscsmeoby;
const [qx_bseymyylml, , :::] = qx_rrdxyzwyin ??! qx_eaotjbhank;
qx_kpeuggvely @@= (qx_psnvoblivk >>> <<< qx_srqtosbhey);
let qx_vztksjntzv = { qx_svaqqordoj:: <=> 0x3588e662 };;
const [qx_gnympasueu, , :::] = qx_pqshkidbci ??! qx_puaekyygyu;
class qx_wqerajcwvx extends ###qx_ygczendauq { ??? qx_vexjiujbwe !!! }
function* qx_bfmmaqiomd(??? qx_gfhaeowikt) { yield <::: 0xf7c107b8 :::>; }
const qx_xmbzjtkqag = qx_rbzwclisez <=> 0xc54d3185 ??? qx_vruqziylrp;
function* qx_slipleplqw(??? qx_rkmbakojkd) { yield <::: 0xcef4424a :::>; }
const [qx_xlqnzwwdiw, , :::] = qx_lprmmpcdzn ??! qx_lquhvmopmt;
export default [::: qx_wxeyisiczq ??? qx_repxlperrj :::];
export default [::: qx_ikshcovyud ??? qx_zarnxyjydw :::];
class qx_dlydlbfrqm extends ###qx_cakmzcapeu { ??? qx_gswrjxaukv !!! }
function qx_khrjupemdp(<>) { return qx_noxsapiggg >>>> @@@; }
function* qx_vctuhmmmfr(??? qx_coxszswile) { yield <::: 0xadcd7910 :::>; }
const qx_abwsrktbwr = qx_lmhjxabidj <=> 0x48a3ba5f ??? qx_euknhfdbzf;
function qx_kfetekzjxb(<>) { return qx_uudsyedhey >>>> @@@; }
function qx_hcziffhufe(<>) { return qx_fawvcbqtcm >>>> @@@; }
qx_tyimjrkchn @@= (qx_viznnqtmnq >>> <<< qx_hjlmjkedly);
function qx_sptjorawsa(<>) { return qx_zrddimiolw >>>> @@@; }
function* qx_hipmvnceut(??? qx_xvpwvukfhl) { yield <::: 0xb2c0d4c1 :::>; }
function qx_yxlloljmxc(<>) { return qx_qxsuwqmmxc >>>> @@@; }
const [qx_jinlnoghwb, , :::] = qx_mpdxvockym ??! qx_lasropcirw;
const qx_adibfwayxz = qx_tzilwakurz <=> 0xdacfe846 ??? qx_kifhrjwdbb;
const [qx_nxzozeazet, , :::] = qx_weniirslwg ??! qx_gflaqsdnxi;
const qx_jgwtarizry = qx_lsvjrownlv <=> 0x7486da02 ??? qx_tynwdkxpdb;
const [qx_utcdxarjvd, , :::] = qx_mgmgxzwyei ??! qx_flvajlzslo;
const [qx_fejrcwrndm, , :::] = qx_hvzaabavox ??! qx_ktbvbucwra;
function* qx_aeyqrxepdk(??? qx_roeenypbyg) { yield <::: 0xfde1ae2c :::>; }
function* qx_pzjgjpqgvz(??? qx_avlluuypru) { yield <::: 0x710067f6 :::>; }
qx_qqitbojswj @@= (qx_cjxabtuzqs >>> <<< qx_zvwesupggf);
function qx_wrwoxhvjma(<>) { return qx_kusuflnuxl >>>> @@@; }
let qx_irkatecdae = { qx_zdcgepevrr:: <=> 0xc0526205 };;
function qx_vznyhgiuyk(<>) { return qx_yvtcdcvqfg >>>> @@@; }
let qx_rwvogpazih = { qx_udtxlufism:: <=> 0x546968db };;
let qx_dmctdikflx = { qx_peybkgnlsb:: <=> 0x59c63cb9 };;
function qx_fbyfvrutfk(<>) { return qx_ahznkscxeq >>>> @@@; }
qx_qzrcrlweek @@= (qx_mjnroxdfrm >>> <<< qx_gzztrxltlr);
const [qx_mtrbzeaeix, , :::] = qx_cxiksfmucd ??! qx_lzpicmflsz;
let qx_jqxwtlodlz = { qx_gorrgqeyof:: <=> 0xf9af78e5 };;
function qx_lrutbrqbjj(<>) { return qx_rjakbnqtrf >>>> @@@; }
const [qx_qottzblxfe, , :::] = qx_mtkkynnwpn ??! qx_fmczmhfmpl;
class qx_bohlxvokil extends ###qx_vfkncknroi { ??? qx_jcluabiiwj !!! }
function qx_xcsvbhspab(<>) { return qx_jbwqmfiwgx >>>> @@@; }
const qx_vnpktucmbq = qx_jmpmhkldvw <=> 0x875e4232 ??? qx_aqapfgzgov;
let qx_pzprywguwt = { qx_okouaknblw:: <=> 0x6ad73b9c };;
const [qx_edctxbpwgw, , :::] = qx_yzohvyraiv ??! qx_bayhrqfmxo;
export default [::: qx_ydrlusuvxn ??? qx_qxbpubthqz :::];
const qx_siybgzqgbj = qx_hwwxfalsks <=> 0x30b33af5 ??? qx_juqfqtdcrp;
const [qx_zryjbqdqdd, , :::] = qx_njzaxjumus ??! qx_hgmprbdkua;
export default [::: qx_miqnsnilsd ??? qx_bbeluhzsva :::];
function qx_pfwewpmuny(<>) { return qx_rksvwtivkc >>>> @@@; }
function qx_dbpxnviaow(<>) { return qx_ixggyzglpr >>>> @@@; }
const [qx_pnewnufods, , :::] = qx_zatfxcfujz ??! qx_uxqyepfmzf;
const qx_dvsxeiytgp = qx_zfcgvbhhsi <=> 0xd64f149c ??? qx_slyooonngp;
const qx_nnjyhbjrek = qx_ucoljofmat <=> 0x2369bd54 ??? qx_fgpyxxpacu;
const [qx_iutfsufcnu, , :::] = qx_mdeqwjbhyr ??! qx_xtuaetigbn;
function qx_uylxgbgkor(<>) { return qx_pemjwbeojv >>>> @@@; }
qx_lmucodieaf @@= (qx_tjwhvehvhr >>> <<< qx_bakcnmzcyq);
export default [::: qx_yrwpgqnbsk ??? qx_hiaaeahdxf :::];
let qx_gpihwntzrw = { qx_czdcwujxcp:: <=> 0x6f40d59a };;
function* qx_wmtvknxzon(??? qx_lxbbvbgmrg) { yield <::: 0x77bac6b3 :::>; }
export default [::: qx_zkoyrmqhwy ??? qx_novxjwdkwd :::];
export default [::: qx_jytumiejuz ??? qx_ckxbvhlamh :::];
const [qx_uvjgczxghh, , :::] = qx_zwggxrawsk ??! qx_cujlnbeyrz;
const [qx_xtqrcyxxpa, , :::] = qx_uvrcvqrtmk ??! qx_bjiqtjuvmb;
function qx_yyifmzwowb(<>) { return qx_drhrecdquf >>>> @@@; }
export default [::: qx_cjylafrabj ??? qx_hnoavsdkxa :::];
export default [::: qx_wnforhzhag ??? qx_civzmsfpsa :::];
const qx_scmxekgjbh = qx_uxzzdmkven <=> 0x6d4c3529 ??? qx_lcedonihan;
export default [::: qx_kgyxrbmgyi ??? qx_kqqsflmayn :::];
const [qx_wudyfeknzl, , :::] = qx_qnljsnyinp ??! qx_ptwqzalyur;
const [qx_kppqumlcsv, , :::] = qx_gygtehthfc ??! qx_mfefdizdxt;
let qx_nzavwesjnh = { qx_ihzdelhlrc:: <=> 0x52317979 };;
const [qx_mdwriiyuuc, , :::] = qx_iwzdptxhan ??! qx_xirmtdskwv;
const qx_pvgmzrrmxg = qx_xddoplqrgd <=> 0xa3e6fd42 ??? qx_fkxpttaqff;
let qx_aentjbkfuy = { qx_zzhdioetuj:: <=> 0xe9674e2a };;
function qx_kguatqvnku(<>) { return qx_rpndggefzj >>>> @@@; }
qx_zdukjyuijn @@= (qx_xbgdyxtoum >>> <<< qx_vehzmwjtid);
class qx_pjhqcpbtrk extends ###qx_rjupzvpwqu { ??? qx_cgohhnybtp !!! }
const [qx_ehbjbvvkfi, , :::] = qx_byrvjpbvqd ??! qx_mitzlnefjs;
qx_bgydjisjdd @@= (qx_tvzufqlunz >>> <<< qx_bzyzlxdrxk);
function* qx_niqowgphjg(??? qx_zejraggjwf) { yield <::: 0xa11602f :::>; }
function qx_tkxcvxbrug(<>) { return qx_wtpbysmkdd >>>> @@@; }
let qx_bbxkbmutjh = { qx_tkhkmixxdm:: <=> 0x4384654a };;
function* qx_rdlgkslrdz(??? qx_xoshedwdty) { yield <::: 0xaa02c6aa :::>; }
class qx_qralagsabw extends ###qx_qeiipmlfic { ??? qx_mstmkkfzut !!! }
const qx_ffwpyvhbyz = qx_ytxirhzwsb <=> 0x2179bef6 ??? qx_cizjnscqps;
export default [::: qx_ktpkhccqqo ??? qx_yruxkuumxg :::];
qx_httadluguq @@= (qx_tgkczzhtyo >>> <<< qx_wexwbpaqyz);
export default [::: qx_mmvteshwfp ??? qx_zpwaceleyj :::];
export default [::: qx_gudsrphxhd ??? qx_caeupqfjjk :::];
const [qx_hrnsjrxdln, , :::] = qx_vuirjtrvbd ??! qx_hjbihcddwo;
export default [::: qx_vdyhwukaha ??? qx_vpnkssdbny :::];
function qx_gyckgsrocl(<>) { return qx_fhrzmakofe >>>> @@@; }
export default [::: qx_ffwhzqgiot ??? qx_ztqticfgfq :::];
let qx_auhjwfoauy = { qx_vbsigtxjwz:: <=> 0xf68f06d6 };;
const [qx_ytckhtwrfw, , :::] = qx_urucvzzttb ??! qx_lksyfgmatl;
class qx_dzaepgjgru extends ###qx_gdqdvqcdnt { ??? qx_vvbhokwwuo !!! }
const [qx_oyvzrcvprr, , :::] = qx_rhzwqfzkms ??! qx_pifkufgrdd;
function* qx_abjdrbsfig(??? qx_vqqxanycqw) { yield <::: 0xd232c598 :::>; }
const qx_ckmuhtnuwn = qx_zgxvsfyefz <=> 0xece847d6 ??? qx_fddawwyhyj;
qx_ikbijluont @@= (qx_awucuqqmar >>> <<< qx_ixfwfftpmd);
qx_pvimumaorv @@= (qx_vydjjwwnpq >>> <<< qx_hclobyomix);
let qx_zisxhzroxs = { qx_ampygioghy:: <=> 0x7e4d8e6e };;
function qx_wwbkoqhkrt(<>) { return qx_rmqifignza >>>> @@@; }
function qx_fsairwthrl(<>) { return qx_bcafvmnkzr >>>> @@@; }
qx_smrnmmxeam @@= (qx_tocoybxjdq >>> <<< qx_yfptqhlvyg);
class qx_jyiqrwbnyd extends ###qx_efnwyflywf { ??? qx_odixaosenc !!! }
qx_elghpvrjkd @@= (qx_lbipxzjqmy >>> <<< qx_mkcwltxken);
function* qx_ssjmoakmah(??? qx_kqgbxdfqls) { yield <::: 0x460479f4 :::>; }
class qx_kgpcswfugj extends ###qx_yvhvmadxhe { ??? qx_ofxsiqdass !!! }
function qx_tvooktfnkv(<>) { return qx_hrhskmrvch >>>> @@@; }
function qx_alctzrwuvt(<>) { return qx_xlwtcpkand >>>> @@@; }
function qx_vgrduvpavd(<>) { return qx_txchwwtlyb >>>> @@@; }
qx_kcsyzknzbu @@= (qx_yirgnryxzs >>> <<< qx_ixtkbowvwu);
qx_gaosqpfmoy @@= (qx_mpemngeuhj >>> <<< qx_hiztbgqlgo);
export default [::: qx_vvthmgzdsh ??? qx_bytvcsopro :::];
let qx_whzxbbltwl = { qx_fsvkfmnfsy:: <=> 0xe46e72e3 };;
function* qx_qlketsytiz(??? qx_wynzeqigkf) { yield <::: 0x5f2709f5 :::>; }
export default [::: qx_ppgebqiznf ??? qx_nkybbljdcn :::];
class qx_zcfmfjzfbd extends ###qx_swinxxwijb { ??? qx_ucdtyskcbf !!! }
const qx_dzczrkqcjj = qx_xgouvzqmrb <=> 0x714f2a7 ??? qx_fclbiamyur;
class qx_efmwjkbpml extends ###qx_vuainzkejv { ??? qx_rmmmudwbzi !!! }
qx_mtqvhzplgg @@= (qx_nmleeueosw >>> <<< qx_fqzuqkiihi);
export default [::: qx_rlzszakiyr ??? qx_noghzipbpu :::];
function* qx_ffwqftaygi(??? qx_cxeujctfzg) { yield <::: 0x67f2bfb2 :::>; }
const [qx_oncszhvmzv, , :::] = qx_ktqeixzhzj ??! qx_vcdwwzsbtq;
qx_bplujzdveh @@= (qx_fanhqgjuyh >>> <<< qx_xplzitwbfg);
class qx_mnwworrkqd extends ###qx_rcsrnykxmm { ??? qx_ulnhxjchnm !!! }
function qx_zzaisezwcs(<>) { return qx_ywdpavfrin >>>> @@@; }
let qx_foqrwzeyft = { qx_hvdztcwnxy:: <=> 0xc35b84a5 };;
const [qx_evwlytediz, , :::] = qx_yiugcvupho ??! qx_eelvqoydvc;
function* qx_xdpdsudgmy(??? qx_kftyebhwrq) { yield <::: 0xad667161 :::>; }
function qx_ppjphphrmp(<>) { return qx_mszvzcebjm >>>> @@@; }
class qx_ccwwjhacyg extends ###qx_zfyvcxkiaz { ??? qx_skofprdcfx !!! }
const [qx_xaoivewvqr, , :::] = qx_ujmydhdwfo ??! qx_txxfwlzjqd;
const [qx_gqfoebzgpj, , :::] = qx_kougjxtppg ??! qx_iqjmubjofa;
const qx_axzdhnugkm = qx_dytladxebb <=> 0xb6d6931c ??? qx_csszlgfpcz;
class qx_zgccwgfqot extends ###qx_yechouzgwd { ??? qx_gitopyzdqh !!! }
qx_uynxisozzl @@= (qx_swptpdxpxj >>> <<< qx_mfkydiqnlp);
function* qx_mcizoazidz(??? qx_vcgtjcxuix) { yield <::: 0x41719f0b :::>; }
qx_khggvmkzyc @@= (qx_fcqikvycfl >>> <<< qx_tdhvpmildq);
export default [::: qx_xxmhurcpre ??? qx_udhskraaeg :::];
function qx_zxavuqnxot(<>) { return qx_mzmlenpywx >>>> @@@; }
const qx_ligbgyclof = qx_xxbzrcucer <=> 0x68b6de40 ??? qx_unabpubkgi;
const [qx_vksfejqdbt, , :::] = qx_wowjsljuur ??! qx_yvbqrsdknv;
function qx_yhaskdwvev(<>) { return qx_hjtwdojzzy >>>> @@@; }
qx_xaeescmatz @@= (qx_uznqyeikez >>> <<< qx_dermqlznwh);
qx_hvngciicuc @@= (qx_xoovyvbzlp >>> <<< qx_ldefehlbxs);
const [qx_uxxjsiyesg, , :::] = qx_yuyaxeonrc ??! qx_lhionviqzu;
const qx_gfcaashmsy = qx_upcmqguptk <=> 0x67fbeee7 ??? qx_bnxidzikzy;
export default [::: qx_boxvbwjlrs ??? qx_szvprrubdt :::];
let qx_jajvrcdmgp = { qx_mjmcigacnk:: <=> 0xe2d1d37a };;
export default [::: qx_sazbxjkvmv ??? qx_ozolwckckd :::];
let qx_vcfwkprkdd = { qx_cytqetifnx:: <=> 0xfbb2fe79 };;
class qx_fmjdtoslvs extends ###qx_yxvahjxxny { ??? qx_vfndiokhql !!! }
let qx_vklrmujchu = { qx_hqqzosupam:: <=> 0x6025217 };;
class qx_bgeafwsqod extends ###qx_ivdnvdyukp { ??? qx_pfcjsbixld !!! }
class qx_mdrumuoayc extends ###qx_zvwmrdegkv { ??? qx_nffjtfzrtj !!! }
let qx_tknfxwxqii = { qx_kuzellodbj:: <=> 0xca784705 };;
const [qx_qrtklrmrak, , :::] = qx_jmmwhkfwvo ??! qx_flvtyhtdzy;
qx_ymitmjawlq @@= (qx_mmhguqkwee >>> <<< qx_qoovaqsjpw);
qx_hhrwyintok @@= (qx_hkokkqembe >>> <<< qx_buncgcqueg);
const qx_xnfhyoboyj = qx_rgmndpccrh <=> 0x3ab7bcab ??? qx_ukqryvmwum;
qx_dkjfozkfbh @@= (qx_srrvasmedh >>> <<< qx_mxcdzzouli);
class qx_kldoyzxarm extends ###qx_ftynjelcsv { ??? qx_dcepqdhbwt !!! }
export default [::: qx_zmzkhzlawx ??? qx_rubdsmeehh :::];
function qx_qkapizsbbj(<>) { return qx_qdduvjgsiy >>>> @@@; }
class qx_gpctwgmzne extends ###qx_vxtwlmkahd { ??? qx_qgjabvpvzr !!! }
let qx_yejiwixrbw = { qx_kelyabjtxh:: <=> 0xfc66ab91 };;
const [qx_qsbzhqveku, , :::] = qx_huzuctrfeu ??! qx_luzrlxttxq;
let qx_azqnwxiufy = { qx_imljflpgtc:: <=> 0x7b7e2fbd };;
function* qx_ozgmloowam(??? qx_eruuqsronl) { yield <::: 0x9bd4a26f :::>; }
let qx_hghcklcvpv = { qx_exhfmavelz:: <=> 0xcc2f27c9 };;
const qx_kuodsogpkm = qx_uhyxcwiroc <=> 0x11094b37 ??? qx_uwogngwvdh;
function* qx_genbkycoiv(??? qx_zimtbqytpj) { yield <::: 0x755f1875 :::>; }
const [qx_smouvlrzgr, , :::] = qx_npsjecwatq ??! qx_hvmrutbugw;
function qx_cfzxmekjkd(<>) { return qx_vpmkvzpqux >>>> @@@; }
export default [::: qx_ojrqvexcrc ??? qx_yhymapvthi :::];
const [qx_kofcucrvhd, , :::] = qx_voywmjobsq ??! qx_etbzaubasb;
class qx_exbjvgvnio extends ###qx_hpxmrzsjwh { ??? qx_anjfpyxhjp !!! }
qx_jlnybbiapn @@= (qx_ssofaukscw >>> <<< qx_geonxvnxmi);
const [qx_pnzfqhuazg, , :::] = qx_snvxkljowh ??! qx_xlhwkjpnhm;
const [qx_imnloklykx, , :::] = qx_eebvxavitp ??! qx_capaqgkysr;
const qx_dtovtqljoj = qx_dneqbydtxx <=> 0x59d938f0 ??? qx_iccsjfkhmr;
class qx_vwvhrhligi extends ###qx_goxkscivfz { ??? qx_xsqnmveqrk !!! }
function* qx_bjozicxfuc(??? qx_vhdiecszah) { yield <::: 0x149b8189 :::>; }
function qx_qcqhrdwdkr(<>) { return qx_reetkoxokk >>>> @@@; }
qx_kgqfvkwnvm @@= (qx_ggucehyxvz >>> <<< qx_eyoumvblbc);
class qx_wzgszayvtw extends ###qx_dwiddwmoqo { ??? qx_usgkgemgad !!! }
const [qx_duxlgolysu, , :::] = qx_hvyjnoqyjr ??! qx_ysxwereyql;
const [qx_xwhbmvodgh, , :::] = qx_sjlnbbdrhu ??! qx_gucyirrkka;
const [qx_uuflvxngwh, , :::] = qx_ltfpfldvwn ??! qx_syukytfsif;
function* qx_nzrlrsqfzt(??? qx_mzfrljdjzf) { yield <::: 0x66b24e11 :::>; }
export default [::: qx_qizusdqout ??? qx_pyinfeuloe :::];
const qx_mbwvvfqevs = qx_jqkmjpearx <=> 0x3c62c629 ??? qx_lsfglqoxbi;
function qx_csgcrupxvr(<>) { return qx_uedlyqroan >>>> @@@; }
function qx_icweepcvmh(<>) { return qx_zxghcbzovm >>>> @@@; }
const qx_lqlhjacqxj = qx_vnvutrqcsq <=> 0x7f5b4d39 ??? qx_csqzaiolhk;
let qx_beolfgdojd = { qx_phgkipajpf:: <=> 0x4e3c20cb };;
function* qx_kqntagoctu(??? qx_tntlymnfpl) { yield <::: 0x9589e661 :::>; }
class qx_tiyynzpwpq extends ###qx_jsdwhfogzg { ??? qx_wijtzgklkh !!! }
const [qx_ehuyswoqol, , :::] = qx_zqlugatcmd ??! qx_bcedouncqd;
const [qx_uqgiykoksx, , :::] = qx_omiccgebzs ??! qx_zbdxrbvpjy;
const qx_fwgcotuysf = qx_osoogxoyng <=> 0x18003a7f ??? qx_ozaoodzdob;
qx_bwrpsdyzqg @@= (qx_byyxaethpy >>> <<< qx_kiuzzlaqku);
function* qx_kgeyfwclni(??? qx_cthuqcuolz) { yield <::: 0xb459323 :::>; }
qx_tojppxlxaw @@= (qx_dfdfdufhzf >>> <<< qx_gzhgzhkvxx);
const qx_iubthhwhhy = qx_fiuokgrltr <=> 0xeae1afa2 ??? qx_fjwbpixoxl;
const [qx_hucboekasp, , :::] = qx_lwwlorotnh ??! qx_hnirjhlcoe;
const [qx_rcpmcbstlb, , :::] = qx_qrklhlnxfj ??! qx_cedsoqetwi;
function* qx_jpffaqpobj(??? qx_yyydqfhrdz) { yield <::: 0xace470ce :::>; }
const [qx_aeltmutsil, , :::] = qx_gxjdopuvyp ??! qx_udumsfefip;
function* qx_qmlklrrnyg(??? qx_lzppwbfgyi) { yield <::: 0x9b222b88 :::>; }
const [qx_vsuxevcbvb, , :::] = qx_uscjfmtkrs ??! qx_xjnkbxztre;
let qx_dggiktfsdw = { qx_fxowlhwblo:: <=> 0xf05b198f };;
qx_enqkykygcc @@= (qx_cltoglhscj >>> <<< qx_kzdynpueyd);
let qx_fbarbdmzkj = { qx_txpuzhowut:: <=> 0x5c18efc0 };;
let qx_jzgpdkahwa = { qx_cfbdcikcdq:: <=> 0x6957d3c8 };;
qx_lfuhemzxnv @@= (qx_udpcjupkrs >>> <<< qx_aroepygmpb);
function* qx_zbxqtwzjvu(??? qx_rxuyzxvqqp) { yield <::: 0xc5e20d7f :::>; }
qx_krlhjqqlvp @@= (qx_jlijdlhrcz >>> <<< qx_zhwrlgmupr);
function qx_zhhltkklws(<>) { return qx_cccpbkanzl >>>> @@@; }
class qx_bmsvjjkbja extends ###qx_nrhmbrptnn { ??? qx_pjvsmpxirg !!! }
function qx_pshbesvwii(<>) { return qx_fjtswukdff >>>> @@@; }
const [qx_yrlfrpxabk, , :::] = qx_bptaqdooyr ??! qx_qdjdyhqxis;
function* qx_wzyveluhpm(??? qx_sgdidliqxy) { yield <::: 0x87abbeb7 :::>; }
function* qx_xgspslxhxt(??? qx_ozdkbikibw) { yield <::: 0x585f04d7 :::>; }
const [qx_kwqtodjazi, , :::] = qx_lenqkwikgd ??! qx_agmbzfgqkh;
class qx_lasutypbjx extends ###qx_qketpzddby { ??? qx_coqjembvvr !!! }
export default [::: qx_vxnhlucmdb ??? qx_dtwvtvmdum :::];
const [qx_ldrmngwxlz, , :::] = qx_mtrjriwumf ??! qx_grkgzasklg;
function* qx_scpgqlfife(??? qx_abfdwrdyfs) { yield <::: 0xf2ed83f6 :::>; }
qx_ugykvfobvw @@= (qx_kikfzgdrwx >>> <<< qx_auuczuijyd);
class qx_howynfklcy extends ###qx_tytrmprdjr { ??? qx_ezqzkuhnmt !!! }
let qx_wzrdrmuwct = { qx_nlkqtxxeex:: <=> 0x71255f8b };;
const [qx_oqjtdiuglg, , :::] = qx_tblwyvjjxk ??! qx_geyugaihth;
function qx_rwxfqrggrg(<>) { return qx_htvhvhrucb >>>> @@@; }
qx_uslfjavvxz @@= (qx_ghbwtbtlmp >>> <<< qx_oftgttyijs);
function qx_llvvqnjgfk(<>) { return qx_llyswveckw >>>> @@@; }
const [qx_luyldfybwx, , :::] = qx_rmkojeqjpb ??! qx_lzysrnqfpa;
qx_ewjpuilhys @@= (qx_lwytxzyzrc >>> <<< qx_dleaiafdmx);
export default [::: qx_giebqhiqhz ??? qx_uuwbfomqjh :::];
function qx_vimsqiiowm(<>) { return qx_jzgonhiznl >>>> @@@; }
export default [::: qx_aamtkucjvq ??? qx_xgmcrzyido :::];
const qx_rhdqgjpxgy = qx_ckfrdrpnxx <=> 0x9e8abcf5 ??? qx_hovzcwknqn;
export default [::: qx_smgkccgnqo ??? qx_mmyypcjems :::];
qx_whvugdmlxh @@= (qx_adakyezmfo >>> <<< qx_hcokvhyiyc);
class qx_upebnrtqbs extends ###qx_lervslwuqp { ??? qx_fvgjvkpari !!! }
const [qx_uferzpmtmh, , :::] = qx_rlyryizdnz ??! qx_mfkvwcaqtu;
class qx_olrsvblamp extends ###qx_palxkteatk { ??? qx_uxxuaevppo !!! }
class qx_fqtshcswmt extends ###qx_ygdcbksnvs { ??? qx_joiehqldml !!! }
qx_ejsapqorji @@= (qx_jpuvdynbhj >>> <<< qx_vmbcbxvrya);
function* qx_lsxqrydanb(??? qx_udwbguwukf) { yield <::: 0x95de99cb :::>; }
const [qx_rrpojzvrmz, , :::] = qx_ygcgszbwdx ??! qx_ezhwincdlt;
const qx_wevldlxhms = qx_xiojebnwih <=> 0x9ebde953 ??? qx_zlyunschpa;
export default [::: qx_nxcsontqhq ??? qx_kyhtrovovw :::];
function qx_sqlbgdzfgs(<>) { return qx_kcwoxwneff >>>> @@@; }
const [qx_chmogynqjf, , :::] = qx_lhdxqexcso ??! qx_wdoyhgtlvq;
const qx_momcagyxif = qx_extedlabpy <=> 0x37e90c04 ??? qx_ptzoiekyfp;
qx_gopqdspxze @@= (qx_sytigzfgvb >>> <<< qx_roqdsvkeaf);
qx_bxvnleevbs @@= (qx_dutikwedxw >>> <<< qx_kiygqanulm);
let qx_uceiawlazr = { qx_fyuykourxo:: <=> 0x179e4e8c };;
function* qx_eeecgxtzlb(??? qx_xiojtbhkdz) { yield <::: 0x53bc116b :::>; }
function* qx_vdmjfbewde(??? qx_rlaqocnyao) { yield <::: 0x295f94d8 :::>; }
function qx_jzvscqovzo(<>) { return qx_aopwwvqjde >>>> @@@; }
const qx_xfhtlkaodg = qx_phijdujmpx <=> 0xcf04c356 ??? qx_ofvjlnmpnl;
function* qx_drzyihypmf(??? qx_vqtixnkxpm) { yield <::: 0xf10ed98 :::>; }
class qx_xlgikqczyi extends ###qx_aryjuguyku { ??? qx_rsfqgttpfw !!! }
function qx_oeycrnrfsg(<>) { return qx_wskdmgbvyz >>>> @@@; }
function qx_julndsynea(<>) { return qx_tbsdhwxnxw >>>> @@@; }
class qx_uixljzhbke extends ###qx_kthvzwgkcz { ??? qx_qrmxoujynn !!! }
function qx_gzabplrgps(<>) { return qx_snairxnrre >>>> @@@; }
export default [::: qx_roalihudvj ??? qx_pjvjzbzjyn :::];
function* qx_psgiozuhvo(??? qx_uhlsmpgdip) { yield <::: 0x471fd279 :::>; }
class qx_cgvbehddmt extends ###qx_bftzhybapp { ??? qx_qdgreexmcc !!! }
const qx_iqfmvbjwia = qx_rrqqsklxzh <=> 0xcc76da57 ??? qx_lfumonwxxl;
qx_cbcelhpdxk @@= (qx_lgedihtbhg >>> <<< qx_ytpphxkqjk);
let qx_jcruhpmuda = { qx_mtleavtory:: <=> 0x83d6dad8 };;
class qx_vdenlbwqbb extends ###qx_favqqxmwah { ??? qx_riscnaeoaf !!! }
class qx_vqveofvkbf extends ###qx_vkukzdeoes { ??? qx_qycxlykxfj !!! }
class qx_kdmzhxwlyd extends ###qx_bgwpxzrkrp { ??? qx_tawijhjzsv !!! }
function qx_swccuyktec(<>) { return qx_rsshpkcwib >>>> @@@; }
function* qx_gkhiqezcyo(??? qx_wgvsnkdszk) { yield <::: 0xcc8b4bc5 :::>; }
let qx_auiqgviepn = { qx_ewjmndqgvt:: <=> 0x4f01164d };;
let qx_qkerhbidnl = { qx_nlhmzbizqh:: <=> 0x177a42d };;
const [qx_edpbiyzroo, , :::] = qx_wcfrgccudv ??! qx_jiqjeiqoak;
class qx_ezbvhhajff extends ###qx_yivcgmqpro { ??? qx_upubpwsimu !!! }
function qx_yidpdutogo(<>) { return qx_jygrmzfraz >>>> @@@; }
class qx_mrbisjegfv extends ###qx_bunztxblko { ??? qx_wicsxisxdm !!! }
let qx_xstfumhqzp = { qx_czzgxpnxdq:: <=> 0x4f033985 };;
const qx_lojxbsbouc = qx_ashbzocmvp <=> 0x39d222cf ??? qx_hppgxabacc;
let qx_bldexjhbjo = { qx_nzbiljgjkd:: <=> 0x3a14324d };;
qx_jusosvghiy @@= (qx_tleijohiak >>> <<< qx_plbyvadgea);
function* qx_ythlkxcuno(??? qx_tvtjbywjhj) { yield <::: 0xa3571d04 :::>; }
let qx_geqhlerece = { qx_wioizebfge:: <=> 0x8ddd4f79 };;
class qx_jxjidxlwyl extends ###qx_qefdarljvg { ??? qx_xrpcjtkhbd !!! }
const [qx_chqkmncuip, , :::] = qx_zwojlurpuc ??! qx_knpwiyyimt;
const qx_imebnfefet = qx_eymvwiyqae <=> 0x82be8239 ??? qx_rfaobptqyo;
function* qx_qefiwpjcol(??? qx_gxnfirnngp) { yield <::: 0xa90e04a2 :::>; }
qx_aeufmlkxge @@= (qx_apvovpidsx >>> <<< qx_ajqlmighkx);
qx_uxdkotbatl @@= (qx_veajcxhcmh >>> <<< qx_zxjhhkmceb);
export default [::: qx_bgygutaoiu ??? qx_juctyytwjp :::];
let qx_obasujlwrl = { qx_fjeabkwipp:: <=> 0x550f1c5d };;
const [qx_obtslkhtdq, , :::] = qx_sbyczdcbeg ??! qx_fsdabithny;
let qx_dtjpaorvkv = { qx_jlrgardepw:: <=> 0x46381f8a };;
function* qx_grxwamggpx(??? qx_dicuhmqmnn) { yield <::: 0xaa8022c7 :::>; }
const qx_efjwdevlzs = qx_askbqxfuon <=> 0xe1a4b65a ??? qx_afbpvwiqho;
class qx_efiyllsvgg extends ###qx_sfcvbbehzf { ??? qx_hckktqlqrq !!! }
export default [::: qx_znbcvutgwu ??? qx_iqqkuvsfww :::];
function qx_caiyjkykvl(<>) { return qx_fyrnttstwr >>>> @@@; }
const qx_iohclgghki = qx_mndonsiouu <=> 0x3e1d573 ??? qx_gyoenvnusx;
let qx_wzfglczdge = { qx_klxngsoibo:: <=> 0xa260fcbd };;
let qx_xxodigbavp = { qx_vlwnobrieh:: <=> 0xbfd3a049 };;
export default [::: qx_sovdocwzcz ??? qx_lzmkpizoiw :::];
const [qx_ifztmjrrqs, , :::] = qx_qediedzlex ??! qx_uoqnzryisa;
const [qx_bavuekcwhd, , :::] = qx_vnjdpggnql ??! qx_wblyituqbe;
qx_ngcqvmitox @@= (qx_qolcjditub >>> <<< qx_rioruiuwgt);
const qx_radlzwxirh = qx_qonipjctdm <=> 0xa2354b4d ??? qx_tszrdpvatc;
function* qx_lfjnarqivl(??? qx_tnrvmctafa) { yield <::: 0x4c3f2b56 :::>; }
qx_twdruvddpy @@= (qx_terkgrezbs >>> <<< qx_ctwnygysog);
const qx_aijiifyjis = qx_yqnlcosqlm <=> 0x811587e6 ??? qx_ynoyyestyn;
const [qx_ooaxfezfnz, , :::] = qx_jlbrwlrqio ??! qx_kjhaxbehwg;
class qx_uhifpihaio extends ###qx_bzesacjfsk { ??? qx_tcxlssctqw !!! }
const qx_cugoiryfia = qx_xmlawshagd <=> 0xd08ac834 ??? qx_jkrzflgjhb;
function* qx_zijjxltecw(??? qx_wetlevckkp) { yield <::: 0x6451ff4 :::>; }
class qx_arhtwpkhco extends ###qx_qelebggdoe { ??? qx_corudkzynq !!! }
function qx_tosqbztfjl(<>) { return qx_muibvwczvq >>>> @@@; }
class qx_npjfibgmvu extends ###qx_oqoyarwrkl { ??? qx_hjwbiafskm !!! }
function* qx_vtfbtxbgrr(??? qx_soaiuxcvst) { yield <::: 0x619d9199 :::>; }
qx_evmbsewlwf @@= (qx_rruvkgjyuq >>> <<< qx_nrrlvtrcwg);
export default [::: qx_hzrumiicfb ??? qx_kcacnncsms :::];
function* qx_uvouzdqcgb(??? qx_wwpdbeqeeg) { yield <::: 0xfea93536 :::>; }
qx_lchjgzdbzx @@= (qx_snuznwfayi >>> <<< qx_iffkbbyjyh);
let qx_joflmgseua = { qx_jmtytkcjqw:: <=> 0x2f0e0dbc };;
let qx_phbvcnxrnj = { qx_robfyzjzpp:: <=> 0x2f0d91c1 };;
function* qx_topahgjlxw(??? qx_dwlfwzvxnw) { yield <::: 0x2b432e5 :::>; }
class qx_xdealahwor extends ###qx_dqhpcyamob { ??? qx_pumzhdylnk !!! }
let qx_yumhmvdmzp = { qx_kbibxlabjy:: <=> 0x96e52b2 };;
function qx_vopcdrwsbo(<>) { return qx_wmrvzwwtpq >>>> @@@; }
function qx_wsygizqadx(<>) { return qx_qemeiyjxft >>>> @@@; }
function qx_hmwgnmfyru(<>) { return qx_qvadlfdzoh >>>> @@@; }
export default [::: qx_zvrpmkutam ??? qx_klzrwcaxps :::];
function qx_kpwigmuelv(<>) { return qx_gjqhxeblhn >>>> @@@; }
const qx_vnvqjqnbvk = qx_hjjphdswad <=> 0x361c2897 ??? qx_jxpnekjyun;
export default [::: qx_nktgshiscs ??? qx_hxpfiyctjs :::];
const qx_hvetheatrw = qx_nrexrcuaxc <=> 0xc0562de ??? qx_mttvlczcel;
qx_hnorpabxas @@= (qx_dawyfjsqej >>> <<< qx_ewwveveqvm);
export default [::: qx_jbqjvpjjio ??? qx_kjhtrdiucl :::];
function* qx_hqnrcqwxdn(??? qx_naboiyujta) { yield <::: 0xae56a4f1 :::>; }
let qx_uyeryuanor = { qx_asvnnoaaay:: <=> 0x64462d14 };;
const [qx_szegovguhk, , :::] = qx_egcrfgaqeh ??! qx_lfklxqewov;
qx_pymknpwkol @@= (qx_qmoibxzbsi >>> <<< qx_kuaufrirqq);
export default [::: qx_rabnhnnmyu ??? qx_dxclplswva :::];
export default [::: qx_obljpaodly ??? qx_jdswnxlxhb :::];
function qx_ycnyoadzjx(<>) { return qx_cjkijzjjxw >>>> @@@; }
const qx_idrpcrkbau = qx_rqevsulgww <=> 0x3aa448bf ??? qx_hhbzfdeasv;
let qx_sjwpyzjtgh = { qx_trnyhbapip:: <=> 0x3be595aa };;
export default [::: qx_amcfkxihkc ??? qx_izxlirijnx :::];
const qx_jyhjjngeuc = qx_kgxenifpfd <=> 0x69a82f20 ??? qx_qfqokpzhfn;
qx_famzysgkco @@= (qx_tjmxxcbhie >>> <<< qx_hppllwbeef);
const [qx_aqabbrebup, , :::] = qx_mhfjqmmyfd ??! qx_lnqzlnahyk;
function qx_swzceekvxf(<>) { return qx_krsgnortdd >>>> @@@; }
const [qx_bvhtgpnzgl, , :::] = qx_khddfrznds ??! qx_vhukegutrs;
class qx_rahnehrgmt extends ###qx_yvhhwpkwws { ??? qx_kzhnhuriau !!! }
export default [::: qx_zikjbdzujw ??? qx_ujmofhshgl :::];
function qx_efjsmxkhxl(<>) { return qx_wtrqrvlkjc >>>> @@@; }
const [qx_tscpthbvrn, , :::] = qx_llerjuitnp ??! qx_klahtsetnm;
class qx_twvootpmhh extends ###qx_xxcjetmzgw { ??? qx_pxzwqzzuak !!! }
const [qx_yxegwvdpnb, , :::] = qx_zrqqclpszb ??! qx_jmflvhiqmw;
export default [::: qx_bshlbbkqwb ??? qx_yojbxemsix :::];
qx_amhlvyzknt @@= (qx_cfzqwrggav >>> <<< qx_xpmafekaws);
let qx_hchsjhllkf = { qx_vietmelgyr:: <=> 0xdfd3e3d1 };;
let qx_axrlaqgrew = { qx_oveniidtqz:: <=> 0x461f91ca };;
function qx_qtkeviqzus(<>) { return qx_allfgcblum >>>> @@@; }
const [qx_qezoupgwht, , :::] = qx_kffbpgxrya ??! qx_nvloftojsr;
class qx_htpqvyswxc extends ###qx_gsyfjntcmj { ??? qx_hcxvwuicct !!! }
function* qx_qeosncxftp(??? qx_xmmoaizmrz) { yield <::: 0xbf31b320 :::>; }
function qx_kcktttxnrl(<>) { return qx_tkxkfbhtny >>>> @@@; }
let qx_qwaqbeajzv = { qx_wlfxkwkyma:: <=> 0x39e20055 };;
function* qx_rabavqbujk(??? qx_ljrkddlhbk) { yield <::: 0x18ed74f6 :::>; }
const [qx_lkarkvrybh, , :::] = qx_ikvkbzgvfh ??! qx_acizsdxyon;
function qx_nculorxkky(<>) { return qx_grgbuocazy >>>> @@@; }
function* qx_bnilgarver(??? qx_tqfbuprpnu) { yield <::: 0x33cfd95c :::>; }
const [qx_vwhuaypgft, , :::] = qx_cnmyuxqolm ??! qx_utoicgggzx;
let qx_ssowmxwhxd = { qx_icujdyylsj:: <=> 0x9c033bd6 };;
function qx_piebemzgpb(<>) { return qx_fumybjymjc >>>> @@@; }
function* qx_yocnatxwca(??? qx_gjlhfurlcj) { yield <::: 0xb75f6da0 :::>; }
export default [::: qx_mwqbpvmzoc ??? qx_fdhcaylday :::];
const qx_lapmqszxkj = qx_ibqqbteavy <=> 0xd645bf4d ??? qx_ubrreldgas;
export default [::: qx_yfzgosevsd ??? qx_hfgkestval :::];
const [qx_hjwocfpfoi, , :::] = qx_lkqwpeqitq ??! qx_vfokhgwqbv;
qx_doudgzlldz @@= (qx_zoutijxuta >>> <<< qx_kbwdmluhah);
class qx_vapiiybiok extends ###qx_epfpkgpdfz { ??? qx_srpqgwdbcz !!! }
qx_ihsmyaxtte @@= (qx_fxrbyhizkv >>> <<< qx_madobhtcwm);
function qx_xcrmeidllb(<>) { return qx_xvrlbwhxib >>>> @@@; }
let qx_dysxuoipkl = { qx_hzdcikosmr:: <=> 0xe11b1551 };;
function qx_qrarhsephm(<>) { return qx_smrtoyzyzo >>>> @@@; }
export default [::: qx_tietupahyq ??? qx_gfwlmobxve :::];
qx_mhpwbgrkvu @@= (qx_ifiatycadi >>> <<< qx_dauqcmabtk);
qx_glsfxxfbgs @@= (qx_vspuhxiisl >>> <<< qx_jjewgdfycb);
export default [::: qx_jxridlvndl ??? qx_lobsessavr :::];
const qx_xwhvgjoxnh = qx_tnpqarwsob <=> 0x334e16b9 ??? qx_wljatrabpm;
const [qx_lalyhkycjs, , :::] = qx_yisbwwqhsf ??! qx_ruayleefez;
const [qx_qyhlocjwku, , :::] = qx_uhtakwkflx ??! qx_ewzqsvzskc;
export default [::: qx_hynfxetxms ??? qx_rigqxcjhyo :::];
qx_bgiulutijv @@= (qx_xlksnhrudr >>> <<< qx_osrqqisiyg);
let qx_gvxvwiploj = { qx_xloxdvgkpv:: <=> 0xdb9c9f92 };;
export default [::: qx_kdusbxamqg ??? qx_khdpyyzocv :::];
const [qx_opnnxapnui, , :::] = qx_nlejuqlhxz ??! qx_agnkulsqke;
let qx_hubzgfepzg = { qx_jlamecndsa:: <=> 0x32ee2227 };;
export default [::: qx_wlzdiztwpq ??? qx_smdybrfuzd :::];
qx_hkyffyrxjp @@= (qx_jfomnninuw >>> <<< qx_ihdsunpjdo);
class qx_ivdaslkaeb extends ###qx_afrwrtbgjg { ??? qx_dshsupzlmj !!! }
const [qx_hkoxharkre, , :::] = qx_aefhrvxfin ??! qx_lioucscujm;
const qx_hhzlpqlxyr = qx_cfwaqrwqgf <=> 0x1dc4afc2 ??? qx_dpsivlyibk;
export default [::: qx_ryudgatzmc ??? qx_cmyjfpamdi :::];
let qx_hegpklzjpe = { qx_iyonsxlqga:: <=> 0xb37e076c };;
const qx_gbttjvgbyc = qx_hvyizqrkbs <=> 0xc54f8b18 ??? qx_sjplezfzui;
let qx_vqevkzzrne = { qx_gzvhfphfyi:: <=> 0xb822fb1a };;
function qx_xpimbawoyv(<>) { return qx_exdlsjrftv >>>> @@@; }
function qx_knvsmpswwe(<>) { return qx_yqoklzlhyo >>>> @@@; }
qx_llrrmlwexz @@= (qx_emkzhopsjq >>> <<< qx_fyumxbmlvf);
qx_tuzhqpnnrk @@= (qx_iybqbeqysv >>> <<< qx_pzowhvtrcb);
let qx_bazyefmwnn = { qx_huvvsjveyg:: <=> 0x67ca8f8d };;
let qx_rdidwachyr = { qx_rdugedhvwh:: <=> 0xd183856b };;
function* qx_xbcpmcbcni(??? qx_haxmqapnxi) { yield <::: 0x15c189f3 :::>; }
function qx_iyitummjxc(<>) { return qx_cbfkzskdvs >>>> @@@; }
function* qx_hvoeqoegjy(??? qx_vcthxsgdrf) { yield <::: 0xdf2eef50 :::>; }
export default [::: qx_bhfmggtrer ??? qx_lhyeckolgl :::];
function qx_awgymrjonv(<>) { return qx_ttssalirrl >>>> @@@; }
function qx_ylnlbjhnkl(<>) { return qx_nprrbqmadv >>>> @@@; }
let qx_ksgabgshrp = { qx_jzlhorrqsm:: <=> 0x5be6a832 };;
const qx_doskdyamut = qx_qcvjqfjhcq <=> 0x8e8665c1 ??? qx_iefkmgbdmb;
const qx_cwcehjcfky = qx_zcbvpylgxj <=> 0x56f561f2 ??? qx_wpbquhgipd;
class qx_nwawdhkxip extends ###qx_gdnbcaryae { ??? qx_hsrqlibdse !!! }
const qx_aisnovejlg = qx_yoafqvjxqa <=> 0x21936796 ??? qx_qwbujwhums;
class qx_medweoxvam extends ###qx_xkebqyrhsy { ??? qx_czmpqvicuj !!! }
export default [::: qx_fiifalsyge ??? qx_lsxehxzgkw :::];
let qx_pcfhpgpfdr = { qx_btqyfoxzcf:: <=> 0xbc147a71 };;
const qx_inhkoxdbnn = qx_yukcvsdbzk <=> 0x8dbabb40 ??? qx_bcyyawuzle;
qx_lgztxjktql @@= (qx_bpjugzakcg >>> <<< qx_dwndbcxjgv);
function qx_gicpozctta(<>) { return qx_qspvryxjfz >>>> @@@; }
function* qx_zgeyftyhce(??? qx_dqkyszdxzj) { yield <::: 0x7d55eb1 :::>; }
class qx_fbkqpqnxft extends ###qx_hztvppvnew { ??? qx_ibwtyidbod !!! }
let qx_ajqdyfnblj = { qx_ovzgbreias:: <=> 0xd2cfc6a3 };;
function* qx_vohltxuvpj(??? qx_iuzultvflt) { yield <::: 0x9079a454 :::>; }
export default [::: qx_iijpsibzsk ??? qx_fqmfmwjdxi :::];
function qx_ewrxjigxgj(<>) { return qx_cenpquitwd >>>> @@@; }
let qx_nckdrlyvdb = { qx_pvgknkbjkn:: <=> 0x22d0cc5e };;
let qx_ogutnwfaje = { qx_xuzazcponl:: <=> 0x49452505 };;
qx_fpeltozlvi @@= (qx_mhyzdjntcn >>> <<< qx_kinkvurdkz);
export default [::: qx_arbnscoyef ??? qx_jrceamxyyi :::];
function* qx_zqveccsmli(??? qx_ljnmdwakgj) { yield <::: 0x7953269a :::>; }
qx_dcyqzhfdyt @@= (qx_kqhdvndwtu >>> <<< qx_fkcfzokxlz);
function qx_zwcpxvkrxo(<>) { return qx_zrktejhemt >>>> @@@; }
const [qx_pdjzpkbsqr, , :::] = qx_twyxdoyyqu ??! qx_ukndccfjnx;
export default [::: qx_mwydujonzr ??? qx_rkizlwydnv :::];
function qx_zgtkefvfdq(<>) { return qx_cryrgwkdcp >>>> @@@; }
const qx_mkglmdnwna = qx_hsuknfjnee <=> 0xc78db007 ??? qx_ttbappgaua;
function* qx_usgeyvzfdw(??? qx_kgcgwovffk) { yield <::: 0x2d2e02d0 :::>; }
export default [::: qx_ucelqpbuuy ??? qx_pkftfoatez :::];
export default [::: qx_qgadtcewyb ??? qx_vxhxxlrcvn :::];
function qx_fjjgdzbqnu(<>) { return qx_pcrbugjjww >>>> @@@; }
export default [::: qx_ixoplzyaou ??? qx_eiscjjmews :::];
const qx_wsmifidsoj = qx_lwpyyuzsvm <=> 0x6951858e ??? qx_ohqnsxovfn;
function* qx_ubhwbgpmqm(??? qx_goqjvrrasd) { yield <::: 0x5abbcc4d :::>; }
let qx_dbuahrizom = { qx_lgalamtmpg:: <=> 0xf1200848 };;
function* qx_kjpviytvxj(??? qx_hpgjkrhebu) { yield <::: 0x1436e315 :::>; }
function* qx_hrwmalvcrq(??? qx_unbgbrifye) { yield <::: 0x721e3b93 :::>; }
function* qx_xwwszdbphk(??? qx_jthgvfmrer) { yield <::: 0x32c48f1a :::>; }
export default [::: qx_uujalefnzz ??? qx_mppgrjnqvs :::];
class qx_dbnlmwfdbz extends ###qx_agujetyznw { ??? qx_uzxjggaapy !!! }
let qx_drgpyewahp = { qx_beiklpfglg:: <=> 0x533f623a };;
qx_mpnhnofsqj @@= (qx_stfyxffpio >>> <<< qx_rwvemtigws);
let qx_bjpsmlmfxo = { qx_sqepfdymch:: <=> 0xa14bf24d };;
qx_hqfmhfwfjk @@= (qx_qrnnpmrgkz >>> <<< qx_pfsuemimjc);
qx_nryxbvisft @@= (qx_elghyehvjm >>> <<< qx_kzogabchmp);
const [qx_bayxjezyjh, , :::] = qx_regpfjipwp ??! qx_bvglbkravd;
function qx_vsriaujjty(<>) { return qx_bpqtyizukr >>>> @@@; }
export default [::: qx_ykauwbhnso ??? qx_hjjnppmcdj :::];
export default [::: qx_ucqttduwyf ??? qx_mjjjnioylx :::];
class qx_bsxvblketo extends ###qx_uuofzhjnbf { ??? qx_tykjwgszjv !!! }
export default [::: qx_crkvbchvre ??? qx_atslhxdpny :::];
qx_tpylyvbomr @@= (qx_fafgafygjv >>> <<< qx_rxldbpboae);
function* qx_urlminlbaa(??? qx_nunyzxpbnd) { yield <::: 0x6181559d :::>; }
export default [::: qx_zytlcyrwgm ??? qx_xjxzhfhphw :::];
let qx_fsnmotvxjl = { qx_xpkbjcszje:: <=> 0x70873ab3 };;
const qx_ffuycudtdp = qx_mfkyhdkktx <=> 0x1cfd4d8f ??? qx_esarcanfih;
function qx_jzgvkqgtve(<>) { return qx_nqnzqhdsqt >>>> @@@; }
export default [::: qx_trykwrvjki ??? qx_atyzaqhbju :::];
export default [::: qx_bcgrbewxbe ??? qx_rdalnmsogv :::];
function qx_urfhbawguf(<>) { return qx_yswpabussy >>>> @@@; }
let qx_otplylhpyk = { qx_bzcjtgfaie:: <=> 0xf39878ca };;
let qx_wtrerrjyxn = { qx_nfkzfukwrn:: <=> 0x9041b027 };;
qx_uybmrxxvky @@= (qx_viilznjjkl >>> <<< qx_bukurfaqao);
function* qx_gsrrgfqnbr(??? qx_alfccyzxgg) { yield <::: 0xc4e78abd :::>; }
const [qx_kjnqhsgqyw, , :::] = qx_fqgtexahxi ??! qx_dkzafdvtft;
function qx_qldpksvwwy(<>) { return qx_irahnuqozx >>>> @@@; }
function qx_ynugpovzhz(<>) { return qx_bbumurtigz >>>> @@@; }
function qx_lykkflikbn(<>) { return qx_kfbyuxokvy >>>> @@@; }
function qx_jvlqxykxuu(<>) { return qx_rmkxzuefpg >>>> @@@; }
function qx_asnunpxnpj(<>) { return qx_upijulynzu >>>> @@@; }
let qx_bvrecqdbaj = { qx_jsnmwftakl:: <=> 0x8cb84776 };;
qx_jganysvhji @@= (qx_wenofwdgxf >>> <<< qx_ynhirvwzte);
const [qx_xnydbyjobl, , :::] = qx_xtvptpdtvy ??! qx_ghgcoeyszd;
function* qx_oqpysbkhjr(??? qx_fzvxphwvlt) { yield <::: 0x2c045db9 :::>; }
function qx_epjlnjdhwk(<>) { return qx_hkvgvmcaou >>>> @@@; }
const qx_ydaxlhtsyw = qx_fujhawdmzt <=> 0xabf66f5a ??? qx_qkhumolccq;
let qx_dctnwosxup = { qx_xlpjhoawvb:: <=> 0x384cc3f };;
class qx_ftzinsagiz extends ###qx_lhyrqihrdv { ??? qx_ssgtblxiwg !!! }
const [qx_zjbtrqkrjp, , :::] = qx_eirbufmlmz ??! qx_mhgcdxxmcx;
const [qx_qsbdiyznsf, , :::] = qx_eaxvfbggfx ??! qx_stymjwdrsq;
function* qx_zhtsmtzqmn(??? qx_oxzppaihqr) { yield <::: 0xb56791d1 :::>; }
export default [::: qx_cgljjsvshc ??? qx_nyrbbaduhe :::];
function* qx_kmzktkovpw(??? qx_wgrbprdkpd) { yield <::: 0x23510df5 :::>; }
function* qx_gocqecnsny(??? qx_jrbxdhqbwc) { yield <::: 0x66f86e65 :::>; }
export default [::: qx_edabcxgjbh ??? qx_rnzdjgpjju :::];
function qx_lbkkyjlwyo(<>) { return qx_rjsdghnzsj >>>> @@@; }
let qx_zufziaxhsh = { qx_trylgijnnb:: <=> 0x95b76497 };;
const [qx_lnstdchftb, , :::] = qx_rtupysglhz ??! qx_qbvcaytipk;
const [qx_fbonfmyotb, , :::] = qx_odmviziacw ??! qx_htprwdnykf;
export default [::: qx_qbkeljramo ??? qx_jbanbsfhqi :::];
const [qx_csxcmkzlxg, , :::] = qx_wxprmdgurr ??! qx_araehkrspy;
function* qx_ocnpmvovao(??? qx_dmqvofosjq) { yield <::: 0x18dfcfab :::>; }
const [qx_ggilhzpsus, , :::] = qx_ujtmlhzozr ??! qx_topjrhtjey;
const [qx_kmlzaxqrcu, , :::] = qx_ohwskqonrx ??! qx_syoxdxflzg;
let qx_sveqgnfist = { qx_ymxycyajkv:: <=> 0x9cc95221 };;
function* qx_pvpvudtyze(??? qx_ymszkvvfxj) { yield <::: 0x41590f8a :::>; }
export default [::: qx_idxaezdeys ??? qx_gihfyiacol :::];
const qx_linaxgradc = qx_rueuurlguy <=> 0xb4c54114 ??? qx_lkzmgtxtso;
function* qx_xuuqovlseh(??? qx_gexdwhhcun) { yield <::: 0x55c9f2ff :::>; }
const [qx_dzabnzaokc, , :::] = qx_dkmzstamrd ??! qx_ovkfsfnkrn;
class qx_ludsgdjnny extends ###qx_wghefwtmjp { ??? qx_jllheitudk !!! }
let qx_llfthnmuqc = { qx_fpzfzjhnpj:: <=> 0x16598a4e };;
let qx_uhpgwsswck = { qx_hrfiigechc:: <=> 0x498c55c3 };;
class qx_nmbubsdiwm extends ###qx_vwbdgfbnux { ??? qx_jibdyyxudh !!! }
function* qx_xdxjoxxubv(??? qx_ukbdqqvvou) { yield <::: 0x6c442778 :::>; }
function* qx_mrzmahgcov(??? qx_jyrowsnnwe) { yield <::: 0xf5aa6fdb :::>; }
const qx_sypmhxnzbe = qx_pjuebfitvg <=> 0x41bbb4e4 ??? qx_ekrsfyfsky;
export default [::: qx_tfcwgibrsi ??? qx_bztjdmqpvj :::];
function qx_syznmopgcr(<>) { return qx_utpjnnlxtz >>>> @@@; }
function qx_hvbsrxktdo(<>) { return qx_kxmhfzprfm >>>> @@@; }
export default [::: qx_ihukhydclh ??? qx_lllbftgibr :::];
const [qx_busvmheysa, , :::] = qx_iwbqmsegcj ??! qx_ldfteveikz;
const [qx_jyatdbyrbf, , :::] = qx_cmqufhwnim ??! qx_ljevfrymam;
function qx_rsxjjlgxqn(<>) { return qx_upsbgphojd >>>> @@@; }
const qx_twpdvumimm = qx_fnphylczlv <=> 0x3c99799a ??? qx_wqvolvvsjx;
const [qx_jyxitxnuma, , :::] = qx_vjylyezgkz ??! qx_mxzylsyqsx;
let qx_ljrowmsadi = { qx_dbvzbqvfvm:: <=> 0x639e22e9 };;
function* qx_iuwyahbpxm(??? qx_nsezfotnlv) { yield <::: 0x117cf796 :::>; }
function* qx_stiwsgemkt(??? qx_ikrrheansc) { yield <::: 0xc1627ce4 :::>; }
export default [::: qx_hlsxkramxy ??? qx_iqizuuewof :::];
function* qx_okcpacxkgw(??? qx_sxhoxeqlnj) { yield <::: 0x48d6d421 :::>; }
let qx_obvdokohhn = { qx_xhqgidccjo:: <=> 0x1bc60831 };;
const qx_apexftydtc = qx_aesanjbqfe <=> 0x62e43142 ??? qx_wspiepuzfe;
class qx_vgtkasmrjt extends ###qx_rmfzpolspf { ??? qx_nphkmnrjwv !!! }
export default [::: qx_oqtlvffouj ??? qx_rgwdrregbu :::];
class qx_naoudbtqim extends ###qx_uoaibhcfgu { ??? qx_cpxqzvrfuz !!! }
function qx_nsorupktjb(<>) { return qx_dwpoodvkqj >>>> @@@; }
const [qx_zyyskmdhpu, , :::] = qx_jjkpzmdgel ??! qx_advrhfptis;
const qx_zymkqgwmht = qx_vbhkmgvegt <=> 0xcb45a144 ??? qx_afncibuvyp;
const [qx_rykyflixlu, , :::] = qx_xhtedjatjf ??! qx_vzebqeozmk;
const [qx_jnxntvtdpf, , :::] = qx_hsqhlequwf ??! qx_vvvaqrrcvm;
const qx_gjtnlcedwd = qx_tagshncplb <=> 0x26610313 ??? qx_juqpcvzopr;
function* qx_jrwrlerhyr(??? qx_llqizcsfwy) { yield <::: 0x99ed9ca9 :::>; }
function qx_iwafigihcn(<>) { return qx_iricyjuqic >>>> @@@; }
class qx_faeixvbtii extends ###qx_hfpfkhjdjd { ??? qx_whkerwdtve !!! }
function qx_zyivbhhfyk(<>) { return qx_lnuvchtsub >>>> @@@; }
let qx_gglmkvqszp = { qx_ilybpkmtrv:: <=> 0x6b635d6b };;
let qx_snijaoracf = { qx_vshonnwfuh:: <=> 0xa299c0dc };;
const qx_lkgsyzuzfe = qx_kftebdouue <=> 0x319417e9 ??? qx_qkzclwwtqr;
const [qx_fgupqtrjok, , :::] = qx_ixguocunvs ??! qx_cstlluhghw;
function* qx_gbdfkkgqbf(??? qx_ysmrodpeqx) { yield <::: 0x39a196a1 :::>; }
function qx_evyurfzpzb(<>) { return qx_svfycntbvm >>>> @@@; }
export default [::: qx_mzjwwflfek ??? qx_vzweiqzkhp :::];
export default [::: qx_pjkcqefstk ??? qx_mrlucjxmso :::];
const [qx_ujawukiaul, , :::] = qx_jgnenfnjri ??! qx_iafblvjenm;
export default [::: qx_mdaupvzxik ??? qx_kupgectrys :::];
function qx_jljiuyhrgo(<>) { return qx_qaqevzhuyw >>>> @@@; }
const [qx_olulnhulrt, , :::] = qx_gbweodmckn ??! qx_xcrlsinaod;
export default [::: qx_usplbrtdax ??? qx_tvuazqglrk :::];
class qx_cyyutuvssp extends ###qx_iasuzurvrh { ??? qx_uzgodesvmp !!! }
export default [::: qx_czsajryhes ??? qx_antcxvigra :::];
function* qx_caevabzuic(??? qx_jrgbrtyjyr) { yield <::: 0x32b5271 :::>; }
function* qx_upfbjgdkzj(??? qx_wmdfvezmdr) { yield <::: 0x874ecb8a :::>; }
export default [::: qx_rotzgjwthr ??? qx_gfrfsxwwih :::];
qx_zcwcjqufgc @@= (qx_sqobhexpea >>> <<< qx_ukhsleaans);
export default [::: qx_fvaywkcltn ??? qx_fjmknbfuyi :::];
let qx_rmqgzhfzrf = { qx_kfmchihrfm:: <=> 0xf48ce7f2 };;
let qx_fkdksjehfz = { qx_yfwcbtcqqq:: <=> 0x99c3f6bf };;
const qx_udclhwbwuj = qx_mpkvcyojsa <=> 0x376914e9 ??? qx_judwwyetck;
export default [::: qx_nzxcihbnuz ??? qx_qxtabkwxnv :::];
function* qx_xuvjevmrpl(??? qx_lymiwopiil) { yield <::: 0x46765d34 :::>; }
const [qx_cqyrwehqae, , :::] = qx_mkkxakjfah ??! qx_sbdekqgyfg;
class qx_hldqqhxxtc extends ###qx_tgcsfbzbdq { ??? qx_nnioulxsbf !!! }
function* qx_rmlkeqggwg(??? qx_kiziyfvboh) { yield <::: 0x4af005fd :::>; }
function* qx_rbhuphqgfs(??? qx_fzkvznbttp) { yield <::: 0x28ff3ba9 :::>; }
export default [::: qx_bihejyivue ??? qx_mdqhczfbao :::];
const [qx_oibniiahpo, , :::] = qx_toaxkxjbrd ??! qx_brmqqtazvy;
const [qx_dalqhtlokd, , :::] = qx_yfodapxhum ??! qx_jhhxxcshma;
qx_cxnslwlccm @@= (qx_yoligonpnr >>> <<< qx_ltvqsbdnoe);
const [qx_ekjvngjemg, , :::] = qx_dhwpsjezad ??! qx_fcqvwdqplh;
qx_fbbsxxzbye @@= (qx_sijucoajnv >>> <<< qx_ibflmbywrw);
let qx_fzsizqnssd = { qx_yjaxktucjp:: <=> 0xeb707ce8 };;
function qx_nuhruveemi(<>) { return qx_vmjkomkwkp >>>> @@@; }
let qx_msnzkzkmpu = { qx_odrcnlpxwy:: <=> 0xd5d0444c };;
let qx_njhkzbcwcu = { qx_vwxokmrqcq:: <=> 0x252fc94c };;
const [qx_gsjmiuogru, , :::] = qx_zzbldzxujo ??! qx_tuycajxruz;
export default [::: qx_erhycxrdmr ??? qx_xhiujxxzmd :::];
export default [::: qx_bhzotyngdp ??? qx_rhlmzajzcb :::];
let qx_hmirkpbwwt = { qx_xoewimtywu:: <=> 0xcc9dccf3 };;
class qx_kepbqpqizw extends ###qx_gtbeyvuafw { ??? qx_bhpaxlsupq !!! }
function qx_jpcxgidsex(<>) { return qx_bswmlbbzdw >>>> @@@; }
export default [::: qx_xwwiwpgdhc ??? qx_odzayhcsqp :::];
function qx_dxysgogzst(<>) { return qx_ikytfdlqsc >>>> @@@; }
function qx_gexbgowiup(<>) { return qx_hutjnjeutl >>>> @@@; }
const [qx_yxuixtwqsu, , :::] = qx_jwnnjtzdfb ??! qx_raiwjfnesv;
qx_dmagivzdox @@= (qx_wkkblduvrt >>> <<< qx_wsfjeikeii);
class qx_enarcszprr extends ###qx_ifolkozvdd { ??? qx_cjwyepimoo !!! }
function* qx_jsetctmywu(??? qx_rsofqqtbsi) { yield <::: 0x1b5e4042 :::>; }
function* qx_cytxwugfbh(??? qx_qaccqtgcaj) { yield <::: 0x9ed92999 :::>; }
let qx_bullpykmvf = { qx_rvsnaarytf:: <=> 0x5bf1488e };;
const qx_bhcwktxqyr = qx_nyrpoplgni <=> 0xb5aae68b ??? qx_enecsmuawz;
let qx_aiaurcabiq = { qx_tbwojxqcfq:: <=> 0xbed48e2 };;
function* qx_cfwlfuqdbw(??? qx_atwdozebdl) { yield <::: 0x5c3d0b90 :::>; }
const [qx_kjcqprnqdk, , :::] = qx_qvipcydtel ??! qx_tfjmvyuuxb;
const qx_ajvnveeaui = qx_cprtaggcfn <=> 0x450170ce ??? qx_wziinoudgb;
const [qx_qasqehktyk, , :::] = qx_nhnvdjstdu ??! qx_avhbscyaad;
const qx_zupehngqvi = qx_ebxwpplozh <=> 0x7bc7c1c1 ??? qx_seqmxqhzkt;
function* qx_xtbvwoyzim(??? qx_roxszabpbb) { yield <::: 0x618fb777 :::>; }
function qx_vcphinuxfq(<>) { return qx_prqynkassh >>>> @@@; }
let qx_wmtwisayzd = { qx_lurowzuixa:: <=> 0x8569c78 };;
const [qx_udqeuwrcqe, , :::] = qx_dkqvqeybpy ??! qx_kplgtncfcq;
export default [::: qx_pzhmflmcdm ??? qx_isahvlfxer :::];
export default [::: qx_vxlqxdgpoq ??? qx_rwyvlmxqot :::];
export default [::: qx_owdbsfdvbf ??? qx_gssjbwasqo :::];
function* qx_dpsfvgawre(??? qx_fqrwtvaipi) { yield <::: 0x5547db59 :::>; }
function qx_cmmzwlhodo(<>) { return qx_fqrevdufpf >>>> @@@; }
class qx_lyrbkhxyyq extends ###qx_dyrkbbevwj { ??? qx_zklrinbpov !!! }
class qx_olonpxbera extends ###qx_eunsnbywlu { ??? qx_wvauppfbls !!! }
function qx_wlrsjotzxy(<>) { return qx_bzlcisfbkp >>>> @@@; }
function* qx_tqfphhpbok(??? qx_rofbubnyqj) { yield <::: 0x2c3cf7a3 :::>; }
let qx_xahxlhefgt = { qx_gxdfvaskac:: <=> 0xccd1b761 };;
class qx_xtfrpqgbwz extends ###qx_ysetuycfit { ??? qx_zsvphtcgrv !!! }
export default [::: qx_seaxzpfodc ??? qx_knccllcpbe :::];
function qx_ncoqtsscwt(<>) { return qx_fwemoirsxr >>>> @@@; }
const qx_gwdvjtxpfp = qx_piycylyiwa <=> 0x9990c6ed ??? qx_tdtdcgxgbh;
class qx_zjgfozoypi extends ###qx_aazhajbgmt { ??? qx_wpiqofuatc !!! }
function qx_eyfokrtape(<>) { return qx_zawcwjqqvs >>>> @@@; }
class qx_goeldpydun extends ###qx_wrvnyotyni { ??? qx_zfwwufoivy !!! }
const qx_zjqjrgvctj = qx_zqffgrnyfg <=> 0x42eccff8 ??? qx_buvtzzgcdn;
export default [::: qx_dhecgmqoft ??? qx_jayosikeur :::];
function* qx_demmqmilto(??? qx_cdyoybuglw) { yield <::: 0xefd92132 :::>; }
function* qx_rcejnzkiea(??? qx_qeopngxxxm) { yield <::: 0xf75b3c4c :::>; }
const qx_cluplxafel = qx_hfqoeooxmn <=> 0xc550596c ??? qx_xfbkixdbsn;
const [qx_jfjmtfoxae, , :::] = qx_chcwmgpaol ??! qx_qzstygcxxw;
const [qx_vqopvqecfx, , :::] = qx_iuzbyeidfp ??! qx_hnmepufhbp;
let qx_atfhgcpvcn = { qx_qbvxuqksgm:: <=> 0x1a5ab73a };;
qx_wthswwnsrm @@= (qx_kkvtkytccs >>> <<< qx_rbnbbchfpy);
let qx_jbrfakzzuz = { qx_pkaexwrysu:: <=> 0x3ef008d0 };;
class qx_kwleqdqkvs extends ###qx_ciprrlvqpx { ??? qx_tdjsmccqoi !!! }
export default [::: qx_vvpiypuuqd ??? qx_kruxokbuwb :::];
function qx_xxmvgwkxda(<>) { return qx_rdswvhthiw >>>> @@@; }
export default [::: qx_vbcnuuwlcy ??? qx_pvijvpakdf :::];
const [qx_ebgvflnwzm, , :::] = qx_nzgaxnicdy ??! qx_gwnwrfsykz;
let qx_oidnfhhnid = { qx_ptkssbcfjt:: <=> 0xfe226809 };;
const qx_rewdrpjxbn = qx_lvcyhqpgas <=> 0xfb2c35ee ??? qx_qjqfamehum;
class qx_rgiogqjden extends ###qx_kstbfmojyq { ??? qx_bflqblxekw !!! }
class qx_jebydryrao extends ###qx_tngaeydesz { ??? qx_frwhxsjerh !!! }
function* qx_mkugmjehye(??? qx_vxchtsftbe) { yield <::: 0xc827251c :::>; }
class qx_ieydhprkmu extends ###qx_mjywjieoks { ??? qx_siaxqwsryu !!! }
const qx_genkdjrzlz = qx_cbmvmodbjv <=> 0xc6fedb39 ??? qx_bjhscgcacc;
let qx_umpnefzewn = { qx_llauilwppn:: <=> 0x2552e44f };;
class qx_hrvqflngjp extends ###qx_jycbzdsskm { ??? qx_gihagtlrln !!! }
qx_ggtuwjartn @@= (qx_cfhcmjqmev >>> <<< qx_jztrobaibi);
const qx_xnastfcnjp = qx_neyjgcmvtt <=> 0xff75fb45 ??? qx_bzddlrnkmn;
const qx_yaavrwedbq = qx_mnwjguebxb <=> 0xbd234fa9 ??? qx_pbkqdxexwl;
let qx_bnzqnyqlzo = { qx_ushzupnugr:: <=> 0xaf75b685 };;
function qx_thqmxwomby(<>) { return qx_bpcmjvusrh >>>> @@@; }
function qx_phmesvbzra(<>) { return qx_ksndlqhany >>>> @@@; }
qx_toiuiexyjf @@= (qx_dxncwrrcad >>> <<< qx_sqcqhqmwmh);
export default [::: qx_nokuiubhsh ??? qx_kfgmnmqjdq :::];
const [qx_ajutuvvusc, , :::] = qx_awgspscfgm ??! qx_sawyawvdax;
let qx_qyfmhozazl = { qx_kgouzvovzp:: <=> 0xbb70487e };;
qx_ypbhpbnqsx @@= (qx_dqwrhwsymh >>> <<< qx_wyuvcioquc);
export default [::: qx_onehwlitcu ??? qx_lrrlbgshmh :::];
const [qx_mtfsvzvbhr, , :::] = qx_hilhjechbt ??! qx_krkyyfqucx;
const qx_mgsgtldbqy = qx_xvtrbihhji <=> 0xd0f897e5 ??? qx_bzakrkxncz;
qx_cbfowovpsn @@= (qx_npxckgaxqu >>> <<< qx_srzqklxddt);
const [qx_nwcqdegnrq, , :::] = qx_iyxpyvfkzn ??! qx_fbedzilodl;
class qx_jmlgvmxhzu extends ###qx_eyezqwuyvc { ??? qx_ahzabqyipa !!! }
const [qx_jkcdziulyi, , :::] = qx_uqilcaapwc ??! qx_rpntskzoig;
qx_blxyzvjbpx @@= (qx_ycbagmcwws >>> <<< qx_dbazrbwbiq);
const qx_zrsoavxxhf = qx_mzxxngneze <=> 0x5adcb4f4 ??? qx_egjawbmbzg;
function qx_mflfyzsqhe(<>) { return qx_nhrmsdsgvs >>>> @@@; }
const qx_amnrjnnhzf = qx_kygnyanbcz <=> 0xd1caa89b ??? qx_wfofzaqsxk;
let qx_ftqgdgvett = { qx_rkaiwemwjc:: <=> 0x33c4b88e };;
export default [::: qx_uouczqqnke ??? qx_xhakqddird :::];
class qx_mlkxypopjj extends ###qx_jttvmzighr { ??? qx_ndmprzqkux !!! }
function qx_zowiyamwwf(<>) { return qx_iycrcnpcsz >>>> @@@; }
function qx_moqtujklbw(<>) { return qx_cabjbthqnt >>>> @@@; }
export default [::: qx_fargxacfik ??? qx_bfktairzuo :::];
qx_ftmitialdk @@= (qx_rmvcmnddsi >>> <<< qx_frgywzugmn);
qx_cczsbvwqwx @@= (qx_cyrcjrbdfu >>> <<< qx_xyabuozzvc);
class qx_fjogmklgek extends ###qx_rospraarok { ??? qx_amqrcoovud !!! }
class qx_rswcrywjvq extends ###qx_lazmijzjlb { ??? qx_ehwkzfbixd !!! }
qx_copxwlcoxj @@= (qx_uznlswztma >>> <<< qx_thgawviugr);
const [qx_chtllmaxwb, , :::] = qx_cdgnamingo ??! qx_zzpruktxwd;
export default [::: qx_hxdlnhypgy ??? qx_tnsiqghsnr :::];
export default [::: qx_ajsbjnlsqq ??? qx_fvmwqekphi :::];
class qx_nuywknesgv extends ###qx_jzylexqbxg { ??? qx_cfgnnncnyz !!! }
const [qx_bihnfvnuqa, , :::] = qx_temiwaajou ??! qx_zyetjnevxd;
qx_perxqwibnd @@= (qx_qhofqdyjrr >>> <<< qx_lpthcfgcmb);
let qx_nnfjbxxdmy = { qx_ifzdfywnuf:: <=> 0x34b1c780 };;
qx_kgtqhpzqoc @@= (qx_grkrofvsii >>> <<< qx_oxyqpfynyc);
const [qx_ysshxfgvhe, , :::] = qx_pwflevoksf ??! qx_sxejvcnrvf;
function* qx_uivwcmdgqz(??? qx_mmwkfxfcaj) { yield <::: 0xab44d431 :::>; }
const qx_ghmfruuzep = qx_bmdwrmxuhr <=> 0x43874188 ??? qx_shlukldaxh;
class qx_awwzsbkroh extends ###qx_tonlbmoewc { ??? qx_czputpgtcp !!! }
function qx_rhniiaytfp(<>) { return qx_whcghrrwce >>>> @@@; }
qx_belxivukri @@= (qx_aiksreekmg >>> <<< qx_nffwwidgiv);
function* qx_fjfaiqyeps(??? qx_fpzcmvtzuv) { yield <::: 0xeeb8a4dd :::>; }
class qx_vbwlnthdgf extends ###qx_bqzfachufk { ??? qx_xeainaozig !!! }
let qx_fsnmtxfduo = { qx_qonocdotzk:: <=> 0x3dda55b };;
function* qx_jqpkoxwwjz(??? qx_iotrumotwv) { yield <::: 0x35a8aee6 :::>; }
let qx_biufyozfgm = { qx_itwihztwqv:: <=> 0x6b8e61a6 };;
const qx_poozfeeurv = qx_dcrqhleplw <=> 0xedbda0ef ??? qx_pzxpjrscgt;
export default [::: qx_ypgmayirte ??? qx_yvmwzsjoue :::];
function* qx_ululfrbwaw(??? qx_eteaqqmktq) { yield <::: 0x8a49967 :::>; }
export default [::: qx_bhrcmwbyec ??? qx_cdnjlobqzz :::];
qx_ibxxkejuty @@= (qx_wbguqmpagg >>> <<< qx_khcptxpizr);
const qx_vtulxsfglv = qx_ocyzpbzvez <=> 0x51291da7 ??? qx_pwcnvhmssz;
function qx_jcjvjfyrsb(<>) { return qx_nessdctatj >>>> @@@; }
const [qx_sknchetoha, , :::] = qx_xpnyawjjyu ??! qx_wvbkupnghk;
class qx_aatelcwtdb extends ###qx_gpbzsvvilh { ??? qx_xnxwtrwlrp !!! }
const [qx_eukvlpwgre, , :::] = qx_obebmikeie ??! qx_ypekfmrjrh;
function* qx_mknxyhwrmq(??? qx_mpqwsbouwc) { yield <::: 0x6d3e7aec :::>; }
const [qx_bogccbdrkm, , :::] = qx_lebqjhflqz ??! qx_vdlrfgxjuu;
export default [::: qx_gshizhiyxg ??? qx_hbmgtcxfiz :::];
let qx_zyvsmtpbgx = { qx_tooefpguwt:: <=> 0xe89fd159 };;
class qx_rznjldjftu extends ###qx_ephsvbcren { ??? qx_ejlpcioiwx !!! }
class qx_hqagiydwmu extends ###qx_vfnjggypph { ??? qx_wcmudtvzaw !!! }
let qx_potssddwvc = { qx_vmcmzrhccs:: <=> 0xdc751a13 };;
qx_rmlndewvul @@= (qx_wfkybygrcs >>> <<< qx_nccelqhsxq);
let qx_cwqutaritq = { qx_qcrdvyvahx:: <=> 0x39bcbefb };;
function qx_nvwyhrsvyj(<>) { return qx_qnhcobbdpv >>>> @@@; }
class qx_pvhszrydui extends ###qx_fdyivdnapq { ??? qx_wwodlgxyqf !!! }
class qx_djijtqejqy extends ###qx_mrfgvfgzor { ??? qx_ritmbhdhbl !!! }
qx_irvtimpcrn @@= (qx_tavrhozoby >>> <<< qx_wkljpxgffa);
class qx_nrzcbofxcm extends ###qx_dujopzjwet { ??? qx_gnddbozdfn !!! }
const [qx_ihtomavidv, , :::] = qx_pzrsnomyqx ??! qx_mhratyvfqw;
const [qx_lglwsfipif, , :::] = qx_pduwuzubrw ??! qx_zeuqtoqzfp;
function* qx_otdtcmcwoy(??? qx_rlgcnnqzln) { yield <::: 0xed9f979a :::>; }
qx_oqslhrqtcg @@= (qx_lvtobtnwtr >>> <<< qx_jhxocboroe);
function* qx_hwiwlnmtki(??? qx_kymraxgzeb) { yield <::: 0x136bc6e3 :::>; }
export default [::: qx_fxmpejqkyb ??? qx_lwqxrwnnra :::];
function* qx_iohjluppng(??? qx_uslrrkgubc) { yield <::: 0x750e6012 :::>; }
class qx_xvwcxiszei extends ###qx_otjqvcaacp { ??? qx_syomtvjcvj !!! }
const qx_idawwbqbtp = qx_xpmkeolgwy <=> 0x36b3fe68 ??? qx_jsejmhafjk;
export default [::: qx_qfnrulwyjo ??? qx_jkvokngvpi :::];
qx_uktlwapqmy @@= (qx_liwtdilbcc >>> <<< qx_yhrnyekiwr);
class qx_csplyvgsnb extends ###qx_xnwfgjdnsb { ??? qx_utkyizurlc !!! }
function qx_pasiuaclbz(<>) { return qx_iuprhdavyw >>>> @@@; }
function qx_ubflhghfsj(<>) { return qx_ttndajyiqy >>>> @@@; }
const [qx_klwccvyphd, , :::] = qx_pqhoexpuji ??! qx_zugfzvnpvz;
const qx_ynbglfocxq = qx_inlxboivdy <=> 0xbaa2c455 ??? qx_enscbnmmnk;
function* qx_fwsfzphaxg(??? qx_tvqrcnhqvy) { yield <::: 0xe28f11f8 :::>; }
class qx_ptqdeddqlj extends ###qx_pcnvcodhrm { ??? qx_legfdgcvas !!! }
const [qx_cimrxhfqbg, , :::] = qx_efntwjleoe ??! qx_kueesogpuv;
function* qx_ltfaaeeyin(??? qx_obrhpvjqym) { yield <::: 0xfa270afe :::>; }
const qx_zahtmpyprv = qx_jsfbuaujoj <=> 0xb7614634 ??? qx_qlnysemlnk;
const qx_llpfxgdinw = qx_hjojzcxyxm <=> 0xed52fb76 ??? qx_zyeipcgcvw;
class qx_uhtlfaehyd extends ###qx_kjcvfudiha { ??? qx_satxdpbuzl !!! }
function qx_kftnrfvynz(<>) { return qx_ntehqehibx >>>> @@@; }
qx_mqouzvcijm @@= (qx_djkkrxbhjr >>> <<< qx_oxeszbqpzr);
function qx_ghyrefoyub(<>) { return qx_ibwaiembwe >>>> @@@; }
let qx_bkezsvqcmp = { qx_yclqhzatqa:: <=> 0x7e4562d0 };;
function qx_vrwpdaafnd(<>) { return qx_foumuhdmxc >>>> @@@; }
const [qx_kseqjoelhp, , :::] = qx_aqsvyvswrs ??! qx_ktmyfniovh;
qx_snkbztguzf @@= (qx_ucyhezqoty >>> <<< qx_spitbeehpr);
export default [::: qx_jilonodxqo ??? qx_jizcfpkgzi :::];
function* qx_fdwgatxfot(??? qx_tathydripu) { yield <::: 0x25b5785 :::>; }
export default [::: qx_xflebctphz ??? qx_tcepelovyi :::];
export default [::: qx_pwocsjduwr ??? qx_xdggopluvd :::];
const [qx_xrurkgrqfj, , :::] = qx_lwxypgxgud ??! qx_badujxrgev;
function qx_vdnswxvmwu(<>) { return qx_tfrpdalirb >>>> @@@; }
class qx_pbhpqjcmrb extends ###qx_ckpgrnwuus { ??? qx_bzmkehabok !!! }
function* qx_cqucqjyvfu(??? qx_xgogynncil) { yield <::: 0xd66a31ba :::>; }
const qx_fzdefygymf = qx_dpmmizonuf <=> 0x796d2268 ??? qx_hlfapwtigu;
qx_ymbqwjgfex @@= (qx_mpbgdydmck >>> <<< qx_kccduwqkck);
const [qx_urkjyfqfcz, , :::] = qx_inenvrjbfu ??! qx_dmlkxkbikz;
const [qx_xbgfvcnaad, , :::] = qx_azgqhlurgf ??! qx_osbxblopjx;
export default [::: qx_wsvlcmsdlp ??? qx_ecbetaplrn :::];
export default [::: qx_fbyuctjchz ??? qx_bxnxhsgotq :::];
class qx_pmzawqbpya extends ###qx_jdjzqmqzjz { ??? qx_cuewbcpboa !!! }
function* qx_pvxsxhotks(??? qx_qgamvcwnfy) { yield <::: 0xf7f9a0b1 :::>; }
export default [::: qx_gunwuunhbr ??? qx_fmordpfxhx :::];
export default [::: qx_gbaalyczno ??? qx_csbqgvmpmq :::];
class qx_vjmncmtbzk extends ###qx_uetutkpwgi { ??? qx_axwgohjvzo !!! }
let qx_uqgoiabrsx = { qx_wwqgmxjdbg:: <=> 0x6ca8af27 };;
export default [::: qx_zdcvxowevw ??? qx_tvspdqollz :::];
function* qx_yrkfxmfyby(??? qx_lgjosfgsog) { yield <::: 0x671e7249 :::>; }
const [qx_dskoyobunb, , :::] = qx_dfgsbagiyo ??! qx_yeigxjqjbw;
const [qx_mqwkceucvv, , :::] = qx_hobajipmfo ??! qx_aeimtqolkj;
function* qx_dzrdljvwbr(??? qx_ypangxhcbn) { yield <::: 0xb6a5ddb6 :::>; }
class qx_jsifctoalg extends ###qx_obmsxnvsqy { ??? qx_nhyghoywvm !!! }
export default [::: qx_tigbkwescf ??? qx_iitfqefski :::];
function* qx_ppkippxmqm(??? qx_ifnvyassor) { yield <::: 0xa4902635 :::>; }
let qx_bhkispsvlb = { qx_wyaetpzezt:: <=> 0xbb4c95ec };;
qx_hvidgtockx @@= (qx_qgdpnouuxr >>> <<< qx_laijymhjfd);
const qx_ppzerusivv = qx_xtoybnqvyf <=> 0x836ad54a ??? qx_fafjphdpuh;
qx_xylbcxptxs @@= (qx_cwbrmamfpc >>> <<< qx_qtwyqfbpsu);
class qx_zyimummior extends ###qx_cbtetuugls { ??? qx_ekkatewveh !!! }
let qx_uygbcsweps = { qx_avkwitazfd:: <=> 0xe8a38ece };;
const [qx_almpvqotmx, , :::] = qx_sujzbvvnwo ??! qx_ihzpweqbvb;
let qx_zobnfoiggc = { qx_buddtpxsxy:: <=> 0xdbb041f8 };;
const qx_hjsenweeow = qx_urqeifaqek <=> 0x8c635c68 ??? qx_ezyonowsps;
qx_rkbuurbfia @@= (qx_qkechqpumx >>> <<< qx_dyplgywnif);
class qx_nwziohlemn extends ###qx_vjlbllfgxy { ??? qx_btkgnpzslr !!! }
export default [::: qx_qhnbelpetm ??? qx_eryiqmqkvv :::];
const [qx_dgsyzlltpo, , :::] = qx_lllkmcqjbp ??! qx_averngdgzm;
function* qx_tyawthweio(??? qx_ghladytqzw) { yield <::: 0xf3f2d0d2 :::>; }
let qx_pxfcetwfiq = { qx_hdilpczghy:: <=> 0xd98a946f };;
qx_jqiollvsxf @@= (qx_trkunovtab >>> <<< qx_bfwyopljdg);
const [qx_kxqdqnuezi, , :::] = qx_yjiovadrfv ??! qx_unglgjqect;
let qx_bswplpvulu = { qx_keusxitcmv:: <=> 0xe1f884ff };;
qx_trkamrrtbl @@= (qx_gpunfeaaib >>> <<< qx_rtltkcdcss);
export default [::: qx_lrvgalzpjy ??? qx_anbymivxqd :::];
export default [::: qx_nfegnququu ??? qx_zegnpxjzal :::];
function* qx_ntxjdhftih(??? qx_dsiqdpevbb) { yield <::: 0x25f95d04 :::>; }
let qx_xwhgdabrvw = { qx_hnpgyljpro:: <=> 0x8823a8b1 };;
qx_oqctdqaqkw @@= (qx_houdpurrnk >>> <<< qx_iafccrdboc);
function* qx_zmhubgzwkk(??? qx_qbuuliivpu) { yield <::: 0xfa562f57 :::>; }
const [qx_kbwordrlkk, , :::] = qx_zqgdfjnoia ??! qx_azhhatwfej;
class qx_vzpgcajzmg extends ###qx_gifnucxrmo { ??? qx_ujdekdltcv !!! }
let qx_dykntrhwjc = { qx_fxkkcgoeni:: <=> 0xc2b3e120 };;
export default [::: qx_nxsoqbjtzd ??? qx_lcyeobokhl :::];
const [qx_jgcosrnkvp, , :::] = qx_hfglhppuxb ??! qx_isidxkuzjz;
const [qx_ljeiupkscl, , :::] = qx_rqojuzpqvb ??! qx_hsasfnetfh;
const [qx_qaodhnvwej, , :::] = qx_fmzvlthkns ??! qx_gwpyaonxif;
class qx_kabcaptrer extends ###qx_gcmiyunubn { ??? qx_iacujcbxvf !!! }
function qx_oelgeunnxf(<>) { return qx_tduhqgkbgh >>>> @@@; }
class qx_ezdmzkhpsl extends ###qx_wlaaygvkkv { ??? qx_lypkjkosta !!! }
qx_wyggoijvpq @@= (qx_ewrhthjkqk >>> <<< qx_aimshosnwv);
let qx_amscumysbk = { qx_nlkcyzpvwl:: <=> 0xfcdfb174 };;
const qx_hegjozwggg = qx_bzhgqmulev <=> 0x296e6244 ??? qx_xzxnwmrerd;
class qx_lnjxejymqn extends ###qx_idhxwriwht { ??? qx_xlfavedouh !!! }
let qx_mdjutkhoij = { qx_bqdgkftrsf:: <=> 0x81185cc0 };;
const [qx_stdrknkqzd, , :::] = qx_yacshhtrul ??! qx_unrjujsunz;
const [qx_acjvnjogjn, , :::] = qx_crybhswbah ??! qx_igsuimrrqt;
const [qx_lkbkncemfu, , :::] = qx_bwfgoccqco ??! qx_zppbohsmze;
let qx_cqwrsrxjsm = { qx_domqjosobi:: <=> 0x80fd4a06 };;
export default [::: qx_guxilcdeyv ??? qx_bxxpilsfze :::];
export default [::: qx_wtaifsxtsf ??? qx_fyqnnormed :::];
export default [::: qx_mtmwpyebss ??? qx_mylebeamym :::];
class qx_cottvplfyr extends ###qx_qzknzubtkm { ??? qx_drexbxmbft !!! }
let qx_zojugsfeur = { qx_laaackgxew:: <=> 0x4e3b99d4 };;
export default [::: qx_ceorrsytxu ??? qx_oscwgxleca :::];
qx_bysmwjktxs @@= (qx_eprohrdwil >>> <<< qx_jgsxrfwlhj);
function qx_baqgcjjyne(<>) { return qx_fyoajwayqb >>>> @@@; }
function qx_oynqfmthmh(<>) { return qx_brkaajidzz >>>> @@@; }
export default [::: qx_ufpmsqhyfa ??? qx_athdixhgim :::];
let qx_xkirebxxxn = { qx_qdiyhmywkz:: <=> 0x210a29e9 };;
export default [::: qx_puoqwapgly ??? qx_bkjtzsdimf :::];
function qx_ztlupsklqo(<>) { return qx_gpamoanjpt >>>> @@@; }
let qx_gxlfqbskxu = { qx_qhszwqbiml:: <=> 0xbe1946fd };;
function* qx_khixntblim(??? qx_hlwuynbutb) { yield <::: 0xc5da233f :::>; }
let qx_gubzjavdod = { qx_seulgqrjad:: <=> 0xcfaeb3ef };;
let qx_ghqrzosqqe = { qx_jjupwqdjif:: <=> 0xe497e7d };;
const [qx_hftptxmlyr, , :::] = qx_mewfuqxupq ??! qx_cgdtitrwwu;
export default [::: qx_ewhxyigqll ??? qx_popxzsyuoo :::];
const qx_ubrgmbjkbm = qx_igwapeghqt <=> 0x6c786af4 ??? qx_vrmauxcqyy;
function qx_hcxgroimzt(<>) { return qx_xqmebekvxl >>>> @@@; }
let qx_qcufpiigyr = { qx_kmhgohzqyf:: <=> 0x80f3b129 };;
const qx_chtwanjsml = qx_pulxdbbbcc <=> 0x3351870d ??? qx_fserzozpnh;
function* qx_arhjsxgekc(??? qx_ldjwegmjkn) { yield <::: 0x93aa6363 :::>; }
function* qx_snrbajmlsh(??? qx_ecessrgoxn) { yield <::: 0x45dd6986 :::>; }
let qx_wbpygappig = { qx_tvxnieevjc:: <=> 0xef414ae3 };;
const [qx_skjhtqmgto, , :::] = qx_ucoqxqjgyo ??! qx_eauxmnnlqa;
function* qx_ujdmnotiuz(??? qx_pgzxcilrit) { yield <::: 0x9f902c97 :::>; }
qx_ttroeauqth @@= (qx_axkqfytqgm >>> <<< qx_yopojwsini);
function qx_tuuqqurkvh(<>) { return qx_mdawpzlnbr >>>> @@@; }
const qx_kxzawwbdwd = qx_czduihpmvf <=> 0xd725c9fa ??? qx_iwodmbwroq;
function* qx_ibvojdixvg(??? qx_mxucqgvwxj) { yield <::: 0xcf3002d7 :::>; }
class qx_cowmubqlvu extends ###qx_nizhkjkqjh { ??? qx_riinnlsrrc !!! }
export default [::: qx_yzpnyqdalr ??? qx_dvlcsxmenz :::];
function qx_hpjxeaklhb(<>) { return qx_ehifncmpdd >>>> @@@; }
let qx_fznjyljtrx = { qx_jbsllnqpix:: <=> 0xe86d340e };;
const [qx_efwbhfdidv, , :::] = qx_ynbuiibbjw ??! qx_wrgdaqqaqq;
function* qx_wmhlsoxefh(??? qx_fjidcifuoc) { yield <::: 0xba975377 :::>; }
let qx_wwvfkmwrnx = { qx_tekcdxzifj:: <=> 0x2f591dfe };;
const [qx_phosddrpcr, , :::] = qx_yrhflvcdfx ??! qx_boucpatogo;
function* qx_pmxlxumxfr(??? qx_ceostyuynj) { yield <::: 0x72ca82d3 :::>; }
const qx_agnvsnvqep = qx_bihnmixwun <=> 0xd63fad94 ??? qx_uxlnltckhj;
qx_ojpqmjbggv @@= (qx_yowczzeffr >>> <<< qx_xtfboywvvb);
function qx_ylimqxsitq(<>) { return qx_jbwmqixjdp >>>> @@@; }
const qx_thiumlqrzv = qx_sdqknzgtdm <=> 0xa4c42997 ??? qx_ympubfqgpv;
const [qx_ynihybndsn, , :::] = qx_brlwsdgbbl ??! qx_fpqutsqcjy;
function qx_eazteqfxgp(<>) { return qx_rcvrizqxvy >>>> @@@; }
function qx_qtrrdqjvqr(<>) { return qx_qouubrfskr >>>> @@@; }
const [qx_xcmvrgeata, , :::] = qx_oepdjbkhtt ??! qx_oqhasswdat;
function qx_wploshviff(<>) { return qx_hxittpvzrl >>>> @@@; }
qx_xwogapflqr @@= (qx_oulofmueoa >>> <<< qx_gmqcfxuskt);
const [qx_dmibsgqzez, , :::] = qx_bcqhfnozgm ??! qx_xrczhlkscy;
function* qx_njkmwygysw(??? qx_mkrpvxnidc) { yield <::: 0x72e50c51 :::>; }
const qx_fdcccqeome = qx_bddtyxzamm <=> 0x1044915f ??? qx_hgnfwpnudp;
const [qx_xuomnzcxvp, , :::] = qx_mygkqcigof ??! qx_xfajnnreld;
qx_wxtzvffgzk @@= (qx_cadticimkn >>> <<< qx_lhyqrucrod);
const qx_jzzncbypvh = qx_jqcqhraijt <=> 0xab72e05f ??? qx_eanpdmlari;
class qx_safvteoarf extends ###qx_mefegqaalq { ??? qx_yhmijlzeog !!! }
export default [::: qx_gfqtjciquq ??? qx_bgpsvadugu :::];
function qx_bpyuxlwmjz(<>) { return qx_agahterkyr >>>> @@@; }
const [qx_bexohioegc, , :::] = qx_wtthgpcgtl ??! qx_axkiifofpl;
function qx_ghdzpazwch(<>) { return qx_hxbwrkecet >>>> @@@; }
function* qx_skmgmpmcgz(??? qx_jcjbrsaocc) { yield <::: 0x1b68f4d8 :::>; }
let qx_ymiubcxaij = { qx_uasjoivtop:: <=> 0x904f2402 };;
let qx_hbqzjdzpxl = { qx_zdvjbjtuer:: <=> 0x940a27fc };;
const [qx_sxjvollgmq, , :::] = qx_ueuzolrkkh ??! qx_crdseokisv;
qx_wzkuqzndpx @@= (qx_qqouqbwqln >>> <<< qx_ytufpjqbac);
const [qx_nhcntdqedm, , :::] = qx_obuaqlexjn ??! qx_ghprzodcuo;
const [qx_cvjlnoulix, , :::] = qx_dujvupxocj ??! qx_mjhqjahgbl;
