/**
 * The in-run HUD. Run headless: `bun packages/mobile/game/hud/hud.test.ts`
 *
 * The HUD is the only part of the game the player looks at while being chased, so its failures are the
 * ones that lose runs: a badge that moves, a colour that reads the same as another colour, a revive
 * ring on somebody who is fine, a clock that counts the wrong way. None of that is findable by playing
 * for five minutes, because all of it needs a specific party in a specific state.
 *
 * WHAT IT PROVES
 *   1. Not one coordinate is invented: change the resolved layout and every number moves with it.
 *   2. Solo draws no badges at all, and settings get the final word over the caller.
 *   3. Badges stay in seat order through downs, deaths and drops — the row never reshuffles.
 *   4. Colour and pip count both carry identity, and pip counts are all different.
 *   5. A dropped player reads as absent, not dead, so the party waits for them.
 *   6. A dead seat reads as dead even while its connection is fine.
 *   7. Down and revive timers only mean anything while a player is actually down.
 *   8. Health fractions are clamped and a dead player's bar is empty.
 *   9. The clock counts up on an endless stage and down on a limited one.
 *  10. The Reaper warning turns on a minute out and off once it has arrived.
 *  11. Six weapon cells then six passive cells, with a divider between and levels only on weapons.
 *  12. Maxed is per item kind — eight for a weapon, five for a passive.
 *  13. The pause icon is the only button, sits at the far right, and is never stolen by the stick.
 *  14. A full experience bar does not divide by zero, and a level-up waiting is visible.
 *  15. Updating a frame allocates nothing: the same arrays are reused for the life of the view.
 *  16. Reading a live-shaped run fills every field from the right seat.
 */

import { HUD_ALIGN, defaultSettings, type SaveSettings } from "../save/schema";
import { MAX_PASSIVE_LEVEL, MAX_PASSIVES } from "../sim/passives";
import { MAX_PLAYERS, PLAYER_STATE } from "../sim/player";
import { TICKS_PER_SECOND } from "../sim/waves";
import { MAX_WEAPON_LEVEL, MAX_WEAPONS } from "../sim/weapons";
import { resolveHud, type DeviceFacts } from "../settings/settings";
import {
  BADGE,
  DOWN_TICKS_TOTAL,
  LOW_HEALTH,
  PARTY_COLOUR,
  REAPER_WARNING_TICKS,
  REVIVE_TICKS_TOTAL,
  SLOT_COUNT,
  SLOT_EMPTY,
  HudView,
  createHudInput,
  readRunInto,
  touchSummonsStick,
  type HudInput,
  type RunLike,
} from "./hud";

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

function device(over: Partial<DeviceFacts> = {}): DeviceFacts {
  return { safeWidth: 390, safeHeight: 780, locale: "en-US", playerCount: 1, ...over };
}

function stored(over: Partial<SaveSettings> = {}): SaveSettings {
  return { ...defaultSettings(), ...over };
}

/** A party of `n`, everybody alive at full health, nothing carried. */
function party(n: number, over: Partial<HudInput> = {}): HudInput {
  const input = createHudInput();
  input.playerCount = n;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    input.maxHealth[i] = 100;
    input.health[i] = 100;
    input.state[i] = PLAYER_STATE.alive;
    input.connected[i] = 1;
  }
  input.downTicksTotal = DOWN_TICKS_TOTAL;
  input.reviveTicksTotal = REVIVE_TICKS_TOTAL;
  return Object.assign(input, over);
}

