/**
 * What the relay does with a message it has just received.
 *
 * THE RELAY NEVER READS A BODY
 * It looks at the 4-byte header and nothing else: type, sender slot, destination. It cannot tell a
 * spawn from a damage number and does not want to, which is what keeps it stateless, cheap, and
 * incapable of being the reason a run desyncs. Everything below is a decision made from four bytes.
 *
 * ROLE ENFORCEMENT IS THE CHEAP ANTI-CHEAT
 * Each message type has exactly one legal sender role. Only the host may send a TICK_CONFIRM; only a
 * guest may send an INPUT_BATCH; HOST_MIGRATE is authored by the relay itself and is illegal from
 * anyone. A modded guest that forges a confirm is dropped at the relay without the host ever seeing
 * the bytes. This is not the ladder's defence — that is server-side revalidation (plan.md §5b) — but
 * it costs one array lookup and removes the entire class of "guest pretends to be host".
 *
 * WHY GUESTS CANNOT REACH EACH OTHER
 * A guest's only legal destination is the host, so a guest never addresses anything. The relay routes
 * guest traffic to the room's host by definition. There is no message a guest can construct that
 * arrives at another guest, which means the abuse surface between players is the host's own code, not
 * the network.
 */

import {
  HDR_DEST,
  HDR_PLAYER,
  HDR_TYPE,
  HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MSG,
  RELAY_BROADCAST,
} from "./protocol";

/** What to do with the message. */
export const ROUTE = {
  /** Illegal, malformed, or from a sender with no business sending it. Say nothing, just drop. */
  DROP: 0,
  /** Forward verbatim to the room's host. */
  TO_HOST: 1,
  /** Forward verbatim to one guest, named in `slot`. */
  TO_SLOT: 2,
  /** Forward verbatim to every member except the sender. */
  BROADCAST: 3,
  /** The relay handles this one itself and forwards nothing (HELLO, LEAVE, PING). */
  SERVER: 4,
} as const;

export type RouteKind = (typeof ROUTE)[keyof typeof ROUTE];

/** Reason a message was dropped. Counters only — the relay never explains itself to a client. */
export const DROP_REASON = {
  NONE: 0,
  /** Shorter than a header, or longer than any message we are willing to forward. */
  MALFORMED: 1,
  /** Type id we do not know. A newer build talking to an older relay. */
  UNKNOWN_TYPE: 2,
  /** Legal type, wrong role — a guest sending host-authoritative state, or vice versa. */
  WRONG_ROLE: 3,
  /** Host addressed a slot that is out of range. */
  BAD_DESTINATION: 4,
  /** Only the relay may author this type. */
  SERVER_AUTHORED: 5,
} as const;

/** Caller-owned result, so routing a message allocates nothing. */
export interface RouteDecision {
  kind: number;
  /** Destination slot when `kind` is TO_SLOT. Meaningless otherwise. */
  slot: number;
  /** Set when `kind` is DROP. */
  reason: number;
}

export function createRouteDecision(): RouteDecision {
  return { kind: ROUTE.DROP, slot: 0, reason: DROP_REASON.NONE };
}

/** Who is allowed to author a message type. */
export const SENDER_ROLE = {
  /** Not a type we know. */
  UNKNOWN: 0,
  /** Host only. Guests forging these is the whole reason this table exists. */
  HOST: 1,
  /** Guests only. */
  GUEST: 2,
  /** Either side. */
  ANY: 3,
  /** The relay itself. Illegal from any client. */
  SERVER: 4,
} as const;

/**
 * Role table, indexed by message type id.
 *
 * A flat array rather than a switch so adding a type is a one-line data change and so the lookup is
 * a single load on the hot path. Sized past the highest known id; anything unlisted reads as UNKNOWN
 * and is therefore dropped, which is the correct default for a type this build has never heard of.
 */
