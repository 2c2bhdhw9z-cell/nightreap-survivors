/**
 * Snapshot self-check. Run headless: `bun packages/mobile/game/save/snapshot.test.ts`
 *
 * WHY THIS TEST IS THE WHOLE POINT OF THE REFLECTIVE WALKER
 * The snapshot discovers its own fields by walking the live run, which means it cannot forget a field
 * somebody adds later. What it *can* do is silently skip something the walker's rules exclude — an
 * array of objects, a field behind a skipped path, something nested past the depth limit. A single
 * matching state hash would not catch that, because a missed field usually agrees for one tick and
 * only diverges once it is read. So the central check here is not "the hash matches after restore",
 * it is "the restored run and the original run tick six hundred more times in perfect lockstep".
 *
 * WHAT IT PROVES
 *   1. Snapshot → restore reproduces the state hash on the snapshot tick.
 *   2. The restored run then runs 600 further ticks in lockstep, hash-identical every single tick.
 *   3. Re-snapshotting the restored run produces byte-identical bytes.
 *   4. The restored run's stats still follow from its restored modifiers and passives.
 *   5. A snapshot taken with a card screen open restores the screen, offers and their words.
 *   6. A run that was interrupted and restored still validates as a legal replay — the Phase 2 gate.
 *   7. Every rejection path returns the right reason: short, wrong file, wrong version, wrong build,
 *      corrupt, truncated.
 *   8. Compression round-trips, is reported, and the uncompressed path restores just as well.
 *   9. Tick zero and a four-player run both snapshot and restore.
 */

import { MODIFIERS_BY_WIRE_ID, type RunModifier } from "../sim/modifiers";
import { Stats } from "../sim/stats";
import { OFFERS_PER_SCREEN } from "../sim/cards";
import type { RunHeader } from "../replay/format";
import { REPLAY_ERROR } from "../replay/format";
import { validateForLadder, type ReplaySim } from "../replay/player";
import { Run } from "../run/run";
import {
  SNAPSHOT_ERROR,
  SNAPSHOT_HEADER_BYTES,
  describeSnapshotError,
  inspectSnapshot,
  restoreRun,
  snapshotFieldCount,
  snapshotRawBytes,
  snapshotRun,
  snapshotSchemaFingerprint,
  type SnapshotError,
} from "./snapshot";

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

/** The same slow circle the run test uses: keeps the player inside the crowd rather than in a corner. */
function stickAt(tick: number): { x: number; y: number } {
  const a = (tick / 240) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** Advance a run, letting `autoPick` answer card screens from inside the tick. */
function drive(run: Run, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    const s = stickAt(run.ticks);
    run.setStick(0, s.x, s.y);
    if (run.over) return;
    run.tick();
  }
}

const BASE = {
  seed: 90210,
  record: true,
  autoPick: true,
} as const;

/* ---- 1-4. capture, restore, lockstep ----------------------------------------------------------- */

section("1. A snapshot restores the world it captured");

const original = new Run(1);
original.begin({ ...BASE });
drive(original, 1800);

check("run reached the snapshot point alive", !original.over, `tick ${original.ticks}`);
check(
  "walker found a plausible number of fields",
  snapshotFieldCount(original) > 200,
  `${snapshotFieldCount(original)} fields, fingerprint ${snapshotSchemaFingerprint(original)
    .toString(16)
    .padStart(8, "0")}`,
);

const bytes = snapshotRun(original);
const info = inspectSnapshot(bytes);

check("header reads back clean", info.error === SNAPSHOT_ERROR.NONE, describeSnapshotError(info.error));
check("header carries the snapshot tick", info.tick === original.ticks, `${info.tick}`);
check("header carries the seed", info.seed === original.seed, `${info.seed}`);
check(
  "reported raw size matches the walker's own estimate",
  info.rawBytes === snapshotRawBytes(original),
  `${info.rawBytes} bytes`,
);
check(
  "buffer is exactly header plus stored payload",
  bytes.byteLength === SNAPSHOT_HEADER_BYTES + info.storedBytes,
  `${bytes.byteLength} bytes on disk`,
);

const restored = new Run(1);
restored.begin({ ...BASE });
const code = restoreRun(restored, bytes);
check("restore accepted", code === SNAPSHOT_ERROR.NONE, describeSnapshotError(code));

