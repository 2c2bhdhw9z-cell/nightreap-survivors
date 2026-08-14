/**
 * Enemy roster self-check. Run headless: `bun packages/mobile/game/sim/enemy-content.test.ts`
 *
 * `crowd.test.ts` proves the crowd *machine* works — it separates, it holds a frame at 800, it is the
 * same on two machines. This file is about the *content*: twenty-six rows of numbers, and the ways a
 * wrong number in a table of numbers never announces itself.
 *
 *   1. THE POSITIONS ARE THE WIRE FORMAT. A wave table names an enemy by id, but a replay and a co-op
 *      packet carry the id's *position* in the table. Insert a row in the middle and every recording
 *      made before that day resolves to the wrong monster, silently. So the original six are pinned
 *      here longhand, and the whole table has to resolve back to itself.
 *   2. ONE TOUCH MUST NEVER BE FATAL. Contact damage above a starting character's whole health bar
 *      would mean an unavoidable death with no mistake made, and it reads as an ordinary number in a
 *      table where the boss two rows down legitimately hits for thirty.
 *   3. THE THREE NEW BEHAVIOURS ACTUALLY BEHAVE. A lurker that creeps, a weaver that walks straight or
 *      a flanker that never dives all still *work* — they just quietly become another chaser, and the
 *      roster loses the variety it was grown for. Each one is simulated and measured here.
 *   4. THE CROWD IS STILL ARITHMETIC. The weaver's sway is a triangle wave off an integer tick count
 *      precisely so two phones cannot disagree about it. That is worth a test, because the obvious
 *      implementation — a sine — would pass every other check in the project.
 *   5. NAMED FIGHTS ARE NAMED FIGHTS. Every boss is unshovable, uncullable, holds the health bar, and
 *      is worth more than the one before it. Nothing that is not a boss carries any of that.
 */

import { ModifierStack } from "./modifiers";
import {
  ENEMY_CELL_SIZE,
  ENEMY_FLAG,
  ENEMY_KIND,
  ENEMY_TYPES,
  ENEMY_TYPE_BY_ID,
  EnemyStore,
  FLANKER_CIRCLE_TICKS,
  FLANKER_RING,
  LURKER_WAKE,
  WEAVER_PERIOD,
} from "./enemies";
import { STAT, STAT_BASE, STAT_SCALE, Stats } from "./stats";

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

function soloPlayer(x = 0, y = 0): { px: Float32Array; py: Float32Array } {
  const px = new Float32Array(4);
  const py = new Float32Array(4);
  px[0] = x;
  py[0] = y;
  return { px, py };
}

function typeIndex(id: string): number {
  const found = ENEMY_TYPE_BY_ID.get(id);
  if (found === undefined) throw new Error(`no enemy type ${id}`);
  return found;
}

/** Spawn one enemy of a type at a point and hand back its slot. */
function spawnOne(enemies: EnemyStore, id: string, x: number, y: number, stats: Stats): number {
  const handle = enemies.spawn(typeIndex(id), x, y, stats);
  return handle & 0xffff;
}

function step(enemies: EnemyStore, stats: Stats, ticks: number, px: Float32Array, py: Float32Array): void {
  for (let t = 0; t < ticks; t++) {
    enemies.rebuildGrid();
    enemies.update(px, py, 1, stats);
  }
}

const bosses = ENEMY_TYPES.filter((t) => t.kind === ENEMY_KIND.boss);
const crowd = ENEMY_TYPES.filter((t) => t.kind !== ENEMY_KIND.boss);

// -------------------------------------------------------------------------------------------------
section("the shape of the roster");

check("eighteen things that walk at you", crowd.length === 18, `${crowd.length}`);
check("eight that are named", bosses.length === 8, `${bosses.length}`);
check("and nothing else in the table", ENEMY_TYPES.length === 26, `${ENEMY_TYPES.length} rows`);

{
  const ids = new Set(ENEMY_TYPES.map((t) => t.id));
  check("no two enemies share an id", ids.size === ENEMY_TYPES.length, `${ids.size} distinct`);
}

{
  const sprites = new Set(ENEMY_TYPES.map((t) => t.sprite));
  check("no two enemies share a sprite key", sprites.size === ENEMY_TYPES.length, `${sprites.size} distinct`);
}

{
  // A behaviour held by exactly one enemy is a behaviour the player meets once and never learns. Bosses
  // are exempt: a named fight is supposed to be the only one of itself.
  const held = new Map<number, number>();
  for (const t of crowd) held.set(t.kind, (held.get(t.kind) ?? 0) + 1);
  const lonely: string[] = [];
  for (const [kind, count] of held) {
    if (count < 2) lonely.push(`kind ${kind} has ${count}`);
  }
  const summary = [...held.entries()].map(([k, n]) => `${k}:${n}`).join(" ");
  check("every behaviour is held by at least two of the crowd", lonely.length === 0, lonely.join("; ") || summary);
}

