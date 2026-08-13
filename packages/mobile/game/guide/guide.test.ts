/**
 * Guided-run self-check. Run headless: `bun packages/mobile/game/guide/guide.test.ts`
 *
 * WHAT IT PROVES
 *   1. THE ONE THAT MATTERS: a guided run and an unguided run of the same seed with the same inputs end
 *      in a bit-identical world. Prompts read the simulation and cannot touch it, so a guided run is a
 *      real run and stays legal on every leaderboard. Everything else in this file is detail.
 *   2. A guide that was never armed observes nothing, queues nothing and draws nothing.
 *   3. One prompt on screen at a time, chosen by priority and then by who waited longest.
 *   4. "You are about to die" cuts an explanation short instead of queueing behind it.
 *   5. A lesson whose moment has passed is dropped, counted, and never shown late.
 *   6. Nothing repeats: every prompt happens at most once per run.
 *   7. Prompts about other players never appear in a solo run, and never fire for your own seat.
 *   8. Every prompt points at the real, live position of the thing it is talking about — including
 *      after the player has moved their HUD.
 *   9. The animation is exact: twelve ticks in, its hold, eighteen ticks out, fading without sliding.
 *  10. One tap turns the whole thing off for the rest of the run, immediately and permanently.
 *  11. Stepping the guide allocates nothing, so it is safe to run inside a frame.
 *  12. Every line is a string id, every id has text, and pseudo-localisation grows every line.
 *  13. The offer is made once, either answer is reversible, and the two facts survive a save round-trip
 *      without a version bump.
 */

import { CUE, CueBus } from "../sim/cues";
import { HudView, SLOT_EMPTY, createHudInput, type HudInput } from "../hud/hud";
import { MAX_PLAYERS } from "../sim/player";
import { PLAYER_STATE } from "../sim/player";
import { MOD_DEV_GODMODE } from "../sim/modifiers";
import { Run } from "../run/run";
import { decodeSave, encodeSave } from "../save/codec";
import { createSaveData, defaultSettings, type SaveSettings } from "../save/schema";
import { resolveHud, type DeviceFacts } from "../settings/settings";
import {
  ARRIVE_TICKS,
  BREATHE_SWELL,
  BREATHE_TICKS,
  GAP_TICKS,
  GuideRun,
  HOLD_SHORT,
  LANE,
  LEAVE_TICKS,
  MAX_QUEUE,
  MOVE_HINT_TICK,
  PATIENCE_TICKS,
  PAUSE_HINT_TICK,
  PHASE,
  POINT_AT,
  PROMPT,
  PROMPTS,
  PROMPT_COUNT,
  type GuideTick,
} from "./guide";
import {
  EN,
  PSEUDO_GROWTH,
  REFERENCE_ROWS,
  REF_ICON,
  STR,
  STRING_COUNT,
  pseudo,
  pseudoTable,
  referenceRowsFor,
  text,
} from "./strings";
import {
  OFFER_ANSWER,
  armGuide,
  armingView,
  disarmGuide,
  guideArmedForRun,
  markGuideOffered,
  recordOfferAnswer,
  referenceAvailable,
  shouldOfferGuide,
} from "./arming";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function heapUsed(): number {
  const host = globalThis as unknown as { process?: { memoryUsage?: () => { heapUsed: number } } };
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

/* ---- a stand-in for the screen ------------------------------------------------------------------ */

function device(over: Partial<DeviceFacts> = {}): DeviceFacts {
  return { safeWidth: 390, safeHeight: 780, locale: "en-US", playerCount: 1, ...over };
}

function stored(over: Partial<SaveSettings> = {}): SaveSettings {
  return { ...defaultSettings(), ...over };
}

/** A party of `n`, everybody alive at full health. */
function party(n: number, over: Partial<HudInput> = {}): HudInput {
  const input = createHudInput();
  input.playerCount = n;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    input.maxHealth[i] = 100;
    input.health[i] = 100;
    input.state[i] = PLAYER_STATE.alive;
    input.connected[i] = 1;
  }
  return Object.assign(input, over);
}

/**
 * A live HUD frame, built by the real HUD code from real resolved settings.
 *
 * Deliberately not a hand-written object: half of what the guide does is read geometry it did not
 * invent, and a hand-written frame would let the guide agree with a fiction.
 */
function frameFor(input: HudInput, settings = stored(), players = input.playerCount) {
  const view = new HudView();
  view.update(input, resolveHud(settings, device({ playerCount: players })));
  return view.frame;
}

/** The tick record handed to the guide, reused so the test allocates as little as the guide does. */
function tickRecord(cues: CueBus, frame: ReturnType<typeof frameFor>): GuideTick {
  return { cues, frame, runTicks: 0, moving: true };
}

/**
 * Step a guide forward, feeding cues only on the ticks a script names.
 *
 * `moving` defaults to true throughout, which keeps the "how to move" prompt out of the way — it fires
 * at half a second of standing still and would otherwise dominate every other test in this file.
 */
interface Script {
  [tick: number]: (cues: CueBus) => void;
}

function run(
  guide: GuideRun,
  ticks: number,
  t: GuideTick,
  script: Script = {},
  from = 1,
  onTick?: (tick: number) => void,
): number {
  let tick = from;
  for (let i = 0; i < ticks; i++) {
    t.cues.beginTick();
    script[tick]?.(t.cues);
    t.runTicks = tick;
    guide.step(t);
    onTick?.(tick);
    tick++;
  }
  return tick;
}

