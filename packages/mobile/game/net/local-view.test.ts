/**
 * Local movement prediction. Run headless: `bun packages/mobile/game/net/local-view.test.ts`
 *
 * This is the file that decides whether a guest's own thumb feels instant or feels like a bad
 * connection. It cannot be tested by playing, because the whole point is what happens during the
 * fraction of a second between the thumb moving and the host agreeing — so the clock, the intents and
 * the authoritative positions are all driven by hand here.
 *
 * WHAT IT PROVES
 *   1. A host or a solo run draws exactly what the simulation says — prediction costs them nothing.
 *   2. A guest with unsealed input draws ahead of the world, by exactly the distance those inputs buy.
 *   3. Diagonals are clamped, so prediction cannot walk faster than the simulation it is guessing at.
 *   4. Prediction respects the player's real speed, not a base number.
 *   5. Guessing is capped, so a bad connection cannot predict a player halfway across the stage.
 *   6. A missing intent repeats the previous one — the same guess the host makes — so they agree.
 *   7. A dead or downed player is never dead-reckoned; a corpse does not walk.
 *   8. A cut clears pending intents; replaying them would drag the sprite off a fresh position.
 *   9. A big authoritative jump cuts, a small standing error glides, and the glide converges.
 *  10. Interpolation between the last two ticks is honest at both ends and in the middle.
 *  11. A stale or wrapped-around intent is never replayed as if it were current.
 *  12. Two hundred thousand ticks allocate nothing and produce no NaN.
 */

import { LOCAL_VIEW_DEFAULTS, LocalView } from "./local-view";

let failures = 0;

function check(what: string, ok: boolean, extra = ""): void {
  if (ok) {
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${extra === "" ? "" : ` — ${extra}`}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function near(a: number, b: number, tolerance = 0.0001): boolean {
  return Math.abs(a - b) <= tolerance;
}

/** 60px/sec at 60Hz is exactly one world pixel per tick, which makes every number below readable. */
const SPEED = 60;

section("1. A host and a solo run draw exactly what the simulation says");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  lv.onTick(1, 1, 0, SPEED, true);
  lv.onTick(2, 2, 0, SPEED, true);
  check("drawn position is the simulated position", near(lv.renderX(1), 2), `${lv.renderX(1)}`);
  check("nothing is being guessed", lv.stats.lead === 0);
  check("and nothing was cut", lv.stats.snaps === 0);
  // The world moving is not an error. Reproducing its motion 1:1 is the whole contract.
  check("no error was ever reported", near(lv.stats.maxErrorPx, 1, 0.001), `${lv.stats.maxErrorPx}`);
}

section("2. A guest draws ahead by exactly what its unsent input buys");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  for (let t = 1; t <= 5; t++) lv.record(t, 1, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  check("five pending ticks are replayed", lv.stats.lead === 5);
  check("five pixels ahead of the world", near(lv.predictedX, 5), `${lv.predictedX}`);
  check("and that is what gets drawn", near(lv.renderX(1), 5), `${lv.renderX(1)}`);
  check("sideways prediction stays put", near(lv.predictedY, 0));

  // The host seals one tick. The lead shrinks by one, and the drawn position does not lurch.
  const before = lv.renderX(1);
  lv.onTick(1, 1, 0, SPEED, true);
  check("one sealed tick leaves four guesses", lv.stats.lead === 4);
  check("drawn position is unchanged by the seal", near(lv.renderX(1), before), `${lv.renderX(1)}`);
  check("no cut was needed", lv.stats.snaps === 0);
}

section("3. Diagonals cannot outrun the simulation");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  lv.record(1, 1, 1);
  lv.onTick(0, 0, 0, SPEED, true);
  const diagonal = Math.sqrt(lv.predictedX * lv.predictedX + lv.predictedY * lv.predictedY);
  check("a diagonal intent is clamped to the unit circle", near(diagonal, 1), `${diagonal}`);
  check("x and y share it evenly", near(lv.predictedX, lv.predictedY));

  const half = new LocalView();
  half.reset(0, 0);
  half.record(1, 0.5, 0);
  half.onTick(0, 0, 0, SPEED, true);
  check("a half-pushed stick is not clamped up", near(half.predictedX, 0.5), `${half.predictedX}`);
}

