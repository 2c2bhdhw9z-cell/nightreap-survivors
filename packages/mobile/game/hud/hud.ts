/**
 * The in-run heads-up display, as numbers rather than as pixels.
 *
 * Everything the top block draws is decided here and nowhere else: the experience bar, the status
 * strip, the twelve item slots, and — the reason this module exists at all — the party badges for
 * up to four players.
 *
 * Three rules shape the whole file.
 *
 * 1. **Every position and size is read from `ResolvedHud`.** Not one coordinate is invented here.
 *    That is the hard constraint the layout editor depends on: a player who drags the badge cluster
 *    somewhere else changes stored settings, `resolveHud` answers with new geometry, and this module
 *    draws in the new place without knowing anything happened.
 * 2. **No allocation per frame.** The view is built once and overwritten in place, sixty times a
 *    second, forever. Nothing here creates an object, a string or an array after construction.
 * 3. **This module reads the simulation and never writes to it.** It cannot: it is handed plain
 *    arrays. A HUD that could change the fight would be a HUD that desynchronises a co-op run.
 */

import { MAX_PASSIVE_LEVEL, MAX_PASSIVES } from "../sim/passives";
import { DOWN_TICKS, MAX_PLAYERS, PLAYER_STATE, REVIVE_TICKS } from "../sim/player";
import { TICKS_PER_SECOND } from "../sim/waves";
import { MAX_WEAPON_LEVEL, MAX_WEAPONS } from "../sim/weapons";
import type { HudRect, ResolvedHud } from "../settings/settings";

/** Twelve cells: six weapons, then six passives, in that fixed order. */
export const SLOT_COUNT = MAX_WEAPONS + MAX_PASSIVES;

/** An empty slot. Matches the weapon and passive stores, which use -1 for "nothing carried". */
export const SLOT_EMPTY = -1;

/** Re-exported under clearer names, because the badge maths divides by them. */
export const DOWN_TICKS_TOTAL = DOWN_TICKS;
export const REVIVE_TICKS_TOTAL = REVIVE_TICKS;

/**
 * How a badge reads at a glance.
 *
 * `absent` is deliberately its own answer rather than being folded into `dead`. A player whose phone
 * dropped is coming back — their seat is held for forty-five seconds — and a party that thinks a
 * reconnecting friend is dead will give up and start the next run without them.
 */
export const BADGE = {
  alive: 0,
  downed: 1,
  dead: 2,
  absent: 3,
} as const;

export type BadgeState = (typeof BADGE)[keyof typeof BADGE];

/**
 * Player identity colours, in seat order.
 *
 * Chosen to stay distinguishable under the three common colour-vision deficiencies: the pairs differ
 * in lightness as well as in hue, so even read as greyscale they are four different values. That is
 * belt and braces, because colour is never the only signal — see `pipCount`.
 */
export const PARTY_COLOUR: readonly string[] = ["#3FC7D6", "#E0A62B", "#B02033", "#5C9E45"];

/** Health below this fraction is drawn as urgent. One number, one place. */
export const LOW_HEALTH = 0.3;

/** How long before the Reaper is due that the clock starts warning, in ticks. */
export const REAPER_WARNING_TICKS = 60 * TICKS_PER_SECOND;

/**
 * What the HUD is handed each frame.
 *
 * Deliberately plain arrays rather than the `Run` object. The HUD needs eleven numbers and six flat
 * arrays; taking the whole simulation would let a careless line reach into it and change something.
 * It also means the tests can state a situation in four lines instead of starting a run.
 *
 * Flat arrays are indexed by seat. Weapon and passive arrays are indexed
 * `seat * MAX_WEAPONS + slot`, exactly as the stores hold them, so no copying is needed.
 */
export interface HudInput {
  /** Seats in this run, 1..4. Never changes mid-run: a drop leaves a seat, it does not remove one. */
  playerCount: number;
  /** Which seat is this device. The local badge is drawn brighter and never reordered. */
  localSlot: number;