{
  // Every behaviour the steering switch can handle is one somebody actually uses. A kind nobody uses is
  // a branch nothing exercises, and it will rot without ever failing a test.
  const used = new Set(ENEMY_TYPES.map((t) => t.kind));
  const unused = Object.entries(ENEMY_KIND)
    .filter(([, v]) => !used.has(v))
    .map(([k]) => k);
  check("every behaviour the crowd can steer is used by somebody", unused.length === 0, unused.join(", ") || "all used");
}

// -------------------------------------------------------------------------------------------------
section("positions, which are what replays and co-op packets carry");

{
  let wrong = 0;
  for (let i = 0; i < ENEMY_TYPES.length; i++) {
    if (ENEMY_TYPE_BY_ID.get(ENEMY_TYPES[i].id) !== i) wrong++;
  }
  check("every id resolves back to its own position", wrong === 0, `${wrong} wrong`);
  check("  and the lookup covers the whole table", ENEMY_TYPE_BY_ID.size === ENEMY_TYPES.length);
}

{
  // Pinned longhand, not derived. The point of this check is to fail when somebody inserts a row above
  // one of these, and a check that computed the expected positions would move along with the mistake.
  const shipped: readonly [string, number][] = [
    ["shambler", 0],
    ["gnawer", 1],
    ["bonepile", 2],
    ["hound", 3],
    ["wisp", 4],
    ["gravewarden", 5],
  ];
  let moved = 0;
  for (const [id, at] of shipped) {
    if (ENEMY_TYPE_BY_ID.get(id) !== at) moved++;
  }
  check("the six that shipped first are still where they shipped", moved === 0, `${moved} moved`);
}

// -------------------------------------------------------------------------------------------------
section("numbers that would not look wrong");

{
  const startingHealth = STAT_BASE[STAT.maxHealth] / STAT_SCALE;
  const lethal = ENEMY_TYPES.filter((t) => t.damage >= startingHealth).map((t) => t.id);
  check(
    "nothing kills a starting character in one touch",
    lethal.length === 0,
    lethal.join(", ") || `hardest hit ${Math.max(...ENEMY_TYPES.map((t) => t.damage))} vs ${startingHealth} health`,
  );
}

{
  let faults = 0;
  const detail: string[] = [];
  for (const t of ENEMY_TYPES) {
    // Zero health is dead on arrival, zero speed is scenery, zero radius cannot be hit, and a negative
    // anything is a sign flip somebody will spend a day on.
    if (!(t.health > 0)) detail.push(`${t.id} health ${t.health}`);
    if (!(t.damage > 0)) detail.push(`${t.id} damage ${t.damage}`);
    if (!(t.speed > 0)) detail.push(`${t.id} speed ${t.speed}`);
    if (!(t.radius > 0)) detail.push(`${t.id} radius ${t.radius}`);
    if (!(t.xp > 0)) detail.push(`${t.id} xp ${t.xp}`);
    if (t.goldChance < 0 || t.goldChance > 1000) detail.push(`${t.id} gold ${t.goldChance}`);
  }
  faults = detail.length;
  check("every enemy is alive, dangerous, hittable and worth something", faults === 0, detail.join("; ") || "all sane");
}

{
  // Separation looks one grid cell out. A body wider than a cell would sit half outside every query it
  // makes, so it would push through its own crowd — which reads as a bug in the physics, not in a table.
  const oversize = ENEMY_TYPES.filter((t) => t.radius > ENEMY_CELL_SIZE).map((t) => t.id);
  check("nobody is wider than the grid the crowd separates on", oversize.length === 0, oversize.join(", ") || `cell ${ENEMY_CELL_SIZE}`);
}

{
  // Reward has to track threat, or the player learns to walk past the dangerous rows. Compared inside the
  // crowd only — a boss is worth more than its health suggests on purpose.
  const bad: string[] = [];
  for (const a of crowd) {
    for (const b of crowd) {
      if (a.health > b.health * 2 && a.xp < b.xp) bad.push(`${a.id} is tougher than ${b.id} and worth less`);
    }
  }
  check("a tougher body in the crowd is never worth less", bad.length === 0, bad.join("; ") || "reward tracks threat");
}

{
  // A fast heavy thing is the one combination with no counter: it cannot be outrun and cannot be shoved.
  // Chargers are allowed to be both because a charge is dodged sideways, which is a real answer.
  const bad = ENEMY_TYPES.filter(
    (t) =>
      t.kind !== ENEMY_KIND.charger &&
      t.kind !== ENEMY_KIND.boss &&
      (t.flags & ENEMY_FLAG.heavy) !== 0 &&
      t.speed > 60,
  ).map((t) => t.id);
  check("nothing is unshovable and faster than a player at once", bad.length === 0, bad.join(", ") || "none are");
}

