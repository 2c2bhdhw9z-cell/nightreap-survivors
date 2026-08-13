/**
 * The fake network, checked against itself. Run headless:
 *   `bun packages/mobile/game/net/sim-network.test.ts`
 *
 * WHY THIS FILE EXISTS
 * Every co-op guarantee we claim — prediction covers a late input, the next confirm repairs a lost
 * one, a guest that falls out of the window resyncs — is proven by running a party over this harness.
 * A harness that quietly lies therefore invalidates all of it at once. If the wire delivered a packet
 * on the tick it was sent, prediction would never be exercised and the tests would pass for the wrong
 * reason. If it handed the receiver the sender's own buffer, aliasing bugs would be invisible here and
 * fatal on a phone.
 *
 * WHAT IT PROVES
 *   1. The same seed produces the same drops, duplicates and delivery order, every run.
 *   2. A different seed produces a different pattern, so the seed is actually doing something.
 *   3. Nothing is ever delivered on the tick it was sent, even at zero latency.
 *   4. Latency really is applied, in ticks, and jitter really does reorder.
 *   5. Every byte is copied on the way in, so a reused send buffer cannot rewrite a queued packet.
 *   6. A dropped packet occupies nothing and is counted.
 *   7. Severing one slot leaves every other slot working, in both directions.
 *   8. `flush` settles and cannot spin forever.
 *   9. A perfect wire is genuinely perfect.
 *  10. The party harness wires the right number of members and the divergence check is not vacuous.
 */

import { MS_PER_TICK } from "./clock";
import { MSG } from "./protocol";
import {
  AWFUL_CONDITIONS,
  DEFAULT_CONDITIONS,
  PERFECT_CONDITIONS,
  SimNetwork,
  firstDivergentTick,
  makeParty,
  runParty,
} from "./sim-network";
import type { NetConditions, Party } from "./sim-network";
import { HashTrail } from "./state-hash";

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

/** A stand-in message. The harness never looks inside a packet, so any bytes will do. */
function packet(tag: number, size = 8): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = MSG.INPUT_BATCH;
  bytes[1] = tag & 0xff;
  for (let i = 2; i < size; i++) bytes[i] = (tag * 7 + i) & 0xff;
  return bytes;
}

function conditions(over: Partial<NetConditions>): NetConditions {
  return { latencyMs: 0, jitterMs: 0, loss: 0, duplicate: 0, ...over };
}

/* ---- 1. the conditions the gate is measured against --------------------------------------------- */

section("conditions");
{
  // These four numbers are the perf contract, not decoration. If someone edits them the co-op gate
  // silently starts measuring something easier than what we promised.
  check("the default round trip is the contract's 150ms", DEFAULT_CONDITIONS.latencyMs * 2 === 150);
  check("the default loss is the contract's 2%", DEFAULT_CONDITIONS.loss === 0.02);
  check("the default jitter is real but modest", DEFAULT_CONDITIONS.jitterMs === 15);
  check("the default duplicates something", DEFAULT_CONDITIONS.duplicate > 0);

  check("a perfect wire has no latency", PERFECT_CONDITIONS.latencyMs === 0);
  check("a perfect wire loses nothing", PERFECT_CONDITIONS.loss === 0);
  check("a perfect wire duplicates nothing", PERFECT_CONDITIONS.duplicate === 0);
  check("a perfect wire has no jitter", PERFECT_CONDITIONS.jitterMs === 0);

  check("the awful wire is worse than the gate on every axis", 
    AWFUL_CONDITIONS.latencyMs > DEFAULT_CONDITIONS.latencyMs &&
    AWFUL_CONDITIONS.jitterMs > DEFAULT_CONDITIONS.jitterMs &&
    AWFUL_CONDITIONS.loss > DEFAULT_CONDITIONS.loss &&
    AWFUL_CONDITIONS.duplicate > DEFAULT_CONDITIONS.duplicate,
  );
}

/* ---- 2. reproducibility ------------------------------------------------------------------------ */

