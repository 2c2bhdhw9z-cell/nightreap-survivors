/**
 * A character inside a real run. Run headless: `bun packages/mobile/game/characters/inrun.test.ts`
 *
 * The two files next door prove the roster's numbers and the records built from them. This one proves the
 * part that cannot be checked in isolation: that a real `Run`, ticking its real loop, actually ends up with
 * those numbers in its live stat table — and keeps them.
 *
 * The failures it is hunting are all silent, and all of the same shape: the character applies, and then
 * something later quietly takes it away.
 *
 *   1. IT ARRIVES. A run begun with a character resolves that character's shifts, exactly, at level one.
 *   2. THE GROWTH STEP LANDS ON THE PROMISED LEVEL — not one level early, not one late, and not twice.
 *   3. IT SURVIVES A CARD PICK. Taking a passive rebuilds the whole loadout from scratch, which is exactly
 *      the operation that would throw a growth record away. This is the bug most likely to ship.
 *   4. IT SURVIVES A RESYNC. After rehydrating from wire ids — what a snapshot restore and a joining guest
 *      both do — the run's live stats must still be derivable from its own contents.
 *   5. THE CEILING HOLDS. A run that reaches an absurd level gets the ceiling the card promised, not more.
 *   6. IT IS ON THE WIRE. The character's record is in the run's wire list, so the far side can rebuild it.
 */

import { Run } from "../run/run";
import { MOD_DEV_GODMODE, MODIFIERS_BY_WIRE_ID } from "../sim/modifiers";
import { MAX_PASSIVES, PASSIVE_TYPES } from "../sim/passives";
import { STAT, STAT_BASE, Stats } from "../sim/stats";
import { MAX_WEAPONS, WEAPON_BY_ID } from "../sim/weapons";

/**
 * First weapon slot belonging to a seat. Written as a helper rather than inline
 * `seat * MAX_WEAPONS` because seat 0's base is `0 * MAX_WEAPONS`, which a linter
 * correctly flags as an always-zero multiply — the intent is "seat 0's base", not zero.
 */
const seatWeaponBase = (seat: number): number => seat * MAX_WEAPONS;
import { firstDivergentTick, makeParty, runParty } from "../net/sim-network";
import { CARD_ACTION } from "../net/messages";
import { CHARACTERS } from "./roster";
import {
  CHARACTER_GROWTH_MODIFIERS,
  CHARACTER_MODIFIERS,
  CHARACTER_MODIFIERS_BY_WIRE_ID,
  characterGrowthLadderForWireId,
  characterLoadout,
  characterStartingWeaponId,
} from "./loadout";
import { restoreRun, snapshotRun, SNAPSHOT_ERROR } from "../save/snapshot";

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

/** Everything the run layer needs to know about a chosen character, the way a screen hands it over. */
function configFor(index: number, seed: number, autoPick = false) {
  const records: RunModifier[] = [];
  characterLoadout(index, 1, records);
  return {
    seed,
    playerCount: 1,
    characters: records,
    characterGrowth: CHARACTER_GROWTH_MODIFIERS[index],
    characterGrowthEvery: CHARACTERS[index].growth.everyLevels,
    characterIds: [index, index, index, index],
    startingWeaponId: characterStartingWeaponId(index, "reapersLash"),
    record: false,
    autoPick,
  };
}

/** Everything a wire id can name, the way a snapshot restore assembles it. */
const ALL_BY_WIRE_ID = (() => {
  const map = new Map<number, RunModifier>(MODIFIERS_BY_WIRE_ID);
  for (const [id, mod] of CHARACTER_MODIFIERS_BY_WIRE_ID) map.set(id, mod);
  return map;
})();

/**
 * Level the run up without letting a card screen open.
 *
 * The queue of unspent level-ups is emptied on the way out, on purpose. A card screen would pause the run —
 * so the next tick would never reach the growth step at all — and taking cards to clear it would move the
 * same stats the growth quirk moves, leaving nothing to measure. The "survives a card pick" section further
 * down does the opposite and takes every card for real; this one keeps the world quiet so the arithmetic is
 * unambiguous.
 */
function levelTo(run: Run, level: number): void {
  let guard = 0;
  while (run.prog.level < level && guard++ < 10_000) {
    run.prog.addXp(run.prog.xpToNext - run.prog.xp, run.stats);
  }
  run.prog.pending = 0;
  run.prog.droppedPending = 0;
}

