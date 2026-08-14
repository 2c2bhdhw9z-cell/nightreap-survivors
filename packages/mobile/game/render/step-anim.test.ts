/**
 * Checks on the step animation.
 *
 * The thing being defended here is subtle enough to be worth naming: this animation is correct when it
 * *stops*. A bob that keeps going while the character stands still, or that runs on the clock so a slowed
 * character still struts, is worse than no animation, and neither of those is visible in a screenshot.
 * So most of what follows is about the pose changing only when the body has actually covered ground.
 */

import {
  IDLE_PERIOD_SECONDS,
  IDLE_SPEED,
  MAX_STEP_PER_SECOND,
  STEP_LEAN,
  STEP_LENGTH,
  STEP_LIFT,
  STEP_PHASES,
  STEP_SQUASH_X,
  STEP_SQUASH_Y,
  WalkTracker,
  createStepPose,
  flipForFacing,
  phaseFor,
  stepPose,
} from "./step-anim";
import { FACING } from "../sim/player";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 1. The pose tables line up with each other.
//
// Four separate tables indexed by the same number is exactly the shape of mistake where somebody adds a
// fifth pose to one of them and the others silently keep their old length.
// ---------------------------------------------------------------------------------------------
{
  check("lift table length", STEP_LIFT.length === STEP_PHASES, `${STEP_LIFT.length}`);
  check("squash x length", STEP_SQUASH_X.length === STEP_PHASES, `${STEP_SQUASH_X.length}`);
  check("squash y length", STEP_SQUASH_Y.length === STEP_PHASES, `${STEP_SQUASH_Y.length}`);
  check("lean table length", STEP_LEAN.length === STEP_PHASES, `${STEP_LEAN.length}`);

  // Every lift is a whole number of pixels. A fractional lift on a pixel sprite shimmers instead of
  // lifting, which is the single most common way this effect is got wrong.
  for (let i = 0; i < STEP_LIFT.length; i++) {
    const v = STEP_LIFT[i] ?? 0;
    check(`lift ${i} is whole pixels`, Number.isInteger(v), `${v}`);
    check(`lift ${i} is up or flat`, v <= 0, `${v}`);
    check(`lift ${i} is small`, v >= -2, `${v}`);
  }

  // The body keeps its volume: wider means shorter and the other way round.
  for (let i = 0; i < STEP_PHASES; i++) {
    const sx = STEP_SQUASH_X[i] ?? 1;
    const sy = STEP_SQUASH_Y[i] ?? 1;
    check(`squash ${i} conserves bulk`, Math.abs(sx * sy - 1) < 0.02, `${(sx * sy).toFixed(3)}`);
    check(`squash ${i} is subtle`, sx > 0.9 && sx < 1.1 && sy > 0.9 && sy < 1.1, `${sx}/${sy}`);
  }

  // The two footfalls lean opposite ways, or both steps look like the same foot.
  const leans = STEP_LEAN.filter((v) => v !== 0);
  check("two leaning poses", leans.length === 2, `${leans.length}`);
  check(
    "leans are opposite",
    leans.length === 2 && (leans[0] ?? 0) === -(leans[1] ?? 0),
    leans.join(","),
  );
  for (const v of leans) {
    check("lean is a few degrees", Math.abs(v) > 0.005 && Math.abs(v) < 0.2, `${v}`);
  }

  // A contact pose has to be flat, and a lift pose has to be off the floor, or there is no cycle.
  check("pose 0 is a contact", (STEP_LIFT[0] ?? -1) === 0);
  check("pose 2 is a contact", (STEP_LIFT[2] ?? -1) === 0);
  check("pose 1 is a lift", (STEP_LIFT[1] ?? 0) < 0);
  check("pose 3 is a lift", (STEP_LIFT[3] ?? 0) < 0);
}

