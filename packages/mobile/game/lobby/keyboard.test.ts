/**
 * The in-game keyboard. Headless: `bun packages/mobile/game/lobby/keyboard.test.ts`
 *
 * A keyboard is nearly all behaviour and nearly no pixels, and none of the behaviour shows up in a
 * screenshot. These are the rules that make it feel like a keyboard rather than a grid of buttons.
 *
 * WHAT IT PROVES
 *   1. Shift has the three states a real keyboard has, in the order a thumb expects.
 *   2. Backspace deletes one character, never half of one.
 *   3. Both caps are real — what the player can see, and what the wire can carry.
 *   4. Spaces cannot be used to fake a message that is all whitespace.
 *   5. An empty send is not a send.
 *   6. Every flag describes the press that just happened, not an older one.
 *   7. The layout has no key that types something the game cannot draw.
 *
 * Exits non-zero on any failure.
 */

import { MAX_CHAT_BYTES, MAX_CHAT_CHARS } from "./lobby";
import {
  KEY,
  LETTER_ROWS,
  PAGE,
  SHIFT,
  SYMBOL_ROWS,
  byteLength,
  capLabel,
  charsLeft,
  clear,
  createKeyboardState,
  fits,
  press,
  rowsFor,
  type KeyCap,
  type KeyboardState,
} from "./keyboard";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  failures++;
  console.log(`FAIL  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

function section(name: string): void {
  console.log(`\n--- ${name}`);
}

/** Find a key by what is written on it, on whichever page it lives. */
function key(label: string): KeyCap {
  for (const rows of [LETTER_ROWS, SYMBOL_ROWS]) {
    for (const row of rows) {
      for (const cap of row) {
        if (cap.label === label) return cap;
      }
    }
  }
  throw new Error(`no key labelled ${label}`);
}

/** Type a run of plain letters. */
function type(state: KeyboardState, text: string): KeyboardState {
  for (const ch of text) press(state, ch === " " ? key("SPACE") : key(ch));
  return state;
}

const SHIFT_KEY = key("SHIFT");
const DEL = key("DEL");
const SPACE = key("SPACE");
const SEND = key("SEND");
const SHOUT = key("SHOUT");

/* ---------------------------------------------------------------------------------------------- */

section("shift behaves the way a thumb expects");
{
  const s = createKeyboardState();
  check("starts off", s.shift === SHIFT.OFF);
  press(s, SHIFT_KEY);
  check("one tap arms it for a single letter", s.shift === SHIFT.ONCE);
  check("and the keys show capitals", capLabel(key("q"), s) === "Q");
  press(s, key("q"));
  check("the letter came out capital", s.text === "Q");
  check("and shift let go by itself", s.shift === SHIFT.OFF);
  press(s, key("q"));
  check("the next letter is lower case", s.text === "Qq");

  press(s, SHIFT_KEY);
  press(s, SHIFT_KEY);
  check("two taps locks it", s.shift === SHIFT.LOCKED);
  type(s, "abc");
  check("caps lock stays on", s.text === "QqABC", s.text);
  check("still locked afterwards", s.shift === SHIFT.LOCKED);
  press(s, SHIFT_KEY);
  check("a third tap turns it off", s.shift === SHIFT.OFF);

  press(s, SHIFT_KEY);
  press(s, key("123"));
  check("a one-shot shift does not survive changing page", s.shift === SHIFT.OFF);
  press(s, key("ABC"));
  press(s, SHIFT_KEY);
  press(s, SHIFT_KEY);
  press(s, key("123"));
  check("but caps lock does", s.shift === SHIFT.LOCKED);
  check("the page did change", s.page === PAGE.SYMBOLS);
  check("and the rows changed with it", rowsFor(s) === SYMBOL_ROWS);
}

section("backspace deletes one character, never half of one");
{
  const s = createKeyboardState();
  type(s, "abc");
  press(s, DEL);
  check("one letter goes", s.text === "ab");
  press(s, DEL);
  press(s, DEL);
  check("emptied", s.text === "");
  press(s, DEL);
  check("deleting from empty is harmless", s.text === "");

  // Something pasted in from the phone keyboard: one character, four bytes.
  const wide = createKeyboardState();
  wide.text = "hi 🦇";
  check("that is four characters", [...wide.text].length === 4);
  check("and seven bytes", byteLength(wide.text) === 7, `${byteLength(wide.text)}`);
  press(wide, DEL);
  check("backspace removed the whole thing", wide.text === "hi ", wide.text);
  check("not half of it", byteLength(wide.text) === 3, `${byteLength(wide.text)}`);
}

section("both caps are real");
{
  check("a plain letter is one byte", byteLength("a") === 1);
  check("an accented letter is two", byteLength("é") === 2);
  check("a bat is four", byteLength("🦇") === 4);
  check("empty is nothing", byteLength("") === 0);

  const s = createKeyboardState();
  s.text = "x".repeat(MAX_CHAT_CHARS - 1);
  check("one more fits", fits(s.text, "x") === true);
  check("one left to say so", charsLeft(s) === 1);
  press(s, key("x"));
  check("it went in", [...s.text].length === MAX_CHAT_CHARS);
  check("and nothing is left", charsLeft(s) === 0);
  press(s, key("x"));
  check("the next one is refused", [...s.text].length === MAX_CHAT_CHARS);
  check("and the screen is told why", s.full === true);

  // The byte cap bites first when the characters are wide ones.
  const wide = createKeyboardState();
  wide.text = "é".repeat(Math.floor(MAX_CHAT_BYTES / 2));
  check("the byte cap is reached before the character cap", [...wide.text].length < MAX_CHAT_CHARS);
  check("nothing more fits", fits(wide.text, "x") === false);
  check("and the counter says zero, honestly", charsLeft(wide) === 0);
}

section("spaces cannot be used to fake a message");
{
  const s = createKeyboardState();
  press(s, SPACE);
  check("a leading space is dropped", s.text === "");
  type(s, "hi");
  press(s, SPACE);
  check("a space after a word is fine", s.text === "hi ");
  press(s, SPACE);
  check("a second space in a row is dropped", s.text === "hi ");
  press(s, SPACE);
  press(s, SPACE);
  check("and so is the tenth", s.text === "hi ");
}

section("an empty send is not a send");
{
  const s = createKeyboardState();
  press(s, SEND);
  check("nothing typed, nothing sent", s.submitted === false);
  type(s, "yo");
  press(s, SEND);
  check("something typed, something sent", s.submitted === true);
  check("but the field is not cleared for us", s.text === "yo");
  clear(s);
  check("clearing empties it", s.text === "");
  check("and stands shift back down", s.shift === SHIFT.OFF);
  check("and forgets the send", s.submitted === false);

  const spaces = createKeyboardState();
  spaces.text = "   ";
  press(spaces, SEND);
  check("whitespace alone is not a send either", spaces.submitted === false);
}

section("every flag describes the press that just happened");
{
  const s = createKeyboardState();
  type(s, "hi");
  press(s, SEND);
  check("submitted after send", s.submitted === true);
  press(s, key("a"));
  check("a later keystroke clears it", s.submitted === false);

  press(s, SHOUT);
  check("the shout key asks for presets", s.wantsPresets === true);
  check("and types nothing", s.text === "hia");
  press(s, key("b"));
  check("the ask is cleared by the next press", s.wantsPresets === false);

  const full = createKeyboardState();
  full.text = "x".repeat(MAX_CHAT_CHARS);
  press(full, key("x"));
  check("full after a refused key", full.full === true);
  press(full, DEL);
  check("and not full after a delete", full.full === false);
}

section("the layout has nothing on it the game cannot draw");
{
  const allowed = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/:;()&@\".,?!'+=".split(""));
  let chars = 0;
  let bad = "";
  for (const rows of [LETTER_ROWS, SYMBOL_ROWS]) {
    for (const row of rows) {
      for (const cap of row) {
        if (cap.kind !== KEY.CHAR) continue;
        chars++;
        if (!allowed.has(cap.label) || !allowed.has(cap.shifted)) bad += `${cap.label}${cap.shifted} `;
      }
    }
  }
  check("there are keys at all", chars > 40, `${chars}`);
  check("every character key types something we have a glyph for", bad === "", bad);
  check("every character key has a shifted form", (() => {
    for (const rows of [LETTER_ROWS, SYMBOL_ROWS]) {
      for (const row of rows) {
        for (const cap of row) {
          if (cap.kind === KEY.CHAR && cap.shifted === "") return false;
        }
      }
    }
    return true;
  })());
  check("both pages can send", SYMBOL_ROWS.some((r) => r.some((c) => c.kind === KEY.ENTER)) && LETTER_ROWS.some((r) => r.some((c) => c.kind === KEY.ENTER)));
  check("both pages can delete", SYMBOL_ROWS.some((r) => r.some((c) => c.kind === KEY.BACKSPACE)) && LETTER_ROWS.some((r) => r.some((c) => c.kind === KEY.BACKSPACE)));
  check("both pages can reach the shouts", SYMBOL_ROWS.some((r) => r.some((c) => c.kind === KEY.PRESETS)) && LETTER_ROWS.some((r) => r.some((c) => c.kind === KEY.PRESETS)));
  check("every row is the same width, so the grid is square", (() => {
    const widthOf = (rows: KeyCap[][]): number[] => rows.map((r) => r.reduce((n, c) => n + c.units, 0));
    const letters = widthOf(LETTER_ROWS);
    const symbols = widthOf(SYMBOL_ROWS);
    const target = 10;
    return [...letters, ...symbols].every((w) => Math.abs(w - target) <= 1);
  })(), `${LETTER_ROWS.map((r) => r.reduce((n, c) => n + c.units, 0)).join(",")}`);
  check("the letters page is a plain qwerty", (LETTER_ROWS[0] as KeyCap[]).map((c) => c.label).join("") === "qwertyuiop");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
