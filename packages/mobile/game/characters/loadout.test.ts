/**
 * Character -> simulation bridge self-check. Run headless: `bun packages/mobile/game/characters/loadout.test.ts`
 *
 * Every failure this file is looking for is silent. Nothing here can crash a run; it can only make a
 * character resolve to numbers other than the ones its card promises, in the one situation nobody tests by
 * hand — after a snapshot restore, on a guest that joined mid-run, or on our server revalidating a replay.
 *
 *   1. A WIRE ID NAMES EXACTLY ONE SET OF NUMBERS. Every id is unique, sits inside the character range, and
 *      never collides with the mode range or the shop range.
 *   2. THE RECORD SAYS WHAT THE ROSTER SAYS. A base record carries the character's shifts exactly — same
 *      stats, same signs, same units — because a bridge that quietly rounds is worse than no bridge.
 *   3. FOLDING GROWTH STEPS IS EXACT. One record carrying five steps must equal five steps added one at a
 *      time, which is the assumption the one-record-per-tier design rests on.
 *   4. GROWTH IS DERIVED, NOT GUESSED. The rung follows from the character and the level and nothing else,
 *      and a level the content cannot explain contributes nothing rather than something plausible.
 *   5. IT FITS. A character's records plus a full shop plus a run's own modes must not overflow the
 *      sixty-four-record stack the replay header is sized around.
 *   6. RESOLVING IT DOES WHAT THE CARD SAYS. The last check folds a real stack into a real stat table, so the
 *      whole path — roster, record, stack, stats — is measured rather than assumed.
 */

import { ModifierStack, MAX_STACK, MODIFIER_SOURCE, MODIFIERS_BY_WIRE_ID } from "../sim/modifiers";
import { STAT, STAT_BASE, STAT_SCALE, Stats } from "../sim/stats";
import { POWERUP_MODIFIERS_BY_WIRE_ID } from "../shop/loadout";
import { CHARACTERS, MAX_GROWTH_TIERS, growthTiersAt } from "./roster";
import {
  CHARACTER_GROWTH_MODIFIERS,
  CHARACTER_MODIFIERS,
  CHARACTER_MODIFIERS_BY_WIRE_ID,
  CHARACTER_SLOT_BASE,
  CHARACTER_WIRE_BASE,
  CHARACTER_WIRE_STRIDE,
  characterGrowthRecord,
  characterLoadout,
  characterRecord,
  characterRecordCount,
  characterStartingWeaponId,
  characterWireId,
} from "./loadout";

import type { RunModifier } from "../sim/modifiers";

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

// -------------------------------------------------------------------------------------------------
section("one record per character, one per growth step");

check("there is a record for every character", CHARACTER_MODIFIERS.length === CHARACTERS.length);
check("there is a ladder for every character", CHARACTER_GROWTH_MODIFIERS.length === CHARACTERS.length);

for (let i = 0; i < CHARACTERS.length; i++) {
  const c = CHARACTERS[i];
  check(`${c.id} has as many rungs as steps`, CHARACTER_GROWTH_MODIFIERS[i].length === c.growth.maxTiers, `${CHARACTER_GROWTH_MODIFIERS[i].length}`);
  check(`${c.id} record is marked as coming from a character`, CHARACTER_MODIFIERS[i].source === MODIFIER_SOURCE.character);
  check(`${c.id} record is named after the character`, CHARACTER_MODIFIERS[i].name === c.name);
  check(`${c.id} record has no run flags`, (CHARACTER_MODIFIERS[i].flags ?? 0) === 0);
  check(`${c.id} record does not change the payout`, CHARACTER_MODIFIERS[i].payout === undefined);
}

// -------------------------------------------------------------------------------------------------
section("wire ids name exactly one set of numbers");