section("reproducibility");
{
  /** Run a fixed traffic pattern and record exactly what arrived, in order. */
  function trace(seed: number, cond = DEFAULT_CONDITIONS): { log: string[]; sent: number; dropped: number; delivered: number } {
    const net = new SimNetwork(cond, seed);
    const log: string[] = [];
    net.onHost((slot, bytes) => log.push(`h<${slot}:${bytes[1]}`));
    for (let slot = 1; slot <= 3; slot++) {
      net.onGuest(slot, (bytes) => log.push(`g${slot}<${bytes[1]}`));
    }
    const toHost = [net.linkToHost(1), net.linkToHost(2), net.linkToHost(3)];
    const toGuest = [net.linkToGuest(1), net.linkToGuest(2), net.linkToGuest(3)];

    for (let tick = 0; tick < 400; tick++) {
      for (let i = 0; i < 3; i++) {
        toHost[i]?.send(packet(tick));
        toGuest[i]?.send(packet(tick + 1000, 12));
      }
      net.pump();
    }
    net.flush();
    return { log, sent: net.tally.sent, dropped: net.tally.dropped, delivered: net.tally.delivered };
  }

  const a = trace(0x1234);
  const b = trace(0x1234);
  const c = trace(0x9999);

  check("the same seed sends the same amount", a.sent === b.sent, `${a.sent}`);
  check("the same seed drops the same packets", a.dropped === b.dropped, `${a.dropped}`);
  check("the same seed delivers the same amount", a.delivered === b.delivered, `${a.delivered}`);
  check("the same seed delivers in the same order", a.log.join("|") === b.log.join("|"));
  check("a different seed drops a different set", a.dropped !== c.dropped || a.log.join("|") !== c.log.join("|"), `${a.dropped} vs ${c.dropped}`);

  // The conditions were actually applied, not just configured.
  check("the default wire really lost packets", a.dropped > 0, `${a.dropped} of ${a.sent}`);
  check(
    "and lost roughly the stated share",
    a.dropped / a.sent > 0.005 && a.dropped / a.sent < 0.06,
    `${((a.dropped / a.sent) * 100).toFixed(2)}%`,
  );
  check("everything that was not lost arrived", a.delivered > 0 && a.log.length === a.delivered, `${a.delivered}`);
}

/* ---- 3. delivery timing ------------------------------------------------------------------------ */

section("delivery timing");
{
  // Nothing arrives on the tick it was sent, even on a zero-latency wire. A same-tick delivery would
  // mean a guest could see a host decision before it had simulated the tick, which no real path does —
  // and it would quietly stop the prediction path from ever being exercised.
  const instant = new SimNetwork(PERFECT_CONDITIONS, 1);
  let arrived = 0;
  instant.onGuest(1, () => arrived++);
  instant.linkToGuest(1).send(packet(1));
  check("a packet does not arrive before a pump", arrived === 0);
  check("and it is in flight", instant.inFlight === 1);
  instant.pump();
  check("one pump delivers it on a perfect wire", arrived === 1);
  check("and the queue is empty", instant.inFlight === 0);

  // Latency converts to whole ticks, once.
  const oneHundredMs = new SimNetwork(conditions({ latencyMs: 100 }), 1);
  const expected = Math.max(1, Math.round(100 / MS_PER_TICK));
  check("100ms is six ticks", expected === 6, `${expected}`);
  let late = 0;
  oneHundredMs.onHost(() => late++);
  oneHundredMs.linkToHost(1).send(packet(1));
  for (let i = 0; i < expected - 1; i++) oneHundredMs.pump();
  check("it has not arrived early", late === 0, `after ${expected - 1} ticks`);
  oneHundredMs.pump();
  check("it arrives on the right tick", late === 1);

  // Within one tick, delivery follows send order — the queue is not a set.
  const ordered = new SimNetwork(PERFECT_CONDITIONS, 1);
  const seenOrder: number[] = [];
  ordered.onGuest(1, (bytes) => seenOrder.push(bytes[1] as number));
  const link = ordered.linkToGuest(1);
  for (let i = 0; i < 10; i++) link.send(packet(i));
  ordered.pump();
  check("send order is preserved inside a tick", seenOrder.join(",") === "0,1,2,3,4,5,6,7,8,9", seenOrder.join(","));
  check("no reordering was counted on a perfect wire", ordered.tally.reordered === 0);

  // Jitter is what produces genuine reordering, and it has to actually happen or the "arrives out of
  // order" half of the netcode is never tested.
  const jittery = new SimNetwork(conditions({ latencyMs: 60, jitterMs: 120 }), 7);
  const jitterOrder: number[] = [];
  jittery.onGuest(1, (bytes) => jitterOrder.push(bytes[1] as number));
  const jlink = jittery.linkToGuest(1);
  for (let tick = 0; tick < 200; tick++) {
    jlink.send(packet(tick));
    jittery.pump();
  }
  jittery.flush();
  check("jitter reordered packets", jittery.tally.reordered > 0, `${jittery.tally.reordered} of ${jittery.tally.delivered}`);
  let outOfOrderSeen = false;
  for (let i = 1; i < jitterOrder.length; i++) {
    if ((jitterOrder[i] as number) < (jitterOrder[i - 1] as number)) outOfOrderSeen = true;
  }
  check("and the receiver really saw them out of order", outOfOrderSeen);
  check("nothing was lost on a lossless jittery wire", jittery.tally.dropped === 0);
  check("everything eventually arrived", jittery.tally.delivered === jittery.tally.sent, `${jittery.tally.delivered}/${jittery.tally.sent}`);

  // Zero jitter means no reordering at all, however long the run.
  const steady = new SimNetwork(conditions({ latencyMs: 200 }), 3);
  const slink = steady.linkToGuest(1);
  steady.onGuest(1, () => {});
  for (let tick = 0; tick < 300; tick++) {
    slink.send(packet(tick));
    steady.pump();
  }
  steady.flush();
  check("a steady wire never reorders", steady.tally.reordered === 0);
}

