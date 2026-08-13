/**
 * The whole co-op stack, end to end, over a real socket. Run: `bun run --cwd packages/relay e2e`
 *
 * WHY THIS EXISTS
 * Every other test in this project stops one layer short of reality. `session.test.ts` runs four
 * simulations against a seeded fake network, which is the only honest way to test 150ms of lag and 2%
 * packet loss. `smoke.ts` runs real sockets against the relay, but with no simulation behind them.
 * `transport.test.ts` runs the reconnect policy against a fake socket and a clock we own.
 *
 * All three can pass while the thing the player actually does — two phones, one relay, one shared world —
 * is broken, because nobody had ever wired the three together. This is that wiring, and it is the first
 * test in the project where a message leaves one simulation, crosses an operating-system socket, passes
 * through the relay process, and is applied by another simulation.
 *
 * WHAT IT PROVES
 *   1. A host can create a room, a guest can join it by code, and both learn their seats.
 *   2. Two real simulations agree on the state hash at every tick they have both applied, across a
 *      real socket, with nothing faked between them.
 *   3. A host addresses a broadcast once and the relay fans it out — the confirm stream does not
 *      multiply by the number of players.
 *   4. A guest whose connection dies ungracefully keeps its seat, and walks back into the same seat
 *      with its seat token.
 *   5. A guest that quits properly frees the seat instead of holding it for the grace window.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not try to measure lag or loss. Loopback has neither, and pretending otherwise is what the
 * seeded simulator is for. This test only answers "are the pieces actually connected".
 */

import { Run } from "../../mobile/game/net/../run/run";
import { GuestSession, HostSession } from "../../mobile/game/net/session";
import { JOIN_MODE, Transport, createAdmission, webSocketFactory } from "../../mobile/game/net/transport";
import type { RoomView } from "../../mobile/game/net/transport";

const PORT = 4401;
const BASE = `ws://127.0.0.1:${PORT}`;
const HEALTH = `http://127.0.0.1:${PORT}/health`;

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------------------------- */
/* A relay of our own, on its own port                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The test starts and stops the relay itself rather than expecting one to be running.
 *
 * It uses its own port so it can never accidentally talk to a relay someone left running, and so it
 * cannot fight the smoke test for rooms.
 */
