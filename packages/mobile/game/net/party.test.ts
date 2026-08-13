/**
 * The party layer. Run headless: `bun packages/mobile/game/net/party.test.ts`
 *
 * WHAT THIS IS FOR
 * `transport.test.ts` proves we get onto a relay and back after a tunnel. `session.test.ts` proves four
 * simulations fed one confirmed record stream stay in the same world. Neither of them asks the question
 * this layer exists to answer: *who is hosting right now*, and what happens to everyone's world the
 * moment that answer changes because somebody's app was killed.
 *
 * Every failure in here is silent in the worst way. A promoted host that re-confirms ticks it never
 * sealed hands a guest running behind a stretch of invented input, and the guest applies it without
 * complaint — two worlds, no error, nobody told. So the socket and the clock are fakes we drive by
 * hand, and the assertions are made against the bytes that actually go out on the wire rather than
 * against internal bookkeeping that could agree with itself while being wrong.
 *
 * WHAT IT PROVES
 *   1. The relay's word decides the role: seated as the host slot we host, otherwise we are a guest.
 *   2. A guest promoted mid-run keeps its world and never confirms a tick it did not seal itself.
 *   3. A guest that was not promoted throws its queue away and asks the new host for the whole world.
 *   4. A duplicate migration announcement is counted and ignored, not acted on twice.
 *   5. A host the relay has demoted becomes a guest, however sure it was that it was hosting.
 *   6. Our own connection dying freezes the world instead of running one nobody else has.
 *   7. The grace countdown is derived from the clock, so a backgrounded phone comes back with the truth.
 *   8. The same seat-left frame reads as dropped, quit or expired depending on where the seat was.
 *   9. The notice queue overflows by dropping the oldest, and draining it allocates nothing.
 *  10. A host stops writing to a seat nobody is sitting in.
 */

import { Run } from "../run/run";
import { Reader, Writer } from "./codec";
import { decodeTickConfirmHeader, encodeHostMigrate, type TickConfirmHeader } from "./messages";
import { HDR_TYPE, HEADER_BYTES, MAX_MESSAGE_BYTES, MSG } from "./protocol";
import { HostSession, type Link } from "./session";
import {
  MAX_NOTICES,
  NOTICE,
  PARTY_ROLE,
  PARTY_STATE,
  Party,
  SEAT,
  type PartyOptions,
} from "./party";
import {
  CLOSE_INTENTIONAL,
  CLOSE_LOST,
  SEAT_GRACE_MS,
  createAdmission,
  type RawSocket,
  type SocketHandlers,
} from "./transport";

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

/* ---------------------------------------------------------------------------------------------- */
/* A relay we play the part of, and a clock we own                                                 */
/* ---------------------------------------------------------------------------------------------- */

interface FakeSocket extends RawSocket {
  url: string;
  handlers: SocketHandlers;
  closedWith: number;
  binary: Uint8Array[];
  text: string[];
}

/** A world of one phone: its sockets, its clock, and the party sitting on top of them. */
class World {
  ms = 10_000;
  sockets: FakeSocket[] = [];
  run = new Run();
  party: Party;

  private readonly writer = new Writer(MAX_MESSAGE_BYTES);

  constructor(playerCount = 2, onWelcome?: PartyOptions["onWelcome"]) {
    this.run.begin({ seed: 4242, playerCount, record: false });
    this.party = new Party({
      run: this.run,
      playerCount,
      baseUrl: "ws://relay.test:4400",
      open: this.open,
      now: this.now,
      random: this.random,
      onWelcome,
    });
  }

  now = (): number => this.ms;
  /** Fixed, so reconnect backoff is a known number of milliseconds rather than a flaky one. */
  random = (): number => 0.5;

  open = (url: string, handlers: SocketHandlers): RawSocket => {
    const sock: FakeSocket = {
      url,
      handlers,
      closedWith: -1,
      binary: [],
      text: [],
      send: (data: Uint8Array | string) => {
        if (typeof data === "string") sock.text.push(data);
        // Copy: the writer reuses one buffer, so keeping the reference would keep re-reading the
        // newest message under an old name and every assertion about history would be a lie.
        else sock.binary.push(new Uint8Array(data));
      },
      close: (code = 1000) => {
        sock.closedWith = code;
      },
    };
    this.sockets.push(sock);
    return sock;
  };

  latest(): FakeSocket {
    return this.sockets[this.sockets.length - 1] as FakeSocket;
  }

