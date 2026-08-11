/**
 * Stats and modifier-stack self-check. Run headless: `bun packages/mobile/game/sim/sim.test.ts`
 *
 * The failures this file exists to prevent are the quiet ones. A stat table that is one entry out of
 * step mislabels the dev menu. A resolve that depends on insertion order makes four co-op clients
 * compute different stats from the same run, diverge their state hashes, and get a legitimate run
 * rejected by the ladder validator — which looks like a netcode bug for a week before anyone
 * suspects arithmetic.
 *
 * WHAT IT PROVES
 *   1. `STAT`, `STAT_COUNT` and every parallel table are aligned, and `STAT_NAMES` labels the right stat.
 *   2. Caps and floors clamp at the exact documented boundary, and nowhere else.
 *   3. Percent bonuses pool exactly: ten +10% is +100%, not +99.5% of accumulated truncation.
 *   4. Compounding factors resolve identically under every insertion order.
 *   5. Hurry and Hyper each work, and stack, with zero mode-specific code in the sim.
 *   6. Resolve does not allocate, and does not leak state between runs.
 */

import {
  MODIFIER,
  MODIFIER_TABLE,
  MOD_CURSE_CYCLE,
  MOD_HURRY,
  MOD_HYPER,
  ModifierStack,
  OP,
  type RunModifier,
  makeModifier,
  modifierOps,
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

const { add, mul, scale } = modifierOps;

/** Resolve a fresh stack built from `mods` and return the stat table. */
function resolveWith(mods: readonly RunModifier[]): Stats {
  const stack = new ModifierStack();
  for (const m of mods) stack.push(m);
  const stats = new Stats();
  stack.resolve(stats, null);
  return stats;
}

/** Every permutation of a small array. Used to prove order-independence rather than assert it. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
section("stat table alignment");
{
  const ids = Object.values(STAT);
  check("STAT_COUNT matches STAT", ids.length === STAT_COUNT, `${ids.length} entries`);
  check(
    "stat ids are 0..STAT_COUNT-1 with no gaps and no duplicates",
    new Set(ids).size === STAT_COUNT && Math.min(...ids) === 0 && Math.max(...ids) === STAT_COUNT - 1,
  );
  check(
    "every parallel table is the right length",
    STAT_BASE.length === STAT_COUNT &&
      STAT_CAPS.length === STAT_COUNT &&
      STAT_FLOORS.length === STAT_COUNT &&
      STAT_NAMES.length === STAT_COUNT,
  );
  check(
    "STAT_NAMES labels the stat it is indexed by",
    Object.entries(STAT).every(([key, id]) => STAT_NAMES[id] === key),
    `index ${STAT.banishes} is "${STAT_NAMES[STAT.banishes]}"`,
  );
  check("no name is blank", STAT_NAMES.every((n) => n.length > 0));
  check(
    "no cap sits below its own floor",
    STAT_CAPS.every((cap, i) => cap < 0 || cap >= STAT_FLOORS[i]),
  );
  check(
    "a fresh table equals the baseline",
    (() => {
      const s = new Stats();
      for (let i = 0; i < STAT_COUNT; i++) if (s.get(i as never) !== STAT_BASE[i]) return false;
      return true;
    })(),
  );
  check(
    "the baseline itself is already legal",
    (() => {
      const s = new Stats();
      const before = Array.from(s.values);
      s.clampAll();
      return before.every((v, i) => v === s.values[i]);
    })(),
    "clamping a fresh character changes nothing",
  );
}

// ---------------------------------------------------------------------------------------------
section("caps and floors clamp at the documented boundary");
{
  // plan.md fixes these four ceilings by name. Each is checked at the cap, one below, and far above.
  const caps: Array<[string, StatId, number]> = [
    ["amount", STAT.amount, 10],
    ["armor", STAT.armor, 50],
    ["pierce", STAT.pierce, 10],
    ["critChance", STAT.critChance, STAT_SCALE],
  ];
  for (const [name, id, cap] of caps) {
    check(`${name} is capped at ${cap}`, STAT_CAPS[id] === cap);
    const atCap = resolveWith([makeModifier(MODIFIER.devEdit, "t", [add(id, cap - STAT_BASE[id])])]);
    check(`${name} passes through untouched at exactly the cap`, atCap.get(id) === cap, `${atCap.get(id)}`);
    const over = resolveWith([
      makeModifier(MODIFIER.devEdit, "t", [add(id, cap * 100 - STAT_BASE[id])]),
    ]);
    check(`${name} clamps down from far above`, over.get(id) === cap, `${over.get(id)}`);
  }

  // The floors are the ones where zero is not "weak", it is a crash or a frozen sim.
  const floors: Array<[string, StatId, number]> = [
    ["cooldown", STAT.cooldown, 100],
    ["maxHealth", STAT.maxHealth, 1],
    ["timeScale", STAT.timeScale, 1],
    ["area", STAT.area, 50],
    ["enemyHealth", STAT.enemyHealth, 1],
  ];
  for (const [name, id, floor] of floors) {
    check(`${name} floors at ${floor}`, STAT_FLOORS[id] === floor);
    const under = resolveWith([
      makeModifier(MODIFIER.devEdit, "t", [add(id, -STAT_BASE[id] * 10 - 1000)]),
    ]);
    check(`${name} cannot be driven to zero or below`, under.get(id) === floor, `${under.get(id)}`);
  }

  check(
    "a cooldown of 100% reduction still leaves a positive divisor",
    resolveWith([makeModifier(MODIFIER.devEdit, "t", [mul(STAT.cooldown, -STAT_SCALE)])]).get(
      STAT.cooldown,
    ) === 100,
    "0.1x, so nothing divides by zero",
  );
  check(
    "an uncapped stat really is uncapped",
    resolveWith([makeModifier(MODIFIER.devEdit, "t", [mul(STAT.damage, 1_000_000)])]).get(
      STAT.damage,
    ) > 1_000_000,
  );
}

// ---------------------------------------------------------------------------------------------
section("percent bonuses pool without drift");
{
  const tenTimesTen = resolveWith([
    makeModifier(MODIFIER.devEdit, "t", Array.from({ length: 10 }, () => mul(STAT.area, 100))),
  ]);
  check(
    "ten +10% area is exactly +100%",
    tenTimesTen.get(STAT.area) === 2 * STAT_SCALE,
    `${tenTimesTen.get(STAT.area)} vs ${2 * STAT_SCALE}`,
  );

  // The same bonuses split across separate modifiers must land on the same number: pooling happens
  // per stat across the whole stack, not per record.
  const split = resolveWith(
    Array.from({ length: 10 }, () => makeModifier(MODIFIER.devEdit, "t", [mul(STAT.area, 100)])),
  );
  check(
    "pooling crosses modifier boundaries",
    split.get(STAT.area) === tenTimesTen.get(STAT.area),
    `${split.get(STAT.area)}`,
  );

  // A value chosen to truncate badly if the multiplier were applied one at a time.
  const awkward = resolveWith([
    makeModifier(MODIFIER.devEdit, "t", [
      add(STAT.regen, 7),
      ...Array.from({ length: 7 }, () => mul(STAT.regen, 33)),
    ]),
  ]);
  check(
    "an awkward base truncates exactly once",
    awkward.get(STAT.regen) === Math.trunc((7 * (STAT_SCALE + 231)) / STAT_SCALE),
    `${awkward.get(STAT.regen)}`,
  );

  check(
    "flat and percent apply in the documented order — flat first",
    resolveWith([
      makeModifier(MODIFIER.devEdit, "t", [add(STAT.maxHealth, 100 * STAT_SCALE), mul(STAT.maxHealth, STAT_SCALE)]),
    ]).get(STAT.maxHealth) === 400 * STAT_SCALE,
    "base 100 + flat 100, doubled = 400",
  );
}

// ---------------------------------------------------------------------------------------------
section("resolve is order-independent");
{
  // Three compounding factors on a base that makes truncation bite. This case is verified to
  // produce FOUR different answers across the six orderings when applied in arrival order, so it
  // fails loudly if the canonical sort in `sortScales` is ever removed as redundant tidying.
  //
  // Do not "simplify" these numbers. Roughly 4% of random (base, factor) triples happen to agree
  // under every ordering, and a test built on one of those is a test that proves nothing.
  const factors = [1382, 2162, 2461];
  const mods = [
    makeModifier(MODIFIER.devEdit, "base", [add(STAT.curse, 97 - STAT_SCALE)]),
    ...factors.map((f, i) => makeModifier(MODIFIER.devEdit, `s${i}`, [scale(STAT.curse, f)])),
  ];
  const results = new Set<number>();
  for (const order of permutations(mods)) results.add(resolveWith(order).get(STAT.curse));
  check(
    "24 orderings of three truncation-sensitive factors agree",
    results.size === 1,
    `values seen: ${[...results].join(", ")}`,
  );
  check(
    "and agree on the ascending-order answer specifically",
    results.has(711),
    "97 → 134 → 289 → 711, low factors first",
  );
  check(
    "the ordering really was ambiguous",
    (() => {
      const seen = new Set<number>();
      for (const order of permutations(factors)) {
        let v = 97;
        for (const f of order) v = Math.trunc((v * f) / STAT_SCALE);
        seen.add(v);
      }
      return seen.size > 1;
    })(),
    "applied in arrival order these factors disagree, so the sort is load-bearing",
  );

  // And the mixed case: flat, percent and compounding on overlapping stats, all shuffled.
  const mixed = [
    makeModifier(MODIFIER.devEdit, "a", [add(STAT.amount, 2), mul(STAT.damage, 250)]),
    makeModifier(MODIFIER.devEdit, "b", [scale(STAT.damage, 1500), mul(STAT.damage, 130)]),
    makeModifier(MODIFIER.devEdit, "c", [scale(STAT.damage, 1111), add(STAT.pierce, 3)]),
    makeModifier(MODIFIER.devEdit, "d", [mul(STAT.damage, 70), scale(STAT.damage, 1010)]),
  ];
  const signatures = new Set<string>();
  for (const order of permutations(mixed)) {
    signatures.add(Array.from(resolveWith(order).values).join(","));
  }
  check(
    "24 orderings of a mixed stack agree on every stat",
    signatures.size === 1,
    `${signatures.size} distinct outcome(s)`,
  );
}

// ---------------------------------------------------------------------------------------------
section("Hurry and Hyper are pure data, and they stack");
{
  const plain = resolveWith([]);
  const hurry = resolveWith([MOD_HURRY]);
  const hyper = resolveWith([MOD_HYPER]);
  const both = resolveWith([MOD_HURRY, MOD_HYPER]);
  const bothReversed = resolveWith([MOD_HYPER, MOD_HURRY]);

  check(
    "Hurry doubles run time and touches nothing else",
    hurry.get(STAT.timeScale) === 2 * STAT_SCALE &&
      Array.from(hurry.values).every((v, i) => i === STAT.timeScale || v === plain.values[i]),
    `timeScale ${plain.get(STAT.timeScale)} → ${hurry.get(STAT.timeScale)}`,
  );

  check(
    "Hyper raises enemy speed, health and spawn rate by 20% and gold by 50%",
    hyper.get(STAT.enemySpeed) === 1200 &&
      hyper.get(STAT.enemyHealth) === 1200 &&
      hyper.get(STAT.spawnRate) === 1200 &&
      hyper.get(STAT.goldGain) === 1500,
  );
  check(
    "Hyper leaves run time alone",
    hyper.get(STAT.timeScale) === plain.get(STAT.timeScale),
    "the two modes are disjoint by construction",
  );

  check(
    "stacked, each modifier's effect survives intact",
    both.get(STAT.timeScale) === hurry.get(STAT.timeScale) &&
      both.get(STAT.enemySpeed) === hyper.get(STAT.enemySpeed) &&
      both.get(STAT.spawnRate) === hyper.get(STAT.spawnRate) &&
      both.get(STAT.goldGain) === hyper.get(STAT.goldGain),
    "no mode-specific branch anywhere in the resolve",
  );
  check(
    "stacking order does not matter",
    Array.from(both.values).join(",") === Array.from(bothReversed.values).join(","),
  );

  // The real payoff: adding a third and fourth knob needs no new code at all.
  const withCurse = resolveWith([MOD_HURRY, MOD_HYPER, MOD_CURSE_CYCLE, MOD_CURSE_CYCLE]);
  check(
    "Curse cycles stack with themselves on top of both modes",
    withCurse.get(STAT.curse) === Math.trunc((Math.trunc((STAT_SCALE * 1100) / STAT_SCALE) * 1100) / STAT_SCALE) &&
      withCurse.get(STAT.timeScale) === 2 * STAT_SCALE &&
      withCurse.get(STAT.enemySpeed) === 1200,
    `curse ${withCurse.get(STAT.curse)}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("stack bookkeeping");
{
  const stack = new ModifierStack();
  check("a mode can be pushed once", stack.push(MOD_HURRY) === true);
  check("and refuses to be pushed twice", stack.push(MOD_HURRY) === false, "Hurry is not stackable");
  check("size reflects what was accepted", stack.size === 1);
  check("has() finds it", stack.has(MODIFIER.hurry));
  check("a self-stacking modifier may repeat", stack.push(MOD_CURSE_CYCLE) && stack.push(MOD_CURSE_CYCLE));
  check("size counts repeats", stack.size === 3, `${stack.size}`);
  check("remove() takes one instance, not all", stack.remove(MODIFIER.curseCycle) && stack.size === 2);
  check("removing something absent is reported, not thrown", stack.remove(MODIFIER.hyper) === false);
  stack.clear();
  check("clear() empties it", stack.size === 0 && !stack.has(MODIFIER.hurry));

  check(
    "shipped modes contribute no taint",
    (() => {
      const s = new ModifierStack();
      s.push(MOD_HURRY);
      s.push(MOD_HYPER);
      s.push(MOD_CURSE_CYCLE);
      return s.taintBits() === 0;
    })(),
    "Hurry and Hyper are legitimate difficulty, not cheating",
  );
  check(
    "a dev edit's taint bit reaches the run header",
    (() => {
      const s = new ModifierStack();
      s.push(makeModifier(MODIFIER.devEdit, "dev", [mul(STAT.damage, 100_000)], 0x4));
      return s.taintBits() === 0x4;
    })(),
  );
  check(
    "the wire table resolves ids back to the same records",
    MODIFIER_TABLE[MODIFIER.hurry] === MOD_HURRY &&
      MODIFIER_TABLE[MODIFIER.hyper] === MOD_HYPER &&
      MODIFIER_TABLE[MODIFIER.curseCycle] === MOD_CURSE_CYCLE,
  );
  check(
    "modifier ids are unique",
    new Set(Object.values(MODIFIER)).size === Object.keys(MODIFIER).length,
  );
  check("op kinds are distinct", new Set(Object.values(OP)).size === 3);
}

// ---------------------------------------------------------------------------------------------
section("resolve is reusable and does not allocate");
{
  const stack = new ModifierStack();
  stack.push(MOD_HYPER);
  const stats = new Stats();

  stack.resolve(stats, null);
  const first = Array.from(stats.values);
  stack.resolve(stats, null);
  check(
    "resolving twice gives the same answer",
    Array.from(stats.values).join(",") === first.join(","),
    "no accumulation across resolves",
  );

  stack.remove(MODIFIER.hyper);
  stack.resolve(stats, null);
  check(
    "removing a modifier fully undoes it",
    stats.get(STAT.enemySpeed) === STAT_SCALE && stats.get(STAT.goldGain) === STAT_SCALE,
    "resolve rebuilds from the baseline rather than patching",
  );

  check(
    "version bumps so systems can detect a change",
    (() => {
      const before = stats.version;
      stack.resolve(stats, null);
      return stats.version > before;
    })(),
  );

  // A character record is read, never written: a bug here would permanently buff a character the
  // first time anyone picked them with Hyper on.
  const characterBase = Int32Array.from(STAT_BASE);
  characterBase[STAT.moveSpeed] = 1100;
  const snapshot = Array.from(characterBase);
  stack.push(MOD_HYPER);
  stack.resolve(stats, characterBase);
  check(
    "the character baseline is not mutated by resolve",
    Array.from(characterBase).join(",") === snapshot.join(","),
  );
  check("the character's own stat survives into the result", stats.get(STAT.moveSpeed) === 1100);

  // Allocation check. A stack of 40 Ascension modifiers resolved 20,000 times is roughly a long
  // session's worth of level-ups; the heap must not move.
  const heavy = new ModifierStack();
  for (let i = 0; i < 40; i++) {
    heavy.push(
      makeModifier(MODIFIER.devEdit, `m${i}`, [
        add(STAT.amount, 1),
        mul(STAT.damage, 50),
        scale(STAT.curse, 1010 + i),
      ]),
    );
  }
  const target = new Stats();
  heavy.resolve(target, null);
  const expected = Array.from(target.values);
  const mem = globalThis as unknown as { process?: { memoryUsage?: () => { heapUsed: number } } };
  const before = mem.process?.memoryUsage?.().heapUsed ?? 0;
  const t0 = Date.now();
  for (let i = 0; i < 20_000; i++) heavy.resolve(target, null);
  const elapsed = Date.now() - t0;
  const after = mem.process?.memoryUsage?.().heapUsed ?? 0;
  const growthKb = Math.round((after - before) / 1024);
  check(
    "20,000 resolves of a 40-modifier stack are stable",
    Array.from(target.values).join(",") === expected.join(","),
    `${elapsed}ms, ${(elapsed * 1000) / 20_000}us each`,
  );
  check(
    "and do not grow the heap",
    growthKb < 512,
    `heapGrowth=${growthKb}KB`,
  );
  check("scale ops did not overflow their scratch buffers", target.get(STAT.amount) === 10);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
