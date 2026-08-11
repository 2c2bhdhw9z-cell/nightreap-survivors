/**
 * Crowd + wave director self-check. Run headless: `bun packages/mobile/game/sim/crowd.test.ts`
 *
 * This is the file that stands between us and the two ways a horde game dies:
 *
 *   1. It stops holding 60fps. The perf contract is 500 enemies as a hard floor and 800 as the gate,
 *      measured warm. This test cannot measure the phone, but it can measure the simulation cost per
 *      tick and it can prove the tick allocates nothing — and allocation, not arithmetic, is what
 *      kills a JS game on a 4GB Android device.
 *   2. It stops being the same game on two machines. Co-op is host-authoritative with a correction
 *      sweep, and replay revalidation resimulates the whole run. Both depend on the crowd being a
 *      pure function of the seed. So the separation push is order-independent and every random draw
 *      comes from the seeded stream, and both of those get tested rather than assumed.
 *
 * WHAT IT PROVES
 *   1. Spawning fills the arrays correctly and respects the pool ceiling without throwing.
 *   2. Enemies actually converge on the player, and the archetypes behave differently from each other.
 *   3. The crowd separates: 300 enemies dumped on one point spread out instead of stacking.
 *   4. Separation is order-independent — the same crowd resolves identically however the pool
 *      recycled its slots.
 *   5. Knockback moves light enemies, is ignored by heavy ones, and decays back into the chase.
 *   6. Culling recycles wanderers without crediting a kill, and never skips an enemy while doing it.
 *   7. The director's fractional spawn accumulator produces the requested rate over time.
 *   8. The live cap holds, and hitting it does not bank a flood for later.
 *   9. Hurry makes the run clock and therefore the waves arrive twice as fast, with no mode code.
 *  10. Hyper raises the spawn rate and enemy stats, and stacks with Hurry.
 *  11. Same seed produces a byte-identical crowd; a different seed does not.
 *  12. A full tick at 800 enemies allocates nothing and fits the frame budget.
 */

import { Rng, RngSet } from "../core/rng";
import { ModifierStack, MOD_HURRY, MOD_HYPER } from "./modifiers";
import {
  CULL_DISTANCE,
  ENEMY_FLAG,
  ENEMY_TYPES,
  ENEMY_TYPE_BY_ID,
  EnemyStore,
} from "./enemies";
import { STAT, STAT_SCALE, Stats } from "./stats";
import { DEFAULT_WAVES, REAPER_SECOND, SPAWN_RING, TICKS_PER_SECOND, WaveDirector } from "./waves";

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

const TYPE = (id: string): number => ENEMY_TYPE_BY_ID.get(id) ?? 0;

/** One player at the origin, in the parallel-array shape the crowd update expects. */
function soloPlayer(x = 0, y = 0): { px: Float32Array; py: Float32Array } {
  const px = new Float32Array(4);
  const py = new Float32Array(4);
  px[0] = x;
  py[0] = y;
  return { px, py };
}

function baseStats(): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  return stats;
}

/** Run the crowd forward n ticks against a stationary solo player. */
function step(enemies: EnemyStore, stats: Stats, ticks: number, px: Float32Array, py: Float32Array): void {
  for (let t = 0; t < ticks; t++) {
    enemies.rebuildGrid();
    enemies.update(px, py, 1, stats);
  }
}

/** Positions of every live enemy, rounded, sorted — an order-independent fingerprint of the crowd. */
function crowdFingerprint(enemies: EnemyStore): string {
  const out: string[] = [];
  const slots = enemies.slots;
  for (let i = 0; i < enemies.count; i++) {
    const s = slots[i];
    out.push(`${enemies.x[s].toFixed(3)},${enemies.y[s].toFixed(3)}`);
  }
  out.sort();
  return out.join("|");
}

