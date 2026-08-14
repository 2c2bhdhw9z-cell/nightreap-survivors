/**
 * Checks for the "does the list match the sheet" guard.
 *
 * Run: bun game/art/manifest-check.test.ts
 */

import { readFileSync } from "node:fs";

import { MAX_SHEET, checkManifest, type CheckedManifest } from "./manifest-check";

let failures = 0;

function ok(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}`);
}

function good(): CheckedManifest {
  return {
    width: 1024,
    height: 512,
    frames: {
      "a/one": { x: 1, y: 1, w: 32, h: 32 },
      "a/two": { x: 35, y: 1, w: 32, h: 32 },
      "b/edge": { x: 990, y: 478, w: 32, h: 32 },
    },
  };
}

// --- the real thing we ship --------------------------------------------------------------------------

const real = JSON.parse(readFileSync(`${import.meta.dir}/../../assets/atlas.json`, "utf8")) as CheckedManifest;
const realComplaints = checkManifest(real, real.width, real.height);
ok(
  `the sheet the game actually ships passes${realComplaints.length ? `: ${realComplaints.join("; ")}` : ""}`,
  realComplaints.length === 0,
);
ok("the shipped sheet names a serious number of pictures", Object.keys(real.frames).length > 200);

// --- a healthy list ----------------------------------------------------------------------------------

ok("a list that matches its sheet has nothing wrong with it", checkManifest(good(), 1024, 512).length === 0);
ok("a picture touching the far corner is allowed", checkManifest(good(), 1024, 512).length === 0);

// --- a stale sheet -----------------------------------------------------------------------------------

const staleSmaller = checkManifest(good(), 512, 512);
ok("a sheet narrower than the list says is refused", staleSmaller.length > 0);
ok("and the complaint says both sizes out loud", staleSmaller.some((c) => c.includes("1024x512") && c.includes("512x512")));

const staleTaller = checkManifest(good(), 1024, 1024);
ok("a sheet taller than the list says is refused", staleTaller.length > 0);

// --- nonsense in the list ----------------------------------------------------------------------------

const noSize = { width: Number.NaN, height: 512, frames: {} } as CheckedManifest;
ok("a list that does not say how big the sheet is is refused", checkManifest(noSize, 1024, 512).length > 0);
ok(
  "and it stops there rather than blaming every picture",
  checkManifest(noSize, 1024, 512).length === 1,
);

const halfPixel = good();
halfPixel.frames["a/one"] = { x: 1.5, y: 1, w: 32, h: 32 };
ok("a picture positioned half way between pixels is refused", checkManifest(halfPixel, 1024, 512).length > 0);

const nothingThere = good();
nothingThere.frames["a/one"] = { x: 1, y: 1, w: 0, h: 32 };
ok("a picture listed as having no width is refused", checkManifest(nothingThere, 1024, 512).length > 0);

const negative = good();
negative.frames["a/one"] = { x: -4, y: 1, w: 32, h: 32 };
ok("a picture listed off the left edge is refused", checkManifest(negative, 1024, 512).length > 0);

const offRight = good();
offRight.frames["a/two"] = { x: 1000, y: 1, w: 32, h: 32 };
ok("a picture hanging off the right edge is refused", checkManifest(offRight, 1024, 512).length > 0);

const offBottom = good();
offBottom.frames["a/two"] = { x: 1, y: 500, w: 32, h: 32 };
ok("a picture hanging off the bottom edge is refused", checkManifest(offBottom, 1024, 512).length > 0);

ok("an empty list is refused", checkManifest({ width: 256, height: 256, frames: {} }, 256, 256).length > 0);

// --- too big for a cheap phone -----------------------------------------------------------------------

const huge: CheckedManifest = {
  width: MAX_SHEET * 2,
  height: 512,
  frames: { "a/one": { x: 1, y: 1, w: 32, h: 32 } },
};
const hugeComplaints = checkManifest(huge, MAX_SHEET * 2, 512);
ok("a sheet wider than the oldest phones can hold is refused", hugeComplaints.length > 0);
ok("and the complaint says why", hugeComplaints.some((c) => c.includes("oldest phones")));

// --- every problem is reported, not just the first ---------------------------------------------------

const manyBroken = good();
manyBroken.frames["a/one"] = { x: -1, y: 1, w: 32, h: 32 };
manyBroken.frames["a/two"] = { x: 1, y: 600, w: 32, h: 32 };
manyBroken.frames["b/edge"] = { x: 1, y: 1, w: 0, h: 32 };
ok("three broken pictures produce three complaints, so a stale sheet reads as stale", checkManifest(manyBroken, 1024, 512).length === 3);

// Every complaint must name the picture it is about, or nobody can act on it.
ok(
  "every complaint about a picture names that picture",
  checkManifest(manyBroken, 1024, 512).every((c) => c.startsWith("a/") || c.startsWith("b/")),
);

console.log(failures === 0 ? "\nPASS — manifest check" : `\nFAIL — ${failures} checks failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`manifest check: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
