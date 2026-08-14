/**
 * The title screen. The first thing anybody sees when they open the game.
 *
 * WHY IT LOOKS LIKE THIS
 *
 * A title screen has one job: make somebody want to press PLAY. Every other screen in this game is a
 * quiet stone menu that gets out of the way. This one is a picture first and a menu second.
 *
 * The picture is not a picture file. Every part of it is drawn by the phone out of plain shapes and
 * colour fades — a sky, a blood moon, a bank of hills, a graveyard of leaning stones and crosses, three
 * layers of fog and a drift of embers. That matters for two reasons. It weighs nothing, so the game
 * opens instantly and the download stays small. And it can never go blurry: a real picture has to be
 * stretched to fit a phone and stretching is what turned the old reaper to mush. Shapes redraw sharp at
 * any size, on any screen, forever.
 *
 * It is built in layers, back to front, exactly like a stage set:
 *   1. the night sky, deepest at the top
 *   2. the moon's halo, then the moon itself, low and huge behind the title
 *   3. far hills, almost black
 *   4. the graveyard: stones, crosses and a dead tree, pure silhouette
 *   5. three fog banks creeping across the ground at different speeds
 *   6. embers drifting up the whole screen
 *   7. a wash of shadow top and bottom, so text always has dark behind it
 *   8. the title and the buttons
 *
 * Nothing in the scenery reacts to a touch — you can press straight through all of it.
 *
 * THE WORDMARK
 *
 * The word is drawn four times on top of itself — black, deep red, then gold — each a couple of pixels
 * apart. That is the old trick for carved metal lettering and it costs nothing.
 *
 * WHAT IS ON IT, AND WHY THAT AND NOTHING ELSE
 *
 * One gold button and four stone ones. PLAY is the only thing most people will ever press, so it is the
 * only thing in the currency colour, at the size a thumb finds without aiming. Characters, PowerUps and
 * Badges are the screens you visit between runs. Settings holds everything else, including How to play
 * and backing your profile up.
 *
 * THE HIDDEN WAY IN
 *
 * Seven taps on the version line opens the dev launcher. Seven because nobody reaches it by accident,
 * and the count resets after two seconds of no tapping so a fidget cannot get there either.
 *
 * NOTHING HERE READS THE SAVE
 *
 * On purpose. A title screen that waits for storage before it can draw its own buttons is a title screen
 * that hangs on a slow phone, and PLAY works the same whether or not a save exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DimensionValue } from "react-native";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";

import { Chunk, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import appJson from "@/app.json";

/** How many taps on the version line open the dev launcher, and how long a run of taps stays alive. */
const DEV_TAPS = 7;

const DEV_TAP_WINDOW_MS = 2000;

const VERSION = appJson.expo.version;

/** How many embers drift up the screen at once, and how long the slowest one takes to cross it. */
const EMBER_COUNT = 14;

const EMBER_RISE_MS = 7000;

const EMBER_SPREAD_MS = 5000;

const EMBER_TRAVEL = 620;

/** How long the slowest fog bank takes to cross the screen once. */
const FOG_DRIFT_MS = 26000;

/** The moon sits low and huge so the title reads against it. */
const MOON_SIZE = 210;

/** One drifting ember: where it sits across the screen, how big it is, how fast it climbs, when it starts. */
type Ember = {
  readonly left: DimensionValue;
  readonly size: number;
  readonly rise: number;
  readonly delay: number;
  readonly drift: number;
};

function buildEmbers(): readonly Ember[] {
  const out: Ember[] = [];
  for (let i = 0; i < EMBER_COUNT; i += 1) {
    // Spread by hand rather than at random so the pattern is the same every launch and never clumps.
    const t = i / EMBER_COUNT;
    out.push({
      left: `${5 + ((i * 31) % 90)}%` as DimensionValue,
      size: 2 + (i % 3),
      rise: EMBER_RISE_MS + Math.round(t * EMBER_SPREAD_MS),
      delay: Math.round(t * EMBER_RISE_MS),
      drift: i % 2 === 0 ? 20 : -20,
    });
  }
  return out;
}

