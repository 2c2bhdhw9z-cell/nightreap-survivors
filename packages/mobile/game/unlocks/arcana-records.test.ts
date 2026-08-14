/**
 * Checks for the bridge between what a profile has survived and which arcanas a run may offer.
 * Run headless: `bun packages/mobile/game/unlocks/arcana-records.test.ts`
 *
 * WHAT THIS FILE EXISTS TO PREVENT
 *
 * Two failures, mirror images of each other. An arcana that was earned and is no longer offered takes
 * something back off a player, which is the one thing this folder promises never to happen. An arcana
 * offered to a profile that never earned it makes the whole unlock ladder pointless and hands a brand
 * new player a card the game expects them to have worked up to.
 *
 * The awkward saves are where both live: a profile migrated up from a build with no per-place times, a
 * save synced down from a build with more places than this one, and a save whose stored marks disagree
 * with its own times. Those are checked here directly rather than by exercising the happy path harder.
 */

import { bitGet, bitSet, createSaveData, type SaveData } from "../save/schema";
import { ARCANA_TYPES, ARCANA_UNLOCK, arcanaConditionMet } from "../sim/arcanas";
import { STAGE_TYPES } from "../sim/stages";
import {
  arcanaConditionMetFor,
  arcanaEarnedLine,
  arcanaLockLine,
  arcanaProgressOf,
  isArcanaOpen,
  openArcanaCount,
  openArcanaPool,
} from "./arcana-records";
import { createAwardReport, isHeld, sweepUnlocks, TRACK } from "./awards";

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

function fresh(): SaveData {
  return createSaveData();
}

/** The index of the first arcana earned by surviving anywhere, and the seconds it asks for. */
const anywhereIndex = ARCANA_TYPES.findIndex((a) => a.unlock.kind === ARCANA_UNLOCK.surviveAnywhere);
/** The index of the first arcana earned in a specific place. */
const stagedIndex = ARCANA_TYPES.findIndex((a) => a.unlock.kind === ARCANA_UNLOCK.surviveStage);

/* ---- a brand new profile ----------------------------------------------------------------------- */
{
  const save = fresh();
  ok(isArcanaOpen(save, 0), "the first arcana is available on a profile that has never played");
  eq(openArcanaCount(save), 1, "and it is the only one");
  eq(openArcanaPool(save).join(","), "0", "so the pool a run draws from holds exactly that one card");
  eq(arcanaLockLine(save, 0), "", "an available arcana has no locked line");
  ok(arcanaLockLine(save, 1).length > 0, "a locked one says how it is earned");

  ok(!isArcanaOpen(save, -1), "an index below the catalog is not open");
  ok(!isArcanaOpen(save, ARCANA_TYPES.length), "nor is one past the end");
  ok(!isArcanaOpen(save, 999999), "nor is nonsense");
  ok(!arcanaConditionMetFor(save, -4), "and neither has met a condition");
  ok(!arcanaConditionMetFor(save, ARCANA_TYPES.length + 3), "at either end");
}

/* ---- the anywhere rule ------------------------------------------------------------------------- */
{
  ok(anywhereIndex > 0, "at least one arcana is earned by surviving anywhere");
  const need = ARCANA_TYPES[anywhereIndex].unlock.seconds;

  const save = fresh();
  save.bestSurvivalSeconds = need - 1;
  ok(!isArcanaOpen(save, anywhereIndex), "one second short does not open it");
  save.bestSurvivalSeconds = need;
  ok(isArcanaOpen(save, anywhereIndex), "exactly the time opens it");
  ok(arcanaConditionMetFor(save, anywhereIndex), "and the condition is plainly met");

  // The header time is the anywhere figure. Deriving it from the per-place block instead would relock
  // every arcana on a profile that predates per-place times, which is the exact bug this guards.
  const migrated = fresh();
  migrated.bestSurvivalSeconds = need + 500;
  for (let i = 0; i < migrated.stageBestSeconds.length; i++) migrated.stageBestSeconds[i] = 0;
  ok(
    isArcanaOpen(migrated, anywhereIndex),
    "a profile with a real record but no per-place times keeps its arcana",
  );
}

