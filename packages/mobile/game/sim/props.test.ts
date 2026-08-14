/**
 * Destructible scenery self-check. Run headless: `bun packages/mobile/game/sim/props.test.ts`
 *
 * WHY THIS FILE IS AS LONG AS IT IS
 * Props look like the most trivial system in the game and are quietly one of the easiest to get
 * wrong, because three of their properties are invisible until a player is ninety minutes into a run:
 *
 *   1. THE SAME CRATE TWICE. Props are derived from their coordinates rather than stored, so the only
 *      thing stopping a smashed crate from coming straight back is the memory of it having been
 *      smashed. A bug there is a loot printer: stand still, break, wait a tick, break again.
 *   2. CHURN AT THE EDGE. One radius instead of two and a prop on the boundary is created and
 *      destroyed on alternate ticks forever — invisible on screen, ruinous to the pool.
 *   3. LOOT VANISHING INTO A FULL REPORT. The payout screen already shipped this class of bug once.
 *      Here the rule is that a break which cannot be reported does not happen at all, and that is
 *      checked by filling the report and confirming the prop is still standing and still worth
 *      something afterwards.
 *
 * WHAT IT PROVES
 *   1. The content table is coherent: shares total 1024, no duplicate ids or names, every prop pays.
 *   2. The layout hash is stable, seed-dependent, and does not collapse at the origin.
 *   3. Which prop a cell carries is decided independently of whether a cell carries one at all.
 *   4. Props stand inside their own cell and never on top of a neighbour.
 *   5. Streaming brings nearby props in, retires distant ones, and never counts one cell twice.
 *   6. The gap between streaming and retiring means no churn: a lap of walking allocates and frees
 *      each prop about once, not once a tick.
 *   7. A broken prop does not come back while it is remembered, and forgetting is counted.
 *   8. Tough props take more than one hit, and a hit is a hit regardless of the weapon behind it.
 *   9. A break is reported once, with its own position and kind.
 *  10. A full break report postpones the break instead of eating it.
 *  11. Paying out breaks produces the drops the table promises, reproducibly from a seed.
 *  12. Luck moves the consumable odds; a break pays at most one consumable.
 *  13. The state hash notices a prop being broken and ignores where props stand.
 *  14. A minute of walking and smashing allocates nothing.
 */

import { Rng } from "../core/rng";
import { ModifierStack } from "./modifiers";
import { PICKUP, PickupStore } from "./pickups";
import {
  BROKEN_MEMORY,
  MAX_BREAK_EVENTS,
  PROP,
  PROP_CELL,
  PROP_CHANCE_PER_1024,
  PROP_TYPES,
  PROP_TYPE_COUNT,
  PropField,
  RETIRE_RADIUS,
  STREAM_RADIUS,
  cellCentre,
  cellHasProp,
  cellOf,
  contentFaults,
  payOutBreaks,
  propHash,
  propOffset,
  propTypeAt,
} from "./props";
import { STAT, STAT_SCALE, Stats } from "./stats";

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
  };
  const usage = host.process?.memoryUsage;
  return usage === undefined ? 0 : usage().heapUsed;
}

function baseStats(): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  return stats;
}

const SEED = 0x51ee5;

// ---------------------------------------------------------------------------
// 1. The content table
// ---------------------------------------------------------------------------

