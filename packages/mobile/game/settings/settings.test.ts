/**
 * Resolved settings. Run headless: `bun packages/mobile/game/settings/settings.test.ts`
 *
 * This layer is the one place that decides what a stored choice actually means, so it is the one place
 * where a wrong answer shows up as "the setting doesn't stick" on a screen that never made the decision.
 * It is pure functions over plain data, which is exactly why it can be tested by calling it.
 *
 * WHAT IT PROVES
 *   1. The phone keyboard is the default, and a latin-language player who asks for ours gets ours.
 *   2. A player whose language ours cannot type gets the working keyboard, and is told why.
 *   3. Junk, empty and unknown locales never throw and always land on the working keyboard.
 *   4. Hearing strangers is impossible while chat itself is off.
 *   5. Battery saver only ever trims: it halves intensities, caps the frame rate, and never adds effects.
 *   6. Every scale and the stick radius are clamped, so a layout editor cannot produce a 4-point control.
 *   7. Docked badges land where the alignment says, to the point, on a known screen width.
 *   8. Undocked badges come from the dragged percentages and are still fully on screen.
 *   9. Solo hides badges; a party keeps its cluster width when someone drops.
 *  10. The three top bands stack from the top edge and the stick zone owns everything below them.
 *  11. Resetting the layout restores every layout field and touches nothing else.
 *  12. The daily reminder is asked on the second run, once, ever.
 */

import { CHAT_KEYBOARD, FRAME_RATE_MODE, HUD_ALIGN, defaultSettings, type SaveSettings } from "../save/schema";
import { DYNAMIC_TARGET_FPS } from "../core/frame-gate";
import {
  BATTERY_SAVER_FPS,
  HIGH_FPS,
  HUD_BASE,
  INTENSITY_MAX,
  NORMAL_FPS,
  PASSIVE_SLOTS,
  SCALE_MAX,
  SCALE_MIN,
  STICK_MAX,
  STICK_MIN,
  WEAPON_SLOTS,
  type DeviceFacts,
  fpsForMode,
  inGameKeyboardSupports,
  languageOf,
  resetLayout,
  resolve,
  resolveHud,
  shouldAskDailyReminder,
} from "./settings";

let failures = 0;

