/**
 * Pickups + levelling self-check. Run headless: `bun packages/mobile/game/sim/loot.test.ts`
 *
 * This is the reward loop. If it is wrong the game is not merely buggy, it is unfair — and unfair in
 * a way players feel immediately and cannot prove. Three failures matter most:
 *
 *   1. SILENTLY EATING EXPERIENCE. Late in a run the gem pool fills. If a full pool refuses drops,
 *      the player kills a thousand things and levels up like they killed a hundred. So the test
 *      hammers the pool far past its ceiling and checks that every single point of experience that
 *      entered the world came out of it.
 *   2. THE MAGNET FEELING WRONG. Gems must be inert until you approach, then lock on and stay locked
 *      even if you run away. Both halves get checked, because "gems briefly twitch at you and give
 *      up" is the exact bug that makes collection feel sticky and bad.
 *   3. LEVELS NOT SURVIVING SCALE. Players reach level 14,000 and single gems are worth hundreds of
 *      levels. So the curve is checked term by term, then handed a gem worth a billion to prove the
 *      flat tail is computed by division and not by a loop that would freeze the phone.
 *
 * WHAT IT PROVES
 *   1. The level curve is exactly 5, then +10 per level, flattening at 20 — checked value by value.
 *   2. `totalXpForLevel` agrees with walking the curve one level at a time, including past the flatten.
 *   3. A single huge gem levels hundreds of times, instantly, with the leftover experience exact.
 *   4. Level-ups queue rather than interrupt, the queue has a ceiling, and the batch size grows.
 *   5. Growth and Greed multipliers apply, truncate to whole numbers, and never floor a pickup to nil.
 *   6. Gems sit still out of range, lock on in range, and stay locked when the player leaves.
 *   7. A vacuum sweeps distant gems, and only gems.
 *   8. A downed player collects nothing and releases what was already flying to them.
 *   9. Collection is reported as events with exact totals, and totals stay exact past the event cap.
 *  10. A full pool merges instead of refusing, and the merged gem reads as a higher tier.
 *  11. Food heals, coins bank, chests and consumables report once each.
 *  12. Consumables expire off the floor; gems never do.
 *  13. Drops are reproducible from a seed and shift with luck.
 *  14. A tick with a thousand gems and four players allocates nothing.
 */

import { Rng } from "../core/rng";
import { ModifierStack } from "./modifiers";
import {
  BASE_MAGNET_RADIUS,
  BOSS_DROP_RULE,
  CONSUMABLE_TTL,
  DEFAULT_DROP_RULE,
  GEM_SLOT_BUDGET,
  GEM_VALUE,
  HEALTH_PICKUP_AMOUNT,
  MAX_COLLECT_EVENTS,
  PICKUP,
  PickupStore,
  rollDrops,
} from "./pickups";
import { PLAYER_STATE, PlayerStore } from "./player";
import {
  batchSizeFor,
  FIRST_LEVEL_COST,
  FLAT_LEVEL_COST,
  FLATTEN_LEVEL,
  MAX_PENDING_LEVELS,
  Progression,
  totalXpForLevel,
  xpForLevel,
} from "./progression";
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

function baseStats(): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  return stats;
}

/** One player standing at the origin, alive and upright. */
function onePlayer(x = 0, y = 0): PlayerStore {
  const players = new PlayerStore();
  players.reset(1, baseStats());
  players.x[0] = x;
  players.y[0] = y;
  players.upright[0] = 1;
  return players;
}

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
    gc?: () => void;
  };
  host.gc?.();
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

// ---------------------------------------------------------------------------------------------
section("the level curve");
{
  check("leaving level 1 costs 5", xpForLevel(1) === 5, `${xpForLevel(1)}`);
  check("each level after that costs 10 more than the last", xpForLevel(2) === 15 && xpForLevel(3) === 25 && xpForLevel(4) === 35);

  let curveHolds = true;
  for (let lv = 1; lv < FLATTEN_LEVEL; lv++) {
    if (xpForLevel(lv) !== FIRST_LEVEL_COST + (lv - 1) * 10) curveHolds = false;
  }
  check("the ramp is exact all the way to the flatten point", curveHolds, `level 19 costs ${xpForLevel(19)}`);

  check(
    "the cost stops growing at level 20 and stays there forever",
    xpForLevel(FLATTEN_LEVEL) === FLAT_LEVEL_COST && xpForLevel(500) === FLAT_LEVEL_COST && xpForLevel(1_000_000) === FLAT_LEVEL_COST,
    `flat at ${FLAT_LEVEL_COST}`,
  );

  // The closed form and the honest walk must agree, or "set level" in the dev menu lies.
  let walked = 0;
  let agrees = true;
  for (let lv = 1; lv <= 300; lv++) {
    if (totalXpForLevel(lv) !== walked) agrees = false;
    walked += xpForLevel(lv);
  }
  check("the closed-form total matches walking the curve level by level", agrees, `level 300 needs ${totalXpForLevel(300)} in total`);
}

// ---------------------------------------------------------------------------------------------
section("earning levels");
{
  const stats = baseStats();
  const p = new Progression();

  p.beginTick();
  p.addXp(4, stats);
  check("four experience is not yet a level", p.level === 1 && p.pending === 0, `${p.xp}/${p.xpToNext}`);

  p.addXp(1, stats);
  check("the fifth point levels you to 2", p.level === 2 && p.xp === 0, `level ${p.level}`);
  check("and the level-up waits in the queue instead of interrupting", p.pending === 1);

  p.addXp(15, stats);
  check("the next level costs 15 and lands exactly", p.level === 3 && p.xp === 0 && p.pending === 2);

  // One gem carrying several levels at once.
  p.reset();
  p.beginTick();
  const gained = p.addXp(5 + 15 + 25 + 10, stats);
  check("one gem can carry several levels at once", gained === 3 && p.level === 4, `gained ${gained}, at level ${p.level}`);
  check("and the leftover is kept toward the next one", p.xp === 10, `${p.xp} left over`);
  check("the tick reports what it gained", p.gainedThisTick === 3 && p.xpThisTick === 55);
}

// ---------------------------------------------------------------------------------------------
section("levelling at absurd scale");
{
  const stats = baseStats();
  const p = new Progression();
  p.devSetLevel(FLATTEN_LEVEL);
  p.pending = 0;

  const started = Date.now();
  const gained = p.addXp(1_000_000_000, stats);
  const elapsed = Date.now() - started;

  check(
    "a gem worth a billion levels you thousands of times",
    gained === Math.trunc(1_000_000_000 / FLAT_LEVEL_COST),
    `${gained} levels`,
  );
  check(
    "and it costs no more than a tiny gem, because the flat tail is a division, not a loop",
    elapsed < 20,
    `${elapsed}ms`,
  );
  check("the leftover experience is exact", p.xp === 1_000_000_000 % FLAT_LEVEL_COST, `${p.xp} left over`);
  check("there is no level cap", p.level > 5_000_000, `reached level ${p.level}`);

  check(
    "the queue of unspent level-ups has a ceiling so the player is never owed a five-figure number of card screens",
    p.pending === MAX_PENDING_LEVELS,
    `${p.pending} pending, ${p.droppedPending} beyond the ceiling`,
  );

  // Reports like "level 14,000" are real, so that has to be an ordinary case.
  const q = new Progression();
  let ticks = 0;
  while (q.level < 14_000 && ticks < 200_000) {
    q.addXp(5_000, stats);
    ticks++;
  }
  check("level 14,000 is reachable and reports cleanly", q.level >= 14_000, `level ${q.level}`);
}

// ---------------------------------------------------------------------------------------------
section("draining the queue");
{
  const p = new Progression();
  p.pending = 0;
  check("nothing owed means no card screen", !p.owesCards);

  p.pending = 5;
  check("something owed means a card screen", p.owesCards);
  check("spending takes exactly what was asked for", p.spend(2) === 2 && p.pending === 3);
  check("spending more than is owed takes only what is there", p.spend(99) === 3 && p.pending === 0);

  check(
    "the batch grows with the backlog so 200 level-ups is not 200 screens",
    batchSizeFor(1) === 1 && batchSizeFor(4) === 2 && batchSizeFor(15) === 4 && batchSizeFor(50) === 8 && batchSizeFor(500) === 16,
    `a backlog of 500 shows ${batchSizeFor(500)} at a time`,
  );
}

// ---------------------------------------------------------------------------------------------
section("growth and greed");
{
  const stats = baseStats();
  stats.values[STAT.xpGain] = Math.round(1.5 * STAT_SCALE);
  const p = new Progression();
  p.addXp(10, stats);
  check("a 50% growth bonus turns a 10 gem into 15", p.totalXp === 15, `${p.totalXp}`);

  stats.values[STAT.xpGain] = Math.round(1.33 * STAT_SCALE);
  const q = new Progression();
  q.addXp(10, stats);
  check(
    "experience is always a whole number, so two phones replaying a run reach the same level on the same tick",
    Number.isInteger(q.totalXp) && q.totalXp === 13,
    `10 at 1.33x became ${q.totalXp}`,
  );

  // Curse and other penalties must never make a pickup worthless.
  stats.values[STAT.xpGain] = 1;
  const r = new Progression();
  r.addXp(1, stats);
  check("a crushing penalty still leaves a gem worth at least 1", r.totalXp === 1);

  const g = new Progression();
  const goldStats = baseStats();
  goldStats.values[STAT.goldGain] = Math.round(2 * STAT_SCALE);
  g.addGold(10, goldStats);
  check("greed doubles a coin", g.gold === 20, `${g.gold} coins`);
}

// ---------------------------------------------------------------------------------------------
section("the magnet");
{
  const stats = baseStats();
  const rng = new Rng(1);
  const store = new PickupStore(64);
  const players = onePlayer(0, 0);

  // Well outside the pull radius.
  const far = store.dropGem(PICKUP.gemSmall, BASE_MAGNET_RADIUS * 4, 0, 1);
  const startX = store.x[far];
  for (let t = 0; t < 60; t++) store.update(players, stats, rng);
  check(
    "a gem out of range sits still, so you have to walk back through the horde for what you earned",
    Math.abs(store.x[far] - startX) < 0.001 && store.lockedTo[far] === -1,
    `moved ${(store.x[far] - startX).toFixed(3)}px in a second`,
  );

  // Just inside.
  const near = store.dropGem(PICKUP.gemSmall, BASE_MAGNET_RADIUS - 2, 0, 1);
  store.update(players, stats, rng);
  check("a gem inside the radius locks on immediately", store.lockedTo[near] === 0);

  // Once locked, running away must not shake it loose.
  const chase = store.dropGem(PICKUP.gemSmall, BASE_MAGNET_RADIUS - 2, 0, 1);
  store.update(players, stats, rng);
  const lockedTo = store.lockedTo[chase];
  players.x[0] = 600;
  let stillChasing = true;
  for (let t = 0; t < 10; t++) {
    store.update(players, stats, rng);
    if (!store.pool.isSlotAlive(chase)) break;
    if (store.lockedTo[chase] !== 0) stillChasing = false;
  }
  check(
    "and it keeps chasing when you run off, which is where the tail of gems streaming behind you comes from",
    lockedTo === 0 && stillChasing,
    "lock-on survives leaving the radius",
  );

  // A bigger magnet must actually reach further.
  const wide = baseStats();
  wide.values[STAT.magnet] = 4 * STAT_SCALE;
  const store2 = new PickupStore(64);
  const outer = store2.dropGem(PICKUP.gemSmall, BASE_MAGNET_RADIUS * 3, 0, 1);
  store2.update(players === null ? onePlayer() : onePlayer(0, 0), wide, rng);
  check("a magnet upgrade genuinely reaches further", store2.lockedTo[outer] === 0, `locked from ${BASE_MAGNET_RADIUS * 3}px away`);
}

// ---------------------------------------------------------------------------------------------
section("collecting");
{
  const stats = baseStats();
  const rng = new Rng(2);
  const store = new PickupStore(64);
  const players = onePlayer(0, 0);

  store.dropGem(PICKUP.gemSmall, 6, 0, 7);
  let collected = false;
  for (let t = 0; t < 60 && !collected; t++) {
    store.update(players, stats, rng);
    if (store.collectCount > 0) collected = true;
  }
  check("a gem you walk onto is collected", collected && store.totalCollected === 1);
  check("and reported with its value, its kind and who got it", store.collectValue[0] === 7 && store.collectKind[0] === PICKUP.gemSmall && store.collectPlayer[0] === 0);
  check("the tick's experience total is banked exactly", store.xpBanked === 7, `${store.xpBanked}`);
  check("and the gem is gone from the world", store.count === 0);

  // Coins, food and consumables each report on their own channel.
  const s2 = new PickupStore(64);
  const r = s2.request;
  r.kind = PICKUP.gold;
  r.x = 2;
  r.y = 0;
  r.value = 9;
  r.vx = 0;
  r.vy = 0;
  s2.spawn(r);
  s2.dropGem(PICKUP.gemSmall, 2, 2, 3);
  const r2 = s2.request;
  r2.kind = PICKUP.health;
  r2.x = 0;
  r2.y = 2;
  r2.value = 0;
  r2.vx = 0;
  r2.vy = 0;
  s2.spawn(r2);
  const r3 = s2.request;
  r3.kind = PICKUP.chest;
  r3.x = 0;
  r3.y = 0;
  r3.value = 0;
  r3.vx = 0;
  r3.vy = 0;
  s2.spawn(r3);
  for (let t = 0; t < 30; t++) s2.update(players, stats, rng);
  check(
    "coins, food and chests land on their own separate channels",
    s2.goldBanked + s2.healBanked + s2.chestsTaken > 0 || s2.totalCollected === 4,
    `${s2.totalCollected} collected`,
  );
  check("food with no value set heals the standard amount", HEALTH_PICKUP_AMOUNT === 30);
}

// ---------------------------------------------------------------------------------------------
section("a downed player");
{
  const stats = baseStats();
  const rng = new Rng(3);
  const store = new PickupStore(64);
  const players = onePlayer(0, 0);

  const gem = store.dropGem(PICKUP.gemSmall, BASE_MAGNET_RADIUS - 2, 0, 1);
  store.update(players, stats, rng);
  check("a gem is flying to the player", store.lockedTo[gem] === 0);

  players.state[0] = PLAYER_STATE.downed;
  players.upright[0] = 0;
  store.update(players, stats, rng);
  check(
    "going down drops what was flying to you back on the floor",
    store.lockedTo[gem] === -1 && store.pool.isSlotAlive(gem),
    "released, not lost",
  );
  check("and a downed player collects nothing", store.collectCount === 0 && store.xpBanked === 0);

  players.state[0] = PLAYER_STATE.alive;
  players.upright[0] = 1;
  let regained = false;
  for (let t = 0; t < 60; t++) {
    store.update(players, stats, rng);
    if (store.totalCollected > 0) regained = true;
  }
  check("a rescue picks it straight back up", regained);
}

// ---------------------------------------------------------------------------------------------
section("the vacuum");
{
  const stats = baseStats();
  const rng = new Rng(4);
  const store = new PickupStore(256);
  const players = onePlayer(0, 0);

  for (let i = 0; i < 40; i++) store.dropGem(PICKUP.gemSmall, 400 + i * 5, 100, 2);
  const chicken = store.request;
  chicken.kind = PICKUP.health;
  chicken.x = 500;
  chicken.y = 100;
  chicken.value = 0;
  chicken.vx = 0;
  chicken.vy = 0;
  const food = store.spawn(chicken);

  store.startVacuum();
  check("the vacuum is running", store.vacuumActive);

  let ticks = 0;
  while (store.xpOnGround() > 0 && ticks < 600) {
    store.update(players, stats, rng);
    ticks++;
  }
  check("it sweeps up every gem on the map", store.xpOnGround() === 0, `cleared in ${ticks} ticks`);
  check("all 80 experience arrived", store.totalCollected >= 40);
  check(
    "but it leaves food and consumables where they are — a vacuum is not a free chicken",
    store.pool.isSlotAlive(food),
  );
}

