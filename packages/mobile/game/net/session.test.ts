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
  RESYNC_AFTER_AGED_OUT_TICKS,
  RESYNC_AFTER_STALL_TICKS,
  STATE_HASH_INTERVAL_TICKS,
} from "./protocol";
import { MAX_CATCHUP_TICKS } from "./session";
import {
  AWFUL_CONDITIONS,
  DEFAULT_CONDITIONS,
  firstDivergentTick,
  makeParty,
  PERFECT_CONDITIONS,
  runParty,
  type Party,
} from "./sim-network";
import { MOD_DEV_GODMODE } from "../sim/modifiers";
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

/**
 * Advance the host and the wire for `ticks`, but never pump the guests.
 *
 * This is what a backgrounded phone looks like: its render loop is stopped, so its session's `pump`
 * is not being called and its stall counter is not advancing — yet the host keeps sealing ticks and
 * broadcasting confirms the whole time. On resume the guest is far behind the horizon but has a stall
 * count of zero, which is exactly the screenshot case the recovery must handle without waiting out the
 * old ninety-tick ceiling. A lossy connection is the opposite (the guest keeps pumping and stalling),
 * and `runParty` already covers that.
 */
function driveGuestlessBlackout(party: Party, ticks: number): void {
  // Sever slot 1 for the duration: a backgrounded app is not servicing its socket, so the confirms the
  // host broadcasts while it is away never reach it and never land in its ring. On resume the guest's
  // ring still ends where it stalled, and the first confirm it hears covers only the recent window — so
  // the record it needs next has genuinely aged out, which is the real screenshot state. (A background
  // spell that merely stopped rendering but kept buffering the socket would instead leave the ring full
  // and be repaired by burst catch-up; that milder case is what section 10 covers.)
  party.net.sever(1);
  for (let i = 0; i < ticks; i++) {
    defaultDrive(i, party);
    party.host.step();
    party.net.pump();
  }
  party.net.restore(1);
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
    // Godmode is on for one reason: this section is about whether two to four worlds agree for a solid
    // minute, and a party that dies at fifty-five seconds stops simulating and stops proving anything.
    // Whether that seed's card picks are strong enough to survive is a balance question, not a
    // networking one, so it is taken off the table. Every peer gets the same modifier, so the thing
    // being measured — that all of them reach the same numbers — is untouched.
    const party = makeParty({
      playerCount,
      seed: 9100 + playerCount,
      conditions: DEFAULT_CONDITIONS,
      modifiers: [MOD_DEV_GODMODE],
    });
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
/* 4. Two players each answer their OWN card screen                                                 */
/* ---------------------------------------------------------------------------------------------- */

function testPerPlayerCardActions(): void {
  section("4. Each player answers their own card screen, onto their own loadout, in lockstep");

  // Godmode so neither seat dies before it has levelled and answered a screen — this section is about
  // the per-player card path, not survival. Both peers get the same modifier, so what is measured
  // (each seat levelling on its own gems and picking onto its own store) is untouched.
  const party = makeParty({
    playerCount: 2,
    seed: 3131,
    conditions: DEFAULT_CONDITIONS,
    modifiers: [MOD_DEV_GODMODE],
  });
  const guest = party.guests[0] as (typeof party.guests)[number];

  // The whole point of the change: the host answers ITS screen and the guest answers ITS screen, each
  // onto its own weapon/passive store. The host picks a card (slot 0's offer), the guest rerolls then
  // picks — different actions on purpose, so a bug that crosses the two shows up as the wrong store
  // changing. Both are answered through the same per-slot request path the app uses.
  let hostPicks = 0;
  let guestPicks = 0;
  const bothAnswer = (tick: number, p: Party): void => {
    driveSticks(tick, p);
    // The host's own screen (slot 0). `requestCardAction` on the host targets its own card byte.
    if (p.host.run.pausedFor(p.host.localSlot)) {
      p.host.requestCardAction(CARD_ACTION.PICK_0);
      hostPicks++;
    }
    // The guest's screen (slot 1). Its request rides the wire into slot 1's card byte.
    if (p.host.run.pausedFor(guest.slot)) {
      guest.requestCardAction(CARD_ACTION.PICK_0);
      guestPicks++;
    }
  };

  // Run long enough that both seats level and each answers at least one screen. Both players walk
  // different arcs through the same crowd, so each collects its own gems and levels on them. Scan for
  // confirmed per-player card bytes as they are sealed, because the picks land early and the ring only
  // retains a few hundred ticks — a trailing scan at the end would find nothing.
  let confirmedActionTicks = 0;
  let confirmedMismatch = 0;
  let lastScanned = -1;
  const slice = 120;
  let done = 0;
  let diverged: { tick: number; slot: number } = { tick: -1, slot: -1 };
  while (done < 6000 && diverged.tick < 0) {
    const n = Math.min(slice, 6000 - done);
    runParty(party, n, (t, p) => bothAnswer(done + t, p));
    done += n;
    // Scan whatever the host has newly confirmed and both machines still hold.
    const from = Math.max(lastScanned + 1, party.host.tick - 200);
    for (let t = from; t <= party.host.tick; t++) {
      if (!party.host.ring.has(t)) continue;
      for (let pl = 0; pl < party.playerCount; pl++) {
        const h = party.host.ring.cardActionOf(t, party.playerCount, pl);
        if (h !== CARD_ACTION.NONE) confirmedActionTicks++;
        if (guest.ring.has(t) && h !== guest.ring.cardActionOf(t, party.playerCount, pl)) {
          confirmedMismatch++;
        }
      }
      lastScanned = t;
    }
    diverged = firstDivergentTick(party);
  }

  check("the world never diverged while both answered their own screens", diverged.tick < 0,
    diverged.tick < 0 ? "" : `slot ${diverged.slot} at tick ${diverged.tick}`);
  check("both seats reached at least one card screen", hostPicks > 0 && guestPicks > 0,
    `host ${hostPicks}, guest ${guestPicks}`);
  check("no screen is left stuck open", !party.host.run.paused,
    `p0 ${party.host.run.cardsFor(0).picksRemaining}, p1 ${party.host.run.cardsFor(1).picksRemaining} picks left`);

  // Each player levelled on their OWN gems and picked onto their OWN weapon store. Player 0 and
  // player 1 are independent progressions now, so both should have advanced.
  check("player 0 levelled up on its own experience", party.host.run.progFor(0).level > 1,
    `level ${party.host.run.progFor(0).level}`);
  check("player 1 levelled up on its own experience", party.host.run.progFor(1).level > 1,
    `level ${party.host.run.progFor(1).level}`);

  // The picks landed on the acting player's own weapon store, not a single shared player-0 loadout.
  const p0Weapons = countWeaponsFor(party.host.run, 0);
  const p1Weapons = countWeaponsFor(party.host.run, 1);
  check("player 0 has its own weapons", p0Weapons >= 1, `${p0Weapons}`);
  check("player 1 has its own weapons", p1Weapons >= 1, `${p1Weapons}`);
  // The two stores are independent memory: the guest is one weapon or level ahead in ITS store, and
  // that must be visible as its own weapon levels rather than as a change to player 0's.
  const p0Levels = weaponLevelSum(party.host.run, 0);
  const p1Levels = weaponLevelSum(party.host.run, 1);
  check("each player's weapon store carries its own levels", p0Levels > 0 && p1Levels > 0,
    `p0 level-sum ${p0Levels}, p1 level-sum ${p1Levels}`);

  // Every per-player card byte matched on both machines as it was sealed — that is what makes each
  // player's own pick reproducible from the confirmed record alone rather than a race.
  check("every per-player card byte is identical on both machines", confirmedMismatch === 0,
    `${confirmedMismatch} differ`);
  check("the confirmed record really carried per-player answers", confirmedActionTicks > 0,
    `${confirmedActionTicks} player-ticks carry an action`);

  // The guest's own machine agrees with the host's world throughout — the guest is not just cosmetically
  // showing its pick, it applied every player's confirmed action identically.
  check("host and guest hold the same world at the guest's horizon",
    guest.run.hashState(HASH_SEED) === (party.host.trail.has(guest.tick)
      ? party.host.trail.at(guest.tick)
      : guest.run.hashState(HASH_SEED)),
    `guest tick ${guest.tick}`);
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

/* ---------------------------------------------------------------------------------------------- */
/* 10. A guest that hitched but stayed inside the window catches up fast, without a resync            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The screenshot bug, half one. A guest misses a burst of confirmed ticks — a hitch short enough that
 * the records it missed are all still in the confirm ring when it comes back — and must converge back
 * to the host horizon in a handful of pumps, NOT crawl six ticks a frame.
 *
 * The wire is severed only long enough to fall a couple of dozen ticks behind, well inside the
 * retransmission window, then restored. Under the old six-tick-per-frame cap a backlog of, say,
 * twenty-five ticks takes five frames of nothing-but-catch-up to close; the burst path closes it in
 * one or two. The assertion — converged within a small bounded number of pumps and without ever
 * asking for a snapshot — fails under the old crawl cap, which is the point.
 */
function testStallBurstCatchup(): void {
  section("10. A guest that hitched inside the window catches up in a burst, not a crawl");

  const party = makeParty({ playerCount: 2, seed: 8123, conditions: PERFECT_CONDITIONS });
  runParty(party, 300, defaultDrive);

  const guest = party.guests[0] as (typeof party.guests)[number];
  const resyncsBefore = guest.stats.resyncsRequested;

  // A hitch short enough that everything missed is still resendable. The host keeps advancing and the
  // wire keeps flowing to everyone else; only this guest's link is cut, exactly like an app that
  // briefly stopped pumping its socket. On a perfect wire the backlog is precisely the blackout length,
  // kept inside the steady confirm window so the very next confirm the guest hears carries the whole
  // hole. Under the old six-tick cap the guest would then crawl the backlog closed six ticks a frame,
  // never keeping pace with a host that is still moving; the burst path swallows it in one confirm.
  const blackout = 20;
  party.net.sever(1);
  runParty(party, blackout, defaultDrive);
  party.net.restore(1);

  const behindAfter = party.host.tick - guest.tick;
  check(
    "the guest really fell behind during the hitch",
    behindAfter > MAX_CATCHUP_TICKS,
    `${behindAfter} ticks behind, steady cap is ${MAX_CATCHUP_TICKS}`,
  );

  // The realistic recovery: the host carries on, and within a couple of frames of the guest hearing a
  // fresh confirm the gap must be back to steady state. `runParty` steps the host, moves the wire, and
  // pumps the guest once each tick — exactly the app's cadence. The burst path swallows the whole
  // 20-tick hole in the one or two frames it takes a confirm to arrive, so the guest is level with the
  // host almost at once. The old six-tick cap nets only five ticks a frame against a still-moving host,
  // so two frames later it would still owe about ten — well above the steady cap. Bounding convergence
  // to two frames is therefore something only the burst path can clear.
  const settleFrames = 2;
  runParty(party, settleFrames, defaultDrive);

  const lagNow = worstLag(party);
  check(
    "the guest is back to steady-state lag within two frames",
    lagNow <= MAX_CATCHUP_TICKS,
    `${lagNow} ticks behind after ${settleFrames} frames (the old crawl would still owe most of ${behindAfter})`,
  );
  check(
    "and it never needed a snapshot for a gap it could replay",
    guest.stats.resyncsRequested === resyncsBefore,
    `${guest.stats.resyncsRequested - resyncsBefore} resyncs requested`,
  );

  const diverged = runChecked(party, 300);
  check(
    "the world still agrees after the burst catch-up",
    diverged.tick < 0,
    diverged.tick < 0 ? "" : `slot ${diverged.slot} at tick ${diverged.tick}`,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* 11. A guest whose records aged out snaps forward promptly, not after ninety stalled ticks        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The screenshot bug, half two. A guest is away long enough — a screenshot pause, a task switch —
 * that the records it needs next have aged out of the retransmission window. No confirm still arriving
 * can carry them, so waiting is pointless; the guest must ask for a snapshot promptly and snap forward
 * to become controllable, rather than sitting frozen for ninety stalled ticks while its predicted lead
 * pins at the drift ceiling.
 *
 * This asserts the prompt request on two triggers: the ordinary `pump` path noticing the aged-out gap,
 * and the explicit `onResumedFromBackground` the AppState handler calls, which must fire on the very
 * first attempt without waiting out any stall counter. Both fail under the old ninety-tick rule.
 */
function testStallSnapForward(): void {
  section("11. A guest past the window snaps forward promptly, not after ninety stalled ticks");

  const party = makeParty({ playerCount: 2, seed: 9241, conditions: PERFECT_CONDITIONS });
  runParty(party, 400, defaultDrive);

  const guest = party.guests[0] as (typeof party.guests)[number];
  const tickBefore = guest.tick;

  // A blackout longer than the whole retransmission window: whatever the guest needs next when it comes
  // back has been overwritten in the host's ring by newer records. Comfortably shorter than the old
  // ninety-tick stall ceiling, so a test that passes here proves the resync fired on the aged-out
  // signal and not on the fallback timer.
  const blackout = RESYNC_AFTER_AGED_OUT_TICKS + 20;
  check(
    "the blackout aged the records out but stayed under the old stall ceiling",
    blackout > CONFIRM_REDUNDANCY_TICKS && blackout < RESYNC_AFTER_STALL_TICKS,
    `${blackout} ticks: window ${CONFIRM_REDUNDANCY_TICKS}, old ceiling ${RESYNC_AFTER_STALL_TICKS}`,
  );

  // A screenshot backgrounds the app: its render loop stops, so the guest's `pump` is NOT called while
  // it is away — its stall counter does not tick up during the pause. Model that by advancing only the
  // host and the wire during the blackout, never the guest. This is the crucial difference from a lossy
  // connection (where the guest keeps pumping and stalling): on resume the guest starts from a stall
  // count of zero, so the old ninety-tick ceiling has the full ninety still to run before it would ever
  // fire. Only the aged-out signal recovers a backgrounded guest promptly.
  driveGuestlessBlackout(party, blackout);

  // With the socket back, let a couple of confirms land so the guest's horizon jumps up to the host —
  // but do NOT pump the guest, so no stall counter runs and the recovery we prove is the resume nudge,
  // not the fallback timer. The record the guest needs next is not in these confirms (it aged out), so
  // once the horizon has risen the guest is stuck exactly as a returning screenshot leaves it.
  let settle = 0;
  while (guest.horizon - guest.tick <= RESYNC_AFTER_AGED_OUT_TICKS && settle < 30) {
    driveSticks(500 + settle, party);
    answerCards(party);
    party.host.step();
    party.net.pump();
    settle++;
  }
  const resyncsBefore = guest.stats.resyncsRequested;
  const behind = guest.horizon - guest.tick;
  check(
    "the guest is stuck behind the confirmed horizon on a record it will never be resent",
    behind > RESYNC_AFTER_AGED_OUT_TICKS,
    `${behind} ticks behind the horizon`,
  );

  // The AppState resume path: one explicit call must ask for the truth at once, before any stall timer
  // has had a chance to run out. This is the "returning from a screenshot" moment.
  guest.onResumedFromBackground();
  check(
    "resuming from background asks for a snapshot immediately",
    guest.stats.resyncsRequested > resyncsBefore,
    `${guest.stats.resyncsRequested - resyncsBefore} requested on resume`,
  );
  check("and the guest is now resyncing", guest.resyncing);

  // Let the snapshot stream over and restore. Well under ninety ticks of run — the whole point.
  const restoresBefore = guest.restores;
  runChecked(party, 300);

  check(
    "the guest restored and snapped forward",
    guest.restores > restoresBefore,
    `${guest.restores - restoresBefore} restores`,
  );
  check(
    "the guest is running again, far past where it stalled",
    guest.tick > tickBefore + blackout,
    `guest ${guest.tick}, stalled at ${tickBefore}`,
  );
  check("the guest is not still resyncing", !guest.resyncing);
  check(
    "and it agrees with the host again",
    firstDivergentTick(party).tick < 0,
    `guest ${guest.tick}, host ${party.host.tick}`,
  );
}

/**
 * The same aged-out stall, but left to the ordinary `pump` path with no AppState nudge, proving the
 * snap-forward fires from the stall detection itself well before the old ninety-tick ceiling.
 *
 * A perfect wire and a fresh party keep any state-hash checkpoint from muddying the attribution: the
 * only thing that can request a resync in this window is the aged-out gap the pump path now watches.
 * Under the old rule the pump path would sit stalled until `stalledFor` crossed ninety, so bounding
 * the request to well under that ceiling is a check only the new aged-out signal can pass.
 */
function testStallSnapForwardWithoutNudge(): void {
  section("12. The pump path itself asks for a resync once the gap ages out, before the old ceiling");

  const party = makeParty({ playerCount: 2, seed: 9242, conditions: PERFECT_CONDITIONS });
  // Start just after a hash checkpoint so the ~120-tick interval does not land inside the measurement
  // window: the resync we count must be the aged-out one, not a hash mismatch (there is none — a
  // severed guest's world is simply behind, not wrong).
  runParty(party, STATE_HASH_INTERVAL_TICKS * 3 + 4, defaultDrive);

  const guest = party.guests[0] as (typeof party.guests)[number];
  const hashMismatchesBefore = guest.stats.hashMismatches;
  const blackout = RESYNC_AFTER_AGED_OUT_TICKS + 20;

  // Backgrounded guest: host and wire advance, the guest does not pump, so it resumes with a stall
  // count of zero and the old ninety-tick ceiling would have the full ninety still to run.
  driveGuestlessBlackout(party, blackout);

  const resyncsBefore = guest.stats.resyncsRequested;
  // Count how many guest pumps it takes, with the host running and the wire flowing again, to decide it
  // must resync. The host keeps sealing and confirming, so the guest's horizon rises above its applied
  // tick within a frame or two of the first confirm landing — and the moment the gap is past the window
  // the aged-out test fires. This should be a handful of pumps, never the ninety the old rule waited.
  const promptBound = RESYNC_AFTER_STALL_TICKS - 20;
  let pumps = 0;
  while (guest.stats.resyncsRequested === resyncsBefore && pumps < RESYNC_AFTER_STALL_TICKS + 30) {
    driveSticks(700 + pumps, party);
    answerCards(party);
    party.host.step();
    party.net.pump();
    guest.pump();
    pumps++;
  }

  check(
    "no state-hash mismatch was involved — the guest's world was behind, not wrong",
    guest.stats.hashMismatches === hashMismatchesBefore,
    `${guest.stats.hashMismatches - hashMismatchesBefore} mismatches`,
  );
  check(
    "the pump path asked for a resync well before the old ninety-tick ceiling",
    guest.stats.resyncsRequested > resyncsBefore && pumps < promptBound,
    `asked after ${pumps} pumps, old ceiling ${RESYNC_AFTER_STALL_TICKS}`,
  );

  const diverged = runChecked(party, 400);
  check(
    "and the world agrees after the snap-forward",
    diverged.tick < 0 && !guest.resyncing,
    diverged.tick < 0 ? `guest ${guest.tick}, host ${party.host.tick}` : `tick ${diverged.tick}`,
  );
}

/** How many weapon slots a given player's own store holds. */
function countWeaponsFor(run: Run, player: number): number {
  let n = 0;
  for (let i = 0; i < 6; i++) if (run.weapons.typeIndex[player * 6 + i] >= 0) n++;
  return n;
}

/** Sum of a given player's weapon levels — a proxy for "this store took its own picks". */
function weaponLevelSum(run: Run, player: number): number {
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const idx = run.weapons.typeIndex[player * 6 + i];
    if (idx >= 0) sum += run.weapons.level[player * 6 + i] as number;
  }
  return sum;
}

testAgreement();
testStallResync();
testForcedDesync();
testPerPlayerCardActions();
testSignExtension();
testSoloIsFree();
testMessageSizes();
testAwfulConnection();
testResyncRepair();
testStallBurstCatchup();
testStallSnapForward();
testStallSnapForwardWithoutNudge();

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
