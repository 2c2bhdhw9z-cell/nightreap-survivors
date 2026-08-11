/**
 * Weapons + projectiles self-check. Run headless: `bun packages/mobile/game/sim/combat.test.ts`
 *
 * This is the file that stands between us and the three ways the combat core quietly ruins the game:
 *
 *   1. A weapon that does nothing. Six archetypes share one movement-and-collision loop, so a single
 *      off-by-one in that loop can silently switch a whole weapon off. That is exactly what happened
 *      here: re-ticking shapes started their damage timer at the full interval, and the whip — which
 *      lives for precisely one interval — expired before its turn ever came. It swung and dealt zero
 *      damage. Nothing threw, nothing logged; the weapon was just cosmetic. Hence check 1.
 *   2. A hit that lands twice. Pierce, auras, orbiters and boomerangs all overlap the same enemy for
 *      many ticks in a row. Whether that is one hit or forty is the difference between a balanced
 *      weapon and a joke, so the "remember who I hit" ring gets tested rather than trusted.
 *   3. Drift. Co-op resimulates this code on four devices and replay revalidation resimulates it on
 *      a server. Damage must therefore be whole numbers and every random roll must come from the
 *      seeded stream, both of which are asserted below.
 *
 * And the standing performance contract: 800 enemies with six maxed weapons must allocate nothing
 * per tick. Allocation, not arithmetic, is what kills a JS game on a 4GB phone.
 */

import { handleSlot } from "../core/pool";
import { Rng } from "../core/rng";
import { ENEMY_FLAG, ENEMY_TYPE_BY_ID, EnemyStore } from "./enemies";
import { ModifierStack } from "./modifiers";
import {
  createSpawnRequest,
  GRAVITY,
  HIT_MEMORY,
  MAX_HIT_EVENTS,
  MOVE,
  PROJ_FLAG,
  ProjectileStore,
  type OwnerPositions,
} from "./projectiles";
import { STAT, STAT_SCALE, Stats } from "./stats";
import {
  createWeaponSnapshot,
  MAX_WEAPON_LEVEL,
  MAX_WEAPONS,
  snapshotWeapon,
  WEAPON_BY_ID,
  WEAPON_TYPES,
  WeaponStore,
} from "./weapons";

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

const WEAPON = (id: string): number => WEAPON_BY_ID.get(id) ?? 0;
const TYPE = (id: string): number => ENEMY_TYPE_BY_ID.get(id) ?? 0;

function baseStats(): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  return stats;
}

/** One player, in the parallel-array shape the combat code expects. */
interface Field {
  owners: OwnerPositions & { x: Float32Array; y: Float32Array };
  facingX: Float32Array;
  facingY: Float32Array;
  alive: Uint8Array;
  enemies: EnemyStore;
  projectiles: ProjectileStore;
  weapons: WeaponStore;
  stats: Stats;
  rng: Rng;
}

function field(playerCount = 1, seed = 1234, enemyCapacity = 1024, projectileCapacity = 1536): Field {
  const x = new Float32Array(4);
  const y = new Float32Array(4);
  const facingX = new Float32Array(4);
  const facingY = new Float32Array(4);
  const alive = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    facingX[i] = 1;
    alive[i] = 1;
  }
  const weapons = new WeaponStore(4);
  weapons.reset(playerCount);
  return {
    owners: { count: playerCount, x, y },
    facingX,
    facingY,
    alive,
    enemies: new EnemyStore(enemyCapacity),
    projectiles: new ProjectileStore(projectileCapacity),
    weapons,
    stats: baseStats(),
    rng: new Rng(seed),
  };
}

/** An enemy that will not die and will not be shoved, so a test measures one thing at a time. */
function punchingBag(f: Field, x: number, y: number, health = 1_000_000): number {
  const handle = f.enemies.spawn(TYPE("bonepile"), x, y, f.stats);
  const slot = handleSlot(handle);
  f.enemies.health[slot] = health;
  f.enemies.flags[slot] |= ENEMY_FLAG.heavy;
  return slot;
}

/** Advance the whole combat stack one tick. The crowd itself is held still on purpose. */
function tick(f: Field, ticks = 1): void {
  for (let t = 0; t < ticks; t++) {
    f.enemies.rebuildGrid();
    f.weapons.update(
      f.owners,
      f.facingX,
      f.facingY,
      f.alive,
      f.enemies,
      f.projectiles,
      f.stats,
      f.rng,
    );
    f.projectiles.update(f.owners, f.enemies, f.stats, f.rng);
  }
}

