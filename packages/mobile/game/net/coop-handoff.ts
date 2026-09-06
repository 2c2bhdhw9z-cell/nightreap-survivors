/**
 * The hand-off between a co-op lobby and the run it launches.
 *
 * WHY THIS EXISTS
 *
 * The lobby and the run are two screens, and a launch has to carry a live thing across the gap between
 * them: a socket the relay has already seated, mid-connection, with a room full of people on the other
 * end. Expo-router only carries strings between routes, so the socket cannot travel as a route param —
 * a `ws://` object flattened to a string and rebuilt on the run screen would be a *second* connection,
 * racing the seat the lobby is still holding, and the relay would refuse the duplicate or split the
 * party across two sockets.
 *
 * So the live thing does not travel by route at all. It is set down here, in one module-level slot,
 * and picked up by the run screen when it mounts. This is the exact pattern `game/save/handoff.ts`
 * already uses to carry a finished run to the results screen; the shape is deliberately the same so
 * there is one idea to learn, not two.
 *
 * WHAT IT CARRIES
 *
 * A `CoopLaunch`: the launch parameters every phone agreed on (seed, stage, party size), and a handle
 * to the live connection (the transport's `Link`, our seat, the host's seat, and whether we are the
 * host). The run screen builds a `NetRun` from exactly this and nothing else.
 *
 * THE ONE HARD RULE: A LAUNCH IS TAKEN EXACTLY ONCE
 *
 * A socket handed to two runs is a socket two things believe they own, and the second run to mount —
 * an accidental remount, a fast back-and-forward — would drive a session over a link the first run is
 * already draining. So `take` clears the slot: the first mount gets the launch, a second mount gets
 * null and falls back to solo rather than fighting over a dead handle. `peek` reads without clearing,
 * for a screen that wants to decide *whether* to take before committing.
 *
 * WHAT IS NOT HERE
 *
 * Tearing the connection down. Leaving a launched run frees the seat — that is the run screen's job,
 * because only it knows when the run is truly over. This slot only carries the handle; it never closes
 * it. A launch that is set down and never taken is a leak the caller must clear with `reset`, which is
 * why `stage` refuses to overwrite a launch that is still waiting rather than silently dropping it.
 */

import type { Link } from "./session";

/** Why a stage was refused. Append-only: these numbers can reach a log line. */
export const COOP_HANDOFF = {
  /** Staged, and the slot now holds the launch. */
  OK: 0,
  /** A launch is still waiting to be taken. Nothing was changed. */
  SLOT_BUSY: 1,
} as const;

export type CoopHandoffCode = (typeof COOP_HANDOFF)[keyof typeof COOP_HANDOFF];

/**
 * A handle to the connection the lobby already seated, and the run it is launching.
 *
 * `link` is the transport's own `Link` — the same one the sessions everywhere else are handed — so the
 * run drives a session over the lobby's socket without ever seeing the socket. `pump` is optional and
 * lets the run keep the underlying transport's reconnect timing driven from its own frame loop, since
 * a transport owns no clock of its own; a driver built against a fake network leaves it undefined.
 */
export interface CoopLink {
  link: Link;
  /** Our seat, as the relay stamped it. */
  localSlot: number;
  /** The host's seat. Equal to `localSlot` on the host. */
  hostSlot: number;
  /** True on the one phone the relay seated as host. */
  isHost: boolean;
  /**
   * Each seat's chosen character, indexed by slot, as the roster held them at launch.
   *
   * These ride the roster the host already published — every phone agreed on them before START was
   * pressed — so they carry no new wire message and cost no protocol bump. The run reads them at
   * `startRun` and begins each seat with its own survivor. A slot nobody sat in is a harmless 0, which the
   * run treats as "the first character" exactly as an unseated slot always has.
   */
  characterIds: readonly number[];
  /**
   * Route inbound game frames to the run's net session. The run calls this once, with its session's
   * `receive`, so confirms and input batches reach the session instead of the lobby. Optional so a
   * driver built against a fake network — which delivers frames itself — need not provide it.
   */
  setReceiver?: (sink: (bytes: Uint8Array, senderSlot: number) => void) => void;
  /** Drive reconnect timing on the borrowed transport, once a frame. Optional. */
  pump?: () => void;
  /** Free the seat for good. Called by the run when it ends, so no seat is leaked. */
  leave?: () => void;
}

/** Everything the run screen needs to begin a shared run, live handle and all. */
export interface CoopLaunch {
  seed: number;
  stageId: number;
  playerCount: number;
  connection: CoopLink;
}

/** What a stage attempt did. `staged` is true only when the slot actually took the launch. */
export interface CoopStageOutcome {
  code: CoopHandoffCode;
  staged: boolean;
}

/**
 * The single slot between a lobby and the run it launches.
 *
 * A class rather than loose module state so the tests can make as many as they like without one test's
 * staged launch leaking into the next, exactly as `RunHandoff` is.
 */
export class CoopHandoff {
  private slot: CoopLaunch | null = null;

  /**
   * Set down a launch for the run screen to pick up.
   *
   * Refuses without touching anything if a launch is still waiting: overwriting it would strand the
   * previous connection's seat with nobody left holding a reference to close it.
   */
  stage(launch: CoopLaunch): CoopStageOutcome {
    if (this.slot !== null) return { code: COOP_HANDOFF.SLOT_BUSY, staged: false };
    this.slot = launch;
    return { code: COOP_HANDOFF.OK, staged: true };
  }

  /** Read the staged launch without consuming it, so a screen can decide before it commits. */
  peek(): CoopLaunch | null {
    return this.slot;
  }

  /** Read and clear. The run screen calls this once at mount, so a remount cannot re-consume it. */
  take(): CoopLaunch | null {
    const held = this.slot;
    this.slot = null;
    return held;
  }

  /** True when a launch is waiting to be taken. */
  get pending(): boolean {
    return this.slot !== null;
  }

  /**
   * Forget the slot without closing anything.
   *
   * For tests and for a launch that was set down and then abandoned before any run took it. It does not
   * call `leave` — clearing the slot is not the same as ending the party, and a caller that wants the
   * seat freed must do that itself.
   */
  reset(): void {
    this.slot = null;
  }
}

/** The one slot the app uses. */
export const coopHandoff = new CoopHandoff();