function testContent(): void {
  section("1. What a prop is");

  check("the table is coherent", contentFaults().length === 0, contentFaults().join("; "));
  check("there are as many props as the count claims", PROP_TYPES.length === PROP_TYPE_COUNT);

  let share = 0;
  for (const type of PROP_TYPES) share += type.sharePer1024;
  check("shares total exactly 1024 — no prop silently soaks up the remainder", share === 1024, `${share}`);

  const ids = new Set(PROP_TYPES.map((t) => t.id));
  check("every prop has its own id", ids.size === PROP_TYPES.length);
  const names = new Set(PROP_TYPES.map((t) => t.name));
  check("every prop has its own name", names.size === PROP_TYPES.length);
  check("ids are the positions in the table", PROP_TYPES.every((t, i) => t.id === i));

  check("the common crate is the most common", PROP_TYPES[PROP.crate].sharePer1024 > 400);
  check("the sarcophagus is rare", PROP_TYPES[PROP.sarcophagus].sharePer1024 < 32);
  check(
    "and it is the only prop that can hold a chest",
    PROP_TYPES.filter((t) => t.reward.chestPer1024 > 0).length === 1 &&
      PROP_TYPES[PROP.sarcophagus].reward.chestPer1024 > 0,
  );
  check(
    "every prop is worth breaking",
    PROP_TYPES.every(
      (t) =>
        t.reward.drops.gemChance > 0 ||
        t.reward.drops.goldChance > 0 ||
        t.reward.healthPer1024 + t.reward.bombPer1024 + t.reward.freezePer1024 > 0,
    ),
  );
  check(
    "nothing takes so many hits a fresh character cannot break it",
    PROP_TYPES.every((t) => t.hitPoints >= 1 && t.hitPoints <= 6),
  );

  // The self-check has to actually refuse a broken table, or it is decoration.
  const bad = PROP_TYPES.map((t, i) => (i === 0 ? { ...t, sharePer1024: t.sharePer1024 + 1 } : t));
  check("a table whose shares do not add up is refused", contentFaults(bad).length > 0);
  const noPay = PROP_TYPES.map((t, i) =>
    i === 0
      ? {
          ...t,
          reward: {
            drops: { gemChance: 0, mediumChance: 0, largeChance: 0, goldChance: 0, goldAmount: 0 },
            healthPer1024: 0,
            bombPer1024: 0,
            freezePer1024: 0,
            vacuumPer1024: 0,
            chestPer1024: 0,
          },
        }
      : t,
  );
  check("a prop that pays nothing is refused", contentFaults(noPay).length > 0);
  const noHits = PROP_TYPES.map((t, i) => (i === 0 ? { ...t, hitPoints: 0 } : t));
  check("a prop that takes no hits is refused", contentFaults(noHits).length > 0);
}

// ---------------------------------------------------------------------------
// 2. Where props are, without storing where props are
// ---------------------------------------------------------------------------

function testLayout(): void {
  section("2. A layout nobody had to save");

  check("the same cell answers the same way twice", propHash(3, -7, SEED) === propHash(3, -7, SEED));
  check("neighbouring cells differ", propHash(3, -7, SEED) !== propHash(4, -7, SEED));
  check("the seed matters", propHash(3, -7, SEED) !== propHash(3, -7, SEED + 1));
  check(
    "the origin does not collapse to zero on seed zero — the tile under the player's feet",
    propHash(0, 0, 0) !== 0,
    `${propHash(0, 0, 0)}`,
  );
  check("it is always a positive 32-bit number", propHash(-99999, 99999, -1) >>> 0 === propHash(-99999, 99999, -1));

  let carrying = 0;
  const SAMPLE = 20000;
  for (let i = 0; i < SAMPLE; i++) {
    if (cellHasProp(SEED, i % 141, Math.floor(i / 141))) carrying++;
  }
  const per1024 = Math.round((carrying / SAMPLE) * 1024);
  check(
    "about as many cells carry a prop as the constant says",
    Math.abs(per1024 - PROP_CHANCE_PER_1024) < 30,
    `${per1024} per 1024, wanted ${PROP_CHANCE_PER_1024}`,
  );

  const seen: number[] = Array.from<number>({ length: PROP_TYPE_COUNT }).fill(0);
  for (let i = 0; i < SAMPLE; i++) seen[propTypeAt(SEED, i % 141, Math.floor(i / 141))]++;
  check("every prop in the table actually turns up", seen.every((n) => n > 0), seen.join("/"));
  const crateShare = Math.round((seen[PROP.crate] / SAMPLE) * 1024);
  check(
    "and in roughly the share it was given",
    Math.abs(crateShare - PROP_TYPES[PROP.crate].sharePer1024) < 40,
    `crates ${crateShare} per 1024`,
  );

  // Which prop must not be answered from the same salt as whether: otherwise retuning the density
  // silently reshuffles every prop in the game.
  let sameAnswer = 0;
  for (let i = 0; i < 2000; i++) {
    if (propHash(i, 1, SEED) % 1024 === propHash(i, 1, (SEED ^ 0x68e31da4) | 0) % 1024) sameAnswer++;
  }
  check("whether and which are decided separately", sameAnswer < 40, `${sameAnswer}/2000 agreed by chance`);

  let worst = 0;
  for (let cx = -30; cx <= 30; cx++) {
    for (let cy = -30; cy <= 30; cy++) {
      worst = Math.max(worst, Math.abs(propOffset(SEED, cx, cy, 0)), Math.abs(propOffset(SEED, cx, cy, 1)));
    }
  }
  check(
    "a prop stands inside its own cell, well clear of the next one",
    worst < PROP_CELL / 3,
    `worst offset ${worst} of a ${PROP_CELL} cell`,
  );

  check("cells and world coordinates agree", cellOf(cellCentre(17)) === 17 && cellOf(cellCentre(-4)) === -4);
  check("the cell left of the origin is -1, not 0", cellOf(-1) === -1);
}