/* ---- the per-place rule ------------------------------------------------------------------------ */
{
  ok(stagedIndex > 0, "at least one arcana is earned in a specific place");
  const rule = ARCANA_TYPES[stagedIndex].unlock;

  const save = fresh();
  save.bestSurvivalSeconds = 99999;
  ok(
    !isArcanaOpen(save, stagedIndex),
    "a huge record somewhere else does not satisfy a place-specific rule",
  );

  save.stageBestSeconds[rule.stageIndex] = rule.seconds - 1;
  ok(!isArcanaOpen(save, stagedIndex), "one second short in the right place does not open it");
  save.stageBestSeconds[rule.stageIndex] = rule.seconds;
  ok(isArcanaOpen(save, stagedIndex), "the right time in the right place opens it");

  ok(rule.stageIndex < STAGE_TYPES.length, "and the place it names is a place this build has");
}

/* ---- what the save is reduced to ---------------------------------------------------------------- */
{
  const save = fresh();
  save.bestSurvivalSeconds = 1234;
  for (let i = 0; i < STAGE_TYPES.length && i < save.stageBestSeconds.length; i++) {
    save.stageBestSeconds[i] = 100 + i;
  }
  const progress = arcanaProgressOf(save);
  eq(progress.bestAnywhereSeconds, 1234, "the anywhere figure is the header's own record");
  eq(progress.bestByStageIndex.length, STAGE_TYPES.length, "one entry per place this build has");
  eq(progress.bestByStageIndex[0], 100, "in the same order as the stage table");
  eq(
    progress.bestByStageIndex[STAGE_TYPES.length - 1],
    100 + STAGE_TYPES.length - 1,
    "right to the last place",
  );

  // A save synced down from a newer build can hold more slots than this build has places. Those slots
  // belong to a place that does not exist here, and are left alone rather than guessed at.
  ok(
    save.stageBestSeconds.length >= STAGE_TYPES.length,
    "the save has at least as many slots as places",
  );
  eq(
    arcanaProgressOf(save).bestByStageIndex.length,
    STAGE_TYPES.length,
    "extra slots from a newer build are not read as places",
  );

  // And the other direction: a save shortened by a bad migration, a truncated file, or a build that
  // knew fewer places. Reading past the end would hand the rules `undefined`, every comparison against
  // it would quietly answer false, and a card the player had earned would go missing with no error.
  const short = fresh();
  short.stageBestSeconds = new Uint16Array(2);
  short.stageBestSeconds[0] = 900;
  short.stageBestSeconds[1] = 800;
  const shortProgress = arcanaProgressOf(short);
  eq(shortProgress.bestByStageIndex.length, 2, "a short save is read only as far as it goes");
  for (let i = 0; i < shortProgress.bestByStageIndex.length; i++) {
    ok(
      Number.isFinite(shortProgress.bestByStageIndex[i]),
      `slot ${i} of a short save is a real number`,
    );
  }
  eq(shortProgress.bestByStageIndex[0], 900, "and the slots it does have are read correctly");
  eq(shortProgress.bestByStageIndex[1], 800, "including the last one it holds");

  // A rule about a place the short save cannot describe must simply not be met — never crash, never
  // pass by accident on a comparison with nothing.
  for (let i = 0; i < ARCANA_TYPES.length; i++) {
    const rule = ARCANA_TYPES[i].unlock;
    if (rule.kind !== ARCANA_UNLOCK.surviveStage) continue;
    if (rule.stageIndex < shortProgress.bestByStageIndex.length) continue;
    ok(
      arcanaConditionMetFor(short, i) === false,
      `${ARCANA_TYPES[i].id} is not earned from a slot the save does not have`,
    );
  }
}

/* ---- a stored mark outranks the times ------------------------------------------------------------ */
{
  const save = fresh();
  const last = ARCANA_TYPES.length - 1;
  ok(!isArcanaOpen(save, last), "the last arcana starts locked");
  bitSet(save.unlockedArcanas, last);
  ok(isArcanaOpen(save, last), "a stored mark opens it on its own");
  ok(
    !arcanaConditionMetFor(save, last),
    "while the condition itself is still plainly unmet — the mark cannot justify itself",
  );
  eq(arcanaLockLine(save, last), "", "and the card no longer shows a locked line");

  // Rebalancing a threshold upward, or a cloud merge from a phone with less history, must not take a
  // card back off somebody who already has it.
  save.bestSurvivalSeconds = 0;
  for (let i = 0; i < save.stageBestSeconds.length; i++) save.stageBestSeconds[i] = 0;
  ok(isArcanaOpen(save, last), "and it stays open even after every time on the profile is lost");
}

