/**
 * Resolved settings — the difference between what the player chose and what actually happens.
 *
 * WHY THIS EXISTS AS ITS OWN LAYER
 * Stored settings are a record of choices. They are not directly usable, because several of them are
 * conditional: the in-game keyboard cannot type Japanese, battery saver overrules effect levels, docked
 * badges ignore the free-drag position, and solo has no badges at all. If every screen worked that out
 * for itself, every screen would work it out slightly differently, and the bug would look like "the
 * keyboard setting doesn't stick" rather than "two screens disagree".
 *
 * So: `resolve()` takes the stored settings plus the facts of the moment — screen size, locale, player
 * count — and returns exactly what to draw and which keyboard to raise. Screens read the result and make
 * no decisions of their own.
 *
 * THE HARD CONSTRAINT THIS SATISFIES
 * `plan.md`: the in-run screen must read every position and scale from settings from the first line of
 * HUD code, and the chat panel must read the keyboard choice from settings from the first line it is
 * written. Retrofitting a layout editor onto hardcoded coordinates is a rewrite, so the geometry is
 * resolved here before a single pixel is placed.
 *
 * NO REACT, NO STORAGE, NO CLOCK
 * Pure functions over plain data. Nothing here reads a device, a file or the time, so it is testable by
 * calling it, which is the only reason it can be tested at all.
 *
 * GEOMETRY UNITS
 * In and out in points, not pixels. Device pixel ratio belongs to the renderer.
 */

import { CHAT_KEYBOARD, FRAME_RATE_MODE, HUD_ALIGN, defaultSettings, type SaveSettings } from "../save/schema";
import { DYNAMIC_TARGET_FPS } from "../core/frame-gate";

/** Scale clamps. A layout editor that lets the player make the pause button 4 points wide is a trap. */
export const SCALE_MIN = 60;
export const SCALE_MAX = 180;

/** Joystick radius clamps in points, and the slider range for the comfort options. */
export const STICK_MIN = 40;
export const STICK_MAX = 140;
export const INTENSITY_MAX = 100;

/**
 * Base HUD geometry at scale 100, in points. These are the numbers from the settled in-run layout: a thin
 * XP bar, one narrow slate strip, one thin strip of twelve slots.
 */
export const HUD_BASE = {
  xpBarHeight: 5,
  statusStripHeight: 26,
  slotStripHeight: 30,
  slotSize: 22,
  slotGap: 2,
  /** Cobble divider between the six weapon slots and the six passive slots. */
  dividerWidth: 4,
  badgeWidth: 46,
  badgeHeight: 30,
  badgeGap: 3,
  /** Side padding for everything in the top block. */
  edgePad: 6,
} as const;

/** The twelve slots: six weapons, then six passives. Not a setting — it is the game's shape. */
export const WEAPON_SLOTS = 6;
export const PASSIVE_SLOTS = 6;

/** Frame rate cap when battery saver is on. Half rate, which the sim's fixed 60Hz tick is unaffected by. */
export const BATTERY_SAVER_FPS = 30;
export const NORMAL_FPS = 60;
/** The 120Hz cap, for the phones that can do it. */
export const HIGH_FPS = 120;

/**
 * Turn the stored frame-rate mode into a render cap in Hz. DYNAMIC resolves to the uncapped sentinel
 * (`DYNAMIC_TARGET_FPS`, zero), which the render loop reads as "draw every frame the display offers".
 * The simulation is 60Hz no matter what this returns.
 */
export function fpsForMode(mode: number): number {
  switch (mode) {
    case FRAME_RATE_MODE.HZ_60:
      return NORMAL_FPS;
    case FRAME_RATE_MODE.HZ_120:
      return HIGH_FPS;
    case FRAME_RATE_MODE.DYNAMIC:
      return DYNAMIC_TARGET_FPS;
    default:
      // An unknown mode from a newer build falls back to DYNAMIC rather than to a fixed cap: following
      // the display is the safe answer on any panel, where guessing 60 could halve a 120Hz phone.
      return DYNAMIC_TARGET_FPS;
  }
}

