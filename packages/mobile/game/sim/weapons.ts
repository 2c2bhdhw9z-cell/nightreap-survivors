/**
 * Weapons — what the player picks up, levels, and eventually evolves.
 *
 * WHAT THIS IS, IN PLAIN TERMS
 * A weapon is a row of numbers plus a firing pattern. It says "every 1.2 seconds, throw three
 * knives at the nearest enemy for 8 damage each". Levelling it edits those numbers. The player's
 * stats — might, area, cooldown, extra projectiles — edit them again on the way out. Nothing here
 * knows what a whip is; it knows a sweep archetype with a set of numbers, which is why weapon seven
 * and weapon forty cost the same amount of code.
 *
 * WHY IT IS SPLIT THIS WAY
 *  - Weapon definitions are pure data, versioned, with append-only wire ids, because they are
 *    written into save files, replay headers and co-op packets. Renaming a weapon must never
 *    invalidate someone's save.
 *  - Levels are a table of deltas rather than eight hand-written stat blocks. It reads the way the
 *    level-up card reads to the player ("+1 projectile", "+5 damage"), so the card text is generated
 *    from the same data that applies the effect and the two can never disagree.
 *  - Stats apply at fire time, not at pickup time. Grabbing a might upgrade must strengthen weapons
 *    you already own — that is the entire feeling of the genre.
 *  - Firing allocates nothing. One reused spawn request, filled in and handed to the projectile
 *    store. A screen with six maxed weapons fires hundreds of shots a second.
 */

import type { Rng } from "../core/rng";
import type { EnemyStore } from "./enemies";
import {
  BRAD_FULL,
  createSpawnRequest,
  GRAVITY,
  MOVE,
  type MoveKind,
  nearestEnemy,
  PROJ_FLAG,
  type OwnerPositions,
  type ProjectileStore,
  type SpawnRequest,
} from "./projectiles";
import { PASSIVE_BY_ID } from "./passives";
import { STAT, STAT_SCALE, type Stats } from "./stats";

/** Weapons a single player can carry. Matches the genre and the HUD layout. */
export const MAX_WEAPONS = 6;

/** Highest level a weapon reaches before it needs an evolution to keep growing. */
export const MAX_WEAPON_LEVEL = 8;

const TICKS_PER_SECOND = 60;

/** What one level-up adds. Every field is optional; absent means unchanged. */
export interface WeaponLevel {
  /** Player-facing card text. Written here so the card and the effect can never drift apart. */
  readonly text: string;
  /** Flat damage added. */
  readonly damage?: number;
  /** Extra projectiles per volley. */
  readonly count?: number;
  /** Ticks removed from the cooldown. */
  readonly cooldown?: number;
  /** Extra enemies each projectile passes through. */
  readonly pierce?: number;
  /** World pixels added to the hit radius. */
  readonly radius?: number;
  /** Ticks added to how long it lives. */
  readonly ttl?: number;
  /** World units per second added to travel speed. */
  readonly speed?: number;
  /** Ticks removed from an aura's damage interval — i.e. it ticks faster. */
  readonly retick?: number;
}

/** A weapon, as content. */
export interface WeaponType {
  /** Stable string id used in content files and dev tooling. */
  readonly id: string;
  /** Player-facing name. */
  readonly name: string;
  /**
   * Append-only numeric id. Written into saves, replays and co-op packets. Never reuse, never
   * reorder, never renumber — an old replay would decode into the wrong weapon.
   */
  readonly wireId: number;
  readonly move: MoveKind;
  /** One-line description for the level-up card and the collection screen. */
  readonly blurb: string;

  readonly damage: number;
  /** Ticks between volleys, before the cooldown stat is applied. */
  readonly cooldown: number;
  readonly count: number;
  readonly speed: number;
  readonly radius: number;
  readonly ttl: number;
  readonly pierce: number;
  readonly knockback: number;
  readonly flags: number;
  /** Ticks between damage ticks, for re-ticking shapes. */
  readonly retick: number;
  /** Distance from the player for sweeps and orbiters. */
  readonly anchorDist: number;
  /** Degrees of arc a sweep travels, or degrees per second for an orbiter. */
  readonly arc: number;
  /** Spread across a volley, in degrees. 0 fires everything on one line. */
  readonly spread: number;
  /** Atlas frame index. Visual only. */
  readonly sprite: number;
  /** Levels 2 through 8. Seven entries. */
  readonly levels: readonly WeaponLevel[];
  /** Weapon this becomes when evolved, by id. Empty means it is already the end of its line. */
  readonly evolvesTo: string;
  /** Passive item required to evolve, by id. Empty means nothing is required. */
  readonly evolveRequires: string;
  /**
   * The weapon this one evolved from, by id. Empty for everything the player can be offered.
   *
   * This is what keeps an evolution out of the level-up screen. An evolution is not a weapon you can
   * be offered, find, or start with — it is earned by taking a weapon to the top and holding the
   * right passive, and it only ever arrives out of a chest.
   */
  readonly evolvedFrom: string;
}

