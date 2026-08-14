/**
 * Hand-off self-check. Run headless: `bun packages/mobile/game/save/handoff.test.ts`
 *
 * The whole point of the hand-off is two guarantees, and this file exists to make both of them provable
 * rather than merely intended:
 *
 *   1. A run is banked EXACTLY ONCE. Re-staging the same run pays nothing more, and it changes nothing at
 *      all — not the gold, not the run counters, not the record. A duplicate stage is reported, never
 *      thrown, because crashing on the results screen would be worse than the bug it is reporting.
 *
 *   2. THE SCREEN NEVER READS LIVE SIMULATION STATE. The run reuses one summary object and refills it in
 *      place, so the snapshot has to be a real copy — including every weapon row. The strongest test of
 *      that is the nastiest one: stage a result, then reset and refill the summary the way the next run
 *      would, and prove the staged result did not move.
 *
 * It also pins the boring things that break quietly: a payout refusal must leave the slot empty (so the
 * screen shows nothing rather than last run's figures), `peek` must be safe to call as many times as a
 * React render loop feels like calling it, and a run id must separate two attempts at the same stage with
 * the same seed — which is the normal case in testing and would otherwise make the second attempt
 * unpayable.
 */

import { CHARACTERS, CHAR_UNLOCK } from "../characters/roster";
import { RUN_END, RunSummary } from "../sim/results";
import { TRACK, isHeld, seedStarters } from "../unlocks/awards";
import { ACHIEVEMENT_BY_ID, achievementsHeld } from "../unlocks/achievements";
import { HANDOFF, RunHandoff, describeHandoff, runIdOf, viewOf } from "./handoff";
import { createSaveData } from "./schema";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function profile() {
  const save = createSaveData(0xabcd, 1);
  save.gold = 500;
  save.goldLifetime = 5000;
  save.runsStarted = 20;
  save.runsCompleted = 3;
  save.secondsPlayed = 9000;
  save.bestSurvivalSeconds = 600;
  return save;
}

/** A finished run, filled the way `summariseRun` would fill it. */
function finished(gold = 340, seconds = 725, end: number = RUN_END.defeat): RunSummary {
  const s = new RunSummary();
  s.end = end as RunSummary["end"];
  s.ticks = seconds * 60;
  s.stageId = 2;
  s.seed = 12345;
  s.playerCount = 1;
  s.levelReached = 31;
  s.totalXp = 8800;
  s.gold = gold;
  s.kills = 1902;
  s.damageDealt = 448000;
  s.damageTaken = 310;
  s.downs = 1;
  s.revives = 0;
  s.screensShown = 12;
  s.picksMade = 12;
  s.weaponCount = 2;
  s.weapons[0].typeIndex = 0;
  s.weapons[0].name = "GRAVE WHIP";
  s.weapons[0].level = 8;
  s.weapons[0].damage = 300000;
  s.weapons[0].sharePermille = 669;
  s.weapons[1].typeIndex = 3;
  s.weapons[1].name = "BONE SHARD";
  s.weapons[1].level = 5;
  s.weapons[1].damage = 148000;
  s.weapons[1].sharePermille = 330;
  return s;
}

console.log("run hand-off self-check");

// ------------------------------------------------------------- an ordinary run end

section("a finished run banks once and lands in the slot");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished();
  const out = h.stage(runIdOf(summary), summary, save);
  check("it staged", out.staged, describeHandoff(out.code));
  check("the code is OK", out.code === HANDOFF.OK, `${out.code}`);
  check("the gold reached the profile", save.gold === 840, `${save.gold}`);
  check("lifetime gold too", save.goldLifetime === 5340, `${save.goldLifetime}`);
  check("the run counted as started", save.runsStarted === 21, `${save.runsStarted}`);
  check("but a defeat is not a completion", save.runsCompleted === 3, `${save.runsCompleted}`);
  check("time was added", save.secondsPlayed === 9725, `${save.secondsPlayed}`);
  check("and it beat the record", save.bestSurvivalSeconds === 725, `${save.bestSurvivalSeconds}`);

  const held = h.peek();
  check("the slot holds it", held !== null);
  check("the receipt is on it", held?.receipt.goldEarned === 340, `${held?.receipt.goldEarned}`);
  check("the receipt knows where gold started", held?.receipt.goldBefore === 500, `${held?.receipt.goldBefore}`);
  check("and where it finished", held?.receipt.goldAfter === 840, `${held?.receipt.goldAfter}`);
  check("it announces the record", held?.receipt.newBestTime === true);
  check("the view carries the kills", held?.view.kills === 1902, `${held?.view.kills}`);
  check("the view carries the level", held?.view.levelReached === 31, `${held?.view.levelReached}`);
  check("the view carries both weapons", held?.view.weapons.length === 2, `${held?.view.weapons.length}`);
}