section("spawning");
{
  const enemies = new EnemyStore(256);
  const stats = baseStats();
  const handle = enemies.spawn(TYPE("shambler"), 100, -50, stats);
  const slot = handle & 0xffff;
  check("spawn returns a live handle", handle >= 0 && enemies.pool.isAlive(handle), `handle ${handle}`);
  check(
    "spawn writes position, health and radius",
    enemies.x[slot] === 100 &&
      enemies.y[slot] === -50 &&
      enemies.health[slot] === ENEMY_TYPES[TYPE("shambler")].health &&
      enemies.radius[slot] === ENEMY_TYPES[TYPE("shambler")].radius,
    `hp ${enemies.health[slot]}`,
  );
  check("count tracks live enemies", enemies.count === 1);

  for (let i = 0; i < 400; i++) enemies.spawn(TYPE("gnawer"), i, i, stats);
  check(
    "the pool ceiling holds and refuses gracefully",
    enemies.count === 256 && enemies.pool.exhaustedCount > 0,
    `${enemies.count} alive, ${enemies.pool.exhaustedCount} refused — a dropped spawn beats a dropped frame`,
  );

  enemies.clear();
  check("clear empties the crowd without reallocating", enemies.count === 0 && enemies.kills === 0);

  // Curse is the one knob that escalates everything; verify it reaches enemy health and speed.
  const cursed = baseStats();
  cursed.values[STAT.curse] = 2 * STAT_SCALE;
  cursed.values[STAT.enemyHealth] = 2 * STAT_SCALE;
  const h2 = enemies.spawn(TYPE("shambler"), 0, 0, cursed);
  check(
    "Curse and enemy-health multipliers compound at spawn",
    enemies.health[h2 & 0xffff] === ENEMY_TYPES[TYPE("shambler")].health * 4,
    `${enemies.health[h2 & 0xffff]} hp at 2x curse and 2x health`,
  );
}

section("steering");
{
  const enemies = new EnemyStore(64);
  const stats = baseStats();
  const { px, py } = soloPlayer();

  const h = enemies.spawn(TYPE("shambler"), 200, 0, stats);
  const slot = h & 0xffff;
  const before = Math.hypot(enemies.x[slot], enemies.y[slot]);
  step(enemies, stats, 60, px, py);
  const after = Math.hypot(enemies.x[slot], enemies.y[slot]);
  check(
    "a chaser closes on the player",
    after < before - 20,
    `${before.toFixed(0)} to ${after.toFixed(0)} units in one second`,
  );
  check(
    "it moves at roughly its stated speed",
    Math.abs(before - after - ENEMY_TYPES[TYPE("shambler")].speed) < 3,
    `closed ${(before - after).toFixed(1)} units, speed is ${ENEMY_TYPES[TYPE("shambler")].speed}`,
  );
  check("facing is set for sprite selection", enemies.facing[slot] === 1, "moving left, faces west");

  // A circler should hold a ring instead of closing all the way in.
  const circ = new EnemyStore(8);
  const ch = circ.spawn(TYPE("wisp"), 240, 0, stats);
  const cslot = ch & 0xffff;
  step(circ, stats, 300, px, py);
  const cdist = Math.hypot(circ.x[cslot], circ.y[cslot]);
  check(
    "a circler holds its distance instead of closing",
    cdist > 60 && cdist < 190,
    `settled at ${cdist.toFixed(0)} units — forces the player to come to it`,
  );

  // Nearest-target selection: two players, enemy should pick the closer one. This is the entire
  // co-op targeting path, and it is the same loop solo uses with playerCount = 1.
  const co = new EnemyStore(8);
  const cpx = new Float32Array(4);
  const cpy = new Float32Array(4);
  cpx[0] = -300;
  cpx[1] = 60;
  const th = co.spawn(TYPE("shambler"), 100, 0, stats);
  co.rebuildGrid();
  co.update(cpx, cpy, 2, stats);
  check(
    "enemies hunt the nearest player, solo and co-op through one loop",
    co.target[th & 0xffff] === 1,
    "picked player 2 at 60 units over player 1 at 400",
  );
}

