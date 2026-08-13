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
