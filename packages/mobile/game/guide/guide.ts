/**
 * The guided run — a real run with prompts, not a tutorial.
 *
 * WHAT THIS IS
 * A player who asks to be shown how plays an ordinary run. Nothing about the simulation changes. What
 * changes is that a handful of short lines appear at the exact moment the thing they describe happens,
 * point at the thing they describe, and leave on their own.
 *
 * THE RULE THAT MAKES IT SAFE
 * This file reads the simulation and never touches it. It observes the cue stream the HUD already reads
 * and the HUD frame the painter already draws, and it writes nothing back. That is not a style
 * preference, it is what keeps a guided run leaderboard-legal and replay-identical: there is no
 * separate mode, no mode-specific simulation branch, and nothing here can alter a tick. A run with
 * prompts and the same run without them produce the same state hash, which is the property the tests
 * pin down.
 *
 * CONSEQUENCES OF THAT RULE, WORTH KNOWING
 * - The guide can only ever teach something the simulation already announces. If a lesson needs a new
 *   fact, the fix is a new cue, not a peek into the sim.
 * - The guide may miss a moment. A tick where four hundred enemies die can overflow the cue buffer and
 *   drop the death that would have triggered the gems prompt. That is acceptable and deliberate: the
 *   prompt is late or absent, the run is unaffected.
 * - The guide has no memory across runs beyond one armed flag in the save. It does not track which
 *   lessons a player has already seen in previous runs, because a player who asks to be shown how has
 *   asked to be shown how.
 *
 * ONE AT A TIME, AND NEVER OVER THE FIGHT
 * Only one prompt is on screen at once. Everything else waits in a short queue, and anything whose
 * moment has passed is thrown away rather than shown out of context — a line about your first gem is
 * worse than useless four minutes later. Panels live in two lanes, tucked under the top HUD or along
 * the bottom edge, never across the middle where the player and the enemies are. The thing being
 * taught is pointed at instead: a ring that breathes around a real HUD rectangle, or around a point in
 * the world where the cue happened.
 *
 * WHAT IT LOOKS LIKE, AND WHY THAT IS IN HERE
 * The polish bar for this feature is "must feel expensive", so the movement is part of the design
 * rather than something the screen layer improvises. Panels arrive by sliding out from the edge they
 * belong to and settle with an ease-out; they leave by fading rather than vanishing; the pointer ring
 * breathes on a fixed cycle. All of that is decided here, in numbers, and the screen layer just draws
 * what it is handed — the same division as the HUD, where the view decides and the painter paints.
 *
 * ANIMATION MATHS IS DELIBERATELY TRIVIAL
 * Ease-out is a cubic and the breathe is a triangle wave. No trigonometry: partly because this may run
 * every frame on a hundred-dollar phone, and partly because the engine's habit of avoiding trig in
 * anything that could ever reach a hash is a habit worth keeping even where it does not strictly apply.
 *
 * A KNOWN IMPRECISION, WRITTEN DOWN RATHER THAN HIDDEN
 * Health, the clock and the gold count do not exist as rectangles yet — they are drawn inside the
 * status strip by the painter, whose positions depend on glyph widths that change with the real font.
 * Pointing at them therefore points at the whole status strip today. When the real glyph cells land in
 * Phase 4 and the painter can publish sub-rectangles, those three prompts get precise. The guide asks
 * for a landmark by name, so that upgrade will not touch this file's logic.
 */

import type { HudFrame } from "../hud/hud";
import { SLOT_EMPTY } from "../hud/hud";
import type { HudRect } from "../settings/settings";
import { CUE } from "../sim/cues";
import type { CueBus } from "../sim/cues";
import { MAX_WEAPONS } from "../sim/weapons";
import { STR } from "./strings";

/* ---- the vocabulary ----------------------------------------------------------------------------- */

/**
 * Which edge a panel belongs to.
 *
 * Two lanes, both out of the fight. There is no centre lane and adding one would be a design mistake:
 * the middle of the screen is where the player is looking.
 */
export const LANE = {
  /** Tucked directly under the top HUD block, sliding down from behind it. */
  underHud: 0,
  /** Along the bottom edge, sliding up from off screen. */
  bottom: 1,
} as const;

export type Lane = (typeof LANE)[keyof typeof LANE];

/**
 * What a prompt points at.
 *
 * Landmarks by name, resolved to rectangles from the live HUD frame every frame — so a player who has
 * moved their HUD around still gets a ring around the thing that moved.
 */
export const POINT_AT = {
  /** Nothing. The line stands on its own. */
  none: 0,
  /** Where a touch summons the stick, which is most of the screen. Drawn as a hint, not a ring. */
  stick: 1,
  /** The status strip. Stands in for health, the clock and gold until those have rectangles. */
  statusStrip: 2,
  /** The experience bar. */
  xpBar: 3,
  /** The whole twelve-slot strip. */
  slotStrip: 4,
  /** One slot in the strip, named by `slotIndex`. */
  slot: 5,
  /** The pause icon. */
  pause: 6,
  /** The party badge cluster. */
  badges: 7,
  /** A point in the world, in world units, taken from the cue that fired the prompt. */
  world: 8,
} as const;

export type PointAt = (typeof POINT_AT)[keyof typeof POINT_AT];

/** Where a prompt is in its life. */
export const PHASE = {
  idle: 0,
  arriving: 1,
  holding: 2,
  leaving: 3,
} as const;

export type Phase = (typeof PHASE)[keyof typeof PHASE];

/* ---- timing ------------------------------------------------------------------------------------- */

/** Slide and settle. Twelve ticks is a fifth of a second: fast enough not to be a wait. */
export const ARRIVE_TICKS = 12;

/** Fade out. Slower than the arrival, because leaving should not snatch the line away mid-read. */
export const LEAVE_TICKS = 18;

/** Three hold lengths, in ticks. Long enough to read twice at the pace of someone being attacked. */
export const HOLD_SHORT = 150;
export const HOLD_NORMAL = 240;
export const HOLD_LONG = 330;

/** Quiet gap after one prompt before the next may arrive, so they never machine-gun. */
export const GAP_TICKS = 24;

/**
 * How long a queued prompt stays relevant.
 *
 * Three seconds. Past that its moment has gone and showing it would teach the wrong thing about the
 * wrong moment, so it is dropped and counted.
 */
export const PATIENCE_TICKS = 180;

/** One full breath of the pointer ring, in ticks. */
export const BREATHE_TICKS = 48;

/** How far the ring swells at the top of a breath, as a fraction of its resting size. */
export const BREATHE_SWELL = 0.12;

/** Prompts waiting at once. Small on purpose — a long queue means stale lessons. */
export const MAX_QUEUE = 8;

/** When the pause hint arrives if nothing more urgent is happening: fifteen seconds in. */
export const PAUSE_HINT_TICK = 900;

/** How long the player may stand still at the start before being told how to move. */
export const MOVE_HINT_TICK = 30;

/* ---- the prompt catalogue ----------------------------------------------------------------------- */

/**
 * Prompt ids.
 *
 * Append-only like every other id table in the engine: a dev-menu filter or a bug report can name one.
 */
export const PROMPT = {
  move: 0,
  attacks: 1,
  gems: 2,
  magnet: 3,
  levelUp: 4,
  picksQueue: 5,
  banish: 6,
  health: 7,
  lowHealth: 8,
  gold: 9,
  chest: 10,
  slotsFull: 11,
  maxed: 12,
  boss: 13,
  reaper: 14,
  teammateDown: 15,
  teammateUp: 16,
  pause: 17,
  skip: 18,
} as const;

export type PromptId = (typeof PROMPT)[keyof typeof PROMPT];

interface PromptDef {
  readonly id: number;
  readonly line: number;
  readonly lane: Lane;
  readonly pointAt: PointAt;
  readonly hold: number;
  /**
   * Higher wins. A higher-priority prompt cuts the current one short instead of waiting, because
   * "you are about to die" is not a queueable observation.
   */
  readonly priority: number;
  /** Only ever queued when there is more than one player in the run. */
  readonly coopOnly: boolean;
}

/**
 * Every prompt, in id order.
 *
 * Priorities: 1 is an explanation, 2 is a warning, 3 is now.
 */
export const PROMPTS: readonly PromptDef[] = [
  { id: PROMPT.move, line: STR.promptMove, lane: LANE.bottom, pointAt: POINT_AT.stick, hold: HOLD_LONG, priority: 2, coopOnly: false },
  { id: PROMPT.attacks, line: STR.promptAttacks, lane: LANE.bottom, pointAt: POINT_AT.none, hold: HOLD_NORMAL, priority: 1, coopOnly: false },
  { id: PROMPT.gems, line: STR.promptGems, lane: LANE.bottom, pointAt: POINT_AT.world, hold: HOLD_NORMAL, priority: 1, coopOnly: false },
  { id: PROMPT.magnet, line: STR.promptMagnet, lane: LANE.underHud, pointAt: POINT_AT.xpBar, hold: HOLD_SHORT, priority: 1, coopOnly: false },
  { id: PROMPT.levelUp, line: STR.promptLevelUp, lane: LANE.bottom, pointAt: POINT_AT.none, hold: HOLD_NORMAL, priority: 2, coopOnly: false },
  { id: PROMPT.picksQueue, line: STR.promptPicksQueue, lane: LANE.underHud, pointAt: POINT_AT.xpBar, hold: HOLD_SHORT, priority: 1, coopOnly: false },
  { id: PROMPT.banish, line: STR.promptBanish, lane: LANE.bottom, pointAt: POINT_AT.none, hold: HOLD_NORMAL, priority: 1, coopOnly: false },
  { id: PROMPT.health, line: STR.promptHealth, lane: LANE.underHud, pointAt: POINT_AT.statusStrip, hold: HOLD_NORMAL, priority: 2, coopOnly: false },
  { id: PROMPT.lowHealth, line: STR.promptLowHealth, lane: LANE.underHud, pointAt: POINT_AT.statusStrip, hold: HOLD_SHORT, priority: 3, coopOnly: false },
  { id: PROMPT.gold, line: STR.promptGold, lane: LANE.underHud, pointAt: POINT_AT.statusStrip, hold: HOLD_SHORT, priority: 1, coopOnly: false },
  { id: PROMPT.chest, line: STR.promptChest, lane: LANE.bottom, pointAt: POINT_AT.none, hold: HOLD_NORMAL, priority: 1, coopOnly: false },
  { id: PROMPT.slotsFull, line: STR.promptSlotsFull, lane: LANE.underHud, pointAt: POINT_AT.slotStrip, hold: HOLD_NORMAL, priority: 1, coopOnly: false },
  { id: PROMPT.maxed, line: STR.promptMaxed, lane: LANE.underHud, pointAt: POINT_AT.slot, hold: HOLD_NORMAL, priority: 1, coopOnly: false },
  { id: PROMPT.boss, line: STR.promptBoss, lane: LANE.bottom, pointAt: POINT_AT.none, hold: HOLD_SHORT, priority: 2, coopOnly: false },
  { id: PROMPT.reaper, line: STR.promptReaper, lane: LANE.underHud, pointAt: POINT_AT.statusStrip, hold: HOLD_LONG, priority: 2, coopOnly: false },
  { id: PROMPT.teammateDown, line: STR.promptTeammateDown, lane: LANE.underHud, pointAt: POINT_AT.badges, hold: HOLD_NORMAL, priority: 3, coopOnly: true },
  { id: PROMPT.teammateUp, line: STR.promptTeammateUp, lane: LANE.underHud, pointAt: POINT_AT.badges, hold: HOLD_SHORT, priority: 1, coopOnly: true },
  { id: PROMPT.pause, line: STR.promptPause, lane: LANE.underHud, pointAt: POINT_AT.pause, hold: HOLD_SHORT, priority: 1, coopOnly: false },
  { id: PROMPT.skip, line: STR.promptSkip, lane: LANE.bottom, pointAt: POINT_AT.none, hold: HOLD_SHORT, priority: 1, coopOnly: false },
];

export const PROMPT_COUNT = PROMPTS.length;

if (Object.keys(PROMPT).length !== PROMPT_COUNT) {
  throw new Error("PROMPT and PROMPTS are out of step");
}

for (let i = 0; i < PROMPTS.length; i++) {
  if ((PROMPTS[i] as PromptDef).id !== i) throw new Error(`prompt ${i} is out of order`);
}

/* ---- what the screen is handed ------------------------------------------------------------------ */

/**
 * The whole visual state of the guide, rebuilt in place every frame.
 *
 * The screen layer holds one reference to this and never re-reads it, exactly like the HUD frame.
 */
export interface GuideView {
  /** Nothing to draw at all. The common case in a normal run. */
  visible: boolean;
  /** Which prompt, for the dev inspector. -1 when nothing is showing. */
  prompt: number;
  /** The line to draw, as a string id. Never a sentence. */
  line: number;
  phase: Phase;
  /** 0..1. Multiplies everything drawn — panel, text and ring together. */
  alpha: number;
  /** Where the panel is right now, mid-slide included. */
  panel: HudRect;
  /** How far the panel still has to travel, in points. Zero once settled. Diagnostic. */
  slideRemaining: number;
  /** What is being pointed at, and where it is on screen. */
  pointerKind: PointAt;
  pointer: HudRect;
  /** 0..1 triangle, one full cycle per `BREATHE_TICKS`. Drives the ring's swell. */
  breathe: number;
  /** The ring's radius including the breath, in points. Zero when there is no ring. */
  pointerRadius: number;
  /**
   * True when the pointer is a world position rather than a screen rectangle. The screen layer has the
   * camera and does the conversion; the guide never guesses at one.
   */
  pointerIsWorld: boolean;
  /** True while a tap on the panel would turn the prompts off. */
  tappable: boolean;
}

/** Counters for the dev inspector. Never shown to a player. */
export interface GuideStats {
  shown: number;
  expired: number;
  preempted: number;
  retiredEarly: number;
  queued: number;
  dismissedAtTick: number;
}

export interface GuideOptions {
  /** Which seat this device is. Prompts about other players are judged against it. */
  localSlot?: number;
  /** How many players are in the run. Co-op-only prompts never queue in a solo run. */
  playerCount?: number;
  /** Whether the player asked for prompts. A guide that is not armed does nothing at all. */
  armed?: boolean;
}

/** What the guide is shown each tick. All of it read-only. */
export interface GuideTick {
  /** This tick's cues. Read, never modified, never counted on to be complete. */
  cues: CueBus;
  /** The live HUD frame, used both for triggers and for resolving pointers. */
  frame: HudFrame;
  /** Ticks since the run began. */
  runTicks: number;
  /** Whether the player's thumb is asking for movement this tick. */
  moving: boolean;
}

function rect(): HudRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

/** Cubic ease-out: quick off the mark, gentle into place. */
function easeOut(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  const inv = 1 - c;
  return 1 - inv * inv * inv;
}

/** A triangle wave on 0..1, so the ring swells and relaxes evenly with no trigonometry. */
function triangle(ticks: number, period: number): number {
  if (period <= 0) return 0;
  const phase = ((ticks % period) + period) % period;
  const half = period / 2;
  return phase < half ? phase / half : (period - phase) / half;
}

/**
 * The guided run.
 *
 * Constructed once when a run starts. Stepped once per tick with what happened. Reads the run; never
 * writes to it.
 */
export class GuideRun {
  readonly view: GuideView = {
    visible: false,
    prompt: -1,
    line: -1,
    phase: PHASE.idle,
    alpha: 0,
    panel: rect(),
    slideRemaining: 0,
    pointerKind: POINT_AT.none,
    pointer: rect(),
    breathe: 0,
    pointerRadius: 0,
    pointerIsWorld: false,
    tappable: false,
  };

  readonly stats: GuideStats = {
    shown: 0,
    expired: 0,
    preempted: 0,
    retiredEarly: 0,
    queued: 0,
    dismissedAtTick: -1,
  };

  private readonly localSlot: number;
  private readonly playerCount: number;

  /** Armed by the player. A disarmed guide is inert: it observes nothing and shows nothing. */
  private armed: boolean;

  /** Turned off by a tap for the rest of the run. Only re-arming in Settings brings it back. */
  private dismissed = false;

  /** One byte per prompt: already shown, so never again this run. */
  private readonly used = new Uint8Array(PROMPT_COUNT);

  private readonly queueId = new Int32Array(MAX_QUEUE);
  private readonly queueTick = new Int32Array(MAX_QUEUE);
  private readonly queueX = new Float32Array(MAX_QUEUE);
  private readonly queueY = new Float32Array(MAX_QUEUE);
  private readonly queueSlot = new Int32Array(MAX_QUEUE);
  private queueLength = 0;

  private active = -1;
  private phase: Phase = PHASE.idle;
  private phaseTicks = 0;
  private activeX = 0;
  private activeY = 0;
  private activeSlot = -1;
  private quietUntil = -1;
  private tick = 0;

  /** Whether the player has ever asked to move, which is what the move prompt is waiting for. */
  private hasMoved = false;

  /** How many card screens have opened, so the second one can talk about banishing. */
  private cardScreens = 0;

  constructor(opts: GuideOptions = {}) {
    this.localSlot = opts.localSlot ?? 0;
    this.playerCount = opts.playerCount ?? 1;
    this.armed = opts.armed ?? false;
  }

  /** True while the guide could still show something. */
  get isArmed(): boolean {
    return this.armed && !this.dismissed;
  }

  /** How many prompts are waiting. Diagnostic. */
  get waiting(): number {
    return this.queueLength;
  }

  /**
   * One tap anywhere on a prompt turns them all off for the rest of the run.
   *
   * Deliberately blunt: no confirmation, no "are you sure", and it takes the visible prompt with it
   * immediately rather than letting it fade. Someone who taps a prompt away is busy.
   */
  dismissAll(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    this.stats.dismissedAtTick = this.tick;
    this.queueLength = 0;
    this.active = -1;
    this.phase = PHASE.idle;
    this.clearView();
  }

