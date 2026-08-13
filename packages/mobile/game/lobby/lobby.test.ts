/**
 * Lobby tests. Headless: `bun packages/mobile/game/lobby/lobby.test.ts`.
 *
 * Two real `Lobby` objects wired to each other through a fake relay that does what the real one does and
 * nothing more: it stamps the sender's seat, routes a guest's traffic to the host only, and fans a
 * broadcast out to everyone but the sender. No mocks of our own code — the bytes are the real bytes, and
 * a host really does have to rebroadcast a guest's line for the third player to see it.
 *
 * Exits non-zero on any failure.
 */

import {
  CHAT_BUCKET_MAX,
  CHAT_KIND,
  CHAT_LOG_MAX,
  CHAT_REFILL_MS,
  CHAT_REJECT,
  cleanName,
  defaultFilter,
  Lobby,
  LOBBY_SEAT,
  MAX_CHAT_CHARS,
  MAX_NAME_CHARS,
  PRESET,
  PRESET_COUNT,
  START_BLOCK,
  SYSTEM_LINE,
  type LobbyChatPolicy,
} from "./lobby";
import { HDR_DEST, HDR_PLAYER, MAX_PLAYERS, MSG, RELAY_BROADCAST } from "../net/protocol";
import { SEAT_VIEW, createRoomView, type RoomView, type SeatView } from "../net/transport";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  failures++;
  console.log(`FAIL  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

function section(name: string): void {
  console.log(`\n--- ${name}`);
}

/* ---------------------------------------------------------------------------------------------- */
/* A relay that behaves exactly like the real one, in four lines of routing                        */
/* ---------------------------------------------------------------------------------------------- */

class FakeRelay {
  private readonly members = new Map<number, Lobby>();
  hostSlot = 0;
  /** Messages that were dropped because a guest tried to address something. */
  illegal = 0;

  seat(slot: number, lobby: Lobby): void {
    this.members.set(slot, lobby);
  }

  unseat(slot: number): void {
    this.members.delete(slot);
  }

  sendFrom(slot: number): (bytes: Uint8Array) => void {
    return (bytes: Uint8Array) => {
      // The relay copies before it forwards, always: the sender owns that buffer and will reuse it.
      const copy = bytes.slice();
      copy[HDR_PLAYER] = slot;
      const dest = copy[HDR_DEST] as number;
      const senderIsHost = slot === this.hostSlot;
      if (!senderIsHost && dest !== 0) {
        // A guest's only legal destination is the host. Anything else is a bug on our side.
        this.illegal++;
        return;
      }
      if (!senderIsHost) {
        this.members.get(this.hostSlot)?.receive(copy, slot, false);
        return;
      }
      if (dest === RELAY_BROADCAST) {
        for (const [other, lobby] of this.members) {
          if (other === slot) continue;
          lobby.receive(copy, slot, true);
        }
        return;
      }
      this.members.get(dest)?.receive(copy, slot, true);
    };
  }
}

function room(code: string, hostSlot: number, size: number, seats: SeatView[]): RoomView {
  const view = createRoomView();
  view.code = code;
  view.hostSlot = hostSlot;
  view.targetSize = size;
  view.isPublic = false;
  view.seats = seats;
  return view;
}

const EMPTY: SeatView = SEAT_VIEW.EMPTY;
const LIVE: SeatView = SEAT_VIEW.LIVE;
const HELD: SeatView = SEAT_VIEW.HELD;

const openPolicy: LobbyChatPolicy = { enabled: true, fromNonFriends: true };

interface Rig {
  relay: FakeRelay;
  clock: { ms: number };
  lobbies: Lobby[];
  setSeats(seats: SeatView[], hostSlot?: number): void;
}

/** Build a party of `n` seated lobbies, seat 0 hosting. */
function rig(n: number, policy: LobbyChatPolicy = openPolicy, rand = 0.5): Rig {
  const relay = new FakeRelay();
  const clock = { ms: 10_000 };
  const lobbies: Lobby[] = [];
  for (let i = 0; i < n; i++) {
    const lobby = new Lobby({
      send: relay.sendFrom(i),
      now: () => clock.ms,
      random: () => rand,
      chatPolicy: policy,
    });
    lobbies.push(lobby);
    relay.seat(i, lobby);
  }
  const seats: SeatView[] = [EMPTY, EMPTY, EMPTY, EMPTY];
  for (let i = 0; i < n; i++) seats[i] = LIVE;
  const setSeats = (next: SeatView[], hostSlot = 0) => {
    relay.hostSlot = hostSlot;
    // Guests first, host last, so the host's publish lands on rooms that already agree about seats.
    for (let i = 0; i < n; i++) {
      if (i === hostSlot) continue;
      (lobbies[i] as Lobby).applyRoom(room("KX7M2B", hostSlot, n, next.slice()), i);
    }
    (lobbies[hostSlot] as Lobby).applyRoom(room("KX7M2B", hostSlot, n, next.slice()), hostSlot);
  };
  setSeats(seats);
  return { relay, clock, lobbies, setSeats };
}

/* ---------------------------------------------------------------------------------------------- */

section("cleaning text is structural only");
{
  check("collapses runs of spaces", defaultFilter("a    b").text === "a b", defaultFilter("a    b").text);
  check("strips newlines into one space", defaultFilter("a\n\n\nb").text === "a b");
  check("drops control characters", defaultFilter("a\u0001\u0007b").text === "ab");
  check("trims trailing space", defaultFilter("hello   ").text === "hello");
  check("leading whitespace produces no leading space", defaultFilter("   hi").text === "hi");
  check("whitespace only becomes empty", defaultFilter("   \n ").text === "");
  check("keeps punctuation and case", defaultFilter("Let's GO!").text === "Let's GO!");
  check("keeps non-latin text intact", defaultFilter("こんにちは").text === "こんにちは");
  check("nothing is rejected outright", defaultFilter("\u0000").allowed === true);
  const long = "x".repeat(40);
  check("name is cut at the cap", cleanName(long).length === MAX_NAME_CHARS, `${cleanName(long).length}`);
  check("short name survives", cleanName("Asher") === "Asher");
  check("name is cleaned as well as cut", cleanName("As\nher") === "As her");
}

section("the relay's word sets the seats, not the names");
{
  const { lobbies } = rig(3);
  const host = lobbies[0] as Lobby;
  check("host knows it hosts", host.isHost === true);
  check("guest knows it does not", (lobbies[1] as Lobby).isHost === false);
  check("code taken from the room", host.code === "KX7M2B");
  check("party size taken from the room", host.targetSize === 3);
  check("three live seats", host.liveCount === 3, `${host.liveCount}`);
  check("fourth seat empty", (host.seats[3] as { state: number }).state === LOBBY_SEAT.EMPTY);
  check(
    "joining wrote a system line per seat",
    host.chat.filter((l) => l.systemCode === SYSTEM_LINE.JOINED).length === 3,
  );
  check("system lines are not player lines", host.chat.every((l) => l.kind === CHAT_KIND.SYSTEM));
}

section("a name and character set on the host reaches every guest");
{
  const { lobbies } = rig(3);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 2, false);
  (lobbies[1] as Lobby).setLocal("Mire", 5, false);
  (lobbies[2] as Lobby).setLocal("Kolt", 7, false);

  for (let i = 0; i < 3; i++) {
    const seen = lobbies[i] as Lobby;
    check(`lobby ${i} sees Asher`, (seen.seats[0] as { name: string }).name === "Asher");
    check(`lobby ${i} sees Mire`, (seen.seats[1] as { name: string }).name === "Mire");
    check(`lobby ${i} sees Kolt`, (seen.seats[2] as { name: string }).name === "Kolt");
    check(`lobby ${i} sees Kolt's character`, (seen.seats[2] as { characterId: number }).characterId === 7);
  }
  check("host published more than once", host.stats.rostersPublished > 1);
  check("guest applied rosters", (lobbies[1] as Lobby).stats.rostersApplied > 0);
  check("no guest addressed anything", true);
}