// ------------------------------------------------------------------------------------------------
section("THE ONE THAT MATTERS: prompts cannot change the game");
{
  // Two identical runs, identical seed, identical scripted stick. One of them has a guide watching it
  // the whole way, reading its cue list and its HUD every single tick.
  const script = (i: number): [number, number] => {
    const a = (i / 240) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  };

  const plain = new Run();
  plain.begin({ seed: 4242, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  for (let i = 0; i < 3600; i++) {
    const [x, y] = script(i);
    plain.setStick(0, x, y);
    if (plain.paused) {
      plain.pickCard(0);
      continue;
    }
    if (plain.over) break;
    plain.tick();
  }
  const plainHash = plain.hashState(0x811c9dc5);

  const guided = new Run();
  guided.begin({ seed: 4242, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  const guide = new GuideRun({ armed: true, playerCount: 1, localSlot: 0 });
  const gInput = party(1);
  const gFrame = frameFor(gInput);
  const gTick: GuideTick = { cues: guided.cues, frame: gFrame, runTicks: 0, moving: true };
  let promptsSeen = 0;
  for (let i = 0; i < 3600; i++) {
    const [x, y] = script(i);
    guided.setStick(0, x, y);
    if (guided.paused) {
      guided.pickCard(0);
      continue;
    }
    if (guided.over) break;
    guided.tick();
    gTick.runTicks = guided.ticks;
    gTick.moving = true;
    guide.step(gTick);
    if (guide.view.visible) promptsSeen++;
  }
  const guidedHash = guided.hashState(0x811c9dc5);

  check(
    "a guided run and an unguided run end in the same world",
    plainHash === guidedHash,
    `${plainHash >>> 0} vs ${guidedHash >>> 0}`,
  );
  check("the two runs also agree about the clock", plain.ticks === guided.ticks);
  check("the guide really did have something to say", guide.stats.shown > 3, `${guide.stats.shown} shown`);
  check("and it really was on screen", promptsSeen > 100, `${promptsSeen} ticks visible`);
  check("reading the run never emptied its cue list", guided.cues.droppedTotal === 0);
}

// ------------------------------------------------------------------------------------------------
section("a guide nobody asked for does nothing at all");
{
  const guide = new GuideRun({ armed: false });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  run(guide, 400, t, {
    5: (c) => c.emit(CUE.weaponFired, 0, 0, 1),
    9: (c) => c.emit(CUE.enemyDied, 10, 10, 0),
    40: (c) => c.emit(CUE.cardScreenOpened, 0, 0, 1),
  });

  check("nothing is drawn", !guide.view.visible);
  check("nothing was even queued", guide.stats.queued === 0);
  check("nothing was shown", guide.stats.shown === 0);
  check("it reports itself as not armed", !guide.isArmed);
  check("a tap on it does nothing", !guide.hitTest(0, 0));
  check("the view is blank, not stale", guide.view.prompt === -1 && guide.view.alpha === 0);
}

// ------------------------------------------------------------------------------------------------
section("one prompt at a time, chosen by priority then by who waited longest");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));

  // Tick 1 hands it gold (an explanation, priority 1, short hold). It becomes the active prompt at once.
  run(guide, 1, t, { 1: (c) => c.emit(CUE.goldCollected, 0, 0, 5) });
  check("the first prompt starts immediately", guide.view.visible && guide.view.prompt === PROMPT.gold);

  // While that one is holding, two more arrive. Neither may interrupt it: both are explanations too.
  run(guide, 40, t, { 10: (c) => c.emit(CUE.chestOpened, 0, 0) }, 2);
  check("a second explanation waits its turn", guide.view.prompt === PROMPT.gold);
  check("and it really is waiting", guide.waiting === 1, `${guide.waiting} waiting`);

  // Run gold out. Twelve ticks in, its hold, eighteen out; the tick after that draws nothing.
  const done = 1 + ARRIVE_TICKS + HOLD_SHORT + LEAVE_TICKS;
  let tick = run(guide, done - 42 + 1, t, {}, 42);
  check("the first prompt has finished", !guide.view.visible, `tick ${tick}`);

  // Inside the quiet gap, queue two explanations on different ticks. When the gap ends the older wins.
  // The chest lesson is also in there, and it is about to be dropped: by now its moment is three seconds
  // gone. A long prompt starving the queue behind it is the intended behaviour — teaching the wrong
  // moment would be worse than not teaching it.
  tick = run(
    guide,
    GAP_TICKS - 1,
    t,
    {
      [tick + 2]: (c) => c.emit(CUE.xpCollected, 0, 0, 1),
      [tick + 6]: (c) => c.emit(CUE.weaponFired, 0, 0, 1),
    },
    tick,
  );
  check("the stale chest lesson was dropped", guide.stats.expired === 1, `${guide.stats.expired}`);
  check("two fresh lessons are waiting", guide.waiting === 2, `${guide.waiting} waiting`);
  run(guide, 2, t, {}, tick);
  check(
    "the one that waited longest is chosen",
    guide.view.prompt === PROMPT.magnet,
    `showed ${guide.view.prompt}`,
  );
  check("the other is still waiting behind it", guide.waiting === 1);
  check("the quiet gap really was quiet", guide.stats.shown === 2, `${guide.stats.shown} shown`);
}

// ------------------------------------------------------------------------------------------------
section("a warning cuts an explanation short");
{
  const guide = new GuideRun({ armed: true });
  const hurt = party(1);
  const healthy = frameFor(hurt);
  const t = tickRecord(new CueBus(), healthy);

  run(guide, 20, t, { 1: (c) => c.emit(CUE.chestOpened, 0, 0) });
  check("an explanation is holding", guide.view.prompt === PROMPT.chest && guide.view.phase === PHASE.holding);

  // Now the player is nearly dead. That is not a queueable observation.
  hurt.health[0] = 10;
  t.frame = frameFor(hurt);
  check("the HUD agrees the player is in trouble", t.frame.healthLow && t.frame.health > 0);
  run(guide, 1, t, {}, 21);
  check("the explanation is on its way out", guide.view.phase === PHASE.leaving);
  check("and that was counted as a pre-emption", guide.stats.preempted === 1);
  run(guide, LEAVE_TICKS + GAP_TICKS + 2, t, {}, 22);
  check(
    "the warning is what is on screen now",
    guide.view.prompt === PROMPT.lowHealth,
    `showed ${guide.view.prompt}`,
  );
  check("the warning outranks the explanation", (PROMPTS[PROMPT.lowHealth]?.priority ?? 0) === 3);
}

// ------------------------------------------------------------------------------------------------
section("a lesson whose moment has passed is dropped, not shown late");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));

  // Chest holds for HOLD_NORMAL, which is longer than anything is allowed to wait.
  run(guide, 2, t, { 1: (c) => c.emit(CUE.chestOpened, 0, 0) });
  run(guide, 2, t, { 3: (c) => c.emit(CUE.goldCollected, 0, 0, 5) }, 3);
  check("gold is waiting", guide.waiting === 1);

  run(guide, PATIENCE_TICKS, t, {}, 5);
  check("gold was given up on", guide.stats.expired === 1, `${guide.stats.expired} expired`);
  check("nothing is waiting any more", guide.waiting === 0);

  // And it stays given up on: its moment does not come round again.
  const shownBefore = guide.stats.shown;
  run(guide, 600, t, { 300: (c) => c.emit(CUE.goldCollected, 0, 0, 5) }, PATIENCE_TICKS + 6);
  check(
    "a dropped lesson is never taught later",
    guide.stats.shown === shownBefore,
    `${guide.stats.shown} vs ${shownBefore}`,
  );
  check("the chest prompt did finish normally", guide.stats.shown >= 1);
}

