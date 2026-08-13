/**
 * The client transport. Run headless: `bun packages/mobile/game/net/transport.test.ts`
 *
 * This is the file that decides whether co-op survives a lift, a tunnel, a hotel wifi captive portal,
 * or a phone that got backgrounded for a phone call. None of that can be tested by connecting to a real
 * relay, because the interesting failures are all about *timing* — how long we wait, when we give up,
 * whether a seat is still ours — so the socket and the clock are both fakes we drive by hand.
 *
 * WHAT IT PROVES
 *   1. Room codes are forgiving to type and confusable characters are repaired, not rejected.
 *   2. The connect URL says exactly what each of the four join modes needs and nothing more.
 *   3. A malformed or hostile text frame is ignored rather than thrown, at every field.
 *   4. Being open is not being seated; nothing is reported ready until the relay says so.
 *   5. A lost connection reconnects as a rejoin of the same seat, with the token we were issued.
 *   6. A deliberate quit never reconnects.
 *   7. A refusal never reconnects, whether it came as a word or as a silent hang-up.
 *   8. Retrying stops once the seat grace window has passed, instead of hammering forever.
 *   9. Backoff grows, is capped, and is jittered so four phones do not retry in lockstep.
 *  10. Game bytes sent while disconnected are dropped and counted, never queued.
 *  11. The seat token never appears in anything the lobby can see.
 */

import { HDR_PLAYER, HEADER_BYTES, MAX_PLAYERS, MSG } from "./protocol";
import {
  CLOSE_INTENTIONAL,
  CONTROL,
  JOIN_MODE,
  LINK_STATE,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SEAT_GRACE_MS,
  SEAT_VIEW,
  Transport,
  backoffMs,
  connectUrl,
  createAdmission,
  isCompleteCode,
  normalizeCode,
  parseControl,
  type ControlFrame,
  type RawSocket,
  type RoomView,
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
/* A socket we drive by hand, and a clock we own                                                   */
/* ---------------------------------------------------------------------------------------------- */

interface FakeSocket extends RawSocket {
  url: string;
  handlers: SocketHandlers;
  closedWith: number;
  binary: Uint8Array[];
  text: string[];
}

class World {
  ms = 1_000;
  /** Deterministic, so a jitter range can be asserted without a flaky test. */
  randomValue = 0.5;
  sockets: FakeSocket[] = [];
  ready: { slot: number; room: RoomView; resumed: boolean }[] = [];
  control: ControlFrame[] = [];
  game: { senderSlot: number; length: number }[] = [];
  drops = 0;
  dead: string[] = [];

  now = (): number => this.ms;
  random = (): number => this.randomValue;

  open = (url: string, handlers: SocketHandlers): RawSocket => {
    const sock: FakeSocket = {
      url,
      handlers,
      closedWith: -1,
      binary: [],
      text: [],
      send: (data: Uint8Array | string) => {
        if (typeof data === "string") sock.text.push(data);
        else sock.binary.push(data);
      },
      close: (code = 1000) => {
        sock.closedWith = code;
      },
    };
    this.sockets.push(sock);
    return sock;
  };

  transport(): Transport {
    return new Transport({
      baseUrl: "ws://relay.test:4400",
      open: this.open,
      now: this.now,
      random: this.random,
      events: {
        onReady: (slot, room, resumed) => this.ready.push({ slot, room, resumed }),
        onControl: (frame) => this.control.push(frame),
        onGame: (bytes, senderSlot) => this.game.push({ senderSlot, length: bytes.length }),
        onDropped: () => {
          this.drops++;
        },
        onDead: (reason) => this.dead.push(reason),
      },
    });
  }

  latest(): FakeSocket {
    return this.sockets[this.sockets.length - 1] as FakeSocket;
  }

  /** What the relay sends a freshly seated player. */
  seat(slot: number, token: number, code = "ABC234"): void {
    this.latest().handlers.onOpen();
    this.latest().handlers.onText(
      JSON.stringify({
        t: "seated",
        slot,
        token,
        room: {
          code,
          hostSlot: 0,
          targetSize: 4,
          public: false,
          seats: ["live", "empty", "empty", "empty"],
        },
      }),
    );
  }
}

function gameBytes(type: number, senderSlot: number, length = HEADER_BYTES + 8): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = type;
  bytes[HDR_PLAYER] = senderSlot;
  return bytes;
}