  /** What the relay sends a player it has just seated. */
  seat(slot: number, hostSlot: number, seats: string[]): void {
    const sock = this.latest();
    sock.handlers.onOpen();
    sock.handlers.onText(
      JSON.stringify({
        t: "seated",
        slot,
        token: 0x0badc0de,
        room: { code: "ABC234", hostSlot, targetSize: seats.length, public: false, seats },
      }),
    );
  }

  /** A seat filling, from the relay. */
  peerJoined(slot: number, seats: string[]): void {
    this.latest().handlers.onText(
      JSON.stringify({
        t: "peer_joined",
        slot,
        room: { code: "ABC234", hostSlot: 0, targetSize: seats.length, public: false, seats },
      }),
    );
  }

  /** A seat emptying. `held` true means the countdown is running; false means it is gone for good. */
  peerLeft(slot: number, held: boolean, seats: string[]): void {
    this.latest().handlers.onText(
      JSON.stringify({
        t: "peer_left",
        slot,
        held,
        room: { code: "ABC234", hostSlot: 0, targetSize: seats.length, public: false, seats },
      }),
    );
  }

  /** The relay's migration announcement. No client can author one of these. */
  migrate(newHostSlot: number): void {
    this.latest().handlers.onBinary(encodeHostMigrate(this.writer, newHostSlot, 0));
  }

  /** The signal dies. Not a close code we asked for, so the transport will try to come back. */
  loseSocket(): void {
    this.latest().handlers.onClose(CLOSE_LOST);
    this.party.step();
  }
}

const LIVE2 = ["live", "live"];
const LIVE2_OF_4 = ["live", "live", "empty", "empty"];

/** Every tick confirm on this socket, oldest first, as decoded headers. */
function confirmHeaders(sock: FakeSocket): TickConfirmHeader[] {
  const out: TickConfirmHeader[] = [];
  for (const bytes of sock.binary) {
    if ((bytes[HDR_TYPE] as number) !== MSG.TICK_CONFIRM) continue;
    const header: TickConfirmHeader = { firstTick: 0, count: 0, playerCount: 0 };
    decodeTickConfirmHeader(new Reader(bytes), header);
    out.push(header);
  }
  return out;
}

function countType(sock: FakeSocket, type: number): number {
  let n = 0;
  for (const bytes of sock.binary) if ((bytes[HDR_TYPE] as number) === type) n++;
  return n;
}

/* ---------------------------------------------------------------------------------------------- */

section("1. The relay decides who hosts");
{
  const w = new World(2);
  w.party.join(createAdmission());
  check("connecting is not yet playing", w.party.state === PARTY_STATE.JOINING);
  w.seat(0, 0, LIVE2);
  check("seated as the host slot means hosting", w.party.role === PARTY_ROLE.HOST);
  check("a host has a host session", w.party.host !== null);
  check("and no guest session to confirm with", w.party.guest === null);
  check("the world is running", w.party.state === PARTY_STATE.PLAYING);
  check("both seats read as live", w.party.liveSeats === 2, `saw ${w.party.liveSeats}`);
  check("our own seat is known", w.party.slot === 0);

  const g = new World(2);
  g.party.join(createAdmission());
  g.seat(1, 0, LIVE2);
  check("seated elsewhere means being a guest", g.party.role === PARTY_ROLE.GUEST);
  check("a guest has no host session", g.party.host === null);
  check("a guest says hello to get the seed", countType(g.latest(), MSG.HELLO) === 1);
  check("a guest knows its own seat", g.party.guest?.slot === 1);
}

section("2. A promoted guest never confirms a tick it did not seal");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(1, 0, LIVE2);
  const guest = w.party.guest;
  check("we start as a guest", guest !== null);
  // The world this guest is holding, forty ticks in. The host it was following is about to vanish.
  if (guest !== null) {
    guest.tick = 40;
    guest.horizon = 40;
  }
  const before = w.latest().binary.length;

  w.migrate(1);
  check("we are hosting now", w.party.role === PARTY_ROLE.HOST);
  check("the promotion was counted", w.party.stats.promotions === 1);
  check("and the migration was counted", w.party.stats.migrations === 1);
  check("the guest session is gone", w.party.guest === null);
  check("the world was not restarted", w.party.host?.run === w.run);

  for (let i = 0; i < 30; i++) w.party.step();
  const headers = confirmHeaders(w.latest());
  check("the new host is confirming", headers.length > 0, `saw ${headers.length}`);
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const h of headers) if (h.firstTick < earliest) earliest = h.firstTick;
  check(
    "and never re-confirms a tick sealed by the host that vanished",
    earliest > 40,
    `earliest confirmed tick was ${earliest}`,
  );
  check("the party was told who is in charge", w.party.pendingNotices > 0);
  const out = new Int32Array(MAX_NOTICES * 2);
  const n = w.party.takeNotices(out);
  let sawHost = false;
  for (let i = 0; i < n; i++) if (out[i * 2] === NOTICE.YOU_ARE_HOST) sawHost = true;
  check("with the you-are-host notice", sawHost);
  check("bytes went out after the promotion", w.latest().binary.length > before);
}

