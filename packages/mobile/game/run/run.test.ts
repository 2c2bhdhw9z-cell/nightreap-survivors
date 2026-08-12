/**
 * Run-loop self-check. Run headless: `bun packages/mobile/game/run/run.test.ts`
 *
 * Every system underneath this file already has its own test. What none of them can prove is that
 * assembling them produces a *game* — that experience actually reaches the level curve, that dead
 * enemies actually leave gems, that a five-minute run does not quietly stall, and above all that two
 * machines handed the same seed and the same inputs end up in the same world.
 *
 * WHAT IT PROVES
 *   1. A five-minute run at 60Hz completes end to end and produces a summary.
 *   2. The loop is deterministic: same seed, same inputs, identical state hash at every checkpoint.
 *   3. A different seed produces a different world, so the hash is actually reading state.
 *   4. Kills turn into gems, gems turn into levels, levels turn into card screens, cards turn into
 *      weapons — the whole reward loop, in one pass.
 *   5. A card screen freezes the simulation and nothing advances until it is answered.
 *   6. Hurry doubles the run clock and Hyper thickens the crowd, together, with no mode-specific code
 *      anywhere in the loop — they are only data in the modifier stack.
 *   7. A tick with 800 enemies on the field fits inside the frame budget and allocates nothing.
 *   8. Every ending the loop can reach headlessly produces a correct summary: defeat, survival, quit,
 *      and being taken by the White Hand.
 */

import { MOD_DEV_GODMODE, MOD_HURRY, MOD_HYPER } from "../sim/modifiers";
import { PLAYER_STATE } from "../sim/player";
import { RUN_END, isCompletion } from "../sim/results";
import { STAT, STAT_SCALE } from "../sim/stats";
import { TICKS_PER_SECOND } from "../sim/waves";
import { REAPER_SECOND } from "../sim/waves";
import { Run } from "./run";

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

function nowMs(): number {
  const host = globalThis as unknown as { performance?: { now?: () => number } };
  return host.performance?.now?.() ?? 0;
}

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
  };
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

/**
 * Drive a run for a while with a scripted stick, answering every card screen.
 *
 * The script is a slow circle: it keeps the player moving through the crowd rather than standing
 * still in a corner, which is what actually exercises spawning, magnetism and contact damage.
 */
function drive(run: Run, ticks: number, pick = 0): void {
  for (let i = 0; i < ticks; i++) {
    const a = (i / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    if (run.paused) {
      run.pickCard(pick);
      continue;
    }
    if (run.over) return;
    run.tick();
  }
}

// ---------------------------------------------------------------------------------------------
section("1. a five-minute run completes");

{
  const run = new Run();
  run.begin({ seed: 12345, modifiers: [MOD_DEV_GODMODE], record: true });
  const target = 5 * 60 * TICKS_PER_SECOND;

  const t0 = nowMs();
  drive(run, target + 4096);
  const elapsed = nowMs() - t0;

  check("five minutes of run clock elapsed", run.runTicks >= target, `${run.describe()}`);
  check("the run is still going", !run.over, `end=${run.end}`);
  check("enemies are on the field", run.enemies.count > 0, `${run.enemies.count} enemies`);
  check("the player levelled up", run.prog.level > 1, `level ${run.prog.level}`);
  check("kills were scored", run.kills > 0, `${run.kills} kills`);
  check("damage was dealt", run.damageDealt > 0, `${Math.trunc(run.damageDealt)} damage`);
  check("card screens were shown", run.cards.screensShown > 0, `${run.cards.screensShown} screens`);
  check(
    "the input log recorded every tick",
    run.recorder.tickCount === run.ticks,
    `${run.recorder.tickCount} logged vs ${run.ticks} ticks`,
  );
  console.log(`       simulated ${run.ticks} ticks in ${elapsed.toFixed(0)}ms`);

  const summary = run.quit();
  check("quitting produces a summary", summary.end === RUN_END.quit);
  check("the summary banks the gold", summary.gold === run.prog.gold, `${summary.gold} gold`);
  check("the summary keeps the time played", summary.ticks === run.runTicks);
  check("the summary lists weapons", summary.weaponCount > 0, `${summary.weaponCount} weapons`);
}

// ---------------------------------------------------------------------------------------------
section("2. the same seed produces the same world");

{
  const hashesA: number[] = [];
  const hashesB: number[] = [];

  function record(run: Run, out: number[], ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      const a = (i / 240) * Math.PI * 2;
      run.setStick(0, Math.cos(a), Math.sin(a));
      if (run.paused) {
        run.pickCard(0);
        continue;
      }
      run.tick();
      if (i % 600 === 0) out.push(run.hashState(0x811c9dc5) >>> 0);
    }
    out.push(run.hashState(0x811c9dc5) >>> 0);
  }

  const a = new Run();
  a.begin({ seed: 777, modifiers: [MOD_DEV_GODMODE], record: false });
  record(a, hashesA, 90 * TICKS_PER_SECOND);

  const b = new Run();
  b.begin({ seed: 777, modifiers: [MOD_DEV_GODMODE], record: false });
  record(b, hashesB, 90 * TICKS_PER_SECOND);

  let firstDivergence = -1;
  for (let i = 0; i < hashesA.length; i++) {
    if (hashesA[i] !== hashesB[i]) {
      firstDivergence = i;
      break;
    }
  }
  check(
    "every checkpoint hash agrees",
    firstDivergence < 0,
    firstDivergence < 0
      ? `${hashesA.length} checkpoints`
      : `diverged at checkpoint ${firstDivergence}`,
  );

  // The same object, reused for a second run on the same seed, must also reproduce it. This is what
  // "restart same seed" in the dev menu depends on, and it is where a missed reset would show up.
  const reused: number[] = [];
  a.begin({ seed: 777, modifiers: [MOD_DEV_GODMODE], record: false });
  record(a, reused, 90 * TICKS_PER_SECOND);
  check(
    "a reused run object reproduces the same seed",
    reused[reused.length - 1] === hashesA[hashesA.length - 1],
  );

  const c = new Run();
  const hashesC: number[] = [];
  c.begin({ seed: 778, modifiers: [MOD_DEV_GODMODE], record: false });
  record(c, hashesC, 90 * TICKS_PER_SECOND);
  check(
    "a different seed produces a different world",
    hashesC[hashesC.length - 1] !== hashesA[hashesA.length - 1],
  );
}

