/**
 * Checks for the unlock awarding layer.
 *
 * The things worth proving here are all about *not losing* and *not repeating*: a bit is never cleared, an
 * unlock is announced exactly once, a starter is never announced, and a position the save cannot store is
 * refused loudly instead of writing nothing and claiming success.
 */

import {
  AWARD,
  AWARD_LIMIT,
  capacityOf,
  characterConditionMet,
  contentFaults,
  createAwardReport,
  describeAward,
  earnedLine,
  grant,
  isHeld,
  reportRows,
  resetAwardReport,
  seedStarters,
  setFor,
  sweepUnlocks,
  TRACK,
  TRACK_NAMES,
  type AwardReport,
} from "./awards";
import { CHAR_UNLOCK, CHARACTERS, type Character } from "../characters/roster";
import { bitCount, bitGet, createSaveData, type SaveData } from "../save/schema";

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

/* ---- a tiny roster of our own, so content edits do not rewrite these checks --------------------- */

function testCharacter(over: Partial<Character>): Character {
  return {
    id: "test",
    name: "Test",
    title: "the Tested",
    blurb: "A character that exists for a check.",
    startingWeaponId: CHARACTERS[0].startingWeaponId,
    shifts: CHARACTERS[0].shifts,
    growth: CHARACTERS[0].growth,
    unlock: CHAR_UNLOCK.ALWAYS,
    unlockValue: 0,
    ...over,
  } as Character;
}

const ROSTER: readonly Character[] = [
  testCharacter({ id: "starter", name: "Starter", unlock: CHAR_UNLOCK.ALWAYS, unlockValue: 0 }),
  testCharacter({ id: "gold", name: "Gold Gate", unlock: CHAR_UNLOCK.LIFETIME_GOLD, unlockValue: 1000 }),
  testCharacter({ id: "runs", name: "Runs Gate", unlock: CHAR_UNLOCK.RUNS_COMPLETED, unlockValue: 3 }),
  testCharacter({ id: "time", name: "Time Gate", unlock: CHAR_UNLOCK.BEST_SECONDS, unlockValue: 600 }),
];

/* ---- tracks and capacity ------------------------------------------------------------------------ */

{
  const save = createSaveData();
  for (const track of Object.values(TRACK)) {
    ok(setFor(save, track) !== undefined, `${TRACK_NAMES[track]} has a bitset`);
    ok(capacityOf(track) > 0, `${TRACK_NAMES[track]} has room`);
  }
  eq(setFor(save, 99), undefined, "an unknown track has no bitset");
  eq(capacityOf(99), 0, "an unknown track has no room");

  // The bitsets must be distinct objects, or granting a character would grant a stage.
  const seen = new Set<Uint8Array>();
  for (const track of Object.values(TRACK)) {
    const set = setFor(save, track);
    if (set !== undefined) seen.add(set);
  }
  eq(seen.size, Object.values(TRACK).length, "every track has its own bitset");
}

/* ---- grant ------------------------------------------------------------------------------------- */

{
  const save = createSaveData();
  const report = createAwardReport();
  resetAwardReport(report);

  eq(grant(save, TRACK.STAGE, 4, "Bone Orchard", "Finished the run.", report), AWARD.OK, "a stage is granted");
  ok(isHeld(save, TRACK.STAGE, 4), "the bit is set");
  eq(report.count, 1, "the grant is reported once");
  eq(report.names[0], "Bone Orchard", "the report carries the name");
  eq(report.tracks[0], TRACK.STAGE, "the report carries the track");
  eq(report.indices[0], 4, "the report carries the position");

  eq(
    grant(save, TRACK.STAGE, 4, "Bone Orchard", "Finished the run.", report),
    AWARD.ALREADY_HELD,
    "granting the same thing twice says so",
  );
  eq(report.count, 1, "and does not report it a second time");

  eq(grant(save, 99, 0, "Nothing", "", report), AWARD.UNKNOWN_TRACK, "an unknown track is refused");
  eq(grant(save, TRACK.STAGE, -1, "Nothing", "", report), AWARD.INDEX_NOT_SAFE, "a negative position is refused");
  eq(grant(save, TRACK.STAGE, 1.5, "Nothing", "", report), AWARD.INDEX_NOT_SAFE, "a fraction is refused");
  eq(grant(save, TRACK.STAGE, Number.NaN, "Nothing", "", report), AWARD.INDEX_NOT_SAFE, "NaN is refused");
  eq(
    grant(save, TRACK.STAGE, capacityOf(TRACK.STAGE), "Nothing", "", report),
    AWARD.INDEX_OUT_OF_RANGE,
    "a position past the bitset is refused",
  );
  eq(grant(save, TRACK.STAGE, 5, "   ", "", report), AWARD.NO_NAME, "a nameless unlock is refused");
  eq(report.count, 1, "no refusal reached the report");
  ok(!isHeld(save, TRACK.STAGE, 5), "a refused grant wrote no bit");

  // The last position must be reachable: an off-by-one here would quietly lose the final row of a list.
  eq(
    grant(save, TRACK.STAGE, capacityOf(TRACK.STAGE) - 1, "Last", "", report),
    AWARD.OK,
    "the last position in a bitset can be granted",
  );
}

