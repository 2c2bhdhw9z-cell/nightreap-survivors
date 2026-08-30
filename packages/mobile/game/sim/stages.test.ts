/**
 * Stage table self-check. Run headless: `bun packages/mobile/game/sim/stages.test.ts`
 *
 * A stage is five numbers and a wave table, and every way a stage can be wrong is quiet:
 *
 *   1. A WAVE TABLE THAT GOES BACKWARDS. A row that arrives before the row in front of it, or that
 *      spawns fewer enemies than the minute before, does not crash anything — the run just gets
 *      easier halfway through and nobody can say why. So the shape of every curve is measured.
 *   2. CONTENT NOBODY EVER SEES. Twenty-six enemies exist. If four of them are not in any stage's mix,
 *      four enemies were drawn, tuned and tested for nothing, and no other check in the project would
 *      ever notice.
 *   3. A CROWD LIMIT ABOVE THE ENGINE GATE. The wave table is the one place that can quietly ask for
 *      more bodies than the cheapest phone we support can draw, and it would show up as "the game is
 *      bad on my phone" a month after launch instead of here.
 *   4. AN UNLOCK THAT CANNOT BE EARNED. A stage that needs a later stage survived, or needs longer
 *      than that stage's run can last, is a stage no player will ever open.
 *   5. THE FAULT FINDER ITSELF. `stageContentFaults` is what all of the above leans on, so every rule
 *      inside it is fired deliberately here against a deliberately broken table. A checker that
 *      cannot fail is not a checker.
 *   6. THE DIRECTOR ACTUALLY EATS THESE TABLES. Each of the five is played headless — the clock is run
 *      forward, enemies are counted, and every named fight is checked to have actually turned up.
 */

import { Rng } from "../core/rng";
import { ARCANA_MINUTE_MARKS, arcanaReachabilityFaults } from "./arcanas";
import { ENEMY_FLAG, ENEMY_TYPES, ENEMY_TYPE_BY_ID, EnemyStore } from "./enemies";
import { ModifierStack } from "./modifiers";
import {
  MAX_LIVE_CAP,
  MAX_PER_SECOND,
  STAGE_BY_ID,
  STAGE_BY_WIRE,
  STAGE_TYPES,
  STAGE_UNLOCK,
  STANDARD_RUN_SECONDS,
  bossesOf,
  stageAt,
  stageContentFaults,
  stageUnlocked,
  unlockText,
  unlockedStages,
  type StageType,
} from "./stages";
import { Stats } from "./stats";
import { TICKS_PER_SECOND, WaveDirector, type WaveEntry } from "./waves";

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

function baseStats(): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  return stats;
}

/** A deep-enough copy of one stage that a test can break exactly one thing in it. */
function copyStage(stage: StageType, patch: Partial<StageType>): StageType {
  return { ...stage, waves: stage.waves.map((w) => ({ ...w, mix: w.mix.map((m) => ({ ...m })) })), ...patch };
}

/** Copy a stage's wave table with one row patched. */
function patchWave(stage: StageType, index: number, patch: Partial<WaveEntry>): StageType {
  const waves = stage.waves.map((w, i) =>
    i === index ? { ...w, mix: w.mix.map((m) => ({ ...m })), ...patch } : { ...w, mix: w.mix.map((m) => ({ ...m })) },
  );
  return { ...stage, waves };
}

/** Whether a broken table produces a fault mentioning a phrase. */
function faultsMention(list: readonly StageType[], phrase: string): boolean {
  return stageContentFaults(list).some((f) => f.includes(phrase));
}

// ---------------------------------------------------------------------------
// 1. The shape of the table
// ---------------------------------------------------------------------------
section("the shape of the table");