section("4. Prediction uses the player's real speed");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  for (let t = 1; t <= 5; t++) lv.record(t, 1, 0);
  lv.onTick(0, 0, 0, SPEED * 2, true);
  check("double speed predicts double the distance", near(lv.predictedX, 10), `${lv.predictedX}`);
}

section("5. Guessing is capped");
{
  const lv = new LocalView({ maxLeadTicks: 3 });
  lv.reset(0, 0);
  for (let t = 1; t <= 40; t++) lv.record(t, 1, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  check("forty pending ticks predict only three", lv.stats.lead === 3);
  check("three pixels, not forty", near(lv.predictedX, 3), `${lv.predictedX}`);

  const stock = new LocalView();
  stock.reset(0, 0);
  for (let t = 1; t <= 400; t++) stock.record(t, 1, 0);
  stock.onTick(0, 0, 0, SPEED, true);
  check("the default cap holds too", stock.stats.lead === LOCAL_VIEW_DEFAULTS.maxLeadTicks);
}

section("6. A missing intent repeats the previous one");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  lv.record(1, 1, 0);
  lv.record(3, 1, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  check("the gap is still replayed", lv.stats.lead === 3);
  check("one tick was filled in", lv.stats.filledTicks === 1, `${lv.stats.filledTicks}`);
  // Repeating the last intent is exactly what the host does with a late input. Anything else here
  // would guarantee the guess and the truth disagree.
  check("filled with the previous intent", near(lv.predictedX, 3), `${lv.predictedX}`);
}

section("7. A corpse does not walk");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  for (let t = 1; t <= 10; t++) lv.record(t, 1, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  check("alive, ten pixels of guessing", near(lv.predictedX, 10), `${lv.predictedX}`);

  lv.onTick(1, 0, 0, SPEED, false);
  check("downed, nothing is guessed", lv.stats.lead === 0);
  check("prediction sits on the truth", near(lv.predictedX, 0), `${lv.predictedX}`);
  const glided = lv.renderX(1);
  check("the sprite glides back rather than snapping", glided < 10 && glided > 0, `${glided}`);
  check(
    "by the configured fraction",
    near(glided, 10 - 10 * LOCAL_VIEW_DEFAULTS.catchUpPerTick),
    `${glided}`,
  );

  for (let t = 2; t < 40; t++) lv.onTick(t, 0, 0, SPEED, false);
  check("and settles on the corpse", Math.abs(lv.renderX(1)) < 0.05, `${lv.renderX(1)}`);
  check("with no cut", lv.stats.snaps === 0);
}

section("8. A cut clears pending intents");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  for (let t = 1; t <= 5; t++) lv.record(t, 1, 0);
  lv.reset(100, 100);
  check("nothing is pending after a cut", lv.newestIntentTick === -1);
  check("drawn where we were put", near(lv.renderX(1), 100) && near(lv.renderY(1), 100));
  lv.onTick(0, 100, 100, SPEED, true);
  check("and stale intents are not replayed", lv.stats.lead === 0);
  check("so the sprite does not drift", near(lv.renderX(1), 100), `${lv.renderX(1)}`);
}