/* ---- the pool handed to a run --------------------------------------------------------------------- */
{
  const save = fresh();
  save.bestSurvivalSeconds = 99999;
  for (let i = 0; i < save.stageBestSeconds.length; i++) save.stageBestSeconds[i] = 99999;
  const pool = openArcanaPool(save);
  eq(pool.length, ARCANA_TYPES.length, "a maxed profile may be offered every arcana");
  eq(openArcanaCount(save), ARCANA_TYPES.length, "and the count agrees with the pool");
  eq(pool.join(","), ARCANA_TYPES.map((_, i) => i).join(","), "the pool is in catalog order");

  const partial = fresh();
  partial.bestSurvivalSeconds = ARCANA_TYPES[anywhereIndex].unlock.seconds;
  const some = openArcanaPool(partial);
  ok(some.includes(0), "the starter is always in the pool");
  ok(some.includes(anywhereIndex), "along with what has been earned");
  ok(some.length < ARCANA_TYPES.length, "and nothing that has not");
  eq(new Set(some).size, some.length, "no arcana appears in the pool twice");
}

/* ---- the sweep announces them --------------------------------------------------------------------- */
{
  const save = fresh();
  const report = createAwardReport();
  sweepUnlocks(save, report);
  let announced = 0;
  for (let i = 0; i < report.count; i++) if (report.tracks[i] === TRACK.ARCANA) announced++;
  eq(announced, 0, "a brand new profile is not congratulated for the arcana it started with");
  ok(!isHeld(save, TRACK.ARCANA, 0), "and the starter is not even marked by the sweep");

  save.bestSurvivalSeconds = ARCANA_TYPES[anywhereIndex].unlock.seconds;
  sweepUnlocks(save, report);
  let named = "";
  for (let i = 0; i < report.count; i++) {
    if (report.tracks[i] === TRACK.ARCANA) named = report.names[i];
  }
  eq(named, ARCANA_TYPES[anywhereIndex].name, "an earned arcana is announced by name");
  ok(isHeld(save, TRACK.ARCANA, anywhereIndex), "and its mark is stored");
  ok(bitGet(save.unlockedArcanas, anywhereIndex), "in the arcana bitset, not somebody else's");

  sweepUnlocks(save, report);
  let again = 0;
  for (let i = 0; i < report.count; i++) if (report.tracks[i] === TRACK.ARCANA) again++;
  eq(again, 0, "sweeping again announces it a second time to nobody");
}

/* ---- the words on the cards ------------------------------------------------------------------------ */
{
  const save = fresh();
  for (let i = 1; i < ARCANA_TYPES.length; i++) {
    const line = arcanaLockLine(save, i);
    ok(line.length > 0, `${ARCANA_TYPES[i].id} tells a locked player what to do`);
    ok(!line.includes("undefined"), `${ARCANA_TYPES[i].id}'s locked line names a real place`);
    const earned = arcanaEarnedLine(i);
    ok(earned.includes("done"), `${ARCANA_TYPES[i].id} reads as finished once it is earned`);
  }
  // The earned line must not be an empty flourish for the starter either — it is never shown, but a
  // caller that asks for it should get a sentence rather than nothing.
  ok(arcanaEarnedLine(0).length > 0, "even the starter has words if something asks for them");
  ok(arcanaEarnedLine(-5).length > 0, "and a nonsense index clamps rather than returning nothing");

  // The rules and the sentences come from the same record, so they can never disagree.
  const maxed = fresh();
  maxed.bestSurvivalSeconds = 99999;
  for (let i = 0; i < maxed.stageBestSeconds.length; i++) maxed.stageBestSeconds[i] = 99999;
  for (let i = 0; i < ARCANA_TYPES.length; i++) {
    eq(
      arcanaConditionMet(ARCANA_TYPES[i], arcanaProgressOf(maxed)),
      arcanaConditionMetFor(maxed, i),
      `${ARCANA_TYPES[i].id} answers the same whichever side is asked`,
    );
  }
}

console.log(`arcana-records.test: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`arcana-records: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