// ------------------------------------------------------- the once-only guarantee

section("the same run cannot be banked twice");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished();
  const id = runIdOf(summary);
  h.stage(id, summary, save);
  const goldAfterFirst = save.gold;
  const startedAfterFirst = save.runsStarted;

  // Take it first, so the refusal cannot be blamed on the slot merely being occupied.
  const taken = h.take();
  check("the first result came out", taken !== null);
  check("and the slot is empty afterwards", h.peek() === null);

  const second = h.stage(id, summary, save);
  check("the second stage is refused", !second.staged);
  check("and says why", second.code === HANDOFF.ALREADY_STAGED, describeHandoff(second.code));
  check("no extra gold was paid", save.gold === goldAfterFirst, `${save.gold}`);
  check("and no extra run was counted", save.runsStarted === startedAfterFirst, `${save.runsStarted}`);
  check("the slot stayed empty", h.peek() === null);
  check("and the run still reads as banked", h.wasBanked(id));
}

section("a second result cannot overwrite one the player has not seen yet");
{
  const h = new RunHandoff();
  const save = profile();
  const first = finished(340, 725);
  h.stage(runIdOf(first), first, save);
  const goldAfterFirst = save.gold;

  const second = finished(99, 300);
  second.seed = 999;
  const out = h.stage(runIdOf(second), second, save);
  check("the second stage is refused", !out.staged);
  check("because the slot is busy", out.code === HANDOFF.SLOT_BUSY, describeHandoff(out.code));
  check("nothing was paid for it", save.gold === goldAfterFirst, `${save.gold}`);
  check("the slot still holds the first run", h.peek()?.view.kills === 1902);
  check("and the second run is not marked banked", !h.wasBanked(runIdOf(second)));
}

section("two different runs both get paid, in turn");
{
  const h = new RunHandoff();
  const save = profile();
  const a = finished(340, 725);
  h.stage(runIdOf(a), a, save);
  h.take();
  const b = finished(200, 400);
  b.ticks = 400 * 60;
  const out = h.stage(runIdOf(b), b, save);
  check("the second run staged", out.staged, describeHandoff(out.code));
  check("both payments landed", save.gold === 1040, `${save.gold}`);
  check("both runs counted", save.runsStarted === 22, `${save.runsStarted}`);
  check("the shorter run did not lower the record", save.bestSurvivalSeconds === 725, `${save.bestSurvivalSeconds}`);
  check("and did not claim one", h.peek()?.receipt.newBestTime === false);
}

section("two attempts at the same stage and seed are different runs");
{
  const a = finished(100, 300);
  const b = finished(100, 301);
  check("their ids differ", runIdOf(a) !== runIdOf(b), `${runIdOf(a)} vs ${runIdOf(b)}`);

  const h = new RunHandoff();
  const save = profile();
  h.stage(runIdOf(a), a, save);
  h.take();
  const out = h.stage(runIdOf(b), b, save);
  check("so the second attempt is payable", out.staged, describeHandoff(out.code));
  check("and both were paid", save.gold === 700, `${save.gold}`);
}

// -------------------------------------------------------------- refusals are clean

section("a payout refusal leaves nothing behind");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished();
  summary.gold = -5;
  const out = h.stage(runIdOf(summary), summary, save);
  check("it did not stage", !out.staged);
  check("and says the payout refused", out.code === HANDOFF.PAYOUT_REFUSED, describeHandoff(out.code));
  check("the receipt names the bad field", out.receipt.badField === "gold", out.receipt.badField);
  check("the profile was untouched", save.gold === 500, `${save.gold}`);
  check("no run was counted", save.runsStarted === 20, `${save.runsStarted}`);
  check("the slot is empty", h.peek() === null, "so the screen shows nothing, not stale figures");
  check("and the run was not marked banked", !h.wasBanked(runIdOf(summary)));

  // The same run, fixed, must still be payable: a refusal must not burn the run id.
  summary.gold = 340;
  const retry = h.stage(runIdOf(summary), summary, save);
  check("a corrected run is still payable", retry.staged, describeHandoff(retry.code));
  check("and pays the corrected amount", save.gold === 840, `${save.gold}`);
}

