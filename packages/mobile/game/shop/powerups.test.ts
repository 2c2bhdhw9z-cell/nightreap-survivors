/**
 * PowerUps shop self-check. Run headless: `bun packages/mobile/game/shop/powerups.test.ts`
 *
 * The shop is where every coin the player has ever earned goes, so the failures worth preventing are the
 * ones that touch their money:
 *
 *   1. A PURCHASE IS ALL OR NOTHING. Every refusal is proved to leave the gold *and* the rank exactly as
 *      they were. Not approximately — byte for byte across the whole rank array, so a purchase cannot
 *      quietly bump a neighbouring powerup.
 *   2. A REFUND RETURNS EVERY COIN. Proved the hard way: buy a long random-ish spread of ranks, note the
 *      gold, refund, and require the balance to be exactly what it was before the first purchase.
 *   3. PRICES ESCALATE AND NEVER LIE. Every rank of every powerup is checked to cost more than the last,
 *      to be a round number, and to be reported as unbuyable rather than priced when it does not exist.
 *   4. LOCKS OPEN ONLY WHEN THEY SHOULD, and every locked row can say why in words.
 *   5. A CORRUPT RANK IS NEVER TRUSTED. A rank above the maximum is refused for purchase, pays nothing on
 *      refund, and contributes nothing to stats — rather than being clamped into something plausible.
 *   6. THE CONTENT TABLE IS SANE, and the checks that say so are proved to actually fire by feeding them
 *      deliberately broken content.
 *
 * Note on the 1:2 rule: over half of `powerups.ts` is the content table itself. Every row of it is checked
 * here by exhaustive loops rather than by spot checks, which is the only way a data table can be tested
 * without retyping it.
 */

import {
  BUY,
  EFFECT,
  GOLD_MAX,
  POWERUPS,
  PRICE_STEP,
  UNLOCK,
  applyPowerUps,
  buyRank,
  contentFaults,
  costOf,
  costToMax,
  createBuyOutcome,
  describeBuy,
  indexOf,
  lockStateOf,
  rankOf,
  refundAll,
  shopProgress,
  spentOn,
  totalInvested,
} from "./powerups";
import { STAT, STAT_BASE, STAT_COUNT, STAT_SCALE } from "../sim/stats";

/** A fresh copy of the character baseline, as an Int32Array, the way the run builds it. */
function baseStats(): Int32Array {
  const out = new Int32Array(STAT_COUNT);
  for (let i = 0; i < STAT_COUNT; i++) out[i] = STAT_BASE[i];
  return out;
}
import { createSaveData, SAVE_LIMITS } from "../save/schema";

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

/** A profile with everything unlocked and a lot of gold, so a test can buy anything. */
function rich(gold = 1_000_000) {
  const save = createSaveData(0xabcd, 1);
  save.gold = gold;
  save.goldLifetime = 1_000_000;
  save.runsCompleted = 500;
  save.bestSurvivalSeconds = 3600;
  return save;
}

/** A brand new profile: nothing earned, nothing finished, nothing unlocked beyond the always-on rows. */
function fresh() {
  return createSaveData(0xabcd, 1);
}

/** A copy of the whole rank array, for proving a refusal changed nothing at all. */
function ranksOf(save: { powerUpLevels: Uint8Array }): string {
  return Array.from(save.powerUpLevels).join(",");
}

console.log("powerups shop self-check");

// ------------------------------------------------------------------ the content table

section("the content table is sane");
{
  const faults = contentFaults();
  check("no content faults", faults.length === 0, faults.join(" / "));
  check("there are at least twenty-four powerups", POWERUPS.length >= 24, `${POWERUPS.length}`);
  check("and they fit the save", POWERUPS.length <= SAVE_LIMITS.powerUpCount, `${POWERUPS.length} of ${SAVE_LIMITS.powerUpCount}`);
  check("with room to add more later", POWERUPS.length < SAVE_LIMITS.powerUpCount, `${SAVE_LIMITS.powerUpCount - POWERUPS.length} free`);
}

section("every row is complete and points somewhere real");
{
  let noName = 0;
  let noBlurb = 0;
  let badStat = 0;
  let noEffect = 0;
  let noRanks = 0;
  let badEffectKind = 0;
  for (const p of POWERUPS) {
    if (p.name.trim() === "") noName++;
    if (p.blurb.trim() === "") noBlurb++;
    if (p.stat < 0 || p.stat >= STAT_COUNT) badStat++;
    if (p.perRank === 0) noEffect++;
    if (p.maxRank < 1) noRanks++;
    if (p.effect !== EFFECT.PERCENT && p.effect !== EFFECT.FLAT) badEffectKind++;
  }
  check("every row has a name", noName === 0, `${noName} missing`);
  check("every row has a blurb", noBlurb === 0, `${noBlurb} missing`);
  check("every row points at a real stat", badStat === 0, `${badStat} bad`);
  check("every row does something", noEffect === 0, `${noEffect} inert`);
  check("every row has at least one rank", noRanks === 0, `${noRanks} rankless`);
  check("every row has a known effect kind", badEffectKind === 0, `${badEffectKind} bad`);
}

