/**
 * Checks for merging a phone profile with a cloud profile.
 *
 * The failures this is really hunting are the two that cost real players real progress: an unlock that exists
 * on one device and not the other going missing, and gold being either duplicated or confiscated by a sync.
 * Everything else in here is guarding the rule that a refused merge must leave both inputs untouched.
 */

import {
  createMergeReport,
  describeSync,
  faultIn,
  goldWouldDrop,
  mergeSaves,
  resetMergeReport,
  sinkFaults,
  SYNC,
  unlockBits,
} from "./sync";
import { bitGet, bitSet, createSaveData, SAVE_VERSION, type SaveData } from "./schema";
import { POWERUPS, spentOn } from "../shop/powerups";
import { U32_MAX } from "./payout";

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

/** A profile that has done a bit of everything, so a merge has something to lose. */
function played(over: Partial<SaveData> = {}): SaveData {
  const save = createSaveData();
  save.generation = 10;
  save.goldLifetime = 5000;
  save.gold = 5000;
  save.runsStarted = 12;
  save.runsCompleted = 4;
  save.secondsPlayed = 4000;
  save.bestSurvivalSeconds = 700;
  return Object.assign(save, over);
}

/* ---- validation --------------------------------------------------------------------------------- */

{
  eq(faultIn(createSaveData()), "", "a fresh profile has no faults");

  const negative = played({ gold: -1 });
  eq(faultIn(negative), "gold", "negative gold is named");

  const fractional = played({ secondsPlayed: 1.5 });
  eq(faultIn(fractional), "secondsPlayed", "a fractional counter is named");

  const nan = played({ goldLifetime: Number.NaN });
  eq(faultIn(nan), "goldLifetime", "NaN is named");

  const huge = played({ runsStarted: U32_MAX + 1 });
  eq(faultIn(huge), "runsStarted", "a counter past the u32 ceiling is named");

  const shortSet = played();
  shortSet.unlockedCharacters = new Uint8Array(4);
  eq(faultIn(shortSet), "unlockedCharacters", "a short bitset is named");

  const shortRanks = played();
  shortRanks.powerUpLevels = new Uint8Array(1);
  eq(faultIn(shortRanks), "powerUpLevels", "a short rank array is named");

  const shortTiers = played();
  shortTiers.ascensionTiers = new Uint16Array(1);
  eq(faultIn(shortTiers), "ascensionTiers", "a short tier array is named");

  const shortStages = played();
  shortStages.stageBestSeconds = new Uint16Array(1);
  eq(faultIn(shortStages), "stageBestSeconds", "a short stage-record array is named");
}

/* ---- unlocks union ------------------------------------------------------------------------------ */

{
  const local = played();
  const remote = played();
  const out = createSaveData();
  const report = createMergeReport();

  bitSet(local.unlockedCharacters, 1, true);
  bitSet(local.unlockedStages, 0, true);
  bitSet(remote.unlockedCharacters, 3, true);
  bitSet(remote.unlockedArcanas, 7, true);
  bitSet(remote.achievements, 40, true);
  bitSet(remote.unlockedWeapons, 2, true);

  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  ok(bitGet(out.unlockedCharacters, 1), "this device's character survives");
  ok(bitGet(out.unlockedCharacters, 3), "the cloud's character arrives");
  ok(bitGet(out.unlockedStages, 0), "this device's stage survives");
  ok(bitGet(out.unlockedArcanas, 7), "the cloud's arcana arrives");
  ok(bitGet(out.achievements, 40), "the cloud's achievement arrives");
  ok(bitGet(out.unlockedWeapons, 2), "the cloud's weapon arrives");
  eq(unlockBits(out), 6, "six things are held in total");
  eq(report.unlocksLocal, 2, "the report says what this device had");
  eq(report.unlocksRemote, 4, "and what the cloud had");
  eq(report.unlocksMerged, 6, "and what the merge holds");
  eq(report.unlocksGained, 4, "and how many are new to this device");

  // Neither input may be touched: a merge that edited its own source could not be retried.
  eq(unlockBits(local), 2, "this device's copy is unchanged");
  eq(unlockBits(remote), 4, "the cloud copy is unchanged");
}

/* ---- high-water marks -------------------------------------------------------------------------- */

