/**
 * Character select.
 *
 * One row per character: portrait box, name and title, what the starting weapon is, the shifts spelled out
 * in plain words, and the growth quirk. Locked rows stay visible and say exactly what opens them, because a
 * roster you can see is a reason to keep playing and a grid of padlocks is not.
 *
 * THE RULE THIS FILE OBEYS: IT DOES NOT DECIDE ANYTHING
 *
 * Not one number here is worked out on this screen. Whether a row is locked, what opens it, what a shift is
 * worth and how big the growth quirk gets all come from the roster rules, which are pure content with a test
 * suite behind them. This file turns them into English and draws them. That is what stops the two classic
 * select-screen bugs: a card that promises a bonus the simulation does not apply, and a row that looks
 * playable and then refuses to start.
 *
 * WHY THE CHOICE IS A ROUTE PARAMETER AND NOT A SAVED FIELD
 *
 * "The character you last played" wants a byte in the save file, and adding one is a save migration — the
 * next item of work, not this one. Until then the choice travels to the run as a route parameter, and the
 * run re-checks it against the profile: a locked or unrecognised pick quietly falls back to somebody the
 * player definitely owns rather than starting a run they were not allowed to have.
 *
 * FIDELITY: rows draw a placeholder mark where the portrait goes. The eight portraits already exist as loose
 * sprites; they become atlas cells in Phase 4 and drop into the same box without any layout moving.
 */

import { useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Sprite } from "@/components/sprite";
import { Chunk, Slab, StoneText } from "@/components/stone";
import { portraitFrame } from "@/game/art/frames";
import { Grid, Palette } from "@/constants/theme";
import { STAT, STAT_NAMES, STAT_SCALE } from "@/game/sim/stats";
import { WEAPON_TYPES } from "@/game/sim/weapons";
import {
  CHARACTERS,
  firstPlayable,
  growthCeiling,
  isCharacterUnlocked,
  unlockHint,
  unlockedCount,
  type Character,
  type CharacterShift,
} from "@/game/characters/roster";
import { useSettings } from "@/hooks/use-settings";

/** Stats that are raw counts rather than permille, per the split written down in `stats.ts`. */
const COUNT_STATS = new Set<number>([
  STAT.amount,
  STAT.armor,
  STAT.pierce,
  STAT.iFrames,
  STAT.revives,
  STAT.rerolls,
  STAT.skips,
  STAT.banishes,
]);

/** Words a player would use for a stat, rather than the name the simulation uses. */
const STAT_WORDS: Record<number, string> = {
  [STAT.damage]: "damage",
  [STAT.area]: "effect size",
  [STAT.projectileSpeed]: "projectile speed",
  [STAT.duration]: "effect length",
  [STAT.amount]: "extra projectile",
  [STAT.cooldown]: "fire rate",
  [STAT.armor]: "armour",
  [STAT.maxHealth]: "health",
  [STAT.regen]: "regeneration",
  [STAT.moveSpeed]: "movement",
  [STAT.xpGain]: "experience",
  [STAT.goldGain]: "gold",
  [STAT.magnet]: "pickup range",
  [STAT.luck]: "luck",
  [STAT.pierce]: "pierce",
  [STAT.critChance]: "critical chance",
  [STAT.critDamage]: "critical damage",
};

function statWords(stat: number): string {
  return STAT_WORDS[stat] ?? STAT_NAMES[stat] ?? "something";
}

/**
 * One shift as a sentence.
 *
 * Health is permille of a hit point and armour is a flat count, so the two cannot share a formatter — that
 * confusion is exactly the 1000x mistake the stat table warns about, and a screen that prints "+40000
 * health" is how a player finds it before we do.
 */
function shiftWords(shift: CharacterShift): string {
  const sign = shift.add > 0 ? "+" : "-";
  const size = Math.abs(shift.add);
  if (shift.stat === STAT.maxHealth) return `${sign}${size / STAT_SCALE} health`;
  if (shift.stat === STAT.cooldown) {
    // Lower cooldown is faster, so the sign reads backwards to a player.
    return `${shift.add < 0 ? "+" : "-"}${(size * 100) / STAT_SCALE}% fire rate`;
  }
  if (COUNT_STATS.has(shift.stat)) {
    const word = statWords(shift.stat);
    return `${sign}${size} ${size === 1 ? word : `${word}s`}`;
  }
  return `${sign}${(size * 100) / STAT_SCALE}% ${statWords(shift.stat)}`;
}