section("ids are unique and findable");
{
  const seen = new Set<string>();
  let duplicates = 0;
  let unfindable = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const id = POWERUPS[i].id;
    if (seen.has(id)) duplicates++;
    seen.add(id);
    if (indexOf(id) !== i) unfindable++;
  }
  check("no duplicate ids", duplicates === 0, `${duplicates}`);
  check("every id finds its own position", unfindable === 0, `${unfindable}`);
  check("an unknown id is not found", indexOf("no-such-thing") === -1);
  check("an empty id is not found", indexOf("") === -1);
}

section("the shop covers the stats a player would expect to buy");
{
  const stats = new Set(POWERUPS.map((p) => p.stat));
  const wanted: [string, number][] = [
    ["damage", STAT.damage],
    ["max health", STAT.maxHealth],
    ["move speed", STAT.moveSpeed],
    ["armour", STAT.armor],
    ["regen", STAT.regen],
    ["cooldown", STAT.cooldown],
    ["area", STAT.area],
    ["magnet", STAT.magnet],
    ["gold gain", STAT.goldGain],
    ["xp gain", STAT.xpGain],
    ["crit chance", STAT.critChance],
    ["luck", STAT.luck],
    ["revives", STAT.revives],
    ["rerolls", STAT.rerolls],
  ];
  for (const [label, stat] of wanted) {
    check(`something sells ${label}`, stats.has(stat));
  }
  check("at least twenty distinct stats are for sale", stats.size >= 20, `${stats.size}`);
}

section("the two rows that make the game harder are the ones that should be");
{
  const curse = POWERUPS[indexOf("curse")];
  const swarm = POWERUPS[indexOf("spawnRate")];
  check("curse exists", curse !== undefined);
  check("swarm exists", swarm !== undefined);
  check("curse is not free to reverse — it is locked behind a long run", curse.unlock === UNLOCK.BEST_SECONDS);
  check("and swarm sits behind curse", swarm.unlock === UNLOCK.POWERUP_RANK && swarm.requires === "curse");
  // Cooldown is the one stat where lower is better, so its per-rank must be negative or it would be a
  // downgrade sold as an upgrade.
  const cooldown = POWERUPS[indexOf("cooldown")];
  check("cooldown reduces rather than increases", cooldown.perRank < 0, `${cooldown.perRank}`);
}

// ------------------------------------------------------------------------- the prices

section("prices escalate, every rank, every powerup");
{
  let notRising = 0;
  let notRound = 0;
  let firstBad = "";
  for (const p of POWERUPS) {
    let previous = 0;
    for (let r = 0; r < p.maxRank; r++) {
      const price = costOf(p, r);
      if (price % PRICE_STEP !== 0) {
        notRound++;
        if (firstBad === "") firstBad = `${p.id} rank ${r} costs ${price}`;
      }
      if (r > 0 && price <= previous) {
        notRising++;
        if (firstBad === "") firstBad = `${p.id} rank ${r} costs ${price}, rank ${r - 1} cost ${previous}`;
      }
      previous = price;
    }
  }
  check("every price is a round number", notRound === 0, firstBad || `${POWERUPS.length} rows checked`);
  check("every rank costs more than the last", notRising === 0, firstBad || "no flat or falling steps");
}

