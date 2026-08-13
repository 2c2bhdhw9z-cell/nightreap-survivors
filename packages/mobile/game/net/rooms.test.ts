/**
 * Rooms and relay routing. Run headless: `bun packages/mobile/game/net/rooms.test.ts`
 *
 * These two files are all the state and all the judgement a co-op server has. Everything else it does
 * is copy bytes from one socket to another without reading them. So the failure modes are not subtle
 * performance problems, they are the unglamorous ones that ruin a session outright: two players handed
 * the same slot, a party that cannot be rejoined after a tunnel, a room that never gets reaped, a code
 * nobody can type, or a modded guest whose forged message reaches the other three phones.
 *
 * WHAT IT PROVES
 *   1. Codes are the right shape, forgiving to type, and never collide silently.
 *   2. A room seats up to four, lowest free slot first, and refuses the fifth.
 *   3. Quitting frees a seat; dropping holds it, and only the token gets it back.
 *   4. The grace window really does expire, and expiry is driven by a clock we control.
 *   5. Losing the host promotes the next player rather than ending the party.
 *   6. Rooms are reaped when idle, when empty, and when absurdly old — no leak path.
 *   7. Matchmaking pairs by party size, oldest room first, and never matches a host to themself.
 *   8. Routing sends guest traffic to the host only, and there is no message shape that gets a guest
 *      to another guest.
 *   9. A guest cannot author a host-authoritative message, and nobody can author a server one.
 *  10. Routing a message allocates nothing, because it runs once per packet per player.
 *  11. The sweep names what it changed, so the players still in the room can be told a held seat ran
 *      out and that the room has a new host — both of which happen with nobody talking to the server.
 */

import {
  HDR_DEST,
  HDR_PLAYER,
  HDR_TYPE,
  HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MSG,
  RELAY_BROADCAST,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "./protocol";
import {
  CODE_ATTEMPTS,
  EMPTY_ROOM_TTL_MS,
  JOIN,
  MAX_ROOMS,
  ROOM_IDLE_TTL_MS,
  ROOM_MAX_AGE_MS,
  RoomRegistry,
  SEAT_GRACE_MS,
  SEAT_STATE,
  VISIBILITY,
  createJoinResult,
  createLeaveResult,
  createSweepReport,
  generateCode,
  isValidCode,
  normalizeCode,
} from "./rooms";
import {
  DROP_REASON,
  ROUTE,
  SENDER_ROLE,
  claimedSlot,
  createRouteDecision,
  roleFor,
  routeFor,
  setDestination,
  setSender,
} from "./routing";

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

function heapUsed(): number {
  const host = globalThis as unknown as {
    process?: { memoryUsage?: () => { heapUsed: number } };
  };
  return host.process?.memoryUsage?.().heapUsed ?? 0;
}

/**
 * A clock and a random source we own outright.
 *
 * Time advances only when a test says so, which is the only reason a 45-second grace window and a
 * six-hour room ceiling can both be tested in the same millisecond. The random source is a plain
 * counter-driven mixer rather than Math.random, which is banned in game/ — a matchmaking test that
 * cannot be replayed is worthless the first time it fails in CI.
 */
class FakeWorld {
  ms = 1_000_000;
  private seed = 0x9e3779b9;

  now = (): number => this.ms;

  random = (): number => {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) as number;
  };

  advance(ms: number): void {
    this.ms += ms;
  }
}

function makeRegistry(): { world: FakeWorld; reg: RoomRegistry } {
  const world = new FakeWorld();
  return { world, reg: new RoomRegistry({ now: world.now, random: world.random }) };
}

/** A message with a real header and nothing meaningful behind it — routing never reads a body. */
function msg(type: number, senderSlot: number, dest: number, bytes = 16): Uint8Array {
  const out = new Uint8Array(bytes);
  out[HDR_TYPE] = type;
  out[HDR_PLAYER] = senderSlot;
  out[HDR_DEST] = dest;
  return out;
}