function check(what: string, ok: boolean, extra = ""): void {
  if (ok) {
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${extra === "" ? "" : ` — ${extra}`}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** A phone-shaped safe area. Chosen so the docked-badge arithmetic below is checkable by hand. */
function device(over: Partial<DeviceFacts> = {}): DeviceFacts {
  return { safeWidth: 400, safeHeight: 800, locale: "en-US", playerCount: 1, ...over };
}

function stored(over: Partial<SaveSettings> = {}): SaveSettings {
  return { ...defaultSettings(), ...over };
}

/* ---------------------------------------------------------------------------------------------- */
section("the keyboard the player actually gets");
{
  const r = resolve(stored(), device());
  check("default is the phone keyboard", r.chatKeyboard === CHAT_KEYBOARD.PHONE);
  check("and nothing was overridden", r.chatKeyboardForced === false);

  const ours = resolve(stored({ chatKeyboard: CHAT_KEYBOARD.IN_GAME }), device({ locale: "en-GB" }));
  check("an English player who asks for ours gets ours", ours.chatKeyboard === CHAT_KEYBOARD.IN_GAME);
  check("and is not told it was forced", ours.chatKeyboardForced === false);

  const pt = resolve(stored({ chatKeyboard: CHAT_KEYBOARD.IN_GAME }), device({ locale: "pt-BR" }));
  check("so does a Brazilian Portuguese player", pt.chatKeyboard === CHAT_KEYBOARD.IN_GAME);

  const phone = resolve(stored({ chatKeyboard: CHAT_KEYBOARD.PHONE }), device({ locale: "en-US" }));
  check("asking for the phone keyboard never gets ours", phone.chatKeyboard === CHAT_KEYBOARD.PHONE);
  check("and that is not a forced override either", phone.chatKeyboardForced === false);
}

section("languages our keyboard cannot type");
{
  for (const locale of ["ja-JP", "zh-CN", "ru-RU", "ar", "ko-KR", "el-GR", "he-IL", "th-TH", "hi-IN"]) {
    const r = resolve(stored({ chatKeyboard: CHAT_KEYBOARD.IN_GAME }), device({ locale }));
    check(`${locale} is pushed to the phone keyboard`, r.chatKeyboard === CHAT_KEYBOARD.PHONE);
    check(`${locale} is told the choice was overridden`, r.chatKeyboardForced === true);
    check(`${locale} is not claimed as supported`, inGameKeyboardSupports(locale) === false);
  }
}

section("locales that are not really locales");
{
  for (const locale of ["", "   ", "-", "zz", "!!!", "en_US", "1234", "----x"]) {
    let threw = false;
    let keyboard = -1;
    try {
      keyboard = resolve(stored({ chatKeyboard: CHAT_KEYBOARD.IN_GAME }), device({ locale })).chatKeyboard;
    } catch {
      threw = true;
    }
    check(`"${locale}" does not throw`, threw === false);
    check(`"${locale}" falls back to the working keyboard`, keyboard === CHAT_KEYBOARD.PHONE);
  }
  check("the language part of a tag is lowercased", languageOf("PT-br") === "pt");
  check("a bare tag is its own language", languageOf("de") === "de");
  check("surrounding space is ignored", languageOf("  fr-CA ") === "fr");
  check("an empty tag gives an empty language", languageOf("") === "");
  check("an unknown language is unsupported, not assumed", inGameKeyboardSupports("zz-ZZ") === false);
}

section("chat switches, where the narrower one cannot outrank the broader one");
{
  const off = resolve(stored({ chatEnabled: false, chatFromNonFriends: true }), device());
  check("chat off means chat off", off.chatEnabled === false);
  check("and strangers are silent regardless of the other switch", off.chatFromNonFriends === false);

  const on = resolve(stored({ chatEnabled: true, chatFromNonFriends: true }), device());
  check("chat on with strangers allowed resolves to both", on.chatEnabled && on.chatFromNonFriends);

  const friends = resolve(stored({ chatEnabled: true, chatFromNonFriends: false }), device());
  check("friends-only keeps chat on", friends.chatEnabled === true);
  check("and keeps strangers out", friends.chatFromNonFriends === false);
}

section("battery saver only ever takes away");
{
  // Pin the frame-rate mode to 60 here so this section is only about the intensity/vfx trimming; the
  // frame-rate resolution has its own section below.
  const base = stored({ damageNumbers: 100, screenFlash: 60, screenShake: 21, vfxLevel: 0, frameRateMode: FRAME_RATE_MODE.HZ_60 });
  const normal = resolve(base, device());
  check("with it off, intensities are the player's own", normal.damageNumbers === 100);
  check("an odd value is untouched when it is off", normal.screenShake === 21);
  check("frame rate is what the player chose", normal.targetFps === NORMAL_FPS);
  check("effect level is what the player chose", normal.vfxLevel === 0);

  const saved = resolve({ ...base, batterySaver: true }, device());
  check("with it on, intensity is halved", saved.damageNumbers === 50);
  check("halving rounds rather than truncating oddly", saved.screenShake === 11, `${saved.screenShake}`);
  check("the other slider halves too", saved.screenFlash === 30);
  check("frame rate is capped at half", saved.targetFps === BATTERY_SAVER_FPS);
  check("effects are reduced at least one step", saved.vfxLevel >= 1);
  check("no intensity ever came out higher", saved.screenFlash <= normal.screenFlash);

  const already = resolve(stored({ vfxLevel: 2, batterySaver: true }), device());
  check("a player already at minimal effects is not walked back up", already.vfxLevel === 2);

  const zero = resolve(stored({ screenShake: 0, batterySaver: true }), device());
  check("off stays off — saver never adds an effect back", zero.screenShake === 0);

  const wild = resolve(stored({ damageNumbers: 400, screenFlash: -50, colorblindMode: 9 }), device());
  check("a slider above the range is capped", wild.damageNumbers === INTENSITY_MAX);
  check("a negative slider is floored at zero", wild.screenFlash === 0);
  check("an out-of-range colourblind mode is clamped", wild.colorblindMode === 3);
}

section("the frame-rate mode resolves to a render cap the sim never sees");
{
  // The mode maps straight to a cap, with DYNAMIC as the uncapped sentinel the render loop reads as
  // "follow the display". The simulation is 60Hz regardless of any of these.
  check("60 resolves to 60", fpsForMode(FRAME_RATE_MODE.HZ_60) === NORMAL_FPS);
  check("120 resolves to 120", fpsForMode(FRAME_RATE_MODE.HZ_120) === HIGH_FPS);
  check("dynamic resolves to the uncapped sentinel", fpsForMode(FRAME_RATE_MODE.DYNAMIC) === DYNAMIC_TARGET_FPS);
  check("an unknown mode falls back to dynamic, never to a fixed cap", fpsForMode(99) === DYNAMIC_TARGET_FPS);

  const at60 = resolve(stored({ frameRateMode: FRAME_RATE_MODE.HZ_60 }), device());
  check("resolve carries a 60 choice to targetFps", at60.targetFps === NORMAL_FPS);
  const at120 = resolve(stored({ frameRateMode: FRAME_RATE_MODE.HZ_120 }), device());
  check("resolve carries a 120 choice to targetFps", at120.targetFps === HIGH_FPS);
  const dyn = resolve(stored({ frameRateMode: FRAME_RATE_MODE.DYNAMIC }), device());
  check("resolve carries dynamic through as the uncapped sentinel", dyn.targetFps === DYNAMIC_TARGET_FPS);
  check("the shipped default is dynamic", resolve(stored(), device()).targetFps === DYNAMIC_TARGET_FPS);

  // Battery saver CAPS to 30 and never raises — even from a 120 choice, and even from DYNAMIC, which is
  // otherwise the highest of all.
  const saver120 = resolve(stored({ frameRateMode: FRAME_RATE_MODE.HZ_120, batterySaver: true }), device());
  check("battery saver caps a 120 choice to 30", saver120.targetFps === BATTERY_SAVER_FPS);
  const saverDyn = resolve(stored({ frameRateMode: FRAME_RATE_MODE.DYNAMIC, batterySaver: true }), device());
  check("battery saver caps dynamic to 30 too", saverDyn.targetFps === BATTERY_SAVER_FPS);
  const saver60 = resolve(stored({ frameRateMode: FRAME_RATE_MODE.HZ_60, batterySaver: true }), device());
  check("battery saver never raises a 60 choice above 30", saver60.targetFps === BATTERY_SAVER_FPS);
}

section("the plain pass-through switches");
{
  const r = resolve(
    stored({ autoAim: true, insectFreeSprites: true, speedrunToolkit: true, colorblindMode: 2 }),
    device(),
  );
  check("auto-aim carries through", r.autoAim === true);
  check("insect-free sprites carry through", r.insectFreeSprites === true);
  check("the speedrun overlay carries through", r.speedrunToolkit === true);
  check("the colourblind palette carries through", r.colorblindMode === 2);

  const d = resolve(stored(), device());
  check("auto-aim is off unless asked for", d.autoAim === false);
  check("insect-free sprites are off by default", d.insectFreeSprites === false);
  check("the speedrun overlay is off by default", d.speedrunToolkit === false);
}

section("scales and the stick are clamped");
{
  const tiny = resolveHud(
    stored({
      hudTopStripScale: 1,
      hudSlotStripScale: 0,
      hudBadgeScale: -400,
      hudStickScale: 5,
      joystickSize: 64,
    }),
    device({ playerCount: 2 }),
  );
  const floor = SCALE_MIN / 100;
  check("the top block cannot shrink past the floor", tiny.statusStrip.height === Math.round(HUD_BASE.statusStripHeight * floor));
  check("nor can a slot", tiny.slotSize === Math.round(HUD_BASE.slotSize * floor));
  check("nor can a badge", tiny.badges.width === Math.round(HUD_BASE.badgeWidth * floor));
  check("the stick never goes below its minimum", tiny.stickRadius === STICK_MIN, `${tiny.stickRadius}`);
  check("gaps never collapse to nothing", tiny.slotGap >= 1 && tiny.dividerWidth >= 2);

  const huge = resolveHud(
    stored({
      hudTopStripScale: 9000,
      hudSlotStripScale: 500,
      hudBadgeScale: 500,
      hudStickScale: 500,
      joystickSize: 120,
    }),
    device({ playerCount: 2 }),
  );
  const ceil = SCALE_MAX / 100;
  check("the top block cannot grow past the ceiling", huge.statusStrip.height === Math.round(HUD_BASE.statusStripHeight * ceil));
  check("nor can a slot", huge.slotSize === Math.round(HUD_BASE.slotSize * ceil));
  check("the stick never goes above its maximum", huge.stickRadius === STICK_MAX, `${huge.stickRadius}`);

  const nan = resolveHud(stored({ hudTopStripScale: Number.NaN, joystickSize: Number.NaN }), device());
  check("nonsense numbers do not produce nonsense geometry", Number.isFinite(nan.statusStrip.height));
  check("nor a nonsense stick", Number.isFinite(nan.stickRadius) && nan.stickRadius >= STICK_MIN);
}

section("docked badges land exactly where the alignment says");
{
  const dev = device({ playerCount: 4 });
  const left = resolveHud(stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.LEFT }), dev);
  const w = HUD_BASE.badgeWidth;
  const gap = HUD_BASE.badgeGap;
  const cluster = w * 4 + gap * 3;
  check("left sits one pad in from the edge", left.badges.x === HUD_BASE.edgePad, `${left.badges.x}`);

  const centre = resolveHud(stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.CENTRE }), dev);
  check("centre is the screen middle minus half the cluster", centre.badges.x === Math.round((400 - cluster) / 2), `${centre.badges.x}`);

  const right = resolveHud(stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.RIGHT }), dev);
  check("right ends one pad from the far edge", right.badges.x === 400 - cluster - HUD_BASE.edgePad, `${right.badges.x}`);
  check("right never runs off the screen", right.badges.x + cluster <= 400);

  check("docked badges are fused to the bottom of the slot strip", left.badges.y === left.slotStrip.y + left.slotStrip.height);
  check("the resolved geometry says it is docked", left.badgesDocked === true);

  const narrow = resolveHud(
    stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.RIGHT, hudBadgeScale: SCALE_MAX }),
    device({ playerCount: 4, safeWidth: 200 }),
  );
  check("a cluster wider than the screen is pinned to the left edge, not pushed off", narrow.badges.x === 0, `${narrow.badges.x}`);
}

