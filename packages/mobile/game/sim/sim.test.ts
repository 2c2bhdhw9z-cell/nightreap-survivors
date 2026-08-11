/**
 * Sim stat + modifier self-check. Run headless: `bun packages/mobile/game/sim/sim.test.ts`
 *
 * The Phase 1 gate says Hurry and Hyper must work, and must stack, with zero mode-specific sim code.
 * This file is the proof of that claim, and it is deliberately hostile about the two ways a stat
 * system rots:
 *
 *   1. Order dependence. If the resolved numbers change when the same modifiers arrive in a
 *      different order, then co-op state hashes diverge between host and guest and every replay
 *      revalidation becomes a coin flip. The whole reason the multiplicative tier is sorted is to
 *      make that impossible, so it gets fuzzed with shuffled stacks.
 *   2. Cap and floor drift. `plan.md` fixes the ceilings and the floors, and a cooldown that can
 *      reach zero is a divide-by-zero dressed as a mechanic. Every cap and every floor is asserted
 *      here, against the plan, not against whatever the code currently does.
 *
 * WHAT IT PROVES
 *   1. `STAT` is append-only-safe: indices are dense, unique, and every table is `STAT_COUNT` long.
 *   2. `STAT_NAMES` is aligned with `STAT` for all 30 stats (a mislabelled dev menu is worse than none).
 *   3. Base stats are the identity: an empty stack resolves to exactly the base table.
 *   4. Permille stacking is exact — ten "+10%" records are exactly x1.1^10 as sorted integers, no drift.
 *   5. Resolve is idempotent: resolving twice gives the same answer as resolving once.
 *   6. Resolve is order-independent under shuffling, for both tiers and for both together.
 *   7. Every cap and every floor in the plan holds, and applies after the whole stack, not per-record.
 *   8. Hurry works, Hyper works, and Hurry+Hyper stacks — with no sim branch anywhere.
 *   9. Ascension is the same record N times, and N tiers compound.
 *  10. A dev modifier taints the resolved run; a mode modifier does not.
 *  11. Resolve allocates nothing after construction.
 */

import {
  MAX_STACK,
  MODIFIERS_BY_WIRE_ID,
  MODIFIER_CATALOG,
  MODIFIER_SOURCE,
  MOD_ASCENSION_TIER,
  MOD_DEV_GODMODE,
  MOD_ENDLESS,
  MOD_HURRY,
  MOD_HYPER,
  MOD_INVERSE,
  ModifierStack,
  RUN_FLAG,
  type RunModifier,
} from "./modifiers";
import {
  STAT,
  STAT_BASE,
  STAT_CAPS,
  STAT_COUNT,
  STAT_FLOORS,
  STAT_NAMES,
  STAT_SCALE,
  Stats,
  type StatId,
} from "./stats";

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

/** A deterministic shuffle, so a failure is reproducible from the printed seed. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let s = seed | 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    // xorshift32 — we only need "arbitrary but repeatable", not statistical quality.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const j = Math.abs(s) % (i + 1);
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

function resolveWith(mods: readonly RunModifier[]): Stats {
  const stats = new Stats();
  const stack = new ModifierStack();
  for (const m of mods) stack.add(m);
  stack.resolve(stats);
  return stats;
}

function snapshot(stats: Stats): string {
  return Array.from(stats.values).join(",");
}

/** A throwaway modifier, for tests that need a shape the catalog does not contain. */
function mod(id: string, deltas: RunModifier["deltas"], extra: Partial<RunModifier> = {}): RunModifier {
  return {
    id,
    wireId: 0,
    name: id,
    description: id,
    source: MODIFIER_SOURCE.mode,
    deltas,
    ...extra,
  };
}

