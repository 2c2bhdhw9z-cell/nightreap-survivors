/**
 * Results-screen self-check. Run headless: `bun packages/mobile/game/sim/results.test.ts`
 *
 * The results screen is the only report a player ever gets, and it is also the record that feeds the
 * save, the achievements and any leaderboard submission. So the failure that matters is not a crash,
 * it is a *disagreement*: the screen saying one thing and the save recording another. This test pins
 * the summary as the single source of both.
 *
 * WHAT IT PROVES
 *   1. The run clock is derived from ticks in one place, and formats as minutes and seconds correctly.
 *   2. The damage breakdown ranks weapons highest-first and its shares add up to the whole.
 *   3. Shares are truncated rather than fudged, so they never claim more than 100%.
 *   4. Being taken by the White Hand counts as completing a run, not as dying — a player who reached
 *      30 minutes did not fail, and the profile must not record it as a failure.
 *   5. Quitting still banks the gold and the time played, because it was still played.
 *   6. A summary is filled in place and stays clean across reuse: no leftovers from the previous run.
 *   7. An empty run (died instantly, no weapons) summarises without dividing by zero.
 */

import { ModifierStack } from "./modifiers";
import { PLAYER_STATE, PlayerStore } from "./player";
import { Progression } from "./progression";
import {
  createProfileDelta,
  formatRunTime,
  isCompletion,
  profileDeltaFor,
  RUN_END,
  RunSummary,
  summariseRun,
  type RunTotals,
} from "./results";
import { Stats } from "./stats";
import { MAX_WEAPONS, WEAPON_BY_ID, WeaponStore } from "./weapons";

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

