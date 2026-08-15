/**
 * The lobby → readout adapter. Run headless: `bun packages/mobile/game/dev/lobby-probe.test.ts`
 *
 * WHAT THIS IS FOR
 * This adapter's whole job is to be trusted. It feeds a debugging panel, and a debugging panel that
 * reports a number confidently while being wrong costs more time than one that reports nothing at all —
 * whoever is chasing a co-op bug will believe it and go looking in the wrong place for an hour.
 *
 * So the assertions here are deliberately unkind about two things: that a figure a lobby does not have
 * reads exactly zero rather than borrowing a plausible-looking neighbour, and that the seat tally can
 * never lose or invent a seat however strange the states it is handed.
 *
 * WHAT IT PROVES
 *   1. Seats are counted by state, and live + held + empty always equals the number of seats.
 *   2. A seat state the lobby has never heard of counts as empty instead of vanishing.
 *   3. No seats at all is three zeros, not a crash and not a negative.
 *   4. Message counters come from the lobby's own counters, sent and received not swapped.
 *   5. Every run-only figure — bytes, predicted frames, resyncs, hashes, stalls, snapshots — is zero.
 *   6. Host and guest are reported as the lobby reports them, not inferred from the seats.
 *   7. The protocol version is passed through, so a version mismatch is visible rather than assumed.
 *   8. A backwards clock cannot produce a negative elapsed time.
 */

import { LOBBY_SEAT } from "../lobby/lobby";
import { lobbyLinkSource, lobbyStats, tallySeats } from "./lobby-probe";

let failures = 0;

function check(what: string, ok: boolean, extra = ""): void {
  if (ok) {
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${extra === "" ? "" : ` — ${extra}`}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** Seats from a shorthand: L live, H held, anything else empty. */
function seatsFrom(shorthand: string): { state: number }[] {
  return [...shorthand].map((c) => ({
    state: c === "L" ? LOBBY_SEAT.LIVE : c === "H" ? LOBBY_SEAT.HELD : LOBBY_SEAT.EMPTY,
  }));
}

/* ---------------------------------------------------------------------------------------------- */

section("Counting seats");
{
  const full = tallySeats(seatsFrom("LLLL"));
  check("four live seats count as four live", full.live === 4);
  check("and none held", full.held === 0);
  check("and none empty", full.empty === 0);

  const mixed = tallySeats(seatsFrom("LHE-"));
  check("one live is found in a mixed lobby", mixed.live === 1);
  check("one held is found in a mixed lobby", mixed.held === 1);
  check("and the remaining two read as empty", mixed.empty === 2);
  check("the three counts add up to the seats", mixed.live + mixed.held + mixed.empty === 4);

  const held = tallySeats(seatsFrom("HHHH"));
  check("a lobby of nothing but held seats has no live seats", held.live === 0);
  check("and four held", held.held === 4);
  check("and none empty", held.empty === 0);
}

section("Seat states we have never seen");
{
  // A newer build, or a corrupted frame, can hand us a state number this build has no name for. It
  // must land somewhere — a seat that is counted nowhere reads on the panel as a player who vanished.
  const strange = tallySeats([{ state: 99 }, { state: -1 }, { state: LOBBY_SEAT.LIVE }]);
  check("an unknown seat state is not counted as live", strange.live === 1);
  check("nor as held", strange.held === 0);
  check("it falls through to empty", strange.empty === 2);
  check("and nothing is lost", strange.live + strange.held + strange.empty === 3);

  const none = tallySeats([]);
  check("no seats is zero live", none.live === 0);
  check("no seats is zero held", none.held === 0);
  check("no seats is zero empty, never a negative", none.empty === 0);
}

section("The counters a lobby really keeps");
{
  const stats = lobbyStats({ sent: 12, received: 34 });
  check("messages sent comes from the lobby's sent count", stats.messagesSent === 12);
  check("messages received comes from the lobby's received count", stats.messagesReceived === 34);
  check("the two are not swapped", stats.messagesSent !== stats.messagesReceived);
}

section("The figures a lobby does not have read zero");
{
  const stats = lobbyStats({ sent: 7, received: 9 });
  check("bytes sent is zero, not borrowed from the message count", stats.bytesSent === 0);
  check("bytes received is zero, not borrowed from the message count", stats.bytesReceived === 0);
  check("predicted frames is zero: a lobby does not simulate", stats.predictedFrames === 0);
  check("resyncs served is zero", stats.resyncsServed === 0);
  check("resyncs requested is zero", stats.resyncsRequested === 0);
  check("hash mismatches is zero: there are no world hashes yet", stats.hashMismatches === 0);
  check("stalled ticks is zero: there are no ticks yet", stats.stalledTicks === 0);
  check("snapshot bytes is zero", stats.snapshotBytes === 0);
}

section("The whole source, as the panel reads it");
{
  const view = { isHost: true, seats: seatsFrom("LLH-") };
  const src = lobbyLinkSource(view, { sent: 5, received: 6 }, 2000, 4);

  check("hosting is reported as hosting", src.isHost);
  check("the tick is zero: a lobby does not tick", src.tick === 0);
  check("the protocol version is passed through untouched", src.protocolVersion === 4);
  check("a different protocol version is not clamped to ours", lobbyLinkSource(view, { sent: 0, received: 0 }, 0, 99).protocolVersion === 99);
  check("live seats reach the panel", src.liveSeats === 2);
  check("held seats reach the panel", src.heldSeats === 1);
  check("empty seats reach the panel", src.emptySeats === 1);
  check("the message counters reach the panel", src.stats.messagesSent === 5 && src.stats.messagesReceived === 6);
  check("round-trip p50 is zero: the lobby transport does not measure it", src.rttP50 === 0);
  check("round-trip p95 is zero", src.rttP95 === 0);
  check("worst round-trip is zero", src.rttWorst === 0);
  check("elapsed time is passed through", src.elapsedMs === 2000);

  const guest = lobbyLinkSource({ isHost: false, seats: seatsFrom("LLLL") }, { sent: 0, received: 0 }, 0, 4);
  check("a guest is reported as a guest", !guest.isHost);
  check("and being a guest is not inferred from having a full lobby", guest.liveSeats === 4);
}

section("A clock that goes backwards");
{
  // Phones move their clocks: time zones, NTP corrections, a user changing the date. A negative
  // elapsed time would turn every per-second figure on the panel into nonsense.
  const view = { isHost: false, seats: seatsFrom("L---") };
  check("a negative elapsed time is floored at zero", lobbyLinkSource(view, { sent: 0, received: 0 }, -5000, 4).elapsedMs === 0);
  check("zero stays zero", lobbyLinkSource(view, { sent: 0, received: 0 }, 0, 4).elapsedMs === 0);
  check("a positive elapsed time is untouched", lobbyLinkSource(view, { sent: 0, received: 0 }, 1, 4).elapsedMs === 1);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
