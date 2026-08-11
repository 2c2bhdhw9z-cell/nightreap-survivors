/**
 * Gate A harness — "can this device push 5,000 textured quads at 60fps, with a HUD, while warm?"
 *
 * This screen is an instrument, not a UI. It is deliberately unstyled beyond legibility and is not
 * subject to the mock-first rule; nothing here ships to players.
 *
 * HOW TO READ IT
 *  - p50 is how it feels, p99 is whether it stutters. 5,000 quads at p50 8ms and p99 40ms is a
 *    fail: bullet-heaven players notice one hitch a second immediately.
 *  - "over 16.7ms" is the share of the last 240 frames that missed 60fps. Under ~1% is clean.
 *  - WARM matters more than anything else on the panel. A cold REVVL flatters itself for about
 *    three minutes, then the SoC throttles. Only the number after ~15 minutes is real, which is
 *    why the warm clock is on screen and the verdict refuses to commit before then.
 *  - Dropped ticks mean the fixed loop hit its catch-up cap: the device is losing, not just late.
 *
 * The panel refreshes 4x a second, not per frame — a per-frame `setState` would have React
 * competing with the thing we are trying to measure.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { Link } from "expo-router";

import { FixedLoop, FrameTimer, TICK_MS } from "@/game/core/loop";
import { createDebugAtlas } from "@/game/render/atlas";
import { Renderer } from "@/game/render/renderer";
import { QuadStorm } from "@/game/bench/quad-storm";
import { Palette } from "@/constants/theme";

const PRESETS = [1000, 2500, 5000, 8000] as const;
const CAPACITY = 12000;
const FRAME_BUDGET_MS = 1000 / 60;
/** Minutes of sustained load before the verdict is trustworthy on a passively cooled phone. */
const WARM_MINUTES = 15;

interface Readout {
  quads: number;
  drawCalls: number;
  layerSwitches: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  overBudgetPct: number;
  fps: number;
  droppedTicks: number;
  warmSeconds: number;
  bufferW: number;
  bufferH: number;
  scale: number;
  maxTexture: number;
  highp: boolean;
  /** Sim ticks completed. tick/60 should track the warm clock; if it lags, the sim is stalling. */
  tick: number;
  /** Rendered frames the JS loop has issued. Alive JS, not necessarily alive GL. */
  frames: number;
  /** Ticks executed on the most recent frame. Steady state at 60fps render is 1. */
  ticksThisFrame: number;
  /** ms since the sim tick counter last changed. Anything over ~100 is a stall. */
  simStaleMs: number;
  /** Exceptions thrown inside the frame callback. Must stay 0. */
  frameErrors: number;
  lastError: string | null;
}

const EMPTY: Readout = {
  quads: 0,
  drawCalls: 0,
  layerSwitches: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  worst: 0,
  overBudgetPct: 0,
  fps: 0,
  droppedTicks: 0,
  warmSeconds: 0,
  bufferW: 0,
  bufferH: 0,
  scale: 1,
  maxTexture: 0,
  highp: false,
  tick: 0,
  frames: 0,
  ticksThisFrame: 0,
  simStaleMs: 0,
  frameErrors: 0,
  lastError: null,
};

/**
 * `Date.now()` has 1ms integer resolution, which cannot measure a 16.67ms budget — every percentile
 * came back as a flat "17.0ms", hiding all sub-millisecond jitter and making p50 and p99
 * indistinguishable. Frame timing has to come from a high-resolution monotonic clock.
 */
const nowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

