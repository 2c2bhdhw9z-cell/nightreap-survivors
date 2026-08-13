/**
 * The dev menu's COOP tab — the co-op lab, on screen.
 *
 * This file draws and nothing else. Every rule it looks like it follows lives somewhere testable:
 *
 *   what a slider is allowed to be, and what it costs   `game/dev/coop-lab.ts`
 *   which faults exist and what each one taints         `game/dev/coop-lab.ts`
 *   what the readout says, and how a rate is worked out `game/dev/coop-lab.ts`
 *   who agrees with whom                                `game/dev/coop-lab.ts`
 *   whether this page may open at all                   `game/dev/devgate.ts`
 *
 * TWO THINGS WORTH KNOWING
 *
 * 1. Every panel here is SYSTEM tier, so this whole page is absent from a public build rather than
 *    merely locked. `lint.ts` fails the build if any `coop.*` panel is tiered any other way, and the
 *    gate — not this file — decides whether a control is live.
 *
 * 2. The page never touches a live session. It reads numbers through a probe function and it queues
 *    faults for whoever owns the session to carry out. A debugging tool that could reach into a run
 *    would eventually be the reason a run broke.
 *
 * FIDELITY: this is built from the React Native stone kit, so it inherits the approved look and the
 * lettering swaps to `NightreapGlyph` when the atlas lands, with no layout change.
 */

import { Chunk, Cobble, Header, Mortar, Slab, StoneText } from "@/components/stone";
import { Grid, Palette, PlayerColors } from "@/constants/theme";
import {
  AGREEMENT,
  createFaultRequest,
  createLinkReadout,
  FAULT,
  FAULT_LABEL,
  JITTER_MAX_MS,
  LATENCY_MAX_MS,
  LOSS_MAX_PCT,
  readLinkInto,
  ROLE,
  type FaultKind,
} from "@/game/dev/coop-lab";
import { panelCounts } from "@/game/dev/lint";
import { PROTOCOL_VERSION } from "@/game/net/protocol";
import { describeTaint } from "@/game/replay/format";
import { devGate } from "@/lib/dev-gate-host";
import {
  coopHashes,
  coopLab,
  onCoopProbeChange,
  readCoopSource,
} from "@/lib/coop-lab-host";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** How often the readout refreshes. Four times a second: fast enough to watch, slow enough to read. */
const REFRESH_MS = 250;

/** Slider steps. Coarse on purpose — the interesting values are decades, not single milliseconds. */
const LATENCY_STEP = 25;
const JITTER_STEP = 10;
const LOSS_STEP = 1;