section("a quit run keeps its gold but is not a completion");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished(120, 200, RUN_END.quit);
  const out = h.stage(runIdOf(summary), summary, save);
  check("it staged", out.staged, describeHandoff(out.code));
  check("the gold was kept", save.gold === 620, `${save.gold}`);
  check("the time was kept", save.secondsPlayed === 9200, `${save.secondsPlayed}`);
  check("but it is not a completion", save.runsCompleted === 3, `${save.runsCompleted}`);
}

// ------------------------------------------- the snapshot is a copy, not a window

section("the snapshot survives the next run reusing the summary object");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished();
  h.stage(runIdOf(summary), summary, save);
  const held = h.peek();
  const killsThen = held?.view.kills;
  const nameThen = held?.view.weapons[0]?.name;
  const damageThen = held?.view.weapons[0]?.damage;
  const rowsThen = held?.view.weapons.length;

  // Exactly what the engine does at the start of the next run, then during it.
  summary.reset();
  summary.kills = 7;
  summary.weaponCount = 1;
  summary.weapons[0].name = "SOMETHING ELSE";
  summary.weapons[0].damage = 1;

  check("the staged kills did not move", held?.view.kills === killsThen, `${held?.view.kills}`);
  check("the staged kills are still the real ones", held?.view.kills === 1902, `${held?.view.kills}`);
  check("the weapon name did not move", held?.view.weapons[0]?.name === nameThen, held?.view.weapons[0]?.name);
  check("the weapon name is still the real one", held?.view.weapons[0]?.name === "GRAVE WHIP");
  check("the weapon damage did not move", held?.view.weapons[0]?.damage === damageThen);
  check("and the row count did not move", held?.view.weapons.length === rowsThen, `${held?.view.weapons.length}`);
  check("both rows are still there", held?.view.weapons.length === 2, `${held?.view.weapons.length}`);
}

section("the snapshot only carries the rows the run actually had");
{
  const summary = finished();
  summary.weaponCount = 1;
  const view = viewOf(summary);
  check("one weapon means one row", view.weapons.length === 1, `${view.weapons.length}`);

  summary.weaponCount = 0;
  const empty = viewOf(summary);
  check("no weapons means no rows", empty.weapons.length === 0, `${empty.weapons.length}`);
  check("and the rest of the view is still filled", empty.kills === 1902, `${empty.kills}`);
}

section("editing a snapshot cannot reach back into the run");
{
  const summary = finished();
  const view = viewOf(summary);
  view.weapons[0].name = "TAMPERED";
  view.weapons[0].damage = 0;
  view.kills = 0;
  check("the run's weapon name is intact", summary.weapons[0].name === "GRAVE WHIP", summary.weapons[0].name);
  check("the run's weapon damage is intact", summary.weapons[0].damage === 300000, `${summary.weapons[0].damage}`);
  check("the run's kills are intact", summary.kills === 1902, `${summary.kills}`);
}

section("two snapshots of the same run do not share rows");
{
  const summary = finished();
  const a = viewOf(summary);
  const b = viewOf(summary);
  a.weapons[0].damage = 1;
  check("the second snapshot is unaffected", b.weapons[0].damage === 300000, `${b.weapons[0].damage}`);
}

// ------------------------------------------------------------------- slot mechanics

section("peeking is free, taking is once");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished();
  h.stage(runIdOf(summary), summary, save);
  check("peek once", h.peek() !== null);
  check("peek again", h.peek() !== null);
  check("peek a third time", h.peek() !== null);
  check("gold was still only paid once", save.gold === 840, `${save.gold}`);
  check("take gets it", h.take() !== null);
  check("take again gets nothing", h.take() === null);
  check("and peek agrees", h.peek() === null);
}

section("taking from an empty slot is not an error");
{
  const h = new RunHandoff();
  check("nothing staged means nothing to take", h.take() === null);
  check("and nothing to peek", h.peek() === null);
  check("and no run reads as banked", !h.wasBanked("anything"));
}

section("a fresh hand-off knows nothing about another one");
{
  const a = new RunHandoff();
  const b = new RunHandoff();
  const save = profile();
  const summary = finished();
  const id = runIdOf(summary);
  a.stage(id, summary, save);
  check("the other slot is empty", b.peek() === null);
  check("and the other has not banked it", !b.wasBanked(id));
}

section("reset forgets, which is why nothing in play calls it");
{
  const h = new RunHandoff();
  const save = profile();
  const summary = finished();
  const id = runIdOf(summary);
  h.stage(id, summary, save);
  h.reset();
  check("the slot is cleared", h.peek() === null);
  check("and the run no longer reads as banked", !h.wasBanked(id));
  const again = h.stage(id, summary, save);
  check("so it can be paid a second time", again.staged, describeHandoff(again.code));
  check("which is a double payment", save.gold === 1180, `${save.gold}`);
}