const originalHash = original.hashState(0x811c9dc5);
check(
  "state hash on the snapshot tick is identical",
  restored.hashState(0x811c9dc5) === originalHash,
  originalHash.toString(16),
);
check("tick counter came back", restored.ticks === original.ticks, `${restored.ticks}`);
check("run clock came back", restored.runTicks === original.runTicks, `${restored.runTicks}`);
check("the crowd came back", restored.enemies.count === original.enemies.count, `${restored.enemies.count} enemies`);
check("kill count came back", restored.kills === original.kills, `${restored.kills} kills`);
check("level came back", restored.prog.level === original.prog.level, `level ${restored.prog.level}`);

section("2. The restored world keeps agreeing for the next 600 ticks");

let divergedAt = -1;
for (let i = 0; i < 600; i++) {
  const s = stickAt(original.ticks);
  original.setStick(0, s.x, s.y);
  restored.setStick(0, s.x, s.y);
  original.tick();
  restored.tick();
  if (original.hashState(0x811c9dc5) !== restored.hashState(0x811c9dc5)) {
    divergedAt = i;
    break;
  }
}
check("600 ticks in lockstep, hash-identical every tick", divergedAt === -1, divergedAt === -1 ? "no divergence" : `diverged ${divergedAt} ticks after restore`);

section("3. Re-snapshotting a restored run is byte-identical");

const twinA = new Run(1);
twinA.begin({ ...BASE });
drive(twinA, 1500);
const first = snapshotRun(twinA);
const twinB = new Run(1);
twinB.begin({ ...BASE });
check("restore for the byte comparison accepted", restoreRun(twinB, first) === SNAPSHOT_ERROR.NONE);
const second = snapshotRun(twinB);
let sameBytes = first.byteLength === second.byteLength;
if (sameBytes) {
  for (let i = 0; i < first.byteLength; i++) {
    if (first[i] !== second[i]) {
      sameBytes = false;
      break;
    }
  }
}
check("snapshot of a restored run equals the original snapshot", sameBytes, `${first.byteLength} bytes`);

section("4. The restored numbers still follow from the restored contents");

check(
  "resolved stats agree with a fresh fold of modifiers and passives",
  twinB.loadoutAgreesWithStats(new Stats()),
);

/* ---- 5. card screen ---------------------------------------------------------------------------- */

section("5. A snapshot taken on a card screen restores the screen and its words");

const paused = new Run(1);
paused.begin({ seed: 4242, record: true, autoPick: false });
for (let i = 0; i < 6000 && !paused.paused && !paused.over; i++) {
  const s = stickAt(paused.ticks);
  paused.setStick(0, s.x, s.y);
  paused.tick();
}
check("reached a card screen", paused.paused, `tick ${paused.ticks}`);

const pausedBytes = snapshotRun(paused);
const pausedBack = new Run(1);
pausedBack.begin({ seed: 4242, record: true, autoPick: false });
check("restore of a paused run accepted", restoreRun(pausedBack, pausedBytes) === SNAPSHOT_ERROR.NONE);
check("card screen is still open", pausedBack.cards.open);
check("same number of offers", pausedBack.cards.offerCount === paused.cards.offerCount, `${pausedBack.cards.offerCount}`);

let offersMatch = true;
let wordsPresent = true;
for (let i = 0; i < pausedBack.cards.offerCount; i++) {
  if (
    pausedBack.cards.offerKind[i] !== paused.cards.offerKind[i] ||
    pausedBack.cards.offerType[i] !== paused.cards.offerType[i] ||
    pausedBack.cards.offerLevel[i] !== paused.cards.offerLevel[i]
  ) {
    offersMatch = false;
  }
  if (pausedBack.cards.offerName[i] !== paused.cards.offerName[i]) offersMatch = false;
  if (pausedBack.cards.offerName[i] === "") wordsPresent = false;
}
check("every offer is the same card", offersMatch);
check("card text came back from the content rows", wordsPresent, `${OFFERS_PER_SCREEN} slots checked`);

// Answering the restored screen and the original screen the same way must keep them together.
paused.pickCard(0);
pausedBack.pickCard(0);
let pausedDiverged = -1;
for (let i = 0; i < 240; i++) {
  const s = stickAt(paused.ticks);
  paused.setStick(0, s.x, s.y);
  pausedBack.setStick(0, s.x, s.y);
  if (paused.paused) paused.pickCard(0);
  if (pausedBack.paused) pausedBack.pickCard(0);
  paused.tick();
  pausedBack.tick();
  if (paused.hashState(0x811c9dc5) !== pausedBack.hashState(0x811c9dc5)) {
    pausedDiverged = i;
    break;
  }
}
check("picking the same card leaves both worlds identical", pausedDiverged === -1, pausedDiverged === -1 ? "240 ticks agreed" : `diverged at ${pausedDiverged}`);

