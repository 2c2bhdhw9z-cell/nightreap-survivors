/**
 * Player self-check. Run headless: `bun packages/mobile/game/sim/player.test.ts`
 *
 * The player is the one entity the game cannot get wrong without the player noticing immediately.
 * Two failure modes matter more than the rest:
 *
 *   1. Movement that is not exactly the same on two machines. Position feeds the co-op state hash
 *      and the replay revalidator, so the diagonal clamp and the facing choice are held to exact
 *      arithmetic — no atan2, no hypot, no drift.
 *   2. Damage rules that quietly become immortality. i-frames, armor and revives interact, and every
 *      one of them can accidentally make incoming damage zero. Armor floors at 1 on purpose and this
 *      file asserts it, so a future armor buff cannot silently turn into godmode.
 *
 * WHAT IT PROVES
 *   1. Diagonal input is clamped to the unit circle, so diagonals are not 1.41x faster.
 *   2. All eight facings come out of `facingFor`, the tan(22.5) boundaries land on the right side,
 *      and a zero vector keeps the previous facing instead of snapping south.
 *   3. Movement covers the expected distance in one second, and scales with `STAT.moveSpeed`.
 *   4. i-frames block a second hit, and expire on schedule.
 *   5. Armor reduces damage but never below 1.
 *   6. A revive is spent on death and restores full health without downing the player.
 *   7. Solo: health reaching zero ends the run the same tick, with no corpse countdown.
 *   8. Co-op: a downed player is revived by a neighbour, two rescuers are twice as fast, progress
 *      decays instead of resetting when the rescuer steps away, and the timer kills them if nobody comes.
 *   9. Regen applies whole hit points only, and never overheals.
 *  10. `writeTargets` compacts to upright players and never returns zero targets.
 *  11. Enemy contact damage lands through the grid, respects i-frames, and ignores phasing enemies.
 *  12. A full tick allocates nothing.
 */

import { ENEMY_TYPE_BY_ID, ENEMY_TYPES, EnemyStore } from "./enemies";
import { ModifierStack } from "./modifiers";
import {
  BASE_MOVE_SPEED,
  DOWN_TICKS,
  FACING,
  type Facing,
  MAX_PLAYERS,
  PLAYER_STATE,
  PlayerStore,
  REVIVE_RANGE,
  REVIVE_TICKS,
  facingFor,
} from "./player";
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

/** Overwrite one stat directly. Tests want a knob, not a whole modifier record. */
function withStat(stats: Stats, id: number, permille: number): Stats {
  stats.values[id] = permille;
  stats.clampAll();
  return stats;
}

const TYPE = (id: string): number => ENEMY_TYPE_BY_ID.get(id) ?? 0;

function step(players: PlayerStore, stats: Stats, ticks: number, enemies: EnemyStore | null = null): void {
  for (let t = 0; t < ticks; t++) {
    if (enemies) enemies.rebuildGrid();
    players.update(stats, enemies);
  }
}