section("every number comes from the resolved layout, none from here");
{
  const view = new HudView();
  const small = resolveHud(stored(), device({ playerCount: 4 }));
  const large = resolveHud(
    stored({ hudTopStripScale: 180, hudSlotStripScale: 180, hudBadgeScale: 180, hudStickScale: 180 }),
    device({ playerCount: 4 }),
  );

  view.update(party(4), small);
  const a = {
    xpH: view.frame.xpBar.height,
    slotSize: view.frame.slots.size,
    divider: view.frame.slots.dividerX,
    badgeW: view.frame.badges.width,
    badgeX1: view.frame.badges.x[1] ?? 0,
    stick: view.frame.stickRadius,
    pauseRight: view.frame.pauseButton.x + view.frame.pauseButton.width,
  };
  view.update(party(4), large);
  const b = {
    xpH: view.frame.xpBar.height,
    slotSize: view.frame.slots.size,
    divider: view.frame.slots.dividerX,
    badgeW: view.frame.badges.width,
    badgeX1: view.frame.badges.x[1] ?? 0,
    stick: view.frame.stickRadius,
    pauseRight: view.frame.pauseButton.x + view.frame.pauseButton.width,
  };
  check("the experience bar grew", b.xpH > a.xpH, `${a.xpH} -> ${b.xpH}`);
  check("the slots grew", b.slotSize > a.slotSize, `${a.slotSize} -> ${b.slotSize}`);
  check("the divider moved right", b.divider > a.divider, `${a.divider} -> ${b.divider}`);
  check("the badges grew", b.badgeW > a.badgeW, `${a.badgeW} -> ${b.badgeW}`);
  check("the second badge moved", b.badgeX1 !== a.badgeX1, `${a.badgeX1} -> ${b.badgeX1}`);
  check("the stick grew", b.stick > a.stick, `${a.stick} -> ${b.stick}`);
  check("the pause icon is still hard against the right edge at both scales", b.pauseRight === 390 && a.pauseRight === 390, `${a.pauseRight} / ${b.pauseRight}`);

  // The layout editor moves the cluster; nothing in the HUD may resist it.
  const right = resolveHud(stored({ hudBadgeAlign: HUD_ALIGN.RIGHT }), device({ playerCount: 4 }));
  const left = resolveHud(stored({ hudBadgeAlign: HUD_ALIGN.LEFT }), device({ playerCount: 4 }));
  view.update(party(4), left);
  const leftX = view.frame.badges.x[0] ?? 0;
  view.update(party(4), right);
  const rightX = view.frame.badges.x[0] ?? 0;
  check("right-aligned badges start further right than left-aligned ones", rightX > leftX, `${leftX} vs ${rightX}`);

  const floating = resolveHud(
    stored({ hudBadgesDocked: false, hudBadgeX: 40, hudBadgeY: 70 }),
    device({ playerCount: 4 }),
  );
  view.update(party(4), floating);
  check("a dragged cluster is drawn where it was dragged", (view.frame.badges.y[0] ?? 0) === floating.badges.y);
}

section("solo has no party row");
{
  const view = new HudView();
  const solo = resolveHud(stored(), device({ playerCount: 1 }));
  view.update(party(1), solo);
  check("no badges are drawn", view.frame.badges.count === 0);

  // A caller asking for four badges on a layout that says badges are invisible must not get them:
  // the settings are the authority, not the caller.
  view.update(party(4), solo);
  check("settings override a caller that asks anyway", view.frame.badges.count === 0);

  const four = resolveHud(stored(), device({ playerCount: 4 }));
  view.update(party(1), four);
  check("and one player draws nothing even on a party layout", view.frame.badges.count === 0);
}

section("the row never reshuffles");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 4 }));
  const input = party(4);
  view.update(input, hud);
  const before = Array.from(view.frame.badges.x.slice(0, 4));

  input.state[1] = PLAYER_STATE.downed;
  input.state[2] = PLAYER_STATE.dead;
  input.connected[3] = 0;
  view.update(input, hud);
  const after = Array.from(view.frame.badges.x.slice(0, 4));
  check("positions are unchanged by downs, deaths and drops", before.join() === after.join(), after.join());
  check("all four are still drawn", view.frame.badges.count === 4);
  check("seat 0 is still the local one", (view.frame.badges.isLocal[0] ?? 0) === 1);
  check("and only seat 0", (view.frame.badges.isLocal[1] ?? 1) === 0 && (view.frame.badges.isLocal[3] ?? 1) === 0);

  // Playing on somebody else's party: the highlight follows the seat, not the order.
  input.localSlot = 2;
  view.update(input, hud);
  check("a guest highlights its own seat", (view.frame.badges.isLocal[2] ?? 0) === 1);
  check("and not the host's", (view.frame.badges.isLocal[0] ?? 1) === 0);
}

section("identity is carried twice");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 4 }));
  view.update(party(4), hud);
  const pips = Array.from(view.frame.badges.pipCount.slice(0, 4));
  const colours = Array.from(view.frame.badges.colour.slice(0, 4));
  check("pip counts are 1,2,3,4", pips.join() === "1,2,3,4", pips.join());
  check("no two seats share a pip count", new Set(pips).size === 4);
  check("colour index is the seat", colours.join() === "0,1,2,3", colours.join());
  check("there is a colour defined for every seat", PARTY_COLOUR.length >= MAX_PLAYERS);
  check("no two seats share a colour", new Set(PARTY_COLOUR.slice(0, MAX_PLAYERS)).size === MAX_PLAYERS);
}