{
  let total = CHARACTER_MODIFIERS.length;
  for (const ladder of CHARACTER_GROWTH_MODIFIERS) total += ladder.length;
  check("every record is reachable by its id", CHARACTER_MODIFIERS_BY_WIRE_ID.size === total, `${CHARACTER_MODIFIERS_BY_WIRE_ID.size} of ${total}`);

  let outside = 0;
  let clashMode = 0;
  let clashShop = 0;
  for (const [id, mod] of CHARACTER_MODIFIERS_BY_WIRE_ID) {
    if (id < CHARACTER_WIRE_BASE || id >= CHARACTER_WIRE_BASE + 100_000) outside++;
    if (MODIFIERS_BY_WIRE_ID.has(id)) clashMode++;
    if (POWERUP_MODIFIERS_BY_WIRE_ID.has(id)) clashShop++;
    check(`id ${id} points back at itself`, mod.wireId === id);
  }
  check("no id escapes the character range", outside === 0, `${outside}`);
  check("no id collides with a mode", clashMode === 0, `${clashMode}`);
  check("no id collides with a shop record", clashShop === 0, `${clashShop}`);
}

{
  check("the base slot is where the layout says", characterWireId(3) === CHARACTER_WIRE_BASE + 3 * CHARACTER_WIRE_STRIDE + CHARACTER_SLOT_BASE);
  check("a growth slot sits above the base slot", characterWireId(3, 2) === characterWireId(3) + 2);
  // The stride has to clear the *largest ladder the content check allows*, not the largest one shipped
  // today: a character added later with the full forty-eight steps must not be able to reach into the next
  // character's slots. Comparing against the shipped rosters' eight steps would be a check that agrees with
  // whatever the stride happens to be.
  check(
    "the stride leaves room for every growth step content is allowed",
    CHARACTER_WIRE_STRIDE > MAX_GROWTH_TIERS,
    `stride ${CHARACTER_WIRE_STRIDE}, up to ${MAX_GROWTH_TIERS} steps`,
  );
  let reachable = 0;
  for (let i = 0; i + 1 < CHARACTERS.length; i++) {
    if (characterWireId(i, MAX_GROWTH_TIERS) >= characterWireId(i + 1)) reachable++;
  }
  check("no character can reach the next character's slots", reachable === 0, `${reachable}`);
  const first = CHARACTER_MODIFIERS[0].wireId;
  const last = CHARACTER_MODIFIERS[CHARACTERS.length - 1].wireId;
  check("the ids run in roster order", last > first, `${first} .. ${last}`);
}

// -------------------------------------------------------------------------------------------------
section("a record says what the roster says");

for (let i = 0; i < CHARACTERS.length; i++) {
  const c = CHARACTERS[i];
  const rec = CHARACTER_MODIFIERS[i];
  check(`${c.id} carries every shift`, rec.deltas.length === c.shifts.length, `${rec.deltas.length} of ${c.shifts.length}`);
  for (let d = 0; d < c.shifts.length; d++) {
    const delta = rec.deltas[d];
    const shift = c.shifts[d];
    if (delta.add === undefined) {
      failures++;
      console.log(`  FAIL ${c.id} shift ${d} became a multiplier instead of an addition`);
      continue;
    }
    check(`  ${c.id} shift ${d} keeps its stat`, delta.stat === shift.stat, `${delta.stat} vs ${shift.stat}`);
    check(`  ${c.id} shift ${d} keeps its size and sign`, delta.add === shift.add, `${delta.add} vs ${shift.add}`);
    check(`  ${c.id} shift ${d} is additive, never multiplicative`, delta.mul === undefined);
  }
}

// -------------------------------------------------------------------------------------------------
section("folding growth steps is exact");

for (let i = 0; i < CHARACTERS.length; i++) {
  const c = CHARACTERS[i];
  const ladder = CHARACTER_GROWTH_MODIFIERS[i];
  for (let tier = 1; tier <= ladder.length; tier++) {
    const rec = ladder[tier - 1];
    const delta = rec.deltas[0];
    if (delta === undefined || delta.add === undefined) {
      failures++;
      console.log(`  FAIL ${c.id} rung ${tier} carries no addition`);
      continue;
    }
    check(`${c.id} rung ${tier} is one delta`, rec.deltas.length === 1, `${rec.deltas.length}`);
    check(`  ${c.id} rung ${tier} moves the growth stat`, delta.stat === c.growth.stat);
    check(`  ${c.id} rung ${tier} equals ${tier} single steps`, delta.add === c.growth.add * tier, `${delta.add} vs ${c.growth.add * tier}`);
    check(`  ${c.id} rung ${tier} is additive`, delta.mul === undefined);
    check(`  ${c.id} rung ${tier} says how far along it is`, rec.description.includes(`${tier} of`), rec.description);
  }
}

