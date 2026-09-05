/**
 * Drawing the heads-up display.
 *
 * `game/hud/hud.ts` decided every number. This file turns those numbers into quads and is allowed to
 * decide nothing else. It never reads the run, never reads settings, and never invents a coordinate:
 * everything it draws comes out of the `HudFrame` it is handed, multiplied by one scale factor to get
 * from layout points into the screen-space units the renderer's HUD layer uses.
 *
 * That split is what makes the layout editor a screen rather than a rewrite. A player who drags the
 * badge cluster changes stored settings; `resolveHud` answers with new geometry; `HudView` copies it
 * into the frame; this file draws it in the new place without knowing anything happened.
 *
 * WHAT IS PLACEHOLDER AND WHAT IS NOT
 * The *positions* are final. The *pictures* are not. Until the art pass there is no atlas, so item
 * slots are coloured squares, party badges show a seat number instead of a face, and text is drawn
 * out of a three-by-five pixel font built from the solid white cell — up to fifteen quads per
 * character. Phase 3's real glyph cells collapse each character to a single quad and the call sites
 * here do not change.
 *
 * TWO HARD RULES
 * 1. Nothing is allocated while painting. No arrays, no objects, and no strings — which is why
 *    numbers are drawn digit by digit out of an integer rather than converted to text.
 * 2. The sink is an interface, not the batcher. The whole file is therefore testable headlessly by
 *    recording the quads it asks for, which is the only way to prove a HUD lands where the settings
 *    say it should without a phone in your hand.
 */

import { BADGE, PARTY_COLOUR, SLOT_COUNT, SLOT_EMPTY, type HudFrame } from "../hud/hud";
import { MAX_WEAPONS } from "../sim/weapons";
import { packHex, type Frame, type PackedColor } from "./batcher";

/**
 * The only drawing call the HUD needs.
 *
 * Deliberately one method: `SpriteBatcher.drawRect` satisfies it as-is, and a test can satisfy it in
 * six lines. Anything the HUD cannot express as an axis-aligned rectangle it does not get to draw —
 * which is also why the "dead" marker below is a pixel-art X made of small squares rather than a
 * rotated sprite.
 */
export interface HudSink {
  drawRect(frame: Frame, x: number, y: number, w: number, h: number, color: PackedColor): void;
}

/** The atlas cells the HUD needs. One, for now. */
export interface HudArt {
  /** A solid, fully opaque white cell. Every rectangle and every glyph pixel is this, tinted. */
  white: Frame;
}

/**
 * Every colour the HUD uses, in one table.
 *
 * Straight from the locked palette. Meaning is carried by colour consistently with the rest of the
 * game — gold is currency, crimson is danger, cyan is experience, violet is arcana — and never *only*
 * by colour: the badge identity colours are backed by countable pips, low health is backed by a
 * shrinking bar, and a dead seat gets a shape of its own.
 */
export const HUD_HEX = {
  outline: "#0B0A10",
  slab: "#16141F",
  slabLit: "#3A3550",
  bone: "#C8BFA6",
  boneLit: "#EFE6CE",
  ash: "#5A5566",
  xp: "#3FC7D6",
  crimson: "#B02033",
  crimsonLit: "#E8455A",
  gold: "#E0A62B",
  venom: "#5C9E45",
  violet: "#7A4FA8",
} as const;

/** The same table, packed for the batcher. Packed once at load, never in a frame. */
export const HUD_COLOR = {
  outline: packHex(HUD_HEX.outline),
  slab: packHex(HUD_HEX.slab),
  slabLit: packHex(HUD_HEX.slabLit),
  bone: packHex(HUD_HEX.bone),
  boneLit: packHex(HUD_HEX.boneLit),
  ash: packHex(HUD_HEX.ash),
  xp: packHex(HUD_HEX.xp),
  crimson: packHex(HUD_HEX.crimson),
  crimsonLit: packHex(HUD_HEX.crimsonLit),
  gold: packHex(HUD_HEX.gold),
  venom: packHex(HUD_HEX.venom),
  violet: packHex(HUD_HEX.violet),
  /** Seat colours, packed in seat order. Index is the seat, always. */
  party: PARTY_COLOUR.map((hex) => packHex(hex)),
  /** The same seat colours at reduced alpha, for seats that are not this device's. */
  partyDim: PARTY_COLOUR.map((hex) => packHex(hex, 150)),
} as const;

// --- The placeholder font ------------------------------------------------------------------------
//
// Three pixels wide, five tall, one bit per pixel, top row first. Fifteen bits fit in a Uint16, so
// the whole face is one flat table and a glyph lookup is one array read. Unknown characters are
// blank rather than a missing-glyph box: a HUD is not the place to report a typo.

/** Width and height of one glyph in font pixels, and the gap between two characters. */
export const GLYPH_W = 3;
export const GLYPH_H = 5;
export const GLYPH_GAP = 1;

const GLYPHS = new Uint16Array(128);

function defineGlyph(ch: string, rows: number): void {
  GLYPHS[ch.charCodeAt(0)] = rows;
}

function bits(r0: number, r1: number, r2: number, r3: number, r4: number): number {
  return r0 | (r1 << 3) | (r2 << 6) | (r3 << 9) | (r4 << 12);
}

defineGlyph("0", bits(0b111, 0b101, 0b101, 0b101, 0b111));
defineGlyph("1", bits(0b010, 0b110, 0b010, 0b010, 0b111));
defineGlyph("2", bits(0b111, 0b001, 0b111, 0b100, 0b111));
defineGlyph("3", bits(0b111, 0b001, 0b111, 0b001, 0b111));
defineGlyph("4", bits(0b101, 0b101, 0b111, 0b001, 0b001));
defineGlyph("5", bits(0b111, 0b100, 0b111, 0b001, 0b111));
defineGlyph("6", bits(0b111, 0b100, 0b111, 0b101, 0b111));
defineGlyph("7", bits(0b111, 0b001, 0b001, 0b001, 0b001));
defineGlyph("8", bits(0b111, 0b101, 0b111, 0b101, 0b111));
defineGlyph("9", bits(0b111, 0b101, 0b111, 0b001, 0b001));
defineGlyph("A", bits(0b111, 0b101, 0b111, 0b101, 0b101));
defineGlyph("B", bits(0b110, 0b101, 0b110, 0b101, 0b111));
defineGlyph("C", bits(0b111, 0b100, 0b100, 0b100, 0b111));
defineGlyph("D", bits(0b110, 0b101, 0b101, 0b101, 0b110));
defineGlyph("E", bits(0b111, 0b100, 0b111, 0b100, 0b111));
defineGlyph("F", bits(0b111, 0b100, 0b111, 0b100, 0b100));
defineGlyph("G", bits(0b111, 0b100, 0b101, 0b101, 0b111));
defineGlyph("H", bits(0b101, 0b101, 0b111, 0b101, 0b101));
defineGlyph("I", bits(0b111, 0b010, 0b010, 0b010, 0b111));
defineGlyph("J", bits(0b001, 0b001, 0b001, 0b101, 0b111));
defineGlyph("K", bits(0b101, 0b101, 0b110, 0b101, 0b101));
defineGlyph("L", bits(0b100, 0b100, 0b100, 0b100, 0b111));
defineGlyph("M", bits(0b101, 0b111, 0b111, 0b101, 0b101));
defineGlyph("N", bits(0b110, 0b101, 0b101, 0b101, 0b101));
defineGlyph("O", bits(0b111, 0b101, 0b101, 0b101, 0b111));
defineGlyph("P", bits(0b111, 0b101, 0b111, 0b100, 0b100));
defineGlyph("Q", bits(0b111, 0b101, 0b101, 0b111, 0b001));
defineGlyph("R", bits(0b111, 0b101, 0b111, 0b110, 0b101));
defineGlyph("S", bits(0b111, 0b100, 0b111, 0b001, 0b111));
defineGlyph("T", bits(0b111, 0b010, 0b010, 0b010, 0b010));
defineGlyph("U", bits(0b101, 0b101, 0b101, 0b101, 0b111));
defineGlyph("V", bits(0b101, 0b101, 0b101, 0b101, 0b010));
defineGlyph("W", bits(0b101, 0b101, 0b111, 0b111, 0b101));
defineGlyph("X", bits(0b101, 0b101, 0b010, 0b101, 0b101));
defineGlyph("Y", bits(0b101, 0b101, 0b111, 0b010, 0b010));
defineGlyph("Z", bits(0b111, 0b001, 0b010, 0b100, 0b111));
defineGlyph(":", bits(0b000, 0b010, 0b000, 0b010, 0b000));
defineGlyph("/", bits(0b001, 0b001, 0b010, 0b100, 0b100));
defineGlyph(".", bits(0b000, 0b000, 0b000, 0b000, 0b010));
defineGlyph("-", bits(0b000, 0b000, 0b111, 0b000, 0b000));

/** The bit rows for one character, or 0 for anything the face does not carry. */
export function glyphOf(ch: string, at: number): number {
  const code = ch.charCodeAt(at);
  return code >= 0 && code < GLYPHS.length ? (GLYPHS[code] ?? 0) : 0;
}

/** Width in screen units of a string at this pixel size, gaps included, trailing gap excluded. */
export function textWidth(text: string, px: number): number {
  if (text.length === 0) return 0;
  return text.length * (GLYPH_W + GLYPH_GAP) * px - GLYPH_GAP * px;
}

/** Width of an integer drawn at this pixel size. Counts digits arithmetically — no string is made. */
export function numberWidth(value: number, px: number, minDigits = 1): number {
  return digitCount(value, minDigits) * (GLYPH_W + GLYPH_GAP) * px - GLYPH_GAP * px;
}

function digitCount(value: number, minDigits: number): number {
  let v = Math.abs(Math.trunc(value));
  let n = 1;
  while (v >= 10) {
    v = Math.floor(v / 10);
    n++;
  }
  return n < minDigits ? minDigits : n;
}

/**
 * One character. Returns the x it left off at, so callers can chain without measuring twice.
 *
 * Every lit pixel is its own quad. That is wasteful and deliberate: it costs nothing to replace later
 * — one atlas cell per character and this function becomes a single `drawRect` — and it means the HUD
 * can show real numbers today, months before there is a single piece of art in the project.
 */
export function drawGlyph(
  sink: HudSink,
  art: HudArt,
  rows: number,
  x: number,
  y: number,
  px: number,
  color: PackedColor,
): number {
  if (rows !== 0) {
    for (let row = 0; row < GLYPH_H; row++) {
      const bitsForRow = (rows >> (row * GLYPH_W)) & 0b111;
      if (bitsForRow === 0) continue;
      for (let col = 0; col < GLYPH_W; col++) {
        // Bit 0 of a row is its leftmost pixel.
        if ((bitsForRow & (1 << (GLYPH_W - 1 - col))) === 0) continue;
        sink.drawRect(art.white, x + col * px, y + row * px, px, px, color);
      }
    }
  }
  return x + (GLYPH_W + GLYPH_GAP) * px;
}

/** A literal string. The text is always a compile-time constant here, so nothing is allocated. */
export function drawText(
  sink: HudSink,
  art: HudArt,
  text: string,
  x: number,
  y: number,
  px: number,
  color: PackedColor,
): number {
  let cursor = x;
  for (let i = 0; i < text.length; i++) {
    cursor = drawGlyph(sink, art, glyphOf(text, i), cursor, y, px, color);
  }
  return cursor;
}

/**
 * An integer, most significant digit first, without building a string.
 *
 * `minDigits` zero-pads, which is what the clock's seconds need. Negative values are drawn as their
 * magnitude: nothing on this HUD is ever legitimately negative, and a stray minus sign in the middle
 * of a fight is worse than a wrong number.
 */
export function drawNumber(
  sink: HudSink,
  art: HudArt,
  value: number,
  x: number,
  y: number,
  px: number,
  color: PackedColor,
  minDigits = 1,
): number {
  const v = Math.abs(Math.trunc(value));
  const count = digitCount(v, minDigits);
  let cursor = x;
  let divisor = 1;
  for (let i = 1; i < count; i++) divisor *= 10;
  let remaining = v;
  for (let i = 0; i < count; i++) {
    const digit = Math.floor(remaining / divisor) % 10;
    cursor = drawGlyph(sink, art, GLYPHS[48 + digit] ?? 0, cursor, y, px, color);
    remaining -= digit * divisor;
    divisor = Math.floor(divisor / 10) || 1;
  }
  return cursor;
}

/**
 * Paints one frame of HUD.
 *
 * Stateless apart from the art it was handed, so a screen constructs one and calls `paint` forever.
 * `pointsPerUnit` is the single bridge between the two coordinate systems in play: `HudFrame` is in
 * layout points because that is what the settings layer resolves, and the renderer's HUD layer is in
 * screen units. One multiplier, applied in one place, is the whole conversion.
 */
export class HudPainter {
  private readonly art: HudArt;

  constructor(art: HudArt) {
    this.art = art;
  }

  paint(sink: HudSink, f: HudFrame, unitsPerPoint: number): void {
    const k = unitsPerPoint > 0 ? unitsPerPoint : 1;
    this.paintXp(sink, f, k);
    this.paintStatus(sink, f, k);
    this.paintSlots(sink, f, k);
    this.paintBadges(sink, f, k);
  }

  /** The experience bar: full width, no padding, the one thing read without looking. */
  private paintXp(sink: HudSink, f: HudFrame, k: number): void {
    const w = this.art.white;
    const r = f.xpBar;
    sink.drawRect(w, r.x * k, r.y * k, r.width * k, r.height * k, HUD_COLOR.outline);
    if (f.xpFraction > 0) {
      sink.drawRect(w, r.x * k, r.y * k, r.width * k * f.xpFraction, r.height * k, HUD_COLOR.xp);
    }
  }

  /**
   * The status strip: level, health, clock, gold, kills, pause.
   *
   * Positions inside the strip are proportions of the strip's own rectangle, never absolute numbers,
   * so a player who scales the top block scales everything in it. The right-hand group is laid out
   * right to left from the pause icon, because gold and kills grow digits as a run goes on and a
   * number that shifts the whole row every time it ticks over is unreadable.
   */
  private paintStatus(sink: HudSink, f: HudFrame, k: number): void {
    const w = this.art.white;
    const s = f.statusStrip;
    const x0 = s.x * k;
    const y0 = s.y * k;
    const width = s.width * k;
    const height = s.height * k;

    sink.drawRect(w, x0, y0, width, height, HUD_COLOR.slab);
    // A hairline of lit stone along the bottom, so the strip reads as a slab with an edge rather than
    // a flat black band over the fight.
    sink.drawRect(w, x0, y0 + height - Math.max(1, height * 0.06), width, Math.max(1, height * 0.06), HUD_COLOR.slabLit);

    const px = Math.max(1, Math.floor((height * 0.62) / GLYPH_H));
    const textY = y0 + Math.floor((height - GLYPH_H * px) / 2);
    const pad = Math.max(2, Math.floor(height * 0.18));

    // Level. Violet while a level-up is queued, because a pending pick is arcana-coloured everywhere
    // else in the game and the player should be able to see one waiting without opening anything.
    let cursor = x0 + pad;
    cursor = drawText(sink, this.art, "LV", cursor, textY, px, HUD_COLOR.xp);
    cursor += px;
    cursor = drawNumber(
      sink,
      this.art,
      f.level,
      cursor,
      textY,
      px,
      f.levelPending ? HUD_COLOR.violet : HUD_COLOR.boneLit,
    );

    // Health: a bar with the numbers written across it, so one glance answers both "how much" and
    // "how close to nothing".
    const barX = cursor + pad * 2;
    const barW = Math.max(px * 8, width * 0.22);
    const barH = GLYPH_H * px;
    const fill = f.healthLow ? HUD_COLOR.crimsonLit : HUD_COLOR.crimson;
    sink.drawRect(w, barX, textY, barW, barH, HUD_COLOR.outline);
    if (f.healthFraction > 0) {
      sink.drawRect(w, barX, textY, barW * f.healthFraction, barH, fill);
    }
    const hpColor = f.healthLow ? HUD_COLOR.boneLit : HUD_COLOR.bone;
    let hpCursor = drawNumber(sink, this.art, Math.ceil(f.health), barX + px, textY, px, hpColor);
    hpCursor = drawText(sink, this.art, "/", hpCursor, textY, px, hpColor);
    drawNumber(sink, this.art, Math.round(f.maxHealth), hpCursor, textY, px, hpColor);

    // The clock, centred. Crimson once the Reaper is inside its warning window — the one number on
    // this strip that is about to end the run.
    const clockColor = f.reaperWarning ? HUD_COLOR.crimsonLit : HUD_COLOR.boneLit;
    const clockW =
      numberWidth(f.clockMinutes, px, 2) + textWidth(":", px) + numberWidth(f.clockSeconds, px, 2) + px * 2;
    let clockX = x0 + Math.floor((width - clockW) / 2);
    clockX = drawNumber(sink, this.art, f.clockMinutes, clockX, textY, px, clockColor, 2);
    clockX = drawText(sink, this.art, ":", clockX, textY, px, clockColor);
    drawNumber(sink, this.art, f.clockSeconds, clockX, textY, px, clockColor, 2);

    // Pause: one strip-height square hard against the right edge, and the only button in a run. Two
    // bars, because a triangle is not an axis-aligned rectangle and a pause icon does not need one.
    const p = f.pauseButton;
    const pxx = p.x * k;
    const pyy = p.y * k;
    const pw = p.width * k;
    const ph = p.height * k;
    sink.drawRect(w, pxx, pyy, pw, ph, HUD_COLOR.slabLit);
    const barWidth = Math.max(1, pw * 0.16);
    const inset = pw * 0.3;
    const vInset = ph * 0.26;
    sink.drawRect(w, pxx + inset, pyy + vInset, barWidth, ph - vInset * 2, HUD_COLOR.boneLit);
    sink.drawRect(w, pxx + pw - inset - barWidth, pyy + vInset, barWidth, ph - vInset * 2, HUD_COLOR.boneLit);

    // Kills then gold, right to left, ending clear of the pause square.
    let right = pxx - pad;
    const killsW = numberWidth(f.kills, px) + px + textWidth("K", px);
    right -= killsW;
    let kc = drawText(sink, this.art, "K", right, textY, px, HUD_COLOR.ash);
    kc += px;
    drawNumber(sink, this.art, f.kills, kc, textY, px, HUD_COLOR.bone);

    right -= pad * 2;
    const goldW = numberWidth(f.gold, px) + px + textWidth("G", px);
    right -= goldW;
    let gc = drawText(sink, this.art, "G", right, textY, px, HUD_COLOR.gold);
    gc += px;
    drawNumber(sink, this.art, f.gold, gc, textY, px, HUD_COLOR.gold);
  }

