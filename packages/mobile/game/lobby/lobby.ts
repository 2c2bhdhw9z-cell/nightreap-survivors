/**
 * The lobby: four seats, four names, four ready flags, and a chat log — with one machine deciding.
 *
 * WHAT THIS IS AND IS NOT
 * This is the state behind the CRYPT PARTY screen. It is not the connection (that is `Transport`), not
 * the room (that is the relay's registry), and not the run (that is `Party` and the sessions). It owns
 * exactly the things a player can see and change while nobody is playing yet: who is here, what they
 * are called, which character they picked, whether they are ready, and what has been said.
 *
 * WHY THE HOST OWNS THE ROSTER
 * The alternative is every phone keeping its own tally from the messages it happened to receive, which
 * works right up until one message is lost and two players disagree about whether the party is ready.
 * The host publishes the whole roster whenever anything changes; a guest draws what it was sent and
 * never edits it locally. So a guest's ready button does not toggle the guest's own view — it asks, and
 * the roster comes back. That is a fifty-millisecond delay on a button press, and in exchange the
 * screen four players are looking at is the same screen.
 *
 * WHY CHAT GOES THROUGH THE HOST
 * A guest cannot address another guest — the relay only routes a guest's traffic to the host, by design.
 * So a line travels guest -> host -> everyone, and the host stamps the true seat number onto it on the
 * way through. Nobody can put words in someone else's mouth, and the host-side re-check that Phase 8's
 * moderation needs already has the one place it has to live.
 *
 * WHAT THIS FILE REFUSES TO DECIDE
 * Whether a word is allowed. Filtering is injected (`filter`), because the real filter is a large piece
 * of versioned content data arriving in Phase 8 and the lobby must not grow its own smaller, wronger
 * copy in the meantime. The default filter enforces only what is structural: length, control characters,
 * and emptiness.
 *
 * NO CLOCK, NO RANDOMNESS, NO REACT
 * `now` and `random` are injected like everywhere else in `game/`, so the chat rate limit and the launch
 * seed are testable by calling them rather than by waiting.
 */

import { Reader, Writer } from "../net/codec";
import {
  createLobbyRosterWire,
  decodeLobbyChat,
  decodeLobbyLaunch,
  decodeLobbyRoster,
  decodeLobbySeat,
  encodeLobbyChat,
  encodeLobbyLaunch,
  encodeLobbyRoster,
  encodeLobbySeat,
  MAX_CHAT_BYTES,
  MAX_NAME_BYTES,
  type LobbyChatWire,
  type LobbyLaunchWire,
  type LobbySeatWire,
} from "../net/messages";
import { MAX_PLAYERS, MSG, RELAY_BROADCAST, HDR_DEST, HDR_TYPE } from "../net/protocol";
import { SEAT_VIEW, type RoomView } from "../net/transport";

/* ---------------------------------------------------------------------------------------------- */
/* Seats                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** Seat states, matching the party badge design: nobody, somebody, somebody reconnecting. */
export const LOBBY_SEAT = { EMPTY: 0, LIVE: 1, HELD: 2 } as const;
export type LobbySeatState = (typeof LOBBY_SEAT)[keyof typeof LOBBY_SEAT];

/** Longest name the lobby will hold. Shorter than the wire cap so a truncation is never a surprise. */
export const MAX_NAME_CHARS = 16;

/** Longest chat line the lobby will hold. */
export const MAX_CHAT_CHARS = 120;

export interface LobbySeatRow {
  state: number;
  name: string;
  characterId: number;
  ready: boolean;
}

function createSeatRow(): LobbySeatRow {
  return { state: LOBBY_SEAT.EMPTY, name: "", characterId: 0, ready: false };
}

/* ---------------------------------------------------------------------------------------------- */
/* Chat                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The six preset messages. Free infrastructure that ships with co-op, never a purchase.
 *
 * Ids, not strings, because these cross the wire and the words are translated per device — two players
 * on different system languages both see their own HERE.
 *
 * Append-only.
 */
export const PRESET = {
  HERE: 0,
  DANGER: 1,
  HELP: 2,
  NICE: 3,
  REGROUP: 4,
  LOOT: 5,
} as const;
export const PRESET_COUNT = 6;

