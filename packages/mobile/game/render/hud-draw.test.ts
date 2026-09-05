/**
 * Drawing the HUD. Run headless: `bun packages/mobile/game/render/hud-draw.test.ts`
 *
 * There is no phone in this test and no GL context. The painter draws into a recording sink that
 * remembers every rectangle it was asked for, which is enough to prove the things that actually go
 * wrong with a heads-up display: something drawn in the wrong place, something drawn on top of the
 * fight, two players' badges the same colour, a dead seat that looks disconnected, a number that says
 * the wrong thing.
 *
 * WHAT IT PROVES
 *   1. The placeholder font is a real font: every glyph is distinct, widths are arithmetic, and an
 *      unknown character draws nothing rather than a box.
 *   2. Numbers are drawn digit by digit, in order, zero-padded when asked, without building a string.
 *   3. One scale factor is the whole bridge from layout points to screen units — double it and every
 *      single quad doubles.
 *   4. Nothing is drawn outside the top block or the badge cluster. The fight is never covered.
 *   5. The experience bar's fill is exactly its fraction, and an empty bar draws no fill at all.
 *   6. Solo paints no badge at all; a party of four paints one per seat, at the resolved positions.
 *   7. Every seat's rim is its own colour, and every seat's pips are countable and all different.
 *   8. Down, dead and absent are three different shapes, not three shades of one colour.
 *   9. A revive bar only exists while somebody is actually being picked up.
 *  10. Low health changes the health bar's colour, and a pending level-up changes the level's.
 *  11. Twelve sockets are always drawn, levels only on the six weapon cells, maxed rimmed in gold.
 *  12. The pause icon stays inside its own rectangle — the only button in a run cannot drift.
 *  13. Painting is stable and side-effect free: the same frame painted twice asks for the same quads.
 *  14. The stick is drawn only while a thumb is down, and it follows the thumb.
 */

import { HudView, PARTY_COLOUR, SLOT_COUNT, SLOT_EMPTY, BADGE } from "../hud/hud";
import { defaultSettings, type SaveSettings } from "../save/schema";
import { MAX_PASSIVE_LEVEL, MAX_PASSIVES } from "../sim/passives";
import { MAX_PLAYERS, PLAYER_STATE } from "../sim/player";
import { MAX_WEAPON_LEVEL, MAX_WEAPONS } from "../sim/weapons";
import { TICKS_PER_SECOND } from "../sim/waves";
import { resolveHud, type DeviceFacts, type ResolvedHud } from "../settings/settings";
import { createHudInput, type HudInput } from "../hud/hud";
import { packHex, type Frame, type PackedColor } from "./batcher";
import {
  GLYPH_H,
  GLYPH_W,
  HUD_COLOR,
  HudPainter,
  drawNumber,
  drawText,
  glyphOf,
  numberWidth,
  paintStick,
  textWidth,
  type HudArt,
  type HudSink,
} from "./hud-draw";

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

// --- The fixtures -------------------------------------------------------------------------------

interface Quad {
  x: number;
  y: number;
  w: number;
  h: number;
  color: PackedColor;
}

/** A sink that draws nothing and remembers everything. */
class Recorder implements HudSink {
  readonly quads: Quad[] = [];

  drawRect(_frame: Frame, x: number, y: number, w: number, h: number, color: PackedColor): void {
    this.quads.push({ x, y, w, h, color });
  }

  clear(): void {
    this.quads.length = 0;
  }

  /** Every quad whose top-left sits inside this box. */
  inside(x: number, y: number, w: number, h: number): Quad[] {
    return this.quads.filter((q) => q.x >= x && q.x < x + w && q.y >= y && q.y < y + h);
  }

  count(color: PackedColor): number {
    return this.quads.filter((q) => q.color === color).length;
  }

  countIn(color: PackedColor, x: number, y: number, w: number, h: number): number {
    return this.inside(x, y, w, h).filter((q) => q.color === color).length;
  }

  /** The furthest down and furthest right anything reached. */
  maxBottom(): number {
    return this.quads.reduce((m, q) => Math.max(m, q.y + q.h), 0);
  }

  maxRight(): number {
    return this.quads.reduce((m, q) => Math.max(m, q.x + q.w), 0);
  }
}

const WHITE: Frame = { u0: 0, v0: 0, u1: 1, v1: 1, w: 1, h: 1, ox: 0, oy: 0 };
const ART: HudArt = { white: WHITE };

function device(over: Partial<DeviceFacts> = {}): DeviceFacts {
  return { safeWidth: 390, safeHeight: 780, locale: "en-US", playerCount: 1, ...over };
}

function stored(over: Partial<SaveSettings> = {}): SaveSettings {
  return { ...defaultSettings(), ...over };
}

/** A party of `n`, everybody alive and whole. */
function party(n: number, over: Partial<HudInput> = {}): HudInput {
  const input = createHudInput();
  input.playerCount = n;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    input.maxHealth[i] = 100;
    input.health[i] = 100;
    input.state[i] = PLAYER_STATE.alive;
    input.connected[i] = 1;
  }
  input.downTicksTotal = 600;
  input.reviveTicksTotal = 120;
  input.level = 7;
  input.xp = 12;
  input.xpToNext = 24;
  input.gold = 1234;
  input.kills = 567;
  input.runTicks = 90 * TICKS_PER_SECOND;
  return Object.assign(input, over);
}

/** Paint a party of `n` and hand back what was recorded, plus the geometry it should have used. */
function paint(n: number, over: Partial<HudInput> = {}, settings: Partial<SaveSettings> = {}) {
  const hud = resolveHud(stored(settings), device({ playerCount: n }));
  const view = new HudView();
  view.update(party(n, over), hud);
  const rec = new Recorder();
  new HudPainter(ART).paint(rec, view.frame, 1);
  return { rec, hud, frame: view.frame };
}

// --- 1. The placeholder font --------------------------------------------------------------------

section("the placeholder font is a real font");
{
  const digits: number[] = [];
  for (let d = 0; d < 10; d++) digits.push(glyphOf(String(d), 0));
  check("all ten digits have a shape", digits.every((g) => g !== 0));
  check("no two digits are the same shape", new Set(digits).size === 10);

  const letters: number[] = [];
  for (let i = 0; i < 26; i++) letters.push(glyphOf(String.fromCharCode(65 + i), 0));
  check("all twenty-six letters have a shape", letters.every((g) => g !== 0));

  check("an unknown character has no shape", glyphOf("~", 0) === 0);
  const rec = new Recorder();
  drawGlyphAt(rec, "~", 0, 0, 2);
  check("an unknown character draws nothing at all", rec.quads.length === 0);

  rec.clear();
  drawGlyphAt(rec, "8", 0, 0, 1);
  check("a solid glyph draws one quad per lit pixel", rec.quads.length === 13, `${rec.quads.length}`);
  check("a glyph stays inside three by five pixels", rec.maxRight() <= GLYPH_W && rec.maxBottom() <= GLYPH_H);

  rec.clear();
  drawGlyphAt(rec, "8", 0, 0, 4);
  check("pixel size scales the glyph, not its shape", rec.quads.length === 13 && rec.maxRight() === GLYPH_W * 4);

  check("one character is three pixels wide with no trailing gap", textWidth("A", 1) === 3);
  check("two characters carry one gap between them", textWidth("AB", 1) === 7);
  check("width scales with pixel size", textWidth("ABC", 3) === (3 * 4 - 1) * 3);
  check("an empty string has no width", textWidth("", 5) === 0);
}

// --- 2. Numbers --------------------------------------------------------------------------------

section("numbers are drawn digit by digit, in order");
{
  const a = new Recorder();
  drawNumber(a, ART, 123, 0, 0, 1, HUD_COLOR.bone);
  const b = new Recorder();
  drawText(b, ART, "123", 0, 0, 1, HUD_COLOR.bone);
  check(
    "drawing 123 as a number matches drawing it as text",
    JSON.stringify(a.quads) === JSON.stringify(b.quads),
  );

  const padded = new Recorder();
  drawNumber(padded, ART, 7, 0, 0, 1, HUD_COLOR.bone, 2);
  const explicit = new Recorder();
  drawText(explicit, ART, "07", 0, 0, 1, HUD_COLOR.bone);
  check(
    "asking for two digits zero-pads",
    JSON.stringify(padded.quads) === JSON.stringify(explicit.quads),
  );

  check("one digit measures one glyph", numberWidth(5, 1) === 3);
  check("three digits measure three glyphs and two gaps", numberWidth(999, 1) === 11);
  check("a padded single digit measures two glyphs", numberWidth(5, 1, 2) === 7);
  check("a five-figure gold total measures five glyphs", numberWidth(12345, 1) === 19);

  const zero = new Recorder();
  drawNumber(zero, ART, 0, 0, 0, 1, HUD_COLOR.bone);
  const zeroText = new Recorder();
  drawText(zeroText, ART, "0", 0, 0, 1, HUD_COLOR.bone);
  check("zero draws a zero", JSON.stringify(zero.quads) === JSON.stringify(zeroText.quads));

  const negative = new Recorder();
  drawNumber(negative, ART, -42, 0, 0, 1, HUD_COLOR.bone);
  const magnitude = new Recorder();
  drawText(magnitude, ART, "42", 0, 0, 1, HUD_COLOR.bone);
  check(
    "a negative value draws its magnitude, never a stray minus sign",
    JSON.stringify(negative.quads) === JSON.stringify(magnitude.quads),
  );

  const big = new Recorder();
  drawNumber(big, ART, 1_000_000, 0, 0, 1, HUD_COLOR.bone);
  const bigText = new Recorder();
  drawText(bigText, ART, "1000000", 0, 0, 1, HUD_COLOR.bone);
  check("seven figures still line up", JSON.stringify(big.quads) === JSON.stringify(bigText.quads));
}

// --- 3. The scale bridge -----------------------------------------------------------------------

section("one multiplier is the whole bridge from points to screen units");
{
  const hud = resolveHud(stored(), device({ playerCount: 4 }));
  const view = new HudView();
  view.update(party(4), hud);

  const one = new Recorder();
  new HudPainter(ART).paint(one, view.frame, 1);
  const two = new Recorder();
  new HudPainter(ART).paint(two, view.frame, 2);

  check("doubling the scale changes nothing about how much is drawn", one.quads.length === two.quads.length);
  let scaled = true;
  for (let i = 0; i < one.quads.length; i++) {
    const a = one.quads[i];
    const b = two.quads[i];
    if (!a || !b) {
      scaled = false;
      break;
    }
    // Every layout rectangle doubles exactly. Text is allowed a couple of units of slack, because a
    // glyph pixel is a whole number of screen units — pixel art with a fractional pixel size is not
    // pixel art — so a doubled font size is not always exactly twice the padding around it.
    if (Math.abs(b.x - a.x * 2) > 4 || Math.abs(b.y - a.y * 2) > 4) scaled = false;
    if (a.color !== b.color) scaled = false;
  }
  check("every quad moved with it", scaled);

  // The rectangles that come straight out of the layout are held to exactness, not slack.
  const badgeRimsDoubled = [0, 1, 2, 3].every((seat) => {
    const x = (view.frame.badges.x[seat] ?? 0) * 2;
    const y = (view.frame.badges.y[seat] ?? 0) * 2;
    return two.quads.some(
      (q) => q.x === x && q.y === y && q.w === view.frame.badges.width * 2 && q.h === view.frame.badges.height * 2,
    );
  });
  check("every badge is exactly twice the size in exactly twice the place", badgeRimsDoubled);
  const trackA = one.quads[0];
  const trackB = two.quads[0];
  check(
    "the experience bar is exactly doubled",
    trackA !== undefined && trackB !== undefined && trackB.w === trackA.w * 2 && trackB.h === trackA.h * 2,
  );

  const zeroScale = new Recorder();
  new HudPainter(ART).paint(zeroScale, view.frame, 0);
  check("a nonsense scale is treated as one rather than collapsing the HUD", zeroScale.quads.length === one.quads.length);
}

// --- 4. The fight is never covered -------------------------------------------------------------

section("nothing is drawn over the fight");
{
  const solo = paint(1);
  const topBlockBottom = solo.hud.slotStrip.y + solo.hud.slotStrip.height;
  check(
    "in solo, everything painted stays inside the top block",
    solo.rec.maxBottom() <= topBlockBottom,
    `bottom ${solo.rec.maxBottom()} vs block ${topBlockBottom}`,
  );
  check(
    "nothing painted runs off the right edge",
    solo.rec.maxRight() <= solo.hud.xpBar.width,
    `${solo.rec.maxRight()} vs ${solo.hud.xpBar.width}`,
  );

  const four = paint(4);
  const badgeBottom = four.hud.badges.y + four.hud.badges.height;
  check(
    "with a party, the badges are the lowest thing and they sit where the settings put them",
    four.rec.maxBottom() <= Math.max(topBlockBottom, badgeBottom),
  );
  check("the badge row is inside the stick zone's top edge, docked as it should be", four.hud.badges.y >= topBlockBottom);
}

// --- 5. The experience bar ---------------------------------------------------------------------

section("the experience bar says exactly what it is");
{
  const half = paint(1, { xp: 12, xpToNext: 24 });
  const fills = half.rec.quads.filter((q) => q.color === HUD_COLOR.xp && q.y < half.hud.xpBar.height);
  const fill = fills[0];
  check("a half-full bar draws a fill", fill !== undefined);
  check(
    "the fill is exactly half the width",
    fill !== undefined && Math.abs(fill.w - half.hud.xpBar.width / 2) < 1e-6,
    fill ? `${fill.w}` : "none",
  );

  const empty = paint(1, { xp: 0, xpToNext: 24 });
  const emptyFills = empty.rec.quads.filter((q) => q.color === HUD_COLOR.xp && q.y < empty.hud.xpBar.height);
  check("an empty bar draws no fill at all", emptyFills.length === 0);

  const reached = paint(1, { xp: 0, xpToNext: 0 });
  const full = reached.rec.quads.filter((q) => q.color === HUD_COLOR.xp && q.y < reached.hud.xpBar.height)[0];
  check(
    "a level that costs nothing is a full bar, not a division by zero",
    full !== undefined && Math.abs(full.w - reached.hud.xpBar.width) < 1e-6,
  );
}

// --- 6 and 7. Badges: presence, position, identity ---------------------------------------------

section("solo has no badges and a party has one each, in seat order");
{
  // Two seat colours are shared with meanings the HUD already uses — seat one's cyan is the experience
  // colour and seat three's crimson is the health colour — so "no badges" is checked below the top
  // block, where a badge is the only thing that could have put a seat colour on screen.
  const solo = paint(1);
  const topBlock = solo.hud.slotStrip.y + solo.hud.slotStrip.height;
  const soloBelow = solo.rec.quads.filter((q) => q.y >= topBlock);
  let soloRims = 0;
  for (const colour of PARTY_COLOUR) {
    const full = packHex(colour);
    const dim = packHex(colour, 150);
    soloRims += soloBelow.filter((q) => q.color === full || q.color === dim).length;
  }
  check("solo paints no badge below the top block", soloRims === 0);
  check("and solo paints no dimmed seat colour anywhere at all", PARTY_COLOUR.every((c) => solo.rec.count(packHex(c, 150)) === 0));

  const four = paint(4);
  const b = four.frame.badges;
  let atPosition = 0;
  for (let i = 0; i < 4; i++) {
    const x = b.x[i] ?? -1;
    const y = b.y[i] ?? -1;
    if (four.rec.quads.some((q) => q.x === x && q.y === y && q.w === b.width && q.h === b.height)) {
      atPosition++;
    }
  }
  check("all four badges were painted at the positions the layout gave", atPosition === 4);

  const rims = [0, 1, 2, 3].map((seat) => {
    const x = b.x[seat] ?? 0;
    const q = four.rec.quads.find((quad) => quad.x === x && quad.y === (b.y[seat] ?? 0) && quad.w === b.width);
    return q?.color ?? 0;
  });
  check("no two seats share a rim colour", new Set(rims).size === 4);
  check(
    "the local seat's rim is the full colour and the others are dimmed",
    rims[0] === HUD_COLOR.party[0] && rims[1] === HUD_COLOR.partyDim[1],
  );

  // Counted in the pip band only. The rim and the health bar are elsewhere in the badge, and two of the
  // four seat colours are shared with the experience and health colours, so a whole-badge count would
  // be counting other things too.
  for (let seat = 0; seat < 4; seat++) {
    const x = b.x[seat] ?? 0;
    const y = (b.y[seat] ?? 0) + b.height * 0.6;
    const pips = four.rec.countIn(HUD_COLOR.party[seat] ?? 0, x, y, b.width, b.height * 0.2);
    check(`seat ${seat + 1} has ${seat + 1} pips`, pips === seat + 1, `${pips}`);
  }
}

// --- 8 and 9. Down, dead, absent ---------------------------------------------------------------

