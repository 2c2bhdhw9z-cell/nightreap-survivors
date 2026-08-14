/**
 * The results screen: what the run was, and what it paid.
 *
 * Built from the approved mock `mocks/screen-results-v1`. Title plate, the ending in words, four stat
 * tiles, the damage breakdown, then the two ways out.
 *
 * THE RULE THIS FILE OBEYS: IT DOES NOT DO ARITHMETIC
 *
 * Every number here is read straight off the staged result. Not one of them is recomputed, re-summed or
 * re-derived on this screen. That is not tidiness, it is the fix for a specific class of bug that players
 * notice and never forgive: the results screen says 6,730 gold, the shop has 6,728, and now the player
 * believes the game steals from them. There is exactly one place gold is added up, one place it is
 * banked, and one place a receipt is written — and this screen reads the receipt.
 *
 * WHERE THE BANKING HAPPENS
 *
 * Not here. By the time this screen mounts the run is already banked and its result is sitting in the
 * hand-off slot. This screen only reads. That matters because a React screen can mount twice — a fast
 * back-and-forward, a hot reload, a remount after a device rotation — and a screen that banked on mount
 * would pay twice. Banking is the run's job, it happens once, and the hand-off refuses a second attempt
 * even if something calls it anyway.
 *
 * WHAT IT DOES WHEN THERE IS NOTHING TO SHOW
 *
 * Says so, plainly, and offers the way out. It does not invent zeroes and it does not show the previous
 * run's figures. A results screen with nothing behind it means something upstream went wrong, and
 * dressing that up as "0 gold, 0 kills" turns a visible bug into a player convinced they lost a run.
 *
 * WHAT IS DELIBERATELY MISSING
 *
 * The mock has a character portrait and an UNLOCKED row. Neither system exists yet — characters and
 * unlocks are later items — and drawing an empty frame for them would be worse than leaving the space to
 * the numbers that are real. They slot in above the buttons without moving anything else.
 *
 * FIDELITY: React Native stone kit, so the lettering swaps to `NightreapGlyph` when the atlas lands with
 * no layout change.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Sprite } from "@/components/sprite";
import { Chunk, Header, Mortar, Slab, StoneText, type StoneTextTone } from "@/components/stone";
import { portraitFrame } from "@/game/art/frames";
import { CHARACTERS } from "@/game/characters/roster";
import { TRACK } from "@/game/unlocks/awards";
import { Grid, Palette } from "@/constants/theme";
import { COUNT_MS, countDone, countValue } from "@/game/save/countup";
import { formatDuration, formatGold } from "@/game/save/payout";
import { describeRunEnd, isCompletion, RUN_END } from "@/game/sim/results";
import { runHandoff, type StagedResult } from "@/game/save/handoff";
import { AWARD_LIMIT, type AwardReport } from "@/game/unlocks/awards";

/**
 * The title plate wording.
 *
 * The distinction is the one the run-end labels already make and is not this screen's to reinterpret: the
 * White Hand and surviving the night are endings you reached, everything else is an ending that happened
 * to you. A player erased at thirty minutes by an unkillable Reaper had the best run of their week, and
 * "RUN FAILED" across the top of it is how you make them close the game.
 */
function titleFor(end: number): { title: string; tone: StoneTextTone } {
  if (isCompletion(end)) return { title: "RUN COMPLETE", tone: "gold" };
  if (end === RUN_END.quit) return { title: "RUN ABANDONED", tone: "ash" };
  if (end === RUN_END.disconnected) return { title: "RUN LOST", tone: "ash" };
  return { title: "RUN OVER", tone: "crimson" };
}

/** One of the four figures in the grid. */
function Tile({
  value,
  label,
  tone = "gold",
}: {
  value: string;
  label: string;
  tone?: StoneTextTone;
}): ReactNode {
  return (
    <Slab style={styles.tile}>
      <StoneText tone={tone} size={22} bold align="center">
        {value}
      </StoneText>
      <StoneText tone="ash" size={10} bold align="center">
        {label}
      </StoneText>
    </Slab>
  );
}

