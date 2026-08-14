/**
 * Passive item self-check. Run headless: `bun packages/mobile/game/sim/passives.test.ts`
 *
 * WHY THIS FILE EXISTS
 * Passives are the largest block of pure content in the game and the one most likely to be edited by
 * hand at two in the morning. Every failure mode is silent: a row with four levels instead of five is a
 * passive that stops levelling with no error; a repeated wire id means an old save quietly loads the
 * wrong item; a level with no deltas is a card that costs a pick and does nothing. None of that shows up
 * as a crash, and none of it is visible in a screenshot, so it is checked here instead.
 *
 * WHAT IT PROVES
 *   1. Every row is well formed: five levels, a name, a blurb, words on every level.
 *   2. Ids, wire ids and sprites are each unique, and wire ids are the append-only run 1..N.
 *   3. No level is a no-op — every one moves at least one stat by a nonzero amount.
 *   4. Every delta names a real stat, and counts stay counts while percentages stay permille.
 *   5. `PASSIVE_MODIFIERS` is one record per level, numbered in its own reserved range, with no
 *      collisions against itself or against the run-modifier catalog.
 *   6. A record's words are the same words the content row shows, so a card cannot lie.
 *   7. The store's contract: grant, level, cap at five, refuse an unowned item when full, report levels.
 *   8. `applyTo` rebuilds rather than patches — every owned level folds in exactly once, and a rebuild
 *      after a change never leaves a trace of the previous loadout.
 *   9. Folding is order-independent: two players who took the same levels in a different order reach
 *      identical stats, which is what a replay and a co-op guest both depend on.
 *  10. It costs nothing per pick: a thousand rebuilds allocate no memory.
 */

import { MODIFIERS_BY_WIRE_ID, ModifierStack, type RunModifier } from "./modifiers";
import {
  MAX_PASSIVE_LEVEL,
  MAX_PASSIVES,
  PASSIVE_BY_ID,
  PASSIVE_BY_WIRE_ID,
  PASSIVE_MODIFIERS,
  PASSIVE_TYPES,
  PassiveStore,
  type LoadoutSink,
} from "./passives";
import { STAT, STAT_COUNT, Stats } from "./stats";

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

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
    gc?: () => void;
  };
  host.gc?.();
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

/** Counts, not permille: these stats are whole things and a permille value in one is a hundred of it. */
const COUNT_STATS: readonly number[] = [
  STAT.armor,
  STAT.amount,
  STAT.pierce,
  STAT.revives,
  STAT.iFrames,
  STAT.rerolls,
  STAT.skips,
  STAT.banishes,
];

/* ---- 1/2. every row is well formed ------------------------------------------------------------- */

section("1. Every passive row is well formed");

check("there are passives to check at all", PASSIVE_TYPES.length > 0, `${PASSIVE_TYPES.length} rows`);

{
  let badLevels = 0;
  let missingWords = 0;
  let missingNames = 0;
  for (const p of PASSIVE_TYPES) {
    if (p.levels.length !== MAX_PASSIVE_LEVEL) badLevels++;
    if (p.name.trim() === "" || p.blurb.trim() === "" || p.id.trim() === "") missingNames++;
    for (const lvl of p.levels) if (lvl.text.trim() === "") missingWords++;
  }
  check("every passive has exactly five levels", badLevels === 0, `${badLevels} wrong`);
  check("every passive has an id, a name and a blurb", missingNames === 0, `${missingNames} incomplete`);
  check("every level has words for its card", missingWords === 0, `${missingWords} blank`);
}

