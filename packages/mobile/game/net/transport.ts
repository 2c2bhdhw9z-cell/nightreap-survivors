/**
 * The client end of the wire: how a phone gets onto a relay and stays there.
 *
 * WHAT THIS IS FOR
 * `HostSession` and `GuestSession` already work — they have been tested for a long time against an
 * in-process latency simulator. What they have never had is a real socket. This module is that socket,
 * shaped so the sessions do not change by a single line: it hands them a `Link`, feeds `receive` the
 * bytes that arrive, and takes care of everything a session deliberately knows nothing about.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never reads a message body. Exactly like the relay, it looks at the four header bytes and passes
 * the rest through. A transport that starts to understand game messages is a second copy of the
 * protocol, and two copies drift.
 *
 * NO SOCKET IN HERE EITHER
 * `RawSocket` is the same trick as `Link`: the smallest thing a WebSocket happens to be. React
 * Native's WebSocket satisfies it, Bun's satisfies it, and the fake in the tests satisfies it, so the
 * reconnect logic — which is the part that is actually hard and the part that only misbehaves on a
 * train — is tested without any networking at all.
 *
 * ONE CLOCK, INJECTED
 * `now` and `random` come in through options for the same reason the room registry takes them: a
 * reconnect policy that reads a global clock can only be tested by waiting, and nobody writes a test
 * that waits forty-five seconds, which means the reconnect path ships unverified.
 */

import { claimedSlot } from "./routing";
import { HDR_TYPE, HEADER_BYTES, MAX_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "./protocol";
import { Writer } from "./codec";
import { encodeLeave, LEAVE_REASON } from "./messages";

/* ---------------------------------------------------------------------------------------------- */
/* Admission                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** How we are asking to get in. Mirrors the relay's four admission modes exactly. */
export const JOIN_MODE = {
  /** Open a new room and be its host. */
  CREATE: "create",
  /** Join a specific room by its six-character code. */
  JOIN: "join",
  /** Be matched into any public room of the requested party size. */
  QUICK: "quick",
  /** Reclaim a seat we were dropped from, using the token we were issued. */
  REJOIN: "rejoin",
} as const;

export type JoinMode = (typeof JOIN_MODE)[keyof typeof JOIN_MODE];

export interface Admission {
  mode: JoinMode;
  /** Party size for CREATE and QUICK. Ignored by the others. */
  size: number;
  /** Room code for JOIN and REJOIN. */
  code: string;
  /** Seat token for REJOIN, issued in the `seated` frame. Zero means none. */
  token: number;
  /** Whether a created room is listed for quick play. */
  isPublic: boolean;
}

export function createAdmission(): Admission {
  return { mode: JOIN_MODE.QUICK, size: MAX_PLAYERS, code: "", token: 0, isPublic: false };
}

/**
 * Fold a typed room code into what the relay will accept.
 *
 * Players type codes off a friend's screen, so lowercase happens, spaces and dashes happen, and the
 * characters the alphabet leaves out on purpose (I, O, S, 0, 1, 5) get typed in place of the ones that
 * look like them. Repairing the pairs that have exactly one sane target is worth it: the alternative is
 * telling someone their code is wrong when they read it correctly off a low-resolution screenshot.
 *
 * ONLY CHARACTERS THE ALPHABET LEAVES OUT MAY BE REPAIRED.
 * A repair rewrites what the player typed into a different character, so it is only ever safe for a
 * character that could NOT have been in the real code. `I`, `1`, `O` and `0` are absent from the
 * alphabet, so a typed `I`/`1` can only have meant `J` and a typed `O`/`0` can only have meant `Q`.
 * `L`, on the other hand, IS in the alphabet — a real code can and does contain `L` (e.g. `L3KND3`) —
 * so remapping `L` to `J` here rewrote valid codes into codes no room had, and the host's room came
 * back "no such room" even though the guest read the code correctly. `L` therefore maps to itself.
 *
 * S and 5 are deliberately NOT repaired. Both are absent from the alphabet, so there is nothing to map
 * them onto — a guess here would turn a typo into a different valid-looking code, which is worse than
 * refusing it. They are simply dropped, and the code then fails the length check.
 */
export function normalizeCode(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length && out.length < ROOM_CODE_LENGTH; i++) {
    let ch = raw.charAt(i).toUpperCase();
    if (ch === "O") ch = "Q";
    else if (ch === "0") ch = "Q";
    else if (ch === "I") ch = "J";
    else if (ch === "1") ch = "J";
    // NOTE: `L` is a legal alphabet character and must NOT be repaired — see the header.
    if (ROOM_CODE_ALPHABET.indexOf(ch) >= 0) out += ch;
  }
  return out;
}