/**
 * One weapon's damage bar.
 *
 * The bar is drawn from the share the simulation already worked out, in permille, and the percentage next
 * to it is that same number — so the bar and the label cannot disagree. Shares are truncated upstream and
 * so can sum to slightly under 100%, which is honest; rounding one row up to make the column total look
 * tidy would not be.
 */
function DamageRow({ name, level, sharePermille }: { name: string; level: number; sharePermille: number }): ReactNode {
  const percent = Math.trunc(sharePermille / 10);
  return (
    <View style={styles.damageRow}>
      <View style={styles.damageName}>
        <StoneText tone="bone" size={11} bold>
          {name}
        </StoneText>
        <StoneText tone="ash" size={9}>
          {`LV ${level}`}
        </StoneText>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${Math.max(2, percent)}%` }]} />
      </View>
      <StoneText tone="ash" size={11} bold align="right" style={styles.damagePercent}>
        {`${percent}%`}
      </StoneText>
    </View>
  );
}

/**
 * The gold total, counting up from the balance the player already knew to the one they now have.
 *
 * The counting is a plain interval rather than `Animated`, because the thing being animated is the text
 * of a number and `Animated` cannot interpolate that — it would need a listener writing state on every
 * frame, which is the same work with more machinery. The arithmetic is not here: it is a tested pure
 * function, so the number cannot overshoot the balance or settle one gold short of it.
 */
function GoldCount({ from, to }: { from: number; to: number }): ReactNode {
  const [shown, setShown] = useState(() => countValue(from, to, 0));
  const started = useRef(0);

  useEffect(() => {
    // Re-armed whenever the endpoints change, so a remount does not freeze the number mid-count.
    setShown(countValue(from, to, 0));
    if (countDone(from, to, 0)) {
      setShown(countValue(from, to, COUNT_MS));
      return;
    }
    started.current = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - started.current;
      setShown(countValue(from, to, elapsed));
      if (countDone(from, to, elapsed)) clearInterval(timer);
    }, 33);
    return () => clearInterval(timer);
  }, [from, to]);

  return (
    <StoneText tone="gold" size={22} bold align="center">
      {formatGold(shown)}
    </StoneText>
  );
}

/**
 * What this run just opened up.
 *
 * The rows are read straight off the report the hand-off filled when the run was banked. This screen does
 * not decide whether anything was unlocked and cannot: an unlock is a bit in the profile, set the moment the
 * gold landed, and all that is left here is saying so once. The report holds at most sixteen rows, so a
 * profile that somehow earns more in one run is summarised rather than truncated in silence.
 */
function UnlockFace({ track, index }: { track: number; index: number }): ReactNode {
  const who = track === TRACK.CHARACTER ? CHARACTERS[index] : undefined;
  if (!who) return <View style={styles.unlockMark} />;
  return <Sprite name={portraitFrame(who.id)} size={Grid * 6} style={styles.unlockFace} />;
}

function UnlockBlock({ awards }: { awards: AwardReport }): ReactNode {
  if (awards.count === 0 && awards.overflow === 0) return null;
  const rows = Math.min(awards.count, AWARD_LIMIT);
  const total = awards.count + awards.overflow;
  return (
    <Slab style={styles.flourish} tint={Palette.violet}>
      <StoneText tone="violet" size={13} bold align="center">
        {total === 1 ? "NEW CHARACTER UNLOCKED" : `${total} NEW CHARACTERS UNLOCKED`}
      </StoneText>
      {Array.from({ length: rows }, (_, i) => (
        <View key={`${awards.tracks[i]}-${awards.indices[i]}`} style={styles.unlockRow}>
          {/* The face of whoever was just unlocked. A row from any other list, or an index this build does
              not have a character for, keeps the plain mark: a wrong face is worse than no face. */}
          <UnlockFace track={awards.tracks[i] ?? -1} index={awards.indices[i] ?? -1} />
          <View style={styles.unlockText}>
            <StoneText tone="bone" size={12} bold>
              {awards.names[i]}
            </StoneText>
            <StoneText tone="ash" size={9}>
              {awards.lines[i]}
            </StoneText>
          </View>
        </View>
      ))}
      {awards.overflow > 0 ? (
        <StoneText tone="ash" size={10} align="center">
          {`AND ${awards.overflow} MORE — SEE THE CHARACTER SCREEN`}
        </StoneText>
      ) : null}
      <StoneText tone="ash" size={9} align="center">
        Pick them on the character screen before your next run.
      </StoneText>
    </Slab>
  );
}

export default function ResultsScreen(): ReactNode {
  const router = useRouter();
  // Read once into state. Peeking on every render would be harmless today and would quietly become a bug
  // the moment anything else clears the slot mid-render.
  const [held] = useState<StagedResult | null>(() => runHandoff.peek());

  // Leaving is the moment the result is consumed. Both exits go through here so neither can forget.
  const leave = useCallback(
    (where: "/" | "/dev/play") => {
      runHandoff.take();
      router.replace(where);
    },
    [router],
  );

  if (held === null) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
        <Header title="NO RESULT" subtitle="THIS RUN WAS NOT BANKED" />
        <Slab style={styles.emptyBlock}>
          <StoneText tone="ash" size={12} align="center">
            Nothing reached this screen, so there is nothing to show. Your profile has not been changed.
          </StoneText>
        </Slab>
        <Chunk label="MAIN MENU" weight="stone" onPress={() => leave("/")} />
      </SafeAreaView>
    );
  }

  const { view, receipt, awards } = held;
  const { title, tone } = titleFor(view.end);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator>
        <View style={styles.titleBlock}>
          <StoneText tone={tone} size={24} bold align="center">
            {title}
          </StoneText>
          <StoneText tone="crimson" size={11} bold align="center">
            {describeRunEnd(view.end).toUpperCase()}
          </StoneText>
        </View>

        <View style={styles.grid}>
          <Tile value={formatDuration(view.seconds)} label="SURVIVED" />
          <Tile value={formatGold(view.kills)} label="SLAIN" tone="bone" />
        </View>

        <View style={styles.grid}>
          <Slab style={styles.tile}>
            <GoldCount from={receipt.goldBefore} to={receipt.goldAfter} />
            <StoneText tone="ash" size={10} bold align="center">
              {`GOLD  (+${formatGold(receipt.goldEarned)})`}
            </StoneText>
          </Slab>
          <Tile value={formatGold(view.levelReached)} label="LEVEL" tone="cyan" />
        </View>

        {receipt.newBestTime ? (
          <Slab style={styles.flourish} tint={Palette.gold}>
            <StoneText tone="gold" size={13} bold align="center">
              NEW BEST TIME
            </StoneText>
            <StoneText tone="ash" size={10} align="center">
              {`PREVIOUS BEST ${formatDuration(receipt.bestSecondsBefore)}`}
            </StoneText>
          </Slab>
        ) : null}

        {/* The ceiling is a real number in the save format, so hitting it is told plainly rather than
            silently pinning the total and letting the player wonder where their gold went. */}
        {receipt.goldCapped ? (
          <Slab style={styles.flourish} tint={Palette.crimson}>
            <StoneText tone="crimson" size={11} bold align="center">
              GOLD IS AT ITS MAXIMUM
            </StoneText>
            <StoneText tone="ash" size={10} align="center">
              Some of this run&apos;s gold could not be added. Spend some and it will fit again.
            </StoneText>
          </Slab>
        ) : null}

        <UnlockBlock awards={awards} />

        <Mortar />

        <StoneText tone="ash" size={11} bold align="center">
          DAMAGE DEALT
        </StoneText>
        <Slab style={styles.damageBlock}>
          {view.weapons.length === 0 ? (
            <StoneText tone="ash" size={11} align="center">
              No weapon dealt any damage.
            </StoneText>
          ) : (
            view.weapons.map((w) => (
              <DamageRow key={`${w.name}-${w.level}`} name={w.name} level={w.level} sharePermille={w.sharePermille} />
            ))
          )}
        </Slab>

        <Slab style={styles.footBlock}>
          <Foot label="TOTAL DAMAGE" value={formatGold(view.damageDealt)} />
          <Foot label="DAMAGE TAKEN" value={formatGold(view.damageTaken)} />
          <Foot label="UPGRADES TAKEN" value={formatGold(view.picksMade)} />
          {view.playerCount > 1 ? <Foot label="PARTY" value={`${view.playerCount} PLAYERS`} /> : null}
          {view.playerCount > 1 ? <Foot label="REVIVES" value={formatGold(view.revives)} /> : null}
          <Foot label="TIMES DOWNED" value={formatGold(view.downs)} />
          <Foot label="LIFETIME GOLD" value={formatGold(receipt.goldLifetimeAfter)} />
          <Foot label="RUNS FINISHED" value={formatGold(receipt.runsCompletedAfter)} />
        </Slab>

        {/* A dev-menu run is marked so a screenshot of it can never be mistaken for a clean one. */}
        {view.tainted !== 0 ? (
          <StoneText tone="crimson" size={10} bold align="center">
            DEV TOOLS WERE USED — THIS RUN IS NOT LEADERBOARD LEGAL
          </StoneText>
        ) : null}
      </ScrollView>

      <View style={styles.exits}>
        <Chunk label="PLAY AGAIN" weight="gold" style={styles.exit} onPress={() => leave("/dev/play")} />
        <Chunk label="MAIN MENU" weight="stone" style={styles.exit} onPress={() => leave("/")} />
      </View>
    </SafeAreaView>
  );
}

/** A label-and-number line in the small print block. */
function Foot({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <View style={styles.footRow}>
      <StoneText tone="ash" size={10}>
        {label}
      </StoneText>
      <StoneText tone="bone" size={10} bold>
        {value}
      </StoneText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Palette.crypt,
    paddingHorizontal: Grid * 2,
    gap: Grid,
  },
  body: {
    gap: Grid,
    paddingTop: Grid,
    paddingBottom: Grid * 2,
  },
  titleBlock: {
    gap: 2,
    paddingBottom: Grid / 2,
  },
  grid: {
    flexDirection: "row",
    gap: Grid,
  },
  tile: {
    flex: 1,
    paddingVertical: Grid * 1.5,
    gap: 2,
  },
  flourish: {
    paddingVertical: Grid,
    paddingHorizontal: Grid,
    gap: 2,
  },
  damageBlock: {
    padding: Grid,
    gap: Grid,
  },
  damageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid,
  },
  damageName: {
    width: Grid * 13,
  },
  barTrack: {
    flex: 1,
    height: Grid * 1.5,
    backgroundColor: Palette.ink,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
  },
  barFill: {
    height: "100%",
    backgroundColor: Palette.gold,
  },
  damagePercent: {
    width: Grid * 5,
  },
  unlockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid,
    paddingTop: 2,
  },
  unlockFace: {
    borderWidth: 1,
    borderColor: Palette.violet,
  },
  unlockMark: {
    width: Grid * 4,
    height: Grid * 4,
    backgroundColor: Palette.ink,
    borderWidth: 1,
    borderColor: Palette.violet,
  },
  unlockText: {
    flex: 1,
    gap: 1,
  },
  footBlock: {
    padding: Grid,
    gap: 3,
  },
  footRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  emptyBlock: {
    padding: Grid * 2,
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
