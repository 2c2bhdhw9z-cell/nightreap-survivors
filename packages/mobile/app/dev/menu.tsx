/**
 * The dev menu shell: the one screen that lists every dev panel and opens them.
 *
 * This file draws and nothing else. Everything it looks like it decides lives somewhere testable:
 *
 *   which tabs exist, which are locked, what a row says   `game/dev/menu.ts`
 *   whether a panel may open at all, and what it costs     `game/dev/devgate.ts`
 *   the tier split and the taint bits themselves           `game/dev/registry.ts`
 *
 * WHY A SHELL AT ALL
 * Until now the panels were loose routes — you reached the bench by knowing its URL. That is fine for
 * two tools and useless for fifty-two, and it also meant the gate was consulted by whoever remembered
 * to consult it. Routing every panel through one list makes the gate unavoidable and makes "what tools
 * does this build have" a question with an answer.
 *
 * WHAT IT REFUSES TO INVENT
 * Not one count on this screen is written down. The approved mock says "SEARCH ALL 41 PANELS" and "8 OF
 * 41"; the registry has moved past both, which is exactly why the numbers are asked for at draw time.
 * The greyed state of a row and the reason next to it are the gate's answers, not this file's opinion.
 *
 * NOT EVERY PANEL IS BUILT YET
 * The registry is the plan; the pages are being written. A row whose page does not exist yet opens a
 * plain "not built yet" notice instead of silently doing nothing, because a dead button in your own
 * tools costs an hour of debugging the wrong thing. The gate is still consulted first, and the taint is
 * still applied — a panel that will taint says so before it exists.
 *
 * FIDELITY: built from the React Native stone kit, so it inherits the approved look and the lettering
 * swaps to `NightreapGlyph` when the atlas lands with no layout change.
 */

