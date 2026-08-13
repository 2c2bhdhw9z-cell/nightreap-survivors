/**
 * PowerUps -> simulation bridge self-check. Run headless: `bun packages/mobile/game/shop/loadout.test.ts`
 *
 * `loadout.ts` is short, and every line of it is load-bearing in a way that fails silently. The whole
 * point of routing shop purchases through modifier records is that they survive a snapshot restore, a
 * co-op join and a server-side replay check. If that routing is subtly wrong, nothing crashes: runs just
 * quietly stop being as strong as the player paid for, months later, in the one situation nobody tests by
 * hand. So the checks here are about identity and totals rather than about the code running at all:
 *
 *   1. A WIRE ID NAMES EXACTLY ONE SET OF NUMBERS. Every id in the whole table is unique, decodes back to
 *      the powerup and rank it was built from, and stays clear of the mode range and the passive range.
 *   2. FOLDING RANKS IS EXACT. One record carrying five ranks must equal five records of one rank, to the
 *      permille — this is the assumption the whole one-record-per-powerup design rests on, so it is
 *      checked against the shop's own `applyPowerUps`, exhaustively, at every rank of every powerup.
 *   3. THE LOADOUT MATCHES THE SAVE, and a rank the content cannot explain contributes nothing rather
 *      than being clamped into something plausible.
 *   4. IT FITS IN THE STACK. A full shop must not be able to overflow the 64-record stack that the replay
 *      header is sized around.
 *   5. NOTHING IS ALLOCATED per run: the same caller-owned array is filled and truncated in place.
 *   6. THE COUNT AGREES with the fill, always — one is used to size buffers the other writes into.
 */

import { MAX_STACK, MODIFIER_SOURCE, MODIFIERS_BY_WIRE_ID } from "../sim/modifiers";
import { STAT_COUNT } from "../sim/stats";
import { createSaveData } from "../save/schema";
import { POWERUPS, applyPowerUps, rankOf } from "./powerups";
import {
  POWERUP_MODIFIERS,
  POWERUP_MODIFIERS_BY_WIRE_ID,
  POWERUP_WIRE_BASE,
  powerUpLoadout,
  powerUpRecordCount,
  powerUpWireId,
} from "./loadout";

import type { RunModifier } from "../sim/modifiers";
import type { SaveData } from "../save/schema";

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

/** A save with a given spread of ranks, written straight in rather than bought, so prices stay out of it. */
function saveWith(ranks: readonly number[]): SaveData {
  const save = createSaveData();
  for (let i = 0; i < ranks.length && i < save.powerUpLevels.length; i++) {
    save.powerUpLevels[i] = ranks[i];
  }
  return save;
}

/** Resolve a list of records into a stat array by hand, the way the stack does: plain addition. */
function addUp(records: readonly RunModifier[]): Int32Array {
  const stats = new Int32Array(STAT_COUNT);
  for (const record of records) {
    for (const delta of record.deltas) {
      // A powerup delta is always additive — the whole folding argument depends on it. Silently treating a
      // missing `add` as zero would make the comparison below pass by agreeing about nothing.
      if (delta.add === undefined) throw new Error(`${record.id} has a delta with no add`);
      stats[delta.stat] += delta.add;
    }
  }
  return stats;
}

// ------------------------------------------------------------------ wire ids

