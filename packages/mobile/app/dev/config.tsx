/**
 * The dev menu's remote-config page: every switch, its state, and why it ended up there.
 *
 * This file draws and nothing else. Everything it looks like it decides lives somewhere testable:
 *
 *   what a switch answers, and why                `game/config/remote-config.ts`
 *   when a document goes stale, then expires      `game/config/remote-config.ts`
 *   whether forcing a switch by hand is allowed   `game/config/remote-config.ts`
 *   whether this page may open at all             `game/dev/devgate.ts`
 *   where the document is cached and fetched      `lib/remote-config-host.ts`
 *
 * WHY THIS PAGE EXISTS
 * Because "the feature is missing and nobody knows why" is otherwise unanswerable on a real device. A
 * flag can be off for eleven different reasons — killed, denied for this account, not in the rollout, a
 * document too old to trust, a build too old to honour the instruction — and they need completely
 * different responses. So the page shows the reason next to every switch, in the same words the plan
 * uses, and it shows the held document's revision, where it came from and how old it is.
 *
 * TWO TIERS ON ONE PAGE, ON PURPOSE
 * Reading is a read-only SYSTEM panel and costs the run nothing, so this page is safe to open mid-run
 * while chasing a bug. Forcing a switch by hand goes through a *separate*, writing panel and taints the
 * run. That split is the whole §5b rule in miniature: looking is free, changing is not.
 *
 * FORCING IS INTERNAL-ONLY AND THE MODULE ENFORCES IT, not this file: `setOverride` refuses on a public
 * build and returns false, so the controls grey out rather than pretending to work.
 *
 * FIDELITY: built from the React Native stone kit, so it inherits the approved look and the lettering
 * swaps to `NightreapGlyph` when the atlas lands with no layout change.
 */

import { Chunk, Cobble, Header, Mortar, Slab, StoneText } from "@/components/stone";
import { Grid, Palette } from "@/constants/theme";
import {
  APPLY,
  CONFIG_MAX_AGE_MS,
  CONFIG_TTL_MS,
  describeWhy,
  SOURCE,
  WHY,
  type ApplyCode,
  type FlagId,
  type WhyCode,
} from "@/game/config/remote-config";
import { panelCounts } from "@/game/dev/lint";
import { describeTaint, TAINT } from "@/game/replay/format";
import { devGate, onDevFlagsChange } from "@/lib/dev-gate-host";
import { configNow, fetchConfig, onConfigChange, remoteConfig } from "@/lib/remote-config-host";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** The panel that only looks. Opening it taints nothing, which is why the page opens mid-run. */
const READ_PANEL = "ops.config-readout";
/** The panel that forces a switch by hand. Opening it taints the run. */
const WRITE_PANEL = "ops.remote-config";

/** How often the age readout ticks over. Once a second: it is a clock, and a clock that lies is useless. */
const REFRESH_MS = 1000;

