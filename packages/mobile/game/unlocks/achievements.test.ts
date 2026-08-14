/**
 * Checks for the achievement catalog and the sweep that hands badges out.
 * Run headless: `bun packages/mobile/game/unlocks/achievements.test.ts`
 *
 * WHAT THIS FILE EXISTS TO PREVENT
 *
 * Three failures, in order of how badly they hurt.
 *
 * A badge granted off a run that never happened. The run questions can only be answered while the run
 * that just ended is in hand; asked with nothing in hand they must be SKIPPED, not answered "no" and not
 * answered off some profile number that happens to look similar. A player who opens the collection screen
 * on a fresh profile must come back out with exactly as many badges as they went in with.
 *
 * A badge taken back. Same promise the rest of this folder makes: a bit that is on stays on, whatever
 * happens to the numbers underneath it, whatever a threshold is rebalanced to, whatever a sync brings
 * down from a phone with less history.
 *
 * A catalog that quietly rots. Positions are bits in the save file, so a duplicate id, a reordered row or
 * a row pointing at a place this build does not have is a save-corrupting content edit rather than a
 * cosmetic one. The whole set is walked here rather than sampled.
 */

import { bitGet, bitSet, createSaveData, type SaveData } from "../save/schema";
import { RUN_END, RunSummary } from "../sim/results";
import { TICKS_PER_SECOND } from "../sim/waves";
import { STAGE_TYPES } from "../sim/stages";
import { MAX_WEAPON_LEVEL } from "../sim/weapons";
import {
  ACH_KIND,
  ACHIEVEMENT_BY_ID,
  ACHIEVEMENT_CAPACITY,
  ACHIEVEMENT_TYPES,
  achievementAt,
  achievementContentFaults,
  achievementEarnedLine,
  achievementHeld,
  achievementLine,
  achievementMet,
  achievementName,
  achievementsHeld,
  isRunKind,
  runFactsOf,
  type RunFacts,
} from "./achievements";
import {
  createAwardReport,
  isHeld,
  sweepAchievements,
  TRACK,
  contentFaults,
} from "./awards";

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

/** A run that did nothing at all, for a test to bend one field of. */
function nothingRun(): RunFacts {
  return {
    end: RUN_END.defeat,
    seconds: 0,
    stageId: 0,
    playerCount: 1,
    level: 1,
    gold: 0,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    downs: 0,
    revives: 0,
    weaponCount: 0,
    bestWeaponLevel: 0,
    maxedWeaponCount: 0,
  };
}

function indexOfId(id: string): number {
  const at = ACHIEVEMENT_BY_ID.get(id);
  if (at === undefined) throw new Error(`the catalog has no row called ${id}`);
  return at;
}

/* ---- the catalog itself -------------------------------------------------------------------------- */
{
  eq(achievementContentFaults().length, 0, "the catalog reports no faults");
  ok(ACHIEVEMENT_TYPES.length >= 50, "there are at least fifty achievements at launch");
  ok(ACHIEVEMENT_TYPES.length <= ACHIEVEMENT_CAPACITY, "every row has a bit in the save to live in");
  eq(ACHIEVEMENT_CAPACITY, 2048, "the save reserves two thousand and forty-eight badge bits");
  eq(ACHIEVEMENT_BY_ID.size, ACHIEVEMENT_TYPES.length, "no two rows share an id");

  const names = new Set<string>();
  for (const a of ACHIEVEMENT_TYPES) names.add(a.name);
  eq(names.size, ACHIEVEMENT_TYPES.length, "no two rows share a name");

  let hidden = 0;
  for (const a of ACHIEVEMENT_TYPES) {
    ok(a.id.trim() !== "", "every row has an id");
    ok(a.name.trim() !== "", `${a.id} has a name`);
    ok(a.blurb.trim() !== "", `${a.id} says how it is earned`);
    ok(a.icon.startsWith("achievements/"), `${a.id} points at a badge`);
    ok(a.blurb.endsWith("."), `${a.id} reads as a sentence`);
    if (a.hidden) hidden++;
    const known = Object.values(ACH_KIND).includes(a.kind);
    ok(known, `${a.id} asks a kind of question this build knows`);
    if (!isRunKind(a.kind)) ok(a.need > 0, `${a.id} asks for something above nothing`);
    if (a.kind === ACH_KIND.profileBestInStage || a.kind === ACH_KIND.runSurvivedStage) {
      ok(a.arg >= 0 && a.arg < STAGE_TYPES.length, `${a.id} names a place this build has`);
    }
    if (a.kind === ACH_KIND.runEndedAs) ok(a.arg >= 0, `${a.id} names an ending`);
  }
  ok(hidden >= 1, "at least one badge is hidden until it is earned");
  ok(hidden <= 5, "hidden badges are the exception, not the rule");
}

