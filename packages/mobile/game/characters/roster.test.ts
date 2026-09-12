/**
 * Character roster self-check. Run headless: `bun packages/mobile/game/characters/roster.test.ts`
 *
 * A roster is a table of numbers, and a wrong number in a table of numbers does not crash — it just makes
 * one character quietly better or worse than the other eleven forever. So these checks are mostly about the
 * kinds of wrongness that never announce themselves:
 *
 *   1. THE UNITS. `stats.ts` warns that reading a count as a permille is a silent 1000x error. Health is
 *      permille, armour is a count, and they sit two lines apart in the same table. The unit checks here are
 *      the only thing standing between "+2 armour" and "+2 thousandths of a point of armour".
 *   2. THE CONTENT CHECK ACTUALLY CHECKS. Every rule `contentFaults` claims to enforce is fed a broken
 *      roster and has to object. A content check that cannot fail is decoration.
 *   3. UNLOCKS OPEN AND STAY OPEN. A save whose unlock bit was never written — a migration, a sync from an
 *      older device — must still show what the player has plainly earned, and a locked pick must never be
 *      what a run starts with.
 *   4. GROWTH IS BOUNDED AND WHOLE. Steps land on the levels the card promises, never before level one, and
 *      never past the ceiling the card names.
 *   5. NOTHING THROWS ON JUNK. Levels and positions arrive from save files and network messages; a fractional
 *      or negative one must contribute nothing rather than ending a run that is otherwise fine.
 */

import { STAT, STAT_COUNT, STAT_SCALE } from "../sim/stats";
import { WEAPON_TYPES } from "../sim/weapons";
import { bitSet, createSaveData } from "../save/schema";
import {
  CHAR_UNLOCK,
  CHARACTER_COUNT,
  CHARACTERS,
  MAX_GROWTH_TIERS,
  characterAt,
  contentFaults,
  firstPlayable,
  growthCeiling,
  growthTiersAt,
  indexOfCharacter,
  isCharacterUnlocked,
  unlockedCount,
  unlockHint,
} from "./roster";

import type { Character } from "./roster";

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

/** A copy of the shipped roster with one character replaced, for feeding the content check bad content. */
function rosterWith(index: number, patch: Partial<Character>): readonly Character[] {
  const list = CHARACTERS.map((c) => ({ ...c }));
  list[index] = { ...list[index], ...patch };
  return list;
}

/** Stats that are raw counts, per the split written down in `stats.ts`. Everything else is permille. */
const COUNT_STATS = new Set<number>([
  STAT.amount,
  STAT.armor,
  STAT.pierce,
  STAT.iFrames,
  STAT.revives,
  STAT.rerolls,
  STAT.skips,
  STAT.banishes,
]);

/**
 * The largest a shift on each count stat could sensibly be.
 *
 * "A count stays under a hundred" is not enough on its own: 30 armour is a plausible-looking number and
 * would make a character unkillable, and 40 added to the untouchable window — which is counted in ticks,
 * sixty to the second — is most of a second of free standing in a crowd. Both would read as an ordinary
 * typo and neither would look broken. So each count carries its own ceiling, taken from what that number
 * means in the sim rather than from how big it looks in the table.
 */
const COUNT_CEILING = new Map<number, number>([
  [STAT.amount, 3],
  [STAT.armor, 6],
  [STAT.pierce, 5],
  [STAT.iFrames, 30],
  [STAT.revives, 3],
  [STAT.rerolls, 5],
  [STAT.skips, 5],
  [STAT.banishes, 5],
]);

// -------------------------------------------------------------------------------------------------
section("the shipped roster");

check("has thirteen characters (twelve launch + Mord)", CHARACTER_COUNT === 13, `${CHARACTER_COUNT}`);
check("passes its own content check", contentFaults().length === 0, contentFaults().join("; ") || "clean");

{
  const ids = new Set(CHARACTERS.map((c) => c.id));
  const names = new Set(CHARACTERS.map((c) => c.name));
  check("no two characters share an id", ids.size === CHARACTER_COUNT, `${ids.size}`);
  check("no two characters share a name", names.size === CHARACTER_COUNT, `${names.size}`);
}

{
  const weaponIds = new Set(WEAPON_TYPES.map((w) => w.id));
  let missing = 0;
  for (const c of CHARACTERS) {
    if (!weaponIds.has(c.startingWeaponId)) missing++;
  }
  check("every character starts with a weapon that exists", missing === 0, `${missing} missing`);
}

