/**
 * The badge collection. Fifty things to chase, and which of them you have.
 *
 * THE RULE THIS FILE OBEYS: IT DOES NOT DECIDE ANYTHING
 *
 * Same rule as stage select and character select. Nothing here works out whether a badge is earned, what
 * it asks for, or what it is called — the catalog and the unlock layer answer all three, and this file
 * turns their answers into rows. That is what stops the classic collection-screen bug: a screen that
 * counts one thing while the save holds another, so a player sees 31/50 here and 30/50 on the results
 * screen after the same run.
 *
 * WHY IT DOES NOT HAND ANYTHING OUT
 *
 * Opening a list must never change a profile. Badges are granted in exactly one place — the moment a run
 * is banked — and a screen that also swept would be a second place for the same decision to be made
 * slightly differently. It would also be the obvious way to grant a run badge with no run in hand, which
 * is the one mistake this whole feature is arranged to prevent.
 *
 * WHY LOCKED ROWS STAY VISIBLE, AND WHY ONE OF THEM DOES NOT
 *
 * A locked badge says exactly what it wants, because a target you cannot read is not a target. The single
 * exception is the hidden one, which shows as "???" until it is earned: the only thing it would tell you
 * is how the game ends. The catalog decides which those are, not this file.
 *
 * FIDELITY: badges are cells out of the shared sheet, a family of rows to a cell. Fifty individually
 * drawn badges is a Phase 7 job; the layout does not move when they arrive.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Sprite } from "@/components/sprite";
import { Chunk, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import {
  ACHIEVEMENT_TYPES,
  achievementHeld,
  achievementLine,
  achievementName,
  achievementsHeld,
} from "@/game/unlocks/achievements";
import { useSettings } from "@/hooks/use-settings";

/** Which rows the list is showing. Not stored: a filter that survives the app being closed is a bug report. */
const SHOW = {
  all: 0,
  earned: 1,
  locked: 2,
} as const;

type ShowMode = (typeof SHOW)[keyof typeof SHOW];

export default function AchievementScreen(): ReactNode {
  const router = useRouter();
  const { save, loadFailed } = useSettings();
  const [show, setShow] = useState<ShowMode>(SHOW.all);

  const held = achievementsHeld(save);

  // The rows to draw, as indices — the index is the row's identity everywhere else in the game, so the
  // list never carries a copy of a row that could drift from the catalog.
  const rows = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < ACHIEVEMENT_TYPES.length; i++) {
      const earned = achievementHeld(save, i);
      if (show === SHOW.earned && !earned) continue;
      if (show === SHOW.locked && earned) continue;
      out.push(i);
    }
    return out;
  }, [save, show]);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <Slab style={styles.top}>
        <StoneText tone="bone" size={16} bold>
          BADGES
        </StoneText>
        <StoneText tone={held === 0 ? "ash" : "gold"} size={12} bold>
          {`${held}/${ACHIEVEMENT_TYPES.length}`}
        </StoneText>
      </Slab>

      {loadFailed ? (
        <StoneText tone="crimson" size={10} bold align="center">
          YOUR SAVE COULD NOT BE READ, SO NOTHING HERE IS TICKED OFF.
        </StoneText>
      ) : null}

      <View style={styles.filters}>
        <Chunk
          label="ALL"
          weight={show === SHOW.all ? "gold" : "stone"}
          style={styles.filter}
          onPress={() => setShow(SHOW.all)}
        />
        <Chunk
          label="EARNED"
          weight={show === SHOW.earned ? "gold" : "stone"}
          style={styles.filter}
          onPress={() => setShow(SHOW.earned)}
        />
        <Chunk
          label="LOCKED"
          weight={show === SHOW.locked ? "gold" : "stone"}
          style={styles.filter}
          onPress={() => setShow(SHOW.locked)}
        />
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator>
        {rows.length === 0 ? (
          <StoneText tone="ash" size={11} align="center">
            {show === SHOW.earned ? "Nothing earned yet. Go and play." : "Every badge is earned."}
          </StoneText>
        ) : null}

        {rows.map((index) => {
          const row = ACHIEVEMENT_TYPES[index];
          const earned = achievementHeld(save, index);
          return (
            <Slab key={row.id} raised={earned} style={styles.row}>
              {/* A locked badge is dimmed rather than hidden. The padlock the sheet carries is nearly
                  invisible against this background at this size, and a full-brightness badge on a row you
                  have not earned reads as earned. */}
              <View style={[styles.badge, earned ? styles.badgeEarned : styles.badgeLocked]}>
                <Sprite name={row.icon} size={Grid * 6} />
              </View>

              <View style={styles.rowText}>
                <StoneText tone={earned ? "gold" : "ash"} size={12} bold>
                  {achievementName(save, index).toUpperCase()}
                </StoneText>
                <StoneText tone={earned ? "bone" : "ash"} size={10}>
                  {achievementLine(save, index)}
                </StoneText>
              </View>
            </Slab>
          );
        })}
      </ScrollView>

      <Chunk label="BACK" weight="stone" style={styles.back} onPress={() => router.back()} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Palette.crypt,
    paddingHorizontal: Grid * 2,
    gap: Grid,
  },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: Grid,
    paddingHorizontal: Grid * 1.5,
    marginTop: Grid,
  },
  filters: {
    flexDirection: "row",
    gap: Grid,
  },
  filter: {
    flex: 1,
  },
  list: {
    gap: Grid,
    paddingBottom: Grid * 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid,
    padding: Grid,
  },
  badge: {
    width: Grid * 7,
    height: Grid * 7,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeEarned: {
    borderColor: Palette.gold,
  },
  badgeLocked: {
    opacity: 0.3,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  back: {
    marginBottom: Grid,
  },
});