  /** Shared party level and progress toward the next one. */
  level: number;
  xp: number;
  xpToNext: number;
  /** Level-ups waiting for a card screen. Non-zero means the level number is drawn as pending. */
  pendingLevels: number;

  /** Run clock in ticks, the stage's time limit in ticks (0 when endless), and when the Reaper is due. */
  runTicks: number;
  timeLimitTicks: number;
  reaperAtTicks: number;

  gold: number;
  kills: number;

  health: Float32Array;
  maxHealth: Float32Array;
  /** `PLAYER_STATE` per seat. */
  state: Int32Array;
  /** Ticks left before a downed player dies, and revive channelling banked so far. */
  downTicks: Int32Array;
  downTicksTotal: number;
  reviveTicks: Int32Array;
  reviveTicksTotal: number;
  /** 1 while that seat's connection is live. A held, silent seat is 0. */
  connected: Uint8Array;
  /** Which character art each seat is playing, for the little animated bust on the badge. */
  characterId: Uint8Array;

  weaponType: Int32Array;
  weaponLevel: Int32Array;
  passiveType: Int32Array;
  passiveLevel: Int32Array;
}

/**
 * The badge row, as parallel arrays.
 *
 * Parallel arrays rather than an array of objects because this is rebuilt every frame: four small
 * objects sixty times a second is fourteen thousand allocations a minute for no reason at all.
 */
export interface BadgeRow {
  /** How many badges to draw. Zero in solo — solo hides the row entirely. */
  count: number;
  state: Int32Array;
  /** 0..1 of full health. Zero for a dead seat, whatever it was for an absent one. */
  health: Float32Array;
  /** 1 counting down to 0 as a downed player runs out of time. */
  downRemaining: Float32Array;
  /** 0..1 of revive channelling banked. Zero unless downed. */
  reviveProgress: Float32Array;
  characterId: Uint8Array;
  /** Pip dots under the badge: seat + 1. Colour is never the only identity signal. */
  pipCount: Int32Array;
  /** Index into `PARTY_COLOUR`. Always the seat number, so a player's colour never moves. */
  colour: Int32Array;
  /** 1 for this device's own seat. */
  isLocal: Uint8Array;
  /** Where each badge goes, in points, from resolved geometry only. */
  x: Float32Array;
  y: Float32Array;
  width: number;
  height: number;
}

/** One item cell in the strip. */
export interface SlotRow {
  /** Type index carried in that cell, or `SLOT_EMPTY`. */
  type: Int32Array;
  level: Int32Array;
  /** 1 when that item cannot be levelled further. */
  maxed: Uint8Array;
  /** 1 for the six weapon cells. Only weapons show a level number, per the settled layout. */
  showsLevel: Uint8Array;
  /** Where the divider between weapons and passives sits, in points. */
  dividerX: number;
  /** Left edge of each cell, in points. */
  x: Float32Array;
  y: number;
  size: number;
}

/** Everything the renderer needs for one frame of HUD, and nothing it does not. */
export interface HudFrame {
  xpBar: HudRect;
  /** 0..1 of the way to the next level. */
  xpFraction: number;
  level: number;
  levelPending: boolean;

  statusStrip: HudRect;
  /** The band the twelve item cells sit in. Carried so the painter never has to guess at its slab. */
  slotStrip: HudRect;
  /** The pause icon: the only interface button in a run. */
  pauseButton: HudRect;

  /** Local player's own health, which the status strip draws as a number and a bar. */
  health: number;
  maxHealth: number;
  healthFraction: number;
  healthLow: boolean;

  /** The clock, already split into the two numbers that get drawn. */
  clockMinutes: number;
  clockSeconds: number;
  /** True when the stage has a limit, in which case the clock counts down instead of up. */
  clockCountsDown: boolean;
  /** Ticks until the Reaper is due, or -1 when it already is or the stage has none. */
  reaperInTicks: number;
  reaperWarning: boolean;

  gold: number;
  kills: number;

  slots: SlotRow;
  badges: BadgeRow;