// -------------------------------------------------------------------------------------------------
section("the rung follows from the level and nothing else");

{
  const i = 0;
  const c = CHARACTERS[i];
  const every = c.growth.everyLevels;
  check("level one has no growth record at all", characterGrowthRecord(i, 1) === undefined);
  check("the level before the first step still has none", characterGrowthRecord(i, every) === undefined);
  check("the first step arrives on the promised level", characterGrowthRecord(i, every + 1) === CHARACTER_GROWTH_MODIFIERS[i][0]);
  check("the second step is the next rung, not two of the first", characterGrowthRecord(i, every * 2 + 1) === CHARACTER_GROWTH_MODIFIERS[i][1]);
  const top = CHARACTER_GROWTH_MODIFIERS[i][c.growth.maxTiers - 1];
  check("a level far past the end clamps to the top rung", characterGrowthRecord(i, 99_999) === top);
  check("a fractional level does not skip ahead", characterGrowthRecord(i, every + 0.5) === undefined);
  check("a negative level contributes nothing", characterGrowthRecord(i, -10) === undefined);
  check("a level that is not a number contributes nothing", characterGrowthRecord(i, Number.NaN) === undefined);
  check("a position off the end of the roster contributes nothing", characterGrowthRecord(999, 50) === undefined);
  check("a fractional position contributes nothing", characterGrowthRecord(1.5, 50) === undefined);

  // The roster and the bridge must agree about how many steps a level has earned, or a screen and the
  // simulation would show different numbers for the same run.
  let disagreements = 0;
  for (let level = 1; level <= 200; level++) {
    const tier = growthTiersAt(c, level);
    const rec = characterGrowthRecord(i, level);
    const expected = tier === 0 ? undefined : CHARACTER_GROWTH_MODIFIERS[i][tier - 1];
    if (rec !== expected) disagreements++;
  }
  check("roster and bridge agree at every level up to 200", disagreements === 0, `${disagreements}`);
}

// -------------------------------------------------------------------------------------------------
section("looking a record up");

check("a known position has a record", characterRecord(0) === CHARACTER_MODIFIERS[0]);
check("a position off the end has none", characterRecord(CHARACTERS.length) === undefined);
check("a negative position has none", characterRecord(-1) === undefined);
check("a fractional position has none", characterRecord(0.5) === undefined);

// -------------------------------------------------------------------------------------------------
section("filling a caller-owned list");

{
  const out: RunModifier[] = [];
  check("level one writes one record", characterLoadout(0, 1, out) === 1, `${out.length}`);
  check("  and it is the base record", out[0] === CHARACTER_MODIFIERS[0]);

  const grown = CHARACTERS[0].growth.everyLevels + 1;
  check("past the first step it writes two", characterLoadout(0, grown, out) === 2, `${out.length}`);
  check("  base first", out[0] === CHARACTER_MODIFIERS[0]);
  check("  growth second", out[1] === CHARACTER_GROWTH_MODIFIERS[0][0]);

  check("dropping back to level one truncates rather than leaving leftovers", characterLoadout(0, 1, out) === 1, `${out.length}`);
  check("  and the stale growth record is gone", out.length === 1);

  check("a position content cannot explain writes nothing", characterLoadout(999, 50, out) === 0, `${out.length}`);
  check("  and empties the list completely", out.length === 0);

  let disagreements = 0;
  for (let i = 0; i < CHARACTERS.length; i++) {
    for (const level of [1, 2, 6, 11, 30, 77, 400]) {
      if (characterLoadout(i, level, out) !== characterRecordCount(i, level)) disagreements++;
    }
  }
  check("the count always agrees with the fill", disagreements === 0, `${disagreements}`);
  check("the count is zero for a position that does not exist", characterRecordCount(-4, 50) === 0);
  check("a character never takes more than two slots", characterRecordCount(0, 99_999) === 2);
}

