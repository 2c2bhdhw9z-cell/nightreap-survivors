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
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { useScreenAwake } from "@/hooks/use-screen-awake";
import { Link } from "expo-router";

import { FixedLoop, FrameTimer, TICK_MS } from "@/game/core/loop";
import { createDebugAtlas } from "@/game/render/atlas";
import { Renderer, type RendererStats } from "@/game/render/renderer";
import { QuadStorm } from "@/game/bench/quad-storm";
import {
  FlightRecorder,
  summariseFlight,
  type FlightLog,
} from "@/game/bench/flight-recorder";
import {
  APP_STATE,
  APP_STATE_LABEL,
  LifecycleProbe,
  MEM_TRIAL_MIN_SECONDS,
  type AppStateCode,
  type LifecycleSnapshot,
} from "@/game/bench/lifecycle";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  /**
   * Reciprocal of the median frame interval. This can read ABOVE the display's refresh rate and
   * still be honest: it is a median of intervals, not a count of frames. On a jittery stream a
   * frame that arrives late is followed by one that arrives early, and the median of those
   * intervals can land under 16.67ms even though the panel never showed more than 60 in a second.
   * Useful for spotting headroom, useless as an answer to "how smooth is it".
   */
  fps: number;
  /**
   * Frames actually issued per wall-clock second over the whole run. This is the number that
   * cannot exceed the refresh rate, and the one to trust when the two disagree.
   */
  realFps: number;
  droppedTicks: number;
  warmSeconds: number;
  bufferW: number;
  bufferH: number;
  scale: number;
  maxTexture: number;
  highp: boolean;
  /** What is actually rasterising. "SwiftShader"/"software" here explains a bad number outright. */
  gpu: string;
  /** Blended device pixels per frame, as a multiple of the drawing buffer. */
  overdraw: number;
  /** On-screen size multiplier applied to every quad, for the fill-rate bisection. */
  sizeScale: number;
  /** Sim ticks completed. tick/60 should track the warm clock; if it lags, the sim is stalling. */
  tick: number;
  /** Rendered frames the JS loop has issued. Alive JS, not necessarily alive GL. */
  frames: number;
  /** Ticks executed on the most recent frame. Steady state at 60fps render is 1. */
  ticksThisFrame: number;
  /** ms since the sim tick counter last changed. Anything over ~100 is a stall. */
  simStaleMs: number;
  /** Vertex bytes handed to GL last frame. Should be flat; growth means the batcher is leaking. */
  uploadBytes: number;
  /** JS heap MB where the engine reports it, else -1. Climbing = the OOM-kill explanation. */
  heapMb: number;
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
  realFps: 0,
  droppedTicks: 0,
  warmSeconds: 0,
  bufferW: 0,
  bufferH: 0,
  scale: 1,
  maxTexture: 0,
  highp: false,
  gpu: "?",
  overdraw: 0,
  sizeScale: 1,
  tick: 0,
  frames: 0,
  ticksThisFrame: 0,
  simStaleMs: 0,
  uploadBytes: 0,
  heapMb: -1,
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

/**
 * JS heap in MB, when the engine will tell us.
 *
 * Hermes does not implement `performance.memory`, so on iOS this usually returns -1 and the
 * flight recorder falls back to the upload-bytes and tick traces instead. It is read anyway
 * because on web (and on Hermes builds that do expose it) a climbing heap identifies a leak in
 * seconds rather than after a nine-minute wait for the OS to kill us.
 */
function heapMb(): number {
  const perf = globalThis.performance as unknown as
    | { memory?: { usedJSHeapSize?: number } }
    | undefined;
  const used = perf?.memory?.usedJSHeapSize;
  return typeof used === "number" ? used / (1024 * 1024) : -1;
}

