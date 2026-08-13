/**
 * The stone kit: the approved out-of-run look, as a handful of pieces every menu screen is built from.
 *
 * FIDELITY: these are React Native views. The shipped version of this look is drawn from the sprite
 * atlas — a cobble border tile and a nine-sliced slate slab, so the frame is crisp at any size on any
 * screen and costs one draw call instead of a view tree. That swap is a Phase 3 job and it does not
 * change any of the layout here, which is the whole reason for building the screens against these pieces
 * rather than against hand-written borders in twelve different files.
 *
 * Every screen inherits the same five things, and nothing invents its own:
 *
 *   Cobble    the outer frame — a rough stone border around the whole screen
 *   Slab      a recessed darker panel, which is what text and rows sit on
 *   Header    the title plate, gold text on stone
 *   Chunk     a button, in three weights: gold for the one thing you came here to do,
 *             stone for everything else, and grey for the thing that leaves
 *   Pips      the colour-blind-proof half of player identity, always drawn next to the colour
 *
 * The colour rules are not decoration and are not negotiable here: gold is currency and the primary
 * action, crimson is danger, cyan is experience, violet is arcana. A screen that wants a nice colour for
 * a button gets stone.
 */

import { Palette, Grid, Fonts } from "@/constants/theme";
import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

/* ---------------------------------------------------------------------------------------------- */
/* Text                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

// FIDELITY: platform monospace stands in for NightreapGlyph until the atlas ships.
const face = Fonts?.mono ?? "monospace";

export type StoneTextTone = "bone" | "gold" | "ash" | "crimson" | "cyan" | "violet";

const TONES: Record<StoneTextTone, string> = {
  bone: Palette.boneLit,
  gold: Palette.gold,
  ash: Palette.ash,
  crimson: Palette.crimsonLit,
  cyan: Palette.cyanLit,
  violet: Palette.violetLit,
};

export function StoneText({
  children,
  tone = "bone",
  size = 13,
  bold = false,
  align = "left",
  style,
}: {
  children: ReactNode;
  tone?: StoneTextTone;
  size?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <Text
      style={[
        {
          color: TONES[tone],
          fontSize: size,
          fontFamily: face,
          fontWeight: bold ? "700" : "400",
          textAlign: align,
          letterSpacing: 1,
        },
        style as never,
      ]}
    >
      {children}
    </Text>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Frame and panels                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The outer frame. Wraps a whole screen.
 *
 * Two nested borders rather than one: the outer is the mortar line, the inner is the lit top edge of the
 * stones. That is what stops a flat rectangle from reading as a web page with a border on it.
 */
export function Cobble({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }): ReactNode {
  return (
    <View style={[styles.cobbleOuter, style]}>
      <View style={styles.cobbleInner}>{children}</View>
    </View>
  );
}

/**
 * A recessed slate panel. Everything readable sits on one of these.
 *
 * `sunken` is the default and is what a list or a text area sits in. `raised` is for a row that should
 * read as an object you can press.
 */
export function Slab({
  children,
  raised = false,
  tint,
  style,
}: {
  children: ReactNode;
  raised?: boolean;
  /** Border colour override — used only to tint a row with a player's identity colour. */
  tint?: string;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <View
      style={[
        raised ? styles.slabRaised : styles.slabSunken,
        tint === undefined ? null : { borderColor: tint },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** The title plate at the top of a screen. Gold on stone, skulls optional and used sparingly. */
export function Header({ title, subtitle }: { title: string; subtitle?: string }): ReactNode {
  return (
    <View style={styles.header}>
      <StoneText tone="gold" size={17} bold align="center">
        {title}
      </StoneText>
      {subtitle === undefined ? null : (
        <StoneText tone="ash" size={11} align="center" style={styles.headerSub}>
          {subtitle}
        </StoneText>
      )}
    </View>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Buttons                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export type ChunkWeight = "gold" | "stone" | "grey" | "danger";

/**
 * A button.
 *
 * A disabled button stays on screen and says why somewhere else, rather than disappearing. A control that
 * vanishes is a control the player thinks they imagined.
 */
export function Chunk({
  label,
  onPress,
  weight = "stone",
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  weight?: ChunkWeight;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  const face_ = disabled ? styles.chunkDisabled : WEIGHTS[weight];
  const tone: StoneTextTone = disabled ? "ash" : weight === "gold" ? "gold" : weight === "danger" ? "crimson" : "bone";
  return (
    <Pressable
      onPress={disabled ? () => {} : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.chunkBase, face_, pressed && !disabled ? styles.chunkPressed : null, style]}
    >
      <StoneText tone={tone} size={13} bold align="center">
        {label}
      </StoneText>
    </Pressable>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Player identity                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The pip dots.
 *
 * One dot for player one, two for player two, and so on. They are not decoration and they are not
 * removable: they are the half of player identity that survives a colour-blind palette, a greyscale
 * screenshot, and a cheap screen in direct sunlight. Colour and count, always both.
 */
export function Pips({ count, color, size = 6 }: { count: number; color: string; size?: number }): ReactNode {
  const dots: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    dots.push(
      <View
        key={i}
        style={{
          width: size,
          height: size,
          marginRight: 3,
          backgroundColor: color,
          borderWidth: 1,
          borderColor: Palette.ink,
        }}
      />,
    );
  }
  return <View style={styles.pips}>{dots}</View>;
}

/** A thin mortar line. Used to divide a list without drawing a box around every row. */
export function Mortar({ style }: { style?: StyleProp<ViewStyle> }): ReactNode {
  return <View style={[styles.mortar, style]} />;
}

/* ---------------------------------------------------------------------------------------------- */

const WEIGHTS: Record<ChunkWeight, ViewStyle> = {
  gold: { backgroundColor: Palette.stone, borderColor: Palette.gold },
  stone: { backgroundColor: Palette.stone, borderColor: Palette.stoneLit },
  grey: { backgroundColor: Palette.crypt, borderColor: Palette.ash },
  danger: { backgroundColor: Palette.stone, borderColor: Palette.crimson },
};

const styles = StyleSheet.create({
  cobbleOuter: {
    flex: 1,
    backgroundColor: Palette.ink,
    borderWidth: Grid / 2,
    borderColor: Palette.stone,
  },
  cobbleInner: {
    flex: 1,
    backgroundColor: Palette.crypt,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
  },
  slabSunken: {
    backgroundColor: "#16141F",
    borderWidth: 2,
    borderColor: Palette.ink,
    padding: Grid,
  },
  slabRaised: {
    backgroundColor: Palette.stone,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
    padding: Grid,
  },
  header: {
    paddingVertical: Grid,
    paddingHorizontal: Grid,
    backgroundColor: Palette.stone,
    borderBottomWidth: 2,
    borderBottomColor: Palette.ink,
  },
  headerSub: {
    marginTop: 2,
  },
  chunkBase: {
    borderWidth: 2,
    paddingVertical: Grid + 2,
    paddingHorizontal: Grid * 2,
    minHeight: 44,
    justifyContent: "center",
  },
  chunkPressed: {
    backgroundColor: Palette.stoneLit,
  },
  chunkDisabled: {
    backgroundColor: Palette.crypt,
    borderColor: Palette.stone,
  },
  pips: {
    flexDirection: "row",
    alignItems: "center",
  },
  mortar: {
    height: 2,
    backgroundColor: Palette.ink,
  },
});
