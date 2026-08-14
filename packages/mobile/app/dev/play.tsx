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
import { Link, useLocalSearchParams, useRouter } from "expo-router";

import { useScreenAwake } from "@/hooks/use-screen-awake";
import { useSettings } from "@/hooks/use-settings";
import { firstOpenStage } from "@/game/unlocks/stage-records";
import { GuideOffer } from "@/components/guide-offer";
import { recordOfferAnswer, shouldOfferGuide, type OfferAnswer } from "@/game/guide/arming";
import { saveStore } from "@/hooks/use-settings";
import { Palette } from "@/constants/theme";

import { FixedLoop } from "@/game/core/loop";
import { type Atlas } from "@/game/render/atlas";
import { loadRunAtlas } from "@/lib/load-atlas";
import {
  BOSS_DRAW_SCALE,
  ENEMY_DRAW_SCALE,
  AURA_ALPHA,
  ENEMY_FRAME,
  PLAYER_DRAW_SCALE,
  PICKUP_DRAW_SCALE,
  PICKUP_FRAME,
  PLAYER_FRAME,
  SHOT_FRAME,
  STAGE_ART,
  WHITE_FRAME,
} from "@/game/art/run-art";
import { Renderer } from "@/game/render/renderer";
import { COLOR_WHITE, packHex, withAlpha } from "@/game/render/batcher";
import { WalkTracker, createStepPose, stepPose } from "@/game/render/step-anim";
import { legLiftY, legOffsetX, splitBody } from "@/game/render/body-split";
import {
  SEQUENCE_SECONDS,
  chestOpenAt,
  createChestOpenFrame,
  createChestOpenSpec,
  createSpark,
} from "@/game/render/chest-open";
import { drawChestScreen, drawChestWorld, type ChestArt } from "@/game/render/chest-draw";
import { CUE } from "@/game/sim/cues";
import { CHEST_REWARD, MAX_CHEST_REWARDS, rewardLine } from "@/game/sim/chests";
import { PICKUP } from "@/game/sim/pickups";
import { stageAt } from "@/game/sim/stages";
import { Ground, type FrameSource, type GroundTheme } from "@/game/render/ground";
import { Run } from "@/game/run/run";
import { STAT, STAT_SCALE } from "@/game/sim/stats";
import { MOD_HURRY, MOD_HYPER } from "@/game/sim/modifiers";
import { ENEMY_FLAG, ENEMY_TYPES } from "@/game/sim/enemies";
import { MAX_WEAPONS, WEAPON_TYPES } from "@/game/sim/weapons";
import { MOVE } from "@/game/sim/projectiles";
import { MAX_PLAYERS, PLAYER_STATE } from "@/game/sim/player";
import { RUN_END, formatRunTime } from "@/game/sim/results";
import { describeHandoff, runHandoff, runIdOf } from "@/game/save/handoff";
import { powerUpLoadout } from "@/game/shop/loadout";
import {
  CHARACTER_GROWTH_MODIFIERS,
  characterLoadout,
  characterStartingWeaponId,
} from "@/game/characters/loadout";
import { CHARACTERS, firstPlayable } from "@/game/characters/roster";
import type { RunModifier } from "@/game/sim/modifiers";
import { OFFERS_PER_SCREEN } from "@/game/sim/cards";
import { ARCANA_OFFERS, ARCANA_TYPES } from "@/game/sim/arcanas";
import { openArcanaPool } from "@/game/unlocks/arcana-records";
import { REAPER_SECOND, TICKS_PER_SECOND } from "@/game/sim/waves";
import { HudView, createHudInput, readRunInto, touchSummonsStick, type HudFrame } from "@/game/hud/hud";
import { HudPainter, paintStick } from "@/game/render/hud-draw";
import type { HudRect, ResolvedHud } from "@/game/settings/settings";

/**
 * Fraction of the stick's travel that reads as "not moving". Without this a resting thumb drifts
 * the character a pixel at a time, which feels like the game is fighting you.
 */
const STICK_DEADZONE = 0.16;

/**
 * Live thumbstick state.
 *
 * There is no pad. The stick has no position until a thumb lands, and then its centre *is* where the
 * thumb landed — which is why the origin is stored here rather than being a constant. `x`/`y` is what
 * the simulation reads; `knobX`/`knobY` is what gets drawn, and they are not the same thing, because
 * the deadzone must not make the knob jump.
 */