import { Chunk, Cobble, Header, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import {
  badgeIsWarning,
  buildMenuView,
  groupLabel,
  routeForPanel,
  runBadge,
  toggleFavourite,
  type MenuRow,
  type MenuTab,
} from "@/game/dev/menu";
import type { DevGroup } from "@/game/dev/registry";
import { devGate, onDevFlagsChange } from "@/lib/dev-gate-host";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function DevMenuScreen(): ReactNode {
  const router = useRouter();
  const gate = devGate();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [group, setGroup] = useState<DevGroup | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState("");

  // A kill published mid-session has to reach this screen, or a greyed-out row is a lie.
  useEffect(() => onDevFlagsChange(redraw), []);

  const view = useMemo(
    () => buildMenuView(gate, group, favourites, query),
    // `gate` is a stable singleton whose contents change under us; `redraw` is what re-runs this.
    [gate, group, favourites, query],
  );

  const openRow = useCallback(
    (row: MenuRow) => {
      // The gate first, always. Its refusal is the real one; the greyed row is only a preview of it.
      const grant = gate.open(row.id, Date.now());
      if (!grant.granted) {
        setNotice(`${row.label} — ${row.denyText || "refused"}`);
        return;
      }
      const route = routeForPanel(row.id);
      if (route === undefined) {
        setNotice(
          `${row.label} — page not built yet${grant.taintApplied !== 0 ? " (this run is now tainted)" : ""}`,
        );
        return;
      }
      setNotice("");
      router.push(route as never);
    },
    [gate, router],
  );

  const pin = useCallback((id: string) => {
    setFavourites((ids) => toggleFavourite(ids, id));
  }, []);

  const totals = view.totals;
  const channel = gate.context.channel.toUpperCase();
  const badge = runBadge(gate);
  const badgeBad = badgeIsWarning(badge);

  if (view.emptyReason !== "") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Cobble style={styles.frame}>
          <Header title="DEV MENU" subtitle="UNAVAILABLE" />
          <Slab style={styles.notice}>
            <StoneText tone="crimson" size={12} bold>
              NO DEV TOOLS IN THIS BUILD
            </StoneText>
            <StoneText tone="ash" size={11}>
              The dev menu is switched off. That is the shape a store build is submitted in, and it can
              also be switched off remotely — including on our own builds, on purpose, so a leaked one
              can be shut down.
            </StoneText>
          </Slab>
          <Chunk label="BACK" weight="grey" onPress={() => router.back()} style={styles.action} />
        </Cobble>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Cobble style={styles.frame}>
        <Header title="DEV MENU" subtitle={channel} />

        <Slab style={styles.statusRow}>
          <StoneText tone="ash" size={11}>
            {`CHANNEL ${channel}`}
          </StoneText>
          <StoneText tone={badgeBad ? "crimson" : "cyan"} size={11} bold>
            {badge}
          </StoneText>
        </Slab>

        {/* ---- search: the count is asked for, never written down ------------------------------- */}
        <Slab style={styles.searchRow}>
          <StoneText tone="ash" size={12}>
            {"⌕"}
          </StoneText>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={`SEARCH ALL ${totals.visible} PANELS`}
            placeholderTextColor={Palette.ash}
            style={styles.searchInput}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {query === "" ? null : (
            <Pressable onPress={() => setQuery("")} accessibilityRole="button">
              <StoneText tone="crimson" size={12} bold>
                X
              </StoneText>
            </Pressable>
          )}
        </Slab>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
          {/* ---- the tab strip: same shape on every build ------------------------------------- */}
          <View style={styles.tabStrip}>
            {view.tabs.map((tab) => (
              <TabButton
                key={tab.group}
                tab={tab}
                selected={tab.group === view.group && query === ""}
                onPress={() => {
                  setQuery("");
                  setGroup(tab.group);
                }}
              />
            ))}
          </View>

          {notice === "" ? null : (
            <Slab style={styles.notice}>
              <StoneText tone="gold" size={11} bold>
                {notice.toUpperCase()}
              </StoneText>
            </Slab>
          )}

          {view.favourites.length === 0 ? null : (
            <>
              <SectionTitle title="FAVOURITES" />
              <View style={styles.rowGrid}>
                {view.favourites.map((row) => (
                  <PanelRow key={`fav-${row.id}`} row={row} onOpen={openRow} onPin={pin} pinned />
                ))}
              </View>
            </>
          )}

          <SectionTitle
            title={query === "" ? groupLabel(view.group) : "RESULTS"}
            note={`${view.rows.length} ${view.rows.length === 1 ? "PANEL" : "PANELS"}`}
          />

          {view.rows.length === 0 ? (
            <Slab style={styles.notice}>
              <StoneText tone="ash" size={11}>
                {query === "" ? "NOTHING IN THIS TAB" : "NO PANEL MATCHES THAT"}
              </StoneText>
            </Slab>
          ) : (
            <View style={styles.rowGrid}>
              {view.rows.map((row) => (
                <PanelRow
                  key={row.id}
                  row={row}
                  onOpen={openRow}
                  onPin={pin}
                  pinned={favourites.includes(row.id)}
                />
              ))}
            </View>
          )}
        </ScrollView>

        {/* ---- the two honest footers ---------------------------------------------------------- */}
        {view.warnTaint ? (
          <Slab style={styles.warnBar}>
            <StoneText tone="crimson" size={11} bold align="center">
              WRITE TOGGLES TAINT THIS RUN — NO LEADERBOARDS
            </StoneText>
          </Slab>
        ) : null}
        <StoneText tone="ash" size={10} align="center" style={styles.footer}>
          {`READ-ONLY PANELS DO NOT TAINT — ${totals.visibleReadOnly} OF ${totals.visible}`}
        </StoneText>

        <Chunk label="BACK" weight="grey" onPress={() => router.back()} style={styles.action} />
      </Cobble>
    </SafeAreaView>
  );
}

