/**
 * The co-op relay: the only server this game has.
 *
 * WHAT IT IS
 * A socket switchboard. It knows which players are in which room and which seat each one occupies,
 * and it copies bytes from one socket to another. It never simulates a tick, never reads a message
 * body, and holds nothing on disk. That is a deliberate cost decision as much as a design one — a
 * server that only forwards four-byte headers runs a full lobby on almost nothing, which is what
 * makes free online play affordable forever.
 *
 * WHERE THE JUDGEMENT LIVES
 * Not here. Every decision worth getting wrong — code generation, seat allocation, the drop-out grace
 * window, host promotion, reaping, matchmaking, and who is allowed to send what — lives in
 * `game/net/rooms.ts` and `game/net/routing.ts`, which are pure logic with no sockets in them and are
 * covered by `game/net/rooms.test.ts`. This file is the shim that owns the one thing those cannot: an
 * actual WebSocket. Keep it that way. Anything in here that starts to look like a rule belongs in a
 * tested module instead.
 *
 * WHY IT IS NOT PART OF THE WEB PACKAGE
 * The template's web server is managed and its dev pipeline routes requests through a Node middleware
 * that calls `app.fetch`, which cannot perform a WebSocket upgrade. Rather than fight that, the relay
 * is its own tiny Bun process and deploys separately.
 *
 * TWO CHANNELS ON ONE SOCKET
 *   - Binary frames are game traffic. The relay reads the first four bytes and nothing else.
 *   - Text frames are lobby control, and the relay authors all of them. Splitting the two means the
 *     game protocol never needs a version bump to add a lobby nicety, and it keeps the promise that
 *     the relay cannot read gameplay: it literally never parses a binary body.
 *
 * ADMISSION HAPPENS BEFORE THE SOCKET EXISTS
 * Which room you want is in the connect URL, so a refused join is an HTTP error rather than a socket
 * that opens and then goes quiet:
 *
 *   /ws?mode=create&size=4&vis=private
 *   /ws?mode=join&code=ABC123
 *   /ws?mode=quick&size=2
 *   /ws?mode=rejoin&code=ABC123&token=1234567890
 */

import { HOST_SLOT, MAX_MESSAGE_BYTES, MAX_PLAYERS } from "../../mobile/game/net/protocol";
import { Writer } from "../../mobile/game/net/codec";
import { encodeHostMigrate } from "../../mobile/game/net/messages";
import {
  JOIN,
  type JoinResult,
  type Room,
  RoomRegistry,
  SEAT_STATE,
  type Seat,
  VISIBILITY,
  type SweepReport,
  createJoinResult,
  createLeaveResult,
  createSweepReport,
} from "../../mobile/game/net/rooms";
import {
  DROP_REASON,
  ROUTE,
  type RouteDecision,
  createRouteDecision,
  routeFor,
  setSender,
} from "../../mobile/game/net/routing";

/**
 * Port the relay listens on. Web dev is 4200 and mobile is 4300, so this takes 4400.
 *
 * `PORT` is what a managed host like Railway injects at runtime and expects the process to bind, so
 * it takes precedence — bind anything else there and the deploy looks up but is unreachable.
 * `RELAY_PORT` is the local-dev override for when you want to move the relay off 4400, and 4400 is the
 * default when neither is set.
 */
const PORT = Number(Bun.env.PORT ?? Bun.env.RELAY_PORT ?? 4400);

/** How often held seats and dead rooms are swept. Fast enough that a 45s grace expires on time. */
const SWEEP_INTERVAL_MS = 5_000;

/**
 * Close code used after a refusal has been spoken.
 *
 * Application close codes live in 4000-4999. 4000 is the client's own "I quit" code, so a refusal
 * takes 4001. The reason itself travels in the control frame; the code just keeps the two apart in
 * logs and in anything watching the socket from outside.
 */
const CLOSE_REFUSED = 4001;

/**
 * Codes and seat tokens come from the OS, not from `Math.random`.
 *
 * A seat token is what proves "I am the player who was in this seat" after a tunnel ate the
 * connection, so a guessable one would let a stranger walk into a held seat. `Math.random` is
 * predictable from a handful of outputs; this is not. It is also why the registry takes its
 * randomness as an argument instead of reaching for a global.
 */
const randomWords = new Uint32Array(64);
let randomCursor = randomWords.length;

function random32(): number {
  if (randomCursor >= randomWords.length) {
    crypto.getRandomValues(randomWords);
    randomCursor = 0;
  }
  return (randomWords[randomCursor++] as number) >>> 0;
}

const registry = new RoomRegistry({ now: () => Date.now(), random: random32 });