section("undocked badges come from the drag, and stay on screen");
{
  const dev = device({ playerCount: 2, safeWidth: 400, safeHeight: 800 });
  const mid = resolveHud(stored({ hudBadgesDocked: false, hudBadgeX: 25, hudBadgeY: 50 }), dev);
  check("a quarter across the screen is a quarter across", mid.badges.x === 100, `${mid.badges.x}`);
  check("halfway down is halfway down", mid.badges.y === 400, `${mid.badges.y}`);
  check("the resolved geometry says it is floating", mid.badgesDocked === false);

  const far = resolveHud(stored({ hudBadgesDocked: false, hudBadgeX: 100, hudBadgeY: 100 }), dev);
  const cluster = far.badges.width * 2 + Math.max(1, HUD_BASE.badgeGap);
  check("dragged to the far right, the whole cluster is still visible", far.badges.x + cluster <= 400, `${far.badges.x}`);
  check("dragged to the bottom, the badge is still visible", far.badges.y + far.badges.height <= 800, `${far.badges.y}`);

  const above = resolveHud(stored({ hudBadgesDocked: false, hudBadgeX: 0, hudBadgeY: 0 }), dev);
  check("badges never hide behind the top block", above.badges.y >= above.slotStrip.y + above.slotStrip.height, `${above.badges.y}`);
  check("and never off the left edge", above.badges.x >= 0);
}