const DEG_TO_BRAD = BRAD_FULL / 360;

/**
 * The six launch weapons, one per archetype.
 *
 * Chosen so that every firing pattern in the engine is exercised by something the player can
 * actually hold. If a seventh archetype is ever needed, it shows up here as a gap rather than as a
 * surprise during content work.
 */
export const WEAPON_TYPES: readonly WeaponType[] = [
  {
    id: "reapersLash",
    name: "Reaper's Lash",
    wireId: 1,
    move: MOVE.sweep,
    blurb: "Cracks horizontally. Strikes both sides once levelled.",
    damage: 10,
    cooldown: 75,
    count: 1,
    speed: 0,
    radius: 14,
    ttl: 12,
    pierce: 99,
    knockback: 60,
    flags: PROJ_FLAG.reticks,
    retick: 12,
    anchorDist: 26,
    arc: 70,
    spread: 0,
    sprite: 0,
    evolvesTo: "reapersVerdict",
    evolveRequires: "grimSigil",
    evolvedFrom: "",
    levels: [
      { text: "Strikes the other side too", count: 1 },
      { text: "+5 damage", damage: 5 },
      { text: "Reaches further", radius: 5 },
      { text: "+5 damage", damage: 5 },
      { text: "Cracks faster", cooldown: 12 },
      { text: "+8 damage", damage: 8 },
      { text: "One more strike", count: 1 },
    ],
  },
  {
    id: "boneKnives",
    name: "Bone Knives",
    wireId: 2,
    move: MOVE.homing,
    blurb: "Splinters that chase down whatever is closest.",
    damage: 7,
    cooldown: 60,
    count: 1,
    speed: 210,
    radius: 6,
    ttl: 110,
    pierce: 0,
    knockback: 20,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 1,
    evolvesTo: "boneStorm",
    evolveRequires: "wanderersBoots",
    evolvedFrom: "",
    levels: [
      { text: "+1 knife", count: 1 },
      { text: "+1 knife", count: 1 },
      { text: "Passes through one more enemy", pierce: 1 },
      { text: "+4 damage", damage: 4 },
      { text: "+1 knife", count: 1 },
      { text: "Thrown faster", speed: 60, cooldown: 8 },
      { text: "+6 damage", damage: 6 },
    ],
  },
  {
    id: "gravebolt",
    name: "Gravebolt",
    wireId: 3,
    move: MOVE.straight,
    blurb: "A fan of bolts fired the way you are facing.",
    damage: 6,
    cooldown: 90,
    count: 3,
    speed: 260,
    radius: 5,
    ttl: 90,
    pierce: 1,
    knockback: 15,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 26,
    sprite: 2,
    evolvesTo: "gravehail",
    evolveRequires: "ashHourglass",
    evolvedFrom: "",
    levels: [
      { text: "+2 bolts", count: 2 },
      { text: "+3 damage", damage: 3 },
      { text: "Passes through one more enemy", pierce: 1 },
      { text: "+2 bolts", count: 2 },
      { text: "Fires faster", cooldown: 15 },
      { text: "+4 damage", damage: 4 },
      { text: "Passes through two more enemies", pierce: 2 },
    ],
  },
  {
    id: "tombAxe",
    name: "Tomb Axe",
    wireId: 4,
    move: MOVE.arcing,
    blurb: "Hurled overhead. Cleaves everything on the way up and down.",
    damage: 18,
    cooldown: 105,
    count: 1,
    speed: 190,
    radius: 11,
    ttl: 130,
    pierce: 99,
    knockback: 90,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 22,
    sprite: 3,
    evolvesTo: "tombfall",
    evolveRequires: "boneCharm",
    evolvedFrom: "",
    levels: [
      { text: "+1 axe", count: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Bigger blade", radius: 4 },
      { text: "+1 axe", count: 1 },
      { text: "+12 damage", damage: 12 },
      { text: "Thrown more often", cooldown: 18 },
      { text: "+1 axe", count: 1 },
    ],
  },
  {
    id: "shroudedTome",
    name: "Shrouded Tome",
    wireId: 5,
    move: MOVE.orbiting,
    blurb: "Circles you, grinding down anything that closes in.",
    damage: 12,
    cooldown: 210,
    count: 1,
    speed: 0,
    radius: 10,
    ttl: 180,
    pierce: 99,
    knockback: 0,
    flags: PROJ_FLAG.reticks | PROJ_FLAG.noKnockback,
    retick: 24,
    anchorDist: 52,
    arc: 200,
    spread: 0,
    sprite: 4,
    evolvesTo: "codexOfHollows",
    evolveRequires: "hollowLantern",
    evolvedFrom: "",
    levels: [
      { text: "+1 tome", count: 1 },
      { text: "+6 damage", damage: 6 },
      { text: "Orbits wider", radius: 3, ttl: 30 },
      { text: "+1 tome", count: 1 },
      { text: "+8 damage", damage: 8 },
      { text: "Stays out longer", ttl: 60 },
      { text: "+1 tome", count: 1 },
    ],
  },
  {
    id: "rotAura",
    name: "Rot Aura",
    wireId: 6,
    move: MOVE.aura,
    blurb: "A ring of decay. Anything that touches you rots.",
    damage: 5,
    cooldown: 0,
    count: 1,
    speed: 0,
    radius: 40,
    ttl: 2_000_000_000,
    pierce: 99,
    knockback: 0,
    flags: PROJ_FLAG.reticks | PROJ_FLAG.noCrit | PROJ_FLAG.noKnockback,
    retick: 30,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 5,
    evolvesTo: "plagueBloom",
    evolveRequires: "gravemossRoot",
    evolvedFrom: "",
    levels: [
      { text: "Wider ring", radius: 8 },
      { text: "+3 damage", damage: 3 },
      { text: "Rots faster", retick: 4 },
      { text: "Wider ring", radius: 8 },
      { text: "+4 damage", damage: 4 },
      { text: "Rots faster", retick: 4 },
      { text: "Wider ring", radius: 10 },
    ],
  },
  // --- Evolutions -------------------------------------------------------------------------------
  //
  // An evolution is never offered on a card and never found on the floor. It is earned: take a weapon
  // to its top level, hold the passive it asks for, and the next chest turns it into this. It arrives
  // finished — granted at the top level — so what a player sees is the base numbers below plus every
  // one of its level-ups at once. Its level-ups still exist because they are what "finished" means,
  // and writing them out keeps an evolution the same shape as every other weapon rather than a
  // special case the firing code has to know about.
  {
    id: "reapersVerdict",
    name: "Reaper's Verdict",
    wireId: 7,
    move: MOVE.sweep,
    blurb: "The lash, answered. Cuts both sides at once and does not care what is in the way.",
    damage: 26,
    cooldown: 54,
    count: 2,
    speed: 0,
    radius: 22,
    ttl: 16,
    pierce: 99,
    knockback: 120,
    flags: PROJ_FLAG.reticks,
    retick: 8,
    anchorDist: 30,
    arc: 110,
    spread: 0,
    sprite: 0,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "reapersLash",
    levels: [
      { text: "+6 damage", damage: 6 },
      { text: "Reaches further", radius: 4 },
      { text: "+6 damage", damage: 6 },
      { text: "One more strike", count: 1 },
      { text: "Cracks faster", cooldown: 8 },
      { text: "+8 damage", damage: 8 },
      { text: "Reaches further", radius: 4 },
    ],
  },
  {
    id: "boneStorm",
    name: "Bone Storm",
    wireId: 8,
    move: MOVE.homing,
    blurb: "A blizzard of splinters. Nothing closes the distance.",
    damage: 15,
    cooldown: 34,
    count: 4,
    speed: 300,
    radius: 8,
    ttl: 140,
    pierce: 3,
    knockback: 30,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 1,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "boneKnives",
    levels: [
      { text: "+1 knife", count: 1 },
      { text: "+4 damage", damage: 4 },
      { text: "Passes through one more enemy", pierce: 1 },
      { text: "+1 knife", count: 1 },
      { text: "+5 damage", damage: 5 },
      { text: "Thrown faster", speed: 40, cooldown: 6 },
      { text: "+1 knife", count: 1 },
    ],
  },
  {
    id: "gravehail",
    name: "Gravehail",
    wireId: 9,
    move: MOVE.straight,
    blurb: "A wall of bolts, wide enough that aiming stops mattering.",
    damage: 13,
    cooldown: 52,
    count: 7,
    speed: 320,
    radius: 7,
    ttl: 110,
    pierce: 3,
    knockback: 25,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 54,
    sprite: 2,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "gravebolt",
    levels: [
      { text: "+2 bolts", count: 2 },
      { text: "+3 damage", damage: 3 },
      { text: "Passes through two more enemies", pierce: 2 },
      { text: "+2 bolts", count: 2 },
      { text: "Fires faster", cooldown: 10 },
      { text: "+4 damage", damage: 4 },
      { text: "+2 bolts", count: 2 },
    ],
  },
  {
    id: "tombfall",
    name: "Tombfall",
    wireId: 10,
    move: MOVE.arcing,
    blurb: "Headstones out of the sky. Everything under them stops being a problem.",
    damage: 46,
    cooldown: 76,
    count: 3,
    speed: 210,
    radius: 18,
    ttl: 150,
    pierce: 99,
    knockback: 150,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 34,
    sprite: 3,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "tombAxe",
    levels: [
      { text: "+12 damage", damage: 12 },
      { text: "Bigger blade", radius: 3 },
      { text: "+1 headstone", count: 1 },
      { text: "+14 damage", damage: 14 },
      { text: "Thrown more often", cooldown: 12 },
      { text: "+16 damage", damage: 16 },
      { text: "+1 headstone", count: 1 },
    ],
  },
  {
    id: "codexOfHollows",
    name: "Codex of Hollows",
    wireId: 11,
    move: MOVE.orbiting,
    blurb: "A ring of open books. Whatever comes close is read out and put down.",
    damage: 30,
    cooldown: 150,
    count: 3,
    speed: 0,
    radius: 16,
    ttl: 260,
    pierce: 99,
    knockback: 0,
    flags: PROJ_FLAG.reticks | PROJ_FLAG.noKnockback,
    retick: 14,
    anchorDist: 46,
    arc: 260,
    spread: 0,
    sprite: 4,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "shroudedTome",
    levels: [
      { text: "+1 tome", count: 1 },
      { text: "+8 damage", damage: 8 },
      { text: "Orbits wider", radius: 3, ttl: 30 },
      { text: "+1 tome", count: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Stays out longer", ttl: 60 },
      { text: "Grinds faster", retick: 3 },
    ],
  },
  {
    id: "plagueBloom",
    name: "Plague Bloom",
    wireId: 12,
    move: MOVE.aura,
    blurb: "The rot, in flower. Standing near you is the mistake.",
    damage: 14,
    cooldown: 0,
    count: 1,
    speed: 0,
    radius: 82,
    ttl: 2_000_000_000,
    pierce: 99,
    knockback: 0,
    flags: PROJ_FLAG.reticks | PROJ_FLAG.noCrit | PROJ_FLAG.noKnockback,
    retick: 18,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 5,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "rotAura",
    levels: [
      { text: "Wider bloom", radius: 8 },
      { text: "+4 damage", damage: 4 },
      { text: "Rots faster", retick: 3 },
      { text: "Wider bloom", radius: 8 },
      { text: "+5 damage", damage: 5 },
      { text: "Rots faster", retick: 3 },
      { text: "Wider bloom", radius: 10 },
    ],
  },
];

export const WEAPON_BY_ID: ReadonlyMap<string, number> = new Map(
  WEAPON_TYPES.map((w, i) => [w.id, i]),
);

export const WEAPON_BY_WIRE_ID: ReadonlyMap<number, number> = new Map(
  WEAPON_TYPES.map((w, i) => [w.wireId, i]),
);

if (WEAPON_BY_WIRE_ID.size !== WEAPON_TYPES.length) {
  throw new Error("two weapons share a wire id — saves and replays would decode wrongly");
}

for (const w of WEAPON_TYPES) {
  if (w.levels.length !== MAX_WEAPON_LEVEL - 1) {
    throw new Error(
      `weapon ${w.id} has ${w.levels.length} level-ups, expected ${MAX_WEAPON_LEVEL - 1}`,
    );
  }
}

/**
 * Every promise an evolution makes has to be real, checked the moment this file loads.
 *
 * A weapon that claims to evolve into something the game does not have, or asks for a passive that
 * does not exist, would be a dead end the player can never see coming: they would take the weapon to
 * the top, hold the item, open chest after chest and never be told why nothing happened.
 */
for (const w of WEAPON_TYPES) {
  if (w.evolvesTo !== "") {
    const target = WEAPON_TYPES.find((t) => t.id === w.evolvesTo);
    if (target === undefined) {
      throw new Error(`weapon ${w.id} evolves into ${w.evolvesTo}, which does not exist`);
    }
    if (target.evolvedFrom !== w.id) {
      throw new Error(`${w.evolvesTo} does not point back at ${w.id} — the pair would half-work`);
    }
    if (w.evolveRequires === "") {
      throw new Error(`weapon ${w.id} evolves but asks for nothing — a chest would hand it out free`);
    }
  }
  if (w.evolvedFrom !== "" && !WEAPON_TYPES.some((t) => t.id === w.evolvedFrom)) {
    throw new Error(`${w.id} evolved from ${w.evolvedFrom}, which does not exist`);
  }
  if (w.evolveRequires !== "" && !PASSIVE_BY_ID.has(w.evolveRequires)) {
    throw new Error(`weapon ${w.id} needs passive ${w.evolveRequires}, which does not exist`);
  }
  if (w.evolvedFrom !== "" && w.evolvesTo !== "") {
    throw new Error(`${w.id} is an evolution of an evolution — the ladder has to end`);
  }
}

/**
 * A weapon's numbers at a given level, before player stats.
 *
 * Reused scratch, not a fresh object, because this is read every time a weapon considers firing.
 */
export interface WeaponSnapshot {
  damage: number;
  cooldown: number;
  count: number;
  speed: number;
  radius: number;
  ttl: number;
  pierce: number;
  retick: number;
}

export function createWeaponSnapshot(): WeaponSnapshot {
  return { damage: 0, cooldown: 0, count: 0, speed: 0, radius: 0, ttl: 0, pierce: 0, retick: 0 };
}

/**
 * Fold a weapon's level-ups into its base numbers.
 *
 * Deliberately additive and order-independent: the same weapon at level 5 is identical whether the
 * player took those levels early or late, which is what makes a replay reproducible and a co-op
 * client's prediction match the host's.
 */
export function snapshotWeapon(typeIndex: number, level: number, out: WeaponSnapshot): void {
  const t = WEAPON_TYPES[typeIndex];
  out.damage = t.damage;
  out.cooldown = t.cooldown;
  out.count = t.count;
  out.speed = t.speed;
  out.radius = t.radius;
  out.ttl = t.ttl;
  out.pierce = t.pierce;
  out.retick = t.retick;

  const top = level > MAX_WEAPON_LEVEL ? MAX_WEAPON_LEVEL : level;
  for (let l = 2; l <= top; l++) {
    const up = t.levels[l - 2];
    if (up === undefined) continue;
    out.damage += up.damage ?? 0;
    out.count += up.count ?? 0;
    out.cooldown -= up.cooldown ?? 0;
    out.pierce += up.pierce ?? 0;
    out.radius += up.radius ?? 0;
    out.ttl += up.ttl ?? 0;
    out.speed += up.speed ?? 0;
    out.retick -= up.retick ?? 0;
  }

  if (out.cooldown < 6) out.cooldown = 6;
  if (out.retick < 4 && t.retick > 0) out.retick = 4;
  if (out.count < 1) out.count = 1;
}

/**
 * Every weapon every player is carrying, and their firing timers.
 *
 * Flat arrays indexed `player * MAX_WEAPONS + slot`. One player uses the first six entries and the
 * loop runs over `playerCount * MAX_WEAPONS`, so solo runs the identical code path as a four-player
 * run with no co-op branch anywhere — which is the whole reason co-op cannot break solo.
 */
export class WeaponStore {
  readonly maxPlayers: number;
  /** Weapon type index, or -1 for an empty slot. */
  readonly typeIndex: Int32Array;
  readonly level: Int32Array;
  /** Ticks until this weapon may fire again. */
  readonly timer: Int32Array;
  /** Per-weapon damage total, for the results screen breakdown. */
  readonly dealt: Float64Array;

  private readonly req: SpawnRequest = createSpawnRequest();
  private readonly snap: WeaponSnapshot = createWeaponSnapshot();
  /** Alternating side for sweeps, per weapon slot. */
  private readonly flip: Uint8Array;

  playerCount = 1;

  constructor(maxPlayers = 4) {
    this.maxPlayers = maxPlayers;
    const n = maxPlayers * MAX_WEAPONS;
    this.typeIndex = new Int32Array(n).fill(-1);
    this.level = new Int32Array(n);
    this.timer = new Int32Array(n);
    this.dealt = new Float64Array(n);
    this.flip = new Uint8Array(n);
  }

  reset(playerCount: number): void {
    this.playerCount = playerCount < 1 ? 1 : playerCount > this.maxPlayers ? this.maxPlayers : playerCount;
    this.typeIndex.fill(-1);
    this.level.fill(0);
    this.timer.fill(0);
    this.dealt.fill(0);
    this.flip.fill(0);
  }

  /** Slots a player is carrying. */
  countFor(player: number): number {
    const base = player * MAX_WEAPONS;
    let n = 0;
    for (let i = 0; i < MAX_WEAPONS; i++) if (this.typeIndex[base + i] >= 0) n++;
    return n;
  }

  /** Which slot holds this weapon for this player, or -1. */
  slotOf(player: number, weaponTypeIndex: number): number {
    const base = player * MAX_WEAPONS;
    for (let i = 0; i < MAX_WEAPONS; i++) {
      if (this.typeIndex[base + i] === weaponTypeIndex) return base + i;
    }
    return -1;
  }

  /**
   * Give a player a weapon, or level the one they already have.
   *
   * Returns the new level, or 0 if they are full and do not already carry it. Returning 0 rather
   * than throwing matters: the card-draw code must be able to ask "can this be offered" and a full
   * loadout is an ordinary situation, not an error.
   */
  grant(player: number, weaponTypeIndex: number): number {
    const existing = this.slotOf(player, weaponTypeIndex);
    if (existing >= 0) {
      if (this.level[existing] >= MAX_WEAPON_LEVEL) return this.level[existing];
      this.level[existing]++;
      return this.level[existing];
    }
    const base = player * MAX_WEAPONS;
    for (let i = 0; i < MAX_WEAPONS; i++) {
      if (this.typeIndex[base + i] >= 0) continue;
      this.typeIndex[base + i] = weaponTypeIndex;
      this.level[base + i] = 1;
      // Fire on the very next tick. Picking a weapon and watching nothing happen for two seconds
      // reads as a bug even when it is not.
      this.timer[base + i] = 0;
      this.flip[base + i] = 0;
      return 1;
    }
    return 0;
  }

  /**
   * Turn a weapon a player is carrying into its evolution, in the same slot.
   *
   * Returns false when they were not carrying it. The slot is kept on purpose: an evolution is not a
   * seventh weapon and must never cost the player a slot, and keeping the position means the HUD does
   * not reshuffle underneath them at the moment the upgrade lands. It arrives at the top level, which
   * is what "finished" means — an evolution the player then has to level again would be a downgrade.
   */
  evolveInPlace(player: number, fromTypeIndex: number, toTypeIndex: number): boolean {
    const slot = this.slotOf(player, fromTypeIndex);
    if (slot < 0) return false;
    this.typeIndex[slot] = toTypeIndex;
    this.level[slot] = MAX_WEAPON_LEVEL;
    // Fire immediately, for the same reason a newly picked weapon does.
    this.timer[slot] = 0;
    this.flip[slot] = 0;
    return true;
  }

  /** True when this weapon is carried and cannot be levelled further. */
  isMaxed(player: number, weaponTypeIndex: number): boolean {
    const slot = this.slotOf(player, weaponTypeIndex);
    return slot >= 0 && this.level[slot] >= MAX_WEAPON_LEVEL;
  }

  /** True when the player has no free slot left. */
  isFull(player: number): boolean {
    return this.countFor(player) >= MAX_WEAPONS;
  }

  /** Levels of a weapon a player carries, 0 if they do not carry it. */
  levelOf(player: number, weaponTypeIndex: number): number {
    const slot = this.slotOf(player, weaponTypeIndex);
    return slot < 0 ? 0 : this.level[slot];
  }

  /**
   * One tick of every weapon on the field.
   *
   * `facing` supplies each player's aim direction as a pair of arrays, because directional weapons
   * fire where the player is looking and the weapon store must not depend on the player store.
   */
  update(
    owners: OwnerPositions,
    facingX: Float32Array,
    facingY: Float32Array,
    alive: Uint8Array,
    enemies: EnemyStore,
    projectiles: ProjectileStore,
    stats: Stats,
    rng: Rng,
  ): void {
    const cooldownScale = stats.get(STAT.cooldown);
    const areaScale = stats.get(STAT.area);
    const speedScale = stats.get(STAT.projectileSpeed);
    const durationScale = stats.get(STAT.duration);
    const damageScale = stats.get(STAT.damage);
    const extraCount = stats.get(STAT.amount);
    const extraPierce = stats.get(STAT.pierce);

    const players = owners.count < this.playerCount ? owners.count : this.playerCount;

    for (let p = 0; p < players; p++) {
      const base = p * MAX_WEAPONS;
      for (let i = 0; i < MAX_WEAPONS; i++) {
        const slot = base + i;
        const type = this.typeIndex[slot];
        if (type < 0) continue;

        snapshotWeapon(type, this.level[slot], this.snap);
        const t = WEAPON_TYPES[type];

        const damage = Math.max(1, Math.trunc((this.snap.damage * damageScale) / STAT_SCALE));
        const radius = Math.max(2, Math.trunc((this.snap.radius * areaScale) / STAT_SCALE));
        const ttl = Math.max(2, Math.trunc((this.snap.ttl * durationScale) / STAT_SCALE));
        const speed = Math.trunc((this.snap.speed * speedScale) / STAT_SCALE);
        const pierce = this.snap.pierce + extraPierce;
        const count = this.snap.count + extraCount;
        const retick = this.snap.retick;

        // An aura is not fired, it is maintained. Keeping the same shape alive means its damage
        // timer is not reset by a stat change mid-run.
        if (t.move === MOVE.aura) {
          if (!projectiles.refresh(p, type, damage, radius, retick)) {
            if (alive[p] !== 0) {
              this.spawnAura(p, type, t, damage, radius, retick, owners, projectiles);
            }
          }
          continue;
        }

        if (this.timer[slot] > 0) {
          this.timer[slot]--;
          continue;
        }
        // A downed player's weapons go quiet. Their timers still run down, so a rescue brings them
        // straight back into the fight rather than into a fresh cooldown.
        if (alive[p] === 0) continue;

        const cooldown = Math.max(
          6,
          Math.trunc((this.snap.cooldown * cooldownScale) / STAT_SCALE),
        );
        this.timer[slot] = cooldown;

        this.fire(
          p,
          slot,
          type,
          t,
          damage,
          radius,
          ttl,
          speed,
          pierce,
          count,
          retick,
          owners,
          facingX,
          facingY,
          enemies,
          projectiles,
          rng,
        );
      }
    }
  }

  private spawnAura(
    player: number,
    type: number,
    t: WeaponType,
    damage: number,
    radius: number,
    retick: number,
    owners: OwnerPositions,
    projectiles: ProjectileStore,
  ): void {
    const r = this.req;
    resetRequest(r);
    r.move = MOVE.aura;
    r.x = owners.x[player];
    r.y = owners.y[player];
    r.damage = damage;
    r.radius = radius;
    r.ttl = t.ttl;
    r.pierce = t.pierce;
    r.owner = player;
    r.weapon = type;
    r.flags = t.flags;
    r.retick = retick;
    r.sprite = t.sprite;
    projectiles.spawn(r);
  }

  private fire(
    player: number,
    slot: number,
    type: number,
    t: WeaponType,
    damage: number,
    radius: number,
    ttl: number,
    speed: number,
    pierce: number,
    count: number,
    retick: number,
    owners: OwnerPositions,
    facingX: Float32Array,
    facingY: Float32Array,
    enemies: EnemyStore,
    projectiles: ProjectileStore,
    rng: Rng,
  ): void {
    const px = owners.x[player];
    const py = owners.y[player];
    const r = this.req;

    switch (t.move) {
      case MOVE.sweep: {
        // Alternate sides so a single-strike whip covers both over time, and a levelled one hits
        // both at once. Matches the genre and reads as intentional rather than random.
        const arcBrad = Math.round(t.arc * DEG_TO_BRAD);
        const step = ttl > 0 ? Math.round(arcBrad / ttl) : arcBrad;
        for (let n = 0; n < count; n++) {
          const rightwards = (this.flip[slot] + n) % 2 === 0;
          const centre = rightwards ? 0 : BRAD_FULL >> 1;
          resetRequest(r);
          r.move = MOVE.sweep;
          r.x = px;
          r.y = py;
          r.damage = damage;
          r.radius = radius;
          r.ttl = ttl;
          r.pierce = pierce;
          r.owner = player;
          r.weapon = type;
          r.flags = t.flags;
          r.knockback = t.knockback;
          r.angle = (centre - (arcBrad >> 1) + BRAD_FULL) & (BRAD_FULL - 1);
          r.angularVel = step;
          r.anchorDist = radius + t.anchorDist;
          r.retick = retick;
          r.sprite = t.sprite;
          projectiles.spawn(r);
        }
        this.flip[slot] = (this.flip[slot] + 1) & 1;
        break;
      }

      case MOVE.homing: {
        for (let n = 0; n < count; n++) {
          // Aim at whatever is closest; with nothing in range, throw where the player looks so the
          // weapon never silently does nothing on an empty screen.
          const target = nearestEnemy(enemies, px, py, 420);
          let dx = facingX[player];
          let dy = facingY[player];
          if (target >= 0) {
            dx = enemies.x[target] - px;
            dy = enemies.y[target] - py;
          }
          const len = Math.hypot(dx, dy) || 1;
          // Fan them slightly so three knives are visibly three knives.
          const jitter = (n - (count - 1) / 2) * 7 * DEG_TO_BRAD;
          const rad = (jitter * Math.PI * 2) / BRAD_FULL;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const nx = dx / len;
          const ny = dy / len;
          resetRequest(r);
          r.move = MOVE.homing;
          r.x = px;
          r.y = py;
          r.vx = (nx * cos - ny * sin) * speed;
          r.vy = (nx * sin + ny * cos) * speed;
          r.damage = damage;
          r.radius = radius;
          r.ttl = ttl;
          r.pierce = pierce;
          r.owner = player;
          r.weapon = type;
          r.flags = t.flags;
          r.knockback = t.knockback;
          r.sprite = t.sprite;
          projectiles.spawn(r);
        }
        break;
      }

      case MOVE.straight: {
        const spreadBrad = t.spread * DEG_TO_BRAD;
        const fx = facingX[player];
        const fy = facingY[player];
        const len = Math.hypot(fx, fy) || 1;
        const nx = fx / len;
        const ny = fy / len;
        for (let n = 0; n < count; n++) {
          const off = count === 1 ? 0 : (n / (count - 1) - 0.5) * spreadBrad;
          const rad = (off * Math.PI * 2) / BRAD_FULL;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          resetRequest(r);
          r.move = MOVE.straight;
          r.x = px;
          r.y = py;
          r.vx = (nx * cos - ny * sin) * speed;
          r.vy = (nx * sin + ny * cos) * speed;
          r.damage = damage;
          r.radius = radius;
          r.ttl = ttl;
          r.pierce = pierce;
          r.owner = player;
          r.weapon = type;
          r.flags = t.flags;
          r.knockback = t.knockback;
          r.sprite = t.sprite;
          projectiles.spawn(r);
        }
        break;
      }

      case MOVE.arcing: {
        for (let n = 0; n < count; n++) {
          // Thrown up and out, then gravity does the rest. The horizontal side alternates so a pair
          // of axes covers both flanks.
          const side = n % 2 === 0 ? 1 : -1;
          const lateral = rng.nextRange(30, 30 + t.spread) * side;
          resetRequest(r);
          r.move = MOVE.arcing;
          r.x = px;
          r.y = py;
          r.vx = lateral;
          r.vy = -speed;
          r.damage = damage;
          r.radius = radius;
          r.ttl = ttl;
          r.pierce = pierce;
          r.owner = player;
          r.weapon = type;
          r.flags = t.flags;
          r.knockback = t.knockback;
          r.gravity = GRAVITY;
          r.sprite = t.sprite;
          projectiles.spawn(r);
        }
        break;
      }

      case MOVE.orbiting: {
        const perTick = Math.round((t.arc * DEG_TO_BRAD) / TICKS_PER_SECOND);
        for (let n = 0; n < count; n++) {
          // Spaced evenly around the ring, so two tomes are opposite each other rather than stacked.
          const phase = Math.round((BRAD_FULL * n) / count);
          resetRequest(r);
          r.move = MOVE.orbiting;
          r.x = px;
          r.y = py;
          r.damage = damage;
          r.radius = radius;
          r.ttl = ttl;
          r.pierce = pierce;
          r.owner = player;
          r.weapon = type;
          r.flags = t.flags;
          r.angle = phase;
          r.angularVel = perTick;
          r.anchorDist = t.anchorDist + radius;
          r.retick = retick;
          r.sprite = t.sprite;
          projectiles.spawn(r);
        }
        break;
      }

      default:
        break;
    }
  }
}

/** Return a reused request to defaults. Cheaper and safer than remembering to set every field. */
function resetRequest(r: SpawnRequest): void {
  r.move = MOVE.straight;
  r.x = 0;
  r.y = 0;
  r.vx = 0;
  r.vy = 0;
  r.damage = 1;
  r.radius = 8;
  r.ttl = 60;
  r.pierce = 0;
  r.owner = 0;
  r.weapon = 0;
  r.flags = 0;
  r.knockback = 0;
  r.angle = 0;
  r.angularVel = 0;
  r.anchorDist = 0;
  r.gravity = 0;
  r.retick = 30;
  r.sprite = 0;
}
