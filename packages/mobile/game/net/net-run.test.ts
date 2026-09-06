/**
 * The co-op run driver, over the seeded fake network. Run headless:
 *   `bun packages/mobile/game/net/net-run.test.ts`
 *
 * WHY THIS FILE EXISTS
 * `NetRun` is the one object the run screen holds instead of ticking a `Run` by hand. It hides whether
 * this phone is a host or a guest, whether to call `step` or `pump`, and where the drawn position of
 * the local player comes from. That is exactly the sort of decision the codebase forbids a screen from
 * making, so it lives in `net/` and is proven here rather than by tapping two phones.
 *
 * It is the same wiring as `packages/relay/test/e2e-session.ts`, but over `SimNetwork` instead of a
 * real socket, so the interesting conditions — latency, loss, reorder — are reproducible. Where the
 * e2e test drives raw `HostSession`/`GuestSession`, this drives them through the `NetRun` wrapper, so a
 * bug in the wrapper's step/pump/receive routing shows up here and not only on a phone.
 *
 * WHAT IT PROVES
 *   1. A host and a guest, each wrapped in a `NetRun`, share one world with no divergence on a perfect
 *      wire and on the contract wire (150ms, 2% loss) — the co-op gate the sessions are measured on.
 *   2. Stick input actually moves the players: a held stick walks both the host's and the guest's own
 *      seat, so the driver is really feeding input and not just holding still.
 *   3. A guest's `renderX/renderY` lead its authoritative position while it holds unsent input — the
 *      `LocalView` is wired and its `lead` climbs above zero — while a host draws exactly the simulation
 *      and reports zero lead. The `lead`/`snaps` accessors are what the dev panel reads to prove on a
 *      real phone that prediction actually engaged.
 *   4. `netRunFromLaunch` does the one-time wiring (host admits, guest says hello, receiver installed)
 *      such that a run built from a launch handle reaches agreement with no manual admit/hello.
 */

import { Run } from "../run/run";
import { NetRun, netRunFromLaunch } from "./net-run";
import type { CoopConnection } from "./net-run";
import {
  DEFAULT_CONDITIONS,
  PERFECT_CONDITIONS,
  SimNetwork,
} from "./sim-network";
import type { NetConditions } from "./sim-network";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const SEED = 4242;

/** A host `NetRun` and one guest `NetRun`, wired through a `SimNetwork`, already joined. */
interface Pair {
  net: SimNetwork;
  host: NetRun;
  guest: NetRun;
}

/**
 * Build a two-phone party where each phone is a `NetRun`, not a raw session.
 *
 * This mirrors `makeParty` in `sim-network.ts`, but wraps each session in the driver the run screen
 * actually uses, so the test exercises `NetRun.step`, `NetRun.receive` and `NetRun.setLocalInput`
 * rather than reaching past them to the sessions underneath.
 */
function makePair(conditions: NetConditions, netSeed = 0x5eed): Pair {
  const net = new SimNetwork(conditions, netSeed);

  const hostRun = new Run();
  hostRun.begin({ seed: SEED, playerCount: 2, modifiers: [], record: false });
  const host = new NetRun({
    run: hostRun,
    playerCount: 2,
    isHost: true,
    localSlot: 0,
    link: net.linkToGuest(1),
    relayed: false,
  });
  net.onHost((slot, bytes) => host.receive(bytes, slot));

  const guestRun = new Run();
  guestRun.begin({ seed: SEED, playerCount: 2, modifiers: [], record: false });
  const guest = new NetRun({
    run: guestRun,
    playerCount: 2,
    isHost: false,
    localSlot: 1,
    link: net.linkToHost(1),
    relayed: false,
  });
  net.onGuest(1, (bytes) => guest.receive(bytes));

  // The one-time wiring, exactly as the e2e test does it by hand: the host hands slot 1 a link to reach
  // it and welcomes it, and the guest asks to be let in.
  host.admit(1, net.linkToGuest(1), "guest");
  guest.hello("guest");

  return { net, host, guest };
}

/** Step the whole pair forward one tick in the real on-phone order: input, host seals, wire, guest applies. */
function stepPair(pair: Pair): void {
  pair.host.step();
  pair.net.pump();
  pair.guest.step();
}

function firstSplit(host: NetRun, guest: NetRun): number {
  const h = host.host;
  const g = guest.guest;
  if (h === null || g === null) return -2;
  for (let t = Math.max(0, g.tick - 600); t <= g.tick; t++) {
    if (!g.trail.has(t) || !h.trail.has(t)) continue;
    if (g.trail.at(t) !== h.trail.at(t)) return t;
  }
  return -1;
}

section("1. Two NetRuns share one world with no divergence");
{
  const perfect = makePair(PERFECT_CONDITIONS, 1);
  for (let i = 0; i < 300; i++) stepPair(perfect);
  perfect.net.flush();
  perfect.guest.step();
  check("host simulated its ticks", perfect.host.tick >= 290, `${perfect.host.tick}`);
  check("guest kept up with the host", perfect.guest.tick > 0 && perfect.host.tick - perfect.guest.tick < 30, `host ${perfect.host.tick} guest ${perfect.guest.tick}`);
  check("a perfect wire never diverges", firstSplit(perfect.host, perfect.guest) === -1, `split ${firstSplit(perfect.host, perfect.guest)}`);

  const gate = makePair(DEFAULT_CONDITIONS, 99);
  for (let i = 0; i < 600; i++) stepPair(gate);
  gate.net.flush();
  gate.guest.step();
  check("the contract wire really lost packets", gate.net.tally.dropped > 0, `${gate.net.tally.dropped}`);
  check("and the contract wire never diverges", firstSplit(gate.host, gate.guest) === -1, `split ${firstSplit(gate.host, gate.guest)}`);
}

