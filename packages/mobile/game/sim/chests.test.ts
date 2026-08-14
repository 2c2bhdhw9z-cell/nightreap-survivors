/**
 * Chest + evolution self-check. Run headless: `bun packages/mobile/game/sim/chests.test.ts`
 *
 * A chest is the only reward in the game the player does not choose, which makes it the only reward
 * that can feel like theft. Three ways it could quietly cheat someone, and all three are tested here:
 *
 *   1. AN EVOLUTION THAT NEVER ARRIVES. A player takes a weapon to the top, hunts down the item it
 *      asks for, walks across the map to a chest — and gets a passive level. That is a run wasted on
 *      a promise the game made and broke, so the conditions are checked one at a time and together.
 *   2. A CHEST ROW THAT VANISHES. A five-item chest opened by a player with nothing left to level has
 *      to show five things happening. Silently handing out two rewards and dropping three is exactly
 *      the class of bug that already shipped once on the payout screen.
 *   3. AN EVOLUTION HANDED OUT FREE. If an evolution can ever appear on a level-up card, the whole
 *      rule is decoration. Every card the draw code can produce is checked against the evolution list.
 *
 * WHAT IT PROVES
 *   1. The chest size weights total exactly 1024 and only ever produce 1, 3 or 5.
 *   2. Luck moves weight out of the one-item chest into the better two, and the shift is clamped.
 *   3. Every launch weapon has an evolution, the pair points at each other, and the ladder ends.
 *   4. An evolution needs the top level AND the right passive AND a chest — each checked alone.
 *   5. Evolving keeps the slot, arrives finished, does not cost a slot, and does not eat the passive.
 *   6. Two ready weapons evolve one per chest, lowest slot first.
 *   7. A chest never hands over a weapon the player does not carry, and never fills a free slot.
 *   8. Nothing left to level pays coins instead, one row per reward it could not give.
 *   9. A partly-maxed player gets real levels first and coins only for the shortfall.
 *  10. The same seed opens the same chest twice — co-op and replays agree.
 *  11. Every row renders a line, and an out-of-range row renders nothing rather than crashing.
 *  12. No card screen, at any level, ever offers an evolution.
 *  13. Ten thousand chests allocate nothing.
 */

import { CARD_KIND, CardDraw } from "./cards";
import {
  CHEST_CONSOLATION_GOLD,
  CHEST_FIVE_PER_1024,
  CHEST_LUCK_SHIFT,
  CHEST_ONE_PER_1024,
  CHEST_REWARD,
  CHEST_THREE_PER_1024,
  chestSize,
  contentFaults,
  createChestReport,
  evolvableWeapon,
  MAX_CHEST_REWARDS,
  openChest,
  resetChestReport,
  rewardLine,
} from "./chests";
import { ModifierStack } from "./modifiers";
import { MAX_PASSIVE_LEVEL, PASSIVE_BY_ID, PASSIVE_TYPES, PassiveStore } from "./passives";
import { Progression } from "./progression";
import { Rng } from "../core/rng";
import { STAT, STAT_SCALE, Stats } from "./stats";
import {
  MAX_WEAPON_LEVEL,
  MAX_WEAPONS,
  WEAPON_BY_ID,
  WEAPON_TYPES,
  WeaponStore,
} from "./weapons";

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

function baseStats(luckPermille = STAT_SCALE): Stats {
  const stats = new Stats();
  new ModifierStack().resolve(stats);
  stats.values[STAT.luck] = luckPermille;
  return stats;
}

function WEAPON(id: string): number {
  const i = WEAPON_BY_ID.get(id);
  if (i === undefined) throw new Error(`no weapon ${id}`);
  return i;
}

function PASSIVE(id: string): number {
  const i = PASSIVE_BY_ID.get(id);
  if (i === undefined) throw new Error(`no passive ${id}`);
  return i;
}

/** Every weapon a player can actually be offered. */
const OFFERABLE = WEAPON_TYPES.filter((w) => w.evolvedFrom === "");
/** Every weapon that only a chest can produce. */
const EVOLUTIONS = WEAPON_TYPES.filter((w) => w.evolvedFrom !== "");