check("five stages ship", STAGE_TYPES.length === 5, `${STAGE_TYPES.length} stages`);
check(
  "no two stages share an id",
  new Set(STAGE_TYPES.map((s) => s.id)).size === STAGE_TYPES.length,
  `${new Set(STAGE_TYPES.map((s) => s.id)).size} distinct`,
);
check(
  "no two stages share a name",
  new Set(STAGE_TYPES.map((s) => s.name)).size === STAGE_TYPES.length,
);
check(
  "no two stages share a set of pictures",
  new Set(STAGE_TYPES.map((s) => s.artKey)).size === STAGE_TYPES.length,
);
check(
  "every stage says what it is",
  STAGE_TYPES.every((s) => s.name.length > 0 && s.blurb.length > 0 && s.artKey.length > 0),
);
check(
  "wire ids are 1..5 with no gaps, and every one resolves back",
  STAGE_TYPES.every((s, i) => s.wireId === i + 1 && STAGE_BY_WIRE.get(s.wireId) === i),
);
check("wire ids still fit in a byte, which the packet format assumes", STAGE_TYPES.every((s) => s.wireId <= 255));
check("every id resolves back to its own row", STAGE_TYPES.every((s, i) => STAGE_BY_ID.get(s.id) === i));
check(
  "the first stage is the crypt, and it stays the first stage",
  STAGE_TYPES[0].id === "paupersCrypt" && STAGE_TYPES[0].artKey === "crypt",
);
check(
  "every run is the same length, so a time on one stage means the same as a time on another",
  STAGE_TYPES.every((s) => s.reaperSecond === STANDARD_RUN_SECONDS),
  `${STANDARD_RUN_SECONDS / 60} minutes`,
);
check(
  "every stage has scenery on it, and none of it is wall-to-wall",
  STAGE_TYPES.every((s) => s.propChance > 0 && s.propChance <= 1024),
);
check(
  "the marsh is the most cluttered and the gallows the barest, which is what their words promise",
  STAGE_TYPES.every((s) => s.propChance <= 320) &&
    STAGE_TYPES.find((s) => s.id === "mournersMarsh")!.propChance >
      STAGE_TYPES.find((s) => s.id === "gallowsRow")!.propChance,
);

// ---------------------------------------------------------------------------
// 2. The shipped table has nothing wrong with it
// ---------------------------------------------------------------------------
section("the shipped table has nothing wrong with it");

const shippedFaults = stageContentFaults();
if (shippedFaults.length > 0) for (const f of shippedFaults) console.log(`       ${f}`);
check("no faults in the five stages that ship", shippedFaults.length === 0, `${shippedFaults.length} faults`);

check(
  "every wave table starts at second zero, so the run is never quiet at the start by accident",
  STAGE_TYPES.every((s) => s.waves[0].atSecond === 0),
);
check(
  "no wave table stops changing more than five minutes before the Reaper",
  STAGE_TYPES.every((s) => s.waves[s.waves.length - 1].atSecond >= s.reaperSecond - 300),
);
check(
  "pressure never drops within a stage",
  STAGE_TYPES.every((s) =>
    s.waves.every((w, i) => i === 0 || (w.perSecond >= s.waves[i - 1].perSecond && w.liveCap >= s.waves[i - 1].liveCap)),
  ),
);
check(
  "no wave asks for more bodies than the engine gate",
  STAGE_TYPES.every((s) => s.waves.every((w) => w.liveCap <= MAX_LIVE_CAP)),
  `worst ${Math.max(...STAGE_TYPES.flatMap((s) => s.waves.map((w) => w.liveCap)))} of ${MAX_LIVE_CAP}`,
);
check(
  "no wave spawns faster than the budget",
  STAGE_TYPES.every((s) => s.waves.every((w) => w.perSecond <= MAX_PER_SECOND)),
  `worst ${Math.max(...STAGE_TYPES.flatMap((s) => s.waves.map((w) => w.perSecond)))} a second`,
);

// ---------------------------------------------------------------------------
// 3. Every enemy and every named fight is somewhere
// ---------------------------------------------------------------------------
section("every enemy and every named fight is somewhere");

