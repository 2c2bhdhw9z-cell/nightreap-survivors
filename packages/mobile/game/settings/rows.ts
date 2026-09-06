/**
 * What the Settings screen contains, and what pressing each control does.
 *
 * THE POINT OF THIS FILE
 *
 * A settings screen is the easiest screen in a game to get quietly wrong. A slider that can be dragged
 * past its own limit, a switch that writes a value nothing reads, a row whose label says one thing and
 * whose value says another — none of those crash, none of them show up in a screenshot, and all of them
 * make a player decide the game is broken. So the screen itself gets no say in any of it.
 *
 * Everything here is plain arithmetic over the saved settings block: which rows exist, what each one is
 * called, what it currently reads as in words, and what the saved settings become when it is pressed.
 * There is not one React import in this file and there never will be, which is what lets the whole thing
 * be checked without a phone, a screen, or a person to look at it.
 *
 * THE SHAPE OF A CHANGE
 *
 * Every control answers the same question — "given the settings as they are, what are the settings after
 * this press" — and answers it by returning a NEW settings block. Nothing is edited in place. That is
 * deliberate: the screen compares what it has against what it started with to know whether there is
 * anything to write, and an in-place edit would make those two the same object and the comparison always
 * say "nothing changed".
 *
 * A NOTE ON DEFAULTS
 *
 * Every volume and comfort default is written on a notch. It has to be: a stored 85 would be shown as
 * 90%, because the display rounds to the nearest notch — and a screen that shows a number the save does
 * not hold is the exact bug this file exists to prevent. The sound-effects default moved from 85 to 80
 * for that reason and no other.
 *
 * WHY SLIDERS ARE STEPPED
 *
 * Every slider here moves in fixed notches rather than continuously. Two reasons, both practical. A thumb
 * on a phone cannot reliably land on 63 out of 100, so a continuous slider is really a stepped one with
 * the steps hidden. And a stepped control can be driven by two plain buttons, which works with a
 * screen reader, works with a controller, and works for someone who cannot make a dragging gesture at
 * all. A drag can be added on top later; the notches are the truth underneath it.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * The HUD positions and scales. They are real settings and they are saved, but they are edited by
 * dragging things around a picture of the HUD, not by a list of numbers, and that is a screen of its own.
 * Putting "joystick X: 18" in a list would technically expose the setting while being useless to the
 * person it exists for.
 *
 * Language. The game reads the phone's language and there is no second choice to offer yet, because
 * there is only one language of text in the game. A picker with one entry in it is a lie about what the
 * game can do, so the row says what language it is using and where that came from, and offers nothing.
 */

import { CHAT_KEYBOARD, type SaveSettings } from "@/game/save/schema";

/** The kinds of control the screen knows how to draw. Adding a kind means teaching the screen too. */
export const ROW_KIND = {
  /** A number in notches, shown as a percentage or a plain value. Two buttons, minus and plus. */
  slider: 0,
  /** On or off. */
  toggle: 1,
  /** One of a short list. Pressing it moves to the next one and wraps. */
  choice: 2,
  /** Not editable. Says something true and offers no control. */
  readout: 3,
  /** A button that does something bigger than setting a value — always behind a confirm. */
  action: 4,
} as const;

export type RowKind = (typeof ROW_KIND)[keyof typeof ROW_KIND];

/** Which part of the screen a row belongs under. Order here is the order on screen. */
export const GROUPS = ["Sound", "Comfort", "Playing", "Social", "Privacy"] as const;

export type GroupName = (typeof GROUPS)[number];

/** Things a row can ask the screen to do that are not "write a number into the save". */
export const ACTION = {
  howToPlay: "howToPlay",
  armGuide: "armGuide",
  deleteSave: "deleteSave",
} as const;

export type ActionId = (typeof ACTION)[keyof typeof ACTION];