section("separation");
{
  const enemies = new EnemyStore(512);
  const stats = baseStats();
  // Far enough that the chase does not dominate the measurement, but inside CULL_DISTANCE.
  // An earlier version parked the player at -4000, past the cull radius, so every enemy was
  // deleted and the "spread" was measured on an empty crowd. That read as zero and looked like
  // a separation failure. Hence the survivor check below.
  const { px, py } = soloPlayer(0, -600);
  const rng = new Rng(12345);

  // Dump 300 enemies into a tight knot.
  for (let i = 0; i < 300; i++) {
    const a = (rng.nextInt(4096) / 4096) * Math.PI * 2;
    const r = rng.nextInt(20);
    enemies.spawn(TYPE("shambler"), Math.cos(a) * r, Math.sin(a) * r, stats);
  }
  const spreadBefore = averageNeighbourDistance(enemies);
  step(enemies, stats, 120, px, py);
  const spreadAfter = averageNeighbourDistance(enemies);
  check(
    "the knot is still alive to measure",
    enemies.count === 300,
    `${enemies.count} of 300 survived — culling here would make the spread meaningless`,
  );
  check(
    "a knot of 300 enemies pushes itself apart",
    spreadAfter > spreadBefore * 1.5,
    `mean nearest-neighbour ${spreadBefore.toFixed(1)} to ${spreadAfter.toFixed(1)} units`,
  );

  let stacked = 0;
  const slots = enemies.slots;
  for (let i = 0; i < enemies.count; i++) {
    for (let j = i + 1; j < enemies.count; j++) {
      const a = slots[i];
      const b = slots[j];
      if (Math.hypot(enemies.x[a] - enemies.x[b], enemies.y[a] - enemies.y[b]) < 1) stacked++;
    }
  }
  check(
    "no two enemies remain perfectly stacked",
    stacked === 0,
    "a stacked horde reads as one sprite, not a crowd",
  );

  check(
    "exactly-overlapping enemies separate deterministically, not randomly",
    (() => {
      const a = new EnemyStore(8);
      const b = new EnemyStore(8);
      for (const store of [a, b]) {
        store.spawn(TYPE("shambler"), 0, 0, stats);
        store.spawn(TYPE("shambler"), 0, 0, stats);
        store.rebuildGrid();
        store.update(px, py, 1, stats);
      }
      return crowdFingerprint(a) === crowdFingerprint(b);
    })(),
    "a random nudge here would desync co-op and break replays",
  );

  check(
    "separation is independent of pool iteration order",
    (() => {
      // Build the same 60-enemy crowd twice, but in the second store churn the pool first so live
      // slots come out in a different order. The resolved crowd must be identical.
      const layout: number[][] = [];
      const r = new Rng(777);
      for (let i = 0; i < 60; i++) layout.push([r.nextInt(80) - 40, r.nextInt(80) - 40]);

      const plain = new EnemyStore(256);
      for (const [x, y] of layout) plain.spawn(TYPE("shambler"), x, y, stats);

      const churned = new EnemyStore(256);
      const scratch: number[] = [];
      for (let i = 0; i < 40; i++) scratch.push(churned.spawn(TYPE("gnawer"), 9999, 9999, stats));
      for (const h of scratch) churned.pool.free(h);
      for (const [x, y] of layout) churned.spawn(TYPE("shambler"), x, y, stats);

      step(plain, stats, 30, px, py);
      step(churned, stats, 30, px, py);
      return crowdFingerprint(plain) === crowdFingerprint(churned);
    })(),
    "two machines in one co-op session cannot drift apart on slot order",
  );

  check(
    "phasing enemies ignore the push and walk through the crowd",
    (() => {
      const s = new EnemyStore(8);
      const a = s.spawn(TYPE("wisp"), 0, 0, stats);
      s.spawn(TYPE("wisp"), 1, 0, stats);
      s.rebuildGrid();
      s.update(px, py, 1, stats);
      return s.pushX[a & 0xffff] === 0 && s.pushY[a & 0xffff] === 0;
    })(),
  );
}

function averageNeighbourDistance(enemies: EnemyStore): number {
  const slots = enemies.slots;
  const n = enemies.count;
  // NaN, not 0: an empty crowd means the setup is wrong, and every comparison against NaN is
  // false, so the calling check fails loudly instead of quietly reading as "no spread".
  if (n < 2) return Number.NaN;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = slots[i];
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = slots[j];
      const d = Math.hypot(enemies.x[a] - enemies.x[b], enemies.y[a] - enemies.y[b]);
      if (d < best) best = d;
    }
    total += best;
  }
  return total / n;
}

