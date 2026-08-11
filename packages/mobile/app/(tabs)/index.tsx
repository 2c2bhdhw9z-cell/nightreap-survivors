/**
 * Dev launcher. This is an instrument panel, not player-facing UI, so it is deliberately plain and
 * is not subject to the mock-first rule — no title screen, no art, nothing here ships.
 *
 * It exists for one reason: opening the preview used to land on the template's stock "Welcome"
 * screen with no route into the benchmark, which reads as "the app did nothing".
 */

import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";

import { Palette, Grid } from "@/constants/theme";

const STEPS = [
  "Tap GATE A BENCH below.",
  "Hit the 5000 preset.",
  "Leave it running ~15 min so the phone gets warm.",
  "Screenshot the panel once WARM reads ready.",
] as const;

export default function Index() {
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>NIGHTREAP SURVIVORS</Text>
        <Text style={styles.title}>Phase 0 — Engine</Text>
      </View>

      <Link href="/dev/bench" style={styles.cta}>
        <Text style={styles.ctaText}>GATE A BENCH</Text>
      </Link>

      {/*
        Secondary because it answers a narrower question: the bench proves the frame rate, the leak
        harness works out who is responsible for the memory that gets the process killed.
      */}
      <Link href="/dev/leak" style={styles.ctaAlt}>
        <Text style={styles.ctaAltText}>LEAK ISOLATION</Text>
      </Link>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>How to run the real test</Text>
        {STEPS.map((step, i) => (
          <Text key={step} style={styles.step}>
            <Text style={styles.stepNum}>{i + 1}. </Text>
            {step}
          </Text>
        ))}
      </View>

      <View style={styles.note}>
        <Text style={styles.noteText}>
          Numbers only count on real hardware. This browser preview falls back to software GL and
          will look catastrophically slow — that is the preview, not the engine.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Palette.crypt,
    padding: Grid * 3,
    gap: Grid * 3,
  },
  header: {
    gap: Grid,
  },
  kicker: {
    color: Palette.gold,
    fontSize: 11,
    letterSpacing: 2,
  },
  title: {
    color: Palette.boneLit,
    fontSize: 26,
    fontWeight: "700",
  },
  ctaAlt: {
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    backgroundColor: Palette.ink,
    paddingVertical: Grid * 2,
    paddingHorizontal: Grid * 2,
    textAlign: "center",
    borderRadius: 4,
  },
  ctaAltText: {
    color: Palette.bone,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1,
    textAlign: "center",
  },
  cta: {
    backgroundColor: Palette.gold,
    borderWidth: 1,
    borderColor: Palette.goldLit,
    paddingVertical: Grid * 2,
    paddingHorizontal: Grid * 2,
    textAlign: "center",
  },
  ctaText: {
    color: Palette.ink,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 1,
    textAlign: "center",
  },
  card: {
    backgroundColor: Palette.stone,
    borderTopWidth: 1,
    borderTopColor: Palette.stoneLit,
    padding: Grid * 2,
    gap: Grid,
  },
  cardTitle: {
    color: Palette.boneLit,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: Grid / 2,
  },
  step: {
    color: Palette.bone,
    fontSize: 13,
    lineHeight: 20,
  },
  stepNum: {
    color: Palette.cyanLit,
    fontWeight: "700",
  },
  note: {
    borderLeftWidth: 2,
    borderLeftColor: Palette.crimson,
    paddingLeft: Grid * 1.5,
  },
  noteText: {
    color: Palette.ash,
    fontSize: 12,
    lineHeight: 18,
  },
});
