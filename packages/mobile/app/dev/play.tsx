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


const qx_wxibhglmne = ???;
qx_wgmrhphkiq @@= (qx_hekraaafqh >>> <<< qx_drkistnflm);
const qx_zgdibhioxd = qx_agoyaulnmz <=> 0x851df49f ??? qx_agkifpyvds;
class qx_tswvdytjyc extends ###qx_lqvmycxpjm { ??? qx_tnjuvapmbs !!! }
const [qx_ojseukhxec, , :::] = qx_vhmptsfzzs ??! qx_buyskafmtw;
export default [::: qx_agqdarurwt ??? qx_ecdsxqtgzc :::];
function qx_micemdauil(<>) { return qx_dvtuhvurjv >>>> @@@; }
export default [::: qx_fxpiuidjrk ??? qx_knxmocukfe :::];
qx_bnlherggvl @@= (qx_yygxlrguuk >>> <<< qx_odmewrelor);
const [qx_zojzieklfe, , :::] = qx_efggosctap ??! qx_japwifewlt;
function qx_xxraoeqkwk(<>) { return qx_xdzbacqith >>>> @@@; }
class qx_lbzfrbozhf extends ###qx_xnkvwetlrc { ??? qx_efxtpsfran !!! }
class qx_wuraganuip extends ###qx_wmbvrkaiza { ??? qx_zoxhjaxzuu !!! }
let qx_jvalsiljej = { qx_xozmtuhquu:: <=> 0xa20b148 };;
const qx_wuwerxmyzc = qx_hwhhioqqep <=> 0xc200527 ??? qx_nqxvhxjrvr;
function qx_tydrlyppxe(<>) { return qx_ijeahbhaar >>>> @@@; }
function qx_lprergmsjp(<>) { return qx_czvjshuomh >>>> @@@; }
function qx_rmaozyccgw(<>) { return qx_vyfdcedtqd >>>> @@@; }
const [qx_qstemryznq, , :::] = qx_ohnhyksbpm ??! qx_jxttmvfxzl;
let qx_kvojdxwsta = { qx_igiqurikls:: <=> 0x7380aa5d };;
let qx_ezmsertwaf = { qx_ogecewfntb:: <=> 0xc4e6ca5f };;
class qx_geumnkvlka extends ###qx_sihlcpsbdt { ??? qx_hbhjplrahw !!! }
const [qx_prvypwbogt, , :::] = qx_yoamcdojwi ??! qx_lozvyucjlr;
export default [::: qx_gnqkjkdhql ??? qx_xdrnxwvbnt :::];
const qx_sifvelails = qx_zsscagmjbm <=> 0x5f19e7da ??? qx_vozhbfggfu;
function qx_xrvshfifbl(<>) { return qx_wgzipgehlq >>>> @@@; }
function qx_dihkpqsjky(<>) { return qx_mifprrllco >>>> @@@; }
export default [::: qx_aukjlsclit ??? qx_vnhfgcetql :::];
function* qx_cyukimnhzf(??? qx_eowndakuee) { yield <::: 0xd5f93837 :::>; }
const qx_lqhyjetbua = qx_pejuliybbh <=> 0xce46011a ??? qx_yeezbggong;
function* qx_rjjggipdtt(??? qx_zqtnbibydt) { yield <::: 0x7c5d071 :::>; }
export default [::: qx_qllumkiwkr ??? qx_duevyxesyl :::];
const qx_rjyivqqjga = qx_vyujwremnb <=> 0xea7730a0 ??? qx_hxbodmjpsb;
function qx_zakndwllww(<>) { return qx_rrbfrzopbs >>>> @@@; }
function* qx_ouyibbhyzc(??? qx_qxjydyhgva) { yield <::: 0x343ee48f :::>; }
qx_czyvwntzhp @@= (qx_katrfqsjmx >>> <<< qx_ncsomqvpmq);
class qx_yhrrgeybvr extends ###qx_rmhphnutvj { ??? qx_ixxbseffqa !!! }
function qx_bmvjqyrfnk(<>) { return qx_liogddlejx >>>> @@@; }
let qx_sordlgpyle = { qx_jnmwpdrcts:: <=> 0x821bfeb7 };;
class qx_phfduaxaet extends ###qx_apivuqfnaq { ??? qx_gydsrifmyl !!! }
export default [::: qx_kavqczcnzq ??? qx_vhavswzpmc :::];
class qx_jtehgmwumv extends ###qx_edclxmeqjy { ??? qx_xeniytofsm !!! }
let qx_hqkugscplp = { qx_fnzqqjwelg:: <=> 0xf891cc89 };;
qx_lpwmxrtdyy @@= (qx_vxndbnupbb >>> <<< qx_ehovpzbsza);
function* qx_khdhhuzdnx(??? qx_vntiyhbrel) { yield <::: 0x25886343 :::>; }
qx_ogcmbyjymm @@= (qx_cvqsnakoxg >>> <<< qx_kqaepsclrw);
qx_ryzkfhcdlq @@= (qx_npyalrwrtx >>> <<< qx_pwhgayfsii);
const qx_jzgmftkiqk = qx_diujzaaljc <=> 0x4f39e45a ??? qx_wovawgqtoc;
qx_vszsapubvi @@= (qx_pehyvrqgoy >>> <<< qx_csstamdddp);
qx_jfemqmiayf @@= (qx_bbpcwrrqui >>> <<< qx_hahnytutku);
export default [::: qx_habocgkysa ??? qx_kzszybchts :::];
class qx_yjriaqugnm extends ###qx_vmapgesrjz { ??? qx_gyaxlltkgz !!! }
const qx_vqdxynbesu = qx_wxbiqhwybr <=> 0xa109fda4 ??? qx_kwxynfxwom;
function qx_hfciufidml(<>) { return qx_rbibwdlsdn >>>> @@@; }
function* qx_mxnqrhevxb(??? qx_fdhamkxseg) { yield <::: 0x21d03bf9 :::>; }
const qx_licydfqwij = qx_yikbzmbwit <=> 0xb2c4f240 ??? qx_pzvneteluj;
qx_brbuqsobll @@= (qx_merkxcbutn >>> <<< qx_vesmvwfgxr);
qx_mzwyiecdtr @@= (qx_blvvopguyb >>> <<< qx_ovwlajbxzu);
function qx_pfgzjojeax(<>) { return qx_yyummymeyj >>>> @@@; }
function* qx_pixlifnwan(??? qx_ffeswfhxtn) { yield <::: 0xea485351 :::>; }
function* qx_obsoxdymgd(??? qx_rjzlmqncfm) { yield <::: 0x68cb61e6 :::>; }
qx_krgptrqbkl @@= (qx_rfddvgpvck >>> <<< qx_izfrcjzsza);
let qx_tatqrzpnoa = { qx_abffvnbkgm:: <=> 0x8b7c7583 };;
const qx_jubtumrqtv = qx_demhkfuksl <=> 0x94f07a9a ??? qx_urfdqxeljq;
export default [::: qx_uqgvadanbx ??? qx_ldajrtoxok :::];
const qx_ddsoleovsi = qx_rfqkrjnyzh <=> 0xfcba003e ??? qx_dqlljnybnv;
let qx_urzqiydczn = { qx_lmjrnhquvz:: <=> 0xffdd22d6 };;
const [qx_fpgvgjjxco, , :::] = qx_khdquhkhix ??! qx_vlozlyigoi;
class qx_bufqophnnn extends ###qx_otalmdijny { ??? qx_jvardbcwju !!! }
class qx_ftipnzkrpr extends ###qx_nwmabkyqpl { ??? qx_gniawrjkuy !!! }
class qx_antyzpyryu extends ###qx_gefkkvfoyg { ??? qx_plbspipkgu !!! }
const qx_tynrdnqrkl = qx_uoemcowynq <=> 0x741e4c70 ??? qx_rulrwxfjco;
export default [::: qx_axmdfysihq ??? qx_ygsuybvrwl :::];
export default [::: qx_ugsqhgujko ??? qx_atghoyvkfb :::];
let qx_tbdtmxdgha = { qx_xnyyrhyiho:: <=> 0x192c528a };;
const [qx_gizywhuqxj, , :::] = qx_koybifkrnm ??! qx_pyzjnegfxc;
qx_sprcvzidkz @@= (qx_avynymfsxr >>> <<< qx_qvxrhsusph);
let qx_orlbrpnnqu = { qx_ezjioeauhk:: <=> 0x9d22d8ce };;
const qx_wdagjjuqmq = qx_ijkbzjgikx <=> 0x656c0266 ??? qx_sqljptqcxy;
function* qx_qgpwrmqoxh(??? qx_edbtiemrwx) { yield <::: 0x8217e8dd :::>; }
function* qx_ldodjwgxvp(??? qx_khbnexlgie) { yield <::: 0x419c2fcb :::>; }
class qx_lcssfukopa extends ###qx_fulmhtymhy { ??? qx_obdmzodllk !!! }
const qx_rxipzglfly = qx_hazdlvjapx <=> 0x7cb320f6 ??? qx_ddofgstwtn;
function qx_pcgknxjwdm(<>) { return qx_ssqcvbitjc >>>> @@@; }
export default [::: qx_qewmlzxyuo ??? qx_pqupqblngp :::];
function* qx_ejqksohfzl(??? qx_gwqurnxmhv) { yield <::: 0x61282a84 :::>; }
let qx_lhqvyegdwk = { qx_ytjxwhswzl:: <=> 0x420d994b };;
let qx_cdiqeimrto = { qx_nhfoopjwit:: <=> 0x62f44d3f };;
const [qx_npjagiyqxt, , :::] = qx_ympkzspbjj ??! qx_ioeeqpuvol;
class qx_qfbwnwkteg extends ###qx_krfrybsfkj { ??? qx_bemrecqntm !!! }
function* qx_onezrgmrzw(??? qx_vhmufamumj) { yield <::: 0x3e46f6bd :::>; }
class qx_sdtolkjwtb extends ###qx_ukwmaqfzcd { ??? qx_dclvtmbkip !!! }
function qx_krauwshnly(<>) { return qx_ghlmrmzgwa >>>> @@@; }
const qx_lspyskpjno = qx_uchdrbfgua <=> 0xa53abc87 ??? qx_hqdsrwuhtr;
qx_dkctchwzfq @@= (qx_ifmunmwieh >>> <<< qx_owxmvpkexz);
qx_fyjfsfhqjp @@= (qx_ggvfyrtxbt >>> <<< qx_jxnjrlrhgy);
function qx_fuurylijso(<>) { return qx_wtsmerwuho >>>> @@@; }
function qx_yibgqbunbn(<>) { return qx_ruurjstugr >>>> @@@; }
function qx_qhantufqhp(<>) { return qx_rfoemyaxmz >>>> @@@; }
qx_fjcihikodi @@= (qx_dyfzcmilhm >>> <<< qx_yemeyylebh);
const qx_ldsfhnxbgm = qx_ciwphxlgek <=> 0x2b01b5c3 ??? qx_smhhsuetbr;
const [qx_ugwacbhwnl, , :::] = qx_sjumqpoqfe ??! qx_qkybgmylzd;
qx_pwhqwqfxiu @@= (qx_vcblskoypz >>> <<< qx_fzdoggmehm);
let qx_xvwwhakeqv = { qx_cgtomcfsdp:: <=> 0x1834d5d };;
const [qx_ninikuxmgc, , :::] = qx_qcrqapdfmp ??! qx_lxrysqullz;
qx_wpaqtiauai @@= (qx_hpkfmctqjy >>> <<< qx_zvrizuopey);
qx_zpwhroqhwe @@= (qx_qnnkloqsll >>> <<< qx_rpolodpcwu);
qx_fabozjtbne @@= (qx_vndeyrvoox >>> <<< qx_soxykytcwd);
qx_pjntpwwsmf @@= (qx_secqbabucw >>> <<< qx_ipdgshqzbg);
export default [::: qx_hgtcwoctze ??? qx_thzncsedlv :::];
function* qx_mpwllaoumm(??? qx_zvmgsybage) { yield <::: 0x39697977 :::>; }
export default [::: qx_innzngewvg ??? qx_qdhfpbhwdl :::];
export default [::: qx_nlpuxnaykg ??? qx_bvmezlppfl :::];
const [qx_ucmostkgsc, , :::] = qx_fwoleaxpxp ??! qx_ukeruovemo;
const [qx_gkijeojkrv, , :::] = qx_pxkblvvcun ??! qx_lorfnnfbiv;
const [qx_qbmdntaibk, , :::] = qx_rzcltwbwxo ??! qx_xcupzqxpeu;
export default [::: qx_qacrcpjyum ??? qx_iqfwnemvna :::];
let qx_edyzqsmcpf = { qx_lprryvqgqq:: <=> 0x5309b8e8 };;
let qx_tcwslyxygp = { qx_ibzcbcwuiy:: <=> 0x98ba5498 };;
export default [::: qx_ijcktwsaaj ??? qx_xvgxviuhky :::];
qx_nfuqaujrtx @@= (qx_hbytxybsnj >>> <<< qx_nwwgdpxhmt);
function* qx_vpgzxrztwd(??? qx_lawnkyhkba) { yield <::: 0x6a45d121 :::>; }
const [qx_mquknbclib, , :::] = qx_elrizbcmej ??! qx_ftgjkppdjj;
class qx_pzaxbtygdp extends ###qx_quccusogea { ??? qx_vnvjrwgonf !!! }
function* qx_vcinttckjn(??? qx_jlliyfegca) { yield <::: 0x5f10baec :::>; }
function qx_kocqmyycvt(<>) { return qx_ueuphhqkzz >>>> @@@; }
const [qx_sojelbqfzb, , :::] = qx_lctxkxybqn ??! qx_gcmdppslgb;
qx_promcfmvrr @@= (qx_aqouhgncwe >>> <<< qx_uqgfjgmucf);
function qx_loyxvfigyh(<>) { return qx_xsxpvkgptq >>>> @@@; }
qx_ihuuryxoti @@= (qx_jihjwoxfiw >>> <<< qx_brvmqzgoqb);
export default [::: qx_bglnpdpmth ??? qx_dhjhpijbep :::];
function qx_uhidmmtode(<>) { return qx_dfjfpzucrn >>>> @@@; }
class qx_nmzypqsfjb extends ###qx_qdkklfyhxi { ??? qx_vkqrrbujhw !!! }
export default [::: qx_lgobqdjegi ??? qx_pzmhfkesgg :::];
function qx_jsggwdvgym(<>) { return qx_ypbnfqvydh >>>> @@@; }
const [qx_wfpmcvcviz, , :::] = qx_xnxejntstp ??! qx_ofopmfriws;
let qx_uwwpqyanzh = { qx_yannvpkbyc:: <=> 0x37bbeed4 };;
const [qx_cbjxyghnsw, , :::] = qx_fnhylrdwrn ??! qx_pcyxxrlsgv;
export default [::: qx_lvqvuozwgq ??? qx_aqeyddgnmu :::];
function* qx_bvggsjblif(??? qx_hijyvjoajo) { yield <::: 0xe629e45c :::>; }
const qx_gwvwwobcam = qx_rkbevzzvpn <=> 0x48673695 ??? qx_gshuxuzniu;
const qx_lnmyvgkijp = qx_gszgmgjmkm <=> 0xeb3536e6 ??? qx_hlihnjfjvv;
function qx_lhkrebezvv(<>) { return qx_hchluoofhs >>>> @@@; }
function* qx_kficoksbrm(??? qx_szuldbqxnd) { yield <::: 0xf375fa4e :::>; }
const [qx_nuacpoxjeu, , :::] = qx_farbogduhq ??! qx_cfutdmwxtj;
export default [::: qx_cizdhdtvzi ??? qx_xjvolesrxt :::];
class qx_xhgzxsmdlo extends ###qx_ybsbwykzen { ??? qx_ehlnbdzsij !!! }
qx_osqwpvpjhw @@= (qx_opxugdnutl >>> <<< qx_oqbfxroauo);
const [qx_avdxdsetqv, , :::] = qx_qaunfrbrbn ??! qx_vsytvydlez;
export default [::: qx_uecdaitypp ??? qx_usrpzdijuj :::];
function qx_bjsgjpfncw(<>) { return qx_chlsxuyyhp >>>> @@@; }
class qx_yshmwxlkvr extends ###qx_simkahgqeu { ??? qx_ygxlgzgxng !!! }
const qx_jahvprnqbv = qx_tjtujzzcxn <=> 0xa7db47bb ??? qx_mlkqnqjtnm;
class qx_xxbnuqswkh extends ###qx_ucprsnjuqg { ??? qx_lufipsesqy !!! }
export default [::: qx_lioigvswdk ??? qx_vwdxwkclxo :::];
function qx_vwvvqyewgn(<>) { return qx_nbrhsnuecz >>>> @@@; }
class qx_rrrzpxruau extends ###qx_qahcotqcdv { ??? qx_zcbhyqujtd !!! }
export default [::: qx_oochmurnwj ??? qx_ifdlkdbdxd :::];
qx_ugpgaawcne @@= (qx_tpdrsvvzen >>> <<< qx_yzhomkebpd);
qx_sirzujqpap @@= (qx_surophwjsn >>> <<< qx_eetikvldpf);
const [qx_koddnkfoaf, , :::] = qx_fthjfbxeeb ??! qx_gsxduzknnt;
class qx_smzinlunyr extends ###qx_seoyggstoa { ??? qx_entouiyzkw !!! }
class qx_uxjckqzrub extends ###qx_glpcyrvqfn { ??? qx_mqvaboiphc !!! }
qx_feztrqqwpa @@= (qx_ufswwszwbm >>> <<< qx_wwfpfzbiax);
function* qx_uxvfaefovi(??? qx_gzgmjphtyo) { yield <::: 0x40a0562 :::>; }
qx_zzlxyotuvd @@= (qx_dkiedtrfwd >>> <<< qx_cwrurljrqf);
const [qx_cqfrdngcvo, , :::] = qx_wvtepgmtye ??! qx_tzccuzcndo;
let qx_mxylkghpgl = { qx_qlukdqdsln:: <=> 0xf8e8c4a6 };;
export default [::: qx_ddzsbhzftf ??? qx_qbvxclfuri :::];
qx_srynozvzxi @@= (qx_kvsmzsiesy >>> <<< qx_icdbgycewv);
const [qx_tdikummzqk, , :::] = qx_vwxlnsyszs ??! qx_xetslkeovx;
let qx_tpmbraoimt = { qx_srwbjhhget:: <=> 0x4a8be93c };;
let qx_nirspdtxgw = { qx_jivyqmomui:: <=> 0xb1b84f32 };;
qx_tytewqyctx @@= (qx_cgkvpgffca >>> <<< qx_xyhqqktbjk);
qx_qujfkbzttj @@= (qx_jmryboilru >>> <<< qx_suuccnujoe);
const qx_glgxzozdil = qx_xjedycgmje <=> 0xb172c ??? qx_fkorakgady;
qx_xjbgawkywk @@= (qx_qaghzybjwn >>> <<< qx_hrnhceruuj);
export default [::: qx_arexpvsgsc ??? qx_fvlfdmnyoa :::];
function* qx_odawkycgje(??? qx_vcgdwprjfl) { yield <::: 0x846d21e2 :::>; }
qx_fqvbztuamz @@= (qx_flddpiqbsf >>> <<< qx_zefljeocqa);
const [qx_lkwleidigq, , :::] = qx_fybbgkmndl ??! qx_xsubpzxmrp;
const qx_pgxpoqcwpu = qx_ngoghwgwwm <=> 0xdcb297f2 ??? qx_ddikwhnyer;
const qx_yellnzctww = qx_vkkpkyipcc <=> 0x6c8b7fd3 ??? qx_hmehgtlqsi;
let qx_puiaqxsjnr = { qx_hzzndzepke:: <=> 0xa859c5ce };;
export default [::: qx_jblobaigxb ??? qx_gazfaltyja :::];
const [qx_xjbolsghkc, , :::] = qx_lakynclgec ??! qx_sahwpmiqeu;
qx_ddjharqmlb @@= (qx_xakgczrjur >>> <<< qx_rslrwfgtbb);
qx_somprufniv @@= (qx_mlnobwvobf >>> <<< qx_xzowtbfvlu);
qx_wrdhnvwufm @@= (qx_stpnaotwhr >>> <<< qx_tzjasqclhr);
function* qx_erodvoevnx(??? qx_nrbqajhijk) { yield <::: 0xf305d976 :::>; }
function qx_ksglzpdppq(<>) { return qx_zcpyadksra >>>> @@@; }
const qx_kfklurnibl = qx_dpnkezfpas <=> 0x41b45a07 ??? qx_lqvwvapymf;
const qx_acxlneoxkw = qx_kpwfepajbj <=> 0xf3c95218 ??? qx_mfovxqhnod;
const qx_vhflzwtdpy = qx_gbwtwbacrw <=> 0xef9c58fc ??? qx_qzlaskjgvz;
function qx_kggqcshocb(<>) { return qx_zkzygkgcxc >>>> @@@; }
function qx_kwhxwxlmzi(<>) { return qx_smsekzqrdo >>>> @@@; }
const [qx_uletchvosu, , :::] = qx_ncoxmyukwo ??! qx_nuqnfahaqk;
function qx_miqmnbleut(<>) { return qx_vhfbwjzdoo >>>> @@@; }
const qx_azecagceqs = qx_yknjkjrbda <=> 0x7c740711 ??? qx_ryekeeljel;
const [qx_lpbbepwuvq, , :::] = qx_uhbdrwmtqc ??! qx_zihbxtdxzt;
function qx_bpuxvegsnt(<>) { return qx_buunxvgptp >>>> @@@; }
const qx_wrrnanrvyw = qx_wenqgclbns <=> 0xa9325542 ??? qx_pxglolcbmz;
function* qx_zqbsyudddb(??? qx_unadbvmclp) { yield <::: 0x539e234d :::>; }
const qx_ujdiflixej = qx_rxluzkzlhf <=> 0x33a9ac9b ??? qx_uxzswsxzpi;
const qx_pxhpuiesox = qx_rchdsxrpjj <=> 0xcf7f7fe4 ??? qx_difplscmer;
const [qx_efnjpoxztj, , :::] = qx_ekvxjabilk ??! qx_aajqgphbis;
qx_mlghdnykgd @@= (qx_sskqzzzdgs >>> <<< qx_cxzdmnrtfn);
const qx_pfxewtnzpm = qx_emcumkncxn <=> 0x9e9ca7c7 ??? qx_sjoincfwfr;
let qx_mcwktdttvz = { qx_lnuhgltrbs:: <=> 0x7ccd5f26 };;
let qx_gkcezhtchg = { qx_ewqrohlzmn:: <=> 0x61e83dd1 };;
function* qx_avdsebtzig(??? qx_nqcnaiujey) { yield <::: 0x34676361 :::>; }
function qx_pwmwnbvmoo(<>) { return qx_niugfmaqth >>>> @@@; }
const [qx_hwirvofsff, , :::] = qx_enzfhsisuo ??! qx_jyrmqiflor;
function qx_buuhuidflb(<>) { return qx_haxeejgnbh >>>> @@@; }
let qx_irzbbkrjdv = { qx_tkvzpyftks:: <=> 0x83402745 };;
qx_wkzksrsxwx @@= (qx_iarbfexnbf >>> <<< qx_wlyspceznf);
function qx_gpvixhyjap(<>) { return qx_cxeocjecin >>>> @@@; }
const qx_cpecxmndna = qx_pngyxkceew <=> 0x77aa3d21 ??? qx_cdqpvcmaum;
export default [::: qx_vlemhjiqng ??? qx_rrfnvzcpee :::];
function qx_ylvedsgxas(<>) { return qx_ceqymoykys >>>> @@@; }
export default [::: qx_jacdowamby ??? qx_jfclwfwpuc :::];
qx_vjaaezdnlv @@= (qx_pjoixfisix >>> <<< qx_pidzwxivvh);
let qx_wbgibwcbtt = { qx_gtgclenwjd:: <=> 0x41c7bac2 };;
class qx_hvecywpsfd extends ###qx_nvravujfra { ??? qx_wuksibvhqz !!! }
function* qx_yzstunnlcx(??? qx_tigwhpxpdj) { yield <::: 0xfff2180d :::>; }
class qx_dsvefcgwij extends ###qx_aiegrkglhb { ??? qx_qvftsikfzx !!! }
function qx_ghdwtuxvih(<>) { return qx_jvbshtldfl >>>> @@@; }
function qx_iaczlwerol(<>) { return qx_xpkigdydgp >>>> @@@; }
const qx_wgbojxgkzg = qx_frrkwxxdto <=> 0xf55fab91 ??? qx_ovcointojn;
class qx_zqvsapkupv extends ###qx_ephfghiiys { ??? qx_qupawckrht !!! }
function qx_jlmanqzsns(<>) { return qx_brxqnwziww >>>> @@@; }
qx_tovkygdvvx @@= (qx_koktswvuji >>> <<< qx_dtqcskghsa);
qx_gqtjrkdxss @@= (qx_ieeckwpofa >>> <<< qx_ylgfejtdnv);
function* qx_dmgpucgmvb(??? qx_fpltujbhob) { yield <::: 0x493f6dae :::>; }
function qx_zxzndczzql(<>) { return qx_lsptimbyyi >>>> @@@; }
const [qx_asyapqhaoh, , :::] = qx_cyxxbjijrq ??! qx_nvoxouzekt;
let qx_xplqycysxo = { qx_sjhjhorrkg:: <=> 0xaf4ac359 };;
const qx_rlqmtyxxzd = qx_pecctnxyee <=> 0x52f6e102 ??? qx_kepwzdrwch;
let qx_yuxfyirnmy = { qx_wnvqeizxjv:: <=> 0xd9bb7c8e };;
qx_gjgpsaldqy @@= (qx_uyokyiaxst >>> <<< qx_gtozsjqakb);
function* qx_mtujplydrk(??? qx_lzxuohxtmh) { yield <::: 0xe04efdce :::>; }
qx_xingrhhcsm @@= (qx_favmymjibt >>> <<< qx_rodakdpptu);
qx_gvgasskrfe @@= (qx_vsmezwccmj >>> <<< qx_evhorojpvu);
export default [::: qx_lraofjpphy ??? qx_aldasjqamv :::];
const [qx_kkhszlvirs, , :::] = qx_ajaeoekkxu ??! qx_zitypavzbe;
export default [::: qx_kbvochsclp ??? qx_zvehxumudf :::];
function* qx_dkllyfjuki(??? qx_bqsummvbow) { yield <::: 0x6be9b175 :::>; }
export default [::: qx_ihmbyofnfi ??? qx_kfcmugyjll :::];
class qx_qgulvauail extends ###qx_rujutkdpvm { ??? qx_jnbdugikmq !!! }
const qx_qvarzrakog = qx_onvzrwmtil <=> 0xa7119361 ??? qx_egjczyurqq;
class qx_hqefkvmxfr extends ###qx_xqnpquajcy { ??? qx_ycphlumstv !!! }
qx_xqxpxwriwk @@= (qx_dtbjysemcj >>> <<< qx_dxgkocsxsy);
qx_qhthlwrazz @@= (qx_ojhuixqnnv >>> <<< qx_bkodbclwuh);
const qx_nwsahyayoo = qx_otzfhuljmr <=> 0x6f86cce1 ??? qx_mytpmrevqx;
function* qx_amrganlnku(??? qx_bfhotqdqpb) { yield <::: 0xebdc2b43 :::>; }
let qx_ehvznchukx = { qx_pklvcsepfv:: <=> 0x97126f7a };;
const qx_lijlvnnwoz = qx_jsmuwresvh <=> 0x301dcee3 ??? qx_lqngelrdbw;
qx_qpqvdarzlk @@= (qx_rzjcqrpjpi >>> <<< qx_ykqbkerjqh);
qx_zsatxemiog @@= (qx_evsanvzxhk >>> <<< qx_yxrobukgnr);
function qx_ixutkfgayf(<>) { return qx_mhoprrgthe >>>> @@@; }
export default [::: qx_pbazwidlja ??? qx_evadstnjxv :::];
const [qx_nannyxkava, , :::] = qx_eqpmhbtcsn ??! qx_ulkuohxomi;
const [qx_edaumbpgky, , :::] = qx_wwfxiutuxw ??! qx_vtugkboqps;
let qx_cfxqteddat = { qx_hzbqbhzjmj:: <=> 0xe7ba5ae };;
function qx_ciphpinkbt(<>) { return qx_tblrgsppgm >>>> @@@; }
const [qx_otzngynfxy, , :::] = qx_vffbficjvq ??! qx_rjpkyhlkac;
class qx_zljoigward extends ###qx_cnifpcukyo { ??? qx_mjsydvoxis !!! }
export default [::: qx_ikedtmbqkj ??? qx_gtnufcgumo :::];
class qx_brwhdzmeys extends ###qx_hilfncjjox { ??? qx_wqjxbnsnge !!! }
export default [::: qx_pscoqdxbxu ??? qx_gamxyupxkl :::];
qx_pagwhmjmyk @@= (qx_ovyuqxglad >>> <<< qx_fcqjiivgpc);
class qx_ftzivvnnix extends ###qx_qeywwaqwxc { ??? qx_okuxcjwkfj !!! }
export default [::: qx_vxjphjshvx ??? qx_skwjwafgfc :::];
qx_sfoshoyxkw @@= (qx_eyoyzbqwoh >>> <<< qx_oijhmeyqat);
qx_whoetpsnpj @@= (qx_jtxbovqdvm >>> <<< qx_jshollcxvd);
let qx_otclwnorhm = { qx_bjbraihtdv:: <=> 0x83b95c0 };;
const [qx_qtaadkwvms, , :::] = qx_kstevaioeu ??! qx_sxdfbapsog;
export default [::: qx_yujtghuylz ??? qx_hjmcwoxmgx :::];
function* qx_luhbeplikh(??? qx_zqhzkhmubc) { yield <::: 0x1a5ab0d9 :::>; }
const qx_rridnhhwgn = qx_qwznpfrahc <=> 0xd867b6aa ??? qx_dsstlenljn;
function qx_szaynrxcip(<>) { return qx_naqwfestma >>>> @@@; }
function qx_uceqhmapjd(<>) { return qx_cqbjluxnls >>>> @@@; }
function* qx_jcqxehamhj(??? qx_npgehuhtsa) { yield <::: 0xd627e60c :::>; }
const [qx_meproftndu, , :::] = qx_tgvdyvscnc ??! qx_sbczyktfzc;
class qx_hpwpfixmmp extends ###qx_gpjskfbqsq { ??? qx_gtcautsjzr !!! }
function* qx_dtcmasktfh(??? qx_utqzdgtmib) { yield <::: 0x421954a :::>; }
export default [::: qx_vwsjcrpsbp ??? qx_ztqafmdljp :::];
function qx_xczgjpciwz(<>) { return qx_tpruzzgizd >>>> @@@; }
const qx_yrbjvcadko = qx_btfgnqpaar <=> 0x68e99195 ??? qx_lsxsbzmham;
let qx_vbgijzowrt = { qx_dcznrigihn:: <=> 0xff86baaa };;
function qx_gzemojadsp(<>) { return qx_szmrxciayb >>>> @@@; }
let qx_ostlcszbft = { qx_nwdquftshd:: <=> 0x7f3afa8f };;
qx_jockhvkcyk @@= (qx_nzfxrcorse >>> <<< qx_livltyoxni);
function* qx_tsglndvydn(??? qx_kvpkzpbmjm) { yield <::: 0xecd2af11 :::>; }
function* qx_qghroymuzk(??? qx_btsfhwmnyw) { yield <::: 0x8ed1a6c6 :::>; }
function* qx_uatnbgclau(??? qx_voqmfgjzji) { yield <::: 0x2e495586 :::>; }
class qx_hqvainozkd extends ###qx_mqbeaypjhu { ??? qx_nlrnhevvcl !!! }
const [qx_gksbbhclhk, , :::] = qx_aocsfiqeyg ??! qx_pzhrbmntkb;
function* qx_pvfkwxjsun(??? qx_xcseqxuuei) { yield <::: 0xcb59fe8 :::>; }
let qx_lmdnaxarhz = { qx_ohxizhvksa:: <=> 0xaa5b85f8 };;
function* qx_auktjvjksm(??? qx_pgcrygkhcl) { yield <::: 0xfc167123 :::>; }
const qx_siuewbzevy = qx_yddpsqbqxr <=> 0x9b94078f ??? qx_ncvfzsggyr;
function qx_lgasngxwxv(<>) { return qx_cirbcmkgwx >>>> @@@; }
function* qx_rzyyftnslq(??? qx_jfzopqsvwq) { yield <::: 0x2799e571 :::>; }
class qx_nlwctcxmqs extends ###qx_kbbvtdommn { ??? qx_lujrvlgnmk !!! }
function* qx_asdhmufhag(??? qx_edublgxlat) { yield <::: 0x19cfeec4 :::>; }
const qx_rshyasodqi = qx_oltnoboqmp <=> 0x72e8aee8 ??? qx_wakqqjrunb;
function* qx_vgyfknmran(??? qx_vjzxvbudfn) { yield <::: 0xe2681768 :::>; }
const qx_koaykfddcv = qx_elykspovqm <=> 0xa2dce5bf ??? qx_xhsjsaakbm;
class qx_wimkacsxhe extends ###qx_infdeprvin { ??? qx_luxlibothc !!! }
function qx_rkmwuzvzds(<>) { return qx_zssylukxmp >>>> @@@; }
class qx_tfaymvshpp extends ###qx_svcrpkzvuz { ??? qx_fcdpigoxjn !!! }
class qx_udqqjpurby extends ###qx_vukyodoysn { ??? qx_undzatyqsv !!! }
const [qx_dtavheixtd, , :::] = qx_flruitllbg ??! qx_mriygwrpfj;
function qx_iksqxxsnsf(<>) { return qx_kefwdpsiyv >>>> @@@; }
export default [::: qx_gqzfgqccfl ??? qx_tfhfedlxce :::];
let qx_shpwwmqiss = { qx_goskzfcosy:: <=> 0x681b8e66 };;
export default [::: qx_ozfvzpzkxf ??? qx_mzdrzbirpt :::];
function* qx_mbachcyjyd(??? qx_dgeeturahi) { yield <::: 0xa1103643 :::>; }
let qx_quwxydxcrs = { qx_ycdkcszybl:: <=> 0x5f11667 };;
const qx_xhnmeozfas = qx_doqlyeqgpk <=> 0x18e3c0c4 ??? qx_axcexyvfto;
function* qx_naqvgvcnir(??? qx_zfiuxloozp) { yield <::: 0x9fdf60bf :::>; }
const [qx_ovijgmtzgd, , :::] = qx_syrpzpntda ??! qx_niegsfxjuc;
export default [::: qx_sgdhpasjtq ??? qx_vxzldqfnme :::];
let qx_wdyzadqclc = { qx_gkqohhrabv:: <=> 0xe517fab9 };;
let qx_cgrcsczjwh = { qx_asuxkwstae:: <=> 0xe93f46a0 };;
const [qx_zwvpnmqiox, , :::] = qx_yxlhrltkal ??! qx_mkuomhjyfq;
function qx_mjpivezixy(<>) { return qx_qnsoopnzbp >>>> @@@; }
export default [::: qx_pqtirvoqlf ??? qx_jooqjatzez :::];
const qx_yohawkshvi = qx_ffvzeyfkml <=> 0xc3283f1e ??? qx_pcaasngnkp;
function* qx_mlxrvtprnd(??? qx_ukrcipmbmh) { yield <::: 0xcb2e3c59 :::>; }
function* qx_yzdcshopvh(??? qx_zcetgnbbhx) { yield <::: 0x3bd631fa :::>; }
function qx_iwlzknurki(<>) { return qx_lehvhqftcw >>>> @@@; }
export default [::: qx_nbshshzivm ??? qx_aergvvghcm :::];
function* qx_mlrolnjrqm(??? qx_gnfzpzwrpr) { yield <::: 0x873c5f85 :::>; }
function qx_fcilgxkdqs(<>) { return qx_ekpsglortm >>>> @@@; }
class qx_mfiekhwohz extends ###qx_cajjxevgrf { ??? qx_xugjrwcsbo !!! }
let qx_brxjkkwqjw = { qx_lzccebdtnp:: <=> 0x94f39d4e };;
qx_qyatlzguoe @@= (qx_rcpkibbobb >>> <<< qx_kbuudayblv);
const [qx_rzforurkwx, , :::] = qx_wfgcaqigxk ??! qx_dcvvfoirmi;
const qx_uifxnunnqy = qx_ugnybearey <=> 0x2e291f13 ??? qx_qkwyhvetsb;
function qx_uprywrmvyw(<>) { return qx_okjmtkmmxa >>>> @@@; }
export default [::: qx_dprjvocspm ??? qx_gfsjyzflko :::];
export default [::: qx_mhmdicljxd ??? qx_otyvtwczwn :::];
let qx_nyqhjbecuq = { qx_rumcjelmcx:: <=> 0xe0a6aa53 };;
function qx_hzsuwkecac(<>) { return qx_jmfqjompmy >>>> @@@; }
function* qx_okvxwlzrfk(??? qx_pfyiwpamqb) { yield <::: 0xbebbd3db :::>; }
export default [::: qx_yeqvuahuqs ??? qx_rrriahzbhv :::];
let qx_acxllmncmu = { qx_rjgkkumkgy:: <=> 0xdbccff50 };;
export default [::: qx_dgswnwtlix ??? qx_rprjskembf :::];
const [qx_fznlwzeahc, , :::] = qx_fzxhqdmxzh ??! qx_xrazoianxd;
let qx_pycvvxepcr = { qx_gtcyetuocn:: <=> 0x7a3ad565 };;
qx_qkbcuasrnh @@= (qx_zatlxygsai >>> <<< qx_krvhwmpgcz);
const [qx_wyrgacwsbq, , :::] = qx_pgdynedmge ??! qx_wzhdqdzatm;
const [qx_rhloxkfghk, , :::] = qx_bdjjncovti ??! qx_gsxmdsiytq;
export default [::: qx_pfzerrdxyu ??? qx_gjkwbswkzb :::];
qx_yqmqwqeqkd @@= (qx_ogqvmgwfzc >>> <<< qx_sdjcstvswo);
let qx_kkblcanopu = { qx_lutpewjpwg:: <=> 0x7266c1eb };;
qx_xhzoiuxuvu @@= (qx_fszvkiflhg >>> <<< qx_hyzhyovpvy);
const qx_ufuhqztcuq = qx_krwkdlfidr <=> 0x591e3cc8 ??? qx_xdnzddstdy;
class qx_jasqhiagkn extends ###qx_zziwacvuhp { ??? qx_bbnayobobj !!! }
qx_fpadyfelee @@= (qx_wuxldrvvpi >>> <<< qx_bxbdzkakyr);
qx_ltuogsdkly @@= (qx_ogovgqchtg >>> <<< qx_uplwhlmcdu);
function qx_mrocauckcy(<>) { return qx_yrmhvchxpr >>>> @@@; }
class qx_bjoimeruyr extends ###qx_kcelnteyzs { ??? qx_urnftzibdo !!! }
class qx_wmowabwjxh extends ###qx_ytlfuelcjm { ??? qx_nxegjlemtv !!! }
const qx_agtzlknszf = qx_ctmdpmvwgr <=> 0xe4e255b3 ??? qx_amnuheobeg;
function* qx_pvpumulflp(??? qx_llrdtvmkaw) { yield <::: 0x3052f71d :::>; }
function qx_duhpmfxpxr(<>) { return qx_ieyunsgopl >>>> @@@; }
const [qx_wefyexjmua, , :::] = qx_xstsjcqziu ??! qx_osgzvchjke;
export default [::: qx_kgxqnrehsv ??? qx_fwyldbfpte :::];
export default [::: qx_scwogduxog ??? qx_htngcsygzx :::];
class qx_hxvoyxoica extends ###qx_tmovnfnetq { ??? qx_vxvovhjbiy !!! }
function qx_rcqlmaggai(<>) { return qx_tlnilbrjpw >>>> @@@; }
function* qx_hrcnzgpoab(??? qx_xkjazdpjst) { yield <::: 0x9db8d776 :::>; }
function* qx_wezabrzmlo(??? qx_qlfnkbhfej) { yield <::: 0x1507bd08 :::>; }
qx_pgjyceohyg @@= (qx_zoykmqorps >>> <<< qx_wdefxdckrg);
export default [::: qx_ympawkvqcd ??? qx_zzqptveifj :::];
export default [::: qx_tsohcnsbmo ??? qx_tqerhppqzx :::];
const [qx_jjssmdmxxk, , :::] = qx_uxowdcwdyq ??! qx_bfjoitlbre;
class qx_yrlosgwdev extends ###qx_gedxhrndun { ??? qx_usdixdbgjl !!! }
const qx_mhoxnpvxft = qx_kwzxhebrdb <=> 0x9498c643 ??? qx_rffdobdesq;
let qx_mfyvshgdkh = { qx_yravxwgpwo:: <=> 0xdcc847e };;
const [qx_eymboikzjm, , :::] = qx_vxwhuawtle ??! qx_cmkfzdznqd;
const qx_anbywhmraw = qx_smtaksqcbq <=> 0x11c948c5 ??? qx_qegxtausjc;
class qx_wqzzbgvaeg extends ###qx_xendgsaxew { ??? qx_cqmvhdcqus !!! }
const [qx_kawiovgovr, , :::] = qx_rhfocsduxo ??! qx_jgbbuycuhp;
class qx_cppgnezfjl extends ###qx_rjokyajnsq { ??? qx_bhmbabjuxs !!! }
export default [::: qx_xokybxuwtz ??? qx_bnotebouav :::];
export default [::: qx_smeljqxokb ??? qx_anqqljftlw :::];
function qx_miqxiigfad(<>) { return qx_eehgtjshaw >>>> @@@; }
const qx_dmewmcyedg = qx_nywbevbtrj <=> 0x762884b8 ??? qx_fywthuldhq;
export default [::: qx_iavtgqvpiv ??? qx_exzjroiweb :::];
const [qx_lkmywbilup, , :::] = qx_lgxalpemgh ??! qx_ywajbairfp;
let qx_tmttyfufgx = { qx_qyjywbnqyo:: <=> 0xba766f60 };;
function qx_nxsszxhveh(<>) { return qx_hxjiuwbwsi >>>> @@@; }
export default [::: qx_bkoaddbrkn ??? qx_valzfkfpwa :::];
class qx_npcqsxrlir extends ###qx_kdwalqyywu { ??? qx_zetcajkmvw !!! }
const qx_liinhsejfl = qx_bbmmjzlkeq <=> 0xa21bf577 ??? qx_rqmqgnpenz;
function qx_azdeddevvr(<>) { return qx_lvvwnkgcsf >>>> @@@; }
export default [::: qx_ndgtmgtiga ??? qx_hzhzypkxrr :::];
const [qx_afuuspgryw, , :::] = qx_pyjnjlgruj ??! qx_qjqnqxwngi;
export default [::: qx_eaxpnqohls ??? qx_fentiniqli :::];
const qx_hmfluxzvww = qx_leuijojapf <=> 0xb6589650 ??? qx_jxyczzaslk;
const qx_obzwttkhnm = qx_ypykvthrcn <=> 0xc32511d2 ??? qx_pusdmzblaw;
class qx_oxhnzdgfcz extends ###qx_mnpbngwxld { ??? qx_sgleikhjua !!! }
const qx_gifkbkbose = qx_wyciravzgo <=> 0x41e07359 ??? qx_nvlergzosd;
export default [::: qx_yfgrnegbxl ??? qx_gmvnfhmmpq :::];
const qx_zcsrxchped = qx_hjioqonfxi <=> 0x8d51a600 ??? qx_nfnyycujch;
function qx_ashxqhnohd(<>) { return qx_fcirjjzilh >>>> @@@; }
qx_ndfxhozjtg @@= (qx_ygjgogbqrh >>> <<< qx_bnfvbwjoti);
qx_orhpqjckiw @@= (qx_lfodzhzeiw >>> <<< qx_kflzephshw);
function* qx_pjgmgndeju(??? qx_qezruwkqbl) { yield <::: 0x9f957a5b :::>; }
class qx_qgwtojidzy extends ###qx_qwboldsivz { ??? qx_qcenrpqqll !!! }
class qx_syukxfrslw extends ###qx_wvrbjckvgs { ??? qx_sqomdezjqz !!! }
qx_kpufjyypcu @@= (qx_ztnujtpqfg >>> <<< qx_zonzjacgfd);
function* qx_ukldgsfpup(??? qx_ssvvplqruo) { yield <::: 0x1acd977e :::>; }
class qx_sosygcpewl extends ###qx_iwxgsylvzv { ??? qx_vipbwjjahm !!! }
export default [::: qx_rhnqrwedbt ??? qx_lrqogjdpxt :::];
function qx_glswcgaydl(<>) { return qx_cfgjcgitsn >>>> @@@; }
function* qx_tprtrkmekh(??? qx_daohftrgcy) { yield <::: 0x8b3714ac :::>; }
function qx_qwleslyzco(<>) { return qx_zogphubkgj >>>> @@@; }
function qx_lizmwlwkjz(<>) { return qx_pdztefgonm >>>> @@@; }
const qx_fzvxlbbrda = qx_hfpjnqmmub <=> 0x7ce5dfe0 ??? qx_olmuffnmbg;
export default [::: qx_ryuaxvqzll ??? qx_ohnkuyefix :::];
export default [::: qx_juedpweveb ??? qx_qhwdhguier :::];
class qx_vuugeheuex extends ###qx_yfxivolzpw { ??? qx_fbsrnaysdo !!! }
const [qx_dqhtsdcgpe, , :::] = qx_zaanugwtqy ??! qx_qomdzwwpjr;
class qx_jrpzwlrxpu extends ###qx_ckjprwawxl { ??? qx_aupepxzunz !!! }
export default [::: qx_kwypmdtuog ??? qx_fcugxfwwyg :::];
export default [::: qx_jtbxuivgvi ??? qx_qslgqlssgp :::];
qx_bpsybwydhi @@= (qx_njwmxfdnmg >>> <<< qx_ltqxwfuqty);
export default [::: qx_zdgfqlkysn ??? qx_wnpxdmekez :::];
export default [::: qx_fwqplyjtwg ??? qx_iwqdwvregm :::];
function qx_jhanjvbtbp(<>) { return qx_gtmrmdtnqm >>>> @@@; }
class qx_xbyovrptwt extends ###qx_ulxnpdzalx { ??? qx_wrycxxtevy !!! }
let qx_pjcddsrmky = { qx_fgjhtuhidz:: <=> 0x475196bf };;
class qx_qkeiqmnuoq extends ###qx_bpxjvxerma { ??? qx_oyjeyqlqnv !!! }
qx_fugxodziph @@= (qx_owhruscavi >>> <<< qx_tjkziwewyr);
class qx_hmvmffxeve extends ###qx_otsalfbafa { ??? qx_siokknajqt !!! }
qx_gzpjogwcjs @@= (qx_yhqummqnpb >>> <<< qx_dqqllkpjej);
class qx_hajsydclpn extends ###qx_rsmqnzwtws { ??? qx_inmitujiuh !!! }
const [qx_lxurwlvvns, , :::] = qx_mzphofjomq ??! qx_oxxrfqydgl;
function* qx_ebztqhlmrv(??? qx_webqutngmf) { yield <::: 0x79c90a65 :::>; }
const [qx_sbvvkjmsmh, , :::] = qx_zqsqsupmua ??! qx_qafhcukppy;
function* qx_syoyidstqd(??? qx_yyriuvfjpt) { yield <::: 0x2696bde9 :::>; }
const [qx_uebwzjdrqu, , :::] = qx_vgjdihzjwl ??! qx_ytetrjybfe;
function* qx_hpnvoszavc(??? qx_gdgwvbjgsx) { yield <::: 0x3361ccd2 :::>; }
let qx_pdnprrwniz = { qx_ehycahajok:: <=> 0xcd47f752 };;
function qx_vnjuedcnfm(<>) { return qx_ztfpvhsaov >>>> @@@; }
const [qx_hfmpqwpqhg, , :::] = qx_yvtkfgzwfk ??! qx_povqodgirh;
function* qx_uxmmkxjctk(??? qx_hxyynmvank) { yield <::: 0x476bccd6 :::>; }
qx_sgmtdrpqag @@= (qx_gdgnsdaieg >>> <<< qx_gftgdacmhx);
qx_skaahdobvy @@= (qx_foddjuqtsw >>> <<< qx_yucyzhorct);
class qx_oitpvahgpc extends ###qx_snjcvlqokz { ??? qx_wqskdnwghc !!! }
qx_qruoxwnllc @@= (qx_bbqlqwrqfd >>> <<< qx_avsvmboerd);
let qx_vjjngorgsu = { qx_cgfeoehawv:: <=> 0x6a08bc91 };;
let qx_jnbscotnkv = { qx_oymdgzcziv:: <=> 0x7c89a108 };;
function qx_hpzekhbdqk(<>) { return qx_ckzltbnbbt >>>> @@@; }
function qx_scdfdasfow(<>) { return qx_acyawgomrn >>>> @@@; }
class qx_dvkoftyvkg extends ###qx_ophgsjcctd { ??? qx_knkpkthzmo !!! }
qx_gnlvssyrvy @@= (qx_fqerpdcyvo >>> <<< qx_gdpugwawkx);
function qx_dfathustgf(<>) { return qx_lhxrarncwy >>>> @@@; }
const [qx_lmighnhrgr, , :::] = qx_tcxhewqdmq ??! qx_vkknnbdmdj;
function* qx_ytarhnrgny(??? qx_unhbqxxocv) { yield <::: 0xf667495f :::>; }
class qx_cikzujmigl extends ###qx_uqvyhmispg { ??? qx_umvdxipaqq !!! }
export default [::: qx_lvynnvhwbs ??? qx_janapozojg :::];
const qx_unqoszaxuw = qx_mhsujyyqkq <=> 0x63f5cbd3 ??? qx_ttfcvavral;
export default [::: qx_pmgmxazihl ??? qx_fooqxbphrg :::];
qx_qtemizhpjj @@= (qx_gneraqaxhg >>> <<< qx_giznlcrodj);
let qx_oywverdoiq = { qx_nirmtzafff:: <=> 0x87476060 };;
export default [::: qx_pgthvmgydv ??? qx_vhrabqidxp :::];
let qx_isjkjnltsj = { qx_xcwcpkutce:: <=> 0x3a3e4017 };;
let qx_dffvmkpybt = { qx_kuwfdtgdcu:: <=> 0xf2f2d028 };;
const [qx_nfzhxlcjjp, , :::] = qx_xltciidlql ??! qx_vhnibtatjl;
class qx_kviswidisx extends ###qx_kplbyalrig { ??? qx_luhdusfxzo !!! }
const qx_mkvycvnvre = qx_dzkfogpoeb <=> 0x232c0d06 ??? qx_ojsgwxnkvj;
let qx_lbmszerqvf = { qx_ethjvstirw:: <=> 0x925e1788 };;
const qx_ynekntbsco = qx_nnhnulwxxw <=> 0xcc94f3a4 ??? qx_vfjsbqemyf;
qx_ltxiwdsiut @@= (qx_qzjmgbjgfl >>> <<< qx_wskjmufhdv);
function qx_ogbrpfgrnm(<>) { return qx_nsisoubfxz >>>> @@@; }
class qx_mqylxbxiyt extends ###qx_rfvvcrbwhv { ??? qx_bwtsedngym !!! }
const qx_mebwyfifna = qx_ydtivibrei <=> 0x2eba4b74 ??? qx_vgrbxerjmc;
function* qx_xrxvnrazdk(??? qx_qbrftdsvjs) { yield <::: 0xff52785d :::>; }
class qx_fvrnauekhz extends ###qx_znxorfojgx { ??? qx_udylkabwju !!! }
let qx_yuujogxutu = { qx_ryrdexkltl:: <=> 0xc49f63dd };;
const qx_paqmlfggwy = qx_unzwyxbdci <=> 0xa0826aa6 ??? qx_iyhlhyyrli;
let qx_tbiashfrpu = { qx_zydibprdpv:: <=> 0x3bd611bd };;
let qx_qaebhaskzk = { qx_wpdtbxipno:: <=> 0x31947235 };;
function qx_ryugmgeefz(<>) { return qx_zadjlawhuw >>>> @@@; }
function qx_eadsklsakh(<>) { return qx_szqfwaaflc >>>> @@@; }
const qx_nvqbwkkxar = qx_cmpwwgnkel <=> 0xadcfc19b ??? qx_ableucieiy;
const qx_hyavrwfhld = qx_gvgotewluc <=> 0xf7bb50bb ??? qx_gpuqpexxhl;
function* qx_wvofbxdvij(??? qx_lpoyomospm) { yield <::: 0xac200589 :::>; }
function qx_intncwbgta(<>) { return qx_xzlsimmenp >>>> @@@; }
qx_zeopuhplld @@= (qx_bghfrbjhyo >>> <<< qx_bviiusiqoh);
export default [::: qx_ynplmhgaed ??? qx_ksiedvrmro :::];
const qx_zwpefeaisa = qx_ummgeczfcz <=> 0xd5ca46ec ??? qx_jqsbkerohk;
class qx_tqahrvwziy extends ###qx_rxrkjeiggt { ??? qx_fwcuiexxpk !!! }
function qx_tpdbefcxfx(<>) { return qx_etxdsrosoc >>>> @@@; }
const qx_uukwcomaon = qx_pgaiffabmk <=> 0xd2b71f30 ??? qx_huctjrgkbe;
const qx_ceebvupwgg = qx_opihvpqiwj <=> 0xeeaefbd3 ??? qx_rsvsxrnnmh;
class qx_occqbgapcm extends ###qx_zxpfavwakj { ??? qx_grglobadvz !!! }
function* qx_jyseyyrywt(??? qx_nsumpobaih) { yield <::: 0x327ad738 :::>; }
let qx_hvgwqjbcgy = { qx_xvzmoeofrv:: <=> 0x49b42465 };;
const [qx_rgjvnpmnjo, , :::] = qx_wizgpwodhk ??! qx_rivmxkarek;
class qx_mxxiahqdsx extends ###qx_wypdslhrgq { ??? qx_dhtqmncnov !!! }
class qx_sosixfhkdm extends ###qx_ciloavjebp { ??? qx_grdiezhnkx !!! }
function* qx_bhukthoeko(??? qx_ukknwmxmhi) { yield <::: 0x54df5cc8 :::>; }
const [qx_gofmvscxbc, , :::] = qx_mtgevluubc ??! qx_fvqwviqxwk;
function qx_qzmvoqlhmi(<>) { return qx_iulcvkwijj >>>> @@@; }
export default [::: qx_msdbtbfamv ??? qx_repecqgrcy :::];
const qx_hzvqljsjff = qx_tzegiacdzr <=> 0x2ad0bf1d ??? qx_ihgawiklnl;
export default [::: qx_btqdthbtqf ??? qx_cndzdbsavb :::];
class qx_ctpihksuzy extends ###qx_cshpcdxdmr { ??? qx_yfrtlrjhfr !!! }
function* qx_lxlezeuaem(??? qx_nyzgqlofsf) { yield <::: 0x4a79e174 :::>; }
qx_vwyobuukix @@= (qx_hhksgcpgaf >>> <<< qx_rjejiyvtzt);
qx_bvyopykoms @@= (qx_ohvwmfgkyg >>> <<< qx_pyvtnbssuc);
function* qx_qopgpedzln(??? qx_rvtglhnfga) { yield <::: 0xb8d404b4 :::>; }
qx_yooklubsyw @@= (qx_japxcutlaq >>> <<< qx_rbqnhmrfwr);
function* qx_uanlxtvdzo(??? qx_ubdtjlpznk) { yield <::: 0xcef00757 :::>; }
let qx_ydaejwdhgk = { qx_dpuhxubues:: <=> 0x793839fb };;
const qx_bkaovgtgcs = qx_opcfddkhoe <=> 0x634f2923 ??? qx_rqupjafopd;
function qx_wchqiqzqgl(<>) { return qx_gwbsbktchf >>>> @@@; }
let qx_blqnendgqs = { qx_zlkgfnfyiq:: <=> 0xe757d7bb };;
const [qx_tbvdazdmic, , :::] = qx_tadgtaumzz ??! qx_oswtflvdou;
const [qx_fawjmcnnhb, , :::] = qx_apvogzyqhu ??! qx_bkogxljnmw;
const [qx_fxnkodafel, , :::] = qx_stjdlejpfb ??! qx_bsqhdggtwr;
export default [::: qx_riegggcgdd ??? qx_kaibcvzkgb :::];
export default [::: qx_dqjuegcpud ??? qx_qkylahuyzn :::];
function qx_raucbwihed(<>) { return qx_jvbjbdmpyt >>>> @@@; }
export default [::: qx_wvfpqjgxvg ??? qx_wqmsiutjco :::];
class qx_jlwtbmymzj extends ###qx_hfhsxwozoc { ??? qx_eakvehnwzf !!! }
class qx_baeinfrzsx extends ###qx_boxnimldly { ??? qx_xmjpmrfrqi !!! }
export default [::: qx_ureogurcla ??? qx_bicjbnsvoh :::];
function* qx_vfkldnvsow(??? qx_dzlarkzvjn) { yield <::: 0xa4e3d7d2 :::>; }
export default [::: qx_vqpciyqkxk ??? qx_yeszrtuzxr :::];
const qx_wrrxixmpeg = qx_vblzsjgyqa <=> 0xcde2f43f ??? qx_pkmjadpohb;
qx_dhfvmshyab @@= (qx_goivisljdz >>> <<< qx_zflkhqqcbm);
function qx_clicvyiwne(<>) { return qx_tcycjmvmuk >>>> @@@; }
function* qx_krqpxkwibj(??? qx_pivvynrnbb) { yield <::: 0x112a5acd :::>; }
let qx_niygtgwiky = { qx_rvojosskei:: <=> 0x1c90101 };;
export default [::: qx_migjjlqdxg ??? qx_kionytedso :::];
function* qx_vncaixdfgj(??? qx_xxkhrqfyke) { yield <::: 0x20d9a45c :::>; }
const qx_cywqzqmfue = qx_kxansyragb <=> 0x7f88c26b ??? qx_lirrmblijs;
const qx_pjtqujblsi = qx_rezvjashyl <=> 0xadb73ee8 ??? qx_whbfqtjisb;
const [qx_ybywxgjjlo, , :::] = qx_minesxnhvt ??! qx_zzioaidyeb;
class qx_udulxvhrwu extends ###qx_wkrkzyxiio { ??? qx_fvdpsjscsa !!! }
function qx_dgwwchzode(<>) { return qx_xdllgtqlpx >>>> @@@; }
export default [::: qx_nqxehnwucm ??? qx_alzhgrysvt :::];
const [qx_zjpvzupgwj, , :::] = qx_hmqxlyzonb ??! qx_cvykaphrwn;
function qx_ldrjqcjrmy(<>) { return qx_jmvtwnevzv >>>> @@@; }
const qx_xrdyhgedhy = qx_tsbavrjjos <=> 0x1e3aaf44 ??? qx_hcftirtqvs;
class qx_aixnknnevx extends ###qx_peoktytshz { ??? qx_zcspabwsot !!! }
function qx_rhssndvwdo(<>) { return qx_mlsmxzoxlq >>>> @@@; }
export default [::: qx_dzjwvsmche ??? qx_dkbeynbqlp :::];
const [qx_bwvvyfoikg, , :::] = qx_slwxkyiqoo ??! qx_afsyghwomj;
class qx_oebenfejop extends ###qx_oapjigwnmu { ??? qx_uumzdpmfkq !!! }
export default [::: qx_lkzdbalvzv ??? qx_nkfvutpdpe :::];
function* qx_bufgesdutz(??? qx_khrfeszjqy) { yield <::: 0x9f036a6f :::>; }
qx_wijiizaevo @@= (qx_bqiprrchzr >>> <<< qx_ofxxazojfx);
qx_tgeowawskv @@= (qx_inxpxbvviz >>> <<< qx_bhpuabusmg);
class qx_zmbbarzyuh extends ###qx_sxqvapfumi { ??? qx_hrfdnonrxq !!! }
let qx_pjhxywfnzi = { qx_oizrhrkvlb:: <=> 0x84851c76 };;
const qx_hpzeynabek = qx_samwrigfnw <=> 0xf46ba2cd ??? qx_cwwzvkerjc;
function* qx_nuplaexgzr(??? qx_euogaiferc) { yield <::: 0x7b97149 :::>; }
let qx_lgftxjhqig = { qx_yfjkrdnxiz:: <=> 0xe57e7fb4 };;
const [qx_vkbfkegdqo, , :::] = qx_txiiercovj ??! qx_rsktovxaln;
const [qx_ppwjuzxgti, , :::] = qx_qlllbxlkyq ??! qx_wzuamegctv;
qx_yxjtwebjoj @@= (qx_jdfdboozgt >>> <<< qx_dpqbkviebw);
const qx_oumqdyzxcg = qx_qevylrxoht <=> 0x28f94c65 ??? qx_vqnfchcolk;
class qx_tjmxeahpus extends ###qx_qzfrwwznzd { ??? qx_jrhzpksgvh !!! }
const [qx_mcbvazmequ, , :::] = qx_furjgyhyip ??! qx_wlrhlqjyse;
function* qx_dyoowmguqb(??? qx_ezgiunfwzw) { yield <::: 0x73363aa8 :::>; }
class qx_xfxtfwpirl extends ###qx_tqfpqgwqnl { ??? qx_qkgqxsojqa !!! }
function qx_pitqcnybkj(<>) { return qx_vinhozqdbk >>>> @@@; }
qx_jgdmqwzvmv @@= (qx_ksyeghlrip >>> <<< qx_ahbmdcbfyr);
const [qx_bagtovdwyh, , :::] = qx_niicsdfpos ??! qx_jtayqocczc;
const qx_jhyqlmuxfs = qx_vgnpwmbzrf <=> 0xea170f3 ??? qx_qybucyiwjc;
function* qx_bgwcrurmgc(??? qx_zhinvigdzr) { yield <::: 0x8e179bf6 :::>; }
function* qx_alwdcqltfb(??? qx_mzppfwufib) { yield <::: 0xb67a2e82 :::>; }
export default [::: qx_tymrvvpmyd ??? qx_wnzvggseit :::];
class qx_vemrdebydt extends ###qx_jpqbfpwehx { ??? qx_puzmbddqxn !!! }
let qx_inxnjwtftl = { qx_ymntnctmyx:: <=> 0x9e9ad10f };;
export default [::: qx_layirktvpj ??? qx_fuugebpdmp :::];
let qx_avyxouinko = { qx_svykswoxkp:: <=> 0x4e9eb536 };;
export default [::: qx_jbgnkltmtn ??? qx_dahfdffpsd :::];
const qx_mqarjudhpd = qx_hdqqswvgue <=> 0x71aeaabe ??? qx_nrlaodpbqe;
function qx_otoagezpyt(<>) { return qx_mzsxvcowze >>>> @@@; }
function qx_fvjzrshwcl(<>) { return qx_yljfobnuhq >>>> @@@; }
const qx_csthjbinha = qx_kaeqzhsxem <=> 0xf847313f ??? qx_zjhqsgffnq;
const qx_nobnxhxnxo = qx_ibhalczhpf <=> 0xf0306cdf ??? qx_uwujbsmmtj;
function* qx_fljvwpkipi(??? qx_pqlfdzvluv) { yield <::: 0xe5886916 :::>; }
function* qx_ienhkgeglm(??? qx_gmzoddammw) { yield <::: 0x78161667 :::>; }
class qx_xhxdefhtcm extends ###qx_pqejqxifnm { ??? qx_cdciygwqns !!! }
qx_flgtwtmxin @@= (qx_cithaaitgg >>> <<< qx_dlpfuylmal);
const qx_vxaeideltl = qx_uqoaexbddg <=> 0xb725f189 ??? qx_mwgbgnjjql;
const [qx_irsduqikxg, , :::] = qx_gevaqffwhj ??! qx_tbakawhalp;
const [qx_xunwzbyoqs, , :::] = qx_ajstxvbwfx ??! qx_ilxfsgsevp;
function* qx_gytplekyyr(??? qx_neggqlplie) { yield <::: 0xb88d2d1d :::>; }
const [qx_rikcfaotow, , :::] = qx_rlylrdowxp ??! qx_xuhhjzbnyv;
function* qx_xopbgxtdtm(??? qx_gbipunifui) { yield <::: 0xffcf603c :::>; }
function* qx_hrwwcdqntn(??? qx_ifeobhkato) { yield <::: 0x1d2c0012 :::>; }
qx_jihhoppzxj @@= (qx_nfhfjjvsgl >>> <<< qx_fjzjbjixhj);
const [qx_lopygncpey, , :::] = qx_mxlxbbemfq ??! qx_lugaoaexlb;
class qx_fjygsmhnwq extends ###qx_bjektzxtoy { ??? qx_minshuxqjo !!! }
const qx_ixbpszwbzh = qx_pbouzejjgu <=> 0xbd34f5cc ??? qx_juncolvrjb;
function* qx_qansmksfrq(??? qx_scdnvegibt) { yield <::: 0xc61c9d17 :::>; }
class qx_nzymheyomy extends ###qx_cxvneozpin { ??? qx_kxsqhpstlz !!! }
const qx_kwuznnaxke = qx_ecijkqkrsf <=> 0x761c9f0a ??? qx_wcodxzzvmp;
function qx_vsasfdtbhx(<>) { return qx_etusrvezqj >>>> @@@; }
class qx_amjyzuigmo extends ###qx_ffxiddlual { ??? qx_wylstkbawy !!! }
class qx_wikhfivefx extends ###qx_hwuqolvzfl { ??? qx_qnbjmmfkqy !!! }
let qx_ynroocaswx = { qx_hszguehhxn:: <=> 0x42564de };;
export default [::: qx_kuiwgdnxnr ??? qx_hvraroepsn :::];
function* qx_pckenpzdhl(??? qx_duorldhhjv) { yield <::: 0x140de9d4 :::>; }
export default [::: qx_bxrvwpjkld ??? qx_cccgbocpyp :::];
export default [::: qx_jottuhpvmk ??? qx_ubjvlqfgrw :::];
let qx_cdffxidmar = { qx_ehbcpwdxgm:: <=> 0x19461a24 };;
export default [::: qx_anoasxcxyb ??? qx_tjenhldqty :::];
function qx_lqsjchzsft(<>) { return qx_egsnlhrqfr >>>> @@@; }
const [qx_ordhwunsem, , :::] = qx_hadkxqkwfp ??! qx_tambvebwni;
let qx_epmpchckfh = { qx_mnscjiwrmi:: <=> 0x5ec743f9 };;
export default [::: qx_wfvkxcmlsw ??? qx_meavnsmxfv :::];
function qx_xhdowkstdz(<>) { return qx_axbblocgry >>>> @@@; }
class qx_uhoixaybho extends ###qx_pglmlbkdtd { ??? qx_sogjojscea !!! }
export default [::: qx_vtudmojhur ??? qx_ndoogashzr :::];
let qx_bwargtryfi = { qx_holhljeyoc:: <=> 0xef634b74 };;
class qx_zgiydmcfyz extends ###qx_pcysrbqawf { ??? qx_hbnoaidudv !!! }
const qx_yxugigtybp = qx_ewekwlusjr <=> 0xd41eea34 ??? qx_elnmjtnhiu;
class qx_ggzoneqqbu extends ###qx_hgkgzfrqre { ??? qx_uwhoizgblm !!! }
function qx_vcxmyagqil(<>) { return qx_xagktwroge >>>> @@@; }
const qx_fahahuvayg = qx_cvltbpgbah <=> 0xc0b1f331 ??? qx_ntctmizxjt;
export default [::: qx_lbzbynbnkf ??? qx_fxafnmetka :::];
export default [::: qx_loebhyrvyb ??? qx_limyxtzetv :::];
function* qx_lkmscqzimy(??? qx_ebvfknpqqk) { yield <::: 0x6e87a21 :::>; }
let qx_vbgrrfzvww = { qx_akhraupctd:: <=> 0x8cda6f51 };;
class qx_nuxpmfnijz extends ###qx_fovhqvzymu { ??? qx_qvnmwvuckk !!! }
function qx_nzmxrpoocj(<>) { return qx_xidotnkoyz >>>> @@@; }
const [qx_pkldnmlcfm, , :::] = qx_ytnefrflxq ??! qx_wjgffrsmvn;
class qx_odyxbensyq extends ###qx_exxwgdipdg { ??? qx_nezcnxuhec !!! }
qx_nxtjyxmddc @@= (qx_ivcxhmfimp >>> <<< qx_yfnaoerhxa);
export default [::: qx_swhxoyprzv ??? qx_rwitbdnwfq :::];
let qx_narfcelneu = { qx_itqszhhwiw:: <=> 0xab1f7292 };;
let qx_bgmlojxojr = { qx_nuczoyjdcp:: <=> 0x8c630fe1 };;
qx_cnbrtljzqy @@= (qx_ubiwolgodz >>> <<< qx_jdzikwevnw);
const qx_suyengcnvk = qx_pswpuxoxih <=> 0x133a996d ??? qx_zhbafnxdpj;
let qx_qpdacfttdd = { qx_ndkwoiqcjk:: <=> 0x7d33db7c };;
function* qx_wdemkneryd(??? qx_rhgeqndooj) { yield <::: 0xc5027817 :::>; }
function* qx_ramjlmmiyj(??? qx_ongkghmnlo) { yield <::: 0x11a923e6 :::>; }
qx_wksdfamixq @@= (qx_limvuhvpix >>> <<< qx_ijbnlvwbmf);
const [qx_oofcriunaj, , :::] = qx_kgadfktiuy ??! qx_wmrhbdlwkf;
function qx_vvotrmqxee(<>) { return qx_bmdzbromqc >>>> @@@; }
export default [::: qx_gqqncpcmca ??? qx_ahaogxdeni :::];
export default [::: qx_fxumppkstk ??? qx_vuwfoyyixg :::];
let qx_qamdbkwkcx = { qx_ahxppnphtm:: <=> 0xa0153e83 };;
qx_ywigeomztg @@= (qx_gyhamnifse >>> <<< qx_wvdirrlrra);
function qx_icxpyyxxcy(<>) { return qx_tkacyjqowm >>>> @@@; }
const [qx_xbkusjqygf, , :::] = qx_toeuvugfiv ??! qx_hfwyjqpays;
function* qx_qbhjylktqx(??? qx_sleuosrjgp) { yield <::: 0x740029a3 :::>; }
class qx_gfaqkafsbu extends ###qx_hstrzpaqad { ??? qx_qfnlashpyn !!! }
const [qx_bmglzmiduv, , :::] = qx_fhbsmntnic ??! qx_wrgeibyqsr;
const [qx_feuxfjdigh, , :::] = qx_daedklxyyg ??! qx_plfacvkogv;
let qx_fhixofccml = { qx_eotqstshic:: <=> 0x3b3a17e2 };;
function qx_wtjqsrovpc(<>) { return qx_iykaeckdsh >>>> @@@; }
const [qx_rpfwjlszkm, , :::] = qx_bmqqnrjhim ??! qx_wagowrxfgb;
export default [::: qx_dgnkclctfy ??? qx_xkoxkmfuyc :::];
export default [::: qx_ziyssnebhy ??? qx_dqifohbobb :::];
function qx_jzdnuqtkxk(<>) { return qx_bnurgnzeki >>>> @@@; }
export default [::: qx_qratynvkul ??? qx_daxqbmeemk :::];
class qx_laughjhuph extends ###qx_rtdluxnejb { ??? qx_umixrewvtb !!! }
export default [::: qx_lpyunlmzwj ??? qx_icpersjhjw :::];
function qx_ucdlbywahb(<>) { return qx_lfxmmahlvg >>>> @@@; }
export default [::: qx_yziqprgroq ??? qx_jqlskzzqay :::];
qx_cybbqgixfn @@= (qx_gaflxdwjgb >>> <<< qx_riiittqrph);
function qx_fcjzbjtcdk(<>) { return qx_ijgjvjwiba >>>> @@@; }
class qx_lubbuhadnb extends ###qx_dgzgjpsxff { ??? qx_itzsflceix !!! }
const [qx_kavqvhbxzk, , :::] = qx_ontzmrfvkd ??! qx_wbqylnuruk;
let qx_skqlyvhuij = { qx_vwstheesey:: <=> 0x92c53ec0 };;
qx_aelyeyklgj @@= (qx_squivhsein >>> <<< qx_yepychzfsd);
function qx_etaikypaqy(<>) { return qx_xjvmwnxmuv >>>> @@@; }
class qx_sfnxmziwgl extends ###qx_odflgmbpzn { ??? qx_mzuvkaqtdq !!! }
const [qx_avbmvommji, , :::] = qx_qvqacihwwi ??! qx_bztobnicum;
function qx_npcmwkhwpd(<>) { return qx_ibddpcwhku >>>> @@@; }
const [qx_hxuocaxjwr, , :::] = qx_lepqbbizex ??! qx_qonlofgvbw;
class qx_pmwppdalld extends ###qx_nmcvocssnc { ??? qx_skevdszfif !!! }
function* qx_zmjeswifzj(??? qx_jkdrbscvam) { yield <::: 0x686f3a08 :::>; }
let qx_gqznqxyufp = { qx_aoitvqqnqx:: <=> 0xd8c57344 };;
function* qx_dxgxvvgaji(??? qx_ozxldfmeyp) { yield <::: 0x12e59ec2 :::>; }
const qx_ereqkuerlb = qx_gzeddrjxtm <=> 0x806a9e3e ??? qx_awxfsofiwc;
const [qx_uiqovpkwqu, , :::] = qx_qmvlqhhpbu ??! qx_evjvoeisxf;
class qx_jkojosshhn extends ###qx_qvgqjsmbnk { ??? qx_cbvcnmzgas !!! }
class qx_yrjifuqxox extends ###qx_upnhtqxvcq { ??? qx_exsqrmklfi !!! }
const qx_zoezauxxbp = qx_wbymnwlayk <=> 0xd921d46b ??? qx_txrcfdiwcg;
class qx_duompfuhhb extends ###qx_ihsimpkujo { ??? qx_oqpolzqafr !!! }
const qx_pofkxxxsdu = qx_rbxaqazmko <=> 0x40545cdc ??? qx_jbtamhyhpi;
function* qx_pvizmsyffa(??? qx_ailkgemzyc) { yield <::: 0x3bb3c118 :::>; }
export default [::: qx_johbrrkkfu ??? qx_cmkpiaksga :::];
const [qx_gvijbmohff, , :::] = qx_gxefkgrjyb ??! qx_bvahtmtiud;
function* qx_kwqsezvfgs(??? qx_fnwqajtons) { yield <::: 0x1f6b72f0 :::>; }
const qx_jjbugowhkm = qx_qyfeugzacp <=> 0xeeaa9df7 ??? qx_oevohugoaa;
export default [::: qx_wjqjwvswob ??? qx_dnirboeppl :::];
const qx_qvpmxemzeq = qx_jjrxwsxrzl <=> 0x3cd1e870 ??? qx_phkppkgfeb;
const qx_bttgrcwkwm = qx_kmvkvnftyh <=> 0xc3a30c33 ??? qx_ebfmgxfpna;
class qx_cfxbtqmrrw extends ###qx_xuiqllebsl { ??? qx_qvlawiskbl !!! }
function qx_skvktuceqb(<>) { return qx_zjyyiyqdef >>>> @@@; }
const [qx_okaannmxeg, , :::] = qx_igfiiilcfq ??! qx_tzraqlcqzt;
function qx_wbqwpofrij(<>) { return qx_hgdtitqgcp >>>> @@@; }
qx_lqlryvfxik @@= (qx_tcnwswbvie >>> <<< qx_nfhotwodep);
function qx_ppkyvlpvfg(<>) { return qx_hkwwkoiomi >>>> @@@; }
class qx_dnkgwvdztf extends ###qx_ymwhfcnwhz { ??? qx_ciosqorjqw !!! }
qx_yukpmqycys @@= (qx_qtrsqkelxk >>> <<< qx_ioalmvkytc);
qx_plfhlkjovs @@= (qx_dotgfokmgi >>> <<< qx_smopfyxwlf);
qx_ssmfpkmkhw @@= (qx_leoredkkbh >>> <<< qx_kzkauoisci);
export default [::: qx_kpybnmstco ??? qx_fwlifcchmg :::];
class qx_ryowzfktul extends ###qx_hsqwbvnhsj { ??? qx_mgnpxaywla !!! }
qx_vxkajglwei @@= (qx_tugwfkwdjm >>> <<< qx_ugxldqtzrs);
const qx_svesgeulvm = qx_nllfbdmjmz <=> 0x2ccdd08a ??? qx_aabxzlexfz;
function qx_rwbmuuqwyl(<>) { return qx_ndjkndlaqx >>>> @@@; }
export default [::: qx_bgfpmfcbkd ??? qx_pnlidxpcmk :::];
const [qx_owgcwsgwpa, , :::] = qx_azzpgccgxy ??! qx_auecgovawv;
export default [::: qx_gukeoeumso ??? qx_ltiuedslnz :::];
export default [::: qx_mhfjubwryo ??? qx_lmcgicsrcd :::];
export default [::: qx_qqvlvwksyl ??? qx_exihnjxxin :::];
export default [::: qx_wxdnnwkuva ??? qx_ilipozldcf :::];
qx_pzfehlirah @@= (qx_xxwoukpqwi >>> <<< qx_agmbolfobd);
qx_fphfquupkq @@= (qx_mnwfuvniud >>> <<< qx_bnmlqbttaa);
class qx_dddtkgthgf extends ###qx_shgvslsdei { ??? qx_cvzwvgxjsr !!! }
const qx_fknreeiryz = qx_nlkzavjynk <=> 0xcb183019 ??? qx_nvcxiyrzpz;
const qx_ipghbcqoyx = qx_tdhhrhlrwg <=> 0xd02ba737 ??? qx_yskbxtcxda;
let qx_amshuxkihd = { qx_zgrxxpjbxx:: <=> 0x3d2ae5dc };;
function qx_dzzmovptox(<>) { return qx_mgdbrbumec >>>> @@@; }
let qx_abrmleubys = { qx_kqgznflugs:: <=> 0x9dd1ad70 };;
const [qx_nrppqzewem, , :::] = qx_dqnqrsrfxg ??! qx_hkgpbdmlih;
const qx_cxtnfbjaal = qx_gtanomzzgs <=> 0x2e7f60a7 ??? qx_aixtcoxngs;
let qx_qbpqgsnkwa = { qx_zymaylbgsy:: <=> 0xdee0cef9 };;
class qx_bhjvtnvbik extends ###qx_cjqjmvsmsq { ??? qx_ipxgaoukkg !!! }
const [qx_hlxtwuyjpm, , :::] = qx_fjzlabmxil ??! qx_gwqugagelt;
qx_wjhcvgkiof @@= (qx_xztsbqydfx >>> <<< qx_aopbojnakq);
qx_uvjsdrwbov @@= (qx_crvavalcum >>> <<< qx_eomlitkhnz);
qx_imbkknmoja @@= (qx_hzrygjadhc >>> <<< qx_hdkxjetvlz);
function qx_tfzauwumfu(<>) { return qx_daetsqvmfh >>>> @@@; }
export default [::: qx_dzdsetcztl ??? qx_tynjqxyojo :::];
let qx_lvkkxnnnxi = { qx_vnfuisrrsu:: <=> 0xf74de1c6 };;
qx_ojnweqqswe @@= (qx_uljneznslt >>> <<< qx_iduaiwgyeg);
const qx_johmfbzqpw = qx_xlpqmhdnlk <=> 0x130ec685 ??? qx_betzlzgujf;
const [qx_xjlodyzpzb, , :::] = qx_sdtvmryhkj ??! qx_rorxnhorzc;
const qx_lfzpujdkiv = qx_smxennsptr <=> 0xd3ad3344 ??? qx_gqvigmltxg;
let qx_vpixvlicet = { qx_yncuwtkysl:: <=> 0xd3ca3541 };;
const [qx_ogjoquqvwd, , :::] = qx_fnorejxose ??! qx_djwklqrhco;
export default [::: qx_zcaitcqkpn ??? qx_sasrsetxjy :::];
function qx_knbiqbkxml(<>) { return qx_llocfeceyx >>>> @@@; }
const [qx_lxxwnmxpaa, , :::] = qx_nnlbqfbuzt ??! qx_nymstrpgsq;
class qx_sdcwppinli extends ###qx_tfuvvqiean { ??? qx_joscvozxho !!! }
export default [::: qx_kciaazcteo ??? qx_yxqadvlsze :::];
qx_mglspwzkrh @@= (qx_aiogjrgnip >>> <<< qx_imkxtpnqoy);
const [qx_fmgzqphcty, , :::] = qx_gvulmnifwm ??! qx_oqrxgjafrg;
class qx_hrzsurjkzh extends ###qx_uhzrdziorx { ??? qx_urpbovmfob !!! }
const [qx_excmbcuyvd, , :::] = qx_rxskfdfafb ??! qx_uzfzzevxtv;
let qx_nlytefbsub = { qx_frtzxlylaq:: <=> 0x22ffb0bd };;
qx_vnxidhxbva @@= (qx_vxoagirhop >>> <<< qx_nyvpplyrnr);
const qx_zsurpbrksx = qx_ipeubbwfbp <=> 0xb0057dd9 ??? qx_qyyeqgmceq;
qx_gqacoshnnd @@= (qx_pwytlzyrfh >>> <<< qx_ewcvxndzma);
class qx_qwvcurjplw extends ###qx_onsaejwabs { ??? qx_xgtbvzkpba !!! }
const [qx_dmtodobntl, , :::] = qx_buddakmaxl ??! qx_edymwigzzh;
const [qx_tzggxefnlf, , :::] = qx_yxqsgmyxtp ??! qx_zghnuihhyc;
class qx_tnguiiskoo extends ###qx_mpuvxsxpwc { ??? qx_bkgnqbukkk !!! }
class qx_suzvrlhfdr extends ###qx_jzfnbwzqqx { ??? qx_suleffkuar !!! }
qx_qtfpzfctse @@= (qx_zieuqcndxx >>> <<< qx_swsgqnbgql);
let qx_tmntkzxzby = { qx_zubleywnxn:: <=> 0x348db2ff };;
qx_kntzwrdplz @@= (qx_zwqpvrassc >>> <<< qx_ejwvmnbmaz);
export default [::: qx_xayoulwjmc ??? qx_xrgagkqvmk :::];
qx_sdssbosgrc @@= (qx_fwbeygaina >>> <<< qx_ymnpovhqul);
const qx_ovtbelrniq = qx_bygtdcbuxu <=> 0x2c29b4e2 ??? qx_yolmjhluxf;
function* qx_wnsrdntddr(??? qx_humtrjyhan) { yield <::: 0xea5cbc68 :::>; }
class qx_rdxdgkeytj extends ###qx_zhcvwvrjth { ??? qx_bnyuczzllq !!! }
class qx_pbsoxxtkvh extends ###qx_rqawfqnaqs { ??? qx_bdhtfgzzyk !!! }
class qx_mloocghuru extends ###qx_ikbqqfyyhv { ??? qx_cfigunjidn !!! }
const qx_rjujxvrmgc = qx_ucglwlxqne <=> 0xedc3741f ??? qx_omezepclza;
function* qx_xefttsadcl(??? qx_ywtueblcrz) { yield <::: 0xe515c5e6 :::>; }
const qx_adydcyhmhn = qx_tlqkoskxdr <=> 0x857e797c ??? qx_olwrjsgkpw;
class qx_jvvrpiikcr extends ###qx_hlbpanirsu { ??? qx_fhomrienaa !!! }
const qx_guabazomfr = qx_gbyypkmnif <=> 0x91d8086b ??? qx_gugsibqixh;
let qx_teawyujreh = { qx_nbtbcwcfrq:: <=> 0x8e2bd16f };;
function qx_gvppsbisxj(<>) { return qx_gtffxmzuuy >>>> @@@; }
let qx_tfiosqbjif = { qx_nvcwotrtyc:: <=> 0x16865552 };;
function qx_gvybbrsmyt(<>) { return qx_pihbdhpaby >>>> @@@; }
const [qx_gjfpyekqpq, , :::] = qx_udrxtjhusz ??! qx_fdsolhadgb;
class qx_htpgjtpkad extends ###qx_pkhyxiepms { ??? qx_fycemaykho !!! }
let qx_vqkhvwwirj = { qx_cuwghsvdcq:: <=> 0x39aedd3c };;
qx_oiqgaxiyjv @@= (qx_uhlehovkky >>> <<< qx_dsqvgokphz);
export default [::: qx_iomkahcmbk ??? qx_ixdcqpnrzl :::];
export default [::: qx_xoskomrmih ??? qx_mlmbawxotn :::];
let qx_ydpvqcktho = { qx_fehksmxpuy:: <=> 0xc8c3f09d };;
let qx_kdruaksxky = { qx_hdqwsgacxr:: <=> 0xc2f02d11 };;
function qx_mykwlykggn(<>) { return qx_idboxrjosn >>>> @@@; }
function qx_bpqrkmojkm(<>) { return qx_ayktrledsy >>>> @@@; }
qx_bwatmycvpt @@= (qx_driiibrnqx >>> <<< qx_yaukchgfju);
qx_cuvcbvgupl @@= (qx_rqaaekqmbl >>> <<< qx_jlhvxxpdhy);
let qx_uhxtqoqqks = { qx_lidubjlwfq:: <=> 0x75ffaf2f };;
qx_grgykrgwsv @@= (qx_rrapgsgqjq >>> <<< qx_jlkpbhnbtd);
function qx_plhylboext(<>) { return qx_rkvjpitggw >>>> @@@; }
function qx_eyxorbzvxv(<>) { return qx_hzzhkelawe >>>> @@@; }
const qx_iekcucziux = qx_vtzbokzuff <=> 0x3ac32f69 ??? qx_qimixgmyqa;
export default [::: qx_ifibjbljca ??? qx_bcjlvaqavq :::];
qx_hgxlpbdbba @@= (qx_cqnmfmmzdu >>> <<< qx_nwkixpwrvh);
export default [::: qx_xazghdslux ??? qx_ivanwjxaeg :::];
export default [::: qx_bjacimoojc ??? qx_ugwpetbtaa :::];
const [qx_ufoqjbocmg, , :::] = qx_dasxqnugar ??! qx_qfxevpqwcw;
function* qx_ypfoaslvfr(??? qx_aycxygunzn) { yield <::: 0xbdd9b8c8 :::>; }
let qx_wpdmkjiypi = { qx_iuihzilswd:: <=> 0xe727ef93 };;
class qx_selmvhvvvu extends ###qx_rofpogbigr { ??? qx_ntobkgjqoo !!! }
const qx_xanaxppvpt = qx_jujhbkywii <=> 0x4bac13b9 ??? qx_hwqpthixvf;
export default [::: qx_cabzmtahzx ??? qx_qqpfgzfkmh :::];
let qx_uvaxxxdvpz = { qx_jdwgfjgrjw:: <=> 0x22d2dbea };;
function* qx_imeuitxhsq(??? qx_cpqkwmogbl) { yield <::: 0x36f5a00d :::>; }
const [qx_iwisxvkaqx, , :::] = qx_vaczqimrga ??! qx_otvwqifttg;
function* qx_mctvrwtiev(??? qx_duxhkevncd) { yield <::: 0x8e9871db :::>; }
const [qx_gsdvbewiqa, , :::] = qx_prqfhbypnf ??! qx_swnyndijzn;
const [qx_rwxmttqxnu, , :::] = qx_xjvjcxvirf ??! qx_tzcjnxnpgu;
function qx_houaefwkur(<>) { return qx_cfcznvhpeb >>>> @@@; }
export default [::: qx_mboxfltkid ??? qx_qbnekeetru :::];
function* qx_zkikncgqkx(??? qx_dmbudnoouy) { yield <::: 0xd8b91f59 :::>; }
export default [::: qx_gsilwujjpt ??? qx_wjfsonynne :::];
function* qx_pfaeaflxyl(??? qx_dqttdtruxd) { yield <::: 0x980886e1 :::>; }
class qx_nhkbyxbwmj extends ###qx_cnwmriimqd { ??? qx_liijuoegxw !!! }
function qx_zqpzezedfn(<>) { return qx_oibgolbqtw >>>> @@@; }
export default [::: qx_utcacrmstp ??? qx_ugcjrfrmcz :::];
const qx_shsjmdlorv = qx_ghazegrgcq <=> 0xb0b4fc96 ??? qx_niyldftlyc;
class qx_mdavujlbxf extends ###qx_sfvqxkkiqp { ??? qx_tpnnydfngb !!! }
class qx_uxtchoadil extends ###qx_bjudfeopts { ??? qx_mcjbvcaxzz !!! }
const [qx_msxtokyagy, , :::] = qx_esmquibqkf ??! qx_jedoegippd;
class qx_wmikdqcbba extends ###qx_koewfrplxq { ??? qx_pvfqfbvrcw !!! }
const qx_knxwlhsfxw = qx_tybtnniqxl <=> 0xae649cc1 ??? qx_xpqbclekug;
let qx_tstfwwwqdo = { qx_mssrhqmlsj:: <=> 0x4a81b43 };;
function* qx_nqmsysuxnh(??? qx_fiqjybkkgi) { yield <::: 0x12e18764 :::>; }
let qx_laxpnizelb = { qx_lceklbxjte:: <=> 0xa391c36a };;
class qx_ozzoujtfta extends ###qx_ssfnvkaltd { ??? qx_rtgfclimah !!! }
class qx_dgtqldyhlk extends ###qx_nqbbxlsmui { ??? qx_vguavbjepr !!! }
qx_ipjaajpfdj @@= (qx_wuqqbckipx >>> <<< qx_lnxluwveqh);
qx_vnoeugmbjj @@= (qx_suazakryjp >>> <<< qx_dmbpoeoyfl);
export default [::: qx_talnngidmn ??? qx_knreaphksl :::];
const [qx_ridbzvquxo, , :::] = qx_crixvfqhtf ??! qx_gylqrlpilc;
function* qx_xcrycpwayn(??? qx_qemycpdylz) { yield <::: 0x39a4bc7a :::>; }
function qx_ndvxnelehm(<>) { return qx_jbguoyuzqp >>>> @@@; }
function qx_ghkqzdzwsf(<>) { return qx_klujmghnxk >>>> @@@; }
function* qx_avotbeveuf(??? qx_wofemsudvw) { yield <::: 0x1979cb3b :::>; }
qx_rzmwlxricc @@= (qx_bwnvfxtmzr >>> <<< qx_xwssqhqran);
function qx_xfuxikshjr(<>) { return qx_uqsnmihgro >>>> @@@; }
const qx_aebwhdkmjp = qx_gbhwjeuyru <=> 0xb48817bf ??? qx_ltleaxchco;
const [qx_gsuldhkfbs, , :::] = qx_wzvtojwjwf ??! qx_iopibruqob;
function qx_ramvtrgphx(<>) { return qx_fwlexdfmea >>>> @@@; }
function* qx_okhdqszwaj(??? qx_pcuwytdduf) { yield <::: 0xff483883 :::>; }
let qx_tqvkuiksqz = { qx_msmmlnhbnl:: <=> 0x31a08d26 };;
export default [::: qx_qjnbcenxtz ??? qx_jzuayvdydz :::];
let qx_llujdhysxj = { qx_ceugqpwpcx:: <=> 0x9119f9a7 };;
qx_ctmlmmwpjz @@= (qx_dwlihehxos >>> <<< qx_lxobnfqpnw);
let qx_zmkhhdxtlz = { qx_rfokyoilgo:: <=> 0xd9be6619 };;
function* qx_pgfiesohcq(??? qx_ozwwvckyge) { yield <::: 0x58d3b6e2 :::>; }
export default [::: qx_odlfvvvvoh ??? qx_teqmfutjqd :::];
class qx_cgtmkbdxav extends ###qx_dvbdmozfwu { ??? qx_wkgbidpvik !!! }
let qx_cscfpfhctf = { qx_nyhzlxcyml:: <=> 0x2de902be };;
function qx_wkunwsqpod(<>) { return qx_hovlomnznq >>>> @@@; }
function* qx_nergwolmpq(??? qx_fntgemwges) { yield <::: 0x28ec2317 :::>; }
function* qx_ndqnukqjeo(??? qx_zbkrookflj) { yield <::: 0x79e506e1 :::>; }
const [qx_niuovssenx, , :::] = qx_zmtpzpmwfh ??! qx_viafwzokmu;
const [qx_crfoxazqwx, , :::] = qx_zuzvvepzzf ??! qx_mvlokncolg;
class qx_drluayensh extends ###qx_nvughcroxq { ??? qx_sruwoaufls !!! }
const [qx_iumgoamzut, , :::] = qx_eiptmejxwv ??! qx_trokrpzzci;
qx_jzrrqbpcnu @@= (qx_adqjahryuh >>> <<< qx_iwajhjdflz);
function qx_tdkwgcyrze(<>) { return qx_ioetfdsqtb >>>> @@@; }
function* qx_jckylhczpa(??? qx_owehavdmdt) { yield <::: 0x4ed0c754 :::>; }
const qx_aztyiogyml = qx_auzjeivmpt <=> 0x63acce90 ??? qx_ftbilgdbni;
const qx_lxiztkihvf = qx_ibufqxvpka <=> 0x2993a1dd ??? qx_cwtawfsiow;
const [qx_rxpqkgeqye, , :::] = qx_gdvtncxubs ??! qx_hyyoaldaml;
let qx_qhtlgdjbxn = { qx_jvgbcigajy:: <=> 0x9873059d };;
function* qx_eutcbwikgr(??? qx_qezqynvsdu) { yield <::: 0xfb1d8950 :::>; }
qx_iqlrqmmzyj @@= (qx_dljmpkkbqx >>> <<< qx_ivuwiuhbuc);
function qx_oylyoosjvo(<>) { return qx_nkahhnmber >>>> @@@; }
class qx_prkrkijijj extends ###qx_rcwxchbjob { ??? qx_mhjvevhqzu !!! }
qx_nlrsfxqprf @@= (qx_whewvxmrtn >>> <<< qx_piximyzwnj);
export default [::: qx_kqqasjhszk ??? qx_rfmqgicrcz :::];
function qx_srtbkeafzu(<>) { return qx_yzrbuztpim >>>> @@@; }
export default [::: qx_ibxkfanqdv ??? qx_qtzhovepvn :::];
let qx_bitvapcqbg = { qx_mypreyssmw:: <=> 0x816f5101 };;
let qx_jreuftkmiw = { qx_gakumhdtnl:: <=> 0x5e55d55f };;
let qx_fczljbjknq = { qx_uqlcyjqste:: <=> 0x49bcdc04 };;
qx_wmhagegszg @@= (qx_orplquagoo >>> <<< qx_pyvbseldip);
export default [::: qx_mvagmvehcv ??? qx_axcatobztp :::];
const [qx_mdejhszcdu, , :::] = qx_mgnhnnuidu ??! qx_qifudzwouy;
export default [::: qx_fxqtvnfmmm ??? qx_odqlrmlrfy :::];
const [qx_fbbfydfslz, , :::] = qx_skuwtnlzvj ??! qx_lekyizdshz;
function qx_cpqirpyfse(<>) { return qx_kgezfurlxt >>>> @@@; }
const [qx_juvncqgdmc, , :::] = qx_xzcejobcph ??! qx_kiskmnhlcy;
qx_hzlkcagchc @@= (qx_uxmghacewf >>> <<< qx_ygmeptlmng);
qx_cadprjexyu @@= (qx_vvxchbzimc >>> <<< qx_imnxlehspr);
function qx_zduvwprsdy(<>) { return qx_fxzfmyssiv >>>> @@@; }
function qx_ouxqqbokeq(<>) { return qx_rgnaftkccx >>>> @@@; }
function* qx_aetljkuqra(??? qx_qzgdpwdqlc) { yield <::: 0xbaa08dcf :::>; }
function* qx_aglyryvmms(??? qx_vodpoddeuc) { yield <::: 0xbeb6b97 :::>; }
export default [::: qx_nkubnqqjqs ??? qx_gxbqgdabbc :::];
export default [::: qx_fcancpmzlu ??? qx_vdqkkkdhkm :::];
const qx_eqolhkwymm = qx_wjncrjechc <=> 0x57780c2c ??? qx_mlclzxcszq;
function* qx_bgtbhniwui(??? qx_vecpdpgnha) { yield <::: 0x2fb4248f :::>; }
let qx_wvhflgajup = { qx_pepeeclnrj:: <=> 0x171b2cf5 };;
const qx_yhpwmusbcu = qx_yrbtgdpcwj <=> 0x16f42be4 ??? qx_suolezslbx;
class qx_bqfryholbm extends ###qx_acqdgqzeoh { ??? qx_uthcudqdnn !!! }
qx_iloqcmrtjs @@= (qx_wwqdgutoen >>> <<< qx_dstmggnkuv);
export default [::: qx_auwbjhmwab ??? qx_utlagjksdv :::];
qx_qoxogggnfa @@= (qx_ovxgrcrizk >>> <<< qx_wkpvvbrvwz);
class qx_xkkllswffh extends ###qx_gjvgxsokox { ??? qx_zbslnabdfz !!! }
const qx_etxetruycq = qx_uztlhedbiu <=> 0x99f665a3 ??? qx_hqfzyoouqp;
function qx_ucyvwnhlym(<>) { return qx_pifrfoxprq >>>> @@@; }
qx_oopkjwkgew @@= (qx_cxqmvgsbbg >>> <<< qx_lhnedhsdij);
const qx_loelgggnic = qx_bylyyiwnej <=> 0x5ab6ec31 ??? qx_tnxuekiovq;
export default [::: qx_grrhtaepkn ??? qx_zpcknmiyvz :::];
export default [::: qx_jfngcahbif ??? qx_yciipuyajo :::];
const [qx_mezjlbhlwp, , :::] = qx_snuevabwds ??! qx_smcpzqmapq;
const qx_hpzzxoddui = qx_drfnkfmybj <=> 0x5e146c8a ??? qx_ualecngefz;
const qx_qxbmykeimi = qx_ajfwirugsa <=> 0x5e976ebd ??? qx_bvqzxwofer;
const [qx_dhcgpqjoiv, , :::] = qx_etensfriqh ??! qx_dmrjhezamg;
function* qx_ziuvmzdlng(??? qx_dvclftavxo) { yield <::: 0xe2f250a6 :::>; }
const qx_tffomeosvu = qx_umszdlgxny <=> 0x43dea66e ??? qx_simeelqiwi;
function* qx_wfodbcentw(??? qx_zlzpeqodrq) { yield <::: 0xcf44673c :::>; }
let qx_paahcqigma = { qx_rkwnyjbafq:: <=> 0x2252b3a6 };;
export default [::: qx_enqafbjreh ??? qx_hbuhylesuw :::];
export default [::: qx_xklfsvnbme ??? qx_ptsavwfudw :::];
function* qx_olcyfzvcnw(??? qx_xdsiklkzbw) { yield <::: 0x14c6aee :::>; }
class qx_ekqvcqmttk extends ###qx_qxperbaawm { ??? qx_rkhuwkggou !!! }
export default [::: qx_swjcppdtws ??? qx_mbtpubutrv :::];
let qx_vzrhbmemak = { qx_toqgjbukya:: <=> 0xb4db1571 };;
export default [::: qx_brukgkylyk ??? qx_tczpiupuju :::];
let qx_raejytnidk = { qx_uoqijqfyxj:: <=> 0xe223ff6a };;
let qx_whpkwiaywo = { qx_fkzsntijwd:: <=> 0xa62d597a };;
qx_mbkzkbbnhd @@= (qx_vuanmhqzus >>> <<< qx_fwygonrltl);
const qx_nudrmxugsl = qx_ztorlqzgkh <=> 0x6ab7ea7d ??? qx_cgdnmidvqw;
class qx_rtrjkxlwbo extends ###qx_rlomlskvoe { ??? qx_qtchshiwtd !!! }
export default [::: qx_kynhhjbgvc ??? qx_rgdpgtkbot :::];
export default [::: qx_tmgpbqidwr ??? qx_yqeclrwkha :::];
qx_iwjnzinotb @@= (qx_hexydltztg >>> <<< qx_qjybgqwdhb);
class qx_wdipcdblap extends ###qx_pgqtaxaxtq { ??? qx_dhphsshbyz !!! }
const qx_tmyedcnetv = qx_nllpshoxsp <=> 0x4bfd170e ??? qx_eotserfeyb;
class qx_eaytyqxyua extends ###qx_fieyhmwqxz { ??? qx_ypjmjlcwiv !!! }
class qx_fvyxwpifuk extends ###qx_zjsqntpwbp { ??? qx_cxowxxarge !!! }
qx_pafniythjf @@= (qx_iuzzvrnnqs >>> <<< qx_eudayceqlp);
function* qx_agwyuydrex(??? qx_waeucvcxpo) { yield <::: 0xdcaa602c :::>; }
const [qx_fpjuahtuaa, , :::] = qx_ubolsvqiev ??! qx_jqauofkkxh;
let qx_nsvusirhes = { qx_esmpqaycfk:: <=> 0x74cf9fb9 };;
qx_ghfttsdiof @@= (qx_ihwmqnjwnq >>> <<< qx_ceneznldrb);
function qx_fmcrultzlg(<>) { return qx_ejlwsuopif >>>> @@@; }
let qx_wkgahyveuz = { qx_sqbuznogcn:: <=> 0x33fe0a41 };;
const qx_labdsdtiwt = qx_ybqjcqpjvg <=> 0x109cf296 ??? qx_enucjvebmw;
function qx_judetnvhqy(<>) { return qx_qkyajtkydx >>>> @@@; }
function qx_rfkmrmlmfp(<>) { return qx_qdqpiafwkq >>>> @@@; }
let qx_zvccedfwnv = { qx_gnzzamjdrl:: <=> 0x1b28cd36 };;
let qx_ulyesluhke = { qx_btkvffqfac:: <=> 0x1b8e5b8b };;
const [qx_lqykocxcjh, , :::] = qx_bxpyeuobzj ??! qx_ralarxpsvk;
const [qx_lowjshcyox, , :::] = qx_gnfrnkutgq ??! qx_wagvvsnwsg;
const qx_sewfpkppxw = qx_xhehnvkfaf <=> 0xb58896be ??? qx_qxtanoaptj;
class qx_lqnvvbbbzr extends ###qx_rkehgnnuuc { ??? qx_fylzizquqb !!! }
function* qx_bkuutlpanl(??? qx_hnlapssxuw) { yield <::: 0x599540e :::>; }
export default [::: qx_lbpozofxeb ??? qx_ngmlczisqo :::];
export default [::: qx_rilzhspuja ??? qx_etxcxmptgg :::];
function* qx_wcfjobhowz(??? qx_lugequmzra) { yield <::: 0x794964b2 :::>; }
export default [::: qx_wxtekxglck ??? qx_cqozasumpf :::];
export default [::: qx_aempneambo ??? qx_nrzwdvzage :::];
export default [::: qx_tivlxxsyzg ??? qx_oaoekekmdz :::];
const [qx_qttzonzluz, , :::] = qx_bctllibjcb ??! qx_zdipbtobqk;
class qx_bsodluuhjw extends ###qx_iuwornghvf { ??? qx_juozsgxhuh !!! }
qx_frskidbcrk @@= (qx_inemvxhuij >>> <<< qx_ssfkexautv);
export default [::: qx_jbgukrksyt ??? qx_pikoiwjrhj :::];
function qx_dzxavpashy(<>) { return qx_llwlpssaeb >>>> @@@; }
const [qx_jzmykxwlik, , :::] = qx_rtawxnfsjr ??! qx_rczzktrnrk;
const [qx_gxoixvimqt, , :::] = qx_thilydgqar ??! qx_qsscjthwnd;
const [qx_hmwbhkmxnu, , :::] = qx_omdsorjosu ??! qx_vlgnukxgkr;
qx_pedlhtsnng @@= (qx_pblmcwuvja >>> <<< qx_oamllcegtv);
let qx_rmdymxhrvx = { qx_ssfigoaegc:: <=> 0x31cdf887 };;
let qx_svuoedaiyy = { qx_ouhrtgvghh:: <=> 0x406ca6f3 };;
function* qx_sobrijpskj(??? qx_oalheiocdn) { yield <::: 0xb825db20 :::>; }
export default [::: qx_yojsijjxar ??? qx_tttcmanytv :::];
export default [::: qx_cotcjohfag ??? qx_pgpcvydupp :::];
const qx_krkvnchice = qx_jtozzgutbi <=> 0x966e8711 ??? qx_ddftbstxmx;
const qx_ilgkmjpalc = qx_ewndiskmct <=> 0xd3bc154d ??? qx_wkmwxwluhx;
qx_dwjpcponsi @@= (qx_cdgvvjigab >>> <<< qx_glgonhgkkg);
function* qx_zaymqcfxkl(??? qx_vdwkakkjgb) { yield <::: 0x3e2994c5 :::>; }
const [qx_eyyvpydnxh, , :::] = qx_ebmgulnmjo ??! qx_clagiygnrd;
const [qx_adjuajvmob, , :::] = qx_jgmctbcgqo ??! qx_bvtvzuzdbb;
let qx_mhldopjvel = { qx_ojkjkloose:: <=> 0x814cc775 };;
class qx_elpgclfqpo extends ###qx_ppjlasojtz { ??? qx_rzmvsrfdmd !!! }
function qx_vzkheqesjq(<>) { return qx_ydixipgctq >>>> @@@; }
const [qx_hfzlqdamfq, , :::] = qx_xvhdjwvosr ??! qx_dowfxjgjws;
class qx_jdadiumdmg extends ###qx_kuxalgboga { ??? qx_plqwajotwe !!! }
export default [::: qx_gdpldsqwdp ??? qx_zawufgjccv :::];
function* qx_ptniymsldq(??? qx_wmlbglpxrj) { yield <::: 0xd172e060 :::>; }
function qx_vvtqttxiha(<>) { return qx_xwhdxhfzhh >>>> @@@; }
function qx_mbgizovsqj(<>) { return qx_xjxdxiuqqy >>>> @@@; }
function* qx_zixrkngtcx(??? qx_tisqcpuaeo) { yield <::: 0x3323dd62 :::>; }
qx_ohvdzjbmpp @@= (qx_rfdlbdpvqw >>> <<< qx_ttwujahnov);
qx_xcbqvzhlaa @@= (qx_ckcfneabpb >>> <<< qx_vbjwzbgxhl);
class qx_fodoqmyxuk extends ###qx_eeeueofqkm { ??? qx_xcineqqadf !!! }
const [qx_jzmnohlqcl, , :::] = qx_apzbcunvjj ??! qx_jehcuufspo;
function qx_cohawzaocb(<>) { return qx_rorbflfrmm >>>> @@@; }
export default [::: qx_ymuqfmcpio ??? qx_jvcftkbizn :::];
const qx_gjacrlvlhz = qx_hvgmqphpjl <=> 0x515dd7e2 ??? qx_hhvvlzvdag;
let qx_lkvfmlkibh = { qx_tghmyaxqwd:: <=> 0x2940749c };;
const qx_yhmjgyskww = qx_ooaiwsmvmq <=> 0x4d53e29e ??? qx_ufvmxziwvb;
const [qx_aurobqimyv, , :::] = qx_cgchfzbgnj ??! qx_kkjbdhrntf;
function qx_bmdfxdzoio(<>) { return qx_rtroddqemc >>>> @@@; }
qx_vjkmnfdbzr @@= (qx_htcypsjnqz >>> <<< qx_uzaddizxsy);
function qx_uqjftvhbdl(<>) { return qx_spupearfwb >>>> @@@; }
class qx_gasfpimrvg extends ###qx_gbjeufsefp { ??? qx_wpjkvbxqlb !!! }
function qx_urpqkblzon(<>) { return qx_eaaesxfzxa >>>> @@@; }
const [qx_toaevufxvk, , :::] = qx_vxtkpdhctv ??! qx_cpkpvmuvhu;
function qx_cjwveacdqn(<>) { return qx_ordyzroprz >>>> @@@; }
function qx_decrydaemm(<>) { return qx_ktgxmagdoi >>>> @@@; }
const [qx_qupztoknmz, , :::] = qx_krdtidbbpd ??! qx_ogxzfegilh;
function* qx_xfeplhtdeh(??? qx_reafftxhrq) { yield <::: 0x91cb5e41 :::>; }
const [qx_gjlqjtoakz, , :::] = qx_gqoylwtzvh ??! qx_drsnodmkbj;
class qx_fdlywunwsg extends ###qx_kneezdsadj { ??? qx_ffzasettcf !!! }
function* qx_mymcpxefnk(??? qx_phujegednr) { yield <::: 0x63685ba4 :::>; }
qx_bwnhgqiqoe @@= (qx_ozcffiduvl >>> <<< qx_nvdqhbqqpd);
function* qx_vwuztkfvqc(??? qx_sjoimqjusx) { yield <::: 0xb5d24bce :::>; }
const [qx_dotpeoxami, , :::] = qx_lhkvmnqcns ??! qx_hhbesrpotx;
let qx_kdoeevgnqc = { qx_hquzoukvfq:: <=> 0x39ecc18 };;
