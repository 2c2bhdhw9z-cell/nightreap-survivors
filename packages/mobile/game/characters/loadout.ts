/**
 * Turning a chosen character into something the simulation understands.
 *
 * This is the character half of the same bridge the shop has, and it is built the same way for the same
 * reasons: the simulation has exactly one mechanism for "these stats are different for this run", a list of
 * `RunModifier` records resolved once in a fixed order. A character that wrote straight into `Stats` would be
 * dropped by every path that rebuilds a run from numbers — a snapshot restore, a guest joining a co-op run,
 * and our own server revalidating a submitted replay — and the bug would surface months later as "co-op runs
 * feel different".
 *
 * WHY THE WIRE IDS LOOK LIKE THIS
 *
 * Modes hold 1..99. In-run passives hold 100_000 upward. Shop powerups hold 200_000 upward. Characters take
 * 300_000 upward, laid out as `300_000 + position * 100 + slot`:
 *
 *   - slot 0 is the character's own starting shifts;
 *   - slots 1..48 are folded growth steps, where slot N means "N steps have landed";
 *   - slots 49..99 are unused and reserved, so a Shadow variant of a character can be added later without
 *     renumbering anybody.
 *
 * That leaves room for a thousand characters before the range would meet 400_000, against a full scope of
 * forty-odd. IDS ARE PERMANENT: they are written into replay headers and co-op join messages, and because an
 * id is derived from a character's *position*, the roster is append-only. That is already true, because the
 * save's unlock bitset is indexed by position too.
 *
 * WHY GROWTH IS ONE RECORD PER TIER AND NOT ONE RECORD PER STEP
 *
 * The stack holds sixty-four records and the replay header holds the same list. Eight characters with up to
 * eight steps each would be fine, but four players in co-op each dripping a record per step would not be —
 * and the failure mode of an overflowing stack is a silently weaker run. So a character contributes one
 * growth record carrying every step earned so far, and the step count is encoded in the wire id, so a wire id
 * still decodes to exactly one set of numbers. This is only safe because every growth step is additive:
 * adding five steps in one record and adding five one-step records give the same total with no truncation in
 * between. A multiplicative quirk could not be folded this way, and `roster.ts`'s content check would have to
 * say so before one was ever added.
 *
 * WHY THE GROWTH RECORD IS NOT ON THE WIRE LIST
 *
 * The wire list is written once, at run start, when the player is level one and no step has landed. A record
 * added at level twenty would be missing from it. Rather than make the header mutable — which would mean a
 * replay's own bytes changed as it played, and a co-op host and guest disagreeing about the header mid-run —
 * the growth record is *derived*: it is a pure function of the character and the level, and both of those are
 * restored by every resync, so it can be recomputed on the other side instead of carried across. The wire ids
 * exist anyway, so a server that wants to explain a resolved stat can still name the record.
 */

import { MODIFIER_SOURCE, type RunModifier, type StatDelta } from "../sim/modifiers";
import type { StatId } from "../sim/stats";
import { CHARACTERS, growthTiersAt, MAX_GROWTH_TIERS, type Character } from "./roster";

/** Base of the character wire id range. Characters occupy 300_000..399_999. */
export const CHARACTER_WIRE_BASE = 300_000;

/** Slots per character: one for the base record plus room for every growth tier, with room spare. */
export const CHARACTER_WIRE_STRIDE = 100;

/** Slot number for a character's own starting shifts. */
export const CHARACTER_SLOT_BASE = 0;

/**
 * Wire id for a character position at a slot.
 *
 * Slot 0 is the starting shifts; slot N is "N growth steps have landed". Callers pass a slot rather than a
 * boolean so the two kinds of record cannot be confused for one another at the call site.
 */
export function characterWireId(index: number, slot = CHARACTER_SLOT_BASE): number {
  return CHARACTER_WIRE_BASE + index * CHARACTER_WIRE_STRIDE + slot;
}

function baseRecord(character: Character, index: number): RunModifier {
  const deltas: readonly StatDelta[] = character.shifts.map((shift) => ({
    stat: shift.stat as StatId,
    add: shift.add,
  }));
  return {
    id: `character.${character.id}`,
    wireId: characterWireId(index, CHARACTER_SLOT_BASE),
    name: character.name,
    description: character.blurb,
    source: MODIFIER_SOURCE.character,
    deltas,
  };
}

function growthRecord(character: Character, index: number, tier: number): RunModifier {
  const deltas: readonly StatDelta[] = [
    { stat: character.growth.stat as StatId, add: character.growth.add * tier },
  ];
  return {
    id: `character.${character.id}.growth.${tier}`,
    wireId: characterWireId(index, tier),
    name: `${character.name} — growth`,
    description: `${character.growth.blurb} ${tier} of ${character.growth.maxTiers} earned.`,
    source: MODIFIER_SOURCE.character,
    deltas,
  };
}