// ---------------------------------------------------------------------------
// 3. Streaming
// ---------------------------------------------------------------------------

function testStreaming(): void {
  section("3. Bringing props in and handing them back");

  const field = new PropField();
  field.setSeed(SEED);
  check("a fresh field is empty", field.count === 0);

  field.stream(0, 0);
  const first = field.count;
  check("standing anywhere finds props nearby", first > 0, `${first} in range`);

  field.stream(0, 0);
  check("streaming twice does not duplicate them", field.count === first, `${field.count}`);

  let tooFar = 0;
  const slots = field.slots;
  for (let i = 0; i < field.count; i++) {
    const s = slots[i];
    if (Math.hypot(field.x[s], field.y[s]) > STREAM_RADIUS) tooFar++;
  }
  check("nothing arrives from further away than it should", tooFar === 0);

  const cells = new Set<string>();
  for (let i = 0; i < field.count; i++) cells.add(`${field.cellX[slots[i]]},${field.cellY[slots[i]]}`);
  check("one prop per cell at most", cells.size === field.count);

  let healthWrong = 0;
  for (let i = 0; i < field.count; i++) {
    const s = slots[i];
    if (field.health[s] !== PROP_TYPES[field.typeIndex[s]].hitPoints) healthWrong++;
  }
  check("each one arrives with its own hit points", healthWrong === 0);

  field.stream(RETIRE_RADIUS * 3, 0);
  let stillBehind = 0;
  for (let i = 0; i < field.count; i++) {
    if (field.x[field.slots[i]] < RETIRE_RADIUS) stillBehind++;
  }
  check("walking away retires what is behind you", stillBehind === 0 && field.totalRetired > 0, `${field.totalRetired} retired`);
  check("and finds new ones ahead", field.count > 0, `${field.count} in range`);

  // No churn. Walk a long line one step at a time and count the traffic. With a single radius this
  // number explodes: every prop on the boundary is allocated and freed on alternating steps.
  const churn = new PropField();
  churn.setSeed(SEED);
  const steps = 400;
  for (let i = 0; i < steps; i++) churn.stream(i * 8, 0);
  const distinctCells = new Set<string>();
  // Recount how many cells that walk passed through, so "about once each" has something to mean.
  const reach = Math.ceil(STREAM_RADIUS / PROP_CELL);
  for (let i = 0; i < steps; i++) {
    const cx0 = cellOf(i * 8);
    for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
      for (let cy = -reach; cy <= reach; cy++) {
        if (cellHasProp(SEED, cx, cy)) distinctCells.add(`${cx},${cy}`);
      }
    }
  }
  check(
    "a long walk streams each prop in about once, not once a tick",
    churn.totalStreamedIn < distinctCells.size * 3,
    `${churn.totalStreamedIn} arrivals over ${distinctCells.size} cells in ${steps} steps`,
  );
  check("and retires about as many as it took in", churn.totalRetired <= churn.totalStreamedIn);

  // The two radii exist for this: a player who paces back and forth must not make props stream in
  // and out on every step. A single radius passes a one-way walk and fails right here.
  const wob = new PropField();
  wob.setSeed(SEED);
  const amplitude = 200;
  wob.stream(0, 0);
  wob.stream(amplitude, 0);
  wob.stream(0, 0);
  const settledIn = wob.totalStreamedIn;
  const settledOut = wob.totalRetired;
  for (let i = 0; i < 50; i++) {
    wob.stream(amplitude, 0);
    wob.stream(0, 0);
  }
  check(
    "pacing back and forth over the same ground streams nothing twice",
    wob.totalStreamedIn === settledIn,
    `${wob.totalStreamedIn - settledIn} extra arrivals over 100 crossings`,
  );
  check(
    "and hands nothing back either — one radius would churn here every step",
    wob.totalRetired === settledOut,
    `${wob.totalRetired - settledOut} extra retirements`,
  );
}