{
  const ids = new Set(PASSIVE_TYPES.map((p) => p.id));
  const wires = new Set(PASSIVE_TYPES.map((p) => p.wireId));
  const sprites = new Set(PASSIVE_TYPES.map((p) => p.sprite));
  check("ids are unique", ids.size === PASSIVE_TYPES.length, `${ids.size} of ${PASSIVE_TYPES.length}`);
  check("wire ids are unique", wires.size === PASSIVE_TYPES.length, `${wires.size} distinct`);
  // Two passives sharing a picture is not a crash, it is a collection screen where the player cannot
  // tell two items apart. Cheap to check, impossible to notice by eye once the list is this long.
  check("no two passives wear the same picture", sprites.size === PASSIVE_TYPES.length, `${sprites.size} distinct`);

  // Append-only means the numbers are 1..N with nothing skipped and nothing reordered. A gap is not
  // fatal on its own, but it is always a symptom: a deleted row, or a renumbering that broke old saves.
  let expected = 1;
  let outOfOrder = 0;
  for (const p of PASSIVE_TYPES) {
    if (p.wireId !== expected) outOfOrder++;
    expected++;
  }
  check("wire ids run 1..N in order, so nothing was renumbered", outOfOrder === 0, `${outOfOrder} off`);
  check("the id lookup covers every row", PASSIVE_BY_ID.size === PASSIVE_TYPES.length);
  check("the wire lookup covers every row", PASSIVE_BY_WIRE_ID.size === PASSIVE_TYPES.length);
  const first = PASSIVE_TYPES[0];
  check("a lookup by id returns that row", PASSIVE_TYPES[PASSIVE_BY_ID.get(first.id) ?? -1] === first);
  check(
    "a lookup by wire id returns that row",
    PASSIVE_TYPES[PASSIVE_BY_WIRE_ID.get(first.wireId) ?? -1] === first,
  );
}

/* ---- 3/4. no level is a no-op ------------------------------------------------------------------- */

section("2. No level costs a pick and gives nothing");

{
  let emptyLevels = 0;
  let zeroDeltas = 0;
  let unknownStats = 0;
  let absurdCounts = 0;
  for (const p of PASSIVE_TYPES) {
    for (const lvl of p.levels) {
      if (lvl.deltas.length === 0) {
        emptyLevels++;
        continue;
      }
      let moved = false;
      for (const d of lvl.deltas) {
        if (d.stat < 0 || d.stat >= STAT_COUNT) unknownStats++;
        const add = d.add ?? 0;
        const mul = d.mul ?? 0;
        if (add !== 0 || mul !== 0) moved = true;
        // A count stat measured in permille is the classic paste error: "+1 armour" written as 1000
        // reads as a thousand armour and makes the run unloseable. Nothing legitimate needs 50 of any
        // of these from one level of one passive.
        if (COUNT_STATS.includes(d.stat) && Math.abs(add) > 50) absurdCounts++;
      }
      if (!moved) zeroDeltas++;
    }
  }
  check("no level has an empty effect list", emptyLevels === 0, `${emptyLevels} empty`);
  check("every level actually moves a number", zeroDeltas === 0, `${zeroDeltas} inert`);
  check("every effect names a real stat", unknownStats === 0, `${unknownStats} unknown`);
  check("counted stats are counts, not permille", absurdCounts === 0, `${absurdCounts} suspicious`);
}

/* ---- 5/6. the modifier records ------------------------------------------------------------------ */

section("3. One record per level, in its own numbering range");

{
  check("one record list per passive", PASSIVE_MODIFIERS.length === PASSIVE_TYPES.length);
  let wrongLength = 0;
  let wrongWords = 0;
  let wrongDeltas = 0;
  const seen = new Set<number>();
  let collisions = 0;
  let leakedIntoCatalog = 0;
  let belowRange = 0;
  for (let i = 0; i < PASSIVE_TYPES.length; i++) {
    const type = PASSIVE_TYPES[i];
    const list = PASSIVE_MODIFIERS[i];
    if (list.length !== MAX_PASSIVE_LEVEL) wrongLength++;
    for (let l = 0; l < list.length; l++) {
      const mod = list[l];
      // The card reads its words off the content row and the stats come off the record; if these two
      // ever disagreed the game would show one thing and do another, which is the bug players never
      // report and never forgive.
      if (mod.description !== type.levels[l].text) wrongWords++;
      if (mod.deltas !== type.levels[l].deltas) wrongDeltas++;
      if (seen.has(mod.wireId)) collisions++;
      seen.add(mod.wireId);
      if (mod.wireId < 100_000) belowRange++;
      // A passive record must never be resolvable as a run modifier: if one leaked into a replay
      // header it has to fail to decode loudly rather than decode as Hurry or an Ascension tier.
      if (MODIFIERS_BY_WIRE_ID.has(mod.wireId)) leakedIntoCatalog++;
    }
  }
  check("every passive has five records", wrongLength === 0, `${wrongLength} wrong`);
  check("each record says exactly what its card says", wrongWords === 0, `${wrongWords} disagree`);
  check("each record carries the row's own effects", wrongDeltas === 0, `${wrongDeltas} copied`);
  check("no two records share a number", collisions === 0, `${seen.size} numbers`);
  check("every record sits above the reserved line", belowRange === 0, `${belowRange} below`);
  check("no record can be mistaken for a run modifier", leakedIntoCatalog === 0, `${leakedIntoCatalog} clash`);

  // Spacing is what makes the range safe to extend: a hundred numbers per passive means five levels
  // today and room for more without ever touching the next passive's block.
  const a = PASSIVE_MODIFIERS[0][0].wireId;
  const b = PASSIVE_MODIFIERS[1]?.[0].wireId ?? a + 100;
  check("consecutive passives are a hundred apart", b - a === 100, `${a} then ${b}`);
}