// ---------------------------------------------------------------------------------------------
// 2. Distance turns into poses, and it wraps.
// ---------------------------------------------------------------------------------------------
{
  check("no distance is pose 0", phaseFor(0) === 0, `${phaseFor(0)}`);
  check("negative distance is pose 0", phaseFor(-50) === 0, `${phaseFor(-50)}`);
  check("part of a step stays put", phaseFor(STEP_LENGTH * 0.9) === 0);
  check("one step advances", phaseFor(STEP_LENGTH * 1.1) === 1);
  check("two steps advance", phaseFor(STEP_LENGTH * 2.1) === 2);
  check("three steps advance", phaseFor(STEP_LENGTH * 3.1) === 3);
  check("four steps wrap to the start", phaseFor(STEP_LENGTH * 4.1) === 0);

  // Walking a very long way must not drift out of the table. A run is half an hour of walking.
  for (const laps of [10, 500, 20000]) {
    const p = phaseFor(STEP_LENGTH * (laps * STEP_PHASES + 1.5));
    check(`pose stays in range after ${laps} cycles`, p === 1, `${p}`);
  }

  // Every pose is reachable — a cycle that only ever shows two of its four poses is a broken cycle.
  const seen = new Set<number>();
  for (let d = 0; d < STEP_LENGTH * STEP_PHASES; d += 0.5) seen.add(phaseFor(d));
  check("all four poses are reachable", seen.size === STEP_PHASES, `${seen.size}`);
}

// ---------------------------------------------------------------------------------------------
// 3. Facing decides mirroring, and only left and right mirror.
// ---------------------------------------------------------------------------------------------
{
  check("west mirrors", flipForFacing(FACING.west));
  check("north west mirrors", flipForFacing(FACING.northWest));
  check("south west mirrors", flipForFacing(FACING.southWest));
  check("east does not mirror", !flipForFacing(FACING.east));
  check("north east does not mirror", !flipForFacing(FACING.northEast));
  check("south east does not mirror", !flipForFacing(FACING.southEast));

  // Straight up and straight down are the interesting ones: neither is a left or a right, so mirroring
  // either would make a character flip back and forth while walking in a straight vertical line.
  check("straight up does not mirror", !flipForFacing(FACING.north));
  check("straight down does not mirror", !flipForFacing(FACING.south));

  // Exactly three of the eight mirror. Any other count means a facing was miscategorised.
  let mirrored = 0;
  for (let f = 0; f < 8; f++) if (flipForFacing(f)) mirrored++;
  check("three of eight facings mirror", mirrored === 3, `${mirrored}`);
}

// ---------------------------------------------------------------------------------------------
// 4. Standing still stops the walk — the whole point of the file.
// ---------------------------------------------------------------------------------------------
{
  const pose = createStepPose();

  // A character that has walked miles but is standing still now must not be mid-stride.
  stepPose(STEP_LENGTH * 3.5, 0, FACING.south, 0, pose);
  check("stopped means not walking", !pose.walking);
  check("stopped means no lean", pose.lean === 0, `${pose.lean}`);
  check("stopped means no squash", pose.scaleX === 1 && pose.scaleY === 1);

  // Just under the standing-still threshold is still standing still; just over it is walking.
  stepPose(STEP_LENGTH * 3.5, IDLE_SPEED - 0.01, FACING.south, 0, pose);
  check("a crawl counts as stopped", !pose.walking);
  stepPose(STEP_LENGTH * 3.5, IDLE_SPEED + 0.01, FACING.south, 0, pose);
  check("over the threshold counts as walking", pose.walking);

  // The breath must actually breathe, and must come back to where it started.
  const lifts = new Set<number>();
  for (let t = 0; t < IDLE_PERIOD_SECONDS; t += IDLE_PERIOD_SECONDS / 40) {
    stepPose(0, 0, FACING.south, t, pose);
    lifts.add(pose.liftY);
    check("breath is whole pixels", Number.isInteger(pose.liftY), `${pose.liftY}`);
  }
  check("the breath moves", lifts.size > 1, `${lifts.size}`);
  check("the breath is gentle", Math.max(...[...lifts].map(Math.abs)) <= 1);

  stepPose(0, 0, FACING.south, 0, pose);
  const atStart = pose.liftY;
  stepPose(0, 0, FACING.south, IDLE_PERIOD_SECONDS, pose);
  check("the breath loops", pose.liftY === atStart, `${atStart} vs ${pose.liftY}`);

  // Standing still must still face the right way — a stopped character looking the wrong way is
  // as wrong as a sliding one.
  stepPose(0, 0, FACING.west, 0, pose);
  check("a stopped character still faces left", pose.flipX);
}