export default function Bench() {
  // The screen locking is what invalidated four leak trials: a suspended app gets discarded by iOS
  // for reasons that have nothing to do with our memory use, and the flight log cannot tell that
  // apart from a real kill after the fact. Holding the display on removes the confound at the source
  // rather than detecting it later.
  useScreenAwake();

  const [count, setCount] = useState<number>(5000);
  const [hud, setHud] = useState(true);
  /**
   * Quad size multiplier. 1 is the gate scene. 0.5 quarters the pixels while submitting exactly
   * the same number of quads, which separates a fill-rate wall from a per-quad wall.
   */
  const [sizeScale, setSizeScale] = useState(1);
  const [readout, setReadout] = useState<Readout>(EMPTY);
  /**
   * Shown live rather than only in the post-mortem. The whole point of the warning counter is that
   * it lets a trial be ended on purpose — which is useless if the number is only legible after the
   * process dies.
   */
  const [life, setLife] = useState<LifecycleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<FlightLog | null>(null);
  const recorderRef = useRef<FlightRecorder | null>(null);
  const probeRef = useRef<LifecycleProbe | null>(null);

  // Recover the last run's tail before this one starts overwriting it. An OS kill leaves no error
  // and no chance to screenshot, so the previous flight is the only evidence we ever get.
  useEffect(() => {
    let live = true;
    void FlightRecorder.readPrevious(AsyncStorage).then((log) => {
      if (live) setPrevious(log);
    });
    return () => {
      live = false;
    };
  }, []);

  // Refs so control changes reach the running loop without tearing down the GL context.
  const countRef = useRef(count);
  const hudRef = useRef(hud);
  const sizeRef = useRef(sizeScale);
  const rafRef = useRef<number | null>(null);

  // One subscription for the screen's lifetime. Feeds whichever probe the current run created, so
  // the flight log can say whether a death happened in the foreground and whether iOS warned first.
  useEffect(() => {
    const onChange = AppState.addEventListener("change", (next) => {
      const code: AppStateCode =
        next === "active" ? APP_STATE.active : next === "inactive" ? APP_STATE.inactive : APP_STATE.background;
      probeRef.current?.setState(code, Date.now());
    });
    const onWarn = AppState.addEventListener("memoryWarning", () => {
      probeRef.current?.noteMemoryWarning(Date.now());
    });
    return () => {
      onChange.remove();
      onWarn.remove();
    };
  }, []);
  const stormRef = useRef<QuadStorm | null>(null);
  const timerRef = useRef<FrameTimer | null>(null);

  countRef.current = count;
  hudRef.current = hud;
  sizeRef.current = sizeScale;

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

      let stats: RendererStats = {
        quads: 0,
        drawCalls: 0,
        textureSwaps: 0,
        layerSwitches: 0,
        uploadBytes: 0,
      };
      let lastFrameStart = -1;
      let lastReport = 0;
      let frameErrors = 0;
      let lastError: string | null = null;
      let lastTickSeen = 0;
      let lastTickChangeAt = nowMs();
      // Wall clock for the warm timer only — it measures minutes, where 1ms resolution is fine.
      const startedAtWall = Date.now();

      const recorder = new FlightRecorder(
        AsyncStorage,
        `${Platform.OS} ${bufferW}x${bufferH}`,
        startedAtWall,
      );
      recorderRef.current = recorder;
      const probe = new LifecycleProbe(startedAtWall);
      probeRef.current = probe;
      let lastFlight = 0;

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
          storm.sizeScale = sizeRef.current;

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
            realFps: (() => {
              const elapsed = (Date.now() - startedAtWall) / 1000;
              return elapsed > 0 ? loop.stats.frames / elapsed : 0;
            })(),
            droppedTicks: loop.stats.droppedTicks,
            warmSeconds: Math.floor((Date.now() - startedAtWall) / 1000),
            bufferW,
            bufferH,
            scale: renderer.camera.scale,
            maxTexture: renderer.maxTextureSize,
            highp: renderer.hasHighp,
            gpu: renderer.gpuName,
            // World area -> device pixels -> multiples of the screen. Alpha-blended quads pay for
            // every layer they stack, so this is the number a tile-based mobile GPU actually feels.
            overdraw:
              (storm.submittedArea * renderer.camera.scale * renderer.camera.scale) /
              (bufferW * bufferH || 1),
            sizeScale: sizeRef.current,
            tick: loop.stats.tick,
            frames: loop.stats.frames,
            ticksThisFrame: loop.stats.ticksThisFrame,
            simStaleMs: now - lastTickChangeAt,
            uploadBytes: stats.uploadBytes,
            heapMb: heapMb(),
            frameErrors,
            lastError,
          });
        }

        // Snapshot to disk every 2s. Frequent enough to catch the trend, rare enough that the
        // instrument cannot be what makes the app miss frames.
        if (now - lastFlight >= 2000) {
          lastFlight = now;
          recorder.push({
            t: Math.floor((Date.now() - startedAtWall) / 1000),
            quads: stats.quads,
            tick: loop.stats.tick,
            frames: loop.stats.frames,
            p50: timer.percentile(0.5),
            p99: timer.percentile(0.99),
            droppedTicks: loop.stats.droppedTicks,
            uploadBytes: stats.uploadBytes,
            heapMb: heapMb(),
            simStaleMs: now - lastTickChangeAt,
            frameErrors,
            lastError,
            life: probe.snapshot(Date.now()),
          });
          setLife(probe.snapshot(Date.now()));
          void recorder.persist();
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
      // Marks the log clean, so next launch can tell "user left" from "the OS killed us".
      void recorderRef.current?.persist(true);
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
          {readout.realFps.toFixed(1)} fps sustained · {readout.fps.toFixed(1)} fps median-interval ·{" "}
          {readout.overBudgetPct.toFixed(1)}% over 16.7ms ·{" "}
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
        {/*
          The OOM trace. uploadBytes must be flat across the whole run — if it climbs, the batcher
          is handing native GL more data every frame and the process death is ours to fix. heap is
          -1 on Hermes, which is why uploadBytes carries the argument on iOS.
        */}
        <Text style={styles.row}>
          upload {(readout.uploadBytes / 1024).toFixed(0)}KB/frame ·{" "}
          {readout.heapMb >= 0 ? `heap ${readout.heapMb.toFixed(1)}MB` : "heap n/a (Hermes)"}
        </Text>
        {/*
          iOS warns before it kills. So this counter, not time-until-death, is the memory instrument:
          a full warm window in the foreground at zero warnings clears memory outright, and the run
          can be stopped by hand at that point without losing anything.
        */}
        <Text style={life && life.memWarn > 0 ? styles.error : styles.row}>
          {APP_STATE_LABEL[life?.state ?? APP_STATE.active]} · left foreground {life?.bgCount ?? 0}× (
          {((life?.bgMs ?? 0) / 1000).toFixed(0)}s) · {life?.memWarn ?? 0} mem warnings
          {life && life.memWarn > 0 ? ` (first ${life.firstMemWarnS}s)` : ""}
        </Text>
        <Text style={styles.dim}>
          {life && life.memWarn > 0
            ? "MEMORY PRESSURE IS REAL — the leak exists and the first-warning time bounds it"
            : readout.warmSeconds >= MEM_TRIAL_MIN_SECONDS && (life?.bgMs ?? 0) <= 30_000
              ? "MEMORY CLEARED — safe to stop now, a kill would add nothing"
              : `keep it foregrounded and awake for ${MEM_TRIAL_MIN_SECONDS / 60}m to clear memory`}
        </Text>
        <Text style={styles.dim}>
          {Platform.OS} · buffer {readout.bufferW}×{readout.bufferH} @{readout.scale}x · maxTex{" "}
          {readout.maxTexture} · {readout.highp ? "highp" : "mediump"}
        </Text>
        <Text style={isSoftwareGpu(readout.gpu) ? styles.error : styles.dim}>
          gpu: {readout.gpu}
          {isSoftwareGpu(readout.gpu) ? " — SOFTWARE RENDERING, no GPU, this number is void" : ""}
        </Text>
        <Text style={styles.dim}>
          overdraw {readout.overdraw.toFixed(1)}x screen · quad size {readout.sizeScale}x
          {readout.sizeScale !== 1 ? " (FILL TEST — not a gate number)" : ""}
        </Text>

        {previous && previous.samples.length > 0 ? (
          <View style={styles.prev}>
            <Text style={styles.prevTitle}>PREVIOUS RUN</Text>
            {summariseFlight(previous).map((line) => (
              <Text
                key={line}
                style={
                  line.startsWith("PREVIOUS RUN DIED") || line.startsWith("MEMORY IS CLIMBING")
                    ? styles.error
                    : styles.dim
                }
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}

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
          <Pressable
            onPress={() => {
              setSizeScale((v) => (v === 1 ? 0.5 : 1));
              resetMeasurement();
            }}
            style={[styles.btn, sizeScale !== 1 && styles.btnOn]}
          >
            <Text style={[styles.btnText, sizeScale !== 1 && styles.btnTextOn]}>HALF SIZE</Text>
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
  // The recovered flight log. Boxed off so it is obviously not live data.
  prev: {
    marginTop: 10,
    paddingTop: 8,
    gap: 2,
    borderTopWidth: 1,
    borderTopColor: Palette.stone,
  },
  prevTitle: { color: Palette.gold, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
});

/**
 * Chrome falls back to SwiftShader, its CPU rasteriser, on devices or drivers it does not trust.
 * The picture is identical and the speed is not, so a benchmark that does not check this can spend
 * a week optimising a renderer that was never touching the GPU.
 */
function isSoftwareGpu(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("swiftshader") || n.includes("software") || n.includes("llvmpipe");
}
