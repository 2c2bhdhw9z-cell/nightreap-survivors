/**
 * Stage select. Where you choose which of the five places to go and die in.
 *
 * THE RULE THIS FILE OBEYS: IT DOES NOT DECIDE ANYTHING
 *
 * Same rule as character select. Nothing on this screen works out whether a place is open, what would
 * open it, or how long you lasted there. All of that comes from the stage table and the unlock layer,
 * which are pure content and pure rules with checks behind them. This file turns their answers into
 * English and draws them. That is what stops the two classic select-screen bugs: a card that promises a
 * place you cannot actually play, and a place that is open in the rules but shows a padlock here.
 *
 * WHY A LOCKED PLACE STAYS ON THE SCREEN
 *
 * Because a list of five with two greyed out is a reason to keep playing, and a list of two is not. A
 * locked card shows its name, what it does to you, and the exact sentence that opens it — never a
 * mystery. The one thing a locked card hides is nothing at all; there is no spoiler here worth keeping,
 * unlike a character portrait, which is the reward itself.
 *
 * WHY THE CHOICE IS A ROUTE PARAMETER
 *
 * Same as the character: "the place you last played" would want a byte in the save file, and the run
 * re-checks the choice anyway — anything locked or unreadable falls back to the first place, which every
 * profile can always play. A screen cannot start a run somewhere it was not allowed to go.
 *
 * FIDELITY: the emblem on each card is that stage's own floor tile out of the shared sheet, tinted the
 * way the stage tints it in play, so the card and the floor you land on are the same colour. It is not a
 * screenshot. Real per-stage art, if it is ever drawn, drops into the same box without moving anything.
 */

import { useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Sprite } from "@/components/sprite";
import { Chunk, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import { STAGE_ART } from "@/game/art/run-art";
import { STAGE_TYPES, bossesOf, type StageType } from "@/game/sim/stages";
import {
  bestTimeLine,
  isStageOpen,
  openStageCount,
  stageBestOf,
  stageLockLine,
} from "@/game/unlocks/stage-records";
import { useSettings } from "@/hooks/use-settings";

/** The tile a card draws as its emblem: the stage's own first floor tile, out of the shared sheet. */
function emblemOf(stage: StageType): string {
  const art = STAGE_ART[stage.artKey];
  return art === undefined ? "" : art.floorFrames[0];
}

/** The colour the stage paints its floor with, used as the card's accent so the two match. */
function accentOf(stage: StageType): string {
  return STAGE_ART[stage.artKey]?.floorTint ?? Palette.stone;
}

/**
 * How many named fights a place holds, in words.
 *
 * The count, not the names. A stage that listed "Bellmaster, Carrion King, Grave Tyrant" on the card
 * would spoil the one thing a first run has going for it, and the count is the part that actually helps
 * you choose — it says how often the floor stops being about the crowd.
 */
function fightLine(stage: StageType): string {
  const count = bossesOf(stage).length;
  if (count === 0) return "No named fights";
  return count === 1 ? "1 named fight" : `${count} named fights`;
}

/** How long a run here lasts before the Reaper arrives, in whole minutes. */
function lengthLine(stage: StageType): string {
  return `${Math.round(stage.reaperSecond / 60)} minutes to the Reaper`;
}

export default function StageScreen(): ReactNode {
  const router = useRouter();
  const { save, loadFailed } = useSettings();
  const [picked, setPicked] = useState(0);
  const [notice, setNotice] = useState("");

  const start = useCallback(() => {
    if (!isStageOpen(save, picked)) {
      setNotice(stageLockLine(save, picked));
      return;
    }
    // Where first, then who. The place travels on so character select can start the run with both.
    router.push(`/characters?stage=${picked}`);
  }, [picked, router, save]);

  const open = openStageCount(save);
  const chosenOpen = isStageOpen(save, picked);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <Slab style={styles.top}>
        <StoneText tone="bone" size={16} bold>
          WHERE TO
        </StoneText>
        <StoneText tone="ash" size={10} bold>
          {`${open}/${STAGE_TYPES.length}`}
        </StoneText>
      </Slab>

      {loadFailed ? (
        <StoneText tone="crimson" size={10} bold align="center">
          YOUR SAVE COULD NOT BE READ. ONLY THE FIRST PLACE IS AVAILABLE.
        </StoneText>
      ) : null}
      {notice !== "" ? (
        <StoneText tone="ash" size={11} align="center">
          {notice}
        </StoneText>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator>
        {STAGE_TYPES.map((stage, index) => {
          const unlocked = isStageOpen(save, index);
          const selected = index === picked;
          const best = bestTimeLine(stageBestOf(save, index));
          return (
            <Pressable
              key={stage.id}
              onPress={() => {
                setNotice(unlocked ? "" : stageLockLine(save, index));
                setPicked(index);
              }}
            >
              <Slab raised={selected} style={[styles.row, selected ? styles.rowPicked : null]}>
                {/* The emblem is the floor itself, under the stage's own tint. Two places that share a
                    tile still read as two places, which is the same thing the contrast check measures. */}
                <View style={[styles.emblem, { backgroundColor: accentOf(stage) }, selected ? styles.emblemPicked : null]}>
                  <Sprite name={emblemOf(stage)} size={Grid * 8} locked={!unlocked} />
                </View>

                <View style={styles.rowText}>
                  <StoneText tone={unlocked ? "bone" : "ash"} size={14} bold>
                    {stage.name.toUpperCase()}
                  </StoneText>
                  <StoneText tone="ash" size={10}>
                    {stage.blurb}
                  </StoneText>

                  {unlocked ? (
                    <>
                      <StoneText tone="cyan" size={10} bold>
                        {fightLine(stage)}
                      </StoneText>
                      <StoneText tone="ash" size={10}>
                        {lengthLine(stage)}
                      </StoneText>
                      <StoneText tone={best === "" ? "ash" : "gold"} size={10} bold>
                        {best === "" ? "Never played" : `Best ${best}`}
                      </StoneText>
                    </>
                  ) : (
                    <StoneText tone="violet" size={10} bold>
                      {stageLockLine(save, index)}
                    </StoneText>
                  )}
                </View>
              </Slab>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.exits}>
        <Chunk
          label={chosenOpen ? "CHOOSE A SURVIVOR" : "LOCKED"}
          weight={chosenOpen ? "gold" : "stone"}
          style={styles.exit}
          onPress={start}
        />
        <Chunk label="BACK" weight="stone" style={styles.exit} onPress={() => router.back()} />
      </View>
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
  list: {
    gap: Grid,
    paddingBottom: Grid * 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Grid,
    padding: Grid,
  },
  rowPicked: {
    borderColor: Palette.gold,
    borderWidth: 2,
  },
  emblem: {
    width: Grid * 9,
    height: Grid * 9,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    alignItems: "center",
    justifyContent: "center",
  },
  emblemPicked: {
    borderColor: Palette.gold,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  exits: {
    flexDirection: "row",
    gap: Grid,
    paddingBottom: Grid,
  },
  exit: {
    flex: 1,
  },
});