/* ---------------------------------------------------------------------------------------------- */

section("1. Typing a room code off a friend's screen");
{
  check("lowercase is accepted", normalizeCode("abc234") === "ABC234");
  check("spaces and dashes are stripped", normalizeCode("AB C-2 34") === "ABC234");
  check("O is repaired to Q", normalizeCode("OBC234").charAt(0) === "Q");
  check("zero is repaired too", normalizeCode("0BC234").charAt(0) === "Q");
  check("I and 1 and L all become J", normalizeCode("I1L234") === "JJJ234");
  // S and 5 are both missing from the alphabet, so there is no honest repair — they are dropped, and
  // the code then fails the length check rather than silently becoming a different real code.
  check("S is dropped rather than guessed at", normalizeCode("SABC234") === "ABC234");
  check("a code that was only wrong by an S is refused, not rewritten", !isCompleteCode(normalizeCode("SBC23")));
  check("it never runs past six characters", normalizeCode("ABC234XYZ").length === 6);
  check("a complete code is recognised", isCompleteCode("ABC234"));
  check("a short one is not", !isCompleteCode("ABC23"));
  check("an illegal character is not", !isCompleteCode("ABC23O"));
  check("nothing survives from an empty string", normalizeCode("") === "");
  check("punctuation alone yields nothing", normalizeCode("!!!") === "");
}

section("2. The connect URL is the whole admission request");
{
  const a = createAdmission();
  a.mode = JOIN_MODE.CREATE;
  a.size = 3;
  a.isPublic = true;
  const create = connectUrl("ws://relay.test:4400", a);
  check("create asks for a size and a visibility", create.includes("size=3") && create.includes("vis=public"));
  check("create carries no code", !create.includes("code="));
  check("create carries no token", !create.includes("token="));

  a.isPublic = false;
  check("a private room says so", connectUrl("ws://x", a).includes("vis=private"));

  const j = createAdmission();
  j.mode = JOIN_MODE.JOIN;
  j.code = "ABC234";
  const join = connectUrl("ws://relay.test:4400/", j);
  check("a trailing slash on the base is not doubled", join.startsWith("ws://relay.test:4400/ws?"));
  check("join carries the code", join.includes("code=ABC234"));
  check("join does not ask for a size", !join.includes("size="));

  const r = createAdmission();
  r.mode = JOIN_MODE.REJOIN;
  r.code = "ABC234";
  r.token = 0xdeadbeef;
  const rejoin = connectUrl("ws://x", r);
  check("rejoin carries code and token", rejoin.includes("code=ABC234") && rejoin.includes("token=3735928559"));

  const q = createAdmission();
  q.mode = JOIN_MODE.QUICK;
  q.size = MAX_PLAYERS;
  check("quick play asks only for a party size", connectUrl("ws://x", q) === "ws://x/ws?mode=quick&size=4");
}

section("3. A hostile text frame cannot take the game down");
{
  check("empty string is ignored", parseControl("").kind === CONTROL.NONE);
  check("not JSON is ignored", parseControl("<html>captive portal</html>").kind === CONTROL.NONE);
  check("JSON that is not an object is ignored", parseControl("[1,2,3]").kind === CONTROL.NONE);
  check("null is ignored", parseControl("null").kind === CONTROL.NONE);
  check("an unknown type is ignored", parseControl('{"t":"something_new"}').kind === CONTROL.NONE);

  const partial = parseControl('{"t":"seated"}');
  check("a seated frame with no fields still parses", partial.kind === CONTROL.SEATED);
  check("and reports no seat rather than seat zero", partial.slot === -1);
  check("and no token", partial.token === 0);

  const junk = parseControl('{"t":"peer_left","slot":"two","held":"yes","room":42}');
  check("a string where a number belongs is ignored", junk.slot === -1);
  check("a string where a boolean belongs is not truthy", junk.held === false);
  check("a number where the room belongs yields an empty room", junk.room.seats.length === 0);

  const seats = parseControl(
    '{"t":"peer_joined","slot":1,"room":{"code":"ABC234","hostSlot":0,"targetSize":4,"public":true,"seats":["live","held","empty","banana","live","live"]}}',
  );
  check("a seat state we do not know reads as empty", seats.room.seats[3] === SEAT_VIEW.EMPTY);
  check("known seat states survive", seats.room.seats[1] === SEAT_VIEW.HELD);
  check("the seat list is capped at the party ceiling", seats.room.seats.length === MAX_PLAYERS);
  check("a public room is reported public", seats.room.isPublic);
}