export const CHAT_KIND = {
  /** Something a player typed. */
  FREE: 0,
  /** One of the six presets, carried as an id. */
  PRESET: 1,
  /** The lobby talking about itself: somebody joined, somebody's seat expired. Never sent on the wire. */
  SYSTEM: 2,
} as const;

/**
 * Why a line was not sent. Numbers, because the words belong to the UI.
 *
 * Every one of these is a case the player must be able to tell apart. "Nothing happened when I pressed
 * send" is the single most common way a chat feature is reported as broken, and it is almost always one
 * of these five with no message attached to it.
 *
 * Append-only.
 */
export const CHAT_REJECT = {
  OK: 0,
  /** Nothing but whitespace. */
  EMPTY: 1,
  /** Longer than the cap, after trimming. */
  TOO_LONG: 2,
  /** The player has chat switched off in settings. Their own switch, so this is not an error. */
  CHAT_OFF: 3,
  /** The injected filter said no. */
  BLOCKED: 4,
  /** Too many lines too fast. */
  RATE_LIMITED: 5,
  /** No seat, so nowhere to send from. */
  NOT_SEATED: 6,
  /** A preset id that does not exist. */
  BAD_PRESET: 7,
} as const;

/** Lines retained. A lobby is minutes long and the panel shows eight, so sixty-four is generous. */
export const CHAT_LOG_MAX = 64;

/**
 * Rate limit: a bucket of five lines, refilling one per second and a half.
 *
 * A bucket rather than a minimum gap because real conversation is bursty — three quick lines then
 * nothing is normal, and a flat gap punishes it while barely slowing a spammer who is willing to wait.
 */
export const CHAT_BUCKET_MAX = 5;
export const CHAT_REFILL_MS = 1_500;

export interface ChatLine {
  kind: number;
  /** Seat the line came from, or -1 for a system line. */
  fromSlot: number;
  /** Name at the time it was said, kept so the log does not rewrite itself when someone leaves. */
  fromName: string;
  text: string;
  presetId: number;
  /** System-line code, from `SYSTEM_LINE`. Zero for anything a player said. */
  systemCode: number;
  atMs: number;
}

/** System lines the lobby writes about itself. Append-only. */
export const SYSTEM_LINE = {
  NONE: 0,
  JOINED: 1,
  LEFT: 2,
  DROPPED: 3,
  RETURNED: 4,
  HOST_CHANGED: 5,
} as const;

export interface FilterResult {
  /** False when the line must not be sent at all. */
  allowed: boolean;
  /** The text to send, possibly with parts masked. */
  text: string;
}

/**
 * The default filter: structure only, no judgement.
 *
 * Control characters are stripped rather than rejected, because they arrive from keyboards and paste
 * buffers with no ill intent and rejecting the line would read as the send button being broken. Runs of
 * whitespace collapse for the same reason a chat panel is eight lines tall: one player should not be
 * able to take the whole panel with newlines.
 */
export function defaultFilter(raw: string): FilterResult {
  let out = "";
  let lastWasSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    const isSpace = c === 32 || c === 9 || c === 10 || c === 13;
    if (c < 32 || c === 127) {
      if (!isSpace) continue;
    }
    if (isSpace) {
      if (!lastWasSpace && out.length > 0) out += " ";
      lastWasSpace = true;
      continue;
    }
    out += raw[i];
    lastWasSpace = false;
  }
  while (out.endsWith(" ")) out = out.slice(0, -1);
  return { allowed: true, text: out };
}

/**
 * Names get the same treatment, plus a hard length cut.
 *
 * Player names are user-generated content in every store's eyes, which is why the game generates one by
 * default and a custom name is opt-in. This is the structural half of that; the word list is Phase 8.
 */
export function cleanName(raw: string): string {
  const cleaned = defaultFilter(raw).text;
  return cleaned.length > MAX_NAME_CHARS ? cleaned.slice(0, MAX_NAME_CHARS) : cleaned;
}

