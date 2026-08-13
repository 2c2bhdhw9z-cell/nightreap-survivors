/**
 * The party: one object that knows whether this phone is hosting, and keeps playing when that changes.
 *
 * WHAT THIS IS FOR
 * Everything underneath is already tested and already correct in isolation: the transport gets us onto
 * a relay and back after a tunnel, `HostSession` seals the record for each tick, `GuestSession` replays
 * it. What none of them can answer is the question the *game* asks — "am I the host right now?" — and
 * that answer changes mid-fight, without warning, when whoever was hosting has their app killed.
 *
 * This is the only place in the codebase where the answer changes. The renderer, the HUD and the
 * simulation never learn about it: they hold a `Run` and it keeps ticking.
 *
 * WHY THERE IS NO CO-OP BRANCH IN THE SIMULATION
 * Solo never constructs a `Party` at all. It ticks its `Run` directly, exactly as it did before any of
 * this existed. That is the whole enforcement of "solo does not touch the co-op code path" — not a flag
 * checked in a hundred places, just a layer that is absent.
 *
 * WHAT A MIGRATION ACTUALLY COSTS
 * One snapshot per remaining player, once. The reasoning is in `GuestSession.rehost`; the short version
 * is that a promoted host is a player, so it is behind the host it replaced, and every tick between the
 * two positions was sealed by a machine that no longer exists. Keeping any of that is guessing. The
 * event happens when somebody's phone rings, so the cost is paid in a situation where a third of a
 * second of catching up is the least of anyone's problems.
 *
 * NOTHING IN HERE READS A CLOCK OR A MESSAGE BODY
 * `now` is injected, same as the transport and the room registry, so the grace countdown a player sees
 * can be tested without waiting forty-five seconds. Bodies are read only for `HOST_MIGRATE`, which is
 * four header bytes and one payload byte, and which the relay authors — no client can send it.
 */

import { HostSession, GuestSession } from "./session";
import { Transport, LINK_STATE, SEAT_GRACE_MS, CONTROL, SEAT_VIEW } from "./transport";
import type { Admission, ControlFrame, RoomView, SocketFactory } from "./transport";
import { createRoomView } from "./transport";
import { MAX_PLAYERS, MSG, HDR_TYPE, HEADER_BYTES } from "./protocol";
import type { Run } from "../run/run";

/* ---------------------------------------------------------------------------------------------- */
/* What the game asks                                                                              */
/* ---------------------------------------------------------------------------------------------- */

export const PARTY_ROLE = {
  /** Not in a party. Reserved for completeness; solo does not build a `Party`. */
  NONE: 0,
  HOST: 1,
  GUEST: 2,
} as const;
export type PartyRole = (typeof PARTY_ROLE)[keyof typeof PARTY_ROLE];

export const PARTY_STATE = {
  IDLE: 0,
  /** Connecting, or connected but not yet holding a confirmed world. */
  JOINING: 1,
  PLAYING: 2,
  /** Our own connection is gone. The world holds still until we are back or the seat expires. */
  INTERRUPTED: 3,
  /** Over: we quit, we were refused, or the seat expired. Nothing further happens by itself. */
  ENDED: 4,
} as const;
export type PartyState = (typeof PARTY_STATE)[keyof typeof PARTY_STATE];

/**
 * Things the party needs to tell the player, as numbers.
 *
 * Numbers rather than strings because this is read inside the frame loop and a string built per event
 * is an allocation in a tick. The words live with the UI, where they can be translated.
 *
 * Append-only.
 */
export const NOTICE = {
  NONE: 0,
  /** A seat filled: someone joined, or someone came back. */
  PEER_HERE: 1,
  /** Someone's connection died. Their seat is held and the countdown is running. */
  PEER_DROPPED: 2,
  /** Someone left on purpose. Their seat is free immediately. */
  PEER_QUIT: 3,
  /** A held seat ran out of time. They are not coming back. */
  PEER_SEAT_EXPIRED: 4,
  /** We were promoted: this phone is now running the world for everyone. */
  YOU_ARE_HOST: 5,
  /** Someone else was promoted. Our world is being rebuilt from theirs. */
  HOST_CHANGED: 6,
  /** Our own connection dropped; we are trying to get back in. */
  RECONNECTING: 7,
  /** We are back in our seat. */
  RECONNECTED: 8,
  /** The party is over for us. */
  PARTY_OVER: 9,
} as const;
export type Notice = (typeof NOTICE)[keyof typeof NOTICE];