section("3. A guest that was not promoted asks for the whole world");
{
  const w = new World(3);
  w.party.join(createAdmission());
  w.seat(2, 0, ["live", "live", "live"]);
  const guest = w.party.guest;
  if (guest !== null) {
    guest.tick = 60;
    guest.horizon = 75;
  }
  const requestsBefore = countType(w.latest(), MSG.RESYNC_REQUEST);

  w.migrate(1);
  check("still a guest", w.party.role === PARTY_ROLE.GUEST);
  check("the new host is remembered", w.party.room.hostSlot === 1);
  check("nothing is expected from the old host any more", guest?.horizon === -1);
  check(
    "the whole world is requested",
    countType(w.latest(), MSG.RESYNC_REQUEST) === requestsBefore + 1,
  );
  const out = new Int32Array(MAX_NOTICES * 2);
  const n = w.party.takeNotices(out);
  let sawChange = false;
  for (let i = 0; i < n; i++) if (out[i * 2] === NOTICE.HOST_CHANGED) sawChange = true;
  check("and the player is told the host changed", sawChange);
  check("no promotion was counted", w.party.stats.promotions === 0);
}

section("4. A repeated announcement is not a second migration");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(0, 0, LIVE2);
  const host = w.party.host;
  w.migrate(0);
  check("we were already hosting, so nothing changed", w.party.host === host);
  check("the repeat was counted as redundant", w.party.stats.redundantMigrations === 1);
  check("and not as a promotion", w.party.stats.promotions === 0);
  w.migrate(0);
  check("twice more is still just counted", w.party.stats.redundantMigrations === 2);
  check("the world is still running", w.party.state === PARTY_STATE.PLAYING);
}

section("5. A host the relay has demoted stops hosting");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(0, 0, LIVE2);
  check("hosting to start with", w.party.role === PARTY_ROLE.HOST);
  for (let i = 0; i < 10; i++) w.party.step();

  // This is what a host looks like when it comes back from a drop: it still thinks it is in charge,
  // and the relay has already given the room to somebody else.
  w.migrate(1);
  check("the relay wins", w.party.role === PARTY_ROLE.GUEST);
  check("the host session is gone", w.party.host === null);
  check("a guest session took over", w.party.guest !== null);
  check("and it asks for the world it can no longer vouch for", w.party.guest?.horizon === -1);
  check(
    "the demoted host requested a snapshot",
    countType(w.latest(), MSG.RESYNC_REQUEST) === 1,
    `saw ${countType(w.latest(), MSG.RESYNC_REQUEST)}`,
  );

  const confirmsBefore = countType(w.latest(), MSG.TICK_CONFIRM);
  for (let i = 0; i < 10; i++) w.party.step();
  check(
    "and confirms nothing any more",
    countType(w.latest(), MSG.TICK_CONFIRM) === confirmsBefore,
  );
}

section("6. Losing our own connection freezes the world");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(0, 0, LIVE2);
  for (let i = 0; i < 6; i++) w.party.step();
  const tickAtDrop = w.party.host?.tick ?? -1;
  check("we were simulating", tickAtDrop >= 0);

  w.loseSocket();
  check("the party knows it is interrupted", w.party.state === PARTY_STATE.INTERRUPTED);
  check("and reports itself disconnected", !w.party.isConnected);
  let advanced = 0;
  for (let i = 0; i < 30; i++) advanced += w.party.step();
  check("no tick is simulated while cut off", advanced === 0, `advanced ${advanced}`);
  check("the world stands exactly where it was", (w.party.host?.tick ?? -1) === tickAtDrop);

  // Our own countdown is the same forty-five seconds the relay is holding the seat for.
  check("the countdown starts full", w.party.ownGraceRemainingMs === SEAT_GRACE_MS);
  w.ms += 20_000;
  check("and is derived from the clock", w.party.ownGraceRemainingMs === SEAT_GRACE_MS - 20_000);
  w.ms += 60_000;
  check("never going below zero", w.party.ownGraceRemainingMs === 0);

  w.ms -= 60_000;
  w.party.step();
  w.seat(0, 0, LIVE2);
  check("back in our seat", w.party.state === PARTY_STATE.PLAYING);
  check("the reconnect was counted", w.party.stats.ownReconnects === 1);
  check("our countdown is over", w.party.ownGraceRemainingMs === -1);
  let after = 0;
  for (let i = 0; i < 5; i++) after += w.party.step();
  check("and the world moves again", after === 5, `advanced ${after}`);
}

