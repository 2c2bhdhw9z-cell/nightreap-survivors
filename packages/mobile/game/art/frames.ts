/**
 * Which drawn icon stands for which thing in the game.
 *
 * The packer names cells after the folder and file they were drawn in — `icons/icon-11` — because that is
 * the only name that survives a redraw. This file is the one place where those names are tied to the
 * things the game actually talks about: a powerup, a character, the little lock badge. Everything else
 * asks here.
 *
 * WHY A TABLE AND NOT ARITHMETIC
 * The obvious shortcut is "the third powerup uses the third icon". That shortcut breaks silently the first
 * time an icon is inserted, redrawn out of order, or shared, and the failure is a shop where every row
 * shows the wrong picture and no test can tell. A table is longer to read and impossible to be quietly
 * wrong about: a missing entry is a failed check, not a wrong picture.
 *
 * NO UPGRADE SHARES A PICTURE ANY MORE
 * For a while three pairs shared one: raw force shared the fist, invulnerability shared the shield, crit
 * chance shared the dice. The three missing icons have since been drawn, so every one of the twenty-six
 * upgrades now has its own. The list of knowing shares below is deliberately kept and deliberately empty:
 * it is what makes an accidental share a failed check instead of a picture nobody notices is repeated.
 *
 * PURE
 * No React, no React Native, no image loading. This is a name table, so it can be checked by a test that
 * reads the packed sheet and proves every name in here is really in it.
 */

/** Every icon in the sheet is this square. The packer refuses anything else. */
export const ATLAS_CELL = 32;

/** The lock badge drawn over anything the player has not earned yet. */
export const LOCK_FRAME = "icons/icon-24";

/** A blank socket, drawn when a name cannot be resolved, so a hole is visible rather than invisible. */
export const MISSING_FRAME = "ui-parts/icon-01";

/**
 * Upgrade → icon.
 *
 * Keyed by the upgrade's own id, so a renamed upgrade fails loudly here instead of shifting every row by
 * one. The comment on a shared line names its partner.
 */
export const POWERUP_FRAME: Readonly<Record<string, string>> = Object.freeze({
  might: "icons/icon-01", // clenched gauntlet fist
  maxHealth: "icons/icon-03", // heart
  moveSpeed: "icons/icon-10", // winged boot
  recovery: "icons/icon-04", // vial
  armor: "icons/icon-02", // kite shield
  magnet: "icons/icon-11", // horseshoe magnet
  growth: "icons/icon-18", // scroll — learning, i.e. experience
  greed: "icons/icon-14", // pile of coins
  cooldown: "icons/icon-23", // burning candle — time running down
  area: "icons/icon-06", // rune circle
  speed: "icons/icon-07", // crossbow bolts
  duration: "icons/icon-05", // hourglass
  amount: "icons/icon-09", // fanned knives
  luck: "icons/icon-12", // clover
  critChance: "icons/icon-27", // dice struck by a red spark — a gamble that pays double
  critDamage: "icons/icon-15", // cracked skull
  pierce: "icons/icon-22", // key — it passes through
  knockback: "icons/icon-25", // gauntlet fist throwing force rings — shoving, not hitting
  iFrames: "icons/icon-26", // a figure and its ghosted afterimages — briefly not there to be hit
  gemValue: "icons/icon-13", // cyan gem shard
  revives: "icons/icon-16", // angel wing
  rerolls: "icons/icon-17", // dice — ask for a different hand
  skips: "icons/icon-21", // sealed letter — pass it on
  banishes: "icons/icon-19", // open satchel — put it away
  curse: "icons/icon-08", // violet smoke
  spawnRate: "icons/icon-20", // raven skull — more of them coming
});

/**
 * Character → portrait.
 *
 * Assigned by looking at the painted sheet against each character's own description, not by position:
 * the beak-masked one is the rot character, the bone-marked skull is the bone-counter, and so on.
 */