// -------------------------------------------------------------------------------------------------
section("the character arrives");

const PICK = 0;
const HERO = CHARACTERS[PICK];
/** The crit character, used wherever a stat nothing else can touch is needed. */
const GAMBLER_INDEX = CHARACTERS.findIndex((c) => c.id === "sable");
const GAMBLER = CHARACTERS[GAMBLER_INDEX];
const EVERY = HERO.growth.everyLevels;
const STEP = HERO.growth.add;

{
  const run = new Run();
  run.begin(configFor(PICK, 4242));

  let wrong = 0;
  for (const shift of HERO.shifts) {
    if (run.stats.values[shift.stat] !== STAT_BASE[shift.stat] + shift.add) wrong++;
  }
  check(`${HERO.id} resolves to base plus its shifts at level one`, wrong === 0, `${wrong} stats off`);
  check("the growth stat has not moved yet", run.stats.values[HERO.growth.stat] === STAT_BASE[HERO.growth.stat] + (HERO.shifts.find((s) => s.stat === HERO.growth.stat)?.add ?? 0));

  const holding = run.weapons.typeIndex[0];
  check("the run starts with the character's own weapon", holding >= 0, `slot 0 holds ${holding}`);
}

{
  const plain = new Run();
  plain.begin({ seed: 4242, playerCount: 1, record: false });
  let same = 0;
  for (const shift of HERO.shifts) {
    if (plain.stats.values[shift.stat] === STAT_BASE[shift.stat]) same++;
  }
  check("a run begun with nobody stays on the baseline", same === HERO.shifts.length, `${same} of ${HERO.shifts.length}`);
}

// -------------------------------------------------------------------------------------------------
section("the growth step lands on the promised level");

{
  const run = new Run();
  run.begin(configFor(PICK, 99));
  const atOne = run.stats.values[HERO.growth.stat];

  levelTo(run, EVERY);
  run.tick();
  check(
    "the level before the first step changes nothing",
    run.stats.values[HERO.growth.stat] === atOne,
    `level ${run.prog.level}, ${run.stats.values[HERO.growth.stat]} vs ${atOne}`,
  );

  levelTo(run, EVERY + 1);
  run.tick();
  check(
    "the first step lands exactly once",
    run.stats.values[HERO.growth.stat] === atOne + STEP,
    `level ${run.prog.level}, ${run.stats.values[HERO.growth.stat]} vs ${atOne + STEP}`,
  );

  run.tick();
  run.tick();
  check(
    "further ticks at the same level do not stack it again",
    run.stats.values[HERO.growth.stat] === atOne + STEP,
    `${run.stats.values[HERO.growth.stat]}`,
  );

  levelTo(run, EVERY * 3 + 1);
  run.tick();
  check(
    "three gaps later it is worth three steps",
    run.stats.values[HERO.growth.stat] === atOne + STEP * 3,
    `level ${run.prog.level}, ${run.stats.values[HERO.growth.stat]} vs ${atOne + STEP * 3}`,
  );
}

// -------------------------------------------------------------------------------------------------
section("the ceiling holds");

{
  const run = new Run();
  run.begin(configFor(PICK, 7));
  const atOne = run.stats.values[HERO.growth.stat];
  levelTo(run, EVERY * (HERO.growth.maxTiers + 40) + 1);
  run.tick();
  const ceiling = atOne + STEP * HERO.growth.maxTiers;
  check(
    "an absurd level gets the promised ceiling and no more",
    run.stats.values[HERO.growth.stat] === ceiling,
    `level ${run.prog.level}, ${run.stats.values[HERO.growth.stat]} vs ${ceiling}`,
  );
}

/**
 * What the passives this player is actually carrying add to one stat.
 *
 * Every owned level folds in, so a passive at level 3 contributes levels 1, 2 and 3 — exactly the way the
 * loadout is rebuilt. Read from the run's own store rather than from a list written down here, so a test
 * expectation can never drift from what the run really picked.
 */
function passiveContribution(run: Run, stat: number): number {
  let total = 0;
  for (let slot = 0; slot < MAX_PASSIVES; slot++) {
    const type = run.passives.typeIndex[slot];
    if (type < 0) continue;
    const level = run.passives.level[slot];
    for (let li = 0; li < level; li++) {
      for (const d of PASSIVE_TYPES[type].levels[li].deltas) {
        if (d.stat === stat) total += d.add ?? 0;
      }
    }
  }
  return total;
}

