/**
 * Save encode/decode. Fixed layout, checksummed, never throws.
 *
 * `decodeSave` returns a reason code instead of throwing, because every caller is a startup path and the
 * correct response to a bad slot is "try the other slot", not "crash on launch". A save loader that can
 * throw is a save loader that turns one corrupt byte into an uninstall.
 *
 * LAYOUT (little-endian)
 *   0   u32  magic "NRSV"
 *   4   u16  version
 *   6   u16  contentVersion
 *   8   u32  buildId
 *   12  u32  generation
 *   16  u32  savedAtUnixSec
 *   20  u32  gold
 *   24  u32  goldLifetime
 *   28  u32  runsStarted
 *   32  u32  runsCompleted
 *   36  u32  secondsPlayed
 *   40  u32  bestSurvivalSeconds
 *   44  u32  everTainted
 *   48  u32  bodyBytes        — length of everything after the header
 *   52  u32  checksum         — FNV-1a over the body, then over the header with this field zeroed
 *   56  u32  reserved
 *   60  u32  reserved
 *   64  ...  body: bitsets, byte arrays, ascension u16s, then settings
 */

import { HASH_SEED, hashByte, hashWord } from "../net/state-hash";
import {
  SAVE_HEADER_BYTES,
  SAVE_LIMITS,
  SAVE_MAGIC,
  SAVE_VERSION,
  createSaveData,
  defaultSettings,
  type SaveData,
  type SaveSettings,
} from "./schema";

export const SAVE_ERROR = {
  NONE: 0,
  EMPTY: 1,
  TOO_SHORT: 2,
  BAD_MAGIC: 3,
  /** Newer than this build understands. Refuse rather than guess — a downgrade must not eat progress. */
  FUTURE_VERSION: 4,
  /** Older, and no migration exists for it. */
  UNSUPPORTED_VERSION: 5,
  BAD_LENGTH: 6,
  BAD_CHECKSUM: 7,
} as const;

export type SaveError = (typeof SAVE_ERROR)[keyof typeof SAVE_ERROR];

export function describeSaveError(error: SaveError): string {
  switch (error) {
    case SAVE_ERROR.NONE:
      return "ok";
    case SAVE_ERROR.EMPTY:
      return "empty slot";
    case SAVE_ERROR.TOO_SHORT:
      return "shorter than a header";
    case SAVE_ERROR.BAD_MAGIC:
      return "not a save file";
    case SAVE_ERROR.FUTURE_VERSION:
      return "written by a newer build";
    case SAVE_ERROR.UNSUPPORTED_VERSION:
      return "version has no migration";
    case SAVE_ERROR.BAD_LENGTH:
      return "truncated or padded";
    case SAVE_ERROR.BAD_CHECKSUM:
      return "checksum mismatch — torn write or corruption";
    default:
      return "unreadable";
  }
}

/** Settings occupy a fixed 20 bytes: 15 declared fields, the rest reserved for the next few options. */
const SETTINGS_BYTES = 20;

export function bodyBytes(): number {
  const L = SAVE_LIMITS;
  return (
    L.characterBytes +
    L.weaponBytes +
    L.stageBytes +
    L.arcanaBytes +
    L.achievementBytes +
    L.powerUpCount +
    L.masteryCount +
    L.ascensionCount * 2 +
    SETTINGS_BYTES
  );
}

export function saveBytes(): number {
  return SAVE_HEADER_BYTES + bodyBytes();
}

function checksumOf(bytes: Uint8Array): number {
  let h = HASH_SEED;
  // Header first, with the checksum field itself treated as zero so the value is stable.
  for (let i = 0; i < SAVE_HEADER_BYTES; i++) {
    const b = i >= 52 && i < 56 ? 0 : (bytes[i] as number);
    h = hashByte(h, b);
  }
  for (let i = SAVE_HEADER_BYTES; i < bytes.length; i++) h = hashByte(h, bytes[i] as number);
  return h >>> 0;
}

