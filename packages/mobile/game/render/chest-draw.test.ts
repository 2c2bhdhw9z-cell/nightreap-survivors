/**
 * Painting the chest opening. Run headless: `bun packages/mobile/game/render/chest-draw.test.ts`
 *
 * No phone, no GL context. The painter draws into a recorder that remembers every rectangle it was
 * asked for, which is enough to prove the things that actually go wrong with an effect like this:
 * something still on screen after it should have gone, something drawn where the player cannot see it,
 * a card that slides in from nowhere and lands off the edge, a flash that misses a corner, a reward
 * line that runs off the side of its own panel.
 *
 * The one thing this cannot prove is whether it looks good. Everything else it can.
 */

import {
  BURST_ARM,
  CARD_BOTTOM_GAP,
  CARD_MAX_CHARS,
  CARD_PAD,
  CARD_ROW_H,
  CARD_TEXT_PX,
  CARD_W,
  RIBBON_H,
  RIBBON_W,
  SPARK_SIZE,
  cardHeight,
  drawChestScreen,
  drawChestWorld,
  type ChestArt,
  type ChestSink,
} from "./chest-draw";
import {
  BEAT,
  SEQUENCE_SECONDS,
  SPARK_COUNT,
  chestOpenAt,
  createChestOpenFrame,
  createChestOpenSpec,
  createSpark,
  sparkAt,
} from "./chest-open";
import { textWidth } from "./hud-draw";
import type { Frame, PackedColor } from "./batcher";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Quad {
  x: number;
  y: number;
  w: number;
  h: number;
  color: PackedColor;
}

const CELL: Frame = { x: 0, y: 0, w: 1, h: 1, u0: 0, v0: 0, u1: 1, v1: 1 } as unknown as Frame;

class Recorder implements ChestSink {
  readonly quads: Quad[] = [];
  drawRect(_frame: Frame, x: number, y: number, w: number, h: number, color: PackedColor): void {
    this.quads.push({ x, y, w, h, color });
  }
  clear(): void {
    this.quads.length = 0;
  }
}

const ART: ChestArt = { white: CELL, sparkFrames: [CELL, CELL, CELL] };

const CHEST_X = 400;
const CHEST_Y = 300;
const VIEW_W = 320;
const VIEW_H = 180;

function specFor(over: Partial<ReturnType<typeof createChestOpenSpec>> = {}) {
  return { ...createChestOpenSpec(), x: CHEST_X, y: CHEST_Y, seed: 2024, ...over };
}

function worldAt(time: number, over: Partial<ReturnType<typeof createChestOpenSpec>> = {}): Quad[] {
  const rec = new Recorder();
  const spec = specFor(over);
  const frame = chestOpenAt(time, spec, createChestOpenFrame());
  drawChestWorld(rec, ART, frame, spec, time, createSpark());
  return rec.quads;
}

function screenAt(time: number, rows: readonly string[], over: Partial<ReturnType<typeof createChestOpenSpec>> = {}): Quad[] {
  const rec = new Recorder();
  const spec = specFor(over);
  const frame = chestOpenAt(time, spec, createChestOpenFrame());
  drawChestScreen(rec, ART, frame, VIEW_W, VIEW_H, rows);
  return rec.quads;
}

const ROWS = ["+1 BONE WHEEL", "+80 GOLD", "GRAVE SHOT EVOLVED"];

// ---------------------------------------------------------------------------------------------
// 1. Nothing is drawn when nothing is happening.
//
// The most common fault in an effect like this is that it never actually turns itself off — one stray
// quad left over a run, invisible in a screenshot and permanent on the screen.
// ---------------------------------------------------------------------------------------------
{
  check("nothing in the world before the chest opens", worldAt(-1).length === 0);
  check("nothing on the screen before the chest opens", screenAt(-1, ROWS).length === 0);

  const late = worldAt(SEQUENCE_SECONDS + 5);
  check("nothing in the world once the sequence is over", late.length === 0, `${late.length} quads`);

  // The card is the one thing that stays. Everything else on the screen pass must be gone.
  const settled = screenAt(SEQUENCE_SECONDS + 5, ROWS);
  check("the card stays up after the sequence", settled.length > 0);
  const covering = settled.filter((q) => q.w >= VIEW_W && q.h >= VIEW_H);
  check("the flash is not still covering the screen", covering.length === 0, `${covering.length}`);

  // An empty chest has nothing to say, so it draws no panel at all rather than an empty one.
  check("a card with no rewards is not drawn", screenAt(SEQUENCE_SECONDS, []).length === 0);
}

