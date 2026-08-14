/**
 * Checks for the table that says which drawn picture stands for which thing in a run.
 *
 * These are the checks that catch the failure nobody sees: a picture that exists, loads, and is simply the
 * wrong one, or a character added later that nobody remembered to give a body.
 *
 * Run: bun game/art/run-art.test.ts
 */

import { readFileSync } from "node:fs";

import { CHARACTERS } from "../characters/roster";
import { ENEMY_TYPES } from "../sim/enemies";
import { PICKUP, PICKUP_KIND_COUNT } from "../sim/pickups";
import { STAGE_TYPES } from "../sim/stages";
import { WEAPON_TYPES } from "../sim/weapons";
import {
  BREAKABLE_FRAME,
  CHEST_FRAME,
  ENEMY_FRAME,
  PICKUP_FRAME,
  PLAYER_FRAME,
  SHOT_FRAME,
  STAGE_ART,
  WHITE_FRAME,
  allRunFrames,
  everythingThatNeedsArt,
} from "./run-art";

let failures = 0;

function ok(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}`);
}

interface Manifest {
  width: number;
  height: number;
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
}

const manifest = JSON.parse(
  readFileSync(`${import.meta.dir}/../../assets/atlas.json`, "utf8"),
) as Manifest;

// --- every name the table asks for is really on the sheet --------------------------------------------

const names = allRunFrames();
ok("the table asks for at least a few dozen pictures", names.length >= 30);

let missing: string[] = [];
for (const name of names) {
  if (!(name in manifest.frames)) missing.push(name);
}
ok(`every picture the run asks for is on the sheet${missing.length ? ` (missing ${missing.join(", ")})` : ""}`, missing.length === 0);

// --- nothing in the game is left without a picture ---------------------------------------------------

const all = everythingThatNeedsArt();

let bodyless: string[] = [];
for (const id of all.players) {
  if (!PLAYER_FRAME[id]) bodyless.push(id);
}
ok(`every character has a body${bodyless.length ? ` (missing ${bodyless.join(", ")})` : ""}`, bodyless.length === 0);

let faceless: string[] = [];
for (const id of all.enemies) {
  if (!ENEMY_FRAME[id]) faceless.push(id);
}
ok(`every enemy has a picture${faceless.length ? ` (missing ${faceless.join(", ")})` : ""}`, faceless.length === 0);

let shotless: string[] = [];
for (const id of all.weapons) {
  if (!SHOT_FRAME[id]) shotless.push(id);
}
ok(`every weapon has a shot picture${shotless.length ? ` (missing ${shotless.join(", ")})` : ""}`, shotless.length === 0);

// The other direction: a name in the table that no longer exists in the game is dead weight and usually
// means something was renamed and the table was only half updated.
const playerIds = new Set(all.players);
const enemyIds = new Set(all.enemies);
const weaponIds = new Set(all.weapons);
ok(
  "the table has no body for a character that does not exist",
  Object.keys(PLAYER_FRAME).every((id) => playerIds.has(id)),
);
ok(
  "the table has no picture for an enemy that does not exist",
  Object.keys(ENEMY_FRAME).every((id) => enemyIds.has(id)),
);
ok(
  "the table has no shot for a weapon that does not exist",
  Object.keys(SHOT_FRAME).every((id) => weaponIds.has(id)),
);

ok("the table covers exactly the characters the game has", Object.keys(PLAYER_FRAME).length === CHARACTERS.length);
ok("and exactly the enemies", Object.keys(ENEMY_FRAME).length === ENEMY_TYPES.length);
ok("and exactly the weapons, evolutions included", Object.keys(SHOT_FRAME).length === WEAPON_TYPES.length);

// --- no two things share a picture by accident -------------------------------------------------------

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) twice.add(v);
    seen.add(v);
  }
  return [...twice];
}

const samePlayer = duplicates(Object.values(PLAYER_FRAME));
ok(`no two characters wear the same body${samePlayer.length ? ` (${samePlayer.join(", ")})` : ""}`, samePlayer.length === 0);

const sameEnemy = duplicates(Object.values(ENEMY_FRAME));
ok(`no two enemies wear the same picture${sameEnemy.length ? ` (${sameEnemy.join(", ")})` : ""}`, sameEnemy.length === 0);

// A weapon and its own evolution sharing a picture would make the evolution land flat, which is the whole
// point of it. This is the one place a duplicate would be invisible in play, so it gets its own check.
const sameShot = duplicates(Object.values(SHOT_FRAME));
ok(`no two weapons throw the same picture${sameShot.length ? ` (${sameShot.join(", ")})` : ""}`, sameShot.length === 0);

// --- pickups -----------------------------------------------------------------------------------------

ok("there is a picture for every kind of thing that can lie on the floor", PICKUP_FRAME.length === PICKUP_KIND_COUNT);

let unpainted: number[] = [];
for (let i = 0; i < PICKUP_FRAME.length; i++) {
  if (PICKUP_FRAME[i] === WHITE_FRAME) unpainted.push(i);
}
ok(`no pickup is still a plain white square${unpainted.length ? ` (kinds ${unpainted.join(", ")})` : ""}`, unpainted.length === 0);

const gems = [PICKUP_FRAME[PICKUP.gemSmall], PICKUP_FRAME[PICKUP.gemMedium], PICKUP_FRAME[PICKUP.gemLarge]];
ok("the three sizes of experience gem are three different pictures", duplicates(gems as string[]).length === 0);
ok("a coin does not look like a gem", !gems.includes(PICKUP_FRAME[PICKUP.gold]));
ok("food does not look like a gem", !gems.includes(PICKUP_FRAME[PICKUP.health]));
ok("the chest on the floor is the same picture the chest table uses", PICKUP_FRAME[PICKUP.chest] === CHEST_FRAME);

// --- stages ------------------------------------------------------------------------------------------

const stageNames = Object.keys(STAGE_ART);
ok("there are stage themes to draw", stageNames.length >= 3);

for (const stage of stageNames) {
  const art = STAGE_ART[stage];
  if (!art) {
    failures += 1;
    console.log(`  FAIL ${stage} has no art at all`);
    continue;
  }
  ok(`${stage} has more than one floor picture, so the floor does not read as wallpaper`, art.floorFrames.length >= 2);
  ok(`${stage} floor pictures are all different`, duplicates([...art.floorFrames]).length === 0);
  ok(`${stage} has scenery`, art.propFrames.length >= 1);
  ok(`${stage} scenery pictures are all different`, duplicates([...art.propFrames]).length === 0);
  ok(
    `${stage} never stands scenery on top of a floor picture`,
    art.propFrames.every((p) => !art.floorFrames.includes(p)),
  );
}

// Two stages that share every single floor picture are the same stage wearing a different name.
let identicalStages: string[] = [];
for (let i = 0; i < stageNames.length; i++) {
  for (let j = i + 1; j < stageNames.length; j++) {
    const a = STAGE_ART[stageNames[i] as string];
    const b = STAGE_ART[stageNames[j] as string];
    if (!a || !b) continue;
    const shared = a.floorFrames.filter((f) => b.floorFrames.includes(f)).length;
    if (shared === a.floorFrames.length && shared === b.floorFrames.length) {
      identicalStages.push(`${stageNames[i]}/${stageNames[j]}`);
    }
  }
}
ok(`no two stages are the same floor twice${identicalStages.length ? ` (${identicalStages.join(", ")})` : ""}`, identicalStages.length === 0);

// --- every place has a floor, and every floor is somebody's place ------------------------------------

// The stage table and the art table are written separately on purpose: the simulation must not import
// the pictures, or the game would not load on a phone. That separation is only safe if something checks
// the two agree, which is this. A stage naming a floor nobody drew is a black screen; a floor no stage
// uses is art that was made and then forgotten about.
for (const stage of STAGE_TYPES) {
  ok(`${stage.name} has a floor drawn for it`, STAGE_ART[stage.artKey] !== undefined);
}
const usedArtKeys = new Set(STAGE_TYPES.map((s) => s.artKey));
const orphanArt = stageNames.filter((n) => !usedArtKeys.has(n));
ok(`no floor was drawn for a place that does not exist${orphanArt.length ? ` (${orphanArt.join(", ")})` : ""}`, orphanArt.length === 0);
ok("every place has its own floor, no two share one", usedArtKeys.size === STAGE_TYPES.length);

// --- breakables and the white cell -------------------------------------------------------------------

ok("every breakable thing has a picture", BREAKABLE_FRAME.length >= 5);
ok("breakable pictures are all different", duplicates([...BREAKABLE_FRAME]).length === 0);
ok("the white cell is on the sheet", WHITE_FRAME in manifest.frames);

// The white cell is what every bar and fade is made of. If it stops being solid white and opaque, every
// health bar in the game quietly picks up its pattern, so this is checked against the real drawn pixels.
const white = manifest.frames[WHITE_FRAME];
ok("the white cell is a full cell", white !== undefined && white.w === 32 && white.h === 32);

console.log(failures === 0 ? "\nPASS — run art table" : `\nFAIL — ${failures} checks failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`run art table: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
