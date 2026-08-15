/**
 * The title screen. The first thing anybody sees when they open the game.
 *
 * WHY IT LOOKS LIKE THIS
 *
 * Two games set the bar for this screen. Vampire Survivors opens on a dark gothic painting with a
 * carved gold logo and almost no furniture — it feels like an old book. Survivor.io opens on a busy
 * live-service front page — your money in the top corners, one enormous button you cannot miss, and
 * a hero standing in the middle of the art. This screen is deliberately between the two: the gothic
 * graveyard painting and gold lettering from one, the confident layout and single obvious button from
 * the other.
 *
 * NONE OF THE ART IS A PICTURE FILE
 *
 * Every part of the scene is drawn by the phone out of plain shapes and colour fades. That is not a
 * shortcut, it is the reason the screen looks sharp: a real picture has to be stretched to fit whatever
 * phone it lands on, and stretching is what turned the old reaper on this screen to mush. Shapes redraw
 * clean at any size, on any screen, forever, and they add nothing to the download.
 *
 * The scene is built in layers, back to front, exactly like a stage set:
 *
 *   1.  night sky, deepest black at the top bleeding to old blood at the horizon
 *   2.  a scatter of dim stars
 *   3.  the moon's glow — eighteen circles stacked inside each other, each barely visible, because
 *       that is how you get a soft halo out of a phone that can only draw hard-edged circles
 *   4.  the moon itself, with craters and two bands of cloud crossing it
 *   5.  a cathedral skyline: five spires with lit windows, far away and nearly black
 *   6.  two banks of hills
 *   7.  bats, drifting across the moon on their own slow loops
 *   8.  the reaper — a silhouette standing in front of the moon with a scythe, rimmed in the faintest
 *       gold, eyes that breathe. He is scenery, not a sprite: no pixel art is scaled up anywhere here
 *   9.  the graveyard: leaning headstones, crosses, a dead tree
 *   10. an iron railing across the very front, so the player is standing outside the fence looking in
 *   11. three fog banks creeping sideways at different speeds
 *   12. embers rising the full height of the screen
 *   13. shadow washes top and bottom, so text always has dark behind it
 *
 * WHAT IS ON IT, AND WHY THAT AND NOTHING ELSE
 *
 * Your gold and your runs survived sit in the top corners, because that is where a player of any
 * mobile game already looks for them. The logo owns the top third. One gold PLAY button owns the
 * bottom, filled rather than outlined and breathing very slightly, so on a shelf in a shop it is
 * still the thing your eye lands on. Characters, PowerUps and Badges are the screens you visit
 * between runs, so they are stone and half-width. Settings holds everything else, including How to
 * play and backing your profile up.
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DimensionValue } from "react-native";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
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

/** The moon. Big enough to matter, small enough that the reaper reads against it. */
const MOON_SIZE = 158;

/** How many circles build the halo. More rings, softer edge — this is the whole trick. */
const HALO_RINGS = 18;

const HALO_OUTER = MOON_SIZE * 2.6;

/** How many embers drift up the screen at once, and how long the slowest one takes to cross it. */
const EMBER_COUNT = 16;

const EMBER_RISE_MS = 7000;

const EMBER_SPREAD_MS = 5000;

const EMBER_TRAVEL = 700;

/** How long the slowest fog bank takes to cross the screen once. */
const FOG_DRIFT_MS = 26000;

/** How long a bat takes to cross the sky, and how many are up there. */
const BAT_CROSS_MS = 14000;

/** How many bars in the iron railing across the front. */
const RAIL_BARS = 26;

/* ------------------------------------------------------------------------------------------------ */
/* Sky                                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/** Where the dim stars sit. Placed by hand so the sky is the same every launch and never clumps. */
const STARS: readonly { readonly left: DimensionValue; readonly top: DimensionValue; readonly size: number }[] = [
  { left: "8%", top: "6%", size: 2 },
  { left: "21%", top: "11%", size: 1 },
  { left: "34%", top: "4%", size: 2 },
  { left: "47%", top: "9%", size: 1 },
  { left: "62%", top: "5%", size: 2 },
  { left: "76%", top: "12%", size: 1 },
  { left: "89%", top: "7%", size: 2 },
  { left: "14%", top: "19%", size: 1 },
  { left: "29%", top: "23%", size: 1 },
  { left: "58%", top: "20%", size: 1 },
  { left: "83%", top: "22%", size: 2 },
  { left: "94%", top: "17%", size: 1 },
];