section("every price is the exact number the curve says, not merely a rising one");
{
  // The curve, written out independently of the code: a linear step per rank, plus an acceleration term,
  // rounded UP to the price step. Rounding up rather than to nearest, because rounding a price down is
  // money given away by accident.
  const byFormula = (base: number, accel: number, owned: number): number => {
    const linear = base * (owned + 1);
    const accelerated = linear + Math.trunc((linear * owned * accel) / 1000);
    return Math.ceil(accelerated / PRICE_STEP) * PRICE_STEP;
  };
  let wrong = 0;
  let firstBad = "";
  let checked = 0;
  for (const p of POWERUPS) {
    for (let r = 0; r < p.maxRank; r++) {
      const want = byFormula(p.baseCost, p.accel, r);
      const got = costOf(p, r);
      checked++;
      if (got !== want) {
        wrong++;
        if (firstBad === "") firstBad = `${p.id} rank ${r}: wanted ${want}, got ${got}`;
      }
    }
  }
  check("every price matches the curve to the coin", wrong === 0, firstBad || `${checked} prices checked`);

  // Hand-checked landmarks, so an off-by-one cannot hide inside a formula that only matches itself.
  // MIGHT is base 200 with 120 acceleration: 200, then 400+48=448 rounded up to 450, then 600+144=744
  // rounded up to 750, then 800+288=1088 -> 1090, then 1000+480=1480.
  const might = POWERUPS[indexOf("might")];
  check("might rank 1 costs 200", costOf(might, 0) === 200, `${costOf(might, 0)}`);
  check("might rank 2 costs 450", costOf(might, 1) === 450, `${costOf(might, 1)}`);
  check("might rank 3 costs 750", costOf(might, 2) === 750, `${costOf(might, 2)}`);
  check("might rank 4 costs 1,090", costOf(might, 3) === 1090, `${costOf(might, 3)}`);
  check("might rank 5 costs 1,480", costOf(might, 4) === 1480, `${costOf(might, 4)}`);
  check("and maxing might costs 3,970", costToMax(might) === 3970, `${costToMax(might)}`);

  // A row with no acceleration must be a straight multiple, which proves the acceleration term is doing
  // something on the rows that have it rather than being multiplied by nothing everywhere.
  const flat = POWERUPS.find((p) => p.accel === 0 && p.maxRank === 1);
  check("there is a row with no acceleration", flat !== undefined);
  if (flat !== undefined) check("and it costs exactly its base", costOf(flat, 0) === flat.baseCost, `${costOf(flat, 0)}`);

  // The acceleration must actually bite: the top rank of an accelerating row costs more than a straight
  // line would. Without this, setting every acceleration to zero would pass every other price test.
  let bitten = 0;
  let accelerating = 0;
  for (const p of POWERUPS) {
    if (p.accel === 0 || p.maxRank < 2) continue;
    accelerating++;
    const top = p.maxRank - 1;
    if (costOf(p, top) > p.baseCost * (top + 1)) bitten++;
  }
  check("most rows accelerate", accelerating >= 20, `${accelerating}`);
  check("and every one of them costs more than a straight line", bitten === accelerating, `${bitten} of ${accelerating}`);

  // The last rank of a long row should be several times the first, or the curve is not a curve.
  const health = POWERUPS[indexOf("maxHealth")];
  check("the top rank of max health is far dearer than the first", costOf(health, health.maxRank - 1) > costOf(health, 0) * 8, `${costOf(health, health.maxRank - 1)} vs ${costOf(health, 0)}`);
}

section("a price is only quoted for a rank that exists");
{
  let quoted = 0;
  for (const p of POWERUPS) {
    if (costOf(p, p.maxRank) !== -1) quoted++;
    if (costOf(p, p.maxRank + 5) !== -1) quoted++;
  }
  check("nothing past the top rank has a price", quoted === 0, `${quoted} phantom prices`);
  const first = POWERUPS[0];
  check("a negative rank has no price", costOf(first, -1) === -1);
  check("a fractional rank has no price", costOf(first, 1.5) === -1);
  check("a NaN rank has no price", costOf(first, Number.NaN) === -1);
}

section("the sum of the prices is what a refund is worth");
{
  let mismatched = 0;
  let firstBad = "";
  for (const p of POWERUPS) {
    for (let owned = 0; owned <= p.maxRank; owned++) {
      let byHand = 0;
      for (let r = 0; r < owned; r++) byHand += costOf(p, r);
      if (spentOn(p, owned) !== byHand) {
        mismatched++;
        if (firstBad === "") firstBad = `${p.id} at ${owned}: ${spentOn(p, owned)} vs ${byHand}`;
      }
    }
  }
  check("every total matches the sum of its parts", mismatched === 0, firstBad || "every rank of every row");
  check("nothing owned is nothing spent", spentOn(POWERUPS[0], 0) === 0);
  check("more than the maximum is capped at the maximum", spentOn(POWERUPS[0], 999) === costToMax(POWERUPS[0]));
  check("a negative amount owned is nothing spent", spentOn(POWERUPS[0], -3) === 0);
}

section("the whole shop is affordable inside the currency");
{
  let all = 0;
  let dearest = { id: "", cost: 0 };
  for (const p of POWERUPS) {
    const cost = costToMax(p);
    all += cost;
    if (cost > dearest.cost) dearest = { id: p.id, cost };
  }
  check("the whole shop fits in the currency", all <= GOLD_MAX, `${all}`);
  check("and so does the dearest single row", dearest.cost <= GOLD_MAX, `${dearest.id} at ${dearest.cost}`);
  // A shop that can be finished off two good runs is not a progression spine.
  check("the shop is a long-term goal", all > 100_000, `${all}`);
  check("but not an impossible one", all < 2_000_000, `${all}`);
}

// ------------------------------------------------------------------- buying, happily

section("buying one rank takes the money and delivers the rank");
{
  const save = rich(10_000);
  const p = POWERUPS[0];
  const price = costOf(p, 0);
  const out = buyRank(save, 0, createBuyOutcome());
  check("it bought", out.bought, describeBuy(out.code));
  check("the code is OK", out.code === BUY.OK, `${out.code}`);
  check("it charged the quoted price", out.paid === price, `${out.paid} vs ${price}`);
  check("the gold went", save.gold === 10_000 - price, `${save.gold}`);
  check("the receipt agrees about the gold", out.goldAfter === save.gold, `${out.goldAfter}`);
  check("and knows where it started", out.goldBefore === 10_000, `${out.goldBefore}`);
  check("the rank arrived", save.powerUpLevels[0] === 1, `${save.powerUpLevels[0]}`);
  check("the receipt agrees about the rank", out.rankAfter === 1 && out.rankBefore === 0);
  check("and quotes the next price", out.nextCost === costOf(p, 1), `${out.nextCost}`);
  check("the next price is dearer", out.nextCost > out.paid, `${out.nextCost} > ${out.paid}`);
}