/* ---- run kinds and profile kinds are cleanly separated -------------------------------------------- */
{
  ok(!isRunKind(ACH_KIND.profileGold), "lifetime gold is a profile question");
  ok(!isRunKind(ACH_KIND.profileArcanas), "the arcana count is a profile question");
  ok(isRunKind(ACH_KIND.runSeconds), "time survived in one run is a run question");
  ok(isRunKind(ACH_KIND.runSurvivedStage), "clearing a place is a run question");
  ok(isRunKind(ACH_KIND.runMaxedWeapons), "counting maxed weapons is a run question");

  // The split is a number comparison, so every run kind must sort above every profile kind. If somebody
  // appends a profile kind at the end, this is the check that catches it before the sweep starts granting
  // profile badges only when a run happens to be in hand.
  for (const [name, kind] of Object.entries(ACH_KIND)) {
    eq(isRunKind(kind), name.startsWith("run"), `${name} is filed on the right side of the split`);
  }
}

/* ---- a brand new profile has earned nothing ------------------------------------------------------- */
{
  const save = fresh();
  eq(achievementsHeld(save), 0, "a new profile holds no badges");
  let met = 0;
  for (const a of ACHIEVEMENT_TYPES) if (achievementMet(a, save, null)) met++;
  eq(met, 0, "a new profile has earned nothing, with no run in hand");

  const report = createAwardReport();
  eq(sweepAchievements(save, report, null), 0, "the sweep grants nothing on a new profile");
  eq(achievementsHeld(save), 0, "and writes nothing down");
}

/* ---- profile questions read the profile ----------------------------------------------------------- */
{
  const save = fresh();
  const goldRow = ACHIEVEMENT_TYPES[indexOfId("goldLifetimeTen")];
  save.goldLifetime = goldRow.need - 1;
  ok(!achievementMet(goldRow, save, null), "one gold short is not earned");
  save.goldLifetime = goldRow.need;
  ok(achievementMet(goldRow, save, null), "exactly the bar is earned");
  save.goldLifetime = goldRow.need * 10;
  ok(achievementMet(goldRow, save, null), "well past the bar is earned");

  const runsRow = ACHIEVEMENT_TYPES[indexOfId("runsTen")];
  save.runsCompleted = 9;
  ok(!achievementMet(runsRow, save, null), "nine runs is not ten");
  save.runsCompleted = 10;
  ok(achievementMet(runsRow, save, null), "ten runs is ten");

  const hoursRow = ACHIEVEMENT_TYPES[indexOfId("playedTenHours")];
  save.secondsPlayed = 35999;
  ok(!achievementMet(hoursRow, save, null), "one second short of ten hours is not earned");
  save.secondsPlayed = 36000;
  ok(achievementMet(hoursRow, save, null), "ten hours is ten hours");

  const bestRow = ACHIEVEMENT_TYPES[indexOfId("bestHalfHour")];
  save.bestSurvivalSeconds = 1799;
  ok(!achievementMet(bestRow, save, null), "a best of 29:59 is not the half hour");
  save.bestSurvivalSeconds = 1800;
  ok(achievementMet(bestRow, save, null), "a best of 30:00 is");
}

/* ---- a place's own best time ---------------------------------------------------------------------- */
{
  const save = fresh();
  const row = ACHIEVEMENT_TYPES[indexOfId("fifteenInMarsh")];
  eq(row.kind, ACH_KIND.profileBestInStage, "the marsh badge asks about one place");

  // A long time in the wrong place earns nothing. This is the whole point of storing a time per place.
  for (let i = 0; i < save.stageBestSeconds.length; i++) save.stageBestSeconds[i] = 0;
  save.stageBestSeconds[0] = 1800;
  ok(!achievementMet(row, save, null), "half an hour in the crypt does not earn the marsh badge");
  save.stageBestSeconds[row.arg] = row.need - 1;
  ok(!achievementMet(row, save, null), "one second short in the marsh is not earned");
  save.stageBestSeconds[row.arg] = row.need;
  ok(achievementMet(row, save, null), "the bar in the marsh is earned");

  // A save from an older or smaller build has fewer slots than this build has places. Reading past the end
  // must answer "no time yet" rather than crashing or reading somebody else's number.
  const short = fresh();
  const tiny = { ...short, stageBestSeconds: new Uint16Array(1) } as SaveData;
  tiny.stageBestSeconds[0] = 1800;
  ok(!achievementMet(row, tiny, null), "a save too short to hold the marsh answers no, not crash");
  const cryptRow = ACHIEVEMENT_TYPES[indexOfId("tenInCrypt")];
  ok(achievementMet(cryptRow, tiny, null), "and the slot it does hold is still read");
}