section("a wire id names exactly one set of numbers");
{
  let total = 0;
  const seen = new Set<number>();
  let collisions = 0;
  let wrongDecode = 0;
  let outOfRange = 0;

  for (let i = 0; i < POWERUP_MODIFIERS.length; i++) {
    const ranks = POWERUP_MODIFIERS[i];
    for (let r = 0; r < ranks.length; r++) {
      const record = ranks[r];
      total++;
      if (seen.has(record.wireId)) collisions++;
      seen.add(record.wireId);
      if (record.wireId !== powerUpWireId(i, r + 1)) wrongDecode++;
      if (record.wireId < POWERUP_WIRE_BASE) outOfRange++;
      if (POWERUP_MODIFIERS_BY_WIRE_ID.get(record.wireId) !== record) wrongDecode++;
    }
  }

  check("there is a record for every rank of every powerup", total > 0, `${total} records`);
  check("no two records share a wire id", collisions === 0, `${collisions} collisions`);
  check("every id decodes back to its own record", wrongDecode === 0, `${wrongDecode} wrong`);
  check("every id sits at or above the shop's base", outOfRange === 0, `${outOfRange} below base`);
  check("the lookup map holds all of them", POWERUP_MODIFIERS_BY_WIRE_ID.size === total, `${POWERUP_MODIFIERS_BY_WIRE_ID.size}`);

  // The three id ranges are the thing that lets a snapshot rebuild a mixed stack from numbers alone.
  let clash = 0;
  for (const id of POWERUP_MODIFIERS_BY_WIRE_ID.keys()) {
    if (MODIFIERS_BY_WIRE_ID.has(id)) clash++;
  }
  check("no shop id collides with a mode id", clash === 0, `${clash} clashes`);

  const highestRank = Math.max(...POWERUPS.map((p) => p.maxRank));
  check("ranks stay inside the 99 the id layout allows", highestRank < 100, `highest maxRank ${highestRank}`);
  check("every record is marked as coming from the shop", POWERUP_MODIFIERS.every((ranks) => ranks.every((m) => m.source === MODIFIER_SOURCE.powerUp)));
  check("every record carries a name and a description", POWERUP_MODIFIERS.every((ranks) => ranks.every((m) => m.name.length > 0 && m.description.length > 0)));
  check("every record has a unique string id", new Set(POWERUP_MODIFIERS.flatMap((ranks) => ranks.map((m) => m.id))).size === total);
}

// -------------------------------------------------------------- folded ranks

section("folding ranks into one record is exact, at every rank");
{
  // This is the assumption the one-record-per-powerup design rests on. If it is ever false, the shop's own
  // numbers and the run's numbers disagree and there is no way to tell which is right.
  let mismatches = 0;
  let checked = 0;

  for (let i = 0; i < POWERUPS.length; i++) {
    for (let rank = 1; rank <= POWERUPS[i].maxRank; rank++) {
      const save = createSaveData();
      save.powerUpLevels[i] = rank;

      const shopWay = applyPowerUps(save, new Int32Array(STAT_COUNT));
      const runWay = addUp([POWERUP_MODIFIERS[i][rank - 1]]);

      checked++;
      for (let s = 0; s < STAT_COUNT; s++) {
        if (shopWay[s] !== runWay[s]) {
          mismatches++;
          break;
        }
      }
    }
  }

  check("every rank of every powerup agrees with the shop's own maths", mismatches === 0, `${mismatches} of ${checked} disagree`);

  // And the folding itself: one record of rank five equals five separate rank-one records, exactly.
  let foldMismatch = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const max = POWERUPS[i].maxRank;
    if (max < 2) continue;
    const folded = addUp([POWERUP_MODIFIERS[i][max - 1]]);
    const spread = addUp(Array.from({ length: max }, () => POWERUP_MODIFIERS[i][0]));
    for (let s = 0; s < STAT_COUNT; s++) {
      if (folded[s] !== spread[s]) {
        foldMismatch++;
        break;
      }
    }
  }
  check("one folded record equals the same ranks added one at a time", foldMismatch === 0, `${foldMismatch} differ`);
}

// ------------------------------------------------------------- the loadout

