/**
 * Checks for the bridge between per-place best times and which places may be played.
 * Run headless: `bun packages/mobile/game/unlocks/stage-records.test.ts`
 *
 * WHAT THIS FILE EXISTS TO PREVENT
 *
 * Every failure here is the same shape from the player's side: a place they earned is shut, or a place
 * they have not earned is open. Both are worse than they sound. The first takes something away that was
 * already given, which is the one thing this whole folder promises never to happen; the second lets a
 * brand new profile walk into the hardest wave table in the game and quietly decide the game is broken.
 *
 * So the checks below are mostly about the awkward saves rather than the happy one: a save migrated up
 * from a version that never recorded per-place times, a save synced from a build with more places than
 * this one, a save whose times were somehow shortened, and a request to start a run somewhere locked.
 */

import { bitGet, bitSet, createSaveData, type SaveData } from "../save/schema";
import { STAGE_TYPES, STAGE_UNLOCK, stageAt } from "../sim/stages";
import { createAwardReport, isHeld, sweepUnlocks, TRACK } from "./awards";
import {
  bestByStageId,
  bestTimeLine,
  firstOpenStage,
  isStageOpen,
  openStageCount,
  stageBestOf,
  stageConditionMet,
  stageEarnedLine,
  stageLockLine,
} from "./stage-records";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`FAIL: ${what} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** A fresh profile that has never played anything. */
function fresh(): SaveData {
  return createSaveData(0x1234, 1);
}

/** The number of seconds the stage at `index` demands of the stage before it. Zero for an open stage. */
function demandOf(index: number): number {
  const unlock = stageAt(index).unlock;
  return unlock.kind === STAGE_UNLOCK.always ? 0 : unlock.seconds;
}

/** Which slot the stage at `index` demands a time in. */
function demandSlot(index: number): number {
  const unlock = stageAt(index).unlock;
  if (unlock.kind === STAGE_UNLOCK.always) return -1;
  return STAGE_TYPES.findIndex((s) => s.id === unlock.stage);
}

/* ---- a brand new profile ------------------------------------------------------------------------ */

{
  const save = fresh();
  ok(isStageOpen(save, 0), "the first place is open on a profile that has never played");
  eq(openStageCount(save), 1, "and it is the only one");
  for (let i = 1; i < STAGE_TYPES.length; i++) {
    ok(!isStageOpen(save, i), `${stageAt(i).name} is shut on a new profile`);
    ok(stageLockLine(save, i) !== "", `${stageAt(i).name} says what would open it`);
  }
  eq(stageLockLine(save, 0), "", "an open place has nothing to say about being shut");
  eq(stageBestOf(save, 0), 0, "no time recorded anywhere yet");
  eq(bestTimeLine(stageBestOf(save, 0)), "", "and a place never played shows no time at all, not 0:00");
}

/* ---- times open the next place, one at a time --------------------------------------------------- */

{
  const save = fresh();
  for (let i = 1; i < STAGE_TYPES.length; i++) {
    const slot = demandSlot(i);
    const need = demandOf(i);
    ok(slot >= 0 && need > 0, `${stageAt(i).name} demands a real time on a real place`);

    save.stageBestSeconds[slot] = need - 1;
    ok(!isStageOpen(save, i), `one second short does not open ${stageAt(i).name}`);

    save.stageBestSeconds[slot] = need;
    ok(isStageOpen(save, i), `hitting the mark exactly opens ${stageAt(i).name}`);
    eq(stageLockLine(save, i), "", `and ${stageAt(i).name} stops saying it is shut`);
  }
  eq(openStageCount(save), STAGE_TYPES.length, "with every demand met, everywhere is open");
}

{
  // A long run in the crypt must not open the belfry. Each rule points at one specific place.
  const save = fresh();
  save.stageBestSeconds[0] = 60 * 60;
  eq(openStageCount(save), 2, "an hour in the first place opens the second and nothing beyond it");
}

/* ---- a stored bit outranks the time ------------------------------------------------------------- */

{
  const save = fresh();
  bitSet(save.unlockedStages, 3, true);
  ok(isStageOpen(save, 3), "a place whose bit is stored is open with no time behind it at all");
  ok(!stageConditionMet(save, 3), "even though the times plainly have not earned it");
  ok(!isStageOpen(save, 2), "and the bit opens that place only, not the ones around it");

  // The migration case: an old save arrives with its bits but with every time at zero.
  const migrated = fresh();
  for (let i = 0; i < STAGE_TYPES.length; i++) bitSet(migrated.unlockedStages, i, true);
  eq(openStageCount(migrated), STAGE_TYPES.length, "an old save keeps every place it had already opened");
  eq(stageBestOf(migrated, 2), 0, "even though it remembers no times");
}

/* ---- the sweep writes those bits, once, and says so --------------------------------------------- */

{
  const save = fresh();
  const report = createAwardReport();

  sweepUnlocks(save, report);
  ok(!isHeld(save, TRACK.STAGE, 1), "a profile that has earned nothing is granted nothing");
  ok(!bitGet(save.unlockedStages, 0), "and the first place is not announced, because nobody earned it");

  save.stageBestSeconds[demandSlot(1)] = demandOf(1);
  const granted = sweepUnlocks(save, report);
  ok(granted >= 1, "earning a place grants something");
  ok(isHeld(save, TRACK.STAGE, 1), "the bit for the earned place is now stored");
  let named = 0;
  for (let i = 0; i < report.count; i++) {
    if (report.tracks[i] === TRACK.STAGE && report.indices[i] === 1) named++;
  }
  eq(named, 1, "and the results screen is told about it exactly once");
  ok(report.names[report.count - 1] !== "", "with a name on it");

  const again = sweepUnlocks(save, report);
  let repeats = 0;
  for (let i = 0; i < report.count; i++) {
    if (report.tracks[i] === TRACK.STAGE) repeats++;
  }
  eq(repeats, 0, "sweeping twice does not announce the same place again");
  ok(again >= 0, "and the second sweep grants nothing new for it");
  ok(isStageOpen(save, 1), "while the place stays open");

  // Bits are a promise: taking the time back must not take the place back.
  save.stageBestSeconds[demandSlot(1)] = 0;
  ok(isStageOpen(save, 1), "a place stays open even if the time behind it goes away");
  ok(!stageConditionMet(save, 1), "which is only true because the bit outranks the times");
}

/* ---- the times handed to the stage rules -------------------------------------------------------- */

{
  const save = fresh();
  save.stageBestSeconds[0] = 700;
  save.stageBestSeconds[2] = 1300;
  const times = bestByStageId(save);
  eq(times[STAGE_TYPES[0].id], 700, "a time is filed under the place's own name");
  eq(times[STAGE_TYPES[2].id], 1300, "for every place, not just the first");
  eq(times[STAGE_TYPES[1].id], 0, "a place never played reads as zero, not as missing");
  eq(Object.keys(times).length, STAGE_TYPES.length, "and nothing else is in there");
}

{
  // A save from a build with fewer slots than this build has stages. Reading past the end must give
  // zero rather than nothing at all, or every unlock comparison downstream turns into gibberish.
  const short = fresh();
  short.stageBestSeconds = new Uint16Array(2);
  short.stageBestSeconds[0] = 900;
  const times = bestByStageId(short);
  eq(times[STAGE_TYPES[0].id], 900, "the times it does have are read");
  eq(Object.keys(times).length, 2, "and it does not invent the ones it does not have");
  eq(stageBestOf(short, 4), 0, "a slot the save cannot hold reads as no time at all");
  ok(!isStageOpen(short, 4), "and does not open anything");
  ok(isStageOpen(short, 0), "while the first place is still open, because it always is");
}

/* ---- nonsense in, first place out --------------------------------------------------------------- */

{
  const save = fresh();
  for (let i = 0; i < STAGE_TYPES.length; i++) bitSet(save.unlockedStages, i, true);
  eq(firstOpenStage(save, 3), 3, "an open place that was asked for is the place you get");
  eq(firstOpenStage(save, STAGE_TYPES.length + 9), 0, "a place this build does not have falls back to the first");
  eq(firstOpenStage(save, -4), 0, "a negative place falls back to the first");
  eq(firstOpenStage(save, Number.NaN), 0, "so does a request that is not a number");
  eq(firstOpenStage(save, 1.5), 0, "and half a place is not a place, so it falls back to the first");

  const locked = fresh();
  eq(firstOpenStage(locked, 4), 0, "a locked place never starts a run, it falls back to the first");
  eq(firstOpenStage(locked, 0), 0, "and the first place always starts");

  ok(!isStageOpen(fresh(), -1), "there is no place before the first");
  ok(!isStageOpen(fresh(), STAGE_TYPES.length), "and none after the last");
  eq(stageBestOf(fresh(), -1), 0, "no time exists before the first place");
  eq(stageConditionMet(fresh(), STAGE_TYPES.length + 2), false, "and nothing past the last is ever earned");
}

/* ---- the words on the cards --------------------------------------------------------------------- */

{
  eq(bestTimeLine(0), "", "no time reads as nothing");
  eq(bestTimeLine(-5), "", "and so does a nonsense time");
  eq(bestTimeLine(9), "0:09", "seconds under ten keep their leading zero");
  eq(bestTimeLine(60), "1:00", "a whole minute");
  eq(bestTimeLine(1800), "30:00", "a full run");
  eq(bestTimeLine(725.9), "12:05", "a fractional second is floored, never rounded up into a record nobody set");

  eq(stageEarnedLine(0), "Open from the start", "the first place has no story");
  for (let i = 1; i < STAGE_TYPES.length; i++) {
    const line = stageEarnedLine(i);
    ok(line.endsWith("— done"), `${stageAt(i).name} reads as something achieved`);
    ok(line.includes("minutes"), `${stageAt(i).name} says how long it took`);
  }

  const save = fresh();
  const line = stageLockLine(save, 1);
  ok(line.includes(stageAt(0).name), "a locked card names the place you have to survive in");
  ok(line.toLowerCase().startsWith("survive"), "and says what to do there");
}

console.log(`stage-records.test: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`stage-records: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
