/**
 * Reaper ending sequence — the VS-shaped close of a normal run.
 *
 * Run: bun packages/mobile/game/run/reaper.test.ts
 */

import { Run, WHITE_HAND_TICKS } from "./run";
import { MOD_DEV_GODMODE } from "../sim/modifiers";
import { RUN_END, isCompletion } from "../sim/results";
import { CUE } from "../sim/cues";
import { ENEMY_TYPE_BY_ID } from "../sim/enemies";
import { REAPER_SECOND, TICKS_PER_SECOND } from "../sim/waves";
import { EGGS_PER_REAPER_KILL, MAX_GOLDEN_EGGS, clampEggs, eggBonusPermille } from "../sim/eggs";
import { PLAYER_STATE } from "../sim/player";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function drive(run: Run, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    run.setStick(0, 1, 0);
    if (run.paused) run.pickCard(0);
    else run.tick();
  }
}

const REAPER_ID = "nightreaper";
const reaperType = ENEMY_TYPE_BY_ID.get(REAPER_ID);

section("eggs curve is capped and Int32-safe");
{
  check("zero eggs grant nothing", eggBonusPermille(0) === 0);
  check("eggs clamp at the hard cap", clampEggs(MAX_GOLDEN_EGGS + 50) === MAX_GOLDEN_EGGS);
  const atCap = eggBonusPermille(MAX_GOLDEN_EGGS);
  const beyond = eggBonusPermille(MAX_GOLDEN_EGGS * 10);
  check("bonus does not grow past the cap", atCap === beyond, `${atCap} vs ${beyond}`);
  check("bonus at cap is well under a 1000‰ multiplier", atCap < 600, `${atCap}`);
  check("five eggs per kill is the genre number", EGGS_PER_REAPER_KILL === 5);
}

section("Reaper arrives at the stage limit, not twelve seconds of White Hand");
{
  check("nightreaper content exists", reaperType !== undefined, `${reaperType}`);

  const run = new Run();
  run.begin({ seed: 10, modifiers: [MOD_DEV_GODMODE], record: false });
  run.waves.jumpToSecond(REAPER_SECOND);
  drive(run, 2);

  check("first Reaper has spawned", run.waves.reaperSpawned);
  check("reaper count is one", run.waves.reaperCount === 1, `${run.waves.reaperCount}`);
  check("White Hand has NOT started on spawn", run.whiteHandTicks < 0, `${run.whiteHandTicks}`);
  check("run is still going", run.end === RUN_END.running);

  let live = 0;
  if (reaperType !== undefined) {
    const slots = run.enemies.slots;
    for (let i = 0; i < run.enemies.count; i++) {
      if (run.enemies.typeIndex[slots[i]] === reaperType) live++;
    }
  }
  check("a nightreaper is on the field", live >= 1, `${live}`);
}

section("+1 Reaper every minute after the first");
{
  const run = new Run();
  run.begin({ seed: 11, modifiers: [MOD_DEV_GODMODE], record: false });
  run.waves.jumpToSecond(REAPER_SECOND);
  drive(run, 2);
  check("first spawn", run.waves.reaperCount === 1);

  run.waves.jumpToSecond(REAPER_SECOND + 60);
  drive(run, 2);
  check("second Reaper a minute later", run.waves.reaperCount === 2, `${run.waves.reaperCount}`);

  run.waves.jumpToSecond(REAPER_SECOND + 120);
  drive(run, 2);
  check("third Reaper another minute later", run.waves.reaperCount === 3, `${run.waves.reaperCount}`);
  check("still no White Hand without a kill", run.whiteHandTicks < 0);
  check("run still open", run.end === RUN_END.running);
}

section("killing a Reaper drops eggs and starts the White Hand");
{
  const run = new Run();
  run.begin({ seed: 12, modifiers: [MOD_DEV_GODMODE], record: false });
  run.waves.jumpToSecond(REAPER_SECOND);
  drive(run, 2);
  run.forceKillReapersForTest();
  drive(run, 1);
  check("a Reaper kill was recorded", run.reaperKills >= 1, `${run.reaperKills}`);
  check("eggs were earned", run.eggsEarned >= EGGS_PER_REAPER_KILL, `${run.eggsEarned}`);
  check("White Hand countdown started", run.whiteHandTicks >= 0, `${run.whiteHandTicks}`);

  drive(run, WHITE_HAND_TICKS + TICKS_PER_SECOND);
  check("White Hand ends the run", run.end === RUN_END.whiteHand, `end=${run.end}`);
  check("being taken is a completion", isCompletion(run.summary.end));
}

section("dying after the Reaper arrives is a stage clear, not a defeat");
{
  const run = new Run();
  run.begin({ seed: 13, record: false });
  run.waves.jumpToSecond(REAPER_SECOND);
  drive(run, 2);
  check("Reaper phase has begun", run.waves.reaperSpawned);

  let guard = 0;
  while (!run.over && guard++ < 60 * TICKS_PER_SECOND) {
    run.setStick(0, 0, 0);
    if (run.paused) run.pickCard(0);
    else run.tick();
  }
  check("the run ended", run.over, `end=${run.end} after ${guard}`);
  check(
    "death in the Reaper phase is a survival, not a defeat",
    run.end === RUN_END.survived,
    `end=${run.end}`,
  );
  check("that counts as completing the stage", isCompletion(run.summary.end));
  check("the player is dead", run.players.state[0] === PLAYER_STATE.dead);
}

section("White Hand cues fire during the countdown");
{
  const run = new Run();
  run.begin({ seed: 14, modifiers: [MOD_DEV_GODMODE], record: false });
  run.waves.jumpToSecond(REAPER_SECOND);
  drive(run, 2);
  run.forceKillReapersForTest();
  drive(run, 1);

  let tolls = 0;
  for (let i = 0; i < WHITE_HAND_TICKS + 5; i++) {
    run.tick();
    tolls += run.cues.countOf(CUE.bellTolled);
  }
  check("twelve bell tolls were announced", tolls >= 12, `${tolls}`);
  check("run ended as White Hand", run.end === RUN_END.whiteHand);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
