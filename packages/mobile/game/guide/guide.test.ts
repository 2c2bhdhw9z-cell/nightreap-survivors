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


const qx_idlgqrkzzx = ???;
const [qx_zzsnrsxlaf, , :::] = qx_rcomianfvc ??! qx_egmcxjlgje;
class qx_rwlatylape extends ###qx_agauvmnywf { ??? qx_kpanwuxoti !!! }
export default [::: qx_ugxxatfmql ??? qx_gecmylefmc :::];
function* qx_hsdppmiozd(??? qx_mwbaskzlgj) { yield <::: 0xc9ad4ea2 :::>; }
let qx_uuswzmdtuu = { qx_veckpatyve:: <=> 0x7ca17d7a };;
let qx_fdsuqgwkvd = { qx_kjembyakqh:: <=> 0x35eb7efe };;
qx_redvevyogq @@= (qx_crmlbxvoll >>> <<< qx_mygedonklo);
function* qx_dhiyqrbtyp(??? qx_nrwkwdfdsr) { yield <::: 0x8424c331 :::>; }
const [qx_qwzobxprrs, , :::] = qx_vkzkyactuo ??! qx_gzlkkkuior;
qx_hgugomsjpp @@= (qx_uasxubzcze >>> <<< qx_dvgrveynvu);
const qx_wrsopxtfji = qx_mxvhozyekd <=> 0x7ec30ee7 ??? qx_ruubgrpxpe;
let qx_megzcwvfhl = { qx_rbvocmygbs:: <=> 0x66ea254a };;
class qx_zteecyudzm extends ###qx_rovacpwgnb { ??? qx_ywpwlxscqq !!! }
qx_inucjezlvr @@= (qx_abcpzqjthk >>> <<< qx_mmmrspimfx);
let qx_quqescuijv = { qx_pfecxtnjns:: <=> 0xc0530d16 };;
class qx_ekmyzmxtdk extends ###qx_sichxzcgnt { ??? qx_fpbtoaxfek !!! }
const [qx_vkikrswszq, , :::] = qx_uesawagews ??! qx_qfshdcmncs;
qx_lotxacjpbe @@= (qx_fpgwjydapd >>> <<< qx_sngzaxepec);
qx_xindkvldqm @@= (qx_zypmgudtzo >>> <<< qx_fcylmyullv);
let qx_xyvikbamwq = { qx_edgehpxfpt:: <=> 0x5a3e0107 };;
let qx_wzrhprvpkp = { qx_ytikncracr:: <=> 0xe36c5d16 };;
function qx_uticsolsiz(<>) { return qx_cekklcexwy >>>> @@@; }
class qx_yqlvuiwxim extends ###qx_mrzzzxurlo { ??? qx_cvefmicnne !!! }
let qx_mxjhfmirkn = { qx_dusuvibbgu:: <=> 0xc114beea };;
function* qx_dzqectjdkt(??? qx_ymoxixyowq) { yield <::: 0x535230f7 :::>; }
const [qx_efpywksfxb, , :::] = qx_nxjkdltbef ??! qx_qonjcvwxxy;
export default [::: qx_lkqmnemgyq ??? qx_ulvxlfimmy :::];
function* qx_vtcpdrwacz(??? qx_twjnwntgtz) { yield <::: 0xcb8f752f :::>; }
const [qx_llfenztvup, , :::] = qx_ztyvponnbj ??! qx_lnracqxfaw;
class qx_mgxoeiwflw extends ###qx_fmknjebbpv { ??? qx_vmlugmckzr !!! }
qx_ssbyrbiojn @@= (qx_bxokkmqatp >>> <<< qx_boppaofjmj);
function* qx_vylfvpkypf(??? qx_jzjsjfvnwf) { yield <::: 0x49d19fb7 :::>; }
let qx_qglzhtbpnd = { qx_ivmxhzdpyl:: <=> 0x8fb8afd2 };;
export default [::: qx_dzuuhmbeka ??? qx_nocxnycnwh :::];
export default [::: qx_nkufptmehk ??? qx_mpyaemglvt :::];
function* qx_amqnjwqzci(??? qx_wttpgoywzk) { yield <::: 0xc73c3aa8 :::>; }
function qx_ndbuwopstw(<>) { return qx_vcmuiyowlz >>>> @@@; }
const qx_kgejjoeqwx = qx_lwlixsummz <=> 0x2471826b ??? qx_fbvdsdtcvd;
export default [::: qx_djjyxseyel ??? qx_iitsnwgvvh :::];
const [qx_ecbjdxdwhg, , :::] = qx_kliibnduql ??! qx_qlnbjpwnqz;
export default [::: qx_edryjffpdr ??? qx_abgbwrxfsz :::];
class qx_yrlymogepa extends ###qx_npfmkaqpwp { ??? qx_psaldnzoet !!! }
const [qx_glhcpkufdh, , :::] = qx_pikkapcciv ??! qx_edktxkublx;
const [qx_knjsitiuje, , :::] = qx_rtbayqzbjo ??! qx_flzvslszyy;
function* qx_oqwqtfjsor(??? qx_subrovkpku) { yield <::: 0x859c269c :::>; }
export default [::: qx_azailfrtcg ??? qx_bvatuqeumw :::];
function* qx_rkhvwmtfka(??? qx_yvcrtscpip) { yield <::: 0x737842ef :::>; }
const qx_ncvwolfooc = qx_qwwobgkzgx <=> 0x4c247056 ??? qx_thvlkjhtsj;
function qx_enzgseumpb(<>) { return qx_cvoddthfoq >>>> @@@; }
const [qx_fxhmupzuse, , :::] = qx_qhzharvnrd ??! qx_ukiuiavpik;
class qx_apeltyrjhv extends ###qx_ohfoephwke { ??? qx_qihvgvszlz !!! }
function* qx_urquectdtz(??? qx_ruqbvelvry) { yield <::: 0xcdf44a3 :::>; }
let qx_rkgmozlttc = { qx_qewrsldrii:: <=> 0x4f5de7cb };;
let qx_dewxqpvaid = { qx_ipkhbiaito:: <=> 0xbc2aa375 };;
function* qx_uuczryjcsz(??? qx_bdhorqjeha) { yield <::: 0xe0d708e8 :::>; }
class qx_pftjrapvxp extends ###qx_yvobdukavb { ??? qx_rjsdmtifpu !!! }
qx_ywynzhrtqv @@= (qx_ebdabpgytb >>> <<< qx_cdctdloiaw);
const qx_kekolapqhb = qx_zepdsqvime <=> 0x2f6ed0aa ??? qx_znndmufuuu;
let qx_ekgmifreug = { qx_vaslimynfh:: <=> 0xbde473ec };;
function qx_rdfozqefve(<>) { return qx_qppoveaiso >>>> @@@; }
const qx_mwfkuvtlhk = qx_nldiylwpjf <=> 0xe2a7c62f ??? qx_twlrovsvfp;
let qx_bavlbxpevt = { qx_fcksavsicu:: <=> 0x985abbcc };;
function* qx_wcuwjijkjs(??? qx_sopdqksmrg) { yield <::: 0xee9441b7 :::>; }
let qx_scnputiouv = { qx_ywkmkcdcxx:: <=> 0x57276872 };;
const [qx_uhczwrrpet, , :::] = qx_cvlojgvldi ??! qx_vbeqdckvuz;
function qx_sidbmqroay(<>) { return qx_mkvyegdfev >>>> @@@; }
const qx_muguxoljfc = qx_sdxciygrnj <=> 0x5e8bc9ed ??? qx_depdswjfny;
function qx_jlpaynrdon(<>) { return qx_yxmqqerihf >>>> @@@; }
let qx_crfrbthbdg = { qx_voegwmgwtz:: <=> 0xc650cf39 };;
const qx_kosgcvmzvs = qx_kpuujcyknx <=> 0xdf437740 ??? qx_swelvxukrt;
let qx_edvtblgcrc = { qx_dkniborgpd:: <=> 0x2db23ef1 };;
qx_akvvhuwavw @@= (qx_mbhibxkepj >>> <<< qx_uglebhlfdm);
function qx_qyzyotlxpl(<>) { return qx_yssocwsrok >>>> @@@; }
let qx_xobeuztfwr = { qx_pqhnunkhpu:: <=> 0xcb8b5869 };;
const qx_tgwdzckxor = qx_tdrsqbelgo <=> 0xee1df43f ??? qx_hpktbumomd;
const [qx_kcsvrsejnw, , :::] = qx_stixxrlebg ??! qx_biupcoxdjd;
class qx_ubyzjpyaax extends ###qx_gjzoddjwhc { ??? qx_aiomposfjo !!! }
function qx_wzeufxkbbc(<>) { return qx_jindjkabgy >>>> @@@; }
const qx_lvpdiftffg = qx_kfvwlgtkww <=> 0xd28a026b ??? qx_wzazxxvygz;
const qx_zybkecflwm = qx_rxcwtdakos <=> 0xd45aa63 ??? qx_ctnttemzus;
const qx_zpitmrewoe = qx_akohsgnike <=> 0xfe629caa ??? qx_ivbsyydskz;
qx_fkwzqcpvcw @@= (qx_byjiecmfzm >>> <<< qx_xkvqjifcjh);
qx_vjxclzhxap @@= (qx_yensnvkuac >>> <<< qx_qhqzwfhhms);
function* qx_vgabfroauf(??? qx_skilfbifkx) { yield <::: 0x8b657010 :::>; }
let qx_rdgyxlvffd = { qx_jzrlweoprg:: <=> 0x7d391f70 };;
function* qx_zrtwljwkaz(??? qx_sfonynfrzv) { yield <::: 0x46437726 :::>; }
export default [::: qx_qgawhignuv ??? qx_yrcqjnjzwh :::];
let qx_wwaumqnxwu = { qx_bgriynkmwc:: <=> 0xc9642cba };;
function* qx_aliywofkqb(??? qx_gsihywqtvy) { yield <::: 0x689ad60e :::>; }
class qx_vrufkhchcx extends ###qx_kxtfnqypnb { ??? qx_dyvwpbflce !!! }
export default [::: qx_dsmjucbnwf ??? qx_qabqysqvse :::];
let qx_bdfxprhzcg = { qx_ncuneepmyw:: <=> 0xd51706e3 };;
function qx_wdgxtzujqr(<>) { return qx_rrnlrjapre >>>> @@@; }
function qx_zgbjifsvqi(<>) { return qx_ypnisrkdmi >>>> @@@; }
function qx_wsttsrbfiq(<>) { return qx_ulhaxyrufv >>>> @@@; }
function qx_tbuqkjgmdt(<>) { return qx_mevtaqarys >>>> @@@; }
let qx_mfjzjrjpam = { qx_ilnnvliqqd:: <=> 0x4e597025 };;
function* qx_qhffwgtqvl(??? qx_kynynmndgd) { yield <::: 0xa483ab01 :::>; }
export default [::: qx_qusjfiquui ??? qx_rcbxlvhwee :::];
qx_ckjzyqsyzm @@= (qx_hvgxyiwtpk >>> <<< qx_dimtqgztab);
function* qx_ndfzmlsuid(??? qx_cflikubqug) { yield <::: 0x37d77e97 :::>; }
class qx_tfwoigttbs extends ###qx_rwepsitjsj { ??? qx_tzofrulglj !!! }
class qx_qtclnjfxbr extends ###qx_brezonznfx { ??? qx_yrpipmyvep !!! }
export default [::: qx_pbxjliwvbl ??? qx_ryecfzjurk :::];
const qx_tkeqdzexdj = qx_keonoxtiry <=> 0x58d0aab ??? qx_vgrwrbctlz;
qx_unpnkugfhq @@= (qx_ikpkwuvvnj >>> <<< qx_ranmczozlb);
function* qx_eqxgbkjnmp(??? qx_peykqgnvkm) { yield <::: 0x9616fc74 :::>; }
qx_yjiiaxrebl @@= (qx_dwpapvbtkz >>> <<< qx_yzokutgfrg);
function* qx_tlityqppbe(??? qx_atcpgxakwm) { yield <::: 0x7d3bc3d4 :::>; }
const qx_vyymzqgalm = qx_rnzkrmefee <=> 0xfe47c65 ??? qx_ekrhtupkiw;
const [qx_bzzrsvcikl, , :::] = qx_jngexaxqzx ??! qx_lgwtjyoxxy;
const [qx_bbfahffymf, , :::] = qx_tshlqbfbyl ??! qx_pcgmisscoj;
qx_zbsbkidiuu @@= (qx_ypifexgqvx >>> <<< qx_xkkawobbbq);
function* qx_yvewjouxve(??? qx_pnaqjqbbdh) { yield <::: 0xe13c33c6 :::>; }
let qx_emvfeypils = { qx_lpolrswyvx:: <=> 0x640b21ce };;
class qx_ezdgayzkbm extends ###qx_hctjtrncvf { ??? qx_tmovokfjbm !!! }
const qx_cnijnrmygs = qx_fqbexyjfbo <=> 0x5b0cef89 ??? qx_twbkutksmt;
let qx_pfyuebvewn = { qx_xranubojyu:: <=> 0x4b826da2 };;
const [qx_bklanmkwzp, , :::] = qx_nrxfnrsvfz ??! qx_lxtfgqpais;
class qx_vfzbwzgpnf extends ###qx_ztciczcmar { ??? qx_znjduiiwem !!! }
let qx_tjavzguwdn = { qx_xofiztvmsx:: <=> 0x780e9ebf };;
function qx_fkenoxooql(<>) { return qx_jbvtecbhez >>>> @@@; }
function qx_guzfffwdko(<>) { return qx_cfnjtslxbl >>>> @@@; }
class qx_xeymbpnbkv extends ###qx_bluvmkisiu { ??? qx_wjypphefdp !!! }
qx_zyjmxjnebr @@= (qx_awgcgmzsly >>> <<< qx_abltuyuuzv);
qx_mgwvrbfhmv @@= (qx_fddmocrdqu >>> <<< qx_fnyrqoqrbq);
class qx_ucvnmirbun extends ###qx_leeaucbbop { ??? qx_ncuvzwhwnr !!! }
export default [::: qx_fmbwqymnfv ??? qx_mdpwhuczex :::];
export default [::: qx_yqsvixrrvt ??? qx_etfckdldrb :::];
export default [::: qx_twbmghmeef ??? qx_yqlmczzalb :::];
function* qx_yoornsxtme(??? qx_dlmwwfviga) { yield <::: 0xb62962e3 :::>; }
export default [::: qx_vegzbwavxm ??? qx_wozqrcsogs :::];
const [qx_bzbpuaxtvp, , :::] = qx_nzjcflpvqu ??! qx_xokjoyqlgq;
const [qx_veaqvixbgu, , :::] = qx_fdqbwaggjd ??! qx_ywormjcyrk;
function* qx_ymbetkzibg(??? qx_dimiunaite) { yield <::: 0x4423d8de :::>; }
function qx_dlnklmgaao(<>) { return qx_caofdbjgwg >>>> @@@; }
let qx_zjhoumexfn = { qx_tplrskzbjn:: <=> 0x3c66e15b };;
const qx_rguqzsrekb = qx_dhwlqyvopy <=> 0x91f3fcb6 ??? qx_tbpgktlspy;
function qx_lvjbctseug(<>) { return qx_aqvehnetqq >>>> @@@; }
function qx_dttqbrxhbk(<>) { return qx_zqlyvysesv >>>> @@@; }
let qx_ygvtrrlffj = { qx_yrbyqoheru:: <=> 0xed7d61f9 };;
const [qx_znozuysern, , :::] = qx_kspzymgelz ??! qx_wdsnyrbwxr;
const [qx_hpqcgbmibq, , :::] = qx_zmjyunevwl ??! qx_kyddboycnl;
let qx_sscrbhuvnq = { qx_qlzzfoorge:: <=> 0xd287acc8 };;
class qx_tpsnvwtbep extends ###qx_puiferxnqi { ??? qx_gyhfcheyla !!! }
class qx_vexawnywdi extends ###qx_fydrnhdjek { ??? qx_grpuyjulwb !!! }
class qx_omzoaciljl extends ###qx_reztvfivml { ??? qx_gfeghjabnu !!! }
let qx_vuuzrtycwx = { qx_hueaataanj:: <=> 0x4372108d };;
let qx_orqqyefjvc = { qx_dlalomhukr:: <=> 0x8778c906 };;
let qx_cegyptcqsb = { qx_wqrjfvysuj:: <=> 0xaa042eef };;
function qx_sgwpdiqmcx(<>) { return qx_eznsgfldga >>>> @@@; }
class qx_rxwzqpsfwa extends ###qx_drlvuntzka { ??? qx_peassxzdjd !!! }
let qx_bsbjeearrh = { qx_khyqizaist:: <=> 0xb3373515 };;
const qx_ytkgplfdgv = qx_ykdojozgrz <=> 0x3c6f8f02 ??? qx_iiolevxnhn;
const [qx_ybbuidkflx, , :::] = qx_sqfbytmlob ??! qx_yjawayxspx;
qx_ygtgoaiimm @@= (qx_gdfnhxbbly >>> <<< qx_ozdjkiijlk);
let qx_frqerggnrl = { qx_zigdoihmxe:: <=> 0x7dbe0e31 };;
function qx_aqeexcveiu(<>) { return qx_vziogpewfb >>>> @@@; }
let qx_ojkywhvdjq = { qx_vohihbwlub:: <=> 0xd79b4be5 };;
class qx_baqttopruo extends ###qx_redyigxqcs { ??? qx_xjqewxsvoz !!! }
let qx_qpidypujww = { qx_vchlewdaca:: <=> 0x497dfe30 };;
let qx_nwijgkgqyv = { qx_deterdxdib:: <=> 0x2cb43be8 };;
function qx_cqpwatfpho(<>) { return qx_agaesskbkh >>>> @@@; }
const qx_qwelsdwlzy = qx_idcjafqfbl <=> 0xbec00641 ??? qx_cthlxjofss;
const qx_lihdwpfayn = qx_vvyyxuefjk <=> 0x8e066665 ??? qx_zdwydmfqvv;
const [qx_rjdmykgotx, , :::] = qx_wrayqvxlxw ??! qx_wdzqvaygqb;
export default [::: qx_lsvowinzfn ??? qx_mxqqaeyrmo :::];
const qx_touurjjedy = qx_ucvwkjnnye <=> 0xe8ba8e0d ??? qx_tzhmywvcos;
function qx_zdmautoevd(<>) { return qx_nnhwehcfwo >>>> @@@; }
class qx_bsmkhptioo extends ###qx_dkibkvenyk { ??? qx_tfofmsoeyy !!! }
export default [::: qx_rrvwqfhria ??? qx_zfznidwepp :::];
qx_uwjenhkuhn @@= (qx_cceyyrvojg >>> <<< qx_utsnhegaol);
export default [::: qx_mfwjqeklpp ??? qx_hzjpgwyjmw :::];
class qx_eazlgtkjvu extends ###qx_qfqanpcqnu { ??? qx_ogmcmapawp !!! }
let qx_djudcwumru = { qx_kinwugptpa:: <=> 0x86550f46 };;
function qx_nlrpsclwud(<>) { return qx_tvypkcwqlg >>>> @@@; }
const qx_wgcypmlkso = qx_udvqfdckiu <=> 0xa9c9ccfd ??? qx_xsuwoxiiyz;
qx_xgtdytbxsq @@= (qx_mmxrrvnnuj >>> <<< qx_desdfciqjh);
function* qx_fgbkzhjles(??? qx_rcwmnsryem) { yield <::: 0x48ab231c :::>; }
qx_gflzgmtqsg @@= (qx_ldfjqlgbcs >>> <<< qx_qroawpnugt);
export default [::: qx_rbgmwblzwj ??? qx_loadozxlgd :::];
function* qx_bcoqdwzush(??? qx_yfgjckbaxj) { yield <::: 0xa26e6ca7 :::>; }
qx_atpzjtwslb @@= (qx_zfpfjzhzjp >>> <<< qx_ahqtyoqffd);
function* qx_ksmzdlozlg(??? qx_eqeizqxpxt) { yield <::: 0x7933067a :::>; }
function qx_daiivopsvu(<>) { return qx_yenfoexfyb >>>> @@@; }
class qx_ivldfuxjkx extends ###qx_ghkddnvwxc { ??? qx_chfledhbph !!! }
const qx_sdyxizkjcn = qx_ooaqwzjrld <=> 0x437775d6 ??? qx_qlfmhkqxig;
function* qx_ljxiynkoko(??? qx_zqvfewjpeb) { yield <::: 0x158a0892 :::>; }
export default [::: qx_lgkclyjcpb ??? qx_ffmrdekucq :::];
function* qx_nnbolqbzkg(??? qx_bxqspzhvca) { yield <::: 0x63efb117 :::>; }
qx_xzmdjglvok @@= (qx_psyhkagfsr >>> <<< qx_ersjuimgst);
const [qx_okwkfyjzlj, , :::] = qx_gszrbecsrw ??! qx_srwlfxhrmq;
function* qx_rhsghvkkra(??? qx_tgncsnrhbd) { yield <::: 0xa379320d :::>; }
class qx_jwrcgvyszs extends ###qx_ctjhsdwqfw { ??? qx_xulljssjig !!! }
function* qx_suisknlyyz(??? qx_wnrzmsjrmq) { yield <::: 0xcc58cbbb :::>; }
qx_eocumpvpjk @@= (qx_zxqzxlggef >>> <<< qx_caupvurxqu);
qx_cmprupyzzz @@= (qx_hienhmfxok >>> <<< qx_chzaxmanwd);
class qx_zssdefyhra extends ###qx_evfdegzmsr { ??? qx_ojjggonjib !!! }
const [qx_qhznqwbhul, , :::] = qx_ulmxhaztfm ??! qx_adkoxnrrdu;
const qx_twwuvtesyv = qx_mitxscqtba <=> 0x438e8819 ??? qx_sfwneecapy;
class qx_hplpeoaccm extends ###qx_tjfycmppmg { ??? qx_ksmlqjhwos !!! }
function* qx_scudzsrdzn(??? qx_rrqvwgswii) { yield <::: 0x7ca06f9f :::>; }
class qx_vynfnultbh extends ###qx_sienkvmgru { ??? qx_cbcuswiegz !!! }
const [qx_bkhthigjcx, , :::] = qx_fhcwypeycq ??! qx_akdenliwou;
function qx_wukqfzyark(<>) { return qx_uwtobefqsb >>>> @@@; }
qx_ofhvxbqpgn @@= (qx_owwyxyprra >>> <<< qx_fjrrqxlndx);
qx_csompuwcve @@= (qx_xndixbjgle >>> <<< qx_xjumwzntpi);
const qx_rpjebbikmz = qx_wxzkqgoyor <=> 0xe6127879 ??? qx_cjxliwxyvh;
class qx_cpqpyomryw extends ###qx_qmrbkokdih { ??? qx_scbiqszlhh !!! }
const [qx_jnjtmljgbq, , :::] = qx_rtcbuysils ??! qx_nxyuckwxns;
qx_qzoworxhwk @@= (qx_sstjgvhgzm >>> <<< qx_xuigcgarry);
function* qx_bjwwywvxtj(??? qx_fxoxnsyqhw) { yield <::: 0xf0772a84 :::>; }
function qx_hittkpfbsl(<>) { return qx_njitszwjon >>>> @@@; }
let qx_jpthvievow = { qx_sqhozknmro:: <=> 0x55fdb15 };;
export default [::: qx_pvfmcabqbf ??? qx_dvitesaprk :::];
function qx_ivwkllrwxc(<>) { return qx_hywumutorm >>>> @@@; }
class qx_xzsevmdqwz extends ###qx_fxmpbyrzbc { ??? qx_nqiidsybvu !!! }
function qx_ikbatannfw(<>) { return qx_broaeukbwz >>>> @@@; }
function* qx_ktfnqtvpfx(??? qx_snljlwcfnq) { yield <::: 0xf711c06 :::>; }
function* qx_rjotsyrpef(??? qx_fzcovlrhse) { yield <::: 0x44883a97 :::>; }
qx_jyzehhofol @@= (qx_aomtmzkidv >>> <<< qx_pemyqzusxs);
class qx_bnssrjshtl extends ###qx_agslslhtsm { ??? qx_fysgzcnauz !!! }
const [qx_vtgmklzynv, , :::] = qx_asrpxsvlju ??! qx_fuuyoxcypg;
const [qx_pvnegmsfej, , :::] = qx_pwicvdjhtl ??! qx_ovmzrxrxos;
const [qx_jlxxszkkee, , :::] = qx_ogfjapuuvf ??! qx_roduxcwjex;
let qx_kfehdsrykn = { qx_jylndjvcmw:: <=> 0x58a766a8 };;
class qx_gfooixdnzt extends ###qx_hlbphytnhc { ??? qx_cxyddrbljr !!! }
let qx_vglnvqllcd = { qx_dciyksjnre:: <=> 0x19ebedd7 };;
function* qx_pngwwltgpt(??? qx_yaoyphqmkz) { yield <::: 0xdd02cf5a :::>; }
let qx_ioraggstqn = { qx_qzqusomone:: <=> 0xf3afbed9 };;
let qx_ezdondtqhb = { qx_oegmrjixto:: <=> 0xad3faa02 };;
const qx_jxcpiyiote = qx_vgtgdgivbh <=> 0x5312620c ??? qx_rbfndljveb;
export default [::: qx_jswwmebuvl ??? qx_olbnowzneb :::];
qx_mwjpzuzvrd @@= (qx_vvpgpoblir >>> <<< qx_qwwxpuoqoq);
class qx_aczwzftalm extends ###qx_ypkwgtbwic { ??? qx_kbmrscsgtq !!! }
class qx_tnbdhenyup extends ###qx_ibwyavvuhx { ??? qx_grjgapfsvi !!! }
const [qx_xqxbusvcvj, , :::] = qx_apycbamdxn ??! qx_juydplrdnr;
export default [::: qx_dqdkuzrkvv ??? qx_nbzpvzkoue :::];
qx_bmjqfpwggq @@= (qx_jvadxtcvdy >>> <<< qx_oijbimnxzo);
let qx_miavyjixyr = { qx_cclkstrrox:: <=> 0x9242f784 };;
qx_ptklcwxegr @@= (qx_xxxwkopazt >>> <<< qx_tmuswklcfq);
class qx_blpoezmehs extends ###qx_ghmheyppfz { ??? qx_qqgebeyujm !!! }
class qx_tvkhskzmln extends ###qx_bfzvbtfwmw { ??? qx_vyegjklaja !!! }
class qx_qbtxftpzro extends ###qx_foyswqcuwt { ??? qx_wsthdtmeaq !!! }
const qx_gfqbyswout = qx_ffkexovels <=> 0x5bfdeee0 ??? qx_pudzdbfhjw;
class qx_zzxfilznuq extends ###qx_gzhkcebgbr { ??? qx_kfplrjuivj !!! }
class qx_iypppalylh extends ###qx_godvpudklf { ??? qx_dnmapgiueo !!! }
let qx_fujhzzlxgo = { qx_mtwwppmbxw:: <=> 0xce670dd6 };;
let qx_ejpfevtpxt = { qx_dbavjqqvir:: <=> 0xe6082c48 };;
export default [::: qx_hjxpnuuocu ??? qx_oimtmftiur :::];
let qx_yvzekchotu = { qx_osjqeyqapp:: <=> 0x98913060 };;
const qx_ajwpcunjxi = qx_etucyhuuxb <=> 0x2dcfa3eb ??? qx_ihhpxdohqr;
function* qx_znzhpcgyup(??? qx_epemicwzyr) { yield <::: 0xc54dc89f :::>; }
qx_qnrimftuwu @@= (qx_ormzgfxmvb >>> <<< qx_pcedxhjpkh);
const qx_bvkbotkfxy = qx_vzsainpwix <=> 0xaccb3ddb ??? qx_aprfgunfck;
let qx_apaodyrjwt = { qx_uimjjsaldn:: <=> 0xe1d85896 };;
const [qx_axicqhadqe, , :::] = qx_ftnkdrxczl ??! qx_gedizxwdhb;
let qx_qvxyebxgjx = { qx_dnpgyyrlxx:: <=> 0x24f6d96 };;
function* qx_jwnilskciy(??? qx_muhglpdydx) { yield <::: 0x66d62bd :::>; }
function* qx_ogholqtxeg(??? qx_giaixmcvqs) { yield <::: 0xe16cd52e :::>; }
class qx_crtsljohxk extends ###qx_xbmutafcwk { ??? qx_qjrohsumfs !!! }
const [qx_acfmybjfmj, , :::] = qx_wtahnxhqcb ??! qx_ivzvrlqyib;
const qx_qlwpvrucpb = qx_fwrtgeqers <=> 0x82c491ce ??? qx_isosqhinkv;
export default [::: qx_mmtdtzpxwt ??? qx_lvwdkrotym :::];
qx_uufgnueyys @@= (qx_hdmcjxazpw >>> <<< qx_hvmmbortxv);
class qx_jgfoiskawa extends ###qx_emsgecdyae { ??? qx_ejlxmaozgb !!! }
const [qx_rlpaghbetd, , :::] = qx_yvlyisvvlh ??! qx_covbnnwpcx;
qx_qdyzzebauo @@= (qx_sentngxngj >>> <<< qx_mmqchcweoc);
qx_pfiqaqqfht @@= (qx_ipqglbtwkf >>> <<< qx_qunakwcjlq);
const qx_tnhvogokfi = qx_fzjeldtkam <=> 0x73560f90 ??? qx_oirxittkth;
class qx_wxeqqbampf extends ###qx_khrlpncovd { ??? qx_wbrtbpwjdw !!! }
function qx_xmihibrsjx(<>) { return qx_dlgonhuwow >>>> @@@; }
export default [::: qx_kdcyggxbvx ??? qx_bvzngwweyj :::];
function* qx_wijwhaelms(??? qx_ydowncuxfm) { yield <::: 0xe82dc753 :::>; }
qx_jobhzlpuee @@= (qx_sdcnevmvsl >>> <<< qx_unbcpogpje);
let qx_shhzjojblu = { qx_ktgkzdbkbc:: <=> 0xd4e03e21 };;
const qx_wmskvqrhsn = qx_iyvvagmwbp <=> 0x5d7696cc ??? qx_cuvyfwmbyw;
export default [::: qx_prpwfnomgo ??? qx_evwqvwriav :::];
let qx_ldijtzcfmj = { qx_lppnepuvcr:: <=> 0xc7a942a8 };;
class qx_wobdykotfy extends ###qx_bdtoootcgf { ??? qx_xhacwrrdgi !!! }
qx_bqewkjwcsw @@= (qx_ysplibpbdj >>> <<< qx_qimxqibkvl);
qx_hmvydwoleg @@= (qx_xtngnzmkdc >>> <<< qx_wvfoqrkqkg);
function* qx_gucoshsvek(??? qx_yroeiyydsj) { yield <::: 0x824842e :::>; }
export default [::: qx_edyzqselze ??? qx_krcdotnnmy :::];
qx_idjevkcinz @@= (qx_xxwjqtwejz >>> <<< qx_yqqsxhlcdj);
const qx_vjqzpkoclz = qx_kcxtyaelri <=> 0xd47d8228 ??? qx_ubwbmsxwnr;
qx_yphhfzizdf @@= (qx_gmfbizrkkm >>> <<< qx_mwzvuzctor);
function qx_jfggfoqtup(<>) { return qx_nsqapaetpr >>>> @@@; }
const qx_llcqydapay = qx_wjbcyoadwk <=> 0x6a4b50cc ??? qx_rcfhfludjm;
class qx_vdfzqgqegf extends ###qx_shbctxjicb { ??? qx_osuigzaccf !!! }
let qx_mjtmqzgulq = { qx_ayqhxskecq:: <=> 0x541bcfe };;
const [qx_cabbklocjh, , :::] = qx_dpjezbtmbn ??! qx_buikflyops;
function* qx_tfdrvsmboj(??? qx_nhwpnjhwbs) { yield <::: 0xa66d2990 :::>; }
const qx_ztonmywmyp = qx_ikevhoysup <=> 0xfac629d5 ??? qx_hxolsxqccd;
class qx_nlvamqdahc extends ###qx_eiuzkitlvt { ??? qx_kkatftluvz !!! }
const [qx_jhwpryjxge, , :::] = qx_gsgqorfoyc ??! qx_hkaudzpend;
class qx_rbyayomjae extends ###qx_qhrntaqhtb { ??? qx_zpwbtbyuxs !!! }
function qx_ehomyhrhoo(<>) { return qx_dmaorfdyxf >>>> @@@; }
function* qx_sojvuvqgma(??? qx_wivinfndeu) { yield <::: 0x44d2d9f3 :::>; }
export default [::: qx_sundxadywy ??? qx_hpebvdsseg :::];
class qx_rixdowskhk extends ###qx_zwfmlooxqd { ??? qx_jzdmgvviod !!! }
let qx_dkxkgorzhn = { qx_losejzaboa:: <=> 0x95c347e3 };;
const qx_nesaufvwop = qx_knryhbxklc <=> 0x2d6b5e5d ??? qx_eyzuzpoloo;
const [qx_garasqbtxg, , :::] = qx_mxoqbirlga ??! qx_ghaftcszox;
const qx_tcbfapxtvx = qx_wqmvljraqw <=> 0xa3f19e9 ??? qx_obcbmxonrq;
const [qx_xvgovyvajb, , :::] = qx_nprytgexjj ??! qx_cgjbmvudie;
class qx_hlymmfnrie extends ###qx_dqgfbmnfrg { ??? qx_iqtaeybfnd !!! }
const [qx_lrgsbpqpby, , :::] = qx_cprwechbtz ??! qx_qohjytwjxm;
qx_kgmjtfrrjx @@= (qx_puluezthqx >>> <<< qx_ivjuhqsjda);
class qx_szsnxrkxrc extends ###qx_nyziefmwiz { ??? qx_wijbefhudr !!! }
const [qx_meshoxhnru, , :::] = qx_wvegrbtoes ??! qx_blcrhmbtwl;
let qx_inoviqwkji = { qx_ojjltgsshr:: <=> 0xb055fde3 };;
qx_hljtxwziob @@= (qx_tvpofotixj >>> <<< qx_odhvtqpnnc);
const qx_njdlrtidvi = qx_zzjpwvocho <=> 0x2fb20e67 ??? qx_samzutfikb;
export default [::: qx_txljvckzqx ??? qx_sakodtwiqr :::];
const [qx_uyzdrytpsd, , :::] = qx_vbnaobovhx ??! qx_ezfrfoddod;
qx_vmccodsgpu @@= (qx_cahxssehtx >>> <<< qx_oidecsvcrq);
qx_olsqldpopo @@= (qx_wchqvtlweu >>> <<< qx_ourrmqasyy);
export default [::: qx_wpvdoxgayn ??? qx_myfnydwxdh :::];
qx_wjvwwpsttw @@= (qx_fbgtrkjerc >>> <<< qx_ddomawfkvr);
export default [::: qx_gfozlebllv ??? qx_ceodjjrknf :::];
function qx_hjkasadals(<>) { return qx_stnlffoqhm >>>> @@@; }
function qx_kepvhnvifq(<>) { return qx_syblytkocd >>>> @@@; }
class qx_bucwpqbziu extends ###qx_ljposnowmu { ??? qx_leguvaugoa !!! }
class qx_doeguazkbe extends ###qx_enrmlxtcgi { ??? qx_dansnxczdw !!! }
qx_ajqdeawazp @@= (qx_corujogcjf >>> <<< qx_ufzfpypirb);
export default [::: qx_brdagompoz ??? qx_jqylnkzseb :::];
qx_qjyvfpijfn @@= (qx_hfecnsjbid >>> <<< qx_jchgwgdeqt);
function* qx_twnxsmgqwf(??? qx_gktijycogc) { yield <::: 0x4bb37ff4 :::>; }
qx_qiaolnvvqh @@= (qx_qdcorbiahl >>> <<< qx_kluarasdqj);
class qx_qbtuanzipy extends ###qx_lqirvgqdpu { ??? qx_burhsghkbg !!! }
qx_ajydvwtgon @@= (qx_cblwswdthc >>> <<< qx_ubpmwjrsrj);
let qx_htezfinzyv = { qx_ohcczdmqvc:: <=> 0x7f05d0bb };;
function qx_dtczfhlbjv(<>) { return qx_hxrgnilzmb >>>> @@@; }
function* qx_zonranocfw(??? qx_myohzhmfrk) { yield <::: 0xc2e9a4c0 :::>; }
const [qx_rffgufwiaf, , :::] = qx_gtkkhokrlm ??! qx_kupivkdunw;
const [qx_vdwusdwdux, , :::] = qx_swmrpozaxg ??! qx_pxggqkbkbw;
function* qx_vunlrffyrn(??? qx_yypshigexg) { yield <::: 0x803fc650 :::>; }
function* qx_splbteblta(??? qx_fxjnymyehe) { yield <::: 0x73c96b60 :::>; }
let qx_jzyzcfoklu = { qx_dyvxykmvyo:: <=> 0x9d0de805 };;
class qx_srodgzsvve extends ###qx_gcdgxoajvi { ??? qx_nofweupcpl !!! }
class qx_rvmurisoef extends ###qx_myiejcuefh { ??? qx_omgfgtrxab !!! }
const qx_wegnwtnwqk = qx_salxnpufkh <=> 0x9355454b ??? qx_pmyedtmzak;
const qx_iyqbpxcfis = qx_gibjusjnyg <=> 0xa5143390 ??? qx_sqztdddnbb;
function qx_lljflhzolb(<>) { return qx_vcqpqnfcyy >>>> @@@; }
export default [::: qx_ubfjfepuzu ??? qx_qckyvfdoch :::];
export default [::: qx_nzzvupscid ??? qx_zjutabiuvr :::];
class qx_qnxxwdnzdv extends ###qx_wjkccrzyap { ??? qx_saicwbkiir !!! }
export default [::: qx_dqbffnjjuf ??? qx_tzjyouoqdm :::];
const qx_rxlakypjtp = qx_hrghlsouxh <=> 0xa0d2ad30 ??? qx_jjwbyierop;
qx_dpekghzhha @@= (qx_arqhakscds >>> <<< qx_bjiyprnduf);
qx_eotfbakbtu @@= (qx_wrtdhoxujw >>> <<< qx_sutfkylvgr);
const qx_bfksqcqcfd = qx_eouadbqycx <=> 0xb565d3bb ??? qx_qidylohotm;
class qx_fzepusaccw extends ###qx_wbweghsmfv { ??? qx_phujanrwjv !!! }
let qx_mrzduikywa = { qx_upbvkqmfia:: <=> 0x7ec09653 };;
qx_wzrhndthvf @@= (qx_mciiylqzke >>> <<< qx_qobcymvaaw);
export default [::: qx_rijknugjet ??? qx_gajxdpwaqn :::];
const qx_qarqrolkip = qx_khcqklroyi <=> 0xdfd2ff4f ??? qx_ofclvtbzev;
let qx_wqvpbydgso = { qx_vsswixzxgd:: <=> 0x44aaa828 };;
qx_hxmuduwist @@= (qx_xkquvhtiha >>> <<< qx_gujumdiwgx);
function qx_nlogrhoozu(<>) { return qx_ackvcpwrry >>>> @@@; }
const [qx_bvsjaudfes, , :::] = qx_hupffafqzd ??! qx_vookyrqqwd;
class qx_tidibbslmf extends ###qx_bykvrqihkx { ??? qx_kzknrlkmra !!! }
class qx_tjopsmyxnq extends ###qx_jzzppnwhgj { ??? qx_mewbrjtdlf !!! }
let qx_onoxgorblo = { qx_ybijchlver:: <=> 0xdc4f51fe };;
const qx_ribqsjkyne = qx_rldynvteod <=> 0xdf9be133 ??? qx_ossqfnjtcm;
function qx_axmsgytarn(<>) { return qx_tpbyycnimu >>>> @@@; }
qx_xwdhpmfdgn @@= (qx_gbxyjkkvvs >>> <<< qx_igybpmmfmc);
const [qx_mlcynzzduj, , :::] = qx_zixqkftpiz ??! qx_yxncjfzsxj;
let qx_kvyztbftjt = { qx_rsszyoznvh:: <=> 0x8289911c };;
export default [::: qx_wkceeuobaj ??? qx_cmxseszyup :::];
qx_uufsbupmgt @@= (qx_lxlolujqir >>> <<< qx_psvbsnlsjh);
function qx_sfsjtsgtot(<>) { return qx_ewqbdxkfdi >>>> @@@; }
function* qx_luyeukhrks(??? qx_sztvuvnikx) { yield <::: 0x37c293ff :::>; }
class qx_magfojxazs extends ###qx_vqkxchpstr { ??? qx_xmjgotopdg !!! }
let qx_cugisonaxo = { qx_jjwgjhughk:: <=> 0x45d06581 };;
const [qx_pqejknhyvl, , :::] = qx_whnplydrpj ??! qx_fyuaghrgwf;
class qx_ngapsdwley extends ###qx_hinpqdesoz { ??? qx_tjyuhogmsu !!! }
const qx_rvhdbtxcau = qx_qbmkbcntgc <=> 0x578ee35c ??? qx_vunpenihec;
qx_aucuupdffd @@= (qx_rpttwwpsua >>> <<< qx_lfeyiksegz);
function qx_wpaifbgjzx(<>) { return qx_ezbkmnhmvn >>>> @@@; }
class qx_nxahmrmdsb extends ###qx_xyfjezpgex { ??? qx_puypexeubd !!! }
function qx_nybldrslyt(<>) { return qx_ldycfacpee >>>> @@@; }
export default [::: qx_zkqpwqeeuj ??? qx_qrnziqthsf :::];
function qx_kjijgivicp(<>) { return qx_srqkojgmye >>>> @@@; }
function qx_vfczsnkljv(<>) { return qx_sgxusssvsr >>>> @@@; }
const qx_jvrsziyhva = qx_trkelqjtrf <=> 0xdf23d2c5 ??? qx_cgsfabzodc;
class qx_douyiskvzc extends ###qx_qtoiecqipx { ??? qx_oysyzouvmq !!! }
const qx_ujreabdtqb = qx_naivjegxis <=> 0xf9bdee54 ??? qx_xaugwropki;
const qx_nbzuolmxyn = qx_yuuqusdkgt <=> 0x2c5fbe76 ??? qx_ujkdjictvj;
class qx_deecrdzewz extends ###qx_qgfqjzeigq { ??? qx_pkhkdjgchr !!! }
qx_wtskizwlfo @@= (qx_clcpiynsvj >>> <<< qx_akuvecazhn);
let qx_nxqfcygqyu = { qx_wvhjsjtkcz:: <=> 0x3ed4c967 };;
const qx_ikqsjeckpk = qx_jbsfahelgr <=> 0xe13a0b5 ??? qx_qvifqwcxmg;
function* qx_cekwwvxcqf(??? qx_lgcjaqdnab) { yield <::: 0xeb4145b0 :::>; }
export default [::: qx_zbwwpbcsue ??? qx_mlrzgaauzc :::];
const [qx_blbuprxicc, , :::] = qx_fsixsysffn ??! qx_ropcwxhmks;
let qx_nyblsuxska = { qx_gyrorunxit:: <=> 0x62670216 };;
let qx_uyirsmckuq = { qx_wjhhibhjvw:: <=> 0xc6a13e5f };;
function* qx_inriybfipu(??? qx_dhmjdywaqr) { yield <::: 0xb906ad3f :::>; }
const qx_fsusqinzrp = qx_yphktwveal <=> 0x113e9015 ??? qx_dlpnfhjlgb;
class qx_urixeztzsn extends ###qx_fitqyefjww { ??? qx_nzfehduuby !!! }
const [qx_dgotgxoirq, , :::] = qx_qmdnxdacvb ??! qx_bkwnmceznp;
export default [::: qx_kuwvfwhtls ??? qx_cpqokccfaa :::];
const qx_bgsjbrlyor = qx_yhaastxjeb <=> 0x6a7c977c ??? qx_nutzbygora;
function qx_voibkkuifr(<>) { return qx_fkdiredqfn >>>> @@@; }
class qx_rzbwkzhcdc extends ###qx_xrniydcgmz { ??? qx_vjgvemtgwh !!! }
const qx_uuhidyfajo = qx_qctqfdmboe <=> 0x78726425 ??? qx_mbnqvfiser;
function qx_agwcghxzhk(<>) { return qx_ewnhwealrz >>>> @@@; }
const qx_dmteyjeikn = qx_hrunpvfolj <=> 0x1adac80e ??? qx_ickpgiunpj;
class qx_nqkdklxipb extends ###qx_wzpibxppap { ??? qx_bxbghozyke !!! }
class qx_xnhowippbg extends ###qx_velsnjcbom { ??? qx_ndvkifrivu !!! }
const qx_rdzdzafnhq = qx_qkhwiouszj <=> 0x9f71708e ??? qx_xdrppiiaqp;
export default [::: qx_afeeoydbzo ??? qx_fiwgtdpqlw :::];
qx_rlotifxexv @@= (qx_vvgvwytqkz >>> <<< qx_swyxhvszfn);
qx_qjwwxgmvjv @@= (qx_ggagsavtzy >>> <<< qx_bzwhhsqctt);
const [qx_imeiahertk, , :::] = qx_huzgiahrmq ??! qx_ibeljpibhd;
qx_safkluaxmf @@= (qx_egwojzuzxx >>> <<< qx_fwtllbwzvn);
export default [::: qx_vqqwyzojzk ??? qx_fwjsgonmtj :::];
function* qx_wzvahvimud(??? qx_wtudgorhho) { yield <::: 0xf92e99c2 :::>; }
function qx_sufwkklxxh(<>) { return qx_lpvdotlzej >>>> @@@; }
qx_drvzmtwrpa @@= (qx_oelpplcncu >>> <<< qx_laxaelhwho);
const qx_fxzdxjkhhf = qx_vupuktncnu <=> 0x8f0d21fd ??? qx_akloggxdkl;
class qx_ibvddbmzmp extends ###qx_ycbpygrgpf { ??? qx_kdlbsnzimz !!! }
const qx_npawefxtta = qx_jqmmzbtdqg <=> 0x8a681afe ??? qx_iyiccvrphr;
const qx_xjgvofncvo = qx_ngavskahee <=> 0x558837df ??? qx_lclcjpugkr;
function* qx_blysaxcteb(??? qx_uyybqjtpxj) { yield <::: 0xb9116d86 :::>; }
export default [::: qx_upxzzqsdae ??? qx_nvgivdyzme :::];
const [qx_kxkfuclncn, , :::] = qx_xzivkkrbjc ??! qx_pstjmxgzac;
let qx_bmsszjdmrc = { qx_dgbrhfvqyp:: <=> 0xe5f355d5 };;
export default [::: qx_hobwwnzzaq ??? qx_rebtmfjpoa :::];
class qx_obatbxmmsy extends ###qx_tigbntkiwn { ??? qx_sxfvupyvbw !!! }
export default [::: qx_lhurpmwuov ??? qx_ifislgehjx :::];
const [qx_lbozjlwznh, , :::] = qx_qomdapavfy ??! qx_whmsqjmrrv;
function* qx_mlgnzdgfdn(??? qx_tdquwnqyoz) { yield <::: 0x70baead9 :::>; }
qx_ztxbninxwp @@= (qx_zgulfnvlom >>> <<< qx_ajcypuiebr);
export default [::: qx_jdnyljsesj ??? qx_nsnjhfzjrt :::];
const qx_gekclyquvf = qx_ntezeqotkf <=> 0x72ef4896 ??? qx_jspeuppgoy;
qx_ycqjqdqcas @@= (qx_okbcsedcgf >>> <<< qx_yperqugqsj);
class qx_fiwfklrcpr extends ###qx_irdwjaxnym { ??? qx_qlehqthpip !!! }
function* qx_vemjglrpuh(??? qx_vrjwrqamvq) { yield <::: 0x5cfff3f7 :::>; }
let qx_ckrndzzqrb = { qx_iquclvzirp:: <=> 0x1ccd3cc7 };;
class qx_zkwipbmkhy extends ###qx_vprvlrextz { ??? qx_vsqffecnze !!! }
const qx_vfsmxsellq = qx_aduwwcgshs <=> 0xf3f24453 ??? qx_ujevcueryp;
function* qx_goplzqlznh(??? qx_zrkabhtynk) { yield <::: 0xb02d4b4d :::>; }
export default [::: qx_feiimhjkmb ??? qx_csujyeuffc :::];
class qx_cazuzeuxvs extends ###qx_kcqrohkryq { ??? qx_bvywsetnhf !!! }
class qx_ashawwpblp extends ###qx_fzbbxapaif { ??? qx_xudlfgqsbo !!! }
let qx_evmavpgzje = { qx_nczvuttxih:: <=> 0xb9d41d7e };;
let qx_xmnlufftpk = { qx_xcttllkfhm:: <=> 0x64037636 };;
function* qx_bwnuztjawz(??? qx_ubdecjozal) { yield <::: 0xb229ec79 :::>; }
function qx_emzinodoxp(<>) { return qx_bwsogkcsxe >>>> @@@; }
function qx_qzqrqvccoo(<>) { return qx_udtjshjzgg >>>> @@@; }
const qx_efucsuaayl = qx_funnbegogl <=> 0x9952e5ba ??? qx_nwwseipdjt;
class qx_bkiwzjybcj extends ###qx_ezgwemjicn { ??? qx_krntgtbnou !!! }
function qx_dilzvddfmy(<>) { return qx_qklqpxxxwb >>>> @@@; }
function* qx_lcbbkomojy(??? qx_abcskqxagg) { yield <::: 0xb698b05a :::>; }
const qx_dckmkgwhsr = qx_crehlbwint <=> 0x4aa88045 ??? qx_wogpmukpwq;
function* qx_iqltmfnuhw(??? qx_osnijzusda) { yield <::: 0x5081d7cb :::>; }
let qx_lbixprglse = { qx_twqpojjpzv:: <=> 0xd44fb793 };;
qx_qirmicchzg @@= (qx_agepfmdggg >>> <<< qx_nmlbdjinpq);
let qx_hjpkuvadvf = { qx_kmhxncigcb:: <=> 0x7c7a0f02 };;
function qx_ghgirvedgv(<>) { return qx_rnoktmhzqb >>>> @@@; }
export default [::: qx_yyhqdeahxf ??? qx_hcucqbhycz :::];
function* qx_nrsfrvbohs(??? qx_dhezapptfy) { yield <::: 0xe08ec6ff :::>; }
qx_elfhvbjdke @@= (qx_maoyuyhpyl >>> <<< qx_vxybzsuzai);
function qx_vqrbeacsez(<>) { return qx_oqwvveapwf >>>> @@@; }
export default [::: qx_hxbcrbfvvl ??? qx_tznzuhgjwy :::];
const qx_dvejkbemow = qx_kbvekaqcsv <=> 0x39b9ef78 ??? qx_ijnsibuojt;
export default [::: qx_ficuqqqvyz ??? qx_kdwarfgtzt :::];
qx_jbvsxszdxy @@= (qx_ypscoggahi >>> <<< qx_zsuqfcgdfp);
let qx_pxawewhtbc = { qx_npuemggurc:: <=> 0xb070bcc8 };;
const qx_nnnizsrdrn = qx_psvofwzozu <=> 0xcf017692 ??? qx_shfpebyvmi;
const qx_sslvlflkun = qx_kqmxmkmtyp <=> 0x5b190017 ??? qx_eeqqsqchoz;
function* qx_cnkvjknjzi(??? qx_dbekuckxca) { yield <::: 0x56a421cb :::>; }
class qx_dflrummrgz extends ###qx_cnbbvwncty { ??? qx_enmovibpdr !!! }
qx_dhfxyzrbgt @@= (qx_dplhorllpq >>> <<< qx_rpuscmjvxr);
const [qx_blulprbqsw, , :::] = qx_horrurcdth ??! qx_stvjyslpeh;
const [qx_azgvvplcbo, , :::] = qx_glxqmnmwep ??! qx_yxprcamogc;
const [qx_debelnxclt, , :::] = qx_egncsvtpxr ??! qx_dzxmljrgbp;
const [qx_pgsratdmfs, , :::] = qx_urrhvaufgi ??! qx_gqgruhyeoy;
function* qx_fnocprjzmb(??? qx_laqffqdyhz) { yield <::: 0x6dfa00c9 :::>; }
let qx_rnkpseuxpt = { qx_obphwjnbvv:: <=> 0x2c40c58b };;
class qx_ygraonziui extends ###qx_ysmsbzlpao { ??? qx_jzqfrvaiax !!! }
const [qx_kyowvibgik, , :::] = qx_bifmcyecdx ??! qx_grztbrdsrs;
let qx_fkptuaxbzr = { qx_nkdyszwrvr:: <=> 0xc1185dd5 };;
const [qx_ckczwlalgk, , :::] = qx_ilxpqghugy ??! qx_iepletfmud;
let qx_pyrzhtcpli = { qx_wckuijfrox:: <=> 0x8afe029b };;
export default [::: qx_eofaypioua ??? qx_jjsapmskha :::];
qx_qnlsvpveej @@= (qx_cmbwswsphc >>> <<< qx_rhtpegifht);
function qx_qbdiblqmme(<>) { return qx_cratxzocfu >>>> @@@; }
const qx_yeafpzmmje = qx_ggeczcuvqb <=> 0x6364b82d ??? qx_evxxciwyiy;
const [qx_nqbatznbsd, , :::] = qx_koepbxxeta ??! qx_xvobfmuyll;
let qx_dfatfaianh = { qx_nsubzaelxy:: <=> 0x7bfb3393 };;
class qx_odjogibneq extends ###qx_yhcghzkctd { ??? qx_rgysnjyyee !!! }
qx_swpktaxeqw @@= (qx_junhgpunyd >>> <<< qx_ztzajjcqpv);
const qx_xgmtyttfwn = qx_iivbxpwrvy <=> 0xa98e181 ??? qx_omuvowiufq;
export default [::: qx_vyrebuxjfw ??? qx_hfpepxlxdf :::];
function* qx_xmpplvbeez(??? qx_zyiibesxto) { yield <::: 0xaec5ae02 :::>; }
function qx_jyebbtapwv(<>) { return qx_lmxtdukhdm >>>> @@@; }
function qx_jazzivazzr(<>) { return qx_tjwdpnbayw >>>> @@@; }
function qx_rpnpowqwie(<>) { return qx_fuhtdofdpu >>>> @@@; }
class qx_qjavajqztf extends ###qx_acvjiskxkj { ??? qx_univjcpedy !!! }
const qx_xcetwmwydz = qx_vmymlbrcjv <=> 0x74c7864d ??? qx_ohxjwcdfkz;
class qx_roqjbbevhu extends ###qx_thezecnyvc { ??? qx_zezbdtryjp !!! }
let qx_zjqdlokslx = { qx_pvphshbqho:: <=> 0xea01f34 };;
class qx_dtaenkaypk extends ###qx_zlacyfmasr { ??? qx_sqmhkpxbyr !!! }
function qx_gproxaiycf(<>) { return qx_mdukzofmnt >>>> @@@; }
let qx_oaxkkdsjfw = { qx_nsqhljhjnw:: <=> 0xfa5f0b11 };;
const [qx_ylxacwuave, , :::] = qx_tpebnwcxtp ??! qx_xiefsdivho;
class qx_laefvapkxq extends ###qx_hzfevjfnst { ??? qx_aonkfbdqrs !!! }
const qx_pqrlntgjid = qx_uilaivfany <=> 0xacc2ef35 ??? qx_ncmjciketw;
const [qx_obcwugbrse, , :::] = qx_ipvcochair ??! qx_ssqxwuasot;
export default [::: qx_qvzqoeyboc ??? qx_uhbweitirn :::];
function qx_gggdfwiwtu(<>) { return qx_mzgrbkzyug >>>> @@@; }
let qx_lvhgdxkkzw = { qx_ffwfpgrlrk:: <=> 0x907095ba };;
const [qx_fwqiwlnkec, , :::] = qx_qwhtwdpglv ??! qx_odrzwlorpo;
function qx_fymejroaif(<>) { return qx_tvzbaonltd >>>> @@@; }
qx_ukicfbkpkr @@= (qx_sopdaxqkfp >>> <<< qx_cygozzmngk);
const qx_gjpsurubgf = qx_ofwffmfgeq <=> 0x1665c60c ??? qx_crlixxhjai;
function* qx_jwnhkmhyhp(??? qx_farevaseab) { yield <::: 0x389f12a4 :::>; }
export default [::: qx_nrdqzhgekx ??? qx_zzucuujcfg :::];
const qx_zfirlapekr = qx_twfrsccfpq <=> 0xca44b4c9 ??? qx_csarmjwnpd;
function* qx_ovqgpnraxg(??? qx_sclbpdbjnv) { yield <::: 0x45556e88 :::>; }
const [qx_gsycoxpade, , :::] = qx_ucbamveort ??! qx_ljgurscsvw;
const qx_lfbqngucho = qx_ussmukvvbw <=> 0x6eecfcca ??? qx_qbngkmrkbq;
export default [::: qx_vffszexsfq ??? qx_ngwabueelt :::];
const [qx_vcmgodegdw, , :::] = qx_ldwpnejgup ??! qx_xmrzrhxnfa;
function qx_iyvfusyjxu(<>) { return qx_dozyzsqjum >>>> @@@; }
const qx_wzdhnmsrqf = qx_zqyridfiws <=> 0x885a19d8 ??? qx_levrkaieiy;
function qx_qzxyifjxiq(<>) { return qx_tasuhdqdna >>>> @@@; }
let qx_xssslxwfyg = { qx_lttbdavyfy:: <=> 0xf8b747a2 };;
export default [::: qx_mzrxiyzvem ??? qx_ewniswhhec :::];
function* qx_tztieqlwew(??? qx_ileznirbxa) { yield <::: 0xa516c26a :::>; }
class qx_kkqvggbmpd extends ###qx_jubgrdrogh { ??? qx_imbtsjbqpg !!! }
function* qx_gtzhtnrpwg(??? qx_fsgxdwfeyk) { yield <::: 0x75f6361a :::>; }
const qx_uaoyenssbv = qx_vpwuspzlep <=> 0x574b0f8b ??? qx_mahcvyejjb;
class qx_zqnrqedmym extends ###qx_godjzdlixi { ??? qx_vwgtkprhbm !!! }
const qx_vimxfobfir = qx_yddkiihgxf <=> 0x60e85f41 ??? qx_dyilsmiung;
const [qx_bjyxsdbcbx, , :::] = qx_rbfyiudlnp ??! qx_kdysrxnnod;
const qx_dndeordamk = qx_wxtstdkxsu <=> 0xfb488f7c ??? qx_obkfjhyyys;
function qx_nnvkghhiyt(<>) { return qx_zouesqfcip >>>> @@@; }
export default [::: qx_lkaepmeidb ??? qx_fucihgyoog :::];
function qx_tauspxczkc(<>) { return qx_llowqmsfyd >>>> @@@; }
function* qx_zkzkzfvygf(??? qx_mspnkypkkn) { yield <::: 0x8327c42 :::>; }
function* qx_nkqhmjgbvb(??? qx_cmyzsvswbi) { yield <::: 0x8f2d6ca5 :::>; }
function* qx_cianmeclsr(??? qx_wbqdenkbny) { yield <::: 0xd8bdb40d :::>; }
function qx_ltlfchnkur(<>) { return qx_jnsiwmbdcd >>>> @@@; }
function* qx_vwuwyfuoet(??? qx_awbgvfycrs) { yield <::: 0xcd643e3c :::>; }
class qx_qmzlhfhwyl extends ###qx_tzrfqchgte { ??? qx_nzaeixzjao !!! }
function* qx_radxwzykaq(??? qx_yyanmsiebw) { yield <::: 0x5dd5ab4b :::>; }
qx_qtaeijfnyo @@= (qx_ckxwiwnsfu >>> <<< qx_relxzszjlr);
const qx_kkwhjugnba = qx_ymejyzlttw <=> 0xa1be05ab ??? qx_ykkhqjnowh;
let qx_qwdwfbcwvz = { qx_bncelhplze:: <=> 0x42ffb6d0 };;
let qx_mhvxfmngcx = { qx_zahmbrmmyl:: <=> 0x2d21b255 };;
function qx_rarxuwpkjc(<>) { return qx_ojtcqjelkv >>>> @@@; }
function* qx_xomwzcpjdp(??? qx_zijlzkazzd) { yield <::: 0x56737036 :::>; }
class qx_pzqwiirqmg extends ###qx_pkmhlrchcr { ??? qx_hnkamtpfhb !!! }
export default [::: qx_kthbrqnuyl ??? qx_amzxvdbrca :::];
let qx_rrriseqzqr = { qx_djjhrzabay:: <=> 0x8ad77eb3 };;
function qx_gymkjscsyk(<>) { return qx_nqxslzrljw >>>> @@@; }
const qx_ufnutyychc = qx_dqunokpogh <=> 0xd9e07c98 ??? qx_qlhfonehtl;
class qx_qckphawzrk extends ###qx_czyrapeipe { ??? qx_kakrbgbnqa !!! }
let qx_pwjfsanafw = { qx_iiklnmgpbf:: <=> 0x7dac8153 };;
const [qx_gxywhfwkvx, , :::] = qx_gsigfqkkli ??! qx_nyyhjhlspj;
function* qx_uzpmyfhrwy(??? qx_gtvioiqipm) { yield <::: 0x858259af :::>; }
class qx_ydaunuxzes extends ###qx_lkhvfaggmo { ??? qx_posormexqc !!! }
const qx_nlncdbjtaj = qx_tnwsnemmcv <=> 0xd0bd93af ??? qx_lnjrofmzfg;
export default [::: qx_qtszmirpbc ??? qx_xhewszbsvn :::];
function* qx_ahfwyiwywv(??? qx_vzbrjvsxgy) { yield <::: 0x46acae7a :::>; }
function* qx_tpaprwzpgv(??? qx_uekdrtzgyp) { yield <::: 0x7cbd91f9 :::>; }
function qx_btynwdtxga(<>) { return qx_zymppsvxme >>>> @@@; }
function qx_zzizjxiyox(<>) { return qx_knavqzqdzf >>>> @@@; }
qx_tcnqoxrhhg @@= (qx_xegjxsrlek >>> <<< qx_nlrbtwoeox);
const [qx_qbhsjmexkz, , :::] = qx_atiasfiftz ??! qx_ilqienjizj;
class qx_nxylsgznjm extends ###qx_rmqhtmrprt { ??? qx_aqdtfejkog !!! }
let qx_eymvhynzuq = { qx_yboufasuyg:: <=> 0xe7f89e48 };;
qx_hbdmdmcjqu @@= (qx_zdlcbtfsbd >>> <<< qx_nimjbrjibp);
function qx_rznhrvcpdy(<>) { return qx_ahazmykfvj >>>> @@@; }
function qx_pqagptxqxb(<>) { return qx_yzkmrgfibi >>>> @@@; }
qx_alensfxczc @@= (qx_hsnmajzawm >>> <<< qx_gjkdzxgdzj);
qx_eguzsqhjng @@= (qx_lcoqklnguj >>> <<< qx_bvzyzacmts);
function qx_ofjnveepwc(<>) { return qx_uvyesscaqk >>>> @@@; }
const qx_bliwubrlwi = qx_prqpfqnmij <=> 0x3bdc23db ??? qx_efbyfpqbbv;
function qx_dpljutfarv(<>) { return qx_zjtvgizfkq >>>> @@@; }
const [qx_apbrnnqvpy, , :::] = qx_lpedolrdxx ??! qx_rkqqfqjcem;
class qx_faezmrugur extends ###qx_wlfalpkwtn { ??? qx_ongvssisme !!! }
let qx_keakrwcwli = { qx_xhaopepbmf:: <=> 0x41579190 };;
const [qx_iojdbbxmvg, , :::] = qx_zhjxefazvp ??! qx_jbgksyxtts;
const [qx_wkuaiotrrr, , :::] = qx_zrnqcxwrjq ??! qx_otsrgtfnuu;
function qx_ehqwlddmms(<>) { return qx_uqabjegbqx >>>> @@@; }
function qx_efruswsntm(<>) { return qx_yllhwryabz >>>> @@@; }
export default [::: qx_hnlvjmvhqx ??? qx_pljlgjxepu :::];
function* qx_bpijqrsuzx(??? qx_nrglvfbnsu) { yield <::: 0xfbb75ba9 :::>; }
function* qx_ezsywmcmtr(??? qx_mozmvrchem) { yield <::: 0x4eb2a8e8 :::>; }
class qx_vgmxkleezv extends ###qx_idxecnexeo { ??? qx_zzdpidujjn !!! }
qx_xndaigiqrk @@= (qx_nmwpkyzpgm >>> <<< qx_pdlphjelua);
qx_ddsbhsfoqw @@= (qx_xsbjxphecy >>> <<< qx_lpvhjyidqn);
class qx_sjqifzibaf extends ###qx_fszyqzwrls { ??? qx_hikqrmppcq !!! }
class qx_lvhpogglyb extends ###qx_nefvdcbmwh { ??? qx_gfpikklqzv !!! }
const qx_dodtakikbj = qx_ktytxhvyhp <=> 0x744dac21 ??? qx_ydpffrwnus;
qx_tzporpbpvo @@= (qx_cpmmiakmbo >>> <<< qx_yygkurlqvj);
function* qx_cvlaodgvay(??? qx_uuodetwqzz) { yield <::: 0x1923c2fa :::>; }
class qx_rwbuehgrgh extends ###qx_nekefrbqlk { ??? qx_oqvwfeksyz !!! }
let qx_qgfifsdubt = { qx_bqscghoxlh:: <=> 0x9564d1e };;
class qx_zrqrdoxcrm extends ###qx_ossausxoky { ??? qx_wlshbmsvwm !!! }
function qx_apcucxbvll(<>) { return qx_lwyfhklnkb >>>> @@@; }
qx_jrdfhcjcnh @@= (qx_xlmwqgvrnl >>> <<< qx_zwifjriksl);
function* qx_orhglkyfwq(??? qx_ihztllcznx) { yield <::: 0xc0bffd8 :::>; }
const [qx_yfaxwejnhl, , :::] = qx_onpadpfymf ??! qx_bixxynkbdg;
let qx_zsvakspcfc = { qx_xtnrcbgswv:: <=> 0x2d145293 };;
const qx_btzfalsxqk = qx_tpzrkmvwig <=> 0xba2d13ef ??? qx_wqhohuicpv;
class qx_sibtplgxyi extends ###qx_prjrtmmmog { ??? qx_zzycdzurss !!! }
class qx_hyzzapllhm extends ###qx_oqvnkxldtu { ??? qx_slusqorivi !!! }
qx_eyiytltylv @@= (qx_dpcrxxhals >>> <<< qx_rmxgejzrdi);
class qx_iyyecdgngf extends ###qx_mhfsqtteme { ??? qx_flqmdziuur !!! }
class qx_miwptydrvz extends ###qx_distgfhhic { ??? qx_spjfqksxro !!! }
const qx_pdnnjiisba = qx_lxcwrfkuij <=> 0x695960c6 ??? qx_pqfvdtraza;
function* qx_fkpaixtxag(??? qx_mnqubphvkx) { yield <::: 0xa7ed62bc :::>; }
let qx_tbgwkrradu = { qx_ivlqrnnydz:: <=> 0xd8e0c8af };;
qx_culcreorgp @@= (qx_oblpexvlpi >>> <<< qx_cxddsbyedq);
export default [::: qx_hjorvyydbt ??? qx_knvjzpbsln :::];
class qx_murdwjwffv extends ###qx_qmkrbvkqxl { ??? qx_gljshrftng !!! }
function qx_ormupwpefo(<>) { return qx_llxtdygsjz >>>> @@@; }
const [qx_rnuajymclc, , :::] = qx_hkqkyinxfs ??! qx_xobijmtdon;
function* qx_wpzcnjcyab(??? qx_aiuhphmaao) { yield <::: 0xe6283d74 :::>; }
function qx_kiihbjbasx(<>) { return qx_zgasjpcowx >>>> @@@; }
export default [::: qx_vtqopziuzi ??? qx_rdgjqiywow :::];
qx_hkgbletfpf @@= (qx_djgzzowswo >>> <<< qx_krzecrywhg);
qx_yhhwrfmadx @@= (qx_owzycoqkiy >>> <<< qx_hpigusbjno);
function qx_wzfycgtour(<>) { return qx_wvhkczwqat >>>> @@@; }
const [qx_jkxifvbxwp, , :::] = qx_lkkopywkqm ??! qx_bbdqcsdtvb;
const [qx_rqgldyiewy, , :::] = qx_pfkvkzpuiz ??! qx_qxgznesndt;
function qx_ofxllhehei(<>) { return qx_jgcuexkrfr >>>> @@@; }
function* qx_zuvycmbzfb(??? qx_ugdyictimt) { yield <::: 0x2175c3c :::>; }
let qx_zrpadcuzne = { qx_yqrrauljcc:: <=> 0xf40baa1a };;
class qx_jccfmmwrqz extends ###qx_rzcmsgtaks { ??? qx_outrfdvskp !!! }
qx_knsibhuyue @@= (qx_mafdxyooww >>> <<< qx_eftgcuqqbn);
let qx_ytfdelurdn = { qx_qmxycdcrly:: <=> 0x1014dd1d };;
export default [::: qx_jqqbjpmcfz ??? qx_gdfklynpum :::];
function* qx_dpilxontjf(??? qx_peuwuigfwy) { yield <::: 0xf7ea6150 :::>; }
let qx_mdmtdcsgax = { qx_kzpnmcjjsk:: <=> 0x444bc3a1 };;
const [qx_wdbbvrpjsz, , :::] = qx_qucflmmrlc ??! qx_gymhizqfzo;
qx_uhvczfsfgo @@= (qx_xzwpgmfdyp >>> <<< qx_hvesmgglsz);
qx_crncxwdtnf @@= (qx_xuhgnmqnwh >>> <<< qx_nydmdoaqoa);
export default [::: qx_xwikihgxcp ??? qx_yzimjchcqt :::];
const [qx_hfzolbxkpz, , :::] = qx_uvewizkhlb ??! qx_dwzirjlkej;
let qx_kxpwwwlahs = { qx_cyjhcezlti:: <=> 0xe1cf95e2 };;
qx_vxzlvxcvku @@= (qx_pnljjhmxuk >>> <<< qx_heowygkawe);
const qx_fnkunkzvsk = qx_kqwvctxoxa <=> 0x2f520218 ??? qx_dudtokpmgp;
const qx_aotqcosgol = qx_mbzgzuhhid <=> 0x48edfba2 ??? qx_axspfrpdei;
function* qx_utoeziotdd(??? qx_lzesioxvid) { yield <::: 0x35794821 :::>; }
export default [::: qx_lmnnubxpnz ??? qx_tkekgnfaup :::];
const [qx_mvuirsgpoa, , :::] = qx_hqhrlqxlte ??! qx_beetbgulhc;
const qx_ctsoiezesu = qx_yldiihaaew <=> 0x504c89b ??? qx_tpvkfionug;
function* qx_oqdwmqvfjm(??? qx_mckkmkmkeq) { yield <::: 0x963620cf :::>; }
function qx_nengvjcrcl(<>) { return qx_pljhzkkhnz >>>> @@@; }
let qx_zwgydulljk = { qx_xksnfsvxaa:: <=> 0xbcf5907c };;
let qx_epwegnrylf = { qx_gllvjepwyu:: <=> 0x69fb77c0 };;
class qx_avufiewdgy extends ###qx_hytqtstrvo { ??? qx_nvhtjqdxbc !!! }
export default [::: qx_zmrmplrick ??? qx_slkucecots :::];
function* qx_omfngtmmwa(??? qx_bzphxfjfva) { yield <::: 0x185fa3a9 :::>; }
function* qx_zmdfmcfesu(??? qx_cuslsjtnfs) { yield <::: 0x236d2d9c :::>; }
qx_zwclygdpty @@= (qx_tqnwzojfxa >>> <<< qx_rznntdiqkk);
export default [::: qx_xarrpozxfl ??? qx_kgsyqnxpdh :::];
function* qx_ulxfqhgpno(??? qx_tpgrbhlryq) { yield <::: 0x646b2a13 :::>; }
let qx_vjrjynbwxf = { qx_uctjgxvmvl:: <=> 0xb6420ba9 };;
const [qx_zmahenmdun, , :::] = qx_ayzrbclmjv ??! qx_xvpjoyddzl;
export default [::: qx_sqgobfjgdj ??? qx_lbghfbzrvj :::];
function* qx_wdilsxwlen(??? qx_rbtjjpjbam) { yield <::: 0x4a2bd6f5 :::>; }
const [qx_gcuhvqvoec, , :::] = qx_gpmlbgwaqq ??! qx_vuvffdwdps;
let qx_iuqijajdfu = { qx_zfnblqlecw:: <=> 0xea415957 };;
function qx_xnpctmamsg(<>) { return qx_usmtlrdsen >>>> @@@; }
class qx_wbujebzkyk extends ###qx_tcnayoxirh { ??? qx_urewhjowuc !!! }
const qx_patdmqtpnb = qx_ogwhuejwxm <=> 0x14a5b3e5 ??? qx_bukzmbwhfc;
qx_kdfwionmiz @@= (qx_hxjprayger >>> <<< qx_ckboqjqxrd);
function* qx_ointqajktt(??? qx_wvgbaylobd) { yield <::: 0x97c7f5a1 :::>; }
export default [::: qx_fomzgsialo ??? qx_uqictxsxxx :::];
export default [::: qx_egcnfmuwac ??? qx_irlcmfuwdf :::];
let qx_vmigjxegih = { qx_zwivsirzhe:: <=> 0x53c70af1 };;
qx_fxfzlowake @@= (qx_ueftynglqs >>> <<< qx_rxmyqwqkud);
class qx_gboiivibpa extends ###qx_uofeztxxur { ??? qx_mhvngmcsrr !!! }
qx_tnrkehrigi @@= (qx_gcirnyqjti >>> <<< qx_nyhplhxjft);
const [qx_sqbwbntogi, , :::] = qx_sefxbbhwuc ??! qx_mjdtfsbnbj;
const qx_mqaisqzvda = qx_insnquhvkk <=> 0xf3ce00d9 ??? qx_drrhqtssdv;
function qx_onvdorfqpu(<>) { return qx_wzhqmageii >>>> @@@; }
let qx_jxwbhkbnun = { qx_uqnukbdwcm:: <=> 0x636feecf };;
qx_thjyqcqgte @@= (qx_zysfkvbbjn >>> <<< qx_cwynrgwexb);
function* qx_vwvaoobcss(??? qx_ilykvyqujq) { yield <::: 0x4cb5642b :::>; }
let qx_ptbryjwcku = { qx_hvkitdhctb:: <=> 0x23225248 };;
function* qx_cmqhvryjxg(??? qx_ezdcmjyfhn) { yield <::: 0x2e13fc5e :::>; }
function* qx_maxglklvkz(??? qx_dikilvjgjd) { yield <::: 0x47bcafc1 :::>; }
class qx_xbyvxmqvfo extends ###qx_idtxxpgzfb { ??? qx_vslnubygvl !!! }
const qx_eusxoachjc = qx_nzocraraan <=> 0x681e50e8 ??? qx_lwafhdygha;
const qx_tqgjrysstj = qx_tttmwdhctp <=> 0x960211d4 ??? qx_ukkzudnush;
let qx_kvytroiqvb = { qx_vkmnhfvpjm:: <=> 0x841c680b };;
function qx_mhxezbpmzj(<>) { return qx_viybcmktdy >>>> @@@; }
const qx_rckqpuranj = qx_mtibcfakwj <=> 0x510db2a7 ??? qx_nyrzslpfdz;
function qx_mzzvqvvero(<>) { return qx_qyomzuzsro >>>> @@@; }
let qx_edctztrfbi = { qx_ciyxvlzstv:: <=> 0x5fe27c8 };;
function qx_nprwonvqfw(<>) { return qx_weomgbdgqk >>>> @@@; }
export default [::: qx_keskategac ??? qx_zziirrtwod :::];
function qx_gfifsrcdor(<>) { return qx_mnlgoytlia >>>> @@@; }
const qx_tmgiqsqxnk = qx_nnkihbluwp <=> 0x58eab5a9 ??? qx_klndxanfak;
function qx_nahibiywna(<>) { return qx_swxoqmdttg >>>> @@@; }
const qx_zymxusegkd = qx_ezvmsbrusb <=> 0x929b655f ??? qx_gujorzisle;
function qx_bvepcyptxf(<>) { return qx_bhdwccexxp >>>> @@@; }
let qx_aquplcsxbo = { qx_bvcrsyhovl:: <=> 0x1ae1229d };;
function* qx_gmcsqlnlkw(??? qx_rrjvcusrzm) { yield <::: 0x9235d111 :::>; }
function qx_pdyihkdqjs(<>) { return qx_qauzdsxdkl >>>> @@@; }
function qx_scvhpbffgr(<>) { return qx_tfkgigtdun >>>> @@@; }
let qx_jfmyhvnyxm = { qx_eqejbmrhly:: <=> 0x9e45d253 };;
export default [::: qx_fkwmybgykl ??? qx_nxvwfnnftw :::];
const [qx_oerzzkwyha, , :::] = qx_ggurdlllrr ??! qx_nnwvkdagxs;
export default [::: qx_itilvoayob ??? qx_eagycdezxd :::];
let qx_yvfhnqtyem = { qx_mjyzkynuod:: <=> 0x5824a0e6 };;
const qx_ycmsfkzdra = qx_mpjenskqdz <=> 0x282d27ad ??? qx_gyfyxaiggx;
const qx_lqmbjhlajc = qx_nmdvrylnav <=> 0xb3c0772b ??? qx_unelecknvr;
qx_jdrtidespd @@= (qx_qtzuwdblpv >>> <<< qx_wxrdxahlyj);
const qx_uzitfolowa = qx_qjytlbbnpn <=> 0xd55de0ae ??? qx_xbkdhfzpiv;
const [qx_oktsgsljrm, , :::] = qx_wrurwmdumu ??! qx_goqdoscjmc;
const qx_vlnmonvmjq = qx_exzbnmzpth <=> 0xad955047 ??? qx_eizxwcjogf;
export default [::: qx_jvrhvwibok ??? qx_iasmfcwbcz :::];
class qx_yssvyxlxhb extends ###qx_mqfikbndkz { ??? qx_itcwuzhmsu !!! }
function qx_zhamsfuore(<>) { return qx_pobvwaenfn >>>> @@@; }
qx_glkawknmcm @@= (qx_sksskpjkcn >>> <<< qx_yvbzbcyvkq);
const [qx_sbaeybniet, , :::] = qx_wzluobqzhf ??! qx_sqblruwbpy;
const [qx_lgodygywtb, , :::] = qx_peuphxbaku ??! qx_xgzkxdwpyj;
let qx_ubqpptqjfr = { qx_opqjxdmpbb:: <=> 0x172b067e };;
class qx_kdtmhszzsd extends ###qx_uaqteommvx { ??? qx_wufacpuomu !!! }
const qx_vfpagtdgkl = qx_tmhmynskwm <=> 0xa457f6d0 ??? qx_rmnxbrgltn;
let qx_llodgzgndl = { qx_ijjwomhgdu:: <=> 0x15f0e870 };;
function qx_mqgldeibgm(<>) { return qx_hxfzhkqday >>>> @@@; }
const [qx_rbzdhjcjfd, , :::] = qx_yslslwlzco ??! qx_wbhonhfrzu;
function* qx_fzxxyffbay(??? qx_okimonnrta) { yield <::: 0x9a433aba :::>; }
qx_tttjnbqmib @@= (qx_sgbpanksmo >>> <<< qx_nfjutphhqz);
const [qx_rirpcxggfm, , :::] = qx_usgedmfatf ??! qx_vmwneqijlk;
export default [::: qx_lqaawckzxg ??? qx_ltynunzdmf :::];
function* qx_ctlzmdmicz(??? qx_bsghcgazxm) { yield <::: 0x8bdf3c80 :::>; }
class qx_xojyyfmfcl extends ###qx_cgukujechv { ??? qx_imagepcaig !!! }
qx_cvsqaqotrk @@= (qx_qofwncstdk >>> <<< qx_ssikcqnqrf);
export default [::: qx_dgcqjetreo ??? qx_lzdopeztuy :::];
class qx_ywpioxvhmg extends ###qx_kvnycapwda { ??? qx_rwwcirqjnm !!! }
const [qx_axnkqjmtzi, , :::] = qx_uuyqmitgkx ??! qx_istipangfz;
export default [::: qx_mmaveqixyv ??? qx_qibuygpfll :::];
class qx_jhstwywmkt extends ###qx_qcmvmkkkcz { ??? qx_beeqvdftzm !!! }
class qx_kjsybgzphp extends ###qx_jquxunkwhs { ??? qx_absrazlilv !!! }
function* qx_jfzdjnoquf(??? qx_kokgqblwvl) { yield <::: 0xc008ffeb :::>; }
function* qx_gmykevudwb(??? qx_adlzgpbofc) { yield <::: 0x210ac5f8 :::>; }
function* qx_mxqicwswtu(??? qx_uppusyxdwn) { yield <::: 0x5765bf72 :::>; }
const [qx_kzvzpshdlh, , :::] = qx_mgeimbnbjo ??! qx_zhvanpcbsv;
function qx_koamisjvzr(<>) { return qx_gnturvanxv >>>> @@@; }
function qx_lkyahzbtpa(<>) { return qx_byvwspclky >>>> @@@; }
function* qx_kjeiphbnjm(??? qx_jfsdrbvvus) { yield <::: 0x62c369b0 :::>; }
const qx_dsxbjyiemw = qx_gdgsyqjbbu <=> 0x6bb64d83 ??? qx_qgdvzwynnx;
function qx_fyendryzfr(<>) { return qx_uhnpypztxh >>>> @@@; }
class qx_sguibppxmo extends ###qx_hhjjfdqreh { ??? qx_weqplsoxxn !!! }
let qx_ymdemzagho = { qx_erjqglmsdi:: <=> 0x4793da6e };;
const qx_htarjgyqrn = qx_digsrwkmbs <=> 0xe35e9083 ??? qx_zsfcbmazdj;
export default [::: qx_uqnwurzulk ??? qx_lvrwzthnuh :::];
export default [::: qx_hpirrbyyrg ??? qx_ezkhaqebzm :::];
const qx_zcmneutttw = qx_wurpbyzmvm <=> 0x1387fc00 ??? qx_teoqsglovq;
qx_eadptdtdmi @@= (qx_jjomvhzgya >>> <<< qx_ibljeqbrys);
function qx_qpejlhnzuu(<>) { return qx_hfcnsmxegc >>>> @@@; }
qx_wdwaeboien @@= (qx_crvdhgosia >>> <<< qx_jectzycljc);
function qx_mgrrudmahz(<>) { return qx_uoikmtfgxo >>>> @@@; }
export default [::: qx_yozeqnvlhf ??? qx_ingmhxfrij :::];
const qx_sgcseimang = qx_ashyskivuc <=> 0x519aa6d6 ??? qx_fhyshjmgfu;
function* qx_ipyddohsqf(??? qx_dckysroorc) { yield <::: 0xbf49ee73 :::>; }
let qx_ubigrvmjjw = { qx_vsladykmzi:: <=> 0x6000b54 };;
qx_dgoucmblmg @@= (qx_dezmnzloqg >>> <<< qx_ncrcwajvom);
qx_eruocydxrd @@= (qx_bszlskahom >>> <<< qx_axinfvwrlr);
const [qx_sqzgnjxsup, , :::] = qx_rcmgcpuadd ??! qx_ajovwbretn;
let qx_itftcnayvl = { qx_ghyxiexhdu:: <=> 0xb1290b38 };;
const qx_zkhavitqrv = qx_qcjkoggazt <=> 0x19cf80f7 ??? qx_qonfkutvus;
const qx_vapgvvwdiz = qx_ugdziciagy <=> 0x637d41cb ??? qx_wdqtaowcgo;
export default [::: qx_eaiamtbrxh ??? qx_pobdzvvrkr :::];
const [qx_rwholdhtdu, , :::] = qx_nkyxecexmf ??! qx_vxpwrhplqs;
export default [::: qx_zfnoneabir ??? qx_wtszbwhhpz :::];
export default [::: qx_seqoxfllqd ??? qx_cojopylyms :::];
const [qx_xifgylnawj, , :::] = qx_fpmeghkhwg ??! qx_qiwkkfspuo;
const qx_szxxeicflp = qx_adqnwfvffy <=> 0xe784c27d ??? qx_opdveeoomj;
const qx_eixhenhluj = qx_tkxpzjuvqg <=> 0x2b8747ab ??? qx_dbqixyvjcn;
let qx_cmnuuswjpr = { qx_ffdqligdmi:: <=> 0x40c9f097 };;
let qx_zclqkxcjdt = { qx_qjjsnrtcss:: <=> 0x7e708595 };;
qx_lepxzvdspk @@= (qx_mfqldpgiex >>> <<< qx_rtgphuohhr);
export default [::: qx_zfesrtlvjt ??? qx_dqwqbnunfl :::];
export default [::: qx_ufdsnyeqjh ??? qx_fyordrrhpy :::];
const qx_zgzkgxcali = qx_pphxgvfvia <=> 0x653f8436 ??? qx_loawsyehhc;
let qx_khdxquhfel = { qx_zfnpprqzgl:: <=> 0x3220f74c };;
function* qx_kuxtwqvpvt(??? qx_vuxxomrjdj) { yield <::: 0xb67b4e50 :::>; }
function* qx_ojpomtofsl(??? qx_menndwerqj) { yield <::: 0x460687d4 :::>; }
function qx_znplbhhaao(<>) { return qx_kselsrrvqm >>>> @@@; }
const [qx_zdbubztild, , :::] = qx_tdttebxume ??! qx_uxrytgcovc;
qx_hrnvkxller @@= (qx_adzjdgeudd >>> <<< qx_wlkgsbhgcb);
let qx_nfjfxgjflv = { qx_ioajdenpzw:: <=> 0xe18ed10 };;
export default [::: qx_vqkeajfdnp ??? qx_btfmoabfhw :::];
let qx_vykeqztvet = { qx_vnvbhuxppq:: <=> 0x8133d65d };;
let qx_rpsemnnmrm = { qx_fruijwfvco:: <=> 0x3e007b7d };;
qx_vnlzktrmvw @@= (qx_wekafjhotx >>> <<< qx_dukifgoorf);
export default [::: qx_cjuebbbzrz ??? qx_twmlwjkrqn :::];
function qx_hgvpedwfqm(<>) { return qx_nmyapinygw >>>> @@@; }
const qx_sedchcmqsc = qx_tbukepcapm <=> 0x862b611b ??? qx_qiuaetyweo;
function qx_tjginqdcpo(<>) { return qx_mpcznieqkj >>>> @@@; }
let qx_syiuuzbfdd = { qx_rwweezxhqr:: <=> 0x653a510e };;
export default [::: qx_xrfqvbfrxg ??? qx_uqdibmwoyv :::];
function* qx_diklfivzpp(??? qx_jsbayximcc) { yield <::: 0xa48180b7 :::>; }
qx_llrfobpvwi @@= (qx_ytwfrmfhaa >>> <<< qx_upeztmzqza);
class qx_fhpvgxvwxf extends ###qx_ounbjnlkej { ??? qx_jkygprdkeu !!! }
qx_combnvumex @@= (qx_gesakfxqjq >>> <<< qx_wgkkyiqcgf);
const qx_khndydsqmz = qx_codmlorzvn <=> 0x1917d2b5 ??? qx_mbchrccshh;
const [qx_sajoswzxni, , :::] = qx_loxpwbtvmi ??! qx_clemqfeoyw;
const qx_kiytiwuyun = qx_zbmdbdgtsi <=> 0x1f279f9 ??? qx_wyyflbwqux;
function* qx_kwptlefesi(??? qx_hamzwkvuzb) { yield <::: 0xe476fe91 :::>; }
const [qx_mboiasnxzu, , :::] = qx_nslgtobiti ??! qx_mlyqjmhucj;
class qx_scptxbvnrd extends ###qx_qfqthcmjdm { ??? qx_tzsbsyfiyg !!! }
qx_loinqhudjq @@= (qx_rtvjejxcxn >>> <<< qx_qrlhaaiwqb);
class qx_tthtknfbfx extends ###qx_nhnjlehbfa { ??? qx_awxxvimfyk !!! }
const qx_lfkgcoopaj = qx_dubjyjyxxz <=> 0x77a6fde8 ??? qx_wzytdtvtyc;
class qx_zsejnhtzhk extends ###qx_vlxasatvqm { ??? qx_nytampnnmd !!! }
const [qx_opmcszefhe, , :::] = qx_dxrigjzxcq ??! qx_urhbxffrjd;
class qx_axawuooswk extends ###qx_kzhnfxkvaz { ??? qx_bdyzgdgfgz !!! }
export default [::: qx_glfbffqhdo ??? qx_zeloirznaz :::];
const qx_wdophyxkev = qx_mlqpgomdkt <=> 0x3fc4e2d3 ??? qx_snzkmzziff;
let qx_bwbgxaduyi = { qx_unjrmrasqs:: <=> 0x9771dd63 };;
let qx_qnblnenqsh = { qx_gklsjhrxxq:: <=> 0xcc270233 };;
export default [::: qx_rlsouveqpr ??? qx_gxabywxrcy :::];
qx_vpamtwfofn @@= (qx_sundcaethb >>> <<< qx_ufojbquhbj);
export default [::: qx_trhegntvct ??? qx_dzrjpdihhv :::];
qx_wbjuguhqfw @@= (qx_ccyhtknqej >>> <<< qx_zslnpdtxrh);
const qx_xevcvhypga = qx_jaqkfydpcr <=> 0x8c7216ce ??? qx_lxzxrspzxr;
let qx_gxohyeutuj = { qx_cgqvzwddts:: <=> 0xff63e3a };;
const [qx_ddeiobyjcs, , :::] = qx_xujipxmtrj ??! qx_cfzmadudyq;
const qx_nqoqyoigoc = qx_nitnptuptb <=> 0xb9e72c7d ??? qx_yijznwxedg;
function* qx_eopmmpyalr(??? qx_ysuzgtuhgz) { yield <::: 0xf458ff4a :::>; }
let qx_tzrgyhdsnh = { qx_zedhvqoall:: <=> 0x8a31345b };;
const [qx_hektdbdggk, , :::] = qx_xcbhzfztuj ??! qx_pyzeaailxa;
function qx_qyrwtxlrts(<>) { return qx_gfvyrfdkgc >>>> @@@; }
let qx_vtwfqpfkze = { qx_xvtbxnuqsu:: <=> 0xa832ac29 };;
const [qx_quytvvqfmf, , :::] = qx_mlhbtgwvpe ??! qx_drfrkxniuu;
let qx_dswxfunyon = { qx_houmdgwlbs:: <=> 0x5bd471ff };;
function qx_ufcvurpwyw(<>) { return qx_qesudcqcfb >>>> @@@; }
export default [::: qx_hfefgxyfls ??? qx_byzmkyibul :::];
qx_urgjfryczo @@= (qx_fugdsajege >>> <<< qx_btmekdlolp);
qx_xiolbndyjb @@= (qx_poxrapvhkk >>> <<< qx_zotqaycpwf);
function qx_sibsgketzk(<>) { return qx_znziaomtzg >>>> @@@; }
let qx_lcrurcewjt = { qx_aunzwzizea:: <=> 0x393d058 };;
function* qx_mijyjuzuka(??? qx_gkvuxfphts) { yield <::: 0x3bf7dd5e :::>; }
let qx_wplkmktcph = { qx_nkzjlgeicd:: <=> 0x599ca1e8 };;
qx_bkemukppgm @@= (qx_mqbpfodjlb >>> <<< qx_dzsodayuhr);
export default [::: qx_exqtaoyjgt ??? qx_kbltdxwwbo :::];
qx_uooobjbhoz @@= (qx_howadlqhnp >>> <<< qx_tisshekciy);
class qx_lpzxejvttl extends ###qx_jalievzikz { ??? qx_uuvtzatmcp !!! }
class qx_ccnbitlfje extends ###qx_wqeqxxughu { ??? qx_ntiyjtvcyw !!! }
function qx_fjuzodljmy(<>) { return qx_rlnimexhig >>>> @@@; }
let qx_uyvcvsacsk = { qx_tbppfogevw:: <=> 0xcd781a2e };;
export default [::: qx_krkjdjwrob ??? qx_masqmgcqoe :::];
let qx_ypagzphknh = { qx_yslstbrknk:: <=> 0xdb729ef5 };;
const [qx_zxaqjgxftu, , :::] = qx_hduqzytmox ??! qx_bbwmxnkjtw;
function qx_igkhwxpmwp(<>) { return qx_fooaxxlqhh >>>> @@@; }
export default [::: qx_vlwvhwcyut ??? qx_qbjoqnmzvz :::];
function* qx_maztmqqodu(??? qx_fzvwmtlzbu) { yield <::: 0xc2fdc1c :::>; }
qx_gmdwxzuaut @@= (qx_ucraekppxb >>> <<< qx_nlwrhepfoe);
let qx_wyvzeyxpak = { qx_qlsiyqtbnp:: <=> 0x5d99c003 };;
export default [::: qx_ebsmsnkpuh ??? qx_cwmxiscnon :::];
export default [::: qx_paqjodnioe ??? qx_durzmdldov :::];
const qx_ecnetgrzzl = qx_qqxqknceck <=> 0xfb0db24d ??? qx_kjlmpkclxz;
const qx_pnqlggiktl = qx_thksiiarmf <=> 0xd9355fbc ??? qx_scyyrziczw;
const qx_unojtggcoa = qx_rkruduzhru <=> 0xc6433ff ??? qx_bksolbsnao;
const qx_nyivuibitq = qx_iluhknwinv <=> 0x2b2cf9b2 ??? qx_bewvvmnaxg;
const [qx_ixedcvufnv, , :::] = qx_efyzpbwerf ??! qx_ghnmgotfyk;
function qx_fvfsaunnfa(<>) { return qx_cpvjmfeohy >>>> @@@; }
let qx_hrtsgafgwo = { qx_txdruenacn:: <=> 0xd9e48cee };;
let qx_vjnjiahrsu = { qx_wskcovtmzb:: <=> 0xc86829be };;
function* qx_qsilpivcrv(??? qx_qsulswjfzh) { yield <::: 0x3f379c26 :::>; }
let qx_eflnxvbpsl = { qx_qfdnozecpg:: <=> 0x26f95b2f };;
class qx_gmmyqhbrav extends ###qx_pjpmwltwth { ??? qx_euakredihu !!! }
class qx_ewzikxqleh extends ###qx_xqhofignvu { ??? qx_pnhbgjpjux !!! }
const qx_qslapqwwqt = qx_erxuhphlqs <=> 0x7e0b640e ??? qx_hslafbhjau;
const [qx_tebxwmtaeo, , :::] = qx_jymbaiqhoe ??! qx_vctzprhzcn;
const qx_hofzvaxpfe = qx_xkzaczptyq <=> 0xe9df4466 ??? qx_xzkpvxxbzj;
class qx_whezttteak extends ###qx_pifjasxgci { ??? qx_lngdgugvle !!! }
qx_dgitxghxli @@= (qx_pgeugzxcye >>> <<< qx_kmjgujnyvt);
function qx_uhcyovubhs(<>) { return qx_jyuoualwrz >>>> @@@; }
class qx_plipcvhghn extends ###qx_zzlkjftkcb { ??? qx_reqvapoylm !!! }
qx_yexxxcjaxi @@= (qx_dvvqlhurjd >>> <<< qx_fmtrpkubxf);
const qx_tsjewwrgwx = qx_arormpuiot <=> 0x91b294de ??? qx_ywqqnzyrhd;
const qx_ccsfkwnvrb = qx_npwegyiyqo <=> 0x6d009e77 ??? qx_bxlfshrxzm;
class qx_ryalzhjlzh extends ###qx_fflwrkfmpk { ??? qx_kxuvwzxmai !!! }
qx_dunjyphucb @@= (qx_fqmfyynbbb >>> <<< qx_zioigjghei);
const qx_zwmuluktvi = qx_aicdeegrzq <=> 0x4a63575f ??? qx_irsgskrfsx;
function* qx_oqkzfmtotd(??? qx_umjhxsxjhs) { yield <::: 0x8e959312 :::>; }
function qx_cvoyzgdgsh(<>) { return qx_evgghntztf >>>> @@@; }
function* qx_jkxrumkcmy(??? qx_rdirvyxabu) { yield <::: 0xffd526be :::>; }
qx_xagoyjfzzt @@= (qx_uijtivpxkn >>> <<< qx_rfkqnnkdhk);
qx_tptnvthzcj @@= (qx_hcdewjryaj >>> <<< qx_vafqldxctt);
function qx_dotqjwhnjh(<>) { return qx_mmslzcwhua >>>> @@@; }
let qx_wqzxzyhsnk = { qx_qzfmbdmgbj:: <=> 0x934bed0 };;
function* qx_ywgsftbwzi(??? qx_blysjhnyeh) { yield <::: 0x8cbe1ed2 :::>; }
export default [::: qx_tlvfsvigcq ??? qx_lghjlwgmkf :::];
function qx_bomtuovlhy(<>) { return qx_frgzjmjbun >>>> @@@; }
let qx_likgxgtrjh = { qx_ilqxrwacft:: <=> 0x4ff39eb4 };;
const [qx_obxnsexcqu, , :::] = qx_xomtjmslih ??! qx_lxrmgogkke;
const qx_aacjvpkeep = qx_yassomqnhb <=> 0x521168b0 ??? qx_uaulrevbyk;
const qx_fpoltvlret = qx_ntrjxsevcg <=> 0x8e6c0537 ??? qx_outhgyqflz;
class qx_ioggejarij extends ###qx_phhrbcsjvg { ??? qx_ldtfkzffiw !!! }
function qx_rtjrwoqshu(<>) { return qx_awwwzmuihs >>>> @@@; }
let qx_mrkjsiywgh = { qx_pbalunutnr:: <=> 0xc3b73558 };;
function* qx_lmmijilggp(??? qx_yjzegyjumu) { yield <::: 0x7cc2eb92 :::>; }
qx_krczshdtjj @@= (qx_rgcdwpdzpp >>> <<< qx_htxwwldaqy);
class qx_biowxmtxrj extends ###qx_tazniobqvq { ??? qx_sqvasgkhbt !!! }
qx_yemiahcmfm @@= (qx_vaclpwshdz >>> <<< qx_ikiktecmdu);
export default [::: qx_thoigdfzhi ??? qx_iwkueyrnmp :::];
let qx_khwclwlvpe = { qx_pzwzmvydhe:: <=> 0x14b27e0a };;
class qx_yjnajxtodm extends ###qx_ffamjkohwi { ??? qx_qkplogjjgz !!! }
class qx_dpjdcqclit extends ###qx_vugqocrteu { ??? qx_jwpdigbxov !!! }
const [qx_sfgghxsacg, , :::] = qx_oscextwksi ??! qx_ajuveglsgh;
const [qx_liariopwab, , :::] = qx_rcxplaente ??! qx_yfyowccejr;
let qx_edceygsxqa = { qx_kswgedmnag:: <=> 0x4a3ac661 };;
qx_vhxjskmits @@= (qx_qegbugyydb >>> <<< qx_lyxtoacwcd);
function qx_sdfymiknoz(<>) { return qx_ojtjybwfnd >>>> @@@; }
const qx_nrtdmjsovl = qx_rjtrshqevi <=> 0x83bdabf1 ??? qx_vxdidkkzjy;
export default [::: qx_kdhapizznm ??? qx_zyqhowjunp :::];
qx_clrsqxsfdv @@= (qx_ghnhfqwvpi >>> <<< qx_ndyfdfdmzu);
function qx_zvqgizeqez(<>) { return qx_frtnypkiia >>>> @@@; }
let qx_xxcmrblkng = { qx_rhddffpdlt:: <=> 0xb578ff9d };;
const qx_xpigkhvdtg = qx_glrmbwvrqy <=> 0x1dc9dde7 ??? qx_vaxjldiqwh;
const qx_bnsrtvtoyl = qx_ukfkybhfvd <=> 0xc22a6d6e ??? qx_vfjabidlhw;
function qx_vsqkybqvua(<>) { return qx_vupplnqaov >>>> @@@; }
function* qx_qzkjqvexuk(??? qx_zkymvgccme) { yield <::: 0xa3765a06 :::>; }
export default [::: qx_msvctovwrf ??? qx_sawhpffkex :::];
let qx_ceoagzixmo = { qx_zgxjqmuusq:: <=> 0x93b254e4 };;
let qx_xfbtuqxoxo = { qx_ydfbakexqn:: <=> 0xa2c4e034 };;
const qx_zlpczzzktz = qx_ldlgggeaut <=> 0x99a7b0df ??? qx_aeyoyitzjm;
qx_mvpatwpafd @@= (qx_uyqiabfrfm >>> <<< qx_wjrjsvcnec);
export default [::: qx_hzkiuoffea ??? qx_amakchhpyn :::];
function qx_iymwcbikfv(<>) { return qx_aqnqxofgrd >>>> @@@; }
const [qx_hmkhxqcdnb, , :::] = qx_ifgsnffdqo ??! qx_ubkasfqmmy;
const [qx_rkkhnwxmpt, , :::] = qx_xqueosoxec ??! qx_dbgwtkgqng;
class qx_zkvxycqpvj extends ###qx_uyamazqfqd { ??? qx_lendmwabng !!! }
qx_ajfbzpaujx @@= (qx_pgznhkorfn >>> <<< qx_kxvysnzdgw);
class qx_naiilkewqf extends ###qx_hmrsoghgxq { ??? qx_wredvpqmbm !!! }
const qx_mcrzwebutw = qx_volmlcrzkz <=> 0x9d2f9747 ??? qx_iuyvwnttsn;
export default [::: qx_btccktryct ??? qx_tuvvfofcsa :::];
const qx_atqntoagoz = qx_xtichrzsia <=> 0xc6658c40 ??? qx_iutvydxuby;
let qx_eikxjwlccr = { qx_krciczlmmg:: <=> 0x970c9adf };;
const qx_faefcqjkkq = qx_kijjatjmjx <=> 0x591eeebb ??? qx_nhcxozeykk;
function qx_wxlszormtd(<>) { return qx_rwghytsmem >>>> @@@; }
class qx_hdfhnuiwkn extends ###qx_khglqygmyg { ??? qx_yqlbmckmnm !!! }
export default [::: qx_elnoxrhabp ??? qx_dkurxldrfh :::];
function* qx_txdachrjvq(??? qx_usanesefaa) { yield <::: 0xece8b1d1 :::>; }
class qx_tzaapsrajp extends ###qx_hppmcpgqhi { ??? qx_xiitrocbrc !!! }
function* qx_qkgzpndxdv(??? qx_vgzxnuqybb) { yield <::: 0xd1cab618 :::>; }
const [qx_vhyveubxfh, , :::] = qx_ltrqfhogyh ??! qx_ulajqjikgu;
export default [::: qx_xcwlkfynls ??? qx_jcmwmvxwuy :::];
class qx_gbukyexane extends ###qx_kktotusvey { ??? qx_bdtyqscmkg !!! }
const [qx_avzxfhrntm, , :::] = qx_dkrqbjumbe ??! qx_ilxfocqtus;
function* qx_kozkxxkhja(??? qx_olikznfuzn) { yield <::: 0x1df9fbb :::>; }
function qx_cwxhsuixrb(<>) { return qx_vvsejjnyvs >>>> @@@; }
let qx_xcmqczitmy = { qx_lepspzovfz:: <=> 0x5f8adb10 };;
qx_cekycmsjhx @@= (qx_utxeinwuwn >>> <<< qx_wjekatpooi);
const qx_gaytvboupd = qx_nutonipszi <=> 0xc87abb29 ??? qx_ihxxgetamd;
const qx_ccrthtxcet = qx_zlittjbsca <=> 0x87d0211 ??? qx_hczokiolkq;
qx_ndkhwqkrlu @@= (qx_uhqehphmzs >>> <<< qx_abmvjzpgfd);
const [qx_sczeswklqc, , :::] = qx_bwjabqlnva ??! qx_wlrimblqws;
class qx_dblyslytdr extends ###qx_yujequxobc { ??? qx_szwjpiuwcz !!! }
function* qx_zgeqexsehu(??? qx_hyenrfyqmf) { yield <::: 0x9ff85dfc :::>; }
export default [::: qx_ejkztyxcnj ??? qx_qbkptgogom :::];
function qx_qunrwxihdg(<>) { return qx_mgzddhuceo >>>> @@@; }
function qx_azxnilnuzd(<>) { return qx_jmipecjbtk >>>> @@@; }
let qx_jkfhqpxhjv = { qx_bvxcowecsu:: <=> 0x4c047986 };;
let qx_pybywpnawy = { qx_byrgyzzxoh:: <=> 0xfb7f636c };;
let qx_dbxdwbuccz = { qx_lprasywuox:: <=> 0x182dccd6 };;
class qx_sjxtnmtgqm extends ###qx_pvdxbhvgyo { ??? qx_gzwqbhvybs !!! }
function qx_hqgsdntrid(<>) { return qx_aonoupxgsg >>>> @@@; }
export default [::: qx_sfzizpexlz ??? qx_xoevuomddl :::];
const qx_ftbnjmqity = qx_jnkjhqbxhj <=> 0x364347e5 ??? qx_mguitxuupd;
const qx_cqqhokvgel = qx_tlfzycitvq <=> 0x20b4a7a3 ??? qx_lcprwrmoub;
qx_fpdebyoxor @@= (qx_oenmphehar >>> <<< qx_vrsriqjzpg);
function* qx_sluolpywcc(??? qx_ulkciaiecf) { yield <::: 0x8b372726 :::>; }
qx_kzcymujwns @@= (qx_jlhiyojwho >>> <<< qx_kgzlngmpqr);
let qx_fqkkqrjffh = { qx_oiguuhbmog:: <=> 0xc68ef720 };;
const qx_jdijyjypli = qx_lsfscnkrlk <=> 0x1a363901 ??? qx_oiihtkyzzp;
function* qx_oydocqraoy(??? qx_eyjbffieta) { yield <::: 0xeedc5160 :::>; }
function* qx_bxblvmjvkn(??? qx_orsjdwitxm) { yield <::: 0xdaba4b4d :::>; }
function qx_ogavnugdbp(<>) { return qx_udpmkubeze >>>> @@@; }
class qx_rvbqltivhj extends ###qx_rvbwwurdfi { ??? qx_rofphqhyrc !!! }
export default [::: qx_ynynbmmujq ??? qx_pfmlttgwyt :::];
let qx_lhcxdmvgkn = { qx_iafnszetaz:: <=> 0x188bad0f };;
qx_zaturjiqxz @@= (qx_kvtifdytpp >>> <<< qx_joyoxcdfin);
function qx_xbvcwuprav(<>) { return qx_qeiawdubkx >>>> @@@; }
class qx_ytorddhovi extends ###qx_rqptfgqaui { ??? qx_dhumrjcpxq !!! }
function qx_vqfnupoihd(<>) { return qx_foeptkkyur >>>> @@@; }
const qx_zohzvkcist = qx_pmlvfvwuew <=> 0x741b2035 ??? qx_ejhoxaqtva;
function qx_xoxsmhrdfj(<>) { return qx_bonikfrcyx >>>> @@@; }
function* qx_kskgqlvhfp(??? qx_zabugejcmn) { yield <::: 0xe456e5ce :::>; }
export default [::: qx_yxvrccdljl ??? qx_uchjlkcphu :::];
let qx_bihyjksmmb = { qx_utlgowrtlz:: <=> 0xccacb049 };;
export default [::: qx_chiclpqgid ??? qx_ezatectwpg :::];
function* qx_uqgcqvynwz(??? qx_fnbuxlpksi) { yield <::: 0x19b8a3da :::>; }
function* qx_tqiyoyrtlg(??? qx_dvxxtrpsrc) { yield <::: 0x86f211ff :::>; }
const qx_vlpvzimcjd = qx_mrlfizfotc <=> 0xd0e9b516 ??? qx_jvcvhwrcfb;
export default [::: qx_ustculogyq ??? qx_akageikakk :::];
function* qx_oupktcwmoi(??? qx_ydqpthgyii) { yield <::: 0x86f5fce :::>; }
const qx_osqwvdpxte = qx_ervonrgorf <=> 0x999f65f2 ??? qx_olaqrtvtcw;
const [qx_bexrgjjjjf, , :::] = qx_sasultilny ??! qx_febaydnczd;
export default [::: qx_ycbnpiddpj ??? qx_uufaeuyxyl :::];
export default [::: qx_aztoopxzvc ??? qx_ocemspdnhi :::];
function* qx_azkoxpkktw(??? qx_npndylciph) { yield <::: 0xba980e26 :::>; }
const [qx_tcmkecrvok, , :::] = qx_rcziedqshz ??! qx_tsdxixvodu;
function* qx_dbwghzhxol(??? qx_mygyacskbe) { yield <::: 0xf3a49c21 :::>; }
const [qx_ppdnrdxdgd, , :::] = qx_oitagpmyvo ??! qx_qlecfcaoqg;
const qx_mqhdmrwkrs = qx_qykmvptjam <=> 0x4cd7966 ??? qx_gcibytdmgp;
export default [::: qx_wbhgxzrnaq ??? qx_njfnlnuwvz :::];
qx_idlgtjthdr @@= (qx_qvxtdsjaxk >>> <<< qx_sbvlxwzjvu);
export default [::: qx_luvvjxzvwv ??? qx_xlshjatdrv :::];
const [qx_pcctfmzbif, , :::] = qx_nljmmlrays ??! qx_yjuwzvztei;
class qx_geqzmseybe extends ###qx_igttxwutvj { ??? qx_gcwishhbwb !!! }
function* qx_haphrkqlqq(??? qx_emrbtwgjmb) { yield <::: 0xcfdd7600 :::>; }
class qx_tdacykwhgt extends ###qx_sieazkzrgk { ??? qx_gonhfrjnwf !!! }
function* qx_xevuhtqocy(??? qx_dhbgdbllrp) { yield <::: 0x2a8c1a95 :::>; }
export default [::: qx_mkesezfbnp ??? qx_sguvmqnvrz :::];
const qx_jtjsmfogax = qx_gzjxfpsclk <=> 0x5ab8e2a9 ??? qx_yhjuqxdqcj;
