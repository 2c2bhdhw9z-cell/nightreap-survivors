/**
 * A fake network, good enough to be cruel.
 *
 * WHY THIS EXISTS
 * The co-op session layer has exactly three answers to a bad connection: predict a late input, repair
 * a lost confirm with the next one, and resync a guest that fell out of the window. None of those
 * three can be proven on a desk with four phones on the same wifi, because the interesting conditions
 * — 150ms of lag, 2% of packets simply gone, packets arriving out of order — do not happen there. So
 * we build the bad network instead, and we make it reproducible.
 *
 * WHAT MAKES IT USABLE AS A TEST
 * Everything is driven off a seeded RNG and a tick counter. No timers, no `setTimeout`, no real clock.
 * A run with the same seed drops the same packets at the same moments every time, forever, on any
 * machine. A netcode bug that shows up one time in five hundred is worth nothing if you cannot make it
 * happen again on demand.
 *
 * It satisfies `Link` and nothing else. The session code cannot tell it apart from a WebSocket, which
 * is the entire reason `Link` has one method: no mocks here, and no test-only branches inside the code
 * being tested.
 *
 * DELIVERY MODEL
 * Time is measured in ticks, not milliseconds, because the sessions are pumped once per tick and a
 * fractional-tick delivery has nowhere to land. Latency in milliseconds is converted once. A message is
 * stamped with the tick it becomes visible and sits in a queue until `pump` reaches it. Reordering
 * therefore falls out for free: two messages given different jitter land in a different order than they
 * were sent, exactly as they would on a real path.
 */

import { Rng } from "../core/rng";
import type { RunModifier } from "../sim/modifiers";
import { Run } from "../run/run";
import { MS_PER_TICK } from "./clock";
import type { Link } from "./session";
import { GuestSession, HostSession } from "./session";

/** How a link behaves. Defaults are the numbers the co-op gate is measured against. */
export interface NetConditions {
  /** One-way delay in milliseconds. 75 each way is the 150ms round trip in the perf contract. */
  latencyMs: number;
  /** Extra delay added per message, uniform in [0, jitterMs]. Reordering comes from this. */
  jitterMs: number;
  /** Fraction of messages dropped outright, 0..1. 0.02 is the 2% in the perf contract. */
  loss: number;
  /** Fraction of messages delivered twice. Real networks do this; the protocol must not care. */
  duplicate: number;
}

export const DEFAULT_CONDITIONS: NetConditions = {
  latencyMs: 75,
  jitterMs: 15,
  loss: 0.02,
  duplicate: 0.005,
};

/** A perfect wire. Used to prove a failure came from the network and not from the code. */
export const PERFECT_CONDITIONS: NetConditions = {
  latencyMs: 0,
  jitterMs: 0,
  loss: 0,
  duplicate: 0,
};

/** A path that is barely a path. Well past the gate, used to prove nothing corrupts under abuse. */
export const AWFUL_CONDITIONS: NetConditions = {
  latencyMs: 200,
  jitterMs: 80,
  loss: 0.1,
  duplicate: 0.02,
};

interface Packet {
  deliverAt: number;
  /** Destination slot. 0 means the host. */
  to: number;
  /** Sender slot. Meaningful for host-bound packets, which is how the host knows who spoke. */
  from: number;
  bytes: Uint8Array;
  seq: number;
}

/** What the simulator saw. Read by tests to prove the conditions were actually applied. */
export interface NetTally {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  reordered: number;
  bytes: number;
}

/**
 * A queue of in-flight messages between a host and up to three guests.
 *
 * One instance owns the whole party rather than one per connection, because a guest's packet loss is
 * independent of every other guest's and the tests need to single one out — sever slot 2 only, and
 * prove slots 1 and 3 carry on regardless.
 */
export class SimNetwork {
  readonly tally: NetTally = {
    sent: 0,
    delivered: 0,
    dropped: 0,
    duplicated: 0,
    reordered: 0,
    bytes: 0,
  };

