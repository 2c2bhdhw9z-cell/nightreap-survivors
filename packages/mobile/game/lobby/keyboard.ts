/**
 * The in-game keyboard: layout and behaviour, with no drawing in it.
 *
 * WHY THIS IS A MODULE AND NOT PART OF A SCREEN
 *
 * A keyboard is almost all behaviour and almost no pixels. Shift that turns itself off after one letter,
 * a caps lock that does not, a backspace that deletes one character and not one *byte*, a character cap
 * that has to count the way the wire counts — every one of those is a rule, and every one of them is
 * invisible in a screenshot. They live here so they can be tested without a phone.
 *
 * WHAT IT IS NOT
 *
 * Not the default. The phone's own keyboard is the default and always will be, because it brings
 * autocorrect, swipe, dictation, emoji, every language, and the accessibility features the operating
 * system already built. This one exists because it looks like the game, and it is offered as a choice —
 * `Settings → Interface → Chat keyboard`. A player who wants the pretty one can have it; a player whose
 * language it cannot type is given the working one whether they asked or not.
 *
 * English and latin letters only, deliberately. There is no honest way to draw a keyboard for every
 * writing system into a sprite atlas, so rather than shipping a keyboard that half the world cannot
 * type on, the settings layer forces those players to the phone keyboard and greys the toggle out.
 *
 * The caps are counted twice on purpose: once in characters, because that is what a player sees, and
 * once in bytes, because that is what the wire has room for. An emoji pasted from elsewhere is one
 * character and four bytes, and a keyboard that only counted characters would let a player type a
 * message the network then silently truncates.
 */

import { MAX_CHAT_BYTES, MAX_CHAT_CHARS } from "./lobby";

/* ---------------------------------------------------------------------------------------------- */
/* Keys                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What a key does. Anything that is not one of these is a character key and inserts its own label.
 *
 * Append-only, like everything else that ends up in saved settings or a layout table.
 */
export const KEY = {
  CHAR: 0,
  SHIFT: 1,
  BACKSPACE: 2,
  SPACE: 3,
  /** Switches between letters and the numbers/punctuation page. */
  PAGE: 4,
  /** Sends. The tick, bottom right. */
  ENTER: 5,
  /** Opens the preset shouts instead — the six words that need no typing at all. */
  PRESETS: 6,
} as const;

export type KeyKind = (typeof KEY)[keyof typeof KEY];

export interface KeyCap {
  kind: number;
  /** What is drawn on the key, and for a character key, what it types when unshifted. */
  label: string;
  /** What a character key types when shift is on. Empty for everything else. */
  shifted: string;
  /** Width in key units, so a spacebar is one entry rather than eight. 1 is a normal key. */
  units: number;
}

function charKey(label: string, shifted: string): KeyCap {
  return { kind: KEY.CHAR, label, shifted, units: 1 };
}

function wideKey(kind: number, label: string, units: number): KeyCap {
  return { kind, label, shifted: "", units };
}

/**
 * The letters page. A plain QWERTY, because every alternative layout ever shipped in a game was a
 * puzzle the player had to solve before they could say "behind you".
 */
export const LETTER_ROWS: KeyCap[][] = [
  "qwertyuiop".split("").map((c) => charKey(c, c.toUpperCase())),
  "asdfghjkl".split("").map((c) => charKey(c, c.toUpperCase())),
  [
    wideKey(KEY.SHIFT, "SHIFT", 1.5),
    ...["z", "x", "c", "v", "b", "n", "m"].map((c) => charKey(c, c.toUpperCase())),
    wideKey(KEY.BACKSPACE, "DEL", 1.5),
  ],
  [
    wideKey(KEY.PAGE, "123", 1.5),
    wideKey(KEY.PRESETS, "SHOUT", 1.5),
    wideKey(KEY.SPACE, "SPACE", 4),
    wideKey(KEY.ENTER, "SEND", 2),
  ],
];

/**
 * The numbers and punctuation page.
 *
 * The set is deliberately small. Every character here has to exist as a drawn glyph in the atlas, and a
 * keyboard offering a character the game cannot draw shows a player a box instead of what they typed.
 */
export const SYMBOL_ROWS: KeyCap[][] = [
  "1234567890".split("").map((c) => charKey(c, c)),
  ["-", "/", ":", ";", "(", ")", "&", "@", '"'].map((c) => charKey(c, c)),
  [
    wideKey(KEY.SHIFT, "SHIFT", 1.5),
    ...[".", ",", "?", "!", "'", "+", "="].map((c) => charKey(c, c)),
    wideKey(KEY.BACKSPACE, "DEL", 1.5),
  ],
  [
    wideKey(KEY.PAGE, "ABC", 1.5),
    wideKey(KEY.PRESETS, "SHOUT", 1.5),
    wideKey(KEY.SPACE, "SPACE", 4),
    wideKey(KEY.ENTER, "SEND", 2),
  ],
];

/** Which page is showing. */
export const PAGE = { LETTERS: 0, SYMBOLS: 1 } as const;