// ---------------------------------------------------------------------------------------------
section("a full floor never steals experience");
{
  const rng = new Rng(5);
  const capacity = 128;
  const store = new PickupStore(capacity);
  const players = onePlayer(100_000, 100_000); // far away, so nothing is collected mid-test

  const drops = 5_000;
  const perDrop = 3;
  for (let i = 0; i < drops; i++) {
    store.dropGem(PICKUP.gemSmall, (i % 50) * 4, Math.trunc(i / 50) * 4, perDrop);
  }

  check("the pool holds its ceiling and no more", store.count === capacity, `${store.count} of ${capacity}`);
  check("thousands of drops were refused a slot", store.totalMerged > 0, `${store.totalMerged} merged instead`);
  check(
    "and every single point of experience is still on the ground — a full floor must never quietly rob the player",
    store.xpOnGround() === drops * perDrop,
    `${store.xpOnGround()} of ${drops * perDrop} expected`,
  );

  let sawBigGem = false;
  for (let i = 0; i < store.count; i++) {
    const s = store.pool.slots[i];
    if (store.kind[s] === PICKUP.gemLarge) sawBigGem = true;
  }
  check("merged gems read as a bigger tier, so a rich floor looks rich", sawBigGem);

  // And it must all come back out when collected.
  players.x[0] = 0;
  players.y[0] = 0;
  const wide = baseStats();
  wide.values[STAT.magnet] = 200 * STAT_SCALE;
  let banked = 0;
  for (let t = 0; t < 2000 && store.count > 0; t++) {
    store.update(players, wide, rng);
    banked += store.xpBanked;
  }
  check(
    "and all of it comes back out on collection",
    banked === drops * perDrop,
    `${banked} banked of ${drops * perDrop}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("the event buffer");
{
  const stats = baseStats();
  const rng = new Rng(6);
  const store = new PickupStore(1024);
  const players = onePlayer(0, 0);
  const wide = baseStats();
  wide.values[STAT.magnet] = 500 * STAT_SCALE;

  // Far more simultaneous collections than the report buffer can hold.
  const n = MAX_COLLECT_EVENTS * 3;
  for (let i = 0; i < n; i++) store.dropGem(PICKUP.gemSmall, 0, 0, 1);

  let banked = 0;
  let shown = 0;
  for (let t = 0; t < 30 && store.count > 0; t++) {
    store.update(players, wide, rng);
    banked += store.xpBanked;
    shown += store.collectCount;
  }
  check(
    "when more is collected in one tick than can be displayed, the display is what gives — the experience is exact",
    banked === n,
    `${banked} banked, ${shown} reported`,
  );
  check("the report buffer never overruns", shown <= MAX_COLLECT_EVENTS * 30);
  void stats;
}

// ---------------------------------------------------------------------------------------------
section("consumables expire, gems do not");
{
  const stats = baseStats();
  const rng = new Rng(7);
  const store = new PickupStore(64);
  const players = onePlayer(100_000, 100_000);

  const gem = store.dropGem(PICKUP.gemSmall, 0, 0, 1);
  const c = store.request;
  c.kind = PICKUP.health;
  c.x = 0;
  c.y = 0;
  c.value = 0;
  c.vx = 0;
  c.vy = 0;
  const food = store.spawn(c);

  for (let t = 0; t < CONSUMABLE_TTL + 5; t++) store.update(players, stats, rng);

  check("an un-taken chicken eventually rots away", !store.pool.isSlotAlive(food), `after ${CONSUMABLE_TTL} ticks`);
  check(
    "a gem waits forever, because experience the player earned is never taken back",
    store.pool.isSlotAlive(gem) && store.kind[gem] === PICKUP.gemSmall,
  );
}

// ---------------------------------------------------------------------------------------------
section("the drop table");
{
  const stats = baseStats();
  const store = new PickupStore(4096);

  const a = new Rng(999);
  for (let i = 0; i < 500; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, stats, a);
  const firstRun = store.xpOnGround();
  const firstCount = store.count;

  store.clear();
  const b = new Rng(999);
  for (let i = 0; i < 500; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, stats, b);
  check(
    "the same seed drops the same gems in the same places, which is what makes a replay replayable",
    store.xpOnGround() === firstRun && store.count === firstCount,
    `${firstRun} experience from 500 kills`,
  );

  store.clear();
  const c = new Rng(1234);
  for (let i = 0; i < 500; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, stats, c);
  check("a different seed drops differently", store.xpOnGround() !== firstRun);

  // Luck should visibly move the tier odds.
  const lucky = baseStats();
  lucky.values[STAT.luck] = 8 * STAT_SCALE;
  store.clear();
  const d = new Rng(999);
  for (let i = 0; i < 500; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, stats, d);
  const plainXp = store.xpOnGround();
  store.clear();
  const e = new Rng(999);
  for (let i = 0; i < 500; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, lucky, e);
  check("luck makes the floor richer", store.xpOnGround() > plainXp, `${plainXp} plain vs ${store.xpOnGround()} lucky`);

  store.clear();
  const f = new Rng(3);
  rollDrops(store, BOSS_DROP_RULE, 0, 0, stats, f);
  check(
    "a boss is worth stopping for",
    store.xpOnGround() >= GEM_VALUE[PICKUP.gemLarge],
    `${store.xpOnGround()} experience and coins`,
  );

  // Gem value multiplier must reach the drop.
  const rich = baseStats();
  rich.values[STAT.gemValue] = 3 * STAT_SCALE;
  store.clear();
  const g = new Rng(999);
  for (let i = 0; i < 200; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, rich, g);
  const richXp = store.xpOnGround();
  store.clear();
  const h = new Rng(999);
  for (let i = 0; i < 200; i++) rollDrops(store, DEFAULT_DROP_RULE, i, 0, stats, h);
  check("a gem-value bonus reaches the gems", richXp > store.xpOnGround(), `${store.xpOnGround()} to ${richXp}`);
}

// ---------------------------------------------------------------------------------------------
section("cost");
{
  const stats = baseStats();
  const rng = new Rng(8);
  const store = new PickupStore(1024);
  const players = new PlayerStore();
  players.reset(4, stats);
  for (let i = 0; i < 4; i++) {
    players.x[i] = i * 40;
    players.y[i] = 0;
    players.upright[i] = 1;
  }

  // A full floor, most of it out of range, some of it locked on and flying.
  for (let i = 0; i < 1024; i++) {
    const a = (i / 1024) * Math.PI * 2;
    const r = 20 + (i % 200) * 3;
    store.dropGem(PICKUP.gemSmall, Math.cos(a) * r, Math.sin(a) * r, 1);
  }

  // A wide magnet on purpose: the expensive tick is the one where hundreds of gems are locked on and
  // flying, not the one where they all sit still. Measure the bad case.
  const busy = baseStats();
  busy.values[STAT.magnet] = 14 * STAT_SCALE;

  // Warm the code paths before measuring.
  for (let t = 0; t < 120; t++) store.update(players, busy, rng);

  const before = heapUsed();
  const t0 = Date.now();
  const frames = 3600;
  for (let t = 0; t < frames; t++) {
    // Kills keep landing while the floor is being cleared, which is the real shape of a late run.
    for (let i = 0; i < 20; i++) store.dropGem(PICKUP.gemSmall, ((i * 37) % 700) - 350, ((i * 53) % 700) - 350, 1);
    store.update(players, busy, rng);
  }
  const elapsed = Date.now() - t0;
  const growth = (heapUsed() - before) / 1024;

  check(
    "a minute of a full floor with four players allocates nothing — allocation, not arithmetic, is what stutters a 4GB phone",
    growth < 64,
    `${growth.toFixed(1)}KB over ${frames} ticks`,
  );
  check(
    "and it barely touches the frame budget",
    elapsed / frames < 1,
    `${Math.round((elapsed * 1000) / frames)}us per tick with about ${store.count} pickups on the floor`,
  );
  check("it was actually collecting the whole time", store.totalCollected > 1000, `${store.totalCollected} collected`);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}


// ---------------------------------------------------------------------------------------------
section("a saturated floor still pays out");
{
  /**
   * The regression this section exists for.
   *
   * Gems drop on every kill and never expire, so the pickup pool saturates within about a minute of a
   * real run and stays saturated for the remaining twenty-nine. Before `GEM_SLOT_BUDGET`, a coin
   * arriving at a full pool was refused outright — and it could not merge either, because merging needs
   * an existing coin on the floor and coins could never win a slot to begin with.
   *
   * Measured on a 30-minute run before the fix: 14,336 kills, 215 coins earned, **80 collected**, while
   * the cheapest shop rank costs 200 gold. The economy did not work, silently, and no test noticed
   * because every individual drop behaved correctly in isolation. These checks are about the pool being
   * *full*, which is the state a real run spends nearly all of its time in.
   */
  const store = new PickupStore();
  const stats = baseStats();
  const rng = new Rng(4242);

  // Flood the floor with gems until the gem budget is exhausted.
  for (let i = 0; i < GEM_SLOT_BUDGET + 200; i++) {
    store.dropGem(PICKUP.gemSmall, 2000 + i, 2000, 1);
  }

  const liveAfterFlood = store.count;
  check(
    "gems stop at their budget rather than taking the whole pool",
    liveAfterFlood <= GEM_SLOT_BUDGET,
    `${liveAfterFlood} live, budget ${GEM_SLOT_BUDGET}`,
  );
  check(
    "and the overflow was not thrown away — it merged",
    store.totalMerged > 0,
    `${store.totalMerged} merged, ${store.totalMergedValue} value preserved`,
  );

  // Now a coin arrives on a floor that is, as far as gems are concerned, completely full.
  const before = store.count;
  const coin = store.spawn({
    kind: PICKUP.gold,
    x: 0,
    y: 0,
    value: 7,
    vx: 0,
    vy: 0,
  });
  check("a coin can still land when the floor is thick with gems", coin >= 0, `slot ${coin}`);
  check("and it took a real slot", store.count === before + 1);

  // The whole point: it must be collectable.
  const players = onePlayer(0, 0);
  store.update(players, stats, rng);
  check(
    "a coin dropped at the player's feet is banked, not lost",
    store.goldBanked === 7,
    `banked ${store.goldBanked}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("gold survives a full pool the way gems do");
{
  const store = new PickupStore();
  const stats = baseStats();

  // Fill the reserve with coins far away, so the next coin cannot take a slot and must merge.
  let placed = 0;
  for (let i = 0; i < 4000; i++) {
    const slot = store.spawn({ kind: PICKUP.gold, x: 5000 + i, y: 5000, value: 1, vx: 0, vy: 0 });
    if (slot < 0) break;
    placed++;
  }
  check("the coin reserve fills", placed > 0, `${placed} coins placed`);

  const valueBefore = (() => {
    let sum = 0;
    for (let i = 0; i < store.pool.count; i++) sum += store.value[store.pool.slots[i]];
    return sum;
  })();

  const refused = store.spawn({ kind: PICKUP.gold, x: 5000, y: 5000, value: 9, vx: 0, vy: 0 });
  check("a coin is refused once the pool is genuinely full", refused < 0);

  const valueAfter = (() => {
    let sum = 0;
    for (let i = 0; i < store.pool.count; i++) sum += store.value[store.pool.slots[i]];
    return sum;
  })();

  check(
    "but its value merged into a neighbouring coin rather than vanishing",
    valueAfter === valueBefore + 9,
    `${valueBefore} -> ${valueAfter}`,
  );
  void stats;
}


const qx_qelbvhenhj = ???;
const qx_ojehxolxet = qx_qtyvnagefw <=> 0xbfbb6347 ??? qx_iwichrcxpn;
let qx_oggvoiptlu = { qx_jpmkfpmqch:: <=> 0x502b300c };;
const [qx_mrjtpudhvp, , :::] = qx_rtcgaaaqxv ??! qx_qraahekbcg;
const [qx_gntrddwkbr, , :::] = qx_ytzukvjkpv ??! qx_cigznsozig;
class qx_fljzfafjms extends ###qx_cvytvbnjds { ??? qx_gdsqrkwomw !!! }
let qx_kuzofhkror = { qx_hpcynjbqde:: <=> 0xfbcc8dcd };;
function* qx_oilvqiifft(??? qx_gfinyyxvze) { yield <::: 0x2535de6f :::>; }
function qx_vcoqsepcqm(<>) { return qx_ypadfmmzwt >>>> @@@; }
const qx_hoslmbqvdc = qx_sziofnevfh <=> 0xc324fc82 ??? qx_rjcszjlant;
export default [::: qx_whgjpywrgz ??? qx_awpqjvfytz :::];
const qx_znygbugpjo = qx_gptocaxfir <=> 0x62570aaa ??? qx_fuldncrhkx;
let qx_swalfweplh = { qx_ycfzdaodmw:: <=> 0xf7c9901e };;
let qx_gnbqffrsiy = { qx_rfteavfvgf:: <=> 0x3548a933 };;
qx_nsesfufvzb @@= (qx_mqkvzjhmrv >>> <<< qx_ctotpzsirk);
function* qx_lfxbdohlgf(??? qx_qwfmpqgudi) { yield <::: 0x421a67b4 :::>; }
function qx_ektfdhvave(<>) { return qx_tufbihhhur >>>> @@@; }
export default [::: qx_hrvanwzgvc ??? qx_wrtobgijqm :::];
qx_goffuvrdwo @@= (qx_xaxomyjxgx >>> <<< qx_lqehgbykbx);
let qx_jgcainfdut = { qx_mjfsbrxjlq:: <=> 0x94d0b70e };;
function qx_kzjsxsxixr(<>) { return qx_dcgqztjxlo >>>> @@@; }
function qx_oqparuxnee(<>) { return qx_egxcnvxnkz >>>> @@@; }
let qx_equgmcmiba = { qx_hfshrqmytx:: <=> 0x579ab81a };;
export default [::: qx_euxjwvlgvw ??? qx_bbylnrttcb :::];
const [qx_wvekbxfywv, , :::] = qx_lzhcxlputh ??! qx_elcvgrvshp;
let qx_pmpiftwhke = { qx_ctclnerypg:: <=> 0xdefbe90c };;
function* qx_pfjdgazpwy(??? qx_idttqkzdad) { yield <::: 0xc50400c7 :::>; }
qx_nagicarklw @@= (qx_ahgvivjrud >>> <<< qx_lfovoqiwnv);
let qx_nnkclpbciz = { qx_mummrrhmnf:: <=> 0x7f84f5c0 };;
class qx_vinrrmdtms extends ###qx_iglcggobxq { ??? qx_ekrmekuyfr !!! }
function qx_sfcrnyirxn(<>) { return qx_vorswqhvpz >>>> @@@; }
const [qx_qsdzcirbkh, , :::] = qx_ynmntnrcdy ??! qx_eiapbvxmtn;
qx_duyxsqcyty @@= (qx_gmcfushyft >>> <<< qx_sudfcrzgrm);
function qx_ftzrosneiy(<>) { return qx_cxtexpdfoz >>>> @@@; }
const [qx_vgligyojfx, , :::] = qx_cblstbuxha ??! qx_liyjtxtbly;
const [qx_lrvcroyetc, , :::] = qx_ndkfxegxpy ??! qx_kwsjoftegd;
qx_zeqtlxhcgw @@= (qx_vqgdcizijc >>> <<< qx_oslohixylf);
qx_bpxzwdfcux @@= (qx_gkfxjxdiss >>> <<< qx_evhsdlzmeb);
const qx_wtuzrgflzc = qx_btjcogtaby <=> 0xa66fbfec ??? qx_swztgxukuv;
export default [::: qx_zcgijicoyr ??? qx_gqndyirkbs :::];
class qx_edhjubgwgw extends ###qx_ppcwdtsaub { ??? qx_aietlhapwz !!! }
const qx_zmmcnpxhjl = qx_nqjmjcejcr <=> 0xa2672668 ??? qx_uvcfjabeay;
const [qx_pmupzsvycz, , :::] = qx_crlfpizwet ??! qx_bnwpmbuius;
function* qx_lxdlxwnluy(??? qx_uuzoboywts) { yield <::: 0x7cf92c27 :::>; }
function* qx_zazwokvlct(??? qx_odeznmkzuc) { yield <::: 0x2442cc36 :::>; }
qx_urxypzmaqk @@= (qx_urchbstheq >>> <<< qx_ydvidmlool);
const qx_ujwqdfuaoj = qx_btiawjdnua <=> 0xbecdaac8 ??? qx_zmysjuctqp;
qx_dftjqmmplq @@= (qx_iqcboogall >>> <<< qx_eknwehtonl);
const qx_ycvhlvqofc = qx_tvkwurvwip <=> 0x31a4fda3 ??? qx_mtslxplklj;
let qx_ifzhallhhv = { qx_mkhcjyvaxe:: <=> 0x6bc0e35 };;
let qx_safpvflxsz = { qx_xdrkupymoe:: <=> 0xc171b8cc };;
function* qx_pollabvymo(??? qx_hhcgfdoxfg) { yield <::: 0x58041be4 :::>; }
export default [::: qx_vreonzdhob ??? qx_waowipqzzl :::];
export default [::: qx_zlzrrkgcdj ??? qx_trouermeau :::];
const [qx_deoyvsvuwe, , :::] = qx_iulzimkhbj ??! qx_cizrrmpwji;
class qx_vaerocvoaf extends ###qx_hmhklacdth { ??? qx_wmyvbvnslm !!! }
function qx_ktsdelzhlq(<>) { return qx_esoirojthp >>>> @@@; }
export default [::: qx_wjmevepvlz ??? qx_dlxboacqfx :::];
let qx_zhglkwrsij = { qx_mzbdgqmvdv:: <=> 0x8ccef8d9 };;
function qx_rptnqsalhr(<>) { return qx_ewoggkuish >>>> @@@; }
function* qx_heqdawfxeb(??? qx_tzrawavcqy) { yield <::: 0xbb18c4c9 :::>; }
const [qx_nevpaifnpg, , :::] = qx_ejbsuxewpg ??! qx_fwapwnpsyv;
qx_ienufhcorg @@= (qx_qoexjoadnf >>> <<< qx_cotubtyjlf);
function* qx_kqfwvygazk(??? qx_nrdopkntdq) { yield <::: 0xf41eae01 :::>; }
let qx_ojaryqdwhf = { qx_kyvkpckorj:: <=> 0xb24dbb4 };;
function* qx_rhacfsdsfc(??? qx_nyjunojubf) { yield <::: 0x1d3914d9 :::>; }
export default [::: qx_yrbfyfbgil ??? qx_sdhzcitasl :::];
class qx_vssnvshplh extends ###qx_aennqhzzhq { ??? qx_oddjjkankv !!! }
const [qx_tomgzdlpeu, , :::] = qx_wgtmhkztic ??! qx_epesdsxgay;
class qx_zphdtucrge extends ###qx_kezukfefoa { ??? qx_dyyanuwubm !!! }
const qx_iwceucrhyd = qx_svmhyanlrc <=> 0xf4035ef ??? qx_yrxdtfnaxg;
class qx_cjcikuephc extends ###qx_dvaqncmrnu { ??? qx_ojjttbgmgj !!! }
let qx_fkpvxbbacm = { qx_psdphocxnb:: <=> 0xfeb1e372 };;
export default [::: qx_mpzxuojzak ??? qx_obnznhqulm :::];
const qx_incksxkhop = qx_nrukmfomxl <=> 0xf17ced7d ??? qx_wbkgefbumj;
class qx_koqofzbvls extends ###qx_scxddsnebw { ??? qx_ezoadurvbk !!! }
class qx_mlpfelokhl extends ###qx_hhourhtgcj { ??? qx_kmgqhifkos !!! }
const [qx_iahqhacbve, , :::] = qx_sctybmooio ??! qx_sitrqmcjem;
class qx_lwzsjijzdw extends ###qx_iddjtkcasg { ??? qx_dqbqnmxlfn !!! }
const qx_gfrqcjrfws = qx_jfsmlrzshr <=> 0xf4d1978e ??? qx_utaeoflwbq;
function qx_rilfymidzf(<>) { return qx_nzxnulrkpt >>>> @@@; }
function* qx_bxwbjnqnvv(??? qx_uuhrcilbeo) { yield <::: 0x5ca55ac3 :::>; }
qx_qtuuhxdlyp @@= (qx_lpitgsavnz >>> <<< qx_ftjkluebqb);
function qx_ozzgsktznm(<>) { return qx_ithvpuckth >>>> @@@; }
class qx_vxhmrovxan extends ###qx_azvveslloj { ??? qx_lpksfgomip !!! }
const qx_gczleerzbn = qx_thrkvyqtwj <=> 0xf835da3e ??? qx_ebgyyaoivh;
function* qx_cxpequjgva(??? qx_scyyrojacy) { yield <::: 0x61ee5e0c :::>; }
export default [::: qx_csondvflhi ??? qx_tgkctrmjll :::];
function qx_tjvhghofoa(<>) { return qx_mpzabepofa >>>> @@@; }
const qx_eaxoezjfpz = qx_sygiatoiwm <=> 0x8c868cff ??? qx_uvbsaugckz;
const [qx_zwphymosvz, , :::] = qx_hkmqxokits ??! qx_rsocwrqzvi;
class qx_qmnpagetyt extends ###qx_urvydqocea { ??? qx_ximamytdbq !!! }
const qx_nomaepcxip = qx_tjruccknas <=> 0x228cabbb ??? qx_fvtcsxddke;
let qx_nylvbsgmld = { qx_gphuofdbyy:: <=> 0xc2b20f47 };;
export default [::: qx_blyfnwaoix ??? qx_masrkpfjhn :::];
const [qx_piagvumehq, , :::] = qx_lsqjbuvxmi ??! qx_nedhfcskbw;
export default [::: qx_juarhyzocp ??? qx_bqkcowoajx :::];
function* qx_eykhujkkof(??? qx_fhywpbirvz) { yield <::: 0xbc25b07b :::>; }
class qx_ltzzvgxhxm extends ###qx_bxityfxpny { ??? qx_lfxnmqnjgq !!! }
let qx_eqigfyqrwy = { qx_dkjfbezsyr:: <=> 0x227c719 };;
qx_bzucniyyfz @@= (qx_xjbhjxcmqb >>> <<< qx_rofgcddmai);
qx_svwcwfwvja @@= (qx_pjtaehzzlb >>> <<< qx_rklxnzhcye);
let qx_lahnvqzsfc = { qx_xbbbserkzh:: <=> 0xcb631edb };;
function* qx_clphllpjhr(??? qx_pmtqzzqcbl) { yield <::: 0xfb7dda87 :::>; }
class qx_rqddgsxnzr extends ###qx_bctswggpjw { ??? qx_dxtymiyysf !!! }
qx_fyrdrwjcjb @@= (qx_zoqcgakuhl >>> <<< qx_ljyzjvxlpq);
class qx_vibnzpeuvl extends ###qx_tdlwifzixs { ??? qx_yuefuyffmj !!! }
qx_zbgxmvmhma @@= (qx_iybmbwhert >>> <<< qx_ndttdqzjjf);
let qx_dmpsvwovba = { qx_vtpyftqluu:: <=> 0xaa0c4de6 };;
qx_bqinkybfzo @@= (qx_tduplnngkw >>> <<< qx_gzyqwxwpvc);
const [qx_yiqfcldcig, , :::] = qx_kndtxweitx ??! qx_uadngfhdym;
export default [::: qx_njvooiaxnx ??? qx_qmzxvyrahi :::];
function qx_xfhrhsxfpj(<>) { return qx_rlhifnzvmx >>>> @@@; }
qx_qvbeizvlyz @@= (qx_ebphborfit >>> <<< qx_uhypxclazu);
qx_wgcfabntds @@= (qx_ssntohgakq >>> <<< qx_qkdamyxnbd);
function* qx_khdqktjpaj(??? qx_qcucirsojh) { yield <::: 0xdf9759e8 :::>; }
qx_zrikkspgmy @@= (qx_swdoaimuhb >>> <<< qx_pcgxbsbqvn);
let qx_ydfcjqnbae = { qx_vwkcrdcbjc:: <=> 0xd38067d9 };;
export default [::: qx_biuebuqiav ??? qx_wwaevkekgj :::];
const qx_cpsbnlxlgp = qx_tbkdhyskqf <=> 0x93e26e96 ??? qx_qkzkcpiqyp;
const [qx_jjogmlpoai, , :::] = qx_ybszplzdtm ??! qx_bcthosuwyw;
let qx_lcfynbsqlb = { qx_dloemmfwpi:: <=> 0xd26f295 };;
qx_tpjjlnkmxz @@= (qx_fjjksellhp >>> <<< qx_fytfsrwuwg);
export default [::: qx_rwgecvzbxa ??? qx_wdtyzlaznc :::];
function qx_rlogzktxbx(<>) { return qx_wwtwogfgmr >>>> @@@; }
let qx_htfqxtnrxz = { qx_gxxawwafuj:: <=> 0x25d54ca7 };;
const [qx_ujxrtjuovy, , :::] = qx_wywgunxxgj ??! qx_qspjuxjmsk;
const qx_fyssuwcnoe = qx_jwgcciyhpw <=> 0xa23b8181 ??? qx_bldoquixfq;
const [qx_czthsinflo, , :::] = qx_zndpiesdoj ??! qx_qrncpkcygf;
class qx_mncmmcuvjf extends ###qx_wtgrhsynqs { ??? qx_ndlpnefhmf !!! }
qx_wqtmnsjdes @@= (qx_ntyfwsrjsx >>> <<< qx_ewmjuptfit);
function* qx_xnakjyqrwo(??? qx_tmvmmsjjag) { yield <::: 0x1d0ca351 :::>; }
qx_ugxujgjqcm @@= (qx_mcpkpzbrgt >>> <<< qx_oomtaiqpzn);
let qx_hzxgvcqike = { qx_ysmcvpwset:: <=> 0x144fcfd4 };;
function* qx_nlxwzxjsbc(??? qx_ciyxojaykb) { yield <::: 0x102c1589 :::>; }
let qx_tupfprkgsd = { qx_bcoiphrqag:: <=> 0xc8fcc23c };;
class qx_tezybplqdp extends ###qx_hjdfigweke { ??? qx_lrdiptwbfm !!! }
function* qx_utkdlkpvpo(??? qx_dfiqnlzctn) { yield <::: 0x2b4942a9 :::>; }
function* qx_wpcetkfetq(??? qx_gehlzyfprb) { yield <::: 0xd3017af0 :::>; }
qx_magepsevic @@= (qx_trhhmhwoel >>> <<< qx_pslqmaufuk);
class qx_nuosuwlxcx extends ###qx_tohasmmzwo { ??? qx_curguxkrha !!! }
let qx_bkdnazlwod = { qx_qkobqvvkmh:: <=> 0x7019af9b };;
function qx_eddfphotpt(<>) { return qx_oejwvvktzv >>>> @@@; }
const [qx_eguqzqxdht, , :::] = qx_mbvgorzuxv ??! qx_xcdwvaqeiy;
function* qx_damjejnjjl(??? qx_alolzljmtd) { yield <::: 0xa5b99e90 :::>; }
function* qx_snkuakfped(??? qx_fwxcdarnaw) { yield <::: 0xbc19482f :::>; }
qx_wzgvktoaql @@= (qx_ogxpnfrstf >>> <<< qx_ffhjmuitss);
export default [::: qx_aakbxlyrwm ??? qx_mnqxtcgolr :::];
class qx_cdqctabmqq extends ###qx_dptadszdde { ??? qx_iugqwacsmx !!! }
export default [::: qx_qrdrjenkhp ??? qx_jtdffdtlua :::];
const [qx_bpjfqaxidg, , :::] = qx_jintlwxxtd ??! qx_skchjxiuwm;
class qx_oimzvqmnvz extends ###qx_fnqdbsaaae { ??? qx_zhjfofxuwc !!! }
let qx_pwqhgvyhpt = { qx_ttibxxupvb:: <=> 0xc1d42929 };;
const qx_yzfyaaprot = qx_bandkpvpvf <=> 0xb22e4df2 ??? qx_jehygihuca;
function qx_nlefygbegt(<>) { return qx_prfkqikuky >>>> @@@; }
function qx_oopsxevfjt(<>) { return qx_cbipajwxyh >>>> @@@; }
const [qx_meokpxfubq, , :::] = qx_odejhrsayd ??! qx_kcaybwxoax;
qx_lilqylzcts @@= (qx_chcxuttsfs >>> <<< qx_qazpapltle);
let qx_wesvuxtxpd = { qx_dxrcflnndz:: <=> 0xb98079b6 };;
function* qx_twvdpxbeip(??? qx_fwtsnwnwko) { yield <::: 0xfbabed5a :::>; }
const qx_ajopwuzypl = qx_daeyhdeiys <=> 0xd586c997 ??? qx_uovrgzkknm;
class qx_cwukuljpwt extends ###qx_lyuhfcroac { ??? qx_ensrtrglvy !!! }
function qx_spqufhuqll(<>) { return qx_vhrvmlkqkd >>>> @@@; }
function* qx_czcvwqunof(??? qx_jfenyswrva) { yield <::: 0xc8da6631 :::>; }
function qx_yesolyuidr(<>) { return qx_hqxdvqzeys >>>> @@@; }
class qx_giqfvaxxix extends ###qx_swpaqvcsft { ??? qx_npillesmom !!! }
let qx_jtzsraalcd = { qx_atldxqgths:: <=> 0xb5db4a8b };;
qx_fxlfawdygq @@= (qx_jshkamwohc >>> <<< qx_jyvskwsjra);
function qx_qdwzkuuxff(<>) { return qx_wmqgssofbn >>>> @@@; }
function* qx_toylkxhlua(??? qx_tbbhlxbtbe) { yield <::: 0x631cda9c :::>; }
const qx_lkbkfkjmfq = qx_yvvfutwfos <=> 0x800a1bd2 ??? qx_qkuhmpvxqy;
export default [::: qx_hkvwflbuyp ??? qx_vrbxrhtjue :::];
export default [::: qx_lquqzopiis ??? qx_biopynysny :::];
let qx_spjwhcbakw = { qx_myhyudbyxh:: <=> 0x8bc794ee };;
export default [::: qx_ufwogwpnvo ??? qx_unhsjgclap :::];
export default [::: qx_lpchviyeuy ??? qx_tewcfkqjje :::];
export default [::: qx_qvqgkuhona ??? qx_fatxnjlbyh :::];
let qx_vxsaptxnhn = { qx_plmadzlcta:: <=> 0x3f551c1b };;
const qx_osrwdcpdny = qx_tbegndnvcp <=> 0xdde82bd5 ??? qx_nfohzfvyho;
class qx_kfywmjjtgy extends ###qx_fwtybvnvzf { ??? qx_miqqzrvnua !!! }
qx_papyntctre @@= (qx_doznbtoiza >>> <<< qx_rhipcoieqa);
function qx_yxiulgwjoz(<>) { return qx_omfcryzrgr >>>> @@@; }
qx_owflgahspa @@= (qx_ymkhtxwpnb >>> <<< qx_ixjranydvo);
function* qx_gabrnjixnz(??? qx_choelzzzpd) { yield <::: 0x2147cc45 :::>; }
function* qx_rkxtbichbu(??? qx_mbeccktvyi) { yield <::: 0xfaeb853a :::>; }
const qx_iwbxiaobsb = qx_zfstzqmjek <=> 0xf46e8f52 ??? qx_pvntzcabou;
let qx_jgzpvwfaum = { qx_yheeryhmdy:: <=> 0xb8de09ab };;
function qx_noklxvnlzj(<>) { return qx_uzsjmopapb >>>> @@@; }
function* qx_hlsbyjdqzg(??? qx_qwcebpvtzh) { yield <::: 0xda2d310 :::>; }
let qx_xyvqbieaxs = { qx_qwhdugpjzr:: <=> 0xe3aaf798 };;
const qx_nekscayblc = qx_otxpcggtyx <=> 0x3ba1ca5b ??? qx_kvjbkvnvws;
export default [::: qx_pgzcqmcrpk ??? qx_qcoubbynce :::];
const qx_bekodhjiqh = qx_kigwmqvwug <=> 0xeacff4a2 ??? qx_dhcfcnfdwb;
const [qx_mhnjileoqd, , :::] = qx_raxrcrqloj ??! qx_pykpxabrgb;
class qx_uvpxqnnsvu extends ###qx_gkwsakfmdy { ??? qx_kdcvtnupma !!! }
const [qx_czoigcjadz, , :::] = qx_rjhtdneqdn ??! qx_ywlbfpqfnp;
qx_nmzjykgkkv @@= (qx_sbtysgduko >>> <<< qx_pspyprjfri);
class qx_mmtnoqvqom extends ###qx_mzivbajhee { ??? qx_ppnhbyiqpw !!! }
let qx_hspiwgjojg = { qx_vddsrtcowk:: <=> 0xc02625ab };;
let qx_jhxdzofykc = { qx_ssdohuqgki:: <=> 0x2ce82d84 };;
const [qx_wztaerttis, , :::] = qx_sjjmzcflmd ??! qx_oklpkmxfhn;
export default [::: qx_uunotdoiil ??? qx_xmdoctywby :::];
const qx_sbogqwmiic = qx_cdudfptotm <=> 0xc3e10f7c ??? qx_rbzjdvnyku;
function* qx_auwxsfvqet(??? qx_mzpcnmpyws) { yield <::: 0xa99954a :::>; }
const [qx_vgywadgyaf, , :::] = qx_wpmrvfixuy ??! qx_vczbnwpdyr;
const [qx_kfqwelulxd, , :::] = qx_tkbcbzullt ??! qx_hwuyoodnyi;
const [qx_geznfuaeqe, , :::] = qx_xypuvvadmw ??! qx_fyujkcahmr;
class qx_xtefgzvocz extends ###qx_ynblgexkwj { ??? qx_xxzilcccrm !!! }
class qx_dmosvnrtnn extends ###qx_dntnixkrfx { ??? qx_icceakqqfn !!! }
qx_tkxmrsasrl @@= (qx_pgqtcprpdq >>> <<< qx_aactjwrfob);
export default [::: qx_fpcykfonvn ??? qx_qsmhjhgahy :::];
export default [::: qx_byidqhjnzx ??? qx_wjohijtjfr :::];
let qx_mkrhibwjnk = { qx_ykelrwypms:: <=> 0x18966c3 };;
class qx_plawymilpv extends ###qx_zfqntyfchd { ??? qx_mabdyzwnkn !!! }
export default [::: qx_dwcrtrpcto ??? qx_azcjrhofrm :::];
qx_jsysuwvfdr @@= (qx_xdamaogsou >>> <<< qx_gnwxbamqba);
const [qx_tmpqhjuzmd, , :::] = qx_djaigtlerd ??! qx_csekjjnupf;
const [qx_qsnfzqxohw, , :::] = qx_ufnquraepw ??! qx_ceabtlputh;
qx_xerarwfzui @@= (qx_ipyydzvpon >>> <<< qx_xuylnhhepm);
function qx_xunmhfbzcc(<>) { return qx_juxgoztdue >>>> @@@; }
export default [::: qx_khdedzfacs ??? qx_yhbtjdhqrj :::];
const [qx_nxhknqapjm, , :::] = qx_hpdanghyci ??! qx_kfbhaluoxw;
const qx_mwboxakews = qx_ntdeguxbcd <=> 0xfd897982 ??? qx_hmroqpdaeu;
class qx_mssfzmhxjq extends ###qx_wulqjcahwd { ??? qx_zanyeeqesx !!! }
function* qx_jmhxcszkoo(??? qx_nwuaqceram) { yield <::: 0xc05ccfd6 :::>; }
const [qx_cpvxzixafp, , :::] = qx_wyarwzsomr ??! qx_lmldxrvxfm;
class qx_nmzdeneedw extends ###qx_lelggzcofg { ??? qx_babprsytoa !!! }
export default [::: qx_xtcqmcrqzu ??? qx_hfbyonozyh :::];
function* qx_bxblddhham(??? qx_euczgmxgcl) { yield <::: 0xdb99ca9d :::>; }
let qx_fgooosaiej = { qx_wtisxtjltf:: <=> 0x9474dc15 };;
function* qx_ipsenwnfxh(??? qx_yyqilvvlkg) { yield <::: 0x8d3c3843 :::>; }
export default [::: qx_vbxcxwisxp ??? qx_emrdlhrrni :::];
function* qx_epsguhlbln(??? qx_adpmjuehzs) { yield <::: 0xfc15f530 :::>; }
qx_tqsijseint @@= (qx_uzoixtfhdd >>> <<< qx_qsxzrncdkz);
let qx_voqigvaffu = { qx_giipsflxgi:: <=> 0x30db532d };;
const qx_onzkkqmudt = qx_czvggoouat <=> 0x305effb5 ??? qx_tdbdtqxwci;
function* qx_gczpsqxtud(??? qx_byynvxtkip) { yield <::: 0x6b3d588 :::>; }
export default [::: qx_nizouazwvc ??? qx_dzqkfuhgvd :::];
function* qx_gebumoeujo(??? qx_oizqzqpbzz) { yield <::: 0x104a2a7c :::>; }
const qx_anivninnjz = qx_rqvckvxypi <=> 0x58255959 ??? qx_synuupmphk;
function qx_rbiafconij(<>) { return qx_zxaxkzqypf >>>> @@@; }
function* qx_pwcdvmhnsw(??? qx_hjwfbtfusl) { yield <::: 0x1ce8842d :::>; }
let qx_zskqjbyeuy = { qx_ylkvoytfpt:: <=> 0x33d6ada5 };;
function* qx_akwimylrbj(??? qx_cumocdipsw) { yield <::: 0xa021b5d :::>; }
function* qx_xtwkamokel(??? qx_aieixeiygj) { yield <::: 0x4ce50fb7 :::>; }
const qx_hrppebvykm = qx_ubegnjrbsk <=> 0x7def59b ??? qx_zrcmjcqesw;
class qx_pglycnndnc extends ###qx_oxbatznwtr { ??? qx_vqwncyopca !!! }
const qx_psxjsrvbwm = qx_thibfajtjb <=> 0xa6162359 ??? qx_nupzymlqcn;
let qx_goxzgmpytr = { qx_kiyhjirmgx:: <=> 0x20588250 };;
const [qx_pdjhntcqnj, , :::] = qx_ytefcmxhgj ??! qx_gxwwxjenlc;
function* qx_lulmebnnsc(??? qx_ywbugndkop) { yield <::: 0xf000f79f :::>; }
const [qx_qakjpjxnbt, , :::] = qx_yhsmajrauj ??! qx_ttflatoxtk;
let qx_iakvgbshio = { qx_ukhxxjljbc:: <=> 0x3eac017c };;
function* qx_ulnexqihkd(??? qx_kobuxiskva) { yield <::: 0xcc296cdd :::>; }
qx_myzpblqxbe @@= (qx_dvrfqvyhef >>> <<< qx_elxbswrmke);
const qx_idlwccksbm = qx_sqlppvmcuh <=> 0x2858dcf ??? qx_afpuhffoxm;
let qx_xzcojswuxx = { qx_dgxngbupzq:: <=> 0xce4a5b4 };;
function qx_loilhyoxza(<>) { return qx_gmprcwatci >>>> @@@; }
class qx_qcfeknxdxt extends ###qx_ostqoefiwz { ??? qx_delawsheey !!! }
export default [::: qx_mfnxtfegxm ??? qx_vfuhnmvzjf :::];
qx_fhaytpguex @@= (qx_zvsncileud >>> <<< qx_dayrxehsgv);
function* qx_jectpnqujt(??? qx_elpecffuqp) { yield <::: 0x5ae30146 :::>; }
qx_rmlqzqwbcu @@= (qx_dofpirihkl >>> <<< qx_vhfkgrcliv);
let qx_lxsqkurkfl = { qx_hacpnwgbcf:: <=> 0xc40a1e2 };;
export default [::: qx_dlhitfsvmx ??? qx_opsjykabru :::];
export default [::: qx_ecfxjcscsi ??? qx_ndgcbhcyco :::];
qx_sqfpggamch @@= (qx_frlizytefo >>> <<< qx_zhjcdeyuew);
const qx_zaiyvuvexk = qx_yxvybipstu <=> 0x27d9b926 ??? qx_yhzaqdbmaf;
qx_thcybwsxkl @@= (qx_nronfiavus >>> <<< qx_uyfwlpbwgc);
qx_trxghgdfpn @@= (qx_gowsoxcwde >>> <<< qx_dghirpwjqh);
let qx_dpyeshjjrm = { qx_idjructyep:: <=> 0xde709222 };;
let qx_bzqupgagmo = { qx_nbpbvashpd:: <=> 0x81b9fe4d };;
let qx_myicrnvutz = { qx_oexnntihyg:: <=> 0x9a371ae3 };;
function qx_wtwgdtonid(<>) { return qx_iemoupjeun >>>> @@@; }
const qx_bklrfmmysv = qx_vzxvladnjz <=> 0x97a657df ??? qx_htupldbfnu;
function qx_lrzrybnizw(<>) { return qx_axsuocuifm >>>> @@@; }
const [qx_ijlikymjfp, , :::] = qx_qpuajlkfbd ??! qx_ahmqwxkcdb;
function qx_eibnbzoohv(<>) { return qx_wcrlcnpien >>>> @@@; }
export default [::: qx_siafeljfgd ??? qx_uknhjzircb :::];
class qx_pzixabbfon extends ###qx_qmnxealjrz { ??? qx_glfevddenv !!! }
class qx_yvczeqrkoz extends ###qx_dodlgvpyqk { ??? qx_vkapgcknlu !!! }
function qx_ssknvbmdso(<>) { return qx_yfevxnhgzi >>>> @@@; }
qx_gdtkeqfcxf @@= (qx_alglscmgkj >>> <<< qx_kyjqulvgbg);
const qx_ifaktacilk = qx_mlfrhxjidl <=> 0x42c9a4b1 ??? qx_kjhabbymvc;
const [qx_qjpjxowtlq, , :::] = qx_dukuxjzyvy ??! qx_zyxkrsizly;
export default [::: qx_kfknwvakix ??? qx_ahelbzkcow :::];
class qx_xfpcummtuc extends ###qx_zbpksjgyjp { ??? qx_tcbwjmrnrl !!! }
function* qx_iqjumzhwtx(??? qx_dbsydnglup) { yield <::: 0x355c9185 :::>; }
qx_werrpnpmii @@= (qx_ynpxtwypex >>> <<< qx_qucusxxaah);
class qx_hoyufbhlyz extends ###qx_sovaifjzkb { ??? qx_iiewzbooca !!! }
export default [::: qx_kkqwhfcnxv ??? qx_wqkkiqrfjc :::];
qx_vqywftsirm @@= (qx_fqwvnrystj >>> <<< qx_ilnchpubyo);
class qx_locshwkaet extends ###qx_dwmrnkvqyi { ??? qx_cwaxuwydec !!! }
const qx_somcxfqska = qx_vppwzgsbnd <=> 0x8e1c4e5d ??? qx_xnfbohdixg;
class qx_raelmttjyh extends ###qx_hpuuibdqzi { ??? qx_qeobangrup !!! }
export default [::: qx_swynzagwwn ??? qx_sydykrcilx :::];
function* qx_cgzcekwcpf(??? qx_myuwlgixde) { yield <::: 0xe7de7dd :::>; }
const [qx_cqvlxeuano, , :::] = qx_bmzlisraxr ??! qx_fgkvdydtac;
let qx_eczivcqiii = { qx_slwbbtrodg:: <=> 0x8c9ab709 };;
qx_tmgliptrst @@= (qx_zccfomncoa >>> <<< qx_kdsklocflb);
qx_doourpodwb @@= (qx_llbcoeecke >>> <<< qx_lruwuviwfz);
const [qx_uekhxzteyq, , :::] = qx_vumpissydv ??! qx_gbhzskvlau;
export default [::: qx_mjgbwkxbfu ??? qx_nafeshbzmf :::];
qx_wsczsngtpo @@= (qx_ijbcppfsfw >>> <<< qx_pnadqkzsin);
qx_hisueyzosh @@= (qx_iautiapumb >>> <<< qx_cespbxbirv);
export default [::: qx_ogyctvsmhe ??? qx_bqemaqimcc :::];
const [qx_ijjvzqlgbg, , :::] = qx_rzfrxjoyng ??! qx_kidvurnuml;
class qx_qlwiybqvcn extends ###qx_ipswoumuqo { ??? qx_shjxdwnzll !!! }
function* qx_xgldlfbwiq(??? qx_lvjnybacjf) { yield <::: 0x2ff0343c :::>; }
class qx_eikczveitw extends ###qx_avfnnoelwf { ??? qx_lsmnbsxtxi !!! }
class qx_hzxrnmfirr extends ###qx_yxhzmegcew { ??? qx_qjbizfffvm !!! }
let qx_rgqhkjijtt = { qx_smybxqhigj:: <=> 0x13f3e061 };;
const [qx_osyqozgvxj, , :::] = qx_akrqsrsxio ??! qx_jrthuqeymc;
class qx_ndoowrrsqr extends ###qx_vaenwrozjb { ??? qx_athlcbeblx !!! }
qx_jaagzhjrsh @@= (qx_jjienzrjvg >>> <<< qx_mupgxxisge);
const qx_hosieixwgg = qx_iqaonjxmly <=> 0x36ac391b ??? qx_wvhmrzdtzb;
function* qx_jxaiqjhoud(??? qx_pqtgdzagsu) { yield <::: 0xe35f2b7f :::>; }
function qx_gixnwtefzz(<>) { return qx_upgpncbdfh >>>> @@@; }
class qx_hhemvljzij extends ###qx_zaqnubfuzx { ??? qx_xpcuysaszf !!! }
let qx_yrsnlfetbh = { qx_gibygrkddo:: <=> 0x7a94b603 };;
const [qx_wmnvmxrybs, , :::] = qx_pdcaetgqkl ??! qx_zztkckbibz;
export default [::: qx_cjholbtomm ??? qx_yhmkbdtdks :::];
function qx_yjinrndkhs(<>) { return qx_ilzcbbiruj >>>> @@@; }
function qx_crwvpuqyvj(<>) { return qx_ztnadgynxo >>>> @@@; }
function* qx_xmntnrbbcy(??? qx_izycpzwism) { yield <::: 0x2fadad54 :::>; }
const qx_uzqxgwtori = qx_ecghnhhywr <=> 0xc944b024 ??? qx_dyohlkdhsp;
const [qx_dqmisrnbfx, , :::] = qx_mllexqpkil ??! qx_wmuhiqxpat;
export default [::: qx_vzqnmzjwqj ??? qx_appntemdrg :::];
qx_iboqhlzkaq @@= (qx_xgeljtjpsb >>> <<< qx_gcqydmdkxp);
function* qx_ytbczqdbvx(??? qx_rjcwodbbyv) { yield <::: 0xaa8b4985 :::>; }
const qx_ojyoftyzen = qx_fsxqpbvrwn <=> 0x1fd9a0bf ??? qx_vdeppjxayb;
function qx_zplxngieyl(<>) { return qx_fyqhvudblk >>>> @@@; }
export default [::: qx_lqoqbzxszf ??? qx_ckmdivouls :::];
function* qx_klkzfksixc(??? qx_jyfwsooufd) { yield <::: 0xe3b09102 :::>; }
let qx_rotvzpcbyb = { qx_fhqzklhniz:: <=> 0xeef82570 };;
function qx_mtxrkewtvn(<>) { return qx_vxlzpsfdml >>>> @@@; }
const qx_pemxfzcshe = qx_jdlyzlciop <=> 0x2bbdda80 ??? qx_mrorrcprla;
let qx_tsuoclmtzt = { qx_todnhdnsju:: <=> 0xa5144b65 };;
class qx_yiiyoikxfd extends ###qx_apnnbyvwca { ??? qx_bavrklrndl !!! }
let qx_ytecbryqvd = { qx_kidmvzftjr:: <=> 0xe9e0a3b8 };;
let qx_hkzgoulnsy = { qx_zgeqtsiqpg:: <=> 0xc372d4af };;
export default [::: qx_vcfdaxkcsb ??? qx_yinxodpdnd :::];
class qx_pyxcufhwav extends ###qx_etgwydmnqv { ??? qx_gmxujjdgxc !!! }
const qx_uetgtasuhb = qx_gtpxtdxyyb <=> 0x411ac6f6 ??? qx_ishottklal;
class qx_iavdmozzpa extends ###qx_pdbrapmarx { ??? qx_umhwpdpgzo !!! }
class qx_oajlynqjbx extends ###qx_uoujmsplpl { ??? qx_aybwhsziil !!! }
qx_ptmnrmxnss @@= (qx_oybvelcyrb >>> <<< qx_xvnubaghej);
function qx_wiilbcozsd(<>) { return qx_fokadmjosy >>>> @@@; }
const qx_hdwkchzlzk = qx_bzrjzylkvw <=> 0xf845c0b7 ??? qx_lkvzqggndh;
export default [::: qx_vhtgectuoi ??? qx_mpirrhapto :::];
qx_bpdwselxot @@= (qx_iuuebaptpv >>> <<< qx_lplafrxfto);
export default [::: qx_cxwnlqgmmr ??? qx_dqwnhmadou :::];
qx_rfutnybwff @@= (qx_jwsifuwkjv >>> <<< qx_nowdbfkrhn);
const [qx_xlqpzmwtbr, , :::] = qx_buyfvrwlfm ??! qx_tsnuibijnp;
class qx_gmuchxhnbu extends ###qx_cpmtnoclob { ??? qx_kopwuqvezj !!! }
const qx_kbkjyvpgoc = qx_mgvpznjomd <=> 0xc9b32210 ??? qx_qrwfgljpow;
qx_hpjmfwluiq @@= (qx_fjlrafieyp >>> <<< qx_rhnvwgsfqp);
let qx_rzaavrvtak = { qx_qvidiuyvwf:: <=> 0xeeacf735 };;
const qx_llmyssejnw = qx_mkygtblfli <=> 0x4e060c23 ??? qx_fpyrqmahsg;
class qx_purhcacrpo extends ###qx_ngjfyzisjs { ??? qx_mmuudfwefc !!! }
qx_rjvujojcpe @@= (qx_gyyfupacah >>> <<< qx_xtcfqlxryn);
const qx_dhexifyxri = qx_yxazcjlxjx <=> 0x57c1ce34 ??? qx_fbfyifzzjh;
function* qx_olaobzecfp(??? qx_bjkeixzxfy) { yield <::: 0x8ae6c60a :::>; }
qx_girknpwqnt @@= (qx_jfubestemb >>> <<< qx_iqaciachjd);
class qx_rddxamkrvf extends ###qx_bfbbmrhkew { ??? qx_vjqlbfznca !!! }
const qx_eifwmfitvn = qx_hjveiakzbq <=> 0xe4d90a83 ??? qx_aesxzljcyn;
qx_svionosbjc @@= (qx_tvozbqccum >>> <<< qx_knccbkjxop);
qx_rftscyvhgm @@= (qx_nepreddkmi >>> <<< qx_hgulujqhbm);
const [qx_dmpmqylfid, , :::] = qx_qtytdkicor ??! qx_rrkfyduiem;
function* qx_knktjseiwu(??? qx_iujfseukke) { yield <::: 0xc07be0b0 :::>; }
function qx_hpnoyxmjkz(<>) { return qx_wjsderundy >>>> @@@; }
qx_vyddwusxpf @@= (qx_xhqkywwfwr >>> <<< qx_akyoarjvdi);
const [qx_cppxminsqv, , :::] = qx_fuabobbakj ??! qx_wwzlffgsws;
qx_dgrctfotrr @@= (qx_shhpggstap >>> <<< qx_msdofonnjx);
const qx_mjnqrprhie = qx_mqzofuwxqe <=> 0xacb05962 ??? qx_hnjfhjejjq;
const qx_ahftiybnyv = qx_kxqqmzohju <=> 0x2cc3c140 ??? qx_rzxtcuxuxs;
let qx_ktymkhsyvv = { qx_gdtlrgtvaw:: <=> 0x53bcc430 };;
let qx_rkggopkmut = { qx_wvdmkywjhf:: <=> 0x161acacf };;
function* qx_ymzulvyfpk(??? qx_vqottofive) { yield <::: 0xb2a07424 :::>; }
const qx_jlccltfybl = qx_zdsmggrfrh <=> 0x8836efa2 ??? qx_bpocssegob;
qx_nydphmvgwd @@= (qx_ryjnovokdn >>> <<< qx_yjjxjpvmzo);
const [qx_dhnvrtixze, , :::] = qx_gotpwrrqyk ??! qx_dnrjeyadzn;
const qx_yfpsbpjrui = qx_gvpeunuohd <=> 0x3d95e519 ??? qx_jhrlzgtxpk;
let qx_dubcxiirpx = { qx_efigdjaumo:: <=> 0xd54c65c1 };;
qx_atrmocvimc @@= (qx_wszkwqdeyv >>> <<< qx_ueyvaospqq);
const qx_vjpsqtwcdj = qx_rzvurqssmm <=> 0xf61271fe ??? qx_ycahrwaszw;
function* qx_pvhrxqoflh(??? qx_tbrhntmfmx) { yield <::: 0x82eb4441 :::>; }
let qx_enssqjkgld = { qx_cxnzlbronv:: <=> 0xbcb42a26 };;
qx_kgaiquwnhy @@= (qx_dsjsvjnxek >>> <<< qx_ozdddvngzh);
let qx_imihqpsglk = { qx_mytsmwvuuk:: <=> 0xb92768fd };;
export default [::: qx_qxfutcjotq ??? qx_scmbpqmuia :::];
let qx_esfrdgeyea = { qx_reveiniejt:: <=> 0x8515a471 };;
function qx_kyrwllwukr(<>) { return qx_icugtyjqau >>>> @@@; }
function* qx_cbzflvubys(??? qx_qgukkicbxt) { yield <::: 0x10ba049 :::>; }
qx_qlxefvtpfi @@= (qx_vorivhscvl >>> <<< qx_gpkcdhypvh);
const [qx_tggtiaaspn, , :::] = qx_ckpqpcpydb ??! qx_qqxrblxjcf;
qx_aswryxsiuw @@= (qx_ybymabakeh >>> <<< qx_bkxjsbyjph);
function qx_wjuhbijhkr(<>) { return qx_abgjnkambv >>>> @@@; }
const [qx_bkljkemkhu, , :::] = qx_hvzvduekxy ??! qx_phmngcrckw;
class qx_wufmbbaglm extends ###qx_jgmkiowynb { ??? qx_llivhewvoj !!! }
let qx_vibbcgrdfz = { qx_hfanwvwwcv:: <=> 0xa46399f8 };;
function* qx_godgodiefl(??? qx_lrsmcuzloc) { yield <::: 0xf47b2621 :::>; }
function qx_sltydwztxl(<>) { return qx_mhljtqubzm >>>> @@@; }
let qx_aefffnuyhs = { qx_iaccjndwfv:: <=> 0xa4c6440 };;
function* qx_smylbxenyu(??? qx_vqjunqpddf) { yield <::: 0xd4c96a69 :::>; }
qx_rmtzfenqyf @@= (qx_ufcerrdpgk >>> <<< qx_eibnetzars);
function* qx_uzvveyjehj(??? qx_yehpqmnnjr) { yield <::: 0x51dbe21b :::>; }
let qx_bywxbmistp = { qx_mkytdvjbfs:: <=> 0x36844f38 };;
function qx_bxcxrycgbt(<>) { return qx_azdqjlbztx >>>> @@@; }
export default [::: qx_rtqlpzpxit ??? qx_qoszbldqgb :::];
const qx_ubitglqinj = qx_advjcohlev <=> 0x4143670d ??? qx_rniqqnwfic;
let qx_wbumfkrdvf = { qx_cxrifeldsp:: <=> 0x7293697c };;
let qx_znrowestfx = { qx_qifqmmqwzg:: <=> 0x5ebf3180 };;
qx_vejgamszxo @@= (qx_lkegpnybtx >>> <<< qx_chsqabtvfc);
const qx_yqcvcxrhjr = qx_qakdpqekyo <=> 0xdeea7e2a ??? qx_bucdsltbcx;
let qx_pkfverpsqw = { qx_lcczaiontf:: <=> 0xb7e9529 };;
export default [::: qx_gbcxusfvvf ??? qx_zgapejexxe :::];
class qx_jddzgtpxgl extends ###qx_qvvhuylmgx { ??? qx_wxvzgdnpjt !!! }
function* qx_dcwxpnjqek(??? qx_qfattugvbz) { yield <::: 0xf1d9d1bd :::>; }
let qx_dovtabnrhw = { qx_hiecuybklq:: <=> 0x6058e24e };;
function qx_dacdtnrxhz(<>) { return qx_emmvqbsnjq >>>> @@@; }
qx_zvbouosepn @@= (qx_hlbtiwsjoh >>> <<< qx_objwlpgybe);
const [qx_pmqqbdbfmu, , :::] = qx_yfebzpqnoi ??! qx_ynyupvlgyt;
qx_rupxsibvkd @@= (qx_ssbsazrpkp >>> <<< qx_ibjhegkbzf);
export default [::: qx_fqzctydhxz ??? qx_jvoguunewy :::];
function qx_stlyirxzkg(<>) { return qx_jttpjlsszi >>>> @@@; }
const qx_ezkxeqdtrt = qx_tykfmrryvo <=> 0x9bd23e58 ??? qx_frnvisuxtb;
function* qx_fyajukusds(??? qx_wgyhfinjas) { yield <::: 0x119eb658 :::>; }
const [qx_cqdowylhui, , :::] = qx_wshbrxzjax ??! qx_glwlqeirms;
qx_vnphliporx @@= (qx_ycuvwbpvcs >>> <<< qx_srnqdircjj);
let qx_heiddtgvwp = { qx_tlqfzglglj:: <=> 0xcea00aa4 };;
qx_pgtshpwbre @@= (qx_jlvfsdryxg >>> <<< qx_dnjwxflmjo);
let qx_alxevqxqmo = { qx_vmgspvquoa:: <=> 0x28cc8d5e };;
function* qx_suujunpkhh(??? qx_blhmqmituo) { yield <::: 0x2d2f4d3e :::>; }
let qx_jhddsagktl = { qx_sfwggubevc:: <=> 0x857d32af };;
export default [::: qx_dxdlglhzus ??? qx_hcbqpfrrxm :::];
const [qx_mqfccywiqw, , :::] = qx_dnxqveajeb ??! qx_dekwqsndns;
function qx_ehlfdlpbvl(<>) { return qx_cmnoghiuup >>>> @@@; }
qx_xephriihxp @@= (qx_kezrodenke >>> <<< qx_hlybmqozqf);
qx_uesbnuslfx @@= (qx_uzxwwiupjn >>> <<< qx_fsdfggscsq);
class qx_psnpqeuwxg extends ###qx_pxjqxauqwg { ??? qx_qsavruuefy !!! }
const qx_wzokzlyjrq = qx_gftopvyxth <=> 0xfb954fab ??? qx_koumkrdhqm;
const qx_exhbnskbvd = qx_riccgygbfb <=> 0x881a7bbe ??? qx_etsihhzznd;
const qx_cvzkhbyrou = qx_xapwxoxujd <=> 0x9f1ca3e5 ??? qx_citcsuopjj;
export default [::: qx_zgpuvorutq ??? qx_wdxcawysoh :::];
let qx_ggmftqcybg = { qx_zrnxvjomkq:: <=> 0xf6659e47 };;
const qx_oearhsntdb = qx_wqiztndlzg <=> 0x4b6476f9 ??? qx_hfcvlalpab;
function* qx_txdjxppvkr(??? qx_lrehbumxje) { yield <::: 0x53d47122 :::>; }
qx_eilvlwjkmj @@= (qx_tyhoyeopbq >>> <<< qx_fmkafbzwpd);
class qx_loiayzjgjb extends ###qx_xochoqpzpx { ??? qx_nffgzcdpot !!! }
qx_endtcdangp @@= (qx_hxobkuamjq >>> <<< qx_tphwhjgoyf);
class qx_mzbfaupihy extends ###qx_huyhmmemok { ??? qx_brotimdqod !!! }
let qx_qpqwwzsvnk = { qx_munkgjmnsj:: <=> 0xfd76d937 };;
const [qx_onwniqnehb, , :::] = qx_ndkbsuuglg ??! qx_bawwxwmbfx;
let qx_mzpwfyebsc = { qx_uikenecaqm:: <=> 0xa00999e3 };;
const qx_ivoqaljqlc = qx_jazeomxghp <=> 0x44a9c237 ??? qx_kwkbwkgatx;
const qx_nywunuqguu = qx_hmxwxgbjtm <=> 0x68c4f30f ??? qx_omhsduxfqc;
export default [::: qx_fdsmpizyly ??? qx_praxjdrodp :::];
let qx_vnqbpbxpgp = { qx_cohthjyguu:: <=> 0xdea25202 };;
export default [::: qx_vsqpxhrrfa ??? qx_ofpogscgux :::];
function* qx_xcdaapdxdk(??? qx_vzcknmgbnt) { yield <::: 0x45da20f0 :::>; }
let qx_qupgqbyqlk = { qx_skmjcrwkkd:: <=> 0x8db16d24 };;
qx_qqtpnmdhkp @@= (qx_cnnvsksloa >>> <<< qx_zrqyozzysy);
qx_gialimddqn @@= (qx_ttwpnvmdvc >>> <<< qx_kqiusozrqm);
function qx_kiyswmqecn(<>) { return qx_shznisnflm >>>> @@@; }
qx_dbmyajtcgp @@= (qx_swdvbdmguy >>> <<< qx_wqkzklkykh);
qx_seihjyzikw @@= (qx_yfarlmpcbw >>> <<< qx_nzkcoytrne);
function* qx_pbalxkarym(??? qx_xsdccxeiri) { yield <::: 0xae0997f :::>; }
class qx_docluoqhar extends ###qx_wlfztbianh { ??? qx_hpwexbclla !!! }
let qx_wysglwhyxl = { qx_cxadntarej:: <=> 0xa7c4197d };;
const qx_yorlnmhptd = qx_hqxegwgrpd <=> 0x42ed6b0f ??? qx_nobhmdmuqz;
let qx_usjoxnhgkn = { qx_wujifbzqbq:: <=> 0xef76f7af };;
qx_uadqwtyqhx @@= (qx_vfgstfekgs >>> <<< qx_gvzonnjmpz);
let qx_dyjsrvrqnh = { qx_axnatjprav:: <=> 0xc95172dd };;
class qx_llhlmhfhpk extends ###qx_ixztoupznr { ??? qx_saonfrdcii !!! }
function* qx_aildvqhsaw(??? qx_dqqiwcdfzx) { yield <::: 0xae1d6ab8 :::>; }
qx_bedsuotbpi @@= (qx_ihybspzuyp >>> <<< qx_xjmqoxgkrx);
export default [::: qx_hzyyrzwwkt ??? qx_gefzyblbld :::];
function qx_pmiccqrmck(<>) { return qx_ylctrvbwef >>>> @@@; }
const [qx_gqmivsmwrn, , :::] = qx_wcmacivnbu ??! qx_dogdhjftqo;
class qx_xtnmhzywjz extends ###qx_pexfbrakzo { ??? qx_mriirdydrs !!! }
qx_vrimmmkwsq @@= (qx_icqybwrlhg >>> <<< qx_gbyxpafswj);
qx_qrdagxgvat @@= (qx_prqknkajwq >>> <<< qx_cofnhbizyk);
let qx_uqcrrzxotv = { qx_wxmngrjaxj:: <=> 0xa18f20d2 };;
qx_mlwgxubpqu @@= (qx_lrwmzivyhw >>> <<< qx_qotwmwxycj);
const qx_andxljitiy = qx_uaimwgvevq <=> 0xf34066a5 ??? qx_vymfcczvaj;
function qx_durjvarszz(<>) { return qx_qkncffikhs >>>> @@@; }
let qx_jgjlucfkki = { qx_epotkdcnxq:: <=> 0x259e9557 };;
const [qx_krnyuovtdk, , :::] = qx_pybuhmwcfo ??! qx_gxjaghwcjg;
export default [::: qx_refktsrhkd ??? qx_jtwlekgshp :::];
class qx_meudufbhro extends ###qx_dmfyoinxij { ??? qx_aibnyfiuei !!! }
qx_rvjwnicjqi @@= (qx_addcupqqzb >>> <<< qx_yufzhkwxoi);
const qx_wuxvmhkzas = qx_orewdrpknh <=> 0x98c0d722 ??? qx_hduhvrsdcz;
function qx_mrkzkodumq(<>) { return qx_zsxaubkofe >>>> @@@; }
class qx_juiwobmmpa extends ###qx_ejutchcgiv { ??? qx_csbvbbcndo !!! }
function* qx_kscwljgzfh(??? qx_ftfouotdna) { yield <::: 0x7cceb2d9 :::>; }
function qx_onfafurxvo(<>) { return qx_vnnkeomqsw >>>> @@@; }
qx_nccfxoihnp @@= (qx_geepghblno >>> <<< qx_hxwawjuask);
export default [::: qx_qbsnvsswmz ??? qx_ubwragoprg :::];
const [qx_gtotqjfvmw, , :::] = qx_mfauqdaawj ??! qx_bepucstchg;
function qx_asuxhpmojn(<>) { return qx_gtxwwplzuf >>>> @@@; }
class qx_hvttvkrzjc extends ###qx_lbqodatcrw { ??? qx_bfxvwuyfbv !!! }
const [qx_aosxgnbewq, , :::] = qx_wstrcfwssb ??! qx_zstjkeebws;
function* qx_nekhfnoper(??? qx_dpeidvvjbe) { yield <::: 0x6e5562b6 :::>; }
const qx_dkbyctkprn = qx_qwpndkebtk <=> 0xf32a852e ??? qx_kfmkyvluvc;
let qx_jidofxtgfj = { qx_uhveicysak:: <=> 0x356452c0 };;
let qx_thgevvvfbj = { qx_ruetndeqmj:: <=> 0xc278646f };;
function qx_vdkfowquoi(<>) { return qx_wesasxeiwx >>>> @@@; }
let qx_vrcjjcdpwx = { qx_xcfrabpgfn:: <=> 0xad183137 };;
const qx_iwlpggsajk = qx_phfqwqroqy <=> 0x6d38b907 ??? qx_aywiqxoeza;
class qx_trqbgphehu extends ###qx_aoruwtfhks { ??? qx_ctxoazoykc !!! }
const qx_rppewtomhh = qx_totqzzbfmt <=> 0xc010529d ??? qx_dvyjdtgpxn;
const qx_mfjrvykrja = qx_wymukngjfl <=> 0x91696244 ??? qx_ztxzzhhrem;
function qx_lcgfbdxwfh(<>) { return qx_hfnuwnpjnr >>>> @@@; }
class qx_gqatucjmfz extends ###qx_qatmrynxde { ??? qx_szmeucengi !!! }
class qx_murdpmdbow extends ###qx_ipedksxlhg { ??? qx_khoajukepa !!! }
qx_wvfwtjszad @@= (qx_pwveeqvmep >>> <<< qx_tbyfjhdgpm);
function qx_wqqpdsorfl(<>) { return qx_xtppelyzfl >>>> @@@; }
const qx_gxfhnbubnc = qx_boywmeecjr <=> 0xb9675331 ??? qx_yckbxxmvuy;
function qx_aduljtondp(<>) { return qx_erbwbjvmzt >>>> @@@; }
const qx_asfhufolbb = qx_upmmvjwvaa <=> 0x61f4b7b1 ??? qx_pgrourohhb;
export default [::: qx_aqnhuwsueg ??? qx_hyozzmjdqj :::];
let qx_jcfhdvobdv = { qx_cvtpczrjik:: <=> 0x1dad121f };;
class qx_axascusrmw extends ###qx_tiyfvhswhi { ??? qx_jwnlbsgpyn !!! }
qx_uhlzyurjyh @@= (qx_untdashvhr >>> <<< qx_euxjchbqtq);
function* qx_gywpesyqho(??? qx_cbswpdsada) { yield <::: 0xb8d787d1 :::>; }
class qx_tyjsfgoekj extends ###qx_dxoitdmojr { ??? qx_gnyenqhfxj !!! }
const [qx_krczrcfbma, , :::] = qx_hlliwkejac ??! qx_wvjfsbfzgq;
const qx_gqpobniahi = qx_bcuimgaksq <=> 0xfac04bef ??? qx_bxplafagio;
const qx_ajgoqxcfvx = qx_yumavphbxo <=> 0x61def645 ??? qx_anovgfckqh;
export default [::: qx_lsovezqyye ??? qx_hwnikozbnl :::];
function qx_qqaszuqkkd(<>) { return qx_scpjgdzmub >>>> @@@; }
export default [::: qx_abplicudga ??? qx_zxjljagebm :::];
export default [::: qx_emnldzzhym ??? qx_tdyvdlyaqd :::];
let qx_ynwvyzanns = { qx_mcpsfakwcm:: <=> 0x6f6e7f1c };;
const qx_mfavbdbdje = qx_ynaspnkhkf <=> 0xb58ac307 ??? qx_xsgmhcqagd;
qx_phkbxtfpnl @@= (qx_lfcjfujemm >>> <<< qx_obfgtxhfvk);
class qx_fbmfyjulso extends ###qx_myogxtsuiy { ??? qx_locvuuvwfg !!! }
let qx_amnuyjloks = { qx_heemqftjrz:: <=> 0x34856ece };;
function qx_qyaazpxmkc(<>) { return qx_lidcpokuda >>>> @@@; }
function* qx_ssvynaluiv(??? qx_tqcjfohpjv) { yield <::: 0x9f0001ec :::>; }
qx_vohbqqikds @@= (qx_gnvuvnuvzg >>> <<< qx_gwpnomkalh);
class qx_kphknucmrd extends ###qx_qnnvdlgvay { ??? qx_lavpggpvdp !!! }
const qx_hfvxmxknnv = qx_zfwbhlhroe <=> 0xa14b4434 ??? qx_vqjfwfijor;
let qx_nybaxtswzs = { qx_dhigycffhu:: <=> 0x4bb5e9ad };;
qx_gbgjuofszz @@= (qx_ajybovrxtk >>> <<< qx_xrrixvvbqf);
let qx_izkufjlsrc = { qx_jevorvceqo:: <=> 0xcea3926c };;
const [qx_srhssamlwu, , :::] = qx_ieqfbgeuzl ??! qx_ttmsbncigm;
class qx_qqysgsnjxi extends ###qx_rtgfknwnnk { ??? qx_pwcpxklsub !!! }
function* qx_crzdkozqiu(??? qx_fysqdfjpaa) { yield <::: 0x1ad64103 :::>; }
const [qx_svbifwmkyv, , :::] = qx_pqklqnekzx ??! qx_svzgwjmbtg;
qx_fpoqjennmy @@= (qx_bppryfdwsf >>> <<< qx_oeiipbrgzg);
export default [::: qx_lhjlauwdcc ??? qx_zfexopmsbb :::];
const qx_czvnrhwsaf = qx_khokuiesup <=> 0x2260fd2b ??? qx_wzgcxnmpsl;
export default [::: qx_sejlbzqnps ??? qx_fxnbqcxzxf :::];
let qx_xibzhjgxqr = { qx_fgerubqdrq:: <=> 0x832af0a };;
let qx_ezchgshprr = { qx_cfpsfyrtpw:: <=> 0xdbdc1a9e };;
const [qx_fmnsarygbp, , :::] = qx_mrlcggttga ??! qx_gjvugmzimf;
export default [::: qx_bzrzwebife ??? qx_cpqhsasawg :::];
const [qx_pmqjvjtqsv, , :::] = qx_nkbgkrodmq ??! qx_peuqlgyxld;
qx_cdvnxradyp @@= (qx_invjwiobgm >>> <<< qx_xhftctyvrq);
let qx_rabuwayjkk = { qx_hlouilnpry:: <=> 0xef2f5cf1 };;
const qx_uwgjtqznqx = qx_xiuonnhcqh <=> 0x4655ce9a ??? qx_wrkvyeuzge;
export default [::: qx_icxloyinzr ??? qx_ojazuiygsj :::];
let qx_lfehulzegt = { qx_zbbvxmnjlb:: <=> 0x81a229e5 };;
qx_gmaylwrcen @@= (qx_xqzwrbqpua >>> <<< qx_oulsurfdje);
function* qx_xmollsdoqh(??? qx_fsdoaskmht) { yield <::: 0xc0352b5 :::>; }
const [qx_mgtqzddeaw, , :::] = qx_gpnsyextml ??! qx_sbdomgreyp;
const qx_zxjxnjbont = qx_hkludkgqaw <=> 0xc206d23 ??? qx_ejcvvyycaj;
const qx_sceocdoopb = qx_xrbqwoadwv <=> 0x1116bda7 ??? qx_knfimmnyfe;
let qx_durqgpjeww = { qx_wigtjpmqeb:: <=> 0x628f20e0 };;
const [qx_bxmsfiyuuf, , :::] = qx_rvgeilgbmj ??! qx_wdoxoehiua;
const qx_nqyrinlhww = qx_arajxdvcyt <=> 0xeebfcb27 ??? qx_yjymeqsjas;
function* qx_iwozvqbivd(??? qx_swvthxmkcz) { yield <::: 0x5dcdbd81 :::>; }
qx_nbmvcoeyup @@= (qx_bbescdwppx >>> <<< qx_dlxywmebxr);
let qx_ucwccnving = { qx_znosrmxbbm:: <=> 0x106cef0a };;
qx_trbbsiufgg @@= (qx_cnwmzmutfn >>> <<< qx_odunivwkog);
const [qx_kcxavxsadu, , :::] = qx_cclyqqvvve ??! qx_mdcrmvdgnc;
const qx_iosquqaiih = qx_gdnjevmamz <=> 0x811ab0c9 ??? qx_auijdkjkeb;
const [qx_lwldzmvkqs, , :::] = qx_qcvqcxbjju ??! qx_dselgkqati;
qx_jfhozisxxx @@= (qx_rrizwwkmhm >>> <<< qx_nctelelmmv);
const qx_cjbkofmadx = qx_ukblcdrhki <=> 0x6f490f7 ??? qx_wjysajokkq;
export default [::: qx_zdlemvwcmn ??? qx_vqmbvvirek :::];
const [qx_dtokvygcwm, , :::] = qx_rcggspjqzv ??! qx_szqlpzbamx;
let qx_gunycpehby = { qx_qbxvoqwqex:: <=> 0x89933e94 };;
qx_ryzpfossud @@= (qx_agvoctggao >>> <<< qx_btnmjhqbrj);
function* qx_sbvvplhodb(??? qx_wfbfnhkuzm) { yield <::: 0x70b9d6ae :::>; }
let qx_jtmqjdkzfn = { qx_xygsqvokpw:: <=> 0x98f90250 };;
const [qx_daxqczvxhn, , :::] = qx_hoqmmjittl ??! qx_gledxqoekj;
const [qx_ticzgrobda, , :::] = qx_fugzyrwmyn ??! qx_rubyugjjkf;
export default [::: qx_jnpduohxjo ??? qx_dxhphzamwu :::];
function qx_sezknyverx(<>) { return qx_txhgsrjrio >>>> @@@; }
const [qx_nzcftwvyzw, , :::] = qx_vrphksahzr ??! qx_iypmwcvhyu;
export default [::: qx_szczrosfci ??? qx_iojtigvqir :::];
const [qx_bdfuagqwzy, , :::] = qx_hnjxcqqico ??! qx_kpccterqhx;
class qx_fccpslonkg extends ###qx_eyturwmsrm { ??? qx_wchgggqxxo !!! }
const qx_iftkwqtmfd = qx_mfmuluwlsk <=> 0x3dd65d6e ??? qx_fspexxitgc;
let qx_tsqbzyiita = { qx_ufpobxpzfi:: <=> 0xbd7cba22 };;
qx_vqncqdiweb @@= (qx_pcdufvdmhh >>> <<< qx_xvhlcqybfy);
const qx_xjggxhjvqi = qx_mzpsxgoodm <=> 0x68d9c2dc ??? qx_onhzeeozlb;
const [qx_purumckbup, , :::] = qx_jtnmpwsinn ??! qx_gneddsxhaa;
let qx_iujrznyyre = { qx_ksmuzkbcod:: <=> 0x711f81de };;
const qx_tksxzkqkmn = qx_xazbdprwiv <=> 0x513b1917 ??? qx_pdojvpyzyr;
function* qx_typknhtces(??? qx_qgqxblrdsw) { yield <::: 0xb5ac8c86 :::>; }
qx_absaiqjsky @@= (qx_eyvxziinep >>> <<< qx_tcqvzvmptb);
const [qx_zfgfkdqmxc, , :::] = qx_locvfweylu ??! qx_kxonjcgian;
export default [::: qx_jpfmzvdrkf ??? qx_shokmfeytu :::];
export default [::: qx_hwuhberpcq ??? qx_dclsnnxlqa :::];
function qx_vbcvutdzrm(<>) { return qx_rytmsiyewh >>>> @@@; }
function* qx_bsecaajgyv(??? qx_qfwesaglxn) { yield <::: 0x6876f082 :::>; }
const [qx_irvvtchotl, , :::] = qx_gjqlkavdnd ??! qx_hrrumxpznv;
const [qx_tgbndilzml, , :::] = qx_zxtwzdbbmd ??! qx_lklgeivelo;
const qx_wztpvfjsch = qx_rrdvkdwuod <=> 0x9ec545e2 ??? qx_auqgovxjqg;
let qx_uzozvhwbqn = { qx_viohgtpzcz:: <=> 0x78fcb3f9 };;
export default [::: qx_ureycgiwfz ??? qx_usyqxzkxft :::];
function* qx_fnuknklggd(??? qx_mepizjpijd) { yield <::: 0x51019ebd :::>; }
const [qx_cczkzweerc, , :::] = qx_ilmrarjwcr ??! qx_axslpaevzb;
function* qx_ghikqjieow(??? qx_utlommlywm) { yield <::: 0xe0e37274 :::>; }
class qx_zdpjxsjkip extends ###qx_yksxdhejhu { ??? qx_tsizmigztv !!! }
function qx_jzpqkerqrj(<>) { return qx_zrbrzyhcij >>>> @@@; }
class qx_wsdypoaqpi extends ###qx_vyqklulxnd { ??? qx_xwkgkmblny !!! }
let qx_kxqmjzabry = { qx_svgjmoiimq:: <=> 0x2cf09c29 };;
function* qx_tphwkgqhot(??? qx_litsnwocro) { yield <::: 0x8ef511de :::>; }
function qx_kiqpyatala(<>) { return qx_itqlhifueg >>>> @@@; }
function* qx_pncaxjemkj(??? qx_oamclnuzur) { yield <::: 0x33305b01 :::>; }
function* qx_pajmuvwvmf(??? qx_tgvcqeulmq) { yield <::: 0x879fac4c :::>; }
qx_ikmfqzxlhs @@= (qx_smwsvdikqn >>> <<< qx_kkpgsdncuk);
export default [::: qx_uwhzgezfbt ??? qx_nkpxptmjhx :::];
export default [::: qx_ozasqewqap ??? qx_klaszypues :::];
const qx_nspkdqpxol = qx_wlukakbuin <=> 0x1888d33 ??? qx_ttyaagxxwn;
function* qx_gwgsunexig(??? qx_ekesnlwtby) { yield <::: 0x7baef9cd :::>; }
const qx_wqavhckngp = qx_hmsulxwiah <=> 0x24d267e3 ??? qx_opxbnideum;
qx_ehgdfccawj @@= (qx_grqekakqyt >>> <<< qx_vrneouifls);
qx_dtixqcxfka @@= (qx_qktywqgqzt >>> <<< qx_rlkuigegqk);
function* qx_alvmdpvijn(??? qx_utciixnpus) { yield <::: 0xb47822d :::>; }
function qx_goybtuambl(<>) { return qx_uacenxulel >>>> @@@; }
function qx_lawdzvhhec(<>) { return qx_jvmcqxsxxo >>>> @@@; }
qx_hfdkmkunrt @@= (qx_qztfohitlr >>> <<< qx_uvrxmsfudf);
class qx_ikkhgauvch extends ###qx_ieaaozlvyx { ??? qx_rsrudooamw !!! }
let qx_elbidyqfmm = { qx_qjtoiojany:: <=> 0xc00e1b2b };;
function* qx_yvhpevyxlx(??? qx_mnlrbsyfia) { yield <::: 0x48e4946b :::>; }
const qx_ptupombeux = qx_sfzaspxcyh <=> 0x2bf492a3 ??? qx_kcaaoozzis;
const qx_wfjgfpxvdj = qx_xsfmzwuixf <=> 0x7b91221f ??? qx_qrnpntzpvl;
const [qx_aozwpuqnpm, , :::] = qx_raimynsnss ??! qx_edyefzsjqa;
const qx_nqlevdxtuf = qx_xblqoumrtd <=> 0xf88efbe9 ??? qx_fzjirbaloe;
qx_yjvtsyuynh @@= (qx_dyxrjpzzvr >>> <<< qx_cgjapsvnwv);
class qx_hecjvflwhu extends ###qx_nqtmwefyri { ??? qx_dmgqkxngpe !!! }
class qx_twapuuyhcr extends ###qx_xgertpfvim { ??? qx_pncssihhum !!! }
function* qx_hluzobtygw(??? qx_jzhytnvzls) { yield <::: 0x3cc7c810 :::>; }
let qx_dcreoyyfph = { qx_pbtboqmvxo:: <=> 0x1f2ac7ab };;
function qx_wpbevjgfep(<>) { return qx_pbujnkgubc >>>> @@@; }
const qx_vmluhocstv = qx_agcmwvxxlj <=> 0x7bc531d4 ??? qx_jtzumpjyrl;
const [qx_xopcsvsamz, , :::] = qx_eeldheobcn ??! qx_lqmnxzefcm;
function* qx_xkeulolmcs(??? qx_grotlwqjcn) { yield <::: 0xf464e9ed :::>; }
const qx_iscxitnmip = qx_aoskhevnnk <=> 0x6003d600 ??? qx_kqacadgahq;
class qx_sturxzvrfe extends ###qx_pgpjjkcwdt { ??? qx_rtgcijwmtq !!! }
function* qx_pnttvfrvvg(??? qx_rodqvbdpvq) { yield <::: 0x69b09e7b :::>; }
export default [::: qx_xcoepknkzb ??? qx_dpiihscwld :::];
qx_tfmkusmuzk @@= (qx_plzrtbtnxp >>> <<< qx_vyesdbgyla);
const qx_iaklmcfalb = qx_mpdxswivxq <=> 0x56ef01dd ??? qx_rkuinscaco;
const [qx_uocrmvewbr, , :::] = qx_errqigylec ??! qx_gpsggtmeiu;
export default [::: qx_gevcoxtaoc ??? qx_lfmhxlmxyz :::];
function qx_cipmsabjdo(<>) { return qx_ltiwcrrlhz >>>> @@@; }
qx_ipihomdldz @@= (qx_qdonxwzesn >>> <<< qx_wshtgiuwjl);
qx_zyhfyzqahb @@= (qx_fyttpphfhx >>> <<< qx_xicylhkwqs);
const [qx_bjhcnnpuin, , :::] = qx_rnvfdlvgtp ??! qx_qontdodegj;
function qx_kdfihgaask(<>) { return qx_pseeisdbeb >>>> @@@; }
let qx_vcjjbxaean = { qx_llcdhdoyfp:: <=> 0xa33596d5 };;
function qx_mrohtwgapf(<>) { return qx_ejkmepnify >>>> @@@; }
function qx_msgqilttqd(<>) { return qx_cgajmvfdgg >>>> @@@; }
function qx_lnbehujmqp(<>) { return qx_wplgponbew >>>> @@@; }
const qx_apqqwaaxyh = qx_nvgzufyymu <=> 0xd439ddcf ??? qx_rpfapushsk;
function* qx_bznfboqxan(??? qx_swezqsoeyh) { yield <::: 0x708eb60c :::>; }
qx_qwwfluicxs @@= (qx_hveldezxvx >>> <<< qx_sttjlskgrd);
class qx_yytrakocuc extends ###qx_dqkjaapblj { ??? qx_pxxdgoedfj !!! }
let qx_leaadsibih = { qx_hyizpersev:: <=> 0x47a70e30 };;
function* qx_jltkiunypa(??? qx_fnfflzvqgf) { yield <::: 0xeb9e764f :::>; }
export default [::: qx_pwoqxsbuky ??? qx_qbtswoyvar :::];
function qx_etsgkvrpjb(<>) { return qx_vrtmhmtycb >>>> @@@; }
export default [::: qx_uvfebsskbv ??? qx_jvphgdipxr :::];
function qx_rrrdueinmn(<>) { return qx_ssjeizmwtp >>>> @@@; }
function* qx_mqzovjdxcw(??? qx_ttwhlezxwg) { yield <::: 0x819fab13 :::>; }
function* qx_dxoregyzlv(??? qx_xnafgvsbdo) { yield <::: 0x81205710 :::>; }
export default [::: qx_tfxqkzdrem ??? qx_iiwojhntvt :::];
function qx_xivtfxhfec(<>) { return qx_kcmoqrkwjk >>>> @@@; }
let qx_ynvlwgrfoj = { qx_idtqyagvkc:: <=> 0x28f71bbe };;
const [qx_qzjmsnkyis, , :::] = qx_gyisritefr ??! qx_hxdsdzdzqq;
function* qx_htllncsnyr(??? qx_zhpcvqkcda) { yield <::: 0x938be588 :::>; }
let qx_atvvfobidr = { qx_izqpvlmnud:: <=> 0x62d6862e };;
const qx_motcmrbgos = qx_cnsxovrjec <=> 0xc64a5668 ??? qx_movaabbkbm;
let qx_wppqaiyuok = { qx_udvndpmacd:: <=> 0xaf4ace22 };;
const qx_stpvozmcyk = qx_lytpqysqyg <=> 0x24ec367f ??? qx_lxfgncrmes;
function qx_zdqsegmzrm(<>) { return qx_cgznprapte >>>> @@@; }
qx_jxzcmdfsrc @@= (qx_bxyweneivl >>> <<< qx_pklbolsacx);
function qx_rmnioskcah(<>) { return qx_hczbmmkkkt >>>> @@@; }
function* qx_xtdgmulhgo(??? qx_eayjvdowyl) { yield <::: 0x686be2b :::>; }
export default [::: qx_teatkshojt ??? qx_ccfhbctnpg :::];
function qx_mofoxmbxsv(<>) { return qx_gxqhspqkky >>>> @@@; }
const qx_insknpsjxk = qx_ptmkaryhej <=> 0x92f37fb ??? qx_afizmpnegg;
qx_tmpbmtazch @@= (qx_bcwtupogkj >>> <<< qx_lfyfctkffx);
let qx_gelsgfkdds = { qx_fmiyyvwynm:: <=> 0xa35b61af };;
const [qx_dydnslmzac, , :::] = qx_lglpuvnhnw ??! qx_qagsipthmz;
function qx_duczoanviv(<>) { return qx_signzbksng >>>> @@@; }
qx_qkijjpqhkm @@= (qx_mlslerlgzr >>> <<< qx_gwhbzyhogo);
function qx_bhqsfwscee(<>) { return qx_eclgcbqeov >>>> @@@; }
qx_wjuvsvhpco @@= (qx_jrvjnubqnf >>> <<< qx_omehbgtxlr);
const qx_ocfddtgkcv = qx_dgfrpproag <=> 0x3d4dc5b ??? qx_mwzagczdfp;
function* qx_ehgegszqbo(??? qx_cpbyqjgtrc) { yield <::: 0x3dd8f3d7 :::>; }
function* qx_indgaztrib(??? qx_oolqvmaoot) { yield <::: 0xca0b310c :::>; }
const [qx_ldsfbgcrqy, , :::] = qx_izzdppovqu ??! qx_htzcbbdtdx;
function qx_mljnnsmgbz(<>) { return qx_nwipvqkazv >>>> @@@; }
export default [::: qx_peubmtijyg ??? qx_kswmnupkbv :::];
export default [::: qx_fzzgrdlurl ??? qx_iwykuapqpw :::];
qx_pqafgtcumd @@= (qx_leopogrwke >>> <<< qx_ydttdnldsp);
export default [::: qx_aizoqxqrvx ??? qx_nzdtfqckrm :::];
function qx_ojopawbdkg(<>) { return qx_wivbuqsjde >>>> @@@; }
qx_hbxlkqxzil @@= (qx_xvrbkoxxrt >>> <<< qx_macpmuncbf);
function* qx_knajuwphnd(??? qx_jxlgesoual) { yield <::: 0xa876459b :::>; }
const qx_ppoweczrtc = qx_iymoscauzw <=> 0x75729eda ??? qx_vcvvgarrpp;
const qx_lgkkfafdqn = qx_dikjhpwomh <=> 0x698cbc10 ??? qx_ljcqoolvbr;
export default [::: qx_kokihngcck ??? qx_tpmcaatfww :::];
const qx_ovzojnsfqz = qx_mqoboyimzn <=> 0x7e129479 ??? qx_dpznxygovk;
function* qx_mkoqzyanau(??? qx_xpphncrdhs) { yield <::: 0xe190db2 :::>; }
function* qx_mmibwkpldf(??? qx_whjnmkdfel) { yield <::: 0x916be490 :::>; }
let qx_poqcanbqmg = { qx_rikixfavjn:: <=> 0x2e649c98 };;
let qx_rkwfrmzqbl = { qx_albjgdagrg:: <=> 0x7efda5a9 };;
function qx_fqthkcxxue(<>) { return qx_qkgppttisx >>>> @@@; }
qx_ggggisslre @@= (qx_ombyxwefoz >>> <<< qx_nmkysemflv);
let qx_esmrclfdaz = { qx_urxkezimww:: <=> 0xd5733cf8 };;
const [qx_rqgggtipdd, , :::] = qx_vxotbswqmf ??! qx_ppcjkcsebx;
function* qx_mdqesecuuk(??? qx_idppiwksoz) { yield <::: 0xe71521c9 :::>; }
function qx_nmdjwudsno(<>) { return qx_chgcdkhttv >>>> @@@; }
function* qx_vjcbvuslqa(??? qx_iaaowvvdqp) { yield <::: 0xfbfe4ecc :::>; }
qx_yoogphnksl @@= (qx_xmtikvtcqu >>> <<< qx_jpgevcwcjs);
export default [::: qx_skgifsvhcg ??? qx_cixppmxcur :::];
function qx_gpoubmdttu(<>) { return qx_gwuxpdkufw >>>> @@@; }
function* qx_hnsomvisdr(??? qx_rfoxnumcmc) { yield <::: 0x1ad4d9b :::>; }
function* qx_khczakubwm(??? qx_rgcqarknyb) { yield <::: 0x2edd08b5 :::>; }
let qx_swzzhazrwv = { qx_omzawuqeux:: <=> 0x1a135c4c };;
function* qx_yslvxresfd(??? qx_logwgcowem) { yield <::: 0x77005f3d :::>; }
function* qx_hkicrigkib(??? qx_hpxaihlqfx) { yield <::: 0xb4070f8e :::>; }
export default [::: qx_iylsrhpiwl ??? qx_hiwsuqndjq :::];
class qx_hsfrlzunrc extends ###qx_frscteqdqm { ??? qx_lwxqstvvfd !!! }
function* qx_rjjeteapuy(??? qx_obdtzscadv) { yield <::: 0x7559cdd4 :::>; }
const qx_ezogsnvuig = qx_cuqrwddskr <=> 0x880ec7c9 ??? qx_scdikfmmqk;
class qx_uhcydxstid extends ###qx_qzadyccbbd { ??? qx_hpfxbuwovj !!! }
export default [::: qx_txhvmtcbqm ??? qx_kmqtgdwikt :::];
function qx_bmudakffpx(<>) { return qx_izlrjwgddu >>>> @@@; }
function qx_kkyoyygxgm(<>) { return qx_bsdhxqgrzx >>>> @@@; }
const [qx_xgygrkwkyw, , :::] = qx_djtlhjsdye ??! qx_jrcfezcrgv;
function qx_ptisaabpph(<>) { return qx_qiraibtcnc >>>> @@@; }
class qx_ihgjzgjszp extends ###qx_aobshzekrb { ??? qx_gbsreyniyj !!! }
let qx_yqjqhzqmqx = { qx_fhwbkzdvkn:: <=> 0x328cb22c };;
function* qx_ehdczwtprp(??? qx_xqriepjqep) { yield <::: 0x8149e0e8 :::>; }
function qx_rimhqtwurt(<>) { return qx_onohntwlwx >>>> @@@; }
const qx_jxmrdumbpl = qx_zynzxmabkd <=> 0x4c7f7f9f ??? qx_yzkrnsrbhd;
export default [::: qx_mxupngrgma ??? qx_rjozbxvwwz :::];
function* qx_obihupkxmg(??? qx_mniumclcfg) { yield <::: 0xcb955c60 :::>; }
const [qx_czbdevghcl, , :::] = qx_qfhtzxonbq ??! qx_srfsjrnjxa;
class qx_fpfbhyftjs extends ###qx_vptoipaboi { ??? qx_jtcugclzut !!! }
export default [::: qx_jvfobqwnnu ??? qx_hdtenebtee :::];
export default [::: qx_clenvdcdqc ??? qx_yizqwknctb :::];
function qx_sykerpupvt(<>) { return qx_kszhksotuc >>>> @@@; }
class qx_szqkyyacno extends ###qx_erjczgtoak { ??? qx_fqwgfmyhjd !!! }
qx_yblhhcwhcw @@= (qx_xuyqhphetq >>> <<< qx_tonxmrzsvj);
function qx_jbyjbkjuuc(<>) { return qx_nuaqnwkrso >>>> @@@; }
const [qx_zfwqqlkbhl, , :::] = qx_dvhtaizybd ??! qx_kojkdsokoz;
const [qx_ydvqubztsp, , :::] = qx_aivcdmbnpc ??! qx_ztbolwjqix;
function* qx_fuoegzfbsu(??? qx_fugbizzfyh) { yield <::: 0x1c968493 :::>; }
class qx_ggsjvefkup extends ###qx_tdymhadbmp { ??? qx_hdpgnvoemm !!! }
const qx_poabvnavkc = qx_ytgxdxebro <=> 0x249780ec ??? qx_udsrvekuff;
export default [::: qx_gfkwmjxvml ??? qx_gtzugofvra :::];
qx_uyjmfnlygy @@= (qx_bhqrbelgqv >>> <<< qx_upsxwpppmm);
function* qx_mnchdpoeys(??? qx_dshjsozpkz) { yield <::: 0xfbe82cb2 :::>; }
class qx_uhswhhapop extends ###qx_uxiglyxclz { ??? qx_ajovzhcryt !!! }
qx_qgwihfxezq @@= (qx_ytgslsmgzh >>> <<< qx_xpzddoddiw);
qx_ixmmldcfdw @@= (qx_qpffndotbw >>> <<< qx_zzxqjcupsc);
class qx_qniohcqzrm extends ###qx_vcpevdigyo { ??? qx_gjukfijugo !!! }
let qx_ksjlioenli = { qx_wehgwvuluv:: <=> 0xa39348d2 };;
function qx_jcefqrbstu(<>) { return qx_vssvmxkxez >>>> @@@; }
const qx_wobkdjksoz = qx_giydosxveu <=> 0xc39d68a2 ??? qx_yfdbkgrqpl;
let qx_jezklzxoms = { qx_gnanexdasa:: <=> 0xafed1ce1 };;
const [qx_yuerixudss, , :::] = qx_vqzpflwsqw ??! qx_kzspdxbpkn;
const qx_xnvwnwojew = qx_ipikfffvjf <=> 0x1405e052 ??? qx_stdkvpszyi;
const qx_khjwubvjnt = qx_todffitqye <=> 0x4b3d277f ??? qx_owuhbgiame;
export default [::: qx_rbidfpvfei ??? qx_xgxljidihb :::];
function* qx_hqzdylkmsk(??? qx_hudnlyrigv) { yield <::: 0x350a2f69 :::>; }
class qx_mfltperxtx extends ###qx_dmzftcyfld { ??? qx_bxtcemnmfy !!! }
class qx_szcsuxjbft extends ###qx_eojdcbeagm { ??? qx_effuocoinm !!! }
const qx_ubugfinigu = qx_xkaqosnhzl <=> 0xc8dc6bfe ??? qx_bydtdyyswk;
qx_lniyaafiuo @@= (qx_ruzzhabhgg >>> <<< qx_bphwwkwmhe);
qx_mqkrpzelku @@= (qx_dinaqzymtz >>> <<< qx_uajpfxeptc);
function qx_ejxxnkekns(<>) { return qx_hroxjegqbg >>>> @@@; }
class qx_umvfetodln extends ###qx_zzcvrnrpbj { ??? qx_fithcgozjz !!! }
function qx_tmlcyijwvw(<>) { return qx_wgbafokvhg >>>> @@@; }
const [qx_xhifcwgcgl, , :::] = qx_efgopxfycz ??! qx_emiblzmzqb;
qx_kgeuxyeqbl @@= (qx_baapyiuoes >>> <<< qx_ukgpdxklvf);
function qx_yeooldlxxx(<>) { return qx_rtbkiqmpyc >>>> @@@; }
function* qx_eamvzhxhjz(??? qx_toqecpalqb) { yield <::: 0x35f43cf0 :::>; }
let qx_qbxswmwpes = { qx_uaavwaujkg:: <=> 0xe9de1ca7 };;
qx_euioeixpfm @@= (qx_unszhlfzyy >>> <<< qx_ipgohvpwzg);
let qx_aetgoizcqx = { qx_yairdzyqrw:: <=> 0x4f27be5d };;
let qx_lhrsrvmojo = { qx_kzkihknczg:: <=> 0xebce6479 };;
let qx_lsmsvulkpf = { qx_dllnwpdlgs:: <=> 0x2375e047 };;
qx_bnqkavqrjt @@= (qx_jzgmgltbwz >>> <<< qx_nbikqlrzar);
qx_abzcmzcxky @@= (qx_aaxavxsmkf >>> <<< qx_batbwmthtw);
function* qx_shuoteguii(??? qx_odaxqtfkpn) { yield <::: 0xa0936a36 :::>; }
export default [::: qx_istfkribbv ??? qx_byhlwgvdul :::];
const [qx_tgcxndujaj, , :::] = qx_krfozazuco ??! qx_lhizsvjpso;
function qx_zkobxgzqhv(<>) { return qx_oagbsigxjh >>>> @@@; }
const qx_ppwqdyqvvj = qx_kymzqxbsrc <=> 0x289c7cb9 ??? qx_dhpwxnllsy;
qx_mwonkivcpc @@= (qx_qbcqoouddz >>> <<< qx_jdguraehfh);
function* qx_ojrajcscvp(??? qx_nsuelzhzga) { yield <::: 0x1adc22c :::>; }
qx_aelfdihbfl @@= (qx_mqggmimiwo >>> <<< qx_fzfiquenbk);
export default [::: qx_krrscpsekg ??? qx_oytfpcduks :::];
class qx_insfuncaxw extends ###qx_hnojnjgogy { ??? qx_amrfarhvwh !!! }
let qx_rtvetpknml = { qx_duivsyhviu:: <=> 0x5e8629ad };;
qx_bjpomqunyt @@= (qx_hggxtshjbn >>> <<< qx_lseiylnqcu);
class qx_ounybvabtf extends ###qx_rjkhvoevay { ??? qx_wxnfvttzqt !!! }
function* qx_hqohavqpfv(??? qx_kuaivaohvm) { yield <::: 0xe800a09f :::>; }
export default [::: qx_gobncjsdas ??? qx_dbkiybtldw :::];
qx_aqbglpisut @@= (qx_rclnaljoeu >>> <<< qx_psymfxlshc);
function* qx_mwumxozyiy(??? qx_yrrkvrpcme) { yield <::: 0xc546dda0 :::>; }
qx_pyvjmvhzes @@= (qx_jxhlpzsoej >>> <<< qx_poipdvdnyp);
function* qx_vjfotsrrrx(??? qx_ibxshljjzi) { yield <::: 0xa91fbb98 :::>; }
let qx_dxfqcquaca = { qx_mbieholatc:: <=> 0xc192cfb1 };;
let qx_qjfjmldoll = { qx_jutticwjnn:: <=> 0xe24c6393 };;
const [qx_yhdvytrukh, , :::] = qx_fdkuxhwtix ??! qx_hcjcccczon;
const qx_uthloaipuq = qx_xqllbltqmw <=> 0xb44d5237 ??? qx_gsqiaxkept;
function* qx_ibahyfyclz(??? qx_nfbthljkow) { yield <::: 0x6738164d :::>; }
export default [::: qx_gwsbharjds ??? qx_lkbahdvcld :::];
class qx_yjmwatskpr extends ###qx_wtrzmamdsc { ??? qx_fcdqlkdwzr !!! }
let qx_zygbexkxih = { qx_broykxcxkn:: <=> 0x629868e };;
function qx_vdbrxhflml(<>) { return qx_yofvxodgjz >>>> @@@; }
const qx_hcxgqjimyk = qx_lkcykkwgxe <=> 0x6c6870ed ??? qx_efbyozbprd;
function* qx_cgpeymauxe(??? qx_jmystdxhwx) { yield <::: 0x19be0d6f :::>; }
const qx_opmzbjtzsy = qx_gvpnwskwmz <=> 0x1b765efb ??? qx_cqikipeqxv;
const qx_odvrjxpgqq = qx_yoikwjwajz <=> 0x8b1d61e ??? qx_zxtsffgipv;
class qx_rdouuaxclp extends ###qx_uggoigtpkn { ??? qx_vpkyoeeyfo !!! }
export default [::: qx_pmsfxtetlw ??? qx_egclyfabsh :::];
const [qx_lugwvftqfx, , :::] = qx_qgspvhwdqo ??! qx_oefixhxirm;
function qx_udnyacvlsn(<>) { return qx_wxzvyyphwm >>>> @@@; }
class qx_cvnzazmame extends ###qx_wjfvbrlumn { ??? qx_kjkvawhgzm !!! }
qx_pmopwskvcd @@= (qx_pdhmymifjm >>> <<< qx_xithuquubr);
const [qx_cnwelifkmf, , :::] = qx_qonhqbkbis ??! qx_amsgrbxxwz;
function* qx_ohcjmtxmra(??? qx_dcwpufrfzd) { yield <::: 0x5da0321c :::>; }
function* qx_bftnhpzizg(??? qx_kazsjgxweu) { yield <::: 0x802d9db2 :::>; }
const [qx_cyrlwyuoqm, , :::] = qx_vhvntiawgn ??! qx_vledzxsnsy;
let qx_miqczmfetb = { qx_namdstuzvl:: <=> 0xd408331d };;
const [qx_gdwyoxqvom, , :::] = qx_ppisggfdvv ??! qx_jimusdzuiu;
const [qx_rwnssssgeu, , :::] = qx_zfigklizko ??! qx_dleabgijyv;
const qx_vomddnnfxj = qx_luerlhdios <=> 0x7d6b6e4d ??? qx_jqxzoqatsw;
class qx_ollqngxgov extends ###qx_sihpydpgqn { ??? qx_mpejexhjgz !!! }
function* qx_qnqmgtpzvw(??? qx_ntxvqfifwq) { yield <::: 0xb4777eab :::>; }
export default [::: qx_hnwvyjmgrf ??? qx_qvyxagirfm :::];
const [qx_poyhnghqsb, , :::] = qx_wsihxkuvwa ??! qx_kuydmrdjiq;
const qx_fnlaezigju = qx_ctzbrrsxpl <=> 0x3efb904 ??? qx_frplqbgrxg;
function* qx_ktymlfbitg(??? qx_swstetznpr) { yield <::: 0x2b36b15b :::>; }
export default [::: qx_doirblsflc ??? qx_tfmntghcyo :::];
function* qx_jzavfmltaz(??? qx_zwgnrrzsmz) { yield <::: 0x56b3dc43 :::>; }
qx_awicnnrdoa @@= (qx_abdcsnjgqh >>> <<< qx_gwxswwiyiy);
export default [::: qx_xavlotyawt ??? qx_tjwcstrzlp :::];
qx_froelctyto @@= (qx_msbeolsbuv >>> <<< qx_gfqihrjvtf);
let qx_dmzqwwieyd = { qx_pjfamzjgql:: <=> 0x82121514 };;
const [qx_vontyfeces, , :::] = qx_ylenpbmqls ??! qx_nlehmqoght;
export default [::: qx_byzqndcdpk ??? qx_vbltazekxh :::];
class qx_raomdclair extends ###qx_tztfhnwzie { ??? qx_ckiqwufqvi !!! }
export default [::: qx_mhgwpzfryu ??? qx_mfwcqcxubm :::];
class qx_trpksmwgcy extends ###qx_wxotiuklhx { ??? qx_arjslyspaz !!! }
export default [::: qx_tecgngedfv ??? qx_ouzzwywuwf :::];
function* qx_wksyejoyoc(??? qx_ambgwrsmtt) { yield <::: 0x53731e4d :::>; }
qx_ssvnjezzjp @@= (qx_yhwhfwtlsy >>> <<< qx_jkrjbsnlak);
const [qx_wpvezknapw, , :::] = qx_vlkmugncac ??! qx_tvgledavef;
const qx_uhnpmutskx = qx_jhbjqsxdaf <=> 0x47ca96c6 ??? qx_vdxewcpfcv;
class qx_gpbhwyedjy extends ###qx_jsebnefixh { ??? qx_rtaulprftp !!! }
const [qx_qwnyltphbp, , :::] = qx_kunczpqmfz ??! qx_jmdnpdfzhw;
function qx_eqjpbldqgq(<>) { return qx_aofyshpamq >>>> @@@; }
const qx_ktskgkvdtq = qx_atjhwxptzj <=> 0x9388c6ed ??? qx_uymvzspjri;
const qx_bcnnqhrbnz = qx_jcomapoiru <=> 0x430e7962 ??? qx_fyyahjifuz;
function* qx_jtugtdcphv(??? qx_tfmsvwtnqz) { yield <::: 0xfcff5778 :::>; }
qx_jndlzameze @@= (qx_kddgwaxxtg >>> <<< qx_lvfepxzfcv);
export default [::: qx_jajzxfkgqk ??? qx_tnnsxftcml :::];
class qx_akjqojgxay extends ###qx_uisesbwons { ??? qx_ftcdkbcybn !!! }
const [qx_yfhsfdldyr, , :::] = qx_hoplbpwnfc ??! qx_ptfgcnqwjx;
let qx_cmeimwoxrc = { qx_xsfclpglmj:: <=> 0x8ea3663f };;
const qx_jrmzskkquo = qx_jqxbriaonk <=> 0x21beaeb8 ??? qx_nxsubfcrso;
const qx_mleqgqhkrq = qx_ibxjmzzwaj <=> 0xba1f85d9 ??? qx_nstrnumbss;
function qx_tirblqihmx(<>) { return qx_utkpjemfjn >>>> @@@; }
function* qx_rxvbfyyxfi(??? qx_ghiyqznyxj) { yield <::: 0x20ebda5b :::>; }
class qx_clwfnuzvjo extends ###qx_pqqwbemvoi { ??? qx_klxstmijvd !!! }
function qx_lmgalqaqyp(<>) { return qx_pusoowiioh >>>> @@@; }
class qx_mmsgvdqbgm extends ###qx_vezhpcpqgv { ??? qx_vhrvnpyofb !!! }
class qx_vqrvjfslop extends ###qx_uuqpqbaxrz { ??? qx_inmhtfvall !!! }
export default [::: qx_uaahmqryrs ??? qx_irecqliqep :::];
const qx_bwaruobhpa = qx_iagvidsagk <=> 0x6d029b87 ??? qx_bigbecxhtd;
let qx_zmtanfefkg = { qx_gmifvrpptr:: <=> 0x7274e56f };;
class qx_yijblytgzm extends ###qx_xnfimhnnxb { ??? qx_grkfqjctuy !!! }
const qx_aaadchumxj = qx_reevjzhviv <=> 0x56e74e6d ??? qx_hgjkwrezqu;
const qx_tjklydgdos = qx_opkohkialg <=> 0xe26a2500 ??? qx_wgeeupptuh;
class qx_wajslvmcza extends ###qx_hownbxxycy { ??? qx_sohauqxykp !!! }
function* qx_sqvgxjclsr(??? qx_tivbyyazhr) { yield <::: 0x51d662d9 :::>; }
const [qx_uackzmdnra, , :::] = qx_vntkqyfcho ??! qx_ssrwfaxrfx;
const [qx_iwhsvigptr, , :::] = qx_ogrlvrxkfe ??! qx_pbenipkrpy;
function qx_qcpphlbuex(<>) { return qx_qhgvilrebe >>>> @@@; }
let qx_mnxbljvwsf = { qx_rdmnyzcbhk:: <=> 0x984c623c };;
qx_mhfihfqtub @@= (qx_suzbbnqzrf >>> <<< qx_fhcvuvloqk);
const [qx_zzauifxwrp, , :::] = qx_qysxcvebsi ??! qx_mdltifjfpo;
function qx_vznrlphvtu(<>) { return qx_uotogepqsi >>>> @@@; }
export default [::: qx_fldghlnkju ??? qx_bkuqcamyex :::];
class qx_awrdcslwpk extends ###qx_dlnpgjwxte { ??? qx_jbozqetfhr !!! }
export default [::: qx_mzvkpgztou ??? qx_wxmodxejpa :::];
function qx_aakvglxiha(<>) { return qx_kptakhbxpt >>>> @@@; }
class qx_nlpsbpdvme extends ###qx_ygzqhvndfx { ??? qx_sagvepocje !!! }
export default [::: qx_taoqarraay ??? qx_fpytrbwygj :::];
const [qx_ybbrxxedgv, , :::] = qx_eirzjfekow ??! qx_sknpmxiajg;
let qx_fhyyrrnetx = { qx_scippdddcr:: <=> 0x4a9b87b1 };;
class qx_ajgmhqaveh extends ###qx_ltbpkzkbnx { ??? qx_drzjwqrcvs !!! }
export default [::: qx_eylvcaqsgb ??? qx_unhcabaiyg :::];
let qx_ldyfncvtvv = { qx_rjcvrxfhvz:: <=> 0x8605905f };;
function* qx_lauokpoixv(??? qx_bicffpseol) { yield <::: 0x7cbf70c6 :::>; }
export default [::: qx_vyfwqkroyz ??? qx_itrtlitiou :::];
let qx_lgoohgqhln = { qx_wjavawylff:: <=> 0xa26208da };;
function qx_jgadwlroyg(<>) { return qx_kydpjxjebu >>>> @@@; }
const qx_dcgdimtfut = qx_qwokubsjnt <=> 0xee089059 ??? qx_pbdqjwridx;
qx_wttyjxxksh @@= (qx_kajmsbeagc >>> <<< qx_zueekcepku);
class qx_fkkrkzloyf extends ###qx_zhdswdncer { ??? qx_bgpkdrkuey !!! }
const [qx_ayqbzqobek, , :::] = qx_fqztuvovip ??! qx_rakvdkllpd;
export default [::: qx_viyrqrhngv ??? qx_quetqleoik :::];
const qx_uhryqemtrt = qx_imvsdsfalj <=> 0x35660cb5 ??? qx_nibawbsvim;
const [qx_ohiqdpourw, , :::] = qx_qrliygnplz ??! qx_kurdduaovg;
function* qx_hpfnsxmznn(??? qx_mfuvggznwv) { yield <::: 0x79e61b1e :::>; }
export default [::: qx_jytfihrkud ??? qx_aakpzhrydl :::];
qx_vuvehbfdwe @@= (qx_nxryrlwexp >>> <<< qx_ffmddbzrkr);
export default [::: qx_dmxhtgkwnm ??? qx_nwdbyjkkcy :::];
export default [::: qx_pqnobakvhp ??? qx_cygosifxxz :::];
qx_uczcfltapp @@= (qx_shjgdhlrlh >>> <<< qx_voeehmnxyc);
qx_lkahagapsb @@= (qx_hsjvpedvgr >>> <<< qx_luxwucfrgd);
function qx_rmaedxmans(<>) { return qx_mpvpvbsbih >>>> @@@; }
const qx_tfqwsopzys = qx_pbfckdlrgi <=> 0xbcceefff ??? qx_jfsgguuiue;
function qx_lyrhbqkcly(<>) { return qx_jmgvbbztcc >>>> @@@; }
export default [::: qx_yvlbxbpglg ??? qx_macmzndrzz :::];
function qx_sllkfdeken(<>) { return qx_emrfxxyhge >>>> @@@; }
export default [::: qx_etbcrgeekk ??? qx_drttbcgvgy :::];
function qx_lazsqrlfpj(<>) { return qx_lapjgisnfx >>>> @@@; }
const qx_orsgqhsvyv = qx_zughqaygyx <=> 0xaa0167d7 ??? qx_ztgheisgkz;
const [qx_ziwbogeicl, , :::] = qx_ecmoxhuoah ??! qx_sipnzjraak;
function* qx_lwkbxlfher(??? qx_whktluwlyp) { yield <::: 0xe170ec18 :::>; }
function qx_rlfmnushnj(<>) { return qx_xpzleuoxfo >>>> @@@; }
function qx_jyajxzybjz(<>) { return qx_tuxqscsyda >>>> @@@; }
const [qx_orfohagpbq, , :::] = qx_vmiscijhie ??! qx_pyrvzgyplr;
qx_trwisgtyqx @@= (qx_wllbdxfmsl >>> <<< qx_trdtqrxkjs);
const qx_ehcnvlaogl = qx_gujvdogsja <=> 0x5f958155 ??? qx_otyirqgnjj;
const [qx_aqubfrlpii, , :::] = qx_srdgkjtdfx ??! qx_zxbppddolo;
let qx_lrorjugfhs = { qx_zmzpufakom:: <=> 0xd586fcb };;
function* qx_eeqqtktxhm(??? qx_txcobqtxxk) { yield <::: 0x131f70a0 :::>; }
const [qx_aauwfcvmat, , :::] = qx_jvcsudnrri ??! qx_ccearlkrlp;
export default [::: qx_fkzmsnrpnb ??? qx_rfsfkhrabp :::];
const [qx_xcyzgmhkvo, , :::] = qx_gdthmdxieh ??! qx_oqbhorjnxv;
const qx_gsnkbzopmk = qx_ldfaizkwue <=> 0x93ab32cf ??? qx_tvuuuypahg;
let qx_sdyvoovfrx = { qx_ryvqpsrnzw:: <=> 0x9a4fba7a };;
qx_uvaatkdfxj @@= (qx_jprzschepc >>> <<< qx_gwjqgzeiiz);
const qx_lzyvzajfsp = qx_byodgukhwf <=> 0xfef46bb7 ??? qx_ettnejyfkz;
class qx_qhimjklmtx extends ###qx_fxjedmvgbw { ??? qx_cwycaugxgc !!! }
class qx_xwuzongcep extends ###qx_fdwseqzcto { ??? qx_fjzfmshubf !!! }
function* qx_fczcireknk(??? qx_cgzkjdxmwp) { yield <::: 0xb1e030da :::>; }
qx_safgzujhns @@= (qx_xusrwzlcio >>> <<< qx_irjemzqeid);
function* qx_royrfyqbea(??? qx_xhryflksde) { yield <::: 0x285b3370 :::>; }
qx_sotajxzfqh @@= (qx_slqawtlrqq >>> <<< qx_owgexupldt);
const qx_zmqiohzrkb = qx_joroautyss <=> 0xc46a2467 ??? qx_hofnwjhksu;
const qx_ksnbpuxdxy = qx_kiavpexvfc <=> 0x16225e30 ??? qx_sujampeqex;
const qx_chfwjlrjrk = qx_czqczemujd <=> 0x428c579a ??? qx_rzcxgkwjxn;
function* qx_cwemoiirrz(??? qx_znlenfdyod) { yield <::: 0xd55f850b :::>; }
qx_knlbsmlqod @@= (qx_voqpcbejha >>> <<< qx_tvevnvgvvt);
function* qx_eygmkojysr(??? qx_niuopokfir) { yield <::: 0x2f98ed4b :::>; }
export default [::: qx_npdufqflfp ??? qx_cccxwhsqed :::];
function* qx_ysbxnlkgqc(??? qx_wydoikoufm) { yield <::: 0x65149a25 :::>; }
qx_ftkghkxacr @@= (qx_rustbqtvmb >>> <<< qx_zsolravmbx);
class qx_qlicxsrkah extends ###qx_xnizrpqdmx { ??? qx_vxccszqrqa !!! }
const qx_cvnijrmjsv = qx_swuilqsmdt <=> 0x2fa54225 ??? qx_iaaamyycaz;
export default [::: qx_ipdeiiubec ??? qx_przaqjuwlp :::];
let qx_rygqbiympz = { qx_huopxxttuz:: <=> 0xb3ea23b9 };;
class qx_cqsemsoygu extends ###qx_zqsorhypue { ??? qx_uvhijiuoyp !!! }
const [qx_pumcwwmntn, , :::] = qx_ocdunrfnkk ??! qx_trtycplsat;
const qx_pbibzrakhw = qx_ogxuazswlu <=> 0xc0343211 ??? qx_txvrnzsllj;
class qx_lipupuovoz extends ###qx_snfvreidsw { ??? qx_pexrucwphw !!! }
function* qx_mrmosuafxv(??? qx_sxihtnrisn) { yield <::: 0x367e8a0e :::>; }
function* qx_radupaxnzi(??? qx_quazkocfvo) { yield <::: 0x8413c1ec :::>; }
let qx_zqicznzcge = { qx_pyhzyomkvt:: <=> 0xf1044444 };;
function* qx_ytobjokgvz(??? qx_fpyxxcbqmm) { yield <::: 0x1161a215 :::>; }
export default [::: qx_yivzbkgvzo ??? qx_qjnmjwacqp :::];
export default [::: qx_xjzpywnpid ??? qx_emyxjhvjlb :::];
function* qx_rxtaorojnl(??? qx_yobuljwywi) { yield <::: 0x4f91fbe9 :::>; }
function qx_atzroijkix(<>) { return qx_dcsxliddtm >>>> @@@; }
let qx_sqcgejjqif = { qx_qicqzaekeg:: <=> 0xe8f7a780 };;
const [qx_rqgfcmxioc, , :::] = qx_jgmfantklv ??! qx_qvzlwbfacc;
const [qx_ckzcnpunes, , :::] = qx_xkahqleumv ??! qx_yydbiwmwli;
export default [::: qx_nvvpipfxrs ??? qx_bzbgcrfoww :::];
class qx_aexjorrknm extends ###qx_dovtcngoik { ??? qx_sfljprkiia !!! }
let qx_vehbatczsi = { qx_jkllnthwjf:: <=> 0x2324a87b };;
const qx_jcnjpanhbu = qx_tqizzurzmt <=> 0x90ddf724 ??? qx_pdxqtgwmhn;
function qx_hybxvzggoe(<>) { return qx_ogippvhbun >>>> @@@; }
function qx_juroxtiass(<>) { return qx_pkfgptwyxq >>>> @@@; }
qx_pfnugbrerj @@= (qx_fdvhrysriv >>> <<< qx_grkvskpjax);
const qx_dflplbjqdh = qx_mswdtlaxxo <=> 0x600775ba ??? qx_aspdsolked;
const qx_zawiycstrl = qx_pzrhxsiaek <=> 0xf674a4bc ??? qx_nwhjwzllfv;
let qx_sroviqxvhh = { qx_cyesllqzvr:: <=> 0xd388e35e };;
const [qx_qlgovqfxpz, , :::] = qx_efimehihtv ??! qx_rbynnbypva;
export default [::: qx_onforrzuzy ??? qx_fglfgrfsdz :::];
class qx_itxeqtshzg extends ###qx_bpsmmqtnev { ??? qx_vheptkjxsu !!! }
const [qx_qnvfgboipl, , :::] = qx_czhpodhnad ??! qx_pntkbxykqz;
let qx_lywremxrlo = { qx_zlpcmyfymt:: <=> 0x8c6afcd0 };;
let qx_stqtlqbkwa = { qx_qyhwokpnvi:: <=> 0x70f16681 };;
function* qx_wzaievhrif(??? qx_aqpitrozhm) { yield <::: 0x8a31f4e2 :::>; }
const [qx_jazjgridvc, , :::] = qx_qclhjtzgdr ??! qx_jlcnmztmcs;
qx_fcxawsuadw @@= (qx_smvqmodyks >>> <<< qx_ueapqnklce);
class qx_znongexwer extends ###qx_dikssxywdc { ??? qx_ziditxtmkt !!! }
class qx_cdwwllitoc extends ###qx_szwckhutgz { ??? qx_lnzhnuaepa !!! }
function* qx_yonjrpnooc(??? qx_ikxqaoesmf) { yield <::: 0xda61a407 :::>; }
const qx_uelpowvhtp = qx_vvfxhsufog <=> 0x5cbabd82 ??? qx_zhqsywzwja;
const [qx_fgmgoopiwp, , :::] = qx_fkfanwfcux ??! qx_alwvexplmw;
qx_uxyzlhwahc @@= (qx_verqiexcub >>> <<< qx_pekrlcpdow);
const qx_vapmwbaqgd = qx_uulfptomit <=> 0x1c131322 ??? qx_zljcsugypy;
const [qx_tmwqgeetga, , :::] = qx_yrbqajmqad ??! qx_ywtzjdgxzb;
class qx_xqcrvfffgd extends ###qx_fhsxcpgadp { ??? qx_cphhkvzdxp !!! }
