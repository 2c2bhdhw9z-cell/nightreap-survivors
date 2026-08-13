/**
 * The seven reference-page icons.
 *
 * FIDELITY: these are drawn from plain views on an 8px grid. The shipped versions are atlas cells drawn
 * in Phase 4 with the rest of the art, at which point this file becomes a single sprite component and
 * every layout around it stays exactly where it is. That is the reason the icons are built to a fixed
 * square box and never size themselves from their content.
 *
 * Two of them are deliberately NOT what the approved mock drew, and both corrections are recorded
 * decisions rather than taste:
 *
 *   gem     the mock's gem is a bright cut gemstone with highlights. Ours are flatter and darker — an XP
 *           gem is a small thing seen fifty at a time on a dark floor, and a jewellery-shop gem at that
 *           size turns the floor into glitter and hides the enemies.
 *
 *   evolve  the mock drew crossed weapons. No held weapon appears anywhere in our art — not on a
 *           character sprite, not on an icon — so this is two item sockets and a star instead. The star
 *           carries "became something more" on its own.
 *
 * Colour is meaning, not decoration: cyan is experience, gold is currency and the good outcome, crimson
 * is danger, violet is arcana. An icon does not get a nice colour because it looks better.
 */

import { View, StyleSheet } from "react-native";
import { Palette, Grid } from "@/constants/theme";
import { REF_ICON } from "@/game/guide/strings";

/** The icon box. Every icon is this square, whatever is inside it. */
export const ICON_BOX = Grid * 7;

export function RefIcon({ icon, size = ICON_BOX }: { icon: number; size?: number }): React.ReactNode {
  return (
    <View style={[styles.box, { width: size, height: size }]}>
      <View style={styles.inner}>{glyph(icon)}</View>
    </View>
  );
}

function glyph(icon: number): React.ReactNode {
  switch (icon) {
    case REF_ICON.gem:
      return <Gem />;
    case REF_ICON.magnet:
      return <Magnet />;
    case REF_ICON.cards:
      return <Cards />;
    case REF_ICON.arcana:
      return <Arcana />;
    case REF_ICON.evolve:
      return <Evolve />;
    case REF_ICON.downed:
      return <Downed />;
    case REF_ICON.reaper:
      return <Reaper />;
    default:
      // An unknown icon draws an empty socket rather than nothing, so a missing case is visible in a
      // screenshot instead of silently leaving a hole in the row.
      return <View style={styles.socket} />;
  }
}

/* ---------------------------------------------------------------------------------------------- */

/** A gem: flat facets, dark body, one dull top edge. No highlight, no glow. */
function Gem(): React.ReactNode {
  return (
    <View style={styles.stack}>
      <View style={[styles.gemTop, { backgroundColor: Palette.cyan }]} />
      <View style={[styles.gemBody, { backgroundColor: "#2A7A85" }]} />
      <View style={[styles.gemTip, { backgroundColor: "#1E5A63" }]} />
    </View>
  );
}

/** A magnet: two legs, red tips. It says "range", so it is drawn wide rather than tall. */
function Magnet(): React.ReactNode {
  return (
    <View style={styles.stack}>
      <View style={styles.magnetArch} />
      <View style={styles.magnetLegs}>
        <View style={[styles.magnetTip, { backgroundColor: Palette.crimson }]} />
        <View style={styles.magnetGap} />
        <View style={[styles.magnetTip, { backgroundColor: Palette.crimson }]} />
      </View>
    </View>
  );
}

/** Three cards, fanned. Violet because a card screen is where arcana and upgrades both live. */
function Cards(): React.ReactNode {
  return (
    <View style={styles.stack}>
      <View style={[styles.card, { left: 2, backgroundColor: Palette.violet }]} />
      <View style={[styles.card, { left: 8, backgroundColor: Palette.violetLit }]} />
      <View style={[styles.card, { left: 14, backgroundColor: Palette.violet }]} />
    </View>
  );
}