// -------------------------------------------------------------------------------------------------
section("it survives a card pick");

{
  // Card picks are what rebuild the loadout, and the loadout is where the growth record lives. Driving a
  // real run with autoPick on means dozens of picks happen for real, including passives.
  const run = new Run();
  run.begin({ ...configFor(GAMBLER_INDEX, 20_260_813, true), modifiers: [MOD_DEV_GODMODE] });
  // Godmode is on for one reason: this section is about what card picks do to the loadout, and a run that
  // dies at four minutes never gets far enough up the growth ladder to say anything. Experience is topped up
  // every second on top of what the run collects, because the ladder is measured in levels and six minutes
  // of honest gem collecting is worth two of them. Every card is still taken for real, by the run itself.
  for (let i = 0; i < 6 * 60 * 60 && !run.over; i++) {
    const a = (i / 240) * Math.PI * 2;
    run.setStick(0, Math.cos(a), Math.sin(a));
    if (i % 60 === 0) run.prog.addXp(60, run.stats);
    run.tick();
  }

  check("the run really did take cards", run.cards.picksMade > 0, `${run.cards.picksMade} picks`);
  check("the run really did level", run.prog.level > GAMBLER.growth.everyLevels * 2, `level ${run.prog.level}`);

  // This is an exact equality, not an "at least", because an exact equality is the only kind that notices a
  // growth record being quietly dropped by a pick. Exactness used to rest on "nothing in the game touches
  // critical chance", which stopped being true the moment the launch passives were finished. So instead of
  // assuming the run's contents contribute nothing, the contribution is read back off the run's own passives
  // and added in: the claim is still "the character's shift and every earned step survive a hundred picks",
  // and it now stays true no matter what content is added later.
  const tier = Math.min(
    Math.floor((run.prog.level - 1) / GAMBLER.growth.everyLevels),
    GAMBLER.growth.maxTiers,
  );
  check("the run reached a level worth several steps", tier >= 2, `${tier} steps`);
  const shift = GAMBLER.shifts.find((s) => s.stat === GAMBLER.growth.stat)?.add ?? 0;
  const fromPassives = passiveContribution(run, GAMBLER.growth.stat);
  const expected = STAT_BASE[GAMBLER.growth.stat] + shift + GAMBLER.growth.add * tier + fromPassives;
  check(
    "the character's shift and every earned step are still applied",
    run.stats.values[GAMBLER.growth.stat] === expected,
    `${run.stats.values[GAMBLER.growth.stat]} vs ${expected}`,
  );
  check("the live stats still follow from the run's own contents", run.loadoutAgreesWithStats(new Stats()));

  section("it survives a resync");
  // Rehydrating is what a snapshot restore and a joining guest both do: throw the stack away and rebuild it
  // from wire ids alone. The growth record is not on the wire — it is re-derived from the character and the
  // level — so this is the check that proves the derivation actually happens on the far side.
  run.rehydrate(ALL_BY_WIRE_ID);
  const after = new Stats();
  run.loadoutAgreesWithStats(after);
  check("after rehydrating, the stats still follow from the contents", run.loadoutAgreesWithStats(new Stats()));
  check(
    "and the rebuilt stack still carries the shift and every step",
    after.values[GAMBLER.growth.stat] === expected,
    `${after.values[GAMBLER.growth.stat]} vs ${expected}`,
  );
}

// -------------------------------------------------------------------------------------------------
section("the character is on the wire");

{
  const run = new Run();
  run.begin(configFor(PICK, 5));
  const wire = new Int32Array(64);
  const n = run.writeModifierWireIds(wire);
  let found = false;
  for (let i = 0; i < n; i++) {
    if (wire[i] === CHARACTER_MODIFIERS[PICK].wireId) found = true;
  }
  check("the character's record is in the wire list", found, `${n} ids`);
  check("  and a wire id resolves back to that record", ALL_BY_WIRE_ID.get(CHARACTER_MODIFIERS[PICK].wireId) === CHARACTER_MODIFIERS[PICK]);

  const plain = new Run();
  plain.begin({ seed: 5, playerCount: 1, record: false });
  const plainWire = new Int32Array(64);
  const pn = plain.writeModifierWireIds(plainWire);
  let leaked = false;
  for (let i = 0; i < pn; i++) {
    if (CHARACTER_MODIFIERS_BY_WIRE_ID.has(plainWire[i])) leaked = true;
  }
  check("a run with nobody chosen carries no character id", !leaked, `${pn} ids`);
}