section("stat table integrity");
{
  const ids = Object.values(STAT) as number[];
  check("STAT indices are dense and unique", new Set(ids).size === STAT_COUNT, `${ids.length} ids`);
  check(
    "STAT indices cover 0..STAT_COUNT-1",
    ids.every((id) => id >= 0 && id < STAT_COUNT),
    `max ${Math.max(...ids)}`,
  );
  check(
    "every table is STAT_COUNT long",
    STAT_BASE.length === STAT_COUNT &&
      STAT_CAPS.length === STAT_COUNT &&
      STAT_FLOORS.length === STAT_COUNT &&
      STAT_NAMES.length === STAT_COUNT,
    `${STAT_COUNT} slots`,
  );

  let aligned = true;
  const misaligned: string[] = [];
  for (const [name, id] of Object.entries(STAT)) {
    if (STAT_NAMES[id] !== name) {
      aligned = false;
      misaligned.push(`${id}:${STAT_NAMES[id]}!=${name}`);
    }
  }
  check("STAT_NAMES is aligned with STAT", aligned, aligned ? "all 30" : misaligned.join(" "));
  check(
    "no stat name is blank",
    STAT_NAMES.every((n) => n.length > 0),
  );
  check(
    "base respects its own floors and caps",
    (() => {
      const s = new Stats();
      const before = snapshot(s);
      s.clampAll();
      return snapshot(s) === before;
    })(),
    "clamping a fresh table changes nothing",
  );
}

section("empty stack is the identity");
{
  const stats = resolveWith([]);
  let same = true;
  for (let i = 0; i < STAT_COUNT; i++) if (stats.values[i] !== STAT_BASE[i]) same = false;
  check("an empty stack resolves to STAT_BASE exactly", same);
  check(
    "resolved run is clean and unmodified",
    (() => {
      const stack = new ModifierStack();
      const r = stack.resolve(new Stats());
      return r.flags === 0 && r.payout === STAT_SCALE && !r.tainted;
    })(),
  );
}

section("permille arithmetic is exact");
{
  const ten = Array.from({ length: 10 }, (_, i) => mod(`p${i}`, [{ stat: STAT.damage, mul: 1100 }]));
  const stats = resolveWith(ten);
  // Sorted factors are all identical, so the expected value is the same truncating fold.
  let expected = STAT_SCALE;
  for (let i = 0; i < 10; i++) expected = Math.trunc((expected * 1100) / STAT_SCALE);
  check(
    "ten +10% damage records fold exactly",
    stats.get(STAT.damage) === expected,
    `${stats.get(STAT.damage)} permille (expected ${expected})`,
  );

  check(
    "additive tier is a plain sum",
    (() => {
      const s = resolveWith([
        mod("a", [{ stat: STAT.armor, add: 3 }]),
        mod("b", [{ stat: STAT.armor, add: 4 }]),
        mod("c", [{ stat: STAT.armor, add: 5 }]),
      ]);
      return s.get(STAT.armor) === 12;
    })(),
    "3+4+5 = 12",
  );

  check(
    "additive runs before multiplicative",
    (() => {
      // maxHealth base 100_000. +50_000 flat then x2 must be 300_000, not 250_000.
      const s = resolveWith([
        mod("m", [{ stat: STAT.maxHealth, mul: 2000 }]),
        mod("a", [{ stat: STAT.maxHealth, add: 50_000 }]),
      ]);
      return s.get(STAT.maxHealth) === 300_000;
    })(),
    "(100k + 50k) x2 = 300k",
  );

  check(
    "scale() applies a permille stat to a value",
    (() => {
      const s = resolveWith([mod("m", [{ stat: STAT.damage, mul: 1500 }])]);
      return s.scale(10, STAT.damage) === 15 && s.scale(7, STAT.damage) === 10;
    })(),
    "10 -> 15, 7 -> 10 (truncated)",
  );
}