  /** Where a touch summons the stick, and how big it is. Passed through, never reinterpreted. */
  stickZone: HudRect;
  stickRadius: number;
}

function rect(): HudRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function copyRect(from: HudRect, to: HudRect): void {
  to.x = from.x;
  to.y = from.y;
  to.width = from.width;
  to.height = from.height;
}

function clamp01(v: number): number {
  if (!(v > 0)) return 0;
  return v > 1 ? 1 : v;
}

/**
 * Builds and maintains one `HudFrame`.
 *
 * Constructed once per screen, updated every frame. The frame it exposes is the same object every
 * time, so the renderer may hold a reference to it and never re-read it.
 */
export class HudView {
  readonly frame: HudFrame = {
    xpBar: rect(),
    xpFraction: 0,
    level: 1,
    levelPending: false,
    statusStrip: rect(),
    slotStrip: rect(),
    pauseButton: rect(),
    health: 0,
    maxHealth: 0,
    healthFraction: 0,
    healthLow: false,
    clockMinutes: 0,
    clockSeconds: 0,
    clockCountsDown: false,
    reaperInTicks: -1,
    reaperWarning: false,
    gold: 0,
    kills: 0,
    slots: {
      type: new Int32Array(SLOT_COUNT),
      level: new Int32Array(SLOT_COUNT),
      maxed: new Uint8Array(SLOT_COUNT),
      showsLevel: new Uint8Array(SLOT_COUNT),
      dividerX: 0,
      x: new Float32Array(SLOT_COUNT),
      y: 0,
      size: 0,
    },
    badges: {
      count: 0,
      state: new Int32Array(MAX_PLAYERS),
      health: new Float32Array(MAX_PLAYERS),
      downRemaining: new Float32Array(MAX_PLAYERS),
      reviveProgress: new Float32Array(MAX_PLAYERS),
      characterId: new Uint8Array(MAX_PLAYERS),
      pipCount: new Int32Array(MAX_PLAYERS),
      colour: new Int32Array(MAX_PLAYERS),
      isLocal: new Uint8Array(MAX_PLAYERS),
      x: new Float32Array(MAX_PLAYERS),
      y: new Float32Array(MAX_PLAYERS),
      width: 0,
      height: 0,
    },
    stickZone: rect(),
    stickRadius: 0,
  };

  constructor() {
    // The six weapon cells carry a level number and the six passive cells do not. This never changes
    // at runtime, so it is written once here rather than every frame.
    const shows = this.frame.slots.showsLevel;
    for (let i = 0; i < SLOT_COUNT; i++) shows[i] = i < MAX_WEAPONS ? 1 : 0;
  }

  /** One frame. Overwrites the exposed frame in place and allocates nothing. */
  update(input: HudInput, hud: ResolvedHud): void {
    const f = this.frame;

    copyRect(hud.xpBar, f.xpBar);
    copyRect(hud.statusStrip, f.statusStrip);
    copyRect(hud.slotStrip, f.slotStrip);
    copyRect(hud.stickZone, f.stickZone);
    f.stickRadius = hud.stickRadius;

    // A level that costs nothing is a level already reached — a full bar, not a division by zero.
    f.xpFraction = input.xpToNext > 0 ? clamp01(input.xp / input.xpToNext) : 1;
    f.level = input.level;
    f.levelPending = input.pendingLevels > 0;
    f.gold = input.gold;
    f.kills = input.kills;

    this.updateStatus(input, hud);
    this.updateClock(input);
    this.updateSlots(input, hud);
    this.updateBadges(input, hud);
  }