/* ---- counting what is unlocked -------------------------------------------------------------------- */
{
  const save = fresh();
  const people = ACHIEVEMENT_TYPES[indexOfId("peopleFive")];
  for (let i = 0; i < 4; i++) bitSet(save.unlockedCharacters, i, true);
  ok(!achievementMet(people, save, null), "four people is not five");
  bitSet(save.unlockedCharacters, 4, true);
  ok(achievementMet(people, save, null), "five people is five");

  const places = ACHIEVEMENT_TYPES[indexOfId("everywhere")];
  eq(places.need, STAGE_TYPES.length, "the everywhere badge asks for every place this build has");
  for (let i = 0; i < STAGE_TYPES.length - 1; i++) bitSet(save.unlockedStages, i, true);
  ok(!achievementMet(places, save, null), "all but one place is not everywhere");
  bitSet(save.unlockedStages, STAGE_TYPES.length - 1, true);
  ok(achievementMet(places, save, null), "every place is everywhere");

  // A bit set past the end of the content list must not count towards "everywhere" — that is what a save
  // synced down from a bigger build looks like.
  const bigger = fresh();
  for (let i = 0; i < STAGE_TYPES.length + 3; i++) bitSet(bigger.unlockedStages, i, true);
  ok(achievementMet(places, bigger, null), "a save from a bigger build still counts as everywhere");
  const partial = fresh();
  for (let i = STAGE_TYPES.length; i < STAGE_TYPES.length + places.need; i++) {
    bitSet(partial.unlockedStages, i, true);
  }
  ok(!achievementMet(places, partial, null), "places this build does not have do not count");
  ok(
    !achievementMet(places, partial, null),
    "even when there are exactly as many of them as the badge asks for",
  );

  const cards = ACHIEVEMENT_TYPES[indexOfId("arcanaThree")];
  bitSet(save.unlockedArcanas, 0, true);
  bitSet(save.unlockedArcanas, 1, true);
  ok(!achievementMet(cards, save, null), "two cards is not three");
  bitSet(save.unlockedArcanas, 2, true);
  ok(achievementMet(cards, save, null), "three cards is three");
}

/* ---- run questions are skipped, never answered, with no run in hand ------------------------------- */
{
  // A profile with everything: if a run question could be answered off the profile, this is the save that
  // would do it. Nothing may be earned.
  const rich = fresh();
  rich.goldLifetime = 9_999_999;
  rich.runsCompleted = 9999;
  rich.secondsPlayed = 9_999_999;
  rich.bestSurvivalSeconds = 65535;
  for (let i = 0; i < rich.stageBestSeconds.length; i++) rich.stageBestSeconds[i] = 65535;
  for (let i = 0; i < rich.unlockedCharacters.length * 8; i++) bitSet(rich.unlockedCharacters, i, true);
  for (let i = 0; i < STAGE_TYPES.length; i++) bitSet(rich.unlockedStages, i, true);
  for (let i = 0; i < rich.unlockedArcanas.length * 8; i++) bitSet(rich.unlockedArcanas, i, true);

  for (const a of ACHIEVEMENT_TYPES) {
    if (!isRunKind(a.kind)) continue;
    ok(!achievementMet(a, rich, null), `${a.id} cannot be answered without a run`);
  }

  const report = createAwardReport();
  const granted = sweepAchievements(rich, report, null);
  ok(granted > 0, "the profile badges are still handed out");
  ok(achievementHeld(rich, indexOfId("firstRun")), "a low-numbered profile badge is handed out");
  ok(achievementHeld(rich, indexOfId("goldLifetimeTwoFifty")), "and so is the big gold one");
  ok(achievementHeld(rich, indexOfId("everywhere")), "and the one for having been everywhere");
  for (let i = 0; i < ACHIEVEMENT_TYPES.length; i++) {
    if (!isRunKind(ACHIEVEMENT_TYPES[i].kind)) continue;
    ok(!achievementHeld(rich, i), `${ACHIEVEMENT_TYPES[i].id} was not written down without a run`);
  }
}

