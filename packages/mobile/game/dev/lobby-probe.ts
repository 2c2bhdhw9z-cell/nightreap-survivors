/**
 * Turns what a lobby knows into what the dev menu's COOP readout wants to draw.
 *
 * WHY THIS EXISTS
 * The readout was written against a live *run* — a simulation with ticks, predicted frames, hashes and
 * round-trip times. A lobby has none of that: it is a socket, four seats and a chat log. Until a run
 * exists to attach, the panel showed NO LIVE SESSION and every co-op problem before the run started was
 * invisible, which is exactly where co-op problems live.
 *
 * So this maps a lobby onto the same shape. The rule followed throughout: a figure a lobby genuinely
 * does not have reads zero, and never a stand-in borrowed from a different figure. A diagnostic that
 * guesses is worse than one that admits it knows nothing — the whole point of the panel is to be
 * believed.
 *
 * It is a plain function over plain data, so it is testable without a socket, a screen or a clock.
 */

import { LOBBY_SEAT } from "../lobby/lobby";

import type { LinkSource, StatsLike } from "./coop-lab";

/** The seat states the readout counts, as the lobby reports them. */
export interface SeatStateRow {
  readonly state: number;
}

/** Just the parts of a lobby's view this needs. Structural, so the real view fits without a cast. */
export interface LobbyViewLike {
  readonly isHost: boolean;
  readonly seats: readonly SeatStateRow[];
}

/** Just the parts of a lobby's diagnostics this needs. */
export interface LobbyDiagnosticsLike {
  readonly sent: number;
  readonly received: number;
}

/** A seat tally: three numbers that always add up to the number of seats. */
export interface SeatTally {
  readonly live: number;
  readonly held: number;
  readonly empty: number;
}

/**
 * Count the seats by state.
 *
 * Anything that is not LIVE or HELD counts as empty rather than being dropped, so the three numbers
 * always sum to the seat count. A tally that quietly loses a seat would read as a vanished player.
 */
export function tallySeats(seats: readonly SeatStateRow[]): SeatTally {
  let live = 0;
  let held = 0;
  for (const seat of seats) {
    if (seat.state === LOBBY_SEAT.LIVE) live++;
    else if (seat.state === LOBBY_SEAT.HELD) held++;
  }
  return { live, held, empty: seats.length - live - held };
}

/**
 * The message counters a lobby really keeps, in the shape the readout wants.
 *
 * Byte counts, predicted frames, resyncs, hash mismatches, stalled ticks and snapshot bytes are all
 * properties of a running simulation. A lobby has no simulation, so they are zero here — deliberately,
 * and not because they were forgotten.
 */
export function lobbyStats(diagnostics: LobbyDiagnosticsLike): StatsLike {
  return {
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: diagnostics.sent,
    messagesReceived: diagnostics.received,
    predictedFrames: 0,
    resyncsServed: 0,
    resyncsRequested: 0,
    hashMismatches: 0,
    stalledTicks: 0,
    snapshotBytes: 0,
  };
}

/**
 * Build the readout's source from a lobby.
 *
 * `tick` is zero because a lobby does not tick, and the round-trip figures are zero because the lobby
 * transport does not measure them. `elapsedMs` is clamped at zero so a clock that goes backwards — which
 * a phone's clock does, on a time-zone change or an NTP correction — can never produce a negative rate.
 */
export function lobbyLinkSource(
  view: LobbyViewLike,
  diagnostics: LobbyDiagnosticsLike,
  elapsedMs: number,
  protocolVersion: number,
): LinkSource {
  const seats = tallySeats(view.seats);
  return {
    isHost: view.isHost,
    tick: 0,
    protocolVersion,
    stats: lobbyStats(diagnostics),
    liveSeats: seats.live,
    heldSeats: seats.held,
    emptySeats: seats.empty,
    rttP50: 0,
    rttP95: 0,
    rttWorst: 0,
    elapsedMs: elapsedMs > 0 ? elapsedMs : 0,
  };
}