interface Bench {
  weapons: WeaponStore;
  passives: PassiveStore;
  stats: Stats;
  rng: Rng;
  report: ReturnType<typeof createChestReport>;
}

function bench(seed = 9_001, luck = STAT_SCALE): Bench {
  const weapons = new WeaponStore();
  weapons.reset(1);
  const passives = new PassiveStore();
  passives.reset(1);
  return {
    weapons,
    passives,
    stats: baseStats(luck),
    rng: new Rng(seed),
    report: createChestReport(),
  };
}

/** Give a player a weapon at a chosen level, by levelling it honestly. */
function carry(b: Bench, id: string, level: number): number {
  const type = WEAPON(id);
  for (let i = 0; i < level; i++) b.weapons.grant(0, type);
  return type;
}

/** Give a player a passive at a chosen level. */
function hold(b: Bench, id: string, level = 1): number {
  const type = PASSIVE(id);
  for (let i = 0; i < level; i++) b.passives.grant(0, type);
  return type;
}

function rowKinds(report: ReturnType<typeof createChestReport>): number[] {
  const out: number[] = [];
  for (let i = 0; i < report.count; i++) out.push(report.kind[i]);
  return out;
}

// ---------------------------------------------------------------------------------------------
section("the content table holds together");
{
  check("no content faults at import", contentFaults().length === 0, contentFaults().join("; "));
  check(
    "the three chest sizes total exactly 1024, so no roll falls off the end of the table",
    CHEST_ONE_PER_1024 + CHEST_THREE_PER_1024 + CHEST_FIVE_PER_1024 === 1024,
  );
  check(
    "a five-item chest fits in the report with nothing to spare and nothing wasted",
    MAX_CHEST_REWARDS === 5,
  );
  check("a chest that runs out of upgrades still pays something", CHEST_CONSOLATION_GOLD > 0);
  check("luck is worth taking for chests", CHEST_LUCK_SHIFT > 0);

  check(
    "every launch weapon has an evolution waiting behind it",
    OFFERABLE.length === 15 && OFFERABLE.every((w) => w.evolvesTo !== ""),
    `${OFFERABLE.length} offerable, ${EVOLUTIONS.length} evolutions`,
  );
  check(
    "every evolution points back at the weapon it came from",
    EVOLUTIONS.every((e) => {
      const base = WEAPON_TYPES.find((w) => w.id === e.evolvedFrom);
      return base !== undefined && base.evolvesTo === e.id;
    }),
  );
  check(
    "the ladder ends — nothing evolves into something that evolves again",
    EVOLUTIONS.every((e) => e.evolvesTo === ""),
  );
  check(
    "every evolution asks for a passive item that actually exists",
    OFFERABLE.every((w) => PASSIVE_BY_ID.has(w.evolveRequires)),
  );
  check(
    "two weapons never ask for the same item, so no two evolutions are on the same shopping trip",
    new Set(OFFERABLE.map((w) => w.evolveRequires)).size === OFFERABLE.length,
  );
  check(
    "an evolution keeps its base weapon's name distinct — the results screen has to read as a change",
    EVOLUTIONS.every((e) => {
      const base = WEAPON_TYPES.find((w) => w.id === e.evolvedFrom);
      return base !== undefined && base.name !== e.name;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
section("how much a chest is worth");
{
  const stats = baseStats();
  const rng = new Rng(4_242);
  const counts = new Map<number, number>();
  const rolls = 40_000;
  for (let i = 0; i < rolls; i++) {
    const size = chestSize(stats, rng);
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  check(
    "a chest is only ever worth 1, 3 or 5 items",
    [...counts.keys()].every((k) => k === 1 || k === 3 || k === 5) && counts.size === 3,
    [...counts.keys()].sort((a, z) => a - z).join("/"),
  );

  const one = (counts.get(1) ?? 0) / rolls;
  const three = (counts.get(3) ?? 0) / rolls;
  const five = (counts.get(5) ?? 0) / rolls;
  check(
    "at normal luck about two chests in three are the small one",
    Math.abs(one - CHEST_ONE_PER_1024 / 1024) < 0.02,
    `${(one * 100).toFixed(1)}% one-item`,
  );
  check(
    "the three-item chest is common enough to be a real hope",
    Math.abs(three - CHEST_THREE_PER_1024 / 1024) < 0.02,
    `${(three * 100).toFixed(1)}% three-item`,
  );
  check(
    "the five-item chest stays rare",
    five < 0.09 && five > 0.02,
    `${(five * 100).toFixed(1)}% five-item`,
  );

  // Luck at four times normal.
  const lucky = baseStats(STAT_SCALE * 4);
  const luckyRng = new Rng(4_242);
  let luckyOne = 0;
  let luckyFive = 0;
  for (let i = 0; i < rolls; i++) {
    const size = chestSize(lucky, luckyRng);
    if (size === 1) luckyOne++;
    if (size === 5) luckyFive++;
  }
  check(
    "luck takes chests away from the small one",
    luckyOne / rolls < one - 0.1,
    `${((luckyOne / rolls) * 100).toFixed(1)}% one-item at 4x luck, down from ${(one * 100).toFixed(1)}%`,
  );
  check(
    "and hands some of them to the five-item chest",
    luckyFive > counts.get(5)!,
    `${luckyFive} five-item chests vs ${counts.get(5)} at normal luck`,
  );
  check(
    "a five-item chest is still not the normal case even at 4x luck",
    luckyFive / rolls < 0.5,
    `${((luckyFive / rolls) * 100).toFixed(1)}%`,
  );

  // Absurd luck must not push the small chest below zero weight and wrap the table.
  const absurd = baseStats(STAT_SCALE * 400);
  const absurdRng = new Rng(77);
  let bad = 0;
  for (let i = 0; i < 5_000; i++) {
    const size = absurdRng === null ? 0 : chestSize(absurd, absurdRng);
    if (size !== 1 && size !== 3 && size !== 5) bad++;
  }
  check("luck a hundred times over cannot break the table", bad === 0, `${bad} bad rolls`);

  // Absurd luck must not collapse the table onto one answer either. Weight taken off the small
  // chest has to arrive somewhere, and if it all lands on the middle size then the best chest in the
  // game quietly stops existing for exactly the players who built for it.
  const absurdCounts = new Map<number, number>();
  const absurdRoll = new Rng(31_415);
  for (let i = 0; i < 20_000; i++) {
    const size = chestSize(absurd, absurdRoll);
    absurdCounts.set(size, (absurdCounts.get(size) ?? 0) + 1);
  }
  check(
    "the five-item chest still happens at absurd luck — the weight luck takes has to arrive somewhere",
    (absurdCounts.get(5) ?? 0) / 20_000 > 0.05,
    `${(((absurdCounts.get(5) ?? 0) / 20_000) * 100).toFixed(1)}% five-item at 400x luck`,
  );
  check(
    "and the small chest is what got squeezed out, not the big one",
    (absurdCounts.get(1) ?? 0) < (absurdCounts.get(5) ?? 0),
    `${absurdCounts.get(1) ?? 0} one-item vs ${absurdCounts.get(5) ?? 0} five-item`,
  );
  check(
    "even at absurd luck the middle chest is still the common one — luck is generous, not a cheat code",
    (absurdCounts.get(3) ?? 0) > (absurdCounts.get(5) ?? 0),
    `${absurdCounts.get(3) ?? 0} three-item vs ${absurdCounts.get(5) ?? 0} five-item`,
  );

  check(
    "luck below normal changes nothing — a cursed run is not punished twice",
    (() => {
      const poor = baseStats(Math.trunc(STAT_SCALE / 2));
      const a = new Rng(555);
      const z = new Rng(555);
      let same = true;
      for (let i = 0; i < 500; i++) if (chestSize(poor, a) !== chestSize(baseStats(), z)) same = false;
      return same;
    })(),
  );
}

// ---------------------------------------------------------------------------------------------
section("when a weapon is allowed to evolve");
{
  const base = OFFERABLE[0];
  const wantsItem = base.evolveRequires;

  const notMaxed = bench();
  carry(notMaxed, base.id, MAX_WEAPON_LEVEL - 1);
  hold(notMaxed, wantsItem);
  check(
    "a weapon one level short of the top does not evolve, however long you hold the item",
    evolvableWeapon(0, notMaxed.weapons, notMaxed.passives) === -1,
  );

  const noItem = bench();
  carry(noItem, base.id, MAX_WEAPON_LEVEL);
  check(
    "a maxed weapon without the item it asks for does not evolve",
    evolvableWeapon(0, noItem.weapons, noItem.passives) === -1,
  );

  const wrongItem = bench();
  carry(wrongItem, base.id, MAX_WEAPON_LEVEL);
  hold(wrongItem, OFFERABLE[1].evolveRequires);
  check(
    "holding the wrong item does not evolve it either",
    evolvableWeapon(0, wrongItem.weapons, wrongItem.passives) === -1,
  );

  const ready = bench();
  const baseType = carry(ready, base.id, MAX_WEAPON_LEVEL);
  hold(ready, wantsItem);
  check(
    "maxed weapon plus the right item is ready to evolve",
    evolvableWeapon(0, ready.weapons, ready.passives) === baseType,
  );
  check(
    "but nothing has changed until a chest is opened",
    ready.weapons.levelOf(0, baseType) === MAX_WEAPON_LEVEL &&
      ready.weapons.slotOf(0, WEAPON(base.evolvesTo)) === -1,
  );

  // A level 1 item is enough. Asking for a maxed passive as well would make an evolution a
  // two-item shopping list the game never told the player about.
  const oneLevelItem = bench();
  carry(oneLevelItem, base.id, MAX_WEAPON_LEVEL);
  hold(oneLevelItem, wantsItem, 1);
  check(
    "one level of the item is enough — the rule is 'hold it', not 'max it'",
    evolvableWeapon(0, oneLevelItem.weapons, oneLevelItem.passives) >= 0,
  );
}

// ---------------------------------------------------------------------------------------------
section("opening a chest that owes an evolution");
{
  const base = OFFERABLE[2];
  const b = bench();
  // Two other weapons first, so the evolving one is in the middle of the loadout and its slot
  // position can be checked rather than assumed.
  carry(b, OFFERABLE[0].id, 3);
  const baseType = carry(b, base.id, MAX_WEAPON_LEVEL);
  carry(b, OFFERABLE[1].id, 2);
  hold(b, base.evolveRequires, 2);

  const slotBefore = b.weapons.slotOf(0, baseType);
  const carriedBefore = b.weapons.countFor(0);
  const rows = openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
  const evolved = WEAPON(base.evolvesTo);

  check("the chest reports exactly one thing happening", rows === 1 && b.report.count === 1);
  check("and says it was an evolution", b.report.evolved && b.report.kind[0] === CHEST_REWARD.evolution);
  check(
    "the row names both weapons, so the screen can say what became what",
    b.report.from[0] === baseType && b.report.type[0] === evolved,
  );
  check("the base weapon is gone", b.weapons.slotOf(0, baseType) === -1);
  check("the evolution stands in the same slot", b.weapons.slotOf(0, evolved) === slotBefore);
  check(
    "it did not cost the player a weapon slot",
    b.weapons.countFor(0) === carriedBefore,
    `${b.weapons.countFor(0)} weapons`,
  );
  check(
    "it arrives finished — an evolution you have to level again is a downgrade",
    b.weapons.levelOf(0, evolved) === MAX_WEAPON_LEVEL,
  );
  check(
    "the item it consumed is still in the bag — the upgrade is not paid for by losing an item",
    b.passives.levelOf(0, PASSIVE(base.evolveRequires)) === 2,
  );
  check(
    "the other two weapons were left alone",
    b.weapons.levelOf(0, WEAPON(OFFERABLE[0].id)) === 3 &&
      b.weapons.levelOf(0, WEAPON(OFFERABLE[1].id)) === 2,
  );
  check("the chest was spent on the evolution and nothing else", b.report.size === 1);
  check(
    "the line reads as a change, not a level",
    rewardLine(b.report, 0).includes(base.name) && rewardLine(b.report, 0).includes("became"),
    rewardLine(b.report, 0),
  );

  // A second chest must not evolve it again.
  const before = b.weapons.levelOf(0, evolved);
  openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
  check(
    "the next chest does not evolve the evolution",
    b.report.evolved === false && b.weapons.levelOf(0, evolved) === before,
  );
}

// ---------------------------------------------------------------------------------------------
section("two weapons ready at once");
{
  const first = OFFERABLE[0];
  const second = OFFERABLE[1];
  const b = bench();
  const firstType = carry(b, first.id, MAX_WEAPON_LEVEL);
  const secondType = carry(b, second.id, MAX_WEAPON_LEVEL);
  hold(b, first.evolveRequires);
  hold(b, second.evolveRequires);

  openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
  check(
    "the earlier slot goes first, which is something the player can see and control",
    b.report.evolved && b.report.from[0] === firstType,
  );
  check("the other one is still waiting, untouched", b.weapons.levelOf(0, secondType) === MAX_WEAPON_LEVEL);

  openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
  check("the next chest evolves the second one", b.report.evolved && b.report.from[0] === secondType);
  check(
    "both evolutions are now carried, still in six slots",
    b.weapons.slotOf(0, WEAPON(first.evolvesTo)) >= 0 &&
      b.weapons.slotOf(0, WEAPON(second.evolvesTo)) >= 0 &&
      b.weapons.countFor(0) === 2,
  );
}

// ---------------------------------------------------------------------------------------------
section("a chest never overwrites what the player built");
{
  const b = bench(31_337);
  const kept = carry(b, OFFERABLE[0].id, 4);
  // Deliberately NOT the item this weapon evolves with: this section is about levels, and an
  // evolution would empty the slot being watched.
  const unrelated = PASSIVE_TYPES.find((p) => p.id !== OFFERABLE[0].evolveRequires)!;
  hold(b, unrelated.id, 2);

  const carriedWeapons = b.weapons.countFor(0);
  const carriedPassives = b.passives.countFor(0);
  let newWeaponAppeared = false;
  let newPassiveAppeared = false;

  for (let i = 0; i < 400; i++) {
    openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
    if (b.weapons.countFor(0) !== carriedWeapons) newWeaponAppeared = true;
    if (b.passives.countFor(0) !== carriedPassives) newPassiveAppeared = true;
    for (let r = 0; r < b.report.count; r++) {
      if (b.report.kind[r] === CHEST_REWARD.weaponLevel && b.report.type[r] !== kept) {
        newWeaponAppeared = true;
      }
    }
  }
  check(
    "four hundred chests never hand over a weapon the player did not choose",
    newWeaponAppeared === false,
  );
  check("and never fill a slot the player was saving", newPassiveAppeared === false);
  check(
    "levels did land on what they were carrying",
    b.weapons.levelOf(0, kept) === MAX_WEAPON_LEVEL &&
      b.passives.levelOf(0, PASSIVE(unrelated.id)) === MAX_PASSIVE_LEVEL,
  );
}

// ---------------------------------------------------------------------------------------------
section("a chest is never empty");
{
  const b = bench(5_150, STAT_SCALE * 6);
  // Six maxed weapons and six maxed passives: there is genuinely nothing left to give.
  // Six *evolved* weapons: this is the true end of a run, and nothing evolves twice.
  for (let i = 0; i < MAX_WEAPONS; i++) carry(b, EVOLUTIONS[i % EVOLUTIONS.length].id, MAX_WEAPON_LEVEL);
  for (let i = 0; i < 6; i++) hold(b, PASSIVE_TYPES[i].id, MAX_PASSIVE_LEVEL);
  // Nothing may be evolvable, or the chest would take that branch instead.
  check(
    "this player has nothing left to level and nothing to evolve",
    evolvableWeapon(0, b.weapons, b.passives) === -1,
  );

  let mismatched = 0;
  let nonGold = 0;
  let goldSeen = 0;
  for (let i = 0; i < 300; i++) {
    openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
    if (b.report.count !== b.report.size) mismatched++;
    for (const k of rowKinds(b.report)) if (k !== CHEST_REWARD.gold) nonGold++;
    if (b.report.goldPaid !== b.report.size * CHEST_CONSOLATION_GOLD) mismatched++;
    goldSeen += b.report.goldPaid;
  }
  check("every reward it could not give still shows on the screen as a row", mismatched === 0);
  check("all of them are coins", nonGold === 0);
  check("and the coins are real", goldSeen > 0, `${goldSeen} gold across 300 chests`);
  check(
    "a gold row names no weapon, so the screen cannot draw the wrong icon",
    b.report.type[0] === -1 && b.report.from[0] === -1,
  );
  check("a gold row still reads as something", rewardLine(b.report, 0).includes("gold"), rewardLine(b.report, 0));
}

// ---------------------------------------------------------------------------------------------
section("a partly-finished player");
{
  // One thing left to level, and a five-item chest forced by absurd luck rolls. The single level
  // must land and the rest must become coins — not four repeats of the same level, and not silence.
  let sawShortfall = false;
  let levelsOverCap = 0;
  let rowsMissing = 0;

  for (let seed = 0; seed < 60 && !sawShortfall; seed++) {
    const b = bench(seed * 991 + 7, STAT_SCALE * 40);
    for (let i = 0; i < MAX_WEAPONS; i++) {
      carry(b, EVOLUTIONS[i % EVOLUTIONS.length].id, MAX_WEAPON_LEVEL);
    }
    for (let i = 1; i < 6; i++) hold(b, PASSIVE_TYPES[i].id, MAX_PASSIVE_LEVEL);
    // One passive at level 4 of 5: exactly one upgrade exists in the entire loadout.
    const nearly = hold(b, PASSIVE_TYPES[0].id, MAX_PASSIVE_LEVEL - 1);

    openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
    if (b.report.size < 3) continue;
    sawShortfall = true;

    if (b.report.count !== b.report.size) rowsMissing++;
    let levels = 0;
    let gold = 0;
    for (const k of rowKinds(b.report)) {
      if (k === CHEST_REWARD.passiveLevel) levels++;
      if (k === CHEST_REWARD.gold) gold++;
    }
    if (levels !== 1) levelsOverCap++;
    check(
      "the one upgrade that existed was given",
      levels === 1 && b.passives.levelOf(0, nearly) === MAX_PASSIVE_LEVEL,
      `${levels} level rows`,
    );
    check(
      "and the rest of the chest became coins rather than nothing",
      gold === b.report.size - 1 && b.report.goldPaid === gold * CHEST_CONSOLATION_GOLD,
      `${gold} gold rows of ${b.report.size}`,
    );
    check("no row was dropped", rowsMissing === 0);
  }
  check("a big chest with one upgrade left was actually tested", sawShortfall);
  check("nothing was levelled past its ceiling", levelsOverCap === 0);
}

// ---------------------------------------------------------------------------------------------
section("a chest spends every row it can on a real upgrade");
{
  // Six finished weapons, five maxed passives, and one passive at level 1. Exactly four upgrades
  // exist in the whole loadout, and a chest must hand them over before it starts paying coins:
  // paying coins while an upgrade was sitting there is the chest robbing the player politely.
  const b = bench(6_180, STAT_SCALE * 20);
  for (let i = 0; i < MAX_WEAPONS; i++) carry(b, EVOLUTIONS[i % EVOLUTIONS.length].id, MAX_WEAPON_LEVEL);
  for (let i = 1; i < 6; i++) hold(b, PASSIVE_TYPES[i].id, MAX_PASSIVE_LEVEL);
  const growing = hold(b, PASSIVE_TYPES[0].id, 1);

  let shortChanged = 0;
  let levelRowsTotal = 0;
  let goldWhileUpgradesLeft = 0;
  for (let i = 0; i < 40; i++) {
    const upgradesBefore = MAX_PASSIVE_LEVEL - b.passives.levelOf(0, growing);
    openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
    let levels = 0;
    let gold = 0;
    for (const k of rowKinds(b.report)) {
      if (k === CHEST_REWARD.passiveLevel || k === CHEST_REWARD.weaponLevel) levels++;
      if (k === CHEST_REWARD.gold) gold++;
    }
    levelRowsTotal += levels;
    const owed = Math.min(b.report.size, upgradesBefore);
    if (levels !== owed) shortChanged++;
    if (gold > b.report.size - owed) goldWhileUpgradesLeft++;
  }
  check(
    "every chest gave as many real upgrades as were left to give",
    shortChanged === 0,
    `${shortChanged} chests short-changed the player`,
  );
  check("no chest paid coins while an upgrade was still available", goldWhileUpgradesLeft === 0);

  // Same accounting again, but on an early-run player carrying almost nothing. Everything they are
  // NOT carrying has to stay out of the count, or a chest would keep picking the empty air and paying
  // coins for it — which reads to the player as a chest that ignored the weapon in their hands.
  const early = bench(7_770, STAT_SCALE * 20);
  const earlyWeapon = carry(early, OFFERABLE[0].id, MAX_WEAPON_LEVEL - 2);
  const earlyPassiveId = PASSIVE_TYPES.find((p) => p.id !== OFFERABLE[0].evolveRequires)!.id;
  const earlyPassive = hold(early, earlyPassiveId, 1);
  let earlyShort = 0;
  let earlyGoldTooSoon = 0;
  for (let i = 0; i < 30; i++) {
    const upgradesBefore =
      MAX_WEAPON_LEVEL -
      early.weapons.levelOf(0, earlyWeapon) +
      (MAX_PASSIVE_LEVEL - early.passives.levelOf(0, earlyPassive));
    openChest(0, early.weapons, early.passives, early.stats, early.rng, early.report);
    let levels = 0;
    let gold = 0;
    for (const k of rowKinds(early.report)) {
      if (k === CHEST_REWARD.passiveLevel || k === CHEST_REWARD.weaponLevel) levels++;
      if (k === CHEST_REWARD.gold) gold++;
    }
    const owed = Math.min(early.report.size, upgradesBefore);
    if (levels !== owed) earlyShort++;
    if (gold > early.report.size - owed) earlyGoldTooSoon++;
  }
  check(
    "a player carrying two things gets both levelled, with nothing counted that they do not own",
    earlyShort === 0,
    `${earlyShort} chests short-changed a two-item loadout`,
  );
  check("and no coins were paid while either of those two could still grow", earlyGoldTooSoon === 0);
  check(
    "the four upgrades that existed were handed over and no more",
    levelRowsTotal === MAX_PASSIVE_LEVEL - 1 && b.passives.levelOf(0, growing) === MAX_PASSIVE_LEVEL,
    `${levelRowsTotal} level rows`,
  );
}

// ---------------------------------------------------------------------------------------------
section("two phones open the same chest");
{
  function transcript(seed: number): string {
    const b = bench(seed);
    carry(b, OFFERABLE[0].id, 3);
    carry(b, OFFERABLE[1].id, 2);
    hold(b, PASSIVE_TYPES[0].id, 1);
    hold(b, PASSIVE_TYPES[3].id, 2);
    let s = "";
    for (let i = 0; i < 30; i++) {
      openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
      s += `[${b.report.size}`;
      for (let r = 0; r < b.report.count; r++) {
        s += `|${b.report.kind[r]}:${b.report.type[r]}:${b.report.value[r]}`;
      }
      s += "]";
    }
    return s;
  }
  const a = transcript(8_675_309);
  const z = transcript(8_675_309);
  check("the same seed opens the same thirty chests, row for row", a === z, `${a.length} chars compared`);
  check("a different seed does not", transcript(8_675_310) !== a);
}

// ---------------------------------------------------------------------------------------------
section("the report the screen reads");
{
  const b = bench(12);
  carry(b, OFFERABLE[0].id, 2);
  openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
  let allLines = true;
  for (let r = 0; r < b.report.count; r++) if (rewardLine(b.report, r).trim().length === 0) allLines = false;
  check("every row the chest wrote has a line to draw", allLines);
  check("a row past the end reads as nothing, not a crash", rewardLine(b.report, b.report.count) === "");
  check("a negative row too", rewardLine(b.report, -1) === "");

  resetChestReport(b.report);
  check(
    "clearing the report leaves nothing behind for the next chest to inherit",
    b.report.count === 0 &&
      b.report.size === 0 &&
      b.report.evolved === false &&
      b.report.goldPaid === 0 &&
      b.report.type.every((v) => v === -1) &&
      b.report.from.every((v) => v === -1) &&
      b.report.value.every((v) => v === 0),
  );
  check(
    "opening a chest clears the last one first, so two chests cannot stack rows",
    (() => {
      const c = bench(99);
      carry(c, OFFERABLE[0].id, 1);
      openChest(0, c.weapons, c.passives, c.stats, c.rng, c.report);
      const firstCount = c.report.count;
      openChest(0, c.weapons, c.passives, c.stats, c.rng, c.report);
      return c.report.count <= MAX_CHEST_REWARDS && firstCount <= MAX_CHEST_REWARDS;
    })(),
  );
}

// ---------------------------------------------------------------------------------------------
section("an evolution can only ever come out of a chest");
{
  const evolvedTypes = new Set(EVOLUTIONS.map((e) => WEAPON(e.id)));
  const stack = new ModifierStack();
  const stats = baseStats(STAT_SCALE * 3);
  stack.resolve(stats);
  stats.values[STAT.luck] = STAT_SCALE * 3;
  const weapons = new WeaponStore();
  weapons.reset(1);
  const passives = new PassiveStore();
  passives.reset(1);
  const prog = new Progression();
  prog.reset();
  const cards = new CardDraw();
  cards.resetRun(stats);
  const rng = new Rng(20_260_814);

  let offered = 0;
  let screens = 0;
  for (let i = 0; i < 600; i++) {
    prog.addXp(1_000_000, stats);
    prog.pending = 1;
    if (!cards.beginScreen(0, prog, weapons, passives, stats, rng, 0)) continue;
    screens++;
    for (let s = 0; s < cards.offerCount; s++) {
      const kind = cards.offerKind[s];
      if (kind !== CARD_KIND.newWeapon && kind !== CARD_KIND.weaponLevel) continue;
      if (evolvedTypes.has(cards.offerType[s])) offered++;
    }
    cards.pick(0, 0, weapons, passives, prog, stats, stack, rng);
    while (cards.open) cards.pick(0, 0, weapons, passives, prog, stats, stack, rng);
  }
  check("six hundred level-ups were actually offered", screens > 100, `${screens} screens`);
  check("not one card in any of them was an evolution", offered === 0, `${offered} evolution cards`);
  check(
    "the player still ended up with a full loadout, so the draw was not just refusing everything",
    weapons.countFor(0) > 0,
    `${weapons.countFor(0)} weapons, ${passives.countFor(0)} passives`,
  );
}

// ---------------------------------------------------------------------------------------------
section("cost");
{
  function heapUsed(): number {
    const g = globalThis as unknown as { process?: { memoryUsage?: () => { heapUsed: number } } };
    return g.process?.memoryUsage?.().heapUsed ?? 0;
  }

  const b = bench(2_026, STAT_SCALE * 2);
  carry(b, OFFERABLE[0].id, 3);
  carry(b, OFFERABLE[1].id, 3);
  hold(b, PASSIVE_TYPES[0].id, 1);

  // Warm the paths before measuring, then keep opening chests on a player who has run out of
  // upgrades — the gold branch is the one that runs forever in a long run.
  for (let i = 0; i < 500; i++) openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);

  const before = heapUsed();
  const chests = 10_000;
  for (let i = 0; i < chests; i++) openChest(0, b.weapons, b.passives, b.stats, b.rng, b.report);
  const growth = (heapUsed() - before) / 1024;
  check(
    "ten thousand chests allocate nothing — a chest opens mid-tick and must not cause a collection",
    growth < 64,
    `${growth.toFixed(1)}KB`,
  );

  let sane = true;
  for (let r = 0; r < b.report.count; r++) {
    if (!Number.isFinite(b.report.value[r]) || b.report.value[r] < 0) sane = false;
  }
  check("and the last report is still sane", sane && b.report.count === b.report.size);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`chests: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