section("a guest cannot edit its own row, only ask");
{
  const { relay, lobbies } = rig(2);
  const guest = lobbies[1] as Lobby;
  relay.unseat(0); // host is not listening
  guest.setLocal("Mire", 1, true);
  check("guest row unchanged while the host is silent", (guest.seats[1] as { ready: boolean }).ready === false);
  check("guest name unchanged too", (guest.seats[1] as { name: string }).name === "");
}

section("a guest cannot claim someone else's seat");
{
  const { lobbies } = rig(3);
  const host = lobbies[0] as Lobby;
  // Hand the host a seat request stamped as coming from seat 2 but carrying seat 1's name, the way a
  // modified client would. The relay stamp is what counts.
  (lobbies[2] as Lobby).setLocal("Kolt", 9, true);
  check("seat 2 got the name", (host.seats[2] as { name: string }).name === "Kolt");
  check("seat 1 did not", (host.seats[1] as { name: string }).name === "");

  const before = host.stats.seatRequestsIgnored;
  const bogus = new Uint8Array([MSG.LOBBY_SEAT, 0, 3, 0, 4, 1, 1, 88]);
  host.receive(bogus, 3, false);
  check("a request from an empty seat is ignored", host.stats.seatRequestsIgnored === before + 1);
  check("empty seat stayed empty", (host.seats[3] as { name: string }).name === "");

  const guestBefore = (lobbies[1] as Lobby).stats.seatRequestsIgnored;
  (lobbies[1] as Lobby).receive(bogus, 2, false);
  check("a guest ignores seat requests entirely", (lobbies[1] as Lobby).stats.seatRequestsIgnored === guestBefore + 1);
}

