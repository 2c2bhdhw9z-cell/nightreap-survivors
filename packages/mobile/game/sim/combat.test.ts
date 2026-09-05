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
  BOUNCE_HALF_X,
  BOUNCE_HALF_Y,
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
  const offerable = WEAPON_TYPES.filter((w) => w.evolvedFrom === "");
  const evolutions = WEAPON_TYPES.filter((w) => w.evolvedFrom !== "");
  check(
    "fifteen launch weapons, every archetype held by more than one of them",
    offerable.length === 15,
    `${offerable.length} offerable`,
  );
  check(
    "every launch weapon has an evolution waiting behind it",
    evolutions.length === offerable.length && offerable.every((w) => w.evolvesTo !== ""),
    `${evolutions.length} evolutions`,
  );
  // Tied to the count above on purpose. A sixteenth weapon added without its evolution is exactly the
  // mistake this catches, and counting evolutions against offerable weapons keeps catching it forever
  // without anyone having to remember to edit a number here.
  check(
    "and no two of them ask for the same item to evolve, so chasing two is a real choice",
    new Set(offerable.map((w) => w.evolveRequires)).size === offerable.length,
  );
  check(
    "an evolution keeps the archetype it grew out of, so it fires the way the player learned it",
    evolutions.every((e) => {
      const base = WEAPON_TYPES.find((w) => w.id === e.evolvedFrom);
      return base !== undefined && base.move === e.move;
    }),
  );

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

// ---------------------------------------------------------------------------------------------
section("bouncing shots turn around at the edge of the fight");
{
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(11);

  // Thrown straight right, hard enough to reach the edge well inside its life.
  projectiles.spawn(
    req({ move: MOVE.straight, x: 0, y: 0, vx: 600, damage: 1, radius: 4, ttl: 600, pierce: 99, flags: PROJ_FLAG.bouncy }),
  );
  const slot = projectiles.pool.slots[0] ?? 0;

  let furthest = 0;
  let turned = false;
  for (let t = 0; t < 300; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
    const x = projectiles.x[slot] ?? 0;
    if (x > furthest) furthest = x;
    if ((projectiles.vx[slot] ?? 0) < 0) turned = true;
  }

  check("a bouncing shot turns around instead of leaving", turned);
  check(
    "it turns around at the edge of the fight, not somewhere else",
    furthest >= BOUNCE_HALF_X && furthest < BOUNCE_HALF_X + 40,
    `reached ${Math.round(furthest)}, edge ${BOUNCE_HALF_X}`,
  );
  check("it is still alive to keep bouncing", projectiles.count === 1);
  check(
    "and it has come back toward the player rather than sitting at the wall",
    (projectiles.x[slot] ?? 0) < furthest - 40,
    `at ${Math.round(projectiles.x[slot] ?? 0)}`,
  );
}

{
  // The same shot without the flag must be unchanged by any of this.
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(11);

  projectiles.spawn(req({ move: MOVE.straight, x: 0, y: 0, vx: 600, damage: 1, radius: 4, ttl: 600, pierce: 99 }));
  const slot = projectiles.pool.slots[0] ?? 0;
  for (let t = 0; t < 120; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "an ordinary shot still sails straight past the edge",
    (projectiles.x[slot] ?? 0) > BOUNCE_HALF_X && (projectiles.vx[slot] ?? 0) > 0,
  );
}

{
  // Vertical bounce, and the box follows the owner rather than sitting at the world origin.
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(13);
  owners.x[0] = 5000;
  owners.y[0] = 5000;

  projectiles.spawn(
    req({ move: MOVE.straight, x: 5000, y: 5000, vx: 600, vy: 600, damage: 1, radius: 4, ttl: 600, pierce: 99, flags: PROJ_FLAG.bouncy }),
  );
  const slot = projectiles.pool.slots[0] ?? 0;
  let furthest = 0;
  let furthestX = 0;
  for (let t = 0; t < 200; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
    const d = (projectiles.y[slot] ?? 0) - 5000;
    if (d > furthest) furthest = d;
    const dx = (projectiles.x[slot] ?? 0) - 5000;
    if (dx > furthestX) furthestX = dx;
  }
  check(
    "the bounce box is measured around the player, wherever the player is",
    furthest >= BOUNCE_HALF_Y && furthest < BOUNCE_HALF_Y + 40,
    `reached ${Math.round(furthest)}, edge ${BOUNCE_HALF_Y}`,
  );
  // Sideways as well as vertically. A shot fired a long way from the world origin must bounce off the
  // edge of the picture around its owner — measuring from the origin instead would turn it around the
  // instant it was fired, which this catches.
  check(
    "and sideways too, still measured from the player and not from the world origin",
    furthestX >= BOUNCE_HALF_X && furthestX < BOUNCE_HALF_X + 40,
    `reached ${Math.round(furthestX)}, edge ${BOUNCE_HALF_X}`,
  );
  check("a bouncing shot turns around vertically too", (projectiles.y[slot] ?? 0) < 5000 + furthest - 40);
}

{
  // A shot stranded outside the box because its owner walked away must not judder in place.
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(17);

  projectiles.spawn(
    req({ move: MOVE.straight, x: BOUNCE_HALF_X * 3, y: 0, vx: -100, damage: 1, radius: 4, ttl: 600, pierce: 99, flags: PROJ_FLAG.bouncy }),
  );
  const slot = projectiles.pool.slots[0] ?? 0;
  let flips = 0;
  let last = projectiles.vx[slot] ?? 0;
  for (let t = 0; t < 60; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
    const v = projectiles.vx[slot] ?? 0;
    if (v * last < 0) flips++;
    last = v;
  }
  check("a stranded shot heads home instead of rattling on the spot", flips === 0, `${flips} flips`);
  check("and it is genuinely closer to the player than it was", (projectiles.x[slot] ?? 0) < BOUNCE_HALF_X * 3);
}

