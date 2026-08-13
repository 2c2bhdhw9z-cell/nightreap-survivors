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