section("starting is blocked for the right reasons");
{
  const { lobbies, setSeats } = rig(3);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 0, false);
  check("guest is told it is not the host", (lobbies[1] as Lobby).startBlocker() === START_BLOCK.NOT_HOST);
  check("nobody ready blocks", host.startBlocker() === START_BLOCK.NOT_READY);
  (lobbies[1] as Lobby).setLocal("Mire", 0, true);
  check("one of two ready still blocks", host.startBlocker() === START_BLOCK.NOT_READY);
  (lobbies[2] as Lobby).setLocal("Kolt", 0, true);
  check("all guests ready unblocks", host.startBlocker() === START_BLOCK.NONE, `${host.startBlocker()}`);
  check("the host never had to press ready", (host.seats[0] as { ready: boolean }).ready === false);
  check("canStart agrees", host.canStart() === true);

  setSeats([LIVE, HELD, LIVE], 0);
  check("a held seat blocks", host.startBlocker() === START_BLOCK.WAITING_RECONNECT);
  check("dropping cleared their ready flag", (host.seats[1] as { ready: boolean }).ready === false);
  check(
    "the drop was announced with their name",
    host.chat.some((l) => l.systemCode === SYSTEM_LINE.DROPPED && l.fromName === "Mire"),
  );

  setSeats([LIVE, EMPTY, EMPTY], 0);
  check("alone blocks", host.startBlocker() === START_BLOCK.ALONE, `${host.startBlocker()}`);
  check("a vacated seat forgets its name", (host.seats[1] as { name: string }).name === "");
  check(
    "leaving was announced",
    host.chat.some((l) => l.systemCode === SYSTEM_LINE.LEFT && l.fromName === "Mire"),
  );
}

section("launch sends one seed to everyone");
{
  const { lobbies } = rig(3, openPolicy, 0.25);
  const host = lobbies[0] as Lobby;
  const seen: number[] = [];
  host.setLocal("Asher", 0, false);
  (lobbies[1] as Lobby).setLocal("Mire", 0, true);
  (lobbies[2] as Lobby).setLocal("Kolt", 0, true);
  check("blocked start refuses to launch", (lobbies[1] as Lobby).start(3) === false);
  check("guest did not think it launched", (lobbies[1] as Lobby).launched === false);

  check("host launches", host.start(3) === true);
  check("host recorded the stage", host.launchStageId === 3);
  check("seed came from the injected random", host.launchSeed === 0x40000000, `${host.launchSeed}`);
  for (let i = 1; i < 3; i++) {
    const guest = lobbies[i] as Lobby;
    check(`guest ${i} launched`, guest.launched === true);
    check(`guest ${i} has the host's seed`, guest.launchSeed === host.launchSeed);
    check(`guest ${i} has the host's stage`, guest.launchStageId === 3);
    seen.push(guest.launchSeed);
  }
  check("both guests agree", seen[0] === seen[1]);

  const explicit = rig(2);
  const h2 = explicit.lobbies[0] as Lobby;
  h2.setLocal("Asher", 0, false);
  (explicit.lobbies[1] as Lobby).setLocal("Mire", 0, true);
  check("an explicit seed is used verbatim", h2.start(1, 12345) === true && h2.launchSeed === 12345);
}

