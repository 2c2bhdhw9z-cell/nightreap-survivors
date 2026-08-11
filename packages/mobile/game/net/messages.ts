/**
 * Encode/decode for every message type. The only file that knows byte layouts beyond the header.
 *
 * SHAPE OF THE API
 * Encoders take a `Writer` and primitive arguments and return the finished view — no intermediate
 * objects. Decoders take a `Reader` and write into caller-owned structs or typed arrays, so the
 * receive path allocates nothing per message either. Anything that returns a fresh object (HELLO,
 * WELCOME) happens once per session, not per tick.
 *
 * ADDING A MESSAGE
 * Append to `MSG` in protocol.ts, add an encode/decode pair here, bump `PROTOCOL_VERSION`. Never
 * change an existing layout in place — old builds will read it as garbage and the mismatch will look
 * like a desync bug rather than a version problem.
 */

import type { Reader, Writer } from "./codec";
import { INPUT_FRAME_BYTES } from "./input";
import {
  CORRECTION_ENTITY_BYTES,
  MAX_PLAYERS,
  MSG,
  PROTOCOL_VERSION,
} from "./protocol";

/* ---------------------------------------------------------------------------------------------- */
/* HELLO / WELCOME — session setup                                                                 */
/* ---------------------------------------------------------------------------------------------- */

export interface Hello {
  version: number;
  /** Build hash, so a room can refuse mixed builds even when the protocol version matches. */
  buildId: number;
  name: string;
  /** Client capability bits, for feature negotiation without another protocol bump. */
  capabilities: number;
}

export function encodeHello(w: Writer, buildId: number, name: string, capabilities: number): Uint8Array {
  w.begin(MSG.HELLO, 0).u16(PROTOCOL_VERSION).u32(buildId).u32(capabilities).str(name);
  return w.finish();
}

export function decodeHello(r: Reader, out: Hello): Hello {
  out.version = r.u16();
  out.buildId = r.u32();
  out.capabilities = r.u32();
  out.name = r.str();
  return out;
}

export interface Welcome {
  slot: number;
  playerCount: number;
  /** Run seed. Everything random in the run derives from this via named RNG streams. */
  seed: number;
  /**
   * Taint bitfield, carried here as well as in the run seed header so a guest knows immediately that
   * the host has touched dev toggles. A guest that cares about its ladder standing can leave.
   */
  tainted: number;
  /** Stage id and the modifier stack, as content ids resolved against the same versioned data. */
  stageId: number;
  modifierCount: number;
  modifiers: Int32Array;
  /** Host's current tick, so a joining guest can start close rather than from zero. */
  tick: number;
}

/** Modifier stack ceiling on the wire. Generous — the sim itself imposes no limit. */
export const MAX_WIRE_MODIFIERS = 32;

export function encodeWelcome(
  w: Writer,
  slot: number,
  playerCount: number,
  seed: number,
  tainted: number,
  stageId: number,
  modifiers: Int32Array,
  modifierCount: number,
  tick: number,
): Uint8Array {
  const n = modifierCount > MAX_WIRE_MODIFIERS ? MAX_WIRE_MODIFIERS : modifierCount;
  w.begin(MSG.WELCOME, slot)
    .u8(slot)
    .u8(playerCount)
    .u32(seed)
    .u32(tainted)
    .u16(stageId)
    .u32(tick)
    .u8(n);
  for (let i = 0; i < n; i++) w.i32(modifiers[i] as number);
  return w.finish();
}

export function decodeWelcome(r: Reader, out: Welcome): Welcome {
  out.slot = r.u8();
  out.playerCount = r.u8();
  out.seed = r.u32();
  out.tainted = r.u32();
  out.stageId = r.u16();
  out.tick = r.u32();
  const n = r.u8();
  out.modifierCount = n > MAX_WIRE_MODIFIERS ? MAX_WIRE_MODIFIERS : n;
  for (let i = 0; i < out.modifierCount; i++) out.modifiers[i] = r.i32();
  return out;
}