function makeTotals(over: Partial<RunTotals> = {}): RunTotals {
  return {
    kills: 0,
    damageDealt: 0,
    downs: 0,
    revives: 0,
    screensShown: 0,
    picksMade: 0,
    stageId: 0,
    seed: 0,
    tainted: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
section("the run clock");
{
  check("zero reads as 0:00", formatRunTime(0) === "0:00", formatRunTime(0));
  check("one second", formatRunTime(60) === "0:01", formatRunTime(60));
  check("seconds under ten keep their leading zero", formatRunTime(60 * 9) === "0:09", formatRunTime(540));
  check("a full minute", formatRunTime(60 * 60) === "1:00", formatRunTime(3600));
  check("the Reaper's timestamp", formatRunTime(60 * 60 * 30) === "30:00", formatRunTime(108000));
  check("a partial tick does not round up into a second the player did not survive", formatRunTime(60 * 61 + 59) === "1:01");
  check("a negative clock cannot happen but does not explode either", formatRunTime(-500) === "0:00");
}

// ---------------------------------------------------------------------------------------------
section("the damage breakdown");
{
  const players = new PlayerStore();
  players.reset(1, baseStats());
  const weapons = new WeaponStore();
  weapons.reset(1);
  const prog = new Progression();
  prog.reset();

  const lash = WEAPON_BY_ID.get("reapersLash") ?? 0;
  const knives = WEAPON_BY_ID.get("boneKnives") ?? 1;
  const tome = WEAPON_BY_ID.get("shroudedTome") ?? 4;
  weapons.grant(0, lash);
  weapons.grant(0, knives);
  weapons.grant(0, tome);
  // Deliberately out of order: the weakest weapon is in the first slot.
  weapons.dealt[weapons.slotOf(0, lash)] = 100;
  weapons.dealt[weapons.slotOf(0, knives)] = 700;
  weapons.dealt[weapons.slotOf(0, tome)] = 200;

  prog.addXp(500, baseStats());
  prog.addGold(340, baseStats());

  const summary = new RunSummary();
  summariseRun(
    summary,
    RUN_END.defeat,
    60 * 754,
    0,
    players,
    weapons,
    prog,
    makeTotals({ kills: 4821, damageDealt: 1000, screensShown: 9, picksMade: 12 }),
  );

  check("all three weapons are listed", summary.weaponCount === 3, `${summary.weaponCount}`);
  check(
    "the biggest contributor is first",
    summary.weapons[0].typeIndex === knives && summary.weapons[1].typeIndex === tome && summary.weapons[2].typeIndex === lash,
    `${summary.weapons[0].name} > ${summary.weapons[1].name} > ${summary.weapons[2].name}`,
  );
  check("names came from the content row", summary.weapons[0].name === "Bone Knives");
  check(
    "shares are the real proportions",
    summary.weapons[0].sharePermille === 700 && summary.weapons[1].sharePermille === 200 && summary.weapons[2].sharePermille === 100,
    `${summary.weapons.slice(0, 3).map((w) => w.sharePermille).join("/")}`,
  );

  let shareSum = 0;
  for (let i = 0; i < summary.weaponCount; i++) shareSum += summary.weapons[i].sharePermille;
  check("shares never claim more than the whole", shareSum <= 1000, `${shareSum} permille`);

  check("the clock, the level and the kills all came through", summary.seconds === 754 && summary.kills === 4821 && summary.levelReached === prog.peakLevel, `${formatRunTime(summary.ticks)}, level ${summary.levelReached}`);
  check("unused weapon rows stay empty", summary.weapons[MAX_WEAPONS - 1].typeIndex === -1);

  // Thirds: truncation must under-report rather than invent a percentage point.
  weapons.dealt[weapons.slotOf(0, lash)] = 1;
  weapons.dealt[weapons.slotOf(0, knives)] = 1;
  weapons.dealt[weapons.slotOf(0, tome)] = 1;
  summariseRun(summary, RUN_END.defeat, 600, 0, players, weapons, prog, makeTotals());
  let thirds = 0;
  for (let i = 0; i < summary.weaponCount; i++) thirds += summary.weapons[i].sharePermille;
  check("three equal weapons each read 33.3%, summing under 100%", thirds === 999, `${thirds} permille`);
}

// ---------------------------------------------------------------------------------------------
section("a summary is reused, not rebuilt");
{
  const players = new PlayerStore();
  players.reset(2, baseStats());
  const weapons = new WeaponStore();
  weapons.reset(2);
  const prog = new Progression();
  prog.reset();

  weapons.grant(0, 0);
  weapons.grant(0, 1);
  weapons.dealt[weapons.slotOf(0, 0)] = 50;

  const summary = new RunSummary();
  summariseRun(summary, RUN_END.defeat, 1200, 0, players, weapons, prog, makeTotals({ kills: 10, downs: 3, revives: 2 }));
  check("a two-player party is recorded as two", summary.playerCount === 2);
  check("downs and revives came through", summary.downs === 3 && summary.revives === 2);

  // Now a fresh, emptier run into the same record.
  const empty = new WeaponStore();
  empty.reset(1);
  const fresh = new Progression();
  fresh.reset();
  const solo = new PlayerStore();
  solo.reset(1, baseStats());
  summariseRun(summary, RUN_END.quit, 0, 0, solo, empty, fresh, makeTotals());
  check("nothing leaked from the previous run", summary.weaponCount === 0 && summary.kills === 0 && summary.downs === 0 && summary.playerCount === 1);
  check("an instant death with no weapons does not divide by zero", summary.seconds === 0 && Number.isFinite(summary.gold));
  check("and no stale weapon row survived", summary.weapons[0].typeIndex === -1 && summary.weapons[0].name === "");
}

// ---------------------------------------------------------------------------------------------
section("who was still standing");
{
  const players = new PlayerStore();
  players.reset(3, baseStats());
  players.state[1] = PLAYER_STATE.dead;
  players.upright[1] = 0;
  const weapons = new WeaponStore();
  weapons.reset(3);
  const prog = new Progression();
  prog.reset();

  const summary = new RunSummary();
  summariseRun(summary, RUN_END.survived, 60 * 1800, 0, players, weapons, prog, makeTotals());
  check(
    "the screen can say exactly who fell",
    summary.playerAlive[0] === 1 && summary.playerAlive[1] === 0 && summary.playerAlive[2] === 1,
  );
}

// ---------------------------------------------------------------------------------------------
section("what a run earns the profile");
{
  const players = new PlayerStore();
  players.reset(1, baseStats());
  const weapons = new WeaponStore();
  weapons.reset(1);
  const prog = new Progression();
  prog.reset();
  prog.addGold(1200, baseStats());

  const summary = new RunSummary();
  const delta = createProfileDelta();

  summariseRun(summary, RUN_END.whiteHand, 60 * 1801, 0, players, weapons, prog, makeTotals());
  check("the White Hand is not a death", isCompletion(RUN_END.whiteHand));
  profileDeltaFor(summary, delta);
  check("so it counts as a completed run", delta.runsCompleted === 1, `${delta.runsCompleted}`);
  check("and banks the gold and the time", delta.gold === 1200 && delta.secondsPlayed === 1801 && delta.bestSurvivalSeconds === 1801);

  // Which place the run happened on has to survive the trip to the profile, or every stage record
  // would be filed under the first stage and nothing past it would ever open.
  summariseRun(summary, RUN_END.defeat, 60 * 480, 0, players, weapons, prog, makeTotals({ stageId: 3 }));
  check("the summary remembers where the run happened", summary.stageId === 3, `${summary.stageId}`);
  profileDeltaFor(summary, delta);
  check("and so does what gets handed to the profile", delta.stageId === 3, `${delta.stageId}`);
  summariseRun(summary, RUN_END.defeat, 60 * 480, 0, players, weapons, prog, makeTotals({ stageId: 0 }));
  profileDeltaFor(summary, delta);
  check("and it goes back to the first place when that is where it was", delta.stageId === 0, `${delta.stageId}`);

  summariseRun(summary, RUN_END.defeat, 60 * 300, 0, players, weapons, prog, makeTotals());
  profileDeltaFor(summary, delta);
  check("dying does not count as completing", delta.runsCompleted === 0);
  check("but it still counts as a run started", delta.runsStarted === 1);

  summariseRun(summary, RUN_END.quit, 60 * 1200, 0, players, weapons, prog, makeTotals());
  profileDeltaFor(summary, delta);
  check(
    "quitting after twenty minutes still banks twenty minutes and the gold — it was still played",
    delta.secondsPlayed === 1200 && delta.gold === 1200,
    `${formatRunTime(60 * 1200)}, ${delta.gold} gold`,
  );

  summariseRun(summary, RUN_END.defeat, 60 * 100, 0, players, weapons, prog, makeTotals({ tainted: 1 << 3 }));
  profileDeltaFor(summary, delta);
  check("a tainted run is flagged on the profile as informational, never as a punishment", delta.everTainted === 1 << 3);
  check("and the run still reports its gold and time honestly", delta.secondsPlayed === 100);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
