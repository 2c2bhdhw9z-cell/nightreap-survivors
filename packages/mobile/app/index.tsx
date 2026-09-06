/**
 * The title screen. The first thing anybody sees when they open the game.
 *
 * THE ART IS A PICTURE NOW
 *
 * The whole background is one painted image that you supplied: the blood moon, the cathedral, the
 * graveyard, the hero in the middle of a crowd of skeletons and ghosts, and the game's name already
 * painted into the sky. Nothing here is drawn out of shapes any more, and nothing here is scaled-up
 * pixel art, so nothing here goes to mush.
 *
 * Because the name is part of the painting, this screen does not draw its own logo. Drawing a second
 * one over the top would fight it.
 *
 * The picture is taller than it is wide, and it is drawn to cover the phone whichever phone it is,
 * so on a wide phone a sliver of each edge is cropped. Everything that matters — the moon, the name,
 * the hero, the chest — sits in the middle column, so the crop never eats anything.
 *
 * It also breathes: a very slow push-in and pull-out, six percent over forty seconds. Too slow to
 * notice as motion, fast enough that the screen never feels like a dead screenshot. It runs on the
 * phone's animation chip, not the game's, so it costs nothing.
 *
 * WHAT SITS ON TOP OF IT, AND WHY THAT AND NOTHING ELSE
 *
 * Your gold and your runs survived sit in the top corners, because that is where a player of any
 * mobile game already looks for them, and the corners of the painting are empty sky. One gold PLAY
 * button owns the bottom, filled rather than outlined and breathing very slightly, so on a shelf in
 * a shop it is still the thing your eye lands on. Characters, PowerUps and Badges are the screens
 * you visit between runs, so they are stone and half-width. Settings holds everything else,
 * including How to play and backing your profile up.
 *
 * Two shadow washes, one at the top and one at the bottom, sit between the picture and the buttons.
 * They are what keeps small text readable no matter how busy the painting gets underneath it.
 *
 * THE TOP CORNERS DO NOT HOLD THE SCREEN UP
 *
 * The save is read after the screen is already on. The chips show a dash until it arrives. A title
 * screen that waits for storage before it can draw its own buttons is a title screen that hangs on a
 * cheap phone, and PLAY works identically whether or not a save exists.
 *
 * THE HIDDEN WAY IN
 *
 * Seven taps on the version line opens the dev launcher. Seven because nobody reaches it by accident,
 * and the count resets after two seconds of no tapping so a fidget cannot get there either.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";

import { Chunk, StoneText } from "@/components/stone";
import { useSettings } from "@/hooks/use-settings";
import { Grid, Palette } from "@/constants/theme";
import appJson from "@/app.json";

/** How many taps on the version line open the dev launcher, and how long a run of taps stays alive. */
const DEV_TAPS = 7;

const DEV_TAP_WINDOW_MS = 2000;

const VERSION = appJson.expo.version;

/** One half of the slow push-in, in milliseconds. Forty seconds for the full in-and-out. */
const DRIFT_MS = 20000;

/** How far the push-in goes. Six percent: felt, not seen. */
const DRIFT_SCALE = 1.06;

const TITLE_ART = require("@/assets/title-bg.jpg") as number;

/* ------------------------------------------------------------------------------------------------ */
/* The painting                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The background picture, very slowly breathing.
 *
 * It is deliberately started a touch zoomed in rather than at its true size, so that the pull-out
 * never exposes an edge on a phone whose shape does not match the picture's.
 */
function Backdrop(): React.ReactNode {
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: DRIFT_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: DRIFT_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift]);

  const scale = drift.interpolate({ inputRange: [0, 1], outputRange: [1, DRIFT_SCALE] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ scale }] }]} pointerEvents="none">
      <Image source={TITLE_ART} style={styles.art} resizeMode="cover" accessible={false} />
    </Animated.View>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Furniture                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/** A top-corner chip: an icon shape, then a number. Shows a dash until the save has loaded. */