/* ---- 6. an interrupted run is still ladder-legal ----------------------------------------------- */

section("6. An interrupted, restored run still validates as a legal replay");

/** The real simulation dressed as a replay target. */
class RunSim implements ReplaySim {
  readonly run = new Run(1);

  resetForReplay(header: RunHeader): void {
    const mods: RunModifier[] = [];
    for (let i = 0; i < header.modifierCount; i++) {
      const mod = MODIFIERS_BY_WIRE_ID.get(header.modifiers[i]);
      if (mod !== undefined) mods.push(mod);
    }
    this.run.begin({
      seed: header.seed,
      stageId: header.stageId,
      playerCount: header.characterCount,
      modifiers: mods,
      record: false,
      autoPick: true,
      buildId: header.buildId,
      contentVersion: header.contentVersion,
      tainted: header.tainted,
    });
  }

  tickWithInput(axes: Int8Array, buttons: Uint8Array): void {
    this.run.axes.set(axes);
    this.run.buttons.set(buttons);
    // A card screen owed to `autoPick` is settled first, so one recorded frame is one advanced tick.
    let guard = 0;
    while (this.run.paused && guard++ < 64) this.run.tick();
    this.run.tick();
  }

  hashState(hash: number): number {
    return this.run.hashState(hash);
  }
}

const LIMIT = 2700;
const interrupted = new Run(1);
interrupted.begin({ seed: 777, record: true, autoPick: true, timeLimitTicks: LIMIT });
drive(interrupted, 1200);
check("interrupted mid-fight, not at a boundary", !interrupted.over && interrupted.enemies.count > 0, `tick ${interrupted.ticks}, ${interrupted.enemies.count} enemies`);

const midBytes = snapshotRun(interrupted);
const resumed = new Run(1);
resumed.begin({ seed: 777, record: true, autoPick: true, timeLimitTicks: LIMIT });
check("resume accepted", restoreRun(resumed, midBytes) === SNAPSHOT_ERROR.NONE);
drive(resumed, LIMIT * 3);
check("resumed run played through to an ending", resumed.over, `end ${resumed.end} at tick ${resumed.ticks}`);

const verdict = validateForLadder(resumed.recorder.encode(), new RunSim());
check(
  "the resumed run's replay reproduces exactly and is accepted",
  verdict.accepted,
  `error ${verdict.error}, ticks ${verdict.result.ticks}, recorded ${verdict.result.recordedHash.toString(16)} vs replayed ${verdict.result.replayedHash.toString(16)}`,
);
check("not rejected for taint", !verdict.rejectedForTaint);
check("no replay-format error", verdict.error === REPLAY_ERROR.NONE);

/* ---- 7. rejection paths ------------------------------------------------------------------------ */

section("7. Anything we cannot fully trust is refused outright");

function restoreCopy(mutate: (b: Uint8Array) => Uint8Array): SnapshotError {
  const target = new Run(1);
  target.begin({ ...BASE });
  return restoreRun(target, mutate(new Uint8Array(bytes)));
}

check(
  "a stub of a file is too short",
  restoreCopy((b) => b.subarray(0, 12)) === SNAPSHOT_ERROR.TOO_SHORT,
);
check(
  "a foreign file is not a snapshot",
  restoreCopy((b) => {
    new DataView(b.buffer).setUint32(0, 0x12345678, true);
    return b;
  }) === SNAPSHOT_ERROR.BAD_MAGIC,
);
check(
  "a future container version is refused",
  restoreCopy((b) => {
    new DataView(b.buffer).setUint16(4, 99, true);
    return b;
  }) === SNAPSHOT_ERROR.BAD_VERSION,
);
check(
  "a snapshot from a different build of the simulation is refused",
  restoreCopy((b) => {
    new DataView(b.buffer).setUint32(8, 0xdeadbeef, true);
    return b;
  }) === SNAPSHOT_ERROR.SCHEMA_MISMATCH,
);
check(
  "a snapshot cut short is refused",
  restoreCopy((b) => b.subarray(0, b.byteLength - 64)) === SNAPSHOT_ERROR.TRUNCATED,
);