function packSettings(view: DataView, at: number, s: SaveSettings): void {
  view.setUint8(at, s.masterVolume & 0xff);
  view.setUint8(at + 1, s.musicVolume & 0xff);
  view.setUint8(at + 2, s.sfxVolume & 0xff);
  view.setUint8(at + 3, s.colorblindMode & 0xff);
  view.setUint8(at + 4, s.vfxLevel & 0xff);
  view.setUint8(at + 5, s.joystickSize & 0xff);
  view.setUint8(at + 6, s.joystickX & 0xff);
  view.setUint8(at + 7, s.joystickY & 0xff);
  view.setUint16(at + 8, s.hudScale & 0xffff, true);
  let flags = 0;
  if (s.damageNumbers) flags |= 1 << 0;
  if (s.screenFlash) flags |= 1 << 1;
  if (s.screenShake) flags |= 1 << 2;
  if (s.telemetryOptIn) flags |= 1 << 3;
  if (s.crashReportOptIn) flags |= 1 << 4;
  if (s.personalisedAdsOptIn) flags |= 1 << 5;
  if (s.customNameOptIn) flags |= 1 << 6;
  view.setUint16(at + 10, flags, true);
  // 12..19 reserved, left zero.
}

function unpackSettings(view: DataView, at: number): SaveSettings {
  const s = defaultSettings();
  s.masterVolume = view.getUint8(at);
  s.musicVolume = view.getUint8(at + 1);
  s.sfxVolume = view.getUint8(at + 2);
  s.colorblindMode = view.getUint8(at + 3);
  s.vfxLevel = view.getUint8(at + 4);
  s.joystickSize = view.getUint8(at + 5);
  s.joystickX = view.getUint8(at + 6);
  s.joystickY = view.getUint8(at + 7);
  s.hudScale = view.getUint16(at + 8, true);
  const flags = view.getUint16(at + 10, true);
  s.damageNumbers = (flags & (1 << 0)) !== 0;
  s.screenFlash = (flags & (1 << 1)) !== 0;
  s.screenShake = (flags & (1 << 2)) !== 0;
  s.telemetryOptIn = (flags & (1 << 3)) !== 0;
  s.crashReportOptIn = (flags & (1 << 4)) !== 0;
  s.personalisedAdsOptIn = (flags & (1 << 5)) !== 0;
  s.customNameOptIn = (flags & (1 << 6)) !== 0;
  return s;
}

export function encodeSave(save: SaveData, out?: Uint8Array): Uint8Array {
  const total = saveBytes();
  const bytes = out && out.length === total ? out : new Uint8Array(total);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint32(0, SAVE_MAGIC, true);
  view.setUint16(4, SAVE_VERSION, true);
  view.setUint16(6, save.contentVersion & 0xffff, true);
  view.setUint32(8, save.buildId >>> 0, true);
  view.setUint32(12, save.generation >>> 0, true);
  view.setUint32(16, save.savedAtUnixSec >>> 0, true);
  view.setUint32(20, save.gold >>> 0, true);
  view.setUint32(24, save.goldLifetime >>> 0, true);
  view.setUint32(28, save.runsStarted >>> 0, true);
  view.setUint32(32, save.runsCompleted >>> 0, true);
  view.setUint32(36, save.secondsPlayed >>> 0, true);
  view.setUint32(40, save.bestSurvivalSeconds >>> 0, true);
  view.setUint32(44, save.everTainted >>> 0, true);
  view.setUint32(48, bodyBytes(), true);
  view.setUint32(52, 0, true);
  view.setUint32(56, 0, true);
  view.setUint32(60, 0, true);

  let at = SAVE_HEADER_BYTES;
  const blocks: Uint8Array[] = [
    save.unlockedCharacters,
    save.unlockedWeapons,
    save.unlockedStages,
    save.unlockedArcanas,
    save.achievements,
    save.powerUpLevels,
    save.masteryLevels,
  ];
  for (const block of blocks) {
    bytes.set(block, at);
    at += block.length;
  }
  for (let i = 0; i < SAVE_LIMITS.ascensionCount; i++) {
    view.setUint16(at, (save.ascensionTiers[i] as number) & 0xffff, true);
    at += 2;
  }
  packSettings(view, at, save.settings);

  view.setUint32(52, checksumOf(bytes), true);
  return bytes;
}