/* ---- isHeld is as strict as grant --------------------------------------------------------------- */

{
  const save = createSaveData();
  grant(save, TRACK.ARCANA, 3, "Arcana", "");
  ok(isHeld(save, TRACK.ARCANA, 3), "a granted arcana is held");
  ok(!isHeld(save, TRACK.ARCANA, 4), "a neighbour is not");
  ok(!isHeld(save, 99, 3), "an unknown track holds nothing");
  ok(!isHeld(save, TRACK.ARCANA, 1.5), "a fractional position is not held");
  ok(!isHeld(save, TRACK.ARCANA, capacityOf(TRACK.ARCANA)), "a position past the end is not held");
}

/* ---- conditions ------------------------------------------------------------------------------- */

{
  const save = createSaveData();
  ok(characterConditionMet(save, ROSTER[0]), "a starter is always earned");
  ok(!characterConditionMet(save, ROSTER[1]), "the gold gate is not earned on a new save");

  save.goldLifetime = 999;
  ok(!characterConditionMet(save, ROSTER[1]), "one gold short is not earned");
  save.goldLifetime = 1000;
  ok(characterConditionMet(save, ROSTER[1]), "exactly the bar is earned");

  save.runsCompleted = 2;
  ok(!characterConditionMet(save, ROSTER[2]), "two of three runs is not earned");
  save.runsCompleted = 3;
  ok(characterConditionMet(save, ROSTER[2]), "three of three runs is earned");

  save.bestSurvivalSeconds = 599;
  ok(!characterConditionMet(save, ROSTER[3]), "a second short of ten minutes is not earned");
  save.bestSurvivalSeconds = 600;
  ok(characterConditionMet(save, ROSTER[3]), "ten minutes is earned");

  const nonsense = testCharacter({ unlock: 99 as Character["unlock"], unlockValue: 1 });
  ok(!characterConditionMet(save, nonsense), "an unlock rule nobody wrote is never met");
}

/* ---- seeding starters -------------------------------------------------------------------------- */

{
  const save = createSaveData();
  eq(seedStarters(save, ROSTER), 1, "the one starter is seeded");
  ok(bitGet(save.unlockedCharacters, 0), "the starter's bit is written");
  ok(!bitGet(save.unlockedCharacters, 1), "a gated character is not seeded");
  eq(seedStarters(save, ROSTER), 0, "seeding again writes nothing");
}

/* ---- the sweep --------------------------------------------------------------------------------- */

function sweptNames(report: AwardReport): string[] {
  const names: string[] = [];
  for (let i = 0; i < report.count; i++) names.push(report.names[i]);
  return names;
}

{
  const save = createSaveData();
  const report = createAwardReport();

  eq(sweepUnlocks(save, report, ROSTER), 0, "a new save has earned nothing");
  eq(report.count, 0, "and the report says nothing — starters are never announced");
  ok(!bitGet(save.unlockedCharacters, 0), "the sweep does not seed starters either");

  save.goldLifetime = 1200;
  eq(sweepUnlocks(save, report, ROSTER), 1, "the gold gate falls");
  eq(sweptNames(report).join(","), "Gold Gate", "and is named");
  ok(report.lines[0].includes("1000"), "the line says what was earned");

  eq(sweepUnlocks(save, report, ROSTER), 0, "sweeping again earns nothing");
  eq(report.count, 0, "and reports nothing");
  ok(bitGet(save.unlockedCharacters, 1), "the bit from last sweep is still set");

  save.runsCompleted = 5;
  save.bestSurvivalSeconds = 900;
  eq(sweepUnlocks(save, report, ROSTER), 2, "two more fall at once");
  eq(sweptNames(report).sort().join(","), "Runs Gate,Time Gate", "both are named");
  eq(bitCount(save.unlockedCharacters), 3, "three bits are held, the starter still unseeded");
}