export interface DeviceFacts {
  /** Safe-area width and height in points — already inset for notches and home bars. */
  safeWidth: number;
  safeHeight: number;
  /**
   * BCP-47 language tag from the operating system, e.g. "en-GB", "ja-JP". Used for one decision only:
   * whether the in-game keyboard is capable of typing this player's language.
   */
  locale: string;
  /** 1 for solo. Badges are hidden at 1, per the settled layout. */
  playerCount: number;
}

export interface HudRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedHud {
  xpBar: HudRect;
  statusStrip: HudRect;
  slotStrip: HudRect;
  /** Size of one weapon or passive slot, square. */
  slotSize: number;
  slotGap: number;
  dividerWidth: number;
  /** Whether party badges are drawn at all. False in solo. */
  badgesVisible: boolean;
  badgesDocked: boolean;
  /** Where the badge cluster starts, and the size of one badge. */
  badges: HudRect;
  /** Gap between two badges. Exposed so the HUD lays the row out from resolved numbers only. */
  badgeGap: number;
  /** Joystick radius in points. The stick has no fixed position — it appears under the thumb. */
  stickRadius: number;
  /** The lower region where a touch summons the stick. Everything above it is the fight. */
  stickZone: HudRect;
}

export interface ResolvedSettings {
  /** Which keyboard will actually open, after the language check. */
  chatKeyboard: number;
  /** True when the player asked for the in-game keyboard and their language rules it out. */
  chatKeyboardForced: boolean;
  /** Whether a chat field is offered at all, and whether strangers may be heard. */
  chatEnabled: boolean;
  chatFromNonFriends: boolean;
  /** Effect strengths after battery saver, 0..100. */
  damageNumbers: number;
  screenFlash: number;
  screenShake: number;
  /** 0 full, 1 reduced, 2 minimal — battery saver never *lowers* the reduction the player asked for. */
  vfxLevel: number;
  /** Render frame-rate cap. The simulation is always 60Hz regardless. */
  targetFps: number;
  autoAim: boolean;
  insectFreeSprites: boolean;
  speedrunToolkit: boolean;
  colorblindMode: number;
  hud: ResolvedHud;
}

/**
 * Latin-script languages the in-game keyboard can actually type. Anything else forces the phone keyboard,
 * because a keyboard that cannot produce your language is not a style choice, it is a locked door.
 *
 * Deliberately a list of what we support rather than a list of what we exclude: a language we have never
 * heard of should get the working keyboard, not the pretty one.
 */
const LATIN_LANGUAGES = new Set([
  "en", "es", "pt", "fr", "it", "de", "nl", "da", "sv", "nb", "no", "nn", "fi", "is",
  "pl", "cs", "sk", "sl", "hr", "hu", "ro", "et", "lv", "lt", "tr", "id", "ms", "sw",
  "af", "sq", "eu", "ca", "gl", "cy", "ga", "vi", "tl", "fil",
]);

/** The language part of a BCP-47 tag, lowercased. "pt-BR" → "pt". Junk in gives "" out, never a throw. */
export function languageOf(locale: string): string {
  const cut = locale.indexOf("-");
  const base = cut === -1 ? locale : locale.slice(0, cut);
  return base.trim().toLowerCase();
}