section("the loadout matches the save");
{
  const save = saveWith([3, 0, 2, 0, 0, 1]);
  const out: RunModifier[] = [];
  const count = powerUpLoadout(save, out);

  check("one record per owned powerup, not per rank", count === 3, `${count}`);
  check("the count agrees with the fill", out.length === count, `${out.length} vs ${count}`);
  check("the record count helper agrees too", powerUpRecordCount(save) === count, `${powerUpRecordCount(save)}`);
  check("the first record is the right rank", out[0] === POWERUP_MODIFIERS[0][2], out[0]?.id ?? "missing");
  check("the third is the right rank as well", out[2] === POWERUP_MODIFIERS[5][0], out[2]?.id ?? "missing");
  check("the order is the shop's order", out[0].wireId < out[1].wireId && out[1].wireId < out[2].wireId);

  const empty = createSaveData();
  const emptyOut: RunModifier[] = [];
  check("an untouched save contributes nothing", powerUpLoadout(empty, emptyOut) === 0);
  check("  and leaves an empty list, not a stale one", emptyOut.length === 0, `${emptyOut.length}`);
  check("  and the helper says zero too", powerUpRecordCount(empty) === 0);

  // The resolved stats must be identical whichever door the ranks come in through.
  const viaLoadout = addUp(out);
  const viaShop = applyPowerUps(save, new Int32Array(STAT_COUNT));
  let same = true;
  for (let s = 0; s < STAT_COUNT; s++) if (viaLoadout[s] !== viaShop[s]) same = false;
  check("a mixed spread resolves the same through both paths", same);
}

section("a rank the content cannot explain contributes nothing");
{
  const save = createSaveData();
  save.powerUpLevels[0] = POWERUPS[0].maxRank + 40;
  check("the shop refuses to read it", rankOf(save, 0) === -1, `${rankOf(save, 0)}`);

  const out: RunModifier[] = [];
  check("it produces no record at all", powerUpLoadout(save, out) === 0, `${out.length} records`);
  check("  and the count helper agrees", powerUpRecordCount(save) === 0);

  // A corrupt rank next to a good one must not take the good one down with it, or a single bad byte would
  // wipe out everything the player bought.
  save.powerUpLevels[1] = 2;
  const mixed: RunModifier[] = [];
  check("a good rank beside it still applies", powerUpLoadout(save, mixed) === 1, `${mixed.length}`);
  check("  and it is the good one", mixed[0] === POWERUP_MODIFIERS[1][1], mixed[0]?.id ?? "missing");
}

// ------------------------------------------------------------------ the stack

section("a fully bought shop still fits in the stack");
{
  const save = createSaveData();
  for (let i = 0; i < POWERUPS.length && i < save.powerUpLevels.length; i++) {
    save.powerUpLevels[i] = POWERUPS[i].maxRank;
  }
  const out: RunModifier[] = [];
  const count = powerUpLoadout(save, out);

  check("every powerup contributes", count === POWERUPS.length, `${count} of ${POWERUPS.length}`);
  check("and it fits the stack with room for the run's own modifiers", count < MAX_STACK, `${count} of ${MAX_STACK}`);

  // The margin matters: a mode, a stage and an ascension tier all need slots in the same stack.
  check("there are at least eight slots left over", MAX_STACK - count >= 8, `${MAX_STACK - count} spare`);
}

section("filling the loadout twice reuses the same array");
{
  const out: RunModifier[] = [];
  const many = saveWith([1, 1, 1, 1, 1, 1, 1, 1]);
  powerUpLoadout(many, out);
  check("the long spread filled", out.length === 8, `${out.length}`);

  const few = saveWith([2]);
  powerUpLoadout(few, out);
  check("a shorter spread truncates the array rather than leaving leftovers", out.length === 1, `${out.length}`);
  check("  and holds the new record", out[0] === POWERUP_MODIFIERS[0][1], out[0]?.id ?? "missing");

  const none = createSaveData();
  powerUpLoadout(none, out);
  check("an empty spread empties it completely", out.length === 0, `${out.length}`);
}

console.log(failures === 0 ? "\nPASS — powerups loadout bridge" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`powerups loadout bridge: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
