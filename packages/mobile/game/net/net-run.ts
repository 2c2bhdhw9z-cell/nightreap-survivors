/**
 * NetRun — the one small object that drives a co-op run, so the run screen stays thin.
 *
 * WHY THIS EXISTS
 * `HostSession` and `GuestSession` already do all the hard work: sealing records, predicting late
 * input, repairing lost confirms, resyncing a guest that fell behind. `LocalView` already makes a
 * guest's own feet feel instant. What none of them do is answer the run screen's one question every
 * frame — "advance the shared world by the input I am holding" — without the screen having to know
 * whether it is a host or a guest, whether to call `step()` or `pump()`, and where the drawn position
 * of the local player comes from.
 *
 * That knowledge is exactly the sort of rule that must not live in a React screen, because a rule in a
 * screen can only be tested by tapping a phone. So it lives here, and the screen holds a `NetRun` and
 * feeds it a stick.
 *
 * This is the same wiring as `packages/relay/test/e2e-session.ts` and `game/net/party.ts`, extracted
 * to one place with no socket of its own. `Party` owns the whole connection-and-migration story and
 * opens its own `Transport`; the co-op launch reuses the socket the lobby already holds, so it hands a
 * ready `Link` in instead. When there is no migration to worry about — one launch, one run — a `NetRun`
 * over a borrowed link is the smaller thing, and it is unit-tested against the same `SimNetwork` the
 * sessions are.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - Reconnects, migration, seat grace. Those are `Party`'s job. A launched run that loses its host
 *     mid-fight is a follow-up; the win this feature ships is two players in one world.
 *   - Sockets. It is handed a `Link`, exactly like the sessions it wraps, so the same driver runs in a
 *     test against a latency-and-loss simulator and in the app against a WebSocket.
 *   - Rendering. `LocalView` is display-only and reads out through `renderX/renderY`; the driver never
 *     touches a pixel.
 */

import type { Run } from "../run/run";
import { BASE_MOVE_SPEED, PLAYER_STATE } from "../sim/player";
import { STAT, STAT_SCALE } from "../sim/stats";
import { GuestSession, HostSession, type Link } from "./session";
import { LocalView } from "./local-view";

/** Sim rate, matching the simulation. Used to turn a move-speed stat into px-per-second for prediction. */
const TICK_SECONDS = 1 / 60;

export interface NetRunOptions {
  /** The world. Already begun on the launch seed/stage/playerCount, exactly as the host's is. */
  run: Run;
  /** Party size agreed in the lobby. Fixed for the whole run. */
  playerCount: number;
  /** True on the one phone the relay seated as host. */
  isHost: boolean;
  /** Our seat. Zero for the host who opened the room; whatever the relay stamped for a guest. */
  localSlot: number;
  /** The lobby's already-seated link. Broadcasts and per-guest sends both go down this one socket. */
  link: Link;
  /**
   * True when every peer is reached through one relay socket rather than a direct link each. Always
   * true in the app — the relay is the wire — and left switchable so the deterministic tests can drive
   * a host that talks to each guest on its own link.
   */
  relayed?: boolean;
}

/**
 * One phone's view of a shared run.
 *
 * A host holds a `HostSession` and no more: it is a player whose own stick is available with no wire
 * hop, and `LocalView` would replay zero pending intents for it, so the drawn position is the simulated
 * position and there is nothing to gain. A guest holds a `GuestSession` and a `LocalView`, because a
 * guest's authoritative position is always a fraction of a round trip behind its thumb.
 */
export class NetRun {
  readonly run: Run;
  readonly playerCount: number;
  readonly isHost: boolean;
  readonly localSlot: number;

  /** Live only on the host. */
  readonly host: HostSession | null = null;
  /** Live only on a guest. */
  readonly guest: GuestSession | null = null;
  /** Dead reckoning for the local player. Only built for a guest; null on the host and solo. */
  readonly localView: LocalView | null = null;

  /** True once the guest has been welcomed into the run. Always true for a host. */
  private helloSent = false;

  constructor(options: NetRunOptions) {
    this.run = options.run;
    this.playerCount = options.playerCount;
    this.isHost = options.isHost;
    this.localSlot = options.localSlot;

    if (options.isHost) {
      this.host = new HostSession(
        options.run,
        options.playerCount,
        options.relayed ?? true,
        options.localSlot,
      );
    } else {
      this.guest = new GuestSession(options.run, options.link);
      this.guest.slot = options.localSlot;
      this.localView = new LocalView();
      this.localView.reset(options.run.players.x[options.localSlot] ?? 0, options.run.players.y[options.localSlot] ?? 0);
    }
  }

  /**
   * Attach a guest's return path on the host and welcome them, or say hello as a guest.
   *
   * On the host this is how each seated guest gets a `Link` to reach it and a WELCOME with the seed. On
   * a guest it is the one HELLO that asks to be let in. Called once, after construction, when the caller
   * knows every seat that launched.
   */
  admit(slot: number, link: Link, name = ""): void {
    this.host?.admit(slot, link, name);
  }

  /** Say hello as a guest. No-op on a host. Safe to call more than once; only the first is sent. */
  hello(name = ""): void {
    if (this.isHost || this.guest === null || this.helloSent) return;
    this.helloSent = true;
    this.guest.hello(name);
  }