// -------------------------------------------------------------------------------------------------
section("a second character, so this is not one lucky row");

{
  const other = CHARACTERS.findIndex((c) => c.id === "grust");
  const run = new Run();
  run.begin(configFor(other, 31));
  const c = CHARACTERS[other];
  let wrong = 0;
  for (const shift of c.shifts) {
    if (run.stats.values[shift.stat] !== STAT_BASE[shift.stat] + shift.add) wrong++;
  }
  check(`${c.id} resolves to base plus its shifts`, wrong === 0, `${wrong} stats off`);
  check("the tank's armour is a count, not a permille", run.stats.values[STAT.armor] < 100, `${run.stats.values[STAT.armor]}`);
  const armourAtOne = run.stats.values[STAT.armor];
  levelTo(run, c.growth.everyLevels + 1);
  run.tick();
  check(
    "and its growth step is a count too",
    run.stats.values[STAT.armor] === armourAtOne + c.growth.add,
    `${run.stats.values[STAT.armor]} vs ${armourAtOne + c.growth.add}`,
  );
  check("the player starts on more health than the baseline", run.players.health[0] > STAT_BASE[STAT.maxHealth] / 1000, `${run.players.health[0]}`);
}

// -------------------------------------------------------------------------------------------------
section("co-op: every seat is its own survivor");

/**
 * Build the per-slot character config the app hands `run.begin` in co-op, for a party where each seat
 * picked a different survivor.
 *
 * This is exactly the shape `app/dev/play.tsx startRun` assembles from the roster the lobby handed over,
 * and the shape `makeParty` passes to every phone's `run.begin` — so what this proves headless is what
 * ships.
 */
function coopConfig(ids: readonly number[]) {
  const charactersBySlot = ids.map((id) => {
    const out: RunModifier[] = [];
    characterLoadout(id, 1, out);
    return out;
  });
  return {
    charactersBySlot,
    characterGrowthBySlot: ids.map((id) => CHARACTER_GROWTH_MODIFIERS[id] ?? []),
    characterGrowthEveryBySlot: ids.map((id) => CHARACTERS[id].growth.everyLevels),
    startingWeaponIdBySlot: ids.map((id) => characterStartingWeaponId(id, "reapersLash")),
  };
}