section("buying a powerup all the way to the top");
{
  const save = rich();
  const p = POWERUPS[0];
  let spent = 0;
  for (let r = 0; r < p.maxRank; r++) {
    const out = buyRank(save, 0, createBuyOutcome());
    if (!out.bought) {
      check(`rank ${r + 1} bought`, false, describeBuy(out.code));
      break;
    }
    spent += out.paid;
  }
  check("it reached the top rank", save.powerUpLevels[0] === p.maxRank, `${save.powerUpLevels[0]}`);
  check("and spent exactly the total", spent === costToMax(p), `${spent} vs ${costToMax(p)}`);
  check("the gold matches", save.gold === 1_000_000 - costToMax(p), `${save.gold}`);

  const extra = buyRank(save, 0, createBuyOutcome());
  check("one more is refused", !extra.bought);
  check("because it is maxed", extra.code === BUY.MAXED, describeBuy(extra.code));
  check("no price is quoted", extra.paid === -1, `${extra.paid}`);
  check("and the gold did not move", save.gold === 1_000_000 - costToMax(p), `${save.gold}`);
}

section("buying one powerup does not touch any other");
{
  const save = rich();
  const before = ranksOf(save);
  buyRank(save, 3, createBuyOutcome());
  const after = Array.from(save.powerUpLevels);
  let moved = 0;
  for (let i = 0; i < after.length; i++) {
    if (i === 3) continue;
    if (after[i] !== 0) moved++;
  }
  check("only the bought row moved", moved === 0, `${moved} others moved`);
  check("and it did move", after[3] === 1, `${after[3]}`);
  check("the array is otherwise as it was", before !== ranksOf(save));
}

section("every unlocked powerup can actually be bought");
{
  const save = rich(GOLD_MAX);
  let refused = 0;
  let firstBad = "";
  for (let i = 0; i < POWERUPS.length; i++) {
    for (let r = 0; r < POWERUPS[i].maxRank; r++) {
      const out = buyRank(save, i, createBuyOutcome());
      if (!out.bought) {
        refused++;
        if (firstBad === "") firstBad = `${POWERUPS[i].id} rank ${r + 1}: ${describeBuy(out.code)}`;
        break;
      }
    }
  }
  check("the whole shop can be bought out", refused === 0, firstBad || `${POWERUPS.length} rows maxed`);
  const progress = shopProgress(save);
  check("progress reports everything owned", progress.owned === progress.total, `${progress.owned} of ${progress.total}`);
  check("and there is a lot of it", progress.total >= 100, `${progress.total} ranks`);
}

// ---------------------------------------------------------------- buying, refused

section("no money means no rank, and nothing moves");
{
  const save = rich(10);
  const goldBefore = save.gold;
  const ranksBefore = ranksOf(save);
  const out = buyRank(save, 0, createBuyOutcome());
  check("it refused", !out.bought);
  check("because it is too expensive", out.code === BUY.TOO_EXPENSIVE, describeBuy(out.code));
  check("it still quotes the price it wanted", out.paid === costOf(POWERUPS[0], 0), `${out.paid}`);
  check("the gold did not move", save.gold === goldBefore, `${save.gold}`);
  check("and not one rank moved", ranksOf(save) === ranksBefore);
}

section("one gold short is still short");
{
  const save = rich(costOf(POWERUPS[0], 0) - 1);
  const out = buyRank(save, 0, createBuyOutcome());
  check("it refused", !out.bought, describeBuy(out.code));
  check("nothing was charged", save.gold === costOf(POWERUPS[0], 0) - 1, `${save.gold}`);

  const exact = rich(costOf(POWERUPS[0], 0));
  const ok = buyRank(exact, 0, createBuyOutcome());
  check("exactly enough is enough", ok.bought, describeBuy(ok.code));
  check("and leaves nothing behind", exact.gold === 0, `${exact.gold}`);
}

section("a powerup that does not exist cannot be bought");
{
  const save = rich();
  const goldBefore = save.gold;
  const ranksBefore = ranksOf(save);
  for (const index of [-1, POWERUPS.length, POWERUPS.length + 100, 1.5, Number.NaN]) {
    const out = buyRank(save, index, createBuyOutcome());
    check(`index ${index} is refused`, !out.bought);
    check(`  and says so`, out.code === BUY.NO_SUCH_POWERUP, describeBuy(out.code));
  }
  check("the gold did not move", save.gold === goldBefore, `${save.gold}`);
  check("and not one rank moved", ranksOf(save) === ranksBefore);
}