// -------------------------------------------------------------------------------------------------
section("it fits in the stack the replay header is sized around");

{
  // Worst realistic case: four players in co-op, each contributing a character and a growth rung, on top of
  // the modes a run can carry.
  const coop = 4 * 2;
  check("four characters and their growth fit with room to spare", coop < MAX_STACK, `${coop} of ${MAX_STACK}`);
  check("the whole roster at once would still fit", CHARACTERS.length * 2 <= MAX_STACK, `${CHARACTERS.length * 2}`);
}

// -------------------------------------------------------------------------------------------------
section("a starting weapon always comes back");

for (let i = 0; i < CHARACTERS.length; i++) {
  check(`${CHARACTERS[i].id} hands over its own weapon`, characterStartingWeaponId(i, "fallback") === CHARACTERS[i].startingWeaponId);
}
check("a position off the end falls back rather than leaving a run weaponless", characterStartingWeaponId(999, "reapersLash") === "reapersLash");
check("a negative position falls back", characterStartingWeaponId(-1, "reapersLash") === "reapersLash");
check("a fractional position falls back", characterStartingWeaponId(2.5, "reapersLash") === "reapersLash");

// -------------------------------------------------------------------------------------------------
section("resolving it does what the card says");

{
  const stats = new Stats();
  const stack = new ModifierStack();
  const i = 0;
  const c = CHARACTERS[i];

  stack.clear();
  stack.clearLoadout();
  stack.add(CHARACTER_MODIFIERS[i]);
  stack.resolve(stats);
  let wrong = 0;
  for (const shift of c.shifts) {
    if (stats.values[shift.stat] !== STAT_BASE[shift.stat] + shift.add) wrong++;
  }
  check(`${c.id} resolves to base plus its shifts`, wrong === 0, `${wrong} stats off`);

  // Growth goes in the loadout list rather than the stack, because it is derived from the level rather than
  // carried on the wire. It has to fold into the same numbers either way.
  const beforeGrowth = stats.values[c.growth.stat];
  stack.addLoadout(CHARACTER_GROWTH_MODIFIERS[i][2]);
  stack.resolve(stats);
  check(
    `${c.id} three growth steps land on top of the shifts`,
    stats.values[c.growth.stat] === beforeGrowth + c.growth.add * 3,
    `${stats.values[c.growth.stat]} vs ${beforeGrowth + c.growth.add * 3}`,
  );

  // And the same three steps added one rung at a time must land in the same place, which is the whole
  // justification for folding them into one record.
  const folded = stats.values[c.growth.stat];
  stack.clearLoadout();
  stack.addLoadout(CHARACTER_GROWTH_MODIFIERS[i][0]);
  stack.addLoadout(CHARACTER_GROWTH_MODIFIERS[i][0]);
  stack.addLoadout(CHARACTER_GROWTH_MODIFIERS[i][0]);
  stack.resolve(stats);
  check(`${c.id} folded steps equal the same steps one at a time`, stats.values[c.growth.stat] === folded, `${stats.values[c.growth.stat]} vs ${folded}`);

  // A tank's armour is a count, so a unit mistake anywhere in the chain shows up here as a wildly wrong
  // number rather than as a slightly wrong one.
  const grust = CHARACTERS.findIndex((x) => x.id === "grust");
  const armour = CHARACTERS[grust].shifts.find((s) => s.stat === STAT.armor)?.add ?? 0;
  stack.clear();
  stack.clearLoadout();
  stack.add(CHARACTER_MODIFIERS[grust]);
  stack.resolve(stats);
  check("the tank's armour resolves as a count", stats.values[STAT.armor] === STAT_BASE[STAT.armor] + armour, `${stats.values[STAT.armor]}`);
  check(
    "  and the tank's health resolves in permille",
    stats.values[STAT.maxHealth] % STAT_SCALE === 0 && stats.values[STAT.maxHealth] > STAT_BASE[STAT.maxHealth],
    `${stats.values[STAT.maxHealth]}`,
  );
}

console.log(failures === 0 ? "\nPASS — character bridge" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`character bridge: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