function haloRings(): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < HALO_RINGS; i += 1) out.push(i);
  return out;
}

/** The sky, the stars, the halo and the moon. */
function Sky(): React.ReactNode {
  const rings = useMemo(haloRings, []);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={["#040309", "#0E0716", "#251024", "#48182A", "#611F2C"]}
        locations={[0, 0.28, 0.5, 0.7, 0.86]}
        style={StyleSheet.absoluteFill}
      />

      {STARS.map((star) => (
        <View
          key={String(star.left) + String(star.top)}
          style={[
            styles.star,
            { left: star.left, top: star.top, width: star.size, height: star.size, borderRadius: star.size },
          ]}
        />
      ))}

      <View style={styles.moonWrap}>
        {/* Eighteen nearly-invisible circles inside each other. One big translucent circle would show
            its own rim; this many, each at three percent, fades out with no edge to see. */}
        {rings.map((i) => {
          const t = i / (HALO_RINGS - 1);
          const size = MOON_SIZE + (HALO_OUTER - MOON_SIZE) * t;
          return (
            <View
              key={String(i)}
              style={[
                styles.halo,
                {
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                  marginTop: (MOON_SIZE - size) / 2,
                  opacity: 0.035 * (1 - t) + 0.006,
                },
              ]}
            />
          );
        })}

        <View style={styles.moon}>
          <LinearGradient
            colors={["#FFBE9B", "#DE5F41", "#9E2029", "#66101C"]}
            locations={[0, 0.42, 0.76, 1]}
            style={styles.moonFace}
          />
          <View style={[styles.crater, styles.craterOne]} />
          <View style={[styles.crater, styles.craterTwo]} />
          <View style={[styles.crater, styles.craterThree]} />
          <View style={[styles.crater, styles.craterFour]} />
          {/* A shadow creeping up from the bottom edge, so the ball has a lit side and a dark one. */}
          <LinearGradient
            colors={["rgba(26,13,24,0)", "rgba(26,13,24,0.55)"]}
            locations={[0.45, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Far background                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** Cathedral spires, far off and nearly black, with a couple of lit windows each. */
const SPIRES: readonly { readonly left: DimensionValue; readonly width: number; readonly body: number; readonly roof: number }[] = [
  { left: "5%", width: 14, body: 40, roof: 22 },
  { left: "18%", width: 22, body: 60, roof: 34 },
  { left: "64%", width: 18, body: 50, roof: 28 },
  { left: "78%", width: 28, body: 76, roof: 44 },
  { left: "92%", width: 13, body: 34, roof: 20 },
];

function Skyline(): React.ReactNode {
  return (
    <View pointerEvents="none" style={styles.skylineLayer}>
      {SPIRES.map((spire) => (
        <View key={String(spire.left)} style={[styles.spireWrap, { left: spire.left }]}>
          <View
            style={[
              styles.spireRoof,
              {
                borderLeftWidth: spire.width / 2 + 4,
                borderRightWidth: spire.width / 2 + 4,
                borderBottomWidth: spire.roof,
              },
            ]}
          />
          <View style={[styles.spireBody, { width: spire.width, height: spire.body }]}>
            <View style={styles.spireWindow} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Two humps of hill, to give the graveyard somewhere to sit. */
function Hills(): React.ReactNode {
  return (
    <View pointerEvents="none" style={styles.hillLayer}>
      <View style={[styles.hill, styles.hillLeft]} />
      <View style={[styles.hill, styles.hillRight]} />
    </View>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Bats                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

const BATS: readonly { readonly top: DimensionValue; readonly scale: number; readonly delay: number; readonly rtl: boolean }[] = [
  { top: "24%", scale: 1, delay: 0, rtl: false },
  { top: "31%", scale: 0.72, delay: 4200, rtl: true },
  { top: "18%", scale: 0.55, delay: 8600, rtl: false },
];

function Bats(): React.ReactNode {
  const values = useRef(BATS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = values.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(BATS[i]?.delay ?? 0),
          Animated.timing(value, {
            toValue: 1,
            duration: BAT_CROSS_MS + i * 3500,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [values]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {BATS.map((bat, i) => {
        const value = values[i] as Animated.Value;
        return (
          <Animated.View
            key={String(bat.top)}
            style={[
              styles.bat,
              {
                top: bat.top,
                opacity: value.interpolate({ inputRange: [0, 0.1, 0.9, 1], outputRange: [0, 0.85, 0.85, 0] }),
                transform: [
                  {
                    translateX: value.interpolate({
                      inputRange: [0, 1],
                      outputRange: bat.rtl ? [420, -80] : [-80, 420],
                    }),
                  },
                  { translateY: value.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -26, 8] }) },
                  { scale: bat.scale },
                ],
              },
            ]}
          >
            <View style={[styles.batWing, styles.batWingLeft]} />
            <View style={styles.batBody} />
            <View style={[styles.batWing, styles.batWingRight]} />
          </Animated.View>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The reaper                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A hooded figure with a scythe, standing in front of the moon.
 *
 * Every piece is a shape: a rounded rect for the cloak, two rotated panels for the way it flares at the
 * hem, a circle for the hood, a thin bar for the scythe handle and a curved bar for its blade. He is
 * black on purpose — the only colour on him is the faintest gold along the edge facing the moon, and two
 * eyes that fade in and out. A silhouette cannot look low-resolution, which is exactly why he is one.
 */
function Reaper(): React.ReactNode {
  const eyes = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(eyes, { toValue: 1, duration: 2100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(eyes, { toValue: 0.4, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [eyes]);

  return (
    <View pointerEvents="none" style={styles.reaperLayer}>
      <View style={styles.reaper}>
        {/* Scythe: handle behind the body, then two steel bars meeting at an angle to read as a hook. */}
        <View style={styles.scytheHandle} />
        <View style={styles.bladeLong} />
        <View style={styles.bladeHook} />

        {/* Robe: a narrow body, plus two panels rotated out so the hem flares instead of ending square. */}
        <View style={[styles.cloakFlare, styles.cloakFlareLeft]} />
        <View style={[styles.cloakFlare, styles.cloakFlareRight]} />
        <View style={styles.cloakBody} />

        {/* Shoulders, the cowl, and the peak that stops the hood reading as a ball. */}
        <View style={styles.shoulders} />
        <View style={[styles.arm, styles.armLeft]} />
        <View style={[styles.arm, styles.armRight]} />
        <View style={styles.hood}>
          <View style={styles.hoodPeak} />
          <View style={styles.hoodMouth} />
          <Animated.View style={[styles.eye, styles.eyeLeft, { opacity: eyes }]} />
          <Animated.View style={[styles.eye, styles.eyeRight, { opacity: eyes }]} />
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Foreground                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/** One grave marker: how far across the screen it stands, how big it is, and how far it leans. */
const MARKERS: readonly {
  readonly left: DimensionValue;
  readonly width: number;
  readonly height: number;
  readonly lean: string;
  readonly cross: boolean;
}[] = [
  { left: "2%", width: 22, height: 46, lean: "-6deg", cross: false },
  { left: "12%", width: 14, height: 32, lean: "5deg", cross: true },
  { left: "20%", width: 26, height: 58, lean: "2deg", cross: false },
  { left: "31%", width: 16, height: 36, lean: "-9deg", cross: false },
  { left: "40%", width: 13, height: 27, lean: "7deg", cross: true },
  { left: "57%", width: 24, height: 52, lean: "-3deg", cross: false },
  { left: "68%", width: 15, height: 34, lean: "8deg", cross: false },
  { left: "77%", width: 13, height: 28, lean: "-5deg", cross: true },
  { left: "86%", width: 28, height: 62, lean: "3deg", cross: false },
  { left: "95%", width: 16, height: 35, lean: "-8deg", cross: false },
];

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
          {marker.cross ? <View style={[styles.crossArm, { width: marker.width * 2.2 }]} /> : null}
        </View>
      ))}
      <View style={styles.trunk} />
      <View style={[styles.branch, styles.branchLeft]} />
      <View style={[styles.branch, styles.branchRight]} />
    </View>
  );
}

function railBars(): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < RAIL_BARS; i += 1) out.push(i);
  return out;
}

/** An iron railing across the very front, so the player is outside the fence looking in. */
function Railing(): React.ReactNode {
  const bars = useMemo(railBars, []);
  return (
    <View pointerEvents="none" style={styles.railLayer}>
      <View style={styles.railTop} />
      <View style={styles.railBottom} />
      {bars.map((i) => (
        <View key={String(i)} style={[styles.railBar, { left: `${(i * 100) / RAIL_BARS + 1}%` }]}>
          <View style={styles.railSpike} />
        </View>
      ))}
    </View>
  );
}

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
              bottom: Grid * (0.5 + i * 3.5),
              height: 16 + i * 10,
              opacity: 0.09 - i * 0.022,
              transform: [
                {
                  translateX: value.interpolate({
                    inputRange: [0, 1],
                    outputRange: i % 2 === 0 ? [-170, 170] : [170, -170],
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
      left: `${4 + ((i * 29) % 92)}%` as DimensionValue,
      size: 2 + (i % 3),
      rise: EMBER_RISE_MS + Math.round(t * EMBER_SPREAD_MS),
      delay: Math.round(t * EMBER_RISE_MS),
      drift: i % 2 === 0 ? 22 : -22,
    });
  }
  return out;
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
    <View style={styles.art}>
      <Sky />
      <Skyline />
      <Hills />
      <Bats />
      <Reaper />
      <Graveyard />
      <Railing />
      <Fog />
      <Embers />

      <LinearGradient
        colors={["rgba(4,3,9,0.96)", "rgba(4,3,9,0.42)", "rgba(4,3,9,0)"]}
        locations={[0, 0.46, 0.72]}
        style={styles.topWash}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["rgba(4,3,9,0)", "rgba(4,3,9,0.8)", "rgba(4,3,9,0.98)"]}
        locations={[0, 0.34, 0.62]}
        style={styles.bottomWash}
        pointerEvents="none"
      />

      <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
        <View style={styles.top}>
          <View style={styles.chipRow}>
            <Chip value={ready ? String(save.gold) : "—"} icon="coin" tint={Palette.goldLit} align="left" />
            <Chip value={ready ? String(save.runsCompleted) : "—"} icon="skull" tint={Palette.bone} align="right" />
          </View>

          <View style={styles.crest}>
            <StoneText tone="ash" size={11} bold align="center">
              S U R V I V E   T H E
            </StoneText>
            <Wordmark />
            <View style={styles.ruleRow}>
              <View style={styles.rule} />
              <View style={styles.diamond} />
              <StoneText tone="bone" size={13} bold align="center" style={styles.sub}>
                S U R V I V O R S
              </StoneText>
              <View style={styles.diamond} />
              <View style={styles.rule} />
            </View>
          </View>
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

const SILHOUETTE = "#050409";

const styles = StyleSheet.create({
  art: { flex: 1, backgroundColor: Palette.ink, overflow: "hidden" },

  /* --- sky ------------------------------------------------------------- */
  star: { position: "absolute", backgroundColor: Palette.bone, opacity: 0.35 },
  moonWrap: { position: "absolute", top: "20%", left: 0, right: 0, alignItems: "center" },
  halo: { position: "absolute", backgroundColor: "#E8455A" },
  moon: { width: MOON_SIZE, height: MOON_SIZE, borderRadius: MOON_SIZE / 2, overflow: "hidden" },
  moonFace: { flex: 1 },
  crater: { position: "absolute", borderRadius: 40, backgroundColor: "#8E2026", opacity: 0.32 },
  craterOne: { width: 38, height: 38, top: 30, left: 32 },
  craterTwo: { width: 22, height: 22, top: 88, left: 100 },
  craterThree: { width: 15, height: 15, top: 52, left: 114 },
  craterFour: { width: 27, height: 27, top: 116, left: 48 },

  /* --- skyline and hills ------------------------------------------------ */
  skylineLayer: { position: "absolute", left: 0, right: 0, bottom: "41%", height: 130 },
  spireWrap: { position: "absolute", bottom: 0, alignItems: "center" },
  spireRoof: {
    width: 0,
    height: 0,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "#07050F",
  },
  spireBody: { backgroundColor: "#07050F", alignItems: "center", paddingTop: 8 },
  spireWindow: { width: 3, height: 6, backgroundColor: Palette.gold, opacity: 0.4 },
  hillLayer: { position: "absolute", left: 0, right: 0, bottom: 0, height: "52%" },
  hill: { position: "absolute", backgroundColor: "#0B0713" },
  hillLeft: {
    left: "-28%",
    bottom: "38%",
    width: "96%",
    height: 150,
    borderTopRightRadius: 300,
    borderTopLeftRadius: 200,
  },
  hillRight: {
    right: "-32%",
    bottom: "38%",
    width: "104%",
    height: 112,
    borderTopLeftRadius: 320,
    borderTopRightRadius: 180,
  },

  /* --- bats ------------------------------------------------------------- */
  bat: { position: "absolute", left: 0, flexDirection: "row", alignItems: "center" },
  batBody: { width: 5, height: 7, borderRadius: 3, backgroundColor: SILHOUETTE },
  batWing: { width: 11, height: 4, backgroundColor: SILHOUETTE, borderRadius: 3 },
  batWingLeft: { transform: [{ rotate: "-22deg" }] },
  batWingRight: { transform: [{ rotate: "22deg" }] },

  /* --- reaper ----------------------------------------------------------- */
  reaperLayer: { position: "absolute", left: 0, right: 0, bottom: "36%", alignItems: "center" },
  reaper: { width: 170, height: 236, alignItems: "center", justifyContent: "flex-end" },
  scytheHandle: {
    position: "absolute",
    right: 24,
    bottom: 0,
    width: 5,
    height: 228,
    backgroundColor: SILHOUETTE,
    transform: [{ rotate: "7deg" }],
  },
  bladeLong: {
    position: "absolute",
    right: 12,
    top: 10,
    width: 68,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#4A4560",
    transform: [{ rotate: "-27deg" }],
  },
  bladeHook: {
    position: "absolute",
    right: 62,
    top: 28,
    width: 28,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#4A4560",
    transform: [{ rotate: "-66deg" }],
  },
  cloakBody: {
    width: 42,
    height: 142,
    backgroundColor: SILHOUETTE,
    borderTopLeftRadius: 21,
    borderTopRightRadius: 21,
  },
  cloakFlare: { position: "absolute", bottom: 0, width: 20, height: 118, backgroundColor: SILHOUETTE },
  cloakFlareLeft: { left: 50, borderTopLeftRadius: 14, transform: [{ rotate: "6deg" }] },
  cloakFlareRight: { right: 50, borderTopRightRadius: 14, transform: [{ rotate: "-6deg" }] },
  shoulders: {
    position: "absolute",
    bottom: 124,
    width: 58,
    height: 22,
    backgroundColor: SILHOUETTE,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  hood: {
    position: "absolute",
    bottom: 138,
    width: 46,
    height: 58,
    backgroundColor: SILHOUETTE,
    borderTopLeftRadius: 23,
    borderTopRightRadius: 23,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    borderLeftWidth: 1.5,
    borderLeftColor: "rgba(247,215,116,0.2)",
    alignItems: "center",
    transform: [{ rotate: "-3deg" }],
  },
  arm: { position: "absolute", width: 13, height: 62, backgroundColor: SILHOUETTE, borderRadius: 7 },
  armLeft: { bottom: 74, left: 48, transform: [{ rotate: "6deg" }] },
  armRight: { bottom: 82, right: 44, transform: [{ rotate: "-24deg" }] },
  hoodPeak: {
    position: "absolute",
    top: -9,
    width: 18,
    height: 18,
    backgroundColor: SILHOUETTE,
    borderTopLeftRadius: 6,
    transform: [{ rotate: "45deg" }],
  },
  hoodMouth: {
    position: "absolute",
    top: 15,
    width: 28,
    height: 34,
    borderRadius: 14,
    backgroundColor: "#010104",
  },
  eye: { position: "absolute", top: 26, width: 6, height: 3, borderRadius: 2, backgroundColor: Palette.crimsonLit },
  eyeLeft: { left: 12 },
  eyeRight: { right: 12 },

  /* --- graveyard -------------------------------------------------------- */
  graveLayer: { position: "absolute", left: 0, right: 0, bottom: 0, height: "42%" },
  ground: { position: "absolute", left: 0, right: 0, bottom: 0, height: "81%", backgroundColor: "#040308" },
  marker: { position: "absolute", bottom: "78%", backgroundColor: SILHOUETTE },
  crossArm: { position: "absolute", top: "24%", left: "-58%", height: 6, backgroundColor: SILHOUETTE },
  trunk: { position: "absolute", left: "8%", bottom: "78%", width: 7, height: 112, backgroundColor: SILHOUETTE },
  branch: { position: "absolute", left: "8%", bottom: "78%", width: 44, height: 5, backgroundColor: SILHOUETTE },
  branchLeft: { marginBottom: 84, marginLeft: -34, transform: [{ rotate: "-32deg" }] },
  branchRight: { marginBottom: 96, marginLeft: 3, transform: [{ rotate: "30deg" }] },

  /* --- railing ---------------------------------------------------------- */
  railLayer: { position: "absolute", left: 0, right: 0, bottom: "30%", height: 50 },
  railTop: { position: "absolute", left: 0, right: 0, top: 14, height: 3, backgroundColor: "#020206" },
  railBottom: { position: "absolute", left: 0, right: 0, bottom: 10, height: 3, backgroundColor: "#020206" },
  railBar: { position: "absolute", bottom: 0, width: 3, height: 42, backgroundColor: "#020206", alignItems: "center" },
  railSpike: {
    position: "absolute",
    top: -9,
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderBottomWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "#020206",
  },

  /* --- fog and embers --------------------------------------------------- */
  fogLayer: { position: "absolute", left: 0, right: 0, bottom: "31%", height: 66 },
  fogBand: { position: "absolute", left: "-30%", right: "-30%" },
  ember: { position: "absolute", bottom: 0, borderRadius: 2, backgroundColor: Palette.goldLit },

  /* --- washes ----------------------------------------------------------- */
  topWash: { position: "absolute", left: 0, right: 0, top: 0, height: "30%" },
  bottomWash: { position: "absolute", left: 0, right: 0, bottom: 0, height: "40%" },

  /* --- content ---------------------------------------------------------- */
  screen: { flex: 1, paddingHorizontal: Grid * 2.5, justifyContent: "space-between" },
  top: { gap: Grid * 2 },
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

  crest: { gap: Grid * 0.5 },
  wordmark: { height: 54, justifyContent: "center" },
  word: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: 2,
  },
  wordShadow: { color: "#000000", top: 5 },
  wordBlood: { color: Palette.crimson, top: 2 },
  wordGold: { color: Palette.goldLit, top: 0 },
  ruleRow: { flexDirection: "row", alignItems: "center", gap: Grid * 0.75, marginTop: Grid * 0.5 },
  rule: { flex: 1, height: 1, backgroundColor: Palette.gold, opacity: 0.45 },
  diamond: { width: 5, height: 5, backgroundColor: Palette.gold, opacity: 0.8, transform: [{ rotate: "45deg" }] },
  sub: { marginTop: 0 },

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