/* ---- a sweep never takes anything back --------------------------------------------------------- */

{
  const save = createSaveData();
  const report = createAwardReport();
  save.goldLifetime = 5000;
  sweepUnlocks(save, report, ROSTER);
  ok(bitGet(save.unlockedCharacters, 1), "earned once");

  // A rebalance, a refund, or a sync from a phone with less history: the numbers go backwards.
  save.goldLifetime = 0;
  eq(sweepUnlocks(save, report, ROSTER), 0, "nothing new is earned once the numbers drop");
  ok(bitGet(save.unlockedCharacters, 1), "and what was earned is still held");
  eq(report.count, 0, "with nothing announced");
}

/* ---- the report is wiped, not just shortened --------------------------------------------------- */

{
  const save = createSaveData();
  const report = createAwardReport();
  save.goldLifetime = 5000;
  sweepUnlocks(save, report, ROSTER);
  eq(report.count, 1, "one row");

  const fresh = createSaveData();
  fresh.goldLifetime = 0;
  eq(sweepUnlocks(fresh, report, ROSTER), 0, "a profile with nothing earned");
  eq(report.count, 0, "reports no rows");
  eq(report.names[0], "", "and leaves no name behind it");
  eq(report.lines[0], "", "and no line behind it");
  eq(report.tracks[0], -1, "and no track behind it");
  eq(report.indices[0], -1, "and no position behind it");
  eq(report.overflow, 0, "and no overflow behind it");
}

/* ---- overflow counts, it does not drop --------------------------------------------------------- */

{
  const many: Character[] = [];
  for (let i = 0; i < AWARD_LIMIT + 5; i++) {
    many.push(testCharacter({ id: `g${i}`, name: `Gate ${i}`, unlock: CHAR_UNLOCK.RUNS_COMPLETED, unlockValue: 1 }));
  }
  const save = createSaveData();
  const report = createAwardReport();
  save.runsCompleted = 1;

  eq(sweepUnlocks(save, report, many), AWARD_LIMIT + 5, "every earned unlock is granted");
  eq(report.count, AWARD_LIMIT, "the report fills up");
  eq(report.overflow, 5, "and counts the rest");
  eq(reportRows(report), AWARD_LIMIT, "a screen draws the rows it has");
  eq(bitCount(save.unlockedCharacters), AWARD_LIMIT + 5, "every bit is set, report or no report");
}

/* ---- text -------------------------------------------------------------------------------------- */

{
  for (const character of CHARACTERS) {
    ok(earnedLine(character).trim() !== "", `${character.id} has an unlock line`);
  }
  ok(describeAward(AWARD.ALREADY_HELD).length > 0, "every award code has words");
  ok(describeAward(9999).includes("9999"), "an unknown code says which one it was");
}

/* ---- the shipping content ---------------------------------------------------------------------- */

{
  const faults = contentFaults();
  eq(faults.length, 0, `the real roster has no unlock faults: ${faults.join("; ")}`);

  const tooMany: Character[] = [];
  for (let i = 0; i <= capacityOf(TRACK.CHARACTER); i++) tooMany.push(testCharacter({ id: `c${i}`, name: `C${i}` }));
  ok(contentFaults(tooMany).length > 0, "a roster larger than the bitset is a fault");

  const noStarters = [testCharacter({ unlock: CHAR_UNLOCK.RUNS_COMPLETED, unlockValue: 1 })];
  ok(
    contentFaults(noStarters).some((f) => f.includes("new save")),
    "a roster with nobody playable on a new save is a fault",
  );

  const badBar = [
    testCharacter({ id: "a", name: "A" }),
    testCharacter({ id: "b", name: "B", unlock: CHAR_UNLOCK.LIFETIME_GOLD, unlockValue: 0 }),
  ];
  ok(contentFaults(badBar).length > 0, "a gate with a bar of zero is a fault");
}

/* ---- the real roster is sane against a real profile -------------------------------------------- */

{
  const save: SaveData = createSaveData();
  const report = createAwardReport();
  eq(sweepUnlocks(save, report), 0, "a brand new profile earns nothing off the real roster");
  save.goldLifetime = 4294967295;
  save.runsCompleted = 100000;
  save.bestSurvivalSeconds = 100000;
  const all = sweepUnlocks(save, report);
  let gated = 0;
  for (const character of CHARACTERS) {
    if (character.unlock !== CHAR_UNLOCK.ALWAYS) gated++;
  }
  eq(all, gated, "a maxed profile earns every gated character on the real roster");
}

console.log(`awards.test: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`awards.test: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