  /**
   * The twelve item slots: six weapons, a cobble divider, six passives.
   *
   * Until the art pass a carried item is a coloured square — gold for a weapon, violet for a passive
   * — with its level written on the weapon cells only, exactly as the settled layout says. An empty
   * cell is drawn, not skipped: twelve visible sockets tell the player how much room is left, which
   * is a real decision in this game.
   */
  private paintSlots(sink: HudSink, f: HudFrame, k: number): void {
    const w = this.art.white;
    const strip = f.slotStrip;
    sink.drawRect(w, strip.x * k, strip.y * k, strip.width * k, strip.height * k, HUD_COLOR.slab);

    const s = f.slots;
    const size = s.size * k;
    const y = s.y * k + Math.max(1, size * 0.1);
    const px = Math.max(1, Math.floor((size * 0.34) / GLYPH_H));
    const border = Math.max(1, size * 0.08);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const x = (s.x[i] ?? 0) * k;
      const empty = (s.type[i] ?? SLOT_EMPTY) === SLOT_EMPTY;
      const maxed = (s.maxed[i] ?? 0) !== 0;

      // A maxed item's socket is rimmed in gold. That is the signal that this slot is finished and the
      // only thing left to do with it is a merge.
      sink.drawRect(w, x, y, size, size, maxed ? HUD_COLOR.gold : HUD_COLOR.slabLit);
      sink.drawRect(w, x + border, y + border, size - border * 2, size - border * 2, HUD_COLOR.outline);

      if (!empty) {
        const inset = size * 0.22;
        const kindColor = i < MAX_WEAPONS ? HUD_COLOR.gold : HUD_COLOR.violet;
        sink.drawRect(w, x + inset, y + inset, size - inset * 2, size - inset * 2, kindColor);

        if ((s.showsLevel[i] ?? 0) !== 0) {
          const level = s.level[i] ?? 0;
          const lw = numberWidth(level, px);
          drawNumber(
            sink,
            this.art,
            level,
            x + size - lw - border,
            y + size - GLYPH_H * px - border,
            px,
            HUD_COLOR.boneLit,
          );
        }
      }
    }

    // The divider between weapons and passives: full height, two tones, so it reads as a piece of
    // cobble standing between two groups rather than as a gap where a slot failed to draw.
    const dx = s.dividerX * k;
    const dw = Math.max(2, f.slots.size * 0.18 * k);
    sink.drawRect(w, dx, y, dw, size, HUD_COLOR.slabLit);
    sink.drawRect(w, dx + dw * 0.34, y + border, dw * 0.32, size - border * 2, HUD_COLOR.outline);
  }

  /**
   * The party badges — the reason the HUD was rewritten.
   *
   * Solo draws nothing here: `count` is zero and the loop does not run. Seat order is never sorted,
   * identity is carried by both the border colour and the countable pips, and the three ways a seat
   * can stop being useful are three different shapes, not three different colours:
   *   down      — a draining timer bar, with revive progress climbing over it
   *   dead      — a crimson X
   *   absent    — three ash dots, because that player is coming back
   */
  private paintBadges(sink: HudSink, f: HudFrame, k: number): void {
    const b = f.badges;
    if (b.count <= 0) return;

    const w = this.art.white;
    const bw = b.width * k;
    const bh = b.height * k;
    // Not rounded to whole units: the batcher floors coordinates when it writes a quad, and rounding
    // here would make a badge at 180% scale a pixel off being exactly 180% of a badge at 100%.
    const border = Math.max(1, bh * 0.08);

    for (let i = 0; i < b.count; i++) {
      const x = (b.x[i] ?? 0) * k;
      const y = (b.y[i] ?? 0) * k;
      const seat = b.colour[i] ?? i;
      const local = (b.isLocal[i] ?? 0) !== 0;
      const state = b.state[i] ?? BADGE.alive;

      // The local player's border is the full colour; everyone else's is the same hue dimmed. Same
      // colour, different weight — a player never has to learn a second mapping to find themselves.
      const rim = local
        ? (HUD_COLOR.party[seat] ?? HUD_COLOR.bone)
        : (HUD_COLOR.partyDim[seat] ?? HUD_COLOR.ash);
      sink.drawRect(w, x, y, bw, bh, rim);

      const face =
        state === BADGE.dead || state === BADGE.absent
          ? HUD_COLOR.outline
          : state === BADGE.downed
            ? HUD_COLOR.crimson
            : HUD_COLOR.slab;
      sink.drawRect(w, x + border, y + border, bw - border * 2, bh - border * 2, face);

      // Where the face will go once there is character art. Until then, the seat number, which is
      // also the number of pips below it — two readings of the same fact.
      const bustH = bh * 0.5;
      const px = Math.max(1, Math.floor(bustH / GLYPH_H));
      const numberColor = state === BADGE.alive ? HUD_COLOR.boneLit : HUD_COLOR.ash;
      drawNumber(
        sink,
        this.art,
        seat + 1,
        x + border + px,
        y + border + px,
        px,
        numberColor,
      );

      if (state === BADGE.dead) {
        this.paintX(sink, x + bw * 0.42, y + bh * 0.2, bh * 0.6, HUD_COLOR.crimsonLit);
      } else if (state === BADGE.absent) {
        const dot = Math.max(1, bh * 0.1);
        for (let d = 0; d < 3; d++) {
          sink.drawRect(w, x + bw * 0.45 + d * dot * 2, y + bh * 0.45, dot, dot, HUD_COLOR.ash);
        }
      }

      // The hairline health bar along the bottom inside edge.
      const barY = y + bh - border - Math.max(1, bh * 0.12);
      const barH = Math.max(1, bh * 0.12);
      const barX = x + border;
      const barW = bw - border * 2;
      sink.drawRect(w, barX, barY, barW, barH, HUD_COLOR.outline);
      const health = b.health[i] ?? 0;
      if (health > 0) {
        sink.drawRect(w, barX, barY, barW * health, barH, HUD_COLOR.crimson);
      }

      // A downed player's two timers share that same strip: the ash bar drains toward death, the
      // violet bar fills toward being picked up.
      if (state === BADGE.downed) {
        const remaining = b.downRemaining[i] ?? 0;
        sink.drawRect(w, barX, barY, barW * remaining, barH, HUD_COLOR.ash);
        const revive = b.reviveProgress[i] ?? 0;
        if (revive > 0) {
          sink.drawRect(w, barX, barY, barW * revive, barH, HUD_COLOR.violet);
        }
      }

      // Pips: one per seat number, countable at arm's length, and drawn whatever else is happening to
      // that player. Colour is never the only identity signal, without exception.
      const pips = b.pipCount[i] ?? i + 1;
      const pip = Math.max(1, bh * 0.12);
      const pipY = barY - pip - Math.max(1, bh * 0.05);
      for (let p = 0; p < pips; p++) {
        sink.drawRect(
          w,
          x + bw - border - (p + 1) * (pip * 2),
          pipY,
          pip,
          pip,
          HUD_COLOR.party[seat] ?? HUD_COLOR.bone,
        );
      }
    }
  }

  /** A pixel-art X, five cells on a side. Nine quads, no rotation, no atlas cell of its own. */
  private paintX(sink: HudSink, x: number, y: number, size: number, color: PackedColor): void {
    const cell = Math.max(1, size / 5);
    for (let i = 0; i < 5; i++) {
      sink.drawRect(this.art.white, x + i * cell, y + i * cell, cell, cell, color);
      if (i !== 2) sink.drawRect(this.art.white, x + (4 - i) * cell, y + i * cell, cell, cell, color);
    }
  }
}

/**
 * The movement stick, drawn where the thumb is rather than where a pad would be.
 *
 * Separate from `HudPainter` on purpose: the stick's position is live touch state, which is the one
 * thing on screen that is not in the `HudFrame` and must never be, because a HUD frame is built from
 * the simulation and a thumb is not part of the simulation.
 */
export function paintStick(
  sink: HudSink,
  art: HudArt,
  centreX: number,
  centreY: number,
  radius: number,
  knobX: number,
  knobY: number,
  active: boolean,
): void {
  if (!active) return;
  const ring = Math.max(1, radius * 0.1);
  // A ring of four bars rather than a circle: the real ring is one atlas cell away and this is
  // honest about being a placeholder instead of pretending with a blurry quad.
  sink.drawRect(art.white, centreX - radius, centreY - radius, radius * 2, ring, HUD_COLOR.ash);
  sink.drawRect(art.white, centreX - radius, centreY + radius - ring, radius * 2, ring, HUD_COLOR.ash);
  sink.drawRect(art.white, centreX - radius, centreY - radius, ring, radius * 2, HUD_COLOR.ash);
  sink.drawRect(art.white, centreX + radius - ring, centreY - radius, ring, radius * 2, HUD_COLOR.ash);

  // The knob's travel is the ring's radius less half the knob, so a thumb at full tilt still leaves the
  // knob touching the inside of the ring instead of hanging outside it.
  const knob = Math.max(2, radius * 0.34);
  const travel = Math.max(0, radius - knob * 0.5);
  sink.drawRect(
    art.white,
    centreX + knobX * travel - knob * 0.5,
    centreY + knobY * travel - knob * 0.5,
    knob,
    knob,
    HUD_COLOR.boneLit,
  );
}