/* ---- 7. the store ------------------------------------------------------------------------------- */

section("4. The store hands out passives the way the card screen expects");

{
  const store = new PassiveStore();
  store.reset(1);
  check("a fresh store is empty", store.countFor(0) === 0);
  check("nothing is owned yet", store.levelOf(0, 0) === 0);
  check("an unowned passive has no slot", store.slotOf(0, 0) === -1);

  check("granting returns level one", store.grant(0, 0) === 1);
  check("granting again levels it", store.grant(0, 0) === 2);
  check("the level reads back", store.levelOf(0, 0) === 2, `${store.levelOf(0, 0)}`);
  check("it took exactly one slot", store.countFor(0) === 1, `${store.countFor(0)} slots`);

  for (let i = 0; i < 10; i++) store.grant(0, 0);
  check("it stops at five", store.levelOf(0, 0) === MAX_PASSIVE_LEVEL, `${store.levelOf(0, 0)}`);
  check("and reports itself maxed", store.isMaxed(0, 0));
  check("a different passive is not maxed", !store.isMaxed(0, 1));

  // Filling up is a normal situation the card screen asks about every level, not an error: it needs a
  // plain "no" so it can offer a level-up instead of a new item.
  for (let i = 1; i < MAX_PASSIVES; i++) store.grant(0, i);
  check("the loadout fills", store.isFull(0), `${store.countFor(0)} of ${MAX_PASSIVES}`);
  check("a full loadout refuses a new passive", store.grant(0, MAX_PASSIVES) === 0);
  check("and refusing it did not overwrite a slot", store.countFor(0) === MAX_PASSIVES);
  check("but an owned one still levels when full", store.grant(0, 1) === 2, `${store.levelOf(0, 1)}`);

  // Players must not be able to see each other's items: the flat arrays are one shared buffer, so an
  // off-by-one in the slot arithmetic would show up here and nowhere else.
  const party = new PassiveStore();
  party.reset(4);
  party.grant(2, 3);
  check("granting to one player leaves the others empty", party.countFor(0) === 0 && party.countFor(1) === 0);
  check("the right player got it", party.levelOf(2, 3) === 1 && party.levelOf(3, 3) === 0);

  party.devSetLevel(1, 4, 5);
  check("the dev menu can set a level outright", party.levelOf(1, 4) === 5);
  party.devSetLevel(1, 5, 99);
  check("and cannot set one past the cap", party.levelOf(1, 5) === MAX_PASSIVE_LEVEL);
  party.devSetLevel(1, 6, 0);
  check("setting level zero grants nothing", party.levelOf(1, 6) === 0);

  party.reset(2);
  check("resetting clears everyone", party.countFor(0) === 0 && party.countFor(1) === 0);
  check("and clamps the player count", party.playerCount === 2, `${party.playerCount}`);
}

/* ---- 8/9. folding ------------------------------------------------------------------------------- */

section("5. The loadout is rebuilt, never patched");

/** A sink that remembers what it was handed, so a rebuild can be inspected rather than inferred. */
class RecordingSink implements LoadoutSink {
  clears = 0;
  readonly added: RunModifier[] = [];
  clearLoadout(): void {
    this.clears++;
    this.added.length = 0;
  }
  addLoadout(mod: RunModifier): boolean {
    this.added.push(mod);
    return true;
  }
}

