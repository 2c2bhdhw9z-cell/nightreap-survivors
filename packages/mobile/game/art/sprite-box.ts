/**
 * The arithmetic behind showing one cell of the packed sheet inside a menu box.
 *
 * The drawing itself is a few lines of view code, but the numbers underneath it are the part that can be
 * wrong in a way nobody notices: a scale that is not a whole number makes pixel art wobble, and a lock
 * badge that is not smaller than the art it marks covers the art completely. Both of those happened. So
 * the numbers live here, on their own, where a test can hold them to account, and the view code just asks.
 *
 * Nothing in this file knows what a screen is. It is plain arithmetic on whole numbers.
 */

import { ATLAS_CELL } from "./frames";

/**
 * How many times bigger than the art itself we are allowed to draw, given the box we have to fit inside.
 *
 * Always a whole number, and never less than one. Pixel art at two-and-a-half times its size has some rows
 * of dots two screen dots tall and some three; the eye reads the difference as a shimmer along every edge.
 * Rounding down means a sprite is sometimes a little smaller than the space it was given, which is the
 * cheaper mistake by a long way.
 */
export function spriteScale(box: number): number {
  if (!Number.isFinite(box)) return 1;
  return Math.max(1, Math.floor(box / ATLAS_CELL));
}

/** The size the art will really be drawn at inside a box of the given size. Always a multiple of a cell. */
export function spriteSize(box: number): number {
  return spriteScale(box) * ATLAS_CELL;
}

/**
 * How big the lock badge may be for art drawn at this scale: one whole step down, so it can sit in the
 * corner and still leave the picture readable.
 *
 * Zero means there is no room for one at all. A badge can never be drawn below one cell — there is no such
 * thing as half a dot of art — so art drawn at a single scale has no corner to put it in, and a screen in
 * that position has to say "locked" in words instead of leaning on a picture.
 */
export function badgeSize(scale: number): number {
  if (!Number.isFinite(scale) || scale < 2) return 0;
  return (Math.floor(scale) - 1) * ATLAS_CELL;
}

/** Will art drawn inside a box this big carry a readable lock badge? */
export function fitsLockBadge(box: number): boolean {
  return badgeSize(spriteScale(box)) > 0;
}

/**
 * Where to shove the whole sheet so the wanted cell lands inside the box.
 *
 * There is no "draw part of a picture" in a menu, so the entire sheet is blown up as one block and pushed
 * up and to the left until the cell we want is the only part still inside a box that clips the rest. These
 * are the four numbers that block needs.
 */
export function sheetPlacement(
  cellX: number,
  cellY: number,
  sheetWidth: number,
  sheetHeight: number,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const step = Math.max(1, Math.floor(scale));
  return {
    left: -cellX * step,
    top: -cellY * step,
    width: sheetWidth * step,
    height: sheetHeight * step,
  };
}
