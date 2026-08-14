/**
 * Step animation — why a character reads as walking instead of sliding.
 *
 * THE PROBLEM THIS SOLVES
 * A character drawn from one unchanging picture, moved by adding to its position every tick, does not
 * look like it is walking. It looks like the picture is being dragged across the floor, because nothing
 * about the picture ever changes. Your eye reads walking from weight: a body rises and falls, leans into
 * the step, and — this is the part everybody forgets — stops doing all of that the instant the feet stop.
 *
 * WHAT THIS DOES INSTEAD OF NEW ART
 * Proper leg movement is two or more drawn pictures per character, which for twelve characters is a
 * painting job, not a code job. That job is still worth doing. This is the part that can be done without
 * it, and it does most of the work: the body bobs, squashes and leans on a cycle, and it faces the way it
 * is going. Put a walk-cycle picture in later and this still applies on top of it, unchanged.
 *
 * DRIVEN BY DISTANCE, NEVER BY TIME
 * The cycle is advanced by how far the character has actually walked, not by the clock. This is the whole
 * trick and it is worth stating plainly:
 *  - Standing still freezes the walk instantly. A time-driven bob keeps jogging on the spot, which looks
 *    worse than no animation at all.
 *  - A character with a movement-speed bonus takes visibly faster steps for free, because it covers the
 *    step length sooner. Nothing has to be told about the bonus.
 *  - Being slowed, frozen or knocked back all read correctly with no special case anywhere.
 *
 * WHOLE PIXELS ONLY
 * This is a pixel-art game. A body lifted by 0.6 of a pixel does not lift, it shimmers, because the
 * fraction lands on a different side of the pixel grid every frame. So the vertical lift comes from a
 * four-entry table of whole numbers and the cycle is a hard step between poses, not a smooth curve. The
 * squash and lean are allowed to be fractional because they scale and rotate a whole sprite, where a
 * small fraction is a shape change rather than a jitter.
 *
 * WHAT IS NOT IN HERE
 * No time, no randomness, no allocation, no state. Every function is arithmetic on its arguments, so a
 * test can ask for any pose directly instead of running a game to reach one. Nothing in this file is ever
 * read by the simulation — it is how the run is drawn, and two players seeing different bobs would still
 * be playing the identical game.
 */

import { FACING } from "../sim/player";

/**
 * World units walked per pose change.
 *
 * At the game's base walking speed this lands a little under four pose changes a second, which is the
 * rate a step reads as a step. Much faster and it becomes a vibration; much slower and the character
 * looks like it is wading.
 */
export const STEP_LENGTH = 7;

/** Poses in a full cycle: contact, lift, contact, lift. Two footfalls, mirrored. */
export const STEP_PHASES = 4;

/**
 * How far the body lifts off the floor in each pose, in whole world pixels, negative being upward.
 *
 * Contact poses sit flat. Lift poses rise one pixel. One pixel sounds like nothing and is in fact the
 * entire difference between walking and sliding at this sprite size — two pixels already reads as
 * hopping, which was tried and looked ridiculous.
 */
export const STEP_LIFT: readonly number[] = [0, -1, 0, -1];

/**
 * Sideways stretch per pose, as a multiplier on the drawn width.
 *
 * A body planting its weight spreads very slightly; a body in the air narrows. The numbers are small on
 * purpose — this is felt rather than seen, and anything stronger turns a walking skeleton into a bouncing
 * cartoon.
 */
export const STEP_SQUASH_X: readonly number[] = [1.04, 0.97, 1.04, 0.97];

/** Vertical stretch per pose. The mirror of the sideways stretch, so the body keeps its volume. */
export const STEP_SQUASH_Y: readonly number[] = [0.96, 1.03, 0.96, 1.03];

/**
 * Body lean per pose, in radians, alternating sides.
 *
 * The two lift poses lean opposite ways, which is what sells one footfall as the left foot and the next
 * as the right without any leg ever being drawn. Roughly three degrees.
 */
export const STEP_LEAN: readonly number[] = [0, 0.05, 0, -0.05];

/**
 * The idle breath cycle, in whole pixels, and how long one loop takes in seconds.
 *
 * A completely motionless character looks like the game has frozen, so a stationary body rises one pixel
 * and settles roughly every second and a half. This is the one thing in the file allowed to run on a
 * clock, because standing still is exactly the case where there is no distance to drive it. It is also
 * the reason the idle loop is slow: anything quick reads as panting.
 */
export const IDLE_LIFT: readonly number[] = [0, -1, 0, 0];
export const IDLE_PERIOD_SECONDS = 1.5;

/**
 * Below this speed, in world units per second, a character counts as standing still.
 *
 * Not zero. A character walking into a wall, being nudged by a crowd, or holding a stick a hair off
 * centre has a tiny non-zero speed, and stepping that out over the step length gives a pose change every
 * few seconds — a body twitching once, then again, with long dead pauses between. Reading that as
 * standing still is correct and looks correct.
 */
export const IDLE_SPEED = 4;

/** A drawn pose. Plain numbers; the caller multiplies its own draw size by the two scales. */
export interface StepPose {
  /** Whole world pixels to add to the drawn Y. Negative is up. */
  liftY: number;
  scaleX: number;
  scaleY: number;
  /** Radians. Positive leans one way, negative the other. */
  lean: number;
  /** Whether the picture should be drawn mirrored, because the character is heading left. */
  flipX: boolean;
  /** Which entry of the cycle this is. Exposed so a walk-cycle picture can use the same number later. */
  phase: number;
  /** Whether this pose came from walking rather than from standing still. */
  walking: boolean;
}