const walkersUsed = new Set<string>();
const bossesUsed = new Set<string>();
for (const s of STAGE_TYPES) {
  for (const w of s.waves) {
    for (const m of w.mix) walkersUsed.add(m.id);
    if (w.boss !== undefined) bossesUsed.add(w.boss);
  }
}
const allWalkers = ENEMY_TYPES.filter((e) => (e.flags & ENEMY_FLAG.boss) === 0).map((e) => e.id);
const allBosses = ENEMY_TYPES.filter((e) => (e.flags & ENEMY_FLAG.boss) !== 0).map((e) => e.id);

check(
  "every ordinary enemy walks on at least one stage",
  allWalkers.every((id) => walkersUsed.has(id)),
  `${walkersUsed.size} of ${allWalkers.length}`,
);
check(
  "every named fight is scheduled on at least one stage",
  allBosses.every((id) => bossesUsed.has(id)),
  `${bossesUsed.size} of ${allBosses.length}`,
);
check(
  "nothing in a crowd mix is a named fight",
  [...walkersUsed].every((id) => (ENEMY_TYPES[ENEMY_TYPE_BY_ID.get(id)!].flags & ENEMY_FLAG.boss) === 0),
);
check(
  "every stage holds at least two named fights, so a run always has a shape",
  STAGE_TYPES.every((s) => bossesOf(s).length >= 2),
  STAGE_TYPES.map((s) => bossesOf(s).length).join("/"),
);
check(
  "no stage fights the same named enemy twice",
  STAGE_TYPES.every((s) => new Set(bossesOf(s)).size === bossesOf(s).length),
);
check(
  "the named fights arrive in the order the table lists them",
  STAGE_TYPES.every((s) => {
    const seconds = s.waves.filter((w) => w.boss !== undefined).map((w) => w.atSecond);
    return seconds.every((sec, i) => i === 0 || sec > seconds[i - 1]);
  }),
);
check(
  "every stage's first named fight is inside the first seven minutes",
  STAGE_TYPES.every((s) => s.waves.find((w) => w.boss !== undefined)!.atSecond <= 7 * 60),
);
check(
  "later stages open harder than earlier ones",
  STAGE_TYPES.every((s, i) => i === 0 || s.waves[0].perSecond >= STAGE_TYPES[i - 1].waves[0].perSecond),
  STAGE_TYPES.map((s) => s.waves[0].perSecond).join(" → "),
);
check(
  "the last stage opens heavier than the first stage ever gets in its first two minutes",
  STAGE_TYPES[4].waves[0].perSecond > STAGE_TYPES[0].waves[1].perSecond,
);

// ---------------------------------------------------------------------------
// 4. Unlocks can actually be earned
// ---------------------------------------------------------------------------
section("unlocks can actually be earned");

check(
  "exactly one stage is open on a brand new phone",
  STAGE_TYPES.filter((s) => s.unlock.kind === STAGE_UNLOCK.always).length === 1,
);
check("and it is the first one", STAGE_TYPES[0].unlock.kind === STAGE_UNLOCK.always);
check(
  "every other stage is opened by a stage that comes before it",
  STAGE_TYPES.every(
    (s, i) => i === 0 || (STAGE_BY_ID.get(s.unlock.stage) ?? 99) < i,
  ),
);
check(
  "and asks for less time than a run on that stage can last",
  STAGE_TYPES.every((s, i) => i === 0 || (s.unlock.seconds > 0 && s.unlock.seconds < s.reaperSecond)),
);

const freshPhone: Record<string, number> = {};
check("a fresh profile sees one stage", unlockedStages(freshPhone).length === 1);
check("and it is playable", stageUnlocked(STAGE_TYPES[0], freshPhone));
check("the second stage is not", !stageUnlocked(STAGE_TYPES[1], freshPhone));
check(
  "and the card tells the player exactly what to do about it",
  unlockText(STAGE_TYPES[1], freshPhone) === "Survive 15 minutes on Pauper's Crypt",
  unlockText(STAGE_TYPES[1], freshPhone),
);
check("an open stage has nothing to say", unlockText(STAGE_TYPES[0], freshPhone) === "");

