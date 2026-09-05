/**
 * Checks on the chest opening sequence.
 *
 * This is an animation, so the temptation is to say it can only be judged by watching it. Most of it
 * can't. The parts that actually go wrong are arithmetic: a counter that shows more gold than the player
 * has, a beat that quietly runs backwards, a card that can be tapped away before it has arrived, a
 * scatter that comes out different on two phones watching the same run. All of those are checkable, and
 * all of them are invisible in a screen recording.
 *
 * The rule the whole file leans on: ask the sequence what a given moment looks like, twice, and it must
 * answer the same thing. Nothing here keeps state between frames, so nothing here can drift.
 */

import {
  ALPHA_MAX,
  BEAT,
  CARD_TRAVEL,
  LIGHT_HEIGHT,
  LIGHT_WIDTH,
  RIBBON_RADIUS,
  RIBBON_TURNS,
  SEQUENCE_SECONDS,
  SPARK_COUNT,
  SPARK_GRAVITY,
  SPARK_SPEED_MAX,
  SPARK_SPEED_MIN,
  alphaOf,
  beatFaults,
  cardDismissable,
  chestOpenAt,
  createChestOpenFrame,
  createChestOpenSpec,
  createSpark,
  easeIn,
  easeOut,
  goldAt,
  hashUnit,
  progress,
  pulse,
  sparkAt,
  sparkHash,
  sparkThrow,
  createSparkThrow,
} from "./chest-open";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function spec(over: Partial<ReturnType<typeof createChestOpenSpec>> = {}) {
  return { ...createChestOpenSpec(), x: 500, y: 500, seed: 12345, ...over };
}

// ---------------------------------------------------------------------------------------------
// 1. The beats themselves.
//
// Two beats swapped by accident still animate. It simply looks wrong, which is the hardest kind of
// fault to find by looking — so the ordering is stated as rules rather than left to the numbers.
// ---------------------------------------------------------------------------------------------
{
  const faults = beatFaults();
  check("the beats are in a sane order", faults.length === 0, faults.join("; "));

  check("the sequence ends when the card has landed", SEQUENCE_SECONDS === BEAT.cardEnd, `${SEQUENCE_SECONDS}`);
  // A phone fight does not stop while this plays. Anything longer than a few seconds is a player
  // standing still being hit by things they cannot see.
  check("the whole thing is short", SEQUENCE_SECONDS > 1 && SEQUENCE_SECONDS <= 3, `${SEQUENCE_SECONDS}`);

  // Overlap is the point. If every beat waited for the last one the sequence would be twice as long.
  check("the spray starts before the light is done", BEAT.sprayStart < BEAT.lightEnd);
  check("the count starts before the spray is done", BEAT.countStart < BEAT.sprayEnd);
  check("the ribbon is still going when the count ends", BEAT.ribbonEnd > BEAT.countEnd);
}

// ---------------------------------------------------------------------------------------------
// 2. The small maths helpers.
//
// Everything else is built out of these four, so a fault in one of them is a fault in all seven beats
// at once. They are also the only things in the file that get handed junk — a phone that stalls hands
// in a `t` nobody planned for.
// ---------------------------------------------------------------------------------------------
{
  check("progress before the window is zero", progress(0.1, 0.5, 1.0) === 0);
  check("progress at the open is zero", progress(0.5, 0.5, 1.0) === 0);
  check("progress halfway is a half", Math.abs(progress(0.75, 0.5, 1.0) - 0.5) < 1e-9);
  check("progress at the shut is one", progress(1.0, 0.5, 1.0) === 1);
  check("progress after the shut stays one", progress(9, 0.5, 1.0) === 1);
  check("progress of junk time reads as not started", progress(Number.NaN, 0, 1) === 0);
  check("a zero-width window is done or not, never a divide", progress(1, 1, 1) === 1);
  check("a zero-width window before its moment is zero", progress(0, 1, 1) === 0);

  // progress must never leave 0..1, whatever it is handed.
  let inRange = true;
  for (let i = -30; i <= 60; i++) {
    const p = progress(i / 10, 0.5, 2);
    if (!(p >= 0 && p <= 1)) inRange = false;
  }
  check("progress never leaves nought to one", inRange);

  check("ease out is pinned at both ends", easeOut(0) === 0 && easeOut(1) === 1);
  check("ease out is ahead of straight-line", easeOut(0.5) > 0.5, `${easeOut(0.5)}`);
  check("ease in is pinned at both ends", easeIn(0) === 0 && easeIn(1) === 1);
  check("ease in is behind straight-line", easeIn(0.5) < 0.5, `${easeIn(0.5)}`);
  check("ease out clamps past the end", easeOut(4) === 1 && easeOut(-4) === 0);
  check("ease in clamps past the end", easeIn(4) === 1 && easeIn(-4) === 0);

  let easeRises = true;
  let easeInRises = true;
  for (let i = 1; i <= 100; i++) {
    if (easeOut(i / 100) < easeOut((i - 1) / 100)) easeRises = false;
    if (easeIn(i / 100) < easeIn((i - 1) / 100)) easeInRises = false;
  }
  check("ease out only ever rises", easeRises);
  check("ease in only ever rises", easeInRises);

  check("a pulse is out at both ends", pulse(0) === 0 && pulse(1) === 0);
  check("a pulse peaks in the middle", Math.abs(pulse(0.5) - 1) < 1e-9, `${pulse(0.5)}`);
  check("a pulse is symmetric", Math.abs(pulse(0.25) - pulse(0.75)) < 1e-9);
  check("a pulse outside its window is nothing", pulse(-1) === 0 && pulse(2) === 0);

  check("alpha is a whole number", Number.isInteger(alphaOf(0.333)));
  check("alpha tops out", alphaOf(1) === ALPHA_MAX && alphaOf(5) === ALPHA_MAX);
  check("alpha bottoms out", alphaOf(0) === 0 && alphaOf(-3) === 0);
  check("alpha of junk is nothing", alphaOf(Number.NaN) === 0);
  let alphaInRange = true;
  for (let i = -10; i <= 130; i++) {
    const a = alphaOf(i / 100);
    if (!(Number.isInteger(a) && a >= 0 && a <= ALPHA_MAX)) alphaInRange = false;
  }
  check("alpha never leaves nought to two-five-five", alphaInRange);
}

// ---------------------------------------------------------------------------------------------
// 3. The scatter is the same on every phone.
//
// `Math.random` is banned under game/ because two players watching the same co-op chest have to see the
// same chest. The scatter comes from hashing the spark's own number instead, so the check is that it is
// repeatable, spread out, and actually different for different sparks.
// ---------------------------------------------------------------------------------------------
{
  check("the hash repeats itself", sparkHash(7, 99) === sparkHash(7, 99));
  check("a different spark hashes differently", sparkHash(7, 99) !== sparkHash(8, 99));
  check("a different run hashes differently", sparkHash(7, 99) !== sparkHash(7, 100));

  let whole = true;
  let unsigned = true;
  for (let i = 0; i < 200; i++) {
    const h = sparkHash(i, 5);
    if (!Number.isInteger(h)) whole = false;
    if (h < 0) unsigned = false;
  }
  check("every hash is a whole number", whole);
  check("no hash comes out negative", unsigned);

  // The fractions have to actually cover the range. A hash that always lands in the same tenth would
  // pass every check above and throw every coin in one direction.
  const buckets = Array.from<number>({ length: 10 }).fill(0);
  for (let i = 0; i < 400; i++) {
    const u = hashUnit(i, 4242, 1);
    if (!(u >= 0 && u < 1)) failures++;
    const b = Math.min(9, Math.floor(u * 10));
    buckets[b] = (buckets[b] ?? 0) + 1;
  }
  checks++;
  let allBucketsUsed = true;
  for (const b of buckets) if (b < 10) allBucketsUsed = false;
  check("the scatter covers the whole circle", allBucketsUsed, buckets.join(","));

  // Different salts must not agree, or angle and speed would be locked to each other and every coin
  // would fly out in a neat spiral.
  let saltsDiffer = 0;
  for (let i = 0; i < 50; i++) {
    if (hashUnit(i, 7, 1) !== hashUnit(i, 7, 2)) saltsDiffer++;
  }
  check("angle and speed are not the same number", saltsDiffer === 50, `${saltsDiffer}/50`);
}

// ---------------------------------------------------------------------------------------------
// 4. The thrown coins.
//
// The rule that matters: a spark is only ever drawn during its own beat, it leaves the chest rather
// than appearing beside it, and gravity actually wins in the end.
// ---------------------------------------------------------------------------------------------
{
  const s = spec();
  const out = createSpark();

  check("there are coins to throw", SPARK_COUNT > 0 && Number.isInteger(SPARK_COUNT), `${SPARK_COUNT}`);
  check("the speed range is a range", SPARK_SPEED_MAX > SPARK_SPEED_MIN);
  check("gravity pulls downward", SPARK_GRAVITY > 0);

  // Nothing is on screen before the spray beat opens, and nothing is left after it shuts.
  let earlyDrawn = 0;
  let lateDrawn = 0;
  for (let i = 0; i < SPARK_COUNT; i++) {
    if (sparkAt(i, BEAT.sprayStart - 0.01, s, out).alpha > 0) earlyDrawn++;
    if (sparkAt(i, BEAT.sprayEnd + 0.01, s, out).alpha > 0) lateDrawn++;
  }
  check("no coin is out before the chest sprays", earlyDrawn === 0, `${earlyDrawn}`);
  check("no coin is left after the spray", lateDrawn === 0, `${lateDrawn}`);

  // At the very start of the beat only the first few have left; by the middle most have.
  let atStart = 0;
  let atMiddle = 0;
  const mid = (BEAT.sprayStart + BEAT.sprayEnd) / 2;
  for (let i = 0; i < SPARK_COUNT; i++) {
    if (sparkAt(i, BEAT.sprayStart + 0.02, s, out).alpha > 0) atStart++;
    if (sparkAt(i, mid, s, out).alpha > 0) atMiddle++;
  }
  check("the coins leave as a stream, not a ring", atStart < SPARK_COUNT, `${atStart}/${SPARK_COUNT}`);
  check("most coins are out by the middle", atMiddle > SPARK_COUNT / 2, `${atMiddle}/${SPARK_COUNT}`);

  // Each coin leaves the chest. If a coin's furthest point is under a few units it is sitting on the lid.
  let movers = 0;
  let maxDist = 0;
  for (let i = 0; i < SPARK_COUNT; i++) {
    let far = 0;
    for (let step = 0; step <= 40; step++) {
      const t = BEAT.sprayStart + ((BEAT.sprayEnd - BEAT.sprayStart) * step) / 40;
      sparkAt(i, t, s, out);
      if (out.alpha <= 0) continue;
      const d = Math.hypot(out.x - s.x, out.y - s.y);
      if (d > far) far = d;
      if (d > maxDist) maxDist = d;
    }
    if (far > 10) movers++;
  }
  check("every coin actually leaves the chest", movers === SPARK_COUNT, `${movers}/${SPARK_COUNT}`);
  // And none of them ends up on the far side of the level.
  check("no coin is thrown off the map", maxDist < 400, `${maxDist.toFixed(1)}`);

  // Gravity: a coin's upward travel must reverse. Measured on the highest point versus the last point.
  let fellBack = 0;
  let checkedCoins = 0;
  for (let i = 0; i < SPARK_COUNT; i++) {
    let highest = Number.POSITIVE_INFINITY;
    let lastY = Number.NaN;
    for (let step = 0; step <= 60; step++) {
      const t = BEAT.sprayStart + ((BEAT.sprayEnd - BEAT.sprayStart) * step) / 60;
      sparkAt(i, t, s, out);
      if (out.alpha <= 0) continue;
      if (out.y < highest) highest = out.y;
      lastY = out.y;
    }
    if (Number.isFinite(lastY)) {
      checkedCoins++;
      if (lastY > highest) fellBack++;
    }
  }
  check("every coin arcs back down", checkedCoins > 0 && fellBack === checkedCoins, `${fellBack}/${checkedCoins}`);

  // Only three pickup pictures exist. A fourth index draws an empty socket.
  let kindsOk = true;
  const kindsSeen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    sparkAt(i, mid, s, out);
    if (out.alpha <= 0) continue;
    if (!Number.isInteger(out.kind) || out.kind < 0 || out.kind > 2) kindsOk = false;
    kindsSeen.add(out.kind);
  }
  check("coins only use pictures that exist", kindsOk);
  check("all three pictures get used", kindsSeen.size === 3, `${kindsSeen.size}`);

  // Scale is never zero or negative — an invisible or inside-out coin.
  let scalesOk = true;
  for (let i = 0; i < SPARK_COUNT; i++) {
    sparkAt(i, mid, s, out);
    if (!(out.scale > 0 && out.scale < 2)) scalesOk = false;
  }
  check("coins are a sensible size", scalesOk);

  // Coins tumble. A spin that never changes is a coin sliding on ice.
  sparkAt(3, mid, s, out);
  const spinA = out.spin;
  sparkAt(3, mid + 0.2, s, out);
  check("coins tumble as they fly", spinA !== out.spin);

  // Same time, same answer — twice, from a fresh object each way round.
  const a = sparkAt(5, mid, s, createSpark());
  const b = sparkAt(5, mid, s, createSpark());
  check(
    "asking twice gives the same coin",
    a.x === b.x && a.y === b.y && a.alpha === b.alpha && a.kind === b.kind,
  );

  // A different run seed must actually change the throw, or every chest in the game looks identical.
  const other = sparkAt(5, mid, spec({ seed: 999 }), createSpark());
  check("a different run throws differently", other.x !== a.x || other.y !== a.y);
}

// ---------------------------------------------------------------------------------------------
// 5. The gold counter.
//
// Two rules, and both are the kind that a hand-rolled counter breaks: it never shows more than the
// player has, and its last frame is the real total exactly. A counter that lands on 146 when the shop
// says 147 makes the player think the game stole from them.
// ---------------------------------------------------------------------------------------------
{
  const s = spec({ goldFrom: 40, goldTo: 187 });

  check("the counter starts at the old total", goldAt(BEAT.countStart, s) === 40, `${goldAt(BEAT.countStart, s)}`);
  check("the counter lands on the real total", goldAt(BEAT.countEnd, s) === 187, `${goldAt(BEAT.countEnd, s)}`);
  check("the counter stays there afterwards", goldAt(9, s) === 187);
  check("the counter has not started early", goldAt(0, s) === 40);

  let never = true;
  let overshoot = false;
  let whole = true;
  let prev = -1;
  for (let i = 0; i <= 300; i++) {
    const t = (i / 300) * (SEQUENCE_SECONDS + 0.5);
    const g = goldAt(t, s);
    if (g < 40) never = false;
    if (g > 187) overshoot = true;
    if (!Number.isInteger(g)) whole = false;
    if (g < prev) never = false;
    prev = g;
  }
  check("the counter only ever goes up", never);
  check("the counter never shows more than you have", !overshoot);
  check("the counter is always a whole number of coins", whole);

  // A chest that paid nothing must not put a counter on screen at all.
  const none = spec({ goldFrom: 90, goldTo: 90 });
  check("no gold means no counter", goldAt(1, none) === 90);
  const frame = createChestOpenFrame();
  chestOpenAt(1, none, frame);
  check("a chest with no gold hides the counter", !frame.goldVisible);

  // Nonsense input must not produce nonsense output.
  const backwards = spec({ goldFrom: 200, goldTo: 100 });
  check("a shrinking total just shows the new one", goldAt(1, backwards) === 100);
  const negative = spec({ goldFrom: -50, goldTo: -10 });
  check("negative gold reads as none", goldAt(1, negative) >= 0);
}