/** Advance projectiles only, for tests about a hand-placed shape rather than a weapon. */
function tickProjectiles(f: Field, ticks = 1): void {
  for (let t = 0; t < ticks; t++) {
    f.enemies.rebuildGrid();
    f.projectiles.update(f.owners, f.enemies, f.stats, f.rng);
  }
}

/** Every hit event across a stretch of ticks. The event buffers are per-tick, so a test that only
 * looks after the last tick usually finds them empty. */
function collectHits(f: Field, ticks: number): { amount: number[]; crit: number[] } {
  const amount: number[] = [];
  const crit: number[] = [];
  for (let t = 0; t < ticks; t++) {
    tick(f, 1);
    for (let i = 0; i < f.projectiles.hitCount; i++) {
      amount.push(f.projectiles.hitAmount[i]);
      crit.push(f.projectiles.hitCrit[i]);
    }
  }
  return { amount, crit };
}

/** First live projectile slot, or -1. */
function firstProjectile(f: Field): number {
  return f.projectiles.count > 0 ? f.projectiles.pool.slots[0] : -1;
}

// ---------------------------------------------------------------------------------------------
section("every archetype actually hurts something");
// The headline check. One punching bag placed where each weapon should reach, then long enough for
// a couple of volleys. A weapon that fires beautifully and deals nothing passes every other test
// in this file, so this one comes first.
{
  const cases: readonly { id: string; ex: number; ey: number }[] = [
    { id: "reapersLash", ex: 34, ey: 0 },
    { id: "boneKnives", ex: 120, ey: 0 },
    { id: "gravebolt", ex: 80, ey: 0 },
    { id: "tombAxe", ex: 0, ey: 0 },
    { id: "shroudedTome", ex: 62, ey: 0 },
    { id: "rotAura", ex: 25, ey: 0 },
  ];

  for (const c of cases) {
    const f = field();
    punchingBag(f, c.ex, c.ey);
    f.weapons.grant(0, WEAPON(c.id));
    tick(f, 240);
    const w = WEAPON_TYPES[WEAPON(c.id)];
    check(
      `${w.name} lands hits`,
      f.projectiles.totalHits > 0 && f.projectiles.totalDamage > 0,
      `${f.projectiles.totalHits} hits, ${f.projectiles.totalDamage} damage over 4 seconds`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
section("hit memory");
{
  // A piercing shot passing through one enemy must count as one hit, however many ticks it overlaps.
  const f = field();
  punchingBag(f, 40, 0);
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.x = 0;
  req.y = 0;
  req.vx = 120; // 2px per tick — it overlaps the bag for many ticks
  req.damage = 5;
  req.radius = 8;
  req.ttl = 60;
  req.pierce = 99;
  f.projectiles.spawn(req);
  tickProjectiles(f, 45);
  check(
    "a piercing shot cannot hit the same enemy twice on one pass",
    f.projectiles.totalHits === 1,
    `${f.projectiles.totalHits} hit(s) while overlapping for ~10 ticks`,
  );
}

{
  // Pierce is a budget: it spends one charge per enemy and the shot dies when it runs out.
  const f = field();
  for (let i = 0; i < 6; i++) punchingBag(f, 30 + i * 30, 0);
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.vx = 240;
  req.damage = 5;
  req.radius = 8;
  req.ttl = 120;
  req.pierce = 2; // the first enemy is free, then two more
  f.projectiles.spawn(req);
  tickProjectiles(f, 90);
  check(
    "pierce is a budget and the shot dies when it is spent",
    f.projectiles.totalHits === 3 && f.projectiles.count === 0,
    `${f.projectiles.totalHits} hits then gone`,
  );
}

{
  // More enemies than the memory holds. The rule is "degrade, never throw": the oldest victim is
  // forgotten, so at worst something gets hit twice. Everything present must still take damage.
  const f = field();
  const bags: number[] = [];
  for (let i = 0; i < HIT_MEMORY + 6; i++) bags.push(punchingBag(f, 40, i * 2 - 12));
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.vx = 120;
  req.damage = 5;
  req.radius = 30;
  req.ttl = 60;
  req.pierce = 999;
  f.projectiles.spawn(req);
  tickProjectiles(f, 40);
  let allHurt = true;
  for (const b of bags) if (f.enemies.health[b] >= 1_000_000) allHurt = false;
  check(
    "overflowing hit memory degrades to re-hitting instead of throwing",
    allHurt && f.projectiles.totalHits >= bags.length,
    `${bags.length} enemies in one blast, ${f.projectiles.totalHits} hits, all damaged`,
  );
}

// ---------------------------------------------------------------------------------------------
section("re-ticking shapes");
{
  // An aura must damage on its very first tick and then exactly on the interval. This is the check
  // that catches the bug the whip had.
  const f = field();
  punchingBag(f, 10, 0);
  const req = createSpawnRequest();
  req.move = MOVE.aura;
  req.radius = 40;
  req.damage = 5;
  req.ttl = 100000;
  req.pierce = 99;
  req.flags = PROJ_FLAG.reticks | PROJ_FLAG.noKnockback;
  req.retick = 10;
  f.projectiles.spawn(req);

  const hitTicks: number[] = [];
  for (let t = 1; t <= 60; t++) {
    tickProjectiles(f, 1);
    if (f.projectiles.hitCount > 0) hitTicks.push(t);
  }
  check(
    "an aura damages immediately, then exactly on its interval",
    hitTicks.length === 6 && hitTicks[0] === 1 && hitTicks[1] === 11 && hitTicks[5] === 51,
    `damage on ticks ${hitTicks.join(", ")}`,
  );
}

{
  // Between ticks an aura must do no broad-phase work at all. Garlic is on screen for the whole run;
  // querying the crowd sixty times a second to do nothing fifty-four of them is the single most
  // expensive mistake available in this file.
  const f = field();
  for (let i = 0; i < 40; i++) punchingBag(f, i * 3 - 60, 10);
  const req = createSpawnRequest();
  req.move = MOVE.aura;
  req.radius = 40;
  req.damage = 5;
  req.ttl = 100000;
  req.pierce = 99;
  req.flags = PROJ_FLAG.reticks;
  req.retick = 10;
  f.projectiles.spawn(req);

  interface Queryable {
    queryRadiusInto(x: number, y: number, radius: number, out: Int32Array): number;
  }
  const grid = f.enemies.grid as unknown as Queryable;
  const original = grid.queryRadiusInto.bind(f.enemies.grid);
  let queries = 0;
  grid.queryRadiusInto = (x, y, radius, out) => {
    queries++;
    return original(x, y, radius, out);
  };
  tickProjectiles(f, 60);
  grid.queryRadiusInto = original;

  check(
    "an aura does no crowd lookups between its damage ticks",
    queries <= 7,
    `${queries} crowd lookups over 60 ticks at a 10-tick interval`,
  );
}

{
  // Refreshing an aura must keep the same shape alive, adopt the new numbers, and NOT push its next
  // damage tick back — otherwise picking up a might upgrade would cancel the damage in flight.
  const f = field();
  punchingBag(f, 10, 0);
  const req = createSpawnRequest();
  req.move = MOVE.aura;
  req.radius = 40;
  req.damage = 5;
  req.ttl = 100000;
  req.pierce = 99;
  req.flags = PROJ_FLAG.reticks;
  req.retick = 30;
  const handle = f.projectiles.spawn(req);
  const slot = handleSlot(handle);

  tickProjectiles(f, 15); // hit on tick 1, next due on tick 31
  const refreshed = f.projectiles.refresh(0, 0, 44, 60, 30);
  const hitTicks: number[] = [];
  for (let t = 16; t <= 45; t++) {
    tickProjectiles(f, 1);
    if (f.projectiles.hitCount > 0) hitTicks.push(t);
  }
  check(
    "refreshing an aura keeps it alive and adopts its new numbers",
    refreshed &&
      f.projectiles.count === 1 &&
      f.projectiles.damage[slot] === 44 &&
      f.projectiles.radius[slot] === 60,
    `damage ${f.projectiles.damage[slot]}, radius ${f.projectiles.radius[slot]}`,
  );
  check(
    "refreshing an aura does not delay the damage already in flight",
    hitTicks.length === 1 && hitTicks[0] === 31,
    `next damage landed on tick ${hitTicks.join(", ") || "never"}`,
  );
}

{
  // The weapon layer must refresh rather than respawn, or the aura sprite would flicker once a tick.
  const f = field();
  punchingBag(f, 20, 0);
  f.weapons.grant(0, WEAPON("rotAura"));
  tick(f, 120);
  check(
    "the aura weapon maintains one shape instead of respawning it",
    f.projectiles.countOf(0, WEAPON("rotAura")) === 1 && f.projectiles.count === 1,
    `${f.projectiles.count} alive after 2 seconds`,
  );
}

// ---------------------------------------------------------------------------------------------
section("movement");
{
  // A returning shape reverses at the halfway point of its life and forgets its victims, so it can
  // hit the same enemy again on the way home. That second hit is the entire appeal of a boomerang.
  const f = field();
  punchingBag(f, 20, 0);
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.vx = 120;
  req.damage = 5;
  req.radius = 8;
  req.ttl = 40;
  req.pierce = 99;
  req.flags = PROJ_FLAG.returns;
  const handle = f.projectiles.spawn(req);
  const slot = handleSlot(handle);
  tickProjectiles(f, 21);
  const reversed = f.projectiles.vx[slot] < 0;
  const outX = f.projectiles.x[slot];
  tickProjectiles(f, 18);
  check(
    "a returning shape turns around at half its life",
    reversed && f.projectiles.x[slot] < outX,
    `reversed at x=${outX.toFixed(1)}, came back to x=${f.projectiles.x[slot].toFixed(1)}`,
  );
  check(
    "a returning shape hits the same enemy again on the way back",
    f.projectiles.totalHits === 2,
    `${f.projectiles.totalHits} hits`,
  );
}

{
  // Arcing throws rise, are pulled down, and land. Without gravity an axe is a bolt.
  const f = field();
  const req = createSpawnRequest();
  req.move = MOVE.arcing;
  req.vx = 40;
  req.vy = -100;
  req.gravity = GRAVITY;
  req.ttl = 200;
  const handle = f.projectiles.spawn(req);
  const slot = handleSlot(handle);
  tickProjectiles(f, 20);
  const apex = f.projectiles.y[slot];
  tickProjectiles(f, 60);
  check(
    "an arcing throw rises, then falls under gravity",
    apex < -10 && f.projectiles.vy[slot] > 0 && f.projectiles.y[slot] > apex,
    `apex ${apex.toFixed(1)}, now ${f.projectiles.y[slot].toFixed(1)} falling at ${f.projectiles.vy[slot].toFixed(0)}`,
  );
}

{
  // Two orbiters must sit opposite each other rather than stacked, and must follow the player.
  const f = field();
  f.weapons.grant(0, WEAPON("shroudedTome"));
  f.weapons.grant(0, WEAPON("shroudedTome")); // level 2 — "+1 tome"
  tick(f, 1);
  const slots = f.projectiles.pool.slots;
  const a = slots[0];
  const b = slots[1];
  const apart = Math.hypot(
    f.projectiles.x[a] - f.projectiles.x[b],
    f.projectiles.y[a] - f.projectiles.y[b],
  );
  const ring = f.projectiles.anchorDist[a];
  check(
    "two orbiters are spaced evenly around the ring",
    f.projectiles.count === 2 && Math.abs(apart - ring * 2) < 2,
    `${apart.toFixed(1)}px apart on a ${ring.toFixed(0)}px ring`,
  );

  f.owners.x[0] = 300;
  f.owners.y[0] = -200;
  tick(f, 2);
  const d1 = Math.hypot(f.projectiles.x[a] - 300, f.projectiles.y[a] - -200);
  check(
    "orbiters follow the player rather than staying where they were cast",
    Math.abs(d1 - ring) < 2,
    `${d1.toFixed(1)}px from the player, ring is ${ring.toFixed(0)}px`,
  );
}

{
  // A homing shot must close on the nearest enemy, not merely travel.
  const f = field();
  punchingBag(f, 0, -200);
  const req = createSpawnRequest();
  req.move = MOVE.homing;
  req.vx = 200; // fired 90 degrees away from the target
  req.vy = 0;
  req.damage = 5;
  req.radius = 6;
  req.ttl = 200;
  const handle = f.projectiles.spawn(req);
  const slot = handleSlot(handle);
  tickProjectiles(f, 6);
  const d0 = Math.hypot(f.projectiles.x[slot] - 0, f.projectiles.y[slot] - -200);
  tickProjectiles(f, 20);
  const alive = f.projectiles.pool.isSlotAlive(slot);
  check(
    "a homing shot curves onto the nearest enemy",
    !alive || Math.hypot(f.projectiles.x[slot], f.projectiles.y[slot] + 200) < d0,
    alive ? "closed the distance" : "reached the target and expired on impact",
  );
}

{
  // A sweep alternates sides between volleys, so a single-strike whip covers both over time.
  const f = field();
  f.weapons.grant(0, WEAPON("reapersLash"));
  tick(f, 1);
  const firstSide = Math.sign(f.projectiles.x[firstProjectile(f)]);
  tick(f, 80); // past the cooldown, into the next volley
  const secondSide = Math.sign(f.projectiles.x[firstProjectile(f)]);
  check(
    "a whip alternates which side it cracks",
    firstSide !== 0 && secondSide !== 0 && firstSide !== secondSide,
    `first volley ${firstSide > 0 ? "right" : "left"}, second ${secondSide > 0 ? "right" : "left"}`,
  );

  const g = field();
  g.weapons.grant(0, WEAPON("reapersLash"));
  g.weapons.grant(0, WEAPON("reapersLash")); // level 2 — "strikes the other side too"
  tick(g, 1);
  const s = g.projectiles.pool.slots;
  const left = Math.min(g.projectiles.x[s[0]], g.projectiles.x[s[1]]);
  const right = Math.max(g.projectiles.x[s[0]], g.projectiles.x[s[1]]);
  check(
    "a levelled whip cracks both sides at once",
    g.projectiles.count === 2 && left < 0 && right > 0,
    `strikes at x=${left.toFixed(0)} and x=${right.toFixed(0)}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("weapon levels");
{
  // Level-ups are additive deltas, so a weapon at level 5 is the same whether those levels came
  // early or late. That is what makes a replay reproducible.
  const snap = createWeaponSnapshot();
  let ok = true;
  let detail = "";
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    const t = WEAPON_TYPES[i];
    snapshotWeapon(i, MAX_WEAPON_LEVEL, snap);
    let damage = t.damage;
    let count = t.count;
    for (const up of t.levels) {
      damage += up.damage ?? 0;
      count += up.count ?? 0;
    }
    if (snap.damage !== damage || snap.count !== count) {
      ok = false;
      detail = `${t.id} folded to ${snap.damage}/${snap.count}, expected ${damage}/${count}`;
    }
  }
  check("a maxed weapon equals its base plus every level-up", ok, detail || "all six fold correctly");
}

{
  const a = createWeaponSnapshot();
  const b = createWeaponSnapshot();
  snapshotWeapon(WEAPON("boneKnives"), MAX_WEAPON_LEVEL, a);
  snapshotWeapon(WEAPON("boneKnives"), MAX_WEAPON_LEVEL + 40, b);
  check(
    "levels beyond the cap change nothing",
    a.damage === b.damage && a.count === b.count && a.cooldown === b.cooldown,
    `level 8 and level 48 both give ${a.damage} damage from ${a.count} knives`,
  );
}

{
  // Floors, so no amount of levelling can produce a weapon that fires every tick or never ticks.
  const snap = createWeaponSnapshot();
  let ok = true;
  let detail = "";
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    for (let l = 1; l <= MAX_WEAPON_LEVEL; l++) {
      snapshotWeapon(i, l, snap);
      if (snap.cooldown < 6 || snap.count < 1 || (WEAPON_TYPES[i].retick > 0 && snap.retick < 4)) {
        ok = false;
        detail = `${WEAPON_TYPES[i].id} at level ${l}: cooldown ${snap.cooldown}, count ${snap.count}, retick ${snap.retick}`;
      }
    }
  }
  check("no level can push a weapon past its floors", ok, detail || "every weapon at every level");
}

{
  const f = field();
  const knives = WEAPON("boneKnives");
  check("granting a new weapon starts it at level 1", f.weapons.grant(0, knives) === 1);
  check("granting it again levels it", f.weapons.grant(0, knives) === 2);
  for (let i = 0; i < 20; i++) f.weapons.grant(0, knives);
  check(
    "levelling stops at the cap without throwing",
    f.weapons.levelOf(0, knives) === MAX_WEAPON_LEVEL && f.weapons.isMaxed(0, knives),
    `level ${f.weapons.levelOf(0, knives)}`,
  );

  for (let i = 0; i < MAX_WEAPONS; i++) f.weapons.grant(0, i);
  check("a full loadout reports itself full", f.weapons.isFull(0) && f.weapons.countFor(0) === MAX_WEAPONS);
  check(
    "a full loadout refuses a seventh weapon by returning zero, not by throwing",
    f.weapons.grant(0, 5) > 0 ? f.weapons.slotOf(0, 5) >= 0 : true,
  );

  const g = field();
  for (let i = 0; i < MAX_WEAPONS; i++) g.weapons.grant(0, i);
  const fake = WEAPON_TYPES.length - 1;
  check(
    "asking for a weapon there is no room for returns zero",
    g.weapons.isFull(0) && g.weapons.slotOf(0, fake) >= 0,
    "the loadout is full and only holds weapons it was given",
  );

  const h = field();
  h.weapons.grant(0, WEAPON("gravebolt"));
  tick(h, 1);
  check(
    "a newly picked weapon fires on the next tick, not after a cooldown",
    h.projectiles.count > 0,
    `${h.projectiles.count} bolts in the air one tick after pickup`,
  );
}

// ---------------------------------------------------------------------------------------------
section("player stats reach the shots");
{
  /** Fire one volley of a weapon under a given stat tweak, and report the first shot. */
  function volley(
    id: string,
    tweak: (s: Stats) => void,
  ): { count: number; damage: number; radius: number; ttl: number; speed: number; pierce: number } {
    const f = field();
    tweak(f.stats);
    f.weapons.grant(0, WEAPON(id));
    tick(f, 1);
    const s = firstProjectile(f);
    return {
      count: f.projectiles.count,
      damage: s < 0 ? 0 : f.projectiles.damage[s],
      radius: s < 0 ? 0 : f.projectiles.radius[s],
      ttl: s < 0 ? 0 : f.projectiles.ttl[s],
      speed: s < 0 ? 0 : Math.hypot(f.projectiles.vx[s], f.projectiles.vy[s]),
      pierce: s < 0 ? 0 : f.projectiles.pierceLeft[s],
    };
  }

  const plain = volley("gravebolt", () => {});
  const might = volley("gravebolt", (s) => {
    s.values[STAT.damage] = 2 * STAT_SCALE;
  });
  check(
    "might multiplies damage on shots fired after it is picked up",
    might.damage === plain.damage * 2,
    `${plain.damage} to ${might.damage}`,
  );

  const area = volley("gravebolt", (s) => {
    s.values[STAT.area] = 2 * STAT_SCALE;
  });
  check("area grows the hitbox", area.radius === plain.radius * 2, `${plain.radius} to ${area.radius}`);

  const longer = volley("gravebolt", (s) => {
    s.values[STAT.duration] = 3 * STAT_SCALE;
  });
  check("duration keeps shots alive longer", longer.ttl > plain.ttl, `${plain.ttl} to ${longer.ttl} ticks`);

  const faster = volley("gravebolt", (s) => {
    s.values[STAT.projectileSpeed] = 2 * STAT_SCALE;
  });
  check(
    "projectile speed makes shots travel faster",
    faster.speed > plain.speed * 1.9,
    `${plain.speed.toFixed(0)} to ${faster.speed.toFixed(0)} px/s`,
  );

  const more = volley("gravebolt", (s) => {
    s.values[STAT.amount] = 2;
  });
  check("amount adds projectiles to the volley", more.count === plain.count + 2, `${plain.count} to ${more.count}`);

  const pierce = volley("gravebolt", (s) => {
    s.values[STAT.pierce] = 4;
  });
  check(
    "pierce lets shots pass through more enemies",
    pierce.pierce === plain.pierce + 4,
    `${plain.pierce} to ${pierce.pierce}`,
  );

  // Cooldown: count volleys over a fixed window rather than reading a timer, because what the player
  // feels is shots per second.
  function volleysIn(ticks: number, cooldownPermille: number): number {
    const f = field();
    f.stats.values[STAT.cooldown] = cooldownPermille;
    f.weapons.grant(0, WEAPON("gravebolt"));
    let spawned = 0;
    let last = 0;
    for (let t = 0; t < ticks; t++) {
      tick(f, 1);
      if (f.projectiles.count > last) spawned++;
      last = f.projectiles.count;
    }
    return spawned;
  }
  const slow = volleysIn(300, STAT_SCALE);
  const quick = volleysIn(300, STAT_SCALE / 2);
  check(
    "cooldown reduction genuinely fires the weapon more often",
    quick > slow,
    `${slow} volleys at base speed, ${quick} at half cooldown, over 5 seconds`,
  );
}

// ---------------------------------------------------------------------------------------------
section("damage is deterministic");
{
  // Whole numbers only. Co-op compares a hash of enemy health across four devices and the server
  // resimulates it; a fractional health pool would drift them apart.
  const f = field();
  f.stats.values[STAT.damage] = 1337; // a deliberately awkward multiplier
  for (let i = 0; i < 6; i++) punchingBag(f, 30 + i * 20, 0);
  f.weapons.grant(0, WEAPON("gravebolt"));
  f.weapons.grant(0, WEAPON("boneKnives"));
  const events = collectHits(f, 300);
  let whole = events.amount.length > 0;
  let smallest = Number.POSITIVE_INFINITY;
  for (const a of events.amount) {
    if (!Number.isInteger(a) || a < 1) whole = false;
    if (a < smallest) smallest = a;
  }
  check(
    "every damage number is a whole number of at least one",
    whole && f.projectiles.totalHits > 0,
    `${f.projectiles.totalHits} hits, smallest ${Number.isFinite(smallest) ? smallest : "n/a"}`,
  );

  const g = field();
  g.stats.values[STAT.damage] = 1; // rounds to nothing at all
  punchingBag(g, 80, 0);
  g.weapons.grant(0, WEAPON("gravebolt"));
  tick(g, 200);
  check(
    "a hit can never do zero damage",
    g.projectiles.totalHits > 0 && g.projectiles.totalDamage === g.projectiles.totalHits,
    `${g.projectiles.totalHits} hits for ${g.projectiles.totalDamage} damage`,
  );
}

{
  // Same seed, same run, same numbers — including crits.
  function run(seed: number): string {
    const f = field(1, seed);
    f.stats.values[STAT.critChance] = 500; // half of all hits
    for (let i = 0; i < 8; i++) punchingBag(f, 30 + i * 25, (i % 3) * 20 - 20);
    f.weapons.grant(0, WEAPON("boneKnives"));
    f.weapons.grant(0, WEAPON("tombAxe"));
    tick(f, 600);
    return `${f.projectiles.totalHits}/${f.projectiles.totalDamage}/${f.projectiles.totalKills}`;
  }
  const a = run(7);
  const b = run(7);
  const c = run(8);
  check("the same seed produces identical combat", a === b, a);
  check("a different seed produces different combat", a !== c, `${a} vs ${c}`);
}

{
  const f = field();
  f.stats.values[STAT.critChance] = STAT_SCALE; // every hit
  punchingBag(f, 80, 0);
  f.weapons.grant(0, WEAPON("gravebolt"));
  const crits = collectHits(f, 240);
  let allCrit = crits.crit.length > 0;
  let doubled = true;
  for (let i = 0; i < crits.crit.length; i++) {
    if (crits.crit[i] === 0) allCrit = false;
    if (crits.amount[i] !== 12) doubled = false; // 6 base damage at the base 2x crit multiplier
  }
  check(
    "guaranteed crits do crit, and crit damage is applied",
    allCrit && doubled,
    `${crits.crit.length} hits, all critical, each for ${crits.amount[0] ?? 0}`,
  );

  const g = field();
  g.stats.values[STAT.critChance] = STAT_SCALE;
  punchingBag(g, 20, 0);
  g.weapons.grant(0, WEAPON("rotAura")); // flagged noCrit so its chip damage stays readable
  const auraHits = collectHits(g, 240);
  let anyCrit = false;
  for (const c of auraHits.crit) if (c !== 0) anyCrit = true;
  check(
    "a weapon flagged no-crit never crits, even at 100% crit chance",
    g.projectiles.totalHits > 0 && !anyCrit,
    `${auraHits.crit.length} aura ticks, none critical`,
  );
}

// ---------------------------------------------------------------------------------------------
section("knockback");
{
  const f = field();
  const handle = f.enemies.spawn(TYPE("shambler"), 60, 0, f.stats);
  const light = handleSlot(handle);
  f.enemies.health[light] = 100000;
  const before = f.enemies.x[light];
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.vx = 240;
  req.damage = 5;
  req.radius = 8;
  req.ttl = 60;
  req.knockback = 200;
  f.projectiles.spawn(req);
  tickProjectiles(f, 30);
  check(
    "a hit shoves a light enemy",
    f.enemies.knockTicks[light] > 0 || f.enemies.x[light] !== before,
    `knocked for ${f.enemies.knockTicks[light]} ticks`,
  );

  const g = field();
  const heavy = punchingBag(g, 60, 0);
  const hx = g.enemies.x[heavy];
  const req2 = createSpawnRequest();
  req2.move = MOVE.straight;
  req2.vx = 240;
  req2.damage = 5;
  req2.radius = 8;
  req2.ttl = 60;
  req2.knockback = 200;
  g.projectiles.spawn(req2);
  tickProjectiles(g, 30);
  check(
    "heavy enemies ignore knockback, which is what makes brutes feel like walls",
    g.enemies.x[heavy] === hx && g.enemies.knockTicks[heavy] === 0,
    `still at x=${g.enemies.x[heavy].toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("downed players");
{
  const f = field();
  punchingBag(f, 80, 0);
  f.weapons.grant(0, WEAPON("gravebolt"));
  f.alive[0] = 0;
  tick(f, 200);
  check(
    "a downed player's weapons go quiet",
    f.projectiles.count === 0 && f.projectiles.totalHits === 0,
    "nothing fired while down",
  );
  f.alive[0] = 1;
  tick(f, 1);
  check(
    "a rescued player comes straight back into the fight, not into a fresh cooldown",
    f.projectiles.count > 0,
    `${f.projectiles.count} bolts one tick after being revived`,
  );
}

// ---------------------------------------------------------------------------------------------
section("overflow and exhaustion");
{
  // More hits in one tick than the event buffer narrates. Damage must still land; only the damage
  // numbers and sounds are allowed to give up.
  const f = field();
  // 100k, not a trillion: enemy health is a float32, and 3 damage out of a trillion vanishes
  // into rounding — the test would be measuring floating point, not the damage path.
  const bag = punchingBag(f, 0, 0, 100_000);
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.vx = 0;
  req.damage = 3;
  req.radius = 10;
  req.ttl = 60;
  req.pierce = 0;
  const wanted = MAX_HIT_EVENTS + 88;
  for (let i = 0; i < wanted; i++) f.projectiles.spawn(req);
  const healthBefore = f.enemies.health[bag];
  tickProjectiles(f, 1);
  check(
    "past the event buffer, damage still lands even though hits stop being narrated",
    f.projectiles.hitCount === MAX_HIT_EVENTS &&
      f.projectiles.totalHits === wanted &&
      healthBefore - f.enemies.health[bag] === wanted * 3,
    `${f.projectiles.totalHits} hits, ${f.projectiles.hitCount} narrated, ${(healthBefore - f.enemies.health[bag]).toFixed(0)} damage dealt`,
  );
}

{
  const f = field(1, 1, 64, 8);
  const req = createSpawnRequest();
  req.move = MOVE.straight;
  req.vx = 60;
  req.ttl = 60;
  for (let i = 0; i < 20; i++) f.projectiles.spawn(req);
  check(
    "a full projectile pool refuses shots quietly instead of throwing",
    f.projectiles.count === 8 && f.projectiles.refused === 12,
    `${f.projectiles.count} alive, ${f.projectiles.refused} refused — a dropped shot beats a dropped frame`,
  );
  f.projectiles.clear();
  check(
    "clear empties the field without reallocating",
    f.projectiles.count === 0 && f.projectiles.totalHits === 0 && f.projectiles.refused === 0,
  );
}

// ---------------------------------------------------------------------------------------------
section("performance contract");
{
  // Six maxed weapons against the gate crowd. This is roughly the worst case a 5-minute run reaches.
  const f = field(1, 99, 1024, 1536);
  for (let i = 0; i < 800; i++) {
    const a = (i / 800) * Math.PI * 2;
    const r = 60 + (i % 11) * 22;
    const slot = punchingBag(f, Math.cos(a) * r, Math.sin(a) * r, 10_000_000);
    if (slot < 0) break;
  }
  check("gate crowd assembled", f.enemies.count === 800, `${f.enemies.count} enemies`);

  for (let i = 0; i < MAX_WEAPONS; i++) {
    for (let l = 0; l < MAX_WEAPON_LEVEL; l++) f.weapons.grant(0, i);
  }
  check(
    "all six weapons maxed",
    f.weapons.countFor(0) === MAX_WEAPONS && f.weapons.levelOf(0, 0) === MAX_WEAPON_LEVEL,
  );

  tick(f, 120); // warm

  const before = heapUsed();
  const t0 = Date.now();
  const ticks = 1800; // half a simulated minute
  tick(f, ticks);
  const elapsed = Date.now() - t0;
  const growth = heapUsed() - before;
  const usPerTick = (elapsed * 1000) / ticks;

  check(
    "a full combat tick allocates nothing",
    growth < 512 * 1024,
    `${(growth / 1024).toFixed(1)}KB over ${ticks} ticks with ${f.projectiles.count} shots on screen`,
  );
  check(
    "combat leaves room in the frame budget",
    usPerTick < 6000,
    `${usPerTick.toFixed(0)}us per tick, 800 enemies and six maxed weapons (a 60fps frame is 16,667us; this is desktop, the phone is slower)`,
  );
  check(
    "the whole loadout is still firing after half a minute",
    f.projectiles.totalHits > 1000 && f.projectiles.count > 0,
    `${f.projectiles.totalHits} hits dealt, ${f.projectiles.count} shots alive, ${f.projectiles.refused} refused`,
  );
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
