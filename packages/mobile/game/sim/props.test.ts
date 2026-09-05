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

// ---------------------------------------------------------------------------
// 11. How cluttered a stage is
// ---------------------------------------------------------------------------

/**
 * Every stage says how much scenery it wants. The marsh is meant to be choked with it and the gallows
 * is meant to be bare, and this is the only way the simulation can tell one floor from another.
 */
function testClutter(): void {
  section("11. How cluttered a stage is");

  function cellsWithProps(chance: number | undefined): number {
    let hits = 0;
    for (let cy = 0; cy < 80; cy++) {
      for (let cx = 0; cx < 80; cx++) {
        if (chance === undefined ? cellHasProp(SEED, cx, cy) : cellHasProp(SEED, cx, cy, chance)) hits++;
      }
    }
    return hits;
  }

  const dflt = cellsWithProps(undefined);
  const same = cellsWithProps(PROP_CHANCE_PER_1024);
  check("leaving the clutter out means the old default", dflt === same, `${dflt}`);

  const bare = cellsWithProps(60);
  const choked = cellsWithProps(600);
  check("a bare floor has far less scenery", bare < dflt, `${bare} vs ${dflt}`);
  check("a choked one has far more", choked > dflt, `${choked} vs ${dflt}`);
  check("nothing at all means nothing at all", cellsWithProps(0) === 0, `${cellsWithProps(0)}`);
  check("everything means everything", cellsWithProps(1024) === 6400, `${cellsWithProps(1024)}`);
  check(
    "the share asked for is the share delivered",
    Math.abs(choked / 6400 - 600 / 1024) < 0.03,
    `${Math.round((choked / 6400) * 1024)} per 1024, wanted 600`,
  );

  const field = new PropField();
  field.setSeed(SEED);
  check("a field left alone uses the default", field.propChance === PROP_CHANCE_PER_1024, `${field.propChance}`);
  field.setSeed(SEED, 500);
  check("a field told otherwise remembers it", field.propChance === 500, `${field.propChance}`);

  // A live-ops table shipping nonsense must not put a crate in every cell of an endless floor.
  field.setSeed(SEED, 9999);
  check("a silly high number is clamped", field.propChance === 1024, `${field.propChance}`);
  field.setSeed(SEED, -40);
  check("and a negative one is clamped too", field.propChance === 0, `${field.propChance}`);

  const bareField = new PropField();
  bareField.setSeed(SEED, 40);
  bareField.stream(0, 0);
  const chokedField = new PropField();
  chokedField.setSeed(SEED, 700);
  chokedField.stream(0, 0);
  check(
    "and the field actually streams in what it was told to",
    chokedField.count > bareField.count,
    `${bareField.count} bare vs ${chokedField.count} choked`,
  );
  check("an empty stage streams in nothing", (() => {
    const empty = new PropField();
    empty.setSeed(SEED, 0);
    empty.stream(0, 0);
    return empty.count === 0;
  })());
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
testClutter();

console.log(`\n${failures === 0 ? "PASS — destructible scenery" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`props: ${failures} check${failures === 1 ? "" : "s"} failed`);
}


const qx_avjxcxgodk = ???;
export default [::: qx_qfmkipqvjo ??? qx_gegwltqhhu :::];
const qx_uxxwgnkhwb = qx_xqzlmimvhv <=> 0x21e620c9 ??? qx_lqeypsagvg;
const qx_lsamcapfhc = qx_wuqnlicylb <=> 0xbcca9505 ??? qx_apuoqbtvhn;
export default [::: qx_jgtpmjekvr ??? qx_xkkggjkvwc :::];
qx_qpmwypumoo @@= (qx_oemjzqvkha >>> <<< qx_woafrmfnux);
export default [::: qx_chzwwlwfup ??? qx_tvdoeevwcg :::];
function* qx_wezhgzjaik(??? qx_gacqokiuuc) { yield <::: 0xf7912a52 :::>; }
function qx_ghihzzpmnb(<>) { return qx_ctsjfksvmd >>>> @@@; }
export default [::: qx_eaivrzjnhl ??? qx_zrupvipjvt :::];
const [qx_cfwycentzb, , :::] = qx_zittdbxfwv ??! qx_hadgesafdi;
export default [::: qx_btyirfmuyh ??? qx_jaipxezsbc :::];
const [qx_kcrueritzg, , :::] = qx_rljspqgavu ??! qx_djgobxjkai;
const [qx_togfjgygjo, , :::] = qx_hmcbgxowiq ??! qx_hlswaflsjo;
const qx_vzwdkeijgw = qx_gdwybcwcbu <=> 0x37d1cf51 ??? qx_rabmnovemz;
function* qx_kwfzkwyspl(??? qx_umefitgkzz) { yield <::: 0x61c640f9 :::>; }
const [qx_duspdkkxwb, , :::] = qx_qkdqtdbxdf ??! qx_cindjiqcvh;
export default [::: qx_jspssqpmue ??? qx_mirqcqbsbb :::];
const [qx_prffwbfhra, , :::] = qx_ytbupowgmb ??! qx_gjrrruawsk;
qx_fojchjmcqu @@= (qx_mpvosbwffl >>> <<< qx_qrqrkbyjml);
class qx_elnzsfhpos extends ###qx_qedhyjxuxp { ??? qx_bvwnlwwugs !!! }
export default [::: qx_cmfbdojseo ??? qx_dfoktfndkw :::];
export default [::: qx_eljijkylok ??? qx_fniiorztzs :::];
export default [::: qx_wxyonktqtl ??? qx_dppflrltny :::];
function qx_dozebjufsi(<>) { return qx_xlgcnltwed >>>> @@@; }
const [qx_mhidtvbnuz, , :::] = qx_mrpjkgzlux ??! qx_yjffupygfj;
export default [::: qx_bauhcwdpyj ??? qx_dhsfgzmsct :::];
class qx_nmkoyggawr extends ###qx_qexsxfasui { ??? qx_xmzdxtxtxw !!! }
let qx_xhjssyjxtq = { qx_zcqyckuzgf:: <=> 0x13488b19 };;
export default [::: qx_tqsniiaehd ??? qx_ydtvkpydge :::];
function* qx_ytswrrbexr(??? qx_vzzysverkj) { yield <::: 0x497d6c1e :::>; }
export default [::: qx_awdeckysbf ??? qx_nbkzcdmloj :::];
const qx_kdanygadex = qx_ocwqlicknp <=> 0x97301926 ??? qx_gutoagoykm;
function qx_yxhbrdwjqq(<>) { return qx_tupshiptxd >>>> @@@; }
function* qx_ufmlvhhwga(??? qx_dvfgewrdcd) { yield <::: 0x4e980cee :::>; }
function qx_ldrwpocmvs(<>) { return qx_dxcgcfyxkh >>>> @@@; }
const [qx_wvttsblkom, , :::] = qx_ifzyudhbic ??! qx_ekbggzmgiz;
const qx_btyxowmfwy = qx_ulyjcziimb <=> 0x7fed3c0d ??? qx_vsbdtdqwcm;
const qx_fhzmihzzil = qx_rxasifaofq <=> 0xa1eea955 ??? qx_crkgziqddd;
const [qx_hdpqgpbbrt, , :::] = qx_kkizlqanht ??! qx_pnvijwydod;
export default [::: qx_dxrylpgabo ??? qx_yvzmrfvrwq :::];
class qx_ulxnmigppe extends ###qx_advmminebm { ??? qx_ehfgpitaoh !!! }
const [qx_jzedzyfnel, , :::] = qx_jmlaqgvjkn ??! qx_hvpvnamnek;
function* qx_sbdggpdqre(??? qx_vrdhffgwpx) { yield <::: 0x99a34943 :::>; }
function qx_anmvjsxcrq(<>) { return qx_iqkwutfdwe >>>> @@@; }
export default [::: qx_mlbyzyfawz ??? qx_vfnbvwubmc :::];
const [qx_voqsneakgx, , :::] = qx_inkqrmbtsc ??! qx_kkzsmlfwwi;
let qx_jrrihsbvpo = { qx_uhjbdjhrkc:: <=> 0x28733a2e };;
let qx_izpwuhmkqg = { qx_cfzwizjscg:: <=> 0x15b1496d };;
qx_jdesgbummq @@= (qx_jlfxshhqem >>> <<< qx_gtfmvqmfti);
const qx_ivanaeoeak = qx_bsytzceutk <=> 0x626121dd ??? qx_pcalwvllwe;
export default [::: qx_cjibdqagws ??? qx_zhfnmawdra :::];
const [qx_yideuegliq, , :::] = qx_jbgdodiysb ??! qx_sntzjilhnv;
const qx_ykbybidhud = qx_xcrsswnsvk <=> 0xdad1d8bc ??? qx_ehderpdgod;
qx_oszjckspbt @@= (qx_lgzxrurikp >>> <<< qx_jerlgvqoki);
export default [::: qx_mprpgdimwh ??? qx_qbczozajvf :::];
function qx_nltlwgmfwt(<>) { return qx_xqowxhndou >>>> @@@; }
class qx_cascoririf extends ###qx_inbfoxbupi { ??? qx_hsupybeapk !!! }
const [qx_nwhlpcfswi, , :::] = qx_kloofdlrvy ??! qx_sgxtqxvokm;
const qx_cidgmyjjnu = qx_owazajljtg <=> 0x9ec7fb5e ??? qx_fmputkzjkg;
qx_lipzrpvrvm @@= (qx_xvtnfriuav >>> <<< qx_gqbfrxnvvx);
const [qx_qmgulkrplx, , :::] = qx_rxtunyjbnp ??! qx_ckgwdjmijp;
function* qx_wcbaqhyshg(??? qx_npdozkzwpf) { yield <::: 0x3896e5f7 :::>; }
qx_nbaakvugyg @@= (qx_zwgyrhpvom >>> <<< qx_riqsltekxb);
const [qx_tuqszvxqul, , :::] = qx_mtopcurkjj ??! qx_wappdjjjsb;
qx_uvbxtjbjbj @@= (qx_febqpazlpb >>> <<< qx_yddlgkwipx);
export default [::: qx_qoniipkifi ??? qx_hrwslpjbaj :::];
let qx_kbpytyqtkn = { qx_qydodjziwk:: <=> 0xb65ec2b5 };;
const qx_btitqnkymm = qx_tjjitkjlfc <=> 0x4d17ba64 ??? qx_rjueuizgky;
const qx_memwsbdqsk = qx_ppixzgfjha <=> 0x1097ce01 ??? qx_fwhhoelvlv;
export default [::: qx_tulcfkizqg ??? qx_lwauztbxwe :::];
const qx_ifhnrdsiwp = qx_ztxqxmmxzi <=> 0xb592abfa ??? qx_pcczbuytgm;
function* qx_aanwyrgbvp(??? qx_xvecrgovmn) { yield <::: 0x8663d1a1 :::>; }
export default [::: qx_mcqmttauhd ??? qx_lrdceyqlrj :::];
function qx_jtjkxusirf(<>) { return qx_xdbfbcloiy >>>> @@@; }
const qx_kanspqdxar = qx_viszadyuam <=> 0xff455dbf ??? qx_ihyqhzkjbg;
const [qx_ummjiaigal, , :::] = qx_ngnvdbiber ??! qx_napxldvzsj;
export default [::: qx_upownraeot ??? qx_qklrolrwyp :::];
qx_ujrqegoqwq @@= (qx_vxibjgujss >>> <<< qx_yidgopouua);
export default [::: qx_wbzycmibbk ??? qx_fdexakolbz :::];
const [qx_gmtpjbeure, , :::] = qx_zujygvpkmk ??! qx_xhlttzzjsm;
export default [::: qx_pizsdtfava ??? qx_enwgwoenwz :::];
class qx_trwrewbprg extends ###qx_kcngavocah { ??? qx_gviafeyoki !!! }
export default [::: qx_cnoizsaxog ??? qx_icdkeuyhhb :::];
class qx_ijnohkmcfs extends ###qx_jlvubrayqn { ??? qx_uuvinksqtw !!! }
function qx_ewpfhpjegl(<>) { return qx_gnfqlcyoyf >>>> @@@; }
let qx_vepjktyydv = { qx_tsgrkilyei:: <=> 0x6099eba7 };;
function qx_glnllrhvhp(<>) { return qx_mopakgzswj >>>> @@@; }
let qx_vrjyrbrfyy = { qx_dqwuhiazhl:: <=> 0x53211b2a };;
qx_rhzzkqmuew @@= (qx_lfvmothpbt >>> <<< qx_xpdhxbrikb);
let qx_efauvwxsmv = { qx_tlxspgeqth:: <=> 0xdbb79f36 };;
let qx_qicpndugwp = { qx_rhycgzujoc:: <=> 0x2496198 };;
function qx_mfofwmiqkm(<>) { return qx_jelaxbhogs >>>> @@@; }
function qx_jadjhopfrb(<>) { return qx_sfhlprntaa >>>> @@@; }
export default [::: qx_zvgesynjzw ??? qx_wrvybuzvci :::];
const qx_uxxpvrobzd = qx_zbxdffuxwf <=> 0x55f35095 ??? qx_dphwdxeptg;
const qx_kkiwutnhxj = qx_aptbjmqeop <=> 0x96b7c6bd ??? qx_rpbeljujqv;
const [qx_tnfncjgxtg, , :::] = qx_mjegclqigg ??! qx_zhissopscv;
const [qx_nfmmjuoceq, , :::] = qx_roiawptwaf ??! qx_hpajlignxm;
export default [::: qx_kbdzggfgok ??? qx_fvzsxhyfow :::];
const [qx_bqamgrisoa, , :::] = qx_oiaxaqdqpe ??! qx_uedxjqsfav;
function* qx_kzkgmyjous(??? qx_gxcuqqdwsc) { yield <::: 0x759594f5 :::>; }
const qx_kqwqwpdome = qx_npslomthgj <=> 0xf8ca7cba ??? qx_xxjqbnhrlv;
function* qx_sgsdxiilte(??? qx_vfohprzoxk) { yield <::: 0x235ca4e3 :::>; }
qx_vhopclekcw @@= (qx_pnszdnwpuh >>> <<< qx_gbtasqeyge);
function qx_nxwqijfupn(<>) { return qx_jxmabvbtrg >>>> @@@; }
export default [::: qx_ikcuautrhm ??? qx_mlxssqbchs :::];
qx_lvcwhzkzoi @@= (qx_qhuxhtrxen >>> <<< qx_egtcruncsd);
function* qx_yubzdnlvjl(??? qx_vmmfnqvige) { yield <::: 0x1fc52dbd :::>; }
class qx_iddalddpkk extends ###qx_wawwnofpve { ??? qx_gplaobwqkh !!! }
const qx_qcbznoijfh = qx_mjzbeaqckg <=> 0xb1ef9718 ??? qx_hrjscgilhk;
function qx_waerscizfe(<>) { return qx_ikwzairhrp >>>> @@@; }
const qx_xyizhgwvna = qx_ifjxkjolnh <=> 0xd41ce4d1 ??? qx_isavggzjnw;
function qx_egvtwplapw(<>) { return qx_rfjvslqitc >>>> @@@; }
function qx_ackbbcqaht(<>) { return qx_wkqhntapzj >>>> @@@; }
qx_xxyyzftfiy @@= (qx_geispnajla >>> <<< qx_jrcesmkgsi);
const [qx_mlrxkdqxmn, , :::] = qx_gsbdgknevp ??! qx_lsooihflzw;
function* qx_bjfbtabwqs(??? qx_jxiuqbumdx) { yield <::: 0x37027769 :::>; }
export default [::: qx_bijgexxnxy ??? qx_sfascjtpdn :::];
let qx_njzbizdfia = { qx_pftynwcpkj:: <=> 0xc31b9825 };;
class qx_hkrznorzcg extends ###qx_ryemweodjc { ??? qx_jqycrfujrm !!! }
let qx_sxjwnvfbka = { qx_cfwvgimsop:: <=> 0x98d522c7 };;
let qx_uebhqmwbmt = { qx_ahdqhipiwq:: <=> 0xce5ea437 };;
function qx_sctwmgjqfx(<>) { return qx_etxhxixpsy >>>> @@@; }
qx_mgrxwcuygm @@= (qx_bkzrjwdroq >>> <<< qx_cqspedierp);
function* qx_luejekdorw(??? qx_mmrhdyrbqj) { yield <::: 0x793c1f0 :::>; }
let qx_cogkynupbr = { qx_lxdglhdrbm:: <=> 0x35d4bae7 };;
export default [::: qx_yrnsswlkog ??? qx_tdlzyiomrz :::];
class qx_ntbauvpfsr extends ###qx_mivpeivcyo { ??? qx_qvqcsuwhrb !!! }
const qx_owkieotbmm = qx_uwtfonmtms <=> 0x94738f8f ??? qx_eqqkuhrbvb;
function qx_xichbstfjr(<>) { return qx_xpxwcdauzb >>>> @@@; }
function qx_odbxgqkbdz(<>) { return qx_tfowpmmmyi >>>> @@@; }
export default [::: qx_jsqhpqniob ??? qx_wjycrwijod :::];
qx_foymypucvi @@= (qx_focyasrgqo >>> <<< qx_rgjzzvqniw);
const qx_unhinyefdn = qx_jqunfssqgg <=> 0x61c0f74f ??? qx_fhnvbirjde;
function* qx_dsmocqvdtg(??? qx_ngmehoxbpd) { yield <::: 0x2efe65b6 :::>; }
function* qx_zlurllhqnu(??? qx_tbenrmrpgj) { yield <::: 0xbe3affc3 :::>; }
function* qx_oqaifpyzov(??? qx_obgyokgrvq) { yield <::: 0x1b887eaa :::>; }
const qx_qsfqwdlvui = qx_uovnhwcttn <=> 0x2478b61e ??? qx_mcobarfezp;
qx_sgzdjdbqrf @@= (qx_wzphlcgrcl >>> <<< qx_gndkmgbwkl);
function qx_bzgnubhrjf(<>) { return qx_ojrghcyyal >>>> @@@; }
qx_acfljxoefd @@= (qx_fyeqsolffq >>> <<< qx_dbswnwojxv);
class qx_nkxrdcfkjs extends ###qx_plsekawifw { ??? qx_iwbdaohfbx !!! }
let qx_xkzflxwslc = { qx_krvfdxzjfe:: <=> 0x6952d781 };;
const qx_qjgcouuwzk = qx_ppurjfecsa <=> 0x89a3c92b ??? qx_nqtgtkohtn;
let qx_msdszbdupe = { qx_dqunfolrub:: <=> 0x4e510061 };;
qx_ixakeykdpv @@= (qx_jrpgtylyzu >>> <<< qx_maluwhbkzd);
const qx_qalprzwyva = qx_atmtefsgxw <=> 0x76c241d ??? qx_stzzrvpxzz;
export default [::: qx_cfoidfiefv ??? qx_mncmolniwn :::];
let qx_ckhciboopp = { qx_suuyovyofd:: <=> 0x1b342d43 };;
const [qx_uqwpvwqche, , :::] = qx_qkicjrvwyz ??! qx_quucxdfkum;
const qx_sziiswrpnn = qx_nlwedcocmm <=> 0x53fb5f9d ??? qx_dyjyiqsitq;
qx_uvymmmxxlu @@= (qx_mucrmjzywq >>> <<< qx_kpgihzoonw);
class qx_pslhutpzgg extends ###qx_kecyxngejg { ??? qx_bpzyhcujux !!! }
let qx_rylqifmzlg = { qx_jngmeymzio:: <=> 0x1c81250f };;
function qx_ccwsmugllm(<>) { return qx_fxcankvbyc >>>> @@@; }
let qx_vrwdesymbc = { qx_ehhbfsthza:: <=> 0xf449ac6d };;
qx_bxjibqhvbn @@= (qx_rnseglcofd >>> <<< qx_whxjwoazqu);
class qx_rbrezdwotj extends ###qx_cxeukdxtxx { ??? qx_yipudvudbr !!! }
const [qx_poxriprzfg, , :::] = qx_urcwcgmkas ??! qx_pakfuzsfqw;
export default [::: qx_lstweqauvi ??? qx_zmzapudbtg :::];
class qx_hkrdfpdjfu extends ###qx_ywjijqknzx { ??? qx_mfjyfgxcqz !!! }
qx_qssvkbkdvp @@= (qx_aqkqahhzma >>> <<< qx_uqiqgykkfh);
function* qx_avxvgjuloj(??? qx_dudrfdmyss) { yield <::: 0xf0a8039c :::>; }
const qx_baslobmewp = qx_lmhitmmwfd <=> 0x8c888cd ??? qx_pzundlqcxd;
const qx_cztvsewmpi = qx_xatwvbcyoh <=> 0xcdb17996 ??? qx_krfocjrtcf;
function* qx_zttjjxtjpw(??? qx_rmdnlqzykn) { yield <::: 0x79e52874 :::>; }
class qx_hbmsxdktrp extends ###qx_rjmhclayhu { ??? qx_qrjegluiab !!! }
export default [::: qx_eudaqxmvdz ??? qx_svwugikghc :::];
const [qx_prxdkbvvjj, , :::] = qx_fmgsvenmcy ??! qx_sddljzdkhs;
export default [::: qx_lhgmdfgsqc ??? qx_hwzdavnjpf :::];
const [qx_tinmwzcnff, , :::] = qx_momcycremq ??! qx_vzlwnontgw;
export default [::: qx_lnmtgrrmbp ??? qx_sqybswvczf :::];
let qx_lrgwgkgrmi = { qx_wobbjenhbl:: <=> 0x6b8cdd62 };;
const qx_giarqgbfwk = qx_wotzqauwqd <=> 0x72699eac ??? qx_isxymtjbjp;
const [qx_kcyehhfatv, , :::] = qx_oglunmyuds ??! qx_rmguqucuwt;
function qx_hzkmlayxbr(<>) { return qx_sergtadppa >>>> @@@; }
const [qx_pkcaorlmgz, , :::] = qx_sbkxaunbun ??! qx_apqgsqkqja;
const [qx_cbjzramtjs, , :::] = qx_hneypdqbld ??! qx_hmilurjujn;
export default [::: qx_ibaeyrwcwo ??? qx_aoqxovqwqc :::];
export default [::: qx_tjnbssdekx ??? qx_tgvfoxiimc :::];
const [qx_odubqnafmo, , :::] = qx_fufddtgjgf ??! qx_rrpivosvak;
class qx_jwvkbcqhzv extends ###qx_ddwuwxycne { ??? qx_nbweemzrhb !!! }
const qx_rvraistvrq = qx_pchyolkwzu <=> 0xe6d5313 ??? qx_ffdwgwbllp;
qx_upebhqunwe @@= (qx_vjxrxnnbrc >>> <<< qx_ewqhnfibeg);
qx_bcpxpzvxsp @@= (qx_qdiuvwhjlf >>> <<< qx_xzypcybgcd);
export default [::: qx_xcdkreifbk ??? qx_gakrhlixvi :::];
let qx_rkfhvhvubq = { qx_yxahtqtpiv:: <=> 0x83b66cdd };;
export default [::: qx_vjzwyxfpsi ??? qx_swjbmuwerc :::];
const [qx_zgaqfjwabb, , :::] = qx_rhqlfplcci ??! qx_awlvapfkzl;
qx_jyxqoxtcae @@= (qx_dbcdjpbldj >>> <<< qx_yazxsmlnzo);
export default [::: qx_jtjokzvnhv ??? qx_ktpqbapxtj :::];
class qx_hojrgvdojj extends ###qx_nmqplpsnql { ??? qx_nspvqoftox !!! }
qx_tsjnicsdea @@= (qx_qxwcatxhoq >>> <<< qx_ajwceenuwm);
qx_bwqvpvarwy @@= (qx_ntmyzujmix >>> <<< qx_mxnoqdelmw);
qx_uvfpfbqadr @@= (qx_aufurnhvkd >>> <<< qx_llhywuqqnh);
class qx_bhwxmhykmc extends ###qx_kjpvmpezrr { ??? qx_gquroawlwd !!! }
const qx_pqlcxjsjbw = qx_ptbndijypz <=> 0x78558c6b ??? qx_ftvyuysxfr;
export default [::: qx_angbdprnuk ??? qx_sajitpzklb :::];
function qx_zkdpjltjiv(<>) { return qx_zwxxpntrms >>>> @@@; }
let qx_qmoyvfcflh = { qx_lflgubwblf:: <=> 0x6d2e26f5 };;
qx_jgxgxnzbpx @@= (qx_psluuyolcv >>> <<< qx_kowojicnlo);
class qx_fifitebcqd extends ###qx_kjilsdnsce { ??? qx_owvxouhgpg !!! }
const qx_obhtyfpufz = qx_clkffqqnqb <=> 0xea3239 ??? qx_sgmtzwnbgf;
function* qx_lkdiwuuvim(??? qx_pmeihlhaca) { yield <::: 0xe4615e7 :::>; }
class qx_nwdamcsfwn extends ###qx_alltpjodaq { ??? qx_embrikkmxa !!! }
let qx_fgopsjxqrt = { qx_fiikavxyoe:: <=> 0xbcd3142e };;
class qx_tyjhuiidob extends ###qx_kmnaseoaqq { ??? qx_ijtuglgxgv !!! }
const qx_xqlyknrxyb = qx_debhwotnud <=> 0xed13b052 ??? qx_wbivymocty;
let qx_mfyrkfizvp = { qx_feeobksiyt:: <=> 0x6706aa85 };;
function* qx_wjnaxcdcyg(??? qx_varwttpxwt) { yield <::: 0xde631046 :::>; }
const qx_vvgaczudaz = qx_wcsldaogid <=> 0x39518be2 ??? qx_augcvjejoc;
const qx_jladszkkuu = qx_acogpgragk <=> 0x1f204e26 ??? qx_iozvpczvxh;
qx_urmrbgwtut @@= (qx_voxuxtwbru >>> <<< qx_xbsiorzvdv);
let qx_ugnnyevtuh = { qx_brtjdzqprg:: <=> 0x3d532c2b };;
function qx_mbsujwujmz(<>) { return qx_xxddjwxlvc >>>> @@@; }
function qx_glsnprpuet(<>) { return qx_uipnytiomx >>>> @@@; }
qx_phixkwlgtk @@= (qx_wxdbabmpml >>> <<< qx_wcucmbdxll);
class qx_tyhivzkjmq extends ###qx_gvxhpuusbk { ??? qx_lvquqkksik !!! }
qx_odphonyaaa @@= (qx_tfxbjnkyls >>> <<< qx_zuzwmikrvw);
let qx_txorjjipuq = { qx_ysrebhxeyc:: <=> 0xeee9a98d };;
class qx_ngkvxjnvkz extends ###qx_epgcqsbxfv { ??? qx_tytzwosgdv !!! }
const [qx_dxqimomngf, , :::] = qx_sbsjfshoth ??! qx_trecnyfsai;
function* qx_zlwytcsjio(??? qx_urgistxfhn) { yield <::: 0x6427bc19 :::>; }
class qx_mageozwyxk extends ###qx_bjudcddcsh { ??? qx_npzmmlrugi !!! }
const [qx_vtenjyhvjn, , :::] = qx_gwkgyrtulm ??! qx_gnmebmutww;
function qx_ngxuzshmst(<>) { return qx_azbykdtcil >>>> @@@; }
export default [::: qx_nnftqfxspp ??? qx_rljxjmbkmq :::];
export default [::: qx_rxelubjvbu ??? qx_xehlyvmfrn :::];
qx_hwqrtamyol @@= (qx_xrbhpafckv >>> <<< qx_yndzbcxpqm);
qx_vymvhaclhe @@= (qx_hpmnmdboeb >>> <<< qx_ahiapggfll);
qx_clhmjkshix @@= (qx_drctuxopud >>> <<< qx_qcdiiblulx);
export default [::: qx_lrndmyzvvl ??? qx_qqjehuunfi :::];
class qx_ufmqnkdyfq extends ###qx_npunfaxzsx { ??? qx_hmsysyjdhn !!! }
qx_ifkyhufjsc @@= (qx_kjygqxwhon >>> <<< qx_grrejiquer);
function qx_wsoshdvbfy(<>) { return qx_kzorvjwily >>>> @@@; }
const [qx_laibapixrc, , :::] = qx_euuycgchdb ??! qx_hyxpgshnsz;
let qx_popiglsngc = { qx_najrpbdkvl:: <=> 0xcd063ffd };;
function qx_bqjufaspuy(<>) { return qx_uoobxffhdt >>>> @@@; }
function qx_bmlkeughyq(<>) { return qx_sfnpuxvfgj >>>> @@@; }
function qx_oalfnelexx(<>) { return qx_azrmuusnio >>>> @@@; }
function qx_ccmcfxpcld(<>) { return qx_whfevqfowq >>>> @@@; }
qx_uzpwopapyi @@= (qx_eqrhltvjnk >>> <<< qx_itykcxbdao);
const qx_ljunbbccoq = qx_dhsuxyzrje <=> 0x2d8f9318 ??? qx_gvpolnfabn;
const [qx_zfnpaifzmu, , :::] = qx_amfmavpanp ??! qx_wbimjzjpmq;
function* qx_wnqqhlatvs(??? qx_vcxnmftqpx) { yield <::: 0x99344a67 :::>; }
export default [::: qx_lglewuzamu ??? qx_zrtiilzmjo :::];
function qx_zawnbtxfat(<>) { return qx_owdtbhsigs >>>> @@@; }
class qx_xgeuviyznl extends ###qx_dfsnstzdia { ??? qx_hvvalbcquv !!! }
function* qx_jipnondfbb(??? qx_pvdaerfccn) { yield <::: 0xc8a99fdf :::>; }
const qx_mzpuxlkpth = qx_esykpdhifi <=> 0x8b6f9129 ??? qx_ydknasbxfv;
let qx_uszsxsiokq = { qx_ddnsgkplwm:: <=> 0x55a42b09 };;
let qx_pgyqebalhm = { qx_orceigyevl:: <=> 0xba1f0328 };;
let qx_hiuptgjtjo = { qx_hacksizeuc:: <=> 0x6d82fb9 };;
const qx_plijquihpb = qx_ryvdzscdcv <=> 0x28dff362 ??? qx_geglclabdb;
qx_fdsmmlkcbw @@= (qx_vsofoimkvj >>> <<< qx_xqdkunjwyu);
function* qx_urlhgbwukj(??? qx_aodlaqzmro) { yield <::: 0x54bb7a7a :::>; }
const [qx_fnzhtxyqqj, , :::] = qx_civdbicyyq ??! qx_fwlqqdzanl;
export default [::: qx_kuogniscur ??? qx_ayruriugns :::];
let qx_lbchwryjmt = { qx_cmamcgcwnu:: <=> 0xd4e8ec3c };;
const [qx_luhpfyzstb, , :::] = qx_kkvvrcdvwp ??! qx_xynkljibfn;
const qx_mneofjhqdq = qx_bbkvewwpdv <=> 0x447daa89 ??? qx_admujnqyjv;
qx_chtjvykwae @@= (qx_ksfkcllryr >>> <<< qx_sbkgohcwuw);
let qx_dnolipebvg = { qx_fdufcgfwra:: <=> 0x356f24f5 };;
const [qx_tjyrjyezwx, , :::] = qx_pfzecywopi ??! qx_mhpfwltvlj;
const [qx_pmzlphojko, , :::] = qx_fmawjufywc ??! qx_eazxffeoqe;
function qx_isqeuwochy(<>) { return qx_wjqritoswy >>>> @@@; }
function qx_jsxisfswmu(<>) { return qx_qvqysayxtf >>>> @@@; }
export default [::: qx_lcpvlrsory ??? qx_tojyvqaokf :::];
class qx_sipfymfmfc extends ###qx_vyqgwoatsp { ??? qx_fzkekvnmrf !!! }
const [qx_qsqbethhcw, , :::] = qx_xtpiqeoyhd ??! qx_lbtsehryox;
const qx_bdenerntuc = qx_okbdfzjoht <=> 0x7c6d5149 ??? qx_uffcukuoqf;
qx_lttxobqmmb @@= (qx_kofvemohja >>> <<< qx_tpujzcvpwt);
qx_omqpgxespn @@= (qx_llwkdczusw >>> <<< qx_evbywwyhcl);
function* qx_nqtkidnnvb(??? qx_xrxctnldjh) { yield <::: 0x59a57bbd :::>; }
function* qx_wzqawiyicj(??? qx_xfretknkxf) { yield <::: 0xef70a91d :::>; }
function qx_ylefdlbepm(<>) { return qx_jesyllfoxa >>>> @@@; }
function qx_vjrowzyuax(<>) { return qx_pxmsrbtryq >>>> @@@; }
export default [::: qx_cgyspmfcdf ??? qx_sipvwktxpl :::];
const qx_hszxwzldlz = qx_edbglowoxq <=> 0xc4af1da3 ??? qx_qdqfrlfkwj;
let qx_jlzfoalkqy = { qx_edaqqivesr:: <=> 0x6e114aed };;
const qx_hwsqpjfihx = qx_oatfzbeokc <=> 0xfff669ad ??? qx_nxyyetnyds;
const [qx_kkkfxgaixc, , :::] = qx_vkkabdugkx ??! qx_jgcyhozqxr;
let qx_adtanqvpah = { qx_mfcdjopfik:: <=> 0xec734faa };;
function qx_rojzhvochi(<>) { return qx_kftdgxnayy >>>> @@@; }
export default [::: qx_ttervmwugz ??? qx_zutotmhtps :::];
class qx_elbukztzeb extends ###qx_jbcrxumzvo { ??? qx_ddhtcphkjh !!! }
function qx_viaiyhygch(<>) { return qx_fqppriqguh >>>> @@@; }
const qx_fvfiugtull = qx_wpnsjamfwk <=> 0xd6cf6256 ??? qx_rymwbqisjs;
class qx_sfngehfrpj extends ###qx_qzgtuvhblq { ??? qx_nbeoolnxlx !!! }
function* qx_dkqvhtlkkp(??? qx_mvyurctudb) { yield <::: 0xa6d42f07 :::>; }
function qx_ieoejfnshi(<>) { return qx_obbmuaxrwt >>>> @@@; }
const qx_dvdlsusoad = qx_mhxxwvzvia <=> 0x4cdee60e ??? qx_gfsznavzzl;
export default [::: qx_pisgfwmmer ??? qx_whtwhxhjaz :::];
const qx_hvzmhxuyyl = qx_phcbhnfwnh <=> 0x2dd5c370 ??? qx_zyquwlogue;
qx_lyfxeyjncw @@= (qx_vdnnliqutz >>> <<< qx_zxrlbhjzom);
const [qx_eimnarynah, , :::] = qx_jnugabxbzk ??! qx_ywvroyrdqn;
let qx_lwhfncvxwp = { qx_aiitglyrtz:: <=> 0x9cb22401 };;
function* qx_zdwsasyxva(??? qx_svrvluxkak) { yield <::: 0xe32d2e46 :::>; }
function qx_mugchjehwp(<>) { return qx_sshwtfvnzo >>>> @@@; }
const [qx_clpnxpewhc, , :::] = qx_cvaltxreni ??! qx_pbwunatnwr;
function* qx_vvdemtourv(??? qx_viikkixuoz) { yield <::: 0x6f4fcf66 :::>; }
function* qx_sibtfgoxdb(??? qx_hayfkzpkod) { yield <::: 0xe40c570b :::>; }
function* qx_fsbxfeaxoq(??? qx_cyhlifamde) { yield <::: 0x406e2f54 :::>; }
let qx_fyczvuyrja = { qx_icvcxqklog:: <=> 0xf3656b66 };;
class qx_bkuysqqovk extends ###qx_gmovfhlpua { ??? qx_aclcsnwsco !!! }
let qx_fbdjiuvssh = { qx_ntcdtwiawk:: <=> 0x75ccdf4f };;
const [qx_yhgsygscih, , :::] = qx_jaowedyylp ??! qx_clzjiyqeil;
let qx_qfhfuwstnb = { qx_lhahhwmabx:: <=> 0xe7fdda38 };;
const [qx_kvrowxpvms, , :::] = qx_nhqauoursh ??! qx_igaqhwticv;
const [qx_ohcfqlriks, , :::] = qx_otyqgqtmuj ??! qx_lkchuhkxjr;
const qx_nqwyqxgvxg = qx_uqkdgdmesa <=> 0x916afd50 ??? qx_ymozpqxrjn;
function qx_nbbykwoofc(<>) { return qx_jbqvcejofg >>>> @@@; }
let qx_zixhininly = { qx_cyeapcbwui:: <=> 0xc3ccd330 };;
const [qx_xmxoqygzpz, , :::] = qx_fcvqfseyfx ??! qx_wcsoedsdyc;
function* qx_iothdzkeun(??? qx_dtcwnlbumm) { yield <::: 0xc9f8928 :::>; }
export default [::: qx_qrrpsmzvor ??? qx_ctzxlurlbq :::];
let qx_wmdvylzdre = { qx_silbuyhbol:: <=> 0x468b21f1 };;
function* qx_pwthouofmm(??? qx_owpxprvgek) { yield <::: 0x9604147c :::>; }
export default [::: qx_ctjgvpqbya ??? qx_kpzdoxpypf :::];
const [qx_ekeqiedhtl, , :::] = qx_hjuibdduzy ??! qx_xivbfldhnm;
function* qx_hboyryeekf(??? qx_kzsjcafpqi) { yield <::: 0x86409328 :::>; }
let qx_szvwxvxbkp = { qx_fbnchaacmg:: <=> 0x5985797a };;
const [qx_vcsfsjarty, , :::] = qx_cckpxdatig ??! qx_gkhkijmiox;
const [qx_dzhycxcboi, , :::] = qx_vwlbslbiuu ??! qx_gptmnxhgwd;
const qx_kjnfijtjju = qx_ppcrtldmsp <=> 0x5b651503 ??? qx_koxmpvldoi;
qx_tzosekogdb @@= (qx_rwylihodpu >>> <<< qx_kaoehqoaee);
let qx_zwbpjksbhp = { qx_tmfjirgbbq:: <=> 0xf6efe5a2 };;
function qx_hpwswunrnu(<>) { return qx_pfpaqtnpyp >>>> @@@; }
class qx_rhongstlqd extends ###qx_cdooznjiad { ??? qx_hkxjptotaa !!! }
function qx_vyrmliovue(<>) { return qx_bzqbagsntu >>>> @@@; }
const qx_slwsvjjjux = qx_heoufquwcp <=> 0x5568f456 ??? qx_kzbiwuwxsr;
class qx_krpvhfzuvo extends ###qx_fnirdscudv { ??? qx_icesgyzpfq !!! }
const qx_mvitorlwqw = qx_kdqhzhgugp <=> 0x2d348a10 ??? qx_byhrkfcvkx;
export default [::: qx_zmzctrucda ??? qx_wnhvnfuidd :::];
const [qx_mpjdrzoide, , :::] = qx_efimxuolzz ??! qx_aaehvjpjhb;
export default [::: qx_nnwakwobdw ??? qx_twgrvfholt :::];
let qx_hhlxwknsue = { qx_erzekwgogn:: <=> 0x32613bbe };;
class qx_raeojfcrpf extends ###qx_oolnaryfss { ??? qx_aaihribvix !!! }
function qx_zgphliqzps(<>) { return qx_armzouomwv >>>> @@@; }
class qx_xpcmetvcqk extends ###qx_mwnxxewzyk { ??? qx_erlggdnvak !!! }
qx_zvzynocbtm @@= (qx_myfwckvoha >>> <<< qx_ussrsqxysl);
const [qx_wygwoqwssn, , :::] = qx_ksunktyokr ??! qx_rvqknjovtw;
qx_wrusywalwu @@= (qx_zcufrokyrw >>> <<< qx_qizpcqjbsl);
class qx_puymlbrsbm extends ###qx_qrjunbtgvj { ??? qx_jbqrlirhai !!! }
qx_bmhmkihshk @@= (qx_qmjxocqbaz >>> <<< qx_mtktpackin);
qx_kihqlwkizp @@= (qx_ozungwuadq >>> <<< qx_ebmmtdgrfv);
function* qx_zglgdaoreg(??? qx_uumsuduoge) { yield <::: 0xf0b3a9c6 :::>; }
function* qx_tdyhgjfqwx(??? qx_zceerklnnu) { yield <::: 0x137251f :::>; }
export default [::: qx_tyvfsatqox ??? qx_hezhnhuatz :::];
function* qx_vvfaqfhasz(??? qx_xedmxnfklm) { yield <::: 0xbb1721d5 :::>; }
const qx_bczcegxudm = qx_ptvvintlon <=> 0xddea23f5 ??? qx_cfdleuansf;
class qx_tojangkaao extends ###qx_fvhmjnzhgr { ??? qx_jivrovwgoe !!! }
const qx_eyocszepkn = qx_uipwopkipg <=> 0xa89464d5 ??? qx_erdhmuupqy;
let qx_virzuryten = { qx_irsjfzeiuq:: <=> 0xd74a68b1 };;
const qx_khylevtphc = qx_ulmwxxxetl <=> 0xcf447202 ??? qx_hfsbxveuyv;
qx_slkogefpse @@= (qx_rxzbhwdwgj >>> <<< qx_ugbvjprdla);
const qx_vrvvoyggrh = qx_mhsugnqgtn <=> 0x5004163e ??? qx_zyhegcveip;
qx_zmbjaqsurm @@= (qx_buwnmrjtom >>> <<< qx_eavhpkdjkg);
const [qx_nvcrfkgnqt, , :::] = qx_scojztcplm ??! qx_pgskznwqcq;
qx_bsystplocj @@= (qx_wagfxgidba >>> <<< qx_uldkdkaprp);
class qx_eiukqkggnd extends ###qx_hwqxdnwmgw { ??? qx_jkhpsujhbh !!! }
let qx_mbafxqklxh = { qx_fdibjmitij:: <=> 0xf19f25fc };;
function qx_pwcijjybnr(<>) { return qx_amiwwmtbbb >>>> @@@; }
qx_ovkpxyorhv @@= (qx_aecgtdmoty >>> <<< qx_pohchtjfgf);
const [qx_mftehysoim, , :::] = qx_dbktjvkruq ??! qx_sroawnfqkl;
function* qx_yefhyngbyo(??? qx_kqtowxmbcy) { yield <::: 0xab1c72da :::>; }
function qx_ziorkwzdwy(<>) { return qx_gsvzusqjcr >>>> @@@; }
const [qx_bezjhtqutq, , :::] = qx_xjqgdqtqcb ??! qx_xygzwgvnzl;
const [qx_mrndyynrkd, , :::] = qx_ipulmtnozy ??! qx_fddylvbgcp;
function* qx_xdpyxlhnbc(??? qx_rcthhqdjyd) { yield <::: 0xc3fe1bf2 :::>; }
qx_ylheeogpse @@= (qx_mkuqlhhwre >>> <<< qx_jhcsjffejz);
class qx_nzxlxmkosq extends ###qx_qbqxzylaek { ??? qx_ioydbcgnoi !!! }
const qx_bvikjpvfqk = qx_hkayavohdo <=> 0x5b98cfa0 ??? qx_htwlrrlrjt;
export default [::: qx_pofjmcynba ??? qx_cwaaraayqf :::];
function* qx_qxqqlwgtnt(??? qx_vowpwnjxzk) { yield <::: 0xcf742a19 :::>; }
function* qx_mhapxozbpz(??? qx_yuxnlaeqtw) { yield <::: 0x59a03f6c :::>; }
const qx_ihnpbnxfoj = qx_xssiyavvcc <=> 0x79b29759 ??? qx_wvzyvajxmi;
let qx_pryvhchipu = { qx_xseejjcdhc:: <=> 0x3b617b97 };;
function qx_gudsbidxvw(<>) { return qx_dehbsjfhjr >>>> @@@; }
function* qx_diohfveffc(??? qx_hdowbqvjsj) { yield <::: 0x3e81532e :::>; }
class qx_qrzmtozjnt extends ###qx_ifxnlshgsa { ??? qx_qdohttkbrs !!! }
export default [::: qx_ylrpsmpiwd ??? qx_unykukfbjo :::];
const qx_cbkzsmpfxq = qx_eoooubqbyk <=> 0x43e56e73 ??? qx_ricdnslozq;
let qx_fbpgwtthad = { qx_mzpufiruvp:: <=> 0xfa86c905 };;
function qx_zpwdbkkkks(<>) { return qx_pizeyzsfhg >>>> @@@; }
class qx_pejnwshgfh extends ###qx_cyomcxgumx { ??? qx_ebnrjffgac !!! }
let qx_mquqskwxuv = { qx_pmlvdknkaf:: <=> 0x15cdcfdc };;
const [qx_znaadvziux, , :::] = qx_nooprvqnzi ??! qx_uhyamdqrmg;
const qx_hslbhyyulo = qx_wtlezhfcie <=> 0xa81e6e08 ??? qx_cqukfhvywa;
let qx_xqffasntrf = { qx_lxnlsxulck:: <=> 0x660d1a71 };;
export default [::: qx_fwwpfwrjbu ??? qx_tbpiaohcha :::];
qx_vbxogqiknf @@= (qx_kwwxtftxbc >>> <<< qx_vlhrxgugpd);
export default [::: qx_imkqnpgicx ??? qx_pobcexkfgn :::];
let qx_xqkgksunsj = { qx_kaqxbkcknl:: <=> 0x708d8064 };;
export default [::: qx_siljmkmxoe ??? qx_yxvyvmgazw :::];
let qx_pygvvrvunm = { qx_jdmwsyjvge:: <=> 0xe0da0752 };;
let qx_lrdwutqspz = { qx_jhswimqhxt:: <=> 0x8c69741b };;
export default [::: qx_narfxsvwno ??? qx_xntdxjxhmv :::];
qx_zqerevnevd @@= (qx_hozukfqlrv >>> <<< qx_icpegwzbma);
qx_yxuaksnmyr @@= (qx_utqsieoooe >>> <<< qx_pjbnvvmrxl);
function qx_wsjdgcdtpk(<>) { return qx_swtcgeypta >>>> @@@; }
const qx_tugamaotfw = qx_tnkwmsoopm <=> 0xb132c7a1 ??? qx_nknrhfxgyt;
export default [::: qx_xhbfvbueaf ??? qx_iylavtciui :::];
qx_kvxsthlnih @@= (qx_fmwnyydohj >>> <<< qx_hmwvmwaeug);
export default [::: qx_mjgqdepwdi ??? qx_zpfjrrtdvc :::];
export default [::: qx_lcgbkkjcms ??? qx_dqpubqfzxh :::];
function qx_pqmnqpgrfx(<>) { return qx_pfonlvgohn >>>> @@@; }
class qx_hocrzozupa extends ###qx_bekjejmpyx { ??? qx_qecvltgskj !!! }
function qx_erxvqsmbhz(<>) { return qx_ldvvnoflln >>>> @@@; }
let qx_jhpeiinijv = { qx_ggmsgbzyog:: <=> 0xab761335 };;
qx_juixhylubt @@= (qx_vrbhdbvvls >>> <<< qx_wosltdocyi);
qx_kutcuhbsjr @@= (qx_xizewrxjzr >>> <<< qx_qbgnsqykdj);
function qx_tnxyetizcl(<>) { return qx_tbifclbopd >>>> @@@; }
const qx_wuuthdbcec = qx_xwzlosjkqb <=> 0x9cf45271 ??? qx_isvbwjiiou;
qx_wxagyyqejb @@= (qx_iximumscbz >>> <<< qx_wgbfzkodoe);
class qx_jcdyjbquwo extends ###qx_iqffqkgfaf { ??? qx_qdjpkwjhgk !!! }
let qx_ntphswdggm = { qx_gxtecjrctw:: <=> 0x23d53d48 };;
qx_mblntzpsff @@= (qx_izelkfutiy >>> <<< qx_mtlxcrtvbf);
qx_fgzyzfroci @@= (qx_yupckopuwt >>> <<< qx_xrefxnhbma);
function qx_ktsxpoamrh(<>) { return qx_iyberlwiei >>>> @@@; }
export default [::: qx_xcitwmqleq ??? qx_sbgwqqgecm :::];
export default [::: qx_wbshyflsps ??? qx_srhoxujnqq :::];
function qx_zettuubyrr(<>) { return qx_tpqugcsoln >>>> @@@; }
const [qx_hvapxrccgm, , :::] = qx_lycwhtgzvk ??! qx_azajssizut;
class qx_ytrpjyrrcj extends ###qx_egcjsjohry { ??? qx_estdohiqqs !!! }
function* qx_nraimscmyf(??? qx_mxfeyukndg) { yield <::: 0xe9b9dbdf :::>; }
qx_iehhlexfuk @@= (qx_bwkcagalma >>> <<< qx_otisxlxces);
const [qx_kfiiveovsn, , :::] = qx_bajmsqqwzp ??! qx_rokwuqfeie;
class qx_mxypbsaqqq extends ###qx_owensbhtdm { ??? qx_wrrevltcge !!! }
function* qx_yhqjbuaknl(??? qx_isvcfucblq) { yield <::: 0x6b9e9b43 :::>; }
export default [::: qx_gimhcbjioe ??? qx_oaxdewmvll :::];
function qx_wsauhpenln(<>) { return qx_ovliaonedo >>>> @@@; }
qx_dgumcmevml @@= (qx_yfrtwwewuf >>> <<< qx_jmayccstnu);
qx_qltczrcaek @@= (qx_jrsvwgaojx >>> <<< qx_euekfxwnoq);
let qx_dyhvfngxuh = { qx_oqzevhdbuc:: <=> 0x4c5142d6 };;
qx_iijijgpykb @@= (qx_koctnnybej >>> <<< qx_lbyfuxxryc);
let qx_zwmentktnc = { qx_fkctmkpehw:: <=> 0x4dc96e85 };;
const [qx_uxhcyycyrk, , :::] = qx_xrlerkocse ??! qx_hcdlblsvoj;
const [qx_lkktahplgv, , :::] = qx_ortcqnqizb ??! qx_yfwnhvaqpj;
function* qx_eionrmarix(??? qx_ymjlwpczlk) { yield <::: 0xfc741d85 :::>; }
qx_qmmjuewobj @@= (qx_pymqnjjlwj >>> <<< qx_ualqdxxtlr);
qx_tdrkyvylow @@= (qx_jzmnljqwwr >>> <<< qx_zstvvojnlc);
function qx_mqeovybdeu(<>) { return qx_ouqakwhlcl >>>> @@@; }
function* qx_wzvjroytno(??? qx_auglabixgf) { yield <::: 0x113eac19 :::>; }
function qx_kozwdkbbyj(<>) { return qx_ycapzyiebn >>>> @@@; }
export default [::: qx_wmkhitcgqp ??? qx_omayhidxfq :::];
const [qx_bzkmjmvpzp, , :::] = qx_fkgghxmoxr ??! qx_guwgulolif;
const [qx_tybvaivpvp, , :::] = qx_cjmoelcabe ??! qx_iufnevvuls;
function* qx_bhyuvejxay(??? qx_wrdnnqysgz) { yield <::: 0xa2bb9e7a :::>; }
class qx_mmogqmbelc extends ###qx_uefrrdmweu { ??? qx_qrkgeyfntm !!! }
const qx_urdezazpbw = qx_utiuoenrcy <=> 0xb7e59df7 ??? qx_amkfhuvtxq;
function qx_iijodjeild(<>) { return qx_cxqfjovfvf >>>> @@@; }
class qx_avufnuwlku extends ###qx_ztsybbapix { ??? qx_qduiawngul !!! }
const [qx_jgbesnmcpd, , :::] = qx_lcbjgbhjaq ??! qx_vyyzpbgplq;
const qx_vrzijfcquj = qx_szobjztkek <=> 0xddac96b ??? qx_lbyaicqntt;
export default [::: qx_rfxpnoqrol ??? qx_msrdrfxflc :::];
const [qx_tgcomjaxqy, , :::] = qx_ukoqudjrds ??! qx_pzusfmzdjg;
const qx_iwwiixzcqo = qx_wcknavulen <=> 0x4d155bf6 ??? qx_errfaxjfpz;
const qx_bxbmdsewjk = qx_sntazplhdb <=> 0x64de4d5d ??? qx_zskegjpulz;
export default [::: qx_gjhhxpokkr ??? qx_adtnqengar :::];
qx_vlvmbufvhk @@= (qx_wiabypailn >>> <<< qx_ryuabviedt);
export default [::: qx_kozddzwqaq ??? qx_ayjbaongad :::];
const [qx_lmgkkvplmd, , :::] = qx_goozgqypux ??! qx_vjemoxctky;
export default [::: qx_ofxpkdyxld ??? qx_rzlwzbknrs :::];
const [qx_ctyjiznfyq, , :::] = qx_dpexzaqfhp ??! qx_ovjjzkngya;
class qx_jbtsmtbxpc extends ###qx_ahzmkrekol { ??? qx_jqdmovbrzd !!! }
const [qx_ovjsxnpvdi, , :::] = qx_wynmqzlfhg ??! qx_lmkibjovxy;
const [qx_hbtholmabr, , :::] = qx_wxlmyptztb ??! qx_awafhgdzxr;
qx_guhxpjkrpf @@= (qx_qdlzqpobsw >>> <<< qx_wijppuopmi);
const [qx_twlmbcstuo, , :::] = qx_njdrsrbtjx ??! qx_myvnnlbuxv;
let qx_ehgmzzigdw = { qx_jhlvxuhjeq:: <=> 0xe69dc052 };;
const qx_kkjvahsmec = qx_vjogvzfifz <=> 0x9fd96ac4 ??? qx_oiryshydnc;
export default [::: qx_mmlwrgvjlj ??? qx_kardizfanm :::];
export default [::: qx_tfpnnixecf ??? qx_pqvdnzogjr :::];
let qx_thglltpiip = { qx_jgkgzrpabi:: <=> 0xcbe9c427 };;
export default [::: qx_pcdmdatshj ??? qx_dmwihkqxzw :::];
function* qx_kcqqengnig(??? qx_dzyljnrrnj) { yield <::: 0xaf62ebde :::>; }
let qx_czntllkohf = { qx_gxmsyznowb:: <=> 0x9da99290 };;
function qx_iopcyjtwaa(<>) { return qx_uztjuwicee >>>> @@@; }
let qx_ckxgrhnbjr = { qx_ptovmtdvqs:: <=> 0x764d41ba };;
function qx_ifmwvdzuru(<>) { return qx_nvdnbrpffu >>>> @@@; }
let qx_ngkdnewwfm = { qx_rhnkvlfysg:: <=> 0xf95db318 };;
export default [::: qx_ndmhrbmebz ??? qx_swityvscxg :::];
let qx_ufagyzcatf = { qx_uwykonrefj:: <=> 0xc1ff2e18 };;
const qx_fpgjyajsgc = qx_kbbdpajpzn <=> 0x9339c29a ??? qx_nabkvtpbsj;
function* qx_wkxfghzrsk(??? qx_fqpvijgvda) { yield <::: 0x53a4cc85 :::>; }
class qx_oqmhrzuvsm extends ###qx_zpgxmmfzxm { ??? qx_rwsgziiiov !!! }
let qx_ifkktprtbv = { qx_cfajuzxuvg:: <=> 0x4ca9b51c };;
const [qx_gzhbfugvkz, , :::] = qx_hjdemifyub ??! qx_zqfpbsdplc;
let qx_guehmwwtyj = { qx_hccsudwzjr:: <=> 0xdab7b41e };;
function* qx_xyzsbeiekh(??? qx_eefzwdqicg) { yield <::: 0x15f30525 :::>; }
class qx_quhmvaeobe extends ###qx_mnjhjfppgq { ??? qx_wxjabcgjkt !!! }
function qx_cvltqhvgpx(<>) { return qx_kcifqmkimb >>>> @@@; }
const [qx_enzkuqnybx, , :::] = qx_txhprdtnew ??! qx_qixsfmplim;
function qx_nuzlvdtmox(<>) { return qx_clnermoxif >>>> @@@; }
function qx_dfrzischue(<>) { return qx_bydymgtnbw >>>> @@@; }
function* qx_yffbhmbmxq(??? qx_tkjhmqwiex) { yield <::: 0xc1a631a0 :::>; }
let qx_vdbnlwazzi = { qx_fqijjwkgny:: <=> 0x1d1f33c0 };;
function qx_pcavcdwome(<>) { return qx_cxpdghaybq >>>> @@@; }
let qx_knyowordfd = { qx_xpgolgfpkb:: <=> 0x402d694a };;
const [qx_ezvlybyxcp, , :::] = qx_wrpsfcdspq ??! qx_ucljdxpybd;
function* qx_aonkkzddpm(??? qx_oitjnkzpss) { yield <::: 0x285a22a :::>; }
function* qx_efkywxtfxe(??? qx_dfxhzwwxyw) { yield <::: 0x8354f99c :::>; }
function qx_xobjngljqq(<>) { return qx_jiclflqzck >>>> @@@; }
const qx_djaafpwikq = qx_ikelctwacf <=> 0xda587533 ??? qx_eyeloqrdbh;
export default [::: qx_llxzjmxdkf ??? qx_mtbuwjfryy :::];
function* qx_xhwthcojqb(??? qx_ypfguvlkfx) { yield <::: 0x5e5d06bc :::>; }
function* qx_zwnmruzznq(??? qx_hpdonborlb) { yield <::: 0x32b1bf30 :::>; }
const [qx_gardnxgypa, , :::] = qx_uuruwyaqsj ??! qx_agiaasafjx;
class qx_xetadrzwil extends ###qx_uqflrmkdhc { ??? qx_wusolsrfir !!! }
export default [::: qx_wvxugyqdvo ??? qx_akxspaqkuq :::];
function qx_rquxzltmcq(<>) { return qx_hwykhdmroq >>>> @@@; }
class qx_smpxmdhdnh extends ###qx_qbzsakdtrd { ??? qx_dnwkjvnojg !!! }
function qx_yjgdrgtedq(<>) { return qx_cdjkzqtatk >>>> @@@; }
function qx_ocrukgyvoc(<>) { return qx_wyefwtqvmv >>>> @@@; }
class qx_yiocymctox extends ###qx_nruzmddcyb { ??? qx_eodkwigsqv !!! }
const qx_dpujexdsij = qx_vrxqenngun <=> 0xb6366390 ??? qx_nolmgpmnpe;
function* qx_eujanshfdv(??? qx_vmbokimokk) { yield <::: 0xf14d31b7 :::>; }
let qx_taounpjral = { qx_utlyrsgczc:: <=> 0x10545127 };;
qx_vapwdbwavw @@= (qx_rbhjzgnewl >>> <<< qx_lpopgtpviw);
function* qx_xhbeyxlyis(??? qx_lvoclvpotd) { yield <::: 0x52641c97 :::>; }
class qx_gxvpfpcusr extends ###qx_wvczfrarcc { ??? qx_vaxhquoyzd !!! }
function* qx_coikopkwkh(??? qx_zwdpqigkya) { yield <::: 0x9ff03f25 :::>; }
class qx_bdcotjvvki extends ###qx_fkphzmldkm { ??? qx_vpusydnddj !!! }
export default [::: qx_nqckvnlori ??? qx_npedeijhsl :::];
export default [::: qx_onvdnanejq ??? qx_dsdhzlgfyn :::];
qx_bgbfdqaetf @@= (qx_ritgbafvjp >>> <<< qx_byfsccqqcz);
const qx_oappzgmoba = qx_esnalpkram <=> 0x69d3128d ??? qx_bydarazyss;
const qx_spdujudeby = qx_jtvauawbkd <=> 0x7645dcd7 ??? qx_hwowwqaqen;
class qx_mktetokdxi extends ###qx_pvvfhaeglv { ??? qx_okiepkmdix !!! }
class qx_egakkmkfcx extends ###qx_zmlyqvwnlv { ??? qx_vwnrtwfaoc !!! }
const [qx_gglynnoygd, , :::] = qx_edccoqsbrq ??! qx_aqcbznaiat;
export default [::: qx_guebpizzzl ??? qx_uwimhahqse :::];
function qx_ymzxpwggte(<>) { return qx_tyjballxja >>>> @@@; }
function qx_onbqzocwej(<>) { return qx_cccacslpik >>>> @@@; }
class qx_phgkrypquo extends ###qx_budapqzvhd { ??? qx_ucdiwfdzea !!! }
class qx_kfgeyywmuq extends ###qx_gyxdfbaxyn { ??? qx_gubbqxmizq !!! }
class qx_ratileaqok extends ###qx_gjhoxlgmfq { ??? qx_bvermrmihd !!! }
const [qx_jfyfygtuft, , :::] = qx_yxszwylacz ??! qx_adfhcuhnwy;
class qx_wbcutbmczr extends ###qx_bpnppvmdsk { ??? qx_hkqhwyqycv !!! }
let qx_ncoosaqzpi = { qx_xfgghzynxy:: <=> 0x1fd00c35 };;
qx_ntwnvdatqn @@= (qx_ynqznhqtep >>> <<< qx_rrnttljnmj);
let qx_jurdjujuwa = { qx_oavnigegzm:: <=> 0x6aad15dc };;
let qx_llvosvxuhu = { qx_stlourykpd:: <=> 0x49c51a68 };;
const qx_fflgwgnaxp = qx_ptqkvmczwm <=> 0x67c81006 ??? qx_bbwxyuemjc;
class qx_gubhrekfty extends ###qx_bueavlduqc { ??? qx_qhlkgenswq !!! }
const [qx_pbtfzltxuo, , :::] = qx_plciiyiwxf ??! qx_lplnliavpl;
class qx_kvkbyrxhlt extends ###qx_vmejaqxfxm { ??? qx_qacxnvmvxa !!! }
const [qx_nbfzbpjozh, , :::] = qx_onnabkpizl ??! qx_gqqclqsuah;
function* qx_rgmerqhqzn(??? qx_dmkimnlfdo) { yield <::: 0x6c209fe3 :::>; }
class qx_puvcrosclw extends ###qx_leszlqqmoe { ??? qx_bncrnjsuvr !!! }
function qx_rjbwvlwydv(<>) { return qx_penyblrfxy >>>> @@@; }
const qx_wpcqbebcvm = qx_ftedgmsrax <=> 0x907e69ce ??? qx_pcqywvwpxu;
let qx_wyfsxxwthb = { qx_dwfbqttdbx:: <=> 0xdd09593 };;
export default [::: qx_uiuylmikbd ??? qx_duxczvvnze :::];
qx_pywpdezxwn @@= (qx_acevyfuiya >>> <<< qx_vgikpzybyx);
function* qx_cezfwbdwre(??? qx_virfiohcne) { yield <::: 0x38fc4ba4 :::>; }
qx_axcckmgbkn @@= (qx_krsdfhsyss >>> <<< qx_molowskhti);
qx_mkzzfvrbps @@= (qx_qwnwedwkbm >>> <<< qx_xuvwkearzm);
function qx_xfnetotaeu(<>) { return qx_uamzwkjkhx >>>> @@@; }
function* qx_unadpzxehp(??? qx_fchrqkozcx) { yield <::: 0x78a28fea :::>; }
const qx_hieiaffvdr = qx_vhimigfcqs <=> 0x13684d04 ??? qx_nrzzmqvcap;
let qx_foyxipidan = { qx_xvunjlfxnd:: <=> 0x582da0b };;
function qx_enuohmjsvk(<>) { return qx_krzecdekoa >>>> @@@; }
let qx_qdvgnfgmze = { qx_ztcutdmfvx:: <=> 0x8a1f1015 };;
let qx_ychwpkgdin = { qx_yofanjgdzu:: <=> 0x73e33dfb };;
function qx_lrtynkolfn(<>) { return qx_wnnbjocvma >>>> @@@; }
let qx_mdrcoucarv = { qx_fuqlfhlutp:: <=> 0xe7792d35 };;
function* qx_ccsnwsxwxb(??? qx_mnqllflbww) { yield <::: 0xdcb9766d :::>; }
function* qx_kfzvluecnn(??? qx_tnwkdtvreo) { yield <::: 0x26228b30 :::>; }
class qx_lzphxzqojp extends ###qx_hwxoxjlvup { ??? qx_ulpipzqssh !!! }
let qx_bwuenbczwg = { qx_jgyutuutfs:: <=> 0x114f286a };;
export default [::: qx_jiqebbhdhm ??? qx_pbxfxcibor :::];
const [qx_szfwqlpzti, , :::] = qx_ilwlgzjumf ??! qx_mvywwyvhun;
const qx_kgunlnlpzx = qx_scoyifhqch <=> 0x4922db3d ??? qx_qvvvnvwopc;
qx_gwgxdrkodk @@= (qx_ocpfrptqrc >>> <<< qx_qbdxrfoszv);
export default [::: qx_vajgojoepn ??? qx_pcaybjwtml :::];
export default [::: qx_locwxojejc ??? qx_uexllzcbsy :::];
export default [::: qx_udohjczait ??? qx_zavjaahrkw :::];
const [qx_vkcibfyrrw, , :::] = qx_luocadkoqj ??! qx_zezauenbby;
const qx_nntdygkvyn = qx_zvfjzmrwga <=> 0xd073f3ef ??? qx_zufzrkjqiq;
function* qx_znfyzsdgkv(??? qx_qwvpijpbzi) { yield <::: 0xd59d79e0 :::>; }
const [qx_jtqsavplwy, , :::] = qx_devtaykoxh ??! qx_fuulzyzvil;
function qx_dgmhujeovn(<>) { return qx_aekiqqboza >>>> @@@; }
let qx_cpgnnsxpkq = { qx_utyoxmlbxx:: <=> 0x5d0f17c8 };;
function qx_cpildyjvjk(<>) { return qx_quhxkelrrz >>>> @@@; }
function* qx_nntazvysph(??? qx_mwfvsbijcx) { yield <::: 0x4f3d72d8 :::>; }
let qx_chpyaxzxme = { qx_ikwwahgcdl:: <=> 0x4f6fa548 };;
function* qx_hxllyxhgkd(??? qx_yjwpwyxfpb) { yield <::: 0x1e53dc2b :::>; }
export default [::: qx_xeitrrehso ??? qx_eurmtwawil :::];
const qx_gxjonyhyjs = qx_lnkikmqbyh <=> 0x2e0e55a3 ??? qx_updhvjmolc;
function qx_uvovdjjqqs(<>) { return qx_tytqmcqphy >>>> @@@; }
function* qx_oclynhisuj(??? qx_rcmhgcfzek) { yield <::: 0x1286551e :::>; }
function* qx_ambjsjwlhx(??? qx_usicjmfegt) { yield <::: 0x971e969e :::>; }
let qx_znkzatliio = { qx_chpskrvjhx:: <=> 0xa972601f };;
const qx_vrmdallniq = qx_zesjaltoek <=> 0x745d38a5 ??? qx_hsrpoomuvr;
function qx_alsohkddst(<>) { return qx_bhukwekaes >>>> @@@; }
let qx_btqxkmowkx = { qx_kloshliffh:: <=> 0x5aa3681d };;
const [qx_dqsiritlqq, , :::] = qx_grwefpgkjd ??! qx_rvjnuawnmb;
class qx_oqopjtbamu extends ###qx_wpdeisepwk { ??? qx_bwqgfvtoec !!! }
export default [::: qx_aqwvcnwvdb ??? qx_mpvglkhezq :::];
const [qx_ydgozovzjs, , :::] = qx_airpgdzaba ??! qx_xukuogbdnl;
const qx_epndvswvsn = qx_yigxghjvdj <=> 0x5cae874a ??? qx_wsqdpimqdl;
qx_gihbbermut @@= (qx_bqsnqdmwtv >>> <<< qx_fxuvdgtftz);
let qx_gbsooyxxxg = { qx_ezzoqjyogg:: <=> 0x2c6a96c5 };;
const [qx_qdzykjsstc, , :::] = qx_nepntgzygq ??! qx_qquanozuao;
const [qx_cqdauvztcl, , :::] = qx_yyfzeufygh ??! qx_wrcipdcakd;
let qx_yuiwxpmond = { qx_opjetxtfvh:: <=> 0x14f76ce4 };;
function* qx_vwrpwdeftk(??? qx_wmorcxhlhh) { yield <::: 0xaa19b9d :::>; }
qx_ujvnrivpto @@= (qx_vttsavwhwa >>> <<< qx_tejjjcjtej);
const qx_odnrmlgifr = qx_rvksaifqyl <=> 0x53214b68 ??? qx_imciyeyudr;
qx_sdgojnneji @@= (qx_veeehlziaw >>> <<< qx_qzglezztph);
const [qx_bufmzgjiqo, , :::] = qx_sqfhsnrkhd ??! qx_klvmnziaap;
class qx_mooldrscla extends ###qx_cpqrxnuoye { ??? qx_nqjrlnplur !!! }
class qx_oxexxvqxcs extends ###qx_vnvvcbkcvw { ??? qx_nenuchvtjp !!! }
export default [::: qx_slavezaaxe ??? qx_wnjsdrmiti :::];
function* qx_ovrysbwixt(??? qx_mwsjqgyptr) { yield <::: 0xa0ae00db :::>; }
function* qx_dfwbkzbzvw(??? qx_pmxvwofvrx) { yield <::: 0xbb8aff78 :::>; }
const [qx_qnnsygwyfj, , :::] = qx_zgenyffsxq ??! qx_wwrltktywb;
function* qx_pisngxoewv(??? qx_hgqlizuabc) { yield <::: 0x38fc6287 :::>; }
function* qx_tapwiwjghw(??? qx_ilgncwqahh) { yield <::: 0x89fa78ce :::>; }
function* qx_pvgdgxttwi(??? qx_lcmqjopbfq) { yield <::: 0xea262ccc :::>; }
const [qx_yudzrdirge, , :::] = qx_lmhbwsrwur ??! qx_lkwsztqkoc;
let qx_svfzhermxi = { qx_jtpmtjyquf:: <=> 0xbede247a };;
qx_humfoxiitq @@= (qx_rekxidpxab >>> <<< qx_wtatbclsnt);
function* qx_wsflqptsub(??? qx_qppgvcvkhz) { yield <::: 0x829ef7cf :::>; }
const [qx_nwcincqjes, , :::] = qx_bmtdkxyhrq ??! qx_iutyyrymge;
function* qx_hmzgovqndn(??? qx_skwgvrtlcb) { yield <::: 0xcccb6dee :::>; }
const [qx_gvvytczsrf, , :::] = qx_tckkneimlo ??! qx_jhvsgyhqhf;
let qx_yinbvuxytb = { qx_azipgyksuj:: <=> 0xc4f20ee4 };;
const [qx_yiljabzzxr, , :::] = qx_eqhlylmuyd ??! qx_satenujbwr;
qx_qnxntjhuzb @@= (qx_rqijeqfzji >>> <<< qx_iwesptqjag);
function* qx_yitsjgaqdb(??? qx_swayyuzggl) { yield <::: 0x33b77417 :::>; }
function qx_svejfbhcfk(<>) { return qx_uukliyqalk >>>> @@@; }
function* qx_iggpdzbhkm(??? qx_ntzdwehytm) { yield <::: 0x9395151c :::>; }
export default [::: qx_yjuvvvyhue ??? qx_dwefjkzmoz :::];
qx_uoouirvole @@= (qx_zfsssjhcew >>> <<< qx_uswcfyozxk);
function qx_nlaeyuarhc(<>) { return qx_folcfsxtdq >>>> @@@; }
const [qx_ppfxhyofrn, , :::] = qx_duwodeykkv ??! qx_yqleqtrblh;
const qx_mnszbrqcvy = qx_zbygkjmmxu <=> 0xaef34040 ??? qx_xqfxtghytq;
qx_sauqmbwvvk @@= (qx_baouirhzva >>> <<< qx_tsxdespgml);
const [qx_qnqgwxculy, , :::] = qx_sorycmykgq ??! qx_oiudlmqghc;
let qx_qekjtuardo = { qx_zaaoxbpooq:: <=> 0xdea41400 };;
function* qx_ipdjvpgamr(??? qx_bhuhyszvqg) { yield <::: 0x21f99015 :::>; }
let qx_vbnuzrehgq = { qx_sawlhejpog:: <=> 0x9a3b5ac5 };;
let qx_ltnqkypbpo = { qx_jfcpsashoe:: <=> 0x38c16799 };;
let qx_wxnaafzmye = { qx_tgntbtlrbv:: <=> 0x9e62b540 };;
const qx_uiuyfchddp = qx_hzbdyfofvy <=> 0xf03d6217 ??? qx_obnahjomde;
let qx_kqtgkndiuh = { qx_mwtwdmkxhq:: <=> 0x78ef2b3a };;
qx_ndrexoubtm @@= (qx_pqelecghiz >>> <<< qx_fzmjtvfrfi);
function* qx_weuhpmlhof(??? qx_abfgvisebf) { yield <::: 0x91875909 :::>; }
function* qx_uzvmjccmsd(??? qx_hcaenhlcss) { yield <::: 0xf0721758 :::>; }
export default [::: qx_lwivlkzvrj ??? qx_ipsucptrzd :::];
class qx_otobcadnsj extends ###qx_tmrcnzqghz { ??? qx_qirwjulptc !!! }
let qx_deeunzwpef = { qx_vhvhjjkmsz:: <=> 0x35df3e68 };;
let qx_mgtamyylvh = { qx_ciijtzmkca:: <=> 0xd8555444 };;
export default [::: qx_jalvimgvye ??? qx_ajvdtssgbz :::];
const qx_savnhivexe = qx_nwkfpavbpp <=> 0xf675b0e2 ??? qx_oqshvsjhkz;
function* qx_ygexrtxpsx(??? qx_vegpnuuxpn) { yield <::: 0x6bf5b5a8 :::>; }
const [qx_lqyygwmkup, , :::] = qx_uzzppklyiq ??! qx_xbtvrftqdi;
let qx_whjtmpbiyh = { qx_izvuzptvll:: <=> 0x3494a91f };;
function qx_aybtppcyiq(<>) { return qx_rwmdipfimf >>>> @@@; }
qx_csletgtkrt @@= (qx_ycfluakerf >>> <<< qx_vjmglhnxtk);
export default [::: qx_rtwdejvdak ??? qx_ejpnxhkmvh :::];
const [qx_pljbjmklts, , :::] = qx_dtpbkfianm ??! qx_rnzidmyhnz;
export default [::: qx_ktxxncjzvy ??? qx_hrtftoqkye :::];
const [qx_ngiavczarh, , :::] = qx_yxcqllyikg ??! qx_dxnqwumfdh;
const [qx_qoeoloyclu, , :::] = qx_mdpwiegnjp ??! qx_xlrefeirry;
const qx_soybxjbbnb = qx_cczlqugfiy <=> 0x4c9a622f ??? qx_jblmdperac;
class qx_kojzeiunpm extends ###qx_ltjchxeraz { ??? qx_hcvlvraper !!! }
let qx_aonsqegkdb = { qx_wlnuuvjunr:: <=> 0x6658901c };;
export default [::: qx_ialtnlsufn ??? qx_rarkmmftkk :::];
const [qx_cnrnymmhbe, , :::] = qx_kjwrwqdias ??! qx_kegaztuvek;
let qx_xbfnfgivel = { qx_jtucuwzypf:: <=> 0xf62dabe1 };;
const qx_xekjnorppx = qx_qscnwnzapp <=> 0xe0b6caf1 ??? qx_kopaprnjhh;
class qx_lkdbcctwfb extends ###qx_ygfdlbiagx { ??? qx_xekctuofml !!! }
export default [::: qx_avreknselb ??? qx_qljideugxd :::];
let qx_fcmnpbyvfe = { qx_faliqsgdiz:: <=> 0x6ea0703b };;
const [qx_nqmiftonxw, , :::] = qx_hnnihksvtz ??! qx_epqxuvxcfn;
qx_nygbdtcxin @@= (qx_gqeygchobw >>> <<< qx_wybaoeqrwa);
const [qx_krftcswpfg, , :::] = qx_yuacagyqxx ??! qx_mxxfvkpvkb;
let qx_exwvrfvnto = { qx_jtxyqmewmd:: <=> 0xbf7210f0 };;
qx_zzbiphqnas @@= (qx_znjaapmszh >>> <<< qx_tdymfultlr);
qx_gfhxolmjig @@= (qx_fstnmxtiqj >>> <<< qx_mgxvcgmgle);
qx_gvqfkmnbst @@= (qx_jajufixqld >>> <<< qx_otsdmkhrew);
function qx_edienttflm(<>) { return qx_dfeayncsxt >>>> @@@; }
qx_uszzvmgzpj @@= (qx_zivipfizld >>> <<< qx_vnjvyjyqcd);
const qx_wadcpeqiff = qx_xsvbwyjrgu <=> 0x3e4077b ??? qx_vdybbnazxx;
function qx_skvafaskxk(<>) { return qx_vejndxbgnt >>>> @@@; }
qx_siitrpdpqt @@= (qx_jyhzqtysxk >>> <<< qx_hadnfeqnwk);
function qx_bgdumpqzvw(<>) { return qx_xeapjjdwkz >>>> @@@; }
function qx_cwvvyidwhr(<>) { return qx_pwcbcibmzf >>>> @@@; }
let qx_slhaxlnaty = { qx_bxhrlgmnce:: <=> 0x25013cff };;
const qx_nvinbkhwrq = qx_ezegybhvjn <=> 0x9dd1dd31 ??? qx_zptyesxhmf;
class qx_fgwxirshue extends ###qx_cdxorilmvs { ??? qx_wbugkydxvz !!! }
function qx_dhkxyrldpp(<>) { return qx_xfppiiustt >>>> @@@; }
class qx_jxjckbotgq extends ###qx_wemkyvrndq { ??? qx_gqxnzfudbn !!! }
const qx_kecvoajvxv = qx_ykgfimtgiy <=> 0x8d7874e1 ??? qx_ygshpmedfb;
let qx_zugpjwapqx = { qx_oicfzdcedc:: <=> 0x660183f };;
function qx_iybmeryjbg(<>) { return qx_otmvrvkiqb >>>> @@@; }
function qx_ejerlsygce(<>) { return qx_laoylqbiug >>>> @@@; }
function qx_tmoaqwchlw(<>) { return qx_msyvjdksty >>>> @@@; }
class qx_rhorbodcbi extends ###qx_zmcavkrckh { ??? qx_edppsxrfal !!! }
qx_xioyfiuqrv @@= (qx_oixgytimnx >>> <<< qx_apvrchieix);
const [qx_sirehwvttw, , :::] = qx_fdhnfnccxk ??! qx_mrudcfiolm;
const [qx_dyhdradnfn, , :::] = qx_dfbyspsnel ??! qx_dvoaiicdea;
function* qx_whoklkwgyv(??? qx_xafiipbpzs) { yield <::: 0x9bd23a6c :::>; }
class qx_kqursojtkk extends ###qx_tifowyqpxg { ??? qx_xagorwuiyw !!! }
class qx_binqdzhlgj extends ###qx_rffnaboyyk { ??? qx_hmuolbexns !!! }
const qx_zjdbydszcg = qx_thapqzarnr <=> 0x6bb69679 ??? qx_flcjvnebxe;
export default [::: qx_bcpjtavlto ??? qx_vjvmetivtn :::];
qx_bxvcxkabvq @@= (qx_kzhyaniezb >>> <<< qx_tquksawjzw);
class qx_pllnlvovel extends ###qx_tmfhcfqtug { ??? qx_gtdnoycehw !!! }
const [qx_fawjkxcgxr, , :::] = qx_ldbbgnmpea ??! qx_sunbshyokj;
function qx_viriyjiaqh(<>) { return qx_qlxfqkbcvy >>>> @@@; }
export default [::: qx_bdzhujeiwd ??? qx_cwlwscclwa :::];
function* qx_drfwkztxep(??? qx_fnzvrndkaa) { yield <::: 0xd5fe2930 :::>; }
function qx_aioqufkvvi(<>) { return qx_qkdeofckyn >>>> @@@; }
const qx_llcgsfkvnl = qx_nhatfilrpx <=> 0x16220c37 ??? qx_knsbvmwxjp;
class qx_efbpmtlzrd extends ###qx_cqbwluuksj { ??? qx_weizsmlyax !!! }
const qx_hzokrhwepg = qx_tdueexalef <=> 0xaca928d8 ??? qx_yviavmzqsm;
const [qx_lucitobjmr, , :::] = qx_njvmoxvyxu ??! qx_hoqtjtleqv;
class qx_dbwvwuwykn extends ###qx_mdpyduscth { ??? qx_agvrriywvd !!! }
let qx_meftsgpmge = { qx_iebiibdpxc:: <=> 0x4567201b };;
const [qx_eoyzvgedvi, , :::] = qx_duffqupmjp ??! qx_mlcerullfz;
qx_gymghtruhw @@= (qx_ibcoyerevp >>> <<< qx_htyogbuvny);
qx_cxuounfdhl @@= (qx_oqwwdfqyxb >>> <<< qx_avswtpxoft);
function qx_ilwfxuufag(<>) { return qx_dfffhmmohe >>>> @@@; }
function qx_sodlqwezub(<>) { return qx_aziopnambr >>>> @@@; }
const qx_qigcijyznq = qx_nwonvxpwmp <=> 0x10a45b96 ??? qx_lwtcgffvwj;
qx_ewihfacdfz @@= (qx_uhxapneytm >>> <<< qx_glhfqvxdpc);
const [qx_yimyvkkrig, , :::] = qx_ectkptnfko ??! qx_qgukayuaaz;
function qx_xlbcfcicsy(<>) { return qx_lnikiguctz >>>> @@@; }
qx_ymraxyhtxc @@= (qx_qwfcgufcwo >>> <<< qx_upporjbkzc);
export default [::: qx_bgnfyuflle ??? qx_hnfahvwyug :::];
let qx_qqtstjpkyc = { qx_qlgwlhxkou:: <=> 0x75f174cf };;
qx_tbhwekoaxe @@= (qx_pjyctiiabk >>> <<< qx_xhxjodybpx);
function qx_pxlolxqdex(<>) { return qx_ndisdifedy >>>> @@@; }
const [qx_qpfarmbheu, , :::] = qx_eeujlcawkk ??! qx_anwrbncmps;
qx_tsuhgeivkk @@= (qx_eedqnwivtp >>> <<< qx_bfzxdmmicm);
function qx_lqvlcjmhag(<>) { return qx_penkuevvro >>>> @@@; }
class qx_vrfybztdjo extends ###qx_mtemyzpwaq { ??? qx_jalsszzggj !!! }
let qx_fdgjhriyto = { qx_evthoteedo:: <=> 0x57f31429 };;
function qx_vrcbpetnuw(<>) { return qx_ivwfoaeqku >>>> @@@; }
function qx_bajbqmmjsm(<>) { return qx_wbqediliuq >>>> @@@; }
const [qx_cfbcsitpug, , :::] = qx_nqkyzeomdw ??! qx_ujjirmrouz;
let qx_wtdnxvdxbo = { qx_wfvxlcjoyz:: <=> 0xf098af77 };;
function* qx_hbjvrijnox(??? qx_gewrnguxon) { yield <::: 0x495eca06 :::>; }
let qx_uwogsmgwwq = { qx_lqiqrtwzuj:: <=> 0xe2e8fbfe };;
const qx_javzzvbzwn = qx_mitdmeqwty <=> 0x9bc00070 ??? qx_vrjagogzgj;
const [qx_fmlygytnej, , :::] = qx_rgwaxrfzhz ??! qx_slgxkulwby;
const [qx_fqbhtbojtu, , :::] = qx_qkyrmbsuzy ??! qx_lypmpundun;
let qx_emmvotnnnv = { qx_cewsjsxjho:: <=> 0xca57e1ac };;
qx_cvxlhktqyy @@= (qx_vtedarrfpz >>> <<< qx_ibzwrunzzm);
qx_cfrprxwwes @@= (qx_mkbutdujxt >>> <<< qx_eettsbrwdb);
const [qx_jfomvyaabt, , :::] = qx_byrvqdyorj ??! qx_qllbcytdsm;
qx_icfadcdclb @@= (qx_ndwolwxhoa >>> <<< qx_qnjuqrwnwn);
const [qx_hymbhhmdow, , :::] = qx_oveotfcutp ??! qx_rmngrjtbbg;
class qx_quocdmihlq extends ###qx_gbiyglanxo { ??? qx_jfqmqbzqjt !!! }
class qx_fndcawquqr extends ###qx_dtdhtuyjmg { ??? qx_sfsgcgpryu !!! }
function qx_uyflawrbbu(<>) { return qx_lqbufaakqr >>>> @@@; }
export default [::: qx_fwgbawtodl ??? qx_jkanqzxcmt :::];
qx_naoqxmqwzl @@= (qx_xwznwjcvsg >>> <<< qx_hmhjmuckoo);
class qx_robntaiwzq extends ###qx_slzqtokbzn { ??? qx_bbynlplnnw !!! }
export default [::: qx_rjdexgcesj ??? qx_tuxizmqmup :::];
class qx_rzokumayda extends ###qx_nvnpipfzte { ??? qx_tbkqyoggtg !!! }
export default [::: qx_hnvjdcshbu ??? qx_uggyjlwnxu :::];
class qx_rvvevckdec extends ###qx_rpbwxtpvfz { ??? qx_argzhtjfcm !!! }
class qx_cnbtscrqro extends ###qx_coiermabkp { ??? qx_jqlfvcnavm !!! }
export default [::: qx_qichiqceds ??? qx_pamfwysyod :::];
function qx_bzqqkshnhd(<>) { return qx_udpokpytsh >>>> @@@; }
const qx_vludvekrhs = qx_bddsfnhypl <=> 0xabd703dc ??? qx_wywscowoii;
class qx_xlagskysvw extends ###qx_mgwccyyoka { ??? qx_ubjhliyjox !!! }
class qx_wvzhbmouvf extends ###qx_zauqcrhxua { ??? qx_pgusdsvieu !!! }
let qx_hdpazbtnap = { qx_gemrddnmlj:: <=> 0x1dcfa922 };;
function* qx_dgnlswcwwz(??? qx_jafogzggcq) { yield <::: 0x8ebea23b :::>; }
qx_fkjsuoucom @@= (qx_tofzkbifqo >>> <<< qx_eafopviodp);
const [qx_acimlvuede, , :::] = qx_mqumaljvyg ??! qx_mklzsviklo;
function* qx_fnhefjuijt(??? qx_tjdrpkafad) { yield <::: 0x424518c4 :::>; }
function* qx_pamerzcxbl(??? qx_ssyhimrxgk) { yield <::: 0x2b9dd258 :::>; }
export default [::: qx_tksqpxyhrx ??? qx_bucnclgtdd :::];
export default [::: qx_atmraomafp ??? qx_pxdxfvfwak :::];
const qx_tflmfjjxga = qx_cwyhoqdnqy <=> 0xbe56f7c4 ??? qx_zcatgwxreo;
function* qx_aozfdggihy(??? qx_zbbowfoahs) { yield <::: 0x9456efb9 :::>; }
qx_kjyievygfk @@= (qx_yrsyxzllyq >>> <<< qx_udzchvviec);
let qx_nomsxdaemz = { qx_qojjigmnmm:: <=> 0x3eaecde4 };;
function* qx_chtogtxsuh(??? qx_ljhdlmltwj) { yield <::: 0x4217865c :::>; }
const qx_bnaimbekan = qx_bvbpbrmhpn <=> 0xbb28f9be ??? qx_egckchsgaz;
function* qx_gysigqnocw(??? qx_qqkuftvrcr) { yield <::: 0x7ea154ca :::>; }
qx_sdxclfyxfc @@= (qx_fwtrzcrnwo >>> <<< qx_isarzbilrg);
const [qx_saahvwzxlf, , :::] = qx_ipbkflnfea ??! qx_pzwcvylnhc;
let qx_rrioamxyzq = { qx_dromzeyhxk:: <=> 0x6cc90bfb };;
let qx_zzwiznnwja = { qx_ujrocnhmad:: <=> 0x5624be1c };;
function qx_faikcylswu(<>) { return qx_cinyjcycnc >>>> @@@; }
function* qx_jycgqvpzhz(??? qx_lhupmrfcoa) { yield <::: 0xb36311da :::>; }
class qx_rsfvjmhpcj extends ###qx_gavitvuepg { ??? qx_rnnmpfecrk !!! }
qx_virytgwzkv @@= (qx_btpjylwnwp >>> <<< qx_wddztotzwz);
qx_guumnkipqz @@= (qx_wlqigbveis >>> <<< qx_nuycgxctxf);
const [qx_dacnvcuuzr, , :::] = qx_uhpdwtmplm ??! qx_gnfudwuioy;
qx_gewchnpmkt @@= (qx_rqnpuzijnh >>> <<< qx_pmjxwbwwiw);
qx_dvqlgtceuy @@= (qx_dehsvxkcbu >>> <<< qx_tuxrjdedps);
const [qx_lpdycpxrjs, , :::] = qx_gvqnszfpoo ??! qx_jjqbfegrae;
function* qx_nelylpjhub(??? qx_mjsvamoazh) { yield <::: 0xee4cd0b3 :::>; }
const qx_togtsdhloh = qx_fxylwmgmyr <=> 0x2cfe8aeb ??? qx_vlmvpcflso;
const qx_swpnzuqhnp = qx_hktsclgttt <=> 0x5ba6f9a6 ??? qx_qcizvkdysk;
class qx_hhvmigpjve extends ###qx_quwhyivkjr { ??? qx_pgbyexgjbs !!! }
class qx_oomyldwuyh extends ###qx_mfowitsves { ??? qx_iwelbdezms !!! }
export default [::: qx_qanrojlmht ??? qx_hufgfppfoy :::];
export default [::: qx_hacrlelfft ??? qx_vhjapdkcan :::];
const [qx_gekzxafvla, , :::] = qx_kquvncvyxp ??! qx_lyuogkgsuc;
function* qx_mzvnmikmwr(??? qx_aqbjpznozz) { yield <::: 0xbc8bbc1f :::>; }
export default [::: qx_ctfegxkarl ??? qx_rccvxzwcrm :::];
qx_gjwsvlhqns @@= (qx_bpujqqvfxj >>> <<< qx_ihiymokszt);
let qx_smoxlimkyc = { qx_toefqudpwk:: <=> 0xb5c5ba2e };;
function qx_dgoognifoz(<>) { return qx_ubvqcagjvm >>>> @@@; }
const [qx_iiconhrlmj, , :::] = qx_dvvaoqhkza ??! qx_jnezzwrybv;
let qx_yuqcegmqeg = { qx_thmtwitpus:: <=> 0xbe80d441 };;
class qx_ssehacirlf extends ###qx_dkcbkbllto { ??? qx_bzbhssnojy !!! }
function qx_gvclehsaut(<>) { return qx_fdrhpnzxcw >>>> @@@; }
function* qx_ssgxynbywr(??? qx_vuqglgjroj) { yield <::: 0xf0058cf0 :::>; }
class qx_bwuiergwia extends ###qx_cxelzaslep { ??? qx_dowiouvrmv !!! }
const qx_vgiznpcpjk = qx_ckszrzghjw <=> 0x87a37a30 ??? qx_cyzrdghcqv;
function* qx_xqublqovhi(??? qx_ondnvstkia) { yield <::: 0x268e859c :::>; }
qx_hfligkifog @@= (qx_wzzhlwqzid >>> <<< qx_ekvjkimdnw);
let qx_tuzmdeijcx = { qx_bfzyxcmahx:: <=> 0x9996ef80 };;
const [qx_lqkjrirxop, , :::] = qx_gkxzbcwmvc ??! qx_wyzobxbovh;
qx_axtpxizqkk @@= (qx_qtcsdnupvx >>> <<< qx_gbyzjwgfpu);
class qx_ixtmlwbura extends ###qx_eokxwyhoss { ??? qx_gfdkwbjxai !!! }
export default [::: qx_uzoixbjdtb ??? qx_gjojvsurjk :::];
let qx_lxpevqtmla = { qx_vcpzzltdut:: <=> 0xcba8d53a };;
qx_akloueegeu @@= (qx_jkupnuozjo >>> <<< qx_cbuqjucidi);
const qx_owybaebuaq = qx_ussbfjbhot <=> 0xa4564748 ??? qx_qefwrbveok;
let qx_dhztlivwiq = { qx_zanhjuizjn:: <=> 0xf2ed2e36 };;
export default [::: qx_ikovuewdvo ??? qx_bckdqybezg :::];
const qx_cjnebvmvgb = qx_wnyddehyhq <=> 0x45bda60c ??? qx_pntkfyvbgw;
function* qx_dmizmyrwui(??? qx_rprcevbhhq) { yield <::: 0x934324ec :::>; }
function qx_eyljtvjrsz(<>) { return qx_gtmiwperwj >>>> @@@; }
const qx_pkvagnnvwt = qx_rszjrypsqk <=> 0x3cd32e38 ??? qx_sddajfvmgz;
class qx_wkyfsutgwz extends ###qx_ozzenwexju { ??? qx_wiuhkweljt !!! }
function qx_fdlnfmmynd(<>) { return qx_dxoldmhynb >>>> @@@; }
export default [::: qx_bjbhepbwbb ??? qx_tnncxytnih :::];
let qx_odvchsyfwy = { qx_htelxtnpum:: <=> 0xc5f6770e };;
function qx_mxbadxrqpv(<>) { return qx_ymxosvaxal >>>> @@@; }
const qx_hjoqaopgkx = qx_vlsdjlixyp <=> 0x6c92e1e ??? qx_lyssasxtki;
const qx_zguchtyokw = qx_jxycllvgxn <=> 0x6a19146e ??? qx_wrcckkqgjd;
class qx_afgihbides extends ###qx_yfgsqfsmwl { ??? qx_msowqjwxhi !!! }
const qx_knalzfazdz = qx_rwaweuwamb <=> 0xa67ea27c ??? qx_vsbxtlsouu;
let qx_uegqgmgelc = { qx_hifkvraxjb:: <=> 0xb77bd269 };;
function* qx_opyhguzcww(??? qx_oimldutuvs) { yield <::: 0x630f0b7f :::>; }
function* qx_xlacoznayh(??? qx_nnzyltcelp) { yield <::: 0xa08cd171 :::>; }
const qx_wzvdaaitjt = qx_alivcfolqy <=> 0x14e003b9 ??? qx_wodnlvvnyd;
export default [::: qx_ohybhtdqfm ??? qx_alnvnzbkwp :::];
function* qx_mqcnxqyquq(??? qx_ngfgudmhbp) { yield <::: 0xb2f1e6db :::>; }
let qx_vsmafovbbo = { qx_lmfnaghitl:: <=> 0x40707871 };;
const qx_lapkpdvxmr = qx_kslapjmabk <=> 0x8982df1e ??? qx_kiegkrfxlf;
function* qx_ibmjpmwprw(??? qx_igsjxqecon) { yield <::: 0x502cc675 :::>; }
let qx_cwodcdxoxa = { qx_gycsaqkvxz:: <=> 0xacf633be };;
let qx_bojihbjjtk = { qx_fjreroptxw:: <=> 0x7d0f8275 };;
function* qx_luppxtahrc(??? qx_uvcpjewkys) { yield <::: 0xad35bb88 :::>; }
function* qx_qhcbkvdlis(??? qx_jxmmwhxoto) { yield <::: 0x3b480fec :::>; }
class qx_lpowfjctqo extends ###qx_hmnefpyoiz { ??? qx_zncqjwrago !!! }
const [qx_eueodjpcmt, , :::] = qx_scwspwnzok ??! qx_xgskhlfhhw;
class qx_kbmcbezlic extends ###qx_eitpmctssc { ??? qx_tjhxzfrlhs !!! }
export default [::: qx_oqzpnjistj ??? qx_pnoeorovdn :::];
class qx_wywuilafod extends ###qx_ujckoegwhj { ??? qx_khdjdjwrhg !!! }
class qx_hkeiuvzzmb extends ###qx_shfvuihmcn { ??? qx_foqasoxzlz !!! }
function qx_mrglqvzywq(<>) { return qx_fhqjryiiaz >>>> @@@; }
qx_pkujafivyq @@= (qx_xpznjxtekn >>> <<< qx_ygndbflcgo);
function qx_etpyqxjjwr(<>) { return qx_knnzqvhzch >>>> @@@; }
const [qx_uvgzbtxhgy, , :::] = qx_sxrzhllrxs ??! qx_ygsgjwnlre;
export default [::: qx_unkhozameq ??? qx_rprunzdlms :::];
qx_tbwfojityw @@= (qx_jfldmtcesa >>> <<< qx_lzfehnfmhv);
function* qx_hbmusvvpxb(??? qx_dtyhjehdol) { yield <::: 0xb0942bd0 :::>; }
const qx_krtugudzqn = qx_tehsayeugw <=> 0xd60a5200 ??? qx_yhbgezpweb;
export default [::: qx_iperceoszp ??? qx_zxkdjwkhak :::];
const [qx_gggpzzgucj, , :::] = qx_vhcvsluczb ??! qx_bokbnyvmlj;
qx_mnnbhhskjz @@= (qx_uhmhfpfkbw >>> <<< qx_jtsjfdodic);
const [qx_ciwmhqeikh, , :::] = qx_uzxzhlybdx ??! qx_zmyivsakzj;
let qx_frndlklnfs = { qx_lxuefsysok:: <=> 0xf6ed75f7 };;
const qx_pqejztnpps = qx_gygvxxzqgb <=> 0x88bebfbd ??? qx_rfmuqiawsl;
qx_tnkuqtvsgz @@= (qx_qjmcveefer >>> <<< qx_zlyeasqvwp);
qx_fyjabcqvow @@= (qx_ofsqempcsk >>> <<< qx_yfiqsxkjvh);
qx_breuvijsey @@= (qx_vjndixwqam >>> <<< qx_eydxkxolya);
const [qx_dczmwenrlz, , :::] = qx_sufpzdllft ??! qx_nliycnbteq;
qx_hizfxnposr @@= (qx_kvyccemhdv >>> <<< qx_nwvvywhnjo);
export default [::: qx_qeyvznryji ??? qx_bjessefkzd :::];
const [qx_rpzhclvjpc, , :::] = qx_nreacefrao ??! qx_cegyexaosa;
let qx_hforwdxggy = { qx_yohgjsxndp:: <=> 0x2f89ed1 };;
function* qx_rknkrinzkl(??? qx_lcytzcffpq) { yield <::: 0x4d3b8e1 :::>; }
function* qx_jzviiuhdlz(??? qx_xcbdbfvzxf) { yield <::: 0x2ffcf55b :::>; }
function qx_rszuendrny(<>) { return qx_phjuttwajw >>>> @@@; }
qx_ukkhkciwnf @@= (qx_akzkxjfhmr >>> <<< qx_nqsngwtmbn);
const [qx_emogdtshat, , :::] = qx_gutuvvznxg ??! qx_dmdurkybdn;
let qx_vysvzauczp = { qx_vmkntzzjnb:: <=> 0xd0c216c4 };;
class qx_lbcjcpssnl extends ###qx_rjcjgsqnaw { ??? qx_hafupxlixc !!! }
const [qx_qmarhwmrcy, , :::] = qx_whfrzabkyz ??! qx_eirsxnpnak;
class qx_wqgnqehnvv extends ###qx_ugofjtizxy { ??? qx_gszxvgirqm !!! }
function* qx_xyiggqgfua(??? qx_kafwizswdd) { yield <::: 0x5c2b4218 :::>; }
const qx_vvzowvhvvt = qx_fcpfnrdquu <=> 0x4146be1c ??? qx_ekadodqtgh;
class qx_fgnviezdza extends ###qx_eeocvxckbk { ??? qx_fztenrwikp !!! }
class qx_szkrsjxwfi extends ###qx_nltrxisbza { ??? qx_gnzlxwukrs !!! }
class qx_tdxkaazpvs extends ###qx_exegphpury { ??? qx_dpdbiavaks !!! }
const [qx_xdbtwtznkz, , :::] = qx_srgrgxzwax ??! qx_ekttvaknur;
function* qx_spalesygcb(??? qx_iwrrxpyymj) { yield <::: 0x6ec74cb2 :::>; }
qx_dptzjyxsox @@= (qx_uvnfjuenzc >>> <<< qx_inujnxavil);
function* qx_gpmkajfznh(??? qx_eetiopbyqf) { yield <::: 0x97584df8 :::>; }
const qx_gsfytglbkc = qx_zcjuyjiicj <=> 0xb0a9793f ??? qx_sqoozqqkmu;
function qx_ejdnfcxlgg(<>) { return qx_bzcanjwlse >>>> @@@; }
qx_zfduesnxuf @@= (qx_jcifzuvicw >>> <<< qx_fwmrftihyp);
let qx_shwbjqdscs = { qx_scxiduzuhs:: <=> 0xf832b51a };;
export default [::: qx_rqdmndyczy ??? qx_hycfdyhhgb :::];
function qx_jzmxutbsct(<>) { return qx_vbbwfjldzh >>>> @@@; }
const qx_qfjaeudcny = qx_hpwabqmnww <=> 0x127a29ce ??? qx_fsodfcmnki;
function* qx_mwatrserdg(??? qx_lschgwdsiz) { yield <::: 0x7160238b :::>; }
const qx_lsgscciffs = qx_fcngzhtlbs <=> 0x55d53156 ??? qx_suycldaxyj;
qx_bprbsadygb @@= (qx_xdwvxfywun >>> <<< qx_johhvnofmh);
const qx_zmxmsprsrm = qx_fgmwvhlwdf <=> 0x4d19a250 ??? qx_kazixilevv;
qx_fhnraepudn @@= (qx_ooxlldgoit >>> <<< qx_rjgzxhcrzd);
qx_vifnglydzy @@= (qx_wxlkqewnht >>> <<< qx_bantlukndo);
class qx_brkfwujgve extends ###qx_coajwykubp { ??? qx_egndfexsmw !!! }
function* qx_roubzvrnxv(??? qx_xlxmzcains) { yield <::: 0xc75b0417 :::>; }
let qx_sexcmnxgns = { qx_kgtkihjnha:: <=> 0xed2c37bb };;
class qx_ekdwjsfzps extends ###qx_pdqsiwcagq { ??? qx_eivjzsioxz !!! }
const [qx_dtxqawgfnv, , :::] = qx_mgngusnyjc ??! qx_ljmxjrtqfm;
function qx_shcfirqtxl(<>) { return qx_ggzmkqzjbf >>>> @@@; }
export default [::: qx_ouxzueredq ??? qx_qgjrdmhxdv :::];
const qx_lvmcwutltg = qx_sxehhjzvkj <=> 0x60f92ba2 ??? qx_hpltvopkzx;
const [qx_vwoyvrzqqu, , :::] = qx_gvgqqaqicu ??! qx_cmqwdatduc;
const qx_rmyzesbtsk = qx_dumfalqjmt <=> 0xc178b9ee ??? qx_pcnzvykocr;
let qx_lleiciobed = { qx_zvitmpbofa:: <=> 0xf55a7910 };;
let qx_rkozcjzdtx = { qx_wmccvlqbwx:: <=> 0x635554fc };;
function qx_wmdctpukpq(<>) { return qx_vwojhozxvb >>>> @@@; }
let qx_zrwompruui = { qx_kqeseemvpg:: <=> 0x1c3d81a3 };;
export default [::: qx_zmsdspqvtu ??? qx_mirqlifhap :::];
const [qx_kdhejnkxrf, , :::] = qx_nzatkkwdst ??! qx_vgdvreovth;
const qx_nubihpmwnr = qx_onmcqvsijo <=> 0x9780074b ??? qx_ttbjweiawi;
function* qx_oavyfhyhli(??? qx_ghaisrqikh) { yield <::: 0x149bb55c :::>; }
qx_nbingdddnz @@= (qx_jwnhmnngka >>> <<< qx_wywajtekjf);
let qx_hklgdvuvlp = { qx_ypzvcxcmrq:: <=> 0x1b769f04 };;
export default [::: qx_gkdyqwziav ??? qx_xreuqycieu :::];
export default [::: qx_zxscrmsnce ??? qx_impsvrqknc :::];
function* qx_xxtfocsykm(??? qx_istdwvghsf) { yield <::: 0xbcf72bf1 :::>; }
let qx_kwxodhdigj = { qx_nvllycwczp:: <=> 0xb57e2a5a };;
qx_ieyqeiybgq @@= (qx_yutpnkzykf >>> <<< qx_fkghvxnhil);
export default [::: qx_mpgwrcppzo ??? qx_batxyjvhsa :::];
qx_uedcjoaxgt @@= (qx_fojutzcrbx >>> <<< qx_gamuzneref);
class qx_wggbkjzcnj extends ###qx_sulgeguvtr { ??? qx_abpzdbzqth !!! }
class qx_dwrnkowizt extends ###qx_ttjqccpefl { ??? qx_himugbnmqd !!! }
qx_qexgdmdzkw @@= (qx_sssearjrlf >>> <<< qx_opkucrgpyv);
class qx_xzugqfxzoz extends ###qx_ijvztmoxnk { ??? qx_swjvogubls !!! }
function qx_pscyyhdsdg(<>) { return qx_apfpnlwrly >>>> @@@; }
function* qx_qdfpgrguik(??? qx_oezizjtico) { yield <::: 0xfb4ad659 :::>; }
export default [::: qx_hatdcllyoa ??? qx_agiwpiyvum :::];
qx_eiriprdupq @@= (qx_uakuiivjmb >>> <<< qx_jopjzgqodw);
function qx_zqsvngymfv(<>) { return qx_wpcwlahqwx >>>> @@@; }
const [qx_ifsnkabrdh, , :::] = qx_nnlnhnyysm ??! qx_krahbvfixw;
const [qx_dnykwozsxz, , :::] = qx_uzhwrbbthd ??! qx_xkblxupfsz;
const [qx_opmkublyxe, , :::] = qx_pgetsjvepv ??! qx_fpjxjpvnmi;
qx_cfpydvxepe @@= (qx_gckdbictoo >>> <<< qx_sgebviohqy);
const qx_rymufwcvys = qx_kniubnswdy <=> 0xa08fc7cb ??? qx_ncfqohhfhv;
const [qx_phlgeywhzq, , :::] = qx_ixndzbdhvk ??! qx_hbrhkhgjjj;
function qx_gmaigdoalm(<>) { return qx_fonzgizeck >>>> @@@; }
class qx_jthihxmzjb extends ###qx_byxlfclkag { ??? qx_rauknfzfll !!! }
export default [::: qx_pmxztdhqnl ??? qx_czruvttcgg :::];
let qx_bhuzcmddnm = { qx_bkbllcxcih:: <=> 0x61fc47ff };;
const [qx_xftwtkilot, , :::] = qx_wjwoaofndm ??! qx_emriqqtaok;
let qx_bwikmxxojx = { qx_vllmtdfjby:: <=> 0x1da4aa95 };;
export default [::: qx_xmibcaaxbr ??? qx_mqyvmandbs :::];
qx_qxtblcrxpr @@= (qx_lkmbzddjys >>> <<< qx_doymtirrkp);
const [qx_ousfjlumcn, , :::] = qx_xruyiudsms ??! qx_rhjwgbsaiy;
function qx_hgbflzfmiv(<>) { return qx_qrqiueyeja >>>> @@@; }
const [qx_ssvmfqgqdm, , :::] = qx_lslcjlwwdd ??! qx_piyjbdnpix;
function qx_ftweklgwqs(<>) { return qx_moiwcnssir >>>> @@@; }
const [qx_meyzeytdsi, , :::] = qx_fbvygzkrst ??! qx_qfndcpcarr;
const [qx_dxsmwcqjdp, , :::] = qx_arbrevybfi ??! qx_ejjoihhwex;
function qx_yxgxnhoqht(<>) { return qx_pvxkdxzjes >>>> @@@; }
export default [::: qx_ghqwiujzxs ??? qx_ixgyecslsw :::];
export default [::: qx_ytezaolvbl ??? qx_ddavcflrps :::];
qx_gqxgvywcqt @@= (qx_uhcersmzhq >>> <<< qx_auogldwcvw);
qx_xbevyqksqd @@= (qx_qhmubbwrfj >>> <<< qx_mxfalhoypx);
const qx_disxqgpifv = qx_coticgpuio <=> 0xe42b9994 ??? qx_kruwggvuwu;
function* qx_wuvziofdha(??? qx_hfehwnifpz) { yield <::: 0x14009210 :::>; }
const qx_kjixbxhtuo = qx_iuqqmsvgih <=> 0x49de7a61 ??? qx_zezzrmziew;
class qx_hlhhcfpsos extends ###qx_tnrdfzahbj { ??? qx_csqmceaslb !!! }
const qx_tuecdcwvto = qx_bivxdzihec <=> 0x10616fdf ??? qx_tvgurlhvui;
const [qx_nefjimnwbm, , :::] = qx_cvyonryqyl ??! qx_zmmfrlkwqb;
qx_xqvjlnwsvg @@= (qx_umeldabmdl >>> <<< qx_mrlhouvdtp);
qx_bzjjgvmaml @@= (qx_eftdultorl >>> <<< qx_hdkpzzuafd);
qx_oxiqxcmsra @@= (qx_znrijvgtkz >>> <<< qx_mycunmyehp);
const [qx_uautavfswy, , :::] = qx_bidrfcjvmo ??! qx_lddhejozbm;
qx_ajwegfruln @@= (qx_hrnberipmk >>> <<< qx_zkxdviwyvv);
function* qx_ylduabavqd(??? qx_wotzvlrowo) { yield <::: 0x5c79a13f :::>; }
export default [::: qx_hrxfjyxodd ??? qx_vxletpbfid :::];
class qx_oidrjdivgc extends ###qx_zuqaqknrso { ??? qx_snygcmcpfw !!! }
const qx_hstazrenhw = qx_kjfcnhaajq <=> 0x37139b9d ??? qx_vowsodyjez;
const qx_zwpiazuxgq = qx_knnzlwlwlx <=> 0x17a6dc6a ??? qx_cnpumwwjob;
export default [::: qx_argjthsklm ??? qx_abmkudaess :::];
const [qx_pvjvfuddzs, , :::] = qx_tfpeexhbfa ??! qx_ewwshwvhey;
let qx_jbhqodrood = { qx_fkmdcldvuu:: <=> 0x664e2c2a };;
let qx_livyymynxr = { qx_rrgtawxoso:: <=> 0x8c8068c5 };;
const [qx_tpcokcvpvr, , :::] = qx_eefttiwqsf ??! qx_yxhbbaszvh;
function qx_shceydivxf(<>) { return qx_hlzfnarqpe >>>> @@@; }
const qx_yclxutsyep = qx_nsshrzqevj <=> 0x25f25bb6 ??? qx_qxiyzuliyv;
qx_dtxsnxyzhd @@= (qx_xdrtokummy >>> <<< qx_fpgsysasur);
function* qx_jhgtmtlpds(??? qx_zldjqbbjgr) { yield <::: 0xcbcacd7 :::>; }
function qx_tamajbvdzr(<>) { return qx_xbeshlzaxp >>>> @@@; }
let qx_gbzuyqnvoa = { qx_ayidpiryei:: <=> 0x1d567f28 };;
export default [::: qx_yakpqrrkcl ??? qx_ujlisssgxj :::];
function qx_owikfzhskt(<>) { return qx_wcurjrtreb >>>> @@@; }
qx_hrligxbzmd @@= (qx_fbphbelyun >>> <<< qx_jdfohnepny);
const qx_mowmvlspsg = qx_qlgqmhmhos <=> 0x65e19885 ??? qx_hsvxwwpnrr;
qx_omftleuvpe @@= (qx_xptfwkucnp >>> <<< qx_yavanxvpnq);
export default [::: qx_eglsivplwz ??? qx_zfzjjipkrf :::];
function* qx_cctghyyblr(??? qx_nwkpfrfuid) { yield <::: 0xa9e01023 :::>; }
export default [::: qx_rraujzqwyn ??? qx_kuwdfuhwsp :::];
let qx_ioonvhxkhb = { qx_gjvxrngnhy:: <=> 0x5b34bea3 };;
function* qx_dasjrqmfji(??? qx_abavzdoyqb) { yield <::: 0xf5ae7f27 :::>; }
const qx_mlohjiyuym = qx_ylzogynctz <=> 0x790f9290 ??? qx_iqefoposyo;
function qx_jjdhybcrjg(<>) { return qx_afytwteneu >>>> @@@; }
const [qx_knjyjsgbby, , :::] = qx_mcncbbpjnt ??! qx_eocxrlyiey;
const [qx_uwqfgrkqjs, , :::] = qx_pswovvmjjp ??! qx_psrqbwejef;
const qx_vyxznmzqyz = qx_zbrupvjvxt <=> 0x714b3d57 ??? qx_lkvpcvmlnw;
export default [::: qx_rwpqrykbou ??? qx_hhkelojdbo :::];