// ---------------------------------------------------------------------------------------------
// 5. Walking produces the pose the table says it should, and writes into the caller's object.
// ---------------------------------------------------------------------------------------------
{
  const pose = createStepPose();
  for (let phase = 0; phase < STEP_PHASES; phase++) {
    const distance = STEP_LENGTH * (phase + 0.5);
    stepPose(distance, 100, FACING.east, 0, pose);
    check(`walking pose ${phase} number`, pose.phase === phase, `${pose.phase}`);
    check(`walking pose ${phase} lift`, pose.liftY === STEP_LIFT[phase], `${pose.liftY}`);
    check(`walking pose ${phase} width`, pose.scaleX === STEP_SQUASH_X[phase]);
    check(`walking pose ${phase} height`, pose.scaleY === STEP_SQUASH_Y[phase]);
    check(`walking pose ${phase} lean`, pose.lean === STEP_LEAN[phase]);
    check(`walking pose ${phase} says walking`, pose.walking);
  }

  // The same object comes back every time, because drawing a crowd must not allocate.
  const returned = stepPose(0, 100, FACING.east, 0, pose);
  check("the pose object is reused", returned === pose);

  // Walking speed must not change the pose — only distance may. If speed leaked into the pose, a
  // slowed character would animate differently from a fast one at the same point in its stride.
  const slow = createStepPose();
  const fast = createStepPose();
  stepPose(STEP_LENGTH * 1.5, 10, FACING.east, 0, slow);
  stepPose(STEP_LENGTH * 1.5, 900, FACING.east, 0, fast);
  check("speed does not change the pose", slow.phase === fast.phase && slow.liftY === fast.liftY);

  // Time must not change a walking pose either. This is the check that fails the moment somebody
  // "improves" this by putting a clock back into it.
  const early = createStepPose();
  const late = createStepPose();
  stepPose(STEP_LENGTH * 1.5, 100, FACING.east, 0, early);
  stepPose(STEP_LENGTH * 1.5, 100, FACING.east, 999, late);
  check("time does not change a walking pose", early.phase === late.phase && early.liftY === late.liftY);
}