{
  // A character must not start holding an evolved weapon. An evolution is the reward for taking a weapon
  // to the top and finding the right item; handing one out at second zero would skip that entirely, and
  // the weapon would also have nothing left to evolve into.
  const evolved = CHARACTERS.filter((c) => {
    const w = WEAPON_TYPES.find((row) => row.id === c.startingWeaponId);
    return w !== undefined && w.evolvedFrom !== "";
  }).map((c) => c.id);
  check("nobody starts holding an evolved weapon", evolved.length === 0, evolved.join(", ") || "none do");
}

{
  // Thirteen characters sharing four starting weapons would be twelve coats of paint on four openings. The
  // floor is deliberately low — a shared starting weapon with different stats is a real difference — but a
  // roster this size has to open in more than a handful of ways.
  const starters = new Set(CHARACTERS.map((c) => c.startingWeaponId));
  check("the roster opens in at least ten different ways", starters.size >= 10, `${starters.size} starting weapons`);
}

{
  // Every character has to be gettable. A pick behind a condition nothing can satisfy is a locked slot the
  // player will stare at forever, and it would not look broken from the outside.
  const bad: string[] = [];
  for (const c of CHARACTERS) {
    if (c.unlock === CHAR_UNLOCK.ALWAYS) continue;
    if (c.unlockValue <= 0) bad.push(`${c.id} asks for ${c.unlockValue}`);
    // A run is thirty minutes at the very most, so a survival unlock above that can never fire.
    if (c.unlock === CHAR_UNLOCK.BEST_SECONDS && c.unlockValue > 30 * 60) bad.push(`${c.id} wants ${c.unlockValue}s`);
  }
  check("every locked character can actually be earned", bad.length === 0, bad.join("; ") || "all reachable");
}

{
  // Two characters with the same unlock and the same threshold arrive together, which wastes one of them:
  // whichever the player notices second feels like nothing happened. Same condition is fine, same number
  // on the same condition is not.
  const seen = new Set<string>();
  const clashes: string[] = [];
  for (const c of CHARACTERS) {
    if (c.unlock === CHAR_UNLOCK.ALWAYS) continue;
    const key = `${c.unlock}:${c.unlockValue}`;
    if (seen.has(key)) clashes.push(c.id);
    seen.add(key);
  }
  check("no two characters unlock at the same moment", clashes.length === 0, clashes.join(", ") || "all staggered");
}

{
  // Two characters with an identical set of shifts and an identical quirk are the same character twice.
  // Compared as sorted text so the order the shifts happen to be written in cannot hide a duplicate.
  const shapes = new Map<string, string>();
  const twins: string[] = [];
  for (const c of CHARACTERS) {
    const shifts = c.shifts.map((s) => `${s.stat}=${s.add}`).sort().join(",");
    const key = `${shifts}|${c.growth.stat}:${c.growth.add}:${c.growth.everyLevels}:${c.growth.maxTiers}`;
    const already = shapes.get(key);
    if (already !== undefined) twins.push(`${already} and ${c.id}`);
    shapes.set(key, c.id);
  }
  check("no character is another character twice over", twins.length === 0, twins.join("; ") || "all distinct");
}

{
  // Every unlock condition the roster uses has to be one the game measures. A condition nobody counts is a
  // character that never arrives, and `isCharacterUnlocked` would silently answer no forever.
  const known = new Set<number>(Object.values(CHAR_UNLOCK));
  const unknown = CHARACTERS.filter((c) => !known.has(c.unlock)).map((c) => c.id);
  check("every unlock condition is one the game counts", unknown.length === 0, unknown.join(", ") || "all known");
}

{
  let alwaysOn = 0;
  for (const c of CHARACTERS) {
    if (c.unlock === CHAR_UNLOCK.ALWAYS) alwaysOn++;
  }
  check("somebody is playable on a brand new save", alwaysOn > 0, `${alwaysOn} unlocked from the start`);
  check("  but not the whole roster", alwaysOn < CHARACTER_COUNT, `${alwaysOn} of ${CHARACTER_COUNT}`);
}

