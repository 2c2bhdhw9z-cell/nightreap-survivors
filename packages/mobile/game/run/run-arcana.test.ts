/**
 * The run's arcana wiring. Run headless: `bun packages/mobile/game/run/run-arcana.test.ts`
 *
 * The deck itself is proved by `game/sim/arcanas.test.ts`. What that file cannot prove is that the
 * deck is actually plugged into the run: that an offer freezes the world, that a pick survives the
 * next loadout rebuild, that a profile which has unlocked nothing is never handed a card, and that
 * two machines given the same seed and the same unlocked pool end up holding the same arcanas.
 *
 * WHAT IT PROVES
 *   1. An empty pool never opens an offer, no matter how long the run goes.
 *   2. A stocked pool opens an offer at the first mark, and that offer freezes the simulation.
 *   3. Taking a card puts it in the loadout and it is still there after the next level-up rebuild.
 *   4. A slot that is not a real offer is refused and leaves the screen up.
 *   5. Refusing spends the offer — the same mark does not come back around.
 *   6. Auto-pick answers the screen so an unattended run cannot deadlock.
 *   7. Same seed and same pool give the same arcanas; a different pool gives a different world.
 *   8. Starting a new run forgets what the last one held.
 */

import { ARCANA_MINUTE_MARKS, ARCANA_TYPES, MAX_ARCANAS } from "../sim/arcanas";
import { MOD_DEV_GODMODE } from "../sim/modifiers";
import { TICKS_PER_SECOND } from "../sim/waves";
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

/** Every arcana index, which is what a profile that has unlocked everything hands the run. */
const FULL_POOL = ARCANA_TYPES.map((_, i) => i);

/** The first mark, in ticks, plus a little slack so a run reliably reaches it. */
const FIRST_MARK_TICKS = (ARCANA_MINUTE_MARKS[0] as number) * TICKS_PER_SECOND + 240;

/**
 * Drive a run, answering card screens but deliberately *not* answering arcana screens.
 *
 * Stopping at the offer is the point: every test below wants to inspect the run while the offer is
 * still on the table. Returns true when it stopped because an offer opened.
 */
