/**
 * Measure what a run actually reaches, minute by minute.
 *
 * WHY THIS EXISTS
 * `reaperSecond` decides how long a run is, and several systems are quietly gated behind reaching a
 * given minute: arcana offers land at 4:00, 12:00 and 22:00 (`ARCANA_MINUTE_MARKS`), stage unlocks
 * want 15 or 20 minutes (`stages.ts`), and a weapon needs level 8 plus a passive before it can evolve
 * (`weapons.ts`). Shortening a run therefore deletes content — but "how much" is an empirical
 * question, not an opinion. This answers it.
 *
 * HOW IT DRIVES THE RUN
 * The player walks a slow circle, because standing still collects no gems and would measure a
 * progression floor of nearly zero. `autoPick` takes the first card every time, which is neither
 * optimal nor random — a real player picks better. So read these as "roughly this much happens by
 * minute N", not as a skilled ceiling.
 *
 * USAGE
 *   bun tools/measure-xp-curve.ts [seed]
 */

import { Run } from "../packages/mobile/game/run/run";
import { MOD_DEV_GODMODE } from "../packages/mobile/game/sim/modifiers";
import { MAX_WEAPON_LEVEL } from "../packages/mobile/game/sim/weapons";
import { ARCANA_MINUTE_MARKS } from "../packages/mobile/game/sim/arcanas";

const TICKS_PER_SECOND = 60;
const SEED = Number(process.argv[2] ?? 20260830);

/** Minutes to report at. Chosen to bracket every gate that exists today. */
const MARKS_MIN = [4, 5, 10, 12, 15, 20, 22, 25, 30];

/** Ticks per lap of the circle the player walks. Slow enough to sweep gems, fast enough to roam. */
const LAP_TICKS = 8 * TICKS_PER_SECOND;

interface Row {
  minute: number;
  level: number;
  kills: number;
  weapons: number;
  bestWeapon: number;
  maxedWeapons: number;
  gold: number;
}

const run = new Run();
run.begin({ seed: SEED, modifiers: [MOD_DEV_GODMODE], record: false, autoPick: true });

const rows: Row[] = [];
let tick = 0;
let endedAt = -1;

for (const minute of MARKS_MIN) {
  const target = minute * 60 * TICKS_PER_SECOND;
  while (tick < target) {
    // Walk a circle. Integer brads through the same table the sim uses, so this driver cannot itself
    // be a source of cross-engine difference if anyone ever compares two runs of this tool.
    const phase = ((tick % LAP_TICKS) / LAP_TICKS) * Math.PI * 2;
    run.setStick(0, Math.cos(phase), Math.sin(phase));

    if (run.paused) {
      run.pickCard(0);
      continue;
    }
    if (run.over) {
      endedAt = tick;
      break;
    }
    run.tick();
    tick++;
  }
  if (endedAt >= 0) break;

  const w = run.weapons;
  let best = 0;
  let maxed = 0;
  let held = 0;
  for (let i = 0; i < w.level.length; i++) {
    const lvl = w.level[i] ?? 0;
    if (lvl > 0) held++;
    if (lvl > best) best = lvl;
    if (lvl >= MAX_WEAPON_LEVEL) maxed++;
  }

  rows.push({
    minute,
    level: run.prog.level,
    kills: run.kills,
    weapons: held,
    bestWeapon: best,
    maxedWeapons: maxed,
    gold: run.prog.gold,
  });
}

console.log(`seed ${SEED} · godmode · walking a circle · autoPick takes card 0\n`);
console.log("  min | level | kills  | weapons | best lvl | maxed | gold");
console.log("  ----+-------+--------+---------+----------+-------+-------");
for (const r of rows) {
  console.log(
    `  ${String(r.minute).padStart(3)} | ${String(r.level).padStart(5)} | ${String(r.kills).padStart(6)} | ` +
      `${String(r.weapons).padStart(7)} | ${String(r.bestWeapon).padStart(8)} | ` +
      `${String(r.maxedWeapons).padStart(5)} | ${String(r.gold).padStart(5)}`,
  );
}

if (endedAt >= 0) {
  console.log(`\nrun ended at tick ${endedAt} (${(endedAt / TICKS_PER_SECOND / 60).toFixed(1)} min)`);
}

const at15 = rows.find((r) => r.minute === 15);
const at30 = rows.find((r) => r.minute === 30);
if (at15 && at30) {
  const pct = (a: number, b: number) => `${((a / Math.max(b, 1)) * 100).toFixed(0)}%`;
  console.log(`\nwhat capping a run at 15 minutes costs, on this seed:`);
  console.log(`  level:         ${at15.level} of ${at30.level}   (${pct(at15.level, at30.level)})`);
  console.log(`  kills:         ${at15.kills} of ${at30.kills}   (${pct(at15.kills, at30.kills)})`);
  console.log(`  best weapon:   ${at15.bestWeapon} of ${at30.bestWeapon}  (max is ${MAX_WEAPON_LEVEL})`);
  console.log(`  maxed weapons: ${at15.maxedWeapons} of ${at30.maxedWeapons}  (each one is an evolution that cannot happen)`);
  console.log(`  gold:          ${at15.gold} of ${at30.gold}   (${pct(at15.gold, at30.gold)})`);
}

const reachable = ARCANA_MINUTE_MARKS.filter((s) => s <= 15 * 60).length;
console.log(
  `\narcana offers reachable in a 15-minute run: ${reachable} of ${ARCANA_MINUTE_MARKS.length}` +
    `  (marks at ${ARCANA_MINUTE_MARKS.map((s) => `${s / 60}:00`).join(", ")})`,
);
