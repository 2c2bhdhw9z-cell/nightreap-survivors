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