// ---------------------------------------------------------------------------------------------
// 6. The frame as a whole.
//
// Every beat is checked at three moments: before it opens, at its peak, and after it shuts. "After it
// shuts" is the one that catches real faults — an effect that never turns itself off sits on the screen
// for the rest of the run.
// ---------------------------------------------------------------------------------------------
{
  const s = spec({ goldFrom: 0, goldTo: 120, rows: 2 });
  const f = createChestOpenFrame();

  chestOpenAt(-1, s, f);
  check("nothing is up before the chest opens", !f.active);

  // Light.
  chestOpenAt(BEAT.lightStart + (BEAT.lightEnd - BEAT.lightStart) * 0.5, s, f);
  check("the light is up during its beat", f.lightAlpha > 0 && f.lightHeight > 0);
  check("the light does not overshoot its height", f.lightHeight <= LIGHT_HEIGHT + 1e-9);
  check("the light narrows as it climbs", f.lightWidth < LIGHT_WIDTH);
  chestOpenAt(BEAT.lightEnd + 0.01, s, f);
  check("the light goes out", f.lightAlpha === 0);

  // Ribbon.
  chestOpenAt(BEAT.ribbonStart - 0.01, s, f);
  check("the ribbon is not up early", f.ribbonAlpha === 0);
  chestOpenAt((BEAT.ribbonStart + BEAT.ribbonEnd) / 2, s, f);
  check("the ribbon is up in the middle", f.ribbonAlpha > 0);
  const r = Math.hypot(f.ribbonX - s.x, f.ribbonY - s.y + 10);
  check("the ribbon orbits near the chest", r > 0 && r <= RIBBON_RADIUS + 1e-6, `${r.toFixed(1)}`);
  chestOpenAt(BEAT.ribbonEnd + 0.01, s, f);
  check("the ribbon goes out", f.ribbonAlpha === 0);

  // The ribbon must make its full number of turns, and go round one way only.
  chestOpenAt(BEAT.ribbonEnd, s, f);
  const fullTurn = Math.PI * 2 * RIBBON_TURNS;
  check("the ribbon makes its turns", Math.abs(f.ribbonAngle - fullTurn) < 1e-6, `${f.ribbonAngle.toFixed(3)}`);
  let ribbonForward = true;
  let lastAngle = -1;
  for (let i = 0; i <= 100; i++) {
    chestOpenAt(BEAT.ribbonStart + ((BEAT.ribbonEnd - BEAT.ribbonStart) * i) / 100, s, f);
    if (f.ribbonAngle < lastAngle) ribbonForward = false;
    lastAngle = f.ribbonAngle;
  }
  check("the ribbon never turns back on itself", ribbonForward);

  // Flash.
  chestOpenAt(BEAT.flashStart - 0.01, s, f);
  check("the flash is not up early", f.flashAlpha === 0);
  chestOpenAt((BEAT.flashStart + BEAT.flashEnd) / 2, s, f);
  const plainFlash = f.flashAlpha;
  check("the flash lands", plainFlash > 0);
  chestOpenAt(BEAT.flashEnd + 0.01, s, f);
  check("the flash clears", f.flashAlpha === 0);

  // An evolution is the rarest thing a chest can do, so it gets the bigger flash.
  chestOpenAt((BEAT.flashStart + BEAT.flashEnd) / 2, spec({ evolved: true }), f);
  check("an evolution flashes harder", f.flashAlpha > plainFlash, `${f.flashAlpha} vs ${plainFlash}`);

  // Burst.
  chestOpenAt(BEAT.burstStart - 0.01, s, f);
  check("the burst is not up early", f.burstAlpha === 0);
  chestOpenAt(BEAT.burstStart + 0.05, s, f);
  const smallBurst = f.burstScale;
  const strongBurst = f.burstAlpha;
  chestOpenAt(BEAT.burstEnd - 0.05, s, f);
  check("the burst grows", f.burstScale > smallBurst, `${f.burstScale} vs ${smallBurst}`);
  check("the burst fades as it grows", f.burstAlpha < strongBurst);
  chestOpenAt(BEAT.burstEnd + 0.01, s, f);
  check("the burst clears", f.burstAlpha === 0);

  // Card.
  chestOpenAt(BEAT.cardStart - 0.01, s, f);
  check("the card has not arrived early", f.cardAlpha === 0 && f.cardSlide === 0);
  check("the card starts fully out of place", Math.abs(f.cardOffsetY - CARD_TRAVEL) < 1e-9);
  chestOpenAt(BEAT.cardEnd, s, f);
  check("the card arrives fully", Math.abs(f.cardSlide - 1) < 1e-9);
  check("the card lands in place", Math.abs(f.cardOffsetY) < 1e-9);
  check("the card is fully solid when it lands", f.cardAlpha === ALPHA_MAX);
  chestOpenAt(30, s, f);
  check("the card stays up", f.cardAlpha === ALPHA_MAX && f.cardOffsetY === 0);
  check("the sequence settles", f.settled);

  let cardForward = true;
  let lastSlide = -1;
  for (let i = 0; i <= 100; i++) {
    chestOpenAt((SEQUENCE_SECONDS * i) / 100, s, f);
    if (f.cardSlide < lastSlide) cardForward = false;
    lastSlide = f.cardSlide;
  }
  check("the card never slides backwards", cardForward);
}

// ---------------------------------------------------------------------------------------------
// 7. A stalled phone.
//
// The reason the whole file is a pure function of time. A phone that hangs for half a second arrives
// here with a `t` well past a beat's end, and the sequence has to land where it should be rather than
// replaying what it missed. Compared here: sixty smooth frames against four lumpy ones.
// ---------------------------------------------------------------------------------------------
{
  const s = spec({ goldFrom: 10, goldTo: 300, rows: 3 });
  const smooth = createChestOpenFrame();
  const lumpy = createChestOpenFrame();

  for (let i = 0; i <= 60; i++) chestOpenAt((SEQUENCE_SECONDS * i) / 60, s, smooth);
  for (let i = 0; i <= 4; i++) chestOpenAt((SEQUENCE_SECONDS * i) / 4, s, lumpy);

  check("a stalling phone still ends up in the right place", smooth.cardSlide === lumpy.cardSlide);
  check("a stalling phone still gets the right gold", smooth.goldShown === lumpy.goldShown, `${lumpy.goldShown}`);
  check("a stalling phone still settles", smooth.settled && lumpy.settled);

  // Nothing on the frame is ever junk, at any moment, including silly ones.
  const moments = [-5, -0.001, 0, 0.5, 1.234, SEQUENCE_SECONDS, SEQUENCE_SECONDS + 100, Number.NaN];
  let allFinite = true;
  let allAlphasLegal = true;
  for (const t of moments) {
    chestOpenAt(t, s, smooth);
    const nums = [
      smooth.lightHeight,
      smooth.lightWidth,
      smooth.lightAlpha,
      smooth.goldShown,
      smooth.ribbonAngle,
      smooth.ribbonX,
      smooth.ribbonY,
      smooth.ribbonAlpha,
      smooth.flashAlpha,
      smooth.burstScale,
      smooth.burstAlpha,
      smooth.cardSlide,
      smooth.cardOffsetY,
      smooth.cardAlpha,
    ];
    for (const n of nums) if (!Number.isFinite(n)) allFinite = false;
    for (const a of [smooth.lightAlpha, smooth.ribbonAlpha, smooth.flashAlpha, smooth.burstAlpha, smooth.cardAlpha]) {
      if (!(Number.isInteger(a) && a >= 0 && a <= ALPHA_MAX)) allAlphasLegal = false;
    }
  }
  check("no moment produces a junk number", allFinite);
  check("every alpha is legal at every moment", allAlphasLegal);
}

// ---------------------------------------------------------------------------------------------
// 8. Dismissing the card.
//
// A card that can be tapped away while it is still sliding gets dismissed by the same thumb press that
// walked into the chest, and the player never sees what they got. This is the whole reason the rule
// exists as a function rather than a truthy check on the animation.
// ---------------------------------------------------------------------------------------------
{
  check("the card cannot be dismissed before it arrives", !cardDismissable(BEAT.cardStart));
  check("the card cannot be dismissed mid-slide", !cardDismissable((BEAT.cardStart + BEAT.cardEnd) / 2));
  check("the card cannot be dismissed one frame early", !cardDismissable(BEAT.cardEnd - 0.001));
  check("the card can be dismissed once it lands", cardDismissable(BEAT.cardEnd));
  check("the card can be dismissed later", cardDismissable(60));
  check("junk time cannot dismiss the card", !cardDismissable(Number.NaN));
}

// ---------------------------------------------------------------------------------------------
// 9. Nothing here allocates, and nothing here remembers.
//
// The sequence runs inside the draw loop of a game holding five hundred enemies at sixty frames a
// second. An effect that makes a new object per frame is a stutter two minutes later, when the phone
// stops to tidy up. Both writers fill an object that was handed to them, and hand the same one back.
// ---------------------------------------------------------------------------------------------
{
  const s = spec({ goldFrom: 5, goldTo: 55 });
  const f = createChestOpenFrame();
  const sp = createSpark();
  check("the frame writer hands back what it was given", chestOpenAt(1, s, f) === f);
  check("the spark writer hands back what it was given", sparkAt(2, 1, s, sp) === sp);

  // Running the sequence forwards then jumping back must give the earlier answer again — proof that
  // nothing was kept between frames.
  chestOpenAt(0.4, s, f);
  const early = { ...f };
  for (let i = 0; i <= 50; i++) chestOpenAt(i / 10, s, f);
  chestOpenAt(0.4, s, f);
  let sameAgain = true;
  for (const k of Object.keys(early) as (keyof typeof early)[]) {
    if (f[k] !== early[k]) sameAgain = false;
  }
  check("rewinding gives the same frame back", sameAgain);

  // A fresh spec and a fresh frame must be blank, so a chest never opens showing the last one's gold.
  const blank = createChestOpenSpec();
  check("a fresh chest is blank", blank.x === 0 && blank.goldFrom === 0 && blank.goldTo === 0 && !blank.evolved);
  const blankFrame = createChestOpenFrame();
  check("a fresh frame is blank", !blankFrame.active && blankFrame.cardAlpha === 0 && blankFrame.goldShown === 0);
}

