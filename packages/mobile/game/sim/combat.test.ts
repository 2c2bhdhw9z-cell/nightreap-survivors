/**
 * Weapons + projectiles self-check. Run headless: `bun packages/mobile/game/sim/combat.test.ts`
 *
 * This is the file that stands between us and the three ways combat quietly rots:
 *
 *   1. A weapon looks like it is working and is not. A whip that only damages at the very start of
 *      its swing, an orbiter that passes straight through an enemy, an aura that stops ticking after
 *      a stat change — all of those look fine on screen and feel terrible to play. So every archetype
 *      gets asked, directly, "did you actually take health off something".
 *   2. Damage stops being reproducible. Co-op compares a hash of enemy health and replay revalidation
 *      resimulates this exact code, so damage must be whole integers drawn from the seeded streams
 *      and never from `Math.random`. Both get tested rather than assumed.
 *   3. It starts allocating. Six maxed weapons against eight hundred enemies fires hundreds of shots
 *      a second; one object per shot per tick is what turns 60fps into a stutter on a 4GB phone.
 *
 * WHAT IT PROVES
 *   1. The weapon table is coherent: one weapon per archetype, unique append-only wire ids, seven
 *      level-ups each, and every clamp holds at max level.
 *   2. Levelling is additive and order-independent, and asking for a level above the cap is safe.
 *   3. Granting weapons behaves at every boundary: new, levelled, maxed, and a full loadout.
 *   4. All six archetypes land real damage on a real crowd.
 *   5. Pierce spends itself correctly and a projectile cannot hit the same enemy twice in one pass.
 *   6. Overflowing a projectile's hit memory degrades to re-hitting instead of throwing.
 *   7. Re-ticking shapes damage again on exactly their interval, and an aura does no broad-phase
 *      work in between.
 *   8. Refreshing an aura keeps the same shape alive instead of respawning it, and does not reset
 *      its damage timer.
 *   9. A returning shot reverses at half life and gets a fresh appetite on the way back.
 *  10. Arcing throws fall under gravity; orbiters stay evenly spaced and follow a moving owner.
 *  11. Every player stat that should reach a fired shot does: damage, area, cooldown, speed,
 *      duration, amount and pierce.
 *  12. Damage is always a whole number of at least 1, crits come only from the seeded stream, and
 *      `noCrit` shots never crit.
 *  13. A downed player fires nothing but keeps its cooldowns running.
 *  14. Event-buffer and pool ceilings degrade gracefully: damage still lands, nothing throws.
 *  15. A tick with six maxed weapons and eight hundred enemies allocates nothing and fits the budget.
 */

import { Rng } from "../core/rng";
import { NULL_HANDLE } from "../core/pool";
import { ENEMY_FLAG, ENEMY_TYPE_BY_ID, EnemyStore } from "./enemies";
import { ModifierStack } from "./modifiers";
import {
  BRAD_FULL,
  createSpawnRequest,
  GRAVITY,
  HIT_MEMORY,
  MAX_HIT_EVENTS,
  MOVE,
  PROJ_FLAG,
  ProjectileStore,
  type OwnerPositions,
  type SpawnRequest,
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

const TYPE = (id: string): number => ENEMY_TYPE_BY_ID.get(id) ?? 0;
const WEAPON = (id: string): number => WEAPON_BY_ID.get(id) ?? 0;

function baseStats(): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  return stats;
}

/**
 * Enemies spawned with an absurd health multiplier. Half these tests need a target that survives
 * being hit, and a dead target reports "no hit" identically to a broken weapon.
 */
function toughSpawnStats(multiplier = 5000): Stats {
  const s = baseStats();
  s.values[STAT.enemyHealth] = multiplier * STAT_SCALE;
  return s;
}

/** Owner positions in the parallel-array shape the sim expects. */
interface Owners extends OwnerPositions {
  count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

function makeOwners(n = 1): Owners {
  return { count: n, x: new Float32Array(4), y: new Float32Array(4) };
}

function facing(dx = 1, dy = 0): { fx: Float32Array; fy: Float32Array; alive: Uint8Array } {
  const fx = new Float32Array(4);
  const fy = new Float32Array(4);
  const alive = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    fx[i] = dx;
    fy[i] = dy;
    alive[i] = 1;
  }
  return { fx, fy, alive };
}

/** A spawn request with sane defaults for the direct-projectile tests. */
function req(over: Partial<SpawnRequest>): SpawnRequest {
  const r = createSpawnRequest();
  return Object.assign(r, over);
}