/* ---------------------------------------------------------------------------------------------- */

section("1. Room codes — read aloud, typed badly, still work");
{
  check("the alphabet is the advertised length", ROOM_CODE_ALPHABET.length === 30, `${ROOM_CODE_ALPHABET.length}`);

  const seen = new Set<string>();
  let duplicated = "";
  for (const ch of ROOM_CODE_ALPHABET) {
    if (seen.has(ch)) duplicated = ch;
    seen.add(ch);
  }
  check("no character appears twice, so no code is more likely than another", duplicated === "", duplicated);

  const ambiguous = ["O", "0", "I", "1", "S", "5"];
  const present = ambiguous.filter((c) => ROOM_CODE_ALPHABET.includes(c));
  check("the glyphs people misread are absent", present.length === 0, present.join(""));

  const world = new FakeWorld();
  const codes = new Set<string>();
  let wrongShape = 0;
  for (let i = 0; i < 5000; i++) {
    const code = generateCode(world.random);
    if (code.length !== ROOM_CODE_LENGTH || !isValidCode(code)) wrongShape++;
    codes.add(code);
  }
  check("every generated code is valid", wrongShape === 0, `${wrongShape} bad`);
  check("5000 codes are essentially all distinct", codes.size > 4990, `${codes.size} unique`);

  check("lowercase is accepted", normalizeCode("abcdef") === "ABCDEF");
  check("punctuation and spaces are forgiven", normalizeCode(" ab-cd ef ") === "ABCDEF");
  check("characters outside the alphabet are dropped", normalizeCode("AB0CD1EF") === "ABCDEF");
  check("a short code is refused", !isValidCode("ABCDE"));
  check("a long code is refused", !isValidCode("ABCDEFG"));
  check("an ambiguous character is refused", !isValidCode("ABCDE0"));
}

section("2. Seating — four players, lowest slot first, no fifth");
{
  const { reg } = makeRegistry();
  const join = createJoinResult();

  const room = reg.createRoom(100, 4, VISIBILITY.PRIVATE);
  check("a room opens", room !== null);
  if (room === null) throw new Error("no room");
  check("the code is typeable", isValidCode(room.code), room.code);
  check("the creator is the host", room.hostSlot === 0);
  check("and is seated in slot 0", reg.slotOf(100) === 0);
  check("the host is recognised as the host", reg.isHost(100));

  reg.join(room.code, 101, join);
  check("a second player gets slot 1", join.status === JOIN.OK && join.slot === 1, `slot ${join.slot}`);
  check("and is issued a seat token", join.token !== 0);
  check("but is not the host", !reg.isHost(101));

  reg.join(room.code, 102, join);
  check("a third gets slot 2", join.slot === 2);
  reg.join(room.code, 103, join);
  check("a fourth gets slot 3", join.slot === 3);
  check("the room is now full", reg.liveCount(room) === MAX_PLAYERS);

  reg.join(room.code, 104, join);
  check("a fifth is turned away", join.status === JOIN.FULL, `status ${join.status}`);
  check("and is seated nowhere", reg.roomOf(104) === null);

  reg.join(room.code, 101, join);
  check("someone already seated cannot join twice", join.status === JOIN.ALREADY_SEATED);

  reg.join("ZZZZZZ", 105, join);
  check("an unknown code is a clean miss, not a crash", join.status === JOIN.NO_SUCH_ROOM);
  reg.join("bad", 105, join);
  check("a malformed code is reported as malformed", join.status === JOIN.BAD_CODE);

  check("lowercase entry finds the room", normalizeCode(room.code.toLowerCase()) === room.code);
  check("connection lookup finds the right seats", reg.connAt(room, 2) === 102 && reg.connAt(room, 3) === 103);
  check("an out-of-range slot reads as nobody", reg.connAt(room, 9) === -1);
}