// -------------------------------------------------------- what the run unlocked

/*
 * The results screen is the only place an unlock is ever announced, and the hand-off is the only thing that
 * can tell it. Two things have to be true and neither is obvious from reading the code:
 *
 *   - The sweep runs AFTER the gold and time are banked. If it ran first, a character earned by this run's
 *     gold would stay silent tonight and be announced tomorrow, on a run that did not earn it.
 *   - A refused payout leaves no rows behind. The report is reused between runs, so stale names surviving a
 *     refusal is exactly the bug the payout receipt already had once.
 */

/** Who each name in a report belongs to, by roster position. Keeps the checks readable. */
function reportedNames(h: RunHandoff): string[] {
  const held = h.peek();
  if (held === null) return [];
  const out: string[] = [];
  for (let i = 0; i < held.awards.count; i++) out.push(held.awards.names[i]);
  return out;
}

/**
 * Names from one track only.
 *
 * A sweep now covers people, places and arcanas at once, and some of them read the same figures — the
 * same best time can earn a character and an arcana on the same run. Checks about the roster filter
 * rather than assume every row in a report is a character.
 */
function reportedNamesOn(h: RunHandoff, track: number): string[] {
  const held = h.peek();
  if (held === null) return [];
  const out: string[] = [];
  for (let i = 0; i < held.awards.count; i++) {
    if (held.awards.tracks[i] === track) out.push(held.awards.names[i]);
  }
  return out;
}

section("a banked run hands out the unlocks it just earned");
{
  const h = new RunHandoff();
  const save = profile();
  seedStarters(save);
  const summary = finished();
  const out = h.stage(runIdOf(summary), summary, save);
  check("it staged", out.staged, describeHandoff(out.code));
  check("and it unlocked somebody", out.unlocked > 0, `${out.unlocked}`);

  const names = reportedNames(h);
  check("the report lists exactly what was granted", names.length === out.unlocked, `${names.length} rows`);
  check("every row has a name", names.every((n) => n.length > 0), names.join(", "));

  const held = h.peek();
  if (held === null) throw new Error("nothing staged");
  check("every row has a line of plain English", held.awards.lines.slice(0, held.awards.count).every((l) => l.length > 0));
  check("nothing overflowed", held.awards.overflow === 0, `${held.awards.overflow}`);

  // The starters were already seeded, so they must not be in the announcement. A player being told they
  // just unlocked the character they have had since install is worse than saying nothing.
  const starters = CHARACTERS.filter((c) => c.unlock === CHAR_UNLOCK.ALWAYS).map((c) => c.name);
  check("no starter was announced", !names.some((n) => starters.includes(n)), names.join(", "));

  // And the bits really are in the profile, not just in the report.
  let bitsSet = 0;
  for (let i = 0; i < CHARACTERS.length; i++) if (isHeld(save, TRACK.CHARACTER, i)) bitsSet++;
  const peopleWon = reportedNamesOn(h, TRACK.CHARACTER).length;
  check(
    "the profile holds the starters plus the new ones",
    bitsSet === starters.length + peopleWon,
    `${bitsSet} bits, ${starters.length} starters, ${peopleWon} won`,
  );

  // And the rest of the report really did go somewhere else, rather than the count quietly drifting.
  check(
    "every announced row belongs to a track that stored it",
    peopleWon <= out.unlocked && names.length === out.unlocked,
    `${peopleWon} people of ${out.unlocked} unlocks`,
  );
}

section("the sweep reads the profile the run just changed, not the one before it");
{
  const h = new RunHandoff();
  const save = profile();
  seedStarters(save);
  // One character wants 8,000 gold earned in total. Park the profile just under it and let the run's own
  // gold cross the line: if the sweep ran before banking, this run would announce nothing.
  const wanted = CHARACTERS.find((c) => c.unlock === CHAR_UNLOCK.LIFETIME_GOLD && c.unlockValue === 8_000);
  if (wanted === undefined) throw new Error("the roster no longer has an 8,000 gold unlock");
  save.goldLifetime = wanted.unlockValue - 100;
  const summary = finished(340);
  const out = h.stage(runIdOf(summary), summary, save);
  check("the run crossed the line", save.goldLifetime >= wanted.unlockValue, `${save.goldLifetime}`);
  check("and it was announced on this run", reportedNames(h).includes(wanted.name), reportedNames(h).join(", "));
  check("it is not announced twice", out.unlocked > 0);
}