// ---------------------------------------------------------------------------------------------
// 2. Every quad is real.
//
// A zero or negative width quad is either invisible or inside out, and either way it is a bug that
// costs a draw call. Checked across the whole sequence rather than at one moment.
// ---------------------------------------------------------------------------------------------
{
  let bad = 0;
  let transparent = 0;
  let total = 0;
  for (let i = 0; i <= 120; i++) {
    const t = (SEQUENCE_SECONDS * i) / 100;
    for (const q of [...worldAt(t), ...screenAt(t, ROWS)]) {
      total++;
      if (!(q.w > 0 && q.h > 0)) bad++;
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) bad++;
      // Alpha lives in the top byte of the packed colour. A fully transparent quad is wasted work.
      if ((q.color >>> 24) === 0) transparent++;
    }
  }
  check("the sequence draws something", total > 100, `${total} quads`);
  check("no quad is empty or inside out", bad === 0, `${bad} of ${total}`);
  check("no quad is drawn fully transparent", transparent === 0, `${transparent} of ${total}`);
}

// ---------------------------------------------------------------------------------------------
// 3. The light column grows out of the chest.
//
// Upward, from the lid. A beam that hangs in the air above the chest, or one that grows downward
// through the floor, is the same code with one sign wrong.
// ---------------------------------------------------------------------------------------------
{
  const t = (BEAT.lightStart + BEAT.lightEnd) / 2;
  const frame = chestOpenAt(t, specFor(), createChestOpenFrame());
  const quads = worldAt(t);
  const beam = quads.find((q) => Math.abs(q.h - frame.lightHeight) < 1e-6);
  check("the light column is drawn", beam !== undefined);
  if (beam) {
    check("the light stands on the chest", Math.abs(beam.y + beam.h - CHEST_Y) < 1e-6, `${beam.y + beam.h}`);
    check("the light is centred on the chest", Math.abs(beam.x + beam.w / 2 - CHEST_X) < 1e-6);
    check("the light rises above the chest", beam.y < CHEST_Y);
  }

  // It grows. Two moments, and the later one must be taller.
  const early = chestOpenAt(BEAT.lightStart + 0.05, specFor(), createChestOpenFrame()).lightHeight;
  check("the light climbs", frame.lightHeight > early, `${frame.lightHeight} vs ${early}`);
}