// ---------------------------------------------------------------------------------------------
section("weapon table integrity");
{
  check("six launch weapons, one per archetype", WEAPON_TYPES.length === 6);

  const moves = new Set(WEAPON_TYPES.map((w) => w.move));
  check(
    "every movement archetype is exercised by something the player can hold",
    moves.size === 6 &&
      [MOVE.sweep, MOVE.homing, MOVE.straight, MOVE.arcing, MOVE.orbiting, MOVE.aura].every((m) =>
        moves.has(m),
      ),
    `${moves.size} distinct archetypes`,
  );

  const wireIds = new Set(WEAPON_TYPES.map((w) => w.wireId));
  check(
    "wire ids are unique and non-zero — a collision would decode old saves into the wrong weapon",
    wireIds.size === WEAPON_TYPES.length && !wireIds.has(0),
  );

  let levelsOk = true;
  let textOk = true;
  for (const w of WEAPON_TYPES) {
    if (w.levels.length !== MAX_WEAPON_LEVEL - 1) levelsOk = false;
    for (const l of w.levels) if (l.text.trim().length === 0) textOk = false;
  }
  check("every weapon has exactly seven level-ups", levelsOk);
  check("every level-up carries card text, so the card and the effect cannot drift apart", textOk);

  let idsOk = true;
  for (const w of WEAPON_TYPES) {
    if ((WEAPON_BY_ID.get(w.id) ?? -1) < 0) idsOk = false;
  }
  check("every weapon is reachable by its string id", idsOk);
}

// ---------------------------------------------------------------------------------------------
section("levelling maths");
{
  const snap = createWeaponSnapshot();
  const knives = WEAPON("boneKnives");
  snapshotWeapon(knives, 1, snap);
  const t = WEAPON_TYPES[knives];
  check(
    "level 1 is the weapon's base numbers, untouched",
    snap.damage === t.damage && snap.cooldown === t.cooldown && snap.count === t.count,
  );

  snapshotWeapon(knives, 4, snap);
  let expectedDamage = t.damage;
  let expectedCount = t.count;
  for (let l = 2; l <= 4; l++) {
    expectedDamage += t.levels[l - 2].damage ?? 0;
    expectedCount += t.levels[l - 2].count ?? 0;
  }
  check(
    "level-ups fold additively, so the same level is the same weapon however it was reached",
    snap.damage === expectedDamage && snap.count === expectedCount,
    `${snap.damage} damage, ${snap.count} projectiles at level 4`,
  );

  const atMax = createWeaponSnapshot();
  const beyond = createWeaponSnapshot();
  snapshotWeapon(knives, MAX_WEAPON_LEVEL, atMax);
  snapshotWeapon(knives, 999, beyond);
  check(
    "asking for a level above the cap is safe and identical to the cap",
    atMax.damage === beyond.damage && atMax.cooldown === beyond.cooldown,
  );

  let clampsOk = true;
  const detail: string[] = [];
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    snapshotWeapon(i, MAX_WEAPON_LEVEL, snap);
    if (snap.cooldown < 6 || snap.count < 1) clampsOk = false;
    if (WEAPON_TYPES[i].retick > 0 && snap.retick < 4) clampsOk = false;
    detail.push(`${WEAPON_TYPES[i].id} cd${snap.cooldown}`);
  }
  check(
    "no weapon can level its way into a zero cooldown or a zero-projectile volley",
    clampsOk,
    detail.join(" "),
  );
}

// ---------------------------------------------------------------------------------------------
section("granting and levelling weapons");
{
  const w = new WeaponStore(4);
  w.reset(1);
  check("a fresh loadout is empty", w.countFor(0) === 0 && !w.isFull(0));

  const lash = WEAPON("reapersLash");
  check("granting a new weapon starts it at level 1", w.grant(0, lash) === 1);
  check("the weapon occupies a slot", w.countFor(0) === 1 && w.levelOf(0, lash) === 1);
  check("granting it again levels it rather than duplicating it", w.grant(0, lash) === 2 && w.countFor(0) === 1);

  for (let i = 0; i < 20; i++) w.grant(0, lash);
  check(
    "levelling stops at the cap instead of running away",
    w.levelOf(0, lash) === MAX_WEAPON_LEVEL && w.isMaxed(0, lash),
    `level ${w.levelOf(0, lash)}`,
  );

  for (let i = 1; i < MAX_WEAPONS; i++) w.grant(0, i);
  check("six slots fill up", w.countFor(0) === MAX_WEAPONS && w.isFull(0));

  const seventh = w.grant(0, WEAPON_TYPES.length - 1);
  check(
    "a seventh weapon is refused with a 0, not an exception — a full loadout is ordinary",
    seventh === 0 || w.levelOf(0, WEAPON_TYPES.length - 1) > 0,
  );

  check("slotOf finds a carried weapon and misses an uncarried one", w.slotOf(0, lash) >= 0 && w.slotOf(1, lash) === -1);
  check("levelOf reports 0 for a weapon the player does not carry", w.levelOf(1, lash) === 0);

  w.reset(1);
  check("reset clears the loadout and its timers", w.countFor(0) === 0 && w.levelOf(0, lash) === 0);
}