export interface SettingRow {
  /** Stable name. Used by tests and by the screen's list keys; never shown to a player. */
  readonly id: string;
  readonly group: GroupName;
  readonly kind: RowKind;
  /** What the player reads. */
  readonly label: string;
  /** One line under the label saying what it actually does. Every row has one; none of them are obvious. */
  readonly help: string;
  /** What this row currently reads as, in words. "80%", "On", "Full". */
  readonly value: (s: SaveSettings) => string;
  /** The settings after a press. `step` is -1 or +1 for a slider, and ignored by everything else. */
  readonly apply: (s: SaveSettings, step: number) => SaveSettings;
  /** Set only on action rows. The screen decides what to do about it. */
  readonly action?: ActionId;
  /** True when a row cannot be changed right now, with the reason in `disabledBecause`. */
  readonly disabled?: (s: SaveSettings) => boolean;
  readonly disabledBecause?: string;
}

/** How far one press moves a percentage slider. Ten notches from silent to full is enough to aim. */
export const SLIDER_STEP = 10;
export const SLIDER_MIN = 0;
export const SLIDER_MAX = 100;

/** Round a stored number onto the notches, then hold it inside the ends. Junk in gives the low end out. */
export function snap(value: number, step = SLIDER_STEP, low = SLIDER_MIN, high = SLIDER_MAX): number {
  if (!Number.isFinite(value)) return low;
  const rounded = Math.round(value / step) * step;
  if (rounded < low) return low;
  if (rounded > high) return high;
  return rounded;
}

/** The value a slider takes after a press. Pressing minus at zero stays at zero and is not an error. */
export function nudge(value: number, step: number): number {
  return snap(snap(value) + (step < 0 ? -SLIDER_STEP : SLIDER_STEP));
}

/** A percentage in words. Zero says "Off", because "0%" reads as a broken control rather than a choice. */
export function percentWords(value: number): string {
  const v = snap(value);
  return v === 0 ? "Off" : `${v}%`;
}

function onOff(on: boolean): string {
  return on ? "On" : "Off";
}

/** The three effect levels, lowest first is NOT the order — full is the default and comes first. */
export const VFX_WORDS = ["Full", "Reduced", "Minimal"] as const;

/** Colour-blind modes in the order the number stores them. */
export const COLORBLIND_WORDS = ["Off", "Deuteranopia", "Protanopia", "Tritanopia"] as const;

/** Frame-rate modes in the order `FRAME_RATE_MODE` stores them: 60, 120, then Dynamic. */
export const FRAME_RATE_WORDS = ["60", "120", "Dynamic"] as const;

/** Next entry in a wrapping list. A count of zero gives zero rather than dividing by nothing. */
export function nextChoice(current: number, count: number): number {
  if (count <= 0) return 0;
  const safe = Number.isFinite(current) ? Math.trunc(current) : 0;
  const next = safe + 1;
  return ((next % count) + count) % count;
}

function slider(
  id: string,
  group: GroupName,
  label: string,
  help: string,
  read: (s: SaveSettings) => number,
  write: (s: SaveSettings, v: number) => SaveSettings,
): SettingRow {
  return {
    id,
    group,
    kind: ROW_KIND.slider,
    label,
    help,
    value: (s) => percentWords(read(s)),
    apply: (s, step) => write(s, nudge(read(s), step)),
  };
}

function toggle(
  id: string,
  group: GroupName,
  label: string,
  help: string,
  read: (s: SaveSettings) => boolean,
  write: (s: SaveSettings, v: boolean) => SaveSettings,
): SettingRow {
  return {
    id,
    group,
    kind: ROW_KIND.toggle,
    label,
    help,
    value: (s) => onOff(read(s)),
    apply: (s) => write(s, !read(s)),
  };
}

/**
 * Every row on the Settings screen, in the order they appear.
 *
 * Sound is first because it is the setting people reach for in the first ten seconds, usually in a room
 * where the game has just started making noise unexpectedly.
 */