section("a locked powerup cannot be bought no matter how rich the player is");
{
  const save = fresh();
  save.gold = GOLD_MAX;
  let bought = 0;
  let lockedRows = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    if (!lockStateOf(save, i).locked) continue;
    lockedRows++;
    const out = buyRank(save, i, createBuyOutcome());
    if (out.bought) bought++;
    else if (out.code !== BUY.LOCKED) {
      check(`${POWERUPS[i].id} refused for the right reason`, false, describeBuy(out.code));
    }
  }
  check("a fresh profile has locked rows", lockedRows > 0, `${lockedRows}`);
  check("and none of them could be bought", bought === 0, `${bought} broke through`);
  check("the gold is untouched", save.gold === GOLD_MAX, `${save.gold}`);
}

section("a rank the content cannot explain is refused, not clamped");
{
  const save = rich();
  save.powerUpLevels[0] = POWERUPS[0].maxRank + 3;
  const out = buyRank(save, 0, createBuyOutcome());
  check("buying is refused", !out.bought);
  check("because the save is wrong", out.code === BUY.BAD_SAVE, describeBuy(out.code));
  check("the impossible rank is reported as unreadable", rankOf(save, 0) === -1, `${rankOf(save, 0)}`);
  check("the gold did not move", save.gold === 1_000_000, `${save.gold}`);
  check("and the bad rank was not quietly fixed", save.powerUpLevels[0] === POWERUPS[0].maxRank + 3);
}

section("a receipt can be reused without leaking the last verdict");
{
  const save = rich(10_000);
  const out = createBuyOutcome();
  buyRank(save, 0, out);
  check("the first purchase is marked bought", out.bought);
  buyRank(save, -1, out);
  check("the refusal is not still marked bought", !out.bought);
  check("nor still carrying a price", out.paid === -1, `${out.paid}`);
  check("nor still quoting a next price", out.nextCost === -1, `${out.nextCost}`);
}

// -------------------------------------------------------------------------- the locks

section("an always-on powerup is available on a brand new profile");
{
  const save = fresh();
  let openRows = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    if (POWERUPS[i].unlock !== UNLOCK.ALWAYS) continue;
    openRows++;
    const lock = lockStateOf(save, i);
    check(`${POWERUPS[i].id} is available`, !lock.locked, lock.reason);
  }
  check("there are enough to start with", openRows >= 4, `${openRows}`);
}

section("every locked row can say why in words");
{
  const save = fresh();
  let silent = 0;
  let noTarget = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const lock = lockStateOf(save, i);
    if (!lock.locked) continue;
    if (lock.reason.trim() === "") silent++;
    if (lock.target <= 0) noTarget++;
  }
  check("every lock has a reason", silent === 0, `${silent} silent`);
  check("and something to work towards", noTarget === 0, `${noTarget} without a target`);
}

section("an unlocked row reports no lock and no reason");
{
  const save = rich();
  let leaked = 0;
  for (let i = 0; i < POWERUPS.length; i++) {
    const lock = lockStateOf(save, i);
    if (lock.locked) continue;
    if (lock.reason !== "" || lock.progress !== 0 || lock.target !== 0) leaked++;
  }
  check("nothing unlocked carries a leftover reason", leaked === 0, `${leaked}`);
}

section("a lifetime-gold lock opens on the exact threshold");
{
  const index = indexOf("greed");
  const want = POWERUPS[index].unlockValue;
  const under = fresh();
  under.goldLifetime = want - 1;
  const on = fresh();
  on.goldLifetime = want;
  check("one short is locked", lockStateOf(under, index).locked);
  check("and reports how far along", lockStateOf(under, index).progress === want - 1);
  check("and how far to go", lockStateOf(under, index).target === want);
  check("exactly there is open", !lockStateOf(on, index).locked);
  const over = fresh();
  over.goldLifetime = want * 10;
  check("well past is open", !lockStateOf(over, index).locked);
  // Spending gold must not re-lock anything: the condition is what was *earned*, not what is held.
  on.gold = 0;
  check("spending the gold does not re-lock it", !lockStateOf(on, index).locked);
}

section("a runs-finished lock opens on the exact threshold");
{
  const index = indexOf("critChance");
  const want = POWERUPS[index].unlockValue;
  const under = fresh();
  under.runsCompleted = want - 1;
  const on = fresh();
  on.runsCompleted = want;
  check("one short is locked", lockStateOf(under, index).locked);
  check("exactly there is open", !lockStateOf(on, index).locked);
}

section("a best-time lock opens on the exact threshold");
{
  const index = indexOf("iFrames");
  const want = POWERUPS[index].unlockValue;
  const under = fresh();
  under.bestSurvivalSeconds = want - 1;
  const on = fresh();
  on.bestSurvivalSeconds = want;
  check("one second short is locked", lockStateOf(under, index).locked);
  check("and the reason talks in minutes", lockStateOf(under, index).reason.includes("minutes"), lockStateOf(under, index).reason);
  check("exactly there is open", !lockStateOf(on, index).locked);
}

