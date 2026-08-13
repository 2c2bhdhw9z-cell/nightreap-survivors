/**
 * Wire protocol constants for 1-4 player co-op.
 *
 * DESIGN RECAP (see plan.md §2)
 * The host is authoritative and is itself a player. The server is a dumb relay plus matchmaking —
 * it never simulates, so it costs almost nothing to run. Guests predict locally from their own
 * input and get corrected by two mechanisms:
 *
 *   1. HOST_EVENTS  — spawns, damage, deaths, chests, card draws and batch level-ups are host
 *                     decisions. Guests never invent them.
 *   2. CORRECTION   — a rolling sweep of ~5% of live enemies per tick, nearest-first round-robin,
 *                     so anything visibly close to a player is re-synced within a few frames while
 *                     off-screen drift is allowed to accumulate harmlessly.
 *
 * STATE_HASH every ~2s is the safety net: if a guest's hash disagrees it asks for a compact
 * resync rather than trying to reason about what diverged.
 *
 * FRAMING
 * Binary `DataView` throughout, never JSON. Every message is a 4-byte header
 * (`type:u8, flags:u8, playerId:u8, reserved:u8`) followed by a type-specific body. Bun's native
 * WebSocket carries these as binary frames; the relay reads only the header and forwards.
 *
 * VERSIONING
 * `PROTOCOL_VERSION` is checked in HELLO/WELCOME. Mismatched builds refuse to play together rather
 * than desync in a way that looks like a bug. Bump it on ANY layout change below.
 */

export const PROTOCOL_VERSION = 2;

/** Hard ceiling on party size. Sized so per-player arrays can be flat and preallocated. */
export const MAX_PLAYERS = 4;

/** Sentinel for "no player" / unassigned slot. */
export const NO_PLAYER = 0xff;

/** The host always occupies slot 0 in a fresh session. Host migration reassigns this. */
export const HOST_SLOT = 0;

/**
 * Ticks of input delay before a local input is applied. Two ticks at 60Hz is ~33ms, which hides
 * one-way latency up to that point without perceptible lag, and local prediction covers the rest.
 */
export const INPUT_DELAY_TICKS = 2;

/** How many past ticks of input we retain per player. Also the resim window ceiling. */
export const INPUT_HISTORY_TICKS = 256;

/** Guests send inputs in small batches to amortise packet overhead without adding real latency. */
export const INPUT_BATCH_TICKS = 3;

/** Interval between authoritative state hashes, in ticks (~2s at 60Hz). */
export const STATE_HASH_INTERVAL_TICKS = 120;

/**
 * Drift ceiling. If a guest is further than this behind or ahead of the host clock it stops trying
 * to catch up smoothly and hard-snaps, because beyond ~0.3s the smooth path looks worse than a cut.
 */
export const MAX_DRIFT_TICKS = 18;

