/**
 * Checks for the arcanas — the run-shaping cards offered a few times per run.
 * Run headless: `bun packages/mobile/game/sim/arcanas.test.ts`
 *
 * WHAT THIS FILE EXISTS TO PREVENT
 *
 * An arcana is the biggest single swing the player gets inside a run, which makes every failure here
 * loud. Three shapes matter, and the checks below are grouped by them.
 *
 * First: being handed a card that was never earned. The pool comes from outside this file, so the deck
 * has to refuse anything not in it — including a stale pick echoed back by another player's phone.
 *
 * Second: an offer that never comes, or comes twice. The marks are fixed run seconds, and a run that
 * jumps past one (a resumed run, a replay scrubbing forward, a co-op guest catching up) must still get
 * its offer. That exact bug already cost us a boss fight once, so it is checked here directly.
 *
 * Third: the numbers. Arcanas go through the same resolution as passives and modes, and the whole
 * point of that is that taking them in a different order cannot change the result. That property is
 * cheap to lose and impossible to notice by eye, so it is checked with real arithmetic rather than
 * asserted in a comment.
 */

import { Rng } from "../core/rng";
import {
  ARCANA_BY_WIRE,
  ARCANA_FLAG,
  ARCANA_MINUTE_MARKS,
  ARCANA_OFFERS,
  ARCANA_TYPES,
  ARCANA_UNLOCK,
  ARCANA_WIRE_BASE,
  ArcanaDeck,
  arcanaAt,
  arcanaConditionMet,
  arcanaContentFaults,
  arcanaIndexOf,
  arcanaUnlockText,
  MAX_ARCANAS,
  type ArcanaProgress,
} from "./arcanas";
import { MODIFIER_CATALOG, MODIFIER_SOURCE, ModifierStack } from "./modifiers";
import { STAT, STAT_SCALE, Stats } from "./stats";

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

const everyIndex = ARCANA_TYPES.map((_, i) => i);

function progress(bestAnywhereSeconds: number, bestByStageIndex: number[] = []): ArcanaProgress {
  return { bestAnywhereSeconds, bestByStageIndex };
}

// -------------------------------------------------------------------------------------------
// The catalog itself
// -------------------------------------------------------------------------------------------
{
  const faults = arcanaContentFaults();
  if (faults.length > 0) console.error("content faults: " + faults.join("; "));
  eq(faults.length, 0, "the arcana catalog passes its own content lint");

  ok(ARCANA_TYPES.length >= 8, "the launch set has at least the eight arcanas that were promised");
  eq(ARCANA_BY_WIRE.size, ARCANA_TYPES.length, "no two arcanas share a wire id");

  // An arcana wire id landing in the mode range would decode a replay header as the wrong rule.
  let clashes = 0;
  for (const m of MODIFIER_CATALOG) if (ARCANA_BY_WIRE.has(m.wireId)) clashes++;
  eq(clashes, 0, "no arcana wire id collides with a run modifier wire id");
  for (const a of ARCANA_TYPES) {
    ok(a.wireId >= ARCANA_WIRE_BASE, `${a.id} sits inside the reserved arcana wire range`);
    eq(a.modifier.source, MODIFIER_SOURCE.arcana, `${a.id} is sourced as an arcana`);
  }

  // Every arcana has to be findable by name and reachable by index, because the dev menu and the
  // unlock bridge both address them that way rather than by position in a list they copied.
  for (let i = 0; i < ARCANA_TYPES.length; i++) {
    eq(arcanaIndexOf(ARCANA_TYPES[i].id), i, `${ARCANA_TYPES[i].id} is found at its own index`);
  }
  eq(arcanaIndexOf("nothingLikeThis"), -1, "an unknown id is reported missing rather than guessed");

  eq(arcanaAt(-5).id, ARCANA_TYPES[0].id, "a negative index clamps to the first arcana");
  eq(
    arcanaAt(9999).id,
    ARCANA_TYPES[ARCANA_TYPES.length - 1].id,
    "an index past the end clamps to the last arcana",
  );

  // A card that only moves one stat upward is a passive in a bigger frame. Every arcana has to
  // either change a rule or cost something — this is a design promise worth failing a build over.
  let plainBonuses = 0;
  for (const a of ARCANA_TYPES) {
    if (a.flags !== 0) continue;
    let hasDownside = false;
    for (const d of a.modifier.deltas) {
      if (d.mul !== undefined && d.mul < STAT_SCALE) hasDownside = true;
      if (d.add !== undefined && d.add < 0) hasDownside = true;
      // A "worse for you" stat going up is also a downside.
      if (
        d.mul !== undefined &&
        d.mul > STAT_SCALE &&
        (d.stat === STAT.enemySpeed ||
          d.stat === STAT.enemyHealth ||
          d.stat === STAT.enemyDamage ||
          d.stat === STAT.spawnRate ||
          d.stat === STAT.curse)
      ) {
        hasDownside = true;
      }
    }
    if (!hasDownside) plainBonuses++;
  }
  eq(plainBonuses, 0, "no arcana is a pure upgrade with nothing given up for it");

  // Words on a card are content, and a blank one ships as an empty frame nobody notices.
  for (const a of ARCANA_TYPES) {
    ok(a.numeral.length > 0, `${a.id} has a numeral for its card`);
    ok(a.name.length > 0 && a.blurb.length > 0, `${a.id} has words on its card`);
  }
}