/* ---- 4. the harness copies every byte ----------------------------------------------------------- */

section("byte ownership");
{
  // The session layer reuses one write buffer per message, exactly as the real one does. If the
  // harness queued that buffer instead of a copy, the next message would rewrite a packet already in
  // flight — and every aliasing bug in the codec would pass here and fail on a phone.
  const net = new SimNetwork(conditions({ latencyMs: 50 }), 1);
  const received: Uint8Array[] = [];
  net.onGuest(1, (bytes) => received.push(bytes));
  const link = net.linkToGuest(1);

  const shared = new Uint8Array(8);
  shared[1] = 11;
  link.send(shared);
  shared[1] = 22;
  link.send(shared);
  shared.fill(0xff);

  net.flush();
  check("both packets arrived", received.length === 2, `${received.length}`);
  check("the first packet kept its own bytes", received[0]?.[1] === 11, `${received[0]?.[1]}`);
  check("the second packet kept its own bytes", received[1]?.[1] === 22, `${received[1]?.[1]}`);
  check("neither saw the later overwrite", received[0]?.[1] !== 0xff && received[1]?.[1] !== 0xff);
  check("the delivered buffer is not the sender's", received[0] !== shared && received[1] !== shared);

  // A duplicate is two independent packets, not the same object handed over twice.
  const dup = new SimNetwork(conditions({ latencyMs: 30, duplicate: 1 }), 5);
  const copies: Uint8Array[] = [];
  dup.onGuest(1, (bytes) => copies.push(bytes));
  dup.linkToGuest(1).send(packet(9));
  dup.flush();
  check("a duplicate arrives twice", copies.length === 2, `${copies.length}`);
  check("and was counted once as a duplication", dup.tally.duplicated === 1);
  check("the two copies are separate buffers", copies[0] !== copies[1]);
  check("but carry the same bytes", copies[0]?.[1] === copies[1]?.[1]);
  check("bytes counted include the duplicate", dup.tally.bytes === 16, `${dup.tally.bytes}`);
  check("sent counts the message once", dup.tally.sent === 1, `${dup.tally.sent}`);
  check("delivered counts both copies", dup.tally.delivered === 2, `${dup.tally.delivered}`);

  // A zero-length message is legal and must not be turned into a delivery of something else.
  const empty = new SimNetwork(PERFECT_CONDITIONS, 1);
  let emptyLength = -1;
  empty.onGuest(1, (bytes) => {
    emptyLength = bytes.byteLength;
  });
  empty.linkToGuest(1).send(new Uint8Array(0));
  empty.pump();
  check("an empty message arrives empty", emptyLength === 0, `${emptyLength}`);
}

/* ---- 5. loss ----------------------------------------------------------------------------------- */

