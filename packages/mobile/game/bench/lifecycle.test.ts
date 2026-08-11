/**
 * Lifecycle probe self-check. Run headless: `bun packages/mobile/game/bench/lifecycle.test.ts`
 *
 * This instrument decides whether a leak trial counts. If it miscounts background time or loses a
 * memory warning, we throw away a good renderer — or keep chasing a leak that was only ever the OS
 * reclaiming a suspended app. So the counters are checked against hand-computed timelines.
 */

import {
  APP_STATE,
  LifecycleProbe,
  MEM_TRIAL_MIN_SECONDS,
  explainDeath,
  explainStop,
} from "./lifecycle";
import { summariseFlight, type FlightLog, type FlightSample } from "./flight-recorder";

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

const T0 = 1_700_000_000_000;

section("background accounting");
{
  const p = new LifecycleProbe(T0);
  p.setState(APP_STATE.inactive, T0 + 10_000);
  p.setState(APP_STATE.background, T0 + 11_000);
  p.setState(APP_STATE.active, T0 + 41_000);
  const s = p.snapshot(T0 + 60_000);
  check("one excursion counted once, not once per state", s.bgCount === 1, `bgCount ${s.bgCount}`);
  check("time away measured from leaving active", s.bgMs === 31_000, `${s.bgMs}ms`);
  check("back to foreground is reported", s.state === APP_STATE.active);
}
{
  const p = new LifecycleProbe(T0);
  p.setState(APP_STATE.active, T0 + 5_000);
  const s = p.snapshot(T0 + 6_000);
  check("re-emitting the current state is ignored", s.bgCount === 0 && s.bgMs === 0);
}
{
  const p = new LifecycleProbe(T0);
  p.setState(APP_STATE.background, T0 + 20_000);
  const mid = p.snapshot(T0 + 50_000);
  check(
    "an in-progress background stretch is included",
    mid.bgMs === 30_000,
    `${mid.bgMs}ms while still suspended`,
  );
  check("still-suspended state is reported", mid.state === APP_STATE.background);
  const later = p.snapshot(T0 + 80_000);
  check("the pending stretch keeps growing", later.bgMs === 60_000, `${later.bgMs}ms`);
  p.setState(APP_STATE.active, T0 + 80_000);
  check(
    "resuming does not double-count the pending stretch",
    p.snapshot(T0 + 90_000).bgMs === 60_000,
    `${p.snapshot(T0 + 90_000).bgMs}ms`,
  );
}
{
  const p = new LifecycleProbe(T0);
  for (let i = 0; i < 4; i++) {
    p.setState(APP_STATE.background, T0 + i * 10_000);
    p.setState(APP_STATE.active, T0 + i * 10_000 + 2_000);
  }
  const s = p.snapshot(T0 + 100_000);
  check("four excursions accumulate", s.bgCount === 4 && s.bgMs === 8_000, `${s.bgMs}ms`);
}

section("memory warnings");
{
  const p = new LifecycleProbe(T0);
  check("none by default", p.snapshot(T0).memWarn === 0 && p.snapshot(T0).firstMemWarnS === -1);
  p.noteMemoryWarning(T0 + 123_400);
  p.noteMemoryWarning(T0 + 200_000);
  const s = p.snapshot(T0 + 210_000);
  check("counted", s.memWarn === 2, `${s.memWarn}`);
  check("first one is timestamped in seconds", s.firstMemWarnS === 123, `${s.firstMemWarnS}s`);
}

section("death verdicts");
{
  const fg = new LifecycleProbe(T0);
  const lines = explainDeath(fg.snapshot(T0 + 600_000)).join(" | ");
  check(
    "foreground death with no warning is not called an OOM",
    lines.includes("not a jetsam OOM"),
    lines,
  );

  const warned = new LifecycleProbe(T0);
  warned.noteMemoryWarning(T0 + 500_000);
  check(
    "foreground death after warnings is called an OOM",
    explainDeath(warned.snapshot(T0 + 600_000)).join(" | ").includes("jetsam OOM confirmed"),
  );

  const bg = new LifecycleProbe(T0);
  bg.setState(APP_STATE.background, T0 + 100_000);
  check(
    "a death while suspended is thrown out, warning or not",
    explainDeath(bg.snapshot(T0 + 600_000)).join(" | ").includes("TRIAL INCONCLUSIVE"),
  );

  const bgWarned = new LifecycleProbe(T0);
  bgWarned.setState(APP_STATE.background, T0 + 100_000);
  bgWarned.noteMemoryWarning(T0 + 200_000);
  const bgw = explainDeath(bgWarned.snapshot(T0 + 600_000)).join(" | ");
  check(
    "a suspended death stays inconclusive even with warnings",
    bgw.includes("TRIAL INCONCLUSIVE") && !bgw.includes("OOM confirmed"),
    bgw,
  );

  check(
    "an older trial without lifecycle data says so instead of guessing",
    explainDeath(null).join(" | ").includes("unknown"),
  );
}

