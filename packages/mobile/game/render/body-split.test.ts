/**
 * Checks on the body split.
 *
 * The thing being defended here is that cutting a picture in two and drawing the halves separately must
 * put them back exactly where the whole picture was. If the halves drift by even one pixel the character
 * has a visible seam across its waist, and a seam is far worse than no leg movement at all. So most of
 * what follows reconstructs the drawn rectangle of each half by hand and demands that the two rectangles
 * add up to the original with nothing missing and nothing overlapping.
 */

import {
  LEG_LIFT_SHARE,
  LEG_LINE,
  LEG_SWING,
  MIN_SPLIT_HEIGHT,
  legLiftY,
  legOffsetX,
  splitBody,
} from "./body-split";
import { STEP_PHASES } from "./step-anim";
import type { Frame } from "./batcher";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A frame shaped like a real packed character: a slice of a bigger atlas, pivoted at the feet. */
function frame(w: number, h: number): Frame {
  return { u0: 0.25, v0: 0.5, u1: 0.375, v1: 0.75, w, h, ox: w >> 1, oy: h };
}

/** Where a half actually lands on screen, using the batcher's own pivot arithmetic. */
function drawnTop(f: Frame, y: number, scaleY: number): number {
  return y - f.oy * scaleY;
}

function drawnBottom(f: Frame, y: number, scaleY: number): number {
  return drawnTop(f, y, scaleY) + f.h * scaleY;
}

// ---------------------------------------------------------------------------------------------
// 1. The two halves are the whole picture, and nothing else.

{
  const whole = frame(32, 32);
  const { top, legs, cut, split } = splitBody(whole);

  check("a character-sized picture is worth cutting", split);
  check("the cut is above halfway down", cut > whole.h / 2 && cut < whole.h);
  check("the cut matches the hip line", cut === Math.round(whole.h * LEG_LINE));
  check("the halves add up to the whole height", top.h + legs.h === whole.h, `${top.h}+${legs.h}`);
  check("neither half is empty", top.h > 0 && legs.h > 0);
  check("both halves keep the full width", top.w === whole.w && legs.w === whole.w);
  check("the sideways texture bounds are untouched", top.u0 === whole.u0 && legs.u1 === whole.u1);
  check("the top half starts where the picture starts", top.v0 === whole.v0);
  check("the bottom half ends where the picture ends", legs.v1 === whole.v1);
  check("the halves meet at one texture line, with no gap", top.v1 === legs.v0);

  const vSpan = whole.v1 - whole.v0;
  const expectedCutV = whole.v0 + (vSpan * cut) / whole.h;
  check("the texture cut sits at the same fraction as the pixel cut", Math.abs(top.v1 - expectedCutV) < 1e-12);
  check("the texture cut is inside the picture", top.v1 > whole.v0 && top.v1 < whole.v1);
}

// ---------------------------------------------------------------------------------------------
// 2. Drawn back to back, the halves reassemble the original rectangle exactly. This is the seam test.

for (const scale of [1, 2, 3, 0.5]) {
  const whole = frame(32, 32);
  const { top, legs } = splitBody(whole);
  const y = 100;

  const wholeTop = drawnTop(whole, y, scale);
  const wholeBottom = drawnBottom(whole, y, scale);

  check(`the top half starts where the picture starts (x${scale})`, Math.abs(drawnTop(top, y, scale) - wholeTop) < 1e-9);
  check(`the legs end where the picture ends (x${scale})`, Math.abs(drawnBottom(legs, y, scale) - wholeBottom) < 1e-9);
  check(
    `there is no seam and no overlap between the halves (x${scale})`,
    Math.abs(drawnBottom(top, y, scale) - drawnTop(legs, y, scale)) < 1e-9,
    `${drawnBottom(top, y, scale)} vs ${drawnTop(legs, y, scale)}`,
  );
  check(
    `the legs are the lower half, not the upper (x${scale})`,
    drawnTop(legs, y, scale) > drawnTop(top, y, scale),
  );
}

// ---------------------------------------------------------------------------------------------
// 3. A picture too small to cut is left alone rather than cut into slivers.