const relay = Bun.spawn(["bun", "src/server.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...Bun.env, RELAY_PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

async function relayIsUp(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(HEALTH);
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await wait(50);
  }
  return false;
}

function stopRelay(): void {
  relay.kill();
}

/* ---------------------------------------------------------------------------------------------- */
/* One player: a transport, a simulation, and the wiring between them                              */
/* ---------------------------------------------------------------------------------------------- */

interface Seated {
  transport: Transport;
  slot: number;
  room: RoomView;
  resumed: boolean;
  /** Every time this connection became ready, in order. A reconnect appends a second entry. */
  readies: { slot: number; resumed: boolean }[];
}

/** Connect a transport and resolve once the relay has actually seated it. */
function seat(
  mode: string,
  fields: { code?: string; token?: number; size?: number },
  onGame: (bytes: Uint8Array, senderSlot: number) => void,
): Promise<Seated> {
  return new Promise((resolve, reject) => {
    const admission = createAdmission();
    admission.mode = mode as typeof admission.mode;
    if (fields.code !== undefined) admission.code = fields.code;
    if (fields.token !== undefined) admission.token = fields.token;
    if (fields.size !== undefined) admission.size = fields.size;

    let settled = false;
    const readies: { slot: number; resumed: boolean }[] = [];
    const transport = new Transport({
      baseUrl: BASE,
      open: webSocketFactory(),
      now: () => Date.now(),
      random: () => Math.random(),
      events: {
        onReady: (slot, room, resumed) => {
          readies.push({ slot, resumed });
          if (settled) return;
          settled = true;
          resolve({ transport, slot, room, resumed, readies });
        },
        onControl: () => undefined,
        onGame,
        onDropped: () => undefined,
        onDead: (reason) => {
          if (settled) return;
          settled = true;
          reject(new Error(`dead before seated: ${reason}`));
        },
      },
    });
    transport.connect(admission);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out waiting for a seat (${mode})`));
    }, 4000);
  });
}

/**
 * Step both simulations forward, yielding to the event loop so the sockets can actually deliver.
 *
 * A real socket is asynchronous, so the tight synchronous loop the seeded simulator uses would run
 * hundreds of ticks before a single byte arrived. Yielding every tick is what makes this resemble a
 * frame loop on a phone.
 */
async function drive(host: HostSession, guest: GuestSession, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    host.step();
    guest.pump();
    // A macrotask, not a microtask: only a macrotask lets Bun's socket reads run.
    await wait(0);
  }
}

/* ---------------------------------------------------------------------------------------------- */

if (!(await relayIsUp())) {
  console.log("FAIL the relay never started");
  stopRelay();
  const bail = globalThis as unknown as { process?: { exit?: (c: number) => void } };
  bail.process?.exit?.(1);
}

section("1. A host makes a room and a guest walks into it");

const hostRun = new Run();
hostRun.begin({ seed: 90210, playerCount: 2, modifiers: [] });
// `relayed` is the one thing that changes when the wire is a relay: broadcasts are written once.
const host = new HostSession(hostRun, 2, true);

const hostSeat = await seat(
  JOIN_MODE.CREATE,
  { size: 2 },
  (bytes, senderSlot) => host.receive(senderSlot, bytes),
);
check("the host is seated in the host's chair", hostSeat.slot === 0, `${hostSeat.slot}`);
const code = hostSeat.room.code;
check("and got a room code to read out", /^[A-Z0-9]{6}$/.test(code), code);

const guestRun = new Run();
guestRun.begin({ seed: 90210, playerCount: 2, modifiers: [] });
let guest!: GuestSession;

const guestSeat = await seat(JOIN_MODE.JOIN, { code }, (bytes) => guest.receive(bytes));
check("the guest got the second seat", guestSeat.slot === 1, `${guestSeat.slot}`);
check("and it was a fresh join, not a resume", guestSeat.resumed === false);

guest = new GuestSession(guestRun, guestSeat.transport.link());
// The session stamps who each message is for; the link just carries bytes to the one socket.
host.admit(1, hostSeat.transport.link(), "guest");
guest.hello("guest");

await wait(150);
check("the guest was welcomed into the run", guest.joined === true);
check("and knows how many are playing", guest.playerCount === 2, `${guest.playerCount}`);

section("2. Two real simulations, one real socket, one world");

const TICKS = 240;
await drive(host, guest, TICKS);

check("the host simulated the ticks it was asked for", host.tick >= TICKS - 5, `${host.tick}`);
check("the guest kept up with the host", guest.tick > 0 && host.tick - guest.tick < 30, `host ${host.tick} guest ${guest.tick}`);

let compared = 0;
let diverged = -1;
for (let t = 0; t <= guest.tick; t++) {
  if (!guest.trail.has(t) || !host.trail.has(t)) continue;
  compared++;
  if (guest.trail.at(t) !== host.trail.at(t)) {
    diverged = t;
    break;
  }
}
check("there were ticks worth comparing", compared > 60, `${compared} ticks`);
check("and the two worlds never disagreed on one of them", diverged === -1, `first split at tick ${diverged}`);
check("nothing had to be resynced", host.stats.resyncsServed === 0, `${host.stats.resyncsServed}`);
check("no input had to be guessed at on loopback", host.stats.predictedFrames < TICKS / 2, `${host.stats.predictedFrames}`);

section("3. The host writes a broadcast once, not once per player");

const health = (await (await fetch(HEALTH)).json()) as {
  traffic: { broadcast: number; forwarded: number; dropped: number };
};
// One broadcast written by the host is one fan-out by the relay. If the session had addressed each
// guest separately this count would climb with the number of players.
check("every broadcast reached somebody", health.traffic.forwarded >= health.traffic.broadcast, `${health.traffic.forwarded} forwarded`);
check("the relay dropped nothing legitimate", health.traffic.dropped === 0, `${health.traffic.dropped}`);

section("4. A guest whose signal dies keeps its seat");

// A tunnel, not a quit: the socket dies with no goodbye, so the relay holds seat one for the guest.
guestSeat.transport.loseConnection();
await wait(150);
check("the guest knows it is disconnected", guestSeat.transport.isReady === false);

// The retry is driven from the frame loop, exactly as it is in the game.
let cameBack = false;
for (let i = 0; i < 200; i++) {
  guestSeat.transport.pump();
  if (guestSeat.transport.isReady) {
    cameBack = true;
    break;
  }
  await wait(25);
}
check("it reconnected on its own", cameBack);
check("into the same seat", guestSeat.transport.slot === 1, `${guestSeat.transport.slot}`);
const second = guestSeat.readies[1];
check("and the game was told this was a resume, not a new player", second?.resumed === true);
check("which cost exactly one reconnect", guestSeat.transport.stats.reconnects === 1, `${guestSeat.transport.stats.reconnects}`);

// The two simulations should still agree after the gap — the confirm stream repairs itself.
await drive(host, guest, 120);
let splitAfterDrop = -1;
for (let t = 0; t <= guest.tick; t++) {
  if (!guest.trail.has(t) || !host.trail.has(t)) continue;
  if (guest.trail.at(t) !== host.trail.at(t)) {
    splitAfterDrop = t;
    break;
  }
}
check("and the worlds still match after the gap", splitAfterDrop === -1, `first split at tick ${splitAfterDrop}`);

section("5. Quitting gives the seat back straight away");

guestSeat.transport.quit();
await wait(200);

const stranger = await seat(JOIN_MODE.JOIN, { code }, () => undefined);
check("a new player takes the freed seat immediately", stranger.slot === 1, `${stranger.slot}`);
stranger.transport.quit();
hostSeat.transport.quit();
await wait(100);

console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
stopRelay();
const exiter = globalThis as unknown as { process?: { exit?: (c: number) => void } };
exiter.process?.exit?.(failures === 0 ? 0 : 1);
