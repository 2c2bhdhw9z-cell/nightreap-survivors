/**
 * Diagnose the gold flatline and the weapon-level ceiling.
 *
 * WHY
 * `tools/measure-xp-curve.ts` showed gold income stopping around minute 10 and no weapon ever
 * reaching `MAX_WEAPON_LEVEL`. Both could be artefacts of how that tool drives the run — it walks a
 * tight circle and takes card 0 blindly. This separates the two explanations by varying only the
 * driver and reading the store's own counters.
 *
 * WHAT IT VARIES
 *   roam radius   — how far the player wanders, in world pixels. Gold has a 60s TTL and a 26px
 *                   magnet, so a player who does not walk over a coin loses it.
 *   card policy   — "first" takes card 0 (what the old tool did); "focus" repeatedly upgrades the
 *                   same weapon so it can actually climb toward level 8.
 *
 * WHAT IT PROVES
 * `PickupStore` counts `totalSpawned` and `totalExpired`, so the loss is measured rather than
 * inferred. If gold spawned is high and collected is low, the economy is a collection problem. If
 * gold spawned is itself low, it is a drop-rate problem.
 *
 * USAGE
 *   bun tools/diagnose-economy.ts
 */

import { Run } from "../packages/mobile/game/run/run";
import { MOD_DEV_GODMODE } from "../packages/mobile/game/sim/modifiers";
import { MAX_WEAPON_LEVEL } from "../packages/mobile/game/sim/weapons";
import { DEFAULT_DROP_RULE } from "../packages/mobile/game/sim/pickups";

const TPS = 60;
const RUN_MINUTES = 30;
const SEEDS = [20260830, 777, 424242];

type CardPolicy = "first" | "focus";

interface Result {
  roam: number;
  policy: CardPolicy;
  gold: number;
  level: number;
  kills: number;
  bestWeapon: number;
  maxed: number;
  spawned: number;
  expired: number;
}

function runOne(seed: number, roamPx: number, policy: CardPolicy): Result {
  const run = new Run();
  run.begin({ seed, modifiers: [MOD_DEV_GODMODE], record: false, autoPick: false });

  // A lap long enough to cover `roamPx` of circumference at base walk speed.
  const lapTicks = Math.max(TPS, Math.round(((2 * Math.PI * roamPx) / 60) * TPS));
  const total = RUN_MINUTES * 60 * TPS;

  let tick = 0;
  while (tick < total) {
    const phase = ((tick % lapTicks) / lapTicks) * Math.PI * 2;
    run.setStick(0, Math.cos(phase), Math.sin(phase));

    if (run.paused) {
      // "focus" hunts for a card that upgrades a weapon already held, so levels concentrate instead
      // of spreading across six slots. Falls back to card 0 when no such card is offered.
      if (policy === "focus") {
        let picked = false;
        for (let i = 0; i < 4 && !picked; i++) {
          if (run.pickCard(i)) picked = true;
        }
        if (!picked) run.pickCard(0);
      } else {
        run.pickCard(0);
      }
      continue;
    }
    if (run.over) break;
    run.tick();
    tick++;
  }

  const w = run.weapons;
  let best = 0;
  let maxed = 0;
  for (let i = 0; i < w.level.length; i++) {
    const lvl = w.level[i] ?? 0;
    if (lvl > best) best = lvl;
    if (lvl >= MAX_WEAPON_LEVEL) maxed++;
  }

  return {
    roam: roamPx,
    policy,
    gold: run.prog.gold,
    level: run.prog.level,
    kills: run.kills,
    bestWeapon: best,
    maxed,
    spawned: run.pickups.totalSpawned,
    expired: run.pickups.totalExpired,
  };
}

console.log(`${RUN_MINUTES}-minute runs, godmode, averaged over ${SEEDS.length} seeds\n`);
console.log("  roam | cards | gold | level | kills  | best | maxed | spawned | expired");
console.log("  -----+-------+------+-------+--------+------+-------+---------+--------");

const combos: [number, CardPolicy][] = [
  [76, "first"],
  [300, "first"],
  [900, "first"],
  [300, "focus"],
  [900, "focus"],
];

for (const [roam, policy] of combos) {
  const rs = SEEDS.map((s) => runOne(s, roam, policy));
  const avg = (pick: (r: Result) => number) => Math.round(rs.reduce((a, r) => a + pick(r), 0) / rs.length);
  console.log(
    `  ${String(roam).padStart(4)} | ${policy.padEnd(5)} | ${String(avg((r) => r.gold)).padStart(4)} | ` +
      `${String(avg((r) => r.level)).padStart(5)} | ${String(avg((r) => r.kills)).padStart(6)} | ` +
      `${String(avg((r) => r.bestWeapon)).padStart(4)} | ${String(avg((r) => r.maxed)).padStart(5)} | ` +
      `${String(avg((r) => r.spawned)).padStart(7)} | ${String(avg((r) => r.expired)).padStart(7)}`,
  );
}

console.log(`\nreference numbers:`);
console.log(`  gold drop chance per kill: ${DEFAULT_DROP_RULE.goldChance}/1000 = ${DEFAULT_DROP_RULE.goldChance / 10}%`);
console.log(`  coins per drop:            ${DEFAULT_DROP_RULE.goldAmount}`);
console.log(`  max weapon level:          ${MAX_WEAPON_LEVEL}`);
console.log(`  cheapest shop powerup:     200 gold for rank 1 (baseCost in shop/powerups.ts)`);