export function createWelcome(): Welcome {
  return {
    slot: 0,
    playerCount: 0,
    seed: 0,
    tainted: 0,
    stageId: 0,
    modifierCount: 0,
    modifiers: new Int32Array(MAX_WIRE_MODIFIERS),
    tick: 0,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* INPUT_BATCH — the only thing a guest authors                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A run of consecutive input frames.
 *
 * `firstTick` plus a count, not a tick per frame, because the frames are always consecutive — a gap
 * is filled by prediction on the receiving side rather than transmitted as a hole. That halves the
 * per-frame cost to the 4 bytes that actually vary.
 *
 * On the wire: `u32 firstTick, u8 count, u8 slot`, then `count` × (i8 x, i8 y, u8 buttons, u8 flags).
 */
export const INPUT_BATCH_HEADER_BYTES = 6;
export const INPUT_BATCH_FRAME_BYTES = 4;

export function encodeInputBatch(
  w: Writer,
  slot: number,
  firstTick: number,
  count: number,
  axes: Int8Array,
  bits: Uint8Array,
): Uint8Array {
  w.begin(MSG.INPUT_BATCH, slot).u32(firstTick).u8(count).u8(slot);
  for (let i = 0; i < count; i++) {
    w.i8(axes[i * 2] as number)
      .i8(axes[i * 2 + 1] as number)
      .u8(bits[i * 2] as number)
      .u8(bits[i * 2 + 1] as number);
  }
  return w.finish();
}

export interface InputBatchHeader {
  slot: number;
  firstTick: number;
  count: number;
}

/**
 * Read the batch header, then hand the reader to the caller to pull frames.
 *
 * Split in two because the caller writes straight into an `InputHistory` ring and we refuse to
 * materialise an intermediate array to do it.
 */
export function decodeInputBatchHeader(r: Reader, out: InputBatchHeader): InputBatchHeader {
  out.firstTick = r.u32();
  out.count = r.u8();
  out.slot = r.u8();
  return out;
}

/** Pull one frame of a batch into four scalars via a small caller-owned array. */
export function decodeInputFrame(r: Reader, out: Int32Array): void {
  out[0] = r.i8();
  out[1] = r.i8();
  out[2] = r.u8();
  out[3] = r.u8();
}

/** Bytes a batch of `count` frames occupies, header included. Used to size send budgets. */
export function inputBatchBytes(count: number): number {
  return 4 + INPUT_BATCH_HEADER_BYTES + count * INPUT_BATCH_FRAME_BYTES;
}

/* ---------------------------------------------------------------------------------------------- */
/* HOST_EVENTS — authoritative decisions                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Event kinds. These are the things a guest is never allowed to decide for itself, because two
 * clients disagreeing about them is not drift — it is two different games.
 *
 * Never renumber.
 */
export const EVT = {
  SPAWN: 1,
  DAMAGE: 2,
  DEATH: 3,
  CHEST: 4,
  CARD_DRAW: 5,
  BATCH_LEVELUP: 6,
  PICKUP: 7,
  PLAYER_DOWN: 8,
  PLAYER_REVIVE: 9,
  /** Reaper sequence stage change, including the White Hand. */
  REAPER: 10,
  /** Host paused, resumed, or ended the run. */
  RUN_STATE: 11,
} as const;

export type EventKind = (typeof EVT)[keyof typeof EVT];

/**
 * Events are variable length, so each carries its own byte count. That is what lets a guest running
 * an older build skip an event kind it does not recognise instead of losing the rest of the packet —
 * the difference between a graceful degrade and a hard desync during a staged rollout.
 *
 * Per event: `u8 kind, u8 byteLength, u32 tick`, then `byteLength` bytes of payload.
 */
export const EVENT_HEADER_BYTES = 6;

export function beginHostEvents(w: Writer, slot: number, tick: number): Writer {
  w.begin(MSG.HOST_EVENTS, slot).u32(tick).u8(0);
  return w;
}

/**
 * Write one event header. The caller then writes exactly `byteLength` bytes of payload.
 *
 * Returns false when the message is full, which is the signal to flush and start another rather than
 * drop the event — dropping an authoritative event is unrecoverable.
 */
export function writeEventHeader(w: Writer, kind: number, byteLength: number, tick: number): boolean {
  if (w.remaining < EVENT_HEADER_BYTES + byteLength) return false;
  w.u8(kind).u8(byteLength).u32(tick);
  return true;
}

export interface EventHeader {
  kind: number;
  byteLength: number;
  tick: number;
}

export function readEventHeader(r: Reader, out: EventHeader): EventHeader {
  out.kind = r.u8();
  out.byteLength = r.u8();
  out.tick = r.u32();
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* STATE_HASH / RESYNC                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export function encodeStateHash(w: Writer, slot: number, tick: number, hash: number): Uint8Array {
  w.begin(MSG.STATE_HASH, slot).u32(tick).i32(hash);
  return w.finish();
}

export function encodeResyncRequest(
  w: Writer,
  slot: number,
  tick: number,
  localHash: number,
  expectedHash: number,
): Uint8Array {
  w.begin(MSG.RESYNC_REQUEST, slot).u32(tick).i32(localHash).i32(expectedHash);
  return w.finish();
}

/**
 * Resync snapshots are chunked because a full enemy set exceeds one datagram, and because a resync
 * must not block the socket long enough to cause the drift it is fixing.
 *
 * `u32 tick, u16 chunkIndex, u16 chunkCount, u16 payloadBytes`, then the payload.
 */
export const RESYNC_CHUNK_HEADER_BYTES = 10;

export function beginResyncChunk(
  w: Writer,
  slot: number,
  tick: number,
  chunkIndex: number,
  chunkCount: number,
  payloadBytes: number,
): Writer {
  w.begin(MSG.RESYNC_CHUNK, slot).u32(tick).u16(chunkIndex).u16(chunkCount).u16(payloadBytes);
  return w;
}

export interface ResyncChunkHeader {
  tick: number;
  chunkIndex: number;
  chunkCount: number;
  payloadBytes: number;
}

export function readResyncChunkHeader(r: Reader, out: ResyncChunkHeader): ResyncChunkHeader {
  out.tick = r.u32();
  out.chunkIndex = r.u16();
  out.chunkCount = r.u16();
  out.payloadBytes = r.u16();
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* CORRECTION                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** `u32 tick, u8 count`, then count × (u16 index, u16 generation, i32 x, i32 y). */
export const CORRECTION_HEADER_BYTES = 5;

export function encodeCorrection(
  w: Writer,
  slot: number,
  tick: number,
  indices: Int32Array,
  count: number,
  generations: Uint16Array,
  posX: Int32Array,
  posY: Int32Array,
): Uint8Array {
  w.begin(MSG.CORRECTION, slot).u32(tick).u8(count);
  for (let i = 0; i < count; i++) {
    const idx = indices[i] as number;
    w.u16(idx)
      .u16(generations[idx] as number)
      .i32(posX[idx] as number)
      .i32(posY[idx] as number);
  }
  return w.finish();
}

export interface CorrectionHeader {
  tick: number;
  count: number;
}

export function readCorrectionHeader(r: Reader, out: CorrectionHeader): CorrectionHeader {
  out.tick = r.u32();
  out.count = r.u8();
  return out;
}

/** Read one corrected entity into `out[0..3]` = index, generation, x, y. */
export function readCorrectionEntity(r: Reader, out: Int32Array): void {
  out[0] = r.u16();
  out[1] = r.u16();
  out[2] = r.i32();
  out[3] = r.i32();
}

export function correctionBytes(count: number): number {
  return 4 + CORRECTION_HEADER_BYTES + count * CORRECTION_ENTITY_BYTES;
}

/* ---------------------------------------------------------------------------------------------- */
/* PING / PONG / LEAVE / HOST_MIGRATE                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Ping carries the sender's local send time and its current tick.
 *
 * Tick travels with the probe so RTT and clock offset are measured from the same packet. Measuring
 * them separately means the offset is computed from a latency figure that is already stale, which on
 * a mobile connection is exactly when it is least accurate.
 */
export function encodePing(w: Writer, slot: number, sendTimeMs: number, tick: number): Uint8Array {
  w.begin(MSG.PING, slot).u32(sendTimeMs >>> 0).u32(tick);
  return w.finish();
}

export function encodePong(
  w: Writer,
  slot: number,
  echoTimeMs: number,
  senderTick: number,
  ownTick: number,
): Uint8Array {
  w.begin(MSG.PONG, slot).u32(echoTimeMs >>> 0).u32(senderTick).u32(ownTick);
  return w.finish();
}

/** Leave reasons. `TIMEOUT` is inferred by the peer, never actually sent. */
export const LEAVE_REASON = {
  QUIT: 1,
  TIMEOUT: 2,
  VERSION_MISMATCH: 3,
  ROOM_FULL: 4,
  KICKED: 5,
  /** Guest-side plausibility checks flagged the host. Session stops counting for everyone. */
  HOST_IMPLAUSIBLE: 6,
} as const;

export function encodeLeave(w: Writer, slot: number, reason: number): Uint8Array {
  w.begin(MSG.LEAVE, slot).u8(reason);
  return w.finish();
}

export function encodeHostMigrate(w: Writer, newHostSlot: number, tick: number): Uint8Array {
  w.begin(MSG.HOST_MIGRATE, newHostSlot).u8(newHostSlot).u32(tick);
  return w.finish();
}

/** Bytes needed for the largest fixed-size message, used to size the shared writer. */
export const LARGEST_FIXED_MESSAGE_BYTES =
  4 + Math.max(INPUT_FRAME_BYTES * MAX_PLAYERS, RESYNC_CHUNK_HEADER_BYTES, CORRECTION_HEADER_BYTES);
