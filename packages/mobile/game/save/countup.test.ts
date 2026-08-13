/**
 * Count-up self-check. Run headless: `bun packages/mobile/game/save/countup.test.ts`
 *
 * WHAT IT PROVES
 *   1. The first frame is exactly the old balance and the last frame is exactly the new one — no rounding
 *      error at either end, because those are the two frames the player actually reads.
 *   2. It never leaves the range between the two, at any elapsed time, including silly ones.
 *   3. It is monotone: sweeping the whole animation, the number never goes backwards.
 *   4. A zero-length run, a zero duration, a negative elapsed and every kind of nonsense all resolve to a
 *      sensible number instead of NaN on screen.
 *   5. Counting down works too, in case a future screen ever spends gold with the same widget.
 *   6. `countDone` agrees with `countValue`: it never reports finished while the value is still moving.
 */

import { COUNT_MS, countDone, countValue, easeOut } from "./countup";

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

console.log("gold count-up self-check");

section("the two frames the player actually reads are exact");
{
  check("the first frame is the old balance", countValue(500, 840, 0) === 500, `${countValue(500, 840, 0)}`);
  check("the last frame is the new balance", countValue(500, 840, COUNT_MS) === 840, `${countValue(500, 840, COUNT_MS)}`);
  check("and it stays there", countValue(500, 840, COUNT_MS * 10) === 840, `${countValue(500, 840, COUNT_MS * 10)}`);
  check("a big total lands exactly", countValue(0, 4294967295, COUNT_MS) === 4294967295);
  check("an awkward total lands exactly", countValue(137, 1039, COUNT_MS) === 1039, `${countValue(137, 1039, COUNT_MS)}`);
}

section("it never shows gold the player does not have");
{
  let outside = 0;
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (let ms = -50; ms <= COUNT_MS + 50; ms += 1) {
    const v = countValue(500, 840, ms);
    if (v < 500 || v > 840) outside++;
    if (v < lowest) lowest = v;
    if (v > highest) highest = v;
  }
  check("no frame left the range", outside === 0, `${outside} frames outside`);
  check("the lowest frame is the start", lowest === 500, `${lowest}`);
  check("the highest frame is the end", highest === 840, `${highest}`);
}

section("it never runs backwards");
{
  let backwards = 0;
  let previous = countValue(0, 6730, 0);
  for (let ms = 1; ms <= COUNT_MS; ms += 1) {
    const v = countValue(0, 6730, ms);
    if (v < previous) backwards++;
    previous = v;
  }
  check("no frame went down", backwards === 0, `${backwards} backwards steps`);
  check("and it actually moved", previous === 6730, `${previous}`);
}

section("it actually animates rather than jumping");
{
  const quarter = countValue(0, 1000, COUNT_MS * 0.25);
  const half = countValue(0, 1000, COUNT_MS * 0.5);
  const threeQuarters = countValue(0, 1000, COUNT_MS * 0.75);
  check("a quarter through is above zero", quarter > 0, `${quarter}`);
  check("a quarter through is below the total", quarter < 1000, `${quarter}`);
  check("halfway is further along", half > quarter, `${half} > ${quarter}`);
  check("three quarters further still", threeQuarters > half, `${threeQuarters} > ${half}`);
  check("and still not finished", threeQuarters < 1000, `${threeQuarters}`);
  // Ease-out means the first half covers more ground than the second.
  check("the first half covers more than the second", half - 0 > 1000 - half, `${half}`);
}

section("mid-flight frames are the exact curve, not roughly it");
{
  // Computed from the documented curve rather than from the code: 1 - (1 - t)^3, times the distance.
  const exact = (from: number, to: number, t: number): number => {
    const inv = 1 - t;
    return Math.round(from + (to - from) * (1 - inv * inv * inv));
  };
  let wrong = 0;
  let firstBad = "";
  for (let step = 1; step < 100; step++) {
    const t = step / 100;
    const want = exact(500, 840, t);
    const got = countValue(500, 840, COUNT_MS * t);
    if (got !== want) {
      wrong++;
      if (firstBad === "") firstBad = `at ${t}: wanted ${want}, got ${got}`;
    }
  }
  check("every frame matches the curve to the gold", wrong === 0, firstBad || "99 frames checked");

  // A handful of hand-checked landmarks, so an off-by-one cannot hide inside a formula that matches
  // itself. 500 -> 840 is 340 gold; a quarter through the clock is 1 - 0.75^3 = 57.8% of the way.
  check("a quarter through reads 697", countValue(500, 840, COUNT_MS * 0.25) === 697, `${countValue(500, 840, COUNT_MS * 0.25)}`);
  check("halfway reads 798", countValue(500, 840, COUNT_MS * 0.5) === 798, `${countValue(500, 840, COUNT_MS * 0.5)}`);
  check("three quarters reads 835", countValue(500, 840, COUNT_MS * 0.75) === 835, `${countValue(500, 840, COUNT_MS * 0.75)}`);
  check("one frame in is barely moving", countValue(500, 840, 16) === 518, `${countValue(500, 840, 16)}`);
  check("and one frame from the end is nearly there", countValue(500, 840, COUNT_MS - 16) === 840, `${countValue(500, 840, COUNT_MS - 16)}`);
}

