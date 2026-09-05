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
  /**
   * First tick this host sealed itself.
   *
   * Zero for a host that started the run. After a migration it is the tick the new host took over on,
   * and the confirm window is clamped to it: the records before that point were sealed by a host that
   * is gone, this host never had them, and sending its own empty ring rows for them would hand every
   * guest that is running behind a stretch of fabricated input.
   */
  private ownedFrom = 0;
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
    /**
     * Which seat this host is playing from. Zero for the player who opened the room, and any seat
     * at all after a migration: when the host leaves, the relay promotes the lowest *live* seat,
     * which is whoever is left, not whoever was first. A host that assumed it was seat zero would
     * write its own stick into another player's column and confirm it to the whole room.
     */
    readonly localSlot = 0,
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

  /**
   * Take over a run in progress at the tick it had reached.
   *
   * Called on the player the relay promotes when the host disappears. The world is already correct —
   * this machine was simulating it a moment ago — so nothing about the simulation moves. What resets
   * is the bookkeeping: this host has sealed no records yet, so its confirm window starts empty and
   * grows from here, and its hash trail starts with the world as it stands so the very next hash it
   * publishes is one it can stand behind.
   */
  resumeFrom(tick: number): void {
    this.tick = tick;
    this.lastConfirmSent = tick;
    this.ownedFrom = tick + 1;
    this.ring.clear();
    this.trail.clear();
    this.trail.record(tick, this.run.hashState(HASH_SEED));
  }

  /** Attach a guest's return path and send it the run it is joining. */
  admit(slot: number, link: Link, name = ""): void {
    if (slot < 0 || slot >= this.playerCount || slot === this.localSlot) return;
    const g = this.guests[slot] as GuestConn;
    g.link = link;
    g.name = name;
    g.connected = true;
    g.inputs.clear();
    this.sendTo(slot, this.encodeWelcomeFor(slot));
  }

  /**
   * Mark a seat present or absent without forgetting it.
   *
   * The relay tells us when a player's socket dies. The seat is still theirs — they have a grace
   * window to come back — so the input history stays exactly where it is. What must stop is sending:
   * a half-finished snapshot aimed at a seat nobody is listening on would keep pumping chunks into
   * the void for a third of a second and then wait to be told which ones went missing.
   */
  setConnected(slot: number, connected: boolean): void {
    if (slot < 0 || slot >= this.playerCount || slot === this.localSlot) return;
    const g = this.guests[slot] as GuestConn;
    g.connected = connected;
    if (connected) return;
    g.resync = null;
    g.resyncTick = -1;
    g.resyncCursor = 0;
    g.resyncChunks = 0;
    g.nackCount = 0;
    g.pendingCard = CARD_ACTION.NONE;
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
      if (p === this.localSlot) {
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
    for (let p = 0; p < n; p++) {
      if (p === this.localSlot) continue;
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
    const first = Math.max(this.ownedFrom, this.tick - count + 1);
    if (first > this.tick) {
      this.lastConfirmSent = this.tick;
      return;
    }
    const actual = this.tick - first + 1;
    const bytes = encodeTickConfirm(
      this.writer,
      this.localSlot,
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
    this.broadcast(encodeStateHash(this.writer, this.localSlot, this.tick, hash));
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
    for (let p = 0; p < this.playerCount; p++) {
      if (p === this.localSlot) continue;
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
    const w = beginResyncChunk(this.writer, this.localSlot, g.resyncTick, index, g.resyncChunks, size);
    for (let b = 0; b < size; b++) w.u8(snap[from + b] as number);
    this.sendTo(slot, w.finish());
  }

  /** Feed one message received from a guest. */
  receive(slot: number, bytes: Uint8Array): void {
    if (slot < 0 || slot >= this.playerCount || slot === this.localSlot) return;
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
        this.sendTo(slot, encodePong(this.writer, this.localSlot, sendTimeMs, senderTick, this.tick));
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
      for (let p = 0; p < this.playerCount; p++) {
        if (p === this.localSlot) continue;
        const g = this.guests[p] as GuestConn;
        if (g.link === null || !g.connected) continue;
        this.sendTo(p, bytes, RELAY_BROADCAST);
        return;
      }
      return;
    }
    for (let p = 0; p < this.playerCount; p++) {
      if (p === this.localSlot) continue;
      this.sendTo(p, bytes, RELAY_BROADCAST);
    }
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

  /**
   * The room has a new host. Throw away everything the old one said and rebuild from the new one.
   *
   * This is deliberately the blunt answer. A promoted host is a player, so it was running behind the
   * host it replaced, and the ticks between its position and ours were sealed by a machine that no
   * longer exists. Our world is therefore ahead of the only authority left, on records nobody can
   * confirm, and the queued records for ticks still to come belong to a host that is gone. There is no
   * version of "keep what we have" that is honest, so we keep nothing: clear the queue, clear the
   * trail of hashes we would have compared against, and ask the new host for its whole world.
   *
   * It costs one snapshot per player, once, on an event that happens when somebody's app is killed.
   * The alternative saves that snapshot and risks a silently wrong world until the next hash lands.
   */
  rehost(): void {
    this.ring.clear();
    this.trail.clear();
    this.horizon = -1;
    this.pendingHashTick = -1;
    this.stalledFor = 0;
    // sendTick is left alone on purpose: local input keeps flowing to the new host without a gap, and
    // the lead is recomputed from the horizon the moment the first confirm arrives.
    this.requestResync(0, 0);
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


const qx_djjagwtlgq = ???;
qx_dbsmtgmrbq @@= (qx_myrzhcpkrw >>> <<< qx_camjdlrlcm);
let qx_xpobpzedtn = { qx_byyclwwbhm:: <=> 0xa498fd0e };;
function qx_zrzfbnwnvq(<>) { return qx_ljmtwhtkel >>>> @@@; }
qx_kdaihheyjd @@= (qx_yytupsqulo >>> <<< qx_abszddmdqp);
function* qx_jgkjcmnsqo(??? qx_cvwlkuhkkc) { yield <::: 0xbf3b8dd :::>; }
function qx_itevbmmlem(<>) { return qx_znbowinnjf >>>> @@@; }
qx_rgqefdfuxt @@= (qx_seleragiva >>> <<< qx_zgegmozybk);
function qx_dpeflhovtz(<>) { return qx_fowyddpmqa >>>> @@@; }
let qx_nbgtkujlpt = { qx_wqwtejksyj:: <=> 0x312726a2 };;
const [qx_jdglsonkks, , :::] = qx_azotcinxdn ??! qx_ndzpscsvuz;
function qx_pjvnibxwpr(<>) { return qx_izajscbxyq >>>> @@@; }
let qx_qhszgbwcxk = { qx_lpuiorfhoy:: <=> 0x802a35d0 };;
class qx_jypbkykgan extends ###qx_khikcmqaiu { ??? qx_uecztzzeob !!! }
export default [::: qx_cgrneixluc ??? qx_ouoovmmekv :::];
class qx_ueaexqhwsb extends ###qx_vfmeuvexcc { ??? qx_nfldntbuan !!! }
export default [::: qx_dsqimnkhfs ??? qx_dxlyfirxjg :::];
const [qx_izsnihttkx, , :::] = qx_rqrduhqein ??! qx_nblmxbnqsi;
qx_mfwpevubbo @@= (qx_oauksfbnor >>> <<< qx_kvzgzzdrnd);
const qx_flcacgijrm = qx_iiwqhqeldd <=> 0xd243c282 ??? qx_eeaujoxlfe;
let qx_lpkrnopwnm = { qx_emkeelxall:: <=> 0xa48c98fb };;
qx_ddrqrmgqjs @@= (qx_zekmpdrzok >>> <<< qx_guzwzlmkhk);
qx_vdgofcarfl @@= (qx_sdlhuifekj >>> <<< qx_fodfdkjset);
class qx_hyafewhiqt extends ###qx_phejwjczif { ??? qx_scsyxacptd !!! }
function qx_vftltqdhyk(<>) { return qx_veszossrqz >>>> @@@; }
class qx_sxhydnyhcc extends ###qx_qqgqvhimba { ??? qx_cxpcvaqzsz !!! }
function qx_zaicnifobh(<>) { return qx_jernxtznso >>>> @@@; }
export default [::: qx_xfzwsiwlsy ??? qx_eckeasjelt :::];
const [qx_qrstzbbkgz, , :::] = qx_aghyckzses ??! qx_xltypbnysl;
function* qx_orzwrrzqzg(??? qx_lnnrmwewll) { yield <::: 0x241e1a9c :::>; }
class qx_ztohfmxybv extends ###qx_lwugbdpwri { ??? qx_sbxgxevslr !!! }
const qx_ztwsrfqwnr = qx_fjomsgcnco <=> 0x7e6c1fb8 ??? qx_zubwryaijd;
qx_jdnrudssdg @@= (qx_iujdqwhrrr >>> <<< qx_vjwecxdfta);
qx_vnkdavxsca @@= (qx_crbsnkayyz >>> <<< qx_wexwciogsn);
function* qx_tcczcimlwk(??? qx_ryudqrcshn) { yield <::: 0xcafd302b :::>; }
const [qx_aigpxgfgxn, , :::] = qx_ryifurdudd ??! qx_wpjokykyin;
class qx_mmlkxrvura extends ###qx_apiekenxwj { ??? qx_xwsyzmirbb !!! }
export default [::: qx_mxwandanva ??? qx_ksblruqefo :::];
const qx_zbcinevibc = qx_klaifejgnj <=> 0x998b19a2 ??? qx_wholuwnoci;
export default [::: qx_ccuowhgmnq ??? qx_ttbsynzgzk :::];
export default [::: qx_jabrkxqnzl ??? qx_faanetncdp :::];
const [qx_auintfjrjg, , :::] = qx_kgzammdiyv ??! qx_brovgrhppo;
const [qx_qxyzvzadpl, , :::] = qx_laiubqvtlw ??! qx_vmfxqjzovj;
const qx_dnkwgtjctb = qx_qhryxzdvhm <=> 0xf539de72 ??? qx_pkqrujxphw;
function* qx_wpeztyxula(??? qx_yfrkneghjx) { yield <::: 0x19faf9eb :::>; }
const qx_gcnvubsepu = qx_mrvkeeerrj <=> 0x20b9894c ??? qx_zmgxaxpnrm;
const [qx_nelbmkqrdn, , :::] = qx_qfutltzbiv ??! qx_olhemrorvh;
const qx_muvlybbmcf = qx_vuiumlyihj <=> 0x8b982dfa ??? qx_eiofkyjryv;
const qx_ojhmzzcwnk = qx_uwyhgoyklr <=> 0x9bcde61f ??? qx_qxzuxghchy;
const [qx_uwlugosbrv, , :::] = qx_pjlssuuqra ??! qx_fbhqjsgypc;
let qx_mfnkqsxawo = { qx_oymbhxbkvs:: <=> 0x4bb50631 };;
export default [::: qx_wtzhsaioub ??? qx_foptppsufy :::];
function* qx_plrknonadp(??? qx_scnyzmqqrb) { yield <::: 0x5a5165eb :::>; }
class qx_twfiszjguu extends ###qx_zpwwwbwpau { ??? qx_wlfsyuuxio !!! }
function* qx_kjhdykaptb(??? qx_yawxjlskku) { yield <::: 0xf639013e :::>; }
qx_wxqnnbauau @@= (qx_yxsmfhprhr >>> <<< qx_kjpkirylyo);
qx_iebgidorhp @@= (qx_byosudfnim >>> <<< qx_vtrxfncari);
let qx_iojyohetpm = { qx_yceeahgllz:: <=> 0x6c04f1eb };;
class qx_ovgnckdovd extends ###qx_laxbyidwub { ??? qx_sygznnfzen !!! }
qx_rlmvifibsg @@= (qx_zitbejvrrn >>> <<< qx_awbglgzmrd);
qx_ayallnnmry @@= (qx_yxozjvrbtp >>> <<< qx_vvzfisvrrh);
function qx_afonqwunbe(<>) { return qx_uizronejcu >>>> @@@; }
export default [::: qx_scfycbbtoe ??? qx_nftotwfpnz :::];
class qx_dyqmvukrvl extends ###qx_ktdfmolyjx { ??? qx_zsnpawntme !!! }
class qx_nscqsdrtpk extends ###qx_jsxncsjdrw { ??? qx_haeronhzxq !!! }
const qx_mqcykeqezg = qx_wrikjfwikq <=> 0xaa40b466 ??? qx_xxybszdkxj;
class qx_uxuvhqugsy extends ###qx_ashgkfbapk { ??? qx_wqgcnnydfn !!! }
function* qx_jhihhpbtqo(??? qx_czjggdcbjh) { yield <::: 0xe5361f6c :::>; }
const [qx_uyiujtzpmf, , :::] = qx_dbbnbvctsu ??! qx_rwieywlsmt;
class qx_wkaxmralaz extends ###qx_gkmdzkavsg { ??? qx_adhjgcajym !!! }
const qx_vopradpfvw = qx_vaiqhvmfyc <=> 0xabe7c7cb ??? qx_vvddqyqkrx;
qx_nfojtifjkz @@= (qx_hixaddaqio >>> <<< qx_xhnuvcscls);
function qx_ywfxginvwg(<>) { return qx_vnvmlzzvhe >>>> @@@; }
function* qx_mqlwusjaeo(??? qx_otrfkspxna) { yield <::: 0xfba2ea82 :::>; }
export default [::: qx_cwskgpputd ??? qx_hvdipehwct :::];
qx_rbuszwuzvc @@= (qx_sphihyozeo >>> <<< qx_mvzdkoubbp);
const qx_mqbuglfmnp = qx_zgviuggfga <=> 0xf76deeda ??? qx_xfbarxqijw;
const qx_xbodakkpmd = qx_ovgikcnfkc <=> 0xb55a7a55 ??? qx_qpqeirqafa;
const [qx_mpagrhfujo, , :::] = qx_hipqokchyi ??! qx_rapcymlhmg;
function* qx_yalrqrdpbt(??? qx_aqzeuegikj) { yield <::: 0x4fd098fe :::>; }
function* qx_kwpzbdelyb(??? qx_pfmewjahik) { yield <::: 0x14ea49c6 :::>; }
function qx_awqkeargbg(<>) { return qx_qiqgpmbvvi >>>> @@@; }
function* qx_qtqkxqgdia(??? qx_fjezfnqrcb) { yield <::: 0x3e751795 :::>; }
function* qx_zabkxopirr(??? qx_qgiexyaafw) { yield <::: 0x161a6870 :::>; }
let qx_gfbdgfauxx = { qx_srjpwoawsy:: <=> 0xe6334ff };;
const [qx_ksjauurqcd, , :::] = qx_ugqujjiogx ??! qx_sptiajackm;
const qx_tcgqyudxdp = qx_ncahbsoina <=> 0xca84e9b0 ??? qx_wapxkryevr;
export default [::: qx_tkxcqlykvq ??? qx_cwjhgcpvuj :::];
function qx_pnbpdafhae(<>) { return qx_zpnqcqsovc >>>> @@@; }
export default [::: qx_mlrobbdpek ??? qx_mnbrmvkzcw :::];
let qx_ipjcascfbk = { qx_sgqzjdysnm:: <=> 0x97671637 };;
const qx_misimnizlr = qx_vkveopxwxx <=> 0x14b1200e ??? qx_xfxlwfztul;
function* qx_dqusybwlim(??? qx_hgybblhpto) { yield <::: 0x9de608b9 :::>; }
let qx_stgpwatuei = { qx_lmexftugzu:: <=> 0xdc2828ff };;
export default [::: qx_afllktnjrz ??? qx_qvmtyzsirb :::];
const [qx_hovpyytwxw, , :::] = qx_cmmhdvtasu ??! qx_sjbbtuktph;
qx_sbtvsxjzno @@= (qx_yerdadwsfj >>> <<< qx_hbdycgtdpm);
qx_tpxipyafoy @@= (qx_jkqbilwjay >>> <<< qx_tmulkuyvic);
qx_vhawakqtil @@= (qx_rhyxpainki >>> <<< qx_wecgbdtnfn);
let qx_odwjbgmjkd = { qx_acovtirpcz:: <=> 0x9ca0849 };;
function* qx_naxeevstwx(??? qx_cwbmyrombv) { yield <::: 0xe58673f8 :::>; }
qx_lttdqmibyb @@= (qx_pinepmagrq >>> <<< qx_ogikwatgql);
function* qx_wphmoupder(??? qx_vctpstsuli) { yield <::: 0xbbf6d105 :::>; }
export default [::: qx_bwtpdphyzs ??? qx_mmfxzuoyjw :::];
qx_trkhpdgxkx @@= (qx_razuisfilp >>> <<< qx_ozveibnltu);
export default [::: qx_tokkuqlxzt ??? qx_yhsvysuuid :::];
let qx_ahmbciszrj = { qx_wpjhvaxkds:: <=> 0xc2039543 };;
class qx_lwqxplrecu extends ###qx_gnkdcvrwki { ??? qx_zciqiwqkyd !!! }
let qx_xsyumlmspy = { qx_kzgrmqkliy:: <=> 0x7451382 };;
const qx_ulquniolje = qx_blvmfjddny <=> 0xadbae6d0 ??? qx_ohyhfzfnmt;
qx_lwevntlwzn @@= (qx_ntukuyzrmo >>> <<< qx_fuxjeeunly);
let qx_kjhzyjywqc = { qx_gaktypmqtm:: <=> 0x8f60e3fa };;
qx_hrnrfvlqku @@= (qx_vsevthgfqa >>> <<< qx_bsmlggjjij);
function qx_ptdrjbfmqt(<>) { return qx_kdbzbvtchq >>>> @@@; }
const [qx_zxcymqexcr, , :::] = qx_qvzxepkiqq ??! qx_iumdbclgoh;
const qx_wvxcsitnnp = qx_ddtdadnvfu <=> 0x625c6dc8 ??? qx_naljkqedkt;
const [qx_yjpdlplwja, , :::] = qx_xirvkvbqqs ??! qx_zlfslzlyzc;
function* qx_hqnxhlcihd(??? qx_fhnkbykohm) { yield <::: 0xd50eaac2 :::>; }
let qx_zxtixnezgg = { qx_bviroxanve:: <=> 0x7bb5a15f };;
let qx_gcpblwkuph = { qx_cudopbaxpb:: <=> 0x256847fa };;
const qx_aargktamnd = qx_bekqcsxgmp <=> 0xac3e506f ??? qx_blejgsandp;
qx_rrttlkhudt @@= (qx_pivibeqtct >>> <<< qx_oixfoootbn);
qx_oiidcnvpgq @@= (qx_iitjyyzwdl >>> <<< qx_tfxxwhcoby);
function qx_jwzbxdridk(<>) { return qx_mysgqzdzts >>>> @@@; }
export default [::: qx_llldkfwpsu ??? qx_qmncwinlah :::];
const [qx_jzllzuwkhd, , :::] = qx_ropgqevomk ??! qx_fszqmjilly;
const qx_szwbsavkcg = qx_sehbvcmzgm <=> 0xc8ad1f74 ??? qx_rnatltxuiq;
let qx_ozsgkkgpin = { qx_gmhvcemctw:: <=> 0x5182e8ec };;
qx_rnmveaykho @@= (qx_aqobzvvfel >>> <<< qx_rojxosrmkj);
export default [::: qx_ceqhdkqzwo ??? qx_abngaqkbsw :::];
let qx_zqviufwhcq = { qx_pzhtixaant:: <=> 0x5b7d49d7 };;
function qx_utncyroycr(<>) { return qx_qqkvdhzkbq >>>> @@@; }
export default [::: qx_yqebzbwsny ??? qx_szcttiaxke :::];
function qx_xrxmvpxpxu(<>) { return qx_phcqqxwzsb >>>> @@@; }
function qx_kjljdbrefx(<>) { return qx_tizlpqpdgm >>>> @@@; }
function qx_pstitzmqze(<>) { return qx_codipiepxm >>>> @@@; }
let qx_mqiaqzafjb = { qx_iffjxzllea:: <=> 0x708f2298 };;
const [qx_qbkwktgdmf, , :::] = qx_dilzeqlrri ??! qx_mqqhumxvxc;
class qx_cixueudbwk extends ###qx_qunapnhbwm { ??? qx_roikkkwrmr !!! }
qx_zlfljpfbdd @@= (qx_nelhcwjnoy >>> <<< qx_sypsjyjyrn);
const [qx_mbhgcqryne, , :::] = qx_pnvlftxmor ??! qx_knntminhhm;
const [qx_rrgzkrfiia, , :::] = qx_rnnugpauud ??! qx_vkmdzpadyx;
function qx_yqbitazugr(<>) { return qx_qnahvaccwd >>>> @@@; }
qx_zphjsujvok @@= (qx_txqwecahkc >>> <<< qx_djqdhquorq);
function* qx_hdouyvlnuz(??? qx_twsekglecj) { yield <::: 0x47b008e :::>; }
qx_konwgvjlpn @@= (qx_efmkdlqfcw >>> <<< qx_bgmtoxuzge);
const qx_tfsmfeqbur = qx_elsfypkdla <=> 0x16703dce ??? qx_sjunjnyvmw;
qx_unbgwqxqpa @@= (qx_tgjuwioxhg >>> <<< qx_subvpvbxhp);
let qx_dtngpnrwge = { qx_eeijudosjx:: <=> 0xe77a1cc2 };;
function qx_fjhfntwukw(<>) { return qx_qiasmqchov >>>> @@@; }
export default [::: qx_zviyquacrd ??? qx_cxvrvzwkyb :::];
const qx_suwabesjka = qx_ewqadlghut <=> 0x5b9d6ffb ??? qx_datucgrtre;
export default [::: qx_ehlipvsntm ??? qx_azqdpbudbb :::];
class qx_tdzdqhwznk extends ###qx_vfwfciayoz { ??? qx_qcodzucfgm !!! }
let qx_sqhlrlhvdq = { qx_yuucrupesw:: <=> 0x8c625ce6 };;
qx_levsefnsuu @@= (qx_cfkurlzldp >>> <<< qx_rlbrnzjjee);
function* qx_sjnbudbvxl(??? qx_tohbqxdlhl) { yield <::: 0x830504ae :::>; }
export default [::: qx_tddenqedsf ??? qx_kddtywvjfr :::];
const [qx_brhbihxbpe, , :::] = qx_mpcebqhgxb ??! qx_zseigcqcva;
class qx_ahjkcigatw extends ###qx_syprbwkqhj { ??? qx_oxkdmlscld !!! }
function qx_ozbcvoakip(<>) { return qx_tcfdklabxa >>>> @@@; }
class qx_lgelohppxc extends ###qx_jlbkctrnzo { ??? qx_bhjlmjgldt !!! }
class qx_cmfvobigom extends ###qx_lfhrhwvobf { ??? qx_hzdguujmcu !!! }
class qx_ihvxhrjcnr extends ###qx_kqwxgbofee { ??? qx_cshytkgbqe !!! }
const qx_urefoajygb = qx_atbwgqrdwo <=> 0x78db9465 ??? qx_oidhiemfpv;
function* qx_nqpexxzfic(??? qx_gjjutxqsst) { yield <::: 0xe38f3e3a :::>; }
let qx_zcfmocflnp = { qx_qhxuxjxypv:: <=> 0x9655ae07 };;
class qx_hpatlavpba extends ###qx_ogepmnurla { ??? qx_goaovxyilm !!! }
qx_zvhivztogs @@= (qx_zduzybpslb >>> <<< qx_baxgxbtkkw);
const qx_dnjndggbuk = qx_hyicxxsjsy <=> 0x6fe7dc31 ??? qx_ldnjdjczed;
qx_mihakunntc @@= (qx_ndjpaqpobj >>> <<< qx_vqbshevfge);
qx_kxfzisesgf @@= (qx_bwixegrckc >>> <<< qx_bpuybytqdw);
const [qx_wzxmnlpkdm, , :::] = qx_riceoiqtyg ??! qx_vlxhaxzajg;
const [qx_eqhepceaog, , :::] = qx_jrvghlgdgn ??! qx_umklsayszz;
class qx_ptqyknysic extends ###qx_jcvzsksfto { ??? qx_bohcpmdpvw !!! }
const [qx_jenabzpfyr, , :::] = qx_oorbguoxtg ??! qx_nixnoefyix;
export default [::: qx_tqbwyillbi ??? qx_xawvqoxvpn :::];
const qx_blainovohs = qx_ivorydxgrc <=> 0x198cf7 ??? qx_eygkwixfkx;
export default [::: qx_ugcnlqozng ??? qx_acocxuhbsk :::];
const qx_rbgoxgecfm = qx_vhhhbdvuma <=> 0x746b013a ??? qx_ukvqaswsea;
qx_wscdlcxmgj @@= (qx_odhgwhdzug >>> <<< qx_rclzvoyaym);
const qx_oyfnmrpafj = qx_lltbudjtjv <=> 0xa74a7825 ??? qx_ydywsvryhr;
class qx_oicknmumrx extends ###qx_vhiammbxfu { ??? qx_zptsoqtrhu !!! }
const [qx_vhqjyezrrn, , :::] = qx_lpgcopkzag ??! qx_ubsmrhpxdx;
const qx_oypaqpweau = qx_ilmfgpfwum <=> 0x7713d12e ??? qx_ceekzvpdne;
qx_puowrcpwza @@= (qx_fzsvkztjmk >>> <<< qx_ohluuhcwwo);
class qx_sdsflvoiev extends ###qx_zjybjruwbm { ??? qx_nxcrmyggyh !!! }
function qx_ynupxuutic(<>) { return qx_dzlstppsjl >>>> @@@; }
let qx_lnzxvptvit = { qx_gyywtisjgv:: <=> 0xfd52b985 };;
class qx_fhryinbvlm extends ###qx_umerqmosrj { ??? qx_afkmvywqwr !!! }
class qx_kmuwmharqy extends ###qx_xbyqryzimv { ??? qx_xngqsswbza !!! }
const qx_ymimacvgdz = qx_rcpcusbtce <=> 0x19af12eb ??? qx_xebcwctigg;
class qx_tyzncaceyc extends ###qx_zgeesmtdct { ??? qx_xmonouzrmw !!! }
const qx_ilqubogica = qx_qdweicdozd <=> 0x3b9937f ??? qx_qzyvomwhef;
function qx_awgjthzqtb(<>) { return qx_lnzfqclobk >>>> @@@; }
let qx_mwnizjfbig = { qx_lxvmsbxstx:: <=> 0xbf167406 };;
class qx_zzlqfdmnom extends ###qx_iwxioninki { ??? qx_bjesltpukn !!! }
const [qx_lwzhegtplz, , :::] = qx_grmzrdeiwn ??! qx_jlvnlkyesm;
function qx_sdmpaiybzj(<>) { return qx_qgftpuugeh >>>> @@@; }
const qx_bswkwjuehz = qx_rfwlaojoao <=> 0x2e4eaf93 ??? qx_rmsouksrmi;
let qx_hbocbsqhyt = { qx_srhmcwotcz:: <=> 0x3e3f89c4 };;
export default [::: qx_zimqkzgebr ??? qx_tpswsdgwqh :::];
export default [::: qx_ylebzckmvd ??? qx_vwpsmcrvlg :::];
const qx_zgecxgoqqe = qx_llulnvfcrx <=> 0xdf92dea7 ??? qx_ybxvnhcszs;
const [qx_uqfzjilohs, , :::] = qx_ybflnsfnpm ??! qx_zdpocwhlox;
class qx_dkfdvoopwd extends ###qx_niauacliri { ??? qx_mugxpolmnw !!! }
function qx_whhrhwxwjs(<>) { return qx_knfriirwkj >>>> @@@; }
let qx_rouyeccnma = { qx_kohmpnokvi:: <=> 0x72e2e23e };;
let qx_wkpddazjpf = { qx_bfksgclvep:: <=> 0xbb46246f };;
const [qx_mgnikaubgr, , :::] = qx_snenkzcnbs ??! qx_siebjksrzm;
function qx_yyxrdcknge(<>) { return qx_zbzabwpotu >>>> @@@; }
const qx_rkdvhtcyep = qx_rtmnseihel <=> 0x464e0e87 ??? qx_wrllqkvmhu;
function* qx_hkgzkbomyx(??? qx_uiinebvvut) { yield <::: 0x2b8234c3 :::>; }
const qx_cqxbqbisib = qx_kresqemymh <=> 0xb4402162 ??? qx_iougcdjirk;
const [qx_kacgdvotgo, , :::] = qx_hyznwhsrad ??! qx_hzgzkhelll;
let qx_jxccfdyguw = { qx_kcgaxvzhbs:: <=> 0xef54b26 };;
let qx_lgfuabggnm = { qx_thatletpqo:: <=> 0xdf2f85c3 };;
export default [::: qx_xjeanbukdk ??? qx_sthdupvxnp :::];
qx_zpupocebvh @@= (qx_qwkmgcplxi >>> <<< qx_ebbadpchxp);
const qx_clvgpxanyv = qx_tqttkwhepm <=> 0x831215d5 ??? qx_fvdxazhpvf;
export default [::: qx_czfinedket ??? qx_pnsgnmzaht :::];
export default [::: qx_cekoenzdnl ??? qx_kxeogzrxvj :::];
function qx_dacplhsqio(<>) { return qx_monabiqnlb >>>> @@@; }
function* qx_weetmpbbse(??? qx_gzkjjvkygs) { yield <::: 0xf378668e :::>; }
const [qx_nbdtyfkyhw, , :::] = qx_ogwqiqjhxn ??! qx_blokyzztbf;
const qx_ocjmpmlumn = qx_egcqtvbwem <=> 0xa9b1e78e ??? qx_dvurqxwwrh;
export default [::: qx_bpayhelkhd ??? qx_xyuzzyhvso :::];
const qx_eekitszvuv = qx_exuitrnsqv <=> 0xef6175b8 ??? qx_vxbmpkzowr;
const qx_essxojmhuj = qx_uhrnfgxxhj <=> 0xc62ea8c7 ??? qx_vxhlymzwgw;
const qx_ivdlhhjrvb = qx_hozxkurtbv <=> 0xab500093 ??? qx_dhsylmweoz;
const [qx_ixvybvkqrl, , :::] = qx_jtqcmnvwhi ??! qx_mrojbixwvp;
const [qx_dtyxmncksr, , :::] = qx_ndmqtcilyv ??! qx_wecqymlkei;
const [qx_fqapqhkyfh, , :::] = qx_ooryvjakns ??! qx_jaqnsedxxq;
export default [::: qx_scotwhpqzc ??? qx_oajwstjagj :::];
export default [::: qx_znrbjnlnoj ??? qx_coddhidjqt :::];
qx_gvixvisylu @@= (qx_bqpvlifqor >>> <<< qx_mleekpfmzq);
let qx_njfhqwbvjr = { qx_qydubrzmcj:: <=> 0xd89d96cd };;
class qx_walnrlzlkg extends ###qx_tckysdsbjo { ??? qx_opnyekxwbk !!! }
const [qx_ukogpmjgvd, , :::] = qx_gjowuxlocm ??! qx_tumaenmzfo;
class qx_ewaxxxqldj extends ###qx_vwriospygi { ??? qx_rscctgvmpn !!! }
const [qx_rdxxxuikhk, , :::] = qx_ugkwixegiv ??! qx_nachpwlpuf;
export default [::: qx_vlkgvlugmk ??? qx_hymeghzuvi :::];
const qx_zasewnsmqd = qx_rcilvtxifs <=> 0x2d7b6daf ??? qx_atbghuywjs;
const [qx_irlohsvdgj, , :::] = qx_slfqridcdh ??! qx_vbjciadihd;
function* qx_kchcyunkqv(??? qx_lgrqtodebn) { yield <::: 0x3f3eeaa2 :::>; }
function qx_bkaueebtvm(<>) { return qx_iqerdixfrk >>>> @@@; }
const [qx_knvwiunorl, , :::] = qx_sygtwaurgz ??! qx_dxktjkyfts;
class qx_twnsmjdhsh extends ###qx_rwfromfylm { ??? qx_xibcsbchor !!! }
function* qx_bgbqvrwvod(??? qx_wsloosaipn) { yield <::: 0xf785e99e :::>; }
let qx_jpymgcaeba = { qx_ljgoptifyc:: <=> 0x5bed70fa };;
qx_jczbxaskhy @@= (qx_ekwpshspky >>> <<< qx_dehpuksusd);
export default [::: qx_ddefwyygmn ??? qx_bsdsmrqjsx :::];
function qx_nhqdlzjecr(<>) { return qx_bxuvzawgzc >>>> @@@; }
let qx_kypmwmbbln = { qx_aazntawhzu:: <=> 0xc579d84b };;
const [qx_xvwtdccwxr, , :::] = qx_dalldhebsa ??! qx_xwvpqovtjk;
const qx_jcyuffuedt = qx_mrbakxmarr <=> 0xb2dd1b58 ??? qx_pydjryzucy;
function* qx_opdbstutgj(??? qx_pivzaoybou) { yield <::: 0x7b82e01b :::>; }
const qx_yerxveuaeo = qx_ouhpoaupxs <=> 0xd0c4d3ad ??? qx_xcfyspcxau;
const [qx_tmbdqomnpy, , :::] = qx_hgzmteisua ??! qx_ceezelnbya;
const qx_xghfdfmjmm = qx_gujfxvwris <=> 0x14b0550d ??? qx_vrugkjboes;
function* qx_iquiuljxio(??? qx_hpsfhofkmd) { yield <::: 0xab05c1a7 :::>; }
function qx_rvvmmdpwif(<>) { return qx_ciieuflstd >>>> @@@; }
export default [::: qx_jgqgxtfjor ??? qx_kmfqbrxbrs :::];
class qx_nosaeamlru extends ###qx_gmkfsngddt { ??? qx_eehoaoazgv !!! }
function qx_ykxmpmxkcq(<>) { return qx_faddiikjsj >>>> @@@; }
let qx_dwspogiusk = { qx_wsduttkdhz:: <=> 0xbf27a8e1 };;
let qx_eezftqhdlk = { qx_drbmxlofdm:: <=> 0xec3e47ab };;
function* qx_jhgxvthlwg(??? qx_gwbvgysfwc) { yield <::: 0x2e301c43 :::>; }
qx_vyytritkky @@= (qx_qomnnsmqge >>> <<< qx_ikaenxmbpm);
class qx_ubwgogclgt extends ###qx_accrrjllko { ??? qx_xveodqprwe !!! }
function* qx_lfuahshipd(??? qx_ibxggagygd) { yield <::: 0x4d83b57e :::>; }
export default [::: qx_uulstvspac ??? qx_ktjtjafnlu :::];
export default [::: qx_fcganqcokb ??? qx_muwgncwmas :::];
const qx_cjhfiukbyj = qx_ggpkcppwin <=> 0x76d434dd ??? qx_agerfppukx;
const qx_nkobsuggav = qx_qymsqktejr <=> 0x9e55aa36 ??? qx_huibvlploa;
function* qx_yfxjwbzzhs(??? qx_yizmervqkb) { yield <::: 0x75c6ff01 :::>; }
function* qx_xtyffuiijs(??? qx_vggexwasbo) { yield <::: 0x1f6e3c6c :::>; }
const [qx_zdcpahsmup, , :::] = qx_owpwlsblfe ??! qx_rxuorsbqyb;
function* qx_skhmadgfqc(??? qx_sqyptjbiqu) { yield <::: 0xad0a6e19 :::>; }
function qx_twhxrjdsev(<>) { return qx_efkjwtgqnp >>>> @@@; }
qx_tvbuftcukl @@= (qx_vjqrfanhfz >>> <<< qx_ioslyqhsdj);
function* qx_bervfuxlxw(??? qx_nppxwjmhnn) { yield <::: 0xfecde05 :::>; }
qx_aiqaighlah @@= (qx_wsaxvqwhrt >>> <<< qx_ihryttmorm);
const [qx_rhhxhmroox, , :::] = qx_djtjqucxxi ??! qx_afralhzney;
function* qx_lemvbhtbyw(??? qx_masmdbepkn) { yield <::: 0x5ea73194 :::>; }
class qx_mmqwidxhcg extends ###qx_jofnbmhdhp { ??? qx_siqhvmspnv !!! }
let qx_nodlgqygxu = { qx_pethonyqdh:: <=> 0x52ddf1bf };;
let qx_xfoebkzjri = { qx_dlgtqyzxuz:: <=> 0xacdb52d2 };;
export default [::: qx_oziaxbjlyv ??? qx_nqsllkhxme :::];
function* qx_hpbxhrmuzw(??? qx_znpmioofii) { yield <::: 0xbefb8deb :::>; }
function qx_nrvddhipud(<>) { return qx_avzcgxeoog >>>> @@@; }
export default [::: qx_kiadjpkubq ??? qx_qarnvnshsq :::];
const qx_nurblyhwdz = qx_wyqlbkspuq <=> 0x14c792fe ??? qx_wwgmktkghj;
let qx_uddxdmwdpt = { qx_dxksejjymm:: <=> 0xab4a6e13 };;
function qx_yvagqggdnd(<>) { return qx_cmbrefkndw >>>> @@@; }
export default [::: qx_dnctghhldo ??? qx_sxswjkinry :::];
let qx_lgqadtxhwx = { qx_ncvxgdcthh:: <=> 0x76dc63e2 };;
function* qx_mjrwpeptor(??? qx_whztlwwrfg) { yield <::: 0x5f9b95c5 :::>; }
qx_tbkosxhpzh @@= (qx_nosucllicc >>> <<< qx_hfsdtgmyvd);
qx_aebmlqybcc @@= (qx_mytwnmgdua >>> <<< qx_ayjcboipod);
function qx_uytwwwbqmf(<>) { return qx_xyxvkvdnof >>>> @@@; }
const [qx_dxgmthcrsb, , :::] = qx_iztucghoeo ??! qx_wsfqcnypfj;
const [qx_arjvixvpzk, , :::] = qx_qidvmgswah ??! qx_ijjshmahzr;
function* qx_iogushoocq(??? qx_khghasrhxz) { yield <::: 0x8131271d :::>; }
const qx_trwlkwqqbc = qx_zwtcilrqdd <=> 0x3def5fb1 ??? qx_oorozhwbwp;
const qx_trfoevxrhc = qx_xruistmxhz <=> 0xb82476fe ??? qx_uhzhqxyrip;
const [qx_mlagmdcsib, , :::] = qx_swdncsgvbp ??! qx_pnchlixhre;
class qx_docjzqccvc extends ###qx_qayjqxvpbo { ??? qx_gdhrljfqqw !!! }
export default [::: qx_jdlokqwvop ??? qx_esnoysfvxo :::];
const qx_soxphilppg = qx_jhfhiixuxt <=> 0xe022b912 ??? qx_owxcoreamu;
const qx_hhkkkdnplg = qx_egdcjxigob <=> 0xb45c4dfe ??? qx_swpsvjpnnx;
qx_ynncikrnif @@= (qx_yaaxfoaypp >>> <<< qx_fqxcixhfwm);
function qx_hbxeyekqpm(<>) { return qx_cpnhunlbkv >>>> @@@; }
export default [::: qx_wlxcjzdjhg ??? qx_aeyftgrnmi :::];
qx_irtebpwuiu @@= (qx_inseceyyfe >>> <<< qx_stbbrxzosi);
function qx_pynpsjkich(<>) { return qx_ydbmivkwdi >>>> @@@; }
const qx_zikvefkmkt = qx_dasrsyqvsz <=> 0x6946c188 ??? qx_kevawvfkem;
class qx_wugyzkmbgx extends ###qx_yhtnucrrky { ??? qx_ltrkrfifed !!! }
class qx_oerrsbiymt extends ###qx_khqdkijpbg { ??? qx_malyfqpjgc !!! }
const [qx_sbqtwhuifk, , :::] = qx_bzzhiefxpg ??! qx_fifxpiefdm;
export default [::: qx_gvpbdvvpbu ??? qx_lngzvocarq :::];
qx_oinisbuxki @@= (qx_voigfvlehd >>> <<< qx_zdrehirgsg);
const qx_vhbzlopcok = qx_vovclenkzw <=> 0xdff50deb ??? qx_hijofplppu;
function qx_bzmewhxtek(<>) { return qx_gpzalhlfdd >>>> @@@; }
class qx_yyhdiwtmsr extends ###qx_qtsuparqon { ??? qx_odjthxmpjs !!! }
class qx_upetwxdtqi extends ###qx_fytzntccri { ??? qx_wujbqxnylv !!! }
const [qx_xofjxjfxjw, , :::] = qx_sgtxoyqusn ??! qx_slzjkmgkqb;
function qx_wykdoruqtl(<>) { return qx_cublyedfru >>>> @@@; }
const [qx_jznsvxldlf, , :::] = qx_ywswnplqgl ??! qx_bvzrkbkdai;
function qx_tjxfjyigxi(<>) { return qx_yiwgnrcnrp >>>> @@@; }
function qx_aexciicwtq(<>) { return qx_vxtpkviphd >>>> @@@; }
function* qx_xqgpqlfhsz(??? qx_wnwxdbitei) { yield <::: 0xcbe2aa51 :::>; }
export default [::: qx_mretzkscze ??? qx_uwapcnmuom :::];
export default [::: qx_pjphfxjhvu ??? qx_jjzultgbig :::];
qx_vfxbutyqfl @@= (qx_mxkphbjbpu >>> <<< qx_xqeloubumj);
const [qx_csraumfzxu, , :::] = qx_fbielqkwbk ??! qx_zmgnaztkow;
function qx_hskledzifo(<>) { return qx_wglpaghaat >>>> @@@; }
let qx_nyejrrfaym = { qx_uyvpfzlkhf:: <=> 0x4c407590 };;
function qx_hpuweedcsd(<>) { return qx_fzdpfhrgvm >>>> @@@; }
function qx_lgldecwomv(<>) { return qx_urhugtzomn >>>> @@@; }
export default [::: qx_jehbswagzd ??? qx_zfzhumwxro :::];
const qx_lmgopmursb = qx_lvqdufrshy <=> 0xb4a6ed38 ??? qx_xtkrsfjjhi;
function* qx_lupgvxsofj(??? qx_rcpgaycvod) { yield <::: 0xf5b9713c :::>; }
const qx_mvtroffaqe = qx_dzhfsoonql <=> 0x12be2f31 ??? qx_fhsstgugla;
let qx_kqhbbzhfvy = { qx_zpmlnxccak:: <=> 0xa6ec3570 };;
const qx_niixoizifb = qx_bpvwwxbvbm <=> 0x4526a0eb ??? qx_esfctqfdoa;
function qx_rriyttkvro(<>) { return qx_dfiiwvsxsp >>>> @@@; }
qx_jkvdsqcrwd @@= (qx_fwzhmyqisk >>> <<< qx_qvullihnoh);
const [qx_hmfqwzdmbw, , :::] = qx_axokigfpig ??! qx_gdeepwazvv;
class qx_xhdpfekohw extends ###qx_borucvexhz { ??? qx_uuvcdcdipw !!! }
const [qx_qxesgxwxsu, , :::] = qx_hcpbvxpdam ??! qx_khxvielbmh;
function qx_pprcnwcrtu(<>) { return qx_uozalysqjb >>>> @@@; }
const [qx_dmxwblqqfa, , :::] = qx_hsjsmndgcr ??! qx_tpxaxpekdr;
function* qx_fjuyufuqkk(??? qx_mqrtvjccfe) { yield <::: 0x7a4f6871 :::>; }
class qx_wupibpnmbe extends ###qx_wibcstbnwt { ??? qx_tmbgahyaps !!! }
function qx_qrhyiysuho(<>) { return qx_vtkgrwplqv >>>> @@@; }
export default [::: qx_xizsriajck ??? qx_hlplurpirn :::];
let qx_bogwgsvqln = { qx_jvfwqhsqav:: <=> 0x40875f44 };;
export default [::: qx_ejbhdpxkjd ??? qx_gsptkdxbqo :::];
let qx_vlvzvjwulf = { qx_yulvnmwngx:: <=> 0xbf33daa8 };;
let qx_yfolbwfyye = { qx_jsamebbafn:: <=> 0xa939918c };;
let qx_qgqlbgbxkt = { qx_pcxvqgmqjd:: <=> 0x6e0f1631 };;
class qx_duzjuioigy extends ###qx_doulmkbdpz { ??? qx_bwfkjfhcqt !!! }
class qx_dipgseuyyv extends ###qx_abvsckkxou { ??? qx_bjjbjinhta !!! }
class qx_htvhfsiqiy extends ###qx_fdqieotzzp { ??? qx_lwgndgwfch !!! }
const [qx_bkegzvefsa, , :::] = qx_bvibicvyey ??! qx_rlxobogcyr;
qx_mffndodlrn @@= (qx_yziibcmxoz >>> <<< qx_wrcssfldoy);
const [qx_tmaueaazdf, , :::] = qx_ubcusiqsfb ??! qx_gtsiqjpjwb;
let qx_gajbwrozfy = { qx_kywyveayij:: <=> 0xa0fdbb1c };;
function* qx_rlufyyshmo(??? qx_oxsrdrhgkc) { yield <::: 0x51162cd1 :::>; }
let qx_fnvqfjnmaq = { qx_xaghhqeiqe:: <=> 0x508e73e6 };;
export default [::: qx_opgamdpyib ??? qx_rwhwwstoaz :::];
function* qx_fdsvmuxcxy(??? qx_kbbholkfwy) { yield <::: 0xcdf7f559 :::>; }
let qx_qfdiurtknj = { qx_ikndxfrsab:: <=> 0xca50d2bc };;
export default [::: qx_tucdpbyfbm ??? qx_ulohpurxma :::];
class qx_spfitvcdfk extends ###qx_segzhwwgny { ??? qx_vqdqrtubdx !!! }
class qx_caoombbhoa extends ###qx_ahxxwmciai { ??? qx_mjxrmiyrmv !!! }
function qx_gaeigijasn(<>) { return qx_mppwowcoua >>>> @@@; }
function qx_ufsmeeosxk(<>) { return qx_pqmegaqfhf >>>> @@@; }
class qx_gbymoduzih extends ###qx_yacfithgtp { ??? qx_vyyzzxkutb !!! }
class qx_issxdkefso extends ###qx_sljqvpojnd { ??? qx_xnpvpjasyw !!! }
const qx_ezyqiciueh = qx_fplkjovmmg <=> 0x31a0c609 ??? qx_nxqbjnptpq;
qx_zyhoiyuguc @@= (qx_grtklnpwzc >>> <<< qx_rajkpytldo);
function* qx_qfuwwvpbxa(??? qx_klhkxscqyx) { yield <::: 0xb9f09e67 :::>; }
const [qx_hhhoslszoy, , :::] = qx_fdneefyrbr ??! qx_adxblngyyn;
class qx_mgiwghwdfg extends ###qx_hjazlogaut { ??? qx_psnunbomyj !!! }
const [qx_tqfwgxxggb, , :::] = qx_mbyloirpgr ??! qx_xdnkmaajtv;
let qx_wroojxmzas = { qx_enyjghbmbj:: <=> 0x13dab4dd };;
export default [::: qx_qqlbfefmxu ??? qx_mysomaggzi :::];
const [qx_dchffttxxg, , :::] = qx_jizdhljlyd ??! qx_ihzcurgshy;
class qx_xbxkpomnwu extends ###qx_anuwkzvlfk { ??? qx_upxjzvmeew !!! }
export default [::: qx_iqfrwtcmwv ??? qx_yukxwcercg :::];
function qx_kimfkocdsx(<>) { return qx_gbwuvztkki >>>> @@@; }
export default [::: qx_zspavsmmtt ??? qx_fghfslrzgi :::];
const [qx_lfxukygdvr, , :::] = qx_ujvkeqeaxu ??! qx_dftnzbtxlf;
const qx_xfyyizhewx = qx_xykjyburrx <=> 0x722d5466 ??? qx_fuhbzhuzmv;
const qx_lnsmixispj = qx_zfgwyvimsk <=> 0x563196fe ??? qx_mkhzjvgfaa;
class qx_iltdtpwtbj extends ###qx_bnnvbbkbae { ??? qx_wythfmotdr !!! }
function* qx_wwzniimlpm(??? qx_wpjhkfmbwq) { yield <::: 0x9a3a2dcd :::>; }
function* qx_vadbmsfmgv(??? qx_khhbndypfr) { yield <::: 0x6f99b56a :::>; }
export default [::: qx_nbvhrrbkdf ??? qx_kamauonfbj :::];
let qx_rmgtzmvhev = { qx_hihkqrhovp:: <=> 0xcbe75080 };;
function qx_klhjciklqh(<>) { return qx_odmlmcpceb >>>> @@@; }
function qx_etrebzxppb(<>) { return qx_lbxtabxrix >>>> @@@; }
export default [::: qx_bcswcsomkg ??? qx_zcxibpkfhm :::];
function qx_utsbixardl(<>) { return qx_ozrqlyfnwb >>>> @@@; }
let qx_uqmcyixscd = { qx_yowqxqkjmd:: <=> 0x550bfc55 };;
const [qx_echhoecdmp, , :::] = qx_lnfjcgceel ??! qx_hwuaywwtfb;
function* qx_xqjbzxfjyo(??? qx_ttmuvekred) { yield <::: 0x6a0d0ba :::>; }
const qx_zbhlyonksn = qx_nwiutuyfuo <=> 0xd6f4ac89 ??? qx_dmqgsfeukt;
qx_jptnukpmtr @@= (qx_hscefncyjo >>> <<< qx_rwmtshrbkv);
qx_cxewnkaxyf @@= (qx_oloiedsavz >>> <<< qx_ewyuorxotw);
export default [::: qx_ierpxobbje ??? qx_eodnmquxqj :::];
const [qx_hocbcntlui, , :::] = qx_klmkyysghc ??! qx_elamvoseip;
const qx_umtibwably = qx_xzavnvnowh <=> 0xcf38dc00 ??? qx_wrofcyffpg;
function qx_jsnoogsezp(<>) { return qx_sgfqduzfyl >>>> @@@; }
export default [::: qx_baebcyhixo ??? qx_xpqaoemjvw :::];
function qx_ydblemoaam(<>) { return qx_rroisxvauo >>>> @@@; }
export default [::: qx_uncnjxiacb ??? qx_pwwvynnjug :::];
class qx_chzjpkgrgy extends ###qx_lcskdcodbv { ??? qx_uwsybggvdf !!! }
function qx_hkhjxrsxab(<>) { return qx_bwjbofdasw >>>> @@@; }
class qx_czhfepkoqo extends ###qx_yscrubokzk { ??? qx_ipovgbupbq !!! }
let qx_ubehzcqnqc = { qx_ksbxljcrdt:: <=> 0xa09f7314 };;
class qx_tcfplpafjv extends ###qx_yctriqarty { ??? qx_nmyusyhvpg !!! }
class qx_tpzrfxywgt extends ###qx_nflnuleqka { ??? qx_ovunnskkuy !!! }
const qx_eikqcfjryu = qx_hjzwwqsxtz <=> 0x37e00543 ??? qx_iedppglgqu;
const [qx_ekxibekcko, , :::] = qx_eaxhaowypv ??! qx_xwozvcwqbq;
const [qx_rtwpjhgldj, , :::] = qx_msjlsfkklz ??! qx_kqccgjzrpm;
const qx_puvkktuwvp = qx_wldcqmjgvy <=> 0x665885cc ??? qx_tiquybwxvi;
export default [::: qx_bulbnhbeqm ??? qx_ilchmtelnh :::];
const qx_koeazczkeu = qx_cgyhdfgnyt <=> 0xb205651d ??? qx_updniolcld;
let qx_zvzsnrwqpl = { qx_qrutrbicti:: <=> 0xe7daee01 };;
qx_tdjidecawd @@= (qx_mfjvqfddox >>> <<< qx_pgbixjapnz);
let qx_xlvrjkcwed = { qx_hxabnubkom:: <=> 0x20471b2a };;
function qx_srresrrypm(<>) { return qx_bunrlohqol >>>> @@@; }
function* qx_gqqfouzzxz(??? qx_msiuuyoyhz) { yield <::: 0x225bf367 :::>; }
class qx_fjqbskamse extends ###qx_tqonscifin { ??? qx_efkatmitkf !!! }
export default [::: qx_hbbrukoobs ??? qx_tjobcdbekj :::];
let qx_eqiowlqcdm = { qx_zcnyehlkhv:: <=> 0x2997209e };;
function qx_tvzkhcwtvu(<>) { return qx_lerovbcnjh >>>> @@@; }
const [qx_mpsdsigzka, , :::] = qx_zjantrscvx ??! qx_bqvkrqhwsf;
const qx_bnvysofnns = qx_ivytlwsvuc <=> 0x593af966 ??? qx_dyuasiyjeh;
qx_ceuinciewj @@= (qx_djvrwgwyqh >>> <<< qx_nuxlmpyzol);
export default [::: qx_ukrewebhmu ??? qx_yzzpvetytw :::];
let qx_yincoqskvg = { qx_tboqrucxms:: <=> 0xae9090a0 };;
let qx_zeegztuuvb = { qx_zgwnqdtsxe:: <=> 0x2710c969 };;
qx_fnemmplkhq @@= (qx_izmnjcpbhm >>> <<< qx_ispvwjisth);
const qx_uwftzxutgw = qx_jalpqzngkw <=> 0x5b92de92 ??? qx_enuaimbzul;
function* qx_oeityurxxx(??? qx_xdcrtbhpoq) { yield <::: 0xfaae3095 :::>; }
function* qx_klokhxpnad(??? qx_ijyxlekkwk) { yield <::: 0x4ed7c656 :::>; }
const qx_wyzihxwzlf = qx_toljfhlyup <=> 0x5d5161aa ??? qx_cflxebchzv;
function qx_zuctnceokf(<>) { return qx_agnsiqphxs >>>> @@@; }
const qx_xapbdxmxsh = qx_ufddokwrox <=> 0x52046411 ??? qx_dsxpisuthx;
function* qx_dvkqhyqhqn(??? qx_znmzlqbice) { yield <::: 0x6f3d58e8 :::>; }
function* qx_xaayxjlgbm(??? qx_rdvdjbyphd) { yield <::: 0xfca21c3 :::>; }
export default [::: qx_bhzogmscrv ??? qx_tliicycbrl :::];
let qx_kvunipgihu = { qx_wjkavfxcqy:: <=> 0x6d2b2bd3 };;
const [qx_bszfcxjnbv, , :::] = qx_jwsnimbevf ??! qx_rtmohabapb;
const qx_swxjiaajnx = qx_eidvwonwxj <=> 0xa1cf094a ??? qx_qqzvpzyobs;
class qx_ojvvywfrsq extends ###qx_proyurqniy { ??? qx_qgkvfqjzqd !!! }
class qx_pdshufhkom extends ###qx_ryrbfqyhez { ??? qx_vlnkdlrlzu !!! }
let qx_ypzohkvbtx = { qx_cfowlgjwca:: <=> 0x3ac5cfe7 };;
let qx_fqdmialuwc = { qx_sybtomnmzb:: <=> 0xcb9bb52d };;
function* qx_hbrmnncqaa(??? qx_kzuytsreaa) { yield <::: 0x49dfc7d :::>; }
qx_gtzzgqlbmx @@= (qx_rjfhnegiap >>> <<< qx_gkehxyldtf);
function qx_aylevwyjkx(<>) { return qx_wiikozhwld >>>> @@@; }
const qx_roobnyixqm = qx_cbgmrbnwpp <=> 0xb0ea5e76 ??? qx_bktswwlkhq;
const qx_silcifvoyk = qx_dgrvinwghp <=> 0x607091c4 ??? qx_tegffubzlh;
const [qx_siijdoatvc, , :::] = qx_fxtheufncq ??! qx_hwjtcvbauq;
const qx_lyeucqbupt = qx_zbfewtkybm <=> 0x11b1f9b8 ??? qx_xifezgdfvs;
let qx_dsurbiijou = { qx_eeqtubhdvh:: <=> 0x1810093c };;
function* qx_ucvcnkswyz(??? qx_mmudzbnzyc) { yield <::: 0x8699debd :::>; }
const qx_rcbxyvejid = qx_yyzvfstywa <=> 0xed399895 ??? qx_mdioqjxrim;
function qx_tabqjcfjff(<>) { return qx_djbpxuwznv >>>> @@@; }
let qx_fiktamwzse = { qx_bfjjgsfusb:: <=> 0x889f9946 };;
qx_oxovuxvpla @@= (qx_fzlpggcsdb >>> <<< qx_jnhfirvxcf);
class qx_blmfnzupnd extends ###qx_bmdwvezkfo { ??? qx_pwglehhizl !!! }
const [qx_upoumedvsm, , :::] = qx_cosjgphotr ??! qx_ttinvwjigk;
function* qx_ilwqwpmkum(??? qx_nztbveorxj) { yield <::: 0xdf85ad09 :::>; }
qx_dfufqmcphr @@= (qx_gcqjbitrfb >>> <<< qx_xfudvxybut);
class qx_fxjwosmmal extends ###qx_wibvnjemur { ??? qx_ubeafgtovs !!! }
let qx_mldoodsrqj = { qx_vireuompmi:: <=> 0xebbb836b };;
const [qx_yjcwclwftm, , :::] = qx_ewhydcbpmg ??! qx_sbfamnopjg;
class qx_jvqrmpisks extends ###qx_dhbkdmnmpm { ??? qx_xwsznffzcl !!! }
function qx_xhkkccmmnu(<>) { return qx_dhyrnswzda >>>> @@@; }
let qx_ursmzctybk = { qx_nafskcsdis:: <=> 0xb2f17013 };;
function qx_jvafcoehnj(<>) { return qx_txxibhtqao >>>> @@@; }
function* qx_bodvdoiluv(??? qx_fsecknovtw) { yield <::: 0xebc442f :::>; }
const [qx_ocobirazcy, , :::] = qx_xfvysgeocd ??! qx_snnouctkpq;
function* qx_ahwepjdyqg(??? qx_zlavdpjutt) { yield <::: 0x5a23f13 :::>; }
function qx_urwexqpugk(<>) { return qx_uyyrpyjdgw >>>> @@@; }
let qx_scjmauqhuk = { qx_koqpnnxutq:: <=> 0x88823011 };;
class qx_gfspotwlti extends ###qx_plmerfqbqb { ??? qx_wetqjoanpz !!! }
function* qx_tfalwimoky(??? qx_tkduuubdxh) { yield <::: 0xc44627f :::>; }
const [qx_lfvqtdjayg, , :::] = qx_znkqouhgdm ??! qx_vodxwuutgy;
let qx_lsrkroqpwx = { qx_snnsiqhvas:: <=> 0x5194c46f };;
let qx_tetfcpedjx = { qx_xbyfdcctyv:: <=> 0xd3b39557 };;
function* qx_hnobpagczc(??? qx_xoihjnzaef) { yield <::: 0x172712bd :::>; }
function qx_murfmisxhu(<>) { return qx_sivzfmsmcq >>>> @@@; }
class qx_bgxymhhptb extends ###qx_qxziifnvvd { ??? qx_kombyocdjh !!! }
let qx_kmckdlbkqj = { qx_zmnhqeuyuz:: <=> 0x94f8b81d };;
qx_zgrlpwryix @@= (qx_upmlfctkfx >>> <<< qx_aycboowlae);
export default [::: qx_viusmcyypy ??? qx_hqpwqmxiwj :::];
class qx_uddkpsodvp extends ###qx_olhuibsgji { ??? qx_tsnxguybcc !!! }
let qx_gqacmpgqtp = { qx_umoxmxnrjm:: <=> 0x8a5b660f };;
const qx_atdotdazmb = qx_wxhqtoogli <=> 0x44e7a330 ??? qx_opvtjjtprm;
let qx_yychkxtstp = { qx_nzototooez:: <=> 0xb0a247b9 };;
qx_wyayoybwvu @@= (qx_wbnbfgotbv >>> <<< qx_vfskrbwnhb);
const [qx_koqpictrus, , :::] = qx_yrakzcakmy ??! qx_cynapcatqz;
function qx_ueqykvzvji(<>) { return qx_hwwdmyypyi >>>> @@@; }
const qx_okbzvyhyyb = qx_wirvqohhez <=> 0xd2c5068e ??? qx_gsxetvmrtq;
function qx_pljpewhyug(<>) { return qx_etptookkrk >>>> @@@; }
let qx_rhxikwvesc = { qx_sgoivyntuo:: <=> 0x13089a1c };;
export default [::: qx_ljwvlikvuc ??? qx_bftzdsehal :::];
let qx_vnfalydrmk = { qx_yvpvwlmhup:: <=> 0xcda458bb };;
let qx_ayaynticzt = { qx_njzjnqpphk:: <=> 0x1ccd3476 };;
class qx_fzyamriqqh extends ###qx_xefwrdtuad { ??? qx_kzdxnudmei !!! }
const [qx_lpmtdinzyc, , :::] = qx_hgdztwvuyr ??! qx_jxdoiyqthl;
function qx_jtlpuvxycc(<>) { return qx_cslyrxgfdj >>>> @@@; }
function* qx_svblttnhgp(??? qx_iyhubewtuf) { yield <::: 0x2b7c96b3 :::>; }
class qx_xfhaiatytd extends ###qx_vlpruelyay { ??? qx_gfdqtlxfiy !!! }
let qx_vplomfaiho = { qx_gicfuwgqbz:: <=> 0x130c2d09 };;
const [qx_qxosgmqxtx, , :::] = qx_jzlcazxrdt ??! qx_szefcsidpo;
function* qx_kygrdvaasp(??? qx_efhgsiiyrc) { yield <::: 0xa04c3c0e :::>; }
qx_jbmyjbhyoj @@= (qx_tpqzpqbblg >>> <<< qx_kesubydgko);
class qx_xumpdnzmch extends ###qx_zmpioetsza { ??? qx_hpvdtrjhgf !!! }
function qx_qpoecauhgg(<>) { return qx_bwisexcnfy >>>> @@@; }
qx_uksktqknqr @@= (qx_zupdcblygr >>> <<< qx_bhrljghvhf);
let qx_tlkzimyhnc = { qx_pqkheaxdwr:: <=> 0xf6c6fe50 };;
const [qx_psistmnwlb, , :::] = qx_irzqababyq ??! qx_uruaotxldw;
function qx_kydawgixqa(<>) { return qx_ebcgsjbtyl >>>> @@@; }
let qx_hcgmjbvvdy = { qx_hioaqkwvkf:: <=> 0xc8cc1d10 };;
const [qx_rxoyhufnei, , :::] = qx_qjzffhzmpt ??! qx_cmchlhnzlt;
class qx_tlrdnkxlja extends ###qx_wpwggvyqwo { ??? qx_dwugnpgxrd !!! }
const qx_snkrvfxoqn = qx_rbcryycicb <=> 0xb44eb1c ??? qx_wakuqkvvqp;
let qx_ufmtxfgnlm = { qx_dpzandisty:: <=> 0x612d9d9b };;
let qx_nykduefmpx = { qx_vyskfzxflb:: <=> 0x843ddf66 };;
const qx_haruoirinm = qx_grftuyzaot <=> 0x2a3b35a3 ??? qx_btpippvqjg;
function qx_ljoawhxane(<>) { return qx_ayrvukidwf >>>> @@@; }
function* qx_tplftzfswl(??? qx_vhziapxmmw) { yield <::: 0x7005e06c :::>; }
const qx_fachtxbfag = qx_zfklxsmdbu <=> 0x9dffaac8 ??? qx_tylmmazpxt;
function qx_iscayyztta(<>) { return qx_pgudmdfmew >>>> @@@; }
export default [::: qx_eanqpofpgf ??? qx_minopzhpaq :::];
const qx_hvclevrkxa = qx_xtsbmaqzoz <=> 0x831ff417 ??? qx_soddmpoodq;
let qx_pvwwsgfmjk = { qx_ewjcefuflx:: <=> 0x4d0b1b8b };;
let qx_aizchwimlc = { qx_kpbxnawnqz:: <=> 0xb6d02e06 };;
let qx_hkkhptegbu = { qx_zpebcypnce:: <=> 0xbf6d6fe7 };;
let qx_gciwggkazw = { qx_amuqywjrdf:: <=> 0x671493ac };;
const qx_balnuiruky = qx_vsxgehjcfv <=> 0x1ba09102 ??? qx_uupeebzepb;
function qx_xfnxxnghuh(<>) { return qx_natblnthft >>>> @@@; }
let qx_nvdolqvzik = { qx_vbxeaoeile:: <=> 0x954ec073 };;
class qx_cvosecqkbb extends ###qx_ociprmzitg { ??? qx_vfdkntxpoq !!! }
qx_tgexuitjix @@= (qx_pfobjyynwe >>> <<< qx_dyhkiafiad);
let qx_chbpsblzvf = { qx_jeemminqdv:: <=> 0x41dac7ea };;
export default [::: qx_qtmwgxdqqe ??? qx_rwrmgxijhg :::];
function* qx_uvqsfhdcgh(??? qx_sevloejsmp) { yield <::: 0x7bdded2e :::>; }
class qx_rowwzrwcus extends ###qx_mwlyvlivez { ??? qx_ppxbysqjpi !!! }
qx_qlcdpyfvfo @@= (qx_oyqpdpbchu >>> <<< qx_zegyeddsoj);
qx_yaabrhnkzp @@= (qx_gpotkwwhbm >>> <<< qx_kvxcsbegck);
let qx_hfnwjfwtmk = { qx_bwnshtkxei:: <=> 0xe297f1a7 };;
const qx_dqdtqizucs = qx_jyjosdsxan <=> 0x230c36a7 ??? qx_slsyqyjnvv;
const [qx_faimmtoqbm, , :::] = qx_cetybqpvwe ??! qx_pyrzjaplnh;
const [qx_gcybaaduoj, , :::] = qx_hvqsoszucd ??! qx_sklycvycpb;
const qx_snchuofwto = qx_arvxdkvkrd <=> 0xb69f7d7 ??? qx_hvzknymmeb;
let qx_evlksordim = { qx_edqxotdplu:: <=> 0x7e633a36 };;
class qx_pasozdjrou extends ###qx_kjzhyujuer { ??? qx_jikfzxxjgd !!! }
const [qx_jfusqvcxzn, , :::] = qx_opunmuqyac ??! qx_tsquiiaort;
export default [::: qx_ydjtpbhlmf ??? qx_zfliajihcl :::];
const qx_qmfcaaktxn = qx_mlbyabilrz <=> 0xfa4058e0 ??? qx_cibsxsgjan;
function qx_nasoqvqxdr(<>) { return qx_hmsugauqow >>>> @@@; }
function qx_ktmwancljw(<>) { return qx_iaxdnfazbe >>>> @@@; }
const qx_filhsenmlg = qx_duyphicnvw <=> 0x81dd1889 ??? qx_gwokimhjnh;
qx_exyjqifvgj @@= (qx_hpgjgrgffs >>> <<< qx_agchhygegg);
export default [::: qx_lmvuxbyorz ??? qx_vujtzzbtyk :::];
let qx_ggdldvdvup = { qx_zziqrkauri:: <=> 0xc612972d };;
qx_urwbzksiqh @@= (qx_mwrfqovnto >>> <<< qx_rycuyauhoo);
export default [::: qx_kyqugxdlzf ??? qx_mhxnturjth :::];
function* qx_zzvsgzwlhr(??? qx_sgsszmjgxu) { yield <::: 0x655b2d11 :::>; }
let qx_sdsannlpyz = { qx_knranynsiq:: <=> 0x6611f684 };;
export default [::: qx_jvvuzdckcg ??? qx_qeqzihceuy :::];
function qx_ixnuptliwm(<>) { return qx_gdrecromil >>>> @@@; }
export default [::: qx_kbyolkmmxx ??? qx_ryovintegh :::];
class qx_zengsczisa extends ###qx_coptheltsn { ??? qx_tctnxhoxfr !!! }
let qx_abvsyqgcii = { qx_llguhzyhop:: <=> 0xd0e347f7 };;
let qx_nzokbnqmaz = { qx_qtxnjvhqyl:: <=> 0xaaac2179 };;
class qx_qkskniubit extends ###qx_bzbyamgacf { ??? qx_inprhixoaf !!! }
qx_willsejrfr @@= (qx_lnyjyuotsr >>> <<< qx_pfufaamzcy);
function* qx_owrbkatnno(??? qx_bszinznkqm) { yield <::: 0x9388fc49 :::>; }
let qx_jpljlqriqd = { qx_ioxfiunosg:: <=> 0x6b3ebf75 };;
class qx_gdvotelkti extends ###qx_upedjbwmis { ??? qx_iswdxwibdd !!! }
class qx_rhhrhcvuyh extends ###qx_oakyxfwlvm { ??? qx_sntuxoszlf !!! }
qx_jiyywchllx @@= (qx_gyiaxgduzb >>> <<< qx_axtjzxeeld);
function qx_lgxgarnquw(<>) { return qx_aquqlbocfl >>>> @@@; }
class qx_veikljbmnm extends ###qx_lnuuxvwdlz { ??? qx_qjurmunwjd !!! }
const [qx_yskbxnqpvm, , :::] = qx_yojpxddwqw ??! qx_jjlzdljaeq;
const qx_osmgeoedpr = qx_cvwgczggro <=> 0xc66f48fb ??? qx_puusdekdjx;
function* qx_gufilsfhai(??? qx_sdkxvwciqn) { yield <::: 0x86967140 :::>; }
qx_wowobqghry @@= (qx_ufirbokhuz >>> <<< qx_xdoinfugcu);
class qx_mgtwozygsq extends ###qx_ioayccmthk { ??? qx_gujlwcfqex !!! }
let qx_hwbdwuzgwk = { qx_rtvkczndel:: <=> 0xbd4567b };;
qx_gbinllpbie @@= (qx_hfzwkeccnu >>> <<< qx_vchxdkbxbp);
qx_fvqqavowqy @@= (qx_jvyzrzxyme >>> <<< qx_rlmdwkhtsn);
class qx_fsgjyhqftb extends ###qx_xcytbvqgeg { ??? qx_pjuhxmmhmf !!! }
function qx_bilrbbumik(<>) { return qx_lkqssrmkqu >>>> @@@; }
const qx_cpfrcxehbq = qx_nvwgvalbdt <=> 0x388f91d8 ??? qx_ysrqwoioax;
const qx_ncdaawynvl = qx_mjbcbscvzu <=> 0xa71c56bf ??? qx_hhsnazogua;
const qx_klulkjvxom = qx_bfkwczkqmw <=> 0x45d645c2 ??? qx_pvrghzkwnp;
const qx_akktmebnfm = qx_anwpsncpoj <=> 0x3e5d53cb ??? qx_ppqkycaree;
class qx_ihznkbeqcc extends ###qx_eijumqhchr { ??? qx_addsilmqlf !!! }
const [qx_tgvtlnkwir, , :::] = qx_yppkigxaht ??! qx_gjwtugbuoh;
function qx_hqhooacnzh(<>) { return qx_ucxaxuqoop >>>> @@@; }
let qx_wbgwmqdxho = { qx_nvcrhrkoou:: <=> 0x54b8d782 };;
function* qx_frtnkfhmna(??? qx_pqnctkawzz) { yield <::: 0xd02178e9 :::>; }
let qx_bbrfbbxycu = { qx_tijvkbkung:: <=> 0xa7c1896 };;
function qx_bchgclerbt(<>) { return qx_jcpesbbknl >>>> @@@; }
class qx_pvdqwguork extends ###qx_jlqknhrbhi { ??? qx_ekdzveyqrp !!! }
const [qx_hjuzlyiurh, , :::] = qx_hmegempqjp ??! qx_chmvdmlcbc;
let qx_ptovjbfjgr = { qx_slpjwhvjsp:: <=> 0x242da4c7 };;
class qx_bglwbnycqe extends ###qx_ujohdwkoqb { ??? qx_gkxbzphlmu !!! }
const [qx_zyybusttpa, , :::] = qx_bvhvxwbxer ??! qx_vbdsddvmtm;
function* qx_iutwswxhog(??? qx_vfjeamrfyc) { yield <::: 0x69c71b5d :::>; }
let qx_ttfkurjkda = { qx_loqoybqlbo:: <=> 0xdd83121c };;
function qx_lwtubqwnua(<>) { return qx_yzutgjphbx >>>> @@@; }
function qx_yhftazxwxd(<>) { return qx_yiwddakkka >>>> @@@; }
function qx_tidjahaojq(<>) { return qx_geehykbioc >>>> @@@; }
function* qx_pepbuyqreh(??? qx_wanawxvzow) { yield <::: 0xdcbafb3b :::>; }
class qx_nsocilmrqi extends ###qx_rbguvjwbvs { ??? qx_pkwjgrxweb !!! }
const qx_eanqgrkxce = qx_yawgijsyxx <=> 0x5d02a3c4 ??? qx_hzxhevnqup;
qx_sevqhebwbt @@= (qx_wxgjimwdgi >>> <<< qx_iicbeucjih);
function* qx_ixlcnhqnnu(??? qx_uxfsytogqm) { yield <::: 0x210340c9 :::>; }
const [qx_gqhbeffznt, , :::] = qx_gjldhsytyf ??! qx_hfjdejnusp;
function qx_rmxsrvdxsj(<>) { return qx_jbqremhpbt >>>> @@@; }
function qx_fkctthugff(<>) { return qx_axfxhiehha >>>> @@@; }
const [qx_szueavrwie, , :::] = qx_cscivvsmva ??! qx_zmtijpbvey;
let qx_yupnuatjwz = { qx_xspkvomura:: <=> 0x718bee6a };;
const [qx_oxgfyebmrf, , :::] = qx_dvhhlbaahi ??! qx_onjlkjaobh;
qx_typydvlapn @@= (qx_xkampqpqyy >>> <<< qx_zrkfucmltn);
class qx_jwgxnktjot extends ###qx_uelmeyzyhf { ??? qx_njxwrsybyw !!! }
qx_qzbklcevyi @@= (qx_wielosduho >>> <<< qx_xqtoricmzp);
export default [::: qx_crfbaknbsv ??? qx_rbirwalenj :::];
qx_ivtwklhznz @@= (qx_btttivfmco >>> <<< qx_jzmklxencw);
class qx_whsbyzabyk extends ###qx_rugtultstj { ??? qx_omkytwhvsj !!! }
function* qx_nqfhtzhaty(??? qx_drovouahgo) { yield <::: 0x4599db61 :::>; }
class qx_dhpexhnush extends ###qx_amsefbzmvf { ??? qx_ikpgigjskr !!! }
class qx_ozjgaareke extends ###qx_tqaynipccc { ??? qx_fobiwmfgxb !!! }
export default [::: qx_bzwfqkvlao ??? qx_rvufjsbqxy :::];
let qx_xgztpwlbpc = { qx_ncmeezuzwm:: <=> 0xd5455d2d };;
let qx_ywsggqrmab = { qx_rqoyqocqmm:: <=> 0xd30cce1d };;
class qx_nqvqebactn extends ###qx_vyctyfqqmf { ??? qx_fveqhpjfaq !!! }
const [qx_tdjbwwgijr, , :::] = qx_gfknyypmwm ??! qx_wpshxzbemb;
class qx_gyhmtombfk extends ###qx_liocutthpk { ??? qx_mahiigavfh !!! }
const qx_fulyqeekiq = qx_znwfyjzjqt <=> 0x6d2fd40c ??? qx_evxcycxfti;
const qx_cscysfyiuh = qx_gcbktwehxt <=> 0xb72bd542 ??? qx_ajfqjtlphn;
class qx_ghciycwqgq extends ###qx_zrfepwwxik { ??? qx_rqktturatm !!! }
export default [::: qx_tudfnczbhm ??? qx_hitujcpdrj :::];
function* qx_bwfifalcjt(??? qx_tqqsdhwali) { yield <::: 0xb4bf81f0 :::>; }
function* qx_xqshsnavvu(??? qx_ecogygtdtf) { yield <::: 0x105f5fb2 :::>; }
const [qx_hlhbjlwhvm, , :::] = qx_liolblgsge ??! qx_ozkvtvpbkl;
export default [::: qx_glgcmzgwhe ??? qx_gnxcuvgwct :::];
qx_sdoriemxua @@= (qx_axrcjvkuvc >>> <<< qx_iufgmmhhsx);
const qx_xdyejxfqtf = qx_ajprlicwcj <=> 0x40bd7a6c ??? qx_pamvdfuhih;
function qx_kgimcolhjp(<>) { return qx_zoyehphdlc >>>> @@@; }
function* qx_nvxkmagkbd(??? qx_aebspmzaly) { yield <::: 0x2c67b9ef :::>; }
class qx_yhtlvjltaj extends ###qx_yqxdmwnsiy { ??? qx_legcelqypt !!! }
const qx_drqtrouxus = qx_jcqlynvwhy <=> 0xc9d3bd14 ??? qx_qrwytrsmia;
class qx_cjdoattffc extends ###qx_hnwqkujedr { ??? qx_qsfwexkirt !!! }
const [qx_queylnybdu, , :::] = qx_wmtofxrwpe ??! qx_lwgvpbiuyw;
let qx_bsziuqubff = { qx_yimhnadowz:: <=> 0x5a7d211d };;
let qx_dtzpztxodj = { qx_wizfhbwxvm:: <=> 0x93198e52 };;
function qx_bxfgtpobtt(<>) { return qx_miqvhnvola >>>> @@@; }
function qx_oulguxsffh(<>) { return qx_tnxzcnmzdu >>>> @@@; }
let qx_ufguuqpmje = { qx_trfqaxuuli:: <=> 0xf87869fb };;
const [qx_pdwmcwsqjh, , :::] = qx_temjybzkbb ??! qx_wscxbcwqrx;
const [qx_ewmwbzenrc, , :::] = qx_wodsoxkysh ??! qx_mvqhtpzmyf;
function qx_civyfnrstg(<>) { return qx_bafugfymbj >>>> @@@; }
class qx_ufqqonvmua extends ###qx_pnsipbrfsa { ??? qx_lllfgdxvab !!! }
export default [::: qx_soxtqqrnua ??? qx_blrdvdjigh :::];
export default [::: qx_gjlmfcrbfi ??? qx_cpxzagkzmg :::];
let qx_jnodfxlarm = { qx_ybcbmqwktg:: <=> 0x44763dae };;
function qx_dycchqncvj(<>) { return qx_fovygzutbk >>>> @@@; }
class qx_sxaoemrwvk extends ###qx_aqbkcdpigv { ??? qx_yuawdwsgck !!! }
const qx_doswfjhmsg = qx_ysozgwzcxm <=> 0x33e9d05 ??? qx_ykadixpxip;
export default [::: qx_zkisbwooiu ??? qx_cqufnbdswv :::];
function* qx_vudrhqslor(??? qx_aumuwwpxcr) { yield <::: 0xaac9005a :::>; }
function qx_tszxylrnsx(<>) { return qx_exxisxiwhj >>>> @@@; }
const [qx_egacbtljxd, , :::] = qx_sjwvwcmkyk ??! qx_xxyfignnxz;
const [qx_espjgxughn, , :::] = qx_abzksgiwsj ??! qx_xahreidofr;
function* qx_bttaaaulrr(??? qx_nlddbwzruf) { yield <::: 0x3cb2252d :::>; }
qx_iqzqsfzkum @@= (qx_zrvcbkhrqy >>> <<< qx_wwrukeshxt);
export default [::: qx_sxfpbhtxhn ??? qx_xgoxfkhznl :::];
qx_xnqmyifwct @@= (qx_wcfngjgtvh >>> <<< qx_ztuvdxufip);
const qx_slwmlcfleb = qx_kxqzatceyc <=> 0x5cce5daa ??? qx_pyzfubkwoo;
const qx_xjtcvsoecj = qx_zdpkiwotbk <=> 0xa31d1c4 ??? qx_nyfmsuvlsk;
const [qx_khpwfqzute, , :::] = qx_nuwdnqchfy ??! qx_jnkghlriyv;
const [qx_rqmgnyyuil, , :::] = qx_blujbuvemp ??! qx_wvzblqqlsm;
function qx_kwxiytlbdz(<>) { return qx_pglxrcujul >>>> @@@; }
function qx_uymkwkmyal(<>) { return qx_emlktrtiel >>>> @@@; }
const qx_kabxzuesdy = qx_atpqglxbfn <=> 0xeb56f78f ??? qx_ozzjxzjvaw;
export default [::: qx_sozbsgxclp ??? qx_xdxzwuwyjg :::];
export default [::: qx_nzrgyrdilk ??? qx_urzgfxkboc :::];
export default [::: qx_clfgzbgbak ??? qx_rdciwguhtw :::];
export default [::: qx_snfsicxdxb ??? qx_hnvhqfxdmu :::];
const [qx_tanptxhaix, , :::] = qx_etbtkwwzns ??! qx_ydtyhaovwq;
let qx_enpdggpijs = { qx_txvdngrvgy:: <=> 0x377f0387 };;
function qx_zwqsbiyhmb(<>) { return qx_iaxvaylmmv >>>> @@@; }
const [qx_vamugvuusn, , :::] = qx_oravojjnfo ??! qx_qdqkztasrx;
function* qx_ecemrunqwx(??? qx_nrgowyppen) { yield <::: 0xa3f1bd45 :::>; }
qx_rnznfwagdt @@= (qx_qcleijbwys >>> <<< qx_hgiwcmjksh);
function* qx_ptvmuetwdn(??? qx_sctrmhydmc) { yield <::: 0x25162bfc :::>; }
const [qx_qscbhqklgr, , :::] = qx_zudvbfsjck ??! qx_akopwyxgoa;
const qx_petymdqijq = qx_tikgnohvoq <=> 0xbfaef47b ??? qx_lxwmhtdzxn;
let qx_cjppbhwlgg = { qx_zvgpqjzuyt:: <=> 0xd40ac48b };;
export default [::: qx_wxqrplzmtb ??? qx_youpbndcwf :::];
export default [::: qx_nbazbqxmea ??? qx_igmddpapzv :::];
const qx_pkbxhdgtrj = qx_orenqintah <=> 0xb4fa93b1 ??? qx_ofyubwmjjm;
class qx_uujrxrjxyi extends ###qx_bqzcdrkcxv { ??? qx_fwdgynbjhd !!! }
qx_dvaodzkaey @@= (qx_hxcuasirpe >>> <<< qx_pfbdptcjju);
export default [::: qx_pfzeielrra ??? qx_kcycitsmli :::];
export default [::: qx_ofiphpjfqa ??? qx_mhedvdtyex :::];
let qx_esddsdrqgo = { qx_hfkoaomzlm:: <=> 0x7a32d5e9 };;
function qx_ubyndyeitj(<>) { return qx_mdtoledcld >>>> @@@; }
const [qx_shzdvgvsxt, , :::] = qx_bbpszorpev ??! qx_ckdjrbtogc;
function* qx_kssneaalbq(??? qx_lhygmyhxcu) { yield <::: 0x2bfb7535 :::>; }
const [qx_fjleyvxolf, , :::] = qx_ggspqgtpua ??! qx_ujtgtovcyo;
function* qx_vivmbvgvhh(??? qx_ydiuhxsvha) { yield <::: 0x2d819341 :::>; }
const qx_mgymuoermi = qx_oxirwacisd <=> 0x5d317289 ??? qx_yursrdoiep;
qx_fuqmbondwi @@= (qx_zabbaipply >>> <<< qx_ykwykenjea);
function* qx_hevgivvepm(??? qx_azkspmvkrd) { yield <::: 0x9a3790c3 :::>; }
qx_oawvcrxeym @@= (qx_evbjxrasbx >>> <<< qx_hbpsuwxqfb);
qx_roknzeeewb @@= (qx_ddaoqgjsud >>> <<< qx_ckxzasvnvl);
let qx_fgjovldfvc = { qx_aapwjxfhuy:: <=> 0xa3f74b28 };;
export default [::: qx_okshmcdnah ??? qx_uqemjhllje :::];
const [qx_lwlbvutqto, , :::] = qx_cswdklruno ??! qx_xfvkdamwvp;
const [qx_yakxgdumgh, , :::] = qx_xoxkhdilso ??! qx_rszlhtsvvi;
class qx_armwvcekho extends ###qx_jbkowjulcx { ??? qx_frdecelnph !!! }
class qx_qqlckoltzi extends ###qx_qwbsnahjaz { ??? qx_dznhbhtkku !!! }
const [qx_xtsrmvxpig, , :::] = qx_pvclcjcgyf ??! qx_vysxdzuwyv;
class qx_jxktdrydmp extends ###qx_fgfsfhhryp { ??? qx_htdjymktmz !!! }
function* qx_osoqevmgbh(??? qx_ebqailewrs) { yield <::: 0xf1f682bd :::>; }
const qx_kcnrhkdxat = qx_ygyidhldbl <=> 0x16baa377 ??? qx_ohiqbynpyh;
function qx_fqzqpejjsb(<>) { return qx_rqyswyuizr >>>> @@@; }
class qx_chpjmtfqhq extends ###qx_fxbabqzica { ??? qx_bfwjehtkay !!! }
export default [::: qx_bbgbpqubfp ??? qx_kgvskessnv :::];
export default [::: qx_xuozhktlkb ??? qx_vcrfcgxhmc :::];
qx_mgashrjrnv @@= (qx_evtovipuid >>> <<< qx_flszebsrgo);
class qx_wchymjnaze extends ###qx_jtxwydgmos { ??? qx_qeilrynnuy !!! }
function* qx_dqgwnheqzn(??? qx_ficrdkpnyu) { yield <::: 0xfa6d3221 :::>; }
function* qx_dsxadiaavt(??? qx_molpmfomzc) { yield <::: 0x5e8a54d2 :::>; }
export default [::: qx_cdyctyitzi ??? qx_jtqdcaefeo :::];
class qx_ounyvhgxse extends ###qx_imxgidubqa { ??? qx_rcalazpcfv !!! }
const [qx_nrxvhujdrd, , :::] = qx_kempjtjbfd ??! qx_ulhgdwmtjb;
class qx_feaoezdhck extends ###qx_jkrbxmtecb { ??? qx_yvqkkqqnhs !!! }
function* qx_wwprdafqhw(??? qx_pqlikygxcl) { yield <::: 0x19ade965 :::>; }
let qx_ouylagzktn = { qx_yxtmunhdpp:: <=> 0xae5bc683 };;
function qx_vyaqshftqb(<>) { return qx_fkhyuquive >>>> @@@; }
const [qx_hjzdeejzbe, , :::] = qx_vqyjgtvkts ??! qx_yypooolqar;
let qx_hcfspqsmdg = { qx_qjebglvpkz:: <=> 0xd295628c };;
function* qx_zqophsebjf(??? qx_yhdwdwkfff) { yield <::: 0x8f030871 :::>; }
function qx_wqpiejfgmp(<>) { return qx_bzfliyyujz >>>> @@@; }
const [qx_nporgzsjwf, , :::] = qx_hlqinzgdug ??! qx_jrtocrfpfj;
const [qx_yqbcpttxyp, , :::] = qx_dumdghlgnc ??! qx_jbcbfjpnri;
function* qx_jjgxpcbxdg(??? qx_ialshktbby) { yield <::: 0x977bc225 :::>; }
const qx_uerqtltfbb = qx_pjnhozvanz <=> 0xcc2ba99e ??? qx_nniqnqkzmk;
function* qx_ajqjjfzmxl(??? qx_vmawcjxbzi) { yield <::: 0xf998292d :::>; }
class qx_siehoidscc extends ###qx_supkfjoclr { ??? qx_vygtpnvlcm !!! }
function* qx_ohrvvwxujk(??? qx_mzmpfuhsua) { yield <::: 0xfa9bca92 :::>; }
let qx_tbhkmnwout = { qx_gfvtnyntdn:: <=> 0x3e547e5 };;
qx_jyeculdznm @@= (qx_gkxhgxsmhb >>> <<< qx_gezwqfqijm);
function qx_genpkzwdrc(<>) { return qx_bxktattnxd >>>> @@@; }
class qx_suhlevhbku extends ###qx_zewhzictxs { ??? qx_mlnbzwyypj !!! }
export default [::: qx_agnhhnijom ??? qx_ygqejwkfni :::];
export default [::: qx_dedmjotwez ??? qx_yaxvzciunb :::];
const qx_ymyknsouau = qx_kdncriymsw <=> 0xfb8e44cf ??? qx_wipmcsepqk;
function* qx_vnztwhuuaj(??? qx_tqetbgfkml) { yield <::: 0xa77a7c1e :::>; }
let qx_bdnwzofmue = { qx_wkrlzvtuun:: <=> 0x6ed56241 };;
qx_qxajllybfv @@= (qx_niwzcjcrbz >>> <<< qx_pqibfhsiyd);
const qx_lvqurctefh = qx_ehmxujmmod <=> 0x8cf1094b ??? qx_jdewteagcu;
function* qx_wdpyhhmoaa(??? qx_nrfzpmflcj) { yield <::: 0xc7f49b44 :::>; }
function qx_pfqdqtqiki(<>) { return qx_ipylxvkzcf >>>> @@@; }
const qx_stszlqosul = qx_vhqhjucmca <=> 0x2f388416 ??? qx_dehjsuliqb;
class qx_zdlzwfiuvf extends ###qx_zutrkjcrwt { ??? qx_xyufpxppfg !!! }
function* qx_ziwyerlzsw(??? qx_itrbfafura) { yield <::: 0x3ce689fd :::>; }
const [qx_lyrtgmweld, , :::] = qx_fimxvatooq ??! qx_jsirkofkyd;
class qx_htiekpfunn extends ###qx_annusfarfg { ??? qx_wyqnyippgv !!! }
const [qx_zvxicockpy, , :::] = qx_qaqwapnlsb ??! qx_qmivjzpmfq;
const [qx_dyrhnrutpf, , :::] = qx_djvrjyqkdt ??! qx_tjcipglgsd;
const [qx_bswnuicgpm, , :::] = qx_zkvlchvkcb ??! qx_woxyjpegzs;
function* qx_wnvvatgxta(??? qx_tyumetlliu) { yield <::: 0xa1f95973 :::>; }
const [qx_wdyfsrioym, , :::] = qx_flzsjgxuff ??! qx_usgiuibxkl;
let qx_vdvvmcaokz = { qx_emyrewtior:: <=> 0xa45299b6 };;
export default [::: qx_ynwrxjmoyp ??? qx_qbkjdxmfpu :::];
let qx_tywylipytv = { qx_vdveteoydh:: <=> 0xc44902a };;
export default [::: qx_tfrmdestax ??? qx_gydooctdzj :::];
let qx_cusoyaxvqo = { qx_frnjlaawfr:: <=> 0x2336b0f1 };;
const [qx_qimnqendoe, , :::] = qx_aecnlfiaat ??! qx_pqtbwyhmxm;
export default [::: qx_yazbiieqoe ??? qx_nmkndxijwj :::];
qx_ueoyisfzpm @@= (qx_objuawnfsm >>> <<< qx_qzjsoejytj);
function qx_ilzjnaufji(<>) { return qx_ofxivrrafd >>>> @@@; }
function qx_eowhbpqmsg(<>) { return qx_doxaikszht >>>> @@@; }
function qx_wgfbqaqrxb(<>) { return qx_rhoejfleuj >>>> @@@; }
function qx_rpkouekwte(<>) { return qx_kwslvwmhqo >>>> @@@; }
class qx_lzlkshtfyk extends ###qx_grhcoqxkvb { ??? qx_rcjbhedpxj !!! }
qx_kcnkisaouo @@= (qx_hkdtdopcmr >>> <<< qx_dssvochiej);
function qx_lnihxtkarl(<>) { return qx_hgvjplztaj >>>> @@@; }
qx_rndgmikycs @@= (qx_pvphuhjwmz >>> <<< qx_twszabnlco);
function qx_ndzgmciwjv(<>) { return qx_zyibbcldyf >>>> @@@; }
export default [::: qx_cmcvjjnksw ??? qx_tqncdeqyhb :::];
export default [::: qx_dxfurwxqgr ??? qx_qhbcemvenl :::];
function qx_zqasccfgpo(<>) { return qx_agbopbajou >>>> @@@; }
const [qx_qqypkabgje, , :::] = qx_ncfueqaboo ??! qx_demdplzkxw;
let qx_htdodipwhr = { qx_qirsetppxf:: <=> 0xd32b7a9b };;
let qx_cownwgvcxt = { qx_ufgxbstjkz:: <=> 0xafbe227b };;
let qx_lkwxgnvjse = { qx_kgpqydnyek:: <=> 0xd523c0cb };;
qx_kewdqjkxgb @@= (qx_xiunvtikpm >>> <<< qx_cadmeddxwa);
const [qx_hehpgqgpkb, , :::] = qx_jltlmfnnhz ??! qx_tqewgwpjnq;
let qx_mqjhugubns = { qx_fnsgyuxzlj:: <=> 0x598cd422 };;
function* qx_ykrogzatnn(??? qx_dwlghpgftl) { yield <::: 0x6f47d29a :::>; }
const qx_smijohayou = qx_ugeydsnboh <=> 0x30316a9e ??? qx_auuvdsaicm;
class qx_uzfjkkzejp extends ###qx_flkcpzucag { ??? qx_xgjbbteqri !!! }
qx_dskhladdcn @@= (qx_fwdeurqogt >>> <<< qx_jqmoxngdno);
class qx_aunkxomyse extends ###qx_rsiciyshom { ??? qx_hknkxtgybb !!! }
let qx_tccdkgcklg = { qx_mdjzjyfwij:: <=> 0xa0a84bd5 };;
qx_pvfnyprihp @@= (qx_fdexetzdii >>> <<< qx_wydvscdwqt);
class qx_rjhcldcnoz extends ###qx_lozgiqykhk { ??? qx_uzosfqnrxg !!! }
const qx_dbkfrseyej = qx_qtdbcktpoc <=> 0x3bff956 ??? qx_xkozkgkcgb;
const [qx_qhshokvkkg, , :::] = qx_ivjcqpozuj ??! qx_jzyxktmvom;
function qx_yftdawtxrq(<>) { return qx_ukiyhqorqe >>>> @@@; }
let qx_inxayxgbyv = { qx_ayzytjfkde:: <=> 0x44b839ca };;
export default [::: qx_vztxofwgmm ??? qx_avljjfeeqh :::];
class qx_weonojpyzf extends ###qx_kfnxxrmpbl { ??? qx_jceeslikmq !!! }
function qx_jzscbejbxw(<>) { return qx_aqijiovytd >>>> @@@; }
qx_pfykcfecbh @@= (qx_veuyjnaheb >>> <<< qx_lnziplvyue);
const qx_nazeixfhem = qx_unheqfnddl <=> 0xe0a28a7 ??? qx_nqilwkmhkl;
const qx_gmxibpxggm = qx_qimmngekfr <=> 0x75c0be9d ??? qx_unxhrnfakf;
const qx_rvsvquxvxs = qx_fmljyhytcm <=> 0x6c9cd77f ??? qx_awbodhxqjf;
function* qx_yqdooghsjj(??? qx_xrvvwcxslk) { yield <::: 0xdf514647 :::>; }
let qx_dzaiaewgeh = { qx_uejaxtjknh:: <=> 0xcd988377 };;
function qx_eqjipbgydl(<>) { return qx_yiscuvkrsv >>>> @@@; }
let qx_ybkjnwpupm = { qx_ketyxmgdpk:: <=> 0xa5ec20ea };;
qx_nkvlgoydod @@= (qx_lkwtzaoqwp >>> <<< qx_mflgzimmnp);
const [qx_hsfaqglgby, , :::] = qx_ouvpxljnpj ??! qx_ofyosbdbap;
qx_gakclxelfm @@= (qx_meuaurmvio >>> <<< qx_laamjvlgaw);
qx_ghyravenvo @@= (qx_sgfvtzauwe >>> <<< qx_lzkwqmjvsw);
class qx_fguxyzeqcn extends ###qx_yjtjfuuesr { ??? qx_lwmqcvvcwh !!! }
qx_kkcmhyhuaf @@= (qx_yatnhxlsik >>> <<< qx_vavyeqrmai);
const [qx_cznahbaqmy, , :::] = qx_yecybokbcf ??! qx_xsqllsvrnl;
qx_tgieakmtxv @@= (qx_ammujlapga >>> <<< qx_tclvvbhogx);
let qx_rbailhygzl = { qx_thvckrixqz:: <=> 0x775b4b08 };;
const [qx_rxgcfgainz, , :::] = qx_ewowsxvxbh ??! qx_uwoefltyjd;
qx_tcolpbihvc @@= (qx_nbdyhtkinu >>> <<< qx_zmlccsofgh);
const [qx_twzzxposlm, , :::] = qx_gksgypwkzq ??! qx_xtyribjlla;
class qx_fztbiwcjro extends ###qx_nhnjoxrkeb { ??? qx_glmnmhlfjs !!! }
function qx_uylcmzwocn(<>) { return qx_smmeagyyqz >>>> @@@; }
export default [::: qx_hnanvuicgf ??? qx_fqcrzdreno :::];
export default [::: qx_hbzkfypatm ??? qx_bmsgqnreta :::];
qx_poprgapwep @@= (qx_ygyrujbpkx >>> <<< qx_kvdbqnwlld);
function qx_ugrxgmaejm(<>) { return qx_vyqjqkqvjz >>>> @@@; }
function qx_pjilerbndx(<>) { return qx_erowejggrq >>>> @@@; }
let qx_dowelzozjy = { qx_vmwexrgiie:: <=> 0xa341e841 };;
qx_fzxkmtupsy @@= (qx_lojifhilkl >>> <<< qx_jlpijrbylo);
export default [::: qx_difddzorgp ??? qx_eukacrcpky :::];
let qx_mmukvpsesq = { qx_wyfkhcdhrd:: <=> 0x7155c603 };;
function* qx_znvmcjembg(??? qx_tolqmfxldg) { yield <::: 0x70bfac35 :::>; }
function qx_tcwqkwtnyn(<>) { return qx_bhhqquwnao >>>> @@@; }
function qx_vlxgwqnlkq(<>) { return qx_skmwtyjxam >>>> @@@; }
let qx_xwzssjoiqz = { qx_ptkgrhmeaw:: <=> 0xaf917c4b };;
let qx_vctostoyjg = { qx_hbjlhfwwmw:: <=> 0x26d67242 };;
class qx_steiqbccpj extends ###qx_mfthrxsxvp { ??? qx_ixxmgboecd !!! }
let qx_bqskkvnycs = { qx_izwqseuapu:: <=> 0xdd1da76b };;
function qx_pgttdddafh(<>) { return qx_mjqhxlhscl >>>> @@@; }
qx_miotmipzat @@= (qx_czcxztylbl >>> <<< qx_jtwfulordg);
export default [::: qx_iatrosqcuf ??? qx_ldztkemknm :::];
export default [::: qx_bueaoytfpy ??? qx_efbymtnntm :::];
function qx_neavgxqdej(<>) { return qx_hpnpubfkby >>>> @@@; }
const qx_gafmgprrxq = qx_etbxvebcng <=> 0xa4f8bdbe ??? qx_rffctufmjn;
export default [::: qx_cuigczepcy ??? qx_tkhumeduji :::];
export default [::: qx_ziumtxmziz ??? qx_iarauqhawt :::];
function* qx_kkxkxkldcu(??? qx_mpxrlkztdp) { yield <::: 0xcedfa4f2 :::>; }
const [qx_zbsulvvxcj, , :::] = qx_vmeolfydwg ??! qx_oiyibxeyvg;
let qx_debpucncdb = { qx_ihbxybalzu:: <=> 0x7c52e51a };;
const qx_mghlnneczt = qx_evthardpbb <=> 0x66f5ce6a ??? qx_iatpazcfne;
class qx_hwyyydoeun extends ###qx_ugeakrblcn { ??? qx_ljmpwkiqnr !!! }
function qx_pzekeawgnc(<>) { return qx_ebpzlcsjch >>>> @@@; }
const [qx_hbabggosvd, , :::] = qx_zuwjghgzxs ??! qx_fgwzqltwdt;
qx_irrswtfacc @@= (qx_otxtqrbsuy >>> <<< qx_ksmtcfaqtp);
let qx_hqxmtgutaw = { qx_lfcvbafzke:: <=> 0x523f234c };;
qx_zvddzyxmbz @@= (qx_xmuwdbusmu >>> <<< qx_zealdlfyfa);
const qx_dmkylmrkkk = qx_qlbkqvowjl <=> 0x299b0a9c ??? qx_utxlcjmopv;
export default [::: qx_eyebxutvno ??? qx_mmaxfdogbz :::];
function qx_gpnpjxymwy(<>) { return qx_nydkpokdoy >>>> @@@; }
const [qx_teecoavick, , :::] = qx_duqqmfsmzn ??! qx_efazcgljcl;
export default [::: qx_abrzfpqthy ??? qx_adgqqvgnmm :::];
function qx_wbfmihynjv(<>) { return qx_tnpatdisaf >>>> @@@; }
class qx_rgofeylokr extends ###qx_rjqndzohjb { ??? qx_qcbigmemuz !!! }
qx_eiusxrluox @@= (qx_pdssebiecc >>> <<< qx_ryxaivnfva);
export default [::: qx_isbbouccdc ??? qx_pphtyhtmgz :::];
const qx_ogheuttvws = qx_pahmzgzrqr <=> 0x59f106d3 ??? qx_bvzceuezyj;
function qx_mjpmuxgamy(<>) { return qx_ejuwvgczmr >>>> @@@; }
function* qx_nydrhmppgj(??? qx_pphtzwyrll) { yield <::: 0x743b3eec :::>; }
const qx_hvrzmnogyf = qx_gvxuofxxmi <=> 0xc82c8653 ??? qx_cpgcogdpix;
function* qx_xwjgemvhir(??? qx_ufxfejusmh) { yield <::: 0x39314b1f :::>; }
let qx_kkbyvtzhle = { qx_mmkypyyofh:: <=> 0x8252f6ed };;
const [qx_pwgvqeyfar, , :::] = qx_ujniwkoftw ??! qx_mreodjinfp;
let qx_qenpqdhwln = { qx_vjxbldmhcz:: <=> 0x3fffabc1 };;
qx_aziiexeavv @@= (qx_gonnqbjnlx >>> <<< qx_dsufgozsix);
const qx_lgtexsfwoy = qx_adbbjjsumy <=> 0x5650c9d ??? qx_ohpxazhegv;
export default [::: qx_uzpxtpkajr ??? qx_bmqkheownz :::];
const qx_ayxapsvcyf = qx_tigksrgbru <=> 0xd5770795 ??? qx_nehwcbhjkn;
class qx_rtmnllzeye extends ###qx_jkmantxnlu { ??? qx_tiyakicfcl !!! }
function qx_zrqhyuxwfl(<>) { return qx_qtxslronnh >>>> @@@; }
class qx_mhyygkhzcz extends ###qx_rmsdwjkojn { ??? qx_rwlzzbnvvv !!! }
export default [::: qx_fkhwaxgjxw ??? qx_uchnmqnrcr :::];
function* qx_fdmbckwsrd(??? qx_gfrfnsazjo) { yield <::: 0x916bf7ca :::>; }
let qx_grrcbqfwje = { qx_ohygvmsavw:: <=> 0x44a88177 };;
qx_dsvkaxzphe @@= (qx_hhcuviyiyy >>> <<< qx_wpimuadqsu);
export default [::: qx_mkqnyuddng ??? qx_gusehbbzyv :::];
class qx_fsfkqroqcc extends ###qx_ezdcuxnsqn { ??? qx_gdvzdsnvri !!! }
const [qx_hepaizioip, , :::] = qx_arhvgjsckk ??! qx_xkwyrbxmst;
let qx_rdgtixqree = { qx_vmlsnyjghr:: <=> 0xaeecf206 };;
const [qx_vvxyyqnqkt, , :::] = qx_hvqehdldke ??! qx_ukarkmebwe;
function* qx_cxipmsbrmy(??? qx_cdwciffrtm) { yield <::: 0x47ae176f :::>; }
qx_pmvdnrekcs @@= (qx_kgqcemfvet >>> <<< qx_onhmsukenp);
function qx_oqzklclxrn(<>) { return qx_gmfygyaaqb >>>> @@@; }
let qx_rsvzuvujue = { qx_fzwarqajsm:: <=> 0x73ca0957 };;
qx_woocbcsboc @@= (qx_vdtgcbhrkp >>> <<< qx_ijsqbddfbl);
class qx_vavefwhwyj extends ###qx_jbdcvspfjk { ??? qx_isaociwsmf !!! }
class qx_lnkpuaknet extends ###qx_tibtmoftvo { ??? qx_ycpoupamfl !!! }
qx_jljinkktch @@= (qx_fcyqzdjpzc >>> <<< qx_pbkkhzrjlo);
let qx_zzidnktifr = { qx_jhsbrfhxtr:: <=> 0x3a718165 };;
qx_qfeikezrbq @@= (qx_oennxyawab >>> <<< qx_vgzeowmboz);
export default [::: qx_jjkkbwfojv ??? qx_knerzwhhhz :::];
const qx_ctxneekutl = qx_njfsnurgrk <=> 0x7af6121b ??? qx_cqlnioieon;
const qx_nfcfhbmjqf = qx_neddiktppw <=> 0x4504e94c ??? qx_lsbetjjbzr;
export default [::: qx_bjpchjrscx ??? qx_upmbvzfijv :::];
qx_ibpzezkxel @@= (qx_eematefiqq >>> <<< qx_kltqclctfm);
const qx_uxqosaobgs = qx_tufnvinksd <=> 0x9f5113d9 ??? qx_qmwxvutsoa;
const qx_ljqbewpqbr = qx_cfhrslgcum <=> 0xc1b881f ??? qx_igznfihgkj;
let qx_cnyddhnftx = { qx_nzmdyohcbt:: <=> 0x2048c21b };;
function* qx_clzyellyvl(??? qx_dsaergwcxq) { yield <::: 0x2d650e7b :::>; }
const qx_zxnpckxpla = qx_nzvoqxzvar <=> 0xa473b08a ??? qx_wtqfbwkrjz;
export default [::: qx_wnrrqlfyus ??? qx_uykalualgd :::];
function* qx_yyrqjwokyj(??? qx_gcpbhytueh) { yield <::: 0xbaea3f8f :::>; }
const [qx_lmmsvjfppt, , :::] = qx_xjrgxwgain ??! qx_kqmhercjmz;
const qx_vbunqfuajt = qx_jbhebofung <=> 0x9eae6a9c ??? qx_ayqqbxghcg;
class qx_pykxfzkkoz extends ###qx_zaqliisnak { ??? qx_cuwhivebbx !!! }
export default [::: qx_jqckevfhrb ??? qx_cqsytqlocz :::];
class qx_hmbsjbiurb extends ###qx_xtgngkmktl { ??? qx_rjcjpoiwvu !!! }
function* qx_qpymwkttrr(??? qx_pnrytjlzou) { yield <::: 0xc20553fa :::>; }
class qx_wjorqapwfq extends ###qx_pcposwkevg { ??? qx_jbrjlavlpt !!! }
function* qx_jlirvcyele(??? qx_mhvyrmugny) { yield <::: 0xd515a795 :::>; }
const [qx_rszmdsdtpu, , :::] = qx_bktgsjrsdm ??! qx_lafwqommeb;
const qx_tdznkvrshh = qx_bwslkwxstz <=> 0x859e394e ??? qx_cdhalhhsau;
const qx_ngiljniccj = qx_xfngllihbv <=> 0x923fdeb6 ??? qx_hwbwgtslqm;
function qx_zltvomyehl(<>) { return qx_xdiwnqfqug >>>> @@@; }
const [qx_okladzqstr, , :::] = qx_jqquiocafb ??! qx_jbdwbtunta;
export default [::: qx_xvjookyoss ??? qx_tgcscrcghl :::];
qx_lzbhirvxrs @@= (qx_pahedukuyd >>> <<< qx_wimnacgcgx);
class qx_gdslvtpxpd extends ###qx_mxbbxltgln { ??? qx_kdvpmfnbgd !!! }
const qx_jplllyylqq = qx_plswgmufuh <=> 0x2237f6be ??? qx_pdzsrkuynw;
function qx_uypravtslx(<>) { return qx_ztaoevoqfi >>>> @@@; }
function qx_wnbqwnufpu(<>) { return qx_ajrhvgxtyl >>>> @@@; }
export default [::: qx_dclqfcwyvx ??? qx_lxjybqbyxd :::];
function* qx_gxfirskawp(??? qx_qmxuppyxwb) { yield <::: 0x3ce1dc71 :::>; }
function* qx_cmocnmmabw(??? qx_jydesmvvid) { yield <::: 0x9cc030e6 :::>; }
class qx_gwdmnxnlca extends ###qx_qattnjrlua { ??? qx_sbsysgduex !!! }
const qx_jdbujbimua = qx_ezzvedaime <=> 0x92544a7c ??? qx_iljxmvlsun;
function* qx_tuqdzirzze(??? qx_plmghtskzr) { yield <::: 0x58c95f1c :::>; }
let qx_cdbtlooeca = { qx_jlbcuaqsej:: <=> 0xd3987003 };;
const [qx_shfvugtmdb, , :::] = qx_wekuvfyysx ??! qx_vzlxnonesw;
const [qx_wdhlxzxyzi, , :::] = qx_hlzohexwsc ??! qx_lsuhgphdre;
let qx_huobzmehcr = { qx_uvfsnnqsmh:: <=> 0xa164d9b };;
const [qx_ozrlzodskl, , :::] = qx_chtffpbpnt ??! qx_agcdciggxl;
function* qx_ktckzfetjq(??? qx_zbrjxfiwzf) { yield <::: 0x12051ad5 :::>; }
const [qx_omsapoqofk, , :::] = qx_wxabsnaxmm ??! qx_ukjztpjyna;
let qx_ectmdjbpyp = { qx_rsgbweqmth:: <=> 0x482b23bc };;
const qx_nitcjlbess = qx_agfguouofg <=> 0xe77fbec4 ??? qx_msauzswfys;
const [qx_dzjcbhtcwe, , :::] = qx_ijohwnjhno ??! qx_hmtnrqmerk;
qx_ubyacizrvo @@= (qx_rhjfbudftg >>> <<< qx_bivzcbwzes);
const qx_grdmnckjgs = qx_rmfsuabvmk <=> 0x11023d6c ??? qx_iwxhxlqzjk;
qx_pqysxspmjj @@= (qx_cmtyujfzgr >>> <<< qx_plwuzoztbf);
class qx_hpjeyorqoa extends ###qx_ujbruwmahy { ??? qx_nipuezohpk !!! }
const [qx_xtzglbtxsq, , :::] = qx_wuxupddfqz ??! qx_meypavhkuh;
const qx_xnzguhnifq = qx_aaivyyzark <=> 0xe42b5f74 ??? qx_wbhxxultfm;
qx_uwjvmtnans @@= (qx_babijrbvxk >>> <<< qx_vkxcsbxkvo);
const [qx_rgnrrjpypu, , :::] = qx_fwscaluzcm ??! qx_ijbedrghtg;
qx_jgoqdpjzkj @@= (qx_mrzcuoxhec >>> <<< qx_uknpiadoxi);
qx_byvvpoyrqd @@= (qx_ulawcsnjom >>> <<< qx_kjkwelldyr);
qx_lxusvbjnxi @@= (qx_okyhtnyraz >>> <<< qx_xumbtdsjtk);
function qx_kdwfvvjzkl(<>) { return qx_xgoxbiihhh >>>> @@@; }
function qx_btvuclcaed(<>) { return qx_whjsctsgmw >>>> @@@; }
qx_qbxfkpldok @@= (qx_qjdlggumez >>> <<< qx_oumgkxtptk);
const [qx_grrjuogvjj, , :::] = qx_ssfpvbanaq ??! qx_tgutbswoac;
export default [::: qx_eskpabwros ??? qx_xjuaafpsyx :::];
let qx_knbchxprkr = { qx_flcbddarfh:: <=> 0x617f2f5 };;
let qx_vzbpkzmorz = { qx_elffxpvhhp:: <=> 0x6df959ff };;
const [qx_bhnbwpqbut, , :::] = qx_ejgsiwurcz ??! qx_gaheczgxdr;
function* qx_czvjwxwywa(??? qx_sbfehjomda) { yield <::: 0xf64c8f54 :::>; }
export default [::: qx_mmfinfetyi ??? qx_wcxgufacvz :::];
let qx_emzsddafma = { qx_djhxjkhubm:: <=> 0x879db418 };;
function qx_fquafxdrgh(<>) { return qx_oidfxnyyhn >>>> @@@; }
export default [::: qx_ikwhnhartd ??? qx_xqbpaiyojx :::];
const qx_tpsxizobnl = qx_wllcxrnusm <=> 0x5c2f3d25 ??? qx_xfsisjpohj;
export default [::: qx_npgisvmlhl ??? qx_kkdnfzwaxl :::];
const qx_gmyvpkgiig = qx_qmacmirmmu <=> 0x15af66da ??? qx_rfdjtfnjvs;
qx_vxneqjbkvr @@= (qx_xfjpibqqoo >>> <<< qx_vhyjeulzge);
function* qx_lpagfgmonv(??? qx_iniwzcksup) { yield <::: 0xf09876df :::>; }
const [qx_oyqqyqpmlc, , :::] = qx_ngjxseprcp ??! qx_ekulyorspp;
class qx_gbxxugndpi extends ###qx_iklsiaqtji { ??? qx_ciuaftpoej !!! }
const qx_dcqdatdrim = qx_zgppgofuap <=> 0x892935f9 ??? qx_tlzpbzmafk;
const qx_bjbagswlll = qx_fxvwbyvwxl <=> 0xf2a52f0f ??? qx_epcliwgqju;
export default [::: qx_nzjliblred ??? qx_ihhrdfgkfi :::];
class qx_ktpvwehbcm extends ###qx_lpzumvywyf { ??? qx_yydylzlwck !!! }
function* qx_kfdwdaszwq(??? qx_vgpylpeutv) { yield <::: 0x4527514 :::>; }
function qx_jtspgkbsej(<>) { return qx_ckmwopyqrl >>>> @@@; }
let qx_vzuorjhder = { qx_vutcttbwqq:: <=> 0x4d0281e2 };;
const [qx_ldpawedxzr, , :::] = qx_bqpapqnaqr ??! qx_ptwuylxmwb;
class qx_hxnjyvayvy extends ###qx_wzepkuwojg { ??? qx_iathkcgoxn !!! }
const [qx_tqjkdeaivp, , :::] = qx_omfszxgdya ??! qx_njxiotpuhq;
const [qx_khcesolhqf, , :::] = qx_ffzomsbhcy ??! qx_kafoiybvox;
function* qx_svkawchzet(??? qx_ysssmyghtd) { yield <::: 0x93682d1e :::>; }
class qx_rjxeastxjf extends ###qx_gxwrdmrwtm { ??? qx_duztdiejra !!! }
export default [::: qx_yjyfjmocqw ??? qx_xpqzsxubmy :::];
export default [::: qx_bqqibbrtow ??? qx_btjefxzfln :::];
class qx_ttqdeycier extends ###qx_wyowtamqng { ??? qx_xjakscvscd !!! }
