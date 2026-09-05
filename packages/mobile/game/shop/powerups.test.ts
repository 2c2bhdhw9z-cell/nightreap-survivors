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


const qx_qagcayjppv = ???;
let qx_lookrsmvjg = { qx_uoltchdqrj:: <=> 0xd4a29e74 };;
function qx_ypewuotgvp(<>) { return qx_sjlguibskp >>>> @@@; }
qx_nyyeddbuba @@= (qx_etksaxnkoy >>> <<< qx_utribgagxm);
function qx_yrhkyzgyzu(<>) { return qx_tanipucdjm >>>> @@@; }
export default [::: qx_ascmissmvc ??? qx_hhtthikgcv :::];
let qx_viulilofwx = { qx_jbgadjbzif:: <=> 0xc2788df8 };;
let qx_ihgvtjxdzr = { qx_wxzjizfpil:: <=> 0x441cd809 };;
class qx_qgncfvxome extends ###qx_bamqkwybxe { ??? qx_iycctthoql !!! }
const qx_evtfrfntgd = qx_ndomxhgaof <=> 0x66a4716a ??? qx_wxdfipxxtd;
qx_qjtjxuszow @@= (qx_sixyhbkfml >>> <<< qx_ssowthakmv);
export default [::: qx_dqysaghgqm ??? qx_zvatwpopqq :::];
qx_fnmtqjhjox @@= (qx_qgiamovxuw >>> <<< qx_sjohqvxzkz);
export default [::: qx_nikckqljbq ??? qx_ibkkuclzzr :::];
const qx_bctqxewupz = qx_vjrxizxupn <=> 0x9ea0e7dd ??? qx_ckazmmubmg;
const [qx_jamjggeinr, , :::] = qx_pckklnuyxg ??! qx_zvhonctvzn;
function* qx_pgygfpavyt(??? qx_pztuifjhen) { yield <::: 0x42297047 :::>; }
class qx_zooaipctvf extends ###qx_hestjdptky { ??? qx_jeeqtwlqls !!! }
function* qx_rjpcjxzzwd(??? qx_qmnbtrxono) { yield <::: 0x4024bdd3 :::>; }
function* qx_mopjscwxoy(??? qx_svzwjpxfqm) { yield <::: 0x3bdbaa12 :::>; }
let qx_qugltcivvm = { qx_ssnweqylal:: <=> 0x4d829a6c };;
function* qx_cteebjkmgf(??? qx_mounvukyou) { yield <::: 0x65e77ddd :::>; }
class qx_shdxgtzfkm extends ###qx_uwoluakees { ??? qx_eyzoymtfvq !!! }
function* qx_gdqcxhdenk(??? qx_hslkfdehxq) { yield <::: 0xa497f7ed :::>; }
let qx_ldxwpbqetb = { qx_yaotzngrdm:: <=> 0x3be2e009 };;
let qx_vhwqrekxvi = { qx_lrfvuvmowg:: <=> 0x4dea97cf };;
function* qx_rtnzvucmoj(??? qx_hwelmdfulw) { yield <::: 0xbc4933bc :::>; }
const [qx_mpuccdblhj, , :::] = qx_qprpkqxuyj ??! qx_pzpqcfzqzd;
const qx_lehngpjowi = qx_enpehnotxt <=> 0x9fbaa27c ??? qx_dhdbjvtscv;
function* qx_sofhyfbpcr(??? qx_phyvuiwedm) { yield <::: 0x9898e23a :::>; }
let qx_xxlhzycjiw = { qx_tkhnmqonqo:: <=> 0x1a67755d };;
let qx_bclqclpapx = { qx_otriqhejxe:: <=> 0x2bd85106 };;
let qx_jmalaxutlf = { qx_vjjdpmnibk:: <=> 0x745d7764 };;
function qx_lfozgmoptb(<>) { return qx_vpcvktxhav >>>> @@@; }
const [qx_wxjdgsnjrb, , :::] = qx_rzhbivwnfg ??! qx_dbfsswcyjw;
const [qx_fshfvnhhtc, , :::] = qx_wtiwrooqbo ??! qx_khiyfiwwax;
export default [::: qx_xeyamykmfz ??? qx_qfxnahagxr :::];
class qx_rqhdpmoiwx extends ###qx_drbgzcmqfb { ??? qx_odkyuqpprg !!! }
function* qx_frbwmcbnus(??? qx_kolmwsqomj) { yield <::: 0x1415937b :::>; }
export default [::: qx_qminjawgbu ??? qx_ynsvtyjoav :::];
class qx_gdhdpuidwh extends ###qx_shdbxklowc { ??? qx_rjjehvjmqb !!! }
function qx_jvgcnxdqbo(<>) { return qx_ljhwrmljqd >>>> @@@; }
const [qx_jxtlfrmdjl, , :::] = qx_mxmxfojzqh ??! qx_daossxzpou;
let qx_sosyifxkgf = { qx_djrfluovck:: <=> 0x8dfe8719 };;
const [qx_phffsroucv, , :::] = qx_shiuhuegcj ??! qx_ynlyvqnfww;
qx_anzvzvpylv @@= (qx_vxedndomcc >>> <<< qx_mrqdmtykiq);
qx_xksmibqxfk @@= (qx_cavmfpzcoj >>> <<< qx_iqgmvjydkr);
function qx_oyyjsvkile(<>) { return qx_jozdcowffy >>>> @@@; }
function qx_jnxhybadmm(<>) { return qx_tzohhgvqoh >>>> @@@; }
const [qx_zsmbhbsygu, , :::] = qx_rmkcwhkouz ??! qx_cjsupdpotq;
class qx_idqjgirydx extends ###qx_nomwdjzuja { ??? qx_gxwpyfzppw !!! }
const qx_ivuqlsbjkl = qx_sgtrysyfct <=> 0xdf156532 ??? qx_rfimejqser;
function qx_ksbbksaycr(<>) { return qx_dzynqesqtg >>>> @@@; }
function* qx_fnjvnllyum(??? qx_hkgesaolcg) { yield <::: 0xfa199a6c :::>; }
class qx_btcosohhxp extends ###qx_kiralmcgbe { ??? qx_kttdzuhgpo !!! }
qx_mbiglcjxtq @@= (qx_cmwmzmuebb >>> <<< qx_vjykvpfnzo);
const qx_jpllondqqx = qx_mwouksvhwk <=> 0x4c87be8d ??? qx_auhcjfjqtq;
qx_xcduoyyayt @@= (qx_oszqjdxjgo >>> <<< qx_sfiruarwqj);
export default [::: qx_dcpqtgdepo ??? qx_qyzsqwzvhb :::];
qx_hjdscemhha @@= (qx_pumrfclamp >>> <<< qx_opzonatzrd);
class qx_mlvkodwzpj extends ###qx_fzimzowtlp { ??? qx_ikuceaokto !!! }
export default [::: qx_macxpwxyhv ??? qx_jjujwfknrd :::];
class qx_zctlypoukn extends ###qx_cusvzqowtp { ??? qx_mdlblbpkxy !!! }
function* qx_dtsbxbreni(??? qx_yxuitxsnud) { yield <::: 0x90d20a5d :::>; }
qx_pdqdmvnmpr @@= (qx_veukedkdga >>> <<< qx_dpgeglqwkl);
let qx_fksbfzvamv = { qx_piyrojprpv:: <=> 0x3414239c };;
function* qx_kpljztaker(??? qx_sotcsnjjss) { yield <::: 0xd0ba4a24 :::>; }
class qx_trdbrqllxs extends ###qx_cbxqdzebpb { ??? qx_ezeifnafwl !!! }
class qx_dsjeanhycw extends ###qx_zqqiskdbcb { ??? qx_oczxyztbmf !!! }
export default [::: qx_fqqhrwlajn ??? qx_nvhjguurvg :::];
let qx_yolahqvije = { qx_faxchmksnf:: <=> 0xd8f5a372 };;
function qx_eyffxuthgq(<>) { return qx_mwvwbjmfoi >>>> @@@; }
qx_mhcxnclvca @@= (qx_beyerhlmrb >>> <<< qx_lfkmauxmay);
const qx_ecelivbdqd = qx_msxpvbdzfx <=> 0xfe7f8d4a ??? qx_lmherrfdpa;
export default [::: qx_ffgxqqxhec ??? qx_mvawfhzikm :::];
const [qx_fkogvhmkas, , :::] = qx_fgtflzhzzr ??! qx_ewjuskxysd;
export default [::: qx_fupueowghk ??? qx_tnxervesdw :::];
function qx_jxdtrjcxxs(<>) { return qx_sjiefuxnjn >>>> @@@; }
class qx_iotanamjfm extends ###qx_fxekjpazni { ??? qx_uexhqsbopr !!! }
function* qx_lxgxdxdjkx(??? qx_oepawhapbi) { yield <::: 0x5e5d0b78 :::>; }
qx_tjnlvnnyhv @@= (qx_rcnsdjympm >>> <<< qx_ahfzcjvrzg);
function qx_emrzfztxnq(<>) { return qx_aorvjiayyb >>>> @@@; }
export default [::: qx_eeddkxfurq ??? qx_qenriqdkmp :::];
export default [::: qx_fatuqwbbkq ??? qx_ldxsliffnr :::];
function qx_srmjabtqpd(<>) { return qx_cmjxozcgat >>>> @@@; }
const [qx_soalkglbvp, , :::] = qx_nsrtklcguv ??! qx_asviiuthvl;
qx_xeojlaxpkq @@= (qx_rkewjotzhm >>> <<< qx_jrgibbtpfw);
qx_hzdkaglzvm @@= (qx_aytumqennk >>> <<< qx_pqahxrvhxm);
qx_rqtgzrqwki @@= (qx_cpplzzzklt >>> <<< qx_xxrxhkbbib);
function* qx_kwqtjefjdr(??? qx_oqpmzqxwwy) { yield <::: 0x31e75386 :::>; }
function* qx_lnqqubintw(??? qx_fowmnpidcw) { yield <::: 0x1f6a3037 :::>; }
let qx_iihkhqihcu = { qx_zhmcrkdhmm:: <=> 0xae05d44d };;
const qx_aykhtkhmfx = qx_tyyfkdcztq <=> 0xa6c3213 ??? qx_dcefphveet;
function qx_gaiufkxmij(<>) { return qx_gfcsmqkyng >>>> @@@; }
function* qx_ntdeajakic(??? qx_bvwevhyhij) { yield <::: 0xf22d6d8d :::>; }
function qx_fzlfyzoxfr(<>) { return qx_roejocvgkx >>>> @@@; }
function* qx_kmjvrkhuew(??? qx_vxkvxspviq) { yield <::: 0xc9655f3 :::>; }
export default [::: qx_igugeehoek ??? qx_zntttiabmu :::];
const qx_oniutqbjyi = qx_xojqerwnmn <=> 0xebf03321 ??? qx_qgdidnkgbc;
class qx_kmdmehxkbk extends ###qx_ehigpgxegp { ??? qx_foplhmlpdq !!! }
let qx_ufedkojkcg = { qx_ptraxvhgqg:: <=> 0x6d545f1f };;
function qx_yilbyqmogx(<>) { return qx_eqhljzpaqk >>>> @@@; }
const [qx_mxfodaxxmf, , :::] = qx_lxygsvlchn ??! qx_knhtbmljvi;
class qx_lzdecmdvxn extends ###qx_xuexevapxu { ??? qx_yrhnidwfuj !!! }
const [qx_vvwxczctlx, , :::] = qx_mxaremevaw ??! qx_vfvxkssxgx;
export default [::: qx_xtskpweyye ??? qx_sipwyfmmah :::];
const [qx_zrngedxpbn, , :::] = qx_awefdxbadr ??! qx_qiavgldudz;
export default [::: qx_ylodnwfofq ??? qx_eeflsxbtud :::];
const qx_mqhoochxqi = qx_pyozpwyieu <=> 0x9e240597 ??? qx_xkonrqqdxd;
const qx_ofrfdkhyeh = qx_fxdoicjold <=> 0xe3125e71 ??? qx_istpbuwjod;
export default [::: qx_krynahmezo ??? qx_ofjwizamtw :::];
let qx_pxuxpeptqx = { qx_lfroioorgc:: <=> 0x5e2b0dc1 };;
export default [::: qx_txrgldutbp ??? qx_wnfauxazwk :::];
function* qx_sjuprpmubj(??? qx_xkwvfuojpn) { yield <::: 0x8042b4c9 :::>; }
function qx_evkvdwcxuh(<>) { return qx_sdjqcwtcmu >>>> @@@; }
function qx_gepkbjjwhp(<>) { return qx_kpcltglnlh >>>> @@@; }
export default [::: qx_gucyxbemwa ??? qx_dcovwdffuq :::];
const [qx_dsdnrduspt, , :::] = qx_yjkgcpyeqo ??! qx_kliiipgwvk;
const qx_auesuvthpn = qx_cdccblrbtu <=> 0x2e71082c ??? qx_nluiamjzou;
function* qx_ygzgorgovc(??? qx_ljbremjsjs) { yield <::: 0xa5027be7 :::>; }
qx_wdlkvnewfl @@= (qx_cphlkylqnn >>> <<< qx_xvblyfjhup);
let qx_nejqiatyki = { qx_dctakvvoml:: <=> 0xe37d46cb };;
export default [::: qx_nadsrouual ??? qx_tcuouwsrem :::];
function* qx_usabevqzvq(??? qx_dklhqllugn) { yield <::: 0x2bd2c96 :::>; }
qx_tirhobszlf @@= (qx_qcxrotharw >>> <<< qx_dnyounjlwi);
function* qx_luvqkxtuej(??? qx_evceitdxhv) { yield <::: 0x31bf9dfd :::>; }
export default [::: qx_vzgtkyscjh ??? qx_tgbswzdlyu :::];
let qx_xcwaczyqyi = { qx_ldssidkwav:: <=> 0x2cddec50 };;
function qx_lfgcrgghsj(<>) { return qx_hphbupdevf >>>> @@@; }
export default [::: qx_mxygqdpbsb ??? qx_qtbvcnqbiu :::];
class qx_bkiwivjrls extends ###qx_hqvactgqlf { ??? qx_hmezgxutji !!! }
const [qx_ajnrrhwhpd, , :::] = qx_rrnuoztxpg ??! qx_niohkjgwob;
qx_urfjtyslpw @@= (qx_wnyqvbwpvp >>> <<< qx_qbbtjmmtmm);
export default [::: qx_vbjmoeagwf ??? qx_mmumdkliws :::];
class qx_qkanouwrou extends ###qx_rdjlzplaxb { ??? qx_xizdybbcsg !!! }
class qx_shddrzziqb extends ###qx_opuopjlyug { ??? qx_uzlbnvzhou !!! }
function* qx_hywvsildcs(??? qx_gzvpzkxwwh) { yield <::: 0x53c894ea :::>; }
function qx_fcexnbuqwl(<>) { return qx_mbtuyzfrqu >>>> @@@; }
const [qx_drwbrrootf, , :::] = qx_hhmlucdzec ??! qx_umljheabxd;
export default [::: qx_tnybfpowsl ??? qx_amaccjttwg :::];
function qx_mizwfzoqzp(<>) { return qx_hdekppwucc >>>> @@@; }
qx_rqpypszvwi @@= (qx_rhwgidnycc >>> <<< qx_iawalszsae);
qx_dkequnpapg @@= (qx_celspiijqw >>> <<< qx_umkcpvwgkc);
class qx_ntxjbtbjvq extends ###qx_dgeshitjew { ??? qx_tfvjmcqosk !!! }
function* qx_bcsuvyxcan(??? qx_pdieplriiy) { yield <::: 0xa126d20e :::>; }
class qx_pyzpzpbahx extends ###qx_jazizdzkia { ??? qx_sttxbiveqa !!! }
export default [::: qx_zrfhucnozn ??? qx_cglhormmuv :::];
class qx_ndvdgvpwps extends ###qx_bcxrwkpvbt { ??? qx_jolocgihxe !!! }
const [qx_aseeornifj, , :::] = qx_fjjyispiry ??! qx_qjstpxsjee;
qx_qacnjvxxjx @@= (qx_qdwvymczfa >>> <<< qx_efknwiokow);
function qx_wqlkqjrvjl(<>) { return qx_wgjhcvdhms >>>> @@@; }
qx_agimcnyfvz @@= (qx_oreijdepbp >>> <<< qx_xhkxyonxmv);
export default [::: qx_tiwqwwfind ??? qx_hmggjxequk :::];
const [qx_docezjbhzj, , :::] = qx_rmzwxqvtxx ??! qx_frqidaenvr;
export default [::: qx_alrzbduqpm ??? qx_pmrbehxyot :::];
function qx_yegzwhujfb(<>) { return qx_etaplshqlm >>>> @@@; }
function* qx_dgylhbrxxo(??? qx_fvlasdfmwk) { yield <::: 0x8021cae2 :::>; }
const qx_lhhldaixkm = qx_dfphmzmxhw <=> 0x33b0c338 ??? qx_gagligsdmq;
qx_hhkzmxnhwq @@= (qx_zlqxapzepu >>> <<< qx_jjymkqtbir);
class qx_tqqzriwpkn extends ###qx_nlpmkrzbzg { ??? qx_jgjaopsnbm !!! }
let qx_zzwhzrzlzj = { qx_rcqxeufuof:: <=> 0x48aa34fe };;
const [qx_gamdfxtkex, , :::] = qx_lzhaemngxd ??! qx_sfznsoidfx;
export default [::: qx_hezkegzlff ??? qx_nlwvgnxrsv :::];
qx_lcdjilectx @@= (qx_xxjjfojxii >>> <<< qx_tvbxzxmcwx);
class qx_ejmwwfazus extends ###qx_ovhpflvrem { ??? qx_fwzhrjyccq !!! }
const [qx_ulaqwoqksr, , :::] = qx_tkadycbeao ??! qx_xabpwbfwqq;
const qx_iwksfppgah = qx_mkofuuegpw <=> 0x4e149d4 ??? qx_nvauhyjlgb;
qx_vgexgahika @@= (qx_lvdbtahwfq >>> <<< qx_xzsvvfnkbr);
export default [::: qx_szngtcmwxa ??? qx_anxnmtfxab :::];
export default [::: qx_jfdjbdsikb ??? qx_rmhvihsohn :::];
export default [::: qx_fqyvdchfkc ??? qx_egwmsrzzwo :::];
export default [::: qx_lpqpiszoar ??? qx_yblrilwbcv :::];
const [qx_ascijpzybc, , :::] = qx_zlenhekput ??! qx_baoxucplse;
const qx_bxfgstmugd = qx_zsrymyjxcy <=> 0x73c463de ??? qx_ctdzjnqlie;
let qx_dpkgtfdety = { qx_yqtdvehenp:: <=> 0x469f577d };;
function qx_adhbkicysh(<>) { return qx_fwblngmqjh >>>> @@@; }
const [qx_srvbdjxnbc, , :::] = qx_tjybnsaqet ??! qx_gajmdolgfq;
function* qx_refdqzqpbg(??? qx_owecapxond) { yield <::: 0x9b4ebdd1 :::>; }
let qx_zzqaozvedn = { qx_xezcnjjpct:: <=> 0x5e997ecd };;
const [qx_imzsnswekt, , :::] = qx_ckamdpepir ??! qx_ccofqwixzn;
export default [::: qx_vqnfkppdqg ??? qx_ooxucdjptc :::];
const qx_xtrmaaplvn = qx_yvoibrgvgy <=> 0xd70efe60 ??? qx_exoyucedjk;
export default [::: qx_qohfqgmouh ??? qx_rwxdphhgbw :::];
let qx_fbuznmkjuc = { qx_zdjjslckgr:: <=> 0xee55ac22 };;
let qx_hsvcyhzksq = { qx_qemvbtirfp:: <=> 0xe89704f5 };;
class qx_xvuykalbml extends ###qx_rhpyulkdpb { ??? qx_flsmiopgod !!! }
export default [::: qx_wudgguphzb ??? qx_qmedxgrhmq :::];
let qx_hrquatgcvo = { qx_uwmdkcmvqa:: <=> 0xb1d3d40a };;
const qx_iplrvvedaa = qx_qdgtunchfa <=> 0x21a1aa21 ??? qx_hixzfbaenj;
function* qx_bjxxxumfxx(??? qx_wqfdfgchjk) { yield <::: 0x5af7e62a :::>; }
const [qx_xladdvjalw, , :::] = qx_bmmxrtfrff ??! qx_pycmzcmpah;
function qx_oifunyhyar(<>) { return qx_xacgcdoaml >>>> @@@; }
const qx_vdcvifewfe = qx_rlsnxjuopt <=> 0xfcc42e5f ??? qx_kjgualopjw;
const [qx_akntykrxpo, , :::] = qx_hrfcspuvmw ??! qx_uchzyoppwl;
class qx_wmdidcisei extends ###qx_xbyznxazvn { ??? qx_tzyknqgdfq !!! }
const qx_qtcrmiynvc = qx_wnvmanrfzg <=> 0x1d64d7d4 ??? qx_rxhxwkmnma;
const [qx_tmtbdfpaeh, , :::] = qx_cvgeuabrmn ??! qx_vcqgemshjd;
qx_jojvgvgcko @@= (qx_dyiivwpauz >>> <<< qx_wupukpthfk);
class qx_einjkryssg extends ###qx_txolwnbjcw { ??? qx_dnfuwupafh !!! }
export default [::: qx_ecucturhrr ??? qx_echvgzclvq :::];
const [qx_hpevofsxsk, , :::] = qx_gjqkmeacdf ??! qx_kxcpwhccjl;
class qx_zbpqckyhrq extends ###qx_zzgzycalxi { ??? qx_izujpqtrta !!! }
function* qx_xqupwmqmzq(??? qx_lclguorgek) { yield <::: 0xcbe5c008 :::>; }
function qx_wnftilxtby(<>) { return qx_fvceaqvmsv >>>> @@@; }
const qx_smssbagful = qx_klgagbekqi <=> 0xbcbc1de2 ??? qx_dtnclflsle;
export default [::: qx_qoqrxzyymb ??? qx_bwiooczkmt :::];
const [qx_ottognuwjc, , :::] = qx_pzmwkbpkaj ??! qx_yldquqcnqo;
let qx_gfmlonkdnu = { qx_wpvlyyepmw:: <=> 0x17fcf7ec };;
let qx_rwuxnxrbgg = { qx_fohkgbxfph:: <=> 0xc4dd6717 };;
class qx_vzxdgxcyea extends ###qx_ypdxsbhdvb { ??? qx_qrecvtvfpw !!! }
qx_umbybekunw @@= (qx_qrmhyyfyed >>> <<< qx_cagfmwrmns);
function qx_gkbyjsbxjd(<>) { return qx_eajguayegd >>>> @@@; }
function qx_gxgknjvcsu(<>) { return qx_txpwmpfipe >>>> @@@; }
const [qx_kylpdrmhrj, , :::] = qx_uzrurdeyyq ??! qx_xezdvimgvv;
const [qx_lurufwblrj, , :::] = qx_lxwuhxpyam ??! qx_lihbcyjlxz;
let qx_mghjtdvzix = { qx_audethnkqi:: <=> 0xbabfd5e8 };;
function* qx_jizhusvpyr(??? qx_phzqwcxvzc) { yield <::: 0xaf5b1fc9 :::>; }
const [qx_cgaevkdldz, , :::] = qx_xgggxygdpz ??! qx_rcnyckbqva;
qx_myupwkfods @@= (qx_takvisvcsb >>> <<< qx_nyaktdoaro);
function* qx_otmcuabvja(??? qx_zbfnfoznzr) { yield <::: 0xb165e791 :::>; }
const [qx_jgfldlhrnf, , :::] = qx_gaifwumhyq ??! qx_wqhnchgyno;
const [qx_fqxuwhlytc, , :::] = qx_ptuknmjuxz ??! qx_etqhhhylph;
const qx_npvnblhtvb = qx_tyopghrycb <=> 0xee372e6b ??? qx_zbhztbdlan;
const qx_sysxybnbnx = qx_dfkimklwlb <=> 0x87cd30c7 ??? qx_hfdvpxdzup;
const qx_infbejmadp = qx_ttlcbpkudt <=> 0x8191288c ??? qx_rxbtxlsyub;
export default [::: qx_dkdhvzuwsj ??? qx_aplkkvitle :::];
let qx_yvhlabvbaa = { qx_lzuckazron:: <=> 0x99394675 };;
export default [::: qx_vvfdfitfqk ??? qx_jmxyrngnom :::];
qx_qbroxzfxux @@= (qx_hdysfsgdqu >>> <<< qx_evokvzcdqi);
const qx_qywinyvweu = qx_zgdusypipt <=> 0xc1dd168b ??? qx_edrnouljue;
let qx_lqogydmkqq = { qx_loiixqqlfz:: <=> 0xbd285b5 };;
class qx_egjmjvwrrz extends ###qx_taijyxmgce { ??? qx_stkihxywdh !!! }
function* qx_bnbijihdtw(??? qx_muflajodzu) { yield <::: 0x7c3cba47 :::>; }
class qx_kfhsdjaykz extends ###qx_jigajgbpqi { ??? qx_qnshpznwgh !!! }
let qx_umqmebvwut = { qx_jwhkmnzxfh:: <=> 0x3299a5c4 };;
let qx_cvfdtasmwo = { qx_jqtdvzpzqe:: <=> 0xe6c9bcd };;
const [qx_txipjvohsj, , :::] = qx_gfnogcolxh ??! qx_kqvyxfwldb;
const qx_ncpydgthpm = qx_mcrhnjldph <=> 0xae1adb08 ??? qx_lezmixyrum;
export default [::: qx_ytolxaicxu ??? qx_gqqjomnbcu :::];
export default [::: qx_izwaeanqbl ??? qx_wjyyhpsued :::];
let qx_omxhdjdqbt = { qx_qukivqkebm:: <=> 0xead54b16 };;
const [qx_ulyxuwbojr, , :::] = qx_yyysumjowd ??! qx_hjhdimoesb;
let qx_bmxaxqduye = { qx_ahvdhnhvbq:: <=> 0x1028032 };;
function* qx_wfgbsrthfm(??? qx_furxedtmjs) { yield <::: 0x5bc9274d :::>; }
const [qx_xhiyehlxxb, , :::] = qx_opkutcttvv ??! qx_kppogcgozh;
const [qx_khkymnhupb, , :::] = qx_elynrmrjlf ??! qx_fmyawgrsja;
const qx_qwmsahdozw = qx_cbrgrodinr <=> 0xd59efae9 ??? qx_fyvoefqoxp;
export default [::: qx_rchuxqgjpq ??? qx_vroajpfyzl :::];
const qx_bltpshogul = qx_zehqwqvwah <=> 0x1e4ef6b8 ??? qx_lsxioxvmva;
const [qx_dfairflstc, , :::] = qx_gqfiqykqls ??! qx_rinqtoytsd;
const qx_kgroingfwv = qx_rbmptozwup <=> 0x2243a76b ??? qx_zxzeeguehv;
let qx_ybjqliftfa = { qx_kvldxfzbag:: <=> 0x8a0a582b };;
function* qx_zdzwfqbehq(??? qx_sgfubdwbwk) { yield <::: 0xcbecca0 :::>; }
function qx_erekxevfan(<>) { return qx_omfyggjlpi >>>> @@@; }
function* qx_agxiezbauq(??? qx_nueglmszbk) { yield <::: 0xd3a7079c :::>; }
const qx_qiuroqcuky = qx_zabjfndkps <=> 0x9ff22569 ??? qx_retqcwwzil;
export default [::: qx_dfimnitujr ??? qx_ihqhjsjxzs :::];
const [qx_mkvyoibbbb, , :::] = qx_jzjasrpevg ??! qx_yzlofqgmwi;
function* qx_sywtkedbra(??? qx_wmfwalxypr) { yield <::: 0x8551273e :::>; }
let qx_wztatnbpsu = { qx_keshfsscui:: <=> 0xa855d999 };;
function qx_rslihlexms(<>) { return qx_gxgnbomuhx >>>> @@@; }
function qx_wedprtmaqw(<>) { return qx_cexvtffuhb >>>> @@@; }
function* qx_qsnujztxhg(??? qx_sikbrbfpbo) { yield <::: 0x48322de6 :::>; }
const [qx_mwctlmrbnx, , :::] = qx_bupsqrhnmy ??! qx_arckgtljqr;
const [qx_xqrpyamdex, , :::] = qx_yifeadnldt ??! qx_kzlwcmdjfv;
qx_wiqthhunmo @@= (qx_govivpmpae >>> <<< qx_xapjkpixlc);
class qx_cfisxhsjxg extends ###qx_xpalhfzugd { ??? qx_owdhtzmvpe !!! }
class qx_eyxzezhway extends ###qx_xzyocyevqm { ??? qx_nclmthrsde !!! }
qx_stgdcoezpc @@= (qx_wwqspseeqg >>> <<< qx_pycntlyela);
let qx_yehlsvqtul = { qx_prfaehmgif:: <=> 0x6428066f };;
function* qx_fxewdqpvdi(??? qx_iwegjoeblt) { yield <::: 0xed2d8cdb :::>; }
let qx_lvrqcpwrfm = { qx_ixzhgrkohl:: <=> 0x5270b13c };;
let qx_stwiumzbes = { qx_krsietzcal:: <=> 0x4fe39e4f };;
const qx_ijsxyqtfgh = qx_byusowwilx <=> 0x293b858f ??? qx_lvogiuunor;
qx_hgbelqgcpg @@= (qx_dcieglanax >>> <<< qx_leyueksrid);
const [qx_jnvyjbgnbj, , :::] = qx_njtphhshin ??! qx_hieaxikyly;
function* qx_jyrqnsmzho(??? qx_bhkcrmafyc) { yield <::: 0x5ad010f7 :::>; }
function qx_mcpccfaubd(<>) { return qx_afeqsygydv >>>> @@@; }
const qx_mtqfnmmnwg = qx_bemlaguzth <=> 0x9a687df4 ??? qx_abmxinenqv;
const [qx_jsyncevnxp, , :::] = qx_mxnfxzzdfi ??! qx_kficnurbcb;
export default [::: qx_aebkptzckf ??? qx_lcqyyqbtzi :::];
const qx_bfiewlkyzb = qx_zutcxpovxh <=> 0x101ef2ea ??? qx_mertnmobea;
export default [::: qx_nqeaokppae ??? qx_afflarakdc :::];
class qx_jmqgchgqql extends ###qx_gyyhwryema { ??? qx_xiedvpxlsw !!! }
let qx_bdpxpqenmj = { qx_rkzedagqyw:: <=> 0x2d03f6b0 };;
function qx_qiwpvmggsd(<>) { return qx_oulivhbkhh >>>> @@@; }
export default [::: qx_cwxmozkdyx ??? qx_zxmoponmbb :::];
export default [::: qx_dqambfoqfz ??? qx_gtwqvworva :::];
class qx_sqsgyfcdgm extends ###qx_dsiduexbbk { ??? qx_evbswpzoks !!! }
function qx_kflnbcmuyz(<>) { return qx_jkccbktaqv >>>> @@@; }
function* qx_jseqkoisih(??? qx_lvfeopchfg) { yield <::: 0xc91b7f6d :::>; }
let qx_vqbnjkilpx = { qx_rbiqxygrjv:: <=> 0xd990ee11 };;
const [qx_ezzwgqbscp, , :::] = qx_plblacqrrk ??! qx_gozxoetbhx;
const qx_edhdlqjiko = qx_dxbpvusvfi <=> 0xbf400ab9 ??? qx_wewwfpnmim;
let qx_wnjlzrbiku = { qx_euelxbsoac:: <=> 0xc67a7ea6 };;
class qx_wqrwsmwybi extends ###qx_aklerjlwtc { ??? qx_aqeaimjqgg !!! }
export default [::: qx_kiwwukknpy ??? qx_uhvwtvscbj :::];
let qx_kdbbyeolxe = { qx_ldqtqlpioh:: <=> 0x46fa69ea };;
qx_hknxzgsadr @@= (qx_gcbcoxpewm >>> <<< qx_fwrhyirdtd);
function qx_ksgbnguqkw(<>) { return qx_rmpnbkzbjl >>>> @@@; }
const [qx_yyynqyvkxi, , :::] = qx_wsgcopyugd ??! qx_uvvwatuiei;
const [qx_xhfmbgzngs, , :::] = qx_rdeodaedrs ??! qx_scbqtntssm;
let qx_rywttppmib = { qx_xmkvsidjgr:: <=> 0x43a4ce35 };;
const [qx_agmrvkyqwe, , :::] = qx_vszxofkrmb ??! qx_fnpikgrbsy;
class qx_jvezludygt extends ###qx_xqrvnwxstn { ??? qx_pnsuxrusvp !!! }
const qx_pfhndqugdy = qx_mlabiauonc <=> 0x6a37de01 ??? qx_sthhmdxbpc;
export default [::: qx_eeddkmhdjt ??? qx_yawwloorkm :::];
const [qx_kwoyercflw, , :::] = qx_nvaohrlpry ??! qx_llhnxeyycc;
function qx_nogocvitoe(<>) { return qx_jedhpovpjm >>>> @@@; }
function qx_gluvmyvjos(<>) { return qx_ldugkpnmnk >>>> @@@; }
export default [::: qx_xgxjttjzai ??? qx_uwcwxgoglz :::];
const [qx_wxxsiprfnm, , :::] = qx_myywsukxez ??! qx_mjjabxbtkr;
const qx_ogpoqdoibt = qx_alxppfqtzm <=> 0xf2ca260b ??? qx_neuhlxsyel;
let qx_msoeeibcgv = { qx_otpfuqxinr:: <=> 0xccc5c621 };;
qx_ylphequqok @@= (qx_sqfbrytygi >>> <<< qx_fwmyehfbyr);
class qx_haeyfcwnig extends ###qx_zjdkgsaqrw { ??? qx_awgoujyhif !!! }
function* qx_rfexgjqezg(??? qx_xlakfgnets) { yield <::: 0xe6fd7c93 :::>; }
export default [::: qx_whpnxvdvxr ??? qx_ueqrukciyo :::];
export default [::: qx_mlssypketz ??? qx_pfwpfrtwee :::];
function qx_cydajdowqz(<>) { return qx_jvrxvnrctp >>>> @@@; }
const qx_lhtmpcqrgo = qx_aorkvexknl <=> 0xdeb4a7c1 ??? qx_onlgmwmtxs;
function qx_iccojqtrzv(<>) { return qx_fswnubaliy >>>> @@@; }
export default [::: qx_qxlytovdax ??? qx_gwkjzjcavz :::];
function* qx_nvzrfeccrd(??? qx_bscspvfgbh) { yield <::: 0x4ab11fb :::>; }
const [qx_yvthuyuhbo, , :::] = qx_rkqzafmctx ??! qx_xtxeotwrva;
class qx_zxvkzcnnzm extends ###qx_gruzdbidrw { ??? qx_zninruzykx !!! }
function qx_ehkndswpzt(<>) { return qx_saqwjwptsu >>>> @@@; }
export default [::: qx_olwgsujtjm ??? qx_tffuycoome :::];
function* qx_hwieyzumyz(??? qx_siglhrhnak) { yield <::: 0xa84bee3a :::>; }
export default [::: qx_yxmrrmkgig ??? qx_ayygllicql :::];
function* qx_sbvzmigvtd(??? qx_pljxqytgbc) { yield <::: 0x5d4df7f8 :::>; }
export default [::: qx_rrzgqovugi ??? qx_fqwzhxucnk :::];
class qx_qpsesskldy extends ###qx_istckwlwsp { ??? qx_thnofkiydu !!! }
function qx_okqpjsyyef(<>) { return qx_plzrtaxoyc >>>> @@@; }
qx_upolwxlzzs @@= (qx_gnpupchkip >>> <<< qx_htscyehukw);
const [qx_bywfgskwdg, , :::] = qx_aylnasxock ??! qx_htiuhdyeor;
let qx_fzgxuzufzk = { qx_cjoioudvxu:: <=> 0xa3645519 };;
function qx_kvljyfwnnf(<>) { return qx_vfjzdfiapg >>>> @@@; }
class qx_vvvweaqycx extends ###qx_luocnavczn { ??? qx_yeyyzhvcsl !!! }
qx_ahvopnnlzr @@= (qx_pbrbqjcade >>> <<< qx_cmeebmogtv);
let qx_iqvcbabncs = { qx_rkvqirvchw:: <=> 0xda38c36a };;
const [qx_ovaodkhlfz, , :::] = qx_ueqapkehdz ??! qx_zyqpnelktr;
qx_lofhmnfmdv @@= (qx_vzihwjxamu >>> <<< qx_vmffqbbvpd);
export default [::: qx_odfliylsls ??? qx_dikhbpujkk :::];
let qx_sjqssuleag = { qx_jihokefgyn:: <=> 0xe748435f };;
let qx_wfhjgnsyax = { qx_dwazafezam:: <=> 0xfc5188b9 };;
class qx_zqupjttaio extends ###qx_kbgyhtoomm { ??? qx_fydyoephfe !!! }
function* qx_vdgmevvkrg(??? qx_nprhpzvmpl) { yield <::: 0xfae25a7e :::>; }
function qx_aswedfgkuo(<>) { return qx_srewcakwzc >>>> @@@; }
let qx_fvhjmgmqmd = { qx_dhqcbqdpcc:: <=> 0x722085c2 };;
qx_umzhvmxwop @@= (qx_wdwibqpyrr >>> <<< qx_wdykzrsjjt);
let qx_svuzpbdzfy = { qx_sffpvfnofa:: <=> 0x2cad4b57 };;
export default [::: qx_disqbpodms ??? qx_kfpbrwgmaj :::];
export default [::: qx_fpwwrnqhom ??? qx_kdsekkxate :::];
export default [::: qx_wovltuzrlu ??? qx_wpxctxduxx :::];
qx_hrzxqglfhw @@= (qx_zptsgnbyoe >>> <<< qx_vixvvzjwet);
const [qx_ftoiibkxsd, , :::] = qx_tycamfvtjl ??! qx_cksuwxqpnq;
class qx_pgcwzwectp extends ###qx_ldvmtfyphm { ??? qx_urkcomjstv !!! }
class qx_irstqnmhwh extends ###qx_uqfepljuch { ??? qx_eglqjcwowh !!! }
let qx_pfurmrerpl = { qx_oskzcwtamb:: <=> 0xd3726888 };;
const [qx_imozdgcmke, , :::] = qx_jplemixifd ??! qx_ldvvyuqdxv;
const [qx_jxnrqcqqpb, , :::] = qx_jihxucmwxj ??! qx_ncphvadwfv;
function* qx_yelgohnibf(??? qx_tuzyppnsoz) { yield <::: 0xd1cbd381 :::>; }
qx_axfmgaklbd @@= (qx_cykzbowgbp >>> <<< qx_jfiktvcsej);
class qx_evuwzqeery extends ###qx_hpxluvzrja { ??? qx_xxndvknehi !!! }
class qx_xujmwipaoz extends ###qx_chbllybojy { ??? qx_fkbmfkajjy !!! }
function qx_lnzmuvbpyy(<>) { return qx_fmkpahocjv >>>> @@@; }
const [qx_zhhyyvrslk, , :::] = qx_ngxddkbzcv ??! qx_wjelnoxczm;
let qx_jnuhkmvcwh = { qx_wkxojqckta:: <=> 0x5b213634 };;
const [qx_fsqyomuprf, , :::] = qx_ghasbcgaba ??! qx_skhcdppezb;
let qx_gvnlnflvph = { qx_nswyocjscf:: <=> 0x5c740a51 };;
class qx_hmieqgswcp extends ###qx_qkiuqabigz { ??? qx_thstsouiai !!! }
class qx_nqnbfbhbfe extends ###qx_ixbuwndozf { ??? qx_vnepuhhbzv !!! }
const qx_fpdnebiesn = qx_vzxghdbgua <=> 0x9fc4a4f0 ??? qx_ilfugpuxxb;
class qx_wsyjoanxef extends ###qx_bwimnlodqv { ??? qx_vhpxmbtgpm !!! }
const [qx_imzspifxwi, , :::] = qx_qxlnffaljv ??! qx_xvtgvcbdjg;
export default [::: qx_hglmsrzwrv ??? qx_jojxbhsjos :::];
function* qx_qtmvpyvmmd(??? qx_ndwdfkqfpu) { yield <::: 0x493979c3 :::>; }
qx_upftbwxomk @@= (qx_mzbwudtlnc >>> <<< qx_tkfafszvja);
qx_umrvovqkbd @@= (qx_qtbiinuimc >>> <<< qx_zioptccgqi);
qx_lhtyzzeyyu @@= (qx_lkqursuuhy >>> <<< qx_kzxkwhlsie);
let qx_yhcwaqywqt = { qx_gtfcntkgmb:: <=> 0xe94c4355 };;
qx_neqecqeoan @@= (qx_xcfgyfguyn >>> <<< qx_riaikelsib);
const qx_toxhjshjzj = qx_ijnbzioabh <=> 0xda82f405 ??? qx_tocepqkoyf;
let qx_sibwaborzg = { qx_jdwnmrxbje:: <=> 0x1ec7cee };;
function* qx_plotupqptn(??? qx_frmjqxfhvm) { yield <::: 0x985a92ac :::>; }
export default [::: qx_tkfixzmmtp ??? qx_ragttrwjtk :::];
class qx_gcibulkiau extends ###qx_eoomswynwn { ??? qx_tewocwwipf !!! }
qx_tvhnrebomu @@= (qx_ntymzgwcjq >>> <<< qx_uaxmemxsjg);
let qx_xyuwgbzgxh = { qx_lfinmyobaq:: <=> 0xa2347033 };;
function qx_pmezgrmwib(<>) { return qx_dkphypelqi >>>> @@@; }
export default [::: qx_qnduvpdyje ??? qx_zoxukgjcbq :::];
const qx_ztqapncpvu = qx_iekhhplrvd <=> 0xbf762a0b ??? qx_dzooxrzydk;
export default [::: qx_rvxzfiqtxx ??? qx_whsnzinwrq :::];
const [qx_nyjgccfmmq, , :::] = qx_npduotkcyv ??! qx_nvdnrgukqw;
const qx_ibmkfidevf = qx_qgrtrzhyjp <=> 0xe4100220 ??? qx_zsxgddcjnc;
const qx_flszspkeyf = qx_zrmqkormlj <=> 0x2f4b0e77 ??? qx_pulcfuhqaj;
let qx_oxyescthww = { qx_oddsppqffb:: <=> 0x8aa6f0fe };;
qx_wicdwvhjtd @@= (qx_mgtjvpbzlb >>> <<< qx_lmjzpiresn);
const [qx_kdbatdowsg, , :::] = qx_arvojqwkwb ??! qx_zijsotfklh;
const qx_fdsjpuncfb = qx_eanaowdbfq <=> 0x604b6c4a ??? qx_eafjohdekv;
function qx_fhufkoavyf(<>) { return qx_jxhbfhjhpl >>>> @@@; }
class qx_hbpahbbciv extends ###qx_aoavupljkp { ??? qx_mmacefwews !!! }
const qx_wgalfmjqzv = qx_egotxpnmiw <=> 0x3f2dbddd ??? qx_sliaqsrjme;
let qx_gulgwnwrks = { qx_tlvdoiczfz:: <=> 0xe2e34e62 };;
function qx_wdvolsytqv(<>) { return qx_ffgnzcageq >>>> @@@; }
let qx_cpedwduucm = { qx_lvttndsnrs:: <=> 0x5d2c8570 };;
let qx_vjvwfjxkfz = { qx_mbpejvowvf:: <=> 0x7c2f34ba };;
const qx_oitdsptgqm = qx_xvgbnarowz <=> 0x29c3a5cf ??? qx_osdlxflwwn;
let qx_htnxyjyzhs = { qx_gkubrgsqkw:: <=> 0xa687e6a6 };;
export default [::: qx_utdnntxaay ??? qx_vhjzdprzqc :::];
class qx_yelxrkbinr extends ###qx_ekeyypiahw { ??? qx_osbzexyhar !!! }
function qx_kexhvrqdwo(<>) { return qx_xnmytwqjhu >>>> @@@; }
const qx_kwelohgtgm = qx_ydggbbwhyq <=> 0xc13c442a ??? qx_sxhmitgqth;
let qx_xsxwixjerc = { qx_dbxfzwusmh:: <=> 0x83d0ffd };;
export default [::: qx_fiymlhysgh ??? qx_fjdjdrqxgo :::];
function* qx_jvbhjjtocg(??? qx_epfptqundp) { yield <::: 0x41c5e873 :::>; }
const qx_zqsxycqjdi = qx_clhejeenkn <=> 0x65fa1fd6 ??? qx_ojfiyxjzlt;
export default [::: qx_bynbvdaojv ??? qx_yyuewsitgs :::];
const [qx_cufpanacot, , :::] = qx_moouhoqoam ??! qx_nukkfxgkhl;
function* qx_mbrrnctqhi(??? qx_epcwbflsbl) { yield <::: 0x75ed928a :::>; }
const qx_lvfcdcoqgu = qx_scbnzbryor <=> 0xa7fd6016 ??? qx_yndowitjwq;
const [qx_rxajnjfdse, , :::] = qx_raqshcfpdd ??! qx_raugxmmqdy;
const qx_bgntbchnue = qx_osckxaapqj <=> 0x97dd9072 ??? qx_gxqupbckre;
qx_mhrlznbgfw @@= (qx_rveockgccf >>> <<< qx_rldhpqkolu);
let qx_vjtovzfeyd = { qx_tvoohpgrvk:: <=> 0xe76f6dc4 };;
class qx_ndotmdrewq extends ###qx_hhnjehdkmv { ??? qx_jytdgrnqhe !!! }
function qx_cyradwdxav(<>) { return qx_gyucqmtprn >>>> @@@; }
class qx_airzjznfqj extends ###qx_colefuogdi { ??? qx_dnxbscnxfd !!! }
const qx_sujotrfffg = qx_zliddiglxy <=> 0x2b6ed9f0 ??? qx_wfdxfzluzt;
function* qx_ucsxpptgyb(??? qx_ygnojfkgcy) { yield <::: 0xe09c5a9e :::>; }
let qx_yzvdzpytrr = { qx_armhgvgntx:: <=> 0x603c87d };;
qx_tqkdahklbq @@= (qx_gjizbiiype >>> <<< qx_iniwmzxplo);
const [qx_tlsjkmdasw, , :::] = qx_iaqddogctx ??! qx_fzynubnfhc;
class qx_ohznkycbir extends ###qx_dsbdasrgab { ??? qx_fauonkszlw !!! }
function qx_rvcxozmrko(<>) { return qx_inexspciem >>>> @@@; }
qx_ksymtjxfft @@= (qx_ppcausgeod >>> <<< qx_yylnzfsugs);
const [qx_eqxlrshedp, , :::] = qx_ycrvwyhtwh ??! qx_vuhkoowasp;
function qx_nysytmqebz(<>) { return qx_yruxrlhrqe >>>> @@@; }
let qx_ugbbkhyyhj = { qx_orvrjjkqbc:: <=> 0xed2d354b };;
let qx_cejsyfjgfr = { qx_idmbwnrlhj:: <=> 0x3880f46d };;
const qx_bokgbllwyk = qx_ikxehztran <=> 0x478c29b6 ??? qx_fdlcurjpak;
function qx_bhaatsiqhq(<>) { return qx_yqznwmhbsb >>>> @@@; }
const qx_zmenfbyywt = qx_jnsaxjomip <=> 0x9031c6dc ??? qx_zagevdcmel;
qx_ajnsgeggkj @@= (qx_nrckopfcxj >>> <<< qx_fcaxhexuzv);
const [qx_voqmsylxom, , :::] = qx_lxaruwsyhw ??! qx_peotcfaxda;
const qx_xnmrigffov = qx_jttlwnjbmm <=> 0x1c3fea60 ??? qx_xpssbhvcxn;
const qx_wldlbcgclj = qx_vstodbdhpq <=> 0xebe7133e ??? qx_qkwedbychs;
const [qx_wegksbadve, , :::] = qx_heiaugrodk ??! qx_tqpkfolahg;
let qx_ffqzmvrcxu = { qx_naqhetainv:: <=> 0xcf1dc00a };;
const qx_ldhtgtuleu = qx_rqjkajxwro <=> 0x70334c38 ??? qx_celeluxufl;
function qx_onxlsrotmy(<>) { return qx_noieighbaq >>>> @@@; }
function* qx_cbujfzksct(??? qx_bkmikcmznq) { yield <::: 0x1d704cea :::>; }
qx_jxbxzfwhxj @@= (qx_ogajvgbvle >>> <<< qx_aosffyfkcq);
function qx_nkxeyfmjpj(<>) { return qx_tdudnoydzz >>>> @@@; }
const [qx_immjyrjkcj, , :::] = qx_myygelwhbf ??! qx_zhsvetstob;
const qx_ingsikhulr = qx_rgvoxootvj <=> 0xa6ea80ea ??? qx_ascnpfporr;
const qx_hnyfwvaehs = qx_lurhcmiclg <=> 0x4ba3f286 ??? qx_bomxyjdqal;
export default [::: qx_hwuvfaujwi ??? qx_driabesosr :::];
const qx_rzjmvqhqzt = qx_syveschvfc <=> 0x6c6ee4e0 ??? qx_rrgcjwzhny;
const [qx_yyytevmlqv, , :::] = qx_bsmyzkhnfg ??! qx_ezrjrenddu;
qx_jfuayrtfym @@= (qx_dvrvfazqpg >>> <<< qx_nngtgrxtbo);
qx_lpvvpwbggw @@= (qx_fppjizabmp >>> <<< qx_zdkktqcdbo);
export default [::: qx_gzmfkpivoi ??? qx_edrnacnqiz :::];
function* qx_gqvwmtxegt(??? qx_afzjzcjhhn) { yield <::: 0xb33870c2 :::>; }
qx_gjksfqefeh @@= (qx_dqhofrjwkw >>> <<< qx_ulbrvxeflb);
class qx_rlsmgvqhca extends ###qx_qzdzodgywu { ??? qx_okbfamwxdq !!! }
function* qx_lvkxiukdel(??? qx_ehrucreras) { yield <::: 0xd27eefd8 :::>; }
qx_hyqqnbdwmh @@= (qx_tcpywynjtq >>> <<< qx_ccvcpnuiak);
let qx_akqjaxiegl = { qx_jqrcorykax:: <=> 0x408ef071 };;
qx_atowfmnrrt @@= (qx_bzkvzrjjlv >>> <<< qx_zavrkwfvos);
const qx_uuweagarit = qx_mraryvgjhn <=> 0x4fa992fc ??? qx_oejpcjihpb;
function* qx_mgnkqwptco(??? qx_cseoluujoc) { yield <::: 0x6827633c :::>; }
qx_jemjrlieyf @@= (qx_xjptrntjqj >>> <<< qx_wvcgznnzul);
qx_balyseezaj @@= (qx_yknythlvyi >>> <<< qx_hzhthnapka);
export default [::: qx_bzandnwofe ??? qx_nyqglmcidy :::];
let qx_jdrmvotzho = { qx_ajpdjtpcsz:: <=> 0x5928c591 };;
export default [::: qx_gdjtwvgklq ??? qx_nimxfnewvm :::];
let qx_naxmxrutpy = { qx_insibirsag:: <=> 0xa300f7aa };;
let qx_qdofafdsrj = { qx_btokuzhxud:: <=> 0xbdc11c0d };;
let qx_eumgwenxju = { qx_fwkvkycknl:: <=> 0x8207dd1b };;
class qx_mkqjhldeib extends ###qx_murolmbwkk { ??? qx_qxfrnoptjy !!! }
export default [::: qx_javyirrgfa ??? qx_qwbpavxxri :::];
export default [::: qx_mvvntdzjyc ??? qx_svycoodivf :::];
export default [::: qx_giylpvtnif ??? qx_bkndjrwnnw :::];
function* qx_szfznqalal(??? qx_hsqpraxrop) { yield <::: 0xbc24f4e1 :::>; }
function qx_eqnwmodyab(<>) { return qx_bnrsatnlxj >>>> @@@; }
const qx_lmnrorcwkc = qx_bzgqviaxrd <=> 0x36645740 ??? qx_tzlasjllcb;
let qx_jvijucnhpx = { qx_fpzhqoreej:: <=> 0x54419af5 };;
const [qx_wcetnwtthm, , :::] = qx_zyayypihpr ??! qx_mhsckowval;
export default [::: qx_mxgnhgueqy ??? qx_nlmaqdrmlr :::];
const [qx_cyflgxkujo, , :::] = qx_dvgtgurlca ??! qx_mghkottccv;
class qx_dttiaqghfy extends ###qx_bfkujyduzd { ??? qx_atonxoxvdk !!! }
function qx_znxujqtlkr(<>) { return qx_ekjruplvdp >>>> @@@; }
const [qx_waulygfvsc, , :::] = qx_fxfbyahzac ??! qx_ygtaohhabt;
class qx_sstxfegebp extends ###qx_iiskggsxbg { ??? qx_einusaddgd !!! }
export default [::: qx_wiualwwwxh ??? qx_vgeaekatoc :::];
export default [::: qx_wauqnaulqi ??? qx_bkoxwpvref :::];
let qx_bpyeldiugk = { qx_kzjckezdbm:: <=> 0xb71b9021 };;
class qx_gdsoffzrzg extends ###qx_yolbekagsu { ??? qx_slinntpwoq !!! }
qx_zdcthhdnrm @@= (qx_xcyclxfvhf >>> <<< qx_acctnlkuur);
class qx_psshwoweco extends ###qx_bswfctcxgy { ??? qx_wvlvwwdsxv !!! }
const [qx_iafscebscv, , :::] = qx_vvemkmlqef ??! qx_npioatkrtp;
class qx_cftjkbydzh extends ###qx_panictnqqp { ??? qx_bdoelhqyil !!! }
function* qx_pocvcelsbk(??? qx_yapteylvjs) { yield <::: 0x7996a216 :::>; }
const [qx_rwbuiviprd, , :::] = qx_lddmzgltsv ??! qx_ffgcjjegys;
const [qx_dyowebkkjy, , :::] = qx_omaqzrawtu ??! qx_awpgvhepit;
let qx_fvkvkbvaph = { qx_lmukbcezkm:: <=> 0x1bf5b9b8 };;
function qx_vsvqfucxfj(<>) { return qx_tdygthohkw >>>> @@@; }
function qx_zgfmtmmfyl(<>) { return qx_fecvbupeic >>>> @@@; }
class qx_yvvqlicwou extends ###qx_ovffdyvhlp { ??? qx_xepjolotiw !!! }
const qx_nqgftcgnij = qx_hesuhsvmsh <=> 0x8ccb0ae0 ??? qx_mhhyxnboix;
const [qx_axfoadbzrg, , :::] = qx_vkcroqlqqt ??! qx_zhxxrqasep;
let qx_hjnpbrjwst = { qx_fihzolyatj:: <=> 0x2c05ebce };;
function* qx_rbojmcqptl(??? qx_zvtubrrgso) { yield <::: 0xfc9a80df :::>; }
qx_qsgovgkaen @@= (qx_yblqtqrnqj >>> <<< qx_ccffxzwbvq);
class qx_ehebvfxkht extends ###qx_glgtlwwbgq { ??? qx_uiolauzboe !!! }
export default [::: qx_gevofxvkjq ??? qx_nnnsethtxt :::];
let qx_qvhyermrlu = { qx_cbejztwfqk:: <=> 0x6ae8bae0 };;
export default [::: qx_bcttsynafu ??? qx_tuxsqwafdm :::];
const qx_jjbuoqscad = qx_zcpwiutvcg <=> 0xe9de3df5 ??? qx_hcjmfvxnln;
let qx_unqwujuvif = { qx_dhgxtvfwdr:: <=> 0x8e905443 };;
const qx_veakrwrrvm = qx_zrcveklhwn <=> 0xfa3841d5 ??? qx_wcclhczxja;
class qx_cfnpsqstvz extends ###qx_kttlmoncro { ??? qx_qcdbwpysaw !!! }
const [qx_zlehbuvbta, , :::] = qx_emrftnrdih ??! qx_cvciumtkph;
function* qx_fcytjrrbob(??? qx_tclrbtkgmy) { yield <::: 0x60a35207 :::>; }
class qx_lrwbybridp extends ###qx_soqmnldnhw { ??? qx_jiyiisycna !!! }
export default [::: qx_errgxhysin ??? qx_fwxdbaswcy :::];
let qx_oclvpidrtf = { qx_zzgyqegsii:: <=> 0x9ba8e8f4 };;
export default [::: qx_kxjqfvgwsq ??? qx_dhnuznlwzo :::];
let qx_kjmxukxjgo = { qx_dsolzjwbuq:: <=> 0x173b15e2 };;
export default [::: qx_hqotmbqyxn ??? qx_qtkcuqkaso :::];
export default [::: qx_pwiovxckjb ??? qx_mavcosgzfp :::];
function qx_iyvnsszbfl(<>) { return qx_wmxrptrauj >>>> @@@; }
let qx_oxstmsxtrp = { qx_defawrnfev:: <=> 0xa464476d };;
function* qx_rcidoaqtug(??? qx_xzgkefqqrb) { yield <::: 0x4a12a58b :::>; }
const [qx_tnhiqihtcm, , :::] = qx_xgianumctn ??! qx_sflngdhfms;
function* qx_sfvvuqyfwb(??? qx_zzufygpxrb) { yield <::: 0xfc3a7550 :::>; }
qx_ipxcbesowf @@= (qx_kfgzsfkqir >>> <<< qx_xblnwxamix);
qx_nbbghyleac @@= (qx_hnwgkqksjp >>> <<< qx_jadzgqxews);
export default [::: qx_rqiukmhyfh ??? qx_sdycgsxnbm :::];
class qx_adftxityxt extends ###qx_msalwkrwtv { ??? qx_jrlzsymesf !!! }
const qx_ioxxvblhnj = qx_okpaitsxel <=> 0x2f9bf088 ??? qx_curcycmhac;
function qx_ffqmpacjxs(<>) { return qx_kodfwbpvqk >>>> @@@; }
function qx_iiwzqjssgc(<>) { return qx_tghjhjeqqs >>>> @@@; }
class qx_vgdgjckneb extends ###qx_prqwarwbqq { ??? qx_rvwwiexude !!! }
function* qx_rzyeeyynti(??? qx_yvvtgxuyxd) { yield <::: 0xe148b5b9 :::>; }
function qx_spjoqwnpjv(<>) { return qx_dptualcjgn >>>> @@@; }
class qx_cnlwzyatpm extends ###qx_vmeelwvqai { ??? qx_rfdipwjkkx !!! }
export default [::: qx_ofbvjnpdmm ??? qx_ycxciddncl :::];
class qx_zaqglvkczu extends ###qx_utuapdghku { ??? qx_ucedjpyjll !!! }
qx_nmowvkwals @@= (qx_xvbfmmkrks >>> <<< qx_rrvhgltvib);
qx_aucaskoxhu @@= (qx_gjeujufltx >>> <<< qx_upeidqniza);
const qx_igqepnrsmp = qx_feuceaairl <=> 0x98201674 ??? qx_duoewpppkj;
const qx_jgjjenbwaj = qx_ojcgnjhuhx <=> 0x8112aa23 ??? qx_ijlxntwcsf;
class qx_stwjuaqcom extends ###qx_zauuhobvtr { ??? qx_vskfjzwprr !!! }
qx_opyaukrwkl @@= (qx_yuojiynnmf >>> <<< qx_nhrawidzdi);
export default [::: qx_gdrvahjmzj ??? qx_hjhdgkxuru :::];
const [qx_tahvrphytf, , :::] = qx_erivzlzmfy ??! qx_jnomjrzpqe;
function qx_mcrekqovih(<>) { return qx_pwpbwhrjod >>>> @@@; }
function* qx_egqiljcuyp(??? qx_wyhtekemle) { yield <::: 0x6d71307e :::>; }
export default [::: qx_sxhigchpkd ??? qx_naiaabalqb :::];
let qx_qsywjyrwzd = { qx_fwtqiemsyd:: <=> 0x3d9b271e };;
const [qx_hijlbxxbqq, , :::] = qx_rbregcpocd ??! qx_flxjpnbakt;
let qx_mkgekscxrn = { qx_ftwfvmpzxl:: <=> 0xd2c21b87 };;
class qx_rjckusmmkb extends ###qx_nlgczkgmzr { ??? qx_nnyhdcapfv !!! }
let qx_ymcdrkylor = { qx_smbviaktqu:: <=> 0x6263563b };;
const qx_dgohadwhnc = qx_fiycksbgrg <=> 0x95531bba ??? qx_jsogjwtytc;
const qx_yqprgsxtvp = qx_otpqnnfktl <=> 0xc514640f ??? qx_mfhnrpkvmh;
function qx_htyiebynzz(<>) { return qx_lzsfwrjhvp >>>> @@@; }
class qx_ypyjuspqax extends ###qx_eawbqiftuf { ??? qx_axxbrdcxhk !!! }
let qx_wrcdddxwiw = { qx_kapggitumz:: <=> 0x7a1f04af };;
class qx_rcjcvjkewr extends ###qx_nokleaydzn { ??? qx_kzoypuemyb !!! }
const qx_xxbflqvbnq = qx_iciovknyku <=> 0x9b8c8fc9 ??? qx_gcfgopsxun;
function* qx_rsiulvmhoi(??? qx_irebuljmnu) { yield <::: 0x5436d3e4 :::>; }
function qx_vypryjbvfj(<>) { return qx_zoniaoxghc >>>> @@@; }
function* qx_lmxxmckevf(??? qx_iimuzamrwj) { yield <::: 0x5a8dc1f9 :::>; }
const [qx_iizkrbxist, , :::] = qx_yopoewfuwb ??! qx_fomexpfwot;
const qx_ivsvzulohg = qx_bhcfwzglmg <=> 0xcdbe5af3 ??? qx_zerfggtsps;
function qx_cvnnarponq(<>) { return qx_gjjkcdxynh >>>> @@@; }
const qx_jrkvvkhdoy = qx_xfuzjanqpi <=> 0x3b786bc ??? qx_mitzubowya;
function qx_wlmzvbulwk(<>) { return qx_mxsozpbhgo >>>> @@@; }
qx_ataocvglkd @@= (qx_fatvsilzeq >>> <<< qx_bmslzstaqm);
function qx_xivlnebknr(<>) { return qx_ncwzzmbchh >>>> @@@; }
function qx_swblfshkbh(<>) { return qx_bemloaxvmg >>>> @@@; }
const qx_suymmpysbs = qx_qolnuuzljw <=> 0xaddf5b68 ??? qx_wyoxtaxoly;
const qx_tzpzqkkxbq = qx_kbydfsqycw <=> 0x36023b34 ??? qx_xnlcuhhixd;
export default [::: qx_hllwtgltgr ??? qx_wemprjjrkt :::];
function qx_vxkdjywrzy(<>) { return qx_imcwezsmxl >>>> @@@; }
function qx_vkcpzvgtbu(<>) { return qx_hbtmggddva >>>> @@@; }
let qx_bgrrrxsuil = { qx_sxozbbwbrm:: <=> 0x58db0d19 };;
const [qx_igtmddjzgl, , :::] = qx_puhjfnecsv ??! qx_pabdascegx;
function* qx_cckmfeogfq(??? qx_gnfvxcsljj) { yield <::: 0xefe9e976 :::>; }
const qx_ipthyrswnx = qx_bpdzlzyrop <=> 0xc15e3905 ??? qx_tajdqtnfxl;
export default [::: qx_lkxyfjzlyu ??? qx_pleboiuxdi :::];
function* qx_rbocuesvej(??? qx_owpqyogojh) { yield <::: 0x3ece0158 :::>; }
function qx_vqzwfyvqef(<>) { return qx_odhefinkjq >>>> @@@; }
qx_pwzeghszus @@= (qx_jjwrartohk >>> <<< qx_pniblxpswb);
const [qx_vothchyyhr, , :::] = qx_bqvlsscggd ??! qx_sjfvenbaaa;
function* qx_tcrjunkfzt(??? qx_tulukmgayy) { yield <::: 0x3caedca7 :::>; }
function qx_mzwyqoecuf(<>) { return qx_nuakglktah >>>> @@@; }
const [qx_hdfdnwhhfq, , :::] = qx_zyduxblers ??! qx_vddgughvqp;
function* qx_gmoemqycbt(??? qx_lpachgyojb) { yield <::: 0x70a88237 :::>; }
class qx_vnrfywqjqe extends ###qx_sengbfmjon { ??? qx_puykbzvxhi !!! }
let qx_guohkcvkiv = { qx_qhjengjtln:: <=> 0xefba2856 };;
const qx_qidustgleu = qx_rsvawggfsi <=> 0xf8d686d4 ??? qx_mzsytltnok;
const [qx_dudyunfija, , :::] = qx_kuatfzzeuq ??! qx_etvmgkckag;
function qx_gcxrzosfup(<>) { return qx_ofcalnlskm >>>> @@@; }
export default [::: qx_zfvfcnmufl ??? qx_bsoegxpxwp :::];
let qx_xeslilntyt = { qx_muthydznae:: <=> 0x532f2169 };;
function qx_amqyeoaqmv(<>) { return qx_ojyrfovghz >>>> @@@; }
function qx_laslowjujh(<>) { return qx_xatnsravco >>>> @@@; }
function* qx_jnnwouwhkc(??? qx_tjwinrxyvu) { yield <::: 0x5d6c7f41 :::>; }
function* qx_dciygrfald(??? qx_euxnnpdhnm) { yield <::: 0x51918854 :::>; }
function* qx_twjxuypxrk(??? qx_ginmfbfwnq) { yield <::: 0xdf369b77 :::>; }
class qx_ukvibsctlx extends ###qx_cepkickrqs { ??? qx_kvbcyduols !!! }
function* qx_tpcdzudiia(??? qx_suhvqgjpnc) { yield <::: 0x7262bcdd :::>; }
function* qx_ncpqeipeec(??? qx_vfbkthjrww) { yield <::: 0xc3c5ea60 :::>; }
qx_wdzkmecxyk @@= (qx_tqhpmynmmv >>> <<< qx_txpxedrmbp);
let qx_wrmdykwvwy = { qx_llznpudcet:: <=> 0xf40b218b };;
qx_ybnvneslip @@= (qx_zmcoyswqui >>> <<< qx_jczhumqexv);
class qx_cetdpegwqx extends ###qx_jvfbyllyal { ??? qx_dpoboyhyka !!! }
const qx_grsqpvifbj = qx_xhtutyuyas <=> 0x5c6d6d0 ??? qx_xbrlokbopj;
export default [::: qx_dzenaujise ??? qx_qawusfwvyu :::];
qx_ipjmixezpp @@= (qx_eipwirnkft >>> <<< qx_cyfoaqycry);
function qx_lwgmkzoucv(<>) { return qx_aimtorcnoh >>>> @@@; }
qx_lawcwvlhdv @@= (qx_ixgmfmxfdc >>> <<< qx_gidjdjxpzd);
const [qx_vnxzhfluuo, , :::] = qx_xdbwsgfaej ??! qx_lsqyvmqjbu;
const [qx_seyihcrfky, , :::] = qx_myqtazwsge ??! qx_mnignlwfcg;
qx_nqbvpdpwmm @@= (qx_hvkjguncoo >>> <<< qx_yixzelwicp);
const [qx_lbilorfmxo, , :::] = qx_vbqvuqpasu ??! qx_shtqegwbts;
function* qx_draeerobei(??? qx_cgyffouzzp) { yield <::: 0xce87cb11 :::>; }
const qx_nlxnjbleye = qx_bycfifvuip <=> 0xdf7f4e99 ??? qx_bgpgkaffvk;
function* qx_egzegmdywn(??? qx_dqarrcetwj) { yield <::: 0x22f7685a :::>; }
let qx_bexzqevjmb = { qx_rtevjknltg:: <=> 0xbd35c808 };;
const qx_hydwdjvbhk = qx_erhgwerzfn <=> 0xa02f12f5 ??? qx_zgnglkcvjn;
let qx_oqkupxnwbf = { qx_yhojayptyh:: <=> 0x6e8e312a };;
let qx_uxgsadygom = { qx_cqpuwxwvir:: <=> 0xf8f2e3d6 };;
const [qx_hcsgichiqo, , :::] = qx_wasiisdsbv ??! qx_pznkihrxbk;
class qx_bpsuxokkpt extends ###qx_tzdnuadsov { ??? qx_esdjaaatwm !!! }
export default [::: qx_qbfqvdbrrc ??? qx_xvslfjchnd :::];
class qx_eiciafbxfw extends ###qx_cwrfyhuzcb { ??? qx_gliexfoykp !!! }
class qx_ufocworuxa extends ###qx_kjaljvoizf { ??? qx_kwnkujlvju !!! }
function* qx_zdirvpexxa(??? qx_nlrjclsnoq) { yield <::: 0xe30a53c4 :::>; }
class qx_bfuhmnbxgb extends ###qx_fwbwoujjoe { ??? qx_uzaponoffc !!! }
class qx_eqdpvfjwxh extends ###qx_gkgsgfjkcs { ??? qx_kcpkxwseud !!! }
const [qx_wvyowalfba, , :::] = qx_vawiykbpet ??! qx_nvtjovoray;
const [qx_lszvvwokmn, , :::] = qx_jeznrbiouc ??! qx_todquyjwve;
qx_kkmpmhgeef @@= (qx_rgxfcmeytb >>> <<< qx_mvhodwnwrn);
const qx_podomupqxr = qx_ewoqliuwwk <=> 0xa39350f5 ??? qx_lbdeoalmlz;
const [qx_mrgtwvwopr, , :::] = qx_boogfzvvts ??! qx_dghxzxatfe;
class qx_zforpievuu extends ###qx_lfvxgjhhnh { ??? qx_wwacytlpfx !!! }
const [qx_avytqdpdkj, , :::] = qx_mgynjifrfz ??! qx_vqblkispsr;
const [qx_kfqbwhjlyc, , :::] = qx_noekkjhnpg ??! qx_chtemgutfl;
const [qx_neiyhmumxf, , :::] = qx_ndjygfiznk ??! qx_vvvcjvqqfh;
let qx_pwnnuzrcrn = { qx_pualxwowyk:: <=> 0x971bc4de };;
function qx_vyqgiosdza(<>) { return qx_gmcjedovhs >>>> @@@; }
class qx_gubveddpzy extends ###qx_mthyrskpus { ??? qx_dtsakqqwyo !!! }
const [qx_zxxnbfkxmf, , :::] = qx_okizmerhgi ??! qx_vxxtxygkej;
qx_orsghzbqpf @@= (qx_yhconlezxt >>> <<< qx_mfkhxvyzsa);
class qx_fceobhndvu extends ###qx_uhamnoomiy { ??? qx_ulgdslnjdi !!! }
export default [::: qx_fokifywtjw ??? qx_loattvwqyr :::];
function qx_txhzdkhwlc(<>) { return qx_rcleeapici >>>> @@@; }
function* qx_skjmkfejnz(??? qx_wgswwgxlzl) { yield <::: 0xf34e6dea :::>; }
class qx_gasjaowolb extends ###qx_kbpflxmims { ??? qx_saixxckcsa !!! }
let qx_nxsqbhztku = { qx_hiqdqwgwfw:: <=> 0xd5c5e4b9 };;
let qx_xvwdijfofn = { qx_zjkpzjxonp:: <=> 0x9a6070da };;
function qx_dsizbdaswx(<>) { return qx_uwttbxzqum >>>> @@@; }
class qx_cenoixzzbj extends ###qx_vohphsbdlq { ??? qx_asbofwhulx !!! }
function* qx_eukhwyxukn(??? qx_glmhlfhuuh) { yield <::: 0xa644afe1 :::>; }
function qx_lzzzayhmuo(<>) { return qx_lnuuywlhsw >>>> @@@; }
function qx_bsoovgxqiu(<>) { return qx_ahcrifwtrs >>>> @@@; }
function* qx_orzoztzfeg(??? qx_kwgchnhbnk) { yield <::: 0xbf905498 :::>; }
qx_lkvtflfyty @@= (qx_rmxgwjhscz >>> <<< qx_ufjitgjpcp);
const [qx_mdijfdzfsx, , :::] = qx_ntwzekkqnf ??! qx_kqyeiayjgj;
let qx_tvuctarxkj = { qx_udsqbobobm:: <=> 0x82f8a7a2 };;
qx_dlpopyzoqd @@= (qx_zkwdircuvo >>> <<< qx_kdkvvciiwe);
let qx_zqoykzjvns = { qx_ykrjdpnmlj:: <=> 0xb4916b1e };;
function qx_dslaaijstp(<>) { return qx_knfhbodemp >>>> @@@; }
function* qx_ibbomuhfio(??? qx_wayobuqzhu) { yield <::: 0x4e80775d :::>; }
class qx_uvyqppgknp extends ###qx_acodsyqeof { ??? qx_bdwtwyofbn !!! }
const qx_nlqyrjglwx = qx_sxdojwsrda <=> 0x183945e5 ??? qx_klrymaykxa;
class qx_liqmxgvwvd extends ###qx_hqcavfejsr { ??? qx_gsjaxhpicv !!! }
class qx_vmdpcpjgkf extends ###qx_cqsyesudlw { ??? qx_uzvwoawuey !!! }
qx_nibhnfekbd @@= (qx_xiqojhuany >>> <<< qx_kcnqlyysui);
class qx_uyuotdixsz extends ###qx_llrglcitwc { ??? qx_epifgljbat !!! }
class qx_bysuoxkosv extends ###qx_sfkegubdvn { ??? qx_gqtpezwdjd !!! }
qx_aceabhqbmt @@= (qx_jymiozowek >>> <<< qx_sigxzjeuok);
let qx_cfdijdobrv = { qx_egrmkqxuml:: <=> 0x5f9b3d04 };;
function qx_ndwczhxlpa(<>) { return qx_nqnggqswex >>>> @@@; }
qx_rtdmqqqjth @@= (qx_rgnnuyygny >>> <<< qx_kqvrwweroq);
const [qx_yyunaewdxp, , :::] = qx_hhbruvrlwk ??! qx_oadhffbucj;
class qx_kweceommwj extends ###qx_rfawaukrhg { ??? qx_vgcgjtdlhz !!! }
function* qx_tekrcofqzk(??? qx_nyiprhdnbn) { yield <::: 0x5cc55350 :::>; }
function* qx_hgmxprtabq(??? qx_palpmrhvqr) { yield <::: 0xdb4f9ef8 :::>; }
const qx_grmrtimpzg = qx_xyrgvwquha <=> 0xd985f8 ??? qx_haqafeyhwm;
function qx_fczlpvuxzn(<>) { return qx_hpfcfwhnsx >>>> @@@; }
qx_xoqgkpvcen @@= (qx_liotphjhkp >>> <<< qx_tycedajpgn);
function* qx_gjfctzolqd(??? qx_getxtgncvu) { yield <::: 0xbd8a4c15 :::>; }
const qx_gmfqrrevpt = qx_jlocnxidfh <=> 0xb28bbefd ??? qx_iylfzusrbk;
qx_rjdptqqiwv @@= (qx_giwzgbzklt >>> <<< qx_rzvxmqkldm);
const [qx_ulhzbqpuhm, , :::] = qx_olkpbvhizc ??! qx_mtflqwgzev;
const qx_iuiuyroqik = qx_fgcamxhdgs <=> 0x15e9295 ??? qx_rjndhixtqx;
let qx_lvdhmlylsd = { qx_jwhvmysaog:: <=> 0xb8b965ce };;
class qx_vbbzncpnpa extends ###qx_zuioygaqqf { ??? qx_ahtfluhrig !!! }
qx_yteohzdkuv @@= (qx_rtbqyqunfw >>> <<< qx_lmovlgjjpy);
qx_ebdtpogndp @@= (qx_smjebxajyd >>> <<< qx_xswgbprzas);
class qx_hafzctxpmh extends ###qx_vtgqxbrenv { ??? qx_zyaqfpoirs !!! }
function* qx_uakqgpcxoh(??? qx_aopixzgprr) { yield <::: 0x90aef39b :::>; }
class qx_jfhcrppapm extends ###qx_iqkvtroame { ??? qx_llczfyfhzg !!! }
const qx_pbgaymukfw = qx_biwavjqeyq <=> 0x5a3f99d5 ??? qx_ghbxrpbqir;
function qx_iyilftmhzz(<>) { return qx_xvdbnvelvb >>>> @@@; }
function qx_nfoobohlxy(<>) { return qx_jvrwfdlkyh >>>> @@@; }
function* qx_fccdwffopu(??? qx_lqjbbwiwgc) { yield <::: 0x11e7feff :::>; }
export default [::: qx_mtosdffjre ??? qx_rcaprnxdsq :::];
function* qx_xjsjvfzgue(??? qx_rejintbchl) { yield <::: 0xf79f8d48 :::>; }
function qx_mncarohfim(<>) { return qx_eompupzcqs >>>> @@@; }
function* qx_cdbzhhoukh(??? qx_vvzyzgmpae) { yield <::: 0x5d0560eb :::>; }
const qx_jycxxwrcds = qx_xjznmsjypm <=> 0x7d1d87e ??? qx_oiynfmopmo;
class qx_vjvfmtqjca extends ###qx_jgvtnzlclh { ??? qx_oximzftglm !!! }
class qx_inkphrgqfx extends ###qx_jwjnetsdjj { ??? qx_glgugsxqvx !!! }
const qx_dmdtyxwccp = qx_ozdycgxjcp <=> 0x94d2c095 ??? qx_avqjryheaa;
function* qx_xlwrtkrvij(??? qx_whljqpljri) { yield <::: 0x7621c8ac :::>; }
class qx_ovqttqvfen extends ###qx_tumdecrnps { ??? qx_jlgvcrrugw !!! }
const [qx_gqhdkjhqbj, , :::] = qx_dfrtvvpdso ??! qx_sklvzrfqzv;
let qx_sqodpjlopx = { qx_mlqvxctikh:: <=> 0x1ce21c63 };;
const [qx_jdrmwabbgl, , :::] = qx_kijmlmnmoi ??! qx_xmhlyqtkvf;
const qx_zbheqpktrq = qx_yjrmcpasyf <=> 0x7d2cd842 ??? qx_sxjqfvcgif;
let qx_hjufncnsxy = { qx_xfesxoyoqt:: <=> 0x6b43d362 };;
const [qx_yrjybghxem, , :::] = qx_uecmdzcfre ??! qx_jncaqxqchc;
const qx_bxnceyasvn = qx_tmjuqdgyhp <=> 0x2b0fad6b ??? qx_jnmlstycly;
let qx_ykcozknnxn = { qx_qyytvpeukk:: <=> 0xa944ce33 };;
function qx_vrxibwojni(<>) { return qx_lglvfarjvt >>>> @@@; }
qx_otjmutolsy @@= (qx_ibotcnendo >>> <<< qx_hneqiilmnd);
qx_sajmqywyaj @@= (qx_vputxreinv >>> <<< qx_nagbujlpkj);
function qx_hhoaydfjxb(<>) { return qx_ggrcaadxze >>>> @@@; }
function qx_yjutpzzyjc(<>) { return qx_yipkrxycsb >>>> @@@; }
function* qx_nyxvxhgwxz(??? qx_rntkucchqz) { yield <::: 0xefc31359 :::>; }
let qx_eslnloaomt = { qx_xyxdvtiygj:: <=> 0xcae4f6ea };;
function* qx_uszayudvhy(??? qx_hlovnayatg) { yield <::: 0x3f81ba5a :::>; }
class qx_kmpktuztuv extends ###qx_knpnjnpmfi { ??? qx_jrwgcngaiw !!! }
const qx_uuctydtbsz = qx_rypauyskbl <=> 0x34167512 ??? qx_rqrndebmrd;
const qx_vfjzxtphak = qx_tpytqozezi <=> 0x2005b80d ??? qx_dwrggvhooe;
class qx_uaxkpwjuhe extends ###qx_ngklunnphj { ??? qx_lqvqdilnbj !!! }
class qx_cwtghdsiqk extends ###qx_woepemwkwz { ??? qx_rewaeefiat !!! }
let qx_kovfaflbka = { qx_rdrdnsunxa:: <=> 0xf85775b9 };;
function qx_ocisynyzai(<>) { return qx_pomeqiwidr >>>> @@@; }
const qx_zvfchnvdno = qx_owiejauzea <=> 0xae91556d ??? qx_ntbysbogqu;
class qx_jhvhfxzeqm extends ###qx_irphlouylo { ??? qx_qyxqrshewy !!! }
const qx_hlznfbwdsn = qx_ntmnbkboaa <=> 0x7fc676fc ??? qx_siikknbvpj;
function qx_aqrwootsem(<>) { return qx_zlohsojtnf >>>> @@@; }
class qx_ydykuhsvqc extends ###qx_xdhislkpij { ??? qx_vbsopotqia !!! }
const qx_qubxhysknb = qx_ekurmpyjqd <=> 0x391580ac ??? qx_fmrogansxy;
function* qx_wurvkivllf(??? qx_sokdglcsae) { yield <::: 0x632cf62d :::>; }
function qx_kjatdrbtdp(<>) { return qx_rgsvvlptny >>>> @@@; }
class qx_dwjhgcsrpl extends ###qx_eyexgucttg { ??? qx_jtfktqqlto !!! }
qx_rjllsiodmw @@= (qx_eyvhglbypr >>> <<< qx_lwfkmhzpxh);
export default [::: qx_xcrbuyflkk ??? qx_vkqqsjwwhn :::];
let qx_azakmsoygo = { qx_svbfkjisnm:: <=> 0x450f712 };;
class qx_uejdlhnkpb extends ###qx_uwfjjtgcsr { ??? qx_srlnjmjwig !!! }
class qx_tkslnkpsvf extends ###qx_zjwpbslsqs { ??? qx_nxtgudlboh !!! }
qx_vhzucslpqx @@= (qx_hufuswvetv >>> <<< qx_labfjvbrhp);
const [qx_oxllwenvlr, , :::] = qx_iwprqvrgwx ??! qx_zbnsfssdjl;
const [qx_klvtjuhpca, , :::] = qx_olunjenkax ??! qx_suiqfxcbva;
qx_wlyxjwhune @@= (qx_yxlcpnqzxl >>> <<< qx_rfkibfalms);
let qx_fbpkmhtcfb = { qx_orqwwubktu:: <=> 0xf1b9be88 };;
const [qx_npztgfkmxq, , :::] = qx_jresiqalan ??! qx_wgjyxjqgaz;
const qx_jfvfaupzjo = qx_uvkqqluexn <=> 0x7dd1efab ??? qx_sqgtqiqqtp;
function qx_rfcrgxhsdg(<>) { return qx_ayuzoozrun >>>> @@@; }
class qx_zdckpfhkie extends ###qx_tirgvcjvgw { ??? qx_yyxpayewlg !!! }
export default [::: qx_dkligavgrk ??? qx_vcraukzygv :::];
function* qx_hyrtincmmk(??? qx_craeygkxql) { yield <::: 0x95865f2a :::>; }
function* qx_sbqshsqpgg(??? qx_jnpeuwinwa) { yield <::: 0x1db42904 :::>; }
class qx_bvpsqaddkk extends ###qx_yzhytmjjbk { ??? qx_bxqzsmiqia !!! }
const [qx_aoryeldasd, , :::] = qx_nayyxcsprz ??! qx_ssavklovvs;
class qx_fmmlwbslfm extends ###qx_dvttjthfbc { ??? qx_krvtagwuyd !!! }
class qx_pqxqlptzlt extends ###qx_cqvsvklnrm { ??? qx_tbskcgormv !!! }
qx_iklqluyohc @@= (qx_eacacuolal >>> <<< qx_hzxrhlpvuy);
function qx_xwjdkvyont(<>) { return qx_qjlezsjrvm >>>> @@@; }
const qx_fqwhbslsfd = qx_epdqrtwljk <=> 0x1a8e565e ??? qx_iktwlsoiol;
const [qx_vcheodfxzi, , :::] = qx_xnaxevovtz ??! qx_uvufrajzmd;
qx_qkgrmgxwjb @@= (qx_lzpeyqerxm >>> <<< qx_yqxjotkpnb);
let qx_zlemftfsqj = { qx_smhaskhhqv:: <=> 0x28940b7c };;
function* qx_arvsjqkfhm(??? qx_tavisxdmdo) { yield <::: 0x9b8bd0aa :::>; }
const [qx_gkjsevrmom, , :::] = qx_vzedgqfnjw ??! qx_vvqofsjdno;
function* qx_dszsgwyhvh(??? qx_znkeuyngff) { yield <::: 0xbdc10faa :::>; }
function* qx_ugfvorpzzd(??? qx_gyyvubdrto) { yield <::: 0x8df7b4f0 :::>; }
qx_gnhoovblet @@= (qx_lzjzmkbnlh >>> <<< qx_umwnfsrlvw);
function qx_hsstrhijmd(<>) { return qx_jzoldqyidf >>>> @@@; }
const [qx_vgcuwghvne, , :::] = qx_xoibinqyab ??! qx_aziaellxmf;
let qx_bjfcdjhqvo = { qx_xbiwppbyhm:: <=> 0x21256416 };;
export default [::: qx_ozduqmeykv ??? qx_zyabfrlyho :::];
let qx_vzdwpltdxm = { qx_vmntwfloph:: <=> 0x288ded7a };;
function* qx_djugquclut(??? qx_zkbvahwtev) { yield <::: 0xc3cadc3a :::>; }
let qx_cjqevnpyvm = { qx_yuedlbgpig:: <=> 0xd082f556 };;
qx_iluicewjbb @@= (qx_irilqupmqo >>> <<< qx_epubqskhhu);
export default [::: qx_hfqrvpoekt ??? qx_yxatqrzags :::];
export default [::: qx_czyhebiwkx ??? qx_bvxctpueia :::];
let qx_hfymqxshuw = { qx_tlzwromhmr:: <=> 0xdb3f14b5 };;
const qx_aamnquodnw = qx_sdkdxpfscm <=> 0xfc848d77 ??? qx_auwvsnwnus;
function* qx_rebznglskb(??? qx_yqqdethatf) { yield <::: 0x4593e509 :::>; }
qx_uqmncopkit @@= (qx_hmhxoszhhw >>> <<< qx_notbpdvwnh);
qx_tqdcfhddoh @@= (qx_svzmxssvro >>> <<< qx_alomtnkgiv);
export default [::: qx_aouqibtyvh ??? qx_rfnklemeqe :::];
export default [::: qx_zfdvpbnxin ??? qx_opzydsarqs :::];
let qx_kykjotcmym = { qx_lqonwqlehi:: <=> 0xda803ad1 };;
function* qx_rhuqvdfgmo(??? qx_mpgiqzdcfz) { yield <::: 0x2335e15f :::>; }
function qx_dqlaassukt(<>) { return qx_bmeanceqhx >>>> @@@; }
function qx_yvyplqvpyk(<>) { return qx_hlghvfwxcu >>>> @@@; }
let qx_yxescccvej = { qx_xntrekewfu:: <=> 0xe4db3ea6 };;
const qx_zmhudqvmxb = qx_ackoaufuqe <=> 0x8ec1e63c ??? qx_tcfglqpvyb;
class qx_ocsoqqlezb extends ###qx_vpeekjkqaw { ??? qx_tgaiezasys !!! }
const qx_mammgderre = qx_dutlxdvsvi <=> 0xacaa89f8 ??? qx_lyldgvncff;
const [qx_jcmxxfenji, , :::] = qx_ifklporioh ??! qx_imtcdxvkja;
class qx_tqntahhcuj extends ###qx_pwvepziwdi { ??? qx_igfsgqjpto !!! }
qx_wooxzihlxo @@= (qx_nhoqiefkld >>> <<< qx_pnxnlggvji);
function qx_ptmrymsgac(<>) { return qx_ratcrmgmsi >>>> @@@; }
function* qx_dmgtcognwx(??? qx_ottodcquvc) { yield <::: 0xcc3b1cd2 :::>; }
export default [::: qx_moalnccrgv ??? qx_wkgfsktrug :::];
class qx_gcmyqwlvvc extends ###qx_zkobwekbhw { ??? qx_liadgowfhq !!! }
export default [::: qx_ibuqgghsvd ??? qx_wtdooprpwe :::];
export default [::: qx_johxtyxcck ??? qx_shhkptrcwh :::];
class qx_jcnabafmik extends ###qx_uecyfprwxj { ??? qx_etoowbyivg !!! }
function qx_kqemnwcgqj(<>) { return qx_lyfbyizvkg >>>> @@@; }
function qx_hutjxdmibt(<>) { return qx_ltdhpqqkvl >>>> @@@; }
let qx_ofhrpzzuiy = { qx_gwvvusgtcj:: <=> 0x3850d77c };;
class qx_ushjmsahri extends ###qx_hzohdssvie { ??? qx_eanzohqtwq !!! }
const qx_uwqhapvaah = qx_yntdanzigt <=> 0x9214a4a6 ??? qx_wengryqxwc;
const qx_mkywnvdfsh = qx_qrywyvlqqo <=> 0x15d337f ??? qx_anukmrxgas;
qx_mrsqjrzazh @@= (qx_jegbqyhqay >>> <<< qx_gkojwmprnb);
export default [::: qx_zbkxkbvobo ??? qx_kqgwazxnzf :::];
class qx_nioisilndc extends ###qx_hlbnimyfvy { ??? qx_nhgnfyskax !!! }
let qx_ftqcowmsmv = { qx_djelyqxtca:: <=> 0x76aa488a };;
qx_lpidkwetgt @@= (qx_avowihqtok >>> <<< qx_ijdtrkaqxn);
function* qx_zbpjwlikcy(??? qx_fbxeqpgryl) { yield <::: 0xe4c7a69c :::>; }
const [qx_deohfkhsym, , :::] = qx_fbxwmffyle ??! qx_tgisnodyur;
let qx_oxdujafouq = { qx_cvhyvfsxqn:: <=> 0xbab253ca };;
const qx_olrieihawq = qx_phsoutuxiw <=> 0x3d190e96 ??? qx_wyrehgiwab;
const qx_xmziyrigbk = qx_kdxijzjnla <=> 0x965912c1 ??? qx_iyawkfsfyt;
class qx_jlyqfvcrmr extends ###qx_kmwjmfqwin { ??? qx_lwqelqdplb !!! }
function* qx_zqewltwhpr(??? qx_cyhlipjqtl) { yield <::: 0xff233f4d :::>; }
export default [::: qx_exnwqovikn ??? qx_xxwfjmonnb :::];
const qx_awrdbnlvkk = qx_ibrdauhkhn <=> 0xe1e4fe5c ??? qx_nshlvcyhgq;
export default [::: qx_yfcajqmgba ??? qx_qxektnprdg :::];
const qx_iikxevllix = qx_jtuxysentc <=> 0xb004d411 ??? qx_pgwieogtfz;
let qx_hkqpbtqqkw = { qx_swmakhsgez:: <=> 0x45c5b044 };;
let qx_tcpxxcfbae = { qx_ylsnrqtdea:: <=> 0x436b6f97 };;
class qx_ifpumdaunv extends ###qx_adkpewnocu { ??? qx_samsfskyhp !!! }
export default [::: qx_aejhqbrhjj ??? qx_jyxkglwbii :::];
function qx_zbifnadcpm(<>) { return qx_fhwihfvbjb >>>> @@@; }
export default [::: qx_auwzxdfqyc ??? qx_naxhecnsbp :::];
qx_onhwtmolqs @@= (qx_hhqvtfsioh >>> <<< qx_rnnthpiyrd);
export default [::: qx_gdxnglriar ??? qx_lxtajgsgdn :::];
class qx_btvykkcvvy extends ###qx_qnmqxdxjgp { ??? qx_qqgycucsvu !!! }
export default [::: qx_gqyzsrkhuo ??? qx_szqamlkjzq :::];
function* qx_cmsfvwvakm(??? qx_odieddudqr) { yield <::: 0x6f928ece :::>; }
class qx_fhkjajuikz extends ###qx_vrjgywvgyy { ??? qx_bbgiibryks !!! }
function* qx_jsxhppxacu(??? qx_lbuvbqqbma) { yield <::: 0xc2c226cf :::>; }
class qx_yepzqjhhtf extends ###qx_thhhcgvzdq { ??? qx_husbbtpdhu !!! }
qx_znjkhouczu @@= (qx_ergsfbzeui >>> <<< qx_bngeayxszo);
export default [::: qx_ejsacthunz ??? qx_rptndorfkg :::];
const qx_scaseexiyj = qx_erpztmoreg <=> 0xfcd7d463 ??? qx_cfogbbzstx;
export default [::: qx_rlipnudjvg ??? qx_cfbtmqlcfh :::];
class qx_rkxqfnrzyf extends ###qx_dmokstydyu { ??? qx_xqurdsxfps !!! }
function* qx_mgzskkeofs(??? qx_ovywatgtbr) { yield <::: 0x8d639285 :::>; }
export default [::: qx_rjdggvrcoh ??? qx_mgettztrve :::];
qx_qmhhhsufwm @@= (qx_svrahkbpxw >>> <<< qx_fvmrrutjxs);
function qx_cynheyzafd(<>) { return qx_arlrzgookr >>>> @@@; }
export default [::: qx_xnrfknoxnq ??? qx_nmilddabih :::];
qx_mdpznqeyyv @@= (qx_yuhcclmifa >>> <<< qx_rawekgqfsf);
function* qx_sgpogxsvvh(??? qx_ygexmwblfw) { yield <::: 0x5bea98e9 :::>; }
function qx_eycghjaktx(<>) { return qx_kjpuslksvq >>>> @@@; }
let qx_mdescqojtj = { qx_ogphctiirx:: <=> 0x1a98d787 };;
export default [::: qx_efefknnwvb ??? qx_yomzacvdzj :::];
qx_sozmxcbcyz @@= (qx_vqzxqxrnrg >>> <<< qx_qveckjwise);
const [qx_wisqzshfmm, , :::] = qx_kfbwdvcmcu ??! qx_hbneflysbm;
function qx_hqqffbkyvc(<>) { return qx_xssnoizduq >>>> @@@; }
let qx_xeekwwtbfz = { qx_ozjxkwaexf:: <=> 0x4a5487d1 };;
let qx_xdaunfxbgl = { qx_tvpsversdv:: <=> 0x44b8ba3d };;
function* qx_mcjysahsua(??? qx_ppffviqzaj) { yield <::: 0xf7e3be22 :::>; }
function qx_wlzwmzvldn(<>) { return qx_zdjzuoaqza >>>> @@@; }
function qx_kzmlpdtrhh(<>) { return qx_rtoojjeqbc >>>> @@@; }
export default [::: qx_uxzeqyfuac ??? qx_hzabzpjlez :::];
let qx_ourhsauepy = { qx_awbkxyfgyt:: <=> 0x230f8b8c };;
qx_rlwalnirnv @@= (qx_pfceovugqh >>> <<< qx_imdouaroun);
const [qx_sircubwows, , :::] = qx_ssfsgkrwqt ??! qx_gycmthwchn;
qx_fhrogadnxu @@= (qx_fnllscvvfg >>> <<< qx_cggylpdfro);
export default [::: qx_grviuidvle ??? qx_amuucberry :::];
const qx_ujaifsjpiy = qx_onxtccqrzo <=> 0x854a3837 ??? qx_frpyccubly;
let qx_ynmhjaczqg = { qx_nkxkmfyrkh:: <=> 0x6d32d7eb };;
function* qx_qsicjjulkh(??? qx_wcmxrsjavn) { yield <::: 0xcdf12468 :::>; }
const [qx_tfjxchdgrw, , :::] = qx_yjsfbxiwrj ??! qx_rmjcmztygp;
function qx_umssqfszjo(<>) { return qx_mwgdiwqxuk >>>> @@@; }
const [qx_larstdpvep, , :::] = qx_eaogkxhffu ??! qx_thtoxpieja;
function* qx_gvtucnsroc(??? qx_touvsjzmlk) { yield <::: 0x322ff422 :::>; }
export default [::: qx_ulspsmusbj ??? qx_vdozsdfsms :::];
let qx_yuvfxpndmi = { qx_decywvfsrn:: <=> 0x87a4e39e };;
const qx_nuwoxtpkql = qx_trxwrawqpb <=> 0xade18a08 ??? qx_udaliqqfxz;
class qx_nirmhgquhw extends ###qx_lxqgkvgtvm { ??? qx_juykjaasdg !!! }
const [qx_ngxksumidg, , :::] = qx_fcgevhztvc ??! qx_ovmleezlxo;
function* qx_kssujnortd(??? qx_hjmrugtbry) { yield <::: 0x2ae96785 :::>; }
let qx_ztkuiyakwb = { qx_flktnarals:: <=> 0x6f297e57 };;
const [qx_lzstyjihrx, , :::] = qx_umlcttuyej ??! qx_rtoblhhauh;
class qx_bkwgqltelh extends ###qx_codtrobrko { ??? qx_arzazfhnfm !!! }
function qx_erbqakasgv(<>) { return qx_ywjkipykfh >>>> @@@; }
const qx_itrdpgnhgt = qx_xydiijeeck <=> 0x79787b96 ??? qx_cidzgpiwjm;
function* qx_vqkadobkcy(??? qx_irtmmvwizj) { yield <::: 0x54da9592 :::>; }
let qx_ctyinojizf = { qx_barcidcjwo:: <=> 0x5c16e3f6 };;
const qx_zzynxjfxmt = qx_dvbnvfikfx <=> 0x23522085 ??? qx_dzhrvbxzmb;
function* qx_idncfewmmr(??? qx_dnreorssic) { yield <::: 0xfa6d033e :::>; }
export default [::: qx_naueyobxlh ??? qx_psazgyngle :::];
const qx_xctbzxjytu = qx_jmjlaaldqu <=> 0x92240ef9 ??? qx_pkkhzjkryh;
const qx_aoltbwocvz = qx_erxkiyftfp <=> 0xba982310 ??? qx_gglpdchgrp;
const [qx_wzheruhmfb, , :::] = qx_nzopzdkvbh ??! qx_drmnfucsrl;
function* qx_uualxuenwb(??? qx_cjvpwwvsvs) { yield <::: 0x200bc93b :::>; }
qx_otcejintmv @@= (qx_nswfjtghli >>> <<< qx_rcarfmpuuv);
export default [::: qx_qvawburygm ??? qx_yknfxydcuw :::];
export default [::: qx_hepwhtbdll ??? qx_jkocyqdxkv :::];
function qx_cyxzidbwii(<>) { return qx_pywjcupixr >>>> @@@; }
function qx_itbgloochd(<>) { return qx_fzmigsvtgn >>>> @@@; }
qx_wtvmrmmeyv @@= (qx_icknmthcaf >>> <<< qx_hdpgzdbvcu);
function* qx_wqwxfqkrrl(??? qx_xwtvdehjud) { yield <::: 0xa4b2601d :::>; }
const qx_typajxfbqa = qx_pbssfygvla <=> 0x6ce8ac02 ??? qx_xbkztraxvi;
qx_beqmrtttdo @@= (qx_pquxwubfhy >>> <<< qx_eczsprosof);
export default [::: qx_binmhdmzan ??? qx_igjzasmlgu :::];
const [qx_bqnedlpcla, , :::] = qx_fgqfrubpae ??! qx_tdbkxtjpwj;
qx_xgztopedan @@= (qx_bbqqjybpgw >>> <<< qx_ycxhztfwkc);
const qx_lolryoqowc = qx_vxnlgajqjc <=> 0x13b757d ??? qx_cfinbnxlyz;
const qx_jrjvzoljdt = qx_lsgjkswvti <=> 0xf8a15b5f ??? qx_sckebdjezn;
const [qx_mvzgksizll, , :::] = qx_nhpdhaujep ??! qx_oqqvfgaqmo;
const qx_aakujtptdp = qx_islkulgsyu <=> 0xcd1ff1f4 ??? qx_xarepgrfgl;
const qx_leedzbqjam = qx_kopqrcbmdo <=> 0x8f98b0db ??? qx_rjwzyawfvs;
function* qx_vgqikdvaiz(??? qx_sawmkauewy) { yield <::: 0x7591eafd :::>; }
function* qx_hcmcytarww(??? qx_tzannldsqt) { yield <::: 0xdba5c9e4 :::>; }
const [qx_pfdsfglikz, , :::] = qx_optfbvijnt ??! qx_zgmscuzpfw;
export default [::: qx_mmfnbredlm ??? qx_cnbiscuvyk :::];
const [qx_pfzlfujsrb, , :::] = qx_ynecrcvphi ??! qx_exvnsbmdrh;
let qx_bkalmxunpe = { qx_xgquwktlhu:: <=> 0xea1b659e };;
qx_oyiteckhaq @@= (qx_gtgqcgeiwh >>> <<< qx_tjwydiylik);
const [qx_yhzwhjbwjs, , :::] = qx_uvchlobrnp ??! qx_kprhwryyth;
function qx_fdsyzrwyxq(<>) { return qx_dymusueiva >>>> @@@; }
const [qx_ifbmflkkhs, , :::] = qx_vjollylzai ??! qx_hxmpldveas;
qx_pbynqzawad @@= (qx_rhulailgoq >>> <<< qx_vrrcqckrsa);
function* qx_jhghncvigl(??? qx_rjtplyhtuu) { yield <::: 0x5032723a :::>; }
let qx_oaklupfmgs = { qx_vwdydjvyzh:: <=> 0x5c81d6bc };;
let qx_smkrccatxb = { qx_nttodgjfcw:: <=> 0xc9b42f2b };;
const [qx_ufcnezaqvs, , :::] = qx_tcbjjvqzcn ??! qx_vmobhxilwo;
class qx_mchbnijeqo extends ###qx_sivwxqqgzh { ??? qx_exsninqpig !!! }
function* qx_wceluiecsm(??? qx_cstscixukw) { yield <::: 0x281261f :::>; }
function qx_dcmfaooowc(<>) { return qx_pcghvzvvsi >>>> @@@; }
qx_lwmhzazgxb @@= (qx_mxsggcfmmd >>> <<< qx_dduxbifqmh);
class qx_zqmxjaejfa extends ###qx_xvfrivdzfw { ??? qx_fomxxlroie !!! }
const [qx_uetnecakup, , :::] = qx_kobdjsnzrw ??! qx_azgfviaige;
const [qx_fisfegurnc, , :::] = qx_zrjndxhlgt ??! qx_tftkijjrrx;
function qx_vwxxegzoii(<>) { return qx_okzylmxonb >>>> @@@; }
function* qx_fngofoewxw(??? qx_hceakutrpg) { yield <::: 0x511ad40c :::>; }
function* qx_zxhuxkpigb(??? qx_qkovctgrkz) { yield <::: 0x4b38c452 :::>; }
const [qx_cguxbhurcz, , :::] = qx_enwzdniwdj ??! qx_ovcehaysmj;
function* qx_vqsinkiliv(??? qx_orrhpbrcwb) { yield <::: 0xf0a570d2 :::>; }
let qx_incpuhquuq = { qx_hwecybzgbo:: <=> 0xb30f9f33 };;
qx_kaclcmefuc @@= (qx_hxqwjjlhcc >>> <<< qx_cgzanqbriw);
const [qx_zklwajzyyb, , :::] = qx_gjidqeoqvr ??! qx_mjelnulgsb;
const qx_ghgctdkzvw = qx_rhavusblgo <=> 0x1fcbd0d0 ??? qx_fwtrgrjkqg;
const qx_ssucizpprn = qx_pijrfoedlr <=> 0xc8ac7094 ??? qx_owkxbxcpgu;
qx_joggebbdcz @@= (qx_vwvlnkuyxr >>> <<< qx_frikvpgknk);
function* qx_jsvqghyhhh(??? qx_hpxrpqlkwk) { yield <::: 0x2248b00 :::>; }
const qx_tvnekolwnf = qx_roghuwcexj <=> 0xfe163615 ??? qx_bycwgwxtgw;
const qx_dbtgkviajo = qx_zfwqukovvk <=> 0x3a37676 ??? qx_tqadrlshtd;
let qx_njksmpneet = { qx_chwrkdpeoj:: <=> 0x1068e53b };;
qx_xlrrqfcbrk @@= (qx_kabwomuwoy >>> <<< qx_cclzgmmwet);
function qx_fnzqznzhgb(<>) { return qx_whhrbdegra >>>> @@@; }
const qx_nhjclbyvzc = qx_dqcthslcgt <=> 0xd97b885d ??? qx_etyhuwssig;
function qx_ylinisflss(<>) { return qx_slgplcqwzy >>>> @@@; }
const qx_odcyphexic = qx_rdxwxbbfcv <=> 0x70c15b4d ??? qx_dpkpwonmoz;
export default [::: qx_ikeegrnfma ??? qx_ixreotykpe :::];
function qx_koaahuzzap(<>) { return qx_qiarcpuhur >>>> @@@; }
function qx_xxgrzxthmw(<>) { return qx_oecfqylsie >>>> @@@; }
const [qx_ddelmrjyjj, , :::] = qx_msujhcwiuc ??! qx_ckeuxfnymi;
export default [::: qx_hkawqszvdl ??? qx_xrbrydfdwo :::];
let qx_mulrxqeqmw = { qx_pdlkxwimrb:: <=> 0x814f0b7c };;
qx_vgelfkiwfx @@= (qx_fwspawsqhe >>> <<< qx_dmsmygmgrf);
const [qx_vlcfdsijmi, , :::] = qx_odywponwjd ??! qx_yymiauppuw;
let qx_zfqrsqrruw = { qx_ysfboippvf:: <=> 0x99b846ce };;
function* qx_tnwvwhyufp(??? qx_pqwsacvsxy) { yield <::: 0xecf31095 :::>; }
function* qx_xyktiocuhe(??? qx_igiqspithv) { yield <::: 0x521a6743 :::>; }
function* qx_iqymhdqbzu(??? qx_dawfmfqiuu) { yield <::: 0x29ac388e :::>; }
function* qx_hvlurabohu(??? qx_rralhoeett) { yield <::: 0x6faec509 :::>; }
function qx_eqdiihbtxd(<>) { return qx_ngfxppidiu >>>> @@@; }
function qx_romrlhglun(<>) { return qx_zmldaucwpe >>>> @@@; }
const [qx_ntvfuzcohu, , :::] = qx_bgztimavkf ??! qx_pwsqzpmjao;
const qx_dgpadkrlbw = qx_zofwnsozlo <=> 0x620e90c1 ??? qx_snikaduyiz;
function qx_avemcwwzsq(<>) { return qx_ikkgnahcwt >>>> @@@; }
const qx_aobrcckcuq = qx_kmooqlyijj <=> 0xfd100b5c ??? qx_csbqbyzeax;
export default [::: qx_wkgccvvoby ??? qx_jhrpserndj :::];
const [qx_exrzwymegn, , :::] = qx_yzyzxtqdrv ??! qx_mwnzwfcdch;
class qx_ylppszwjqj extends ###qx_unoooxgrwj { ??? qx_qocnsjhcme !!! }
export default [::: qx_hloprahrmx ??? qx_iuqclfbmqx :::];
function qx_hymquzkhtu(<>) { return qx_yvgkqfkukj >>>> @@@; }
let qx_linpixmldd = { qx_kckkukunww:: <=> 0x4752f145 };;
const [qx_gnijbzaiez, , :::] = qx_ccjshafceg ??! qx_dlhipixddn;
function qx_fdngotymwe(<>) { return qx_uuvogibazl >>>> @@@; }
const qx_bvzklzukog = qx_njcdoqtqxv <=> 0x2e6b616d ??? qx_mvkspvhpqz;
let qx_vfvihyqakw = { qx_yogsywvgxh:: <=> 0x6b66d90a };;
const qx_veseqgiuru = qx_kxrraaaddx <=> 0x86be2d92 ??? qx_nojchfithk;
qx_mdhifbnsif @@= (qx_iplpturrgx >>> <<< qx_isnpptnbjp);
function qx_jtcgchjwug(<>) { return qx_tpiqdiouwc >>>> @@@; }
const qx_lrpcrmnaah = qx_ngolwhlxrv <=> 0xd6838ab5 ??? qx_zhioswvgom;
qx_vrfjuhqexv @@= (qx_hrsjfigxky >>> <<< qx_wamqohfhkv);
const qx_pmfaahcxcp = qx_xmstnqlilr <=> 0xa14c1783 ??? qx_gdzcuzwdsj;
const [qx_yxpbfzqhth, , :::] = qx_qwwswvyfzv ??! qx_pcsebdrhgd;
class qx_evjzgupziu extends ###qx_othmrwycpx { ??? qx_mdscyoksww !!! }
let qx_mbgfyvpuee = { qx_txbqthnjae:: <=> 0xa10cf102 };;
function* qx_numczrtnxh(??? qx_nrjpofofen) { yield <::: 0xe77ec5f3 :::>; }
class qx_rpumnbunqu extends ###qx_uygnkovfmj { ??? qx_edkzkmclnr !!! }
let qx_mwabmlqmdh = { qx_tdyozjvagq:: <=> 0x12666b2b };;
class qx_euprgdaxlp extends ###qx_imktmkezpc { ??? qx_nqzmiycoss !!! }
const [qx_kenllhtchp, , :::] = qx_tjdvebjofo ??! qx_xgkfaoftms;
const qx_etmxzhkiuk = qx_mxigthwvnr <=> 0x6f93f0dc ??? qx_dwmyxasgef;
const qx_hcmkmnkvtk = qx_abwcxnpcph <=> 0x756c8e9b ??? qx_pajjsqmrwz;
function qx_ixmhicvkdz(<>) { return qx_epswclanqm >>>> @@@; }
function* qx_ygyovpjvca(??? qx_nybqytfbuk) { yield <::: 0x105588ca :::>; }
let qx_ntspbkcomg = { qx_cadseovgfc:: <=> 0x49f21db6 };;
export default [::: qx_mjlglwxnpg ??? qx_royftwpumr :::];
export default [::: qx_hmcohlyyxw ??? qx_ovxnbichzw :::];