section("7. Dropped, quit and expired are three different things to a player");
{
  const w = new World(4);
  w.party.join(createAdmission());
  w.seat(0, 0, ["live", "live", "live", "empty"]);
  const out = new Int32Array(MAX_NOTICES * 2);
  w.party.takeNotices(out);

  w.peerLeft(1, true, ["live", "held", "live", "empty"]);
  check("a lost connection holds the seat", w.party.seats[1] === SEAT.HELD);
  check("the countdown is running on it", w.party.graceRemainingMs(1) === SEAT_GRACE_MS);
  check("live seats drop to two", w.party.liveSeats === 2, `saw ${w.party.liveSeats}`);
  let n = w.party.takeNotices(out);
  check("and the player is told they dropped", n === 1 && out[0] === NOTICE.PEER_DROPPED);
  check("named by seat", out[1] === 1);

  w.ms += 30_000;
  check("their countdown counts down", w.party.graceRemainingMs(1) === SEAT_GRACE_MS - 30_000);
  w.peerLeft(1, false, ["live", "empty", "live", "empty"]);
  check("a held seat running out empties it", w.party.seats[1] === SEAT.EMPTY);
  check("with no countdown left", w.party.graceRemainingMs(1) === -1);
  n = w.party.takeNotices(out);
  check("and reads as an expired seat", n === 1 && out[0] === NOTICE.PEER_SEAT_EXPIRED);

  w.peerLeft(2, false, ["live", "empty", "empty", "empty"]);
  n = w.party.takeNotices(out);
  check("leaving straight from live reads as quitting", n === 1 && out[0] === NOTICE.PEER_QUIT);

  w.peerJoined(1, ["live", "live", "empty", "empty"]);
  check("somebody arriving is live again", w.party.seats[1] === SEAT.LIVE);
  n = w.party.takeNotices(out);
  check("and announced", n === 1 && out[0] === NOTICE.PEER_HERE);
  check("a seat nobody has is not counted down", w.party.graceRemainingMs(3) === -1);
  check("an impossible seat is refused politely", w.party.graceRemainingMs(99) === -1);
}

section("8. The notice queue overflows without breaking");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(0, 0, LIVE2_OF_4);
  const out = new Int32Array(MAX_NOTICES * 2);
  w.party.takeNotices(out);

  // Far more than fit, alternating so the ones that survive can be told apart.
  for (let i = 0; i < MAX_NOTICES + 12; i++) {
    if (i % 2 === 0) w.peerLeft(1, false, LIVE2_OF_4);
    else w.peerJoined(1, LIVE2_OF_4);
  }
  check("the queue is capped", w.party.pendingNotices <= MAX_NOTICES, `${w.party.pendingNotices}`);
  const n = w.party.takeNotices(out);
  check("draining hands over a full queue", n === MAX_NOTICES, `gave ${n}`);
  check("the newest event survived", out[(n - 1) * 2] === NOTICE.PEER_HERE);
  check("the queue is empty after draining", w.party.pendingNotices === 0);
  check("draining again gives nothing", w.party.takeNotices(out) === 0);

  // A short array is a partial drain, not a crash: the HUD may only have room for a few lines.
  w.peerJoined(1, LIVE2_OF_4);
  w.peerJoined(1, LIVE2_OF_4);
  const small = new Int32Array(2);
  check("a small array takes one pair", w.party.takeNotices(small) === 1);
  check("and the rest waits for the next frame", w.party.pendingNotices === 1);
  check("arriving in order", w.party.takeNotices(small) === 1 && small[0] === NOTICE.PEER_HERE);

  // Nothing in a frame may allocate. Two hundred drains should move the heap by nothing at all.
  const usage = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process
    ?.memoryUsage;
  if (usage !== undefined) {
    for (let i = 0; i < 50; i++) w.peerJoined(1, LIVE2_OF_4);
    const heapBefore = usage().heapUsed;
    for (let i = 0; i < 200; i++) w.party.takeNotices(out);
    const grew = usage().heapUsed - heapBefore;
    check("draining notices allocates nothing", grew < 64 * 1024, `heap moved ${grew} bytes`);
  }
}