{
  // Two seats, two different survivors, chosen so their starting weapons differ and their growth quirks
  // touch different stats — the only way to tell a genuinely per-seat build apart from one shared one.
  const A = CHARACTERS.findIndex((c) => c.id === "vesna");
  const B = CHARACTERS.findIndex((c) => c.id === "grust");
  const ids = [A, B];
  const cfg = coopConfig(ids);

  const run = new Run();
  run.begin({ seed: 24680, playerCount: 2, record: false, ...cfg });

  // Each seat holds its OWN starting weapon, in its own weapon store, not one weapon handed to the party.
  const weaponA = run.weapons.typeIndex[seatWeaponBase(0)];
  const weaponB = run.weapons.typeIndex[seatWeaponBase(1)];
  check(
    "seat 0 starts with its own character's weapon",
    weaponA === WEAPON_BY_ID.get(CHARACTERS[A].startingWeaponId),
    `${weaponA}`,
  );
  check(
    "seat 1 starts with its own character's weapon",
    weaponB === WEAPON_BY_ID.get(CHARACTERS[B].startingWeaponId),
    `${weaponB}`,
  );
  check("the two seats did not end up with the same weapon", weaponA !== weaponB, `${weaponA} vs ${weaponB}`);

  // Per-seat growth: level ONLY seat 0 up to earn its first damage step; seat 1 stays at level one and
  // earns nothing. The shared stat table must move by seat 0's step alone — proof the tier is read off
  // each seat's own level and ladder, not one shared level.
  const dmgAtOne = run.stats.values[CHARACTERS[A].growth.stat];
  const armorAtOne = run.stats.values[CHARACTERS[B].growth.stat];
  const p0 = run.progFor(0);
  let guard = 0;
  while (p0.level < CHARACTERS[A].growth.everyLevels + 1 && guard++ < 10_000) {
    p0.addXp(p0.xpToNext - p0.xp, run.stats);
  }
  p0.pending = 0;
  p0.droppedPending = 0;
  run.tick();
  check(
    "seat 0's own level earns seat 0's growth step",
    run.stats.values[CHARACTERS[A].growth.stat] === dmgAtOne + CHARACTERS[A].growth.add,
    `${run.stats.values[CHARACTERS[A].growth.stat]} vs ${dmgAtOne + CHARACTERS[A].growth.add}`,
  );
  check(
    "and seat 1, still at level one, has earned no step of its own",
    run.stats.values[CHARACTERS[B].growth.stat] === armorAtOne,
    `${run.stats.values[CHARACTERS[B].growth.stat]} vs ${armorAtOne}`,
  );

  // Now level seat 1 to earn its first armour step. Both seats' steps must be folded into the one shared
  // table together — each read off its own level.
  const p1 = run.progFor(1);
  guard = 0;
  while (p1.level < CHARACTERS[B].growth.everyLevels + 1 && guard++ < 10_000) {
    p1.addXp(p1.xpToNext - p1.xp, run.stats);
  }
  p1.pending = 0;
  p1.droppedPending = 0;
  run.tick();
  check(
    "seat 1's own level then earns seat 1's growth step",
    run.stats.values[CHARACTERS[B].growth.stat] === armorAtOne + CHARACTERS[B].growth.add,
    `${run.stats.values[CHARACTERS[B].growth.stat]} vs ${armorAtOne + CHARACTERS[B].growth.add}`,
  );
  check(
    "seat 0's step is still applied alongside it",
    run.stats.values[CHARACTERS[A].growth.stat] === dmgAtOne + CHARACTERS[A].growth.add,
    `${run.stats.values[CHARACTERS[A].growth.stat]}`,
  );

  section("co-op: every seat's build survives a resync");
  // Both seats' characters are on the wire, so rehydrating from wire ids alone rebuilds every seat's
  // survivor. The growth records are derived per seat from each seat's level, so this proves that
  // derivation happens for both seats, not just seat 0.
  const wire = new Int32Array(128);
  const n = run.writeModifierWireIds(wire);
  let foundA = false;
  let foundB = false;
  for (let i = 0; i < n; i++) {
    if (wire[i] === CHARACTER_MODIFIERS[A].wireId) foundA = true;
    if (wire[i] === CHARACTER_MODIFIERS[B].wireId) foundB = true;
  }
  check("seat 0's character is on the wire", foundA);
  check("seat 1's character is on the wire", foundB);

  run.rehydrate(ALL_BY_WIRE_ID);
  check("after rehydrating, both seats' stats still follow from the contents", run.loadoutAgreesWithStats(new Stats()));
  const after = new Stats();
  run.loadoutAgreesWithStats(after);
  check(
    "and the rebuilt stack still carries seat 0's earned step",
    after.values[CHARACTERS[A].growth.stat] === dmgAtOne + CHARACTERS[A].growth.add,
    `${after.values[CHARACTERS[A].growth.stat]}`,
  );
  check(
    "and seat 1's earned step",
    after.values[CHARACTERS[B].growth.stat] === armorAtOne + CHARACTERS[B].growth.add,
    `${after.values[CHARACTERS[B].growth.stat]}`,
  );

  section("co-op: two phones with different survivors stay in lockstep");
  // The real proof of determinism: two machines, each building the SAME per-slot world from seed + the
  // same per-slot records, must never disagree. Driven through the actual net harness, over a lossy wire,
  // with the host answering both seats' card screens so a level-up never deadlocks the party.
  const party = makeParty({ playerCount: 2, seed: 13579, modifiers: [MOD_DEV_GODMODE], ...cfg });
  const hostWeapon0 = party.host.run.weapons.typeIndex[seatWeaponBase(0)];
  const hostWeapon1 = party.host.run.weapons.typeIndex[seatWeaponBase(1)];
  check("the host built seat 0's weapon", hostWeapon0 === WEAPON_BY_ID.get(CHARACTERS[A].startingWeaponId));
  check("the host built seat 1's weapon", hostWeapon1 === WEAPON_BY_ID.get(CHARACTERS[B].startingWeaponId));
  const guest = party.guests[0] as (typeof party.guests)[number];
  check("the guest built the identical seat 0 weapon", guest.run.weapons.typeIndex[seatWeaponBase(0)] === hostWeapon0);
  check("the guest built the identical seat 1 weapon", guest.run.weapons.typeIndex[seatWeaponBase(1)] === hostWeapon1);

  let done = 0;
  let screensAnswered = 0;
  let diverged = { tick: -1, slot: -1 };
  const total = 5400;
  while (done < total && diverged.tick < 0) {
    const n = Math.min(240, total - done);
    runParty(party, n, (t, p) => {
      // Both seats walk different arcs through the same crowd so each collects its OWN gems in-sim and
      // levels on them — the only deterministic way to earn a level, since injected XP would move one
      // phone and not the other.
      const a = ((done + t) / 260) * Math.PI * 2;
      p.host.setLocalInput(Math.cos(a), Math.sin(a), 0);
      const g = p.guests[0] as (typeof p.guests)[number];
      g.setLocalInput(Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2), 0);
      // Each seat answers ITS OWN screen, the way the two-player card path is meant to work: the host
      // picks its own card byte, the guest's pick rides the wire into its own. Answering per seat is what
      // keeps a party with two open screens from freezing on the second one.
      if (p.host.run.pausedFor(p.host.localSlot)) {
        p.host.requestCardAction(CARD_ACTION.PICK_0);
        screensAnswered++;
      }
      if (p.host.run.pausedFor(g.slot)) {
        g.requestCardAction(CARD_ACTION.PICK_0);
        screensAnswered++;
      }
    });
    done += n;
    diverged = firstDivergentTick(party);
  }
  check(
    "two survivors, two phones, never disagree",
    diverged.tick < 0,
    diverged.tick < 0 ? `in lockstep for ${done} ticks` : `slot ${diverged.slot} at tick ${diverged.tick}`,
  );
  check("and at least one seat answered a card screen while they ran", screensAnswered > 0, `${screensAnswered}`);
}

