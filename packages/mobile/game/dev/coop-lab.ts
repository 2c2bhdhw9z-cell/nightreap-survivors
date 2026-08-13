/**
 * The co-op lab: the rules behind the dev menu's COOP tab.
 *
 * WHAT THIS IS FOR
 * Multiplayer only works if it survives a bad connection, and a bad connection cannot be waited for.
 * Every repair path in `net/` — prediction, retransmission, resync, host migration — is a claim, and a
 * claim that is only ever exercised by a good wifi connection is untested. This module is how those
 * paths get exercised on purpose: it delays, drops and jitters our own traffic, and it fires one-shot
 * disasters (desync, a guest vanishing, the host handing over mid-fight) on demand.
 *
 * WHY THE RULES LIVE HERE AND NOT IN THE SCREEN
 * The screen is a picture of these numbers and nothing else. A fault injector written inside a React
 * component would be untestable, would drift from the real link contract, and would be exactly the kind
 * of thing that quietly ships. Everything here is plain data and plain classes, so a test can state a
 * situation in a few lines and assert what comes out.
 *
 * FOUR RULES THIS FILE HOLDS TO
 *
 *   1. NO AMBIENT CLOCK, NO AMBIENT RANDOMNESS. `ImpairedLink` is told the time by `pump(nowMs)` and is
 *      handed its own `Rng`. `Date.now()` and `Math.random` are banned engine-wide, and a fault injector
 *      that could not be replayed exactly would be useless as a bug-reproduction tool anyway.
 *
 *   2. DELAY IS NOT REORDER. Jitter that let packet 5 overtake packet 4 would be a second, different
 *      fault wearing the first one's clothes, and every bug it found would be ambiguous. Release times
 *      are forced monotonic unless `reorder` is explicitly asked for.
 *
 *   3. EVERY BYTE IS COPIED. The `Link` contract is that anything handed to a link is copied, because
 *      senders reuse their scratch buffers. A link that holds a packet for 200ms and then forwards the
 *      caller's buffer would deliver whatever happened to be in that buffer 200ms later.
 *
 *   4. TOUCHING ANY OF THIS TAINTS THE RUN. Impairment and faults change what the simulation sees, so
 *      the run cannot be ranked. The two read-only views — the link readout and the hash comparison —
 *      cost nothing, which is the point: you have to be able to watch a real run without spoiling it.
 *
 * SECURITY NOTE
 * Every panel here is SYSTEM tier: it either affects another player's session or reveals internals we
 * do not hand out. `lint.ts` already fails the build if a `coop.*` panel is anything but SYSTEM, so the
 * whole tab is absent from a public build rather than merely locked.
 */

import { Rng } from "../core/rng";
import { TAINT } from "../replay/format";
import type { Link } from "../net/session";

/* ---------------------------------------------------------------------------------------------- */
/* Impairment                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Ceilings. Generous rather than realistic: the interesting question is not "does 60ms work" but "where
 * does it break", and the answers we care about (drift cap, resync, prediction limits) live out past
 * anything a real network does.
 */
export const LATENCY_MAX_MS = 2000;
export const JITTER_MAX_MS = 500;
export const LOSS_MAX_PCT = 100;

/** How many packets may sit in flight at once before the oldest is thrown away. */
export const HOLD_CAPACITY = 512;

export interface Impairment {
  /** Added one-way delay in milliseconds, on top of whatever the real network costs. */
  latencyMs: number;
  /** Random extra delay, uniform in [0, jitterMs]. */
  jitterMs: number
  /** Chance in whole percent that a packet is simply never delivered. */
  lossPct: number;
  /**
   * Allow jitter to reorder packets. Off by default — see rule 2. Worth turning on deliberately once,
   * because a real mobile network on a handover does reorder, and the protocol should not care.
   */
  reorder: boolean;
}

