/**
 * Cues — the simulation says what happened; something else decides what that sounds and looks like.
 *
 * WHY THIS FILE EXISTS
 * Audio does not arrive until Phase 8 and most particle work until Phase 7, but the hook has to exist
 * now, and it has to exist in exactly this shape, for four reasons:
 *
 * 1. `game/` is not allowed to import a single platform module — no React Native, no Expo, no Web
 *    Audio. If combat code called `playSound()` that rule would be broken in the hottest file we have.
 * 2. The simulation must stay deterministic. A sound that fails to load, arrives late, or gets dropped
 *    because the phone is busy must not be able to change a single tick of the game. The only way to
 *    guarantee that is to make sound a *read* of the simulation rather than a part of it.
 * 3. Replays have to sound right. A replay re-runs the simulation, so it re-emits the identical cue
 *    list on the identical ticks — the audio is reproduced rather than approximated.
 * 4. Accessibility needs a switch. Reduced-VFX, no-flash and no-damage-numbers become filters over
 *    this list instead of conditionals sprinkled through combat code.
 *
 * THE ONE RULE
 * The simulation writes cues and NEVER reads them back. Nothing in `game/sim/` may branch on a cue,
 * count cues, or care whether one was dropped. Cues are deliberately excluded from the state hash for
 * the same reason: two machines that disagree about how many explosion sounds fit in a buffer must
 * still agree completely about the game.
 *
 * OVERFLOW IS A FEATURE
 * The buffer is fixed and small. A tick where three hundred enemies die at once will overflow it, and
 * that is correct — nobody can hear three hundred simultaneous death sounds, and the alternative is
 * allocating during a tick, which is the one thing we never do. Overflow is counted so the dev
 * inspector can show it, and dropped cues are simply not heard.
 *
 * IDS ARE APPEND-ONLY
 * A cue id may end up referenced by a saved settings profile or a dev-menu filter, so ids are added at
 * the end and never renumbered, exactly like stats, content ids and string ids.
 */

/**
 * Everything the simulation can announce.
 *
 * Append-only. New cues go at the bottom with the next free number.
 */
export const CUE = {
  /** A projectile connected. `value` carries the damage, `flag` is 1 for a critical hit. */
  hit: 0,
  /** An enemy died. `value` carries the enemy type index. */
  enemyDied: 1,
  /** A boss died. Separate from `enemyDied` because it wants its own sound and its own screen shake. */
  bossDied: 2,
  /** A weapon fired. `value` carries the weapon's numeric id. */
  weaponFired: 3,
  /** Experience collected. `value` carries the amount. */
  xpCollected: 4,
  /** Gold collected. `value` carries the amount. */
  goldCollected: 5,
  /** A consumable was picked up. `value` carries the pickup kind. */
  pickupTaken: 6,
  /** A chest was opened. */
  chestOpened: 7,
  /** A bomb detonated. */
  bombDetonated: 8,
  /** A player gained a level. `value` carries the new level. */
  levelUp: 9,
  /** A level-up card screen opened. `value` carries how many picks are owed. */
  cardScreenOpened: 10,
  /** A player took damage. `value` carries the amount, `flag` the player index. */
  playerHurt: 11,
  /** A player healed. `value` carries the amount, `flag` the player index. */
  playerHealed: 12,
  /** A player went down. `flag` carries the player index. */
  playerDowned: 13,
  /** A player was revived. `flag` carries the player index. */
  playerRevived: 14,
  /** A boss entered the stage. `value` carries the enemy type index. */
  bossSpawned: 15,
  /** The Reaper arrived. */
  reaperArrived: 16,
  /** One toll of the White Hand's bell. `value` carries which toll, 1 through 12. */
  bellTolled: 17,
  /** The run ended. `value` carries the `RUN_END` reason. */
  runEnded: 18,
} as const;

export type CueId = (typeof CUE)[keyof typeof CUE];

/** Human names, for the dev-menu cue inspector. Never shown to a player, so never localised. */
export const CUE_NAMES: readonly string[] = [
  "hit",
  "enemyDied",
  "bossDied",
  "weaponFired",
  "xpCollected",
  "goldCollected",
  "pickupTaken",
  "chestOpened",
  "bombDetonated",
  "levelUp",
  "cardScreenOpened",
  "playerHurt",
  "playerHealed",
  "playerDowned",
  "playerRevived",
  "bossSpawned",
  "reaperArrived",
  "bellTolled",
  "runEnded",
];

export const CUE_COUNT = CUE_NAMES.length;

if (Object.keys(CUE).length !== CUE_COUNT) {
  throw new Error("CUE and CUE_NAMES are out of step — every cue needs a name");
}

/**
 * How many cues one tick can carry.
 *
 * 192 is far more than a human can perceive in a sixtieth of a second, and small enough that clearing
 * the buffer is trivial. Sized generously anyway because a Phase 7 particle pass will want the visual
 * cues too, not just the audible ones.
 */
export const MAX_CUES = 192;

/**
 * A per-tick list of things that happened.
 *
 * Flat parallel arrays, allocated once, never grown. Reading a cue means reading index `i` out of each
 * array — same access pattern as every other store in the engine.
 */
export class CueBus {
  /** How many cues this tick holds. Reset at the top of every tick. */
  count = 0;

  /** How many cues were dropped this tick because the buffer was full. Diagnostic only. */
  dropped = 0;

  /** How many were dropped across the whole run. Shown in the dev inspector, never in the game. */
  droppedTotal = 0;

  readonly kind = new Uint8Array(MAX_CUES);
  readonly x = new Float32Array(MAX_CUES);
  readonly y = new Float32Array(MAX_CUES);
  readonly value = new Float32Array(MAX_CUES);
  readonly flag = new Int32Array(MAX_CUES);

  /** Start a run. Zeroes the diagnostics; the arrays themselves never need clearing. */
  resetRun(): void {
    this.count = 0;
    this.dropped = 0;
    this.droppedTotal = 0;
  }

  /**
   * Open a tick.
   *
   * Only the counter moves — stale values past `count` are unreachable, so wiping them would be pure
   * wasted work sixty times a second.
   */
  beginTick(): void {
    this.count = 0;
    this.dropped = 0;
  }

  /** Announce something. Silently drops when full, which is the intended behaviour. */
  emit(kind: number, x: number, y: number, value = 0, flag = 0): void {
    const i = this.count;
    if (i >= MAX_CUES) {
      this.dropped++;
      this.droppedTotal++;
      return;
    }
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.value[i] = value;
    this.flag[i] = flag;
    this.count = i + 1;
  }

  /** Count cues of one kind in the current tick. For tests and the dev inspector only. */
  countOf(kind: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.kind[i] === kind) n++;
    return n;
  }

  /** Index of the first cue of a kind in this tick, or -1. For tests and the dev inspector only. */
  indexOf(kind: number): number {
    for (let i = 0; i < this.count; i++) if (this.kind[i] === kind) return i;
    return -1;
  }
}