/** Most notices held before the oldest is dropped. The UI drains these every frame. */
export const MAX_NOTICES = 32;

/** Seat states as the HUD draws them, matching the badge design: live, held-and-counting, empty. */
export const SEAT = { EMPTY: 0, LIVE: 1, HELD: 2 } as const;

export interface PartyOptions {
  /** The world. Already begun for a host; begun from the host's WELCOME for a guest. */
  run: Run;
  /** Party size agreed in the lobby. Fixed for the whole run — enemy count is scaled from it. */
  playerCount: number;
  baseUrl: string;
  open: SocketFactory;
  now: () => number;
  random: () => number;
  /**
   * Called once, on a guest, with the host's WELCOME details, so the app can begin the run on the
   * host's seed and modifier stack. Deliberately a hook rather than something this file does itself:
   * turning wire ids back into modifiers needs the content registry, and nothing in `net/` may reach
   * for content.
   */
  onWelcome?: (seed: number, stageId: number, tainted: number, playerCount: number) => void;
}

/* ---------------------------------------------------------------------------------------------- */

export class Party {
  state: PartyState = PARTY_STATE.IDLE;
  role: PartyRole = PARTY_ROLE.NONE;
  /** Our seat, or -1 until the relay seats us. */
  slot = -1;
  room: RoomView = createRoomView();
  /** Why it ended, verbatim from the relay when it gave a word. Empty while still running. */
  endedBecause = "";

  readonly transport: Transport;
  /** Live only while this phone is hosting. Null otherwise, so a guest cannot accidentally confirm. */
  host: HostSession | null = null;
  /** Live only while this phone is a guest. */
  guest: GuestSession | null = null;

  /** One entry per seat: EMPTY, LIVE or HELD. Index is the seat number. */
  readonly seats = new Uint8Array(MAX_PLAYERS);
  /** When each held seat stops being reclaimable, per the injected clock. -1 when not held. */
  private readonly heldUntil = new Float64Array(MAX_PLAYERS);

  /** Notice ring: kind at 2i, seat at 2i+1. Drained with `takeNotices`. */
  private readonly noticeRing = new Int32Array(MAX_NOTICES * 2);
  private noticeCount = 0;

  private readonly o: PartyOptions;
  /** When our own connection died, so the player can be shown the same countdown the relay is running. */
  private interruptedAtMs = -1;
  private welcomed = false;

  readonly stats = {
    migrations: 0,
    promotions: 0,
    ownReconnects: 0,
    /** Migration messages we ignored because they told us what we already were. */
    redundantMigrations: 0,
  };

  constructor(options: PartyOptions) {
    this.o = options;
    for (let i = 0; i < MAX_PLAYERS; i++) this.heldUntil[i] = -1;
    this.transport = new Transport({
      baseUrl: options.baseUrl,
      open: options.open,
      now: options.now,
      random: options.random,
      events: {
        onReady: (slot, room, resumed) => this.handleReady(slot, room, resumed),
        onControl: (frame) => this.handleControl(frame),
        onGame: (bytes, senderSlot) => this.handleGame(bytes, senderSlot),
        onDropped: () => this.handleDropped(),
        onDead: (reason) => this.handleDead(reason),
      },
    });
  }

  /* -- driving ---------------------------------------------------------------------------------- */

  join(admission: Admission): void {
    this.state = PARTY_STATE.JOINING;
    this.transport.connect(admission);
  }