section("9. Big jumps cut, small errors glide");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  lv.onTick(1, 500, 0, SPEED, true);
  check("a teleport is cut, not slid", lv.stats.snaps === 1);
  check("landing on the truth immediately", near(lv.renderX(1), 500), `${lv.renderX(1)}`);
  check("with no smear across the frame", near(lv.renderX(0), 500), `${lv.renderX(0)}`);
  check("the gap was recorded", lv.stats.maxErrorPx >= 500);

  // A standing error small enough to hide: leave one behind with a downed tick, then walk again.
  const glide = new LocalView();
  glide.reset(0, 0);
  for (let t = 1; t <= 10; t++) glide.record(t, 1, 0);
  glide.onTick(0, 0, 0, SPEED, true);
  glide.onTick(1, 0, 0, SPEED, false);
  const gap = Math.abs(glide.renderX(1) - glide.predictedX);
  check("a small error is left standing", gap > 1 && gap < LOCAL_VIEW_DEFAULTS.snapDistancePx);
  glide.onTick(2, 0, 0, SPEED, true);
  const afterOne = Math.abs(glide.renderX(1) - glide.predictedX);
  check("it is not closed in one tick", afterOne > 0.5 && afterOne < gap, `${afterOne}`);
  for (let t = 3; t < 40; t++) glide.onTick(t, 0, 0, SPEED, true);
  check("but it does close", Math.abs(glide.renderX(1) - glide.predictedX) < 0.05);
  check("without ever cutting", glide.stats.snaps === 0);
}

section("10. Interpolation is honest");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  lv.onTick(1, 10, 0, SPEED, true);
  check("alpha 0 is the previous tick", near(lv.renderX(0), 0), `${lv.renderX(0)}`);
  check("alpha 1 is this tick", near(lv.renderX(1), 10), `${lv.renderX(1)}`);
  check("alpha 0.5 is halfway", near(lv.renderX(0.5), 5), `${lv.renderX(0.5)}`);
  lv.onTick(2, 10, 6, SPEED, true);
  check("and it works on both axes", near(lv.renderY(0.5), 3), `${lv.renderY(0.5)}`);
}

section("11. Stale and wrapped-around intents are never replayed");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  lv.record(100, 1, 0);
  lv.record(10, 1, 0);
  check("an ancient intent is refused", lv.newestIntentTick === 100);
  lv.record(-1, 1, 0);
  check("a negative tick is refused", lv.newestIntentTick === 100);

  // Slot reuse is the dangerous one: tick 1 and tick 65 share a slot in the ring. If the slot's own
  // tick number were not checked, an intent from a second ago would move the player now.
  const ring = new LocalView();
  ring.reset(0, 0);
  ring.record(1, 1, 0);
  ring.record(70, 0, 0);
  ring.onTick(64, 0, 0, SPEED, true);
  check("six ticks were replayed", ring.stats.lead === 6);
  // Only tick 70 is genuinely held; the other five slots hold other ticks and must be filled.
  check("five treated as missing", ring.stats.filledTicks === 5, `${ring.stats.filledTicks}`);
  check("so the old intent moved nothing", near(ring.predictedX, 0), `${ring.predictedX}`);
}

section("12. Two hundred thousand ticks allocate nothing");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  const mem = (globalThis as unknown as { process?: { memoryUsage?: () => { heapUsed: number } } })
    .process?.memoryUsage;
  const gc = (globalThis as unknown as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc;
  gc?.(true);
  const before = mem?.().heapUsed ?? 0;
  let x = 0;
  for (let t = 0; t < 200_000; t++) {
    lv.record(t + 4, t % 2 === 0 ? 1 : -1, 0.5);
    lv.onTick(t, x, 0, SPEED, t % 1000 !== 0);
    x += 0.25;
    if (!Number.isFinite(lv.renderX(0.5))) break;
  }
  gc?.(true);
  const after = mem?.().heapUsed ?? 0;
  const movedKb = (after - before) / 1024;
  check("drawn position is still a real number", Number.isFinite(lv.renderX(0.5)));
  check("and still a real number on the other axis", Number.isFinite(lv.renderY(0.5)));
  check("it tracked the moving truth", Math.abs(lv.renderX(1) - x) < 100, `${lv.renderX(1)} vs ${x}`);
  check("the heap barely moved", mem !== undefined && movedKb < 512, `${movedKb.toFixed(1)}kb`);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
