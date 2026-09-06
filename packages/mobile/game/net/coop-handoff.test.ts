/**
 * The lobby-to-run hand-off, checked in isolation. Run headless:
 *   `bun packages/mobile/game/net/coop-handoff.test.ts`
 *
 * WHY THIS FILE EXISTS
 * The hand-off carries the one thing a launch cannot flatten into a route param: a live socket the
 * relay has already seated, with a room full of people on the other end. The rule that keeps a socket
 * from being driven by two runs at once — a launch is taken exactly once — lives in `CoopHandoff`, and
 * a rule that lives anywhere but a screen has to be proven anywhere but a phone. So it is proven here.
 *
 * WHAT IT PROVES
 *   1. An empty slot yields null, and pending is false.
 *   2. Staging fills the slot, take reads it back whole, and clears it.
 *   3. Taking twice yields null the second time — a remount cannot re-consume a live socket.
 *   4. Peek reads without consuming, so a screen can decide before it commits.
 *   5. Staging over a still-pending launch is refused, leaving the first launch untouched.
 *   6. Reset clears the slot without closing the connection it held.
 *   7. The module singleton is the same slot the app uses, independent of any test instance.
 */

import { COOP_HANDOFF, CoopHandoff, coopHandoff } from "./coop-handoff";
import type { CoopLaunch } from "./coop-handoff";
import type { Link } from "./session";

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

/** A link that remembers whether it was ever used. The handoff must never send down it itself. */
function silentLink(): { link: Link; sent: number } {
  const state = { sent: 0 };
  return { link: { send: () => state.sent++ }, sent: state.sent };
}

/** A launch that also records whether its `leave` was called, so we can prove reset does not close it. */
function makeLaunch(seed: number): { launch: CoopLaunch; left: () => number } {
  const { link } = silentLink();
  let leaves = 0;
  const launch: CoopLaunch = {
    seed,
    stageId: 3,
    playerCount: 2,
    connection: {
      link,
      localSlot: 1,
      hostSlot: 0,
      isHost: false,
      characterIds: [0, 1, 0, 0],
      leave: () => {
        leaves++;
      },
    },
  };
  return { launch, left: () => leaves };
}

section("1. An empty slot yields nothing");
{
  const h = new CoopHandoff();
  check("nothing is pending", h.pending === false);
  check("peek is null", h.peek() === null);
  check("take is null", h.take() === null);
}

section("2. Staging then taking reads it back whole and clears it");
{
  const h = new CoopHandoff();
  const { launch } = makeLaunch(90210);
  const outcome = h.stage(launch);
  check("staging is accepted", outcome.staged && outcome.code === COOP_HANDOFF.OK);
  check("and the slot is now pending", h.pending === true);
  const taken = h.take();
  check("take returns the exact launch", taken === launch);
  check("with the seed intact", taken?.seed === 90210, `${taken?.seed}`);
  check("with the stage intact", taken?.stageId === 3, `${taken?.stageId}`);
  check("with the party size intact", taken?.playerCount === 2, `${taken?.playerCount}`);
  check("and the live connection intact", taken?.connection.localSlot === 1 && taken?.connection.isHost === false);
  check("taking cleared the slot", h.pending === false);
}

section("3. Taking twice yields null the second time");
{
  const h = new CoopHandoff();
  const { launch } = makeLaunch(1);
  h.stage(launch);
  check("first take gets the launch", h.take() === launch);
  check("second take gets null — no re-consuming a live socket", h.take() === null);
}

section("4. Peek reads without consuming");
{
  const h = new CoopHandoff();
  const { launch } = makeLaunch(7);
  h.stage(launch);
  check("peek returns the launch", h.peek() === launch);
  check("peek did not clear the slot", h.pending === true);
  check("peek again still returns it", h.peek() === launch);
  check("and take still works after peeking", h.take() === launch);
}

section("5. Staging over a pending launch is refused");
{
  const h = new CoopHandoff();
  const { launch: first } = makeLaunch(100);
  const { launch: second } = makeLaunch(200);
  h.stage(first);
  const outcome = h.stage(second);
  check("the second stage is refused", !outcome.staged && outcome.code === COOP_HANDOFF.SLOT_BUSY);
  check("the first launch is still the one held", h.peek() === first);
  check("the first seed is untouched", h.peek()?.seed === 100, `${h.peek()?.seed}`);
}

section("6. Reset clears the slot without closing the connection");
{
  const h = new CoopHandoff();
  const { launch, left } = makeLaunch(5);
  h.stage(launch);
  h.reset();
  check("the slot is empty after reset", h.pending === false && h.take() === null);
  check("but the connection was never closed by reset", left() === 0, `${left()} leaves`);
}

section("7. The module singleton is a real, independent slot");
{
  // Leave it as we found it: this is the slot the app uses, and a test must not strand a launch in it.
  coopHandoff.reset();
  check("the app's slot starts empty", coopHandoff.pending === false);
  const { launch } = makeLaunch(42);
  coopHandoff.stage(launch);
  check("staging into the singleton works", coopHandoff.take() === launch);
  check("and it is empty again", coopHandoff.pending === false);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