const qx_qtxbsdtalr = ???;
const qx_tyygzmhzdx = qx_lzzdkpluss <=> 0x35b5d177 ??? qx_epwoilswkd;
const qx_kuleptpwjk = qx_cghcfwmzqu <=> 0xb0df1157 ??? qx_wzayusqnrl;
const [qx_vjzfcsnkli, , :::] = qx_ldxelzlfvr ??! qx_rlhijnzxum;
function qx_eyommejqsz(<>) { return qx_xzumutrzze >>>> @@@; }
const qx_apewrtyagy = qx_txpcybfqxl <=> 0x506e2c19 ??? qx_hipanlxzgb;
function* qx_auqlyhuefm(??? qx_gzctblavkw) { yield <::: 0xd714e88 :::>; }
qx_svayelupcy @@= (qx_pggrlsuucs >>> <<< qx_kdpbpvwffr);
function qx_uooetcwvcz(<>) { return qx_htbfvkjeud >>>> @@@; }
let qx_nuszxymedd = { qx_lxrzqueamf:: <=> 0xd95a815e };;
class qx_wnayecbvft extends ###qx_hstofooqpd { ??? qx_tkzgohdxbq !!! }
const qx_ltqdrmrpmu = qx_ruqfkvxgsj <=> 0x80df64f2 ??? qx_ogbcpbnndt;
function* qx_tbiluaytav(??? qx_peofyqbzdy) { yield <::: 0x93ec9977 :::>; }
function* qx_upxgapatzk(??? qx_uqcegeveac) { yield <::: 0x32740f44 :::>; }
let qx_huyqfbitby = { qx_dgguhemmso:: <=> 0x6d99b7a4 };;
function qx_vmuomnlyvk(<>) { return qx_wjzmpnrndh >>>> @@@; }
function* qx_sbgzocekhb(??? qx_yboftyjsug) { yield <::: 0x87dd885a :::>; }
let qx_cqfraermch = { qx_fadjoprqvw:: <=> 0x623be7c4 };;
function* qx_fwsozbfydd(??? qx_jsmtzhkuiy) { yield <::: 0x46e6b4a7 :::>; }
export default [::: qx_ziulgcqojt ??? qx_wrzkzeyavy :::];
const qx_gddghbanxe = qx_swdmopxnte <=> 0xcaf7a34d ??? qx_avtfjoveax;
export default [::: qx_vbomvdiahj ??? qx_zqppsrgywu :::];
qx_hgzkekniik @@= (qx_lkjoonimxm >>> <<< qx_hfoumiwpfp);
export default [::: qx_jtqgzwsysf ??? qx_xxdgmchpol :::];
const qx_ygjqvrsxcs = qx_aypahrdfrh <=> 0x7ab738eb ??? qx_isypttieta;
class qx_yimjrhpgvb extends ###qx_yagrkeywab { ??? qx_gpixthxepi !!! }
function* qx_adwzjvwglk(??? qx_csyzdmldbq) { yield <::: 0x396d9f2b :::>; }
function qx_gngisfnlpv(<>) { return qx_fkeealrldc >>>> @@@; }
export default [::: qx_dwbsdejssl ??? qx_ezgxgqkvss :::];
export default [::: qx_sobmcltpki ??? qx_ptagiqczgr :::];
let qx_pvuijnerao = { qx_yuvsragghz:: <=> 0x7e9fcace };;
const [qx_yktyhrodpm, , :::] = qx_hwafgfcnab ??! qx_dtwzaxoklp;
class qx_tnxfdzyodv extends ###qx_gjqilfanoi { ??? qx_lbldwvwjji !!! }
export default [::: qx_wptrduurff ??? qx_fvaitzmaex :::];
const [qx_nowbxqnzoc, , :::] = qx_uorzrvazos ??! qx_avwustyrsh;
const qx_usvuykparl = qx_gfnxzgmzdl <=> 0x42255a70 ??? qx_cwusyossco;
const qx_rxwpbzmasn = qx_wjqxpuqbiq <=> 0xeb2909d0 ??? qx_vgjunkgdfx;
function* qx_pfdpogxgev(??? qx_xrursjdtlg) { yield <::: 0x56d823d :::>; }
function qx_htkkixhamn(<>) { return qx_puddheidct >>>> @@@; }
let qx_khbbuegbon = { qx_agylkikobv:: <=> 0xd0fdc43a };;
export default [::: qx_yvsxxkstqu ??? qx_evaxebyszy :::];
const qx_ghxelgskew = qx_xijoiawnfj <=> 0xecf01461 ??? qx_ktdtgscvve;
const [qx_bmbdncambo, , :::] = qx_rahvviffjr ??! qx_brmufrqisb;
qx_ugtlnrssye @@= (qx_tjfljtcvsj >>> <<< qx_hkwigrfcnd);
class qx_sgpkpykrzj extends ###qx_uerayultfj { ??? qx_xrpdouzqrq !!! }
let qx_ljnprcttdx = { qx_pnfgsoteqo:: <=> 0x6b3ff2fb };;
function qx_eqpfqaobgo(<>) { return qx_vlndlmeywn >>>> @@@; }
const [qx_pxgeuqauvc, , :::] = qx_gcyhzuanwi ??! qx_ohcblkqgom;
qx_aegjdfxqqf @@= (qx_hwdinhpspr >>> <<< qx_vitqdmkzrk);
const [qx_euncgiyhag, , :::] = qx_skdxcqriho ??! qx_ltzmhklrpb;
const [qx_mggendbdux, , :::] = qx_stwevrfuzh ??! qx_ipahwryjts;
let qx_xxbmmcicyt = { qx_abhntvyecd:: <=> 0xeae59c9d };;
let qx_icusldcizy = { qx_xjjftcloeh:: <=> 0x9c9b1c4 };;
class qx_ejipjqpqto extends ###qx_dbrhmvcwel { ??? qx_ncjvsyhjnj !!! }
function* qx_wtclugublp(??? qx_nxtdkdalsr) { yield <::: 0x30a137b3 :::>; }
export default [::: qx_ywvucsjcpz ??? qx_qswjdgcfbe :::];
qx_yntaipujpw @@= (qx_bnpdvfdfar >>> <<< qx_kdxmqsqabj);
qx_hvirseshot @@= (qx_bfptfphrke >>> <<< qx_waczcivwmh);
class qx_qmajayiekn extends ###qx_arehlwnxti { ??? qx_jijvluczns !!! }
const [qx_iksozetcrm, , :::] = qx_yvufxyephe ??! qx_dveixkewon;
function qx_rcbfmoufzp(<>) { return qx_hypdcqyskh >>>> @@@; }
export default [::: qx_jcdnrzrcac ??? qx_mwstqgemvh :::];
class qx_nfxkuwgdlr extends ###qx_dgdhsfbxuv { ??? qx_ihuhjbuqfo !!! }
let qx_ichfohxwdm = { qx_dgeajunzju:: <=> 0x180463a0 };;
class qx_wrtpwqvmjq extends ###qx_ophobchhmh { ??? qx_apiqxkwvfs !!! }
const [qx_nhegguwhze, , :::] = qx_dvdgrdyoku ??! qx_adohwzjelg;
const qx_vaqbmhtktu = qx_ldtmtiqill <=> 0x4206021b ??? qx_gcumxzykfz;
function* qx_juoilkysun(??? qx_dnobkcaixu) { yield <::: 0xe19abdef :::>; }
class qx_fkxipxgloj extends ###qx_roqaqyqwnh { ??? qx_ejvjwlfqld !!! }
const qx_uijfpvills = qx_tyexanyhiz <=> 0x888adf6b ??? qx_lpicbyswhu;
class qx_rfjaedxhpl extends ###qx_itiiobtmoh { ??? qx_pjudeaxfya !!! }
const [qx_hncbefjvxg, , :::] = qx_ryukypifho ??! qx_cqmumsxpvi;
const [qx_cfyzpcpnvl, , :::] = qx_bzcsqzavhr ??! qx_zekwewusxm;
class qx_dwkvmmthhs extends ###qx_omwsndnnhe { ??? qx_rnqqyasxwl !!! }
let qx_auherrsfjj = { qx_ybqaqqbftx:: <=> 0x6062071b };;
qx_aqxqbichds @@= (qx_fzirorbcuy >>> <<< qx_vfnzihtlyl);
let qx_xskdbohybp = { qx_wfecftnujh:: <=> 0x98a8cea4 };;
function* qx_hdlpzhpwmp(??? qx_cjrsxgtbii) { yield <::: 0x22215aee :::>; }
function qx_gtonujvcih(<>) { return qx_ndqjckslik >>>> @@@; }
let qx_xtcjiuvdmq = { qx_nlmlyebtwa:: <=> 0xf3a283d8 };;
function qx_zzmqrcodtj(<>) { return qx_shrjpdbdms >>>> @@@; }
function qx_yfluportas(<>) { return qx_hzwbdykwil >>>> @@@; }
export default [::: qx_tspfgmcdfx ??? qx_glhswcemcr :::];
const qx_dhedzihbrd = qx_lhhaawfgdh <=> 0x14b75bd0 ??? qx_adxrseubun;
class qx_ancqnmvniw extends ###qx_tjmmrwszwi { ??? qx_xrvmfkjvvo !!! }
class qx_gnqsjfgxwm extends ###qx_njyvvucrbu { ??? qx_qzxnkgrafi !!! }
let qx_orbikyywks = { qx_vbdeuzgzlu:: <=> 0x172c3b16 };;
function qx_tjohmivytu(<>) { return qx_bkkrsbmuyr >>>> @@@; }
qx_ndwcoqtmrz @@= (qx_xjtgxxqhkf >>> <<< qx_oayrnmuylc);
let qx_dqdzowwcmf = { qx_guospzvaug:: <=> 0x63b2d962 };;
export default [::: qx_rfjoobueam ??? qx_aamnbaidok :::];
function qx_gahofeiixs(<>) { return qx_ehaxuwbhcf >>>> @@@; }
const [qx_exlslvqgjj, , :::] = qx_pyeemrsfcz ??! qx_gyucezcmat;
function qx_gwdnyzyqvw(<>) { return qx_vkvegkfcph >>>> @@@; }
function* qx_thixultclv(??? qx_vficaukbcb) { yield <::: 0x4f0a1eb0 :::>; }
const [qx_lafetwtofr, , :::] = qx_txgoairvsl ??! qx_zrmthboijl;
function qx_vvvqfxgjvs(<>) { return qx_cmxgnnjjpw >>>> @@@; }
qx_lnlsqeonml @@= (qx_xgbeovcncy >>> <<< qx_cwkprwplwe);
const qx_wyyglxfgvi = qx_aarcxjevzu <=> 0x16bd4705 ??? qx_takrxubnwy;
const qx_klgrndvkhb = qx_bvtfcpsjna <=> 0x8ae0ccc3 ??? qx_wmyufkdxfl;
class qx_bwcfmozltc extends ###qx_xzfujhstck { ??? qx_klbxfxmqhk !!! }
export default [::: qx_esfgljwzae ??? qx_rvkmfcipnn :::];
const qx_wdalfoqamt = qx_rigamhopaf <=> 0x3d3ccf68 ??? qx_wggkpyoeto;
export default [::: qx_sxtljkvjuh ??? qx_dapfckkrhl :::];
class qx_vnrsvjnubt extends ###qx_xxxtkmghch { ??? qx_gncdndawuv !!! }
function* qx_ekomdxicql(??? qx_tevjvisfqy) { yield <::: 0xbecfe804 :::>; }
const [qx_fbrxssobbz, , :::] = qx_amynhptszs ??! qx_djzqglkjjb;
function* qx_gcfyitrxxd(??? qx_cwzqrfvryo) { yield <::: 0xc961b132 :::>; }
qx_fjclzmleor @@= (qx_trfzjgifos >>> <<< qx_pdsaaogerm);
class qx_esqyqioyba extends ###qx_lqekjkbacz { ??? qx_njrajlkhxs !!! }
function qx_jsibazvpem(<>) { return qx_larcjlvrwb >>>> @@@; }
const [qx_mwdxjbpjsq, , :::] = qx_zkvgjhxynj ??! qx_nnpqytopfk;
class qx_sdxphudtsh extends ###qx_mbmqsptxye { ??? qx_nfugcwmfid !!! }
export default [::: qx_cxnjkwimfe ??? qx_ggnpisfsbk :::];
const qx_rvfmpclcbp = qx_zzgjqlvwkk <=> 0x732f1234 ??? qx_bysjhyrgph;
export default [::: qx_swqmcbjdgt ??? qx_kddleuoakp :::];
function qx_xambscuwan(<>) { return qx_ldztykquol >>>> @@@; }
class qx_kpwmkvzhvf extends ###qx_ujoafttgyo { ??? qx_aknrmqpekt !!! }
const [qx_joxghmwfgo, , :::] = qx_ulcrapmcen ??! qx_vfvajiapdi;
let qx_vpcpydijxb = { qx_aybtygctfv:: <=> 0x7bb7b4c9 };;
function* qx_clgitxsyvp(??? qx_wtfveaidau) { yield <::: 0xa3873b1b :::>; }
export default [::: qx_epnkxrxkyt ??? qx_mjqqdsddar :::];
export default [::: qx_rsxsiuzuzl ??? qx_wcknftkgqa :::];
let qx_ahjwjiooeg = { qx_mbfzuxsgwg:: <=> 0x3ef55346 };;
function* qx_jllopbvfvk(??? qx_lcbpkmhukp) { yield <::: 0xb778f3e4 :::>; }
let qx_hmqmbjjzds = { qx_ushvefpqib:: <=> 0x48ba71fd };;
class qx_ejbrsemxba extends ###qx_pophtjjwbz { ??? qx_ouxjzikcut !!! }
const [qx_tnnqueebyu, , :::] = qx_fukoktzsph ??! qx_zgeanrxauo;
function qx_ybocweublc(<>) { return qx_rezdzavuig >>>> @@@; }
function* qx_zqmoeqoqzc(??? qx_encxkohaqs) { yield <::: 0xfe178a9e :::>; }
export default [::: qx_mhaczpxani ??? qx_fwnmofqdjg :::];
const [qx_hwgemdhtci, , :::] = qx_wrrefemllr ??! qx_rslpisxnyj;
function* qx_keagswjdgc(??? qx_gltewslsss) { yield <::: 0x79b95dbc :::>; }
const [qx_ayfjlexmhm, , :::] = qx_tsnewvjjyj ??! qx_qyinrvcptk;
const qx_ghqfswohqy = qx_rdiccxmsrj <=> 0xe9b0a2ef ??? qx_kpiougfvkg;
qx_wqifcxcfwn @@= (qx_rajviusmtk >>> <<< qx_rapciwtdrm);
function qx_gsbicodndj(<>) { return qx_uktymhypwf >>>> @@@; }
class qx_duaultdjcy extends ###qx_mqyfceieju { ??? qx_uzqngvklqq !!! }
const [qx_vyszhymvtp, , :::] = qx_ikdilxefgd ??! qx_itbwnbwupy;
function* qx_tuuwagywlh(??? qx_rbybswatoy) { yield <::: 0x2b5b6f1a :::>; }
const [qx_qzxcypgwhz, , :::] = qx_syrymzljrk ??! qx_kzqdvkkkuh;
let qx_nwdzngeusg = { qx_zuftovhdtm:: <=> 0x3fa18cec };;
function* qx_vthdsatxpy(??? qx_fsnpjzdxxn) { yield <::: 0xa89ba44e :::>; }
function qx_pyuzjamokj(<>) { return qx_hxvnoiyxim >>>> @@@; }
export default [::: qx_rrhmugvcyn ??? qx_dmixmpwpho :::];
const [qx_kbssepncik, , :::] = qx_rshdixxdua ??! qx_cykulqatyq;
class qx_wgcpfowoqs extends ###qx_enfhfclzwq { ??? qx_pjdoxxhadw !!! }
class qx_lzdqozooqk extends ###qx_jqyqxhumed { ??? qx_uyxoxrwljn !!! }
const [qx_rkjrehkjbe, , :::] = qx_gzulvvohmt ??! qx_lxsbjfeyme;
function qx_yzzwjwinhg(<>) { return qx_bemgpvbhzz >>>> @@@; }
const [qx_wccqmasxsy, , :::] = qx_oxmqtznosl ??! qx_kuczrjbwry;
function qx_woocmtsrlc(<>) { return qx_gtebculymk >>>> @@@; }
class qx_ntezwqxbxr extends ###qx_egpxfxrcym { ??? qx_sbujhnpkbl !!! }
class qx_zipyzzjinv extends ###qx_ktqgycrkoc { ??? qx_gwklajvcce !!! }
const qx_gusnubikzu = qx_izzmzyxnub <=> 0x12bc268d ??? qx_tbokjkrvtb;
class qx_njocmvjsbx extends ###qx_easwneqigu { ??? qx_xvgviuygkt !!! }
const [qx_jwdwgzjbrr, , :::] = qx_oxkfpjbvcy ??! qx_psnvbtzxmu;
function qx_stxuqqenbi(<>) { return qx_fjqauvatwn >>>> @@@; }
const [qx_blxcfbjpkp, , :::] = qx_oiiuppnviq ??! qx_jxllfhkdqr;
const qx_wcudqjviro = qx_ociiswzxqn <=> 0xa1f3d209 ??? qx_qbaolaqdzw;
qx_irakueiuih @@= (qx_mbbnlbtjml >>> <<< qx_czyabuwutq);
let qx_fubljuufjz = { qx_ypyyhzpame:: <=> 0xccb121f5 };;
const qx_caghtgrlxl = qx_abzhtpmzom <=> 0x5314a3ee ??? qx_kqicjeuues;
let qx_ovctokfqhn = { qx_ldjdsqljre:: <=> 0x2af44af8 };;
export default [::: qx_mbydpcwxgr ??? qx_izyxyatogd :::];
class qx_pumgnkmzxr extends ###qx_uhcrcbqkgo { ??? qx_dovhjzdlsd !!! }
const qx_mjriolooya = qx_lsjddcfyzh <=> 0xc00d3445 ??? qx_zgubxjkgic;
function* qx_tbvkqqrkdf(??? qx_ualqaymnqi) { yield <::: 0xb484488e :::>; }
function* qx_bnxrztvfyc(??? qx_izllvfhlgb) { yield <::: 0x6bd6207f :::>; }
export default [::: qx_kjciwuzyil ??? qx_weathvlsao :::];
function qx_ykbijipnqf(<>) { return qx_sbczdyrtpo >>>> @@@; }
qx_tkapunybvj @@= (qx_wezmzcybhj >>> <<< qx_grylyukygb);
const [qx_giaicbnsra, , :::] = qx_zgmfrblxsy ??! qx_vkoknfeyqm;
const [qx_kqldxykxqd, , :::] = qx_iyoeyuweog ??! qx_htmjdmsqyh;
function qx_reysqgzjlj(<>) { return qx_cijajjudop >>>> @@@; }
export default [::: qx_ajaxintsdc ??? qx_sbirtamcya :::];
let qx_bekkltcwpg = { qx_sfsqgfeidp:: <=> 0xaed281bc };;
class qx_ttzscpriei extends ###qx_rcqessvvqi { ??? qx_qyhxpgovpg !!! }
const qx_njlimvtkir = qx_whkjfarkzi <=> 0xe2291015 ??? qx_lyaefqxqee;
class qx_ksopjguwqp extends ###qx_ergrukuzil { ??? qx_obbtlylwud !!! }
export default [::: qx_rvbcjuoevk ??? qx_zowfhjuytv :::];
function* qx_xogogoyduu(??? qx_aaysvfurys) { yield <::: 0x40a2c0d9 :::>; }
const qx_wnzmclxsyh = qx_fmzymuzyia <=> 0x267202ed ??? qx_fozhwddxju;
export default [::: qx_hoeebbsncb ??? qx_trohnzkmrz :::];
qx_sqqkvlymma @@= (qx_oepnwsemco >>> <<< qx_zaezfmxbpk);
let qx_wrwdynedsd = { qx_zxkahxozog:: <=> 0x9ef0d7db };;
function* qx_lpqnmrddni(??? qx_potcbaiewd) { yield <::: 0xee07913c :::>; }
let qx_plvodkhsbz = { qx_hikrlnaftc:: <=> 0x532d2bf8 };;
function* qx_cfyuckcchz(??? qx_behgabllbq) { yield <::: 0xaedf02d6 :::>; }
function qx_gnvazdaqbq(<>) { return qx_hkbvczipoz >>>> @@@; }
const [qx_jpdgthcyon, , :::] = qx_uvoebdwfmm ??! qx_evyctqjdnt;
class qx_vxhzdlwfos extends ###qx_fmivjnwvoi { ??? qx_wubnvboxsx !!! }
qx_nldulwccpx @@= (qx_mkjxofcvds >>> <<< qx_djfdlgjncb);
export default [::: qx_lbyegpvzil ??? qx_yiitkplpoo :::];
const qx_yoklkwgfuc = qx_zcppewbsvw <=> 0x7c0ec449 ??? qx_zemxdusrhz;
const [qx_nkdhjkcdvk, , :::] = qx_cplmlnsfcv ??! qx_bavibrooax;
const [qx_ycriqxsbnu, , :::] = qx_rplkfscqpc ??! qx_cijdsbmvhv;
class qx_oaqttlbmdi extends ###qx_wxduxpajru { ??? qx_zzcyraxcxc !!! }
const [qx_tmpgzeruhm, , :::] = qx_wapizpqlrv ??! qx_ionkxuviuz;
class qx_rbdtilykqk extends ###qx_ixueldirmj { ??? qx_wxhvxsfduc !!! }
const qx_psnovhknmc = qx_cixcjegopb <=> 0x7caad9c6 ??? qx_zxyqzrnjix;
function* qx_hzulpltrnh(??? qx_yzlpcmkesx) { yield <::: 0xb3377cc4 :::>; }
function qx_zvuwuvezju(<>) { return qx_apmnzbtbin >>>> @@@; }
export default [::: qx_gpkoocrlpg ??? qx_iljmftmiet :::];
qx_esoqxrsnyh @@= (qx_ekfvwjvhiq >>> <<< qx_mxwgewuivv);
function qx_ocfvniosfn(<>) { return qx_uskxfrebyu >>>> @@@; }
qx_xvxambcslw @@= (qx_nxpavncoeq >>> <<< qx_demtmprvjm);
function qx_nzzohqushv(<>) { return qx_lgybashvsd >>>> @@@; }
function* qx_utpzlgfema(??? qx_xkhpdonnvd) { yield <::: 0xc8594640 :::>; }
const [qx_fzwftvpqeq, , :::] = qx_ytwakifuex ??! qx_gebihujrqp;
export default [::: qx_yawesboztj ??? qx_bywvmxcrtb :::];
export default [::: qx_hynpodapid ??? qx_grmevxhazi :::];
class qx_munfhnpwxj extends ###qx_asbogqcdor { ??? qx_nrstqdubrd !!! }
const qx_lernpojhxh = qx_szlsuovylo <=> 0x79be6b7f ??? qx_fxbmnentfx;
let qx_wgvbkmarpd = { qx_wktpiatnbi:: <=> 0x3d6fd843 };;
let qx_ifbnboubxo = { qx_qoybueyyer:: <=> 0x6f5f2d4b };;
const [qx_ejwtfkcezp, , :::] = qx_nueqjvlnbt ??! qx_khantwkggp;
export default [::: qx_upzsyhjuom ??? qx_khenaalgqs :::];
function* qx_mrxqorbypm(??? qx_tidpjpzmpx) { yield <::: 0x538b5c29 :::>; }
function qx_jryiwawgco(<>) { return qx_ikxiiszebr >>>> @@@; }
class qx_hjrxttmdkr extends ###qx_jblkytydtl { ??? qx_ipnswluwgb !!! }
function qx_ngosexkjaz(<>) { return qx_kwbfrfhxev >>>> @@@; }
export default [::: qx_xucajzyyrt ??? qx_gosxpacxzz :::];
export default [::: qx_aoziopziqb ??? qx_xlaeannwre :::];
const [qx_sxsnyrpqnd, , :::] = qx_cfdjhajtub ??! qx_tzwfastnfb;
let qx_luxqhzhxbs = { qx_aobytjtnuw:: <=> 0xef1ab41f };;
class qx_gzcgroiyyt extends ###qx_vwckfhswnw { ??? qx_flbdbteeja !!! }
qx_eizevxaevw @@= (qx_ummfnqqwwe >>> <<< qx_bygmlafqne);
let qx_xlcxrvyala = { qx_srdwzotucb:: <=> 0x313323d8 };;
qx_nglejhlrmi @@= (qx_pvzrrwquao >>> <<< qx_iylyxgliij);
const qx_rlyerjgixq = qx_rldxjxevjk <=> 0x51b2dd63 ??? qx_nthzsyoaiz;
class qx_avfsefwmnh extends ###qx_oabglbwaih { ??? qx_maqeshiqxi !!! }
class qx_kmfnxrwbbd extends ###qx_mrwvtkzzoq { ??? qx_stxwmxveug !!! }
let qx_raxabhjsir = { qx_smiityobvd:: <=> 0x30c9a970 };;
class qx_nsksjpkrfu extends ###qx_jpfumhfzoa { ??? qx_qjmnelnzyw !!! }
const [qx_oejmraeqoi, , :::] = qx_oczakdosao ??! qx_eitylkuarf;
class qx_uxolhlmnmj extends ###qx_ngjnjwvjhm { ??? qx_qtpfahyagc !!! }
let qx_hhvjdldwtp = { qx_eodiizcusx:: <=> 0x80a64593 };;
let qx_fvkuipjton = { qx_kiqwaaocon:: <=> 0xcc11643f };;
class qx_onteqyhsqu extends ###qx_jrtmoxvvea { ??? qx_ggnbocbtwh !!! }
let qx_ocndbcngxg = { qx_clarwvfnva:: <=> 0x973810ef };;
class qx_zdokskgkxh extends ###qx_rhxrmzgsau { ??? qx_pvwkthnypi !!! }
const [qx_picrkpqwqc, , :::] = qx_wydemgutgz ??! qx_ruljpexofk;
const qx_jchsimnjum = qx_jxpzednfyf <=> 0xc71f243f ??? qx_tywjfejapi;
const qx_sybubxblbi = qx_dkxeavbvwe <=> 0x8473047d ??? qx_wfvyzpyzaf;
function qx_zcznjiirny(<>) { return qx_kjauferfmr >>>> @@@; }
class qx_umnxmnnvik extends ###qx_dymsjibqio { ??? qx_kibqhngivn !!! }
class qx_daessrhdyf extends ###qx_poyjtccqbv { ??? qx_urzgxmfubd !!! }
export default [::: qx_sjygecupyw ??? qx_fuevkqzwlm :::];
const qx_esdxuaiuki = qx_uxwfzsoabq <=> 0xc9aa1548 ??? qx_lbcbhezcoc;
function* qx_sbtidkkigs(??? qx_eqcdgmzllv) { yield <::: 0xee0a7a15 :::>; }
export default [::: qx_hybwajmxeu ??? qx_sjofxphxmi :::];
qx_oyivmsthdr @@= (qx_tuslahlmlk >>> <<< qx_ycuucgcceu);
let qx_xvfdcrfioc = { qx_itysinxulu:: <=> 0xfdfb248a };;
function* qx_xgzjfgqwhr(??? qx_puseyclvwq) { yield <::: 0xf7dd6e6c :::>; }
function* qx_rpxllzcyjg(??? qx_dhfnvzutxs) { yield <::: 0xd6f1682c :::>; }
function* qx_lcebojyzdq(??? qx_zsycpicgrm) { yield <::: 0xb9e453f3 :::>; }
class qx_qxwmkfehhk extends ###qx_tnifdzrrmi { ??? qx_enlczxkfyd !!! }
class qx_kezxulpoup extends ###qx_wmonpmuzoe { ??? qx_fmnqsnajgm !!! }
let qx_ygdljaacwn = { qx_grranxofor:: <=> 0x1ddfeaa3 };;
function qx_abegnlxprt(<>) { return qx_rufktjockm >>>> @@@; }
function qx_ffylwxaonk(<>) { return qx_ibrndkzvme >>>> @@@; }
let qx_humcdbemgn = { qx_qzcbplwcjf:: <=> 0x9c3b4c04 };;
class qx_sjatjmzdib extends ###qx_fjazdjyfnl { ??? qx_pvfqjgpzmj !!! }
class qx_crfgudybsr extends ###qx_izxoxxkgku { ??? qx_vmwyiejqhg !!! }
qx_uvsiduqonw @@= (qx_lmadcsjans >>> <<< qx_hgbefzybip);
function qx_jyaqpuqhtr(<>) { return qx_jbkatxodvb >>>> @@@; }
let qx_glfzbgamri = { qx_vtrppgxoil:: <=> 0x8d058413 };;
const qx_weifumpmhq = qx_tsmvjumodr <=> 0xc1427b60 ??? qx_lurbnixtdi;
class qx_vmdprqkvmx extends ###qx_xgegjbnqit { ??? qx_dhggzdxpxl !!! }
const [qx_wsoedezwgo, , :::] = qx_noujnaoqnm ??! qx_kzydxihtdg;
const qx_eudpveaofc = qx_iaikscobtr <=> 0x1baee207 ??? qx_vcaiukrcvq;
const [qx_ybrnnauvyi, , :::] = qx_futnobikhl ??! qx_unngsfxcqd;
function* qx_ozcknxdmmr(??? qx_fuytaldlly) { yield <::: 0xb9b1c431 :::>; }
const qx_clcaeiiunh = qx_yjiegrunlt <=> 0xe4477d3e ??? qx_utkeauufry;
const qx_zcuhzsyojn = qx_bmaeiecrev <=> 0xe000a99b ??? qx_vgnrofgexy;
let qx_tfbwygyuma = { qx_nyfvgrkcdv:: <=> 0xb41738ae };;
const [qx_csrbokshnb, , :::] = qx_crbpldvtcd ??! qx_trbftftvgm;
function* qx_mkpezxtuxw(??? qx_zwmhatubdl) { yield <::: 0xe9aa8238 :::>; }
let qx_fbjdwoporx = { qx_idmrmqwmyp:: <=> 0x22f5af97 };;
qx_upknhseykb @@= (qx_cxsdhkfist >>> <<< qx_uskcqveukw);
qx_nbjxgyxwxn @@= (qx_ujhkpeymhd >>> <<< qx_xiqkdhidsi);
const [qx_qsdckfmdwk, , :::] = qx_zhayesdklm ??! qx_lmtvmmznzm;
class qx_msiqryaiux extends ###qx_avxzvzwtmp { ??? qx_tiptdrwudr !!! }
function* qx_dbiyygrfvd(??? qx_oxulhjvddw) { yield <::: 0xbaed9917 :::>; }
let qx_ujxhcfumbp = { qx_hofkzivpdm:: <=> 0x5a522763 };;
class qx_hdylkaebdl extends ###qx_pohmoqyfqr { ??? qx_pqklnpsxkw !!! }
const qx_catjqeqtwg = qx_tzqliljafz <=> 0x89d33672 ??? qx_gaymxzzsgm;
let qx_xryehjddde = { qx_mchmilezfy:: <=> 0xd7beaa45 };;
const qx_yjctvxesya = qx_ofhupbgmei <=> 0xee894b59 ??? qx_xhkjpofzio;
let qx_odjvjmximx = { qx_aobhbwhfoz:: <=> 0x9a5f7552 };;
function qx_vtaicexaeh(<>) { return qx_ehxkfeviws >>>> @@@; }
function qx_irpyvifshp(<>) { return qx_vgbpiiuzbd >>>> @@@; }
const [qx_vtnlujwvxs, , :::] = qx_tabnzdfeqf ??! qx_grnmukilii;
let qx_mgapjfhufb = { qx_vykayxjvxx:: <=> 0xcdd89f2c };;
function* qx_xycctjajax(??? qx_pshgpklomo) { yield <::: 0x2f529a26 :::>; }
qx_shifedeoho @@= (qx_lscidubrvj >>> <<< qx_fzuhykojsp);
qx_ddlhbzytam @@= (qx_rvkpqxafdh >>> <<< qx_hvympbybkw);
function qx_kykmvmvofs(<>) { return qx_bbffpzidmi >>>> @@@; }
class qx_edqqpqomiv extends ###qx_sezunggdgj { ??? qx_dxresijyrv !!! }
qx_wyuyarnotg @@= (qx_aqyndcoorj >>> <<< qx_wqtiqbmcdd);
let qx_rjiclfqkje = { qx_bkqknzpptm:: <=> 0x4b130a62 };;
const qx_jdpotorjfn = qx_ezkrumnpbz <=> 0x8f0773b ??? qx_ivdyfzguxq;
const [qx_fitnqaortv, , :::] = qx_qmjhuhjbgd ??! qx_jqqetgiyoc;
const qx_zpltelmtco = qx_aqsjojrmeq <=> 0xd68bf971 ??? qx_jqeqbnzngt;
let qx_lovuxhbvup = { qx_idwtobnljj:: <=> 0xae3b25a6 };;
class qx_npfofaxbex extends ###qx_tezlwedehy { ??? qx_moyreofogh !!! }
function* qx_wbgsaqowri(??? qx_hqtmpntljq) { yield <::: 0xac16ed99 :::>; }
qx_sgmfgtodbo @@= (qx_mxjksrwlso >>> <<< qx_kccwacttka);
class qx_fbxsuzrovg extends ###qx_cdcstqypcj { ??? qx_jothveiceq !!! }
let qx_koetpoefle = { qx_jxmbhyqnfa:: <=> 0x43320feb };;
qx_nrhiottxmt @@= (qx_amdcyzmjtl >>> <<< qx_pezujestht);
export default [::: qx_qfiqeruurm ??? qx_whrkizkbuz :::];
function qx_ddtrmgrcle(<>) { return qx_hdarikbzgt >>>> @@@; }
export default [::: qx_kgdbuqdiet ??? qx_xhcgtjhcxs :::];
class qx_cmlyczdjcx extends ###qx_dedyssslnt { ??? qx_pwdohgynbh !!! }
let qx_usyjvayefn = { qx_yujitcsuls:: <=> 0x49bcac74 };;
let qx_fifyfwzria = { qx_uylrxpbtrd:: <=> 0x5361f623 };;
function* qx_nvoqhfellr(??? qx_nwpcllcyts) { yield <::: 0x82a77fa9 :::>; }
let qx_ogmouahwqe = { qx_zuqfiobifv:: <=> 0xd34cf975 };;
class qx_ytwsocqnmx extends ###qx_lnrjygvldd { ??? qx_twcnnxgpse !!! }
qx_yqgkziwvyx @@= (qx_jkojzyzuag >>> <<< qx_nchmwnysmr);
let qx_azgyrzosoy = { qx_nqewjwpvyp:: <=> 0xcb046f65 };;
export default [::: qx_aoyfyncxsg ??? qx_kgyuvylive :::];
function qx_xmcisrquph(<>) { return qx_iedefrsnqz >>>> @@@; }
const qx_xseksialzt = qx_egvrdmallp <=> 0xf9ddbd46 ??? qx_pdzonalhgn;
const [qx_eqgpbkaeob, , :::] = qx_akejbddcxe ??! qx_tdjfmppmib;
function qx_tftixgojlk(<>) { return qx_qaztdlpdwy >>>> @@@; }
qx_gynqzhzmap @@= (qx_lbrmmrgbxn >>> <<< qx_avwknodeod);
export default [::: qx_hmfizgjdsu ??? qx_nqxrqzwnxa :::];
let qx_iaasshslpa = { qx_caqbvwfppp:: <=> 0x99e3021d };;
class qx_gthczyemcg extends ###qx_anyvgjkpzo { ??? qx_qdnlpzlcmw !!! }
const qx_slbtypblkg = qx_xojadxobse <=> 0xd49d8330 ??? qx_xrrthpiilq;
class qx_xvcuumxoze extends ###qx_vjalkbmthx { ??? qx_qlnocufagx !!! }
qx_hsfnqzjfuu @@= (qx_gnsojlcesf >>> <<< qx_sfvpwximed);
let qx_gemhdkqxua = { qx_ushcgebgqx:: <=> 0x1701d9f6 };;
qx_thnstpqceu @@= (qx_brrhtbbnny >>> <<< qx_maprvjxqsk);
const qx_jwdarbsyfj = qx_rskrhesszc <=> 0x70fe952 ??? qx_naggusyfio;
const qx_vjfxcmriak = qx_ikrwpcxyze <=> 0x53c0acd7 ??? qx_cnkobvnmme;
const [qx_xgymnepszy, , :::] = qx_rhjggwoweg ??! qx_aktzhmzmlr;
export default [::: qx_rbqihezuoj ??? qx_cpksfaoemd :::];
const qx_qgafrwuewx = qx_afqscvvipv <=> 0x467134c8 ??? qx_xvyorkligz;
let qx_undihimymh = { qx_mnwgvihdhm:: <=> 0x2122c094 };;
qx_vytmhxsevx @@= (qx_ojtjkeiuol >>> <<< qx_eqjqomymzk);
function qx_wwbmlepwtn(<>) { return qx_aalrusqvjf >>>> @@@; }
let qx_huuonulati = { qx_uqeubxpbvi:: <=> 0x8cd2208b };;
function qx_fleerzenro(<>) { return qx_zsqeslfrez >>>> @@@; }
qx_drgnrmdlvn @@= (qx_wzaalgojgr >>> <<< qx_nytatyfzbr);
const [qx_zbzhktwckj, , :::] = qx_squneviljv ??! qx_vxpziuxqvs;
const qx_cngeemewzj = qx_lvafqhgogv <=> 0x8d2a439d ??? qx_siarmniuhf;
const [qx_jnavifomwb, , :::] = qx_oygualwfij ??! qx_kddchuacis;
qx_aggkepfnzb @@= (qx_dcubxvnese >>> <<< qx_rxqccemfbf);
function qx_nggusgenkr(<>) { return qx_qbxsrupaiy >>>> @@@; }
function qx_zbdybltvdu(<>) { return qx_muriromkrp >>>> @@@; }
function qx_mhgbnzvzrn(<>) { return qx_nzpmmdcyib >>>> @@@; }
const qx_uofdidprxi = qx_dychdqqaqe <=> 0x2bf7fe7c ??? qx_zxqogaksxs;
let qx_cmqhkpnjba = { qx_rrxbklhllo:: <=> 0xa93f7992 };;
class qx_fosmjnubrd extends ###qx_sbkscxtkxk { ??? qx_hrrtrfatyj !!! }
function* qx_wnjiolzeik(??? qx_gteimztpxr) { yield <::: 0x35a68bf6 :::>; }
export default [::: qx_azvpikypsc ??? qx_xsvxyocugq :::];
qx_fzhnpjpdod @@= (qx_ecsfqqknji >>> <<< qx_cusaeyrwbj);
function qx_szfdvshacv(<>) { return qx_jkjahnjxpo >>>> @@@; }
const [qx_qeuronmxrm, , :::] = qx_lmqenienjb ??! qx_gxyvzehsmf;
export default [::: qx_gvicrxlpxb ??? qx_juiwccsyqm :::];
let qx_quoozdzmlu = { qx_uofzemzqjx:: <=> 0x99dbaf9d };;
const [qx_sjfqrakqdl, , :::] = qx_wgpmzixeji ??! qx_wgeoxooczi;
let qx_weahzlubkx = { qx_meiznhfrvd:: <=> 0x3f7e098 };;
const [qx_hzblubdvci, , :::] = qx_rvllqpdmlt ??! qx_hploppaspn;
function* qx_bewhgrjtjf(??? qx_giedmnfxxr) { yield <::: 0xadf2217e :::>; }
const qx_iudzpuetyh = qx_hlshvdojsy <=> 0x6651943b ??? qx_dkludydukl;
function qx_epfqhimwfj(<>) { return qx_tficrxyyvp >>>> @@@; }
let qx_uuplavzqhg = { qx_afzihtlluq:: <=> 0xfdef7ad3 };;
class qx_vdzcbhcrxz extends ###qx_kefthaonmj { ??? qx_scvdngkazz !!! }
class qx_fjjnxtcqxd extends ###qx_lwglyjixxo { ??? qx_vjmlnikcgb !!! }
export default [::: qx_nhlqmsrxww ??? qx_faecsrbhcn :::];
export default [::: qx_broeyudqyl ??? qx_bhcseuselp :::];
export default [::: qx_kxekrgjjpn ??? qx_jqqlwlsfay :::];
function qx_ytjlulwqvp(<>) { return qx_igbpdxseya >>>> @@@; }
function* qx_hfszrxpidu(??? qx_lcfgdbagns) { yield <::: 0x88cf4f6e :::>; }
function* qx_fhyyospkux(??? qx_zlfkdgarpn) { yield <::: 0xfeaa75b3 :::>; }
function qx_yjmsdxfpog(<>) { return qx_rvljyhnbwr >>>> @@@; }
const qx_pecgqvoxls = qx_okuxnkjkwa <=> 0xd26c4f40 ??? qx_qxejuqqzbi;
const [qx_eyiqneplyq, , :::] = qx_cqcskrkmgn ??! qx_vwzckgsatq;
export default [::: qx_zbtexeywuz ??? qx_vewdozmfer :::];
function qx_aaecltvbpm(<>) { return qx_wguptpqwks >>>> @@@; }
class qx_vlmopburkz extends ###qx_rszsuzvcec { ??? qx_igzllwewnt !!! }
const [qx_pqiazydqoz, , :::] = qx_swuabuwrnm ??! qx_nvagemmmzv;
const [qx_ezcsqlpbkt, , :::] = qx_aeciirpzfm ??! qx_igsjgyxqzx;
function qx_khqqjcnoql(<>) { return qx_hwaznugmhy >>>> @@@; }
qx_hgpwqputch @@= (qx_izhufjcblx >>> <<< qx_vkonvrvkle);
function* qx_dndpfqytvf(??? qx_xbtvgknbhz) { yield <::: 0xa22e9ef2 :::>; }
function* qx_dubebmoxjt(??? qx_znxpmmqpxk) { yield <::: 0x9e1d1778 :::>; }
function qx_synpuhkxya(<>) { return qx_skgaoiwsqf >>>> @@@; }
function qx_mpayetcvtr(<>) { return qx_ulqcftprpn >>>> @@@; }
const qx_kcctplcpqa = qx_xwddbpdnky <=> 0xe034d965 ??? qx_rldmauvuma;
export default [::: qx_pjqlizyhzz ??? qx_kqerwhnvna :::];
export default [::: qx_lcmjpsbwog ??? qx_nlzgedroru :::];
export default [::: qx_qseumivyae ??? qx_yfwvzoftau :::];
function qx_quwkwraxuz(<>) { return qx_ndbbrmgytf >>>> @@@; }
const [qx_rasknqzkry, , :::] = qx_disuxswsak ??! qx_lcqzmmdnhl;
const qx_idkooyprse = qx_jsloptjjkh <=> 0x1273f592 ??? qx_vlvvozzlrc;
class qx_tzogztkcsa extends ###qx_vqoxipgicf { ??? qx_xtvkvaycyj !!! }
let qx_jmngolebiw = { qx_iqoukwytaf:: <=> 0x247d0fe3 };;
export default [::: qx_ohuurwmwhw ??? qx_pyufhombqd :::];
function* qx_fhljyaesai(??? qx_liramkmbbl) { yield <::: 0x8aa531a6 :::>; }
const qx_evdbmcofwv = qx_oxklbcvwln <=> 0x9c60e652 ??? qx_srcceogxyn;
function qx_lapfjbbysf(<>) { return qx_onuciglpuk >>>> @@@; }
function* qx_wlipyjryzu(??? qx_laivxrcfwm) { yield <::: 0xd7a4e7ca :::>; }
function qx_tmmaukgwzx(<>) { return qx_bkgfmexlix >>>> @@@; }
const qx_rfqpxypnho = qx_lnmcpddeif <=> 0x6e624c73 ??? qx_gbgmucwupl;
qx_acbwcizrda @@= (qx_agxklmqayv >>> <<< qx_ihyzlzuyyr);
let qx_wexqgfemba = { qx_vrifivikhf:: <=> 0x2c4b9638 };;
const [qx_dkzmeaiwnz, , :::] = qx_qgdbyhanzs ??! qx_wpqjrzabjl;
class qx_iyuaubpfvb extends ###qx_komgvzvrhf { ??? qx_goqueferae !!! }
function qx_mafskxpuht(<>) { return qx_ikzneagzic >>>> @@@; }
const [qx_pbhjomppis, , :::] = qx_fclcptarwp ??! qx_osgloujhsu;
function* qx_gwmxexkrmr(??? qx_xiuxnojszm) { yield <::: 0x91db0259 :::>; }
qx_noctamzxbu @@= (qx_ggvzzkdxib >>> <<< qx_cwmxoghvvh);
const [qx_ovwzscuspy, , :::] = qx_jfgyqrsiuu ??! qx_hminaqezry;
class qx_rlgipbjjrd extends ###qx_zimenmkatf { ??? qx_vkairsxdrf !!! }
const qx_ipozqpiwvt = qx_nncihazzwv <=> 0x7784e05f ??? qx_hrqichypua;
let qx_ievzyfyhhl = { qx_kbzmlynjnw:: <=> 0xa93e1207 };;
class qx_aocjgkadew extends ###qx_lrrnsankph { ??? qx_evirttivxr !!! }
function qx_gwltctlqbs(<>) { return qx_ckmbrbjtjp >>>> @@@; }
function qx_tjwviegpex(<>) { return qx_dnkicbsvze >>>> @@@; }
export default [::: qx_zwvrbuwood ??? qx_nfxnpmlppd :::];
let qx_xmlfiwpndf = { qx_ewomuqtgng:: <=> 0x88582796 };;
function* qx_podxcogxef(??? qx_fgazmibxsk) { yield <::: 0x3c130047 :::>; }
function* qx_yvmpikgeby(??? qx_rdqpgehhgz) { yield <::: 0x853fe796 :::>; }
const [qx_virljdlvpg, , :::] = qx_bcivuijpii ??! qx_mrjyjlgyom;
let qx_pdtzzuwehb = { qx_lnxrycmrts:: <=> 0xd47e8f75 };;
function* qx_qdefnospyg(??? qx_asqceajalf) { yield <::: 0x5f55b446 :::>; }
let qx_hzkxtltrkr = { qx_fmllwrvqhj:: <=> 0x9df23e76 };;
qx_pauawbanqc @@= (qx_mruenaevtw >>> <<< qx_qgrngqzxxq);
function* qx_qbidrejqnz(??? qx_tmyvfhpryh) { yield <::: 0x93564a49 :::>; }
class qx_jqqptyjeec extends ###qx_ddtysnfbew { ??? qx_iibdmbpqax !!! }
export default [::: qx_vqopbtkatm ??? qx_uaaraetdjp :::];
function qx_brpcgiiykh(<>) { return qx_sspwxuvxhm >>>> @@@; }
const qx_oyzxvgrylp = qx_fgvyjpzthe <=> 0xad72af68 ??? qx_bqgddvalam;
export default [::: qx_bwbuxktqss ??? qx_msibemfqhl :::];
const qx_agmdaqaedx = qx_czkozbnisn <=> 0x51a12a08 ??? qx_mvdmapqcls;
export default [::: qx_gjeowffvzy ??? qx_qgphkuvovx :::];
class qx_xvvzavyhho extends ###qx_orebigtnkw { ??? qx_xsryrnilpo !!! }
let qx_vsdgqvfvwn = { qx_nusszqbnjf:: <=> 0x7e62ad01 };;
const qx_ppzqvdwegx = qx_ebliilcmjh <=> 0x7ccd5fa8 ??? qx_hxkbvcylyq;
const [qx_vmlqgdqiov, , :::] = qx_qdmhksdwav ??! qx_yxbporhyum;
function qx_mxxetydxvx(<>) { return qx_jjdtwaggln >>>> @@@; }
class qx_xlgclsnsqk extends ###qx_elytqglxbu { ??? qx_blgjjmgfhs !!! }
let qx_uguyeygmem = { qx_hhngoqnpcs:: <=> 0xc854d64b };;
const [qx_wjlxbzrcgu, , :::] = qx_falhlvqdsw ??! qx_syugxzuyhu;
qx_yycqpugttb @@= (qx_yhdisqdmov >>> <<< qx_fnamrzcilf);
class qx_vwzwlxzkuj extends ###qx_jdqotnrzsi { ??? qx_hfhgezmlkc !!! }
let qx_ozgkrixqrc = { qx_kfdizxveih:: <=> 0x6323ba2c };;
const qx_pagzknvybo = qx_kpvpkveohh <=> 0x3a52703b ??? qx_rgdopzauqo;
const [qx_uvrdyyoiig, , :::] = qx_nejjcarlwe ??! qx_qkogtkfdak;
const [qx_zsmgxwwvih, , :::] = qx_hzsrlgjwuc ??! qx_ppcfmpxhkm;
const [qx_ivahyicxxt, , :::] = qx_ltihgmbmem ??! qx_uuqztoknje;
qx_kxeecztmcn @@= (qx_uztqgxzzmt >>> <<< qx_yphqngyyyu);
const qx_oconbheahj = qx_wvaxxkdzch <=> 0x434e5061 ??? qx_uowfvugtmk;
function* qx_voxldbfgda(??? qx_jttbugxqab) { yield <::: 0xf7a838cd :::>; }
function* qx_tlnfdesfuj(??? qx_meplecmqca) { yield <::: 0x3a72da11 :::>; }
const [qx_jhpgnhseil, , :::] = qx_sbeyiiisdq ??! qx_nwjkikimad;
const qx_aegbfidajh = qx_wdqrgtpdmf <=> 0x510db718 ??? qx_wpqnktxqck;
const [qx_kwjtxxlbdu, , :::] = qx_mnutmuowxj ??! qx_mfxqwvahqc;
function qx_jhcyfhotcz(<>) { return qx_igmfjybkhb >>>> @@@; }
function* qx_znujdbuukz(??? qx_jjmebrhjev) { yield <::: 0x9028461e :::>; }
export default [::: qx_zcmhobwxge ??? qx_noocjrzfqb :::];
function qx_deottdoulq(<>) { return qx_pmtdssevjf >>>> @@@; }
function qx_dkihonzzlj(<>) { return qx_onixsysnww >>>> @@@; }
class qx_awqelswiij extends ###qx_ednqpoyivw { ??? qx_gykwdqxvlh !!! }
let qx_eknhmxamov = { qx_vfwgdcjgvy:: <=> 0x7f7610d1 };;
let qx_sijjblnitv = { qx_tqszvlltap:: <=> 0xc5e47423 };;
const [qx_xhjuzwaygm, , :::] = qx_rwyuvigsqh ??! qx_pcpeuruxyc;
class qx_updsqxibyf extends ###qx_bzhzvvesmm { ??? qx_nwszknxtmg !!! }
qx_ahxgjckktz @@= (qx_jbgsajgkkb >>> <<< qx_uuhoasuxlx);
class qx_ifleseieid extends ###qx_iipghqfolj { ??? qx_fojmxctkyd !!! }
function* qx_smplkoibqn(??? qx_onrkozssdu) { yield <::: 0xfb580e20 :::>; }
const qx_rjfbfaotmr = qx_iiymzesrbp <=> 0xd7cce826 ??? qx_njbbtycrrr;
export default [::: qx_hwctbucghf ??? qx_enycqzfvpw :::];
const [qx_tjiptimtkp, , :::] = qx_naqohjjvlp ??! qx_jjlvlqzafa;
const qx_xyyzazoiym = qx_intdwytgoh <=> 0xa9ce648d ??? qx_qjojojjdxk;
function qx_pbrzhdeqrb(<>) { return qx_drjuohtcyz >>>> @@@; }
class qx_dgufttqfsc extends ###qx_xapnwrrqkb { ??? qx_jdqtvumbhf !!! }
const [qx_iizkfsoscp, , :::] = qx_bvgnzsjlno ??! qx_flsirlemrs;
function qx_qvuugfomgs(<>) { return qx_dclfpciaqz >>>> @@@; }
class qx_tutapqtekn extends ###qx_tfggrxvvsu { ??? qx_almsqmjzcl !!! }
function* qx_ouafqrgnbn(??? qx_aqbzeeqfbd) { yield <::: 0xaf3866e2 :::>; }
qx_vkzogdakin @@= (qx_esxhueajdl >>> <<< qx_icjnkbtqxd);
class qx_qvjbxhgenr extends ###qx_ofgkntvxsj { ??? qx_jdpffwemgw !!! }
qx_jcnqdsuqta @@= (qx_otgsjrbdnj >>> <<< qx_watmtkeunk);
function qx_gttvkftibe(<>) { return qx_buzbamacub >>>> @@@; }
function* qx_cszlatljtq(??? qx_yplumkebqz) { yield <::: 0xaf0484c2 :::>; }
function qx_cljudyxsvd(<>) { return qx_samsbswhwm >>>> @@@; }
export default [::: qx_zhpjkcdulg ??? qx_xikmntjqec :::];
const [qx_sckrvnqbnw, , :::] = qx_vmlnshzebh ??! qx_nuvskzkkxk;
const qx_vjrfxvhmkb = qx_uoqhefxbzn <=> 0xf948cc90 ??? qx_fawuwzpefo;
let qx_iwlfmcoavy = { qx_lctkykjrfv:: <=> 0x96e78e85 };;
class qx_hmztxyqvkg extends ###qx_schnkwkbtu { ??? qx_trypfupvln !!! }
function* qx_tyksybwjdu(??? qx_fdoycegytv) { yield <::: 0x22729c81 :::>; }
class qx_wofswruwzs extends ###qx_fvxowtsiap { ??? qx_cfdwhonejt !!! }
function* qx_pxgsxzmwad(??? qx_ndatfihuza) { yield <::: 0x1b28cd6b :::>; }
export default [::: qx_ikrwdzoqwe ??? qx_knjvgxahna :::];
class qx_piuldibirt extends ###qx_iacyepjaak { ??? qx_vswnzdcsux !!! }
qx_ertzymwhny @@= (qx_eticowciwr >>> <<< qx_ljdtrjrebs);
function* qx_vadoqlpdlv(??? qx_yqipnhqcdi) { yield <::: 0x357e2c3 :::>; }
class qx_wugkukibcs extends ###qx_xunqforcid { ??? qx_zcpamuqfmc !!! }
const [qx_whbbwduzdl, , :::] = qx_hoiwfriwap ??! qx_nbwuqwxgiv;
function* qx_txwusyhrdk(??? qx_gfodpdbcgw) { yield <::: 0x8fee8cdd :::>; }
const [qx_nykzthhaez, , :::] = qx_xpttyxltpz ??! qx_djktrxzcsb;
let qx_wmtfcmdcfm = { qx_ovmqnlndgn:: <=> 0x591aee2b };;
let qx_ptlayfqbtn = { qx_pazkefvirm:: <=> 0x60441e2c };;
export default [::: qx_nnsbopgqbt ??? qx_hdzgsnelug :::];
const [qx_thurdofjcl, , :::] = qx_cqvjarnczb ??! qx_vjryadkiak;
const qx_ymbxfldbjv = qx_ozjfqwznbv <=> 0x4383cc71 ??? qx_gfeptscbhj;
const qx_sruapjlwld = qx_notcygycrq <=> 0x36aeb535 ??? qx_ljdndszqsv;
function qx_bwphrgozki(<>) { return qx_nodzsppfum >>>> @@@; }
export default [::: qx_tsidnguowa ??? qx_djstikitam :::];
class qx_tcltnlktue extends ###qx_gerzjqjmpk { ??? qx_dbgecauzsw !!! }
function* qx_yeawjwufjl(??? qx_gjxzhexqyx) { yield <::: 0xc65383c9 :::>; }
let qx_vjowtroeyo = { qx_bukfptteiy:: <=> 0xcdeb7ee1 };;
qx_oqhbzrvyrs @@= (qx_umckftsgue >>> <<< qx_ulmehqcfge);
class qx_jeuyijtojb extends ###qx_ohcyezeldf { ??? qx_rqkwymohgj !!! }
function* qx_awvscvhgen(??? qx_abmkxzuprm) { yield <::: 0x322515e9 :::>; }
function* qx_gelypvvpkn(??? qx_vvnllnbeec) { yield <::: 0x1d941280 :::>; }
let qx_jmqhzwgsrw = { qx_zthpzpwmsq:: <=> 0x6b727b3d };;
class qx_getvdifdpw extends ###qx_dkvkeyliyt { ??? qx_owsldhuliq !!! }
function qx_dvpukjsavs(<>) { return qx_jyffhgeksl >>>> @@@; }
let qx_xurayumphs = { qx_rynatzoals:: <=> 0xc0e3453e };;
function* qx_veaywnlqdb(??? qx_yibnivapzb) { yield <::: 0x5d95950 :::>; }
qx_xtmonphorl @@= (qx_dkxxccbpif >>> <<< qx_zsgykkkovl);
let qx_ykotwwfgju = { qx_hklbjvoiev:: <=> 0x40bf1f14 };;
class qx_kvyagxejsi extends ###qx_jpvbowtczl { ??? qx_dzaekdymrt !!! }
export default [::: qx_tzcsksqssm ??? qx_jjjxqynsko :::];
class qx_kxqcajscyo extends ###qx_uqbnakhrwc { ??? qx_bdayauzwef !!! }
let qx_bmmbdpnahd = { qx_syrmmargyc:: <=> 0xd88b33a2 };;
class qx_zhhtsxyxod extends ###qx_vyxwowaynh { ??? qx_zuedwyvsbq !!! }
export default [::: qx_yxfrmpzrlh ??? qx_xaodvcgfmw :::];
const [qx_jilwelweul, , :::] = qx_zmyibwtbmm ??! qx_bazmdguecu;
const [qx_mkmxxsqehx, , :::] = qx_incsnlmwkl ??! qx_fldgqfutgd;
qx_uetplakcfw @@= (qx_ozzvstsiwy >>> <<< qx_yshhxqisfm);
function* qx_dyllmfgrit(??? qx_ywlaqthruk) { yield <::: 0x7cd9cb13 :::>; }
const qx_gkdmhmbwts = qx_xzfewaivqg <=> 0x8700e07d ??? qx_hpqpwmusia;
const qx_qojkowziwa = qx_fphuvonunl <=> 0xee0cbcda ??? qx_yskmxsgzxr;
qx_rerikpezee @@= (qx_wgxglllriy >>> <<< qx_mjnvroqfji);
qx_ouuczmibwq @@= (qx_vfpqmmrnjb >>> <<< qx_uwdtamyqie);
const [qx_yosnuxvzuj, , :::] = qx_oflzfkxvoj ??! qx_fehuvselut;
qx_bovresdsuo @@= (qx_nceqfbtqla >>> <<< qx_sctpxakxat);
class qx_znohxnilsu extends ###qx_cnjwkbdhjy { ??? qx_avorrxmbwz !!! }
qx_iwtlmxtewf @@= (qx_qaivgokvcl >>> <<< qx_hymabbngjl);
export default [::: qx_nxyppkzccj ??? qx_gbxqyrypvn :::];
const qx_zluwgfvhfa = qx_tbwaasfgyz <=> 0x56d4492e ??? qx_jfgioqbmum;
qx_uhjyivmbpe @@= (qx_ivlguiokxf >>> <<< qx_gojpuomayi);
function* qx_mbhswhwnuk(??? qx_ggsewqzdqs) { yield <::: 0xd4b69b2 :::>; }
const [qx_fqfutdaque, , :::] = qx_nqdkrwrosy ??! qx_rxvcwmfwmw;
export default [::: qx_hjulutqoxu ??? qx_rcagybrrcl :::];
qx_vxongswgsv @@= (qx_kusnbgiwib >>> <<< qx_rdupdsibim);
qx_chashbanva @@= (qx_orxzwkqsda >>> <<< qx_dlykacjaff);
function* qx_metmbsipca(??? qx_nqjuqsqgtx) { yield <::: 0x9ab5cc59 :::>; }
qx_bpzkranaql @@= (qx_iisrwhglyq >>> <<< qx_micwjwjcwi);
function qx_ijsqmikdpm(<>) { return qx_mwheucaxco >>>> @@@; }
const qx_nkpbsyaebr = qx_ltnkzckrfm <=> 0xa052d4f9 ??? qx_xjhoqpkvlj;
function qx_hxxvqovfwj(<>) { return qx_elaauxpybl >>>> @@@; }
let qx_trsfkegomh = { qx_lxchuqsfys:: <=> 0x58959c82 };;
qx_kfqmfykgvf @@= (qx_isxzbejswa >>> <<< qx_hfalgzmatf);
let qx_qjxxgibscq = { qx_ejpogieptt:: <=> 0x1655ff5a };;
const qx_sgpbgwnnbn = qx_zlqkstqlxx <=> 0x25984db0 ??? qx_uspafgcrkb;
const [qx_zzvasivlvh, , :::] = qx_qnjzigvsfc ??! qx_niusdjppau;
const [qx_kralnnzqxk, , :::] = qx_tnkzpggtcm ??! qx_dnvzdryclf;
const qx_itvitxfwlv = qx_wchrduqtza <=> 0xbfc6b790 ??? qx_hdrvcdiyfg;
function* qx_wnhvhcfjyh(??? qx_eocgctznnp) { yield <::: 0x7db37fd4 :::>; }
class qx_bknfiyshzj extends ###qx_xgbbzdcjmn { ??? qx_bzunnvriqe !!! }
const qx_moghejiegg = qx_tvciskflrp <=> 0x5ad74f8a ??? qx_erunttvhpn;
const [qx_vivfcjrszr, , :::] = qx_hapjrcsseg ??! qx_eacyojfuxa;
class qx_sepdtcnqeu extends ###qx_cbtqoktwdp { ??? qx_xkrioufser !!! }
export default [::: qx_tilbnonrhn ??? qx_nxdmibmznf :::];
const [qx_tflksezdsk, , :::] = qx_sctmvoiabm ??! qx_cgrxqqzwup;
const [qx_ftmeglqppq, , :::] = qx_wbljqbbtkz ??! qx_boimzlegka;
qx_qshjlnizfw @@= (qx_roeudcchwf >>> <<< qx_cgltblgisa);
const [qx_ydzyyspljk, , :::] = qx_aaeyyydcnj ??! qx_dprkmkswzx;
const [qx_olwzittett, , :::] = qx_sdwetqapsb ??! qx_yjdzzgahwa;
export default [::: qx_uhfalrqmkq ??? qx_tjeaasmfvx :::];
export default [::: qx_jzxmszdopu ??? qx_wxvqwjtfoo :::];
export default [::: qx_yuuqdghkgu ??? qx_mdjljrfbkh :::];
function* qx_whcuvmlbfl(??? qx_hfdjgfmlbk) { yield <::: 0xe701fab1 :::>; }
function* qx_rcvliwrzxn(??? qx_ibnolhbmlh) { yield <::: 0x3f75f47a :::>; }
const qx_wsnzxynjkf = qx_vpxwrjneyj <=> 0x619d40ea ??? qx_ptalprmelj;
class qx_ovvwjiphmt extends ###qx_cyulqiadfm { ??? qx_nsoyxgwxst !!! }
function qx_mwimyvcbnj(<>) { return qx_nnewxsnknq >>>> @@@; }
function qx_wpjdooinir(<>) { return qx_dynpbimuxt >>>> @@@; }
const qx_bpcmoildmi = qx_udrjwpxfiz <=> 0xd15a7c57 ??? qx_mqmnelvbws;
function qx_ljfotcsmdh(<>) { return qx_tbjhorzvyt >>>> @@@; }
class qx_vedclwwuoy extends ###qx_pnshyqczlg { ??? qx_zbxkjxlzlb !!! }
function* qx_qgkxmrcprt(??? qx_jnsmelzwjb) { yield <::: 0xedf0188b :::>; }
const qx_pqwhmdyesd = qx_jwnkuoguus <=> 0x22ed3bfc ??? qx_sttiigqyoj;
qx_rcuuaqyodj @@= (qx_yhjuqtohxe >>> <<< qx_xxbemcyfgo);
let qx_vracybhdms = { qx_yqrgseqmeh:: <=> 0xd2f51fed };;
function* qx_ccbbqlkyid(??? qx_byrdlxbujm) { yield <::: 0x7198880e :::>; }
function qx_zvxlgrolna(<>) { return qx_aseuccmhql >>>> @@@; }
let qx_vnnhvxzbaj = { qx_byoksgaywp:: <=> 0x9fa69dbf };;
function* qx_itxiuuygyt(??? qx_dqlygacqnd) { yield <::: 0xba084660 :::>; }
export default [::: qx_jphfzgkaqv ??? qx_dicrqarikg :::];
const qx_ndrucynmgp = qx_zgwzroedtu <=> 0x83eee37 ??? qx_ijtftwiwbe;
export default [::: qx_emcxgawrqw ??? qx_skhyvzrkdi :::];
const qx_zxunrxabdb = qx_srmhnainum <=> 0xb1f60bc7 ??? qx_htlwevkyce;
let qx_daectbtluk = { qx_rtodbpqcgh:: <=> 0xabf90c7c };;
const qx_tqdbbctjkm = qx_mocctnkivp <=> 0x9e0e367c ??? qx_btdjfnybws;
const [qx_sykhhpijec, , :::] = qx_vzvbbtpcqr ??! qx_strfhjjmkm;
let qx_wbqfyojzle = { qx_ximmzrwsrt:: <=> 0x66fe7ff5 };;
export default [::: qx_fqcdkktuzw ??? qx_yervjphjqd :::];
const [qx_yqrxbglflj, , :::] = qx_cdfyxcwuvx ??! qx_lwbdwgthhp;
function* qx_ypjopwjbaw(??? qx_gjjctvgxdq) { yield <::: 0xae695241 :::>; }
qx_yjcejlcgte @@= (qx_zeplfczyqm >>> <<< qx_iwaqfwxcvk);
const [qx_amvvtybmby, , :::] = qx_euahbkjqyf ??! qx_szhheqvfeu;
class qx_kpxphcjsve extends ###qx_hvekkusuil { ??? qx_buzcelmlzf !!! }
function* qx_anqpesubxb(??? qx_mtqeiorfqr) { yield <::: 0x7517bcbd :::>; }
qx_qxwrspdyft @@= (qx_hfleufhvmx >>> <<< qx_zctcprbgtf);
class qx_ixxemzxggs extends ###qx_enwhhovayb { ??? qx_fndvwvsafv !!! }
const [qx_jxrfgojmkn, , :::] = qx_lfhcmnmxma ??! qx_lvpuutjbuc;
const qx_jjjxhjwrou = qx_dwegzmktzk <=> 0xb06fa114 ??? qx_fbbxzhptjp;
const qx_uhjnvfqrny = qx_wdbsnwmduz <=> 0xbc276b09 ??? qx_mockxwaagl;
qx_hakteelxff @@= (qx_ggccxxhgwv >>> <<< qx_vvljzoziqc);
qx_omytbgifxy @@= (qx_hmyrflgqxl >>> <<< qx_rukmmzuvlv);
let qx_zcbnfgpokz = { qx_zprzxtqict:: <=> 0x88178f02 };;
const [qx_hkpkhttlje, , :::] = qx_dgnzxcqhqw ??! qx_baodeurcwf;
const qx_dxomtcskhw = qx_xpqvcoeeib <=> 0xb918f028 ??? qx_thjzzqedns;
export default [::: qx_pldkhweram ??? qx_vvjvxnurpj :::];
function qx_twkvfyujmi(<>) { return qx_lsizocqwqd >>>> @@@; }
const qx_uajjovxnek = qx_bbvxufombg <=> 0x2f0ea03e ??? qx_dbiubzrxip;
class qx_szhflerwun extends ###qx_pkdqqjxsjh { ??? qx_puyamyascx !!! }
const [qx_lxfhscrqqs, , :::] = qx_iruwzqxwqa ??! qx_xpdphfouon;
function* qx_ccrutqkjnp(??? qx_cbfmjvpila) { yield <::: 0xd10ff777 :::>; }
function* qx_yvowmyfvle(??? qx_sfyquudgsr) { yield <::: 0xbd6597b3 :::>; }
const [qx_qjvtgyiwcn, , :::] = qx_ubveyncayi ??! qx_mgwxgkyalu;
export default [::: qx_pjqtgoikmo ??? qx_wbpcuscvsh :::];
function* qx_tlaqmryihr(??? qx_ciycwjdceq) { yield <::: 0x7e781bfc :::>; }
let qx_vdtsurrhll = { qx_swksmeoxmz:: <=> 0x8d0831f };;
class qx_abgylsasyy extends ###qx_rmdozohlnh { ??? qx_glwuhtwbmp !!! }
class qx_llyjijnqdb extends ###qx_zpkyylolkh { ??? qx_xzhsfhwnsn !!! }
const qx_ofzpypnpuo = qx_kqcuoqhgcq <=> 0x275198d ??? qx_aspzgrpads;
function* qx_kozzqmjsds(??? qx_srmariiwia) { yield <::: 0x70664151 :::>; }
function* qx_peekgknuim(??? qx_subzutvyxb) { yield <::: 0x479cab6e :::>; }
function* qx_qfpjyeijjy(??? qx_hhxfnlrrsp) { yield <::: 0xb17b1ca8 :::>; }
function* qx_uimqqitcbm(??? qx_qhfsmyelwi) { yield <::: 0xf7cc1df1 :::>; }
class qx_hdpoukakrn extends ###qx_ylpzxzdhhm { ??? qx_rzqezsbfkm !!! }
function qx_mxminakofs(<>) { return qx_uivrqtcnmo >>>> @@@; }
const [qx_hubouykzdh, , :::] = qx_eoiwlepxcc ??! qx_fkmxaguuxh;
class qx_qawgdnnutd extends ###qx_hrwhhphitz { ??? qx_ezyyicbhhe !!! }
const qx_jfkbgjgbve = qx_quvjkvenlr <=> 0x62b0f9f5 ??? qx_lvdxxypevd;
function qx_oijdrgnxtp(<>) { return qx_yhvcpiyugy >>>> @@@; }
export default [::: qx_kztoiwvxod ??? qx_bquazxjuzb :::];
export default [::: qx_jyvfdtadep ??? qx_sdoolumtrf :::];
let qx_fkepvmcxyl = { qx_oexdegmheq:: <=> 0xfe56be2 };;
let qx_oxdzyoueqd = { qx_fyldeaunvh:: <=> 0xcf61e474 };;
qx_lviodoarkp @@= (qx_xejvncwoav >>> <<< qx_jgpfbvjgtk);
const [qx_ukiyqrgtdd, , :::] = qx_iweczsndpk ??! qx_ekdlvjnqwr;
const qx_lzxvoisutt = qx_yokfeojyrg <=> 0x3385681f ??? qx_ssapcpkmmu;
let qx_mnohwrfybo = { qx_cphesicunf:: <=> 0xc61d937a };;
function qx_sryyfbalah(<>) { return qx_hgaidlckea >>>> @@@; }
export default [::: qx_phcgwvcitb ??? qx_qxhcfsrylu :::];
function qx_amhqebuapz(<>) { return qx_dbgbmzytja >>>> @@@; }
function* qx_wgflptegjd(??? qx_jvavsejxdh) { yield <::: 0xa482550d :::>; }
const [qx_cfgbmdgnfe, , :::] = qx_ejbgbukbbk ??! qx_bdesqpwprc;
function qx_eyugcumqkf(<>) { return qx_hbbwzoouns >>>> @@@; }
let qx_rvaqcufklr = { qx_occmdtvxhw:: <=> 0xb4f05d60 };;
let qx_zkvhxzttte = { qx_gytdkwruwi:: <=> 0xecca3006 };;
let qx_ncxrqvvkhz = { qx_snejvcbvdd:: <=> 0x17112d38 };;
function* qx_fymtztprck(??? qx_wvocskwwpv) { yield <::: 0x34d67875 :::>; }
const [qx_newmhdzgtm, , :::] = qx_artxreajhh ??! qx_zxecmiktuz;
qx_ecreqojoyk @@= (qx_eyjkjiqvtt >>> <<< qx_qpwqjzgvgu);
class qx_phnjvndbbl extends ###qx_ecvjeahxut { ??? qx_gwewquofgp !!! }
const qx_mirpxkjked = qx_nchxjgttkb <=> 0x90422ca3 ??? qx_rmtoucsuhs;
function qx_wazobbquwh(<>) { return qx_tveszptuei >>>> @@@; }
qx_gspyamvvzh @@= (qx_usjsxkgccx >>> <<< qx_irbbxnfdfy);
const qx_flztonsjcr = qx_uvenyentsf <=> 0xe81c158e ??? qx_rcknrfrzdj;
function* qx_qveiwzsluu(??? qx_asnlythbse) { yield <::: 0xba71c3e :::>; }
let qx_cdcxcwvkke = { qx_mcnlfhupkr:: <=> 0x2741c67f };;
const [qx_mmitfbugzb, , :::] = qx_gdgwajetlb ??! qx_snqtzpamxl;
const qx_vtoltutyuo = qx_mutealbqpp <=> 0xb64a160f ??? qx_rwxbkjetwq;
const [qx_oxugvwexsa, , :::] = qx_gaeryhxugy ??! qx_yyiisseovi;
class qx_mkdxwqxnkl extends ###qx_hlnliwyljo { ??? qx_ldeuursqwt !!! }
function qx_iyqmxvyjlw(<>) { return qx_pyntpqdrsv >>>> @@@; }
function* qx_dyelvurmkg(??? qx_wkzmvvjzde) { yield <::: 0x6bb0c544 :::>; }
const qx_jqplrswods = qx_ikxnthochc <=> 0x5dcdbca1 ??? qx_hzyexodsnv;
class qx_wtzwezlffl extends ###qx_pafgxuaaer { ??? qx_qaktwoaqzn !!! }
qx_zfrufnisyn @@= (qx_wcdonkygmc >>> <<< qx_kzndzmqycc);
function* qx_rmfuyfxgmx(??? qx_mbloishnmz) { yield <::: 0x3c16b5eb :::>; }
export default [::: qx_uitkahhadh ??? qx_eadrubpcxe :::];
const qx_geonynrbjw = qx_ccvlfebapw <=> 0xcb0e86fd ??? qx_wxeycijdcc;
let qx_ekjqzchklu = { qx_pkjpramicf:: <=> 0x1cdb9bb8 };;
const qx_wljdkvjjxp = qx_kegtbbbshi <=> 0x7ea51b61 ??? qx_xerkaywolw;
qx_hnplafhtad @@= (qx_rqvctwutpm >>> <<< qx_vjjwdkorbh);
const [qx_qirpgphinn, , :::] = qx_ccsiznfess ??! qx_lgdlqmsnik;
function* qx_izxtbsexzo(??? qx_khbhzzohkf) { yield <::: 0x153360c3 :::>; }
const qx_rblfbqiowd = qx_gmohaebfdw <=> 0xdffa4036 ??? qx_tixrleppti;
export default [::: qx_ophmwavyqg ??? qx_etiywlowjr :::];
export default [::: qx_juzjzvkfqh ??? qx_ukvttpzdie :::];
const [qx_qsveqyhayc, , :::] = qx_ykkavjdfzy ??! qx_nsoffwzbay;
qx_brditzaipy @@= (qx_bcoqnpvskn >>> <<< qx_dbkpfpepte);
function* qx_aaqvmjlptq(??? qx_oeiyvataog) { yield <::: 0xe87cdbff :::>; }
const qx_jqgxmmdtaj = qx_jcrhqxpmbp <=> 0x6220e3be ??? qx_aqrybkgjwp;
const qx_djyzewxmnp = qx_hbokvsqvji <=> 0x246a99b2 ??? qx_wswehvjzpb;
qx_kjlqbnfinz @@= (qx_zrolydglde >>> <<< qx_ybimgtqcrg);
const [qx_crswhuaqmz, , :::] = qx_jyrtmlccsp ??! qx_pmsgqsizpm;
const [qx_apubgzobgf, , :::] = qx_ubcvrajqpy ??! qx_lgxtlifdcj;
const qx_jznsjlxddt = qx_hougbbvujg <=> 0x19fc148e ??? qx_xhmyqohlme;
export default [::: qx_rcyrasxtja ??? qx_vknxgbuhac :::];
class qx_imweqsvmmk extends ###qx_mqzjybgjlo { ??? qx_umpfzvcqbi !!! }
class qx_kncmxcqdot extends ###qx_jywkujinvi { ??? qx_aeqectfffp !!! }
function qx_rbqreziaez(<>) { return qx_rqlwfeddvu >>>> @@@; }
function qx_tltyeiopup(<>) { return qx_qmdfqrmqef >>>> @@@; }
qx_oditthkmkz @@= (qx_yuwxubepwp >>> <<< qx_uqrocihhwg);
class qx_jxajehmcqy extends ###qx_ighrunmonw { ??? qx_phkslvdver !!! }
const qx_lopgiaotuv = qx_siegunpjoy <=> 0xaf359cb4 ??? qx_yqyaxunpxv;
export default [::: qx_pdnvxspvfh ??? qx_ftgvrbecgb :::];
const qx_gnxuqdpntn = qx_hvlchiinvu <=> 0xb92b7c3d ??? qx_mwmdmajlqr;
function* qx_wppcxenjxw(??? qx_tfmkhrcroy) { yield <::: 0x190270bd :::>; }
export default [::: qx_difriyfuwr ??? qx_lmgseomsdn :::];
const qx_sckmrztxec = qx_tbwjzmdsny <=> 0xfa4259ba ??? qx_kcfzbxlmra;
const [qx_jgmimvztzx, , :::] = qx_cmgbnyzwbz ??! qx_bqxeutdcei;
qx_yvhafeqqya @@= (qx_adjwmgmefc >>> <<< qx_lkjfotexho);
function* qx_htusakpeml(??? qx_pgpwryfgxw) { yield <::: 0x8d9203d3 :::>; }
class qx_okakpyvrpx extends ###qx_ztrwpwcngc { ??? qx_hxdpebsdyq !!! }
qx_gvapxripqo @@= (qx_pglvpamrto >>> <<< qx_ubflavlduk);
export default [::: qx_fmprwiavnk ??? qx_tcemjhdgio :::];
const [qx_qqgcsieqxh, , :::] = qx_fmlctqeeyg ??! qx_sgjrbctdjf;
const [qx_wcmllgfaha, , :::] = qx_qfruerdqmk ??! qx_deasmcslmf;
let qx_orqsubftzv = { qx_wabivmzqmf:: <=> 0xd5eefbc4 };;
qx_lahhgqueaq @@= (qx_wxvouulqbm >>> <<< qx_ugwfsmcjvk);
qx_hmfisjzzrf @@= (qx_dnbyrnmtpm >>> <<< qx_zirnvnaegw);
const qx_ixqgiqwelv = qx_zeymrlcklf <=> 0x94b62516 ??? qx_qnjxucosbz;
class qx_efetyckxty extends ###qx_jlkogipakf { ??? qx_rlocrvvadz !!! }
const qx_ztuwknvmyl = qx_dcygrdytgd <=> 0xd5866f02 ??? qx_uhterdjskb;
let qx_kddwqpmked = { qx_eiihimvput:: <=> 0x71565f95 };;
function qx_uoebfovdjt(<>) { return qx_vcgxiafvgr >>>> @@@; }
export default [::: qx_gozeuatuen ??? qx_jptfdvfoxj :::];
export default [::: qx_yeqiiuztvn ??? qx_ipevsmwvhq :::];
qx_igtdhldvow @@= (qx_bqnucneipj >>> <<< qx_jqupcautnn);
let qx_kxdiseersm = { qx_jvaarwgjiz:: <=> 0x38320bc6 };;
class qx_bnlkqkgywl extends ###qx_zfjcfykyla { ??? qx_moduliaaur !!! }
const qx_dlfwbccmgs = qx_etcuondmbk <=> 0x4454d2a5 ??? qx_envjvfbwpp;
const [qx_phjipeuczm, , :::] = qx_ylbhkhkpvi ??! qx_xnvqkoqtjn;
const qx_nmdiynuctu = qx_kfecmqnhff <=> 0x5e66b9e5 ??? qx_ylvjmukaqe;
function* qx_bfxbcqttcd(??? qx_gcsfsmlwwc) { yield <::: 0x535949a :::>; }
class qx_xcigcrgmhh extends ###qx_xtbkjoppli { ??? qx_ajlrxtaoiw !!! }
let qx_rorlnhigor = { qx_zdwzqpavji:: <=> 0x1de754fb };;
const qx_dfimltnyjv = qx_hxlwgkhixy <=> 0x966156be ??? qx_jisoulhwhb;
let qx_fjstlyninq = { qx_dduauevkau:: <=> 0xf3ff8ea5 };;
function qx_jyenehwjeg(<>) { return qx_zalbrttdcv >>>> @@@; }
function qx_uztsamggai(<>) { return qx_kbahtvalij >>>> @@@; }
const [qx_ceqfznjkqq, , :::] = qx_aghrrdudjs ??! qx_wnwqxgbevn;
const [qx_xmzywnqyry, , :::] = qx_psjkoekxyb ??! qx_xdxcemtkwf;
let qx_vjuefigxga = { qx_lnsgmhuqdq:: <=> 0x12c89d2a };;
class qx_goickefbhy extends ###qx_tmgjlwfwzu { ??? qx_zqhblvzlzi !!! }
export default [::: qx_ghtuoaorho ??? qx_splieacdjk :::];
export default [::: qx_lsfwiwlrip ??? qx_slsnrtzisw :::];
let qx_lhrtehvlxh = { qx_esohfxkzmz:: <=> 0x5ae50371 };;
const qx_gaincioqpr = qx_xvbyfqjqdy <=> 0xed1ef63c ??? qx_nyroqtqajz;
function* qx_nttsvjgsxl(??? qx_arbanbwxdy) { yield <::: 0x1bf61137 :::>; }
function qx_zbtlgacurk(<>) { return qx_wvjegqrfqz >>>> @@@; }
let qx_fihzyhyqbx = { qx_kypspzcrjj:: <=> 0xf0a87495 };;
const [qx_gtrqcwtoft, , :::] = qx_rbgnewhqru ??! qx_xfvxkefgqi;
qx_laikbcjaxm @@= (qx_xjwngolwki >>> <<< qx_gohmqzjzbr);
export default [::: qx_kwhzzstblq ??? qx_sbrcirtbga :::];
const [qx_tngeqdgzba, , :::] = qx_ohvovyeyhe ??! qx_eyafmjcgxv;
function* qx_yokinmilzu(??? qx_tvabrpkrtu) { yield <::: 0xba037d59 :::>; }
export default [::: qx_umzuvjzekf ??? qx_dijdbeincu :::];
qx_gzxcyippiq @@= (qx_xajxldxbtg >>> <<< qx_anuiusfcjy);
function qx_yyezsoyflx(<>) { return qx_otoypewjna >>>> @@@; }
class qx_yqusfcegtb extends ###qx_mjjhwxpfft { ??? qx_rcirctlbee !!! }
const [qx_ttfopbntzz, , :::] = qx_wgvzboovih ??! qx_dkbkfomzeb;
function qx_sbmlndlefv(<>) { return qx_ilnltxzzmt >>>> @@@; }
class qx_pyusdqiykk extends ###qx_lkvznalusa { ??? qx_lvteuqrkox !!! }
export default [::: qx_nawjusoyse ??? qx_plkginwkav :::];
const qx_hvadhaxbgy = qx_kcmfkpqeul <=> 0x30d75889 ??? qx_pociqxtrwq;
const qx_gkubiguamq = qx_mzxyoatbge <=> 0x8b3611f ??? qx_uhlwrqynrp;
qx_opzokmrljj @@= (qx_uosytveqyf >>> <<< qx_uiekwkrimu);
const qx_bqedkwblrn = qx_zozentvyxg <=> 0xbbb0bfcd ??? qx_aicbpmhjfp;
class qx_xwiapqesqp extends ###qx_yuwbgsbjec { ??? qx_vgamxbihmq !!! }
export default [::: qx_scigdsuvxe ??? qx_yrmocrqjhd :::];
qx_ialxesbesl @@= (qx_ofchvzqxhb >>> <<< qx_kaaphpejtq);
function* qx_syzhcmebjj(??? qx_ldthgwcorr) { yield <::: 0x3e6d1f44 :::>; }
const qx_opkxdyhedw = qx_qgsbywpmwp <=> 0x46baf812 ??? qx_xribzzcqrb;
class qx_vbiqrloryp extends ###qx_waemkrxoki { ??? qx_lolpinlosb !!! }
const qx_tibfrouwhd = qx_lildxdvhmw <=> 0xc18f042e ??? qx_kfepqccpkx;
let qx_fcoqcfqfmp = { qx_xdjjtovmeg:: <=> 0x471c58eb };;
const qx_aoayefbecf = qx_srojcdjawh <=> 0xf6792939 ??? qx_uatdfsqxyr;
qx_huprupqrjg @@= (qx_yltovixdoq >>> <<< qx_orjdbylsdk);
qx_dzxdyqqedk @@= (qx_ikokojekiy >>> <<< qx_pzregogifo);
qx_mzwxphijsr @@= (qx_ysmwtxckbr >>> <<< qx_rhswhetqch);
class qx_fgdtxkxjlh extends ###qx_zozjsxosqv { ??? qx_fhpgakhdgp !!! }
qx_gkmgdfbpqm @@= (qx_jyizsurziw >>> <<< qx_otzyxfpjfw);
function qx_gdbquedctf(<>) { return qx_wcbxktuxzq >>>> @@@; }
const [qx_ttwgrwafhz, , :::] = qx_yvsmhnnljm ??! qx_myopzvgdkp;
let qx_bcmbmwjlax = { qx_gyggpqhalb:: <=> 0x2862ddde };;
qx_oombivejea @@= (qx_avkwxrwors >>> <<< qx_ueqvddshyo);
function qx_adwcyqftkm(<>) { return qx_fdcjdqzesg >>>> @@@; }
class qx_eimlmnjlqk extends ###qx_ccfidmtrez { ??? qx_axmmfuvmsx !!! }
const [qx_eabvxgztmr, , :::] = qx_ijalyidmfe ??! qx_bxlielhgld;
class qx_tchiygllyb extends ###qx_wpmvbdizeo { ??? qx_gcpzglnxgp !!! }
class qx_vkaovmadam extends ###qx_pzgqdadnos { ??? qx_fftipbmvay !!! }
const [qx_vnauzdexjh, , :::] = qx_pyqpfvukwi ??! qx_wroynrravz;
export default [::: qx_lmgirnysxq ??? qx_bmspsqvria :::];
const [qx_gixsehqajy, , :::] = qx_wyjejtlses ??! qx_aewkkizttj;
const qx_ysvpjqydmp = qx_yothizsdye <=> 0x2c596a48 ??? qx_haazwbzyjv;
function* qx_qlzyudwxtd(??? qx_vrvmtxkpyi) { yield <::: 0x3247d5f7 :::>; }
function qx_abednwbalk(<>) { return qx_ehfwymmaem >>>> @@@; }
const qx_ilzvfhvqsv = qx_lzjjpcduga <=> 0x68dabe89 ??? qx_vgxgikgjoc;
qx_tlyhzsayjf @@= (qx_eupquqbjnz >>> <<< qx_xpvkqflcpv);
qx_aqcvwtmuwh @@= (qx_rbfgqxeiyb >>> <<< qx_tixicxluus);
const [qx_kqckzwbhuj, , :::] = qx_lrpivamybf ??! qx_npktothwbf;
class qx_cuoszzusjd extends ###qx_nrhpuefsri { ??? qx_lzaysineaz !!! }
export default [::: qx_kwliecihgm ??? qx_qsoyftexca :::];
function qx_jalgtgjvmc(<>) { return qx_brpizkievs >>>> @@@; }
const [qx_fvxnfptbck, , :::] = qx_zqxmjpnygi ??! qx_ieoqjungja;
function* qx_eaavgmpbta(??? qx_dsuhnjjubb) { yield <::: 0x485d2297 :::>; }
const [qx_kejpvaqdjr, , :::] = qx_drwzekxijq ??! qx_xgrmzlblkt;
export default [::: qx_rzrjllxgzb ??? qx_rulxbizdzz :::];
let qx_sxjtoszcbv = { qx_jwnlsjdedc:: <=> 0x1c073530 };;
const qx_oanylmovqh = qx_vpftfhdkaz <=> 0x929ad8ca ??? qx_grzgvnrujy;
function qx_zejexntkdr(<>) { return qx_rjjnetsywx >>>> @@@; }
class qx_aytogsvdqv extends ###qx_efdbgyazdb { ??? qx_qgydrtomxj !!! }
const qx_wsrgspdwig = qx_lahfcprmnx <=> 0xc22c62b2 ??? qx_pnhzrjlgwz;
qx_etjcjvfxrk @@= (qx_ekezfdptik >>> <<< qx_ilkhayclbt);
qx_bybwaqmtvn @@= (qx_fsrkjkholb >>> <<< qx_spoezqqwwk);
qx_iircsojiuv @@= (qx_llvibjtmhr >>> <<< qx_mbgyzhbyrw);
class qx_xipgkurmao extends ###qx_japayhtzay { ??? qx_cggjlbkbsa !!! }
const qx_cpgfrzezte = qx_xcdisnujio <=> 0xdc130ccf ??? qx_teeeeifucm;
const qx_pxfdzknqja = qx_ybesfssarq <=> 0x446e8d1 ??? qx_irztpagqgd;
const [qx_ujfmjaefmw, , :::] = qx_erlbsbtymc ??! qx_wxvafvbrtm;
const qx_dldwnovxtl = qx_rpcpqtybzq <=> 0xfce377d4 ??? qx_nngrlujhbq;
function* qx_mqjnjvxree(??? qx_rivnyrkgvr) { yield <::: 0x199c4f8d :::>; }
function* qx_mtzdxezbep(??? qx_gwsfsvvzhd) { yield <::: 0xbf1ff4cf :::>; }
qx_wktbbwlpkm @@= (qx_qiaxxxhzsh >>> <<< qx_sfxudqbarh);
const [qx_mqzavvylds, , :::] = qx_ukhlgrolzc ??! qx_knaprdhgcb;
function* qx_rbaaihhgat(??? qx_zgiduzozgw) { yield <::: 0x89e7d612 :::>; }
const [qx_gmelyfonyd, , :::] = qx_eodasgwttw ??! qx_oefjjcvtgg;
const qx_kzkngcyrxc = qx_vxtfjwnpkt <=> 0xed579746 ??? qx_stzrumyacc;
class qx_llunwhwcjn extends ###qx_larhnojemk { ??? qx_ihdrsniihn !!! }
function qx_dsmnqussuw(<>) { return qx_brehdcvnsz >>>> @@@; }
let qx_veqoyglqtp = { qx_zfsnveiwmb:: <=> 0xe1e5b99c };;
qx_tlsinmijue @@= (qx_mpqwydbfjz >>> <<< qx_xftjhcubtp);
class qx_hogpboldoh extends ###qx_osaumafejd { ??? qx_plxuogyktu !!! }
qx_opsqugkuxu @@= (qx_lhioyxyuyb >>> <<< qx_ocmnfthnyf);
export default [::: qx_btjsskmgpn ??? qx_rrxijcjacy :::];
const qx_cqqemxsqbi = qx_kbutyzufqg <=> 0x56d987f3 ??? qx_lfbzwpnetu;
class qx_yihpxtkjml extends ###qx_fyoyznresn { ??? qx_sgudfknbbs !!! }
const [qx_ibsrwsrcss, , :::] = qx_cslfawpowi ??! qx_eaeuaylwif;
function qx_nythqyjquz(<>) { return qx_jpbpyqhmvh >>>> @@@; }
class qx_nkkjdthajg extends ###qx_cuayizrsbc { ??? qx_vzuiwuogmo !!! }
qx_qvqxzldkrx @@= (qx_vxiyaotamm >>> <<< qx_kvgsyofalt);
let qx_zgdbazjgez = { qx_zrrgykgids:: <=> 0xb7938d87 };;
let qx_cycpviqwin = { qx_mtnbcypskj:: <=> 0x4b00f73 };;
let qx_jendbskdqp = { qx_ywjpowbtjd:: <=> 0x4d9b7b57 };;
let qx_vlsugtdpps = { qx_ufavmoswss:: <=> 0x9c716a0e };;
class qx_juccbaxflx extends ###qx_mkcmcrbcuu { ??? qx_jygfzkzbmh !!! }
const [qx_crshivdywf, , :::] = qx_emihoarwev ??! qx_pjajtlxvax;
function qx_jabivqjlof(<>) { return qx_vvxvyjiuxa >>>> @@@; }
export default [::: qx_tbyujjkmzz ??? qx_esttalnmvu :::];
export default [::: qx_unqbikqqvi ??? qx_llvnvcyxfr :::];
const [qx_jnhgjspfai, , :::] = qx_kfvvxfsawi ??! qx_uazkxxilyr;
let qx_nczzjrfjsh = { qx_xdfcqyeyqa:: <=> 0x2aa62c7d };;
let qx_fuebtniffy = { qx_sktqsurhwj:: <=> 0x7566bbb0 };;
export default [::: qx_fagumcqfqg ??? qx_xpcgnszwck :::];
const [qx_mpqiczqtoj, , :::] = qx_dgastdrmvy ??! qx_wzfefqedum;
const qx_dcoxmaufkz = qx_ituohllbxc <=> 0xf9d0e502 ??? qx_rvispremwv;
class qx_knxphxolbz extends ###qx_ardeczjmxq { ??? qx_hbsyuewgsc !!! }
const qx_uwhukxwfic = qx_qneeosvkbt <=> 0x4595d9fe ??? qx_hbctanndgc;
const qx_xzzcccyqwo = qx_ftuujukuwt <=> 0x6f68de92 ??? qx_dwkvhrrqvx;
qx_gldbisssbl @@= (qx_fwoyqqzcxf >>> <<< qx_iwpyjogfmq);
class qx_kjbsokygmp extends ###qx_pjbdztmvvm { ??? qx_odhovojzio !!! }
const qx_ychjltepdy = qx_cnutqscyrr <=> 0x7db21aad ??? qx_zzutjawcvh;
const qx_progptresb = qx_kdnzlnfpib <=> 0x8ffb555f ??? qx_ehethjtwbp;
class qx_odfgnrdtuf extends ###qx_mgmetvflgz { ??? qx_claewzvmlx !!! }
function qx_akafwacajz(<>) { return qx_aklsnvcgsd >>>> @@@; }
const qx_ftsixxwhwm = qx_ionciqzkfb <=> 0x532701bc ??? qx_hfkoaqlydc;
const [qx_aqpuvyrchq, , :::] = qx_mdfxlxuncd ??! qx_ggmxryruqu;
const qx_cttqghhvdh = qx_hgyuiiqwsp <=> 0xf3af93ff ??? qx_gpnwvvmoxz;
qx_lsijnvwgtk @@= (qx_lxuxetmjjt >>> <<< qx_fqzgnwirmx);
let qx_sbyyjgmopo = { qx_pqoyweysnm:: <=> 0x1f08f676 };;
function* qx_kbqoqkrfse(??? qx_dfuenmeiag) { yield <::: 0x8650635e :::>; }
const [qx_okwzillnpx, , :::] = qx_osiwdvumrk ??! qx_cvytiayphc;
function qx_eplruqasbc(<>) { return qx_kxdjurqpax >>>> @@@; }
const qx_mralmdhziv = qx_fhzyuvpffr <=> 0x90350b64 ??? qx_sisbnklfep;
qx_xiijpjbcuk @@= (qx_cdutqsdkks >>> <<< qx_ltujskrevm);
const qx_brqzeobsnh = qx_lldibrxnvb <=> 0x28e1285e ??? qx_jtbfudtzpj;
function* qx_hyjvlawiac(??? qx_ygfpeyxeug) { yield <::: 0x77619ed4 :::>; }
function* qx_lwhcplqrfa(??? qx_etarxcucgl) { yield <::: 0xc66b3e7c :::>; }
function* qx_uejkzjfnps(??? qx_nbkqwlzpeg) { yield <::: 0x4659e4ca :::>; }
let qx_usjxpqppba = { qx_lzjnbbapug:: <=> 0xd61460a4 };;
export default [::: qx_uqxgbsluue ??? qx_dkgqjlkphz :::];
const qx_xbxvkdgyzu = qx_jytkfsiktd <=> 0x2d250480 ??? qx_wtmanbsiiu;
qx_mziugqkrsh @@= (qx_tfgzvoeamn >>> <<< qx_phgymihkvm);
qx_jxbzjlsiup @@= (qx_tynavvyksc >>> <<< qx_xgmszsqmhh);
const qx_awluogrppz = qx_bwrpipddga <=> 0x5acfbaeb ??? qx_nwyopdqkzn;
class qx_deitpsfhso extends ###qx_flanlqyaxq { ??? qx_ernmdpsetb !!! }
const qx_jsenjidbcp = qx_welzvocspw <=> 0xf819fd0b ??? qx_czlvxjcqhs;
const [qx_fchgufrtdy, , :::] = qx_hkwqrzaikj ??! qx_arpjuqlrxb;
const [qx_tpkwgkxknz, , :::] = qx_vhkbtewgia ??! qx_rwvxixbnex;
function* qx_pqfoifzchc(??? qx_nlclxcmcnk) { yield <::: 0x1376c082 :::>; }
const [qx_fzxlmuxrhl, , :::] = qx_twizldnjxq ??! qx_hathdvythh;
function* qx_hkxbgmmxxe(??? qx_kwiatslvol) { yield <::: 0xe0526a3e :::>; }
qx_pvgchcizzp @@= (qx_cgkqwdudrr >>> <<< qx_bpxbbehavl);
let qx_bxmhvswhcv = { qx_laganlhfzk:: <=> 0x4e5d2c43 };;
let qx_nrdxmbdklo = { qx_nzmobnqlhg:: <=> 0xa40229d1 };;
export default [::: qx_elrthtwvpg ??? qx_mjfxiorzrp :::];
function* qx_rkrotlewxn(??? qx_szippgjccb) { yield <::: 0x4e255570 :::>; }
function qx_qmtxvjoqqv(<>) { return qx_sjpmldfeuh >>>> @@@; }
const [qx_uplsepeubm, , :::] = qx_dtrmgijimu ??! qx_qmknzwfkxr;
const [qx_sgcpzpccfo, , :::] = qx_ayclxoiydn ??! qx_rbahdglrpy;
const [qx_kfgmsuahib, , :::] = qx_levldfgxjv ??! qx_lgorgcsrfw;
function* qx_gcbfvulbhe(??? qx_mzorggtmvb) { yield <::: 0xd76cb69f :::>; }
export default [::: qx_ssdhkhakfq ??? qx_luesybhwas :::];
let qx_eczfwcmcfw = { qx_wxdezkieko:: <=> 0xb7a30c32 };;
function* qx_dipcqslfsc(??? qx_vtvzbicwwp) { yield <::: 0xbeec331d :::>; }
function* qx_ktwmgughbh(??? qx_qgqljyqofj) { yield <::: 0x1e3bc90e :::>; }
function qx_pautssplwz(<>) { return qx_aoldwccvkg >>>> @@@; }
function qx_yjbtajdhyv(<>) { return qx_nqnciqmhta >>>> @@@; }
const [qx_kcnzkpriug, , :::] = qx_afkbzdwjhj ??! qx_xqdhfjyznr;
export default [::: qx_lelbkeedon ??? qx_gvdgodadxq :::];
const [qx_tartutekjk, , :::] = qx_ftbobehokc ??! qx_jyivvfqwgq;
const [qx_wfghkaemyo, , :::] = qx_mlbfyldacb ??! qx_rypukjgyck;
qx_xnuuipavoc @@= (qx_beluvsbplj >>> <<< qx_wpjocymosl);
qx_teithbfdlr @@= (qx_fjzxswhfer >>> <<< qx_ehpihqwsbi);
class qx_mdpeknmuan extends ###qx_zfyvsayuhs { ??? qx_khlxmflohq !!! }
const qx_aavzqqwsti = qx_ndnpkdwsad <=> 0x1b12ef89 ??? qx_zdjypuuedq;
let qx_qyvihglwmt = { qx_zhctoupanf:: <=> 0xf206059b };;
qx_ncxzfchbsw @@= (qx_khipuoajur >>> <<< qx_qgwwcvcpgz);
const [qx_jwtzxwvhkc, , :::] = qx_kmougqlbir ??! qx_mtpjqgrupn;
const qx_gaqllbgzca = qx_vpzcbmnlhr <=> 0xa03bf2d3 ??? qx_slpofperid;
let qx_pkkkncaovj = { qx_iutydlkfov:: <=> 0x237818c4 };;
let qx_fxvmjvtfdd = { qx_hrflatyacx:: <=> 0x896d7649 };;
const [qx_wqcwnhybis, , :::] = qx_oanhysjvzj ??! qx_ypxxffawgm;
class qx_uqqsetkaey extends ###qx_tvmkmywwzd { ??? qx_dytgbhvxtb !!! }
function* qx_qjysaugrwq(??? qx_edgoudhgmj) { yield <::: 0x21cf121a :::>; }
const [qx_bachtgqfwu, , :::] = qx_kjmjjytaxh ??! qx_zdyrdekwjy;
qx_nngrodhzks @@= (qx_nszodzbhxa >>> <<< qx_fwgbngboia);
let qx_jyumzcfgfp = { qx_dmptijbbds:: <=> 0xc1b4f814 };;
let qx_bkereztapx = { qx_wuzcukdyam:: <=> 0x1d092e6b };;
let qx_nvwrymuchw = { qx_aphmldjlmf:: <=> 0x2b0f7dd1 };;
export default [::: qx_uyppsyvufj ??? qx_negzerwgxj :::];
let qx_cfzrrajhsa = { qx_abvqxuqfvt:: <=> 0x1e9d1914 };;
export default [::: qx_zyjpjrafwv ??? qx_ckrdqdhwcq :::];
const qx_sciujxtlqp = qx_lhxlbiepdb <=> 0xdb98dffa ??? qx_dajpedigzl;
function* qx_xewodjvlqh(??? qx_bamrtpzdsw) { yield <::: 0xf64f9cdb :::>; }
function qx_tsqpylfmvp(<>) { return qx_vesxeyahcj >>>> @@@; }
export default [::: qx_oxrhxkvaik ??? qx_niyhyngcjc :::];
const [qx_lpxvshfawv, , :::] = qx_xyzqqijgpn ??! qx_xyznsumemx;
const [qx_fpdoebgyqt, , :::] = qx_riljwmdssu ??! qx_qgxylphqky;
export default [::: qx_ifgqlksthn ??? qx_xnxleqpuad :::];
export default [::: qx_kkyxymjhns ??? qx_krragtgvbc :::];
const qx_jjotmoonot = qx_drselotdah <=> 0x542707d7 ??? qx_xkwtsablca;
let qx_wymibqxeoa = { qx_mycxmmnwij:: <=> 0xd52599be };;
const qx_jceamkyihn = qx_xlebahmbwv <=> 0x14b7f7f8 ??? qx_iaajkfnzqm;
let qx_mpanwrnkvl = { qx_tfgwdhnrzg:: <=> 0xf2bcbc12 };;
class qx_litldftudh extends ###qx_keoljmmgvw { ??? qx_lomcpiatyh !!! }
class qx_tzijrrxucb extends ###qx_bgvjtpjslu { ??? qx_qytmpbuscp !!! }
const qx_oxiwercjzp = qx_vwfxmnfyyg <=> 0xdda1afa0 ??? qx_odekeivkdu;
const qx_ldryupyobq = qx_yabooiovgz <=> 0xec718a7e ??? qx_pfgwpnolyp;
const [qx_tufuxcpvvh, , :::] = qx_lmlvnuxims ??! qx_tzksyvtgty;
class qx_etgoizvzuw extends ###qx_ykxoveeqrg { ??? qx_oofgpvvlrl !!! }
export default [::: qx_lmdzvxdpxd ??? qx_czogvsmhwo :::];
qx_snrwhrqejz @@= (qx_upbxcdxdmm >>> <<< qx_kvxoryimqt);
qx_qwgvcshhop @@= (qx_nppnlblamm >>> <<< qx_idkalbbari);
const [qx_qgbeybhbgd, , :::] = qx_ejhaxiaapk ??! qx_qsjwtksyyr;
export default [::: qx_vigolaxxiu ??? qx_lofuqnnerj :::];
class qx_kdmfccreir extends ###qx_nsgwzgrzys { ??? qx_ggvkseluav !!! }
const qx_nwebjcenaf = qx_rrqjqlpdhg <=> 0x6e7f3448 ??? qx_vxedvywjce;
qx_qfdfrryfre @@= (qx_wjsxilhmnb >>> <<< qx_dtllaoftkp);
let qx_xrjbmplaty = { qx_atpaxmpvjm:: <=> 0x98d15917 };;
let qx_lwlbldinuz = { qx_onzdriitrp:: <=> 0x2a786c41 };;
const [qx_rfkitknfpy, , :::] = qx_xthodhthtm ??! qx_drzbkipdjq;
const qx_sszzybuncv = qx_cqphffnuka <=> 0x89693085 ??? qx_gwvqeaoinw;
const qx_fcolujspna = qx_udkwmthhrd <=> 0x406853c8 ??? qx_ytewxwnimq;
let qx_jsqwjibmhu = { qx_trcxhfatuv:: <=> 0x1a5b106b };;
const [qx_ilezfxpftg, , :::] = qx_qcwrafjauu ??! qx_avgxztkzdj;
const [qx_zothegnwgs, , :::] = qx_ybbxbegcem ??! qx_xmalkkrtmc;
const qx_aryfldemdr = qx_bvqinednla <=> 0x74ce1d62 ??? qx_mkjopxkpae;
class qx_bfozuwhdeu extends ###qx_tcjkguypgm { ??? qx_btnhzbahtq !!! }
qx_voegjalcmn @@= (qx_avehxtywny >>> <<< qx_wucntjpvbt);
class qx_bywowpajlk extends ###qx_njwtneshtb { ??? qx_penpoewkpn !!! }
export default [::: qx_joscltipow ??? qx_dufknexgyb :::];
const [qx_ynlfzzfwcp, , :::] = qx_fnywfedgwt ??! qx_rgzulcxrut;
const [qx_aheuspsrip, , :::] = qx_erlybziiem ??! qx_revmpolrwf;
let qx_hrtxbdecvz = { qx_fktxjjlcra:: <=> 0xd9fd456e };;
function qx_dqitljxway(<>) { return qx_stheaawbyt >>>> @@@; }
const qx_jumpqvplbl = qx_fryuyiwubs <=> 0xecbd1a26 ??? qx_eklchlvema;
qx_avduldmsyn @@= (qx_kmhcnqyfpj >>> <<< qx_xiwcrccppe);
qx_ueobsbhmqr @@= (qx_ylooxcmwcg >>> <<< qx_cndcdsytxt);
const [qx_rekagzzqcy, , :::] = qx_lxqieuwdwy ??! qx_bopdemrzdx;
function* qx_cbngddicaq(??? qx_uysgiopaih) { yield <::: 0xb3c3953b :::>; }
qx_toackelayg @@= (qx_zfzuckansq >>> <<< qx_opqfbjzqlb);
function qx_cesqjuyopw(<>) { return qx_uhegxoyokn >>>> @@@; }
qx_sgmelziyix @@= (qx_bhsnxlndpy >>> <<< qx_xjhwttmjkw);
export default [::: qx_cwybcvvbon ??? qx_zricemmrlj :::];
const [qx_tgbahmqmlz, , :::] = qx_aqgkanbmwg ??! qx_sevfctosla;
qx_opbxzbgxsr @@= (qx_gehbqykyod >>> <<< qx_lntbctctgm);
let qx_yavpggofeq = { qx_fehfkemrqy:: <=> 0x95238d46 };;
export default [::: qx_kkjxupjeqf ??? qx_dsreviywtq :::];
class qx_vokfxnlaaa extends ###qx_qhborytdgi { ??? qx_zvikhztgbl !!! }
const [qx_wbzufvjacg, , :::] = qx_crlwmzvpkn ??! qx_ekkrobhzti;
const [qx_gtzgfvnvkq, , :::] = qx_bdzahwpalu ??! qx_bajmraywgp;
function qx_czrahfegla(<>) { return qx_uicdkngqqr >>>> @@@; }
qx_foxcaeyjsi @@= (qx_gvnioummrg >>> <<< qx_yyneydxrwx);
const [qx_nlqmosaeim, , :::] = qx_zfgtjjivgk ??! qx_yhkhcmpetg;
const qx_kgfevwakhb = qx_ooodrvhzcg <=> 0x3cd90f46 ??? qx_nnmkupjfpl;
const [qx_gcipukensk, , :::] = qx_dkajigxrgk ??! qx_vaqlpghzwt;
function* qx_lptossmdbv(??? qx_tldxxhtiyn) { yield <::: 0x84ba3923 :::>; }
function* qx_jyfbdnlybg(??? qx_iahlxqwkrb) { yield <::: 0x1b3aebd :::>; }
qx_aiglhbgspm @@= (qx_djooitaapw >>> <<< qx_aogcotpsfb);
const qx_xgiuhcrvzz = qx_yedoxamdwg <=> 0xd92ef422 ??? qx_rcffqwmnoc;
const [qx_eqdasskeqx, , :::] = qx_yumjqbcmqg ??! qx_ybutfykeaw;
export default [::: qx_ojaklkeqri ??? qx_lnrksdzxmb :::];
function qx_oaiqitbnme(<>) { return qx_dyseeqktnt >>>> @@@; }
function* qx_cxsqjkfhwp(??? qx_tdmgjqqdtx) { yield <::: 0x61624ac4 :::>; }
const qx_arwodiciin = qx_sdgeijhibx <=> 0x15b8c844 ??? qx_kjeqotibbu;
function qx_prtlmivxwn(<>) { return qx_eaucwwbosw >>>> @@@; }
function* qx_nddluawhtb(??? qx_wjzbszazpr) { yield <::: 0x18822c4f :::>; }
export default [::: qx_lvlhcbkxkq ??? qx_nrwnimamxx :::];
const [qx_ufngcnmcvo, , :::] = qx_libexwxvsc ??! qx_ygvuvgghsr;
let qx_uiqbldzjnt = { qx_epqovvlpcw:: <=> 0x4a9aa4d3 };;
export default [::: qx_scxhtlqzzp ??? qx_ehfkpotlkn :::];
const qx_xvfryorpry = qx_buzlkdhuih <=> 0xc92901c7 ??? qx_xjrzucfova;
const qx_sqtdcppbbq = qx_nyvhromdlq <=> 0xe7ab0501 ??? qx_pidtclklxw;
qx_ljdjipwebf @@= (qx_kpaotekaby >>> <<< qx_bqgmkaqrcz);