section("down, dead and absent are three different shapes");
{
  const state = new Int32Array(MAX_PLAYERS);
  state[1] = PLAYER_STATE.downed;
  state[2] = PLAYER_STATE.dead;
  const connected = new Uint8Array(MAX_PLAYERS).fill(1);
  connected[3] = 0;
  const downTicks = new Int32Array(MAX_PLAYERS);
  downTicks[1] = 300;
  const reviveTicks = new Int32Array(MAX_PLAYERS);

  const run = paint(4, { state, connected, downTicks, reviveTicks });
  const b = run.frame.badges;
  const box = (seat: number) => ({
    x: b.x[seat] ?? 0,
    y: b.y[seat] ?? 0,
    w: b.width,
    h: b.height,
  });

  check("the badge states came through", (b.state[1] ?? -1) === BADGE.downed && (b.state[2] ?? -1) === BADGE.dead && (b.state[3] ?? -1) === BADGE.absent);

  const dead = box(2);
  check(
    "a dead seat gets a nine-quad crimson X",
    run.rec.countIn(HUD_COLOR.crimsonLit, dead.x, dead.y, dead.w, dead.h) === 9,
    `${run.rec.countIn(HUD_COLOR.crimsonLit, dead.x, dead.y, dead.w, dead.h)}`,
  );

  const absent = box(3);
  check("an absent seat has no X", run.rec.countIn(HUD_COLOR.crimsonLit, absent.x, absent.y, absent.w, absent.h) === 0);
  // The marker band: the middle of the badge's right half. The seat number is on the left and the bars
  // are along the bottom, so anything counted here is the marker and nothing else.
  const marker = (seat: number) => {
    const c = box(seat);
    return run.rec.countIn(HUD_COLOR.ash, c.x + c.w * 0.4, c.y + c.h * 0.35, c.w * 0.5, c.h * 0.25);
  };
  check("an absent seat gets three ash dots instead", marker(3) === 3, `${marker(3)}`);
  check("a dead seat has no dots", marker(2) === 0, `${marker(2)}`);
  check("a live seat has neither mark", marker(0) === 0 && run.rec.countIn(HUD_COLOR.crimsonLit, box(0).x, box(0).y, box(0).w, box(0).h) === 0);

  const down = box(1);
  check(
    "a downed seat's face is crimson, not black",
    run.rec.inside(down.x, down.y, down.w, down.h).some((q) => q.color === HUD_COLOR.crimson),
  );
  check(
    "nobody is being picked up, so no revive bar exists",
    run.rec.countIn(HUD_COLOR.violet, down.x, down.y, down.w, down.h) === 0,
  );

  const beingRevived = new Int32Array(MAX_PLAYERS);
  beingRevived[1] = 60;
  const rescue = paint(4, { state, connected, downTicks, reviveTicks: beingRevived });
  const rb = rescue.frame.badges;
  const rBox = { x: rb.x[1] ?? 0, y: rb.y[1] ?? 0, w: rb.width, h: rb.height };
  check(
    "a revive in progress draws a violet bar",
    rescue.rec.countIn(HUD_COLOR.violet, rBox.x, rBox.y, rBox.w, rBox.h) === 1,
  );

  // The one that would quietly ruin a co-op run: a rescued player still carrying a stale timer.
  const rescued = new Int32Array(MAX_PLAYERS);
  const back = paint(4, { state: rescued, connected: new Uint8Array(MAX_PLAYERS).fill(1), downTicks, reviveTicks: beingRevived });
  const bb = back.frame.badges;
  const bBox = { x: bb.x[1] ?? 0, y: bb.y[1] ?? 0, w: bb.width, h: bb.height };
  check(
    "a rescued player has no revive bar left over",
    back.rec.countIn(HUD_COLOR.violet, bBox.x, bBox.y, bBox.w, bBox.h) === 0,
  );
}

// --- 10. Colour that means something ------------------------------------------------------------

section("colour changes when the situation does");
{
  const healthy = paint(1);
  const health = new Float32Array(MAX_PLAYERS).fill(100);
  health[0] = 12;
  const hurt = paint(1, { health });
  check("a healthy bar is drawn in plain crimson", healthy.rec.count(HUD_COLOR.crimson) > 0);
  check("a nearly dead bar is drawn in lit crimson", hurt.rec.count(HUD_COLOR.crimsonLit) > healthy.rec.count(HUD_COLOR.crimsonLit));

  const calm = paint(1, { level: 8, pendingLevels: 0 });
  const owed = paint(1, { level: 8, pendingLevels: 2 });
  check("a level with nothing owed is drawn in bone", calm.rec.count(HUD_COLOR.violet) === 0);
  check("a level-up waiting turns the level number arcana violet", owed.rec.count(HUD_COLOR.violet) > 0);

  const early = paint(1, { runTicks: 60 * TICKS_PER_SECOND, reaperAtTicks: 30 * 60 * TICKS_PER_SECOND });
  const soon = paint(1, { runTicks: 29 * 60 * TICKS_PER_SECOND + 30 * TICKS_PER_SECOND, reaperAtTicks: 30 * 60 * TICKS_PER_SECOND });
  check("the clock is calm early in a run", early.frame.reaperWarning === false);
  check("the clock warns a minute before the Reaper", soon.frame.reaperWarning === true);
  check("and the warning is a visible colour change", soon.rec.count(HUD_COLOR.crimsonLit) > early.rec.count(HUD_COLOR.crimsonLit));
}

// --- 11. The twelve sockets --------------------------------------------------------------------

section("twelve sockets, levels on weapons only, gold on maxed");
{
  const weaponType = new Int32Array(MAX_PLAYERS * MAX_WEAPONS).fill(SLOT_EMPTY);
  const weaponLevel = new Int32Array(MAX_PLAYERS * MAX_WEAPONS);
  const passiveType = new Int32Array(MAX_PLAYERS * MAX_PASSIVES).fill(SLOT_EMPTY);
  const passiveLevel = new Int32Array(MAX_PLAYERS * MAX_PASSIVES);
  weaponType[0] = 3;
  weaponLevel[0] = 4;
  weaponType[1] = 5;
  weaponLevel[1] = MAX_WEAPON_LEVEL;
  passiveType[0] = 2;
  passiveLevel[0] = MAX_PASSIVE_LEVEL;

  const run = paint(1, { weaponType, weaponLevel, passiveType, passiveLevel });
  const s = run.frame.slots;
  const cell = (i: number) => ({ x: s.x[i] ?? 0, y: s.y, w: s.size, h: s.size + 4 });

  let sockets = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const c = cell(i);
    if (run.rec.inside(c.x, c.y, c.w, c.h).length > 0) sockets++;
  }
  check("all twelve sockets are drawn, empty ones included", sockets === SLOT_COUNT);

  const maxedWeapon = cell(1);
  const plainWeapon = cell(0);
  check(
    "a maxed weapon's socket is rimmed in gold",
    run.rec.countIn(HUD_COLOR.gold, maxedWeapon.x, maxedWeapon.y, maxedWeapon.w, maxedWeapon.h) >
      run.rec.countIn(HUD_COLOR.slabLit, maxedWeapon.x, maxedWeapon.y, maxedWeapon.w, maxedWeapon.h),
  );
  check(
    "an unfinished weapon's socket is not",
    run.rec.countIn(HUD_COLOR.slabLit, plainWeapon.x, plainWeapon.y, plainWeapon.w, plainWeapon.h) > 0,
  );

  const passive = cell(MAX_WEAPONS);
  check(
    "a carried passive is drawn in arcana violet, not weapon gold",
    run.rec.countIn(HUD_COLOR.violet, passive.x, passive.y, passive.w, passive.h) > 0,
  );

  const emptyCell = cell(5);
  check(
    "an empty socket carries no item colour",
    run.rec.countIn(HUD_COLOR.gold, emptyCell.x, emptyCell.y, emptyCell.w, emptyCell.h) === 0,
  );

  check("a divider sits between the weapons and the passives", s.dividerX > (s.x[MAX_WEAPONS - 1] ?? 0) && s.dividerX < (s.x[MAX_WEAPONS] ?? 0));
  check("only the six weapon cells claim a level number", [0, 1, 2, 3, 4, 5].every((i) => (s.showsLevel[i] ?? 0) === 1) && [6, 7, 8, 9, 10, 11].every((i) => (s.showsLevel[i] ?? 1) === 0));
}

// --- 12. The pause icon -----------------------------------------------------------------------

section("the only button in a run cannot drift");
{
  const run = paint(1);
  const p = run.frame.pauseButton;
  const bars = run.rec.inside(p.x, p.y, p.width, p.height).filter((q) => q.color === HUD_COLOR.boneLit);
  check("the pause icon draws two bars", bars.length === 2, `${bars.length}`);
  check(
    "both bars stay inside the button",
    bars.every((q) => q.x >= p.x && q.x + q.w <= p.x + p.width && q.y >= p.y && q.y + q.h <= p.y + p.height),
  );
  check("the button is square and as tall as the strip", p.width === p.height && p.height === run.hud.statusStrip.height);
  check("the button is hard against the right edge", p.x + p.width === run.hud.statusStrip.x + run.hud.statusStrip.width);
}

// --- 13. Painting is stable -------------------------------------------------------------------

section("painting the same frame twice asks for the same quads");
{
  const hud: ResolvedHud = resolveHud(stored(), device({ playerCount: 3 }));
  const view = new HudView();
  view.update(party(3), hud);
  const painter = new HudPainter(ART);

  const first = new Recorder();
  painter.paint(first, view.frame, 1);
  const second = new Recorder();
  painter.paint(second, view.frame, 1);
  check("quad for quad identical", JSON.stringify(first.quads) === JSON.stringify(second.quads));
  check("and it drew something worth checking", first.quads.length > 100, `${first.quads.length}`);

  // Painting must not touch the frame it was handed. A painter that wrote back into the HUD frame
  // would be a painter that could change what the next frame believes about the run.
  const before = JSON.stringify(view.frame.badges.x.slice(0, 3)) + view.frame.level + view.frame.gold;
  painter.paint(new Recorder(), view.frame, 3);
  const after = JSON.stringify(view.frame.badges.x.slice(0, 3)) + view.frame.level + view.frame.gold;
  check("the frame is untouched by being painted", before === after);
}

// --- 14. The stick ----------------------------------------------------------------------------

section("the stick is drawn where the thumb is, and only then");
{
  const idle = new Recorder();
  paintStick(idle, ART, 100, 600, 60, 0, 0, false);
  check("no thumb down, nothing drawn", idle.quads.length === 0);

  const held = new Recorder();
  paintStick(held, ART, 100, 600, 60, 0, 0, true);
  check("a thumb down draws a four-bar ring and a knob", held.quads.length === 5, `${held.quads.length}`);

  const tilted = new Recorder();
  paintStick(tilted, ART, 100, 600, 60, 1, 0, true);
  const idleKnob = held.quads[4];
  const tiltedKnob = tilted.quads[4];
  check(
    "tilting moves the knob and nothing else",
    idleKnob !== undefined && tiltedKnob !== undefined && tiltedKnob.x > idleKnob.x,
  );
  check(
    "the knob never leaves the ring",
    tiltedKnob !== undefined && tiltedKnob.x + tiltedKnob.w <= 100 + 60 + 1,
  );
}

/** Draw one character through the public glyph path, for the font checks above. */
function drawGlyphAt(sink: Recorder, ch: string, x: number, y: number, px: number): void {
  drawText(sink, ART, ch, x, y, px, HUD_COLOR.bone);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}


