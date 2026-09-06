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

/**
 * Apply one authoritative tick and then step the drawn glide once. This mirrors the steady case —
 * one confirmed tick arriving per render frame — and is what every "steady walk" assertion below is
 * written against. The split matters because the render-clock glide (`advance`) is deliberately
 * decoupled from the authoritative-clock prediction (`onTick`): a guest applies a bursty count of
 * confirmed ticks per frame, and gliding the sprite on that bursty clock is the jitter this file
 * removes. Where a test needs a burst (several `onTick` in one frame) or a starved frame (an
 * `advance` with no `onTick`) it drives them by hand.
 */
function tickThenAdvance(
  lv: LocalView,
  tick: number,
  authX: number,
  authY: number,
  speed: number,
  alive: boolean,
): void {
  lv.onTick(tick, authX, authY, speed, alive);
  lv.advance();
}

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
  // A steady walk with no pending input: one confirmed tick per frame, target on the truth. The glide
  // closes the one-pixel-per-tick step and, with nothing pending, converges to the simulated position.
  for (let t = 0; t <= 40; t++) tickThenAdvance(lv, t, t, 0, SPEED, true);
  check("drawn position is the simulated position", near(lv.renderX(1), 40, 0.01), `${lv.renderX(1)}`);
  check("nothing is being guessed", lv.stats.lead === 0);
  check("and nothing was cut", lv.stats.snaps === 0);
  // The world moving is not an error. Reproducing its motion 1:1 is the whole contract — the only gap
  // ever seen is the single pixel between ticks that the glide is mid-closing.
  check("no error above a pixel was ever reported", lv.stats.maxErrorPx <= 1.001, `${lv.stats.maxErrorPx}`);
}

section("2. A guest draws ahead by exactly what its unsent input buys");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  for (let t = 1; t <= 5; t++) lv.record(t, 1, 0);
  lv.onTick(0, 0, 0, SPEED, true);
  check("five pending ticks are replayed", lv.stats.lead === 5);
  check("five pixels ahead of the world", near(lv.predictedX, 5), `${lv.predictedX}`);
  check("sideways prediction stays put", near(lv.predictedY, 0));
  // The drawn sprite glides onto that target over a few render frames rather than teleporting to it —
  // the target is five pixels out, so give the glide time to arrive.
  for (let i = 0; i < 60; i++) lv.advance();
  check("and that is what gets drawn once the glide settles", near(lv.renderX(1), 5, 0.01), `${lv.renderX(1)}`);

  // The host seals one tick. The lead shrinks by one; the drawn position stays where it settled because
  // the confirmed truth plus the four remaining guesses is the same five pixels out.
  const before = lv.renderX(1);
  lv.onTick(1, 1, 0, SPEED, true);
  lv.advance();
  check("one sealed tick leaves four guesses", lv.stats.lead === 4);
  check("drawn position is unchanged by the seal", near(lv.renderX(1), before, 0.001), `${lv.renderX(1)}`);
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
  // Let the drawn sprite catch up to the live prediction before the player is downed. The glide settles
  // within the deadzone of the target — a sub-pixel gap it is right to leave alone — not exactly on it.
  for (let i = 0; i < 60; i++) lv.advance();
  check("drawn out on the prediction", near(lv.renderX(1), 10, LOCAL_VIEW_DEFAULTS.deadzonePx), `${lv.renderX(1)}`);

  const beforeDown = lv.renderX(1);
  lv.onTick(1, 0, 0, SPEED, false);
  check("downed, nothing is guessed", lv.stats.lead === 0);
  check("prediction sits on the truth", near(lv.predictedX, 0), `${lv.predictedX}`);
  lv.advance();
  const glided = lv.renderX(1);
  check("the sprite glides back rather than snapping", glided < beforeDown && glided > 0, `${glided}`);
  check(
    "by the configured fraction of the standing gap",
    near(glided, beforeDown - beforeDown * LOCAL_VIEW_DEFAULTS.catchUpPerTick, 0.01),
    `${glided}`,
  );

  for (let t = 2; t < 60; t++) {
    lv.onTick(t, 0, 0, SPEED, false);
    lv.advance();
  }
  check(
    "and settles onto the corpse within the deadzone",
    Math.abs(lv.renderX(1)) <= LOCAL_VIEW_DEFAULTS.deadzonePx,
    `${lv.renderX(1)}`,
  );
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
  tickThenAdvance(lv, 0, 100, 100, SPEED, true);
  check("and stale intents are not replayed", lv.stats.lead === 0);
  check("so the sprite does not drift", near(lv.renderX(1), 100), `${lv.renderX(1)}`);
}