const oneSecondShort: Record<string, number> = { paupersCrypt: STAGE_TYPES[1].unlock.seconds - 1 };
check("one second short is still locked", !stageUnlocked(STAGE_TYPES[1], oneSecondShort));
const exactly: Record<string, number> = { paupersCrypt: STAGE_TYPES[1].unlock.seconds };
check("landing exactly on the requirement opens it", stageUnlocked(STAGE_TYPES[1], exactly));
check("and it does not open the one after that", !stageUnlocked(STAGE_TYPES[2], exactly));

const everything: Record<string, number> = {};
for (const s of STAGE_TYPES) everything[s.id] = STANDARD_RUN_SECONDS;
check("a profile that has survived everything sees everything", unlockedStages(everything).length === 5);
check(
  "surviving a later stage does not open an earlier one out of order",
  !stageUnlocked(STAGE_TYPES[4], { hollowBelfry: STANDARD_RUN_SECONDS }),
);
check(
  "a nonsense negative time never counts as progress",
  !stageUnlocked(STAGE_TYPES[1], { paupersCrypt: -9999 }),
);

// ---------------------------------------------------------------------------
// 5. Looking a stage up
// ---------------------------------------------------------------------------
section("looking a stage up");

check("index zero is the first stage", stageAt(0).id === STAGE_TYPES[0].id);
check("index four is the last", stageAt(4).id === STAGE_TYPES[4].id);
check("a stage that does not exist falls back to the first, rather than crashing a phone", stageAt(99).id === STAGE_TYPES[0].id);
check("and so does a negative one", stageAt(-3).id === STAGE_TYPES[0].id);
check("a fractional index is truncated, not rounded", stageAt(2.9).id === STAGE_TYPES[2].id);

// ---------------------------------------------------------------------------
// 6. The fault finder can actually fail
// ---------------------------------------------------------------------------
section("the fault finder can actually fail");

const one = STAGE_TYPES[0];
const two = STAGE_TYPES[1];