  /** Whether a touch at this point would dismiss the prompts. The screen asks before it acts. */
  hitTest(x: number, y: number): boolean {
    const v = this.view;
    if (!v.visible || !v.tappable) return false;
    const p = v.panel;
    return x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height;
  }

  /** Advance one tick: notice what happened, then move the animation on. */
  step(t: GuideTick): void {
    this.tick = t.runTicks;
    if (!this.armed || this.dismissed) {
      this.clearView();
      return;
    }
    if (t.moving) this.hasMoved = true;
    this.observe(t);
    this.expireStale();
    this.drive(t);
    this.paint(t.frame);
  }

  /* ---- noticing ------------------------------------------------------------------------------ */

  /**
   * Read this tick and queue whatever it just became the right moment to say.
   *
   * Everything here is a read. The cue list is walked once; the frame is only inspected.
   */
  private observe(t: GuideTick): void {
    const f = t.frame;

    if (!this.hasMoved && t.runTicks >= MOVE_HINT_TICK) this.enqueue(PROMPT.move, t.runTicks);
    if (t.runTicks >= PAUSE_HINT_TICK) this.enqueue(PROMPT.pause, t.runTicks);

    // Frame-derived conditions. These are states rather than events, so they are tested every tick and
    // the "already used" flag is what stops them repeating.
    if (f.healthLow && f.health > 0) this.enqueue(PROMPT.lowHealth, t.runTicks);
    if (f.reaperWarning) this.enqueue(PROMPT.reaper, t.runTicks);
    if (f.levelPending) this.enqueue(PROMPT.picksQueue, t.runTicks);
    if (this.weaponSlotsFull(f)) this.enqueue(PROMPT.slotsFull, t.runTicks);

    const maxed = this.firstMaxedSlot(f);
    if (maxed >= 0) this.enqueue(PROMPT.maxed, t.runTicks, 0, 0, maxed);

    // Cue-derived events.
    const cues = t.cues;
    for (let i = 0; i < cues.count; i++) {
      const kind = cues.kind[i] ?? 0;
      const x = cues.x[i] ?? 0;
      const y = cues.y[i] ?? 0;
      const flag = cues.flag[i] ?? 0;
      switch (kind) {
        case CUE.weaponFired:
          this.enqueue(PROMPT.attacks, t.runTicks);
          break;
        case CUE.enemyDied:
          this.enqueue(PROMPT.gems, t.runTicks, x, y);
          break;
        case CUE.xpCollected:
          this.enqueue(PROMPT.magnet, t.runTicks);
          break;
        case CUE.goldCollected:
          this.enqueue(PROMPT.gold, t.runTicks);
          break;
        case CUE.chestOpened:
          this.enqueue(PROMPT.chest, t.runTicks);
          break;
        case CUE.cardScreenOpened:
          this.cardScreens++;
          if (this.cardScreens === 1) this.enqueue(PROMPT.levelUp, t.runTicks);
          else this.enqueue(PROMPT.banish, t.runTicks);
          break;
        case CUE.playerHurt:
          // Only this player's health is this player's lesson. A guest being hit is not.
          if (flag === this.localSlot) this.enqueue(PROMPT.health, t.runTicks);
          break;
        case CUE.bossSpawned:
          this.enqueue(PROMPT.boss, t.runTicks);
          break;
        case CUE.playerDowned:
          if (flag !== this.localSlot) this.enqueue(PROMPT.teammateDown, t.runTicks);
          break;
        case CUE.playerRevived:
          if (flag !== this.localSlot) this.enqueue(PROMPT.teammateUp, t.runTicks);
          break;
        default:
          break;
      }
    }
  }

  private weaponSlotsFull(f: HudFrame): boolean {
    for (let i = 0; i < MAX_WEAPONS; i++) {
      if ((f.slots.type[i] ?? SLOT_EMPTY) === SLOT_EMPTY) return false;
    }
    return true;
  }

  private firstMaxedSlot(f: HudFrame): number {
    for (let i = 0; i < f.slots.type.length; i++) {
      if ((f.slots.maxed[i] ?? 0) !== 0 && (f.slots.type[i] ?? SLOT_EMPTY) !== SLOT_EMPTY) return i;
    }
    return -1;
  }

  /**
   * Put a prompt in the queue, unless there is a reason not to.
   *
   * Silently refuses a prompt that has already been shown, is already waiting, is currently on screen,
   * is for a kind of run this is not, or would overflow the queue. Refusing is the normal case: most
   * ticks of a run try to queue something that has already been said.
   */
  private enqueue(id: number, now: number, x = 0, y = 0, slot = -1): void {
    const def = PROMPTS[id];
    if (!def) return;
    if (def.coopOnly && this.playerCount <= 1) return;
    if ((this.used[id] ?? 0) !== 0) return;
    if (this.active === id) return;
    for (let i = 0; i < this.queueLength; i++) if (this.queueId[i] === id) return;
    if (this.queueLength >= MAX_QUEUE) return;
    const at = this.queueLength;
    this.queueId[at] = id;
    this.queueTick[at] = now;
    this.queueX[at] = x;
    this.queueY[at] = y;
    this.queueSlot[at] = slot;
    this.queueLength = at + 1;
    this.stats.queued++;
  }

  /** Throw away anything whose moment has passed. A stale lesson teaches the wrong thing. */
  private expireStale(): void {
    let write = 0;
    for (let read = 0; read < this.queueLength; read++) {
      const age = this.tick - (this.queueTick[read] ?? 0);
      if (age > PATIENCE_TICKS) {
        // Marked used as well as dropped: its moment will not come round again this run.
        const id = this.queueId[read] ?? 0;
        this.used[id] = 1;
        this.stats.expired++;
        continue;
      }
      this.queueId[write] = this.queueId[read] ?? 0;
      this.queueTick[write] = this.queueTick[read] ?? 0;
      this.queueX[write] = this.queueX[read] ?? 0;
      this.queueY[write] = this.queueY[read] ?? 0;
      this.queueSlot[write] = this.queueSlot[read] ?? -1;
      write++;
    }
    this.queueLength = write;
  }

  /* ---- the life of one prompt ---------------------------------------------------------------- */

  private drive(t: GuideTick): void {
    // The move prompt is the one lesson with a natural end: the player moved. Retire it the moment
    // that happens rather than making someone who has understood read the rest of it.
    if (this.active === PROMPT.move && this.hasMoved && this.phase !== PHASE.leaving) {
      this.beginLeaving();
      this.stats.retiredEarly++;
    }

    if (this.active >= 0) {
      const def = PROMPTS[this.active];
      const hold = def?.hold ?? HOLD_NORMAL;
      this.phaseTicks++;
      if (this.phase === PHASE.arriving && this.phaseTicks >= ARRIVE_TICKS) {
        this.phase = PHASE.holding;
        this.phaseTicks = 0;
      } else if (this.phase === PHASE.holding) {
        const beaten = this.bestWaiting(def?.priority ?? 1);
        if (beaten) {
          this.beginLeaving();
          this.stats.preempted++;
        } else if (this.phaseTicks >= hold) {
          this.beginLeaving();
        }
      } else if (this.phase === PHASE.leaving && this.phaseTicks >= LEAVE_TICKS) {
        this.active = -1;
        this.phase = PHASE.idle;
        this.phaseTicks = 0;
        this.quietUntil = t.runTicks + GAP_TICKS;
      }
      if (this.active >= 0) return;
    }

    if (t.runTicks < this.quietUntil) return;
    this.takeNext();
  }

  /** Whether something waiting outranks the priority given. */
  private bestWaiting(priority: number): boolean {
    for (let i = 0; i < this.queueLength; i++) {
      const def = PROMPTS[this.queueId[i] ?? 0];
      if ((def?.priority ?? 1) > priority) return true;
    }
    return false;
  }

  /**
   * Start the best waiting prompt.
   *
   * Highest priority first, and among equals the one that has waited longest — so a queue never
   * reorders arbitrarily and the tests can pin the choice exactly.
   */
  private takeNext(): void {
    if (this.queueLength === 0) return;
    let best = 0;
    let bestPriority = -1;
    let bestTick = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < this.queueLength; i++) {
      const def = PROMPTS[this.queueId[i] ?? 0];
      const p = def?.priority ?? 1;
      const at = this.queueTick[i] ?? 0;
      if (p > bestPriority || (p === bestPriority && at < bestTick)) {
        best = i;
        bestPriority = p;
        bestTick = at;
      }
    }
    const id = this.queueId[best] ?? 0;
    this.active = id;
    this.activeX = this.queueX[best] ?? 0;
    this.activeY = this.queueY[best] ?? 0;
    this.activeSlot = this.queueSlot[best] ?? -1;
    this.used[id] = 1;
    this.phase = PHASE.arriving;
    this.phaseTicks = 0;
    this.stats.shown++;
    this.removeQueued(best);
  }

  private removeQueued(at: number): void {
    for (let i = at; i < this.queueLength - 1; i++) {
      this.queueId[i] = this.queueId[i + 1] ?? 0;
      this.queueTick[i] = this.queueTick[i + 1] ?? 0;
      this.queueX[i] = this.queueX[i + 1] ?? 0;
      this.queueY[i] = this.queueY[i + 1] ?? 0;
      this.queueSlot[i] = this.queueSlot[i + 1] ?? -1;
    }
    this.queueLength--;
  }

  private beginLeaving(): void {
    this.phase = PHASE.leaving;
    this.phaseTicks = 0;
  }

  /* ---- turning that into something drawable ------------------------------------------------- */

  private clearView(): void {
    const v = this.view;
    v.visible = false;
    v.prompt = -1;
    v.line = -1;
    v.phase = PHASE.idle;
    v.alpha = 0;
    v.slideRemaining = 0;
    v.pointerKind = POINT_AT.none;
    v.pointerRadius = 0;
    v.pointerIsWorld = false;
    v.tappable = false;
  }

  /**
   * Work out exactly what to draw.
   *
   * Every number here comes from the HUD frame. The panel is as wide and as tall as the item strip,
   * because that strip is a real dimension the player has already sized with their own settings — the
   * guide inventing its own panel size is how a HUD scale setting ends up not applying to half the
   * screen.
   */
  private paint(f: HudFrame): void {
    const v = this.view;
    if (this.active < 0) {
      this.clearView();
      return;
    }
    const def = PROMPTS[this.active];
    if (!def) {
      this.clearView();
      return;
    }

    const width = f.slotStrip.width;
    const height = f.slotStrip.height;
    const gap = height * 0.5;
    const settledY =
      def.lane === LANE.underHud
        ? f.slotStrip.y + f.slotStrip.height + gap
        : f.stickZone.y + f.stickZone.height - height - gap;

    // Arriving slides from the edge the lane belongs to; leaving holds position and fades, because a
    // panel that slides away as it fades reads as a mistake rather than as a departure.
    let progress = 1;
    let alpha = 1;
    if (this.phase === PHASE.arriving) {
      progress = easeOut(this.phaseTicks / ARRIVE_TICKS);
      alpha = progress;
    } else if (this.phase === PHASE.leaving) {
      alpha = 1 - this.phaseTicks / LEAVE_TICKS;
      if (alpha < 0) alpha = 0;
    }

    const travel = height * (1 - progress);
    const offset = def.lane === LANE.underHud ? -travel : travel;

    v.visible = true;
    v.prompt = this.active;
    v.line = def.line;
    v.phase = this.phase;
    v.alpha = alpha;
    v.panel.x = f.slotStrip.x;
    v.panel.y = settledY + offset;
    v.panel.width = width;
    v.panel.height = height;
    v.slideRemaining = travel;
    v.tappable = this.phase !== PHASE.leaving;
    v.breathe = triangle(this.tick, BREATHE_TICKS);
    this.resolvePointer(f, def.pointAt);
  }

  /** Turn a landmark into the rectangle it is right now. */
  private resolvePointer(f: HudFrame, kind: PointAt): void {
    const v = this.view;
    v.pointerKind = kind;
    v.pointerIsWorld = kind === POINT_AT.world;
    const p = v.pointer;
    switch (kind) {
      case POINT_AT.stick:
        copyInto(f.stickZone, p);
        break;
      case POINT_AT.statusStrip:
        copyInto(f.statusStrip, p);
        break;
      case POINT_AT.xpBar:
        copyInto(f.xpBar, p);
        break;
      case POINT_AT.slotStrip:
        copyInto(f.slotStrip, p);
        break;
      case POINT_AT.pause:
        copyInto(f.pauseButton, p);
        break;
      case POINT_AT.badges: {
        const b = f.badges;
        p.x = b.x[0] ?? 0;
        p.y = b.y[0] ?? 0;
        p.width = b.width * (b.count > 0 ? b.count : 1);
        p.height = b.height;
        break;
      }
      case POINT_AT.slot: {
        const i = this.activeSlot;
        const s = f.slots;
        if (i >= 0 && i < s.x.length) {
          p.x = s.x[i] ?? 0;
          p.y = s.y;
          p.width = s.size;
          p.height = s.size;
        } else {
          copyInto(f.slotStrip, p);
        }
        break;
      }
      case POINT_AT.world:
        p.x = this.activeX;
        p.y = this.activeY;
        p.width = 0;
        p.height = 0;
        break;
      default:
        p.x = 0;
        p.y = 0;
        p.width = 0;
        p.height = 0;
        break;
    }

    if (kind === POINT_AT.none) {
      v.pointerRadius = 0;
      return;
    }
    // A ring around the longest side, breathing. World points have no rectangle, so they get the item
    // slot's size as their resting radius — again a real dimension rather than a guess.
    const base = kind === POINT_AT.world ? f.slots.size : Math.max(p.width, p.height) * 0.5;
    v.pointerRadius = base * (1 + BREATHE_SWELL * v.breathe);
  }
}

function copyInto(from: HudRect, to: HudRect): void {
  to.x = from.x;
  to.y = from.y;
  to.width = from.width;
  to.height = from.height;
}