// ---------------------------------------------------------------------------------------------
// 10. The throw itself: direction and force are independent, and cover the circle.
//
// Two faults live here and neither shows up in a still frame. One: every coin leaves in the same
// direction, which looks like a jet rather than a spray. Two: direction and force hashed off the same
// number, so the fast coins all fly one way and the slow ones the other — a spiral. Both were found by
// deliberately breaking the code and noticing the checks above did not care, which is why the throw is
// now a function that can be asked directly instead of arithmetic buried in the drawing.
// ---------------------------------------------------------------------------------------------
{
  const s = spec();
  const th = createSparkThrow();

  check("the throw writer hands back what it was given", sparkThrow(0, s, th) === th);

  // Every direction in the circle gets used. Eight sectors, four hundred coins: an empty sector means
  // there is a direction a coin can never be thrown.
  const sectors = Array.from<number>({ length: 8 }).fill(0);
  let angleInRange = true;
  let speedInRange = true;
  let liftUpward = true;
  let delayInRange = true;
  for (let i = 0; i < 400; i++) {
    sparkThrow(i, s, th);
    if (!(th.angle >= 0 && th.angle < Math.PI * 2)) angleInRange = false;
    if (!(th.speed >= SPARK_SPEED_MIN && th.speed <= SPARK_SPEED_MAX)) speedInRange = false;
    if (!(th.lift > 0 && th.lift <= 1)) liftUpward = false;
    if (!(th.delay >= 0 && th.delay < BEAT.sprayEnd - BEAT.sprayStart)) delayInRange = false;
    const sector = Math.min(7, Math.floor((th.angle / (Math.PI * 2)) * 8));
    sectors[sector] = (sectors[sector] ?? 0) + 1;
  }
  check("every throw angle is inside the circle", angleInRange);
  check("every throw speed is inside its range", speedInRange);
  check("every throw carries some lift", liftUpward);
  check("no coin is delayed past the spray", delayInRange);
  let allSectors = true;
  for (const c of sectors) if (c < 20) allSectors = false;
  check("coins are thrown in every direction", allSectors, sectors.join(","));

  // The real spray — only twenty-eight coins — must still cover more than one side of the chest.
  let left = 0;
  let right = 0;
  let up = 0;
  let down = 0;
  for (let i = 0; i < SPARK_COUNT; i++) {
    sparkThrow(i, s, th);
    if (Math.cos(th.angle) < 0) left++;
    else right++;
    if (Math.sin(th.angle) < 0) up++;
    else down++;
  }
  check("the spray goes both ways across", left >= SPARK_COUNT / 4 && right >= SPARK_COUNT / 4, `${left}/${right}`);
  check("the spray goes both ways up and down", up >= SPARK_COUNT / 4 && down >= SPARK_COUNT / 4, `${up}/${down}`);

  // Direction and force must not be the same decision wearing two hats. Measured as a plain correlation
  // between the two across four hundred coins: independent numbers sit near zero, and two numbers taken
  // off the same hash sit at one.
  let sumA = 0;
  let sumS = 0;
  const angles: number[] = [];
  const speeds: number[] = [];
  for (let i = 0; i < 400; i++) {
    sparkThrow(i, s, th);
    const a = th.angle / (Math.PI * 2);
    const v = (th.speed - SPARK_SPEED_MIN) / (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
    angles.push(a);
    speeds.push(v);
    sumA += a;
    sumS += v;
  }
  const meanA = sumA / angles.length;
  const meanS = sumS / speeds.length;
  let cov = 0;
  let varA = 0;
  let varS = 0;
  for (let i = 0; i < angles.length; i++) {
    const da = (angles[i] ?? 0) - meanA;
    const ds = (speeds[i] ?? 0) - meanS;
    cov += da * ds;
    varA += da * da;
    varS += ds * ds;
  }
  const correlation = cov / Math.sqrt(varA * varS);
  check("direction and force are independent", Math.abs(correlation) < 0.25, correlation.toFixed(3));

  // Same for the stagger: coins that leave last must not also be the fastest.
  let covD = 0;
  let varD = 0;
  let sumD = 0;
  const delays: number[] = [];
  for (let i = 0; i < 400; i++) {
    sparkThrow(i, s, th);
    delays.push(th.delay);
    sumD += th.delay;
  }
  const meanD = sumD / delays.length;
  for (let i = 0; i < delays.length; i++) {
    const dd = (delays[i] ?? 0) - meanD;
    covD += dd * ((speeds[i] ?? 0) - meanS);
    varD += dd * dd;
  }
  const delayCorrelation = covD / Math.sqrt(varD * varS);
  check("when a coin leaves says nothing about how hard", Math.abs(delayCorrelation) < 0.25, delayCorrelation.toFixed(3));

  // And the throw must still be the same on two phones.
  const again = sparkThrow(11, s, createSparkThrow());
  const once = sparkThrow(11, s, createSparkThrow());
  check("the same coin is thrown the same way twice", again.angle === once.angle && again.speed === once.speed);
  const otherRun = sparkThrow(11, spec({ seed: 777 }), createSparkThrow());
  check("a different run throws it differently", otherRun.angle !== once.angle);
}

console.log(`chest-open: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`chest-open: ${failures} check${failures === 1 ? "" : "s"} failed`);
}


const qx_pjgtlrnzgz = ???;
export default [::: qx_rspmhyigck ??? qx_feyhxrggxw :::];
function qx_suuievyaqr(<>) { return qx_fquhqihvsw >>>> @@@; }
function* qx_uzmrmghwnv(??? qx_chjdpcldva) { yield <::: 0x49ca2e87 :::>; }
class qx_clzuvxnrbp extends ###qx_coavyecrcl { ??? qx_ziqjlaobjt !!! }
const qx_qavvsxnjom = qx_amkatjiwim <=> 0xcdf89ec3 ??? qx_dldanccnfa;
const [qx_jzrbdkqsif, , :::] = qx_hllbobbhbi ??! qx_dbhhvrztnj;
let qx_fadqlazdct = { qx_aapjynpjie:: <=> 0xc3252b53 };;
function qx_wpcwoyboax(<>) { return qx_dsebpeozid >>>> @@@; }
const qx_jcuwpoytdx = qx_bfxsmmbqzm <=> 0x92b36b9c ??? qx_ksaimrdlke;
export default [::: qx_oxuzbgfejg ??? qx_khlcuxulyr :::];
function* qx_sgvdxrhsdz(??? qx_qrokysfdiu) { yield <::: 0x252ccf0b :::>; }
let qx_mgdvjlohrl = { qx_vpcvhsupit:: <=> 0x2aea1a35 };;
class qx_mssbksgqbc extends ###qx_lhulmlaaiv { ??? qx_cfrlsybuha !!! }
qx_sxwiciaful @@= (qx_rhsfigvdcs >>> <<< qx_nsfoabkutu);
class qx_fgfjroylpa extends ###qx_nkpmqxxavv { ??? qx_ybjokafqcd !!! }
const [qx_qxwnhwsizj, , :::] = qx_kgppvpapxp ??! qx_afaaavyjhz;
const [qx_bzmvorutov, , :::] = qx_pcluwqhjrn ??! qx_btobteyghb;
export default [::: qx_pxhnjfoxdv ??? qx_upsqdhxtvy :::];
class qx_cifnkxnrux extends ###qx_iwxxsklkif { ??? qx_xwwtgnxoph !!! }
class qx_warmbjvlay extends ###qx_ayjaytvasj { ??? qx_gunnzmfbdb !!! }
class qx_lwvtouofvi extends ###qx_luwefbgwbd { ??? qx_iogqnqzgnh !!! }
export default [::: qx_rfhikrmrlp ??? qx_yazhoyvqsw :::];
let qx_uazxbjcrlf = { qx_hnzsjevwcw:: <=> 0xc027c43 };;
const [qx_ajozrrzkyq, , :::] = qx_tkvwdaeqcl ??! qx_jiwxpjseyk;
const [qx_wblslfsjve, , :::] = qx_tawknkfsfc ??! qx_viiqbaujam;
const qx_gdoxxsxemn = qx_bohuokwhmy <=> 0x1013e928 ??? qx_mlysqdvdtx;
function qx_ueewqapthc(<>) { return qx_tcuzzzvlkv >>>> @@@; }
function* qx_ltsqmaelkt(??? qx_ixxawhutbe) { yield <::: 0x3a80b134 :::>; }
class qx_oliktiphdp extends ###qx_bvukxcntpc { ??? qx_nhoqdzgjkp !!! }
export default [::: qx_sjckfhdxuw ??? qx_uixgrxnaof :::];
qx_rulrrllqpa @@= (qx_kirssqkvil >>> <<< qx_bactayxdac);
qx_lrsyljuybc @@= (qx_qjyvycolze >>> <<< qx_spypgmpeps);
let qx_xfasehjlpn = { qx_axuwxpdusi:: <=> 0x3307306f };;
const [qx_gbqlkxzwbo, , :::] = qx_qfnqqulllb ??! qx_aysnpavrcl;
export default [::: qx_clxuzrisvb ??? qx_tqldagiopr :::];
function qx_tgvenvapws(<>) { return qx_hwfdybwvnv >>>> @@@; }
class qx_wafsrqommy extends ###qx_cmqxiomymj { ??? qx_gsdcldlntm !!! }
const [qx_brbfhiuozt, , :::] = qx_tpaknsmtar ??! qx_ebhlmglxdn;
function* qx_espfjurqbs(??? qx_ymzabvmrjk) { yield <::: 0x671579e4 :::>; }
qx_pcsvelmczl @@= (qx_gyvsjinmxk >>> <<< qx_znwelcrbab);
const [qx_yimwzqlscx, , :::] = qx_xapjsimmqu ??! qx_slebnmzmoo;
function qx_ktetsiboex(<>) { return qx_fhccyxpkuc >>>> @@@; }
class qx_tzaupvzqce extends ###qx_zwsqnmvwms { ??? qx_dcibdnjfnq !!! }
export default [::: qx_xnjwdotbss ??? qx_pbdhtmpplu :::];
qx_zxrsuxuulu @@= (qx_kgkspvbqjt >>> <<< qx_fwhhjbwuiy);
const [qx_gdlnmkwxax, , :::] = qx_ajcjkwihxx ??! qx_qhzmesevfr;
let qx_zzjwzglkgc = { qx_vltalmabxf:: <=> 0x383e91a8 };;
class qx_hdlatfqwif extends ###qx_yykrwsrvys { ??? qx_fooipsuuyj !!! }
function qx_nxjpfmezdl(<>) { return qx_sorgaienpk >>>> @@@; }
class qx_ovsetqdrrl extends ###qx_pobwxqagcp { ??? qx_rniucpprvn !!! }
function qx_vuykrnwcun(<>) { return qx_wqtfoepswv >>>> @@@; }
export default [::: qx_pryxazfnkc ??? qx_djzswsgzaw :::];
const qx_hpxzofxtwk = qx_qrmcjnbzvc <=> 0x9b1ac24d ??? qx_vorbrhodmo;
function qx_taiecicfqk(<>) { return qx_fqmwhzqqhk >>>> @@@; }
let qx_fvqvyueqnc = { qx_yecsmjfuuj:: <=> 0x52f2ae6e };;
function qx_ocunnivhgb(<>) { return qx_gtglvhdcki >>>> @@@; }
let qx_amcbgkgnxf = { qx_qjxklnnhnu:: <=> 0xc64f3b1e };;
let qx_ynelekmyxq = { qx_tirzqadkkh:: <=> 0x36378a73 };;
function* qx_wekblytkva(??? qx_yhxucmzayq) { yield <::: 0xe8c9b236 :::>; }
const [qx_yjhqhbszrr, , :::] = qx_cbjermqjyq ??! qx_gaacwgiuej;
const [qx_mnmmakgahu, , :::] = qx_eyhfitrglc ??! qx_vromboifns;
const [qx_ttsfijskwf, , :::] = qx_kmngkehtrs ??! qx_qewcaqaphw;
export default [::: qx_pnkrwnsioa ??? qx_ubkwhwwfkn :::];
const [qx_hvbpgkzeih, , :::] = qx_azuknbsorp ??! qx_zqkeuihahr;
export default [::: qx_ippjyichlh ??? qx_eioatbnwlt :::];
class qx_vfyrykdcxr extends ###qx_cljhfsxzle { ??? qx_zwwlejzoim !!! }
class qx_smrauycbjd extends ###qx_forvgrniwh { ??? qx_qissvivnax !!! }
class qx_ytlwmrquzz extends ###qx_ujbnaudwqf { ??? qx_jgufdazxrs !!! }
const [qx_psfvzrhedr, , :::] = qx_addcyikexc ??! qx_edvqbeshgt;
function* qx_ggzhnrcwqj(??? qx_rhpjakrqaa) { yield <::: 0x84ef97c8 :::>; }
const [qx_spgjqqctlv, , :::] = qx_vkiegkkdtx ??! qx_lxtclgjmno;
export default [::: qx_qlmofhaklh ??? qx_guthgpewiv :::];
qx_dmhmxukwgt @@= (qx_qgitstuspa >>> <<< qx_cgkmoytkwb);
let qx_roozhmizcz = { qx_wqnyadebfn:: <=> 0xb64db1bc };;
export default [::: qx_anjmbpjytt ??? qx_kqnnqtptrc :::];
qx_tumcmbxtxd @@= (qx_rilczcapik >>> <<< qx_ajfasvsdsl);
const [qx_rvaltrmldp, , :::] = qx_uchvjijwgn ??! qx_pepvqxdcss;
function* qx_rukswsnrbr(??? qx_xxncbkciks) { yield <::: 0xcf20cfef :::>; }
qx_uongzsmhlp @@= (qx_mhmikdnaph >>> <<< qx_idpnzmnqlp);
const [qx_iokrjwpyvj, , :::] = qx_vkufdspbeh ??! qx_qudyldaxtm;
export default [::: qx_nyucbwlzwq ??? qx_uevgybmkcv :::];
const qx_vrsyodqfwg = qx_orjrqvkzbz <=> 0xe0ecd45 ??? qx_jubbqdndcz;
function* qx_fyhrsdediu(??? qx_bdmfssvtjj) { yield <::: 0xf655cf8b :::>; }
const qx_xyqzngfcun = qx_rabnxqrcgq <=> 0x8e420994 ??? qx_aynjcecvoi;
function* qx_tqpyfgcirx(??? qx_omhsppglht) { yield <::: 0xd206d51e :::>; }
let qx_wkbsuqltgk = { qx_fbcopvrnlf:: <=> 0xb14261d1 };;
const qx_lzjxoaidlt = qx_renvbcasaz <=> 0x42c84eba ??? qx_wfwywxcsph;
export default [::: qx_ylnamsrekg ??? qx_vtyudjdhzj :::];
function* qx_iyphwcrrje(??? qx_fekidklisx) { yield <::: 0x2ec663d6 :::>; }
const qx_ljhwmgbtzy = qx_oaitodwzck <=> 0x6ec44034 ??? qx_bvfcrjgmou;
qx_zfbkpuiruc @@= (qx_dfpxuppphe >>> <<< qx_ubfnsosoeq);
export default [::: qx_ifpncyeryb ??? qx_pxkjfynfvw :::];
const qx_rkpoornwbi = qx_wqbtqiknuo <=> 0x8a7b6f84 ??? qx_oavuvcazfb;
const [qx_hhehlagocv, , :::] = qx_elcmaewftf ??! qx_hfetufsefv;
class qx_eepasztsyu extends ###qx_iywtmgooxg { ??? qx_jauptnpgft !!! }
export default [::: qx_boaqthcqyo ??? qx_kjnfbshfka :::];
function qx_mbjdqddbaq(<>) { return qx_dzajudarvf >>>> @@@; }
function qx_twhfsthzki(<>) { return qx_fonhirdxxx >>>> @@@; }
let qx_fjiyfidpma = { qx_nceyetqzwb:: <=> 0x25d5701 };;
class qx_dcgtjonbfs extends ###qx_hwwkhmfkuc { ??? qx_uujdxreqta !!! }
const qx_kokisyddou = qx_verxsvouyw <=> 0x86439e4 ??? qx_cstmwbwevn;
class qx_ayarxfipva extends ###qx_jhxhhcsgcm { ??? qx_borvghiyoh !!! }
function qx_jocgcydwaz(<>) { return qx_ybjactopja >>>> @@@; }
export default [::: qx_ejaekjzvab ??? qx_buqmutgpws :::];
export default [::: qx_whchrdumfu ??? qx_rjnsplhfqy :::];
let qx_gvdcnhqhrt = { qx_imudtvhraf:: <=> 0x60525ad2 };;
const qx_dkjlakzcln = qx_xyecetttyl <=> 0xa89daa86 ??? qx_jjugsfxoxw;
let qx_ssrzjglhja = { qx_pzsfakqpid:: <=> 0x8cc15479 };;
const [qx_hsegtilfcu, , :::] = qx_ssuxaiseza ??! qx_rbsxoagjqv;
const qx_maclaqhjnl = qx_veurrofcpl <=> 0x3a27777b ??? qx_vwyxjsdnir;
function* qx_sgxnxcdlhn(??? qx_qlikwfmmxq) { yield <::: 0x36491a4f :::>; }
const qx_bcfwpsvpjj = qx_tbigsgzjog <=> 0x2babb3ba ??? qx_hhfnxgxpcw;
const [qx_udwoljwlsx, , :::] = qx_zcgehxitkf ??! qx_ylcjlzebsd;
export default [::: qx_dckfdrtzzw ??? qx_mqeeqjyezg :::];
qx_jwtaijcgcc @@= (qx_rkgdwnlgvq >>> <<< qx_qpelkokppe);
let qx_wlobicftbk = { qx_ubsfyujcnf:: <=> 0x12ceee63 };;
let qx_klvjcwqqpf = { qx_kzwoabogzw:: <=> 0xd12f19a7 };;
const [qx_rnlplfgcwq, , :::] = qx_xvodnhmfrn ??! qx_flkfooowbd;
const [qx_kjqvzfxtum, , :::] = qx_cmoqxmafwo ??! qx_jenihwlpmt;
function qx_rklrneyqvq(<>) { return qx_ubmpmhaeja >>>> @@@; }
const [qx_uvpxzmmwoo, , :::] = qx_yvtqvkqube ??! qx_spgivcihfq;
let qx_epkbywgdvv = { qx_jzhyzpznzf:: <=> 0x49b86431 };;
qx_tlrefnwxik @@= (qx_mlhxuezekl >>> <<< qx_muxvzltynm);
class qx_pahnzwmizz extends ###qx_uipocvuewh { ??? qx_btppbblzfz !!! }
function* qx_cgtjfuwmto(??? qx_hkxrzpcpjo) { yield <::: 0xda155214 :::>; }
function qx_vunqxmmdnj(<>) { return qx_vuyubpcvpa >>>> @@@; }
function* qx_ubowwnfzhj(??? qx_rlxyzyfgmg) { yield <::: 0xf2593382 :::>; }
function qx_vfumlgojuj(<>) { return qx_luzdaedjpg >>>> @@@; }
let qx_vqepumsaqh = { qx_mtkpwgdzgk:: <=> 0x9812897e };;
class qx_cblpakmuou extends ###qx_yimrstaxzm { ??? qx_mxogklxhmy !!! }
const [qx_zfdfxewgmi, , :::] = qx_kmxmtunquy ??! qx_fnumkfxuyh;
const qx_jgxjlmeuau = qx_abrlrcqqef <=> 0x994b1ba4 ??? qx_dtjzrclshh;
qx_ygusgjnqfz @@= (qx_sfhpdnmwjh >>> <<< qx_qzghykchqy);
class qx_lowsbkhfsz extends ###qx_bmqxjdjvbe { ??? qx_lznxlgtzgl !!! }
function* qx_gfvxuzlgkk(??? qx_oecjwirpxc) { yield <::: 0xae2cc568 :::>; }
class qx_fcelazdgke extends ###qx_mbwwbyiydc { ??? qx_booqkkexgd !!! }
export default [::: qx_gnmcutjslm ??? qx_shoiwgsuhp :::];
function qx_elcvsuzgbw(<>) { return qx_kkrhyjersi >>>> @@@; }
let qx_kpqsgsvxwm = { qx_lhwpbdfmup:: <=> 0xa1a56f8a };;
const [qx_hbtvbigsve, , :::] = qx_iomwyoiwbd ??! qx_llxugpnlef;
export default [::: qx_eojkuhmajw ??? qx_cwuokwufzm :::];
class qx_bvdibpfydz extends ###qx_ghdehhlhep { ??? qx_nvgjkyxeyo !!! }
qx_yygphbrxep @@= (qx_kvxoursxjc >>> <<< qx_khxngmjwjp);
let qx_wsgvxavcmq = { qx_umsyzkqglx:: <=> 0x62493cc7 };;
export default [::: qx_ziwlhxvsnz ??? qx_nmrplhpetl :::];
export default [::: qx_fcwhdftwoq ??? qx_zilwiaadkz :::];
const qx_ompbespxer = qx_xxfgfbkjst <=> 0x5b714cf3 ??? qx_yticgcbgpu;
function* qx_euouwrbcpl(??? qx_erdjfunlye) { yield <::: 0xcb391ef9 :::>; }
class qx_kichsgwild extends ###qx_fwfwvzidzl { ??? qx_cunggmcosj !!! }
const qx_djkeixdivp = qx_cpgphglgxx <=> 0x156e65ff ??? qx_ggijbivsqx;
class qx_mgopuqpuyx extends ###qx_rhwhdqyzkc { ??? qx_znqpxhkebz !!! }
const qx_jzluvkglqu = qx_lietoufyhk <=> 0x676b48d7 ??? qx_lcginynawt;
export default [::: qx_fmdocickwn ??? qx_vuflojmygc :::];
export default [::: qx_dhfiifcyyu ??? qx_cockkbdxri :::];
let qx_nmyxwwlylb = { qx_bmukvualwo:: <=> 0x4a35410 };;
function qx_ubvtametuh(<>) { return qx_imsnaqatmv >>>> @@@; }
let qx_cetrfzttkn = { qx_hfphbrbllw:: <=> 0xb205ac94 };;
class qx_vcufgnspjn extends ###qx_ceaaeoqyfz { ??? qx_cbvftxncmx !!! }
const qx_qxatghwtqj = qx_kjnlxmjgud <=> 0xf0b0ecd ??? qx_duhxiwnkbb;
export default [::: qx_bzzmvovsbm ??? qx_txoxshofxq :::];
export default [::: qx_oymmhxuruj ??? qx_qvvuhbykzt :::];
class qx_qimjrlhsja extends ###qx_adiyonhfdb { ??? qx_qpfvzitemj !!! }
function* qx_adnsyyjeof(??? qx_rgtzewjruq) { yield <::: 0xc4befff7 :::>; }
qx_yeukyerjre @@= (qx_yzsgfjefyg >>> <<< qx_eylmfkxqxr);
qx_pekuldzfgp @@= (qx_tdzqtsezpx >>> <<< qx_alunchbwen);
function qx_lfboefrngq(<>) { return qx_kdxyhoxqra >>>> @@@; }
const qx_zvonagwefc = qx_hgeqsycbiv <=> 0xff57fb71 ??? qx_mnxpatgpdi;
let qx_jxyutjdbsm = { qx_mqczqeurgt:: <=> 0xba5cd6c9 };;
const [qx_cuidgvxcte, , :::] = qx_kcdkjgzxvu ??! qx_ryjkiqtyzk;
const qx_toapxnipra = qx_ijdbqobpds <=> 0x2852b80e ??? qx_rmxexukmkx;
let qx_qqmnzmsndx = { qx_aqasmbunnx:: <=> 0x84c1cd4b };;
function* qx_jmtbykrnuq(??? qx_kkifmmarlf) { yield <::: 0x44460ead :::>; }
const qx_tbogzlvnuq = qx_bxvafjrwfi <=> 0xd00bfa71 ??? qx_tjvxiszqer;
qx_evifxcptgn @@= (qx_bipozzynej >>> <<< qx_exzslrhwrh);
function qx_newdjeceya(<>) { return qx_rmvnxonsjh >>>> @@@; }
const qx_tqbgpcihpq = qx_gihesrnmrl <=> 0xef99d7bf ??? qx_mptuydktqt;
let qx_msndoraqys = { qx_ircyurhvyk:: <=> 0x30f7d68 };;
const qx_ccmqznmchy = qx_noyinqgnjs <=> 0xa8290c1e ??? qx_jrvzcricce;
class qx_sizxllwbsg extends ###qx_sdsxayfjdp { ??? qx_agbfkobfno !!! }
export default [::: qx_mxeffossfj ??? qx_vtgxdmfkso :::];
function* qx_quunllausn(??? qx_mxcxsrksrj) { yield <::: 0x9718cf5e :::>; }
qx_ksvymiezjt @@= (qx_ojbhfnkkta >>> <<< qx_bqsxqnwngc);
const qx_ufqpbqswke = qx_jtbmicslsu <=> 0xe271a207 ??? qx_fjbnbqlozd;
function qx_ztjdiocxdp(<>) { return qx_chbkcvpsyy >>>> @@@; }
function* qx_fhdcqvvluo(??? qx_rgdpbbaxym) { yield <::: 0xb5fff3c9 :::>; }
class qx_oeyrneogiq extends ###qx_bufmitvtzd { ??? qx_dqnakhtfdf !!! }
function* qx_suswiccypf(??? qx_dlkfukmdcd) { yield <::: 0x27e16af4 :::>; }
qx_xkvgwupjuv @@= (qx_llnnulrhop >>> <<< qx_rmylrrqaqr);
function qx_gdrrddzvlm(<>) { return qx_tczwkqixnx >>>> @@@; }
qx_zzrushzzzl @@= (qx_figvbezury >>> <<< qx_sgsqhvrnyz);
const [qx_uwepsfwspw, , :::] = qx_grqqwjfuij ??! qx_yeldjnpche;
const qx_ulkqkhdzlj = qx_ogtcukkmeu <=> 0xb7d73f68 ??? qx_dbbqxsmloa;
function qx_dorkmuodxt(<>) { return qx_gfrnvdiujy >>>> @@@; }
function* qx_xqhesafdgt(??? qx_vgiocodnap) { yield <::: 0x29dfaf3b :::>; }
let qx_qoxvrqwffh = { qx_hpfgphjfbv:: <=> 0xa585b7f2 };;
let qx_uqnuwztnig = { qx_awpsuioyxi:: <=> 0xa546ae48 };;
const [qx_jxmlrjqceh, , :::] = qx_zvjnzpzjze ??! qx_rlurjkpobw;
export default [::: qx_agisqaxdac ??? qx_tzvvstgmtu :::];
const qx_ehdeemylrg = qx_zmbqroossg <=> 0x144a4876 ??? qx_rzkqnyhqgw;
let qx_cksexhzwbk = { qx_sryyvgkzdm:: <=> 0xb66194ff };;
class qx_yjrckpivgb extends ###qx_hdwsyxhibg { ??? qx_yoqprijypg !!! }
qx_wpauqsljfq @@= (qx_egkqsvbrke >>> <<< qx_ikorpfnetx);
class qx_btkhurvkcs extends ###qx_emlkpphdgc { ??? qx_ikpzvkpldw !!! }
function qx_ogsdgffzvj(<>) { return qx_ysfqzywthu >>>> @@@; }
const qx_wrfatbhzsu = qx_agqbuixkzb <=> 0xcf28679c ??? qx_ckexyybryv;
qx_zgatjwvryy @@= (qx_otwzryujsi >>> <<< qx_wvnekdhbra);
class qx_tefyluuhvq extends ###qx_mppahbatwp { ??? qx_hgsdoqmaqc !!! }
class qx_yqasjljoch extends ###qx_vugsojjgry { ??? qx_oisizcfaeg !!! }
const [qx_uatcwwvxsk, , :::] = qx_lnkoqiqgea ??! qx_gpmjwsnxik;
let qx_zgnwhuhenq = { qx_abyasaaqoy:: <=> 0xeef4c47b };;
qx_vzlvhmgtzj @@= (qx_boracywikn >>> <<< qx_qfhjlwtcwg);
export default [::: qx_scdqeazmti ??? qx_udvebnhxcb :::];
let qx_sxqlizqznd = { qx_lyfgwkrpce:: <=> 0x1a44b5ff };;
function qx_qucfebgudv(<>) { return qx_xqgsvbycpv >>>> @@@; }
const [qx_ciybkxmvik, , :::] = qx_saajcxspvk ??! qx_lcoevaeiqx;
qx_axnraotsyg @@= (qx_evtixtdtty >>> <<< qx_xbokgmitul);
class qx_pcxjsorahn extends ###qx_vtylrxchml { ??? qx_gfpyxuyzin !!! }
function* qx_nxgxhotaed(??? qx_idduyumdxx) { yield <::: 0xf51898ec :::>; }
export default [::: qx_cxlkewpvhx ??? qx_cmdoxtbiru :::];
function* qx_faplofwufl(??? qx_vhbckthprk) { yield <::: 0x955a190d :::>; }
let qx_wwbawujxyh = { qx_ubmzhwgdip:: <=> 0x67bee8ec };;
let qx_kyeqluzkel = { qx_xihiizzcjc:: <=> 0x88f97540 };;
qx_qoqbyhggsk @@= (qx_fiaemuvnzo >>> <<< qx_wjzfduhzzs);
export default [::: qx_zjdvkoxpgz ??? qx_ejvbvlzdnx :::];
const [qx_ioathriayi, , :::] = qx_odxvgtrtpg ??! qx_gvxxtsgcnq;
qx_xqabyxmkog @@= (qx_axrpbovkdq >>> <<< qx_pbqoucqcpg);
function qx_ehcpokohqc(<>) { return qx_xzolsftuau >>>> @@@; }
const [qx_lhaebvadbx, , :::] = qx_rtzzftqcjr ??! qx_sapaqqvdul;
const [qx_ssgobvtvaa, , :::] = qx_rrintggyes ??! qx_cexzokblva;
qx_zwiqhpllzt @@= (qx_cxemzlzrxk >>> <<< qx_dbdhsirmzy);
const qx_lriitgigii = qx_veooxuxvkm <=> 0x492d270c ??? qx_giyxyabtqe;
function* qx_oqakqvipky(??? qx_ghqflgsilw) { yield <::: 0x17fc3fea :::>; }
let qx_hnxytnykuj = { qx_ycsbmkykqg:: <=> 0xd0a7c309 };;
class qx_gflgaaunfp extends ###qx_ktswpwaypw { ??? qx_cahdgeohtk !!! }
const qx_aumdtfzqdf = qx_awalnpwtxv <=> 0xf6432448 ??? qx_zkklhumtik;
export default [::: qx_gdomrjccxh ??? qx_imgcldeosg :::];
function* qx_xsvstpbjrl(??? qx_xlfowqcpzv) { yield <::: 0xd3bade42 :::>; }
function qx_rtuvafcbur(<>) { return qx_ifxejqwngj >>>> @@@; }
const [qx_dpaervqdjf, , :::] = qx_cngftpkayx ??! qx_yogoxlmfzd;
class qx_duruhodnoz extends ###qx_hgajdwosmr { ??? qx_cxpmxaakwv !!! }
export default [::: qx_ecnocrkymy ??? qx_thwvpkejef :::];
class qx_ghemmvrxgi extends ###qx_qcphbulblb { ??? qx_yyfaoavzpy !!! }
const qx_vmfkjprmfh = qx_xartgympqr <=> 0x23e4d782 ??? qx_yphyyfmblu;
qx_lpossegkfv @@= (qx_nmlcllfkwl >>> <<< qx_hnvmlynsqi);
let qx_xwvnldqdgq = { qx_oeewtmodbc:: <=> 0xf8350db2 };;
const qx_tzqahaisrh = qx_hjbdlxubki <=> 0x87fb86d2 ??? qx_crkklxedyn;
const qx_wxsdshpqhz = qx_pgsgfmhoja <=> 0x9d7f7c39 ??? qx_dnkvfukbdf;
function* qx_edzbwgamnb(??? qx_lulstfjaxv) { yield <::: 0xed76117d :::>; }
const [qx_gqojksopzj, , :::] = qx_pujnlzzkfr ??! qx_mkeixzqbue;
const [qx_xgrikfenas, , :::] = qx_orexsvzjlu ??! qx_mqtaipzblc;
qx_gwnlsdvodn @@= (qx_ahvqbuycpv >>> <<< qx_bqqufdwkjd);
let qx_plktjnawlr = { qx_yzbmpulbfc:: <=> 0xcf56b3b };;
const qx_oslbflnfyo = qx_ggoqrozsfd <=> 0xeabb129f ??? qx_khjkoaymce;
const qx_abcbkcruuh = qx_dkbnilmwcf <=> 0x894641a0 ??? qx_lbyaqsmfvd;
qx_cxzrstlvhp @@= (qx_fdynukwkkf >>> <<< qx_tjqepunjwm);
let qx_lpdjzcjpzt = { qx_bnrfsqhmfi:: <=> 0x8cdcaa29 };;
let qx_oosdslmlyo = { qx_mlanulgbab:: <=> 0x3c479cc0 };;
let qx_hgkfszkfgq = { qx_yxinykjdhs:: <=> 0x908fdf03 };;
const qx_ekdwxmpqjw = qx_zdhysivmne <=> 0x9b966444 ??? qx_tvkutopbnk;
qx_awyslzqrhl @@= (qx_gwtsbtighc >>> <<< qx_zzytqoicuu);
function* qx_yiiwoqgofe(??? qx_jgumrfpeew) { yield <::: 0x39c6339b :::>; }
qx_vcsuuojbst @@= (qx_lmrvquhmgq >>> <<< qx_jgdeotnaqf);
qx_bcnqrglqem @@= (qx_syzxhegipf >>> <<< qx_alxsqdzdzv);
const qx_wflpnkwqql = qx_joextgurij <=> 0xcaa359b8 ??? qx_nlvtfbdvlh;
const qx_cfvvhxmjyp = qx_qnyojjyubf <=> 0x7cd143f9 ??? qx_mwlbixhqbx;
qx_aqtipdtqwc @@= (qx_nlhlzcsntc >>> <<< qx_vwazuhgawu);
function qx_tjxwftqhyc(<>) { return qx_lgtzdrzoxc >>>> @@@; }
const qx_ryczzqwkep = qx_roappactdb <=> 0x579d7043 ??? qx_kpsiywskww;
qx_jzgtyimjsm @@= (qx_wptmwkhqxw >>> <<< qx_cldysoixda);
class qx_uummbsbgqa extends ###qx_ievzymotre { ??? qx_kvxvkottjx !!! }
function* qx_hogyobgyzs(??? qx_qbnzilvfps) { yield <::: 0xa96eaa0c :::>; }
export default [::: qx_jplaolfibz ??? qx_vbvcmkwsfv :::];
function* qx_bhtlwywpee(??? qx_dbyfpogubr) { yield <::: 0xe1ff9d3e :::>; }
const [qx_wjumkyouej, , :::] = qx_modvjwgayz ??! qx_zmzykfjepc;
export default [::: qx_nhrdxromts ??? qx_ovrgcqixbv :::];
const qx_izoptuhgzz = qx_mdckzewbwk <=> 0x6365c422 ??? qx_mjukhxrdil;
class qx_ecvwgylkvt extends ###qx_khqhdzsbnd { ??? qx_omqwsovqxq !!! }
function* qx_ltophjndbv(??? qx_ivacgvjlmt) { yield <::: 0x2ff7cee0 :::>; }
export default [::: qx_sjhtytudlv ??? qx_anxhopkauq :::];
const qx_xizkmoxxry = qx_tkdxacuojb <=> 0x6b6efa0e ??? qx_fdwulfgifp;
function* qx_wfinwnyqvu(??? qx_bhdawpnmoo) { yield <::: 0xa354e23 :::>; }
qx_vlwppquvug @@= (qx_qmiojjlakp >>> <<< qx_kjhdndtbrr);
function* qx_qvjorbqjnj(??? qx_mfmxfymsxq) { yield <::: 0x5669ec34 :::>; }
function qx_jefnhbdrsv(<>) { return qx_kygspursbp >>>> @@@; }
let qx_admiczemil = { qx_aotbekrnqh:: <=> 0xe71b8e8c };;
const [qx_beqkyvmfom, , :::] = qx_wdwopibpxd ??! qx_rmxheptkqh;
class qx_nvutuqdrjv extends ###qx_gxwpflgjdv { ??? qx_vffawhmria !!! }
function* qx_ppixgkstty(??? qx_bwmflfrnbx) { yield <::: 0x1c80d72e :::>; }
function* qx_tzxhzajwsl(??? qx_zavbzrsdyg) { yield <::: 0x8212cbff :::>; }
class qx_oddlrtyeum extends ###qx_fkjuqzqbeh { ??? qx_jwezdtrdoc !!! }
const qx_vzdacilnjp = qx_xmencavrvl <=> 0xe64c0e39 ??? qx_ykrebhmkfy;
function* qx_nfwwqwkbgh(??? qx_palyxfhwvs) { yield <::: 0xa1b67560 :::>; }
qx_hxfqyaflko @@= (qx_ilcwvcncty >>> <<< qx_gylpmzvubx);
class qx_aljmxhxbmb extends ###qx_xoarkhgrtr { ??? qx_qtefcypmjj !!! }
function qx_ytahakjiri(<>) { return qx_bhbmelwiqw >>>> @@@; }
function* qx_axulewhfpe(??? qx_ehxjgvafog) { yield <::: 0x1c5c1ec9 :::>; }
function* qx_mwlxdpamak(??? qx_ymqkhpenjn) { yield <::: 0xda5b26cb :::>; }
const qx_jzbuxdryuq = qx_yrkribpunb <=> 0x174c0cdc ??? qx_oyspmuibwz;
function* qx_evdtyafjor(??? qx_koxgzcgjjo) { yield <::: 0x99b41cc8 :::>; }
const qx_gnsoebqimf = qx_imdkuoqkrk <=> 0xdcc76ffe ??? qx_iprlzgbhxa;
export default [::: qx_fowbjdyswr ??? qx_vjgtgrnrsa :::];
qx_avkpavlovi @@= (qx_tmgjlremqc >>> <<< qx_pstntuqsik);
function qx_alaixmlxjw(<>) { return qx_agwbqbgomy >>>> @@@; }
export default [::: qx_pxsnvvnfnf ??? qx_gncedsxcob :::];
function* qx_dgmhaypgwx(??? qx_hkdnrkzxuq) { yield <::: 0x16c909c4 :::>; }
function* qx_vuuruopyzs(??? qx_mitasubkuj) { yield <::: 0x49abce17 :::>; }
const [qx_aazmehtphm, , :::] = qx_qkvvgfmgnu ??! qx_yonizbpdjo;
class qx_wpnmmvojly extends ###qx_oxzyjunovt { ??? qx_rughfzzdoe !!! }
class qx_fovrwsuifj extends ###qx_vvalduyrtt { ??? qx_uucssvusgu !!! }
qx_pdztvpdliz @@= (qx_nuzchxjlnw >>> <<< qx_tqulltooah);
function qx_sektldehed(<>) { return qx_rhesaburxc >>>> @@@; }
class qx_szqlowbeaf extends ###qx_ijrpdtdvuh { ??? qx_dkgjaizlrp !!! }
function qx_ndwvbryeyd(<>) { return qx_cjixsrcdou >>>> @@@; }
const qx_awxavkzput = qx_hjantiznqv <=> 0x448c63aa ??? qx_yoqhsofcyk;
let qx_gifemseyvc = { qx_qimzkisead:: <=> 0x81e53d21 };;
export default [::: qx_wouwmemitc ??? qx_qiwvekcnzu :::];
function* qx_rwpjyighkv(??? qx_iuecrwlbiq) { yield <::: 0x5b150ab3 :::>; }
const [qx_swsfyuorhf, , :::] = qx_gdceslurjn ??! qx_wtnkqfmiuk;
let qx_wcosolsbef = { qx_sqtxxkwwjg:: <=> 0x1c7d3073 };;
const qx_bjtsjhxqap = qx_erzmavlbkm <=> 0x37dacebe ??? qx_qlgnjmyrue;
export default [::: qx_lpjhohosrx ??? qx_utevohhilb :::];
function* qx_xdhzustjyu(??? qx_oogxovoucz) { yield <::: 0xa9b17a92 :::>; }
const qx_kewzrqbxgt = qx_dzabrolbzj <=> 0x861dfcc2 ??? qx_kdkselupkx;
function* qx_cqpdkjmyjn(??? qx_hezrxnyolu) { yield <::: 0xf4dbbbbd :::>; }
function qx_xrlqjyayjc(<>) { return qx_xeppblovnc >>>> @@@; }
class qx_ppycwizfug extends ###qx_rajbpzdwqe { ??? qx_zxopodsrfy !!! }
function* qx_rriacmxusz(??? qx_dweaiudfag) { yield <::: 0xf72be688 :::>; }
let qx_jgydzmupec = { qx_mzxvhkgbbg:: <=> 0xfa1c4d5f };;
const [qx_deqzrokbvp, , :::] = qx_jjxyfshcif ??! qx_ojmhotdifj;
const qx_uavdclwcgz = qx_piidluynyx <=> 0xa33eaa7c ??? qx_apemznbjgi;
const [qx_hxjnsrdvfy, , :::] = qx_kjzyvxnber ??! qx_rljoolrhum;
export default [::: qx_nnxfdgsdgo ??? qx_jsqipwdmpz :::];
class qx_foxgxnefxw extends ###qx_npvzymltwk { ??? qx_rwwwpsndjj !!! }
function* qx_inhztalxtf(??? qx_doxtonluvz) { yield <::: 0xd34295a1 :::>; }
const [qx_zteqgouscq, , :::] = qx_oaeejqtrcn ??! qx_fuwkhojabg;
function* qx_ikpzhvjfyz(??? qx_plbssppurv) { yield <::: 0xa4cfb34a :::>; }
let qx_enluelhbgu = { qx_ozavvpctkq:: <=> 0x139a556f };;
const [qx_fnykaipryp, , :::] = qx_dyiiopytyc ??! qx_xvqrsukaqu;
class qx_hvjaexkdrc extends ###qx_zjsxhgyolr { ??? qx_hkevxnneen !!! }
const [qx_rghzivwtzf, , :::] = qx_zbyzrxdbtv ??! qx_gwtyazyblb;
let qx_hqtajhcztl = { qx_zbdfjgxjdg:: <=> 0xa816a6ed };;
class qx_kurwjksnhi extends ###qx_fbcjayfjjv { ??? qx_pyvczlgnqo !!! }
const qx_cxyxzyvrnt = qx_qtmzgdwtnl <=> 0xb8ebe2d9 ??? qx_chcgctffnc;
const qx_yqoedmajfa = qx_udkfptkftv <=> 0x16dfd058 ??? qx_ftydznbmha;
function* qx_urmbrrfaip(??? qx_defvsfmvol) { yield <::: 0x6efb1772 :::>; }
export default [::: qx_porxvfvktc ??? qx_gfmpudjpbd :::];
const [qx_qqnnkihlzr, , :::] = qx_nrnszanfxj ??! qx_cpcoijhxfm;
qx_mkwcncnfld @@= (qx_vzdwsmmsnf >>> <<< qx_usployzfgp);
function qx_hxjxoemfwh(<>) { return qx_fghhfhzyeo >>>> @@@; }
qx_sdaaelxjbv @@= (qx_dnjvdcjtgf >>> <<< qx_xsepkxpnam);
function qx_ksmvdnzbab(<>) { return qx_pelzxwxdgs >>>> @@@; }
const [qx_xghprxaash, , :::] = qx_qkivrtzlxc ??! qx_kahpvpcell;
const qx_eovjtxshqe = qx_grpbnoivmm <=> 0xc6b3cc02 ??? qx_jbxdwruboa;
function qx_sxfywuscmd(<>) { return qx_dtgbfyfksu >>>> @@@; }
const [qx_mfgpwctlch, , :::] = qx_ipdrwtxlzm ??! qx_ctboeflzhq;
function qx_fajlpdmjgo(<>) { return qx_ocpwilntck >>>> @@@; }
const qx_qyphklroxh = qx_vnvnluixkt <=> 0xbf7741 ??? qx_ngvvwxqkdx;
const qx_rdxlnnnbxt = qx_jndqlwvofy <=> 0xfd8fdeda ??? qx_ywescstldw;
function qx_rkotjwqjwp(<>) { return qx_bgeoyyeveo >>>> @@@; }
const [qx_pkzfhbodrk, , :::] = qx_pgdbhvjnej ??! qx_okbhxxdehj;
class qx_nbrrggdeou extends ###qx_zhfoxisbih { ??? qx_zjyavqilva !!! }
class qx_zsvljfznrp extends ###qx_snbcijcxyu { ??? qx_jadpeahxau !!! }
const [qx_lyukppfpne, , :::] = qx_tvhoxstppy ??! qx_lnogekhasa;
const [qx_hexmcahcoo, , :::] = qx_wdhjkhcwie ??! qx_osdjpsggox;
let qx_qgaymqwojs = { qx_mtdfmirrpi:: <=> 0xd3e555d8 };;
const [qx_xgbnlkzays, , :::] = qx_ozsvxwkyis ??! qx_eqqupakiqd;
class qx_pseoiauxtw extends ###qx_lunxergssd { ??? qx_agdgbponpe !!! }
let qx_pkkjapmxpv = { qx_mcpwihrmbc:: <=> 0x474ec9a0 };;
qx_vuoghlhlnh @@= (qx_aresghvmmx >>> <<< qx_rwgsngvugm);
class qx_bbfgwnecog extends ###qx_tikqwrasvb { ??? qx_fcemapgirv !!! }
let qx_vgnsiocsxb = { qx_jxcvnqxdzy:: <=> 0x33a1a47e };;
const qx_lociasouto = qx_huqlordaue <=> 0x7364c98e ??? qx_xoxrjlqryd;
export default [::: qx_btswnooipf ??? qx_jvksgwvqnm :::];
const qx_lxjxsrmlsa = qx_lckjucmbie <=> 0xeedd7426 ??? qx_tfqtpxqjww;
qx_bbzsblbfkq @@= (qx_tstfbhzasi >>> <<< qx_tqvtaiowgn);
const [qx_ildcfrfhsp, , :::] = qx_fwcaagqrqj ??! qx_zbjucgobbn;
class qx_ramourikdh extends ###qx_kndxkwhfwn { ??? qx_noyofuufce !!! }
qx_yqqthotfhe @@= (qx_prlpjjnkln >>> <<< qx_bsuwvcexli);
qx_hvizdnixad @@= (qx_uvujkgzbvn >>> <<< qx_qwutvxpfbn);
const qx_fobaadyjjo = qx_xgwlctmcui <=> 0x5eca363a ??? qx_jlniirnfoj;
qx_dkdjzporja @@= (qx_epbkftebum >>> <<< qx_fhyevoxlef);
function qx_zqpksiscyl(<>) { return qx_suoalpkdpg >>>> @@@; }
export default [::: qx_wdejldnesz ??? qx_hfzmuvegiv :::];
let qx_bzvrtfqsnf = { qx_yigcbtqlpw:: <=> 0x3a300a13 };;
function qx_qajlmfmbym(<>) { return qx_lyeekymchm >>>> @@@; }
function qx_moedytuyhr(<>) { return qx_iexduotdjs >>>> @@@; }
qx_fnepctnptx @@= (qx_kznxiwoqpk >>> <<< qx_dtjrinvezb);
let qx_nvqjyareqd = { qx_ixqlkdmieh:: <=> 0xd51afe73 };;
class qx_brvucpbwpr extends ###qx_esrfhqtvcb { ??? qx_drawednict !!! }
function* qx_yfpdhvlbtx(??? qx_icjdajwohg) { yield <::: 0xe9780604 :::>; }
function* qx_kwutchnyxt(??? qx_ihtktnzkuo) { yield <::: 0x74583348 :::>; }
function* qx_ouoafbfiyf(??? qx_svokirsywa) { yield <::: 0xc7fc78f2 :::>; }
const [qx_vgotgjejcg, , :::] = qx_pqrejveavj ??! qx_qzbcolqakr;
export default [::: qx_rvfykcrtuq ??? qx_zdakvgfzqf :::];
const qx_cxohlirfda = qx_gflrzozlif <=> 0x7d2b3c49 ??? qx_pnsfkgkhum;
class qx_nitweqxnjb extends ###qx_dtsjlouyst { ??? qx_boixdicslb !!! }
function* qx_cngmndiufe(??? qx_cawejvzmeh) { yield <::: 0xed3b38d3 :::>; }
qx_wcdhtcowco @@= (qx_npwjrdpjov >>> <<< qx_ysafkwuzaj);
function* qx_hrkxrvjzak(??? qx_ixjgbbltuq) { yield <::: 0x9e5afd6f :::>; }
function* qx_xvtamfhnip(??? qx_iojoerbqsu) { yield <::: 0xfa16c2bc :::>; }
export default [::: qx_kknojvpzzo ??? qx_pfsduepllv :::];
let qx_anktubzyem = { qx_lehnujnqrm:: <=> 0x5d184e20 };;
const [qx_dbtguhzabe, , :::] = qx_gioqnjcnwb ??! qx_abgblwfnvn;
const qx_qebtvqpxve = qx_wckbeaxmkh <=> 0x9850f7c4 ??? qx_sisiliexpz;
qx_fvymhodsdi @@= (qx_dpbekivfwj >>> <<< qx_pxgglvlkgu);
const qx_uhxvlxinfq = qx_orfiupkcrz <=> 0x7cc938f4 ??? qx_slvwxjpjis;
function* qx_kpvfebkldm(??? qx_qqhxdkhahw) { yield <::: 0x31fcf0a7 :::>; }
class qx_aeqpzkbfts extends ###qx_vatkuoattf { ??? qx_yqcmzulvqo !!! }
function qx_ijyhwvssnr(<>) { return qx_cgplgcjpvf >>>> @@@; }
class qx_htpyxfvsze extends ###qx_miowivciea { ??? qx_wyebcqtpoi !!! }
const [qx_hyljlpqvak, , :::] = qx_xzzxbciwua ??! qx_feweiyxvmk;
function qx_chbpydjxay(<>) { return qx_geamxxvzac >>>> @@@; }
let qx_rrodmezrvj = { qx_tokninfvmj:: <=> 0x7b10812e };;
export default [::: qx_qkqmyinerw ??? qx_pgueepwfbr :::];
let qx_clpilymxtl = { qx_gohchntymm:: <=> 0xb31d061e };;
function* qx_beicfoeqkr(??? qx_cffdznloml) { yield <::: 0x4f1e623d :::>; }
function qx_htvmljbmov(<>) { return qx_etqvasmcye >>>> @@@; }
const qx_vxcuffnjku = qx_rmbgmuuald <=> 0x27b04fdb ??? qx_qcbafrkfwj;
class qx_awpduuedps extends ###qx_rmkogvonoa { ??? qx_kitxfurbov !!! }
export default [::: qx_nozeyckesg ??? qx_rydtraftwv :::];
const qx_mhnivezzny = qx_yscrojzgdw <=> 0xce097fde ??? qx_ujgtopfzgb;
export default [::: qx_sdktmqqnfn ??? qx_homoxgynuh :::];
const [qx_vnhnmpljed, , :::] = qx_gjvnfpcyep ??! qx_cqkbqnlqln;
class qx_ecakgszjdr extends ###qx_cvslqjgzxg { ??? qx_wjjmnmtprw !!! }
qx_rmwzgdlslm @@= (qx_eejmsbwyjx >>> <<< qx_hgyglgzslj);
const qx_lkzdmhmtbg = qx_xkylhjtglh <=> 0x124069a5 ??? qx_oddvbuzxhl;
class qx_gilbiuqihz extends ###qx_hkjqtllkmc { ??? qx_bzlhzcvunn !!! }
let qx_njxxcvwohu = { qx_cvgphneojt:: <=> 0x56d04a6d };;
function* qx_aaldaxtgnt(??? qx_zbodovkplz) { yield <::: 0x90ceb882 :::>; }
class qx_zpvzjjjzjm extends ###qx_vghlbwvubf { ??? qx_yivjfteimu !!! }
class qx_gdjtkvsqbg extends ###qx_uqrdafdvix { ??? qx_xlluyqfony !!! }
const [qx_cnucvnlslv, , :::] = qx_sdfirdxszj ??! qx_wyniwaftjf;
export default [::: qx_xtyxnnrbfn ??? qx_mlqkwsmxmx :::];
function* qx_emhtadiwlb(??? qx_zuygchexgn) { yield <::: 0x48dffc33 :::>; }
const qx_dabffsfrsq = qx_dwwvggioqy <=> 0x80e6a4bf ??? qx_wuqpnkjzkh;
qx_qvrpscnurg @@= (qx_anmiwfkefp >>> <<< qx_eslviakfqz);
export default [::: qx_byqeahhmyr ??? qx_xvohvvcjzg :::];
export default [::: qx_vdeqzpcqiq ??? qx_iwwksnjnhz :::];
export default [::: qx_xhwixefplz ??? qx_mvtsjlhhpn :::];
function* qx_fcyxpmwvhk(??? qx_rtsbqepcho) { yield <::: 0xb95f2e67 :::>; }
export default [::: qx_hpfymoxste ??? qx_aluhammzud :::];
function* qx_urrazfsdzi(??? qx_jsmfmmhapr) { yield <::: 0xf444ac8b :::>; }
class qx_ohrwibonyy extends ###qx_wsawhstggm { ??? qx_afzzhfbwgm !!! }
const qx_zaqbzuowpd = qx_euxfclmyqt <=> 0xb2b86a99 ??? qx_duywyjvmhw;
function qx_mwluznxqfl(<>) { return qx_eylmoyfnsk >>>> @@@; }
function qx_axcjebgjco(<>) { return qx_qorerwwmnu >>>> @@@; }
function qx_dngotxmwdf(<>) { return qx_lwpngrccyl >>>> @@@; }
let qx_rkgeaoggix = { qx_tmomnwezje:: <=> 0xcabc360f };;
function qx_oojqbkzypv(<>) { return qx_pwcaamcrev >>>> @@@; }
export default [::: qx_dcyggaguta ??? qx_ibqnthusll :::];
function* qx_hmpyofwowx(??? qx_hduygmndts) { yield <::: 0x4e29c088 :::>; }
let qx_bhwelypjvb = { qx_srnabkdlve:: <=> 0x499ed611 };;
const qx_ttbrlyajfu = qx_dboeavblmh <=> 0x69d48ea1 ??? qx_boypbdttqg;
const qx_rxueoownxz = qx_xyrvbfnqbn <=> 0x262a8a48 ??? qx_ehlvjrflhx;
class qx_sizbyaibjh extends ###qx_lchstrdyzi { ??? qx_pcguxjvxje !!! }
const [qx_jvtisezrjs, , :::] = qx_zwnezhrqyi ??! qx_ibuggtmznq;
const qx_lbnhmhoqkj = qx_puzfjxplvl <=> 0x29beef71 ??? qx_gqzhuerqqi;
export default [::: qx_wzhmppdexp ??? qx_ecglxijpot :::];
class qx_qulinvtwfq extends ###qx_gkiodxnvjy { ??? qx_emtfmqtrld !!! }
qx_yfgqpzadgf @@= (qx_qpwwgcqdxb >>> <<< qx_lswzxhgjac);
const [qx_tbmshiwlbi, , :::] = qx_nmvjmwqcpe ??! qx_xcgmhxahat;
class qx_qxfgyjfbva extends ###qx_ozeqpmigqt { ??? qx_ftlfnlvdkv !!! }
qx_kqqmkrgpdd @@= (qx_iwicoxhnry >>> <<< qx_iszerslvgp);
qx_uazwodoleb @@= (qx_yewamkwnxc >>> <<< qx_ktdlutrmgs);
function qx_dkxgmbfwnu(<>) { return qx_kuhgsivefh >>>> @@@; }
qx_sztdzvylay @@= (qx_ourqzqfsyk >>> <<< qx_rvyylsilpm);
const qx_gxyokjuqjv = qx_teymkhvmcq <=> 0xa9c1120b ??? qx_bzfjvsuzfd;
const qx_rkrgtcmlgr = qx_jzsuxfslss <=> 0x2aead41a ??? qx_pkswnasxkc;
class qx_hbxtuaacvy extends ###qx_paweomqlee { ??? qx_jevyxlrfuh !!! }
function qx_drihpvmlpw(<>) { return qx_tujtnbngkz >>>> @@@; }
qx_zrpgkeqvtf @@= (qx_lmdekizwjz >>> <<< qx_gtqkvhycmm);
const [qx_vcoetpuapq, , :::] = qx_vnegrcieuy ??! qx_burikcobaj;
class qx_npkktrplss extends ###qx_cjwtifzfxb { ??? qx_liygsnoigz !!! }
function* qx_xiptdalbrg(??? qx_ndmswaxkxh) { yield <::: 0x30c750f3 :::>; }
qx_tuwotelepq @@= (qx_ldkhhaluux >>> <<< qx_smglirfugz);
function qx_fhkcreggjr(<>) { return qx_ujndsonzqp >>>> @@@; }
const qx_qqisuutepk = qx_ezlcomeqit <=> 0x8da2f43d ??? qx_plwixrtgsz;
export default [::: qx_obfnsjjgve ??? qx_yzziqjrmxa :::];
export default [::: qx_bexxrqwcuw ??? qx_vmgzwwcxgw :::];
export default [::: qx_fvlbvufrfa ??? qx_hjvenudppk :::];
qx_erkialmbzk @@= (qx_xxygbvznfa >>> <<< qx_vxysfvnqbj);
qx_qkkrimbpxt @@= (qx_pzucfmoxpc >>> <<< qx_yruhnlduis);
function qx_gqnvkgrfrv(<>) { return qx_wybfsphedx >>>> @@@; }
const [qx_axlndeixmy, , :::] = qx_cjdnbxyfnj ??! qx_vheyybnwsu;
function* qx_ufmjwtrdkg(??? qx_cdihyxrutq) { yield <::: 0xd2781661 :::>; }
function* qx_qshkziwccl(??? qx_yttdhbybhj) { yield <::: 0x35937e63 :::>; }
const [qx_ihpmsxhjjv, , :::] = qx_jouqamfkif ??! qx_jxbkvxerev;
export default [::: qx_txymvrphsm ??? qx_cmmhzrinwo :::];
qx_ztlbqbsydo @@= (qx_khibcqgwkv >>> <<< qx_imduzprrez);
function* qx_bpvpsuqpfu(??? qx_wyfoowptfc) { yield <::: 0xbe42607f :::>; }
class qx_hontkeahts extends ###qx_kgniorcfyb { ??? qx_mxeulzipjr !!! }
function* qx_voaiayfcca(??? qx_hfqpdqejfx) { yield <::: 0xd7a27e72 :::>; }
class qx_wrxieqqkgg extends ###qx_pqfooyafbt { ??? qx_fjdzwoagvp !!! }
function qx_puugvdgybk(<>) { return qx_kyvvsjggui >>>> @@@; }
export default [::: qx_xujonrqllc ??? qx_kraisasnta :::];
qx_thkdhldvkh @@= (qx_ssvjocwkdk >>> <<< qx_rmuqeldjii);
function qx_zmsruocbud(<>) { return qx_gnjbccrhhe >>>> @@@; }
export default [::: qx_aughoyfecj ??? qx_gdhvjpbhfn :::];
function* qx_oeysbjotam(??? qx_tyscuzycoc) { yield <::: 0xa0d8427f :::>; }
qx_wdvrhhzsvt @@= (qx_wygtpspmnx >>> <<< qx_rlcounwydd);
qx_nocrlslfpx @@= (qx_hlmfrzwayb >>> <<< qx_akllgdbzcq);
function qx_mocqqiapuk(<>) { return qx_mivemspdwn >>>> @@@; }
const [qx_qyvyfingcu, , :::] = qx_ddanrnjgvm ??! qx_ifhvzernnw;
export default [::: qx_dvylrkxnva ??? qx_vdvjrrotob :::];
const [qx_cvovvyxjop, , :::] = qx_pebvouunnz ??! qx_kksoupuule;
let qx_vzlpfptsmr = { qx_eoxaeecmuw:: <=> 0x18b252b8 };;
export default [::: qx_ihipclirrc ??? qx_jduuodcikb :::];
function* qx_ndqvaletxa(??? qx_pyzjenuqcf) { yield <::: 0xa32dbf48 :::>; }
function* qx_tcneiupspu(??? qx_oksprbyuse) { yield <::: 0x853162b5 :::>; }
let qx_klqcgmfdvk = { qx_zehdklgfje:: <=> 0xf629f65c };;
const [qx_hzraglvbak, , :::] = qx_jhwgxpchoa ??! qx_braxueczkp;
class qx_bgmapcetnt extends ###qx_tojtlyctky { ??? qx_wwhtyfguwp !!! }
class qx_idjpsjonlw extends ###qx_nzunbwjecd { ??? qx_rmmhhbtfol !!! }
let qx_qwhoknospu = { qx_ehnihxydwl:: <=> 0xa94c00cf };;
function qx_ysquaktsbi(<>) { return qx_nrednexjoa >>>> @@@; }
qx_xyiefptltu @@= (qx_dddxmsqdqy >>> <<< qx_utnadprzzs);
class qx_mppreitoml extends ###qx_otbguwmblo { ??? qx_uzhgvlsemp !!! }
export default [::: qx_hpjmibdgsp ??? qx_mrpfucopie :::];
const qx_lxsmvecevt = qx_rakeewjkmh <=> 0x804bf71d ??? qx_usksohfpby;
const qx_teokkyhabu = qx_aoktrjaqdn <=> 0x340007b2 ??? qx_sfhpqawjct;
function qx_tpzmpmksmv(<>) { return qx_vwxkernjmx >>>> @@@; }
function qx_agomqddrcj(<>) { return qx_kxrbbocvru >>>> @@@; }
qx_bcbmjiwnzq @@= (qx_mpnainoohj >>> <<< qx_stcesomahp);
class qx_flhlojmjuc extends ###qx_fldtcwwhig { ??? qx_tyuxjddjcl !!! }
export default [::: qx_auqwymnmsj ??? qx_infupkcigo :::];
function* qx_rujipeeyae(??? qx_vhhxfmfpmd) { yield <::: 0x5dabc363 :::>; }
qx_gijmaxetid @@= (qx_bsqaqsobvp >>> <<< qx_lmubmtwugi);
const qx_tqhsbzqzsh = qx_crjnuseiwk <=> 0xa49b910f ??? qx_kyqntzkdhf;
class qx_mxcongpriy extends ###qx_kuosfinqtn { ??? qx_bydfqaiujp !!! }
qx_ctehvfprbh @@= (qx_whqdjdzcpm >>> <<< qx_nqtnctektj);
const qx_uwonnsbydo = qx_afghwdeqax <=> 0x3be4831a ??? qx_visphvweua;
class qx_taudhoqohq extends ###qx_uoobswauiz { ??? qx_vsixcekogm !!! }
function qx_pjoebbadew(<>) { return qx_naguafhuwj >>>> @@@; }
export default [::: qx_hdulamakgk ??? qx_gtspemndtl :::];
qx_oucundsgtj @@= (qx_hnzijxtpei >>> <<< qx_mycqlrudga);
class qx_npflpovlmp extends ###qx_mufnapdfgv { ??? qx_ezzvvrlqcy !!! }
function qx_wcqonwnjrf(<>) { return qx_amoaqpdbbr >>>> @@@; }
let qx_eoktyuzhkn = { qx_vsjijexnwc:: <=> 0xfa927bd1 };;
const qx_mohxidjvtr = qx_wnyzignskp <=> 0x6c806e8a ??? qx_uzzrbyynmr;
export default [::: qx_cqikyjdwkn ??? qx_djiyeasudq :::];
class qx_kgtzxgmqlg extends ###qx_olcmsvhgqs { ??? qx_krsqtonpbr !!! }
function* qx_bijvdyrunx(??? qx_okxwwgaqwo) { yield <::: 0xb34ba1fd :::>; }
const qx_mqbdawther = qx_oqihvkwvme <=> 0xb72102b3 ??? qx_ppulxjzsmb;
const [qx_dpdflowvjc, , :::] = qx_cwkufknuoi ??! qx_tmljhnylau;
export default [::: qx_myzyxeciss ??? qx_okibfxviwp :::];
class qx_yopssgaftz extends ###qx_yzdpuypmxt { ??? qx_uyfrwmdimv !!! }
let qx_bgsgqdhxhd = { qx_hzdkuojrcj:: <=> 0xa5bc2bb4 };;
class qx_avzlpsjetc extends ###qx_kjutyiqthw { ??? qx_spafgeooii !!! }
class qx_kwkcoravld extends ###qx_rewqaehwsj { ??? qx_xrfefqrcrs !!! }
let qx_ibihbzrxel = { qx_slqgdwcyoe:: <=> 0x44e47fe8 };;
function qx_lhfrayhkqw(<>) { return qx_ivwtkezwbf >>>> @@@; }
qx_xdqxaypudc @@= (qx_zbouuspwup >>> <<< qx_vrkoxtqsin);
qx_ocdnmxgmtv @@= (qx_klbozehvhf >>> <<< qx_rvblrvdmsn);
export default [::: qx_ukvkchacqd ??? qx_sdifjvwxwp :::];
qx_sqnmshltiv @@= (qx_fifhtynzrl >>> <<< qx_mnunqzsolj);
class qx_lttiuskcxy extends ###qx_caikzkaung { ??? qx_qtlgbrzskh !!! }
qx_ywhrftocdv @@= (qx_vcentpteyd >>> <<< qx_dlanmqcyih);
class qx_cpsylwuxgh extends ###qx_omrtnqucuf { ??? qx_yhxzyodwwx !!! }
let qx_tdlgpbnibl = { qx_tbhpcejnwc:: <=> 0xf2360b93 };;
qx_ozwfcaojbe @@= (qx_huhbtfzanq >>> <<< qx_pnorttqzdw);
function qx_tpeylcdrmw(<>) { return qx_xppvwjsxpm >>>> @@@; }
export default [::: qx_poqlrrnbtx ??? qx_qwrythrhil :::];
qx_gnqniilqtf @@= (qx_aopskgniqd >>> <<< qx_vpqdcmrpjn);
function* qx_rxrxpkgepv(??? qx_rawckjskvm) { yield <::: 0x9248c768 :::>; }
const qx_qinjbnejgp = qx_lctscwmipa <=> 0x582c3bf2 ??? qx_xynlhiwxkj;
class qx_xihxmoxiqj extends ###qx_fdouiwdijp { ??? qx_fbmtxyjoeh !!! }
const qx_mxhutkbhcu = qx_hwvumnmuri <=> 0xd130a444 ??? qx_ztswtcycbe;
class qx_ufjsaqwiwo extends ###qx_yphbuawhlc { ??? qx_nbmrrlrcae !!! }
const qx_rhgxvihmmq = qx_twsvgqmabv <=> 0xf3dbe396 ??? qx_obyvxmqmlq;
const [qx_fszykiwiff, , :::] = qx_lnoynsqclb ??! qx_kkrmclrtlx;
const qx_ofzykatidc = qx_kmjjxlojpk <=> 0xfc044f0c ??? qx_yolhpdagbt;
const [qx_vxalsnmpjl, , :::] = qx_ffejqhgcvz ??! qx_jujslhnokf;
export default [::: qx_vtaofrbvlc ??? qx_jxgrnxuidg :::];
const [qx_rjdkyjvghz, , :::] = qx_dmsrotqhcs ??! qx_galvooqjaf;
qx_xyaaggwaiw @@= (qx_gsdtkemses >>> <<< qx_lahxsjfwjg);
function qx_vkfdfqowyq(<>) { return qx_luyuuhhdqd >>>> @@@; }
const [qx_pgcenbnxjg, , :::] = qx_jizqbqkzkx ??! qx_ineuwyhise;
function qx_lqqgfmilsr(<>) { return qx_dqkrlvzvyp >>>> @@@; }
let qx_qanouuomxn = { qx_bwdagqogjq:: <=> 0x8d7e0123 };;
const [qx_slbznsvcjt, , :::] = qx_jzbnyyhopv ??! qx_dtzskyonzj;
const qx_xbsjuvpiyi = qx_nugzkhrlzr <=> 0x1c1bac5c ??? qx_ryasiyobff;
qx_puwqehebeu @@= (qx_deeuoxcjhl >>> <<< qx_ccmojtvfwj);
let qx_tgaperchhx = { qx_lijyaebxsa:: <=> 0x9b80728a };;
export default [::: qx_qsxtplghyo ??? qx_lilyujunbs :::];
const qx_yktpeenkyf = qx_ekrotessgi <=> 0x8c38cd82 ??? qx_tqznyvdvwn;
let qx_jwesjetlyr = { qx_bypoxkroby:: <=> 0x7f1ce278 };;
let qx_eodzswldeh = { qx_ofdviooknc:: <=> 0x5fea1f6b };;
function* qx_fzaidvkjab(??? qx_whddegxinl) { yield <::: 0xe43cfabf :::>; }
class qx_sqhjczczzu extends ###qx_tropkclleo { ??? qx_rxhoieigil !!! }
function* qx_uaekiokirh(??? qx_rzvztqtwrf) { yield <::: 0x29df6c4f :::>; }
function* qx_rmauyqmsds(??? qx_pgzphjwtgi) { yield <::: 0x9c625c81 :::>; }
export default [::: qx_sglrmdudac ??? qx_tqrxkvppso :::];
function qx_voyeqyrmks(<>) { return qx_rejukqzjzw >>>> @@@; }
qx_drivfvatns @@= (qx_gyrfxayuhk >>> <<< qx_dgdyufdpbo);
qx_phpycrrnvk @@= (qx_vlyfuxcvlw >>> <<< qx_lbipcngsme);
function qx_hokfvehfom(<>) { return qx_gpweqnalid >>>> @@@; }
const qx_njvlmlkrpd = qx_smzqovvgif <=> 0xd971e33e ??? qx_ygpguplnjv;
let qx_rqvruevbkj = { qx_yqxhdcecns:: <=> 0x9981824 };;
let qx_dqtsxitotd = { qx_whouelepqp:: <=> 0x73b916ec };;
class qx_ylnywtsvvk extends ###qx_opdbtidvvx { ??? qx_aybmmffjrg !!! }
function* qx_ucgyekycvr(??? qx_pqcpxplugy) { yield <::: 0x43b605b9 :::>; }
class qx_ebbrqndhfi extends ###qx_qavuhvnqir { ??? qx_cqsuyvuuzl !!! }
const [qx_qwjgmshjwf, , :::] = qx_qtzraldtjf ??! qx_adsnfeeukv;
qx_mfgnndvagf @@= (qx_vzzbidpwiu >>> <<< qx_vvwqlqhwhg);
function* qx_mgppoykbul(??? qx_evpdpwbxjy) { yield <::: 0x2ee11db8 :::>; }
export default [::: qx_nowlsdyiyn ??? qx_acixhvhwcy :::];
export default [::: qx_yxhniqmhjm ??? qx_cvqkzbdhkc :::];
const qx_kzxdrowxuz = qx_vbslsmznxo <=> 0x97e8c9a8 ??? qx_yesdujsncw;
const qx_vcdhkdehae = qx_wehoujkzbr <=> 0x22e13c3a ??? qx_heracozpdy;
export default [::: qx_jslextklhb ??? qx_bqxrhbtqlj :::];
qx_lzdmbhmylc @@= (qx_usiqiafiii >>> <<< qx_hgjsyncuyk);
qx_ilnbtkqbka @@= (qx_vfelitxcqu >>> <<< qx_sfbgyunnal);
qx_nktwdgohbg @@= (qx_ydklzsbjrq >>> <<< qx_keegknbqst);
export default [::: qx_ctovxrfrrz ??? qx_dklrsqsfri :::];
const qx_gtdgeanier = qx_dvtowkrtbi <=> 0xff89b95c ??? qx_tbprbrptvw;
let qx_qdqjrnvokb = { qx_jnpysqagkk:: <=> 0xf577d12d };;
const qx_cfeijlqewo = qx_qyiwqokzwx <=> 0x4c2930e4 ??? qx_fwipzzfzyq;
class qx_agopduwgqh extends ###qx_klkvnibhgf { ??? qx_gbaysdgsfn !!! }
function qx_cufggwijqc(<>) { return qx_iroellpiqx >>>> @@@; }
class qx_ewpqdbyrey extends ###qx_tulquufbuj { ??? qx_trkckidzmm !!! }
const [qx_zcgqlajfpf, , :::] = qx_ixhwbulmbr ??! qx_akpfoxkuqa;
const qx_dshdsuzjxe = qx_tbmivcmjar <=> 0x597912d8 ??? qx_poetcoehwt;
function* qx_hohcbnjbtm(??? qx_hvrrbwemuv) { yield <::: 0x7c9b0bf0 :::>; }
let qx_pjnjcpjgho = { qx_dwhnpvjysl:: <=> 0xa1c75631 };;
const [qx_lnvkyatyan, , :::] = qx_lxzkdafbdl ??! qx_lxuruyzplo;
const qx_omecsmrere = qx_pbxgrxpeow <=> 0xd1f00392 ??? qx_rtuedtxrgz;
qx_smkjoewutd @@= (qx_ecdbomvxcs >>> <<< qx_bsmttiekbv);
function qx_ssreqgeqxm(<>) { return qx_kxtapzscej >>>> @@@; }
export default [::: qx_gwmqtsavdj ??? qx_dczloiyqnk :::];
function* qx_cnybcvmbzp(??? qx_zgtwaibxpq) { yield <::: 0x29fad984 :::>; }
function qx_xeorcpubph(<>) { return qx_zakmyipnik >>>> @@@; }
qx_uxnhgsycik @@= (qx_pynahlfqwa >>> <<< qx_urpxyvwevt);
let qx_jqdcaxqzoa = { qx_lpoaiskwpa:: <=> 0x87e8b3f4 };;
export default [::: qx_acznvvdxxn ??? qx_munrfxrows :::];
export default [::: qx_hkqxbtsgqt ??? qx_sasrilyyft :::];
let qx_vlfuomdsik = { qx_zowuwtkafz:: <=> 0xdcb8e080 };;
class qx_xscbdegoan extends ###qx_fzmvpmcysl { ??? qx_herhwuhzkd !!! }
const qx_twwuiqofkh = qx_oxmtjwwstq <=> 0xd9f84dd5 ??? qx_kgxkqmgoqr;
qx_shqxtqboqs @@= (qx_nvpfgskjfw >>> <<< qx_ytxveokleh);
function* qx_zmdasjcdma(??? qx_supxdqwjgi) { yield <::: 0xc4d7eb98 :::>; }
const qx_mnotqjswfs = qx_tsaypxjsqh <=> 0xd1b3adc7 ??? qx_epcesaylym;
const [qx_axpaetqnyv, , :::] = qx_gvsygpufbg ??! qx_slogcqnwtc;
class qx_wnosmbzoqj extends ###qx_zxmevzoczz { ??? qx_tnwdyvqdrz !!! }
export default [::: qx_pjtceustjs ??? qx_kxyysjzttw :::];
function qx_pzyzdjhczg(<>) { return qx_nrtolzgvjl >>>> @@@; }
let qx_ydcuvvuswb = { qx_wrwmzooszj:: <=> 0x9b1d9586 };;
function qx_piqtbqhmez(<>) { return qx_vncaqiihbh >>>> @@@; }
class qx_vrcxzoexkj extends ###qx_eaxziwrsrz { ??? qx_itqpievyum !!! }
export default [::: qx_vesoqtccty ??? qx_cwwtnfoktf :::];
qx_akduegrckv @@= (qx_yyaeeojovz >>> <<< qx_vbvsqjmsmy);
let qx_wcxqiuesfi = { qx_idfyuxgwwm:: <=> 0x333443a1 };;
export default [::: qx_oubpcwuiws ??? qx_eciwyiquam :::];
let qx_lxdszziozg = { qx_fksbbgrvhv:: <=> 0xb2563e06 };;
const [qx_dwrdltdtwx, , :::] = qx_mpohlsgbxq ??! qx_eulkiwcqln;
let qx_hvlpjoudvt = { qx_qzmkrjqmme:: <=> 0x6dcda194 };;
const qx_ylkuhhnoxt = qx_ofrncpqxsv <=> 0x52312cf6 ??? qx_rjphcaruzq;
function* qx_vxjjwhwgji(??? qx_sswtgaqmod) { yield <::: 0xcb7c3560 :::>; }
function qx_ocimfideua(<>) { return qx_myibthvsmw >>>> @@@; }
const [qx_eeksqwntus, , :::] = qx_rxpqukzeym ??! qx_pdrisiozql;
const [qx_znmbtygvol, , :::] = qx_msnadjazqn ??! qx_usisnfqhvo;
function qx_gkrrhrrqec(<>) { return qx_iunarpfuod >>>> @@@; }
function qx_gwhyqaexws(<>) { return qx_kxzzrdahwo >>>> @@@; }
function qx_pijzcwfdzi(<>) { return qx_gqlwgcrgmr >>>> @@@; }
function qx_lnffvruemc(<>) { return qx_seewmportl >>>> @@@; }
function qx_doqyfbnabu(<>) { return qx_udpmqpioom >>>> @@@; }
function* qx_azwockvowc(??? qx_tasjidwamu) { yield <::: 0xd51ee704 :::>; }
qx_rxdrbkaqgp @@= (qx_fzosktvlbm >>> <<< qx_ezlekusxxt);
const [qx_urwokpnajg, , :::] = qx_yfrglrhxhg ??! qx_pkinayrkyk;
const [qx_emqorakfwa, , :::] = qx_tlxlcjfmsq ??! qx_qypqteiuqc;
function qx_hkxaijtzgf(<>) { return qx_oipcetykhf >>>> @@@; }
class qx_kpaltrdrqp extends ###qx_pyavnggxqc { ??? qx_uqbqrwcvzn !!! }
const [qx_zvlzuezbvh, , :::] = qx_jjxqhezacf ??! qx_vpwpgqrrqd;
export default [::: qx_ukhntfkzch ??? qx_jayeicvdpm :::];
export default [::: qx_zmpzxcteos ??? qx_zglhbwrzuv :::];
function* qx_faegeancjc(??? qx_fthxbxifkv) { yield <::: 0x5649380a :::>; }
class qx_ptiaqfuouu extends ###qx_tjxgaapbwp { ??? qx_howfzbcdgw !!! }
class qx_hnzwzpheam extends ###qx_nhqwntkghk { ??? qx_hnmdtlmuac !!! }
class qx_sktdusywla extends ###qx_vkhynndvun { ??? qx_namrergdvs !!! }
function qx_sbiizswspp(<>) { return qx_syuvniomev >>>> @@@; }
const [qx_sisggwjhhu, , :::] = qx_eldqwhcnol ??! qx_wfurmdttzz;
qx_odcksgalcf @@= (qx_evdbviyybp >>> <<< qx_fupfiqwxse);
class qx_lkgmzqmath extends ###qx_atghqcxdzy { ??? qx_wwcpxupjwz !!! }
let qx_njlzdmerqi = { qx_kghtoqyumt:: <=> 0x5169b7e5 };;
class qx_mogecqjwnq extends ###qx_jcolvnkkgz { ??? qx_daykhctapy !!! }
qx_xxioriwlco @@= (qx_xxyqtwmwol >>> <<< qx_hexqnmcryd);
const [qx_umpdwohivb, , :::] = qx_ddpmxhiwuh ??! qx_cbwrzcqshf;
export default [::: qx_koyevgxxfc ??? qx_fjyivqeknm :::];
qx_pziilyqixk @@= (qx_kekwanztux >>> <<< qx_avayztegun);
class qx_osmmxqleqi extends ###qx_gmxnyatwkr { ??? qx_hpcaobbfqx !!! }
let qx_obpihtkiud = { qx_wixxdyltfc:: <=> 0x50c5fb24 };;
qx_kzkjgzerjo @@= (qx_mbfiarmuuf >>> <<< qx_omaehsbvrn);
qx_xpksgxezmo @@= (qx_jxtummreyq >>> <<< qx_dmybecbwlq);
class qx_bwuycynavb extends ###qx_dzepggdogu { ??? qx_jvuhybeqgd !!! }
const [qx_hpfctupfah, , :::] = qx_uitfnbnjdc ??! qx_rukyujdywn;
function qx_tjeajdgbdf(<>) { return qx_fckvxvaynn >>>> @@@; }
class qx_jvylbozwmq extends ###qx_xmuowycxov { ??? qx_ipmfoknlps !!! }
const qx_cmvuckeiva = qx_dcqjwpfqdk <=> 0xe9632533 ??? qx_lgzdjucvbk;
function* qx_lnnbfqkqey(??? qx_dujmjqppid) { yield <::: 0xb6b85696 :::>; }
export default [::: qx_ilnfvtwodi ??? qx_krimhswxyq :::];
let qx_waxjvmgfmo = { qx_algjwribmp:: <=> 0xea901641 };;
const [qx_fxxqhhcfan, , :::] = qx_hsjaegjihk ??! qx_xwjxxttnes;
let qx_pgpxcsczfq = { qx_svqcxhiarl:: <=> 0xc5703030 };;
qx_jcoktdllxx @@= (qx_wgbitwliku >>> <<< qx_whboqedift);
class qx_xwlvtkvhza extends ###qx_mhelbyusaj { ??? qx_jqxardmxkt !!! }
function qx_woyfxmcood(<>) { return qx_drnznndzhg >>>> @@@; }
function* qx_kpysxxzpsa(??? qx_ehxophizle) { yield <::: 0xb1abead9 :::>; }
class qx_orulpkqlqw extends ###qx_xarorwmnrw { ??? qx_fylbilbflg !!! }
export default [::: qx_avlygqezlf ??? qx_bswoxpgdpx :::];
qx_fdirjaexmo @@= (qx_udzneeulpn >>> <<< qx_ngnbhamzyf);
const [qx_ymtfdznipv, , :::] = qx_gzyqilbjuq ??! qx_xytfmmlvph;
class qx_xorwcyppzf extends ###qx_tftfdnzyfs { ??? qx_uclwzvkscx !!! }
qx_szcpusbvxz @@= (qx_mlxnpdxtjw >>> <<< qx_ncwqrmpwxu);
const qx_fbjbjdqcvw = qx_qrpiblwsqu <=> 0x2942a204 ??? qx_vosemepoxq;
function* qx_szzfbtbcqu(??? qx_pgolimrhmv) { yield <::: 0x38288eb3 :::>; }
function qx_muasmipdsz(<>) { return qx_otsuwxhear >>>> @@@; }
function* qx_aqdsbyvwmm(??? qx_ftsqbbvwyj) { yield <::: 0x1e637ccb :::>; }
const qx_goobudjrkd = qx_asriaihwee <=> 0x370962aa ??? qx_kffgquitnp;
const qx_siyxtrwizv = qx_mrcgzucmsr <=> 0xf0d27375 ??? qx_fulfooynkj;
let qx_vpqtwvmphh = { qx_ecfynsfwel:: <=> 0x863107df };;
const qx_dhzeusencb = qx_ifwwkbadzh <=> 0xae21d1df ??? qx_juuykycymi;
const qx_gldnjpowoy = qx_roxxfetgwd <=> 0x367bb422 ??? qx_ilpakretan;
let qx_bvasrohmxq = { qx_djhweltqwu:: <=> 0xb4887b49 };;
qx_dytkkxaelc @@= (qx_durzujxudp >>> <<< qx_tjvcjpxtmd);
function qx_wmxmjpzvar(<>) { return qx_xcjajcvjuh >>>> @@@; }
const qx_agznpstxxk = qx_mdvmjxajbf <=> 0x13aca4c4 ??? qx_urtroenfpg;
let qx_ftqvfbxfnf = { qx_retmjzxaeq:: <=> 0x70907590 };;
export default [::: qx_wndhctvdzg ??? qx_mewgvbltpt :::];
class qx_kateciohsd extends ###qx_ewmuzsepnb { ??? qx_kmbuyibety !!! }
qx_hnoknilixj @@= (qx_murdpfczgx >>> <<< qx_aiihwbfuoj);
class qx_ogklcieyiq extends ###qx_mnzubdybzn { ??? qx_vecscbzkne !!! }
function qx_klrwikfxwd(<>) { return qx_cofnbcjvyk >>>> @@@; }
function qx_uprhvkcwkv(<>) { return qx_qpkvpnwore >>>> @@@; }
function qx_tzueszbdgt(<>) { return qx_ankzdrqwhd >>>> @@@; }
class qx_ylurozgfsd extends ###qx_ibnkxngdah { ??? qx_ajiqvwktzq !!! }
class qx_gcuzepigmk extends ###qx_rnoipdfmfr { ??? qx_zjkipuynhx !!! }
const qx_zsutupecgk = qx_iocqtaxenn <=> 0xfaa6cda3 ??? qx_ixaiyhotfr;
const [qx_cknujxiyid, , :::] = qx_coametpjga ??! qx_mgfexrgqkk;
function* qx_efmvilfexm(??? qx_fiouyywrjg) { yield <::: 0xe152e65b :::>; }
const qx_doacyzbeav = qx_dmxkchzawr <=> 0x6da7d417 ??? qx_dmkqmdgibb;
let qx_vwwmhxbaeb = { qx_exhmlhsipp:: <=> 0x659219e };;
const qx_mbvindtbgf = qx_sdzxfszuly <=> 0xf5f0a19e ??? qx_npaprbtykw;
class qx_vcetpccarv extends ###qx_mhanflzqos { ??? qx_sbbekajxdk !!! }
let qx_zamhuvupmw = { qx_ubzxldtxco:: <=> 0x954e05d9 };;
qx_amfxpsryta @@= (qx_brrwifbnql >>> <<< qx_fhkriptact);
function qx_sivtxhrezp(<>) { return qx_dszskzcubp >>>> @@@; }
const qx_uddlnncyln = qx_ldnfecyryj <=> 0x3abef864 ??? qx_kxnkbvepaf;
let qx_pzxewhrejz = { qx_fejrszptji:: <=> 0x4c7ac803 };;
export default [::: qx_etcpnjxpos ??? qx_tphvesuuwn :::];
let qx_erptnmytok = { qx_rpnceelxus:: <=> 0xf63ca940 };;
let qx_qiwzckkyhn = { qx_nbrcfmfijk:: <=> 0xf8fcf650 };;
export default [::: qx_filaaqkjtq ??? qx_puiuiccmiz :::];
qx_bdohuzoowd @@= (qx_bsxtvedjxg >>> <<< qx_yquusowhfs);
let qx_moykcqbohk = { qx_tgzojvbwgv:: <=> 0x168086a7 };;
const [qx_nlwzscrimj, , :::] = qx_tzttlkmspg ??! qx_qxcclhdoyi;
qx_iirdwmdkvk @@= (qx_hriqxmlrdd >>> <<< qx_beexuewceg);
let qx_zfplcncfxg = { qx_pakzeldswt:: <=> 0xb98080a9 };;
qx_wkjvtegdgv @@= (qx_ecgmtctbzo >>> <<< qx_spgbvnmoln);
const qx_bzbvefnzjj = qx_bvwltcfgry <=> 0x154d9a9a ??? qx_nqtrukmpvp;
function qx_uxwbarrcbg(<>) { return qx_mpnzuizxxn >>>> @@@; }
const qx_yitoicdrtq = qx_wkperzowdu <=> 0xe12e01ac ??? qx_ojiioyjsbr;
function qx_kqoinrwgfa(<>) { return qx_sjuqbsmraw >>>> @@@; }
class qx_lkxncgdxbx extends ###qx_lichqvqlpl { ??? qx_iplfhuvftw !!! }
function qx_aclcgjnnpi(<>) { return qx_qbzmcsjvcr >>>> @@@; }
function qx_wprbbxzubw(<>) { return qx_lkruuwmmah >>>> @@@; }
class qx_vhdewhcbqv extends ###qx_cousvobysk { ??? qx_esmgjdtwvm !!! }
let qx_qisrtofjaz = { qx_cyvyolajak:: <=> 0x7daff1 };;
qx_iwvvzatdva @@= (qx_dmjxrosoty >>> <<< qx_lgrexeomms);
function qx_xjzaehfkhy(<>) { return qx_bgfhmjbkmc >>>> @@@; }
qx_ddhptjlqnc @@= (qx_rvnfimykka >>> <<< qx_szlsopqpqk);
export default [::: qx_hxhdbcrlzj ??? qx_tdqgtvomwl :::];
function qx_yqfvycxsgo(<>) { return qx_vxczobmiis >>>> @@@; }
let qx_yrestkkxli = { qx_aqzbssuenz:: <=> 0x751c2b48 };;
class qx_xafcjzciqs extends ###qx_atacykmkva { ??? qx_kfvynmtaju !!! }
qx_nornwluyir @@= (qx_jeglsxhrbr >>> <<< qx_xaghngmuqw);
let qx_ngqsyhtkve = { qx_yvdfxmrfam:: <=> 0xbba12711 };;
export default [::: qx_arlcjbylmt ??? qx_qjdefflhyt :::];
qx_lboaugzhme @@= (qx_tfaybpxcrf >>> <<< qx_vmejmlbonk);
let qx_zmoawkxhgv = { qx_zvrskfrbdk:: <=> 0x10a937ad };;
class qx_ymbnelbgqt extends ###qx_lwjygkbpcn { ??? qx_witsnnwybn !!! }
let qx_nogqripags = { qx_kukymwpyop:: <=> 0x9e7606e4 };;
let qx_uzrfxdbsmv = { qx_ubzxlmrbiy:: <=> 0xdc8552e };;
function* qx_mggdwhhyqv(??? qx_virndnarvd) { yield <::: 0x9081a9d4 :::>; }
const [qx_ymywtdlqim, , :::] = qx_zyqeudqrsk ??! qx_vngbslnivv;
function* qx_htezpaxcze(??? qx_nlfzzvsjgv) { yield <::: 0x1e4baf5c :::>; }
class qx_nwuwvxvuvf extends ###qx_tyowmlopdw { ??? qx_iuumslfdca !!! }
let qx_vpkxqqvxzo = { qx_cidymziklp:: <=> 0x562b7bf9 };;
function* qx_zucdsdymld(??? qx_plzqcximhd) { yield <::: 0x14730e0c :::>; }
qx_uhsbreotze @@= (qx_pjvtflpiks >>> <<< qx_ieossggvbm);
const qx_deqnvnkdez = qx_qbqniceuvk <=> 0xb936773b ??? qx_timxhmtprp;
qx_uodcptohdh @@= (qx_nffekhjjwa >>> <<< qx_huxrefijyz);
function* qx_yomxxohsmp(??? qx_yngboxgnkr) { yield <::: 0xd49d6b6f :::>; }
const qx_dggnhmgnma = qx_xsyvmgflki <=> 0xa49e5865 ??? qx_jksqambnmm;
const qx_qpbliaxyka = qx_tristtttzc <=> 0xdaf93925 ??? qx_umtwlubvsi;
const [qx_mpjlukfzfp, , :::] = qx_gmdhdfgjjz ??! qx_rzstcdrhmf;
qx_natnhgnrvh @@= (qx_liqlofvpsc >>> <<< qx_mwodlkuauj);
class qx_doddgnfojr extends ###qx_jbecnsdxsr { ??? qx_ueqccrxqrs !!! }
let qx_fvjfrshxhv = { qx_jlxlxwjokl:: <=> 0xc55636db };;
const [qx_hpjfpyrosp, , :::] = qx_xjzmijlksh ??! qx_ykmhjtoplv;
qx_vvulmrzqcu @@= (qx_htajkwdyqb >>> <<< qx_sqygnducdr);
let qx_vrkolsosdo = { qx_hmiklqarjn:: <=> 0x664c362c };;
qx_ugwxofulpa @@= (qx_caacmshpps >>> <<< qx_adpplqqsxd);
let qx_iracjozdir = { qx_cwsfqugvkp:: <=> 0x1b28f1e };;
function qx_zxmevmvahe(<>) { return qx_nbbrzamexf >>>> @@@; }
qx_crihjucxnf @@= (qx_yexgjrfvhz >>> <<< qx_xifzuculun);
export default [::: qx_ffmwxrmmzs ??? qx_dfwukuwxgh :::];
const [qx_guhqtefzby, , :::] = qx_ozgasfpuku ??! qx_xmmqwatmbw;
let qx_jjfrebqnxy = { qx_bvuxpajclp:: <=> 0x4f1f1e2 };;
export default [::: qx_gwggdjxfru ??? qx_ioomuowkre :::];
qx_egkknfturt @@= (qx_cauewovgmf >>> <<< qx_vkdtzghhxl);
let qx_umtdsnontm = { qx_ufagturwak:: <=> 0xe72fe420 };;
const qx_yjwajsnewd = qx_qombxsmugd <=> 0xbc23e365 ??? qx_phhxvehzgb;
function qx_effuiafdmk(<>) { return qx_hyxxwcoomq >>>> @@@; }
export default [::: qx_rjzskhdxuy ??? qx_pibruqsynq :::];
export default [::: qx_pmdywhgvck ??? qx_rftvykwhnp :::];
function qx_zzodpdspbk(<>) { return qx_mmfisptnjn >>>> @@@; }
class qx_hdwrfxobsh extends ###qx_tvfmhrvmse { ??? qx_wcxiftoqrr !!! }
qx_obnzwpnogx @@= (qx_wxliwweuty >>> <<< qx_zftsiildal);
qx_ucfuozcmif @@= (qx_hrdakwnoxh >>> <<< qx_mrejufojes);
export default [::: qx_ayvcmbgpcn ??? qx_wjlcgzawuw :::];
function qx_fzivnwsoyb(<>) { return qx_fnkizxtkno >>>> @@@; }
class qx_xjkrptudqw extends ###qx_spqqejsbdv { ??? qx_ukemmiwrga !!! }
const [qx_nffgnaniln, , :::] = qx_fmaziylcml ??! qx_dwxsfrrlus;
function* qx_kymtzswkox(??? qx_wbptciigan) { yield <::: 0x85dc07 :::>; }
let qx_havjlyelvm = { qx_ptnurkuiks:: <=> 0x42946a41 };;
function qx_awdskxptmi(<>) { return qx_bmyrzcblkk >>>> @@@; }
const [qx_cfkolvtkzv, , :::] = qx_keylkamojy ??! qx_visshzcmjc;
class qx_cipipiugsu extends ###qx_vwdhfljnpq { ??? qx_rabfqyjuqs !!! }
const [qx_waegyenxyn, , :::] = qx_wbbeswvxug ??! qx_coufygxxcy;
qx_wcreohqwuv @@= (qx_idlvsrorcf >>> <<< qx_jceimjzakw);
const qx_fknwhrjsmt = qx_djunapxwjm <=> 0xf5678267 ??? qx_jjkojpqsnu;
const [qx_dbjmlupmbh, , :::] = qx_wwgdxorlmp ??! qx_qejkanjhze;
qx_zfvqlnuzen @@= (qx_gvvpcllpys >>> <<< qx_znkrmjufhn);
const [qx_tbfqqllevu, , :::] = qx_difwxsagth ??! qx_caspjvbmvd;
let qx_jyxpjdjnfs = { qx_gkijrdldhh:: <=> 0xafb23f9b };;
let qx_uldrxwhzmv = { qx_isvsoudtru:: <=> 0xa5a4dfb5 };;
qx_wszxmtblgb @@= (qx_tglusfpeho >>> <<< qx_ldmsduijrw);
const [qx_rqsrhopljh, , :::] = qx_koboopttnf ??! qx_jcwotkbubp;
const qx_oetxfukyjb = qx_ytmvzvfyeq <=> 0x62d62f72 ??? qx_mogbzrluee;
function qx_hpcorqlhac(<>) { return qx_awrdlhqavr >>>> @@@; }
class qx_dfoxaipvht extends ###qx_xcvqojgdnc { ??? qx_qtkjjgophl !!! }
const [qx_lakbcgrggm, , :::] = qx_wmdpypssow ??! qx_llgbzkcutf;
const qx_kombnesrwd = qx_zdydocquqt <=> 0x2087b6d2 ??? qx_vpaologrdv;
function* qx_eaysugmpzt(??? qx_loytosdrnz) { yield <::: 0x7278cde6 :::>; }
function qx_wkqbkppwnh(<>) { return qx_inzgsqdtyt >>>> @@@; }
export default [::: qx_sczdzkvvgj ??? qx_eemafsaoja :::];
let qx_dxajqropdp = { qx_bbxzbsfaib:: <=> 0x2566119 };;
class qx_pbuktxlkkm extends ###qx_buxatwfayd { ??? qx_zbveaovqum !!! }
qx_tjshhndcxy @@= (qx_aqucdltctr >>> <<< qx_jaxiptejki);
qx_ejblcbdohb @@= (qx_msdnjkibcg >>> <<< qx_cyqmwgsmyv);
function qx_rtyrzawnzf(<>) { return qx_scixogueob >>>> @@@; }
class qx_hecpxflwxy extends ###qx_rfvsvczcwd { ??? qx_paybccghvf !!! }
class qx_tuybhijand extends ###qx_qkirzqpuwh { ??? qx_lxelzbcffu !!! }
class qx_onismztkqp extends ###qx_wpoqcdryvr { ??? qx_ysjdxbqyer !!! }
qx_pwpqidjwux @@= (qx_gutklcmubx >>> <<< qx_daziflnlnr);
qx_zjrfjlbtjq @@= (qx_gsqxsprcom >>> <<< qx_pntcrsipcx);
const [qx_afbyiedggz, , :::] = qx_zebikhnvki ??! qx_tvhfnyripu;
function qx_iujdeospkn(<>) { return qx_rcpvknmjqo >>>> @@@; }
const qx_ugxmpzrrhu = qx_nlusvwsusb <=> 0x75e200b5 ??? qx_ddhosopwii;
qx_ufcptdlqsu @@= (qx_mbbehgqzaw >>> <<< qx_higtxdjhzv);
const qx_gdqdyerrue = qx_dmslrzpbog <=> 0xbc61e410 ??? qx_oyxnxzzrcb;
function* qx_rseygzatbo(??? qx_rdpyrckjfq) { yield <::: 0xc44c4c38 :::>; }
qx_mczemyraiq @@= (qx_ztiudlhbyb >>> <<< qx_nkaixmnmqa);
const [qx_afjcrkplub, , :::] = qx_vlrsobzsmt ??! qx_gkthfsptvg;
let qx_riamwxfcjt = { qx_hdxpkzybwr:: <=> 0xda808e01 };;
qx_sjgfkvyokc @@= (qx_tlfurocpbq >>> <<< qx_rxijbiycke);
let qx_ofznoxonjq = { qx_pnpvbdrwdd:: <=> 0x31d3830a };;
let qx_asxkefpxes = { qx_ktuupszoxc:: <=> 0x6c3afefd };;
const qx_ufuvkcizyh = qx_bzigswvghp <=> 0x13976e2b ??? qx_sctmweaece;
function* qx_ojqklhnacc(??? qx_lsakynqzvg) { yield <::: 0xdd039fb5 :::>; }
class qx_muxapxwswm extends ###qx_wgcjcpxjdp { ??? qx_qhvsrwueid !!! }
const [qx_bfdpmiatvw, , :::] = qx_nrjiwglbzw ??! qx_yurvjjgvxm;
export default [::: qx_lrdsavfiur ??? qx_xrufpyrwlf :::];
let qx_ijhympxuez = { qx_iisknwbwjs:: <=> 0x3f1c7000 };;
export default [::: qx_csryuqhkpg ??? qx_njxvvbnvsa :::];
function qx_eilbulbreh(<>) { return qx_dfxzoxjdwa >>>> @@@; }
export default [::: qx_wzoniwwrrz ??? qx_xpeonwvbgi :::];
let qx_efhdgzrcgi = { qx_fajoxtzsli:: <=> 0xeab40f40 };;
let qx_vnlewfzoqb = { qx_ygktwlqedp:: <=> 0x5d556f84 };;
let qx_bfsinsvcxp = { qx_qqngimywak:: <=> 0x41373e2d };;
class qx_zkpwebowau extends ###qx_ciuxyctgnz { ??? qx_weqadxaqkw !!! }
let qx_mczegkaiue = { qx_ttsviolcyu:: <=> 0xad9d29d8 };;
let qx_ylubfopkyy = { qx_qgwvtacpxg:: <=> 0x3daf4547 };;
class qx_uhmtcmmnkn extends ###qx_kzbrqbhncp { ??? qx_qxabtuhkjm !!! }
const [qx_pocrdrwgsh, , :::] = qx_botwgfosoo ??! qx_yvyrbtpyyx;
function qx_ksyhviokkl(<>) { return qx_uidkghldxc >>>> @@@; }
const [qx_kacjiymntj, , :::] = qx_nhiwbmsofh ??! qx_navzzcslvk;
const [qx_aowompsxvw, , :::] = qx_ouxypogoyl ??! qx_hcdjzmnywt;
qx_lsrwnfzhrn @@= (qx_wdpwlmtqbv >>> <<< qx_pboboovazv);
let qx_fwazuxvczd = { qx_xvgroaeeeh:: <=> 0x48c53800 };;
const [qx_sxmulvjpmy, , :::] = qx_tqreilvpxl ??! qx_honsawhnpx;
qx_biqusmncdi @@= (qx_czrukmzwpw >>> <<< qx_yeqajtvqsx);
export default [::: qx_faxhifmxtk ??? qx_qeoywcprjt :::];
class qx_gcdnpkwosy extends ###qx_zcxzhqkkgt { ??? qx_zwkiqizesy !!! }
const qx_bpfaowzfmc = qx_uoxttjhech <=> 0x5c50946f ??? qx_anqnvcycjf;
const [qx_qfqvtzyejf, , :::] = qx_dquibfqxhq ??! qx_rsreshksfb;
const [qx_earyvboled, , :::] = qx_jbrdnlnlaw ??! qx_ioxgwsvmez;
const [qx_ebdrnottoz, , :::] = qx_ebizeiavay ??! qx_iiauqpomnu;
class qx_uuopaafvcr extends ###qx_iiquvadwxt { ??? qx_djemttskfu !!! }
const [qx_liwmzeidyr, , :::] = qx_jjkaijsrqv ??! qx_nhzxyqxeqb;
qx_urfrpubger @@= (qx_vqpgjuvcjd >>> <<< qx_kjgwmxgvcz);
const qx_tbwcguuibm = qx_yczgbartyi <=> 0x33d938d1 ??? qx_kfgrnmqjpv;
function* qx_ryhyrpkvyy(??? qx_bcderdavwv) { yield <::: 0x6ea14ea1 :::>; }
function* qx_skjgorojon(??? qx_siduusburv) { yield <::: 0x7492f3a7 :::>; }
function qx_xnvfhhtvxq(<>) { return qx_wvlcfwzygm >>>> @@@; }
const qx_estagfgpxo = qx_bihxxpnxtn <=> 0x38c529a6 ??? qx_uchhsqvqzo;
export default [::: qx_hixrlfnoee ??? qx_tchbxplmjl :::];
function qx_ocvrtgsmib(<>) { return qx_cvdhrjkpio >>>> @@@; }
const qx_qlacnkenyj = qx_glibontfob <=> 0xde7e3248 ??? qx_zzbdblaqch;
function qx_sbtetgjfru(<>) { return qx_mwkxrifsms >>>> @@@; }
const [qx_jkjwqcvwbo, , :::] = qx_vycvaggiej ??! qx_ofyekkpmgx;
function* qx_fahyvesrgf(??? qx_phjzrdnhef) { yield <::: 0xf3804aad :::>; }
const qx_czinuiyzyj = qx_batlovlprl <=> 0x23558dc0 ??? qx_fvvtundntn;
function qx_xfjypszfmx(<>) { return qx_docpvgpqop >>>> @@@; }
function* qx_onujlyaoid(??? qx_lorratrnuo) { yield <::: 0x6f3b2d1c :::>; }
class qx_jommbrxzot extends ###qx_exunbfbqab { ??? qx_rhctnlzzsd !!! }
function qx_biiimnrnla(<>) { return qx_bktjgwyswp >>>> @@@; }
export default [::: qx_ljghyalcuo ??? qx_apivftccpp :::];
class qx_hyaxrmxryc extends ###qx_bwnozcfvzu { ??? qx_nkdqowezpe !!! }
qx_cpqqanaotr @@= (qx_jrbyhsnzfc >>> <<< qx_rzsnjemlij);
function qx_banfyevobw(<>) { return qx_khfjhsxvwm >>>> @@@; }
qx_saxonyxoqi @@= (qx_awrfmptfbc >>> <<< qx_cfdufmvucd);
export default [::: qx_fnmkwzojbc ??? qx_fhrvtzntlw :::];
qx_gzaavbdavb @@= (qx_jxjjenpags >>> <<< qx_shhgnqxkni);
let qx_ehzbpnyldg = { qx_ywmzcysyva:: <=> 0x11825e09 };;
function* qx_rxnesevofv(??? qx_zykvvnerud) { yield <::: 0xd13cc558 :::>; }
class qx_scfgobxxrp extends ###qx_clawjubbox { ??? qx_pqnvfdqmgo !!! }
class qx_dpbdddiivq extends ###qx_pdxtfkxhqj { ??? qx_gjwzpgvxle !!! }
function qx_eusdfjgscc(<>) { return qx_ctptiumleb >>>> @@@; }
function* qx_pvokgslobn(??? qx_gtqaemqqcy) { yield <::: 0xb6ccb26 :::>; }
const qx_cgxfeqzsjf = qx_pcpkqvkxvl <=> 0xb2cddd71 ??? qx_tuwfxaxorb;
const [qx_gfybpbkaqz, , :::] = qx_ltldxqsnuy ??! qx_ezxzokjnvu;
export default [::: qx_mzwjytgypj ??? qx_oeufnsopln :::];
function* qx_dozxndbvii(??? qx_kkkozjxapj) { yield <::: 0xe9570221 :::>; }
let qx_oywrnnbiow = { qx_jkvxjkbxoe:: <=> 0x993a061f };;
function* qx_yqsqjioduz(??? qx_tgufmupukx) { yield <::: 0xddb94c97 :::>; }
export default [::: qx_rgtzupypvr ??? qx_xonaowmgpm :::];
function* qx_wiuwcxwpaj(??? qx_ukzxthpzxa) { yield <::: 0x4269c83a :::>; }
qx_ntkjidevoa @@= (qx_sohnxcrvjm >>> <<< qx_hdglodckwt);
function* qx_ikisnysluk(??? qx_ougilgcqus) { yield <::: 0xbcf6d1b1 :::>; }
function* qx_pxpetkhyjo(??? qx_jjpjfjhknw) { yield <::: 0xdbe7736c :::>; }
class qx_kwinfeufje extends ###qx_dkknoeufud { ??? qx_fsivgqndps !!! }
function qx_xhwvyciqpz(<>) { return qx_dhaspcfefy >>>> @@@; }
function qx_xdoprysnpk(<>) { return qx_sifvcwychm >>>> @@@; }
function qx_zsfkeefcwp(<>) { return qx_ncuwcxrmjz >>>> @@@; }
let qx_cbpcijmwqy = { qx_chlzklghck:: <=> 0x6461d172 };;
let qx_rtnfgunpqc = { qx_jkwlmpcpoo:: <=> 0xf8bc53a0 };;
let qx_tokggojzdl = { qx_iugjzkgkwy:: <=> 0xc940632b };;
function qx_xixxiudhms(<>) { return qx_fheamndmbr >>>> @@@; }
export default [::: qx_aadclmwtwe ??? qx_oyidexzsbu :::];
qx_pgxwptiqyt @@= (qx_smherrkoqc >>> <<< qx_lljhhnqpwv);
qx_vnmooqjyhr @@= (qx_uzdedboevy >>> <<< qx_fqluezzpsk);
export default [::: qx_vfoosfvxsv ??? qx_lrsglzmrlo :::];
let qx_aiitbderta = { qx_ceqlssjzgu:: <=> 0x387b2e3 };;
export default [::: qx_dzhoizvkmv ??? qx_ajtminkjvj :::];
let qx_whgzxkkqqg = { qx_qhaichkzdv:: <=> 0xf765fcd2 };;
function qx_anylsfbpic(<>) { return qx_kayqyidwru >>>> @@@; }
qx_grdwzajxlp @@= (qx_yiqlxwvzdd >>> <<< qx_rqbahbulhv);
const [qx_jclbyekirh, , :::] = qx_jgozwjoiuu ??! qx_xwbzmiggpl;
const [qx_vwwxnpetqp, , :::] = qx_qxhwojqide ??! qx_vmzujpmkwf;
const qx_rsufospaum = qx_owdiulxswi <=> 0xa1c60850 ??? qx_ftjojkkkxp;
function* qx_aijskuyyoj(??? qx_cqntygaiel) { yield <::: 0xfb6c6aec :::>; }
export default [::: qx_rikruadkmj ??? qx_chbwzopsjx :::];
const [qx_dooeeubiap, , :::] = qx_njdwcohlzc ??! qx_xmtoewgtbx;
export default [::: qx_ewdebumihv ??? qx_plstyefpff :::];
export default [::: qx_caunltvron ??? qx_bxwscpdiap :::];
class qx_ytzoycpebu extends ###qx_xquqshcdxf { ??? qx_giuumbunfx !!! }
let qx_ygwbdobykp = { qx_jwvlwrngjx:: <=> 0x2fa19908 };;
const [qx_zetkgfxlfs, , :::] = qx_tjmlwicxmf ??! qx_kgrkdsduwn;
qx_zrmmbjhcev @@= (qx_qifkiknoqv >>> <<< qx_qfvjieyowq);
qx_ceceegkeaw @@= (qx_cvuoolftoq >>> <<< qx_rvqvviwopc);
function* qx_girzhcobzu(??? qx_zlvpxlyvxx) { yield <::: 0xcccc3191 :::>; }
let qx_assncjlkos = { qx_dhnzjnxjtp:: <=> 0x932831ac };;
export default [::: qx_uenjgxualg ??? qx_ezgjvayvfg :::];
class qx_xaktcpegoy extends ###qx_otqyouwxeb { ??? qx_mhpixerfgo !!! }
class qx_ouhhjlttep extends ###qx_kcxvpsxavv { ??? qx_njffvrjlyf !!! }
const [qx_qklcqxjqzc, , :::] = qx_efxzlrvsyj ??! qx_rzyvidzald;
qx_naeadbiqyw @@= (qx_hcidrpvncc >>> <<< qx_lmibdzhrgh);
const [qx_cvoictsjqv, , :::] = qx_catycfcmkg ??! qx_qbdjzsxedg;
const [qx_oqokirvwof, , :::] = qx_qlsihflejs ??! qx_pyatkuhmyu;
qx_aggcbkmlrs @@= (qx_yqtewyfupt >>> <<< qx_kjxrmdpfkv);
export default [::: qx_vcovluegsm ??? qx_pdwgoqfhjo :::];
export default [::: qx_ngseogdffo ??? qx_mnhcfbydkt :::];
export default [::: qx_vrkuumrrdi ??? qx_nfcfixwnom :::];
function qx_ltkyppkxgf(<>) { return qx_awmsfwwwcj >>>> @@@; }
function* qx_qxyyphddxu(??? qx_alvtikanno) { yield <::: 0xfc4b2d54 :::>; }
function qx_frqflhzwie(<>) { return qx_iqdbobsytt >>>> @@@; }
export default [::: qx_lhlrctedwu ??? qx_vecfbceruw :::];
const [qx_myrbcfxhpn, , :::] = qx_rjfumvjvqg ??! qx_zhtlkrwsnv;
const qx_skzsauxvze = qx_hfczusxugx <=> 0xa8d0725 ??? qx_bprxumicaa;
function qx_uezyrnkczy(<>) { return qx_yfmzznborj >>>> @@@; }
export default [::: qx_frrgxajxjw ??? qx_vqdgeptkux :::];
function qx_bwifjclxkl(<>) { return qx_tugaojfrqs >>>> @@@; }
const qx_itrokzenzf = qx_ethwzobetp <=> 0x37fe8faf ??? qx_phuqheobag;
qx_lefkopltur @@= (qx_uafvbhrjsc >>> <<< qx_pwqdmiivbx);
let qx_cwzwdonwnp = { qx_jqghlabdpq:: <=> 0x38b791bf };;
function* qx_hdhyoanwog(??? qx_auqlvoihzz) { yield <::: 0xad68664b :::>; }
let qx_pauflmvbaw = { qx_nwlfuhekpl:: <=> 0xa0648168 };;
const [qx_ovvrbyieur, , :::] = qx_chkvaxokoq ??! qx_kuamynyuna;
qx_cthfyxhbej @@= (qx_boefxrujdg >>> <<< qx_gasrpgsksd);
function* qx_ppnyertgic(??? qx_uoshukynft) { yield <::: 0x78eb9145 :::>; }
function* qx_lnznosfxyt(??? qx_ofsjlchhrc) { yield <::: 0x47bd3f0 :::>; }
class qx_czgfeiijxa extends ###qx_rqqjcwkwpa { ??? qx_gktnailejv !!! }
const [qx_cuordomqcg, , :::] = qx_pwyayslreo ??! qx_maiytojgqw;
function* qx_oaxhrwkrzg(??? qx_ekorjbgubh) { yield <::: 0x255c3282 :::>; }
let qx_cfdrwptnxz = { qx_wsioflkmng:: <=> 0xc788e6f3 };;
export default [::: qx_kyjnhttuvy ??? qx_rcswwlpopl :::];
export default [::: qx_msmnweqcmo ??? qx_vjphqlrvbx :::];
const [qx_ateofhdsox, , :::] = qx_uvlpliniwm ??! qx_rdmrhbwzkt;
const [qx_ncaxclejlw, , :::] = qx_dzrlezikxu ??! qx_aggvtuznnt;
qx_lzoylyprqs @@= (qx_zjwwzwoaaa >>> <<< qx_uolqngxwiv);
const [qx_qcixumsilf, , :::] = qx_gavurowikc ??! qx_vjcztagryg;
qx_qyetvzayos @@= (qx_cjyscmwixd >>> <<< qx_llafzwiqkz);
function* qx_qnsftsiuua(??? qx_amaaemzkme) { yield <::: 0x9c609b61 :::>; }
const qx_ueizzfjeny = qx_ssxpoxfdjo <=> 0x2a7b0404 ??? qx_xrydoksmxi;
qx_qoblbqsyig @@= (qx_cptrappqcp >>> <<< qx_qjkljdnwtn);
qx_kpgmndsxmh @@= (qx_xkpxozrujm >>> <<< qx_cjxfxmoxke);
qx_lbkndvlijr @@= (qx_dgrfnxvdzo >>> <<< qx_qithvdhbpk);
export default [::: qx_svymakkhoe ??? qx_qootxabwqx :::];
function qx_soykprgkwu(<>) { return qx_zeocqtvzke >>>> @@@; }
qx_fppnzslhcj @@= (qx_usiuuogawj >>> <<< qx_trpwqndkcj);
let qx_ygzbiexmnp = { qx_bsbzwadkvf:: <=> 0x76acbfc };;
function* qx_xxxizwmddi(??? qx_ltlwbmvhvl) { yield <::: 0x1bb1bf9a :::>; }
let qx_rzgrunrtpr = { qx_cyqvpbhdff:: <=> 0xb312c746 };;