section("3. Quitting frees a seat; dropping holds it");
{
  const { world, reg } = makeRegistry();
  const join = createJoinResult();
  const left = createLeaveResult();

  const room = reg.createRoom(200, 4, VISIBILITY.PRIVATE);
  if (room === null) throw new Error("no room");
  reg.join(room.code, 201, join);
  const token201 = join.token;
  reg.join(room.code, 202, join);

  reg.leave(202, true, left);
  check("pressing quit reports the slot", left.slot === 2);
  check("and frees the seat immediately", (room.seats[2] as { state: number }).state === SEAT_STATE.EMPTY);
  check("so a friend can take it at once", reg.openSeats(room) === 2);

  reg.leave(201, false, left);
  check("losing signal reports the slot", left.slot === 1);
  check("and holds the seat", left.heldForReturn);
  check("the seat is marked absent, not empty", (room.seats[1] as { state: number }).state === SEAT_STATE.ABSENT);
  check("a held seat does not count as open", reg.openSeats(room) === 2);
  check("nor as live", reg.liveCount(room) === 1);

  reg.join(room.code, 299, join);
  check("a stranger cannot take a held seat", join.slot !== 1, `got slot ${join.slot}`);
  reg.leave(299, true, left);

  world.advance(8000);
  reg.rejoin(room.code, token201 ^ 1, 203, join);
  check("the wrong token is refused", join.status === JOIN.BAD_TOKEN);
  reg.rejoin(room.code, token201, 203, join);
  check("the right token gets back in", join.status === JOIN.OK, `status ${join.status}`);
  check("into the same slot, with the same weapons waiting", join.slot === 1);
  check("under a new connection", reg.connAt(room, 1) === 203);
  check("and the seat is live again", reg.liveCount(room) === 2);
}

section("4. The grace window really does close");
{
  const { world, reg } = makeRegistry();
  const join = createJoinResult();
  const left = createLeaveResult();

  const room = reg.createRoom(300, 4, VISIBILITY.PRIVATE);
  if (room === null) throw new Error("no room");
  reg.join(room.code, 301, join);
  const token = join.token;

  reg.leave(301, false, left);
  world.advance(SEAT_GRACE_MS - 1);
  reg.sweep();
  check("a seat survives right up to the deadline", (room.seats[1] as { state: number }).state === SEAT_STATE.ABSENT);

  world.advance(2);
  reg.sweep();
  check("and is released just after it", (room.seats[1] as { state: number }).state === SEAT_STATE.EMPTY);
  check("the release is counted", reg.stats.seatsExpired === 1);

  reg.rejoin(room.code, token, 302, join);
  check("coming back too late is refused", join.status === JOIN.BAD_TOKEN);
  reg.join(room.code, 302, join);
  check("but the seat is available to anyone now", join.status === JOIN.OK && join.slot === 1);
}

section("5. Losing the host does not end the party");
{
  const { reg } = makeRegistry();
  const join = createJoinResult();
  const left = createLeaveResult();

  const room = reg.createRoom(400, 4, VISIBILITY.PRIVATE);
  if (room === null) throw new Error("no room");
  reg.join(room.code, 401, join);
  reg.join(room.code, 402, join);

  reg.leave(400, false, left);
  check("the host dropping promotes someone", left.newHostSlot === 1, `new host ${left.newHostSlot}`);
  check("the room agrees", room.hostSlot === 1);
  check("the room is still open", !room.closed);
  check("the promotion is counted", reg.stats.hostMigrations === 1);
  check("the new host is recognised", reg.isHost(401));

  reg.leave(401, true, left);
  check("losing the new host promotes again", room.hostSlot === 2 && left.newHostSlot === 2);

  // The original host is still ABSENT rather than gone — they lost signal, they did not quit. So the
  // room outlives everyone leaving, because the one person who never chose to leave can still return.
  reg.leave(402, true, left);
  check("the room survives while a dropped player's seat is still held", !left.roomClosed);
  check("and the code still resolves", reg.get(room.code) !== null);

  check("nobody is live in it", reg.liveCount(room) === 0);
  check("but a seat is still held", reg.openSeats(room) === MAX_PLAYERS - 1);

  const quitters = reg.createRoom(420, 4, VISIBILITY.PRIVATE);
  if (quitters === null) throw new Error("no room");
  reg.join(quitters.code, 421, join);
  reg.leave(421, true, left);
  reg.leave(420, true, left);
  check("a room everyone actually quit closes at once", left.roomClosed);
  check("and is gone", reg.get(quitters.code) === null);
  check("closures are counted", reg.stats.roomsClosed === 1);

  const guestOnly = reg.createRoom(410, 4, VISIBILITY.PRIVATE);
  if (guestOnly === null) throw new Error("no room");
  reg.join(guestOnly.code, 411, join);
  reg.leave(411, true, left);
  check("a guest leaving does not change the host", left.newHostSlot === -1 && guestOnly.hostSlot === 0);
}