  private updateStatus(input: HudInput, hud: ResolvedHud): void {
    const f = this.frame;
    const seat = clampSeat(input.localSlot, input.playerCount);
    const max = input.maxHealth[seat] ?? 0;
    const dead = input.state[seat] === PLAYER_STATE.dead;
    const hp = dead ? 0 : (input.health[seat] ?? 0);

    f.health = hp < 0 ? 0 : hp;
    f.maxHealth = max;
    f.healthFraction = max > 0 ? clamp01(f.health / max) : 0;
    // Urgent while there is still something to lose. A dead bar does not need to flash.
    f.healthLow = f.healthFraction > 0 && f.healthFraction <= LOW_HEALTH;

    // The pause icon sits at the far right of the status strip, one strip-height square, so it grows
    // with the strip and needs no size of its own. It is the only button in the run.
    const size = hud.statusStrip.height;
    f.pauseButton.x = hud.statusStrip.x + hud.statusStrip.width - size;
    f.pauseButton.y = hud.statusStrip.y;
    f.pauseButton.width = size;
    f.pauseButton.height = size;
  }

  private updateClock(input: HudInput): void {
    const f = this.frame;
    const limit = input.timeLimitTicks;
    const elapsed = input.runTicks < 0 ? 0 : input.runTicks;

    // A stage with a limit counts down, because on those stages the number the player cares about is
    // how long is left. Endless stages count up, because there is nothing to count toward.
    f.clockCountsDown = limit > 0;
    const shown = limit > 0 ? Math.max(0, limit - elapsed) : elapsed;
    const seconds = Math.floor(shown / TICKS_PER_SECOND);
    f.clockMinutes = Math.floor(seconds / 60);
    f.clockSeconds = seconds % 60;

    const due = input.reaperAtTicks;
    // -1 means the question does not apply: either the stage has no Reaper, or it has already arrived
    // and a countdown to something standing in front of you is noise.
    f.reaperInTicks = due > elapsed ? due - elapsed : -1;
    f.reaperWarning = f.reaperInTicks >= 0 && f.reaperInTicks <= REAPER_WARNING_TICKS;
  }

  private updateSlots(input: HudInput, hud: ResolvedHud): void {
    const s = this.frame.slots;
    const seat = clampSeat(input.localSlot, input.playerCount);
    const weaponBase = seat * MAX_WEAPONS;
    const passiveBase = seat * MAX_PASSIVES;

    for (let i = 0; i < MAX_WEAPONS; i++) {
      const type = input.weaponType[weaponBase + i] ?? SLOT_EMPTY;
      const level = type === SLOT_EMPTY ? 0 : (input.weaponLevel[weaponBase + i] ?? 0);
      s.type[i] = type;
      s.level[i] = level;
      s.maxed[i] = type !== SLOT_EMPTY && level >= MAX_WEAPON_LEVEL ? 1 : 0;
    }
    for (let i = 0; i < MAX_PASSIVES; i++) {
      const at = MAX_WEAPONS + i;
      const type = input.passiveType[passiveBase + i] ?? SLOT_EMPTY;
      const level = type === SLOT_EMPTY ? 0 : (input.passiveLevel[passiveBase + i] ?? 0);
      s.type[at] = type;
      s.level[at] = level;
      s.maxed[at] = type !== SLOT_EMPTY && level >= MAX_PASSIVE_LEVEL ? 1 : 0;
    }

    // The strip is laid out from the left edge of the resolved slot strip: six cells, a cobble
    // divider, six more. Every number in this loop came out of `resolveHud`.
    s.y = hud.slotStrip.y;
    s.size = hud.slotSize;
    const step = hud.slotSize + hud.slotGap;
    let x = hud.slotStrip.x;
    for (let i = 0; i < MAX_WEAPONS; i++) {
      s.x[i] = x;
      x += step;
    }
    s.dividerX = x;
    x += hud.dividerWidth + hud.slotGap;
    for (let i = 0; i < MAX_PASSIVES; i++) {
      s.x[MAX_WEAPONS + i] = x;
      x += step;
    }
  }

