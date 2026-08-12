/**
 * Autosave self-check. Run headless: `bun packages/mobile/game/save/resume.test.ts`
 *
 * `snapshot.test.ts` proves a captured run comes back exactly. This proves the player actually gets
 * that benefit: that the game saves often enough, waits when it has to, drops what it must, survives a
 * storage layer that lies or fails, and never offers to resume a run it cannot faithfully rebuild.
 *
 * WHAT IT PROVES
 *   1. A rolling autosave fires on the interval and not before it.
 *   2. A backgrounded run is captured immediately, and resumes on the tick it was captured on.
 *   3. Two slots alternate, and the newer generation wins.
 *   4. A torn or truncated slot is discarded and the older good slot is offered instead.
 *   5. A backend that fails a write, lies about a write, or throws, never produces a false resume.
 *   6. Rolling autosaves that collide with a write in flight are dropped, not queued.
 *   7. A finished run is never captured, and clearing removes the offer.
 *   8. A resume written by a different build of the simulation is refused.
 */

import { Run } from "../run/run";
import {
  AUTOSAVE_INTERVAL_TICKS,
  RESUME_REASON,
  RESUME_SLOT_KEYS,
  ResumeStore,
} from "./resume";
import { SNAPSHOT_ERROR, describeSnapshotError } from "./snapshot";
import { MemoryBackend, type SaveBackend } from "./store";

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

function stickAt(tick: number): { x: number; y: number } {
  const a = (tick / 240) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

const CONFIG = { seed: 5150, record: true, autoPick: true } as const;

function freshRun(): Run {
  const run = new Run(1);
  run.begin({ ...CONFIG });
  return run;
}

/** Drive a run, offering the store a chance to autosave every tick the way the screen would. */
async function drive(run: Run, ticks: number, store?: ResumeStore): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const s = stickAt(run.ticks);
    run.setStick(0, s.x, s.y);
    if (run.over) return;
    run.tick();
    if (store !== undefined) await store.maybeCapture(run);
  }
}

/** A backend that can be told to fail, to lie, or to throw. */
class HostileBackend implements SaveBackend {
  private readonly inner = new MemoryBackend();
  mode: "ok" | "swallow" | "throw" | "corrupt" = "ok";

  async read(key: string): Promise<Uint8Array | undefined> {
    return this.inner.read(key);
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.mode === "throw") throw new Error("disk full");
    // "swallow" resolves without storing anything — the exact lie the readback exists to catch.
    if (this.mode === "swallow") return;
    if (this.mode === "corrupt") {
      const copy = new Uint8Array(bytes);
      copy[copy.byteLength - 1] ^= 0xff;
      await this.inner.write(key, copy);
      return;
    }
    await this.inner.write(key, bytes);
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key);
  }
}

/* ---- 1. timing --------------------------------------------------------------------------------- */

section("1. The rolling autosave fires on the interval, not before");

const backend = new MemoryBackend();
const store = new ResumeStore(backend, 600);
const run = freshRun();
store.armForNewRun(run);

await drive(run, 599, store);
check("nothing saved before the interval elapsed", store.stats.captures === 0, `tick ${run.ticks}`);
await drive(run, 2, store);
check("saved once the interval elapsed", store.stats.captures === 1, `tick ${store.stats.lastCaptureTick}`);
check("and the write landed", store.stats.writes === 1 && store.stats.failures === 0);
await drive(run, 600, store);
check("saved again one interval later", store.stats.captures === 2, `${store.stats.captures} captures`);
check(
  "default interval is thirty seconds of play",
  AUTOSAVE_INTERVAL_TICKS === 1800,
  `${AUTOSAVE_INTERVAL_TICKS} ticks`,
);

/* ---- 2. background capture and resume ---------------------------------------------------------- */

section("2. Backgrounding captures at once and the run comes back on that tick");

await drive(run, 137, store);
const capturedAt = run.ticks;
check("background capture written", await store.capture(run, RESUME_REASON.background));
check("captured on the current tick", store.stats.lastCaptureTick === capturedAt, `tick ${capturedAt}`);