function driveToOffer(run: Run, ticks: number, pick = 0): boolean {
  for (let i = 0; i < ticks; i++) {
    if (run.arcanas.open) return true;
    const a = (i / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    if (run.paused) {
      run.pickCard(pick);
      continue;
    }
    if (run.over) return false;
    run.tick();
  }
  return run.arcanas.open;
}

/** Drive a run answering everything, arcana screens included. Used for the determinism pass. */
function driveAll(run: Run, ticks: number, arcanaSlot = 0): void {
  for (let i = 0; i < ticks; i++) {
    const a = (i / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    if (run.arcanas.open) {
      run.pickArcana(arcanaSlot);
      continue;
    }
    if (run.paused) {
      run.pickCard(0);
      continue;
    }
    if (run.over) return;
    run.tick();
  }
}

// ---------------------------------------------------------------------------------------------
section("1. a profile that has unlocked nothing is never offered a card");

{
  const run = new Run();
  run.begin({ seed: 4001, modifiers: [MOD_DEV_GODMODE], record: false });
  check("the default pool is empty", run.arcanas.poolSize === 0, `${run.arcanas.poolSize}`);

  const opened = driveToOffer(run, FIRST_MARK_TICKS);
  check("the run passed the first mark", run.waves.runSeconds >= (ARCANA_MINUTE_MARKS[0] as number));
  check("no offer ever opened", !opened && !run.arcanas.open);
  check("and nothing is held", run.arcanas.heldCount === 0);
  check("so no arcana behaviour is switched on", run.arcanaFlags === 0);
}

// ---------------------------------------------------------------------------------------------
section("2. an unlocked pool opens an offer at the first mark, and it freezes the run");

{
  const run = new Run();
  run.begin({ seed: 4002, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  check("the pool is what the profile unlocked", run.arcanas.poolSize === ARCANA_TYPES.length);

  const opened = driveToOffer(run, FIRST_MARK_TICKS);
  check("an offer opened", opened, `at ${Math.trunc(run.waves.runSeconds)}s`);
  check(
    "it did not open early",
    run.waves.runSeconds >= (ARCANA_MINUTE_MARKS[0] as number),
    `${Math.trunc(run.waves.runSeconds)}s`,
  );
  check("cards are on the table", run.arcanas.offerCount > 0, `${run.arcanas.offerCount} cards`);
  check("the run reports itself paused", run.paused);

  // The whole point of a pause: ticking must not move the world on.
  const ticksBefore = run.runTicks;
  const killsBefore = run.kills;
  for (let i = 0; i < 120; i++) run.tick();
  check("ticking does not advance the clock while an offer is up", run.runTicks === ticksBefore);
  check("and nothing dies while an offer is up", run.kills === killsBefore);
  check("the offer is still up", run.arcanas.open);
}

// ---------------------------------------------------------------------------------------------
section("3. taking a card puts it in the loadout, and a rebuild does not lose it");

{
  const run = new Run();
  run.begin({ seed: 4003, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  check("an offer opened", driveToOffer(run, FIRST_MARK_TICKS));

  const before = new Int32Array(run.stats.values);
  const offered = run.arcanas.offerIndex[0] as number;
  const took = run.pickArcana(0);

  check("the pick returns the card that was on the table", took === offered, `${took} vs ${offered}`);
  check("the screen closed", !run.arcanas.open && run.arcanas.offerCount === 0);
  check("the run holds it", run.arcanas.holds(took) && run.arcanas.heldCount === 1);
  check(
    "its behaviour bits are switched on",
    (run.arcanaFlags & (ARCANA_TYPES[took] as { flags: number }).flags) ===
      (ARCANA_TYPES[took] as { flags: number }).flags,
  );

  let moved = 0;
  for (let i = 0; i < run.stats.values.length; i++) {
    if (before[i] !== run.stats.values[i]) moved++;
  }
  check("taking it moved the numbers", moved > 0, `${moved} stats changed`);

  // The loadout is cleared and rebuilt on every level-up. An arcana that was patched in rather than
  // rebuilt in would silently vanish the next time the player levelled.
  const levelBefore = run.prog.level;
  driveAll(run, 60 * TICKS_PER_SECOND);
  check("the player levelled again", run.prog.level > levelBefore, `level ${run.prog.level}`);
  check("the arcana is still held after a rebuild", run.arcanas.holds(took));
  check(
    "and its behaviour is still switched on",
    (run.arcanaFlags & (ARCANA_TYPES[took] as { flags: number }).flags) ===
      (ARCANA_TYPES[took] as { flags: number }).flags,
  );
  check("no more than the cap is ever held", run.arcanas.heldCount <= MAX_ARCANAS);
}

// ---------------------------------------------------------------------------------------------
section("4. a slot that is not a real offer is refused");

{
  const run = new Run();
  run.begin({ seed: 4004, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  check("an offer opened", driveToOffer(run, FIRST_MARK_TICKS));

  const count = run.arcanas.offerCount;
  check("a negative slot is refused", run.pickArcana(-1) === -1);
  check("a slot past the end is refused", run.pickArcana(count + 5) === -1);
  check("nothing was taken", run.arcanas.heldCount === 0);
  check("and the offer is still on the table", run.arcanas.open && run.arcanas.offerCount === count);

  const real = run.pickArcana(count - 1);
  check("the last real slot is accepted", real >= 0 && run.arcanas.heldCount === 1);
  check("taking from a closed screen is refused", run.pickArcana(0) === -1);
}

// ---------------------------------------------------------------------------------------------
section("5. refusing an offer spends it");

{
  const run = new Run();
  run.begin({ seed: 4005, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  check("an offer opened", driveToOffer(run, FIRST_MARK_TICKS));

  const made = run.arcanas.offersMade;
  run.closeArcanaOffer();
  check("the screen closed", !run.arcanas.open && run.arcanas.offerCount === 0);
  check("nothing is held", run.arcanas.heldCount === 0 && run.arcanaFlags === 0);
  check("the run is running again", !run.paused);
  check("the offer counted as made", run.arcanas.offersMade === made);
  check(
    "the next offer is a later mark, not the same one again",
    run.arcanas.nextMarkSecond() > (ARCANA_MINUTE_MARKS[0] as number) ||
      run.arcanas.nextMarkSecond() === -1,
    `${run.arcanas.nextMarkSecond()}`,
  );

  // And the run keeps going normally rather than re-opening the spent mark every tick.
  const ticksBefore = run.runTicks;
  driveToOffer(run, 600);
  check("the clock moved on", run.runTicks > ticksBefore);
  check("the spent mark did not come back", !run.arcanas.open);
}

// ---------------------------------------------------------------------------------------------
section("6. an unattended run answers its own offer");

{
  const run = new Run();
  run.begin({
    seed: 4006,
    modifiers: [MOD_DEV_GODMODE],
    record: false,
    autoPick: true,
    arcanaPool: FULL_POOL,
  });

  // Nothing here answers a screen: the run has to unstick itself or the loop deadlocks.
  for (let i = 0; i < FIRST_MARK_TICKS + 600; i++) {
    run.setStick(0, 1, 0);
    if (run.over) break;
    run.tick();
  }
  check("the run got past the first mark", run.waves.runSeconds >= (ARCANA_MINUTE_MARKS[0] as number));
  check("an arcana was taken automatically", run.arcanas.heldCount > 0, `${run.arcanas.heldCount}`);
  check("no screen is stuck open", !run.arcanas.open);
}

// ---------------------------------------------------------------------------------------------
section("7. the same seed and the same pool give the same arcanas");

{
  const a = new Run();
  a.begin({ seed: 4007, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  driveAll(a, FIRST_MARK_TICKS + 600);

  const b = new Run();
  b.begin({ seed: 4007, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  driveAll(b, FIRST_MARK_TICKS + 600);

  check("both runs took something", a.arcanas.heldCount > 0);
  check(
    "both runs hold the same arcanas",
    a.arcanas.heldCount === b.arcanas.heldCount && a.arcanas.heldIndex[0] === b.arcanas.heldIndex[0],
    `${a.arcanas.heldIndex[0]} vs ${b.arcanas.heldIndex[0]}`,
  );
  check("and the worlds match", a.hashState(0x811c9dc5) === b.hashState(0x811c9dc5));

  // A pool of exactly one card proves the pool is really what the draw reads, not the catalog.
  const narrow = new Run();
  const only = ARCANA_TYPES.length - 1;
  narrow.begin({ seed: 4007, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: [only] });
  driveAll(narrow, FIRST_MARK_TICKS + 600);
  check("a one-card pool offers only that card", narrow.arcanas.heldIndex[0] === only, `${only}`);
  check("and it is only ever offered once", narrow.arcanas.heldCount === 1);
  // The one card in that pool has real behaviour bits, so this also proves the run's flag reader is
  // reading the deck rather than answering zero.
  const onlyFlags = (ARCANA_TYPES[only] as { flags: number }).flags;
  check("the card chosen for this check actually has behaviour", onlyFlags !== 0, `${onlyFlags}`);
  check("the run reports exactly that behaviour", narrow.arcanaFlags === onlyFlags, `${narrow.arcanaFlags}`);
  check(
    "a narrower pool is a different world",
    narrow.hashState(0x811c9dc5) !== a.hashState(0x811c9dc5),
  );
}

// ---------------------------------------------------------------------------------------------
section("8. a new run forgets the last one's arcanas");

{
  const run = new Run();
  run.begin({ seed: 4008, modifiers: [MOD_DEV_GODMODE], record: false, arcanaPool: FULL_POOL });
  driveAll(run, FIRST_MARK_TICKS + 600);
  const carried = run.arcanas.heldCount;
  check("the first run held something", carried > 0);

  run.begin({ seed: 4009, modifiers: [MOD_DEV_GODMODE], record: false });
  check("the new run holds nothing", run.arcanas.heldCount === 0);
  check("no behaviour carried over", run.arcanaFlags === 0);
  check("and the pool was replaced, not added to", run.arcanas.poolSize === 0);
  check("nor is a screen left open", !run.arcanas.open && !run.paused);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`run-arcana: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