/* ---- run questions read the run ------------------------------------------------------------------- */
{
  const save = fresh();
  const five = ACHIEVEMENT_TYPES[indexOfId("fiveMinutes")];
  const run = { ...nothingRun(), seconds: 299 };
  ok(!achievementMet(five, save, run), "4:59 is not five minutes");
  ok(achievementMet(five, save, { ...run, seconds: 300 }), "5:00 is five minutes");

  const kills = ACHIEVEMENT_TYPES[indexOfId("killsThousand")];
  ok(!achievementMet(kills, save, { ...run, kills: 999 }), "999 kills is not a thousand");
  ok(achievementMet(kills, save, { ...run, kills: 1000 }), "a thousand kills is a thousand");

  const level = ACHIEVEMENT_TYPES[indexOfId("levelTwentyFive")];
  ok(!achievementMet(level, save, { ...run, level: 24 }), "level 24 is not 25");
  ok(achievementMet(level, save, { ...run, level: 25 }), "level 25 is 25");

  const damage = ACHIEVEMENT_TYPES[indexOfId("damageMillion")];
  ok(!achievementMet(damage, save, { ...run, damageDealt: 999_999 }), "just under a million is not");
  ok(achievementMet(damage, save, { ...run, damageDealt: 1_000_000 }), "a million is");

  const bar = ACHIEVEMENT_TYPES[indexOfId("fullBar")];
  ok(!achievementMet(bar, save, { ...run, weaponCount: 5 }), "five weapons is not a full bar");
  ok(achievementMet(bar, save, { ...run, weaponCount: 6 }), "six weapons is");

  const mastered = ACHIEVEMENT_TYPES[indexOfId("maxedWeapon")];
  const bothHands = ACHIEVEMENT_TYPES[indexOfId("twoMaxedWeapons")];
  const oneMaxed = { ...run, bestWeaponLevel: MAX_WEAPON_LEVEL, maxedWeaponCount: 1 };
  ok(achievementMet(mastered, save, oneMaxed), "one maxed weapon masters a weapon");
  ok(!achievementMet(bothHands, save, oneMaxed), "one maxed weapon is not both hands");
  ok(
    achievementMet(bothHands, save, { ...oneMaxed, maxedWeaponCount: 2 }),
    "two maxed weapons is both hands",
  );
  ok(
    !achievementMet(mastered, save, { ...run, bestWeaponLevel: MAX_WEAPON_LEVEL - 1 }),
    "one level short of the top is not mastered",
  );

  const gold = ACHIEVEMENT_TYPES[indexOfId("goldRunFive")];
  ok(!achievementMet(gold, save, { ...run, gold: 4999 }), "4999 gold in a run is not five thousand");
  ok(achievementMet(gold, save, { ...run, gold: 5000 }), "five thousand is");

  const revives = ACHIEVEMENT_TYPES[indexOfId("reviveFive")];
  ok(!achievementMet(revives, save, { ...run, revives: 4 }), "four pick-ups is not five");
  ok(achievementMet(revives, save, { ...run, revives: 5 }), "five pick-ups is five");

  const party = ACHIEVEMENT_TYPES[indexOfId("partyOfFour")];
  ok(!achievementMet(party, save, { ...run, playerCount: 3 }), "three in the party is not four");
  ok(achievementMet(party, save, { ...run, playerCount: 4 }), "four in the party is four");
}

/* ---- the ones you have to mean to do -------------------------------------------------------------- */
{
  const save = fresh();
  const unhurt = ACHIEVEMENT_TYPES[indexOfId("unhurtFive")];
  const base = { ...nothingRun(), seconds: 600 };
  ok(achievementMet(unhurt, save, base), "ten clean minutes clears the five-minute clean badge");
  ok(
    !achievementMet(unhurt, save, { ...base, damageTaken: 1 }),
    "a single point of damage loses it",
  );
  ok(
    !achievementMet(unhurt, save, { ...base, seconds: 299, damageTaken: 0 }),
    "clean but short loses it too",
  );

  const standing = ACHIEVEMENT_TYPES[indexOfId("noDownsTwenty")];
  const long = { ...nothingRun(), seconds: 1200, damageTaken: 99999 };
  ok(achievementMet(standing, save, long), "hurt but never down still clears it");
  ok(!achievementMet(standing, save, { ...long, downs: 1 }), "one player going down loses it");
  ok(
    !achievementMet(standing, save, { ...long, seconds: 1199 }),
    "nobody down but a second short loses it",
  );
  ok(
    !achievementMet(standing, save, { ...long, seconds: 0 }),
    "and quitting at nought seconds with nobody down earns nothing",
  );
}