interface StickState {
  x: number;
  y: number;
  active: boolean;
  originX: number;
  originY: number;
  knobX: number;
  knobY: number;
}

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
 * What the arcana overlay needs.
 *
 * A separate view from the card one rather than a shared "offer" shape: an arcana screen has no
 * reroll, no skip charges and no picks owed, and folding two screens with different rules into one
 * type is how a reroll button ends up on a screen that cannot reroll.
 */
interface ArcanaView {
  open: boolean;
  numerals: string[];
  names: string[];
  blurbs: string[];
}

const CLOSED_ARCANA: ArcanaView = { open: false, numerals: [], names: [], blurbs: [] };

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
  const [arcana, setArcana] = useState<ArcanaView>(CLOSED_ARCANA);
  const [ended, setEnded] = useState<string | null>(null);
  /**
   * Why the finished run could not be banked, if it could not.
   *
   * Shown on the old dev overlay rather than swallowed. A run that ends and goes nowhere is the single
   * most confusing thing this screen could do, so if the hand-off refuses, it says which refusal it was.
   */
  const [bankFault, setBankFault] = useState<string | null>(null);
  const [seed, setSeed] = useState<number>(SEEDS[0]);
  const [hurry, setHurry] = useState(false);
  const [hyper, setHyper] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Seats in the run. The other three stand still — this is here to look at the four-player HUD. */
  const [partySize, setPartySize] = useState(1);
  const [paused, setPaused] = useState(false);
  /**
   * The one-time guide offer. It is shown the instant a run starts and never over a run in progress — a
   * player asked whether they would like to be taught while something is already eating them has been
   * asked at the worst possible moment. `null` means "not decided yet this mount"; the save decides
   * whether it is ever put on screen at all.
   */
  const [offerAnswered, setOfferAnswered] = useState(false);

  // The HUD draws itself from resolved settings and from nothing else, so the screen reads them the
  // same way every other screen does. Party size is passed in because it decides whether badges exist.
  const settings = useSettings(partySize);

  const router = useRouter();

  /**
   * Bank the finished run and go to the results screen.
   *
   * Held in a ref because the render loop is set up once, inside an effect, and a callback captured there
   * would go stale the moment settings reloaded — banking into a stale copy of the save is how gold
   * disappears. The ref is repointed every render; the loop always calls the current one.
   *
   * Two things happen here and their order matters. The hand-off banks into the save in memory and hands
   * the result over; only then is the save written to storage. If the write fails the player still sees
   * the correct figures, because the figures are what their profile says right now — and the run is not
   * re-banked on the next launch, because nothing re-reads a run that already went through the hand-off.
   */
  const showResults = useCallback(
    (run: Run) => {
      const summary = run.summary;
      const outcome = runHandoff.stage(runIdOf(summary), summary, settings.save);
      if (!outcome.staged) {
        const field = outcome.receipt.badField;
        setBankFault(`not banked: ${describeHandoff(outcome.code)}${field ? ` (${field})` : ""}`);
        return;
      }
      setBankFault(null);
      void saveStore().save(settings.save);
      router.push("/results");
    },
    [router, settings.save],
  );
  /**
   * The save and the run's shop records, held in refs for the same reason the callback above is: the render
   * loop is built once and must always read the current save, not the one that existed when it started.
   * The record array is reused so starting a run allocates nothing.
   */
  const saveRef = useRef(settings.save);
  const powerUpsRef = useRef<RunModifier[]>([]);
  // Who the player picked on the character screen. A route parameter rather than a saved field, because
  // "the character you last played" is a save migration and this is not it: an unreadable or locked choice
  // falls back to somebody the profile definitely owns rather than refusing to start.
  const params = useLocalSearchParams<{ character?: string; stage?: string }>();
  const wanted = Number.parseInt(params.character ?? "", 10);
  // Which of the five places this run happens in. Also a route parameter, for the same reason as the
  // character: anything unreadable falls back to the first stage, which every profile can always play.
  const wantedStage = Number.parseInt(params.stage ?? "", 10);
  const stageRef = useRef(0);
  // Checked against the profile, not just against the list: a link, a stale back-stack entry or a dev
  // shortcut must not be able to start a run somewhere the player has not opened. Anything that does not
  // pass falls back to the first place, which every profile can always play.
  stageRef.current = firstOpenStage(settings.save, wantedStage);
  const characterRef = useRef(0);
  characterRef.current = firstPlayable(settings.save, Number.isSafeInteger(wanted) ? wanted : 0);
  const characterModsRef = useRef<RunModifier[]>([]);
  useEffect(() => {
    saveRef.current = settings.save;
  }, [settings.save]);

  const showResultsRef = useRef(showResults);
  useEffect(() => {
    showResultsRef.current = showResults;
  }, [showResults]);

  // Live handles the render loop reads without being torn down and rebuilt by a re-render.
  const runRef = useRef<Run | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Current stick vector, -1..1, already deadzoned. Read once per sim tick. */
  const stickRef = useRef<StickState>({ x: 0, y: 0, active: false, originX: 0, originY: 0, knobX: 0, knobY: 0 });
  /** Resolved HUD geometry and the live HUD frame, for the touch handlers to read. */
  const hudRef = useRef<ResolvedHud>(settings.resolved.hud);
  const frameRef = useRef<HudFrame | null>(null);
  const pausedRef = useRef(false);
  const partyRef = useRef(partySize);
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
  hudRef.current = settings.resolved.hud;
  pausedRef.current = paused;
  partyRef.current = partySize;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    layoutRef.current.w = width > 0 ? width : 1;
    layoutRef.current.h = height > 0 ? height : 1;
  }, []);

  // --- Thumbstick -------------------------------------------------------------------------
  // There is no pad. The responder covers the whole screen and the settled rule decides what a touch
  // means: the top block is interface, everything below it is movement, and there is no third case.
  // That rule lives in `touchSummonsStick` in the engine, not here, so it is testable without a phone.
  const togglePause = useCallback(() => setPaused((p) => !p), []);

  const stick = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e: GestureResponderEvent) => {
          const x = e.nativeEvent.locationX;
          const y = e.nativeEvent.locationY;
          const pause = frameRef.current?.pauseButton;
          // The one button in a run. Checked first, so a mis-scaled top block can never make pausing
          // impossible by having the movement region swallow it.
          if (pause && insideRect(pause, x, y)) {
            togglePause();
            return;
          }
          if (!touchSummonsStick(x, y, hudRef.current, pause)) return;
          const s = stickRef.current;
          s.active = true;
          s.originX = x;
          s.originY = y;
          s.x = 0;
          s.y = 0;
          s.knobX = 0;
          s.knobY = 0;
        },
        onPanResponderMove: (e: GestureResponderEvent, _g: PanResponderGestureState) =>
          applyStick(stickRef, e, hudRef.current.stickRadius),
        onPanResponderRelease: () => releaseStick(stickRef),
        onPanResponderTerminate: () => releaseStick(stickRef),
      }),
    [togglePause],
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
    setPaused(false);
    setCards(CLOSED_CARDS);
    setArcana(CLOSED_ARCANA);
  }, []);

  const onContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
    try {
      const renderer = new Renderer(gl);
      renderer.setClearColor(Palette.ink);
      // The real art, from the one packed sheet. This deliberately has no fallback to placeholder
      // squares: a build with missing art that looks like a build with placeholder art is a build that
      // ships. If the sheet will not load, the screen says so instead.
      const atlas = await loadRunAtlas(gl as unknown as WebGLRenderingContext);
      renderer.setAtlas(atlas);
      renderer.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);

      const source = frameSourceFor(atlas);
      // Real drawn floors and scenery, tinted down by the stage's own numbers.
      //
      // This started out untinted, on the reasoning that the art already carries its colour and tinting
      // a drawn picture only muddies it. That was wrong for one specific reason: every crypt tile has
      // bone chips painted into it, and a bone chip repeated across a whole screen is indistinguishable
      // from an experience gem lying on the floor. Knocking the floor back is the only lever available,
      // because a tint can darken and never brighten. `art/floor_contrast_test.py` measures the gap.
      // Which floor gets drawn is the stage's own business. The stage table names an art set and the
      // art table owns the pictures; the two are checked against each other by the art tests, so a
      // stage can never name a set that was never drawn.
      const stageArt = STAGE_ART[stageAt(stageRef.current).artKey];
      const ground = new Ground(source, {
        ...DEBUG_GROUND,
        floorFrames: stageArt?.floorFrames ?? [],
        propFrames: stageArt?.propFrames ?? [],
        floorTint: packHex(stageArt?.floorTint ?? "#FFFFFF"),
        propTint: packHex(stageArt?.propTint ?? "#FFFFFF"),
      });

      // Every picture this screen will ever draw, looked up once. A frame lookup is a string lookup,
      // and doing string work inside a frame is exactly what starved the benchmark of memory.
      const white = atlas.need(WHITE_FRAME);
      const enemyFrames = ENEMY_TYPES.map((t) => atlas.need(ENEMY_FRAME[t.id] ?? WHITE_FRAME));
      const shotFrames = WEAPON_TYPES.map((w) => atlas.need(SHOT_FRAME[w.id] ?? WHITE_FRAME));
      const pickupFrames = PICKUP_FRAME.map((name) => atlas.need(name));
      const pickupScales = PICKUP_DRAW_SCALE;

      // How far each character has walked, and the pose that distance puts them in. Kept on the
      // drawing side, never in the simulation: a number that only picks a picture has no business
      // being able to desync a co-op game.
      const walk = new WalkTracker(MAX_PLAYERS);
      const pose = createStepPose();

      // The chest opening. Everything here is decoration and nothing else: by the time any of it is
      // drawn the simulation has already handed over the levels, the evolution and the coins, so a
      // phone that dies halfway through the animation has still been paid.
      //
      // One chest at a time. A second chest opened while the first is still playing takes the screen
      // over rather than queueing — a queue would show a card describing a reward from four seconds
      // ago while the player is standing somewhere else entirely.
      const chestSpec = createChestOpenSpec();
      const chestFrame = createChestOpenFrame();
      const chestSpark = createSpark();
      const chestArt: ChestArt = {
        white,
        sparkFrames: [
          pickupFrames[PICKUP.gold] ?? white,
          pickupFrames[PICKUP.gemSmall] ?? white,
          pickupFrames[PICKUP.gemMedium] ?? white,
        ],
      };
      const chestRows: string[] = [];
      // Seconds since the chest opened. Negative means no chest is playing.
      let chestClock = -1;
      // How long the card waits on screen after it has landed before it takes itself away. The fight
      // does not stop while it is up, so it cannot sit there being read at the player's leisure.
      const CHEST_CARD_HOLD = 2.2;
      let lastPoseClock = nowMs();
      let poseSeconds = 0;

      // Which weapons are auras. Looked up once, because deciding it per projectile per frame would
      // mean a table walk sixty times a second for no new information.
      const isAuraWeapon = WEAPON_TYPES.map((w) => w.move === MOVE.aura);
      // Every character on the roster, so the body is right the moment a run restarts as somebody else
      // without re-reading the sheet.
      const bodyFrames = CHARACTERS.map((c) => atlas.need(PLAYER_FRAME[c.id] ?? WHITE_FRAME));
      // Each character picture cut in two at the hips, once, here — so the legs can be drawn a pixel
      // or two out of step with the chest and the body reads as striding instead of sliding. Cutting
      // is arithmetic on a handful of numbers but it allocates, so it never happens inside a frame.
      const bodyHalves = bodyFrames.map((f) => splitBody(f));

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
      } as const;

      // The HUD: one view that decides the numbers, one painter that draws them, both built once and
      // reused for the life of the screen. Nothing here is allocated per frame.
      const hudView = new HudView();
      const hudInput = createHudInput();
      const painter = new HudPainter({ white });
      frameRef.current = hudView.frame;
      // Who is on the network and what they are playing is the party layer's business, not the run's.
      // There is no party on this screen, so everybody is present and everybody is character zero.
      const connected = new Uint8Array(MAX_PLAYERS).fill(1);
      const characterIds = new Uint8Array(MAX_PLAYERS).fill(characterRef.current);
      const reaperAtTicks = REAPER_SECOND * TICKS_PER_SECOND;

      const run = new Run(seedRef.current);
      runRef.current = run;
      startRun(run);

      renderer.camera.snapTo(run.players.x[0], run.players.y[0]);

      const loop = new FixedLoop(() => {
        const s = stickRef.current;
        run.setStick(0, s.x, s.y);
        // Read before the tick, because the counter on screen has to start from what the player had
        // rather than from what they ended the tick with.
        const goldBefore = run.prog.gold;
        run.tick();

        // Cues live for exactly one tick, so a chest has to be noticed here and not in the drawing
        // frame — at thirty frames a second the drawing frame misses half of them.
        const cue = run.cues.indexOf(CUE.chestOpened);
        if (cue >= 0 && run.cues.flag[cue] === 0) {
          const report = run.chestReport;
          const rows = Math.max(0, Math.min(MAX_CHEST_REWARDS, run.cues.value[cue]));
          chestRows.length = 0;
          let evolved = false;
          for (let r = 0; r < rows && r < report.count; r++) {
            const line = rewardLine(report, r);
            if (line.length > 0) chestRows.push(line);
            if (report.kind[r] === CHEST_REWARD.evolution) evolved = true;
          }
          chestSpec.x = run.cues.x[cue];
          chestSpec.y = run.cues.y[cue];
          chestSpec.goldFrom = goldBefore;
          chestSpec.goldTo = run.prog.gold;
          chestSpec.rows = chestRows.length;
          chestSpec.evolved = evolved;
          // The run's own seed, so two phones in a party throw the same coins in the same directions.
          chestSpec.seed = run.seed;
          chestClock = 0;
        }
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
      let arcanaWasOpen = false;
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
            walk.reset();
            chestClock = -1;
            chestRows.length = 0;
            renderer.camera.snapTo(run.players.x[0], run.players.y[0]);
            cardsWereOpen = false;
            arcanaWasOpen = false;
            reportedEnd = RUN_END.running;
          }

          // Paused means paused. Rather than freezing the loop and letting it owe itself a second of
          // ticks on resume, the clock is re-anchored to now every paused frame — the sim's tick count
          // is kept, so unpausing does not fast-forward and does not rewind either.
          if (pausedRef.current) loop.reset(now, loop.stats.tick);
          loop.advance(now);
          const alpha = loop.stats.alpha;
          renderer.beginFrame(alpha);

          // The drawing clock. Only the standing-still breath uses it, and it is measured here rather
          // than inside the pose rules, because nothing under game/render is allowed to read a clock.
          const poseDt = Math.min(0.25, Math.max(0, (now - lastPoseClock) / 1000));
          lastPoseClock = now;
          poseSeconds += poseDt;

          // The chest sequence is a pure function of how long ago the chest opened, so all that is
          // kept between frames is that one number. A dropped frame lands further along the sequence
          // instead of replaying the part it missed.
          if (chestClock >= 0) {
            if (!pausedRef.current) chestClock += poseDt;
            if (chestClock > SEQUENCE_SECONDS + CHEST_CARD_HOLD) {
              chestClock = -1;
              chestRows.length = 0;
            }
          }
          const chestPlaying = chestClock >= 0;
          if (chestPlaying) chestOpenAt(chestClock, chestSpec, chestFrame);

          // 1. background — the floor and its scenery.
          ground.draw(renderer.layer("background"), renderer.camera);

          // 2. floorFx — aura weapons, and only aura weapons.
          //
          // An aura is a disc centred on the player and usually wider than the player is tall. Drawn on
          // the layer above them it swallowed the character whole. Down here, under everything that
          // walks and drawn part-transparent, the cloud still reads as a cloud and you can still see
          // yourself standing in the middle of it.
          {
            const b = renderer.layer("floorFx");
            const pr = run.projectiles;
            const slots = pr.pool.slots;
            const tint = withAlpha(COLOR_WHITE, AURA_ALPHA);
            for (let i = 0; i < pr.pool.count; i++) {
              const s = slots[i];
              if (!isAuraWeapon[pr.weapon[s]]) continue;
              const scale = Math.max(0.2, (pr.radius[s] * 2) / 32);
              b.drawScaled(shotFrames[pr.weapon[s]] ?? white, pr.x[s], pr.y[s], scale, scale, tint);
            }
          }

          // 3. pickups — gems and drops sit under everything that moves.
          {
            const b = renderer.layer("pickups");
            const p = run.pickups;
            const slots = p.pool.slots;
            for (let i = 0; i < p.pool.count; i++) {
              const s = slots[i];
              const kind = p.kind[s];
              // One table, shared with the art rules, instead of three numbers written out here. The
              // gems were raised after the first play test because they were too small to spot.
              const size = pickupScales[kind] ?? 0.5;
              b.drawScaled(pickupFrames[kind] ?? white, p.x[s], p.y[s], size, size, COLOR_WHITE);
            }
          }

          // 4. enemies — one quad each, tinted by type, gold for anything flagged as a boss.
          {
            const b = renderer.layer("enemies");
            const e = run.enemies;
            const slots = e.slots;
            for (let i = 0; i < e.count; i++) {
              const s = slots[i];
              const boss = (e.flags[s] & ENEMY_FLAG.boss) !== 0;
              const r = e.radius[s];
              const scale = ((r * 2) / 32) * ENEMY_DRAW_SCALE;
              // The drawn picture, untinted. A boss is drawn bigger; it keeps the gold wash, because a
              // boss has to be readable through a screen full of everything else.
              b.drawScaled(
                enemyFrames[e.typeIndex[s]] ?? white,
                e.x[s],
                e.y[s],
                boss ? (scale / ENEMY_DRAW_SCALE) * BOSS_DRAW_SCALE : scale,
                boss ? (scale / ENEMY_DRAW_SCALE) * BOSS_DRAW_SCALE : scale,
                boss ? C.boss : COLOR_WHITE,
              );
            }
          }

          // 5. player — interpolated, because this is the one sprite the eye tracks.
          {
            const b = renderer.layer("player");
            const pl = run.players;
            for (let i = 0; i < pl.count; i++) {
              const x = pl.prevX[i] + (pl.x[i] - pl.prevX[i]) * alpha;
              const y = pl.prevY[i] + (pl.y[i] - pl.prevY[i]) * alpha;
              // The character's own body, drawn as drawn while nothing is happening to them. Being hit
              // and being down still wash the sprite, because those two have to be unmissable.
              const colour =
                pl.state[i] === PLAYER_STATE.alive
                  ? pl.invuln[i] > 0
                    ? C.invuln
                    : COLOR_WHITE
                  : C.downed;
              // The stride. Driven by how far the body has actually travelled, never by the clock —
              // a clock-driven bob keeps jogging on the spot when you stop, and gets move speed,
              // slows, freezes and knockback wrong for free. Distance gets all of them right for free.
              walk.update(i, x, y, poseDt);
              stepPose(walk.distance[i] ?? 0, walk.speed[i] ?? 0, pl.facing[i] ?? 0, poseSeconds, pose);
              // A negative width mirrors the picture. Safe because face culling is off in the batcher.
              const mirror = pose.flipX ? -1 : 1;
              const sx = PLAYER_DRAW_SCALE * pose.scaleX * mirror;
              const sy = PLAYER_DRAW_SCALE * pose.scaleY;
              const halves = bodyHalves[characterIds[i] ?? 0];
              if (halves === undefined || !halves.split) {
                b.drawScaled(bodyFrames[characterIds[i] ?? 0] ?? white, x, y + pose.liftY, sx, sy, colour);
              } else {
                // Chest and head where the whole picture always went, and the legs shifted sideways on
                // the same cycle. Two quads instead of one, and the legs genuinely swing.
                b.drawScaled(halves.top, x, y + pose.liftY, sx, sy, colour);
                b.drawScaled(
                  halves.legs,
                  x + legOffsetX(pose.phase, pose.walking, pose.flipX) * PLAYER_DRAW_SCALE,
                  y + legLiftY(pose.liftY),
                  sx,
                  sy,
                  colour,
                );
              }
            }
          }

          // 6. projectiles — above the crowd so you can read your own build.
          {
            const b = renderer.layer("projectiles");
            const pr = run.projectiles;
            const slots = pr.pool.slots;
            for (let i = 0; i < pr.pool.count; i++) {
              const s = slots[i];
              if (isAuraWeapon[pr.weapon[s]]) continue; // already drawn on the floor layer
              const scale = Math.max(0.2, (pr.radius[s] * 2) / 32);
              b.drawScaled(shotFrames[pr.weapon[s]] ?? white, pr.x[s], pr.y[s], scale, scale, COLOR_WHITE);
            }
          }

          // 7. overheadFx — the chest opening, drawn over the fight but under the numbers and the HUD.
          if (chestPlaying) {
            drawChestWorld(
              renderer.layer("overheadFx"),
              chestArt,
              chestFrame,
              chestSpec,
              chestClock,
              chestSpark,
            );
          }

          // 8. hud — screen space, and every coordinate in it comes from resolved settings.
          //
          // The screen's whole job here is three calls: copy the run into an input block, let the HUD
          // rules turn that into a frame, then paint the frame. It decides nothing itself, which is why
          // the layout editor will be a screen rather than a rewrite of this file.
          {
            const b = renderer.layer("hud");
            const hud = hudRef.current;
            const L = layoutRef.current;
            // The one bridge between the two coordinate systems: settings resolve in layout points, the
            // HUD layer draws in screen units.
            L.hudPerDp = renderer.camera.worldViewW / L.w;
            const k = L.hudPerDp;

            readRunInto(
              run,
              0,
              run.stats.get(STAT.maxHealth) / STAT_SCALE,
              connected,
              characterIds,
              reaperAtTicks,
              hudInput,
            );
            hudView.update(hudInput, hud);
            painter.paint(b, hudView.frame, k);

            const s = stickRef.current;
            paintStick(
              b,
              { white },
              s.originX * k,
              s.originY * k,
              hud.stickRadius * k,
              s.knobX,
              s.knobY,
              s.active,
            );

            // The flash and the reward card go on last, over the HUD. A flash with a health bar
            // sitting on top of it is not a flash.
            if (chestPlaying) {
              drawChestScreen(
                b,
                chestArt,
                chestFrame,
                renderer.camera.worldViewW,
                renderer.camera.worldViewH,
                chestRows,
              );
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
        // The same treatment for an arcana offer. It has to be edge-triggered like the card screen is:
        // rebuilding this view every frame would hand React three fresh strings sixty times a second
        // for a screen that never changes while it is up.
        const arcanaOpen = run.arcanas.open;
        if (arcanaOpen !== arcanaWasOpen) {
          arcanaWasOpen = arcanaOpen;
          setArcana(arcanaOpen ? readArcana(run) : CLOSED_ARCANA);
        }
        if (run.end !== reportedEnd) {
          reportedEnd = run.end;
          if (reportedEnd === RUN_END.running) {
            setEnded(null);
            setBankFault(null);
          } else {
            // The simulation has already written its own summary by this point — `finish()` does that,
            // once, and refuses to do it twice. All this does is hand that summary over and change screen.
            setEnded(describeEnd(run));
            showResultsRef.current(run);
          }
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

  const takeArcana = useCallback((index: number) => {
    const run = runRef.current;
    if (!run) return;
    run.pickArcana(index);
    setArcana(run.arcanas.open ? readArcana(run) : CLOSED_ARCANA);
  }, []);

  const refuseArcana = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.closeArcanaOffer();
    setArcana(CLOSED_ARCANA);
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

  // Decided once, the first moment the save is readable, and then latched. Deliberately not "while the
  // run clock is under half a second": the save arrives asynchronously and on a slow read that window has
  // already gone by, which would silently swallow the only offer the player ever gets. The shipped run
  // screen will not start a run before the save has loaded, so latching here and starting late there give
  // the same thing — the question is on screen before anything can reach the player.
  const showOffer = settings.ready && !offerAnswered && shouldOfferGuide(settings.save);

  const answerOffer = (answer: OfferAnswer): void => {
    setOfferAnswered(true);
    recordOfferAnswer(settings.save, answer);
    void saveStore().save(settings.save);
  };

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
      <View style={styles.fill} onLayout={onLayout}>
        <GLView style={styles.gl} onContextCreate={onContextCreate} />

        {/* One invisible surface over the whole screen. The engine decides what a touch means. */}
        <View style={styles.touchLayer} {...stick.panHandlers} />

        {showOffer ? <GuideOffer onAnswer={answerOffer} /> : null}

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
            stick {readout.stickX.toFixed(2)},{readout.stickY.toFixed(2)} · {partySize}p hud
            {settings.ready ? "" : " (defaults)"}
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

        {arcana.open ? (
          <View style={styles.overlay}>
            <Text style={styles.title}>An arcana turns over</Text>
            {arcana.names.map((name, i) => (
              <Pressable
                key={`${name}-${i}`}
                style={styles.card}
                onPress={() => takeArcana(i)}
              >
                <Text style={styles.cardName}>
                  {arcana.numerals[i]} · {name}
                </Text>
                <Text style={styles.cardText}>{arcana.blurbs[i]}</Text>
              </Pressable>
            ))}
            <View style={styles.controls}>
              <Pressable style={styles.btn} onPress={refuseArcana}>
                <Text style={styles.btnText}>take none</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {paused && !cards.open && !arcana.open && ended === null ? (
          <View style={styles.overlay}>
            <Text style={styles.title}>Paused</Text>
            <Text style={styles.row}>
              The clock is stopped. Nothing is happening until you say so.
            </Text>
            <View style={styles.controls}>
              <Pressable style={styles.btn} onPress={togglePause}>
                <Text style={styles.btnText}>resume</Text>
              </Pressable>
              <Link href="/" asChild>
                <Pressable style={styles.btn}>
                  <Text style={styles.btnText}>give up</Text>
                </Pressable>
              </Link>
            </View>
          </View>
        ) : null}

        {ended ? (
          <View style={styles.overlay}>
            <Text style={styles.title}>{ended}</Text>
            {bankFault ? <Text style={styles.title}>{bankFault}</Text> : null}
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
            {[1, 2, 3, 4].map((n) => (
              <Pressable
                key={`party${n}`}
                style={[styles.chip, partySize === n ? styles.chipOn : null]}
                onPress={() => {
                  setPartySize(n);
                  restart();
                }}
              >
                <Text style={styles.chipText}>{n}p</Text>
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
    // Everything bought in the shop, read from the save and handed to the run as records. Read here, at
    // the start of a run, rather than held somewhere: the shop can be visited between two runs, and a run
    // that used a stale copy would be the shop appearing not to work.
    powerUpLoadout(saveRef.current, powerUpsRef.current);
    // The character's own shifts go on the wire with everything else; its growth quirk is handed over as a
    // ladder the run climbs as the player levels, because how far along it is depends on the level rather
    // than on anything decided here.
    const pick = Math.max(0, characterRef.current);
    characterLoadout(pick, 1, characterModsRef.current);
    const growth = CHARACTER_GROWTH_MODIFIERS[pick] ?? [];
    run.begin({
      seed: seedRef.current,
      playerCount: partyRef.current,
      stageId: stageRef.current,
      modifiers: mods,
      powerUps: powerUpsRef.current,
      characters: characterModsRef.current,
      characterGrowth: growth,
      characterGrowthEvery: CHARACTERS[pick]?.growth.everyLevels ?? 1,
      characterIds: [pick, pick, pick, pick],
      startingWeaponId: characterStartingWeaponId(pick, "reapersLash"),
      // Which arcanas may be offered is a profile question, not a simulation one, so it is answered
      // here and handed over as plain indices. Read at the start of every run rather than held, for
      // the same reason the shop loadout is: a run started right after an unlock must see it.
      arcanaPool: openArcanaPool(saveRef.current),
      record: false,
    });
    stickRef.current.x = 0;
    stickRef.current.y = 0;
    stickRef.current.active = false;
  }
}

/** Is this point inside that rectangle? Both in layout points. */
function insideRect(r: HudRect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/**
 * Turn a moving thumb into a clamped, deadzoned stick vector, measured from where the thumb landed.
 *
 * A thumb is allowed to slide past the stick's radius and keep full tilt — that is what makes chasing
 * a gem across the screen possible without lifting off. Allocates nothing.
 */
function applyStick(ref: { current: StickState }, e: GestureResponderEvent, radius: number) {
  const s = ref.current;
  if (!s.active) return;
  const r = radius > 0 ? radius : 1;
  let dx = (e.nativeEvent.locationX - s.originX) / r;
  let dy = (e.nativeEvent.locationY - s.originY) / r;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  s.knobX = dx;
  s.knobY = dy;
  if (len < STICK_DEADZONE) {
    s.x = 0;
    s.y = 0;
    return;
  }
  s.x = dx;
  s.y = dy;
}

function releaseStick(ref: { current: StickState }) {
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

/**
 * Copy the arcana offer out of the simulation.
 *
 * Copied rather than referenced for the same reason the cards are: React holding a live handle into
 * the sim is how a re-render ends up reading a half-finished tick.
 */
function readArcana(run: Run): ArcanaView {
  const deck = run.arcanas;
  const numerals: string[] = [];
  const names: string[] = [];
  const blurbs: string[] = [];
  for (let i = 0; i < Math.min(deck.offerCount, ARCANA_OFFERS); i++) {
    const type = ARCANA_TYPES[deck.offerIndex[i]];
    if (!type) continue;
    numerals.push(type.numeral);
    names.push(type.name);
    blurbs.push(type.blurb);
  }
  return { open: deck.open, numerals, names, blurbs };
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
  touchLayer: { ...StyleSheet.absoluteFillObject },
  panelInner: { padding: 14, gap: 8 },
  hud: { position: "absolute", left: 8, top: 96, right: 8, gap: 2 },
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
  footer: { position: "absolute", right: 8, bottom: 10, left: 8 },
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