section("stopped-trial verdicts");
{
  const clean = new LifecycleProbe(T0);
  check(
    "a full foreground window with no warnings clears memory",
    explainStop(clean.snapshot(T0 + 1_000_000), 1_000).join(" | ").includes("MEMORY CLEARED"),
  );
  check(
    "stopping early does not clear anything",
    explainStop(clean.snapshot(T0 + 400_000), 400).join(" | ").includes("TOO SHORT"),
    `at ${MEM_TRIAL_MIN_SECONDS}s minimum`,
  );

  const blipped = new LifecycleProbe(T0);
  blipped.setState(APP_STATE.inactive, T0 + 10_000);
  blipped.setState(APP_STATE.active, T0 + 13_000);
  check(
    "a 3s notification banner does not disqualify a trial",
    explainStop(blipped.snapshot(T0 + 1_000_000), 1_000).join(" | ").includes("MEMORY CLEARED"),
  );

  const locked = new LifecycleProbe(T0);
  locked.setState(APP_STATE.background, T0 + 10_000);
  locked.setState(APP_STATE.active, T0 + 300_000);
  check(
    "a real suspension does disqualify it",
    explainStop(locked.snapshot(T0 + 1_000_000), 1_000).join(" | ").includes("TRIAL INCONCLUSIVE"),
  );

  const warned = new LifecycleProbe(T0);
  warned.noteMemoryWarning(T0 + 90_000);
  const wl = explainStop(warned.snapshot(T0 + 200_000), 200).join(" | ");
  check(
    "a warning outranks the duration rule — a short trial that warned is still a finding",
    wl.includes("MEMORY PRESSURE IS REAL") && !wl.includes("TOO SHORT"),
    wl,
  );

  const warnedBg = new LifecycleProbe(T0);
  warnedBg.setState(APP_STATE.background, T0 + 10_000);
  warnedBg.setState(APP_STATE.active, T0 + 300_000);
  warnedBg.noteMemoryWarning(T0 + 400_000);
  check(
    "a warning outranks the foreground rule too",
    explainStop(warnedBg.snapshot(T0 + 500_000), 500).join(" | ").includes("MEMORY PRESSURE IS REAL"),
  );

  check(
    "an older stopped trial admits it cannot say",
    explainStop(null, 1_000).join(" | ").includes("unknown"),
  );
}

section("flight log integration");
{
  const sample = (t: number, life?: FlightSample["life"]): FlightSample => ({
    t,
    quads: 5000,
    tick: t * 60,
    frames: t * 60,
    p50: 16.7,
    p99: 16.7,
    droppedTicks: 0,
    uploadBytes: 528 * 1024,
    heapMb: -1,
    simStaleMs: 0,
    frameErrors: 0,
    lastError: null,
    life,
  });

  const probe = new LifecycleProbe(T0);
  probe.setState(APP_STATE.background, T0 + 1_000_000);
  const dead: FlightLog = {
    startedAt: T0,
    cleanExit: false,
    device: "ios 1320x2868 layers x16",
    samples: [sample(2, probe.snapshot(T0 + 2_000)), sample(2306, probe.snapshot(T0 + 2_306_000))],
  };
  const deadLines = summariseFlight(dead).join(" | ");
  check("a dead log surfaces the lifecycle verdict", deadLines.includes("TRIAL INCONCLUSIVE"), deadLines);
  check("it still reports the death time", deadLines.includes("DIED at 2306s"));

  const clean: FlightLog = { ...dead, cleanExit: true };
  const cleanLines = summariseFlight(clean).join(" | ");
  check(
    "a clean exit is not called a death",
    !cleanLines.includes("DIED") && cleanLines.includes("exited cleanly"),
    cleanLines,
  );
  check(
    "a stopped trial still gets a memory verdict — this is the whole point",
    cleanLines.includes("stopped by hand") && cleanLines.includes("TRIAL INCONCLUSIVE"),
    cleanLines,
  );

  const awakeProbe = new LifecycleProbe(T0);
  const awake: FlightLog = {
    ...dead,
    cleanExit: true,
    samples: [sample(2, awakeProbe.snapshot(T0 + 2_000)), sample(1_100, awakeProbe.snapshot(T0 + 1_100_000))],
  };
  check(
    "a full foreground window stopped by hand clears memory",
    summariseFlight(awake).join(" | ").includes("MEMORY CLEARED"),
    summariseFlight(awake).join(" | "),
  );

  const legacy: FlightLog = { ...dead, samples: [sample(2), sample(844)] };
  check(
    "a pre-probe log degrades instead of throwing",
    summariseFlight(legacy).join(" | ").includes("unknown"),
  );
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