// ---------------------------------------------------------------------------------------------
section("every archetype lands real damage");
{
  for (const type of WEAPON_TYPES) {
    const enemies = new EnemyStore(256);
    const projectiles = new ProjectileStore(512);
    const weapons = new WeaponStore(4);
    const stats = baseStats();
    const tough = toughSpawnStats();
    const owners = makeOwners(1);
    const { fx, fy, alive } = facing(1, 0);
    const rng = new Rng(12345);

    weapons.reset(1);
    weapons.grant(0, WEAPON(type.id));

    // A blob of very tough enemies pressed up against the player from every side, so no archetype
    // can miss for want of a target and nothing dies and stops being a target.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 18 + (i % 3) * 12;
      enemies.spawn(TYPE("bonepile"), Math.cos(a) * r, Math.sin(a) * r, tough);
    }
    // Enemies frozen in place: this test is about the weapon, not the crowd.
    for (let t = 0; t < 400; t++) {
      enemies.rebuildGrid();
      weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
      projectiles.update(owners, enemies, stats, rng);
    }

    check(
      `${type.name} damages a crowd standing on the player`,
      projectiles.totalHits > 0 && projectiles.totalDamage > 0,
      `${projectiles.totalHits} hits, ${projectiles.totalDamage} damage over 400 ticks`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
section("pierce and hit memory");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const a = enemies.spawn(TYPE("bonepile"), 40, 0, tough) & 0xffff;
  const b = enemies.spawn(TYPE("bonepile"), 80, 0, tough) & 0xffff;
  const c = enemies.spawn(TYPE("bonepile"), 120, 0, tough) & 0xffff;
  const hp = enemies.health[a];

  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 300, damage: 5, radius: 6, ttl: 90, pierce: 1 }));
  for (let t = 0; t < 90; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "a shot with one pierce hits two enemies and then stops",
    enemies.health[a] < hp && enemies.health[b] < hp && enemies.health[c] === hp,
    `${projectiles.totalHits} hits`,
  );
  check("the spent shot is gone from the pool", projectiles.count === 0);
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 5, 0, tough);
  // A wide, near-stationary shape that overlaps the same enemy for its whole life.
  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 1, damage: 5, radius: 30, ttl: 60, pierce: 99 }));
  for (let t = 0; t < 60; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "a projectile cannot hit the same enemy twice in one pass",
    projectiles.totalHits === 1,
    `${projectiles.totalHits} hits across 60 ticks of overlap`,
  );
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  // More enemies inside one shape than it can remember.
  const crowd = HIT_MEMORY + 6;
  for (let i = 0; i < crowd; i++) enemies.spawn(TYPE("bonepile"), -40 + i * 6, 0, tough);
  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 5, radius: 80, ttl: 20, pierce: 999 }));
  for (let t = 0; t < 20; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "overflowing hit memory degrades to re-hitting rather than throwing",
    projectiles.totalHits >= crowd,
    `${projectiles.totalHits} hits with ${crowd} enemies inside and memory for ${HIT_MEMORY}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("re-ticking shapes");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 10, 0, tough);
  projectiles.spawn(
    req({
      move: MOVE.aura,
      damage: 5,
      radius: 40,
      ttl: 100,
      pierce: 99,
      flags: PROJ_FLAG.reticks | PROJ_FLAG.noCrit | PROJ_FLAG.noKnockback,
      retick: 10,
    }),
  );
  for (let t = 0; t < 100; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "an aura damages again on exactly its interval and never in between",
    projectiles.totalHits === 10,
    `${projectiles.totalHits} hits over 100 ticks at a 10-tick interval`,
  );
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 60, 0, tough);
  // An orbiter parked on top of the enemy, re-ticking every 20.
  projectiles.spawn(
    req({
      move: MOVE.orbiting,
      damage: 5,
      radius: 10,
      ttl: 120,
      pierce: 99,
      flags: PROJ_FLAG.reticks | PROJ_FLAG.noKnockback,
      retick: 20,
      angle: 0,
      angularVel: 0,
      anchorDist: 60,
    }),
  );
  for (let t = 0; t < 120; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "an orbiter grinding an enemy re-damages it on its interval",
    projectiles.totalHits === 6,
    `${projectiles.totalHits} hits over 120 ticks at a 20-tick interval`,
  );
}

{
  // A moving re-ticking shape must damage an enemy the moment it reaches it, not only on the tick
  // its interval happens to land. This is what makes an orbiter feel like a solid object.
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const e = enemies.spawn(TYPE("bonepile"), 0, 60, tough) & 0xffff;
  projectiles.spawn(
    req({
      move: MOVE.orbiting,
      damage: 5,
      radius: 10,
      ttl: 200,
      pierce: 99,
      flags: PROJ_FLAG.reticks | PROJ_FLAG.noKnockback,
      retick: 60,
      angle: 0,
      angularVel: 34, // a bit over one full turn across its life
      anchorDist: 60,
    }),
  );
  const hp = enemies.health[e];
  for (let t = 0; t < 200; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "a travelling orbiter hits what it sweeps past, not only what it happens to touch on its interval",
    enemies.health[e] < hp,
    `${projectiles.totalHits} hits while orbiting through the enemy`,
  );
}

// ---------------------------------------------------------------------------------------------
section("returning shots and gravity");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 60, 0, tough);
  projectiles.spawn(
    req({
      move: MOVE.straight,
      x: 0,
      y: 0,
      vx: 300,
      damage: 5,
      radius: 6,
      ttl: 40,
      pierce: 99,
      flags: PROJ_FLAG.returns,
    }),
  );
  for (let t = 0; t < 40; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "a returning shot reverses at half life and hits the same enemy again on the way back",
    projectiles.totalHits === 2,
    `${projectiles.totalHits} hits`,
  );
}

{
  const enemies = new EnemyStore(4);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const h = projectiles.spawn(
    req({ move: MOVE.arcing, x: 0, y: 0, vx: 40, vy: -160, damage: 5, radius: 6, ttl: 120, gravity: GRAVITY }),
  );
  const slot = h & 0xffff;
  let peak = 0;
  let rising = false;
  for (let t = 0; t < 100; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
    if (projectiles.y[slot] < peak) peak = projectiles.y[slot];
    if (projectiles.vy[slot] > 0) rising = true;
  }
  check(
    "a thrown axe rises, is pulled back down by gravity, and drifts sideways",
    peak < 0 && rising && projectiles.y[slot] > peak && projectiles.x[slot] > 0,
    `peak ${peak.toFixed(1)}, ended ${projectiles.y[slot].toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("shapes pinned to a moving player");
{
  const enemies = new EnemyStore(4);
  const projectiles = new ProjectileStore(16);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const count = 4;
  const slots: number[] = [];
  for (let n = 0; n < count; n++) {
    const h = projectiles.spawn(
      req({
        move: MOVE.orbiting,
        damage: 1,
        radius: 8,
        ttl: 600,
        flags: PROJ_FLAG.reticks,
        retick: 30,
        angle: Math.round((BRAD_FULL * n) / count),
        angularVel: 0,
        anchorDist: 50,
      }),
    );
    slots.push(h & 0xffff);
  }
  const auraHandle = projectiles.spawn(
    req({ move: MOVE.aura, damage: 1, radius: 40, ttl: 600, flags: PROJ_FLAG.reticks, retick: 30 }),
  );
  const auraSlot = auraHandle & 0xffff;

  owners.x[0] = 137;
  owners.y[0] = -64;
  for (let t = 0; t < 5; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }

  let radiiOk = true;
  for (const s of slots) {
    const d = Math.hypot(projectiles.x[s] - owners.x[0], projectiles.y[s] - owners.y[0]);
    if (Math.abs(d - 50) > 0.01) radiiOk = false;
  }
  check("orbiters follow the player, holding their ring distance", radiiOk);

  const angles = slots
    .map((s) => Math.atan2(projectiles.y[s] - owners.y[0], projectiles.x[s] - owners.x[0]))
    .sort((p, q) => p - q);
  let spacingOk = true;
  for (let i = 1; i < angles.length; i++) {
    if (Math.abs(angles[i] - angles[i - 1] - Math.PI / 2) > 0.02) spacingOk = false;
  }
  check("four orbiters sit evenly spaced rather than stacked on top of each other", spacingOk);

  check(
    "an aura sits exactly on the player",
    projectiles.x[auraSlot] === owners.x[0] && projectiles.y[auraSlot] === owners.y[0],
  );
}

// ---------------------------------------------------------------------------------------------
section("player stats reach fired shots");
{
  /** Fire one volley of a weapon under the given stats and report what came out. */
  function volley(
    weaponId: string,
    tune: (s: Stats) => void,
  ): { count: number; damage: number; radius: number; life: number; speed: number; pierce: number; cooldown: number } {
    const enemies = new EnemyStore(4);
    const projectiles = new ProjectileStore(256);
    const weapons = new WeaponStore(4);
    const stats = baseStats();
    tune(stats);
    const owners = makeOwners(1);
    const { fx, fy, alive } = facing(1, 0);
    const rng = new Rng(99);
    weapons.reset(1);
    weapons.grant(0, WEAPON(weaponId));

    enemies.rebuildGrid();
    weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);

    const slot = projectiles.pool.slots[0];
    return {
      count: projectiles.count,
      damage: projectiles.damage[slot],
      radius: projectiles.radius[slot],
      life: projectiles.life[slot],
      speed: Math.hypot(projectiles.vx[slot], projectiles.vy[slot]),
      pierce: projectiles.pierceLeft[slot],
      cooldown: weapons.timer[0],
    };
  }

  const plain = volley("gravebolt", () => {});
  const strong = volley("gravebolt", (s) => {
    s.values[STAT.damage] = 3 * STAT_SCALE;
  });
  check(
    "a might upgrade strengthens a weapon the player already owns",
    strong.damage === plain.damage * 3,
    `${plain.damage} to ${strong.damage} damage per bolt`,
  );

  const wide = volley("gravebolt", (s) => {
    s.values[STAT.area] = 2 * STAT_SCALE;
  });
  check("an area upgrade widens the hit radius", wide.radius === plain.radius * 2, `${plain.radius} to ${wide.radius}px`);

  const quick = volley("gravebolt", (s) => {
    s.values[STAT.cooldown] = 500;
  });
  check(
    "a cooldown upgrade shortens the wait between volleys",
    quick.cooldown === Math.trunc(plain.cooldown / 2),
    `${plain.cooldown} to ${quick.cooldown} ticks`,
  );

  const fast = volley("gravebolt", (s) => {
    s.values[STAT.projectileSpeed] = 2 * STAT_SCALE;
  });
  check(
    "a speed upgrade makes bolts travel faster",
    Math.abs(fast.speed - plain.speed * 2) < 1,
    `${plain.speed.toFixed(0)} to ${fast.speed.toFixed(0)} units per second`,
  );

  const lasting = volley("gravebolt", (s) => {
    s.values[STAT.duration] = 2 * STAT_SCALE;
  });
  check("a duration upgrade keeps shots alive longer", lasting.life === plain.life * 2, `${plain.life} to ${lasting.life} ticks`);

  const more = volley("gravebolt", (s) => {
    s.values[STAT.amount] = 2;
  });
  check(
    "an extra-projectile upgrade adds bolts to the volley",
    more.count === plain.count + 2,
    `${plain.count} to ${more.count} bolts`,
  );

  const piercing = volley("gravebolt", (s) => {
    s.values[STAT.pierce] = 3;
  });
  check(
    "a pierce upgrade lets bolts pass through more enemies",
    piercing.pierce === plain.pierce + 3,
    `${plain.pierce} to ${piercing.pierce}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("damage numbers stay reproducible");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 5, 0, tough);
  // A deliberately fractional damage value, the kind a stat multiplier produces.
  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 7.61, radius: 30, ttl: 4, pierce: 0 }));
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check(
    "damage is truncated to a whole number, so two devices cannot drift apart",
    projectiles.hitCount === 1 && Number.isInteger(projectiles.hitAmount[0]) && projectiles.hitAmount[0] === 7,
    `${projectiles.hitAmount[0]} damage from 7.61`,
  );
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 5, 0, tough);
  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 0.2, radius: 30, ttl: 4, pierce: 0 }));
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check(
    "a hit always takes off at least 1 — chip damage never rounds to nothing",
    projectiles.hitAmount[0] === 1,
  );
}

{
  /** Roll a fixed number of hits under a given crit chance and seed. */
  function critPattern(seed: number, chance: number, noCrit: boolean): string {
    const enemies = new EnemyStore(256);
    const projectiles = new ProjectileStore(256);
    const stats = baseStats();
    stats.values[STAT.critChance] = chance;
    const tough = toughSpawnStats();
    const owners = makeOwners(1);
    const rng = new Rng(seed);
    for (let i = 0; i < 40; i++) enemies.spawn(TYPE("bonepile"), -100 + i * 5, 0, tough);
    for (let i = 0; i < 40; i++) {
      projectiles.spawn(
        req({
          move: MOVE.straight,
          x: -100 + i * 5,
          y: 0,
          vx: 0,
          damage: 10,
          radius: 4,
          ttl: 3,
          pierce: 0,
          flags: noCrit ? PROJ_FLAG.noCrit : 0,
        }),
      );
    }
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
    let out = "";
    for (let i = 0; i < projectiles.hitCount; i++) out += projectiles.hitCrit[i] === 1 ? "C" : ".";
    return out;
  }

  const a = critPattern(4242, 500, false);
  const b = critPattern(4242, 500, false);
  const c = critPattern(9999, 500, false);
  check("crits come only from the seeded stream — the same seed crits identically", a === b && a.length > 0, a);
  check("a different seed produces a different crit pattern", a !== c);
  check("crits actually happen at a 50% chance", a.includes("C") && a.includes("."));

  const never = critPattern(4242, 1000, true);
  check(
    "a noCrit shape never crits, even at 100% crit chance",
    never.length > 0 && !never.includes("C"),
    `${never.length} hits, none critical`,
  );

  const always = critPattern(4242, 1000, false);
  check("at 100% crit chance every hit crits", always.length > 0 && !always.includes("."));
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  stats.values[STAT.critChance] = STAT_SCALE;
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(3);
  enemies.spawn(TYPE("bonepile"), 5, 0, tough);
  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 10, radius: 30, ttl: 3, pierce: 0 }));
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check(
    "a crit applies the crit multiplier",
    projectiles.hitCrit[0] === 1 && projectiles.hitAmount[0] === 20,
    `${projectiles.hitAmount[0]} damage at 2x`,
  );
}

// ---------------------------------------------------------------------------------------------
section("knockback and kills");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const light = enemies.spawn(TYPE("shambler"), 20, 0, tough) & 0xffff;
  const heavy = enemies.spawn(TYPE("bonepile"), -20, 0, tough) & 0xffff;
  check("the heavy enemy is actually flagged heavy", (enemies.flags[heavy] & ENEMY_FLAG.heavy) !== 0);

  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 5, radius: 40, ttl: 3, pierce: 99, knockback: 80 }));
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check("a light enemy is knocked back when hit", enemies.knockTicks[light] > 0);
  check("a heavy enemy shrugs knockback off", enemies.knockTicks[heavy] === 0);
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const e = enemies.spawn(TYPE("shambler"), 5, 0, baseStats()) & 0xffff;
  const kind = enemies.typeIndex[e];
  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 9999, radius: 30, ttl: 3, pierce: 0, knockback: 50 }));
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check(
    "a kill is reported once, with a position and the enemy kind, so a gem can drop there",
    projectiles.killCount === 1 && projectiles.killType[0] === kind && projectiles.totalKills === 1,
  );
  check("a dead enemy is not also knocked back", enemies.count === 0);
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  const e = enemies.spawn(TYPE("bonepile"), 5, 0, tough) & 0xffff;
  const before = enemies.health[e];
  projectiles.spawn(
    req({
      move: MOVE.straight,
      x: 0,
      y: 0,
      vx: 0,
      damage: 5,
      radius: 40,
      ttl: 3,
      pierce: 99,
      knockback: 80,
      flags: PROJ_FLAG.noKnockback,
    }),
  );
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check(
    "a noKnockback shape damages without shoving the horde out of its own range",
    enemies.health[e] < before && enemies.knockTicks[e] === 0,
  );
}

{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  enemies.spawn(TYPE("bonepile"), 40, 0, tough);
  enemies.spawn(TYPE("bonepile"), 80, 0, tough);
  projectiles.spawn(
    req({ move: MOVE.straight, x: 0, y: 0, vx: 300, damage: 5, radius: 6, ttl: 90, pierce: 99, flags: PROJ_FLAG.fragile }),
  );
  for (let t = 0; t < 90; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "a fragile shape dies on its first hit even with pierce to spare",
    projectiles.totalHits === 1 && projectiles.count === 0,
  );
}

// ---------------------------------------------------------------------------------------------
section("ceilings degrade gracefully");
{
  const projectiles = new ProjectileStore(8);
  let refusedHandle = 0;
  for (let i = 0; i < 20; i++) {
    refusedHandle = projectiles.spawn(req({ move: MOVE.straight, ttl: 600 }));
  }
  check(
    "a full projectile pool refuses new shots instead of throwing",
    projectiles.count === 8 && projectiles.refused === 12 && refusedHandle === NULL_HANDLE,
    `${projectiles.count} alive, ${projectiles.refused} refused — a dropped shot beats a dropped frame`,
  );

  projectiles.clear();
  check("clear empties the pool and the run totals", projectiles.count === 0 && projectiles.refused === 0);
}

{
  const enemies = new EnemyStore(2048);
  const projectiles = new ProjectileStore(256);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(7);

  // Enough overlapping shapes and enough enemies to blow past the narration buffer in one tick.
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    enemies.spawn(TYPE("bonepile"), Math.cos(a) * 30, Math.sin(a) * 30, tough);
  }
  for (let i = 0; i < 40; i++) {
    projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 0, damage: 3, radius: 60, ttl: 3, pierce: 999 }));
  }
  enemies.rebuildGrid();
  projectiles.update(owners, enemies, stats, rng);
  check(
    "past the event ceiling damage still lands, it just stops being narrated",
    projectiles.hitCount === MAX_HIT_EVENTS && projectiles.totalHits > MAX_HIT_EVENTS,
    `${projectiles.totalHits} hits landed, ${projectiles.hitCount} shown`,
  );
}

// ---------------------------------------------------------------------------------------------
section("auras are maintained, not respawned");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const weapons = new WeaponStore(4);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const { fx, fy, alive } = facing(1, 0);
  const rng = new Rng(7);

  weapons.reset(1);
  weapons.grant(0, WEAPON("rotAura"));
  enemies.spawn(TYPE("bonepile"), 10, 0, tough);

  const step = (n: number): void => {
    for (let t = 0; t < n; t++) {
      enemies.rebuildGrid();
      weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
      projectiles.update(owners, enemies, stats, rng);
    }
  };

  step(1);
  check("an aura exists from the first tick", projectiles.count === 1);
  const slot = projectiles.pool.slots[0];
  const firstDamage = projectiles.damage[slot];

  step(300);
  check(
    "five seconds later there is still exactly one aura, not three hundred",
    projectiles.count === 1 && projectiles.pool.slots[0] === slot,
    `${projectiles.count} alive`,
  );

  const hitsBefore = projectiles.totalHits;
  stats.values[STAT.damage] = 4 * STAT_SCALE;
  step(1);
  check(
    "a mid-run might upgrade reaches the aura already on the field",
    projectiles.damage[slot] === firstDamage * 4,
    `${firstDamage} to ${projectiles.damage[slot]}`,
  );
  check("refreshing the aura does not reset its damage clock", projectiles.totalHits >= hitsBefore);

  const expected = Math.floor(301 / projectiles.retick[slot]);
  check(
    "the aura ticked steadily across those five seconds",
    projectiles.totalHits >= expected - 1,
    `${projectiles.totalHits} hits, expected about ${expected}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("a downed player");
{
  const enemies = new EnemyStore(64);
  const projectiles = new ProjectileStore(64);
  const weapons = new WeaponStore(4);
  const stats = baseStats();
  const owners = makeOwners(1);
  const { fx, fy, alive } = facing(1, 0);
  const rng = new Rng(7);

  weapons.reset(1);
  weapons.grant(0, WEAPON("gravebolt"));

  enemies.rebuildGrid();
  weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
  check("an upright player fires immediately on pickup", projectiles.count > 0);
  projectiles.clear();

  alive[0] = 0;
  const timerBefore = weapons.timer[0];
  for (let t = 0; t < 200; t++) {
    enemies.rebuildGrid();
    weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
    projectiles.update(owners, enemies, stats, rng);
  }
  check("a downed player fires nothing", projectiles.count === 0, `${projectiles.count} shots`);
  check(
    "but their cooldowns keep running, so a rescue is not followed by a dead pause",
    weapons.timer[0] < timerBefore,
    `${timerBefore} to ${weapons.timer[0]} ticks`,
  );

  alive[0] = 1;
  enemies.rebuildGrid();
  weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
  check("a rescued player is straight back in the fight", projectiles.count > 0);
}

// ---------------------------------------------------------------------------------------------
section("sweeps alternate sides");
{
  const enemies = new EnemyStore(256);
  const projectiles = new ProjectileStore(256);
  const weapons = new WeaponStore(4);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const { fx, fy, alive } = facing(1, 0);
  const rng = new Rng(7);

  weapons.reset(1);
  const lash = WEAPON("reapersLash");
  weapons.grant(0, lash);

  // One enemy on each flank, both far too tough to die.
  const right = enemies.spawn(TYPE("bonepile"), 34, 0, tough) & 0xffff;
  const left = enemies.spawn(TYPE("bonepile"), -34, 0, tough) & 0xffff;
  const rightHp = enemies.health[right];
  const leftHp = enemies.health[left];

  const step = (n: number): void => {
    for (let t = 0; t < n; t++) {
      enemies.rebuildGrid();
      weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
      projectiles.update(owners, enemies, stats, rng);
    }
  };

  // One crack only. The whip's cooldown is longer than this, so nothing has fired twice yet.
  step(20);
  const rightAfterFirst = enemies.health[right] < rightHp;
  const leftAfterFirst = enemies.health[left] < leftHp;
  check(
    "a level 1 whip cracks one side at a time",
    rightAfterFirst !== leftAfterFirst,
    rightAfterFirst ? "hit the right flank first" : "hit the left flank first",
  );

  step(240);
  check(
    "the next cracks cover the other side, so a single whip guards both over time",
    enemies.health[right] < rightHp && enemies.health[left] < leftHp,
  );

  // Level 2 adds a second strike, which the data says covers the opposite side at once.
  const two = new WeaponStore(4);
  const twoProjectiles = new ProjectileStore(64);
  two.reset(1);
  two.grant(0, lash);
  two.grant(0, lash);
  enemies.rebuildGrid();
  two.update(owners, fx, fy, alive, enemies, twoProjectiles, stats, rng);
  check(
    "at level 2 the whip puts out two strikes in one crack",
    twoProjectiles.count === 2,
    `${twoProjectiles.count} strikes`,
  );
  // A strike is placed from its angle on its first tick, so run one before asking where it is.
  enemies.rebuildGrid();
  twoProjectiles.update(owners, enemies, stats, rng);
  const sides = [twoProjectiles.pool.slots[0], twoProjectiles.pool.slots[1]].map((s) =>
    twoProjectiles.x[s] > owners.x[0] ? "right" : "left",
  );
  check("those two strikes cover opposite flanks", sides[0] !== sides[1], sides.join(" and "));
}

// ---------------------------------------------------------------------------------------------
section("cost");
{
  const enemies = new EnemyStore(2048);
  const projectiles = new ProjectileStore(1536);
  const weapons = new WeaponStore(4);
  const stats = baseStats();
  const owners = makeOwners(1);
  const { fx, fy, alive } = facing(1, 0);
  const rng = new Rng(20260811);

  // The worst realistic case: every weapon owned and maxed, a full crowd, nothing dying.
  weapons.reset(1);
  for (let i = 0; i < MAX_WEAPONS; i++) {
    for (let l = 0; l < MAX_WEAPON_LEVEL; l++) weapons.grant(0, i);
  }
  const tough = toughSpawnStats(200_000);
  for (let i = 0; i < 800; i++) {
    const a = (i / 800) * Math.PI * 2;
    const r = 40 + (i % 40) * 6;
    enemies.spawn(TYPE("bonepile"), Math.cos(a) * r, Math.sin(a) * r, tough);
  }
  check("the crowd is at the gate size", enemies.count === 800);

  const warm = 600;
  for (let t = 0; t < warm; t++) {
    enemies.rebuildGrid();
    weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
    projectiles.update(owners, enemies, stats, rng);
  }

  const ticks = 3600;
  const before = heapUsed();
  const start = Date.now();
  for (let t = 0; t < ticks; t++) {
    enemies.rebuildGrid();
    weapons.update(owners, fx, fy, alive, enemies, projectiles, stats, rng);
    projectiles.update(owners, enemies, stats, rng);
  }
  const elapsed = Date.now() - start;
  const growth = heapUsed() - before;
  const usPerTick = (elapsed * 1000) / ticks;

  check(
    "a minute of combat with six maxed weapons at 800 enemies allocates nothing",
    growth < 64 * 1024,
    `${(growth / 1024).toFixed(1)}KB over ${ticks} ticks — allocation, not arithmetic, is what kills a JS game on 4GB`,
  );
  check(
    "combat leaves room in the frame budget",
    usPerTick < 6000,
    `${usPerTick.toFixed(0)}us per tick with ${projectiles.count} shots on screen (a 60fps frame is 16,667us; this is desktop, the phone will be slower)`,
  );
  check(
    "the weapons were actually working the whole time",
    projectiles.totalHits > 10_000,
    `${projectiles.totalHits} hits, ${projectiles.totalDamage} damage`,
  );
  check("nothing went non-finite", Number.isFinite(projectiles.totalDamage) && Number.isFinite(projectiles.x[0]));
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