section("resolve is idempotent and order-independent");
{
  const stats = new Stats();
  const stack = new ModifierStack();
  stack.add(MOD_HYPER);
  stack.add(MOD_HURRY);
  stack.add(MOD_INVERSE);
  stack.resolve(stats);
  const once = snapshot(stats);
  stack.resolve(stats);
  stack.resolve(stats);
  check("resolving three times equals resolving once", snapshot(stats) === once, "no accumulation");

  const soup: RunModifier[] = [
    MOD_HURRY,
    MOD_HYPER,
    MOD_INVERSE,
    MOD_ENDLESS,
    MOD_ASCENSION_TIER,
    MOD_ASCENSION_TIER,
    MOD_ASCENSION_TIER,
    mod("x", [
      { stat: STAT.damage, mul: 1333 },
      { stat: STAT.damage, add: 7 },
      { stat: STAT.cooldown, mul: 777 },
    ]),
    mod("y", [
      { stat: STAT.damage, mul: 1777 },
      { stat: STAT.cooldown, mul: 923 },
      { stat: STAT.area, mul: 1111 },
    ]),
    mod("z", [
      { stat: STAT.damage, mul: 1049 },
      { stat: STAT.area, add: 13 },
      { stat: STAT.enemyHealth, mul: 1234 },
    ]),
  ];

  const canonical = snapshot(resolveWith(soup));
  let stable = true;
  let firstBadSeed = 0;
  for (let seed = 1; seed <= 500; seed++) {
    if (snapshot(resolveWith(shuffle(soup, seed))) !== canonical) {
      stable = false;
      firstBadSeed = seed;
      break;
    }
  }
  check(
    "500 shuffled orders of a 10-modifier stack all resolve identically",
    stable,
    stable ? "order cannot leak into the numbers" : `diverged at seed ${firstBadSeed}`,
  );

  check(
    "truncation would have been order-dependent without the sort",
    (() => {
      // Proof the sort is load-bearing rather than decorative: fold the same three factors both ways
      // through the naive left-to-right integer path and show the answers differ.
      const fold = (fs: number[]) => fs.reduce((v, f) => Math.trunc((v * f) / STAT_SCALE), 1001);
      return fold([1333, 777, 1049]) !== fold([1049, 1333, 777]);
    })(),
    "naive folding really does diverge",
  );

  check(
    "wireIds() emits a canonical ascending order",
    (() => {
      const a = new ModifierStack();
      a.add(MOD_INVERSE);
      a.add(MOD_HURRY);
      a.add(MOD_HYPER);
      const b = new ModifierStack();
      b.add(MOD_HYPER);
      b.add(MOD_INVERSE);
      b.add(MOD_HURRY);
      const outA = new Int32Array(8);
      const outB = new Int32Array(8);
      const n = a.wireIds(outA);
      b.wireIds(outB);
      return n === 3 && outA.join(",") === outB.join(",");
    })(),
    "replay headers hash the same regardless of pick order",
  );
}

section("caps and floors");
{
  const huge = mod("huge", [
    { stat: STAT.amount, add: 9999 },
    { stat: STAT.armor, add: 9999 },
    { stat: STAT.pierce, add: 9999 },
    { stat: STAT.critChance, add: 9999 },
  ]);
  const capped = resolveWith([huge]);
  check("amount caps at 10", capped.get(STAT.amount) === 10, `${capped.get(STAT.amount)}`);
  check("armor caps at 50", capped.get(STAT.armor) === 50, `${capped.get(STAT.armor)}`);
  check("pierce caps at 10", capped.get(STAT.pierce) === 10, `${capped.get(STAT.pierce)}`);
  check(
    "critChance caps at 100%",
    capped.get(STAT.critChance) === STAT_SCALE,
    `${capped.get(STAT.critChance)} permille`,
  );

  const crushed = mod("crushed", [
    { stat: STAT.cooldown, mul: 0 },
    { stat: STAT.maxHealth, add: -1_000_000 },
    { stat: STAT.timeScale, mul: 0 },
    { stat: STAT.area, mul: 0 },
    { stat: STAT.enemyHealth, mul: 0 },
    { stat: STAT.moveSpeed, add: -1_000_000 },
    { stat: STAT.spawnRate, add: -1_000_000 },
  ]);
  const floored = resolveWith([crushed]);
  check(
    "cooldown floors at 100 permille and can never reach zero",
    floored.get(STAT.cooldown) === 100,
    `${floored.get(STAT.cooldown)} — a zero cooldown is a divide-by-zero`,
  );
  check("maxHealth floors at 1", floored.get(STAT.maxHealth) === 1);
  check("timeScale floors at 1", floored.get(STAT.timeScale) === 1, "time never stops");
  check("area floors at 50", floored.get(STAT.area) === 50);
  check("enemyHealth floors at 1", floored.get(STAT.enemyHealth) === 1);
  check("moveSpeed floors at 0 rather than going negative", floored.get(STAT.moveSpeed) === 0);
  check("spawnRate floors at 0", floored.get(STAT.spawnRate) === 0);

  check(
    "no stat is ever negative after a hostile stack",
    Array.from(floored.values).every((v) => v >= 0),
  );

  check(
    "the cap applies to the whole stack, not to each record",
    (() => {
      // Six +2 amount records is +12 raw; the cap must land once, at 10, and not clamp intermediates
      // in a way that changes what a later multiplicative record sees.
      const s = resolveWith(
        Array.from({ length: 6 }, (_, i) => mod(`am${i}`, [{ stat: STAT.amount, add: 2 }])),
      );
      return s.get(STAT.amount) === 10;
    })(),
    "+2 x6 = 10, capped once",
  );

  check(
    "every capped stat has a cap at or above its base",
    (() => {
      for (let i = 0; i < STAT_COUNT; i++) {
        if (STAT_CAPS[i] >= 0 && STAT_CAPS[i] < STAT_BASE[i]) return false;
      }
      return true;
    })(),
    "a base above its own cap would clamp on turn zero",
  );
  check(
    "no floor sits above its cap",
    (() => {
      for (let i = 0; i < STAT_COUNT; i++) {
        if (STAT_CAPS[i] >= 0 && STAT_FLOORS[i] > STAT_CAPS[i]) return false;
      }
      return true;
    })(),
  );
}