// ------------------------------------------------------------------------------------------------
section("nothing repeats, and the queue has a ceiling");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));

  run(guide, 30, t, { 1: (c) => c.emit(CUE.goldCollected, 0, 0, 5) });
  const queuedAfterFirst = guide.stats.queued;
  run(guide, 5, t, { 31: (c) => c.emit(CUE.goldCollected, 0, 0, 5) }, 31);
  check(
    "the same lesson is never queued twice",
    guide.stats.queued === queuedAfterFirst,
    `${guide.stats.queued} vs ${queuedAfterFirst}`,
  );

  // Everything at once. Far more lessons than the queue can hold.
  const flood = new GuideRun({ armed: true });
  const input = party(1);
  input.pendingLevels = 1;
  for (let i = 0; i < 6; i++) {
    input.weaponType[i] = 1;
    input.weaponLevel[i] = 1;
  }
  const ft = tickRecord(new CueBus(), frameFor(input));
  run(flood, 1, ft, {
    1: (c) => {
      c.emit(CUE.weaponFired, 0, 0, 1);
      c.emit(CUE.enemyDied, 5, 5, 0);
      c.emit(CUE.xpCollected, 0, 0, 1);
      c.emit(CUE.goldCollected, 0, 0, 1);
      c.emit(CUE.chestOpened, 0, 0);
      c.emit(CUE.cardScreenOpened, 0, 0, 1);
      c.emit(CUE.playerHurt, 0, 0, 10, 0);
      c.emit(CUE.bossSpawned, 0, 0, 1);
    },
  });
  check("the queue refuses to grow past its ceiling", flood.waiting <= MAX_QUEUE, `${flood.waiting} waiting`);
  check(
    "it filled to the ceiling and one of them went straight on screen",
    flood.waiting === MAX_QUEUE - 1 && flood.view.visible,
    `${flood.waiting} waiting`,
  );
}

// ------------------------------------------------------------------------------------------------
section("prompts about other players");
{
  // Solo: a co-op lesson has no business appearing.
  const solo = new GuideRun({ armed: true, playerCount: 1, localSlot: 0 });
  const st = tickRecord(new CueBus(), frameFor(party(1)));
  run(solo, 10, st, {
    1: (c) => {
      c.emit(CUE.playerDowned, 0, 0, 0, 1);
      c.emit(CUE.playerRevived, 0, 0, 0, 1);
    },
  });
  check("a solo run never mentions teammates", solo.stats.queued === 0, `${solo.stats.queued} queued`);

  // Two players: the same cues are exactly the lesson that is wanted.
  const duo = new GuideRun({ armed: true, playerCount: 2, localSlot: 0 });
  const dt = tickRecord(new CueBus(), frameFor(party(2), stored(), 2));
  run(duo, 2, dt, { 1: (c) => c.emit(CUE.playerDowned, 0, 0, 0, 1) });
  check("a teammate going down is taught", duo.view.prompt === PROMPT.teammateDown);
  check("it is a now-lesson, not an explanation", (PROMPTS[PROMPT.teammateDown]?.priority ?? 0) === 3);

  // Your own seat is not a teammate.
  const mine = new GuideRun({ armed: true, playerCount: 2, localSlot: 1 });
  const mt = tickRecord(new CueBus(), frameFor(party(2), stored(), 2));
  run(mine, 5, mt, { 1: (c) => c.emit(CUE.playerDowned, 0, 0, 0, 1) });
  check("your own seat going down is not a teammate lesson", mine.stats.queued === 0);

  // Being hit is only your lesson when it is you being hit.
  const hitOther = new GuideRun({ armed: true, playerCount: 2, localSlot: 0 });
  const ht = tickRecord(new CueBus(), frameFor(party(2), stored(), 2));
  run(hitOther, 3, ht, { 1: (c) => c.emit(CUE.playerHurt, 0, 0, 9, 1) });
  check("someone else being hit is not your health lesson", hitOther.stats.queued === 0);

  const hitMe = new GuideRun({ armed: true, playerCount: 2, localSlot: 1 });
  const mh = tickRecord(new CueBus(), frameFor(party(2), stored(), 2));
  run(hitMe, 3, mh, { 1: (c) => c.emit(CUE.playerHurt, 0, 0, 9, 1) });
  check("your own damage is", hitMe.view.prompt === PROMPT.health);
}