section("movement");
{
  const players = new PlayerStore();
  const stats = baseStats();
  players.reset(1, stats);

  players.setMove(0, 1, 1);
  const len = Math.sqrt(players.moveX[0] ** 2 + players.moveY[0] ** 2);
  check(
    "diagonal input is clamped to the unit circle",
    Math.abs(len - 1) < 0.0001,
    `length ${len.toFixed(4)}`,
  );

  players.setMove(0, 0.3, 0);
  check(
    "input already inside the circle is left alone",
    // Float32 storage, so 0.3 comes back as 0.30000001. Compared with a tolerance on purpose: the
    // arrays are Float32 precisely so every device rounds the same way.
    Math.abs(players.moveX[0] - 0.3) < 1e-6 && players.moveY[0] === 0,
    `moveX ${players.moveX[0]}`,
  );

  players.reset(1, stats);
  players.setMove(0, 1, 0);
  step(players, stats, 60);
  check(
    "one second of walking covers the base speed",
    Math.abs(players.x[0] - BASE_MOVE_SPEED) < 0.01,
    `travelled ${players.x[0].toFixed(2)} units, expected ${BASE_MOVE_SPEED}`,
  );

  const fast = withStat(baseStats(), STAT.moveSpeed, 1500);
  const runner = new PlayerStore();
  runner.reset(1, fast);
  runner.setMove(0, 1, 0);
  step(runner, fast, 60);
  check(
    "move speed scales the distance covered",
    Math.abs(runner.x[0] - BASE_MOVE_SPEED * 1.5) < 0.01,
    `travelled ${runner.x[0].toFixed(2)} units at +50% speed`,
  );

  players.reset(1, stats);
  players.setMove(0, 1, 1);
  const startX = players.x[0];
  step(players, stats, 60);
  const diagonalDist = Math.hypot(players.x[0] - startX, players.y[0]);
  check(
    "a diagonal second covers the same ground as a straight one",
    Math.abs(diagonalDist - BASE_MOVE_SPEED) < 0.01,
    `travelled ${diagonalDist.toFixed(2)} units diagonally`,
  );

  players.reset(1, stats);
  players.setMove(0, 0, 0);
  step(players, stats, 10);
  check("standing still does not move the player", players.x[0] === 0 && players.y[0] === 0);
  check("standing still reports not moving", players.moving[0] === 0);
  players.setMove(0, 0, 1);
  step(players, stats, 1);
  check("walking reports moving", players.moving[0] === 1);
  check(
    "the previous position is kept for render interpolation",
    players.prevY[0] !== players.y[0],
    `prev ${players.prevY[0].toFixed(3)} now ${players.y[0].toFixed(3)}`,
  );
}

section("facing");
{
  // Screen space: +y is south, +x is east.
  const cases: Array<[number, number, Facing, string]> = [
    [0, 1, FACING.south, "south"],
    [-1, 1, FACING.southWest, "south-west"],
    [-1, 0, FACING.west, "west"],
    [-1, -1, FACING.northWest, "north-west"],
    [0, -1, FACING.north, "north"],
    [1, -1, FACING.northEast, "north-east"],
    [1, 0, FACING.east, "east"],
    [1, 1, FACING.southEast, "south-east"],
  ];
  let allEight = true;
  const seen = new Set<number>();
  for (const [dx, dy, want, label] of cases) {
    const got = facingFor(dx, dy, FACING.south);
    seen.add(got);
    if (got !== want) {
      allEight = false;
      check(`facing ${label}`, false, `got ${got}, wanted ${want}`);
    }
  }
  check("all eight facings resolve correctly", allEight && seen.size === 8, `${seen.size} distinct facings`);

  // tan(22.5deg) = 0.41421356. Just inside is cardinal, just outside is diagonal.
  check(
    "just inside the diagonal boundary stays cardinal",
    facingFor(1, 0.41, FACING.south) === FACING.east,
    "1, 0.41 reads east",
  );
  check(
    "just outside the diagonal boundary becomes diagonal",
    facingFor(1, 0.42, FACING.south) === FACING.southEast,
    "1, 0.42 reads south-east",
  );
  check(
    "the same boundary holds on the vertical axis",
    facingFor(0.41, 1, FACING.south) === FACING.south &&
      facingFor(0.42, 1, FACING.south) === FACING.southEast,
  );
  check(
    "a zero vector keeps the previous facing",
    facingFor(0, 0, FACING.northWest) === FACING.northWest,
  );
  check(
    "a vector too small to read keeps the previous facing",
    facingFor(0.00001, -0.00001, FACING.east) === FACING.east,
  );

  const players = new PlayerStore();
  const stats = baseStats();
  players.reset(1, stats);
  players.setMove(0, -1, 0);
  step(players, stats, 1);
  check("walking west sets the west facing", players.facing[0] === FACING.west);
  players.setMove(0, 0, 0);
  step(players, stats, 1);
  check("releasing the stick keeps the last facing", players.facing[0] === FACING.west);
}