// ---------------------------------------------------------------------------------------------
// 6. The distance tracker: it must measure walking and refuse everything that is not walking.
// ---------------------------------------------------------------------------------------------
{
  const walk = new WalkTracker(4);
  const dt = 1 / 60;

  // The very first sighting must bank the position and credit nothing. A character spawning at
  // (500, 500) would otherwise be credited seven hundred units of walking on frame one.
  walk.update(0, 500, 500, dt);
  check("first sighting credits nothing", walk.distance[0] === 0, `${walk.distance[0]}`);
  check("first sighting has no speed", walk.speed[0] === 0, `${walk.speed[0]}`);

  // Then a plain walk east.
  walk.update(0, 502, 500, dt);
  check("a step is measured", Math.abs((walk.distance[0] ?? 0) - 2) < 1e-4, `${walk.distance[0]}`);
  check("speed is distance over time", Math.abs((walk.speed[0] ?? 0) - 120) < 0.5, `${walk.speed[0]}`);

  // Distance only ever grows, including when walking back the way you came — otherwise pacing left
  // and right would unwind the stride and the character would moonwalk.
  walk.update(0, 500, 500, dt);
  check("walking back still adds", Math.abs((walk.distance[0] ?? 0) - 4) < 1e-4, `${walk.distance[0]}`);

  // Diagonal distance is the real distance, not the sum of the two sides.
  const diag = new WalkTracker(1);
  diag.update(0, 0, 0, dt);
  diag.update(0, 3, 4, dt);
  check("diagonals measure straight-line", Math.abs((diag.distance[0] ?? 0) - 5) < 1e-4, `${diag.distance[0]}`);

  // Standing perfectly still adds nothing and reports no speed.
  const still = new WalkTracker(1);
  still.update(0, 10, 10, dt);
  still.update(0, 10, 10, dt);
  check("standing still adds nothing", still.distance[0] === 0, `${still.distance[0]}`);
  check("standing still has no speed", still.speed[0] === 0, `${still.speed[0]}`);

  // A teleport is not a walk. Being yanked across the map must not spin the character through
  // fifty poses in one frame.
  const port = new WalkTracker(1);
  port.update(0, 0, 0, dt);
  port.update(0, MAX_STEP_PER_SECOND * dt * 10, 0, dt);
  check("a teleport adds nothing", port.distance[0] === 0, `${port.distance[0]}`);
  check("a teleport reports no speed", port.speed[0] === 0, `${port.speed[0]}`);
  // ...and the frame after a teleport measures from the new spot, not the old one.
  port.update(0, MAX_STEP_PER_SECOND * dt * 10 + 2, 0, dt);
  check("walking resumes after a teleport", Math.abs((port.distance[0] ?? 0) - 2) < 1e-4, `${port.distance[0]}`);

  // A frame with no time in it must not divide by zero and produce an infinite speed.
  const zero = new WalkTracker(1);
  zero.update(0, 0, 0, dt);
  zero.update(0, 5, 0, 0);
  check("a zero-length frame is safe", Number.isFinite(zero.speed[0] ?? 0), `${zero.speed[0]}`);

  // Characters do not share a stride.
  const party = new WalkTracker(4);
  for (let i = 0; i < 4; i++) party.update(i, 0, 0, dt);
  party.update(1, 6, 0, dt);
  check("one character walking", Math.abs((party.distance[1] ?? 0) - 6) < 1e-4);
  check("does not move the others", party.distance[0] === 0 && party.distance[2] === 0 && party.distance[3] === 0);

  // A new run starts from a standstill, including the first-sighting rule.
  party.reset();
  check("reset clears the stride", party.distance[1] === 0, `${party.distance[1]}`);
  party.update(1, 900, 900, dt);
  check("reset restores first-sighting", party.distance[1] === 0, `${party.distance[1]}`);
}

// ---------------------------------------------------------------------------------------------
// 7. The tracker and the pose agree end to end: walk a straight line and the cycle turns over.
// ---------------------------------------------------------------------------------------------
{
  const walk = new WalkTracker(1);
  const pose = createStepPose();
  const dt = 1 / 60;
  const speedPerSecond = 90;
  const perFrame = speedPerSecond * dt;

  let x = 0;
  walk.update(0, x, 0, dt);

  const posesSeen: number[] = [];
  for (let frame = 0; frame < 240; frame++) {
    x += perFrame;
    walk.update(0, x, 0, dt);
    stepPose(walk.distance[0] ?? 0, walk.speed[0] ?? 0, FACING.east, frame * dt, pose);
    const last = posesSeen[posesSeen.length - 1];
    if (last !== pose.phase) posesSeen.push(pose.phase);
  }

  check("walking cycles the poses", posesSeen.length >= 8, `${posesSeen.length} changes`);
  // The cycle must go forwards in order and never skip, or the walk stutters.
  let ordered = true;
  for (let i = 1; i < posesSeen.length; i++) {
    const prev = posesSeen[i - 1] ?? 0;
    const cur = posesSeen[i] ?? 0;
    if (cur !== (prev + 1) % STEP_PHASES) ordered = false;
  }
  check("the cycle runs in order", ordered, posesSeen.join(","));

  // And the moment the feet stop, the stride must stop too — one more frame standing still.
  walk.update(0, x, 0, dt);
  stepPose(walk.distance[0] ?? 0, walk.speed[0] ?? 0, FACING.east, 0, pose);
  check("stopping stops the walk", !pose.walking);
}

console.log(`step-anim: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`step-anim: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