section("a run that earned nothing does not animate");
{
  check("the value is the balance", countValue(500, 500, 0) === 500, `${countValue(500, 500, 0)}`);
  check("at every moment", countValue(500, 500, 400) === 500);
  check("and it reports finished immediately", countDone(500, 500, 0));
}

section("nonsense resolves to a number, never NaN on screen");
{
  check("NaN start", countValue(Number.NaN, 840, 100) === 0, `${countValue(Number.NaN, 840, 100)}`);
  check("NaN end", countValue(500, Number.NaN, 100) === 0, `${countValue(500, Number.NaN, 100)}`);
  check("infinite end", countValue(500, Number.POSITIVE_INFINITY, 100) === 0);
  check("NaN elapsed shows the start", countValue(500, 840, Number.NaN) === 500, `${countValue(500, 840, Number.NaN)}`);
  check("negative elapsed shows the start", countValue(500, 840, -100) === 500, `${countValue(500, 840, -100)}`);
  check("zero duration shows the answer", countValue(500, 840, 0, 0) === 840, `${countValue(500, 840, 0, 0)}`);
  check("negative duration shows the answer", countValue(500, 840, 0, -5) === 840);
  check("NaN duration shows the answer", countValue(500, 840, 0, Number.NaN) === 840);
  check("fractional endpoints are truncated", countValue(500.9, 840.9, COUNT_MS) === 840, `${countValue(500.9, 840.9, COUNT_MS)}`);
  check("and so is the start frame", countValue(500.9, 840.9, 0) === 500, `${countValue(500.9, 840.9, 0)}`);
}

section("counting down works the same way");
{
  check("it starts at the top", countValue(840, 500, 0) === 840);
  check("it lands on the bottom", countValue(840, 500, COUNT_MS) === 500);
  let outside = 0;
  let forwards = 0;
  let previous = 840;
  for (let ms = 0; ms <= COUNT_MS; ms += 1) {
    const v = countValue(840, 500, ms);
    if (v < 500 || v > 840) outside++;
    if (v > previous) forwards++;
    previous = v;
  }
  check("no frame left the range", outside === 0, `${outside}`);
  check("and it never went back up", forwards === 0, `${forwards}`);
}

section("done agrees with the value");
{
  check("not done at the start", !countDone(500, 840, 0));
  check("not done halfway", !countDone(500, 840, COUNT_MS / 2));
  check("done at the end", countDone(500, 840, COUNT_MS));
  check("done past the end", countDone(500, 840, COUNT_MS * 3));
  check("a zero duration is done", countDone(500, 840, 0, 0));
  // The important one: nothing may report finished while the value is still short of the total.
  let liars = 0;
  for (let ms = 0; ms <= COUNT_MS + 20; ms += 1) {
    if (countDone(500, 840, ms) && countValue(500, 840, ms) !== 840) liars++;
  }
  check("it never claims finished early", liars === 0, `${liars}`);
}

section("the easing curve behaves");
{
  check("zero is zero", easeOut(0) === 0);
  check("one is one", easeOut(1) === 1);
  check("past one is one", easeOut(4) === 1);
  check("before zero is zero", easeOut(-1) === 0);
  check("NaN is zero", easeOut(Number.NaN) === 0);
  check("halfway is past halfway", easeOut(0.5) > 0.5, `${easeOut(0.5)}`);
  let backwards = 0;
  let previous = 0;
  for (let i = 0; i <= 1000; i++) {
    const v = easeOut(i / 1000);
    if (v < previous) backwards++;
    previous = v;
  }
  check("the curve only rises", backwards === 0, `${backwards}`);
  check("and reaches the top", previous === 1, `${previous}`);
}

console.log(failures === 0 ? "\nPASS — gold count-up" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`gold count-up: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
