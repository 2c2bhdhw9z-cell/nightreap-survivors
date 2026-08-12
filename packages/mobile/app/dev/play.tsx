/**
 * The first playable screen — the whole engine wired to a thumb.
 *
 * Everything under `game/` has been proven in isolation by headless tests: the crowd, the weapons,
 * the pickups, the level curve, the card screen, the results. This screen is the first place all of
 * it runs at once with a human in the loop. It exists to answer one question the tests cannot:
 * does moving around and killing things feel like anything?
 *
 * It is an instrument, not shipping UI. The placeholder debug atlas draws coloured blobs, the
 * numbers are plain React Native text, and none of this survives the art pass. It is deliberately
 * not subject to the mock-first rule for that reason.
 *
 * HOW THE FRAME IS STRUCTURED
 *  - The simulation runs at a fixed 60Hz through `FixedLoop`. Rendering happens as often as the
 *    display allows and interpolates between the last two ticks, so a 120Hz phone looks smoother
 *    without the game running faster.
 *  - Input is written into the run once per *tick*, never per frame. A stick read twice in one tick
 *    would make movement frame-rate dependent, which would break replay determinism.
 *  - Layers are submitted strictly in `LAYERS` order. The renderer throws on a violation on
 *    purpose; discovering the order is wrong here is much cheaper than discovering it in a run.
 *  - React state is touched at most four times a second, plus once whenever the card screen or the
 *    run's outcome actually changes. Per-frame `setState` would have React competing with the game.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  PanResponder,
  type GestureResponderEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { Link } from "expo-router";

import { useScreenAwake } from "@/hooks/use-screen-awake";
import { Palette } from "@/constants/theme";

import { FixedLoop } from "@/game/core/loop";
import { createDebugAtlas, type Atlas } from "@/game/render/atlas";
import { Renderer } from "@/game/render/renderer";
import { Ground, type FrameSource, type GroundTheme } from "@/game/render/ground";
import { Run } from "@/game/run/run";
import { STAT, STAT_SCALE } from "@/game/sim/stats";
import { MOD_HURRY, MOD_HYPER } from "@/game/sim/modifiers";
import { PICKUP } from "@/game/sim/pickups";
import { ENEMY_FLAG } from "@/game/sim/enemies";
import { MAX_WEAPONS, WEAPON_TYPES } from "@/game/sim/weapons";
import { PLAYER_STATE } from "@/game/sim/player";
import { RUN_END, formatRunTime } from "@/game/sim/results";
import { OFFERS_PER_SCREEN } from "@/game/sim/cards";

/** On-screen radius of the thumbstick, in layout points. Sized for a thumb, not a mouse. */
const STICK_RADIUS_DP = 76;
/** Distance from the screen's bottom-left corner to the stick's outer edge, in layout points. */
const STICK_INSET_DP = 28;
/**
 * Fraction of the stick's travel that reads as "not moving". Without this a resting thumb drifts
 * the character a pixel at a time, which feels like the game is fighting you.
 */
const STICK_DEADZONE = 0.16;

/** Seeds are picked from a fixed list so a run that felt good can be asked for again by hand. */
const SEEDS = [1, 7, 1337, 90210] as const;

interface Readout {
  ticks: number;
  level: number;
  xpFraction: number;
  health: number;
  maxHealth: number;
  enemies: number;
  projectiles: number;
  gems: number;
  kills: number;
  gold: number;
  damage: number;
  fps: number;
  droppedTicks: number;
  cuesDropped: number;
  weapons: string;
  /** Live stick vector. On screen because "is my thumb even reaching the sim" must be answerable. */
  stickX: number;
  stickY: number;
}

const EMPTY_READOUT: Readout = {
  ticks: 0,
  level: 1,
  xpFraction: 0,
  health: 0,
  maxHealth: 0,
  enemies: 0,
  projectiles: 0,
  gems: 0,
  kills: 0,
  gold: 0,
  damage: 0,
  fps: 0,
  droppedTicks: 0,
  cuesDropped: 0,
  weapons: "",
  stickX: 0,
  stickY: 0,
};

/** What the card overlay needs. Copied out of the sim so React never holds a live sim reference. */
interface CardView {
  open: boolean;
  picksRemaining: number;
  names: string[];
  texts: string[];
  rerolls: number;
  skips: number;
  banishes: number;
}

