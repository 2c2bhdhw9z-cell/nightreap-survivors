/**
 * The co-op session: the layer that turns four separate simulations into one game.
 *
 * WHY THIS SHAPE
 * The simulation is deterministic. Given a seed, a run config and the exact per-tick input of every
 * player, every machine that runs it produces bit-identical worlds — that is what the replay
 * validator already proves on a single machine. So the session's whole job is to make sure all four
 * machines agree on *one* thing: the input record for each tick.
 *
 * That is why there is no steady-state traffic describing spawns, damage or deaths. Telling a guest
 * where 800 enemies are, sixty times a second, is the expensive design; telling it which four sticks
 * were held is seventeen bytes. The host confirms a tick's input record and broadcasts it; guests
 * apply confirmed records in order and their worlds follow for free.
 *
 * THE THREE THINGS THAT CAN GO WRONG, AND WHAT ANSWERS THEM
 *   1. A guest's input arrives too late.  The host confirms the tick anyway, repeating that player's
 *      previous frame and flagging it PREDICTED. Wrong for one frame of movement, and — crucially —
 *      wrong *identically everywhere*, because the guess is part of the confirmed record. A guess
 *      that everyone shares is not a desync.
 *   2. A confirm packet is lost.  Every confirm carries the last CONFIRM_REDUNDANCY_TICKS records,
 *      so the next packet repairs the hole. No acknowledgements, no round trips.
 *   3. A guest falls out of the retransmission window, or disagrees on a state hash.  It stops
 *      guessing and asks for the truth: the host sends a full run snapshot, chunked, and the guest
 *      restores it and resumes from the next confirmed record. This is the same snapshot code that
 *      powers mid-run resume, which is why it was built first.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *   - Render-side prediction for the local player. A guest here is a fraction of a round trip behind
 *     the host, which is correct but feels heavy; the fix is a presentation-layer offset that never
 *     touches the simulation, and it belongs with the HUD work, not here.
 *   - Sockets. A `Link` is anything with `send(bytes)`. That is what lets the whole thing be tested
 *     headlessly against a network simulator with real latency and loss instead of against a mock.
 */

import type { Run } from "../run/run";
import { restoreRun, SNAPSHOT_ERROR, snapshotRun, type SnapshotError } from "../save/snapshot";
import { Reader, Writer } from "./codec";
import { InputHistory, INPUT_FLAG } from "./input";
import {
  beginResyncChunk,
  CARD_ACTION,
  MAX_WIRE_MODIFIERS,
  createWelcome,
  decodeInputBatchHeader,
  decodeInputFrame,
  decodeTickConfirmHeader,
  decodeTickRecord,
  decodeWelcome,
  encodeCardRequest,
  encodeHello,
  encodeInputBatch,
  encodePing,
  encodePong,
  encodeResyncNack,
  encodeResyncRequest,
  encodeStateHash,
  encodeTickConfirm,
  encodeWelcome,
  readResyncChunkHeader,
  readResyncNackHeader,
  tickConfirmBytes,
  tickRecordBytes,
  type InputBatchHeader,
  type ResyncChunkHeader,
  type ResyncNackHeader,
  type TickConfirmHeader,
  type Welcome,
} from "./messages";
import {
  CONFIRM_INTERVAL_TICKS,
  CONFIRM_WINDOW_TICKS,
  INPUT_BATCH_TICKS,
  INPUT_DELAY_TICKS,
  INPUT_HISTORY_TICKS,
  HOST_SLOT,
  MAX_MESSAGE_BYTES,
  MAX_NACK_CHUNKS,
  MAX_PLAYERS,
  MSG,
  RELAY_BROADCAST,
  RESYNC_AFTER_STALL_TICKS,
  RESYNC_KEEP_TICKS,
  RESYNC_NACK_WAIT_TICKS,
  STATE_HASH_INTERVAL_TICKS,
} from "./protocol";
import { setDestination } from "./routing";
import { HASH_SEED, HashTrail } from "./state-hash";
import { MS_PER_TICK, NetClock } from "./clock";

/* ---------------------------------------------------------------------------------------------- */
/* Transport                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Anything that can carry bytes to one peer.
 *
 * Deliberately one method. A WebSocket satisfies it, a latency-and-loss simulator satisfies it, and a
 * direct function call satisfies it — so the same session code is what runs in tests and in the app.
 */
export interface Link {
  send(bytes: Uint8Array): void;
}

/* ---------------------------------------------------------------------------------------------- */
/* The confirmed record ring                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Bytes reserved per tick record. Sized for four players so the ring never has to resize. */
export const RECORD_STRIDE = MAX_PLAYERS * 4 + 1;