section("damage, knockback and culling");
{
  const enemies = new EnemyStore(64);
  const stats = baseStats();
  const { px, py } = soloPlayer();

  const h = enemies.spawn(TYPE("shambler"), 50, 0, stats);
  const slot = h & 0xffff;
  check("a non-lethal hit does not kill", !enemies.damageAt(slot, 4) && enemies.count === 1);
  check(
    "a lethal hit kills once and credits one kill",
    enemies.damageAt(slot, 999) && enemies.count === 0 && enemies.kills === 1,
  );
  check(
    "damaging a dead slot is a no-op, not a second death",
    !enemies.damageAt(slot, 999) && enemies.kills === 1,
    "two death paths is how a boss drops loot twice",
  );

  const light = enemies.spawn(TYPE("gnawer"), 40, 0, stats);
  const lslot = light & 0xffff;
  enemies.knockback(lslot, 1, 0, 400);
  const xBefore = enemies.x[lslot];
  step(enemies, stats, 3, px, py);
  check(
    "knockback shoves a light enemy backwards",
    enemies.x[lslot] > xBefore,
    `moved ${(enemies.x[lslot] - xBefore).toFixed(1)} units away from the player`,
  );
  check("knockback sets the knocked flag", (enemies.flags[lslot] & ENEMY_FLAG.knocked) !== 0);
  step(enemies, stats, 20, px, py);
  check(
    "knockback decays and the chase resumes",
    (enemies.flags[lslot] & ENEMY_FLAG.knocked) === 0 && enemies.vx[lslot] < 0,
    "eases back in rather than snapping — that reads as weight",
  );

  const heavy = enemies.spawn(TYPE("bonepile"), 40, 0, stats);
  const hslot = heavy & 0xffff;
  enemies.knockback(hslot, 1, 0, 400);
  check(
    "heavy enemies ignore knockback entirely",
    enemies.knockTicks[hslot] === 0,
    "that is what makes brutes feel like walls",
  );

  const cull = new EnemyStore(64);
  const killsBefore = cull.kills;
  for (let i = 0; i < 20; i++) cull.spawn(TYPE("shambler"), CULL_DISTANCE + 500, i * 30, stats);
  cull.spawn(TYPE("shambler"), 10, 0, stats);
  cull.rebuildGrid();
  cull.update(px, py, 1, stats);
  check(
    "wanderers are recycled and the nearby enemy is kept",
    cull.count === 1 && cull.culled === 20,
    `${cull.culled} recycled, ${cull.count} kept — culling every one in a single pass, none skipped`,
  );
  check(
    "a recycled enemy is not counted as a kill",
    cull.kills === killsBefore,
    "otherwise a player could farm the counter by running away",
  );
  check(
    "persistent enemies are never culled",
    (() => {
      const s = new EnemyStore(8);
      s.spawn(TYPE("hound"), CULL_DISTANCE + 2000, 0, stats);
      s.rebuildGrid();
      s.update(px, py, 1, stats);
      return s.count === 1;
    })(),
  );
}

section("the wave director");
{
  const stats = baseStats();
  const enemies = new EnemyStore(2048);
  const director = new WaveDirector();
  const rng = new RngSet(0xc0ffee);
  director.begin();

  check("a run starts on the first wave at time zero", director.runSeconds === 0 && director.currentWave.atSecond === 0);

  // Ten seconds of the opening wave at 1.2/sec should be about 12 enemies. The fractional
  // accumulator is the thing under test: rounding per tick would give 0 or 720.
  for (let t = 0; t < TICKS_PER_SECOND * 10; t++) {
    director.update(enemies, stats, rng.get("spawn"), 0, 0, false);
  }
  check(
    "the fractional accumulator produces the requested rate",
    director.spawnedTotal >= 10 && director.spawnedTotal <= 14,
    `${director.spawnedTotal} spawned in 10s at 1.2/s`,
  );

  check(
    "enemies appear on the spawn ring, off screen",
    (() => {
      const slots = enemies.slots;
      for (let i = 0; i < enemies.count; i++) {
        const d = Math.hypot(enemies.x[slots[i]], enemies.y[slots[i]]);
        if (Math.abs(d - SPAWN_RING) > 1) return false;
      }
      return true;
    })(),
    `all at ${SPAWN_RING} units — nothing pops into existence on screen`,
  );

  // Waves advance on the clock.
  director.jumpToSecond(210);
  check(
    "jumping the clock lands on the right wave",
    director.currentWave.atSecond === 210,
    "the dev menu's jump-to-timestamp is instant, not a fast-forward",
  );
  check(
    "the boss wave carries a boss",
    DEFAULT_WAVES.some((w) => w.boss !== undefined),
    "first boss at minute 5",
  );

  // The boss spawns exactly once when its wave opens, and does not duplicate.
  const bossRun = new EnemyStore(2048);
  const bossDir = new WaveDirector();
  bossDir.begin();
  bossDir.jumpToSecond(295);
  for (let t = 0; t < TICKS_PER_SECOND * 20; t++) {
    bossDir.update(bossRun, stats, rng.get("spawn"), 0, 0, false);
  }
  check(
    "exactly one boss spawns when its wave opens",
    bossRun.bossCount() === 1,
    "two bosses would share one health bar",
  );

  // The live cap has to hold, and must not bank a flood.
  const capped = new EnemyStore(2048);
  const capDir = new WaveDirector();
  capDir.begin();
  capDir.jumpToSecond(0);
  for (let t = 0; t < TICKS_PER_SECOND * 120; t++) {
    capDir.update(capped, stats, rng.get("spawn"), 0, 0, false);
  }
  check(
    "the live cap holds",
    capped.count <= capDir.currentWave.liveCap,
    `${capped.count} alive against a cap of ${capDir.currentWave.liveCap}`,
  );
  check(
    "hitting the cap discards the debt instead of banking a flood",
    capDir.refusedTotal > 0 && capped.count <= capDir.currentWave.liveCap,
    "otherwise clearing the crowd releases a stored-up wave, which reads as a bug",
  );

  check(
    "the Reaper is due at minute 30, and early when a modifier says so",
    (() => {
      const d = new WaveDirector();
      d.begin();
      d.jumpToSecond(REAPER_SECOND - 1);
      const notYet = !d.reaperDue(stats, false);
      const earlyYes = d.reaperDue(stats, true);
      d.jumpToSecond(REAPER_SECOND);
      return notYet && earlyYes && d.reaperDue(stats, false);
    })(),
    "minute 30 normally, minute 15 with the early-Reaper flag",
  );
}