// -------------------------------------------------------------------------------------------
// Unlock conditions
// -------------------------------------------------------------------------------------------
{
  eq(ARCANA_TYPES[0].unlock.kind, ARCANA_UNLOCK.always, "the first arcana is available from the start");
  ok(
    arcanaConditionMet(ARCANA_TYPES[0], progress(0, [])),
    "a brand new profile has met the first arcana's condition",
  );

  const anywhere = ARCANA_TYPES.find((a) => a.unlock.kind === ARCANA_UNLOCK.surviveAnywhere);
  ok(anywhere !== undefined, "at least one arcana is earned by surviving anywhere");
  if (anywhere) {
    const need = anywhere.unlock.seconds;
    ok(!arcanaConditionMet(anywhere, progress(need - 1)), "one second short does not earn it");
    ok(arcanaConditionMet(anywhere, progress(need)), "exactly the time earns it");
    ok(arcanaConditionMet(anywhere, progress(need + 600)), "more than the time earns it");
    ok(
      !arcanaConditionMet(anywhere, progress(0, [need + 600])),
      "a long run in one place does not satisfy the anywhere rule through the wrong field",
    );
  }

  const staged = ARCANA_TYPES.find((a) => a.unlock.kind === ARCANA_UNLOCK.surviveStage);
  ok(staged !== undefined, "at least one arcana is earned in a specific place");
  if (staged) {
    const i = staged.unlock.stageIndex;
    const need = staged.unlock.seconds;
    const times: number[] = [];
    for (let k = 0; k <= i; k++) times.push(0);
    ok(!arcanaConditionMet(staged, progress(9999, times)), "a huge time elsewhere does not earn it");
    times[i] = need - 1;
    ok(!arcanaConditionMet(staged, progress(0, times)), "one second short in the right place misses");
    times[i] = need;
    ok(arcanaConditionMet(staged, progress(0, times)), "the right time in the right place earns it");

    // A profile migrated from an older build has a shorter list of per-place times. Reading past
    // the end must be a "not yet", never an undefined compared against a number.
    ok(!arcanaConditionMet(staged, progress(0, [])), "an empty per-place list reads as not yet");
    ok(
      !arcanaConditionMet(staged, progress(0, times.slice(0, i))),
      "a per-place list too short to hold this place reads as not yet",
    );
  }

  const names = ["Pauper's Crypt", "The Ossuary", "Mourner's Marsh"];
  for (const a of ARCANA_TYPES) {
    const text = arcanaUnlockText(a, names);
    ok(text.length > 0, `${a.id} says how it is earned`);
    ok(text.trim().endsWith("."), `${a.id}'s unlock line is a sentence`);
    if (a.unlock.kind === ARCANA_UNLOCK.surviveStage && a.unlock.stageIndex < names.length) {
      ok(text.includes(names[a.unlock.stageIndex]), `${a.id} names the place you have to survive in`);
    }
    if (a.unlock.kind !== ARCANA_UNLOCK.always) {
      ok(
        text.includes(String(Math.floor(a.unlock.seconds / 60))),
        `${a.id} says how many minutes are needed`,
      );
    }
  }
  // A stage name list shorter than the rule asks for must still produce a sentence, not "undefined".
  ok(
    !arcanaUnlockText(ARCANA_TYPES[ARCANA_TYPES.length - 1], []).includes("undefined"),
    "a missing stage name never leaks the word undefined onto a card",
  );
}