export function createImpairment(): Impairment {
  return { latencyMs: 0, jitterMs: 0, lossPct: 0, reorder: false };
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  const v = Math.trunc(value);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Clamps in place. Sliders are user input and the ceilings are the only defence. */
export function clampImpairment(into: Impairment): Impairment {
  into.latencyMs = clampInt(into.latencyMs, 0, LATENCY_MAX_MS);
  into.jitterMs = clampInt(into.jitterMs, 0, JITTER_MAX_MS);
  into.lossPct = clampInt(into.lossPct, 0, LOSS_MAX_PCT);
  return into;
}

/**
 * Whether this impairment does anything at all.
 *
 * `reorder` alone counts as active even though it adds no delay: with zero jitter it changes nothing,
 * but the flag is a deliberate fault and a run where somebody flipped it must not be ranked on the
 * strength of "well, it happened to have no effect".
 */
export function impairmentActive(imp: Impairment): boolean {
  return imp.latencyMs > 0 || imp.jitterMs > 0 || imp.lossPct > 0 || imp.reorder;
}

/** Counters for the readout. Plain numbers, reset with the lab. */
export interface ImpairStats {
  sent: number;
  delivered: number;
  dropped: number;
  /** Packets thrown away because the hold queue was full, which is a different problem to loss. */
  overflowed: number;
  /** Packets currently waiting for their release time. */
  inFlight: number;
}

function createImpairStats(): ImpairStats {
  return { sent: 0, delivered: 0, dropped: 0, overflowed: 0, inFlight: 0 };
}

interface Held {
  bytes: Uint8Array;
  releaseAt: number;
  /** Send order, so a monotonic release can be enforced without comparing floats for equality. */
  seq: number;
}

/**
 * A `Link` that misbehaves on purpose.
 *
 * Wraps the real link. `send` decides that packet's fate immediately — dropped, or released at some
 * future moment — and `pump(nowMs)` is what actually hands due packets to the real link. The host or
 * guest session on the other side of this never learns it is being lied to, which is the point: no
 * session code branches on "are we in the lab", so the lab cannot itself be the reason a test passes.
 */
export class ImpairedLink implements Link {
  readonly stats: ImpairStats = createImpairStats();
  readonly impairment: Impairment = createImpairment();

  private readonly held: Held[] = [];
  private nowMs = 0;
  private seq = 0;
  private lastReleaseAt = 0;

  constructor(
    private readonly inner: Link,
    private readonly rng: Rng,
  ) {}

  /**
   * Queue or drop. Note that the loss roll happens here rather than at release time: a dropped packet
   * should never have occupied a queue slot, or heavy loss would push real packets out via overflow and
   * the two failures would be indistinguishable.
   */
  send(bytes: Uint8Array): void {
    this.stats.sent++;
    const imp = this.impairment;

    if (imp.lossPct > 0 && this.rng.nextInt(100) < imp.lossPct) {
      this.stats.dropped++;
      return;
    }

    if (imp.latencyMs === 0 && imp.jitterMs === 0) {
      // No delay asked for: pass straight through, still copying, because the contract says copy.
      this.deliver(bytes.slice());
      return;
    }

    const jitter = imp.jitterMs > 0 ? this.rng.nextInt(imp.jitterMs + 1) : 0;
    let releaseAt = this.nowMs + imp.latencyMs + jitter;
    if (!imp.reorder && releaseAt < this.lastReleaseAt) releaseAt = this.lastReleaseAt;
    this.lastReleaseAt = releaseAt;

    if (this.held.length >= HOLD_CAPACITY) {
      this.held.shift();
      this.stats.overflowed++;
    }
    this.held.push({ bytes: bytes.slice(), releaseAt, seq: this.seq++ });
    this.stats.inFlight = this.held.length;
  }

  /**
   * Advance the clock and deliver everything due, in send order.
   *
   * Called once per frame from the screen that owns the session. Time never runs backwards here: a
   * clock that went back would hold packets forever and look exactly like a protocol hang.
   */
  pump(nowMs: number): void {
    if (nowMs > this.nowMs) this.nowMs = nowMs;
    if (this.held.length === 0) return;

    this.held.sort(compareHeld);
    let cut = 0;
    while (cut < this.held.length && (this.held[cut]?.releaseAt ?? 0) <= this.nowMs) cut++;
    if (cut === 0) return;

    for (let i = 0; i < cut; i++) {
      const item = this.held[i];
      if (item) this.deliver(item.bytes);
    }
    this.held.splice(0, cut);
    this.stats.inFlight = this.held.length;
  }

  /** Throw away everything in flight. Used when the session is torn down, and by "drop a guest". */
  flushAway(): void {
    this.held.length = 0;
    this.stats.inFlight = 0;
  }

  private deliver(bytes: Uint8Array): void {
    this.stats.delivered++;
    this.inner.send(bytes);
  }
}

function compareHeld(a: Held, b: Held): number {
  if (a.releaseAt !== b.releaseAt) return a.releaseAt - b.releaseAt;
  return a.seq - b.seq;
}

/* ---------------------------------------------------------------------------------------------- */
/* Faults                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One-shot disasters. Append-only: these ids reach the audit log, so a retired fault keeps its number.
 */
export const FAULT = {
  NONE: 0,
  /** Corrupt our own state on purpose, so the hash comparison and the resync path both have to work. */
  FORCE_DESYNC: 1,
  /** Cut a guest's link without a goodbye, which is the case that must hold the seat for 45 seconds. */
  DROP_GUEST: 2,
  /** Hand hosting to the lowest live seat, mid-fight, on purpose. */
  MIGRATE_HOST: 3,
  /** Freeze the host for a second, so every guest hits the drift cap at once. */
  STALL_HOST: 4,
  /** Poison the recorded input log so replay revalidation has something real to reject. */
  REPLAY_DIVERGE: 5,
} as const;

export type FaultKind = (typeof FAULT)[keyof typeof FAULT];

export const FAULT_LABEL: Readonly<Record<number, string>> = {
  [FAULT.NONE]: "none",
  [FAULT.FORCE_DESYNC]: "force desync",
  [FAULT.DROP_GUEST]: "drop a guest",
  [FAULT.MIGRATE_HOST]: "migrate host",
  [FAULT.STALL_HOST]: "stall host",
  [FAULT.REPLAY_DIVERGE]: "replay diverge",
};

/**
 * Taint bits per fault. Stated as data so the screen cannot describe a fault as harmless while the
 * recorder disagrees, and so a new fault has to answer the question before it can be listed.
 */
const FAULT_TAINT: Readonly<Record<number, number>> = {
  [FAULT.NONE]: 0,
  [FAULT.FORCE_DESYNC]: TAINT.DEV_TOGGLE | TAINT.RNG_EDIT,
  [FAULT.DROP_GUEST]: TAINT.DEV_TOGGLE,
  [FAULT.MIGRATE_HOST]: TAINT.DEV_TOGGLE,
  [FAULT.STALL_HOST]: TAINT.DEV_TOGGLE | TAINT.TIME_SCALE,
  [FAULT.REPLAY_DIVERGE]: TAINT.DEV_TOGGLE | TAINT.SYNTHETIC_INPUT,
};

export function faultTaint(kind: FaultKind): number {
  return FAULT_TAINT[kind] ?? TAINT.DEV_TOGGLE;
}

/** A fault waiting to be carried out. Caller-owned, so draining the queue allocates nothing. */
export interface FaultRequest {
  kind: FaultKind;
  /** Which seat it lands on. Ignored by faults that have no target. */
  slot: number;
}

export function createFaultRequest(): FaultRequest {
  return { kind: FAULT.NONE, slot: 0 };
}

/** Faults are one-shot and the queue is small: a screen cannot queue a thousand migrations by mashing. */
export const FAULT_QUEUE_MAX = 8;

/**
 * The lab itself: the impairment settings, the pending faults, and the record of what has been touched.
 *
 * The session does not know this exists. Whoever owns the session drains `takeFault` each frame and
 * carries out what it finds — which keeps every dangerous action in the one place that already knows
 * how to do it safely, instead of handing the lab a reference to the session.
 */
export class CoopLab {
  readonly impairment: Impairment = createImpairment();

  private readonly queue: FaultRequest[] = [];
  /** Accumulated taint from everything used since the lab was reset. Only ever grows. */
  private used = 0;
  /** Count per fault kind, for the audit view. */
  private readonly fired = new Int32Array(8);

  /**
   * Apply a slider. Returns the taint this cost, so the caller can hand it to the gate without having
   * to remember that sliders taint at all.
   */
  setImpairment(latencyMs: number, jitterMs: number, lossPct: number, reorder = false): number {
    this.impairment.latencyMs = latencyMs;
    this.impairment.jitterMs = jitterMs;
    this.impairment.lossPct = lossPct;
    this.impairment.reorder = reorder;
    clampImpairment(this.impairment);
    if (!impairmentActive(this.impairment)) return 0;
    this.used |= TAINT.DEV_TOGGLE;
    return TAINT.DEV_TOGGLE;
  }

  /**
   * Ask for a fault. Returns the taint bits it costs — non-zero even if the queue is full, because the
   * intent was expressed and a run where somebody tried to force a desync is not a clean run.
   */
  requestFault(kind: FaultKind, slot = 0): number {
    if (kind === FAULT.NONE) return 0;
    const bits = faultTaint(kind);
    this.used |= bits;
    const index = kind & 7;
    this.fired[index] = (this.fired[index] ?? 0) + 1;
    if (this.queue.length < FAULT_QUEUE_MAX) {
      this.queue.push({ kind, slot: clampInt(slot, 0, 3) });
    }
    return bits;
  }

  /** Drain one fault into a caller-owned record. False when there is nothing to do. */
  takeFault(out: FaultRequest): boolean {
    const next = this.queue.shift();
    if (!next) {
      out.kind = FAULT.NONE;
      out.slot = 0;
      return false;
    }
    out.kind = next.kind;
    out.slot = next.slot;
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }

  firedCount(kind: FaultKind): number {
    return this.fired[kind & 7] ?? 0;
  }

  /** Everything this run has been subjected to. What the gate writes into the replay header. */
  taintUsed(): number {
    return this.used;
  }

  /** True when this run can still be ranked as far as the lab is concerned. */
  get clean(): boolean {
    return this.used === 0;
  }

  /**
   * Back to harmless. Called between runs.
   *
   * `used` is cleared here and nowhere else, and deliberately does not un-taint anything: the recorder
   * already has the bits and taint is one-way. This only means "the next run starts clean".
   */
  reset(): void {
    this.impairment.latencyMs = 0;
    this.impairment.jitterMs = 0;
    this.impairment.lossPct = 0;
    this.impairment.reorder = false;
    this.queue.length = 0;
    this.used = 0;
    this.fired.fill(0);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The link readout — read-only                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export const ROLE = { HOST: 0, GUEST: 1 } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

/** Just enough of `SessionStats` to draw the readout, structurally, so either session type fits. */
export interface StatsLike {
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly predictedFrames: number;
  readonly resyncsServed: number;
  readonly resyncsRequested: number;
  readonly hashMismatches: number;
  readonly stalledTicks: number;
  readonly snapshotBytes: number;
}

/** What the owning screen knows that the session does not. */
export interface LinkSource {
  readonly isHost: boolean;
  readonly tick: number;
  readonly protocolVersion: number;
  readonly stats: StatsLike;
  readonly liveSeats: number;
  readonly heldSeats: number;
  readonly emptySeats: number;
  readonly rttP50: number;
  readonly rttP95: number;
  readonly rttWorst: number;
  /** Milliseconds the session has been running, for the rate figures. */
  readonly elapsedMs: number;
}

/**
 * Everything the readout draws. One object, created once, overwritten every frame — a diagnostic panel
 * that allocated per frame would change the very numbers it exists to measure.
 */
export interface LinkReadout {
  role: Role;
  tick: number;
  protocolVersion: number;
  liveSeats: number;
  heldSeats: number;
  emptySeats: number;
  rttP50: number;
  rttP95: number;
  rttWorst: number;
  upBytesPerSec: number;
  downBytesPerSec: number;
  /** Predicted frames per thousand ticks. Integers, because permille is how the engine states rates. */
  predictedPermille: number;
  resyncs: number;
  mismatches: number;
  stalledTicks: number;
  snapshotBytes: number;
  /** True when the numbers above are being distorted by us, so nobody debugs a fault they caused. */
  impaired: boolean;
}

export function createLinkReadout(): LinkReadout {
  return {
    role: ROLE.HOST,
    tick: -1,
    protocolVersion: 0,
    liveSeats: 0,
    heldSeats: 0,
    emptySeats: 0,
    rttP50: 0,
    rttP95: 0,
    rttWorst: 0,
    upBytesPerSec: 0,
    downBytesPerSec: 0,
    predictedPermille: 0,
    resyncs: 0,
    mismatches: 0,
    stalledTicks: 0,
    snapshotBytes: 0,
    impaired: false,
  };
}

function perSecond(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.round((bytes * 1000) / elapsedMs);
}

/**
 * Fill the readout. Reads, never writes, and takes plain numbers rather than the session object so no
 * line in here can reach into a live session and change it.
 */
export function readLinkInto(src: LinkSource, imp: Impairment, out: LinkReadout): void {
  out.role = src.isHost ? ROLE.HOST : ROLE.GUEST;
  out.tick = src.tick;
  out.protocolVersion = src.protocolVersion;
  out.liveSeats = src.liveSeats;
  out.heldSeats = src.heldSeats;
  out.emptySeats = src.emptySeats;
  out.rttP50 = Math.max(0, Math.round(src.rttP50));
  out.rttP95 = Math.max(0, Math.round(src.rttP95));
  out.rttWorst = Math.max(0, Math.round(src.rttWorst));
  out.upBytesPerSec = perSecond(src.stats.bytesSent, src.elapsedMs);
  out.downBytesPerSec = perSecond(src.stats.bytesReceived, src.elapsedMs);

  // Ticks elapsed, not ticks confirmed: `tick` is -1 before the first one, and a rate over zero ticks
  // is zero rather than an error.
  const ticks = src.tick + 1;
  out.predictedPermille = ticks > 0 ? Math.round((src.stats.predictedFrames * 1000) / ticks) : 0;

  // A host serves resyncs and a guest asks for them; the readout shows the one that applies rather
  // than making the reader work out which of two numbers is meaningful for their role.
  out.resyncs = src.isHost ? src.stats.resyncsServed : src.stats.resyncsRequested;
  out.mismatches = src.stats.hashMismatches;
  out.stalledTicks = src.stats.stalledTicks;
  out.snapshotBytes = src.stats.snapshotBytes;
  out.impaired = impairmentActive(imp);
}

/* ---------------------------------------------------------------------------------------------- */
/* Hash comparison — read-only                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export const AGREEMENT = { UNKNOWN: 0, AGREE: 1, DISAGREE: 2 } as const;
export type Agreement = (typeof AGREEMENT)[keyof typeof AGREEMENT];

const MAX_SEATS = 4;

/**
 * Whose simulation agrees with whose, for one tick.
 *
 * The whole value of this panel is that a desync is a fact rather than a suspicion, so it is strict
 * about which tick it is talking about. Hashes for the tick on show are recorded; a hash for an older
 * tick is ignored outright, because a late arrival from two seconds ago says nothing about now; a hash
 * for a newer tick throws the whole board away and starts again. A panel that mixed ticks would show
 * disagreement between four clients that were all perfectly fine.
 *
 * The local seat is the reference. It agrees with itself by definition, and that is not a shortcut —
 * "everyone else is wrong" is exactly what a desynced client sees, and the panel's job is to show what
 * this device believes, not to guess who is right. Deciding who is right is the host's job.
 */
export class HashCompare {
  /** The tick every reported hash on the board belongs to. -1 before anything is reported. */
  tick = -1;

  private readonly hashes = new Int32Array(MAX_SEATS);
  /** 1 once a seat has reported a hash for the tick on show. Separate from the verdict on purpose. */
  private readonly reported = new Uint8Array(MAX_SEATS);
  private readonly state = new Uint8Array(MAX_SEATS);

  constructor(private localSlot = 0) {}

  setLocalSlot(slot: number): void {
    this.localSlot = clampInt(slot, 0, MAX_SEATS - 1);
    this.recompute();
  }

  /** False when the report was ignored as stale. */
  report(slot: number, tick: number, hash: number): boolean {
    if (tick < this.tick) return false;
    if (tick > this.tick) {
      this.tick = tick;
      this.hashes.fill(0);
      this.reported.fill(0);
      this.state.fill(AGREEMENT.UNKNOWN);
    }
    const s = clampInt(slot, 0, MAX_SEATS - 1);
    this.hashes[s] = hash | 0;
    this.reported[s] = 1;
    this.recompute();
    return true;
  }

  agreementOf(slot: number): Agreement {
    const s = clampInt(slot, 0, MAX_SEATS - 1);
    return (this.state[s] ?? AGREEMENT.UNKNOWN) as Agreement;
  }

  hashOf(slot: number): number {
    const s = clampInt(slot, 0, MAX_SEATS - 1);
    return this.hashes[s] ?? 0;
  }

  hasReported(slot: number): boolean {
    const s = clampInt(slot, 0, MAX_SEATS - 1);
    return this.reported[s] === 1;
  }

  /** One bit per seat that disagrees with us. Zero when the party agrees or nobody has reported. */
  disagreeMask(): number {
    let mask = 0;
    for (let i = 0; i < MAX_SEATS; i++) {
      if (this.state[i] === AGREEMENT.DISAGREE) mask |= 1 << i;
    }
    return mask;
  }

  get inSync(): boolean {
    return this.disagreeMask() === 0;
  }

  reset(): void {
    this.tick = -1;
    this.hashes.fill(0);
    this.reported.fill(0);
    this.state.fill(AGREEMENT.UNKNOWN);
  }

  /**
   * Re-judge every reported seat against the local one.
   *
   * Runs on every report rather than at draw time so the board is never a frame behind, and so the
   * local seat changing cannot leave a stale verdict on screen. A seat that has reported while we
   * ourselves have not stays UNKNOWN and is re-judged the moment our own hash lands - which is why
   * "has this seat reported" is stored separately from "what do we think of it". Folding the two
   * together loses the report and the seat never gets judged at all.
   */
  private recompute(): void {
    const reference = this.hashes[this.localSlot] ?? 0;
    const haveReference = this.reported[this.localSlot] === 1;
    for (let i = 0; i < MAX_SEATS; i++) {
      if (this.reported[i] !== 1) {
        this.state[i] = AGREEMENT.UNKNOWN;
        continue;
      }
      if (i === this.localSlot) {
        this.state[i] = AGREEMENT.AGREE;
        continue;
      }
      if (!haveReference) {
        this.state[i] = AGREEMENT.UNKNOWN;
        continue;
      }
      this.state[i] = (this.hashes[i] ?? 0) === reference ? AGREEMENT.AGREE : AGREEMENT.DISAGREE;
    }
  }
}