{
  // A roster where one pick is strictly better than the rest is a roster with seven decorations. Every
  // character except the deliberate plain starter pays for its strengths with a weakness.
  let freebies = 0;
  for (const c of CHARACTERS) {
    let good = 0;
    let bad = 0;
    for (const s of c.shifts) {
      // Cooldown is the one stat where lower is better, so its sign reads backwards.
      const better = s.stat === STAT.cooldown ? s.add < 0 : s.add > 0;
      if (better) good++;
      else bad++;
    }
    check(`${c.id} has a strength`, good > 0, `${good} good, ${bad} bad`);
    if (bad === 0) freebies++;
  }
  check("at most one character has no downside", freebies <= 1, `${freebies}`);
}

// -------------------------------------------------------------------------------------------------
section("the units — the silent 1000x error");

for (const c of CHARACTERS) {
  for (const s of c.shifts) {
    const whole = Number.isSafeInteger(s.add);
    check(`${c.id} shift on stat ${s.stat} is a whole number`, whole, `${s.add}`);
    if (COUNT_STATS.has(s.stat)) {
      // A count shift the size of a permille one is the mistake this check exists for: "+2 armour" written
      // as 2000 would be forty times the game's own armour cap.
      check(`  ${c.id} count shift stays a count`, Math.abs(s.add) <= 100, `${s.add}`);
      const ceiling = COUNT_CEILING.get(s.stat) ?? 100;
      check(`  ${c.id} count shift stays inside what that count can mean`, Math.abs(s.add) <= ceiling, `${s.add} vs ${ceiling}`);
    } else {
      // A permille shift smaller than a tenth of a percent cannot have been meant: it is a count written
      // where a permille belongs.
      check(`  ${c.id} permille shift is permille-sized`, Math.abs(s.add) >= STAT_SCALE / 100, `${s.add}`);
    }
  }
  const hp = c.shifts.find((s) => s.stat === STAT.maxHealth);
  if (hp !== undefined) {
    check(`${c.id} health shift is a whole number of hit points`, hp.add % STAT_SCALE === 0, `${hp.add}`);
  }
  if (COUNT_STATS.has(c.growth.stat)) {
    check(`${c.id} growth step stays a count`, c.growth.add <= 100, `${c.growth.add}`);
    const ceiling = COUNT_CEILING.get(c.growth.stat) ?? 100;
    const total = growthCeiling(c);
    check(`  ${c.id} growth quirk stays inside what that count can mean`, total <= ceiling, `${total} vs ${ceiling}`);
  } else {
    check(`${c.id} growth step is permille-sized`, c.growth.add >= STAT_SCALE / 100, `${c.growth.add}`);
  }
}

{
  // Crit chance is capped at 100%, so a character whose starting crit plus its whole growth quirk would
  // exceed the cap is promising a number the sim will clamp away.
  const sable = CHARACTERS[indexOfCharacter("sable")];
  const start = sable.shifts.find((s) => s.stat === STAT.critChance)?.add ?? 0;
  const total = start + growthCeiling(sable);
  check("the crit character never promises past 100%", total <= STAT_SCALE, `${total} permille`);
}

// -------------------------------------------------------------------------------------------------
section("the content check can actually fail");

