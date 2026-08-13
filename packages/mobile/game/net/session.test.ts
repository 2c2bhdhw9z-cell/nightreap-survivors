/**
 * Co-op session self-check. Run headless: `bun packages/mobile/game/net/session.test.ts`
 *
 * WHAT THIS IS FOR
 * `net.test.ts` proves the wire format survives a round trip. `run.test.ts` proves one machine's
 * simulation is deterministic. Neither of them proves the thing co-op actually lives or dies on: that
 * two, three or four separate simulations, fed nothing but a stream of confirmed input records across
 * a wire that loses packets and reorders them, stay in the same world for a full run.
 *
 * That cannot be tested on a desk with four phones on one wifi router, because the conditions that
 * break netcode — 150ms of lag, 2% of packets simply gone, packets arriving swapped — do not happen
 * there. So the network is simulated, seeded, and reproducible: the same seed drops the same packets
 * at the same moments every time, on any machine, forever.
 *
 * WHAT IT PROVES
 *   1. Two, three and four-player sessions run a full minute at 150ms round trip and 2% loss with the
 *      host and every guest agreeing on the state hash at every tick both have applied.
 *   2. Late and lost input costs one frame of a repeated stick — never a divergence.
 *   3. A guest cut off long enough to fall out of the retransmission window asks for the truth, gets a
 *      chunked snapshot, restores it, and rejoins in agreement.
 *   4. A guest whose world is corrupted on purpose is caught by the state hash and heals itself.
 *   5. A card screen answered by a guest is applied on the same tick on every machine.
 *   6. Full-tilt negative sticks survive the wire — a byte of 129 is -127, not 129.
 *   7. A one-player session sends nothing and matches a plain local run tick for tick: solo never pays
 *      for co-op existing.
 *   8. A four-player confirm never exceeds one message, and an awful connection may stall or resync but
 *      must never corrupt.
 */

import { Run } from "../run/run";
import { SNAPSHOT_ERROR } from "../save/snapshot";
import { CARD_ACTION, tickConfirmBytes } from "./messages";
import {
  CONFIRM_REDUNDANCY_TICKS,
  MAX_MESSAGE_BYTES,
  STATE_HASH_INTERVAL_TICKS,
} from "./protocol";
import {
  AWFUL_CONDITIONS,
  DEFAULT_CONDITIONS,
  firstDivergentTick,
  makeParty,
  PERFECT_CONDITIONS,
  runParty,
  type Party,
} from "./sim-network";
import { HASH_SEED } from "./state-hash";

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

function nowMs(): number {
  const host = globalThis as unknown as { performance?: { now?: () => number } };
  return host.performance?.now?.() ?? 0;
}

/* ---------------------------------------------------------------------------------------------- */
/* Driving a party                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A slow circle per player, each starting from a different point on it.
 *
 * Standing still is the easiest thing in the world to keep in sync and proves nothing. Four players
 * walking different paths through the same crowd is what actually stresses spawning, collisions,
 * magnetism and the level curve at the same time.
 */
function driveSticks(tick: number, party: Party): void {
  const a = (tick / 260) * Math.PI * 2;
  party.host.setLocalInput(Math.cos(a), Math.sin(a), 0);
  for (let i = 0; i < party.guests.length; i++) {
    const g = party.guests[i] as (typeof party.guests)[number];
    const b = a + ((i + 1) * Math.PI) / 2;
    g.setLocalInput(Math.cos(b), Math.sin(b), 0);
  }
}

/** Answer any open card screen from the host's own UI, so a headless party never deadlocks. */
function answerCards(party: Party): void {
  if (party.host.run.paused) party.host.requestCardAction(CARD_ACTION.PICK_0);
}

const defaultDrive = (tick: number, party: Party): void => {
  driveSticks(tick, party);
  answerCards(party);
};

/**
 * Run a party in slices, checking for divergence between each one.
 *
 * `firstDivergentTick` only looks back a few hundred ticks, because a guest's hash trail is a ring and
 * the old entries are gone. Checking only at the end of a long run would therefore miss a desync that
 * happened and then scrolled out of the window — which is exactly the kind of bug worth catching.
 */
function runChecked(
  party: Party,
  ticks: number,
  drive: (tick: number, party: Party) => void = defaultDrive,
  slice = 240,
): { tick: number; slot: number } {
  let done = 0;
  while (done < ticks) {
    const n = Math.min(slice, ticks - done);
    runParty(party, n, (t, p) => drive(done + t, p));
    done += n;
    const d = firstDivergentTick(party);
    if (d.tick >= 0) return d;
  }
  return { tick: -1, slot: -1 };
}

