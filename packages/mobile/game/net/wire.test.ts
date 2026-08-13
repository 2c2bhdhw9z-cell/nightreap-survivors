/**
 * Wire format self-check. Run headless: `bun packages/mobile/game/net/wire.test.ts`
 *
 * `net.test.ts` already proves the happy path of a handful of messages. This file exists because
 * `codec.ts` and `messages.ts` together are the largest untested surface in `net/`, and because
 * every desync we will ever chase starts with the suspicion that the bytes lied.
 *
 * WHAT IT PROVES
 *   1. Every encoder has a decoder that returns exactly what went in — including all four lobby
 *      messages, which nothing else covers.
 *   2. The header lands in the three bytes the relay reads, for every message type.
 *   3. Overflow sets a flag; it never truncates silently. Over-read sets a flag; it never invents
 *      data that looks plausible.
 *   4. `str()` survives multi-byte UTF-8 and stops at the 255-byte prefix ceiling without splitting
 *      a character.
 *   5. An event kind an older build does not recognise is skipped by its own byte count, leaving the
 *      rest of the packet readable.
 *   6. The declared size helpers agree with the real encoded lengths, to the byte.
 *   7. Decode clamps every count that indexes a fixed-size array.
 *   8. `TICK_CONFIRM` reads correctly out of a ring that has wrapped.
 *   9. Every id table is internally distinct, so no two meanings share a number.
 *
 * No test framework, same shape as the rest of `game/`: prints a table, exits non-zero on failure.
 */

import { Reader, Writer } from "./codec";
import { INPUT_FRAME_BYTES } from "./input";
import {
  CARD_ACTION,
  CORRECTION_HEADER_BYTES,
  EVENT_HEADER_BYTES,
  EVT,
  INPUT_BATCH_FRAME_BYTES,
  INPUT_BATCH_HEADER_BYTES,
  LARGEST_FIXED_MESSAGE_BYTES,
  LEAVE_REASON,
  MAX_CHAT_BYTES,
  MAX_NAME_BYTES,
  MAX_WIRE_MODIFIERS,
  RESYNC_CHUNK_HEADER_BYTES,
  RESYNC_NACK_HEADER_BYTES,
  TICK_CONFIRM_HEADER_BYTES,
  beginHostEvents,
  beginResyncChunk,
  correctionBytes,
  createLobbyRosterWire,
  createWelcome,
  decodeHello,
  decodeInputBatchHeader,
  decodeInputFrame,
  decodeLobbyChat,
  decodeLobbyLaunch,
  decodeLobbyRoster,
  decodeLobbySeat,
  decodeTickConfirmHeader,
  decodeTickRecord,
  decodeWelcome,
  encodeCardRequest,
  encodeCorrection,
  encodeHello,
  encodeHostMigrate,
  encodeInputBatch,
  encodeLeave,
  encodeLobbyChat,
  encodeLobbyLaunch,
  encodeLobbyRoster,
  encodeLobbySeat,
  encodePing,
  encodePong,
  encodeResyncNack,
  encodeResyncRequest,
  encodeStateHash,
  encodeTickConfirm,
  encodeWelcome,
  inputBatchBytes,
  readCorrectionEntity,
  readCorrectionHeader,
  readEventHeader,
  readResyncChunkHeader,
  readResyncNackHeader,
  tickConfirmBytes,
  tickRecordBytes,
  writeEventHeader,
} from "./messages";
import {
  CORRECTION_ENTITY_BYTES,
  HDR_FLAGS,
  HDR_PLAYER,
  HDR_TYPE,
  HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MSG,
  PROTOCOL_VERSION,
} from "./protocol";

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