/* ---- endings and clearing a place ----------------------------------------------------------------- */
{
  const save = fresh();
  const hand = ACHIEVEMENT_TYPES[indexOfId("takenByTheHand")];
  ok(hand.hidden, "the ending badge is hidden until it is earned");
  ok(
    achievementMet(hand, save, { ...nothingRun(), end: RUN_END.whiteHand }),
    "the white hand ending earns it",
  );
  ok(
    !achievementMet(hand, save, { ...nothingRun(), end: RUN_END.survived }),
    "merely surviving does not",
  );

  const crypt = ACHIEVEMENT_TYPES[indexOfId("clearCrypt")];
  const ossuary = ACHIEVEMENT_TYPES[indexOfId("clearOssuary")];
  const survivedCrypt = { ...nothingRun(), end: RUN_END.survived, stageId: 0, seconds: 1800 };
  ok(achievementMet(crypt, save, survivedCrypt), "surviving the crypt clears the crypt");
  ok(!achievementMet(ossuary, save, survivedCrypt), "and does not clear the ossuary");
  ok(
    !achievementMet(crypt, save, { ...survivedCrypt, end: RUN_END.defeat }),
    "dying in the crypt at 30:00 does not clear it",
  );
  ok(
    !achievementMet(crypt, save, { ...survivedCrypt, end: RUN_END.quit }),
    "walking out of the crypt does not clear it",
  );
}

/* ---- reducing a finished run to facts ------------------------------------------------------------- */
{
  const summary = new RunSummary();
  summary.end = RUN_END.survived;
  summary.ticks = 1800 * TICKS_PER_SECOND;
  summary.stageId = 2;
  summary.playerCount = 3;
  summary.levelReached = 61;
  summary.gold = 4321;
  summary.kills = 7654;
  summary.damageDealt = 2_500_000;
  summary.damageTaken = 12;
  summary.downs = 2;
  summary.revives = 2;
  summary.weaponCount = 3;
  summary.weapons[0].level = MAX_WEAPON_LEVEL;
  summary.weapons[1].level = MAX_WEAPON_LEVEL;
  summary.weapons[2].level = 4;
  // A stale row past `weaponCount` is what a reused summary looks like. It must not be counted.
  summary.weapons[3].level = MAX_WEAPON_LEVEL;

  const facts = runFactsOf(summary);
  eq(facts.end, RUN_END.survived, "the ending is carried over");
  eq(facts.seconds, 1800, "ticks become seconds");
  eq(facts.stageId, 2, "the place is carried over");
  eq(facts.playerCount, 3, "the party size is carried over");
  eq(facts.level, 61, "the level is carried over");
  eq(facts.gold, 4321, "the gold is carried over");
  eq(facts.kills, 7654, "the kills are carried over");
  eq(facts.damageDealt, 2_500_000, "the damage is carried over");
  eq(facts.damageTaken, 12, "the damage taken is carried over");
  eq(facts.downs, 2, "the downs are carried over");
  eq(facts.revives, 2, "the revives are carried over");
  eq(facts.weaponCount, 3, "the weapon count is carried over");
  eq(facts.bestWeaponLevel, MAX_WEAPON_LEVEL, "the best weapon level is found");
  eq(facts.maxedWeaponCount, 2, "only the rows the run actually filled are counted");

  const empty = new RunSummary();
  const none = runFactsOf(empty);
  eq(none.bestWeaponLevel, 0, "a run with no weapons has no best weapon level");
  eq(none.maxedWeaponCount, 0, "and no maxed weapons");
  eq(none.seconds, 0, "and no time");
}

