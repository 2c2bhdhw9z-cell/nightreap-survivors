import { Platform } from "react-native";

/**
 * Nightreap Survivors colour tokens. Values come from `design.md` — that file is the
 * source of truth; this is the mobile mapping onto the template's token names.
 *
 * The game is DARK ONLY. A light-mode gothic pixel game is not a thing, so
 * `Colors.light` and `Colors.dark` hold identical values. That way `app.json` can keep
 * `userInterfaceStyle: "automatic"` untouched (it is template-managed) while the app
 * never changes appearance with the system setting.
 *
 * Accents are meaning-bound. Do not reuse them decoratively:
 *   gold = currency, crimson = damage/danger, cyan = XP/level-up,
 *   violet = arcana/evolution, venom = healing/buffs.
 */

/** The locked palette. Every sprite, panel, and glyph draws from this list. */
export const Palette = {
  ink: "#0B0A10",
  crypt: "#141320",
  stone: "#232132",
  stoneLit: "#3A3550",
  ash: "#6B6480",
  bone: "#C8BFA6",
  boneLit: "#EFE6CE",

  gold: "#E0A62B",
  goldLit: "#F7D774",
  crimson: "#B02033",
  crimsonLit: "#E8455A",
  cyan: "#3FB8C4",
  cyanLit: "#7BE8EE",
  violet: "#7A4FA8",
  violetLit: "#B27FE0",
  venom: "#5C9E45",
  rust: "#8A4B2A",
} as const;

/**
 * Co-op player identity. Always paired with a pip count in the UI so identity
 * survives a colourblind palette and a greyscale screenshot.
 */
export const PlayerColors = [
  { color: Palette.crimsonLit, pips: 1 },
  { color: Palette.cyanLit, pips: 2 },
  { color: Palette.goldLit, pips: 3 },
  { color: Palette.violetLit, pips: 4 },
] as const;

const tokens = {
  background: Palette.crypt,
  foreground: Palette.boneLit,
  card: Palette.stone,
  cardForeground: Palette.bone,
  primary: Palette.gold,
  primaryForeground: Palette.ink,
  secondary: Palette.stoneLit,
  secondaryForeground: Palette.boneLit,
  muted: Palette.stone,
  mutedForeground: Palette.ash,
  accent: Palette.violet,
  accentForeground: Palette.boneLit,
  border: Palette.stoneLit,
  destructive: Palette.crimson,
  success: Palette.venom,
  warning: Palette.gold,
} as const;

export const Colors = {
  light: tokens,
  dark: tokens,
} as const;

export type ColorScheme = keyof typeof Colors;
export type ThemeColors = (typeof Colors)[ColorScheme];

/** 8px base grid — every edge, gap, and inset is a multiple of this. */
export const Grid = 8;

/**
 * Font families.
 *
 * FIDELITY: this is scaffolding only. Real text renders from `NightreapGlyph`, our own
 * bitmap glyphs drawn into the sprite atlas (6×8 small, 10×12 display) — no licensed
 * font file ever ships. Until the atlas lands, RN screens use platform monospace so
 * layout can be built. Every such use is marked `// FIDELITY:` and CI greps for it.
 */
export const Fonts = Platform.select({
  ios: {
    sans: "system-ui",
    serif: "ui-serif",
    rounded: "ui-rounded",
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', sans-serif",
    mono: "'SF Mono', 'Roboto Mono', monospace",
  },
});