  private readonly rng: Rng;
  private queue: Packet[] = [];
  private tick = 0;
  private seq = 0;
  private readonly highestSeqTo = new Int32Array(8);
  /** Slots whose traffic is thrown away entirely, simulating a dead connection. */
  private readonly severed = new Set<number>();

  private hostInbox: ((slot: number, bytes: Uint8Array) => void) | null = null;
  private readonly guestInbox: (((bytes: Uint8Array) => void) | undefined)[] = [];

  constructor(
    readonly conditions: NetConditions = DEFAULT_CONDITIONS,
    seed = 0x5eed,
  ) {
    this.rng = new Rng(seed >>> 0);
  }

  /** Where messages addressed to the host get delivered. */
  onHost(fn: (slot: number, bytes: Uint8Array) => void): void {
    this.hostInbox = fn;
  }

  /** Where messages addressed to one guest get delivered. */
  onGuest(slot: number, fn: (bytes: Uint8Array) => void): void {
    this.guestInbox[slot] = fn;
  }

  /** A link the host writes into to reach one guest. */
  linkToGuest(slot: number): Link {
    return { send: (bytes: Uint8Array) => this.enqueue(slot, slot, bytes) };
  }

  /** A link one guest writes into to reach the host. */
  linkToHost(slot: number): Link {
    return { send: (bytes: Uint8Array) => this.enqueue(0, slot, bytes) };
  }

  /** Stop carrying anything to or from a slot, as if the phone went into a lift. */
  sever(slot: number): void {
    this.severed.add(slot);
  }

  /** Restore a severed slot. Anything sent while it was severed is gone for good. */
  restore(slot: number): void {
    this.severed.delete(slot);
  }

  /** True if this slot's traffic is currently being thrown away. */
  isSevered(slot: number): boolean {
    return this.severed.has(slot);
  }

  private roll(): number {
    return this.rng.nextFx() / 65536;
  }

  private enqueue(to: number, party: number, bytes: Uint8Array): void {
    this.tally.sent++;
    if (this.severed.has(party)) {
      this.tally.dropped++;
      return;
    }
    if (this.conditions.loss > 0 && this.roll() < this.conditions.loss) {
      this.tally.dropped++;
      return;
    }

    const copies = this.conditions.duplicate > 0 && this.roll() < this.conditions.duplicate ? 2 : 1;
    if (copies === 2) this.tally.duplicated++;

    for (let c = 0; c < copies; c++) {
      const jitterMs =
        this.conditions.jitterMs > 0 ? this.rng.nextInt(this.conditions.jitterMs + 1) : 0;
      const delay = Math.max(1, Math.round((this.conditions.latencyMs + jitterMs) / MS_PER_TICK));
      // Copied because the sender reuses its write buffer and this packet is about to sit in a queue.
      const held = new Uint8Array(bytes.byteLength);
      held.set(bytes);
      this.queue.push({
        deliverAt: this.tick + delay,
        to,
        from: to === 0 ? party : 0,
        bytes: held,
        seq: this.seq++,
      });
      this.tally.bytes += held.byteLength;
    }
  }

  /**
   * Advance one tick and deliver everything due.
   *
   * Within a tick, delivery follows send order; across ticks, jitter has already decided the order, so
   * two messages that crossed on the wire really do arrive swapped. Sorting on every pump is fine — the
   * queue holds a few dozen packets at four players, not thousands.
   */
  pump(): void {
    this.tick++;
    if (this.queue.length === 0) return;

    const due: Packet[] = [];
    const rest: Packet[] = [];
    for (const p of this.queue) {
      if (p.deliverAt <= this.tick) due.push(p);
      else rest.push(p);
    }
    this.queue = rest;
    if (due.length === 0) return;

    due.sort((a, b) => a.deliverAt - b.deliverAt || a.seq - b.seq);

    for (const p of due) {
      const key = p.to === 0 ? p.from : p.to;
      if (p.seq < (this.highestSeqTo[key] as number)) this.tally.reordered++;
      else this.highestSeqTo[key] = p.seq;

      this.tally.delivered++;
      if (p.to === 0) this.hostInbox?.(p.from, p.bytes);
      else this.guestInbox[p.to]?.(p.bytes);
    }
  }