check("a missing starting weapon is caught", contentFaults(rosterWith(0, { startingWeaponId: "nope" })).length > 0);
check("a duplicate id is caught", contentFaults(rosterWith(1, { id: CHARACTERS[0].id })).length > 0);
check("a duplicate name is caught", contentFaults(rosterWith(1, { name: CHARACTERS[0].name })).length > 0);
check("an empty name is caught", contentFaults(rosterWith(2, { name: "  " })).length > 0);
check("an empty blurb is caught", contentFaults(rosterWith(2, { blurb: "" })).length > 0);
check("an empty title is caught", contentFaults(rosterWith(2, { title: "" })).length > 0);
check("a character that changes nothing is caught", contentFaults(rosterWith(3, { shifts: [] })).length > 0);
check(
  "a shift worth zero is caught",
  contentFaults(rosterWith(3, { shifts: [{ stat: STAT.damage, add: 0 }] })).length > 0,
);
check(
  "a shift on a stat that does not exist is caught",
  contentFaults(rosterWith(3, { shifts: [{ stat: STAT_COUNT + 5, add: 100 }] })).length > 0,
);
check(
  "a fractional shift is caught",
  contentFaults(rosterWith(3, { shifts: [{ stat: STAT.damage, add: 10.5 }] })).length > 0,
);
check(
  "the same stat shifted twice is caught",
  contentFaults(
    rosterWith(3, {
      shifts: [
        { stat: STAT.damage, add: 100 },
        { stat: STAT.damage, add: -50 },
      ],
    }),
  ).length > 0,
);
check(
  "a growth gap of zero levels is caught",
  contentFaults(rosterWith(4, { growth: { ...CHARACTERS[4].growth, everyLevels: 0 } })).length > 0,
);
check(
  "a growth step worth nothing is caught",
  contentFaults(rosterWith(4, { growth: { ...CHARACTERS[4].growth, add: 0 } })).length > 0,
);
check(
  "a growth quirk with no steps is caught",
  contentFaults(rosterWith(4, { growth: { ...CHARACTERS[4].growth, maxTiers: 0 } })).length > 0,
);
check(
  "more growth steps than the wire ids allow is caught",
  contentFaults(rosterWith(4, { growth: { ...CHARACTERS[4].growth, maxTiers: MAX_GROWTH_TIERS + 1 } })).length > 0,
);
check(
  "a growth quirk on a stat that does not exist is caught",
  contentFaults(rosterWith(4, { growth: { ...CHARACTERS[4].growth, stat: -3 } })).length > 0,
);
check(
  "a growth quirk with no blurb is caught",
  contentFaults(rosterWith(4, { growth: { ...CHARACTERS[4].growth, blurb: " " } })).length > 0,
);
{
  const allLocked = CHARACTERS.map((c) => ({ ...c, unlock: CHAR_UNLOCK.RUNS_COMPLETED, unlockValue: 5 }));
  check("a roster nobody can play on a new save is caught", contentFaults(allLocked).length > 0);
}

// -------------------------------------------------------------------------------------------------
section("growth steps land where the card says");

{
  const c = CHARACTERS[0];
  const every = c.growth.everyLevels;
  check("level one has earned nothing", growthTiersAt(c, 1) === 0, `${growthTiersAt(c, 1)}`);
  check("the level before the first step has earned nothing", growthTiersAt(c, every) === 0);
  check("the first step lands on the promised level", growthTiersAt(c, every + 1) === 1);
  check("the second step lands one gap later", growthTiersAt(c, every * 2 + 1) === 2);
  check("halfway between steps holds the earlier one", growthTiersAt(c, every + 2) === 1);
  check(
    "a level far past the end clamps to the ceiling",
    growthTiersAt(c, 10_000) === c.growth.maxTiers,
    `${growthTiersAt(c, 10_000)} of ${c.growth.maxTiers}`,
  );
  check("the very last step is reachable", growthTiersAt(c, every * c.growth.maxTiers + 1) === c.growth.maxTiers);
  check("a fractional level floors rather than rounding up", growthTiersAt(c, every + 0.9) === 0);
  check("level zero earns nothing", growthTiersAt(c, 0) === 0);
  check("a negative level earns nothing", growthTiersAt(c, -40) === 0);
  check("a level that is not a number earns nothing", growthTiersAt(c, Number.NaN) === 0);
  check("an infinite level earns nothing rather than everything", growthTiersAt(c, Number.POSITIVE_INFINITY) === 0);
  check("the ceiling is the step times the count", growthCeiling(c) === c.growth.add * c.growth.maxTiers);
}

// -------------------------------------------------------------------------------------------------
section("looking characters up");

check("a known id resolves to its position", indexOfCharacter(CHARACTERS[3].id) === 3);
check("an unknown id is -1 rather than 0", indexOfCharacter("nobody") === -1);
check("an empty id is -1", indexOfCharacter("") === -1);
check("a position in range resolves", characterAt(2)?.id === CHARACTERS[2].id);
check("a position past the end is undefined", characterAt(CHARACTER_COUNT) === undefined);
check("a negative position is undefined", characterAt(-1) === undefined);
check("a fractional position is undefined", characterAt(1.5) === undefined);
check("a position that is not a number is undefined", characterAt(Number.NaN) === undefined);

// -------------------------------------------------------------------------------------------------
section("unlocks on a brand new save");

