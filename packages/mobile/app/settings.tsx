/**
 * Settings.
 *
 * This file draws a list and writes a file. It decides nothing. Which rows exist, what each one is
 * called, what it reads as and what pressing it does all come out of the settings rules, which are plain
 * arithmetic with their own checks — so a control here cannot say one thing and store another.
 *
 * WRITES ARE CONFIRMED, NOT ASSUMED
 *
 * A change lands in memory immediately, because a control that lags behind your thumb feels broken, and
 * is then written to storage. If that write fails the screen says so, in those words, rather than showing
 * a setting that will be gone the next time the game opens. Same rule the shop follows.
 *
 * DELETING EVERYTHING IS BEHIND A CONFIRM
 *
 * It is the one button in the game that can destroy hours of play, and the confirm spells out exactly
 * what goes: progress, gold, and these settings. Nothing on this screen is reachable by a stray thumb
 * twice in a row by accident.
 */

import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Chunk, Mortar, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import type { SaveData } from "@/game/save/schema";
import {
  ACTION,
  GROUPS,
  ROW_KIND,
  rowsIn,
  settingsDiffer,
  type SettingRow,
} from "@/game/settings/rows";
import { saveStore, useSettings } from "@/hooks/use-settings";

export default function SettingsScreen() {
  const router = useRouter();
  const { ready, save, loadFailed } = useSettings();

  // The working copy. Starts as whatever loaded, and every press replaces it whole.
  const [working, setWorking] = useState<SaveData | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);

  // The save arrives asynchronously. Adopt it once, and never again — adopting it twice would throw away
  // whatever the player had already changed while it was still loading.
  useEffect(() => {
    if (!ready) return;
    setWorking((current) => current ?? save);
  }, [ready, save]);

  const current = working ?? save;

  const press = useCallback(
    (row: SettingRow, step: number) => {
      if (row.disabled?.(current.settings) === true) return;

      if (row.action === ACTION.howToPlay) {
        router.push("/how-to-play");
        return;
      }
      if (row.action === ACTION.deleteSave) {
        setConfirmDelete(true);
        return;
      }

      const nextSettings = row.apply(current.settings, step);
      if (!settingsDiffer(current.settings, nextSettings)) return;

      const next: SaveData = { ...current, settings: nextSettings };
      setWorking(next);
      void (async () => {
        const result = await saveStore().save(next);
        setWriteFailed(!result.ok);
      })();
    },
    [current, router],
  );

  const wipe = useCallback(() => {
    void (async () => {
      await saveStore().eraseEverything();
      setConfirmDelete(false);
      setDeleted(true);
    })();
  }, []);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <View style={styles.titleBar}>
        <StoneText tone="gold" size={17} bold align="center">
          SETTINGS
        </StoneText>
      </View>

      {loadFailed ? (
        <Slab style={styles.notice}>
          <StoneText tone="crimson" size={12}>
            Your saved settings could not be read, so these are the defaults. Changing anything here will
            write a fresh save over the unreadable one.
          </StoneText>
        </Slab>
      ) : null}

      {writeFailed ? (
        <Slab style={styles.notice}>
          <StoneText tone="crimson" size={12}>
            That change could not be saved to this phone. It is applied for now, but it will be gone the
            next time the game opens.
          </StoneText>
        </Slab>
      ) : null}

      {deleted ? (
        <Slab style={styles.notice}>
          <StoneText tone="crimson" size={12}>
            Everything has been deleted. Close and reopen the game to start fresh.
          </StoneText>
        </Slab>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {GROUPS.map((group) => (
          <View key={group} style={styles.group}>
            <StoneText tone="ash" size={11} bold style={styles.groupTitle}>
              {group.toUpperCase()}
            </StoneText>
            <Mortar />
            {rowsIn(group).map((row) => (
              <Row key={row.id} row={row} settings={current.settings} onPress={press} />
            ))}
          </View>
        ))}

        {confirmDelete ? (
          <Slab style={styles.confirm}>
            <StoneText tone="crimson" size={13} bold>
              Delete everything?
            </StoneText>
            <StoneText tone="bone" size={12} style={styles.confirmBody}>
              Your progress, your gold, every unlock and these settings all go. This cannot be undone.
            </StoneText>
            <View style={styles.confirmRow}>
              <Chunk label="KEEP MY SAVE" weight="stone" onPress={() => setConfirmDelete(false)} style={styles.confirmButton} />
              <Chunk label="DELETE IT ALL" weight="danger" onPress={wipe} style={styles.confirmButton} />
            </View>
          </Slab>
        ) : null}

        <Chunk label="BACK" weight="stone" onPress={() => router.back()} style={styles.back} />
      </ScrollView>
    </SafeAreaView>
  );
}

