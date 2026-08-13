/**
 * Tests for the co-op lab.
 *
 * The lab exists to break multiplayer on purpose, so these tests are mostly about the lab being honest:
 * a delayed packet arrives once, at the right moment, in the right order, holding the bytes it was given
 * and not whatever the sender's scratch buffer says later; a dropped packet never arrives; touching any
 * of it costs the run its ranking; and the two read-only views cost nothing.
 *
 * Run directly: `bun packages/mobile/game/dev/coop-lab.test.ts`. Exits non-zero on the first problem,
 * because a check that can report a failure and still exit 0 is not a check.
 */

import { Rng } from "../core/rng";
import { TAINT } from "../replay/format";
import {
  AGREEMENT,
  clampImpairment,
  CoopLab,
  createFaultRequest,
  createImpairment,
  createLinkReadout,
  FAULT,
  FAULT_LABEL,
  faultTaint,
  HashCompare,
  HOLD_CAPACITY,
  impairmentActive,
  ImpairedLink,
  JITTER_MAX_MS,
  LATENCY_MAX_MS,
  LOSS_MAX_PCT,
  readLinkInto,
  ROLE,
  type LinkSource,
  type StatsLike,
} from "./coop-lab";

let failures = 0;
let checks = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name}`);
}

/* ---- doubles ------------------------------------------------------------------------------------ */

/** A link that keeps what it was handed. Not a mock: it is the whole of the `Link` contract. */
class Sink {
  readonly got: Uint8Array[] = [];
  send(bytes: Uint8Array): void {
    this.got.push(bytes);
  }
  get count(): number {
    return this.got.length;
  }
  firstByteAt(i: number): number {
    return this.got[i]?.[0] ?? -1;
  }
}

function statsWith(over: Partial<StatsLike> = {}): StatsLike {
  return {
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    predictedFrames: 0,
    resyncsServed: 0,
    resyncsRequested: 0,
    hashMismatches: 0,
    stalledTicks: 0,
    snapshotBytes: 0,
    ...over,
  };
}

function sourceWith(over: Partial<LinkSource> = {}): LinkSource {
  return {
    isHost: true,
    tick: 599,
    protocolVersion: 4,
    stats: statsWith(),
    liveSeats: 4,
    heldSeats: 0,
    emptySeats: 0,
    rttP50: 62,
    rttP95: 71,
    rttWorst: 118,
    elapsedMs: 10_000,
    ...over,
  };
}

/* ---- 1. impairment is clamped ------------------------------------------------------------------- */

section("impairment values are clamped, because sliders are user input");
{
  const imp = createImpairment();
  check("a fresh impairment does nothing", !impairmentActive(imp));

  imp.latencyMs = 99_999;
  imp.jitterMs = -40;
  imp.lossPct = 400;
  clampImpairment(imp);
  check("latency clamps to its ceiling", imp.latencyMs === LATENCY_MAX_MS, String(imp.latencyMs));
  check("negative jitter clamps to zero", imp.jitterMs === 0, String(imp.jitterMs));
  check("loss clamps to 100%", imp.lossPct === LOSS_MAX_PCT, String(imp.lossPct));

  imp.latencyMs = 12.7;
  imp.jitterMs = JITTER_MAX_MS + 1;
  clampImpairment(imp);
  check("fractional milliseconds are truncated", imp.latencyMs === 12, String(imp.latencyMs));
  check("jitter clamps to its ceiling", imp.jitterMs === JITTER_MAX_MS, String(imp.jitterMs));

  const nan = createImpairment();
  nan.latencyMs = Number.NaN;
  clampImpairment(nan);
  check("a NaN slider becomes zero rather than poisoning the clock", nan.latencyMs === 0);

  const reorderOnly = createImpairment();
  reorderOnly.reorder = true;
  check("reordering alone still counts as impaired", impairmentActive(reorderOnly));
}

/* ---- 2. zero impairment is a straight pass-through --------------------------------------------- */

section("with nothing set, the link is transparent");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(1));
  const scratch = new Uint8Array([7, 7, 7]);

  link.send(scratch);
  check("the packet arrives immediately", sink.count === 1, `count=${sink.count}`);
  check("nothing was counted as dropped", link.stats.dropped === 0);
  check("nothing is in flight", link.stats.inFlight === 0);

  // Rule 3: the caller reuses its buffer, so the link must have copied.
  scratch[0] = 99;
  check("the delivered bytes were copied, not aliased", sink.firstByteAt(0) === 7, String(sink.firstByteAt(0)));
}

/* ---- 3. latency holds packets until their moment ------------------------------------------------ */

section("added latency delays delivery and nothing else");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(2));
  link.impairment.latencyMs = 100;

  link.send(new Uint8Array([1]));
  check("a delayed packet has not arrived yet", sink.count === 0);
  check("it is counted as in flight", link.stats.inFlight === 1);

  link.pump(50);
  check("still nothing at half the delay", sink.count === 0);

  link.pump(100);
  check("it arrives exactly at the delay", sink.count === 1, `count=${sink.count}`);
  check("in-flight drops back to zero", link.stats.inFlight === 0);

  link.pump(400);
  check("it arrives once, not once per pump", sink.count === 1, `count=${sink.count}`);
}

section("a held packet keeps the bytes it was given, not what the sender said later");
{
  // The gap the earlier copy check does not cover: a packet that is held for 200ms is the one that
  // actually matters, because the sender will have reused that scratch buffer many times over by the
  // time it is delivered. A held packet that aliased the caller's buffer would deliver garbage.
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(11));
  link.impairment.latencyMs = 200;
  const scratch = new Uint8Array([1, 2, 3]);

  link.send(scratch);
  scratch[0] = 41;
  link.send(scratch);
  scratch[0] = 42;

  link.pump(200);
  check("both held packets arrived", sink.count === 2, `count=${sink.count}`);
  check("the first held packet kept its own byte", sink.firstByteAt(0) === 1, String(sink.firstByteAt(0)));
  check("the second held packet kept its own byte", sink.firstByteAt(1) === 41, String(sink.firstByteAt(1)));
}

/* ---- 4. delay is not reorder -------------------------------------------------------------------- */

section("jitter delays packets without letting them overtake each other");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(1234));
  link.impairment.latencyMs = 20;
  link.impairment.jitterMs = 200;

  for (let i = 1; i <= 40; i++) link.send(new Uint8Array([i]));
  link.pump(100_000);

  check("every packet arrived", sink.count === 40, `count=${sink.count}`);
  let ordered = true;
  for (let i = 0; i < sink.count; i++) {
    if (sink.firstByteAt(i) !== i + 1) ordered = false;
  }
  check("arrival order matches send order", ordered, sink.got.map((b) => b[0]).join(","));
}

section("reordering happens only when it is asked for");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(1234));
  link.impairment.latencyMs = 20;
  link.impairment.jitterMs = 200;
  link.impairment.reorder = true;

  for (let i = 1; i <= 40; i++) link.send(new Uint8Array([i]));
  link.pump(100_000);

  check("every packet still arrived", sink.count === 40, `count=${sink.count}`);
  let outOfOrderSomewhere = false;
  for (let i = 0; i < sink.count; i++) {
    if (sink.firstByteAt(i) !== i + 1) outOfOrderSomewhere = true;
  }
  check("with reordering on, order is genuinely disturbed", outOfOrderSomewhere);
}

/* ---- 5. loss ------------------------------------------------------------------------------------ */

section("packet loss loses packets, and the numbers add up");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(77));
  link.impairment.lossPct = 50;

  for (let i = 0; i < 400; i++) link.send(new Uint8Array([1]));
  link.pump(1_000);

  check("sent is every attempt", link.stats.sent === 400, String(link.stats.sent));
  check(
    "delivered plus dropped equals sent",
    link.stats.delivered + link.stats.dropped === link.stats.sent,
    `${link.stats.delivered}+${link.stats.dropped}`,
  );
  check("about half went missing", link.stats.dropped > 150 && link.stats.dropped < 250, String(link.stats.dropped));
  check("what arrived is what was delivered", sink.count === link.stats.delivered);

  const total = new ImpairedLink(new Sink(), new Rng(5));
  total.impairment.lossPct = 100;
  for (let i = 0; i < 50; i++) total.send(new Uint8Array([1]));
  total.pump(10_000);
  check("100% loss delivers nothing at all", total.stats.delivered === 0, String(total.stats.delivered));

  const none = new ImpairedLink(new Sink(), new Rng(5));
  none.impairment.lossPct = 0;
  for (let i = 0; i < 50; i++) none.send(new Uint8Array([1]));
  check("0% loss drops nothing at all", none.stats.dropped === 0, String(none.stats.dropped));
}

section("a lost packet never occupied a queue slot");
{
  const link = new ImpairedLink(new Sink(), new Rng(9));
  link.impairment.lossPct = 100;
  link.impairment.latencyMs = 500;
  for (let i = 0; i < HOLD_CAPACITY * 2; i++) link.send(new Uint8Array([1]));
  check("nothing is held", link.stats.inFlight === 0, String(link.stats.inFlight));
  check("heavy loss never overflows the queue", link.stats.overflowed === 0, String(link.stats.overflowed));
}

/* ---- 6. the queue has a ceiling ----------------------------------------------------------------- */

section("the hold queue is bounded, and overflow is reported separately from loss");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(3));
  link.impairment.latencyMs = 5_000;

  for (let i = 0; i < HOLD_CAPACITY + 40; i++) link.send(new Uint8Array([1]));
  check("in flight is capped", link.stats.inFlight === HOLD_CAPACITY, String(link.stats.inFlight));
  check("the excess is counted as overflow", link.stats.overflowed === 40, String(link.stats.overflowed));
  check("overflow is not counted as loss", link.stats.dropped === 0, String(link.stats.dropped));

  link.pump(10_000);
  check("the survivors all arrive", sink.count === HOLD_CAPACITY, `count=${sink.count}`);
}

/* ---- 7. the clock never runs backwards ---------------------------------------------------------- */

section("time never goes backwards, so a packet can never be stranded");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(4));
  link.impairment.latencyMs = 100;

  link.pump(1_000);
  link.send(new Uint8Array([1]));
  link.pump(500); // a clock that jumped back
  check("a backwards clock delivers nothing early", sink.count === 0, `count=${sink.count}`);
  link.pump(1_100);
  check("the packet still arrives on its own schedule", sink.count === 1, `count=${sink.count}`);
}

section("tearing down throws away what was in flight");
{
  const sink = new Sink();
  const link = new ImpairedLink(sink, new Rng(4));
  link.impairment.latencyMs = 100;
  link.send(new Uint8Array([1]));
  link.flushAway();
  link.pump(100_000);
  check("a flushed packet never arrives", sink.count === 0, `count=${sink.count}`);
  check("nothing is left in flight", link.stats.inFlight === 0);
}

/* ---- 8. every fault costs the run its ranking --------------------------------------------------- */

section("using the lab taints the run");
{
  const lab = new CoopLab();
  check("a fresh lab is clean", lab.clean);
  check("a clean lab taints nothing", lab.taintUsed() === 0);

  const noop = lab.setImpairment(0, 0, 0);
  check("setting every slider to zero taints nothing", noop === 0 && lab.clean);

  const bits = lab.setImpairment(150, 30, 2);
  check("moving a slider taints", bits === TAINT.DEV_TOGGLE, String(bits));
  check("the lab remembers being used", !lab.clean);
  check("the sliders took the values", lab.impairment.latencyMs === 150 && lab.impairment.lossPct === 2);

  const zeroed = lab.setImpairment(0, 0, 0);
  check("zeroing the sliders afterwards costs nothing more", zeroed === 0);
  check("but the run stays tainted, because taint is one-way", !lab.clean);
}

section("each fault declares its own taint, and every fault has one");
{
  const kinds = [
    FAULT.FORCE_DESYNC,
    FAULT.DROP_GUEST,
    FAULT.MIGRATE_HOST,
    FAULT.STALL_HOST,
    FAULT.REPLAY_DIVERGE,
  ] as const;

  check("no fault is free", kinds.every((k) => faultTaint(k) !== 0));
  check(
    "every fault at least reports a dev toggle",
    kinds.every((k) => (faultTaint(k) & TAINT.DEV_TOGGLE) !== 0),
  );
  check("forcing a desync is reported as touching the rng", (faultTaint(FAULT.FORCE_DESYNC) & TAINT.RNG_EDIT) !== 0);
  check("stalling the host is reported as touching time", (faultTaint(FAULT.STALL_HOST) & TAINT.TIME_SCALE) !== 0);
  check(
    "diverging the replay is reported as synthetic input",
    (faultTaint(FAULT.REPLAY_DIVERGE) & TAINT.SYNTHETIC_INPUT) !== 0,
  );
  check("doing nothing costs nothing", faultTaint(FAULT.NONE) === 0);

  const labelled = [FAULT.NONE, ...kinds].every((k) => (FAULT_LABEL[k] ?? "") !== "");
  check("every fault has a label to show", labelled);

  const ids = new Set<number>(Object.values(FAULT));
  check("fault ids are distinct", ids.size === Object.values(FAULT).length);
}

/* ---- 9. faults are one-shot and drain in order -------------------------------------------------- */

section("faults are carried out once, in the order they were asked for");
{
  const lab = new CoopLab();
  const out = createFaultRequest();

  check("nothing to do on an untouched lab", !lab.takeFault(out));
  check("an empty drain reports no fault", out.kind === FAULT.NONE);

  lab.requestFault(FAULT.MIGRATE_HOST);
  lab.requestFault(FAULT.DROP_GUEST, 2);
  check("two faults are pending", lab.pending === 2, String(lab.pending));

  check("the first one out is the first one in", lab.takeFault(out) && out.kind === FAULT.MIGRATE_HOST);
  check("the second carries its target seat", lab.takeFault(out) && out.kind === FAULT.DROP_GUEST && out.slot === 2);
  check("the queue is empty afterwards", !lab.takeFault(out) && lab.pending === 0);
  check("the count of what was fired is kept", lab.firedCount(FAULT.DROP_GUEST) === 1);

  const impossible = new CoopLab();
  impossible.requestFault(FAULT.DROP_GUEST, 99);
  impossible.takeFault(out);
  check("an impossible seat is clamped into the party", out.slot === 3, String(out.slot));

  const mashed = new CoopLab();
  for (let i = 0; i < 500; i++) mashed.requestFault(FAULT.MIGRATE_HOST);
  check("mashing the button cannot queue five hundred migrations", mashed.pending <= 8, String(mashed.pending));
  check("but every press is still counted", mashed.firedCount(FAULT.MIGRATE_HOST) === 500);
  check("and it still taints", !mashed.clean);

  const nothing = new CoopLab();
  check("asking for no fault does nothing", nothing.requestFault(FAULT.NONE) === 0);
  check("and taints nothing", nothing.clean && nothing.pending === 0);
}

section("resetting between runs makes the next run clean again");
{
  const lab = new CoopLab();
  lab.setImpairment(200, 50, 10);
  lab.requestFault(FAULT.FORCE_DESYNC);
  lab.reset();
  check("the sliders are back to zero", !impairmentActive(lab.impairment));
  check("the queue is empty", lab.pending === 0);
  check("the next run starts clean", lab.clean && lab.taintUsed() === 0);
  check("the fired counts are cleared", lab.firedCount(FAULT.FORCE_DESYNC) === 0);
}

/* ---- 10. the readout ---------------------------------------------------------------------------- */

section("the readout reports what the session actually did");
{
  const out = createLinkReadout();
  const imp = createImpairment();

  readLinkInto(sourceWith({ isHost: true }), imp, out);
  check("a host says host", out.role === ROLE.HOST);
  readLinkInto(sourceWith({ isHost: false }), imp, out);
  check("a guest says guest", out.role === ROLE.GUEST);

  readLinkInto(
    sourceWith({ stats: statsWith({ bytesSent: 240_000, bytesReceived: 80_000 }), elapsedMs: 10_000 }),
    imp,
    out,
  );
  check("upstream rate is per second", out.upBytesPerSec === 24_000, String(out.upBytesPerSec));
  check("downstream rate is per second", out.downBytesPerSec === 8_000, String(out.downBytesPerSec));

  readLinkInto(sourceWith({ elapsedMs: 0, stats: statsWith({ bytesSent: 500 }) }), imp, out);
  check("a session that has not started yet reports zero, not infinity", out.upBytesPerSec === 0);

  readLinkInto(sourceWith({ tick: 999, stats: statsWith({ predictedFrames: 4 }) }), imp, out);
  check("prediction is reported per thousand ticks", out.predictedPermille === 4, String(out.predictedPermille));

  readLinkInto(sourceWith({ tick: -1, stats: statsWith({ predictedFrames: 3 }) }), imp, out);
  check("before the first tick the rate is zero rather than a divide by zero", out.predictedPermille === 0);

  readLinkInto(
    sourceWith({ isHost: true, stats: statsWith({ resyncsServed: 3, resyncsRequested: 9 }) }),
    imp,
    out,
  );
  check("a host reports the resyncs it served", out.resyncs === 3, String(out.resyncs));
  readLinkInto(
    sourceWith({ isHost: false, stats: statsWith({ resyncsServed: 3, resyncsRequested: 9 }) }),
    imp,
    out,
  );
  check("a guest reports the resyncs it asked for", out.resyncs === 9, String(out.resyncs));

  readLinkInto(sourceWith({ rttP50: -5, rttP95: 70.4, rttWorst: 118.6 }), imp, out);
  check("round-trip times are whole milliseconds", out.rttP95 === 70 && out.rttWorst === 119);
  check("a nonsense negative time reads as zero", out.rttP50 === 0, String(out.rttP50));

  readLinkInto(sourceWith({ liveSeats: 3, heldSeats: 1, emptySeats: 0 }), imp, out);
  check("held seats are reported apart from live ones", out.liveSeats === 3 && out.heldSeats === 1);
  check("the protocol version is on show", out.protocolVersion === 4);

  check("an untouched session is not flagged as impaired", out.impaired === false);
  imp.lossPct = 2;
  readLinkInto(sourceWith(), imp, out);
  check("a distorted session says so, so nobody debugs a fault they caused", out.impaired === true);
}

section("the readout is filled in place, never rebuilt");
{
  const out = createLinkReadout();
  const imp = createImpairment();
  const before = out;
  for (let i = 0; i < 100; i++) readLinkInto(sourceWith({ tick: i }), imp, out);
  check("the same object is reused every frame", out === before);
  check("and it holds the latest values", out.tick === 99);
}

/* ---- 11. hash comparison ------------------------------------------------------------------------ */

section("the hash board shows who agrees with this device");
{
  const cmp = new HashCompare(0);
  check("nothing is known before anyone reports", cmp.agreementOf(1) === AGREEMENT.UNKNOWN);
  check("and the party counts as in sync", cmp.inSync);

  cmp.report(0, 600, 0x7f3a21c8);
  cmp.report(1, 600, 0x7f3a21c8);
  cmp.report(2, 600, 0x7f3a21c8);
  check("we agree with ourselves", cmp.agreementOf(0) === AGREEMENT.AGREE);
  check("a matching seat agrees", cmp.agreementOf(1) === AGREEMENT.AGREE);
  check("a seat that never reported stays unknown", cmp.agreementOf(3) === AGREEMENT.UNKNOWN);
  check("nobody disagrees", cmp.disagreeMask() === 0 && cmp.inSync);

  cmp.report(3, 600, 0x91b0e45d);
  check("a mismatching seat is called out", cmp.agreementOf(3) === AGREEMENT.DISAGREE);
  check("the disagreement is a bit for that seat", cmp.disagreeMask() === 0b1000, cmp.disagreeMask().toString(2));
  check("the party is no longer in sync", !cmp.inSync);
  check("the mismatching hash is kept for display", cmp.hashOf(3) === (0x91b0e45d | 0));
}

section("the board only ever talks about one tick");
{
  const cmp = new HashCompare(0);
  cmp.report(0, 600, 111);
  cmp.report(1, 600, 222);
  check("the mismatch is seen", cmp.agreementOf(1) === AGREEMENT.DISAGREE);

  const stale = cmp.report(1, 500, 111);
  check("a hash from an older tick is refused", !stale);
  check("and it does not repair the verdict", cmp.agreementOf(1) === AGREEMENT.DISAGREE);
  check("the tick on show is unchanged", cmp.tick === 600, String(cmp.tick));

  cmp.report(0, 720, 333);
  check("a newer tick starts a fresh board", cmp.tick === 720);
  check("old verdicts are thrown away rather than carried forward", cmp.agreementOf(1) === AGREEMENT.UNKNOWN);
  check("and the seat is no longer marked as having reported", !cmp.hasReported(1));
}

section("a seat that reports before we do is judged the moment our own hash lands");
{
  const cmp = new HashCompare(0);
  cmp.report(2, 900, 555);
  check("with nothing to compare against, the verdict is unknown", cmp.agreementOf(2) === AGREEMENT.UNKNOWN);
  check("but the report itself was not thrown away", cmp.hasReported(2));

  cmp.report(0, 900, 444);
  check("once we report, the earlier seat is judged", cmp.agreementOf(2) === AGREEMENT.DISAGREE);
}

section("the reference is whichever seat this device is");
{
  const cmp = new HashCompare(1);
  cmp.report(0, 600, 111);
  cmp.report(1, 600, 222);
  cmp.report(2, 600, 222);
  check("we agree with ourselves whatever seat we are", cmp.agreementOf(1) === AGREEMENT.AGREE);
  check("the seat matching us agrees", cmp.agreementOf(2) === AGREEMENT.AGREE);
  check("the odd one out disagrees", cmp.agreementOf(0) === AGREEMENT.DISAGREE);

  cmp.setLocalSlot(0);
  check("changing our own seat re-judges the board", cmp.agreementOf(0) === AGREEMENT.AGREE);
  check("and everyone else is judged against the new reference", cmp.agreementOf(2) === AGREEMENT.DISAGREE);

  cmp.setLocalSlot(99);
  check("an impossible seat is clamped rather than read off the end", cmp.agreementOf(3) === AGREEMENT.UNKNOWN);

  cmp.reset();
  check("resetting clears the board", cmp.tick === -1 && cmp.agreementOf(0) === AGREEMENT.UNKNOWN);
  check("and an empty board counts as in sync", cmp.inSync);
}

section("an out-of-range seat cannot corrupt a neighbour");
{
  const cmp = new HashCompare(0);
  cmp.report(0, 10, 1);
  cmp.report(7, 10, 999);
  check("a seat past the end lands on the last seat", cmp.hashOf(3) === 999, String(cmp.hashOf(3)));
  check("and the seats before it are untouched", cmp.hashOf(1) === 0 && cmp.hashOf(2) === 0);
}

/* ---- done --------------------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) in the co-op lab`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
} else {
  console.log("PASS — co-op lab");
}