/**
 * Every character's starting record, built once at module load.
 *
 * Built up front rather than per run because starting a run must not allocate, and because these are
 * immutable content: the same character always resolves to the same numbers on every device, which is the
 * property co-op state hashing and replay revalidation both stand on.
 */
export const CHARACTER_MODIFIERS: readonly RunModifier[] = CHARACTERS.map((c, i) => baseRecord(c, i));

/**
 * Every character's growth record at every reachable tier, indexed `[position][tier - 1]`.
 *
 * Tier zero has no record: a character at level one has earned nothing, and an empty record in the stack
 * would still cost a resolve pass every time stats changed.
 */
export const CHARACTER_GROWTH_MODIFIERS: readonly (readonly RunModifier[])[] = CHARACTERS.map((c, i) => {
  const tiers: RunModifier[] = [];
  const top = Math.min(c.growth.maxTiers, MAX_GROWTH_TIERS);
  for (let tier = 1; tier <= top; tier++) tiers.push(growthRecord(c, i, tier));
  return tiers;
});

/**
 * Lookup by wire id, for rebuilding a stack from a replay header or a snapshot.
 *
 * A separate map from the mode catalogue and from the shop's, for the same reason the shop's is separate:
 * the mode catalogue is hand-written content with its own duplicate guard, and folding generated entries into
 * it would make that guard much harder to reason about. Whoever rebuilds a stack consults all of them.
 */
export const CHARACTER_MODIFIERS_BY_WIRE_ID: ReadonlyMap<number, RunModifier> = (() => {
  const map = new Map<number, RunModifier>();
  for (const mod of CHARACTER_MODIFIERS) map.set(mod.wireId, mod);
  for (const tiers of CHARACTER_GROWTH_MODIFIERS) {
    for (const mod of tiers) map.set(mod.wireId, mod);
  }
  return map;
})();

/** Guard: a duplicated wire id would make one character silently decode as another. */
{
  let total = CHARACTER_MODIFIERS.length;
  for (const tiers of CHARACTER_GROWTH_MODIFIERS) total += tiers.length;
  if (CHARACTER_MODIFIERS_BY_WIRE_ID.size !== total) {
    throw new Error("CHARACTER_MODIFIERS contains duplicate wireId values");
  }
  for (const wireId of CHARACTER_MODIFIERS_BY_WIRE_ID.keys()) {
    if (wireId < CHARACTER_WIRE_BASE || wireId >= CHARACTER_WIRE_BASE + 100_000) {
      throw new Error(`character wire id ${wireId} is outside the character range`);
    }
  }
}

/** The record for a character's starting shifts, or `undefined` for a position content cannot explain. */
export function characterRecord(index: number): RunModifier | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= CHARACTER_MODIFIERS.length) return undefined;
  return CHARACTER_MODIFIERS[index];
}

/**
 * The growth record a character has earned at a level, or `undefined` when it has earned none.
 *
 * A level the content cannot explain contributes nothing rather than throwing — the same rule the shop
 * follows for a rank it does not recognise, for the same reason: a number we do not trust must not become a
 * stat, and refusing to answer would end a run that is otherwise fine.
 */
export function characterGrowthRecord(index: number, level: number): RunModifier | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= CHARACTERS.length) return undefined;
  const tier = growthTiersAt(CHARACTERS[index], level);
  if (tier <= 0) return undefined;
  const tiers = CHARACTER_GROWTH_MODIFIERS[index];
  return tiers[tier - 1];
}

/**
 * Fill `out` with the records a character contributes at a level, and report how many were written.
 *
 * Writes into a caller-owned array so beginning a run and re-resolving after a level-up both allocate
 * nothing. At level one that is one record; past the first growth step it is two, never more, whatever the
 * level.
 */
export function characterLoadout(index: number, level: number, out: RunModifier[]): number {
  let count = 0;
  const base = characterRecord(index);
  if (base !== undefined) out[count++] = base;
  const growth = characterGrowthRecord(index, level);
  if (growth !== undefined) out[count++] = growth;
  out.length = count;
  return count;
}

/** How many stack slots a character will take at a level. Never more than two. */
export function characterRecordCount(index: number, level: number): number {
  if (characterRecord(index) === undefined) return 0;
  return characterGrowthRecord(index, level) === undefined ? 1 : 2;
}

/**
 * The weapon a character starts holding, falling back to the run's configured weapon.
 *
 * A fallback rather than a refusal because `run.ts` treats a missing starting weapon as "no weapon", and a
 * run with no weapon is not a run. A character position the roster cannot explain — an older save, a content
 * version mismatch — should still hand the player something to swing.
 */
export function characterStartingWeaponId(index: number, fallback: string): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= CHARACTERS.length) return fallback;
  return CHARACTERS[index].startingWeaponId;
}
