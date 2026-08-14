/**
 * Checks for the arithmetic behind showing one cell of the sheet in a menu.
 *
 * Every check here can fail and say so. Run: bun game/art/sprite-box.test.ts
 */

import { ATLAS_CELL } from "./frames";
import { badgeSize, fitsLockBadge, sheetPlacement, spriteScale, spriteSize } from "./sprite-box";

let failures = 0;

function ok(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}`);
}

function eq(name: string, got: number, want: number): void {
  ok(`${name} (got ${got}, want ${want})`, got === want);
}

// --- whole scales only -------------------------------------------------------------------------------

eq("a box exactly one cell wide draws at one scale", spriteScale(ATLAS_CELL), 1);
eq("a box two cells wide draws at two", spriteScale(ATLAS_CELL * 2), 2);
eq("a box two and a half cells wide draws at two, not two and a half", spriteScale(ATLAS_CELL * 2.5), 2);
eq("a box a single dot short of three cells draws at two", spriteScale(ATLAS_CELL * 3 - 1), 2);
eq("a box smaller than one cell still draws at one", spriteScale(8), 1);
eq("a box of nothing still draws at one", spriteScale(0), 1);
eq("a box of nonsense still draws at one", spriteScale(Number.NaN), 1);

for (const box of [1, 7, 32, 33, 63, 64, 65, 100, 231, 512]) {
  const size = spriteSize(box);
  ok(`a box of ${box} draws a whole number of cells`, size % ATLAS_CELL === 0);
  ok(`a box of ${box} never draws smaller than one cell`, size >= ATLAS_CELL);
  ok(`a box of ${box} never draws bigger than the box unless the box is tiny`, size <= Math.max(box, ATLAS_CELL));
}

// A box that grows can never make the art smaller. This is the property that catches a stray rounding
// change far better than any single example does.
let previous = 0;
let monotone = true;
for (let box = 0; box <= 400; box += 1) {
  const size = spriteSize(box);
  if (size < previous) monotone = false;
  previous = size;
}
ok("art never shrinks as the box it sits in grows", monotone);

// --- the lock badge ----------------------------------------------------------------------------------

eq("art at a single scale has no room for a badge", badgeSize(1), 0);
eq("art at two scales carries a badge one cell across", badgeSize(2), ATLAS_CELL);
eq("art at three scales carries a badge two cells across", badgeSize(3), ATLAS_CELL * 2);
eq("a badge is never asked for at half a scale", badgeSize(1.5), 0);
eq("a badge is never asked for at a negative scale", badgeSize(-4), 0);
eq("a badge is never asked for on nonsense", badgeSize(Number.NaN), 0);

for (const scale of [2, 3, 4, 8]) {
  ok(`a badge at ${scale} scales is smaller than the art it marks`, badgeSize(scale) < scale * ATLAS_CELL);
  ok(`a badge at ${scale} scales is a whole number of cells`, badgeSize(scale) % ATLAS_CELL === 0);
}

ok("a one-cell box is told it cannot carry a badge", !fitsLockBadge(ATLAS_CELL));
ok("a one-cell box plus a few dots is still told no", !fitsLockBadge(ATLAS_CELL + 12));
ok("a two-cell box is told it can", fitsLockBadge(ATLAS_CELL * 2));
ok("a nine-step-of-eight box is told it can", fitsLockBadge(8 * 9));

// This is the bug that shipped to a screenshot: four locked shop rows all showed the same padlock and none
// of their own pictures, because the badge was exactly as big as the art. Nail it shut.
let coversArt = false;
for (let scale = 1; scale <= 12; scale += 1) {
  if (badgeSize(scale) >= scale * ATLAS_CELL) coversArt = true;
}
ok("a badge never covers the whole picture at any scale", !coversArt);

// --- shoving the sheet -------------------------------------------------------------------------------

const p = sheetPlacement(1, 1, 1024, 512, 2);
eq("the sheet is pushed left by the cell's own distance across, times the scale", p.left, -2);
eq("and up by the same rule", p.top, -4 / 2);
eq("the sheet is blown up across", p.width, 2048);
eq("and down", p.height, 1024);

const first = sheetPlacement(0, 0, 1024, 512, 3);
eq("the very first cell needs no push across", first.left, 0);
eq("nor down", first.top, 0);

const far = sheetPlacement(340, 170, 1024, 512, 1);
eq("a cell far into the sheet is pushed by its full distance", far.left, -340);
eq("and its full drop", far.top, -170);
ok("a cell far into the sheet is still inside the blown-up sheet", -far.left < far.width);
ok("and still above its bottom", -far.top < far.height);

const broken = sheetPlacement(35, 35, 1024, 512, 2.5);
eq("a half scale is never used to place the sheet across", broken.width, 2048);
eq("nor to push it", broken.left, -70);

// A cell's corner must land exactly on the box's corner at every scale, or the art is a dot out of line.
let aligned = true;
for (const scale of [1, 2, 3, 4]) {
  for (const cell of [0, 34, 68, 340]) {
    const placed = sheetPlacement(cell, cell, 1024, 512, scale);
    if (placed.left !== -cell * scale || placed.top !== -cell * scale) aligned = false;
  }
}
ok("every cell lands exactly on the corner of its box at every scale", aligned);

console.log(failures === 0 ? "\nPASS — sprite box" : `\nFAIL — ${failures} checks failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`sprite box: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