{
  const local = played({ runsStarted: 20, runsCompleted: 2, secondsPlayed: 9000, bestSurvivalSeconds: 400 });
  const remote = played({ runsStarted: 5, runsCompleted: 9, secondsPlayed: 100, bestSurvivalSeconds: 1500 });
  const out = createSaveData();
  const report = createMergeReport();

  local.powerUpLevels[0] = 4;
  remote.powerUpLevels[0] = 2;
  local.powerUpLevels[1] = 1;
  remote.powerUpLevels[1] = 6;
  local.masteryLevels[3] = 7;
  remote.masteryLevels[3] = 2;
  local.ascensionTiers[0] = 3;
  remote.ascensionTiers[0] = 11;
  // Two phones that each played a different place: after the merge both records stand.
  local.stageBestSeconds[1] = 900;
  remote.stageBestSeconds[1] = 400;
  remote.stageBestSeconds[3] = 1200;

  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  eq(out.runsStarted, 20, "runs started takes the larger");
  eq(out.runsCompleted, 9, "runs finished takes the larger");
  eq(out.secondsPlayed, 9000, "time played takes the larger");
  eq(out.bestSurvivalSeconds, 1500, "best time takes the larger");
  eq(out.powerUpLevels[0], 4, "a rank this device bought survives");
  eq(out.powerUpLevels[1], 6, "a rank the cloud bought arrives");
  eq(out.masteryLevels[3], 7, "mastery takes the larger");
  eq(out.ascensionTiers[0], 11, "ascension takes the larger");
  eq(out.stageBestSeconds[1], 900, "a stage record this device set survives the cloud's worse one");
  eq(out.stageBestSeconds[3], 1200, "a stage record only the cloud has arrives");
  eq(out.stageBestSeconds[2], 0, "a stage neither of them played stays empty");
  ok(out.generation > local.generation && out.generation > remote.generation, "the merge outranks both inputs");
  eq(report.generation, out.generation, "and the report says so");
}

/* ---- gold is reconstructed, never duplicated ---------------------------------------------------- */

{
  // The scenario the whole file exists for: the same profile on two phones, one of which went shopping.
  const local = played({ goldLifetime: 5000, gold: 5000 });
  const remote = played({ goldLifetime: 5000 });
  const out = createSaveData();
  const report = createMergeReport();

  remote.powerUpLevels[0] = 3;
  const spent = spentOn(POWERUPS[0], 3);
  remote.gold = 5000 - spent;

  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  eq(out.powerUpLevels[0], 3, "the purchase is kept");
  eq(out.gold, 5000 - spent, "and so is the bill — the money is not handed back");
  ok(report.goldReconstructed, "the report says the balance was derived");
  eq(report.invested, spent, "and how much is tied up in the shop");
  eq(report.goldMerged, out.gold, "and what the balance came out as");

  // The mirror case: this device shopped, the cloud is stale. Same answer, which is the point.
  const out2 = createSaveData();
  eq(mergeSaves(remote, local, out2, report), SYNC.OK, "merging the other way round succeeds");
  eq(out2.gold, out.gold, "and lands on the same balance");
  eq(out2.powerUpLevels[0], 3, "with the same purchase");
}

{
  // Both devices earned gold the other never saw. Lifetime is a high-water mark, not a sum: adding them
  // would invent currency out of two views of the same history.
  const local = played({ goldLifetime: 8000, gold: 8000 });
  const remote = played({ goldLifetime: 3000, gold: 3000 });
  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  eq(out.goldLifetime, 8000, "lifetime takes the larger");
  eq(out.gold, 8000, "and the balance follows it, with nothing invested");
  ok(out.gold < local.goldLifetime + remote.goldLifetime, "the two histories are not added together");
}

{
  // A refund lowers what is invested and leaves lifetime alone, so the balance comes back on its own.
  const local = played({ goldLifetime: 4000 });
  local.powerUpLevels[0] = 2;
  local.gold = 4000 - spentOn(POWERUPS[0], 2);
  const remote = played({ goldLifetime: 4000, gold: 4000 });
  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(remote, local, out, report), SYNC.OK, "the merge succeeds");
  eq(out.gold, 4000 - spentOn(POWERUPS[0], 2), "the shopping device's bill wins");

  // Now the shopping device refunds. A later merge must give the money back, once.
  local.powerUpLevels[0] = 0;
  local.gold = 4000;
  const out2 = createSaveData();
  eq(mergeSaves(remote, local, out2, report), SYNC.OK, "and after a refund");
  eq(out2.gold, 4000, "the balance is whole again");
  eq(out2.powerUpLevels[0], 0, "with the rank gone");
}