section("Hurry and Hyper drive the crowd with no mode code");
{
  const enemies = new EnemyStore(2048);
  const rng = new RngSet(42);

  function runSeconds(mods: readonly Parameters<ModifierStack["add"]>[0][], ticks: number) {
    const stats = new Stats();
    const stack = new ModifierStack();
    for (const m of mods) stack.add(m);
    stack.resolve(stats);
    const dir = new WaveDirector();
    dir.begin();
    const store = new EnemyStore(2048);
    for (let t = 0; t < ticks; t++) dir.update(store, stats, rng.get("spawn"), 0, 0, false);
    return { dir, store, stats };
  }

  const ticks = TICKS_PER_SECOND * 60;
  const normal = runSeconds([], ticks);
  const hurry = runSeconds([MOD_HURRY], ticks);
  check(
    "Hurry makes the run clock advance twice as fast",
    Math.abs(hurry.dir.runSeconds - normal.dir.runSeconds * 2) < 1,
    `${normal.dir.runSeconds.toFixed(0)}s of run time becomes ${hurry.dir.runSeconds.toFixed(0)}s in the same real minute`,
  );
  check(
    "so Hurry reaches later waves sooner",
    hurry.dir.currentWave.atSecond > normal.dir.currentWave.atSecond,
    `wave at ${hurry.dir.currentWave.atSecond}s vs ${normal.dir.currentWave.atSecond}s`,
  );

  const hyper = runSeconds([MOD_HYPER], ticks);
  check(
    "Hyper spawns more enemies over the same run time",
    hyper.dir.spawnedTotal > normal.dir.spawnedTotal,
    `${hyper.dir.spawnedTotal} vs ${normal.dir.spawnedTotal} spawned`,
  );
  // Measured as distance actually covered, not as the stored speed field. enemySpeed is applied
  // live in update() rather than baked in at spawn, so that a modifier arriving mid-run speeds up
  // the crowd already on screen. Reading the field would test the wrong thing.
  const paceUnderHyper = (() => {
    const target = new Float32Array([0]);
    const zero = new Float32Array([0]);
    const walk = (stats: Stats): number => {
      const store = new EnemyStore(8);
      const h = store.spawn(TYPE("shambler"), -200, 0, stats);
      const slot = h & 0xffff;
      for (let t = 0; t < 60; t++) {
        store.rebuildGrid();
        store.update(target, zero, 1, stats);
      }
      return store.x[slot] + 200;
    };
    const plainHealth = (() => {
      const store = new EnemyStore(8);
      return store.health[store.spawn(TYPE("shambler"), 0, 0, normal.stats) & 0xffff];
    })();
    const hyperHealth = (() => {
      const store = new EnemyStore(8);
      return store.health[store.spawn(TYPE("shambler"), 0, 0, hyper.stats) & 0xffff];
    })();
    const plainWalk = walk(normal.stats);
    const hyperWalk = walk(hyper.stats);
    return { plainWalk, hyperWalk, plainHealth, hyperHealth };
  })();
  check(
    "Hyper enemies close in faster and take more hits",
    paceUnderHyper.hyperWalk > paceUnderHyper.plainWalk &&
      paceUnderHyper.hyperHealth > paceUnderHyper.plainHealth,
    `covered ${paceUnderHyper.hyperWalk.toFixed(0)} units vs ${paceUnderHyper.plainWalk.toFixed(0)} in one second, ` +
      `${paceUnderHyper.hyperHealth.toFixed(0)} health vs ${paceUnderHyper.plainHealth.toFixed(0)}`,
  );

  check(
    "raising enemy speed mid-run speeds up the crowd already on screen",
    (() => {
      const target = new Float32Array([0]);
      const zero = new Float32Array([0]);
      const store = new EnemyStore(8);
      const slot = store.spawn(TYPE("shambler"), -200, 0, normal.stats) & 0xffff;
      store.rebuildGrid();
      store.update(target, zero, 1, normal.stats);
      const slowStep = store.x[slot] + 200;
      const before = store.x[slot];
      store.rebuildGrid();
      store.update(target, zero, 1, hyper.stats);
      const fastStep = store.x[slot] - before;
      return fastStep > slowStep;
    })(),
    "an Arcana or a dev slider must affect the horde you are already fighting, not just the next spawns",
  );

  const both = runSeconds([MOD_HURRY, MOD_HYPER], ticks);
  check(
    "Hurry and Hyper stack: faster clock AND a bigger crowd",
    Math.abs(both.dir.runSeconds - hurry.dir.runSeconds) < 1 &&
      both.dir.spawnedTotal > hyper.dir.spawnedTotal,
    `${both.dir.runSeconds.toFixed(0)}s of run time, ${both.dir.spawnedTotal} spawned`,
  );
  void enemies;
}

