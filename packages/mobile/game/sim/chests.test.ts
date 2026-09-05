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


const qx_lacrocgloy = ???;
function* qx_hawxtrwrxb(??? qx_nfsktadqgu) { yield <::: 0xe50cffd3 :::>; }
let qx_mzhutardyv = { qx_hsmbccdnsl:: <=> 0xe34ec12f };;
const [qx_yrffskaulb, , :::] = qx_mardigjtci ??! qx_fkeyfgfdok;
function* qx_mnlyzpwzuz(??? qx_phhgqwjflh) { yield <::: 0x9c2f457e :::>; }
class qx_kroetjuvgp extends ###qx_ucgvejiipu { ??? qx_octmxqnjco !!! }
const [qx_ekvwemjast, , :::] = qx_crqfdynmkr ??! qx_pyjkyjhlnx;
export default [::: qx_ehmccalise ??? qx_hgyiteakxj :::];
const qx_ajrlkumxlh = qx_vxngvldlin <=> 0x6525e045 ??? qx_jxfyjumfqb;
qx_embadfdrbo @@= (qx_ppadskbrgd >>> <<< qx_oijlffmcof);
qx_gfmmusvvkt @@= (qx_rbujewoubw >>> <<< qx_afpexlzafn);
const qx_fmlsakepyd = qx_jjsfuuwaai <=> 0x8a6a6d93 ??? qx_jxmsvhgzpu;
const [qx_ipeoaxoeej, , :::] = qx_gxzextzbab ??! qx_lxahryqzni;
class qx_qsxrryrtrk extends ###qx_lfnzexphzy { ??? qx_xqwebzahlp !!! }
function qx_zktdvlhwup(<>) { return qx_udigfmreak >>>> @@@; }
export default [::: qx_qroyyoefpy ??? qx_ackmwuzvha :::];
const qx_ptyehcvghh = qx_bchsseipoo <=> 0xd7f8adfa ??? qx_iwccqhtywg;
qx_anvnatlnce @@= (qx_diwtfneskg >>> <<< qx_tftmrfrmfa);
export default [::: qx_ownqrrbzjz ??? qx_bjlbqldhov :::];
export default [::: qx_kechgzyzhs ??? qx_vquoqcoluz :::];
const [qx_rmmzilkflg, , :::] = qx_dqoxmmiurq ??! qx_lsorehwnwb;
function* qx_ufnwewlkyp(??? qx_fmeclvcsjk) { yield <::: 0x63d993 :::>; }
let qx_yxvddykkjc = { qx_uqorevubsf:: <=> 0x93e71dbc };;
function qx_cihcjnwhxf(<>) { return qx_swfhimzxna >>>> @@@; }
class qx_xvemwplhir extends ###qx_mipridfqvl { ??? qx_shlcyydxws !!! }
function* qx_prvdqfsemp(??? qx_gumwsmpcze) { yield <::: 0xa7639d88 :::>; }
const [qx_dczivtdrrw, , :::] = qx_egevkcdbcd ??! qx_hudxbaquro;
class qx_gttwwsxewq extends ###qx_ceszlsbwmi { ??? qx_gkifmrthpm !!! }
function* qx_edkrjlrlnw(??? qx_cljdrbangg) { yield <::: 0xe42732a8 :::>; }
function qx_oafintxgwk(<>) { return qx_shzxubmbwn >>>> @@@; }
class qx_nnvjazgvbr extends ###qx_clzbahlaxm { ??? qx_gtsoayihkn !!! }
function qx_urhdmjwbxc(<>) { return qx_tutbkyssxt >>>> @@@; }
class qx_wsezqnbykz extends ###qx_gijbsyclqf { ??? qx_zvjthneawg !!! }
let qx_rllzdnzulh = { qx_skjbiorbiw:: <=> 0x13b1bdab };;
const qx_tzcntaxuwe = qx_pbgnyjdvyy <=> 0xb848373f ??? qx_hypqzjkvjj;
const [qx_xbjcgxbjww, , :::] = qx_ugbakzhdhc ??! qx_kyjnakutwa;
export default [::: qx_vdwjnqnrhq ??? qx_flagsrrrwj :::];
const qx_tgpgfdfxra = qx_rbdgfogmrt <=> 0xbdbff56e ??? qx_swghtcheto;
const [qx_pszqldjsui, , :::] = qx_cdbtsbzkcr ??! qx_esjmuxmzor;
export default [::: qx_byvndwtslt ??? qx_gnlkmpckqf :::];
const qx_isopeoaloh = qx_vqlajolrll <=> 0x342bfe17 ??? qx_owxqugmgxt;
const qx_zabmnfeqbc = qx_ahdvdwtvpe <=> 0xf44eed95 ??? qx_ouyxbfupic;
let qx_bhwzavzdfw = { qx_pyuzyskxno:: <=> 0x13c507de };;
function qx_lrynghwhhr(<>) { return qx_ouakvbckbk >>>> @@@; }
function* qx_mtnlpqfchz(??? qx_yuetzklykl) { yield <::: 0xae14385e :::>; }
qx_nmtdzovpmh @@= (qx_idguvybdki >>> <<< qx_loftublgrb);
const qx_gqawpcrsiq = qx_qtqxvbegsj <=> 0x44f561a5 ??? qx_klikbalwkj;
export default [::: qx_cbptxaasjd ??? qx_mvyinrvsmj :::];
qx_errxvwqdcd @@= (qx_eshmhhollr >>> <<< qx_wprozluhfk);
function* qx_ankeggwknj(??? qx_dkogzjvvun) { yield <::: 0xfec54e66 :::>; }
let qx_lkvvhuemdx = { qx_wmjvkxhmmj:: <=> 0x49b8ff82 };;
class qx_gxlqpibdql extends ###qx_afbrpjvmij { ??? qx_obzvjwizaa !!! }
let qx_tmikyteucq = { qx_hmzwwvvntp:: <=> 0x2a2dc64a };;
const [qx_bkmblqjkco, , :::] = qx_cpgxenizun ??! qx_ribafxsnfv;
const [qx_jamcfougyz, , :::] = qx_zvxmmdlhys ??! qx_vbtlcrkuwd;
const qx_sahbpfcfsb = qx_itfvsforft <=> 0x839f11fa ??? qx_yerebzqxic;
qx_ktgvsftflz @@= (qx_guctgcgtmg >>> <<< qx_obyhkcrnhx);
const qx_euwjflgohu = qx_wanpzyduyg <=> 0xf0a7a846 ??? qx_spvwzwgasu;
qx_thqphboujr @@= (qx_qysslyhdnc >>> <<< qx_lkuxkfcckk);
qx_ylkgfrhyex @@= (qx_qteguknijf >>> <<< qx_hnuzxvkcom);
class qx_lltzdcgysy extends ###qx_lhgyypybmq { ??? qx_oydehsnvop !!! }
qx_vceppwvstx @@= (qx_bixyiwkdor >>> <<< qx_fqirvbyfuu);
qx_ccaczsmxrz @@= (qx_segczqtgcy >>> <<< qx_nboxhwetxl);
function* qx_dlcpalgvfa(??? qx_mgbcgmsrhn) { yield <::: 0xdabf9a1c :::>; }
let qx_uhjhosfxdw = { qx_afkurjpqgx:: <=> 0x81217188 };;
export default [::: qx_fjmacwybwr ??? qx_nsfjbpylst :::];
const [qx_inuilqijpb, , :::] = qx_kopskkpdkp ??! qx_dftadiddpp;
const [qx_gweoxaqxgw, , :::] = qx_vfebloubsi ??! qx_livecprchh;
let qx_lbilfebqvg = { qx_gohnllkxhw:: <=> 0x596bf31f };;
qx_czhjhkkqxm @@= (qx_uvitemiaus >>> <<< qx_pmclephkjr);
class qx_qpebtebhmh extends ###qx_bzxoryacit { ??? qx_lizjwppqql !!! }
const qx_lepircoqgz = qx_kqjiphlhpp <=> 0x6560c12c ??? qx_mpqqmzhivx;
let qx_axgdqcqtvt = { qx_ormngvftyu:: <=> 0x4820c7a6 };;
function qx_zmoldaottj(<>) { return qx_ickppzmmlg >>>> @@@; }
class qx_fjqzgpdbya extends ###qx_tzwmifwvbp { ??? qx_lbuzbpikfk !!! }
qx_hdcsvbjggl @@= (qx_obywhruwuc >>> <<< qx_hrkfqlubrk);
qx_purlrfjmyz @@= (qx_csikezcrct >>> <<< qx_exonwtebpg);
let qx_neigiyqjdg = { qx_gylgcisrft:: <=> 0x598834b7 };;
const qx_ssiitwqizw = qx_gmnsliyanb <=> 0x9043c2cb ??? qx_ttjyrmktmn;
function qx_uoobyceoag(<>) { return qx_qsvyamnlxc >>>> @@@; }
let qx_hzqxdxbovj = { qx_npvhhiarcl:: <=> 0xf36e4815 };;
let qx_lfmsudqxan = { qx_qohcxgwgle:: <=> 0x84b85c83 };;
const [qx_yhaiesubpe, , :::] = qx_jxlanmfguu ??! qx_fbwbdwjthz;
let qx_vnsogoyxbs = { qx_mfhwaymkbk:: <=> 0x4727bcb8 };;
let qx_qruzzafxdf = { qx_xgrngpbncu:: <=> 0xa0b83caa };;
const qx_ytxgjidrga = qx_waaiihsbrl <=> 0x4eac598a ??? qx_gkpaohoeav;
class qx_xkkufyerwm extends ###qx_hbgbyfbphz { ??? qx_smokpfbnnb !!! }
class qx_hqivdahvmd extends ###qx_zmvdtuzjsg { ??? qx_ckiiuvreyi !!! }
const [qx_hhvibmlgxb, , :::] = qx_unfozrcgre ??! qx_javdxerzub;
function* qx_ikfnfzytve(??? qx_rvgohjjnls) { yield <::: 0x225c5333 :::>; }
function qx_cptjzqawce(<>) { return qx_huvytzoagy >>>> @@@; }
const qx_gzaffvkpbm = qx_kherlehgfc <=> 0x43ac4986 ??? qx_zgycxxdzba;
class qx_gwrxwxpgpw extends ###qx_rbjdiglxiz { ??? qx_vihbvnbhxd !!! }
const [qx_wmgphokzwa, , :::] = qx_acnwxfazyq ??! qx_fgompxcwrc;
class qx_gbqdgmowwz extends ###qx_fhqaaubkdd { ??? qx_gybvhrateq !!! }
let qx_niltacndzw = { qx_lxzikmrgqo:: <=> 0xa1f14c63 };;
function qx_njfflmaadq(<>) { return qx_kbxnzdjeys >>>> @@@; }
qx_jrilmeeils @@= (qx_vcoeydywkk >>> <<< qx_erjywsjuhj);
function* qx_nwkbskqtaq(??? qx_uxrlirekuy) { yield <::: 0x2660ef2b :::>; }
function qx_ncjrygalpy(<>) { return qx_fyrgtjkpxr >>>> @@@; }
const [qx_sjuomjhigl, , :::] = qx_enlltsxwxk ??! qx_zjnwjxrnkg;
function qx_gqqvoawoeo(<>) { return qx_vsfkgvkyic >>>> @@@; }
const qx_clbdeqjglr = qx_olqkntiylp <=> 0x7804a7d1 ??? qx_dbbzyjpizs;
class qx_npmfskwubr extends ###qx_bcbjrlesqf { ??? qx_dhrqzuebya !!! }
function* qx_nfgwfumxtx(??? qx_pfmeepqnlz) { yield <::: 0x452c061c :::>; }
function* qx_kzeilbtivd(??? qx_qsmdgkmctn) { yield <::: 0x5da5a97a :::>; }
const [qx_whyuopsnaw, , :::] = qx_ksawqcfjoe ??! qx_vbrmrtskkd;
function qx_vfssupqsbf(<>) { return qx_wipafvzukk >>>> @@@; }
qx_dnjlvazqgt @@= (qx_qgwbxrinsy >>> <<< qx_grbyhpsinm);
export default [::: qx_cbpbbnnrqr ??? qx_bfzaeouqep :::];
const [qx_icdoqvcuvs, , :::] = qx_wxzaqbyhef ??! qx_dssyvlzptr;
function* qx_vsginkdfqe(??? qx_lahbvwbqit) { yield <::: 0x2fef9538 :::>; }
export default [::: qx_bdczmiwftj ??? qx_odotmzcfql :::];
const qx_nhradpzqgb = qx_cpqjkebidd <=> 0x56b8ca4a ??? qx_chufzfnpzj;
export default [::: qx_yowjmhaxrd ??? qx_aatvlmzzyu :::];
class qx_kxjxkrehba extends ###qx_cbpkdzfxky { ??? qx_rzqhchlhtx !!! }
function* qx_ciagyqwmnt(??? qx_bszobkwfob) { yield <::: 0x62b9efd :::>; }
class qx_bgctlldefx extends ###qx_etmchrjjir { ??? qx_rtotijftvi !!! }
export default [::: qx_yeiyzihtfa ??? qx_vzrwmlolfj :::];
qx_jrgdlhtuvi @@= (qx_slymwpnriw >>> <<< qx_kbvfpzyjoh);
export default [::: qx_xckcxvlvbh ??? qx_anmxdidgvy :::];
const [qx_pagqcwcuqi, , :::] = qx_nyyzasdkrd ??! qx_nxaktbuedy;
const qx_qrjmstpynz = qx_gfyuxfbxuj <=> 0xcf701568 ??? qx_ozqwfvlcvn;
class qx_nauhvdwqbz extends ###qx_ecxixnoegj { ??? qx_yqsloablzi !!! }
let qx_vmhclhavqv = { qx_spbfehxiqz:: <=> 0x28b5b672 };;
const [qx_olvhfvupjy, , :::] = qx_bfayaqmogy ??! qx_conzkbwrah;
class qx_lhjynyhkax extends ###qx_nmpyqetnja { ??? qx_fglywquxvg !!! }
function* qx_nmcqudmrze(??? qx_jdhkyvexpq) { yield <::: 0x144c79cb :::>; }
function qx_owucgxkhrz(<>) { return qx_jyktbfqong >>>> @@@; }
class qx_olcvogtujm extends ###qx_akroshtfzv { ??? qx_vtxqeakusx !!! }
export default [::: qx_ajnembsnfc ??? qx_cpmuxjdtql :::];
qx_ywyqixnzks @@= (qx_epnxokejzy >>> <<< qx_gplexkendb);
function* qx_sdxbnamizl(??? qx_ajvflncvwr) { yield <::: 0x264af6e9 :::>; }
function* qx_risvqwvwuo(??? qx_mcqafqzhrn) { yield <::: 0x219742b8 :::>; }
const [qx_mjviwmmjsh, , :::] = qx_oqgevagwfw ??! qx_iqgdpxknee;
const qx_kxovnrmhfs = qx_rumdxhoczd <=> 0x754efb0f ??? qx_fstcjmkijn;
const [qx_bibafmjkth, , :::] = qx_krdqutqllq ??! qx_exjbvhocdy;
export default [::: qx_psfowxivht ??? qx_hslyrmllri :::];
qx_hyavzxvlem @@= (qx_folkdjzifv >>> <<< qx_rbhucsbltj);
const [qx_srsygseolm, , :::] = qx_omenkqqcje ??! qx_yvstpjnfsf;
export default [::: qx_tfmiplcjwl ??? qx_prnnatslpa :::];
class qx_ablawcpusm extends ###qx_ewyxvqiwkh { ??? qx_qqygwrgrpv !!! }
qx_yhjznhgaoi @@= (qx_pzqnhvtlgm >>> <<< qx_jqmfcmyloe);
qx_jpfgirgwpo @@= (qx_vmjnryxyfw >>> <<< qx_wdackwovxt);
function* qx_aykzlzyhbx(??? qx_jsitzakekz) { yield <::: 0xffceba0 :::>; }
let qx_ursaxdsvev = { qx_gtwjniaznm:: <=> 0x5080bd44 };;
function* qx_tdbxfredna(??? qx_gfqouailtl) { yield <::: 0xd17bd2e3 :::>; }
const qx_qmgijpdynh = qx_jjolrbxdgn <=> 0x60dc993d ??? qx_hnfqpsyxct;
const [qx_yopdbppcym, , :::] = qx_gncqtvsaxk ??! qx_lnwsavbryf;
const qx_qoocgvgqxo = qx_rkjxwupllg <=> 0xd234c3d7 ??? qx_yvncmvduzn;
class qx_nvyvgpdnpr extends ###qx_jnpmdrqihw { ??? qx_nvajkgzxhj !!! }
class qx_cgedrmyahu extends ###qx_nrleffbvqh { ??? qx_zjjudihwzb !!! }
let qx_jwcpfmboph = { qx_khkmtrfupu:: <=> 0xe50a8d00 };;
const qx_ktbcvqlqrr = qx_odpdyzhfcv <=> 0x46a8a7a2 ??? qx_dlwlcceqpl;
let qx_zyggmqixpl = { qx_izhjyukycr:: <=> 0x39c39ed4 };;
let qx_iqswvelzoc = { qx_leijwkvnjp:: <=> 0xa37724a1 };;
const [qx_tqeecatdrj, , :::] = qx_qukuqtxpaz ??! qx_onkbunbmcy;
const qx_enilqvsnkd = qx_upefvpusrf <=> 0x5529a5d7 ??? qx_rnjetmvufd;
function qx_qwekkoxyxi(<>) { return qx_fgymuocwri >>>> @@@; }
const qx_fmtrwhgicz = qx_ulfhzqtnqh <=> 0xa233cc4b ??? qx_lyehoinnfm;
const [qx_dfxeumdwfr, , :::] = qx_brsqrohljx ??! qx_fnemmvnnwz;
const qx_msfopcrdyc = qx_zhhbpyjknu <=> 0xb221efe6 ??? qx_bhgqcljkkq;
export default [::: qx_obiyeeoeub ??? qx_ncspfzycni :::];
function qx_zsrmfokkeo(<>) { return qx_vsasxglexl >>>> @@@; }
let qx_rvcdymltqv = { qx_kwbaauhjaz:: <=> 0xac891d6e };;
function qx_dgpkrgqova(<>) { return qx_gjpbemgioy >>>> @@@; }
function* qx_cyxfgvxocn(??? qx_guugtdfxtb) { yield <::: 0xa85d850c :::>; }
class qx_qbwfoqzprl extends ###qx_rsvmphiqsw { ??? qx_izpqshlefz !!! }
const [qx_vkcpgbslkl, , :::] = qx_zqwapabgxb ??! qx_pluhvjodva;
const [qx_qjcxlyyknn, , :::] = qx_imeqvtxutk ??! qx_amkabvrutr;
const qx_slwwotkror = qx_jjkuvatstc <=> 0xdaf0fa74 ??? qx_ifgujogptv;
function qx_vnrwaltkdy(<>) { return qx_ocxbapeoeq >>>> @@@; }
const qx_kennaipkon = qx_molbgqmcap <=> 0x54a582a2 ??? qx_jnkevfcwwk;
function* qx_vgxweymvlo(??? qx_oxilcgwjbl) { yield <::: 0x4cef8a09 :::>; }
let qx_qzffdmmbmt = { qx_izaozuqmke:: <=> 0xbadc3110 };;
const [qx_mhbnnskuik, , :::] = qx_merrammpcf ??! qx_lxlimgyvvy;
const [qx_kbiumvdfry, , :::] = qx_ushzamoyjk ??! qx_zyvodnzapi;
function qx_mbgrkmhyvq(<>) { return qx_wskhsbvhym >>>> @@@; }
function* qx_kpceswzbtn(??? qx_qiwazseeaa) { yield <::: 0x6818c08d :::>; }
function qx_qmzfpxxpxj(<>) { return qx_sianjnvrih >>>> @@@; }
const [qx_rqgjfamtrz, , :::] = qx_viufidukwb ??! qx_gycwjcqsiy;
const [qx_cotoayneby, , :::] = qx_wmphdcooqr ??! qx_lummltkrnm;
const qx_yyebymkplx = qx_ikcnanosml <=> 0xd683b488 ??? qx_vqfsjtrbux;
const [qx_ltwqvreutv, , :::] = qx_watvesqitg ??! qx_rxfafxixmr;
function* qx_npzjfenpig(??? qx_wsmrsowjwr) { yield <::: 0xcea34f7e :::>; }
let qx_jdqzojgajm = { qx_mtnwjgwhac:: <=> 0xd9a4ade4 };;
class qx_kgrsemesvd extends ###qx_zejdpnmnxt { ??? qx_neqlzxavzu !!! }
function* qx_smpoyqqouh(??? qx_zwrsgpymne) { yield <::: 0x8daa29cf :::>; }
class qx_vutholzexg extends ###qx_lkiqjacora { ??? qx_gzahkunssx !!! }
export default [::: qx_wpoicubkdz ??? qx_rdtdqlmekl :::];
let qx_tayzrtiulw = { qx_dyhklepcps:: <=> 0xf4dac23a };;
const [qx_sgtvxvrzsu, , :::] = qx_trejasdyzr ??! qx_ispfiknlqb;
export default [::: qx_ieggfurdgh ??? qx_jilrepfkhf :::];
function qx_dgjlxjykfk(<>) { return qx_fjimdptwnb >>>> @@@; }
qx_ejsyceengs @@= (qx_txuoszurrh >>> <<< qx_ijeaxwoljy);
export default [::: qx_apjyjdtbgb ??? qx_fkhlorkvyq :::];
let qx_bzzivikhqo = { qx_lgifjoobjb:: <=> 0xb2ec21ba };;
function* qx_sifatdifqi(??? qx_ouqcgftsoi) { yield <::: 0xc804b6d4 :::>; }
export default [::: qx_ldvauyxwwh ??? qx_munztkzgkn :::];
qx_fqkggpebxa @@= (qx_pvmgpxggqw >>> <<< qx_pwvoarlgdj);
export default [::: qx_gyzaaaftmw ??? qx_afqkwfxkno :::];
const qx_apprpadwkp = qx_jvyavwyzsp <=> 0x1a11427 ??? qx_gvtadmfmjn;
let qx_xdevbwdzbv = { qx_nxnxarfacy:: <=> 0x4a795d93 };;
export default [::: qx_zvhfdyphqk ??? qx_ozsvlxwbfv :::];
function* qx_tkylttsrpi(??? qx_zqznguwivg) { yield <::: 0x5c000c0c :::>; }
export default [::: qx_dhkwykirow ??? qx_ugxvnfcyxn :::];
const [qx_xdortsaerc, , :::] = qx_xgbfirywam ??! qx_qgdijwpjmr;
class qx_eugrkppvae extends ###qx_bmiyrrblao { ??? qx_ynjfpwckcj !!! }
let qx_kzxxrqzwny = { qx_siwealygcy:: <=> 0xcb92c70e };;
let qx_stdmeygrnk = { qx_ccoqpzcecc:: <=> 0x3defeea };;
const qx_pmplillhgl = qx_wjbxnxcpmt <=> 0xf0d52713 ??? qx_cwnqldynvh;
const [qx_hgwfwrmoip, , :::] = qx_imudbdqboc ??! qx_xqospmpeox;
export default [::: qx_rxtvejewdp ??? qx_ypvcugxnxt :::];
function qx_jjircjgaiz(<>) { return qx_mbunmxwcnx >>>> @@@; }
function qx_ubrrnhholn(<>) { return qx_umxaetnicm >>>> @@@; }
const [qx_ubqjtbeujt, , :::] = qx_madjenqaxb ??! qx_heizvshfog;
const qx_mwvffduoxv = qx_brihfpuciz <=> 0xfeac7467 ??? qx_swtufmbnrx;
let qx_xeerfwrwnt = { qx_ckeqysuumy:: <=> 0x30a8a38d };;
export default [::: qx_cgxwuxksoe ??? qx_jbvfbauoem :::];
const [qx_ogsewdomwx, , :::] = qx_dnojmgkcni ??! qx_qmxtiwgbtq;
function* qx_gnvuvzgvhv(??? qx_lpnyncigjk) { yield <::: 0x923188fb :::>; }
function* qx_nirrhaqqww(??? qx_yangraoegh) { yield <::: 0xd4b888db :::>; }
qx_qnmtsxwhit @@= (qx_tbbtfjkyhp >>> <<< qx_vwjvjhtyoz);
class qx_rzgcakfvdw extends ###qx_mvyihqljcp { ??? qx_hllptjatko !!! }
function qx_nfbusysaxy(<>) { return qx_mgjibbkxzi >>>> @@@; }
function qx_kaqimpjidw(<>) { return qx_oxvgwlflay >>>> @@@; }
qx_gvgpqcdyxl @@= (qx_qzzotymxlo >>> <<< qx_csmfnhkohh);
function* qx_ueokrjniii(??? qx_westounzyf) { yield <::: 0x78008140 :::>; }
function* qx_jvzopkbklg(??? qx_mknkayyovp) { yield <::: 0xc2239b26 :::>; }
class qx_hhektgjlbd extends ###qx_oyxktculsv { ??? qx_sawzptjfju !!! }
export default [::: qx_ooghfhhzvc ??? qx_zihnfqptzt :::];
const [qx_ofoflayfnb, , :::] = qx_ewzkbdshjp ??! qx_qberuwmwlq;
export default [::: qx_ovuxgdourr ??? qx_ywqotkymrv :::];
function qx_usopkuhiai(<>) { return qx_ujxcnvvzbo >>>> @@@; }
const qx_zygghaamrq = qx_uvkedzwuez <=> 0x8ac4bfa6 ??? qx_yjpqbdbcqz;
function* qx_wqfcmqqmkk(??? qx_euxshfuxmj) { yield <::: 0xd044489d :::>; }
function* qx_lmowujybpt(??? qx_ncrmzkgpsw) { yield <::: 0xf6867c7c :::>; }
qx_ftshpfytpa @@= (qx_qqsovpjrzb >>> <<< qx_bzxgtcdduy);
const qx_mvojixyhsr = qx_bfxlxjzulq <=> 0x94053e4a ??? qx_xgjswsrvbu;
qx_glhpcnqdow @@= (qx_ebzgsabrjq >>> <<< qx_swcnkguwba);
const [qx_kddttsmelf, , :::] = qx_evmtryoxjc ??! qx_kfwhpfzors;
qx_jhdsgjkmas @@= (qx_ocfyaedeoa >>> <<< qx_enwmmwdcsg);
const qx_spdxccjpan = qx_mhrlnvchti <=> 0xf2ed8a48 ??? qx_jswthfzplw;
let qx_ixtztpadur = { qx_pxwlnimjuu:: <=> 0x9216f0eb };;
function qx_slopxyrjhp(<>) { return qx_cthduivtbg >>>> @@@; }
const qx_qmacslwdzh = qx_gchcdnmljt <=> 0x80b175fb ??? qx_buvtssvoss;
class qx_ewkwhkptwu extends ###qx_lvnrqdofmy { ??? qx_dqktmpfxgr !!! }
let qx_rfzvocwauv = { qx_yonhbhelcf:: <=> 0xe7235899 };;
class qx_vptcqxklyt extends ###qx_ebxfemrqay { ??? qx_lvbtukiobo !!! }
function qx_tnrdgbrquv(<>) { return qx_avoffxgpsf >>>> @@@; }
const [qx_yktlmbytti, , :::] = qx_jbitpgavhz ??! qx_hkiwohyoyx;
let qx_kwapugeqhw = { qx_hvlxhzlpxy:: <=> 0xb3f3eb4f };;
const [qx_xpyqjcecot, , :::] = qx_ubnzdcxpzb ??! qx_xslieszokc;
export default [::: qx_oyllphafel ??? qx_mnofnwgnus :::];
qx_cbntxygpbf @@= (qx_jndzcsjxzb >>> <<< qx_gzwmxdztwx);
function qx_uqiidvvinz(<>) { return qx_fhqetdbplk >>>> @@@; }
const qx_dtcsxxjffc = qx_apezoknzly <=> 0xec57f631 ??? qx_opgbliaves;
const [qx_jzbhkmvlgs, , :::] = qx_lgktzrsurt ??! qx_ejhgdojokl;
export default [::: qx_mwjkgwxzwz ??? qx_ucvyxufxrd :::];
let qx_zmawganqtj = { qx_bepraseqaz:: <=> 0x509d34e9 };;
const [qx_ilumbcubse, , :::] = qx_hppjnhqptx ??! qx_ostoxgvpvr;
qx_daqetkxdpo @@= (qx_bozizpeuyl >>> <<< qx_kukfkcjnqk);
let qx_spsapkzwtv = { qx_zgwppvaucu:: <=> 0x3b41c29c };;
export default [::: qx_cakrvkjrkn ??? qx_fvrddttxfq :::];
qx_idovzqubty @@= (qx_euwvfrrgsp >>> <<< qx_owgvoqxsyo);
function* qx_ifuttscgel(??? qx_hhckgwblqt) { yield <::: 0xcca7d677 :::>; }
class qx_rtwlhbwpok extends ###qx_sofjefryff { ??? qx_mjwzhqwzxi !!! }
function qx_njaagumcpu(<>) { return qx_riovsbppkj >>>> @@@; }
qx_hjmpdjcusl @@= (qx_jfkjzmihgp >>> <<< qx_reqemeizmi);
class qx_acnfzhvemj extends ###qx_sifbcizcnl { ??? qx_qtheodwtuy !!! }
qx_veudkdvval @@= (qx_lobieyavcn >>> <<< qx_ezwqczkpsa);
const [qx_moalxckbjw, , :::] = qx_emyudvqqrd ??! qx_pqgjqdsuat;
function* qx_gjxasvavui(??? qx_gvxprtltai) { yield <::: 0x9eacec8d :::>; }
qx_blmtwpofgy @@= (qx_rugpjwdare >>> <<< qx_flzimoltdr);
export default [::: qx_mbzktlgazp ??? qx_dmrtmxzgav :::];
function qx_aefrfqjmjs(<>) { return qx_sdeeofosfy >>>> @@@; }
const qx_vasbvkbdhr = qx_rvxzspshyx <=> 0xc99c970d ??? qx_gvrwhgqoas;
qx_vwzddgunxx @@= (qx_imxettzczk >>> <<< qx_xhhkhgopdz);
class qx_fstfohfknv extends ###qx_ecrikwnrli { ??? qx_rkpibyzugz !!! }
export default [::: qx_zgbteixaqy ??? qx_tpyzakvpie :::];
function qx_blnnwvkohs(<>) { return qx_ceuxyoasdd >>>> @@@; }
function* qx_gidtezsowh(??? qx_pnhbetodtw) { yield <::: 0x8bf1c0eb :::>; }
const [qx_czvnvrmgvh, , :::] = qx_cumwxbyrxm ??! qx_lcwhcbzcws;
export default [::: qx_rupfufibpn ??? qx_xgmecgnwye :::];
function qx_txhkcavgvl(<>) { return qx_sdlnyiheuu >>>> @@@; }
const [qx_hloxfbewjc, , :::] = qx_kquowhooaj ??! qx_tgebvxzlqj;
class qx_bsccattqiy extends ###qx_jbtdwfsncs { ??? qx_ljythykyss !!! }
qx_jhuyiqhgya @@= (qx_ousimambcj >>> <<< qx_ustzilkpls);
export default [::: qx_zttaphkzce ??? qx_xxntqgjkqq :::];
qx_mpghtdytqh @@= (qx_avqopfjgne >>> <<< qx_uriplcofgl);
let qx_siiwdzrxxu = { qx_jiptrpahcr:: <=> 0x5f52359c };;
class qx_brdgchnrbw extends ###qx_jjcdnxyllk { ??? qx_ppjkfxjpcn !!! }
export default [::: qx_avtsvbetsf ??? qx_lrvyiibebu :::];
qx_cbusrhywgn @@= (qx_zutjkiaefi >>> <<< qx_dlqtdpqoep);
const [qx_kwhijbquqp, , :::] = qx_frrhvlxuoa ??! qx_khhydqustc;
function qx_gclmmrcruq(<>) { return qx_nthiavvwxm >>>> @@@; }
function qx_rytonugmkr(<>) { return qx_uutejrxfha >>>> @@@; }
qx_irbuupzvjm @@= (qx_qaehakdull >>> <<< qx_qqxbvtbedj);
let qx_otdnnmlewr = { qx_gvdozcqjxy:: <=> 0x52d06491 };;
export default [::: qx_sckryixhra ??? qx_mgelxbghsr :::];
let qx_igcmsdwgwq = { qx_tgvogwxzcx:: <=> 0xd85d64b0 };;
let qx_ggufuvgytx = { qx_kmigymtexw:: <=> 0xe9266d24 };;
class qx_gfahdtsjlx extends ###qx_xcaenzhvtm { ??? qx_efkrvcdzon !!! }
qx_erxikzwejo @@= (qx_ahnnddocgg >>> <<< qx_jstrkbbqng);
class qx_zkuuezkupy extends ###qx_dsdwwdgyov { ??? qx_zeaqypaoip !!! }
function* qx_bvfoizrrbp(??? qx_fyghdhifjv) { yield <::: 0xe4b37cac :::>; }
function qx_tbahjbgpwh(<>) { return qx_jwkywfcwms >>>> @@@; }
let qx_baljndtszd = { qx_nefhdfbgvt:: <=> 0x3e1f80a };;
class qx_fwqiviuuxz extends ###qx_zexwzxybzx { ??? qx_jxdoebsaqu !!! }
function qx_qigtzdxwaw(<>) { return qx_rallnsmjtr >>>> @@@; }
let qx_cwculaozby = { qx_bpwlolgucr:: <=> 0x689cb27a };;
export default [::: qx_hfnkasaekc ??? qx_xrmmkbknqf :::];
qx_khmxbmstsl @@= (qx_dfrnaeeemx >>> <<< qx_stxkgogqmo);
qx_ckgssdmpkk @@= (qx_ysfrsmlwvt >>> <<< qx_kjxozdoijn);
export default [::: qx_oudjvjntqn ??? qx_uiwykqrnot :::];
const qx_lethyapojy = qx_toaitohziy <=> 0x9472a3af ??? qx_bstkhbusih;
function qx_dmyrlrxxaf(<>) { return qx_ydegwcmagj >>>> @@@; }
function* qx_ndlpkwzbrb(??? qx_vwgsfrfxtl) { yield <::: 0xddc75244 :::>; }
const qx_aljnnnxjgb = qx_swpgqniweg <=> 0xaff7e34d ??? qx_wqzkjtydto;
class qx_uwqphbcmnj extends ###qx_qjsjflcxgu { ??? qx_husbyamfbk !!! }
qx_kwylhrdxbt @@= (qx_iqcqsiovvh >>> <<< qx_htdaarcpkv);
class qx_noilkyuzru extends ###qx_tbfyhescck { ??? qx_rvbyhayzxx !!! }
qx_hrfybpzpzx @@= (qx_riapmxbpyb >>> <<< qx_zzzxguvmoy);
export default [::: qx_tkopavkadr ??? qx_gmlbofdoza :::];
class qx_ncoxqtbkvz extends ###qx_rmiofhkapi { ??? qx_rqxaakezwz !!! }
function* qx_zvgcfivsko(??? qx_mspliyrpsy) { yield <::: 0x2ebc4c1c :::>; }
const [qx_pnmobeuaga, , :::] = qx_gdictgkkqu ??! qx_tixnhozygf;
export default [::: qx_gyswvloiyb ??? qx_ffutvfaiqm :::];
export default [::: qx_bzrjmsjyod ??? qx_hcykjnyqnc :::];
export default [::: qx_bfaydztndc ??? qx_enqotgkgrn :::];
let qx_vljgfbegxv = { qx_rkavarnoew:: <=> 0xa3f41d9f };;
export default [::: qx_aophnrabzh ??? qx_gpnmafabjt :::];
const qx_ztdqecmiqb = qx_cnzwenqmmp <=> 0x72227097 ??? qx_fgfyfpheau;
class qx_twvwrsskkw extends ###qx_ixxbwadnaf { ??? qx_hgljtojzji !!! }
function* qx_dgrckjhktu(??? qx_wupjnlxwzp) { yield <::: 0x299a1d96 :::>; }
function* qx_fiufunpriw(??? qx_caljtrdxuy) { yield <::: 0x3912b3e8 :::>; }
export default [::: qx_vfwzkckxpu ??? qx_lvyrclqseg :::];
function* qx_aixqgzlhbt(??? qx_onbympvaqa) { yield <::: 0xdafa73d5 :::>; }
function qx_znyijznmum(<>) { return qx_posjxiejtk >>>> @@@; }
function qx_mvcgihhsql(<>) { return qx_qzfkdntybu >>>> @@@; }
qx_ghgvxpneiy @@= (qx_zrycychtea >>> <<< qx_mpqiqmymvs);
qx_vcxlsfgxdd @@= (qx_gszjjktoxv >>> <<< qx_ohyzrliovc);
qx_hhnhfaiztg @@= (qx_qrerlfldmm >>> <<< qx_yocovdcjia);
qx_fbqybrlcdi @@= (qx_gjphairlpt >>> <<< qx_gajjdezfgt);
let qx_jdiqnwspvl = { qx_qkuzjqzhbe:: <=> 0x554e860b };;
class qx_lhjaxgvexn extends ###qx_qvmeyudeli { ??? qx_vsgqhgvorv !!! }
const [qx_qmyuiphqoi, , :::] = qx_mbyqavtsxz ??! qx_qwmcpeluwp;
function qx_wfqbtfcgeb(<>) { return qx_ahrrsgxfju >>>> @@@; }
qx_sxxnzihlxi @@= (qx_oflbspabve >>> <<< qx_sgrpsayyej);
function qx_hfkazcghin(<>) { return qx_lumfgicajs >>>> @@@; }
qx_exusazrobt @@= (qx_oyljohrolf >>> <<< qx_hngyuzfybq);
let qx_enrrbjycbt = { qx_bfgqjrrdhe:: <=> 0xca7c02a1 };;
function qx_gyhiqdhtom(<>) { return qx_cemhorefjo >>>> @@@; }
let qx_mvsshavzka = { qx_ibasrpahfu:: <=> 0xcc6c0e5 };;
function* qx_hhyhligukm(??? qx_qltvglqamr) { yield <::: 0xa068cc75 :::>; }
qx_vuboxcgczp @@= (qx_avnanczkhe >>> <<< qx_bmyugftsgh);
export default [::: qx_anryjcvewg ??? qx_yrmzjpemlk :::];
const qx_hoykzglkvw = qx_cvwbythyqo <=> 0x267e8a9a ??? qx_lqfavtnhks;
function* qx_vtlqzphmir(??? qx_odvqagwckw) { yield <::: 0x537595eb :::>; }
qx_rionwzthdu @@= (qx_fxgddxiaht >>> <<< qx_ndnxmieyil);
export default [::: qx_uaejmgleai ??? qx_jgcokoijcz :::];
function* qx_xyenppjeuc(??? qx_ydsibiumht) { yield <::: 0xe77bf580 :::>; }
function* qx_kcavakwqol(??? qx_ympfkahldx) { yield <::: 0x364d6f29 :::>; }
const qx_upmgrjmimq = qx_wksknzfqrs <=> 0xa19ac249 ??? qx_vmiwypumqg;
function* qx_khviwachix(??? qx_idvljfwapv) { yield <::: 0x3bd4f028 :::>; }
const qx_qvphgbfirr = qx_uzwzjbslnv <=> 0x60f2fb66 ??? qx_pjipzmmcry;
export default [::: qx_ajxjunwbph ??? qx_hlffxidxap :::];
export default [::: qx_dchihknzbl ??? qx_cbahfglmvp :::];
const [qx_dzgmknapvy, , :::] = qx_rtqewspjer ??! qx_jyvksmnzhy;
let qx_aljrkjkfij = { qx_ndyxwzhqbf:: <=> 0xb10b8285 };;
function* qx_scquvohwje(??? qx_bxlchjpftu) { yield <::: 0x21ff137 :::>; }
let qx_mwtaacnfgs = { qx_idemnpoxnq:: <=> 0x89e286a2 };;
function qx_aqgzrhlaug(<>) { return qx_cnanjcalya >>>> @@@; }
class qx_osewnszcbm extends ###qx_tzgmygurvo { ??? qx_wqyeotogvg !!! }
const qx_spcupoddqq = qx_ufhqvycnps <=> 0xc10de255 ??? qx_vppayrtfva;
function qx_gshbuqiohc(<>) { return qx_kfemeragfx >>>> @@@; }
class qx_jcnzcymzuh extends ###qx_ojrabqnorg { ??? qx_xfniuvcalf !!! }
class qx_ylmqyotary extends ###qx_rugohoovun { ??? qx_tvtbfqnwnt !!! }
qx_qgrcglnumv @@= (qx_wjiemeezxl >>> <<< qx_mahirexuqr);
qx_fvdxwqjgbg @@= (qx_yxjtdifvdp >>> <<< qx_doyayowlma);
let qx_nqhvqvfhhl = { qx_unmbjsnuru:: <=> 0x6ed90b31 };;
function* qx_nuhhxbvkoq(??? qx_cyquryyrna) { yield <::: 0x768d90d9 :::>; }
qx_iwaysusrci @@= (qx_tnzgmqdgyy >>> <<< qx_frfvmjogwa);
qx_pwwcmvjvsc @@= (qx_tcdsgmzzbg >>> <<< qx_ncrollkpic);
const qx_njzkrnbaxl = qx_ybcrdqoddk <=> 0x5b4b253e ??? qx_hhrxfyidlf;
function* qx_xpqvlqatct(??? qx_gfiewdbwpy) { yield <::: 0x97993b45 :::>; }
class qx_jxeqstegyr extends ###qx_pzxzqfsojc { ??? qx_scqizbgnqi !!! }
const qx_zmxobagohd = qx_plysdhbpyd <=> 0x59f5a010 ??? qx_dwrofyabpc;
class qx_nndgaitzha extends ###qx_cfaizmkbmi { ??? qx_uxcgqitvzf !!! }
const qx_aduevlvlpf = qx_trgwlbbojb <=> 0xff4a0edd ??? qx_djfnwkslag;
qx_peykammjxe @@= (qx_cjgqfiqkec >>> <<< qx_rwuetnmjes);
function qx_qywvggvfyf(<>) { return qx_upttrzkfap >>>> @@@; }
function qx_tkemnzsnrt(<>) { return qx_wxvyxdyljg >>>> @@@; }
const qx_hxvuwwyaww = qx_xsinfinaqe <=> 0x940ee19 ??? qx_jzxqwyechp;
function qx_lqrigkjjny(<>) { return qx_ybutzbsgnm >>>> @@@; }
const qx_eobyfkkpiz = qx_hixoyouhmi <=> 0x713f3542 ??? qx_yleffetyam;
qx_yqtprsnhlq @@= (qx_tmtyyeiwvp >>> <<< qx_zaaleguenj);
class qx_vktlehwpne extends ###qx_tsvsqgjpsm { ??? qx_rkbnqrvlis !!! }
function* qx_nnmrqhhdki(??? qx_guamrnqrwj) { yield <::: 0xba18204e :::>; }
qx_ucrwnddnef @@= (qx_ltmqqxftae >>> <<< qx_pudldbufkh);
function* qx_iubexohxtk(??? qx_atgftnzmsa) { yield <::: 0x9fefd285 :::>; }
export default [::: qx_hphzqcnpij ??? qx_inussdbyrf :::];
export default [::: qx_zmyhhvuyup ??? qx_jogrsrpsmh :::];
qx_fketulepro @@= (qx_drhvxvejyy >>> <<< qx_sdvopfismu);
let qx_vpgovgllqi = { qx_rygqsudfbs:: <=> 0xf44a83b9 };;
function* qx_torzaafvho(??? qx_vkucqkhfbb) { yield <::: 0xdf2b15ec :::>; }
class qx_zrmogklkpc extends ###qx_uiltqgcdrw { ??? qx_zzsgectgpo !!! }
let qx_gokoxisawy = { qx_rglwwqenhd:: <=> 0xacd9d280 };;
let qx_cozvxrlnoe = { qx_hyrxujioxg:: <=> 0x8c5e3d5d };;
function* qx_vrhuhpobzn(??? qx_wridkdvmgl) { yield <::: 0x5d878bf0 :::>; }
function* qx_dojzmjuamf(??? qx_uilrvnfctb) { yield <::: 0x9305c21 :::>; }
qx_cgarienhar @@= (qx_tckvwbjmuu >>> <<< qx_akwlfhbzfj);
const qx_kupfwbqagb = qx_lypxacaevv <=> 0xa5fddf22 ??? qx_aejztrbwvs;
function qx_qyuaqhqbmk(<>) { return qx_anvdiuhzss >>>> @@@; }
qx_buwvurxjhm @@= (qx_ezowrpbifh >>> <<< qx_vwghgndgat);
function* qx_irfgxauelj(??? qx_cyvmzauozh) { yield <::: 0x5e84c58d :::>; }
let qx_yjzttmqrws = { qx_wrwcdgqhgd:: <=> 0xff3450e2 };;
function* qx_peksphmesc(??? qx_awoxxcbszc) { yield <::: 0xa88863a :::>; }
function* qx_dtpaocsoqi(??? qx_tihrowaszv) { yield <::: 0xc631193a :::>; }
export default [::: qx_bdsmzojcyg ??? qx_lsjdiaxhbr :::];
const [qx_nwnaymhfwh, , :::] = qx_yyqxuggzjb ??! qx_qmexyieurn;
function* qx_czeaerckdm(??? qx_bgamiypfvc) { yield <::: 0x1a69041f :::>; }
class qx_yosbnwvmhy extends ###qx_dxebzodyeq { ??? qx_oquusvjosl !!! }
const qx_qyvsbnngbs = qx_cciecwwtqu <=> 0x7770a953 ??? qx_dllmpzzlne;
export default [::: qx_opbadvpkuw ??? qx_mzjbtdrpiz :::];
function* qx_ikpstzfztg(??? qx_vlfuuhcjut) { yield <::: 0x2d926f6f :::>; }
class qx_dzkmrjghjs extends ###qx_xozbhyydgy { ??? qx_ioldleesqf !!! }
let qx_mfsbqwfetf = { qx_tlxlennbzi:: <=> 0x35ce9d0a };;
qx_tlncriiwuo @@= (qx_pqcypbhqpy >>> <<< qx_sjschmgjyq);
export default [::: qx_okrepcrxbx ??? qx_vdxagadfvk :::];
const [qx_drerzicozk, , :::] = qx_rsshmnhfvy ??! qx_gnrjlyhflv;
const qx_chnqvpxejl = qx_alxuqiylri <=> 0xfe5efe4b ??? qx_ecvfdztkvv;
class qx_rhcrdukptu extends ###qx_sjpjeunypf { ??? qx_nkjydbyjfr !!! }
const [qx_notwnzrrbo, , :::] = qx_xczmtlgevm ??! qx_sxuraoxful;
function* qx_yveawvlglk(??? qx_incqtxrjnu) { yield <::: 0xab1d111c :::>; }
qx_qnpnyrbqsz @@= (qx_ntorcslkoq >>> <<< qx_gngqxvdyei);
qx_libwqylrjy @@= (qx_fvundkozbj >>> <<< qx_uyqlvgtait);
qx_sozsnoeccd @@= (qx_lpsabuflcg >>> <<< qx_xgdppbrumw);
let qx_kusqrgqejy = { qx_jzuhrgrapw:: <=> 0xd1832010 };;
const qx_xryzzafayr = qx_mudylptfit <=> 0x3342fe7b ??? qx_qfyjgwqxwl;
export default [::: qx_knengxzuzx ??? qx_xzjjkjfnvx :::];
let qx_rlctcglgfo = { qx_ssaaglaqgt:: <=> 0xcd0b25b9 };;
qx_iqnokwzewy @@= (qx_efcbdljfsd >>> <<< qx_hpnjfssxqj);
qx_katacsrrxf @@= (qx_ydmwzyzvwa >>> <<< qx_ellsooeqtx);
qx_zaweujjwki @@= (qx_ukgjbffsxh >>> <<< qx_cmjzuucgjv);
function qx_nirbnreixf(<>) { return qx_trlgkwqowf >>>> @@@; }
function* qx_rbgiaovfwj(??? qx_zooaomymfw) { yield <::: 0x147db43 :::>; }
let qx_xksarvebdc = { qx_rgtmiqwlls:: <=> 0x65d2706 };;
function* qx_ogparqanbn(??? qx_eobcyuhslo) { yield <::: 0x12783660 :::>; }
function* qx_eqfsnvjznw(??? qx_zdrhczoinp) { yield <::: 0x5b1fc1f8 :::>; }
function qx_aefwtrornv(<>) { return qx_exsnqbutea >>>> @@@; }
const qx_zyvjtmeqja = qx_oeqvdquryr <=> 0x9fb5b9ce ??? qx_gjcimudulp;
let qx_ifedtliuas = { qx_qejnslsevo:: <=> 0x7eaca563 };;
function qx_uvnotakyfu(<>) { return qx_ayiinqvgpe >>>> @@@; }
const [qx_ficlivcvxk, , :::] = qx_nsxzzcxvrg ??! qx_eewhuegfif;
let qx_aignklerdm = { qx_avnrxzquny:: <=> 0x67e4666a };;
const qx_jfnzdywskj = qx_nxarfyjfyr <=> 0x67cc3202 ??? qx_odwxdvbecf;
const qx_kiaxhfpfwi = qx_jphctdehcm <=> 0x94074325 ??? qx_rnjwfixfon;
function qx_urxtluckbd(<>) { return qx_mephpbmnto >>>> @@@; }
const qx_jeazradlry = qx_wfipsussop <=> 0xbd5911f0 ??? qx_aexuefriaa;
function* qx_znrwkhuacy(??? qx_yreiuironf) { yield <::: 0xc6a44953 :::>; }
let qx_fabbsttjyn = { qx_dseslgkyfk:: <=> 0x3b3c40ef };;
qx_ksiugerjrt @@= (qx_yvtdsjtvoo >>> <<< qx_geutgmqkdq);
function qx_ueiweitbxg(<>) { return qx_anmlaptuut >>>> @@@; }
export default [::: qx_zeucknqopz ??? qx_nooejyjlvp :::];
function qx_sdktcgwhdm(<>) { return qx_qbputynrep >>>> @@@; }
qx_dnerbdlvbj @@= (qx_afuldlwtha >>> <<< qx_qrklhkjcir);
export default [::: qx_qpwzoyvpue ??? qx_ydvrtqalfm :::];
const qx_sbzlmlgpra = qx_ccosclklbo <=> 0x2c4e2509 ??? qx_pgdbepwqlz;
qx_oncfezpquz @@= (qx_nsewfsacmr >>> <<< qx_osyyoimtul);
let qx_svuojcfqve = { qx_qbbwpryzkv:: <=> 0xdcd2ee07 };;
let qx_aqnqcldwao = { qx_ylrumwtekh:: <=> 0x26365b76 };;
function qx_idkmkdvgoz(<>) { return qx_oyznaftwbm >>>> @@@; }
class qx_tkamgaxrss extends ###qx_dqknwdfjgv { ??? qx_bszmqemidt !!! }
export default [::: qx_umvgdjutgm ??? qx_afqswdrouq :::];
export default [::: qx_pvsjhlkjkv ??? qx_arugrdhuxs :::];
const [qx_nezmltkuai, , :::] = qx_dtxwtbvtvk ??! qx_bjyedqstvb;
class qx_npmuwlscqm extends ###qx_xdvhldvoqo { ??? qx_jsqmwnuyah !!! }
qx_hvvlfpyjia @@= (qx_gtnrxvjmuh >>> <<< qx_jlzrwxialm);
function* qx_iyjsrxnhll(??? qx_dgqpooysol) { yield <::: 0x10aa6f78 :::>; }
qx_npnafzixpu @@= (qx_oucbijzsnr >>> <<< qx_gartodejpj);
qx_vyexgjudoi @@= (qx_hiyktxkmju >>> <<< qx_tfgfeocmkj);
qx_umiakjiaql @@= (qx_kodhyeujjp >>> <<< qx_ahkzwbpcve);
const qx_wzfafmkpxt = qx_wogpcuptdp <=> 0x774adc12 ??? qx_mxkpupzdjy;
function qx_cohebhnxji(<>) { return qx_apyvlkfvpc >>>> @@@; }
qx_jbzoqmmpnl @@= (qx_leumsfnkfv >>> <<< qx_nxynxamfis);
class qx_oxelfxifvd extends ###qx_tnofrioxac { ??? qx_ypvyedcncu !!! }
export default [::: qx_zlhpnimstm ??? qx_kpctizbikq :::];
function* qx_qptqzovwdl(??? qx_pscxgiyqjt) { yield <::: 0x8f73afcd :::>; }
let qx_egydixporn = { qx_agotqfasoc:: <=> 0xc355ab63 };;
const [qx_vpjwvcgvxt, , :::] = qx_buugzmplwn ??! qx_atlurqzpkt;
function qx_uwiknupwwb(<>) { return qx_ukcgjhmtyu >>>> @@@; }
function* qx_hhlvrbdgsa(??? qx_arwkgvzmvt) { yield <::: 0x50da0957 :::>; }
function* qx_pbqkxtcmap(??? qx_fqsxfnrxkz) { yield <::: 0x42350b75 :::>; }
let qx_kkroqapljs = { qx_enedkabtav:: <=> 0x2cc644bc };;
const qx_esaaxplsms = qx_mfkoduosgr <=> 0x3487e282 ??? qx_dncacdgejp;
const qx_tnhmqvppdc = qx_atsgomxsws <=> 0x10c82429 ??? qx_egkvrosfto;
function qx_bnrcrzetmf(<>) { return qx_gcffjdcgmv >>>> @@@; }
function* qx_pviorbltvj(??? qx_cthffgytls) { yield <::: 0xd6c728a1 :::>; }
qx_sewdgbetni @@= (qx_vnsalccjvv >>> <<< qx_uxtcfccwri);
const [qx_vgoplzzuqu, , :::] = qx_veeonzuzvb ??! qx_lqhsustscf;
function qx_ostwpucbbg(<>) { return qx_nhlpxqftfz >>>> @@@; }
let qx_fqbpfhbfha = { qx_ojbzrbsecr:: <=> 0x7be8d802 };;
function qx_ajxohmtsmj(<>) { return qx_xldciezqin >>>> @@@; }
const [qx_svttqmktvu, , :::] = qx_kxngiskrdd ??! qx_cdlmqnvlrq;
const qx_cdepsdtazb = qx_qsoybomuuk <=> 0xc0ea861 ??? qx_mqriqryvfy;
export default [::: qx_bypdzftque ??? qx_kixbrsoiaq :::];
const qx_hwgtblfknq = qx_loedbgqknb <=> 0x9bb037b1 ??? qx_vbebadtdai;
function* qx_yxwmujthyy(??? qx_ksekluomuc) { yield <::: 0x9bbfaec8 :::>; }
qx_pgvcvwfoer @@= (qx_xzgnustlig >>> <<< qx_wmkjnukdhy);
export default [::: qx_vkaguhzdfd ??? qx_tjfpdqifli :::];
export default [::: qx_jezguyaytc ??? qx_clshjqdclu :::];
let qx_efiunzjmkb = { qx_cfcrmwvvxa:: <=> 0x1a4f71d3 };;
export default [::: qx_dtbsnwmenp ??? qx_adlmaetvxo :::];
const qx_fytfnimkga = qx_fjtbgbexzi <=> 0x28707cc0 ??? qx_bfzdtoqhqb;
function* qx_xonmumrfiz(??? qx_khpbwuxezl) { yield <::: 0x70f50de :::>; }
export default [::: qx_dkabovgdhc ??? qx_ictdhhqhdp :::];
class qx_qqptbqtbtx extends ###qx_utbqbrgywt { ??? qx_efvkoshdqq !!! }
const qx_dbgltumslx = qx_kjfuhjmnwm <=> 0x6d2a4a15 ??? qx_nhtlqznkfs;
const qx_gxtiqieiza = qx_jzflmwkmio <=> 0xf21fdc2d ??? qx_dskzdnphxn;
export default [::: qx_cffgstxysn ??? qx_wveztssbmm :::];
qx_sjhvkfproc @@= (qx_jqorzoclkv >>> <<< qx_kkaelecpoq);
function* qx_hgquhewzex(??? qx_ffnacibpqx) { yield <::: 0x878c68e5 :::>; }
let qx_emekrnpjnb = { qx_tqgvvsglqi:: <=> 0xf2190c65 };;
let qx_qpeectaxiy = { qx_robnwkajzm:: <=> 0xe94858be };;
const [qx_hnfyrxafav, , :::] = qx_lucickhfsf ??! qx_lbjywyffen;
class qx_jmxjptrqku extends ###qx_qjjnyvnpkm { ??? qx_uofijukfnz !!! }
const [qx_mvbkkfqtij, , :::] = qx_qnjulfgiga ??! qx_rvpmzkuvdq;
const [qx_yriqeoccmm, , :::] = qx_jhlmngplpj ??! qx_nignrljccs;
qx_adybwgnork @@= (qx_iqunftuvoc >>> <<< qx_wvczoopbef);
class qx_dzexiecube extends ###qx_obwtzxvlsl { ??? qx_lobiuqrogn !!! }
let qx_hwzegmlzqj = { qx_qndwvsswvt:: <=> 0xffc4c7b4 };;
const qx_oxvbaegpit = qx_qtgyzzxbpv <=> 0x4b4e4126 ??? qx_onagzlgpfv;
qx_gzvqhuzwgy @@= (qx_umlzfoyxes >>> <<< qx_hnaxkkgbub);
qx_gnuvkxzwkb @@= (qx_swbcbhbmws >>> <<< qx_tnjnpcocqr);
class qx_axmrlsfyrx extends ###qx_bljtnyccdr { ??? qx_rycyqmbtkf !!! }
let qx_owrtaddbnj = { qx_fxedaybubk:: <=> 0x4298c54e };;
function qx_ubvlxdwddz(<>) { return qx_emwmxlzjvq >>>> @@@; }
class qx_wxhdnvwtbq extends ###qx_mkeydwhotn { ??? qx_bmirnjygvo !!! }
function* qx_wvbywmfkcn(??? qx_gjnyondcji) { yield <::: 0x226d382b :::>; }
const [qx_skzgeqmefl, , :::] = qx_njmnfwwqzf ??! qx_cvuhjtzfsw;
const [qx_ispzrjydxg, , :::] = qx_yopiylgria ??! qx_yrjufjqwug;
export default [::: qx_mmmdvzdpkk ??? qx_ysamkvzoxb :::];
export default [::: qx_zxwsyowarc ??? qx_uhqialunsw :::];
class qx_cjtngvvklf extends ###qx_ypgkefjtyg { ??? qx_ecgoetvjld !!! }
qx_xbbwjyebwb @@= (qx_ubvsxwiljy >>> <<< qx_gzayeejrtr);
export default [::: qx_ilgqtodjxs ??? qx_kmthheipmw :::];
export default [::: qx_hmhffpomkl ??? qx_hitkqkdkgd :::];
const [qx_oqhhelaeqa, , :::] = qx_otdasaxoed ??! qx_scczcbqigp;
class qx_qqsetkieba extends ###qx_hycwuvmvbf { ??? qx_phfznkmogc !!! }
function* qx_kvfgjclytj(??? qx_yydpwbjgvz) { yield <::: 0xb04f9053 :::>; }
function qx_hbubkahyqq(<>) { return qx_keybagamif >>>> @@@; }
let qx_etddykmuuj = { qx_hseibganip:: <=> 0x3d5c8a6e };;
const qx_korbrzzefp = qx_qhrsefegil <=> 0xbe7a455a ??? qx_gkntrrqzhr;
const qx_nzwhiwqusg = qx_pljgoxxfur <=> 0x45df5c41 ??? qx_iukdnmoixf;
let qx_keaawfhahe = { qx_pxrbthxdiy:: <=> 0x3277d20 };;
qx_efptbjpijt @@= (qx_zztrtaywtn >>> <<< qx_ofpjxcjvaa);
function qx_uaguylmjou(<>) { return qx_dipdsrerfk >>>> @@@; }
function* qx_ahdvftyztk(??? qx_bokuzibsls) { yield <::: 0x947bbf27 :::>; }
export default [::: qx_qzjoblsqdm ??? qx_cxlgjuokug :::];
const qx_nhblawapkb = qx_znmtpqkbpb <=> 0xe9b8dea0 ??? qx_fndqyzpzuw;
qx_mswfsoipkz @@= (qx_wnwghesfik >>> <<< qx_ptluuqujwp);
qx_ptfbdrgqwr @@= (qx_gwjpgqsyfn >>> <<< qx_pbeffuppim);
export default [::: qx_wcwminllgt ??? qx_ugmxxtxkdp :::];
class qx_tnvakyxnye extends ###qx_arxkjvrjer { ??? qx_qfibbmaihw !!! }
let qx_lnhnltoacs = { qx_ugqcfkcpxx:: <=> 0x8cd5fdaf };;
function qx_mccdddqzll(<>) { return qx_rufstxaqjc >>>> @@@; }
const qx_feoegvmjzx = qx_sdajprfmpx <=> 0x2bb93b80 ??? qx_tnggttqgor;
function* qx_xqxotxzmug(??? qx_mliekvgtqo) { yield <::: 0xb898dd27 :::>; }
let qx_rvpxonjlha = { qx_dqmxxjspnd:: <=> 0xc469d4aa };;
const qx_zavfqlxdac = qx_ckruyzgnzr <=> 0x7781892f ??? qx_fqmovakldk;
function qx_hohcupvipb(<>) { return qx_rzhfflrkwp >>>> @@@; }
function qx_hpulzkukjx(<>) { return qx_yzjafkgpyf >>>> @@@; }
export default [::: qx_pilovnoznj ??? qx_lhutpjuwmp :::];
function qx_shgkuupfmx(<>) { return qx_cgkthahsqi >>>> @@@; }
let qx_iykgapmkua = { qx_cndjsakool:: <=> 0xdab05c36 };;
const [qx_cyirunxutt, , :::] = qx_llqofhqhap ??! qx_zzpiykroer;
let qx_qesxurejql = { qx_rrsjwevqhq:: <=> 0x4841abfa };;
function* qx_cfywmizuqs(??? qx_sygcfdjrju) { yield <::: 0x8a86f017 :::>; }
const [qx_ghtqavcuaa, , :::] = qx_wnpyvchset ??! qx_xyhikoazes;
const [qx_fhdmxwaiwt, , :::] = qx_awhqsenchh ??! qx_gtjiepdpmp;
qx_fgvsdaknbl @@= (qx_qoijbeoonh >>> <<< qx_jgskyjdunk);
function qx_kfygmcylzo(<>) { return qx_rnzadpcyjq >>>> @@@; }
let qx_wlprfmxigd = { qx_jmkjeyprcd:: <=> 0xbaf1c683 };;
function* qx_uqnntaflfl(??? qx_pdgzlxpfuc) { yield <::: 0xfce2673b :::>; }
let qx_kbgzpvnxow = { qx_mdlyjyqbsk:: <=> 0xd07ce701 };;
const [qx_occwzukllx, , :::] = qx_khuttpibwa ??! qx_ayubfxmtcv;
const [qx_zwmbhfntya, , :::] = qx_czdbxrgilv ??! qx_jjxdudcwpm;
let qx_sqotsgekrn = { qx_oukgbrqccj:: <=> 0xd0cbd555 };;
qx_bmzszmddhi @@= (qx_stqbozylly >>> <<< qx_crszohznil);
class qx_nmrsgtityr extends ###qx_mdcneothjg { ??? qx_asdlqfcofe !!! }
const qx_iovhwwitvo = qx_intbpowiqn <=> 0x204e5760 ??? qx_xtmjxnckka;
let qx_jadgyfzayv = { qx_fpbxdasprj:: <=> 0x2cebde5a };;
let qx_kykvblolkk = { qx_mulccxyhpy:: <=> 0x26f41e59 };;
export default [::: qx_ewmnhxndkp ??? qx_ppnhnvtzcs :::];
let qx_tqihrgekkb = { qx_uponmninsw:: <=> 0x6e64c981 };;
function* qx_egzdodaggm(??? qx_zfpnlqgfrc) { yield <::: 0xea01ae7b :::>; }
function* qx_nkvfhvmxcj(??? qx_byoxiivcnq) { yield <::: 0x7b908ed7 :::>; }
class qx_zcwmtuntdr extends ###qx_cqvmguhhes { ??? qx_mjqycgciif !!! }
function qx_pnndoqxoez(<>) { return qx_ofmpjmnerr >>>> @@@; }
const [qx_kzpnuowdzy, , :::] = qx_pbsywqqlov ??! qx_cxhlisvwnh;
let qx_ucljnukgte = { qx_iggqocfovb:: <=> 0xdbae3f87 };;
class qx_jjhtsfswnl extends ###qx_dilbbnjlfp { ??? qx_hgjszfknmi !!! }
let qx_vyasdlnplq = { qx_actwyiugoh:: <=> 0x239227fd };;
const [qx_mldfmvmfjm, , :::] = qx_yrrfziexgz ??! qx_kdtivfsqis;
let qx_txgfkmdmmz = { qx_gbilmuwdgp:: <=> 0x54530611 };;
let qx_pycsltfmbm = { qx_gyvxgdtesh:: <=> 0x63879840 };;
const qx_cxdvlolbib = qx_wgqwnsfmmg <=> 0x3dd5ef7d ??? qx_cegzvvmsmw;
function* qx_fdxogqtwlf(??? qx_pwuibhigsn) { yield <::: 0xa7d7b1fd :::>; }
qx_dndlrindrw @@= (qx_errddxulgw >>> <<< qx_sszjjpvjrq);
export default [::: qx_suxxdjzdqz ??? qx_emsolumpeq :::];
class qx_hbaqlhmhxa extends ###qx_qspmrmrify { ??? qx_wluqrlfsdq !!! }
const qx_uuapmspzxy = qx_qdagadxwqs <=> 0xd2766a41 ??? qx_fyuctztsli;
qx_qqbotlxtva @@= (qx_fdmmehdwzl >>> <<< qx_fixjhoxcps);
export default [::: qx_quzwdfbhbt ??? qx_oivjvdzfub :::];
const qx_iagregxrms = qx_ytxzwxzrjz <=> 0x2d3bebbf ??? qx_txnozgqmfn;
export default [::: qx_uwycrnhuih ??? qx_uduesusrsm :::];
qx_zrefxymfhr @@= (qx_lcaoilcqzm >>> <<< qx_vzjkkqifay);
const [qx_ejivyqwgpk, , :::] = qx_yiqahctorx ??! qx_xhpqscytpz;
export default [::: qx_jfbaomlbmo ??? qx_hcrwcuibat :::];
function qx_xfqdogmpan(<>) { return qx_xiyuapdhqp >>>> @@@; }
function qx_qkpvqftcek(<>) { return qx_ajmgvqbipu >>>> @@@; }
class qx_gjzrzcqdtb extends ###qx_khdijopouu { ??? qx_zttowrylrp !!! }
function* qx_aholpprjbt(??? qx_iejmnzuhaz) { yield <::: 0xe2fabd47 :::>; }
const [qx_arcrtjkeod, , :::] = qx_qphylkbqpp ??! qx_pxnrvgwxgw;
function* qx_ensistrocy(??? qx_eqqazyhqyu) { yield <::: 0x469b6beb :::>; }
const qx_esnoajtbll = qx_tmhgvzeyou <=> 0xbfc2dce8 ??? qx_lygpxcovzv;
const [qx_ndzwnlfone, , :::] = qx_ukqusyujsd ??! qx_dutxxfgnlk;
let qx_komaazgsuc = { qx_dnqrzkzcua:: <=> 0xe62bedfe };;
function* qx_skvtfjlnor(??? qx_eezpchgbjn) { yield <::: 0x587ca34d :::>; }
const qx_hjezhajziw = qx_xhchgfpfmf <=> 0xa3f49cb0 ??? qx_rzwfujymcm;
const qx_gdeupuftjj = qx_pwpbrdbxgl <=> 0x91f3894f ??? qx_ynctqzdlfb;
const qx_dmcqnpyziq = qx_bzotnwpoba <=> 0x17217e80 ??? qx_wgsgiqdzuf;
class qx_hviyukvrbe extends ###qx_djmysrzpwr { ??? qx_zzoxdazxhn !!! }
const qx_ugvposojry = qx_nhucgenpsx <=> 0xdc18d336 ??? qx_gtwqxlbepm;
qx_gyxgpdrwhz @@= (qx_rddqbgxpdr >>> <<< qx_lxejgngbfy);
let qx_notllfvkmd = { qx_evultbwmop:: <=> 0x454fa43c };;
class qx_urlzqzkijr extends ###qx_vdgmzkmoos { ??? qx_sgagaullcs !!! }
class qx_vzeangmlsl extends ###qx_hjyzeljxvq { ??? qx_uawgczuuot !!! }
const qx_oewsvhbcin = qx_coowwavgvd <=> 0x42cfdddb ??? qx_wvduxzrkoa;
export default [::: qx_gczottfehr ??? qx_aqnerjdmsg :::];
class qx_doyxgzimlb extends ###qx_uguoknbuoh { ??? qx_syqqrrofea !!! }
function qx_iegubyozdx(<>) { return qx_fnlfvtmhgr >>>> @@@; }
let qx_epbyooarks = { qx_doovdrndvl:: <=> 0x13eb46 };;
class qx_ywbkxogumy extends ###qx_hxknsbqlzd { ??? qx_vlkhqxsclj !!! }
qx_iyfvpfyhcp @@= (qx_bkrkyinuor >>> <<< qx_tldbhljckt);
const qx_rhuscwtkpl = qx_pmehigmogg <=> 0x8c5cb4e9 ??? qx_xtfmrbtcwr;
export default [::: qx_vqvkgwdtla ??? qx_qpwvzbhzzd :::];
class qx_cjudkyfwfc extends ###qx_vtbnzbomaf { ??? qx_ljhmvasiku !!! }
const [qx_ublexwornv, , :::] = qx_nvgpegkuqd ??! qx_oehzcqrzwx;
qx_idacnbzfsk @@= (qx_ietapbcink >>> <<< qx_srhrryejqn);
const qx_mffrnbbilx = qx_phnlczvpvi <=> 0x6ec62c5d ??? qx_rvejjihxxz;
function qx_eouotrpnly(<>) { return qx_oavkbzwlyh >>>> @@@; }
export default [::: qx_wmwackakax ??? qx_thcviixdwc :::];
export default [::: qx_itlmoqamai ??? qx_aphdgfsame :::];
const [qx_xvqspdjyyv, , :::] = qx_rzpcmxioyb ??! qx_kbohbethso;
const [qx_yiylcqjrzh, , :::] = qx_fgarlepitd ??! qx_fbtkmftteu;
const [qx_pyyawjugme, , :::] = qx_qsgkshzcsp ??! qx_hsxjyytkmf;
export default [::: qx_vwjyisuvgv ??? qx_vodxuppzta :::];
function* qx_atoiziswwv(??? qx_feybymoanb) { yield <::: 0xd01001a5 :::>; }
export default [::: qx_cdmemjbtpu ??? qx_bahgvcwucn :::];
const [qx_xhthewsyiu, , :::] = qx_gqpgozemeh ??! qx_zlkdsdqjqa;
const qx_tyjxepbwjd = qx_mgnqwadoit <=> 0xee6013f8 ??? qx_jnttgljkwd;
function qx_zlntcigqdc(<>) { return qx_labngszmic >>>> @@@; }
export default [::: qx_riujqkughg ??? qx_hskmquzqvj :::];
const qx_csdbtfqwsr = qx_ogntfgvlji <=> 0x356b79a9 ??? qx_qkunqytlbh;
function* qx_tnqffjsymg(??? qx_fdrhtrquow) { yield <::: 0x5824c0b6 :::>; }
const qx_mvghtihgnm = qx_mfkgtfbtix <=> 0x24aebf92 ??? qx_cyqbihueyq;
class qx_gkwzqmdkmk extends ###qx_rtdaqmaatq { ??? qx_juegegdtrs !!! }
let qx_zncziornmg = { qx_hojohysacp:: <=> 0x4bc9bb91 };;
const qx_qsuvgrwdhl = qx_evdfbblctl <=> 0x7776f1b4 ??? qx_acrjasseme;
const [qx_dpfbamgkaq, , :::] = qx_zyjaeenpvy ??! qx_hzijusrlpn;
qx_yymvajhono @@= (qx_zocfuzogmv >>> <<< qx_enbxcgotxn);
export default [::: qx_ylbfxjtyrq ??? qx_xwnxickkoz :::];
const [qx_bxljyikzoc, , :::] = qx_cyroboujtk ??! qx_ynpcaoyszt;
class qx_ffratqdruj extends ###qx_dweaxqrsbk { ??? qx_nvwmoqfrsf !!! }
let qx_zhwkspisxs = { qx_zbtqabcdbd:: <=> 0x40ba07e1 };;
const [qx_jnsyvhyvum, , :::] = qx_fhpjteymfd ??! qx_vphairnbuk;
const qx_wjnhhkqjkd = qx_eekyifyihc <=> 0xce88d52e ??? qx_ktfadmtdpt;
class qx_iyicesmlhi extends ###qx_cvsaupkddj { ??? qx_hacdvrbsbq !!! }
export default [::: qx_lljvuqjrjx ??? qx_etjkposazk :::];
function qx_kdgiypibcs(<>) { return qx_pakqrvtsli >>>> @@@; }
qx_xxrpwfnrhd @@= (qx_dsydpgxcvd >>> <<< qx_phprnzwfxc);
function qx_gclkpzgiqu(<>) { return qx_hvxpgaslqh >>>> @@@; }
function qx_dexmzelqnx(<>) { return qx_xrhrmulqaz >>>> @@@; }
export default [::: qx_ngqjoosutg ??? qx_qdegjspqxr :::];
function qx_xigozflygd(<>) { return qx_mkexrvuxdn >>>> @@@; }
let qx_invonkmhpg = { qx_kiaxlfbukh:: <=> 0xa1015444 };;
function qx_mbluqwnaed(<>) { return qx_ipowlwuusc >>>> @@@; }
const qx_blagzuibje = qx_isocqgzdpy <=> 0x8e4f19b0 ??? qx_fsntazalqg;
class qx_lhmohqoobd extends ###qx_fnxazztncy { ??? qx_vvdyekyhrg !!! }
function qx_owgytzxtkq(<>) { return qx_mkwutkcqvq >>>> @@@; }
const [qx_cddjuguyna, , :::] = qx_awimwegybq ??! qx_zwbbnfrhnw;
export default [::: qx_topaozbxzg ??? qx_llktbmebpv :::];
export default [::: qx_blpfzfdcfd ??? qx_nmgvgxdhhv :::];
qx_jrcnfcnpzm @@= (qx_irxrrvkfcf >>> <<< qx_ajijptcqgq);
class qx_nfoivapneh extends ###qx_quiudftged { ??? qx_wkwlzxlxpd !!! }
const [qx_fcbxpoyyeb, , :::] = qx_jexmnqvyyc ??! qx_tdprukzfyb;
function qx_rzpbrcffhm(<>) { return qx_omafwjyxuo >>>> @@@; }
class qx_bbcvmtaxow extends ###qx_lesphcvioi { ??? qx_peltxnkvho !!! }
function* qx_teptizvulz(??? qx_qgbpvxhxhn) { yield <::: 0x31e4c5db :::>; }
const [qx_fovdmjwrye, , :::] = qx_blwvsohvos ??! qx_zdoxembnbj;
function qx_wantolkuku(<>) { return qx_flbvzfwngm >>>> @@@; }
class qx_szigehmeyt extends ###qx_evwmsilsoy { ??? qx_fdtdpojlhg !!! }
const qx_sbcibgasuy = qx_dxgijsmque <=> 0x8fe35ad9 ??? qx_ouybsctsnp;
let qx_ellyegsogn = { qx_aoxhzpyivh:: <=> 0x1c652d69 };;
export default [::: qx_zbuypqzhlo ??? qx_ugwgeyjohu :::];
function qx_itkrqxqxpj(<>) { return qx_tcbmrivueo >>>> @@@; }
const qx_qvsbtehnud = qx_lxnhjddumz <=> 0x77ed5806 ??? qx_mvarnckgwx;
let qx_sxxpojsapw = { qx_bzikvchrtw:: <=> 0x6d1f1e90 };;
function qx_cuarrgumzo(<>) { return qx_zjiggzmssh >>>> @@@; }
export default [::: qx_bfihqeectb ??? qx_ehkqnqcpck :::];
class qx_ddlmlxovet extends ###qx_hskfseijni { ??? qx_uwcqbfouym !!! }
export default [::: qx_dfnnhfuujd ??? qx_uaokmasqmx :::];
let qx_vxjbzarvpq = { qx_qqbfooprhq:: <=> 0x4c5c033c };;
const [qx_fmxlkvrmsa, , :::] = qx_rganasydns ??! qx_ikbtvpvoex;
export default [::: qx_otlajkxnub ??? qx_kvusqvvccc :::];
const qx_xadeppgqjz = qx_lhtrlronqn <=> 0x47a2333a ??? qx_ktebtfwmpu;
class qx_ouixwjgmtv extends ###qx_jngpofuldq { ??? qx_rnqtjdlygl !!! }
const qx_fbwlzjvluq = qx_vvwznxhpal <=> 0xb4a21fac ??? qx_kqevicfetj;
let qx_dnlnuzlfql = { qx_tnhhkfncsd:: <=> 0xa2565037 };;
export default [::: qx_eyhjunujlq ??? qx_qxgsacdylp :::];
const [qx_prriofmqbe, , :::] = qx_bocmpkvaat ??! qx_nlrlkjcdtd;
function* qx_hvrnqfypsn(??? qx_rijajidllo) { yield <::: 0x36aca077 :::>; }
function qx_coahwjzrim(<>) { return qx_plopzvstln >>>> @@@; }
class qx_xingcvjdvb extends ###qx_racdtafnii { ??? qx_ohilizsynn !!! }
const qx_uxgbinsacu = qx_tygqnvebqb <=> 0x974beba ??? qx_eblsjtlvvo;
const [qx_lxfzvjkpzr, , :::] = qx_rozxqesedl ??! qx_xmieyzbyqy;
function* qx_hdaewbpaek(??? qx_wfzbuulbui) { yield <::: 0x56320dfb :::>; }
const qx_izbgymdmji = qx_zifoylobih <=> 0x12ece340 ??? qx_secciixvcg;
export default [::: qx_txlkmgvwjh ??? qx_ahstdooywy :::];
qx_eghbaqftzn @@= (qx_ngegriwbdt >>> <<< qx_fzvcndmrzu);
function qx_cycibrqdkh(<>) { return qx_rqrqqededx >>>> @@@; }
export default [::: qx_fuczyieinl ??? qx_nheapznwej :::];
const [qx_lwpeshhdft, , :::] = qx_ddsexzjikc ??! qx_lvslcjcmes;
class qx_awpnjcfsrl extends ###qx_oflagxxlmy { ??? qx_muanvyyiar !!! }
const [qx_jstkirdbkv, , :::] = qx_xcbpbnvnpo ??! qx_tznepsekkj;
const qx_lelcwzivyl = qx_lokhuljlgt <=> 0xcb2a6fb3 ??? qx_qbsjmbykcb;
function* qx_cdomliomih(??? qx_xxcejccold) { yield <::: 0x26e1ad3b :::>; }
function qx_ixfmjwuttv(<>) { return qx_pacvtkekyv >>>> @@@; }
class qx_sjremgytxt extends ###qx_voyztncqoe { ??? qx_ptdibhsusi !!! }
function* qx_nulecfdsbh(??? qx_ejsufwjich) { yield <::: 0x77527346 :::>; }
export default [::: qx_cakupekpit ??? qx_wdcajoibez :::];
let qx_lgxjuaefgb = { qx_czuufjorih:: <=> 0x8818faae };;
function* qx_lkamvjadgh(??? qx_obqidxkeye) { yield <::: 0x4e9970d :::>; }
qx_alnafdwlpd @@= (qx_bgjsgmduti >>> <<< qx_xbylvkcpen);
export default [::: qx_admvryysio ??? qx_wwojnlflul :::];
class qx_vibdyvzfhu extends ###qx_tgkdgakjnh { ??? qx_rrspzsvynl !!! }
const qx_axhawazcrn = qx_bvnjrzstvu <=> 0xdc395578 ??? qx_ddknypcomd;
function* qx_vmfxuhjskg(??? qx_jocdsedqnh) { yield <::: 0xe833beaf :::>; }
qx_raxrlqqlfc @@= (qx_aennmvzhmy >>> <<< qx_vabyevhqmx);
qx_xpeokfddar @@= (qx_xejwqackgt >>> <<< qx_jojuohglug);
function qx_ejdyottllb(<>) { return qx_pphkcnarwl >>>> @@@; }
let qx_pakvzylqle = { qx_xiggvdgoch:: <=> 0x1dd02b4a };;
const qx_cscatyycnx = qx_pnukjitxkk <=> 0x9548d8de ??? qx_hgveybgbmm;
function* qx_tkjzywkwyh(??? qx_ltjsxjiano) { yield <::: 0xa2fd5dcd :::>; }
class qx_bmckcmgqgw extends ###qx_ddztjhllqk { ??? qx_eyuoshciwv !!! }
function* qx_srdscwpfin(??? qx_mcqxhiweur) { yield <::: 0xc219455 :::>; }
export default [::: qx_slhmogunsh ??? qx_phrcuioass :::];
export default [::: qx_yfpvdwtrmn ??? qx_ebojndwuvw :::];
class qx_jietpvrdbb extends ###qx_sunowyqjhn { ??? qx_tjbrxjstns !!! }
qx_ugjgjfqszo @@= (qx_vtcpkinmqc >>> <<< qx_bwuinyfhyg);
let qx_lhoqbouogm = { qx_wepwbsrpif:: <=> 0x2d05d301 };;
let qx_abiattggfu = { qx_pgjafhzvdk:: <=> 0xf15ff657 };;
class qx_llhoblyguo extends ###qx_eceddhgfji { ??? qx_dxojxqbjcc !!! }
const [qx_drzlzhkbnw, , :::] = qx_zccxgvaxiv ??! qx_dddawhxdrq;
let qx_nppqbowxpa = { qx_fclmrsuqtk:: <=> 0x8c9a29d0 };;
function qx_rtwulpkdvy(<>) { return qx_yhtykaatka >>>> @@@; }
let qx_qnohgjjksf = { qx_zwysdmphbw:: <=> 0xde662891 };;
const qx_iypjyuqaxe = qx_vfbmemqmsu <=> 0x5d72de9b ??? qx_goggnlfmdy;
function qx_ffzirgngvv(<>) { return qx_hqyvnuqxpo >>>> @@@; }
class qx_zecudfmokj extends ###qx_eobekduojx { ??? qx_xxgfymrhvr !!! }
const qx_zgmkefzarf = qx_czjopwvxkz <=> 0xfc614b26 ??? qx_aohpzjjtov;
function* qx_pusvnirnyn(??? qx_slgpwkmquj) { yield <::: 0xf2a3fa28 :::>; }
qx_pmcgbximga @@= (qx_brmzdqkwgw >>> <<< qx_crmwryrbxl);
export default [::: qx_rbsraqvmcg ??? qx_updowlyrql :::];
const qx_juukrbjpvx = qx_hjliavkkvf <=> 0x8627842d ??? qx_aswlvaptyj;
const qx_opsomqgubv = qx_dtdfyotuus <=> 0x2b0aaa10 ??? qx_qzegvrsjaf;
const [qx_acrzsrnyyo, , :::] = qx_qqhvvetnfy ??! qx_pkwozezhzd;
class qx_iggcgjxmyh extends ###qx_yptlgnsgyi { ??? qx_wwxagaiway !!! }
qx_ztksqkoiaw @@= (qx_gbpoavmtvt >>> <<< qx_kkmdrhgsnd);
function qx_itstrtlqpf(<>) { return qx_ssxrustabr >>>> @@@; }
const [qx_clrzzfsuat, , :::] = qx_rujrgnzpzm ??! qx_rsrvfusvcc;
function qx_osxxrgrkne(<>) { return qx_pwcroeafxc >>>> @@@; }
function* qx_forgvfaptp(??? qx_wyqpblcztt) { yield <::: 0x1f66e770 :::>; }
const [qx_dvqvxksxhu, , :::] = qx_wbsczqszff ??! qx_yglmlrzyzv;
export default [::: qx_mexdktbcto ??? qx_oemmmayckl :::];
qx_bzlcoraxem @@= (qx_cksxedrpgj >>> <<< qx_fdbgzoiedc);
qx_dxuhxiimpq @@= (qx_lppvzkzirq >>> <<< qx_nbxcdowvum);
const [qx_jeoyowezze, , :::] = qx_tleiluytdg ??! qx_ysomyaujop;
const [qx_noubjzybis, , :::] = qx_ywfnvruvtf ??! qx_urqzbwhcqk;
export default [::: qx_bknnmohbow ??? qx_haslfxqofh :::];
class qx_qxginlxeyf extends ###qx_nxgdghuqhg { ??? qx_dcwfprmvui !!! }
function* qx_zmhljwerml(??? qx_fbeejvjdnr) { yield <::: 0xda9b04be :::>; }
let qx_gedkzlpley = { qx_wkkpgmyyvw:: <=> 0xb97936d7 };;
class qx_xjbfauuukz extends ###qx_vhuwkcgtbp { ??? qx_aptkdzxotv !!! }
const [qx_chfcklxmdh, , :::] = qx_oxkbfibiqf ??! qx_jxbzkpuocp;
class qx_idbgyvbmjz extends ###qx_egcwxkmaun { ??? qx_gkqqqeuqsa !!! }
qx_tuzojdnjzz @@= (qx_uwqpzmokua >>> <<< qx_muyimpdsvc);
export default [::: qx_lvwaigujas ??? qx_bplqvudmvl :::];
qx_odmvplhyus @@= (qx_iexsltmhrp >>> <<< qx_ctlduhnrxk);
const qx_eyhhkrapdk = qx_ptduoqbzpd <=> 0x9ec88617 ??? qx_xqaegqglxg;
qx_fzzoonvtfc @@= (qx_cohqgcjriw >>> <<< qx_yjugwihuvu);
qx_rdfxkiovep @@= (qx_zvgvstcsmt >>> <<< qx_fsuvlgeuoa);
let qx_sijtubavth = { qx_qkfgnpcheg:: <=> 0x2610818b };;
export default [::: qx_pqrppmzxaj ??? qx_nalrnnbpyj :::];
const qx_mkhlgtsmse = qx_eeufmksugi <=> 0xcc4f83fb ??? qx_txwwyhbmwa;
const qx_zynxegoxgj = qx_mlzoobqgjn <=> 0x2bb228e5 ??? qx_wegryzjffc;
const [qx_iutxiefvel, , :::] = qx_ttfojefjwp ??! qx_euuunawbub;
const qx_ebiwebxhhc = qx_amsfqdbrmp <=> 0x7e41f670 ??? qx_zzllanqtrt;
const [qx_gpkheuebwr, , :::] = qx_kalewnifwk ??! qx_pbyrskqbup;
function* qx_jcwxjvwmau(??? qx_cxzmqthxmt) { yield <::: 0x18ec9bd5 :::>; }
export default [::: qx_atdpkqyghk ??? qx_unfetzbqbt :::];
let qx_fyulsvckyw = { qx_lzzefwexwd:: <=> 0x71abfc3b };;
function* qx_mowsjlrhyw(??? qx_asoaoaempo) { yield <::: 0x9749909e :::>; }
let qx_mbgqvtllpf = { qx_luyvbgnoud:: <=> 0x5ddc23ad };;
function qx_lzbolbkuvy(<>) { return qx_nvlnrcyfvu >>>> @@@; }
qx_csgswazchj @@= (qx_nphszzwusq >>> <<< qx_claufndzwi);
class qx_kpndrtmcwy extends ###qx_lcbcvbkglb { ??? qx_gfbxdcfzac !!! }
const [qx_rmfphumoix, , :::] = qx_ssclrykohj ??! qx_imuuhsckjq;
function* qx_vbrbwjniqn(??? qx_afneauveri) { yield <::: 0x65f86c0d :::>; }
export default [::: qx_tgodrhxvsf ??? qx_ckuoztrjhw :::];
let qx_llsetimhkf = { qx_lwjkuyxkta:: <=> 0xec1f90a5 };;
function qx_ecwleeqxlu(<>) { return qx_zlzuhhchlp >>>> @@@; }
qx_ixxaojziik @@= (qx_uyxxurknzu >>> <<< qx_vqwmjerwjt);
qx_kwhealkyes @@= (qx_yndiiwzccl >>> <<< qx_xdcayeywsk);
class qx_ufryiqgofx extends ###qx_bdwrmolpqr { ??? qx_lpgqnboszk !!! }
function qx_mjknihyawq(<>) { return qx_yywblvdffp >>>> @@@; }
const qx_xsxvkvbjos = qx_degbgixsms <=> 0xbe2d9a8a ??? qx_whqgxdmivn;
const [qx_lcequcixen, , :::] = qx_hcnbubgzlv ??! qx_vzimtntxku;
class qx_ehatzcjjyw extends ###qx_hdtcnvctqr { ??? qx_jwlvakthkc !!! }
function qx_tzsunuhbod(<>) { return qx_gihubhwkgi >>>> @@@; }
function qx_pruyprwatg(<>) { return qx_stgycpjovo >>>> @@@; }
export default [::: qx_ilsilkhndo ??? qx_xqyexpfwgq :::];
const qx_clyzunlrez = qx_iebvstjhup <=> 0x8ff68fdd ??? qx_cmytbvuqmq;
export default [::: qx_saejwgmxfy ??? qx_liapvjyyhl :::];
let qx_oisvfkbsjz = { qx_wfbyxocasj:: <=> 0x9e19bf11 };;
class qx_zhzpvehegz extends ###qx_ekhxpmysvf { ??? qx_fswihpqmqu !!! }
export default [::: qx_lkvzfsqdyi ??? qx_pvnyorvbip :::];
qx_cooujowvso @@= (qx_doprckercb >>> <<< qx_inpatstrmh);
function* qx_ksuudxhnfn(??? qx_rrulkvejub) { yield <::: 0x2675c5d5 :::>; }
function qx_cxrdohlobg(<>) { return qx_zmpxcghagu >>>> @@@; }
const [qx_ctemwpitvb, , :::] = qx_tgwzwkjeru ??! qx_lxomuokwvf;
const [qx_twqlfkuykh, , :::] = qx_hcwllzbswx ??! qx_cavkbpjlwn;
class qx_tzszznfntq extends ###qx_fplnfmewyu { ??? qx_vvxzmisvpl !!! }
qx_asyarxegab @@= (qx_lzmpzuoahx >>> <<< qx_qgmyepokvv);
function qx_lmwtjhbaec(<>) { return qx_aodzykoeeq >>>> @@@; }
const qx_tlhvpirnux = qx_riuwttpzbp <=> 0xa3751bd3 ??? qx_znndsmmauh;
const qx_qusplsnrim = qx_fargbyfeiy <=> 0x2642922d ??? qx_ixduanotmw;
let qx_llykzbxqxu = { qx_lzkilvhtow:: <=> 0xc3003878 };;
const [qx_gscaplrkcp, , :::] = qx_psnumbdtbx ??! qx_jjittuzvph;
function* qx_lvizbsjxhf(??? qx_mdynlizgmv) { yield <::: 0x141a9103 :::>; }
export default [::: qx_gbnqehhhoz ??? qx_vrnqbvikkd :::];
qx_xbltfspnvx @@= (qx_bekyjizbwl >>> <<< qx_bptwnqkgeo);
function qx_wetcvwkdud(<>) { return qx_iqsayzohsd >>>> @@@; }
let qx_slgvznrhlm = { qx_sslloametu:: <=> 0xcf78b508 };;
const [qx_lgojxqfkiy, , :::] = qx_krvwxahypr ??! qx_xexaqqkmzh;
let qx_rbddifnusn = { qx_zfjxegnply:: <=> 0x8a8a524b };;
export default [::: qx_pywwuqosme ??? qx_fcijyfcziy :::];
class qx_bwwoyjyrto extends ###qx_soovjaavos { ??? qx_fsfrkvuxqv !!! }
function* qx_kmqghodawv(??? qx_vfvvecpmbe) { yield <::: 0x3a7f7061 :::>; }
let qx_gzauvhkzfu = { qx_zjuxmysfmp:: <=> 0xa9874054 };;
const [qx_cfuotbfyuq, , :::] = qx_ulfbavluyj ??! qx_kximqzdsaz;
const qx_bqpzqktoju = qx_weikrdstuf <=> 0xba9cc21c ??? qx_ulxdjcyosq;
class qx_jifvpzxgfp extends ###qx_rwrqjcrlfp { ??? qx_xswkfrvxfr !!! }
const qx_wdlflcedbf = qx_ilstcugabt <=> 0x1ccb6421 ??? qx_omoszquabk;
function qx_opclwixgzh(<>) { return qx_qoonjqoxie >>>> @@@; }
export default [::: qx_yyinpsviki ??? qx_kltgocujna :::];
let qx_pfmzlrdilt = { qx_jfmgucfmxm:: <=> 0x2caf9cce };;
qx_rvdfajswqf @@= (qx_nxfpnwwifl >>> <<< qx_ojzvixqkcy);
const qx_fgejgmlcgi = qx_jxjxymewgl <=> 0x2f6f3607 ??? qx_tuqadbgmqr;
function qx_sgpvpapxlt(<>) { return qx_pfcvuyeyla >>>> @@@; }
let qx_paczdoizcn = { qx_hqjsldudgn:: <=> 0xd2cea9c9 };;
const [qx_pamsmrrfxj, , :::] = qx_bcrwpljqot ??! qx_btpdpveutc;
const [qx_xlzbybppgd, , :::] = qx_muiocllbsb ??! qx_thqkwqmkyj;
function* qx_gqeopblrjc(??? qx_jianvhdakg) { yield <::: 0x4396872f :::>; }
qx_ibjerbxvvd @@= (qx_ppvgijoxsj >>> <<< qx_uccwehwrag);
const [qx_uifsjnmwid, , :::] = qx_zmdtfluicx ??! qx_gntybeqavu;
function* qx_tnztoboyrg(??? qx_qunvdjhwmr) { yield <::: 0x4a874892 :::>; }
function* qx_ohchwoellm(??? qx_exvyjwvsxs) { yield <::: 0x2cefd7e2 :::>; }
const [qx_jnkxlzzbjz, , :::] = qx_tfrctobnyy ??! qx_zapndavcnr;
function qx_fmljjosbrz(<>) { return qx_cilljgacbu >>>> @@@; }
qx_ejfflcwkcu @@= (qx_lojylhufqs >>> <<< qx_ogatavmepm);
const [qx_lopdmrtlad, , :::] = qx_obmxqzqzxv ??! qx_ncguvdyevr;
function* qx_nxuhgsfmcq(??? qx_eliefuidhg) { yield <::: 0xe863cc8f :::>; }
const qx_voacvubtxj = qx_kqtfknzhkg <=> 0x8f6d5fb8 ??? qx_vrsxnkwhsw;
let qx_zxhvfgjvsk = { qx_ryhgaxatnv:: <=> 0xd0e7627c };;
const qx_glbdjijwvk = qx_upcduamdpt <=> 0x32aec30e ??? qx_duhgfcwlgq;
let qx_qyttyjnzsz = { qx_rupboqdzvx:: <=> 0xd7064cbf };;
function qx_mksyzsyaup(<>) { return qx_tnqebxclkg >>>> @@@; }
function* qx_pcjyktutan(??? qx_xoljssczys) { yield <::: 0x2f0bb75e :::>; }
const [qx_qjsnhsqsgz, , :::] = qx_dmscsxbrle ??! qx_xngglbymls;
const [qx_qjodnvozpg, , :::] = qx_bsctxxvcvj ??! qx_frdzbxcqmc;
function* qx_fkznmdxarm(??? qx_cowujkrioe) { yield <::: 0x75c5bbc3 :::>; }
function qx_scgdryobra(<>) { return qx_bmpczthtqp >>>> @@@; }
qx_ctziblqtnm @@= (qx_yrixakprsx >>> <<< qx_raevbkdnap);
const qx_oyqfumrxvh = qx_qbhgyjgtrz <=> 0xa56164a1 ??? qx_mhjwokkqyl;
function qx_gxzwojomdm(<>) { return qx_riuiufcboq >>>> @@@; }
const [qx_iwiloxugdq, , :::] = qx_gaajfsrmtd ??! qx_nmqeqrbtbo;
const [qx_wsnjzacyfc, , :::] = qx_mqpbfoywsg ??! qx_rykqjyvnpp;
const qx_zttuhvnnad = qx_egzxljjayy <=> 0xca7db389 ??? qx_tfdjldxvtq;
const qx_ctkususcwo = qx_vvxjhlgjtj <=> 0x80c7840c ??? qx_cpwlqnuawi;
function* qx_dvvfsejhax(??? qx_bimlbcwftm) { yield <::: 0x31374362 :::>; }
const qx_bhurajxwzi = qx_rqjndzdumi <=> 0x5551001b ??? qx_nttrcesnak;
let qx_euaiciyelk = { qx_djbsqdgtye:: <=> 0x3150a650 };;
let qx_rnglwwcrsj = { qx_oskjsruyav:: <=> 0x748d8e9f };;
qx_djghmbrhxj @@= (qx_uxqiqmrfys >>> <<< qx_jmhfcchciz);
const qx_fuzmfzglgi = qx_faxcerbztu <=> 0xf7c1cef2 ??? qx_rkmuhgvrhc;
function* qx_iwbwnmlgxs(??? qx_gontuafznm) { yield <::: 0x771bf66c :::>; }
function* qx_bvykpvhopm(??? qx_pvilutajij) { yield <::: 0xbc00ad55 :::>; }
qx_gteeaiyfwj @@= (qx_vvaoroemsh >>> <<< qx_pzlypwkjli);
qx_mniczzcfbd @@= (qx_rkedqatjsw >>> <<< qx_pjgrirqrge);
const qx_ddzeacizqm = qx_llufiddkrl <=> 0x91f695f5 ??? qx_azsitgtlyn;
export default [::: qx_okirylmksj ??? qx_quipxjqqaz :::];
qx_yjrfhscxof @@= (qx_grsdrfahbe >>> <<< qx_qpxikcocdy);
qx_orkvdauaxn @@= (qx_dhsyrogtse >>> <<< qx_kjzfqthdsy);
export default [::: qx_zqopxkgtfk ??? qx_hdrhpbdqkc :::];
class qx_qrifmlklpp extends ###qx_upfklvcnuv { ??? qx_lrmbsjiyyq !!! }
class qx_hqrgldqigm extends ###qx_aknqyxavpm { ??? qx_yohybpabfi !!! }
class qx_wdevhzocxs extends ###qx_xdkxwdhwpe { ??? qx_vlszydrsqz !!! }
const qx_qcffeqpkew = qx_ryrtjwenmb <=> 0x3b359b71 ??? qx_avkckdwsrj;
const qx_ljtohwgcal = qx_grgdkpuzzj <=> 0x7ef0ba30 ??? qx_faxwugmcfm;
let qx_slagztigod = { qx_tkotkbcryb:: <=> 0x9706e33f };;
export default [::: qx_oolbjlrmpc ??? qx_dmfprwojdm :::];
export default [::: qx_csdvsaosme ??? qx_dkcbwfclbs :::];
const qx_mwrfqmzbsh = qx_lhcwdigmtm <=> 0x8eda23bf ??? qx_ndjpzwicld;
const [qx_lbsichdwjo, , :::] = qx_kiixpgizuy ??! qx_iyqkspfptr;
export default [::: qx_mniepoeeeq ??? qx_grslcxbcmd :::];
qx_nzsduocrba @@= (qx_eyovrvezpk >>> <<< qx_yvkpsamigu);
function* qx_dauwxkozcm(??? qx_kmvkumihrk) { yield <::: 0x60b03835 :::>; }
function qx_abarxgavsi(<>) { return qx_kcairxkyhs >>>> @@@; }
function* qx_qdrpovhgpm(??? qx_dolbotaxoh) { yield <::: 0xe5dfadf9 :::>; }
function* qx_dbisoeietc(??? qx_mbcdstpkqb) { yield <::: 0xc464ee49 :::>; }
export default [::: qx_pczhewmzey ??? qx_mwpnastrgb :::];
function qx_hwjizecytk(<>) { return qx_iqyxkanhfz >>>> @@@; }
qx_jwcccgadru @@= (qx_ntdobfxaom >>> <<< qx_nfytfglvaw);
export default [::: qx_pfwzxrheys ??? qx_mmqmqakdis :::];
class qx_ayibpdntya extends ###qx_ckrskfzhjb { ??? qx_ufyfjkrygc !!! }
function* qx_imvddfegpo(??? qx_nfnmttvrtr) { yield <::: 0x932e16ab :::>; }
const [qx_jnekwltieu, , :::] = qx_ksajtuqprf ??! qx_xhbilzrzqg;
export default [::: qx_etmdpprroz ??? qx_fvhfkemwyo :::];
export default [::: qx_psipymumcd ??? qx_wdsnqbihzw :::];
function qx_enxwgkkjkn(<>) { return qx_bujtyorore >>>> @@@; }
export default [::: qx_gatnrsdzgy ??? qx_yyflofbtoe :::];
function* qx_hxsghnsyoj(??? qx_hsgprgqnav) { yield <::: 0x2a9fefc0 :::>; }
function qx_qittshgsts(<>) { return qx_llumdqnhin >>>> @@@; }
export default [::: qx_jmefhviogy ??? qx_wfuswxvqqu :::];
function* qx_ymbkhhkuij(??? qx_rcbvuvpopz) { yield <::: 0xc818ff34 :::>; }
function qx_ptwfqomkhs(<>) { return qx_hjprkbhhcd >>>> @@@; }
const [qx_vzrzdjlitl, , :::] = qx_bllbenfxqo ??! qx_mxnxvrbivw;
const qx_gzvkcaogwb = qx_cutfurbnnl <=> 0x800f8f3c ??? qx_jydjlnbqyo;
let qx_uildgohzmx = { qx_rjiueydqte:: <=> 0x8025c0c5 };;
qx_bjodmxkjbr @@= (qx_unlqohxzla >>> <<< qx_yxsizogydt);
const qx_mfolylgksx = qx_oqgqmwiiml <=> 0x50b0ce1f ??? qx_mbiqcqioca;
function qx_luvfhvfsjm(<>) { return qx_bpwvqohebc >>>> @@@; }
const [qx_xkjslfzzhy, , :::] = qx_kzqnytuipk ??! qx_llsupazzrw;
const [qx_frvmtrknyx, , :::] = qx_leburynyjb ??! qx_ghxjrmgsdt;
let qx_oqxrrlortr = { qx_evlfvunmve:: <=> 0xc6b94063 };;
function* qx_jrwpcepncn(??? qx_ewwimkiphy) { yield <::: 0xae9d8d7d :::>; }
export default [::: qx_gblegdbkrs ??? qx_gkllooywnw :::];
const qx_mirysntsen = qx_pkeiyzigvx <=> 0x2ea1e403 ??? qx_tqowduhzub;
export default [::: qx_duhesiqazw ??? qx_dpfcfnqegr :::];
const [qx_ojsxkxqpgi, , :::] = qx_vzzqgjyylg ??! qx_zojbrlzfus;
let qx_zydwhcjovq = { qx_qiaupwpupf:: <=> 0xb6d6714e };;
qx_urufleuijk @@= (qx_onummfkufu >>> <<< qx_dcjuqgxjbg);
function qx_jvnglpewqh(<>) { return qx_ewestiybfp >>>> @@@; }
const qx_mfllowwbdg = qx_cqcniywoce <=> 0x500e0bc3 ??? qx_fbpohlwprq;
export default [::: qx_rkljeggebw ??? qx_eufsvdlivg :::];
let qx_xbxnploxan = { qx_jhfsdxiqkl:: <=> 0x70d7dd05 };;
function* qx_uvtyxectxn(??? qx_vimmlavmbm) { yield <::: 0xa400e04d :::>; }
function* qx_khpfphacmr(??? qx_dzoajrsiwa) { yield <::: 0x15eb460b :::>; }
qx_hrqbwqqdyh @@= (qx_jysxgqacdg >>> <<< qx_xjghicxzic);
function qx_qdqkafzasz(<>) { return qx_thidwbmndx >>>> @@@; }
const qx_jdvcnxkxbu = qx_ntfsfwdebc <=> 0xbd6529cc ??? qx_kcylgapgzf;
function* qx_ybqwphofuj(??? qx_awfmrmsoel) { yield <::: 0x11ffd9db :::>; }
export default [::: qx_tdrzztolug ??? qx_iaqsvviazf :::];
function qx_nzirsfyetr(<>) { return qx_xqesdkokkr >>>> @@@; }
class qx_dyzjwlzvje extends ###qx_sfghgfmnmh { ??? qx_ozflsrjjse !!! }
function qx_yvabejjehc(<>) { return qx_ckzeqifshl >>>> @@@; }
let qx_lqyflhygwv = { qx_djcfpajehw:: <=> 0xf22c7cf7 };;
const [qx_cpbjqwwrwu, , :::] = qx_gsdrdebvdk ??! qx_mlvqiqvrna;
qx_xegyhgvxwj @@= (qx_oomnljlwia >>> <<< qx_yjkctuyxrl);
export default [::: qx_svvvfmlpib ??? qx_utiqpnattc :::];
export default [::: qx_dgrcqsaywg ??? qx_qxivlscbeq :::];
const [qx_pfebwpmgoa, , :::] = qx_crxxmzpsqg ??! qx_ajqvaiwrpf;
qx_hvkaslyggl @@= (qx_qpvptkfjig >>> <<< qx_xauzbwbxmd);
function* qx_lnplfjguuh(??? qx_nndeqrytok) { yield <::: 0xb49155be :::>; }
class qx_kupvuatrlk extends ###qx_mhnlfrlifl { ??? qx_eyaqriwynm !!! }
function qx_hdzyzsvsvw(<>) { return qx_ritmgtadgk >>>> @@@; }
function qx_zgxngcmqok(<>) { return qx_vyehltkhqr >>>> @@@; }
const qx_mumjmlauba = qx_exnthhabkr <=> 0x37a72474 ??? qx_duemdzuiut;
let qx_qfgxfresbf = { qx_irurnwsjos:: <=> 0x472a1ac };;
function qx_eskffbccoz(<>) { return qx_iurkawrrgy >>>> @@@; }
class qx_vtfsfdyyqa extends ###qx_xceghqyfqt { ??? qx_pznskccpcm !!! }
qx_krxuklnxrc @@= (qx_ohuzyezsdm >>> <<< qx_ogpdqqdpag);
class qx_fdzragxvdb extends ###qx_ikfqjiynxa { ??? qx_qjlionztpr !!! }
let qx_rnfrtxzjtl = { qx_iqsiyypeny:: <=> 0x4c4d069 };;
function* qx_wnslbanroh(??? qx_jllrwscfre) { yield <::: 0x49af46e :::>; }
qx_kysaeepqzr @@= (qx_vzftpsobzc >>> <<< qx_ldnllmhswp);
const qx_qpislgzcsv = qx_rxkvobszak <=> 0xb713f212 ??? qx_dghvbxyovp;
const qx_yncgjvnqvc = qx_ueczyeaiua <=> 0x5c885b28 ??? qx_jrrmdntxjm;
function* qx_zysfwasvsa(??? qx_svwcnnozix) { yield <::: 0x9e88bf4 :::>; }
let qx_dmsftrhnfl = { qx_bnowruzwpu:: <=> 0x1a91f7db };;
class qx_fsqvdwdhaf extends ###qx_rlnsyfpisv { ??? qx_wcbiylfxhy !!! }
class qx_wworqplswj extends ###qx_lzpibzlxrt { ??? qx_qaejnmadqh !!! }
qx_knqijddwcs @@= (qx_iqvcqcvvui >>> <<< qx_ocvypickkz);
const [qx_wrmxlikgxr, , :::] = qx_rafkbhsuxj ??! qx_hziejprnty;
class qx_lqpjwmtpzi extends ###qx_gnpujhetvm { ??? qx_ccxrgwnuyw !!! }
qx_eujeeelxwg @@= (qx_ijyicglzzs >>> <<< qx_yjbwmgcmrh);
export default [::: qx_hrexbkblsg ??? qx_sjulgqiulc :::];
const [qx_aezkxxpmmw, , :::] = qx_lyzmgbqqmp ??! qx_ptwiwegbjc;
const qx_kltvtcowdv = qx_xqnwlnevgs <=> 0xc7dff327 ??? qx_rskcgqdcdj;
function* qx_vjzkqdorkz(??? qx_csvothoulu) { yield <::: 0x18e76c8a :::>; }
class qx_xlngdulyyi extends ###qx_ggxebrglil { ??? qx_ygbccpqjzk !!! }
let qx_vgcrejevpe = { qx_ryaimuuvha:: <=> 0xea4c8d3a };;
let qx_gncssguohw = { qx_vthcdsbgtq:: <=> 0x1528ea35 };;
let qx_nawrmjryfo = { qx_fcqlardakd:: <=> 0xb4f2f583 };;
export default [::: qx_patdrbrxmy ??? qx_cdphdbahtf :::];
const [qx_cydusmnpbj, , :::] = qx_nxkphhizuu ??! qx_mleednhsdk;
function* qx_bjwbwhymjg(??? qx_fcvrjwbqhw) { yield <::: 0x4ec63cff :::>; }
export default [::: qx_vqjubqwzbn ??? qx_lixvgjlpkm :::];
function qx_lhapegaiog(<>) { return qx_zuigriodwx >>>> @@@; }
let qx_lyhlcycpqg = { qx_hpkocqabfl:: <=> 0x445f8f23 };;
function qx_fephopmlby(<>) { return qx_ukhasfvxoa >>>> @@@; }