{
  const store = new PassiveStore();
  store.reset(1);
  store.devSetLevel(0, 0, 3);
  store.devSetLevel(0, 1, 1);

  const sink = new RecordingSink();
  store.applyTo(sink, 0);
  check("the rebuild starts by throwing the old loadout away", sink.clears === 1);
  check("every owned level was folded in", sink.added.length === 4, `${sink.added.length} records`);
  check(
    "levels one to three of the first passive, in order",
    sink.added[0] === PASSIVE_MODIFIERS[0][0] &&
      sink.added[1] === PASSIVE_MODIFIERS[0][1] &&
      sink.added[2] === PASSIVE_MODIFIERS[0][2],
  );

  // The point of rebuilding: there is no subtract path, so dropping a level cannot leave a trace.
  store.devSetLevel(0, 0, 1);
  store.applyTo(sink, 0);
  check("a rebuild after a change leaves nothing behind", sink.added.length === 2, `${sink.added.length} records`);
  check("and no record appears twice", new Set(sink.added).size === sink.added.length);

  const empty = new PassiveStore();
  empty.reset(1);
  const emptySink = new RecordingSink();
  empty.applyTo(emptySink, 0);
  check("a player with nothing still clears the loadout", emptySink.clears === 1 && emptySink.added.length === 0);
}

{
  // Five levels of one passive has to be exactly five times its row, resolved through the same stack
  // everything else uses. Measured against a hand fold rather than a remembered number, so this stays
  // true when the content changes.
  const damageIndex = PASSIVE_BY_ID.get("grimSigil") ?? 0;
  const store = new PassiveStore();
  store.reset(1);
  store.devSetLevel(0, damageIndex, MAX_PASSIVE_LEVEL);
  const stack = new ModifierStack();
  store.applyTo(stack, 0);
  const stats = new Stats();
  stack.resolve(stats);

  const bare = new Stats();
  new ModifierStack().resolve(bare);
  let expected = 0;
  for (const lvl of PASSIVE_TYPES[damageIndex].levels) {
    for (const d of lvl.deltas) if (d.stat === STAT.damage) expected += d.add ?? 0;
  }
  check(
    "five levels is exactly five times the row",
    stats.values[STAT.damage] - bare.values[STAT.damage] === expected,
    `${stats.values[STAT.damage] - bare.values[STAT.damage]} vs ${expected}`,
  );

  // Order independence is what lets a replay and a co-op guest take the same levels in a different
  // sequence and still land on identical numbers. Without it, every desync would be unexplainable.
  const forwards = new PassiveStore();
  forwards.reset(1);
  const backwards = new PassiveStore();
  backwards.reset(1);
  const picks: [number, number][] = [
    [0, 1],
    [1, 1],
    [2, 1],
    [0, 2],
    [2, 2],
    [1, 2],
  ];
  for (const [type] of picks) forwards.grant(0, type);
  for (const [type] of [...picks].reverse()) backwards.grant(0, type);
  const fStats = new Stats();
  const bStats = new Stats();
  const fStack = new ModifierStack();
  const bStack = new ModifierStack();
  forwards.applyTo(fStack, 0);
  backwards.applyTo(bStack, 0);
  fStack.resolve(fStats);
  bStack.resolve(bStats);
  let off = 0;
  for (let i = 0; i < STAT_COUNT; i++) if (fStats.values[i] !== bStats.values[i]) off++;
  check("the same levels in a different order reach the same stats", off === 0, `${off} stats differ`);
}

/* ---- 10. cost ----------------------------------------------------------------------------------- */

section("6. Rebuilding costs nothing");

{
  const store = new PassiveStore();
  store.reset(4);
  for (let p = 0; p < 4; p++) {
    for (let i = 0; i < MAX_PASSIVES; i++) store.devSetLevel(p, i, MAX_PASSIVE_LEVEL);
  }
  const stack = new ModifierStack();
  const stats = new Stats();
  // Warm up first: the records are built at load, but the stack's own buffers grow on first use and
  // counting that growth as a per-pick cost would be measuring the wrong thing.
  for (let i = 0; i < 200; i++) {
    store.applyTo(stack, i & 3);
    stack.resolve(stats);
  }
  const before = heapUsed();
  for (let i = 0; i < 4000; i++) {
    store.applyTo(stack, i & 3);
    stack.resolve(stats);
  }
  const grew = heapUsed() - before;
  check(
    "four thousand rebuilds allocate nothing",
    grew < 64 * 1024,
    `${(grew / 1024).toFixed(1)}KB over 4000 rebuilds`,
  );
}

console.log("");
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`passives: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log(`PASS — ${PASSIVE_TYPES.length} passives, ${PASSIVE_TYPES.length * MAX_PASSIVE_LEVEL} levels`);