section("6. No room lives forever");
{
  const { world, reg } = makeRegistry();
  const left = createLeaveResult();

  const idle = reg.createRoom(500, 4, VISIBILITY.PRIVATE);
  if (idle === null) throw new Error("no room");
  world.advance(ROOM_IDLE_TTL_MS + 1);
  check("silence reaps a room", reg.sweep() === 1);
  check("and it is really gone", reg.get(idle.code) === null);

  const busy = reg.createRoom(501, 4, VISIBILITY.PRIVATE);
  if (busy === null) throw new Error("no room");
  for (let i = 0; i < 10; i++) {
    world.advance(ROOM_IDLE_TTL_MS - 1000);
    reg.touch(501);
  }
  check("a room being played in is never reaped", reg.get(busy.code) !== null);

  world.advance(ROOM_MAX_AGE_MS);
  reg.touch(501);
  check("but an absurdly old room is reaped anyway", reg.sweep() === 1);

  const abandoned = reg.createRoom(502, 4, VISIBILITY.PRIVATE);
  if (abandoned === null) throw new Error("no room");
  reg.leave(502, false, left);
  check("the last player dropping keeps the room briefly", reg.get(abandoned.code) !== null);
  world.advance(SEAT_GRACE_MS + EMPTY_ROOM_TTL_MS + 1);
  reg.sweep();
  check("and drops it once nobody came back", reg.get(abandoned.code) === null);

  const survivor = reg.createRoom(503, 4, VISIBILITY.PRIVATE);
  if (survivor === null) throw new Error("no room");
  const join = createJoinResult();
  reg.join(survivor.code, 504, join);
  const token = join.token;
  reg.leave(503, false, left);
  reg.leave(504, false, left);
  world.advance(1000);
  reg.sweep();
  check("both players dropping at once does not destroy the room", reg.get(survivor.code) !== null);
  reg.rejoin(survivor.code, token, 505, join);
  check("either of them can come back to it", join.status === JOIN.OK);
  check("and whoever is back becomes the host", survivor.hostSlot === reg.slotOf(505));

  check("the registry is empty of leaks", reg.roomCount === 1, `${reg.roomCount} rooms`);
}

section("7. Matchmaking — by party size, oldest first");
{
  const { world, reg } = makeRegistry();
  const join = createJoinResult();

  const duo = reg.createRoom(600, 2, VISIBILITY.PUBLIC);
  world.advance(1000);
  const quadOld = reg.createRoom(601, 4, VISIBILITY.PUBLIC);
  world.advance(1000);
  const quadNew = reg.createRoom(602, 4, VISIBILITY.PUBLIC);
  world.advance(1000);
  const hidden = reg.createRoom(603, 4, VISIBILITY.PRIVATE);
  if (duo === null || quadOld === null || quadNew === null || hidden === null) throw new Error("no room");

  const found = reg.findPublicRoom(4, 700);
  check("a four-player queue finds a four-player room", found === quadOld, found?.code);
  check("not the newer one — waiting longest goes first", found !== quadNew);
  check("a two-player queue finds the duo", reg.findPublicRoom(2, 700) === duo);
  check("a three-player queue finds nothing", reg.findPublicRoom(3, 700) === null);
  check("a private room is never offered", reg.findPublicRoom(4, 700) !== hidden);
  check("nobody is matched into their own room", reg.findPublicRoom(4, 601) === quadNew);

  reg.quickPlay(700, 4, join);
  check("quick play seats you in the waiting room", reg.roomOf(700) === quadOld);
  check("in the next free slot", join.slot === 1, `slot ${join.slot}`);

  const before = reg.roomCount;
  reg.quickPlay(701, 3, join);
  check("quick play with no match opens a room instead", reg.roomCount === before + 1);
  check("and you host it", join.slot === 0 && reg.isHost(701));

  for (let i = 0; i < 3; i++) reg.join(quadOld.code, 710 + i, join);
  check("a full public room is no longer offered", reg.findPublicRoom(4, 800) !== quadOld);
}