export default function CoopLabScreen(): ReactNode {
  const router = useRouter();
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const lab = coopLab();
  const hashes = coopHashes();
  const readout = useMemo(createLinkReadout, []);
  const fault = useMemo(createFaultRequest, []);

  // One gate for the whole app, told what it is allowed to do by remote config. Not a local one: two
  // gates would mean two audit logs and two opinions about whether the current run is still clean.
  const gate = devGate();

  useEffect(() => {
    const timer = setInterval(redraw, REFRESH_MS);
    const stop = onCoopProbeChange(redraw);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, []);

  const source = readCoopSource();
  const live = source !== null;
  if (source !== null) readLinkInto(source, lab.impairment, readout);

  const counts = panelCounts();

  /** Opening a panel is what taints, so every control goes through the gate on the way in. */
  const openPanel = useCallback(
    (id: string): boolean => {
      const grant = gate.open(id);
      return grant.granted;
    },
    [gate],
  );

  const nudge = useCallback(
    (which: "latency" | "jitter" | "loss", delta: number) => {
      const id = which === "latency" ? "coop.latency" : which === "jitter" ? "coop.jitter" : "coop.loss";
      if (!openPanel(id)) return;
      const imp = lab.impairment;
      lab.setImpairment(
        which === "latency" ? imp.latencyMs + delta : imp.latencyMs,
        which === "jitter" ? imp.jitterMs + delta : imp.jitterMs,
        which === "loss" ? imp.lossPct + delta : imp.lossPct,
        imp.reorder,
      );
      redraw();
    },
    [lab, openPanel],
  );

  const toggleReorder = useCallback(() => {
    if (!openPanel("coop.jitter")) return;
    const imp = lab.impairment;
    lab.setImpairment(imp.latencyMs, imp.jitterMs, imp.lossPct, !imp.reorder);
    redraw();
  }, [lab, openPanel]);

  const fire = useCallback(
    (kind: FaultKind, panelId: string, slot = 0) => {
      if (!openPanel(panelId)) return;
      lab.requestFault(kind, slot);
      redraw();
    },
    [lab, openPanel],
  );

  const clearAll = useCallback(() => {
    lab.reset();
    hashes.reset();
    // Draining is normally the session owner's job; with no session there is nobody to drain the queue,
    // so a reset here would otherwise leave faults waiting to fire on the next run that starts.
    while (lab.takeFault(fault)) {
      /* discarded on purpose */
    }
    redraw();
  }, [lab, hashes, fault]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Cobble style={styles.frame}>
        <Header title="DEV — CRYPT PARTY LAB" subtitle="INTERNAL BUILD ONLY" />

        <Slab style={styles.statusRow}>
          <StoneText tone="ash" size={11}>
            {`CHANNEL ${gate.context.channel.toUpperCase()} · ${counts.system} SYSTEM / ${counts.self} SELF · ${counts.readOnly} READ-ONLY`}
          </StoneText>
          <StoneText tone={lab.clean ? "cyan" : "crimson"} size={11} bold>
            {lab.clean ? "RUN CLEAN" : "RUN TAINTED"}
          </StoneText>
        </Slab>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
          {/* ---- the readout ------------------------------------------------------------------ */}
          <SectionTitle title="LINK" note="READ ONLY" />
          {live ? null : (
            <Slab style={styles.notice}>
              <StoneText tone="crimson" size={11} bold>
                NO LIVE SESSION
              </StoneText>
              <StoneText tone="ash" size={11}>
                Numbers appear here once a party is in a run. Sliders and faults set now apply to the next
                session that starts.
              </StoneText>
            </Slab>
          )}
          <Slab style={styles.readout}>
            <Readout label="ROLE" value={live ? (readout.role === ROLE.HOST ? "HOST" : "GUEST") : "—"} />
            <Readout
              label="SEATS"
              value={live ? `${readout.liveSeats} LIVE / ${readout.heldSeats} HELD` : "—"}
            />
            <Readout label="PROTOCOL" value={`V${PROTOCOL_VERSION}`} />
            <Readout label="TICK" value={live ? String(readout.tick) : "—"} />
            <Readout
              label="RTT"
              value={live ? `${readout.rttP50} / ${readout.rttP95} / ${readout.rttWorst} MS` : "—"}
            />
            <Readout label="UP" value={live ? kbs(readout.upBytesPerSec) : "—"} />
            <Readout label="DOWN" value={live ? kbs(readout.downBytesPerSec) : "—"} />
            <Readout label="PREDICTED" value={live ? permille(readout.predictedPermille) : "—"} />
            <Readout label="RESYNCS" value={live ? String(readout.resyncs) : "—"} />
            <Readout
              label="MISMATCHES"
              value={live ? String(readout.mismatches) : "—"}
              tone={readout.mismatches > 0 ? "crimson" : "bone"}
            />
            <Readout label="STALLED" value={live ? `${readout.stalledTicks} TICKS` : "—"} />
            <Readout label="SNAPSHOT" value={live ? kb(readout.snapshotBytes) : "—"} />
          </Slab>
          {live && readout.impaired ? (
            <StoneText tone="crimson" size={11} bold style={styles.warnLine}>
              THESE NUMBERS ARE BEING DISTORTED BY THIS PAGE
            </StoneText>
          ) : null}

          {/* ---- impairment ------------------------------------------------------------------- */}
          <SectionTitle title="IMPAIRMENT" />
          <Slider
            label="ADDED LATENCY"
            value={lab.impairment.latencyMs}
            max={LATENCY_MAX_MS}
            display={`${lab.impairment.latencyMs} MS`}
            onLess={() => nudge("latency", -LATENCY_STEP)}
            onMore={() => nudge("latency", LATENCY_STEP)}
          />
          <Slider
            label="JITTER"
            value={lab.impairment.jitterMs}
            max={JITTER_MAX_MS}
            display={`${lab.impairment.jitterMs} MS`}
            onLess={() => nudge("jitter", -JITTER_STEP)}
            onMore={() => nudge("jitter", JITTER_STEP)}
          />
          <Slider
            label="PACKET LOSS"
            value={lab.impairment.lossPct}
            max={LOSS_MAX_PCT}
            display={`${lab.impairment.lossPct}%`}
            onLess={() => nudge("loss", -LOSS_STEP)}
            onMore={() => nudge("loss", LOSS_STEP)}
          />
          <Slab style={styles.switchRow}>
            <View style={styles.switchText}>
              <View style={styles.sliderLabel}>
                <StoneText tone="bone" size={12} bold>
                  ALLOW REORDERING
                </StoneText>
                <TaintTag />
              </View>
              <StoneText tone="ash" size={10}>
                Off by default: jitter delays packets but never lets one overtake another, so a bug found
                with it off is unambiguous.
              </StoneText>
            </View>
            <Chunk
              label={lab.impairment.reorder ? "ON" : "OFF"}
              weight={lab.impairment.reorder ? "danger" : "stone"}
              onPress={toggleReorder}
              style={styles.switchButton}
            />
          </Slab>

          {/* ---- faults ----------------------------------------------------------------------- */}
          <SectionTitle title="FAULTS" />
          <View style={styles.faultGrid}>
            <FaultButton
              label="FORCE DESYNC"
              kind={FAULT.FORCE_DESYNC}
              panelId="coop.desync"
              onFire={fire}
              fired={lab.firedCount(FAULT.FORCE_DESYNC)}
            />
            <FaultButton
              label="DROP A GUEST"
              kind={FAULT.DROP_GUEST}
              panelId="coop.drop"
              onFire={fire}
              fired={lab.firedCount(FAULT.DROP_GUEST)}
              slot={1}
            />
            <FaultButton
              label="MIGRATE HOST"
              kind={FAULT.MIGRATE_HOST}
              panelId="coop.migrate"
              onFire={fire}
              fired={lab.firedCount(FAULT.MIGRATE_HOST)}
            />
            <FaultButton
              label="STALL HOST 1S"
              kind={FAULT.STALL_HOST}
              panelId="coop.stall"
              onFire={fire}
              fired={lab.firedCount(FAULT.STALL_HOST)}
            />
            <FaultButton
              label="REPLAY DIVERGE"
              kind={FAULT.REPLAY_DIVERGE}
              panelId="coop.diverge"
              onFire={fire}
              fired={lab.firedCount(FAULT.REPLAY_DIVERGE)}
            />
          </View>
          <StoneText tone="ash" size={10} style={styles.warnLine}>
            {lab.pending === 0
              ? "Nothing queued. A fault is carried out by whoever owns the session, on its next frame."
              : `${lab.pending} QUEUED — waiting for the session to carry them out`}
          </StoneText>

          {/* ---- hashes ----------------------------------------------------------------------- */}
          <SectionTitle title="HASH COMPARISON" />
          <Slab style={styles.hashSlab}>
            <StoneText tone="ash" size={10} style={styles.hashHead}>
              {hashes.tick < 0 ? "NOTHING REPORTED YET" : `TICK ${hashes.tick} · THIS DEVICE IS THE REFERENCE`}
            </StoneText>
            {[0, 1, 2, 3].map((slot) => (
              <HashRow key={slot} slot={slot} compare={hashes} />
            ))}
          </Slab>

          <Mortar style={styles.footerRule} />
          <StoneText tone="crimson" size={11} bold align="center">
            WRITE TOGGLES TAINT THIS RUN — NO LEADERBOARDS
          </StoneText>
          <StoneText tone="ash" size={10} align="center" style={styles.footerSub}>
            {`READ-ONLY PANELS DO NOT TAINT — ${counts.readOnly} OF ${counts.self + counts.system}`}
          </StoneText>
          {lab.clean ? null : (
            <StoneText tone="ash" size={10} align="center" style={styles.footerSub}>
              {`THIS RUN CARRIES: ${describeTaint(lab.taintUsed()).toUpperCase()}`}
            </StoneText>
          )}

          <View style={styles.actions}>
            <Chunk label="CLEAR EVERYTHING" weight="stone" onPress={clearAll} style={styles.action} />
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
 * A section heading.
 *
 * Deliberately carries no taint tag. Taint is a property of an individual control that writes something,
 * not of a region of the screen, and a heading that says TAINTS above a group that contains a read-only
 * readout teaches the wrong thing about where the line is.
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

/** The mark a single write control carries. Only ever drawn on a control that actually writes. */
function TaintTag(): ReactNode {
  return (
    <StoneText tone="crimson" size={9} bold>
      TAINTS
    </StoneText>
  );
}

function Readout({
  label,
  value,
  tone = "bone",
}: {
  label: string;
  value: string;
  tone?: "bone" | "crimson";
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
 * A stepper, drawn as a filled track.
 *
 * Deliberately not a drag gesture: the useful values here are decades, a fat thumb on a phone cannot
 * hit 25ms reliably, and a slider that has to be nudged to an exact number is worse than two buttons.
 */
function Slider({
  label,
  value,
  max,
  display,
  onLess,
  onMore,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
  onLess: () => void;
  onMore: () => void;
}): ReactNode {
  const filled = max <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return (
    <Slab style={styles.sliderSlab}>
      <View style={styles.sliderHead}>
        <View style={styles.sliderLabel}>
          <StoneText tone="bone" size={12} bold>
            {label}
          </StoneText>
          <TaintTag />
        </View>
        <StoneText tone={value > 0 ? "gold" : "ash"} size={12} bold>
          {display}
        </StoneText>
      </View>
      <View style={styles.track}>
        <View style={[styles.trackFill, { width: `${filled}%` }]} />
      </View>
      <View style={styles.sliderButtons}>
        <Chunk label="−" weight="stone" onPress={onLess} style={styles.step} />
        <Chunk label="+" weight="stone" onPress={onMore} style={styles.step} />
      </View>
    </Slab>
  );
}

function FaultButton({
  label,
  kind,
  panelId,
  onFire,
  fired,
  slot = 0,
}: {
  label: string;
  kind: FaultKind;
  panelId: string;
  onFire: (kind: FaultKind, panelId: string, slot?: number) => void;
  fired: number;
  slot?: number;
}): ReactNode {
  return (
    <View style={styles.faultCell}>
      <Chunk label={label} weight="danger" onPress={() => onFire(kind, panelId, slot)} />
      <View style={styles.faultFoot}>
        <StoneText tone="ash" size={9}>
          {fired === 0 ? (FAULT_LABEL[kind] ?? "") : `FIRED ${fired}×`}
        </StoneText>
        <TaintTag />
      </View>
    </View>
  );
}

function HashRow({
  slot,
  compare,
}: {
  slot: number;
  compare: { agreementOf: (s: number) => number; hashOf: (s: number) => number; hasReported: (s: number) => boolean };
}): ReactNode {
  const identity = PlayerColors[slot];
  const state = compare.agreementOf(slot);
  const reported = compare.hasReported(slot);
  const mark = state === AGREEMENT.AGREE ? "OK" : state === AGREEMENT.DISAGREE ? "✕" : "—";
  const tone = state === AGREEMENT.AGREE ? "cyan" : state === AGREEMENT.DISAGREE ? "crimson" : "ash";
  return (
    <View style={styles.hashRow}>
      <View style={[styles.swatch, { backgroundColor: identity?.color ?? Palette.ash }]} />
      <StoneText tone="ash" size={11}>
        {`P${slot + 1}`}
      </StoneText>
      <StoneText tone={reported ? "bone" : "ash"} size={11} bold style={styles.hashValue}>
        {reported ? hex(compare.hashOf(slot)) : "NO REPORT"}
      </StoneText>
      <StoneText tone={tone} size={11} bold>
        {mark}
      </StoneText>
    </View>
  );
}

/* ---- formatting --------------------------------------------------------------------------------- */

function kbs(bytesPerSec: number): string {
  return `${(bytesPerSec / 1000).toFixed(1)} KB/S`;
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function permille(value: number): string {
  return `${(value / 10).toFixed(1)}%`;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
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
  sliderSlab: { padding: Grid, marginBottom: Grid / 2 },
  sliderHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sliderLabel: { flexDirection: "row", alignItems: "center", gap: Grid / 2 },
  track: {
    height: 10,
    marginVertical: Grid / 2,
    backgroundColor: Palette.ink,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
  },
  trackFill: { height: "100%", backgroundColor: Palette.gold },
  sliderButtons: { flexDirection: "row", gap: Grid / 2 },
  step: { flex: 1 },
  switchRow: { flexDirection: "row", alignItems: "center", padding: Grid, gap: Grid },
  switchText: { flex: 1, gap: 2 },
  switchButton: { width: 72 },
  faultGrid: { flexDirection: "row", flexWrap: "wrap", gap: Grid / 2 },
  faultCell: { width: "48%", gap: 2 },
  faultFoot: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Grid / 2,
  },
  hashSlab: { padding: Grid },
  hashHead: { marginBottom: Grid / 2 },
  hashRow: { flexDirection: "row", alignItems: "center", gap: Grid / 2, paddingVertical: 3 },
  swatch: { width: 10, height: 10, borderWidth: 1, borderColor: Palette.ink },
  hashValue: { flex: 1 },
  footerRule: { marginTop: Grid * 2, marginBottom: Grid },
  footerSub: { marginTop: 2 },
  actions: { flexDirection: "row", gap: Grid / 2, marginTop: Grid * 2 },
  action: { flex: 1 },
});
