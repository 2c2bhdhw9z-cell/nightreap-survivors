/**
 * The title screen. The first thing anybody sees when they open the game.
 *
 * Until now this slot held the dev launcher — a list of benchmarks and leak harnesses — which meant the
 * first impression of the game was an instrument panel. The launcher still exists and is still two taps
 * away; it is just not the front door any more.
 *
 * WHAT IS ON IT, AND WHY THAT AND NOTHING ELSE
 *
 * One gold button and three stone ones. PLAY is the only thing most people will ever press and it is the
 * only thing drawn in the currency colour, at the size a thumb finds without aiming. Characters,
 * PowerUps and Badges are the screens you visit between runs. Settings is where everything else lives, including
 * How to play and backing your profile up — those used to be loose buttons here, and a title screen with
 * six equal buttons on it is a menu, not a title screen.
 *
 * THE HIDDEN WAY IN
 *
 * Seven taps on the version line at the bottom opens the dev launcher. Seven because nobody reaches it by
 * accident, and the count resets if you stop tapping for two seconds so a fidget cannot get there either.
 * It is deliberately not a button: a "DEV" button on a shipped title screen is the sort of thing that
 * gets a build rejected, and it invites a player to press it and then report what it does as a bug.
 *
 * NOTHING HERE READS THE SAVE
 *
 * On purpose. A title screen that waits for storage before it can draw its own buttons is a title screen
 * that hangs on a phone with a slow disk, and PLAY works identically whether or not a save exists — a
 * brand new profile and a loaded one take the same path into a run.
 */

import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Chunk, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import appJson from "@/app.json";

/** How many taps on the version line open the dev launcher, and how long a run of taps stays alive. */
const DEV_TAPS = 7;

const DEV_TAP_WINDOW_MS = 2000;

const VERSION = appJson.expo.version;

export default function Title() {
  const router = useRouter();
  const taps = useRef(0);
  const lastTap = useRef(0);
  const [hint, setHint] = useState("");

  const tapVersion = useCallback(() => {
    const now = Date.now();
    // A run of taps, not a lifetime total. Stop for two seconds and the count starts again from one.
    taps.current = now - lastTap.current > DEV_TAP_WINDOW_MS ? 1 : taps.current + 1;
    lastTap.current = now;

    if (taps.current >= DEV_TAPS) {
      taps.current = 0;
      setHint("");
      router.push("/dev/launcher");
      return;
    }
    // Silent until it is nearly open, so a stray double tap gives nothing away.
    const left = DEV_TAPS - taps.current;
    setHint(left <= 3 ? `${left}` : "");
  }, [router]);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <View style={styles.crest}>
        <StoneText tone="ash" size={11} bold align="center">
          S U R V I V E   T H E
        </StoneText>
        <StoneText tone="gold" size={34} bold align="center">
          NIGHTREAP
        </StoneText>
        <StoneText tone="bone" size={15} bold align="center" style={styles.sub}>
          S U R V I V O R S
        </StoneText>
      </View>

      <View style={styles.buttons}>
        <Chunk label="PLAY" weight="gold" onPress={() => router.push("/stages")} style={styles.play} />
        <Chunk label="CHARACTERS" weight="stone" onPress={() => router.push("/characters")} />
        <Chunk label="POWERUPS" weight="stone" onPress={() => router.push("/shop")} />
        <Chunk label="BADGES" weight="stone" onPress={() => router.push("/achievements")} />
        <Chunk label="SETTINGS" weight="stone" onPress={() => router.push("/settings")} />
      </View>

      <Pressable
        onPress={tapVersion}
        // Not announced as a button. It is a line of text that happens to count taps.
        accessibilityRole="text"
        style={styles.footer}
      >
        <StoneText tone="ash" size={10} align="center">
          {`v${VERSION}${hint === "" ? "" : `  ·  ${hint}`}`}
        </StoneText>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Palette.crypt,
    paddingHorizontal: Grid * 3,
    justifyContent: "space-between",
  },
  crest: { paddingTop: Grid * 6, gap: Grid * 0.5 },
  sub: { marginTop: Grid },
  buttons: { gap: Grid * 1.5, paddingBottom: Grid * 4 },
  play: { paddingVertical: Grid * 2.5 },
  footer: { paddingVertical: Grid * 2 },
});