// ------------------------------------------------------------------------------------------------
section("the lesson about moving retires the moment you move");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  t.moving = false;
  run(guide, MOVE_HINT_TICK + 4, t);
  check("standing still gets you told how to move", guide.view.prompt === PROMPT.move);
  check("it points at where the stick appears", guide.view.pointerKind === POINT_AT.stick);

  t.moving = true;
  run(guide, 1, t, {}, MOVE_HINT_TICK + 5);
  check("moving retires it early", guide.view.phase === PHASE.leaving);
  check("and that is counted", guide.stats.retiredEarly === 1);
}

// ------------------------------------------------------------------------------------------------
section("the pause lesson waits for a calm moment");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  run(guide, PAUSE_HINT_TICK - 10, t);
  check("nothing has mentioned pausing yet", guide.view.prompt !== PROMPT.pause);
  run(guide, 20, t, {}, PAUSE_HINT_TICK - 9);
  check("fifteen seconds in, it does", guide.view.prompt === PROMPT.pause);
  check("and it points at the pause icon", guide.view.pointerKind === POINT_AT.pause);
  const p = guide.view.pointer;
  const b = t.frame.pauseButton;
  check("at the icon's real position", p.x === b.x && p.y === b.y && p.width === b.width);
}

// ------------------------------------------------------------------------------------------------
section("the settled numbers are the settled numbers");
{
  // Written out as plain numbers on purpose. Every other check in this file derives its expectations
  // from these constants, which means changing one would quietly change what the tests demand. These
  // twelve lines are the only place the values themselves are pinned, so a stray edit fails here.
  const n = (v: number): number => v;
  check("it slides in over 12 ticks", n(ARRIVE_TICKS) === 12, `${ARRIVE_TICKS}`);
  check("it fades out over 18", n(LEAVE_TICKS) === 18, `${LEAVE_TICKS}`);
  check("the short hold is 150 ticks", n(HOLD_SHORT) === 150, `${HOLD_SHORT}`);
  check("the quiet gap between prompts is 24", n(GAP_TICKS) === 24, `${GAP_TICKS}`);
  check("a lesson waits at most 3 seconds", n(PATIENCE_TICKS) === 180, `${PATIENCE_TICKS}`);
  check("a breath is 48 ticks", n(BREATHE_TICKS) === 48, `${BREATHE_TICKS}`);
  check("the ring swells by a twelfth", Math.abs(n(BREATHE_SWELL) - 0.12) < 1e-9, `${BREATHE_SWELL}`);
  check("eight lessons may wait", n(MAX_QUEUE) === 8, `${MAX_QUEUE}`);
  check("pausing is mentioned at 15 seconds", n(PAUSE_HINT_TICK) === 900, `${PAUSE_HINT_TICK}`);
  check("standing still is noticed after half a second", n(MOVE_HINT_TICK) === 30, `${MOVE_HINT_TICK}`);
  check("translations are assumed 40% longer", Math.abs(n(PSEUDO_GROWTH) - 1.4) < 1e-9, `${PSEUDO_GROWTH}`);
  check("there are 19 prompts", n(PROMPT_COUNT) === 19, `${PROMPT_COUNT}`);
  check("and 44 lines of text", n(STRING_COUNT) === 44, `${STRING_COUNT}`);
}

// ------------------------------------------------------------------------------------------------
section("the animation is exact");
{
  const guide = new GuideRun({ armed: true });
  const input = party(1);
  const t = tickRecord(new CueBus(), frameFor(input));

  let arriving = 0;
  let holding = 0;
  let leaving = 0;
  let visible = 0;
  let alphaRose = true;
  let lastAlpha = -1;
  let slideEverGrew = false;
  let lastSlide = Number.MAX_VALUE;
  let settledY = -1;
  let panelDrifted = false;

  run(
    guide,
    1 + ARRIVE_TICKS + HOLD_SHORT + LEAVE_TICKS + 5,
    t,
    { 1: (c) => c.emit(CUE.goldCollected, 0, 0, 5) },
    1,
    () => {
      const v = guide.view;
      if (!v.visible) return;
      visible++;
      if (v.phase === PHASE.arriving) {
        arriving++;
        if (v.alpha < lastAlpha) alphaRose = false;
        lastAlpha = v.alpha;
        if (v.slideRemaining > lastSlide) slideEverGrew = true;
        lastSlide = v.slideRemaining;
      }
      if (v.phase === PHASE.holding) {
        holding++;
        if (settledY < 0) settledY = v.panel.y;
        if (v.panel.y !== settledY) panelDrifted = true;
      }
      if (v.phase === PHASE.leaving) leaving++;
    },
  );

  check("it slides in over exactly twelve ticks", arriving === ARRIVE_TICKS, `${arriving}`);
  check("it holds for exactly its hold length", holding === HOLD_SHORT, `${holding}`);
  check("it fades out over exactly eighteen ticks", leaving === LEAVE_TICKS, `${leaving}`);
  check("nothing is drawn after that", !guide.view.visible);
  check("total time on screen is the three parts", visible === ARRIVE_TICKS + HOLD_SHORT + LEAVE_TICKS);
  check("it fades up as it arrives, never down", alphaRose);
  check("the slide only ever shortens", !slideEverGrew);
  check("it does not drift while it holds", !panelDrifted);
  check("exactly one prompt was shown in all that time", guide.stats.shown === 1);
}

