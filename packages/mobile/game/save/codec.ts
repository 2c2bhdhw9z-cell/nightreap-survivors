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
 *
 * VERSIONS
 * v1 is readable and migrated forward; its settings block is 20 bytes rather than 48. Everything before
 * the settings block is identical in both, which is why the migration is a settings-only special case.
 */

import { HASH_SEED, hashByte, hashWord } from "../net/state-hash";
import {
  SAVE_HEADER_BYTES,
  SAVE_LIMITS,
  SAVE_MAGIC,
  SAVE_OLDEST_READABLE,
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

/**
 * Settings occupy a fixed 48 bytes: 32 declared fields, the rest reserved. v1's block was 20 bytes with
 * 15 fields, which ran out the moment the co-op switches and the HUD layout options were decided — hence
 * a version bump rather than squeezing.
 */
const SETTINGS_BYTES = 48;
const SETTINGS_BYTES_V1 = 20;

/** Body length for a given save version. Everything before settings is unchanged between v1 and v2. */
function bodyBytesFor(version: number): number {
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
    (version === 1 ? SETTINGS_BYTES_V1 : SETTINGS_BYTES)
  );
}

export function bodyBytes(): number {
  return bodyBytesFor(SAVE_VERSION);
}

export function saveBytes(): number {
  return SAVE_HEADER_BYTES + bodyBytes();
}

/** Total length a save of `version` must be. Used to validate an older slot before migrating it. */
export function saveBytesFor(version: number): number {
  return SAVE_HEADER_BYTES + bodyBytesFor(version);
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
  // Bits 0..2 were the three comfort booleans in v1 and are now the sliders below. They stay written so a
  // v1-era reader — a downgraded build, a bug report tool — still sees "shake on" rather than "shake off".
  if (s.damageNumbers > 0) flags |= 1 << 0;
  if (s.screenFlash > 0) flags |= 1 << 1;
  if (s.screenShake > 0) flags |= 1 << 2;
  if (s.telemetryOptIn) flags |= 1 << 3;
  if (s.crashReportOptIn) flags |= 1 << 4;
  if (s.personalisedAdsOptIn) flags |= 1 << 5;
  if (s.customNameOptIn) flags |= 1 << 6;
  if (s.batterySaver) flags |= 1 << 7;
  if (s.chatEnabled) flags |= 1 << 8;
  if (s.chatFromNonFriends) flags |= 1 << 9;
  if (s.dailyReminderOptIn) flags |= 1 << 10;
  if (s.dailyReminderAsked) flags |= 1 << 11;
  if (s.insectFreeSprites) flags |= 1 << 12;
  if (s.autoAim) flags |= 1 << 13;
  if (s.speedrunToolkit) flags |= 1 << 14;
  if (s.hudBadgesDocked) flags |= 1 << 15;
  view.setUint16(at + 10, flags & 0xffff, true);
  // v2 additions. Bytes 12..19 were reserved in v1 and are still reserved, so a v1 blob widened to v2
  // length would read as defaults here rather than as garbage.
  view.setUint8(at + 20, s.chatKeyboard & 0xff);
  view.setUint8(at + 21, s.hudBadgeAlign & 0xff);
  view.setUint8(at + 22, s.hudBadgeX & 0xff);
  view.setUint8(at + 23, s.hudBadgeY & 0xff);
  view.setUint8(at + 24, s.damageNumbers & 0xff);
  view.setUint8(at + 25, s.screenFlash & 0xff);
  view.setUint8(at + 26, s.screenShake & 0xff);
  view.setUint16(at + 28, s.hudTopStripScale & 0xffff, true);
  view.setUint16(at + 30, s.hudSlotStripScale & 0xffff, true);
  view.setUint16(at + 32, s.hudBadgeScale & 0xffff, true);
  view.setUint16(at + 34, s.hudStickScale & 0xffff, true);
  // 36..47 reserved, left zero.
}

function unpackSettings(view: DataView, at: number, version: number): SaveSettings {
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
  s.telemetryOptIn = (flags & (1 << 3)) !== 0;
  s.crashReportOptIn = (flags & (1 << 4)) !== 0;
  s.personalisedAdsOptIn = (flags & (1 << 5)) !== 0;
  s.customNameOptIn = (flags & (1 << 6)) !== 0;

  if (version === 1) {
    // The three comfort options were on/off. On becomes full strength, off becomes zero, which is exactly
    // what the player had. A v1 slot has no bytes past 19, so everything else keeps its default.
    s.damageNumbers = (flags & (1 << 0)) !== 0 ? 100 : 0;
    s.screenFlash = (flags & (1 << 1)) !== 0 ? 100 : 0;
    s.screenShake = (flags & (1 << 2)) !== 0 ? 100 : 0;
    return s;
  }

  s.batterySaver = (flags & (1 << 7)) !== 0;
  s.chatEnabled = (flags & (1 << 8)) !== 0;
  s.chatFromNonFriends = (flags & (1 << 9)) !== 0;
  s.dailyReminderOptIn = (flags & (1 << 10)) !== 0;
  s.dailyReminderAsked = (flags & (1 << 11)) !== 0;
  s.insectFreeSprites = (flags & (1 << 12)) !== 0;
  s.autoAim = (flags & (1 << 13)) !== 0;
  s.speedrunToolkit = (flags & (1 << 14)) !== 0;
  s.hudBadgesDocked = (flags & (1 << 15)) !== 0;
  s.chatKeyboard = view.getUint8(at + 20);
  s.hudBadgeAlign = view.getUint8(at + 21);
  s.hudBadgeX = view.getUint8(at + 22);
  s.hudBadgeY = view.getUint8(at + 23);
  s.damageNumbers = view.getUint8(at + 24);
  s.screenFlash = view.getUint8(at + 25);
  s.screenShake = view.getUint8(at + 26);
  s.hudTopStripScale = view.getUint16(at + 28, true);
  s.hudSlotStripScale = view.getUint16(at + 30, true);
  s.hudBadgeScale = view.getUint16(at + 32, true);
  s.hudStickScale = view.getUint16(at + 34, true);
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
  if (version < SAVE_OLDEST_READABLE) {
    // Older than anything this build has a migration for. Refusing is right: guessing at a layout we no
    // longer have would turn a readable-but-old profile into a silently wrong one.
    return { error: SAVE_ERROR.UNSUPPORTED_VERSION, save: blank, generation };
  }
  // Older but readable: validated at *its* length, then migrated forward field by field into a fresh
  // profile. Never in place, so a migration that goes wrong leaves the old slot exactly as it was.
  if (bytes.length !== saveBytesFor(version) || view.getUint32(48, true) !== bodyBytesFor(version)) {
    return { error: SAVE_ERROR.BAD_LENGTH, save: blank, generation };
  }
  if (view.getUint32(52, true) !== checksumOf(bytes)) {
    return { error: SAVE_ERROR.BAD_CHECKSUM, save: blank, generation };
  }

  const save = createSaveData();
  // The migrated result is a v2 profile regardless of what it was read from — the next write must not
  // claim to be v1 with v2 bytes in it.
  save.version = SAVE_VERSION;
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
  save.settings = unpackSettings(view, at, version);

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