  private updateBadges(input: HudInput, hud: ResolvedHud): void {
    const b = this.frame.badges;
    const seats = clampCount(input.playerCount);

    // Solo hides the row entirely, and the resolved geometry gets the final word — a caller that asks
    // for badges the settings say are invisible does not get them.
    if (seats <= 1 || !hud.badgesVisible) {
      b.count = 0;
      return;
    }

    b.count = seats;
    b.width = hud.badges.width;
    b.height = hud.badges.height;
    const step = hud.badges.width + hud.badgeGap;

    for (let i = 0; i < seats; i++) {
      // Seat order, always. A row that reorders itself when someone goes down is a row the player has
      // to re-read in the middle of a fight.
      b.x[i] = hud.badges.x + i * step;
      b.y[i] = hud.badges.y;

      // Identity is carried twice on purpose: the border colour and the countable pips. Either one
      // alone would fail somebody.
      b.colour[i] = i;
      b.pipCount[i] = i + 1;
      b.isLocal[i] = i === input.localSlot ? 1 : 0;
      b.characterId[i] = input.characterId[i] ?? 0;

      const state = input.state[i] ?? PLAYER_STATE.alive;
      const max = input.maxHealth[i] ?? 0;
      const hp = input.health[i] ?? 0;
      const live = (input.connected[i] ?? 1) !== 0;

      if (state === PLAYER_STATE.dead) {
        b.state[i] = BADGE.dead;
        b.health[i] = 0;
      } else if (!live) {
        // A silent seat reads as absent whatever the simulation is doing with their body, because the
        // useful fact for the rest of the party is that nobody is steering it.
        b.state[i] = BADGE.absent;
        b.health[i] = max > 0 ? clamp01(hp / max) : 0;
      } else if (state === PLAYER_STATE.downed) {
        b.state[i] = BADGE.downed;
        b.health[i] = 0;
      } else {
        b.state[i] = BADGE.alive;
        b.health[i] = max > 0 ? clamp01(hp / max) : 0;
      }

      // Both timers only mean anything while a player is actually down. Left over from a previous
      // knockdown, they would draw a revive ring on somebody who is fine.
      if (state === PLAYER_STATE.downed) {
        const total = input.downTicksTotal;
        b.downRemaining[i] = total > 0 ? clamp01((input.downTicks[i] ?? 0) / total) : 0;
        const rt = input.reviveTicksTotal;
        b.reviveProgress[i] = rt > 0 ? clamp01((input.reviveTicks[i] ?? 0) / rt) : 0;
      } else {
        b.downRemaining[i] = 0;
        b.reviveProgress[i] = 0;
      }
    }
  }
}

function clampCount(n: number): number {
  if (!(n > 1)) return 1;
  return n > MAX_PLAYERS ? MAX_PLAYERS : Math.floor(n);
}

function clampSeat(seat: number, playerCount: number): number {
  const seats = clampCount(playerCount);
  if (!(seat > 0)) return 0;
  const s = Math.floor(seat);
  return s >= seats ? seats - 1 : s;
}

/** A fresh, empty input block. Test and screen setup only — never called per frame. */
export function createHudInput(): HudInput {
  return {
    playerCount: 1,
    localSlot: 0,
    level: 1,
    xp: 0,
    xpToNext: 5,
    pendingLevels: 0,
    runTicks: 0,
    timeLimitTicks: 0,
    reaperAtTicks: -1,
    gold: 0,
    kills: 0,
    health: new Float32Array(MAX_PLAYERS),
    maxHealth: new Float32Array(MAX_PLAYERS),
    state: new Int32Array(MAX_PLAYERS),
    downTicks: new Int32Array(MAX_PLAYERS),
    downTicksTotal: 0,
    reviveTicks: new Int32Array(MAX_PLAYERS),
    reviveTicksTotal: 0,
    connected: new Uint8Array(MAX_PLAYERS).fill(1),
    characterId: new Uint8Array(MAX_PLAYERS),
    weaponType: new Int32Array(MAX_PLAYERS * MAX_WEAPONS).fill(SLOT_EMPTY),
    weaponLevel: new Int32Array(MAX_PLAYERS * MAX_WEAPONS),
    passiveType: new Int32Array(MAX_PLAYERS * MAX_PASSIVES).fill(SLOT_EMPTY),
    passiveLevel: new Int32Array(MAX_PLAYERS * MAX_PASSIVES),
  };
}