export const PORTRAIT_FRAME: Readonly<Record<string, string>> = Object.freeze({
  vesna: "portraits/icon-01", // hooded, a small lantern at the throat
  nyx: "portraits/icon-02", // young, dark, quick
  odrick: "portraits/icon-03", // bone-marked skull, bone necklace
  bram: "portraits/icon-04", // beaked plague mask, rot green
  ysolde: "portraits/icon-05", // pale scholar, quills in the hair
  maren: "portraits/icon-06", // broad, capped, heavy
  grust: "portraits/icon-07", // bone helm and chain
  sable: "portraits/icon-08", // wild dark hair, face half hidden
  // Painted later, in a second sheet of four, and assigned the same way — by looking at the drawing
  // against the character's own description, never by position.
  thane: "portraits/icon-09", // slate helm, narrow visor slit, chain at the shoulders
  hessa: "portraits/icon-10", // leather hood, gold tooth, coins at the throat
  orin: "portraits/icon-11", // gaunt, eyes closed, throat wrapped in bandages
  calla: "portraits/icon-12", // wide hood, violet eyes, a card in the hood band
  // Secret — shares sable until a thirteenth portrait is painted. Declared in SHARED_PORTRAIT_ICONS.
  mord: "portraits/icon-08",
});

/**
 * Arcana → symbol.
 *
 * Keyed by the arcana's own id, same as everything else here, and assigned by looking at the drawn
 * symbol against what the card actually does rather than by position in the sheet. Eighteen symbols
 * were drawn and eight are used; the rest are the post-launch arcanas, which is why the check below
 * proves every id has a symbol rather than proving every symbol has an id.
 */
export const ARCANA_FRAME: Readonly<Record<string, string>> = Object.freeze({
  twinToll: "arcana/icon-01", // paired bells
  graveBloom: "arcana/icon-02", // flower breaking through stone
  foolsVigil: "arcana/icon-03", // a single open eye
  theLongHour: "arcana/icon-04", // a clock face with too many hands
  paupersPurse: "arcana/icon-05", // cut purse spilling coin
  ironLitany: "arcana/icon-06", // chained tower shield
  reapersBargain: "arcana/icon-07", // scythe crossed with an hourglass
  shatteredReliquary: "arcana/icon-08", // a broken casket, light coming out of it
});

/** The symbol for an arcana, or the blank socket when the id is not one we know. */
export function arcanaFrame(id: string): string {
  return ARCANA_FRAME[id] ?? MISSING_FRAME;
}

/** Upgrades that knowingly share a picture with another upgrade. Checked, so it can never grow by accident. */
export const SHARED_POWERUP_ICONS: readonly string[] = Object.freeze([
  // Empty on purpose. Every upgrade has its own icon now, so any repeat in the table above is a mistake
  // and the check will say so. If a future pair really must share, both ids go here, in the same commit.
]);

/** Characters that knowingly share a portrait until dedicated art ships. */
export const SHARED_PORTRAIT_ICONS: readonly string[] = Object.freeze(["sable", "mord"]);

/** The icon for an upgrade, or the blank socket when the id is not one we know. */
export function powerupFrame(id: string): string {
  return POWERUP_FRAME[id] ?? MISSING_FRAME;
}

/** The portrait for a character, or the blank socket when the id is not one we know. */
export function portraitFrame(id: string): string {
  return PORTRAIT_FRAME[id] ?? MISSING_FRAME;
}

/** Every frame name this table can ever hand out. The test proves the sheet contains all of them. */
export function allNamedFrames(): string[] {
  const names = new Set<string>([LOCK_FRAME, MISSING_FRAME]);
  for (const name of Object.values(POWERUP_FRAME)) names.add(name);
  for (const name of Object.values(PORTRAIT_FRAME)) names.add(name);
  for (const name of Object.values(ARCANA_FRAME)) names.add(name);
  return [...names].sort();
}

/** A frame name is a set and a cell, nothing else. Anything else is a typo. */
export function looksLikeFrameName(name: string): boolean {
  return /^[a-z0-9-]+\/[a-z0-9-]+$/.test(name);
}