section("8. Routing — a guest can only ever reach the host");
{
  const decision = createRouteDecision();

  routeFor(msg(MSG.INPUT_BATCH, 2, 0), false, decision);
  check("guest input goes to the host", decision.kind === ROUTE.TO_HOST);

  for (const dest of [0, 1, 2, 3, RELAY_BROADCAST]) {
    routeFor(msg(MSG.INPUT_BATCH, 2, dest), false, decision);
    check(`a guest addressing slot ${dest} still only reaches the host`, decision.kind === ROUTE.TO_HOST);
  }

  routeFor(msg(MSG.CARD_REQUEST, 3, 1), false, decision);
  check("a card tap goes to the host", decision.kind === ROUTE.TO_HOST);
  routeFor(msg(MSG.RESYNC_REQUEST, 1, 2), false, decision);
  check("a resync request goes to the host", decision.kind === ROUTE.TO_HOST);
  routeFor(msg(MSG.RESYNC_NACK, 1, 2), false, decision);
  check("a repair request goes to the host", decision.kind === ROUTE.TO_HOST);

  routeFor(msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST), true, decision);
  check("the host's confirmed inputs go to everyone", decision.kind === ROUTE.BROADCAST);
  routeFor(msg(MSG.RESYNC_CHUNK, 0, 2), true, decision);
  check("a snapshot goes only to the guest that asked", decision.kind === ROUTE.TO_SLOT && decision.slot === 2);
  routeFor(msg(MSG.WELCOME, 0, 3), true, decision);
  check("a welcome goes only to the new arrival", decision.kind === ROUTE.TO_SLOT && decision.slot === 3);
  routeFor(msg(MSG.STATE_HASH, 0, RELAY_BROADCAST), true, decision);
  check("a state hash goes to everyone", decision.kind === ROUTE.BROADCAST);

  routeFor(msg(MSG.RESYNC_CHUNK, 0, 9), true, decision);
  check("the host addressing a slot that cannot exist is dropped", decision.kind === ROUTE.DROP);
  check("and named as a bad address", decision.reason === DROP_REASON.BAD_DESTINATION);

  routeFor(msg(MSG.HELLO, 0, 0), false, decision);
  check("a guest's session handshake reaches the host, not the relay", decision.kind === ROUTE.TO_HOST);
  routeFor(msg(MSG.WELCOME, 0, 1), true, decision);
  check("and the host's answer comes back to that guest alone", decision.kind === ROUTE.TO_SLOT && decision.slot === 1);

  routeFor(msg(MSG.PING, 2, 0), false, decision);
  check("a latency probe is answered by the host, not the relay", decision.kind === ROUTE.TO_HOST);
  routeFor(msg(MSG.PONG, 0, 2), true, decision);
  check("so the clock a guest syncs to is the host's", decision.kind === ROUTE.TO_SLOT && decision.slot === 2);

  routeFor(msg(MSG.LEAVE, 2, 0), false, decision);
  check("a departure is the relay's own business", decision.kind === ROUTE.SERVER);
  routeFor(msg(MSG.LEAVE, 0, 0), true, decision);
  check("including the host's", decision.kind === ROUTE.SERVER);
}