/* ---------------------------------------------------------------------------------------------- */
/* Starting                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Why START RUN is not available. Append-only.
 *
 * The screen shows the reason instead of a greyed-out button with no explanation, because with four
 * people in a room the reason is almost always another person and they can be told about it.
 */
export const START_BLOCK = {
  /** Nothing is wrong. Go. */
  NONE: 0,
  /** Only the host may start. A guest's button says "waiting for the host" instead. */
  NOT_HOST: 1,
  /** Alone in the room. A one-player party is a solo run and belongs on the other screen. */
  ALONE: 2,
  /** Somebody has not pressed ready. */
  NOT_READY: 3,
  /**
   * Somebody's seat is being held while they reconnect.
   *
   * Deliberately blocking. Starting now would strand a player who is thirty seconds from being back,
   * and the party can see the countdown, so the choice to give up on them is theirs to make by kicking
   * the seat rather than ours to make by ignoring it.
   */
  WAITING_RECONNECT: 4,
} as const;

/* ---------------------------------------------------------------------------------------------- */
/* Options                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the lobby is allowed to know about settings.
 *
 * Both fields come from `resolve()` in the settings layer, already reconciled — `chatFromNonFriends` is
 * false whenever chat is off, and `keyboard` is already forced to the phone keyboard when the player's
 * language cannot be typed on ours. The lobby does not re-derive either one. Two places deciding the
 * same thing is how a setting appears not to stick.
 */
export interface LobbyChatPolicy {
  enabled: boolean;
  fromNonFriends: boolean;
}

export interface LobbyOptions {
  /** Sends one message. The transport's binary channel; the lobby never touches the text channel. */
  send: (bytes: Uint8Array) => void;
  now: () => number;
  random: () => number;
  chatPolicy: LobbyChatPolicy;
  /** Whether a seat belongs to someone this player has as a friend. Defaults to false — a stranger. */
  isFriend?: (slot: number) => boolean;
  /** Pre-transmission filter. Defaults to structure only. */
  filter?: (raw: string) => FilterResult;
  /** Called on a guest when the host says the run is starting. */
  onLaunch?: (seed: number, stageId: number, playerCount: number) => void;
}

/* ---------------------------------------------------------------------------------------------- */

export class Lobby {
  /** Room code, party size and visibility as the relay reported them. */
  code = "";
  targetSize = 0;
  isPublic = false;

  /** Our seat, and the host's. -1 until the relay seats us. */
  localSlot = -1;
  hostSlot = -1;

  readonly seats: LobbySeatRow[] = [
    createSeatRow(),
    createSeatRow(),
    createSeatRow(),
    createSeatRow(),
  ];

  /** Oldest first. The panel draws the tail. */
  readonly chat: ChatLine[] = [];

  /** Set once the host has launched, so the screen can hand over without asking twice. */
  launched = false;
  launchSeed = 0;
  launchStageId = 0;

  /** Counters worth seeing in the dev menu rather than guessing at. */
  readonly stats = {
    rostersPublished: 0,
    rostersApplied: 0,
    chatSent: 0,
    chatReceived: 0,
    chatRejected: 0,
    seatRequestsIgnored: 0,
  };

  private readonly o: LobbyOptions;
  private readonly writer = new Writer();
  private readonly seatWire: LobbySeatWire = { characterId: 0, ready: false, name: "" };
  private readonly rosterWire = createLobbyRosterWire();
  private readonly chatWire: LobbyChatWire = { kind: 0, presetId: 0, fromSlot: 0, text: "" };
  private readonly launchWire: LobbyLaunchWire = { seed: 0, stageId: 0, playerCount: 0 };
  /** Scratch arrays for publishing a roster, so publishing allocates nothing. */
  private readonly outStates = new Uint8Array(MAX_PLAYERS);
  private readonly outCharacters = new Uint8Array(MAX_PLAYERS);
  private readonly outReady = new Uint8Array(MAX_PLAYERS);
  private readonly outNames: string[] = ["", "", "", ""];
  private tokens = CHAT_BUCKET_MAX;
  private tokensAtMs = 0;

  constructor(options: LobbyOptions) {
    this.o = options;
    this.tokensAtMs = options.now();
  }

