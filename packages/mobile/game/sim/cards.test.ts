/**
 * Level-up card self-check. Run headless: `bun packages/mobile/game/sim/cards.test.ts`
 *
 * The card screen is where the player makes every decision they will remember. Three ways it can go
 * wrong, and all three are checked here:
 *
 *   1. A SCREEN WITH NOTHING TO PICK. Late in a run, with a maxed loadout and a fistful of banishes,
 *      the pool can genuinely run dry. If the draw returns zero cards, the run loop sits waiting for
 *      a choice that can never come — the game hangs, at level 300, in someone's best run ever.
 *   2. OFFERS THAT ARE NOT REPRODUCIBLE. Cards come out of the seeded draw stream and nothing else.
 *      If they drifted, every replay would diverge and every ladder submission would be rejected.
 *   3. WORDS THAT DISAGREE WITH EFFECTS. A card that says +10% damage and grants something else is
 *      the kind of bug players never report, they just quietly stop trusting the game. The card text
 *      is pulled from the same content row as the deltas, and this test checks the pairing.
 *
 * WHAT IT PROVES
 *   1. The same seed and the same picks produce identical offers, card for card.
 *   2. Charges come from the stat table, and reroll/skip/banish each spend exactly one.
 *   3. Reroll changes the screen without consuming the pick; skip consumes it and grants nothing.
 *   4. A banished item never appears again for the rest of the run.
 *   5. Taking a passive raises the stat immediately, and the level card text matches the row applied.
 *   6. A full weapon loadout stops offering new weapons but keeps offering level-ups.
 *   7. Every level of a passive folds in — five levels of one passive is exactly five times the row.
 *   8. Removing a passive rebuild is impossible by construction: the loadout is rebuilt, not patched.
 *   9. A completely maxed player still gets a full screen of filler and can always pick something.
 *  10. Batch screens consume exactly `batchSizeFor` levels and owe exactly that many picks.
 *  11. Draining a deep queue terminates and empties it exactly.
 *  12. `noCardDraw` pays coins per level instead of opening a screen.
 *  13. Thousands of draws allocate nothing.
 */

import { Rng } from "../core/rng";
import { CARD_KIND, CardDraw, FILLER_GOLD, NO_CARD_GOLD, OFFERS_PER_SCREEN } from "./cards";
import { ModifierStack, RUN_FLAG } from "./modifiers";
import { MAX_PASSIVE_LEVEL, PASSIVE_BY_ID, PASSIVE_TYPES, PassiveStore } from "./passives";
import { batchSizeFor, Progression } from "./progression";
import { STAT, STAT_SCALE, Stats } from "./stats";
import { MAX_WEAPON_LEVEL, WEAPON_BY_ID, WEAPON_TYPES, WeaponStore } from "./weapons";

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

function nowMs(): number {
  const host = globalThis as unknown as { performance?: { now?: () => number } };
  return host.performance?.now?.() ?? 0;
}

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
    gc?: () => void;
  };
  host.gc?.();
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

/** A whole run's worth of state, wired the way the run loop wires it. */
interface Harness {
  stats: Stats;
  stack: ModifierStack;
  weapons: WeaponStore;
  passives: PassiveStore;
  prog: Progression;
  cards: CardDraw;
  rng: Rng;
}

function makeRun(seed = 1234, charges = 0): Harness {
  const stats = new Stats();
  const stack = new ModifierStack();
  if (charges > 0) {
    stack.add({
      id: "test.charges",
      wireId: 9001,
      name: "Charges",
      description: "test",
      source: 0,
      deltas: [
        { stat: STAT.rerolls, add: charges },
        { stat: STAT.skips, add: charges },
        { stat: STAT.banishes, add: charges },
      ],
    });
  }
  stack.resolve(stats);
  const weapons = new WeaponStore();
  weapons.reset(1);
  const passives = new PassiveStore();
  passives.reset(1);
  const prog = new Progression();
  prog.reset();
  const cards = new CardDraw();
  cards.resetRun(stats);
  return { stats, stack, weapons, passives, prog, cards, rng: new Rng(seed) };
}