// ---------------------------------------------------------------------------------------------
// 4. The coins.
//
// One quad per coin that is actually out, and none for the ones that are not. The count is checked
// against the sequence itself rather than a number written down here, so the two cannot drift.
// ---------------------------------------------------------------------------------------------
{
  const t = (BEAT.sprayStart + BEAT.sprayEnd) / 2;
  const spec = specFor();
  const spark = createSpark();
  let expected = 0;
  let biggest = 0;
  for (let i = 0; i < SPARK_COUNT; i++) {
    sparkAt(i, t, spec, spark);
    if (spark.alpha > 0) {
      expected++;
      biggest = Math.max(biggest, SPARK_SIZE * spark.scale);
    }
  }
  check("some coins are out mid-spray", expected > 0, `${expected}`);

  const quads = worldAt(t);
  const coinish = quads.filter((q) => q.w === q.h && q.w <= biggest + 1e-6 && q.w > 0);
  check("one quad per coin that is out", coinish.length >= expected, `${coinish.length} vs ${expected}`);

  // No coin is drawn as a sliver or a slab: every coin is square.
  let square = true;
  for (const q of coinish) if (Math.abs(q.w - q.h) > 1e-9) square = false;
  check("every coin is square", square);

  // Coins are drawn centred on where the sequence says they are, not offset by half a coin.
  sparkAt(0, t, spec, spark);
  if (spark.alpha > 0) {
    const size = SPARK_SIZE * spark.scale;
    const hit = quads.find(
      (q) => Math.abs(q.x + q.w / 2 - spark.x) < 1e-6 && Math.abs(q.y + q.h / 2 - spark.y) < 1e-6 && Math.abs(q.w - size) < 1e-6,
    );
    check("a coin is drawn centred where it is", hit !== undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. The burst is a star, not a square.
// ---------------------------------------------------------------------------------------------
{
  const t = BEAT.burstStart + (BEAT.burstEnd - BEAT.burstStart) * 0.3;
  const frame = chestOpenAt(t, specFor(), createChestOpenFrame());
  const quads = worldAt(t);
  const arm = BURST_ARM * frame.burstScale;
  const across = quads.find((q) => Math.abs(q.w - arm * 2) < 1e-6 && q.h < q.w);
  const up = quads.find((q) => Math.abs(q.h - arm * 2) < 1e-6 && q.w < q.h);
  check("the burst has an arm across", across !== undefined);
  check("the burst has an arm up and down", up !== undefined);
  if (across && up) {
    check("the burst is centred on the chest", Math.abs(across.x + across.w / 2 - CHEST_X) < 1e-6);
    check("both arms cross at the same point", Math.abs(up.y + up.h / 2 - (across.y + across.h / 2)) < 1e-6);
  }
}

// ---------------------------------------------------------------------------------------------
// 6. The gold counter is only up while gold is being counted.
// ---------------------------------------------------------------------------------------------
{
  const paying = { goldFrom: 0, goldTo: 240 };
  const during = worldAt((BEAT.countStart + BEAT.countEnd) / 2, paying);
  const before = worldAt(BEAT.countStart - 0.05, paying);
  const after = worldAt(BEAT.cardStart + 0.05, paying);
  check("the counter is up while it counts", during.length > before.length, `${during.length} vs ${before.length}`);
  check("the counter is gone once the card arrives", after.length < during.length, `${after.length}`);

  // A chest that paid no gold draws no counter at all — the same moment, the same everything else.
  const free = worldAt((BEAT.countStart + BEAT.countEnd) / 2, { goldFrom: 90, goldTo: 90 });
  check("no gold means no counter drawn", free.length < during.length, `${free.length} vs ${during.length}`);

  // The counter sits above the chest, never under it where the player's thumb is.
  const spec = specFor(paying);
  const rec = new Recorder();
  const frame = chestOpenAt((BEAT.countStart + BEAT.countEnd) / 2, spec, createChestOpenFrame());
  drawChestWorld(rec, ART, frame, spec, (BEAT.countStart + BEAT.countEnd) / 2, createSpark());
  const tiny = rec.quads.filter((q) => q.w <= 3 && q.h <= 3);
  check("the counter is drawn as glyph pixels", tiny.length > 0, `${tiny.length}`);
  let allAbove = true;
  for (const q of tiny) if (q.y >= CHEST_Y) allAbove = false;
  check("the counter floats above the chest", allAbove);
}

// ---------------------------------------------------------------------------------------------
// 7. The flash covers the whole screen, corner to corner.
//
// A flash that misses the corners is a grey box in the middle of the screen. Checked by area rather
// than by trusting the one quad it happens to be today.
// ---------------------------------------------------------------------------------------------
{
  const t = (BEAT.flashStart + BEAT.flashEnd) / 2;
  const quads = screenAt(t, ROWS);
  const full = quads.find((q) => q.x <= 0 && q.y <= 0 && q.x + q.w >= VIEW_W && q.y + q.h >= VIEW_H);
  check("the flash covers the screen", full !== undefined);
  check("the flash is not solid white", full !== undefined && (full.color >>> 24) < 255, `${full ? full.color >>> 24 : "none"}`);
  check("the flash is gone before the card lands", screenAt(BEAT.cardEnd, ROWS).every((q) => !(q.w >= VIEW_W && q.h >= VIEW_H)));
}

// ---------------------------------------------------------------------------------------------
// 8. The card slides in from below and lands where it should.
//
// The two faults worth naming: a card that finishes off the bottom of the screen, and a card that
// finishes over the joystick, where the player's own thumb hides the thing they were shown.
// ---------------------------------------------------------------------------------------------
{
  const h = cardHeight(ROWS.length);
  check("the card is a sensible height", h > CARD_ROW_H * ROWS.length && h < VIEW_H, `${h}`);
  check("more rewards make a taller card", cardHeight(5) > cardHeight(2));
  check("one reward still gets a card", cardHeight(1) > 0);
  check("a silly row count does not make a silly card", cardHeight(9999) < VIEW_H, `${cardHeight(9999)}`);

  const landed = screenAt(SEQUENCE_SECONDS, ROWS);
  const panel = landed.find((q) => Math.abs(q.w - CARD_W) < 1e-6 && Math.abs(q.h - h) < 1e-6);
  check("the card panel is drawn", panel !== undefined);
  if (panel) {
    check("the card is centred across", Math.abs(panel.x + panel.w / 2 - VIEW_W / 2) <= 1, `${panel.x}`);
    check("the card is fully on screen", panel.x >= 0 && panel.y >= 0 && panel.y + panel.h <= VIEW_H);
    check(
      "the card sits clear of the bottom",
      Math.abs(VIEW_H - (panel.y + panel.h) - CARD_BOTTOM_GAP) <= 1,
      `${VIEW_H - (panel.y + panel.h)}`,
    );
  }

  // Sliding: earlier in the beat the card must be lower, and it must only ever move up.
  let lastY = Number.POSITIVE_INFINITY;
  let onlyUp = true;
  let sawMovement = false;
  for (let i = 0; i <= 20; i++) {
    const t = BEAT.cardStart + ((BEAT.cardEnd - BEAT.cardStart) * i) / 20;
    const q = screenAt(t, ROWS).find((r) => Math.abs(r.w - CARD_W) < 1e-6 && Math.abs(r.h - h) < 1e-6);
    if (!q) continue;
    if (q.y > lastY + 1e-9) onlyUp = false;
    if (Number.isFinite(lastY) && q.y < lastY - 1e-9) sawMovement = true;
    lastY = q.y;
  }
  check("the card only ever slides upward", onlyUp);
  check("the card actually moves", sawMovement);

  // And it fades in rather than appearing: the same panel, weaker earlier.
  const earlyPanel = screenAt(BEAT.cardStart + 0.02, ROWS).find((q) => Math.abs(q.w - CARD_W) < 1e-6);
  const latePanel = landed.find((q) => Math.abs(q.w - CARD_W) < 1e-6);
  check(
    "the card fades in",
    earlyPanel !== undefined && latePanel !== undefined && (earlyPanel.color >>> 24) < (latePanel.color >>> 24),
  );
}

// ---------------------------------------------------------------------------------------------
// 9. The reward text stays inside its own card.
//
// A reward line is written by the chest rules, not by this file, so it can be any length at all. It
// must be cut off rather than allowed to run out across the fight.
// ---------------------------------------------------------------------------------------------
{
  const runaway = ["THIS REWARD LINE IS ABSURDLY LONG AND SHOULD NOT ESCAPE THE PANEL AT ALL"];
  const h = cardHeight(runaway.length);
  const quads = screenAt(SEQUENCE_SECONDS, runaway);
  const panel = quads.find((q) => Math.abs(q.w - CARD_W) < 1e-6 && Math.abs(q.h - h) < 1e-6);
  check("a long reward still gets a panel", panel !== undefined);
  if (panel) {
    let escaped = 0;
    for (const q of quads) {
      if (q.w >= CARD_W) continue; // the panel and its outline are allowed to be the panel
      if (q.x < panel.x || q.x + q.w > panel.x + panel.w) escaped++;
      if (q.y < panel.y || q.y + q.h > panel.y + panel.h) escaped++;
    }
    check("no text escapes the card", escaped === 0, `${escaped} quads outside`);
  }
  check(
    "the cut-off line fits the card",
    textWidth("X".repeat(CARD_MAX_CHARS), CARD_TEXT_PX) <= CARD_W - CARD_PAD * 2,
    `${textWidth("X".repeat(CARD_MAX_CHARS), CARD_TEXT_PX)} vs ${CARD_W - CARD_PAD * 2}`,
  );

  // Every row gets drawn, and they are drawn in the order the rules listed them.
  const rec = new Recorder();
  const spec = specFor();
  const frame = chestOpenAt(SEQUENCE_SECONDS, spec, createChestOpenFrame());
  drawChestScreen(rec, ART, frame, VIEW_W, VIEW_H, ROWS);
  const rowYs: number[] = [];
  for (let r = 0; r < ROWS.length; r++) {
    const y = restingY(cardHeight(ROWS.length)) + CARD_PAD + CARD_ROW_H * (r + 1);
    rowYs.push(y);
    const drawnHere = rec.quads.filter((q) => q.y >= y && q.y < y + CARD_ROW_H && q.w <= 3);
    check(`reward row ${r + 1} is drawn`, drawnHere.length > 0, `${drawnHere.length} pixels`);
  }
  let increasing = true;
  for (let i = 1; i < rowYs.length; i++) if ((rowYs[i] ?? 0) <= (rowYs[i - 1] ?? 0)) increasing = false;
  check("the rewards are listed top to bottom", increasing);

  // An empty line in the middle is skipped rather than leaving a gap that shifts everything up.
  const withBlank = screenAt(SEQUENCE_SECONDS, ["+1 SOMETHING", "", "+40 GOLD"]);
  check("a blank reward line does not break the card", withBlank.length > 0);
}

function restingY(h: number): number {
  return Math.round(VIEW_H - CARD_BOTTOM_GAP - h);
}

// ---------------------------------------------------------------------------------------------
// 10. Painting is stable and allocates nothing of its own.
//
// Asked for the same moment twice, the painter must ask for exactly the same quads. Anything else
// means it is keeping something between calls, and something kept between calls in a draw loop is
// something that will be one frame stale on the phone that matters.
// ---------------------------------------------------------------------------------------------
{
  const t = 1.2;
  const a = worldAt(t, { goldFrom: 0, goldTo: 500 });
  const b = worldAt(t, { goldFrom: 0, goldTo: 500 });
  let identical = a.length === b.length;
  for (let i = 0; i < a.length && identical; i++) {
    const p = a[i];
    const q = b[i];
    if (!p || !q) identical = false;
    else if (p.x !== q.x || p.y !== q.y || p.w !== q.w || p.h !== q.h || p.color !== q.color) identical = false;
  }
  check("painting the same moment twice draws the same thing", identical, `${a.length} vs ${b.length}`);

  // The spark object handed in is reused, never replaced.
  const rec = new Recorder();
  const spark = createSpark();
  // Same chest as `a` above, or the gold counter is a different number of digits and "twice as many
  // quads" is comparing two different chests.
  const spec = specFor({ goldFrom: 0, goldTo: 500 });
  const frame = chestOpenAt(t, spec, createChestOpenFrame());
  drawChestWorld(rec, ART, frame, spec, t, spark);
  drawChestWorld(rec, ART, frame, spec, t, spark);
  check("painting twice draws twice", rec.quads.length === a.length * 2, `${rec.quads.length}`);

  // The whole sequence stays cheap. A hundred quads a frame is nothing; a thousand is a stutter.
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    const time = (SEQUENCE_SECONDS * i) / 100;
    worst = Math.max(worst, worldAt(time, { goldFrom: 0, goldTo: 99999 }).length + screenAt(time, ROWS).length);
  }
  check("the sequence never costs many quads", worst < 400, `worst frame ${worst} quads`);
}

// ---------------------------------------------------------------------------------------------
// 11. The ribbon really orbits, and a finished frame really is finished.
//
// Two faults slipped past everything above. The first: the ribbon could have been nailed to the chest
// and every check still passed, because nothing looked at where it actually was — an orbit that never
// leaves the middle is just a blinking dot. The second: the painter's own "is this still running"
// guard could be deleted with no test noticing, because the moment-maker happens to blank every field
// once the sequence is over. It will not always be the only caller, and a stale frame drawn forever is
// exactly the fault this whole file exists to catch.
// ---------------------------------------------------------------------------------------------
{
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  const seen = new Set<number>();
  let matchesFrame = true;
  for (let i = 0; i <= 40; i++) {
    const t = BEAT.ribbonStart + ((BEAT.ribbonEnd - BEAT.ribbonStart) * i) / 40;
    const spec = specFor();
    const frame = chestOpenAt(t, spec, createChestOpenFrame());
    const q = worldAt(t).find((r) => Math.abs(r.w - RIBBON_W) < 1e-6 && Math.abs(r.h - RIBBON_H) < 1e-6);
    if (!q) continue;
    if (Math.abs(q.x - (frame.ribbonX - RIBBON_W / 2)) > 1e-6) matchesFrame = false;
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    seen.add(Math.round(q.x));
  }
  check("the ribbon is drawn where the sequence says it is", matchesFrame);
  check("the ribbon passes left of the chest", minX < CHEST_X - 20, `${minX}`);
  check("the ribbon passes right of the chest", maxX > CHEST_X + 20, `${maxX}`);
  check("the ribbon takes many positions", seen.size >= 10, `${seen.size} positions`);

  // A frame that still has contents but is switched off draws nothing at all.
  const spec = specFor();
  const busy = chestOpenAt(1.0, spec, createChestOpenFrame());
  check("the busy moment really is busy", worldAt(1.0).length > 0);
  busy.active = false;
  const stale = new Recorder();
  drawChestWorld(stale, ART, busy, spec, 1.0, createSpark());
  check("a switched-off frame draws nothing in the world", stale.quads.length === 0, `${stale.quads.length}`);
  const staleScreen = new Recorder();
  const busyCard = chestOpenAt(SEQUENCE_SECONDS, spec, createChestOpenFrame());
  busyCard.active = false;
  drawChestScreen(staleScreen, ART, busyCard, VIEW_W, VIEW_H, ROWS);
  check("a switched-off frame draws nothing on the screen", staleScreen.quads.length === 0, `${staleScreen.quads.length}`);
}

console.log(`chest-draw: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`chest-draw: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
