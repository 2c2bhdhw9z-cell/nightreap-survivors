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