const lookup = await store.loadCandidate();
check("a resume is on offer", lookup.candidate !== undefined, describeSnapshotError(lookup.error));
const candidate = lookup.candidate;
if (candidate === undefined) throw new Error("no candidate to continue with");
check("offered at the captured tick", candidate.tick === capturedAt, `tick ${candidate.tick}`);
check("offered for the right seed", candidate.seed === run.seed, `${candidate.seed}`);
check(
  "stored compressed",
  candidate.compressed && candidate.storedBytes < candidate.rawBytes,
  `${(candidate.storedBytes / 1024).toFixed(0)}KB stored vs ${(candidate.rawBytes / 1024).toFixed(0)}KB raw`,
);

const resumed = freshRun();
const code = store.restore(resumed, candidate);
check("resume accepted", code === SNAPSHOT_ERROR.NONE, describeSnapshotError(code));
check(
  "resumed to the identical world",
  resumed.hashState(0x811c9dc5) === run.hashState(0x811c9dc5),
  `tick ${resumed.ticks}, ${resumed.enemies.count} enemies, level ${resumed.prog.level}`,
);

let diverged = -1;
for (let i = 0; i < 300; i++) {
  const s = stickAt(run.ticks);
  run.setStick(0, s.x, s.y);
  resumed.setStick(0, s.x, s.y);
  run.tick();
  resumed.tick();
  if (run.hashState(0x811c9dc5) !== resumed.hashState(0x811c9dc5)) {
    diverged = i;
    break;
  }
}
check("and keeps playing in lockstep", diverged === -1, diverged === -1 ? "300 ticks agreed" : `diverged at ${diverged}`);

/* ---- 3. slots and generations ------------------------------------------------------------------ */

section("3. Two slots alternate and the newest wins");

const bothSlots = new MemoryBackend();
const alt = new ResumeStore(bothSlots, 600);
const altRun = freshRun();
alt.armForNewRun(altRun);
await drive(altRun, 400, alt);
await alt.capture(altRun, RESUME_REASON.manual);
const firstTick = altRun.ticks;
await drive(altRun, 400, alt);
await alt.capture(altRun, RESUME_REASON.manual);
const secondTick = altRun.ticks;

const slotA = await bothSlots.read(RESUME_SLOT_KEYS[0]);
const slotB = await bothSlots.read(RESUME_SLOT_KEYS[1]);
check("both slots are in use", slotA !== undefined && slotB !== undefined);
const newest = await alt.loadCandidate();
check("the newer capture is the one offered", newest.candidate?.tick === secondTick, `${newest.candidate?.tick} vs older ${firstTick}`);

/* ---- 4. a bad slot falls back to the good one -------------------------------------------------- */

section("4. A damaged slot is discarded and the older good one is offered");

/**
 * Which physical slot holds the newest capture is an implementation detail, so the damage is aimed by
 * matching on the tick instead. The container is 16 bytes and the snapshot's tick sits 20 bytes into it.
 */
async function findSlotWithTick(be: MemoryBackend, tick: number): Promise<string> {
  for (const key of RESUME_SLOT_KEYS) {
    const bytes = await be.read(key);
    if (bytes === undefined) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(16 + 20, true) === tick) return key;
  }
  return RESUME_SLOT_KEYS[0];
}

const newestKey = await findSlotWithTick(bothSlots, secondTick);

const damaged = await bothSlots.read(newestKey);
if (damaged === undefined) throw new Error("expected a slot to damage");
const torn = damaged.subarray(0, damaged.byteLength - 200);
await bothSlots.write(newestKey, torn);

const fallback = new ResumeStore(bothSlots, 600);
const recovered = await fallback.loadCandidate();
check("still offers a resume", recovered.candidate !== undefined, describeSnapshotError(recovered.error));
check("and it is the older, intact capture", recovered.candidate?.tick === firstTick, `tick ${recovered.candidate?.tick}`);
const recoveredRun = freshRun();
check(
  "the fallback resume restores",
  fallback.restore(recoveredRun, recovered.candidate!) === SNAPSHOT_ERROR.NONE,
);

/* ---- 5. a hostile storage layer ---------------------------------------------------------------- */

section("5. Storage that fails, lies, or throws never yields a false resume");