// ---------------------------------------------------------------------------
// 4. Breaking things
// ---------------------------------------------------------------------------

function firstLive(field: PropField): number {
  return field.slots[0];
}

/** Is there a prop standing in this cell right now? The loot-printer check leans on this. */
function liveInCell(field: PropField, cx: number, cy: number): boolean {
  for (let i = 0; i < field.count; i++) {
    const s = field.slots[i];
    if (field.cellX[s] === cx && field.cellY[s] === cy) return true;
  }
  return false;
}

function testBreaking(): void {
  section("4. Breaking things, once");

  const field = new PropField();
  field.setSeed(SEED);
  field.stream(0, 0);

  // A prop that takes more than one hit, found by walking rather than by hoping the patch of floor
  // under the starting position happens to hold one.
  const tougher = new PropField();
  tougher.setSeed(SEED);
  let tough = -1;
  for (let walk = 0; walk < 200 && tough < 0; walk++) {
    tougher.stream(walk * 2000, 0);
    for (let i = 0; i < tougher.count; i++) {
      if (PROP_TYPES[tougher.typeIndex[tougher.slots[i]]].hitPoints > 1) {
        tough = tougher.slots[i];
        break;
      }
    }
  }
  check("the floor has something that does not break in one hit", tough >= 0);
  if (tough >= 0) {
    const hits = PROP_TYPES[tougher.typeIndex[tough]].hitPoints;
    for (let i = 0; i < hits - 1; i++) {
      check(`hit ${i + 1} of ${hits} does not break it`, tougher.damageAt(tough) === false);
    }
    check("the last hit does", tougher.damageAt(tough) === true);
    check("and hitting the space it left does nothing", tougher.damageAt(tough) === false);
  }

  const before = field.count;
  const victim = firstLive(field);
  const vx = field.x[victim];
  const vy = field.y[victim];
  const vkind = field.typeIndex[victim];
  const vcx = field.cellX[victim];
  const vcy = field.cellY[victim];
  let broke = false;
  for (let i = 0; i < 8 && !broke; i++) broke = field.damageAt(victim);
  check("a prop can be broken", broke);
  check("it leaves the floor", field.count < before);
  const row = field.breakCount - 1;
  check("the break is reported once, where it happened", field.breakX[row] === vx && field.breakY[row] === vy);
  check("with the kind that broke", field.breakType[row] === vkind);
  check("and the cell is remembered as broken", field.isBroken(vcx, vcy));

  // The loot printer: break it, stream again, and it must not be standing there.
  field.stream(0, 0);
  check("a smashed prop does not come back next tick", !liveInCell(field, vcx, vcy));

  check("a hit is a hit — nothing scales prop health", PROP_TYPES.every((t) => Number.isSafeInteger(t.hitPoints)));

  const huge = new PropField();
  huge.setSeed(SEED);
  huge.stream(0, 0);
  const slot = firstLive(huge);
  check("one enormous hit still only breaks it once", huge.damageAt(slot, 9999) === true && huge.breakCount === 1);
}

function testBreakReportIsNeverLost(): void {
  section("5. A break that cannot be reported does not happen");

  const field = new PropField();
  field.setSeed(SEED);
  // The report holds more rows than one screen of floor can ever carry, which is the point: it is a
  // ceiling, not a budget. To reach it at all the props have to be placed directly.
  const wanted = MAX_BREAK_EVENTS + 8;
  for (let i = 0; i < wanted; i++) {
    const cx = 400 + (i % 8);
    const cy = 400 + Math.floor(i / 8);
    field.spawnAt(cx, cy, cellCentre(cx), cellCentre(cy));
  }
  check("plenty of props to smash", field.count > MAX_BREAK_EVENTS, `${field.count} alive`);

  let broken = 0;
  const slots = field.slots;
  // Snapshot the live slots first: breaking mutates the dense list under the loop.
  const live: number[] = [];
  for (let i = 0; i < field.count; i++) live.push(slots[i]);
  for (const s of live) {
    if (field.damageAt(s, 9999)) broken++;
  }
  check("the report fills to its cap and no further", field.breakCount === MAX_BREAK_EVENTS, `${field.breakCount}`);
  check("exactly that many props actually broke", broken === MAX_BREAK_EVENTS);
  check("the rest were postponed, not eaten", field.breaksDeferred > 0, `${field.breaksDeferred} postponed`);

  let survivors = 0;
  let worthless = 0;
  for (let i = 0; i < field.count; i++) {
    survivors++;
    if (field.health[field.slots[i]] <= 0) worthless++;
  }
  check("the postponed props are still standing", survivors > 0, `${survivors} left`);
  check("and none of them is standing on zero health", worthless === 0);

  field.resetBreaks();
  check("draining the report frees it up", field.breakCount === 0);
  const next = field.slots[0];
  check("and the next tick can finish the job", field.damageAt(next, 9999) === true);
}