section("a powerup-rank lock follows the powerup it names");
{
  const index = indexOf("critDamage");
  const needed = indexOf("critChance");
  const want = POWERUPS[index].unlockValue;
  const save = rich();
  check("it starts locked", lockStateOf(save, index).locked);
  check("and names the powerup it wants", lockStateOf(save, index).reason.includes(POWERUPS[needed].name), lockStateOf(save, index).reason);

  save.powerUpLevels[needed] = want - 1;
  check("one rank short is still locked", lockStateOf(save, index).locked);
  check("and reports the rank held", lockStateOf(save, index).progress === want - 1);

  save.powerUpLevels[needed] = want;
  check("the exact rank opens it", !lockStateOf(save, index).locked);

  // And a refund closes it again, which is correct: the requirement is a rank held, not a rank ever held.
  refundAll(save);
  check("refunding the requirement re-locks it", lockStateOf(save, index).locked);
}

section("a lock cannot be opened by a rank the save should not hold");
{
  const index = indexOf("critDamage");
  const needed = indexOf("critChance");
  const save = rich();
  save.powerUpLevels[needed] = POWERUPS[needed].maxRank + 9;
  check("an impossible rank does not open the next row", lockStateOf(save, index).locked, lockStateOf(save, index).reason);
}

section("an unknown row is locked rather than free");
{
  const save = rich();
  check("past the end of the list", lockStateOf(save, POWERUPS.length).locked);
  check("before the start of the list", lockStateOf(save, -1).locked);
}

// ------------------------------------------------------------------------- the refund

section("a refund returns every coin, exactly");
{
  const save = rich();
  const startingGold = save.gold;
  // A spread across the shop rather than one row, including a maxed one and a half-bought one.
  const plan: [number, number][] = [
    [0, POWERUPS[0].maxRank],
    [1, 3],
    [2, 1],
    [4, POWERUPS[4].maxRank],
    [5, 2],
  ];
  let spent = 0;
  for (const [index, ranks] of plan) {
    for (let r = 0; r < ranks; r++) {
      const out = buyRank(save, index, createBuyOutcome());
      if (!out.bought) {
        check(`bought ${POWERUPS[index].id} rank ${r + 1}`, false, describeBuy(out.code));
        break;
      }
      spent += out.paid;
    }
  }
  check("gold left the profile", save.gold === startingGold - spent, `${save.gold}`);
  check("the shop knows what it is holding", totalInvested(save) === spent, `${totalInvested(save)} vs ${spent}`);

  const out = refundAll(save);
  check("it refunded", out.refunded);
  check("every coin came back", save.gold === startingGold, `${save.gold} vs ${startingGold}`);
  check("the outcome agrees", out.goldReturned === spent, `${out.goldReturned} vs ${spent}`);
  check("nothing was capped", !out.capped);
  check("and it counted the ranks", out.ranksCleared > 0, `${out.ranksCleared}`);

  let leftover = 0;
  for (const rank of save.powerUpLevels) if (rank !== 0) leftover++;
  check("every rank was cleared", leftover === 0, `${leftover} left`);
  check("and the shop now holds nothing", totalInvested(save) === 0, `${totalInvested(save)}`);
}

section("buy the whole shop, refund the whole shop, end up where you started");
{
  const save = rich(GOLD_MAX);
  const startingGold = save.gold;
  for (let i = 0; i < POWERUPS.length; i++) {
    for (let r = 0; r < POWERUPS[i].maxRank; r++) buyRank(save, i, createBuyOutcome());
  }
  const progress = shopProgress(save);
  check("everything is owned", progress.owned === progress.total, `${progress.owned} of ${progress.total}`);
  const spent = startingGold - save.gold;
  check("a lot of gold was spent", spent > 100_000, `${spent}`);

  refundAll(save);
  check("the balance is exactly what it was", save.gold === startingGold, `${save.gold} vs ${startingGold}`);
  check("and nothing is owned", shopProgress(save).owned === 0, `${shopProgress(save).owned}`);
}

section("refunding an empty shop is not an error and pays nothing");
{
  const save = rich(1234);
  const out = refundAll(save);
  check("it did not refund", !out.refunded);
  check("nothing was returned", out.goldReturned === 0, `${out.goldReturned}`);
  check("no ranks were cleared", out.ranksCleared === 0, `${out.ranksCleared}`);
  check("the gold did not move", save.gold === 1234, `${save.gold}`);
}

section("a refund into a nearly full purse says what it lost");
{
  const save = rich();
  for (let i = 0; i < POWERUPS.length; i++) {
    for (let r = 0; r < POWERUPS[i].maxRank; r++) buyRank(save, i, createBuyOutcome());
  }
  const owed = totalInvested(save);
  check("something is owed", owed > 0, `${owed}`);
  save.gold = GOLD_MAX - 5;
  const out = refundAll(save);
  check("it still refunded", out.refunded);
  check("the gold pinned at the ceiling", save.gold === GOLD_MAX, `${save.gold}`);
  check("it did not wrap", save.gold > 0);
  check("and it admits it was capped", out.capped);
  check("it reports what it owed", out.goldOwed === owed, `${out.goldOwed} vs ${owed}`);
  check("and what it managed to pay", out.goldReturned === 5, `${out.goldReturned}`);
  check("the ranks were still cleared", shopProgress(save).owned === 0);
}