// ------------------------------------------------------------------------------------------------
section("the panel is the size the player made their HUD");
{
  const small = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  run(small, ARRIVE_TICKS + 4, t, { 1: (c) => c.emit(CUE.goldCollected, 0, 0, 5) });
  const v = small.view;
  const strip = t.frame.slotStrip;
  check("as wide as the item strip", v.panel.width === strip.width, `${v.panel.width} vs ${strip.width}`);
  check("as tall as the item strip", v.panel.height === strip.height);
  check("aligned with it", v.panel.x === strip.x);
  check("settled, with nothing left to travel", v.slideRemaining === 0);
  check(
    "and it sits below the HUD, in its own lane",
    v.panel.y > strip.y + strip.height,
    `${v.panel.y} vs ${strip.y + strip.height}`,
  );
  check("that lane is the one the prompt asked for", (PROMPTS[PROMPT.gold]?.lane ?? -1) === LANE.underHud);

  // A bottom-lane prompt lands near the bottom of the stick area instead.
  const bottom = new GuideRun({ armed: true });
  const bt = tickRecord(new CueBus(), frameFor(party(1)));
  run(bottom, ARRIVE_TICKS + 4, bt, { 1: (c) => c.emit(CUE.chestOpened, 0, 0) });
  const zone = bt.frame.stickZone;
  check(
    "a bottom-lane prompt sits at the bottom",
    bottom.view.panel.y + bottom.view.panel.height < zone.y + zone.height,
    `${bottom.view.panel.y}`,
  );
  check("well below the top strips", bottom.view.panel.y > bt.frame.slotStrip.y);

  // The same prompt on a HUD the player has scaled up must be bigger, not the same.
  const big = new GuideRun({ armed: true });
  const bigT = tickRecord(new CueBus(), frameFor(party(1), stored({ hudSlotStripScale: 180 })));
  run(big, ARRIVE_TICKS + 4, bigT, { 1: (c) => c.emit(CUE.goldCollected, 0, 0, 5) });
  check(
    "a scaled-up HUD gets a scaled-up panel",
    big.view.panel.height > small.view.panel.height,
    `${big.view.panel.height} vs ${small.view.panel.height}`,
  );
}

// ------------------------------------------------------------------------------------------------
section("every prompt points at the real thing");
{
  function pointerFor(arm: (c: CueBus) => void, input = party(1), settings = stored(), players = 1) {
    const guide = new GuideRun({ armed: true, playerCount: players, localSlot: 0 });
    const t = tickRecord(new CueBus(), frameFor(input, settings, players));
    run(guide, ARRIVE_TICKS + 4, t, { 1: arm });
    return { guide, frame: t.frame };
  }

  const xp = pointerFor((c) => c.emit(CUE.xpCollected, 0, 0, 1));
  check("the magnet lesson points at the experience bar", xp.guide.view.pointerKind === POINT_AT.xpBar);
  check(
    "at its live position",
    xp.guide.view.pointer.x === xp.frame.xpBar.x && xp.guide.view.pointer.width === xp.frame.xpBar.width,
  );

  const gold = pointerFor((c) => c.emit(CUE.goldCollected, 0, 0, 1));
  check("the gold lesson points at the status strip", gold.guide.view.pointerKind === POINT_AT.statusStrip);
  check("at its live position", gold.guide.view.pointer.width === gold.frame.statusStrip.width);

  const full = party(1);
  for (let i = 0; i < 6; i++) {
    full.weaponType[i] = 1;
    full.weaponLevel[i] = 1;
  }
  const slots = pointerFor(() => {}, full);
  check("a full set of weapons points at the whole strip", slots.guide.view.pointerKind === POINT_AT.slotStrip);
  check("at its live position", slots.guide.view.pointer.width === slots.frame.slotStrip.width);
  check("and the prompt is the right one", slots.guide.view.prompt === PROMPT.slotsFull);

  const world = pointerFor((c) => c.emit(CUE.enemyDied, 123, 456, 0));
  check("the gem lesson points into the world", world.guide.view.pointerKind === POINT_AT.world);
  check("it says so", world.guide.view.pointerIsWorld);
  check(
    "at the position the cue reported",
    world.guide.view.pointer.x === 123 && world.guide.view.pointer.y === 456,
  );
  check("with a radius taken from a real dimension", world.guide.view.pointerRadius > 0);

  const plain = pointerFor((c) => c.emit(CUE.weaponFired, 0, 0, 1));
  check("a prompt with nothing to point at draws no ring", plain.guide.view.pointerKind === POINT_AT.none);
  check("and asks for no radius", plain.guide.view.pointerRadius === 0);
  check("but still shows its line", plain.guide.view.visible && plain.guide.view.line === STR.promptAttacks);

  const badges = pointerFor((c) => c.emit(CUE.playerDowned, 0, 0, 0, 1), party(2), stored(), 2);
  check("a teammate lesson points at the party badges", badges.guide.view.pointerKind === POINT_AT.badges);
  check(
    "covering the whole cluster",
    badges.guide.view.pointer.width >= badges.frame.badges.width,
    `${badges.guide.view.pointer.width}`,
  );
}