/** One grave marker: how far across the screen it stands, how big it is, and how far it leans. */
type Marker = {
  readonly left: DimensionValue;
  readonly width: number;
  readonly height: number;
  readonly lean: string;
  readonly cross: boolean;
};

const MARKERS: readonly Marker[] = [
  { left: "3%", width: 20, height: 42, lean: "-6deg", cross: false },
  { left: "13%", width: 14, height: 30, lean: "4deg", cross: true },
  { left: "22%", width: 24, height: 54, lean: "2deg", cross: false },
  { left: "33%", width: 16, height: 34, lean: "-9deg", cross: false },
  { left: "43%", width: 13, height: 26, lean: "6deg", cross: true },
  { left: "56%", width: 22, height: 48, lean: "-3deg", cross: false },
  { left: "67%", width: 15, height: 32, lean: "8deg", cross: false },
  { left: "76%", width: 13, height: 27, lean: "-5deg", cross: true },
  { left: "86%", width: 26, height: 58, lean: "3deg", cross: false },
  { left: "95%", width: 15, height: 33, lean: "-7deg", cross: false },
];

/** The sky, the moon and its halo. Everything here is a fade or a circle. */
function Sky(): React.ReactNode {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={["#05040A", "#160B1E", "#33122A", "#4A1826"]}
        locations={[0, 0.34, 0.6, 0.78]}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.moonWrap}>
        <View style={styles.moonHaloFar} />
        <View style={styles.moonHaloNear} />
        <View style={styles.moon}>
          <LinearGradient
            colors={["#F0A88A", "#D8523F", "#8E1D22"]}
            locations={[0, 0.5, 1]}
            style={styles.moonFace}
          />
          <View style={[styles.crater, styles.craterOne]} />
          <View style={[styles.crater, styles.craterTwo]} />
          <View style={[styles.crater, styles.craterThree]} />
        </View>
      </View>
    </View>
  );
}

/** The far hills: two almost-black humps that give the moon something to sit behind. */
function Hills(): React.ReactNode {
  return (
    <View pointerEvents="none" style={styles.hillLayer}>
      <View style={[styles.hill, styles.hillLeft]} />
      <View style={[styles.hill, styles.hillRight]} />
      <View style={styles.spire} />
      <View style={styles.spireRoof} />
    </View>
  );
}

/** The graveyard in the foreground: leaning stones, crosses and one dead tree, all pure silhouette. */
function Graveyard(): React.ReactNode {
  return (
    <View pointerEvents="none" style={styles.graveLayer}>
      <View style={styles.ground} />
      {MARKERS.map((marker) => (
        <View
          key={String(marker.left)}
          style={[
            styles.marker,
            {
              left: marker.left,
              width: marker.width,
              height: marker.height,
              borderTopLeftRadius: marker.cross ? 0 : marker.width / 2,
              borderTopRightRadius: marker.cross ? 0 : marker.width / 2,
              transform: [{ rotate: marker.lean }],
            },
          ]}
        >
          {marker.cross ? <View style={[styles.crossArm, { width: marker.width * 2.1 }]} /> : null}
        </View>
      ))}
      <View style={styles.trunk} />
      <View style={[styles.branch, styles.branchLeft]} />
      <View style={[styles.branch, styles.branchRight]} />
    </View>
  );
}