/** How many ticks of the host's world the slowest guest has not applied yet. */
function worstLag(party: Party): number {
  let worst = 0;
  for (const g of party.guests) worst = Math.max(worst, party.host.tick - g.tick);
  return worst;
}

/* ---------------------------------------------------------------------------------------------- */
/* 1. Agreement at 2, 3 and 4 players                                                              */
/* ---------------------------------------------------------------------------------------------- */

function testAgreement(): void {
  section("1. Two, three and four players agree at 150ms and 2% loss");

  for (const playerCount of [2, 3, 4]) {
    const started = nowMs();
    const party = makeParty({ playerCount, seed: 9100 + playerCount, conditions: DEFAULT_CONDITIONS });
    const ticks = 3600;
    const diverged = runChecked(party, ticks);
    const ms = Math.round(nowMs() - started);

    check(
      `${playerCount} players never disagree over ${ticks} ticks`,
      diverged.tick < 0,
      diverged.tick < 0 ? `${ms}ms` : `slot ${diverged.slot} at tick ${diverged.tick}`,
    );
    check(
      `${playerCount} players: host reached the end of the minute`,
      party.host.tick >= ticks - 2,
      `host tick ${party.host.tick}`,
    );
    check(
      `${playerCount} players: every guest stayed within a round trip of the host`,
      worstLag(party) <= 20,
      `worst lag ${worstLag(party)} ticks`,
    );
    check(
      `${playerCount} players: the wire really was lossy`,
      party.net.tally.dropped > 0,
      `${party.net.tally.dropped} of ${party.net.tally.sent} messages dropped`,
    );
    check(
      `${playerCount} players: late input cost predicted frames, not agreement`,
      party.host.stats.predictedFrames > 0,
      `${party.host.stats.predictedFrames} predicted frames`,
    );
    check(
      `${playerCount} players: nobody needed a resync on a healthy connection`,
      party.host.stats.resyncsServed === 0,
      `${party.host.stats.resyncsServed} served`,
    );
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* 2. A guest cut off long enough to fall out of the window                                        */
/* ---------------------------------------------------------------------------------------------- */

function testStallResync(): void {
  section("2. A guest cut off past the retransmission window asks for the truth");

  const party = makeParty({ playerCount: 3, seed: 5150, conditions: DEFAULT_CONDITIONS });
  runChecked(party, 600);

  const victim = party.guests[0] as (typeof party.guests)[number];
  const bystander = party.guests[1] as (typeof party.guests)[number];
  const tickBefore = victim.tick;
  const bystanderBefore = bystander.tick;

  // Long enough to be well past both the stall threshold and the redundancy window, so the confirms
  // that arrive after reconnection cannot possibly repair the hole.
  const blackout = 240;
  party.net.sever(1);
  runParty(party, blackout, defaultDrive);
  party.net.restore(1);

  check(
    "the cut-off guest stopped advancing",
    victim.tick - tickBefore < 8,
    `advanced ${victim.tick - tickBefore} ticks during a ${blackout}-tick blackout`,
  );
  check(
    "the blackout was longer than the redundancy window",
    blackout > CONFIRM_REDUNDANCY_TICKS,
    `${blackout} ticks vs ${CONFIRM_REDUNDANCY_TICKS} of redundancy`,
  );
  check(
    "the other guest carried on regardless",
    bystander.tick - bystanderBefore > blackout - 30,
    `advanced ${bystander.tick - bystanderBefore} ticks`,
  );
  check(
    "the host never waited for the missing player",
    party.host.tick >= tickBefore + blackout - 2,
    `host tick ${party.host.tick}`,
  );

  const diverged = runChecked(party, 600);

  check("the guest asked for a resync", victim.stats.resyncsRequested > 0);
  check("the host served one", party.host.stats.resyncsServed > 0);
  check(
    "the whole snapshot actually arrived",
    victim.stats.snapshotBytes > 0,
    `${victim.stats.snapshotBytes} bytes assembled`,
  );
  check(
    "and it restored cleanly",
    victim.lastRestoreError === SNAPSHOT_ERROR.NONE,
    `error code ${victim.lastRestoreError}`,
  );
  check("the guest is not still resyncing", !victim.resyncing);
  check(
    "the guest is running again",
    victim.tick > tickBefore + blackout,
    `guest tick ${victim.tick} vs host ${party.host.tick}`,
  );
  check(
    "and it agrees with the host again",
    diverged.tick < 0,
    diverged.tick < 0 ? "" : `slot ${diverged.slot} at tick ${diverged.tick}`,
  );
  check(
    "the snapshot was big enough to have needed chunking",
    party.host.stats.snapshotBytes > 1024,
    `${party.host.stats.snapshotBytes} bytes`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 3. A world corrupted on purpose                                                                 */
/* ---------------------------------------------------------------------------------------------- */

function testForcedDesync(): void {
  section("3. A corrupted guest is caught by the hash and heals itself");

  const party = makeParty({ playerCount: 2, seed: 7777, conditions: DEFAULT_CONDITIONS });
  runChecked(party, 600);

  const guest = party.guests[0] as (typeof party.guests)[number];
  const before = guest.stats.hashMismatches;

  // Shove one player twelve units sideways in the guest's world only. Nothing in the protocol can see
  // this; only the state hash can. This is the stand-in for a real divergence — a rounding difference,
  // a missed record, a modded client.
  guest.run.players.x[0] = (guest.run.players.x[0] as number) + 12;
  const corruptedHash = guest.run.hashState(HASH_SEED);
  const honestHash = party.host.run.hashState(HASH_SEED);
  check("the corruption actually changed the world", corruptedHash !== honestHash);

  // Long enough for a state hash to be broadcast, compared, and answered with a full snapshot.
  runParty(party, STATE_HASH_INTERVAL_TICKS * 3 + 120, defaultDrive);

  check(
    "the guest noticed it disagreed",
    guest.stats.hashMismatches > before,
    `${guest.stats.hashMismatches} mismatches`,
  );
  check("it asked for a snapshot", guest.stats.resyncsRequested > 0);
  check(
    "the whole snapshot actually arrived",
    guest.stats.snapshotBytes > 0,
    `${guest.stats.snapshotBytes} bytes assembled`,
  );
  check(
    "and it restored cleanly",
    guest.lastRestoreError === SNAPSHOT_ERROR.NONE,
    `error code ${guest.lastRestoreError}`,
  );
  check("the guest is not stuck waiting for a lost chunk", !guest.resyncing);

  const healedAt = party.host.tick;
  const diverged = runChecked(party, 300);
  check(
    "and the two worlds match again",
    diverged.tick < 0,
    diverged.tick < 0 ? `healed by tick ${healedAt}` : `slot ${diverged.slot} at tick ${diverged.tick}`,
  );
  check(
    "the guest is keeping pace again",
    party.host.tick - guest.tick <= 20,
    `host ${party.host.tick} vs guest ${guest.tick}`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 4. A card screen answered from the far end of the wire                                           */
/* ---------------------------------------------------------------------------------------------- */

function testGuestCardAction(): void {
  section("4. A guest can answer a card screen, and everyone applies it on the same tick");

  const party = makeParty({ playerCount: 2, seed: 3131, conditions: DEFAULT_CONDITIONS });
  const guest = party.guests[0] as (typeof party.guests)[number];

  // Nobody answers locally: the only answer in this session comes from the guest, over the wire.
  let asked = 0;
  let sawPause = false;
  const guestAnswers = (tick: number, p: Party): void => {
    driveSticks(tick, p);
    if (p.host.run.paused) {
      sawPause = true;
      // Ask once per screen rather than every tick, so a stuck screen shows up as a failure.
      if (asked === 0) {
        guest.requestCardAction(CARD_ACTION.PICK_0);
        asked++;
      }
    } else {
      asked = 0;
    }
  };

  // Walk forward one tick at a time until a screen has been raised and answered, then carry on for a
  // while. Doing it this way keeps the answered tick recent enough to still be in both hash trails and
  // both record rings when they are compared — a screen that happened a thousand ticks ago has already
  // scrolled out of the rings and proves nothing.
  let waited = 0;
  while (!sawPause && waited < 3000) {
    runParty(party, 1, (t, p) => guestAnswers(waited + t, p));
    waited++;
  }
  const diverged = runChecked(party, 150, guestAnswers, 75);

  check("a card screen actually came up", sawPause, `after ${waited} ticks`);
  check(
    "the run is not stuck on it",
    !party.host.run.paused,
    `paused with ${party.host.run.cards.picksRemaining} picks left`,
  );
  check(
    "the guest's pick reached the world",
    countWeapons(party.host.run) > 1 || party.host.run.prog.level > 1,
    `level ${party.host.run.prog.level}, ${countWeapons(party.host.run)} weapons`,
  );

  // The action lives inside the confirmed record, so both machines must find it on the same tick with
  // the same value — that is what makes "who answered first" reproducible instead of a race.
  let actionTicks = 0;
  let mismatched = 0;
  for (let t = Math.max(0, guest.tick - 200); t <= guest.tick; t++) {
    if (!party.host.ring.has(t) || !guest.ring.has(t)) continue;
    const h = party.host.ring.cardActionOf(t, party.playerCount);
    const g = guest.ring.cardActionOf(t, party.playerCount);
    if (h !== CARD_ACTION.NONE) actionTicks++;
    if (h !== g) mismatched++;
  }
  check("confirmed card actions are identical on both machines", mismatched === 0, `${mismatched} differ`);
  check(
    "and the answer really is in the confirmed record both are reading",
    actionTicks > 0,
    `${actionTicks} ticks carry an action`,
  );
  check(
    "the world agreed throughout the card screens",
    diverged.tick < 0,
    diverged.tick < 0 ? `${actionTicks} answered ticks in the window` : `tick ${diverged.tick}`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 5. Sign extension — the bug that would only show up when running left                            */
/* ---------------------------------------------------------------------------------------------- */

function testSignExtension(): void {
  section("5. A full-tilt negative stick survives the wire");

  const party = makeParty({ playerCount: 2, seed: 606, conditions: PERFECT_CONDITIONS });
  const guest = party.guests[0] as (typeof party.guests)[number];

  runParty(party, 90, (_t, p) => {
    p.host.setLocalInput(-1, 0, 0);
    guest.setLocalInput(0, -1, 0);
    answerCards(p);
  });

  check(
    "the host's own hard-left is -127, not 129",
    party.host.run.axes[0] === -127,
    `axes[0] = ${party.host.run.axes[0]}`,
  );
  check(
    "a guest's hard-up reaches the host as -127",
    party.host.run.axes[3] === -127,
    `axes[3] = ${party.host.run.axes[3]}`,
  );
  check(
    "and comes back out of the guest's own record as -127",
    guest.run.axes[3] === -127,
    `axes[3] = ${guest.run.axes[3]}`,
  );
  check(
    "the player actually moved the way the stick pointed",
    (party.host.run.players.y[1] as number) < (party.host.run.players.y[0] as number) ||
      (party.host.run.players.x[0] as number) < 0,
    `p0 x ${party.host.run.players.x[0]}, p1 y ${party.host.run.players.y[1]}`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 6. Solo pays nothing for co-op existing                                                         */
/* ---------------------------------------------------------------------------------------------- */

function testSoloIsFree(): void {
  section("6. A one-player session matches a plain local run, tick for tick");

  const party = makeParty({ playerCount: 1, seed: 8080, conditions: DEFAULT_CONDITIONS });
  const plain = new Run();
  plain.begin({ seed: 8080, playerCount: 1, record: false });

  const ticks = 1200;
  let mismatchAt = -1;
  for (let i = 0; i < ticks; i++) {
    const a = (i / 260) * Math.PI * 2;
    const x = Math.cos(a);
    const y = Math.sin(a);

    party.host.setLocalInput(x, y, 0);
    if (party.host.run.paused) party.host.requestCardAction(CARD_ACTION.PICK_0);
    party.host.step();
    party.net.pump();

    // The plain run is fed the same numbers the session quantises to, written the same way the record
    // application writes them. Going through `setStick` here would re-quantise an already-quantised
    // value, which is precisely the mistake the session is built to avoid.
    plain.axes[0] = Math.max(-127, Math.min(127, Math.round(x * 127)));
    plain.axes[1] = Math.max(-127, Math.min(127, Math.round(y * 127)));
    if (plain.paused) plain.pickCard(0);
    plain.tick();

    if (mismatchAt < 0 && plain.hashState(HASH_SEED) !== party.host.run.hashState(HASH_SEED)) {
      mismatchAt = i;
    }
  }

  check(
    "solo through the session is the same world as solo without it",
    mismatchAt < 0,
    mismatchAt < 0 ? `${ticks} ticks` : `first difference at tick ${mismatchAt}`,
  );
  check("a solo session sends nothing", party.host.stats.bytesSent === 0, `${party.host.stats.bytesSent} bytes`);
  check("a solo session confirms nothing", party.host.stats.confirmsSent === 0);
  check("and nothing was ever in flight", party.net.tally.sent === 0);
}

/* ---------------------------------------------------------------------------------------------- */
/* 7. Message sizes                                                                                */
/* ---------------------------------------------------------------------------------------------- */

function testMessageSizes(): void {
  section("7. A confirm always fits in one message");

  let worst = 0;
  let worstCount = 0;
  for (let count = 1; count <= CONFIRM_REDUNDANCY_TICKS; count++) {
    const bytes = tickConfirmBytes(4, count);
    if (bytes > worst) {
      worst = bytes;
      worstCount = count;
    }
  }
  check(
    "four players at full redundancy fit in one datagram",
    worst <= MAX_MESSAGE_BYTES,
    `${worst} bytes at ${worstCount} ticks, limit ${MAX_MESSAGE_BYTES}`,
  );

  const party = makeParty({ playerCount: 4, seed: 21, conditions: PERFECT_CONDITIONS });
  runParty(party, 300, defaultDrive);
  const perTick = party.host.stats.bytesSent / Math.max(1, party.host.tick);
  const upKbPerSec = (perTick * 60) / 1024;
  check(
    "hosting four players costs the host a sane amount of upload",
    upKbPerSec < 40,
    `${perTick.toFixed(0)} bytes per tick to all three guests, ${upKbPerSec.toFixed(1)} KB/s up`,
  );
  const downKbPerSec = upKbPerSec / 3;
  check(
    "and each guest downloads a fraction of that",
    downKbPerSec < 15,
    `${downKbPerSec.toFixed(1)} KB/s down per guest`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 8. Abuse                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function testAwfulConnection(): void {
  section("8. An awful connection may stall or resync — it must not corrupt");

  const party = makeParty({ playerCount: 4, seed: 4004, netSeed: 0xbad, conditions: AWFUL_CONDITIONS });
  const diverged = runChecked(party, 2400);

  check(
    "nobody's world went wrong at 200ms and 10% loss",
    diverged.tick < 0,
    diverged.tick < 0 ? "" : `slot ${diverged.slot} at tick ${diverged.tick}`,
  );
  check(
    "the connection really was that bad",
    party.net.tally.dropped > party.net.tally.sent * 0.05,
    `${party.net.tally.dropped} of ${party.net.tally.sent} dropped, ${party.net.tally.reordered} reordered`,
  );
  check(
    "guests still got through most of the run",
    worstLag(party) < 600,
    `worst lag ${worstLag(party)} ticks behind the host`,
  );
  check(
    "any snapshot that was needed restored cleanly",
    party.guests.every((g) => g.lastRestoreError === SNAPSHOT_ERROR.NONE),
    `${party.host.stats.resyncsServed} resyncs served`,
  );
  check(
    "duplicated packets changed nothing",
    party.net.tally.duplicated > 0 && diverged.tick < 0,
    `${party.net.tally.duplicated} duplicates delivered twice`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 9. A snapshot delivered over a wire that eats a quarter of it                                    */
/* ---------------------------------------------------------------------------------------------- */

function testResyncRepair(): void {
  section("9. A snapshot that arrives with holes in it gets repaired, not abandoned");

  const party = makeParty({ playerCount: 2, seed: 1212, netSeed: 0xf00d, conditions: DEFAULT_CONDITIONS });
  runChecked(party, 480);
  const guest = party.guests[0] as (typeof party.guests)[number];

  // Force the resync, then make the wire genuinely hostile while the snapshot is streaming. Seventy-odd
  // chunks at a quarter loss means the first pass cannot possibly complete — the only way through is
  // for the guest to name what it is missing and the host to send those pieces again.
  party.net.sever(1);
  runParty(party, 240, defaultDrive);
  party.net.restore(1);
  party.net.conditions.loss = 0.25;

  runChecked(party, 900);

  check("the guest asked for the snapshot", guest.stats.resyncsRequested > 0);
  check(
    "and got all of it despite a quarter of the wire disappearing",
    guest.stats.snapshotBytes > 0,
    `${guest.stats.snapshotBytes} bytes assembled`,
  );
  check("it is not stuck waiting", !guest.resyncing);
  check(
    "it restored cleanly — no half-snapshot ever reached the world",
    guest.lastRestoreError === SNAPSHOT_ERROR.NONE,
    `error code ${guest.lastRestoreError}`,
  );

  party.net.conditions.loss = DEFAULT_CONDITIONS.loss;
  const diverged = runChecked(party, 600);
  check(
    "and the two worlds agree again",
    diverged.tick < 0,
    diverged.tick < 0 ? `guest ${guest.tick}, host ${party.host.tick}` : `tick ${diverged.tick}`,
  );
}

function countWeapons(run: Run): number {
  let n = 0;
  for (let i = 0; i < 6; i++) if (run.weapons.typeIndex[i] >= 0) n++;
  return n;
}

testAgreement();
testStallResync();
testForcedDesync();
testGuestCardAction();
testSignExtension();
testSoloIsFree();
testMessageSizes();
testAwfulConnection();
testResyncRepair();

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