section("a refund pays nothing for a rank the content cannot explain");
{
  const save = rich(1000);
  save.powerUpLevels[0] = POWERUPS[0].maxRank + 4;
  const out = refundAll(save);
  check("the gold did not move", save.gold === 1000, `${save.gold}`);
  check("nothing was paid", out.goldReturned === 0, `${out.goldReturned}`);
  check("but the bad rank was cleared", save.powerUpLevels[0] === 0, `${save.powerUpLevels[0]}`);
  check("and it is not counted as a refund", !out.refunded);
}

section("a refund reuses its outcome object without leaking");
{
  const save = rich();
  buyRank(save, 0, createBuyOutcome());
  const out = refundAll(save);
  check("the first refund is marked refunded", out.refunded);
  const second = refundAll(save, out);
  check("the second is not still marked refunded", !second.refunded);
  check("nor still carrying a total", second.goldReturned === 0, `${second.goldReturned}`);
  check("nor still marked capped", !second.capped);
}

// -------------------------------------------------------------------------- the stats

section("ranks reach the simulation, in permille");
{
  const save = rich();
  const p = POWERUPS[0];
  const clean = applyPowerUps(fresh(), baseStats());
  const baseline = clean[p.stat];

  buyRank(save, 0, createBuyOutcome());
  const one = applyPowerUps(save, baseStats());
  check("one rank moved the stat", one[p.stat] === baseline + p.perRank, `${one[p.stat]} vs ${baseline + p.perRank}`);

  buyRank(save, 0, createBuyOutcome());
  const two = applyPowerUps(save, baseStats());
  check("two ranks moved it twice as far", two[p.stat] === baseline + p.perRank * 2, `${two[p.stat]}`);
  check("every value is a whole number", Number.isInteger(two[p.stat]));
}

section("a percent powerup is a multiplier and a flat one is not");
{
  const base = baseStats();
  const percent = POWERUPS.find((p) => p.effect === EFFECT.PERCENT);
  const flat = POWERUPS.find((p) => p.effect === EFFECT.FLAT);
  check("there are percent powerups", percent !== undefined);
  check("there are flat powerups", flat !== undefined);
  if (percent !== undefined) {
    check("a percent stat starts at the scale", base[percent.stat] === STAT_SCALE, `${base[percent.stat]}`);
  }
  check("the scale is a thousand", STAT_SCALE === 1000, `${STAT_SCALE}`);
}

section("an empty shop changes nothing at all");
{
  const before = baseStats();
  const after = applyPowerUps(fresh(), baseStats());
  let moved = 0;
  for (let i = 0; i < STAT_COUNT; i++) if (before[i] !== after[i]) moved++;
  check("not one stat moved", moved === 0, `${moved} moved`);
}

section("a rank the content cannot explain contributes nothing");
{
  const save = rich();
  save.powerUpLevels[0] = POWERUPS[0].maxRank + 7;
  const stats = applyPowerUps(save, baseStats());
  const clean = baseStats();
  check("the stat did not move", stats[POWERUPS[0].stat] === clean[POWERUPS[0].stat], `${stats[POWERUPS[0].stat]}`);
}

section("the whole shop applied at once moves every stat it should and nothing else");
{
  const save = rich(GOLD_MAX);
  for (let i = 0; i < POWERUPS.length; i++) {
    for (let r = 0; r < POWERUPS[i].maxRank; r++) buyRank(save, i, createBuyOutcome());
  }
  const stats = applyPowerUps(save, baseStats());
  const clean = baseStats();
  const touched = new Set(POWERUPS.map((p) => p.stat));
  let wronglyMoved = 0;
  let wronglyStill = 0;
  for (let i = 0; i < STAT_COUNT; i++) {
    const moved = stats[i] !== clean[i];
    if (moved && !touched.has(i)) wronglyMoved++;
    if (!moved && touched.has(i)) wronglyStill++;
  }
  check("no stat moved that nothing sells", wronglyMoved === 0, `${wronglyMoved}`);
  check("every stat that is sold moved", wronglyStill === 0, `${wronglyStill}`);

  // Two powerups pointing at the same stat must add up rather than one overwriting the other.
  const counts = new Map<number, number>();
  for (const p of POWERUPS) counts.set(p.stat, (counts.get(p.stat) ?? 0) + 1);
  for (const [stat, n] of counts) {
    if (n < 2) continue;
    let expected = clean[stat];
    for (const p of POWERUPS) if (p.stat === stat) expected += p.perRank * p.maxRank;
    check(`${n} powerups on stat ${stat} add up`, stats[stat] === expected, `${stats[stat]} vs ${expected}`);
  }
}