section("damage, armor and i-frames");
{
  const stats = withStat(baseStats(), STAT.iFrames, 30);
  const players = new PlayerStore();
  players.reset(1, stats);
  const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;

  const first = players.damage(0, 10, stats);
  check("the first hit lands", first && players.health[0] === maxHealth - 10, `health ${players.health[0]}`);
  const second = players.damage(0, 10, stats);
  check("a second hit inside the i-frame window is refused", !second && players.health[0] === maxHealth - 10);
  check("damage taken is tallied for the results screen", players.damageTaken === 10);

  step(players, stats, 30);
  check("i-frames expire on schedule", players.invuln[0] === 0, `${players.invuln[0]} ticks left`);
  check("a hit lands again once i-frames are gone", players.damage(0, 10, stats));

  const armored = withStat(baseStats(), STAT.armor, 3);
  const tank = new PlayerStore();
  tank.reset(1, armored);
  const tankMax = armored.get(STAT.maxHealth) / STAT_SCALE;
  tank.damage(0, 10, armored);
  check(
    "armor subtracts flat from incoming damage",
    tank.health[0] === tankMax - 7,
    `took ${tankMax - tank.health[0]} from a 10 damage hit with 3 armor`,
  );

  const wall = withStat(baseStats(), STAT.armor, 999_999);
  const brick = new PlayerStore();
  brick.reset(1, wall);
  const brickMax = wall.get(STAT.maxHealth) / STAT_SCALE;
  brick.damage(0, 5, wall);
  check(
    "armor never reduces a hit below 1 — no accidental immortality",
    brick.health[0] === brickMax - 1,
    `took ${brickMax - brick.health[0]} from a 5 damage hit with maximum armor`,
  );

  const healer = new PlayerStore();
  const hs = baseStats();
  healer.reset(1, hs);
  const hsMax = hs.get(STAT.maxHealth) / STAT_SCALE;
  healer.damage(0, 20, hs);
  healer.heal(0, 5, hs);
  check("healing restores health", healer.health[0] === hsMax - 15);
  healer.heal(0, 9999, hs);
  check("healing cannot overheal", healer.health[0] === hsMax, `health ${healer.health[0]} of ${hsMax}`);
}

section("revives and death");
{
  const stats = withStat(baseStats(), STAT.revives, 1);
  const players = new PlayerStore();
  players.reset(1, stats);
  const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;
  check("revives are seeded from the stat", players.revivesLeft[0] === 1);

  players.damage(0, 9999, stats);
  check(
    "a revive is spent instead of dying",
    players.state[0] === PLAYER_STATE.alive && players.revivesLeft[0] === 0,
    `state ${players.state[0]}`,
  );
  check("the revive restores full health", players.health[0] === maxHealth, `health ${players.health[0]}`);
  check("the revive grants a grace period", players.invuln[0] >= 120, `${players.invuln[0]} ticks`);
  check("the down was still counted", players.downs === 1);

  step(players, stats, 200);
  players.damage(0, 9999, stats);
  check("with no revives left the player goes down", players.state[0] === PLAYER_STATE.downed);
  step(players, stats, 1);
  check(
    "solo: going down ends the run the same tick, with no corpse countdown",
    players.state[0] === PLAYER_STATE.dead && players.runOver,
    `state ${players.state[0]}`,
  );
  check("a dead solo player is not alive", !players.anyAlive);
}