// -------------------------------------------------------------------------------------------------
section("named fights");

{
  const want = ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent;
  const wrong = bosses.filter((t) => (t.flags & want) !== want).map((t) => t.id);
  check("every boss is unshovable, uncullable, and holds the health bar", wrong.length === 0, wrong.join(", ") || "all eight");
}

{
  const pretenders = crowd.filter((t) => (t.flags & ENEMY_FLAG.boss) !== 0).map((t) => t.id);
  check("nothing in the crowd claims the health bar", pretenders.length === 0, pretenders.join(", ") || "none do");
}

{
  // Bosses are handed out in table order across the stages, so a later one that is weaker than an earlier
  // one would be a fight that goes backwards.
  let regressions = 0;
  for (let i = 1; i < bosses.length; i++) {
    if (bosses[i].health <= bosses[i - 1].health) regressions++;
    if (bosses[i].xp <= bosses[i - 1].xp) regressions++;
  }
  check("each boss is a bigger fight than the one before", regressions === 0, `${regressions} regressions`);
}

{
  const stingy = bosses.filter((t) => t.goldChance !== 1000).map((t) => t.id);
  check("a boss always pays", stingy.length === 0, stingy.join(", ") || "all of them drop gold");
}

{
  // A boss with crowd-sized health would die to a stray shot before its own music finished. The floor is
  // 800 rather than a round thousand because the first boss shipped at 900 and is the five-minute fight —
  // the number that matters is that it is an order of magnitude above the toughest body in the crowd.
  const thin = bosses.filter((t) => t.health < 800).map((t) => t.id);
  check("no boss has crowd-sized health", thin.length === 0, thin.join(", ") || `weakest ${Math.min(...bosses.map((t) => t.health))}`);
}

// -------------------------------------------------------------------------------------------------
section("a lurker stands still until you walk into it");

{
  const stats = baseStats();
  const enemies = new EnemyStore(64);
  const far = soloPlayer(600, 0);
  const slot = spawnOne(enemies, "tomblurker", 0, 0, stats);
  step(enemies, stats, 120, far.px, far.py);
  const movedAsleep = Math.hypot(enemies.x[slot], enemies.y[slot]);
  check("two seconds with the player far away and it has not moved", movedAsleep < 0.001, `${movedAsleep.toFixed(4)} units`);

  const near = soloPlayer(LURKER_WAKE - 10, 0);
  step(enemies, stats, 60, near.px, near.py);
  const gap = Math.hypot(near.px[0] - enemies.x[slot], near.py[0] - enemies.y[slot]);
  check("  and it closes once somebody is inside its reach", gap < LURKER_WAKE - 20, `${gap.toFixed(1)} units away`);
}

{
  // The wake distance has to be shorter than the spawn ring, or a lurker would wake up the instant it
  // arrived and simply be a slow chaser.
  const enemies = new EnemyStore(8);
  const stats = baseStats();
  const player = soloPlayer(LURKER_WAKE + 40, 0);
  const slot = spawnOne(enemies, "nightcap", 0, 0, stats);
  step(enemies, stats, 60, player.px, player.py);
  const moved = Math.hypot(enemies.x[slot], enemies.y[slot]);
  check("a lurker just outside the wake distance is still asleep", moved < 0.001, `${moved.toFixed(4)} units`);
}

// -------------------------------------------------------------------------------------------------
section("a weaver does not walk in a straight line");

{
  const stats = baseStats();
  const enemies = new EnemyStore(8);
  const player = soloPlayer(0, 0);
  const slot = spawnOne(enemies, "bloatfly", 300, 0, stats);
  let maxOffLine = 0;
  let lastDist = Math.hypot(enemies.x[slot], enemies.y[slot]);
  let closedEveryStretch = true;
  for (let t = 0; t < WEAVER_PERIOD * 2; t++) {
    enemies.rebuildGrid();
    enemies.update(player.px, player.py, 1, stats);
    // The straight line from spawn to the player is the x axis, so any y at all is a deviation.
    maxOffLine = Math.max(maxOffLine, Math.abs(enemies.y[slot]));
    if (t % WEAVER_PERIOD === WEAVER_PERIOD - 1) {
      const dist = Math.hypot(enemies.x[slot], enemies.y[slot]);
      if (dist >= lastDist) closedEveryStretch = false;
      lastDist = dist;
    }
  }
  check("it leaves the straight line on the way in", maxOffLine > 8, `${maxOffLine.toFixed(1)} units off line`);
  check("  but it still closes, every full sway", closedEveryStretch, `${lastDist.toFixed(1)} units away`);
}