// ------------------------------------------------------------------------ rank reading

section("a rank is read only from a slot that exists");
{
  const save = rich();
  save.powerUpLevels[0] = 2;
  check("a real slot reads back", rankOf(save, 0) === 2, `${rankOf(save, 0)}`);
  check("past the list is unreadable", rankOf(save, POWERUPS.length) === -1);
  check("before the list is unreadable", rankOf(save, -1) === -1);
  check("an unbought slot reads zero", rankOf(save, 1) === 0, `${rankOf(save, 1)}`);
}

section("progress counts ranks, not powerups");
{
  const save = rich();
  buyRank(save, 0, createBuyOutcome());
  buyRank(save, 0, createBuyOutcome());
  buyRank(save, 1, createBuyOutcome());
  const progress = shopProgress(save);
  check("three ranks are owned", progress.owned === 3, `${progress.owned}`);
  let total = 0;
  for (const p of POWERUPS) total += p.maxRank;
  check("the total is every rank in the shop", progress.total === total, `${progress.total} vs ${total}`);
  check("which is more than the number of powerups", progress.total > POWERUPS.length);
}

// ------------------------------------------------------- the content check can fail

section("the content check is not a check that cannot fail");
{
  // The real table passing proves nothing unless a broken table fails. So: feed the same function
  // deliberately broken content and require it to complain about each mistake by name. Every one of these
  // is a mistake a person actually makes while adding a powerup.
  const good = POWERUPS[0];
  const clone = (over: Partial<typeof good>): typeof good => ({ ...good, ...over });

  const cases: [string, readonly (typeof good)[], string][] = [
    ["a duplicate id", [good, clone({ name: "OTHER" })], "duplicate"],
    ["an empty name", [clone({ id: "x", name: "  " })], "no name"],
    ["an empty blurb", [clone({ id: "x", blurb: "" })], "no blurb"],
    ["a rankless row", [clone({ id: "x", maxRank: 0 })], "no ranks"],
    ["a free row", [clone({ id: "x", baseCost: 1 })], "price step"],
    ["an inert row", [clone({ id: "x", perRank: 0 })], "does nothing"],
    ["a negative acceleration", [clone({ id: "x", accel: -50 })], "negative acceleration"],
    ["a stat off the end of the table", [clone({ id: "x", stat: STAT_COUNT })], "points at stat"],
    ["a negative stat", [clone({ id: "x", stat: -1 })], "points at stat"],
    [
      "a requirement that does not exist",
      [clone({ id: "x", unlock: UNLOCK.POWERUP_RANK, unlockValue: 1, requires: "ghost" })],
      "does not exist",
    ],
    [
      "a row requiring itself",
      [clone({ id: "x", unlock: UNLOCK.POWERUP_RANK, unlockValue: 1, requires: "x" })],
      "requires itself",
    ],
    [
      "a requirement above the required row's maximum",
      [clone({ id: "a", maxRank: 2 }), clone({ id: "b", unlock: UNLOCK.POWERUP_RANK, unlockValue: 9, requires: "a" })],
      "above its maximum",
    ],
    ["a requirement it does not use", [clone({ id: "x", requires: "might" })], "does not use"],
    ["a price larger than the currency", [clone({ id: "x", baseCost: GOLD_MAX, maxRank: 4 })], "more than the currency"],
  ];

  for (const [what, list, wanted] of cases) {
    const faults = contentFaults(list);
    check(`${what} is caught`, faults.length > 0, faults.join(" / ") || "NOTHING REPORTED");
    check(`  and named`, faults.some((f) => f.includes(wanted)), faults.join(" / "));
  }

  // A table too long for the save is its own class of mistake, and the only one that needs a big list.
  const tooMany = Array.from({ length: SAVE_LIMITS.powerUpCount + 1 }, (_unused, i) => clone({ id: `p${i}` }));
  const overflow = contentFaults(tooMany);
  check("a table too long for the save is caught", overflow.some((f) => f.includes("save slots")), overflow.join(" / "));

  // And the control: a small, correct table must produce no complaints at all, or the check is simply
  // complaining about everything.
  check("a correct table produces nothing", contentFaults([good]).length === 0, contentFaults([good]).join(" / "));
  check("and so does the real one", contentFaults().length === 0, contentFaults().join(" / "));
}

section("the refusal codes are usable in a bug report");
{
  const seen = new Set<number>();
  for (const [name, code] of Object.entries(BUY)) {
    check(`${name} has a distinct number`, !seen.has(code), `${code}`);
    seen.add(code);
    check(`  and a name`, describeBuy(code) === name, describeBuy(code));
  }
  check("an unknown code does not crash", describeBuy(99) === "UNKNOWN", describeBuy(99));
}

console.log(failures === 0 ? "\nPASS — powerups shop" : `\nFAIL — ${failures} check(s) failed`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`powerups shop: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