// ---------------------------------------------------------------------------------------------
section("3. the reward loop connects end to end");

{
  const run = new Run();
  run.begin({ seed: 99, modifiers: [MOD_DEV_GODMODE], record: false });

  const weaponsAtStart = countWeapons(run);
  check("the run starts with one weapon", weaponsAtStart === 1, `${weaponsAtStart} weapons`);

  drive(run, 60 * TICKS_PER_SECOND);

  check("gems were collected", run.prog.totalXp > 0, `${run.prog.totalXp} xp banked`);
  check("levels were gained", run.prog.level > 1, `level ${run.prog.level}`);
  check("picks were taken", run.cards.picksMade > 0, `${run.cards.picksMade} picks`);
  check(
    "the loadout grew",
    countWeapons(run) + countPassives(run) > weaponsAtStart,
    `${countWeapons(run)} weapons, ${countPassives(run)} passives`,
  );
  check("gold accumulated", run.prog.gold > 0, `${run.prog.gold} gold`);
}

// ---------------------------------------------------------------------------------------------
section("4. a card screen freezes the world");

{
  const run = new Run();
  run.begin({ seed: 4242, modifiers: [MOD_DEV_GODMODE], record: false });

  // Run until a screen opens.
  // Circle rather than sprint in one direction: gems are collected by walking over them, and a
  // player who only ever runs right outruns their own loot and never levels at all.
  let guard = 0;
  while (!run.paused && guard < 120 * TICKS_PER_SECOND) {
    const a = (guard / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    run.tick();
    guard++;
  }
  check("a card screen opened", run.paused, `after ${guard} ticks`);

  const ticksBefore = run.ticks;
  const runTicksBefore = run.runTicks;
  const hashBefore = run.hashState(0x811c9dc5);
  for (let i = 0; i < 120; i++) run.tick();
  check("ticks do not advance while a screen is open", run.ticks === ticksBefore);
  check("the run clock does not advance either", run.runTicks === runTicksBefore);
  check("the world is unchanged", run.hashState(0x811c9dc5) === hashBefore);

  check("a card can be taken", run.pickCard(0));
  while (run.paused) run.pickCard(0);
  run.tick();
  check("the world advances again once answered", run.ticks === ticksBefore + 1);
}

// ---------------------------------------------------------------------------------------------
section("5. Hurry and Hyper are data, and they stack");

{
  const plain = new Run();
  plain.begin({ seed: 31337, modifiers: [MOD_DEV_GODMODE], record: false });
  drive(plain, 60 * TICKS_PER_SECOND);

  const hurry = new Run();
  hurry.begin({ seed: 31337, modifiers: [MOD_DEV_GODMODE, MOD_HURRY], record: false });
  drive(hurry, 60 * TICKS_PER_SECOND);

  check(
    "Hurry doubles the run clock for the same number of ticks",
    hurry.runTicks >= plain.runTicks * 2 - 4,
    `${plain.runTicks} ticks of clock vs ${hurry.runTicks}`,
  );

  const both = new Run();
  both.begin({ seed: 31337, modifiers: [MOD_DEV_GODMODE, MOD_HURRY, MOD_HYPER], record: false });
  drive(both, 60 * TICKS_PER_SECOND);

  check(
    "Hurry and Hyper stack on the clock",
    both.runTicks >= plain.runTicks * 2 - 4,
    `${both.runTicks} ticks of clock`,
  );
  check(
    "Hyper thickens the crowd on top of Hurry",
    both.waves.spawnedTotal > hurry.waves.spawnedTotal,
    `${hurry.waves.spawnedTotal} spawned with Hurry vs ${both.waves.spawnedTotal} with both`,
  );
  check(
    "Hyper speeds the crowd up as a live stat",
    both.stats.get(STAT.enemySpeed) > plain.stats.get(STAT.enemySpeed),
    `${both.stats.get(STAT.enemySpeed) / STAT_SCALE}x`,
  );
  // Every iteration of the driver either advances one tick or answers one card — never both, never
  // neither. A mode that had reached into the loop would break that identity somewhere.
  const budget = 60 * TICKS_PER_SECOND;
  check(
    "and no mode changed the shape of the loop",
    plain.ticks + plain.cards.picksMade === budget &&
      hurry.ticks + hurry.cards.picksMade === budget &&
      both.ticks + both.cards.picksMade === budget,
    `${plain.ticks}+${plain.cards.picksMade}, ${hurry.ticks}+${hurry.cards.picksMade}, ${both.ticks}+${both.cards.picksMade} of ${budget}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("6. a heavy tick fits the budget and allocates nothing");

{
  const run = new Run();
  run.begin({ seed: 5150, modifiers: [MOD_DEV_GODMODE], record: false });

  // Fill the field by hand rather than waiting twenty minutes for the wave table to do it.
  const stats = run.stats;
  for (let i = 0; i < 800; i++) {
    const a = (i / 800) * Math.PI * 2;
    const r = 60 + (i % 200);
    run.enemies.spawn(i % 4, Math.cos(a) * r, Math.sin(a) * r, stats);
  }
  check("the field holds 800 enemies", run.enemies.count === 800, `${run.enemies.count}`);

  // Warm up first: the first few ticks include lazy initialisation that is not per-tick cost.
  for (let i = 0; i < 120; i++) {
    run.setStick(0, 1, 0);
    if (run.paused) run.pickCard(0);
    else run.tick();
  }

  const before = heapUsed();
  const t0 = nowMs();
  const measured = 600;
  let ticked = 0;
  for (let i = 0; i < measured; i++) {
    const a = (i / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    if (run.paused) {
      run.pickCard(0);
      continue;
    }
    run.tick();
    ticked++;
  }
  const elapsed = nowMs() - t0;
  const growth = (heapUsed() - before) / 1024;
  const perTick = elapsed / Math.max(1, ticked);

  console.log(
    `       ${ticked} ticks, ${perTick.toFixed(3)}ms per tick, ${growth.toFixed(1)}KB heap growth, ${run.enemies.count} enemies live`,
  );
  check("a heavy tick fits inside the 16.6ms frame budget", perTick < 16.6, `${perTick.toFixed(3)}ms`);
  check("ticking does not grow the heap", growth < 512, `${growth.toFixed(1)}KB`);
}

// ---------------------------------------------------------------------------------------------
section("7. every ending produces a summary");

{
  // Defeat: no godmode, and the player stands still in the crowd.
  const dead = new Run();
  dead.begin({ seed: 8, record: false });
  let guard = 0;
  while (!dead.over && guard++ < 20 * 60 * TICKS_PER_SECOND) {
    dead.setStick(0, 0, 0);
    if (dead.paused) dead.pickCard(0);
    else dead.tick();
  }
  check("standing in the crowd kills you", dead.end === RUN_END.defeat, `after ${guard} ticks`);
  check("the dead player is dead", dead.players.state[0] === PLAYER_STATE.dead);
  check("defeat is not a completion", !isCompletion(dead.summary.end));
  check("the defeat summary records damage taken", dead.summary.damageTaken > 0);

  // Survival: a time limit, which is how Phase 2's timed stages and the daily race will end.
  const survived = new Run();
  survived.begin({
    seed: 9,
    modifiers: [MOD_DEV_GODMODE],
    record: false,
    timeLimitTicks: 30 * TICKS_PER_SECOND,
  });
  drive(survived, 40 * TICKS_PER_SECOND);
  check("a time limit ends the run as a survival", survived.end === RUN_END.survived);
  check("survival is a completion", isCompletion(survived.summary.end));

  // The White Hand: jump the clock to the Reaper and let the bell finish.
  const taken = new Run();
  taken.begin({ seed: 10, modifiers: [MOD_DEV_GODMODE], record: false });
  taken.waves.jumpToSecond(REAPER_SECOND);
  drive(taken, 20 * TICKS_PER_SECOND);
  check("the White Hand ends the run", taken.end === RUN_END.whiteHand, `end=${taken.end}`);
  check("being taken counts as completing the run", isCompletion(taken.summary.end));
  check("the Reaper was actually spawned", taken.waves.reaperSpawned);

  // Finishing twice must not produce two records of one run.
  const before = taken.summary.end;
  taken.quit();
  check("a finished run cannot be finished again", taken.summary.end === before);
}

function countWeapons(run: Run): number {
  let n = 0;
  for (let i = 0; i < 6; i++) if (run.weapons.typeIndex[i] >= 0) n++;
  return n;
}

function countPassives(run: Run): number {
  let n = 0;
  for (let i = 0; i < 6; i++) if (run.passives.typeIndex[i] >= 0) n++;
  return n;
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