/** Shift, in the three states a real keyboard has. */
export const SHIFT = {
  OFF: 0,
  /** On for exactly one letter, then off. The state a keyboard is in after you tap shift once. */
  ONCE: 1,
  /** Caps lock. Stays on. Reached by tapping shift twice. */
  LOCKED: 2,
} as const;

/* ---------------------------------------------------------------------------------------------- */
/* State                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export interface KeyboardState {
  text: string;
  page: number;
  shift: number;
  /** True when the last key press asked to send. The screen acts on it and calls `clear`. */
  submitted: boolean;
  /** True when the last key press asked for the preset shouts instead. */
  wantsPresets: boolean;
  /** True when the last press was refused because the message is as long as it can get. */
  full: boolean;
}

export function createKeyboardState(): KeyboardState {
  return { text: "", page: PAGE.LETTERS, shift: SHIFT.OFF, submitted: false, wantsPresets: false, full: false };
}

/** Rows for whichever page is showing. */
export function rowsFor(state: KeyboardState): KeyCap[][] {
  return state.page === PAGE.SYMBOLS ? SYMBOL_ROWS : LETTER_ROWS;
}

/** What a character key should be drawing right now. */
export function capLabel(cap: KeyCap, state: KeyboardState): string {
  if (cap.kind !== KEY.CHAR) return cap.label;
  return state.shift === SHIFT.OFF ? cap.label : cap.shifted;
}

/** How many bytes this text will take on the wire. Counted, not estimated. */
export function byteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Whether one more piece of text still fits.
 *
 * Both caps are real. Characters are what the player sees; bytes are what the message has room for.
 * Whichever runs out first is the one that stops them.
 */
export function fits(text: string, addition: string): boolean {
  const chars = [...text].length + [...addition].length;
  if (chars > MAX_CHAT_CHARS) return false;
  return byteLength(text) + byteLength(addition) <= MAX_CHAT_BYTES;
}

/**
 * Press a key. Returns the same state object, mutated — one keyboard, one state, no garbage per
 * keystroke.
 *
 * `submitted`, `wantsPresets` and `full` are cleared at the top of every press, so they always describe
 * the press that just happened and never a press from ten seconds ago.
 */
export function press(state: KeyboardState, cap: KeyCap): KeyboardState {
  state.submitted = false;
  state.wantsPresets = false;
  state.full = false;

  switch (cap.kind) {
    case KEY.SHIFT:
      // Off → once → locked → off. Tap for one capital, tap again for caps lock, tap again to stop.
      state.shift = state.shift === SHIFT.OFF ? SHIFT.ONCE : state.shift === SHIFT.ONCE ? SHIFT.LOCKED : SHIFT.OFF;
      return state;

    case KEY.BACKSPACE: {
      // Delete one character, not one byte. Splitting a multi-byte character in half is how a text field
      // starts showing replacement boxes.
      const chars = [...state.text];
      chars.pop();
      state.text = chars.join("");
      return state;
    }

    case KEY.PAGE:
      state.page = state.page === PAGE.LETTERS ? PAGE.SYMBOLS : PAGE.LETTERS;
      // Caps lock survives a page change; a one-shot shift does not, because it was meant for the letter
      // you were about to type and you just went somewhere else.
      if (state.shift === SHIFT.ONCE) state.shift = SHIFT.OFF;
      return state;

    case KEY.PRESETS:
      state.wantsPresets = true;
      return state;

    case KEY.ENTER:
      // An empty send is not a send. The lobby would refuse it anyway; refusing here means the field does
      // not flash an error at a player who simply tapped the wrong key.
      if (state.text.trim().length === 0) return state;
      state.submitted = true;
      return state;

    case KEY.SPACE: {
      // A leading space, or a second space in a row, is dropped rather than typed. The filter collapses
      // both before sending, so typing them only ever misleads about how much room is left.
      if (state.text.length === 0 || state.text.endsWith(" ")) return state;
      if (!fits(state.text, " ")) {
        state.full = true;
        return state;
      }
      state.text += " ";
      return state;
    }

    default: {
      const typed = state.shift === SHIFT.OFF ? cap.label : cap.shifted;
      if (!fits(state.text, typed)) {
        state.full = true;
        return state;
      }
      state.text += typed;
      if (state.shift === SHIFT.ONCE) state.shift = SHIFT.OFF;
      return state;
    }
  }
}

/** Empty the field. Called after a line is sent, and when the panel closes. */
export function clear(state: KeyboardState): KeyboardState {
  state.text = "";
  state.shift = SHIFT.OFF;
  state.submitted = false;
  state.wantsPresets = false;
  state.full = false;
  return state;
}

/**
 * Room left, in characters, for the counter above the field.
 *
 * Reported in characters because that is the unit a player is typing in. When the byte cap is the one
 * about to bite, this still counts down to zero honestly — it just does so faster.
 */
export function charsLeft(state: KeyboardState): number {
  const byChars = MAX_CHAT_CHARS - [...state.text].length;
  const byBytes = MAX_CHAT_BYTES - byteLength(state.text);
  return Math.max(0, Math.min(byChars, byBytes));
}
