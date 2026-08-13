/**
 * The PowerUps shop.
 *
 * Built from the approved mock `mocks/screen-powerups-shop-v1`: gold and a title across the top, one row
 * per upgrade with its icon, name, blurb, a pip row showing ranks owned, and a price plate — then REFUND
 * ALL and BACK at the bottom.
 *
 * THE RULE THIS FILE OBEYS: IT DOES NOT DECIDE ANYTHING
 *
 * Not one price, rank, lock or total on this screen is worked out here. Every number and every locked
 * reason comes from the shop rules, which are pure arithmetic with a test suite behind them. This file
 * reads them and draws them. That is what stops the two classic shop bugs: a row that shows a price
 * different from what it charges, and a row that looks affordable and then refuses.
 *
 * WRITES ARE CONFIRMED, NOT ASSUMED
 *
 * A purchase changes the profile in memory and is then written to storage. If the write fails, the screen
 * says so instead of quietly showing a rank the player does not actually own — a shop that shows purchases
 * it did not manage to store is how people learn not to trust a shop. The refusals from the rules layer
 * are shown in the player's words too, so "why can't I buy this" always has an answer on screen.
 *
 * REFUND IS BEHIND A CONFIRM
 *
 * It is the one destructive button in the whole game outside of wiping a save, and a stray thumb on a
 * phone should not be able to unwind an hour of decisions. It asks once, says exactly how much gold comes
 * back, and the confirm is the only gold-weight button in that state.
 *
 * FIDELITY: rows draw a placeholder mark where the powerup icon goes. The 24 icons already exist as loose
 * sprites; they become atlas cells in Phase 4 and drop into the same box without any layout moving.
 */

import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Chunk, Mortar, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import { formatGold } from "@/game/save/payout";
import {
  BUY,
  POWERUPS,
  buyRank,
  costOf,
  createBuyOutcome,
  lockStateOf,
  rankOf,
  refundAll,
  shopProgress,
  totalInvested,
  type BuyCode,
} from "@/game/shop/powerups";
import { saveStore, useSettings } from "@/hooks/use-settings";

/**
 * A refusal in the player's words.
 *
 * `TOO_EXPENSIVE` is the only one a player will ever see in normal play; the rest mean something is wrong
 * upstream, and each says enough to be reported rather than just "error".
 */
function refusalWords(code: BuyCode): string {
  switch (code) {
    case BUY.TOO_EXPENSIVE:
      return "Not enough gold.";
    case BUY.MAXED:
      return "That is already at its highest rank.";
    case BUY.LOCKED:
      return "That is still locked.";
    case BUY.BAD_SAVE:
      return "Your save holds a rank this version does not recognise. Nothing was charged.";
    case BUY.NO_SUCH_POWERUP:
      return "That upgrade does not exist in this version.";
    default:
      return "That could not be bought.";
  }
}

/** The rank pips. Filled for ranks owned, empty for ranks still for sale. */
function RankPips({ owned, total }: { owned: number; total: number }): ReactNode {
  const cells: ReactNode[] = [];
  for (let i = 0; i < total; i++) {
    cells.push(
      <View key={i} style={[styles.pip, i < owned ? styles.pipOn : styles.pipOff]} />,
    );
  }
  return <View style={styles.pipRow}>{cells}</View>;
}