/** A tab. A locked one stays on screen and says so, rather than vanishing between builds. */
function TabButton({
  tab,
  selected,
  onPress,
}: {
  tab: MenuTab;
  selected: boolean;
  onPress: () => void;
}): ReactNode {
  if (tab.locked) {
    return (
      <View style={[styles.tab, styles.tabLocked]}>
        <StoneText tone="crimson" size={11} bold>
          {`\u{1F512} ${tab.label}`}
        </StoneText>
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      style={[styles.tab, selected ? styles.tabSelected : null]}
    >
      <StoneText tone={selected ? "gold" : "bone"} size={11} bold>
        {tab.label}
      </StoneText>
    </Pressable>
  );
}

/**
 * One panel row.
 *
 * A refused row is greyed and still tappable, so tapping it produces the reason rather than nothing.
 * A row that will taint says TAINTS before you open it — the gate applies taint on open, not on use, so
 * the warning has to arrive before the tap.
 */
function PanelRow({
  row,
  onOpen,
  onPin,
  pinned,
}: {
  row: MenuRow;
  onOpen: (row: MenuRow) => void;
  onPin: (id: string) => void;
  pinned: boolean;
}): ReactNode {
  return (
    <Slab style={[styles.row, row.reachable ? null : styles.rowDim]}>
      <Pressable onPress={() => onOpen(row)} style={styles.rowMain} accessibilityRole="button">
        <StoneText tone={row.reachable ? "bone" : "ash"} size={12} bold>
          {row.label.toUpperCase()}
        </StoneText>
        {row.reachable ? null : (
          <StoneText tone="crimson" size={9}>
            {row.denyText.toUpperCase()}
          </StoneText>
        )}
      </Pressable>
      {row.taints && row.reachable ? (
        <StoneText tone="gold" size={9} bold>
          TAINTS
        </StoneText>
      ) : null}
      <Pressable onPress={() => onPin(row.id)} accessibilityRole="button" style={styles.pin}>
        <StoneText tone={pinned ? "gold" : "ash"} size={12} bold>
          {pinned ? "★" : "☆"}
        </StoneText>
      </Pressable>
    </Slab>
  );
}

function SectionTitle({ title, note }: { title: string; note?: string }): ReactNode {
  return (
    <View style={styles.sectionTitle}>
      <StoneText tone="gold" size={12} bold>
        {title}
      </StoneText>
      {note === undefined ? null : (
        <StoneText tone="ash" size={10}>
          {note}
        </StoneText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Palette.crypt },
  frame: { flex: 1, margin: Grid, padding: Grid },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Grid,
    paddingVertical: Grid,
    marginBottom: Grid,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid,
    paddingHorizontal: Grid,
    paddingVertical: Grid / 2,
    marginBottom: Grid,
  },
  searchInput: {
    flex: 1,
    color: Palette.boneLit,
    fontSize: 12,
    letterSpacing: 1,
    paddingVertical: Grid / 2,
  },
  scroll: { flex: 1 },
  scrollBody: { paddingBottom: Grid * 2, gap: Grid / 2 },
  tabStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Grid / 2,
    marginBottom: Grid,
  },
  tab: {
    paddingHorizontal: Grid * 1.5,
    paddingVertical: Grid,
    backgroundColor: Palette.stone,
    borderWidth: 2,
    borderColor: Palette.stoneLit,
  },
  tabSelected: { backgroundColor: Palette.stoneLit, borderColor: Palette.gold },
  tabLocked: { borderColor: Palette.crimson, opacity: 0.7 },
  sectionTitle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: Grid,
    marginBottom: Grid / 2,
  },
  rowGrid: { gap: Grid / 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Grid,
    paddingHorizontal: Grid,
    paddingVertical: Grid,
  },
  rowDim: { opacity: 0.6 },
  rowMain: { flex: 1 },
  pin: { paddingHorizontal: Grid / 2 },
  notice: { padding: Grid, gap: Grid / 2, marginBottom: Grid / 2 },
  warnBar: {
    paddingVertical: Grid,
    paddingHorizontal: Grid,
    marginTop: Grid / 2,
    borderColor: Palette.crimson,
  },
  footer: { marginTop: Grid / 2 },
  action: { marginTop: Grid },
});