/**
 * A ring of confirmed input records, one per tick.
 *
 * Flat bytes rather than objects, and the same layout as the wire, so encoding a confirm is a byte
 * copy and decoding one is a byte copy back. `tickOf` sits alongside so a slot that has been lapped
 * is recognised as stale instead of read as plausible-looking garbage.
 */
export class ConfirmRing {
  readonly capacity: number;
  readonly stride = RECORD_STRIDE;
  readonly data: Uint8Array;
  private readonly tickOf: Int32Array;
  /** Highest tick ever written. -1 when empty. */
  highest = -1;

  constructor(capacity = INPUT_HISTORY_TICKS) {
    this.capacity = capacity;
    this.data = new Uint8Array(capacity * this.stride);
    this.tickOf = new Int32Array(capacity).fill(-1);
  }

  slotOf(tick: number): number {
    const m = tick % this.capacity;
    return m < 0 ? m + this.capacity : m;
  }

  offsetOf(tick: number): number {
    return this.slotOf(tick) * this.stride;
  }

  has(tick: number): boolean {
    return tick >= 0 && this.tickOf[this.slotOf(tick)] === tick;
  }

  /** Mark a slot as holding `tick`. The bytes themselves are written directly into `data`. */
  claim(tick: number): number {
    const slot = this.slotOf(tick);
    this.tickOf[slot] = tick;
    if (tick > this.highest) this.highest = tick;
    return slot * this.stride;
  }

  cardActionOf(tick: number, playerCount: number): number {
    if (!this.has(tick)) return CARD_ACTION.NONE;
    return this.data[this.offsetOf(tick) + playerCount * 4] as number;
  }