{
  // Lifetime pinned at the ceiling is no longer a total, so the subtraction is meaningless and the merge
  // says so rather than quietly answering with a wrong balance.
  const local = played({ goldLifetime: U32_MAX, gold: 12 });
  const remote = played({ goldLifetime: U32_MAX, gold: 900 });
  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge still succeeds");
  eq(out.gold, 900, "the larger balance is kept");
  ok(!report.goldReconstructed, "and the report admits the balance was not derived");
}

{
  // A balance that cannot be afforded by the merged history is not carried over. Spending more than was
  // ever earned is the shape of a tampered save, and the floor is zero, never a negative.
  const local = played({ goldLifetime: 100, gold: 100 });
  const remote = played({ goldLifetime: 100, gold: 100 });
  for (let i = 0; i < POWERUPS.length; i++) remote.powerUpLevels[i] = POWERUPS[i].maxRank;
  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  eq(out.gold, 0, "the balance floors at zero rather than going negative");
  ok(out.gold >= 0, "and never goes below it");
}

/* ---- the warning a prompt shows ---------------------------------------------------------------- */

{
  const local = played({ goldLifetime: 5000, gold: 5000 });
  const remote = played({ goldLifetime: 5000, gold: 5000 });
  ok(!goldWouldDrop(local, remote), "two identical profiles cost nothing to merge");

  remote.powerUpLevels[0] = 3;
  ok(goldWouldDrop(local, remote), "a purchase on the other device will lower the balance here");

  const maxed = played({ goldLifetime: U32_MAX, gold: 5 });
  ok(!goldWouldDrop(maxed, maxed), "a pinned lifetime never warns");
}

/* ---- settings are taken whole ------------------------------------------------------------------ */

{
  const local = played({ generation: 4 });
  const remote = played({ generation: 9 });
  local.settings.joystickSize = 111;
  local.settings.hudScale = 133;
  local.settings.autoAim = true;
  remote.settings.joystickSize = 55;
  remote.settings.hudScale = 90;
  remote.settings.autoAim = false;

  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  eq(report.settingsFrom, "remote", "the more recently written block wins");
  eq(out.settings.joystickSize, 55, "and its stick size comes with it");
  eq(out.settings.hudScale, 90, "and its HUD scale");
  eq(out.settings.autoAim, false, "and its switches — no blend of the two");

  // Tie goes to the device in the player's hand.
  const tiedLocal = played({ generation: 7 });
  const tiedRemote = played({ generation: 7 });
  tiedLocal.settings.hudScale = 120;
  tiedRemote.settings.hudScale = 80;
  const out2 = createSaveData();
  eq(mergeSaves(tiedLocal, tiedRemote, out2, report), SYNC.OK, "a tie merges");
  eq(report.settingsFrom, "local", "and this device wins it");
  eq(out2.settings.hudScale, 120, "with its own layout");
}

/* ---- taint accumulates ------------------------------------------------------------------------- */

{
  const local = played({ everTainted: 0b0001 });
  const remote = played({ everTainted: 0b0100 });
  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(local, remote, out, report), SYNC.OK, "the merge succeeds");
  eq(out.everTainted, 0b0101, "both devices' dev-menu history is kept");
}

/* ---- refusals ---------------------------------------------------------------------------------- */

{
  const local = played();
  const remote = played();
  const out = createSaveData();
  const report = createMergeReport();

  eq(mergeSaves(local, remote, local, report), SYNC.BAD_DESTINATION, "merging into one of the inputs is refused");
  eq(report.badField, "out", "and says which argument was wrong");
  eq(mergeSaves(local, remote, remote, report), SYNC.BAD_DESTINATION, "either input, in fact");

  const newer = played({ version: SAVE_VERSION + 1 });
  eq(mergeSaves(newer, remote, out, report), SYNC.VERSION_TOO_NEW, "a newer local save is refused");
  eq(mergeSaves(local, newer, out, report), SYNC.VERSION_TOO_NEW, "a newer cloud save is refused");

  const brokenLocal = played({ gold: -5 });
  eq(mergeSaves(brokenLocal, remote, out, report), SYNC.BAD_LOCAL, "a broken local save is refused");
  eq(report.badField, "gold", "and the field is named");

  const brokenRemote = played({ runsCompleted: 0.5 });
  eq(mergeSaves(local, brokenRemote, out, report), SYNC.BAD_REMOTE, "a broken cloud save is refused");
  eq(report.badField, "runsCompleted", "and the field is named");

  const brokenOut = createSaveData();
  brokenOut.achievements = new Uint8Array(2);
  eq(mergeSaves(local, remote, brokenOut, report), SYNC.BAD_DESTINATION, "a wrong-shaped destination is refused");
}

