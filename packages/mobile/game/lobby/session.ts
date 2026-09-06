/**
 * The lobby session: one object that owns the connection and the party room together, so that the
 * screens above it own neither.
 *
 * WHY THIS EXISTS
 *
 * `Transport` knows about sockets, seats and reconnects. `Lobby` knows about rosters, chat and who may
 * start. Neither knows about the other, deliberately — both are tested in isolation and both stay that
 * way. But something has to marry them, and if that something lives inside a React screen then the
 * rules of co-op end up in a file that can only be tested by tapping a phone. Every rule below would be
 * untestable there, and every one of them is a rule that breaks a party when it is wrong:
 *
 *  - The relay is the only authority on seats, so a room view arriving on *any* control frame refreshes
 *    the roster, not just the one that seated us.
 *  - Reconnecting is not rejoining: the seat is still ours, but our row on the host was cleared of its
 *    ready flag on the way down, so we re-state who we are and come back NOT ready. Coming back
 *    silently ready would let a party start a run while a phone is still finding wifi.
 *  - A refusal and a hang-up are the same thing to a player — "it did not work" — so both land on one
 *    status with one sentence, and neither retries.
 *  - Nothing the screen does can send anything before we are seated, because a message sent before the
 *    relay has stamped us has no sender.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No timers of its own. `pump` is called from outside, once a frame or on an interval, because a module
 * that installs its own `setInterval` cannot be tested against a clock we own — and the whole reconnect
 * story is about timing.
 *
 * No knowledge of settings beyond the chat policy handed to it, which is already resolved. The lobby
 * does not re-derive whether chat is on; neither does this.
 */

import { CHAT_REJECT, Lobby, START_BLOCK, type LobbyChatPolicy, type ChatLine, type LobbySeatRow } from "./lobby";
import { MAX_PLAYERS } from "../net/protocol";
import {
  LINK_STATE,
  Transport,
  createAdmission,
  type Admission,
  type SocketFactory,
} from "../net/transport";

/* ---------------------------------------------------------------------------------------------- */
/* Status                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the screen shows. Five states, because a player can tell these five apart and cannot tell
 * anything finer apart.
 */
export const LOBBY_STATUS = {
  /** Nothing attempted yet. */
  IDLE: 0,
  /** Asking for a room. The spinner state. */
  JOINING: 1,
  /** In a seat, roster live. The only state the lobby screen is worth drawing in. */
  SEATED: 2,
  /** Connection lost, seat held, retrying. Everything stays on screen, greyed. */
  RECONNECTING: 3,
  /** Over. `reason` says why in words. */
  ENDED: 4,
} as const;

export type LobbyStatus = (typeof LOBBY_STATUS)[keyof typeof LOBBY_STATUS];

/**
 * Refusal reasons the relay can give, mapped to sentences a player can act on.
 *
 * The relay's words are deliberately machine-shaped (`room_full`), and putting them on screen is how a
 * player ends up reading `no_such_room` and filing a bug about it.
 */
const REFUSAL_WORDS: Record<string, string> = {
  room_full: "That party is full.",
  no_such_room: "No party with that code.",
  bad_code: "That code is not a real code.",
  already_seated: "You are already in that party.",
  server_busy: "The server is full right now. Try again in a moment.",
};

/** Turn whatever the relay said into something worth reading. Unknown reasons never leak through. */
export function refusalSentence(reason: string): string {
  const known = REFUSAL_WORDS[reason];
  if (known !== undefined) return known;
  return "Could not join that party.";
}

/* ---------------------------------------------------------------------------------------------- */
/* The view the screens read                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One immutable-enough snapshot of everything a lobby screen draws.
 *
 * Rebuilt only when something actually changed, and handed out by reference in between, so React's
 * `useSyncExternalStore` can compare snapshots by identity and skip a render. Arrays are copied out of
 * the live lobby rather than shared: a screen holding a reference to a mutable seat row would render
 * whatever the network did halfway through the frame.
 */
export interface LobbyView {
  status: number;
  /** Set only in ENDED. A whole sentence, already fit to show. */
  reason: string;
  code: string;
  targetSize: number;
  isPublic: boolean;
  localSlot: number;
  hostSlot: number;
  isHost: boolean;
  liveCount: number;
  seats: LobbySeatRow[];
  chat: ChatLine[];
  /** Why START is refusing, as a `START_BLOCK` code. NONE means it is live. */
  startBlocker: number;
  /** Set when the host has launched. The screen hands over to the run and stops drawing. */
  launched: boolean;
  launchSeed: number;
  launchStageId: number;
  /** The last chat refusal, so the field can say why. Cleared by the next accepted line. */
  lastChatReject: number;
}