const ROLE_BY_TYPE = new Uint8Array(32);
ROLE_BY_TYPE[MSG.HELLO] = SENDER_ROLE.GUEST;
ROLE_BY_TYPE[MSG.WELCOME] = SENDER_ROLE.HOST;
ROLE_BY_TYPE[MSG.INPUT_BATCH] = SENDER_ROLE.GUEST;
ROLE_BY_TYPE[MSG.HOST_EVENTS] = SENDER_ROLE.HOST;
ROLE_BY_TYPE[MSG.STATE_HASH] = SENDER_ROLE.HOST;
ROLE_BY_TYPE[MSG.RESYNC_REQUEST] = SENDER_ROLE.GUEST;
ROLE_BY_TYPE[MSG.RESYNC_CHUNK] = SENDER_ROLE.HOST;
ROLE_BY_TYPE[MSG.CORRECTION] = SENDER_ROLE.HOST;
ROLE_BY_TYPE[MSG.PING] = SENDER_ROLE.ANY;
ROLE_BY_TYPE[MSG.PONG] = SENDER_ROLE.ANY;
ROLE_BY_TYPE[MSG.LEAVE] = SENDER_ROLE.ANY;
ROLE_BY_TYPE[MSG.HOST_MIGRATE] = SENDER_ROLE.SERVER;
ROLE_BY_TYPE[MSG.TICK_CONFIRM] = SENDER_ROLE.HOST;
ROLE_BY_TYPE[MSG.CARD_REQUEST] = SENDER_ROLE.GUEST;
ROLE_BY_TYPE[MSG.RESYNC_NACK] = SENDER_ROLE.GUEST;

/** Role for a message type. Exported for the tests and for the relay's own counters. */
export function roleFor(type: number): number {
  if (type < 0 || type >= ROLE_BY_TYPE.length) return SENDER_ROLE.UNKNOWN;
  return ROLE_BY_TYPE[type] as number;
}

/**
 * Types the relay answers itself instead of forwarding.
 *
 * HELLO is a join, LEAVE is a departure, PING is an RTT probe the relay can answer faster than the
 * host can. Everything else is somebody else's business.
 */
function serverHandled(type: number): boolean {
  return type === MSG.HELLO || type === MSG.LEAVE || type === MSG.PING;
}

/**
 * Decide where a message goes, from its header alone.
 *
 * `senderIsHost` comes from the room, not from the message — a client claiming to be the host in a
 * field it wrote itself is worth nothing.
 */
export function routeFor(
  bytes: Uint8Array,
  senderIsHost: boolean,
  out: RouteDecision,
): RouteDecision {
  out.slot = 0;
  out.reason = DROP_REASON.NONE;

  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_MESSAGE_BYTES) {
    out.kind = ROUTE.DROP;
    out.reason = DROP_REASON.MALFORMED;
    return out;
  }

  const type = bytes[HDR_TYPE] as number;
  const role = roleFor(type);

  if (role === SENDER_ROLE.UNKNOWN) {
    out.kind = ROUTE.DROP;
    out.reason = DROP_REASON.UNKNOWN_TYPE;
    return out;
  }
  if (role === SENDER_ROLE.SERVER) {
    out.kind = ROUTE.DROP;
    out.reason = DROP_REASON.SERVER_AUTHORED;
    return out;
  }
  if (role === SENDER_ROLE.HOST && !senderIsHost) {
    out.kind = ROUTE.DROP;
    out.reason = DROP_REASON.WRONG_ROLE;
    return out;
  }
  if (role === SENDER_ROLE.GUEST && senderIsHost) {
    out.kind = ROUTE.DROP;
    out.reason = DROP_REASON.WRONG_ROLE;
    return out;
  }

  if (serverHandled(type)) {
    out.kind = ROUTE.SERVER;
    return out;
  }

  // A guest never addresses anything: its one legal destination is the host.
  if (!senderIsHost) {
    out.kind = ROUTE.TO_HOST;
    return out;
  }

  const dest = bytes[HDR_DEST] as number;
  if (dest === RELAY_BROADCAST) {
    out.kind = ROUTE.BROADCAST;
    return out;
  }
  if (dest >= MAX_PLAYERS) {
    out.kind = ROUTE.DROP;
    out.reason = DROP_REASON.BAD_DESTINATION;
    return out;
  }
  out.kind = ROUTE.TO_SLOT;
  out.slot = dest;
  return out;
}

/**
 * Stamp the relay destination into a finished message.
 *
 * Called by the sending side after `Writer.finish()`, which is safe because the writer's buffer is
 * still the message and links copy on send. Separate from the encoders so no encoder has to know a
 * relay exists — direct-link play stamps the byte and nothing reads it.
 */
export function setDestination(bytes: Uint8Array, slot: number): void {
  if (bytes.byteLength < HEADER_BYTES) return;
  bytes[HDR_DEST] = slot;
}

/** Sender slot as written by the author. Advisory — the relay trusts the room, not this field. */
export function claimedSlot(bytes: Uint8Array): number {
  if (bytes.byteLength < HEADER_BYTES) return -1;
  return bytes[HDR_PLAYER] as number;
}