const CLOSED_CARDS: CardView = {
  open: false,
  picksRemaining: 0,
  names: [],
  texts: [],
  rerolls: 0,
  skips: 0,
  banishes: 0,
};

/**
 * `Date.now()` cannot measure a 16.7ms budget — it rounds to whole milliseconds and flattened every
 * percentile on the benchmark until it was removed. Frame pacing needs a monotonic high-resolution
 * clock, and the engine must not assume one exists.
 */
function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf?.now ? perf.now() : Date.now();
}

/**
 * The debug atlas has no `"ground"` frame, which is what the default theme asks for, so the floor
 * would silently draw nothing. A dark tinted panel tile plus a sparse scatter of crosses reads as
 * ground well enough to judge whether movement feels right.
 */
const DEBUG_GROUND: Omit<GroundTheme, "floorTint" | "propTint"> = {
  seed: 0x1a2b3c,
  floorFrames: ["debug/panel"],
  propFrames: ["debug/cross"],
  propChancePer1024: 28,
};

export default function PlayScreen() {
  useScreenAwake();

  const [readout, setReadout] = useState<Readout>(EMPTY_READOUT);
  const [cards, setCards] = useState<CardView>(CLOSED_CARDS);
  const [ended, setEnded] = useState<string | null>(null);
  const [seed, setSeed] = useState<number>(SEEDS[0]);
  const [hurry, setHurry] = useState(false);
  const [hyper, setHyper] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live handles the render loop reads without being torn down and rebuilt by a re-render.
  const runRef = useRef<Run | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Current stick vector, -1..1, already deadzoned. Read once per sim tick. */
  const stickRef = useRef({ x: 0, y: 0, active: false, knobX: 0, knobY: 0 });
  /** GLView size in layout points, and the multiplier from points to HUD units. */
  const layoutRef = useRef({ w: 1, h: 1, hudPerDp: 1 });
  /** Bumped to ask the GL loop to restart the run with the current seed and modifier choices. */
  const restartRef = useRef(0);
  const seedRef = useRef(seed);
  const hurryRef = useRef(hurry);
  const hyperRef = useRef(hyper);

  seedRef.current = seed;
  hurryRef.current = hurry;
  hyperRef.current = hyper;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    layoutRef.current.w = width > 0 ? width : 1;
    layoutRef.current.h = height > 0 ? height : 1;
  }, []);

  // --- Thumbstick -------------------------------------------------------------------------
  // The stick's visual lives in GL so it is pixel-exact with the game; this responder only turns
  // touches into a vector. Touch coordinates are relative to the pad view and are allowed to leave
  // it, which is what lets a thumb slide past the edge and still hold full tilt.
  const stick = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e: GestureResponderEvent) => applyStick(stickRef, e),
        onPanResponderMove: (e: GestureResponderEvent, _g: PanResponderGestureState) =>
          applyStick(stickRef, e),
        onPanResponderRelease: () => releaseStick(stickRef),
        onPanResponderTerminate: () => releaseStick(stickRef),
      }),
    [],
  );

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const restart = useCallback(() => {
    restartRef.current++;
    setEnded(null);
    setCards(CLOSED_CARDS);
  }, []);

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    try {
      const renderer = new Renderer(gl);
      renderer.setClearColor(Palette.ink);
      const atlas = createDebugAtlas(gl);
      renderer.setAtlas(atlas);
      renderer.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);

      const source = frameSourceFor(atlas);
      const ground = new Ground(source, {
        ...DEBUG_GROUND,
        floorTint: Renderer.color(Palette.stone),
        propTint: Renderer.color(Palette.crypt),
      });

      const white = atlas.need("debug/white");
      const blob = atlas.need("debug/blob");
      const skull = atlas.need("debug/skull");
      const gem = atlas.need("debug/gem");
      const diamond = atlas.need("debug/diamond");
      const ring = atlas.need("debug/ring");

      // Looked up once. Packing a colour from a hex string inside a frame would allocate a string
      // per sprite, which is exactly the kind of thing that starved the benchmark of memory.
      const C = {
        enemy: [
          Renderer.color(Palette.venom),
          Renderer.color(Palette.rust),
          Renderer.color(Palette.bone),
          Renderer.color(Palette.crimsonLit),
          Renderer.color(Palette.cyanLit),
          Renderer.color(Palette.violetLit),
        ],
        boss: Renderer.color(Palette.goldLit),
        player: Renderer.color(Palette.boneLit),
        downed: Renderer.color(Palette.crimson),
        invuln: Renderer.color(Palette.cyanLit),
        shot: Renderer.color(Palette.goldLit),
        xp: Renderer.color(Palette.cyanLit),
        gold: Renderer.color(Palette.gold),
        food: Renderer.color(Palette.venom),
        special: Renderer.color(Palette.violetLit),
        track: Renderer.color(Palette.stone),
        hp: Renderer.color(Palette.crimsonLit),
        stickBase: Renderer.color(Palette.ash, 90),
        stickKnob: Renderer.color(Palette.boneLit, 150),
      } as const;

      const run = new Run(seedRef.current);
      runRef.current = run;
      startRun(run);

      renderer.camera.snapTo(run.players.x[0], run.players.y[0]);

      const loop = new FixedLoop(() => {
        const s = stickRef.current;
        run.setStick(0, s.x, s.y);
        run.tick();
        // Ticked every time, paused or not: while a card screen is open the player does not move,
        // so the camera converges and interpolation has nothing to smear.
        renderer.camera.tick(run.players.x[0], run.players.y[0]);
      });

      let lastFrame = -1;
      let frameMsSum = 0;
      let frameMsCount = 0;
      let lastReport = 0;
      let seenRestart = restartRef.current;
      let cardsWereOpen = false;
      let reportedEnd: number = RUN_END.running;

      const frame = () => {
        rafRef.current = requestAnimationFrame(frame);
        const now = nowMs();
        if (lastFrame >= 0) {
          frameMsSum += now - lastFrame;
          frameMsCount++;
        }
        lastFrame = now;

        try {
          if (seenRestart !== restartRef.current) {
            seenRestart = restartRef.current;
            run.seed = seedRef.current;
            startRun(run);
            renderer.camera.snapTo(run.players.x[0], run.players.y[0]);
            cardsWereOpen = false;
            reportedEnd = RUN_END.running;
          }

          loop.advance(now);
          const alpha = loop.stats.alpha;
          renderer.beginFrame(alpha);

          // 1. background — the floor and its scenery.
          ground.draw(renderer.layer("background"), renderer.camera);

          // 2. pickups — gems and drops sit under everything that moves.
          {
            const b = renderer.layer("pickups");
            const p = run.pickups;
            const slots = p.pool.slots;
            for (let i = 0; i < p.pool.count; i++) {
              const s = slots[i];
              const kind = p.kind[s];
              const colour =
                kind === PICKUP.gold
                  ? C.gold
                  : kind === PICKUP.health
                    ? C.food
                    : kind === PICKUP.gemSmall || kind === PICKUP.gemMedium || kind === PICKUP.gemLarge
                      ? C.xp
                      : C.special;
              const size = kind === PICKUP.gemLarge ? 0.5 : kind === PICKUP.gemMedium ? 0.38 : 0.28;
              b.drawScaled(gem, p.x[s], p.y[s], size, size, colour);
            }
          }

          // 3. enemies — one quad each, tinted by type, gold for anything flagged as a boss.
          {
            const b = renderer.layer("enemies");
            const e = run.enemies;
            const slots = e.slots;
            for (let i = 0; i < e.count; i++) {
              const s = slots[i];
              const boss = (e.flags[s] & ENEMY_FLAG.boss) !== 0;
              const r = e.radius[s];
              const scale = (r * 2) / 32;
              b.drawScaled(
                blob,
                e.x[s],
                e.y[s],
                boss ? scale * 1.6 : scale,
                boss ? scale * 1.6 : scale,
                boss ? C.boss : C.enemy[e.typeIndex[s] % C.enemy.length],
              );
            }
          }

          // 4. player — interpolated, because this is the one sprite the eye tracks.
          {
            const b = renderer.layer("player");
            const pl = run.players;
            for (let i = 0; i < pl.count; i++) {
              const x = pl.prevX[i] + (pl.x[i] - pl.prevX[i]) * alpha;
              const y = pl.prevY[i] + (pl.y[i] - pl.prevY[i]) * alpha;
              const colour =
                pl.state[i] === PLAYER_STATE.alive
                  ? pl.invuln[i] > 0
                    ? C.invuln
                    : C.player
                  : C.downed;
              b.drawScaled(skull, x, y, 0.6, 0.6, colour);
            }
          }

          // 5. projectiles — above the crowd so you can read your own build.
          {
            const b = renderer.layer("projectiles");
            const pr = run.projectiles;
            const slots = pr.pool.slots;
            for (let i = 0; i < pr.pool.count; i++) {
              const s = slots[i];
              const scale = Math.max(0.2, (pr.radius[s] * 2) / 32);
              b.drawScaled(diamond, pr.x[s], pr.y[s], scale, scale, C.shot);
            }
          }

          // 6. hud — screen space, drawn in GL so the bars are pixel-exact with the game.
          {
            const b = renderer.layer("hud");
            const vw = renderer.camera.worldViewW;
            const vh = renderer.camera.worldViewH;

            // Experience across the very top: the one number a bullet-heaven player reads constantly.
            const xp = run.prog.barFraction;
            b.drawRect(white, 0, 0, vw, 3, C.track);
            b.drawRect(white, 0, 0, vw * xp, 3, C.xp);

            // Health under it, only while it matters.
            const maxHp = run.stats.get(STAT.maxHealth) / STAT_SCALE;
            const hp = maxHp > 0 ? run.players.health[0] / maxHp : 0;
            if (hp < 1) {
              b.drawRect(white, 0, 4, vw, 2, C.track);
              b.drawRect(white, 0, 4, vw * Math.max(0, hp), 2, C.hp);
            }

            // The thumbstick, positioned from the layout rect React measured.
            const L = layoutRef.current;
            L.hudPerDp = vw / L.w;
            const k = L.hudPerDp;
            const r = STICK_RADIUS_DP * k;
            const cx = (STICK_INSET_DP + STICK_RADIUS_DP) * k;
            const cy = vh - (STICK_INSET_DP + STICK_RADIUS_DP) * k;
            const baseScale = (r * 2) / 32;
            b.drawScaled(ring, cx, cy, baseScale, baseScale, C.stickBase);
            const s = stickRef.current;
            if (s.active) {
              const knob = (r * 0.8) / 32;
              b.drawScaled(blob, cx + s.knobX * r, cy + s.knobY * r, knob, knob, C.stickKnob);
            }
          }

          renderer.endFrame();
          if (Platform.OS !== "web") gl.endFrameEXP();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }

        // React hears about the card screen the moment it opens, and about everything else four
        // times a second. Anything faster and the panel starts costing frames.
        const open = run.cards.open;
        if (open !== cardsWereOpen) {
          cardsWereOpen = open;
          setCards(open ? readCards(run) : CLOSED_CARDS);
        }
        if (run.end !== reportedEnd) {
          reportedEnd = run.end;
          setEnded(reportedEnd === RUN_END.running ? null : describeEnd(run));
        }

        if (now - lastReport >= 250) {
          lastReport = now;
          const avg = frameMsCount > 0 ? frameMsSum / frameMsCount : 0;
          frameMsSum = 0;
          frameMsCount = 0;
          setReadout({
            ticks: run.runTicks,
            level: run.prog.level,
            xpFraction: run.prog.barFraction,
            health: run.players.health[0],
            maxHealth: run.stats.get(STAT.maxHealth) / STAT_SCALE,
            enemies: run.enemies.count,
            projectiles: run.projectiles.count,
            gems: run.pickups.pool.count,
            kills: run.kills,
            gold: run.prog.gold,
            damage: run.damageDealt,
            fps: avg > 0 ? 1000 / avg : 0,
            droppedTicks: loop.stats.droppedTicks,
            cuesDropped: run.cues.droppedTotal,
            weapons: describeWeapons(run),
            stickX: stickRef.current.x,
            stickY: stickRef.current.y,
          });
        }
      };

      rafRef.current = requestAnimationFrame(frame);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const pick = useCallback((index: number) => {
    const run = runRef.current;
    if (!run) return;
    run.pickCard(index);
    setCards(run.cards.open ? readCards(run) : CLOSED_CARDS);
  }, []);

  const reroll = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.rerollCards();
    setCards(readCards(run));
  }, []);

  const skip = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.skipCard();
    setCards(run.cards.open ? readCards(run) : CLOSED_CARDS);
  }, []);

  if (!webglAvailable()) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
        <ScrollView contentContainerStyle={styles.panelInner}>
          <Text style={styles.title}>No WebGL on this browser</Text>
          <Text style={styles.row}>
            The game needs a GPU context and this browser is not giving one out. Run it on the phone
            through Expo Go, where expo-gl gets a real OpenGL ES context.
          </Text>
          <Link href="/" asChild>
            <Pressable style={styles.btn}>
              <Text style={styles.btnText}>back</Text>
            </Pressable>
          </Link>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
      <View style={styles.fill} onLayout={onLayout}>
        <GLView style={styles.gl} onContextCreate={onContextCreate} />

        {/* Invisible pad over the GL-drawn stick. Only job: turn touches into a vector. */}
        <View style={styles.stickPad} {...stick.panHandlers} />

        <View style={styles.hud} pointerEvents="box-none">
          <Text style={styles.clock}>
            {formatRunTime(readout.ticks)} · lvl {readout.level} · {Math.ceil(readout.health)}/
            {Math.round(readout.maxHealth)} hp
          </Text>
          <Text style={styles.dim}>
            {readout.enemies} enemies · {readout.gems} gems · {readout.projectiles} shots ·{" "}
            {readout.fps.toFixed(0)} fps
            {readout.droppedTicks > 0 ? ` · ${readout.droppedTicks} dropped` : ""}
          </Text>
          <Text style={styles.dim}>
            {readout.kills} kills · {Math.round(readout.damage)} damage · {readout.gold} gold ·
            stick {readout.stickX.toFixed(2)},{readout.stickY.toFixed(2)}
          </Text>
          <Text style={styles.dim}>{readout.weapons}</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        {cards.open ? (
          <View style={styles.overlay}>
            <Text style={styles.title}>
              Level up{cards.picksRemaining > 1 ? ` · ${cards.picksRemaining} picks owed` : ""}
            </Text>
            {cards.names.map((name, i) => (
              <Pressable key={`${name}-${i}`} style={styles.card} onPress={() => pick(i)}>
                <Text style={styles.cardName}>{name}</Text>
                <Text style={styles.cardText}>{cards.texts[i]}</Text>
              </Pressable>
            ))}
            <View style={styles.controls}>
              {cards.rerolls > 0 ? (
                <Pressable style={styles.btn} onPress={reroll}>
                  <Text style={styles.btnText}>reroll ({cards.rerolls})</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.btn} onPress={skip}>
                <Text style={styles.btnText}>skip{cards.skips > 0 ? ` (${cards.skips})` : ""}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {ended ? (
          <View style={styles.overlay}>
            <Text style={styles.title}>{ended}</Text>
            <View style={styles.controls}>
              <Pressable style={styles.btn} onPress={restart}>
                <Text style={styles.btnText}>run it again</Text>
              </Pressable>
              <Link href="/" asChild>
                <Pressable style={styles.btn}>
                  <Text style={styles.btnText}>back</Text>
                </Pressable>
              </Link>
            </View>
          </View>
        ) : null}

        {/* Run setup. Modifiers are picked before a restart, never mid-run: the whole point of the
            modifier stack is that the simulation resolves them once, at the start. */}
        <View style={styles.footer} pointerEvents="box-none">
          <View style={styles.controls}>
            {SEEDS.map((s) => (
              <Pressable
                key={s}
                style={[styles.chip, seed === s ? styles.chipOn : null]}
                onPress={() => setSeed(s)}
              >
                <Text style={styles.chipText}>seed {s}</Text>
              </Pressable>
            ))}
            <Pressable
              style={[styles.chip, hurry ? styles.chipOn : null]}
              onPress={() => setHurry(!hurry)}
            >
              <Text style={styles.chipText}>hurry</Text>
            </Pressable>
            <Pressable
              style={[styles.chip, hyper ? styles.chipOn : null]}
              onPress={() => setHyper(!hyper)}
            >
              <Text style={styles.chipText}>hyper</Text>
            </Pressable>
            <Pressable style={styles.btn} onPress={restart}>
              <Text style={styles.btnText}>restart</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );

  function startRun(run: Run) {
    const mods = [];
    if (hurryRef.current) mods.push(MOD_HURRY);
    if (hyperRef.current) mods.push(MOD_HYPER);
    run.begin({ seed: seedRef.current, playerCount: 1, modifiers: mods, record: false });
    stickRef.current.x = 0;
    stickRef.current.y = 0;
    stickRef.current.active = false;
  }
}

/** Turn a touch inside the pad into a clamped, deadzoned stick vector. Allocates nothing. */
function applyStick(
  ref: { current: { x: number; y: number; active: boolean; knobX: number; knobY: number } },
  e: GestureResponderEvent,
) {
  const s = ref.current;
  let dx = (e.nativeEvent.locationX - STICK_RADIUS_DP) / STICK_RADIUS_DP;
  let dy = (e.nativeEvent.locationY - STICK_RADIUS_DP) / STICK_RADIUS_DP;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  s.knobX = dx;
  s.knobY = dy;
  s.active = true;
  if (len < STICK_DEADZONE) {
    s.x = 0;
    s.y = 0;
    return;
  }
  s.x = dx;
  s.y = dy;
}

function releaseStick(ref: {
  current: { x: number; y: number; active: boolean; knobX: number; knobY: number };
}) {
  const s = ref.current;
  s.x = 0;
  s.y = 0;
  s.knobX = 0;
  s.knobY = 0;
  s.active = false;
}

/** Adapt the atlas to what `Ground` wants. Atlas speaks `get`/`need`; the ground speaks frames. */
function frameSourceFor(atlas: Atlas): FrameSource {
  return {
    frame: (name: string) => atlas.need(name),
    has: (name: string) => atlas.get(name) !== undefined,
  };
}

function readCards(run: Run): CardView {
  const c = run.cards;
  const names: string[] = [];
  const texts: string[] = [];
  for (let i = 0; i < Math.min(c.offerCount, OFFERS_PER_SCREEN); i++) {
    names.push(c.offerName[i]);
    texts.push(c.offerText[i]);
  }
  return {
    open: c.open,
    picksRemaining: c.picksRemaining,
    names,
    texts,
    rerolls: c.rerollsLeft,
    skips: c.skipsLeft,
    banishes: c.banishesLeft,
  };
}

function describeEnd(run: Run): string {
  const label =
    run.end === RUN_END.defeat
      ? "Killed"
      : run.end === RUN_END.whiteHand
        ? "Taken by the White Hand"
        : run.end === RUN_END.survived
          ? "Survived"
          : "Run over";
  return `${label} at ${formatRunTime(run.runTicks)} · level ${run.prog.level} · ${run.kills} kills`;
}

/** One line of "what am I actually holding", so a build can be read without a proper HUD. */
function describeWeapons(run: Run): string {
  const w = run.weapons;
  const parts: string[] = [];
  for (let i = 0; i < MAX_WEAPONS; i++) {
    const type = w.typeIndex[i];
    if (type < 0) continue;
    parts.push(`${WEAPON_TYPES[type].name} ${w.level[i]}`);
  }
  return parts.join(" · ");
}

/**
 * On native this is always true — expo-gl owns a real GLES context. On web, GLView throws during
 * render when the browser hands back no context, which takes the whole screen down through the
 * error boundary and reports an unsupported browser as a crash.
 */
function webglAvailable(): boolean {
  if (Platform.OS !== "web") return true;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.ink },
  fill: { flex: 1 },
  gl: { ...StyleSheet.absoluteFillObject },
  stickPad: {
    position: "absolute",
    left: STICK_INSET_DP,
    bottom: STICK_INSET_DP,
    width: STICK_RADIUS_DP * 2,
    height: STICK_RADIUS_DP * 2,
  },
  panelInner: { padding: 14, gap: 8 },
  hud: { position: "absolute", left: 8, top: 10, right: 8, gap: 2 },
  clock: {
    color: Palette.boneLit,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  dim: { color: Palette.ash, fontSize: 11, fontVariant: ["tabular-nums"] },
  error: { color: Palette.crimsonLit, fontSize: 11 },
  overlay: {
    position: "absolute",
    left: 16,
    right: 16,
    top: 90,
    padding: 14,
    gap: 8,
    backgroundColor: Palette.crypt,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
  },
  title: { color: Palette.gold, fontSize: 16, fontWeight: "700" },
  row: { color: Palette.bone, fontSize: 13 },
  card: {
    padding: 10,
    backgroundColor: Palette.stone,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
  },
  cardName: { color: Palette.boneLit, fontSize: 14, fontWeight: "700" },
  cardText: { color: Palette.bone, fontSize: 12 },
  footer: { position: "absolute", right: 8, bottom: 10, left: STICK_RADIUS_DP * 2 + 40 },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: Palette.stone,
    borderWidth: 1,
    borderColor: Palette.stoneLit,
  },
  chipOn: { backgroundColor: Palette.violet, borderColor: Palette.violetLit },
  chipText: { color: Palette.boneLit, fontSize: 11 },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: Palette.stoneLit,
  },
  btnText: { color: Palette.boneLit, fontSize: 12, fontWeight: "700" },
});