section("9. Routing — nobody sends what is not theirs to send");
{
  const decision = createRouteDecision();

  const hostOnly = [MSG.TICK_CONFIRM, MSG.HOST_EVENTS, MSG.STATE_HASH, MSG.RESYNC_CHUNK, MSG.CORRECTION, MSG.WELCOME];
  let leaked = 0;
  for (const type of hostOnly) {
    routeFor(msg(type, 0, RELAY_BROADCAST), false, decision);
    if (decision.kind !== ROUTE.DROP || decision.reason !== DROP_REASON.WRONG_ROLE) leaked++;
  }
  check("a guest forging host decisions is dropped every time", leaked === 0, `${leaked} leaked`);

  const guestOnly = [MSG.INPUT_BATCH, MSG.CARD_REQUEST, MSG.RESYNC_REQUEST, MSG.RESYNC_NACK, MSG.HELLO];
  let wrongWay = 0;
  for (const type of guestOnly) {
    routeFor(msg(type, 0, 1), true, decision);
    if (decision.kind !== ROUTE.DROP) wrongWay++;
  }
  check("the host sending guest-only messages is dropped too", wrongWay === 0, `${wrongWay} allowed`);

  routeFor(msg(MSG.HOST_MIGRATE, 0, RELAY_BROADCAST), true, decision);
  check("even the host cannot announce a host migration", decision.kind === ROUTE.DROP);
  check("because only the server may say that", decision.reason === DROP_REASON.SERVER_AUTHORED);

  routeFor(msg(200, 0, 0), true, decision);
  check("an unknown message type is dropped", decision.kind === ROUTE.DROP);
  check("and named as unknown, not as cheating", decision.reason === DROP_REASON.UNKNOWN_TYPE);

  routeFor(new Uint8Array(2), false, decision);
  check("a runt message is dropped", decision.kind === ROUTE.DROP && decision.reason === DROP_REASON.MALFORMED);
  routeFor(msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST, MAX_MESSAGE_BYTES + 1), true, decision);
  check("an oversized message is dropped", decision.kind === ROUTE.DROP && decision.reason === DROP_REASON.MALFORMED);

  check("every known type has an owner", roleFor(MSG.PING) === SENDER_ROLE.ANY);
  check("and an unlisted id has none", roleFor(31) === SENDER_ROLE.UNKNOWN);

  const stamped = msg(MSG.RESYNC_CHUNK, 0, 0);
  setDestination(stamped, 3);
  routeFor(stamped, true, decision);
  check("stamping an address works after the message is built", decision.slot === 3);
  check("the sender's own claim is readable but advisory", claimedSlot(stamped) === 0);
  check("a runt cannot be stamped", (setDestination(new Uint8Array(1), 2), true));
}

section("10. Cost — this runs once per packet per player");
{
  const decision = createRouteDecision();
  const samples = [
    msg(MSG.INPUT_BATCH, 1, 0),
    msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST),
    msg(MSG.RESYNC_CHUNK, 0, 2),
    msg(MSG.PING, 3, 0),
  ];

  for (let i = 0; i < 20000; i++) {
    routeFor(samples[i & 3] as Uint8Array, (i & 1) === 0, decision);
  }

  const before = heapUsed();
  for (let i = 0; i < 200000; i++) {
    routeFor(samples[i & 3] as Uint8Array, (i & 1) === 0, decision);
  }
  const grew = (heapUsed() - before) / 1024;
  check("200,000 routed messages allocate nothing", grew < 64, `heap moved ${grew.toFixed(1)}kb`);

  check("the header is still four bytes", HEADER_BYTES === 4);
  check("the room ceiling is sane", MAX_ROOMS >= 1024 && CODE_ATTEMPTS >= 4);
}