section("solo has no badges, and a party keeps its width when someone drops");
{
  const solo = resolveHud(stored(), device({ playerCount: 1 }));
  check("solo draws no badges at all", solo.badgesVisible === false);
  const duo = resolveHud(stored(), device({ playerCount: 2 }));
  check("two players do", duo.badgesVisible === true);
  check("so do four", resolveHud(stored(), device({ playerCount: 4 })).badgesVisible === true);

  // playerCount is the size of the party, not the number still standing, so alignment cannot shift when
  // somebody dies or drops mid-fight. A row that re-centres itself is a row you have to re-find.
  const fourCentred = resolveHud(
    stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.CENTRE }),
    device({ playerCount: 4 }),
  );
  const stillFour = resolveHud(
    stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.CENTRE }),
    device({ playerCount: 4 }),
  );
  check("the same party resolves to the same place every time", fourCentred.badges.x === stillFour.badges.x);
  const threeCentred = resolveHud(
    stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.CENTRE }),
    device({ playerCount: 3 }),
  );
  check("a smaller party is a genuinely different cluster", threeCentred.badges.x !== fourCentred.badges.x);
}

section("the top block stacks and the fight gets everything below it");
{
  const hud = resolveHud(stored(), device({ playerCount: 1, safeHeight: 800 }));
  check("the XP bar is at the very top edge", hud.xpBar.y === 0);
  check("and spans the full width with no padding", hud.xpBar.width === 400 && hud.xpBar.x === 0);
  check("the status strip sits directly under it", hud.statusStrip.y === hud.xpBar.height);
  check("the slot strip sits directly under that", hud.slotStrip.y === hud.xpBar.height + hud.statusStrip.height);
  check("nothing overlaps", hud.slotStrip.y >= hud.statusStrip.y + hud.statusStrip.height);
  check("the stick zone begins where the top block ends", hud.stickZone.y === hud.slotStrip.y + hud.slotStrip.height);
  check("and runs to the bottom of the screen", hud.stickZone.y + hud.stickZone.height === 800);
  check("the fight is most of the screen", hud.stickZone.height > 800 * 0.8, `${hud.stickZone.height}`);
  check("the whole top block is a thin band", hud.stickZone.y < 80, `${hud.stickZone.y}`);
  check("twelve slots plus a divider fit across the screen", WEAPON_SLOTS + PASSIVE_SLOTS === 12
    && (hud.slotSize + hud.slotGap) * 12 + hud.dividerWidth <= 400);

  const squashed = resolveHud(stored({ hudTopStripScale: SCALE_MAX, hudSlotStripScale: SCALE_MAX }), device({ safeHeight: 60 }));
  check("on an absurdly short screen the stick zone still exists", squashed.stickZone.height >= 1);
  check("and stays inside the screen", squashed.stickZone.y <= 59, `${squashed.stickZone.y}`);
}