section("a dropped player is absent, not dead");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 3 }));
  const input = party(3);
  input.connected[1] = 0;
  input.health[1] = 60;
  view.update(input, hud);
  check("the silent seat reads absent", (view.frame.badges.state[1] ?? -1) === BADGE.absent);
  check("their health is still shown", Math.abs((view.frame.badges.health[1] ?? 0) - 0.6) < 1e-6);
  const codes = Object.values(BADGE) as number[];
  check("all four badge states are distinct codes", new Set(codes).size === codes.length && codes.length === 4);
  check("the others are unaffected", (view.frame.badges.state[0] ?? -1) === BADGE.alive);

  // Dead beats connected: a seat whose player is gone reads gone even on a perfect connection.
  input.state[2] = PLAYER_STATE.dead;
  input.health[2] = 0;
  view.update(input, hud);
  check("a dead seat reads dead", (view.frame.badges.state[2] ?? -1) === BADGE.dead);
  check("with an empty bar", (view.frame.badges.health[2] ?? -1) === 0);

  // And dead while also disconnected is still dead — there is nothing to wait for.
  input.connected[2] = 0;
  view.update(input, hud);
  check("dead and disconnected is dead", (view.frame.badges.state[2] ?? -1) === BADGE.dead);
}

section("down and revive rings only exist while someone is down");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 2 }));
  const input = party(2);
  input.state[1] = PLAYER_STATE.downed;
  input.downTicks[1] = Math.floor(DOWN_TICKS_TOTAL / 4);
  input.reviveTicks[1] = Math.floor(REVIVE_TICKS_TOTAL / 2);
  view.update(input, hud);
  check("downed reads downed", (view.frame.badges.state[1] ?? -1) === BADGE.downed);
  check("the timer counts down toward zero", Math.abs((view.frame.badges.downRemaining[1] ?? 0) - 0.25) < 1e-6);
  check("revive progress is half done", Math.abs((view.frame.badges.reviveProgress[1] ?? 0) - 0.5) < 1e-6);
  check("a downed player's bar is empty", (view.frame.badges.health[1] ?? -1) === 0);

  // Rescued. The stale tick counts are still sitting in the arrays; nothing must draw from them.
  input.state[1] = PLAYER_STATE.alive;
  input.health[1] = 40;
  view.update(input, hud);
  check("no revive ring on a rescued player", (view.frame.badges.reviveProgress[1] ?? -1) === 0);
  check("no down timer either", (view.frame.badges.downRemaining[1] ?? -1) === 0);
  check("their health is back on the bar", Math.abs((view.frame.badges.health[1] ?? 0) - 0.4) < 1e-6);
}

section("health fractions are clamped and honest");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 2 }));
  const input = party(2);
  input.health[0] = 250;
  view.update(input, hud);
  check("overhealing does not overflow the bar", view.frame.healthFraction === 1);

  input.health[0] = -7;
  view.update(input, hud);
  check("negative health reads as empty", view.frame.healthFraction === 0);
  check("and is not reported as urgent", view.frame.healthLow === false);

  input.health[0] = 100 * LOW_HEALTH * 0.5;
  view.update(input, hud);
  check("a nearly-dead player is urgent", view.frame.healthLow === true);

  input.health[0] = 90;
  view.update(input, hud);
  check("a healthy player is not", view.frame.healthLow === false);

  input.maxHealth[0] = 0;
  view.update(input, hud);
  check("a zero maximum does not produce a NaN bar", view.frame.healthFraction === 0);

  input.maxHealth[0] = 100;
  input.state[0] = PLAYER_STATE.dead;
  input.health[0] = 55;
  view.update(input, hud);
  check("a dead local player shows no health, whatever the array says", view.frame.health === 0);
}

section("the clock counts the way the stage does");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device());
  const input = party(1);
  input.runTicks = 95 * TICKS_PER_SECOND;
  view.update(input, hud);
  check("endless counts up", view.frame.clockCountsDown === false);
  check("1:35 after 95 seconds", view.frame.clockMinutes === 1 && view.frame.clockSeconds === 35);

  input.timeLimitTicks = 30 * 60 * TICKS_PER_SECOND;
  view.update(input, hud);
  check("a limited stage counts down", view.frame.clockCountsDown === true);
  check("28:25 left of thirty minutes", view.frame.clockMinutes === 28 && view.frame.clockSeconds === 25);

  input.runTicks = input.timeLimitTicks + 500;
  view.update(input, hud);
  check("it never goes negative", view.frame.clockMinutes === 0 && view.frame.clockSeconds === 0);

  input.runTicks = -50;
  view.update(input, hud);
  check("a nonsense clock does not throw", view.frame.clockSeconds >= 0);
}