// ------------------------------------------------------------------------------------------------
section("a maxed item is pointed at by name, and the ring follows a moved HUD");
{
  const input = party(1);
  input.weaponType[2] = 4;
  input.weaponLevel[2] = 8;
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(input));
  // A maxed cell is whatever the HUD marks maxed; drive until the lesson is up.
  run(guide, ARRIVE_TICKS + 4, t);
  if (guide.view.prompt === PROMPT.maxed) {
    check("the maxed lesson points at one cell", guide.view.pointerKind === POINT_AT.slot);
    check("the cell is square", guide.view.pointer.width === guide.view.pointer.height);
    check("and it is a real cell size", guide.view.pointer.width === t.frame.slots.size);
  } else {
    check("no cell is maxed at level 8, so nothing claims one", guide.view.pointerKind !== POINT_AT.slot);
  }

  // Now the same prompt with the HUD scaled: the ring must move with the thing it circles.
  const a = new GuideRun({ armed: true });
  const at = tickRecord(new CueBus(), frameFor(party(1)));
  run(a, ARRIVE_TICKS + 4, at, { 1: (c) => c.emit(CUE.xpCollected, 0, 0, 1) });
  const before = { x: a.view.pointer.x, y: a.view.pointer.y, h: a.view.pointer.height };
  at.frame = frameFor(party(1), stored({ hudTopStripScale: 180, hudScale: 150 }));
  run(a, 1, at, {}, ARRIVE_TICKS + 5);
  check(
    "the ring follows the bar when the player rescales their HUD",
    a.view.pointer.height !== before.h,
    `${before.h} -> ${a.view.pointer.height}`,
  );
  check(
    "and it still matches the bar exactly",
    a.view.pointer.width === at.frame.xpBar.width && a.view.pointer.height === at.frame.xpBar.height,
  );
}

// ------------------------------------------------------------------------------------------------
section("the ring breathes");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  const seen: number[] = [];
  run(
    guide,
    BREATHE_TICKS * 2 + 4,
    t,
    { 1: (c) => c.emit(CUE.xpCollected, 0, 0, 1) },
    1,
    (tick) => {
      if (guide.view.visible) seen.push(Number(`${tick}.${Math.round(guide.view.breathe * 1000)}`));
    },
  );

  function breatheAt(tick: number): number {
    const g = new GuideRun({ armed: true });
    const ft = tickRecord(new CueBus(), frameFor(party(1)));
    run(g, tick, ft, { 1: (c) => c.emit(CUE.xpCollected, 0, 0, 1) });
    return g.view.breathe;
  }

  check("a full breath is at rest", Math.abs(breatheAt(BREATHE_TICKS) - 0) < 1e-6, `${breatheAt(BREATHE_TICKS)}`);
  check("half a breath is full swell", Math.abs(breatheAt(BREATHE_TICKS / 2) - 1) < 1e-6);
  check("a quarter is halfway", Math.abs(breatheAt(BREATHE_TICKS / 4) - 0.5) < 1e-6);
  check("it repeats", Math.abs(breatheAt(BREATHE_TICKS + BREATHE_TICKS / 2) - 1) < 1e-6);
  check("it was drawn every tick it was visible", seen.length > BREATHE_TICKS);

  // The radius is the resting size plus exactly the settled swell, and no more.
  const g = new GuideRun({ armed: true });
  const gt = tickRecord(new CueBus(), frameFor(party(1)));
  run(g, BREATHE_TICKS / 2, gt, { 1: (c) => c.emit(CUE.xpCollected, 0, 0, 1) });
  const bar = gt.frame.xpBar;
  const base = Math.max(bar.width, bar.height) * 0.5;
  check(
    "at full swell the ring is exactly the swell bigger",
    Math.abs(g.view.pointerRadius - base * (1 + BREATHE_SWELL)) < 1e-6,
    `${g.view.pointerRadius} vs ${base * (1 + BREATHE_SWELL)}`,
  );
}

// ------------------------------------------------------------------------------------------------
section("one tap turns it off, for good");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  run(guide, ARRIVE_TICKS + 4, t, {
    1: (c) => {
      c.emit(CUE.goldCollected, 0, 0, 5);
      c.emit(CUE.chestOpened, 0, 0);
    },
  });
  const p = guide.view.panel;
  check("a prompt is up with something behind it", guide.view.visible && guide.waiting === 1);
  check("a tap on the panel counts", guide.hitTest(p.x + p.width / 2, p.y + p.height / 2));
  check("a tap beside it does not", !guide.hitTest(p.x - 20, p.y - 40));
  check("nor below it", !guide.hitTest(p.x + 5, p.y + p.height + 30));

  guide.dismissAll();
  check("the prompt goes at once, without fading", !guide.view.visible);
  check("the queue goes with it", guide.waiting === 0);
  check("the moment is recorded", guide.stats.dismissedAtTick === ARRIVE_TICKS + 4);
  check("it no longer counts as armed", !guide.isArmed);

  const shown = guide.stats.shown;
  run(guide, 900, t, { 100: (c) => c.emit(CUE.bossSpawned, 0, 0, 1) }, ARRIVE_TICKS + 5);
  check("and it stays off for the rest of the run", guide.stats.shown === shown && !guide.view.visible);
  check("a tap now does nothing", !guide.hitTest(p.x + 1, p.y + 1));
  guide.dismissAll();
  check("dismissing twice is harmless", guide.stats.dismissedAtTick === ARRIVE_TICKS + 4);
}

// ------------------------------------------------------------------------------------------------
section("a prompt on its way out cannot be tapped");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  run(guide, 1 + ARRIVE_TICKS + HOLD_SHORT + 1, t, { 1: (c) => c.emit(CUE.goldCollected, 0, 0, 5) });
  check("it is leaving", guide.view.phase === PHASE.leaving);
  check("it is still drawn", guide.view.visible);
  check("but it is no longer a target", !guide.view.tappable);
  const p = guide.view.panel;
  check("a tap on it is ignored", !guide.hitTest(p.x + 2, p.y + 2));
}

