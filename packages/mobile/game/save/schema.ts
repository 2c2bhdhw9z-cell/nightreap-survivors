/**
 * Save schema, version 1.
 *
 * WHY A BINARY SAVE AND NOT JSON
 * The save is written after every run, on a phone, possibly while the OS is deciding to kill us — the
 * 844s jetsam in `task.md` is a live reminder that a write can be interrupted at any instant. A fixed
 * binary layout with a checksum can be validated in full before it is trusted, and it does not allocate
 * a multi-megabyte string to do it. JSON would also silently accept a half-written file that happens to
 * parse.
 *
 * DOUBLE-BUFFERED SLOTS, NOT ATOMIC RENAME
 * There is no portable atomic rename across the storage backends we care about (RN FileSystem,
 * AsyncStorage, localStorage on web). So the save is double buffered: two slots, each carrying a
 * generation counter and a checksum, written alternately. Load takes the highest generation that
 * validates. A torn write can therefore only ever destroy the *older* copy of the data, and the worst
 * case is losing one run's progress rather than the whole profile. That is the single most important
 * property in this file, and `save.test.ts` proves it by tearing writes deliberately.
 *
 * ON MODDED SAVES
 * Editing this file on your own device is explicitly allowed (plan.md §5b): a modded save costs nobody
 * anything, and there is no honest way to stop it on a device the player owns. The checksum here exists
 * to catch *corruption*, not cheating — it is a hash, not a signature, and pretending otherwise would
 * just mean writing code that looks like security and is not. Ladder integrity is server-side replay
 * revalidation, and nothing else.
 */

import { TAINT } from "../replay/format";

export const SAVE_VERSION = 3;

/**
 * Versions this build can still read. A v1 save has a shorter settings block and none of the switches
 * decided after it was written, so it is migrated forward: every v1 field is kept, every new field takes
 * its default. Migration is forward-only and never in place — see `decodeSave`.
 */
export const SAVE_OLDEST_READABLE = 1;

/** "NRSV". Rejects a foreign or truncated blob before anything reads a field out of it. */
export const SAVE_MAGIC = 0x5653_524e;

/** Two slots, alternating. Three would not buy anything a generation counter does not already give us. */
export const SAVE_SLOTS = 2;

/**
 * Sizes are fixed so the layout can be validated by length alone. They are generous against the locked
 * launch scope (~15 weapons, ~12 characters, 5 stages, ~50 achievements) and against full scope (40+
 * weapons, 40+ characters, 20+ stages, 150+ achievements, 22 arcanas) so a content addition does not
 * force a schema migration.
 */
export const SAVE_LIMITS = {
  /** Bitset bytes for unlocked characters — 512 characters. */
  characterBytes: 64,
  /** Bitset bytes for unlocked weapons — 512. */
  weaponBytes: 64,
  /** Bitset bytes for unlocked stages — 256. */
  stageBytes: 32,
  /**
   * Best survival time per stage, one u16 of seconds each — 32 stages.
   *
   * Separate from `bestSurvivalSeconds`, which is the one best time anywhere. This is what opens the
   * next stage and what the stage-select screen prints under each place, and neither question can be
   * answered by a single number: surviving twenty minutes on the crypt says nothing about the marsh.
   */
  stageBestCount: 32,
  /** Bitset bytes for unlocked arcanas — 256. */
  arcanaBytes: 32,
  /** Bitset bytes for achievements — 2048. */
  achievementBytes: 256,
  /** PowerUp shop levels, one byte each. */
  powerUpCount: 32,
  /** Per-character mastery levels, one byte each. */
  masteryCount: 512,
  /** Ascension tier per ladder, one u16 each. */
  ascensionCount: 8,
} as const;

/** Bytes of the fixed header, little-endian. Layout is spelled out in `codec.ts`. */
export const SAVE_HEADER_BYTES = 64;

export interface SaveData {
  version: number;
  /** Monotonic. Decides which slot wins on load; wraps at u32, which is ~4 billion runs away. */
  generation: number;
  /** Build that wrote this save. Used by anomaly detection and by migrations. */
  buildId: number;
  contentVersion: number;
  /** Unix seconds of the last write. Advisory only — the device clock is not trustworthy. */
  savedAtUnixSec: number;

  /** Account currency. Co-op gold counts fully toward this, per the plan. */
  gold: number;
  /** Lifetime gold earned, for achievements that ask about totals rather than balance. */
  goldLifetime: number;

  unlockedCharacters: Uint8Array;
  unlockedWeapons: Uint8Array;
  unlockedStages: Uint8Array;
  /**
   * Longest run survived on each stage, in seconds, indexed by stage. Zero means never survived there.
   * Capped at a u16 — eighteen hours — because an endless run left on a charger must not wrap to zero.
   */
  stageBestSeconds: Uint16Array;
  unlockedArcanas: Uint8Array;
  achievements: Uint8Array;
  powerUpLevels: Uint8Array;
  masteryLevels: Uint8Array;
  ascensionTiers: Uint16Array;

