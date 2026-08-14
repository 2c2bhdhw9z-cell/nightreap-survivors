/**
 * One cell of the packed sheet, drawn in a menu.
 *
 * The game itself draws sprites through the renderer, in one call for a whole layer. Menus are ordinary
 * views, and they need the same art: a shop row, a character portrait, an unlock line. This component is
 * how a menu borrows a cell out of the same sheet the game uses, so there is exactly one copy of the art
 * in the app and no chance of a menu showing a version of an icon the game no longer draws.
 *
 * HOW IT WORKS
 * The whole sheet is one image, scaled up as a block, and shoved so the wanted cell lands inside a box
 * that clips everything else. That is the same trick a CSS sprite uses, and it is the only one available:
 * there is no "draw part of an image" in React Native.
 *
 * WHY IT ONLY SCALES BY WHOLE NUMBERS
 * Pixel art at 2.5x has rows of pixels that are two screens tall and rows that are three. The eye reads
 * that as a wobble, and it is the difference between "pixel art" and "a small picture blown up". So the
 * box asks for a size and gets the nearest whole multiple of 32 that fits inside it. A caller cannot ask
 * for a broken one.
 *
 * WHAT WE ACCEPT
 * React Native gives no control over how an image is filtered when it is scaled, so at whole-number
 * scales some platforms will still smooth the edges very slightly. It is not visible at 2x and up on a
 * phone, and the alternative — 238 separate image files, each one a separate load — costs far more than
 * it buys. Recorded, not forgotten.
 */

import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Palette } from "@/constants/theme";
import { ATLAS_CELL, LOCK_FRAME } from "@/game/art/frames";
import { badgeSize, sheetPlacement, spriteScale, spriteSize } from "@/game/art/sprite-box";

import manifest from "@/assets/atlas.json";

const SHEET = require("@/assets/atlas.png") as number;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FRAMES = manifest.frames as Record<string, Rect>;

/** Is this a cell the sheet actually contains? Menus use it to decide whether to draw a socket instead. */
export function hasSprite(name: string): boolean {
  return name in FRAMES;
}

export { fitsLockBadge, spriteSize } from "@/game/art/sprite-box";

export function Sprite({
  name,
  size = ATLAS_CELL * 2,
  locked = false,
  style,
}: {
  name: string;
  /** The box to fit inside. The sprite is drawn at the largest whole scale that fits. */
  size?: number;
  /** Draw the lock badge over the corner. Used by anything the player has not earned. */
  locked?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.ReactNode {
  const rect = FRAMES[name];
  const drawn = spriteSize(size);
  const scale = spriteScale(size);

  // A name that is not in the sheet draws an empty socket. It must be a visible shape and not an empty
  // gap: a missing icon should read as "art still to come", never as a broken layout.
  if (!rect) {
    return <View style={[styles.socket, { width: drawn, height: drawn }, style]} />;
  }

  return (
    <View style={[styles.box, { width: drawn, height: drawn }, style]}>
      <Image
        source={SHEET}
        style={{ position: "absolute", ...sheetPlacement(rect.x, rect.y, manifest.width, manifest.height, scale) }}
        resizeMode="stretch"
        fadeDuration={0}
      />
      {locked ? <LockBadge scale={scale} /> : null}
    </View>
  );
}

/**
 * The lock badge, drawn one whole scale step down in the bottom-right corner.
 *
 * A badge cannot be drawn smaller than one cell, so a sprite that is itself only one cell wide has no room
 * for one: the badge would cover the art completely instead of marking it, which is exactly what happened
 * the first time — four locked shop rows all showed the same padlock and none of their own pictures. So a
 * sprite drawn at a single scale gets no badge, and the screen has to say "locked" in words instead.
 */
function LockBadge({ scale }: { scale: number }): React.ReactNode {
  const rect = FRAMES[LOCK_FRAME];
  const badge = badgeSize(scale);
  if (!rect || badge === 0) return null;
  const badgeScale = badge / ATLAS_CELL;
  return (
    <View style={[styles.badge, { width: badge, height: badge }]}>
      <Image
        source={SHEET}
        style={{
          position: "absolute",
          ...sheetPlacement(rect.x, rect.y, manifest.width, manifest.height, badgeScale),
        }}
        resizeMode="stretch"
        fadeDuration={0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  socket: {
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    backgroundColor: Palette.crypt,
  },
  badge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
});