/** Whether the in-game keyboard can type this language at all. */
export function inGameKeyboardSupports(locale: string): boolean {
  const lang = languageOf(locale);
  if (lang === "") return false;
  return LATIN_LANGUAGES.has(lang);
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/** A stored scale as a multiplier, clamped. Whole points out, so nothing lands on a half pixel. */
function scaleOf(stored: number): number {
  return clamp(stored, SCALE_MIN, SCALE_MAX) / 100;
}

/**
 * Resolve stored settings against the facts of the moment.
 *
 * Allocates a handful of small objects. Called on a settings change, a rotation and a run start — never
 * on a tick, which is why it is allowed to allocate at all.
 */
export function resolve(stored: SaveSettings, device: DeviceFacts): ResolvedSettings {
  const saver = stored.batterySaver;

  const wantsInGame = stored.chatKeyboard === CHAT_KEYBOARD.IN_GAME;
  const capable = inGameKeyboardSupports(device.locale);
  const keyboard = wantsInGame && capable ? CHAT_KEYBOARD.IN_GAME : CHAT_KEYBOARD.PHONE;

  // Battery saver trims effects but never adds them back: a player who set shake to 20 gets 20, not 50.
  const trim = (value: number): number => {
    const v = clamp(value, 0, INTENSITY_MAX);
    return saver ? Math.round(v / 2) : v;
  };

  return {
    chatKeyboard: keyboard,
    chatKeyboardForced: wantsInGame && !capable,
    chatEnabled: stored.chatEnabled,
    // Hearing strangers requires chat to be on at all. Two switches, one of which silently overrides the
    // other, is how a player ends up convinced they turned chat off and it kept talking to them.
    chatFromNonFriends: stored.chatEnabled && stored.chatFromNonFriends,
    damageNumbers: trim(stored.damageNumbers),
    screenFlash: trim(stored.screenFlash),
    screenShake: trim(stored.screenShake),
    vfxLevel: saver ? Math.max(1, clamp(stored.vfxLevel, 0, 2)) : clamp(stored.vfxLevel, 0, 2),
    // Battery saver CAPS the frame rate to 30 and never raises it — DYNAMIC's uncapped sentinel and a
    // chosen 60/120 all collapse to 30 with it on. With it off, the player's chosen mode decides, where
    // DYNAMIC is the uncapped sentinel the render loop reads as "follow the display".
    targetFps: saver ? BATTERY_SAVER_FPS : fpsForMode(stored.frameRateMode),
    autoAim: stored.autoAim,
    insectFreeSprites: stored.insectFreeSprites,
    speedrunToolkit: stored.speedrunToolkit,
    colorblindMode: clamp(stored.colorblindMode, 0, 3),
    hud: resolveHud(stored, device),
  };
}

/** The in-run geometry on its own, so the layout editor can preview a change without resolving everything. */
export function resolveHud(stored: SaveSettings, device: DeviceFacts): ResolvedHud {
  const width = Math.max(1, device.safeWidth);
  const height = Math.max(1, device.safeHeight);
  const topScale = scaleOf(stored.hudTopStripScale);
  const slotScale = scaleOf(stored.hudSlotStripScale);
  const badgeScale = scaleOf(stored.hudBadgeScale);
  const stickScale = scaleOf(stored.hudStickScale);
  const pad = HUD_BASE.edgePad;

  const xpHeight = Math.round(HUD_BASE.xpBarHeight * topScale);
  const statusHeight = Math.round(HUD_BASE.statusStripHeight * topScale);
  const slotStripHeight = Math.round(HUD_BASE.slotStripHeight * slotScale);

  // The three bands stack from the very top edge. The XP bar is full width on purpose — it is the one
  // number the player reads without looking, so it gets the whole screen and no padding.
  const xpBar: HudRect = { x: 0, y: 0, width, height: xpHeight };
  const statusStrip: HudRect = { x: 0, y: xpHeight, width, height: statusHeight };
  const slotStrip: HudRect = { x: 0, y: xpHeight + statusHeight, width, height: slotStripHeight };

  const slotSize = Math.round(HUD_BASE.slotSize * slotScale);
  const slotGap = Math.max(1, Math.round(HUD_BASE.slotGap * slotScale));
  const dividerWidth = Math.max(2, Math.round(HUD_BASE.dividerWidth * slotScale));

  const badgesVisible = device.playerCount > 1;
  const badgeW = Math.round(HUD_BASE.badgeWidth * badgeScale);
  const badgeH = Math.round(HUD_BASE.badgeHeight * badgeScale);
  const badgeGap = Math.max(1, Math.round(HUD_BASE.badgeGap * badgeScale));
  // Cluster width covers every seat including the local player, so alignment does not shift when someone
  // drops. A row that re-centres itself mid-fight is a row the player has to re-find mid-fight.
  const clusterWidth = badgeW * device.playerCount + badgeGap * Math.max(0, device.playerCount - 1);

  let badgeX: number;
  let badgeY: number;
  if (stored.hudBadgesDocked) {
    badgeY = slotStrip.y + slotStrip.height;
    if (stored.hudBadgeAlign === HUD_ALIGN.CENTRE) {
      badgeX = Math.round((width - clusterWidth) / 2);
    } else if (stored.hudBadgeAlign === HUD_ALIGN.RIGHT) {
      badgeX = width - clusterWidth - pad;
    } else {
      badgeX = pad;
    }
  } else {
    badgeX = Math.round((clamp(stored.hudBadgeX, 0, 100) / 100) * width);
    badgeY = Math.round((clamp(stored.hudBadgeY, 0, 100) / 100) * height);
  }
  // Dragged or aligned, the cluster stays on screen. A badge parked half off the edge is not a preference,
  // it is a lost badge, and on a different phone it would be lost through no choice of the player's.
  badgeX = clamp(badgeX, 0, Math.max(0, width - clusterWidth));
  badgeY = clamp(badgeY, slotStrip.y + slotStrip.height, Math.max(0, height - badgeH));

  const stickRadius = clamp(Math.round(stored.joystickSize * stickScale), STICK_MIN, STICK_MAX);
  // There is no fixed pad: the stick materialises wherever the thumb lands inside this region. It starts
  // below the top block and covers the bottom of the screen, so the lower part of the display is the fight
  // and the fight is never covered by a control that is not being touched.
  const zoneTop = Math.min(height - 1, slotStrip.y + slotStrip.height);
  const stickZone: HudRect = { x: 0, y: zoneTop, width, height: Math.max(1, height - zoneTop) };

  return {
    xpBar,
    statusStrip,
    slotStrip,
    slotSize,
    slotGap,
    dividerWidth,
    badgesVisible,
    badgesDocked: stored.hudBadgesDocked,
    badges: { x: badgeX, y: badgeY, width: badgeW, height: badgeH },
    badgeGap,
    stickRadius,
    stickZone,
  };
}

/**
 * Reset only the layout, leaving volumes, opt-ins and comfort options alone. The layout editor's mandatory
 * escape hatch: a player who has dragged the badges somewhere unusable must be able to get back without
 * wiping their sound settings to do it.
 */
export function resetLayout(stored: SaveSettings): SaveSettings {
  const d = defaultSettings();
  return {
    ...stored,
    joystickSize: d.joystickSize,
    joystickX: d.joystickX,
    joystickY: d.joystickY,
    hudScale: d.hudScale,
    hudBadgesDocked: d.hudBadgesDocked,
    hudBadgeAlign: d.hudBadgeAlign,
    hudBadgeX: d.hudBadgeX,
    hudBadgeY: d.hudBadgeY,
    hudTopStripScale: d.hudTopStripScale,
    hudSlotStripScale: d.hudSlotStripScale,
    hudBadgeScale: d.hudBadgeScale,
    hudStickScale: d.hudStickScale,
  };
}

/**
 * True when the daily-reminder question may be asked. Day two, once, ever — asked on first launch it is
 * noise, asked repeatedly it is the reason people turn notifications off at the system level.
 */
export function shouldAskDailyReminder(stored: SaveSettings, runsStarted: number): boolean {
  return !stored.dailyReminderAsked && runsStarted >= 2;
}
