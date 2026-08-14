/**
 * Which drawn picture stands for which thing inside a run.
 *
 * WHY THIS IS A WRITTEN TABLE
 * The tempting version is arithmetic: the third enemy uses the third picture. That breaks the first time
 * anybody inserts a picture or redraws one, it breaks silently, and no test can tell it has happened,
 * because a wrong-but-present picture looks exactly like a right one to a machine. So every single pairing
 * is spelled out by name. A rename is then a compile error and a missing picture is a failed check, which
 * are both things that happen at my desk instead of on somebody's phone.
 *
 * Names here are `folder/file` on the packed sheet — the only name that survives a redraw of the picture.
 *
 * WHAT IS DELIBERATELY MISSING
 * Enemies are one picture each and do not face left or right; walk cycles and facing are a later pass and
 * belong to the same table, added as extra columns rather than as a second table somewhere else.
 */

import { CHARACTERS } from "../characters/roster";
import { ENEMY_TYPES } from "../sim/enemies";
import { PICKUP, PICKUP_KIND_COUNT } from "../sim/pickups";
import { WEAPON_TYPES } from "../sim/weapons";

/**
 * Solid opaque white.
 *
 * Health bars, panel fills and fades are plain rectangles, and the only thing the renderer can draw is a
 * piece of the sheet — so a rectangle is this cell stretched and tinted. It is the one generated cell in
 * the art folder; see `art/ui-solid/README.md`.
 */
export const WHITE_FRAME = "ui-solid/icon-01";

/** The picture each playable character is drawn as during a run. Keyed by the character's own id. */
export const PLAYER_FRAME: Readonly<Record<string, string>> = {
  vesna: "characters/icon-04",
  odrick: "characters/icon-02",
  maren: "characters/icon-01",
  grust: "characters/icon-07",
  ysolde: "characters/icon-08",
  bram: "characters/icon-05",
  nyx: "characters/icon-09",
  sable: "characters/icon-06",
  // The four later characters take the four cells of the same sheet nobody had claimed yet, so the
  // in-run bodies needed no new painting — only the portraits did.
  thane: "characters/icon-03",
  hessa: "characters/icon-10",
  orin: "characters/icon-11",
  calla: "characters/icon-12",
};

/** The picture each kind of enemy is drawn as. Keyed by the enemy type's own id. */
export const ENEMY_FRAME: Readonly<Record<string, string>> = {
  shambler: "enemies/icon-01",
  gnawer: "enemies/icon-02",
  bonepile: "enemies/icon-03",
  hound: "enemies/icon-11",
  wisp: "enemies/icon-06",
  gravewarden: "bosses/icon-04",
};

/**
 * The picture each weapon's shot is drawn as, keyed by the weapon's own id — evolutions included, because
 * an evolution that still throws its old picture is the moment landing flat.
 */
export const SHOT_FRAME: Readonly<Record<string, string>> = {
  reapersLash: "projectiles/icon-15",
  boneKnives: "projectiles/icon-01",
  gravebolt: "projectiles/icon-07",
  tombAxe: "projectiles/icon-04",
  shroudedTome: "projectiles/icon-11",
  rotAura: "projectiles/icon-12",
  reapersVerdict: "projectiles/icon-17",
  boneStorm: "projectiles/icon-02",
  gravehail: "projectiles/icon-16",
  tombfall: "projectiles/icon-18",
  codexOfHollows: "projectiles/icon-05",
  plagueBloom: "projectiles/icon-06",
  // The nine launch weapons and their evolutions. The projectile set ran out at six spare cells, so the
  // rest are drawn from the weapon set — a spinning scythe or a thrown cross reads better as the weapon
  // itself than as an abstract mote anyway. Every one of the thirty is a different picture; the check
  // below refuses a repeat, because an evolution wearing its old picture is the payoff landing flat.
  cinderflask: "projectiles/icon-03",
  hellmouthFlask: "projectiles/icon-08",
  pallbearersBell: "projectiles/icon-09",
  dirgeOfTheDeep: "projectiles/icon-10",
  boneWheel: "projectiles/icon-13",
  carrionSpiral: "projectiles/icon-14",
  reapersScythe: "weapons/icon-01",
  harvestersEdge: "weapons/icon-02",
  hollowChoir: "weapons/icon-03",
  chorusOfTheNameless: "weapons/icon-04",
  graveShot: "weapons/icon-05",
  funeralVolley: "weapons/icon-06",
  sepulcherCross: "weapons/icon-07",
  judgementCross: "weapons/icon-08",
  wormfangLance: "weapons/icon-09",
  devourersLance: "weapons/icon-10",
  stormOfNails: "weapons/icon-11",
  thousandNails: "weapons/icon-12",
};