  get isHost(): boolean {
    return this.localSlot >= 0 && this.localSlot === this.hostSlot;
  }

  /** Seats with a live player in them. What "party size" means for enemy count. */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if ((this.seats[i] as LobbySeatRow).state === LOBBY_SEAT.LIVE) n++;
    }
    return n;
  }

  /* -------------------------------------------------------------------------------------------- */
  /* The relay's word                                                                             */
  /* -------------------------------------------------------------------------------------------- */

  /**
   * Take the room as the relay described it.
   *
   * The relay is the authority on seats — who is connected, whose seat is held, who hosts. It is not the
   * authority on names, characters or ready flags, which it never sees. So this writes the seat states
   * and leaves everything else alone, and a seat that empties is cleared so a departed player's name
   * cannot linger under somebody else's connection.
   */
  applyRoom(room: RoomView, localSlot: number): void {
    this.code = room.code;
    this.targetSize = room.targetSize;
    this.isPublic = room.isPublic;
    this.localSlot = localSlot;
    const hostChanged = this.hostSlot >= 0 && room.hostSlot !== this.hostSlot;
    this.hostSlot = room.hostSlot;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = this.seats[i] as LobbySeatRow;
      const view = room.seats[i];
      const before = seat.state;
      const state =
        view === SEAT_VIEW.LIVE
          ? LOBBY_SEAT.LIVE
          : view === SEAT_VIEW.HELD
            ? LOBBY_SEAT.HELD
            : LOBBY_SEAT.EMPTY;
      seat.state = state;
      if (state === LOBBY_SEAT.EMPTY && before !== LOBBY_SEAT.EMPTY) {
        const wasCalled = seat.name;
        seat.name = "";
        seat.characterId = 0;
        seat.ready = false;
        this.system(SYSTEM_LINE.LEFT, i, wasCalled);
      } else if (state === LOBBY_SEAT.LIVE && before === LOBBY_SEAT.EMPTY) {
        // Not for our own seat. Being told you sat down is noise, and worse, it is the first line in an
        // empty log, so a brand new party opens on the game talking about the player to the player.
        if (i !== this.localSlot) this.system(SYSTEM_LINE.JOINED, i, "");
      } else if (state === LOBBY_SEAT.LIVE && before === LOBBY_SEAT.HELD) {
        this.system(SYSTEM_LINE.RETURNED, i, seat.name);
      } else if (state === LOBBY_SEAT.HELD && before === LOBBY_SEAT.LIVE) {
        seat.ready = false;
        this.system(SYSTEM_LINE.DROPPED, i, seat.name);
      }
    }
    if (hostChanged) this.system(SYSTEM_LINE.HOST_CHANGED, room.hostSlot, "");
    if (this.isHost) this.publish();
  }

  /* -------------------------------------------------------------------------------------------- */
  /* What the local player changes                                                                */
  /* -------------------------------------------------------------------------------------------- */

  /**
   * Set our name, character and ready flag.
   *
   * On a host this is the roster, so it takes effect and is published. On a guest it is a request: the
   * local row is left exactly as the host last described it, and the host's next roster is what changes
   * the screen. Guests that edited their own row optimistically would show ready for a moment even when
   * the host never heard them, and pressing ready is the one moment in the lobby where being wrong for a
   * moment matters.
   */
  setLocal(name: string, characterId: number, ready: boolean): void {
    if (this.localSlot < 0) return;
    const cleaned = cleanName(name);
    if (this.isHost) {
      const seat = this.seats[this.localSlot] as LobbySeatRow;
      seat.name = cleaned;
      seat.characterId = characterId & 0xff;
      seat.ready = ready;
      this.publish();
      return;
    }
    this.o.send(
      encodeLobbySeat(this.writer, this.localSlot, characterId & 0xff, ready, cleaned),
    );
  }

  /** Convenience for the ready button: keep name and character, change only the flag. */
  setReady(ready: boolean): void {
    if (this.localSlot < 0) return;
    const seat = this.seats[this.localSlot] as LobbySeatRow;
    this.setLocal(seat.name, seat.characterId, ready);
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Chat                                                                                         */
  /* -------------------------------------------------------------------------------------------- */

  /** Send something typed. Returns a `CHAT_REJECT` code; `OK` means it went. */
  say(raw: string): number {
    if (this.localSlot < 0) return this.reject(CHAT_REJECT.NOT_SEATED);
    if (!this.o.chatPolicy.enabled) return this.reject(CHAT_REJECT.CHAT_OFF);
    const filter = this.o.filter ?? defaultFilter;
    const result = filter(raw);
    if (!result.allowed) return this.reject(CHAT_REJECT.BLOCKED);
    const text = result.text;
    if (text.length === 0) return this.reject(CHAT_REJECT.EMPTY);
    if (text.length > MAX_CHAT_CHARS) return this.reject(CHAT_REJECT.TOO_LONG);
    if (!this.spendToken()) return this.reject(CHAT_REJECT.RATE_LIMITED);
    this.emit(CHAT_KIND.FREE, 0, text);
    return CHAT_REJECT.OK;
  }

  /**
   * Send a preset.
   *
   * Presets bypass the filter — they cannot be abused into a message they are not — but they do not
   * bypass the rate limit, because six buttons and no cooldown is a working spam machine.
   */
  sayPreset(presetId: number): number {
    if (this.localSlot < 0) return this.reject(CHAT_REJECT.NOT_SEATED);
    if (!this.o.chatPolicy.enabled) return this.reject(CHAT_REJECT.CHAT_OFF);
    if (!Number.isInteger(presetId) || presetId < 0 || presetId >= PRESET_COUNT) {
      return this.reject(CHAT_REJECT.BAD_PRESET);
    }
    if (!this.spendToken()) return this.reject(CHAT_REJECT.RATE_LIMITED);
    this.emit(CHAT_KIND.PRESET, presetId, "");
    return CHAT_REJECT.OK;
  }

  private emit(kind: number, presetId: number, text: string): void {
    const slot = this.localSlot;
    // Shown locally at once. Our own words never wait for a round trip; the host echo that comes back
    // is recognised by seat and dropped, so the line does not appear twice.
    this.append(kind, slot, this.nameOf(slot), text, presetId, SYSTEM_LINE.NONE);
    this.stats.chatSent++;
    const bytes = encodeLobbyChat(this.writer, slot, kind, presetId, slot, text);
    if (this.isHost) bytes[HDR_DEST] = RELAY_BROADCAST;
    this.o.send(bytes);
  }

  private reject(code: number): number {
    this.stats.chatRejected++;
    return code;
  }

  private spendToken(): boolean {
    const nowMs = this.o.now();
    const elapsed = nowMs - this.tokensAtMs;
    if (elapsed > 0) {
      const gained = Math.floor(elapsed / CHAT_REFILL_MS);
      if (gained > 0) {
        this.tokens = Math.min(CHAT_BUCKET_MAX, this.tokens + gained);
        this.tokensAtMs += gained * CHAT_REFILL_MS;
      }
    } else if (elapsed < 0) {
      // A clock that went backwards is a clock, not a cheat. Re-anchor rather than hand out tokens.
      this.tokensAtMs = nowMs;
    }
    if (this.tokens <= 0) return false;
    this.tokens--;
    return true;
  }

  /** A line the lobby wrote about itself. Never sent anywhere. */
  private system(code: number, slot: number, name: string): void {
    this.append(CHAT_KIND.SYSTEM, slot, name, "", 0, code);
  }

  private append(
    kind: number,
    fromSlot: number,
    fromName: string,
    text: string,
    presetId: number,
    systemCode: number,
  ): void {
    this.chat.push({
      kind,
      fromSlot,
      fromName,
      text,
      presetId,
      systemCode,
      atMs: this.o.now(),
    });
    while (this.chat.length > CHAT_LOG_MAX) this.chat.shift();
  }

  private nameOf(slot: number): string {
    if (slot < 0 || slot >= MAX_PLAYERS) return "";
    return (this.seats[slot] as LobbySeatRow).name;
  }

  /**
   * Should we show a line from this seat at all?
   *
   * Chat off hides everything; stranger chat off hides everyone not on the friends list. Note that the
   * line is dropped on arrival rather than at draw time, so switching chat back on does not reveal a
   * backlog of what was said while it was off — which is what a player who turned it off wanted.
   */
  private accepts(slot: number): boolean {
    if (!this.o.chatPolicy.enabled) return false;
    if (slot === this.localSlot) return true;
    if (this.o.chatPolicy.fromNonFriends) return true;
    const isFriend = this.o.isFriend;
    return isFriend === undefined ? false : isFriend(slot);
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Starting                                                                                     */
  /* -------------------------------------------------------------------------------------------- */

  /** Why we cannot start, as a `START_BLOCK` code. */
  startBlocker(): number {
    if (!this.isHost) return START_BLOCK.NOT_HOST;
    let live = 0;
    let held = 0;
    let notReady = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = this.seats[i] as LobbySeatRow;
      if (seat.state === LOBBY_SEAT.HELD) held++;
      if (seat.state !== LOBBY_SEAT.LIVE) continue;
      live++;
      // The host's readiness is the act of pressing start. Asking the host to also tick a box is a
      // second button for the same decision.
      if (i !== this.localSlot && !seat.ready) notReady++;
    }
    if (held > 0) return START_BLOCK.WAITING_RECONNECT;
    if (live < 2) return START_BLOCK.ALONE;
    if (notReady > 0) return START_BLOCK.NOT_READY;
    return START_BLOCK.NONE;
  }

  canStart(): boolean {
    return this.startBlocker() === START_BLOCK.NONE;
  }

  /**
   * Launch. Host only, and only when nothing blocks it.
   *
   * The seed is drawn here and sent, rather than derived on each phone from something they share, so
   * that there is exactly one answer to "what run is this" and it belongs to the machine that will be
   * simulating it. A daily run overrides it with the server's seed; that is the caller's business.
   */
  start(stageId: number, seed?: number): boolean {
    if (!this.canStart()) return false;
    const chosen = seed === undefined ? (Math.floor(this.o.random() * 0x100000000) >>> 0) : seed >>> 0;
    this.launchSeed = chosen;
    this.launchStageId = stageId & 0xffff;
    this.launched = true;
    const bytes = encodeLobbyLaunch(
      this.writer,
      this.localSlot,
      chosen,
      this.launchStageId,
      this.liveCount,
    );
    bytes[HDR_DEST] = RELAY_BROADCAST;
    this.o.send(bytes);
    // The guests hear the launch over LOBBY_LAUNCH and fire this from `receive`; the host never
    // receives its own broadcast, so it fires the same hook here. One path into a run for everyone,
    // rather than the host screen having to watch `launched` flip and the guests using the hook.
    this.o.onLaunch?.(chosen, this.launchStageId, this.liveCount);
    return true;
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Publishing and receiving                                                                     */
  /* -------------------------------------------------------------------------------------------- */

  /** Host only: broadcast the whole roster. Called whenever anything in it changed. */
  publish(): void {
    if (!this.isHost) return;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = this.seats[i] as LobbySeatRow;
      this.outStates[i] = seat.state;
      this.outCharacters[i] = seat.characterId;
      this.outReady[i] = seat.ready ? 1 : 0;
      this.outNames[i] = seat.name;
    }
    const bytes = encodeLobbyRoster(
      this.writer,
      this.localSlot,
      this.hostSlot,
      MAX_PLAYERS,
      this.outStates,
      this.outCharacters,
      this.outReady,
      this.outNames,
    );
    bytes[HDR_DEST] = RELAY_BROADCAST;
    this.stats.rostersPublished++;
    this.o.send(bytes);
  }

  /**
   * Take a lobby message.
   *
   * `senderSlot` is the relay-stamped seat and is trustworthy; `senderIsHost` comes from the room. Both
   * are passed in rather than read out of the message, for the same reason the session does it that way:
   * a field in a body is a claim, and this is the layer where claims stop.
   */
  receive(bytes: Uint8Array, senderSlot: number, senderIsHost: boolean): void {
    if (bytes.length < 4) return;
    const type = bytes[HDR_TYPE] as number;
    const r = new Reader(bytes);
    if (type === MSG.LOBBY_SEAT) {
      // A guest describing itself. Only the host acts on it, and only for the seat the relay says it
      // came from — a guest naming another seat is naming its own.
      if (!this.isHost) {
        this.stats.seatRequestsIgnored++;
        return;
      }
      if (senderSlot < 0 || senderSlot >= MAX_PLAYERS || senderSlot === this.localSlot) {
        this.stats.seatRequestsIgnored++;
        return;
      }
      const wire = decodeLobbySeat(r, this.seatWire);
      const seat = this.seats[senderSlot] as LobbySeatRow;
      if (seat.state !== LOBBY_SEAT.LIVE) {
        this.stats.seatRequestsIgnored++;
        return;
      }
      seat.name = cleanName(wire.name);
      seat.characterId = wire.characterId;
      seat.ready = wire.ready;
      this.publish();
      return;
    }

    if (type === MSG.LOBBY_ROSTER) {
      if (!senderIsHost || this.isHost) return;
      const wire = decodeLobbyRoster(r, this.rosterWire);
      this.hostSlot = wire.hostSlot;
      for (let i = 0; i < wire.count && i < MAX_PLAYERS; i++) {
        const seat = this.seats[i] as LobbySeatRow;
        const state = wire.states[i] as number;
        seat.state =
          state === LOBBY_SEAT.LIVE
            ? LOBBY_SEAT.LIVE
            : state === LOBBY_SEAT.HELD
              ? LOBBY_SEAT.HELD
              : LOBBY_SEAT.EMPTY;
        seat.characterId = wire.characters[i] as number;
        seat.ready = (wire.ready[i] as number) === 1;
        seat.name = cleanName(wire.names[i] ?? "");
      }
      this.stats.rostersApplied++;
      return;
    }

    if (type === MSG.LOBBY_CHAT) {
      const wire = decodeLobbyChat(r, this.chatWire);
      // On a host, a guest's line is stamped with the seat the relay reported and rebroadcast. The
      // body's own `fromSlot` is discarded on the way through, which is the whole reason it is safe.
      const from = senderIsHost && !this.isHost ? wire.fromSlot : senderSlot;
      if (from < 0 || from >= MAX_PLAYERS) return;
      if (this.isHost && from !== this.localSlot) {
        const relayed = encodeLobbyChat(
          this.writer,
          this.localSlot,
          wire.kind,
          wire.presetId,
          from,
          wire.text,
        );
        relayed[HDR_DEST] = RELAY_BROADCAST;
        this.o.send(relayed);
      }
      // Our own line came back to us. It was shown when we sent it.
      if (from === this.localSlot) return;
      if (!this.accepts(from)) return;
      if (wire.kind === CHAT_KIND.PRESET) {
        if (wire.presetId < 0 || wire.presetId >= PRESET_COUNT) return;
        this.append(CHAT_KIND.PRESET, from, this.nameOf(from), "", wire.presetId, SYSTEM_LINE.NONE);
      } else {
        // Re-filtered on arrival, not trusted from the wire. A modified client can send anything it
        // likes; what it cannot do is make our screen show it.
        const filter = this.o.filter ?? defaultFilter;
        const result = filter(wire.text);
        if (!result.allowed) return;
        const text =
          result.text.length > MAX_CHAT_CHARS ? result.text.slice(0, MAX_CHAT_CHARS) : result.text;
        if (text.length === 0) return;
        this.append(CHAT_KIND.FREE, from, this.nameOf(from), text, 0, SYSTEM_LINE.NONE);
      }
      this.stats.chatReceived++;
      return;
    }

    if (type === MSG.LOBBY_LAUNCH) {
      if (!senderIsHost || this.isHost) return;
      const wire = decodeLobbyLaunch(r, this.launchWire);
      this.launchSeed = wire.seed;
      this.launchStageId = wire.stageId;
      this.launched = true;
      this.o.onLaunch?.(wire.seed, wire.stageId, wire.playerCount);
      return;
    }
  }
}

/** Wire caps re-exported so a screen can size its input field from the same numbers. */
export { MAX_CHAT_BYTES, MAX_NAME_BYTES };