section("co-op revives");
{
  const stats = baseStats();
  const players = new PlayerStore();
  players.reset(2, stats);
  const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;

  // Put both players on top of each other so player 1 is in revive range of player 0.
  players.x[0] = 0;
  players.y[0] = 0;
  players.x[1] = 4;
  players.y[1] = 0;
  players.damage(0, 9999, stats);
  check("a downed co-op player is downed, not dead", players.state[0] === PLAYER_STATE.downed);
  check("the death timer starts", players.downTicks[0] === DOWN_TICKS);

  step(players, stats, 1);
  check("a nearby ally banks revive progress", players.reviveTicks[0] === 1, `${players.reviveTicks[0]} ticks`);

  step(players, stats, REVIVE_TICKS);
  check(
    "one rescuer completes the revive",
    players.state[0] === PLAYER_STATE.alive,
    `state ${players.state[0]}`,
  );
  check(
    "the revived player comes back at half health",
    Math.abs(players.health[0] - maxHealth * 0.5) < 0.001,
    `health ${players.health[0]} of ${maxHealth}`,
  );
  check(
    "the revived player gets a grace period",
    players.invuln[0] >= 100,
    `${players.invuln[0]} ticks (one already ticked off since the rescue)`,
  );

  // Two rescuers should bank twice as fast as one.
  const trio = new PlayerStore();
  trio.reset(3, stats);
  trio.x[0] = 0;
  trio.y[0] = 0;
  trio.x[1] = 4;
  trio.x[2] = -4;
  trio.damage(0, 9999, stats);
  step(trio, stats, 10);
  check(
    "two rescuers revive twice as fast as one",
    trio.reviveTicks[0] === 20,
    `${trio.reviveTicks[0]} ticks banked in 10 ticks`,
  );

  // Stepping out of range should decay progress, not throw it away.
  trio.x[1] = REVIVE_RANGE * 4;
  trio.x[2] = REVIVE_RANGE * 4;
  step(trio, stats, 5);
  check(
    "progress decays when the rescuers step away instead of resetting",
    trio.reviveTicks[0] === 15,
    `${trio.reviveTicks[0]} ticks left of 20`,
  );

  // Nobody comes: the timer runs out.
  const abandoned = new PlayerStore();
  abandoned.reset(2, stats);
  abandoned.x[1] = 5000;
  abandoned.damage(0, 9999, stats);
  step(abandoned, stats, DOWN_TICKS + 1);
  check(
    "an abandoned downed player dies when the timer runs out",
    abandoned.state[0] === PLAYER_STATE.dead,
    `state ${abandoned.state[0]}`,
  );
  check("the surviving ally keeps the run going", abandoned.anyAlive && !abandoned.runOver);
}

section("regen");
{
  // 5 health per second: 1 whole point should land every 12 ticks and nothing in between.
  const stats = withStat(baseStats(), STAT.regen, 5000);
  const players = new PlayerStore();
  players.reset(1, stats);
  players.damage(0, 20, stats);
  const start = players.health[0];

  let fractional = false;
  for (let t = 0; t < 60; t++) {
    step(players, stats, 1);
    if (players.health[0] !== Math.floor(players.health[0])) fractional = true;
  }
  check("regen never produces fractional health", !fractional, `health ${players.health[0]}`);
  check(
    "one second of regen restores the stat's worth of health",
    players.health[0] - start === 5,
    `restored ${players.health[0] - start} in a second at 5/s`,
  );

  step(players, stats, 60 * 20);
  const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;
  check("regen stops at full health", players.health[0] === maxHealth, `health ${players.health[0]}`);

  const noRegen = new PlayerStore();
  const flat = baseStats();
  noRegen.reset(1, flat);
  noRegen.damage(0, 10, flat);
  const hurt = noRegen.health[0];
  step(noRegen, flat, 600);
  check("with no regen stat health does not creep back", noRegen.health[0] === hurt);
}

section("targets for the crowd");
{
  const stats = baseStats();
  const players = new PlayerStore();
  players.reset(3, stats);
  players.x[0] = 10;
  players.x[1] = 20;
  players.x[2] = 30;
  const outX = new Float32Array(MAX_PLAYERS);
  const outY = new Float32Array(MAX_PLAYERS);

  check("all upright players are targets", players.writeTargets(outX, outY) === 3);

  players.state[1] = PLAYER_STATE.dead;
  const n = players.writeTargets(outX, outY);
  check(
    "the dead are compacted out, not left as holes",
    n === 2 && outX[0] === 10 && outX[1] === 30,
    `${n} targets: ${outX[0]}, ${outX[1]}`,
  );

  players.state[0] = PLAYER_STATE.dead;
  players.state[2] = PLAYER_STATE.dead;
  const none = players.writeTargets(outX, outY);
  check(
    "with nobody upright the crowd still gets one target so it does not freeze",
    none === 1 && outX[0] === 10,
    `${none} target at ${outX[0]}`,
  );

  const near = new PlayerStore();
  near.reset(2, stats);
  near.x[0] = 0;
  near.x[1] = 100;
  check("nearest upright player is found", near.nearestAlive(90, 0) === 1);
  near.state[1] = PLAYER_STATE.downed;
  check("a downed player is not a valid target", near.nearestAlive(90, 0) === 0);
  near.state[0] = PLAYER_STATE.dead;
  check("with nobody upright there is no target", near.nearestAlive(90, 0) === -1);

  const hashed = new PlayerStore();
  hashed.reset(2, stats);
  hashed.x[0] = 1;
  hashed.y[0] = 2;
  hashed.x[1] = 3;
  hashed.y[1] = 4;
  const view = hashed.hashablePositions();
  check(
    "hashable positions are interleaved and sized to the player count",
    view.length === 4 && view[0] === 1 && view[1] === 2 && view[2] === 3 && view[3] === 4,
    `length ${view.length}`,
  );
  check("the hashable view is reused, not reallocated", hashed.hashablePositions() === view);
}