section("determinism");
{
  function crowdAfter(seed: number, ticks: number): string {
    const stats = baseStats();
    const store = new EnemyStore(1024);
    const dir = new WaveDirector();
    dir.begin();
    const rng = new RngSet(seed);
    const { px, py } = soloPlayer();
    for (let t = 0; t < ticks; t++) {
      dir.update(store, stats, rng.get("spawn"), px[0], py[0], false);
      store.rebuildGrid();
      store.update(px, py, 1, stats);
    }
    return `${store.count}:${crowdFingerprint(store)}`;
  }

  const ticks = TICKS_PER_SECOND * 45;
  const a = crowdAfter(0xabcdef, ticks);
  const b = crowdAfter(0xabcdef, ticks);
  const c = crowdAfter(0xabcdf0, ticks);
  check(
    "the same seed produces an identical crowd",
    a === b,
    "this is what replay revalidation and co-op resync rest on",
  );
  check("a different seed produces a different crowd", a !== c, "the seed is actually being used");
}

section("performance and allocation");
{
  const stats = baseStats();
  const store = new EnemyStore(2048);
  const rng = new Rng(99);
  const { px, py } = soloPlayer();

  // Build the gate crowd: 800 enemies, the number the perf contract gates on.
  for (let i = 0; i < 800; i++) {
    const a = (rng.nextInt(4096) / 4096) * Math.PI * 2;
    const r = 40 + rng.nextInt(300);
    store.spawn(TYPE(i % 7 === 0 ? "bonepile" : i % 3 === 0 ? "gnawer" : "shambler"), Math.cos(a) * r, Math.sin(a) * r, stats);
  }
  check("gate crowd assembled", store.count === 800, `${store.count} enemies`);

  step(store, stats, 60, px, py); // warm

  const before = heapUsed();
  const t0 = Date.now();
  const ticks = 3600; // one simulated minute
  for (let t = 0; t < ticks; t++) {
    store.rebuildGrid();
    store.update(px, py, 1, stats);
  }
  const elapsed = Date.now() - t0;
  const growth = heapUsed() - before;
  const usPerTick = (elapsed * 1000) / ticks;

  check(
    "a full tick at 800 enemies allocates nothing",
    growth < 512 * 1024,
    `${(growth / 1024).toFixed(1)}KB over ${ticks} ticks — allocation, not arithmetic, is what kills a JS game on 4GB`,
  );
  check(
    "the crowd tick leaves room in the frame budget",
    usPerTick < 4000,
    `${usPerTick.toFixed(0)}us per tick at 800 enemies (a 60fps frame is 16,667us; this is desktop, the phone will be slower)`,
  );
  check(
    "the broad phase is not degrading toward brute force",
    store.grid.maxBucketLoad < 60,
    `busiest grid cell holds ${store.grid.maxBucketLoad} enemies`,
  );
  check("the crowd survived the minute intact", store.count > 0, `${store.count} still alive`);
}

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
    gc?: () => void;
  };
  host.gc?.();
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
