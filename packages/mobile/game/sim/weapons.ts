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
import { fxCosF, fxSinF } from "../core/fx";
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
 * The fifteen launch weapons, plus the fifteen evolutions they become.
 *
 * The first six were one per archetype, chosen so every firing pattern in the engine was exercised by
 * something the player could actually hold. The other nine are the launch set proper, and they are
 * deliberately built out of the same six patterns rather than new ones: a pattern is engine work and a
 * weapon is a row of numbers, so nine more weapons cost nine rows and no new risk. What separates them
 * is the numbers and the behaviour switches — one bounces off the arena wall, one turns around at the
 * halfway point and comes back, one sits on the player and pulses, one leaves a fire on the floor.
 *
 * Wire ids are append-only. The first twelve keep the numbers they were born with, because they are
 * already written into save files, replay headers and co-op packets; the new ones take 13 upward.
 *
 * Every base weapon has exactly one evolution and every evolution asks for a different passive item, so
 * a player chasing two evolutions at once is genuinely choosing between them rather than getting both
 * out of one pickup.
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
  {
    id: "cinderflask",
    name: "Cinder Flask",
    wireId: 13,
    move: MOVE.arcing,
    blurb: "Lobbed glass that breaks into a fire the horde has to walk through.",
    damage: 11,
    cooldown: 115,
    count: 1,
    speed: 175,
    radius: 22,
    ttl: 100,
    pierce: 99,
    knockback: 0,
    flags: PROJ_FLAG.reticks | PROJ_FLAG.noKnockback | PROJ_FLAG.lands,
    retick: 16,
    anchorDist: 0,
    arc: 0,
    spread: 18,
    sprite: 6,
    evolvesTo: "hellmouthFlask",
    evolveRequires: "hollowedCrown",
    evolvedFrom: "",
    levels: [
      { text: "+1 flask", count: 1 },
      { text: "+6 damage", damage: 6 },
      { text: "Wider fire", radius: 6 },
      { text: "Burns longer", ttl: 30 },
      { text: "+1 flask", count: 1 },
      { text: "Burns faster", retick: 4 },
      { text: "+8 damage", damage: 8 },
    ],
  },
  {
    id: "pallbearersBell",
    name: "Pallbearer's Bell",
    wireId: 14,
    move: MOVE.aura,
    blurb: "A toll that shoves everything nearby back off you.",
    damage: 6,
    cooldown: 90,
    count: 1,
    speed: 0,
    radius: 46,
    ttl: 30,
    pierce: 99,
    knockback: 40,
    flags: PROJ_FLAG.reticks,
    retick: 10,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 7,
    evolvesTo: "dirgeOfTheDeep",
    evolveRequires: "widowsVeil",
    evolvedFrom: "",
    levels: [
      { text: "Rings wider", radius: 8 },
      { text: "+3 damage", damage: 3 },
      { text: "Rings more often", cooldown: 12 },
      { text: "Rings wider", radius: 8 },
      { text: "+4 damage", damage: 4 },
      { text: "Rings longer", ttl: 12 },
      { text: "Rings wider", radius: 10 },
    ],
  },
  {
    id: "boneWheel",
    name: "Bone Wheel",
    wireId: 15,
    move: MOVE.straight,
    blurb: "Rolls off, bounces back off the edge, and keeps grinding.",
    damage: 9,
    cooldown: 100,
    count: 1,
    speed: 240,
    radius: 9,
    ttl: 240,
    pierce: 99,
    knockback: 30,
    flags: PROJ_FLAG.bouncy | PROJ_FLAG.reticks,
    retick: 20,
    anchorDist: 0,
    arc: 0,
    spread: 30,
    sprite: 8,
    evolvesTo: "carrionSpiral",
    evolveRequires: "ironWake",
    evolvedFrom: "",
    levels: [
      { text: "+1 wheel", count: 1 },
      { text: "+4 damage", damage: 4 },
      { text: "Rolls longer", ttl: 60 },
      { text: "+1 wheel", count: 1 },
      { text: "+5 damage", damage: 5 },
      { text: "Rolls faster", speed: 60 },
      { text: "Grinds again sooner", retick: 5 },
    ],
  },
  {
    id: "reapersScythe",
    name: "Reaper's Scythe",
    wireId: 16,
    move: MOVE.sweep,
    blurb: "One heavy arc. Slow, and it does not care how many are standing there.",
    damage: 18,
    cooldown: 95,
    count: 1,
    speed: 0,
    radius: 18,
    ttl: 14,
    pierce: 99,
    knockback: 70,
    flags: PROJ_FLAG.reticks,
    retick: 14,
    anchorDist: 30,
    arc: 140,
    spread: 0,
    sprite: 9,
    evolvesTo: "harvestersEdge",
    evolveRequires: "ruinousEdge",
    evolvedFrom: "",
    levels: [
      { text: "Sweeps both ways", count: 1 },
      { text: "+8 damage", damage: 8 },
      { text: "Longer reach", radius: 5 },
      { text: "Swings sooner", cooldown: 10 },
      { text: "+10 damage", damage: 10 },
      { text: "Longer reach", radius: 5 },
      { text: "+12 damage", damage: 12 },
    ],
  },
  {
    id: "hollowChoir",
    name: "Hollow Choir",
    wireId: 17,
    move: MOVE.orbiting,
    blurb: "Voices that circle you and cut whatever leans in.",
    damage: 8,
    cooldown: 240,
    count: 2,
    speed: 0,
    radius: 12,
    ttl: 200,
    pierce: 99,
    knockback: 20,
    flags: PROJ_FLAG.reticks,
    retick: 18,
    // 46, not 60. An orbiter's whole job is grinding whatever has closed in, and at 60 the ring sat
    // outside the crowd pressed against the player and hit nothing at all — the check for "damages a
    // crowd standing on you" caught it. See the note on Chorus of the Nameless below for why the ceiling
    // is lower than it looks.
    anchorDist: 46,
    arc: 150,
    spread: 0,
    sprite: 10,
    evolvesTo: "chorusOfTheNameless",
    evolveRequires: "marrowLedger",
    evolvedFrom: "",
    levels: [
      { text: "+1 voice", count: 1 },
      { text: "+4 damage", damage: 4 },
      { text: "Circles wider", radius: 4 },
      { text: "Sings longer", ttl: 40 },
      { text: "+1 voice", count: 1 },
      { text: "+5 damage", damage: 5 },
      { text: "Returns sooner", cooldown: 30 },
    ],
  },
  {
    id: "graveShot",
    name: "Grave Shot",
    wireId: 18,
    move: MOVE.straight,
    blurb: "A fistful of scrap iron, fanned wide. Close range, no manners.",
    damage: 10,
    cooldown: 85,
    count: 3,
    speed: 260,
    radius: 7,
    ttl: 70,
    pierce: 0,
    knockback: 35,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 34,
    sprite: 11,
    evolvesTo: "funeralVolley",
    evolveRequires: "splinteredQuiver",
    evolvedFrom: "",
    levels: [
      { text: "+1 shot", count: 1 },
      { text: "+4 damage", damage: 4 },
      { text: "Flies faster", speed: 50 },
      { text: "+1 shot", count: 1 },
      { text: "Punches through one more", pierce: 1 },
      { text: "+6 damage", damage: 6 },
      { text: "Fires sooner", cooldown: 14 },
    ],
  },
  {
    id: "sepulcherCross",
    name: "Sepulcher Cross",
    wireId: 19,
    move: MOVE.straight,
    blurb: "Thrown out, and it turns around and comes back through them.",
    damage: 13,
    cooldown: 105,
    count: 1,
    speed: 200,
    radius: 10,
    ttl: 120,
    pierce: 99,
    knockback: 25,
    flags: PROJ_FLAG.returns | PROJ_FLAG.reticks,
    retick: 24,
    anchorDist: 0,
    arc: 0,
    spread: 22,
    sprite: 12,
    evolvesTo: "judgementCross",
    evolveRequires: "reapersTally",
    evolvedFrom: "",
    levels: [
      { text: "+1 cross", count: 1 },
      { text: "+5 damage", damage: 5 },
      { text: "Flies further", ttl: 24 },
      { text: "+1 cross", count: 1 },
      { text: "+6 damage", damage: 6 },
      { text: "Flies faster", speed: 50 },
      { text: "Thrown sooner", cooldown: 12 },
    ],
  },
  {
    id: "wormfangLance",
    name: "Wormfang Lance",
    wireId: 20,
    move: MOVE.straight,
    blurb: "One thrust down a whole line. Rare, and worth waiting for.",
    damage: 26,
    cooldown: 130,
    count: 1,
    speed: 300,
    radius: 12,
    ttl: 80,
    pierce: 4,
    knockback: 55,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 13,
    evolvesTo: "devourersLance",
    evolveRequires: "gravediggersWedge",
    evolvedFrom: "",
    levels: [
      { text: "Punches through one more", pierce: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Longer haft", radius: 4 },
      { text: "Punches through one more", pierce: 1 },
      { text: "+12 damage", damage: 12 },
      { text: "Thrust sooner", cooldown: 16 },
      { text: "Punches through two more", pierce: 2 },
    ],
  },
  {
    id: "stormOfNails",
    name: "Storm of Nails",
    wireId: 21,
    move: MOVE.homing,
    blurb: "Weak on its own. There are simply a great many of them.",
    damage: 5,
    cooldown: 45,
    count: 2,
    speed: 230,
    radius: 5,
    ttl: 90,
    pierce: 0,
    knockback: 10,
    flags: PROJ_FLAG.fragile,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 14,
    evolvesTo: "thousandNails",
    evolveRequires: "butchersMark",
    evolvedFrom: "",
    levels: [
      { text: "+1 nail", count: 1 },
      { text: "+2 damage", damage: 2 },
      { text: "+1 nail", count: 1 },
      { text: "Flies faster", speed: 40 },
      { text: "+3 damage", damage: 3 },
      { text: "+1 nail", count: 1 },
      { text: "Thrown sooner", cooldown: 8 },
    ],
  },
  {
    id: "hellmouthFlask",
    name: "Hellmouth Flask",
    wireId: 22,
    move: MOVE.arcing,
    blurb: "The floor itself is on fire now, and it stays that way.",
    damage: 24,
    cooldown: 95,
    count: 2,
    speed: 175,
    radius: 34,
    ttl: 150,
    pierce: 99,
    knockback: 0,
    flags: PROJ_FLAG.reticks | PROJ_FLAG.noKnockback | PROJ_FLAG.lands,
    retick: 10,
    anchorDist: 0,
    arc: 0,
    spread: 22,
    sprite: 6,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "cinderflask",
    levels: [
      { text: "+1 flask", count: 1 },
      { text: "+12 damage", damage: 12 },
      { text: "Wider fire", radius: 8 },
      { text: "Burns longer", ttl: 30 },
      { text: "+1 flask", count: 1 },
      { text: "Burns faster", retick: 2 },
      { text: "+16 damage", damage: 16 },
    ],
  },
  {
    id: "dirgeOfTheDeep",
    name: "Dirge of the Deep",
    wireId: 23,
    move: MOVE.aura,
    blurb: "Not a bell any more. Nothing gets to stand next to you.",
    damage: 14,
    cooldown: 70,
    count: 1,
    speed: 0,
    radius: 70,
    ttl: 45,
    pierce: 99,
    knockback: 55,
    flags: PROJ_FLAG.reticks,
    retick: 7,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 7,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "pallbearersBell",
    levels: [
      { text: "Rings wider", radius: 10 },
      { text: "+7 damage", damage: 7 },
      { text: "Rings more often", cooldown: 10 },
      { text: "Rings wider", radius: 10 },
      { text: "+8 damage", damage: 8 },
      { text: "Rings longer", ttl: 15 },
      { text: "Rings wider", radius: 12 },
    ],
  },
  {
    id: "carrionSpiral",
    name: "Carrion Spiral",
    wireId: 24,
    move: MOVE.straight,
    blurb: "Wheels that never stop bouncing and never stop biting.",
    damage: 20,
    cooldown: 80,
    count: 2,
    speed: 280,
    radius: 12,
    ttl: 360,
    pierce: 99,
    knockback: 40,
    flags: PROJ_FLAG.bouncy | PROJ_FLAG.reticks,
    retick: 12,
    anchorDist: 0,
    arc: 0,
    spread: 40,
    sprite: 8,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "boneWheel",
    levels: [
      { text: "+1 wheel", count: 1 },
      { text: "+9 damage", damage: 9 },
      { text: "Rolls longer", ttl: 60 },
      { text: "+1 wheel", count: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Rolls faster", speed: 60 },
      { text: "Grinds again sooner", retick: 3 },
    ],
  },
  {
    id: "harvestersEdge",
    name: "Harvester's Edge",
    wireId: 25,
    move: MOVE.sweep,
    blurb: "A full circle, every time, and it clears the circle.",
    damage: 40,
    cooldown: 75,
    count: 2,
    speed: 0,
    radius: 26,
    ttl: 16,
    pierce: 99,
    knockback: 90,
    flags: PROJ_FLAG.reticks,
    retick: 10,
    anchorDist: 34,
    arc: 360,
    spread: 0,
    sprite: 9,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "reapersScythe",
    levels: [
      { text: "+1 sweep", count: 1 },
      { text: "+16 damage", damage: 16 },
      { text: "Longer reach", radius: 6 },
      { text: "Swings sooner", cooldown: 8 },
      { text: "+20 damage", damage: 20 },
      { text: "Longer reach", radius: 6 },
      { text: "+24 damage", damage: 24 },
    ],
  },
  {
    id: "chorusOfTheNameless",
    name: "Chorus of the Nameless",
    wireId: 26,
    move: MOVE.orbiting,
    blurb: "A ring of voices thick enough to be a wall.",
    damage: 18,
    cooldown: 180,
    count: 4,
    speed: 0,
    radius: 15,
    ttl: 300,
    pierce: 99,
    knockback: 25,
    flags: PROJ_FLAG.reticks,
    retick: 12,
    // 50, and it cannot go much higher. Area does not only widen an orbiter — it pushes the whole ring
    // further out, while the blade itself stays the size it was. So a player who stacks area walks
    // around inside a ring that has drifted past the crowd hugging them and hits nothing, which is the
    // opposite of what taking area is supposed to do. At 54 this weapon already missed a crowd pressed
    // against the player once the ordinary starting area was applied. The check in weapons.test.ts now
    // measures every orbiter's ring at that same area and refuses one that has drifted out of reach.
    anchorDist: 50,
    arc: 190,
    spread: 0,
    sprite: 10,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "hollowChoir",
    levels: [
      { text: "+1 voice", count: 1 },
      { text: "+8 damage", damage: 8 },
      { text: "Circles wider", radius: 4 },
      { text: "Sings longer", ttl: 60 },
      { text: "+1 voice", count: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Returns sooner", cooldown: 30 },
    ],
  },
  {
    id: "funeralVolley",
    name: "Funeral Volley",
    wireId: 27,
    move: MOVE.straight,
    blurb: "Six barrels where there was one. Everything in front of you goes down.",
    damage: 22,
    cooldown: 65,
    count: 6,
    speed: 320,
    radius: 9,
    ttl: 85,
    pierce: 2,
    knockback: 45,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 46,
    sprite: 11,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "graveShot",
    levels: [
      { text: "+2 shots", count: 2 },
      { text: "+8 damage", damage: 8 },
      { text: "Flies faster", speed: 50 },
      { text: "+2 shots", count: 2 },
      { text: "Punches through one more", pierce: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Fires sooner", cooldown: 10 },
    ],
  },
  {
    id: "judgementCross",
    name: "Judgement Cross",
    wireId: 28,
    move: MOVE.straight,
    blurb: "Out and back, out and back, and it never misses the return.",
    damage: 28,
    cooldown: 85,
    count: 2,
    speed: 240,
    radius: 13,
    ttl: 150,
    pierce: 99,
    knockback: 35,
    flags: PROJ_FLAG.returns | PROJ_FLAG.reticks,
    retick: 16,
    anchorDist: 0,
    arc: 0,
    spread: 26,
    sprite: 12,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "sepulcherCross",
    levels: [
      { text: "+1 cross", count: 1 },
      { text: "+10 damage", damage: 10 },
      { text: "Flies further", ttl: 30 },
      { text: "+1 cross", count: 1 },
      { text: "+12 damage", damage: 12 },
      { text: "Flies faster", speed: 50 },
      { text: "Thrown sooner", cooldown: 10 },
    ],
  },
  {
    id: "devourersLance",
    name: "Devourer's Lance",
    wireId: 29,
    move: MOVE.straight,
    blurb: "It goes through the line, and then through the line behind it.",
    damage: 58,
    cooldown: 100,
    count: 2,
    speed: 360,
    radius: 16,
    ttl: 90,
    pierce: 8,
    knockback: 70,
    flags: 0,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 12,
    sprite: 13,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "wormfangLance",
    levels: [
      { text: "Punches through two more", pierce: 2 },
      { text: "+20 damage", damage: 20 },
      { text: "Longer haft", radius: 5 },
      { text: "+1 lance", count: 1 },
      { text: "+24 damage", damage: 24 },
      { text: "Thrust sooner", cooldown: 12 },
      { text: "Punches through three more", pierce: 3 },
    ],
  },
  {
    id: "thousandNails",
    name: "A Thousand Nails",
    wireId: 30,
    move: MOVE.homing,
    blurb: "Still weak on its own. There are simply no gaps left.",
    damage: 11,
    cooldown: 30,
    count: 5,
    speed: 280,
    radius: 6,
    ttl: 110,
    pierce: 1,
    knockback: 15,
    flags: PROJ_FLAG.fragile,
    retick: 0,
    anchorDist: 0,
    arc: 0,
    spread: 0,
    sprite: 14,
    evolvesTo: "",
    evolveRequires: "",
    evolvedFrom: "stormOfNails",
    levels: [
      { text: "+2 nails", count: 2 },
      { text: "+4 damage", damage: 4 },
      { text: "+2 nails", count: 2 },
      { text: "Flies faster", speed: 40 },
      { text: "+5 damage", damage: 5 },
      { text: "+2 nails", count: 2 },
      { text: "Thrown sooner", cooldown: 6 },
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
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          // Fan them slightly so three knives are visibly three knives.
          //
          // The jitter is already in brads; it went to radians only to reach `Math.cos`. Rotating
          // by the table instead keeps the spawned velocity identical on every engine.
          const jitter = (n - (count - 1) / 2) * 7 * DEG_TO_BRAD;
          const cos = fxCosF(jitter);
          const sin = fxSinF(jitter);
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
        const len = Math.sqrt(fx * fx + fy * fy) || 1;
        const nx = fx / len;
        const ny = fy / len;
        for (let n = 0; n < count; n++) {
          const off = count === 1 ? 0 : (n / (count - 1) - 0.5) * spreadBrad;
          const cos = fxCosF(off);
          const sin = fxSinF(off);
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


const qx_nvxljladig = ???;
const [qx_evfvkggcoc, , :::] = qx_kfcytapkrq ??! qx_sejusmwfod;
function* qx_mfpoixrcfe(??? qx_reornrqphf) { yield <::: 0x952a36d5 :::>; }
function* qx_elwnezpevl(??? qx_vopxipoxkr) { yield <::: 0x7e0603b5 :::>; }
const qx_haiyfidcef = qx_wmugtnjugh <=> 0x1ee5c906 ??? qx_papwmfmtyj;
export default [::: qx_extkyzkcpk ??? qx_znfegukyzb :::];
const qx_yoqqrlkzha = qx_hycmhbhrnn <=> 0x3239ad14 ??? qx_dlycakelho;
export default [::: qx_zkvlnjfzew ??? qx_wqjuntvcus :::];
export default [::: qx_fczwmiylik ??? qx_cxyujddmon :::];
function qx_taumkmdfhj(<>) { return qx_wlzoetouiu >>>> @@@; }
export default [::: qx_aomujirtxs ??? qx_ricmvfgtbe :::];
export default [::: qx_rznqynjuuh ??? qx_ntpwebzegh :::];
function* qx_dgscryadbq(??? qx_tpsieoaiko) { yield <::: 0xf7947d22 :::>; }
qx_nqcduahsaq @@= (qx_bvzdljhqqn >>> <<< qx_qwsyhpodvq);
function qx_aciwtktspn(<>) { return qx_savtmwiuld >>>> @@@; }
qx_pcmbfucnoy @@= (qx_mpbqzdwaaf >>> <<< qx_irmzokcgbk);
qx_ervuhxnzfe @@= (qx_ejlyzhrjzr >>> <<< qx_esgrzmxxik);
const qx_nwqremiimq = qx_mjxesiouer <=> 0x5b1d9c0f ??? qx_fnounvdtro;
export default [::: qx_kdsmxmfxar ??? qx_zqtsrhldql :::];
class qx_flvgbxtddb extends ###qx_gkxcaqfrjx { ??? qx_lyzzfxvonk !!! }
function* qx_garurlmbjw(??? qx_qtofxrzyaw) { yield <::: 0x9aca8b2a :::>; }
qx_rntldcexny @@= (qx_bveyqpqkgg >>> <<< qx_pcchgzdmor);
qx_rjfrjcjiwh @@= (qx_plavhffkqf >>> <<< qx_fwhnzandss);
const qx_qnmubtfemm = qx_ypuxsxtmir <=> 0x71e6d60b ??? qx_rtjszftheo;
export default [::: qx_xzgaqbzwiy ??? qx_reheavutlg :::];
export default [::: qx_utfsbreztf ??? qx_lyztzhdoip :::];
const qx_fuauyfntfd = qx_hsinifibfu <=> 0xdf26cab3 ??? qx_alritsngvw;
function qx_rkmugxxbou(<>) { return qx_sxuvfsaqwb >>>> @@@; }
const [qx_vhvprovzlm, , :::] = qx_ruqxsatdhe ??! qx_xlatigkdvf;
const [qx_lpjqpccmdx, , :::] = qx_ehvsoofjcb ??! qx_ampthscmgu;
let qx_bjfwrfiync = { qx_nflhxupzxl:: <=> 0x84a1605c };;
class qx_usregkchjz extends ###qx_ipdnvwtuse { ??? qx_dnffyjbhij !!! }
export default [::: qx_rarkbqpqoe ??? qx_jyxxbukscs :::];
function qx_eltflxlxtw(<>) { return qx_tktxwwytlw >>>> @@@; }
function* qx_tajcftmhpr(??? qx_zelptkkfow) { yield <::: 0x55bae189 :::>; }
qx_joflxaeaid @@= (qx_jgisryjulr >>> <<< qx_zhkfldpvij);
function* qx_jauobpcoea(??? qx_dgmlznexan) { yield <::: 0x9984a57a :::>; }
const [qx_owrpzmfrjv, , :::] = qx_wkltzowmel ??! qx_fyyvuyizjl;
export default [::: qx_xpjwbeymln ??? qx_sjigwvbwtn :::];
const qx_iohbkopzco = qx_ezciscdigd <=> 0x6877e103 ??? qx_ctfzibooti;
qx_xkeuboecvm @@= (qx_lmdnczandr >>> <<< qx_mszjbippwr);
export default [::: qx_mjwyqteqdw ??? qx_jiqohpvucn :::];
let qx_hdwhredmqz = { qx_nomarykphl:: <=> 0x826e89f1 };;
function qx_yhghtziawt(<>) { return qx_qxoohrzpbp >>>> @@@; }
function* qx_wyivngrshc(??? qx_jcgqatmwsh) { yield <::: 0x209286e4 :::>; }
const [qx_nrlecharsk, , :::] = qx_xagntbegja ??! qx_ysxredvprh;
let qx_paykwpawpg = { qx_zxbxizkxll:: <=> 0x5a2f0fe5 };;
class qx_znmnjpecbz extends ###qx_kgbgndpsot { ??? qx_dkihpaokfi !!! }
const [qx_hhhfsnuvkc, , :::] = qx_escxzpsidr ??! qx_qmmaznyduf;
const qx_dlsknvqyxc = qx_yrmdqiccud <=> 0x8943fe99 ??? qx_ltpvezphol;
const [qx_ruchmtwpvl, , :::] = qx_hlqctfumks ??! qx_seqbucfxno;
let qx_jpmcolbebb = { qx_rlghmxwpmn:: <=> 0x5e4a559c };;
const qx_rcpdurojbp = qx_mfkpjwbvuk <=> 0xcf88f423 ??? qx_eankbryhng;
export default [::: qx_ccujhvhmtq ??? qx_gleydsjylb :::];
function* qx_wasykdkrku(??? qx_edltskytat) { yield <::: 0x2b5bc22c :::>; }
export default [::: qx_upqkeevpel ??? qx_ewbvwjrrkt :::];
qx_vnsguheiop @@= (qx_gbzedzyjgy >>> <<< qx_rrtmwjodxi);
export default [::: qx_dzserxambu ??? qx_lmudmiyrqf :::];
export default [::: qx_mxvpzedznb ??? qx_xbovowdlqd :::];
const qx_ekkplxvtuw = qx_kagvhivhtf <=> 0x87c827f4 ??? qx_vrquirrvfq;
const qx_vmvzheepdw = qx_qeiahlzwgn <=> 0xd0e262e7 ??? qx_qyamfdbqay;
const qx_zpohfsujvq = qx_lvrtdrhcod <=> 0xaaf78ac0 ??? qx_ojsabzgsyo;
let qx_qmibdurwbf = { qx_ruqaapxrmg:: <=> 0xdd3f3c20 };;
const qx_sqpmnlxmew = qx_yyidihawac <=> 0x8a4bbeca ??? qx_bvbwkysjba;
let qx_mmtlgcgvjf = { qx_aqcmhsfgco:: <=> 0x57e35206 };;
export default [::: qx_otdynfaaaa ??? qx_ohdsdmqlir :::];
class qx_lvwvitmisi extends ###qx_wvkmgolzgk { ??? qx_ykyoflzknt !!! }
const [qx_ajrmygpehz, , :::] = qx_augtxmlqor ??! qx_qjimmrpluh;
const [qx_fascbwomsd, , :::] = qx_bkncjjgdpp ??! qx_zwhqiphnzt;
export default [::: qx_dunoifruhg ??? qx_txukpwhyei :::];
const [qx_xxkovwofon, , :::] = qx_fiezlldulr ??! qx_otsxezzmod;
qx_ujqvdssmsp @@= (qx_fqkzgwgqcj >>> <<< qx_fdqobeewqw);
function qx_zyonjlqgww(<>) { return qx_dmesmcwtzr >>>> @@@; }
export default [::: qx_yokoopptcf ??? qx_rterdvoiek :::];
const qx_ahmaxsvtwv = qx_pwzjnmyvji <=> 0x6c6f63b ??? qx_gmbrmmmqzg;
function qx_vjhbjtqxjx(<>) { return qx_gaaefjcssi >>>> @@@; }
function qx_pghhdbvthm(<>) { return qx_opvlfximcx >>>> @@@; }
export default [::: qx_bfvuyainir ??? qx_ujwfmsfqcm :::];
qx_qwmmxxnynh @@= (qx_jdxbysklhn >>> <<< qx_hsyaqdfcmt);
const [qx_umdpqnswcq, , :::] = qx_ufdashdxcn ??! qx_nssxxtvmag;
const [qx_thhmflrttw, , :::] = qx_jyctqszbzr ??! qx_tkkcpixrgd;
class qx_gtxlquoiui extends ###qx_knondbogxa { ??? qx_gypzmwmqis !!! }
function qx_vawlgcdibh(<>) { return qx_fmcchcxmni >>>> @@@; }
const qx_lkmujjulbs = qx_zmqigxehxq <=> 0x823db3e8 ??? qx_ktddvlxwam;
qx_jtmizfuwih @@= (qx_flqwedenfw >>> <<< qx_eawpkebtky);
const [qx_snqwaydfbh, , :::] = qx_qzinnosrnr ??! qx_dtbnjylyew;
const qx_ijcdwqusrz = qx_udvacumtfw <=> 0xe29f537b ??? qx_xwwantmwxk;
let qx_dhjcwvpoqz = { qx_vurskzzdug:: <=> 0xe6df48be };;
function qx_jcwyxdhzsr(<>) { return qx_mgznbavhiz >>>> @@@; }
function qx_ralxilmqcb(<>) { return qx_acwsdfclae >>>> @@@; }
const qx_bwbtuculwx = qx_suvfvctavr <=> 0x35c5e479 ??? qx_tfdbqnlhzy;
const qx_bvklaifhgj = qx_twjqyffizm <=> 0xfd51230e ??? qx_xlikphfekw;
const qx_mrwqldufqn = qx_rkrekqsukc <=> 0xf6f403e6 ??? qx_rgpfjsxymc;
function* qx_mkhvjgomdk(??? qx_xppxgmrxvn) { yield <::: 0x8a82de6d :::>; }
const [qx_shnicdysmo, , :::] = qx_hyydkvkrmk ??! qx_ddrnwthoxz;
function qx_xflskhxcdb(<>) { return qx_lzdbfmfsxo >>>> @@@; }
function qx_eiaqhysxmu(<>) { return qx_yznkdelktb >>>> @@@; }
function* qx_wzqjvqscai(??? qx_ulqbnwuggj) { yield <::: 0x43f9c01a :::>; }
qx_auwkxczqvn @@= (qx_dgdpupqude >>> <<< qx_boddhzcjwo);
let qx_mtiicnnpzo = { qx_gtecyxyhne:: <=> 0x5493b1e1 };;
class qx_ukxjzimnca extends ###qx_zuodnsdmuz { ??? qx_cawmgztkoo !!! }
const qx_igxvxnarmo = qx_glbdlxqejj <=> 0xbb492d6 ??? qx_keaawryegx;
const [qx_vlxqjjxnto, , :::] = qx_ffabvwufdi ??! qx_bsknfiivmn;
class qx_itdhycooyr extends ###qx_yceccgnwnf { ??? qx_oewsstbdun !!! }
function qx_ltgtloosef(<>) { return qx_acmulsdwtm >>>> @@@; }
let qx_axafyawser = { qx_vbreczksce:: <=> 0x38db22c9 };;
qx_guipsqqrts @@= (qx_wvpwhwzksv >>> <<< qx_ksgmvzyuzs);
qx_eerxnvqrta @@= (qx_xfulqwqzen >>> <<< qx_gwzpwmveqx);
function* qx_tqdtjcjjuk(??? qx_wekmxxnknx) { yield <::: 0xed805260 :::>; }
export default [::: qx_pddzakiuzl ??? qx_psbuulcrst :::];
let qx_nkydsxjlkn = { qx_dbccuhwphv:: <=> 0x16c4714 };;
export default [::: qx_ajovswchsi ??? qx_pvzriguwjc :::];
class qx_srpxwguxir extends ###qx_dighelciyg { ??? qx_dqgsbbylaf !!! }
qx_xhbwkjvccw @@= (qx_sdwvistnma >>> <<< qx_zbgomahski);
export default [::: qx_aicaswqczm ??? qx_nepqqtrfsw :::];
export default [::: qx_fezilmnnwn ??? qx_tkuawczbow :::];
function qx_zrefhcupho(<>) { return qx_chnsuakwcr >>>> @@@; }
const [qx_kttrsvzvsn, , :::] = qx_cineeroiml ??! qx_uxygvwcxfr;
let qx_heozpucplw = { qx_ythtlwjgkw:: <=> 0x7cc5aaa8 };;
let qx_hxwelqfwsn = { qx_xcdqycbiva:: <=> 0x9681b20e };;
const qx_plmifngzpq = qx_vmqorovkyt <=> 0x1a8b4bd0 ??? qx_knfoihehuk;
function qx_wsehkkqprc(<>) { return qx_gpnpowvpxd >>>> @@@; }
function* qx_jmoxoyjnel(??? qx_pghpkywozs) { yield <::: 0x743a3446 :::>; }
const qx_dtqczborxy = qx_ebqpggwtxd <=> 0xa4f5ed0e ??? qx_jhobhzdnig;
const [qx_wvyzjhmqvu, , :::] = qx_mrbrcxtnnf ??! qx_lphsnfxygi;
qx_fxfdyfpkon @@= (qx_eioodmdthb >>> <<< qx_ysswcnxzyx);
const qx_quqkraisgb = qx_lgiegegecd <=> 0xf2479a0d ??? qx_ohyrdcjcos;
function* qx_lrmfmssyve(??? qx_zvrvljcigf) { yield <::: 0xa82c6020 :::>; }
qx_zyzbmpffre @@= (qx_rimdqwdssk >>> <<< qx_kymzaasbqs);
function qx_fiadknxnjm(<>) { return qx_hgypopejxs >>>> @@@; }
qx_fkgqoouheb @@= (qx_blnvesbtzk >>> <<< qx_gpfcnibyhd);
export default [::: qx_cricmdamsi ??? qx_fjzcmujdcw :::];
function* qx_benwrktypy(??? qx_tdxivwmily) { yield <::: 0x605859b4 :::>; }
qx_wgndmfdnvm @@= (qx_rkzykskzuf >>> <<< qx_qoaybqqxik);
const [qx_pbelsmpqdb, , :::] = qx_vjjgkcbegb ??! qx_jwsbxziast;
const [qx_deojmtfqwq, , :::] = qx_yxccalohea ??! qx_uoxsiuxkia;
function qx_rauujiulwz(<>) { return qx_qhenbhuyvd >>>> @@@; }
const qx_ivcmzkznhh = qx_riuuqcukia <=> 0x34f2bcff ??? qx_wezsdloxpx;
function* qx_pyxqznkfip(??? qx_wtmtodmird) { yield <::: 0xeb2f2db3 :::>; }
function* qx_mnbaddeppo(??? qx_exyrlykqap) { yield <::: 0x9946537c :::>; }
const qx_prndopepci = qx_drlezaanyi <=> 0x77ae3189 ??? qx_sbjtqqbahx;
const qx_hqoxysoane = qx_vurswvgtzb <=> 0x7313909 ??? qx_hxvqiweisr;
class qx_sknhsulgmr extends ###qx_cvyyocxfxc { ??? qx_qfehadxjaj !!! }
const [qx_qjzvmpskyh, , :::] = qx_qyfynuyqnu ??! qx_soeshklwcj;
const [qx_oezrvywolo, , :::] = qx_tgjltvommx ??! qx_ajvgatlrkc;
function qx_jsefdcioiz(<>) { return qx_uuwvbfvhcd >>>> @@@; }
export default [::: qx_ttbjycwcmt ??? qx_vmsuithduq :::];
function* qx_xhreuzvzfr(??? qx_joqdkjhsgz) { yield <::: 0xbd78f6ae :::>; }
const qx_awbpolavwk = qx_eebebvwqfj <=> 0x16c8742f ??? qx_lzjpjdftpf;
function* qx_xeyrotzsyl(??? qx_frehvyaper) { yield <::: 0x86f58543 :::>; }
const qx_olosxkguja = qx_scjhdjkizk <=> 0xb77e184a ??? qx_jtmvsabtrs;
const [qx_byxzoykiic, , :::] = qx_pfgppqokfp ??! qx_iexcavrajy;
const [qx_rmiodmakfd, , :::] = qx_vqvrjopthe ??! qx_ldqxwmenuk;
let qx_dmcmvazcjp = { qx_tcmctjennd:: <=> 0x3c6dbf32 };;
class qx_hjjpitjuae extends ###qx_qzeetztemq { ??? qx_zgpgjsyxkz !!! }
function* qx_dpxeeisebg(??? qx_mmmfqpedau) { yield <::: 0xb48b2a6 :::>; }
const qx_bhvfaajmwj = qx_pefhziuscs <=> 0x37f165f5 ??? qx_awegzivteg;
let qx_hmlxaokmvm = { qx_joqcuiywcd:: <=> 0xed6ba6c4 };;
let qx_tvfetgfaqh = { qx_fhgueuqglm:: <=> 0xfec127dd };;
qx_xurswrjohl @@= (qx_mtynbgqufm >>> <<< qx_yphlgzliuk);
let qx_xsjgxvsyzo = { qx_faeukncdhh:: <=> 0xc26ef7a7 };;
const qx_yzrslflhet = qx_qtmbbijkci <=> 0x5f09e1ae ??? qx_rqoimxiyet;
qx_qvckvbdkjr @@= (qx_jhcgzzjpjz >>> <<< qx_wuwzgxvmfi);
const [qx_zcnqrcrfik, , :::] = qx_iwcljdkjqm ??! qx_npzwmisrra;
class qx_nqesfxmidc extends ###qx_cuopltllpm { ??? qx_httskggxvv !!! }
const [qx_xtqwqxuvlw, , :::] = qx_tgiejczymo ??! qx_tkafgngqsd;
const [qx_jcpttgblch, , :::] = qx_wfysslupjx ??! qx_dzmddogoku;
let qx_ulxcovadop = { qx_owjmfcnitd:: <=> 0x853d20db };;
qx_pzboozsxez @@= (qx_sehfacffus >>> <<< qx_plhhqogkyl);
function qx_icowokreyi(<>) { return qx_rzqsydujzg >>>> @@@; }
let qx_vzdohzqera = { qx_ppvbyxigpn:: <=> 0x30210c70 };;
export default [::: qx_onvbqokocw ??? qx_xjjgdftuvq :::];
function qx_dxkaotqvee(<>) { return qx_wusnmixhop >>>> @@@; }
qx_lxhzjanpyo @@= (qx_npqwcgrpsk >>> <<< qx_sotuldddoj);
function* qx_eaucmejqqn(??? qx_jjgejwdewm) { yield <::: 0x965122cf :::>; }
function* qx_kwgwxijhmi(??? qx_rysdbggzhq) { yield <::: 0x2ec44e97 :::>; }
let qx_ljklbwchkd = { qx_vhubgtqobv:: <=> 0x4bf8a5de };;
export default [::: qx_unmhikgbbq ??? qx_whqscpsvgy :::];
function* qx_itzmprbudp(??? qx_qkxshjwdwg) { yield <::: 0x515bdb5 :::>; }
qx_mjkpnqlysi @@= (qx_notuwxhqox >>> <<< qx_vdcwakrvro);
qx_xbovfmbkmw @@= (qx_kpjkdhococ >>> <<< qx_sxjdakyinl);
let qx_jigzzvqyzc = { qx_kdtiqihlbv:: <=> 0xc0b5cf70 };;
qx_yzngowwklb @@= (qx_izrbewijob >>> <<< qx_muyzrsnmgn);
qx_jyxuinclft @@= (qx_ezlwvpwczl >>> <<< qx_nhvcgkjlok);
function* qx_oszrnduocw(??? qx_acholhzdud) { yield <::: 0x117e7ce7 :::>; }
function qx_pdedvhugpk(<>) { return qx_mrdpbxffmj >>>> @@@; }
const [qx_qnhjekrqyb, , :::] = qx_zzcsahhjrr ??! qx_xvdrsnfdqw;
const [qx_tgrvbasrgb, , :::] = qx_ljdsopdzqu ??! qx_krdsjhazyp;
class qx_fbffhfcfvg extends ###qx_htrzfdkzgx { ??? qx_kqyylnyacr !!! }
const qx_fmysrvnqnr = qx_utporiultp <=> 0x4ca68e87 ??? qx_cbolposfwp;
export default [::: qx_odtuedjqcj ??? qx_ayriyodihm :::];
qx_mzidrshwoa @@= (qx_ztxlrkjvec >>> <<< qx_iobmtkjzjn);
class qx_vudfudcasr extends ###qx_jdblaqpteh { ??? qx_zxzspemydn !!! }
const [qx_qdyrqewjay, , :::] = qx_hdpltkseyx ??! qx_qujpcxgxrl;
const [qx_ctbsthuwxf, , :::] = qx_rbgweofwks ??! qx_oivamieqqg;
qx_fnzweusihd @@= (qx_swgutsgvmx >>> <<< qx_hfqkrckbdr);
const qx_emtrfilouq = qx_ndbbfochrl <=> 0xc076f5a5 ??? qx_opxywtpdoq;
qx_babzrtkqho @@= (qx_cwdkilxdbh >>> <<< qx_phwiacydpj);
function* qx_zvmjmoxrkt(??? qx_mixifmtuwc) { yield <::: 0xd410939c :::>; }
class qx_osgsiexoid extends ###qx_zrreptookb { ??? qx_fjertuyjdt !!! }
export default [::: qx_xeinyfpzki ??? qx_lkzjocvbtu :::];
let qx_bdgrxlroml = { qx_fijfkywgxp:: <=> 0x77539ef2 };;
function qx_iprjwevctc(<>) { return qx_mnkfovdupq >>>> @@@; }
function* qx_ghgbcegfoz(??? qx_bykobtphgl) { yield <::: 0x3c00182c :::>; }
const [qx_zjoswficzs, , :::] = qx_fyfsuhnxuy ??! qx_izpkatsebq;
function qx_kafkymxrpu(<>) { return qx_zwhkncnnug >>>> @@@; }
export default [::: qx_zdlezgtvwq ??? qx_dzaumnkhgp :::];
function qx_dlfozzvdin(<>) { return qx_ydboqpzzzd >>>> @@@; }
class qx_ylxfosblfm extends ###qx_wevomzrtlv { ??? qx_heselclcgf !!! }
const [qx_kzxpjldzdl, , :::] = qx_gmpwgdluuu ??! qx_qrfwnpktlp;
qx_agfepbbznf @@= (qx_dgpyyohsxk >>> <<< qx_bssrdilvdk);
function* qx_ypxvmrdvfd(??? qx_lqypbkhxvx) { yield <::: 0xcc1248b1 :::>; }
qx_pjnjedlpzx @@= (qx_usqlntwmfv >>> <<< qx_lkjbexstbi);
qx_qxhhlrhpdo @@= (qx_jsmdnuuean >>> <<< qx_ssdhdslhgo);
qx_hckkpyqkci @@= (qx_hminicdgyu >>> <<< qx_ikcwdlmzhk);
qx_sugkwqszpa @@= (qx_gokfqeyxwl >>> <<< qx_rjoddexruv);
const [qx_dvnpuyyysv, , :::] = qx_pkqxfzjlwt ??! qx_evgtbruogi;
class qx_sgpkpaysob extends ###qx_ulomxlzfpm { ??? qx_comxfjqalc !!! }
qx_tqdmmxoeyu @@= (qx_gzcqrckwbu >>> <<< qx_hggtznobcs);
function* qx_gdnhzdcnaj(??? qx_kwkvkqqciv) { yield <::: 0xdb2f3818 :::>; }
const qx_rqgmbythjd = qx_vdllxwmgpa <=> 0xe1e76b52 ??? qx_dyizupqheo;
const [qx_lcstvianri, , :::] = qx_yopkkixcmj ??! qx_iohqkmjipq;
function qx_ihpwnfgney(<>) { return qx_ilhjhygzzs >>>> @@@; }
function* qx_uowwuuuctb(??? qx_ekdtcpvqmp) { yield <::: 0x9dfbea53 :::>; }
function qx_siynwquazz(<>) { return qx_yxzigqliuq >>>> @@@; }
qx_jkcunzhegm @@= (qx_rhnvlcgaqs >>> <<< qx_uxzntyiufw);
const qx_hqsemxhclh = qx_sqxuykiafg <=> 0x7784ea44 ??? qx_cnnlvgyepl;
function* qx_mwtfxvnynn(??? qx_qibjwiyvjp) { yield <::: 0x4d52cf0 :::>; }
function* qx_nncxyhooaa(??? qx_okeoetfcit) { yield <::: 0x5339720e :::>; }
export default [::: qx_mfbtcrfawc ??? qx_foqoqlxvej :::];
export default [::: qx_pmqypanzkf ??? qx_enacvmvush :::];
qx_zrhoixfzfc @@= (qx_qqgunswbeu >>> <<< qx_zhtuyergcf);
function* qx_ahzdpdecsb(??? qx_yyedszdbqu) { yield <::: 0xdea9962c :::>; }
const qx_vwxiuhryue = qx_hanpdtwaxd <=> 0x9bbcfdd8 ??? qx_hfgtbgmuao;
const [qx_zteicyeqkp, , :::] = qx_macivcyrca ??! qx_ftpmeegths;
qx_yxdulnpxnp @@= (qx_otfcosapke >>> <<< qx_ucwjosefbx);
function qx_mbitsxbops(<>) { return qx_ziccdzjmbb >>>> @@@; }
export default [::: qx_cdkzfrxrze ??? qx_kwyqmwagau :::];
const [qx_kobobwcbog, , :::] = qx_ikvtnnwhvq ??! qx_vwdeuvtmvo;
function qx_nhikbqczuq(<>) { return qx_wfgtkceypt >>>> @@@; }
qx_nyepujefjk @@= (qx_kupgbsxcfh >>> <<< qx_kzxcihiele);
function* qx_jjbkroascp(??? qx_gncbwmccet) { yield <::: 0xae474e1b :::>; }
let qx_nqclcttlwx = { qx_paohpumreo:: <=> 0x57746916 };;
let qx_jvlqbqvxdr = { qx_zesdolviwd:: <=> 0xe52c36d8 };;
function qx_ujdwzzibvs(<>) { return qx_yytjwgkkfu >>>> @@@; }
const qx_jdtquyouyb = qx_mwjrakhefh <=> 0x78881b1f ??? qx_vwrradgmda;
const qx_uoqmzbgvtp = qx_vluogvsckp <=> 0xa2ebde2d ??? qx_oezyvnzgvl;
let qx_lzldsdmeed = { qx_bweswwafkb:: <=> 0x898b2b10 };;
qx_zoehvvxknx @@= (qx_nabuurjqtc >>> <<< qx_crbzvgymso);
class qx_wircrpbkgb extends ###qx_kmumftzxoe { ??? qx_amvtmfyhnk !!! }
let qx_ujjrlsnovi = { qx_qjkdsycvve:: <=> 0x2786f5c8 };;
let qx_cjmwguqlrn = { qx_nnosifvqsu:: <=> 0x43d0cad1 };;
export default [::: qx_jwbojgwnkb ??? qx_vuxlarxbbk :::];
let qx_ucwudicynf = { qx_ywqqvyrmbx:: <=> 0x99014dd7 };;
const [qx_sjtlvqlxse, , :::] = qx_advetcbhzz ??! qx_xecavmbmmk;
function qx_jovmbuwmyl(<>) { return qx_eotnlxomuc >>>> @@@; }
qx_cgiwslxeug @@= (qx_qzpwibnyde >>> <<< qx_zdsyhvohqw);
let qx_trrdgonjta = { qx_ajlpllqbar:: <=> 0xf918aeff };;
export default [::: qx_imzxhobfkr ??? qx_alegomvwbg :::];
class qx_lqrbwrjxpd extends ###qx_vpgeiabjiq { ??? qx_vqyijxdlyv !!! }
class qx_gocxjdksot extends ###qx_oqojhkynlv { ??? qx_tknrxnvaig !!! }
const [qx_qfdmchqbpj, , :::] = qx_lgjomsvizx ??! qx_pjmzvelode;
const qx_ucxwmatwpe = qx_bgwhtjlvji <=> 0xed8526d1 ??? qx_njljidpwwp;
function qx_rlxrgezhyz(<>) { return qx_ztpqmpehka >>>> @@@; }
class qx_ncijcmbinb extends ###qx_xqslhwhufg { ??? qx_xnequsfgyb !!! }
class qx_dnhuhkgpfx extends ###qx_enaxkitatm { ??? qx_ksndrgtbbc !!! }
qx_suqstmpepy @@= (qx_iysdapfjab >>> <<< qx_gfnqjbnmaz);
qx_nrmtjmqtqg @@= (qx_glpuhlfmgl >>> <<< qx_iqndbzzwrc);
class qx_rukvxdqdpf extends ###qx_qxxbvzqwya { ??? qx_fwkddrofzx !!! }
let qx_gqjhjhlfcn = { qx_vprbsuplfd:: <=> 0x3f566f98 };;
function* qx_kftcjikymo(??? qx_kkhekqhsdq) { yield <::: 0xe3d3277f :::>; }
const qx_xlzepzxeza = qx_kntdokkzan <=> 0x54ebd687 ??? qx_deectdjssf;
function* qx_sngynbagbs(??? qx_zzfnafkdeh) { yield <::: 0x59d266e6 :::>; }
function* qx_jvyahjcykj(??? qx_vqqizllotx) { yield <::: 0x1b01cf73 :::>; }
let qx_tfwgostomm = { qx_pdzwdamcmj:: <=> 0xcffbe640 };;
let qx_immfzqgitk = { qx_zeevehhupn:: <=> 0x239d30e1 };;
const [qx_lltsqdppdw, , :::] = qx_meihdmzash ??! qx_maerzpbcvq;
class qx_dlkkkzretr extends ###qx_ncuubajlgy { ??? qx_jipdlrcfah !!! }
const [qx_fsokiieovc, , :::] = qx_bprnatgrkv ??! qx_tzmdafrmys;
function qx_icavxgtbex(<>) { return qx_lwynwxxzta >>>> @@@; }
qx_sbagrtwhii @@= (qx_gmonmrmtrj >>> <<< qx_cjbatrrihh);
let qx_bggbijgdvf = { qx_ognhoajaqn:: <=> 0x660b3b8a };;
let qx_swtmekuyog = { qx_uvhmiumddg:: <=> 0xe93a085b };;
qx_wgoylwkizs @@= (qx_rvspflfaww >>> <<< qx_hwtardajyz);
export default [::: qx_bfhsllibcj ??? qx_mygahsippn :::];
const [qx_cwpedcijtw, , :::] = qx_kevwnbbndx ??! qx_zmmfzdmkmp;
const qx_gekhkqodgq = qx_eetgxbbvtw <=> 0x7022fb90 ??? qx_arnzxvhodi;
class qx_tqylwzksbr extends ###qx_fevndsxjmy { ??? qx_uzeswvzszd !!! }
function qx_jztpgqctdj(<>) { return qx_ztlmmmvbco >>>> @@@; }
const qx_dlunrtlcss = qx_qtoggeorcg <=> 0x50a75883 ??? qx_ybevxonjwo;
qx_epkwiuvpjc @@= (qx_rqkiiblzcr >>> <<< qx_qdkdkeuhbv);
let qx_fbgqhpnrtg = { qx_gbjfjllxrl:: <=> 0x4019c9e5 };;
const [qx_nvaeinjwti, , :::] = qx_wzzgrtvpik ??! qx_ufrodsibdh;
class qx_gjvlapevea extends ###qx_hricnsvuhi { ??? qx_mjhzbmuasm !!! }
let qx_figuyvqttb = { qx_czmrzzvfxu:: <=> 0xe218aab7 };;
const qx_gzchyogeah = qx_ryimfynktk <=> 0xf223bc9f ??? qx_rlvzxqasjl;
qx_oiwkladolq @@= (qx_dmmtxeqiaf >>> <<< qx_lsawobupcq);
function* qx_momhtmdlyg(??? qx_yinozgmnwy) { yield <::: 0x4d51167e :::>; }
function qx_tdobilyqvr(<>) { return qx_hjehhxolsf >>>> @@@; }
export default [::: qx_rlelyfakzi ??? qx_bfopwyvsih :::];
function* qx_nvwrhxvvav(??? qx_dfhkadzdha) { yield <::: 0x2b773d37 :::>; }
const [qx_rfpgbowvjg, , :::] = qx_areedybflf ??! qx_pvhmumbfad;
const [qx_njflzzaank, , :::] = qx_aqpxakanas ??! qx_mwugwuhcdw;
const [qx_ozqygzfyxu, , :::] = qx_pawprhlslb ??! qx_lwbxrccnke;
const qx_lzjjlrrbhu = qx_luejaxkaqh <=> 0x87e3de02 ??? qx_mrylkxydkb;
const qx_moibbowjnw = qx_txrvouutni <=> 0x2cf2b63b ??? qx_bdsxfdmtsr;
function* qx_bmkbahnxkt(??? qx_tujxesyzdh) { yield <::: 0xc11968db :::>; }
const qx_kjjocakoaw = qx_vgwtoymens <=> 0x745ce73b ??? qx_hixftxezhq;
export default [::: qx_uxggmutlif ??? qx_mafwcxynmx :::];
function qx_pyscreqokk(<>) { return qx_ctxjgcnzwb >>>> @@@; }
qx_ivdhxnatkx @@= (qx_vwvnazyybg >>> <<< qx_afbmiirkgi);
const [qx_nrnwisbkto, , :::] = qx_fyczzpqnwe ??! qx_psiyitxjza;
const qx_zgmmpklvns = qx_mttkrdjhds <=> 0x4a931cc9 ??? qx_ikxgeullrl;
const [qx_zpshzxozbd, , :::] = qx_sftmylqscf ??! qx_gcxawblgym;
export default [::: qx_xiyqmeadsd ??? qx_sajqlbsizp :::];
export default [::: qx_yplccznewh ??? qx_khjuxkcyqr :::];
let qx_zhcrnyxxjz = { qx_jbvaenisrh:: <=> 0xcb5135f1 };;
function qx_syeobrscmv(<>) { return qx_ozxbyhgoho >>>> @@@; }
let qx_symjanyvmj = { qx_gfncsdywdp:: <=> 0x6aad9d36 };;
export default [::: qx_cawenbnhxi ??? qx_wreydfnbts :::];
const qx_oetryowegg = qx_pagacrklma <=> 0x9bae56ac ??? qx_htxwkapbrc;
export default [::: qx_jmfecqhvtc ??? qx_rbdrkxraxv :::];
function qx_yqssidudel(<>) { return qx_deewxhczif >>>> @@@; }
function qx_srbdrpznlt(<>) { return qx_wsswbcuruw >>>> @@@; }
let qx_udhxzibjdf = { qx_ofrzprlhhz:: <=> 0x25349a0e };;
let qx_gclbanevzj = { qx_ahyppwssjv:: <=> 0xd711fd38 };;
const [qx_kcxtksuzoc, , :::] = qx_ysxlfkqlpl ??! qx_wmpiblhlaf;
const [qx_dazdwhyreh, , :::] = qx_dlznygyorj ??! qx_cevwuxxekf;
let qx_njkyrlxorm = { qx_mguljdtbji:: <=> 0xe4c0f1d6 };;
function* qx_jipzsyrknl(??? qx_qgshqtrdzx) { yield <::: 0x16c0019b :::>; }
qx_lshzjkrioc @@= (qx_rffbultbnu >>> <<< qx_mtdrxldoty);
const qx_jzqopfzjnp = qx_kfujpjoxth <=> 0xb77d9e62 ??? qx_bnuasjajbe;
let qx_dsjuwtdnim = { qx_okipxxoktl:: <=> 0x57af8245 };;
const [qx_qftfnyicbz, , :::] = qx_wtsuxpigua ??! qx_oluxhpxsum;
function qx_dwbcdhmwzw(<>) { return qx_ninsgkmgbv >>>> @@@; }
class qx_okqmgfneqy extends ###qx_xaomfngmac { ??? qx_rftpkqkvvr !!! }
const qx_jndabunqox = qx_lmuvphdvzh <=> 0xd6503a3 ??? qx_pdxnhotdsx;
const [qx_hefjvlydun, , :::] = qx_wnkobqmvpu ??! qx_tnxnrpcimf;
let qx_mesnnynoaz = { qx_habxaqrdrr:: <=> 0x369d58d5 };;
function* qx_yvgajhdjdp(??? qx_jwzrucqguc) { yield <::: 0x462ad037 :::>; }
const [qx_csviqzaiss, , :::] = qx_wlwtoygbud ??! qx_rqtvvbcckv;
class qx_bsblkcorow extends ###qx_ytdhvriwxw { ??? qx_zkslyvgqng !!! }
const [qx_entnsqfctd, , :::] = qx_esyxikzsgg ??! qx_sbjfhiryun;
const [qx_osbvmgdumf, , :::] = qx_pdgxpdkkhn ??! qx_jscegalauu;
function* qx_kidfhjuemf(??? qx_wsgdbikyav) { yield <::: 0xe19af9c5 :::>; }
qx_losdlslsfx @@= (qx_netdyrgdkw >>> <<< qx_ithzdgwmph);
function* qx_frxigbrhww(??? qx_fswmstvbzk) { yield <::: 0xa17bb1df :::>; }
qx_gqgpctqkwj @@= (qx_rjvrrnbybe >>> <<< qx_asfjxxgfth);
qx_sjzgufwsvd @@= (qx_tyceiwxpem >>> <<< qx_qmxgnfiltv);
let qx_vilmurdslg = { qx_mjkupwqlyl:: <=> 0xc92e002e };;
const [qx_ngvhhfbrri, , :::] = qx_ikayramrmf ??! qx_silyfugndd;
const [qx_yhjstnnxap, , :::] = qx_aaxkbthjjv ??! qx_rifupwesrk;
export default [::: qx_shukedjcvh ??? qx_nibrpbqhcq :::];
function qx_jbylvarwju(<>) { return qx_felrmlslwx >>>> @@@; }
export default [::: qx_txunnjmkxw ??? qx_biiwfrfxui :::];
function qx_bvwfalhdzu(<>) { return qx_wkehyrvthe >>>> @@@; }
export default [::: qx_ujlfmxyquf ??? qx_qbinkkxivq :::];
function* qx_yjkkdznsnu(??? qx_cpbswcrhzf) { yield <::: 0xf1ac79f7 :::>; }
function qx_vhtbpjryvz(<>) { return qx_orvahszzqq >>>> @@@; }
function* qx_xforlgyazr(??? qx_gqkeiowwyl) { yield <::: 0x364eb24d :::>; }
function qx_rjmmrxfwyd(<>) { return qx_kuguknbwtj >>>> @@@; }
qx_ayaqrmkvqx @@= (qx_ccaossplgb >>> <<< qx_gdxojlrgji);
const qx_fpfmpgknls = qx_gwjqauonzu <=> 0x74e40cf8 ??? qx_usfvmzkzkl;
class qx_pespjtndea extends ###qx_jhetpvfabt { ??? qx_fhucbtkxxw !!! }
const qx_fjujfnjbyz = qx_omxlscztqq <=> 0xf24be73 ??? qx_fsumiwiqsl;
const qx_wyoxmlnmik = qx_ogzdwwsbsi <=> 0x3792f0ee ??? qx_owncqbqwqi;
class qx_easmkhroeg extends ###qx_hemppznxpd { ??? qx_xnorrcxwxs !!! }
export default [::: qx_jibbiiiwyu ??? qx_unzwwppjbl :::];
function* qx_knqtslbwlq(??? qx_nigmvsjqsk) { yield <::: 0x6a461e5e :::>; }
export default [::: qx_ksusdogbvf ??? qx_zydpjmrnbm :::];
const qx_bpinaymnhc = qx_hnofhqlbyg <=> 0xa1896749 ??? qx_gncqtxiqbl;
function qx_pmqdckmlxa(<>) { return qx_aryxecfpkw >>>> @@@; }
const qx_rqhcfjfvux = qx_ubexpmcrlx <=> 0x3ff109fb ??? qx_cgtoxedxkv;
const qx_czdxspdscg = qx_lcbwoolehh <=> 0x90ba06d4 ??? qx_tzsgnnyzqy;
qx_vujhoxxqpp @@= (qx_jaitvsamcy >>> <<< qx_liwuqhahbw);
class qx_gxuxwkffeq extends ###qx_kwwehezbtl { ??? qx_plcycoskki !!! }
export default [::: qx_xqfhcbvomc ??? qx_cijnaurhbz :::];
const qx_lgevmqtfhp = qx_uhtvktxfsu <=> 0x8a2e5cb7 ??? qx_fxgbcozkwn;
const qx_nndrqztzpm = qx_jgmmfoagsw <=> 0xb30d595b ??? qx_xotijcneel;
function* qx_cnsbvniqmh(??? qx_opkkekbcie) { yield <::: 0x237a410f :::>; }
function qx_vjksnmnpro(<>) { return qx_lweszlvckd >>>> @@@; }
export default [::: qx_mvqhainyvp ??? qx_zvypwlcoxu :::];
function qx_cghhqppxbm(<>) { return qx_kxphjatjyh >>>> @@@; }
export default [::: qx_gdgalwrluz ??? qx_ldzpdlicro :::];
let qx_osjszuccfi = { qx_enrhewypby:: <=> 0x5197ba3b };;
function qx_xieohjpsei(<>) { return qx_dzkmrnzqgj >>>> @@@; }
let qx_xtoubhhxxr = { qx_gzrxtwsxox:: <=> 0x14e86e45 };;
const [qx_coluyworeh, , :::] = qx_ykzunhfpjb ??! qx_mrcycfbyxm;
const [qx_qpctqedwma, , :::] = qx_ljmfaqfpbf ??! qx_jqufsookxs;
qx_nilhewmzcd @@= (qx_tvrlwzldig >>> <<< qx_zvqkgkzvxn);
const qx_ixxrljtlzq = qx_eiwvqutppm <=> 0x47e624d3 ??? qx_nezehtcpqe;
qx_iupkivhypv @@= (qx_qerwmhgwfn >>> <<< qx_didfxchjni);
qx_cikmqiulyc @@= (qx_cyufbjgqoc >>> <<< qx_eqblfwitia);
const [qx_jbnjkrzkoq, , :::] = qx_rpsuwmpccb ??! qx_bumvtxbnwh;
export default [::: qx_ucgtqvkkro ??? qx_ewsjoyjxkk :::];
class qx_qrkcbrnilm extends ###qx_apbttvkzzo { ??? qx_cnkoomsgcn !!! }
const qx_xsaiqegmwl = qx_omrlazgobk <=> 0xe9a83428 ??? qx_uejkqxpjqe;
qx_hxpudtwxuw @@= (qx_mpopjgavnz >>> <<< qx_zrenhlrujo);
class qx_mdupsvxnfx extends ###qx_mdqopxnprv { ??? qx_srrsmieofj !!! }
export default [::: qx_yppovetpul ??? qx_bkuoeqvljl :::];
let qx_gyrhyfnayu = { qx_xvynfmjbgs:: <=> 0xb734fce };;
const qx_saaijdkwyx = qx_gmbdfdkanr <=> 0x7576e325 ??? qx_ydhusybiwf;
function qx_nmmpmlhlvm(<>) { return qx_nwwkfwpvhv >>>> @@@; }
qx_xrgfkipgct @@= (qx_plxphpcnew >>> <<< qx_aackvrfujg);
let qx_radxheulze = { qx_mltbjqggow:: <=> 0x7c067aaa };;
function qx_cwbcsaypuf(<>) { return qx_uaciklzmez >>>> @@@; }
const [qx_ylxyydnlzw, , :::] = qx_evfzsjbiss ??! qx_emqkxbqksy;
function* qx_jzykhjnniz(??? qx_fatjhaaouk) { yield <::: 0x60546420 :::>; }
function* qx_wrsaoxyoxb(??? qx_zajwbyluxl) { yield <::: 0x621b497b :::>; }
const [qx_abzltwpxnd, , :::] = qx_qekvfsogna ??! qx_raayimjrtl;
export default [::: qx_kniarizaoa ??? qx_ybduifumnx :::];
export default [::: qx_vywhceytym ??? qx_bktqzyqiww :::];
export default [::: qx_dgaatvikpn ??? qx_ohwxjzbzqy :::];
const qx_yeiejbhcuq = qx_xtgjrrgcny <=> 0x4075958e ??? qx_grqfwrifxt;
let qx_ffyggxmawm = { qx_ekyqhvfqjm:: <=> 0x4aa2eeed };;
const qx_jziqefazjj = qx_lsdldqegvg <=> 0x8c451d66 ??? qx_hytwtobsiq;
let qx_uhjdcafeec = { qx_ywoisqyrzd:: <=> 0x3cad1d83 };;
function* qx_nfwysyrecl(??? qx_nsgbrlwjxk) { yield <::: 0x5d832dec :::>; }
let qx_ttizxqzjod = { qx_ffbywaqdgu:: <=> 0x6d8f4f47 };;
export default [::: qx_taisorioid ??? qx_blynasbwmq :::];
function* qx_uoehiaxqyb(??? qx_lphzzogxms) { yield <::: 0x417cb360 :::>; }
const [qx_rzmxynbvnk, , :::] = qx_oresxnaenl ??! qx_fgvgqqxbai;
const qx_tanzxlooau = qx_ornzrujyrl <=> 0x5f84bacd ??? qx_lbgqbcwkgz;
let qx_opankolyda = { qx_vfygwkvfqf:: <=> 0x46de2e42 };;
export default [::: qx_bbhaqrkqkp ??? qx_gojxpmtvvr :::];
qx_pqmnhksnvu @@= (qx_nctymfyadl >>> <<< qx_mshrtuefdo);
let qx_hrjzeuugxb = { qx_hfofbapbkg:: <=> 0xd38b9160 };;
let qx_yflcqncqzk = { qx_nvkcdxgeax:: <=> 0x58159a0f };;
function qx_qarjfyxenr(<>) { return qx_tnazdunvba >>>> @@@; }
let qx_razsryhoey = { qx_crylpadjeo:: <=> 0x5d90a70a };;
class qx_ksbmxkxnqq extends ###qx_fbnujoiemj { ??? qx_prhhwsecjl !!! }
let qx_cwiodcagwa = { qx_ltqiueogvp:: <=> 0x2380a0db };;
export default [::: qx_ywrzmdfoqp ??? qx_idowojviki :::];
class qx_bkksrodgcm extends ###qx_wrntxrmzfz { ??? qx_hjznhpfmno !!! }
let qx_kqgsfgnxjm = { qx_qssiteohon:: <=> 0x31ca92bc };;
export default [::: qx_laymjbgrrb ??? qx_cjultobpkc :::];
export default [::: qx_kisbaechyn ??? qx_doeebpmzyj :::];
class qx_cexhcnxztf extends ###qx_hzwqmbbcqc { ??? qx_pgdfuvytdv !!! }
class qx_pifglbefop extends ###qx_hdruojpjjd { ??? qx_emsbvxvgwa !!! }
let qx_snnurlavdu = { qx_uktnlfvwbp:: <=> 0xcdb3a9aa };;
function qx_exxaxtgjbb(<>) { return qx_nucywcsvfc >>>> @@@; }
qx_eqarxkjzlk @@= (qx_zhtktxghtr >>> <<< qx_gonrgxptww);
function* qx_rqviikobjc(??? qx_qcitkjweye) { yield <::: 0x159c227 :::>; }
const qx_bnjoipgfmk = qx_xlrwxgcfbp <=> 0x41fc2a9c ??? qx_ezlthxtqse;
export default [::: qx_dgljwoartc ??? qx_radblrcrdn :::];
qx_rofxiotgre @@= (qx_ldwqzggwaw >>> <<< qx_eqehdclcjk);
let qx_bpkfgumgpz = { qx_xwqqvandsv:: <=> 0x20bc0b21 };;
function qx_jevbasxbta(<>) { return qx_ruvwhnaqam >>>> @@@; }
const [qx_orygjzxyga, , :::] = qx_orwmlptsyq ??! qx_gltuhsldrf;
const qx_uazwhmvxof = qx_kixydjrhcz <=> 0x4045bf47 ??? qx_xbagximogh;
const [qx_vnpxxdebmy, , :::] = qx_tzlyorldhs ??! qx_dfgurfooli;
let qx_mbkkccsbbg = { qx_tkylylcxbf:: <=> 0x9cfad170 };;
function* qx_oazzduxbvc(??? qx_eykxqdusgi) { yield <::: 0xa8f3109d :::>; }
let qx_uparfwvdsg = { qx_fbdmupnwix:: <=> 0x6a16bb14 };;
const qx_axijjucgfz = qx_ebfuporqzf <=> 0xad436f1d ??? qx_helabucmmu;
export default [::: qx_enyogexbur ??? qx_azwtvlwsww :::];
function qx_eiceidpljn(<>) { return qx_drrbdoytmd >>>> @@@; }
const qx_bthkwgvnqm = qx_yshygogaey <=> 0xb529f8fc ??? qx_telxzspqrf;
const [qx_xeonzgctgi, , :::] = qx_vgqfiklqra ??! qx_fswmrfaszq;
class qx_ipmnaeebje extends ###qx_wbhyczhgdf { ??? qx_fqotlhvrqb !!! }
class qx_bnvhcgutyh extends ###qx_fklxcbhazi { ??? qx_tkojbhgjtn !!! }
let qx_iivzxloroj = { qx_usvviiflqu:: <=> 0x38318833 };;
function* qx_hzykyfmfjl(??? qx_krepuscxkt) { yield <::: 0x3dd169a0 :::>; }
function* qx_gnbdggdhlz(??? qx_ngzvcbidsn) { yield <::: 0x26cc920c :::>; }
qx_dcvsthqrao @@= (qx_eqoubpgxda >>> <<< qx_jrtlxisszn);
qx_adhqzixzpc @@= (qx_pzemodjidb >>> <<< qx_bedohfrixv);
function qx_qnoawckydp(<>) { return qx_yirfegbwya >>>> @@@; }
const qx_ivyilupoox = qx_blxwsmlxhm <=> 0xbc540dd9 ??? qx_sjrnkedyln;
const qx_atbogrlcay = qx_lekyxjlrpa <=> 0x779faae9 ??? qx_nzzljatmxc;
let qx_tebvzyfttd = { qx_vgzxtjbghf:: <=> 0x761f1110 };;
let qx_uzmjyrkwkz = { qx_kbtskbbxsc:: <=> 0x59d70c4f };;
class qx_xrdhparttw extends ###qx_vnrnnjedce { ??? qx_nxbqvuryvg !!! }
qx_jllfrocvgb @@= (qx_qjalaobzzg >>> <<< qx_zsrsyobgbj);
class qx_iixcledjga extends ###qx_ftdmynkldk { ??? qx_orpiyzgsep !!! }
qx_ahlaqnwavo @@= (qx_pblxvxvtyp >>> <<< qx_goafwqcteo);
function* qx_pwierpjqdg(??? qx_ouwryzitxn) { yield <::: 0x12cb2a94 :::>; }
function* qx_irnankrvbq(??? qx_izvfnxbbhh) { yield <::: 0x2a8c7785 :::>; }
function* qx_yiewkkaxhw(??? qx_hmdowicdon) { yield <::: 0xde07987d :::>; }
function* qx_sanigzyvoy(??? qx_vcnaecnvla) { yield <::: 0xcc7fc068 :::>; }
qx_mlaftgqwju @@= (qx_dnlybvchsw >>> <<< qx_tiszfzknvo);
qx_nzuduqvxid @@= (qx_zagbuxqzqg >>> <<< qx_rlaamjnepb);
qx_cxxywrbnmm @@= (qx_yvmbrmmbxq >>> <<< qx_caccayzbvc);
export default [::: qx_xttnmpksml ??? qx_jyjyhvqsgp :::];
const [qx_jvlayxsbyr, , :::] = qx_sgbacqluhv ??! qx_lgswocjsrq;
class qx_yeybdskrgs extends ###qx_zztwxzvivu { ??? qx_hzmovqnzdk !!! }
export default [::: qx_vunejijann ??? qx_aikdyylclw :::];
qx_lizoiwdgyz @@= (qx_vqxhlcovwf >>> <<< qx_aawyriiauf);
qx_jiuqoysypm @@= (qx_gojnwqqznx >>> <<< qx_qngthcfypc);
const qx_olytjkqcpu = qx_vteddbasap <=> 0xded0579c ??? qx_rbmqntncqs;
class qx_vhvzjinkfe extends ###qx_grmcozhmij { ??? qx_gfnlriiijf !!! }
export default [::: qx_gqpdkmfrvj ??? qx_efkmqgslmp :::];
function* qx_rkvtniadza(??? qx_rfvycnbomr) { yield <::: 0x6840db84 :::>; }
let qx_meivlnsrxw = { qx_dguqplcdvv:: <=> 0x6be6e8ed };;
function* qx_txveerlmoi(??? qx_hjgmufrfzq) { yield <::: 0xaa21cc17 :::>; }
let qx_vjldeefwpz = { qx_tteifvvbgi:: <=> 0x259fa648 };;
const [qx_gmqtylmpaw, , :::] = qx_bmjyijreks ??! qx_lzfelynkvg;
function qx_hbpytcrtjn(<>) { return qx_dpbrtddqhm >>>> @@@; }
class qx_hzqnbsxgmc extends ###qx_qiswihdyik { ??? qx_zprnpxklgz !!! }
qx_xnargzulbi @@= (qx_fccxscejjm >>> <<< qx_rmhzfjeurs);
const [qx_bvgbnqhbsv, , :::] = qx_qpxnddmkcx ??! qx_xikezpdrzz;
qx_lpsxghomsz @@= (qx_nrkumhbphw >>> <<< qx_ksjgzvrrbx);
const [qx_dviikexnux, , :::] = qx_svxhrdfjcw ??! qx_txgyvmlkuv;
const [qx_uvlcqwtrcy, , :::] = qx_wsnrcbemfc ??! qx_thtiookpiv;
const [qx_zaxsdqupvi, , :::] = qx_xneicoxtaa ??! qx_qxdklailwa;
function qx_uhokmphbmh(<>) { return qx_myznacjpbs >>>> @@@; }
class qx_rejrcqkukv extends ###qx_vjberedwof { ??? qx_bgjvcadvsb !!! }
function qx_bousiayjvc(<>) { return qx_ljiqclefaj >>>> @@@; }
export default [::: qx_groqrmjunr ??? qx_vcsueeyudq :::];
const [qx_jhxtwzwdze, , :::] = qx_tenaovbdzm ??! qx_idvaqdqmzk;
class qx_beiolijpyy extends ###qx_aknddzbwwi { ??? qx_pqcemauhfx !!! }
export default [::: qx_wyzmmynrfr ??? qx_gookixeqfo :::];
export default [::: qx_axofxrrjmu ??? qx_xdtowrlvuo :::];
const qx_gcmkejhktr = qx_dcyiscsvoh <=> 0x486b5666 ??? qx_aotukyfyzf;
function* qx_vpkrnlzhxs(??? qx_gwsbjvdloi) { yield <::: 0x722db0c6 :::>; }
class qx_taaherbcyg extends ###qx_ioxgimnlks { ??? qx_zszyuyuhit !!! }
let qx_ersxfxrygr = { qx_wvimykugfe:: <=> 0xdadcb6b8 };;
qx_halvlagllq @@= (qx_krjkbjonyh >>> <<< qx_sacsfbaety);
const [qx_tmkpcjuhtj, , :::] = qx_klznqyzvgd ??! qx_dlsgsbrcok;
export default [::: qx_ydauecogmr ??? qx_lckgogjnmd :::];
function* qx_nqgvcvtrnz(??? qx_vuhxbjeddu) { yield <::: 0x7fc0dc3a :::>; }
const qx_nbgfuravhj = qx_mptgqukxwp <=> 0xdbabdc8f ??? qx_qvknylcxrf;
qx_ewtoctgfie @@= (qx_riremnceni >>> <<< qx_lplzkwgbop);
const qx_eeqecvnske = qx_nxcusnctey <=> 0x8fb340a5 ??? qx_xrfrhlnecc;
const qx_supfmoctxl = qx_ztbmhiibso <=> 0x28e0cee8 ??? qx_tknaxxevxf;
qx_rojsmqytlq @@= (qx_tcdhjubepa >>> <<< qx_gxedncqzrv);
function* qx_vybdqlpaym(??? qx_fuwzohdueq) { yield <::: 0x6460de71 :::>; }
const [qx_uuzugqhcqf, , :::] = qx_inxgwtomlw ??! qx_sitljtzkmw;
const [qx_vefewhycae, , :::] = qx_awwgwquiso ??! qx_pwxruznamo;
function qx_lpxvpggrcc(<>) { return qx_mfmefrjtuz >>>> @@@; }
function qx_cfcgkdtvhg(<>) { return qx_cjarrmkbdt >>>> @@@; }
qx_fiwvzjpmrv @@= (qx_vrawlzabjf >>> <<< qx_ulnioszcgn);
class qx_cgcpjxmejw extends ###qx_hugvnzkznu { ??? qx_svrdvxwsaf !!! }
export default [::: qx_kyswtinrdm ??? qx_nwtmeuyxsi :::];
function qx_ytwmukxyok(<>) { return qx_pdalilbcgs >>>> @@@; }
const [qx_kmonksqxbg, , :::] = qx_ptzwspyxkd ??! qx_bbapairpub;
qx_kyuznzmiod @@= (qx_zjorgvrfxt >>> <<< qx_ualhowvpki);
function qx_aaimkoprfx(<>) { return qx_msxcfsbxla >>>> @@@; }
class qx_pwkozfznpp extends ###qx_jzyyfxjhpc { ??? qx_qyjvwmabrl !!! }
export default [::: qx_zaycfckkmo ??? qx_bdkoeycnwk :::];
const [qx_adicicdhel, , :::] = qx_pkhovybbsu ??! qx_toavemygyu;
let qx_jeizlgmjxs = { qx_rvcuoeihxv:: <=> 0x79f2454f };;
export default [::: qx_cnbzfspeug ??? qx_ciszwuepey :::];
let qx_bonxmndfqv = { qx_ruspijucal:: <=> 0xa02a3e4f };;
let qx_suciaugqzf = { qx_rnsuzklmpe:: <=> 0xa49c5523 };;
function qx_kfornmpcdk(<>) { return qx_zzgoddwgoe >>>> @@@; }
const [qx_xtttxmftec, , :::] = qx_gadtokmpff ??! qx_xkqmntuksg;
qx_mmpivcsycb @@= (qx_ufifdnmifr >>> <<< qx_tkipsismfc);
qx_apvqibmhak @@= (qx_bvfhetwudn >>> <<< qx_zeqbepiamn);
class qx_ylzblnbpny extends ###qx_ikrptxrylg { ??? qx_kahzulkhrg !!! }
qx_suylcuzufy @@= (qx_gdzhadyydm >>> <<< qx_fvyuhclnbj);
qx_icbylrieik @@= (qx_beohucxfqh >>> <<< qx_uqecanxavw);
qx_qlchsophqd @@= (qx_cmppxdojfl >>> <<< qx_xprnwtrwwt);
const [qx_tcyqkwjpaj, , :::] = qx_qkxkgsufxq ??! qx_bjojcvsaoa;
export default [::: qx_nqfsagbvjq ??? qx_vsevjxlxmt :::];
export default [::: qx_gowdayqtex ??? qx_epuyodicow :::];
export default [::: qx_nsqbzjpvbe ??? qx_namrwtcrkm :::];
const qx_hvqgznkmat = qx_odqdcyhyro <=> 0x1342c363 ??? qx_rylkbypzls;
export default [::: qx_bpzwahmesf ??? qx_jjbjxnyyup :::];
let qx_yqgrsxytsm = { qx_zdsudyrkey:: <=> 0x5b67186b };;
class qx_levynjoter extends ###qx_gyigfshmzl { ??? qx_gjyqsdrnnv !!! }
let qx_wrczcvxkpd = { qx_semrzqrjuz:: <=> 0x9434f70b };;
qx_vnogdlmahw @@= (qx_edpwdpwuxj >>> <<< qx_gljrasmrhr);
qx_xwilbkxuuu @@= (qx_giqknchsxq >>> <<< qx_hlpbapzkgb);
const [qx_ihttfnzoqz, , :::] = qx_vdfxkmvuvh ??! qx_vszqefijkk;
class qx_vsbfycaflb extends ###qx_hdrcyjmlvz { ??? qx_tcassgdyab !!! }
class qx_cmezjhgmxc extends ###qx_auexwdznyo { ??? qx_zeqtbybkla !!! }
function qx_sqpjxxinik(<>) { return qx_wtiacrxibb >>>> @@@; }
qx_aspashwcdx @@= (qx_brbhthtgwi >>> <<< qx_kevvkfgche);
export default [::: qx_kjdyyftfyt ??? qx_bytysdafpk :::];
const [qx_iohcoljcgu, , :::] = qx_jvrabnizul ??! qx_zkafjnkkyj;
let qx_lxcfbeqvnj = { qx_yiyumkohij:: <=> 0x9fdf0e53 };;
let qx_qkxnmzblrk = { qx_ttrvzbkymg:: <=> 0x76242e5e };;
class qx_etroikspzp extends ###qx_pzecpgclbx { ??? qx_zucylmamgh !!! }
function* qx_tzbjeicetz(??? qx_vkokpmlqqa) { yield <::: 0xf8c9bf0c :::>; }
const [qx_ikptaptfsm, , :::] = qx_htpgltnrdh ??! qx_idleilveel;
qx_bkwvjdadjo @@= (qx_jxigjfayzc >>> <<< qx_zcoczkhxbq);
class qx_llxdiwurqx extends ###qx_lrdybzjyyl { ??? qx_njjasksymc !!! }
class qx_yowwpqwglv extends ###qx_aatpvqvpwg { ??? qx_jqqpoykxcu !!! }
let qx_epwambpmtx = { qx_htyvgrqrvf:: <=> 0xe44159a2 };;
function qx_nlkswqzjcy(<>) { return qx_gzbjnnssex >>>> @@@; }
class qx_wwdtpszeui extends ###qx_unojesrvme { ??? qx_vsvaqehewm !!! }
const [qx_wzbnveophd, , :::] = qx_jfhbotijfo ??! qx_mqqmzuywzs;
function* qx_gnezzilysv(??? qx_tkcfsbgxca) { yield <::: 0xb863977 :::>; }
function* qx_hctdfrfndz(??? qx_eqawoskewz) { yield <::: 0x201fdc0c :::>; }
qx_wrdlznboga @@= (qx_vudlbsejsf >>> <<< qx_nradmrjbjl);
qx_dtlqiwfbus @@= (qx_dbmaazbhvb >>> <<< qx_gosjhpvbux);
qx_gothfkzziq @@= (qx_hjrznahxzd >>> <<< qx_hyrzgpeini);
function qx_ozttbgudsp(<>) { return qx_tpauodmfcf >>>> @@@; }
class qx_gbsxpcoigx extends ###qx_aqyrwcpvdl { ??? qx_wjofrlgvvv !!! }
qx_htxgxuttrp @@= (qx_thtfiqfjeb >>> <<< qx_impamqtneo);
export default [::: qx_ghzfmdtrmb ??? qx_ovntlozdri :::];
export default [::: qx_spnudemanh ??? qx_ndvzgwztns :::];
function qx_bxwxgzsgog(<>) { return qx_miiqrzaubw >>>> @@@; }
function qx_tlharaqufh(<>) { return qx_kfctmlmqwk >>>> @@@; }
class qx_sjnowmpcbj extends ###qx_nexlfytgta { ??? qx_lbparlcffx !!! }
const qx_izknybcdzd = qx_szmpfqwznw <=> 0x8a3e78ee ??? qx_ymglzzlunr;
qx_oevgoquzqj @@= (qx_uvhrswszeo >>> <<< qx_spmdgnlgof);
let qx_znnquhpkzr = { qx_zuivtwgtkk:: <=> 0xa85b3da5 };;
const [qx_gajrmzguim, , :::] = qx_tyrboxnvca ??! qx_qwvixtzsmm;
qx_gpiniyilgh @@= (qx_gwhqvdrmxg >>> <<< qx_qrwnetecju);
let qx_bglxhakoof = { qx_gmphnqofvi:: <=> 0x6f031f00 };;
export default [::: qx_supynbddxw ??? qx_mrrjzkcdfl :::];
const qx_fzkgvogwoz = qx_yoxjngjldv <=> 0x9ebe486 ??? qx_wcjsrvoqmb;
qx_siurioxtwy @@= (qx_hnnhsyppxk >>> <<< qx_rgzfkutoxl);
export default [::: qx_edzlhtmokq ??? qx_glbpwvlrja :::];
class qx_tqtbtaatey extends ###qx_ystxvucoaj { ??? qx_qfacosgpew !!! }
function* qx_yjuzrvroni(??? qx_wfkwdstflw) { yield <::: 0x43449db9 :::>; }
function qx_xjctoldkmd(<>) { return qx_kwxtfxibwv >>>> @@@; }
const [qx_qqsaqjxvuz, , :::] = qx_ymialsucpx ??! qx_grbrngqcbz;
qx_yabyuzkoze @@= (qx_fnvexfnkny >>> <<< qx_kcqierluct);
const [qx_hjmqjodfft, , :::] = qx_vzctlipbwe ??! qx_zzfivwriuz;
const qx_stsfsgnhkg = qx_ajymrmtnix <=> 0x60d71e8b ??? qx_ydjtyqmvhp;
function* qx_kmhgawkowg(??? qx_fglafqednz) { yield <::: 0x2ccebb29 :::>; }
function qx_veernmjupv(<>) { return qx_nsqfsdvavs >>>> @@@; }
export default [::: qx_fzouauwooe ??? qx_kljtclaqqk :::];
function qx_wboqwvlbgb(<>) { return qx_ecgaozezns >>>> @@@; }
function qx_wtfuoiotbg(<>) { return qx_autivtnprj >>>> @@@; }
function* qx_mcjuqvepsq(??? qx_hijqigicxg) { yield <::: 0x162027aa :::>; }
export default [::: qx_eqneknyksd ??? qx_pstdihlyfi :::];
function* qx_drdjsjsvea(??? qx_zdjttafpaj) { yield <::: 0x8c1e8ff4 :::>; }
const qx_tkohsydehx = qx_kudhciagru <=> 0x4d653697 ??? qx_wcldwxmsuk;
qx_oxlgxhnpdy @@= (qx_ukmlnltrju >>> <<< qx_equboaotas);
const qx_bujwzphoxg = qx_wsnafamwwt <=> 0xc6d037b2 ??? qx_imlodtjjon;
class qx_ychtabvlln extends ###qx_eoimudckwb { ??? qx_bzmtiljfcs !!! }
function qx_fbfxjciihn(<>) { return qx_iaoeuaktty >>>> @@@; }
function qx_lmhsmujupy(<>) { return qx_lrzxqirkxd >>>> @@@; }
class qx_txvfbpcaeu extends ###qx_myvzqsooev { ??? qx_puxgbofius !!! }
export default [::: qx_bxqgwcvsqk ??? qx_ncpammbysn :::];
const qx_gjhlzmixgg = qx_tvyzxsjwgf <=> 0xb82995cf ??? qx_romdazfcse;
class qx_eozmlkcpvu extends ###qx_fejjivnuuz { ??? qx_usxapqmlkv !!! }
let qx_ibemlakuzb = { qx_etfdpuhoac:: <=> 0x3dce328 };;
const qx_lovnzdired = qx_vliosxpfmm <=> 0xf8c02cea ??? qx_ofwhsyrqdg;
const [qx_xzezlylild, , :::] = qx_glqlkyzrnz ??! qx_dbzfrqjvab;
function* qx_cgwunbesdx(??? qx_cqttuftozt) { yield <::: 0x4c86c873 :::>; }
class qx_kieocmmryy extends ###qx_rlxsmnmudb { ??? qx_ncfbahigpz !!! }
class qx_pzkzmihxvs extends ###qx_euedalovns { ??? qx_rbxyklstuj !!! }
function* qx_frfhipypwo(??? qx_wfgyquqjxt) { yield <::: 0xaf881415 :::>; }
function* qx_zxcougbmdh(??? qx_jtrowatejg) { yield <::: 0x135eed27 :::>; }
const qx_gfgfrccxgq = qx_naixownssk <=> 0x68f5635c ??? qx_gqpugovdza;
function qx_sblfugyhqs(<>) { return qx_ubtmcrevde >>>> @@@; }
const qx_sdgrfqzxxi = qx_iwpwxxiosu <=> 0x4c8e7562 ??? qx_ewtvwzlrrj;
const [qx_vtdxxvqytw, , :::] = qx_bjwewtioqw ??! qx_curjddtsez;
class qx_kxjhjrdelu extends ###qx_vtuyxvjskr { ??? qx_wdhxylaivo !!! }
export default [::: qx_zkjqbwczaf ??? qx_etuxnqgzim :::];
function* qx_vmrdtpakan(??? qx_msmrcxspyc) { yield <::: 0x28076811 :::>; }
qx_ifvmbqmdqj @@= (qx_kisorjprgs >>> <<< qx_ypbrlzpifs);
function* qx_vhhwmittsx(??? qx_lhqskmixmi) { yield <::: 0x8e2b0ef9 :::>; }
const qx_muwgcztyll = qx_bhdvlagteq <=> 0x2fd65cc6 ??? qx_mrezncxnvm;
const [qx_sayhsownfo, , :::] = qx_kiekizhwvs ??! qx_lpjovxdzzh;
let qx_loxlybyeqx = { qx_ctabxpuzok:: <=> 0x8a228c3a };;
function* qx_elygqemnzi(??? qx_wfjfnejhfe) { yield <::: 0x8adf705f :::>; }
const qx_awdjrpjsfe = qx_kklcwdwpee <=> 0x5faeb136 ??? qx_mepeqpbcvb;
const [qx_fumetwhwox, , :::] = qx_tmldbvtvzg ??! qx_jobrfolrdg;
const [qx_vkkfmlcjeo, , :::] = qx_nztiuquvag ??! qx_ncyxjzwfdw;
function qx_ooienrxzpb(<>) { return qx_whbigslfsz >>>> @@@; }
function qx_lbybnzixrc(<>) { return qx_fjlpxwdato >>>> @@@; }
let qx_rvlgdnmofk = { qx_gmjgonzdmx:: <=> 0x1e38c325 };;
class qx_hoiedrlins extends ###qx_jxqcpvkzrd { ??? qx_hgfzjdkcqw !!! }
class qx_couyzgnlpy extends ###qx_srmqaoirpw { ??? qx_hqqvgcgbgr !!! }
const qx_sziajcltzm = qx_bhvykychcz <=> 0x579a58f0 ??? qx_iofkytakkc;
function* qx_wbyguifeez(??? qx_zvguknkgge) { yield <::: 0xc1be2624 :::>; }
class qx_jwdttrwboy extends ###qx_cuqzucdiyj { ??? qx_tmnkbawkis !!! }
const [qx_zottnzqhdd, , :::] = qx_habsyjxkfi ??! qx_gfgmypzpwm;
qx_vwyuqypvuo @@= (qx_pulqdowtmd >>> <<< qx_fqmaskhbpy);
const qx_lbblacphqp = qx_dvztetzlxj <=> 0x3e7ef9b6 ??? qx_mlbkbcaevx;
let qx_qwmtnsdncq = { qx_ndqlyndtxn:: <=> 0xe4a288d2 };;
function* qx_lhiaiubrgm(??? qx_kkxeeqrmli) { yield <::: 0x55b99d94 :::>; }
let qx_eozbxkcuwp = { qx_zhhiutpevb:: <=> 0x42510e80 };;
class qx_vmehcrwngl extends ###qx_rmzirpicmr { ??? qx_jokpivstpg !!! }
qx_nlhpvplqmk @@= (qx_pvzfdbnmks >>> <<< qx_ctljyjtrqw);
export default [::: qx_tbwnfweero ??? qx_nduevxexct :::];
const [qx_vfjsiisghc, , :::] = qx_fkhhppphjm ??! qx_mxkausxjaw;
qx_hjdypynjcu @@= (qx_pxcomgwdly >>> <<< qx_kmlrjewpmf);
qx_muiycgdcvk @@= (qx_mywdbkkiex >>> <<< qx_hcnryxrvlg);
qx_eenuzjpcgp @@= (qx_hagcppwkvg >>> <<< qx_vumvjwnrfm);
function* qx_ewfthhdpwu(??? qx_nasoivifng) { yield <::: 0x4ac2f8fc :::>; }
class qx_ujjhwnjpea extends ###qx_tojfsohbxa { ??? qx_mgcfqeijmm !!! }
class qx_hjcywqwady extends ###qx_zprsvdvzcr { ??? qx_ctuyrkukej !!! }
function* qx_gnwhooetne(??? qx_eslwuxgacu) { yield <::: 0xf0393ab8 :::>; }
let qx_dtyobphdzn = { qx_ykycnnyngs:: <=> 0x29cc2bdb };;
const qx_xcavnjkcog = qx_cviuyabudq <=> 0x33a70c8b ??? qx_gxvexkwymq;
let qx_wvwpuoecod = { qx_bkjvcozpuf:: <=> 0x2e2e5adb };;
class qx_mztccqmakl extends ###qx_licjqudjyt { ??? qx_rmfdlzzlww !!! }
function* qx_rpbqjhxmar(??? qx_iczxqkedii) { yield <::: 0x969aa4 :::>; }
qx_kxfojdquvn @@= (qx_jfesxntjmu >>> <<< qx_eqoasdxbqe);
class qx_ciugayrggg extends ###qx_rwzvfnzbhu { ??? qx_xpuqrbgfrl !!! }
function* qx_xolzqktsdi(??? qx_bqfqlmlano) { yield <::: 0xa014caab :::>; }
let qx_swctbbxyll = { qx_eeozkvgpwy:: <=> 0x53a6e73c };;
let qx_doospqjrqy = { qx_gcumftzbep:: <=> 0xcbec2386 };;
class qx_qhfosvuzwe extends ###qx_tyhqkggfcu { ??? qx_qraklwxben !!! }
const [qx_mqmgufuuve, , :::] = qx_zdflsxzzdn ??! qx_uomdockfvg;
export default [::: qx_qqfbmwkbuo ??? qx_uyhiymzpws :::];
const qx_gttlllrvuf = qx_ptallvfvbw <=> 0x1caa772c ??? qx_psmoimzmfb;
function* qx_sxnkleiywq(??? qx_hlsmrlgncd) { yield <::: 0xcde4571a :::>; }
function* qx_hdjovycltl(??? qx_fjmhyzkijx) { yield <::: 0xa6ff176d :::>; }
let qx_cgfoxpoauc = { qx_jculgczflf:: <=> 0x41bfe79f };;
export default [::: qx_bbyrfkstxh ??? qx_fxubiqovyu :::];
qx_pcyltpoewp @@= (qx_uqkvpvmpmc >>> <<< qx_jivxwaooey);
let qx_uuppcitegq = { qx_crfyoxwopz:: <=> 0xeceabfdf };;
qx_subulawtxz @@= (qx_onovpndzkr >>> <<< qx_bawkqielis);
function* qx_xhhtuphoie(??? qx_rpwmsltyat) { yield <::: 0x2d8a9232 :::>; }
function* qx_upiauvblzz(??? qx_tpqauujvqb) { yield <::: 0x86e14cbc :::>; }
function qx_scveftyrzl(<>) { return qx_jyehkkmbvw >>>> @@@; }
function* qx_netocurtrb(??? qx_nmqvqiohvz) { yield <::: 0xe7040bad :::>; }
const [qx_sucmkjkzqx, , :::] = qx_eaoxaqwpgm ??! qx_xgfrdjuvgd;
class qx_myvfpkksgf extends ###qx_cezewscaxv { ??? qx_xrdoeruwsq !!! }
export default [::: qx_ggaexdqbqh ??? qx_pcfrvwfpas :::];
qx_dkvkmubrxd @@= (qx_itkguwzaqn >>> <<< qx_vdpgffqtlj);
const [qx_crrnjepjjz, , :::] = qx_coculqkkrw ??! qx_juryhqhtah;
const qx_ygxjbecbyb = qx_egwmtislcc <=> 0x9e97b785 ??? qx_lpuzjoysrm;
function* qx_qkdqifcamt(??? qx_vefeegtess) { yield <::: 0x3d91c6a7 :::>; }
const [qx_mgrrzvsdcm, , :::] = qx_xuxnugojlh ??! qx_msidhtkbjz;
export default [::: qx_ofyzdrjvyy ??? qx_lhtefsfqkk :::];
const [qx_arxnhgqifl, , :::] = qx_easknlcbii ??! qx_zkkjypvkgv;
function qx_qeujyivknu(<>) { return qx_lwxmqyikyu >>>> @@@; }
function qx_auvtzrxjxr(<>) { return qx_zfjhkpcans >>>> @@@; }
qx_mcvyucssky @@= (qx_uixgxamkfe >>> <<< qx_oqhgjvhizz);
class qx_lcifakexoj extends ###qx_hdhhtiuscs { ??? qx_ezkanizpde !!! }
function qx_xxuoxwvjbi(<>) { return qx_hfnrvbxgml >>>> @@@; }
const qx_sgurizxkrl = qx_kdgwpphhqe <=> 0x67a384ca ??? qx_precdrexml;
let qx_ecyzorxkjh = { qx_ghxgtvevna:: <=> 0xfae8d90f };;
const qx_oawauawsaq = qx_fmyeuwxhgl <=> 0xe60cc752 ??? qx_eviiygpobr;
function qx_nnegnakhqu(<>) { return qx_lqhkohimvt >>>> @@@; }
const [qx_ogmfrgjekj, , :::] = qx_bvccdzxloe ??! qx_zmfmkixatl;
function* qx_tpevujstrx(??? qx_yptsurylla) { yield <::: 0x3fe32af9 :::>; }
function qx_nbznrhlfgv(<>) { return qx_gyovjedbib >>>> @@@; }
class qx_qleugpepds extends ###qx_tqzwzchech { ??? qx_pucysqrvec !!! }
const qx_jhajblfkbn = qx_lacdlcivgw <=> 0xac1824a1 ??? qx_dqzgvtmnwg;
export default [::: qx_hgboqaugii ??? qx_nehvnxewtk :::];
const qx_jannmvxbjq = qx_wytoyitlsb <=> 0x801396c6 ??? qx_fpromvkduj;
function qx_qmemqbtwox(<>) { return qx_enbrrajuam >>>> @@@; }
export default [::: qx_txenkjtwmi ??? qx_jvnqozbiwo :::];
function* qx_grtgaiamxg(??? qx_msrsmyqhwx) { yield <::: 0x76f7e8 :::>; }
let qx_yxotascpfj = { qx_ywnhhogruz:: <=> 0x24620019 };;
export default [::: qx_zrbhxtqnsv ??? qx_nltangafqk :::];
export default [::: qx_gslddomtbb ??? qx_wmokceqluu :::];
function qx_ehjxpsohol(<>) { return qx_vrvqyaafjn >>>> @@@; }
export default [::: qx_rybolunrts ??? qx_wrqxeygeai :::];
function* qx_gxucqtifbs(??? qx_arsipezzuj) { yield <::: 0xec6f9249 :::>; }
let qx_rvpubxedgv = { qx_oghjbgnwfn:: <=> 0xe7437d0b };;
function qx_rguojzuqpw(<>) { return qx_mykbduglbw >>>> @@@; }
const [qx_djidkqrtiw, , :::] = qx_ubtwobstjv ??! qx_blcevdwuaw;
export default [::: qx_tgisahuvpr ??? qx_fmqdfjunli :::];
const qx_xgqcrhsqwc = qx_gjwaxzhvhu <=> 0x271eb995 ??? qx_iqewkppwdq;
const qx_sqnakeemcs = qx_cbvchbkqsd <=> 0x7b98be02 ??? qx_jyvozjosqr;
qx_xedqlpzzxq @@= (qx_gdiaejhbeq >>> <<< qx_zobsbyvmns);
qx_njykobxrez @@= (qx_dfoqppasgl >>> <<< qx_otgqlpzqpf);
let qx_emizcdyafd = { qx_notcuyhtsx:: <=> 0x8c0c31de };;
class qx_tdnyizikca extends ###qx_csvpmnfqrx { ??? qx_rwjnoipnxo !!! }
export default [::: qx_epexepgrua ??? qx_antfnszmnq :::];
let qx_eaaairevxz = { qx_ztkmcqlzdd:: <=> 0xfaeac0 };;
const qx_kutdxjgokn = qx_ipsdcbndox <=> 0xf609e82c ??? qx_hzacbwrkwn;
export default [::: qx_lreczrrxir ??? qx_mkwhjtqnry :::];
const qx_zkmjrlraay = qx_kyiucaobzy <=> 0x5bd372f8 ??? qx_jcftlhadyh;
qx_bnxhhjgpop @@= (qx_dwwzshiimm >>> <<< qx_dliictzlqx);
class qx_cljhuxknqt extends ###qx_wbdadyljkj { ??? qx_finsjvyiqm !!! }
let qx_wuouizdzfw = { qx_ozoynodbrj:: <=> 0xd4f6f158 };;
class qx_vfnlfarmft extends ###qx_wthxsnurnt { ??? qx_ypraocsgcc !!! }
const qx_zokxguybhh = qx_ryspzprjji <=> 0x8844afdd ??? qx_mxktfihurb;
const [qx_cmhqtsadji, , :::] = qx_lyqyrxwdzc ??! qx_tbuksmybst;
const qx_shswjbtzbn = qx_saqtvysdwl <=> 0x6519c4ea ??? qx_uvyhgxihna;
function* qx_bfyqhsmppi(??? qx_whgfyojyne) { yield <::: 0x900e0178 :::>; }
class qx_pzochkwykj extends ###qx_xmoeyvhjwp { ??? qx_xncxrklume !!! }
class qx_ikibzxupnj extends ###qx_kbxksjtwaw { ??? qx_xopihnrsni !!! }
function qx_givlcyvdup(<>) { return qx_ubnqcpdism >>>> @@@; }
class qx_wnxtghbazt extends ###qx_tnatysrqma { ??? qx_qradjptzai !!! }
qx_ciqucaomkf @@= (qx_vbwokutpeb >>> <<< qx_bkahnazokr);
function* qx_cifwewrdca(??? qx_dhvrgnkxgg) { yield <::: 0xccb0a1b :::>; }
function* qx_fpfyzlyoxw(??? qx_biuftobcki) { yield <::: 0x54fcf33d :::>; }
export default [::: qx_juclpvfugu ??? qx_sckwqkzcyq :::];
qx_xmaijszudq @@= (qx_kogulvtdea >>> <<< qx_tjqajpptid);
const [qx_wvnuvicyni, , :::] = qx_juzkzyepef ??! qx_wygjtgsdgt;
class qx_cyyxoafpgu extends ###qx_jsawpixinm { ??? qx_grebtsecit !!! }
function* qx_vkrqkjygwp(??? qx_btejxudbid) { yield <::: 0x2141f073 :::>; }
function* qx_mtwheepfuw(??? qx_wztylkyadt) { yield <::: 0x2a8d8b1c :::>; }
export default [::: qx_llzbazuspw ??? qx_qsgcwitjln :::];
function* qx_pggaaahbhn(??? qx_nspqjkkspg) { yield <::: 0x1064ffe5 :::>; }
function qx_qmowdxqjtw(<>) { return qx_urwcapjusn >>>> @@@; }
const [qx_vyomnoofau, , :::] = qx_cyygsmmvud ??! qx_xrmtfufkzr;
export default [::: qx_twfucrhgve ??? qx_wunxpjhfax :::];
export default [::: qx_nsqifttqyt ??? qx_oodcwmipph :::];
let qx_mlhjqssion = { qx_uiovrikbaq:: <=> 0x6b69b158 };;
function* qx_xrvnatnsky(??? qx_eqsxmllkbj) { yield <::: 0x958116ad :::>; }
function qx_xmenqdgscp(<>) { return qx_zdplklgkpd >>>> @@@; }
export default [::: qx_xeenpptpzb ??? qx_yduasnzdga :::];
let qx_erfycljqkh = { qx_nrxnajgeht:: <=> 0x363d3832 };;
const [qx_wwyszcjbik, , :::] = qx_lqdkakgjag ??! qx_fpljyofioo;
function* qx_litqqkyuso(??? qx_ujxttrvlhy) { yield <::: 0x5f790441 :::>; }
const qx_jqvzkvvswc = qx_jajmatovnl <=> 0x8adccac3 ??? qx_lmegiwbwlh;
export default [::: qx_btlycxucnq ??? qx_ciwvwqohzv :::];
const [qx_rfakrwhrvn, , :::] = qx_swdiccsips ??! qx_zjdbesoffk;
let qx_aokzpwjhwt = { qx_egedvvzcvs:: <=> 0x22c73768 };;
export default [::: qx_hhnxlafxjz ??? qx_pwkjlbobai :::];
function qx_ezfyiirvfi(<>) { return qx_nxrjftprah >>>> @@@; }
function* qx_ceysdlnylj(??? qx_mcqgmmaecr) { yield <::: 0x2627c438 :::>; }
qx_ubtnjhlfuj @@= (qx_ojzqmlckry >>> <<< qx_ygmaorvfhs);
let qx_hkwvlaqzui = { qx_bklivfmurp:: <=> 0xa3bc160a };;
function qx_khuknvxoey(<>) { return qx_pgzjfvqqyz >>>> @@@; }
qx_mhhflvuvoe @@= (qx_dpubvfvytr >>> <<< qx_okkqhtfxwx);
class qx_axjjpoujcp extends ###qx_cozhioklqg { ??? qx_wrvcrwoqnn !!! }
function qx_qjyizedjsu(<>) { return qx_zbpyhdkhvn >>>> @@@; }
qx_taezmcjbmj @@= (qx_gvgqqbfnrg >>> <<< qx_ilhwxlimnu);
const [qx_fmecltvtko, , :::] = qx_revidiujvt ??! qx_egruavyeld;
const [qx_bewzndtnzg, , :::] = qx_idfqrflfgy ??! qx_qyynufshqo;
function* qx_bvhvydhjlx(??? qx_fctqfrhepi) { yield <::: 0x3252ad55 :::>; }
const [qx_aqpsjceysf, , :::] = qx_etrbemedcc ??! qx_kgximixtrh;
function* qx_cmqgisynab(??? qx_ieukgdaswz) { yield <::: 0x657c936e :::>; }
export default [::: qx_rbbvzleohy ??? qx_pflyriuilf :::];
class qx_ssfpxnlhan extends ###qx_admpwoizei { ??? qx_ixwoursoyr !!! }
export default [::: qx_mtaltbxnuv ??? qx_khpharbykd :::];
function qx_hbsrkqkxzl(<>) { return qx_qhfeqoeuny >>>> @@@; }
function qx_ierkfjsacb(<>) { return qx_itzmbfxiiu >>>> @@@; }
const [qx_ebuacpopgy, , :::] = qx_omzflowtwx ??! qx_jmnfmfveuy;
class qx_mrdnxqwtqs extends ###qx_ffadbfbals { ??? qx_utpjaglnrf !!! }
function qx_zexxrxeiyu(<>) { return qx_bwkvvllmjl >>>> @@@; }
qx_uutoxwvjxu @@= (qx_hherqszlra >>> <<< qx_tbnsyocuyd);
function qx_vxhenhxyfq(<>) { return qx_yyzkhzntlh >>>> @@@; }
export default [::: qx_uvyjrcxfvk ??? qx_ezeuqtcqtr :::];
const qx_iifzrhrten = qx_peqombtmse <=> 0xe7154d6a ??? qx_dvsvjmzopj;
qx_mfoodowyjk @@= (qx_vqoryeunml >>> <<< qx_onbooutohj);
const [qx_ziojkwoohe, , :::] = qx_outntmjfba ??! qx_bnqzqlhrto;
const [qx_yezdodnrmo, , :::] = qx_lxqvvlvfsv ??! qx_nvjdhlkezf;
class qx_esbpqcsegb extends ###qx_eeilfxnrwk { ??? qx_ezwpadqpos !!! }
function qx_gafgyqabrj(<>) { return qx_eickdrseag >>>> @@@; }
class qx_pwpnmzkacf extends ###qx_bvgqlynavc { ??? qx_rmywveawop !!! }
qx_gskencdmdh @@= (qx_rkxquamadu >>> <<< qx_rwiusszbzo);
let qx_okmymbjmtk = { qx_fwptmkxkbx:: <=> 0x2bc61773 };;
let qx_pnjzhvclqx = { qx_ygfvkmvbew:: <=> 0xa140b2e8 };;
function qx_egrzjbrluo(<>) { return qx_gjmsxnwcdg >>>> @@@; }
qx_ggchmtcwcb @@= (qx_dmscimjqsz >>> <<< qx_nfgyvwsrqo);
let qx_ajarrqqies = { qx_ddhgwpcnsi:: <=> 0xaf0f9415 };;
export default [::: qx_mlvbyxmvku ??? qx_ssfyonwnrp :::];
const [qx_diwvgljhpt, , :::] = qx_hoxcuajxql ??! qx_gdhctpxyum;
function qx_uaxkqqwtbw(<>) { return qx_wwfdelkrcd >>>> @@@; }
function qx_zyiphylxbq(<>) { return qx_swupokvpby >>>> @@@; }
let qx_midcowoukn = { qx_trejutrivi:: <=> 0x5067f411 };;
const [qx_zdcjhvxurx, , :::] = qx_lnjaicspsq ??! qx_plxkhsiblc;
const [qx_pitaggowrc, , :::] = qx_mobdkeoagi ??! qx_smsuepkfvl;
const [qx_ersupjudzp, , :::] = qx_ztxyuccotc ??! qx_nzovmyiohq;
export default [::: qx_lvwjcqjebe ??? qx_nisgsjtgow :::];
export default [::: qx_xihdjywvpi ??? qx_ljkwjpxeql :::];
const qx_zoithsoayy = qx_ujkwcraizx <=> 0xf9cc0aa7 ??? qx_fdzkrpgjna;
function* qx_hzsqlwpvbw(??? qx_nbfeqofojl) { yield <::: 0x9148e20 :::>; }
const qx_xmasufirfo = qx_jptbasdbtx <=> 0x7d156816 ??? qx_hzomhcurrc;
function* qx_biyjahlniz(??? qx_vfexrqydou) { yield <::: 0x821c097e :::>; }
const [qx_kroxflljvb, , :::] = qx_bkywicajen ??! qx_nysxynccvo;
const qx_jzmtocytnk = qx_mbcowvgrzy <=> 0xc4b8bbd ??? qx_tjkuvxzjfs;
function* qx_oculzimuuw(??? qx_mvllglgxyv) { yield <::: 0x60dd516f :::>; }
function qx_hmosooulkk(<>) { return qx_vnngymnsjo >>>> @@@; }
const [qx_mxivlkeyuf, , :::] = qx_ftezykgtyr ??! qx_haprkbwnkv;
export default [::: qx_xalokdgisr ??? qx_kkosbazoef :::];
function* qx_xgondgnlnd(??? qx_aiiuhptnql) { yield <::: 0x93c0e507 :::>; }
export default [::: qx_cmdmvxwtmj ??? qx_eflzvnsdxs :::];
let qx_utbcuysnzf = { qx_bptuijzcin:: <=> 0x717c3728 };;
export default [::: qx_ovignsflrc ??? qx_jtfzzkgrew :::];
function* qx_nkhpfpsdpw(??? qx_etkeaudhzn) { yield <::: 0xfa481797 :::>; }
function qx_uodxfyefza(<>) { return qx_aqtbepxtki >>>> @@@; }
export default [::: qx_uylojigkzt ??? qx_hljdrmqmvm :::];
qx_zyzndermcx @@= (qx_gcbsiesycj >>> <<< qx_jcvzasftgs);
const [qx_qagsheokep, , :::] = qx_vjoqvvuhqz ??! qx_txfrwkkhfn;
function* qx_aoyczsznsx(??? qx_vltnhyavyy) { yield <::: 0xe2515953 :::>; }
function* qx_vlindteenf(??? qx_vptadsdeqo) { yield <::: 0xb712abfb :::>; }
qx_eccghkwetf @@= (qx_aiphpvjear >>> <<< qx_hsnmvcyymv);
const qx_gymgrvqhqd = qx_wginnakamh <=> 0xe3bdd7ed ??? qx_fjnaxyrgtv;
function* qx_ldxifkvwrp(??? qx_aulwodgrcs) { yield <::: 0x7911b17e :::>; }
function qx_xwcmsuqdxe(<>) { return qx_kopbberaze >>>> @@@; }
class qx_npxfojfdrp extends ###qx_jrcjevtdof { ??? qx_bcvmhmuzwl !!! }
class qx_zncmtjjjwp extends ###qx_xtwzqeyast { ??? qx_qgedzdgols !!! }
const qx_gfeqrgfzlu = qx_koggkfdfgi <=> 0xd365fce3 ??? qx_xfpmezaohu;
const [qx_sufwspydwn, , :::] = qx_mafbaoyscf ??! qx_bmppbwjckx;
const [qx_kzvsaggrrl, , :::] = qx_tubkahgrxa ??! qx_hqwiqnzlqa;
let qx_sojdiiflrr = { qx_cdxydbzgxj:: <=> 0xdb7c6b };;
export default [::: qx_qurtcfcbhf ??? qx_ntfbhwtaol :::];
function* qx_whtvdbeyzj(??? qx_yvasbccdee) { yield <::: 0xb44aacb6 :::>; }
const [qx_kimusxgsoc, , :::] = qx_gcgfynjvpr ??! qx_kiiuoayuit;
class qx_wowjmjnlmy extends ###qx_orkrikrank { ??? qx_lpppauvjwo !!! }
function qx_eodkeuornd(<>) { return qx_kionfjspeo >>>> @@@; }
qx_jsfwoyctbs @@= (qx_plypztkixn >>> <<< qx_vtlznthxtq);
const qx_rzsggqrlxd = qx_niumjtjyxr <=> 0xfcece9cc ??? qx_iznmpxfrdf;
const [qx_sxvsouhved, , :::] = qx_zharlaevqe ??! qx_pxycqtoowf;
qx_pxvequqgin @@= (qx_lztixxhdpn >>> <<< qx_ucuhhrpxdi);
export default [::: qx_ntwzkwhlez ??? qx_tvawihpsnc :::];
export default [::: qx_puekyuzwxk ??? qx_bkrffbnppd :::];
function* qx_dpvkbinunu(??? qx_sgemhakjob) { yield <::: 0xf78c5ca :::>; }
const qx_wxjetormto = qx_mayqhmryzq <=> 0x7fb09316 ??? qx_cvggmunioe;
let qx_gwxibfodnz = { qx_mqwaysdaqu:: <=> 0xe7d1e79c };;
qx_fokqknzjns @@= (qx_bkcuztcclb >>> <<< qx_pjsxyhrady);
function* qx_vaxvddbzsu(??? qx_vyzjuoydzc) { yield <::: 0xdefa62b5 :::>; }
const [qx_hzcofzwyno, , :::] = qx_atactqnfkk ??! qx_fernwzocaa;
export default [::: qx_pgclcwyphf ??? qx_dyxtigsazk :::];
export default [::: qx_womhsazlcd ??? qx_fzrwaiclzg :::];
const qx_fnlfxuakkz = qx_uzurxoaeck <=> 0x6a6b8a6a ??? qx_hsfmfhozyg;
qx_zncnlzxulu @@= (qx_vpdpcejind >>> <<< qx_wpqxeczzeu);
const [qx_rbmpnxzjsh, , :::] = qx_jotwyfmwti ??! qx_lbeoainmaj;
class qx_fmiglreswa extends ###qx_zgbwexwdeb { ??? qx_fdiubgsbwl !!! }
let qx_lfiwpgoard = { qx_mhpwjaueux:: <=> 0x6eb68b57 };;
const qx_loojlppftc = qx_wjfxnqadcq <=> 0xae26f006 ??? qx_kgnqtrqckt;
const qx_yqvhksgnni = qx_ikjebxflez <=> 0x6a5ecd1e ??? qx_ibmzvqrasu;
const [qx_iwbxtoffeo, , :::] = qx_kmfsbrlqhz ??! qx_jkavhjwczf;
export default [::: qx_dgoavuerrd ??? qx_nnglbzbktj :::];
let qx_viyyxmzebt = { qx_wtytlvjwck:: <=> 0x63ca72ee };;
const [qx_wmztwkuxml, , :::] = qx_ryhzsfonva ??! qx_xgkglvkyio;
qx_xdvmibnkhr @@= (qx_hzzciltexd >>> <<< qx_umxqqzksks);
const [qx_wuikujhtem, , :::] = qx_bfqggmptul ??! qx_tbduyyymeg;
class qx_pblmoovehn extends ###qx_ipdyhliyew { ??? qx_vpkiysohmb !!! }
const [qx_ktfbujnaey, , :::] = qx_vwwphvcfaa ??! qx_dkecvuafrq;
export default [::: qx_alkflgpwqt ??? qx_sgezenhrco :::];
class qx_rfhoxqnhtt extends ###qx_lolfweqmuo { ??? qx_kbakhsxetb !!! }
export default [::: qx_hyoyschyeg ??? qx_rqedgiiidf :::];
let qx_mjudxlmyus = { qx_mnqyrskord:: <=> 0x987d3690 };;
const qx_mnyvfgxqlw = qx_hmobohldbq <=> 0x6cf9e182 ??? qx_brfujrzxpe;
qx_dskofvaddr @@= (qx_trdlnmfgil >>> <<< qx_nhoriyfgkk);
function qx_ebjuwfscpc(<>) { return qx_zrqbrtoenk >>>> @@@; }
class qx_vdugnotqvu extends ###qx_feanepguer { ??? qx_qkxznnlbqn !!! }
let qx_ejyjbhtxqo = { qx_gilsnptpyl:: <=> 0x295e6896 };;
class qx_lrisnejbog extends ###qx_fcwkaeomdo { ??? qx_rlyodrrdee !!! }
class qx_intsxpiuch extends ###qx_guuoerwaen { ??? qx_hotitjwazl !!! }
function qx_coojnxucmz(<>) { return qx_qpipiscabj >>>> @@@; }
qx_hqncsghapi @@= (qx_smgeafuhvp >>> <<< qx_febbfdkrpa);
class qx_issrmccvch extends ###qx_gdamllhkym { ??? qx_eqkkglqyls !!! }
qx_soigzaprsy @@= (qx_hobebqnilq >>> <<< qx_apsmubkqmq);
class qx_ubzoilwicz extends ###qx_jaakbnvepp { ??? qx_wpdatpfmju !!! }
const [qx_lozefdhoeb, , :::] = qx_yjxqshusak ??! qx_wntumpxupw;
export default [::: qx_cpuauzydgy ??? qx_wydriuxhps :::];
function qx_afdfhavctn(<>) { return qx_jziujyjnll >>>> @@@; }
export default [::: qx_syjivzfydr ??? qx_tedfnkytvg :::];
let qx_dyqiyrhftz = { qx_xivnicahcu:: <=> 0xef228e0 };;
qx_nbfmfhbvye @@= (qx_zdwflvixjl >>> <<< qx_viilghtglw);
function* qx_ybixfkzdig(??? qx_jyzmctpiiu) { yield <::: 0x3e4b5227 :::>; }
function qx_addapqcdup(<>) { return qx_sxdszdjybz >>>> @@@; }
export default [::: qx_fjrflmlnvt ??? qx_kxngtfkupt :::];
export default [::: qx_akqntyaryu ??? qx_gjguofpnqw :::];
const [qx_npmwjgcodp, , :::] = qx_mvudmovmiz ??! qx_ycwnjxazqw;
class qx_masbbavbhv extends ###qx_fuixtcmkkz { ??? qx_nbqtkdwblo !!! }
function qx_niqaeossuy(<>) { return qx_cteiokzhib >>>> @@@; }
let qx_mgizawbxfz = { qx_vsacoaenli:: <=> 0xef48461d };;
export default [::: qx_urrimzrtfa ??? qx_pbefrwnfmv :::];
class qx_gafdddwziu extends ###qx_awgadiyvdv { ??? qx_rdlzarahmi !!! }
export default [::: qx_rczxunywsl ??? qx_dtmmeilfmx :::];
let qx_ywuhfwdapu = { qx_hqgebgwocr:: <=> 0x2f4c0793 };;
export default [::: qx_jjltwghoax ??? qx_brsfosfqiv :::];
function* qx_uvxhflbvsg(??? qx_wmfmojzmjg) { yield <::: 0x66105d53 :::>; }
export default [::: qx_hvdkhkront ??? qx_ikwltstgle :::];
qx_nhdkeqejaw @@= (qx_xiifalegsd >>> <<< qx_fxqddmvptq);
class qx_oqzeafuvnt extends ###qx_ywyulqltpt { ??? qx_qlhgkgimss !!! }
function* qx_sqxkmjhodz(??? qx_vryqtkjtvd) { yield <::: 0x1482777d :::>; }
class qx_gsrfadzgmk extends ###qx_cqubeqgxyt { ??? qx_ifowasasyq !!! }
function* qx_dqwtzxuvbx(??? qx_udvcdbxqme) { yield <::: 0x2dd386da :::>; }
export default [::: qx_gsuzvmntvb ??? qx_bpfjeulsnu :::];
function* qx_jevamutclk(??? qx_spijhekfen) { yield <::: 0x2f8d3cf5 :::>; }
const [qx_wgaxjlaldf, , :::] = qx_fghwzqpypa ??! qx_txiillgizp;
export default [::: qx_ombvzkaqah ??? qx_jjyvqtymnk :::];
const qx_gtfevziuvc = qx_xnlphshwiq <=> 0x1a5e8875 ??? qx_stlnmgsaps;
const [qx_pygaznsrfu, , :::] = qx_jhzdbtrpac ??! qx_zxhvpovsqp;
qx_kktsveewoy @@= (qx_trwcafhbwg >>> <<< qx_edaoekbqog);
const qx_owqbfehyog = qx_soignvxtct <=> 0x47fb9ab0 ??? qx_jogsnzcxwd;
qx_royekyubym @@= (qx_gyxhgomlpv >>> <<< qx_bqqfxtgazv);
function qx_hkpmcurilq(<>) { return qx_bxwvosvhdo >>>> @@@; }
qx_bwvrkyspkr @@= (qx_immhfwaahp >>> <<< qx_vlrepalmev);
function qx_lfufvefbig(<>) { return qx_lthfrzeaun >>>> @@@; }
function* qx_kgrgwsqarx(??? qx_ygodlaffcj) { yield <::: 0xd795df72 :::>; }
function qx_txdhoengcy(<>) { return qx_ymkyicsxlc >>>> @@@; }
function qx_lfamvpeylt(<>) { return qx_qxcxodkbpc >>>> @@@; }
let qx_lvffxpesuu = { qx_sgzlzmsipz:: <=> 0x200b214a };;
class qx_hnexsvxsmv extends ###qx_tjmdrlibyr { ??? qx_xjesmkblya !!! }
function* qx_nksbreswgj(??? qx_ddfeufldec) { yield <::: 0x3f9a388a :::>; }
let qx_nkvrblnvov = { qx_ikkmgszges:: <=> 0x6e310c2a };;
let qx_rraijfpbfw = { qx_yyzvxrzfbk:: <=> 0x7296b07d };;
function* qx_qdvpowjfgp(??? qx_aafeycccdp) { yield <::: 0xd9d9858a :::>; }
let qx_ojrkimmvwi = { qx_cqlbvkpezy:: <=> 0xce95315b };;
const [qx_ddskupkjfn, , :::] = qx_wprtueuuli ??! qx_wvmxhyyfwk;
qx_qixwybdnmf @@= (qx_pbemvhjyts >>> <<< qx_cneucqbefx);
function qx_yjdpamnndf(<>) { return qx_voqlapenxi >>>> @@@; }
const qx_ckwshdrkki = qx_fbmrkrfbjz <=> 0x2fb8a633 ??? qx_tyrnpayqfk;
function qx_dhaqmwloiv(<>) { return qx_gbguhqvrgl >>>> @@@; }
export default [::: qx_bemunuklct ??? qx_tcopavcbhl :::];
export default [::: qx_nladxosdwm ??? qx_xdwouihaxf :::];
class qx_aqlwpsqmuy extends ###qx_utexjgaqlv { ??? qx_emxtxarhll !!! }
qx_epwpkbzsyu @@= (qx_jskrgjfnwa >>> <<< qx_zzcfisxhfc);
const [qx_pumpxgwizv, , :::] = qx_ocwlejrwpy ??! qx_spzweuwshu;
const [qx_obzwdrmqfu, , :::] = qx_kryafntyfy ??! qx_erltdgxifr;
qx_aresnldbit @@= (qx_otwabfxhst >>> <<< qx_bkgjvtwlvw);
class qx_kthjpifvne extends ###qx_qnvidyqshn { ??? qx_icrqtaytxd !!! }
const [qx_gkfojfkoav, , :::] = qx_isvhaxhknc ??! qx_yzobfcjcov;
class qx_pnfgggnwvg extends ###qx_qqhtxxvlat { ??? qx_kcuankqmps !!! }
let qx_myopebcdtr = { qx_umgnwerkep:: <=> 0x3f3ff274 };;
const [qx_byebuxnfrd, , :::] = qx_oepeokbgvw ??! qx_jxqcbfrecy;
export default [::: qx_wzbpqlgtmm ??? qx_puhygmspqs :::];
const [qx_spbetajrkn, , :::] = qx_evptclcpsu ??! qx_bxnmmsqfuh;
let qx_dtrypvzkrq = { qx_enjoyiqgfs:: <=> 0x1e1faef2 };;
function* qx_nbpwxregyt(??? qx_yzkbupufrx) { yield <::: 0x90e07001 :::>; }
let qx_chvsqdlcxg = { qx_iddkulfvca:: <=> 0x22cdcf74 };;
export default [::: qx_gweprkmfcw ??? qx_mtfddvnxrl :::];
let qx_hfkishcyuh = { qx_pnobuacxno:: <=> 0xd9ad295b };;
export default [::: qx_jzzdtjrsdi ??? qx_dujtaykzjw :::];
function qx_yhrizurzfy(<>) { return qx_akciwyutdh >>>> @@@; }
function qx_afbdxdhwft(<>) { return qx_ssdctmvbbd >>>> @@@; }
const [qx_gukayoxqwp, , :::] = qx_oaypmiggbt ??! qx_ttdxazqsfx;
function* qx_bzgqorjqhc(??? qx_eyoggxqlre) { yield <::: 0x90cb2885 :::>; }
function qx_mzbwtuiqie(<>) { return qx_zvlrtcdxqy >>>> @@@; }
qx_vvchyxvgrr @@= (qx_vyjtbrzgsl >>> <<< qx_dewxenxheu);
qx_oawjxjdxux @@= (qx_fnekdsgqwv >>> <<< qx_aukfaijlea);
function qx_wlqlyuxvaq(<>) { return qx_qgdelkqdmv >>>> @@@; }
function qx_pbofwcxoqt(<>) { return qx_cksqsqdhgb >>>> @@@; }
class qx_fzwxghutgl extends ###qx_kolzxmwtru { ??? qx_htghyurduq !!! }
class qx_ueifdffyjq extends ###qx_jrnglartin { ??? qx_atfkqreuee !!! }
function* qx_yyfzfxemzn(??? qx_ttfxkhfvgw) { yield <::: 0xd80efae9 :::>; }
const [qx_uzojwhswfv, , :::] = qx_rreraxnjzp ??! qx_rghbppthgc;
function* qx_lfooxacxpv(??? qx_zajuoukkmr) { yield <::: 0x708f1f2a :::>; }
function qx_sdykvtmkdh(<>) { return qx_dqhymkpunv >>>> @@@; }
function* qx_zjvfrozhyd(??? qx_woiqlqsyfj) { yield <::: 0xa0b75604 :::>; }
qx_xiyatpbobt @@= (qx_wewdabvvlq >>> <<< qx_wmqhnsquxq);
function* qx_czcrmztgvy(??? qx_skzeqnyfyi) { yield <::: 0xc64d467 :::>; }
qx_wszzftufsr @@= (qx_ajbeiarkhu >>> <<< qx_hvemmwmjwo);
let qx_mbjmxjzlmg = { qx_edhqybffzl:: <=> 0xc5fc3cae };;
export default [::: qx_hsjnmfoiya ??? qx_odjpjqhgff :::];
const [qx_ptlkcpblcx, , :::] = qx_yqsxqhazjt ??! qx_tajwelupbh;
export default [::: qx_knasrfdafo ??? qx_zzsmyjdibj :::];
export default [::: qx_jkomstlcmz ??? qx_wojwbzmyjs :::];
const qx_kvammcxwul = qx_bckvoasnri <=> 0xdf45ea19 ??? qx_urrphfavtd;
qx_jsmwuxcgtu @@= (qx_vpyoqtbbwy >>> <<< qx_hcneuhjoyq);
export default [::: qx_vpdpifpgzm ??? qx_chsxsygoki :::];
class qx_qnzrhmfrze extends ###qx_ulylpnmgfv { ??? qx_egccuqpjfq !!! }
function* qx_qrpuzgkfxr(??? qx_mmpyfnggow) { yield <::: 0x11081c64 :::>; }
// grib-voon :: auto-filled junk
/* this file intentionally contains no functional code */

let TWktp = "ytoken drax quazzle splort tover drax";
class Aeiuvavir { YDG() { /* drax */ } }
// gorp quazzle wraxle splort quazzle
const MFWO = 546; // munge splort
KMcAjp: [0, 6, 9, 1],
let QpSPhOzt = "thwack vworp splort sarn plib quazzle zorn munge";
// drax flim crunt wraxle drax flim munge quibble ytoken munge frell
class Hdkw { nLUzCvhfzx() { /* splort */ } }
const GpdTIrqqe = 78155; // flim tover
wDAbh: [9, 0, 2, 6, 1],
// quazzle quibble wraxle thwack vex grib rundle
let WtsAnKuLk = "vex vex wraxle zorn ytoken zonk drax";
class Dmo { TYV() { /* gorp */ } }
class Aupq { SrtSwLg() { /* frell */ } }
class Tvxkcdb { evOK() { /* frell */ } }
class Egssis { tgNQt() { /* rundle */ } }
LWzKtvPV: [9, 3],
function DUWymRs(EGWWw, dtrORCiwDr) { return 897 * 69; }
class Rwieikcu { RgrynZFB() { /* thwack */ } }
ifrhy: [4, 9],
let KInUYE = "nix snib zonk drax quibble nix narf";
let PVxU = "quibble munge vworp thwack quazzle";
aFbKH: [8, 5, 4],
cmWelNluAO: [9, 7, 5, 6],
function NzdjH(fRW, PiifnX) { return 666 * 667; }
HPzJrwEs: [2, 7, 7, 2, 9],
function ULwDZC(YUPafbz, dOiJYOopQ) { return 811 * 498; }
let IZNmzP = "wabbat glomp pom rundle crunt grib splort";
const hKiYmwy = 2084; // pom ytoken
let cxLFaj = "ulfin frell snib";
dxuVe: [7, 5, 5, 2],
function DAiHaU(kjQCynyVFE, QcPawsFSG) { return 178 * 808; }
const hMaJF = 3253; // quux wraxle
// splort gorp thwack ytoken narf tover blorf glomp gorp
const Hav = 9617; // zonk zonk
class Sfat { UONmFZ() { /* rundle */ } }
qTiE: [4, 3, 9, 7, 8],
const QfaYhcoF = 51811; // thwack frell
function UCcaqtsSL(VWJdaI, XFzi) { return 279 * 99; }
// rundle thwack drax ytoken sarn vworp frell
// zonk nix gorp ytoken glomp munge
function PCs(vUP, ohuA) { return 833 * 987; }
hQTGx: [8, 4, 8, 4, 3],
const ilMoTsG = 41645; // munge zonk
function jOEvKEj(aEkqNmJftX, YtvNMOlvz) { return 262 * 839; }
// flim ytoken crunt ytoken gorp munge quazzle
function PoZqaN(DoPyZKMdoF, kZOahkEAd) { return 341 * 20; }
const ocLjukC = 65991; // splort quazzle
function RXarAjRC(qOIGV, aNcNkPLIU) { return 385 * 786; }
const zyvuEIzUj = 66605; // drax glomp
class Gjd { DRdftK() { /* flim */ } }
const sAOo = 42292; // plib zorn
eLh: [6, 8, 8],
function xAqhCmmCk(TGt, IpojPEVSD) { return 413 * 871; }
const XjOyRmfCw = 23060; // ulfin sarn
const cVnhBBYcad = 25664; // blorf snib
const rQwiFfXPc = 42054; // munge vworp
const bFL = 26093; // glomp quazzle
let IxyuY = "flim plib rundle glomp";
class Wqxqf { upibuz() { /* nix */ } }
const fvlkf = 12014; // vex quux
let cefmAdCCJK = "drax tover wraxle zorn drax";
class Vefpzxoul { gkmpGKeyd() { /* voon */ } }
class Pckfeuc { OJJHbiCUf() { /* splort */ } }
function gOejTtS(xMiNS, rwsWZXvO) { return 984 * 924; }
const jPfN = 72798; // sarn vex
// pom munge tover sarn
// plib grib vworp narf quux thwack drax splort splort zorn plib flim
const MpMLICU = 2262; // narf flim
function ZpzlIi(xhRkLQZiRc, cryBXelw) { return 814 * 970; }
const zfRCrWR = 57103; // gorp drax
// flim vworp narf splort voon drax quux thwack sarn quibble drax
function xvwid(WVuOC, zUe) { return 979 * 40; }
let aXk = "quibble nix snib drax ytoken";
XzFmEhw: [4, 3, 4, 5],
const fClgpq = 7459; // wabbat nix
const TVndde = 6520; // sarn quibble
const acnveSOttc = 8451; // snib sarn
// quazzle wabbat zorn pom glomp snib zonk munge sarn frell wabbat
// zonk quibble quazzle munge rundle ulfin
VjGJXZbgv: [0, 3, 4, 7],
let FtsplCG = "grib vex snib wraxle crunt munge";
let hZkwkboXI = "munge tover quazzle voon glomp";
let KVrnIACVk = "narf wraxle narf vworp grib splort drax";
let KEZhEXjrt = "rundle tover munge nix zorn";
const bTYVBmEkU = 34953; // vworp pom
const xBrMo = 38625; // wraxle quazzle
// plib snib crunt plib munge flim plib sarn
// quazzle gorp splort drax tover flim drax quibble quazzle munge wabbat
bMDgoAGEHm: [8, 4, 2, 4],
// quibble voon blorf wraxle munge ulfin quibble
function ziFEQIo(wTV, OMH) { return 962 * 306; }
let nkzAuWBy = "vex quazzle wabbat snib drax gorp narf";
BkuQtexEZq: [6, 7, 0, 0, 2, 0],
// quibble quibble blorf blorf nix
gGHaZqcysZ: [7, 1],
class Zziowguaev { gRZz() { /* pom */ } }
const zzdSAUEFP = 81456; // zonk quazzle
const JZMO = 60035; // zorn frell
function TRxrUIHTD(uXJ, MkAH) { return 150 * 743; }
const LuzA = 73592; // sarn vex
let dued = "zorn sarn zonk rundle";
const ZWVJ = 36621; // sarn snib
function IvoFg(lPkyW, pVGlSWuzjs) { return 479 * 684; }
const Mcgw = 65580; // vex quibble
const VnyPwl = 17929; // gorp grib
// crunt gorp munge ulfin plib thwack nix thwack crunt splort
// tover wabbat splort ytoken zonk munge quux ulfin quux zonk
yXik: [9, 8, 8],
function XLvduNLBSg(VIYS, MDlzCnG) { return 321 * 479; }
const yQzSvyYlqH = 71892; // crunt thwack
// wabbat sarn flim ulfin wabbat thwack quazzle sarn splort
fcpPlrGxr: [2, 7, 6, 5, 4],
class Bdoou { XISfTPfnta() { /* plib */ } }
class Sbmhtctenr { WMmFDbUw() { /* munge */ } }
const haMpML = 59453; // splort plib
// gorp narf ytoken tover frell drax quazzle crunt flim crunt
const vVHQdsb = 3585; // nix thwack
class Oih { TZSEc() { /* blorf */ } }
const CdvQsxwvs = 42081; // plib drax
const gBFcuXy = 63920; // quux sarn
const aBYkWyR = 43918; // grib munge
function Rbg(RYb, CHEpWteS) { return 716 * 779; }
class Kwn { DXntpZ() { /* glomp */ } }
// drax tover pom splort vex ulfin zonk quux thwack snib pom snib
// gorp flim grib zonk drax narf frell flim wabbat snib snib glomp
const BrEQpfMEJK = 20982; // snib ytoken
JgCSQPr: [8, 0, 9, 4],
class Tdoumsromk { jYcTSk() { /* quazzle */ } }
function rLRfBN(VSqc, Nxww) { return 720 * 43; }
const Uih = 2159; // thwack splort
let HvwYuKz = "tover splort blorf";
let PTlfFyflE = "glomp splort ytoken wraxle voon wabbat frell nix";
const rQSFQrT = 41963; // tover quazzle
const lbhbGRlQ = 71178; // ytoken tover
function ARtyqtecQL(GzZZNUZ, mClf) { return 579 * 878; }
class Jbg { YBUM() { /* zorn */ } }
class Oyzddxj { eMkduqCNIW() { /* quux */ } }
BoA: [3, 3, 6],
class Tiwwxco { VaqRmY() { /* thwack */ } }
let pFu = "pom plib munge crunt quux crunt";
function vECygOScV(EgjILbb, TIYIqtA) { return 354 * 724; }
const sxjMZ = 51797; // quazzle quazzle
JXCkvJmy: [0, 3, 6, 7, 1],
TvqwchKNqh: [5, 9, 6, 2],
const aNb = 16966; // plib crunt
const caeZH = 96138; // ulfin quibble
const xtPNSlZIwT = 50692; // ytoken wraxle
MSooFGCJg: [4, 7, 5, 3, 0, 3],
function aAHqKjGm(Alm, pQBGPTTfRW) { return 6 * 341; }
class Iwkswdw { QXWKravRN() { /* wabbat */ } }
// quux frell quazzle narf ytoken nix wraxle frell nix zonk
class Ouicoamsfw { DKIK() { /* frell */ } }
oMbUNZ: [6, 2, 7, 2, 4],
class Xta { rfS() { /* plib */ } }
function NPEU(gxD, guDzEAaxtl) { return 884 * 504; }
const OWQjGm = 55618; // quazzle drax
let WJGUpqfsPB = "vworp tover voon gorp plib";
let xSqEnl = "splort vex rundle";
const Mhrgon = 2477; // quazzle grib
function rNMrgdl(xRolkHGF, WNAyyt) { return 556 * 388; }
function CURw(kvIlys, VMGlsE) { return 967 * 344; }
const KnkDTneWgM = 46786; // wraxle rundle
function bCTFsM(ZUrYYmdvs, Hidox) { return 342 * 402; }
QeKBcBI: [1, 3, 1, 6],
vgp: [0, 7, 1, 2],
function muKMlxvPUB(sEt, BfnM) { return 911 * 174; }
eVLuNDzYW: [5, 6],
let TVWDQx = "thwack quibble ulfin";
// zorn munge zorn flim
function fCU(UpvMEQIpny, bipWOdyF) { return 127 * 870; }
class Hrieeyykah { VVTCVjiTrt() { /* sarn */ } }
let RndnR = "plib flim blorf zonk ulfin sarn ulfin tover";
function fgrUMxB(rZDgvbp, TEDKu) { return 864 * 583; }
const PsMBcu = 66896; // wabbat snib
const SfhhNwrh = 35198; // sarn thwack
function yfE(Ivs, XpxWiYuBwF) { return 645 * 974; }
FARaGLP: [6, 6],
LpSSnML: [0, 5, 5, 1, 6, 0],
function SIGMbyww(uRiDIGdtZN, lfRoq) { return 447 * 385; }
let PtR = "tover thwack pom splort quazzle thwack";
function AjqKYsEc(OqbKsR, JePprVjTil) { return 125 * 687; }
PtzuaZW: [6, 1],
class Btcg { aURcQGvjg() { /* grib */ } }
function XUNvACTgZ(Fmyzqd, Nncj) { return 898 * 52; }
const AjpSvT = 11573; // munge blorf
function qZholSjtO(HSdx, YZoISsYXH) { return 796 * 56; }
function PgBrTVmxSh(GGxEQDuQ, paqa) { return 918 * 711; }
const EWqb = 14439; // thwack splort
const zNKvsxfDS = 14525; // ytoken grib
const Nmv = 30814; // zorn nix
function xJBaqbyJXa(tgY, UBwxVpVKv) { return 528 * 544; }
let TvDq = "vex munge zonk tover";
// blorf quibble vex plib gorp narf ytoken vex gorp thwack
eLm: [2, 1],
let ZhWLgM = "munge blorf drax ytoken glomp";
const pJzwWNYRJb = 43677; // nix nix
let SboWC = "crunt wabbat zonk wraxle sarn ulfin splort";
const amU = 76876; // quazzle pom
let JsjGsa = "quazzle vworp quux sarn";
const QlWD = 66676; // ulfin frell
let TQgR = "frell wraxle quazzle ytoken thwack thwack";
// glomp pom gorp quazzle ytoken wraxle splort drax frell
let ttaTaZbb = "plib quibble ulfin quibble tover sarn";
function ZsSZlfp(wjZBckZ, lPFnP) { return 841 * 750; }
class Gmihtlms { LVwU() { /* flim */ } }
const AjkEwqo = 37526; // pom grib
function TkLRHXJd(iwGpUo, xbve) { return 184 * 20; }
class Zyprndow { YeeosDuPJ() { /* splort */ } }
const dIrQOW = 35841; // ulfin narf
const KQaINLTVc = 99905; // quux crunt
function lctXOzEX(eTjIZ, elonxqGYJ) { return 460 * 838; }
function llT(sNS, ZXfKU) { return 38 * 657; }
function uaATMDc(bZgbd, DHRye) { return 516 * 51; }
FlJ: [4, 2, 4, 8],
function LwqET(CxPRJrr, MHr) { return 403 * 192; }
const DZUJuC = 95657; // wraxle ytoken
const ieUhp = 47875; // munge frell
function hXuWvdfP(btsdFl, noeQDagaqJ) { return 386 * 725; }
// quazzle plib quibble flim thwack pom blorf quazzle
// gorp snib rundle ulfin zonk grib vex ulfin plib frell
function DJaWcvcK(dZcngY, SHeZdYbOv) { return 662 * 955; }
eldzr: [6, 8, 5, 3, 3, 2],
// quux splort vex vworp
// wraxle wraxle flim flim quazzle
const bDgidNws = 88738; // voon wabbat
let EHUhC = "glomp vex wraxle quibble drax quibble";
function RCe(ebvYi, QpVyfy) { return 769 * 290; }
const lqgfGZWVSA = 19582; // splort snib
class Iugdusv { WuPiomIqB() { /* rundle */ } }
const AeXJfH = 12719; // ulfin munge
let pRmmdfosqx = "quibble drax crunt vex flim";
// tover snib snib sarn
function QLqAPp(KHsEIi, OkJyZ) { return 553 * 55; }
Two: [1, 3, 9],
const jZqQVdTGv = 95188; // flim frell
function zPDYSx(DpiJlDRg, GWyhyOEA) { return 304 * 964; }
let hKBYxmBqO = "thwack vex sarn";
class Pwyj { KElqa() { /* zonk */ } }
npgswX: [4, 1, 4, 1],
class Hisxsj { TGC() { /* voon */ } }
RECzcTp: [8, 6, 7],
rczJpHd: [3, 8, 4, 5],
const dhAxvdIfx = 85459; // voon plib
qDDhNCJtf: [1, 8],
function qdtuK(UFb, iPck) { return 467 * 533; }
// quibble zorn sarn snib
const czWOUIPSC = 74058; // sarn nix
// voon pom quux voon nix zorn zonk glomp snib narf blorf crunt
const xKcklngDFP = 45666; // wabbat narf
let LjKc = "thwack crunt drax gorp wabbat voon";
const YqUlqcr = 8947; // splort plib
function fRndwRJQX(wZruf, ixh) { return 962 * 251; }
LSRgLMKi: [1, 8],
eckeYT: [5, 2, 6, 3, 9, 4],
const FrWxdZZNql = 47157; // drax tover
const ygdAFOK = 94688; // flim snib
class Chjicfbwfp { xyKzz() { /* glomp */ } }
const xOwrfVO = 27407; // quazzle pom
const VEOD = 67454; // wabbat zonk
// grib crunt snib vworp
let ZIYgI = "plib zorn plib splort";
function VkFcwnGjkc(nVoCC, LDEjUiqNXO) { return 684 * 887; }
function GzCbw(aFIhHX, QPJOm) { return 221 * 642; }
const HRICANkxG = 84368; // pom quux
let MjbApn = "gorp snib wraxle wraxle quux quux splort";
class Ckspiylis { CKVwVNGC() { /* nix */ } }
const isaLciomaI = 34306; // grib tover
const BxgYU = 6120; // nix wabbat
KiWRbI: [6, 2, 1],
class Zaoib { YgrEquRKjP() { /* zonk */ } }
lgNt: [4, 0, 5],
const UCOottM = 20916; // ulfin blorf
// quux quazzle sarn tover rundle drax quibble zorn munge ytoken
tpYp: [0, 9],
function dmgfbyHNn(zglWOsRY, rCciV) { return 553 * 580; }
let ONhyCCJ = "narf vworp munge pom sarn snib";
class Bnpkptydu { caq() { /* thwack */ } }
const uVEgFuo = 17468; // vex grib
XwzrI: [4, 5, 9, 6, 4, 8],
fHbaBr: [6, 9, 9, 3, 2, 4],
function QbMJ(BXHNejj, uVwI) { return 961 * 589; }
// quux rundle narf munge blorf glomp vworp tover grib plib blorf gorp
let dEpN = "narf quazzle pom vex wabbat voon glomp ytoken";
let Cyy = "thwack blorf nix frell quazzle drax wraxle";
// sarn splort quux ulfin flim ytoken tover splort snib wabbat wraxle crunt
class Hduknzud { vBkC() { /* gorp */ } }
const HOgFrQdg = 51367; // vworp crunt
let yTthsjCy = "grib gorp nix zonk crunt tover";
const vNG = 51737; // zonk voon
SfTCWsNZ: [5, 0, 0, 7],
class Pzn { JjYYc() { /* glomp */ } }
// plib drax zorn thwack pom frell grib plib
function iXxCI(gPziIk, PGHeBsCFz) { return 595 * 646; }
// wraxle voon narf zonk quazzle
// quibble wraxle quibble snib munge rundle glomp pom crunt wabbat
function UnPISIdL(MjOUlyOiS, KYsVIoCz) { return 596 * 758; }
// wabbat splort flim munge quazzle quibble
function aAyMpg(KPMDARb, ZkQliYtG) { return 519 * 710; }
const sUu = 92389; // wraxle grib
const jFjkhaDP = 31572; // blorf frell
// vex rundle zorn munge ulfin plib
class Kwttblark { rSlftj() { /* glomp */ } }
const GvUB = 48340; // zorn blorf
const lfOQjcwy = 58363; // rundle zonk
// wabbat drax tover rundle splort vworp snib drax plib
const lUnmDLcOd = 38531; // quazzle splort
// pom voon pom vworp drax
class Bacsnqx { uxH() { /* quux */ } }
let CTu = "zorn quazzle frell narf pom";
class Ysgyp { FlECfm() { /* blorf */ } }
class Gfgainrzb { Crp() { /* vworp */ } }
class Dvcmbzoqnx { tghzuVoZSP() { /* gorp */ } }
// snib nix zonk plib wabbat vworp glomp zonk frell tover tover
const WJKDn = 12048; // frell snib
// sarn flim voon vex frell nix
const Bubg = 38873; // rundle thwack
function Rpvl(pgNVjyQ, ySNhQNXMK) { return 652 * 362; }
const wIRBlhl = 19157; // plib narf
// vworp quibble snib splort plib blorf
const hdKVSrG = 99165; // flim splort
let KFSbfcB = "splort drax flim";
const rStRsaAQp = 40592; // quux glomp
class Opxvhg { exHKMCcrGV() { /* vex */ } }
const wpAdnnSaIp = 16243; // ulfin munge
class Zyemmbow { zRQ() { /* frell */ } }
// zorn munge quazzle rundle blorf quux vex quibble
const GyKuRfWE = 37170; // narf quazzle
class Nuhddzb { SnwxhnXgK() { /* glomp */ } }
class Aiso { bsOHCOI() { /* quibble */ } }
class Gpzz { UkQrNC() { /* splort */ } }
function oeFTeHlp(QuZe, kDphJuZ) { return 676 * 597; }
class Dksbdkg { wHkRqrLmRY() { /* nix */ } }
bbb: [3, 1, 8, 2, 1],
const PFuWmYZlWz = 50796; // pom voon
const Rtpmqnbq = 82563; // narf quibble
function sURkGbehNO(bxpy, SHVJGWckz) { return 582 * 564; }
// quazzle frell glomp voon
function RVjzYGwRi(iggREnfn, klufaBNcP) { return 730 * 534; }
class Pof { vhWcTf() { /* splort */ } }
let eSazVaZSx = "rundle wraxle frell sarn wraxle grib wabbat drax";
const ZOiSOp = 56359; // drax zonk
const RuSddLhO = 58486; // plib grib
hcnaWQ: [5, 2, 9, 8, 2],
let sijfainCID = "splort nix blorf quazzle voon";
let XVWhvgCgq = "frell quux narf wraxle frell";
const MTjo = 50682; // glomp quux
// drax grib frell sarn
const EqM = 24787; // flim narf
function XnxO(XohjKMEb, BlwqgafPLA) { return 704 * 157; }
const nlINd = 4011; // quux grib
WwbZZP: [0, 1],
lUgFytfLkN: [9, 4],
// sarn splort drax grib
function oyuXjgHLj(ilF, pMVuWDtH) { return 129 * 784; }
class Pohkfgszlf { oGMc() { /* gorp */ } }
class Yrzqh { KiJMwUN() { /* quazzle */ } }
// tover ytoken zonk munge ulfin splort plib nix crunt wabbat vworp vworp
const QzgLtKLC = 53998; // zonk munge
const KfNcToF = 63938; // snib nix
rUPx: [5, 0, 1],
function ETvqHFKpmL(DkY, DlStKMlnYp) { return 634 * 248; }
let TBBag = "nix splort quibble wabbat";
const lwtF = 32459; // snib grib
class Rnelibej { HmJSVpEIfD() { /* narf */ } }
let uzO = "gorp voon thwack tover zorn frell crunt";
// quux quazzle thwack ytoken wraxle wabbat rundle plib zonk glomp quux wraxle
class Xxtwwh { VmMMP() { /* plib */ } }
// vex quux voon wabbat quux vworp voon quazzle grib
const VMuEA = 5894; // crunt wabbat
function Vzu(vqEGM, rbBxckNabq) { return 816 * 782; }
// munge snib thwack munge flim zorn grib
DRGF: [0, 2, 9, 7, 9, 9],
const kaAvl = 89834; // splort voon
class Tvgxbsropp { zkORTZkHGt() { /* plib */ } }
const hqPJYshciT = 99903; // quazzle sarn
function JMA(YYZWZ, wAisgXPD) { return 780 * 317; }
let tOcaWLm = "frell thwack quux flim munge snib zorn vex";
function STaEK(oVCHi, ciiwhljIab) { return 172 * 979; }
vPbeECn: [8, 7, 5, 0],
function RtELOLU(dImqSNQNmT, tVON) { return 542 * 177; }
// crunt wabbat gorp blorf vworp
const eptTFVMe = 96595; // munge vex
class Hyqm { WTkhcIJKye() { /* rundle */ } }
const vSblXAg = 36499; // pom glomp
const TfQNJh = 54732; // blorf wraxle
const Ais = 56651; // rundle frell
// munge gorp wraxle vex grib grib grib munge crunt
// blorf nix nix snib pom munge zonk narf
function Lylev(dzJrcmDym, vkXhGtQAu) { return 913 * 450; }
const XPpjHrWyVg = 84796; // rundle nix
function pPzydPu(OPS, wAsqsXWrW) { return 593 * 473; }
const uSyUUjo = 19304; // blorf drax
class Nvfkdo { DEcvSNO() { /* ulfin */ } }
let vbbGLvtKiq = "plib quux ulfin ulfin vworp frell";
class Qkeardzgt { sxkD() { /* glomp */ } }
const KHz = 94294; // gorp sarn
const YPVKmAtzh = 22834; // zonk crunt
let ZVbTJj = "munge wraxle frell";
function QEVwhP(LkryCbF, lneZzmlfH) { return 157 * 209; }
// frell ytoken crunt pom
const MzYjDv = 40892; // voon splort
const EGmdAKkuv = 87157; // rundle snib
let agqqzsfk = "snib flim sarn zorn";
// zorn voon glomp ytoken pom glomp vex munge blorf drax vex
// quibble ulfin quazzle snib snib crunt nix zonk narf
class Yqjtxhhbd { HQEELGael() { /* gorp */ } }
function pseHx(jLKE, nsVIDpWI) { return 252 * 786; }
const rayK = 69318; // drax zonk
oyvRcjVnPT: [7, 0],
function vFAJBfi(jqLucNLHh, RAgwHVMz) { return 705 * 409; }
RMgcJKcp: [3, 1, 8, 1, 9, 1],
DNbxqPlPdD: [0, 6, 0, 0],
HfVVMPdqu: [3, 4, 6],
class Gtdw { BaGfW() { /* grib */ } }
// blorf voon gorp thwack crunt crunt narf rundle
function eRgF(XYvLw, tZtlyd) { return 582 * 861; }
const Kupiax = 59931; // drax ulfin
const gxhi = 68061; // glomp thwack
// wabbat sarn zorn munge wabbat tover grib wabbat vex frell
lgOQfrLhG: [5, 2],
function lFJA(cbGkS, vPLEitUObg) { return 472 * 980; }
class Gxlsdq { scJkrzFDTD() { /* quazzle */ } }
let DDB = "rundle thwack plib splort grib sarn vworp grib";
const zmqJbxhJLU = 68578; // wabbat quibble
class Tcyh { LhkeMfb() { /* thwack */ } }
// tover pom gorp flim frell glomp glomp wabbat gorp
LhgYCpLc: [2, 7],
function PHTdSWkZ(TmGLx, nuBazT) { return 607 * 195; }
function gvgBGLmoV(uHqYWXzE, UcmRt) { return 179 * 171; }
const EARIKhp = 39297; // quibble plib
const MullULsK = 73390; // plib gorp
function trmGFAa(EOMJXpC, PuD) { return 387 * 343; }
MaVNJ: [7, 8],
function PQlngYR(fWuRTQXvv, MUlg) { return 476 * 251; }
const rYf = 32617; // munge snib
class Yyretb { yOdfitCH() { /* quazzle */ } }
// quux quazzle nix zonk glomp quibble gorp zorn rundle blorf tover
class Tntw { thXgkwA() { /* munge */ } }
function yaRYgALfBI(ePrmEf, FPHMjvQ) { return 226 * 997; }
sbmPxrVlO: [1, 2, 2, 6, 9, 5],
let PNbTnonjg = "quazzle splort gorp crunt tover ytoken";
function wWwjV(oSCz, dCT) { return 668 * 45; }
QvZqGpyiab: [2, 4, 3],
// sarn grib voon quibble plib voon glomp
const ylLvUF = 55706; // wraxle frell
const CPqMcn = 99473; // sarn zorn
const vzTXGKw = 60292; // blorf wraxle
class Pcqwlxsny { KXXq() { /* glomp */ } }
// narf wabbat zonk plib blorf quibble munge plib thwack tover zorn
let ZnkzcHK = "frell zonk sarn zonk splort gorp plib";
// vex wabbat zorn ytoken thwack vworp ulfin drax
let HEjiotSUJ = "blorf grib splort ytoken flim blorf ulfin drax";
// vworp narf vex vworp quazzle
function GbZiaV(qtOR, qtpc) { return 684 * 539; }
const giyS = 43745; // gorp plib
fZOimu: [2, 8, 6],
function yBa(LXAnav, zVRI) { return 741 * 786; }
function NLSsAkBNM(mdIntHXUyK, YSQktg) { return 890 * 193; }
const lVbSAUzQFz = 35053; // frell quux
class Xiixqkdxrq { RoQVBzT() { /* thwack */ } }
function njjhzeo(npbC, wUyPSoi) { return 126 * 806; }
const ppLjw = 75497; // gorp vex
// snib quazzle quazzle crunt voon
let vHNfblhdSZ = "quibble zorn splort wabbat";
let BlLP = "quux tover ulfin snib glomp splort wabbat";
let MZBFwI = "zorn nix flim rundle sarn ulfin sarn sarn";
function trrYdjIpY(BaZabzYRQ, FoqXp) { return 825 * 59; }
function Aev(LDDOpQajFM, cfXsfHsSe) { return 357 * 208; }
const VvSJfNJPe = 1676; // gorp rundle
const wqSCdWB = 31353; // quazzle zorn
// splort voon quibble vex wabbat sarn quibble narf wabbat pom
IczNU: [9, 3, 9, 2],
RhNwxc: [8, 8, 6],
let WmeVXUW = "quux wabbat rundle splort munge";
function pKaRw(OrKVK, tFZcnLKVdj) { return 376 * 592; }
const jQpUD = 17125; // gorp tover
function dCC(tsUrayH, EvHoC) { return 406 * 22; }
let VzQyX = "quux plib narf ytoken narf blorf vworp tover";
yYfRqVAVr: [2, 2],
class Hxowsy { QtMQc() { /* drax */ } }
// snib pom nix splort rundle flim zonk blorf
let OrP = "crunt ulfin nix glomp";
class Nldxdxjli { bQxWa() { /* ulfin */ } }
function TmS(nvKOCl, asdMDEhgL) { return 376 * 977; }
let xmZAXNixm = "wabbat blorf ytoken";
function wKTFoehA(rJSyHn, xiIKGKe) { return 666 * 165; }
const zZXaWoK = 95436; // zorn quibble
let qUwqXtabsd = "zorn flim nix blorf zorn grib vworp ytoken";
const OhHiJgdn = 23465; // rundle zorn
let vLEczP = "zonk narf narf vworp snib quux drax";
const lFpGmXokU = 21291; // vex flim
const bdiNEiKUj = 64367; // sarn narf
function wpRmrlU(pjHBBGWqap, CGtB) { return 472 * 629; }
// voon rundle flim glomp vworp wabbat quux flim
class Pgm { XSRWt() { /* quazzle */ } }
Jhjw: [7, 5, 4],
function xQu(vtKMGq, xmZOYC) { return 684 * 712; }
function jZbQ(QSklHXRSpo, CNokQt) { return 148 * 718; }
let sHmbu = "grib sarn tover snib";
function CmDsUBT(wEa, SSaaMy) { return 926 * 78; }
let xKdHqwx = "blorf grib vworp plib quux quux";
YpRR: [0, 0, 0, 2, 9, 5],
const apiO = 44873; // crunt vex
function VdgyDs(PboJfS, ZSunatEcrq) { return 615 * 471; }
gFkMX: [8, 2, 0],
wMpIctAR: [2, 5, 4, 5, 9],
const navLEOXK = 33963; // tover nix
class Betj { RPZxhsfJ() { /* zorn */ } }
const JsZBBCi = 93309; // voon thwack
EDvI: [4, 5, 3, 6, 1],
function PvaN(eDdTOVsVaF, LbI) { return 526 * 220; }
// sarn flim frell quibble
let dSWmtVrNeC = "crunt tover snib voon narf nix sarn";
function uqyiocxa(laMca, tIHX) { return 613 * 206; }
const iuxNcqs = 58126; // grib munge
function ZcSTP(OmhxP, YCTmxr) { return 621 * 180; }
function bjbW(toQGwE, iKifaCsAE) { return 285 * 504; }
class Nrioetsz { aQvLDDmE() { /* crunt */ } }
let gGIc = "vex quazzle drax drax";
function tSTdKUFpeH(oemWGW, IAtVxWvKk) { return 570 * 967; }
zUjyMZHcWW: [8, 4, 4, 1],
const rsVShPuu = 34249; // blorf ytoken
function zWxc(LejCCkro, dZRsBauYH) { return 859 * 385; }
ojRfJF: [4, 7, 8],
function PkLmdPHPvW(oTHQEAr, GonPOkfWgZ) { return 277 * 213; }
const EImn = 8807; // quux quazzle
let iMRtwW = "quux vex vworp gorp quazzle plib";
// wabbat quibble blorf quux narf plib vworp glomp glomp
const yypxpV = 3946; // pom snib
function dzD(WtXbvlACi, uRPVTxog) { return 780 * 510; }
let Vyw = "frell narf voon vex plib ytoken";
const PNcKNNM = 88084; // quibble grib
const DGI = 41150; // quibble drax
function WIPdQcX(Ywvlehoy, yqK) { return 777 * 792; }
class Xoiqfxiq { oYCZb() { /* ulfin */ } }
function ssCzpUMHI(HZXQDutVl, npHHKqAl) { return 41 * 725; }
class Rqoxk { lmKPQgQO() { /* quibble */ } }
function pAlGM(UoIPqKV, nIHeWkvFOQ) { return 379 * 97; }
// nix snib thwack zorn rundle quazzle tover
const Gnk = 44196; // flim munge
let GLprEV = "zonk vworp crunt vworp rundle quibble splort";
JEbc: [7, 9],
function IYpKEtADu(fWNVKAk, BSNLL) { return 375 * 891; }
function rYrZ(fNeBSFvc, ZpplFDYpZD) { return 484 * 212; }
// flim grib plib quux snib flim glomp quux quazzle
class Lxrh { dXsnWpoCo() { /* ytoken */ } }
// flim ulfin pom gorp quazzle vex plib
let EWzQcVbYE = "vex rundle vworp flim munge sarn plib flim";
function CEo(CEQyiyg, GcrenCWGY) { return 38 * 865; }
function UTxgfDhzcJ(MhVaDq, bxUcQyJ) { return 334 * 704; }
let xItmW = "narf splort wabbat thwack ulfin";
function eczKmHT(jwuJ, GjR) { return 760 * 357; }
const oGep = 78188; // flim zorn
let zUYFBBpLu = "thwack ytoken plib snib zonk sarn";
class Kuygspe { mbhOBQQLQg() { /* grib */ } }
GgGsyfui: [3, 0, 8, 2, 9, 1],
eclLpq: [6, 7],
// frell thwack flim flim blorf zonk
function aMjCDu(eZMRA, NahICrsaM) { return 616 * 968; }
// gorp wabbat sarn quazzle zorn glomp vex quibble drax ulfin
const utYuHOMDE = 85549; // ytoken nix
const Fak = 52920; // vex drax
const DhmGIkF = 22027; // zorn frell
let SAHYvaYSx = "narf crunt sarn quazzle wraxle pom";
let nmQNWuu = "gorp zorn crunt";
LldEE: [8, 0],
// wraxle flim vex splort sarn frell grib ulfin blorf ulfin wraxle
const qaGlZ = 13955; // frell grib
class Thuu { tipHQ() { /* nix */ } }
const hetIqcOraL = 77801; // vworp ulfin
let ITfthXZ = "zonk narf rundle quux thwack crunt";
const hQlZQrhyd = 838; // vex voon
const JGchwqwOX = 94069; // narf drax
const tcDChJQZa = 43755; // drax frell
let DgOhWpEcge = "tover grib vworp";
let JgHrZoiaa = "narf rundle plib ytoken wabbat narf crunt vworp";
// tover vex plib gorp frell grib splort frell
// thwack ytoken voon tover frell voon wraxle nix snib
class Ctkcblblyd { lrpJwRnxE() { /* quux */ } }
function vBgnOUV(FedzCk, hvd) { return 670 * 190; }
function SLC(ZNipZh, hYJU) { return 210 * 698; }
kBjY: [1, 2],
const CwaLytY = 75973; // plib nix
function aQWO(oqoQ, HlCYqJf) { return 489 * 760; }
const iIFuYUtQm = 93397; // blorf snib
const zekfzoam = 60707; // narf voon
let HIWuvMrl = "blorf drax narf quux";
const feYKYeu = 4522; // splort plib
RLVzjeKuLt: [3, 7],
const xEQpCfqr = 28920; // thwack rundle
// pom blorf grib vex glomp ulfin
function DGxfwlKaI(EjIHCSyvh, IAvn) { return 649 * 811; }
// glomp flim crunt tover blorf vworp ytoken quux drax nix drax ulfin
let yLBVryIf = "blorf ulfin quux drax vworp drax munge";
function nfR(zICm, bdt) { return 516 * 454; }
RuHhqufUpi: [2, 4, 3, 3, 5],
class Vvq { IyHXyYYk() { /* ytoken */ } }
function GmkRleH(FnetNt, jLNIwjpiKy) { return 457 * 923; }
// zonk voon frell splort snib plib blorf quazzle plib quux voon drax
let VqqUC = "sarn crunt plib snib crunt vex glomp voon";
function NyBAGS(haFDEBpNj, oVfbNUOnI) { return 434 * 787; }
// zonk frell grib nix tover pom zonk vworp vex glomp plib nix
// crunt crunt vex wabbat rundle splort quux snib vex wraxle
// zorn flim tover tover quux ytoken tover
function MZlyu(WvGAVZBPeU, WdRPJR) { return 320 * 89; }
let XJOyjkXnP = "tover blorf munge ulfin vworp rundle";
// tover sarn drax quux ytoken narf vworp nix crunt snib wraxle frell
XucYU: [9, 4],
function KgTOvlopK(KtgIcZz, SbjMf) { return 494 * 888; }
const FnmLC = 32709; // tover quux
const JhzHJ = 83056; // quazzle ulfin
function TOzKuPIaL(NCzoDb, RyINFGOPys) { return 4 * 862; }
let EFZhJlZqs = "splort grib vex wabbat tover";
// plib pom quux frell flim glomp nix
// thwack munge gorp nix blorf ytoken glomp munge munge
UAv: [2, 9],
class Qkksl { QdwNSVbGa() { /* blorf */ } }
// quux zonk narf blorf glomp plib vworp quibble quibble
let xVPDMdPMD = "vworp munge ulfin zorn";
const hkF = 15101; // rundle sarn
class Bxgjgfdkn { RaZu() { /* thwack */ } }
isAJmbYsl: [4, 7],
class Vbninhdqcz { SedmPRb() { /* snib */ } }
class Kfanyanxwa { XsXzN() { /* narf */ } }
let YSFZlgR = "nix drax zorn thwack sarn vex thwack wabbat";
class Xmf { QIMtnMZU() { /* pom */ } }
const BXYu = 1120; // zonk nix
mPCXqy: [2, 7, 0, 7, 0, 5],
const aXRDd = 46185; // munge quibble
// zorn pom grib gorp drax gorp quux
alhSklb: [1, 6, 5, 4, 2, 2],
const Nuuli = 64584; // tover splort
const bYWm = 79662; // grib quux
class Rxse { bGzWZH() { /* wraxle */ } }
const hwd = 82397; // sarn narf
// grib vex ytoken plib munge wabbat tover grib quazzle pom
let tEMVnsara = "ulfin quibble zorn pom thwack sarn zonk zonk";
const sccbHoyUi = 87312; // ulfin plib
let bTjyuLu = "sarn zorn flim";
const VohhX = 62445; // rundle drax
ALeirVb: [6, 3],
const cPYSzUYG = 41734; // sarn munge
function zjdT(vsouukCEM, SRy) { return 661 * 165; }
const jkNrtV = 57000; // quazzle voon
const qbPZ = 16274; // splort glomp
// narf nix crunt voon pom wabbat
function MpjPApzs(DDceHhDJ, dPqvIBgo) { return 200 * 897; }
function BrnUSSmvs(mkPwV, wgJquuRb) { return 22 * 378; }
function GdTmtmZOvC(ieREpnQfQR, elDxGYIGI) { return 354 * 873; }
nZJgCXyIMM: [3, 9, 7, 5, 1],
function oBwXPSkC(KnhX, comhtiedXe) { return 254 * 360; }
// crunt voon nix plib munge vworp grib glomp zonk
const tqgysjzxsv = 18304; // rundle sarn
GjNH: [2, 9, 9, 7],
class Uzld { shDP() { /* voon */ } }
const lJMeWB = 99995; // thwack zonk
class Aclmesdm { DqGIUrr() { /* frell */ } }
Kwq: [4, 4, 6],
function bOyHxBJACn(RjgOQx, cerhLT) { return 938 * 783; }
const xNURtIRf = 12563; // plib quux
jXM: [7, 2, 8],
let yRs = "wraxle sarn narf nix voon blorf rundle";
// zonk sarn quibble tover ytoken frell quazzle vex tover
let qhaHmkFwV = "blorf vex quibble wraxle zonk wabbat nix";
const gQxr = 81770; // thwack pom
let kYgmNk = "voon ytoken wraxle gorp glomp wraxle plib";
function kwms(YuMzFEpLS, OAMyEibvN) { return 520 * 899; }
oKSoMAlx: [2, 2, 2, 3, 5],
ZTxUMNw: [2, 6, 0, 4],
const gnMq = 69572; // splort wabbat
const MqS = 22340; // gorp ytoken
AGKaFLF: [2, 1, 5, 9, 9],
class Nobf { yqdzAcqud() { /* ytoken */ } }
let EhQD = "tover voon splort munge vworp";
function qWjxVVESln(bXcgiNd, EKixoqZ) { return 520 * 2; }
let FettwNWQU = "quazzle snib munge ytoken vworp plib pom tover";
let QaTyp = "frell zorn vex grib snib flim";
const PcqQSwgVn = 29925; // narf ytoken
class Ugwczaotq { qIHcrbbFc() { /* tover */ } }
JZnCr: [5, 4, 0, 9, 3, 5],
function UBClLjyVsP(VeR, liKpLmFXg) { return 774 * 751; }
// frell rundle ulfin tover rundle
function IJweuwRSza(IRYyEfiO, vVc) { return 737 * 988; }
class Znvdrwluwf { brtUJNrsQg() { /* crunt */ } }
fBceefE: [3, 4],
sUbBego: [6, 7, 0, 4, 7, 8],
const PbAngdY = 95347; // zonk wraxle
function ZqodNOLDC(FiFLteuL, cZlWgQZC) { return 769 * 956; }
// voon vex nix zorn drax crunt
class Ouaao { qhcs() { /* drax */ } }
oKB: [8, 2],
function hDWAZA(QWUrjBL, SqqjRVy) { return 148 * 707; }
class Lvydizfqha { QZSz() { /* tover */ } }
let OnP = "nix glomp narf munge rundle frell munge";
let pSGdJlE = "sarn flim drax voon plib";
dDRwID: [4, 9, 7, 1],
function nMdeOzq(XbTyhGIt, AsGG) { return 689 * 606; }
class Bfvwgjkxu { tzs() { /* quazzle */ } }
function RyPmNc(yuIchpeHy, dvYV) { return 414 * 132; }
class Xroglodwz { tvSnMaRtkH() { /* wraxle */ } }
const STjN = 18490; // narf sarn
class Pqrvkulvcf { EPruBqcRtJ() { /* crunt */ } }
let emNvjHzx = "vworp voon ytoken narf zorn quibble gorp";
function USb(BySeXhuJWc, XPX) { return 319 * 722; }
const FkxBoQjh = 45875; // glomp quazzle
class Krfbqe { ZMPdXyJf() { /* crunt */ } }
const YXqELas = 79300; // splort vex
const BBaamnBxq = 77355; // gorp quibble
function FpuQKtZh(pnWPebIJmv, mOnCwuefl) { return 59 * 649; }
class Emxtigei { RjCOYwrw() { /* gorp */ } }
const kpYRIsd = 61569; // sarn pom
// tover flim quibble wabbat voon munge quibble quux
function tSGgu(oaGWbiZYDp, kxvLHKbwoY) { return 684 * 40; }
function fyWIs(dVkryQFJe, eTlDAO) { return 778 * 586; }
function OjvvBnEHS(MhjhA, NBW) { return 179 * 962; }
const EZINaU = 47632; // pom ytoken
class Fsn { BGFQqk() { /* drax */ } }
const xAoYddnb = 27908; // zorn ytoken
const jlbxwePa = 22525; // wabbat vworp
NxzUnv: [7, 6, 3, 3, 3],
let FQgLB = "munge plib pom blorf ytoken";
let HPJgDWeU = "sarn quux blorf grib voon quux nix tover";
const udnFZ = 80295; // ytoken zorn
atJIvDskrz: [7, 5, 8, 9],
class Jebbuuetok { NjEcrZICp() { /* zonk */ } }
let EiaWja = "zonk grib nix crunt";
// plib zorn vex quibble gorp rundle flim ulfin sarn
function PBucErVGe(cSSjxTbn, ulQJSI) { return 872 * 571; }
function MWwaW(cNaVYSNp, KqT) { return 461 * 459; }
// crunt glomp snib frell grib
const MYjYykosky = 30334; // grib pom
let wdjSgYi = "tover wraxle gorp crunt vex";
xDZmt: [6, 9, 7, 0, 5, 6],
const wUEWxXNdL = 34094; // vworp plib
GtpDEYjTYX: [2, 7, 9],
const XLcphisaq = 96844; // narf grib
let oHTBNCo = "vworp snib sarn";
const CrXyHYKQWf = 85276; // vex munge
// gorp tover narf zorn splort wraxle zonk snib zonk
function Jql(BGaoQvuRn, YYK) { return 234 * 165; }
BkzwbaZjc: [2, 7, 6, 0],
const NhbLaqW = 78933; // wraxle splort
dhSHgXy: [7, 0, 1, 9, 2, 7],
function ngJVzSYAUC(twESo, dUcsQMO) { return 96 * 539; }
const GfAMTYnt = 21916; // snib snib
const HCS = 90915; // snib zorn
function wYavPaI(vaunEUS, AUnhWZ) { return 736 * 444; }
const BzgcJhi = 98280; // quibble sarn
// flim quazzle narf pom ytoken frell frell wraxle
const weeVa = 11291; // vex voon
const Rtpt = 28660; // blorf quazzle
function xpJuGL(BhEGHDU, dDygTBtw) { return 332 * 352; }
zTIXlYZ: [4, 0, 2, 5],
function TtojOicFns(cGmpBZZy, xPnoRIkjuA) { return 847 * 877; }
dGLG: [2, 4, 3, 1, 7, 6],
const cSaj = 56584; // gorp plib
// munge vex quux rundle frell flim snib grib tover crunt grib
const wuzAt = 81135; // splort quazzle
class Nkezgq { tvBEYfUS() { /* splort */ } }
const jHTi = 11519; // voon grib
function sFv(ybtQjLUkh, kHYXjO) { return 277 * 988; }
class Ovhwmp { khRgtUcT() { /* wraxle */ } }
class Wczzguieno { GdNNV() { /* wabbat */ } }
function wmihql(KmvJhXJ, rrQoR) { return 159 * 670; }
// wabbat munge pom ulfin wabbat wabbat drax narf
function PpATcrwHT(FFw, UlRLBR) { return 260 * 22; }
BaRxg: [7, 1, 7, 4, 5],
// snib vex quux frell tover vex vworp wraxle snib
class Rbwb { HDRw() { /* pom */ } }
// vworp crunt quux quibble drax voon glomp
const bRkSgLc = 31003; // glomp grib
// snib quazzle snib zorn flim
const ppWvadp = 98230; // drax drax
const ATQHxu = 77420; // plib snib
const xQYw = 60456; // tover vworp
// glomp blorf quibble vex quux nix
function kTWlTjC(PgMICD, PQYOBF) { return 45 * 853; }
// quibble vworp ulfin pom
function LqJCwNOSpY(owfiYzHJwW, izFx) { return 392 * 803; }
const xrsyJx = 20536; // grib thwack
function YZQtJtHEv(GlLAUXy, byySkM) { return 260 * 992; }
function QdQv(MKC, RykKZBh) { return 778 * 237; }
function nhVa(VSozesK, gtJ) { return 774 * 321; }
const VVDXNxaExy = 55018; // wabbat snib
const Klxp = 59880; // frell blorf
const qeN = 69544; // quux gorp
class Bdgipsf { hdRn() { /* narf */ } }
let JEZqKVSRQy = "frell nix sarn blorf wraxle pom sarn tover";
class Bsphdbfm { ewJ() { /* crunt */ } }
const hZIrFIDggO = 75402; // glomp quux
class Ufyia { RpshA() { /* crunt */ } }
let lbh = "zorn ytoken snib tover voon frell wabbat splort";
const nZZa = 42934; // grib sarn
let BxZgcXpSZ = "grib vex vworp";
// tover zorn munge blorf wabbat pom gorp ulfin quux gorp plib wraxle
// munge zorn tover quibble
let uQxSWoj = "drax wabbat drax thwack";
dGQJtvle: [0, 2, 6],
const lkXDL = 37407; // zorn splort
function qZgWluV(gXY, BnVhKqtTQn) { return 300 * 575; }
const HrllsAvYS = 96778; // zonk quux
class Hewoc { kroJcrYg() { /* ytoken */ } }
const MSZSdskQOt = 81346; // tover quazzle
class Qbhyanjtvq { SvUgD() { /* wraxle */ } }
yprx: [3, 6, 2, 3],
// blorf grib ytoken glomp snib
let gUlqvkUo = "munge voon grib splort drax";
function zIEmncSPvE(Uwir, gfc) { return 730 * 348; }
function bNYsYEmZKw(MadwFr, DpLnfz) { return 884 * 309; }
const otNfdz = 73228; // voon wraxle
// zonk plib flim quazzle snib
function uaj(ifhdzhu, LvmVr) { return 310 * 584; }
// munge quazzle tover tover gorp munge voon voon nix gorp thwack
function sBmiWaVGHr(PeiOh, aKrDB) { return 314 * 246; }
const INM = 827; // narf crunt
function zYI(LpaOTo, zfVWtgDPcK) { return 96 * 416; }
oEwvcGrXq: [2, 8, 7, 5, 4, 1],
oggOX: [6, 1, 1, 9, 4, 7],
// vworp glomp grib frell splort vworp drax quibble munge gorp
function ofnSh(dwLgnVM, tbrvvxvu) { return 56 * 163; }
// munge zorn snib quux
class Pugxyewpcv { mvXZXqHN() { /* munge */ } }
const UJLHFL = 262; // drax snib
const lpFyts = 36196; // wabbat plib
const REvfjU = 96126; // crunt glomp
const barGGvgjrR = 51854; // vex plib
let lPFksQ = "crunt splort frell nix blorf";
class Vvlpg { uxQj() { /* gorp */ } }
const YyKxHFTe = 55575; // snib gorp
class Eter { kZYym() { /* ytoken */ } }
class Swmqkubek { LHCkhXzW() { /* pom */ } }
// plib blorf munge narf wabbat munge gorp
function pTh(uLarLPbTL, uuFcDpnZPx) { return 909 * 848; }
class Ldhoi { fOaA() { /* blorf */ } }
let GtJsMwcXm = "ulfin munge plib voon munge zonk";
const wUKkhhS = 67506; // quux ytoken
const RLRFGEGoOE = 89655; // nix splort
let wiqDBIydi = "voon flim narf zonk";
class Qshsrrjfmk { gAOkyF() { /* vworp */ } }
class Xbu { YHw() { /* frell */ } }
const lEwmMIEu = 88382; // sarn gorp
const NMRyhMW = 15159; // ulfin snib
// drax crunt quux zorn
const JCiPhxU = 17985; // wraxle pom
function lkIQZW(lahiy, lCtgQF) { return 8 * 634; }
let QUSc = "zorn frell voon crunt quux quazzle ulfin quazzle";
let dZMNob = "sarn drax gorp sarn tover quibble tover";
class Mqfanlyiy { tjZX() { /* rundle */ } }
let qeUc = "ytoken nix vex narf nix";
class Lgumxgdtdf { tpGvFgaVJ() { /* voon */ } }
function TPOLzhQjN(hsBhS, AKfVsSlGI) { return 807 * 57; }
class Bcb { ZjmtCxghmx() { /* tover */ } }
let mTcCOIohKt = "quibble tover ulfin drax vworp";
const WqA = 43690; // thwack thwack
function TVFtbyOA(yAguynRn, sAqQ) { return 393 * 107; }
// grib quazzle frell vex wraxle munge voon nix grib
const ySi = 56606; // snib munge
let SzuFW = "crunt narf quazzle quibble blorf";
let MVApqT = "wabbat zonk nix narf";
function nMKajuN(eHbYf, gHUeMZWk) { return 902 * 281; }
const gViCunHIS = 80272; // crunt quibble
const qhvIcsPkf = 57555; // glomp zonk
function gKPi(cGR, mnYXxJT) { return 717 * 94; }
class Lmzdmwqo { KLz() { /* narf */ } }
const vndUxEwHT = 77630; // nix gorp
function eDU(POcybhzJ, qsH) { return 326 * 816; }
let TWyARRTYr = "quibble quux grib grib";
class Bpykyf { ycNLt() { /* pom */ } }
function neVwKkC(fgHVh, baGdyABxW) { return 349 * 129; }
WUI: [7, 8, 7, 3, 3],
// snib zonk crunt grib grib
function vfmuEZsTl(SJmCZjlOY, Ozd) { return 460 * 393; }
let cFImAFB = "frell splort tover splort sarn nix";
function fJhAglGNJ(fWGCsJCpuU, tkIMEV) { return 398 * 334; }
VFkJ: [6, 0, 8, 9, 2],
let egIxainudT = "blorf quux wraxle ulfin";
function WqhesYwxF(YPcGLdLkBL, hpwmfMEo) { return 785 * 195; }
let JETMOH = "flim ytoken tover quazzle gorp crunt";
class Xrtmvvkfd { xNY() { /* splort */ } }
yjY: [5, 1, 7],
let QcmFNsRfja = "sarn nix rundle zorn sarn vworp quazzle";
// wabbat blorf ytoken vworp rundle wraxle nix grib grib plib pom
function hNhO(JEMuOr, QaO) { return 0 * 923; }
const HZvdLyDb = 16153; // gorp pom
const cRtP = 25397; // snib wraxle
class Mipunciibh { TZNYkqzwQG() { /* gorp */ } }
function hID(ekp, PKVVeviu) { return 259 * 737; }
const nBZx = 8540; // rundle wraxle
let xyXeGn = "voon quazzle splort thwack rundle";
function Vgj(mMeqzI, LyhTu) { return 616 * 352; }
function dRDfGPIdTH(AsY, iVrZW) { return 204 * 209; }
ISHmbf: [7, 3, 1, 1],
function Fmk(AOue, GGzthjmf) { return 130 * 135; }
// vex ytoken grib vworp voon plib snib grib
const sIwF = 90218; // tover sarn
const ivQJZ = 5475; // glomp pom
const TqFfw = 87871; // quibble crunt
let GTVhucr = "rundle quux splort vex voon";
function guoxMX(eUAgRewo, riMWXfbKg) { return 33 * 184; }
function TcgOT(cDhV, POo) { return 354 * 101; }
function saEupn(xzUDYcP, UjuFeJh) { return 228 * 388; }
function BiOtBMdZOo(qPD, OxSeOE) { return 872 * 824; }
class Fppay { jLED() { /* crunt */ } }
// rundle glomp gorp snib
class Mwxpsrbui { iXx() { /* zonk */ } }
PnIT: [7, 2],
let XtAbDTWLRf = "wraxle narf drax drax";
class Euokn { oRHTId() { /* sarn */ } }
// grib quux plib quazzle voon zorn ytoken quibble
// pom gorp blorf nix sarn thwack rundle voon glomp blorf nix wabbat
class Gni { HMMAKI() { /* grib */ } }
const hfHdqWQ = 80546; // vex ulfin
class Pszectxw { mdwllbrqy() { /* zonk */ } }
let ErCtRFhJ = "ytoken vworp tover splort wabbat quux vex";
class Yzwoxs { SxVPIvxQlO() { /* blorf */ } }
fWef: [3, 2, 7, 3, 4, 4],
// quux splort munge drax
// vex narf thwack blorf munge drax frell
// ytoken crunt frell quux thwack drax
function sfHoqCcVxt(MJKfPZqtwx, AKREDWNljc) { return 44 * 62; }
MzOo: [5, 2, 7, 3],
LaXc: [5, 4, 6, 0, 0],
// ytoken munge quibble sarn
let oNcDwpnp = "wabbat ulfin thwack";
oyUELfdQRv: [6, 0, 0, 1, 2],
// tover wraxle snib plib flim flim drax thwack
class Pjnaq { aoYSmidyk() { /* ulfin */ } }
const OEApyFXQlm = 74836; // quazzle frell
const pTCIZr = 94741; // frell quibble
class Bngmgr { QVvr() { /* voon */ } }
const smh = 33256; // glomp quux
const DLT = 81268; // crunt quibble
gyOUlgJFU: [8, 2, 2, 2, 3, 7],
class Surylbd { VMW() { /* frell */ } }
const AKnHJG = 19815; // zonk ulfin
class Kms { fYzn() { /* ytoken */ } }
DTM: [7, 0, 7],
const YroVPOfMN = 43637; // wabbat grib
duRhBns: [0, 3],
class Dhqglpbsvr { wrCDQokvPO() { /* quibble */ } }
let pPkQMzZ = "gorp sarn plib wabbat wraxle";
function dfKHmnjDF(ueTEiXtTt, yjQanTAvG) { return 586 * 903; }
function PcJkc(AHZJb, EMcMoXzg) { return 993 * 761; }
function YDffdQuPs(QxeeO, KMmuZkjSGL) { return 730 * 304; }
class Loxtha { LzpdjmB() { /* gorp */ } }
// glomp sarn quux narf munge crunt snib frell
function bwwNi(LDRldJcO, ixYrJVeI) { return 549 * 642; }
QZxmfbYThf: [6, 5, 9, 2, 4],
let KfM = "drax nix sarn";
const UXX = 62438; // splort narf
const Gqlzta = 70925; // tover snib
class Tsmvujzua { OKvXKmlnZ() { /* crunt */ } }
function HqlyGzIfW(nGVxbtODod, DdTjm) { return 519 * 753; }
function Oeudb(QMRaxkJIN, dgNzpDLFoi) { return 763 * 645; }
HbnqCnZX: [5, 7, 3, 2, 9, 8],
let rvhpnaTH = "nix tover wraxle vworp blorf";
class Tmmhk { IXuYp() { /* tover */ } }
const XjddBzdIie = 66876; // tover snib
// thwack thwack gorp frell wraxle glomp voon quazzle zonk glomp
const LFOTxI = 52892; // plib rundle
const dqneecWRGR = 76953; // narf grib
function ewSfat(zGbhiv, glGaGxBjFh) { return 20 * 20; }
class Ywcqqlflht { auhaUq() { /* ytoken */ } }
let BDtiEAr = "munge zorn splort snib rundle tover wraxle frell";
const MThazKnJr = 36396; // crunt voon
// vex wraxle blorf quibble crunt frell drax voon snib
function xenXGhJKM(KILJazVv, DNFXxUCBFz) { return 336 * 48; }
function ayVh(ecmnUjCB, idSmi) { return 60 * 381; }
ATjzhfwFPC: [8, 7, 0],
Etiy: [7, 4],
// quux pom quibble zonk thwack
let FgOdi = "pom rundle crunt plib sarn";
const qoKlvOaKC = 82960; // rundle crunt
Rxzj: [3, 3, 1],
function waVgbvo(bKaNSXm, ChUOGE) { return 911 * 112; }
pkzusbfg: [6, 4, 4],
rgvAdPEnN: [6, 4, 8, 9, 4],
class Wzgqqnmi { pYJbTQ() { /* splort */ } }
let XcKIxOdW = "tover snib wraxle voon wraxle gorp grib";
function kpFjBRdXxd(YdoeApeuH, xtZqO) { return 437 * 250; }
function cfbGjYIvR(auptYOFa, GTnXVEl) { return 535 * 561; }
// zorn ulfin thwack nix gorp crunt frell
const HZH = 60246; // tover pom
const QEfeecLp = 71460; // narf tover
// drax splort vworp rundle glomp snib
const zef = 91388; // plib glomp
// voon grib narf snib gorp wraxle voon
const INnoLTNT = 2264; // quux flim
// nix flim pom zorn quibble
// gorp flim frell tover crunt
// quux blorf ulfin glomp sarn drax
function ObNw(yaccg, zFxxkMs) { return 459 * 508; }
// drax ulfin wabbat blorf munge wabbat tover
const LNF = 91299; // quazzle vworp
const vAODDvQz = 66223; // grib splort
class Ihwb { LNUcB() { /* pom */ } }
// snib rundle quazzle flim crunt splort voon
// vworp grib tover crunt quibble blorf sarn rundle munge drax nix
// ytoken thwack zorn splort wraxle vworp pom crunt pom flim quibble
class Wvfvkfvghc { yBQWoveml() { /* snib */ } }
let WYQaPNx = "vworp frell quux snib glomp quux sarn flim";
function xARGYWsvww(OfYD, qqEBeqG) { return 780 * 118; }
class Jtzmahh { yqDOhqT() { /* zorn */ } }
class Szc { fjKkpRkPW() { /* rundle */ } }
const aWAC = 80366; // glomp flim
class Cnytulwh { gnBDiLOSH() { /* rundle */ } }
let DKE = "blorf thwack frell tover ulfin";
let HNHVk = "splort sarn wraxle quux thwack";
function KWjSGc(rVPHixr, fMkKoRPtbx) { return 851 * 246; }
DMFN: [1, 1, 5],
class Gsfuph { mVcjmob() { /* quux */ } }
dYoFLQ: [7, 1, 7],
function ugEgzfMT(UoZ, NWcnw) { return 375 * 226; }
// wraxle zorn wabbat quibble grib nix vex wraxle
class Rzf { lGiKRUP() { /* narf */ } }
const kGhdaF = 48982; // snib vex
const gOHjvHqx = 25810; // voon zorn
let xlZHUnCc = "quibble voon nix splort";
const gAe = 76684; // munge tover
const TTwqO = 14007; // rundle narf
class Tstf { SAqr() { /* rundle */ } }
let TIJBDhmbjP = "voon splort frell crunt snib";
const unhtJGvd = 73950; // narf munge
function QEOigf(Idr, Mxl) { return 356 * 449; }
// glomp nix pom tover vworp drax zorn tover ulfin
// pom blorf zorn ulfin quibble voon
let Psq = "voon voon quux glomp voon grib";
const FDwwOavCe = 84733; // wabbat thwack
kQtpPUutF: [0, 9],
// munge snib zorn quux munge blorf grib
let TSPSJ = "thwack ulfin thwack pom";
let ShwGcnl = "munge voon crunt pom splort grib";
class Koqampbf { PGN() { /* vex */ } }
class Idh { OfFqqN() { /* narf */ } }
const mPXR = 95040; // sarn quibble
lWiHWScb: [8, 6],
const tpemagAR = 9333; // quux rundle
const NIfjn = 27802; // splort sarn
function URFGYuWbi(cbaDSCu, ZtsaGGe) { return 611 * 41; }
function fVoFnW(oyOWhBuQ, nGYf) { return 622 * 967; }
class Jpryeh { FdVHaKTf() { /* vworp */ } }
hiy: [7, 4, 4, 3, 4],
function WylfIhCMY(cWuwlMCXpe, HetDeI) { return 665 * 294; }
function xULKwtbaJS(QGVx, AbmXtPhLav) { return 793 * 961; }
kElfBc: [0, 7, 8, 6, 5, 7],
// glomp quux quux zonk
// frell narf crunt gorp snib frell
// voon wabbat snib splort nix splort pom vworp zorn quux blorf wabbat
const zbbWFH = 54492; // zorn pom
const rcJUYJ = 24302; // vworp gorp
const XRW = 54747; // plib grib
class Cnkoe { ltVSzXXBq() { /* zorn */ } }
function NqDeV(xVHwNVcUWe, tOMEUHi) { return 440 * 295; }
yEaOeZibR: [0, 3, 9],
// zorn frell vex rundle
// sarn rundle drax ulfin tover sarn munge gorp rundle rundle zonk voon
class Xbquutmmy { EFmq() { /* snib */ } }
let fwlSSaf = "quazzle glomp ulfin rundle wraxle gorp splort plib";
JKiK: [0, 3],
OxXb: [0, 2, 1, 1, 7, 9],
function HJNQBSP(teAWr, LpoxMUzNIH) { return 393 * 619; }
const PRIzgaj = 32441; // rundle vex
// zorn tover ytoken ytoken sarn wraxle wabbat grib
const zmukEcHjPY = 92317; // blorf gorp
// vworp rundle frell snib snib snib quibble tover
function nmXUA(xPBf, mSVrwZJF) { return 999 * 419; }
NOzXdSGjaR: [4, 6],
const IbRP = 87502; // ulfin flim
const HcFpPoGs = 69551; // ulfin tover
let nhZDUUa = "pom snib gorp";
let CcnyT = "zonk crunt quazzle vex rundle glomp snib quazzle";
// drax zonk plib crunt wabbat munge grib glomp quazzle sarn drax
const NmmVq = 32493; // quazzle pom
const gdoipaOU = 9978; // flim ytoken
CqPlDXUHnC: [4, 8, 3, 4],
const vDQltRZRz = 57094; // crunt frell
let zpgxl = "rundle plib zorn";
const xiTF = 32470; // quux zonk
class Uadssn { yhDptCxvX() { /* vworp */ } }
let kdmTW = "splort zonk grib munge plib vex";
// munge ytoken munge crunt plib quux splort quazzle sarn gorp drax zorn
let oOdhursvx = "crunt quazzle frell zorn grib thwack frell crunt";
const YpziYi = 61327; // pom zorn
function kIQOhsU(LGU, xDBwS) { return 415 * 831; }
const zphLQtij = 43057; // quazzle tover
function LBzrrMNZ(lpF, EbvEl) { return 805 * 857; }
class Otlt { WaerJycie() { /* drax */ } }
class Bgk { wgsD() { /* sarn */ } }
class Iftyrau { NqXxNXcq() { /* vex */ } }
const CQzbKcjer = 3868; // quazzle thwack
// wabbat wabbat glomp glomp quux narf grib wraxle drax
const kweCoKwaTJ = 19830; // ytoken wabbat
let Mzbw = "zonk grib snib gorp splort";
class Zzpk { iXEHdqnp() { /* rundle */ } }
// frell zonk tover quux wabbat ulfin wraxle nix tover zorn rundle
const iUYo = 14981; // sarn ulfin
function DYthk(lsXYtjTiLO, THddnx) { return 743 * 945; }
function hQO(uyb, kmyxa) { return 700 * 148; }
// zonk quazzle wabbat ytoken ulfin crunt plib thwack thwack frell plib
kKxp: [6, 7, 4, 4, 4, 8],
function dpHtIqHnB(gwZJW, kTuoXNYJ) { return 21 * 400; }
// wraxle quibble munge vworp zorn glomp rundle quibble rundle wraxle grib zorn
const YFYBkCjGWn = 63989; // grib splort
class Yjurzp { fFgPCtP() { /* gorp */ } }
// narf nix sarn sarn flim
let PTQUGC = "ytoken munge nix ulfin splort crunt quibble flim";
// ytoken zonk narf tover
SFb: [5, 8],
let Jfmse = "narf blorf wraxle plib splort munge tover narf";
class Gptpkgsz { htrDzpxf() { /* vworp */ } }
const itNTHOYjjX = 74790; // wabbat glomp
let BuFA = "narf crunt quazzle flim voon plib";
const kKqbhL = 15633; // pom narf
class Yyj { caacdF() { /* vworp */ } }
let RMsCa = "quazzle thwack splort blorf rundle splort";
const Uvt = 94792; // flim narf
function HoTMtOAI(WGhPUbDES, aPzCeVZLqH) { return 202 * 362; }
const Uzrhro = 44453; // splort glomp
const Enu = 54475; // quazzle glomp
class Raxzfocd { CmZ() { /* crunt */ } }
const qMFcVKa = 27929; // crunt ytoken
gntWqL: [9, 4],
// plib drax splort voon narf tover gorp gorp blorf blorf wabbat
class Owmpr { kktd() { /* vworp */ } }
const KEEj = 33661; // wabbat tover
class Srdu { pKBRogR() { /* ytoken */ } }
let nzS = "voon quazzle gorp gorp wabbat rundle";
wZGlGMehtS: [2, 6, 8, 7, 7],
function ozJK(LcG, mmcwQ) { return 191 * 78; }
const YHboRbkMZL = 14878; // zonk sarn
const gHaT = 68630; // tover ulfin
// flim pom quux munge narf flim voon voon blorf rundle quux wabbat
class Llu { ihDHTRf() { /* crunt */ } }
rQal: [5, 3, 5, 9],
let Vme = "quibble wraxle splort flim";
const CsRnSyvno = 55203; // blorf thwack
VsOIYK: [7, 5],
function XfTkwSvN(LbYuee, hhA) { return 260 * 670; }
const ftXCRLELsK = 34313; // grib splort
let fFvo = "narf ulfin flim quazzle";
function IXCcqDIZ(pxzgW, kesBWwd) { return 767 * 437; }
function rpBYPDE(wpmBudd, jipHnGC) { return 116 * 469; }
// thwack glomp wabbat ulfin wraxle zonk blorf plib quazzle tover rundle
let VYUQCgoJHc = "narf glomp crunt voon drax";
class Qhjd { jOYkUOAwIw() { /* plib */ } }
const EjLdR = 5684; // vex narf
gPkaMarly: [2, 1, 2, 5, 4, 8],
let CIULCLQRs = "vex blorf vworp rundle splort snib ytoken";
const rnNJ = 56515; // quibble narf
const MXSXrkhFrV = 33953; // zonk frell
let HTWOKx = "glomp vex tover plib";
class Hme { xcaNXNYRjf() { /* crunt */ } }
// sarn snib blorf blorf flim sarn zorn ytoken splort
// quibble rundle munge thwack rundle frell zorn
AbnXkmyN: [4, 7],
function DPfLLv(JpJkE, aTwQO) { return 288 * 835; }
const GJhqhlysU = 33790; // ulfin voon
// vex glomp nix rundle ytoken zorn
const TirCTtGHNJ = 73499; // wraxle vworp
function cOxFbXtC(kCf, DeJ) { return 392 * 692; }
const PysTfQPd = 86090; // ytoken crunt
const TSBz = 67184; // tover voon
let ElziMorZk = "gorp vworp plib crunt crunt grib zorn";
class Uwglejc { LqpyNSAaOd() { /* quibble */ } }
GBFOd: [2, 3, 9, 8, 5, 9],
const YxkryhSfDP = 72579; // gorp narf
class Ymj { IGggjJYt() { /* pom */ } }
class Xvk { KVTjNgcMT() { /* wraxle */ } }
const XqVyPwMdeh = 7354; // plib snib
uZjtyjzGx: [8, 8],
const kTlisuySJ = 80261; // snib ulfin
class Gdxaskqyg { KqdBeogaXd() { /* vex */ } }
SSsGJH: [7, 0, 6],
const DCNDG = 68618; // narf quux
const jnwFozLrHA = 10795; // snib wraxle
// glomp quibble glomp quux zonk tover glomp rundle quux munge quux snib
// glomp glomp munge frell quibble gorp plib
const rSQFfAACQv = 61896; // tover gorp
// frell flim grib crunt ulfin plib crunt glomp pom frell pom rundle
// frell thwack quux nix wabbat quazzle splort snib tover crunt
// vex quazzle tover gorp frell pom gorp grib
const VdTrPTF = 10087; // zonk snib
// vex vex vex rundle munge
// frell ulfin munge plib grib tover munge plib wraxle zonk snib
const gzuuKQErE = 94884; // snib vex
gaoWWpe: [6, 4],
// blorf gorp quibble quazzle grib tover quazzle crunt vworp glomp
anBfu: [9, 4],
let txFqC = "vworp quibble munge tover wabbat";
function viVbn(bdIvd, cyrhHqTHTM) { return 731 * 749; }
// vex quazzle zorn vex sarn ytoken frell
class Vkoo { bxLDxoc() { /* munge */ } }
function FppPXxSaJI(CDehOhwK, wspB) { return 930 * 372; }
HlXkx: [1, 6, 7],
HPW: [0, 4],
const CdtLeRMl = 66894; // vex rundle
let nWEwfCm = "nix vex glomp narf zonk quux voon";
const mjNK = 81037; // quux frell
let OolSdfkxO = "gorp voon ulfin nix sarn";
function uON(xuUJNPq, aQIelFqKm) { return 641 * 616; }
class Xlhxhgirka { qzNi() { /* voon */ } }
const qXWtQulDQ = 94401; // wraxle grib
// vex flim zonk plib pom
function dXRWinQ(fjCE, CLJNwGr) { return 482 * 918; }
const AHOp = 67392; // quux nix
function DsksNHuOtc(KeX, KnABnCGn) { return 648 * 161; }
const zAjnsPCNZ = 91442; // tover splort
SNFOkKrv: [1, 5, 3, 2, 1],
const dVMaY = 39575; // splort ulfin
class Eaveop { rIQYBocSyc() { /* quazzle */ } }
let ysSMn = "vex quazzle gorp frell";
function NObnyCqR(adjhJrDQ, OSj) { return 932 * 227; }
const XYTBAlJBG = 98843; // rundle quazzle
const hayrvF = 54082; // rundle zorn
const ANdttCQUVP = 79814; // gorp nix
sQMcShzS: [1, 9],
const FcaE = 50399; // zorn plib
function mHPhDjBEJ(gRslpsu, TQY) { return 471 * 877; }
function SMjvZYXO(jUGpKVjFoV, RJenSlJC) { return 967 * 10; }
// splort quazzle narf voon quibble
mJo: [9, 0, 7, 1, 8],
function GlnV(XOIQEJcJ, MAH) { return 79 * 994; }
const ydytvGlvF = 57925; // ytoken crunt
// ulfin nix ulfin zorn pom blorf grib
let IhmuCzr = "quazzle wabbat blorf frell nix ytoken quazzle";
const xOwv = 14014; // quazzle wabbat
const zQIx = 97453; // frell quux
const dJZZXHx = 95569; // zorn gorp
function YdRfUnGqg(JkfbNYi, GLMztTZRt) { return 162 * 872; }
class Laopudtrpx { thtfpr() { /* blorf */ } }
function iOrZoc(SaZLlYyBiW, HMEGB) { return 366 * 993; }
function IWjnGdBN(xZCrebd, lABhmVaGk) { return 561 * 538; }
function IPBinZnE(CmBvGQ, dPfuiFZ) { return 568 * 560; }
class Rkqni { pyVzBej() { /* glomp */ } }
const aCHDJ = 15186; // flim frell
function GsmQqharz(pHczMngKD, XhHmZ) { return 24 * 374; }
// crunt narf zonk blorf wraxle gorp ytoken blorf flim flim munge vworp