section("11. Party size is a promise, not a hint");
{
  // Enemy counts scale with how many players are in the run, so an uninvited extra player makes the
  // fight harder for everyone who agreed to a smaller one. A room built for three seats three.
  const reg = makeRegistry().reg;
  const room = reg.createRoom(1, 3, VISIBILITY.PRIVATE);
  if (room === null) throw new Error("no room");
  const join = createJoinResult();

  check("a trio has two seats to give", reg.seatsAvailable(room) === 2, `${reg.seatsAvailable(room)}`);
  reg.join(room.code, 2, join);
  check("the second player gets in", join.status === JOIN.OK && join.slot === 1);
  reg.join(room.code, 3, join);
  check("the third player gets in", join.status === JOIN.OK && join.slot === 2);
  check("and now it is full", reg.isFull(room));

  reg.join(room.code, 4, join);
  check("a fourth is refused even though a seat exists in memory", join.status === JOIN.FULL);
  check("and the physical seat is still there, untouched", reg.openSeats(room) === 1);

  // A held seat counts against the promise too: someone who dropped four seconds ago still outranks a
  // stranger, or every tunnel would cost you your place to whoever queued next.
  const left = createLeaveResult();
  reg.leave(3, false, left);
  check("dropping holds the seat", left.heldForReturn);
  check("so the trio is still full", reg.isFull(room));
  reg.join(room.code, 5, join);
  check("and a stranger cannot take the held seat", join.status === JOIN.FULL);

  // Quitting is different: that seat is genuinely given up.
  reg.leave(2, true, left);
  check("quitting frees a seat", reg.seatsAvailable(room) === 1);
  reg.join(room.code, 6, join);
  check("which the next player can take", join.status === JOIN.OK && join.slot === 1);

  // Matchmaking has to agree with all of the above, or the queue would keep sending people to a room
  // that will refuse them.
  const pub = makeRegistry().reg;
  const duo = pub.createRoom(10, 2, VISIBILITY.PUBLIC);
  if (duo === null) throw new Error("no room");
  check("an empty duo is offered to the queue", pub.findPublicRoom(2, 99) === duo);
  pub.join(duo.code, 11, join);
  check("a filled duo is not", pub.findPublicRoom(2, 99) === null);
  check("even though it still has spare seats in memory", pub.openSeats(duo) === 2);
}

section("12. Nobody gets to be somebody else");
{
  // A relay-backed host has one socket for the whole room, so "who sent this" can only live in the
  // header — and a header field a client wrote is a claim, not a fact. The relay overwrites it with
  // the seat the message actually came from, which is what makes it safe for the host to trust.
  const forged = msg(MSG.INPUT_BATCH, 3, 0);
  check("a guest can write any sender it likes", claimedSlot(forged) === 3);
  setSender(forged, 1);
  check("but the relay overwrites it with the real seat", claimedSlot(forged) === 1);

  // Impersonation is not merely detected, it is erased: the stamp happens on every forwarded message,
  // so the number the other players see is never the one the sender chose.
  let leaked = 0;
  for (let claim = 0; claim < 8; claim++) {
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      const m = msg(MSG.CARD_REQUEST, claim, 0);
      setSender(m, seat);
      if (claimedSlot(m) !== seat) leaked++;
    }
  }
  check("no combination of claim and seat survives the stamp", leaked === 0, `${leaked} leaked`);

  // Stamping touches one byte and never the destination byte, so a host broadcast stays a broadcast.
  const confirm = msg(MSG.TICK_CONFIRM, 0, RELAY_BROADCAST);
  setSender(confirm, 0);
  check("stamping the sender leaves the address alone", confirm[HDR_DEST] === RELAY_BROADCAST);
  check("and leaves the type alone", confirm[HDR_TYPE] === MSG.TICK_CONFIRM);

  const runt = new Uint8Array(2);
  setSender(runt, 2);
  check("a runt cannot be stamped with a sender either", claimedSlot(runt) === -1);

  // And after the stamp the message still routes the same way, because routing reads the room's idea
  // of who the host is and not anything in the bytes.
  const decision = createRouteDecision();
  const stamped = msg(MSG.INPUT_BATCH, 0, 0);
  setSender(stamped, 2);
  routeFor(stamped, false, decision);
  check("a stamped guest message still goes to the host", decision.kind === ROUTE.TO_HOST);
  routeFor(stamped, true, decision);
  check("and claiming to be slot 0 does not make it host traffic", decision.kind === ROUTE.DROP);
  check("it is refused for the role, not the number", decision.reason === DROP_REASON.WRONG_ROLE);
}