/* ---- a refused merge writes nothing ------------------------------------------------------------ */

{
  const local = played({ goldLifetime: 900, gold: 900 });
  bitSet(local.unlockedCharacters, 2, true);
  const remote = played({ runsCompleted: -3 });
  bitSet(remote.unlockedCharacters, 5, true);
  const out = createSaveData();
  const report = createMergeReport();

  eq(mergeSaves(local, remote, out, report), SYNC.BAD_REMOTE, "the merge is refused");
  eq(unlockBits(out), 0, "the destination has no bits");
  eq(out.gold, 0, "no gold");
  eq(out.goldLifetime, 0, "no lifetime");
  eq(out.generation, createSaveData().generation, "and no generation bump");
  eq(unlockBits(local), 1, "this device is untouched");
  eq(unlockBits(remote), 1, "the cloud copy is untouched");
}

/* ---- a refused report carries no numbers to show ----------------------------------------------- */

{
  const local = played({ goldLifetime: 4000, gold: 4000 });
  bitSet(local.unlockedCharacters, 1, true);
  const remote = played({ goldLifetime: 6000, gold: 6000 });
  bitSet(remote.unlockedCharacters, 4, true);
  const out = createSaveData();
  const report = createMergeReport();

  eq(mergeSaves(local, remote, out, report), SYNC.OK, "a good merge first");
  ok(report.unlocksMerged > 0, "which fills the report");

  const broken = played({ gold: Number.NaN });
  const out2 = createSaveData();
  eq(mergeSaves(broken, remote, out2, report), SYNC.BAD_LOCAL, "then a refused one");
  eq(report.unlocksMerged, 0, "the unlock counts are wiped");
  eq(report.unlocksLocal, 0, "all of them");
  eq(report.unlocksRemote, 0, "all of them");
  eq(report.unlocksGained, 0, "all of them");
  eq(report.goldMerged, 0, "the balance is wiped");
  eq(report.goldLocal, 0, "and both sides of it");
  eq(report.goldRemote, 0, "and both sides of it");
  eq(report.invested, 0, "the invested figure is wiped");
  eq(report.generation, 0, "the generation is wiped");
  eq(report.goldReconstructed, false, "and the flag is back down");
}

/* ---- reset and words -------------------------------------------------------------------------- */

{
  const report = createMergeReport();
  report.code = SYNC.BAD_LOCAL;
  report.badField = "gold";
  report.goldMerged = 44;
  resetMergeReport(report);
  eq(report.code, SYNC.OK, "reset clears the code");
  eq(report.badField, "", "and the field");
  eq(report.goldMerged, 0, "and the numbers");

  for (const code of Object.values(SYNC)) ok(describeSync(code).length > 0, `code ${code} has words`);
  ok(describeSync(9999).includes("9999"), "an unknown code says which one it was");
}

/* ---- the shipping shop is still the only gold sink --------------------------------------------- */

{
  const faults = sinkFaults();
  eq(faults.length, 0, `the shop's prices can all be reconstructed: ${faults.join("; ")}`);
}

/* ---- merging a profile with itself changes nothing but the generation -------------------------- */

{
  const local = played({ goldLifetime: 3000, gold: 3000 });
  bitSet(local.unlockedCharacters, 2, true);
  local.powerUpLevels[2] = 3;
  local.gold = 3000 - spentOn(POWERUPS[2], 3);

  const copy = played({ goldLifetime: 3000, gold: local.gold });
  bitSet(copy.unlockedCharacters, 2, true);
  copy.powerUpLevels[2] = 3;

  const out = createSaveData();
  const report = createMergeReport();
  eq(mergeSaves(local, copy, out, report), SYNC.OK, "a profile merges with its own copy");
  eq(out.gold, local.gold, "with the same balance");
  eq(unlockBits(out), unlockBits(local), "the same unlocks");
  eq(out.powerUpLevels[2], 3, "the same ranks");
  eq(report.unlocksGained, 0, "and nothing gained");
}

console.log(`sync.test: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`sync.test: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
