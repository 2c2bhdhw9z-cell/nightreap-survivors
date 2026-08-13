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

/**
 * A list of snapshot chunks that never arrived: `u32 tick, u16 count`, then count × `u16 index`.
 *
 * Named per chunk rather than as a range, because loss is scattered — a 10% path drops the 3rd, the
 * 11th and the 40th, not the last forty.
 */
export const RESYNC_NACK_HEADER_BYTES = 6;

export function encodeResyncNack(
  w: Writer,
  slot: number,
  tick: number,
  indices: Uint16Array,
  count: number,
): Uint8Array {
  w.begin(MSG.RESYNC_NACK, slot).u32(tick).u16(count);
  for (let i = 0; i < count; i++) w.u16(indices[i] as number);
  return w.finish();
}

export interface ResyncNackHeader {
  tick: number;
  count: number;
}

export function readResyncNackHeader(r: Reader, out: ResyncNackHeader): ResyncNackHeader {
  out.tick = r.u32();
  out.count = r.u16();
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


/* ---------------------------------------------------------------------------------------------- */
/* TICK_CONFIRM — the confirmed input record, which is what actually keeps four sims identical      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Card-screen actions, as a single byte inside the confirmed record.
 *
 * A level-up screen freezes the simulation, so answering it is not an input — it is a decision about
 * when the world resumes, and every client has to make it on the same tick or they part company on
 * the frame the screen closes. Carrying it here rather than as a separate event means it inherits the
 * confirm stream's ordering and retransmission for free.
 *
 * Never renumber.
 */
export const CARD_ACTION = {
  NONE: 0,
  PICK_0: 1,
  PICK_1: 2,
  PICK_2: 3,
  PICK_3: 4,
  REROLL: 5,
  SKIP: 6,
  BANISH_0: 7,
  BANISH_1: 8,
  BANISH_2: 9,
  BANISH_3: 10,
} as const;

export type CardAction = (typeof CARD_ACTION)[keyof typeof CARD_ACTION];

/** `u32 firstTick, u8 count, u8 playerCount`. */
export const TICK_CONFIRM_HEADER_BYTES = 6;

/** Per confirmed tick: `playerCount` x (i8 x, i8 y, u8 buttons, u8 flags), then `u8 cardAction`. */
export function tickRecordBytes(playerCount: number): number {
  return playerCount * 4 + 1;
}

export function tickConfirmBytes(playerCount: number, count: number): number {
  return 4 + TICK_CONFIRM_HEADER_BYTES + count * tickRecordBytes(playerCount);
}

/**
 * Write a run of confirmed ticks straight out of the host's record ring.
 *
 * `records` is the flat ring: `stride` bytes per tick, indexed by `tick % capacity`. Copying out of
 * it byte-wise avoids materialising anything per tick, which matters because this runs twenty times
 * a second for the whole run.
 */
export function encodeTickConfirm(
  w: Writer,
  slot: number,
  firstTick: number,
  count: number,
  playerCount: number,
  records: Uint8Array,
  stride: number,
  capacity: number,
): Uint8Array {
  const bytes = tickRecordBytes(playerCount);
  w.begin(MSG.TICK_CONFIRM, slot).u32(firstTick).u8(count).u8(playerCount);
  for (let i = 0; i < count; i++) {
    const base = ((firstTick + i) % capacity) * stride;
    for (let b = 0; b < bytes; b++) w.u8(records[base + b] as number);
  }
  return w.finish();
}

export interface TickConfirmHeader {
  firstTick: number;
  count: number;
  playerCount: number;
}

export function decodeTickConfirmHeader(r: Reader, out: TickConfirmHeader): TickConfirmHeader {
  out.firstTick = r.u32();
  out.count = r.u8();
  out.playerCount = r.u8();
  return out;
}

/** Read one confirmed tick record into a caller-owned ring at `destOffset`. */
export function decodeTickRecord(
  r: Reader,
  playerCount: number,
  dest: Uint8Array,
  destOffset: number,
): void {
  const bytes = tickRecordBytes(playerCount);
  for (let b = 0; b < bytes; b++) dest[destOffset + b] = r.u8();
}

/** guest -> host: `u8 action`. The host is free to ignore it. */
export function encodeCardRequest(w: Writer, slot: number, action: number): Uint8Array {
  w.begin(MSG.CARD_REQUEST, slot).u8(action);
  return w.finish();
}

/* ---------------------------------------------------------------------------------------------- */
/* Lobby — the only messages sent while nobody is playing                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Why the lobby is on the binary channel with everything else.
 *
 * The relay's text channel is relay-authored only: client text frames are ignored, deliberately, so
 * that nothing a player types can ever be mistaken for something the server said. That leaves the
 * binary channel, which is no hardship — the lobby sends a handful of messages per player per session,
 * and it gets the role table for free. A guest that tries to publish a roster is dropped by the same
 * rule that stops a guest publishing a tick confirm.
 */

/** Longest display name on the wire. Names are user content and are filtered before they get here. */
export const MAX_NAME_BYTES = 24;

/** Longest chat line on the wire. */
export const MAX_CHAT_BYTES = 160;

/** guest -> host: `u8 characterId, u8 ready, str name`. */
export function encodeLobbySeat(
  w: Writer,
  slot: number,
  characterId: number,
  ready: boolean,
  name: string,
): Uint8Array {
  w.begin(MSG.LOBBY_SEAT, slot).u8(characterId).u8(ready ? 1 : 0).str(name);
  return w.finish();
}

export interface LobbySeatWire {
  characterId: number;
  ready: boolean;
  name: string;
}

export function decodeLobbySeat(r: Reader, out: LobbySeatWire): LobbySeatWire {
  out.characterId = r.u8();
  out.ready = r.u8() === 1;
  out.name = r.str();
  return out;
}

/**
 * host -> guests: `u8 count, u8 hostSlot`, then per seat `u8 state, u8 characterId, u8 ready, str name`.
 *
 * Always the complete roster. A diff would be smaller and would also mean that a guest which missed one
 * message shows a stale party for the rest of the lobby, which is precisely the kind of bug nobody can
 * reproduce. At four players this is under 150 bytes and it is sent when something changes, not per tick.
 */
export function encodeLobbyRoster(
  w: Writer,
  slot: number,
  hostSlot: number,
  count: number,
  states: Uint8Array,
  characters: Uint8Array,
  ready: Uint8Array,
  names: string[],
): Uint8Array {
  const n = count > MAX_PLAYERS ? MAX_PLAYERS : count;
  w.begin(MSG.LOBBY_ROSTER, slot).u8(n).u8(hostSlot);
  for (let i = 0; i < n; i++) {
    w.u8(states[i] as number)
      .u8(characters[i] as number)
      .u8(ready[i] as number)
      .str(names[i] ?? "");
  }
  return w.finish();
}

export interface LobbyRosterWire {
  hostSlot: number;
  count: number;
  states: Uint8Array;
  characters: Uint8Array;
  ready: Uint8Array;
  names: string[];
}

export function createLobbyRosterWire(): LobbyRosterWire {
  return {
    hostSlot: 0,
    count: 0,
    states: new Uint8Array(MAX_PLAYERS),
    characters: new Uint8Array(MAX_PLAYERS),
    ready: new Uint8Array(MAX_PLAYERS),
    names: ["", "", "", ""],
  };
}

export function decodeLobbyRoster(r: Reader, out: LobbyRosterWire): LobbyRosterWire {
  const n = r.u8();
  out.count = n > MAX_PLAYERS ? MAX_PLAYERS : n;
  out.hostSlot = r.u8();
  for (let i = 0; i < out.count; i++) {
    out.states[i] = r.u8();
    out.characters[i] = r.u8();
    out.ready[i] = r.u8();
    out.names[i] = r.str();
  }
  return out;
}

/**
 * chat: `u8 kind, u8 presetId, u8 fromSlot, str text`.
 *
 * `fromSlot` is in the body as well as the header because the host rebroadcasts a guest's line under
 * its own header — the header seat says who relayed it, the body says who wrote it, and only the host
 * is ever allowed to write the body's value.
 */
export function encodeLobbyChat(
  w: Writer,
  slot: number,
  kind: number,
  presetId: number,
  fromSlot: number,
  text: string,
): Uint8Array {
  w.begin(MSG.LOBBY_CHAT, slot).u8(kind).u8(presetId).u8(fromSlot).str(text);
  return w.finish();
}

export interface LobbyChatWire {
  kind: number;
  presetId: number;
  fromSlot: number;
  text: string;
}

export function decodeLobbyChat(r: Reader, out: LobbyChatWire): LobbyChatWire {
  out.kind = r.u8();
  out.presetId = r.u8();
  out.fromSlot = r.u8();
  out.text = r.str();
  return out;
}

/** host -> guests: `u32 seed, u16 stageId, u8 playerCount`. The run begins from exactly this. */
export function encodeLobbyLaunch(
  w: Writer,
  slot: number,
  seed: number,
  stageId: number,
  playerCount: number,
): Uint8Array {
  w.begin(MSG.LOBBY_LAUNCH, slot).u32(seed).u16(stageId).u8(playerCount);
  return w.finish();
}

export interface LobbyLaunchWire {
  seed: number;
  stageId: number;
  playerCount: number;
}

export function decodeLobbyLaunch(r: Reader, out: LobbyLaunchWire): LobbyLaunchWire {
  out.seed = r.u32();
  out.stageId = r.u16();
  out.playerCount = r.u8();
  return out;
}

/** Bytes needed for the largest fixed-size message, used to size the shared writer. */
export const LARGEST_FIXED_MESSAGE_BYTES =
  4 + Math.max(INPUT_FRAME_BYTES * MAX_PLAYERS, RESYNC_CHUNK_HEADER_BYTES, CORRECTION_HEADER_BYTES);