// Every single-bit flip in the payload has to be caught, because a half-restored world is worse than
// none. Sampling rather than exhausting: half a megabyte times eight bits is not a per-commit cost.
let missedFlips = 0;
let flipsTried = 0;
const step = Math.max(1, Math.floor((bytes.byteLength - SNAPSHOT_HEADER_BYTES) / 400));
for (let i = SNAPSHOT_HEADER_BYTES; i < bytes.byteLength; i += step) {
  for (let bit = 0; bit < 8; bit += 3) {
    flipsTried++;
    const copy = new Uint8Array(bytes);
    copy[i] ^= 1 << bit;
    if (restoreRun(new Run(1), copy) !== SNAPSHOT_ERROR.BAD_CHECKSUM) missedFlips++;
  }
}
check("every sampled bit flip in the payload is caught", missedFlips === 0, `${flipsTried} flips, ${missedFlips} missed`);

/* ---- 8. compression ---------------------------------------------------------------------------- */

section("8. Compression earns its keep and both paths restore");

check("the mid-run snapshot compressed", info.compressed);
check(
  "compression actually shrank it",
  info.storedBytes < info.rawBytes,
  `${(info.rawBytes / 1024).toFixed(0)}KB raw → ${(info.storedBytes / 1024).toFixed(0)}KB stored (${(info.rawBytes / Math.max(1, info.storedBytes)).toFixed(1)}x)`,
);

const uncompressed = snapshotRun(twinA, false);
const flat = inspectSnapshot(uncompressed);
check("an uncompressed snapshot says so", !flat.compressed && flat.storedBytes === flat.rawBytes, `${flat.storedBytes} bytes`);
const flatBack = new Run(1);
flatBack.begin({ ...BASE });
check("an uncompressed snapshot restores", restoreRun(flatBack, uncompressed) === SNAPSHOT_ERROR.NONE);
check(
  "and restores to the same world the compressed one would",
  flatBack.hashState(0x811c9dc5) === twinB.hashState(0x811c9dc5),
);

/* ---- 9. edges ---------------------------------------------------------------------------------- */

section("9. Tick zero and a four-player run");

const fresh = new Run(1);
fresh.begin({ ...BASE });
const freshBytes = snapshotRun(fresh);
const freshBack = new Run(1);
freshBack.begin({ ...BASE });
check("a snapshot at tick zero restores", restoreRun(freshBack, freshBytes) === SNAPSHOT_ERROR.NONE);
check("tick-zero worlds match", freshBack.hashState(0x811c9dc5) === fresh.hashState(0x811c9dc5));

const party = new Run(1);
party.begin({ seed: 31337, playerCount: 4, record: true, autoPick: true });
for (let i = 0; i < 1800; i++) {
  const s = stickAt(party.ticks);
  for (let p = 0; p < 4; p++) party.setStick(p, s.x * (p % 2 === 0 ? 1 : -1), s.y);
  if (party.over) break;
  party.tick();
}
const partyBytes = snapshotRun(party);
const partyBack = new Run(1);
partyBack.begin({ seed: 31337, playerCount: 4, record: true, autoPick: true });
check("a four-player snapshot restores", restoreRun(partyBack, partyBytes) === SNAPSHOT_ERROR.NONE);
check("four-player worlds match", partyBack.hashState(0x811c9dc5) === party.hashState(0x811c9dc5), `${party.players.count} players, ${party.enemies.count} enemies`);

let partyDiverged = -1;
for (let i = 0; i < 300; i++) {
  const s = stickAt(party.ticks);
  for (let p = 0; p < 4; p++) {
    party.setStick(p, s.x * (p % 2 === 0 ? 1 : -1), s.y);
    partyBack.setStick(p, s.x * (p % 2 === 0 ? 1 : -1), s.y);
  }
  party.tick();
  partyBack.tick();
  if (party.hashState(0x811c9dc5) !== partyBack.hashState(0x811c9dc5)) {
    partyDiverged = i;
    break;
  }
}
check("four players stay in lockstep after restore", partyDiverged === -1, partyDiverged === -1 ? "300 ticks agreed" : `diverged at ${partyDiverged}`);

/* ---- verdict ----------------------------------------------------------------------------------- */

console.log(failures === 0 ? "\nsnapshot: PASS" : `\nsnapshot: FAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