section("resetting the layout, and nothing else");
{
  const messed = stored({
    joystickSize: 130,
    joystickX: 90,
    joystickY: 5,
    hudScale: 170,
    hudBadgesDocked: false,
    hudBadgeAlign: HUD_ALIGN.RIGHT,
    hudBadgeX: 99,
    hudBadgeY: 99,
    hudTopStripScale: 175,
    hudSlotStripScale: 61,
    hudBadgeScale: 180,
    hudStickScale: 140,
    // Not layout: these must survive the reset.
    masterVolume: 12,
    musicVolume: 0,
    screenShake: 15,
    chatEnabled: false,
    chatKeyboard: CHAT_KEYBOARD.IN_GAME,
    dailyReminderAsked: true,
    telemetryOptIn: true,
    autoAim: true,
  });
  const back = resetLayout(messed);
  const d = defaultSettings();
  const layoutKeys = [
    "joystickSize", "joystickX", "joystickY", "hudScale", "hudBadgesDocked", "hudBadgeAlign",
    "hudBadgeX", "hudBadgeY", "hudTopStripScale", "hudSlotStripScale", "hudBadgeScale", "hudStickScale",
  ] as const;
  for (const key of layoutKeys) {
    check(`${key} is back to default`, back[key] === d[key], `${String(back[key])} vs ${String(d[key])}`);
  }
  check("sound is untouched", back.masterVolume === 12 && back.musicVolume === 0);
  check("comfort sliders are untouched", back.screenShake === 15);
  check("the chat switch is untouched", back.chatEnabled === false);
  check("the keyboard choice is untouched", back.chatKeyboard === CHAT_KEYBOARD.IN_GAME);
  check("opt-ins are untouched", back.telemetryOptIn === true && back.dailyReminderAsked === true);
  check("auto-aim is untouched", back.autoAim === true);
  check("the original was not modified in place", messed.hudBadgeX === 99 && messed.hudStickScale === 140);
  check("a reset profile resolves to the docked default", resolveHud(back, device({ playerCount: 2 })).badgesDocked === true);
}

section("the daily reminder is asked on day two, once, ever");
{
  const fresh = stored();
  check("never on the first launch", shouldAskDailyReminder(fresh, 0) === false);
  check("not after one run either", shouldAskDailyReminder(fresh, 1) === false);
  check("asked on the second run", shouldAskDailyReminder(fresh, 2) === true);
  check("still asked later if it somehow never happened", shouldAskDailyReminder(fresh, 40) === true);
  const asked = stored({ dailyReminderAsked: true });
  check("never asked again once it has been asked", shouldAskDailyReminder(asked, 2) === false);
  check("not even hundreds of runs later", shouldAskDailyReminder(asked, 900) === false);
  check("and the answer itself does not gate the question", shouldAskDailyReminder(stored({ dailyReminderOptIn: true }), 2) === true);
}

section("resolve returns the same geometry resolveHud does");
{
  const s = stored({ hudBadgesDocked: true, hudBadgeAlign: HUD_ALIGN.CENTRE, hudBadgeScale: 120 });
  const dev = device({ playerCount: 3 });
  const whole = resolve(s, dev);
  const just = resolveHud(s, dev);
  check("badge position agrees", whole.hud.badges.x === just.badges.x && whole.hud.badges.y === just.badges.y);
  check("slot size agrees", whole.hud.slotSize === just.slotSize);
  check("the stick zone agrees", whole.hud.stickZone.y === just.stickZone.y);
  check("badge visibility agrees", whole.hud.badgesVisible === just.badgesVisible);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