// -------------------------------------------------------------------------------------------------
section("co-op: a resync reconstructs each seat's growth ladder without begin()");

/**
 * The latent invariant the review flagged, pinned as a test.
 *
 * Growth is derived, not carried: the growth *records* are re-derived from the character and the level, but
 * WHICH ladder a seat climbs — and how far apart its steps are — used to live only on the run object from
 * `begin()`. In the shipped flow that is fine: every phone calls `begin()` with the roster before the run and
 * a resync reuses the same run object. The risk is a future path that reaches a live run WITHOUT `begin()`'s
 * per-slot config — it would restore correct current stats yet hold an empty ladder and drift on the next
 * growth step, invisibly until two state hashes disagree.
 *
 * `characterGrowthLadderForWireId` closes that: the character base record wire id — which a resync already
 * carries and restores to the stack — names the survivor, so the ladder is recoverable from it. This section
 * proves the reconstruction two ways: a bare `rehydrate` from wire ids alone onto a run whose ladders were
 * NEVER established for these characters, and a full snapshot round-trip onto a fresh run begun without the
 * per-slot config. Both must (a) agree loadout-with-stats per seat and (b) land FURTHER growth steps for
 * each seat afterwards — proof the ladder was rebuilt, not lost.
 */
{
  // Two survivors whose growth quirks touch different stats, so a per-seat ladder is distinguishable from a
  // shared one. Vesna grows damage every 5 levels; Bram grows effect lifetime (duration) every 6.
  const A = CHARACTERS.findIndex((c) => c.id === "vesna");
  const B = CHARACTERS.findIndex((c) => c.id === "bram");
  const ids = [A, B];
  const cfg = coopConfig(ids);
  const charA = CHARACTERS[A];
  const charB = CHARACTERS[B];

  // The source run: begun with the per-slot config the app derives from the roster, then advanced past the
  // first growth step for EACH seat off its own level.
  const source = new Run();
  source.begin({ seed: 8642, playerCount: 2, record: true, ...cfg });
  const dmgAtOne = source.stats.values[charA.growth.stat];
  const durAtOne = source.stats.values[charB.growth.stat];

  const s0 = source.progFor(0);
  const s1 = source.progFor(1);
  let guard = 0;
  while (s0.level < charA.growth.everyLevels + 1 && guard++ < 10_000) s0.addXp(s0.xpToNext - s0.xp, source.stats);
  guard = 0;
  while (s1.level < charB.growth.everyLevels + 1 && guard++ < 10_000) s1.addXp(s1.xpToNext - s1.xp, source.stats);
  s0.pending = 0;
  s0.droppedPending = 0;
  s1.pending = 0;
  s1.droppedPending = 0;
  source.tick();
  check(
    "source: seat 0 earned its first damage step",
    source.stats.values[charA.growth.stat] === dmgAtOne + charA.growth.add,
    `${source.stats.values[charA.growth.stat]}`,
  );
  check(
    "source: seat 1 earned its first duration step",
    source.stats.values[charB.growth.stat] === durAtOne + charB.growth.add,
    `${source.stats.values[charB.growth.stat]}`,
  );

  // --- Path 1: bare rehydrate onto a run whose ladders were NEVER these characters' ---------------
  // The target is begun with NO per-slot config at all — a plain solo-shaped begin() — so its growthLadders
  // are empty for slots 1..3 and slot 0 is the default. This is the strongest stand-in for "a phone reached
  // the run without begin()'s per-slot config": if the ladder were only ever established by begin(), the
  // reconstruction below would have nothing to work from. We copy the wire list and the restored numbers
  // that a resync carries (modifier ids, per-seat levels), then rehydrate WITH the growth resolver.
  const target = new Run();
  target.begin({ seed: 8642, playerCount: 2, record: true });

  // A resync restores the modifier wire ids and the per-seat progression. Mirror exactly that much by hand:
  // copy the source's wire list onto the target, and bring each seat's level across. Nothing here hands the
  // target a ladder — only the ids and the levels, which is all a snapshot carries.
  const wire = new Int32Array(128);
  const n = source.writeModifierWireIds(wire);
  const targetWire = (target as unknown as { modifierWire: Int32Array; modifierCount: number });
  for (let i = 0; i < n; i++) targetWire.modifierWire[i] = wire[i];
  targetWire.modifierCount = n;
  const t0 = target.progFor(0);
  const t1 = target.progFor(1);
  guard = 0;
  while (t0.level < s0.level && guard++ < 10_000) t0.addXp(t0.xpToNext - t0.xp, target.stats);
  guard = 0;
  while (t1.level < s1.level && guard++ < 10_000) t1.addXp(t1.xpToNext - t1.xp, target.stats);
  t0.pending = 0;
  t0.droppedPending = 0;
  t1.pending = 0;
  t1.droppedPending = 0;

  // The reconstruction under test: rehydrate with the resolver re-establishes each seat's ladder from the
  // base record wire ids on the list, in slot order — so the target now climbs the right ladders even though
  // begin() never handed it these characters' per-slot config.
  target.rehydrate(ALL_BY_WIRE_ID, characterGrowthLadderForWireId);
  // Resolve the REBUILT stack into a fresh table and read it directly. (`loadoutAgreesWithStats` compares
  // against the live `stats`, which this hand-built mock never restored byte-for-byte — the realistic
  // snapshot round-trip below is what proves that agreement. Here we read the reconstructed stack itself,
  // which is exactly what the resolver's ladder feeds.)
  const reAfter = new Stats();
  target.loadoutAgreesWithStats(reAfter);
  check(
    "begin()-less rehydrate: seat 0's damage step was reconstructed",
    reAfter.values[charA.growth.stat] === dmgAtOne + charA.growth.add,
    `${reAfter.values[charA.growth.stat]}`,
  );
  check(
    "begin()-less rehydrate: seat 1's duration step was reconstructed",
    reAfter.values[charB.growth.stat] === durAtOne + charB.growth.add,
    `${reAfter.values[charB.growth.stat]}`,
  );

  // Now the real proof the ladder itself was rebuilt, not just the current step: advance EACH seat one more
  // growth gap and tick. If the ladder had been lost, the tier would never move again and these would stay
  // flat. They must climb to a SECOND step per seat.
  guard = 0;
  while (t0.level < charA.growth.everyLevels * 2 + 1 && guard++ < 10_000) t0.addXp(t0.xpToNext - t0.xp, target.stats);
  guard = 0;
  while (t1.level < charB.growth.everyLevels * 2 + 1 && guard++ < 10_000) t1.addXp(t1.xpToNext - t1.xp, target.stats);
  t0.pending = 0;
  t0.droppedPending = 0;
  t1.pending = 0;
  t1.droppedPending = 0;
  target.tick();
  check(
    "begin()-less rehydrate: seat 0 climbs to its SECOND damage step after the restore",
    target.stats.values[charA.growth.stat] === dmgAtOne + charA.growth.add * 2,
    `${target.stats.values[charA.growth.stat]} vs ${dmgAtOne + charA.growth.add * 2}`,
  );
  check(
    "begin()-less rehydrate: seat 1 climbs to its SECOND duration step after the restore",
    target.stats.values[charB.growth.stat] === durAtOne + charB.growth.add * 2,
    `${target.stats.values[charB.growth.stat]} vs ${durAtOne + charB.growth.add * 2}`,
  );

  // --- Path 2: a full snapshot round-trip onto a fresh run begun without the per-slot config -------
  // This is the realistic resync carrier: `snapshotRun`/`restoreRun` capture and rebuild the whole world,
  // and `restoreRun` now hands `rehydrate` the growth resolver. The receiving run is begun with NO per-slot
  // config, so its ladders start wrong for these seats; the restore must fix them.
  const snapSource = new Run();
  snapSource.begin({ seed: 24680, playerCount: 2, record: true, ...cfg });
  const sd0 = snapSource.progFor(0);
  const sd1 = snapSource.progFor(1);
  guard = 0;
  while (sd0.level < charA.growth.everyLevels + 1 && guard++ < 10_000) sd0.addXp(sd0.xpToNext - sd0.xp, snapSource.stats);
  guard = 0;
  while (sd1.level < charB.growth.everyLevels + 1 && guard++ < 10_000) sd1.addXp(sd1.xpToNext - sd1.xp, snapSource.stats);
  sd0.pending = 0;
  sd0.droppedPending = 0;
  sd1.pending = 0;
  sd1.droppedPending = 0;
  snapSource.tick();
  const snapDmgStep = snapSource.stats.values[charA.growth.stat];
  const snapDurStep = snapSource.stats.values[charB.growth.stat];
  const snapDmgBase = snapDmgStep - charA.growth.add;
  const snapDurBase = snapDurStep - charB.growth.add;

  const bytes = snapshotRun(snapSource);
  const restored = new Run();
  restored.begin({ seed: 24680, playerCount: 2, record: true });
  const code = restoreRun(restored, bytes);
  check("snapshot round-trip: restore accepted", code === SNAPSHOT_ERROR.NONE, `${code}`);
  check(
    "snapshot round-trip: the restored stats follow from the contents",
    restored.loadoutAgreesWithStats(new Stats()),
  );
  check(
    "snapshot round-trip: seat 0's damage step survived the restore",
    restored.stats.values[charA.growth.stat] === snapDmgStep,
    `${restored.stats.values[charA.growth.stat]} vs ${snapDmgStep}`,
  );
  check(
    "snapshot round-trip: seat 1's duration step survived the restore",
    restored.stats.values[charB.growth.stat] === snapDurStep,
    `${restored.stats.values[charB.growth.stat]} vs ${snapDurStep}`,
  );

  // And again the ladder proof: advance each seat past a second gap on the RESTORED run and confirm the
  // next step lands. Only a correctly reconstructed ladder can do this.
  const r0 = restored.progFor(0);
  const r1 = restored.progFor(1);
  guard = 0;
  while (r0.level < charA.growth.everyLevels * 2 + 1 && guard++ < 10_000) r0.addXp(r0.xpToNext - r0.xp, restored.stats);
  guard = 0;
  while (r1.level < charB.growth.everyLevels * 2 + 1 && guard++ < 10_000) r1.addXp(r1.xpToNext - r1.xp, restored.stats);
  r0.pending = 0;
  r0.droppedPending = 0;
  r1.pending = 0;
  r1.droppedPending = 0;
  restored.tick();
  check(
    "snapshot round-trip: seat 0 climbs to its SECOND damage step after the restore",
    restored.stats.values[charA.growth.stat] === snapDmgBase + charA.growth.add * 2,
    `${restored.stats.values[charA.growth.stat]} vs ${snapDmgBase + charA.growth.add * 2}`,
  );
  check(
    "snapshot round-trip: seat 1 climbs to its SECOND duration step after the restore",
    restored.stats.values[charB.growth.stat] === snapDurBase + charB.growth.add * 2,
    `${restored.stats.values[charB.growth.stat]} vs ${snapDurBase + charB.growth.add * 2}`,
  );
}

console.log(failures === 0 ? "\nPASS — a character inside a real run" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`character in a run: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