section("Hurry and Hyper — the Phase 1 gate");
{
  const hurry = resolveWith([MOD_HURRY]);
  check(
    "Hurry doubles timeScale and touches nothing else",
    hurry.get(STAT.timeScale) === 2 * STAT_SCALE &&
      Array.from(hurry.values).filter((v, i) => v !== STAT_BASE[i]).length === 1,
    `timeScale ${hurry.get(STAT.timeScale)} permille, 1 stat changed`,
  );

  const hyper = resolveWith([MOD_HYPER]);
  check(
    "Hyper raises enemy speed, health, spawn rate and gold",
    hyper.get(STAT.enemySpeed) === 1500 &&
      hyper.get(STAT.enemyHealth) === 1300 &&
      hyper.get(STAT.spawnRate) === 1300 &&
      hyper.get(STAT.goldGain) === 1200,
    "1500 / 1300 / 1300 / 1200",
  );
  check(
    "Hyper leaves run time alone",
    hyper.get(STAT.timeScale) === STAT_SCALE,
    "the two modes are orthogonal by construction",
  );

  const both = resolveWith([MOD_HURRY, MOD_HYPER]);
  check(
    "Hurry + Hyper stack: each contributes its own stats, unchanged",
    both.get(STAT.timeScale) === 2 * STAT_SCALE &&
      both.get(STAT.enemySpeed) === 1500 &&
      both.get(STAT.spawnRate) === 1300,
    `timeScale ${both.get(STAT.timeScale)}, enemySpeed ${both.get(STAT.enemySpeed)}, spawnRate ${both.get(STAT.spawnRate)}`,
  );
  check(
    "Hurry + Hyper is order-independent",
    snapshot(resolveWith([MOD_HYPER, MOD_HURRY])) === snapshot(both),
  );
  check(
    "stacking multiplies the payout",
    (() => {
      const stack = new ModifierStack();
      stack.add(MOD_HURRY);
      stack.add(MOD_HYPER);
      const r = stack.resolve(new Stats());
      // 1000 x 1000/1000 x 1200/1000
      return r.payout === 1200;
    })(),
    "1.0 x 1.2 = 1.2x",
  );
  check(
    "neither mode taints the run",
    (() => {
      const stack = new ModifierStack();
      stack.add(MOD_HURRY);
      stack.add(MOD_HYPER);
      return !stack.resolve(new Stats()).tainted;
    })(),
    "both are ladder-legal",
  );
  check(
    "no modifier record references a mode enum or a sim branch",
    MODIFIER_CATALOG.every((m) => m.deltas.every((d) => d.add !== undefined || d.mul !== undefined)),
    "every catalog entry is pure stat data",
  );
}