function Chip({
  value,
  icon,
  tint,
  align,
}: {
  value: string;
  icon: "coin" | "skull";
  tint: string;
  align: "left" | "right";
}): React.ReactNode {
  return (
    <View style={[styles.chip, align === "right" ? styles.chipRight : null]}>
      {icon === "coin" ? (
        <View style={[styles.coin, { borderColor: tint }]} />
      ) : (
        <View style={[styles.skull, { backgroundColor: tint }]} />
      )}
      <Text style={[styles.chipText, { color: tint }]}>{value}</Text>
    </View>
  );
}

/**
 * The one button that matters.
 *
 * Filled gold rather than outlined, because on a shop shelf the outlined version disappears. It breathes
 * — a slow, small pulse, three percent either side — which is enough to pull an eye without being the
 * kind of animation that makes a screen feel cheap.
 */
function PlayButton({ onPress }: { onPress: () => void }): React.ReactNode {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.playOuter, pressed ? styles.playPressed : null]}
      >
        <LinearGradient
          colors={["#FBE49A", "#F0B93C", "#C4841B"]}
          locations={[0, 0.5, 1]}
          style={styles.playFill}
        >
          <Text style={styles.playLabel}>PLAY</Text>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export default function Title() {
  const router = useRouter();
  const { ready, save } = useSettings();
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
    <View style={styles.stage}>
      <Backdrop />

      <LinearGradient
        colors={["rgba(4,3,9,0.72)", "rgba(4,3,9,0.18)", "rgba(4,3,9,0)"]}
        locations={[0, 0.55, 1]}
        style={styles.topWash}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["rgba(4,3,9,0)", "rgba(4,3,9,0.42)", "rgba(4,3,9,0.82)"]}
        locations={[0, 0.5, 0.9]}
        style={styles.bottomWash}
        pointerEvents="none"
      />

      <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
        <View style={styles.chipRow}>
          <Chip value={ready ? String(save.gold) : "—"} icon="coin" tint={Palette.goldLit} align="left" />
          <Chip value={ready ? String(save.runsCompleted) : "—"} icon="skull" tint={Palette.bone} align="right" />
        </View>

        <View style={styles.buttons}>
          <PlayButton onPress={() => router.push("/stages")} />
          <View style={styles.row}>
            <Chunk
              label="CHARACTERS"
              weight="stone"
              onPress={() => router.push("/characters")}
              style={styles.half}
            />
            <Chunk label="POWERUPS" weight="stone" onPress={() => router.push("/shop")} style={styles.half} />
          </View>
          <View style={styles.row}>
            <Chunk
              label="BADGES"
              weight="stone"
              onPress={() => router.push("/achievements")}
              style={styles.half}
            />
            <Chunk label="SETTINGS" weight="stone" onPress={() => router.push("/settings")} style={styles.half} />
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
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: Palette.ink, overflow: "hidden" },
  art: { width: "100%", height: "100%" },

  /* --- washes ----------------------------------------------------------- */
  topWash: { position: "absolute", left: 0, right: 0, top: 0, height: "12%" },
  bottomWash: { position: "absolute", left: 0, right: 0, bottom: 0, height: "46%" },

  /* --- content ---------------------------------------------------------- */
  screen: { flex: 1, paddingHorizontal: Grid * 2.5, justifyContent: "space-between" },
  chipRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: Grid },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid * 0.75,
    paddingVertical: Grid * 0.5,
    paddingHorizontal: Grid,
    backgroundColor: "rgba(11,10,16,0.72)",
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    minWidth: 74,
  },
  chipRight: { justifyContent: "flex-end" },
  chipText: { fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  coin: { width: 11, height: 11, borderRadius: 6, borderWidth: 3 },
  skull: { width: 10, height: 11, borderRadius: 3, opacity: 0.85 },

  buttons: { gap: Grid * 1.5, paddingBottom: Grid * 2 },
  playOuter: {
    borderWidth: 2,
    borderColor: "#5C3A08",
    shadowColor: "#F7D774",
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  playPressed: { opacity: 0.85 },
  playFill: { paddingVertical: Grid * 2.25, alignItems: "center", justifyContent: "center" },
  playLabel: { color: "#1A1006", fontSize: 20, fontWeight: "900", letterSpacing: 6 },
  row: { flexDirection: "row", gap: Grid * 1.5 },
  half: { flex: 1 },
  footer: { paddingVertical: Grid * 1.25 },
});