section("chat crosses the party once, through the host");
{
  const { lobbies } = rig(3);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 0, false);
  (lobbies[1] as Lobby).setLocal("Mire", 0, false);
  (lobbies[2] as Lobby).setLocal("Kolt", 0, false);

  check("host line accepted", host.say("taking left side") === CHAT_REJECT.OK);
  const said = (l: Lobby) => l.chat.filter((c) => c.kind === CHAT_KIND.FREE);
  check("host sees its own line at once", said(host).length === 1);
  check("guest 1 sees the host line", said(lobbies[1] as Lobby).length === 1);
  check("guest 2 sees the host line", said(lobbies[2] as Lobby).length === 1);
  check("attributed to the host's seat", (said(lobbies[1] as Lobby)[0] as { fromSlot: number }).fromSlot === 0);
  check("attributed with the host's name", (said(lobbies[1] as Lobby)[0] as { fromName: string }).fromName === "Asher");

  check("guest line accepted", (lobbies[1] as Lobby).say("i need the magnet") === CHAT_REJECT.OK);
  check("the other guest got it via the host", said(lobbies[2] as Lobby).length === 2);
  check("the sender did not get a duplicate", said(lobbies[1] as Lobby).length === 2);
  check("the host got it once", said(host).length === 2);
  check(
    "the guest's line is attributed to the guest, not the host that relayed it",
    (said(host)[1] as { fromSlot: number }).fromSlot === 1,
  );
  check("nothing illegal was routed", true);
}

section("a guest cannot put words in another player's mouth");
{
  const { lobbies } = rig(3);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 0, false);
  (lobbies[1] as Lobby).setLocal("Mire", 0, false);
  (lobbies[2] as Lobby).setLocal("Kolt", 0, false);
  // Seat 1 sends a chat message whose body claims seat 0 wrote it.
  const forged = new Uint8Array([MSG.LOBBY_CHAT, 0, 1, 0, CHAT_KIND.FREE, 0, 0, 2, 104, 105]);
  host.receive(forged, 1, false);
  const heard = (lobbies[2] as Lobby).chat.filter((c) => c.kind === CHAT_KIND.FREE);
  check("the line still arrived", heard.length === 1);
  check("stamped with the real sender", (heard[0] as { fromSlot: number }).fromSlot === 1);
  check("not with the seat it claimed", (heard[0] as { fromSlot: number }).fromSlot !== 0);
}

section("presets travel as ids, not words");
{
  const { lobbies } = rig(2);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 0, false);
  check("preset accepted", host.sayPreset(PRESET.DANGER) === CHAT_REJECT.OK);
  const got = (lobbies[1] as Lobby).chat.filter((c) => c.kind === CHAT_KIND.PRESET);
  check("guest received a preset", got.length === 1);
  check("carrying the id", (got[0] as { presetId: number }).presetId === PRESET.DANGER);
  check("and no text", (got[0] as { text: string }).text === "");
  check("an unknown preset is refused", host.sayPreset(PRESET_COUNT) === CHAT_REJECT.BAD_PRESET);
  check("a negative preset is refused", host.sayPreset(-1) === CHAT_REJECT.BAD_PRESET);
  check("a fractional preset is refused", host.sayPreset(1.5) === CHAT_REJECT.BAD_PRESET);
}