/** One arcana card, face up, with the mark on it. */
function Arcana(): React.ReactNode {
  return (
    <View style={styles.arcanaCard}>
      <View style={styles.arcanaMarkV} />
      <View style={styles.arcanaMarkH} />
    </View>
  );
}

/** Two item sockets and a star. Never crossed weapons. */
function Evolve(): React.ReactNode {
  return (
    <View style={styles.stack}>
      <View style={styles.evolveRow}>
        <View style={styles.socket} />
        <View style={styles.socket} />
      </View>
      <View style={styles.starRow}>
        <View style={styles.starV} />
        <View style={styles.starH} />
      </View>
    </View>
  );
}

/** A downed figure inside a revive ring. The ring is crimson: being down is danger, not a status effect. */
function Downed(): React.ReactNode {
  return (
    <View style={styles.stack}>
      <View style={styles.downedBody} />
      <View style={styles.downedRing} />
    </View>
  );
}

/** The Reaper: a skull and the blade edge. Crimson, and the only icon allowed to be. */
function Reaper(): React.ReactNode {
  return (
    <View style={styles.stack}>
      <View style={styles.skull}>
        <View style={styles.skullEyeLeft} />
        <View style={styles.skullEyeRight} />
      </View>
      <View style={styles.blade} />
    </View>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  box: {
    backgroundColor: Palette.ink,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    width: Grid * 5,
    height: Grid * 5,
    alignItems: "center",
    justifyContent: "center",
  },
  stack: {
    width: Grid * 5,
    height: Grid * 5,
    alignItems: "center",
    justifyContent: "center",
  },
  socket: {
    width: Grid * 2,
    height: Grid * 2,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
    backgroundColor: Palette.crypt,
  },

  /* gem */
  gemTop: { width: Grid * 3, height: 4 },
  gemBody: { width: Grid * 3, height: Grid * 2 },
  gemTip: { width: Grid, height: Grid },

  /* magnet */
  magnetArch: {
    width: Grid * 4,
    height: Grid * 2,
    borderTopWidth: Grid,
    borderLeftWidth: Grid,
    borderRightWidth: Grid,
    borderColor: Palette.ash,
  },
  magnetLegs: { flexDirection: "row" },
  magnetTip: { width: Grid, height: Grid },
  magnetGap: { width: Grid * 2 },

  /* cards */
  card: {
    position: "absolute",
    top: 4,
    width: Grid * 2,
    height: Grid * 4,
    borderWidth: 1,
    borderColor: Palette.ink,
  },

  /* arcana */
  arcanaCard: {
    width: Grid * 3,
    height: Grid * 4,
    backgroundColor: Palette.violet,
    borderWidth: 1,
    borderColor: Palette.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  arcanaMarkV: { position: "absolute", width: 2, height: Grid * 2, backgroundColor: Palette.violetLit },
  arcanaMarkH: { position: "absolute", width: Grid * 2, height: 2, backgroundColor: Palette.violetLit },

  /* evolve */
  evolveRow: { flexDirection: "row", gap: 4 },
  starRow: { marginTop: 3, alignItems: "center", justifyContent: "center", width: Grid * 2, height: Grid * 2 },
  starV: { position: "absolute", width: 3, height: Grid * 2, backgroundColor: Palette.gold },
  starH: { position: "absolute", width: Grid * 2, height: 3, backgroundColor: Palette.gold },

  /* downed */
  downedBody: { width: Grid * 3, height: Grid * 2, backgroundColor: Palette.ash },
  downedRing: {
    marginTop: 2,
    width: Grid * 4,
    height: Grid,
    borderWidth: 2,
    borderColor: Palette.crimson,
    backgroundColor: "transparent",
  },

  /* reaper */
  skull: {
    width: Grid * 3,
    height: Grid * 2,
    backgroundColor: Palette.crimson,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  skullEyeLeft: { width: 3, height: 4, backgroundColor: Palette.ink },
  skullEyeRight: { width: 3, height: 4, backgroundColor: Palette.ink },
  blade: { width: Grid * 4, height: 3, marginTop: 3, backgroundColor: Palette.bone },
});
