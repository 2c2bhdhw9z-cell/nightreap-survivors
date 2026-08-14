/**
 * Painting the chest opening.
 *
 * `chest-open.ts` decides what a given moment of the sequence looks like as plain numbers. This file
 * turns those numbers into quads, and does nothing else — no clock, no state, no decisions. Split that
 * way for the same reason the HUD is: a painter that draws into an interface can be pointed at a
 * recorder in a test and asked exactly what it drew and where, with no phone and no GL context in
 * sight. "Run it and look at it" is not a check.
 *
 * TWO PASSES, TWO COORDINATE SYSTEMS
 *
 * The chest itself lives in the world — the light, the coins, the ribbon and the burst all sit at the
 * place on the floor where the chest was, and the camera moves past them. The flash and the reward card
 * live on the screen: a flash that scrolls with the floor is not a flash, and a card that slides off the
 * edge because the player kept walking is not a card. So there are two entry points, one per layer
 * space, and the caller submits them to the right layers.
 *
 * EVERYTHING IS A RECTANGLE
 *
 * One drawing call, like the HUD. A rectangle can be a beam of light, a coin, a panel, a flash or an
 * arm of a star, and anything that cannot be built out of rectangles does not get drawn. That is a
 * real constraint and it is worth it: the sink is six lines to fake, so every quad is checkable.
 */

import {
  SPARK_COUNT,
  sparkAt,
  type ChestOpenFrame,
  type ChestOpenSpec,
  type Spark,
} from "./chest-open";
import {
  GLYPH_GAP,
  GLYPH_W,
  HUD_COLOR,
  drawNumber,
  drawText,
  textWidth,
  type HudArt,
} from "./hud-draw";
import { withAlpha, type Frame, type PackedColor } from "./batcher";

/** The only drawing call needed. `SpriteBatcher.drawRect` satisfies it unchanged. */
export interface ChestSink {
  drawRect(frame: Frame, x: number, y: number, w: number, h: number, color: PackedColor): void;
}

/** The atlas cells the sequence needs: a solid white cell, and the three pickup pictures for coins. */
export interface ChestArt extends HudArt {
  /** Small gem, medium gem, coin — whatever the caller hands over, in that order. */
  sparkFrames: readonly Frame[];
}

/** How big a thrown coin is drawn at scale 1, in world units. */
export const SPARK_SIZE = 14;

/** The ribbon is a short bright dash rather than a dot, so its direction of travel reads. */
export const RIBBON_W = 10;
export const RIBBON_H = 4;

/** The burst is a four-armed star: this is one arm's length and thickness at scale 1. */
export const BURST_ARM = 12;
export const BURST_THICK = 3;

/** The reward card, in screen units. */
export const CARD_W = 168;
export const CARD_ROW_H = 14;
export const CARD_PAD = 8;
export const CARD_TEXT_PX = 2;
/** How far above the bottom of the screen the card sits when it has landed. */
export const CARD_BOTTOM_GAP = 56;
/**
 * Nothing wider than this many characters is drawn — a reward line is a phrase, not a paragraph.
 *
 * Worked out from the panel width rather than picked by eye. Picked by eye it was 26, which is four
 * characters of reward text hanging out over the fight, and nobody would have noticed until a weapon
 * with a long name dropped.
 */
export const CARD_MAX_CHARS = Math.max(
  1,
  Math.floor((CARD_W - CARD_PAD * 2 + GLYPH_GAP * CARD_TEXT_PX) / ((GLYPH_W + GLYPH_GAP) * CARD_TEXT_PX)),
);

/** Height of a card holding this many reward rows, including its title strip. */
export function cardHeight(rows: number): number {
  const n = Math.max(1, Math.min(8, Math.trunc(rows)));
  return CARD_PAD * 2 + CARD_ROW_H * (n + 1);
}

/**
 * The world pass: light column, thrown coins, ribbon, burst.
 *
 * `time` is seconds since the chest opened — the coins are asked for their own positions here rather
 * than being carried on the frame, because twenty-eight sparks on a frame object would mean either an
 * allocation per chest or twenty-eight more fields on a structure that is otherwise seven numbers.
 */