  /** Runs started, runs survived, total seconds played, best survival time in seconds. */
  runsStarted: number;
  runsCompleted: number;
  secondsPlayed: number;
  bestSurvivalSeconds: number;

  /**
   * Taint bits this *profile* has ever seen. Purely informational, never gates anything: taint is on the
   * run, not the save (plan.md §5b). It exists so a bug report can say "this player has used the dev
   * menu at some point", which changes how a crash report is read.
   */
  everTainted: number;

  /** Settings that must survive a reinstall alongside progress. Layout in `codec.ts`. */
  settings: SaveSettings;
}

/** Which keyboard the lobby chat field raises. `plan.md`: two keyboards, player's choice, PHONE default. */
export const CHAT_KEYBOARD = {
  /** The operating system keyboard. Brings autocorrect, swipe, emoji, dictation and every language. */
  PHONE: 0,
  /** Our own atlas-drawn grid. Looks like the game, English and latin only. */
  IN_GAME: 1,
} as const;

export type ChatKeyboard = (typeof CHAT_KEYBOARD)[keyof typeof CHAT_KEYBOARD];

/** Where the party badges sit when docked to the slot strip. */
export const HUD_ALIGN = {
  LEFT: 0,
  CENTRE: 1,
  RIGHT: 2,
} as const;

export type HudAlign = (typeof HUD_ALIGN)[keyof typeof HUD_ALIGN];

/**
 * The render frame-rate the player chose. The SIMULATION is always a fixed 60Hz tick regardless — this
 * only decides how often the screen is drawn, and 120/DYNAMIC are free because rendering interpolates
 * between ticks (see `core/loop.ts`).
 *
 * DYNAMIC is the default: it follows the display's own cadence, so a 120Hz phone gets 120 out of the box
 * (iOS needs `CADisableMinimumFrameDuration` in `app.json`, which is set) and a 60Hz phone gets 60,
 * with no setting to find. The numeric codes are chosen so DYNAMIC is 2 rather than 0 — see the codec,
 * where a stored zero in the reserved byte of an old save is deliberately read as DYNAMIC, not "60Hz".
 */
export const FRAME_RATE_MODE = {
  /** Cap the render loop to 60 frames a second. */
  HZ_60: 0,
  /** Cap the render loop to 120 frames a second. */
  HZ_120: 1,
  /** Uncapped: draw every frame the display offers, and detect its rate (60, 120, or higher). */
  DYNAMIC: 2,
} as const;

export type FrameRateMode = (typeof FRAME_RATE_MODE)[keyof typeof FRAME_RATE_MODE];

export interface SaveSettings {
  masterVolume: number; // 0..100
  musicVolume: number; // 0..100
  sfxVolume: number; // 0..100
  /** 0 none, 1 deuteranopia, 2 protanopia, 3 tritanopia. */
  colorblindMode: number;
  /** 0 full, 1 reduced, 2 minimal. */
  vfxLevel: number;
  /**
   * Comfort sliders, 0..100, where 0 is off. These were booleans in v1. Sliders because the people who
   * need them do not all need the same amount: a player who cannot take full screen shake can often take
   * a third of it, and forcing that person to choose between all and nothing is the accessibility failure
   * we said we would not ship.
   */
  damageNumbers: number;
  screenFlash: number;
  screenShake: number;
  /** Joystick radius in points, and its anchor as a percentage of the safe area. */
  joystickSize: number;
  joystickX: number;
  joystickY: number;
  /** HUD text scale, 100 = default. */
  hudScale: number;
  /** Opt-ins. All default false — nothing is collected until the player says yes. */
  telemetryOptIn: boolean;
  crashReportOptIn: boolean;
  personalisedAdsOptIn: boolean;
  /** Player chose a custom display name instead of a generated one. */
  customNameOptIn: boolean;

  /* ---- decided after v1 ------------------------------------------------------------------------- */

  /** `CHAT_KEYBOARD`. The stored *choice*; what actually opens is `effectiveChatKeyboard`. */
  chatKeyboard: number;
  /** Caps the frame rate and trims effects to save battery. Off by default. */
  batterySaver: boolean;
  /**
   * `FRAME_RATE_MODE`. The render frame-rate cap. DYNAMIC by default so a 120Hz phone is smooth without
   * the player finding a setting. Lives in the reserved tail of the settings block, so no SAVE_VERSION
   * bump — an old save with a zero in that byte is read back as DYNAMIC, the intended default.
   */
  frameRateMode: number;
  /**
   * Chat comfort switch. On by default. Turning it off does NOT lower the age rating — the rating is set
   * by what the app can do, not by what one player switched off — it exists so a player who does not want
   * to read strangers can play anyway.
   */
  chatEnabled: boolean;
  /** Narrower version of the same: friends can still talk, nobody else can. */
  chatFromNonFriends: boolean;
  /** Daily reminder notification. Asked once, on day two, and never again. */
  dailyReminderOptIn: boolean;
  /** Whether that one ask has happened, so it cannot happen twice. */
  dailyReminderAsked: boolean;
  /** Replaces every insect-shaped enemy with a non-insect sprite. OFF by default: an option, not the look. */
  insectFreeSprites: boolean;
  /**
   * Aims weapons at the nearest target. Off by default and legal on every leaderboard — an accessibility
   * option that costs you your scores is not an accessibility option.
   */
  autoAim: boolean;
  /** Read-only speedrun overlay: input display, precise timer, seed. Reads do not taint a run. */
  speedrunToolkit: boolean;