section("9. Big jumps cut, small errors glide");
{
  const lv = new LocalView();
  lv.reset(0, 0);
  tickThenAdvance(lv, 0, 0, 0, SPEED, true);
  tickThenAdvance(lv, 1, 500, 0, SPEED, true);
  check("a teleport is cut, not slid", lv.stats.snaps === 1);
  check("landing on the truth immediately", near(lv.renderX(1), 500), `${lv.renderX(1)}`);
  check("with no smear across the frame", near(lv.renderX(0), 500), `${lv.renderX(0)}`);
  check("the gap was recorded", lv.stats.maxErrorPx >= 500);

  // A standing error small enough to hide: leave one behind by walking out on prediction, then downing
  // the player so the target drops back to the truth while the drawn sprite is still out ahead of it.
  const glide = new LocalView();
  glide.reset(0, 0);
  for (let t = 1; t <= 10; t++) glide.record(t, 1, 0);
  glide.onTick(0, 0, 0, SPEED, true);
  for (let i = 0; i < 40; i++) glide.advance();
  glide.onTick(1, 0, 0, SPEED, false);
  const gap = Math.abs(glide.renderX(1) - glide.predictedX);
  check("a small error is left standing", gap > 1 && gap < LOCAL_VIEW_DEFAULTS.snapDistancePx, `${gap}`);
  glide.advance();
  const afterOne = Math.abs(glide.renderX(1) - glide.predictedX);
  check("it is not closed in one step", afterOne > 0.5 && afterOne < gap, `${afterOne}`);
  for (let i = 0; i < 80; i++) glide.advance();
  check(
    "but it does close to within the deadzone",
    Math.abs(glide.renderX(1) - glide.predictedX) <= LOCAL_VIEW_DEFAULTS.deadzonePx,
    `${glide.renderX(1)}`,
  );
  check("without ever cutting", glide.stats.snaps === 0);
}