section("the Reaper warning");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device());
  const input = party(1);
  input.reaperAtTicks = 30 * 60 * TICKS_PER_SECOND;

  input.runTicks = 60 * TICKS_PER_SECOND;
  view.update(input, hud);
  check("silent twenty-nine minutes out", view.frame.reaperWarning === false);
  check("but the countdown is available", view.frame.reaperInTicks > 0);

  input.runTicks = input.reaperAtTicks - REAPER_WARNING_TICKS + 1;
  view.update(input, hud);
  check("warning inside the last minute", view.frame.reaperWarning === true);

  input.runTicks = input.reaperAtTicks;
  view.update(input, hud);
  check("the countdown stops once it is here", view.frame.reaperInTicks === -1);
  check("and the warning stops with it", view.frame.reaperWarning === false);

  input.reaperAtTicks = -1;
  input.runTicks = 100;
  view.update(input, hud);
  check("a stage without one says nothing", view.frame.reaperInTicks === -1 && view.frame.reaperWarning === false);
}

section("twelve cells: six weapons, a divider, six passives");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 2 }));
  const input = party(2);
  input.localSlot = 1;
  const wBase = 1 * MAX_WEAPONS;
  const pBase = 1 * MAX_PASSIVES;
  input.weaponType[wBase] = 3;
  input.weaponLevel[wBase] = MAX_WEAPON_LEVEL;
  input.weaponType[wBase + 1] = 7;
  input.weaponLevel[wBase + 1] = 2;
  input.passiveType[pBase] = 4;
  input.passiveLevel[pBase] = MAX_PASSIVE_LEVEL;
  input.passiveType[pBase + 1] = 9;
  input.passiveLevel[pBase + 1] = 1;
  view.update(input, hud);

  const s = view.frame.slots;
  check("there are twelve cells", s.type.length === SLOT_COUNT && SLOT_COUNT === MAX_WEAPONS + MAX_PASSIVES);
  check("the guest's own weapons are shown, not the host's", s.type[0] === 3 && s.type[1] === 7);
  check("passives start at cell six", s.type[MAX_WEAPONS] === 4 && s.type[MAX_WEAPONS + 1] === 9);
  check("empty cells are empty", s.type[5] === SLOT_EMPTY && s.type[SLOT_COUNT - 1] === SLOT_EMPTY);
  check("an empty cell has no level", s.level[5] === 0);
  check("a maxed weapon is flagged at eight", (s.maxed[0] ?? 0) === 1);
  check("an unmaxed one is not", (s.maxed[1] ?? 1) === 0);
  check("a maxed passive is flagged at five, not eight", (s.maxed[MAX_WEAPONS] ?? 0) === 1);
  check("an unmaxed passive is not", (s.maxed[MAX_WEAPONS + 1] ?? 1) === 0);
  check("only weapons show a level number", (s.showsLevel[0] ?? 0) === 1 && (s.showsLevel[MAX_WEAPONS] ?? 1) === 0);

  let ordered = true;
  for (let i = 1; i < SLOT_COUNT; i++) if ((s.x[i] ?? 0) <= (s.x[i - 1] ?? 0)) ordered = false;
  check("cells run left to right without overlapping", ordered);
  check("the divider is after the sixth weapon", s.dividerX >= (s.x[MAX_WEAPONS - 1] ?? 0) + s.size);
  check("and before the first passive", s.dividerX < (s.x[MAX_WEAPONS] ?? 0));
}

section("the pause icon is the only button in a run");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device());
  view.update(party(1), hud);
  const p = view.frame.pauseButton;
  check("it is inside the status strip", p.y === hud.statusStrip.y && p.height === hud.statusStrip.height);
  check("it is at the far right", Math.abs(p.x + p.width - (hud.statusStrip.x + hud.statusStrip.width)) < 1e-6);
  check("it is square", p.width === p.height);

  check("a touch in the fight summons the stick", touchSummonsStick(200, 600, hud, p) === true);
  check("a touch in the top block does not", touchSummonsStick(200, 2, hud, p) === false);
  check("nor does a touch on the pause icon", touchSummonsStick(p.x + 1, p.y + 1, hud, p) === false);
  check("a touch off the left edge does not", touchSummonsStick(-5, 600, hud, p) === false);
  check("a touch below the screen does not", touchSummonsStick(200, 10_000, hud, p) === false);
  check("the very bottom row still counts", touchSummonsStick(200, hud.stickZone.y + hud.stickZone.height - 1, hud, p) === true);
}