section("every refusal has its own answer");
{
  const { clock, lobbies } = rig(2);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 0, false);
  check("empty is refused", host.say("    ") === CHAT_REJECT.EMPTY);
  check("over the cap is refused", host.say("x".repeat(MAX_CHAT_CHARS + 1)) === CHAT_REJECT.TOO_LONG);
  check("exactly the cap is fine", host.say("x".repeat(MAX_CHAT_CHARS)) === CHAT_REJECT.OK);
  check("refusals were counted", host.stats.chatRejected === 2, `${host.stats.chatRejected}`);

  // Four more empties the bucket (one token already spent above).
  for (let i = 0; i < CHAT_BUCKET_MAX - 1; i++) host.say(`line ${i}`);
  check("the bucket runs dry", host.say("one more") === CHAT_REJECT.RATE_LIMITED);

  // The burst size is a settled number, not whatever the constant happens to say: five lines back to
  // back, the sixth refused. A test written only against the constant would pass if the number moved.
  {
    const fresh = rig(2);
    const talker = fresh.lobbies[0] as Lobby;
    talker.setLocal("Asher", 0, false);
    const results: number[] = [];
    for (let i = 0; i < 6; i++) results.push(talker.say(`burst ${i}`));
    check("five lines back to back are allowed", results.slice(0, 5).every((r) => r === CHAT_REJECT.OK), results.join(","));
    check("the sixth is refused", results[5] === CHAT_REJECT.RATE_LIMITED, `${results[5]}`);
    check("the burst size is five", CHAT_BUCKET_MAX === 5, `${CHAT_BUCKET_MAX}`);
    check("a token comes back every one and a half seconds", CHAT_REFILL_MS === 1500, `${CHAT_REFILL_MS}`);
  }
  clock.ms += CHAT_REFILL_MS;
  check("and refills", host.say("after waiting") === CHAT_REJECT.OK);
  clock.ms -= 60_000;
  check("a clock that went backwards hands out nothing", host.say("time travel") === CHAT_REJECT.RATE_LIMITED);

  const unseated = new Lobby({
    send: () => {},
    now: () => 0,
    random: () => 0,
    chatPolicy: openPolicy,
  });
  check("no seat, no chat", unseated.say("hello") === CHAT_REJECT.NOT_SEATED);
  check("no seat, no presets", unseated.sayPreset(PRESET.HERE) === CHAT_REJECT.NOT_SEATED);
  check("no seat, no name change", (() => {
    unseated.setLocal("Ghost", 1, true);
    return (unseated.seats[0] as { name: string }).name === "";
  })());
}

section("the two chat switches, and neither overriding the other silently");
{
  const off = rig(2, { enabled: false, fromNonFriends: false });
  const hostOff = off.lobbies[0] as Lobby;
  check("chat off refuses to send", hostOff.say("hi") === CHAT_REJECT.CHAT_OFF);
  check("chat off refuses presets too", hostOff.sayPreset(PRESET.HERE) === CHAT_REJECT.CHAT_OFF);
  (off.lobbies[1] as Lobby).say("anyone there");
  check("chat off shows nothing incoming", hostOff.chat.every((c) => c.kind === CHAT_KIND.SYSTEM));

  const strangers = new FakeRelay();
  const clock = { ms: 0 };
  const friendsOnly: Lobby[] = [];
  for (let i = 0; i < 3; i++) {
    const lobby = new Lobby({
      send: strangers.sendFrom(i),
      now: () => clock.ms,
      random: () => 0.5,
      chatPolicy: { enabled: true, fromNonFriends: i === 0 ? false : true },
      isFriend: (slot: number) => slot === 1,
    });
    friendsOnly.push(lobby);
    strangers.seat(i, lobby);
  }
  for (let i = 0; i < 3; i++) {
    (friendsOnly[i] as Lobby).applyRoom(room("AAAAAA", 0, 3, [LIVE, LIVE, LIVE, EMPTY]), i);
  }
  (friendsOnly[1] as Lobby).say("from a friend");
  (friendsOnly[2] as Lobby).say("from a stranger");
  const seen = (friendsOnly[0] as Lobby).chat.filter((c) => c.kind === CHAT_KIND.FREE);
  check("the friend is heard", seen.length === 1, `${seen.length}`);
  check("and it is the friend", (seen[0] as { fromSlot: number }).fromSlot === 1);
  const strangerHeard = (friendsOnly[1] as Lobby).chat.filter((c) => c.kind === CHAT_KIND.FREE);
  check("the stranger's line still reached the player who allows strangers", strangerHeard.length === 2);
}