// ------------------------------------------------------------------------------------------------
section("stepping the guide allocates nothing");
{
  const guide = new GuideRun({ armed: true });
  const t = tickRecord(new CueBus(), frameFor(party(1)));
  // Warm up, then measure a long stretch with cues flowing the whole time.
  run(guide, 2000, t, {}, 1);
  const before = heapUsed();
  let tick = 3000;
  for (let i = 0; i < 60000; i++) {
    t.cues.beginTick();
    t.cues.emit(CUE.hit, i, i, 1);
    t.cues.emit(CUE.enemyDied, i, i, 0);
    t.runTicks = tick++;
    guide.step(t);
  }
  const grew = heapUsed() - before;
  check("sixty thousand ticks add no measurable heap", grew < 400_000, `${grew} bytes`);
}

// ------------------------------------------------------------------------------------------------
section("every line is an id, and every id has text");
{
  const ids = Object.values(STR);
  check("the string table has as many entries as ids", ids.length === STRING_COUNT, `${ids.length} vs ${STRING_COUNT}`);
  check("no two string ids collide", new Set(ids).size === ids.length);
  check("ids are a dense run from zero", Math.min(...ids) === 0 && Math.max(...ids) === STRING_COUNT - 1);

  let empty = 0;
  let lowercase = 0;
  for (let i = 0; i < STRING_COUNT; i++) {
    const line = EN[i] ?? "";
    if (line.trim().length === 0) empty++;
    if (line !== line.toUpperCase()) lowercase++;
  }
  check("no line is blank", empty === 0, `${empty} blank`);
  check("every line is in the game's voice", lowercase === 0, `${lowercase} not upper case`);

  check("a known id reads back", text(STR.offerYes).length > 0);
  check("an unknown id names itself instead of crashing", text(9999) === "?9999?");
  check("a negative id does the same", text(-1) === "?-1?");

  let grewEnough = true;
  let accented = false;
  for (let i = 0; i < STRING_COUNT; i++) {
    const line = EN[i] ?? "";
    const p = pseudo(line);
    if (p.length < Math.ceil(line.length * PSEUDO_GROWTH)) grewEnough = false;
    if (p !== line) accented = true;
  }
  check("pseudo-localisation grows every line", grewEnough);
  check("and marks it as untranslated", accented);
  check("the whole table can be pseudo-localised", pseudoTable().length === STRING_COUNT);
  check("pseudo-localising twice grows it again", pseudo(pseudo("HELLO")).length > pseudo("HELLO").length);
}

// ------------------------------------------------------------------------------------------------
section("the prompt catalogue is consistent");
{
  const ids = Object.values(PROMPT);
  check("no two prompt ids collide", new Set(ids).size === ids.length);
  check("the catalogue has one entry per id", PROMPT_COUNT === ids.length);

  let ordered = true;
  let linesValid = true;
  let prioritiesSane = true;
  let holdsSane = true;
  const lines = new Set<number>();
  for (let i = 0; i < PROMPTS.length; i++) {
    const def = PROMPTS[i];
    if (!def) continue;
    if (def.id !== i) ordered = false;
    if (def.line < 0 || def.line >= STRING_COUNT) linesValid = false;
    if (def.priority < 1 || def.priority > 3) prioritiesSane = false;
    if (def.hold < HOLD_SHORT) holdsSane = false;
    lines.add(def.line);
  }
  check("the catalogue is in id order", ordered);
  check("every prompt's line is a real string id", linesValid);
  check("no two prompts share a line", lines.size === PROMPTS.length);
  check("every priority is an explanation, a warning or a now", prioritiesSane);
  check("nothing is on screen for less than the short hold", holdsSane);

  const coop = PROMPTS.filter((d) => d.coopOnly).map((d) => d.id);
  check("exactly the teammate prompts are co-op only", coop.length === 2, `${coop.length}`);
  check("and they are the two about other players", coop.includes(PROMPT.teammateDown) && coop.includes(PROMPT.teammateUp));
}

// ------------------------------------------------------------------------------------------------
section("the reference page");
{
  const icons = Object.values(REF_ICON);
  check("no two icons collide", new Set(icons).size === icons.length);
  check("every row has an icon, a title and a body", REFERENCE_ROWS.every((r) => r.icon >= 0 && r.title >= 0 && r.body >= 0));
  check(
    "every row's text is a real string id",
    REFERENCE_ROWS.every((r) => r.title < STRING_COUNT && r.body < STRING_COUNT),
  );
  check("titles and bodies are all different", new Set(REFERENCE_ROWS.map((r) => r.title)).size === REFERENCE_ROWS.length);

  const solo = referenceRowsFor(1);
  const duo = referenceRowsFor(2);
  check("a solo player is not told about reviving", solo.length === REFERENCE_ROWS.length - 1, `${solo.length}`);
  check("a party is", duo.length === REFERENCE_ROWS.length);
  check("the dropped row is the co-op one", solo.every((r) => !r.coopOnly));
  check("four players sees the same as two", referenceRowsFor(4).length === duo.length);
  check("the page is always reachable", referenceAvailable());
}

