/**
 * Checks on the Settings rows.
 *
 * Nothing here draws anything. Every check is "given these settings, pressing this control leaves the
 * settings like this", which is the whole of what a settings screen is once the pictures are taken away.
 *
 * The checks that matter most are the boring ones: that a slider cannot leave its ends, that a control
 * changes its own setting and NOTHING else, and that every row's words match its stored value. Those
 * three are where a settings screen actually goes wrong.
 */

import { defaultSettings, CHAT_KEYBOARD, type SaveSettings } from "@/game/save/schema";
import {
  ACTION,
  COLORBLIND_WORDS,
  GROUPS,
  ROW_KIND,
  SETTING_ROWS,
  SLIDER_MAX,
  SLIDER_MIN,
  SLIDER_STEP,
  VFX_WORDS,
  nextChoice,
  nudge,
  percentWords,
  rowsIn,
  settingsDiffer,
  snap,
  snapChoice,
} from "@/game/settings/rows";

let checks = 0;
let failures = 0;

function ok(what: string, condition: boolean): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL ${what}`);
}

function eq(what: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual === expected) return;
  failures++;
  console.log(`  FAIL ${what}: got ${String(actual)}, wanted ${String(expected)}`);
}

/* ---- 1. the table itself ------------------------------------------------------------------- */

{
  ok("there are rows at all", SETTING_ROWS.length >= 15);

  const ids = new Set<string>();
  for (const r of SETTING_ROWS) {
    ok(`${r.id} has a unique id`, !ids.has(r.id));
    ids.add(r.id);
    ok(`${r.id} has a label`, r.label.trim().length > 0);
    // Every row explains itself. A settings list where half the rows are a bare noun is a quiz.
    ok(`${r.id} has help text`, r.help.trim().length >= 20);
    ok(`${r.id} help ends in a full stop`, r.help.trim().endsWith("."));
    ok(`${r.id} is in a known group`, (GROUPS as readonly string[]).includes(r.group));
  }

  // Every group named actually has rows in it, so the screen cannot draw an empty heading.
  for (const g of GROUPS) {
    ok(`group ${g} has rows`, rowsIn(g).length > 0);
  }

  // rowsIn keeps table order rather than inventing one.
  const soundIds = rowsIn("Sound").map((r) => r.id);
  eq("Sound rows are in table order", soundIds.join(","), "masterVolume,musicVolume,sfxVolume");

  // Every action row names an action, and no non-action row does.
  for (const r of SETTING_ROWS) {
    if (r.kind === ROW_KIND.action) {
      ok(`${r.id} names an action`, r.action !== undefined);
      ok(
        `${r.id} names a known action`,
        r.action !== undefined && (Object.values(ACTION) as string[]).includes(r.action),
      );
    } else {
      ok(`${r.id} is not pretending to be an action`, r.action === undefined);
    }
  }

  // A row that can be disabled must say why. A greyed-out control with no reason is a dead end.
  for (const r of SETTING_ROWS) {
    if (r.disabled === undefined) continue;
    ok(`${r.id} says why it is disabled`, (r.disabledBecause ?? "").trim().length > 0);
  }

  // The three the user asked for by name are present.
  for (const id of ["sfxVolume", "musicVolume", "screenShake", "insectFreeSprites", "deleteSave"]) {
    ok(`${id} is on the screen`, SETTING_ROWS.some((r) => r.id === id));
  }
}

{
  // Every default that a slider will display must already sit on a notch. Otherwise the screen shows a
  // rounded number while the save holds a different one, and the first press appears to jump two steps.
  const base = defaultSettings();
  const offNotch: string[] = [];
  for (const r of SETTING_ROWS) {
    if (r.kind !== ROW_KIND.slider) continue;
    const shown = r.value(base);
    const stored = base[r.id as keyof SaveSettings];
    const storedWords = percentWords(typeof stored === "number" ? stored : -1);
    if (shown !== storedWords || (typeof stored === "number" && stored % SLIDER_STEP !== 0)) {
      offNotch.push(`${r.id}=${String(stored)} shows ${shown}`);
    }
  }
  eq("every slider default sits on a notch", offNotch.join(" "), "");
}

/* ---- 2. snapping a stored number onto the notches -------------------------------------------- */

{
  eq("snap keeps a value already on a notch", snap(80), 80);
  eq("snap rounds up", snap(76), 80);
  eq("snap rounds down", snap(73), 70);
  eq("snap holds the top", snap(140), SLIDER_MAX);
  eq("snap holds the bottom", snap(-40), SLIDER_MIN);
  eq("snap of junk gives the bottom", snap(Number.NaN), SLIDER_MIN);
  eq("snap of infinity gives the bottom", snap(Number.POSITIVE_INFINITY), SLIDER_MIN);
  eq("snap of zero is zero", snap(0), 0);

  // Every snapped value lands on a notch, for every input from below the bottom to above the top.
  let offNotch = 0;
  for (let v = -30; v <= 130; v++) {
    const s = snap(v);
    if (s % SLIDER_STEP !== 0 || s < SLIDER_MIN || s > SLIDER_MAX) offNotch++;
  }
  eq("nothing snaps off a notch or out of range", offNotch, 0);
}

/* ---- 3. pressing a slider -------------------------------------------------------------------- */

{
  eq("plus moves one notch", nudge(50, 1), 60);
  eq("minus moves one notch", nudge(50, -1), 40);
  eq("plus at the top stays at the top", nudge(SLIDER_MAX, 1), SLIDER_MAX);
  eq("minus at the bottom stays at the bottom", nudge(SLIDER_MIN, -1), SLIDER_MIN);
  eq("a stored value off a notch is tidied on the way", nudge(73, 1), 80);
  eq("and tidied downward too", nudge(73, -1), 60);
  // Zero is not treated as "unset". Pressing plus from silence gives one notch, not the default.
  eq("plus from silence gives one notch", nudge(0, 1), SLIDER_STEP);

  // Ten presses from the bottom reach the top and go no further.
  let v = SLIDER_MIN;
  for (let i = 0; i < 40; i++) v = nudge(v, 1);
  eq("pressing plus forever lands on the top", v, SLIDER_MAX);
  for (let i = 0; i < 40; i++) v = nudge(v, -1);
  eq("pressing minus forever lands on the bottom", v, SLIDER_MIN);
}

/* ---- 4. words --------------------------------------------------------------------------------- */

{
  eq("silence reads as Off, not 0%", percentWords(0), "Off");
  eq("full reads as a percentage", percentWords(100), "100%");
  eq("a value off a notch reads as its notch", percentWords(73), "70%");
  eq("junk reads as Off rather than NaN%", percentWords(Number.NaN), "Off");
}

/* ---- 5. a wrapping choice --------------------------------------------------------------------- */

{
  eq("next of the first is the second", nextChoice(0, 3), 1);
  eq("next of the last wraps to the first", nextChoice(2, 3), 0);
  eq("next of an impossible value comes back into range", nextChoice(99, 3), 1);
  eq("next of a negative comes back into range", nextChoice(-1, 3), 0);
  eq("next with nothing to choose from is zero", nextChoice(0, 0), 0);

  eq("a stored choice inside the list is kept", snapChoice(2, 4), 2);
  eq("a stored choice past the end falls back to the first", snapChoice(9, 4), 0);
  eq("a negative stored choice falls back to the first", snapChoice(-3, 4), 0);
  eq("junk falls back to the first", snapChoice(Number.NaN, 4), 0);
}

/* ---- 6. every control changes its own setting and nothing else -------------------------------- */

function pressed(id: string, from: SaveSettings, step = 1): SaveSettings {
  const row = SETTING_ROWS.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row.apply(from, step);
}

/**
 * Which way to press a row so that it actually moves.
 *
 * Three of the comfort sliders ship at full, and pressing plus on a slider that is already at the top
 * correctly does nothing — so a check that always pressed plus would report those three as broken when
 * they are the only ones behaving. Press away from whichever end the value is sitting on.
 */
function movingStep(row: { kind: number; value: (s: SaveSettings) => string }, s: SaveSettings): number {
  if (row.kind !== ROW_KIND.slider) return 1;
  return row.value(s) === `${SLIDER_MAX}%` ? -1 : 1;
}

function movingPress(id: string, from: SaveSettings): SaveSettings {
  const row = SETTING_ROWS.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row.apply(from, movingStep(row, from));
}

function changedKeys(a: SaveSettings, b: SaveSettings): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as (keyof SaveSettings)[]) {
    if (a[k] !== b[k]) out.push(String(k));
  }
  return out;
}

{
  const base = defaultSettings();

  const single: [string, string][] = [
    ["masterVolume", "masterVolume"],
    ["musicVolume", "musicVolume"],
    ["sfxVolume", "sfxVolume"],
    ["screenShake", "screenShake"],
    ["screenFlash", "screenFlash"],
    ["damageNumbers", "damageNumbers"],
    ["vfxLevel", "vfxLevel"],
    ["colorblindMode", "colorblindMode"],
    ["insectFreeSprites", "insectFreeSprites"],
    ["autoAim", "autoAim"],
    ["batterySaver", "batterySaver"],
    ["speedrunToolkit", "speedrunToolkit"],
    ["chatEnabled", "chatEnabled"],
    ["chatFromNonFriends", "chatFromNonFriends"],
    ["chatKeyboard", "chatKeyboard"],
    ["crashReportOptIn", "crashReportOptIn"],
    ["telemetryOptIn", "telemetryOptIn"],
    ["personalisedAdsOptIn", "personalisedAdsOptIn"],
  ];

  for (const [id, field] of single) {
    const after = movingPress(id, base);
    const moved = changedKeys(base, after);
    eq(`${id} changes exactly one setting`, moved.join(","), field);
  }

  // The original is never edited in place — the screen's "is there anything to save" check depends on it.
  const before = defaultSettings();
  const copy = { ...before };
  pressed("masterVolume", before);
  eq("pressing a control leaves the original alone", settingsDiffer(before, copy), false);
}

{
  // The other half of the same fact, stated on purpose: a slider already at the top does not move when
  // pressed further up, and that is the control working rather than the control being stuck.
  const full = { ...defaultSettings(), screenShake: SLIDER_MAX };
  eq("plus on a full slider changes nothing", settingsDiffer(full, pressed("screenShake", full, 1)), false);
  eq("minus on a full slider does move it", settingsDiffer(full, pressed("screenShake", full, -1)), true);
}

/* ---- 7. the rows that are allowed to touch two things ----------------------------------------- */

{
  // Arming the tips also records that the offer has happened, so it cannot be made a second time.
  const base = defaultSettings();
  const after = pressed("armGuide", base);
  ok("arming the tips arms them", after.guideArmed);
  ok("arming the tips also marks the offer as made", after.guideOffered);
  eq("and touches nothing else", changedKeys(base, after).sort().join(","), "guideArmed,guideOffered");

  // The two rows that only tell the screen to go somewhere change no setting at all.
  for (const id of ["howToPlay", "deleteSave"]) {
    const out = pressed(id, base);
    eq(`${id} changes no setting by itself`, changedKeys(base, out).length, 0);
  }
}

/* ---- 8. the words on a row always match what is stored ---------------------------------------- */

{
  const base = defaultSettings();

  eq("the overall volume reads its stored value", rowValue("masterVolume", base), percentWords(base.masterVolume));
  eq("a toggle that is on says On", rowValue("chatEnabled", { ...base, chatEnabled: true }), "On");
  eq("a toggle that is off says Off", rowValue("chatEnabled", { ...base, chatEnabled: false }), "Off");
  eq("effects at the default say Full", rowValue("vfxLevel", base), VFX_WORDS[0]);
  eq("effects at minimal say Minimal", rowValue("vfxLevel", { ...base, vfxLevel: 2 }), VFX_WORDS[2]);
  eq(
    "an effects value from a newer build falls back to the first rather than blank",
    rowValue("vfxLevel", { ...base, vfxLevel: 77 }),
    VFX_WORDS[0],
  );
  eq(
    "colour-blind mode reads its stored value",
    rowValue("colorblindMode", { ...base, colorblindMode: 3 }),
    COLORBLIND_WORDS[3],
  );
  eq(
    "the in-game keyboard reads as In-game",
    rowValue("chatKeyboard", { ...base, chatKeyboard: CHAT_KEYBOARD.IN_GAME }),
    "In-game",
  );
  eq("the phone keyboard reads as Phone", rowValue("chatKeyboard", { ...base, chatKeyboard: CHAT_KEYBOARD.PHONE }), "Phone");

  // The words follow the value through a press, for every slider and toggle, from the defaults.
  let mismatch = 0;
  for (const r of SETTING_ROWS) {
    if (r.kind !== ROW_KIND.slider && r.kind !== ROW_KIND.toggle) continue;
    const after = r.apply(base, movingStep(r, base));
    if (r.value(after) === r.value(base)) mismatch++;
  }
  eq("every slider and toggle visibly changes when pressed", mismatch, 0);
}

function rowValue(id: string, s: SaveSettings): string {
  const row = SETTING_ROWS.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row.value(s);
}

{
  const base = defaultSettings();
  const readouts = SETTING_ROWS.filter((r) => r.kind === ROW_KIND.readout);
  ok("there is at least one readout", readouts.length > 0);
  for (const r of readouts) {
    // A readout says something true and changes nothing, whichever way it is pressed.
    eq(`${r.id} changes nothing when pressed up`, settingsDiffer(base, r.apply(base, 1)), false);
    eq(`${r.id} changes nothing when pressed down`, settingsDiffer(base, r.apply(base, -1)), false);
    ok(`${r.id} still says something`, r.value(base).trim().length > 0);
  }
}

/* ---- 9. rows that switch themselves off -------------------------------------------------------- */

{
  const on = defaultSettings();
  const off = { ...on, chatEnabled: false };

  for (const id of ["chatFromNonFriends", "chatKeyboard"]) {
    const row = SETTING_ROWS.find((r) => r.id === id);
    if (row === undefined) throw new Error(`no row ${id}`);
    ok(`${id} is live while chat is on`, row.disabled?.(on) === false);
    ok(`${id} is dead while chat is off`, row.disabled?.(off) === true);
    ok(`${id} says why`, (row.disabledBecause ?? "").length > 0);
  }

  // Chat itself is never disabled by anything — it is the switch the others hang off.
  const chat = SETTING_ROWS.find((r) => r.id === "chatEnabled");
  ok("chat itself is always pressable", chat?.disabled === undefined);
}

/* ---- 10. telling whether there is anything to write ------------------------------------------- */

{
  const a = defaultSettings();
  const b = defaultSettings();
  eq("two untouched blocks are the same", settingsDiffer(a, b), false);
  eq("a copy of a block is the same", settingsDiffer(a, { ...a }), false);
  eq("one changed number is a difference", settingsDiffer(a, { ...a, masterVolume: 10 }), true);
  eq("one flipped switch is a difference", settingsDiffer(a, { ...a, autoAim: true }), true);

  // Pressing anything at all makes it worth writing.
  let unnoticed = 0;
  for (const r of SETTING_ROWS) {
    if (r.kind === ROW_KIND.readout || r.id === "howToPlay" || r.id === "deleteSave") continue;
    if (!settingsDiffer(a, r.apply(a, movingStep(r, a)))) unnoticed++;
  }
  eq("no press goes unnoticed", unnoticed, 0);
}

console.log(`settings rows: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`settings rows: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