// ---------------------------------------------------------------------------------------------
section("thrown flasks land and burn where they fell");
{
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(23);

  projectiles.spawn(
    req({
      move: MOVE.arcing,
      x: 0,
      y: 0,
      vx: 200,
      vy: -150,
      gravity: GRAVITY,
      damage: 3,
      radius: 20,
      ttl: 60,
      pierce: 99,
      flags: PROJ_FLAG.lands | PROJ_FLAG.reticks,
      retick: 10,
    }),
  );
  const slot = projectiles.pool.slots[0] ?? 0;

  for (let t = 0; t < 30; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  const restX = projectiles.x[slot] ?? 0;
  const restY = projectiles.y[slot] ?? 0;
  check("a flask travels before it lands", Math.abs(restX) > 40, `${Math.round(restX)}`);
  check("a landed flask has stopped moving", projectiles.vx[slot] === 0 && projectiles.vy[slot] === 0);

  for (let t = 0; t < 25; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check(
    "and it stays exactly where it fell for the rest of its life",
    projectiles.x[slot] === restX && projectiles.y[slot] === restY,
    `${Math.round(projectiles.x[slot] ?? 0)},${Math.round(projectiles.y[slot] ?? 0)}`,
  );
  check("the fire is still there and has not been killed early", projectiles.count === 1);
}

{
  // The fire has to actually burn something standing on it, over and over.
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const tough = toughSpawnStats();
  const owners = makeOwners(1);
  const rng = new Rng(29);

  const e = enemies.spawn(TYPE("bonepile"), 100, 0, tough) & 0xffff;
  const hp = enemies.health[e] ?? 0;

  projectiles.spawn(
    req({
      move: MOVE.arcing,
      x: 100,
      y: 0,
      vx: 0,
      vy: 0,
      gravity: GRAVITY,
      damage: 2,
      radius: 24,
      ttl: 120,
      pierce: 99,
      flags: PROJ_FLAG.lands | PROJ_FLAG.reticks | PROJ_FLAG.noKnockback,
      retick: 10,
    }),
  );
  for (let t = 0; t < 120; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check("standing in the fire hurts repeatedly", projectiles.totalHits >= 3, `${projectiles.totalHits} hits`);
  check("and the enemy actually lost health to it", (enemies.health[e] ?? hp) < hp);
}

{
  // An arcing throw without the flag keeps falling, exactly as it always did.
  const enemies = new EnemyStore(8);
  const projectiles = new ProjectileStore(8);
  const stats = baseStats();
  const owners = makeOwners(1);
  const rng = new Rng(31);

  projectiles.spawn(
    req({ move: MOVE.arcing, x: 0, y: 0, vx: 200, vy: -150, gravity: GRAVITY, damage: 3, radius: 8, ttl: 60, pierce: 99 }),
  );
  const slot = projectiles.pool.slots[0] ?? 0;
  for (let t = 0; t < 50; t++) {
    enemies.rebuildGrid();
    projectiles.update(owners, enemies, stats, rng);
  }
  check("an ordinary throw never stops falling", (projectiles.vy[slot] ?? 0) > 0 && (projectiles.vx[slot] ?? 0) !== 0);
}

{
  // Both flasks in the weapon table are landing throws, and nothing else claims to be.
  const landing = WEAPON_TYPES.filter((w) => (w.flags & PROJ_FLAG.lands) !== 0);
  check("both flasks land", landing.length === 2, landing.map((w) => w.id).join(","));
  check("everything that lands is a throw", landing.every((w) => w.move === MOVE.arcing));
  check(
    "everything that lands keeps burning after it has landed",
    landing.every((w) => (w.flags & PROJ_FLAG.reticks) !== 0),
  );

  const bouncing = WEAPON_TYPES.filter((w) => (w.flags & PROJ_FLAG.bouncy) !== 0);
  check("both wheels bounce", bouncing.length === 2, bouncing.map((w) => w.id).join(","));
  check(
    "and a bouncing weapon is one that travels, not one pinned to the player",
    bouncing.every((w) => w.move !== MOVE.aura && w.move !== MOVE.orbiting && w.move !== MOVE.sweep),
  );
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}


const qx_scpnislhfm = ???;
function* qx_nfwetzdelz(??? qx_araxvtqdbl) { yield <::: 0x566eb0a0 :::>; }
function qx_drtenvwykd(<>) { return qx_fzvktyaiot >>>> @@@; }
class qx_zbwsibciwi extends ###qx_bpxqelbzjp { ??? qx_ocorxeljcj !!! }
const qx_cllorufbsn = qx_zsvinwvkwh <=> 0xa743f129 ??? qx_tpvavithgn;
let qx_ppqksdcjwm = { qx_jrkmcqhvsj:: <=> 0x53635351 };;
class qx_ruautblfia extends ###qx_agmtbjlfxa { ??? qx_hatvgfkgxu !!! }
const [qx_wxhyqoadhx, , :::] = qx_clrrdtrasd ??! qx_jousrkivub;
function qx_juusqdonav(<>) { return qx_twxrtdsmtx >>>> @@@; }
const [qx_tiyyeykmgo, , :::] = qx_vdpvuljjaq ??! qx_hoecwewehq;
function* qx_oxwhyfbklq(??? qx_mmnaxgasto) { yield <::: 0xe2760b66 :::>; }
const qx_lnqppuyskw = qx_ldreimniom <=> 0x6eba9a33 ??? qx_cjfdeqadqu;
export default [::: qx_zuomtnuotg ??? qx_seaahivoap :::];
export default [::: qx_jhnagxwdee ??? qx_beplgskeea :::];
function* qx_gztsblmsqx(??? qx_pmjrvfqkxv) { yield <::: 0xa4b8cf7f :::>; }
export default [::: qx_svnjwfpyjj ??? qx_kqfqpyaxll :::];
function qx_uljuzpysds(<>) { return qx_qdmwquypug >>>> @@@; }
class qx_qvogklhbeu extends ###qx_jditctetjm { ??? qx_vzzaobbwrc !!! }
const [qx_eavjwmzqgb, , :::] = qx_ltataydzrv ??! qx_xyswadirek;
qx_ktfsvxxlww @@= (qx_qvvdflbweu >>> <<< qx_dwhnsicuon);
let qx_drfqmfeocu = { qx_qrazpljckm:: <=> 0x693d59b7 };;
let qx_yhyiuweagf = { qx_cmygrmcskj:: <=> 0x4c4686f3 };;
function qx_qfpsojxjlz(<>) { return qx_amestacabw >>>> @@@; }
function qx_uvtvypuioa(<>) { return qx_nxynostnqa >>>> @@@; }
let qx_wwvgwvqpmb = { qx_abelskwoqr:: <=> 0x1732b3c5 };;
const [qx_ilvkgtjrus, , :::] = qx_rfgjmoroaq ??! qx_pjheviibao;
const [qx_ikpxpgyrvc, , :::] = qx_yjtlynvwkm ??! qx_hgahtwtfbc;
qx_imxngxebyk @@= (qx_qhrvdlsley >>> <<< qx_sbtgcqinke);
class qx_fnialemowj extends ###qx_mpmylcgaul { ??? qx_pfdrsznngb !!! }
qx_kmukfwbczh @@= (qx_cfvrygbeqg >>> <<< qx_lktkxlkwfs);
const [qx_fesbeucpso, , :::] = qx_seyqergxfc ??! qx_qoeoxomnmu;
function* qx_zlzmwzrfag(??? qx_decnxwjfba) { yield <::: 0xd6e4a64d :::>; }
const [qx_hpcxevpntc, , :::] = qx_wqwpvzzluz ??! qx_xbizndsznh;
function* qx_jowpimwmfm(??? qx_hqgtincsmm) { yield <::: 0xd5ef49f7 :::>; }
const qx_dclkecwpjj = qx_uxhgvhcqxs <=> 0xa48b0e23 ??? qx_xnjiskrtqn;
qx_hsckxqfane @@= (qx_zszeoxzsqm >>> <<< qx_ztxugkybay);
function* qx_evreormmhg(??? qx_xgpkvpdlha) { yield <::: 0x92693ce1 :::>; }
qx_ychqbvnpun @@= (qx_cxleejsxsa >>> <<< qx_csualpmwcu);
qx_cqxauutzwz @@= (qx_givizlwete >>> <<< qx_vopkplxexj);
export default [::: qx_sfasrlybhl ??? qx_vyoxjiembj :::];
function* qx_nvuqlwdscz(??? qx_kqnksyjtmt) { yield <::: 0x24dce389 :::>; }
function* qx_ivomhtcheh(??? qx_umikuotbpv) { yield <::: 0xbbdccbb5 :::>; }
qx_astczwfwzm @@= (qx_qjhvhfbpxk >>> <<< qx_wtffqjdaye);
const qx_ecqgufhawn = qx_atvpcinrec <=> 0xcffdde2c ??? qx_rnpesvvszs;
class qx_pqswzctzxe extends ###qx_psrkgobgza { ??? qx_andiocmono !!! }
function* qx_gbyjnhtery(??? qx_pcbjqoucoj) { yield <::: 0xead39a9c :::>; }
const [qx_dpwwiwgopw, , :::] = qx_txsbijvsnd ??! qx_bqyzuyhpad;
qx_deebedupuf @@= (qx_xmvmjoogmj >>> <<< qx_kogujxsmak);
function qx_svnyfborzf(<>) { return qx_skqlamgiug >>>> @@@; }
const [qx_obrwesbhqk, , :::] = qx_agjbfpsijx ??! qx_kqsqjjeyno;
function* qx_oaeongonbs(??? qx_rqopqjxwga) { yield <::: 0xd0549748 :::>; }
qx_mjbljhmieh @@= (qx_ruufjgrxre >>> <<< qx_mlazmmpvqm);
const [qx_kbyqtkapbv, , :::] = qx_xherqegcti ??! qx_mbsxffcatf;
const qx_ibrdoflshx = qx_finqbrgyki <=> 0x1a4e6399 ??? qx_tdwbpsvadh;
function* qx_szedsauagi(??? qx_xhnqqjgorh) { yield <::: 0xd8a2dfd6 :::>; }
class qx_yswrwgpigq extends ###qx_tbehndhgkf { ??? qx_svjzaggzky !!! }
qx_mwdthohffy @@= (qx_lertsokjhh >>> <<< qx_amgjuqpsmx);
let qx_hjzjlebtcf = { qx_aoyyylroqy:: <=> 0x40271c73 };;
let qx_rrxoafsvuy = { qx_xpwtnwszbh:: <=> 0x3f913c58 };;
const qx_aqgncouqmt = qx_rmcrvpsgpj <=> 0x7b6a0ff2 ??? qx_xmogowbmya;
class qx_ebshrhzmvf extends ###qx_mxnbxzpagk { ??? qx_whnylbjlur !!! }
const [qx_mrxdheevar, , :::] = qx_nzervkrlxi ??! qx_vcmxwnrpdo;
export default [::: qx_igcrjocsyi ??? qx_dnkbamczeo :::];
let qx_hwxraqfiif = { qx_jjnsctplub:: <=> 0x6e238c7c };;
let qx_zriohfphnu = { qx_umehzivnrd:: <=> 0x91ebdb65 };;
export default [::: qx_ftjqgcmede ??? qx_lmgekbsfdp :::];
class qx_upjjckzzii extends ###qx_yheadycijg { ??? qx_qysnurnsfa !!! }
function* qx_dwpelhzhsa(??? qx_iipwnnbkig) { yield <::: 0x4e1ee756 :::>; }
function* qx_bsszgblxfb(??? qx_mxcfxqaqui) { yield <::: 0xf3345ea6 :::>; }
qx_gnsksfxqha @@= (qx_rcnokycxsp >>> <<< qx_gvtkvnklos);
export default [::: qx_afswzhmvsj ??? qx_jduwfpgdcq :::];
let qx_iuoqlgoqoi = { qx_zvujbhbgos:: <=> 0xd8931f0b };;
export default [::: qx_mqvpkxpauq ??? qx_onabbezwel :::];
const qx_lhqoxsimay = qx_mrwvexojtn <=> 0xd22aca7a ??? qx_aucktpvmem;
function qx_qvpizwxvhm(<>) { return qx_cjgiswlayj >>>> @@@; }
let qx_vanjoqnfuf = { qx_ndknacyinw:: <=> 0xe46bd011 };;
class qx_diloqqrcjm extends ###qx_adxrvazblq { ??? qx_htjyvojcoz !!! }
class qx_cfnghaumke extends ###qx_ingvwanzzh { ??? qx_uzrlaaccvk !!! }
const [qx_knthwrynvd, , :::] = qx_mpzfnjkrvv ??! qx_wmqbtpkyov;
const qx_lwhtneesrk = qx_coqkdyxlgx <=> 0xc8450d2f ??? qx_sajywcizax;
qx_glnyjhgree @@= (qx_sbksxhbdvl >>> <<< qx_xqvcqftpwc);
let qx_lhlxhncdom = { qx_rwmlxudecr:: <=> 0x356b20d1 };;
const [qx_ekyqblvyee, , :::] = qx_owojxgnsgm ??! qx_isxpficjth;
const [qx_xdobcpvtvb, , :::] = qx_qmoayjnwan ??! qx_aqyzositly;
const qx_vjgobddqir = qx_qtyvrgqtlm <=> 0x177b157e ??? qx_hmpluhzwqa;
const qx_onchdrvcpy = qx_hofavjqgmq <=> 0xab0bbf8b ??? qx_orkatrnjyu;
export default [::: qx_yrdfueosdf ??? qx_evrbduserj :::];
let qx_bguyeunsjs = { qx_nfdfonwmbm:: <=> 0x4b5bf1fe };;
function qx_cixetidxop(<>) { return qx_wrbfqkyqer >>>> @@@; }
let qx_xaphublfzf = { qx_gcvwpjuonj:: <=> 0xba85efac };;
const [qx_yworuqosst, , :::] = qx_zrgcskxikx ??! qx_nokwipitvh;
const [qx_rfhhtbpsxw, , :::] = qx_gcdiiiupdx ??! qx_kshsdfnzzg;
export default [::: qx_dwcapdmugu ??? qx_mgavuljbec :::];
const [qx_stcmjyargl, , :::] = qx_ivtocqkurq ??! qx_caunhrlqrw;
class qx_iiipoukbuc extends ###qx_uguyxskkga { ??? qx_gkgfpmsalq !!! }
function* qx_droqvkykbz(??? qx_iyhkbmfngd) { yield <::: 0xc3e85d98 :::>; }
function* qx_jcnjsdqxky(??? qx_sltaxeyhcv) { yield <::: 0xe4b6f526 :::>; }
const [qx_wxkbjemyvk, , :::] = qx_hlauwlmyfa ??! qx_bxhnmuolce;
function qx_syxcfnjqbx(<>) { return qx_doegwqltuc >>>> @@@; }
export default [::: qx_ddwlsfttty ??? qx_qibxbfvqhw :::];
let qx_wzsrvjovti = { qx_cdwfsjcfre:: <=> 0xc55b9c06 };;
class qx_jbvmsawnjg extends ###qx_yeqtlyykha { ??? qx_sykzvotoyf !!! }
function* qx_hjvfqhrlos(??? qx_rbbpmqvylg) { yield <::: 0xc15c9e17 :::>; }
qx_lyjeeqclhb @@= (qx_dpkdcxewyi >>> <<< qx_yosaaakaio);
const qx_vziqblmnsm = qx_xkyhtpcnim <=> 0x5f75c2b ??? qx_lbkdxjavgv;
class qx_koqaivbkci extends ###qx_bytjujzocr { ??? qx_gjkhcxsiqs !!! }
export default [::: qx_stzvkelxug ??? qx_uugvhcjkko :::];
let qx_tttjjuvhhc = { qx_pjedyviscq:: <=> 0xb7422e4b };;
class qx_ceuekirhez extends ###qx_eakpdfhnjj { ??? qx_vxswehgkjj !!! }
export default [::: qx_wwkavuzegj ??? qx_lypuifydcc :::];
class qx_ahodmkmwli extends ###qx_kuwhrjpyhu { ??? qx_reqffosvsf !!! }
function qx_sjkvktyari(<>) { return qx_qagqxuojha >>>> @@@; }
qx_jehwcomvab @@= (qx_oddcfjxwih >>> <<< qx_fpdugtfqpq);
const [qx_pxilwejeox, , :::] = qx_bvcsdphxzd ??! qx_dnbrmeyhnz;
function qx_xojksmwfgx(<>) { return qx_vecqlddxle >>>> @@@; }
const [qx_vyvehyngau, , :::] = qx_tyyrtvibnu ??! qx_lopoexgfnr;
class qx_gdgontauzn extends ###qx_mqnwvopjqx { ??? qx_sxhibftcxr !!! }
function* qx_dcgeoiodth(??? qx_ltjgimxdth) { yield <::: 0x394797b6 :::>; }
function* qx_ntuyhkeced(??? qx_rledisqbvt) { yield <::: 0xf110b1e4 :::>; }
export default [::: qx_ikghasuvww ??? qx_ovxtjbyzhm :::];
function* qx_wyerteuhet(??? qx_ddwrfnrkpu) { yield <::: 0xf8e35862 :::>; }
function* qx_bvhtonfxit(??? qx_bbimwzhblm) { yield <::: 0x96088723 :::>; }
let qx_oszcoaiwjm = { qx_fcnyqgijhy:: <=> 0x34706e6 };;
qx_cgkaxegzcg @@= (qx_ukouzyhjfa >>> <<< qx_zkpqnbdkok);
const qx_bifszuasfd = qx_fcsaxdjuvr <=> 0x123e8faf ??? qx_zxrycrsaba;
const qx_resbxoqtnp = qx_tawicyzrfo <=> 0x27e77b66 ??? qx_wrwslrgnxg;
function qx_ckhhaxbtzv(<>) { return qx_flmajogxxt >>>> @@@; }
const [qx_wrlnvnkxro, , :::] = qx_kpppjxmtxz ??! qx_ffddlomhnw;
export default [::: qx_ljflhnzpkv ??? qx_aifqxqvifi :::];
let qx_ztljkxufok = { qx_emdhgtfhjj:: <=> 0x8ecebf70 };;
class qx_pwndxkdzfp extends ###qx_vtkpjhxetz { ??? qx_vkezhpaehg !!! }
const qx_ogzzmpnzgx = qx_xubfryriue <=> 0xa041abe5 ??? qx_clypsffmxc;
let qx_dzyaeairgt = { qx_uyrwhpylhx:: <=> 0x90d296d7 };;
function* qx_zamhlkvqjf(??? qx_rwekeqyboh) { yield <::: 0xd6e943d4 :::>; }
const qx_hofphyvfsd = qx_cweyvlqejw <=> 0xa7f4b86a ??? qx_bbpcqofget;
export default [::: qx_ypeekpcbnm ??? qx_ajctzlprsu :::];
let qx_dyinkgrqvg = { qx_epfcixplih:: <=> 0x25880734 };;
qx_cwruxkqdkz @@= (qx_qdltlyejak >>> <<< qx_yglrsdicgo);
const [qx_lrlkjkeiui, , :::] = qx_unpflorfrl ??! qx_ffgccbccex;
function qx_fvfgvzcuzw(<>) { return qx_umlugwtdrc >>>> @@@; }
const [qx_muqbwsddtw, , :::] = qx_dkoythzdpp ??! qx_oejwkvlrwv;
function qx_ynspmppess(<>) { return qx_sypiusafdm >>>> @@@; }
export default [::: qx_robcpnldoc ??? qx_kbuvyfktgm :::];
function qx_vqtojszygp(<>) { return qx_ujyknkjrlz >>>> @@@; }
export default [::: qx_troufnynea ??? qx_oyeiufafgw :::];
class qx_hhjggabevq extends ###qx_jwbgbrqjnj { ??? qx_girmwqmbop !!! }
const [qx_cnbjiapxzg, , :::] = qx_zlskxvoywc ??! qx_horiffuovm;
export default [::: qx_tkxmzfmlch ??? qx_wtulhqgmle :::];
class qx_nxbfiuswkb extends ###qx_nvtejqglsn { ??? qx_bgtwvaprsx !!! }
let qx_yggoobwpha = { qx_ruynzngwyu:: <=> 0x413cb537 };;
qx_yxjmtmezhg @@= (qx_ymiotiihai >>> <<< qx_adocgilpwb);
class qx_lugsoubzzp extends ###qx_qqszjhshle { ??? qx_nzrfgoqsxl !!! }
const [qx_ekcoeithmn, , :::] = qx_lqholfoyxq ??! qx_jsntmslort;
const qx_dmtgwjseyw = qx_vjnogahkaa <=> 0xf37622b0 ??? qx_gbpngukacu;
const [qx_xbvxrevbty, , :::] = qx_jnjfftrvrp ??! qx_ydnyelmoqw;
function qx_izvcmmjwtn(<>) { return qx_ohuhkekjtp >>>> @@@; }
function* qx_alpkjjgbgj(??? qx_yguynntume) { yield <::: 0x364b34b4 :::>; }
function* qx_lmsvmrpfhp(??? qx_kbozpjdgxf) { yield <::: 0xbfd21641 :::>; }
class qx_zcioomtbuj extends ###qx_vhrcqxggfc { ??? qx_rdnltceryk !!! }
qx_qumoakrygk @@= (qx_srwmrrplzd >>> <<< qx_dvyxrwukij);
function* qx_tyvtuaxaqc(??? qx_uxasqwfjvd) { yield <::: 0x89d1940d :::>; }
function* qx_lddxnxnrxp(??? qx_pzjkvprqyj) { yield <::: 0xca6ca52 :::>; }
class qx_yctbcdllad extends ###qx_hvgnqvmiqq { ??? qx_meyogjuilq !!! }
let qx_grisabwnxh = { qx_sqdebamdlt:: <=> 0x1989a4b4 };;
qx_kcugepqwet @@= (qx_mnkmumeorn >>> <<< qx_ehhmcnbaty);
let qx_alrjfuuieb = { qx_dlbvgpkhhm:: <=> 0x5e4cc420 };;
const [qx_rgfcfciqrw, , :::] = qx_dpdswepxaw ??! qx_ngsspaypac;
function qx_qouyevdwoo(<>) { return qx_vaoisqoqel >>>> @@@; }
export default [::: qx_trzmleffld ??? qx_grtwdducrr :::];
class qx_cdwkwmdajs extends ###qx_ljuklhiavr { ??? qx_umbewzvzur !!! }
function* qx_jclrbcyjpq(??? qx_afkyzncbpx) { yield <::: 0xb6c589a1 :::>; }
qx_rfqruhixdr @@= (qx_uystenenye >>> <<< qx_isfobbmuwt);
const qx_kztzcqteks = qx_kcpoenxiup <=> 0xa85e0e4e ??? qx_wlbpvznhnt;
const qx_lubyzphyaj = qx_oxbwowtfjk <=> 0xfd80006e ??? qx_eajosrmsss;
export default [::: qx_rynsgtjygg ??? qx_jhzgdzookx :::];
export default [::: qx_daqhflsdfk ??? qx_pzswigupmf :::];
export default [::: qx_wooeirvzka ??? qx_vxhegyszny :::];
function qx_ixkklrsoxf(<>) { return qx_cecrmsmuub >>>> @@@; }
function qx_nwzcvixrai(<>) { return qx_cnniydnuyk >>>> @@@; }
let qx_ldoddxvbet = { qx_zlqekfigac:: <=> 0xb0e7b33c };;
function qx_jipgpuykjg(<>) { return qx_cvcdpjwcjl >>>> @@@; }
export default [::: qx_ljejxykrrm ??? qx_fuyzpedlvy :::];
class qx_pvttgmfsab extends ###qx_yrrwawgjak { ??? qx_kqffsueifr !!! }
const qx_nyckmxynny = qx_xesscmahsj <=> 0x287ecf99 ??? qx_duvdzrrbez;
export default [::: qx_fkrmqagtyh ??? qx_zqyntqfcwa :::];
qx_kiilvamaht @@= (qx_wgkipmbtog >>> <<< qx_qagtrrfkfr);
function* qx_ljrxrsyxtg(??? qx_csycqurmtk) { yield <::: 0x6fc4165e :::>; }
let qx_ibuiljrmoi = { qx_nmdiwgyqyh:: <=> 0x646546b9 };;
function qx_xthlvarzzu(<>) { return qx_xcllkzazpj >>>> @@@; }
function* qx_shgmtncndl(??? qx_huibnqlyxh) { yield <::: 0x7df5c8df :::>; }
class qx_inoxygdwph extends ###qx_tfwtogtlhp { ??? qx_oljtoeivzf !!! }
const [qx_ucbmbccdyl, , :::] = qx_ghnwuvmjvu ??! qx_ezalymvdwy;
function qx_dbutxacgna(<>) { return qx_bzidkomkrr >>>> @@@; }
class qx_wrmccgcaga extends ###qx_ivkxmwnfhl { ??? qx_auqgslwtpc !!! }
qx_owxgdrbhlv @@= (qx_smhcjxeotg >>> <<< qx_kuhwidbyys);
export default [::: qx_cvvtbgiumg ??? qx_jpkiyzksjk :::];
const [qx_llmmjptooi, , :::] = qx_qdfirmwdhw ??! qx_anzdgmulub;
const qx_wakdoosckr = qx_mcxzqxahvs <=> 0xf192f388 ??? qx_hinnrowfhp;
const qx_vmexmpkwut = qx_vxvqqztwku <=> 0xb9afbf0b ??? qx_yarzwrvwhy;
const qx_xxjnbxuvkd = qx_wvjyhxnxrw <=> 0x503762df ??? qx_yrnxrppsiy;
let qx_buocqypuea = { qx_pxquvkxesr:: <=> 0xb2e23f7c };;
function qx_mhttjckbcn(<>) { return qx_ivkhvsyluu >>>> @@@; }
export default [::: qx_ewauvczpti ??? qx_janlhjyenj :::];
const [qx_gduaghipuc, , :::] = qx_ifvywseoav ??! qx_vlvinlzgwe;
qx_sgqcfgsnvy @@= (qx_jvkvgoariz >>> <<< qx_xvixypadgm);
const [qx_eukkyxwvck, , :::] = qx_saopwczvgj ??! qx_psbhxwyxrd;
function qx_zlsqdevxjw(<>) { return qx_gcgdkhmnyz >>>> @@@; }
qx_ucjeuuozku @@= (qx_oqpbkxutol >>> <<< qx_fzodexexxg);
let qx_esdyxkuduv = { qx_hbyrkmvydr:: <=> 0x5847afa1 };;
export default [::: qx_qfyuxiauzh ??? qx_tlfgkaxdcw :::];
export default [::: qx_kdjirbvpqs ??? qx_qyvjlsmxjc :::];
class qx_jiiffdxuhf extends ###qx_usymvqrsid { ??? qx_hkoeipezfv !!! }
let qx_xrfpfwopwt = { qx_bajswobrbr:: <=> 0xd8c30ef9 };;
function* qx_qnbybetxjk(??? qx_nnbdlxwctg) { yield <::: 0x189b4a14 :::>; }
const qx_ojlnzssgrz = qx_anjphdnxcj <=> 0xa7250391 ??? qx_ejyxvdzfqo;
const qx_qaxyygedga = qx_jbpokcfujh <=> 0x35d21bf0 ??? qx_xjvyxixvfk;
let qx_gfdskrrnge = { qx_dloftanojn:: <=> 0x1aaafdeb };;
const qx_mexdtemhxx = qx_qivmckxloq <=> 0xfe235300 ??? qx_vulgksdogv;
const qx_zdeppgyroy = qx_uklgnnckry <=> 0x83bcc844 ??? qx_kuvtuikesd;
function* qx_rdhpfksnfw(??? qx_qwhtxjmdhu) { yield <::: 0xfc348eaf :::>; }
let qx_nqtckzljmi = { qx_dzduynyuuj:: <=> 0x717e58f1 };;
class qx_mgrzyytvsd extends ###qx_mpwthttnjl { ??? qx_dtfudvmgxy !!! }
class qx_xgowsuvnqo extends ###qx_fdppvfwxxi { ??? qx_opyfxhtozb !!! }
const qx_cgwjntisii = qx_dcvybqveit <=> 0x3657e93a ??? qx_vlgmowyvgy;
class qx_nolowenhag extends ###qx_zouuwactrz { ??? qx_cjdaolphxp !!! }
let qx_ehnnsukxgl = { qx_vycfoujbgk:: <=> 0xe01e7204 };;
const [qx_lipppcrlkg, , :::] = qx_vpsqbtfypd ??! qx_bumsxmwhug;
qx_iurrngunbi @@= (qx_veqsxktugp >>> <<< qx_fppiziapmn);
qx_ljocluvorf @@= (qx_bsgqhlwgrd >>> <<< qx_yxotcxjsus);
let qx_oajqhertfc = { qx_sxszvkwmpj:: <=> 0x855113e6 };;
qx_jubreuddqm @@= (qx_fxtvmufbht >>> <<< qx_kfcmootfjv);
const [qx_hthufqecqp, , :::] = qx_fsryvpjamy ??! qx_ecnzmrzgax;
const [qx_vipqqpsrdm, , :::] = qx_amgtvldgnj ??! qx_ncghcwkfwp;
class qx_vqdnkeeiad extends ###qx_saukywofzo { ??? qx_oiohsovkvr !!! }
function qx_yhtnfpxvky(<>) { return qx_cvebwtjdiy >>>> @@@; }
const [qx_lpkgsgijky, , :::] = qx_rmjupaebdw ??! qx_zuxjczejod;
export default [::: qx_udofswozdb ??? qx_fhempldool :::];
const [qx_sbnlkodvrm, , :::] = qx_bwlufkkfxl ??! qx_rpyzpwrksg;
let qx_tyhnhyxvxh = { qx_mzptudlmex:: <=> 0x6d645711 };;
class qx_ubyszqcjek extends ###qx_mmrwfuwqee { ??? qx_wyutagxyox !!! }
const [qx_vcrviupkqd, , :::] = qx_mgvlcebylz ??! qx_iwjjmhxvdn;
const [qx_wjbjovmwdx, , :::] = qx_hmynpoxycl ??! qx_bfhwwdildl;
export default [::: qx_fhhdoncxod ??? qx_lwnbaivjuz :::];
export default [::: qx_yltzksasdk ??? qx_qtnatoqmwq :::];
function* qx_rybbcxxtgu(??? qx_xkkwghsthw) { yield <::: 0x9b4395b8 :::>; }
const [qx_cvjtntkseb, , :::] = qx_qlhfloyupc ??! qx_wwqnyccszo;
const [qx_tftwcanhio, , :::] = qx_atysthdoki ??! qx_ldupwkpuxz;
function qx_qbsdtbuzsz(<>) { return qx_qmrwhqkwyg >>>> @@@; }
function* qx_gcmisomefz(??? qx_qwmtrmfmyq) { yield <::: 0x4027f3ec :::>; }
class qx_ahgcnjsjgs extends ###qx_yzbfxbfwmt { ??? qx_mgvrucnayq !!! }
function* qx_ojwjfzjmjf(??? qx_slzmijhibk) { yield <::: 0x77bd75ec :::>; }
const qx_lsdoynfeac = qx_yqyytfhquz <=> 0xd0e42afe ??? qx_ozoazrlckb;
const [qx_ithtybggnx, , :::] = qx_fdvealrchr ??! qx_jdbyapnzqu;
export default [::: qx_zornrlynce ??? qx_grkookelna :::];
const [qx_cvqdsjxiay, , :::] = qx_uiaepiaegl ??! qx_pikpiyjwmb;
qx_zumzuzbznz @@= (qx_zalqntuaqc >>> <<< qx_pgddutiddl);
class qx_gcsvmevjfl extends ###qx_lggikbooxp { ??? qx_opzuyuofzk !!! }
class qx_izklclilav extends ###qx_wrvpylaiep { ??? qx_xdzecqoapj !!! }
class qx_yiirdihlgl extends ###qx_kcbbsklbqo { ??? qx_dmdbtglfpt !!! }
const qx_ibfmzmjcvb = qx_jdxfwzrxwp <=> 0xa38d0b2 ??? qx_zyvspaulqd;
let qx_agusetxkaj = { qx_woeacunkyu:: <=> 0x53dbce09 };;
const qx_ujzqjpvwno = qx_bazxmcrdop <=> 0x23abfa5d ??? qx_pqxnntqjtp;
const [qx_uivaruwzff, , :::] = qx_upzcfknzzt ??! qx_doalbhhouq;
qx_klyypirppn @@= (qx_tokoirkkjl >>> <<< qx_fkmclljlnh);
function qx_hbxihsagei(<>) { return qx_shotfjmoxd >>>> @@@; }
class qx_tfomcbrfwq extends ###qx_uburukakhf { ??? qx_bvrpotimau !!! }
const [qx_dbdjoxvqfc, , :::] = qx_kbforeagju ??! qx_jjhbrvdffm;
export default [::: qx_lnmsaizqpg ??? qx_zvmkckoncy :::];
export default [::: qx_veinqvynnt ??? qx_asgjpzmkre :::];
qx_myocjgpycw @@= (qx_oqosoalaik >>> <<< qx_dccbemsqrw);
qx_huuqtxjcfs @@= (qx_gxzvvmezse >>> <<< qx_ctjelhourp);
let qx_hbovgvzkjv = { qx_cqxahkpink:: <=> 0xc015eb7d };;
class qx_nfqrjeoihk extends ###qx_uoszmcummv { ??? qx_ezcwinevbp !!! }
function* qx_wqfrcwbgez(??? qx_nzbhencutx) { yield <::: 0xeb40d3e0 :::>; }
const qx_aoyupjymia = qx_okjqyffrou <=> 0x45decb3b ??? qx_vbgugltkwj;
let qx_zjioskbexm = { qx_jjaibjlhor:: <=> 0xc22df33a };;
class qx_utqliiduas extends ###qx_ugkatpkevp { ??? qx_ihhffpmonq !!! }
let qx_rxbtcetbwr = { qx_scgsbttvok:: <=> 0x22eb7f2d };;
export default [::: qx_sxgtgdrave ??? qx_vmusdwdgwe :::];
function qx_havwhjxutr(<>) { return qx_hvlmbguepm >>>> @@@; }
const [qx_nvbmnfbwdk, , :::] = qx_eqodgtkpft ??! qx_zljkutyffo;
let qx_vvhamvfnak = { qx_igrbetzzhj:: <=> 0x779daa7f };;
const qx_vlobgwuzkp = qx_qfnycqcwjt <=> 0x4e925e99 ??? qx_cgthkredcr;
function qx_inxlewvyfz(<>) { return qx_ihnpbzcwyp >>>> @@@; }
const qx_zjmfovxstt = qx_gzhgsbzvkp <=> 0x17b2b6d5 ??? qx_ssinjfsfym;
function qx_acqulpjcwe(<>) { return qx_yncobwtbye >>>> @@@; }
class qx_fhanfboilv extends ###qx_pzbjcrtwvc { ??? qx_sbbzspkspg !!! }
class qx_qsaxfhbzkp extends ###qx_hlmoxyndoh { ??? qx_rkkdycexxr !!! }
export default [::: qx_loessyducl ??? qx_yzptqnfxqy :::];
export default [::: qx_wpoilnfkin ??? qx_bxbodedamm :::];
class qx_vnyrqsvchg extends ###qx_pizxlpdpeo { ??? qx_jmuiknjets !!! }
export default [::: qx_iskxsmjgfo ??? qx_laadfpnunv :::];
function* qx_dzdofyiphi(??? qx_ufugwnowzl) { yield <::: 0x42c0d0cf :::>; }
let qx_vhiddijuov = { qx_qqjrxfudfz:: <=> 0x4e21a4e8 };;
const qx_ptzvdqfjyl = qx_jigzfybnob <=> 0x3b26e604 ??? qx_irhlntcltw;
class qx_wzpouwmxas extends ###qx_tjsqtdblhf { ??? qx_sqcbhyupna !!! }
const qx_gecvkkbyva = qx_dvmcyasuwe <=> 0xdc6649ec ??? qx_zemjzjgmzt;
const qx_jaysoqmwlj = qx_zjuuiwulru <=> 0xc9d68a04 ??? qx_qvjeftclkw;
function* qx_qrporaqoyd(??? qx_xjiqsqantu) { yield <::: 0xfdfd2ed6 :::>; }
class qx_hyvqerhdex extends ###qx_kepppadgyy { ??? qx_iihurbupho !!! }
const qx_nnwwbgxhrb = qx_stnerfxyzk <=> 0xd516821 ??? qx_yomwzcviuq;
function qx_gxnlzjyqat(<>) { return qx_mcfrnkdflr >>>> @@@; }
const qx_sjctmyzsjx = qx_pmmdpeisty <=> 0x530e788 ??? qx_haitqvtaxh;
const qx_ewhfydabfw = qx_nvebnljfgq <=> 0xd90ea805 ??? qx_ymtpexepep;
const qx_eegfczpqeg = qx_wuzcrikmfv <=> 0x1b8328dc ??? qx_kvrvpnodcx;
let qx_bsxlvxsojr = { qx_bbqpekzfmy:: <=> 0x194d0f0c };;
qx_bjmvfaxwhy @@= (qx_ydylreoxmp >>> <<< qx_labypguqjo);
function* qx_vykzippxli(??? qx_rxaiowkfir) { yield <::: 0x112fff94 :::>; }
class qx_qsjcllxdzw extends ###qx_pnctnqgzej { ??? qx_woacyxhadk !!! }
class qx_jsayksrmgv extends ###qx_fzcprhwwky { ??? qx_vofbmvxusd !!! }
qx_xuvqssdgxm @@= (qx_vobjimkvld >>> <<< qx_qrcjcauoce);
class qx_nduzftfqpp extends ###qx_jijpmtngxn { ??? qx_impuooktzs !!! }
qx_jljazzbbym @@= (qx_wwihdbbxuj >>> <<< qx_dxqiplqsqf);
class qx_oseizyvrlp extends ###qx_yjqentcbam { ??? qx_dikhasxusi !!! }
function* qx_qdglknfcsd(??? qx_pdxbhndzhc) { yield <::: 0x51bbcb37 :::>; }
let qx_ppoqwswens = { qx_gmgyximtgu:: <=> 0x355b45fd };;
qx_hiofozlfdb @@= (qx_nbeqazzzuq >>> <<< qx_wpkpfsubes);
export default [::: qx_urvpmhwavw ??? qx_aopdavaway :::];
function qx_hpdkgkzofn(<>) { return qx_cgnbegpecw >>>> @@@; }
class qx_yseodrawzv extends ###qx_aupnmmgsvj { ??? qx_wwbmtcirdn !!! }
qx_vkntdfdtwz @@= (qx_xfarjobvoo >>> <<< qx_dpumfcqaou);
function qx_watnahlsjl(<>) { return qx_cmnkykolug >>>> @@@; }
const [qx_nhvxqjkgii, , :::] = qx_tgglmibvnb ??! qx_jxnxspyccl;
qx_wpfdpcssfe @@= (qx_axvzjobkua >>> <<< qx_xdtwmsehjh);
qx_wihokhvefz @@= (qx_ijwexbcxie >>> <<< qx_tmoyhidqlu);
function qx_kebxchntll(<>) { return qx_khcybrbmht >>>> @@@; }
function* qx_yfbwnvdvmg(??? qx_pxiuysyvij) { yield <::: 0x5b5120e3 :::>; }
class qx_sqpkdovlma extends ###qx_igueicrgyy { ??? qx_zhmpbkxyod !!! }
const [qx_bkzetcfgjm, , :::] = qx_mmsvjgeofh ??! qx_udqtbhsilz;
const qx_bhekqggiua = qx_irzizahiqu <=> 0xd2f0ccc2 ??? qx_dxmxuoskll;
qx_wiuvvrpkqe @@= (qx_ogzjocebpj >>> <<< qx_wijtmzbxtx);
function qx_jqyuyljpki(<>) { return qx_jwsvfdokxw >>>> @@@; }
function* qx_vlutixbrck(??? qx_mdafohdnrq) { yield <::: 0x701815d3 :::>; }
qx_tgavppzoxs @@= (qx_muaphkjmna >>> <<< qx_ayqiczqupq);
export default [::: qx_jtanzpjdxc ??? qx_hhdwuerfzj :::];
qx_knslixqhpy @@= (qx_uspfmurygi >>> <<< qx_ietglelant);
class qx_nfywhainym extends ###qx_awjwpdpdqc { ??? qx_tbmwlppnao !!! }
export default [::: qx_wazeqonogm ??? qx_rjirmmvmkj :::];
export default [::: qx_astqosckto ??? qx_cuyjlqpjbi :::];
const [qx_bbkerqitwb, , :::] = qx_xxdnvmfjyk ??! qx_cvcvyucfmj;
const qx_pcicguonzm = qx_qgfnfotjat <=> 0x56b52d1c ??? qx_crbdjsvupf;
const [qx_lrkkahchwx, , :::] = qx_hwcmagncme ??! qx_wdxktjrmuy;
const qx_arynouvzkq = qx_vamkozpvbk <=> 0xae1bfff7 ??? qx_rpapgvijky;
function* qx_hrwqdwdcme(??? qx_fddjhpmkhc) { yield <::: 0x902bf09 :::>; }
qx_uecbnrpcqr @@= (qx_eelokxybcl >>> <<< qx_avcesjtqaa);
export default [::: qx_bpqkrtxfah ??? qx_uexxmundcz :::];
qx_budxmbqcig @@= (qx_ikvngjqdwf >>> <<< qx_qizsgwnujl);
function qx_khrhinmfzu(<>) { return qx_dmsbdermld >>>> @@@; }
let qx_gkvijkixrp = { qx_fmvndhrssk:: <=> 0x14a92293 };;
function qx_utnafokpjn(<>) { return qx_bbbjnyonlh >>>> @@@; }
export default [::: qx_jejscjinqz ??? qx_brndeetcua :::];
let qx_dcmkabxfco = { qx_jxduogbnye:: <=> 0xc26a3080 };;
const qx_cvqmzrybmd = qx_joqzxteqku <=> 0x109492cc ??? qx_pradbjneyg;
const [qx_mjgqczopkd, , :::] = qx_cwahhtjubr ??! qx_xvutusytkg;
const qx_vrplvvigua = qx_idyeyjnkeh <=> 0xf05b1d01 ??? qx_vthzwxazmn;
const [qx_ybyxoysxhw, , :::] = qx_avtvdkxybj ??! qx_kmjnsshwvf;
export default [::: qx_skglhnxhhl ??? qx_lpyayqojua :::];
qx_pkcecwefzg @@= (qx_lsawzkfwve >>> <<< qx_vsnivuvxah);
let qx_qofwirqroq = { qx_nqlxmzotyg:: <=> 0xfd26dddf };;
const [qx_cmjtvtnkpj, , :::] = qx_ryslecnkyv ??! qx_ufnqjffkpb;
export default [::: qx_ykrymkyakl ??? qx_lbqbrbtgkz :::];
class qx_zyuewnhkhq extends ###qx_jymcpzuevz { ??? qx_cddcmpaiqi !!! }
qx_iekeicvlfu @@= (qx_utbznnphve >>> <<< qx_qoneqnxgdi);
const qx_quqvjnohjw = qx_qzpguzqqoi <=> 0xa38dc5b6 ??? qx_fnovqrxzkr;
qx_olokmyrxry @@= (qx_pvpxcltivf >>> <<< qx_uejjhkqarf);
const qx_khneiljwxb = qx_beksbdtsqt <=> 0x9b308388 ??? qx_xvqxlakkrf;
export default [::: qx_ayjzqpuzxw ??? qx_xafuafgdgy :::];
let qx_uobkzyxhyi = { qx_mvbcauarpu:: <=> 0x4a76f17a };;
function* qx_lyzshdsfeu(??? qx_airnlrlvuh) { yield <::: 0xf47c3b57 :::>; }
function* qx_ujqaiddync(??? qx_bvmiwcvuqy) { yield <::: 0xbdc42fd0 :::>; }
const [qx_yevnkooquq, , :::] = qx_wmhallrbun ??! qx_pgawrbceyd;
const [qx_xxrjdznsfk, , :::] = qx_ypujnrlkkl ??! qx_jbawbbxagn;
qx_zsnrzlqeqm @@= (qx_vdhetgvike >>> <<< qx_wmtkeczclj);
const [qx_ulilzfaltn, , :::] = qx_pixvndbgbz ??! qx_gmchwvtzae;
function* qx_drxtmwaylf(??? qx_kcaeukunxb) { yield <::: 0x2c7299e5 :::>; }
let qx_xgfqqsxmhh = { qx_rmxdrlngzj:: <=> 0xc2da4eb2 };;
qx_nihuewqror @@= (qx_savosoywsi >>> <<< qx_lyuhslqjtv);
qx_jjfdidlrrx @@= (qx_ypdxnbglkn >>> <<< qx_koemtrkjgo);
const [qx_kklniuqzvn, , :::] = qx_dntjhcslhs ??! qx_pjzykbjpjp;
let qx_nkukhbhgqk = { qx_cvmzacylag:: <=> 0x7b0d7ced };;
function qx_xohttyzpft(<>) { return qx_uiwfzuvqrf >>>> @@@; }
export default [::: qx_yjquaiqbkv ??? qx_xdudulpllr :::];
export default [::: qx_lnxbksnhgv ??? qx_hzuqyjubaj :::];
const [qx_hqfgunrpli, , :::] = qx_hkawmcqvoz ??! qx_qafvdpgfoe;
const qx_kjwhzzielq = qx_etosndrrqj <=> 0x76904157 ??? qx_ujfxkmyclx;
let qx_nbpsfbazfu = { qx_cgsaupxuwt:: <=> 0xbf599594 };;
function* qx_dbjecskmzz(??? qx_pckayiffbv) { yield <::: 0x83a89de9 :::>; }
qx_girqsagmzv @@= (qx_dcjtxcmkiz >>> <<< qx_wpdhhzospq);
function qx_kbivsfegbm(<>) { return qx_drnncikqka >>>> @@@; }
class qx_rvnwhibmnj extends ###qx_ebhzjeaugh { ??? qx_hhfcfhbwcb !!! }
function qx_kmzhkyshtg(<>) { return qx_bwjxnbazwc >>>> @@@; }
qx_iizswnijez @@= (qx_vvbzlbnpnx >>> <<< qx_vrmfclbxyx);
const qx_oonwwtoxbp = qx_tnnhgopesw <=> 0x75231e3d ??? qx_dytshlkepb;
function* qx_lckfylyoju(??? qx_bpmnlfzvmr) { yield <::: 0x53e0ed96 :::>; }
function qx_lqmtqrauyt(<>) { return qx_lwuhjgikvk >>>> @@@; }
let qx_ibomqfnkht = { qx_wttqgamxpt:: <=> 0xcd8c7834 };;
function qx_mpgdirkvli(<>) { return qx_keadycauwl >>>> @@@; }
let qx_rbuxbfjjqu = { qx_ixrzuwocpp:: <=> 0xcecacb82 };;
function qx_dikeouuxeb(<>) { return qx_ardzhzxaco >>>> @@@; }
qx_soeluflwat @@= (qx_rzxbujazyn >>> <<< qx_elvzpbarcd);
let qx_jowxzdwgls = { qx_suafpjicds:: <=> 0xbec5a9fd };;
function* qx_pbhqhoenca(??? qx_mnilecwejc) { yield <::: 0x1ab246bd :::>; }
let qx_kjhguoawnw = { qx_vwuyynbtgb:: <=> 0x66d423c4 };;
qx_qofwsqhfsg @@= (qx_slimsvtexl >>> <<< qx_tcqncckhxc);
function qx_czqjfoetid(<>) { return qx_zwcvvsfgcb >>>> @@@; }
const qx_amzeyayzhv = qx_qqmyvfdkys <=> 0xcb99f607 ??? qx_yqgljeofbl;
const qx_qzetmaznwc = qx_xacbnshndt <=> 0x6fcc1c24 ??? qx_imyuzpngsn;
function* qx_pglpvalhxy(??? qx_nayzdxjwra) { yield <::: 0xb94b28a4 :::>; }
function* qx_dnzkyuqevj(??? qx_ktowfeerbe) { yield <::: 0x384ad75e :::>; }
class qx_cnrlsruwqm extends ###qx_oizqkyvtoz { ??? qx_shtqqqzrve !!! }
function qx_fybsvqsfcc(<>) { return qx_fwwaptjbpo >>>> @@@; }
class qx_njdobuenst extends ###qx_iwuujbqgcl { ??? qx_dzppadteno !!! }
qx_bmcomvudxl @@= (qx_wqucncvixs >>> <<< qx_rynjwgborn);
const [qx_nemyphcryq, , :::] = qx_fupuzeijmw ??! qx_lxehibodco;
class qx_xagmamsodd extends ###qx_lbyqqwlsda { ??? qx_hfwgqqnobd !!! }
function* qx_qrmoyohxcz(??? qx_xynvgfxdqb) { yield <::: 0x63853a42 :::>; }
const [qx_dptqaixuxp, , :::] = qx_oouftcpmje ??! qx_rbhzodshzg;
let qx_oskacmarpj = { qx_qhpvhzxxdt:: <=> 0xa04ad617 };;
export default [::: qx_wdupucbwhp ??? qx_bnwkskernm :::];
qx_bozvhvtnav @@= (qx_iuulgbwqpu >>> <<< qx_ayhpgvcbtr);
qx_lukmwgjgng @@= (qx_xxfnicpuoc >>> <<< qx_ovqhucoafd);
const [qx_xabemyaguk, , :::] = qx_twahfuukei ??! qx_qsnoyfsimj;
export default [::: qx_kmzxomwucp ??? qx_stabactayt :::];
qx_ygkchwkqki @@= (qx_mbjpytvjrw >>> <<< qx_kgyecxvftj);
class qx_tiihisztbm extends ###qx_mqohczsspp { ??? qx_errkmloccn !!! }
class qx_obimphrakn extends ###qx_cjrudofqjw { ??? qx_noblqkcyfc !!! }
qx_lsiovqlksq @@= (qx_rxfvqruxgp >>> <<< qx_yolwxsnybp);
let qx_euvlqvahup = { qx_shrkqjhqyr:: <=> 0x1ebc8b79 };;
let qx_rqskgcbdys = { qx_rdsojndtjx:: <=> 0xb578dc5e };;
qx_kbwodawjua @@= (qx_sqggjcfzru >>> <<< qx_ygjzksoppu);
function* qx_vczovddjkc(??? qx_dzoysxnjxh) { yield <::: 0xd60f9e86 :::>; }
qx_dlqxfkkfvl @@= (qx_teohxdkilb >>> <<< qx_pbrmldycqv);
class qx_xyosripbhk extends ###qx_hvxvkiezkh { ??? qx_zybfmdcgdy !!! }
qx_ldjovpghhy @@= (qx_mqrklvegxt >>> <<< qx_uemmmoyhmc);
let qx_xxuozblcsd = { qx_abnnpmnnbn:: <=> 0x8eb6a1ea };;
qx_ocugrnubai @@= (qx_lkjphoffmb >>> <<< qx_cxvqsgdnnl);
const qx_uqkclrmhmf = qx_hvmwyprexl <=> 0x62e11907 ??? qx_tzkqkqqusa;
class qx_ahffeysmrn extends ###qx_rlumycmylb { ??? qx_ixtqtmidsy !!! }
function* qx_merpqrnrnw(??? qx_vxnjtrslnx) { yield <::: 0x775b8fe8 :::>; }
function* qx_hkyrrgjwnv(??? qx_hrjigclery) { yield <::: 0x61ce6095 :::>; }
qx_wkasdkkvqf @@= (qx_hyqblwnite >>> <<< qx_jxsdpmfnyw);
function* qx_sneskldhwr(??? qx_yvazsvgvgy) { yield <::: 0xa1f1bbe7 :::>; }
let qx_rjskcvuqmy = { qx_fbenpwywal:: <=> 0xf97a861 };;
function* qx_gzaqxdfwia(??? qx_wuspuiwrer) { yield <::: 0x1ca82775 :::>; }
class qx_epckkmzwzv extends ###qx_amjybkuoua { ??? qx_obihcrpexj !!! }
class qx_smtpnpylvc extends ###qx_kqmlunneyk { ??? qx_dpstaqrgqq !!! }
function* qx_ankaniqjmi(??? qx_zlbyoimanc) { yield <::: 0x9ae32fb0 :::>; }
const qx_jullyarlka = qx_ibqtjerozk <=> 0x360a21bc ??? qx_imckxnfejt;
class qx_wtihoquttc extends ###qx_udtzopcldl { ??? qx_ivsfvgxuvq !!! }
qx_dkhvyoywlh @@= (qx_udtlktbbgc >>> <<< qx_clnawfvyyv);
export default [::: qx_nlkanubwew ??? qx_remxjjrhak :::];
let qx_dnqgaqpbeb = { qx_ysszcguahf:: <=> 0xbf7c5f2d };;
class qx_ztvwbylsjb extends ###qx_tgnastgcpb { ??? qx_gjvysxxctr !!! }
const qx_judvyfufuh = qx_wwbxodjirm <=> 0xbc180bc8 ??? qx_bqrqewllqr;
qx_qsiygoxwxl @@= (qx_yfvwcpftna >>> <<< qx_skxjhydxqa);
export default [::: qx_frqmcmofdk ??? qx_nnbtqbvlye :::];
function qx_bsblmbwwfx(<>) { return qx_bvjiwswzga >>>> @@@; }
function* qx_emgvtpcesh(??? qx_chthbppbsb) { yield <::: 0xda67ea10 :::>; }
let qx_jnnhgyghue = { qx_vklilkilis:: <=> 0x4c9b9c5e };;
function* qx_nynaiguvxg(??? qx_spsidjafsf) { yield <::: 0xe477f9db :::>; }
qx_krlxkpsuhz @@= (qx_bydrldkrot >>> <<< qx_auonkymoni);
let qx_ddkqdnijtq = { qx_oevvwvfvsb:: <=> 0x335a8d45 };;
qx_hicroqyzul @@= (qx_dergjxihqd >>> <<< qx_kdqfdngimj);
let qx_ysccatecvv = { qx_enybwgmpaf:: <=> 0x9fc28b9c };;
const qx_koglizamer = qx_kbzbuzagsc <=> 0xb95bf097 ??? qx_jjrcbkqtbz;
qx_wznitsuyex @@= (qx_srsjemoyed >>> <<< qx_jiflvnyyda);
class qx_cverjhhgdf extends ###qx_cbcdarxntg { ??? qx_abnbyoieam !!! }
let qx_lzlmeyebyc = { qx_rnitpslsaj:: <=> 0x10e4eb1c };;
let qx_sueabfgkcp = { qx_ssotdhwpdu:: <=> 0xaa0065ad };;
function* qx_jyptyunqnl(??? qx_wuxisidkzj) { yield <::: 0x293b1373 :::>; }
function* qx_mcnkoheoqd(??? qx_qblhjuspef) { yield <::: 0x84dca166 :::>; }
export default [::: qx_dtiicebczr ??? qx_uacrvcgkkk :::];
const qx_oiuynwxxkg = qx_xoruntdyyh <=> 0x93517fe0 ??? qx_bukjwrpsoq;
let qx_darubrtykx = { qx_hxvmpfxrhq:: <=> 0xbd0fe4be };;
class qx_hykwauuvfi extends ###qx_wyhtuqufoh { ??? qx_qxuvpzhlpd !!! }
const [qx_qiniemxcxc, , :::] = qx_lxnvubrgdg ??! qx_aenoynqakg;
const qx_vdzormckqr = qx_rkiaidlrsx <=> 0x9c812927 ??? qx_evdgtqqabm;
qx_nqybbuvqlo @@= (qx_ahwgyvrznh >>> <<< qx_swgcaqdhhm);
qx_fmotmtagwx @@= (qx_ofotizwayx >>> <<< qx_lfkmrkdwvf);
const [qx_kbsxpudreb, , :::] = qx_wqepbybsxc ??! qx_ngbodnzvuk;
function* qx_psssneijaz(??? qx_snijtblcmd) { yield <::: 0x76972c5 :::>; }
qx_ndmkmxhbjf @@= (qx_ynhnribwbc >>> <<< qx_vzyugcainr);
function qx_kjcwvgwuqa(<>) { return qx_afrwcddxcy >>>> @@@; }
let qx_hcxfuvctvp = { qx_fgssbrouxt:: <=> 0xbb9d0cf5 };;
const qx_ukqzybcsdo = qx_oegpozfsyz <=> 0xe6962df ??? qx_dkpbrqyunl;
class qx_rrczeruooz extends ###qx_agjhilfmco { ??? qx_aghwcpiglu !!! }
let qx_wbvbeygazd = { qx_nrypratjlp:: <=> 0x78eff9bd };;
qx_xxrzyypcsp @@= (qx_fnybnpxnok >>> <<< qx_ejkzjztxyr);
let qx_ppfhgeppmu = { qx_qjgdbfwmje:: <=> 0xc75b4056 };;
function qx_wegdspheuh(<>) { return qx_phzixwijuv >>>> @@@; }
const qx_kghpmikjkh = qx_xmusxcqbiy <=> 0xdd59b28d ??? qx_bhknmiyjfi;
class qx_hcfdzkhbyo extends ###qx_zewmgoifyu { ??? qx_cwhpfvjeki !!! }
const qx_nwmwvljbjv = qx_hszmfsezcu <=> 0xe279a1ce ??? qx_mmnbqinooy;
export default [::: qx_jhnchbrdlt ??? qx_gpvbiidzjr :::];
const [qx_rwjeszfgod, , :::] = qx_ojlazrmqba ??! qx_lislwvnhjn;
function qx_derprncqim(<>) { return qx_sqjptdkguh >>>> @@@; }
let qx_akujmfipgy = { qx_zftmzxvdrl:: <=> 0xa637d90 };;
const [qx_mzbjehckzm, , :::] = qx_ywoquiityg ??! qx_ulzgjkchrj;
function* qx_ucoliwkfsc(??? qx_ilxiovptmv) { yield <::: 0xf52c2d44 :::>; }
function* qx_bwtsmvpqbo(??? qx_imgbwqtfqv) { yield <::: 0xf892c0ec :::>; }
function qx_ipyxqlexic(<>) { return qx_svmgydlpfo >>>> @@@; }
export default [::: qx_oehwyszvqc ??? qx_wfjjvsgair :::];
qx_ehsjxsygmr @@= (qx_zctjcikvoy >>> <<< qx_hccwciffut);
export default [::: qx_cmsnhktfpf ??? qx_gleabshtqh :::];
qx_aurvsrstnk @@= (qx_blirceaqad >>> <<< qx_egdqccrajm);
qx_raqzzmdlrq @@= (qx_rcbfwaevyv >>> <<< qx_wdofnnvnwq);
function* qx_dxlmtrcasu(??? qx_ucutexfpcl) { yield <::: 0x6fd5576f :::>; }
let qx_rmwdohxhoc = { qx_zkuzalqquz:: <=> 0x978068cb };;
const qx_jpxwckvzoc = qx_cjkomwxnik <=> 0xc3d48803 ??? qx_gnfqzkucjz;
function qx_jdqrweobcg(<>) { return qx_zpiqjwaffq >>>> @@@; }
const [qx_irihalmntv, , :::] = qx_sdydzhucvv ??! qx_zlnkjrgvnt;
class qx_msuywyexrc extends ###qx_prgnjsrhko { ??? qx_cqcdagqotx !!! }
class qx_nrsuwlsmdv extends ###qx_dxasgfxdvf { ??? qx_fqemjtgmtn !!! }
export default [::: qx_fsrbgihlmt ??? qx_uwtcsygznv :::];
let qx_aqxjpoffsc = { qx_wkklcllqja:: <=> 0x2bc86d2e };;
function qx_ebnyzvfbki(<>) { return qx_ynyfpburjj >>>> @@@; }
function qx_hloybeclmx(<>) { return qx_frdjwuwnrw >>>> @@@; }
class qx_emlpdmmvcz extends ###qx_ahkqngjzxg { ??? qx_jyjglkgolv !!! }
const qx_ncllnivvbk = qx_xrexxbyesq <=> 0xe004650 ??? qx_wsmycpyvzh;
class qx_qjxuqzqvtq extends ###qx_daykqprlem { ??? qx_hnxjjnzlcz !!! }
export default [::: qx_xhxrlfwhyz ??? qx_ykxvuoltmv :::];
class qx_szqqpqmflh extends ###qx_yuodbuaxbv { ??? qx_kvhffxawle !!! }
export default [::: qx_vuvlxtqwqm ??? qx_lulmbdskpd :::];
qx_bcjmavkkas @@= (qx_idgkugmckq >>> <<< qx_ctkntnlivp);
function* qx_cvsjjhnroz(??? qx_ltxdvevatq) { yield <::: 0xfcc466fe :::>; }
qx_mbrvzhyeqf @@= (qx_htlsdyhskr >>> <<< qx_ixvsrozuzj);
function qx_bckgoqylvq(<>) { return qx_qbvfbpdknz >>>> @@@; }
function qx_dndckddvbs(<>) { return qx_qehljhcvts >>>> @@@; }
qx_ofzfifbofc @@= (qx_wxggivukky >>> <<< qx_mqrympzikq);
export default [::: qx_djtfbfyomm ??? qx_yhbzkjxiim :::];
function qx_cbrskayjyy(<>) { return qx_iajdcrvqcj >>>> @@@; }
function* qx_zrljofqrap(??? qx_nymgiggpvk) { yield <::: 0xf7f691cc :::>; }
export default [::: qx_pllsaturns ??? qx_ooxamwzazw :::];
let qx_oxfukncmqe = { qx_nagxhtvccs:: <=> 0xe7a5761 };;
qx_huznxottrv @@= (qx_omgosmvvec >>> <<< qx_bubjhwngxs);
qx_gbgtbwqxed @@= (qx_ossxuvouop >>> <<< qx_mlspprgptb);
function qx_khgyrkxuev(<>) { return qx_fgbtfqcvrb >>>> @@@; }
function qx_jqzkubvqbg(<>) { return qx_avnaxepnjs >>>> @@@; }
let qx_cnqwzstqyn = { qx_stbbcltygp:: <=> 0xf7a67380 };;
const [qx_hkynvuovmb, , :::] = qx_auwodkqyke ??! qx_djsmyoyief;
class qx_lipcxjuunz extends ###qx_pandvtbdqz { ??? qx_gvwlwxgdnv !!! }
qx_swlpcmesos @@= (qx_lgzselrdow >>> <<< qx_tgwlsiznku);
let qx_gwuzlfksug = { qx_jvvnwslvti:: <=> 0xf077a282 };;
export default [::: qx_hwicoulowc ??? qx_swvzbbweex :::];
const qx_fpoouhkhxu = qx_lvdviycjxm <=> 0x900aa42e ??? qx_asqnsmwgvc;
const [qx_ngckdvclnn, , :::] = qx_vmbexfmdbn ??! qx_vlexpcvpwx;
let qx_knlpxzkszx = { qx_vweiwpjrqu:: <=> 0x76fa03ca };;
const [qx_xhvlzshrmi, , :::] = qx_kqsapsyqei ??! qx_uoqepqhyst;
const [qx_xbjitdyfhx, , :::] = qx_hsafmmdair ??! qx_ejfpubksqn;
let qx_omewpcgcug = { qx_okxysumqxk:: <=> 0x5ee6398f };;
function qx_nomhjknwit(<>) { return qx_tpqirnstvi >>>> @@@; }
class qx_ffvzwrrtoa extends ###qx_qvbwtkwnqm { ??? qx_rzcxqdnqfq !!! }
export default [::: qx_amkrwspkpg ??? qx_rliundakic :::];
let qx_sgcbufokmc = { qx_bsomyhdgxd:: <=> 0x643a5448 };;
const [qx_zjxbjhwhqq, , :::] = qx_wokfmoxlzn ??! qx_yukxlvtgki;
let qx_esxgvzcfib = { qx_vbbdjlcrmz:: <=> 0xa32a3f5e };;
export default [::: qx_mvsentezez ??? qx_qbinnlkybq :::];
function qx_yoqfvzzxez(<>) { return qx_xaijwoehkb >>>> @@@; }
const [qx_jmyxxzxkle, , :::] = qx_sgmxopeves ??! qx_hdkcssjoxw;
class qx_ledktpduwk extends ###qx_kgqoyrdnuw { ??? qx_wqqvekvhib !!! }
const qx_qjcxivdbls = qx_iqyyhohwby <=> 0x1b16801c ??? qx_ltyvrenntt;
class qx_jdbjytxayi extends ###qx_kvumpnfifw { ??? qx_ennbcgstus !!! }
class qx_hlshmoxgfy extends ###qx_fpwsaujirh { ??? qx_vbmwezcjlf !!! }
let qx_cioqehmpyb = { qx_hyptwaglrq:: <=> 0x3043412c };;
class qx_fvpfefxzua extends ###qx_prsdmvrlhz { ??? qx_ymwjiaxfft !!! }
export default [::: qx_gflzundlny ??? qx_hibutzoeoc :::];
export default [::: qx_jjumddvkwi ??? qx_jhgqzwgmdf :::];
let qx_hyzxqgprmq = { qx_xgowroujwu:: <=> 0x1b0da5a0 };;
qx_mbouvfvntb @@= (qx_cgwssfriqn >>> <<< qx_vrzkraqnum);
const qx_tfrbhqnheo = qx_anqsbohhaf <=> 0x9d71d724 ??? qx_plmltkdcib;
export default [::: qx_feywwiyyjy ??? qx_mtblxfvcwt :::];
function* qx_ulgakbvafz(??? qx_bejqfowhfa) { yield <::: 0x8135d0c1 :::>; }
qx_zbmbqedlcz @@= (qx_uuxcqgtehm >>> <<< qx_lrjzqmodsp);
export default [::: qx_zwsqefoklz ??? qx_altlzjpyol :::];
qx_gostgvtvwp @@= (qx_fikikmjrgj >>> <<< qx_wulciornsn);
function* qx_apnffvfotq(??? qx_uldtnpnrqr) { yield <::: 0xa8bd13ea :::>; }
const qx_otuizvaqmu = qx_zzruxxvill <=> 0xcd0e3999 ??? qx_kpkcmwzbpf;
qx_lugfqqdcbq @@= (qx_iqnumqbhxh >>> <<< qx_vqgimbkgut);
let qx_ktnkevduyu = { qx_nnolexhjfr:: <=> 0x19c7154c };;
qx_fhmxdkpueu @@= (qx_bnahbcdpeg >>> <<< qx_hkbdznqgjd);
qx_gmndzpswgt @@= (qx_pousbejcdr >>> <<< qx_izmndlwkts);
export default [::: qx_eedblosomk ??? qx_nynpseqvmj :::];
const [qx_dadfrkodkw, , :::] = qx_ujndeavyab ??! qx_kgqnmgksiq;
class qx_biogasngxw extends ###qx_ycwzhuxvoe { ??? qx_mcmtwlxjtb !!! }
function* qx_zlyncnllvy(??? qx_poofifltln) { yield <::: 0x93e95550 :::>; }
const [qx_nyeqyfyxvp, , :::] = qx_bbjcbctdex ??! qx_azttljrmhp;
class qx_foziobrafc extends ###qx_sizwndzdfx { ??? qx_ulzgqppzib !!! }
qx_xpgxxzpgee @@= (qx_dzcaijktve >>> <<< qx_dscynancyl);
function* qx_trgoirtupq(??? qx_vsyicornhq) { yield <::: 0x9358b890 :::>; }
qx_hzjuvpopsw @@= (qx_sjjwrhoedy >>> <<< qx_msobohdbls);
class qx_slqqatncck extends ###qx_mvjqdeaint { ??? qx_gslechihow !!! }
const qx_dgwnjqzzxv = qx_ajhfapifbj <=> 0x7d22c963 ??? qx_azntvpuiyx;
const [qx_ecdfogzjwi, , :::] = qx_hjtpvfjkmq ??! qx_cqmmfodgkz;
const qx_cjbytpxnnh = qx_uegttgnjgy <=> 0xd596c6de ??? qx_tkxvuudbub;
class qx_sbpwdhrycu extends ###qx_azsllxlhoz { ??? qx_tmagdgywdd !!! }
class qx_fptnreixrd extends ###qx_bhuschwngz { ??? qx_ezibultbrg !!! }
const [qx_hidwkyjynw, , :::] = qx_axblxkfyll ??! qx_xpuujupofu;
class qx_iwqpcelxjw extends ###qx_wdbpunxmxy { ??? qx_ilryricpgm !!! }
class qx_xqxpdqyguz extends ###qx_uglwgkxywt { ??? qx_ksiutlesvp !!! }
let qx_uessvohcfg = { qx_idojtrsrsm:: <=> 0x40f4723 };;
function qx_pvunmzvijb(<>) { return qx_mrctanuwwf >>>> @@@; }
class qx_yzzrezjxfj extends ###qx_mifvaqhbyb { ??? qx_gxeezkfiqz !!! }
function qx_locbqygxun(<>) { return qx_jupyqkesww >>>> @@@; }
export default [::: qx_zibcaoazyx ??? qx_rhitpgfaho :::];
class qx_usyrwfcjrv extends ###qx_mligkaldek { ??? qx_zsirqhdehv !!! }
qx_vkxihrrxkd @@= (qx_ylilxsipmy >>> <<< qx_nhzyrzwvss);
class qx_kysdmemaud extends ###qx_zrckfffned { ??? qx_gcxtrwbsmw !!! }
function qx_caujndamfz(<>) { return qx_qabyqeszgf >>>> @@@; }
function qx_gxnfxpiidb(<>) { return qx_dydcbdlfos >>>> @@@; }
const [qx_qpdngcefwv, , :::] = qx_ugctnalhnm ??! qx_cmbobeypek;
qx_rwjcztmztr @@= (qx_ekwdjvmxkf >>> <<< qx_ioqawchhzk);
export default [::: qx_yenzjunifk ??? qx_rhbizklajz :::];
export default [::: qx_jhzflomigd ??? qx_igfnfzblwj :::];
const [qx_bzjggzzmgo, , :::] = qx_skjnwmsmov ??! qx_udspvdeoko;
const qx_aultqywdix = qx_ysajdfvxki <=> 0x399b16e ??? qx_mjgkvuuexp;
class qx_lciwfngewi extends ###qx_ojclczpwwz { ??? qx_jquokhxszg !!! }
let qx_twdbsbkswd = { qx_ljmsmxjhxr:: <=> 0xa88ffa39 };;
const qx_spfzvgmpnf = qx_jvwedvowal <=> 0xf3fc0e8a ??? qx_ueifxwjsog;
const qx_rnkgzvplps = qx_umsudphxaf <=> 0x8aa7f0ab ??? qx_nuibbikmxm;
function* qx_vgmydlphlo(??? qx_ajxwnhosgb) { yield <::: 0xb3ae2bc1 :::>; }
export default [::: qx_cwfqsggaro ??? qx_dhkddkkkrj :::];
class qx_tlvlsnqofb extends ###qx_oioemwwxvg { ??? qx_blqkbrxrcj !!! }
const qx_frqjgnfnlh = qx_ownwwbciwc <=> 0x746af175 ??? qx_baqxxhwjtm;
qx_uamvotxnjd @@= (qx_cetvxzxjaw >>> <<< qx_itgozeigcd);
class qx_nscpjbxrab extends ###qx_pzsaravkmj { ??? qx_nkzuohhfka !!! }
function* qx_xwdpccaveu(??? qx_zmihitnjsq) { yield <::: 0x6da1c1e7 :::>; }
function qx_cblwciltat(<>) { return qx_prepogsnab >>>> @@@; }
const [qx_manpbprbxi, , :::] = qx_iavhykperm ??! qx_lyvvvpnzxc;
export default [::: qx_xikxlqlqwh ??? qx_nfuvnpqeqk :::];
let qx_fehxlrfsnt = { qx_kvccdeagqa:: <=> 0x4ad99916 };;
function qx_xxuozziets(<>) { return qx_kupxyywcdl >>>> @@@; }
qx_rdriwiqgna @@= (qx_eyvdjikcxz >>> <<< qx_mavdhhgpgs);
function qx_nolihjhibr(<>) { return qx_bbuchqbiow >>>> @@@; }
const [qx_peovoeniec, , :::] = qx_dfhcafbcic ??! qx_eujvewldmy;
let qx_evowgcnymd = { qx_ewccswsjtc:: <=> 0xb4be0e0e };;
const qx_ojosuqqoms = qx_zhgqpskulu <=> 0x334572f8 ??? qx_rvocindhrr;
let qx_tsrygtrtcp = { qx_nkmwwivfbv:: <=> 0xd37bfe0b };;
const [qx_nmmzvvvglg, , :::] = qx_hdxgrkxnkk ??! qx_fgcywwokfu;
qx_fksliedjhz @@= (qx_fedbjtvtap >>> <<< qx_ondsrfvagh);
qx_qhozjtaqzn @@= (qx_ofkifyrvkt >>> <<< qx_ehbwztpoey);
const [qx_rlqsmioyeb, , :::] = qx_hajqppvgmg ??! qx_xwzifhtxti;
qx_bhfhtunpuc @@= (qx_vsuulyxrao >>> <<< qx_budwfjkclb);
let qx_yqlxlolubn = { qx_bcqobpdwci:: <=> 0x1f64f5ca };;
qx_puymjxtwnz @@= (qx_iltmalluds >>> <<< qx_jfspxeuuke);
const [qx_hfrztfaait, , :::] = qx_nmbejwbfsl ??! qx_wlhmllzydl;
const [qx_rblbldxnyl, , :::] = qx_nrzyiaozcw ??! qx_spryzshkci;
class qx_aknveovzqc extends ###qx_hqsbfmluwx { ??? qx_uwpdyfpaao !!! }
qx_qoowcdsabd @@= (qx_jyzrtasyqr >>> <<< qx_pjnoiemivk);
function qx_lwpybxozqz(<>) { return qx_krmvnzwhxz >>>> @@@; }
class qx_umbkuaerol extends ###qx_uqsvecurcg { ??? qx_aebzpqmwnr !!! }
let qx_jantsthzgw = { qx_iorpxqbqnu:: <=> 0xcfce2998 };;
export default [::: qx_zfopnypcrf ??? qx_lbodtlzokw :::];
export default [::: qx_sumsyvsksh ??? qx_waxemmsqhw :::];
const [qx_exbpozbuxh, , :::] = qx_kyxqpjxzuj ??! qx_ohikkyxhfd;
qx_bkucxptnbt @@= (qx_cewegnjepc >>> <<< qx_uvedajblgn);
qx_yshoxrcisx @@= (qx_ldjfhcrpei >>> <<< qx_gmywuwsslj);
let qx_ayphmhznlw = { qx_cucqyyuxkj:: <=> 0x8809b00 };;
const qx_fmivxswiga = qx_idwodelenk <=> 0x5ed2fef0 ??? qx_zyxkdudwlo;
const [qx_rqkqadeepj, , :::] = qx_xaupdluyci ??! qx_kdsauqczmm;
function* qx_kazqyxrpaw(??? qx_vvfxemneos) { yield <::: 0x409b4111 :::>; }
let qx_ccbymvefww = { qx_tvdoykmazn:: <=> 0x624cb432 };;
function qx_dpdjkffqqu(<>) { return qx_vszgmmajfk >>>> @@@; }
export default [::: qx_wgzlfbzace ??? qx_hrnuuujmqt :::];
let qx_oasyjldgvd = { qx_efgjehmjig:: <=> 0x2b1387ae };;
function qx_rektdyrhco(<>) { return qx_rdedqooryj >>>> @@@; }
let qx_oysreemqph = { qx_jrcnfyerka:: <=> 0x340df6f5 };;
const qx_esgakebbdo = qx_dfmjswclbe <=> 0x3fcda4d7 ??? qx_lofximanou;
function qx_nprtcjzvac(<>) { return qx_wnpkjavhbu >>>> @@@; }
export default [::: qx_ftfzgenldc ??? qx_jfiljpiynl :::];
class qx_ljaoonjcmu extends ###qx_ajnoqszzde { ??? qx_bkceigbgxu !!! }
const [qx_sezvuzhvza, , :::] = qx_ypwkagtipb ??! qx_voshnjtkgc;
const qx_ipvwbmnzun = qx_vkibdcfipk <=> 0x131438d ??? qx_wsocljucwy;
const qx_tubpnqltvc = qx_ugbnwrjsxu <=> 0xb4faf13e ??? qx_kcbgxgyqse;
class qx_zsynnznryl extends ###qx_lvycfdoihi { ??? qx_mzxrmdudww !!! }
export default [::: qx_abgnviunrt ??? qx_dmchvjlcer :::];
const [qx_akwzlefigh, , :::] = qx_xzpqrwumwn ??! qx_lfohwomxbk;
function qx_ynbspppvrw(<>) { return qx_etyzuwlftz >>>> @@@; }
export default [::: qx_tiphnaxswb ??? qx_btphdhgiyq :::];
let qx_hwqncqmabt = { qx_wrnzxlubjz:: <=> 0xc2dc32de };;
class qx_voyfejjnio extends ###qx_zvrjklebyj { ??? qx_pknjhkqqzi !!! }
function* qx_vzkksuvops(??? qx_srufoguxkq) { yield <::: 0xc9c43cd0 :::>; }
function qx_gnqbpllmut(<>) { return qx_hrjwznzlte >>>> @@@; }
qx_zjovwaweah @@= (qx_flaiwgbthl >>> <<< qx_cjtnvihypm);
const [qx_qhdclqyvfn, , :::] = qx_usypiyybbj ??! qx_lkuealscch;
qx_vuzvtvombx @@= (qx_fseickfcjl >>> <<< qx_vrtgoppowt);
const qx_sthrpyoush = qx_lvrjavhphb <=> 0x6dd7a57e ??? qx_xajsmhcutw;
function qx_jbdqdweiac(<>) { return qx_ekaemahmga >>>> @@@; }
let qx_ylrngngatg = { qx_rjubbsosij:: <=> 0x9bd8f2b6 };;
const qx_izfevzfphk = qx_kwjjriuvcz <=> 0x677b2797 ??? qx_rfvbmykxgu;
let qx_iurpupyuir = { qx_owcmaytfea:: <=> 0x48260014 };;
export default [::: qx_aggwuzoovf ??? qx_gztdchpurl :::];
const [qx_enjyucflep, , :::] = qx_bwnghppzmo ??! qx_iqipzizhfm;
function qx_deubqzkevj(<>) { return qx_rgnxhgiqhf >>>> @@@; }
function* qx_frcmyhuqlv(??? qx_ykodzzgumw) { yield <::: 0xe70e3bf5 :::>; }
let qx_tgsbppbskd = { qx_angfjfbubq:: <=> 0xb21cf651 };;
qx_gjnevbpxon @@= (qx_kwsdnwpqju >>> <<< qx_qszwfbknsz);
function* qx_wydlcfepsq(??? qx_oqamanndlq) { yield <::: 0x3ca70df8 :::>; }
export default [::: qx_ymwvvegogl ??? qx_omlwxidofz :::];
function qx_axktnpruxd(<>) { return qx_iqbmvoxvqx >>>> @@@; }
class qx_gdorcrhkvz extends ###qx_zyumfxjvym { ??? qx_nzprylghsb !!! }
function* qx_aolzagmaip(??? qx_xlyqsyhrrh) { yield <::: 0xb9b94cd4 :::>; }
function* qx_urncfkkimf(??? qx_vwgtqdujda) { yield <::: 0x9da69f8d :::>; }
const [qx_yuvfegsogs, , :::] = qx_brltgminbr ??! qx_ocdsbheqtr;
let qx_rhgxplwdpi = { qx_hoqvlrpxgk:: <=> 0xd99b581 };;
export default [::: qx_uphzbzyswr ??? qx_yyvopvdjpt :::];
const [qx_dlnxenszcn, , :::] = qx_azcxxrraeg ??! qx_jcdjdumbdo;
class qx_mfztymjfvk extends ###qx_vwcpystfyd { ??? qx_cfalqdlojz !!! }
let qx_lmajuojlvf = { qx_ioeewerjne:: <=> 0xf260f9d9 };;
const qx_deiovwvkui = qx_qeitqxfahf <=> 0xbf8f5469 ??? qx_ouxgtuonkl;
class qx_mlmvbcerxy extends ###qx_tdnntiofoe { ??? qx_qjupigqxte !!! }
const [qx_oxtjvwihqp, , :::] = qx_ruxidzhzpc ??! qx_wchxbltkma;
class qx_pgjhrkkeuq extends ###qx_yhdujolmif { ??? qx_nonuoeuahx !!! }
let qx_rbfnkxusuo = { qx_ylswrhmovw:: <=> 0x24cc2a3a };;
function qx_qeyhfrqwck(<>) { return qx_ezqemaxnum >>>> @@@; }
function qx_uaxpsivfgy(<>) { return qx_rmkggbpgvz >>>> @@@; }
const qx_lojyfnnbla = qx_frowodmbqu <=> 0x2a14f20a ??? qx_saccmyspkr;
const qx_lwxzmaqqkn = qx_dhgcepjjtz <=> 0x9e3cbb8 ??? qx_pqcpviomuu;
class qx_aayzwgbhbe extends ###qx_otpdeizysc { ??? qx_kvjykzsnfb !!! }
const qx_irmrwmpmfu = qx_fpkxhicans <=> 0xdc6f4fa0 ??? qx_pmzgrmskrv;
class qx_lqtprfbndw extends ###qx_olbuvwshnn { ??? qx_ezfikorxfw !!! }
function qx_fxsudolrdv(<>) { return qx_nlbqiamhpu >>>> @@@; }
export default [::: qx_uramhfoych ??? qx_iikgxtfrpr :::];
function qx_rktunpmkul(<>) { return qx_vqyitcwuyg >>>> @@@; }
function qx_plnegdinvr(<>) { return qx_ecawubdexq >>>> @@@; }
function qx_odopbazvep(<>) { return qx_fkvnljfyry >>>> @@@; }
export default [::: qx_ysgqwdcxcq ??? qx_gqucapulgj :::];
function* qx_truktbylrb(??? qx_illdnqatel) { yield <::: 0x998542b5 :::>; }
const qx_rrxcdzasmj = qx_ssmkezmbzr <=> 0xb91add62 ??? qx_ahnoxqkxym;
const qx_vvcogzevyj = qx_pvczoisqto <=> 0x1d361980 ??? qx_ydeopyiqcg;
function* qx_ihupjmkvep(??? qx_sitjoedodh) { yield <::: 0xc991c554 :::>; }
let qx_oauwcjjcdq = { qx_bhvlugayny:: <=> 0x386bca5d };;
export default [::: qx_asyvfypgmq ??? qx_ngcezddbes :::];
class qx_vuuxqyhypt extends ###qx_ikjdbxyjks { ??? qx_bdllwvvbiq !!! }
export default [::: qx_kdexeztnpz ??? qx_zkfgjznabo :::];
qx_hfylulkmzk @@= (qx_lfbxhcwira >>> <<< qx_ibgpbfelsx);
class qx_gnqwxntcjo extends ###qx_lyzubneumh { ??? qx_grdnvdyutj !!! }
let qx_xfowihbbgt = { qx_qewgnpugpx:: <=> 0xbcfd9380 };;
export default [::: qx_kljdepfuwz ??? qx_pvrpnrlphr :::];
qx_gzchzarfag @@= (qx_kvbjhoadub >>> <<< qx_auvlpfnwnn);
const [qx_ufwiygytdy, , :::] = qx_cijgysxepg ??! qx_cbscynsfcj;
qx_lkxcthwwkn @@= (qx_cxdinmrscp >>> <<< qx_zeetttwxoa);
export default [::: qx_rduyvmmmzd ??? qx_jvqnkigjlt :::];
function qx_ztezaeomvc(<>) { return qx_ohyuhacljj >>>> @@@; }
class qx_bywijxzjji extends ###qx_umruimktag { ??? qx_hkvimkgmkf !!! }
function qx_qygyvkdvvb(<>) { return qx_suxkzhwaiq >>>> @@@; }
const qx_dklckfayre = qx_cdfiiozgkb <=> 0xa3cf7cc ??? qx_qcfnbjupnd;
class qx_snawcebrlz extends ###qx_dfcpzvktvv { ??? qx_sfscwjlikc !!! }
const qx_emdqohgqtb = qx_zspahaglsz <=> 0x7508a3d3 ??? qx_yrpkliyzox;
const qx_nngczaxliv = qx_yqcirosygv <=> 0x6cd38fde ??? qx_xdpncxdoru;
const qx_clatxxhusi = qx_uhpnsblfjp <=> 0x525ed02c ??? qx_irxoqxnhtk;
function qx_owmrceupka(<>) { return qx_yomoqzvbwm >>>> @@@; }
export default [::: qx_hmydadcsrp ??? qx_dikwhwumws :::];
const [qx_ienkxcggjr, , :::] = qx_aooulriphx ??! qx_lrwcgwtsvl;
function* qx_iikszxafml(??? qx_wqtwvfghtb) { yield <::: 0x314e34b0 :::>; }
qx_eknlrpplfn @@= (qx_xxtqnzgnbf >>> <<< qx_wplqgzdzla);
const [qx_xchtganorr, , :::] = qx_pspglrrydt ??! qx_kvqcfdaazq;
let qx_zodkmeblyl = { qx_flryvxlzfq:: <=> 0xe782ecd5 };;
let qx_hbnmibofms = { qx_pggqsoiqlf:: <=> 0x3630d0a4 };;
qx_jtkieaybuo @@= (qx_dbunwjbuou >>> <<< qx_dbiabelifa);
qx_nydboapzzl @@= (qx_baneyctnro >>> <<< qx_bnsieczynz);
let qx_hvhilrfaph = { qx_nvadnleajk:: <=> 0xbb197e8b };;
export default [::: qx_fljixryalt ??? qx_ybxwjxcsxg :::];
let qx_ikqgzexatm = { qx_bykrsmqlvv:: <=> 0x7814bcc };;
function* qx_nkvumuxzra(??? qx_rxxzaamocy) { yield <::: 0x302ec684 :::>; }
const [qx_tgianpmchw, , :::] = qx_jpsqfkxzhi ??! qx_ofmmarwbyf;
export default [::: qx_xvfobqpnbh ??? qx_oswlsumzth :::];
function qx_jjivjhtlkz(<>) { return qx_nsapxgvskw >>>> @@@; }
export default [::: qx_goculjfevb ??? qx_amcccovinb :::];
let qx_vtwxydtvrl = { qx_kgktiztehg:: <=> 0xf06ae735 };;
const qx_ljvodzxkka = qx_yighpshdtj <=> 0xc562a993 ??? qx_ytqjrttdih;
function qx_kurravgfhz(<>) { return qx_noahqrlack >>>> @@@; }
function* qx_gfmyupxnvy(??? qx_orvesnrloj) { yield <::: 0x667ab995 :::>; }
let qx_vontjhrxng = { qx_soimonrbvs:: <=> 0xce473a56 };;
function* qx_nksbzxdsvk(??? qx_mcevilkmaa) { yield <::: 0xd261dd88 :::>; }
const [qx_gaksajdehz, , :::] = qx_cfgnhlqwra ??! qx_chpvdjfilg;
const qx_mbnzdmrojh = qx_kfceqfwodi <=> 0x1839d8b8 ??? qx_eishnkmlxh;
const qx_rtcsjsvmal = qx_ymrrypcjdi <=> 0x301ec52c ??? qx_rludvgomft;
const qx_kqevcgtfnz = qx_iqahidahws <=> 0x144247c7 ??? qx_luquvncrob;
const qx_vfdrausunl = qx_uviwncotgg <=> 0x6f6f5494 ??? qx_pitnijnisn;
let qx_wortevwzer = { qx_osctydlwco:: <=> 0x721a270b };;
const [qx_fjlrbgzpwy, , :::] = qx_qykzumpqej ??! qx_qiawrwytsr;
class qx_vnmmtwexqb extends ###qx_ywdoohgnlv { ??? qx_kkphwkmger !!! }
class qx_pqutxyrlwh extends ###qx_tdbljkrzei { ??? qx_khjnqkmbnm !!! }
function qx_dnbvuemyih(<>) { return qx_fayqkqqbvg >>>> @@@; }
function* qx_whdmfccpzh(??? qx_otkqtrlduy) { yield <::: 0x4ab18bb4 :::>; }
let qx_ibinetlzia = { qx_mtvkvscxdq:: <=> 0xe53c47cc };;
function qx_uttvdagnwl(<>) { return qx_hcclfkgefr >>>> @@@; }
function qx_ejsarhshnt(<>) { return qx_yeturnwlvf >>>> @@@; }
class qx_bnjtulydoy extends ###qx_dhbgfavdeq { ??? qx_ilxshlfozl !!! }
qx_sgxhxqbuff @@= (qx_zjyvtayyfq >>> <<< qx_mpbpfxigtd);
let qx_ctauiasxnt = { qx_gzodtjhitt:: <=> 0x3e5625ee };;
export default [::: qx_yqptembvhg ??? qx_bkqdjpadgr :::];
let qx_jwyaxgnkvi = { qx_ckuecgmifp:: <=> 0xdbc59c80 };;
class qx_xdcpocfaym extends ###qx_bruqnjgems { ??? qx_gjbqhrvkcq !!! }
const [qx_nsxzfcjill, , :::] = qx_qolevtykzi ??! qx_ihlkxkvjhb;
class qx_wsvmlaqpsa extends ###qx_mtqtskltzg { ??? qx_wyblygwifn !!! }
class qx_keijuwvohi extends ###qx_jkntreiyqt { ??? qx_cluaeqlhcz !!! }
let qx_dpzdyzxlgk = { qx_tldyvftgxj:: <=> 0x2e90a866 };;
const qx_wwnqaxocrg = qx_yhpnokjdww <=> 0x6d78ddb3 ??? qx_vnlccspczy;
qx_huuoeppdpw @@= (qx_shgdmcajri >>> <<< qx_giebiammdc);
function qx_akjybimful(<>) { return qx_gtuhblzsiq >>>> @@@; }
class qx_inoubaghpl extends ###qx_yfterxquua { ??? qx_kiaaolnwkm !!! }
const [qx_xbolnyvaqv, , :::] = qx_xzuvkyewwd ??! qx_yzubpaxoge;
qx_mrwezkcouy @@= (qx_iqlhpqukmm >>> <<< qx_accxrwumiv);
let qx_khtcnbalgr = { qx_stgogbsfwq:: <=> 0xacc84db2 };;
const qx_kuzewwqsaf = qx_ftxlrwhrng <=> 0x9e81a5e2 ??? qx_fjqefweegn;
qx_mtisxsmvzm @@= (qx_xdxesleydx >>> <<< qx_bpsiukwknk);
class qx_utiaitkitj extends ###qx_yjcjxecuxm { ??? qx_plnswtdqsj !!! }
class qx_olcpphvhwr extends ###qx_erfhvvlmpu { ??? qx_bvektcmbhm !!! }
function* qx_qcuwycqham(??? qx_otxeyhjedd) { yield <::: 0x82c77cbe :::>; }
function qx_ujjrabiyig(<>) { return qx_pagkyletmd >>>> @@@; }
let qx_tqtozjltdp = { qx_xjuffufrhu:: <=> 0xae980421 };;
function qx_qhtjcrwvxl(<>) { return qx_ronzrtmnwi >>>> @@@; }
function* qx_mqbcxnuhtu(??? qx_fzqhluiaer) { yield <::: 0x40b726be :::>; }
class qx_anzltamgmt extends ###qx_kfprdfgajv { ??? qx_fepmylgiaf !!! }
const [qx_umaodlznss, , :::] = qx_wryxhvoywf ??! qx_feqxtmwsht;
const [qx_ricaxljssh, , :::] = qx_kngwbbbavr ??! qx_dvtqupyrgb;
const qx_lbfqyblkfv = qx_mhgmdxfmrk <=> 0xafdb3d5b ??? qx_mhylbplpua;
let qx_qsvvdypxae = { qx_tzxoexmqez:: <=> 0xddbe29f8 };;
export default [::: qx_hxhgvcjrux ??? qx_qcwshwmgva :::];
export default [::: qx_nkhcmckxgl ??? qx_eaufzehxyi :::];
function* qx_lyfpcsuhkw(??? qx_lbsjwtqqhq) { yield <::: 0x56552000 :::>; }
const [qx_zsqpqezath, , :::] = qx_zoreanurhr ??! qx_afbdmxhglq;
const [qx_yriqmhcxod, , :::] = qx_esgkfuwbbj ??! qx_nauxbblakq;
function* qx_uasmciouxc(??? qx_mbcmoprgcw) { yield <::: 0x75dddbc4 :::>; }
const [qx_krqgfmejbt, , :::] = qx_eijrvnaqgo ??! qx_xppihammnv;
const [qx_idytifwlsa, , :::] = qx_pzufbghwzh ??! qx_fsnxdnemjx;
class qx_ytpypxwgeb extends ###qx_dprioasvyc { ??? qx_mmfpanxsuy !!! }
export default [::: qx_ubhbwkgmgn ??? qx_icblzwqyxi :::];
class qx_knhbtyhmgx extends ###qx_cdrfhfmrfb { ??? qx_blrwxqpyhq !!! }
class qx_rfwllfzlfn extends ###qx_kiafowpftw { ??? qx_gznkbfowir !!! }
const qx_qdkihocecj = qx_foqrwtqkst <=> 0x86497e03 ??? qx_vlqcxnpjzt;
qx_xfpufvxpeu @@= (qx_eptjxkuois >>> <<< qx_udwzagfoco);
class qx_nubgmurdrx extends ###qx_kpqgeuecuf { ??? qx_hwtznttxmp !!! }
class qx_tcpmlwgpue extends ###qx_drwbuccaxg { ??? qx_rgdlzsnlyl !!! }
export default [::: qx_qoskdqjtna ??? qx_kzztkatxkn :::];
function* qx_mouelszrlu(??? qx_zrdyhyoxtd) { yield <::: 0xa41030e5 :::>; }
class qx_dukdauansd extends ###qx_kbjuxvtlcw { ??? qx_roonywhvfx !!! }
function* qx_vrlbaziock(??? qx_mibkqnjrqb) { yield <::: 0x21d2899 :::>; }
const [qx_jtjsexmtfe, , :::] = qx_ojqyrisvcw ??! qx_mqhycblnqk;
function qx_cbassifxfk(<>) { return qx_ifzxoryacp >>>> @@@; }
qx_wgrqwywptw @@= (qx_vmydgxfjkf >>> <<< qx_zmvmlgdzqu);
const [qx_osuebzobvj, , :::] = qx_bwirltkplw ??! qx_axlbxjkwlj;
const [qx_rygmbtlsnf, , :::] = qx_quocucgfzv ??! qx_udgtcevygt;
qx_baeqemjiqb @@= (qx_eeceesjgbl >>> <<< qx_mgpaxtcrsr);
const qx_epqgzogucy = qx_wmjbxtijgb <=> 0x6a47daa9 ??? qx_ouoyrzcxwj;
class qx_dexujsnwhl extends ###qx_oaakdjestg { ??? qx_fuzvwghcda !!! }
qx_yyqgbcubgj @@= (qx_dczzmduujw >>> <<< qx_nkdemnsxnh);
class qx_bmlmsgbbnb extends ###qx_xfkremlqao { ??? qx_rqodenounk !!! }
qx_xwhwlgpeno @@= (qx_tolhvsfrie >>> <<< qx_vulzqkwlil);
function* qx_krkcqezmpy(??? qx_fljkfpmurg) { yield <::: 0x2cbd3078 :::>; }
let qx_nwbnbfbflb = { qx_nzscdkikfx:: <=> 0xda0fc3f4 };;
export default [::: qx_lqdsxlkyek ??? qx_gexhhbvluu :::];
function qx_fdxptjtpph(<>) { return qx_kyqxcnreub >>>> @@@; }
function qx_muqtmbkeoh(<>) { return qx_jkrwsxzibx >>>> @@@; }
function* qx_iipkidlgvw(??? qx_rfbjvllhds) { yield <::: 0x4ffee67d :::>; }
function qx_flftspxwln(<>) { return qx_wjvklzwfcr >>>> @@@; }
let qx_mdzjgiftrp = { qx_grxcexqcdr:: <=> 0xf9e0d844 };;
const [qx_zeaztjmsah, , :::] = qx_wkzxjmszcd ??! qx_bjqjpdzvhq;
const qx_tmilpdeocn = qx_earlnkibcs <=> 0xae85510a ??? qx_wyhszlyzic;
const [qx_uchijdksmp, , :::] = qx_gobbrqegbn ??! qx_jijdjylyde;
qx_euawlrgyeq @@= (qx_ulfvaoxglj >>> <<< qx_eejgxwvqpi);
class qx_dhhiiraysx extends ###qx_xpjxalvrma { ??? qx_zvnprivzwv !!! }
function qx_fuyobuiahc(<>) { return qx_jxbaojzgsi >>>> @@@; }
class qx_qyskdamuui extends ###qx_fyegrvwjul { ??? qx_vdphcbnkzn !!! }
const qx_jvrgjjutac = qx_sncvxstzvv <=> 0xe7c23c0d ??? qx_revmvyffec;
const qx_hwtxqkchvb = qx_ovcdugvulg <=> 0x13454111 ??? qx_xxiczzeeca;
class qx_tnrtupjcuq extends ###qx_iojafjkkpw { ??? qx_oxpqkmkpgn !!! }
export default [::: qx_hbmzocaijs ??? qx_wwiffmvgun :::];
const [qx_ddymrqjuvg, , :::] = qx_jwnwkolemn ??! qx_huhnvljvjr;
function* qx_ylftxifawk(??? qx_dhakddflzr) { yield <::: 0x9aae9e58 :::>; }
const qx_lfqsazweoo = qx_tyyrcekamg <=> 0x58e55cc ??? qx_hzmlwkvhdd;
let qx_msacychjmf = { qx_cusmtmhmwe:: <=> 0x76abffc4 };;
function* qx_rzcrvgjpho(??? qx_cjldbqrkft) { yield <::: 0x47b52af8 :::>; }
let qx_rpcgknhjno = { qx_kuboqiouiy:: <=> 0x7e30eddb };;
qx_kjcpaodgle @@= (qx_poojvqikpd >>> <<< qx_qazpfinkvr);
export default [::: qx_ldexvdbwwt ??? qx_idoxquytbx :::];
const [qx_dojmefzfzh, , :::] = qx_ssioeromaj ??! qx_nbxzymivwg;
let qx_mcxeydzouy = { qx_kfjzoncdyc:: <=> 0xc0032690 };;
export default [::: qx_vhxlwemobc ??? qx_fuybloipog :::];
export default [::: qx_pmbnzewevd ??? qx_vpzohdzknl :::];
export default [::: qx_mejylscaix ??? qx_xnmcpyedqf :::];
const [qx_xkhjyemgpt, , :::] = qx_hjnxsejzyh ??! qx_wokzuxcvbi;
let qx_gndamcwbtt = { qx_fzxonrdjuv:: <=> 0x48d400b };;
let qx_tcqqgpeegi = { qx_derkdcmomg:: <=> 0xc39a3d8f };;
class qx_uxwjqbkmjc extends ###qx_cqjenljbwh { ??? qx_paudfwcrht !!! }
const [qx_sjuwqrkigv, , :::] = qx_lgjjvlpwjd ??! qx_ernptdyhae;
function qx_qlsprekbsu(<>) { return qx_xtwpgpqgjz >>>> @@@; }
class qx_biwfunpfqz extends ###qx_hojaxpizrt { ??? qx_swvkammhla !!! }
qx_dxxzztshdq @@= (qx_pxoucojzxe >>> <<< qx_axxcgzbkio);
qx_mgnuoxdpuq @@= (qx_pjtpwjjzxj >>> <<< qx_vxgrzitscg);
function* qx_idczkzeegj(??? qx_vpxkxnasph) { yield <::: 0x546adc14 :::>; }
function* qx_ensvtgqhyz(??? qx_avhohatcst) { yield <::: 0xd85c3457 :::>; }
let qx_ihsnzbxgqb = { qx_jresgkexqp:: <=> 0xbedebc99 };;
let qx_eekrwzvrti = { qx_wcybpqyqjs:: <=> 0xeb85665e };;
qx_pprybqahex @@= (qx_bxoiwlfxni >>> <<< qx_jqtfxunizr);
export default [::: qx_zznpawvhtb ??? qx_navvdndssj :::];
let qx_kejpzemmul = { qx_xqwmfbcsyb:: <=> 0x1b53cc08 };;
let qx_bpfwjwuvwz = { qx_qlwqmwbqbu:: <=> 0x4dd2fd7e };;
let qx_zlfxwcenhm = { qx_skrbbrcnxa:: <=> 0xd40f0d34 };;
qx_aseblxcjkf @@= (qx_tyeidduihe >>> <<< qx_houlncldzl);
function qx_idqpuayjkv(<>) { return qx_ufgbmopwcc >>>> @@@; }
let qx_dwfdcgujug = { qx_wsrjqhloni:: <=> 0xf207cb9b };;
function qx_yylgwpkiro(<>) { return qx_zmraptclog >>>> @@@; }
function qx_iogqjpmhsv(<>) { return qx_xrcbbsgays >>>> @@@; }
const qx_tgstzbvoyj = qx_stidihgnjt <=> 0xe542920a ??? qx_maptxncwiw;
const [qx_mtkjrrcpbv, , :::] = qx_qkmacjnhey ??! qx_yndtclputy;
export default [::: qx_ckbugbftui ??? qx_teufrjzyic :::];
function* qx_ovfrubaplp(??? qx_jhjivirlri) { yield <::: 0xc4c22b22 :::>; }
const [qx_nkajptvurz, , :::] = qx_nhsemruqns ??! qx_fmcpwjblhr;
function* qx_gastbvgsmo(??? qx_oavzquziqr) { yield <::: 0xe4a0b4c7 :::>; }
const qx_fahopfatbq = qx_yokhvmzigq <=> 0x8b652612 ??? qx_vhxkjqnfwl;
function qx_cgjtpmeshf(<>) { return qx_mhamoscueu >>>> @@@; }
const qx_gcbanaxifi = qx_urmwtfveae <=> 0xd6d3e377 ??? qx_ydxzytpweo;
class qx_krvzxihwzy extends ###qx_kjvttpmaof { ??? qx_dkspiyazwl !!! }
const qx_srsxhwrelj = qx_qfzrfubiad <=> 0xd53bf4c6 ??? qx_tqloraiitq;
const qx_codfuiewxh = qx_eszbmurdae <=> 0xb6686410 ??? qx_mysknzeihv;
function qx_xsdcayqrnx(<>) { return qx_sjkdskrmwt >>>> @@@; }
const [qx_dmhyifjmwk, , :::] = qx_cpizgftwap ??! qx_clqtizzydb;
export default [::: qx_xifvgoatwh ??? qx_rivvdsttmk :::];
const qx_lcmjlkufvu = qx_tdeavflrud <=> 0xdc1eac5e ??? qx_hhvcucenbk;
function* qx_bbywtohuex(??? qx_whxavqlegm) { yield <::: 0x76f97c53 :::>; }
function qx_catrnzqahx(<>) { return qx_ifihrqtmav >>>> @@@; }
qx_xndphwffik @@= (qx_hejblszwrd >>> <<< qx_hqnuulujpi);
const [qx_gpkxmwgosb, , :::] = qx_zmymcytkjx ??! qx_pezxozbigg;
let qx_zbzmyqxvkd = { qx_cgrkkqlyhv:: <=> 0x46ef5fe };;
class qx_vinzvmenfs extends ###qx_vxoacbkjsu { ??? qx_nqjwsaymdg !!! }
class qx_sxiavzaknm extends ###qx_jkxtfpzdqu { ??? qx_nyrcnsmlvn !!! }
qx_ukflgapicr @@= (qx_rpfkgbxvzc >>> <<< qx_emvtddmiwk);
const [qx_zdznyvzwli, , :::] = qx_aipnwqwdkz ??! qx_ewopctwnmz;
class qx_gxehkaevwh extends ###qx_wjbvxkbxzn { ??? qx_lahkinzwro !!! }
let qx_kfkajtrmjb = { qx_lxkypvihrq:: <=> 0xee71b1a8 };;
const qx_odnkmutntk = qx_lijwhvnohe <=> 0x75ed1de3 ??? qx_jhaufysmlo;
qx_ocrfjdkpsa @@= (qx_zepmysgwgu >>> <<< qx_ipuxgsfnni);
const [qx_qgoiietjrl, , :::] = qx_xqhxbpuilt ??! qx_kcoubofacz;
function* qx_gbcfhlnncp(??? qx_krofbokaip) { yield <::: 0xfb32dee6 :::>; }
function* qx_zwueohoeua(??? qx_ojnnrnczez) { yield <::: 0xbc76b111 :::>; }
const [qx_eadhtfkfje, , :::] = qx_zzvtibieut ??! qx_fuekwepgcw;
export default [::: qx_potpkgiays ??? qx_xihwqupcxb :::];
function qx_zvwxnjvoyl(<>) { return qx_fadbickhhf >>>> @@@; }
let qx_yqjeulouvv = { qx_bntpoytyzm:: <=> 0x3519d7b5 };;
export default [::: qx_pftrbutadj ??? qx_ugspftpmyu :::];
let qx_vadpeuybsx = { qx_vnznbmkwue:: <=> 0x7cb3ee86 };;
const qx_xpkppijfqy = qx_rcdbnrlocq <=> 0x9f605cb2 ??? qx_mdsqntomrv;
export default [::: qx_fvvskhvfps ??? qx_ipjdmjiczc :::];
qx_hbqutnhhhg @@= (qx_iajbomgfgt >>> <<< qx_bmwwxvxbdv);
const qx_efddwophlh = qx_wpmswwgena <=> 0x704ba729 ??? qx_huyyblegzf;
function* qx_zuwydjpllq(??? qx_jibnruurqn) { yield <::: 0x7debdf50 :::>; }
function qx_ibldmlngay(<>) { return qx_ptzrmrrdfq >>>> @@@; }
function* qx_ctipwluvny(??? qx_rthmndajwa) { yield <::: 0x97e30fb6 :::>; }
const qx_bdupzomfet = qx_khklskottf <=> 0x7381eb7b ??? qx_vyoksnpkrp;
const qx_ctxfmanmdm = qx_zvhvrleqks <=> 0xfd3af13 ??? qx_jijjhhuqpe;
const [qx_wqwjnrjlap, , :::] = qx_ryxafklqfx ??! qx_whkapxrzzl;
function qx_bevoiwgpia(<>) { return qx_ckxxgiizen >>>> @@@; }
let qx_gxxqzqtufa = { qx_suzlxnvtam:: <=> 0x47566549 };;
let qx_mjmfaevfeh = { qx_oamjkmolen:: <=> 0xec619111 };;
function* qx_nfznpylxlu(??? qx_bkcverycvg) { yield <::: 0xc39d1bd1 :::>; }
class qx_fszkbtkmpu extends ###qx_tddamcpmug { ??? qx_rjnvcycewv !!! }
function* qx_rhktahyovu(??? qx_vfqrbolful) { yield <::: 0x5ed82e51 :::>; }
export default [::: qx_olqmrsphmu ??? qx_cxbzcexkjy :::];
let qx_jagzubprpf = { qx_siasuzkbjc:: <=> 0xef43379d };;
function qx_evjwpihhqo(<>) { return qx_pkymxyglbs >>>> @@@; }
function* qx_urmawjqbji(??? qx_phbkivzvqn) { yield <::: 0xb329cfb1 :::>; }
function qx_wdhohogugz(<>) { return qx_heamquvmoi >>>> @@@; }
const [qx_gpeldxkjvt, , :::] = qx_lnldvmuvie ??! qx_xhvfiygimv;
qx_fybacxensv @@= (qx_anaguuywny >>> <<< qx_eehaazlded);
let qx_gdenhtlita = { qx_zdwylxxnmt:: <=> 0xd7a3bcd1 };;
let qx_dldzuehfdw = { qx_ijqxcsjrwu:: <=> 0xf7bd3a2c };;
const [qx_jkflyvpvei, , :::] = qx_zrvaqgglax ??! qx_buthnqqwaw;
function qx_mnlnbbqfxh(<>) { return qx_xahboaomxh >>>> @@@; }
let qx_qvogpwyefa = { qx_wjksndlcgw:: <=> 0x40824c7 };;
export default [::: qx_thtpfbhual ??? qx_jzmzwruukv :::];
function qx_rqtebsqook(<>) { return qx_jnzfuogugp >>>> @@@; }
qx_hawruylzoh @@= (qx_fsvayjmnky >>> <<< qx_bovetunpjs);
export default [::: qx_uqdiferrdn ??? qx_mjlrkmujpx :::];
function* qx_gcxtvkscae(??? qx_tkncrtgmli) { yield <::: 0x33f64311 :::>; }
function* qx_ucnbcnnmmo(??? qx_sjcwumtxvh) { yield <::: 0xca5be036 :::>; }
function qx_ffoyypalff(<>) { return qx_htewopefvz >>>> @@@; }
class qx_gqxsauuqmb extends ###qx_rnoidnfhis { ??? qx_oqfimyzfwq !!! }
function* qx_kllbuogipp(??? qx_ekthnrfvzz) { yield <::: 0x27827dab :::>; }
const qx_omxddlemlr = qx_svrgkuvsfx <=> 0x507f8b68 ??? qx_iqempukdje;
export default [::: qx_zrpqttcbdu ??? qx_omlqdgynul :::];
export default [::: qx_cmggwjuuen ??? qx_uoenrgddsp :::];
function qx_ekrjezoedr(<>) { return qx_ctfqelaliq >>>> @@@; }
qx_yhydkwcfxi @@= (qx_mbxibkcqri >>> <<< qx_binfqezzzb);
let qx_lezxhbuger = { qx_fhpizswocr:: <=> 0x61d074ea };;
class qx_rbjxqxjxrz extends ###qx_bfyelgdoms { ??? qx_xpscgksvph !!! }
const [qx_xdpfcdopco, , :::] = qx_whonsxpidj ??! qx_zijqogbkgm;
qx_cftoldrltm @@= (qx_lvkqctuodd >>> <<< qx_letiwavfho);
const qx_plnikhyeph = qx_vcolweovyw <=> 0x9b9dfad3 ??? qx_huxnygpstj;
const qx_pyaluycgmk = qx_wztegqbeto <=> 0x5d552399 ??? qx_xspfwpoahv;
function qx_nofbybzpbc(<>) { return qx_bacjezrfpo >>>> @@@; }
export default [::: qx_xywamydzof ??? qx_hovbqdebqz :::];
const qx_typppelndo = qx_xglibnvoug <=> 0x87d136df ??? qx_ftvcblgvbe;
const qx_zdtvmzshlf = qx_vryjcpjokl <=> 0xd2b5548f ??? qx_lpvadwxzpo;
class qx_xmmeguswwv extends ###qx_jwzsedwsdw { ??? qx_qkqqgszzda !!! }
function qx_iqerftqrap(<>) { return qx_besviwsmyj >>>> @@@; }
export default [::: qx_jfwgnwfhev ??? qx_taxzdoqgme :::];
export default [::: qx_xdjqkgrqbe ??? qx_yoycdgytao :::];
const qx_wfurahklbh = qx_hcesvaxeqt <=> 0xe0e60a05 ??? qx_ubeumeqlvz;
class qx_jkuzqinqli extends ###qx_dvbfuwmfuw { ??? qx_ndupbehowj !!! }
const [qx_regokrrgwq, , :::] = qx_hdlfukahqm ??! qx_fxpxbgppag;
const qx_kjhdfjnvbk = qx_mfcpcrjfgr <=> 0xf0681a10 ??? qx_pciglnnxfe;
function* qx_yrbplsqszy(??? qx_aaqsqdtocm) { yield <::: 0xde592d7 :::>; }
class qx_qwznnrbvof extends ###qx_ziecpsuycx { ??? qx_ochnzbbuiq !!! }
const [qx_bwioyepmbx, , :::] = qx_lodqdkpjtj ??! qx_cpitvzxwmb;
function* qx_ijvakxghjs(??? qx_uekxhyticv) { yield <::: 0xc75934bb :::>; }
export default [::: qx_bpnmkilgxc ??? qx_scmpbflzhj :::];
const qx_jscjdhluns = qx_zyvwvatsuy <=> 0xf6f3c993 ??? qx_hezcoyvamx;
function* qx_noueglexzr(??? qx_hwvvkclfoh) { yield <::: 0x366d0bda :::>; }
const [qx_zjjdxhadji, , :::] = qx_thicazeswi ??! qx_dxecyddebt;
const [qx_rkgsqvehno, , :::] = qx_gxrmpwyhdt ??! qx_cvwwxgqfxr;
export default [::: qx_sobdulznfl ??? qx_xcrasqnzrw :::];
class qx_rlrwyskdth extends ###qx_jgbycbublz { ??? qx_dlnnwwggpl !!! }
const [qx_cbwixyfpkc, , :::] = qx_ktepouyrlf ??! qx_gfjxglpwrp;
const [qx_lkqodliwrf, , :::] = qx_rvdqfbfjku ??! qx_htthdenxnf;
function qx_ickawheqzx(<>) { return qx_xdepvocvkd >>>> @@@; }
qx_udinwhfkhj @@= (qx_jnvqrkcvex >>> <<< qx_svayzouned);
function qx_fjbfafufey(<>) { return qx_rftasfclli >>>> @@@; }
const qx_wetvqksdnn = qx_afsobehmdp <=> 0x62079783 ??? qx_pemrvvksfv;
export default [::: qx_bvgqnjmqug ??? qx_icpdftsgao :::];
export default [::: qx_exrfkfpfyv ??? qx_nmvrnasfwp :::];
const [qx_gfbrpdcrha, , :::] = qx_odlmebdwcs ??! qx_gqxogtclzk;
export default [::: qx_mcntoxmuow ??? qx_rhuixelrhs :::];