export function drawChestWorld(
  sink: ChestSink,
  art: ChestArt,
  frame: ChestOpenFrame,
  spec: ChestOpenSpec,
  time: number,
  spark: Spark,
): void {
  if (!frame.active) return;

  // 1. the column of light. Drawn from the chest upward, so it grows out of the lid rather than
  // hanging in the air above it.
  if (frame.lightAlpha > 0 && frame.lightHeight > 0 && frame.lightWidth > 0) {
    const w = frame.lightWidth;
    sink.drawRect(
      art.white,
      spec.x - w / 2,
      spec.y - frame.lightHeight,
      w,
      frame.lightHeight,
      withAlpha(HUD_COLOR.xp, frame.lightAlpha),
    );
  }

  // 2. the coins. A spark with no alpha is not drawn at all rather than drawn invisibly — twenty-eight
  // transparent quads a frame is twenty-eight quads of nothing.
  for (let i = 0; i < SPARK_COUNT; i++) {
    sparkAt(i, time, spec, spark);
    if (spark.alpha <= 0) continue;
    const size = SPARK_SIZE * spark.scale;
    const cell = art.sparkFrames[spark.kind] ?? art.white;
    sink.drawRect(
      cell,
      spark.x - size / 2,
      spark.y - size / 2,
      size,
      size,
      withAlpha(HUD_COLOR.boneLit, spark.alpha),
    );
  }

  // 3. the ribbon.
  if (frame.ribbonAlpha > 0) {
    sink.drawRect(
      art.white,
      frame.ribbonX - RIBBON_W / 2,
      frame.ribbonY - RIBBON_H / 2,
      RIBBON_W,
      RIBBON_H,
      withAlpha(HUD_COLOR.gold, frame.ribbonAlpha),
    );
  }

  // 4. the burst: two crossed bars out of the middle of the flash.
  if (frame.burstAlpha > 0 && frame.burstScale > 0) {
    const arm = BURST_ARM * frame.burstScale;
    const thick = BURST_THICK * frame.burstScale;
    const colour = withAlpha(HUD_COLOR.boneLit, frame.burstAlpha);
    sink.drawRect(art.white, spec.x - arm, spec.y - thick / 2, arm * 2, thick, colour);
    sink.drawRect(art.white, spec.x - thick / 2, spec.y - arm, thick, arm * 2, colour);
  }

  // 5. the running gold total, floating over the chest. Drawn digit by digit out of the integer, so a
  // counter ticking sixty times a second never builds a string.
  if (frame.goldVisible) {
    drawNumber(
      sink,
      art,
      frame.goldShown,
      spec.x + 6,
      spec.y - 34,
      2,
      withAlpha(HUD_COLOR.gold, 255),
    );
    drawText(sink, art, "G", spec.x - 12, spec.y - 34, 2, withAlpha(HUD_COLOR.gold, 255));
  }
}

/**
 * The screen pass: the flash, and the reward card.
 *
 * `rows` are the reward lines exactly as the chest rules worded them. This file never composes them —
 * the wording of a reward belongs with the rules that granted it, so that what the card says and what
 * the player actually got cannot drift apart.
 */
export function drawChestScreen(
  sink: ChestSink,
  art: ChestArt,
  frame: ChestOpenFrame,
  viewW: number,
  viewH: number,
  rows: readonly string[],
): void {
  if (!frame.active) return;

  // The flash covers everything, the HUD included. It is two tenths of a second and it is the
  // punctuation between "something happened" and "here is what it was".
  if (frame.flashAlpha > 0) {
    sink.drawRect(art.white, 0, 0, viewW, viewH, withAlpha(HUD_COLOR.boneLit, frame.flashAlpha));
  }

  if (frame.cardAlpha <= 0 || rows.length === 0) return;

  const h = cardHeight(rows.length);
  const x = Math.round((viewW - CARD_W) / 2);
  const restY = Math.round(viewH - CARD_BOTTOM_GAP - h);
  const y = restY + frame.cardOffsetY;
  const a = frame.cardAlpha;

  // Panel: an outline, a body, and a lit strip along the top so the card has a reading order.
  sink.drawRect(art.white, x - 2, y - 2, CARD_W + 4, h + 4, withAlpha(HUD_COLOR.outline, a));
  sink.drawRect(art.white, x, y, CARD_W, h, withAlpha(HUD_COLOR.slab, a));
  sink.drawRect(art.white, x, y, CARD_W, 2, withAlpha(HUD_COLOR.gold, a));

  const title = "CHEST";
  drawText(
    sink,
    art,
    title,
    x + Math.round((CARD_W - textWidth(title, CARD_TEXT_PX)) / 2),
    y + CARD_PAD,
    CARD_TEXT_PX,
    withAlpha(HUD_COLOR.gold, a),
  );

  for (let r = 0; r < rows.length; r++) {
    const line = (rows[r] ?? "").slice(0, CARD_MAX_CHARS);
    if (line.length === 0) continue;
    drawText(
      sink,
      art,
      line,
      x + CARD_PAD,
      y + CARD_PAD + CARD_ROW_H * (r + 1),
      CARD_TEXT_PX,
      withAlpha(HUD_COLOR.boneLit, a),
    );
  }
}