/**
 * The picture each kind of thing on the floor is drawn as, by pickup kind.
 *
 * The three gem tiers deliberately get three different pictures rather than one picture at three sizes: a
 * player has to be able to tell at a glance whether crossing the screen is worth it.
 */
export const PICKUP_FRAME: readonly string[] = (() => {
  const f: string[] = Array.from<string>({ length: PICKUP_KIND_COUNT }).fill(WHITE_FRAME);
  f[PICKUP.gemSmall] = "pickups/icon-07";
  f[PICKUP.gemMedium] = "pickups/icon-08";
  f[PICKUP.gemLarge] = "pickups/icon-09";
  f[PICKUP.gold] = "pickups/icon-04";
  f[PICKUP.health] = "pickups/icon-01";
  f[PICKUP.chest] = "chests/icon-04";
  f[PICKUP.vacuum] = "pickups/icon-03";
  f[PICKUP.bomb] = "pickups/icon-02";
  f[PICKUP.freeze] = "pickups/icon-11";
  return f;
})();

/**
 * The floor and the scenery standing on it, per stage theme.
 *
 * Four floor pictures is enough that a floor does not read as wallpaper and few enough that the whole
 * stage still costs one draw call. Scenery here is cosmetic only — the breakable layer is its own thing
 * and does not come from this table.
 */
export interface StageArt {
  readonly floorFrames: readonly string[];
  readonly propFrames: readonly string[];
}

export const STAGE_ART: Readonly<Record<string, StageArt>> = {
  // Quiet floors on purpose. The first attempt used the bone-strewn and mossy tiles here and the floor
  // fought the enemies for attention — on a screen with two hundred things moving, the floor's only job
  // is to prove the player is moving at all.
  crypt: {
    floorFrames: ["tiles/icon-01", "tiles/icon-05", "tiles/icon-08", "tiles/icon-11"],
    propFrames: ["props/icon-05", "props/icon-06", "props/icon-11", "props/icon-08"],
  },
  ossuary: {
    floorFrames: ["tiles/icon-03", "tiles/icon-04", "tiles/icon-10", "tiles/icon-02"],
    propFrames: ["props/icon-03", "props/icon-08", "props/icon-12", "props/icon-05"],
  },
  marsh: {
    floorFrames: ["tiles/icon-06", "tiles/icon-07", "tiles/icon-09", "tiles/icon-12"],
    propFrames: ["props/icon-01", "props/icon-02", "props/icon-10", "props/icon-07"],
  },
};

/**
 * How big a thing is drawn compared with the picture it is drawn from.
 *
 * These are deliberately not tied to the sizes the simulation uses for hitting things. A sprite drawn the
 * exact size of its hitbox looks tiny beside the floor, and a hitbox grown to match a comfortable-looking
 * sprite makes the game feel unfair. So the picture is allowed to be bigger than the thing, and nothing in
 * here is ever read by the part of the game that decides what touched what.
 */
export const PLAYER_DRAW_SCALE = 1.15;
export const ENEMY_DRAW_SCALE = 1.7;
export const BOSS_DRAW_SCALE = 2.6;

/** The breakable things, in the order the simulation numbers them. */
export const BREAKABLE_FRAME: readonly string[] = [
  "props/icon-01", // crate
  "props/icon-03", // urn
  "props/icon-05", // gravestone
  "props/icon-07", // brazier
  "props/icon-09", // sarcophagus
];

/** The picture a chest is drawn as while it sits on the floor waiting to be walked into. */
export const CHEST_FRAME = "chests/icon-04";

/** Every picture name this table asks the sheet for. Used by the checks and by the atlas loader. */
export function allRunFrames(): string[] {
  const names = new Set<string>([WHITE_FRAME, CHEST_FRAME]);
  for (const name of Object.values(PLAYER_FRAME)) names.add(name);
  for (const name of Object.values(ENEMY_FRAME)) names.add(name);
  for (const name of Object.values(SHOT_FRAME)) names.add(name);
  for (const name of PICKUP_FRAME) names.add(name);
  for (const name of BREAKABLE_FRAME) names.add(name);
  for (const art of Object.values(STAGE_ART)) {
    for (const name of art.floorFrames) names.add(name);
    for (const name of art.propFrames) names.add(name);
  }
  return [...names].sort();
}

/** Every character, enemy and weapon the game has, so a check can prove none of them was left out. */
export function everythingThatNeedsArt(): { players: string[]; enemies: string[]; weapons: string[] } {
  return {
    players: CHARACTERS.map((c) => c.id),
    enemies: ENEMY_TYPES.map((e) => e.id),
    weapons: WEAPON_TYPES.map((w) => w.id),
  };
}