/** One row. A slider gets two buttons, everything else is one press on the whole row. */
function Row({
  row,
  settings,
  onPress,
}: {
  row: SettingRow;
  settings: SaveData["settings"];
  onPress: (row: SettingRow, step: number) => void;
}) {
  const dead = row.disabled?.(settings) === true;
  const value = row.value(settings);
  const danger = row.action === ACTION.deleteSave;

  const body = (
    <View style={styles.rowBody}>
      <View style={styles.rowText}>
        <StoneText tone={dead ? "ash" : danger ? "crimson" : "bone"} size={13} bold>
          {row.label}
        </StoneText>
        <StoneText tone="ash" size={11} style={styles.help}>
          {dead ? (row.disabledBecause ?? row.help) : row.help}
        </StoneText>
      </View>

      {row.kind === ROW_KIND.slider ? (
        <View style={styles.stepper}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.label} down`}
            onPress={() => onPress(row, -1)}
            style={({ pressed }) => [styles.step, pressed ? styles.stepPressed : null]}
          >
            <StoneText tone="bone" size={15} bold align="center">
              –
            </StoneText>
          </Pressable>
          <View style={styles.readout}>
            <StoneText tone="gold" size={12} bold align="center">
              {value}
            </StoneText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.label} up`}
            onPress={() => onPress(row, 1)}
            style={({ pressed }) => [styles.step, pressed ? styles.stepPressed : null]}
          >
            <StoneText tone="bone" size={15} bold align="center">
              +
            </StoneText>
          </Pressable>
        </View>
      ) : value === "" ? null : (
        <View style={styles.readout}>
          <StoneText tone={dead ? "ash" : "gold"} size={12} bold align="center">
            {value}
          </StoneText>
        </View>
      )}
    </View>
  );

  // A slider's own buttons do the work, and a readout has nothing to press, so neither wraps in a button.
  if (row.kind === ROW_KIND.slider || row.kind === ROW_KIND.readout) {
    return <Slab style={styles.row}>{body}</Slab>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: dead }}
      onPress={() => onPress(row, 1)}
      style={({ pressed }) => [pressed && !dead ? styles.rowPressed : null]}
    >
      <Slab raised style={styles.row}>
        {body}
      </Slab>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.crypt },
  titleBar: { paddingVertical: Grid * 2 },
  notice: { marginHorizontal: Grid * 2, marginBottom: Grid, padding: Grid * 1.5 },
  list: { paddingHorizontal: Grid * 2, paddingBottom: Grid * 6 },
  group: { marginBottom: Grid * 3 },
  groupTitle: { marginBottom: Grid * 0.5 },
  row: { marginTop: Grid, padding: Grid * 1.5 },
  rowPressed: { opacity: 0.85 },
  rowBody: { flexDirection: "row", alignItems: "center", gap: Grid },
  rowText: { flex: 1 },
  help: { marginTop: 2 },
  stepper: { flexDirection: "row", alignItems: "center", gap: Grid * 0.5 },
  step: {
    width: Grid * 4.5,
    height: Grid * 4.5,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    backgroundColor: Palette.stone,
    alignItems: "center",
    justifyContent: "center",
  },
  stepPressed: { backgroundColor: Palette.stoneLit },
  readout: { minWidth: Grid * 7, alignItems: "center" },
  confirm: { padding: Grid * 2, marginTop: Grid },
  confirmBody: { marginTop: Grid },
  confirmRow: { flexDirection: "row", gap: Grid, marginTop: Grid * 2 },
  confirmButton: { flex: 1 },
  back: { marginTop: Grid * 2 },
});