/** Three banks of fog creeping sideways at different speeds, so the ground is never still. */
function Fog(): React.ReactNode {
  const values = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const loops = values.map((value, i) =>
      Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration: FOG_DRIFT_MS + i * 9000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [values]);

  return (
    <View pointerEvents="none" style={styles.fogLayer}>
      {values.map((value, i) => (
        <Animated.View
          key={String(i)}
          style={[
            styles.fogBand,
            {
              bottom: Grid * (2 + i * 3),
              height: 26 + i * 14,
              opacity: 0.16 - i * 0.03,
              transform: [
                {
                  translateX: value.interpolate({
                    inputRange: [0, 1],
                    outputRange: i % 2 === 0 ? [-160, 160] : [160, -160],
                  }),
                },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={["rgba(200,191,166,0)", "rgba(200,191,166,1)", "rgba(200,191,166,0)"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ))}
    </View>
  );
}

function Embers(): React.ReactNode {
  const embers = useMemo(buildEmbers, []);
  const values = useRef(embers.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = values.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(embers[i]?.delay ?? 0),
          Animated.timing(value, {
            toValue: 1,
            duration: embers[i]?.rise ?? EMBER_RISE_MS,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [embers, values]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {embers.map((ember, i) => {
        const value = values[i] as Animated.Value;
        return (
          <Animated.View
            key={String(ember.left) + String(i)}
            style={[
              styles.ember,
              {
                left: ember.left,
                width: ember.size,
                height: ember.size,
                opacity: value.interpolate({ inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 0.9, 0.45, 0] }),
                transform: [
                  { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -EMBER_TRAVEL] }) },
                  { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [0, ember.drift] }) },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

/** The carved wordmark: the same word stacked on itself in black, red and gold. */
function Wordmark(): React.ReactNode {
  return (
    <View style={styles.wordmark}>
      <Text style={[styles.word, styles.wordShadow]}>NIGHTREAP</Text>
      <Text style={[styles.word, styles.wordBlood]}>NIGHTREAP</Text>
      <Text style={[styles.word, styles.wordGold]}>NIGHTREAP</Text>
    </View>
  );
}

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
    <View style={styles.art}>
      <Sky />
      <Hills />
      <Graveyard />
      <Fog />
      <Embers />

      <LinearGradient
        colors={["rgba(5,4,10,0.95)", "rgba(5,4,10,0.35)", "rgba(5,4,10,0)"]}
        locations={[0, 0.42, 0.68]}
        style={styles.topWash}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["rgba(5,4,10,0)", "rgba(5,4,10,0.78)", "rgba(5,4,10,0.98)"]}
        locations={[0, 0.42, 0.74]}
        style={styles.bottomWash}
        pointerEvents="none"
      />

      <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
        <View style={styles.crest}>
          <StoneText tone="ash" size={11} bold align="center">
            S U R V I V E   T H E
          </StoneText>
          <Wordmark />
          <View style={styles.ruleRow}>
            <View style={styles.rule} />
            <StoneText tone="bone" size={13} bold align="center" style={styles.sub}>
              S U R V I V O R S
            </StoneText>
            <View style={styles.rule} />
          </View>
        </View>

        <View style={styles.buttons}>
          <Chunk label="PLAY" weight="gold" onPress={() => router.push("/stages")} style={styles.play} />
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
  art: { flex: 1, backgroundColor: Palette.ink, overflow: "hidden" },

  // --- sky and moon -------------------------------------------------------
  moonWrap: { position: "absolute", top: "26%", left: 0, right: 0, alignItems: "center" },
  moonHaloFar: {
    position: "absolute",
    width: MOON_SIZE * 2.2,
    height: MOON_SIZE * 2.2,
    borderRadius: MOON_SIZE * 1.1,
    top: -MOON_SIZE * 0.6,
    backgroundColor: "#B02033",
    opacity: 0.1,
  },
  moonHaloNear: {
    position: "absolute",
    width: MOON_SIZE * 1.45,
    height: MOON_SIZE * 1.45,
    borderRadius: MOON_SIZE * 0.725,
    top: -MOON_SIZE * 0.22,
    backgroundColor: "#E8455A",
    opacity: 0.14,
  },
  moon: {
    width: MOON_SIZE,
    height: MOON_SIZE,
    borderRadius: MOON_SIZE / 2,
    overflow: "hidden",
  },
  moonFace: { flex: 1 },
  crater: { position: "absolute", borderRadius: 40, backgroundColor: "#7A1B22", opacity: 0.4 },
  craterOne: { width: 44, height: 44, top: 38, left: 40 },
  craterTwo: { width: 26, height: 26, top: 104, left: 118 },
  craterThree: { width: 18, height: 18, top: 62, left: 132 },

  // --- far hills and the belfry spire --------------------------------------
  hillLayer: { position: "absolute", left: 0, right: 0, bottom: 0, height: "42%" },
  hill: { position: "absolute", backgroundColor: "#0C0812", opacity: 0.96 },
  hillLeft: { left: "-25%", bottom: "34%", width: "95%", height: 190, borderTopRightRadius: 300, borderTopLeftRadius: 200 },
  hillRight: { right: "-30%", bottom: "34%", width: "100%", height: 150, borderTopLeftRadius: 320, borderTopRightRadius: 180 },
  spire: {
    position: "absolute",
    left: "72%",
    bottom: "40%",
    width: 26,
    height: 96,
    backgroundColor: "#08060E",
  },
  spireRoof: {
    position: "absolute",
    left: "72%",
    bottom: "40%",
    marginBottom: 96,
    marginLeft: -9,
    width: 0,
    height: 0,
    borderLeftWidth: 22,
    borderRightWidth: 22,
    borderBottomWidth: 54,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "#08060E",
  },

  // --- graveyard -----------------------------------------------------------
  graveLayer: { position: "absolute", left: 0, right: 0, bottom: 0, height: "30%" },
  ground: { position: "absolute", left: 0, right: 0, bottom: 0, height: "58%", backgroundColor: "#050409" },
  marker: { position: "absolute", bottom: "56%", backgroundColor: "#050409" },
  crossArm: { position: "absolute", top: "26%", left: "-55%", height: 6, backgroundColor: "#050409" },
  trunk: { position: "absolute", left: "48%", bottom: "56%", width: 8, height: 86, backgroundColor: "#050409" },
  branch: { position: "absolute", left: "48%", bottom: "56%", width: 42, height: 5, backgroundColor: "#050409" },
  branchLeft: { marginBottom: 64, marginLeft: -36, transform: [{ rotate: "-28deg" }] },
  branchRight: { marginBottom: 74, marginLeft: 4, transform: [{ rotate: "26deg" }] },

  // --- fog and embers ------------------------------------------------------
  fogLayer: { position: "absolute", left: 0, right: 0, bottom: 0, height: "34%" },
  fogBand: { position: "absolute", left: "-30%", right: "-30%" },
  ember: { position: "absolute", bottom: 0, borderRadius: 2, backgroundColor: Palette.goldLit },

  // --- washes --------------------------------------------------------------
  topWash: { position: "absolute", left: 0, right: 0, top: 0, height: "34%" },
  bottomWash: { position: "absolute", left: 0, right: 0, bottom: 0, height: "52%" },

  // --- foreground content --------------------------------------------------
  screen: {
    flex: 1,
    paddingHorizontal: Grid * 3,
    justifyContent: "space-between",
  },
  crest: { paddingTop: Grid * 5, gap: Grid * 0.5 },
  wordmark: { height: 52, justifyContent: "center" },
  word: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 42,
    fontWeight: "900",
    letterSpacing: 2,
  },
  wordShadow: { color: "#000000", top: 5 },
  wordBlood: { color: Palette.crimson, top: 2 },
  wordGold: { color: Palette.goldLit, top: 0 },
  ruleRow: { flexDirection: "row", alignItems: "center", gap: Grid, marginTop: Grid * 0.5 },
  rule: { flex: 1, height: 1, backgroundColor: Palette.gold, opacity: 0.5 },
  sub: { marginTop: 0 },
  buttons: { gap: Grid * 1.5, paddingBottom: Grid * 2 },
  row: { flexDirection: "row", gap: Grid * 1.5 },
  half: { flex: 1 },
  play: { paddingVertical: Grid * 2.5 },
  footer: { paddingVertical: Grid * 1.5 },
});