/**
 * Which pose of the cycle a character is in, from how far it has walked.
 *
 * `distanceWalked` is a total that only ever grows, in world units. Feeding it a distance that resets
 * would visibly snap the body, so the caller keeps a running total per character and never clears it
 * mid-run.
 */
export function phaseFor(distanceWalked: number): number {
  if (!(distanceWalked > 0)) return 0;
  const steps = Math.floor(distanceWalked / STEP_LENGTH);
  const phase = steps % STEP_PHASES;
  return phase < 0 ? phase + STEP_PHASES : phase;
}

/**
 * Whether a picture drawn for this facing should be mirrored.
 *
 * The characters are drawn facing the camera, so this is only about left and right. The three westward
 * facings mirror; everything else, including both straight-up and straight-down, does not. Facing is a
 * whole number from the simulation, so this is a lookup and not angle arithmetic.
 */
export function flipForFacing(facing: number): boolean {
  return (
    facing === FACING.west || facing === FACING.northWest || facing === FACING.southWest
  );
}

/**
 * The pose to draw a character in this frame.
 *
 * `speed` is how fast the body is actually moving right now, in world units per second — measured from
 * the positions it has actually reached, not from its stat sheet, so being slowed or held shows up here
 * without anybody passing a flag.
 *
 * `elapsedSeconds` only ever feeds the standing-still breath. It is a required argument rather than a
 * clock read inside this function, because this file is not allowed to know what time it is.
 *
 * `out` is written into and returned, so drawing a hundred characters allocates nothing.
 */
export function stepPose(
  distanceWalked: number,
  speed: number,
  facing: number,
  elapsedSeconds: number,
  out: StepPose,
): StepPose {
  out.flipX = flipForFacing(facing);

  if (speed < IDLE_SPEED) {
    const t = elapsedSeconds / IDLE_PERIOD_SECONDS;
    const frac = t - Math.floor(t);
    const idx = Math.min(IDLE_LIFT.length - 1, Math.floor(frac * IDLE_LIFT.length));
    out.liftY = IDLE_LIFT[idx] ?? 0;
    out.scaleX = 1;
    out.scaleY = 1;
    out.lean = 0;
    out.phase = idx;
    out.walking = false;
    return out;
  }

  const phase = phaseFor(distanceWalked);
  out.liftY = STEP_LIFT[phase] ?? 0;
  out.scaleX = STEP_SQUASH_X[phase] ?? 1;
  out.scaleY = STEP_SQUASH_Y[phase] ?? 1;
  out.lean = STEP_LEAN[phase] ?? 0;
  out.phase = phase;
  out.walking = true;
  return out;
}

/** A pose object to reuse every frame. One per drawn character is plenty; drawing is single-threaded. */
export function createStepPose(): StepPose {
  return { liftY: 0, scaleX: 1, scaleY: 1, lean: 0, flipX: false, phase: 0, walking: false };
}

/**
 * Per-character walk bookkeeping: the running distance and the speed it is currently moving at.
 *
 * This lives in the drawing side rather than the simulation on purpose. The simulation already knows
 * where everybody is and does not need to carry a number that exists only to pick a picture — and a
 * number the simulation does not carry is a number that can never desync a co-op game or a replay.
 */
export class WalkTracker {
  readonly distance: Float32Array;
  readonly speed: Float32Array;
  private readonly lastX: Float32Array;
  private readonly lastY: Float32Array;
  private readonly seeded: Uint8Array;

  constructor(capacity: number) {
    this.distance = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.lastX = new Float32Array(capacity);
    this.lastY = new Float32Array(capacity);
    this.seeded = new Uint8Array(capacity);
  }

  /** Forget everything. Called when a run starts, so a new run does not inherit the last one's stride. */
  reset(): void {
    this.distance.fill(0);
    this.speed.fill(0);
    this.lastX.fill(0);
    this.lastY.fill(0);
    this.seeded.fill(0);
  }

  /**
   * Take in where a character is now and how long since the last look.
   *
   * The first sighting of a character only records the position. Without that, a character starting away
   * from the origin would be credited with the entire distance from nothing to wherever they spawned —
   * hundreds of units in one frame — and would sprint through the cycle on the first frame of the run.
   *
   * A teleport is ignored for the same reason, by the same rule: anything further than a body could
   * plausibly have walked in one frame is a jump, not a walk, and contributes nothing to the stride.
   */
  update(index: number, x: number, y: number, dtSeconds: number): void {
    if (this.seeded[index] === 0) {
      this.seeded[index] = 1;
      this.lastX[index] = x;
      this.lastY[index] = y;
      this.speed[index] = 0;
      return;
    }

    const dx = x - (this.lastX[index] ?? 0);
    const dy = y - (this.lastY[index] ?? 0);
    this.lastX[index] = x;
    this.lastY[index] = y;

    const moved = Math.sqrt(dx * dx + dy * dy);
    if (dtSeconds <= 0) return;

    if (moved > MAX_STEP_PER_SECOND * dtSeconds) {
      // A jump, not a walk. Position is already recorded, so the next frame measures from here.
      this.speed[index] = 0;
      return;
    }

    this.distance[index] = (this.distance[index] ?? 0) + moved;
    this.speed[index] = moved / dtSeconds;
  }
}

/**
 * The fastest a body can move and still be walking, in world units per second.
 *
 * Generous — several times the fastest a character can be built to run — because the only thing this
 * needs to catch is a genuine teleport across the map. Setting it near real walking speed would eat the
 * stride of a fast character, which is the opposite of the point.
 */
export const MAX_STEP_PER_SECOND = 2000;