section("an unlock is announced once and then stays quiet");
{
  const h = new RunHandoff();
  const save = profile();
  seedStarters(save);
  const first = finished(340, 725);
  h.stage(runIdOf(first), first, save);
  const announcedFirst = h.peek()?.awards.count ?? -1;
  check("the first run announced something", announcedFirst > 0, `${announcedFirst}`);
  h.take();

  const second = finished(10, 100);
  const out = h.stage(runIdOf(second), second, save);
  check("the second run staged", out.staged, describeHandoff(out.code));
  check("but announced nothing new", out.unlocked === 0, `${out.unlocked}`);
  check("and its report is empty", (h.peek()?.awards.count ?? -1) === 0, `${h.peek()?.awards.count}`);
  check("with no stale names left in it", (h.peek()?.awards.names[0] ?? "x") === "", h.peek()?.awards.names[0]);
}

section("a refused run leaves no unlocks lying around");
{
  const h = new RunHandoff();
  const save = profile();
  seedStarters(save);
  const good = finished(340);
  h.stage(runIdOf(good), good, save);
  check("the good run announced something", (h.peek()?.awards.count ?? 0) > 0);
  const report = h.peek()?.awards;
  h.take();

  const bad = finished(340, 725);
  bad.seed = 999;
  bad.gold = -5;
  const out = h.stage(runIdOf(bad), bad, save);
  check("the bad run was refused", out.code === HANDOFF.PAYOUT_REFUSED, describeHandoff(out.code));
  check("it unlocked nothing", out.unlocked === 0, `${out.unlocked}`);
  check("and the report was wiped", (report?.count ?? -1) === 0, `${report?.count}`);
  check("names included", (report?.names[0] ?? "x") === "", report?.names[0]);
}

// ------------------------------------------------------------------- badges

section("banking a run hands out the badges that run earned");
{
  const h = new RunHandoff();
  const save = profile();
  seedStarters(save);
  // Half an hour, survived. That earns the time ladder, the kill ladder's first rungs and the badge for
  // clearing this particular place — none of which the profile alone could ever answer.
  const summary = finished(900, 1800, RUN_END.survived);
  const out = h.stage(runIdOf(summary), summary, save);
  check("it staged", out.staged, describeHandoff(out.code));

  const badges = achievementsHeld(save);
  check("badges were written down", badges > 0, `${badges}`);
  const five = ACHIEVEMENT_BY_ID.get("fiveMinutes") ?? -1;
  const hour = ACHIEVEMENT_BY_ID.get("theFullHalfHour") ?? -1;
  const marsh = ACHIEVEMENT_BY_ID.get("clearMarsh") ?? -1;
  check("the five-minute badge is held", isHeld(save, TRACK.ACHIEVEMENT, five));
  check("the half-hour badge is held", isHeld(save, TRACK.ACHIEVEMENT, hour));
  check("and the badge for clearing that place", isHeld(save, TRACK.ACHIEVEMENT, marsh));

  const badgeRows = reportedNamesOn(h, TRACK.ACHIEVEMENT).length;
  check("the badges are announced", badgeRows > 0, `${badgeRows} rows`);
  check(
    "the unlock count covers both sweeps",
    out.unlocked >= badgeRows,
    `${out.unlocked} unlocks, ${badgeRows} badge rows`,
  );

  // A second, worse run must not take a badge back, and must not announce the same badge twice.
  const again = finished(10, 30, RUN_END.defeat);
  again.seed = 999;
  const out2 = h.take() === null ? null : h.stage(runIdOf(again), again, save);
  check("the second run staged", out2 !== null && out2.staged, out2 === null ? "no slot" : describeHandoff(out2.code));
  check("no badge was taken back", achievementsHeld(save) >= badges, `${achievementsHeld(save)} of ${badges}`);
  const repeated = reportedNamesOn(h, TRACK.ACHIEVEMENT);
  check("no badge was announced twice", repeated.length === 0, repeated.join(", "));
}

// ------------------------------------------------------------------- the code names

section("the refusal codes are usable in a bug report");
{
  const seen = new Set<number>();
  for (const [name, code] of Object.entries(HANDOFF)) {
    check(`${name} has a distinct number`, !seen.has(code), `${code}`);
    seen.add(code);
    check(`  and a name`, describeHandoff(code) === name, describeHandoff(code));
  }
  check("an unknown code does not crash", describeHandoff(99) === "UNKNOWN", describeHandoff(99));
}

console.log(failures === 0 ? "\nPASS — run hand-off" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`run hand-off: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