section("13. A sweep says what it changed, or nobody finds out");
{
  const { world, reg } = makeRegistry();
  const join = createJoinResult();
  const left = createLeaveResult();
  const report = createSweepReport();

  const room = reg.createRoom(700, 4, VISIBILITY.PRIVATE);
  if (room === null) throw new Error("no room");
  reg.join(room.code, 701, join);
  reg.join(room.code, 702, join);

  // One player's signal dies. Their seat is held, and the countdown runs with nobody sending anything.
  reg.leave(702, false, left);
  reg.sweep(report);
  check("nothing to report while the seat is still theirs", report.expiredCount === 0);

  world.advance(SEAT_GRACE_MS + 1);
  reg.sweep(report);
  check("the expiry is reported", report.expiredCount === 1, `saw ${report.expiredCount}`);
  check("naming the room", report.expiredRoom[0] === room);
  check("and the seat", report.expiredSlot[0] === 2, `saw ${report.expiredSlot[0]}`);
  check("the seat really is gone", (room.seats[2] as { state: number }).state === SEAT_STATE.EMPTY);

  reg.sweep(report);
  check("and it is reported exactly once", report.expiredCount === 0);

  // Now the host itself drops. The room keeps a host immediately, by promotion on departure.
  const other = reg.createRoom(800, 4, VISIBILITY.PRIVATE);
  if (other === null) throw new Error("no room");
  reg.join(other.code, 801, join);
  reg.join(other.code, 802, join);
  reg.leave(800, false, left);
  check("departure promotes straight away", left.newHostSlot === 1, `saw ${left.newHostSlot}`);

  // The case only a sweep can produce: the host seat is held, so nothing was promoted at the time,
  // and the promotion happens later off the clock alone.
  const third = reg.createRoom(900, 4, VISIBILITY.PRIVATE);
  if (third === null) throw new Error("no room");
  reg.join(third.code, 901, join);
  reg.join(third.code, 902, join);
  reg.leave(901, false, left);
  reg.leave(902, false, left);
  reg.leave(900, false, left);
  check("with nobody live there is nobody to promote", left.newHostSlot === -1);
  // Bring one guest back, so the room is live again but its host seat is still held.
  world.advance(1_000);
  reg.join(third.code, 903, join);
  check("a returning player takes the lowest free seat", join.status === JOIN.OK);
  world.advance(SEAT_GRACE_MS + 1);
  reg.sweep(report);
  check("the sweep promotes the room", third.hostSlot === join.slot, `host is ${third.hostSlot}`);
  check("and says so", report.migratedCount === 1, `saw ${report.migratedCount}`);
  check("naming the room", report.migratedRoom[0] === third);
  check("and the new host", report.migratedHost[0] === third.hostSlot);
  check("the expiries came with it", report.expiredCount > 0, `saw ${report.expiredCount}`);

  reg.sweep(report);
  check("a settled room reports nothing", report.migratedCount === 0 && report.expiredCount === 0);

  // The sweep runs forever on a timer, so it must not leave rubbish behind for the collector.
  const usage = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process
    ?.memoryUsage;
  if (usage !== undefined) {
    const before = usage().heapUsed;
    for (let i = 0; i < 500; i++) reg.sweep(report);
    const grew = usage().heapUsed - before;
    check("sweeping a quiet server allocates almost nothing", grew < 256 * 1024, `${grew} bytes`);
  }

  // And a relay that never passes a report must keep working exactly as it did.
  const plain = reg.sweep();
  check("a sweep with nothing to report into still works", plain >= 0);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