const hostile = new HostileBackend();
const guard = new ResumeStore(hostile, 600);
const guardRun = freshRun();
await drive(guardRun, 300);

hostile.mode = "swallow";
check("a swallowed write is reported as failed", (await guard.capture(guardRun, RESUME_REASON.manual)) === false);
check("nothing is on offer after it", (await guard.loadCandidate()).candidate === undefined);

hostile.mode = "throw";
check("a throwing write is reported as failed", (await guard.capture(guardRun, RESUME_REASON.manual)) === false);
check("still nothing on offer", (await guard.loadCandidate()).candidate === undefined);

hostile.mode = "corrupt";
check("a corrupted write is caught by the readback", (await guard.capture(guardRun, RESUME_REASON.manual)) === false);
const afterCorrupt = await guard.loadCandidate();
check(
  "a corrupt slot is never offered",
  afterCorrupt.candidate === undefined,
  describeSnapshotError(afterCorrupt.error),
);
check("every failure was counted", guard.stats.failures === 3, `${guard.stats.failures} failures`);

hostile.mode = "ok";
check("and it recovers once storage does", await guard.capture(guardRun, RESUME_REASON.manual));
check("with a usable offer", (await guard.loadCandidate()).candidate !== undefined);

/* ---- 6. collisions are dropped, not queued ----------------------------------------------------- */

section("6. An autosave that collides with a write in flight is dropped, not queued");

class SlowBackend implements SaveBackend {
  private readonly inner = new MemoryBackend();
  release: (() => void) | undefined;

  async read(key: string): Promise<Uint8Array | undefined> {
    return this.inner.read(key);
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await this.inner.write(key, bytes);
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key);
  }
}

const slow = new SlowBackend();
const slowStore = new ResumeStore(slow, 60);
const slowRun = freshRun();
await drive(slowRun, 120);

const pending = slowStore.capture(slowRun, RESUME_REASON.rolling);
await Promise.resolve();
check("a write is in flight", slowStore.busy);
const dropped = await slowStore.capture(slowRun, RESUME_REASON.rolling);
check("the colliding rolling autosave was dropped", dropped === false);
check("and counted as skipped", slowStore.stats.skipped === 1, `${slowStore.stats.skipped} skipped`);
slow.release?.();
check("the original write completed", await pending);
await slowStore.settle();
check("only one capture was taken", slowStore.stats.captures === 1, `${slowStore.stats.captures}`);

/* ---- 7. finished runs and clearing ------------------------------------------------------------- */

section("7. A finished run is never captured, and clearing removes the offer");

const done = freshRun();
await drive(done, 300);
done.quit();
check("the run is over", done.over);
const overStore = new ResumeStore(new MemoryBackend(), 60);
check("a finished run is never captured", (await overStore.capture(done, RESUME_REASON.background)) === false);
check("and is never due", !overStore.shouldCapture(done));

await store.clear();
check("clearing removes the offer", (await store.loadCandidate()).candidate === undefined);

/* ---- 8. a resume from another build ------------------------------------------------------------ */

section("8. A resume written by a different build of the simulation is refused");

const stale = new MemoryBackend();
const staleStore = new ResumeStore(stale, 600);
const staleRun = freshRun();
await drive(staleRun, 300);
await staleStore.capture(staleRun, RESUME_REASON.manual);
for (const key of RESUME_SLOT_KEYS) {
  const bytes = await stale.read(key);
  if (bytes === undefined) continue;
  // The snapshot's schema fingerprint sits at offset 8 inside the snapshot, 16 bytes into the container.
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(16 + 8, 0xfeedface, true);
  await stale.write(key, bytes);
}
const staleLookup = await staleStore.loadCandidate();
check("the header still reads, so it is offered rather than silently vanishing", staleLookup.candidate !== undefined);
const staleTarget = freshRun();
check(
  "but restoring it is refused",
  staleStore.restore(staleTarget, staleLookup.candidate!) === SNAPSHOT_ERROR.SCHEMA_MISMATCH,
);
check("and the fresh run is untouched at tick zero", staleTarget.ticks === 0);

/* ---- verdict ----------------------------------------------------------------------------------- */

console.log(failures === 0 ? "\nresume: PASS" : `\nresume: FAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