export const SETTING_ROWS: readonly SettingRow[] = [
  slider(
    "masterVolume",
    "Sound",
    "Overall volume",
    "Everything the game plays, music and effects together.",
    (s) => s.masterVolume,
    (s, v) => ({ ...s, masterVolume: v }),
  ),
  slider(
    "musicVolume",
    "Sound",
    "Music",
    "The soundtrack only. Set it to Off to play with just the effects.",
    (s) => s.musicVolume,
    (s, v) => ({ ...s, musicVolume: v }),
  ),
  slider(
    "sfxVolume",
    "Sound",
    "Sound effects",
    "Hits, pickups, level-ups and the rest.",
    (s) => s.sfxVolume,
    (s, v) => ({ ...s, sfxVolume: v }),
  ),

  slider(
    "screenShake",
    "Comfort",
    "Screen shake",
    "How much the screen kicks when something big happens. Off is fully still.",
    (s) => s.screenShake,
    (s, v) => ({ ...s, screenShake: v }),
  ),
  slider(
    "screenFlash",
    "Comfort",
    "Screen flashes",
    "The bright flash on a level-up or a big hit. Turn it down if flashing bothers you.",
    (s) => s.screenFlash,
    (s, v) => ({ ...s, screenFlash: v }),
  ),
  slider(
    "damageNumbers",
    "Comfort",
    "Damage numbers",
    "How many of the little numbers that fly off enemies are drawn. Off hides them.",
    (s) => s.damageNumbers,
    (s, v) => ({ ...s, damageNumbers: v }),
  ),
  {
    id: "vfxLevel",
    group: "Comfort",
    kind: ROW_KIND.choice,
    label: "Effects",
    help: "How much is drawn on top of the fight. Reduce it if the screen gets too busy to read.",
    value: (s) => VFX_WORDS[snapChoice(s.vfxLevel, VFX_WORDS.length)] ?? VFX_WORDS[0],
    apply: (s) => ({ ...s, vfxLevel: nextChoice(s.vfxLevel, VFX_WORDS.length) }),
  },
  {
    id: "colorblindMode",
    group: "Comfort",
    kind: ROW_KIND.choice,
    label: "Colour-blind mode",
    help: "Shifts the colours the game uses to tell things apart.",
    value: (s) => COLORBLIND_WORDS[snapChoice(s.colorblindMode, COLORBLIND_WORDS.length)] ?? COLORBLIND_WORDS[0],
    apply: (s) => ({ ...s, colorblindMode: nextChoice(s.colorblindMode, COLORBLIND_WORDS.length) }),
  },
  toggle(
    "insectFreeSprites",
    "Comfort",
    "No insects",
    "Swaps every insect-shaped enemy for one that is not an insect. Nothing else changes.",
    (s) => s.insectFreeSprites,
    (s, v) => ({ ...s, insectFreeSprites: v }),
  ),

  toggle(
    "autoAim",
    "Playing",
    "Auto aim",
    "Points your weapons at the nearest enemy. Allowed on every leaderboard.",
    (s) => s.autoAim,
    (s, v) => ({ ...s, autoAim: v }),
  ),
  {
    id: "frameRate",
    group: "Playing",
    kind: ROW_KIND.choice,
    label: "Frame rate",
    help: "How often the screen is drawn: 60, 120, or Dynamic (matches your display). The game speed is unchanged.",
    value: (s) => FRAME_RATE_WORDS[snapChoice(s.frameRateMode, FRAME_RATE_WORDS.length)] ?? FRAME_RATE_WORDS[0],
    apply: (s) => ({ ...s, frameRateMode: nextChoice(s.frameRateMode, FRAME_RATE_WORDS.length) }),
  },
  toggle(
    "batterySaver",
    "Playing",
    "Battery saver",
    "Caps the frame rate and trims effects. The game still runs at the same speed.",
    (s) => s.batterySaver,
    (s, v) => ({ ...s, batterySaver: v }),
  ),
  toggle(
    "speedrunToolkit",
    "Playing",
    "Speedrun overlay",
    "Shows a precise timer, your inputs and the run's seed. It only reads; it changes nothing.",
    (s) => s.speedrunToolkit,
    (s, v) => ({ ...s, speedrunToolkit: v }),
  ),
  {
    id: "armGuide",
    group: "Playing",
    kind: ROW_KIND.action,
    label: "Show the tips again",
    help: "Turns the first-run tips back on for your next run.",
    action: ACTION.armGuide,
    value: (s) => (s.guideArmed ? "Armed" : "Off"),
    apply: (s) => ({ ...s, guideArmed: true, guideOffered: true }),
  },
  {
    id: "howToPlay",
    group: "Playing",
    kind: ROW_KIND.action,
    label: "How to play",
    help: "The controls, the level-up cards, and what all the pickups do.",
    action: ACTION.howToPlay,
    value: () => "",
    apply: (s) => s,
  },

  {
    id: "language",
    group: "Social",
    kind: ROW_KIND.readout,
    label: "Language",
    help: "Taken from your phone. It decides whether the game's own keyboard can type what you write.",
    value: () => "From your phone",
    apply: (s) => s,
  },
  toggle(
    "chatEnabled",
    "Social",
    "Chat",
    "Whether a chat box appears in a party at all. Turning it off does not change the age rating.",
    (s) => s.chatEnabled,
    (s, v) => ({ ...s, chatEnabled: v }),
  ),
  {
    ...toggle(
      "chatFromNonFriends",
      "Social",
      "Chat from strangers",
      "Off means only people on your friends list can be read.",
      (s) => s.chatFromNonFriends,
      (s, v) => ({ ...s, chatFromNonFriends: v }),
    ),
    disabled: (s) => !s.chatEnabled,
    disabledBecause: "Chat is off.",
  },
  {
    id: "chatKeyboard",
    group: "Social",
    kind: ROW_KIND.choice,
    label: "Chat keyboard",
    help: "Your phone's keyboard, or the game's own. The game's own is English letters only.",
    value: (s) => (s.chatKeyboard === CHAT_KEYBOARD.IN_GAME ? "In-game" : "Phone"),
    apply: (s) => ({
      ...s,
      chatKeyboard: s.chatKeyboard === CHAT_KEYBOARD.IN_GAME ? CHAT_KEYBOARD.PHONE : CHAT_KEYBOARD.IN_GAME,
    }),
    disabled: (s) => !s.chatEnabled,
    disabledBecause: "Chat is off.",
  },

  toggle(
    "crashReportOptIn",
    "Privacy",
    "Send crash reports",
    "If the game dies, send what it was doing. Off by default and nothing is sent until you say yes.",
    (s) => s.crashReportOptIn,
    (s, v) => ({ ...s, crashReportOptIn: v }),
  ),
  toggle(
    "telemetryOptIn",
    "Privacy",
    "Share play data",
    "Anonymous numbers about how runs go, used to balance the game. Off by default.",
    (s) => s.telemetryOptIn,
    (s, v) => ({ ...s, telemetryOptIn: v }),
  ),
  toggle(
    "personalisedAdsOptIn",
    "Privacy",
    "Personalised ads",
    "Off by default. There are no ads in the game today; this is here so the answer is yours first.",
    (s) => s.personalisedAdsOptIn,
    (s, v) => ({ ...s, personalisedAdsOptIn: v }),
  ),
  {
    id: "deleteSave",
    group: "Privacy",
    kind: ROW_KIND.action,
    label: "Delete everything",
    help: "Wipes your progress, your gold and these settings off this phone. It cannot be undone.",
    action: ACTION.deleteSave,
    value: () => "",
    apply: (s) => s,
  },
];

/** Hold a stored choice inside a list, so a save from a newer build cannot show an empty value. */
export function snapChoice(value: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(value)) return 0;
  const v = Math.trunc(value);
  if (v < 0) return 0;
  if (v >= count) return 0;
  return v;
}

/** The rows of one group, in order. Used by the screen to draw a section at a time. */
export function rowsIn(group: GroupName): readonly SettingRow[] {
  return SETTING_ROWS.filter((r) => r.group === group);
}

/**
 * Whether two settings blocks differ in any way the player could have caused.
 *
 * The screen uses this to decide whether it owes the save file a write. Comparing field by field rather
 * than by identity, because every apply returns a new object and identity would always say "different".
 */
export function settingsDiffer(a: SaveSettings, b: SaveSettings): boolean {
  const keys = Object.keys(a) as (keyof SaveSettings)[];
  for (const k of keys) {
    if (a[k] !== b[k]) return true;
  }
  return false;
}