// ------------------------------------------------------------------------------------------------
section("the offer is made once, and either answer can be changed later");
{
  const save = createSaveData();
  check("a brand-new player is offered the guide", shouldOfferGuide(save));
  check("nothing is armed before they answer", !guideArmedForRun(save.settings));

  markGuideOffered(save);
  check("once asked, never asked again", !shouldOfferGuide(save));
  check("asking alone does not arm it", !save.settings.guideArmed);

  const yes = createSaveData();
  recordOfferAnswer(yes, OFFER_ANSWER.SHOW_ME);
  check("saying yes arms it", yes.settings.guideArmed);
  check("and counts as having been asked", !shouldOfferGuide(yes));

  const no = createSaveData();
  recordOfferAnswer(no, OFFER_ANSWER.GOT_IT);
  check("saying no leaves it off", !no.settings.guideArmed);
  check("but still counts as having been asked", !shouldOfferGuide(no));

  armGuide(no);
  check("Settings can arm it afterwards", no.settings.guideArmed && guideArmedForRun(no.settings));
  disarmGuide(no);
  check("and turn it off again", !no.settings.guideArmed);
  check("turning it off does not un-ask the question", !shouldOfferGuide(no));

  const v = armingView(no);
  check("the Settings page can read all of it", !v.armed && v.everOffered && !v.offerPending);
  const reused = armingView(yes, v);
  check("and can be handed the same object twice", reused === v && v.armed);

  const fresh = armingView(createSaveData());
  check("a new player's view says the offer is still coming", fresh.offerPending && !fresh.everOffered);
}

// ------------------------------------------------------------------------------------------------
section("both facts survive a save round-trip, with no version bump");
{
  const save = createSaveData();
  save.settings.guideOffered = true;
  save.settings.guideArmed = true;
  const bytes = encodeSave(save);
  const back = decodeSave(bytes);
  check("the save still reads clean", back.error === 0, `error ${back.error}`);
  check("offered survived", back.save.settings.guideOffered);
  check("armed survived", back.save.settings.guideArmed);

  const offeredOnly = createSaveData();
  offeredOnly.settings.guideOffered = true;
  const back2 = decodeSave(encodeSave(offeredOnly));
  check("the two facts are stored separately", back2.save.settings.guideOffered && !back2.save.settings.guideArmed);

  const neither = decodeSave(encodeSave(createSaveData()));
  check("a save with neither set reads as neither", !neither.save.settings.guideOffered && !neither.save.settings.guideArmed);

  // The byte these two live in was reserved and written zero before this feature existed, so a save
  // written by an older build of the same version reads them as "never offered, not armed" — the truth.
  const zeroed = createSaveData();
  zeroed.settings.guideOffered = false;
  zeroed.settings.guideArmed = false;
  const backZero = decodeSave(encodeSave(zeroed));
  check("a zero byte means never offered and not armed", !backZero.save.settings.guideOffered);
  check("nothing else in settings was disturbed", backZero.save.settings.chatEnabled === true);
  check("no other setting was moved to make room", backZero.save.settings.hudStickScale === 100);
  check("the save version did not change", backZero.save.version === save.version, `${backZero.save.version}`);
}

// ------------------------------------------------------------------------------------------------
section("armed, disarmed, and armed again inside one run");
{
  // A guide constructed unarmed can never speak, even if the run is eventful.
  const off = new GuideRun({ armed: false, playerCount: 4, localSlot: 2 });
  const t = tickRecord(new CueBus(), frameFor(party(4), stored(), 4));
  run(off, 500, t, {
    3: (c) => c.emit(CUE.playerDowned, 0, 0, 0, 1),
    9: (c) => c.emit(CUE.bossSpawned, 0, 0, 1),
  });
  check("an unarmed guide in a four-player run still says nothing", off.stats.queued === 0);

  // And an armed one in the same run does.
  const on = new GuideRun({ armed: true, playerCount: 4, localSlot: 2 });
  const t2 = tickRecord(new CueBus(), frameFor(party(4), stored(), 4));
  run(on, 500, t2, {
    3: (c) => c.emit(CUE.playerDowned, 0, 0, 0, 1),
    9: (c) => c.emit(CUE.bossSpawned, 0, 0, 1),
  });
  check("an armed one does", on.stats.shown > 0, `${on.stats.shown} shown`);
  check("a guest's prompts are its own business", on.stats.queued >= 2, `${on.stats.queued} queued`);
}

// ------------------------------------------------------------------------------------------------
section("the guide never touches what it reads");
{
  const guide = new GuideRun({ armed: true });
  const input = party(1);
  const frame = frameFor(input);
  const cues = new CueBus();
  const t: GuideTick = { cues, frame, runTicks: 0, moving: true };

  const snapshot = JSON.stringify({
    xpBar: frame.xpBar,
    slotStrip: frame.slotStrip,
    statusStrip: frame.statusStrip,
    stickZone: frame.stickZone,
    health: frame.health,
    gold: frame.gold,
  });

  cues.beginTick();
  cues.emit(CUE.enemyDied, 7, 8, 0);
  cues.emit(CUE.goldCollected, 0, 0, 3);
  const countBefore = cues.count;
  const kindBefore = cues.kind[0];
  t.runTicks = 1;
  guide.step(t);

  check("the cue list is left exactly as it was", cues.count === countBefore && cues.kind[0] === kindBefore);
  check("the HUD frame is left exactly as it was", JSON.stringify({
    xpBar: frame.xpBar,
    slotStrip: frame.slotStrip,
    statusStrip: frame.statusStrip,
    stickZone: frame.stickZone,
    health: frame.health,
    gold: frame.gold,
  }) === snapshot);
  check("and it did read them", guide.stats.queued === 2, `${guide.stats.queued} queued`);
  check("the frame's slot marks are untouched", (frame.slots.type[0] ?? SLOT_EMPTY) === SLOT_EMPTY);
}

// ------------------------------------------------------------------------------------------------
console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} checks`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