export default function RemoteConfigScreen(): ReactNode {
  const router = useRouter();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [fetching, setFetching] = useState(false);
  const [lastFetch, setLastFetch] = useState("");

  const gate = devGate();
  const state = remoteConfig();

  useEffect(() => {
    const timer = setInterval(redraw, REFRESH_MS);
    const stopConfig = onConfigChange(redraw);
    const stopFlags = onDevFlagsChange(redraw);
    return () => {
      clearInterval(timer);
      stopConfig();
      stopFlags();
    };
  }, []);

  /**
   * Opening is what taints, so the page announces itself to the gate exactly once, on the way in, rather
   * than on every redraw. Reading costs nothing, but an audit log with a thousand identical entries in it
   * is a log nobody can read.
   */
  useEffect(() => {
    gate.open(READ_PANEL);
  }, [gate]);

  const canRead = gate.reachable(READ_PANEL);

  const refresh = useCallback(() => {
    if (!gate.reachable(READ_PANEL)) return;
    setFetching(true);
    void fetchConfig().then((applied) => {
      setFetching(false);
      setLastFetch(applyLabel(applied));
      redraw();
    });
  }, [gate]);

  /**
   * Cycle a switch: automatic, then forced on, then forced off, then back. Three states rather than two,
   * because "I forced this off" and "this is off by itself" are different facts and a two-state control
   * cannot say which one you are looking at.
   */
  const cycle = useCallback(
    (id: FlagId, why: WhyCode) => {
      if (!gate.open(WRITE_PANEL).granted) return;
      const forced = why === WHY.LOCAL_OVERRIDE;
      const on = state.isOn(id, configNow());
      const next = !forced ? true : on ? false : undefined;
      state.setOverride(id, next);
      redraw();
    },
    [gate, state],
  );

  const clearForced = useCallback(() => {
    if (!gate.open(WRITE_PANEL).granted) return;
    state.clearOverrides();
    redraw();
  }, [gate, state]);

  const now = configNow();
  const rows = state.snapshot(now);
  const held = state.held !== undefined;
  const ageMs = state.ageMs(now);
  const stale = state.stale(now);
  const expired = state.expired(now);
  const forcedCount = state.overrideCount;
  const canForce = gate.reachable(WRITE_PANEL);
  const counts = panelCounts();

  if (!canRead) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Cobble style={styles.frame}>
          <Header title="DEV — REMOTE CONFIG" subtitle="UNAVAILABLE" />
          <Slab style={styles.notice}>
            <StoneText tone="crimson" size={12} bold>
              THIS PAGE IS NOT AVAILABLE IN THIS BUILD
            </StoneText>
            <StoneText tone="ash" size={11}>
              Remote config is a SYSTEM tool: it is absent from a public build rather than locked, and the
              dev menu itself can be switched off remotely.
            </StoneText>
          </Slab>
          <View style={styles.actions}>
            <Chunk label="BACK" weight="grey" onPress={() => router.back()} style={styles.action} />
          </View>
        </Cobble>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Cobble style={styles.frame}>
        <Header title="DEV — REMOTE CONFIG" subtitle="WHAT WE HAVE BEEN TOLD" />

        <Slab style={styles.statusRow}>
          <StoneText tone="ash" size={11}>
            {`CHANNEL ${gate.context.channel.toUpperCase()} · ${counts.system} SYSTEM / ${counts.self} SELF`}
          </StoneText>
          <StoneText tone={forcedCount === 0 ? "cyan" : "crimson"} size={11} bold>
            {forcedCount === 0 ? "NOTHING FORCED" : `${forcedCount} FORCED`}
          </StoneText>
        </Slab>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
          {/* ---- the document ------------------------------------------------------------------ */}
          <SectionTitle title="DOCUMENT" note="READ ONLY" />
          {held ? null : (
            <Slab style={styles.notice}>
              <StoneText tone="crimson" size={11} bold>
                NOTHING HELD
              </StoneText>
              <StoneText tone="ash" size={11}>
                Every switch below is answering with the default baked into this build — which is the
                shape a store build is submitted in, and the correct answer with no network.
              </StoneText>
            </Slab>
          )}
          <Slab style={styles.readout}>
            <Readout label="REVISION" value={held ? String(state.revision) : "—"} />
            <Readout label="SOURCE" value={sourceLabel(state.from)} />
            <Readout
              label="AGE"
              value={held ? duration(ageMs) : "—"}
              tone={expired ? "crimson" : stale ? "gold" : "bone"}
            />
            <Readout
              label="FRESHNESS"
              value={!held ? "—" : expired ? "EXPIRED — IGNORED" : stale ? "STALE — WILL REFETCH" : "FRESH"}
              tone={expired ? "crimson" : stale ? "gold" : "cyan"}
            />
            <Readout label="ASKS AGAIN AFTER" value={duration(CONFIG_TTL_MS)} />
            <Readout label="GIVES UP AFTER" value={duration(CONFIG_MAX_AGE_MS)} />
            <Readout label="ACCOUNT" value={state.account === "" ? "NONE YET" : state.account} />
            <Readout label="SWITCHES" value={`${rows.length} KNOWN TO THIS BUILD`} />
          </Slab>
          <StoneText tone="ash" size={10} style={styles.warnLine}>
            {state.account === ""
              ? "No account id yet, so a percentage rollout cannot place this device and answers off."
              : "Rollout position is fixed per account and per switch — raising a percentage only adds players."}
          </StoneText>

          {/* ---- the switches ------------------------------------------------------------------ */}
          <SectionTitle title="SWITCHES" note={canForce ? undefined : "FORCING UNAVAILABLE"} />
          {rows.map((row) => (
            <FlagRow
              key={row.id}
              id={row.id}
              on={row.on}
              why={row.why}
              canForce={canForce}
              onPress={() => cycle(row.id, row.why)}
            />
          ))}

          <Mortar style={styles.footerRule} />
          <StoneText tone="crimson" size={11} bold align="center">
            FORCING A SWITCH TAINTS THIS RUN — NO LEADERBOARDS
          </StoneText>
          <StoneText tone="ash" size={10} align="center" style={styles.footerSub}>
            {`READING DOES NOT — ${counts.readOnly} OF ${counts.self + counts.system} PANELS ARE READ-ONLY`}
          </StoneText>
          <StoneText tone="ash" size={10} align="center" style={styles.footerSub}>
            {`A FORCED SWITCH WOULD CARRY: ${describeTaint(TAINT.DEV_TOGGLE).toUpperCase()}`}
          </StoneText>
          <StoneText tone="ash" size={10} align="center" style={styles.footerSub}>
            None of this is a security measure. What a leaderboard, a room or a giveaway accepts is
            decided on our side, never here.
          </StoneText>

          <View style={styles.actions}>
            <Chunk
              label={fetching ? "ASKING…" : "ASK THE SERVER NOW"}
              weight="gold"
              onPress={refresh}
              disabled={fetching}
              style={styles.action}
            />
            <Chunk
              label="CLEAR FORCED"
              weight={forcedCount === 0 ? "stone" : "danger"}
              onPress={clearForced}
              disabled={!canForce || forcedCount === 0}
              style={styles.action}
            />
          </View>
          {lastFetch === "" ? null : (
            <StoneText tone="ash" size={10} align="center" style={styles.footerSub}>
              {`LAST ANSWER: ${lastFetch}`}
            </StoneText>
          )}
          <View style={styles.actions}>
            <Chunk label="BACK" weight="grey" onPress={() => router.back()} style={styles.action} />
          </View>
        </ScrollView>
      </Cobble>
    </SafeAreaView>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Pieces                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A section heading. Carries no taint tag: taint belongs to an individual control that writes something,
 * never to a region of the screen.
 */
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

function Readout({
  label,
  value,
  tone = "bone",
}: {
  label: string;
  value: string;
  tone?: "bone" | "crimson" | "gold" | "cyan";
}): ReactNode {
  return (
    <View style={styles.readoutRow}>
      <StoneText tone="ash" size={11}>
        {label}
      </StoneText>
      <StoneText tone={tone} size={11} bold>
        {value}
      </StoneText>
    </View>
  );
}

/**
 * One switch: its id, whether it is on, and the reason in the same plain words the plan uses.
 *
 * The reason is not a nicety. Off-because-killed and off-because-the-document-expired need opposite
 * responses, and a row that only said OFF would send somebody looking in the wrong place for an hour.
 */
function FlagRow({
  id,
  on,
  why,
  canForce,
  onPress,
}: {
  id: FlagId;
  on: boolean;
  why: WhyCode;
  canForce: boolean;
  onPress: () => void;
}): ReactNode {
  const forced = why === WHY.LOCAL_OVERRIDE;
  return (
    <Slab style={[styles.flagSlab, forced ? styles.flagForced : null]}>
      <View style={styles.flagText}>
        <View style={styles.flagHead}>
          <StoneText tone="bone" size={12} bold>
            {id}
          </StoneText>
          {forced ? (
            <StoneText tone="crimson" size={9} bold>
              FORCED
            </StoneText>
          ) : null}
        </View>
        <StoneText tone="ash" size={10}>
          {describeWhy(why)}
        </StoneText>
      </View>
      <View style={styles.flagRight}>
        <StoneText tone={on ? "cyan" : "ash"} size={12} bold>
          {on ? "ON" : "OFF"}
        </StoneText>
        <View style={styles.flagButton}>
          <Chunk
            label={forced ? (on ? "→OFF" : "→AUTO") : "→ON"}
            weight={forced ? "danger" : "stone"}
            onPress={onPress}
            disabled={!canForce}
          />
          {canForce ? (
            <StoneText tone="crimson" size={9} bold align="center">
              TAINTS
            </StoneText>
          ) : null}
        </View>
      </View>
    </Slab>
  );
}

/* ---- formatting --------------------------------------------------------------------------------- */

/** What the server's answer was worth. A refused older copy is the interesting case, so it is named. */
function applyLabel(applied: ApplyCode | undefined): string {
  if (applied === undefined) return "NO ANSWER";
  if (applied === APPLY.APPLIED) return "NEWER — APPLIED";
  if (applied === APPLY.SAME) return "SAME REVISION";
  return "OLDER — REFUSED";
}

function sourceLabel(from: number): string {
  if (from === SOURCE.FETCHED) return "FETCHED THIS SESSION";
  if (from === SOURCE.CACHED) return "CACHED ON THIS DEVICE";
  return "NONE";
}

/** Whole units only. A config age reported to the millisecond invites a precision nobody should trust. */
function duration(ms: number): string {
  if (ms < 1000) return `${ms} MS`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs} SEC`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} MIN`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} HR`;
  return `${Math.floor(hours / 24)} DAYS`;
}

/* ---------------------------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Palette.ink },
  frame: { flex: 1 },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Grid,
    paddingVertical: Grid / 2,
  },
  scroll: { flex: 1 },
  scrollBody: { paddingBottom: Grid * 4 },
  sectionTitle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: Grid * 2,
    marginBottom: Grid / 2,
    paddingHorizontal: Grid / 2,
  },
  notice: { padding: Grid, gap: Grid / 2, borderColor: Palette.crimson },
  readout: { padding: Grid },
  readoutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 2,
  },
  warnLine: { marginTop: Grid / 2, paddingHorizontal: Grid / 2 },
  flagSlab: {
    flexDirection: "row",
    alignItems: "center",
    padding: Grid,
    marginBottom: Grid / 2,
    gap: Grid,
  },
  flagForced: { borderColor: Palette.crimson },
  flagText: { flex: 1, gap: 2 },
  flagHead: { flexDirection: "row", alignItems: "center", gap: Grid / 2 },
  flagRight: { flexDirection: "row", alignItems: "center", gap: Grid / 2 },
  flagButton: { width: 78, gap: 2 },
  footerRule: { marginTop: Grid * 2, marginBottom: Grid },
  footerSub: { marginTop: 2 },
  actions: { flexDirection: "row", gap: Grid / 2, marginTop: Grid * 2 },
  action: { flex: 1 },
});