  /** Deliver everything still in flight. Used to settle a party before asserting on it. */
  flush(maxTicks = 480): void {
    let guard = 0;
    while (this.queue.length > 0 && guard++ < maxTicks) this.pump();
  }

  get inFlight(): number {
    return this.queue.length;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Party harness                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** One host plus its guests, wired through a simulated network and already joined. */
export interface Party {
  net: SimNetwork;
  host: HostSession;
  guests: GuestSession[];
  playerCount: number;
}

export interface PartyOptions {
  playerCount: number;
  /** Run seed. Every member of the party uses it, exactly as WELCOME would deliver it. */
  seed?: number;
  /** Seed for the network's own randomness, kept separate so loss patterns vary independently. */
  netSeed?: number;
  conditions?: NetConditions;
  modifiers?: readonly RunModifier[];
  /** Recording is off by default: these tests are about agreement, not about replay files. */
  record?: boolean;
}

/**
 * Build a party whose members are already connected and holding identical worlds.
 *
 * Guests begin from the same seed and modifier stack as the host rather than being told over the wire.
 * That is not a shortcut — it is what actually happens in the app. WELCOME carries the seed and the
 * modifier ids, and the guest builds its own identical world from them. Here the same information
 * arrives by a shorter road.
 */
export function makeParty(opts: PartyOptions): Party {
  const {
    playerCount,
    seed = 4242,
    netSeed = 0x5eed,
    conditions = DEFAULT_CONDITIONS,
    modifiers = [],
    record = false,
  } = opts;

  const net = new SimNetwork(conditions, netSeed);

  const begin = (run: Run): void => {
    run.begin({ seed, playerCount, modifiers: modifiers as RunModifier[], record });
  };

  const hostRun = new Run();
  begin(hostRun);
  const host = new HostSession(hostRun, playerCount);
  net.onHost((slot, bytes) => host.receive(slot, bytes));

  const guests: GuestSession[] = [];
  for (let slot = 1; slot < playerCount; slot++) {
    const run = new Run();
    begin(run);
    const guest = new GuestSession(run, net.linkToHost(slot));
    guests.push(guest);
    net.onGuest(slot, (bytes) => guest.receive(bytes));
    host.admit(slot, net.linkToGuest(slot), `p${slot}`);
    guest.hello(`p${slot}`);
  }

  return { net, host, guests, playerCount };
}

/**
 * Run a party forward by `ticks`, holding every stick still unless a driver says otherwise.
 *
 * Order inside one tick matters and is deliberate: input first, then the host seals and simulates the
 * tick, then the wire moves, then guests apply whatever reached them. That is the real order of events
 * on a phone, and running it any other way would hide a class of one-tick bugs.
 */
export function runParty(
  party: Party,
  ticks: number,
  drive?: (tick: number, party: Party) => void,
): void {
  for (let i = 0; i < ticks; i++) {
    drive?.(i, party);
    party.host.step();
    party.net.pump();
    for (const g of party.guests) g.pump();
  }
}

/**
 * The one assertion that matters: nobody's world disagrees with the host's.
 *
 * Compares hash trails rather than final states, and only at ticks both sides have actually applied —
 * a guest legitimately runs a fraction of a round trip behind, and calling that a desync would be
 * testing the wrong thing. Returns the first tick that disagrees, or -1 when everyone agrees.
 */
export function firstDivergentTick(party: Party): { tick: number; slot: number } {
  const { host, guests } = party;
  for (let i = 0; i < guests.length; i++) {
    const g = guests[i] as GuestSession;
    for (let t = Math.max(0, g.tick - 600); t <= g.tick; t++) {
      if (!g.trail.has(t) || !host.trail.has(t)) continue;
      if (g.trail.at(t) !== host.trail.at(t)) return { tick: t, slot: i + 1 };
    }
  }
  return { tick: -1, slot: -1 };
}
