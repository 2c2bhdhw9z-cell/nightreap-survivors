/**
 * Turning shop purchases into something the simulation understands.
 *
 * The shop stores ranks. The simulation reads `Stats`. This is the bridge, and the way it is built is the
 * whole point of the file.
 *
 * WHY POWERUPS ARE RUN MODIFIERS AND NOT A SPECIAL CASE
 *
 * The simulation already has exactly one mechanism for "these stats are different for this run": a list of
 * `RunModifier` records resolved once, in a fixed, order-independent way. Modes use it, ascension tiers use
 * it, stages use it, live-ops mutators use it, and in-run passives use it. Bolting a second, shop-shaped
 * path into `Stats` would mean the sim had two ways to be told the same thing — and every future feature
 * would have to remember both.
 *
 * More importantly, going through modifiers means the shop's contribution travels with the run for free.
 * A modifier's `wireId` is written into the replay header and into a co-op join message, so:
 *
 *   - a replay our server revalidates resolves the same stats we did, without the server needing the
 *     player's save file;
 *   - a guest joining a co-op run learns the host's rules the same way it learns every other rule;
 *   - a snapshot restore rebuilds the stack from wire ids and gets the powerups back with everything else.
 *
 * If the shop wrote straight into `Stats`, every one of those three would silently drop it, and the bug
 * would look like "co-op runs feel weaker" months later.
 *
 * WHY THE LOADOUT LIST IS NOT USED
 *
 * There is a second list on the stack, for in-run passives. It cannot be used here: `passives.applyTo`
 * clears the whole loadout and rebuilds it from what a player owns after every single card pick, so
 * anything else living there is erased the first time the player takes a passive. The loadout belongs to
 * passives. Powerups go in the main stack, which is only cleared when a run begins.
 *
 * WHY ONE RECORD PER POWERUP AND NOT ONE PER RANK
 *
 * Passives add one record per level. Powerups cannot: twenty-six powerups with up to eight ranks each is
 * over a hundred records, and the stack — and the replay header it has to fit inside — holds sixty-four.
 * So a powerup contributes one record carrying all its ranks, and the rank is encoded in the wire id, so a
 * wire id still identifies exactly one set of numbers. This is only safe because every powerup delta is
 * additive: adding five ranks in one record and adding five records of one rank produce the same total,
 * with no truncation in between. A multiplicative powerup could not be folded this way, and
 * `contentFaults` in `powerups.ts` would need to say so before one is ever added.
 */

import { MODIFIER_SOURCE, type RunModifier, type StatDelta } from "../sim/modifiers";
import type { StatId } from "../sim/stats";
import type { SaveData } from "../save/schema";
import { POWERUPS, rankOf } from "./powerups";

/**
 * Base of the powerup wire id range.
 *
 * Modes occupy 1..99 and in-run passives occupy 100_000 upward. Powerups take 200_000 upward so the three
 * ranges cannot ever meet. The layout is `200_000 + position * 100 + rank`, which means:
 *
 *   - the id names both the powerup and how many ranks of it are folded in, so it decodes to exactly one
 *     set of numbers, which is what replay revalidation needs;
 *   - up to 99 ranks per powerup fit before the ranges would collide, and the largest today is eight.
 *
 * IDS ARE PERMANENT. They are written into replay headers and co-op join messages. Because the id is
 * derived from a powerup's *position*, the shop list is append-only — which is already true, because the
 * save stores ranks by position too.
 */
export const POWERUP_WIRE_BASE = 200_000;

/** Wire id for a given powerup position at a given rank. */
export function powerUpWireId(index: number, rank: number): number {
  return POWERUP_WIRE_BASE + index * 100 + rank;
}

/**
 * Every powerup at every rank, as a modifier record.
 *
 * Built once at module load rather than per run, because a run must not allocate and because these are
 * immutable content. Indexed `[powerup position][rank - 1]`; rank zero has no record, since a powerup
 * nobody has bought contributes nothing and an empty record in the stack would still cost a resolve pass.
 */
export const POWERUP_MODIFIERS: readonly (readonly RunModifier[])[] = POWERUPS.map((power, index) => {
  const perRank: RunModifier[] = [];
  for (let rank = 1; rank <= power.maxRank; rank++) {
    const deltas: readonly StatDelta[] = [{ stat: power.stat as StatId, add: power.perRank * rank }];
    perRank.push({
      id: `powerup.${power.id}.${rank}`,
      wireId: powerUpWireId(index, rank),
      name: power.name,
      description: `${power.blurb} Rank ${rank}.`,
      source: MODIFIER_SOURCE.powerUp,
      deltas,
    });
  }
  return perRank;
});

/**
 * Lookup by wire id, for rebuilding a stack from a replay header or a snapshot.
 *
 * Deliberately a separate map from the mode catalogue rather than being merged into it: the mode catalogue
 * is hand-written content with a duplicate-id guard, and quietly adding a hundred generated entries to it
 * would make that guard much harder to reason about. Whoever rebuilds a stack consults both.
 */
export const POWERUP_MODIFIERS_BY_WIRE_ID: ReadonlyMap<number, RunModifier> = (() => {
  const map = new Map<number, RunModifier>();
  for (const ranks of POWERUP_MODIFIERS) {
    for (const mod of ranks) map.set(mod.wireId, mod);
  }
  return map;
})();

/** Guard: a duplicated wire id would make one powerup silently decode as another. */
{
  let total = 0;
  for (const ranks of POWERUP_MODIFIERS) total += ranks.length;
  if (POWERUP_MODIFIERS_BY_WIRE_ID.size !== total) {
    throw new Error("POWERUP_MODIFIERS contains duplicate wireId values");
  }
}

/**
 * Fill `out` with one modifier per owned powerup, and report how many were written.
 *
 * Writes into a caller-owned array so starting a run allocates nothing. Ranks the content cannot explain
 * contribute nothing — the same rule the shop and the refund follow, for the same reason: a number we do
 * not trust must not become a stat.
 *
 * The order is the shop's order, which is fixed, so two devices building this from the same save produce
 * the same list. Resolution is order-independent anyway, but a stable order means the replay header's bytes
 * are stable too, and a header that differs between two identical runs is a debugging nightmare.
 */
export function powerUpLoadout(save: SaveData, out: RunModifier[]): number {
  let count = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const rank = rankOf(save, i);
    if (rank <= 0) continue;
    const record = POWERUP_MODIFIERS[i][rank - 1];
    if (record === undefined) continue;
    out[count++] = record;
  }
  out.length = count;
  return count;
}

/** How many stack slots a save's purchases will take. One per owned powerup, never per rank. */
export function powerUpRecordCount(save: SaveData): number {
  let count = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    if (rankOf(save, i) > 0) count++;
  }
  return count;
}
