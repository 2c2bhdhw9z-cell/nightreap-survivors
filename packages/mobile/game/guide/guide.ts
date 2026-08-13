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