/** A fresh copy, because `finish()` returns a view over a buffer the next message will overwrite. */
function copy(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * Widen an id table to plain numbers.
 *
 * TypeScript narrows each member of these tables to its own literal type and then refuses to compare
 * one against a number it "knows" cannot match — which is exactly the comparison a distinctness or
 * range check needs to make at runtime.
 */
function values(table: Record<string, number>): number[] {
  return Object.values(table);
}

/** Distinctness over a value table, at runtime — TypeScript refuses to compare two literal types. */
function allDistinct(table: Record<string, number>): boolean {
  const seen = new Set<number>();
  for (const v of Object.values(table)) {
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

/* ---- 1. the header the relay reads ------------------------------------------------------------- */

section("header placement");
{
  const w = new Writer();

  // Every message type, encoded with a non-zero sender, must put type and sender where the relay
  // looks. The relay reads four bytes and nothing else, so a layout slip here misroutes silently.
  // HELLO is the exception and deliberately so: a client saying hello has not been given a seat yet,
  // so it always sends sender 0. Everything after WELCOME knows its own slot and stamps it.
  const helloBytes = copy(encodeHello(w, 1, "a", 0));
  check("HELLO type byte", helloBytes[HDR_TYPE] === MSG.HELLO);
  check("HELLO has no seat yet", helloBytes[HDR_PLAYER] === 0, `${helloBytes[HDR_PLAYER]}`);

  const cases: Array<[string, number, Uint8Array]> = [
    ["WELCOME", MSG.WELCOME, copy(encodeWelcome(w, 2, 3, 9, 0, 1, new Int32Array(4), 0, 0))],
    ["INPUT_BATCH", MSG.INPUT_BATCH, copy(encodeInputBatch(w, 2, 0, 1, new Int8Array(2), new Uint8Array(2)))],
    ["STATE_HASH", MSG.STATE_HASH, copy(encodeStateHash(w, 2, 10, 5))],
    ["RESYNC_REQUEST", MSG.RESYNC_REQUEST, copy(encodeResyncRequest(w, 2, 10, 1, 2))],
    ["RESYNC_NACK", MSG.RESYNC_NACK, copy(encodeResyncNack(w, 2, 10, new Uint16Array(1), 1))],
    ["CORRECTION", MSG.CORRECTION, copy(encodeCorrection(w, 2, 1, new Int32Array(1), 0, new Uint16Array(1), new Int32Array(1), new Int32Array(1)))],
    ["PING", MSG.PING, copy(encodePing(w, 2, 1234, 7))],
    ["PONG", MSG.PONG, copy(encodePong(w, 2, 1234, 7, 8))],
    ["LEAVE", MSG.LEAVE, copy(encodeLeave(w, 2, LEAVE_REASON.QUIT))],
    ["CARD_REQUEST", MSG.CARD_REQUEST, copy(encodeCardRequest(w, 2, CARD_ACTION.PICK_1))],
    ["LOBBY_SEAT", MSG.LOBBY_SEAT, copy(encodeLobbySeat(w, 2, 1, true, "a"))],
    ["LOBBY_CHAT", MSG.LOBBY_CHAT, copy(encodeLobbyChat(w, 2, 0, 0, 2, "hi"))],
    ["LOBBY_LAUNCH", MSG.LOBBY_LAUNCH, copy(encodeLobbyLaunch(w, 2, 1, 1, 2))],
  ];

  for (const [name, type, bytes] of cases) {
    check(`${name} type byte`, bytes[HDR_TYPE] === type, `${bytes[HDR_TYPE]}`);
    check(`${name} sender byte`, bytes[HDR_PLAYER] === 2, `${bytes[HDR_PLAYER]}`);
    check(`${name} at least a header`, bytes.byteLength >= HEADER_BYTES, `${bytes.byteLength}`);
  }

  // Flags are the one header byte an encoder never sets; the relay and session own it.
  const plain = copy(encodeStateHash(w, 1, 5, 5));
  check("flags default to zero", plain[HDR_FLAGS] === 0);

  w.begin(MSG.STATE_HASH, 1, 0xa5);
  check("begin carries explicit flags", copy(w.finish())[HDR_FLAGS] === 0xa5);

  // HOST_MIGRATE is server-authored and names the new host in the header as well as the body.
  const migrate = copy(encodeHostMigrate(w, 3, 0));
  check("HOST_MIGRATE header names new host", migrate[HDR_PLAYER] === 3);
  const mr = new Reader(migrate);
  check("HOST_MIGRATE body names new host", mr.u8() === 3);
  check("HOST_MIGRATE tick is zero", mr.u32() === 0);
}

/* ---- 2. scalar round trips and the edges of each width ------------------------------------------ */

section("scalars");
{
  const w = new Writer();
  w.begin(MSG.PING, 0);
  w.u8(255).i8(-128).u16(65535).i16(-32768).u32(0xffffffff).i32(-2147483648);
  w.u8(0).i8(127).u16(0).i16(32767).u32(0).i32(2147483647);
  const bytes = copy(w.finish());
  check("no overflow at 26 bytes", !w.overflowed);

  const r = new Reader(bytes);
  check("u8 max", r.u8() === 255);
  check("i8 min", r.i8() === -128);
  check("u16 max", r.u16() === 65535);
  check("i16 min", r.i16() === -32768);
  check("u32 max", r.u32() === 0xffffffff);
  check("i32 min", r.i32() === -2147483648);
  check("u8 zero", r.u8() === 0);
  check("i8 max", r.i8() === 127);
  check("u16 zero", r.u16() === 0);
  check("i16 max", r.i16() === 32767);
  check("u32 zero", r.u32() === 0);
  check("i32 max", r.i32() === 2147483647);
  check("reader consumed everything", r.remaining === 0, `${r.remaining}`);
  check("nothing was truncated", !r.truncated);

  // Little-endian, stated explicitly on every call. Assert it rather than trust the default.
  const w2 = new Writer();
  w2.begin(MSG.PING, 0).u16(0x0102);
  const le = copy(w2.finish());
  check("u16 is little-endian", le[HEADER_BYTES] === 0x02 && le[HEADER_BYTES + 1] === 0x01);

  const w3 = new Writer();
  w3.begin(MSG.PING, 0).u32(0x01020304);
  const le4 = copy(w3.finish());
  check(
    "u32 is little-endian",
    le4[HEADER_BYTES] === 0x04 && le4[HEADER_BYTES + 3] === 0x01,
    `${le4[HEADER_BYTES]},${le4[HEADER_BYTES + 3]}`,
  );

  // Writers mask rather than throw, so a caller bug degrades to a wrong value, not a crash mid-tick.
  const w4 = new Writer();
  w4.begin(MSG.PING, 0).u8(0x1ff).u16(0x1ffff);
  const masked = new Reader(copy(w4.finish()));
  check("u8 masks to a byte", masked.u8() === 0xff);
  check("u16 masks to two bytes", masked.u16() === 0xffff);
}

/* ---- 3. writer bookkeeping --------------------------------------------------------------------- */

section("writer bookkeeping");
{
  const w = new Writer(16);
  check("capacity is what was asked for", w.capacity === 16, `${w.capacity}`);
  w.begin(MSG.PING, 0);
  check("length after begin is the header", w.length === HEADER_BYTES, `${w.length}`);
  check("remaining after begin", w.remaining === 12, `${w.remaining}`);

  w.u32(1).u32(2).u32(3);
  check("full writer has not overflowed", !w.overflowed);
  check("full writer has no room", w.remaining === 0, `${w.remaining}`);

  const before = w.length;
  w.u8(9);
  check("overflow flag set", w.overflowed);
  check("overflow did not advance the cursor", w.length === before, `${w.length}`);

  // The finished view is exactly the message, not the buffer.
  const view = w.finish();
  check("finish returns exact length", view.byteLength === before, `${view.byteLength}`);

  // begin() clears the flag, so a writer is reusable after a caller bug.
  w.begin(MSG.PING, 0);
  check("begin clears overflow", !w.overflowed);
  check("begin resets length", w.length === HEADER_BYTES);

  // A multi-byte field that does not fit must write nothing at all, not a partial value.
  const w2 = new Writer(HEADER_BYTES + 2);
  w2.begin(MSG.PING, 0).u32(0x11223344);
  check("partial u32 wrote nothing", w2.length === HEADER_BYTES && w2.overflowed, `${w2.length}`);

  // The default writer is big enough for the largest message the protocol allows.
  const wDefault = new Writer();
  check("default capacity is the protocol ceiling", wDefault.capacity === MAX_MESSAGE_BYTES);
  check(
    "largest fixed message fits",
    LARGEST_FIXED_MESSAGE_BYTES <= MAX_MESSAGE_BYTES,
    `${LARGEST_FIXED_MESSAGE_BYTES}`,
  );
  check(
    "largest fixed message covers a 4-player input frame",
    LARGEST_FIXED_MESSAGE_BYTES >= HEADER_BYTES + INPUT_FRAME_BYTES * MAX_PLAYERS,
  );

  // finish() caches views per length; the same length must not hand back a stale window.
  const w3 = new Writer();
  w3.begin(MSG.PING, 0).u32(1);
  const first = w3.finish();
  const firstLength = first.byteLength;
  w3.begin(MSG.PING, 0).u32(2);
  const second = w3.finish();
  check("cached view is reused for the same length", second.byteLength === firstLength);
  check("cached view sees the new bytes", new Reader(second).u32() === 2);
  check("the two views are the same window", first[HEADER_BYTES] === second[HEADER_BYTES]);
}

/* ---- 4. reader refuses to invent data ---------------------------------------------------------- */

section("reader safety");
{
  // A message cut off mid-field must report truncation, not return a plausible zero silently.
  const w = new Writer();
  w.begin(MSG.WELCOME, 0).u8(1).u8(2).u32(3);
  const full = copy(w.finish());

  for (let cut = HEADER_BYTES; cut < full.byteLength; cut++) {
    const r = new Reader(full.subarray(0, cut));
    r.u8();
    r.u8();
    r.u32();
    check(`truncated at ${cut} bytes is flagged`, r.truncated);
  }

  const whole = new Reader(full);
  whole.u8();
  whole.u8();
  whole.u32();
  check("the whole message is not flagged", !whole.truncated);

  // A header-only message has nothing to read and must say so on the first field.
  const headerOnly = new Reader(full.subarray(0, HEADER_BYTES));
  check("header-only remaining is zero", headerOnly.remaining === 0);
  check("reading past the header returns zero", headerOnly.u8() === 0);
  check("reading past the header is flagged", headerOnly.truncated);

  // reset() re-points a reader without allocating, and must clear the previous message's flag.
  const r2 = new Reader(full.subarray(0, HEADER_BYTES));
  r2.u32();
  check("flag set before reset", r2.truncated);
  r2.reset(full);
  check("reset clears the flag", !r2.truncated);
  check("reset re-points the reader", r2.u8() === 1);
  check("reset restarts after the header", r2.length === full.byteLength, `${r2.length}`);

  // A reader over a subarray must respect the subarray's window, not the whole backing buffer.
  const backing = new Uint8Array(64);
  backing.fill(0xcc);
  const windowed = backing.subarray(0, HEADER_BYTES + 1);
  const r3 = new Reader(windowed);
  check("windowed reader sees its own byte", r3.u8() === 0xcc);
  r3.u8();
  check("windowed reader stops at its own end", r3.truncated);

  // A string prefix longer than what is left must fail, not read a neighbour's bytes.
  const w2 = new Writer();
  w2.begin(MSG.LOBBY_CHAT, 0).u8(200);
  const liar = copy(w2.finish());
  const r4 = new Reader(liar);
  check("lying length prefix returns empty", r4.str() === "");
  check("lying length prefix is flagged", r4.truncated);
}

/* ---- 5. strings ------------------------------------------------------------------------------- */

section("strings");
{
  const w = new Writer();

  const samples = ["", "a", "Brett", "ABC123", "  spaces  ", "!@#$%^&*()"];
  for (const s of samples) {
    w.begin(MSG.LOBBY_SEAT, 0).str(s);
    const got = new Reader(copy(w.finish())).str();
    check(`ascii round trip ${JSON.stringify(s)}`, got === s, JSON.stringify(got));
  }

  // Two- and three-byte UTF-8. Names are user content; a mangled name is a support ticket.
  const multi = ["ü", "éü", "日本", "aé日b"];
  for (const s of multi) {
    w.begin(MSG.LOBBY_SEAT, 0).str(s);
    const got = new Reader(copy(w.finish())).str();
    check(`utf-8 round trip ${JSON.stringify(s)}`, got === s, JSON.stringify(got));
  }

  // The prefix is one byte, so 255 is the hard ceiling. 300 ascii characters must come back as 255.
  w.begin(MSG.LOBBY_CHAT, 0).str("x".repeat(300));
  const long = new Reader(copy(w.finish())).str();
  check("ascii truncates at 255 bytes", long.length === 255, `${long.length}`);

  // Exactly 255 must survive whole — an off-by-one here silently eats the last character forever.
  w.begin(MSG.LOBBY_CHAT, 0).str("y".repeat(255));
  check("exactly 255 survives", new Reader(copy(w.finish())).str().length === 255);
  w.begin(MSG.LOBBY_CHAT, 0).str("y".repeat(256));
  check("256 becomes 255", new Reader(copy(w.finish())).str().length === 255);

  // Truncation must not split a multi-byte character in half.
  w.begin(MSG.LOBBY_CHAT, 0).str("ü".repeat(200));
  const cut = new Reader(copy(w.finish())).str();
  check("two-byte truncation lands on a boundary", cut.length === 127, `${cut.length}`);
  check("two-byte truncation kept whole characters", cut === "ü".repeat(cut.length));

  w.begin(MSG.LOBBY_CHAT, 0).str("日".repeat(200));
  const cut3 = new Reader(copy(w.finish())).str();
  check("three-byte truncation lands on a boundary", cut3.length === 85, `${cut3.length}`);
  check("three-byte truncation kept whole characters", cut3 === "日".repeat(cut3.length));

  // A string that does not fit at all must set overflow rather than write a short version.
  const small = new Writer(HEADER_BYTES + 4);
  small.begin(MSG.LOBBY_CHAT, 0).str("abcdefgh");
  check("oversized string overflows", small.overflowed);
  check("oversized string wrote nothing", small.length === HEADER_BYTES, `${small.length}`);

  // The wire ceilings the lobby imposes are both inside the codec's own prefix limit.
  check("name ceiling fits a byte prefix", MAX_NAME_BYTES <= 255, `${MAX_NAME_BYTES}`);
  check("chat ceiling fits a byte prefix", MAX_CHAT_BYTES <= 255, `${MAX_CHAT_BYTES}`);
}

/* ---- 6. session setup ------------------------------------------------------------------------- */

section("hello and welcome");
{
  const w = new Writer();

  const hello = decodeHello(new Reader(copy(encodeHello(w, 0x12345678, "Nightreap", 0xffffffff))), {
    version: 0,
    buildId: 0,
    name: "",
    capabilities: 0,
  });
  check("hello version is the constant", hello.version === PROTOCOL_VERSION, `${hello.version}`);
  check("hello build id survives", hello.buildId === 0x12345678, hello.buildId.toString(16));
  check("hello name survives", hello.name === "Nightreap", hello.name);
  check("hello capabilities survive all 32 bits", hello.capabilities === 0xffffffff);

  const mods = new Int32Array(MAX_WIRE_MODIFIERS);
  for (let i = 0; i < MAX_WIRE_MODIFIERS; i++) mods[i] = -(i + 1) * 1000;

  const out = createWelcome();
  check("created welcome sizes its own modifier array", out.modifiers.length === MAX_WIRE_MODIFIERS);

  decodeWelcome(
    new Reader(copy(encodeWelcome(w, 3, 4, 0xfeedface, 0b101, 900, mods, MAX_WIRE_MODIFIERS, 12345))),
    out,
  );
  check("welcome slot", out.slot === 3);
  check("welcome player count", out.playerCount === 4);
  check("welcome seed survives the top bit", out.seed === 0xfeedface, out.seed.toString(16));
  check("welcome taint survives", out.tainted === 0b101);
  check("welcome stage", out.stageId === 900);
  check("welcome tick", out.tick === 12345);
  check("welcome modifier count", out.modifierCount === MAX_WIRE_MODIFIERS);
  let modsMatch = true;
  for (let i = 0; i < MAX_WIRE_MODIFIERS; i++) if (out.modifiers[i] !== mods[i]) modsMatch = false;
  check("welcome modifiers survive, negatives included", modsMatch);

  // An over-long modifier stack is clamped on both sides — the encoder writes at most the ceiling,
  // and the decoder refuses to index past its own array even if the bytes claim more.
  const many = new Int32Array(MAX_WIRE_MODIFIERS + 8);
  many.fill(7);
  const clamped = copy(encodeWelcome(w, 0, 1, 1, 0, 1, many, MAX_WIRE_MODIFIERS + 8, 0));
  const clampedOut = createWelcome();
  decodeWelcome(new Reader(clamped), clampedOut);
  check("encoder clamps the modifier stack", clampedOut.modifierCount === MAX_WIRE_MODIFIERS);

  const forged = copy(clamped);
  forged[forged.byteLength - MAX_WIRE_MODIFIERS * 4 - 1] = 200;
  const forgedOut = createWelcome();
  decodeWelcome(new Reader(forged), forgedOut);
  check("decoder clamps a forged modifier count", forgedOut.modifierCount === MAX_WIRE_MODIFIERS);

  // Zero modifiers is the normal case and must not read a single spare byte.
  const bare = copy(encodeWelcome(w, 1, 2, 5, 0, 3, mods, 0, 9));
  const bareOut = createWelcome();
  const bareReader = new Reader(bare);
  decodeWelcome(bareReader, bareOut);
  check("no modifiers decodes clean", bareOut.modifierCount === 0 && !bareReader.truncated);
  check("no modifiers consumes the whole message", bareReader.remaining === 0, `${bareReader.remaining}`);
}

/* ---- 7. input batches ------------------------------------------------------------------------- */

section("input batches");
{
  const w = new Writer();
  const count = 12;
  const axes = new Int8Array(count * 2);
  const bits = new Uint8Array(count * 2);
  for (let i = 0; i < count; i++) {
    axes[i * 2] = i % 2 === 0 ? 127 : -128;
    axes[i * 2 + 1] = -(i * 3);
    bits[i * 2] = i * 7 + 1;
    bits[i * 2 + 1] = i % 3;
  }

  const bytes = copy(encodeInputBatch(w, 2, 4_000_000_000, count, axes, bits));
  check(
    "declared batch size matches reality",
    bytes.byteLength === inputBatchBytes(count),
    `${bytes.byteLength} vs ${inputBatchBytes(count)}`,
  );
  check(
    "batch header size is honest",
    inputBatchBytes(0) === HEADER_BYTES + INPUT_BATCH_HEADER_BYTES,
    `${inputBatchBytes(0)}`,
  );

  const r = new Reader(bytes);
  const header = decodeInputBatchHeader(r, { slot: 0, firstTick: 0, count: 0 });
  check("batch slot", header.slot === 2);
  check("batch first tick survives above 2^31", header.firstTick === 4_000_000_000, `${header.firstTick}`);
  check("batch count", header.count === count);

  const frame = new Int32Array(4);
  let framesMatch = true;
  for (let i = 0; i < count; i++) {
    decodeInputFrame(r, frame);
    if (frame[0] !== axes[i * 2]) framesMatch = false;
    if (frame[1] !== axes[i * 2 + 1]) framesMatch = false;
    if (frame[2] !== bits[i * 2]) framesMatch = false;
    if (frame[3] !== bits[i * 2 + 1]) framesMatch = false;
  }
  check("every frame survives, signs included", framesMatch);
  check("batch consumed exactly", r.remaining === 0 && !r.truncated, `${r.remaining}`);

  // An empty batch is legal — a guest with nothing new still says so, and it must not read a frame.
  const empty = copy(encodeInputBatch(w, 1, 100, 0, axes, bits));
  const er = new Reader(empty);
  const eh = decodeInputBatchHeader(er, { slot: 0, firstTick: 0, count: 0 });
  check("empty batch decodes", eh.count === 0 && eh.firstTick === 100 && !er.truncated);
  check("empty batch is header-sized", empty.byteLength === inputBatchBytes(0));
}

/* ---- 8. host events, including one from a future build ----------------------------------------- */

section("host events");
{
  const w = new Writer();
  beginHostEvents(w, 0, 500);

  // Three events: one known, one from a build we do not have, one known again. The unknown one has
  // to be skipped by its own byte count or everything after it is garbage.
  check("spawn header fits", writeEventHeader(w, EVT.SPAWN, 4, 500));
  w.u16(11).u16(22);
  const futureKind = 200;
  check("future header fits", writeEventHeader(w, futureKind, 6, 501));
  w.u16(1).u16(2).u16(3);
  check("death header fits", writeEventHeader(w, EVT.DEATH, 2, 502));
  w.u16(0xbeef);

  const bytes = copy(w.finish());
  const r = new Reader(bytes);
  check("events message tick", r.u32() === 500);
  check("events message reserved count byte", r.u8() === 0);

  const head = { kind: 0, byteLength: 0, tick: 0 };
  readEventHeader(r, head);
  check("first event is a spawn", head.kind === EVT.SPAWN);
  check("first event tick", head.tick === 500);
  check("first event payload length", head.byteLength === 4);
  check("first event payload", r.u16() === 11 && r.u16() === 22);

  readEventHeader(r, head);
  check("second event is unknown", head.kind === futureKind, `${head.kind}`);
  check("unknown event declares its length", head.byteLength === 6);
  for (let i = 0; i < head.byteLength; i++) r.u8();

  readEventHeader(r, head);
  check("third event survived the skip", head.kind === EVT.DEATH, `${head.kind}`);
  check("third event tick survived the skip", head.tick === 502);
  check("third event payload survived the skip", r.u16() === 0xbeef);
  check("events consumed exactly", r.remaining === 0 && !r.truncated, `${r.remaining}`);

  // A full message refuses the header rather than writing half an event. Dropping an authoritative
  // event is unrecoverable, so the answer is "flush and start another", which needs a false here.
  const tight = new Writer(HEADER_BYTES + 5 + EVENT_HEADER_BYTES + 4);
  beginHostEvents(tight, 0, 1);
  check("first event fits the tight writer", writeEventHeader(tight, EVT.SPAWN, 4, 1));
  tight.u16(1).u16(2);
  const lengthBefore = tight.length;
  check("second event is refused", !writeEventHeader(tight, EVT.SPAWN, 4, 1));
  check("refusal wrote nothing", tight.length === lengthBefore, `${tight.length}`);
  check("refusal is not an overflow", !tight.overflowed);

  // The declared header size, measured rather than trusted. Everything else in this section uses the
  // constant, so a wrong constant would agree with itself; this counts the bytes that were written.
  const probe = new Writer();
  beginHostEvents(probe, 0, 1);
  const beforeHeader = probe.length;
  writeEventHeader(probe, EVT.SPAWN, 0, 1);
  check(
    "an event header really is the declared number of bytes",
    probe.length - beforeHeader === EVENT_HEADER_BYTES,
    `${probe.length - beforeHeader}`,
  );

  // A zero-length event is legal (a bare signal) and must not be confused with a refusal.
  const zero = new Writer(HEADER_BYTES + 5 + EVENT_HEADER_BYTES);
  beginHostEvents(zero, 0, 1);
  check("zero-length event is accepted", writeEventHeader(zero, EVT.RUN_STATE, 0, 1));

  check("event kinds are distinct", allDistinct(EVT));
  check("no event kind is zero", values(EVT).every((v) => v !== 0));
  check("every event kind fits a byte", values(EVT).every((v) => v >= 0 && v <= 255));
}

/* ---- 9. hashes, resync, corrections ------------------------------------------------------------ */

section("resync and corrections");
{
  const w = new Writer();

  const hashBytes = copy(encodeStateHash(w, 0, 7200, -1));
  const hr = new Reader(hashBytes);
  check("state hash tick", hr.u32() === 7200);
  check("state hash keeps a negative hash", hr.i32() === -1);

  const reqBytes = copy(encodeResyncRequest(w, 1, 60, 0x7fffffff, -0x80000000));
  const rr = new Reader(reqBytes);
  check("resync request tick", rr.u32() === 60);
  check("resync request local hash", rr.i32() === 0x7fffffff);
  check("resync request expected hash", rr.i32() === -0x80000000);

  beginResyncChunk(w, 0, 900, 5, 24, 1024);
  const chunkBytes = copy(w.finish());
  check(
    "chunk header size is honest",
    chunkBytes.byteLength === HEADER_BYTES + RESYNC_CHUNK_HEADER_BYTES,
    `${chunkBytes.byteLength}`,
  );
  const ch = readResyncChunkHeader(new Reader(chunkBytes), {
    tick: 0,
    chunkIndex: 0,
    chunkCount: 0,
    payloadBytes: 0,
  });
  check("chunk tick", ch.tick === 900);
  check("chunk index", ch.chunkIndex === 5);
  check("chunk count", ch.chunkCount === 24);
  check("chunk payload size", ch.payloadBytes === 1024);

  // A nack names scattered indices, not a range — that is the whole point of the format.
  const indices = new Uint16Array([3, 11, 40, 65535]);
  const nackBytes = copy(encodeResyncNack(w, 1, 120, indices, indices.length));
  check(
    "nack header size is honest",
    nackBytes.byteLength === HEADER_BYTES + RESYNC_NACK_HEADER_BYTES + indices.length * 2,
    `${nackBytes.byteLength}`,
  );
  const nr = new Reader(nackBytes);
  const nh = readResyncNackHeader(nr, { tick: 0, count: 0 });
  check("nack tick", nh.tick === 120);
  check("nack count", nh.count === indices.length);
  let nackMatch = true;
  for (let i = 0; i < nh.count; i++) if (nr.u16() !== indices[i]) nackMatch = false;
  check("nack indices survive, scattered and at the top of the range", nackMatch);
  check("nack consumed exactly", nr.remaining === 0 && !nr.truncated);

  // Corrections index into the host's own arrays, so the encoder reads generation and position by
  // entity index rather than by loop position. Sparse indices are the normal case.
  const picks = new Int32Array([9, 2, 40]);
  const generations = new Uint16Array(64);
  const posX = new Int32Array(64);
  const posY = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    generations[i] = i * 3;
    posX[i] = i * -1000;
    posY[i] = i * 1000;
  }

  const corrBytes = copy(encodeCorrection(w, 0, 4242, picks, picks.length, generations, posX, posY));
  check(
    "correction size is honest",
    corrBytes.byteLength === correctionBytes(picks.length),
    `${corrBytes.byteLength} vs ${correctionBytes(picks.length)}`,
  );
  check(
    "correction entity size is honest",
    correctionBytes(1) - correctionBytes(0) === CORRECTION_ENTITY_BYTES,
  );
  check(
    "correction header size is honest",
    correctionBytes(0) === HEADER_BYTES + CORRECTION_HEADER_BYTES,
    `${correctionBytes(0)}`,
  );

  const cr = new Reader(corrBytes);
  const chh = readCorrectionHeader(cr, { tick: 0, count: 0 });
  check("correction tick", chh.tick === 4242);
  check("correction count", chh.count === picks.length);
  const ent = new Int32Array(4);
  let corrMatch = true;
  for (let i = 0; i < chh.count; i++) {
    readCorrectionEntity(cr, ent);
    const idx = picks[i] as number;
    if (ent[0] !== idx) corrMatch = false;
    if (ent[1] !== generations[idx]) corrMatch = false;
    if (ent[2] !== posX[idx]) corrMatch = false;
    if (ent[3] !== posY[idx]) corrMatch = false;
  }
  check("corrections carry the right entity's generation and position", corrMatch);
  check("correction consumed exactly", cr.remaining === 0 && !cr.truncated);

  // An empty correction sweep is legal and costs a header.
  const noneBytes = copy(encodeCorrection(w, 0, 1, picks, 0, generations, posX, posY));
  check("empty correction is header-sized", noneBytes.byteLength === correctionBytes(0));
}

/* ---- 10. ping, pong, leave -------------------------------------------------------------------- */

section("ping, pong, leave");
{
  const w = new Writer();

  // Send time is a millisecond clock that will pass 2^31 inside a long session, so it travels as u32
  // and must come back unsigned.
  const pingBytes = copy(encodePing(w, 1, 3_000_000_000, 777));
  const pr = new Reader(pingBytes);
  check("ping send time survives above 2^31", pr.u32() === 3_000_000_000);
  check("ping carries the sender's tick", pr.u32() === 777);

  const pongBytes = copy(encodePong(w, 0, 3_000_000_000, 777, 779));
  const gr = new Reader(pongBytes);
  check("pong echoes the send time", gr.u32() === 3_000_000_000);
  check("pong echoes the sender tick", gr.u32() === 777);
  check("pong carries its own tick", gr.u32() === 779);

  for (const reason of values(LEAVE_REASON)) {
    const bytes = copy(encodeLeave(w, 2, reason));
    check(`leave reason ${reason} round trips`, new Reader(bytes).u8() === reason);
  }
  check("leave reasons are distinct", allDistinct(LEAVE_REASON));
  check("no leave reason is zero", values(LEAVE_REASON).every((v) => v !== 0));
}

/* ---- 11. tick confirm, read out of a wrapped ring ----------------------------------------------- */

section("tick confirm");
{
  const w = new Writer();

  check("one player record is 5 bytes", tickRecordBytes(1) === 5, `${tickRecordBytes(1)}`);
  check("four player record is 17 bytes", tickRecordBytes(MAX_PLAYERS) === 17, `${tickRecordBytes(4)}`);
  check(
    "confirm header size is honest",
    tickConfirmBytes(4, 0) === HEADER_BYTES + TICK_CONFIRM_HEADER_BYTES,
    `${tickConfirmBytes(4, 0)}`,
  );

  const playerCount = 4;
  const stride = tickRecordBytes(playerCount);
  const capacity = 16;
  const records = new Uint8Array(stride * capacity);

  // Fill the ring as the host would, for ticks 0..39 — so it has wrapped more than twice and the
  // ticks we ask for do not start at ring slot zero.
  for (let tick = 0; tick < 40; tick++) {
    const base = (tick % capacity) * stride;
    for (let b = 0; b < stride; b++) records[base + b] = (tick * 31 + b * 7) & 0xff;
  }

  const firstTick = 30;
  const count = 8;
  const bytes = copy(
    encodeTickConfirm(w, 0, firstTick, count, playerCount, records, stride, capacity),
  );
  check(
    "confirm size is honest",
    bytes.byteLength === tickConfirmBytes(playerCount, count),
    `${bytes.byteLength} vs ${tickConfirmBytes(playerCount, count)}`,
  );

  const r = new Reader(bytes);
  const header = decodeTickConfirmHeader(r, { firstTick: 0, count: 0, playerCount: 0 });
  check("confirm first tick", header.firstTick === firstTick);
  check("confirm count", header.count === count);
  check("confirm player count", header.playerCount === playerCount);

  const dest = new Uint8Array(stride * count);
  for (let i = 0; i < count; i++) decodeTickRecord(r, header.playerCount, dest, i * stride);
  check("confirm consumed exactly", r.remaining === 0 && !r.truncated, `${r.remaining}`);

  let ringMatch = true;
  for (let i = 0; i < count; i++) {
    const tick = firstTick + i;
    for (let b = 0; b < stride; b++) {
      if (dest[i * stride + b] !== ((tick * 31 + b * 7) & 0xff)) ringMatch = false;
    }
  }
  check("the wrapped ring came out in tick order", ringMatch);

  // The record bytes are opaque to the codec, so all-ones must survive as well as the pattern above.
  records.fill(0xff);
  const ones = copy(encodeTickConfirm(w, 0, 15, 2, playerCount, records, stride, capacity));
  const or2 = new Reader(ones);
  decodeTickConfirmHeader(or2, { firstTick: 0, count: 0, playerCount: 0 });
  let allOnes = true;
  for (let b = 0; b < stride * 2; b++) if (or2.u8() !== 0xff) allOnes = false;
  check("opaque record bytes survive untouched", allOnes);

  // Card actions ride inside the record, one byte, never renumbered.
  check("card actions are distinct", allDistinct(CARD_ACTION));
  check("card action NONE is zero", CARD_ACTION.NONE === 0);
  check("every card action fits a byte", values(CARD_ACTION).every((v) => v >= 0 && v <= 255));
  for (const action of values(CARD_ACTION)) {
    const bytes2 = copy(encodeCardRequest(w, 3, action));
    check(`card request ${action} round trips`, new Reader(bytes2).u8() === action);
  }
}

/* ---- 12. lobby -------------------------------------------------------------------------------- */

section("lobby");
{
  const w = new Writer();

  const seat = decodeLobbySeat(new Reader(copy(encodeLobbySeat(w, 2, 7, true, "Brett"))), {
    characterId: 0,
    ready: false,
    name: "",
  });
  check("seat character", seat.characterId === 7);
  check("seat ready is true", seat.ready);
  check("seat name", seat.name === "Brett");

  const notReady = decodeLobbySeat(new Reader(copy(encodeLobbySeat(w, 1, 0, false, ""))), {
    characterId: 9,
    ready: true,
    name: "stale",
  });
  check("seat ready is false", !notReady.ready);
  check("seat decode overwrites a stale name", notReady.name === "");

  // Only 1 is ready. Anything else on the wire is not-ready, so a corrupt byte cannot start a run.
  const forgedSeat = copy(encodeLobbySeat(w, 1, 0, true, ""));
  forgedSeat[HEADER_BYTES + 1] = 200;
  const forged = decodeLobbySeat(new Reader(forgedSeat), { characterId: 0, ready: true, name: "" });
  check("only 1 counts as ready", !forged.ready);

  // The roster is always complete, never a diff.
  const states = new Uint8Array([1, 2, 3, 0]);
  const characters = new Uint8Array([10, 20, 30, 40]);
  const ready = new Uint8Array([1, 0, 1, 0]);
  const names = ["Brett", "ü日", "", "Four"];

  const rosterBytes = copy(encodeLobbyRoster(w, 0, 2, 4, states, characters, ready, names));
  const roster = createLobbyRosterWire();
  const rr = new Reader(rosterBytes);
  decodeLobbyRoster(rr, roster);
  check("roster count", roster.count === 4);
  check("roster names the host seat", roster.hostSlot === 2);
  let rosterMatch = true;
  for (let i = 0; i < 4; i++) {
    if (roster.states[i] !== states[i]) rosterMatch = false;
    if (roster.characters[i] !== characters[i]) rosterMatch = false;
    if (roster.ready[i] !== ready[i]) rosterMatch = false;
    if (roster.names[i] !== names[i]) rosterMatch = false;
  }
  check("every seat survives, empty names and utf-8 included", rosterMatch);
  check("roster consumed exactly", rr.remaining === 0 && !rr.truncated, `${rr.remaining}`);

  // A missing name must encode as empty rather than the string "undefined".
  const shortNames = ["a"];
  const sparse = copy(encodeLobbyRoster(w, 0, 0, 4, states, characters, ready, shortNames));
  const sparseOut = createLobbyRosterWire();
  decodeLobbyRoster(new Reader(sparse), sparseOut);
  check("missing names decode empty", sparseOut.names[1] === "" && sparseOut.names[3] === "");

  // Both sides clamp the seat count, because it indexes fixed four-slot arrays.
  const over = copy(encodeLobbyRoster(w, 0, 0, 9, states, characters, ready, names));
  const overOut = createLobbyRosterWire();
  decodeLobbyRoster(new Reader(over), overOut);
  check("encoder clamps the seat count", overOut.count === MAX_PLAYERS, `${overOut.count}`);

  const forgedRoster = copy(over);
  forgedRoster[HEADER_BYTES] = 200;
  const forgedRosterOut = createLobbyRosterWire();
  decodeLobbyRoster(new Reader(forgedRoster), forgedRosterOut);
  check("decoder clamps a forged seat count", forgedRosterOut.count === MAX_PLAYERS);
  check("forged roster wrote nothing past the array", forgedRosterOut.states.length === MAX_PLAYERS);

  // Chat says who relayed it in the header and who wrote it in the body. Only the host writes the body.
  const chatBytes = copy(encodeLobbyChat(w, 0, 1, 4, 3, "regroup on me"));
  check("chat header says who relayed it", chatBytes[HDR_PLAYER] === 0);
  const chat = decodeLobbyChat(new Reader(chatBytes), {
    kind: 0,
    presetId: 0,
    fromSlot: 0,
    text: "",
  });
  check("chat kind", chat.kind === 1);
  check("chat preset id", chat.presetId === 4);
  check("chat body says who wrote it", chat.fromSlot === 3);
  check("chat text", chat.text === "regroup on me");

  // A chat line at the wire ceiling must arrive whole.
  const maxText = "z".repeat(MAX_CHAT_BYTES);
  const maxChat = decodeLobbyChat(new Reader(copy(encodeLobbyChat(w, 0, 0, 0, 1, maxText))), {
    kind: 0,
    presetId: 0,
    fromSlot: 0,
    text: "",
  });
  check("a full-length chat line arrives whole", maxChat.text === maxText, `${maxChat.text.length}`);

  const maxName = "n".repeat(MAX_NAME_BYTES);
  const maxSeat = decodeLobbySeat(new Reader(copy(encodeLobbySeat(w, 1, 0, false, maxName))), {
    characterId: 0,
    ready: false,
    name: "",
  });
  check("a full-length name arrives whole", maxSeat.name === maxName, `${maxSeat.name.length}`);

  // The launch message is the whole contract for starting a run: seed, stage, party size.
  const launch = decodeLobbyLaunch(new Reader(copy(encodeLobbyLaunch(w, 0, 0xcafebabe, 65535, 4))), {
    seed: 0,
    stageId: 0,
    playerCount: 0,
  });
  check("launch seed survives the top bit", launch.seed === 0xcafebabe, launch.seed.toString(16));
  check("launch stage survives the top of the range", launch.stageId === 65535);
  check("launch party size", launch.playerCount === 4);
}

/* ---- 13. constants of record ------------------------------------------------------------------- */

section("constants of record");
{
  // Every number here is a wire layout. Changing one silently makes this build unable to talk to the
  // last one, and the symptom on a player's phone is a desync, not a version error — so each is
  // pinned to its literal value on purpose. Changing one deliberately means bumping the protocol
  // version and editing this list in the same commit.
  check("a header is 4 bytes", HEADER_BYTES === 4, `${HEADER_BYTES}`);
  check("an input batch header is 6 bytes", INPUT_BATCH_HEADER_BYTES === 6, `${INPUT_BATCH_HEADER_BYTES}`);
  check("an input frame on the wire is 4 bytes", INPUT_BATCH_FRAME_BYTES === 4, `${INPUT_BATCH_FRAME_BYTES}`);
  check("an event header is 6 bytes", EVENT_HEADER_BYTES === 6, `${EVENT_HEADER_BYTES}`);
  check("a resync chunk header is 10 bytes", RESYNC_CHUNK_HEADER_BYTES === 10, `${RESYNC_CHUNK_HEADER_BYTES}`);
  check("a resync nack header is 6 bytes", RESYNC_NACK_HEADER_BYTES === 6, `${RESYNC_NACK_HEADER_BYTES}`);
  check("a correction header is 5 bytes", CORRECTION_HEADER_BYTES === 5, `${CORRECTION_HEADER_BYTES}`);
  check("a corrected entity is 12 bytes", CORRECTION_ENTITY_BYTES === 12, `${CORRECTION_ENTITY_BYTES}`);
  check("a tick confirm header is 6 bytes", TICK_CONFIRM_HEADER_BYTES === 6, `${TICK_CONFIRM_HEADER_BYTES}`);
  check("an input frame in memory is 8 bytes", INPUT_FRAME_BYTES === 8, `${INPUT_FRAME_BYTES}`);
  check("the modifier stack ceiling is 32", MAX_WIRE_MODIFIERS === 32, `${MAX_WIRE_MODIFIERS}`);
  check("a name is at most 24 bytes", MAX_NAME_BYTES === 24, `${MAX_NAME_BYTES}`);
  check("a chat line is at most 160 bytes", MAX_CHAT_BYTES === 160, `${MAX_CHAT_BYTES}`);
  check("a message is at most 1200 bytes", MAX_MESSAGE_BYTES === 1200, `${MAX_MESSAGE_BYTES}`);
  check("a party is at most 4", MAX_PLAYERS === 4, `${MAX_PLAYERS}`);
  check("the protocol version is 4", PROTOCOL_VERSION === 4, `${PROTOCOL_VERSION}`);
}

/* ---- 14. the message table itself -------------------------------------------------------------- */

section("message table");
{
  check("message ids are distinct", allDistinct(MSG));
  check("no message id is zero", values(MSG).every((v) => v !== 0));
  check("every message id fits a byte", values(MSG).every((v) => v >= 1 && v <= 255));
  check("no message id collides with the broadcast marker", values(MSG).every((v) => v !== 0xff));
  check("protocol version is at least 4", PROTOCOL_VERSION >= 4, `${PROTOCOL_VERSION}`);
}

console.log(
  `\n${failures === 0 ? "PASS" : `FAIL — ${failures} check${failures === 1 ? "" : "s"}`}\n`,
);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