{
  const tiny = frame(8, MIN_SPLIT_HEIGHT - 1);
  const r = splitBody(tiny);
  check("a tiny picture is not split", !r.split);
  check("a tiny picture hands back itself as the top", r.top === tiny);
  check("a tiny picture hands back itself as the legs", r.legs === tiny);

  const justBigEnough = splitBody(frame(8, MIN_SPLIT_HEIGHT));
  check("the smallest allowed picture is split", justBigEnough.split);
}

// ---------------------------------------------------------------------------------------------
// 4. Odd heights and awkward sizes still leave both halves alive.

for (const h of [12, 13, 15, 17, 24, 31, 33, 48, 64]) {
  const r = splitBody(frame(16, h));
  check(`height ${h}: both halves have rows`, r.top.h >= 1 && r.legs.h >= 1);
  check(`height ${h}: the halves total the original`, r.top.h + r.legs.h === h);
  check(`height ${h}: the pivot shift equals the cut`, r.top.oy - r.legs.oy === r.cut);
}

// ---------------------------------------------------------------------------------------------
// 5. The stride table is a real cycle: it strides both ways and it comes back to nothing.

{
  check("there is one swing entry per pose", LEG_SWING.length === STEP_PHASES);
  check("the swings cancel over a full cycle", LEG_SWING.reduce((a, b) => a + b, 0) === 0);
  check("every swing is a whole pixel", LEG_SWING.every((v) => Number.isInteger(v)));
  check("the legs stride to both sides", LEG_SWING.some((v) => v > 0) && LEG_SWING.some((v) => v < 0));
  check("some pose plants the legs under the body", LEG_SWING.some((v) => v === 0));
  check("no swing is wild", LEG_SWING.every((v) => Math.abs(v) <= 3));
}

// ---------------------------------------------------------------------------------------------
// 6. Standing still means standing still. This is the whole point of the walking flag.

{
  let moved = false;
  for (let p = 0; p < STEP_PHASES; p++) {
    if (legOffsetX(p, false, false) !== 0) moved = true;
    if (legOffsetX(p, false, true) !== 0) moved = true;
  }
  check("a character standing still never shifts its legs", !moved);

  let anyWalkOffset = false;
  for (let p = 0; p < STEP_PHASES; p++) if (legOffsetX(p, true, false) !== 0) anyWalkOffset = true;
  check("a walking character does shift its legs at some point", anyWalkOffset);
}

// ---------------------------------------------------------------------------------------------
// 7. The stride mirrors with the picture, and survives a phase outside the table.

{
  for (let p = 0; p < STEP_PHASES; p++) {
    check(
      `pose ${p} mirrors when facing the other way`,
      legOffsetX(p, true, true) === -legOffsetX(p, true, false),
    );
    check(`pose ${p} matches the table`, legOffsetX(p, true, false) === LEG_SWING[p]);
  }

  check("a phase past the end wraps instead of vanishing", legOffsetX(STEP_PHASES + 1, true, false) === LEG_SWING[1]);
  check("a negative phase wraps forward", legOffsetX(-1, true, false) === LEG_SWING[STEP_PHASES - 1]);
  check("a far-out phase is still a real pose", Number.isInteger(legOffsetX(9999, true, false)));
}

// ---------------------------------------------------------------------------------------------
// 8. The legs lift less than the chest, in whole pixels, and never the wrong way.

{
  check("the legs keep only part of the lift", LEG_LIFT_SHARE > 0 && LEG_LIFT_SHARE < 1);
  check("a flat body has flat legs", legLiftY(0) === 0);
  check("the legs lift the same direction as the body", legLiftY(-4) < 0 && legLiftY(4) > 0);
  check("the legs never out-lift the body", Math.abs(legLiftY(-4)) <= 4);
  for (const lift of [-3, -2, -1, 0, 1, 2, 3]) {
    check(`a lift of ${lift} lands on a whole pixel`, Number.isInteger(legLiftY(lift)));
  }
}

console.log(`body-split: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`body-split: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
