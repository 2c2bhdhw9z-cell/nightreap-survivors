/**
 * Rooms: who is playing with whom, and under what code.
 *
 * WHAT THIS IS
 * The entire state a co-op server keeps. A room is a code, up to four seats, and a note of which seat
 * is the host. That is it — no run state, no entities, no scores. The relay forwards bytes it cannot
 * read (see routing.ts), so this file is the only place it holds anything at all, and it holds a few
 * hundred bytes per party.
 *
 * NO SOCKETS IN HERE
 * A member is an opaque integer connection id supplied by the caller. That keeps this file testable
 * without a network — the same reason `Link` is a one-method interface — and means the transport can
 * be swapped without touching a line of the logic below.
 *
 * NO CLOCK AND NO RANDOMNESS IN HERE EITHER
 * Both are injected. A registry that called `Date.now()` could not be tested for expiry without
 * actually waiting, and `Math.random` is banned everywhere in game/ because a test that cannot be
 * replayed is a test that will eventually lie. Tests drive time by hand and seed the code generator.
 *
 * A SEAT IS HELD, NOT FREED, WHEN SOMEONE DROPS
 * A phone that loses signal for eight seconds should come back to its own slot with its own weapons,
 * not find the party full or, worse, find someone else wearing its slot number. So a lost connection
 * marks the seat ABSENT and keeps it for `SEAT_GRACE_MS`, redeemable with the token issued at join.
 * The alternative — freeing immediately — turns every lift and every tunnel into a lost run.
 */

import { MAX_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "./protocol";

/* ---------------------------------------------------------------------------------------------- */
/* Limits                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Rooms one relay process will hold. Four thousand parties is far past anything this game will see
 * early, and the point of a ceiling is that running out is a refused join rather than a dead server.
 */
export const MAX_ROOMS = 4096;

/** Attempts at an unused code before we admit the table is too crowded. */
export const CODE_ATTEMPTS = 8;

/** How long a dropped player's seat is held for them. */
export const SEAT_GRACE_MS = 45_000;

/** How long a room with nobody live in it survives before being reaped. */
export const EMPTY_ROOM_TTL_MS = 20_000;

/** Silence from every member for this long and the room is presumed dead. */
export const ROOM_IDLE_TTL_MS = 120_000;

/**
 * Absolute ceiling on a room's life. A run that has been open for six hours is not a run, it is a
 * leak — a backgrounded phone, a crashed client, a socket nobody closed.
 */
export const ROOM_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------------------------------- */
/* Types                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export const SEAT_STATE = {
  /** Never taken, or vacated for good. */
  EMPTY: 0,
  /** Someone is connected in it right now. */
  LIVE: 1,
  /** Someone dropped and the seat is being held for their return. */
  ABSENT: 2,
} as const;

export const VISIBILITY = {
  /** Reachable only by typing the code. */
  PRIVATE: 0,
  /** Offered to the public queue for matching by party size. */
  PUBLIC: 1,
} as const;

export const JOIN = {
  OK: 0,
  /** Code is well formed but no such room, or it has been reaped. */
  NO_SUCH_ROOM: 1,
  /** Every seat is taken, or held for someone with a better claim to it. */
  FULL: 2,
  /** Not six characters, or characters outside the alphabet. */
  BAD_CODE: 3,
  /** This connection is already seated somewhere. */
  ALREADY_SEATED: 4,
  /** The relay is at MAX_ROOMS. */
  SERVER_FULL: 5,
  /** Rejoin only: the seat exists but the token does not match, or the grace window closed. */
  BAD_TOKEN: 6,
} as const;

export interface Seat {
  state: number;
  /** Opaque connection id supplied by the transport. -1 when nobody is in it. */
  connId: number;
  /** Issued at join, required to reclaim an ABSENT seat. Never leaves the owner's device. */
  token: number;
  /** When the seat went ABSENT, for the grace window. */
  absentSinceMs: number;
}

export interface Room {
  code: string;
  createdAtMs: number;
  /** Last time any member was heard from. Drives idle reaping. */
  lastSeenMs: number;
  visibility: number;
  /**
   * Party size the host is looking for. Only meaningful for public rooms, where it is what the queue
   * matches on — a duo looking for a fourth should not be handed to someone queuing for a duo.
   */
  targetSize: number;
  hostSlot: number;
  seats: Seat[];
  closed: boolean;
}

/** Result of a join attempt. Caller-owned so a join allocates nothing beyond the room itself. */
export interface JoinResult {
  status: number;
  slot: number;
  token: number;
}

/** What a departure did to the room, so the transport knows what to tell the others. */
export interface LeaveResult {
  /** Room the connection was in, or null if it was in none. */
  room: Room | null;
  slot: number;
  /** The seat is being held, not freed. */
  heldForReturn: boolean;
  /** The host left and a new one was promoted. -1 when the host did not change. */
  newHostSlot: number;
  /** Nobody live is left and the room is now closed. */
  roomClosed: boolean;
}