export interface DecodedSave {
  readonly error: SaveError;
  readonly save: SaveData;
  /** Generation read straight from the header, valid even when the body failed. Used to pick a slot. */
  readonly generation: number;
}

export function decodeSave(bytes: Uint8Array | undefined): DecodedSave {
  const blank = createSaveData();
  if (!bytes || bytes.length === 0) {
    return { error: SAVE_ERROR.EMPTY, save: blank, generation: 0 };
  }
  if (bytes.length < SAVE_HEADER_BYTES) {
    return { error: SAVE_ERROR.TOO_SHORT, save: blank, generation: 0 };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SAVE_MAGIC) {
    return { error: SAVE_ERROR.BAD_MAGIC, save: blank, generation: 0 };
  }

  const version = view.getUint16(4, true);
  const generation = view.getUint32(12, true);
  if (version > SAVE_VERSION) {
    return { error: SAVE_ERROR.FUTURE_VERSION, save: blank, generation };
  }
  if (version < SAVE_VERSION) {
    // Version 1 is the first, so nothing can legitimately be older. Migrations land here when v2 exists,
    // and the shape of that is already decided: migrate forward into a fresh `createSaveData`, never
    // in place, so a failed migration leaves the older slot untouched.
    return { error: SAVE_ERROR.UNSUPPORTED_VERSION, save: blank, generation };
  }
  if (bytes.length !== saveBytes() || view.getUint32(48, true) !== bodyBytes()) {
    return { error: SAVE_ERROR.BAD_LENGTH, save: blank, generation };
  }
  if (view.getUint32(52, true) !== checksumOf(bytes)) {
    return { error: SAVE_ERROR.BAD_CHECKSUM, save: blank, generation };
  }

  const save = createSaveData();
  save.version = version;
  save.contentVersion = view.getUint16(6, true);
  save.buildId = view.getUint32(8, true);
  save.generation = generation;
  save.savedAtUnixSec = view.getUint32(16, true);
  save.gold = view.getUint32(20, true);
  save.goldLifetime = view.getUint32(24, true);
  save.runsStarted = view.getUint32(28, true);
  save.runsCompleted = view.getUint32(32, true);
  save.secondsPlayed = view.getUint32(36, true);
  save.bestSurvivalSeconds = view.getUint32(40, true);
  save.everTainted = view.getUint32(44, true);

  let at = SAVE_HEADER_BYTES;
  const targets: Uint8Array[] = [
    save.unlockedCharacters,
    save.unlockedWeapons,
    save.unlockedStages,
    save.unlockedArcanas,
    save.achievements,
    save.powerUpLevels,
    save.masteryLevels,
  ];
  for (const target of targets) {
    target.set(bytes.subarray(at, at + target.length));
    at += target.length;
  }
  for (let i = 0; i < SAVE_LIMITS.ascensionCount; i++) {
    save.ascensionTiers[i] = view.getUint16(at, true);
    at += 2;
  }
  save.settings = unpackSettings(view, at);

  return { error: SAVE_ERROR.NONE, save, generation };
}

/** Exposed for the dev menu's save inspector and for tests. */
export function saveChecksum(bytes: Uint8Array): number {
  return checksumOf(bytes);
}

/** Cheap identity for anomaly detection: generation plus checksum, as one word. */
export function saveFingerprint(save: SaveData): number {
  return hashWord(hashWord(HASH_SEED, save.generation), save.gold) >>> 0;
}