{
  const save = createSaveData();
  for (let i = 0; i < CHARACTER_COUNT; i++) {
    const c = CHARACTERS[i];
    const open = isCharacterUnlocked(save, i);
    check(
      `${c.id} is ${c.unlock === CHAR_UNLOCK.ALWAYS ? "open" : "locked"} on a new save`,
      open === (c.unlock === CHAR_UNLOCK.ALWAYS),
      open ? "open" : "locked",
    );
  }
  check("a position off the end of the roster is never unlocked", !isCharacterUnlocked(save, 999));
  check("a negative position is never unlocked", !isCharacterUnlocked(save, -2));
  check(
    "the count agrees with the individual answers",
    unlockedCount(save) === CHARACTERS.filter((c) => c.unlock === CHAR_UNLOCK.ALWAYS).length,
    `${unlockedCount(save)}`,
  );
}

section("unlocks earned, and unlocks granted");

{
  const gold = CHARACTERS.findIndex((c) => c.unlock === CHAR_UNLOCK.LIFETIME_GOLD);
  const runs = CHARACTERS.findIndex((c) => c.unlock === CHAR_UNLOCK.RUNS_COMPLETED);
  const secs = CHARACTERS.findIndex((c) => c.unlock === CHAR_UNLOCK.BEST_SECONDS);
  check("the roster uses all three unlock conditions", gold >= 0 && runs >= 0 && secs >= 0, `${gold} ${runs} ${secs}`);

  {
    const save = createSaveData();
    save.goldLifetime = CHARACTERS[gold].unlockValue - 1;
    check("one gold short stays locked", !isCharacterUnlocked(save, gold));
    save.goldLifetime = CHARACTERS[gold].unlockValue;
    check("exactly on the threshold opens", isCharacterUnlocked(save, gold));
  }
  {
    const save = createSaveData();
    save.runsCompleted = CHARACTERS[runs].unlockValue - 1;
    check("one run short stays locked", !isCharacterUnlocked(save, runs));
    save.runsCompleted = CHARACTERS[runs].unlockValue + 5;
    check("past the threshold opens", isCharacterUnlocked(save, runs));
  }
  {
    const save = createSaveData();
    save.bestSurvivalSeconds = CHARACTERS[secs].unlockValue - 1;
    check("one second short stays locked", !isCharacterUnlocked(save, secs));
    save.bestSurvivalSeconds = CHARACTERS[secs].unlockValue;
    check("exactly on the time opens", isCharacterUnlocked(save, secs));
  }
  {
    // The bit is the other way in: a gift, an achievement, or a save whose condition has since been raised.
    const save = createSaveData();
    bitSet(save.unlockedCharacters, secs, true);
    check("the unlock bit opens somebody the numbers do not", isCharacterUnlocked(save, secs));
    check("  and it does not open anybody else", !isCharacterUnlocked(save, gold));
  }
}

section("what a select screen starts on");

{
  const save = createSaveData();
  const locked = CHARACTERS.findIndex((c) => c.unlock !== CHAR_UNLOCK.ALWAYS);
  check("an unlocked preference is kept", firstPlayable(save, 0) === 0);
  check("a locked preference falls back to somebody owned", firstPlayable(save, locked) !== locked);
  check("  and the fallback is genuinely playable", isCharacterUnlocked(save, firstPlayable(save, locked)));
  check("a preference off the end of the roster falls back", isCharacterUnlocked(save, firstPlayable(save, 500)));
  const nobody = CHARACTERS.map((c) => ({ ...c, unlock: CHAR_UNLOCK.RUNS_COMPLETED, unlockValue: 99 }));
  check("a roster with nobody playable answers -1 rather than zero", firstPlayable(save, 0, nobody) === -1);
}

section("the words on a locked row");

for (const c of CHARACTERS) {
  const hint = unlockHint(c);
  check(`${c.id} explains itself`, hint.trim().length > 0 && hint.endsWith("."), hint);
  if (c.unlock === CHAR_UNLOCK.LIFETIME_GOLD || c.unlock === CHAR_UNLOCK.RUNS_COMPLETED) {
    // "Finish 1 runs" is worse English than "Finish a run", so a threshold of one is allowed to say so in
    // words. Every other threshold has to print the actual number the player is chasing.
    const named = c.unlockValue === 1 ? hint.includes(" a ") : hint.includes(String(c.unlockValue));
    check(`  ${c.id} names its number`, named, hint);
  }
  if (c.unlock === CHAR_UNLOCK.BEST_SECONDS) {
    check(`  ${c.id} says minutes, not seconds`, hint.includes("minutes"), hint);
  }
}

console.log(failures === 0 ? "\nPASS — character roster" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`character roster: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