  /**
   * One frame of party work. Returns simulation ticks advanced, so the caller can interpolate.
   *
   * The state gate is the important line in this file. A host that has lost its connection has also
   * lost its authority — the relay promoted someone else the moment it dropped — so it must stop
   * simulating immediately. Carrying on would build a world nobody else has, and then hand it to
   * everyone on reconnect as if it were true.
   */
  step(): number {
    this.transport.pump();
    if (this.state !== PARTY_STATE.PLAYING) return 0;
    if (this.host !== null) return this.host.step() ? 1 : 0;
    if (this.guest !== null) return this.guest.pump();
    return 0;
  }

  /** Leave on purpose: the seat is freed at once rather than held for the grace window. */
  quit(): void {
    this.transport.quit();
    this.state = PARTY_STATE.ENDED;
    if (this.endedBecause === "") this.endedBecause = "quit";
    this.push(NOTICE.PARTY_OVER, this.slot);
  }

  /* -- what the UI reads ------------------------------------------------------------------------ */

  /**
   * Milliseconds left before a held seat is gone for good, or -1 if it is not held.
   *
   * The countdown is derived, never stored ticking: a phone that gets backgrounded stops calling us,
   * and a stored countdown would come back wrong. This one is always the truth as of right now.
   */
  graceRemainingMs(slot: number): number {
    if (slot < 0 || slot >= MAX_PLAYERS) return -1;
    const until = this.heldUntil[slot] as number;
    if (until < 0) return -1;
    const left = until - this.o.now();
    return left > 0 ? left : 0;
  }

  /** Our own countdown while we are the one trying to get back in. -1 when we are fine. */
  get ownGraceRemainingMs(): number {
    if (this.state !== PARTY_STATE.INTERRUPTED || this.interruptedAtMs < 0) return -1;
    const left = this.interruptedAtMs + SEAT_GRACE_MS - this.o.now();
    return left > 0 ? left : 0;
  }