section("loss");
{
  // A lost packet costs nothing: it is never queued, never delivered, and it is counted.
  const gone = new SimNetwork(conditions({ latencyMs: 50, loss: 1 }), 1);
  let delivered = 0;
  gone.onHost(() => delivered++);
  gone.onGuest(1, () => delivered++);
  for (let i = 0; i < 50; i++) {
    gone.linkToHost(1).send(packet(i));
    gone.linkToGuest(1).send(packet(i));
  }
  check("a fully lossy wire queues nothing", gone.inFlight === 0);
  gone.flush();
  check("and delivers nothing", delivered === 0);
  check("everything was counted as sent", gone.tally.sent === 100, `${gone.tally.sent}`);
  check("everything was counted as dropped", gone.tally.dropped === 100, `${gone.tally.dropped}`);
  check("nothing was counted as delivered", gone.tally.delivered === 0);
  check("no bytes were counted for a dropped packet", gone.tally.bytes === 0, `${gone.tally.bytes}`);

  // Loss is per message and independent, so a heavy path still gets most traffic through.
  const heavy = new SimNetwork(conditions({ latencyMs: 50, loss: 0.1 }), 42);
  heavy.onGuest(1, () => {});
  for (let i = 0; i < 2000; i++) heavy.linkToGuest(1).send(packet(i));
  heavy.flush();
  const ratio = heavy.tally.dropped / heavy.tally.sent;
  check("a tenth-loss path loses about a tenth", ratio > 0.07 && ratio < 0.13, `${(ratio * 100).toFixed(1)}%`);
  check("and gets the rest through", heavy.tally.delivered === heavy.tally.sent - heavy.tally.dropped);
}

/* ---- 6. severing one slot ---------------------------------------------------------------------- */

section("severing");
{
  // The reason the network owns the whole party rather than one instance per connection: a test needs
  // to kill one phone and prove the other three carry on. Both directions of that slot must die.
  const net = new SimNetwork(PERFECT_CONDITIONS, 1);
  const toHostFrom = [0, 0, 0, 0];
  const toGuest = [0, 0, 0, 0];
  net.onHost((slot) => {
    toHostFrom[slot] = (toHostFrom[slot] as number) + 1;
  });
  for (let slot = 1; slot <= 3; slot++) {
    net.onGuest(slot, () => {
      toGuest[slot] = (toGuest[slot] as number) + 1;
    });
  }

  check("nothing is severed to start with", !net.isSevered(2));
  net.sever(2);
  check("severing is visible", net.isSevered(2));
  check("and only for that slot", !net.isSevered(1) && !net.isSevered(3));

  for (let slot = 1; slot <= 3; slot++) {
    net.linkToHost(slot).send(packet(slot));
    net.linkToGuest(slot).send(packet(slot));
  }
  net.flush();

  check("the severed guest heard nothing", toGuest[2] === 0);
  check("the host heard nothing from the severed guest", toHostFrom[2] === 0);
  check("the other guests heard the host", toGuest[1] === 1 && toGuest[3] === 1);
  check("and the host heard them", toHostFrom[1] === 1 && toHostFrom[3] === 1);
  check("the severed traffic was counted as dropped", net.tally.dropped === 2, `${net.tally.dropped}`);

  // Restoring reconnects, and nothing sent during the outage comes back — a dead connection is not a
  // buffer, which is exactly why the session has to resync rather than wait.
  net.restore(2);
  check("restoring clears the severance", !net.isSevered(2));
  net.linkToGuest(2).send(packet(2));
  net.flush();
  check("the restored guest hears again", toGuest[2] === 1, `${toGuest[2]}`);
  check("nothing from the outage was replayed", toGuest[2] === 1);

  // Severing an already-severed slot is harmless, and so is restoring one that was never severed.
  net.sever(3);
  net.sever(3);
  net.restore(1);
  check("double severing is harmless", net.isSevered(3) && !net.isSevered(1));
}

/* ---- 7. flush -------------------------------------------------------------------------------- */

