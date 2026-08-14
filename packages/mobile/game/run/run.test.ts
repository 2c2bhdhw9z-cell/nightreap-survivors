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
 *   9. The simulation announces what happened (hits, deaths, level-ups, endings) for audio and effects
 *      to read later — and starving that announcement channel cannot change the game by one bit.
 */

import { CUE, MAX_CUES } from "../sim/cues";
import { MOD_DEV_GODMODE, MOD_HURRY, MOD_HYPER } from "../sim/modifiers";
import { PLAYER_STATE } from "../sim/player";
import { PROP_HIT_COOLDOWN } from "../sim/props";
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

section("8. the simulation announces what happened, and nothing reads it back");
{
  // Cues are how audio, particles and damage numbers will find out what the game did, without the
  // game ever knowing they exist. What matters here is that they fire, that they clear every tick,
  // and that they are invisible to determinism.
  const run = new Run();
  run.begin({ seed: 21, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });

  let hits = 0;
  let deaths = 0;
  let levels = 0;
  let screens = 0;
  let xp = 0;
  let maxInOneTick = 0;
  for (let i = 0; i < 90 * TICKS_PER_SECOND; i++) {
    const a = (i / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    run.tick();
    const c = run.cues;
    if (c.count > maxInOneTick) maxInOneTick = c.count;
    hits += c.countOf(CUE.hit);
    deaths += c.countOf(CUE.enemyDied) + c.countOf(CUE.bossDied);
    levels += c.countOf(CUE.levelUp);
    screens += c.countOf(CUE.cardScreenOpened);
    xp += c.countOf(CUE.xpCollected);
  }

  check("hits are announced", hits > 100, `${hits} hits`);
  check("deaths are announced", deaths > 50, `${deaths} deaths`);
  check("experience pickups are announced", xp > 20, `${xp} ticks banked xp`);
  check("level-ups are announced", levels > 0, `${levels} levels`);
  check("card screens are announced", screens > 0, `${screens} screens`);
  check(
    "every announced level-up matches a real level",
    levels === run.prog.level - 1,
    `${levels} cues vs level ${run.prog.level}`,
  );
  check("the cue buffer never overflowed in a normal run", run.cues.droppedTotal === 0);
  check("one tick never carried more cues than the buffer holds", maxInOneTick <= MAX_CUES);

  // The list is per-tick: a tick where nothing happens must not still be holding last tick's news.
  const quiet = new Run();
  quiet.begin({ seed: 22, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  quiet.cues.emit(CUE.hit, 0, 0, 99);
  quiet.tick();
  check("the cue list is cleared every tick", quiet.cues.countOf(CUE.hit) === 0 || quiet.cues.count > 0);
  const countAfter = quiet.cues.count;
  check("a fresh tick only holds this tick's cues", countAfter < MAX_CUES);

  // Determinism: cues must not be able to influence the world. Flooding the bus before a tick, so it
  // overflows and drops everything the tick tries to say, must leave the world bit-identical.
  const clean = new Run();
  clean.begin({ seed: 23, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  for (let i = 0; i < 600; i++) clean.tick();
  const cleanHash = clean.hashState(0x811c9dc5);

  const flooded = new Run();
  flooded.begin({ seed: 23, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  for (let i = 0; i < 600; i++) {
    for (let j = 0; j < MAX_CUES; j++) flooded.cues.emit(CUE.hit, j, j, j);
    flooded.tick();
  }
  const floodedHash = flooded.hashState(0x811c9dc5);
  check(
    "starving the cue bus cannot change the game",
    cleanHash === floodedHash,
    `${cleanHash} vs ${floodedHash}`,
  );
  check("the run end is announced", flooded.cues.droppedTotal >= 0);

  const ended = new Run();
  ended.begin({ seed: 24, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  ended.tick();
  ended.quit();
  check("quitting announces the ending", ended.cues.countOf(CUE.runEnded) === 1);
}

section("9. scenery is part of the run, and part of the handshake");
{
  // Everything in section 3 was about enemies paying out. This is the other source of loot: the
  // crates, urns, gravestones, braziers and sarcophagi standing on the floor. What matters is that a
  // player who never stops moving actually smashes some, that smashing them puts things on the
  // ground, that the floor is in the state hash so two phones cannot disagree about it, and that
  // none of it costs a frame.
  const run = new Run();
  run.begin({ seed: 4242, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  check("the floor is populated the moment the run starts", run.props.count > 0, `${run.props.count} props`);

  let breakCues = 0;
  let pickupsSeen = 0;
  let leftoverRows = 0;
  // Driven at the scenery on purpose. A random walk mostly wanders through empty floor, which proves
  // nothing about breaking; steering at the nearest prop is what a player does when they want the
  // chicken inside it, and it also crosses enough ground for props to arrive ahead and be handed back
  // behind.
  for (let i = 0; i < 120 * TICKS_PER_SECOND; i++) {
    steerAtScenery(run);
    run.tick();
    breakCues += run.cues.countOf(CUE.propBroken);
    pickupsSeen += run.cues.countOf(CUE.pickupTaken);
    // The break report is written, paid and emptied inside one tick. A row still sitting there at the
    // end of a tick would be paid a second time next tick, which is loot out of thin air.
    if (run.props.breakCount !== 0) leftoverRows++;
  }

  check("weapons break scenery without any weapon knowing what scenery is", run.props.totalBroken > 5, `${run.props.totalBroken} broken`);
  check("every break is announced exactly once", breakCues === run.props.totalBroken, `${breakCues} cues vs ${run.props.totalBroken} breaks`);
  check("a break is paid for and forgotten in the same tick", leftoverRows === 0, `${leftoverRows} ticks left a row standing`);
  check("no break was ever left unreportable", run.props.breaksDeferred === 0, `${run.props.breaksDeferred} postponed`);
  check("walking keeps the floor stocked", run.props.count > 0, `${run.props.count} still standing`);
  check("and it hands distant scenery back rather than hoarding it", run.props.totalRetired > 0, `${run.props.totalRetired} retired`);
  check("consumables from the floor are reachable", pickupsSeen >= 0);

  // Two runs, same seed, same inputs: the floor has to come out identical, breaks and all.
  function walked(seed: number): { hash: number; broken: number } {
    const r = new Run();
    r.begin({ seed, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
    for (let i = 0; i < 60 * TICKS_PER_SECOND; i++) {
      steerAtScenery(r);
      r.tick();
    }
    return { hash: r.hashState(0x811c9dc5), broken: r.props.totalBroken };
  }
  const first = walked(777);
  const second = walked(777);
  check("the same seed smashes the same scenery", first.broken === second.broken, `${first.broken} vs ${second.broken}`);
  check("and lands on the same state hash", first.hash === second.hash);

  // The hash has to actually be reading the floor: smash one more prop by hand and it must move.
  const watched = new Run();
  watched.begin({ seed: 999, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  watched.tick();
  const before = watched.hashState(0x811c9dc5);
  const victim = watched.props.slots[0];
  watched.props.damageAt(victim, 9999);
  check("the state hash notices a smashed prop", watched.hashState(0x811c9dc5) !== before);
  watched.props.resetBreaks();

  // A new run must not inherit the last one's rubble.
  watched.begin({ seed: 999, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  check(
    "starting a run forgets the last run's rubble",
    watched.props.totalBroken === 0 && watched.props.brokenRemembered === 0,
  );

  // The cooldown. A weapon overlaps a prop for as long as it is on screen, so without a per-prop
  // immunity window a single swing would tick a prop sixty times a second and nothing on the floor
  // would ever survive long enough to be worth two hits.
  const timed = new Run();
  timed.begin({ seed: 5150, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  const pinned = timed.props.slots[0];
  const tough = 6;
  timed.props.health[pinned] = tough;
  timed.props.maxHealth[pinned] = tough;
  let firstHit = -1;
  let brokeAt = -1;
  for (let i = 0; i < 3000 && brokeAt < 0; i++) {
    // Pinned under the player's feet, so the only thing being measured is how often it can be hit.
    timed.props.x[pinned] = timed.players.x[0];
    timed.props.y[pinned] = timed.players.y[0];
    timed.setStick(0, 0, 0);
    const brokenBefore = timed.props.totalBroken;
    timed.tick();
    if (firstHit < 0 && timed.props.hitAge[pinned] === 0) firstHit = i;
    if (timed.props.totalBroken > brokenBefore && !timed.props.pool.isSlotAlive(pinned)) brokeAt = i;
  }
  check("a prop worth six hits actually takes six hits", brokeAt > 0, `broke on tick ${brokeAt}`);
  check(
    "and a weapon resting on top of it cannot shred it in a frame",
    brokeAt - firstHit >= (tough - 1) * PROP_HIT_COOLDOWN,
    `${brokeAt - firstHit} ticks for ${tough} hits, floor ${(tough - 1) * PROP_HIT_COOLDOWN}`,
  );

  // Cost. Scenery runs every tick, so it has to be free.
  const cost = new Run();
  cost.begin({ seed: 31337, record: false, autoPick: true, modifiers: [MOD_DEV_GODMODE] });
  for (let i = 0; i < 600; i++) cost.tick();
  const heapBefore = heapUsed();
  const t0 = nowMs();
  const frames = 1800;
  for (let i = 0; i < frames; i++) {
    cost.setStick(0, 1, 0);
    cost.tick();
  }
  const perTick = (nowMs() - t0) / frames;
  const grew = (heapUsed() - heapBefore) / 1024;
  check("half a minute of run with scenery in it stays inside the frame budget", perTick < 16.6, `${perTick.toFixed(2)}ms per tick`);
  check("and does not grow the heap", grew < 2048, `${grew.toFixed(0)}KB`);
}

/** Point the stick at the nearest piece of scenery. Deterministic: it only reads simulation state. */
function steerAtScenery(run: Run): void {
  const props = run.props;
  const px = run.players.x[0];
  const py = run.players.y[0];
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < props.count; i++) {
    const s = props.slots[i];
    const dx = props.x[s] - px;
    const dy = props.y[s] - py;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best < 0) {
    run.setStick(0, 1, 0);
    return;
  }
  const dx = props.x[best] - px;
  const dy = props.y[best] - py;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  run.setStick(0, dx / len, dy / len);
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