  /** How many seats are occupied by someone who is actually connected. */
  get liveSeats(): number {
    let n = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) if (this.seats[i] === SEAT.LIVE) n++;
    return n;
  }

  /**
   * Drain pending notices into a caller-owned array as (kind, seat) pairs. Returns the pair count.
   *
   * Caller-owned because this is read every frame and returning a fresh array would allocate inside a
   * tick, which is the one thing the whole engine is built not to do.
   */
  takeNotices(out: Int32Array): number {
    const n = Math.min(this.noticeCount, Math.floor(out.length / 2));
    for (let i = 0; i < n * 2; i++) out[i] = this.noticeRing[i] as number;
    // Whatever did not fit stays queued for the next frame rather than vanishing. A HUD with room for
    // two lines should show the third one a moment later, not lose it.
    const left = this.noticeCount - n;
    for (let i = 0; i < left * 2; i++) this.noticeRing[i] = this.noticeRing[n * 2 + i] as number;
    this.noticeCount = left;
    return n;
  }

  get pendingNotices(): number {
    return this.noticeCount;
  }

  private push(kind: number, slot: number): void {
    if (this.noticeCount >= MAX_NOTICES) {
      // Drop the oldest rather than the newest. What just happened matters more than what happened
      // thirty events ago, and nothing here is load-bearing — it is text on a screen.
      for (let i = 2; i < MAX_NOTICES * 2; i++) this.noticeRing[i - 2] = this.noticeRing[i] as number;
      this.noticeCount = MAX_NOTICES - 1;
    }
    const at = this.noticeCount * 2;
    this.noticeRing[at] = kind;
    this.noticeRing[at + 1] = slot;
    this.noticeCount++;
  }

  /* -- transport events ------------------------------------------------------------------------- */

  private handleReady(slot: number, room: RoomView, resumed: boolean): void {
    this.slot = slot;
    this.room = room;
    this.readSeats(room);
    this.interruptedAtMs = -1;
    this.heldUntil[slot] = -1;
    this.seats[slot] = SEAT.LIVE;

    if (resumed) {
      this.stats.ownReconnects++;
      this.push(NOTICE.RECONNECTED, slot);
    }

    // The relay's word on who hosts is the only one that counts, and it may have changed while we were
    // away — being the host before a tunnel does not make us the host after one.
    if (room.hostSlot === slot) this.becomeHost(resumed);
    else this.becomeGuest(resumed);

    this.state = PARTY_STATE.PLAYING;
  }

  private handleControl(frame: ControlFrame): void {
    if (frame.kind === CONTROL.PEER_JOINED) {
      this.readSeats(frame.room);
      const s = frame.slot;
      if (s >= 0 && s < MAX_PLAYERS) {
        this.seats[s] = SEAT.LIVE;
        this.heldUntil[s] = -1;
        // A host re-welcomes a returning player unconditionally. `admit` clears their input history, so
        // stale frames from before the drop cannot be confirmed for ticks that have already gone past.
        if (this.host !== null) this.host.admit(s, this.transport.link());
        this.push(NOTICE.PEER_HERE, s);
      }
      return;
    }
    if (frame.kind === CONTROL.PEER_LEFT) {
      const s = frame.slot;
      // Read where the seat *was* before the room view overwrites it. The relay's room already shows
      // the seat empty, so asking after the update always answers "not held" and a seat that quietly
      // ran out of time would be reported to everyone as somebody choosing to leave.
      const wasHeld = s >= 0 && s < MAX_PLAYERS ? this.seats[s] === SEAT.HELD : false;
      this.readSeats(frame.room);
      if (s >= 0 && s < MAX_PLAYERS) {
        if (frame.held) {
          this.seats[s] = SEAT.HELD;
          this.heldUntil[s] = this.o.now() + SEAT_GRACE_MS;
          this.push(NOTICE.PEER_DROPPED, s);
        } else {
          this.seats[s] = SEAT.EMPTY;
          this.heldUntil[s] = -1;
          // The same frame means two different things depending on where the seat was: from LIVE it is
          // somebody pressing quit, from HELD it is the grace window running out on somebody who never
          // made it back. Players read those very differently, so they are separate notices.
          this.push(wasHeld ? NOTICE.PEER_SEAT_EXPIRED : NOTICE.PEER_QUIT, s);
        }
        // Stop addressing a seat nobody is sitting in: pongs and snapshot chunks aimed at a dead seat
        // are pure waste on the host's uplink, which is the tightest budget in the room.
        if (this.host !== null) this.host.setConnected(s, false);
      }
      return;
    }
    // SEATED is what produced onReady, and REFUSED is followed by onDead. Neither needs handling twice.
  }

  /**
   * A game message arrived.
   *
   * `HOST_MIGRATE` is the one type this layer opens, because it is the one type that is about the party
   * rather than the world. The relay authors it — no client can send one, the role table drops it — so
   * a migration cannot be faked by a modified guest.
   */
  private handleGame(bytes: Uint8Array, senderSlot: number): void {
    if (bytes.byteLength < HEADER_BYTES) return;
    if ((bytes[HDR_TYPE] as number) === MSG.HOST_MIGRATE) {
      this.migrate(bytes[HEADER_BYTES] as number);
      return;
    }
    if (this.host !== null) {
      this.host.receive(senderSlot, bytes);
      return;
    }
    if (this.guest !== null) this.guest.receive(bytes);
  }

  private handleDropped(): void {
    if (this.state === PARTY_STATE.ENDED) return;
    this.state = PARTY_STATE.INTERRUPTED;
    this.interruptedAtMs = this.o.now();
    this.push(NOTICE.RECONNECTING, this.slot);
  }

  private handleDead(reason: string): void {
    this.state = PARTY_STATE.ENDED;
    this.endedBecause = reason;
    this.push(NOTICE.PARTY_OVER, this.slot);
  }

  /* -- roles ------------------------------------------------------------------------------------ */

  /**
   * The room has a new host. Everything about this method is about not trusting our own memory.
   */
  private migrate(newHostSlot: number): void {
    if (newHostSlot < 0 || newHostSlot >= MAX_PLAYERS) return;
    this.room.hostSlot = newHostSlot;
    this.stats.migrations++;

    if (newHostSlot === this.slot) {
      if (this.host !== null) {
        // Already hosting. A duplicate announcement is normal — the relay tells the whole room, and we
        // may also have worked it out from the seat frame on reconnect.
        this.stats.redundantMigrations++;
        return;
      }
      this.becomeHost(false);
      return;
    }
    if (this.host !== null) {
      // We thought we were hosting and the relay says otherwise, which is what a host coming back from
      // a drop looks like. The relay is right, always: it is the only thing that saw the whole room.
      this.becomeGuest(true);
      return;
    }
    if (this.guest !== null) {
      this.guest.rehost();
      this.push(NOTICE.HOST_CHANGED, newHostSlot);
    }
  }

  /**
   * Start hosting, either from the beginning or by taking over a run in progress.
   *
   * Taking over does not touch the simulation. This machine was already running the same world a
   * frame ago; what changes is who seals the next record. The one thing that must be right is where
   * the new host's confirm window starts, which is why `resumeFrom` exists — see the comment on
   * `ownedFrom` for what goes wrong without it.
   */
  private becomeHost(resumed: boolean): void {
    const takingOver = this.guest !== null;
    const resumeTick = this.guest !== null ? this.guest.tick : -1;
    this.guest = null;

    const host = new HostSession(this.o.run, this.o.playerCount, true, this.slot);
    if (takingOver && resumeTick >= 0) host.resumeFrom(resumeTick);
    this.host = host;
    this.role = PARTY_ROLE.HOST;

    // Every other live seat gets a fresh welcome. They will each ask for the world themselves, and we
    // deliberately do not push it at them: a snapshot sent before a guest has processed the same
    // migration announcement is a snapshot it throws away, and then we would send it twice.
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (s === this.slot) continue;
      if (this.seats[s] !== SEAT.LIVE) continue;
      host.admit(s, this.transport.link());
    }

    if (takingOver) {
      this.stats.promotions++;
      this.push(NOTICE.YOU_ARE_HOST, this.slot);
    } else if (resumed) {
      this.push(NOTICE.YOU_ARE_HOST, this.slot);
    }
  }

  /**
   * Become a guest of whoever is hosting now.
   *
   * `resumed` covers both ways this happens to a machine that already has a world: we came back from a
   * drop, or we were demoted. Either way the world we are holding is no longer authoritative, so we
   * ask for the whole thing rather than trying to work out which part of it still counts.
   */
  private becomeGuest(resumed: boolean): void {
    const hadWorld = this.host !== null || this.guest !== null;
    this.host = null;

    if (this.guest === null) {
      this.guest = new GuestSession(this.o.run, this.transport.link());
      this.guest.slot = this.slot < 0 ? 0 : this.slot;
    } else {
      this.guest.slot = this.slot < 0 ? 0 : this.slot;
    }
    this.role = PARTY_ROLE.GUEST;

    if (hadWorld && resumed) {
      this.guest.rehost();
      this.push(NOTICE.HOST_CHANGED, this.room.hostSlot);
      return;
    }
    // A first join: say hello and wait to be welcomed with the seed.
    this.guest.hello();
  }

  /** Called by the app when the host's WELCOME has produced a run. Guards the hook against repeats. */
  noteWelcomed(seed: number, stageId: number, tainted: number, playerCount: number): void {
    if (this.welcomed) return;
    this.welcomed = true;
    this.o.onWelcome?.(seed, stageId, tainted, playerCount);
  }

  private readSeats(room: RoomView): void {
    if (room.seats.length === 0) return;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const v = i < room.seats.length ? room.seats[i] : SEAT_VIEW.EMPTY;
      if (v === SEAT_VIEW.LIVE) {
        this.seats[i] = SEAT.LIVE;
        this.heldUntil[i] = -1;
      } else if (v === SEAT_VIEW.HELD) {
        if (this.seats[i] !== SEAT.HELD) this.heldUntil[i] = this.o.now() + SEAT_GRACE_MS;
        this.seats[i] = SEAT.HELD;
      } else {
        this.seats[i] = SEAT.EMPTY;
        this.heldUntil[i] = -1;
      }
    }
  }

  /** True when the link is carrying traffic right now. The HUD's connection light reads this. */
  get isConnected(): boolean {
    return this.transport.state === LINK_STATE.READY;
  }
}