section("4. Open is not seated");
{
  const w = new World();
  const t = w.transport();
  const a = createAdmission();
  a.mode = JOIN_MODE.CREATE;
  t.connect(a);
  check("a socket was opened", w.sockets.length === 1);
  check("the state is connecting", t.state === LINK_STATE.CONNECTING);

  w.latest().handlers.onOpen();
  check("an open socket alone is not ready", t.state === LINK_STATE.CONNECTING);
  check("nothing was reported to the game yet", w.ready.length === 0);
  check("we have no seat", t.slot === -1);

  t.send(gameBytes(MSG.INPUT_BATCH, 0));
  check("sending before we are seated is refused", t.stats.sent === 0);
  check("and counted", t.stats.droppedSends === 1);

  w.latest().handlers.onText(
    JSON.stringify({
      t: "seated",
      slot: 2,
      token: 777,
      room: { code: "ABC234", hostSlot: 0, targetSize: 4, public: false, seats: ["live", "empty", "live", "empty"] },
    }),
  );
  check("the seated frame makes us ready", t.state === LINK_STATE.READY);
  check("and reports our seat", t.slot === 2);
  check("and it is not a resume", w.ready[0]?.resumed === false);
  check("and the lobby can see the room", t.room.code === "ABC234");

  t.send(gameBytes(MSG.INPUT_BATCH, 2));
  check("now a send goes out", t.stats.sent === 1);
  check("and reached the socket", w.latest().binary.length === 1);
}

section("5. Traffic and control after we are in");
{
  const w = new World();
  const t = w.transport();
  t.connect(createAdmission());
  w.seat(0, 555);

  w.latest().handlers.onBinary(gameBytes(MSG.TICK_CONFIRM, 3));
  check("a game message is handed up", w.game.length === 1);
  check("with the seat the relay stamped on it", w.game[0]?.senderSlot === 3);
  check("and counted", t.stats.received === 1);

  w.latest().handlers.onBinary(new Uint8Array(2));
  check("a frame too short to have a header is dropped", w.game.length === 1);
  check("and counted as bad", t.stats.badGame === 1);

  w.latest().handlers.onText('{"t":"peer_joined","slot":1,"room":{"code":"ABC234","seats":["live","live","empty","empty"]}}');
  check("a peer joining reaches the lobby", w.control.length === 1);
  check("and updates the room the lobby draws", t.room.seats[1] === SEAT_VIEW.LIVE);

  w.latest().handlers.onText("not json at all");
  check("garbage on the control channel is survived", t.stats.badControl === 1);
  check("and does not disturb the connection", t.state === LINK_STATE.READY);
}

section("6. A tunnel is not a quit");
{
  const w = new World();
  const t = w.transport();
  const a = createAdmission();
  a.mode = JOIN_MODE.JOIN;
  a.code = "ABC234";
  t.connect(a);
  w.seat(1, 0xabcdef, "ABC234");
  check("we joined by code", w.sockets[0]?.url.includes("mode=join") === true);

  w.latest().handlers.onClose(1006);
  check("an abnormal close leaves us waiting, not dead", t.state === LINK_STATE.WAITING);
  check("the game was told we dropped", w.drops === 1);
  check("a retry is scheduled", t.retryDueMs > w.ms);
  check("no new socket was opened yet", w.sockets.length === 1);

  t.send(gameBytes(MSG.INPUT_BATCH, 1));
  check("game bytes are dropped while disconnected", t.stats.droppedSends === 1);

  t.pump();
  check("pumping before the retry is due does nothing", w.sockets.length === 1);

  w.ms = t.retryDueMs;
  t.pump();
  check("once due, it reconnects", w.sockets.length === 2);
  const url = w.latest().url;
  check("as a rejoin, not the original join", url.includes("mode=rejoin"));
  check("naming the room we were in", url.includes("code=ABC234"));
  check("with the seat token we were issued", url.includes("token=11259375"));

  w.seat(1, 0xabcdef, "ABC234");
  check("we are ready again", t.state === LINK_STATE.READY);
  check("and it is reported as a resume", w.ready[1]?.resumed === true);
  check("and counted as a reconnect", t.stats.reconnects === 1);
  check("the retry counter is reset for next time", t.attempt === 0);
}

