/**
 * Leak isolation harness — "who is eating the memory: us, or expo-gl?"
 *
 * WHY THIS EXISTS
 * The Gate A bench now survives 844s (14m04s) on an iPhone 17 Pro Max and then gets killed by iOS
 * jetsam, with the sim on time the whole way and vertex upload flat at 528KB/frame. Flat upload
 * bytes means the growth is not our vertex data, and a healthy sim means it is not the game logic.
 * That leaves the per-frame GL calls themselves — and there is no way to read process RSS from
 * Hermes, so the only instrument available is *time until the OS kills us*.
 *
 * THE EXPERIMENT
 * Three modes, each stripping one more thing away, plus an amplifier that multiplies the work per
 * frame without changing what is on screen:
 *
 *   present : clear + endFrameEXP. No buffers, no draws, no uploads. The absolute floor.
 *   draw    : static geometry uploaded once, then drawElements every frame. No per-frame upload.
 *   upload  : bufferSubData every frame, then drawElements. The real batcher's pattern.
 *   layers  : five uniform2f camera writes per frame, each followed by its own drawElements.
 *
 * `layers` was added after present/draw/upload all survived 32-35 minutes on an iPhone 17 Pro Max
 * while the real bench died at 844s. Those three modes never touch a uniform, but the renderer
 * rewrites the camera uniform once per layer — five times a frame — which makes uniform marshalling
 * the last untested difference between the harness that lives and the bench that dies.
 *
 * HOW TO READ THE RESULT
 *   - `present` dies too            -> the leak is inside expo-gl's frame presentation. Not fixable
 *                                      from `game/render/`. Gate A fails; pivot to native Skia.
 *   - only `upload` dies            -> per-frame bufferSubData is the culprit. Fixable: persistent
 *                                      buffer, fewer flushes, or double-buffered VBOs.
 *   - `draw` and `upload` both die  -> per-draw-call marshalling. Fixable by cutting draw calls.
 *   - amplifier shortens death time -> the leak scales with bytes or calls, which names the unit.
 *     Death time unchanged by the amplifier -> it leaks per *frame*, not per call.
 *
 * Amplifying is what makes this practical: at 14 minutes a trial, a 16x amplifier that dies in ~50s
 * turns a full afternoon of waiting into a few minutes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { Link } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { FlightRecorder, summariseFlight, type FlightLog } from "@/game/bench/flight-recorder";
import { compileSpriteProgram } from "@/game/render/shader";
import { Palette } from "@/constants/theme";

type Mode = "present" | "draw" | "upload" | "layers";
const MODES: Mode[] = ["present", "draw", "upload", "layers"];

/**
 * Layer switches per frame in `layers` mode, matching the renderer's real stack: five world/screen
 * layers, each costing one `uniform2f` camera write plus its own `drawElements`.
 */
const LAYERS_PER_FRAME = 5;
const AMPS = [1, 4, 16] as const;

/** 2,000 quads is enough geometry to be representative without being the thing under test. */
const QUADS = 2000;
const VERTS_PER_QUAD = 4;
const BYTES_PER_VERT = 16;

const flightKey = (mode: Mode, amp: number) => `nightreap.leak.${mode}.x${amp}.v1`;

const nowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