// ---------------------------------------------------------------------------
// 6. Remembering
// ---------------------------------------------------------------------------

function testMemory(): void {
  section("6. Remembering what was smashed, within reason");

  const field = new PropField();
  field.setSeed(SEED);
  check("nothing is remembered at the start", field.brokenRemembered === 0);
  check("and nothing is broken", !field.isBroken(0, 0));

  field.stream(0, 0);
  const s = firstLive(field);
  const cx = field.cellX[s];
  const cy = field.cellY[s];
  field.damageAt(s, 9999);
  check("one break is remembered", field.brokenRemembered === 1);
  check("the right cell", field.isBroken(cx, cy) && !field.isBroken(cx + 1000, cy));
  check("nothing has been forgotten yet", field.brokenForgotten === 0);

  // Fill the ring past its capacity by walking and smashing everything.
  let step = 0;
  while (field.brokenRemembered < BROKEN_MEMORY && step < 4000) {
    field.stream(step * 60, 0);
    field.resetBreaks();
    const live: number[] = [];
    for (let i = 0; i < field.count; i++) live.push(field.slots[i]);
    for (const slot of live) field.damageAt(slot, 9999);
    step++;
  }
  check("the memory fills up", field.brokenRemembered === BROKEN_MEMORY, `${field.brokenRemembered}`);
  const forgottenBefore = field.brokenForgotten;
  field.resetBreaks();
  // Well clear of everything already smashed, so there is definitely something standing here.
  const live: number[] = [];
  for (let jump = 1; jump < 40 && live.length === 0; jump++) {
    field.stream(step * 60 + jump * 5000, 0);
    for (let i = 0; i < field.count; i++) live.push(field.slots[i]);
  }
  for (const slot of live) field.damageAt(slot, 9999);
  check(
    "past that it starts forgetting, and says so out loud",
    field.brokenForgotten > forgottenBefore,
    `${field.brokenForgotten} forgotten`,
  );
  check("it never remembers more than its ring", field.brokenRemembered === BROKEN_MEMORY);
  check("the most recent break is still remembered", field.isBroken(field.cellX[live[0]], field.cellY[live[0]]));

  field.setSeed(SEED + 1);
  check("a new stage forgets the old one's rubble", field.brokenRemembered === 0 && field.count === 0);
}

// ---------------------------------------------------------------------------
// 7. Paying out
// ---------------------------------------------------------------------------