export interface LobbySessionOptions {
  baseUrl: string;
  open: SocketFactory;
  now: () => number;
  random: () => number;
  chatPolicy: LobbyChatPolicy;
  /** Our name and character, as chosen before we ever opened this screen. */
  name: string;
  characterId: number;
  isFriend?: (slot: number) => boolean;
  filter?: (raw: string) => { allowed: boolean; text: string };
  /** Fired once, on whoever is in the party, when the run begins. */
  onLaunch?: (seed: number, stageId: number, playerCount: number) => void;
}

/* ---------------------------------------------------------------------------------------------- */

export class LobbySession {
  private readonly o: LobbySessionOptions;
  private readonly transport: Transport;
  private readonly lobby: Lobby;

  private status: number = LOBBY_STATUS.IDLE;
  private reason = "";
  /** Annotated: initialising from one member of the table would narrow this to that member's value. */
  private lastChatReject: number = CHAT_REJECT.OK;

  private name: string;
  private characterId: number;

  /** Bumped whenever anything a screen draws changed. The screen's only trigger to re-render. */
  revision = 0;
  private listeners: (() => void)[] = [];
  private cached: LobbyView | null = null;

  /**
   * Where game bytes go once the run has launched. Null while this is still a lobby.
   *
   * Set by `handOffToRun`, and its presence is the single switch that turns this object from a lobby
   * into a wire the run drives: after it is set, every game frame off the socket is the net session's,
   * not the lobby's.
   */
  private gameSink: ((bytes: Uint8Array, senderSlot: number) => void) | null = null;
  /** True once the run has been handed the connection, so a stray `leave` on unmount cannot close it. */
  private handedOff = false;

  readonly stats = {
    /** Reconnects that got the same seat back. A climb here is a bad connection, not a bug. */
    resumes: 0,
    /** Times we re-stated who we are after a reconnect. */
    reintroductions: 0,
  };