{
  // The sway is a triangle wave off an integer tick count. Run the same spawn twice and the paths have to
  // be identical to the last decimal — which is the property a `Math.sin` would put at risk across two
  // different phones running the same co-op session.
  const stats = baseStats();
  const player = soloPlayer(0, 0);
  const paths: string[] = [];
  for (let run = 0; run < 2; run++) {
    const enemies = new EnemyStore(8);
    const slot = spawnOne(enemies, "gravemoth", 260, 40, stats);
    const trail: string[] = [];
    for (let t = 0; t < 200; t++) {
      enemies.rebuildGrid();
      enemies.update(player.px, player.py, 1, stats);
      trail.push(`${enemies.x[slot].toFixed(6)},${enemies.y[slot].toFixed(6)}`);
    }
    paths.push(trail.join("|"));
  }
  check("two runs of the same weaver trace the identical path", paths[0] === paths[1]);
}

// -------------------------------------------------------------------------------------------------
section("a flanker circles, then commits");

{
  const stats = baseStats();
  const enemies = new EnemyStore(8);
  const player = soloPlayer(0, 0);
  const slot = spawnOne(enemies, "bonehound", 300, 0, stats);

  let closestWhileCircling = Infinity;
  for (let t = 0; t < FLANKER_CIRCLE_TICKS; t++) {
    enemies.rebuildGrid();
    enemies.update(player.px, player.py, 1, stats);
    closestWhileCircling = Math.min(closestWhileCircling, Math.hypot(enemies.x[slot], enemies.y[slot]));
  }
  check(
    "it keeps its distance while it winds up",
    closestWhileCircling > FLANKER_RING * 0.6,
    `${closestWhileCircling.toFixed(1)} units at its closest`,
  );

  // It spawned due east of the player. The circling is what carries it around to another side, so that
  // is where the movement is measured — the dive itself is straight in, and measuring the angle during the
  // dive would be measuring nothing and passing anyway.
  const angleAfterCircling = Math.abs(Math.atan2(enemies.y[slot], enemies.x[slot]));
  check("  and the wind-up carried it around to another side", angleAfterCircling > 0.5, `${angleAfterCircling.toFixed(2)} radians around`);

  step(enemies, stats, 90, player.px, player.py);
  const after = Math.hypot(enemies.x[slot], enemies.y[slot]);
  check("  then it dives", after < closestWhileCircling * 0.7, `${after.toFixed(1)} units away`);
}

// -------------------------------------------------------------------------------------------------
section("the new behaviours are still the same crowd");

{
  // Every kind, dumped together, must survive a minute of simulation without anybody flying off to
  // infinity or landing on a not-a-number — the two ways a steering bug shows up much later, as an
  // enemy that has quietly stopped existing on screen.
  const stats = baseStats();
  const enemies = new EnemyStore(256);
  const player = soloPlayer(0, 0);
  const slots: number[] = [];
  for (const t of ENEMY_TYPES) {
    for (let i = 0; i < 3; i++) {
      slots.push(spawnOne(enemies, t.id, 120 + i * 40, i * 37 - 40, stats));
    }
  }
  step(enemies, stats, 60 * 60, player.px, player.py);
  let broken = 0;
  for (const s of slots) {
    if (!enemies.pool.isSlotAlive(s)) continue;
    if (!Number.isFinite(enemies.x[s]) || !Number.isFinite(enemies.y[s])) broken++;
    if (Math.abs(enemies.x[s]) > 100_000 || Math.abs(enemies.y[s]) > 100_000) broken++;
  }
  check("a minute with all twenty-six kinds on screen leaves everybody somewhere real", broken === 0, `${broken} broken`);
}

{
  // A heavy enemy ignores a shove; a light one does not. Checked on the new rows specifically, because a
  // flag copied from the row above is the easiest mistake in a table this long.
  const stats = baseStats();
  const enemies = new EnemyStore(16);
  const heavy = spawnOne(enemies, "nightcap", 50, 0, stats);
  const light = spawnOne(enemies, "graveling", 50, 40, stats);
  enemies.knockback(heavy, 1, 0, 300);
  enemies.knockback(light, 1, 0, 300);
  check("the heavy new ambusher shrugs off a shove", enemies.vx[heavy] === 0, `${enemies.vx[heavy]}`);
  check("  and a light new walker does not", enemies.vx[light] > 0, `${enemies.vx[light]}`);
}

// -------------------------------------------------------------------------------------------------
if (failures > 0) {
  console.log(`\nFAIL — ${failures} check${failures === 1 ? "" : "s"} failed`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`enemy-content: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log(`\nPASS — ${crowd.length} in the crowd, ${bosses.length} named fights`);
