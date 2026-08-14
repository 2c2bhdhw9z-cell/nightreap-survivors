/**
 * Back up this profile, and pull in anything another phone did.
 *
 * This screen makes exactly one decision — when to start a sync — and every word it shows comes off the
 * report the sync layer filled in. No arithmetic, no "probably", no guessing at what happened from a code.
 * The rules are in `game/save/cloudsync.ts`, the network in `lib/cloud-sync.ts`, and both are somebody
 * else's problem from here.
 *
 * WHY IT ASKS BEFORE IT SYNCS
 *
 * Merging can make the visible gold balance go down. That is correct — a balance is rebuilt from lifetime
 * earnings minus what the shop is holding, and the other phone may have spent more — but a number going down
 * on its own looks like theft. So the first sync on a device is a button the player pressed, and the report
 * says plainly what changed. Automatic background syncing can come later, once players trust it.
 *
 * This is a stopgap route, like the shop and character screens: it lives at its own URL until there is a
 * title screen and a Settings page to reach it from.
 */

import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Chunk, Header, Mortar, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import { CLOUD, describeCloud, type CloudCode } from "@/game/save/cloudsync";
import { formatGold } from "@/game/save/payout";
import { syncNow, type SyncOutcome } from "@/lib/cloud-sync";
import { saveStore, useSettings } from "@/hooks/use-settings";

/** Whether an outcome is worth celebrating, worth shrugging at, or worth a warning colour. */
function toneFor(code: CloudCode): { tint: string; word: string } {
  switch (code) {
    case CLOUD.OK:
      return { tint: Palette.gold, word: "SYNCED" };
    case CLOUD.SEEDED:
      return { tint: Palette.gold, word: "BACKED UP" };
    case CLOUD.UP_TO_DATE:
      return { tint: Palette.stoneLit, word: "ALREADY UP TO DATE" };
    case CLOUD.KEPT_NOT_PUSHED:
      return { tint: Palette.stoneLit, word: "KEPT ON THIS PHONE" };
    case CLOUD.OFFLINE:
      return { tint: Palette.stoneLit, word: "NO CONNECTION" };
    default:
      return { tint: Palette.crimson, word: "SYNC DID NOT FINISH" };
  }
}

function Row({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <View style={styles.row}>
      <StoneText tone="ash" size={10}>
        {label}
      </StoneText>
      <StoneText tone="bone" size={10} bold>
        {value}
      </StoneText>
    </View>
  );
}

export default function CloudScreen(): ReactNode {
  const router = useRouter();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const start = useCallback(() => {
    if (busy || !settings.ready) return;
    setBusy(true);
    void (async () => {
      // The save time is passed in rather than read inside the sync layer, for the same reason as
      // everywhere else in this codebase: one clock, at the edge, never buried in a rule.
      const nowUnixSec = Math.floor(Date.now() / 1000);
      const result = await syncNow(settings.save, saveStore(), nowUnixSec);
      setOutcome(result);
      setBusy(false);
    })();
  }, [busy, settings.ready, settings.save]);

  const tone = outcome === null ? null : toneFor(outcome.code);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <Header title="BACKUP" subtitle="KEEP THIS PROFILE SAFE" />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator>
        <Slab style={styles.block}>
          <StoneText tone="ash" size={11}>
            Your profile is stored on this phone. Backing it up keeps a copy off the phone as well, and pulls
            in anything you unlocked on another one.
          </StoneText>
          <StoneText tone="ash" size={10}>
            Nothing is ever taken away by a backup. Unlocks, records and totals only ever go up.
          </StoneText>
        </Slab>

        <Chunk
          label={busy ? "WORKING…" : "BACK UP NOW"}
          weight="gold"
          onPress={start}
          style={styles.action}
        />

        {outcome !== null && tone !== null ? (
          <>
            <Slab style={styles.block} tint={tone.tint}>
              <StoneText tone="bone" size={13} bold align="center">
                {tone.word}
              </StoneText>
              <StoneText tone="ash" size={10} align="center">
                {describeCloud(outcome.code)}
              </StoneText>
            </Slab>

            {outcome.report.unlocksGained > 0 ? (
              <Slab style={styles.block} tint={Palette.violet}>
                <StoneText tone="violet" size={12} bold align="center">
                  {outcome.report.unlocksGained === 1
                    ? "1 NEW UNLOCK CAME ACROSS"
                    : `${outcome.report.unlocksGained} NEW UNLOCKS CAME ACROSS`}
                </StoneText>
                <StoneText tone="ash" size={10} align="center">
                  Have a look at the character screen.
                </StoneText>
              </Slab>
            ) : null}

            {/* Said out loud, before the player finds it themselves and assumes something was stolen. */}
            {outcome.report.goldDrops ? (
              <Slab style={styles.block} tint={Palette.crimson}>
                <StoneText tone="crimson" size={11} bold align="center">
                  YOUR GOLD BALANCE WENT DOWN
                </StoneText>
                <StoneText tone="ash" size={10}>
                  Your other phone had spent more in the shop than this one had. The upgrades it bought came
                  across with it, so nothing was lost — the balance is what is left after paying for them.
                </StoneText>
              </Slab>
            ) : null}

            <Mortar />

            <Slab style={styles.block}>
              <Row label="GOLD ON THIS PHONE" value={formatGold(outcome.report.merge.goldLocal)} />
              <Row label="GOLD IN THE BACKUP" value={formatGold(outcome.report.merge.goldRemote)} />
              <Row label="GOLD AFTER" value={formatGold(outcome.report.merge.goldMerged)} />
              <Row label="UNLOCKS AFTER" value={formatGold(outcome.report.merge.unlocksMerged)} />
              <Row label="KEPT ON THIS PHONE" value={outcome.report.kept ? "YES" : "NO"} />
              <Row label="BACKUP VERSION" value={`${outcome.report.storedGeneration}`} />
              <Row label="BACKUP NAME" value={outcome.accountId} />
            </Slab>

            <StoneText tone="ash" size={9}>
              Write the backup name down. Until accounts exist it is the only way to find this backup from
              another phone.
            </StoneText>
          </>
        ) : null}
      </ScrollView>

      <View style={styles.exits}>
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
  body: {
    gap: Grid,
    paddingTop: Grid,
    paddingBottom: Grid * 2,
  },
  block: {
    padding: Grid,
    gap: Grid / 2,
  },
  action: {
    width: "100%",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
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