  constructor(options: LobbySessionOptions) {
    this.o = options;
    this.name = options.name;
    this.characterId = options.characterId;

    this.transport = new Transport({
      baseUrl: options.baseUrl,
      open: options.open,
      now: options.now,
      random: options.random,
      events: {
        onReady: (slot, room, resumed) => {
          this.lobby.applyRoom(room, slot);
          if (resumed) this.stats.resumes++;
          // Say who we are, every time we are seated, and always NOT ready. On a first join that is the
          // introduction; on a reconnect it is a re-introduction, because the drop cleared our ready
          // flag on the host and a phone that comes back silently ready lets a party start a run it is
          // not in yet. Same line either way — one path, so there is nothing to forget on the rarer one.
          this.stats.reintroductions++;
          this.lobby.setLocal(this.name, this.characterId, false);
          this.status = LOBBY_STATUS.SEATED;
          this.reason = "";
          this.changed();
        },
        onControl: (frame) => {
          // A refusal deliberately does *not* appear here: the transport turns it into a death, because
          // being refused and being hung up on are the same event to a player and two paths to one
          // outcome is two places to forget. Handling it twice would be dead code that looks like a rule.
          //
          // Any frame carrying a room is the relay restating the seats, and the relay is the only
          // authority on those. Peers joining and leaving arrive this way and nowhere else.
          if (frame.room.seats.length > 0 && this.transport.slot >= 0) {
            this.lobby.applyRoom(frame.room, this.transport.slot);
            this.changed();
          }
        },
        onGame: (bytes, senderSlot) => {
          // After launch the socket carries the run, not the lobby: input batches, tick confirms, state
          // hashes and resyncs are the net session's traffic, and handing them to the lobby's `receive`
          // would be handing it bytes it has no case for. The sink is set by `handOffToRun`, and once it
          // is set the lobby is done listening — the party has become a run on the same wire.
          if (this.gameSink !== null) {
            this.gameSink(bytes, senderSlot);
            return;
          }
          this.lobby.receive(bytes, senderSlot, senderSlot === this.lobby.hostSlot);
          this.changed();
        },
        onDropped: () => {
          this.status = LOBBY_STATUS.RECONNECTING;
          this.changed();
        },
        onDead: (reason) => {
          this.status = LOBBY_STATUS.ENDED;
          this.reason = reason === "" ? "Lost the connection to that party." : refusalSentence(reason);
          this.changed();
        },
      },
    });

    this.lobby = new Lobby({
      send: (bytes) => {
        this.transport.send(bytes);
      },
      now: options.now,
      random: options.random,
      chatPolicy: options.chatPolicy,
      ...(options.isFriend === undefined ? {} : { isFriend: options.isFriend }),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      onLaunch: (seed, stageId, playerCount) => {
        this.changed();
        options.onLaunch?.(seed, stageId, playerCount);
      },
    });
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Subscription                                                                                 */
  /* -------------------------------------------------------------------------------------------- */

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private changed(): void {
    this.revision++;
    this.cached = null;
    for (const l of this.listeners) l();
  }

  /**
   * The snapshot. Identical by reference until something changes, so a screen that re-renders for its
   * own reasons does not rebuild the party list.
   */
  view(): LobbyView {
    const cached = this.cached;
    if (cached !== null) return cached;
    const seats: LobbySeatRow[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const row = this.lobby.seats[i] as LobbySeatRow;
      seats.push({ state: row.state, name: row.name, characterId: row.characterId, ready: row.ready });
    }
    const built: LobbyView = {
      status: this.status,
      reason: this.reason,
      code: this.lobby.code,
      targetSize: this.lobby.targetSize,
      isPublic: this.lobby.isPublic,
      localSlot: this.lobby.localSlot,
      hostSlot: this.lobby.hostSlot,
      isHost: this.lobby.isHost,
      liveCount: this.lobby.liveCount,
      seats,
      chat: this.lobby.chat.slice(),
      startBlocker: this.lobby.startBlocker(),
      launched: this.lobby.launched,
      launchSeed: this.lobby.launchSeed,
      launchStageId: this.lobby.launchStageId,
      lastChatReject: this.lastChatReject,
    };
    this.cached = built;
    return built;
  }

  /* -------------------------------------------------------------------------------------------- */
  /* What the screen does                                                                         */
  /* -------------------------------------------------------------------------------------------- */

  /** Start joining. `admission` is built by the entry screen from what the player typed or tapped. */
  open(admission: Admission): void {
    this.status = LOBBY_STATUS.JOINING;
    this.reason = "";
    this.transport.connect(admission);
    this.changed();
  }

  /** Drive reconnect timing. Called from outside on an interval, so the clock is never ours. */
  pump(): void {
    const before = this.transport.state;
    this.transport.pump();
    if (this.transport.state !== before) this.changed();
  }

  /** Change name or character without touching the ready flag. */
  setIdentity(name: string, characterId: number): void {
    this.name = name;
    this.characterId = characterId;
    const seat = this.lobby.seats[Math.max(0, this.lobby.localSlot)] as LobbySeatRow;
    this.lobby.setLocal(name, characterId, this.lobby.localSlot < 0 ? false : seat.ready);
    this.changed();
  }

  /**
   * Press ready.
   *
   * On a guest this only *asks*. Nothing on screen moves until the host's roster comes back, which is
   * the point: all four phones agree, at the cost of about a fiftieth of a second.
   */
  setReady(ready: boolean): void {
    this.lobby.setReady(ready);
    this.changed();
  }

  /** Send something typed. The returned code is why it was refused, if it was. */
  say(text: string): number {
    const result = this.lobby.say(text);
    this.lastChatReject = result;
    this.changed();
    return result;
  }

  /** Send one of the six presets. */
  sayPreset(presetId: number): number {
    const result = this.lobby.sayPreset(presetId);
    this.lastChatReject = result;
    this.changed();
    return result;
  }

  /** Host only. Returns false and changes nothing when START is blocked. */
  start(stageId: number): boolean {
    const went = this.lobby.start(stageId);
    this.changed();
    return went;
  }

  /**
   * Leave for good. Frees the seat immediately rather than holding it for the grace window.
   *
   * Once the connection has been handed to a run, leaving is refused: the run now owns the socket, and
   * closing it here — which the lobby screen's unmount cleanup does on every navigation — would pull the
   * wire out from under a run that is mid-fight. The run frees the seat itself when it ends, through the
   * handle this handed it.
   */
  leave(): void {
    if (this.handedOff) return;
    this.transport.quit();
    this.status = LOBBY_STATUS.ENDED;
    this.reason = "";
    this.changed();
  }

  /**
   * Hand the live connection to the run and stop being a lobby.
   *
   * Returns everything a `NetRun` needs and nothing more: the transport's own `Link` (so the run drives
   * a session over the seated socket without ever seeing the socket), our seat, the host's seat, whether
   * we are the host, and the party size. From this point:
   *
   *   - game frames off the socket are routed to `sink` instead of the lobby, because they are now the
   *     session's INPUT_BATCH / TICK_CONFIRM / STATE_HASH / RESYNC traffic, not roster and chat;
   *   - `leave` is disarmed, so the lobby screen unmounting cannot close the socket the run is using;
   *   - `pump` and `leave` are exposed on the handle so the run keeps reconnect timing driven from its
   *     own frame loop and can free the seat for good when it is over.
   *
   * The seed and stage are the launch's, not this method's: the host drew them in `Lobby.start` and every
   * guest heard them over LOBBY_LAUNCH, so the caller already has them from `onLaunch` and this need not
   * repeat them.
   */
  handOffToRun(): {
    link: { send(bytes: Uint8Array): void };
    localSlot: number;
    hostSlot: number;
    isHost: boolean;
    playerCount: number;
    /**
     * Each seat's chosen character, read from the roster the host published. Every phone agrees on these
     * — the roster reached all of them before START — so the run begins each seat with its own survivor
     * without a single new wire message. A never-seated slot reads 0, the first character, which is what
     * an empty seat has always resolved to.
     */
    characterIds: number[];
    setReceiver: (sink: (bytes: Uint8Array, senderSlot: number) => void) => void;
    pump: () => void;
    leave: () => void;
  } {
    // Swallow game frames until the run installs its own receiver. Between the launch firing and the run
    // screen mounting there is no session to hand them to, and letting them fall to the lobby's `receive`
    // would be handing it session bytes it cannot read. A confirm or two lost in this gap is repaired by
    // the next one, exactly as any other lost confirm is.
    this.gameSink = () => undefined;
    this.handedOff = true;
    // Read each seat's chosen character straight off the roster. The host published it and every phone
    // applied it before START, so this array is identical on all of them — which is exactly why the run
    // can begin each seat with its own survivor from seed + roster and stay deterministic without any new
    // wire message.
    const characterIds: number[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      characterIds.push((this.lobby.seats[i] as LobbySeatRow).characterId);
    }
    return {
      link: this.transport.link(),
      localSlot: this.lobby.localSlot,
      hostSlot: this.lobby.hostSlot,
      isHost: this.lobby.isHost,
      playerCount: Math.max(1, this.lobby.liveCount),
      characterIds,
      // The run installs its net session's `receive` here once it is built, so inbound game frames reach
      // the session instead of the floor.
      setReceiver: (sink) => {
        this.gameSink = sink;
      },
      pump: () => this.transport.pump(),
      // Free the seat for good, bypassing the disarmed `leave` above — this is the run deciding it is
      // truly over, which is the one caller allowed to close a handed-off socket.
      leave: () => {
        this.transport.quit();
        this.status = LOBBY_STATUS.ENDED;
      },
    };
  }

  /* -------------------------------------------------------------------------------------------- */
  /* For the dev menu, not the game                                                               */
  /* -------------------------------------------------------------------------------------------- */

  /** Everything worth watching while co-op is being debugged, and nothing a screen should read. */
  diagnostics(): {
    linkState: number;
    attempt: number;
    retryDueMs: number;
    sent: number;
    received: number;
    droppedSends: number;
    resumes: number;
    rostersPublished: number;
    rostersApplied: number;
    chatSent: number;
    chatReceived: number;
    chatRejected: number;
    seatRequestsIgnored: number;
  } {
    return {
      linkState: this.transport.state,
      attempt: this.transport.attempt,
      retryDueMs: this.transport.retryDueMs,
      sent: this.transport.stats.sent,
      received: this.transport.stats.received,
      droppedSends: this.transport.stats.droppedSends,
      resumes: this.stats.resumes,
      rostersPublished: this.lobby.stats.rostersPublished,
      rostersApplied: this.lobby.stats.rostersApplied,
      chatSent: this.lobby.stats.chatSent,
      chatReceived: this.lobby.stats.chatReceived,
      chatRejected: this.lobby.stats.chatRejected,
      seatRequestsIgnored: this.lobby.stats.seatRequestsIgnored,
    };
  }
}

/** Re-exported so an entry screen can build an admission without importing the transport itself. */
export { createAdmission, LINK_STATE, START_BLOCK };
export type { Admission };
