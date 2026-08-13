/**
 * Settings -> How to play.
 *
 * Two things live here and they are different things:
 *
 *   START A GUIDED RUN   arms the prompts for the next run. A switch, not a mode — nothing it writes ever
 *                        reaches the simulation, so a guided run is a real run and stays legal on every
 *                        leaderboard. It reads as a button because that is what the player is asking for
 *                        ("teach me next time"), and it says out loud which way it is currently set,
 *                        because a control that only shows its own label is a control people press twice.
 *
 *   WHAT THINGS MEAN     the reference list. Definitions, always reachable, no arming, no state. The
 *                        player most likely to need it is the one who declined the guide at first launch.
 *
 * Built from the approved mock `mocks/screen-what-things-mean-v1`. The rows come from the guide's own
 * reference table rather than being retyped here, so the page cannot drift from the thing it documents,
 * and the revive row is dropped in a solo game by the table's own rule rather than by a condition in this
 * file. Every word is a string id.
 *
 * The one write on this page goes straight to the save and is read back and verified by the save layer
 * before it counts. If it fails the label goes back to what it was and says so, because a settings screen
 * that shows a choice it did not manage to store is how players learn not to trust settings.
 */

import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Palette, Grid } from "@/constants/theme";
import { Chunk, Header, Mortar, Slab, StoneText } from "@/components/stone";
import { RefIcon } from "@/components/ref-icon";
import { EN, STR, text, referenceRowsFor } from "@/game/guide/strings";
import { armGuide, disarmGuide } from "@/game/guide/arming";
import { saveStore, useSettings } from "@/hooks/use-settings";

export default function HowToPlay(): React.ReactNode {
  const router = useRouter();
  const { ready, save, stored } = useSettings();
  const [armed, setArmed] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  // The switch shows the pending value while a write is in flight, and the stored value otherwise.
  const on = armed ?? stored.guideArmed;

  const toggle = useCallback(() => {
    const next = !on;
    const before = on;
    setArmed(next);
    setFailed(false);
    if (next) armGuide(save);
    else disarmGuide(save);
    void (async () => {
      const result = await saveStore().save(save);
      if (result.ok) return;
      // Put the save object back the way it was as well as the label — the next screen to read it must
      // not see a choice that was never stored.
      if (before) armGuide(save);
      else disarmGuide(save);
      setArmed(before);
      setFailed(true);
    })();
  }, [on, save]);

  const rows = referenceRowsFor(1);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <View style={styles.top}>
        <Chunk label="<" weight="stone" style={styles.back} onPress={() => router.back()} />
        <View style={styles.title}>
          <Header title={text(STR.howToPlayTitle, EN)} />
        </View>
      </View>

      <View style={styles.armBlock}>
        <Chunk
          label={text(STR.startGuidedRun, EN)}
          weight={on ? "gold" : "stone"}
          disabled={!ready}
          onPress={toggle}
        />
        <StoneText tone={on ? "gold" : "ash"} size={10} align="center">
          {text(on ? STR.guidedRunArmed : STR.guidedRunDisarmed, EN)}
        </StoneText>
        {failed ? (
          <StoneText tone="crimson" size={10} align="center">
            COULD NOT SAVE THAT. TRY AGAIN.
          </StoneText>
        ) : null}
      </View>

      <Mortar />

      <StoneText tone="ash" size={11} bold style={styles.sectionLabel}>
        {text(STR.whatThingsMean, EN)}
      </StoneText>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator>
        {rows.map((row) => (
          <Slab key={row.title} raised style={styles.row}>
            <RefIcon icon={row.icon} />
            <View style={styles.rowText}>
              <StoneText tone="bone" size={15} bold>
                {text(row.title, EN)}
              </StoneText>
              <StoneText tone="ash" size={11}>
                {text(row.body, EN)}
              </StoneText>
            </View>
          </Slab>
        ))}
      </ScrollView>
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
    gap: Grid,
    paddingTop: Grid,
  },
  back: {
    width: Grid * 6,
  },
  title: {
    flex: 1,
  },
  armBlock: {
    gap: Grid / 2,
    paddingBottom: Grid,
  },
  sectionLabel: {
    paddingTop: Grid,
  },
  list: {
    gap: Grid,
    paddingBottom: Grid * 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid * 1.5,
    padding: Grid * 1.5,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
});