export default function Bench() {
  const [count, setCount] = useState<number>(5000);
  const [hud, setHud] = useState(true);
  const [readout, setReadout] = useState<Readout>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  // Refs so control changes reach the running loop without tearing down the GL context.
  const countRef = useRef(count);
  const hudRef = useRef(hud);
  const rafRef = useRef<number | null>(null);
  const stormRef = useRef<QuadStorm | null>(null);
  const timerRef = useRef<FrameTimer | null>(null);

  countRef.current = count;
  hudRef.current = hud;

  const resetMeasurement = useCallback(() => {
    timerRef.current?.clear();
  }, []);

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    try {
      const renderer = new Renderer(gl);
      renderer.setClearColor(Palette.ink);
      const atlas = createDebugAtlas(gl);
      renderer.setAtlas(atlas);

      const bufferW = gl.drawingBufferWidth;
      const bufferH = gl.drawingBufferHeight;
      renderer.resize(bufferW, bufferH);

      const storm = new QuadStorm(atlas, CAPACITY);
      storm.setField(renderer.camera.worldViewW, renderer.camera.worldViewH);
      storm.setCount(countRef.current);
      stormRef.current = storm;

      // Camera parked at the field centre: every quad stays on screen, nothing gets culled.
      renderer.camera.snapTo(renderer.camera.worldViewW / 2, renderer.camera.worldViewH / 2);

      const timer = new FrameTimer(240);
      timerRef.current = timer;

      const loop = new FixedLoop(() => storm.tick());

      let stats = { quads: 0, drawCalls: 0, textureSwaps: 0, layerSwitches: 0 };
      let lastFrameStart = -1;
      let lastReport = 0;
      let frameErrors = 0;
      let lastError: string | null = null;
      let lastTickSeen = 0;
      let lastTickChangeAt = nowMs();
      // Wall clock for the warm timer only — it measures minutes, where 1ms resolution is fine.
      const startedAtWall = Date.now();

      const frame = () => {
        rafRef.current = requestAnimationFrame(frame);
        const now = nowMs();

        if (lastFrameStart >= 0) timer.push(now - lastFrameStart);
        lastFrameStart = now;

        // A throw here used to be invisible: rAF is rescheduled on the first line, so the loop kept
        // running while nothing rendered and the panel silently froze. Now it is counted and shown.
        try {
          if (storm.activeCount !== countRef.current) storm.setCount(countRef.current);
          storm.drawHud = hudRef.current;

          loop.advance(now);
          renderer.beginFrame(loop.stats.alpha);
          storm.draw(renderer, loop.stats.alpha);
          storm.drawHeartbeat(renderer, loop.stats.frames, loop.stats.tick);
          stats = renderer.endFrame();
          gl.endFrameEXP();
        } catch (e) {
          frameErrors++;
          lastError = e instanceof Error ? e.message : String(e);
        }

        if (loop.stats.tick !== lastTickSeen) {
          lastTickSeen = loop.stats.tick;
          lastTickChangeAt = now;
        }

        if (now - lastReport >= 250) {
          lastReport = now;
          const over = timer.countAbove(FRAME_BUDGET_MS + 0.5);
          const recorded = timer.samplesRecorded || 1;
          const p50 = timer.percentile(0.5);
          setReadout({
            quads: stats.quads,
            drawCalls: stats.drawCalls,
            layerSwitches: stats.layerSwitches,
            p50,
            p95: timer.percentile(0.95),
            p99: timer.percentile(0.99),
            worst: timer.percentile(1),
            overBudgetPct: (over / recorded) * 100,
            fps: p50 > 0 ? 1000 / p50 : 0,
            droppedTicks: loop.stats.droppedTicks,
            warmSeconds: Math.floor((Date.now() - startedAtWall) / 1000),
            bufferW,
            bufferH,
            scale: renderer.camera.scale,
            maxTexture: renderer.maxTextureSize,
            highp: renderer.hasHighp,
            tick: loop.stats.tick,
            frames: loop.stats.frames,
            ticksThisFrame: loop.stats.ticksThisFrame,
            simStaleMs: now - lastTickChangeAt,
            frameErrors,
            lastError,
          });
        }
      };

      rafRef.current = requestAnimationFrame(frame);
    } catch (e) {
      setError(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const warm = readout.warmSeconds >= WARM_MINUTES * 60;
  const clean = readout.p99 > 0 && readout.p99 <= FRAME_BUDGET_MS + 1 && readout.overBudgetPct < 1;
  // Two consecutive missed ticks. At 60Hz a healthy frame is never more than ~33ms behind a tick.
  const simStalled = readout.simStaleMs > 100 && readout.frames > 120;
  const verdict =
    readout.p50 === 0
      ? "measuring…"
      : simStalled
        ? "SIM STALLED — numbers are not valid"
        : !clean
        ? `MISSING 60fps at ${readout.quads} quads`
        : warm
          ? `HOLDING 60fps at ${readout.quads} quads (warm)`
          : `holding 60fps at ${readout.quads} quads — cold, keep running`;

  if (!webglAvailable()) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
        <ScrollView contentContainerStyle={styles.panelInner}>
          <Text style={[styles.verdict, { color: Palette.gold }]}>No WebGL on this browser</Text>
          <Text style={styles.row}>
            The benchmark needs a GPU context and this browser is not giving one out, so there is
            nothing to measure. Mounting GLView anyway would just crash the screen.
          </Text>
          <Text style={styles.dim}>
            This is expected in a headless or hardware-accelerated-disabled browser. Gate A is a
            hardware question anyway — run this on the phone through Expo Go, where expo-gl gets a
            real OpenGL ES context. Numbers from a software rasteriser would be meaningless.
          </Text>
          <View style={styles.controls}>
            <Link href="/" asChild>
              <Pressable style={styles.btn}>
                <Text style={styles.btnText}>back</Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
      <GLView style={styles.gl} onContextCreate={onContextCreate} />

      <ScrollView style={styles.panel} contentContainerStyle={styles.panelInner}>
        <Text style={[styles.verdict, { color: clean ? Palette.venom : Palette.crimsonLit }]}>
          {verdict}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {simStalled ? (
          <Text style={styles.error}>
            SIM STALLED — no tick for {readout.simStaleMs.toFixed(0)}ms. Sprites are frozen because
            the fixed loop stopped, not because the GPU did.
          </Text>
        ) : null}
        {readout.frameErrors > 0 ? (
          <Text style={styles.error}>
            {readout.frameErrors} frame errors · {readout.lastError}
          </Text>
        ) : null}

        <Text style={styles.row}>
          {fmt(readout.p50)} p50 · {fmt(readout.p95)} p95 · {fmt(readout.p99)} p99 ·{" "}
          {fmt(readout.worst)} worst
        </Text>
        <Text style={styles.row}>
          {readout.fps.toFixed(1)} fps · {readout.overBudgetPct.toFixed(1)}% over 16.7ms ·{" "}
          {readout.droppedTicks} dropped ticks
        </Text>
        <Text style={styles.row}>
          {readout.quads} quads · {readout.drawCalls} draws · {readout.layerSwitches} layers
        </Text>
        {/*
          sim vs real is the freeze detector that survives a screenshot: the sim clock is derived
          from the tick counter, the real clock from the wall. They must stay within a second of each
          other. If sim lags real, the loop stalled; if they match while sprites sit still, GL
          stopped presenting and the bug is below us in expo-gl.
        */}
        <Text style={styles.row}>
          sim {(readout.tick / 60).toFixed(1)}s / real {readout.warmSeconds}s · {readout.tick} ticks
          · {readout.ticksThisFrame}/frame · stale {readout.simStaleMs.toFixed(0)}ms
        </Text>
        <Text style={styles.dim}>
          warm {Math.floor(readout.warmSeconds / 60)}m{String(readout.warmSeconds % 60).padStart(2, "0")}s
          {warm ? " ✓" : ` / ${WARM_MINUTES}m`} · tick {TICK_MS.toFixed(2)}ms · {readout.frames}{" "}
          frames
        </Text>
        <Text style={styles.dim}>
          {Platform.OS} · buffer {readout.bufferW}×{readout.bufferH} @{readout.scale}x · maxTex{" "}
          {readout.maxTexture} · {readout.highp ? "highp" : "mediump"}
        </Text>

        <View style={styles.controls}>
          {PRESETS.map((n) => (
            <Pressable
              key={n}
              onPress={() => {
                setCount(n);
                resetMeasurement();
              }}
              style={[styles.btn, count === n && styles.btnOn]}
            >
              <Text style={[styles.btnText, count === n && styles.btnTextOn]}>{n}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setHud((v) => !v)} style={[styles.btn, hud && styles.btnOn]}>
            <Text style={[styles.btnText, hud && styles.btnTextOn]}>HUD</Text>
          </Pressable>
          <Pressable onPress={resetMeasurement} style={styles.btn}>
            <Text style={styles.btnText}>reset</Text>
          </Pressable>
          <Link href="/" asChild>
            <Pressable style={styles.btn}>
              <Text style={styles.btnText}>back</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

/**
 * On native this is always true — expo-gl owns a real GLES context. On web, GLView throws during
 * render when the browser hands back no context, which takes the whole screen down through the
 * error boundary and reports it as a crash rather than an unsupported browser.
 */
function webglAvailable(): boolean {
  if (Platform.OS !== "web") return true;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.ink },
  gl: { ...StyleSheet.absoluteFillObject },
  // Opaque, not translucent: the panel sits over 8,000 moving sprites and has to stay readable at
  // a glance. An unreadable instrument is a broken instrument.
  panel: {
    flexGrow: 0,
    maxHeight: 260,
    backgroundColor: Palette.ink,
    borderBottomWidth: 1,
    borderBottomColor: Palette.stoneLit,
  },
  panelInner: { padding: 12, gap: 4 },
  verdict: { fontSize: 15, fontWeight: "700" },
  row: { color: Palette.bone, fontSize: 13, fontVariant: ["tabular-nums"] },
  dim: { color: Palette.ash, fontSize: 11, fontVariant: ["tabular-nums"] },
  error: { color: Palette.crimsonLit, fontSize: 11 },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
    backgroundColor: Palette.crypt,
  },
  btnOn: { backgroundColor: Palette.gold, borderColor: Palette.goldLit },
  btnText: { color: Palette.bone, fontSize: 12, fontWeight: "600" },
  btnTextOn: { color: Palette.ink },
});