/** Earn `n` level-ups without caring about experience arithmetic. */
function earnLevels(h: Harness, n: number): void {
  for (let i = 0; i < n; i++) h.prog.addXp(1_000_000, h.stats);
  // addXp with a huge value grabs many levels at once; trim the queue to exactly n.
  h.prog.pending = n;
}

function open(h: Harness, flags = 0): boolean {
  return h.cards.beginScreen(0, h.prog, h.weapons, h.passives, h.stats, h.rng, flags);
}

function offersSignature(cards: CardDraw): string {
  let s = "";
  for (let i = 0; i < cards.offerCount; i++) {
    s += `${cards.offerKind[i]}:${cards.offerType[i]}:${cards.offerLevel[i]}|`;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
section("a screen opens when levels are owed");
{
  const h = makeRun();
  check("no levels owed, no screen", open(h) === false && h.cards.open === false);

  earnLevels(h, 1);
  check("one level owed opens a screen", open(h) === true && h.cards.open);
  check("the screen is full", h.cards.offerCount === OFFERS_PER_SCREEN, `${h.cards.offerCount} cards`);
  check("it owes exactly one pick", h.cards.picksRemaining === 1);
  check("the level came off the queue", h.prog.pending === 0);

  let allNew = true;
  for (let i = 0; i < h.cards.offerCount; i++) {
    if (h.cards.offerKind[i] === CARD_KIND.weaponLevel) allNew = false;
    if (h.cards.offerKind[i] === CARD_KIND.passiveLevel) allNew = false;
    if (h.cards.offerLevel[i] !== 1 && h.cards.offerType[i] >= 0) allNew = false;
  }
  check("with an empty loadout every real card is a level 1 pickup", allNew);

  let noDupes = true;
  for (let i = 0; i < h.cards.offerCount; i++) {
    for (let j = i + 1; j < h.cards.offerCount; j++) {
      if (h.cards.offerKind[i] === h.cards.offerKind[j] && h.cards.offerType[i] === h.cards.offerType[j]) {
        noDupes = false;
      }
    }
  }
  check("the same card is never offered twice on one screen", noDupes);
}

// ---------------------------------------------------------------------------------------------
section("the same seed deals the same cards");
{
  const a = makeRun(777);
  const b = makeRun(777);
  earnLevels(a, 6);
  earnLevels(b, 6);

  let identical = true;
  for (let screen = 0; screen < 6; screen++) {
    if (!open(a)) break;
    open(b);
    if (offersSignature(a.cards) !== offersSignature(b.cards)) identical = false;
    while (a.cards.open) {
      a.cards.pick(0, 0, a.weapons, a.passives, a.prog, a.stats, a.stack, a.rng);
      b.cards.pick(0, 0, b.weapons, b.passives, b.prog, b.stats, b.stack, b.rng);
      if (offersSignature(a.cards) !== offersSignature(b.cards)) identical = false;
    }
  }
  check("two runs on one seed, picking the same cards, see the same offers throughout", identical);

  const c = makeRun(778);
  earnLevels(c, 1);
  open(c);
  const a2 = makeRun(777);
  earnLevels(a2, 1);
  open(a2);
  check(
    "a different seed deals a different screen",
    offersSignature(c.cards) !== offersSignature(a2.cards),
    `${offersSignature(a2.cards)} vs ${offersSignature(c.cards)}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("reroll, skip and banish");
{
  const h = makeRun(42, 3);
  check("charges come from the stat table", h.cards.rerollsLeft === 3 && h.cards.skipsLeft === 3 && h.cards.banishesLeft === 3);

  earnLevels(h, 4);
  open(h);
  const before = offersSignature(h.cards);
  const picksBefore = h.cards.picksRemaining;
  check("reroll spends a charge", h.cards.reroll(0, h.weapons, h.passives, h.rng) && h.cards.rerollsLeft === 2);
  check("reroll does not consume the pick", h.cards.picksRemaining === picksBefore);
  check("reroll changed the screen", offersSignature(h.cards) !== before, offersSignature(h.cards));

  // A banished item is gone for the run. Banish whatever is in slot 0 and deal a hundred screens.
  const kind = h.cards.offerKind[0];
  const type = h.cards.offerType[0];
  check("banish spends a charge", h.cards.banish(0, 0, h.weapons, h.passives, h.rng) && h.cards.banishesLeft === 2);
  check("the banished item is recorded", h.cards.isBanished(kind, type));

  let reappeared = false;
  for (let i = 0; i < 200; i++) {
    h.cards.reroll(0, h.weapons, h.passives, h.rng);
    h.cards.rerollsLeft = 5; // keep rerolling for the sake of the search
    for (let s = 0; s < h.cards.offerCount; s++) {
      const sameFamily =
        (kind === CARD_KIND.newWeapon || kind === CARD_KIND.weaponLevel) ===
        (h.cards.offerKind[s] === CARD_KIND.newWeapon || h.cards.offerKind[s] === CARD_KIND.weaponLevel);
      if (sameFamily && h.cards.offerType[s] === type) reappeared = true;
    }
  }
  check("a banished item never comes back this run", !reappeared, "200 redraws");

  const goldBefore = h.prog.gold;
  const weaponsBefore = h.weapons.countFor(0);
  const passivesBefore = h.passives.countFor(0);
  const owed = h.cards.picksRemaining;
  check("skip spends a charge", h.cards.skip(0, h.weapons, h.passives, h.rng) && h.cards.skipsLeft === 2);
  check("skip consumes the pick", h.cards.picksRemaining === owed - 1);
  check(
    "skip grants nothing at all",
    h.prog.gold === goldBefore &&
      h.weapons.countFor(0) === weaponsBefore &&
      h.passives.countFor(0) === passivesBefore,
  );

  h.cards.rerollsLeft = 0;
  h.cards.skipsLeft = 0;
  h.cards.banishesLeft = 0;
  check("with no charges left the buttons simply do nothing", !h.cards.reroll(0, h.weapons, h.passives, h.rng) && !h.cards.skip(0, h.weapons, h.passives, h.rng) && !h.cards.banish(0, 0, h.weapons, h.passives, h.rng));
}

// ---------------------------------------------------------------------------------------------
section("taking a passive changes the numbers straight away");
{
  const h = makeRun(9);
  const sigil = PASSIVE_BY_ID.get("grimSigil") ?? -1;
  check("the passive catalog is addressable by id", sigil >= 0);

  const damageBefore = h.stats.get(STAT.damage);
  earnLevels(h, MAX_PASSIVE_LEVEL);
  for (let level = 1; level <= MAX_PASSIVE_LEVEL; level++) {
    h.passives.grant(0, sigil);
    h.passives.applyTo(h.stack, 0);
    h.stack.resolve(h.stats);
  }
  check(
    "five levels of Grim Sigil is exactly five times the card's promise",
    h.stats.get(STAT.damage) === damageBefore + 5 * 100,
    `${h.stats.get(STAT.damage)} vs ${damageBefore + 500}`,
  );
  check("and the item is maxed", h.passives.isMaxed(0, sigil) && h.passives.levelOf(0, sigil) === MAX_PASSIVE_LEVEL);

  h.passives.grant(0, sigil);
  h.passives.applyTo(h.stack, 0);
  h.stack.resolve(h.stats);
  check("granting a maxed passive again changes nothing", h.stats.get(STAT.damage) === damageBefore + 500);

  // Order independence: two loadouts with the same levels in a different order must be identical.
  const boots = PASSIVE_BY_ID.get("wanderersBoots") ?? -1;
  const x = makeRun(1);
  x.passives.grant(0, boots);
  x.passives.grant(0, sigil);
  x.passives.grant(0, boots);
  x.passives.applyTo(x.stack, 0);
  x.stack.resolve(x.stats);
  const y = makeRun(1);
  y.passives.grant(0, sigil);
  y.passives.grant(0, boots);
  y.passives.grant(0, boots);
  y.passives.applyTo(y.stack, 0);
  y.stack.resolve(y.stats);
  let same = true;
  for (let i = 0; i < x.stats.values.length; i++) if (x.stats.values[i] !== y.stats.values[i]) same = false;
  check("pick order cannot change the resulting stats", same);

  // Cooldown passives go the other way, and the floor is what protects the fire rate.
  const glass = PASSIVE_BY_ID.get("ashHourglass") ?? -1;
  const z = makeRun(1);
  const cdBefore = z.stats.get(STAT.cooldown);
  z.passives.devSetLevel(0, glass, MAX_PASSIVE_LEVEL);
  z.passives.applyTo(z.stack, 0);
  z.stack.resolve(z.stats);
  check("Ash Hourglass shortens the cooldown", z.stats.get(STAT.cooldown) === cdBefore - 300, `${z.stats.get(STAT.cooldown)}`);

  const health = PASSIVE_BY_ID.get("gravemossRoot") ?? -1;
  const w = makeRun(1);
  const hpBefore = w.stats.get(STAT.maxHealth);
  w.passives.devSetLevel(0, health, MAX_PASSIVE_LEVEL);
  w.passives.applyTo(w.stack, 0);
  w.stack.resolve(w.stats);
  check(
    "Gravemoss Root adds the health it says it does",
    w.stats.get(STAT.maxHealth) === hpBefore + 120 * STAT_SCALE,
    `${w.stats.get(STAT.maxHealth) / STAT_SCALE}hp`,
  );
}

// ---------------------------------------------------------------------------------------------
section("the card text always matches what is applied");
{
  const h = makeRun(31);
  let mismatch = "";
  earnLevels(h, 400);
  let guard = 0;
  while (h.prog.pending > 0 && guard++ < 500) {
    if (!open(h)) break;
    while (h.cards.open) {
      const kind = h.cards.offerKind[0];
      const type = h.cards.offerType[0];
      const level = h.cards.offerLevel[0];
      const text = h.cards.offerText[0];
      if (kind === CARD_KIND.weaponLevel && text !== WEAPON_TYPES[type].levels[level - 2].text) {
        mismatch = `weapon ${WEAPON_TYPES[type].id} level ${level}`;
      }
      if (kind === CARD_KIND.passiveLevel && text !== PASSIVE_TYPES[type].levels[level - 1].text) {
        mismatch = `passive ${PASSIVE_TYPES[type].id} level ${level}`;
      }
      if (kind === CARD_KIND.newWeapon && level !== 1) mismatch = `new weapon at level ${level}`;
      h.cards.pick(0, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
    }
  }
  check("every level card quoted the row it actually applied", mismatch === "", mismatch);
  check("the queue drained completely", h.prog.pending === 0, `${h.cards.screensShown} screens, ${h.cards.picksMade} picks`);
  check("the loadout filled up on the way", h.weapons.countFor(0) === 6 && h.passives.countFor(0) === 6);
}

// ---------------------------------------------------------------------------------------------
section("a full loadout still offers upgrades");
{
  const h = makeRun(55);
  for (let i = 0; i < WEAPON_TYPES.length; i++) h.weapons.grant(0, i);
  check("six weapons fills the loadout", h.weapons.isFull(0));

  earnLevels(h, 200);
  let sawNewWeapon = false;
  let sawWeaponLevel = false;
  for (let s = 0; s < 40; s++) {
    if (!open(h)) break;
    for (let i = 0; i < h.cards.offerCount; i++) {
      if (h.cards.offerKind[i] === CARD_KIND.newWeapon) sawNewWeapon = true;
      if (h.cards.offerKind[i] === CARD_KIND.weaponLevel) sawWeaponLevel = true;
    }
    while (h.cards.open) h.cards.pick(0, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
  }
  check("a full weapon loadout is never offered a seventh weapon", !sawNewWeapon);
  check("but it is still offered level-ups", sawWeaponLevel);
}

// ---------------------------------------------------------------------------------------------
section("a maxed player still gets a screen");
{
  const h = makeRun(101);
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    for (let l = 0; l < MAX_WEAPON_LEVEL; l++) h.weapons.grant(0, i);
  }
  for (let i = 0; i < PASSIVE_TYPES.length; i++) h.passives.devSetLevel(0, i, MAX_PASSIVE_LEVEL);
  check("everything is maxed", h.weapons.isMaxed(0, WEAPON_BY_ID.get("gravebolt") ?? 0) && h.passives.isMaxed(0, 0));

  earnLevels(h, 3);
  open(h);
  check("the screen is still full", h.cards.offerCount === OFFERS_PER_SCREEN);
  let allFiller = true;
  for (let i = 0; i < h.cards.offerCount; i++) {
    if (h.cards.offerKind[i] !== CARD_KIND.gold && h.cards.offerKind[i] !== CARD_KIND.food) allFiller = false;
  }
  check("and it is all filler, because there is nothing left to improve", allFiller);

  const goldBefore = h.prog.gold;
  const goldSlot = h.cards.offerKind[0] === CARD_KIND.gold ? 0 : 1;
  h.cards.pick(goldSlot, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
  check("a coin card pays coins", h.prog.gold === goldBefore + FILLER_GOLD, `${h.prog.gold - goldBefore}`);

  earnLevels(h, 1);
  open(h);
  const foodSlot = h.cards.offerKind[0] === CARD_KIND.food ? 0 : 1;
  h.cards.pick(foodSlot, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
  check("a food card queues healing for the run loop to apply", h.cards.healPending > 0, `${h.cards.healPending}hp`);
  h.cards.clearHeal();
  check("and the run loop can clear it", h.cards.healPending === 0);

  check("filler cannot be banished — there is nothing to remove", (() => {
    earnLevels(h, 1);
    open(h);
    h.cards.banishesLeft = 1;
    const ok = h.cards.banish(0, 0, h.weapons, h.passives, h.rng);
    return !ok && h.cards.banishesLeft === 1;
  })());
}

// ---------------------------------------------------------------------------------------------
section("batched screens");
{
  const cases = [1, 2, 3, 6, 7, 20, 21, 80, 81, 500];
  let sizesMatch = true;
  let drainsExactly = true;
  for (const owed of cases) {
    const h = makeRun(7 + owed);
    earnLevels(h, owed);
    open(h);
    const expected = Math.min(batchSizeFor(owed), owed);
    if (h.cards.picksRemaining !== expected) sizesMatch = false;
    if (h.cards.levelsThisScreen !== expected) sizesMatch = false;

    let guard = 0;
    while (guard++ < 5000) {
      while (h.cards.open) h.cards.pick(0, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
      if (!open(h)) break;
    }
    if (h.prog.pending !== 0 || h.cards.open) drainsExactly = false;
  }
  check("the batch size follows the queue depth exactly", sizesMatch);
  check("however deep the queue, draining it terminates and empties it", drainsExactly);

  const h = makeRun(3);
  earnLevels(h, 30);
  open(h);
  check("a batch screen owes several picks", h.cards.picksRemaining === batchSizeFor(30), `${h.cards.picksRemaining} picks`);
  const first = offersSignature(h.cards);
  h.cards.pick(0, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
  check("the screen stays open until every pick is spent", h.cards.open && h.cards.picksRemaining === batchSizeFor(30) - 1);
  check("and redeals between picks", offersSignature(h.cards) !== first);
}

// ---------------------------------------------------------------------------------------------
section("a run with card draws switched off");
{
  const h = makeRun(12);
  earnLevels(h, 25);
  const opened = open(h, RUN_FLAG.noCardDraw);
  check("no screen opens", opened === false && h.cards.open === false);
  check("the whole queue is consumed", h.prog.pending === 0);
  check("and it pays out per level instead", h.prog.gold === NO_CARD_GOLD * 25, `${h.prog.gold} gold`);
}

// ---------------------------------------------------------------------------------------------
section("unlocks");
{
  const h = makeRun(64);
  for (let i = 1; i < WEAPON_TYPES.length; i++) h.cards.weaponUnlocked[i] = 0;
  for (let i = 1; i < PASSIVE_TYPES.length; i++) h.cards.passiveUnlocked[i] = 0;
  earnLevels(h, 5);
  open(h);
  let onlyUnlocked = true;
  for (let i = 0; i < h.cards.offerCount; i++) {
    const kind = h.cards.offerKind[i];
    if ((kind === CARD_KIND.newWeapon || kind === CARD_KIND.newPassive) && h.cards.offerType[i] !== 0) {
      onlyUnlocked = false;
    }
  }
  check("locked content is not offered", onlyUnlocked);

  // Deliberately across many seeds rather than one: a single screen only shows four cards, so with a
  // large content pool "this seed happened to deal four passives" would fail a working dev flag. What
  // is actually being claimed is a pool claim, not a deal claim — locked weapons are reachable with
  // the flag on and unreachable with it off — so both halves are asked of the same list of seeds.
  const SEEDS = 24;
  let lockedWeaponDealsWithFlag = 0;
  let lockedWeaponDealsWithoutFlag = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const useFlag of [true, false]) {
      const g = makeRun(seed * 977);
      for (let i = 1; i < WEAPON_TYPES.length; i++) g.cards.weaponUnlocked[i] = 0;
      earnLevels(g, 5);
      open(g, useFlag ? RUN_FLAG.ignoreUnlocks : 0);
      for (let i = 0; i < g.cards.offerCount; i++) {
        if (g.cards.offerKind[i] !== CARD_KIND.newWeapon) continue;
        if (g.cards.offerType[i] === 0) continue;
        if (useFlag) lockedWeaponDealsWithFlag++;
        else lockedWeaponDealsWithoutFlag++;
      }
    }
  }
  check(
    "the dev flag opens the whole pool",
    lockedWeaponDealsWithFlag > 0,
    `${lockedWeaponDealsWithFlag} locked weapons dealt across ${SEEDS} screens`,
  );
  check(
    "and without the flag a locked weapon never once appears",
    lockedWeaponDealsWithoutFlag === 0,
    `${lockedWeaponDealsWithoutFlag} leaks`,
  );
}

// ---------------------------------------------------------------------------------------------
section("cost");
{
  const h = makeRun(2024);
  // Warm the code paths first so the measurement is of steady state, not of first-run compilation.
  earnLevels(h, 50);
  while (h.prog.pending > 0 && open(h)) {
    while (h.cards.open) h.cards.pick(0, 0, h.weapons, h.passives, h.prog, h.stats, h.stack, h.rng);
  }

  const before = heapUsed();
  const t0 = nowMs();
  const draws = 20_000;
  h.cards.rerollsLeft = draws + 10;
  earnLevels(h, 4);
  open(h);
  for (let i = 0; i < draws; i++) {
    h.cards.rerollsLeft = draws + 10;
    h.cards.reroll(0, h.weapons, h.passives, h.rng);
  }
  const elapsed = nowMs() - t0;
  const growth = (heapUsed() - before) / 1024;

  check(
    "twenty thousand deals allocate nothing — a batch screen redeals a lot and the phone cannot afford garbage",
    growth < 64,
    `${growth.toFixed(1)}KB over ${draws} deals`,
  );
  check("and a deal is far too fast to be felt", elapsed / draws < 0.05, `${Math.round((elapsed * 1000) / draws)}ns per deal`);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
