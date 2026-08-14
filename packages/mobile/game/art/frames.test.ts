/**
 * Checks for the icon name table.
 *
 * The point of these: a wrong picture in a shop row is invisible to a compiler and obvious to a player.
 * So every name this table can hand out is looked up in the sheet that was actually packed, and every
 * upgrade and character in the game is required to have one.
 *
 * Run: bun game/art/frames.test.ts
 */

import { readFileSync } from "node:fs";

import { CHARACTERS } from "../characters/roster";
import { POWERUPS } from "../shop/powerups";
import { ARCANA_TYPES } from "../sim/arcanas";
import {
  ARCANA_FRAME,
  ATLAS_CELL,
  LOCK_FRAME,
  MISSING_FRAME,
  PORTRAIT_FRAME,
  POWERUP_FRAME,
  SHARED_POWERUP_ICONS,
  allNamedFrames,
  arcanaFrame,
  looksLikeFrameName,
  portraitFrame,
  powerupFrame,
} from "./frames";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

interface Manifest {
  width: number;
  height: number;
  cell: number;
  gutter: number;
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
  sets: Record<string, string[]>;
}

const manifestPath = `${import.meta.dir}/../../assets/atlas.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

console.log("the packed sheet this table points into");
check("the sheet has been packed", Object.keys(manifest.frames).length > 0);
check("its cells are the size the table expects", manifest.cell === ATLAS_CELL, `sheet says ${manifest.cell}`);
check("every cell in it is square and full size", Object.values(manifest.frames).every((f) => f.w === ATLAS_CELL && f.h === ATLAS_CELL));
check(
  "no cell in it hangs off the sheet",
  Object.values(manifest.frames).every(
    (f) => f.x >= 0 && f.y >= 0 && f.x + f.w <= manifest.width && f.y + f.h <= manifest.height,
  ),
);

console.log("names");
check("every name in the table is a set and a cell", allNamedFrames().every(looksLikeFrameName), allNamedFrames().filter((n) => !looksLikeFrameName(n)).join(", "));
check("a name with no set is not a name", !looksLikeFrameName("icon-01"));
check("a name with a capital letter is not a name", !looksLikeFrameName("Icons/icon-01"));
check("a name with two slashes is not a name", !looksLikeFrameName("a/b/c"));

const absent = allNamedFrames().filter((name) => !(name in manifest.frames));
check("every name the table can hand out is really in the sheet", absent.length === 0, `missing: ${absent.slice(0, 6).join(", ")}`);

console.log("every upgrade has a picture");
const upgradesWithout = POWERUPS.filter((power) => !(power.id in POWERUP_FRAME)).map((power) => power.id);
check("no upgrade is left without one", upgradesWithout.length === 0, `without: ${upgradesWithout.join(", ")}`);
check(
  "the table names no upgrade the game does not have",
  Object.keys(POWERUP_FRAME).every((id) => POWERUPS.some((power) => power.id === id)),
  Object.keys(POWERUP_FRAME).filter((id) => !POWERUPS.some((power) => power.id === id)).join(", "),
);
check("there are as many entries as upgrades", Object.keys(POWERUP_FRAME).length === POWERUPS.length, `${Object.keys(POWERUP_FRAME).length} vs ${POWERUPS.length}`);

// Sharing is allowed, but only where it was decided on purpose. An accidental share is two shop rows
// wearing the same picture, which reads as a bug in the shop rather than a gap in the art.
const seen = new Map<string, string[]>();
for (const [id, frame] of Object.entries(POWERUP_FRAME)) {
  const owners = seen.get(frame) ?? [];
  owners.push(id);
  seen.set(frame, owners);
}
const sharers = [...seen.values()].filter((owners) => owners.length > 1).flat().sort();
const declared = [...SHARED_POWERUP_ICONS].sort();
check(
  "the only upgrades sharing a picture are the ones we said would",
  sharers.length === new Set(sharers).size && sharers.every((id) => declared.includes(id)),
  `sharing: ${sharers.join(", ")} / declared: ${declared.join(", ")}`,
);
check("each declared sharer really is an upgrade", declared.every((id) => POWERUPS.some((power) => power.id === id)));
check(
  "no picture is worn by three upgrades at once",
  [...seen.values()].every((owners) => owners.length <= 2),
);

console.log("every character has a portrait");
const facelessCharacters = CHARACTERS.filter((who) => !(who.id in PORTRAIT_FRAME)).map((who) => who.id);
check("no character is left faceless", facelessCharacters.length === 0, `without: ${facelessCharacters.join(", ")}`);
check("there are as many portraits as characters", Object.keys(PORTRAIT_FRAME).length === CHARACTERS.length);
check(
  "the table names no character the game does not have",
  Object.keys(PORTRAIT_FRAME).every((id) => CHARACTERS.some((who) => who.id === id)),
);
check(
  "no two characters wear the same face",
  new Set(Object.values(PORTRAIT_FRAME)).size === Object.keys(PORTRAIT_FRAME).length,
);
check(
  "every portrait comes from the portraits sheet",
  Object.values(PORTRAIT_FRAME).every((frame) => frame.startsWith("portraits/")),
);
check(
  "every upgrade icon comes from the upgrade sheet",
  Object.values(POWERUP_FRAME).every((frame) => frame.startsWith("icons/")),
);

console.log("every arcana has a symbol");
const symbolless = ARCANA_TYPES.filter((card) => !(card.id in ARCANA_FRAME)).map((card) => card.id);
check("no arcana is left without a symbol", symbolless.length === 0, `without: ${symbolless.join(", ")}`);
check(
  "the table names no arcana the game does not have",
  Object.keys(ARCANA_FRAME).every((id) => ARCANA_TYPES.some((card) => card.id === id)),
);
check(
  "no two arcanas wear the same symbol",
  new Set(Object.values(ARCANA_FRAME)).size === Object.keys(ARCANA_FRAME).length,
);
check(
  "every arcana symbol comes from the arcana sheet",
  Object.values(ARCANA_FRAME).every((frame) => frame.startsWith("arcana/")),
);
check(
  "every arcana symbol is really in the packed sheet",
  Object.values(ARCANA_FRAME).every((frame) => frame in manifest.frames),
);
check("a known arcana resolves to its own symbol", arcanaFrame("twinToll") === ARCANA_FRAME.twinToll);
check("an arcana nobody has heard of draws the blank socket", arcanaFrame("nonsense") === MISSING_FRAME);

console.log("looking a name up");
check("a known upgrade resolves to its own icon", powerupFrame("luck") === POWERUP_FRAME.luck);
check("a known character resolves to their own portrait", portraitFrame("grust") === PORTRAIT_FRAME.grust);
check("an upgrade nobody has heard of draws the blank socket", powerupFrame("nonsense") === MISSING_FRAME);
check("a character nobody has heard of draws the blank socket", portraitFrame("nonsense") === MISSING_FRAME);
check("an empty id draws the blank socket rather than crashing", powerupFrame("") === MISSING_FRAME && portraitFrame("") === MISSING_FRAME);
check("the blank socket is itself in the sheet", MISSING_FRAME in manifest.frames);
check("the lock badge is in the sheet", LOCK_FRAME in manifest.frames);
check("the lock badge is not also an upgrade's icon", !Object.values(POWERUP_FRAME).includes(LOCK_FRAME));
check("the blank socket is not also an upgrade's icon", !Object.values(POWERUP_FRAME).includes(MISSING_FRAME));

console.log("the table cannot be edited at runtime");
const frozen = (() => {
  try {
    (POWERUP_FRAME as Record<string, string>).might = "icons/icon-24";
  } catch {
    return true;
  }
  return POWERUP_FRAME.might !== "icons/icon-24";
})();
check("an upgrade's icon cannot be swapped from somewhere else", frozen);

console.log("");
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`frames: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log("PASS — icon name table");