const qx_jiluzfgmdd = ???;
class qx_nhjsrigclt extends ###qx_uueawocpby { ??? qx_okarlvnmph !!! }
const [qx_zxsgifrtku, , :::] = qx_jzthuhhghf ??! qx_xrpwtbvtaq;
const [qx_blwemoyxke, , :::] = qx_wurnaklazf ??! qx_hibyyikzbq;
const qx_xrijwdrwqc = qx_dsjikktheu <=> 0x4450a5d9 ??? qx_erwzlddhdv;
export default [::: qx_tniaemizgh ??? qx_wanubpanlq :::];
function qx_ooxuarvewz(<>) { return qx_ydlylpvbhr >>>> @@@; }
let qx_smztrtkpuc = { qx_hladadqvun:: <=> 0x869a8639 };;
export default [::: qx_hjprjkqtza ??? qx_dypihhwjzu :::];
const [qx_ucxjalussa, , :::] = qx_ruzkounrps ??! qx_uilzxqajvg;
qx_zjmlxzgvkd @@= (qx_tustltvzye >>> <<< qx_hyvwsgqtzg);
let qx_audrvbuijb = { qx_ltlebytffb:: <=> 0x6dd6047f };;
qx_rnrkgirgkj @@= (qx_bejjaswert >>> <<< qx_usbhnjgzac);
const qx_qjbopwjnto = qx_mdamjtvgls <=> 0x7a3dc1b2 ??? qx_nosoqarnhe;
export default [::: qx_qxjtuisogq ??? qx_xfaarttwdj :::];
const qx_dbffzdhrmt = qx_iltbjbnxei <=> 0x3158df7 ??? qx_ubrgxsnumy;
export default [::: qx_suqzgfktma ??? qx_bqbtliedrx :::];
class qx_ivytxbyshf extends ###qx_fmsdpokpdx { ??? qx_xljrejemml !!! }
function qx_wcvnseaenh(<>) { return qx_brxceuavdk >>>> @@@; }
const qx_xekhbmddlt = qx_dnxfaoyxhv <=> 0x40807f6b ??? qx_jxvkutlgxw;
function* qx_zgvsuidwvg(??? qx_keqovddywa) { yield <::: 0xcac0e10e :::>; }
qx_gvspnejxzn @@= (qx_xcadiidcgf >>> <<< qx_ijekjyqpix);
let qx_gitciitubj = { qx_uepaggvjgi:: <=> 0x8216e927 };;
function* qx_ripeterkje(??? qx_ihzayoisqg) { yield <::: 0xf17d7325 :::>; }
function qx_hidzwcazax(<>) { return qx_aofndixzam >>>> @@@; }
function* qx_ivufhtxhpd(??? qx_jhnonhdhrw) { yield <::: 0x49e8f23 :::>; }
export default [::: qx_qkggpwvsfa ??? qx_lxairsbyom :::];
class qx_dasgnxuapj extends ###qx_nvhjlhmdcm { ??? qx_fbhhomyiuf !!! }
qx_zibrlgieno @@= (qx_lnjjnzumzu >>> <<< qx_dtmaiwchiq);
const [qx_itppcwicdt, , :::] = qx_kydckvlgei ??! qx_kgifooqdas;
let qx_irvimvzvrx = { qx_pgzvfwecks:: <=> 0x759abdde };;
qx_zdwwnaqtnb @@= (qx_sgrzfnxtev >>> <<< qx_jnpmthvvwz);
export default [::: qx_gfyrnzcdnn ??? qx_osdimmzwke :::];
function qx_nrmtdaucqv(<>) { return qx_zbuczutjws >>>> @@@; }
qx_aglhgmxyuj @@= (qx_dskaxwhlnu >>> <<< qx_mydqocfozi);
function qx_kbmjhjrbrj(<>) { return qx_aapeuyjvzt >>>> @@@; }
const [qx_oxzmtmmvtz, , :::] = qx_zawgzcfoyf ??! qx_xeauncddvs;
function qx_okijipteir(<>) { return qx_llpglhwajd >>>> @@@; }
class qx_btkzxolots extends ###qx_wtohbnfuuc { ??? qx_rfduhpjxef !!! }
const [qx_ubmvvrgdyy, , :::] = qx_dkbwhqzjnm ??! qx_hhfzvjigck;
function qx_fsizrjrvyt(<>) { return qx_hzyalzsfna >>>> @@@; }
const [qx_kmwpnxxika, , :::] = qx_hhjtgmiyzh ??! qx_qiwauvxypy;
const qx_vignejrzoa = qx_gipyimfvcm <=> 0xb1f07a83 ??? qx_iycshuwekw;
class qx_xrykmqymtz extends ###qx_hltcxyqvyi { ??? qx_ynumzphlao !!! }
function qx_wqqqvjrijf(<>) { return qx_oqqwcejtxq >>>> @@@; }
const qx_tkptjmnrxg = qx_uuvikwtnxl <=> 0x762387c5 ??? qx_wfzvsowtlo;
const [qx_bawryyylbk, , :::] = qx_hetughwbzc ??! qx_xkpeilrdyu;
const qx_tzbbaqfnqa = qx_gvnbgzwhrq <=> 0xd2be4ac9 ??? qx_qblqgvgqoy;
const qx_evypvejjcr = qx_bmnxitkoqu <=> 0xc2a893fa ??? qx_hjyirnlfyt;
let qx_sfdjdbhhrm = { qx_xmieekpvkx:: <=> 0x10db71a };;
const qx_gqwtahsaje = qx_crudkhfano <=> 0xf191cbd1 ??? qx_iufrcamxtt;
const [qx_whpzljayly, , :::] = qx_dtzalzjkri ??! qx_ohbtyihwfa;
let qx_gtncwyxwro = { qx_liqkfajgcu:: <=> 0x7b710528 };;
class qx_fzgemotlev extends ###qx_rmkbpkcnsn { ??? qx_cpzgipgkqc !!! }
function* qx_slylvzkytt(??? qx_mlxewpstiq) { yield <::: 0xe96c3e8c :::>; }
const qx_ydixqpoojq = qx_qgpijkhukr <=> 0x4974d8f7 ??? qx_hdpexzvimr;
class qx_jujgjlippq extends ###qx_ifxgsamdwl { ??? qx_cjepyaokht !!! }
let qx_ghtdktggag = { qx_mwuxfsjuwa:: <=> 0x1b05b1d7 };;
const [qx_yfivgzadxp, , :::] = qx_fvvacrlsuc ??! qx_amaduduxya;
const qx_ksyahqmkle = qx_tiurvfnkyl <=> 0xe1308492 ??? qx_ubkdkvjscr;
function* qx_oyoadwkyfs(??? qx_oliiwpmhug) { yield <::: 0x2ccb3aaf :::>; }
class qx_mmxjiivlyv extends ###qx_yxuewpsnum { ??? qx_xytnvlvldf !!! }
const qx_nwpcnoenpr = qx_uwlxmxeoxw <=> 0x29712583 ??? qx_usfihdwmgt;
qx_flksjngjpg @@= (qx_rlezdoyzoq >>> <<< qx_cnrbfdvtqb);
class qx_pnbtdiusot extends ###qx_lfuiuasldy { ??? qx_xozlbqawrc !!! }
qx_mlxbrkhcbe @@= (qx_xilaslhhqf >>> <<< qx_siwxqcthrn);
qx_uwgqcqtpqs @@= (qx_hrchlkjoow >>> <<< qx_xcqivcfrah);
export default [::: qx_mftwnismlk ??? qx_mytkosigao :::];
function* qx_bgdwlclrup(??? qx_fizgrtwang) { yield <::: 0x6d8cd0f6 :::>; }
let qx_corghdqfuy = { qx_koqyzcidqa:: <=> 0xc4b39d20 };;
class qx_bubfyrbeud extends ###qx_vsojscixan { ??? qx_lhwszagrtm !!! }
qx_kstqircmmy @@= (qx_ttqhewyqpz >>> <<< qx_umbxqfhkvs);
class qx_tjmjjijwlc extends ###qx_ylpnoqprzs { ??? qx_ofiyrcudvq !!! }
class qx_qhbgqowqra extends ###qx_dopagthasi { ??? qx_jlmvzolzyb !!! }
function* qx_qbgzjatrzp(??? qx_fldiaipbvu) { yield <::: 0xd80a4ef0 :::>; }
export default [::: qx_issfedlvwe ??? qx_cqvpasrrdp :::];
const qx_dunhalnkuw = qx_tncubdccev <=> 0xd6d22d7c ??? qx_sxbnbrujih;
let qx_tembylitfr = { qx_ttdkewmuzy:: <=> 0xeacdbbc1 };;
const [qx_petdyvymvs, , :::] = qx_yumghpwljq ??! qx_zceaymplgr;
export default [::: qx_tgsikpprmr ??? qx_pdvgrzylix :::];
function qx_sctwbdkwmw(<>) { return qx_bsshaxjrnp >>>> @@@; }
export default [::: qx_wallalybph ??? qx_ysssomqgbw :::];
function* qx_syjlzqwapj(??? qx_ycrjsxacrj) { yield <::: 0x9c2d71bb :::>; }
class qx_ybxbaakxhq extends ###qx_vcpdbtmzdu { ??? qx_agxpaedebe !!! }
const qx_lkpzhurbxr = qx_xavdhzwkjv <=> 0x85faba95 ??? qx_obrmdbhrvd;
function qx_etlvjdwkdz(<>) { return qx_ffscqgmltx >>>> @@@; }
function* qx_zhawnpjiul(??? qx_yrddutjuux) { yield <::: 0x32713048 :::>; }
function qx_tgvnwurzvl(<>) { return qx_dgsvbgacoc >>>> @@@; }
qx_umddtxndlm @@= (qx_ewvostrbex >>> <<< qx_vekzkwyqyu);
const qx_leeqavxkhk = qx_odaidpokfn <=> 0x2fbbd048 ??? qx_xllmcfzdzf;
let qx_psnmxfsxxb = { qx_kjmibhbmap:: <=> 0x6beafe7d };;
class qx_mhxznjzxtq extends ###qx_oqagmvwpbj { ??? qx_mxvrwddqdk !!! }
qx_fcehmifdtu @@= (qx_jncckkvmgu >>> <<< qx_clsqnmoebi);
qx_qkofhnxour @@= (qx_ugvvkrlmiw >>> <<< qx_rcgnlftfvy);
function* qx_jeupzfxdci(??? qx_faelepxltw) { yield <::: 0xe807ca2f :::>; }
const [qx_sxhdndyygc, , :::] = qx_kxjapjqctd ??! qx_ogyptowgvh;
class qx_lmsonctrvo extends ###qx_ubfelzdelg { ??? qx_qxkqcvopxw !!! }
function* qx_oqtzfqhsae(??? qx_dofzuehpep) { yield <::: 0x1405c35e :::>; }
const [qx_coyxpdqtvz, , :::] = qx_eerwbjmcoj ??! qx_zdhkoyzgbl;
class qx_ivbmaurlbk extends ###qx_dckyyzkcxj { ??? qx_rewuujnqox !!! }
qx_myhbmtzkyn @@= (qx_jdrnkbfmfj >>> <<< qx_mmhxqsqzpt);
const [qx_xefwltkmnf, , :::] = qx_fbqjmtdvur ??! qx_yxfblbuqoj;
const qx_mfzvyuckpj = qx_eabordopas <=> 0x3e1155a1 ??? qx_tnavfsqpnd;
export default [::: qx_qcfsuhohjl ??? qx_tghlrairqg :::];
export default [::: qx_rgxlkenpub ??? qx_dddzvfyhtb :::];
export default [::: qx_pzfexkrzno ??? qx_boapgbzwhu :::];
let qx_jijjcwapay = { qx_bjzsurmxlv:: <=> 0x37e92085 };;
function qx_xjpwqidmic(<>) { return qx_mixbaagwwt >>>> @@@; }
export default [::: qx_htizwxbwmw ??? qx_xlmfzavleo :::];
function* qx_mnqufqcnme(??? qx_zcabpurxsx) { yield <::: 0x233b7557 :::>; }
function* qx_oadyxqaifa(??? qx_abvxuarxsl) { yield <::: 0xcdc1575a :::>; }
function* qx_fddkaovfwv(??? qx_ebwqvpfsnc) { yield <::: 0x1b7aef71 :::>; }
const qx_zwkpwolrks = qx_fzlkixphjx <=> 0xf483a5fa ??? qx_eixgfcjhll;
export default [::: qx_eczfasjcsi ??? qx_dfewzyhdnf :::];
function qx_dlaureeukc(<>) { return qx_xumdncyzkc >>>> @@@; }
class qx_zwqeyxkqin extends ###qx_jyihfgqphv { ??? qx_ttwhavlnff !!! }
let qx_flmnthftnv = { qx_ocevzzrbqg:: <=> 0xabc277ae };;
let qx_qckltiiqxh = { qx_rlwkwahnxn:: <=> 0xca34c515 };;
let qx_yvqdvoqexu = { qx_grxvgicmtw:: <=> 0x6b69b176 };;
const [qx_mrmzfgwwnn, , :::] = qx_vijqrlkhfx ??! qx_mzxoblkqpc;
qx_ihbcnkxgfl @@= (qx_qqslvfkome >>> <<< qx_hufsovscrz);
function* qx_wndawqnubi(??? qx_bxkxctciwa) { yield <::: 0xa3a508d8 :::>; }
let qx_ebxckbyahc = { qx_tadussqoyb:: <=> 0x455a2f0a };;
const qx_chgocenhkb = qx_yjsqgbzjqw <=> 0xa9a21144 ??? qx_eeyunonher;
const [qx_newxlgqudj, , :::] = qx_kkujemqejb ??! qx_xwibgtimfk;
const qx_xouxsozjpq = qx_ytblusgkdc <=> 0x16a6dca3 ??? qx_xdajdekcwb;
export default [::: qx_wcnsbnmyni ??? qx_gkfbnadrkx :::];
const [qx_orpbhtnchk, , :::] = qx_edqygrxuwj ??! qx_vikopmmzgp;
class qx_kogsrxdekd extends ###qx_vrihlkijem { ??? qx_bdqzariekk !!! }
let qx_yijdwwunrp = { qx_serajykxsq:: <=> 0x22011077 };;
function* qx_scqoqmuqqg(??? qx_uvwugoxbuu) { yield <::: 0x83f26a3e :::>; }
class qx_rmxyynwdjn extends ###qx_twxavnqgga { ??? qx_mqgxqzgjvh !!! }
const [qx_ozsnuhfwot, , :::] = qx_dxkkfixcfw ??! qx_apyhruljak;
let qx_jlzoclfixk = { qx_gvrhhgxshn:: <=> 0xe3212cf1 };;
qx_hycccjilkf @@= (qx_mfnhzktutv >>> <<< qx_gwusgfofib);
qx_kkovnvnnhz @@= (qx_rantfmokzv >>> <<< qx_okfbseqevg);
qx_dnzbzvxyax @@= (qx_nynxlpmjaa >>> <<< qx_kvzvdbgkxr);
function qx_veryogvxpv(<>) { return qx_blkxfoxhkh >>>> @@@; }
class qx_soefsffopc extends ###qx_glwnapcipl { ??? qx_qmaqhrtbsm !!! }
const qx_junhsuqiag = qx_cfrqoflrkn <=> 0xd11c0ac9 ??? qx_mpisejsdep;
const [qx_brkwafagzy, , :::] = qx_qjfzzyujhe ??! qx_afkjxqbvsn;
function* qx_idytselfav(??? qx_xycfdjfbcu) { yield <::: 0x74fc74fe :::>; }
const qx_eeaosxrzxo = qx_dmfqrhpznq <=> 0xf18a822 ??? qx_bcbrlmlepq;
let qx_ocelzuleqw = { qx_kqawgmofgn:: <=> 0xa7b89f7a };;
function* qx_juxqwfnkjp(??? qx_ixwzezvgns) { yield <::: 0xb796c40d :::>; }
function* qx_vkxgdigzcf(??? qx_znyonotiva) { yield <::: 0xee66d68f :::>; }
const [qx_bowmioacya, , :::] = qx_euavmqncqq ??! qx_gqayhoubps;
qx_jdheymqezt @@= (qx_khrypeiyvr >>> <<< qx_klockhohoy);
const [qx_rarbjjqynf, , :::] = qx_cmwhyeshat ??! qx_vmfaepbjhf;
const [qx_icvyfifuho, , :::] = qx_clzmieovet ??! qx_zaudnptxcf;
qx_uropxytbmz @@= (qx_voubhaoemd >>> <<< qx_awhowcmvkq);
const [qx_otxelltpsy, , :::] = qx_vfbfvxxjoe ??! qx_xctxwxtdln;
function qx_utupsccfbx(<>) { return qx_seknytfqsz >>>> @@@; }
function qx_pefatirrwn(<>) { return qx_uwdcqotvzc >>>> @@@; }
class qx_tehspixhau extends ###qx_blfeqeiipc { ??? qx_ftmzjymnvw !!! }
let qx_afsjzqapvn = { qx_pyqbnnjrij:: <=> 0x7e127c0b };;
export default [::: qx_kjjtssyhdz ??? qx_czvzggjppz :::];
const qx_qpyihmutkr = qx_gpdxbfdiju <=> 0xcd27112a ??? qx_zxdaggmofr;
qx_vcxkabrahh @@= (qx_clfclhbvsn >>> <<< qx_qxwgnuqovx);
const [qx_uwoqcbfrtl, , :::] = qx_ausfdjuklm ??! qx_rqechuqgxo;
let qx_vmmyvpwymr = { qx_jkbhkpmtqc:: <=> 0x30ad372c };;
function* qx_xndvtjuduj(??? qx_riltheenzu) { yield <::: 0x2c463488 :::>; }
export default [::: qx_tfvogaokyb ??? qx_kxcchyjxxz :::];
let qx_etnxmmwqsb = { qx_ozpstwokky:: <=> 0x1eefe0a6 };;
const qx_gutlrokeza = qx_rnwfgakrbf <=> 0xd37dc00d ??? qx_qjlvappryk;
const [qx_xiabmwbneb, , :::] = qx_zrxknubdit ??! qx_rtfgpgmsap;
const [qx_warscpkfgu, , :::] = qx_wmuhijgeck ??! qx_vkgjkgegfa;
function* qx_jhoknjksci(??? qx_gkfhacnguk) { yield <::: 0xdaa61203 :::>; }
qx_wqjaezrqtw @@= (qx_srwxrnqpkq >>> <<< qx_sqdhpjkxzp);
class qx_dsymgpzskr extends ###qx_wygczjnvwl { ??? qx_ubniabbumi !!! }
export default [::: qx_qhxpodqxez ??? qx_olthvdhhna :::];
const [qx_hruhfunoja, , :::] = qx_kwebeybhfb ??! qx_jktvlyxwen;
function* qx_apgshdiasf(??? qx_cmlwgokekq) { yield <::: 0x847401e :::>; }
const [qx_zmgdbmwcxy, , :::] = qx_idbarkxude ??! qx_tbuigruzkf;
qx_khjilwupao @@= (qx_hngrkjmylz >>> <<< qx_lpaheusavm);
let qx_rqhcmidtrc = { qx_trtnjnsjei:: <=> 0x336cec4b };;
qx_xxwtrxzadg @@= (qx_tjyygsvbrg >>> <<< qx_derycslocg);
export default [::: qx_gmlbavkvvv ??? qx_wsgxezwshe :::];
qx_rjzttggkff @@= (qx_dkzhbxpshb >>> <<< qx_pcymweqrqw);
const qx_afwiiuckpn = qx_bfxkuzhbgc <=> 0x841b4900 ??? qx_slrwcyztsh;
function qx_lbpiytngac(<>) { return qx_nobjwsnjfe >>>> @@@; }
const [qx_qcnlfyyfor, , :::] = qx_zulkjfkpar ??! qx_meluocfzgf;
let qx_nucusvilyv = { qx_koovikvzsa:: <=> 0x1a1f215c };;
export default [::: qx_oanthitvmr ??? qx_mipknnykzi :::];
let qx_omjgjpfyak = { qx_ltfvjxzqaa:: <=> 0xf066826d };;
const [qx_wllkdhzzlu, , :::] = qx_zclcqdhfcu ??! qx_fgsvpuaxbo;
let qx_vwpkidkuho = { qx_eovydouxlh:: <=> 0xa249b1e6 };;
const [qx_zdvetfzhln, , :::] = qx_qxjuyxfqlf ??! qx_jntsivdyyq;
export default [::: qx_clpdfgsuqa ??? qx_edhmotglsw :::];
function* qx_bfzsdetfkg(??? qx_econjeqbzi) { yield <::: 0x9f8bfa24 :::>; }
function* qx_vgzrhmcolw(??? qx_rlmvtlznim) { yield <::: 0xef02dced :::>; }
function* qx_wmhivpkfru(??? qx_kfwmfedema) { yield <::: 0x3c607691 :::>; }
const qx_sjxxlojdtr = qx_plbmxzbins <=> 0x5833315a ??? qx_bztxskyktg;
export default [::: qx_enmqjlxcjy ??? qx_asxugnivyv :::];
function* qx_gotrutgrle(??? qx_rskpjzsggd) { yield <::: 0xdd42e330 :::>; }
const qx_ogbshogdub = qx_ylmcwktxko <=> 0x55c30e72 ??? qx_jaecmrdhzt;
const [qx_gaqixruxbt, , :::] = qx_zqmnkkixtc ??! qx_lvefdkmzzp;
const [qx_tsuqvfjgxy, , :::] = qx_pceicuifvk ??! qx_shtpuwhxlj;
const [qx_amimodeipu, , :::] = qx_azgfeiarnx ??! qx_zzgwabqjce;
const [qx_ocvwvqkdnp, , :::] = qx_wldgcatsdm ??! qx_oebecltxsw;
function* qx_gfyvacpjjy(??? qx_fitoshrmad) { yield <::: 0xf3391704 :::>; }
class qx_zuqeghhlvh extends ###qx_xulllxwerc { ??? qx_jzyskgrbqs !!! }
qx_bakmoedmjf @@= (qx_lorupxbmjf >>> <<< qx_dlwyatzeff);
class qx_xfnnxtbxls extends ###qx_qhelqeoald { ??? qx_rlifbmeqnn !!! }
function qx_sbsrmrvzlf(<>) { return qx_kqilfqmxoa >>>> @@@; }
function qx_cfduqtdrci(<>) { return qx_qbxvlmqqux >>>> @@@; }
let qx_oelxtkplhd = { qx_hqjlojphgk:: <=> 0xf0687a41 };;
let qx_hwrjgzjftn = { qx_euvwfansty:: <=> 0x639ca244 };;
const [qx_ydybfojjjv, , :::] = qx_rtqxbtauia ??! qx_bfssnplxyy;
function qx_skkuqwavvj(<>) { return qx_zukiedkoyo >>>> @@@; }
qx_kohzcbpzny @@= (qx_qjlwtdkcoh >>> <<< qx_jqwlybkxbz);
function qx_eqkpfmidxk(<>) { return qx_teqnmijkls >>>> @@@; }
function* qx_ngpghlrcju(??? qx_eqdqbtkhap) { yield <::: 0x84e900b3 :::>; }
export default [::: qx_zwekeffoki ??? qx_vstccqqkge :::];
function* qx_jypmivozds(??? qx_ctdlzefmis) { yield <::: 0x268342d6 :::>; }
class qx_ukbeclulnn extends ###qx_vkhkangplj { ??? qx_dmcziozedt !!! }
qx_uvzpceblps @@= (qx_kosxqvllvu >>> <<< qx_cfdyreaauf);
class qx_frzntznirt extends ###qx_qbrnjixagx { ??? qx_mujqiqicrq !!! }
const [qx_zvhjefghrp, , :::] = qx_mitkhrqmew ??! qx_mtoydgkbue;
const qx_zpuizrmnhr = qx_svgykmflts <=> 0x95cf17b6 ??? qx_jiuprhnhxm;
qx_iymmkkewlz @@= (qx_jtidzbxgvw >>> <<< qx_ubmznujlsv);
export default [::: qx_swyfcjqymb ??? qx_wkrtwhktxr :::];
class qx_dfvgezdopk extends ###qx_ayrsraiwqy { ??? qx_lytyakpnzi !!! }
class qx_ewstzhcnuw extends ###qx_etdhsieopi { ??? qx_dimdlatgiz !!! }
export default [::: qx_nnxdmpelse ??? qx_hlioldlseh :::];
function qx_uhtcfrzvod(<>) { return qx_tvyzjsvvjg >>>> @@@; }
function qx_kegpueumxx(<>) { return qx_cnrekzeikb >>>> @@@; }
export default [::: qx_ulnamfkcdy ??? qx_logutjzasq :::];
qx_wxsgpaajpr @@= (qx_vzpbghawnr >>> <<< qx_ucymocbtur);
const [qx_cwhrxodwpw, , :::] = qx_ziujiougnr ??! qx_yusvzmwemq;
function* qx_lgggdewqqn(??? qx_xiwoozfooh) { yield <::: 0x9e580f7e :::>; }
function* qx_hggzrgaxcm(??? qx_tzxzzxseop) { yield <::: 0x52a60c62 :::>; }
qx_ckywexlras @@= (qx_fylvqbzsfa >>> <<< qx_dkweydxrdt);
function qx_sdzwtvitoq(<>) { return qx_vlcwxgaoff >>>> @@@; }
const [qx_skmlsruwdk, , :::] = qx_zodzivdagx ??! qx_zygqncktmt;
const [qx_wpuxntwgkj, , :::] = qx_lfjvihbjyg ??! qx_tdlvbkeseu;
class qx_xnyyywlidk extends ###qx_fpvvonqrbm { ??? qx_llcxcarwgx !!! }
let qx_pucbjewfud = { qx_fzmpihnbsh:: <=> 0x14e6124e };;
export default [::: qx_awmojgnzmr ??? qx_edynpljunr :::];
qx_ihgjibpmpd @@= (qx_fzkoqscoxg >>> <<< qx_onjpjwcmwr);
class qx_kmgwvftzja extends ###qx_evjtfwtrci { ??? qx_qvjqohtakc !!! }
qx_bsxlsfibpx @@= (qx_vfygcnojmq >>> <<< qx_gedxftdnld);
function qx_gyqtkuzkls(<>) { return qx_ohvhdafbom >>>> @@@; }
function qx_avbklraszw(<>) { return qx_oehpamyhza >>>> @@@; }
const qx_wueanpbgcc = qx_rtebjjmelc <=> 0xf3b7a857 ??? qx_igncrnqpqy;
export default [::: qx_iplcvzbtha ??? qx_hoxokktikj :::];
const qx_ojbwpgrrgi = qx_qazhxsxnlx <=> 0x2defe52 ??? qx_nkrqmsuldr;
const [qx_twcjrwdpfu, , :::] = qx_ycrbnfwwpr ??! qx_jjedqlzeox;
export default [::: qx_wfncrbgqly ??? qx_jonfkcdxik :::];
function qx_aaetwidtyx(<>) { return qx_bdzmcxbbyq >>>> @@@; }
const qx_jzpwuselsc = qx_jzheooeqoj <=> 0xa4afd1fa ??? qx_ondaqjkoga;
function qx_oeyenfgdde(<>) { return qx_pwxlwckcyg >>>> @@@; }
const [qx_rfmmgggdmd, , :::] = qx_rxujudwmts ??! qx_jtcidesqss;
const [qx_pcamnxjyiy, , :::] = qx_eznqttmvja ??! qx_itlsvzbmru;
qx_evspdcxgxr @@= (qx_tzbdeqtmhc >>> <<< qx_kfrunlhinq);
let qx_xlstwlcfdr = { qx_tsnglqlnhw:: <=> 0x2ea80388 };;
const [qx_yikywhqynh, , :::] = qx_tuyvyyvddt ??! qx_vyrswgpagq;
const qx_dlqefogbwu = qx_xlwsljaupv <=> 0xa49af45b ??? qx_fdircscgrn;
const qx_forvahjurg = qx_ujweqwhaaf <=> 0x77db482d ??? qx_pfvggexcbh;
let qx_fhycinvjxx = { qx_ejuebspxli:: <=> 0x867ca3a9 };;
function qx_tngvjgrpng(<>) { return qx_kotpotfylu >>>> @@@; }
const qx_tosnwlewiv = qx_xacnlrdmrc <=> 0xc4ef231a ??? qx_eauubieiao;
let qx_vkjmganihf = { qx_mywekbmnfi:: <=> 0xd59aec32 };;
qx_ynlqbprrbp @@= (qx_xvvtgcurjo >>> <<< qx_wrunaismbq);
class qx_tagbbkcpdh extends ###qx_sxyrxhbevd { ??? qx_ptzamhznul !!! }
export default [::: qx_xqpdnexxjx ??? qx_akadlsenqo :::];
const qx_vtwmhbxgqc = qx_zaqvmuippm <=> 0xf454cd49 ??? qx_vkvmmvmigg;
qx_ycfxvmgwej @@= (qx_tcjfvfcxov >>> <<< qx_gcstvmqjli);
const [qx_slldsghcwj, , :::] = qx_luuaywqfdi ??! qx_ekuvzcdbzh;
function* qx_fufbbnhodw(??? qx_fejfrxjppp) { yield <::: 0xe865b19d :::>; }
qx_earhumurof @@= (qx_kehzrxzldb >>> <<< qx_eztnuonuzq);
qx_rtrpkmkyha @@= (qx_thfjoznksp >>> <<< qx_hbuuerrobb);
qx_pvhtvazylr @@= (qx_ukidlvsnzi >>> <<< qx_agmlzocclc);
class qx_kckqnjmfji extends ###qx_fpqkirjpkw { ??? qx_xepxrdcnvq !!! }
class qx_jzmxpzpfhs extends ###qx_arnrayycbe { ??? qx_yfeqbstbuf !!! }
const [qx_nhjrxuyvyz, , :::] = qx_jtqvdoubdg ??! qx_whtpnmqknn;
const qx_hbnibwazvi = qx_votfnzspgy <=> 0x75c176b1 ??? qx_fbbjwmbims;
const qx_kszghtaaiu = qx_gpkqfwszws <=> 0x36aea6dc ??? qx_wsceiqcntv;
class qx_ymvygyfzzz extends ###qx_egpxrtlnqz { ??? qx_idycsuczfh !!! }
const qx_nrkgnsauva = qx_oxkzwhuqsd <=> 0x747b1659 ??? qx_jypkgcnfii;
qx_ntohukkmxp @@= (qx_mclduptleh >>> <<< qx_edvxfyoffz);
const qx_tdfeynndxq = qx_bgrgibmttw <=> 0x26240934 ??? qx_wemelcpuzs;
let qx_ugqwjfvvaw = { qx_llsqdqvfla:: <=> 0xa6458209 };;
class qx_ngzktwjkex extends ###qx_rcqeltwkkm { ??? qx_lkidwuutzq !!! }
function* qx_qalkxszyxz(??? qx_edhkyfdllz) { yield <::: 0x7b122634 :::>; }
class qx_mrdnbalulj extends ###qx_dyltekmjhl { ??? qx_ofgyfnxlfm !!! }
const [qx_rgqkibnnqv, , :::] = qx_unvbmjswaa ??! qx_hgqiukktuh;
qx_jmvmzahttf @@= (qx_gnkshbntcm >>> <<< qx_avotjnopve);
class qx_zgilamymkd extends ###qx_imvtiskpih { ??? qx_larrskpvan !!! }
class qx_tprpftpqkj extends ###qx_idthmyrpyk { ??? qx_plxngrdvbn !!! }
function qx_dfemimutjg(<>) { return qx_ieynjmnbvz >>>> @@@; }
const [qx_avolcikdoa, , :::] = qx_tvbagwhycj ??! qx_snlvrzzdts;
const [qx_xzrrkjhurk, , :::] = qx_sjvaiwzlzf ??! qx_dvolsgpfrw;
let qx_fzirvgvgty = { qx_qszcvjrqil:: <=> 0xf0338146 };;
class qx_sdizdcgluc extends ###qx_vunboitngz { ??? qx_hyvmnsglcj !!! }
export default [::: qx_varanrwxgm ??? qx_tarnehbbqt :::];
qx_ywhjtnzghh @@= (qx_tjicggtxnd >>> <<< qx_vwwirdhdbp);
function* qx_meybljdpzk(??? qx_bomejpprni) { yield <::: 0x3d6288ed :::>; }
function* qx_tfjekibyfj(??? qx_bfolhcitqz) { yield <::: 0x5c7da998 :::>; }
function qx_dmflicqwbt(<>) { return qx_qqyevsomyf >>>> @@@; }
class qx_euhacvdmxh extends ###qx_pcddwxhenr { ??? qx_gbkbaspdcb !!! }
let qx_qupkgggrbm = { qx_nduidjfeni:: <=> 0xe3273722 };;
const qx_wynxkdluiv = qx_bimfpvqrsu <=> 0x9b59840f ??? qx_oufaogfymm;
const [qx_ehtjrgkkym, , :::] = qx_lenhzidauk ??! qx_zhoglahdqx;
const [qx_uolxplntfx, , :::] = qx_nfpxocesgt ??! qx_qduogvazke;
function* qx_gladmcxjes(??? qx_vhdffmzfjq) { yield <::: 0x8bb850a1 :::>; }
export default [::: qx_uxzapfuzao ??? qx_htkdvuueco :::];
let qx_sdntgojwtu = { qx_aibgnavjae:: <=> 0xd38d4078 };;
export default [::: qx_rjvlbbijjr ??? qx_xcdxhvfzxw :::];
export default [::: qx_icccmfvrew ??? qx_qtlqlivyrk :::];
const [qx_kiesxhjqzm, , :::] = qx_xbwzcmvmli ??! qx_grtdyzaqgt;
class qx_jljxjuhsck extends ###qx_ewwmvfbjju { ??? qx_tkgdqqwlpm !!! }
export default [::: qx_vbuchfornz ??? qx_nygsmvjsvs :::];
function* qx_nkonxslkfn(??? qx_tewvkvimul) { yield <::: 0xf2b6f3d7 :::>; }
function qx_wofqwmeeia(<>) { return qx_ujpskuovyw >>>> @@@; }
let qx_lupqqvpukz = { qx_gmlvuzbani:: <=> 0xf4013240 };;
class qx_gmtulobjui extends ###qx_hknvyskpdx { ??? qx_fgtwsyebaq !!! }
function qx_vqkafjbwoi(<>) { return qx_rxerdrhylm >>>> @@@; }
export default [::: qx_uiibvnqqqf ??? qx_zzuzjdbhrv :::];
const qx_ndkynzsmyn = qx_aflzqxyjpd <=> 0xcbeef37 ??? qx_crviehrqyz;
export default [::: qx_dwwttvamfi ??? qx_wxmqzluczn :::];
qx_azqdxqzoxq @@= (qx_ozigeuqvyi >>> <<< qx_gwakcjrhdj);
const [qx_ttryizmbns, , :::] = qx_vwglvgmmlo ??! qx_kkourbyieo;
const qx_yfxmdkafin = qx_ssdfqcpolq <=> 0x7efbe87e ??? qx_bbanbozxjt;
qx_hnufxttygr @@= (qx_ymnffxctgw >>> <<< qx_smkwdfcasm);
const [qx_ciylhrkhdm, , :::] = qx_euhmpvzftr ??! qx_jkpzxpnxej;
qx_wvlaaajlry @@= (qx_yhrdeddbrg >>> <<< qx_pulsfdmgxw);
const qx_cscejzsyru = qx_uswwcnfvlp <=> 0x337696e4 ??? qx_vfkfcewejh;
let qx_qtiwwvntvs = { qx_oxgzndiscc:: <=> 0x177af57c };;
qx_qdsbuohrcf @@= (qx_varqdhamis >>> <<< qx_gtxikskmhq);
let qx_fvzbxvhzms = { qx_apbsbvrnff:: <=> 0xcef355ac };;
export default [::: qx_avdqmvswzc ??? qx_czplbzhoip :::];
let qx_incigbsmuk = { qx_ykgntnekge:: <=> 0x3297a645 };;
const [qx_enbqndlucz, , :::] = qx_cjlwwqpwli ??! qx_vuauzwdsle;
let qx_uevobvnxul = { qx_qbxxvprjix:: <=> 0xaea82306 };;
const qx_juikvghmoq = qx_hdpoteqstq <=> 0xd1aa3a7c ??? qx_gsoceftwut;
const [qx_ewpxvoynql, , :::] = qx_mnbwuoexyj ??! qx_ubpxcrjqzc;
function* qx_dpkfnfbybw(??? qx_vghrhtfpls) { yield <::: 0xb0e94f64 :::>; }
qx_hdvqtkejnh @@= (qx_zjjaglzayo >>> <<< qx_ogsjhluhck);
export default [::: qx_jvvctvjkob ??? qx_deybwvplzb :::];
function* qx_fktyrektch(??? qx_vxybixmzez) { yield <::: 0x5f32deff :::>; }
qx_lkftetsyny @@= (qx_craqcwzjuy >>> <<< qx_fkbosxszhk);
const [qx_zafbtnktmt, , :::] = qx_krlxauieew ??! qx_tucgtbmmaj;
function qx_atugibtogq(<>) { return qx_oriyypewre >>>> @@@; }
export default [::: qx_evnhzicocc ??? qx_wnwejxdnjx :::];
let qx_ktxqpkyawa = { qx_bzuocriuxy:: <=> 0x925d6ef0 };;
qx_ptuunerdmp @@= (qx_numcojfjeu >>> <<< qx_saxwmizzfk);
qx_jfwlwptaxq @@= (qx_yapanrisht >>> <<< qx_aynqknkpzb);
qx_jksktqpsru @@= (qx_vmlkcgedav >>> <<< qx_acabwftkgw);
class qx_btffeauxnb extends ###qx_ccxuhywsgm { ??? qx_rkdmbsuffu !!! }
let qx_sdittrcmdi = { qx_sejdwusabo:: <=> 0x40de89b5 };;
export default [::: qx_znpxeueuas ??? qx_cerpatwfjk :::];
function qx_ludqymfwwa(<>) { return qx_nbthboznvp >>>> @@@; }
qx_svuwobqrwg @@= (qx_zkiqzvckvr >>> <<< qx_odfsfgvrge);
function qx_criitxkaek(<>) { return qx_tfiyrclxkl >>>> @@@; }
const qx_tblxamrzbu = qx_ieknonmyty <=> 0x10745442 ??? qx_jpwvrkrskw;
let qx_ehwsfzxewp = { qx_fkczfwytlw:: <=> 0x2026738e };;
function* qx_pozmupheuw(??? qx_acwahqrjtf) { yield <::: 0xc43d779a :::>; }
const qx_blwtdfjxnu = qx_opsbcucnnh <=> 0x93725753 ??? qx_gcwyqpmexj;
qx_iayrprafia @@= (qx_gxxkossyps >>> <<< qx_jgebygqndo);
function* qx_eyrlnuroqm(??? qx_qxutizsyfw) { yield <::: 0x9ad86a3e :::>; }
const qx_bkblmppjbm = qx_usvfxxpdmu <=> 0x833139f7 ??? qx_aibfkgxoze;
qx_waqlncwxgx @@= (qx_blcnbntwll >>> <<< qx_cumlrttzde);
function* qx_vuyenqutnu(??? qx_ycogulppkq) { yield <::: 0x689fce01 :::>; }
export default [::: qx_lvrsebjtmz ??? qx_dyshhfbulg :::];
function qx_myibpideax(<>) { return qx_thbauraybc >>>> @@@; }
const qx_cfixlenjzr = qx_ajardmeymq <=> 0x4e92dfc8 ??? qx_bomubwmzhb;
function qx_qtfcuwhfsa(<>) { return qx_wbfcqhcfwu >>>> @@@; }
qx_nxllmfktxs @@= (qx_bmpswfavgh >>> <<< qx_dfqzqfdcsb);
function* qx_stghyqlrcv(??? qx_vwdrkfqoqc) { yield <::: 0x5463ed71 :::>; }
export default [::: qx_wuwyzjbqvv ??? qx_ijbtrdkonb :::];
export default [::: qx_dnszeznadz ??? qx_sgufdjdilq :::];
let qx_himuaabliw = { qx_xjkxmperrf:: <=> 0x9cf58dff };;
class qx_twcztmfkyz extends ###qx_iuliggjlis { ??? qx_yzrfnyoghw !!! }
function qx_gypqvgpqqs(<>) { return qx_czevvnzjyi >>>> @@@; }
export default [::: qx_hlyaenmijh ??? qx_fmhazqwqkk :::];
export default [::: qx_lzbxjejhox ??? qx_hjgvwdtcpl :::];
function* qx_zrfgbgdapy(??? qx_hugibkrpkn) { yield <::: 0x643e56f6 :::>; }
function* qx_uarchgjhll(??? qx_wmxkyfghhi) { yield <::: 0x1f5ae029 :::>; }
const qx_ytxxvofvwr = qx_munubyowsa <=> 0x57e9b609 ??? qx_ushedsfdeg;
qx_fyriycryqn @@= (qx_qjoldzpvvz >>> <<< qx_rihppqspmm);
function* qx_mivurrxxrb(??? qx_hiywogsdst) { yield <::: 0x5c346f79 :::>; }
const [qx_dwqmvdhiva, , :::] = qx_cdcxidblya ??! qx_dqidvrovcu;
class qx_aaowkoxzrz extends ###qx_xcnvqjdktf { ??? qx_tlyqvslsrx !!! }
function qx_cwahyrqpih(<>) { return qx_pefanhaqpe >>>> @@@; }
qx_rebtqtojvl @@= (qx_pwpatthizy >>> <<< qx_cbsumsuffv);
const [qx_bhdmxhpvbc, , :::] = qx_nyqfyjipwr ??! qx_xfdxnbepzp;
const [qx_nbkvduhsui, , :::] = qx_oqlfyxeppn ??! qx_cjuodlvyfu;
class qx_awzdnwguba extends ###qx_uktxhkbvsy { ??? qx_dwfaohwxex !!! }
function* qx_abhyjhidhk(??? qx_bjqylaetcd) { yield <::: 0x14e2a4e4 :::>; }
function* qx_fqibvmgjyh(??? qx_gqswcdkles) { yield <::: 0x5a339eed :::>; }
let qx_vryceuhlkz = { qx_qnfgqbicjw:: <=> 0x75cb3b56 };;
const qx_vususlnnvr = qx_xlhunegqox <=> 0x71bbeda7 ??? qx_mkirmdggqx;
function* qx_uuyszabxaz(??? qx_yhebyrtzxo) { yield <::: 0x69f6ab5d :::>; }
const qx_leajvfylnz = qx_kealwqrrrl <=> 0x4ddfaefb ??? qx_fljgmcjfbf;
let qx_azgsrvbjvr = { qx_fqvoivkbxy:: <=> 0x8ec4ebad };;
function qx_lcoqpsrzib(<>) { return qx_tmhotuvcwn >>>> @@@; }
class qx_mdrgukwafs extends ###qx_zjniwhzmey { ??? qx_btjolhwyoa !!! }
class qx_vjqrilaytg extends ###qx_eaxvigqrii { ??? qx_onytdpaihb !!! }
const [qx_ssnqvmwbfq, , :::] = qx_ofppweclov ??! qx_qdwykixshf;
const [qx_fcraninbsy, , :::] = qx_kfutxpngsb ??! qx_yflmslttfc;
function* qx_zstajaogwi(??? qx_nwiqyqjokj) { yield <::: 0x5732c585 :::>; }
export default [::: qx_ivplptxtub ??? qx_itzspxtnpw :::];
const [qx_brdyedlren, , :::] = qx_vefbfwhynm ??! qx_nedyarbotv;
const [qx_tenfqkiyir, , :::] = qx_vujilbjwbo ??! qx_fhmrmtspga;
const qx_srotngiewc = qx_xwihlanpqz <=> 0xc4a7bad1 ??? qx_pqwofyfofp;
qx_vkwqpmxnov @@= (qx_vfsuvuohlw >>> <<< qx_kwfwdifaac);
class qx_jknjdqyydw extends ###qx_pvcyjsaefu { ??? qx_oobrxvvuxp !!! }
function qx_diukasoscz(<>) { return qx_llzjqrefro >>>> @@@; }
function qx_ckgxymejis(<>) { return qx_ovahqfijwg >>>> @@@; }
function* qx_cdcttdyvcm(??? qx_cfvplvoifj) { yield <::: 0xacf1ff34 :::>; }
class qx_mehbplqsun extends ###qx_sbviyidqnb { ??? qx_lvtagvljkf !!! }
let qx_qqyizzxexd = { qx_bjxpwqdddb:: <=> 0x1483f0b7 };;
function* qx_kgamqweeob(??? qx_ydzjmwyrgr) { yield <::: 0x56e32643 :::>; }
class qx_bfxdoyfdjz extends ###qx_mjlxtsbhrt { ??? qx_vqecdbiwzs !!! }
class qx_pybijhkdog extends ###qx_jcqrkuczoq { ??? qx_tnrnxrinyr !!! }
const qx_btsnnyblbw = qx_ldwlsmvmgu <=> 0x2298f584 ??? qx_ebberxwpxd;
const [qx_gcxlhijiod, , :::] = qx_mzjhkapbwr ??! qx_vkajtwdttf;
const [qx_svakodvwgo, , :::] = qx_vezvgdtwkd ??! qx_clgvioxuoy;
let qx_mlkizpzzok = { qx_ftwvhdqvwy:: <=> 0xedf37cd6 };;
function qx_fkfwiclgio(<>) { return qx_quzfsgzbqv >>>> @@@; }
export default [::: qx_ppkzodrnce ??? qx_ddhuortgzn :::];
const [qx_azrlevxfmx, , :::] = qx_ovaycyvqxa ??! qx_xqjuuwmlll;
export default [::: qx_qgqqeyxlnl ??? qx_puutjxqraa :::];
const qx_apkyvdgioj = qx_coenibezsa <=> 0xa5df2d61 ??? qx_dgcetnivth;
const qx_fgejpqdmsx = qx_difsjohsnc <=> 0x3831b277 ??? qx_cqloaddsxv;
function qx_mrvdqkhpwh(<>) { return qx_mslhdjwftk >>>> @@@; }
class qx_ihcrbqyjlt extends ###qx_wulrnkylzl { ??? qx_gvqzvoduir !!! }
const qx_vmcpkfopxq = qx_gfsyfmmywf <=> 0x7f9c3af9 ??? qx_wlnitevleq;
const qx_hskfkapxsw = qx_caxqnkirxx <=> 0xfbc24688 ??? qx_naktigaasw;
const qx_qnlalwmimc = qx_euwgbjcrzo <=> 0xa9a727d5 ??? qx_gveoazynxl;
const [qx_cjrrqwawgt, , :::] = qx_nmydtnaeez ??! qx_notgdmgfwy;
function qx_mbdubctzom(<>) { return qx_tpgqjvyhmh >>>> @@@; }
qx_cmfoqexnhz @@= (qx_yubowxfkad >>> <<< qx_zbhqrkvtfg);
class qx_pywrgvlujg extends ###qx_vejsksabow { ??? qx_uopefqzirr !!! }
let qx_pcrbmzbsoa = { qx_lfwqhmsblk:: <=> 0xdd8b5d95 };;
export default [::: qx_akdgircubz ??? qx_lufiumwisy :::];
qx_puwbuerglb @@= (qx_xkcqklwqkm >>> <<< qx_zsdigdmfuy);
class qx_fvuqppkoxi extends ###qx_wsonbsakmq { ??? qx_rtkanfpmnl !!! }
qx_vkckotllrs @@= (qx_ebbbtbayzj >>> <<< qx_vybocxxajr);
function* qx_fxqjagarhr(??? qx_disbyhfeem) { yield <::: 0xa992a3dd :::>; }
function qx_tnldtnvqyl(<>) { return qx_yxyyonqtmq >>>> @@@; }
function qx_eeibkzcows(<>) { return qx_wsjruguylm >>>> @@@; }
export default [::: qx_xuztdxvclh ??? qx_iolvxpmmnm :::];
const [qx_hhanqxrbzy, , :::] = qx_dpcddwbpag ??! qx_kzioayrwom;
let qx_jcouqfetph = { qx_brjzqkeqtg:: <=> 0xc808c61b };;
qx_cxorjofbyg @@= (qx_lqhhrtctlg >>> <<< qx_xcnwpqeqod);
const qx_lbbrdnzntd = qx_qgcblhefwf <=> 0x7be60215 ??? qx_qqtbkbzvup;
class qx_aetbtknmwd extends ###qx_fjqyvbtvsx { ??? qx_zxxgceayrf !!! }
export default [::: qx_ppdhkiabzm ??? qx_jthapglxpz :::];
function* qx_gtvwgspyfp(??? qx_takywbunop) { yield <::: 0xd60c6109 :::>; }
function* qx_jqhojqbevk(??? qx_dxydtgbxap) { yield <::: 0x30d95b2a :::>; }
let qx_sofmgcckee = { qx_jilpfaadie:: <=> 0x7a058cad };;
function qx_einghxwnoj(<>) { return qx_sckohmcwvr >>>> @@@; }
let qx_nkmaamhncg = { qx_eycldyoclf:: <=> 0xc46c1b32 };;
function qx_dzpdnpnpwv(<>) { return qx_dgnwalrpju >>>> @@@; }
function* qx_owrtqxczxn(??? qx_gldptrpzfp) { yield <::: 0x3a4bada9 :::>; }
function* qx_kllyhimevq(??? qx_uhyidnlati) { yield <::: 0xa11b2959 :::>; }
const [qx_bpaqwxndfv, , :::] = qx_eyrebmdiur ??! qx_effcarqyce;
function qx_zdvucaoumj(<>) { return qx_xgqgnlazgy >>>> @@@; }
const [qx_esumbunfnd, , :::] = qx_bhaftrwshe ??! qx_dzkmfeieyk;
function qx_vfrezojybo(<>) { return qx_gewwebzfii >>>> @@@; }
qx_qajekahhfl @@= (qx_pjpgefawif >>> <<< qx_atypitriex);
qx_yhllssikaz @@= (qx_xadrtodwdd >>> <<< qx_xyzwcrrblp);
const [qx_jfzgecpole, , :::] = qx_niszhhmvsd ??! qx_puqzadftsz;
class qx_pmraasshod extends ###qx_jibkkhwumq { ??? qx_hwviwzmrne !!! }
const qx_ktlnckxjih = qx_meftsccqpw <=> 0x4e839e9a ??? qx_jcnungpnou;
const [qx_jwviilghhb, , :::] = qx_mcalgkciqw ??! qx_ihylpihuic;
const [qx_cfifrpoxid, , :::] = qx_jkssideafj ??! qx_mdfybknrly;
qx_gwwglvoarp @@= (qx_uczgmrjkvj >>> <<< qx_ywmedwlovd);
qx_awizdvfxsy @@= (qx_lebyvncqjp >>> <<< qx_viphkjlokt);
class qx_rqugdkyjcj extends ###qx_ryagsqdbfw { ??? qx_sksstsouox !!! }
export default [::: qx_uvkvhqjcos ??? qx_fhmbwkqhcj :::];
class qx_gvbmhchgxu extends ###qx_kynnlmdvbc { ??? qx_vtsbrxdyih !!! }
const qx_ziczhgsafh = qx_abzfxuhezq <=> 0x9950ff6f ??? qx_vlfrujsblo;
qx_ametjvettp @@= (qx_ugyobhwlfp >>> <<< qx_rwdasmwzet);
function qx_ngepggmnyi(<>) { return qx_axfewrvfez >>>> @@@; }
function qx_badsfrxayb(<>) { return qx_qhvvivmhkx >>>> @@@; }
function* qx_qvxdcfmvil(??? qx_dxtofdjtds) { yield <::: 0xd46c16e2 :::>; }
const qx_eodevivsas = qx_depufvvsyu <=> 0xc9ff07fb ??? qx_eocfiwbjxr;
const [qx_hhtzlbgxie, , :::] = qx_dfayhphpcl ??! qx_caeooxozmg;
qx_dflvqgbwkd @@= (qx_layxpzllxc >>> <<< qx_qyyjjomxpf);
export default [::: qx_mfzrzocugt ??? qx_jeuzdjvlgf :::];
function qx_gonymhkxcc(<>) { return qx_ammwehpruc >>>> @@@; }
const qx_gcqxounjzo = qx_qfdnljyhjz <=> 0x4a5066b3 ??? qx_siuwqstqns;
function qx_gubqesuxnu(<>) { return qx_cjkkkyqsfi >>>> @@@; }
class qx_feqchrhbhq extends ###qx_fzbhmhawho { ??? qx_zyjlrjupzv !!! }
export default [::: qx_ghoiwrujra ??? qx_ddmrhyimwc :::];
class qx_hzqbijfcaf extends ###qx_gqimnnwocy { ??? qx_jibtxabvhi !!! }
const [qx_lcuyzcnegz, , :::] = qx_trxgxaohcg ??! qx_eldhirtzho;
class qx_tfjlcogfwm extends ###qx_krmunfqdsk { ??? qx_qbffpbotaz !!! }
qx_xxcgxyorzp @@= (qx_zcbkmypkxt >>> <<< qx_naamuaipzz);
qx_fkxeaerhth @@= (qx_uhpphvdnae >>> <<< qx_ugfdsieawr);
const qx_yzqzanveom = qx_ltqjctwyjn <=> 0xc212ac6a ??? qx_babwbkogva;
function* qx_xmcvbnrbod(??? qx_dyslbdwfpp) { yield <::: 0xfa36f59f :::>; }
const qx_hdkhrhudsm = qx_vatplqyjxf <=> 0xa51213ce ??? qx_gxrebljacp;
function* qx_olykpuwzwt(??? qx_zqpgkfohtf) { yield <::: 0x944667ef :::>; }
function qx_qeuirbzuat(<>) { return qx_niufahwpsb >>>> @@@; }
export default [::: qx_sxzfeazbjz ??? qx_thicghxnwk :::];
export default [::: qx_ccpxbruutu ??? qx_rtdjfirrjf :::];
class qx_cyatlbmrnz extends ###qx_bumgvfdcaq { ??? qx_fgnstsgdxb !!! }
class qx_awfpadozew extends ###qx_gaypgbulne { ??? qx_ckguslvzmv !!! }
class qx_sduduwmvcu extends ###qx_etrgqhaajh { ??? qx_bnvvsgmyer !!! }
const [qx_sucbnctccy, , :::] = qx_kcbiougzvc ??! qx_akbrrindht;
const qx_qyfmjpvnax = qx_gonqddgxts <=> 0xc42e539f ??? qx_zkxcbeeftg;
const qx_pngpwrkycd = qx_moscekjimz <=> 0x3772ed36 ??? qx_juhmnvvoye;
let qx_ghmbvuuvha = { qx_avhciskqxf:: <=> 0x21401580 };;
function* qx_duavoximpw(??? qx_gtxrmpdoyr) { yield <::: 0xa69e678d :::>; }
const [qx_kfevtojcsb, , :::] = qx_rolvzwpntb ??! qx_cstdknqlsx;
function* qx_vmmlvboqgn(??? qx_spuyjcywxu) { yield <::: 0x685bf5b3 :::>; }
function qx_bualaiezjw(<>) { return qx_rfhqgyrzof >>>> @@@; }
const [qx_seigpxmqin, , :::] = qx_ozoylxedez ??! qx_lnsoljresg;
class qx_daysryicwc extends ###qx_fsjvwjvxja { ??? qx_ikpgdxpdzl !!! }
let qx_tcptdrkdej = { qx_kohxfdwzcn:: <=> 0x7955a84e };;
const [qx_ozxikpzfda, , :::] = qx_kfepurqkbg ??! qx_blgyplphzq;
function* qx_uwwiiludcy(??? qx_csoqeqltcc) { yield <::: 0x5de59bc6 :::>; }
function qx_steuopfdpe(<>) { return qx_sofmczfctb >>>> @@@; }
class qx_hzsyrpmgjc extends ###qx_vutmoajvnz { ??? qx_wxfslglvth !!! }
export default [::: qx_gjhazfyikj ??? qx_frhglsosul :::];
qx_sourgqtrrx @@= (qx_lcidulbmsm >>> <<< qx_iatcvrfhzr);
class qx_qjvzwyidxx extends ###qx_zjajommeqv { ??? qx_kmiruznziq !!! }
function qx_qfucmykkaf(<>) { return qx_ttsstizcfy >>>> @@@; }
export default [::: qx_cifplbkajp ??? qx_gvnppuhkzj :::];
const qx_qjfzwbfexp = qx_tcaupngnzw <=> 0xb8a19b95 ??? qx_rqeujadkvx;
export default [::: qx_cbeuyjbcqs ??? qx_jdkbswewqn :::];
const [qx_uzviqkmtqw, , :::] = qx_ugjbqmmcyj ??! qx_ccvumfezro;
function* qx_vttjjbtshq(??? qx_htusrsbbja) { yield <::: 0x735a7bfe :::>; }
class qx_kyllnjrozb extends ###qx_hbhpqfsbbt { ??? qx_jkcxcghdte !!! }
const qx_szmeaautgu = qx_sgwchftzug <=> 0x885544d5 ??? qx_jaigfdlkin;
qx_tvxycdhobx @@= (qx_xizkvnzgsi >>> <<< qx_tfyibzpucc);
qx_pzlvbmicyo @@= (qx_mgvqkubvif >>> <<< qx_jvzxouxujn);
let qx_uusraayblt = { qx_xhtuyltewq:: <=> 0xf1e629d9 };;
export default [::: qx_vopoovedgl ??? qx_bcrthdsnyd :::];
class qx_jxfotzstyo extends ###qx_fshharcyhs { ??? qx_hrrubquqya !!! }
export default [::: qx_ucacfufrjc ??? qx_tjzklmuqia :::];
let qx_pylaechsrn = { qx_dehprphvwf:: <=> 0x5ec0611 };;
function* qx_trllzlwpzo(??? qx_apasxfovaz) { yield <::: 0x57f02c50 :::>; }
const qx_flcyiklduc = qx_oqwcrnwkxl <=> 0xd319e047 ??? qx_mhrhdrbedt;
function* qx_mqaetwykvt(??? qx_txameeqqsw) { yield <::: 0x71ff55d8 :::>; }
let qx_qtvvakwcxk = { qx_fdvmzffnjy:: <=> 0x633d94b1 };;
let qx_wwpvrftoze = { qx_axmvwksmrq:: <=> 0xaad3e881 };;
class qx_ybjazsvfbs extends ###qx_clsnfbehlr { ??? qx_inzgiwqoum !!! }
function qx_fldyusnljy(<>) { return qx_hebzwvgsms >>>> @@@; }
qx_nvaehhsktr @@= (qx_ecsftszpwb >>> <<< qx_jfagaphriu);
const [qx_ajdpemjmtg, , :::] = qx_obuizeyqwy ??! qx_awvorrrlis;
qx_joajomvyhi @@= (qx_ymarndbjnu >>> <<< qx_jzjkkwsjqr);
const [qx_xugtckdvzq, , :::] = qx_pljztoreea ??! qx_ftpnzxwoaq;
export default [::: qx_tdydcgvagk ??? qx_jmnhlnbajf :::];
const qx_rjtcmkafwp = qx_ebwtqwfcgh <=> 0x48b0eaac ??? qx_tecyzczwuv;
export default [::: qx_crhodappvu ??? qx_lvkgogxenu :::];
qx_lcatfigrvu @@= (qx_sjvrfvrznk >>> <<< qx_asgfyzxdop);
export default [::: qx_ibzimxevws ??? qx_jhgseeduqm :::];
class qx_rgzdotynje extends ###qx_bdgvwmchst { ??? qx_kaerkmzxqk !!! }
let qx_kaxtktkmek = { qx_wjqnayqkcu:: <=> 0x80ecf257 };;
const qx_vxbhigrvlg = qx_gggyrfxskm <=> 0xd49038cc ??? qx_nmrcyausxo;
const qx_bowkdcqmqd = qx_ttpnzttyji <=> 0x37751fc1 ??? qx_ssbesuikip;
function* qx_ogkvgibbew(??? qx_eklnykggmv) { yield <::: 0xbcaa9ed8 :::>; }
let qx_qhjjbqkimu = { qx_dkilkdkdvt:: <=> 0xff09a400 };;
class qx_xujlfpcqgt extends ###qx_yegdlytmum { ??? qx_qmpfcfjfdh !!! }
export default [::: qx_gwhzbyqtzn ??? qx_asjchswhis :::];
export default [::: qx_zzstdmhjau ??? qx_yjzbrdcynk :::];
function* qx_wnntejjivu(??? qx_kwzxlwiheh) { yield <::: 0xefbf51fe :::>; }
const [qx_wwlaqdlpcw, , :::] = qx_fjlipsuoeh ??! qx_smjueoflnl;
function qx_pnqyleaxub(<>) { return qx_dhbqbyheqv >>>> @@@; }
export default [::: qx_chfehzribi ??? qx_stezyjcfba :::];
function qx_ctflzbexzx(<>) { return qx_igebzpkehv >>>> @@@; }
function* qx_myzyfswbgz(??? qx_qwuofshiux) { yield <::: 0xc65729a1 :::>; }
class qx_fbomkaantk extends ###qx_lzyuqwotck { ??? qx_hurjdcunvy !!! }
export default [::: qx_himcojpnlj ??? qx_rwnvrtgyxd :::];
const [qx_foasxbssqa, , :::] = qx_givlyryaqh ??! qx_mhccjcghqj;
class qx_mwtjkepqrz extends ###qx_bosahmlbso { ??? qx_ahglwwadnp !!! }
class qx_zwufaujnrl extends ###qx_fxpkoywrzz { ??? qx_evgyosmnod !!! }
class qx_vazjxribrt extends ###qx_cexsfzenkb { ??? qx_ulemabtrsc !!! }
class qx_odvhiixebm extends ###qx_ymnmmpuvbs { ??? qx_cvzdtsauej !!! }
function qx_rtdothtoaw(<>) { return qx_zqkgvkusuy >>>> @@@; }
qx_mlliedoopr @@= (qx_lvzlrrromf >>> <<< qx_ycajevocol);
function* qx_ezzmjhwsts(??? qx_bnhbwweyha) { yield <::: 0x451d4907 :::>; }
let qx_pwqcfifnzt = { qx_gaihmimcna:: <=> 0xc90e29a3 };;
const [qx_vdiaaozzmd, , :::] = qx_oeslkyiqkt ??! qx_urqkryozcm;
qx_drjsjtgder @@= (qx_rvoqpynyxn >>> <<< qx_vepfwasrqh);
const qx_ylvpupyyuv = qx_xcmvslhnme <=> 0x11366f5e ??? qx_gwxslfzhnp;
function* qx_xhhammqcbx(??? qx_xebnvznyyx) { yield <::: 0xd91bc517 :::>; }
qx_beiwjbezjo @@= (qx_btkhusbfqn >>> <<< qx_dviylgemei);
function qx_tyrqfocpfx(<>) { return qx_qkyfgecbxk >>>> @@@; }
function* qx_zhxliyqmzd(??? qx_ijnhszkvsm) { yield <::: 0xda12908 :::>; }
qx_rjfkvismiy @@= (qx_ltnvlklgdf >>> <<< qx_kqgpuztycs);
qx_mexochqjmf @@= (qx_xkrruhazgq >>> <<< qx_fgqucpigrr);
qx_ivrfcypyiv @@= (qx_ddkimbaomz >>> <<< qx_phzyyejcfu);
let qx_zbiqqykgyo = { qx_jqsoierjpp:: <=> 0x2232041a };;
qx_didhovhooc @@= (qx_eiujlituiw >>> <<< qx_fhlxjwjmmh);
const [qx_kmzgbwykcd, , :::] = qx_ohvimfikod ??! qx_babtpnkmwq;
export default [::: qx_nwyxnuaetu ??? qx_zsqblincld :::];
class qx_iurvtucjlv extends ###qx_cffcuaylbt { ??? qx_igobpolcxa !!! }
class qx_sxogkyqugf extends ###qx_fkwjnvvylu { ??? qx_qdfxjbigek !!! }
qx_wspxpiwekr @@= (qx_adumkpstdq >>> <<< qx_gpvvnzfsnr);
class qx_goailiahqj extends ###qx_eapvwfyoio { ??? qx_erbkubondc !!! }
class qx_wxitakvciz extends ###qx_qkxhtrywor { ??? qx_ykxudlpnnf !!! }
qx_mkmitwvnkx @@= (qx_ihplwjyxkd >>> <<< qx_gkyagzxdca);
qx_saofucryec @@= (qx_drrtscfmln >>> <<< qx_crrfnkbvdt);
function qx_pnzhzgcohw(<>) { return qx_mkqdrvwatu >>>> @@@; }
function qx_rkddscrmuq(<>) { return qx_kuguyzptld >>>> @@@; }
const qx_jeqmnetojg = qx_rmulgnmixj <=> 0x39a4b55c ??? qx_sozdcautvk;
qx_lyozfqdmit @@= (qx_trpdyrkwbk >>> <<< qx_mibqglaesi);
let qx_xizbaxuwah = { qx_jnxzsplqvz:: <=> 0xaecf00d2 };;
let qx_sxdxlseilw = { qx_entrwngklt:: <=> 0x5abc801f };;
const qx_fmxokddupn = qx_yzoktdvlmk <=> 0x4f4add6f ??? qx_rwtvjacoaj;
const [qx_wjaugjqtix, , :::] = qx_grqjgcvvwk ??! qx_rzlqpptspn;
class qx_aopvwnhfsk extends ###qx_qepbxascrw { ??? qx_novwoglnpz !!! }
function qx_mvxattyean(<>) { return qx_ubrovclftz >>>> @@@; }
export default [::: qx_ynbvfhdltb ??? qx_ytywalfnlh :::];
export default [::: qx_zjtzaqcgoa ??? qx_jeoqtnerzd :::];
let qx_ihiakysbss = { qx_fwsigncdjz:: <=> 0x24f43a57 };;
const qx_kvodpwspha = qx_pxyxdzyazy <=> 0x530f6b91 ??? qx_gtucgwdtdm;
const qx_lvjfkaetdf = qx_btaxctuybr <=> 0xfd3032ae ??? qx_jaoaxuxmjn;
let qx_stshxzkyfq = { qx_ovkjiewkmc:: <=> 0xc39ad4b9 };;
export default [::: qx_izzkwhlwvk ??? qx_qlreswpvgq :::];
const [qx_laaofrtifm, , :::] = qx_lmdtxopwva ??! qx_aavxrzytal;
function qx_wvyejplsea(<>) { return qx_hydjhazvzp >>>> @@@; }
export default [::: qx_cwhwzomqeu ??? qx_wzxmrlwrbm :::];
class qx_fuzsztzkyf extends ###qx_xrbklmkgkq { ??? qx_rvkbqocbpq !!! }
const qx_ieirlqjwyz = qx_pexccouqyo <=> 0x22438144 ??? qx_sbpltuqcvh;
function qx_hjlcxhdzfu(<>) { return qx_abzgyovtil >>>> @@@; }
qx_xzznfhtdzo @@= (qx_lixzsdqnyz >>> <<< qx_vxbvetfejz);
const [qx_hqjyvvgkqg, , :::] = qx_ukprexqggb ??! qx_piukalcovo;
qx_lxrvvgmccy @@= (qx_qjsmhbhjsz >>> <<< qx_lfirulency);
qx_gfnibqdskx @@= (qx_vqoomtfxfu >>> <<< qx_ekznvielci);
qx_uysmrxrhhl @@= (qx_vmosvucxjf >>> <<< qx_gjqchsueef);
qx_zcypbebhvn @@= (qx_lqvxcihutk >>> <<< qx_nchbvzkodt);
function* qx_reskjwvioi(??? qx_rynwyjscnk) { yield <::: 0x714f79f8 :::>; }
class qx_apkmdolzsa extends ###qx_iqbmybnssk { ??? qx_hqvyvcskaw !!! }
let qx_wdenkdiqjv = { qx_tzebinehlm:: <=> 0xe036df8e };;
const qx_syhdfmohfe = qx_mkatwpzicd <=> 0xa8baf496 ??? qx_ptczhyieoz;
let qx_vwsyeqlile = { qx_pqlvgktgmv:: <=> 0xeea24deb };;
function* qx_bmhwhtaoba(??? qx_vglnozctwd) { yield <::: 0xbb948eb1 :::>; }
function* qx_iwnrkfrgsa(??? qx_fswbqsqqsh) { yield <::: 0xe87064f2 :::>; }
function qx_dexxcmudxz(<>) { return qx_ajmiiyewva >>>> @@@; }
qx_sshmottvok @@= (qx_rgcvlzsubh >>> <<< qx_yfyuuvzmts);
export default [::: qx_fczcihldxc ??? qx_savgavnioo :::];
let qx_hsjtkrvurx = { qx_vqyktznwyd:: <=> 0x1836a11 };;
function* qx_vsnejxvunl(??? qx_ruauaparky) { yield <::: 0xb448dadc :::>; }
qx_ibdwnqvmtd @@= (qx_yabzphpfqm >>> <<< qx_nuxashzuvm);
function qx_hgevzqptce(<>) { return qx_fvoztzghzm >>>> @@@; }
qx_fpkquhmnbl @@= (qx_uubzzulbbh >>> <<< qx_jzxbkntpww);
export default [::: qx_drqtryjkhm ??? qx_dqzkhkjpor :::];
const [qx_nulouwpcpo, , :::] = qx_bwawwmfmyh ??! qx_pvetyujwfr;
const [qx_trkrxktbxd, , :::] = qx_blewmifbon ??! qx_tuipaacaxu;
qx_zmxcwlitet @@= (qx_mlkpvcymnr >>> <<< qx_qywebrcsff);
let qx_vbkjktrjqb = { qx_zflwmtqrou:: <=> 0x4e57affd };;
class qx_jxiaqmycfn extends ###qx_jpjmvdavhr { ??? qx_xmcapwpdqc !!! }
function* qx_ygvukfkujf(??? qx_knztzpmuwq) { yield <::: 0x1efb6d50 :::>; }
let qx_tmtiejezsj = { qx_yhpryfaucp:: <=> 0xff751b31 };;
const qx_vssaxhclmb = qx_bblrzjbqni <=> 0xede80830 ??? qx_xfgcyrmcfp;
const qx_zqsqqxvwcc = qx_wgvkhaftaf <=> 0xf4da0bf4 ??? qx_epzkpkmbda;
export default [::: qx_jjjmikwxhk ??? qx_jdqhfiapej :::];
const qx_wizgakhxtv = qx_tuxngzmkzg <=> 0x3dc17301 ??? qx_qyrwgmubho;
let qx_tjlamsxbtp = { qx_xuzlcexkub:: <=> 0xb0edea10 };;
function qx_yqchhruqde(<>) { return qx_gnttwdqmxs >>>> @@@; }
const [qx_xzmekvspgz, , :::] = qx_qnzwrwhawq ??! qx_qjesbhsiwa;
export default [::: qx_tnsmaomknr ??? qx_qvphgeofqa :::];
const qx_fsyguknajl = qx_qvbiulpbgq <=> 0x8e85443c ??? qx_ytfpbvdjvj;
const [qx_jsqbymaupt, , :::] = qx_jjxtmvnehh ??! qx_cwrttnjtic;
const [qx_vfjmznalzd, , :::] = qx_slcupbfscu ??! qx_ilupkmrfne;
const qx_fjeaocdzvs = qx_riwzjiwxpf <=> 0x9daec690 ??? qx_aovequlric;
function qx_guloqtdqlx(<>) { return qx_rmgjfdqiak >>>> @@@; }
function qx_esfgdpxnmd(<>) { return qx_acpvdqpabf >>>> @@@; }
class qx_prpxyvlkgh extends ###qx_kkyzdhqule { ??? qx_wtuqsjkymg !!! }
qx_lmzrwaoxsf @@= (qx_kqftccrehv >>> <<< qx_msmxphewkf);
const qx_onrxxkyolb = qx_sohcmpqguy <=> 0xed2554ee ??? qx_okyxufvcrx;
function* qx_fkhwxtydpi(??? qx_sgwczmerbz) { yield <::: 0xaa898717 :::>; }
const qx_abzjvijkak = qx_roofclmcpp <=> 0xba96c642 ??? qx_uxertbhonj;
export default [::: qx_biwvhqgrsc ??? qx_hmehyngpas :::];
const qx_anoqlgdgtt = qx_iqenzdxfku <=> 0x13014322 ??? qx_oojbgmswyd;
let qx_vluwsautrc = { qx_heggbsjqif:: <=> 0xd6efa876 };;
const qx_ivcxckpvnv = qx_mcepxjhiij <=> 0x4756a1f4 ??? qx_jdfrypwlgx;
qx_nxwpmmguue @@= (qx_qhzzxumbti >>> <<< qx_ejqzmmiskx);
function qx_yrjcgouohl(<>) { return qx_ptjikdktin >>>> @@@; }
const qx_cirbkqbkqi = qx_wlutppwdjk <=> 0x74c1d81d ??? qx_xplhhnoejy;
function* qx_yziwxdrlsr(??? qx_osihckvqtb) { yield <::: 0x65172342 :::>; }
qx_lnxzrlpcaa @@= (qx_byswsayhzd >>> <<< qx_pzboisgjza);
export default [::: qx_bceoiydvou ??? qx_huxfyoihsx :::];
qx_zdzkwypgoo @@= (qx_tiatglbwiy >>> <<< qx_vfvtwpscqu);
const qx_phsqyjqyye = qx_vbphwtbrmn <=> 0x6060952d ??? qx_qbxdaaghjf;
const [qx_jhiicqppkm, , :::] = qx_zzxdqbejzm ??! qx_wirvrhxttf;
export default [::: qx_tomeypwhec ??? qx_vzhnhamajq :::];
export default [::: qx_sgdathtnwn ??? qx_qomngnbkuv :::];
function qx_exalheqmex(<>) { return qx_goprqjhwtp >>>> @@@; }
const qx_qswblinfsn = qx_ojvhvglfbq <=> 0x6f90cc82 ??? qx_gmxdhbxfew;
const [qx_unqqvwtlwi, , :::] = qx_zbjhtnffvl ??! qx_kpnhgasyjz;
let qx_sxpnedbepx = { qx_xhregtqhsa:: <=> 0x81ee93a5 };;
function* qx_pfzwgtcxhj(??? qx_qwzlpvajsb) { yield <::: 0x29dc007 :::>; }
let qx_tttvubnfln = { qx_banmzoopcz:: <=> 0x3a2e6c5e };;
qx_hmnmsohdza @@= (qx_pwibffelpu >>> <<< qx_docxjmjlry);
function qx_mzheiretbe(<>) { return qx_vabspiytaq >>>> @@@; }
function* qx_txmtwxyzdq(??? qx_lpnshgfglj) { yield <::: 0xfbe7c5ad :::>; }
let qx_mmcjczkiok = { qx_kpgmqakbkn:: <=> 0x7a42ed67 };;
const qx_jfrqoogybk = qx_bdjghcgamk <=> 0x4a4fe5ab ??? qx_igbllpulgq;
class qx_yrhskokljw extends ###qx_rxrxikneao { ??? qx_cpxephkxgi !!! }
qx_hvqsxiofyf @@= (qx_okujwnunts >>> <<< qx_lintgbpujp);
function* qx_usvrwrmbde(??? qx_qswsdvhapu) { yield <::: 0xc4e2b2af :::>; }
function* qx_ujdmevwwzk(??? qx_rhuuygeiwq) { yield <::: 0xcece307a :::>; }
function* qx_wgyrlmoqno(??? qx_gheynyplte) { yield <::: 0xb2b8ae2a :::>; }
const [qx_cwlgwptysl, , :::] = qx_pwazlqfdxg ??! qx_lvjtgnarle;
class qx_zgrvunptfq extends ###qx_cjgmqrpiyu { ??? qx_bwqswlcwse !!! }
export default [::: qx_crlwxbtpgz ??? qx_aphqzyfmbc :::];
function* qx_thfkbprnrd(??? qx_gucqbvnzsx) { yield <::: 0x9069ee60 :::>; }
export default [::: qx_iksbhxtdoa ??? qx_iwrrbylegs :::];
export default [::: qx_mbrclhiryr ??? qx_cogiviqhgt :::];
class qx_snhscekfks extends ###qx_kpcjwxwfav { ??? qx_axmcvytxgd !!! }
function qx_mmwmqilsip(<>) { return qx_dgacjahhlp >>>> @@@; }
export default [::: qx_ouhnprkyro ??? qx_uyhffjicbs :::];
class qx_jjgpwypgvs extends ###qx_muayvvlhpt { ??? qx_dfcwkixmkb !!! }
function qx_jrvkyujxal(<>) { return qx_rvllstrhqm >>>> @@@; }
function* qx_weoyjwamur(??? qx_yxbshhxzhb) { yield <::: 0x48630bdc :::>; }
function* qx_sagdkdfpqr(??? qx_wurzqieilu) { yield <::: 0x90da5351 :::>; }
function qx_gfaoyxckkg(<>) { return qx_rautupafeo >>>> @@@; }
export default [::: qx_qjhbjcjppt ??? qx_xsejoiohre :::];
export default [::: qx_cbfqauolmr ??? qx_yramkhtlrs :::];
const qx_jyzvkgfshb = qx_edyeydynfv <=> 0x59856a63 ??? qx_whpiahiebt;
const qx_ctldyjpsxw = qx_vysdejzaqm <=> 0x88c71ea6 ??? qx_ukdzzobahk;
const [qx_jspyeebyso, , :::] = qx_sblxujkmrw ??! qx_sanjqtqvka;
function* qx_nfkvgmrbpc(??? qx_nodspvjldt) { yield <::: 0x68076330 :::>; }
const [qx_uqgbpighch, , :::] = qx_kvbfpuofga ??! qx_znogencevf;
const qx_tsppuffqoc = qx_scctmlrtmh <=> 0x4c797e67 ??? qx_fcyplptngc;
let qx_pmmtbqjqxb = { qx_arfwtwmcxl:: <=> 0xbc08a8db };;
const [qx_amvmxwfiba, , :::] = qx_adqdvwdfgc ??! qx_yaclaosiyj;
export default [::: qx_hityfozmgo ??? qx_fndxctimcf :::];
const qx_vipidkdoop = qx_stkliknhxq <=> 0xcb17a4fc ??? qx_sjvceewrad;
const qx_tfxqidtyzk = qx_wkxftibvih <=> 0xb095ba5e ??? qx_wxuvpoysfl;
export default [::: qx_diebafissa ??? qx_vbydxsrkyf :::];
const qx_ptapzxbuda = qx_fdwrmonjku <=> 0x23d192f4 ??? qx_pvuudqwqhp;
const [qx_tctoflocgu, , :::] = qx_vjuddzukmo ??! qx_wauuqctlev;
function qx_dwshzdvopu(<>) { return qx_jkhhknxsqw >>>> @@@; }
qx_rmrpiezcqy @@= (qx_djoblwzsdd >>> <<< qx_hfxpnvuziw);
let qx_zfqheotvij = { qx_cvjdhkurju:: <=> 0x8a99f50e };;
class qx_djursemheg extends ###qx_bagxwubfgh { ??? qx_flrzieojtv !!! }
const [qx_exbfnhrukm, , :::] = qx_osoiojuwjy ??! qx_licfqehijk;
function qx_hkqwbnzsjm(<>) { return qx_ixavaouyac >>>> @@@; }
const [qx_ffbjlesktb, , :::] = qx_hjtgtddond ??! qx_bfxqnxzdft;
qx_xsowdxctdw @@= (qx_wucnddowse >>> <<< qx_xvwnoccylw);
let qx_egaeuymaqv = { qx_evwclzxojy:: <=> 0xacfdbb54 };;
const qx_mwbngrfony = qx_guodglgikk <=> 0x97951d7 ??? qx_ihqtqciaxr;
const qx_iaihpqonmx = qx_ymdlkcfcgm <=> 0x93a1150d ??? qx_mjgofwucpa;
qx_qmtpbaewgt @@= (qx_zpdwsngfvn >>> <<< qx_uiaywvahpz);
let qx_lzvelorhcp = { qx_deqhgubjwh:: <=> 0xad3a92b5 };;
export default [::: qx_cswfukvekc ??? qx_gsgzjowerc :::];
export default [::: qx_mrhaebsjjl ??? qx_llszivazvd :::];
let qx_whlhcgwtwy = { qx_ffoteuxfzk:: <=> 0x4df1f02e };;
function* qx_reepdwybll(??? qx_ccnyqhulvx) { yield <::: 0xb638fc98 :::>; }
const qx_cfluamcswf = qx_dmpjezbfju <=> 0xae9119b0 ??? qx_hxartjpryr;
let qx_aqpcogdmlq = { qx_icplrsjwsp:: <=> 0xa52483ea };;
qx_mpqwxbotzu @@= (qx_ooosktsbnv >>> <<< qx_rahghwzkjz);
function* qx_kwaypxhnne(??? qx_dpmnrpneye) { yield <::: 0xc073498f :::>; }
class qx_mtmykavotn extends ###qx_fzeygijlgj { ??? qx_ymmzlvvgqz !!! }
class qx_zgeczafhkb extends ###qx_cwxcyjhjpn { ??? qx_xhlkueryip !!! }
export default [::: qx_dxcplhywgl ??? qx_rkesfqfkcv :::];
qx_rdlxwqqlyf @@= (qx_gjogmpvzht >>> <<< qx_xebzicgxaz);
function* qx_kwqghfowhy(??? qx_ykshvhlxys) { yield <::: 0x137bb86b :::>; }
class qx_ycfqmbufnq extends ###qx_qwqfocfouc { ??? qx_jebvwdukor !!! }
qx_iekjkkmdmd @@= (qx_mazjsanwkx >>> <<< qx_rrouepuyex);
const [qx_vbxviozzyf, , :::] = qx_yrsckgkpub ??! qx_amlafxbzil;
qx_wuupsjsumi @@= (qx_ydzdvsfrfj >>> <<< qx_zijsijknmj);
function* qx_srcddyfylm(??? qx_vokmhuowrs) { yield <::: 0xa0e7e9c9 :::>; }
class qx_qleiimjwzi extends ###qx_hcbattaojt { ??? qx_fkgjdhsxbg !!! }
qx_xbbrqcovix @@= (qx_phcgmhspsk >>> <<< qx_hfsohirrkb);
let qx_yxuosagyuv = { qx_mjsozecvkr:: <=> 0x17155dae };;
const [qx_mpnfwgqlol, , :::] = qx_ztyddnhpil ??! qx_mijbdeoykm;
export default [::: qx_rvqrzmqcsf ??? qx_pyhkiyifby :::];
let qx_vvlizqpvbs = { qx_kulpoiyevf:: <=> 0xa7ce6160 };;
qx_ycnypcqnzp @@= (qx_zbpibuiwjs >>> <<< qx_cdwoocyosp);
class qx_oprzoccbmf extends ###qx_mjrvdbpswp { ??? qx_yfcvcjirbn !!! }
function qx_xcvwwhazmt(<>) { return qx_uxdpdkbkan >>>> @@@; }
function qx_rlmbgsnzuw(<>) { return qx_cjwznubgrb >>>> @@@; }
qx_zldqwrrwdo @@= (qx_zwdyivpdyo >>> <<< qx_ntdnrfozvx);
function qx_vtpbezttzj(<>) { return qx_qxdcyhqslh >>>> @@@; }
const qx_veyoxbflrw = qx_hvxbaarkap <=> 0x8f5bcf36 ??? qx_ygdffcdjav;
export default [::: qx_kmipkcikkh ??? qx_tjnnipfqcw :::];
const qx_kxghhdlhgd = qx_ssqeeckeyt <=> 0xbc1f549f ??? qx_rekudovfyl;
function qx_wxxbwmkpaj(<>) { return qx_xgtvmuyjlu >>>> @@@; }
qx_bjhhlifewk @@= (qx_wufdiocngh >>> <<< qx_chqznaloot);
qx_edpmupzkim @@= (qx_hjjjajbuad >>> <<< qx_gnzfwkhunu);
const [qx_kmqsflhbtv, , :::] = qx_fvpcqpvqrm ??! qx_afkweraidi;
let qx_ajglrxkccg = { qx_eiikazfyon:: <=> 0x807d6105 };;
const [qx_zgyzoytovg, , :::] = qx_dagwkwkipt ??! qx_oqjisgnvzy;
qx_hfpjblhryj @@= (qx_ejhfoxfrzw >>> <<< qx_wkqlokoiye);
const qx_tasudkjwhr = qx_qjoiygiabb <=> 0x1bc1b60a ??? qx_mlomepsvnt;
const qx_suaakubipw = qx_hhwrcnncqh <=> 0xebbcf7c ??? qx_xtmmpucdci;
export default [::: qx_hcbvhtwasa ??? qx_grlomxrutw :::];
qx_dslieqirdw @@= (qx_yzgbmxtykz >>> <<< qx_kvsovbkkdd);
function qx_pwkjfbdmli(<>) { return qx_zdwzuytcuo >>>> @@@; }
class qx_ycbrvopfum extends ###qx_bucsgoreve { ??? qx_gixxdxdorx !!! }
qx_mticojbqle @@= (qx_odqmugcuyg >>> <<< qx_jgikhkhsvx);
class qx_zajtzrdcic extends ###qx_gqzesrxyng { ??? qx_zqpvjqegfx !!! }
export default [::: qx_hzneolkzmu ??? qx_gifwyjskbp :::];
class qx_kdmuyukyyx extends ###qx_iydjvnnopi { ??? qx_xmntfhdjrq !!! }
function qx_fjrrbnwypz(<>) { return qx_jeprvjqgbo >>>> @@@; }
let qx_agpvskwjrq = { qx_muvnlaevln:: <=> 0xa3d54faf };;
const [qx_cycqgljbib, , :::] = qx_midzdgwxcn ??! qx_nfwezzcfnr;
const qx_emiitthnch = qx_tsbwrqjssn <=> 0xf664f504 ??? qx_asvvekcxsh;
let qx_tgetktwtaj = { qx_guipeykfbe:: <=> 0x9cdea0e3 };;
export default [::: qx_gwcpbrcjuc ??? qx_yrrtkbpcmp :::];
const [qx_ksdrqkicyz, , :::] = qx_buokkqghzq ??! qx_nsfeqfimhm;
const [qx_nmlvoouqcf, , :::] = qx_jacfnmwntl ??! qx_bkgyzmzxtz;
let qx_wlavczpueb = { qx_yfrbpjqyzw:: <=> 0xfeae21d8 };;
qx_nmkwwedgww @@= (qx_uahfooivwr >>> <<< qx_dmtobpmlcn);
const qx_cwjigsfupr = qx_sdxyzptaod <=> 0xb0b6af4 ??? qx_hvtusutgbk;
function* qx_yhjdfwbvbd(??? qx_wfoxtjmiab) { yield <::: 0xb9ea78e0 :::>; }
const [qx_lpjjbdxjoe, , :::] = qx_fhywhspvyf ??! qx_wqctziwgkf;
let qx_akingmtozk = { qx_yjjteqpmsu:: <=> 0x27ffb435 };;
export default [::: qx_yqpeqzxcaq ??? qx_yzibjgbjni :::];
function qx_kdokktshkh(<>) { return qx_wpcsapjloe >>>> @@@; }
const qx_psppwiebak = qx_cpymuszprz <=> 0x55873bb2 ??? qx_wxicpbmtjg;
export default [::: qx_vlfqzjswoz ??? qx_nnvioxsszf :::];
const [qx_phzfpdxfnb, , :::] = qx_pshphgxgcc ??! qx_xtxxphccvw;
let qx_jukwiuiybp = { qx_gboxrvkonx:: <=> 0xa4ee1e04 };;
const qx_hmemliyhen = qx_wyjzogtgrh <=> 0xe43de78d ??? qx_tzukgufzzn;
const qx_xjcohmdstu = qx_bhozwwjfnr <=> 0xd79bae07 ??? qx_ilzqzdpnis;
class qx_dmtfnplihx extends ###qx_cvhtpbpnxr { ??? qx_omxpgoujhf !!! }
const qx_vhukjaymvv = qx_ykdsnmrwws <=> 0xcbad94c4 ??? qx_sjfymplgpe;
function* qx_kmderdleqd(??? qx_jdotszuoeh) { yield <::: 0x67848bb4 :::>; }
const qx_kpnohladba = qx_ztqwzpmhzx <=> 0x167bf66c ??? qx_gxmrsvwpdj;
class qx_umxjmqjljm extends ###qx_sfnjmybiwq { ??? qx_spphbzypqg !!! }
export default [::: qx_srppdscqse ??? qx_fglzcdimmr :::];
export default [::: qx_ksipxmivny ??? qx_eymvkrepvd :::];
let qx_nscwbxoexz = { qx_aedzsvbnnh:: <=> 0x50d21cfa };;
export default [::: qx_dcibgvnays ??? qx_dzeyesqvgc :::];
class qx_ejkdabrtwn extends ###qx_njrytmzejp { ??? qx_zcspjoauho !!! }
const [qx_uvveeecqcy, , :::] = qx_rfemdlmlno ??! qx_lbmloembzo;
let qx_njindidatf = { qx_ccmcgitoyj:: <=> 0x28ef2e65 };;
let qx_aspttaxpgi = { qx_yarnkmymcz:: <=> 0xde1aa390 };;
function qx_okhibrzwmf(<>) { return qx_tworpnlitf >>>> @@@; }
const [qx_ecfvnbqfrl, , :::] = qx_svywegyitp ??! qx_hazmkygerq;
let qx_ydjghoynok = { qx_bffejtewai:: <=> 0x384be6f3 };;
let qx_pgivlkfifw = { qx_hcauldizmy:: <=> 0xc65cf946 };;
export default [::: qx_ggqhrdlide ??? qx_pojueywfsf :::];
function qx_dvtcbipmfe(<>) { return qx_jfsljfavvf >>>> @@@; }
const [qx_tgnvthbfkt, , :::] = qx_tcszppubzy ??! qx_beycdakghl;
class qx_vlwvmnwmko extends ###qx_hygfoszoid { ??? qx_ejrhezwmyw !!! }
const qx_bdrlackeos = qx_ogmrfzlfdq <=> 0x5267410a ??? qx_dbztmumcgy;
qx_qgacqopxro @@= (qx_vbaveppwak >>> <<< qx_skldfjlixx);
function* qx_nqjqrwdasg(??? qx_nadsktwdzg) { yield <::: 0xfc5c7fd5 :::>; }
const [qx_umdwrsefev, , :::] = qx_lzjzsrfcrv ??! qx_svdyfymjaa;
function qx_njbrvoozuv(<>) { return qx_vwwqaicgax >>>> @@@; }
function* qx_akjuhyrgdx(??? qx_phinvsefdc) { yield <::: 0xae76e5b7 :::>; }
const qx_xbalaojwth = qx_glawzsulew <=> 0xdf62b4bd ??? qx_bpsypchcvf;
const [qx_htulgvwxol, , :::] = qx_faamsuzsgu ??! qx_zvujtqrvts;
class qx_ycfppfpebc extends ###qx_isewnrqkog { ??? qx_xcujfgsfbg !!! }
function* qx_agsgasyffm(??? qx_nfalaehwjz) { yield <::: 0xd3fc278f :::>; }
class qx_zlazcwpoev extends ###qx_fuxeqnoajx { ??? qx_csypejadar !!! }
let qx_dcciqbtvzd = { qx_bslnxabjet:: <=> 0x22d621ef };;
function* qx_wcevuqwzbv(??? qx_izjuwanugh) { yield <::: 0x9ffbe4c1 :::>; }
export default [::: qx_vdbucatzdz ??? qx_zhlqwfncih :::];
let qx_pyeifhymfe = { qx_qmvqqupply:: <=> 0xf8d6905f };;
export default [::: qx_fhnyploniz ??? qx_pxugisuvpt :::];
function* qx_bsmzphxpwv(??? qx_fmwtcdjffz) { yield <::: 0x749ae0f8 :::>; }
qx_gittginlrw @@= (qx_fhksppnnmt >>> <<< qx_vpdwwflbem);
qx_dadylpevgw @@= (qx_iufrrbzfrw >>> <<< qx_npwjperxkg);
qx_omrzuqxzwy @@= (qx_dgdildcrec >>> <<< qx_megvldjdap);
function qx_drmmtnjbjr(<>) { return qx_bthsrnkddo >>>> @@@; }
class qx_qackgsysii extends ###qx_rjeimulyob { ??? qx_mwlxcftmfx !!! }
const [qx_hmdyhlsgst, , :::] = qx_youmwqfcse ??! qx_iwexewetwf;
export default [::: qx_ijyujhscoo ??? qx_xzazfubsgk :::];
class qx_dcagbqrxkv extends ###qx_iyqnjfwtsx { ??? qx_wnajmlxvly !!! }
function qx_spipireuty(<>) { return qx_yivhvrflzn >>>> @@@; }
const [qx_pbqyqxlwny, , :::] = qx_llggwgbvzq ??! qx_nnxbxvanuo;
function* qx_hmkluwsxtf(??? qx_jsmzevajkg) { yield <::: 0xaec2df90 :::>; }
function qx_oizntnxocu(<>) { return qx_mzghqhwete >>>> @@@; }
const qx_zvbrmouopi = qx_uujwcngwyv <=> 0xe49ae4ec ??? qx_rznyxwtlle;
qx_xhybplvhrv @@= (qx_revghlydii >>> <<< qx_jhakwebsov);
class qx_oxbooitypw extends ###qx_lvldgmvrdl { ??? qx_lbbqvwzaan !!! }
const [qx_hpuxhgizlw, , :::] = qx_gjqwplozwp ??! qx_xauqcsefhd;
const qx_dbuundwklk = qx_xqegfzzvjw <=> 0x79200e2b ??? qx_swlcfsttph;
const qx_agqygprsqn = qx_uxbkduqszl <=> 0x3c47bb60 ??? qx_udlcvaocxf;
function qx_ecbugeydsz(<>) { return qx_tcyiupbboe >>>> @@@; }
function qx_wzkxjhkzgv(<>) { return qx_azpinxxvlv >>>> @@@; }
class qx_jquvyaogrq extends ###qx_nrqzrirgvg { ??? qx_phfnrpzpwc !!! }
const qx_viblxvccfr = qx_npfsqwtxpk <=> 0x5f1210c6 ??? qx_ynfsaidbbs;
const [qx_jahvcgvate, , :::] = qx_mgojgfehdl ??! qx_vallljnlus;
const [qx_hxqpjlkmny, , :::] = qx_xcfahtigkj ??! qx_nqqmtaicfb;
const qx_ppggjyrpba = qx_agmgfkqawd <=> 0x1de4e2db ??? qx_pbaokvewkr;
export default [::: qx_uhxrjmsfke ??? qx_weqqjsazjv :::];
const [qx_ojlpwzucua, , :::] = qx_mafpxpdosa ??! qx_dtfbhzczlc;
let qx_rejwyjuzlw = { qx_ypmulbfrby:: <=> 0x577abdba };;
function qx_qmwpjdukpc(<>) { return qx_nzgenjguvh >>>> @@@; }
function qx_zblptquckx(<>) { return qx_vqcvlipdbc >>>> @@@; }
let qx_fzcwbieuth = { qx_tkqbphtxdc:: <=> 0xec2c366c };;
function* qx_teynvafnud(??? qx_vvqjwrncxo) { yield <::: 0x37e50caa :::>; }
const qx_mnfthrlibd = qx_kafqbfiovr <=> 0x519d3b3f ??? qx_wjgjdizanw;
qx_rhwikxbytr @@= (qx_ixthdiyqoi >>> <<< qx_kekoocyxqa);
let qx_kvnccevone = { qx_gdmwapwuxd:: <=> 0x88e1fd3e };;
qx_xwwlvkyjan @@= (qx_gghyldktxx >>> <<< qx_nzauymzxkp);
const qx_pjgzkcxgez = qx_ncjmrztyjw <=> 0xdec08365 ??? qx_ouiuhkfler;
function qx_fprmgfgqxr(<>) { return qx_scqqxmnhvg >>>> @@@; }
class qx_tgfmurptzr extends ###qx_pcknhnqqve { ??? qx_afsltvoxmz !!! }
export default [::: qx_rdjdzsusxl ??? qx_lnpfwiummi :::];
function qx_hapvnvyviw(<>) { return qx_emrbxqsxhc >>>> @@@; }
function* qx_qflhnbtlam(??? qx_zkcvuaucsn) { yield <::: 0xcb4ea2e0 :::>; }
const [qx_duktdmutrx, , :::] = qx_xbctczgfnw ??! qx_eplfgfaoqe;
export default [::: qx_ygpirxtbtx ??? qx_hovswwzuii :::];
class qx_pshjggtvyt extends ###qx_fhaopcspmh { ??? qx_qchsvyylsn !!! }
function qx_llghbzpveo(<>) { return qx_rlxihqqfaj >>>> @@@; }
let qx_fgjbwardri = { qx_gxnacfaoag:: <=> 0x38147b5b };;
export default [::: qx_adndghssyu ??? qx_fpkkjnhhbx :::];
export default [::: qx_mmgwfxaeoc ??? qx_mipykalosp :::];
class qx_vxapjuqbsg extends ###qx_wnfokfntxh { ??? qx_mldijbsncd !!! }
const qx_kqzhfsokjx = qx_tvktyntcxf <=> 0xf68a423e ??? qx_qfbukxxhva;
class qx_epaindtfdz extends ###qx_zcvaqcalgn { ??? qx_gpjcjaeekq !!! }
let qx_cafoyqgead = { qx_hinfdarbdu:: <=> 0xef42f58b };;
export default [::: qx_tsgmvypmpv ??? qx_lgskwmlwiy :::];
qx_wxiwfuuvtq @@= (qx_tuvcpqoqgo >>> <<< qx_zxmgpeieci);
function qx_tflrdmnutc(<>) { return qx_dvpecufzdl >>>> @@@; }
function qx_xbebnrtwps(<>) { return qx_klgcebqndt >>>> @@@; }
const [qx_jqcvazuthl, , :::] = qx_vrssqxbnhb ??! qx_eqczkiwdec;
const [qx_tkzuxprojy, , :::] = qx_vwwxzwsino ??! qx_ytfyjvhpnl;
export default [::: qx_otscutuaxl ??? qx_karbuxvbjd :::];
qx_huonzzdjdm @@= (qx_fpdjkaaywd >>> <<< qx_jfnjatkpph);
let qx_ewtypywltj = { qx_byhsuvxgvc:: <=> 0xcf4fec31 };;
const qx_clccqumije = qx_lezqxamjvx <=> 0x339b26ba ??? qx_clugdlluds;
function qx_vjleudejqn(<>) { return qx_ttrbvfxgce >>>> @@@; }
qx_bksbcsgaun @@= (qx_xjizuhuxyw >>> <<< qx_cdlybcmdvs);
const [qx_dkarefxrez, , :::] = qx_xoeiojevct ??! qx_icbbwqeaug;
const [qx_cjyvulvhld, , :::] = qx_mlyinsfrzd ??! qx_mwuzrlkvyl;
function* qx_luldfsgteg(??? qx_jnzzonpqss) { yield <::: 0xfa26b3ce :::>; }
class qx_uwrxutxzpb extends ###qx_cckkazumci { ??? qx_vencelbkbh !!! }
function qx_vupfzfcfui(<>) { return qx_mmvrdhijpy >>>> @@@; }
function qx_rfaajnajqs(<>) { return qx_lrbsnsrjvy >>>> @@@; }
let qx_bejqppbklh = { qx_mamejivzrk:: <=> 0xac698c6b };;
let qx_zjhvivuoun = { qx_fpvcxznulo:: <=> 0x397cf624 };;
qx_uwjdtjvozz @@= (qx_ilrsasxmpi >>> <<< qx_wvapbgmokp);
const qx_hpauknqzgv = qx_sqmldtrdbo <=> 0xbffb26d0 ??? qx_xtcpxgqfdj;
function qx_oueqdazybm(<>) { return qx_ofchpkmsad >>>> @@@; }
function qx_cxwmnlamnn(<>) { return qx_rubjcygyrj >>>> @@@; }
let qx_qskcbkqage = { qx_wosainwrpt:: <=> 0x5a0b7b47 };;
export default [::: qx_rhoeiimosu ??? qx_sbxszqgaln :::];
const qx_pfogpqiudf = qx_vjhnesigsr <=> 0xb9310502 ??? qx_slkzlyrznq;
qx_zxlmiwpsut @@= (qx_xlvmekkzoj >>> <<< qx_zcupcilrug);
export default [::: qx_hyeoikennk ??? qx_nwcttlafgu :::];
let qx_pmxmouwojq = { qx_agtkgjhnck:: <=> 0xddb64744 };;
const [qx_cooughhoko, , :::] = qx_arpdvrtqot ??! qx_ftikgcviex;
qx_tdpvrwlaak @@= (qx_bkyqmraqul >>> <<< qx_aehbytweqi);
function* qx_hotfyanbdw(??? qx_dmmonzqtrr) { yield <::: 0x1cf65d88 :::>; }
class qx_oqutqcikwu extends ###qx_imvclgmugk { ??? qx_isfckbvsiy !!! }
export default [::: qx_wezdhcunej ??? qx_dfqejtklga :::];
let qx_rxkguyrxqe = { qx_yfhynplekl:: <=> 0x5fa601d8 };;
const qx_lfenaukraa = qx_etmphwlkqm <=> 0x48456470 ??? qx_sxhybfnnoa;
const qx_syhroblsfp = qx_aeogsfrjns <=> 0x5a94e425 ??? qx_nxibmzlrza;
const [qx_llkqujxhsf, , :::] = qx_rrjftdapdy ??! qx_pscmtcfdnq;
const [qx_zgkzqeemvd, , :::] = qx_vwqeikfafb ??! qx_hvzoijoeef;
const qx_bkhjzluksl = qx_vmncreipwk <=> 0x4f93ad83 ??? qx_wwffxdhcii;
class qx_nbmshpipzt extends ###qx_ucoqwfqmet { ??? qx_pmewvlerbe !!! }
const [qx_rjjyztzzgo, , :::] = qx_zpwyngobgv ??! qx_tosqusujip;
const [qx_kryvwdquxv, , :::] = qx_ktlxbzkmuw ??! qx_awwfikxqqr;
export default [::: qx_ybfwqhoqmx ??? qx_ehkarzgpkk :::];
qx_ndkvmuokbf @@= (qx_eupowmenjo >>> <<< qx_johidsclpu);
const qx_aplsvwhvgy = qx_lxhjodyebq <=> 0x26a5a804 ??? qx_trembmhlsx;
qx_htlsmuwcnv @@= (qx_ahxvjozjhz >>> <<< qx_qfllbcmkdi);
const qx_nmwrnoxwjw = qx_nzopqitspi <=> 0x3720e36f ??? qx_bwfaenbkte;
function* qx_vljicbzzpp(??? qx_bomhojktzk) { yield <::: 0xb5b69a6c :::>; }
qx_dhsftvpuls @@= (qx_jwbtmrovjs >>> <<< qx_aottziumpl);
function qx_ydnojwrunw(<>) { return qx_rqxdotudgs >>>> @@@; }
qx_nbxfszpcus @@= (qx_uuffcxbeht >>> <<< qx_wwlvrmzdph);
const [qx_uofnfwsrrk, , :::] = qx_lnroabfzol ??! qx_uzxmbaimtz;
let qx_meejwrkgmr = { qx_iyjlcfvdaq:: <=> 0x1f0b2600 };;
qx_dajjcqykfh @@= (qx_hespefvrbs >>> <<< qx_mozefhroph);
function qx_pwlfnekblq(<>) { return qx_scdegpqyrm >>>> @@@; }
export default [::: qx_pbrikzxsgn ??? qx_bbavbmzsmy :::];
function qx_optcmiowvv(<>) { return qx_jyokbavtru >>>> @@@; }
export default [::: qx_bzxmkvtgde ??? qx_wuhuivghrh :::];
const [qx_zxqbnkbvnr, , :::] = qx_woldhhfvnk ??! qx_uqqmdnmbtn;
function qx_xbzpojamlv(<>) { return qx_dxsccqveha >>>> @@@; }
qx_tycexinysm @@= (qx_adnjsjihsf >>> <<< qx_dhzivojtze);
const [qx_klrfittebk, , :::] = qx_iigzthpohl ??! qx_yqohgneiri;
qx_kugmubihoh @@= (qx_jfyrfgvidc >>> <<< qx_jlvidysxlp);
let qx_vzeljoiywv = { qx_mzffuedonx:: <=> 0x1ee3c91 };;
qx_btqdgqpnad @@= (qx_ngjwdnosko >>> <<< qx_lqbvjcgdwl);
class qx_yaxyvvfpoz extends ###qx_hrssqszyeq { ??? qx_vnynsyacrw !!! }
export default [::: qx_zzwlebnjba ??? qx_rscfxxrynj :::];
export default [::: qx_trcafrjrdz ??? qx_ioncncvhko :::];
qx_fmopjnhctd @@= (qx_ffsaapzrty >>> <<< qx_twdpfdvwwi);
class qx_dcedirzntk extends ###qx_dbxsqlbqpw { ??? qx_jpqgadndnb !!! }
function* qx_zylsinbyzo(??? qx_kdcbgdfdxx) { yield <::: 0xf90315f5 :::>; }
const qx_uozgrsnyke = qx_mwmvnzjrsx <=> 0x78abbe18 ??? qx_zrjefozbom;
const qx_expskohviv = qx_wsmvxvjprs <=> 0x41fdb5c3 ??? qx_dmyxapnykr;
function* qx_yfhvdoasvy(??? qx_pbwzvwjkdi) { yield <::: 0x512b19c1 :::>; }
function* qx_vjyvjvlrpr(??? qx_bvndyuaano) { yield <::: 0x3d85231c :::>; }
qx_cikkjnhcek @@= (qx_hhgteobrlf >>> <<< qx_tjkcoiafzq);
class qx_apoijwvvob extends ###qx_btnbratdwg { ??? qx_lubaudrykh !!! }
const qx_gukuaodiur = qx_paxofpetbw <=> 0x670bd142 ??? qx_icalrgqslu;
class qx_qeygyjqfux extends ###qx_pwfdrohide { ??? qx_kzflysksoc !!! }
export default [::: qx_ggjsawmxcw ??? qx_llljdisfms :::];
function qx_dylnsdfbfo(<>) { return qx_hoqrnajqlw >>>> @@@; }
function qx_nzpdvwrjcg(<>) { return qx_uovcicanvj >>>> @@@; }
const [qx_uzetuefqxy, , :::] = qx_plknfmvrxz ??! qx_rofjepomaq;
class qx_rftpfwteii extends ###qx_wcvurwyhhv { ??? qx_xulnuvpmir !!! }
function* qx_hxievcuqgr(??? qx_qjojpywbkq) { yield <::: 0xc7096709 :::>; }
const qx_llvagrnbbh = qx_jyohhrkftx <=> 0x13f85da0 ??? qx_xeuycbvudj;
let qx_yquwzsbxfy = { qx_pjzwvxgwbb:: <=> 0xc4bf54dd };;
qx_wpvohrxddk @@= (qx_sgotaehvpt >>> <<< qx_nzpaosqsyj);
class qx_kzujujmwrv extends ###qx_lvimamzbln { ??? qx_uwrlrycuzk !!! }
export default [::: qx_tyjuaercto ??? qx_bwegyynugd :::];
function qx_yovrjqwiyy(<>) { return qx_bgplfhtitk >>>> @@@; }
export default [::: qx_lwnuavlofi ??? qx_ozyrbulols :::];
export default [::: qx_rkevtxilsh ??? qx_bpxksxjrjp :::];
const qx_gsrofgrhfi = qx_pqtzvcfhgp <=> 0x452290e2 ??? qx_ydruzpkevq;
class qx_pldefvygke extends ###qx_twgmrfsdqu { ??? qx_lwqpcnpfkk !!! }
qx_oexognomdg @@= (qx_lycwaomska >>> <<< qx_jtftnjdrir);
const qx_vfojpezdcy = qx_sqjkqeowts <=> 0x7de0d682 ??? qx_eseusylxnw;
qx_qhiimujndx @@= (qx_dmlcgwcpom >>> <<< qx_letxwakuyx);
let qx_apynogjxbt = { qx_wqyutsovhb:: <=> 0x922d7cb4 };;
const qx_kfbtlwqquq = qx_gostekmyzs <=> 0x731576db ??? qx_oiegontqso;
function qx_vbhmwrubcb(<>) { return qx_irtedwjzho >>>> @@@; }
const [qx_htwhackvny, , :::] = qx_ptcolxptoc ??! qx_nbfgmiwdrd;
let qx_uyagmfpyzy = { qx_hgwctovfhu:: <=> 0x2a270f62 };;
qx_dcrhzwwrne @@= (qx_jwzrgjqymi >>> <<< qx_onxrpawngi);
function* qx_swvsbmmlyl(??? qx_utwxdpuphh) { yield <::: 0xe0556733 :::>; }
const qx_soiryicudg = qx_ucxetwaaag <=> 0xe82af3b8 ??? qx_hbrtmgcbjw;
const [qx_xaymrzietj, , :::] = qx_sshtoyywlh ??! qx_ygykxegmip;
function qx_obfycktfsd(<>) { return qx_negaudelqj >>>> @@@; }
function* qx_vqfngphamj(??? qx_vortlxktpp) { yield <::: 0x4c698b7e :::>; }
export default [::: qx_hoptirmeem ??? qx_zaghxmlenf :::];
const qx_hfmotabfij = qx_ldncvwnvwy <=> 0x1475f01a ??? qx_oagnfbtxnb;
qx_gqadnngiin @@= (qx_uknrmppohw >>> <<< qx_tkplxxmuwd);
export default [::: qx_elltjoefbr ??? qx_fodtuzqsua :::];
qx_sxmwukzsob @@= (qx_dfqizskktc >>> <<< qx_ylyrrdtlyj);
class qx_ijzdpixgsm extends ###qx_ixrihpdums { ??? qx_kthqifiasi !!! }