export default function Leak() {
  const [mode, setMode] = useState<Mode>("present");
  const [amp, setAmp] = useState<number>(1);
  const [armed, setArmed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [frames, setFrames] = useState(0);
  const [bytesPerFrame, setBytesPerFrame] = useState(0);
  const [callsPerFrame, setCallsPerFrame] = useState(0);
  const [previous, setPrevious] = useState<FlightLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<FlightRecorder | null>(null);

  // Read the selected trial's last flight before arming, so the verdict for that exact
  // mode+amplifier combination is on screen while choosing the next one.
  useEffect(() => {
    let live = true;
    setPrevious(null);
    void FlightRecorder.readPrevious(AsyncStorage, flightKey(mode, amp)).then((log) => {
      if (live) setPrevious(log);
    });
    return () => {
      live = false;
    };
  }, [mode, amp]);

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      try {
        const prog = compileSpriteProgram(gl);
        const vertexCount = QUADS * VERTS_PER_QUAD;
        const byteLength = vertexCount * BYTES_PER_VERT;

        const staging = new ArrayBuffer(byteLength);
        const f32 = new Float32Array(staging);
        const u16 = new Uint16Array(staging);
        const u32 = new Uint32Array(staging);
        const upload = new Uint8Array(staging);

        // Fill once with a static grid. The contents never matter here — only the cost of moving
        // them does — so nothing is recomputed per frame and the sim is entirely absent.
        const cols = 50;
        for (let q = 0; q < QUADS; q++) {
          const x = (q % cols) * 24;
          const y = Math.floor(q / cols) * 24;
          for (let v = 0; v < 4; v++) {
            const fi = (q * 4 + v) * 4;
            const si = (q * 4 + v) * 8;
            const ci = (q * 4 + v) * 4;
            f32[fi] = x + (v === 1 || v === 2 ? 20 : 0);
            f32[fi + 1] = y + (v >= 2 ? 20 : 0);
            u16[si + 4] = v === 1 || v === 2 ? 65535 : 0;
            u16[si + 5] = v >= 2 ? 65535 : 0;
            u32[ci + 3] = 0xff5ad4e0;
          }
        }

        const indices = new Uint16Array(QUADS * 6);
        for (let q = 0; q < QUADS; q++) {
          const v = q * 4;
          const i = q * 6;
          indices[i] = v;
          indices[i + 1] = v + 1;
          indices[i + 2] = v + 2;
          indices[i + 3] = v + 2;
          indices[i + 4] = v + 3;
          indices[i + 5] = v;
        }

        const vbo = gl.createBuffer();
        const ibo = gl.createBuffer();
        if (!vbo || !ibo) throw new Error("gl.createBuffer returned null");

        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, staging, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        // A 1x1 white texture: enough to satisfy the sampler without an atlas in the picture.
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          1,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array([255, 255, 255, 255]),
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.useProgram(prog.program);
        gl.enableVertexAttribArray(prog.aPos);
        gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, BYTES_PER_VERT, 0);
        gl.enableVertexAttribArray(prog.aUv);
        gl.vertexAttribPointer(prog.aUv, 2, gl.UNSIGNED_SHORT, true, BYTES_PER_VERT, 8);
        gl.enableVertexAttribArray(prog.aColor);
        gl.vertexAttribPointer(prog.aColor, 4, gl.UNSIGNED_BYTE, true, BYTES_PER_VERT, 12);
        gl.uniform2f(prog.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.uniform1f(prog.uScale, 2);
        gl.uniform2f(prog.uCamera, 0, 0);
        gl.uniform1i(prog.uTex, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0.08, 0.08, 0.13, 1);

        const currentMode = mode;
        const currentAmp = amp;
        const perFrameBytes = currentMode === "upload" ? byteLength * currentAmp : 0;
        const perFrameCalls =
          currentMode === "present"
            ? 0
            : currentMode === "layers"
              ? currentAmp * LAYERS_PER_FRAME
              : currentAmp;
        setBytesPerFrame(perFrameBytes);
        setCallsPerFrame(perFrameCalls);

        const startedAtWall = Date.now();
        const recorder = new FlightRecorder(
          AsyncStorage,
          `${Platform.OS} ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} ${currentMode} x${currentAmp}`,
          startedAtWall,
          flightKey(currentMode, currentAmp),
        );
        recorderRef.current = recorder;

        let frameCount = 0;
        let lastFrameStart = -1;
        let lastFlight = 0;
        let lastUi = 0;
        let worst = 0;

        const frame = () => {
          rafRef.current = requestAnimationFrame(frame);
          const t = nowMs();
          if (lastFrameStart >= 0) {
            const dt = t - lastFrameStart;
            if (dt > worst) worst = dt;
          }
          lastFrameStart = t;
          frameCount++;

          gl.clear(gl.COLOR_BUFFER_BIT);

          if (currentMode === "layers") {
            // Camera uniform rewritten per layer, exactly as Renderer.layer() does. The value
            // changes every frame so the driver cannot short-circuit a redundant upload.
            for (let i = 0; i < currentAmp; i++) {
              for (let l = 0; l < LAYERS_PER_FRAME; l++) {
                gl.uniform2f(prog.uCamera, (frameCount + l) % 64, l * 8);
                gl.drawElements(gl.TRIANGLES, QUADS * 6, gl.UNSIGNED_SHORT, 0);
              }
            }
          } else if (currentMode !== "present") {
            for (let i = 0; i < currentAmp; i++) {
              if (currentMode === "upload") {
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, upload);
              }
              gl.drawElements(gl.TRIANGLES, QUADS * 6, gl.UNSIGNED_SHORT, 0);
            }
          }

          gl.endFrameEXP();

          const secs = Math.floor((Date.now() - startedAtWall) / 1000);

          if (t - lastUi >= 500) {
            lastUi = t;
            setElapsed(secs);
            setFrames(frameCount);
          }

          if (t - lastFlight >= 2000) {
            lastFlight = t;
            recorder.push({
              t: secs,
              quads: currentMode === "present" ? 0 : QUADS * perFrameCalls,
              tick: secs * 60,
              frames: frameCount,
              p50: secs > 0 ? (secs * 1000) / frameCount : 0,
              p99: worst,
              droppedTicks: 0,
              uploadBytes: perFrameBytes,
              heapMb: -1,
              simStaleMs: 0,
              frameErrors: 0,
              lastError: null,
            });
            worst = 0;
            void recorder.persist();
          }
        };

        rafRef.current = requestAnimationFrame(frame);
      } catch (e) {
        setError(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
      }
    },
    [mode, amp],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void recorderRef.current?.persist(true);
    };
  }, []);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
      {armed ? (
        <GLView
          // Remounting on mode change would leak contexts of its own and muddy the very thing being
          // measured, so the key forces a clean teardown between trials.
          key={`${mode}-${amp}`}
          style={styles.gl}
          onContextCreate={onContextCreate}
        />
      ) : null}

      <ScrollView style={styles.panel} contentContainerStyle={styles.panelInner}>
        <Text style={styles.title}>LEAK ISOLATION</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {armed ? (
          <>
            <Text style={styles.big}>
              {Math.floor(elapsed / 60)}m{String(elapsed % 60).padStart(2, "0")}s alive
            </Text>
            <Text style={styles.row}>
              {mode} ×{amp} · {frames} frames · {(bytesPerFrame / 1024).toFixed(0)}KB/frame ·{" "}
              {callsPerFrame} draws/frame
            </Text>
            <Text style={styles.dim}>
              Let it die. Reopen this screen with the same mode selected and read PREVIOUS RUN.
            </Text>
          </>
        ) : (
          <Text style={styles.dim}>
            Pick a mode and an amplifier, then arm it. Each combination keeps its own log, so trials
            never overwrite each other. Baseline reference: the full Gate A bench died at 844s.
          </Text>
        )}

        <View style={styles.controls}>
          {MODES.map((m) => (
            <Pressable
              key={m}
              onPress={() => {
                setMode(m);
                setArmed(false);
              }}
              style={[styles.btn, mode === m && styles.btnOn]}
            >
              <Text style={[styles.btnText, mode === m && styles.btnTextOn]}>{m}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.controls}>
          {AMPS.map((a) => (
            <Pressable
              key={a}
              onPress={() => {
                setAmp(a);
                setArmed(false);
              }}
              style={[styles.btn, amp === a && styles.btnOn]}
            >
              <Text style={[styles.btnText, amp === a && styles.btnTextOn]}>×{a}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setArmed(true)} style={[styles.btn, armed && styles.btnOn]}>
            <Text style={[styles.btnText, armed && styles.btnTextOn]}>
              {armed ? "running" : "ARM"}
            </Text>
          </Pressable>
          <Link href="/" asChild>
            <Pressable style={styles.btn}>
              <Text style={styles.btnText}>back</Text>
            </Pressable>
          </Link>
        </View>

        {previous && previous.samples.length > 0 ? (
          <View style={styles.prev}>
            <Text style={styles.prevTitle}>
              PREVIOUS RUN — {mode} ×{amp}
            </Text>
            {summariseFlight(previous).map((line) => (
              <Text
                key={line}
                style={line.startsWith("PREVIOUS RUN DIED") ? styles.error : styles.dim}
              >
                {line}
              </Text>
            ))}
          </View>
        ) : (
          <View style={styles.prev}>
            <Text style={styles.prevTitle}>
              PREVIOUS RUN — {mode} ×{amp}
            </Text>
            <Text style={styles.dim}>no trial recorded for this combination yet</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.ink },
  gl: { ...StyleSheet.absoluteFillObject },
  panel: {
    flexGrow: 0,
    maxHeight: 340,
    backgroundColor: Palette.ink,
    borderBottomWidth: 1,
    borderBottomColor: Palette.stoneLit,
  },
  panelInner: { padding: 12, gap: 4 },
  title: { color: Palette.gold, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  big: { color: Palette.bone, fontSize: 22, fontWeight: "700", fontVariant: ["tabular-nums"] },
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
  prev: { marginTop: 10, paddingTop: 8, gap: 2, borderTopWidth: 1, borderTopColor: Palette.stone },
  prevTitle: { color: Palette.gold, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
});
