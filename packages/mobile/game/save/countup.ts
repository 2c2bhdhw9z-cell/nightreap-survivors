/**
 * The gold count-up on the results screen, as pure arithmetic.
 *
 * WHY IT IS A MODULE AND NOT SIX LINES INSIDE THE SCREEN
 *
 * A number that ticks up from the old total to the new one is a tiny animation with a surprising number of
 * ways to be wrong, and every one of them is visible to the player:
 *
 *   - it can overshoot and show a total the player does not actually have;
 *   - it can undershoot and settle one gold short of the real balance, so the shop disagrees with the
 *     screen the player just closed;
 *   - it can run backwards when a run earned nothing;
 *   - it can divide by a zero duration on a device where two frames land on the same millisecond.
 *
 * None of that is testable while it lives inside a component, so it lives here instead: no React, no
 * timers, no state. Given a start, an end and how long the animation has been running, it returns the
 * number to draw. The component's only job is to call it and re-render.
 *
 * THE GUARANTEES
 *
 *   - the first frame shows exactly `from`, so the screen opens on the balance the player already knew;
 *   - the last frame shows exactly `to`, never a rounded approximation of it;
 *   - it never leaves the range between the two, whichever way round they are;
 *   - it is monotone: more elapsed time never shows less gold on the way up.
 */

/** How long the count-up runs. Long enough to read, short enough not to be in the way. */
export const COUNT_MS = 900;

/**
 * Ease-out: fast at the start, slow at the finish.
 *
 * A linear count reads like a spreadsheet recalculating. Easing out makes the number feel like it is
 * landing on a total rather than being cut off at one. Cubic because it is the cheapest curve that reads
 * as a deliberate stop.
 */
export function easeOut(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t >= 1) return 1;
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/**
 * The whole number to draw after `elapsed` milliseconds of counting from `from` to `to`.
 *
 * Rounds rather than truncating, so the animation does not spend its last visible frames one short. The
 * exact endpoints are returned as themselves rather than being computed, because the one frame that must
 * be perfect is the one the player is still looking at when the animation stops.
 */
export function countValue(from: number, to: number, elapsed: number, duration = COUNT_MS): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const start = Math.trunc(from);
  const end = Math.trunc(to);
  if (start === end) return end;
  // A zero or nonsense duration means there is nothing to animate — show the answer.
  if (!Number.isFinite(duration) || duration <= 0) return end;
  // No early-out for a negative, NaN or overrun `elapsed`. `easeOut` already pins its input to 0..1, and
  // a second place that decides the same thing is a second place that can disagree: an early-out here
  // once returned `start` for an elapsed the curve considered finished. One clamp, in one function.
  const value = start + (end - start) * easeOut(elapsed / duration);
  // No second clamp here on purpose. `easeOut` pins its output to 0..1, so the value cannot leave the
  // range between the endpoints, and a range clamp at this line would be code no test can ever make fire
  // — which is the kind of code that quietly stops being true. If the easing is ever changed to a curve
  // that overshoots (a spring, a bounce), the clamp belongs inside `easeOut` with the rest of them.
  return Math.round(value);
}

/** True once the count-up has finished, so the screen can stop re-rendering. */
export function countDone(from: number, to: number, elapsed: number, duration = COUNT_MS): boolean {
  if (Math.trunc(from) === Math.trunc(to)) return true;
  if (!Number.isFinite(duration) || duration <= 0) return true;
  return Number.isFinite(elapsed) && elapsed >= duration;
}