  /**
   * Feed the local phone's stick for the tick about to be sealed.
   *
   * Records the intent into `LocalView` first, at the moment of capture, because that is the whole
   * point of dead reckoning: the phone knows its own thumb long before the host confirms it.
   */
  setLocalInput(x: number, y: number, buttons: number): void {
    if (this.host !== null) {
      this.host.setLocalInput(x, y, buttons);
      return;
    }
    const g = this.guest as GuestSession;
    // Record the intent for the next tick the guest will send, so the replay lines up with the world.
    this.localView?.record(g.tick + 1, x, y);
    g.setLocalInput(x, y, buttons);
  }

  /** Ask the host or guest to answer an open card screen. */
  requestCardAction(action: number): void {
    this.host?.requestCardAction(action);
    this.guest?.requestCardAction(action);
  }

  /**
   * Advance the shared world by as much as this phone is allowed to.
   *
   * A host seals and simulates exactly one tick and returns 1, or 0 when the run is over. A guest
   * applies whatever the host has confirmed since last time — zero, one or several ticks while it is
   * catching up — and returns how many it advanced. After each applied guest tick the local player's
   * authoritative position is handed to `LocalView`, so the drawn feet chase the truth.
   */
  step(): number {
    if (this.host !== null) return this.host.step() ? 1 : 0;
    const g = this.guest as GuestSession;
    const before = g.tick;
    const advanced = g.pump();
    if (advanced > 0 && this.localView !== null) this.onGuestTicks(before + 1, g.tick);
    return advanced;
  }

  /**
   * Feed one inbound frame.
   *
   * The host is told which seat spoke — its `receive` stamps input into that seat's column. A guest
   * reads only the host, so the sender is not its concern.
   */
  receive(bytes: Uint8Array, senderSlot = 0): void {
    if (this.host !== null) {
      this.host.receive(senderSlot, bytes);
      return;
    }
    this.guest?.receive(bytes);
  }

  /** Highest session tick this phone has applied. -1 before the first. */
  get tick(): number {
    return this.host !== null ? this.host.tick : (this.guest as GuestSession).tick;
  }

  /** The drawn X of the local player, interpolated. The simulated X on a host, dead-reckoned on a guest. */
  renderX(alpha: number): number {
    if (this.localView === null) return this.run.players.x[this.localSlot] ?? 0;
    return this.localView.renderX(alpha);
  }

  renderY(alpha: number): number {
    if (this.localView === null) return this.run.players.y[this.localSlot] ?? 0;
    return this.localView.renderY(alpha);
  }

  /**
   * Hand each freshly applied tick's authoritative local position to the dead-reckoner.
   *
   * The move speed is the player's *current* speed including every stat, not the base — a guest who has
   * taken a boot upgrade would under-predict on the base number, and the error grows with every pending
   * tick.
   */
  private onGuestTicks(from: number, to: number): void {
    const view = this.localView as LocalView;
    const players = this.run.players;
    const slot = this.localSlot;
    const speed = (BASE_MOVE_SPEED * this.run.stats.get(STAT.moveSpeed)) / STAT_SCALE;
    const alive = players.state[slot] === PLAYER_STATE.alive;
    for (let t = from; t <= to; t++) {
      view.onTick(t, players.x[slot] ?? 0, players.y[slot] ?? 0, speed, alive);
    }
  }
}

/**
 * The launch handle a lobby hands to a run: a live link, our seat, the host's seat, whether we host.
 *
 * Structurally the same as `CoopLink` in `coop-handoff.ts`, spelled out here so `net/` need not import
 * from the handoff module — the driver is the lower layer and the handoff is what carries it. `pump` and
 * `setReceiver` are the borrowed transport's, optional so the fake-network tests can leave them off.
 */
export interface CoopConnection {
  link: Link;
  localSlot: number;
  hostSlot: number;
  isHost: boolean;
  setReceiver?: (sink: (bytes: Uint8Array, senderSlot: number) => void) => void;
}

/**
 * Build a fully wired `NetRun` from a launch handle and an already-begun run.
 *
 * This is the app's counterpart to what `makeParty` does in the tests: it does the one-time wiring that
 * `e2e-session.ts` spells out by hand — the guest says hello, the host admits every other seat and gives
 * each one the link to reach it, and the transport's inbound game frames are pointed at the new session.
 * After this returns, the caller only ever calls `setLocalInput` and `step` in its frame loop.
 *
 * The run must already have been begun on the launch's seed, stage and player count, because a host
 * `admit` sends a WELCOME describing the world as it stands, and a guest builds its own identical world
 * from the same numbers.
 */
export function netRunFromLaunch(run: Run, playerCount: number, connection: CoopConnection): NetRun {
  const netRun = new NetRun({
    run,
    playerCount,
    isHost: connection.isHost,
    localSlot: connection.localSlot,
    link: connection.link,
    relayed: true,
  });

  // Point the socket's inbound game frames at the session before anything is sent, so a WELCOME or a
  // first confirm that arrives immediately is not dropped.
  connection.setReceiver?.((bytes, senderSlot) => netRun.receive(bytes, senderSlot));

  if (connection.isHost) {
    // Every other seat in the party gets the return link and a WELCOME. The relay routes each stamped
    // message to the right seat; over a relay every guest's link is the same socket.
    for (let slot = 0; slot < playerCount; slot++) {
      if (slot === connection.localSlot) continue;
      netRun.admit(slot, connection.link);
    }
  } else {
    netRun.hello();
  }
  return netRun;
}