  /**
   * The guided run. Two separate facts, deliberately: whether the one-time offer has already been made
   * (so it can never be made twice), and whether prompts are currently armed. Answering "I've got it" is
   * not permanent — Settings can arm the guide again any time — so a single boolean would not do.
   * These live in the reserved tail of the settings block, so no save version bump: an existing v2 slot
   * reads both as false, which is exactly "never offered, not armed".
   */
  guideOffered: boolean;
  guideArmed: boolean;

  /** Party badges fused to the slot strip (true) or a free-floating cluster the player drags (false). */
  hudBadgesDocked: boolean;
  /** `HUD_ALIGN`, used only while docked. */
  hudBadgeAlign: number;
  /** Undocked badge cluster anchor, percentage of the safe area. */
  hudBadgeX: number;
  hudBadgeY: number;
  /** Independent scales, 100 = default: the two top strips, the badges, and the stick. */
  hudTopStripScale: number;
  hudSlotStripScale: number;
  hudBadgeScale: number;
  hudStickScale: number;
}

export function defaultSettings(): SaveSettings {
  return {
    masterVolume: 80,
    musicVolume: 70,
    sfxVolume: 80,
    colorblindMode: 0,
    vfxLevel: 0,
    damageNumbers: 100,
    screenFlash: 100,
    screenShake: 100,
    joystickSize: 64,
    joystickX: 18,
    joystickY: 78,
    hudScale: 100,
    telemetryOptIn: false,
    crashReportOptIn: false,
    personalisedAdsOptIn: false,
    customNameOptIn: false,
    chatKeyboard: CHAT_KEYBOARD.PHONE,
    batterySaver: false,
    frameRateMode: FRAME_RATE_MODE.DYNAMIC,
    chatEnabled: true,
    chatFromNonFriends: true,
    dailyReminderOptIn: false,
    dailyReminderAsked: false,
    insectFreeSprites: false,
    autoAim: false,
    speedrunToolkit: false,
    guideOffered: false,
    guideArmed: false,
    hudBadgesDocked: true,
    hudBadgeAlign: HUD_ALIGN.LEFT,
    hudBadgeX: 6,
    hudBadgeY: 22,
    hudTopStripScale: 100,
    hudSlotStripScale: 100,
    hudBadgeScale: 100,
    hudStickScale: 100,
  };
}

/** A brand new profile. Allocates once, at startup — never during a run. */
export function createSaveData(buildId = 0, contentVersion = 1): SaveData {
  return {
    version: SAVE_VERSION,
    generation: 0,
    buildId,
    contentVersion,
    savedAtUnixSec: 0,
    gold: 0,
    goldLifetime: 0,
    unlockedCharacters: new Uint8Array(SAVE_LIMITS.characterBytes),
    unlockedWeapons: new Uint8Array(SAVE_LIMITS.weaponBytes),
    unlockedStages: new Uint8Array(SAVE_LIMITS.stageBytes),
    stageBestSeconds: new Uint16Array(SAVE_LIMITS.stageBestCount),
    unlockedArcanas: new Uint8Array(SAVE_LIMITS.arcanaBytes),
    achievements: new Uint8Array(SAVE_LIMITS.achievementBytes),
    powerUpLevels: new Uint8Array(SAVE_LIMITS.powerUpCount),
    masteryLevels: new Uint8Array(SAVE_LIMITS.masteryCount),
    ascensionTiers: new Uint16Array(SAVE_LIMITS.ascensionCount),
    runsStarted: 0,
    runsCompleted: 0,
    secondsPlayed: 0,
    bestSurvivalSeconds: 0,
    everTainted: 0,
    settings: defaultSettings(),
  };
}

/* ---- bitset helpers ----------------------------------------------------------------------------- */

export function bitGet(set: Uint8Array, index: number): boolean {
  if (index < 0) return false;
  const byte = index >> 3;
  if (byte >= set.length) return false;
  return ((set[byte] as number) & (1 << (index & 7))) !== 0;
}

export function bitSet(set: Uint8Array, index: number, on = true): void {
  if (index < 0) return;
  const byte = index >> 3;
  if (byte >= set.length) return;
  const mask = 1 << (index & 7);
  set[byte] = on ? (set[byte] as number) | mask : (set[byte] as number) & ~mask;
}

export function bitCount(set: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < set.length; i++) {
    let b = set[i] as number;
    while (b !== 0) {
      b &= b - 1;
      n++;
    }
  }
  return n;
}

/** Record that this profile has seen a dev toggle. Informational; see `everTainted`. */
export function noteTaint(save: SaveData, bits: number): void {
  save.everTainted |= bits & ~TAINT.CHAOS_EVENT;
}