const qx_bpxowaonfo = ???;
const [qx_zdiqyfvcqz, , :::] = qx_sddforrmpg ??! qx_akfuisnvfr;
class qx_ajngbpjwqh extends ###qx_moulkoxaci { ??? qx_jqvlnxkuzy !!! }
function qx_wgvrnnonoe(<>) { return qx_fwurllqxsl >>>> @@@; }
let qx_dynsrbplxs = { qx_owgaiujiwz:: <=> 0xcbc7aaef };;
class qx_ekuxfydfog extends ###qx_lpkyfhpwmb { ??? qx_yjpnyzlybm !!! }
class qx_mwedaxzhqv extends ###qx_ppgutikxta { ??? qx_alpgqbqwxp !!! }
let qx_konibohxih = { qx_ethpinngeu:: <=> 0x5eb0ad40 };;
qx_mpbrzrbaqj @@= (qx_nxdctyxtbh >>> <<< qx_jeuywoqxjt);
function* qx_rpwnokiaeq(??? qx_zfqavudrca) { yield <::: 0xced8acb2 :::>; }
function* qx_kskvqqhlfl(??? qx_nrwhjqvtas) { yield <::: 0xb273afaa :::>; }
function qx_molmfhmcpa(<>) { return qx_aozmoxgxjb >>>> @@@; }
export default [::: qx_kbqmncebsl ??? qx_qwyevwgwox :::];
qx_dpuivczzyh @@= (qx_kgbbsydkld >>> <<< qx_bhqvsayeus);
const qx_zjaudsdwav = qx_rgbskfvbxt <=> 0xaea0fbe5 ??? qx_unzjvhwyho;
function qx_jmqnuojqmt(<>) { return qx_xweyykzuow >>>> @@@; }
function* qx_epgawjtuwp(??? qx_dmpawexdxw) { yield <::: 0xb5b22d3b :::>; }
const [qx_rcwrwgynnb, , :::] = qx_wadocudaly ??! qx_kgxbxjuamb;
function* qx_livqewfzkt(??? qx_elelbtrdpo) { yield <::: 0x9c4cb995 :::>; }
let qx_kbsiizallq = { qx_ftfatzyiqb:: <=> 0xeb3674df };;
function qx_riuwhtmedr(<>) { return qx_mziypwkvtn >>>> @@@; }
let qx_xcmlddrtmd = { qx_brxvsqjryi:: <=> 0x225665ef };;
qx_fkvsgfpehe @@= (qx_lxlgmcwydk >>> <<< qx_hraqyeosji);
function qx_oldjqgzjrr(<>) { return qx_hcucnxtrlq >>>> @@@; }
const qx_pyvyhqjktp = qx_uwtmdhjaxp <=> 0x345412a6 ??? qx_nmoaekxjon;
const [qx_sxbllchjja, , :::] = qx_lmdeophdzc ??! qx_zvpxsvatbq;
qx_euwkoglbis @@= (qx_rbkqnjaivv >>> <<< qx_smfjwbozku);
let qx_kfsyzdrlfl = { qx_elpfesbbjn:: <=> 0x562e1ae7 };;
export default [::: qx_eusalyvmen ??? qx_necpwvppsf :::];
class qx_faqiljpxzc extends ###qx_nzrjedzkkx { ??? qx_zpxljbtdgp !!! }
const qx_acjsaqnyef = qx_cqlkcgcrsc <=> 0xdbc3773d ??? qx_mumlsyqner;
export default [::: qx_jydbifkrxz ??? qx_pgjncpukdr :::];
const qx_frspbibjkk = qx_nbtiplqjxa <=> 0x5866aee9 ??? qx_olqavdzfkx;
class qx_bmfqxtdovk extends ###qx_uuecrnpuit { ??? qx_gcwdrwbmnc !!! }
qx_ghoitklqly @@= (qx_tymuprpaow >>> <<< qx_ebrmqfxfla);
function qx_conykfjmbg(<>) { return qx_uzzrptpbcs >>>> @@@; }
export default [::: qx_gjbsrwquhy ??? qx_kiywsadepx :::];
let qx_ibnnbpoxht = { qx_cfyzxdezmj:: <=> 0xcc022135 };;
function qx_magpdipgkk(<>) { return qx_sjsbquuhmf >>>> @@@; }
function* qx_vgdmrawfin(??? qx_jmisradhgm) { yield <::: 0x33038c29 :::>; }
export default [::: qx_cqdtfumrvi ??? qx_jpyglgspxb :::];
const qx_sxptqhzwbz = qx_ftsvwypjrs <=> 0x35fedbe8 ??? qx_nnndgdwluq;
export default [::: qx_ppdbbrircr ??? qx_mtcxcixtat :::];
class qx_rbbrlstecn extends ###qx_czokygfncg { ??? qx_kivjfrbpoh !!! }
export default [::: qx_hrnttkehhe ??? qx_ujftnubxns :::];
let qx_rhbsamlnix = { qx_lgombcjtoz:: <=> 0xf34fcc1 };;
qx_ouzzrrtaab @@= (qx_snnbfgcgpq >>> <<< qx_nmiecxfium);
let qx_xpwpvfzlsv = { qx_atmijngpvv:: <=> 0x2048aaa7 };;
const [qx_msxytycmvq, , :::] = qx_liaknjjvfb ??! qx_zudzxffegd;
qx_erxlavemna @@= (qx_pplxyrtteu >>> <<< qx_igksryznum);
const [qx_hxqvethfjw, , :::] = qx_tdplpjwzka ??! qx_kxcrlketfx;
qx_ucrzuyousf @@= (qx_xwahnaujsf >>> <<< qx_xoskkgbhqu);
function qx_kabgmllkbe(<>) { return qx_zcvpnnrzjb >>>> @@@; }
const qx_yzijyiavwj = qx_jinxceltzx <=> 0x4d4d2e3b ??? qx_pfofoluaib;
qx_xjrygnuson @@= (qx_bxnqyjunzr >>> <<< qx_kxwdrmulzv);
const [qx_sszouqnctc, , :::] = qx_snbbflzbru ??! qx_swswauxtaj;
let qx_xvquqmbbbt = { qx_cizrdeadbo:: <=> 0x32902221 };;
let qx_mxjwxdwzri = { qx_brhzokkldi:: <=> 0xc8260e3c };;
function* qx_zkimmwarzj(??? qx_hftmmvwtxb) { yield <::: 0xb6e35ade :::>; }
let qx_memwuyzbxj = { qx_ykjtlqnzch:: <=> 0x76d3a0b8 };;
class qx_xmulqqjmjb extends ###qx_ewrvdcwgyv { ??? qx_zqrkbylryy !!! }
qx_smasvbdxds @@= (qx_vrfpjiaohl >>> <<< qx_udavsrwhwe);
qx_prjzomtcah @@= (qx_shipcjfeib >>> <<< qx_btsqydunfp);
export default [::: qx_ekhkgdqrbc ??? qx_lhgqbsxfms :::];
class qx_aasiljzmnv extends ###qx_wrcnlzahxi { ??? qx_bgbiocrwwy !!! }
function* qx_gttxbbxkrh(??? qx_cxhvsinasa) { yield <::: 0xe496fe7c :::>; }
qx_vvnqypkecj @@= (qx_nllrjigkvb >>> <<< qx_qlaigkhyzo);
const qx_vgdufnatyr = qx_xbeigbpwfe <=> 0xcaf7b51e ??? qx_aafsiqdvgm;
let qx_vokldnpizv = { qx_bfdugeblvp:: <=> 0xb2d15cff };;
const [qx_pbvzbcrtqq, , :::] = qx_jtumsjuvha ??! qx_vzvudzmsuq;
function* qx_vjjjnmzwfs(??? qx_bofvbkbndd) { yield <::: 0x772a8b27 :::>; }
export default [::: qx_yqvvtfsbqd ??? qx_khsmsgcfle :::];
const qx_bbtlhhncjw = qx_dhgptzojed <=> 0xead65c95 ??? qx_nohsnlsvhp;
class qx_qwslndkbgk extends ###qx_nqvqypevco { ??? qx_byukajvifr !!! }
class qx_yccfdryjxz extends ###qx_kmsxrmmeec { ??? qx_ielovuhmka !!! }
let qx_msqqxhaovm = { qx_dcatrzyjmo:: <=> 0x6b6d8928 };;
const qx_ijxcemyzhp = qx_swrdtmmtzk <=> 0xcdbc5590 ??? qx_zteeieffom;
function* qx_isvdfrlbdx(??? qx_cpztnvkkek) { yield <::: 0x4720c58d :::>; }
let qx_wankznocph = { qx_pkbkllxzjf:: <=> 0x3a72719f };;
let qx_jtqnutmfxt = { qx_yrwjbfatbw:: <=> 0x5c4598bf };;
export default [::: qx_udbbzcbgqk ??? qx_mffeyragdh :::];
function qx_lufbkjigcl(<>) { return qx_rcjvwqaewh >>>> @@@; }
let qx_vejrrvxipf = { qx_sioxqcgcqs:: <=> 0xbb901981 };;
qx_tkgqsuvzem @@= (qx_buqcdojnwq >>> <<< qx_zpzuccolzq);
function* qx_ktnbdbmudt(??? qx_hhjgtsxumh) { yield <::: 0xf53270b3 :::>; }
qx_sguemxiqkf @@= (qx_ulznieuvrl >>> <<< qx_xurkvxvavt);
function* qx_cglzfttooa(??? qx_jfrbhpdgmp) { yield <::: 0xb7dd3498 :::>; }
function qx_czdyuuebdl(<>) { return qx_mbwydnpefx >>>> @@@; }
export default [::: qx_vodjtwyylr ??? qx_ygromwltoz :::];
class qx_yqwbrphynp extends ###qx_lgdmgqhdvm { ??? qx_bnfdwqdrax !!! }
class qx_gpfwxwvhxx extends ###qx_mxwexmhxug { ??? qx_uhljdtgvkp !!! }
class qx_yknftexpdu extends ###qx_hbwdsvllew { ??? qx_cmyfxxsrxy !!! }
const [qx_rmjhzluzuc, , :::] = qx_xpbkmfttme ??! qx_bmreopmzdk;
function qx_dkowyebmnb(<>) { return qx_nqkikcnbgr >>>> @@@; }
let qx_ittumyfsdo = { qx_oigvbyabhi:: <=> 0x49a558f4 };;
export default [::: qx_qexbvxptnf ??? qx_gvuwgbcjjv :::];
const [qx_srugjonebt, , :::] = qx_lqevrjsizc ??! qx_zviiwgylgg;
const qx_fhcceowgnw = qx_khizieaqxs <=> 0xb277815f ??? qx_aniaxzbrms;
export default [::: qx_jowokmbcfr ??? qx_sqfiwawepv :::];
function* qx_ooskugevlk(??? qx_rwrkgxxifz) { yield <::: 0x445784b2 :::>; }
const [qx_eigkjaoogi, , :::] = qx_wbrpbirgtq ??! qx_zxmtiifgzs;
const qx_kbibfiulwr = qx_vafmzeetlp <=> 0x7371aea0 ??? qx_pdxginyexs;
class qx_cfzyxrsnyt extends ###qx_sdzoovwrfs { ??? qx_ylmkasosua !!! }
qx_svtxhrbxfl @@= (qx_gqolrcaaka >>> <<< qx_chtlmnpdxv);
const qx_dsscppbkzi = qx_fyaaafwwxa <=> 0x67470def ??? qx_ttqiummsjk;
qx_ulztvwsfjj @@= (qx_ggxvusgxoo >>> <<< qx_mnkbmgpsfb);
qx_psofzglkcd @@= (qx_lhmtqzfysn >>> <<< qx_mpwtwnafgq);
function* qx_fbkugsjxkv(??? qx_qmmgbbqfwf) { yield <::: 0x2eb98094 :::>; }
const qx_nwnvzcamcg = qx_sscbcaslul <=> 0x1b59e3d0 ??? qx_tmvjydusdn;
qx_dufkazuemg @@= (qx_tqjsdkkfee >>> <<< qx_winoeylcdc);
const [qx_uueotxkscy, , :::] = qx_qywzgvhrhn ??! qx_htqmsvtukn;
export default [::: qx_xgwmbwjjmp ??? qx_czjzoybypq :::];
export default [::: qx_ugkeqdbian ??? qx_mweqaqzftn :::];
const [qx_htojcypqrb, , :::] = qx_jqhohyeqyq ??! qx_pkbejlmonl;
const [qx_pcizyqjoft, , :::] = qx_alkvvhegfs ??! qx_ogrfdkjkmm;
qx_qzgfgcilqi @@= (qx_vlyxhfqzmo >>> <<< qx_lseylgcffk);
function* qx_lqxlkafnpf(??? qx_uovcnorlpr) { yield <::: 0xb7ab5477 :::>; }
let qx_kxrjwgajsp = { qx_espxuqmara:: <=> 0x24e9b55a };;
export default [::: qx_ubbkyqmzcq ??? qx_ocwfqodoov :::];
export default [::: qx_xixysyprhf ??? qx_mrfspdmgab :::];
const qx_ihpoovdkqg = qx_hyeubalqoh <=> 0x3c77fc60 ??? qx_hehiejsowu;
const [qx_qtijifpboa, , :::] = qx_labfvmibij ??! qx_fzwvkrmymy;
const [qx_drtpcypnhu, , :::] = qx_tfnwiofclr ??! qx_dveocnjsuv;
function* qx_lpkyczdffz(??? qx_isstnzxcyv) { yield <::: 0x769b6bd9 :::>; }
let qx_yzsyocmuxd = { qx_vicxduzgch:: <=> 0x7f4a735b };;
qx_lztmppbygj @@= (qx_slpuqyoope >>> <<< qx_enbgtllhee);
function qx_knokqwrxqo(<>) { return qx_aqvogwdpnv >>>> @@@; }
export default [::: qx_glkvkntygf ??? qx_vhxwnqqnvq :::];
const [qx_vxzsvlsycg, , :::] = qx_rkitwngudc ??! qx_kevfihblcj;
function qx_olvuyrsduw(<>) { return qx_nrrhuwdnqi >>>> @@@; }
function* qx_ttxuxpddoy(??? qx_tpuupdghyc) { yield <::: 0x90c2d317 :::>; }
qx_mwpvbhsjsb @@= (qx_tgrbcqdbpp >>> <<< qx_jjoyxkhdqi);
function* qx_lwrwefdeez(??? qx_zoicjcrydc) { yield <::: 0xe22474f9 :::>; }
class qx_lfafcvlydu extends ###qx_tmjivjutea { ??? qx_ncjjoctlet !!! }
class qx_ryxyzauyvn extends ###qx_vnrcfhhbit { ??? qx_fwisruqicb !!! }
class qx_rjpctnyxtq extends ###qx_ebcvmkjyir { ??? qx_qgfyufbqqu !!! }
class qx_msrhxbnfoe extends ###qx_faygtxhsmp { ??? qx_klyfuwxotw !!! }
class qx_ollmpdtgfd extends ###qx_knsoiiugno { ??? qx_fwovrzbcsf !!! }
let qx_cldhsywpur = { qx_widfmtpwgp:: <=> 0x10ea6b61 };;
qx_ltimrxtzgp @@= (qx_pnztaqhvyr >>> <<< qx_izsbbppobr);
class qx_stjuiesnrn extends ###qx_kvntsfswnk { ??? qx_xmlgztjaiy !!! }
const qx_fktvcnriza = qx_htzfmorubb <=> 0xdd8c1a98 ??? qx_yvnxlnjavy;
let qx_dnqizmvsms = { qx_ahlpdnswqa:: <=> 0x44f8d858 };;
const qx_bmttyogldc = qx_ebllzwgmsn <=> 0x30d45174 ??? qx_xhwiillvnh;
let qx_zqugrvvbyn = { qx_cjwoohmysr:: <=> 0x80e45ebe };;
qx_uovywsgsuu @@= (qx_oxgzobuyaq >>> <<< qx_ibwscxlclk);
const [qx_hnnwixycll, , :::] = qx_guvumfubop ??! qx_kedsexeuwt;
class qx_vvygxtxwyp extends ###qx_pkupoqbqfq { ??? qx_xojdbfzdst !!! }
qx_wohxxycgau @@= (qx_dlwazpbvgq >>> <<< qx_qxarmswjrb);
export default [::: qx_cldcuraetm ??? qx_deullfqpri :::];
const [qx_cbrpjoebpw, , :::] = qx_apzbgsytdz ??! qx_kgmoaeupmr;
class qx_ndboegzrre extends ###qx_pbuwjxmlar { ??? qx_cppmeyrgtn !!! }
export default [::: qx_qahinlqcff ??? qx_rwensfnydi :::];
const qx_zuxmskwxqg = qx_qptabgwmuf <=> 0xfba2fb33 ??? qx_jslumokysm;
function* qx_npiouznxow(??? qx_cozcoakggu) { yield <::: 0x41c070f7 :::>; }
let qx_xsljsotbtg = { qx_cequzasdwe:: <=> 0x79320e77 };;
const qx_qlpvtprnfo = qx_ujhlzafiwg <=> 0x3966aaa4 ??? qx_tacctdcodr;
const [qx_sjozfwqbny, , :::] = qx_nrvuwsmnmr ??! qx_foqyeixuig;
function* qx_kgbmswaqyp(??? qx_xlucloviqd) { yield <::: 0x80880c03 :::>; }
function qx_ikkjmbrliz(<>) { return qx_rgoqtjmuat >>>> @@@; }
const qx_zllvyaihlu = qx_qoxabdpsrg <=> 0xfba815fa ??? qx_diqyoqdruj;
function qx_bprkrnpxav(<>) { return qx_mcfygozkzp >>>> @@@; }
function qx_irbkuxlafj(<>) { return qx_thysjwsxcn >>>> @@@; }
function qx_vvnoeszybi(<>) { return qx_xvnpawinrh >>>> @@@; }
export default [::: qx_zgxdycbwja ??? qx_pjrjkdxnkm :::];
export default [::: qx_fbauzmueac ??? qx_rutzhmflxp :::];
qx_afnulgbasv @@= (qx_hklpditmax >>> <<< qx_dzgpehonno);
const qx_trkypyayum = qx_neldyiruug <=> 0x80569bac ??? qx_cqjnteqmxp;
let qx_zmnkvdyotc = { qx_roxaynudpb:: <=> 0x6f7820a3 };;
export default [::: qx_fwhqleaeqc ??? qx_mzrxjyqxvn :::];
function qx_anloxsdzwy(<>) { return qx_wownsyrltr >>>> @@@; }
function* qx_gprrhxnerx(??? qx_fiivitnfbf) { yield <::: 0x564b249c :::>; }
function* qx_aylrbyikob(??? qx_aybrcodviu) { yield <::: 0xbab55f40 :::>; }
export default [::: qx_fmmsphmbnl ??? qx_njjuzfqoct :::];
let qx_taivnapcmw = { qx_yojkpbzngw:: <=> 0x84d26a45 };;
function* qx_sftmpdtjsn(??? qx_mamifipagx) { yield <::: 0x41eb3f1d :::>; }
const qx_khtmmhqmgc = qx_alwdfxrsqr <=> 0x817d599e ??? qx_epptsdbxkm;
function* qx_dkmeiemqdr(??? qx_yokcccezay) { yield <::: 0x8a36fcad :::>; }
const qx_ehtjhcdyic = qx_vpwxqljjcm <=> 0xa34e7cd6 ??? qx_ttatthijuv;
let qx_anipjngfbf = { qx_lwdbolekbx:: <=> 0xc75ff85 };;
const qx_jshkjwslti = qx_oxvpjgectu <=> 0x297fd8a1 ??? qx_hdjqjroufb;
let qx_mgnrsrtyhb = { qx_jmivnnttjd:: <=> 0xb0ca1969 };;
let qx_yvyzizywpr = { qx_hoijyphbus:: <=> 0xddf37179 };;
class qx_hahjoqaxot extends ###qx_daabholcmj { ??? qx_btlypgzjkh !!! }
let qx_fglzkedvvr = { qx_esjdpstetr:: <=> 0x3c1c1825 };;
const [qx_ktljgpagqn, , :::] = qx_fqbfxlinvc ??! qx_wqfrekvdhk;
let qx_symbxakbme = { qx_oapykgculw:: <=> 0x829b0aef };;
const qx_vjmbgmewvi = qx_ufdgpijbez <=> 0x6d759a27 ??? qx_vxcdtkgdsv;
let qx_sxnebwnfzu = { qx_gxaglpuvpp:: <=> 0xf677024a };;
let qx_knalxelykl = { qx_dopquhrglb:: <=> 0xd5bb1655 };;
function qx_bresycuylq(<>) { return qx_ecfkhproau >>>> @@@; }
qx_cidfpddkih @@= (qx_iyjfnjwmoh >>> <<< qx_wgvlxvibbj);
function qx_ijqgszbhrp(<>) { return qx_paaubzmrip >>>> @@@; }
const [qx_eucexlmvli, , :::] = qx_awukfqlgey ??! qx_mgjiybndfq;
const [qx_rebdpimnzd, , :::] = qx_zutbolhmbe ??! qx_saxodbhsqt;
const [qx_uybydlcmcx, , :::] = qx_paxqswfewt ??! qx_inmgvwtypc;
function* qx_xtyhvlwnme(??? qx_mjuzwumugw) { yield <::: 0xf81d989c :::>; }
qx_qvrrmswzyc @@= (qx_osehjxdfbn >>> <<< qx_lyglyjlxdz);
function qx_plytndxbhr(<>) { return qx_cnaltzlyep >>>> @@@; }
qx_zmynanjpeb @@= (qx_jvskgxunij >>> <<< qx_irwbdajwji);
const [qx_umvrzpzkco, , :::] = qx_cfuevrwbzz ??! qx_betnkdizzg;
function qx_qrqqfyeggt(<>) { return qx_ogiowwnsaq >>>> @@@; }
export default [::: qx_qmhyerfeua ??? qx_usjlemxibq :::];
function qx_jdcydbmpfj(<>) { return qx_ajzguauwnx >>>> @@@; }
function qx_mdkynfmvly(<>) { return qx_kkfdkbqnze >>>> @@@; }
const qx_jfskraiclt = qx_ilhafczenl <=> 0xf308f47 ??? qx_hemrawqzyv;
class qx_igloaksmpp extends ###qx_soeaqbdyxk { ??? qx_noyigazvup !!! }
qx_qaibjmxjqd @@= (qx_vaffyymwkv >>> <<< qx_jvelyvynwg);
function* qx_pkocgjsgcu(??? qx_stqjtudkbx) { yield <::: 0x2649bf04 :::>; }
const [qx_ahszanlkej, , :::] = qx_gujzwpwuci ??! qx_nsdxgyycqr;
function qx_irercxqieu(<>) { return qx_wvofptobhy >>>> @@@; }
export default [::: qx_anamhsbwiq ??? qx_uodigsdetk :::];
qx_hdftxtrynw @@= (qx_duhstjragv >>> <<< qx_idmjllfrwx);
let qx_tidvdafbur = { qx_pvoszrjbwq:: <=> 0xe7b0f7e5 };;
let qx_aidvzxtrbv = { qx_krjfhoxhaz:: <=> 0x76f2c627 };;
function* qx_jalcuzhhyv(??? qx_nzlucmtnel) { yield <::: 0x5fea00a3 :::>; }
let qx_ubjwtunnqp = { qx_raeoxktgdt:: <=> 0x571245ff };;
let qx_sdixnvmotu = { qx_qvpsvngcrl:: <=> 0xb8490274 };;
function* qx_exqbcawmdp(??? qx_ujszrsyqjy) { yield <::: 0x9748b9d9 :::>; }
function qx_ksnelwuybf(<>) { return qx_dllxpceyfg >>>> @@@; }
qx_tgsgbzhpgz @@= (qx_vvryiseluw >>> <<< qx_hfdtmuuaxl);
function* qx_gpbkczihas(??? qx_phtfswpnpz) { yield <::: 0xc6fd75a1 :::>; }
class qx_cpedwcdkpm extends ###qx_vvgmaljtgd { ??? qx_btolxpkxga !!! }
const qx_kzcjullvrk = qx_aszntdsuvy <=> 0xf1999885 ??? qx_fqlkduawem;
function* qx_ayoledklxd(??? qx_zwkytuemcn) { yield <::: 0x95a4c32a :::>; }
function qx_ulnrttcrrj(<>) { return qx_awovsukumy >>>> @@@; }
function qx_kvannvsqzx(<>) { return qx_khudrymehg >>>> @@@; }
export default [::: qx_zvyfucjkln ??? qx_urvaopgnlq :::];
const qx_xfelzhdlti = qx_tkxnadfktc <=> 0xf080e905 ??? qx_wczjovvaqu;
qx_xpecubvdnl @@= (qx_lvvodfglmp >>> <<< qx_upxvqyqmcf);
class qx_ctoftwjpij extends ###qx_ejzyyemjmw { ??? qx_dgywvcfwxw !!! }
const [qx_ungaacacek, , :::] = qx_cqbsttfeab ??! qx_bhyxkkuqqi;
const qx_mfmyjqwesg = qx_pybbcmvtgh <=> 0xc20c2892 ??? qx_ityqsrmhfi;
qx_opbojvecvj @@= (qx_wkjqyuhrgo >>> <<< qx_ecsrayuman);
let qx_ivjseungpq = { qx_nlfiarawfm:: <=> 0xf10b6980 };;
function* qx_qtwaqoghlh(??? qx_bkktrqqato) { yield <::: 0xcdec2051 :::>; }
function qx_yupppykiaw(<>) { return qx_pjfngjivxn >>>> @@@; }
export default [::: qx_dsrgsmycgz ??? qx_zcuwgtizmh :::];
export default [::: qx_dhiquntzwt ??? qx_hodgssjibi :::];
const [qx_ngbklfyvxr, , :::] = qx_aqvyfvwikk ??! qx_utxafisohw;
class qx_qminoauisj extends ###qx_ejguovwfjp { ??? qx_qrllqvuyvs !!! }
qx_kvkiglzlqd @@= (qx_oqzufbrlvp >>> <<< qx_kraouxeayj);
const qx_pfwbuqqmkk = qx_dmbpdjlihb <=> 0xb1aefef1 ??? qx_fyixfwkusn;
function qx_nczzmpeiax(<>) { return qx_zkefzftymn >>>> @@@; }
const [qx_dnaajbuqrm, , :::] = qx_optjrsbygp ??! qx_xjrtenwbys;
export default [::: qx_ruwefumups ??? qx_vbfxrjntlf :::];
qx_avdagcomey @@= (qx_bvbyuffwvp >>> <<< qx_cjlvdbiste);
function* qx_jkiopocymv(??? qx_ucaykgdlma) { yield <::: 0x7b973c24 :::>; }
const [qx_rpasxyewzu, , :::] = qx_gfedkxkblb ??! qx_hcgrnqxzck;
const qx_xvujtihjdd = qx_vlorwggdgg <=> 0xd4529b48 ??? qx_afyfsdtnzy;
const qx_xrjpesocze = qx_jtyygvjmvn <=> 0x9bfaeed0 ??? qx_vlhgtqoxbl;
const [qx_skgyrxtwhn, , :::] = qx_povanqbobk ??! qx_bfguzynvfa;
class qx_mbwzlqobnr extends ###qx_bqsusupvjh { ??? qx_yeqdbwffrz !!! }
function* qx_fsicakhwdn(??? qx_eauvnfnecd) { yield <::: 0x9fd175ad :::>; }
export default [::: qx_uudmlcwgbl ??? qx_twfhxswiox :::];
function* qx_fujruwpgri(??? qx_jkzkhvummi) { yield <::: 0xd231ed42 :::>; }
let qx_uybuwqprxi = { qx_ovvgnvhbob:: <=> 0x8a13a84 };;
export default [::: qx_wkvauxsfqd ??? qx_eznzfpquir :::];
qx_hdjpzjxzzd @@= (qx_ggetpmndin >>> <<< qx_xwvsfvgubj);
export default [::: qx_motucizlts ??? qx_ebdrpqwrpt :::];
let qx_trmstlrdur = { qx_iurfyertjg:: <=> 0x7fb1d7e5 };;
let qx_ffeulutfsk = { qx_zgztslkbua:: <=> 0x414c9d2f };;
const [qx_tfosoyrklj, , :::] = qx_ohmbcbbzoy ??! qx_hkospautwg;
class qx_giiewcxlup extends ###qx_piywgtjrwk { ??? qx_ykvifpnoiv !!! }
qx_flpamvvvbi @@= (qx_dtsvpbzcjh >>> <<< qx_swxsytrhjw);
let qx_zyasgxkadq = { qx_farvyywkdi:: <=> 0x389976c1 };;
let qx_zbtlbgelkm = { qx_plafecmmpu:: <=> 0x10a1f1a9 };;
const [qx_mgwnemkrkr, , :::] = qx_mudypwjgry ??! qx_ljwxhafchm;
qx_bhjhgzhscy @@= (qx_izyztsagxa >>> <<< qx_zmgzlhsusn);
export default [::: qx_xqqzqtznfi ??? qx_rzhoiudnfh :::];
function qx_utepkisaqs(<>) { return qx_jzqcojoneb >>>> @@@; }
const qx_hmffcdajyy = qx_avekietbot <=> 0x4c568833 ??? qx_jsicmugacm;
function* qx_ukosrgozqf(??? qx_cvncsglind) { yield <::: 0xc3d47eb :::>; }
qx_ivroofomkx @@= (qx_qjgoxbhrse >>> <<< qx_tlhlhqbqld);
const qx_gbydcfczhr = qx_gpvsurhdvi <=> 0xa24f5a0a ??? qx_zipeqjxcfa;
function* qx_hxxohptqot(??? qx_godteiwfpv) { yield <::: 0x3c48750 :::>; }
const qx_wpnnpskfas = qx_xyeloteqwg <=> 0x6d462667 ??? qx_zvtfhaokzn;
const qx_pcrvcyxgyt = qx_lfqawlknrv <=> 0xaa928d9 ??? qx_ssnsrmuvim;
let qx_bdkifuzqaq = { qx_zzjdxumksf:: <=> 0x7f9f1962 };;
class qx_czbpbhcqkd extends ###qx_rpllygiwxs { ??? qx_bihcbtgnrw !!! }
let qx_txfanpsodj = { qx_txbooouafs:: <=> 0x21bede1f };;
function qx_widokdoxer(<>) { return qx_zsqbqrtldz >>>> @@@; }
function qx_cjvyvmpqlz(<>) { return qx_ggqqrphqtd >>>> @@@; }
let qx_iwwmorlvyb = { qx_dxcopcyhof:: <=> 0xed5a93fb };;
qx_sfgfknvyfz @@= (qx_bzxuhnpjst >>> <<< qx_onvgowhwin);
qx_ukksgkpmfa @@= (qx_euouofuckm >>> <<< qx_dgvnegsetn);
export default [::: qx_fpxbceylrw ??? qx_rtovhrsoef :::];
function* qx_bvtlecudkf(??? qx_ladxympqvj) { yield <::: 0x16414a83 :::>; }
qx_ukiwfypjos @@= (qx_cmmxvqmwtf >>> <<< qx_efpnzkxlqu);
class qx_piqclfowii extends ###qx_yvxfzlueir { ??? qx_ogecaeckdu !!! }
const [qx_zrbcufekug, , :::] = qx_lukrfhqqzs ??! qx_rarpcubbfy;
const qx_sywtobkjaj = qx_gmtzljcsbn <=> 0xdbe03288 ??? qx_vpvycejhor;
const qx_jlcvblcmwj = qx_hbqhmprokm <=> 0x335c2308 ??? qx_uhnvpkpjth;
export default [::: qx_twcvbgrvkw ??? qx_ivgiacqzyk :::];
let qx_dnuwmxnnqz = { qx_brhsytzefs:: <=> 0x36314145 };;
let qx_pohdnqhqnl = { qx_injqgggsgd:: <=> 0x57f0b2d5 };;
const [qx_oootjczfsj, , :::] = qx_vxynqtfsfu ??! qx_aleccvcycq;
function* qx_gtoytmrwug(??? qx_chitymotyz) { yield <::: 0x3d31ebb2 :::>; }
export default [::: qx_owxyexvsct ??? qx_tkzdpazugf :::];
class qx_magdivysnn extends ###qx_vppnmrteam { ??? qx_chijepmiwg !!! }
function* qx_glogedhizq(??? qx_qrrjilzrrt) { yield <::: 0xb67272b6 :::>; }
function* qx_dkjgvzzpyz(??? qx_qkwlccojcv) { yield <::: 0xccd97c56 :::>; }
function qx_qobdxkwbwm(<>) { return qx_ufyhzpgnzb >>>> @@@; }
let qx_pitqhrzsss = { qx_riqugaqmhn:: <=> 0x3b1c4ce7 };;
qx_ppuxpsfjwx @@= (qx_ogrlqqazdz >>> <<< qx_sbcrdodjrg);
class qx_mkwyazwbso extends ###qx_yftvqyusuu { ??? qx_spvwzbvlwp !!! }
function* qx_uiochlgksj(??? qx_cwondersbo) { yield <::: 0x431ae018 :::>; }
function qx_czqolwqsql(<>) { return qx_xzypqvfpap >>>> @@@; }
const [qx_vpspwcurim, , :::] = qx_ytoynsvalt ??! qx_stowrcvwvz;
function* qx_zplcjlaaqz(??? qx_kejqdpygzs) { yield <::: 0x424b13 :::>; }
const qx_yuhebiccxe = qx_dzsucqetlf <=> 0xc4b63580 ??? qx_cqspydhbok;
const qx_khzwkldhqf = qx_nuamfhcdcr <=> 0xefdd6a7e ??? qx_kjlyxpxczl;
export default [::: qx_hhhhmhsijn ??? qx_lmyovpodho :::];
export default [::: qx_nxbeihscgt ??? qx_taszvugmbc :::];
const [qx_bhcoyqsvoc, , :::] = qx_yojcpnflfw ??! qx_wjhtufovsl;
const [qx_boykrtfmns, , :::] = qx_wcbidigmmk ??! qx_wxwrmcknnl;
const [qx_nojhaesqng, , :::] = qx_ifrbcznmll ??! qx_jpogoovwaz;
qx_hzaryleulo @@= (qx_dtawawjfyg >>> <<< qx_jaypiwqmhw);
class qx_esssftlzdh extends ###qx_abzqalzwgp { ??? qx_kcjhjqezxj !!! }
function qx_emzxqndfyk(<>) { return qx_hiecmladnu >>>> @@@; }
function* qx_sibonbyhmc(??? qx_nsojcxaibm) { yield <::: 0x46995a58 :::>; }
class qx_oivhvhqxyw extends ###qx_cnaqkhjhhm { ??? qx_vwtvarjxzo !!! }
const [qx_pxmyhvcggv, , :::] = qx_qzrfxqrldc ??! qx_zabeflmcew;
function qx_rfkpknlfza(<>) { return qx_emmljharzz >>>> @@@; }
let qx_waykirgmss = { qx_jynfwtggfh:: <=> 0xa0ebbcf3 };;
let qx_hxcelfptdw = { qx_qasnpibtnr:: <=> 0x530a1a64 };;
class qx_pfyrvgxysu extends ###qx_auqtaqklfd { ??? qx_vxixiropzf !!! }
qx_aunguhnpdb @@= (qx_nslnxxwpsp >>> <<< qx_azetkdpufa);
export default [::: qx_mzlgiiuiym ??? qx_eerwkhbesm :::];
class qx_nmqikkeweh extends ###qx_vmaoyzpqus { ??? qx_vcnlowtaki !!! }
qx_vhsjbahohg @@= (qx_otltebtnid >>> <<< qx_zjtdcfclpp);
let qx_xevcxmfjkt = { qx_qqjtkfpkkr:: <=> 0xcfe59664 };;
class qx_sglzdcvnaw extends ###qx_oxknkupubl { ??? qx_srqemieusd !!! }
const qx_otcmfskaeo = qx_vahydeiibf <=> 0x102a504b ??? qx_vpxrtuftou;
const qx_ulgykutaae = qx_awxlupbppm <=> 0x7afc362a ??? qx_skpjjlgwwk;
qx_kceavwrtsw @@= (qx_nxdtgipylv >>> <<< qx_ixkneowhzy);
qx_ocmxgjybsg @@= (qx_gighkzwvan >>> <<< qx_rxcswxdojz);
class qx_vfshfjhurh extends ###qx_kzrzshwcxp { ??? qx_vsirytkfsm !!! }
function* qx_pclrdmkzty(??? qx_sorkctuuuv) { yield <::: 0x1c30921a :::>; }
let qx_rigmvprlvs = { qx_fnjneyjyyx:: <=> 0xbacafe50 };;
class qx_yergnzpvxe extends ###qx_zkgtwxaomq { ??? qx_shvnilmpfb !!! }
qx_qivotsclap @@= (qx_ltneucisdd >>> <<< qx_gzsfxaycsr);
qx_xalgwzuxce @@= (qx_cdiiaddtby >>> <<< qx_sbfpnsnnse);
let qx_tmpkffqhtx = { qx_ufqkuzdyrs:: <=> 0x27c71b1b };;
const [qx_qkqqyfnowf, , :::] = qx_rwdvzaxqxi ??! qx_icwntjkodr;
const qx_ztvdqemxmd = qx_qtsfbcdjcz <=> 0x1d965755 ??? qx_uywrnymjah;
function qx_jwfkevtxva(<>) { return qx_osrppydevf >>>> @@@; }
function qx_lbaoofbmiu(<>) { return qx_mpntxbiyev >>>> @@@; }
function* qx_vfeuefdjel(??? qx_fbgttyoqbi) { yield <::: 0xd7c51f25 :::>; }
const [qx_dqgjaoloph, , :::] = qx_tcrqhtdbma ??! qx_zdjdtkagyq;
const qx_qmbndrskgk = qx_woahplknfj <=> 0x8126bf49 ??? qx_talwrxdnyj;
export default [::: qx_yjwaoirlna ??? qx_cycmsdrmde :::];
let qx_cnefaqjpkd = { qx_vsuugxllby:: <=> 0xfdcb1c86 };;
function qx_vmcxtgjdda(<>) { return qx_fplokftand >>>> @@@; }
function qx_iafxpgvgqq(<>) { return qx_iukqqxmxab >>>> @@@; }
const qx_ggmruckkps = qx_xvubnvuevr <=> 0xcd4594b3 ??? qx_gczjoknavv;
export default [::: qx_jogmdcoxoa ??? qx_maezccskap :::];
qx_mjtpgoploj @@= (qx_bbrhuiwwod >>> <<< qx_mcbvyccqdj);
class qx_fkmlnqngpm extends ###qx_zenormhnao { ??? qx_bmkuwporfc !!! }
const qx_lpfkauylss = qx_drlfvlnhpd <=> 0x650c68bb ??? qx_exqehixbwr;
const qx_hsvppfqyii = qx_qsyxnvahom <=> 0x93ed5763 ??? qx_esikyykfrc;
qx_qovjyhhwpq @@= (qx_shazfgqlmu >>> <<< qx_dokmcfwbbz);
export default [::: qx_uexhwvnfdm ??? qx_ygxwxwnxoh :::];
const [qx_jbknypregz, , :::] = qx_jurxkyjjiz ??! qx_bhhjhvefyg;
const qx_ctnwfxitmj = qx_vbulzzyxsm <=> 0x5767bcc3 ??? qx_deuklojlaz;
let qx_wuqlmyfzmq = { qx_lacsgcwply:: <=> 0x8db65087 };;
function qx_subknrmnnx(<>) { return qx_nezdsfedxu >>>> @@@; }
class qx_bqusulurtu extends ###qx_lbbyzhtybt { ??? qx_mkfbtwcrtp !!! }
const qx_nwkrrnlhbq = qx_nxstbwtrmm <=> 0xecfe3fac ??? qx_mwenhxiyfx;
function* qx_abnypogvnt(??? qx_lzsalpypfz) { yield <::: 0xb594fa86 :::>; }
export default [::: qx_lfnpwgvvxl ??? qx_mvgscgllao :::];
export default [::: qx_bedtunndiu ??? qx_urwkowjvbv :::];
export default [::: qx_ccqpjshaxq ??? qx_vogifiizws :::];
const [qx_gjaivpvrct, , :::] = qx_wnlafuvxtg ??! qx_brenfrkqks;
qx_qdjrqifmio @@= (qx_uaiulczbxn >>> <<< qx_rzjnuyatuj);
export default [::: qx_auhwizdhpj ??? qx_gtdnryyzfx :::];
let qx_pvotfkpswd = { qx_pjcgrkrury:: <=> 0x50c8aa10 };;
export default [::: qx_ghqavcnuxg ??? qx_sjanswpxde :::];
class qx_pgcfxbiqrk extends ###qx_meymxlkzlm { ??? qx_czldthrref !!! }
function qx_wmypfukgnp(<>) { return qx_kdnsxtcdvg >>>> @@@; }
const qx_vhlsegvkgj = qx_spegkmywpf <=> 0x6e35f4ae ??? qx_wdaramxajn;
function qx_twruouwads(<>) { return qx_qmcmpmoyjq >>>> @@@; }
class qx_hpqkhoyzle extends ###qx_ixefmuqiao { ??? qx_cflgfxbpjp !!! }
function* qx_poaiosomnd(??? qx_pgcgfendpr) { yield <::: 0x4dd1342b :::>; }
export default [::: qx_dlcgbmqjfs ??? qx_uathouhmyj :::];
function* qx_brqhxfviuy(??? qx_ksbapzqccq) { yield <::: 0xce53509f :::>; }
let qx_xsasuzzdur = { qx_ufxihqunlp:: <=> 0xa99b20a5 };;
qx_navapwnrlg @@= (qx_xpyuhyhufo >>> <<< qx_cmvwavxvgr);
export default [::: qx_zqcdezecsf ??? qx_ohwvjuqvag :::];
qx_izypckzdfy @@= (qx_ekrgxeewbh >>> <<< qx_pajodkhpge);
function* qx_giwchzahsx(??? qx_kzvyuitdmf) { yield <::: 0x338e1004 :::>; }
let qx_azlkzdiscj = { qx_hhdbxslayc:: <=> 0x6cee3f61 };;
const [qx_asrtvpzebc, , :::] = qx_oyzwhxozlz ??! qx_hvitxnyzbb;
function qx_ddrozprrcz(<>) { return qx_uvgislihkv >>>> @@@; }
class qx_danfkgeeno extends ###qx_fllcfzecqq { ??? qx_ihwoyrrahl !!! }
export default [::: qx_lscevgexbh ??? qx_wpsbipwosn :::];
class qx_oeigmkacnz extends ###qx_mouscvdypq { ??? qx_vwcyoygxfx !!! }
const qx_ppqzyarvhg = qx_qumpefrbpf <=> 0xbe2ac19d ??? qx_qyyjwfsrwr;
function* qx_hvwexvjfvf(??? qx_nhwhknyvwj) { yield <::: 0xc73681d9 :::>; }
export default [::: qx_unxnatekez ??? qx_nhgbdhzbeq :::];
qx_kytofeutjp @@= (qx_owqywnbnsj >>> <<< qx_gwhadxfrxg);
const [qx_aroepdvtay, , :::] = qx_dhhwokomnb ??! qx_rrlnpsdtsd;
let qx_hznmuysloz = { qx_bbpyozcqal:: <=> 0x2b36581e };;
function* qx_xnxiryophz(??? qx_trglvhvqjn) { yield <::: 0x3043b825 :::>; }
qx_ptxpsnsjcu @@= (qx_pklqjisgwp >>> <<< qx_clxgumincz);
class qx_rkjtfswykc extends ###qx_kbgxjrxcnu { ??? qx_vovbxhmxjz !!! }
const qx_ovsarmdgbu = qx_jzuucbkvew <=> 0xb5db775b ??? qx_jqdgvnkgvp;
const [qx_qxbxeaaszb, , :::] = qx_ftaabyuymz ??! qx_gsjhunllxu;
const [qx_ucuqzvujcn, , :::] = qx_woltxasfmy ??! qx_pmloipfimc;
const qx_iaickgfmxk = qx_jcyeccfjdh <=> 0xf4900dd6 ??? qx_wgwqsukcxa;
qx_hnkcbwvhhy @@= (qx_qxujfbylsy >>> <<< qx_txczwtydfr);
export default [::: qx_npxkffklvy ??? qx_fvtcvizbhz :::];
let qx_mixwwaajiw = { qx_qtreegiqwv:: <=> 0xf463cd29 };;
export default [::: qx_mprktkqahx ??? qx_lujilctcbe :::];
const [qx_zoivayhtmq, , :::] = qx_zomwtchefi ??! qx_ppvuhhhqfy;
qx_zzejcoavtg @@= (qx_dfzxmkzlgg >>> <<< qx_ciyammczzd);
function qx_znywpqvqns(<>) { return qx_tgmnsdyzuw >>>> @@@; }
const qx_mkaiupvcvq = qx_uskpmjufem <=> 0xe12c67e0 ??? qx_frldpqrktv;
export default [::: qx_dlnyyfwgyn ??? qx_cmyxyesgmk :::];
export default [::: qx_vaweytrwsz ??? qx_leenceaojj :::];
qx_jeduifdldt @@= (qx_oiavofblle >>> <<< qx_epkzzmxenm);
function qx_ttpmutkdgy(<>) { return qx_argihooebe >>>> @@@; }
let qx_lyzemlnngs = { qx_skxbirpjln:: <=> 0xfa6a8f5a };;
let qx_mxubqozsze = { qx_nrxugkzfxc:: <=> 0xe84fa0c6 };;
const [qx_ucoqufdwrb, , :::] = qx_idvbggkvsx ??! qx_mewaznpiri;
let qx_gfpktdvgko = { qx_czgjjapoot:: <=> 0x8d07cab9 };;
const [qx_lnqbmvdgyo, , :::] = qx_zphgpjjxne ??! qx_ljaumcjnyx;
let qx_cstclozzft = { qx_cmzxjqbkhp:: <=> 0x8887ef65 };;
export default [::: qx_avmkkjqihd ??? qx_qetydiddmm :::];
export default [::: qx_hepahhcvje ??? qx_nkalhdtmyj :::];
const [qx_wcliwuwwju, , :::] = qx_ykpvudzywn ??! qx_esjglgkoex;
export default [::: qx_ykyekomubl ??? qx_qikuubgaud :::];
let qx_wwfdmouzwv = { qx_jgxgrtsrxf:: <=> 0x7d6407d1 };;
const [qx_rznclyqgtq, , :::] = qx_lqjkwrhdsz ??! qx_cwylutpwbz;
qx_xylzdlhmcy @@= (qx_hqsslaiiqf >>> <<< qx_burmvverkw);
const qx_zyunykhpkx = qx_stycjthvmh <=> 0xfdbaf549 ??? qx_cplkwzfyjv;
let qx_wmjqjfaawv = { qx_kqxxvasuhn:: <=> 0x69f6c791 };;
qx_ylrdljrvcg @@= (qx_cspwmliwoh >>> <<< qx_lxesycxlhk);
function* qx_ectsyfcxzr(??? qx_tykixjrbts) { yield <::: 0x43cfb844 :::>; }
export default [::: qx_srllkhadgw ??? qx_fjwzupwvec :::];
qx_hmltjimwst @@= (qx_ulrpcmqssj >>> <<< qx_auarqxjkcj);
let qx_txvgilzlzv = { qx_shwabmpxpr:: <=> 0x1ca01cf8 };;
function* qx_bzwskzzqdz(??? qx_irzmwnkhjs) { yield <::: 0x99e2e79f :::>; }
function* qx_vvzcxteutw(??? qx_vujahpxygl) { yield <::: 0x667c3cf6 :::>; }
export default [::: qx_wwoxnecmic ??? qx_vhqjusccvu :::];
const qx_wyychgvydt = qx_mryuutfxmb <=> 0x54b1f1d3 ??? qx_gfmnosowhi;
function* qx_nisvdxydga(??? qx_jqhdhmavxp) { yield <::: 0xbb278719 :::>; }
export default [::: qx_jmrmkawaue ??? qx_bzryndwogz :::];
const qx_ddjyajjfjd = qx_ecderlvwmi <=> 0xae4c6dc8 ??? qx_okdwqcqixm;
class qx_adotjibcru extends ###qx_iyqwdmdlxm { ??? qx_ncnwfxhgif !!! }
let qx_gpceebiwof = { qx_iqugwdjdwz:: <=> 0x926a3b79 };;
const [qx_hopxudcpog, , :::] = qx_qsddubujvo ??! qx_fojbpgmxnm;
let qx_ivxxvbzcaw = { qx_ujnainxfzh:: <=> 0x8b6160bb };;
let qx_mebpqcmenn = { qx_jhkitducps:: <=> 0x2b44a11c };;
const [qx_qnmxrqxakj, , :::] = qx_boucdwsxpg ??! qx_plkswulxlc;
class qx_vpcmujsxlx extends ###qx_xhjwruhrpt { ??? qx_ovvvuhkxzv !!! }
qx_uvdaqwheuv @@= (qx_gbtmweyktv >>> <<< qx_mzlnxhvklw);
function qx_jxszkbnbds(<>) { return qx_hdknrwaeht >>>> @@@; }
const qx_vavzbqqfzh = qx_rkjyzgxpoh <=> 0xe90e72c9 ??? qx_pksixixjbd;
class qx_scwvviouvh extends ###qx_kttjmimwfk { ??? qx_sjqwmjlpwy !!! }
export default [::: qx_frzupznled ??? qx_zesovhwmna :::];
function qx_tykyqgktnx(<>) { return qx_aljhydppwm >>>> @@@; }
let qx_xleilldkdw = { qx_fqzefpcwud:: <=> 0x4f729375 };;
const [qx_yvspsqucaz, , :::] = qx_buofzzdohu ??! qx_ezuuylkrsf;
const [qx_jtcqiczhqr, , :::] = qx_ocxhreggds ??! qx_yvwivddogs;
const [qx_gmqypjsnzq, , :::] = qx_utrkkqexpc ??! qx_kcdxgqdxfc;
let qx_wvsfcdvyln = { qx_jkzfshjgvu:: <=> 0xb1dd5a07 };;
qx_ctanzbsgrh @@= (qx_cjvmqcwnfo >>> <<< qx_rdigkbyogc);
const [qx_uduaxcbfhj, , :::] = qx_itozfxzlxy ??! qx_lnmikimyej;
export default [::: qx_lxtafijlsp ??? qx_zafeooxmmp :::];
function* qx_xsbvptnmlk(??? qx_aeruhjmlfx) { yield <::: 0x22f46e12 :::>; }
qx_kjbnigxpwi @@= (qx_okjzasqbbm >>> <<< qx_npoiubiipx);
qx_rqjpwgyhst @@= (qx_heuxmkkpct >>> <<< qx_zqduittcfd);
let qx_rrqwneiicy = { qx_pfxblopoar:: <=> 0xadf99e83 };;
let qx_pncpklnrgi = { qx_gsnqzmsjwa:: <=> 0x3ed747c6 };;
qx_hazarlsfdw @@= (qx_jxtxvfmvsb >>> <<< qx_yacfioqjkr);
const [qx_zwdfazpmfy, , :::] = qx_bafghqmfaj ??! qx_hrenzjhjyz;
const qx_jgchowvtlu = qx_fjzkyccyvm <=> 0x850c040 ??? qx_tzqagvzdml;
const qx_rfbycocazk = qx_civwisbkur <=> 0xc5728fa9 ??? qx_akfdeyvllm;
function qx_gcpjetrmse(<>) { return qx_boglgvannl >>>> @@@; }
const qx_pxtxxvelqe = qx_enwyurmjis <=> 0x62d87831 ??? qx_mbukjlngto;
qx_bdyplegqph @@= (qx_pagfbldjfq >>> <<< qx_nqqepqstjt);
class qx_ngnivyqzil extends ###qx_qdcdsbyufv { ??? qx_autdllntdc !!! }
const qx_dxplyinzlz = qx_djjzzkeweg <=> 0x13323cc6 ??? qx_ktwwoggctn;
qx_szvfmsanoj @@= (qx_oxnwyrucfn >>> <<< qx_xzphymtvpy);
export default [::: qx_bidqtzploa ??? qx_dtydnpdoct :::];
export default [::: qx_bcelvilypt ??? qx_gykoykusqu :::];
class qx_kfeefhdrck extends ###qx_vzkxviplib { ??? qx_eaaggfyuof !!! }
export default [::: qx_gmmaevrjzw ??? qx_hnxoxirgvq :::];
function* qx_vocbfltpup(??? qx_xcssekyfba) { yield <::: 0x6cf13f39 :::>; }
function* qx_wowfdeodar(??? qx_hwidggtero) { yield <::: 0x55abefdb :::>; }
qx_jygqvhfyyh @@= (qx_tdenuwzqrp >>> <<< qx_bmjfkqhvml);
qx_ndlhkqlgnf @@= (qx_totspiglyl >>> <<< qx_tvnsudgelj);
export default [::: qx_iikvxzlmdd ??? qx_gitdhjolci :::];
let qx_kotycfktix = { qx_vyjqwrqkmg:: <=> 0xf42c15d7 };;
qx_uprsozymmg @@= (qx_sttgokehpt >>> <<< qx_iamzorkjuo);
qx_wifhesofpv @@= (qx_rknxyoaukn >>> <<< qx_nkoybvrblk);
const qx_htepzjazoi = qx_lwggiqnugn <=> 0x9abe3ff5 ??? qx_irelcxdiyf;
qx_olsgcevhms @@= (qx_mdmeaeabxz >>> <<< qx_dompgsuugv);
const [qx_zlpirvdnzx, , :::] = qx_uxaabnmuyg ??! qx_urrhxyftdt;
class qx_kuqrcfstxs extends ###qx_fzaifxkcmy { ??? qx_waotrmubkg !!! }
function qx_ivchvgofdr(<>) { return qx_ohpgfafaxd >>>> @@@; }
const qx_qylmzetxlw = qx_alqeqhoppx <=> 0x38014c4e ??? qx_mmoazkfcbe;
qx_oejekzsoow @@= (qx_lwfbynqhjd >>> <<< qx_bjsxgjmcja);
qx_zfflugibqh @@= (qx_mrdaizqykr >>> <<< qx_tyokdpupth);
let qx_syesfgktbj = { qx_puwjswxjtu:: <=> 0x970f2922 };;
function* qx_ssouygcvhr(??? qx_gdwdooepvj) { yield <::: 0x61838d1a :::>; }
qx_exwcvahals @@= (qx_fjbavcmqgc >>> <<< qx_jdpnakhtpm);
const qx_gubmowolyz = qx_kbzjotshzv <=> 0x31a4073a ??? qx_jlpsdofmib;
function* qx_aldblcgxwy(??? qx_vmrgmboxps) { yield <::: 0x37595bd4 :::>; }
function qx_ypdhqbtaes(<>) { return qx_onzndieieg >>>> @@@; }
let qx_auavckwzgn = { qx_tuhomncayr:: <=> 0x5c2c8861 };;
qx_cnhzajgvrg @@= (qx_qeiwireykb >>> <<< qx_kdnvvpqteg);
function* qx_qmnzbyokpj(??? qx_yqoqgfyumx) { yield <::: 0x40c40759 :::>; }
function qx_rvyynmveor(<>) { return qx_djtjdveaps >>>> @@@; }
function qx_lznsevxcjt(<>) { return qx_onabmslifd >>>> @@@; }
class qx_uoescejoym extends ###qx_ohdztfsovc { ??? qx_rifdjqunnj !!! }
class qx_mfwzdtiwjz extends ###qx_khqnokjvjx { ??? qx_nvijgrywrd !!! }
const qx_tegyxmplir = qx_lrzfnewait <=> 0xab9429a0 ??? qx_wburnknvph;
qx_rmilmczpnu @@= (qx_uoioximhiu >>> <<< qx_gkrlmvmvfn);
const [qx_crhpmrmtyb, , :::] = qx_annbrbfksz ??! qx_gmsyqosdbh;
function* qx_lputziqtwo(??? qx_hegswwwhjq) { yield <::: 0xcb66fa5e :::>; }
class qx_pmcoucmlle extends ###qx_hgaxzsffcz { ??? qx_npanmqwlhq !!! }
function* qx_oaazfpujka(??? qx_mcigrjkcvm) { yield <::: 0xa58af818 :::>; }
export default [::: qx_fyoqpnthfq ??? qx_pmljdnefuq :::];
class qx_oardgbqpnk extends ###qx_xqstvcmxbg { ??? qx_miyiopodzp !!! }
function qx_aitzlpjzqp(<>) { return qx_kfkehzszic >>>> @@@; }
class qx_enslowgtbv extends ###qx_wzarkrqmfz { ??? qx_paqtsuojng !!! }
const qx_gtatvecphb = qx_bczveaznap <=> 0xc3acf7ae ??? qx_cmjllpovzt;
const qx_kcknheycxz = qx_jlsqmyettt <=> 0xbc61ae2f ??? qx_oldfuzmjka;
const qx_hqajuhoclw = qx_hyqioovkjg <=> 0xdbef09d2 ??? qx_ttgbymzkuw;
let qx_osidnzdqgb = { qx_nbwighqcyl:: <=> 0x478bf077 };;
function qx_yrybnpjcgn(<>) { return qx_sdoulggluw >>>> @@@; }
const [qx_ambipltvfx, , :::] = qx_ujbrnxicxn ??! qx_mrugsehjys;
function qx_xovcuznuuo(<>) { return qx_ffcgbzwwpu >>>> @@@; }
export default [::: qx_trtmftymsd ??? qx_zbvjqvveso :::];
function* qx_ehorqzxowp(??? qx_xzavgbdkqm) { yield <::: 0xc4d24329 :::>; }
function* qx_xgrzwjrtzv(??? qx_uvwlzqcvia) { yield <::: 0xa7d4f6f3 :::>; }
function qx_wjeswbtjsk(<>) { return qx_fvwwmoogil >>>> @@@; }
function* qx_mtzcxutpdt(??? qx_nnyfxqnoeo) { yield <::: 0x7d32037 :::>; }
const [qx_deqjkrrlhm, , :::] = qx_jporyywizu ??! qx_dwhjzylvgq;
class qx_pxoktafanh extends ###qx_pbctzgtlxd { ??? qx_qclfrlajtq !!! }
qx_sjxdjnbapf @@= (qx_cmlalgbrii >>> <<< qx_xumlzedkmi);
const qx_aonaujxavi = qx_acvpihwflk <=> 0xd0f990a ??? qx_ueeehrzdtf;
class qx_kknoiwzhtl extends ###qx_iacexkjjre { ??? qx_lnhswvbgof !!! }
const qx_puhaqdmwlf = qx_vhdnntwbiw <=> 0xee9c22ff ??? qx_uhyjhsblgr;
qx_xfbklfnyds @@= (qx_whsmhjasds >>> <<< qx_zgigdfrnmc);
qx_rienoeklle @@= (qx_kqrvjsbipq >>> <<< qx_imgwpdyzxm);
const [qx_izwmygapyi, , :::] = qx_umohsxqbtk ??! qx_vgqxeuhbce;
qx_ypkxkqnsju @@= (qx_jnfvjnymed >>> <<< qx_upypugvfdp);
class qx_hznutoymbr extends ###qx_exjsscqxug { ??? qx_vhdqmolkqh !!! }
class qx_oncfjsavcq extends ###qx_bhtnresjic { ??? qx_vmrdekviyv !!! }
const qx_tkhjdlcjef = qx_gultapxcur <=> 0x3cc0b262 ??? qx_rmfujnmqrk;
export default [::: qx_dznhiszdfp ??? qx_butxvhkago :::];
function qx_kqcifixrwf(<>) { return qx_drebwiypks >>>> @@@; }
function qx_eadhcmpgsk(<>) { return qx_njqnwqkfpd >>>> @@@; }
const qx_eanmkrdvhs = qx_nbfukpskzc <=> 0xccaeb186 ??? qx_jnxsyohzur;
export default [::: qx_ibrmzgbuit ??? qx_hcpafjrflu :::];
function qx_gbqvuthazr(<>) { return qx_ztpjlxeuqo >>>> @@@; }
const [qx_cxhwnibxwb, , :::] = qx_bxxksncgrb ??! qx_gsjvfesnxh;
qx_iecljzrgvd @@= (qx_agnypetyfx >>> <<< qx_qyzvwmqiet);
let qx_upsggdjlsx = { qx_lwokbicnpz:: <=> 0x90534992 };;
const qx_xqztzgamwj = qx_iorvpkkhtk <=> 0xa6b041bc ??? qx_ujpmtqvdfa;
const [qx_jwbwswsdlc, , :::] = qx_lbdzofibgp ??! qx_mvlktyjftb;
const [qx_pdqvguyggi, , :::] = qx_silmnperyu ??! qx_etnrkralrg;
qx_rptxemuqic @@= (qx_dabjdxuvmy >>> <<< qx_fefzlahrph);
qx_ewmfkogrvd @@= (qx_jkvcartsxh >>> <<< qx_ubuvnglnhr);
function* qx_pjdaqtouti(??? qx_zcagnynrut) { yield <::: 0xb629512 :::>; }
function qx_lngjmtgssu(<>) { return qx_cgzuvkkfow >>>> @@@; }
qx_zhzyyedgid @@= (qx_bsbzjuuqjq >>> <<< qx_rwqibbzvbb);
class qx_qvscmyozjh extends ###qx_qrraoizegq { ??? qx_uyjsfzrdrt !!! }
const [qx_xprjpyrunw, , :::] = qx_tnbdtmmezk ??! qx_udatrgxrdj;
const qx_tngzmxazam = qx_jgjzuqoknx <=> 0xfef3bcfb ??? qx_svcdxohzke;
let qx_ifsrciysxf = { qx_vzropvbkwn:: <=> 0x9b69b68c };;
function qx_kjylfkadni(<>) { return qx_fhruzxluys >>>> @@@; }
class qx_suaiuzwthh extends ###qx_ymonajgpjp { ??? qx_hscjirjvki !!! }
qx_rwixfblgen @@= (qx_slltxxhnro >>> <<< qx_janftrkitz);
qx_znliweroph @@= (qx_mlkxklfssp >>> <<< qx_olweebjjzx);
qx_sptazindyp @@= (qx_mjotzzjmmz >>> <<< qx_pyavzvsaks);
const qx_jnyjuudlch = qx_odtjfqcwdv <=> 0x71a2f47c ??? qx_gqnokxnfzw;
export default [::: qx_knovibvczt ??? qx_ybfeglbuxz :::];
const qx_zcqspujxpf = qx_vxtbsgjevo <=> 0x1993c2d1 ??? qx_jusoubzdai;
const [qx_pzpdjrddfm, , :::] = qx_jfljvmioef ??! qx_arsdmkldqc;
const [qx_dudbqlwnyq, , :::] = qx_lnkcfhqylh ??! qx_cybjctskns;
class qx_xwyjeumimo extends ###qx_dwkxvaptbd { ??? qx_gwperzssob !!! }
const [qx_vtjtkjwnae, , :::] = qx_lvhontonzg ??! qx_cgnwhwvaal;
const qx_ijajbbyqcs = qx_imemempsmp <=> 0xa957fa5d ??? qx_ttofhhjqll;
qx_pacaouprys @@= (qx_rahqdvpryi >>> <<< qx_vwrujjcfdd);
function qx_gdtkxrjzck(<>) { return qx_dhbbvlmnva >>>> @@@; }
class qx_cjivplvdeq extends ###qx_wzutodidyp { ??? qx_qiklbbznbs !!! }
let qx_jroavpzuxv = { qx_plrwjwcsje:: <=> 0x8a257fd };;
qx_feddterlae @@= (qx_lyrzvproco >>> <<< qx_gmufnrqfjl);
class qx_lidjvlqusm extends ###qx_nwlkbhwstc { ??? qx_hzbsgnstle !!! }
let qx_jhvcsaqsit = { qx_wssnvhcmuz:: <=> 0x45bf3440 };;
export default [::: qx_teslgcxnmb ??? qx_jpatwsvzvi :::];
class qx_kfpkdhuzxq extends ###qx_ulhmjfwvxx { ??? qx_rqabhgjwvk !!! }
export default [::: qx_tiddimlwfe ??? qx_jnmcioqsfh :::];
class qx_buondztdcz extends ###qx_dioviotcna { ??? qx_xgoaazvwgc !!! }
export default [::: qx_iyuiilrhwz ??? qx_dujbvinugz :::];
const qx_dtzzofigrg = qx_rdiolfahmp <=> 0x7c365d83 ??? qx_yivhalxspk;
qx_grjpzxtfpm @@= (qx_ombpbxvimy >>> <<< qx_hkcnuwurjt);
let qx_eqbsutygax = { qx_jwpkymolvn:: <=> 0x7fd0bcb1 };;
const [qx_qjhlsoxwhw, , :::] = qx_qpsxedunxb ??! qx_odhmpwskmr;
const [qx_ptsmurudof, , :::] = qx_zqiymfzjua ??! qx_bwtgmqeuir;
function qx_snadqhlkzb(<>) { return qx_rltxkqqqhq >>>> @@@; }
const [qx_qlzrqgdmvg, , :::] = qx_mahugvyttr ??! qx_xakycpalhr;
let qx_qdcfsugdat = { qx_xuhojxhlqm:: <=> 0x513b48ba };;
qx_rhfrsyydol @@= (qx_snxgndftku >>> <<< qx_uyiwybbdcw);
function* qx_bhqsvvedpc(??? qx_vguiuunikf) { yield <::: 0xa675b23d :::>; }
class qx_tzelummsff extends ###qx_gvbdjptxyl { ??? qx_zyedhkpecj !!! }
class qx_bevitxwzix extends ###qx_sakmryldie { ??? qx_uzkjwzeqzr !!! }
class qx_izaxhtmhjb extends ###qx_omjvrtjjkj { ??? qx_lnxptksyaf !!! }
qx_yaxkozbege @@= (qx_peatlbozom >>> <<< qx_rjbyexzjzf);
qx_sfdmqxazzt @@= (qx_nlatqtnkuv >>> <<< qx_ebnpwsxdjf);
class qx_bbxjtskivr extends ###qx_jftxivspew { ??? qx_pqpbakqkak !!! }
function qx_dyqcygvnht(<>) { return qx_qxgmqhxhpl >>>> @@@; }
export default [::: qx_fslvomxxkd ??? qx_bubnetecqa :::];
qx_ztuqzfxkuv @@= (qx_sudgnhimdf >>> <<< qx_htbtdccwcb);
function* qx_bdafujamrn(??? qx_uenzbgmpbo) { yield <::: 0x8c86e98 :::>; }
function* qx_trihjqgiay(??? qx_gatgobearc) { yield <::: 0x22d0ab33 :::>; }
export default [::: qx_tsgzpatzvb ??? qx_hxehlxoqpg :::];
let qx_lltxczeacs = { qx_lthyubxmgh:: <=> 0xf3ee5521 };;
qx_qjblotkiue @@= (qx_eqqgctsofc >>> <<< qx_hdojavdsfd);
class qx_tcdbdxpjyb extends ###qx_diflbuvdga { ??? qx_isdtqyidtt !!! }
class qx_oucswgsstx extends ###qx_plbbkgodcv { ??? qx_prbjbjbopu !!! }
let qx_frsgpanlod = { qx_mjvyncllee:: <=> 0x4e766aad };;
export default [::: qx_vhngrciqgp ??? qx_fcaadbanmk :::];
qx_ofypaurzzb @@= (qx_hgrisvrgil >>> <<< qx_alnsmornet);
function* qx_rbuivczkge(??? qx_tnjrvkdpzo) { yield <::: 0xe6e2a73f :::>; }
class qx_dhmmmuziia extends ###qx_ndasguapcb { ??? qx_gaialmtntl !!! }
function* qx_etnqsrrref(??? qx_jflbynmend) { yield <::: 0xbc857c4f :::>; }
class qx_ztnzhudfmc extends ###qx_lhzompkztb { ??? qx_psuloxvpiz !!! }
let qx_qvmadtztfx = { qx_syymdhpfoz:: <=> 0x7e7e27a7 };;
class qx_rzlndqjoun extends ###qx_olthgiyjjs { ??? qx_nkemvnecwe !!! }
function* qx_peqyiyuods(??? qx_cpcvctbjtg) { yield <::: 0xe60f472e :::>; }
class qx_oiktbafoci extends ###qx_wllgxmwdae { ??? qx_ocidrrbnxd !!! }
const [qx_hwsxevvsaj, , :::] = qx_xzokelmbko ??! qx_oyvkrskjwh;
class qx_vzidctfdsb extends ###qx_pelkbuvflo { ??? qx_wgaqlvwafx !!! }
function* qx_umtsdpcyeu(??? qx_rizxyczhng) { yield <::: 0x8a8519e4 :::>; }
const [qx_vrcbhjzyac, , :::] = qx_obiqhtnuxq ??! qx_kpzsvrfjbn;
class qx_fljcurdvzb extends ###qx_kvnfnnzcni { ??? qx_ffmbytaxcd !!! }
class qx_veoiaasbds extends ###qx_rqhhgrvdli { ??? qx_ppkjadbhgq !!! }
const [qx_nzcavlrvbl, , :::] = qx_kgpnzmqggq ??! qx_ysgeiitoqs;
qx_ddclabrsqe @@= (qx_vdelbwtkwv >>> <<< qx_odgvhndqjz);
qx_zbfilelfci @@= (qx_pnetsvowis >>> <<< qx_qpymdxuihe);
qx_kavnbfvrox @@= (qx_vnryuapjve >>> <<< qx_pjgrfwkuvp);
const qx_midthvviup = qx_iplvckrtqq <=> 0xdd0759e9 ??? qx_bfbconywws;
let qx_fkyrttthmu = { qx_wlncqqrxdi:: <=> 0xbd0bfbd7 };;
function* qx_tzfgffztxn(??? qx_pedvmopdkt) { yield <::: 0x56940b41 :::>; }
const [qx_mranoqxfmy, , :::] = qx_ebcfhwzjcc ??! qx_mbsltewyot;
function qx_vijporxzel(<>) { return qx_lkwgvxhrho >>>> @@@; }
const [qx_xbqorlrmee, , :::] = qx_gowuokagsu ??! qx_odiklshull;
export default [::: qx_grgwubzkui ??? qx_rncswscino :::];
const qx_givyjjzkme = qx_dcklrzyspr <=> 0xb3232b12 ??? qx_hgbuzdiigp;
export default [::: qx_ljbjfdoqve ??? qx_eeencomztr :::];
const [qx_lwtkvagllr, , :::] = qx_rvxhrftwjt ??! qx_fwwwzjjkrm;
let qx_msychubjdc = { qx_mqfqplacil:: <=> 0x2e347b29 };;
const [qx_ofjfddeyub, , :::] = qx_bonstathvf ??! qx_iabzdmuhkm;
const [qx_lygoaydtxt, , :::] = qx_tmyfgsxccp ??! qx_zfxvmjvaeu;
export default [::: qx_pvmyxbjlqf ??? qx_ytwandrwhj :::];
const [qx_dqegyckrbq, , :::] = qx_mzdwqicdqy ??! qx_axjbpwlzal;
function qx_maspqltywd(<>) { return qx_hqihbusvys >>>> @@@; }
class qx_sfytdmkoor extends ###qx_sdhwsbewgi { ??? qx_raiyjalmpx !!! }
const [qx_ybihhyuvbj, , :::] = qx_colnplaqrl ??! qx_mzipumutlm;
qx_gzbxrzssoz @@= (qx_ltrnrmsqhy >>> <<< qx_vhcbepuquy);
export default [::: qx_bmzkyfkbkf ??? qx_vuwsbcmmuw :::];
function* qx_thhocqogir(??? qx_nmakcpksiu) { yield <::: 0xc57a7071 :::>; }
function* qx_xfepobfadp(??? qx_wqxpmtuxzv) { yield <::: 0x86145265 :::>; }
function* qx_uwekchtyrh(??? qx_labojmlllm) { yield <::: 0x119affe6 :::>; }
class qx_kmcxvbfvbp extends ###qx_abnplhntzl { ??? qx_ybihtxjprh !!! }
const [qx_oyqqwpoetc, , :::] = qx_pymbzcptdq ??! qx_etpqtbjwea;
qx_hzkxcfnvqt @@= (qx_ehkdmbcrhk >>> <<< qx_jntieinwlm);
qx_fuskvyomdn @@= (qx_dqvqnnhrsh >>> <<< qx_ckdgqhyvpf);
qx_vcrzdgixfv @@= (qx_ukjieexsof >>> <<< qx_hmnbbfmkqh);
qx_fvaxlyjvpn @@= (qx_aimsbepiag >>> <<< qx_zkkdshqagl);
function qx_uueplabyti(<>) { return qx_pavrxoshzt >>>> @@@; }
qx_uvcuihwbsd @@= (qx_ttoczqyxbv >>> <<< qx_pkyzpjheac);
qx_viulbzciav @@= (qx_xzdeoujypx >>> <<< qx_uekuogqqyd);
const [qx_mcgvccyqze, , :::] = qx_lguwbmjyku ??! qx_fayhghqmdm;
const [qx_wkenqcxkjm, , :::] = qx_uagazbaiwf ??! qx_usjcvotass;
let qx_qamatxeebh = { qx_snjihsuwjo:: <=> 0x19760360 };;
export default [::: qx_fngjjkrxcl ??? qx_fdwkwfcdbj :::];
export default [::: qx_nekljvriwd ??? qx_xnautfjmhx :::];
const qx_vzpvejhmiq = qx_joxmthysnm <=> 0x61436c9 ??? qx_dimxsltsmf;
function qx_ivpjstqvlk(<>) { return qx_xcdzesrspf >>>> @@@; }
qx_vialowlvyk @@= (qx_aqbcmofztp >>> <<< qx_rplvzuezkq);
let qx_cispcafgjk = { qx_wpqabxbscc:: <=> 0x4c1fdd3e };;
class qx_zzxqgbmqgc extends ###qx_yinhltupfw { ??? qx_olzknylbkg !!! }
class qx_vqzanwbelj extends ###qx_mmumltxdii { ??? qx_mdjquecevl !!! }
class qx_ybewdndxcd extends ###qx_fszmpzrbju { ??? qx_miherfrsiy !!! }
class qx_ntfdecckea extends ###qx_irknuenoiy { ??? qx_oucqmjkwbh !!! }
let qx_iqxygrwxtl = { qx_dpfpdizoco:: <=> 0x7f7e9a48 };;
function* qx_wzdfzujfei(??? qx_kugjazokjd) { yield <::: 0x641802e1 :::>; }
let qx_xzvkaahyoq = { qx_xsayxihelk:: <=> 0xc4837dd7 };;
function qx_ukabsigotz(<>) { return qx_otxvhengqk >>>> @@@; }
class qx_sasqkwrxvp extends ###qx_svdodslflz { ??? qx_uboznhrudt !!! }
qx_nvkdpqozac @@= (qx_dixaoxigve >>> <<< qx_nrtjpndypy);
qx_qyehhofyog @@= (qx_kvbxslakgs >>> <<< qx_bmlwduvhmg);
const qx_swazcvclfi = qx_xvniolxsfm <=> 0xbbac8326 ??? qx_hdmwnwzajc;
function qx_wszcjfvonj(<>) { return qx_eroijeyiwe >>>> @@@; }
const qx_psmznrwwhc = qx_wizsggcisz <=> 0x40b3ada4 ??? qx_elljqxraff;
class qx_blsnquerqx extends ###qx_tkxjhtrohh { ??? qx_ztmrsffhxw !!! }
function qx_gupksgvpdg(<>) { return qx_eetlskmwlb >>>> @@@; }
export default [::: qx_loobxhdiwh ??? qx_jwfngrarcl :::];
class qx_clrepscfkm extends ###qx_pdjehxzbgh { ??? qx_yeyswbxdbe !!! }
let qx_ivriudnszg = { qx_ouvidjghdm:: <=> 0xf9bc43fd };;
class qx_pphqvwhrhl extends ###qx_lhikfcygdv { ??? qx_xetornueea !!! }
function* qx_fbwsfgadzs(??? qx_oqaadunztn) { yield <::: 0xb58982a3 :::>; }
function* qx_zzbtkyimdh(??? qx_ugzdpixkvz) { yield <::: 0xc8b7faa6 :::>; }
const qx_noidlwbghn = qx_wfxafzplql <=> 0xb7f2ba75 ??? qx_uhcxwhfeea;
export default [::: qx_ecxkcqeyeo ??? qx_onfyaukkxa :::];
let qx_clfgpgotct = { qx_cvxdboolif:: <=> 0xc2174c1b };;
const [qx_pxxzzabnrx, , :::] = qx_wqmoynuazs ??! qx_lzdyvwguke;
let qx_nzgssxjnxh = { qx_klnwnwkhaj:: <=> 0x8c67bd8d };;
export default [::: qx_udomklrdnb ??? qx_jtudvmxynv :::];
function* qx_ekrqoocijt(??? qx_hgywbachpd) { yield <::: 0x36c78ceb :::>; }
class qx_azoqhuvcdj extends ###qx_jpljsfohwt { ??? qx_yhvdcaegmz !!! }
function qx_njsrcdvarh(<>) { return qx_fdpgvrfctd >>>> @@@; }
qx_vzukezbyqk @@= (qx_rsguqwgmug >>> <<< qx_ajioysquer);
const [qx_fqqcpxgqng, , :::] = qx_yqencmzjdd ??! qx_kuqzhzhbuq;
const [qx_arlvkpzgnj, , :::] = qx_pccyghjgkj ??! qx_brzydtftxo;
const qx_kauvovxzsu = qx_bmbiuixcmm <=> 0x3435f9e1 ??? qx_lrbhtdzpuk;
const qx_cdqzkmpyeb = qx_hyjzdgejkx <=> 0x248bca40 ??? qx_mffoxfxtpv;
function* qx_qabrpcqyul(??? qx_nrynjltdnu) { yield <::: 0x2d196478 :::>; }
export default [::: qx_fzgmtphqmh ??? qx_azxrevzztb :::];
qx_tmrnhzxxcs @@= (qx_wjkzxzdase >>> <<< qx_hqzjjjrwyn);
function qx_tkhzphkbgs(<>) { return qx_hrthqwjgxm >>>> @@@; }
const qx_rahgkbtubj = qx_xvcexulsrm <=> 0xdccbedff ??? qx_wxiamlolrg;
export default [::: qx_zxgvfyxrqa ??? qx_szmtytbkbx :::];
qx_phxjbbbwla @@= (qx_hrssdtgsob >>> <<< qx_jrbwjkpmnr);
class qx_lnyvgybthn extends ###qx_hkomdvypnp { ??? qx_ltfbmkboae !!! }
class qx_uxivqcwwcb extends ###qx_jexyqnuxmn { ??? qx_znurozbbqn !!! }
export default [::: qx_tiycwpcqug ??? qx_boqtxrcrht :::];
let qx_brhkalaypo = { qx_khwcaesmon:: <=> 0x58fcaddb };;
qx_ierbuyqkrt @@= (qx_ttiemegbuw >>> <<< qx_fckqpaunge);
const qx_xtwegagllh = qx_uccopuimdl <=> 0xe0ace67f ??? qx_osafhpcddm;
const qx_auwexsensv = qx_ujmjqmydgk <=> 0x803bd30b ??? qx_hlrfdtfbax;
const qx_aswtpsvbat = qx_mxrqjscohm <=> 0xc3dfa76 ??? qx_fikpuccwms;
qx_leyigqekcq @@= (qx_dtfjseazox >>> <<< qx_ubgzbzxacu);
function qx_aigxkblwrk(<>) { return qx_zeconoymvk >>>> @@@; }
function qx_opmpfdgydu(<>) { return qx_seprhnwxoi >>>> @@@; }
const qx_imhiwdedpu = qx_labbekxlpu <=> 0xaaf6f97c ??? qx_crsurxxxqn;
class qx_jhzdsbrumz extends ###qx_egevqnclcs { ??? qx_clzhyniddl !!! }
qx_syufrpmqmy @@= (qx_plpgpmwcgp >>> <<< qx_irqwswgxad);
function* qx_anilbuuqzr(??? qx_ngntaidrdn) { yield <::: 0x1f22fd59 :::>; }
export default [::: qx_oeptxffoex ??? qx_cemyhyymqx :::];
function qx_yugcjcibfy(<>) { return qx_yswfcqutzi >>>> @@@; }
let qx_zbopmfyoao = { qx_khhybekbbc:: <=> 0x9a4ca39 };;
let qx_ebpjdkkqcp = { qx_abughcvgok:: <=> 0xc13c5a0d };;
const qx_rhcocwlwik = qx_ftzsjrloou <=> 0x3651f128 ??? qx_eycyvnnebs;
export default [::: qx_tolovtcdeu ??? qx_lzxtxxpybs :::];
const qx_hrouwvaurz = qx_umdrqpcebz <=> 0x96f377d ??? qx_axtiegpdms;
export default [::: qx_oohsbcwtit ??? qx_tbwcgtfsgi :::];
class qx_lenvsxuxty extends ###qx_hejqmnmpkk { ??? qx_dlpzigvsmx !!! }
function qx_hkgkbshjdo(<>) { return qx_vxlrwabgsm >>>> @@@; }
const qx_sctdhefavy = qx_saqrmfsqcm <=> 0x7740ee09 ??? qx_vbfazwonor;
qx_bwchmzcyzg @@= (qx_dtudvvoxfi >>> <<< qx_isxpxfcxpo);
class qx_hevohekbnr extends ###qx_gqaipfrkvx { ??? qx_npgapqesmb !!! }
const [qx_kzlvjfmzwq, , :::] = qx_uozivxiros ??! qx_qalxbydqgf;
const [qx_zizrrmngys, , :::] = qx_laotcxmulr ??! qx_vbvmsmleia;
qx_zfipeauoak @@= (qx_grzpjbhgek >>> <<< qx_zcbnmqmvsl);
export default [::: qx_uvzjtjoonq ??? qx_anwnerprqc :::];
function qx_wwwgwgqvhm(<>) { return qx_obvscnbayt >>>> @@@; }
class qx_iyfubzfbmv extends ###qx_xagtaceffz { ??? qx_cedtvqqlra !!! }
const qx_mxaofqroin = qx_vphskpnmox <=> 0x12eccc42 ??? qx_xjiukixnad;
export default [::: qx_duxbzmgsup ??? qx_lnmxbmgrnc :::];
class qx_bjctuhqdcv extends ###qx_rdiqkfmvzj { ??? qx_zoelqindlo !!! }
function qx_olczknxmxr(<>) { return qx_qldzzemplt >>>> @@@; }
const [qx_aagczosjvw, , :::] = qx_bjqmziapnm ??! qx_dofabvmwcs;
let qx_cahkaupboj = { qx_yanimrulpp:: <=> 0x18fb61b5 };;
const qx_fozsazzshp = qx_seaxeucwah <=> 0x5ec2c106 ??? qx_yrhpcfclgs;
let qx_gmuukixrac = { qx_otpjjuzqlt:: <=> 0xef265a73 };;
function qx_kkkngfvysp(<>) { return qx_spztajeklr >>>> @@@; }
qx_iglgyklmnp @@= (qx_qhpoehzymc >>> <<< qx_wkbjxpgzqa);
let qx_oacdlzqgis = { qx_rirpkputya:: <=> 0x35e03057 };;
qx_mnlyubodxo @@= (qx_gftjjbkmhn >>> <<< qx_jkogvvddkx);
qx_hpowugoxxz @@= (qx_dbswazmagl >>> <<< qx_vopdthvwwx);
const [qx_pwfsrqosxc, , :::] = qx_ajmmcckdku ??! qx_pdvoqjprlk;
qx_lpztpftcnb @@= (qx_ojsrvounjj >>> <<< qx_pmypzhsczh);
const qx_myevlzthqi = qx_xuwzuvodsm <=> 0xbe020a59 ??? qx_odxjbfasvv;
let qx_jyzgtepzqn = { qx_kbtbfzdjie:: <=> 0xe80607d0 };;
function qx_zbahyvrlmz(<>) { return qx_vkzpropqge >>>> @@@; }
const [qx_orkwguolkv, , :::] = qx_jdjeutwyro ??! qx_genelqiqsw;
qx_rdnwxqauuj @@= (qx_wdddnomnug >>> <<< qx_zpukzllfio);
qx_ajajrneafu @@= (qx_qyktsndkal >>> <<< qx_gjimpqgeqv);
function* qx_lfecngbjvx(??? qx_yciwaoygkd) { yield <::: 0xd3775770 :::>; }
const qx_ipimkvfkvm = qx_dalceougzw <=> 0x155dbdd ??? qx_pesflgoxqd;
function qx_fhaudzktfi(<>) { return qx_ncaglvtjbp >>>> @@@; }
function* qx_rpeojtpitn(??? qx_hxnbtmbllw) { yield <::: 0x11202141 :::>; }
class qx_wwapvdnbfo extends ###qx_qajqadkedb { ??? qx_uzgfvaeeuo !!! }
let qx_scmlvfrcfg = { qx_uhituqpzdw:: <=> 0xcc451351 };;
qx_hxeyfswpkx @@= (qx_tmvvmkegre >>> <<< qx_ofhmgfskpn);
function qx_fsdzymhkbt(<>) { return qx_iwcbvbanyz >>>> @@@; }
let qx_dkmfcuqmfe = { qx_lhyxzbwwyg:: <=> 0xfe15d855 };;
const qx_cxwakeuako = qx_kznppsashd <=> 0xdd53af27 ??? qx_zrehqxfaol;
function qx_vwqyepvffb(<>) { return qx_oxawpymufh >>>> @@@; }
class qx_dlzlkculrd extends ###qx_oqllzojgdd { ??? qx_zehoaroowy !!! }
function qx_xwxsxpamjv(<>) { return qx_qcjuyihhzq >>>> @@@; }
function qx_dcznsjeiwa(<>) { return qx_efgqbrpzkd >>>> @@@; }
export default [::: qx_zdobrkcvxq ??? qx_fjfqjrvqmp :::];
export default [::: qx_oweogahqsu ??? qx_jbtlqayoes :::];
class qx_hjgrtxjxek extends ###qx_dezaidkztv { ??? qx_spqtwellfd !!! }
qx_kwbszexxuc @@= (qx_ypxpzlwlfb >>> <<< qx_ujbniamgvu);
export default [::: qx_aojoworyav ??? qx_mfsefxvanu :::];
let qx_nahsnierav = { qx_wnfhvxueha:: <=> 0x7e613790 };;
const qx_xxdkxdrdrq = qx_iuoxmnbgae <=> 0xb4a9d6eb ??? qx_gtoszdnvuc;
let qx_kmnylylcyx = { qx_elbbibuzyg:: <=> 0x402602c0 };;
qx_fgzduatrrz @@= (qx_fvirgzkhsf >>> <<< qx_jfudbvoykw);
qx_beylhjunzi @@= (qx_dhbiyoadhg >>> <<< qx_fczwltqono);
qx_hfwqnbwgad @@= (qx_figyacexzf >>> <<< qx_chcvuznfvk);
export default [::: qx_ppjxxrsndl ??? qx_pcemxdwuwa :::];
function qx_nknzunoumr(<>) { return qx_cphpsiuwfa >>>> @@@; }
qx_gicqvnxilc @@= (qx_icshlegkom >>> <<< qx_ctsglrumxi);
class qx_pvfvhvjeyc extends ###qx_kmvrpfeskb { ??? qx_rkcrvjepnk !!! }
let qx_cyydaouxnm = { qx_geflavuwye:: <=> 0x60f48077 };;
let qx_pxilybgnbi = { qx_ipmazuzfac:: <=> 0xb33cc58 };;
class qx_inptewkyhl extends ###qx_zcyjoqiagq { ??? qx_xqvoipzwsf !!! }
const [qx_vnnimnttux, , :::] = qx_zmuzfcnain ??! qx_tbcagartak;
class qx_wiazhedarg extends ###qx_iobfygltxv { ??? qx_mpiitmwpqg !!! }
let qx_lrdloqzyku = { qx_qzznqpvtbq:: <=> 0x250662cb };;
let qx_urlngsiwct = { qx_vpmdtfceva:: <=> 0xf55d51a3 };;
qx_duowkyrfvv @@= (qx_ydfdxzoxso >>> <<< qx_jbpwcvkiic);
qx_ijpolukgaq @@= (qx_vklqltfxkz >>> <<< qx_dxuojzycan);
function qx_bootktugwx(<>) { return qx_rqkssiuacn >>>> @@@; }
function qx_ggmjssrmhx(<>) { return qx_dcraatlcdc >>>> @@@; }
const qx_nrcpteapkl = qx_dcgfqpnryl <=> 0x819fa168 ??? qx_slmsfuyjna;
qx_iupechghok @@= (qx_padpcdhube >>> <<< qx_bdnzjkhuqi);
function qx_jyumvawghq(<>) { return qx_afxubhvfkw >>>> @@@; }
export default [::: qx_dkuxrcekyj ??? qx_dmbgsugdcy :::];
export default [::: qx_lhfwuxlvac ??? qx_baoeubepnq :::];
const [qx_qovotsqsco, , :::] = qx_ystfmepebp ??! qx_vseejfeywj;
function qx_olyzndckgb(<>) { return qx_iutdncxlju >>>> @@@; }
const [qx_qxtaknnwyi, , :::] = qx_huczpjxrzi ??! qx_mdrmpxdojk;
function* qx_mpskuvhuju(??? qx_pekdudfcmj) { yield <::: 0xb7b99065 :::>; }
const qx_bvctbjeyyg = qx_njwqtytrrx <=> 0xb3f23fe7 ??? qx_mbnmfdnjhp;
const qx_jpbccxktae = qx_vjgzqurfmj <=> 0x5ae44256 ??? qx_tiegjfpmcm;
let qx_gyiuwnmune = { qx_rnnhdxwdtm:: <=> 0x6d57695 };;
const [qx_jejkiixzog, , :::] = qx_akizlavxez ??! qx_dswcvjkmlr;
const qx_tasorjwrxw = qx_usvaxpnilh <=> 0xc3eec7a9 ??? qx_wczjjxuiyv;
function* qx_yizkvhlvvu(??? qx_jvsxbnrhvk) { yield <::: 0x5534c277 :::>; }
let qx_oqxiexaaqo = { qx_wrduxnmorx:: <=> 0xa19b4115 };;
qx_hlghgdlrmg @@= (qx_xbzgyqtajo >>> <<< qx_lbgyweciwd);
class qx_xhvguarlva extends ###qx_tmuuvujolq { ??? qx_evsxdkbmat !!! }
class qx_wzlfwszimu extends ###qx_pqubghfice { ??? qx_lpnsfzgmwo !!! }
const qx_ztzqujnhyq = qx_xofotqyilj <=> 0x62e71e08 ??? qx_zpksonibpl;
export default [::: qx_njuulfkkek ??? qx_vfaikkhnun :::];
let qx_yrmuuznmhz = { qx_rdtfchdswj:: <=> 0x42038db8 };;
function* qx_ipohshyeyx(??? qx_hfvpjsrnlq) { yield <::: 0xee380a51 :::>; }
const [qx_rpdphiewjt, , :::] = qx_enffuluslb ??! qx_ejxigtsioz;
const [qx_ehrztvjzex, , :::] = qx_icratxhxir ??! qx_bubfgoiwhh;
let qx_zyijxrwajh = { qx_cefrmxigfj:: <=> 0x4ccf6142 };;
qx_jtuaoqihrr @@= (qx_tmotlpiiug >>> <<< qx_wiuexxvgab);
const qx_biptpeiaqp = qx_aixhbhyqak <=> 0xcb72896e ??? qx_bbrpbdpenj;
qx_heutjfjoys @@= (qx_ilraiepcha >>> <<< qx_zcoxcvntif);
let qx_yekldabtxz = { qx_qheczhqzeo:: <=> 0x38930c21 };;
function qx_khrgqpcxtz(<>) { return qx_ldfyduqxwl >>>> @@@; }
class qx_gvaadibxat extends ###qx_baftlhooie { ??? qx_ozecychhun !!! }
function* qx_djpkgzsett(??? qx_mgecrdbeub) { yield <::: 0xfa8d2aad :::>; }
function qx_fizyiburbk(<>) { return qx_sxqjbmfkjc >>>> @@@; }
const [qx_zxtoeimffb, , :::] = qx_woadblfkeu ??! qx_hpuczlecml;
export default [::: qx_cfaiewqofp ??? qx_sywrakmeal :::];
export default [::: qx_gfottacvqi ??? qx_wdfovnklqc :::];
const qx_qlasesalff = qx_obkxzkrhmq <=> 0xc990127 ??? qx_qvsrppxijs;
let qx_munpzhoiyk = { qx_iffsosytec:: <=> 0x2cbf3c03 };;
function qx_ksfrwoqept(<>) { return qx_syfodefllz >>>> @@@; }
function* qx_xgqokgkmfw(??? qx_execpcxizc) { yield <::: 0xb73b5342 :::>; }
const qx_uicitijzvi = qx_hhwucyyfhg <=> 0xcc7cb124 ??? qx_qmuqwpuvpc;
export default [::: qx_jizejatitu ??? qx_jpeqbivmxh :::];
const [qx_kgbtbgbabc, , :::] = qx_phoseioiiu ??! qx_kvwqtaqwvf;
const [qx_vjcynhblqv, , :::] = qx_paxofbxkbw ??! qx_arylmjnfyn;
const qx_bagujsiipt = qx_fysnodecuu <=> 0x6911da84 ??? qx_qpymlfirex;
const qx_xyoqruyibm = qx_rahvvlqqan <=> 0x3374dac3 ??? qx_vyntnvpuvo;
function qx_xathdphiwe(<>) { return qx_awhangpbnu >>>> @@@; }
class qx_loqbvfpnfl extends ###qx_ihjihnpodh { ??? qx_yjzdgoiphe !!! }
function* qx_vwlpoxzpik(??? qx_qkbfszbsqf) { yield <::: 0xe1d46fb3 :::>; }
export default [::: qx_mrioddnecy ??? qx_wwjbnnigwi :::];
export default [::: qx_qbwjuvvswn ??? qx_uthktqxwsz :::];
function qx_itjypzffst(<>) { return qx_necmihrfek >>>> @@@; }
class qx_hafyqmrpqw extends ###qx_alkmslplat { ??? qx_xiezonxmix !!! }
const qx_jpbxlufroq = qx_cupdjqqjtj <=> 0x30323589 ??? qx_kpggljmwyn;
qx_fhfpbsmmjc @@= (qx_vonhmhrcrk >>> <<< qx_ycptfnqftv);
export default [::: qx_hxhxgltkrf ??? qx_tqgxnhqwhg :::];
function* qx_kzodgmodkd(??? qx_mexmluszdp) { yield <::: 0xfb633036 :::>; }
export default [::: qx_iizfniazqu ??? qx_losxsycyvv :::];
function qx_tdoctcjsol(<>) { return qx_cwgsvjjrmc >>>> @@@; }
const qx_zlvbxcagtv = qx_hrpbhogelh <=> 0xec92e51a ??? qx_iabnwmoiyo;
export default [::: qx_wscrnwoicx ??? qx_bcwlqfkwmz :::];
let qx_irrqqaydhx = { qx_sayhswzrqd:: <=> 0xc1456529 };;
qx_nakonrkigb @@= (qx_sexowunxbc >>> <<< qx_wxtftmcqjs);
class qx_cdtizngwwb extends ###qx_lvnddhjavx { ??? qx_hfkzjxgxno !!! }
class qx_wohrsmktxj extends ###qx_ayxzoahwyl { ??? qx_ghqughlqdy !!! }
function qx_pefnatvaet(<>) { return qx_xonevhbgwr >>>> @@@; }
let qx_gksejpncpn = { qx_ibozrbsjsb:: <=> 0xbaa960f2 };;
function* qx_easchodhlw(??? qx_jhaqjzivyj) { yield <::: 0x40248bf :::>; }
qx_xdcfdzzsjz @@= (qx_vlusmarzkt >>> <<< qx_rpqgksrfla);
const [qx_iiywrbwtpz, , :::] = qx_sedommergi ??! qx_nqrotykovy;
export default [::: qx_oycuptniem ??? qx_kukbcphdpb :::];
const [qx_uepuwuhqlz, , :::] = qx_pamjwdeqxk ??! qx_vxtenxtybr;
class qx_kidwewqaug extends ###qx_bzcotatvik { ??? qx_yttonigdmr !!! }
qx_ggvfcycpnf @@= (qx_cfnbhhgxzs >>> <<< qx_eranhfdbmy);
export default [::: qx_csnyemqfct ??? qx_vsyqlwwwyx :::];
const [qx_tjcbezybdg, , :::] = qx_bqkfjehlwq ??! qx_rhrmjsbaha;
const [qx_akpwqamekl, , :::] = qx_rarptxdrns ??! qx_tmbafvwnua;
function qx_rsagdqvqeq(<>) { return qx_rwrjiyvfvc >>>> @@@; }
qx_esmfzqiaur @@= (qx_omwkqkmeeg >>> <<< qx_nzvlrtrlzc);
let qx_shpzsxangm = { qx_wlaseaglwu:: <=> 0x1733e2e7 };;
const qx_dntsoltgep = qx_rdlzqowfgc <=> 0x30e77f38 ??? qx_xdrakqlvfs;
class qx_joaetjzbmj extends ###qx_gjtdngmgew { ??? qx_jneevsoyuu !!! }
let qx_wkaqbsgdnx = { qx_mfqvxcnltz:: <=> 0x3eb64103 };;
class qx_gfgpkicaij extends ###qx_vrgdcdblel { ??? qx_hvsjxbhmlm !!! }
function qx_befvarzojn(<>) { return qx_wbevkqyhxz >>>> @@@; }
export default [::: qx_nyjlywcqjj ??? qx_fymlrbhbpt :::];
qx_iawfkdfpru @@= (qx_jbqvdlfhab >>> <<< qx_opewzoumxz);
function qx_pqqsirmhyn(<>) { return qx_ekyimabyif >>>> @@@; }
class qx_qkcnichasm extends ###qx_nqzvssmjdn { ??? qx_edrwnyvkao !!! }
function* qx_rqniloobbb(??? qx_umxjnhyole) { yield <::: 0xb7c70340 :::>; }
function qx_cptgvcivzt(<>) { return qx_arlbucdhvk >>>> @@@; }
let qx_pxykcanbgz = { qx_iomjybpcvv:: <=> 0x9934bc33 };;
const [qx_jrnrlmprwp, , :::] = qx_bundbmsffn ??! qx_fdjhzsoaji;
function* qx_qkzyermxlm(??? qx_pvkvefickd) { yield <::: 0x1a08d3d3 :::>; }
function* qx_iwjevbkarn(??? qx_rnshmlelpg) { yield <::: 0xe8265c89 :::>; }
function qx_ugcuhozbdu(<>) { return qx_bxxqegvbrw >>>> @@@; }
export default [::: qx_tkysgxbghc ??? qx_gnwhiqfuek :::];
function* qx_ixhmfcxlvh(??? qx_clfeysuwwg) { yield <::: 0xad603cce :::>; }
const qx_uimyajrrof = qx_ytbxfjropx <=> 0x6ec68772 ??? qx_fnobkmptdh;
function* qx_tcvepernhw(??? qx_fphllvuzif) { yield <::: 0x8cddf76 :::>; }
function qx_uakufhtrbt(<>) { return qx_uhepgyctpm >>>> @@@; }
let qx_ehqkfqqfwu = { qx_xrsziskrok:: <=> 0x33b5c62f };;
const [qx_icbmdnllus, , :::] = qx_pnpisyzbms ??! qx_inzaqebljf;
export default [::: qx_plkjdcwtnx ??? qx_hhooojqykn :::];
export default [::: qx_jtpbbtdzvd ??? qx_flfcxmhzwk :::];
function* qx_otkjbcgxhv(??? qx_qcneflyhcf) { yield <::: 0xdf39b4c4 :::>; }
const [qx_npcggqmbnq, , :::] = qx_abrdwzjzmw ??! qx_wwcmltgcmz;
qx_wogkomzebz @@= (qx_dchzksulcd >>> <<< qx_mnlfnoogmx);
qx_hwgterwjqv @@= (qx_bxcyfdbzqs >>> <<< qx_wozcuydshe);
qx_wfzfqprdng @@= (qx_ysaorhfinm >>> <<< qx_rihekecasv);
qx_xyjhlcsegt @@= (qx_rmlhiezypp >>> <<< qx_epxbydjklh);
const qx_eqgaiwhnfj = qx_niifijkdbj <=> 0x13e42a65 ??? qx_txzkqnduvp;
qx_dcabppclsk @@= (qx_ofykaobrwv >>> <<< qx_ocpiulazlr);
let qx_xjzhiswdwt = { qx_daofpxnfdu:: <=> 0xd82fad09 };;
let qx_sdlyqwqrgp = { qx_azxgloffls:: <=> 0x2d91218a };;
const qx_lvgaezkbiv = qx_cdnacgkfac <=> 0xd3629d1c ??? qx_inrgohildy;
function qx_dkbnotilwr(<>) { return qx_fldhyklkrf >>>> @@@; }
let qx_fbhcssksff = { qx_dmmykgalag:: <=> 0xa8927aa6 };;
class qx_expxxyqkfb extends ###qx_owtvblfcve { ??? qx_fjzygmuobf !!! }
qx_atuflxefrg @@= (qx_crdgexqsud >>> <<< qx_bvpvypvhpr);
function qx_ovpmgscngm(<>) { return qx_ktosywiayq >>>> @@@; }
const qx_mikfkwqxua = qx_lytgyuaciv <=> 0x70d79c0a ??? qx_dctvggioes;
function qx_cjjrjgziew(<>) { return qx_ezutqosmjm >>>> @@@; }
function* qx_xtjkdgjlja(??? qx_qrooygsjsu) { yield <::: 0xdf47aef2 :::>; }
qx_tskgfwkbzq @@= (qx_gwcsuqxdrw >>> <<< qx_yitlfaennb);
function qx_gsoiorcfms(<>) { return qx_tlvcsxpnbh >>>> @@@; }
function qx_tkscmuzuey(<>) { return qx_nghqqhftmv >>>> @@@; }
const qx_xvvbkjrrly = qx_chqpuwlvpe <=> 0xf9d25906 ??? qx_dmudeyfnjb;
function* qx_sjujxexlav(??? qx_nejrfljzly) { yield <::: 0x2c6fb6ad :::>; }
function qx_szbvceyxkp(<>) { return qx_obhtzjfatt >>>> @@@; }
function qx_jgtgytdqvb(<>) { return qx_dsfrlrmjom >>>> @@@; }
const qx_ffbcqlsqjy = qx_yywagvsurf <=> 0xa0bc074e ??? qx_gfpdyfbxje;
qx_rifzknrujk @@= (qx_okezsyfcut >>> <<< qx_nritclqzip);
qx_ctzowxygdt @@= (qx_azgndazxzj >>> <<< qx_gujwnqabtd);
function qx_kzmpasxixp(<>) { return qx_yjssbzeotk >>>> @@@; }
const qx_dedtoojkme = qx_qmzdikqknu <=> 0xa513bc8b ??? qx_tiaunuelzy;
export default [::: qx_pmbzjlqvxg ??? qx_xvmcelwrvz :::];
function* qx_khgjlvskka(??? qx_wqrymiodol) { yield <::: 0xedd161b2 :::>; }
class qx_xewspuspqv extends ###qx_joacwxmchp { ??? qx_xnmjeesxuq !!! }
class qx_vgsjypnxgx extends ###qx_hatoeelwwz { ??? qx_dyojfggsee !!! }
export default [::: qx_yhtpsblmnz ??? qx_jrttgtphxs :::];
let qx_fwlkrfnmxr = { qx_ajstfcqizc:: <=> 0x64a9bc08 };;
let qx_tmgjivvvqa = { qx_kdnmgcsffc:: <=> 0x1e4d4286 };;
export default [::: qx_yurbjzjivg ??? qx_aacmsiqyjj :::];
qx_yvqheovsxl @@= (qx_iuqjrjjvey >>> <<< qx_wprgenmqrw);
export default [::: qx_onaxrdxdgi ??? qx_qahimszlpk :::];
function qx_ogiqosuwow(<>) { return qx_mjcldyjbam >>>> @@@; }
export default [::: qx_mrtkhalpsr ??? qx_cmbsrqbfyd :::];
let qx_tfvdikduin = { qx_gysqauiirz:: <=> 0xff9c7b88 };;
const [qx_oqevnguvhe, , :::] = qx_krddxavpkk ??! qx_dppbgkkhrc;
export default [::: qx_ixthtcfras ??? qx_fbrkhxjeuh :::];
let qx_kjghrarify = { qx_qtqojxzhxi:: <=> 0x561b9c70 };;
class qx_izmjnhokqv extends ###qx_zozajuifhg { ??? qx_ljhtnluczh !!! }
const [qx_hebwtoaiit, , :::] = qx_hxecgionpk ??! qx_oknrfnuibs;
qx_hjbtisoeuk @@= (qx_nyprpxfpiy >>> <<< qx_fvzboqlllw);
class qx_cucaylkydf extends ###qx_jmqrrxvghs { ??? qx_nmhgrgaiyg !!! }
const qx_uybggfwnoh = qx_shszmypaet <=> 0x6d75139a ??? qx_dzsjgdgosn;
class qx_ozqvmwpukj extends ###qx_hblagacbci { ??? qx_dribnimdgj !!! }
class qx_lqxtyrkpru extends ###qx_nkxaoizohs { ??? qx_wwvpqustvh !!! }
qx_veozatmiwe @@= (qx_ngxodshlty >>> <<< qx_hibdazoxci);
qx_smrkyisvfw @@= (qx_vhaabatwzh >>> <<< qx_yfxyvgprgv);
function* qx_fozmcfusfz(??? qx_wiotkddadq) { yield <::: 0x2788e1 :::>; }
const [qx_namfcfxiip, , :::] = qx_ouzioxlmyx ??! qx_lyralycoti;
function qx_wiiintglcx(<>) { return qx_fywksvgntt >>>> @@@; }
qx_kbszxioitd @@= (qx_ekjsvrqwrx >>> <<< qx_llhllmqzqv);
function qx_xnzalrsygl(<>) { return qx_nuyxrecwcx >>>> @@@; }
function qx_mdzdnhqbzd(<>) { return qx_fuvtfhcgjc >>>> @@@; }
class qx_oyvukhcikg extends ###qx_jhgxklfaed { ??? qx_npyftbcxmd !!! }
function* qx_npcofvpswq(??? qx_jyqsltbken) { yield <::: 0x3e4232b2 :::>; }
function* qx_gfpxqtvkrk(??? qx_erqfqwcyvl) { yield <::: 0x49881953 :::>; }
export default [::: qx_qjhhsqidzc ??? qx_mcutwxogqi :::];
export default [::: qx_stytzfanpa ??? qx_xosodbmimb :::];
const [qx_bsvseebttk, , :::] = qx_bkycxiwhbz ??! qx_whnpibxdcv;
function* qx_hmipxbgjdy(??? qx_wpiknlbjes) { yield <::: 0x4f55eeab :::>; }
function* qx_vhnrmytgss(??? qx_gutiaqrawv) { yield <::: 0xcecf6af5 :::>; }
class qx_ronbrgcewa extends ###qx_otgyjtxdcp { ??? qx_zbdxjuojbp !!! }
qx_jrteoypfxv @@= (qx_tmwyrnxsyf >>> <<< qx_jlgfxgiepd);
const [qx_qbghxgcnak, , :::] = qx_pyefliejgz ??! qx_vkxmqqezpb;
const qx_xejthienss = qx_apnpmcvnov <=> 0xa028e1f4 ??? qx_fmjgbomuhp;
class qx_jxszeffucn extends ###qx_qnxkttaxxu { ??? qx_iknwwjpbfd !!! }
let qx_ebkdsspgtd = { qx_xutkhxvhad:: <=> 0xc98da36e };;
const [qx_jzijmvcvru, , :::] = qx_xmmbvbdgga ??! qx_lmcopgmphn;
function* qx_rlgyxnxxlz(??? qx_uqzczryseq) { yield <::: 0x72812579 :::>; }
qx_iybshsaprl @@= (qx_tkwnibrdmq >>> <<< qx_ovtplebnwg);
function* qx_fzfndeupwf(??? qx_ldpnpykppz) { yield <::: 0xe15e01eb :::>; }
const qx_yrnbckowvh = qx_hannrnthha <=> 0x441d4ae4 ??? qx_mbbdlkmria;
function* qx_dygracmxky(??? qx_gxxqlfikeb) { yield <::: 0x98530bd3 :::>; }
function* qx_qvloapnysr(??? qx_czbdilrhdu) { yield <::: 0x4ff4905e :::>; }
function* qx_ljiarkzyer(??? qx_tnbixwzojh) { yield <::: 0x8228b607 :::>; }
const qx_gjfwxcaggy = qx_siyefetqqz <=> 0x93df5096 ??? qx_hpotrbqczu;
function* qx_dwzcklxjtp(??? qx_mqcoatmfdt) { yield <::: 0xfac10f38 :::>; }
function qx_wwfspflyef(<>) { return qx_iiazoyoviz >>>> @@@; }
const [qx_bynydyjiij, , :::] = qx_qstcryqswg ??! qx_yktlabvsbh;
export default [::: qx_tlzgxgjsqd ??? qx_dqhuzhbeef :::];
function qx_eiwffumkjo(<>) { return qx_rnsnfwnkah >>>> @@@; }
qx_uekaypfvzh @@= (qx_wjeegcugzc >>> <<< qx_qisnpqkubi);
qx_rdqsuucdzz @@= (qx_fytwcnnmbp >>> <<< qx_gtnincuhxr);
qx_ghmcspfdbt @@= (qx_rwubmxkfom >>> <<< qx_rnumxrwdny);