function testPayout(): void {
  section("7. What a break is worth");

  const stats = baseStats();
  const field = new PropField();
  field.setSeed(SEED);
  const pickups = new PickupStore();
  const rng = new Rng(99);

  check("an empty report pays nothing", payOutBreaks(field, pickups, stats, rng) === 0);
  check("and puts nothing on the floor", pickups.count === 0);

  field.stream(0, 0);
  const live: number[] = [];
  for (let i = 0; i < field.count && live.length < 8; i++) live.push(field.slots[i]);
  for (const s of live) field.damageAt(s, 9999);
  const paid = payOutBreaks(field, pickups, stats, rng);
  check("every reported break is paid for", paid === field.breakCount, `${paid} of ${field.breakCount}`);
  check("and something landed on the floor", pickups.count > 0, `${pickups.count} pickups`);

  // Reproducible: same seed, same field, same breaks, same floor.
  function runOnce(seed: number): string {
    const f = new PropField();
    f.setSeed(SEED);
    const p = new PickupStore();
    const r = new Rng(seed);
    f.stream(0, 0);
    const list: number[] = [];
    for (let i = 0; i < f.count; i++) list.push(f.slots[i]);
    for (const s of list) {
      if (f.breakCount < MAX_BREAK_EVENTS) f.damageAt(s, 9999);
    }
    payOutBreaks(f, p, baseStats(), r);
    let out = "";
    const slots = p.pool.slots;
    for (let i = 0; i < p.count; i++) {
      const s = slots[i];
      out += `${p.kind[s]}:${p.value[s]}:${Math.round(p.x[s])},${Math.round(p.y[s])}|`;
    }
    return out;
  }
  const a = runOnce(4242);
  const b = runOnce(4242);
  const c = runOnce(4243);
  check("the same seed pays out identically — a replay has to agree", a === b, `${a.length} chars`);
  check("a different seed does not", a !== c);

  // A crate is money, an urn is progress. Break each kind directly through the report.
  function payKind(kind: number, rngSeed: number): { gold: number; gems: number; consumables: number } {
    const f = new PropField();
    f.setSeed(SEED);
    const p = new PickupStore();
    const r = new Rng(rngSeed);
    // Fill one report row by hand: the field's own arrays are the contract with the run loop.
    f.stream(0, 0);
    let found = -1;
    for (let i = 0; i < f.count; i++) {
      if (f.typeIndex[f.slots[i]] === kind) {
        found = f.slots[i];
        break;
      }
    }
    if (found < 0) {
      // Not on screen this seed; walk until one is.
      for (let step = 1; step < 200 && found < 0; step++) {
        f.stream(step * 120, 0);
        for (let i = 0; i < f.count; i++) {
          if (f.typeIndex[f.slots[i]] === kind) {
            found = f.slots[i];
            break;
          }
        }
      }
    }
    if (found < 0) return { gold: -1, gems: -1, consumables: -1 };
    f.damageAt(found, 9999);
    payOutBreaks(f, p, baseStats(), r);
    let gold = 0;
    let gems = 0;
    let consumables = 0;
    const slots = p.pool.slots;
    for (let i = 0; i < p.count; i++) {
      const s = slots[i];
      if (p.kind[s] === PICKUP.gold) gold += p.value[s];
      else if (p.kind[s] <= PICKUP.gemLarge) gems++;
      else consumables++;
    }
    return { gold, gems, consumables };
  }

  const crate = payKind(PROP.crate, 7);
  check("a crate pays coins", crate.gold >= PROP_TYPES[PROP.crate].reward.drops.goldAmount, `${crate.gold} coins`);
  check("and no gem", crate.gems === 0);
  const urn = payKind(PROP.urn, 7);
  check("an urn pays a gem", urn.gems === 1);
  check("and no coins", urn.gold === 0);

  let consumables = 0;
  for (let seed = 0; seed < 40; seed++) consumables += payKind(PROP.brazier, seed).consumables;
  check("a brazier hands out the loud things", consumables > 0, `${consumables} over 40 breaks`);
  check(
    "never more than one per break",
    (() => {
      for (let seed = 0; seed < 40; seed++) {
        if (payKind(PROP.brazier, seed).consumables > 1) return false;
      }
      return true;
    })(),
  );
}

function testLuck(): void {
  section("8. Luck");

  function consumablesWithLuck(luckPermille: number): number {
    let total = 0;
    for (let seed = 0; seed < 60; seed++) {
      const stats = baseStats();
      stats.values[STAT.luck] = luckPermille;
      const f = new PropField();
      f.setSeed(SEED);
      const p = new PickupStore();
      f.stream(0, 0);
      const live: number[] = [];
      for (let i = 0; i < f.count && f.breakCount < MAX_BREAK_EVENTS; i++) live.push(f.slots[i]);
      for (const s of live) f.damageAt(s, 9999);
      payOutBreaks(f, p, stats, new Rng(seed));
      const slots = p.pool.slots;
      for (let i = 0; i < p.count; i++) {
        if (p.kind[slots[i]] > PICKUP.chest || p.kind[slots[i]] === PICKUP.health || p.kind[slots[i]] === PICKUP.chest) {
          total++;
        }
      }
    }
    return total;
  }

  const plain = consumablesWithLuck(STAT_SCALE);
  const lucky = consumablesWithLuck(STAT_SCALE * 4);
  check("luck makes props more generous", lucky > plain, `${plain} plain vs ${lucky} lucky`);
  const none = consumablesWithLuck(0);
  check("and no luck at all turns the extras off entirely", none === 0, `${none}`);
}