/** Message type ids. Never renumber — append only, and bump PROTOCOL_VERSION. */
export const MSG = {
  /** guest -> server -> host: join request, carries protocol version and display name. */
  HELLO: 1,
  /** host -> guest: slot assignment, session seed, modifier stack, current tick. */
  WELCOME: 2,
  /** guest -> host: a batch of input frames. Also host -> guests as a merged batch. */
  INPUT_BATCH: 3,
  /** host -> guests: authoritative events for a tick range. */
  HOST_EVENTS: 4,
  /** host -> guests: state hash checkpoint. */
  STATE_HASH: 5,
  /** guest -> host: my hash disagreed, send me a resync. */
  RESYNC_REQUEST: 6,
  /** host -> guest: compact snapshot, possibly chunked. */
  RESYNC_CHUNK: 7,
  /** host -> guests: rolling correction sweep for a slice of entities. */
  CORRECTION: 8,
  /** either direction: RTT probe. */
  PING: 9,
  PONG: 10,
  /** either direction: clean disconnect. */
  LEAVE: 11,
  /** server -> all: the host went away, here is the new host slot. */
  HOST_MIGRATE: 12,
  /**
   * host -> guests: the confirmed input record for a run of ticks.
   *
   * This is the backbone of the session. Because the simulation is deterministic given a seed and a
   * per-tick input record, a guest that replays the host's confirmed records produces the identical
   * world without being told a single spawn or damage number. HOST_EVENTS and CORRECTION exist for
   * the cases determinism cannot cover on its own (a late joiner, a guest that fell too far behind),
   * not for the steady state.
   */
  TICK_CONFIRM: 13,
  /** guest -> host: I tapped a level-up card. Advisory; the host decides and confirms it. */
  CARD_REQUEST: 14,
  /**
   * guest -> host: these snapshot chunks never arrived, send them again.
   *
   * A resync happens precisely when the connection is bad, so assuming the snapshot itself arrives
   * intact is the one assumption guaranteed to be wrong. Naming the missing chunks costs two bytes
   * each and repairs a 10%-loss stream in a couple of passes; re-sending the whole snapshot on a
   * timeout would, at that loss rate, essentially never complete.
   */
  RESYNC_NACK: 15,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/** Byte length of the common header on every message. */
export const HEADER_BYTES = 4;

/** Header field offsets. */
export const HDR_TYPE = 0;
export const HDR_FLAGS = 1;
export const HDR_PLAYER = 2;
export const HDR_RESERVED = 3;

/**
 * Largest datagram we will construct. WebSocket has no practical limit but staying under a typical
 * MTU-ish size keeps latency predictable and forces RESYNC to chunk rather than stall the socket.
 */
export const MAX_MESSAGE_BYTES = 1200;

/** Ticks a guest waits for a quiet resync stream before naming the chunks it is missing. */
export const RESYNC_NACK_WAIT_TICKS = 18;

/** Most chunk indices named in one RESYNC_NACK. Two bytes each, so 256 fits inside a message. */
export const MAX_NACK_CHUNKS = 256;

/** How long the host keeps a served snapshot around to answer repair requests from. */
export const RESYNC_KEEP_TICKS = 240;

/** Room codes are 6 characters from an ambiguity-free alphabet (no O/0, I/1, S/5). */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ23467889";

/** Fraction of live enemies re-synced per tick by the rolling sweep, in percent. */
export const CORRECTION_SWEEP_PERCENT = 5;

/** Entities per CORRECTION message. 12 bytes each keeps us far inside MAX_MESSAGE_BYTES. */
export const CORRECTION_ENTITY_BYTES = 12;
export const CORRECTION_MAX_ENTITIES = 64;

/**
 * Ticks of input the host resends in every TICK_CONFIRM.
 *
 * Retransmission, not acknowledgement. A dropped confirm is repaired by the next one instead of by a
 * round trip, which matters because a round trip at 150ms costs nine ticks and the thing we are
 * repairing is worth four bytes. Sized to keep the message inside MAX_MESSAGE_BYTES at four players.
 */
export const CONFIRM_REDUNDANCY_TICKS = 64;

/**
 * Ticks of input actually resent in a steady-state confirm.
 *
 * The window above is the widest the message format can carry; this is what a healthy connection is
 * worth. Confirms go out every three ticks, so a 24-tick window already sends every record eight
 * times over — at 2% loss the odds of all eight copies vanishing are one in fifty trillion, and the
 * host is a phone paying for every byte it uploads. Four players at the full 64 would cost the host
 * about 66KB a second; at 24 it costs 25KB, and the repair story is unchanged. Anything a guest is
 * missing beyond this window was a real outage, and a real outage is answered with a snapshot.
 */
export const CONFIRM_WINDOW_TICKS = 24;

/**
 * How often the host broadcasts confirms, in ticks. Three ticks is 50ms — small enough to be
 * invisible, large enough that we send twenty packets a second rather than sixty.
 */
export const CONFIRM_INTERVAL_TICKS = 3;

/**
 * How far behind the confirmed horizon a guest may fall before it stops waiting and asks for a
 * snapshot instead. Beyond this the missing records have aged out of the retransmission window, so
 * waiting longer cannot help.
 */
export const RESYNC_AFTER_STALL_TICKS = 90;