check(
  "a duplicated id is caught",
  faultsMention([one, copyStage(two, { id: one.id })], "share an id"),
);
check(
  "a duplicated name is caught",
  faultsMention([one, copyStage(two, { name: one.name })], "share the name"),
);
check(
  "two stages wearing the same floor is caught",
  faultsMention([one, copyStage(two, { artKey: one.artKey })], "shares an art set"),
);
check("a blank name is caught", faultsMention([copyStage(one, { name: "" })], "has no name"));
check("a blank blurb is caught", faultsMention([copyStage(one, { blurb: "" })], "has no blurb"));
check("a missing floor is caught", faultsMention([copyStage(one, { artKey: "" })], "has no art set"));
check(
  "a wire id out of order is caught",
  faultsMention([one, copyStage(two, { wireId: 7 })], "wire id is 7"),
);
check(
  "scenery chance out of range is caught",
  faultsMention([copyStage(one, { propChance: 2000 })], "not between 0 and 1024"),
);
check(
  "a run that ends before it starts is caught",
  faultsMention([copyStage(one, { reaperSecond: 60 })], "ends before it starts"),
);
check(
  "a second always-open stage is caught",
  faultsMention(
    [one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.always, stage: "", seconds: 0 } })],
    "only the first stage",
  ),
);
check(
  "an always-open stage that also names a requirement is caught",
  faultsMention([copyStage(one, { unlock: { kind: STAGE_UNLOCK.always, stage: "theOssuary", seconds: 5 } })], "must not name a requirement"),
);
check(
  "a first stage that is locked is caught",
  faultsMention([copyStage(one, { unlock: { kind: STAGE_UNLOCK.survive, stage: "theOssuary", seconds: 60 } })], "must be open from the start"),
);
check(
  "an unlock naming something that is not a stage is caught",
  faultsMention([one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.survive, stage: "atlantis", seconds: 60 } })], "which is not a stage"),
);
check(
  "an unlock that needs a stage further down the list is caught",
  faultsMention([one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.survive, stage: "mournersMarsh", seconds: 60 } })], "not open before it"),
);
check(
  "an unlock asking for zero seconds is caught",
  faultsMention([one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.survive, stage: "paupersCrypt", seconds: 0 } })], "survival time of zero"),
);
check(
  "an unlock asking for longer than a run can last is caught",
  faultsMention(
    [one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.survive, stage: "paupersCrypt", seconds: STANDARD_RUN_SECONDS + 1 } })],
    "longer than a run",
  ),
);
check(
  "an unlock asking for longer than the required stage's own run can last is caught",
  faultsMention(
    [one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.survive, stage: "paupersCrypt", seconds: STANDARD_RUN_SECONDS + 1 } })],
    `needs ${STANDARD_RUN_SECONDS + 1}s survived on paupersCrypt, but a run there ends at ${STANDARD_RUN_SECONDS}s`,
  ),
);
check(
  "an unlock asking for exactly the required stage's reaperSecond is caught (>= not >)",
  faultsMention(
    [one, copyStage(two, { unlock: { kind: STAGE_UNLOCK.survive, stage: "paupersCrypt", seconds: STANDARD_RUN_SECONDS } })],
    `needs ${STANDARD_RUN_SECONDS}s survived on paupersCrypt, but a run there ends at ${STANDARD_RUN_SECONDS}s`,
  ),
);
check("a stage with no waves at all is caught", faultsMention([copyStage(one, { waves: [] })], "has no waves"));
check(
  "a table that does not start at zero is caught",
  faultsMention([patchWave(one, 0, { atSecond: 45 })], "does not start at second zero"),
);
check(
  "a wave that arrives out of order is caught",
  faultsMention([patchWave(one, 2, { atSecond: 5 })], "arrives before the wave in front"),
);
check(
  "a wave where the spawn rate drops is caught",
  faultsMention([patchWave(one, 3, { perSecond: 0.5 })], "pressure drops"),
);
check(
  "a wave where the crowd limit drops is caught",
  faultsMention([patchWave(one, 3, { liveCap: 5 })], "crowd limit drops"),
);
check(
  "a wave that spawns nothing is caught",
  faultsMention([patchWave(one, 0, { perSecond: 0 })], "spawns nothing"),
);
check(
  "a wave above the spawn budget is caught",
  faultsMention([patchWave(one, 12, { perSecond: MAX_PER_SECOND + 1 })], "faster than the engine budget"),
);
check(
  "a wave above the engine's body gate is caught",
  faultsMention([patchWave(one, 12, { liveCap: MAX_LIVE_CAP + 1 })], "more bodies than the engine gate"),
);
check("an empty mix is caught", faultsMention([patchWave(one, 0, { mix: [] })], "empty mix"));
check(
  "a mix naming an enemy that does not exist is caught",
  faultsMention([patchWave(one, 0, { mix: [{ id: "grue", weight: 1 }] })], "not an enemy"),
);
check(
  "a named fight smuggled into the crowd is caught",
  faultsMention([patchWave(one, 0, { mix: [{ id: "graveTyrant", weight: 1 }] })], "mixes a named fight"),
);
check(
  "the same enemy listed twice in one mix is caught",
  faultsMention(
    [patchWave(one, 0, { mix: [{ id: "shambler", weight: 50 }, { id: "shambler", weight: 50 }] })],
    "twice",
  ),
);
check(
  "an enemy in the mix with no chance of appearing is caught",
  faultsMention([patchWave(one, 0, { mix: [{ id: "shambler", weight: 0 }] })], "no chance of appearing"),
);
check(
  "a boss slot holding something that is not a boss is caught",
  faultsMention([patchWave(one, 5, { boss: "shambler" })], "but it is ordinary"),
);
check(
  "a boss slot naming nothing real is caught",
  faultsMention([patchWave(one, 5, { boss: "godzilla" })], "which is not an enemy"),
);
check(
  "the same named fight twice on one stage is caught",
  faultsMention([patchWave(one, 5, { boss: "bellmaster" })], "twice on one stage"),
);
check(
  "a named fight scheduled after the Reaper has come and gone is caught",
  faultsMention([copyStage(one, { reaperSecond: 5 * 60 })], "arrives after the Reaper"),
);
check(
  "a stage with fewer than two named fights is caught",
  faultsMention(
    [copyStage(one, { waves: one.waves.map((w) => ({ ...w, boss: undefined })) })],
    "fewer than two named fights",
  ),
);
check(
  "a roster where an enemy appears nowhere is caught",
  faultsMention([one], "never appears on any stage"),
);
check(
  "a roster where a named fight is scheduled nowhere is caught",
  faultsMention([one], "never scheduled on any stage"),
);
check(
  "a last wave that lands too close to the Reaper is caught",
  faultsMention([patchWave(one, 12, { atSecond: STANDARD_RUN_SECONDS - 10 })], "too near the Reaper"),
);
check(
  "a table that stops changing far too early is caught",
  faultsMention([copyStage(one, { waves: one.waves.slice(0, 6) })], "stops changing"),
);