section("9. Quitting ends it on purpose");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(0, 0, LIVE2);
  w.party.quit();
  check("the party is over", w.party.state === PARTY_STATE.ENDED);
  check("the reason is recorded", w.party.endedBecause === "quit");
  check("the socket was closed deliberately", w.latest().closedWith === CLOSE_INTENTIONAL);
  let advanced = 0;
  for (let i = 0; i < 10; i++) advanced += w.party.step();
  check("and nothing simulates afterwards", advanced === 0);
  const out = new Int32Array(MAX_NOTICES * 2);
  const n = w.party.takeNotices(out);
  let over = false;
  for (let i = 0; i < n; i++) if (out[i * 2] === NOTICE.PARTY_OVER) over = true;
  check("with a party-over notice", over);
}

section("10. Being refused is not something to retry");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.latest().handlers.onOpen();
  w.latest().handlers.onText(JSON.stringify({ t: "refused", reason: "room_full" }));
  check("the party ends", w.party.state === PARTY_STATE.ENDED);
  check("and says why, in the relay's words", w.party.endedBecause === "room_full");
  check("no second socket was opened", w.sockets.length === 1);
}

section("11. A host stops writing to a seat nobody is sitting in");
{
  const run = new Run();
  run.begin({ seed: 77, playerCount: 2, record: false });
  const sent: number[] = [];
  const link: Link = { send: (bytes: Uint8Array) => sent.push(bytes.byteLength) };
  const host = new HostSession(run, 2, false, 0);
  host.admit(1, link);
  check("admitting a guest welcomes it", sent.length === 1);

  for (let i = 0; i < 12; i++) host.step();
  const withSeat = sent.length;
  check("a seated guest is written to", withSeat > 1, `${withSeat} messages`);

  host.setConnected(1, false);
  for (let i = 0; i < 12; i++) host.step();
  check("a dead seat is written nothing", sent.length === withSeat, `${sent.length} messages`);

  host.setConnected(1, true);
  for (let i = 0; i < 12; i++) host.step();
  check("and traffic resumes when they come back", sent.length > withSeat);

  // A host is not one of its own guests, and neither is a seat that does not exist. Either of these
  // landing in the guest table would silence the whole room.
  const beforeGuards = sent.length;
  host.setConnected(0, false);
  host.setConnected(9, false);
  host.setConnected(-1, false);
  for (let i = 0; i < 12; i++) host.step();
  check("the host cannot disconnect itself or a seat that is not there", sent.length > beforeGuards);
}

section("12. The seed hook fires once, for the app to build the world from");
{
  let calls = 0;
  let seenSeed = -1;
  const w = new World(2, (seed) => {
    calls++;
    seenSeed = seed;
  });
  w.party.join(createAdmission());
  w.seat(1, 0, LIVE2);
  w.party.noteWelcomed(1234, 0, 0, 2);
  check("the app is handed the host's seed", calls === 1 && seenSeed === 1234);
  w.party.noteWelcomed(9999, 0, 0, 2);
  check("and never a second time", calls === 1 && seenSeed === 1234);
}

section("13. Rubbish on the wire is ignored, not obeyed");
{
  const w = new World(2);
  w.party.join(createAdmission());
  w.seat(1, 0, LIVE2);
  const short = new Uint8Array(HEADER_BYTES - 1);
  short[HDR_TYPE] = MSG.HOST_MIGRATE;
  w.latest().handlers.onBinary(short);
  check("a truncated migration changes nothing", w.party.role === PARTY_ROLE.GUEST);

  const impossible = new Uint8Array(HEADER_BYTES + 1);
  impossible[HDR_TYPE] = MSG.HOST_MIGRATE;
  impossible[HEADER_BYTES] = 200;
  w.latest().handlers.onBinary(impossible);
  check("a nonsense host slot is refused", w.party.room.hostSlot === 0);
  check("and we are still a guest", w.party.role === PARTY_ROLE.GUEST);
  check("the world is still running", w.party.state === PARTY_STATE.PLAYING);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