section("the experience bar");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device());
  const input = party(1);
  input.xp = 3;
  input.xpToNext = 12;
  view.update(input, hud);
  check("a quarter of the way is a quarter of the bar", Math.abs(view.frame.xpFraction - 0.25) < 1e-6);
  check("it spans the whole screen width", view.frame.xpBar.width === 390 && view.frame.xpBar.x === 0);

  input.xpToNext = 0;
  view.update(input, hud);
  check("a costless level is a full bar, not a divide by zero", view.frame.xpFraction === 1);

  input.xpToNext = 10;
  input.xp = 99;
  view.update(input, hud);
  check("banked experience does not overflow the bar", view.frame.xpFraction === 1);

  input.pendingLevels = 3;
  view.update(input, hud);
  check("waiting level-ups are visible", view.frame.levelPending === true);
  input.pendingLevels = 0;
  view.update(input, hud);
  check("and gone once they are spent", view.frame.levelPending === false);
}

section("a frame costs no allocations");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 4 }));
  const input = party(4);
  const first = view.frame;
  const slotX = view.frame.slots.x;
  const badgeState = view.frame.badges.state;
  const xpBar = view.frame.xpBar;
  for (let i = 0; i < 200; i++) {
    input.runTicks = i * 7;
    input.health[i % MAX_PLAYERS] = 1 + (i % 90);
    view.update(input, hud);
  }
  check("the frame object is the same one", view.frame === first);
  check("the slot positions are the same array", view.frame.slots.x === slotX);
  check("the badge states are the same array", view.frame.badges.state === badgeState);
  check("even the rectangles are reused", view.frame.xpBar === xpBar);
}

section("reading a live run");
{
  const view = new HudView();
  const hud = resolveHud(stored(), device({ playerCount: 3 }));
  const run: RunLike = {
    runTicks: 12 * TICKS_PER_SECOND,
    timeLimitTicks: 0,
    kills: 431,
    prog: { level: 14, xp: 30, xpToNext: 60, pending: 2, gold: 1250 },
    players: {
      count: 3,
      health: Float32Array.from([80, 0, 45, 0]),
      state: Int32Array.from([PLAYER_STATE.alive, PLAYER_STATE.downed, PLAYER_STATE.alive, PLAYER_STATE.dead]),
      downTicks: Int32Array.from([0, 300, 0, 0]),
      reviveTicks: Int32Array.from([0, 60, 0, 0]),
    },
    stats: { get: () => 1 },
    weapons: { typeIndex: new Int32Array(MAX_PLAYERS * MAX_WEAPONS).fill(SLOT_EMPTY), level: new Int32Array(MAX_PLAYERS * MAX_WEAPONS) },
    passives: { typeIndex: new Int32Array(MAX_PLAYERS * MAX_PASSIVES).fill(SLOT_EMPTY), level: new Int32Array(MAX_PLAYERS * MAX_PASSIVES) },
  };
  run.weapons.typeIndex[2 * MAX_WEAPONS] = 5;
  run.weapons.level[2 * MAX_WEAPONS] = 3;

  const connected = Uint8Array.from([1, 1, 0, 1]);
  const characters = Uint8Array.from([2, 5, 9, 0]);
  const input = readRunInto(run, 2, 120, connected, characters, 30 * 60 * TICKS_PER_SECOND, createHudInput());

  check("the party size came across", input.playerCount === 3);
  check("gold and kills came across", input.gold === 1250 && input.kills === 431);
  check("the shared level came across", input.level === 14 && input.pendingLevels === 2);

  view.update(input, hud);
  check("the local seat's own weapon is in cell zero", view.frame.slots.type[0] === 5);
  check("the local seat's health is drawn, not seat zero's", Math.abs(view.frame.healthFraction - 45 / 120) < 1e-6);
  check("the downed guest reads downed", (view.frame.badges.state[1] ?? -1) === BADGE.downed);
  check("the local seat reads absent when its own link is down", (view.frame.badges.state[2] ?? -1) === BADGE.absent);
  check("character art came from the party layer", (view.frame.badges.characterId[1] ?? 0) === 5);
  check("only three badges, though four seats exist in the arrays", view.frame.badges.count === 3);
  check("the Reaper countdown is set from the caller", view.frame.reaperInTicks === 30 * 60 * TICKS_PER_SECOND - 12 * TICKS_PER_SECOND);

  // A caller passing a seat the run does not have must not read past the party.
  const wild = readRunInto(run, 9, 120, connected, characters, -1, createHudInput());
  check("an impossible seat is clamped into the party", wild.localSlot === 2);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