export interface RegistryOptions {
  /** Milliseconds. Any monotonic source; the registry only ever compares and subtracts. */
  now: () => number;
  /** Unsigned 32-bit randomness, used for codes and seat tokens. */
  random: () => number;
}

/* ---------------------------------------------------------------------------------------------- */
/* Codes                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A code is six characters from a 30-character alphabet with the ambiguous glyphs removed, because
 * these get read aloud and typed by someone squinting at a phone. Uppercased and stripped on the way
 * in so "abc-123" and "ABC123" are the same room.
 */
export function normalizeCode(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    const up = ch.toUpperCase();
    if (ROOM_CODE_ALPHABET.includes(up)) out += up;
  }
  return out;
}

export function isValidCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i] as string)) return false;
  }
  return true;
}

/**
 * Generate a code from the supplied randomness.
 *
 * Modulo over a 30-character alphabet is very slightly biased against the last few characters. At 729
 * million codes and a few thousand rooms that is worth nothing to an attacker and nothing to
 * collisions, and rejection sampling would make the generator able to loop. Documented rather than
 * defended.
 */
export function generateCode(random: () => number): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const r = random() >>> 0;
    out += ROOM_CODE_ALPHABET[r % ROOM_CODE_ALPHABET.length] as string;
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Registry                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function makeSeat(): Seat {
  return { state: SEAT_STATE.EMPTY, connId: -1, token: 0, absentSinceMs: 0 };
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  /** Reverse index so a socket closing is a map lookup rather than a scan of every room. */
  private readonly byConn = new Map<number, string>();
  private readonly now: () => number;
  private readonly random: () => number;

  /** Counters, for the admin page. Nothing here is per-player and nothing is persisted. */
  readonly stats = {
    roomsCreated: 0,
    roomsClosed: 0,
    joins: 0,
    rejoins: 0,
    rejoinsRefused: 0,
    hostMigrations: 0,
    seatsHeld: 0,
    seatsExpired: 0,
    codeCollisions: 0,
    matchedFromQueue: 0,
  };

  constructor(options: RegistryOptions) {
    this.now = options.now;
    this.random = options.random;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  roomOf(connId: number): Room | null {
    const code = this.byConn.get(connId);
    if (code === undefined) return null;
    return this.rooms.get(code) ?? null;
  }

  slotOf(connId: number): number {
    const room = this.roomOf(connId);
    if (room === null) return -1;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = room.seats[i] as Seat;
      if (seat.state === SEAT_STATE.LIVE && seat.connId === connId) return i;
    }
    return -1;
  }

  isHost(connId: number): boolean {
    const room = this.roomOf(connId);
    if (room === null) return false;
    return this.slotOf(connId) === room.hostSlot;
  }

  /** Connection id sitting in a slot, or -1. What the transport needs to forward a routed message. */
  connAt(room: Room, slot: number): number {
    if (slot < 0 || slot >= MAX_PLAYERS) return -1;
    const seat = room.seats[slot] as Seat;
    return seat.state === SEAT_STATE.LIVE ? seat.connId : -1;
  }

  liveCount(room: Room): number {
    let n = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if ((room.seats[i] as Seat).state === SEAT_STATE.LIVE) n++;
    }
    return n;
  }

  /** Seats neither live nor held. What the public queue cares about. */
  openSeats(room: Room): number {
    let n = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if ((room.seats[i] as Seat).state === SEAT_STATE.EMPTY) n++;
    }
    return n;
  }

  /**
   * Open a room. The creator takes slot 0 and is the host, because the host is a player.
   *
   * Returns null only when the relay is at MAX_ROOMS or the code space refused to yield an unused
   * code, both of which the caller reports as "try again", never as a crash.
   */
  createRoom(connId: number, targetSize: number, visibility: number): Room | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    if (this.byConn.has(connId)) return null;

    let code = "";
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const candidate = generateCode(this.random);
      if (!this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
      this.stats.codeCollisions++;
    }
    if (code === "") return null;

    const nowMs = this.now();
    const size = targetSize < 1 ? 1 : targetSize > MAX_PLAYERS ? MAX_PLAYERS : targetSize;
    const seats: Seat[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) seats.push(makeSeat());

    const room: Room = {
      code,
      createdAtMs: nowMs,
      lastSeenMs: nowMs,
      visibility,
      targetSize: size,
      hostSlot: 0,
      seats,
      closed: false,
    };

    const host = seats[0] as Seat;
    host.state = SEAT_STATE.LIVE;
    host.connId = connId;
    host.token = this.random() >>> 0;

    this.rooms.set(code, room);
    this.byConn.set(connId, code);
    this.stats.roomsCreated++;
    return room;
  }

  /** Take the lowest free seat in a room. Lowest, not random, so slot order is stable and testable. */
  join(rawCode: string, connId: number, out: JoinResult): JoinResult {
    out.slot = -1;
    out.token = 0;

    const code = normalizeCode(rawCode);
    if (!isValidCode(code)) {
      out.status = JOIN.BAD_CODE;
      return out;
    }
    if (this.byConn.has(connId)) {
      out.status = JOIN.ALREADY_SEATED;
      return out;
    }
    const room = this.rooms.get(code);
    if (room === undefined || room.closed) {
      out.status = JOIN.NO_SUCH_ROOM;
      return out;
    }

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = room.seats[i] as Seat;
      if (seat.state !== SEAT_STATE.EMPTY) continue;
      seat.state = SEAT_STATE.LIVE;
      seat.connId = connId;
      seat.token = this.random() >>> 0;
      seat.absentSinceMs = 0;
      room.lastSeenMs = this.now();
      this.byConn.set(connId, code);
      this.stats.joins++;
      out.status = JOIN.OK;
      out.slot = i;
      out.token = seat.token;
      return out;
    }

    // Held seats count as full. Someone who dropped four seconds ago has a better claim than a
    // stranger who queued one second ago.
    out.status = JOIN.FULL;
    return out;
  }

  /**
   * Reclaim a held seat.
   *
   * The token is the whole check. It is a random 32-bit value the seat's owner was handed at join and
   * nobody else ever saw, which is enough to stop a stranger walking into a slot that is mid-run —
   * and it is deliberately not an identity: it proves "I am who was in this seat", not who they are.
   */
  rejoin(rawCode: string, token: number, connId: number, out: JoinResult): JoinResult {
    out.slot = -1;
    out.token = 0;

    const code = normalizeCode(rawCode);
    if (!isValidCode(code)) {
      out.status = JOIN.BAD_CODE;
      return out;
    }
    if (this.byConn.has(connId)) {
      out.status = JOIN.ALREADY_SEATED;
      return out;
    }
    const room = this.rooms.get(code);
    if (room === undefined || room.closed) {
      out.status = JOIN.NO_SUCH_ROOM;
      return out;
    }

    const nowMs = this.now();
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = room.seats[i] as Seat;
      if (seat.state !== SEAT_STATE.ABSENT) continue;
      if (seat.token !== (token >>> 0)) continue;
      if (nowMs - seat.absentSinceMs > SEAT_GRACE_MS) continue;
      seat.state = SEAT_STATE.LIVE;
      seat.connId = connId;
      seat.absentSinceMs = 0;
      room.lastSeenMs = nowMs;
      this.byConn.set(connId, code);
      this.stats.rejoins++;
      out.status = JOIN.OK;
      out.slot = i;
      out.token = seat.token;
      return out;
    }

    this.stats.rejoinsRefused++;
    out.status = JOIN.BAD_TOKEN;
    return out;
  }

  /** Called on every message, so idle reaping measures silence rather than connection state. */
  touch(connId: number): void {
    const room = this.roomOf(connId);
    if (room !== null) room.lastSeenMs = this.now();
  }

  /**
   * A connection went away.
   *
   * `graceful` separates "I pressed quit" from "the tunnel ate my signal". A quit frees the seat
   * immediately; a drop holds it. Getting this backwards means either quitters block their friends'
   * fourth slot for 45 seconds, or a subway tunnel costs someone their run.
   */
  leave(connId: number, graceful: boolean, out: LeaveResult): LeaveResult {
    out.room = null;
    out.slot = -1;
    out.heldForReturn = false;
    out.newHostSlot = -1;
    out.roomClosed = false;

    const room = this.roomOf(connId);
    if (room === null) return out;
    const slot = this.slotOf(connId);
    if (slot < 0) return out;

    const seat = room.seats[slot] as Seat;
    const nowMs = this.now();
    this.byConn.delete(connId);
    out.room = room;
    out.slot = slot;

    if (graceful) {
      seat.state = SEAT_STATE.EMPTY;
      seat.connId = -1;
      seat.token = 0;
      seat.absentSinceMs = 0;
    } else {
      seat.state = SEAT_STATE.ABSENT;
      seat.connId = -1;
      seat.absentSinceMs = nowMs;
      out.heldForReturn = true;
      this.stats.seatsHeld++;
    }

    // The host leaving is not the room ending. Promote the lowest live seat and let the clients sort
    // out authority — the relay only says who it is now.
    if (slot === room.hostSlot) {
      const promoted = this.lowestLiveSlot(room);
      if (promoted >= 0) {
        room.hostSlot = promoted;
        out.newHostSlot = promoted;
        this.stats.hostMigrations++;
      }
    }

    if (this.liveCount(room) === 0) {
      // Nobody live. If every seat is genuinely gone, close now; if seats are held, the sweep decides
      // later — the last two players both dropping should not lose a room they can both come back to.
      if (this.openSeats(room) === MAX_PLAYERS) {
        this.closeRoom(room);
        out.roomClosed = true;
      }
    }

    return out;
  }

  private lowestLiveSlot(room: Room): number {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if ((room.seats[i] as Seat).state === SEAT_STATE.LIVE) return i;
    }
    return -1;
  }

  closeRoom(room: Room): void {
    if (room.closed) return;
    room.closed = true;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = room.seats[i] as Seat;
      if (seat.connId >= 0) this.byConn.delete(seat.connId);
      seat.state = SEAT_STATE.EMPTY;
      seat.connId = -1;
      seat.token = 0;
    }
    this.rooms.delete(room.code);
    this.stats.roomsClosed++;
  }

  /**
   * Expire held seats and dead rooms. Called on a timer by the transport.
   *
   * Everything here is a subtraction against the injected clock, which is why expiry can be tested in
   * microseconds instead of by sleeping for a minute.
   */
  sweep(): number {
    const nowMs = this.now();
    let closed = 0;
    for (const room of Array.from(this.rooms.values())) {
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const seat = room.seats[i] as Seat;
        if (seat.state !== SEAT_STATE.ABSENT) continue;
        if (nowMs - seat.absentSinceMs <= SEAT_GRACE_MS) continue;
        seat.state = SEAT_STATE.EMPTY;
        seat.token = 0;
        seat.absentSinceMs = 0;
        this.stats.seatsExpired++;
      }

      const live = this.liveCount(room);
      const empty = this.openSeats(room) === MAX_PLAYERS;
      const tooOld = nowMs - room.createdAtMs > ROOM_MAX_AGE_MS;
      const idle = nowMs - room.lastSeenMs > ROOM_IDLE_TTL_MS;
      const emptyTooLong = live === 0 && empty && nowMs - room.lastSeenMs > EMPTY_ROOM_TTL_MS;

      if (tooOld || idle || emptyTooLong) {
        this.closeRoom(room);
        closed++;
        continue;
      }

      // A host seat that expired while nobody was live leaves the room without a host. Promote.
      if (live > 0 && (room.seats[room.hostSlot] as Seat).state !== SEAT_STATE.LIVE) {
        const promoted = this.lowestLiveSlot(room);
        if (promoted >= 0) {
          room.hostSlot = promoted;
          this.stats.hostMigrations++;
        }
      }
    }
    return closed;
  }

  /**
   * The public queue: find a room that wants exactly this party size and has room.
   *
   * Oldest first, so a room that has been waiting fills before a fresh one — otherwise the unlucky
   * party waits forever while new rooms keep absorbing arrivals. There is no queue object at all; the
   * rooms themselves are the queue, which is why matchmaking adds no state to maintain and nothing to
   * leak. Friends-first fill happens above this, by handing the friend's code straight to `join`.
   */
  findPublicRoom(targetSize: number, excludeConnId: number): Room | null {
    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.closed) continue;
      if (room.visibility !== VISIBILITY.PUBLIC) continue;
      if (room.targetSize !== targetSize) continue;
      if (this.openSeats(room) === 0) continue;
      if (this.liveCount(room) === 0) continue;
      if (this.connAt(room, room.hostSlot) === excludeConnId) continue;
      if (best === null || room.createdAtMs < best.createdAtMs) best = room;
    }
    if (best !== null) this.stats.matchedFromQueue++;
    return best;
  }

  /** Public queue first, a fresh room if nothing matches. The whole of "quick play". */
  quickPlay(connId: number, targetSize: number, out: JoinResult): Room | null {
    const found = this.findPublicRoom(targetSize, connId);
    if (found !== null) {
      this.join(found.code, connId, out);
      if (out.status === JOIN.OK) return found;
    }
    const room = this.createRoom(connId, targetSize, VISIBILITY.PUBLIC);
    if (room === null) {
      out.status = JOIN.SERVER_FULL;
      out.slot = -1;
      out.token = 0;
      return null;
    }
    out.status = JOIN.OK;
    out.slot = 0;
    out.token = (room.seats[0] as Seat).token;
    return room;
  }

  clear(): void {
    this.rooms.clear();
    this.byConn.clear();
  }
}

export function createJoinResult(): JoinResult {
  return { status: JOIN.OK, slot: -1, token: 0 };
}

export function createLeaveResult(): LeaveResult {
  return { room: null, slot: -1, heldForReturn: false, newHostSlot: -1, roomClosed: false };
}