  clear(): void {
    this.tickOf.fill(-1);
    this.highest = -1;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Applying a record — the one function both sides must agree on exactly                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Answer a card screen. Returns true when the action was accepted.
 *
 * Kept next to the record application rather than inside `Run` because it is a session concern: the
 * simulation only knows "pick index 2", it has no opinion about who asked.
 */
export function applyCardAction(run: Run, action: number): boolean {
  if (action === CARD_ACTION.NONE) return false;
  if (action >= CARD_ACTION.PICK_0 && action <= CARD_ACTION.PICK_3) {
    return run.pickCard(action - CARD_ACTION.PICK_0);
  }
  if (action === CARD_ACTION.REROLL) return run.rerollCards();
  if (action === CARD_ACTION.SKIP) return run.skipCard();
  if (action >= CARD_ACTION.BANISH_0 && action <= CARD_ACTION.BANISH_3) {
    return run.banishCard(action - CARD_ACTION.BANISH_0);
  }
  return false;
}

/**
 * Consume one confirmed record and advance the world by one session tick.
 *
 * Input bytes are written straight into `run.axes` rather than through `setStick`, because the wire
 * value *is* the quantised value — re-quantising an already-quantised byte is how a host and a guest
 * end up one least-significant bit apart, which by minute four is two different games.
 *
 * A session tick is not always a simulation tick: while a level-up screen is open the world is frozen
 * and `run.tick()` does nothing. Both sides still count the tick, so both sides stay on the same
 * numbering and resume on the same frame.
 */
export function applyRecord(
  run: Run,
  ring: ConfirmRing,
  tick: number,
  playerCount: number,
): boolean {
  if (!ring.has(tick)) return false;
  const base = ring.offsetOf(tick);
  const data = ring.data;
  for (let p = 0; p < playerCount; p++) {
    const o = base + p * 4;
    // The bytes were written as unsigned; sign-extend the two axes back to -128..127.
    const x = data[o] as number;
    const y = data[o + 1] as number;
    run.axes[p * 2] = x > 127 ? x - 256 : x;
    run.axes[p * 2 + 1] = y > 127 ? y - 256 : y;
    run.buttons[p] = data[o + 2] as number;
  }
  const action = data[base + playerCount * 4] as number;
  if (action !== CARD_ACTION.NONE) applyCardAction(run, action);
  run.tick();
  return true;
}

/* ---------------------------------------------------------------------------------------------- */
/* Host                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** Counters the netcode dev panel reads. Nothing here affects the simulation. */
export interface SessionStats {
  bytesSent: number;
  bytesReceived: number;
  messagesSent: number;
  messagesReceived: number;
  /** Ticks where a player's real input never arrived and the previous frame was repeated. */
  predictedFrames: number;
  confirmsSent: number;
  hashesSent: number;
  resyncsServed: number;
  resyncsRequested: number;
  hashMismatches: number;
  /** Ticks a guest spent waiting for a record it did not have. */
  stalledTicks: number;
  snapshotBytes: number;
}

function createStats(): SessionStats {
  return {
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    predictedFrames: 0,
    confirmsSent: 0,
    hashesSent: 0,
    resyncsServed: 0,
    resyncsRequested: 0,
    hashMismatches: 0,
    stalledTicks: 0,
    snapshotBytes: 0,
  };
}

/** How many resync chunks the host will push per tick, so a resync never floods the socket. */
export const RESYNC_CHUNKS_PER_TICK = 24;

/** Payload bytes per resync chunk, leaving room for the header inside one datagram. */
export const RESYNC_CHUNK_PAYLOAD = 1024;

interface GuestConn {
  link: Link | null;
  name: string;
  inputs: InputHistory;
  /** Highest tick we have real input for. Used only for diagnostics. */
  newestInput: number;
  /** Snapshot being pushed to this guest, kept afterwards so missing chunks can be resent. */
  resync: Uint8Array | null;
  resyncTick: number;
  resyncCursor: number;
  /** Total chunks in the snapshot above. */
  resyncChunks: number;
  /** Chunk indices the guest said it never received, waiting to be resent. */
  nack: Int32Array;
  nackCount: number;
  pendingCard: number;
  connected: boolean;
}

export class HostSession {
  readonly stats = createStats();
  readonly ring = new ConfirmRing();
  readonly trail = new HashTrail(INPUT_HISTORY_TICKS);
  /** Last confirmed and applied session tick. -1 before the first. */
  tick = -1;

  private readonly guests: GuestConn[] = [];
  private readonly writer = new Writer(MAX_MESSAGE_BYTES);
  private readonly reader = new Reader(new Uint8Array(4));
  private readonly batchHeader: InputBatchHeader = { slot: 0, firstTick: 0, count: 0 };
  private readonly nackHeader: ResyncNackHeader = { tick: 0, count: 0 };
  private readonly frame = new Int32Array(4);
  private readonly localAxes = new Int8Array(2);
  private localButtons = 0;
  private pendingCard: number = CARD_ACTION.NONE;
  private lastConfirmSent = -1;
  private readonly wireScratch = new Int32Array(MAX_WIRE_MODIFIERS);

  /**
   * @param relayed True when every guest is reached through one relay socket rather than a direct link
   *   each. It changes exactly one thing: a broadcast is written once and addressed to everyone, instead
   *   of once per guest. Over a relay the per-guest version would send the same confirm three times and
   *   have the relay fan each copy out to all three guests — nine deliveries where three were meant.
   */
  constructor(
    readonly run: Run,
    readonly playerCount: number,
    readonly relayed = false,
  ) {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      this.guests.push({
        link: null,
        name: "",
        inputs: new InputHistory(INPUT_HISTORY_TICKS),
        newestInput: -1,
        resync: null,
        resyncTick: -1,
        resyncCursor: 0,
        resyncChunks: 0,
        nack: new Int32Array(MAX_NACK_CHUNKS),
        nackCount: 0,
        pendingCard: CARD_ACTION.NONE,
        connected: false,
      });
    }
  }

  /** Attach a guest's return path and send it the run it is joining. */
  admit(slot: number, link: Link, name = ""): void {
    if (slot <= 0 || slot >= this.playerCount) return;
    const g = this.guests[slot] as GuestConn;
    g.link = link;
    g.name = name;
    g.connected = true;
    g.inputs.clear();
    this.sendTo(slot, this.encodeWelcomeFor(slot));
  }

  private encodeWelcomeFor(slot: number): Uint8Array {
    const count = this.run.writeModifierWireIds(this.wireScratch);
    return encodeWelcome(
      this.writer,
      slot,
      this.playerCount,
      this.run.seed,
      this.run.tainted,
      this.run.stageId,
      this.wireScratch,
      count,
      this.tick,
    );
  }

  /** The host is a player. Its own stick is available immediately, with no wire hop. */
  setLocalInput(x: number, y: number, buttons: number): void {
    // Quantise once, here, exactly as a guest does before sending.
    const mag = Math.sqrt(x * x + y * y);
    const nx = mag > 1 ? x / mag : x;
    const ny = mag > 1 ? y / mag : y;
    const qx = Math.max(-127, Math.min(127, Math.round(nx * 127)));
    const qy = Math.max(-127, Math.min(127, Math.round(ny * 127)));
    this.localAxes[0] = qx;
    this.localAxes[1] = qy;
    this.localButtons = buttons & 0xff;
  }

  /** Queue a card-screen answer from the host's own UI. */
  requestCardAction(action: number): void {
    this.pendingCard = action;
  }

  /**
   * Confirm and simulate exactly one tick.
   *
   * The host does not wait for anyone. A tick's record is sealed the moment the host reaches it, and
   * a player whose input has not landed by then gets its previous frame repeated. Waiting would mean
   * the whole party runs at the latency of its worst connection.
   */
  step(): boolean {
    if (this.run.over) return false;
    const t = this.tick + 1;
    const base = this.ring.claim(t);
    const data = this.ring.data;
    const n = this.playerCount;

    for (let p = 0; p < n; p++) {
      const o = base + p * 4;
      if (p === 0) {
        data[o] = this.localAxes[0] as number;
        data[o + 1] = this.localAxes[1] as number;
        data[o + 2] = this.localButtons;
        data[o + 3] = 0;
        continue;
      }
      const g = this.guests[p] as GuestConn;
      if (g.inputs.has(t)) {
        data[o] = g.inputs.stickX(t);
        data[o + 1] = g.inputs.stickY(t);
        data[o + 2] = g.inputs.buttons(t);
        data[o + 3] = g.inputs.flags(t);
      } else if (g.inputs.predictFrom(t)) {
        data[o] = g.inputs.stickX(t);
        data[o + 1] = g.inputs.stickY(t);
        data[o + 2] = g.inputs.buttons(t);
        data[o + 3] = g.inputs.flags(t);
        this.stats.predictedFrames++;
      } else {
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
        data[o + 3] = INPUT_FLAG.PREDICTED;
        this.stats.predictedFrames++;
      }
    }

    // A card screen is answered by whoever asked first this tick: the host's own UI, then guests in
    // slot order. Fixed order rather than arrival order, because arrival order is a network detail and
    // this decision has to be reproducible from the confirm stream alone.
    let action = this.pendingCard;
    this.pendingCard = CARD_ACTION.NONE;
    for (let p = 1; p < n; p++) {
      const g = this.guests[p] as GuestConn;
      if (action === CARD_ACTION.NONE) action = g.pendingCard;
      g.pendingCard = CARD_ACTION.NONE;
    }
    if (!this.run.paused) action = CARD_ACTION.NONE;
    data[base + n * 4] = action;

    applyRecord(this.run, this.ring, t, n);
    this.tick = t;
    this.trail.record(t, this.run.hashState(HASH_SEED));

    if (t - this.lastConfirmSent >= CONFIRM_INTERVAL_TICKS) this.broadcastConfirm();
    if (t % STATE_HASH_INTERVAL_TICKS === 0) this.broadcastHash();
    this.pumpResyncs();
    return true;
  }

  private broadcastConfirm(): void {
    const n = this.playerCount;
    if (n < 2) {
      this.lastConfirmSent = this.tick;
      return;
    }
    let count = CONFIRM_WINDOW_TICKS;
    while (count > 1 && tickConfirmBytes(n, count) > MAX_MESSAGE_BYTES) count--;
    const first = Math.max(0, this.tick - count + 1);
    const actual = this.tick - first + 1;
    const bytes = encodeTickConfirm(
      this.writer,
      0,
      first,
      actual,
      n,
      this.ring.data,
      this.ring.stride,
      this.ring.capacity,
    );
    this.broadcast(bytes);
    this.stats.confirmsSent++;
    this.lastConfirmSent = this.tick;
  }

  private broadcastHash(): void {
    if (this.playerCount < 2) return;
    const hash = this.trail.at(this.tick);
    this.broadcast(encodeStateHash(this.writer, 0, this.tick, hash));
    this.stats.hashesSent++;
  }

  /**
   * Push queued snapshot chunks, a bounded slice per tick.
   *
   * Half a megabyte in one frame on a 4GB phone is a stall, and a stall is exactly what the guest was
   * complaining about. Twenty-four chunks a tick delivers a full snapshot in about a third of a
   * second while leaving the confirm stream untouched.
   */
  private pumpResyncs(): void {
    for (let p = 1; p < this.playerCount; p++) {
      const g = this.guests[p] as GuestConn;
      if (g.resync === null) continue;

      let sent = 0;
      // Repairs go out before new ground: the guest cannot restore anything until its last hole is
      // filled, so a chunk it asked for twice is worth more than the next one in order.
      while (sent < RESYNC_CHUNKS_PER_TICK && g.nackCount > 0) {
        g.nackCount--;
        this.sendChunk(p, g, g.nack[g.nackCount] as number);
        sent++;
      }
      while (sent < RESYNC_CHUNKS_PER_TICK && g.resyncCursor < g.resyncChunks) {
        this.sendChunk(p, g, g.resyncCursor);
        g.resyncCursor++;
        sent++;
      }

      // The snapshot is held after the last chunk goes out, not thrown away: the guest may still be
      // missing a piece of it, and re-snapshotting would move the target it is aiming at. It is
      // released once it is too old to be worth restoring from.
      if (g.resyncCursor >= g.resyncChunks && this.tick - g.resyncTick > RESYNC_KEEP_TICKS) {
        g.resync = null;
        g.resyncCursor = 0;
        g.resyncChunks = 0;
        g.nackCount = 0;
      }
    }
  }

  private sendChunk(slot: number, g: GuestConn, index: number): void {
    const snap = g.resync;
    if (snap === null || index < 0 || index >= g.resyncChunks) return;
    const from = index * RESYNC_CHUNK_PAYLOAD;
    const size = Math.min(RESYNC_CHUNK_PAYLOAD, snap.byteLength - from);
    const w = beginResyncChunk(this.writer, 0, g.resyncTick, index, g.resyncChunks, size);
    for (let b = 0; b < size; b++) w.u8(snap[from + b] as number);
    this.sendTo(slot, w.finish());
  }

  /** Feed one message received from a guest. */
  receive(slot: number, bytes: Uint8Array): void {
    if (slot <= 0 || slot >= this.playerCount) return;
    this.stats.bytesReceived += bytes.byteLength;
    this.stats.messagesReceived++;
    const r = this.reader.reset(bytes);
    const g = this.guests[slot] as GuestConn;

    switch (r.type) {
      case MSG.INPUT_BATCH: {
        const h = decodeInputBatchHeader(r, this.batchHeader);
        for (let i = 0; i < h.count; i++) {
          decodeInputFrame(r, this.frame);
          const tick = h.firstTick + i;
          // Input for a tick already confirmed is dead on arrival: the record is sealed and sent.
          if (tick <= this.tick) continue;
          g.inputs.write(
            tick,
            this.frame[0] as number,
            this.frame[1] as number,
            this.frame[2] as number,
            (this.frame[3] as number) & ~INPUT_FLAG.PREDICTED,
          );
          if (tick > g.newestInput) g.newestInput = tick;
        }
        return;
      }
      case MSG.CARD_REQUEST: {
        g.pendingCard = r.u8();
        return;
      }
      case MSG.PING: {
        const sendTimeMs = r.u32();
        const senderTick = r.u32();
        this.sendTo(slot, encodePong(this.writer, 0, sendTimeMs, senderTick, this.tick));
        return;
      }
      case MSG.RESYNC_REQUEST: {
        this.serveResync(slot);
        return;
      }
      case MSG.RESYNC_NACK: {
        const h = readResyncNackHeader(r, this.nackHeader);
        // Only for the snapshot we are actually holding. A repair request for a snapshot we have
        // already released is answered by taking a fresh one instead.
        if (g.resync === null || h.tick !== g.resyncTick) {
          this.serveResync(slot);
          return;
        }
        g.nackCount = 0;
        for (let i = 0; i < h.count; i++) {
          const index = r.u16();
          if (g.nackCount >= MAX_NACK_CHUNKS) continue;
          if (index < 0 || index >= g.resyncChunks) continue;
          g.nack[g.nackCount++] = index;
        }
        return;
      }
      default:
        return;
    }
  }

  /** Snapshot the world as it stands and start streaming it to one guest. */
  serveResync(slot: number): void {
    const g = this.guests[slot] as GuestConn;
    // A request that arrives while the stream is still going is a duplicate, not a new problem, and
    // starting a second snapshot would leave the guest assembling two half-worlds at once.
    if (g.resync !== null && g.resyncCursor < g.resyncChunks) return;
    const snap = snapshotRun(this.run);
    g.resync = snap;
    g.resyncTick = this.tick;
    g.resyncCursor = 0;
    g.resyncChunks = Math.ceil(snap.byteLength / RESYNC_CHUNK_PAYLOAD);
    g.nackCount = 0;
    this.stats.resyncsServed++;
    this.stats.snapshotBytes = snap.byteLength;
  }

  private broadcast(bytes: Uint8Array): void {
    // Addressed to every guest at once. A direct link ignores the stamp; a relay reads it and fans out.
    if (this.relayed) {
      // One socket for the whole room, so one write. Any connected seat's link is the same socket.
      for (let p = 1; p < this.playerCount; p++) {
        const g = this.guests[p] as GuestConn;
        if (g.link === null || !g.connected) continue;
        this.sendTo(p, bytes, RELAY_BROADCAST);
        return;
      }
      return;
    }
    for (let p = 1; p < this.playerCount; p++) this.sendTo(p, bytes, RELAY_BROADCAST);
  }

  private sendTo(slot: number, bytes: Uint8Array, dest: number = slot): void {
    const g = this.guests[slot] as GuestConn;
    if (g.link === null || !g.connected) return;
    // The writer is reused, so anything handed to a link must be copied — a link may queue it.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    // Stamp where this is going, so a relay that never reads a body still knows who gets it.
    setDestination(copy, dest);
    g.link.send(copy);
    this.stats.bytesSent += copy.byteLength;
    this.stats.messagesSent++;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Guest                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** Ticks of local input a guest resends in each batch, for the same reason the host does. */
export const INPUT_REDUNDANCY_TICKS = 12;

/** Ticks between RTT probes. Half a second is plenty to keep the lead estimate honest. */
export const PING_INTERVAL_TICKS = 30;

/** Most ticks a guest will simulate in one pump while catching up. */
export const MAX_CATCHUP_TICKS = 6;

export class GuestSession {
  readonly stats = createStats();
  readonly ring = new ConfirmRing();
  readonly trail = new HashTrail(INPUT_HISTORY_TICKS);
  readonly clock = new NetClock();
  /** Last session tick this guest has applied. -1 before the first. */
  tick = -1;
  /** Highest confirmed tick received from the host. -1 before the first confirm. */
  horizon = -1;
  slot = 0;
  playerCount = 1;
  /** True once WELCOME has been seen. */
  joined = false;
  /** True while a snapshot is being assembled — the guest holds still rather than guessing. */
  resyncing = false;

  private readonly local = new InputHistory(INPUT_HISTORY_TICKS);
  private readonly writer = new Writer(MAX_MESSAGE_BYTES);
  private readonly reader = new Reader(new Uint8Array(4));
  private readonly welcome: Welcome = createWelcome();
  private readonly confirmHeader: TickConfirmHeader = {
    firstTick: 0,
    count: 0,
    playerCount: 0,
  };
  private readonly chunkHeader: ResyncChunkHeader = {
    tick: 0,
    chunkIndex: 0,
    chunkCount: 0,
    payloadBytes: 0,
  };
  private readonly axesOut = new Int8Array(INPUT_REDUNDANCY_TICKS * 2);
  private readonly bitsOut = new Uint8Array(INPUT_REDUNDANCY_TICKS * 2);
  private snapshotBuffer: Uint8Array | null = null;
  /** One byte per chunk: 1 once that chunk has arrived. Makes a duplicate chunk free and a hole visible. */
  private snapshotHave: Uint8Array | null = null;
  private snapshotChunks = 0;
  private snapshotSeen = 0;
  private snapshotTick = -1;
  private snapshotTotalBytes = 0;
  /** Ticks since the last chunk arrived. Past the wait, the missing pieces get named. */
  private snapshotQuiet = 0;
  private readonly nackOut = new Uint16Array(MAX_NACK_CHUNKS);
  private lastSnapshotError: SnapshotError = SNAPSHOT_ERROR.NONE;
  private sendTick = -1;
  private lastBatchSent = -1;
  private pingCountdown = 0;
  private stalledFor = 0;
  private pendingHashTick = -1;
  private pendingHash = 0;
  private wall = 0;
  private curAxisX = 0;
  private curAxisY = 0;
  private curButtons = 0;

  constructor(
    readonly run: Run,
    readonly link: Link,
  ) {}

  /** Send the join request. The host answers with WELCOME. */
  hello(name = "", buildId = 1): void {
    this.send(encodeHello(this.writer, buildId, name, 0));
  }

  setLocalInput(x: number, y: number, buttons: number): void {
    const mag = Math.sqrt(x * x + y * y);
    const nx = mag > 1 ? x / mag : x;
    const ny = mag > 1 ? y / mag : y;
    this.curAxisX = Math.max(-127, Math.min(127, Math.round(nx * 127)));
    this.curAxisY = Math.max(-127, Math.min(127, Math.round(ny * 127)));
    this.curButtons = buttons & 0xff;
  }

  /** Ask the host to answer the open card screen. Advisory — the host confirms or ignores it. */
  requestCardAction(action: number): void {
    this.send(encodeCardRequest(this.writer, this.slot, action));
  }

  /**
   * How far ahead of the confirmed horizon local input is sent.
   *
   * Two ticks of deliberate delay, plus however long one trip actually takes, plus one for jitter.
   * Send too near and the host predicts constantly; send too far and the player feels the delay they
   * were promised they would not. This number is measured, not assumed.
   */
  private leadTicks(): number {
    const oneWay = Math.ceil(this.clock.rttMs / 2 / MS_PER_TICK);
    return INPUT_DELAY_TICKS + oneWay + 1;
  }

  /**
   * One frame of guest work: send input, then simulate whatever the host has already confirmed.
   *
   * The guest never simulates a tick it has not been given. That is the whole reason it cannot
   * silently diverge: there is no guess to be wrong about.
   */
  pump(): number {
    this.wall++;
    this.sendInput();
    this.maybePing();
    this.chaseResync();

    let advanced = 0;
    while (advanced < MAX_CATCHUP_TICKS && !this.run.over) {
      const next = this.tick + 1;
      if (!this.ring.has(next)) break;
      applyRecord(this.run, this.ring, next, this.playerCount);
      this.tick = next;
      this.trail.record(next, this.run.hashState(HASH_SEED));
      this.checkPendingHash();
      advanced++;
    }

    if (advanced === 0 && this.joined && !this.run.over) {
      this.stats.stalledTicks++;
      this.stalledFor++;
      if (this.stalledFor > RESYNC_AFTER_STALL_TICKS && !this.resyncing && this.horizon > this.tick) {
        this.requestResync(0, 0);
      }
    } else {
      this.stalledFor = 0;
    }
    return advanced;
  }

  /**
   * Keep a resync moving when the wire eats part of it.
   *
   * A snapshot is asked for exactly when the connection is bad, so some of it will not arrive. Waiting
   * silently for a chunk that is already gone is how a guest ends up frozen forever, which is a worse
   * outcome than the desync it was fixing. So: if nothing has arrived for a while, name the pieces that
   * are missing; if nothing arrived at all, ask again from scratch.
   */
  private chaseResync(): void {
    if (!this.resyncing) return;
    this.snapshotQuiet++;
    if (this.snapshotQuiet <= RESYNC_NACK_WAIT_TICKS) return;
    this.snapshotQuiet = 0;

    const have = this.snapshotHave;
    if (have === null || this.snapshotChunks === 0) {
      // Not one chunk landed — the request itself may have been the casualty.
      this.send(encodeResyncRequest(this.writer, this.slot, this.tick, 0, 0));
      return;
    }
    let count = 0;
    for (let i = 0; i < this.snapshotChunks && count < MAX_NACK_CHUNKS; i++) {
      if (have[i] === 0) this.nackOut[count++] = i;
    }
    if (count === 0) return;
    this.send(encodeResyncNack(this.writer, this.slot, this.snapshotTick, this.nackOut, count));
  }

  private sendInput(): void {
    const want = Math.max(this.horizon + this.leadTicks(), this.sendTick + 1);
    // Fill any ticks skipped by a jump in the estimate, so the host has a continuous stream and never
    // has to predict for a gap we could have written ourselves.
    const from = Math.max(this.sendTick + 1, want - INPUT_REDUNDANCY_TICKS + 1);
    for (let t = from; t <= want; t++) {
      this.local.write(t, this.curAxisX, this.curAxisY, this.curButtons, 0);
    }
    this.sendTick = want;

    if (want - this.lastBatchSent < INPUT_BATCH_TICKS) return;
    let count = 0;
    const first = Math.max(0, want - INPUT_REDUNDANCY_TICKS + 1);
    for (let t = first; t <= want; t++) {
      if (!this.local.has(t)) continue;
      this.axesOut[count * 2] = this.local.stickX(t);
      this.axesOut[count * 2 + 1] = this.local.stickY(t);
      this.bitsOut[count * 2] = this.local.buttons(t);
      this.bitsOut[count * 2 + 1] = this.local.flags(t);
      count++;
    }
    if (count === 0) return;
    this.send(
      encodeInputBatch(this.writer, this.slot, want - count + 1, count, this.axesOut, this.bitsOut),
    );
    this.lastBatchSent = want;
  }

  private maybePing(): void {
    if (this.pingCountdown > 0) {
      this.pingCountdown--;
      return;
    }
    this.pingCountdown = PING_INTERVAL_TICKS;
    this.send(encodePing(this.writer, this.slot, this.wall, this.tick));
  }

  private checkPendingHash(): void {
    // A snapshot is already on its way; comparing hashes against a world we are about to throw away
    // would only ask for a second snapshot whose chunks interleave with the first one's.
    if (this.resyncing) return;
    if (this.pendingHashTick < 0 || this.pendingHashTick > this.tick) return;
    const t = this.pendingHashTick;
    this.pendingHashTick = -1;
    if (!this.trail.has(t)) return;
    if (this.trail.at(t) === this.pendingHash) return;
    this.stats.hashMismatches++;
    this.requestResync(this.trail.at(t), this.pendingHash);
  }

  private requestResync(localHash: number, expectedHash: number): void {
    this.resyncing = true;
    this.snapshotBuffer = null;
    this.snapshotHave = null;
    this.snapshotSeen = 0;
    this.snapshotChunks = 0;
    this.snapshotQuiet = 0;
    this.stats.resyncsRequested++;
    this.send(encodeResyncRequest(this.writer, this.slot, this.tick, localHash, expectedHash));
  }

  /** Feed one message received from the host. */
  receive(bytes: Uint8Array): void {
    this.stats.bytesReceived += bytes.byteLength;
    this.stats.messagesReceived++;
    const r = this.reader.reset(bytes);

    switch (r.type) {
      case MSG.WELCOME: {
        const w = decodeWelcome(r, this.welcome);
        this.slot = w.slot;
        this.playerCount = w.playerCount;
        this.joined = true;
        return;
      }
      case MSG.TICK_CONFIRM: {
        const h = decodeTickConfirmHeader(r, this.confirmHeader);
        this.playerCount = h.playerCount;
        this.joined = true;
        const bytesPerRecord = tickRecordBytes(h.playerCount);
        for (let i = 0; i < h.count; i++) {
          const tick = h.firstTick + i;
          if (tick <= this.tick || this.ring.has(tick)) {
            // Already applied or already held: step the reader past it without touching the ring.
            for (let b = 0; b < bytesPerRecord; b++) r.u8();
            if (tick > this.horizon) this.horizon = tick;
            continue;
          }
          const offset = this.ring.claim(tick);
          decodeTickRecord(r, h.playerCount, this.ring.data, offset);
          if (tick > this.horizon) this.horizon = tick;
        }
        return;
      }
      case MSG.STATE_HASH: {
        const tick = r.u32();
        const hash = r.i32();
        // Mid-resync the local world is known to be wrong and is about to be replaced. Reporting that
        // again would start a second snapshot on top of the first.
        if (this.resyncing) return;
        if (tick <= this.tick) {
          if (this.trail.has(tick) && this.trail.at(tick) !== hash) {
            this.stats.hashMismatches++;
            this.requestResync(this.trail.at(tick), hash);
          }
          return;
        }
        this.pendingHashTick = tick;
        this.pendingHash = hash;
        return;
      }
      case MSG.RESYNC_CHUNK: {
        this.takeChunk(r);
        return;
      }
      case MSG.PONG: {
        const sendTimeMs = r.u32();
        r.u32();
        const hostTick = r.u32();
        // `wall` counts pumps, which are ticks, so a tick difference is a round trip in ticks.
        const rttTicks = this.wall - sendTimeMs;
        this.clock.sample(rttTicks * MS_PER_TICK, hostTick, this.tick);
        return;
      }
      default:
        return;
    }
  }

  private takeChunk(r: Reader): void {
    const h = readResyncChunkHeader(r, this.chunkHeader);
    // Nothing is being assembled, so this is the tail of a snapshot we already restored from.
    if (!this.resyncing) return;
    // Chunks are stamped with the tick their snapshot was taken at. A late chunk from an abandoned
    // snapshot must be thrown away, not written into the buffer of the current one: mixing two
    // snapshots produces a byte stream that passes for a snapshot right up to the checksum.
    if (this.snapshotBuffer !== null && h.tick < this.snapshotTick) return;
    if (this.snapshotBuffer === null || this.snapshotTick !== h.tick) {
      this.snapshotBuffer = new Uint8Array(h.chunkCount * RESYNC_CHUNK_PAYLOAD);
      this.snapshotHave = new Uint8Array(h.chunkCount);
      this.snapshotChunks = h.chunkCount;
      this.snapshotSeen = 0;
      this.snapshotTick = h.tick;
      this.snapshotTotalBytes = 0;
    }
    const buf = this.snapshotBuffer;
    const have = this.snapshotHave as Uint8Array;
    this.snapshotQuiet = 0;
    const dest = h.chunkIndex * RESYNC_CHUNK_PAYLOAD;
    const fresh = have[h.chunkIndex] === 0;
    for (let b = 0; b < h.payloadBytes; b++) buf[dest + b] = r.u8();
    // A duplicate writes the same bytes to the same place, so it is harmless — but it must not be
    // counted, or a snapshot with one hole and one duplicate would look complete.
    if (!fresh) return;
    have[h.chunkIndex] = 1;
    this.snapshotSeen++;
    this.snapshotTotalBytes += h.payloadBytes;
    if (this.snapshotSeen < this.snapshotChunks) return;

    const exact = buf.subarray(0, this.snapshotTotalBytes);
    const code = restoreRun(this.run, exact);
    this.lastSnapshotError = code;
    this.snapshotBuffer = null;
    this.snapshotHave = null;
    this.snapshotChunks = 0;
    this.snapshotSeen = 0;
    if (code !== SNAPSHOT_ERROR.NONE) {
      // A snapshot we cannot trust is not applied. The guest stays where it is and asks again; if the
      // host is genuinely on a different build, the retry fails the same way and the session is over.
      this.resyncing = false;
      return;
    }
    this.tick = h.tick;
    this.stats.snapshotBytes = this.snapshotTotalBytes;
    this.trail.clear();
    this.trail.record(this.tick, this.run.hashState(HASH_SEED));
    this.pendingHashTick = -1;
    this.stalledFor = 0;
    this.resyncing = false;
  }

  get lastRestoreError(): SnapshotError {
    return this.lastSnapshotError;
  }

  private send(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    // A guest has exactly one legal destination: the host. The relay enforces this regardless.
    setDestination(copy, HOST_SLOT);
    this.link.send(copy);
    this.stats.bytesSent += copy.byteLength;
    this.stats.messagesSent++;
  }
}