section("10. Interpolation is honest");
{
  // A cut puts the sprite exactly on a fresh position with no segment to interpolate along, then two
  // render steps toward two new far-apart targets give a clean, honest prev→cur segment to read across.
  // The glide closes the whole gap in one step for a target beyond the deadzone, because the snap on
  // the first tick lands prev and cur together and each subsequent target is reached fractionally — so
  // to get an exact 0/10 segment the targets themselves are placed by snapping.
  const lv = new LocalView({ catchUpPerTick: 1 });
  lv.reset(0, 0);
  tickThenAdvance(lv, 0, 0, 0, SPEED, true);
  tickThenAdvance(lv, 1, 10, 0, SPEED, true);
  check("alpha 0 is the previous tick", near(lv.renderX(0), 0), `${lv.renderX(0)}`);
  check("alpha 1 is this tick", near(lv.renderX(1), 10), `${lv.renderX(1)}`);
  check("alpha 0.5 is halfway", near(lv.renderX(0.5), 5), `${lv.renderX(0.5)}`);
  tickThenAdvance(lv, 2, 10, 6, SPEED, true);
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
    // Bursts and starved frames: some iterations advance the render glide twice, some not at all, so
    // the zero-allocation guarantee has to hold under the real two-clock cadence, not a tidy 1:1.
    if (t % 3 !== 0) lv.advance();
    if (t % 7 === 0) lv.advance();
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

section("13. The glide runs on the render clock, not the applied-tick clock");
{
  // This is the fix for the reported bug: the local player jittering the whole time on a guest while
  // the crowd is smooth. A guest applies a bursty count of confirmed ticks per render frame — zero on
  // one frame, two or three on the next — so `onTick` fires in clumps. The drawn sprite must NOT move
  // in those clumps; it must move once per render step (`advance`) so it shares the crowd's and the
  // camera's clock. If the glide moved inside `onTick`, a starved frame would freeze the sprite and a
  // burst frame would lurch it — which is exactly the jitter.
  const lv = new LocalView({ catchUpPerTick: 1 });
  lv.reset(0, 0);
  // Prime a settled position.
  tickThenAdvance(lv, 0, 0, 0, SPEED, true);

  // Starved frame: several render steps with NO new confirmed tick. The target is unchanged, so the
  // drawn position must hold perfectly still — no drift, no freeze-then-jump.
  const held = lv.renderX(1);
  lv.advance();
  lv.advance();
  check("a frame with no applied tick does not move the sprite", near(lv.renderX(1), held), `${lv.renderX(1)}`);

  // Burst frame: two confirmed ticks applied inside one render frame. `onTick` fires twice — moving
  // only the target — and the sprite does NOT move until the single `advance` that follows. That is the
  // whole point: the drawn motion is paced by render steps, not by how many ticks happened to pump this
  // frame, so a burst frame and a steady frame draw the same per-step motion instead of lurching.
  const beforeBurst = lv.renderX(1);
  lv.onTick(1, 1, 0, SPEED, true);
  lv.onTick(2, 2, 0, SPEED, true);
  check("two applied ticks move only the target, not the sprite", near(lv.renderX(1), beforeBurst), `${lv.renderX(1)}`);
  check("the target reflects both applied ticks", near(lv.predictedX, 2), `${lv.predictedX}`);
  lv.advance();
  check("the render step that follows moves the sprite once", lv.renderX(1) > beforeBurst, `${lv.renderX(1)}`);

  // Two render steps that each see one applied tick draw the same total motion as one render step that
  // sees a two-tick burst — the sprite's pace is a function of render steps, not pump bursts. This is
  // what keeps the local player as smooth as the crowd, which is sampled on the very same render clock.
  const steady = new LocalView({ catchUpPerTick: 1 });
  steady.reset(0, 0);
  tickThenAdvance(steady, 0, 0, 0, SPEED, true);
  tickThenAdvance(steady, 1, 1, 0, SPEED, true);
  tickThenAdvance(steady, 2, 2, 0, SPEED, true);
  const burst = new LocalView({ catchUpPerTick: 1 });
  burst.reset(0, 0);
  tickThenAdvance(burst, 0, 0, 0, SPEED, true);
  burst.onTick(1, 1, 0, SPEED, true);
  burst.onTick(2, 2, 0, SPEED, true);
  burst.advance();
  burst.advance();
  check("burst and steady reach the same drawn position", near(steady.renderX(1), burst.renderX(1)), `${steady.renderX(1)} vs ${burst.renderX(1)}`);
}

section("14. A sub-pixel disagreement is left alone, not chased into a shimmer");
{
  // The other half of the fix: even on the render clock the dead-reckoned target breathes by a fraction
  // of a pixel as `lead` rises and falls with the confirm cadence. Chasing that fraction every frame is
  // itself a visible shimmer. A gap under `deadzonePx` must not move the sprite at all.
  // Drive the target to a sub-deadzone offset via one tiny pending intent. At SPEED (1px/tick) a stick
  // of 0.4*deadzone buys a 0.2px lead — under the 0.5px deadzone. The sprite tracks the target's motion
  // once (it moved, so we move with it) and then must HOLD dead still: it may not hunt around the truth
  // frame after frame as the target breathes, because that hunting is the jitter.
  const tiny = new LocalView();
  tiny.reset(0, 0);
  tiny.record(1, 0.4 * LOCAL_VIEW_DEFAULTS.deadzonePx, 0);
  tiny.onTick(0, 0, 0, SPEED, true);
  tiny.advance();
  const settledAt = tiny.renderX(1);
  for (let i = 0; i < 30; i++) tiny.advance();
  check("a settled sub-pixel gap never moves the sprite again", near(tiny.renderX(1), settledAt), `${tiny.renderX(1)}`);
  check("and it is never counted as a cut", tiny.stats.snaps === 0);

  // A gap just ABOVE the deadzone still closes, so a real standing error is not ignored.
  const real = new LocalView();
  real.reset(0, 0);
  real.record(1, 1, 0);
  real.record(2, 1, 0);
  real.onTick(0, 0, 0, SPEED, true); // target ~2px out, well above the 0.5px deadzone
  const startGap = Math.abs(real.renderX(1) - real.predictedX);
  for (let i = 0; i < 80; i++) real.advance();
  const endGap = Math.abs(real.renderX(1) - real.predictedX);
  check(
    "a gap above the deadzone glides closed to within the deadzone",
    endGap < startGap && endGap <= LOCAL_VIEW_DEFAULTS.deadzonePx,
    `${endGap}`,
  );
}

section("15. A bursty confirm cadence draws smooth motion, not a stutter");
{
  // This is the residual-jitter fix (item 3, "not as bad but still jitters"). Decoupling the glide onto
  // the render clock (section 13) stopped the sprite moving *inside* `onTick`, but one lurch survived:
  // `advance` fed the target's whole motion since the last render step forward at once. A guest applies
  // a bursty count of confirmed ticks per render frame — the classic [0,0,3,0,1,2] pattern below — so
  // on the 3-tick frame the target jumped 3px and the old code drew all 3px in that one render step,
  // then drew ~0 on the starved frames around it. The underlying walk is perfectly steady (1px/tick),
  // yet the drawn motion stuttered fast-slow-fast at the confirm cadence. That is the jitter.
  //
  // The fix caps the feed-forward at one sim-tick of motion per render step and banks the rest, so a
  // three-tick burst is paid out over the render steps that follow. We drive that exact cadence here,
  // walking a straight line with no pending intent (so `predX` is the authoritative truth and the
  // feed-forward path is what is under test, not the dead-reckoning), sample the drawn position once
  // per render frame, and assert the per-frame displacement is smooth: bounded frame-to-frame jerk (the
  // second difference) and never a lurch of more than about one tick, with no overshoot past the truth.
  const cadence = [0, 0, 3, 0, 1, 2]; // applied ticks per render frame; sums to one tick/frame on average
  const lv = new LocalView();
  lv.reset(0, 0);

  // Warm the glide up to a steady 1px/tick walk over a few clean ticks so the cap has settled before we
  // start measuring — we are testing the burst response of an established walk, not the cold start.
  let tick = 0;
  let authX = 0;
  for (let i = 0; i < 20; i++) {
    tick++;
    authX += 1;
    lv.onTick(tick, authX, 0, SPEED, true);
    lv.advance();
  }

  // Now run the bursty cadence for many cycles, sampling the drawn X once per render frame (`renderX(1)`
  // is the end-of-step drawn position, which is what the frame shows). The truth keeps advancing 1px
  // per applied tick throughout, at a constant rate — only the *grouping* of ticks into frames is
  // bursty, exactly as a real guest's `pump()` delivers them.
  const drawn: number[] = [];
  for (let cycle = 0; cycle < 40; cycle++) {
    for (const applied of cadence) {
      for (let k = 0; k < applied; k++) {
        tick++;
        authX += 1;
        lv.onTick(tick, authX, 0, SPEED, true);
      }
      lv.advance();
      drawn.push(lv.renderX(1));
    }
  }

  check("the bursty walk never had to cut", lv.stats.snaps === 0, `snaps ${lv.stats.snaps}`);

  // Per-frame drawn displacement, and its frame-to-frame change (jerk). Skip the first couple of cycles
  // so the measurement is of the steady-state burst response, not the transient as the pending settles.
  const skip = cadence.length * 3;
  const disp: number[] = [];
  for (let i = skip + 1; i < drawn.length; i++) disp.push(drawn[i] - drawn[i - 1]);

  let maxDisp = 0;
  let maxJerk = 0;
  let minDisp = Infinity;
  for (let i = 0; i < disp.length; i++) {
    if (disp[i] > maxDisp) maxDisp = disp[i];
    if (disp[i] < minDisp) minDisp = disp[i];
    if (i > 0) {
      const jerk = Math.abs(disp[i] - disp[i - 1]);
      if (jerk > maxJerk) maxJerk = jerk;
    }
  }

  // The average frame draws exactly one tick of motion (one applied tick per frame on average), and the
  // fix holds every frame close to that instead of the old [~0,~0,~3,~0,~1,~2] stutter. A single tick is
  // 1px at SPEED; allow a little headroom for the glide easing the banked remainder out.
  check("no frame lurches more than about one tick of motion", maxDisp <= 1.5, `maxDisp ${maxDisp.toFixed(3)}`);
  // The drawn sprite always moves forward on a forward walk — never stalls dead and never reverses.
  check("the sprite never stalls or reverses on a starved frame", minDisp > 0.3, `minDisp ${minDisp.toFixed(3)}`);
  // Frame-to-frame jerk stays small: this is the number the eye reads as smoothness. The old code hit a
  // jerk of ~3px (a 3px burst frame next to a 0px starved one); the fix keeps it well under a tick.
  check("frame-to-frame jerk stays small (smooth motion)", maxJerk <= 0.75, `maxJerk ${maxJerk.toFixed(3)}`);
  // And there is no overshoot: the drawn position never runs past the authoritative truth on a straight
  // walk — a rate limiter that over-released would sail ahead and then get pulled back, an oscillation.
  const finalGap = drawn[drawn.length - 1] - authX;
  check("no overshoot past the truth", finalGap <= 0.75, `finalGap ${finalGap.toFixed(3)}`);
  check("and it keeps near-zero lag behind the truth", finalGap >= -2, `finalGap ${finalGap.toFixed(3)}`);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