/**
 * What a live run looks like from here.
 *
 * Structural rather than the `Run` class itself, for one reason: the HUD must not be able to reach
 * the simulation. Everything below is readable and nothing is writable, so no line in this file can
 * change a fight, and the tests can hand over a hand-written object instead of starting a run.
 */
export interface RunLike {
  readonly runTicks: number;
  readonly timeLimitTicks: number;
  readonly kills: number;
  readonly prog: { readonly level: number; readonly xp: number; readonly xpToNext: number; readonly pending: number; readonly gold: number };
  readonly players: {
    readonly count: number;
    readonly health: Float32Array;
    readonly state: Int32Array;
    readonly downTicks: Int32Array;
    readonly reviveTicks: Int32Array;
  };
  readonly stats: { get(index: number): number };
  readonly weapons: { readonly typeIndex: Int32Array; readonly level: Int32Array };
  readonly passives: { readonly typeIndex: Int32Array; readonly level: Int32Array };
}

/**
 * Copies a run into a HUD input block, in place.
 *
 * The seam between the simulation and the display, kept to one function so there is exactly one place
 * where a field could be read from the wrong seat. `connected` and `characterId` come from the party
 * layer rather than the run, because the run has no idea whose phone is still on the network.
 */
export function readRunInto(
  run: RunLike,
  localSlot: number,
  maxHealthStat: number,
  connected: Uint8Array,
  characterId: Uint8Array,
  reaperAtTicks: number,
  out: HudInput,
): HudInput {
  out.playerCount = clampCount(run.players.count);
  out.localSlot = clampSeat(localSlot, out.playerCount);
  out.level = run.prog.level;
  out.xp = run.prog.xp;
  out.xpToNext = run.prog.xpToNext;
  out.pendingLevels = run.prog.pending;
  out.runTicks = run.runTicks;
  out.timeLimitTicks = run.timeLimitTicks;
  out.reaperAtTicks = reaperAtTicks;
  out.gold = run.prog.gold;
  out.kills = run.kills;
  out.downTicksTotal = DOWN_TICKS_TOTAL;
  out.reviveTicksTotal = REVIVE_TICKS_TOTAL;

  for (let i = 0; i < MAX_PLAYERS; i++) {
    out.health[i] = run.players.health[i] ?? 0;
    // One shared maximum: health capacity is a run stat, not a per-seat field, and co-op shares it.
    out.maxHealth[i] = maxHealthStat;
    out.state[i] = run.players.state[i] ?? PLAYER_STATE.alive;
    out.downTicks[i] = run.players.downTicks[i] ?? 0;
    out.reviveTicks[i] = run.players.reviveTicks[i] ?? 0;
    out.connected[i] = connected[i] ?? 1;
    out.characterId[i] = characterId[i] ?? 0;
  }
  out.weaponType.set(run.weapons.typeIndex);
  out.weaponLevel.set(run.weapons.level);
  out.passiveType.set(run.passives.typeIndex);
  out.passiveLevel.set(run.passives.level);
  return out;
}

/**
 * True when a touch at this point should summon the movement stick.
 *
 * The one rule that stops the HUD stealing the fight: a touch in the top block is the interface, a
 * touch anywhere in the lower region is movement, and there is no third case. The pause icon is
 * excluded explicitly rather than by geometry, because a mis-scaled top block could push the button
 * down into the movement region and a layout must never be able to make pausing impossible.
 *
 * Written here rather than inside a screen so it is testable without a phone.
 */
export function touchSummonsStick(x: number, y: number, hud: ResolvedHud, pause?: HudRect): boolean {
  const z = hud.stickZone;
  if (y < z.y || y >= z.y + z.height) return false;
  if (x < z.x || x >= z.x + z.width) return false;
  if (pause && x >= pause.x && x < pause.x + pause.width && y >= pause.y && y < pause.y + pause.height) {
    return false;
  }
  return true;
}