section("flush");
{
  const net = new SimNetwork(conditions({ latencyMs: 200, jitterMs: 80 }), 11);
  net.onGuest(1, () => {});
  for (let i = 0; i < 100; i++) net.linkToGuest(1).send(packet(i));
  check("the queue is full", net.inFlight === 100, `${net.inFlight}`);
  net.flush();
  check("flush settles the queue", net.inFlight === 0);
  check("flush delivered everything", net.tally.delivered === 100, `${net.tally.delivered}`);
  check("flushing an empty queue is a no-op", (() => { net.flush(); return net.inFlight === 0; })());

  // The guard exists so a mistake in the delivery arithmetic cannot hang the whole test run. A budget
  // too small to settle the queue must return with work outstanding rather than spin.
  const slow = new SimNetwork(conditions({ latencyMs: 5000 }), 1);
  slow.onGuest(1, () => {});
  slow.linkToGuest(1).send(packet(1));
  slow.flush(3);
  check("a flush budget that cannot settle returns anyway", slow.inFlight === 1, `${slow.inFlight}`);
  slow.flush();
  check("and a full flush finishes the job", slow.inFlight === 0);
}

/* ---- 8. the party harness ---------------------------------------------------------------------- */

section("party harness");
{
  const solo = makeParty({ playerCount: 1, conditions: PERFECT_CONDITIONS });
  check("a solo party has no guests", solo.guests.length === 0);
  check("and still reports its size", solo.playerCount === 1);

  const four = makeParty({ playerCount: 4, conditions: PERFECT_CONDITIONS, netSeed: 1 });
  check("a four-player party has three guests", four.guests.length === 3, `${four.guests.length}`);
  check("the party reports its size", four.playerCount === 4);

  // Running the party advances the host, and traffic really crosses the harness.
  const beforeSent = four.net.tally.sent;
  const beforeTick = four.host.tick;
  runParty(four, 200);
  check("the host advanced by the ticks asked for", four.host.tick - beforeTick === 200, `${beforeTick} -> ${four.host.tick}`);
  check("traffic crossed the wire", four.net.tally.sent > beforeSent, `${four.net.tally.sent - beforeSent}`);
  check("the guests advanced too", four.guests.every((g) => g.tick > 0), four.guests.map((g) => g.tick).join(","));

  // The driver hook is called once per tick, before the host seals it.
  let driven = 0;
  runParty(four, 30, () => {
    driven++;
  });
  check("the driver runs once per tick", driven === 30, `${driven}`);

  // Every member built the same world from the same seed, so a perfect wire must show no divergence —
  // and the check has to be comparing something, or a -1 means nothing at all.
  const clean = firstDivergentTick(four);
  check("a perfect party does not diverge", clean.tick === -1, `tick ${clean.tick} slot ${clean.slot}`);

  let compared = 0;
  for (const g of four.guests) {
    for (let t = Math.max(0, g.tick - 600); t <= g.tick; t++) {
      if (g.trail.has(t) && four.host.trail.has(t)) compared++;
    }
  }
  check("and the check actually compared some ticks", compared > 0, `${compared} ticks compared`);

  // A party on the contract's own wire, which is the condition the co-op gate is written against.
  const gate = makeParty({ playerCount: 4, conditions: DEFAULT_CONDITIONS, netSeed: 99 });
  runParty(gate, 600);
  gate.net.flush();
  for (const g of gate.guests) g.pump();
  const gateResult = firstDivergentTick(gate);
  check("a party on the contract wire does not diverge", gateResult.tick === -1, `tick ${gateResult.tick} slot ${gateResult.slot}`);
  check("and the contract wire really lost packets", gate.net.tally.dropped > 0, `${gate.net.tally.dropped}`);

  // The divergence check itself, proven able to fail. A -1 from a check that cannot return anything
  // else would be the most expensive false pass in the project.
  const hostTrail = new HashTrail(64);
  const guestTrail = new HashTrail(64);
  for (let t = 0; t < 10; t++) {
    hostTrail.record(t, 1000 + t);
    guestTrail.record(t, t === 6 ? -1 : 1000 + t);
  }
  const fake = {
    net: four.net,
    host: { tick: 9, trail: hostTrail },
    guests: [{ tick: 9, trail: guestTrail }],
    playerCount: 2,
  } as unknown as Party;
  const found = firstDivergentTick(fake);
  check("a real disagreement is found", found.tick === 6, `${found.tick}`);
  check("and the guilty seat is named", found.slot === 1, `${found.slot}`);

  const agreeing = {
    net: four.net,
    host: { tick: 9, trail: hostTrail },
    guests: [{ tick: 9, trail: hostTrail }],
    playerCount: 2,
  } as unknown as Party;
  check("agreement reports nothing", firstDivergentTick(agreeing).tick === -1);
}

console.log(
  `\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}\n`,
);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