/** True when a code is the right length and made only of legal characters. */
export function isCompleteCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (ROOM_CODE_ALPHABET.indexOf(code.charAt(i)) < 0) return false;
  }
  return true;
}

/**
 * Build the connect URL. Admission happens in this string and nowhere else — by the time a socket
 * exists the relay has already decided whether we have a seat, which is why a refusal cannot leave a
 * half-joined room behind.
 */
export function connectUrl(base: string, a: Admission): string {
  const root = base.replace(/\/+$/, "");
  const q: string[] = [`mode=${a.mode}`];
  if (a.mode === JOIN_MODE.CREATE || a.mode === JOIN_MODE.QUICK) {
    q.push(`size=${a.size}`);
  }
  if (a.mode === JOIN_MODE.CREATE) {
    q.push(`vis=${a.isPublic ? "public" : "private"}`);
  }
  if (a.mode === JOIN_MODE.JOIN || a.mode === JOIN_MODE.REJOIN) {
    q.push(`code=${encodeURIComponent(a.code)}`);
  }
  if (a.mode === JOIN_MODE.REJOIN) {
    q.push(`token=${a.token >>> 0}`);
  }
  return `${root}/ws?${q.join("&")}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Control frames — text, and only ever authored by the relay                                      */
/* ---------------------------------------------------------------------------------------------- */

export const SEAT_VIEW = { EMPTY: "empty", LIVE: "live", HELD: "held" } as const;
export type SeatView = (typeof SEAT_VIEW)[keyof typeof SEAT_VIEW];

/** The room as the lobby is allowed to draw it. No tokens, ever. */
export interface RoomView {
  code: string;
  hostSlot: number;
  targetSize: number;
  isPublic: boolean;
  seats: SeatView[];
}

export function createRoomView(): RoomView {
  return { code: "", hostSlot: -1, targetSize: 0, isPublic: false, seats: [] };
}

export const CONTROL = {
  /** Unrecognised, malformed, or from a future build. Ignored, never fatal. */
  NONE: 0,
  SEATED: 1,
  PEER_JOINED: 2,
  PEER_LEFT: 3,
  /** The relay is telling us why we are not getting in, then hanging up. */
  REFUSED: 4,
} as const;

export interface ControlFrame {
  kind: number;
  slot: number;
  token: number;
  /** True when a departing peer's seat is being held for their return. */
  held: boolean;
  /** Refusal reason, verbatim from the relay. */
  reason: string;
  room: RoomView;
}

function readSeats(value: unknown): SeatView[] {
  const out: SeatView[] = [];
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length && i < MAX_PLAYERS; i++) {
    const s = value[i];
    out.push(s === SEAT_VIEW.LIVE || s === SEAT_VIEW.HELD ? s : SEAT_VIEW.EMPTY);
  }
  return out;
}

function readRoom(value: unknown): RoomView {
  const view = createRoomView();
  if (value === null || typeof value !== "object") return view;
  const o = value as Record<string, unknown>;
  view.code = typeof o.code === "string" ? o.code : "";
  view.hostSlot = typeof o.hostSlot === "number" ? o.hostSlot : -1;
  view.targetSize = typeof o.targetSize === "number" ? o.targetSize : 0;
  view.isPublic = o.public === true;
  view.seats = readSeats(o.seats);
  return view;
}

/**
 * Parse a control frame. Never throws.
 *
 * A transport that can be killed by a malformed text frame is a transport that can be killed by a
 * proxy injecting one, so every field is checked and anything unrecognised becomes NONE rather than an
 * exception in the middle of a run.
 */
export function parseControl(text: string): ControlFrame {
  const frame: ControlFrame = {
    kind: CONTROL.NONE,
    slot: -1,
    token: 0,
    held: false,
    reason: "",
    room: createRoomView(),
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return frame;
  }
  if (raw === null || typeof raw !== "object") return frame;
  const o = raw as Record<string, unknown>;

  if (o.t === "seated") frame.kind = CONTROL.SEATED;
  else if (o.t === "peer_joined") frame.kind = CONTROL.PEER_JOINED;
  else if (o.t === "peer_left") frame.kind = CONTROL.PEER_LEFT;
  else if (o.t === "refused") frame.kind = CONTROL.REFUSED;
  else return frame;

  if (typeof o.slot === "number" && Number.isInteger(o.slot)) frame.slot = o.slot;
  if (typeof o.token === "number" && Number.isInteger(o.token)) frame.token = o.token >>> 0;
  frame.held = o.held === true;
  if (typeof o.reason === "string") frame.reason = o.reason;
  frame.room = readRoom(o.room);
  return frame;
}

/* ---------------------------------------------------------------------------------------------- */
/* The socket, reduced to what we use                                                              */
/* ---------------------------------------------------------------------------------------------- */

export interface RawSocket {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onBinary(bytes: Uint8Array): void;
  onClose(code: number): void;
  onError(): void;
}

/** Opens a socket and wires it to the handlers. The app passes a real WebSocket, tests pass a fake. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => RawSocket;

/* ---------------------------------------------------------------------------------------------- */
/* Reconnect policy                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** How long the relay holds a dropped seat. Reconnecting after this is pointless — the seat is gone. */
export const SEAT_GRACE_MS = 45_000;

/** First retry delay. Short, because most drops are a two-second tunnel. */
export const RECONNECT_BASE_MS = 400;

/** Ceiling on the backoff, so a long outage still retries often enough to catch the grace window. */
export const RECONNECT_MAX_MS = 6_000;

/**
 * Wait before retry number `attempt`, jittered.
 *
 * Jitter is not politeness here: four players on the same wifi all drop on the same router hiccup and
 * would otherwise all retry on the same millisecond forever, which is the one pattern guaranteed to
 * make a weak router drop them again.
 */
export function backoffMs(attempt: number, random: () => number): number {
  const exponent = attempt < 0 ? 0 : attempt > 8 ? 8 : attempt;
  const flat = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent);
  const jitter = 0.75 + random() * 0.5;
  return Math.round(flat * jitter);
}

/** A close code we chose ourselves, so a deliberate hang-up is never mistaken for a lost connection. */
export const CLOSE_INTENTIONAL = 4000;

/**
 * Close code for a connection we are giving up on without giving up the seat.
 *
 * Used when the OS tells us the network went away, and by the end-to-end test to reproduce a tunnel.
 * The relay treats every close that was not preceded by a goodbye the same way, so the code itself is
 * only there to keep the two cases apart in logs.
 */
export const CLOSE_LOST = 4002;

/* ---------------------------------------------------------------------------------------------- */
/* Transport state                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

export const LINK_STATE = {
  /** Nothing open, nothing wanted. */
  IDLE: 0,
  /** A socket is opening, or reopening after a drop. */
  CONNECTING: 1,
  /** Open, seated, and carrying traffic. */
  READY: 2,
  /** Dropped, waiting out a backoff before trying again. */
  WAITING: 3,
  /** Finished for good: quit, refused, or out of retries. Nothing further happens by itself. */
  DEAD: 4,
} as const;

export interface TransportEvents {
  /** Seated and ready. `resumed` is true when this was a reconnect rather than a first join. */
  onReady(slot: number, room: RoomView, resumed: boolean): void;
  /** A control frame the lobby cares about. */
  onControl(frame: ControlFrame): void;
  /**
   * A game message arrived. `senderSlot` is the relay-stamped seat, already trustworthy, so a host
   * can hand it straight to `receive` without deciding whether to believe it.
   */
  onGame(bytes: Uint8Array, senderSlot: number): void;
  /** Connection lost; a retry is scheduled. */
  onDropped(): void;
  /** Over for good. `reason` is the relay's word when it gave one. */
  onDead(reason: string): void;
}

export interface TransportOptions {
  baseUrl: string;
  open: SocketFactory;
  now: () => number;
  random: () => number;
  events: TransportEvents;
}

/**
 * One connection to one relay, with the reconnect behaviour a phone actually needs.
 *
 * The rules it enforces, all of which came out of how mobile connections really fail:
 *
 *  - A drop is not a quit. Losing the socket schedules a rejoin with the seat token; pressing quit
 *    closes with our own code and never retries.
 *  - Retries stop at the grace window. Once the relay has given the seat away there is nothing to
 *    reconnect to, so we stop and say so instead of retrying into a wall for ten minutes.
 *  - Game bytes sent while disconnected are dropped, not queued. Every message in this protocol is
 *    about a specific tick; delivering a stack of them four seconds late is worse than never sending
 *    them, and the session already repairs gaps.
 */
export class Transport {
  private readonly o: TransportOptions;
  private socket: RawSocket | null = null;
  private admission: Admission = createAdmission();

  state: number = LINK_STATE.IDLE;
  /** Our seat, or -1 before the first `seated` frame. */
  slot = -1;
  /** Our seat token. Never leaves this object except in a rejoin URL. */
  private token = 0;
  room: RoomView = createRoomView();

  /** Retries since the last successful open. */
  attempt = 0;
  /** When the current retry becomes due, per the injected clock. -1 when none is pending. */
  retryDueMs = -1;
  /** When we lost the seat, so we can stop retrying once the grace window has passed. */
  private droppedAtMs = -1;
  private hasBeenReady = false;
  /** Only ever used to write the single goodbye message. */
  private readonly writer = new Writer();

  readonly stats = {
    opens: 0,
    reconnects: 0,
    sent: 0,
    received: 0,
    /** Sends attempted while not connected. A steady climb here is a bug, not bad wifi. */
    droppedSends: 0,
    /** Text frames we could not make sense of. Should stay zero against our own relay. */
    badControl: 0,
    /** Binary frames too short to have a header. */
    badGame: 0,
  };

  constructor(options: TransportOptions) {
    this.o = options;
  }

  /** Start connecting. Any existing connection is abandoned first. */
  connect(admission: Admission): void {
    this.admission = { ...admission };
    this.hasBeenReady = false;
    this.attempt = 0;
    this.droppedAtMs = -1;
    this.slot = -1;
    this.token = 0;
    this.openSocket();
  }

  private openSocket(): void {
    this.state = LINK_STATE.CONNECTING;
    this.retryDueMs = -1;
    this.stats.opens++;
    const url = connectUrl(this.o.baseUrl, this.admission);
    this.socket = this.o.open(url, {
      onOpen: () => this.handleOpen(),
      onText: (t) => this.handleText(t),
      onBinary: (b) => this.handleBinary(b),
      onClose: (c) => this.handleClose(c),
      onError: () => {
        /* A socket error is always followed by a close, and the close is where the decision lives. */
      },
    });
  }

  private handleOpen(): void {
    // Being open is not being seated. The `seated` frame is what makes us a player, and until it
    // arrives we have a socket and no seat, which is not a state the game should ever be shown.
  }

  private handleText(text: string): void {
    const frame = parseControl(text);
    if (frame.kind === CONTROL.NONE) {
      this.stats.badControl++;
      return;
    }
    if (frame.kind === CONTROL.REFUSED) {
      this.die(frame.reason === "" ? "refused" : frame.reason);
      return;
    }
    if (frame.kind === CONTROL.SEATED) {
      this.slot = frame.slot;
      this.token = frame.token;
      this.room = frame.room;
      this.state = LINK_STATE.READY;
      const resumed = this.hasBeenReady;
      if (resumed) this.stats.reconnects++;
      this.hasBeenReady = true;
      this.attempt = 0;
      this.droppedAtMs = -1;
      // From here on a reconnect is a rejoin of this specific seat, whatever we originally asked for.
      this.admission = {
        mode: JOIN_MODE.REJOIN,
        size: this.admission.size,
        code: frame.room.code,
        token: frame.token,
        isPublic: this.admission.isPublic,
      };
      this.o.events.onReady(this.slot, this.room, resumed);
      return;
    }
    this.room = frame.room;
    this.o.events.onControl(frame);
  }

  private handleBinary(bytes: Uint8Array): void {
    if (bytes.length < HEADER_BYTES) {
      this.stats.badGame++;
      return;
    }
    this.stats.received++;
    // The type byte is read only so a caller can log it; the body is never inspected here.
    void bytes[HDR_TYPE];
    this.o.events.onGame(bytes, claimedSlot(bytes));
  }

  private handleClose(code: number): void {
    this.socket = null;
    if (this.state === LINK_STATE.DEAD) return;
    if (code === CLOSE_INTENTIONAL) {
      this.state = LINK_STATE.DEAD;
      return;
    }
    // Never seated at all: the relay refused admission and hung up without a word we understood.
    // Retrying a refusal just refuses again.
    if (!this.hasBeenReady) {
      this.die("refused");
      return;
    }
    if (this.droppedAtMs < 0) this.droppedAtMs = this.o.now();
    this.state = LINK_STATE.WAITING;
    this.retryDueMs = this.o.now() + backoffMs(this.attempt, this.o.random);
    this.attempt++;
    this.o.events.onDropped();
  }

  /**
   * Drive retries. Called from the same place the frame loop is driven, so nothing in here needs a
   * timer of its own and a paused app does not silently burn its grace window.
   */
  pump(): void {
    if (this.state !== LINK_STATE.WAITING) return;
    const now = this.o.now();
    if (this.droppedAtMs >= 0 && now - this.droppedAtMs > SEAT_GRACE_MS) {
      this.die("seat_expired");
      return;
    }
    if (this.retryDueMs >= 0 && now >= this.retryDueMs) this.openSocket();
  }

  /** True when game traffic will actually reach the relay right now. */
  get isReady(): boolean {
    return this.state === LINK_STATE.READY && this.socket !== null;
  }

  /**
   * `Link` for the sessions. Handing them this instead of the transport keeps them unable to reconnect
   * or renegotiate anything, which is exactly the amount of network authority a simulation should have.
   */
  link(): { send(bytes: Uint8Array): void } {
    return { send: (bytes: Uint8Array) => this.send(bytes) };
  }

  send(bytes: Uint8Array): void {
    if (!this.isReady) {
      this.stats.droppedSends++;
      return;
    }
    this.stats.sent++;
    (this.socket as RawSocket).send(bytes);
  }

  /** Say something on the lobby's text channel. The relay ignores these today; kept for symmetry. */
  sendText(text: string): void {
    if (!this.isReady) {
      this.stats.droppedSends++;
      return;
    }
    (this.socket as RawSocket).send(text);
  }

  /**
   * Leave on purpose. Frees the seat immediately and stops all retrying.
   *
   * The goodbye matters. The relay cannot tell a closed socket apart from a dead one, so it assumes the
   * worst and holds the seat for the grace window. Saying LEAVE first is the only thing that turns
   * "they will be back" into "they are gone", and without it a player who quits keeps a seat nobody
   * can use for another forty-five seconds.
   */
  quit(): void {
    const sock = this.socket;
    if (sock !== null && this.state === LINK_STATE.READY) {
      sock.send(encodeLeave(this.writer, this.slot < 0 ? 0 : this.slot, LEAVE_REASON.QUIT));
      this.stats.sent++;
    }
    this.state = LINK_STATE.DEAD;
    this.retryDueMs = -1;
    this.socket = null;
    if (sock !== null) sock.close(CLOSE_INTENTIONAL, "quit");
  }

  /**
   * Throw the connection away but keep the seat.
   *
   * This is the deliberate counterpart of `quit`: no goodbye is sent, so the relay holds the seat for
   * the grace window and the normal retry path brings us back into it. The app uses it when the OS
   * reports the network has gone; the tests use it to reproduce a tunnel without waiting for one.
   */
  loseConnection(): void {
    const sock = this.socket;
    if (sock === null) return;
    sock.close(CLOSE_LOST, "lost");
  }

  private die(reason: string): void {
    const sock = this.socket;
    this.state = LINK_STATE.DEAD;
    this.retryDueMs = -1;
    this.socket = null;
    if (sock !== null) sock.close(CLOSE_INTENTIONAL, reason);
    this.o.events.onDead(reason);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The real socket                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

interface WebSocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

/**
 * A `SocketFactory` over the platform WebSocket.
 *
 * The only awkward part is that React Native and Bun disagree about what a binary frame arrives as —
 * `ArrayBuffer` on one, sometimes a view on the other — so both shapes are normalised to a
 * `Uint8Array` here and nothing downstream has to care which platform it is running on.
 */
export function webSocketFactory(): SocketFactory {
  const ctor = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
  if (ctor === undefined) throw new Error("no WebSocket on this platform");
  return (url, handlers) => {
    const ws = new ctor(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (e) => {
      const data = e.data;
      if (typeof data === "string") {
        handlers.onText(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        handlers.onBinary(new Uint8Array(data));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        handlers.onBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      }
    };
    ws.onclose = (e) => handlers.onClose(typeof e.code === "number" ? e.code : 1006);
    ws.onerror = () => handlers.onError();
    return {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
  };
}