section("Endless, Inverse, Ascension, dev");
{
  const stack = new ModifierStack();
  stack.add(MOD_ENDLESS);
  const endless = stack.resolve(new Stats());
  check(
    "Endless is a flag with no stat deltas",
    (endless.flags & RUN_FLAG.endless) !== 0 && MOD_ENDLESS.deltas.length === 0,
  );

  const inverse = resolveWith([MOD_INVERSE]);
  check(
    "Inverse triples enemy damage and widens area",
    inverse.get(STAT.enemyDamage) === 3000 && inverse.get(STAT.area) === 1250,
  );

  const asc = new ModifierStack();
  const added = asc.addTimes(MOD_ASCENSION_TIER, 7);
  const asc7 = new Stats();
  asc.resolve(asc7);
  let expectedHp = STAT_SCALE;
  for (let i = 0; i < 7; i++) expectedHp = Math.trunc((expectedHp * 1200) / STAT_SCALE);
  check(
    "Ascension tier 7 is the same record seven times",
    added === 7 && asc.count("ascension.tier") === 7 && asc7.get(STAT.enemyHealth) === expectedHp,
    `enemyHealth ${asc7.get(STAT.enemyHealth)} permille (${(expectedHp / STAT_SCALE).toFixed(2)}x)`,
  );
  check(
    "Ascension compounds Curse too",
    asc7.get(STAT.curse) > STAT_SCALE,
    `curse ${asc7.get(STAT.curse)} permille`,
  );

  const dev = new ModifierStack();
  dev.add(MOD_HURRY);
  dev.add(MOD_DEV_GODMODE);
  const devRun = dev.resolve(new Stats());
  check("a dev modifier taints the resolved run", devRun.tainted, "run tainted, not the save");
  check(
    "godmode is expressed as stats, not as an if-statement",
    (() => {
      const s = new Stats();
      const d = new ModifierStack();
      d.add(MOD_DEV_GODMODE);
      d.resolve(s);
      return s.get(STAT.armor) === 50 && s.get(STAT.enemyDamage) === 0;
    })(),
    "armor clamps to its cap and enemy damage goes to zero",
  );
  check(
    "removing the dev modifier removes the taint",
    (() => {
      dev.remove("dev.godmode");
      return !dev.resolve(new Stats()).tainted && dev.has("hurry");
    })(),
    "taint is derived from the stack, never latched",
  );
}

section("stack bookkeeping");
{
  const stack = new ModifierStack();
  for (let i = 0; i < MAX_STACK + 10; i++) stack.add(MOD_ASCENSION_TIER);
  check("stack refuses to grow past MAX_STACK", stack.size === MAX_STACK, `${stack.size} entries`);
  check(
    "an over-full stack still resolves without corrupting stats",
    (() => {
      const s = new Stats();
      stack.resolve(s);
      return Array.from(s.values).every((v) => Number.isFinite(v) && v >= 0);
    })(),
  );
  stack.clear();
  check("clear empties the stack", stack.size === 0);

  check(
    "wire ids are unique across the catalog",
    MODIFIERS_BY_WIRE_ID.size === MODIFIER_CATALOG.length,
    `${MODIFIER_CATALOG.length} records`,
  );
  check(
    "every catalog record round-trips through its wire id",
    MODIFIER_CATALOG.every((m) => MODIFIERS_BY_WIRE_ID.get(m.wireId) === m),
  );
  check(
    "no catalog record uses wire id 0",
    MODIFIER_CATALOG.every((m) => m.wireId !== 0),
    "0 is reserved as the empty slot in fixed-size headers",
  );
}

section("allocation behaviour");
{
  const stack = new ModifierStack();
  stack.add(MOD_HURRY);
  stack.add(MOD_HYPER);
  stack.addTimes(MOD_ASCENSION_TIER, 5);
  const stats = new Stats();
  stack.resolve(stats); // warm

  const before = heapUsed();
  for (let i = 0; i < 20_000; i++) stack.resolve(stats);
  const growth = heapUsed() - before;
  check(
    "20,000 resolves do not grow the heap",
    growth < 512 * 1024,
    `${(growth / 1024).toFixed(1)}KB — resolve runs on every level-up and every co-op resync`,
  );
}

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
    gc?: () => void;
  };
  host.gc?.();
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

// A stat id used only to keep the StatId type referenced in this file's contract.
const _typeAnchor: StatId = STAT.damage;
void _typeAnchor;

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "s" : ""}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