// -------------------------------------------------------------------------------------------
// Offers
// -------------------------------------------------------------------------------------------
{
  const deck = new ArcanaDeck();
  const rng = new Rng(12345);

  deck.begin(everyIndex);
  eq(deck.poolSize, ARCANA_TYPES.length, "the pool is what was handed in");
  eq(deck.open, false, "a run does not start with an offer already on screen");

  eq(deck.update(ARCANA_MINUTE_MARKS[0] - 1, rng), false, "no offer before the first mark");
  eq(deck.open, false, "and the screen stays shut");

  eq(deck.update(ARCANA_MINUTE_MARKS[0], rng), true, "the first offer opens exactly on its mark");
  eq(deck.open, true, "the screen is up");
  eq(deck.offerCount, ARCANA_OFFERS, "a full pool fills every offer slot");
  eq(deck.update(ARCANA_MINUTE_MARKS[0] + 30, rng), false, "an open offer is not reopened each tick");
  eq(deck.offerCount, ARCANA_OFFERS, "and the cards on screen do not change underneath the player");

  // A player can leave an offer on screen for a long time — the run is paused, but a resumed run or a
  // replay scrubbing forward can hand the deck a second well past the *next* mark. That must not
  // redeal the cards under the player's finger, and must not burn the mark they have not answered yet.
  const beforeCards = Array.from(deck.offerIndex);
  eq(
    deck.update(ARCANA_MINUTE_MARKS[ARCANA_MINUTE_MARKS.length - 1] + 500, rng),
    false,
    "an offer left open is not replaced when the run runs on past the next mark",
  );
  eq(deck.open, true, "the same screen is still up");
  eq(deck.offersMade, 1, "and no further mark has been spent");
  eq(
    Array.from(deck.offerIndex).join(","),
    beforeCards.join(","),
    "with exactly the same three cards on it",
  );

  // Duplicate cards on one screen would look like a bug and waste a choice.
  const seen = new Set<number>();
  for (let i = 0; i < deck.offerCount; i++) seen.add(deck.offerIndex[i]);
  eq(seen.size, deck.offerCount, "no arcana appears twice on the same screen");
  for (let i = 0; i < deck.offerCount; i++) {
    ok(deck.offerIndex[i] >= 0 && deck.offerIndex[i] < ARCANA_TYPES.length, "every offer is real");
  }

  const taken = deck.take(0);
  ok(taken >= 0, "taking the first card returns which arcana it was");
  eq(deck.open, false, "taking a card closes the screen");
  eq(deck.heldCount, 1, "and the arcana is held");
  ok(deck.holds(taken), "the deck says it holds what it just handed over");
  eq(deck.offerCount, 0, "the offer slots are emptied so a stale card cannot be taken twice");
  eq(deck.take(0), -1, "taking again with the screen shut is refused");

  // Second offer, and the card already held must not come round again.
  eq(deck.update(ARCANA_MINUTE_MARKS[1], rng), true, "the second offer opens on its own mark");
  let repeats = 0;
  for (let i = 0; i < deck.offerCount; i++) if (deck.offerIndex[i] === taken) repeats++;
  eq(repeats, 0, "an arcana already held is never offered again");
  eq(deck.take(deck.offerCount), -1, "a slot past the end of the offer is refused");
  eq(deck.take(-1), -1, "a negative slot is refused");
  eq(deck.heldCount, 1, "and neither refusal handed anything over");
  deck.take(0);
  eq(deck.heldCount, 2, "the second card is held");

  eq(deck.update(ARCANA_MINUTE_MARKS[2], rng), true, "the third offer opens");
  deck.take(0);
  eq(deck.heldCount, MAX_ARCANAS, "three offers fill the three slots");
  eq(deck.update(99999, rng), false, "there is no fourth offer once the slots are full");
  eq(deck.nextMarkSecond(), -1, "and the deck reports no mark left");

  const heldSeen = new Set<number>();
  for (let i = 0; i < deck.heldCount; i++) heldSeen.add(deck.heldIndex[i]);
  eq(heldSeen.size, MAX_ARCANAS, "the three held arcanas are three different arcanas");
}