/* ---------------------------------------------------------------------------------------------- */
/* Sockets                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** What the relay attaches to each socket. A connection id and nothing that needs keeping in sync. */
interface ConnData {
  connId: number;
  /** Set once the socket is open, so a close on a connection that never seated does nothing. */
  seated: boolean;
  /**
   * Why this connection was refused a seat, or null when it got one.
   *
   * A refused connection is still upgraded, told the reason on the control channel and then closed.
   * The HTTP status a browser or React Native returns for a failed WebSocket handshake is not visible
   * to the code that opened it, so refusing before the upgrade would leave every client guessing.
   */
  refusal: string | null;
}

type Socket = import("bun").ServerWebSocket<ConnData>;

/** Connection id to socket. The registry deals in opaque integers; this is the only place they map. */
const sockets = new Map<number, Socket>();

let nextConnId = 1;

/** What the relay wanted to do with a socket, decided from the URL before the upgrade. */
interface Admission {
  mode: "create" | "join" | "quick" | "rejoin";
  code: string;
  token: number;
  size: number;
  visibility: number;
}

/* Scratch objects, reused. A relay's whole job happens once per packet, so it allocates per packet
 * as close to never as a garbage-collected language allows. */
const decision: RouteDecision = createRouteDecision();
const joinResult: JoinResult = createJoinResult();
const leaveResult = createLeaveResult();
const sweepReport: SweepReport = createSweepReport();
const writer = new Writer();

/* ---------------------------------------------------------------------------------------------- */
/* Lobby control frames — the relay authors every one of these                                     */
/* ---------------------------------------------------------------------------------------------- */

function sendControl(ws: Socket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload), false);
}

/** Tell everyone live in a room something, optionally skipping one seat. */
function controlToRoom(room: Room, skipConnId: number, payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const seat = room.seats[i] as Seat;
    if (seat.state !== SEAT_STATE.LIVE) continue;
    if (seat.connId === skipConnId) continue;
    const peer = sockets.get(seat.connId);
    if (peer !== undefined) peer.send(text, false);
  }
}

/** A room as the clients are allowed to see it: seats and their state, never tokens. */
function roomView(room: Room): Record<string, unknown> {
  const seats: string[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const seat = room.seats[i] as Seat;
    seats.push(seat.state === SEAT_STATE.LIVE ? "live" : seat.state === SEAT_STATE.ABSENT ? "held" : "empty");
  }
  return {
    code: room.code,
    hostSlot: room.hostSlot,
    targetSize: room.targetSize,
    public: room.visibility === VISIBILITY.PUBLIC,
    seats,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Admission                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

function readAdmission(url: URL): Admission | null {
  const mode = url.searchParams.get("mode") ?? "quick";
  if (mode !== "create" && mode !== "join" && mode !== "quick" && mode !== "rejoin") return null;

  const size = Number(url.searchParams.get("size") ?? MAX_PLAYERS);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PLAYERS) return null;

  const token = Number(url.searchParams.get("token") ?? 0);
  if (!Number.isInteger(token) || token < 0 || token > 0xffffffff) return null;

  return {
    mode,
    code: url.searchParams.get("code") ?? "",
    token: token >>> 0,
    size,
    visibility: url.searchParams.get("vis") === "public" ? VISIBILITY.PUBLIC : VISIBILITY.PRIVATE,
  };
}

/** Player-facing reason a join was refused. The relay is vague on purpose about the token case. */
function joinRefusal(status: number): string {
  switch (status) {
    case JOIN.NO_SUCH_ROOM:
      return "no_such_room";
    case JOIN.FULL:
      return "room_full";
    case JOIN.BAD_CODE:
      return "bad_code";
    case JOIN.ALREADY_SEATED:
      return "already_seated";
    case JOIN.SERVER_FULL:
      return "server_busy";
    case JOIN.BAD_TOKEN:
      return "no_such_room";
    default:
      return "refused";
  }
}

/**
 * Seat a connection according to its URL, before the socket is upgraded.
 *
 * Returns the room on success. On failure nothing has been created and nothing needs cleaning up,
 * which is the reason admission happens here rather than in the open handler.
 */
function admit(connId: number, wanted: Admission): { room: Room; result: JoinResult } | null {
  if (wanted.mode === "create") {
    const room = registry.createRoom(connId, wanted.size, wanted.visibility);
    if (room === null) {
      joinResult.status = JOIN.SERVER_FULL;
      joinResult.slot = -1;
      joinResult.token = 0;
      return null;
    }
    joinResult.status = JOIN.OK;
    joinResult.slot = HOST_SLOT;
    joinResult.token = (room.seats[HOST_SLOT] as Seat).token;
    return { room, result: joinResult };
  }

  if (wanted.mode === "quick") {
    const room = registry.quickPlay(connId, wanted.size, joinResult);
    if (room === null) return null;
    return { room, result: joinResult };
  }

  if (wanted.mode === "rejoin") {
    registry.rejoin(wanted.code, wanted.token, connId, joinResult);
  } else {
    registry.join(wanted.code, connId, joinResult);
  }
  if (joinResult.status !== JOIN.OK) return null;
  const room = registry.roomOf(connId);
  if (room === null) return null;
  return { room, result: joinResult };
}

/* ---------------------------------------------------------------------------------------------- */
/* Departure                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Take a connection out of its room and tell the room what happened.
 *
 * `graceful` is the difference between "I pressed quit" and "the train went into a tunnel", and it is
 * the whole reason a dropped player can come back to the same seat. A quit frees the seat
 * immediately; a drop holds it for the grace window and only the seat token gets it back.
 */
function depart(connId: number, graceful: boolean): void {
  registry.leave(connId, graceful, leaveResult);
  sockets.delete(connId);

  const room = leaveResult.room;
  if (room === null) return;

  if (!leaveResult.roomClosed) {
    controlToRoom(room, connId, {
      t: "peer_left",
      slot: leaveResult.slot,
      held: leaveResult.heldForReturn,
      room: roomView(room),
    });
  }

  // Losing the host does not end the party. The registry has already promoted the lowest live seat;
  // all that is left is to say so, in the one message type only the server may author. The tick is 0
  // because the relay has no idea what tick anyone is on — the new host's own state is the truth, and
  // guests reconcile by asking it for a resync.
  if (leaveResult.newHostSlot >= 0 && !leaveResult.roomClosed) {
    const bytes = encodeHostMigrate(writer, leaveResult.newHostSlot, 0);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = room.seats[i] as Seat;
      if (seat.state !== SEAT_STATE.LIVE) continue;
      const peer = sockets.get(seat.connId);
      if (peer !== undefined) peer.send(bytes, true);
    }
  }
}