section("enemy contact");
{
  const stats = withStat(baseStats(), STAT.iFrames, 30);
  const players = new PlayerStore();
  players.reset(1, stats);
  const enemies = new EnemyStore(256);
  const maxHealth = stats.get(STAT.maxHealth) / STAT_SCALE;
  const shambler = TYPE("shambler");
  const contactDamage = ENEMY_TYPES[shambler].damage;

  enemies.spawn(shambler, 2, 0, stats);
  step(players, stats, 1, enemies);
  check(
    "an enemy standing on the player deals its contact damage",
    players.health[0] === maxHealth - contactDamage,
    `health ${players.health[0]} of ${maxHealth}`,
  );

  // Six more bodies piled on the same spot must not deal six more hits in one tick.
  for (let i = 0; i < 6; i++) enemies.spawn(shambler, 2, 0, stats);
  const before = players.health[0];
  step(players, stats, 1, enemies);
  check(
    "a pile of enemies cannot burst the player down in one tick",
    players.health[0] === before,
    `health ${players.health[0]}`,
  );

  step(players, stats, 30, enemies);
  check(
    "once i-frames lapse the pile hits again, exactly once",
    players.health[0] === before - contactDamage,
    `health ${players.health[0]}`,
  );

  const far = new PlayerStore();
  far.reset(1, stats);
  const empty = new EnemyStore(256);
  empty.spawn(shambler, 500, 500, stats);
  step(far, stats, 10, empty);
  check("a distant enemy does not reach the player", far.health[0] === maxHealth);

  const grid = new EnemyStore(256);
  const found = (() => {
    grid.spawn(shambler, 0, 0, stats);
    grid.spawn(shambler, 1000, 1000, stats);
    grid.rebuildGrid();
    return grid.queryNear(0, 0, 30);
  })();
  check(
    "the broad-phase query returns only nearby enemies",
    found === 1 && grid.neighbourScratch[0] === 0,
    `${found} found`,
  );
}

section("performance");
{
  const stats = baseStats();
  const players = new PlayerStore();
  players.reset(4, stats);
  const enemies = new EnemyStore(1024);
  for (let i = 0; i < 800; i++) {
    const a = (i / 800) * Math.PI * 2;
    enemies.spawn(TYPE("shambler"), Math.cos(a) * (60 + (i % 200)), Math.sin(a) * (60 + (i % 200)), stats);
  }
  for (let i = 0; i < 4; i++) players.setMove(i, 1, 1);

  // Warm up so the measurement is of steady state, not of the optimiser catching up.
  step(players, stats, 600, enemies);

  const before = heapUsed();
  const t0 = performance.now();
  step(players, stats, 3600, enemies);
  const elapsed = performance.now() - t0;
  const growthKb = (heapUsed() - before) / 1024;

  check(
    "a minute of player ticks with 4 players and 800 enemies allocates nothing",
    growthKb < 64,
    `${growthKb.toFixed(1)}KB over 3600 ticks`,
  );
  check(
    "player ticks are a rounding error in the frame budget",
    elapsed / 3600 < 0.5,
    `${((elapsed / 3600) * 1000).toFixed(0)}us per tick`,
  );
  check("everyone is still standing after the minute", players.anyAlive);
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