section("2. Stick input actually moves both players");
{
  const pair = makePair(PERFECT_CONDITIONS, 2);
  const hostRun = pair.host.run;
  const guestRun = pair.guest.run;
  const host0x = hostRun.players.x[0] ?? 0;
  const guest1x = guestRun.players.x[1] ?? 0;

  // Both hold their sticks hard right for a while.
  for (let i = 0; i < 200; i++) {
    pair.host.setLocalInput(1, 0, 0);
    pair.guest.setLocalInput(1, 0, 0);
    stepPair(pair);
  }
  pair.net.flush();
  pair.guest.step();

  check("the host's own seat moved right", (hostRun.players.x[0] ?? 0) > host0x + 10, `${hostRun.players.x[0]} from ${host0x}`);
  // Slot 1's authoritative position, as the host confirmed it, moved — the guest's input reached the host.
  check("the guest's seat moved on the host's world", (hostRun.players.x[1] ?? 0) > (guest1x + 10), `${hostRun.players.x[1]}`);
  check("and the two worlds still agree", firstSplit(pair.host, pair.guest) === -1, `split ${firstSplit(pair.host, pair.guest)}`);
}

section("3. A guest predicts its own feet; a host draws the simulation");
{
  const pair = makePair(DEFAULT_CONDITIONS, 3);
  // Warm up so the guest has an authoritative position to lead from.
  for (let i = 0; i < 60; i++) {
    pair.host.setLocalInput(1, 0, 0);
    pair.guest.setLocalInput(1, 0, 0);
    stepPair(pair);
  }
  // Now feed the guest fresh unsent intent right before we read its drawn position.
  pair.guest.setLocalInput(1, 0, 0);
  const authGuestX = pair.guest.run.players.x[1] ?? 0;
  const drawnGuestX = pair.guest.renderX(1);
  check("the guest draws at or ahead of its confirmed feet", drawnGuestX >= authGuestX - 0.001, `drawn ${drawnGuestX} auth ${authGuestX}`);
  check("the guest has a LocalView", pair.guest.localView !== null);

  // Prediction is engaged, not just present: while the guest holds a stick under real latency it draws
  // ahead of its confirmed feet by a non-zero lead. This is exactly the number the dev panel surfaces
  // through `NetRun.lead`, so a green here is a guarantee the phone readout can prove prediction on a
  // real device — a guest stuck at lead 0 while moving would fail this and read as the old lag bug.
  let sawLead = false;
  for (let i = 0; i < 60; i++) {
    // Record the intent, then step the pair. The guest keeps sending input the host has not sealed yet
    // (input delay plus the wire), so at each applied tick there are unsealed intents ahead to replay —
    // `lead` is recomputed on that tick and climbs above zero. `lead` lives on `LocalView.onTick`, which
    // only runs when the guest actually advances, which is why the wire has to move.
    pair.guest.setLocalInput(1, 0, 0);
    pair.host.setLocalInput(0, 0, 0);
    stepPair(pair);
    if (pair.guest.lead > 0) sawLead = true;
  }
  check("the guest accumulates lead while holding a stick", sawLead, `lead ${pair.guest.lead}`);
  check("a host reports zero lead (no prediction)", pair.host.lead === 0, `lead ${pair.host.lead}`);

  // The host has no LocalView and draws exactly what its simulation says.
  check("the host has no LocalView", pair.host.localView === null);
  check("the host draws the simulated position", Math.abs(pair.host.renderX(1) - (pair.host.run.players.x[0] ?? 0)) < 0.001);
}

section("4. netRunFromLaunch wires a run with no manual admit/hello");
{
  const net = new SimNetwork(PERFECT_CONDITIONS, 4);

  const hostRun = new Run();
  hostRun.begin({ seed: SEED, playerCount: 2, modifiers: [], record: false });
  const hostConn: CoopConnection = {
    link: net.linkToGuest(1),
    localSlot: 0,
    hostSlot: 0,
    isHost: true,
    setReceiver: (sink) => net.onHost((slot, bytes) => sink(bytes, slot)),
  };
  const host = netRunFromLaunch(hostRun, 2, hostConn);

  const guestRun = new Run();
  guestRun.begin({ seed: SEED, playerCount: 2, modifiers: [], record: false });
  const guestConn: CoopConnection = {
    link: net.linkToHost(1),
    localSlot: 1,
    hostSlot: 0,
    isHost: false,
    setReceiver: (sink) => net.onGuest(1, (bytes) => sink(bytes, 0)),
  };
  const guest = netRunFromLaunch(guestRun, 2, guestConn);

  for (let i = 0; i < 200; i++) {
    host.setLocalInput(0, 1, 0);
    guest.setLocalInput(0, 1, 0);
    host.step();
    net.pump();
    guest.step();
  }
  net.flush();
  guest.step();

  check("the launch-wired guest joined", guest.guest?.joined === true);
  check("both advanced", host.tick > 100 && guest.tick > 100, `host ${host.tick} guest ${guest.tick}`);
  check("and a launch-wired party does not diverge", firstSplit(host, guest) === -1, `split ${firstSplit(host, guest)}`);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const proc = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  proc.process?.exit?.(1);
}