/**
 * Say out loud what the sweep quietly changed.
 *
 * Everything the sweep does is a subtraction against a clock, so it happens with nobody talking to the
 * relay at all. Two of its outcomes matter to players who are still in the room: a held seat finally
 * running out, and a room ending up with a new host because the old one's held seat expired. Both are
 * announced with exactly the messages the clients already understand from a normal departure — a seat
 * that is gone for good is `held: false`, which is the same thing a quit looks like, and the client
 * knows which of the two it was because it remembers where the seat was a moment ago.
 */
function announceSweep(): void {
  for (let i = 0; i < sweepReport.expiredCount; i++) {
    const room = sweepReport.expiredRoom[i];
    if (room === undefined || room === null || room.closed) continue;
    controlToRoom(room, -1, {
      t: "peer_left",
      slot: sweepReport.expiredSlot[i],
      held: false,
      room: roomView(room),
    });
  }

  for (let i = 0; i < sweepReport.migratedCount; i++) {
    const room = sweepReport.migratedRoom[i];
    if (room === undefined || room === null || room.closed) continue;
    const bytes = encodeHostMigrate(writer, sweepReport.migratedHost[i] as number, 0);
    for (let seatIndex = 0; seatIndex < MAX_PLAYERS; seatIndex++) {
      const seat = room.seats[seatIndex] as Seat;
      if (seat.state !== SEAT_STATE.LIVE) continue;
      const peer = sockets.get(seat.connId);
      if (peer !== undefined) peer.send(bytes, true);
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Forwarding                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const counters = {
  forwarded: 0,
  broadcast: 0,
  dropped: 0,
  droppedRole: 0,
  droppedMalformed: 0,
  droppedUnknownType: 0,
  droppedServerAuthored: 0,
  droppedBadDestination: 0,
};

function countDrop(reason: number): void {
  counters.dropped++;
  if (reason === DROP_REASON.WRONG_ROLE) counters.droppedRole++;
  else if (reason === DROP_REASON.MALFORMED) counters.droppedMalformed++;
  else if (reason === DROP_REASON.UNKNOWN_TYPE) counters.droppedUnknownType++;
  else if (reason === DROP_REASON.SERVER_AUTHORED) counters.droppedServerAuthored++;
  else if (reason === DROP_REASON.BAD_DESTINATION) counters.droppedBadDestination++;
}

function sendTo(room: Room, slot: number, bytes: Uint8Array): void {
  const connId = registry.connAt(room, slot);
  if (connId < 0) return;
  const peer = sockets.get(connId);
  if (peer === undefined) return;
  peer.send(bytes, true);
  counters.forwarded++;
}

/** Every live seat except the sender. Guests never reach this path; only the host may broadcast. */
function broadcastFrom(room: Room, senderConnId: number, bytes: Uint8Array): void {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const seat = room.seats[i] as Seat;
    if (seat.state !== SEAT_STATE.LIVE) continue;
    if (seat.connId === senderConnId) continue;
    const peer = sockets.get(seat.connId);
    if (peer === undefined) continue;
    peer.send(bytes, true);
    counters.forwarded++;
  }
  counters.broadcast++;
}

function handleGameMessage(ws: Socket, bytes: Uint8Array): void {
  const connId = ws.data.connId;
  const room = registry.roomOf(connId);
  if (room === null) {
    ws.close(1008, "not_seated");
    return;
  }

  // A message of any kind is proof the connection is alive, so it defers idle reaping. This is the
  // only thing the relay does with a packet before deciding whether it is allowed to exist.
  registry.touch(connId);

  const senderIsHost = registry.isHost(connId);
  const senderSlot = registry.slotOf(connId);

  // Note what this call is given: four bytes and a fact from the room. Not the body, and not the
  // sender's opinion of who it is.
  routeFor(bytes, senderIsHost, decision);

  if (decision.kind === ROUTE.DROP) {
    countDrop(decision.reason);
    return;
  }

  if (decision.kind === ROUTE.SERVER) {
    // The only type the relay answers itself is a clean departure.
    depart(connId, true);
    ws.close(1000, "left");
    return;
  }

  // Overwrite the sender byte with the seat this genuinely came from. A relay-backed host has one
  // socket for the whole room, so this is the only place "who sent it" can live — and a client's own
  // claim is worth nothing, so it is erased rather than checked.
  setSender(bytes, senderSlot);

  if (decision.kind === ROUTE.TO_HOST) {
    sendTo(room, room.hostSlot, bytes);
    return;
  }
  if (decision.kind === ROUTE.TO_SLOT) {
    sendTo(room, decision.slot, bytes);
    return;
  }
  if (decision.kind === ROUTE.BROADCAST) {
    broadcastFrom(room, connId, bytes);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Server                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const server = Bun.serve<ConnData, never>({
  port: PORT,
  idleTimeout: 60,

  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        rooms: registry.stats,
        traffic: counters,
        sockets: sockets.size,
      });
    }

    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });

    const wanted = readAdmission(url);
    if (wanted === null) return Response.json({ error: "bad_request" }, { status: 400 });

    const connId = nextConnId++;
    const seated = admit(connId, wanted);
    if (seated === null) {
      const reason = joinRefusal(joinResult.status);
      // Upgrade anyway, purely so the reason can be spoken on a channel the client can actually read.
      // No seat was taken, so there is nothing to clean up if the client hangs up first.
      const refused = srv.upgrade(req, {
        data: { connId, seated: false, refusal: reason } satisfies ConnData,
      });
      if (refused) return undefined;
      return Response.json({ error: reason }, { status: 409 });
    }

    const upgraded = srv.upgrade(req, {
      data: { connId, seated: true, refusal: null } satisfies ConnData,
    });
    if (upgraded) return undefined;

    // The upgrade failed after the seat was taken, so give it back rather than leak it.
    depart(connId, true);
    return new Response("upgrade required", { status: 426 });
  },

  websocket: {
    maxPayloadLength: MAX_MESSAGE_BYTES * 4,
    perMessageDeflate: false,

    open(ws) {
      if (ws.data.refusal !== null) {
        // Say why, then go. Nothing is registered, so the close handler has nothing to undo.
        sendControl(ws, { t: "refused", reason: ws.data.refusal });
        ws.close(CLOSE_REFUSED, ws.data.refusal);
        return;
      }
      sockets.set(ws.data.connId, ws);
      const room = registry.roomOf(ws.data.connId);
      if (room === null) {
        ws.close(1011, "lost_seat");
        return;
      }
      const slot = registry.slotOf(ws.data.connId);

      // The seat token is the one secret in the whole protocol and it goes to exactly one socket.
      sendControl(ws, {
        t: "seated",
        slot,
        token: (room.seats[slot] as Seat).token,
        room: roomView(room),
      });
      controlToRoom(room, ws.data.connId, { t: "peer_joined", slot, room: roomView(room) });
    },

    message(ws, raw) {
      if (typeof raw === "string") {
        // Clients have nothing to say on the control channel. Ignoring it costs nothing and means a
        // future lobby feature cannot be spoofed by something shipped today.
        return;
      }
      handleGameMessage(ws, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    },

    close(ws) {
      if (!ws.data.seated) return;
      ws.data.seated = false;
      // Not graceful: a socket that closed without saying LEAVE is a player whose connection died,
      // and their seat is held for them.
      depart(ws.data.connId, false);
    },
  },
});

setInterval(() => {
  registry.sweep(sweepReport);
  announceSweep();
}, SWEEP_INTERVAL_MS);

console.log(`relay listening on :${server.port}`);