/** Is this shift good for the player? Cooldown is the one stat where lower is better. */
function isGain(shift: CharacterShift): boolean {
  return shift.stat === STAT.cooldown ? shift.add < 0 : shift.add > 0;
}

/** What the growth quirk is worth by the time every step has landed. */
function growthWords(character: Character): string {
  const total = growthCeiling(character);
  const stat = character.growth.stat;
  if (COUNT_STATS.has(stat)) return `up to +${total} ${statWords(stat)}`;
  return `up to +${(total * 100) / STAT_SCALE}% ${statWords(stat)}`;
}

/** The weapon's own name, so a card never names a weapon the game does not have. */
function weaponName(id: string): string {
  return WEAPON_TYPES.find((w) => w.id === id)?.name ?? id;
}

export default function CharacterScreen(): ReactNode {
  const router = useRouter();
  const { save, loadFailed } = useSettings();
  const [picked, setPicked] = useState(() => firstPlayable(save, 0));
  const [notice, setNotice] = useState("");

  const start = useCallback(() => {
    if (!isCharacterUnlocked(save, picked)) {
      setNotice("That one is still locked.");
      return;
    }
    router.push(`/dev/play?character=${picked}`);
  }, [picked, router, save]);

  const owned = unlockedCount(save);
  const chosen = CHARACTERS[picked];

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <Slab style={styles.top}>
        <StoneText tone="bone" size={16} bold>
          CHARACTERS
        </StoneText>
        <StoneText tone="ash" size={10} bold>
          {`${owned}/${CHARACTERS.length}`}
        </StoneText>
      </Slab>

      {loadFailed ? (
        <StoneText tone="crimson" size={10} bold align="center">
          YOUR SAVE COULD NOT BE READ. ONLY THE STARTING CHARACTERS ARE AVAILABLE.
        </StoneText>
      ) : null}
      {notice !== "" ? (
        <StoneText tone="ash" size={11} align="center">
          {notice}
        </StoneText>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator>
        {CHARACTERS.map((character, index) => {
          const open = isCharacterUnlocked(save, index);
          const selected = index === picked;
          return (
            <Pressable
              key={character.id}
              onPress={() => {
                setNotice(open ? "" : unlockHint(character));
                setPicked(index);
              }}
            >
              <Slab raised={selected} style={[styles.row, selected ? styles.rowPicked : null]}>
              {/* A character nobody has earned yet keeps their face hidden. Showing the portrait behind a
                  lock badge would give away the one thing unlocking them is for. */}
              <View style={[styles.portrait, selected ? styles.portraitPicked : null]}>
                {open ? (
                  <Sprite name={portraitFrame(character.id)} size={Grid * 8} />
                ) : (
                  <StoneText tone="ash" size={18} bold align="center">
                    ?
                  </StoneText>
                )}
              </View>

              <View style={styles.rowText}>
                <StoneText tone={open ? "bone" : "ash"} size={14} bold>
                  {open ? character.name : "LOCKED"}
                </StoneText>
                <StoneText tone="ash" size={10}>
                  {open ? character.title : unlockHint(character)}
                </StoneText>

                {open ? (
                  <>
                    <StoneText tone="cyan" size={10} bold>
                      {weaponName(character.startingWeaponId).toUpperCase()}
                    </StoneText>
                    <View style={styles.shiftRow}>
                      {character.shifts.map((shift) => (
                        <StoneText
                          key={`${character.id}-${shift.stat}`}
                          tone={isGain(shift) ? "bone" : "crimson"}
                          size={10}
                        >
                          {shiftWords(shift)}
                        </StoneText>
                      ))}
                    </View>
                    <StoneText tone="violet" size={10}>
                      {`${character.growth.blurb} (${growthWords(character)})`}
                    </StoneText>
                  </>
                ) : null}
              </View>
              </Slab>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.exits}>
        <Chunk
          label={isCharacterUnlocked(save, picked) ? `PLAY AS ${chosen?.name.toUpperCase() ?? ""}` : "LOCKED"}
          weight={isCharacterUnlocked(save, picked) ? "gold" : "stone"}
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
  portrait: {
    // A face at a single scale is 32 screen pixels and reads as a smudge. Two scales, so the box is one
    // step wider than the art it holds.
    width: Grid * 9,
    height: Grid * 9,
    backgroundColor: Palette.ink,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    alignItems: "center",
    justifyContent: "center",
  },
  portraitPicked: {
    borderColor: Palette.gold,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  shiftRow: {
    gap: 2,
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