// ---------------------------------------------------------------------------
// 9. The state hash
// ---------------------------------------------------------------------------

function testHash(): void {
  section("9. What the run's checksum sees");

  const a = new PropField();
  a.setSeed(SEED);
  a.stream(0, 0);
  const b = new PropField();
  b.setSeed(SEED);
  b.stream(0, 0);
  check("two fields on the same seed hash the same", a.hashInto(0x811c9dc5) === b.hashInto(0x811c9dc5));

  const before = a.hashInto(0x811c9dc5);
  a.damageAt(firstLive(a), 9999);
  check("breaking one changes the hash", a.hashInto(0x811c9dc5) !== before);

  const c = new PropField();
  c.setSeed(SEED);
  c.stream(0, 0);
  const cHash = c.hashInto(0x811c9dc5);
  const slots = c.slots;
  for (let i = 0; i < c.count; i++) {
    c.x[slots[i]] += 0.3;
    c.y[slots[i]] -= 0.7;
  }
  check("nudging positions does not — floats have no business in a checksum", c.hashInto(0x811c9dc5) === cHash);

  const hit = new PropField();
  hit.setSeed(SEED);
  hit.stream(0, 0);
  let tough = -1;
  for (let i = 0; i < hit.count; i++) {
    if (PROP_TYPES[hit.typeIndex[hit.slots[i]]].hitPoints > 1) {
      tough = hit.slots[i];
      break;
    }
  }
  if (tough >= 0) {
    const h0 = hit.hashInto(0x811c9dc5);
    hit.damageAt(tough, 1);
    check("a prop being damaged but not broken changes it too", hit.hashInto(0x811c9dc5) !== h0);
  }
  // Same number of props standing, same number broken, different ground. If the cell coordinates do
  // not reach the hash, two phones that disagree about the floor will still shake hands.
  function placed(cx: number, cy: number): number {
    const f = new PropField();
    f.setSeed(SEED);
    f.spawnAt(cx, cy, cellCentre(cx), cellCentre(cy));
    return f.hashInto(0x811c9dc5);
  }
  check("a prop one cell east hashes differently", placed(5, 0) !== placed(7, 0));
  check("and a prop one cell south does too", placed(5, 0) !== placed(5, 3));

  check("the hash is always a positive 32-bit number", a.hashInto(0) >>> 0 === a.hashInto(0));
}

// ---------------------------------------------------------------------------
// 10. Cost
// ---------------------------------------------------------------------------

function testCost(): void {
  section("10. A minute of walking and smashing");

  const field = new PropField();
  field.setSeed(SEED);
  const pickups = new PickupStore();
  const stats = baseStats();
  const rng = new Rng(1);
  // Warm everything up first, so what is measured is the steady state and not the first allocation.
  for (let i = 0; i < 60; i++) {
    field.stream(i * 4, 0);
    field.update();
    field.resetBreaks();
  }

  const before = heapUsed();
  const t0 = Date.now();
  const frames = 3600;
  for (let t = 0; t < frames; t++) {
    const px = t * 4;
    field.stream(px, 0);
    field.rebuildGrid();
    field.update();
    const found = field.queryNear(px, 0, 200);
    for (let i = 0; i < found; i++) field.damageAt(field.neighbourScratch[i], 1);
    payOutBreaks(field, pickups, stats, rng);
    field.resetBreaks();
    pickups.clear();
  }
  const elapsed = Date.now() - t0;
  const growth = (heapUsed() - before) / 1024;

  check(
    "a minute of it allocates nothing — allocation, not arithmetic, is what stutters a 4GB phone",
    growth < 64,
    `${growth.toFixed(1)}KB over ${frames} ticks`,
  );
  check(
    "and it costs a fraction of the frame budget",
    elapsed / frames < 1,
    `${Math.round((elapsed * 1000) / frames)}us per tick`,
  );
  // A single straight walk only sweeps a corridor about one cell wide, so this is a floor on
  // "the loop did real work every tick", not a density claim.
  check("it was actually breaking things the whole time", field.totalBroken > 15, `${field.totalBroken} broken`);
}

testContent();
testLayout();
testStreaming();
testBreaking();
testBreakReportIsNeverLost();
testMemory();
testPayout();
testLuck();
testHash();
testCost();

console.log(`\n${failures === 0 ? "PASS — destructible scenery" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`props: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