// ---------------------------------------------------------------------------
// 6b. Arcana offer marks are reachable inside the shortest run
// ---------------------------------------------------------------------------
section("arcana offer marks are reachable inside the shortest run");

const stageReapers = STAGE_TYPES.map((s) => ({ id: s.id, reaperSecond: s.reaperSecond }));

check(
  "every shipped arcana mark fires inside the shortest run",
  arcanaReachabilityFaults(ARCANA_MINUTE_MARKS, stageReapers).length === 0,
  arcanaReachabilityFaults(ARCANA_MINUTE_MARKS, stageReapers).join("; ") || "clean",
);
{
  // Shorten one stage so an existing shipped mark now lands after that stage's Reaper.
  const shortened = stageReapers.map((s, i) => (i === 0 ? { id: s.id, reaperSecond: 60 } : s));
  const faults = arcanaReachabilityFaults(ARCANA_MINUTE_MARKS, shortened);
  check(
    "a mark later than the shortest run is caught, naming the mark and the shortest run",
    faults.some((f) => f.includes(`is later than the shortest run (60s on ${STAGE_TYPES[0].id})`)),
    faults.join("; ") || "no fault",
  );
}
check(
  "a mark equal to the shortest run is fine (it still fires on the final tick)",
  arcanaReachabilityFaults([STANDARD_RUN_SECONDS], stageReapers).length === 0,
);
check(
  "an empty stage list raises nothing rather than dividing by nothing",
  arcanaReachabilityFaults(ARCANA_MINUTE_MARKS, []).length === 0,
);

// ---------------------------------------------------------------------------
// 7. The director actually plays these tables
// ---------------------------------------------------------------------------
section("the director actually plays these tables");

/**
 * Run one stage headless for a number of seconds and report what happened.
 *
 * `killBosses` stands in for a player who wins their fights: a named enemy is removed a few seconds
 * after it arrives. Without it the first boss stands on the floor forever and every later fight is
 * correctly held back, which is a different thing worth testing and is tested separately below.
 */
function play(
  stage: StageType,
  seconds: number,
  killBosses = false,
): { spawned: number; bosses: Set<string>; peak: number } {
  const enemies = new EnemyStore(MAX_LIVE_CAP + 64);
  const stats = baseStats();
  const rng = new Rng(12345);
  const director = new WaveDirector();
  director.begin(stage.waves);
  const bosses = new Set<string>();
  let peak = 0;
  for (let t = 0; t < seconds * TICKS_PER_SECOND; t++) {
    const before = enemies.count;
    director.update(enemies, stats, rng, 0, 0, false);
    if (enemies.count > before) {
      for (let i = before; i < enemies.count; i++) {
        const type = ENEMY_TYPES[enemies.typeIndex[i]];
        if ((type.flags & ENEMY_FLAG.boss) !== 0) bosses.add(type.id);
      }
    }
    if (enemies.count > peak) peak = enemies.count;
    if (killBosses) {
      for (let i = enemies.count - 1; i >= 0; i--) {
        // Killed on the tick after it arrives. Nothing here simulates a fight, so the only thing being
        // measured is whether the table ever sends the enemy in at all.
        if ((ENEMY_TYPES[enemies.typeIndex[i]].flags & ENEMY_FLAG.boss) !== 0) enemies.kill(i);
      }
    }
    // Nothing is killed here on purpose: this measures what the table asks for, not what a build can
    // hold off. Enemies pile up against the wave's own limit, which is exactly the number under test.
  }
  return { spawned: director.spawnedTotal, bosses, peak };
}