// -------------------------------------------------------------------------------------------
// Awkward runs: a jump past a mark, a tiny pool, an empty pool
// -------------------------------------------------------------------------------------------
{
  // The exact bug the wave director had: a mark that came due while the run was elsewhere.
  const deck = new ArcanaDeck();
  const rng = new Rng(7);
  deck.begin(everyIndex);
  eq(deck.update(ARCANA_MINUTE_MARKS[0] + 500, rng), true, "a run that jumps past a mark still offers");
  deck.take(0);
  eq(deck.update(ARCANA_MINUTE_MARKS[1] + 5, rng), true, "and the next mark is still owed after that");
}

{
  const deck = new ArcanaDeck();
  const rng = new Rng(99);
  deck.begin([0]);
  eq(deck.poolSize, 1, "a profile with one arcana unlocked has a pool of one");
  eq(deck.update(ARCANA_MINUTE_MARKS[0], rng), true, "and still gets an offer");
  eq(deck.offerCount, 1, "with as many cards as it can honestly show");
  eq(deck.take(0), 0, "which can be taken");
  eq(deck.update(ARCANA_MINUTE_MARKS[1], rng), false, "the next mark has nothing left to offer");
  eq(deck.open, false, "so no empty screen is put up that the player cannot dismiss");
}

{
  const deck = new ArcanaDeck();
  const rng = new Rng(1);
  deck.begin([]);
  eq(deck.poolSize, 0, "an empty pool stays empty");
  eq(deck.update(ARCANA_MINUTE_MARKS[0], rng), false, "and never opens an offer");
  eq(deck.open, false, "nor invents a card the profile has not earned");
}

{
  const deck = new ArcanaDeck();
  // Rubbish from a save file or a link: out of range, and the same index twice.
  deck.begin([-1, 0, 0, ARCANA_TYPES.length, ARCANA_TYPES.length + 40, 1]);
  eq(deck.poolSize, 2, "out-of-range and repeated entries are dropped from the pool");
}

{
  // Taking a card, not just restoring one, has to turn its behaviour on. These are two different code
  // paths and only one of them is what actually happens during a run.
  const flagged = ARCANA_TYPES.findIndex((a) => a.flags !== 0);
  const deck = new ArcanaDeck();
  const rng = new Rng(31337);
  deck.begin([flagged]);
  eq(deck.update(ARCANA_MINUTE_MARKS[0], rng), true, "the one unlocked arcana is offered");
  eq(deck.flags, 0, "nothing is switched on while the card is only being offered");
  eq(deck.take(0), flagged, "taking it hands back that arcana");
  eq(deck.flags, ARCANA_TYPES[flagged].flags, "and taking it switches its rule on");
  ok(deck.has(ARCANA_TYPES[flagged].flags), "which the sim can read straight off the deck");
}

// -------------------------------------------------------------------------------------------
// Determinism — the property replays and co-op both depend on
// -------------------------------------------------------------------------------------------
{
  function playOut(seed: number): string {
    const deck = new ArcanaDeck();
    const rng = new Rng(seed);
    deck.begin(everyIndex);
    const picks: number[] = [];
    for (const mark of ARCANA_MINUTE_MARKS) {
      if (!deck.update(mark, rng)) continue;
      picks.push(...Array.from(deck.offerIndex.slice(0, deck.offerCount)));
      deck.take(0);
    }
    return picks.join(",");
  }
  eq(playOut(4242), playOut(4242), "the same seed offers exactly the same cards in the same order");
  ok(playOut(4242) !== playOut(4243), "a different seed offers something different");
}