section("7. Quitting and being refused both stop for good");
{
  const w = new World();
  const t = w.transport();
  t.connect(createAdmission());
  w.seat(0, 42);
  t.quit();
  check("quitting closes the socket with our own code", w.latest().closedWith === CLOSE_INTENTIONAL);
  check("and the transport is finished", t.state === LINK_STATE.DEAD);
  w.latest().handlers.onClose(CLOSE_INTENTIONAL);
  t.pump();
  check("a quit never reconnects", w.sockets.length === 1);
  check("and nothing is scheduled", t.retryDueMs === -1);

  const w2 = new World();
  const t2 = w2.transport();
  t2.connect(createAdmission());
  w2.latest().handlers.onText('{"t":"refused","reason":"room_full"}');
  check("a spoken refusal ends it", t2.state === LINK_STATE.DEAD);
  check("with the relay's own word for it", w2.dead[0] === "room_full");
  t2.pump();
  check("a refusal never retries", w2.sockets.length === 1);

  const w3 = new World();
  const t3 = w3.transport();
  t3.connect(createAdmission());
  w3.latest().handlers.onClose(1006);
  check("a hang-up before we ever sat down is not retried either", t3.state === LINK_STATE.DEAD);
  check("and is reported as a refusal", w3.dead[0] === "refused");
  check("no second attempt was made", w3.sockets.length === 1);
}

section("8. Retrying stops when the seat is gone");
{
  const w = new World();
  const t = w.transport();
  t.connect(createAdmission());
  w.seat(2, 99);
  const droppedAt = w.ms;
  w.latest().handlers.onClose(1006);

  let opens = w.sockets.length;
  for (let i = 0; i < 40; i++) {
    w.ms += 1_500;
    t.pump();
    if (t.state === LINK_STATE.CONNECTING) {
      // Each reconnect attempt fails immediately, the way a tunnel behaves.
      w.latest().handlers.onClose(1006);
      opens = w.sockets.length;
    }
    if (t.state === LINK_STATE.DEAD) break;
  }
  check("it eventually gives up", t.state === LINK_STATE.DEAD);
  check("and says the seat expired", w.dead[0] === "seat_expired");
  check("it gave up after the grace window, not before", w.ms - droppedAt > SEAT_GRACE_MS);
  check("it did retry repeatedly in the meantime", opens > 3);
  check("and every attempt was a rejoin", w.sockets.slice(1).every((s) => s.url.includes("mode=rejoin")));
  check("nothing is left scheduled", t.retryDueMs === -1);
}

section("9. Backoff grows, is capped, and is jittered");
{
  const fixed = (): number => 0.5;
  const first = backoffMs(0, fixed);
  const second = backoffMs(1, fixed);
  const third = backoffMs(2, fixed);
  check("the first retry is quick", first <= RECONNECT_BASE_MS * 1.5);
  check("the second waits longer", second > first);
  check("the third longer still", third > second);
  check("it is capped", backoffMs(20, fixed) <= RECONNECT_MAX_MS);
  check("a negative attempt is treated as the first", backoffMs(-3, fixed) === first);

  const low = backoffMs(3, () => 0);
  const high = backoffMs(3, () => 1);
  check("jitter spreads the retry", high > low);
  check("jitter is bounded below", low >= RECONNECT_BASE_MS * 8 * 0.7);
  check("jitter is bounded above", high <= RECONNECT_BASE_MS * 8 * 1.3);

  // Four phones dropping on the same router hiccup must not line up on the same millisecond.
  const seeds = [0.1, 0.35, 0.6, 0.9];
  const waits = new Set(seeds.map((s) => backoffMs(2, () => s)));
  check("four players get four different waits", waits.size === 4);
}

section("10. The token is not the lobby's business");
{
  const w = new World();
  const t = w.transport();
  t.connect(createAdmission());
  w.seat(0, 0x12345678);
  const asJson = JSON.stringify(t.room);
  check("the room view carries no token", !asJson.includes("305419896"));
  check("and no token field at all", !asJson.includes("token"));
  // The link is the only thing a session gets, and it can do exactly one thing.
  const link = t.link();
  check("a link has one method", Object.keys(link).length === 1);
  link.send(gameBytes(MSG.INPUT_BATCH, 0));
  check("and it carries bytes", t.stats.sent === 1);
  check("through to the socket", w.latest().binary.length === 1);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
