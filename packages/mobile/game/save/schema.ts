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

export const SAVE_VERSION = 1;

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

export interface SaveSettings {
  masterVolume: number; // 0..100
  musicVolume: number; // 0..100
  sfxVolume: number; // 0..100
  /** 0 none, 1 deuteranopia, 2 protanopia, 3 tritanopia. */
  colorblindMode: number;
  /** 0 full, 1 reduced, 2 minimal. */
  vfxLevel: number;
  damageNumbers: boolean;
  screenFlash: boolean;
  screenShake: boolean;
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
}

export function defaultSettings(): SaveSettings {
  return {
    masterVolume: 80,
    musicVolume: 70,
    sfxVolume: 85,
    colorblindMode: 0,
    vfxLevel: 0,
    damageNumbers: true,
    screenFlash: true,
    screenShake: true,
    joystickSize: 64,
    joystickX: 18,
    joystickY: 78,
    hudScale: 100,
    telemetryOptIn: false,
    crashReportOptIn: false,
    personalisedAdsOptIn: false,
    customNameOptIn: false,
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
