/**
 * Body split — how the legs actually move without a second picture being drawn.
 *
 * THE PROBLEM THIS SOLVES
 * Every character in the game is one drawn picture. The step animation next door bobs, squashes and
 * leans that picture so a walking body has weight, and that gets most of the way there — but the legs
 * themselves never move, because a single picture has one pair of legs frozen in one position. Somebody
 * watching closely sees a statue being slid around, and once seen it cannot be unseen.
 *
 * WHAT THIS DOES
 * It cuts the one picture in two along a horizontal line at the hips, and draws the halves as two
 * separate quads instead of one. The top half — head, chest, arms — is drawn exactly where it always
 * was. The bottom half is shifted sideways a pixel or two, in a cycle, in step with the walk. That is
 * a stride: the legs swing out ahead of the body, plant, and swing back. It costs one extra quad per
 * character and no new art at all.
 *
 * WHY A CUT AND NOT A NEW DRAWING
 * Proper drawn walk frames are better and are still worth doing later. This is what can be had now,
 * for twelve characters at once, and it keeps working underneath drawn frames if they ever arrive —
 * the halves are just frames, so a walk-cycle picture would be split the same way or not at all.
 *
 * WHOLE PIXELS ONLY
 * This is a pixel-art game, so the sideways shift is a table of whole numbers and the cut lands on a
 * whole row of texels. A leg shifted by two thirds of a pixel does not stride, it shimmers.
 *
 * THE CUT IS COMPUTED ONCE
 * Splitting a frame is arithmetic on eight numbers, but it is arithmetic that never changes for a given
 * character, so it is done at load time and the halves are held. Nothing in here is called inside a
 * frame except `legOffsetX`, which is a table lookup.
 *
 * NOT SIMULATION
 * Nothing here is ever read by the game rules. Two players seeing different strides would still be
 * playing the identical game, exactly as with the bob.
 */

import type { Frame } from "./batcher";
import { STEP_PHASES } from "./step-anim";

/**
 * Where the cut lands, as a fraction of the picture's height measured from the top.
 *
 * Just above halfway. The characters are drawn standing, and on a standing figure at this sprite size
 * the hips sit a little above the middle of the picture — cutting at a true half puts the line through
 * the belt and takes a strip of torso along with the legs, which reads as the whole body shearing
 * rather than the legs swinging.
 */
export const LEG_LINE = 0.55;

/**
 * The smallest picture worth cutting, in pixels of height.
 *
 * Below this the bottom half is a handful of rows and a one-pixel shift on it is noise, not a stride.
 * Small frames are left whole and simply never get a leg offset.
 */
export const MIN_SPLIT_HEIGHT = 12;

/**
 * Sideways shift of the legs in each pose of the cycle, in whole world pixels.
 *
 * The two contact poses sit centred under the body; the two lift poses stride to opposite sides. That
 * is one footfall forward and the next one back, which is what makes a cycle of four read as two steps
 * rather than as a twitch. Two pixels is deliberate: one is invisible under the bob already happening,
 * three detaches the legs from the body.
 */
export const LEG_SWING: readonly number[] = [0, 2, 0, -2];

/**
 * How much of the body's lift the legs keep, as a multiplier.
 *
 * The legs lift less than the chest does, because in a real step the feet stay near the floor while the
 * body rises over them. Keeping the legs fully in sync with the bob makes the whole figure hop.
 */
export const LEG_LIFT_SHARE = 0.5;

/** The two halves of one character picture, plus whether cutting it was worth doing at all. */
export interface BodyHalves {
  /** Head, chest and arms. Drawn at the character's position exactly as the whole picture was. */
  readonly top: Frame;
  /** Hips and legs. Drawn at the same position, shifted sideways by the stride. */
  readonly legs: Frame;
  /** Rows of the picture that went to the top half. */
  readonly cut: number;
  /** False when the picture was too small to cut — both halves are then the original, unshifted. */
  readonly split: boolean;
}

/**
 * Cut one character picture in two at the hips.
 *
 * Call this once per character when the atlas loads and hold the result. It allocates, which is exactly
 * why it must never be called inside a frame.
 *
 * A picture too short to be worth cutting comes back with `split: false` and both halves equal to the
 * original, so a caller can draw it without a special case — it just draws the same picture twice on
 * top of itself, which is why the caller checks `split` and draws once instead.
 */
export function splitBody(frame: Frame): BodyHalves {
  if (frame.h < MIN_SPLIT_HEIGHT) {
    return { top: frame, legs: frame, cut: frame.h, split: false };
  }

  const cut = Math.max(1, Math.min(frame.h - 1, Math.round(frame.h * LEG_LINE)));
  // The texture coordinate of the cut line, found by walking the same fraction down the frame's own
  // slice of the atlas. Done in v space rather than pixels so it survives whatever the atlas packer did.
  const vSpan = frame.v1 - frame.v0;
  const vCut = frame.v0 + (vSpan * cut) / frame.h;

  const top: Frame = {
    u0: frame.u0,
    v0: frame.v0,
    u1: frame.u1,
    v1: vCut,
    w: frame.w,
    h: cut,
    ox: frame.ox,
    oy: frame.oy,
  };

  // The legs' top-left corner sits `cut` rows below the whole picture's top-left corner. Moving the
  // pivot up by the same `cut` is what puts it back in the right place, at any draw scale.
  const legs: Frame = {
    u0: frame.u0,
    v0: vCut,
    u1: frame.u1,
    v1: frame.v1,
    w: frame.w,
    h: frame.h - cut,
    ox: frame.ox,
    oy: frame.oy - cut,
  };

  return { top, legs, cut, split: true };
}

/**
 * How far the legs are shifted sideways this frame, in whole world pixels.
 *
 * `walking` comes straight off the step pose: a character standing still has both feet planted and its
 * legs must not drift, or it looks like it is shuffling in place.
 *
 * `flipX` mirrors the stride along with the picture, so a character walking left strides left.
 */
export function legOffsetX(phase: number, walking: boolean, flipX: boolean): number {
  if (!walking) return 0;
  const p = phase % STEP_PHASES;
  const i = p < 0 ? p + STEP_PHASES : p;
  const swing = LEG_SWING[i] ?? 0;
  return flipX ? -swing : swing;
}

/**
 * How far the legs lift this frame, given the lift the whole body is taking.
 *
 * Whole pixels, rounded toward the floor, because the legs lifting by half a pixel is the shimmer this
 * whole file exists to avoid.
 */
export function legLiftY(bodyLiftY: number): number {
  return Math.round(bodyLiftY * LEG_LIFT_SHARE);
}