for (const stage of STAGE_TYPES) {
  const result = play(stage, 90);
  check(
    `${stage.name}: the first ninety seconds actually produce a crowd`,
    result.spawned > 30,
    `${result.spawned} spawned`,
  );
  check(
    `${stage.name}: and never more alive at once than its own limit`,
    result.peak <= stage.waves[stage.waves.length - 1].liveCap,
    `peak ${result.peak}`,
  );
}

const crypt = play(STAGE_TYPES[0], 13 * 60, true);
check(
  "a player who wins their fights meets the crypt's first two named enemies in thirteen minutes",
  crypt.bosses.has("gravewarden") && crypt.bosses.has("bellmaster"),
  [...crypt.bosses].join(", "),
);
check("and not the third one, which is twenty-three minutes away", !crypt.bosses.has("carrionKing"));

// The bug this found: a fight that is due while the last one is still standing used to be skipped
// outright, so a slow player simply never met it. It waits now.
const stalled = play(STAGE_TYPES[0], 13 * 60, false);
check(
  "a player who never kills the first boss is not fighting two at once",
  stalled.bosses.size === 1 && stalled.bosses.has("gravewarden"),
  [...stalled.bosses].join(", "),
);

{
  const enemies = new EnemyStore(MAX_LIVE_CAP + 64);
  const stats = baseStats();
  const rng = new Rng(99);
  const d = new WaveDirector();
  d.begin(STAGE_TYPES[0].waves);
  // Thirteen minutes without killing anything: the first boss is standing and the second is owed.
  for (let t = 0; t < 13 * 60 * TICKS_PER_SECOND; t++) d.update(enemies, stats, rng, 0, 0, false);
  const before = new Set<string>();
  for (let i = 0; i < enemies.count; i++) {
    const type = ENEMY_TYPES[enemies.typeIndex[i]];
    if ((type.flags & ENEMY_FLAG.boss) !== 0) before.add(type.id);
  }
  for (let i = enemies.count - 1; i >= 0; i--) {
    if ((ENEMY_TYPES[enemies.typeIndex[i]].flags & ENEMY_FLAG.boss) !== 0) enemies.kill(i);
  }
  d.update(enemies, stats, rng, 0, 0, false);
  const after = new Set<string>();
  for (let i = 0; i < enemies.count; i++) {
    const type = ENEMY_TYPES[enemies.typeIndex[i]];
    if ((type.flags & ENEMY_FLAG.boss) !== 0) after.add(type.id);
  }
  check("the owed fight was remembered while the floor was busy", before.has("gravewarden") && !before.has("bellmaster"));
  check(
    "and walks in on the very next tick after the floor clears, however late that is",
    after.has("bellmaster"),
    [...after].join(", "),
  );
}

const director = new WaveDirector();
director.begin(STAGE_TYPES[4].waves);
director.jumpToSecond(1500);
check(
  "jumping the clock lands on the wave that owns that minute",
  director.currentWave.atSecond === 1320,
  `wave at ${director.currentWave.atSecond}s`,
);
director.jumpToSecond(0);
check("and jumping back lands on the opener", director.currentWave.atSecond === 0);

check(
  "the director's own clock and this table agree about how long a second is",
  TICKS_PER_SECOND === 60,
);

// ---------------------------------------------------------------------------

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${STAGE_TYPES.length} stages, ` +
    `${STAGE_TYPES.reduce((n, s) => n + s.waves.length, 0)} waves, ` +
    `${STAGE_TYPES.reduce((n, s) => n + bossesOf(s).length, 0)} named fights`,
);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`stages: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