export default function ShopScreen(): ReactNode {
  const router = useRouter();
  const { ready, save, loadFailed } = useSettings();
  // Bumped after every write so the rows re-read the save. The save object is mutated in place by the
  // rules layer, so a counter is what tells React that anything happened.
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [writeFailed, setWriteFailed] = useState(false);
  const [confirmRefund, setConfirmRefund] = useState(false);

  const persist = useCallback(() => {
    void (async () => {
      const result = await saveStore().save(save);
      setWriteFailed(!result.ok);
    })();
  }, [save]);

  const buy = useCallback(
    (index: number) => {
      const out = buyRank(save, index, createBuyOutcome());
      if (!out.bought) {
        setNotice(refusalWords(out.code));
        return;
      }
      setNotice("");
      setRevision((n) => n + 1);
      persist();
    },
    [save, persist],
  );

  const doRefund = useCallback(() => {
    const out = refundAll(save);
    setConfirmRefund(false);
    if (!out.refunded) {
      setNotice("There is nothing to refund.");
      return;
    }
    setNotice(
      out.capped
        ? `Refunded ${formatGold(out.goldReturned)} gold. Your purse was full, so ${formatGold(out.goldOwed - out.goldReturned)} could not fit.`
        : `Refunded ${formatGold(out.goldReturned)} gold across ${out.ranksCleared} ranks.`,
    );
    setRevision((n) => n + 1);
    persist();
  }, [save, persist]);

  // Referenced so the rows recompute when a purchase lands. The save is mutated in place, so without
  // reading the counter here nothing on this screen would know to redraw.
  void revision;
  const progress = shopProgress(save);
  const invested = totalInvested(save);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <Slab style={styles.top}>
        <StoneText tone="gold" size={18} bold>
          {formatGold(save.gold)}
        </StoneText>
        <StoneText tone="bone" size={16} bold>
          POWERUPS
        </StoneText>
        <StoneText tone="ash" size={10} bold>
          {`${progress.owned}/${progress.total}`}
        </StoneText>
      </Slab>

      {loadFailed ? (
        <StoneText tone="crimson" size={10} bold align="center">
          YOUR SAVE COULD NOT BE READ. NOTHING BOUGHT HERE WILL BE KEPT.
        </StoneText>
      ) : null}
      {writeFailed ? (
        <StoneText tone="crimson" size={10} bold align="center">
          THAT COULD NOT BE SAVED. CHECK YOUR STORAGE AND TRY AGAIN.
        </StoneText>
      ) : null}
      {notice !== "" ? (
        <StoneText tone="ash" size={11} align="center">
          {notice}
        </StoneText>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator>
        {POWERUPS.map((power, index) => {
          const rank = rankOf(save, index);
          const lock = lockStateOf(save, index);
          const price = rank < 0 ? -1 : costOf(power, rank);
          const maxed = rank >= power.maxRank;
          const affordable = price >= 0 && save.gold >= price;
          const dim = lock.locked || maxed || rank < 0;
          return (
            <Slab key={power.id} raised style={styles.row}>
              {/* FIDELITY: the powerup icon lands here as an atlas cell. */}
              <View style={styles.iconBox}>
                <StoneText tone={dim ? "ash" : "gold"} size={16} bold align="center">
                  {power.name.slice(0, 1)}
                </StoneText>
              </View>

              <View style={styles.rowText}>
                <StoneText tone={dim ? "ash" : "bone"} size={14} bold>
                  {power.name}
                </StoneText>
                <StoneText tone="ash" size={10}>
                  {lock.locked ? `${lock.reason} — ${lock.progress}/${lock.target}` : power.blurb}
                </StoneText>
                {rank < 0 ? (
                  <StoneText tone="crimson" size={10} bold>
                    UNREADABLE RANK
                  </StoneText>
                ) : (
                  <RankPips owned={rank} total={power.maxRank} />
                )}
              </View>

              {lock.locked ? (
                <View style={styles.priceBox}>
                  <StoneText tone="ash" size={11} bold align="center">
                    LOCKED
                  </StoneText>
                </View>
              ) : maxed ? (
                <View style={styles.priceBox}>
                  <StoneText tone="gold" size={11} bold align="center">
                    MAX
                  </StoneText>
                </View>
              ) : (
                <Chunk
                  label={formatGold(price)}
                  weight={affordable ? "gold" : "stone"}
                  disabled={!ready || !affordable}
                  style={styles.priceBox}
                  onPress={() => buy(index)}
                />
              )}
            </Slab>
          );
        })}
      </ScrollView>

      <Mortar />

      {confirmRefund ? (
        <View style={styles.exits}>
          <Chunk
            label={`RETURN ${formatGold(invested)}`}
            weight="gold"
            style={styles.exit}
            onPress={doRefund}
          />
          <Chunk label="KEEP THEM" weight="stone" style={styles.exit} onPress={() => setConfirmRefund(false)} />
        </View>
      ) : (
        <View style={styles.exits}>
          <Chunk
            label="REFUND ALL"
            weight="danger"
            disabled={!ready || invested === 0}
            style={styles.exit}
            onPress={() => {
              setNotice("");
              setConfirmRefund(true);
            }}
          />
          <Chunk label="BACK" weight="stone" style={styles.exit} onPress={() => router.back()} />
        </View>
      )}
      {confirmRefund ? (
        <StoneText tone="ash" size={10} align="center">
          {`Every rank is cleared and every coin comes back. ${progress.owned} ranks.`}
        </StoneText>
      ) : null}
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
    alignItems: "center",
    gap: Grid,
    padding: Grid,
  },
  iconBox: {
    width: Grid * 5,
    height: Grid * 5,
    backgroundColor: Palette.ink,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  pipRow: {
    flexDirection: "row",
    gap: 3,
  },
  pip: {
    width: 8,
    height: 8,
    borderWidth: 1,
  },
  pipOn: {
    backgroundColor: Palette.gold,
    borderColor: Palette.ink,
  },
  pipOff: {
    backgroundColor: Palette.ink,
    borderColor: Palette.stoneLit,
  },
  priceBox: {
    width: Grid * 11,
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

// Note: the rank dots above are deliberately NOT the co-op `Pips` widget. They happen to look similar, but
// `Pips` is player identity — reusing it here would mean a change to how players are identified silently
// changed what the shop looks like.