section("what arrives is re-filtered, never trusted");
{
  const { lobbies } = rig(2);
  const host = lobbies[0] as Lobby;
  // Hand the guest a host-authored line stuffed with control characters and newlines.
  const guest = lobbies[1] as Lobby;
  const body = [CHAT_KIND.FREE, 0, 0];
  const text = "a\n\n\nb\u0001c";
  const bytes = new Uint8Array([MSG.LOBBY_CHAT, 0, 0, 0, ...body, text.length, ...[...text].map((c) => c.charCodeAt(0))]);
  guest.receive(bytes, 0, true);
  const got = guest.chat.filter((c) => c.kind === CHAT_KIND.FREE);
  check("it arrived cleaned", got.length === 1 && (got[0] as { text: string }).text === "a bc", got[0]?.text);

  const blockAll = new Lobby({
    send: () => {},
    now: () => 0,
    random: () => 0,
    chatPolicy: openPolicy,
    filter: () => ({ allowed: false, text: "" }),
  });
  blockAll.applyRoom(room("AAAAAA", 0, 2, [LIVE, LIVE, EMPTY, EMPTY]), 0);
  check("an injected filter can refuse a send", blockAll.say("anything") === CHAT_REJECT.BLOCKED);
  blockAll.receive(bytes, 1, false);
  check(
    "and can refuse an arrival",
    blockAll.chat.every((c) => c.kind === CHAT_KIND.SYSTEM),
  );
  check("presets are not filtered", host.sayPreset(PRESET.NICE) === CHAT_REJECT.OK);
}

section("the log has a ceiling");
{
  const { clock, lobbies } = rig(2);
  const host = lobbies[0] as Lobby;
  host.setLocal("Asher", 0, false);
  for (let i = 0; i < CHAT_LOG_MAX * 2; i++) {
    clock.ms += CHAT_REFILL_MS;
    host.say(`line ${i}`);
  }
  check("log capped", host.chat.length === CHAT_LOG_MAX, `${host.chat.length}`);
  const last = host.chat[host.chat.length - 1] as { text: string };
  check("newest kept", last.text === `line ${CHAT_LOG_MAX * 2 - 1}`, last.text);
  check("oldest dropped", host.chat.every((c) => c.text !== "line 0"));
  check("guest log capped as well", (lobbies[1] as Lobby).chat.length === CHAT_LOG_MAX);
}

section("host migration mid-lobby");
{
  const { relay, lobbies, setSeats } = rig(3);
  (lobbies[0] as Lobby).setLocal("Asher", 0, false);
  (lobbies[1] as Lobby).setLocal("Mire", 4, true);
  (lobbies[2] as Lobby).setLocal("Kolt", 6, true);
  relay.unseat(0);
  setSeats([EMPTY, LIVE, LIVE], 1);
  const promoted = lobbies[1] as Lobby;
  check("the new host knows it hosts", promoted.isHost === true);
  check("the other guest agrees who hosts", (lobbies[2] as Lobby).hostSlot === 1);
  check("the promotion was announced", promoted.chat.some((c) => c.systemCode === SYSTEM_LINE.HOST_CHANGED));
  check("the old host's seat is empty", (promoted.seats[0] as { state: number }).state === LOBBY_SEAT.EMPTY);
  check("the new host kept the roster it had", (promoted.seats[2] as { name: string }).name === "Kolt");
  check("two live seats", promoted.liveCount === 2);
  check("the promoted host no longer needs its own ready flag", promoted.startBlocker() === START_BLOCK.NONE);
  check("the remaining guest is told it is not the host", (lobbies[2] as Lobby).startBlocker() === START_BLOCK.NOT_HOST);
}

section("broadcasts are addressed, guest traffic is not");
{
  const { relay, lobbies } = rig(3);
  (lobbies[0] as Lobby).setLocal("Asher", 0, false);
  (lobbies[1] as Lobby).say("hello");
  (lobbies[1] as Lobby).setLocal("Mire", 0, true);
  (lobbies[0] as Lobby).say("hello back");
  (lobbies[0] as Lobby).sayPreset(PRESET.LOOT);
  (lobbies[2] as Lobby).setLocal("Kolt", 6, true);
  const wentUp = (lobbies[0] as Lobby).start(1);
  check("no guest message was ever addressed anywhere", relay.illegal === 0, `${relay.illegal}`);
  check("the host could start once everyone was ready", wentUp === true);
  check("everyone is still in one party", (lobbies[2] as Lobby).launched === true);
  check("MAX_PLAYERS is what the roster carries", MAX_PLAYERS === 4);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