/* ---- the sweep: grants once, reports once, never takes back --------------------------------------- */
{
  const save = fresh();
  const report = createAwardReport();
  const run: RunFacts = {
    ...nothingRun(),
    end: RUN_END.survived,
    seconds: 1800,
    stageId: 0,
    kills: 1200,
    level: 30,
    gold: 800,
  };

  const first = sweepAchievements(save, report, run);
  ok(first > 0, "a good run earns badges");
  ok(achievementHeld(save, indexOfId("fiveMinutes")), "the run badges it earned are written down");
  ok(achievementHeld(save, indexOfId("theFullHalfHour")), "including the one for lasting the hour out");
  ok(achievementHeld(save, indexOfId("clearCrypt")), "including the one for clearing the place");
  eq(achievementsHeld(save), first, "every badge granted is written down");
  eq(report.count + report.overflow, first, "and every one of them is reported");

  // Reported rows are all badges, and all of them are actually held.
  for (let i = 0; i < report.count; i++) {
    eq(report.tracks[i], TRACK.ACHIEVEMENT, "the sweep reports on the badge track");
    ok(isHeld(save, TRACK.ACHIEVEMENT, report.indices[i]), "a reported badge is really held");
    ok(report.names[i].trim() !== "", "a reported badge has a name to draw");
    ok(report.lines[i].trim() !== "", "a reported badge has a line to draw");
  }

  // Run it again on the same profile with the same run. Nothing new, nothing announced twice.
  const second = createAwardReport();
  eq(sweepAchievements(save, second, run), 0, "the same run cannot earn the same badges twice");
  eq(second.count, 0, "and nothing is announced a second time");
  eq(achievementsHeld(save), first, "and the count does not move");

  // A worse run afterwards takes nothing back.
  const held = achievementsHeld(save);
  sweepAchievements(save, second, nothingRun());
  eq(achievementsHeld(save), held, "a bad run takes no badge back");

  // Neither does a profile whose numbers were somehow wiped.
  const wiped = save;
  wiped.goldLifetime = 0;
  wiped.runsCompleted = 0;
  wiped.secondsPlayed = 0;
  wiped.bestSurvivalSeconds = 0;
  sweepAchievements(wiped, second, null);
  eq(achievementsHeld(wiped), held, "a wiped profile keeps every badge it earned");
}

/* ---- what a screen draws --------------------------------------------------------------------------- */
{
  const save = fresh();
  const hiddenIndex = indexOfId("takenByTheHand");
  eq(achievementName(save, hiddenIndex), "???", "a hidden badge withholds its name");
  eq(achievementLine(save, hiddenIndex), "???", "and withholds its line");
  bitSet(save.achievements, hiddenIndex, true);
  eq(
    achievementName(save, hiddenIndex),
    ACHIEVEMENT_TYPES[hiddenIndex].name,
    "once earned it says what it is",
  );
  eq(
    achievementLine(save, hiddenIndex),
    ACHIEVEMENT_TYPES[hiddenIndex].blurb,
    "and says how it was earned",
  );

  const plain = indexOfId("fiveMinutes");
  eq(achievementName(save, plain), "Five Minutes", "an ordinary badge says its name while locked");
  eq(
    achievementLine(save, plain),
    ACHIEVEMENT_TYPES[plain].blurb,
    "and says how to earn it while locked",
  );
  eq(achievementEarnedLine(plain), ACHIEVEMENT_TYPES[plain].blurb, "the results line is the same line");

  // Out-of-range indices are clamped rather than crashing a list that scrolled too far.
  eq(achievementAt(-5).id, ACHIEVEMENT_TYPES[0].id, "a negative index draws the first row");
  eq(
    achievementAt(ACHIEVEMENT_TYPES.length + 50).id,
    ACHIEVEMENT_TYPES[ACHIEVEMENT_TYPES.length - 1].id,
    "an index past the end draws the last row",
  );
  ok(!achievementHeld(save, -1), "a negative index holds nothing");
  ok(!achievementHeld(save, ACHIEVEMENT_TYPES.length + 1), "an index past the end holds nothing");

  // The count and the bits agree, including a bit set past the end of the catalog by a bigger build.
  const future = fresh();
  bitSet(future.achievements, ACHIEVEMENT_TYPES.length + 4, true);
  eq(achievementsHeld(future), 0, "badges this build does not have do not count");
  ok(
    !achievementHeld(future, ACHIEVEMENT_TYPES.length + 4),
    "and asking about one directly answers no rather than reading its bit",
  );
  ok(bitGet(future.achievements, ACHIEVEMENT_TYPES.length + 4), "and the bit is left alone");
}

/* ---- the content self-check sees the badges too ---------------------------------------------------- */
{
  eq(contentFaults().length, 0, "the whole unlock layer reports no content faults");
}

console.log(`achievements.test: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`achievements: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