// -------------------------------------------------------------------------------------------
// Behaviour bits and the numbers
// -------------------------------------------------------------------------------------------
{
  const deck = new ArcanaDeck();
  eq(deck.flags, 0, "a fresh deck turns nothing on");

  const withFlag = ARCANA_TYPES.findIndex((a) => a.flags !== 0);
  ok(withFlag >= 0, "at least one arcana changes a rule rather than a number");
  deck.restore([withFlag]);
  eq(deck.heldCount, 1, "restoring puts the arcana back in hand");
  eq(deck.flags, ARCANA_TYPES[withFlag].flags, "and turns its behaviour back on");
  ok(deck.has(ARCANA_TYPES[withFlag].flags), "which the sim can ask about with one integer");
  ok(!deck.has(1 << 30), "a bit nothing turns on reads as off");

  deck.restore([withFlag, withFlag]);
  eq(deck.heldCount, 1, "restoring the same arcana twice holds it once");
  deck.restore([0, 1, 2, 3, 4, 5]);
  eq(deck.heldCount, MAX_ARCANAS, "restoring more than fits stops at the limit");
  deck.restore([-3, 9999]);
  eq(deck.heldCount, 0, "restoring nothing but rubbish holds nothing");
  eq(deck.flags, 0, "and turns everything back off");

  const out = new Int32Array(MAX_ARCANAS);
  deck.restore([0, 1]);
  eq(deck.wireIds(out), 2, "the held arcanas can be written to a join packet");
  eq(out[0], ARCANA_TYPES[0].wireId, "as wire ids, not indices");
  eq(ARCANA_BY_WIRE.get(out[1])?.id, ARCANA_TYPES[1].id, "which decode back to the same arcanas");
}

{
  // Resolution order must not matter. Taking the same two arcanas in the other order has to land on
  // exactly the same stats, or two co-op phones drift apart and every state hash disagrees.
  function resolveWith(order: number[]): string {
    const deck = new ArcanaDeck();
    deck.restore(order);
    const stack = new ModifierStack();
    stack.clearLoadout();
    deck.applyTo(stack);
    const stats = new Stats();
    stack.resolve(stats);
    return Array.from(stats.values).join(",");
  }
  eq(resolveWith([1, 3]), resolveWith([3, 1]), "the order two arcanas were taken in changes nothing");
  eq(resolveWith([0, 2, 5]), resolveWith([5, 0, 2]), "and the same holds for three of them");

  const plain = resolveWith([]);
  ok(resolveWith([1]) !== plain, "an arcana actually changes the numbers");

  const deck = new ArcanaDeck();
  deck.restore([0, 1, 2]);
  const stack = new ModifierStack();
  eq(deck.applyTo(stack), 3, "every held arcana reaches the modifier stack");
  eq(stack.loadoutSize, 3, "as loadout records");
  eq(stack.size, 0, "and never as run modifiers, which would put them in the replay header");
}

{
  // The armoured arcana is the one with a flat addition rather than a multiplier, and flat additions
  // are where a permille mix-up would hide. Check the actual arithmetic once, by hand.
  const iron = ARCANA_TYPES.find((a) => a.id === "ironLitany");
  ok(iron !== undefined, "the armoured arcana is in the catalog");
  if (iron) {
    const stack = new ModifierStack();
    const stats = new Stats();
    stats.reset();
    const baseArmor = stats.values[STAT.armor];
    const baseSpeed = stats.values[STAT.moveSpeed];
    stack.addLoadout(iron.modifier);
    stack.resolve(stats);
    eq(stats.values[STAT.armor], baseArmor + 8, "armour goes up by the flat amount on the card");
    ok(stats.values[STAT.moveSpeed] < baseSpeed, "and movement is genuinely slower for it");
  }
}

{
  // The flags in the catalog must be the ones the sim was written against. A renamed or renumbered
  // bit that nothing checks would silently switch an arcana's rule off.
  const mirrored = ARCANA_TYPES.find((a) => (a.flags & ARCANA_FLAG.mirroredStarter) !== 0);
  const burns = ARCANA_TYPES.find((a) => (a.flags & ARCANA_FLAG.healingBurns) !== 0);
  const crit = ARCANA_TYPES.find((a) => (a.flags & ARCANA_FLAG.critAtFullHealth) !== 0);
  const burst = ARCANA_TYPES.find((a) => (a.flags & ARCANA_FLAG.gemBurst) !== 0);
  const weaponsOnly = ARCANA_TYPES.find((a) => (a.flags & ARCANA_FLAG.weaponsOnlyCards) !== 0);
  const coins = ARCANA_TYPES.find((a) => (a.flags & ARCANA_FLAG.coinsFeedTheLevel) !== 0);
  ok(mirrored !== undefined, "something mirrors the starting weapon");
  ok(burns !== undefined, "something makes healing burn");
  ok(crit !== undefined, "something crits at full health");
  ok(burst !== undefined, "something detonates large gems");
  ok(weaponsOnly !== undefined, "something narrows the cards to weapons");
  ok(coins !== undefined, "something turns coins into experience");
}

console.log(`arcanas.test: ${checks} checks, ${failures} failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`arcanas: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
