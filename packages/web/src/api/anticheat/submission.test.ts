/**
 * Anti-cheat v1 self-check. Run headless: `bun src/api/anticheat/submission.test.ts`
 *
 * WHAT IT PROVES
 *   1. The tables have no holes: no shared numbers, no code without wording, no flag that reads as
 *      "no flag", and no more flags than a verdict can carry.
 *   2. Real logs, built by the same recorder the game ships, are accepted.
 *   3. Every structural refusal fires for its own reason and for no other reason — each mapped one to
 *      one, so "bad log" never swallows the interesting case.
 *   4. A result that disagrees with its log about any fact the log already holds is refused, field by
 *      field, rather than judged.
 *   5. A refused submission carries no flags at all.
 *   6. Every flag fires when it should, does not fire on an ordinary honest run, and is measured against
 *      the logged duration rather than the claimed one.
 *   7. Flags never refuse: a run covered in flags is still accepted.
 *   8. Nothing here throws on hostile input — a malformed upload is a value.
 *   9. The offsets this server reads a header at are the same offsets the game writes it at. This is the
 *      guard that keeps two packages from drifting apart on a byte layout.
 */

import {
  HDR,
  HEADER_BYTES,
  MAX_REPLAY_PLAYERS,
  REPLAY_MAGIC,
  REPLAY_VERSION,
  TAINT,
} from "../../../../mobile/game/replay/format";
import { ReplayRecorder } from "../../../../mobile/game/replay/recorder";
import {
  CEILING,
  CLAIMABLE_END,
  MAX_RUN_FLAGS,
  MAX_SUBMISSION_BYTES,
  REFUSE_RUN,
  RUN_FLAG,
  SUBMIT_LIMITS_VERSION,
  TICKS_PER_SECOND,
  describeFlag,
  describeRefusal,
  emptyVerdict,
  flagLines,
  judge,
  tableFaults,
  verdictLine,
  type RunClaim,
} from "./submission";

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

/* ---------------------------------------------------------------------------------------------- */
/* Building real logs                                                                              */
/* ---------------------------------------------------------------------------------------------- */

interface LogOptions {
  ticks?: number;
  seed?: number;
  stageId?: number;
  players?: number;
  tainted?: number;
  contentVersion?: number;
  startedAtUnixSec?: number;
  /** How often the stick changes. 1 means every tick, which is the worst case for log size. */
  changeEvery?: number;
}

/**
 * Build a log with the recorder the game actually ships, not a hand-written buffer.
 *
 * A test that writes its own bytes tests the test. Every accepted case below is a log the game could
 * have produced, and the deliberately broken cases are made by damaging one of these.
 */
function makeLog(o: LogOptions = {}): Uint8Array {
  const ticks = o.ticks ?? TICKS_PER_SECOND * 60;
  const players = o.players ?? 1;
  const changeEvery = o.changeEvery ?? 30;
  const rec = new ReplayRecorder();
  rec.begin({
    seed: o.seed ?? 12345,
    stageId: o.stageId ?? 1,
    buildId: 7,
    contentVersion: o.contentVersion ?? 1,
    characterIds: [0, 1, 2, 3],
    playerCount: players,
    startedAtUnixSec: o.startedAtUnixSec ?? 1_700_000_000,
    tainted: o.tainted ?? 0,
  });
  const axes = new Int8Array(players * 2);
  const buttons = new Uint8Array(players);
  for (let t = 0; t < ticks; t++) {
    if (t % changeEvery === 0) {
      const a = (t / changeEvery) % 127;
      for (let p = 0; p < players; p++) {
        axes[p * 2] = a;
        axes[p * 2 + 1] = -a;
      }
    }
    rec.recordTick(axes, buttons);
  }
  rec.end(0x1234abcd | 0);
  return rec.encode();
}

/** A claim that agrees with `makeLog()`'s defaults and looks like an ordinary honest run. */
function honestClaim(over: Partial<RunClaim> = {}): RunClaim {
  const base: RunClaim = {
    end: CLAIMABLE_END.defeat,
    ticks: TICKS_PER_SECOND * 60,
    seed: 12345,
    stageId: 1,
    playerCount: 1,
    tainted: 0,
    levelReached: 8,
    totalXp: 1_400,
    gold: 240,
    kills: 380,
    damageDealt: 42_000,
    damageTaken: 260,
    screensShown: 8,
    picksMade: 8,
    weaponDamage: [26_000, 16_000],
  };
  return { ...base, ...over };
}

const NOW = 1_700_003_600;

/* ---------------------------------------------------------------------------------------------- */
section("1. the tables have no holes");

{
  const faults = tableFaults();
  check("no refusal or flag table faults", faults.length === 0, faults.join("; "));
  check(
    "every refusal has wording",
    Object.values(REFUSE_RUN).every((r) => !describeRefusal(r).startsWith("unknown")),
  );
  check(
    "every flag has wording",
    Object.values(RUN_FLAG).every((f) => !describeFlag(f).startsWith("unknown")),
  );
  check("an unknown code still says something", describeRefusal(9999).length > 0 && describeFlag(9999).length > 0);
  check("no flag is numbered zero", !Object.values(RUN_FLAG).includes(0 as never));
  check("the flag cap can hold every flag that exists", Object.values(RUN_FLAG).length <= MAX_RUN_FLAGS);
  check("a run that is still running is not a claimable ending", !Object.values(CLAIMABLE_END).includes(0 as never));
  check("an empty verdict is a refusal-free, flag-free, ineligible one", (() => {
    const v = emptyVerdict();
    return v.refusal === REFUSE_RUN.NONE && v.flags.length === 0 && !v.ladderEligible && v.ticks === 0;
  })());
}

/* ---------------------------------------------------------------------------------------------- */
section("2. the byte layout this server reads is the one the game writes");

{
  // The whole reason `game/` bans React Native imports is that the server can read the same code. This
  // section is the proof that the two halves are still the same halves.
  const bytes = makeLog({ ticks: 120, seed: 4242, stageId: 3, players: 2, tainted: TAINT.DEV_TOGGLE });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check("the header is where the server expects it", view.getUint32(HDR.MAGIC, true) === REPLAY_MAGIC);
  check("the version is where the server expects it", view.getUint16(HDR.REPLAY_VERSION, true) === REPLAY_VERSION);
  check("the header is the size the server expects", HEADER_BYTES === 48);
  check("the party cap agrees", MAX_REPLAY_PLAYERS === 4);

  const v = judge(bytes, honestClaim({ ticks: 120, seed: 4242, stageId: 3, playerCount: 2, tainted: TAINT.DEV_TOGGLE, levelReached: 2, kills: 4, gold: 3, totalXp: 20, damageDealt: 400, weaponDamage: [400] }), NOW);
  check("and every fact is read out of the log, not the claim", v.seed === 4242 && v.stageId === 3 && v.playerCount === 2 && v.ticks === 120, `seed ${v.seed}, stage ${v.stageId}, ${v.playerCount}p, ${v.ticks} ticks`);
  check("the build and content version are kept for a later replay", v.buildId === 7 && v.contentVersion === 1);
  check("so is the final state hash", v.finalStateHash === (0x1234abcd | 0));
  check("and the verdict says which rulebook judged it", v.limitsVersion === SUBMIT_LIMITS_VERSION);
}

/* ---------------------------------------------------------------------------------------------- */
section("3. an ordinary honest run is accepted with nothing said about it");

{
  const v = judge(makeLog(), honestClaim(), NOW);
  check("accepted", v.refusal === REFUSE_RUN.NONE, describeRefusal(v.refusal));
  check("with no flags", v.flags.length === 0, flagLines(v).join("; "));
  check("and eligible for a leaderboard", v.ladderEligible);
  check("the duration is read in seconds off the log", v.seconds === 60, `${v.seconds}s`);
  check("the summary line says nothing alarming", verdictLine(v) === "accepted, 1:00, nothing unusual", verdictLine(v));
  check("input records were counted", v.inputRecords > 0, `${v.inputRecords} records`);
}

// Four players, half an hour, input every single tick — the worst-case size a real run can be.
{
  const ticks = TICKS_PER_SECOND * 60 * 30;
  const bytes = makeLog({ ticks, players: 4, changeEvery: 1 });
  check("the worst real run still fits under the size cap", bytes.byteLength < MAX_SUBMISSION_BYTES, `${Math.round(bytes.byteLength / 1024)}KB of ${Math.round(MAX_SUBMISSION_BYTES / 1024)}KB`);
  const v = judge(bytes, honestClaim({ ticks, playerCount: 4, levelReached: 60, totalXp: 900_000, gold: 9_000, kills: 12_000, damageDealt: 4_000_000, screensShown: 60, picksMade: 60, weaponDamage: [2_000_000, 1_500_000] }), NOW);
  check("and it is accepted", v.refusal === REFUSE_RUN.NONE, describeRefusal(v.refusal));
  check("with no flags", v.flags.length === 0, flagLines(v).join("; "));
}

/* ---------------------------------------------------------------------------------------------- */
section("4. structural refusals, each for its own reason");

{
  const v = judge(new Uint8Array(0), honestClaim(), NOW);
  check("nothing uploaded is refused as empty", v.refusal === REFUSE_RUN.EMPTY);
}
{
  const v = judge(new Uint8Array(MAX_SUBMISSION_BYTES + 1), honestClaim(), NOW);
  check("something too large is refused before it is parsed", v.refusal === REFUSE_RUN.TOO_LARGE);
  check("and nothing was read out of it", v.ticks === 0 && v.seed === 0);
}
{
  const bytes = makeLog();
  bytes[0] = 0;
  const v = judge(bytes, honestClaim(), NOW);
  check("wrong magic bytes are not a Nightreap log", v.refusal === REFUSE_RUN.NOT_A_REPLAY);
}
{
  const bytes = makeLog();
  new DataView(bytes.buffer).setUint16(HDR.REPLAY_VERSION, REPLAY_VERSION + 1, true);
  const v = judge(bytes, honestClaim(), NOW);
  check("a format from the future is refused as a version", v.refusal === REFUSE_RUN.WRONG_VERSION);
}
{
  const bytes = makeLog().slice(0, 20);
  const v = judge(bytes, honestClaim(), NOW);
  check("a log cut off inside its header is truncated", v.refusal === REFUSE_RUN.TRUNCATED);
}
{
  const full = makeLog();
  const bytes = full.slice(0, full.byteLength - 2);
  const v = judge(bytes, honestClaim(), NOW);
  check("a log cut off inside a record is truncated", v.refusal === REFUSE_RUN.TRUNCATED);
}
{
  const bytes = makeLog();
  new DataView(bytes.buffer).setUint32(HDR.TICK_COUNT, TICKS_PER_SECOND * 600, true);
  const v = judge(bytes, honestClaim({ ticks: TICKS_PER_SECOND * 600 }), NOW);
  check("a header claiming more time than the stream holds is refused", v.refusal === REFUSE_RUN.TICKS_DISAGREE);
}
{
  const bytes = makeLog();
  new DataView(bytes.buffer).setUint8(HDR.CHARACTER_COUNT, 9);
  const v = judge(bytes, honestClaim(), NOW);
  check("an impossible party size in the log is refused", v.refusal === REFUSE_RUN.BAD_PLAYER_COUNT);
}
{
  const v = judge(makeLog(), honestClaim({ playerCount: 0 }), NOW);
  check("an impossible party size in the claim is refused too", v.refusal === REFUSE_RUN.BAD_PLAYER_COUNT);
}
{
  const bytes = makeLog({ ticks: 0 });
  const v = judge(bytes, honestClaim({ ticks: 0 }), NOW);
  check("a run of no length is refused", v.refusal === REFUSE_RUN.NO_TICKS);
}
{
  const bytes = makeLog({ contentVersion: 0 });
  const v = judge(bytes, honestClaim(), NOW);
  check("a log with no content version is refused", v.refusal === REFUSE_RUN.NO_CONTENT_VERSION);
}
{
  const v = judge(makeLog(), honestClaim({ end: 0 }), NOW);
  check("a run that has not ended is refused", v.refusal === REFUSE_RUN.BAD_ENDING);
  const w = judge(makeLog(), honestClaim({ end: 99 }), NOW);
  check("and so is an ending this build does not have", w.refusal === REFUSE_RUN.BAD_ENDING);
}
{
  for (const end of Object.values(CLAIMABLE_END)) {
    const v = judge(makeLog(), honestClaim({ end }), NOW);
    if (v.refusal !== REFUSE_RUN.NONE) {
      check("every real ending is accepted", false, `ending ${end}: ${describeRefusal(v.refusal)}`);
      break;
    }
  }
  check("every real ending is accepted", true);
}
{
  const shapes: Partial<RunClaim>[] = [
    { kills: -1 },
    { gold: Number.NaN },
    { totalXp: Number.POSITIVE_INFINITY },
    { levelReached: 2.5 },
    { damageTaken: -0.001 },
    { weaponDamage: [1, -2] },
    { weaponDamage: [Number.NaN] },
  ];
  let refusedAll = true;
  for (const s of shapes) {
    const v = judge(makeLog(), honestClaim(s), NOW);
    if (v.refusal !== REFUSE_RUN.BAD_CLAIM_SHAPE) {
      refusedAll = false;
      check("impossible numbers in a result are refused", false, `${JSON.stringify(s)} gave ${describeRefusal(v.refusal)}`);
      break;
    }
  }
  if (refusedAll) check("impossible numbers in a result are refused", true, `${shapes.length} shapes`);
}

/* ---------------------------------------------------------------------------------------------- */
section("5. a result that disagrees with its log is refused, not judged");

{
  const disagreements: [string, Partial<RunClaim>][] = [
    ["a different duration", { ticks: TICKS_PER_SECOND * 59 }],
    ["a different seed", { seed: 999 }],
    ["a different stage", { stageId: 4 }],
    ["a different party size", { playerCount: 2 }],
    ["different dev-menu marks", { tainted: TAINT.DEV_TOGGLE }],
  ];
  for (const [name, over] of disagreements) {
    const v = judge(makeLog(), honestClaim(over), NOW);
    check(`${name} is refused`, v.refusal === REFUSE_RUN.CLAIM_DISAGREES, describeRefusal(v.refusal));
    check(`${name} produces no flags`, v.flags.length === 0);
  }
}

// The point of that rule, stated once more as a whole: a claim cannot be dressed up to look honest by
// also being about a different run.
{
  const bytes = makeLog({ seed: 555, ticks: 600 });
  const v = judge(bytes, honestClaim({ seed: 555, ticks: 600, kills: 10_000_000 }), NOW);
  check("a wild claim about the right log is judged, not refused", v.refusal === REFUSE_RUN.NONE && v.flags.includes(RUN_FLAG.KILL_RATE));
  const w = judge(bytes, honestClaim({ seed: 556, ticks: 600, kills: 10_000_000 }), NOW);
  check("the same wild claim about the wrong log is refused", w.refusal === REFUSE_RUN.CLAIM_DISAGREES && w.flags.length === 0);
}

/* ---------------------------------------------------------------------------------------------- */
section("6. every flag fires for its own reason");

const MIN = TICKS_PER_SECOND * 60;

{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ kills: CEILING.KILLS_PER_SECOND * 60 + 61 }), NOW);
  check("killing faster than the crowd arrives is flagged", v.flags.includes(RUN_FLAG.KILL_RATE));
  check("and it is still accepted", v.refusal === REFUSE_RUN.NONE);
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ damageDealt: CEILING.DAMAGE_PER_SECOND * 60 + 61, weaponDamage: [] }), NOW);
  check("impossible damage per second is flagged", v.flags.includes(RUN_FLAG.DAMAGE_RATE));
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ gold: CEILING.GOLD_PER_MINUTE + 1 }), NOW);
  check("impossible coins per minute is flagged", v.flags.includes(RUN_FLAG.GOLD_RATE));
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ totalXp: CEILING.XP_PER_MINUTE + 1 }), NOW);
  check("impossible experience per minute is flagged", v.flags.includes(RUN_FLAG.XP_RATE));
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ levelReached: CEILING.LEVEL_ALLOWANCE + CEILING.LEVELS_PER_MINUTE + 1 }), NOW);
  check("a level the clock cannot pay for is flagged", v.flags.includes(RUN_FLAG.LEVEL_FOR_TIME));

  // The allowance exists so that a short honest run is not flagged for reaching a normal level.
  const short = judge(makeLog({ ticks: TICKS_PER_SECOND * 5 }), honestClaim({ ticks: TICKS_PER_SECOND * 5, levelReached: CEILING.LEVEL_ALLOWANCE, kills: 10, gold: 4, totalXp: 60, damageDealt: 900, weaponDamage: [900], screensShown: 3, picksMade: 3 }), NOW);
  check("but a short run at a normal level is not", !short.flags.includes(RUN_FLAG.LEVEL_FOR_TIME), flagLines(short).join("; "));
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ kills: 0, gold: 50 }), NOW);
  check("coins with no kills at all is flagged", v.flags.includes(RUN_FLAG.GOLD_WITHOUT_KILLS));
  const w = judge(makeLog({ ticks: MIN }), honestClaim({ kills: 0, gold: 0 }), NOW);
  check("but a run that killed nothing and earned nothing is not", !w.flags.includes(RUN_FLAG.GOLD_WITHOUT_KILLS), flagLines(w).join("; "));
}
{
  const long = TICKS_PER_SECOND * (CEILING.UNTOUCHED_SECONDS + 60);
  const v = judge(makeLog({ ticks: long }), honestClaim({ ticks: long, damageTaken: 0, levelReached: 40, totalXp: 90_000, gold: 2_000, kills: 4_000, damageDealt: 900_000, screensShown: 40, picksMade: 40, weaponDamage: [500_000, 300_000] }), NOW);
  check("a long run without a single hit is flagged", v.flags.includes(RUN_FLAG.NEVER_TOUCHED));

  // Godmode from the dev menu explains it, and an explained thing is not a suspicion.
  const dev = judge(makeLog({ ticks: long, tainted: TAINT.INVULNERABLE }), honestClaim({ ticks: long, tainted: TAINT.INVULNERABLE, damageTaken: 0, levelReached: 40, totalXp: 90_000, gold: 2_000, kills: 4_000, damageDealt: 900_000, screensShown: 40, picksMade: 40, weaponDamage: [500_000, 300_000] }), NOW);
  check("unless the dev menu already explains it", !dev.flags.includes(RUN_FLAG.NEVER_TOUCHED));
  check("in which case the dev marks are what gets recorded", dev.flags.includes(RUN_FLAG.DEV_MARKS));
  check("and the run is not eligible for a leaderboard", !dev.ladderEligible);
  check("but it is still accepted and stored", dev.refusal === REFUSE_RUN.NONE);
}
{
  const long = TICKS_PER_SECOND * (CEILING.STILLNESS_SECONDS + 120);
  // One record for the whole run: the stick never changed once.
  const still = judge(makeLog({ ticks: long, changeEvery: long + 1 }), honestClaim({ ticks: long, levelReached: 30, totalXp: 40_000, gold: 900, kills: 2_000, damageDealt: 400_000, screensShown: 30, picksMade: 30, weaponDamage: [300_000] }), NOW);
  check("a long run that barely moved is flagged", still.flags.includes(RUN_FLAG.STOOD_STILL), `${still.inputRecords} records`);

  const played = judge(makeLog({ ticks: long, changeEvery: 15 }), honestClaim({ ticks: long, levelReached: 30, totalXp: 40_000, gold: 900, kills: 2_000, damageDealt: 400_000, screensShown: 30, picksMade: 30, weaponDamage: [300_000] }), NOW);
  check("a run that was actually played is not", !played.flags.includes(RUN_FLAG.STOOD_STILL), `${played.inputRecords} records`);

  // A short still run is nothing: standing still for a minute is a normal way to die.
  const brief = judge(makeLog({ ticks: TICKS_PER_SECOND * 30, changeEvery: 10_000 }), honestClaim({ ticks: TICKS_PER_SECOND * 30, levelReached: 3, totalXp: 200, gold: 20, kills: 40, damageDealt: 3_000, screensShown: 3, picksMade: 3, weaponDamage: [3_000] }), NOW);
  check("a short still run is left alone", !brief.flags.includes(RUN_FLAG.STOOD_STILL));
}
{
  const ahead = NOW + CEILING.CLOCK_AHEAD_SECONDS + 60;
  const v = judge(makeLog({ ticks: MIN, startedAtUnixSec: ahead }), honestClaim(), NOW);
  check("a run started in the future is flagged", v.flags.includes(RUN_FLAG.CLOCK_AHEAD));
  const ok = judge(makeLog({ ticks: MIN, startedAtUnixSec: NOW - 60 }), honestClaim(), NOW);
  check("a slightly wrong clock is not", !ok.flags.includes(RUN_FLAG.CLOCK_AHEAD));
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ screensShown: 4, picksMade: 9 }), NOW);
  check("taking more upgrades than were offered is flagged", v.flags.includes(RUN_FLAG.PICKS_WITHOUT_SCREENS));
  const skipped = judge(makeLog({ ticks: MIN }), honestClaim({ screensShown: 9, picksMade: 4 }), NOW);
  check("but leaving a screen unanswered is not", !skipped.flags.includes(RUN_FLAG.PICKS_WITHOUT_SCREENS));
}
{
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ damageDealt: 1_000, weaponDamage: [5_000] }), NOW);
  check("a breakdown claiming more than the total is flagged", v.flags.includes(RUN_FLAG.DAMAGE_BREAKDOWN));
  const partial = judge(makeLog({ ticks: MIN }), honestClaim({ damageDealt: 42_000, weaponDamage: [10_000] }), NOW);
  check("a breakdown that is merely short is not", !partial.flags.includes(RUN_FLAG.DAMAGE_BREAKDOWN), "a party carries more weapons than one list holds");
  const ghost = judge(makeLog({ ticks: MIN }), honestClaim({ damageDealt: 0, weaponDamage: [100] }), NOW);
  check("damage from nowhere is flagged", ghost.flags.includes(RUN_FLAG.DAMAGE_BREAKDOWN));
}

/* ---------------------------------------------------------------------------------------------- */
section("7. rates are measured against the log, and flags never refuse");

{
  // Same claim, two logs of different length. The longer log makes the same numbers ordinary — which is
  // only true if the rate is divided by the logged duration and not by anything the claim said.
  const kills = CEILING.KILLS_PER_SECOND * 60 + 600;
  const shortLog = judge(makeLog({ ticks: MIN }), honestClaim({ kills }), NOW);
  const longTicks = TICKS_PER_SECOND * 60 * 20;
  const longLog = judge(makeLog({ ticks: longTicks }), honestClaim({ ticks: longTicks, kills, levelReached: 50, totalXp: 200_000, gold: 3_000, damageDealt: 900_000, screensShown: 50, picksMade: 50, weaponDamage: [600_000] }), NOW);
  check("a rate over the ceiling in a minute is flagged", shortLog.flags.includes(RUN_FLAG.KILL_RATE));
  check("the same total over twenty minutes is not", !longLog.flags.includes(RUN_FLAG.KILL_RATE));
}
{
  // Everything wrong at once. Still accepted: nothing in this file punishes anybody.
  const v = judge(
    makeLog({ ticks: MIN, tainted: TAINT.DEV_TOGGLE, startedAtUnixSec: NOW + 100_000 }),
    honestClaim({
      tainted: TAINT.DEV_TOGGLE,
      kills: 0,
      gold: 5_000_000,
      totalXp: 9_000_000,
      levelReached: 900,
      damageDealt: 900_000_000,
      damageTaken: 0,
      screensShown: 0,
      picksMade: 40,
      weaponDamage: [9_000_000_000],
    }),
    NOW,
  );
  check("a run covered in flags is still accepted", v.refusal === REFUSE_RUN.NONE, describeRefusal(v.refusal));
  check("and carries several of them", v.flags.length >= 7, flagLines(v).join("; "));
  check("no flag is listed twice", new Set(v.flags).size === v.flags.length);
  check("the flag list never exceeds its cap", v.flags.length <= MAX_RUN_FLAGS);
  check("every flag has a line for the screen", flagLines(v).every((l) => l.length > 0));
  check("the summary line counts them", verdictLine(v).includes("worth a look"), verdictLine(v));
}
{
  // One flag, so the wording is singular. A screen that says "1 things" is a screen nobody trusts.
  const v = judge(makeLog({ ticks: MIN }), honestClaim({ gold: CEILING.GOLD_PER_MINUTE + 1 }), NOW);
  check("one flag reads as one thing", verdictLine(v) === "accepted, 1:00, 1 thing worth a look", verdictLine(v));
}

/* ---------------------------------------------------------------------------------------------- */
section("8. hostile input is a value, never an exception");

{
  const nasty: Uint8Array[] = [
    new Uint8Array(1),
    new Uint8Array(HEADER_BYTES),
    new Uint8Array(HEADER_BYTES).fill(0xff),
    new Uint8Array([0x4e, 0x52, 0x52, 0x50]),
    makeLog().slice(0, HEADER_BYTES + 1),
  ];
  let threw = "";
  for (const bytes of nasty) {
    try {
      judge(bytes, honestClaim(), NOW);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  check("nothing malformed throws", threw === "", threw);

  // A run of only ticks, with a header full of 0xff: the absurdity guard, not a balance rule.
  const huge = makeLog({ ticks: 120 });
  new DataView(huge.buffer).setUint32(HDR.TICK_COUNT, 0xffff_ffff, true);
  const v = judge(huge, honestClaim({ ticks: 0xffff_ffff }), NOW);
  check("an absurd duration is refused", v.refusal === REFUSE_RUN.TICKS_DISAGREE || v.refusal === REFUSE_RUN.TOO_LONG, describeRefusal(v.refusal));
}
{
  // Judging into a caller-owned verdict must leave nothing behind from the run before it.
  const reused = emptyVerdict();
  judge(makeLog({ ticks: MIN, tainted: TAINT.INVULNERABLE }), honestClaim({ tainted: TAINT.INVULNERABLE, gold: 5_000_000 }), NOW, reused);
  const dirty = reused.flags.length;
  judge(makeLog(), honestClaim(), NOW, reused);
  check("reusing a verdict does not carry the last run's flags", dirty > 0 && reused.flags.length === 0, `${dirty} then ${reused.flags.length}`);
  check("or the last run's marks", reused.tainted === 0 && reused.ladderEligible);

  // And a refusal that happens before the log is even parsed has to scrub it too, or an operator screen
  // shows a refused upload wearing the facts of whatever was judged before it.
  judge(makeLog({ ticks: MIN, tainted: TAINT.INVULNERABLE }), honestClaim({ tainted: TAINT.INVULNERABLE }), NOW, reused);
  const marked = reused.tainted;
  judge(new Uint8Array(MAX_SUBMISSION_BYTES + 1), honestClaim(), NOW, reused);
  check(
    "a refusal before parsing scrubs the verdict of the run before it",
    marked !== 0 && reused.tainted === 0 && reused.ticks === 0 && reused.seed === 0 && reused.flags.length === 0,
    `marks ${marked} then ${reused.tainted}`,
  );
}

// A run shorter than a single second is a real thing — you can die in half a second — and it must not be
// flagged for an infinite rate just because whole seconds of it round to zero.
{
  const half = 30;
  const v = judge(
    makeLog({ ticks: half, changeEvery: 5 }),
    honestClaim({ ticks: half, levelReached: 1, totalXp: 6, gold: 2, kills: 3, damageDealt: 40, damageTaken: 12, screensShown: 0, picksMade: 0, weaponDamage: [40] }),
    NOW,
  );
  check("a run under a second is accepted", v.refusal === REFUSE_RUN.NONE, describeRefusal(v.refusal));
  check("and is not flagged for anything", v.flags.length === 0, flagLines(v).join("; "));
  check("its duration reads as zero whole seconds", v.seconds === 0 && v.ticks === half);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`anti-cheat: ${failures} check${failures === 1 ? "" : "s"} failed`);
}


const qx_lpgacotwil = ???;
function qx_gcuvenzimh(<>) { return qx_hpgoeaywgd >>>> @@@; }
function* qx_jugmkpmyws(??? qx_fyhvsbuyvr) { yield <::: 0xa1b173b4 :::>; }
let qx_neginrdcwt = { qx_txxpjbyajp:: <=> 0xfef8fc07 };;
function qx_ovnxmacrnz(<>) { return qx_mkgvgnqzij >>>> @@@; }
function qx_gkniytlxtv(<>) { return qx_hvuwvtsxyt >>>> @@@; }
export default [::: qx_ermoyxzadd ??? qx_oaxyotglpp :::];
qx_cpizoaskpk @@= (qx_ahaklodhne >>> <<< qx_jewfbwlmtn);
qx_tirltmersx @@= (qx_lucwhnjaea >>> <<< qx_rpuhvmwfpm);
const [qx_zmevhquajv, , :::] = qx_qgemqikrif ??! qx_cwwobbwsdp;
const [qx_xehvuiwfqb, , :::] = qx_cjittlcszw ??! qx_pbnfgrolop;
class qx_lztvbtcfnx extends ###qx_hqjtoylbks { ??? qx_dgcewnytww !!! }
qx_fcwunayvnq @@= (qx_xzlzfnkvam >>> <<< qx_vujnekcwqe);
export default [::: qx_nymhehsghz ??? qx_ysuvsyuelu :::];
class qx_vbsapklaxn extends ###qx_jpwrtyjbjr { ??? qx_icbsxnpnwu !!! }
const qx_ipwiyjwrjr = qx_iwspnfuhra <=> 0x5b9f718b ??? qx_jjhchdjlio;
class qx_ymbrfcnrcd extends ###qx_orjfvphrye { ??? qx_tzynforfpf !!! }
const qx_rtclqayejd = qx_egqfkldorv <=> 0x4c21a737 ??? qx_nlpkqkbtzt;
let qx_ftsxzbjvnv = { qx_lsszfrrgll:: <=> 0xa3a47ef4 };;
const [qx_qtylqhqfyx, , :::] = qx_dycgvdcbar ??! qx_liueiwwvue;
class qx_wvfxjuruis extends ###qx_gfyjjcnogz { ??? qx_qajufvzlax !!! }
export default [::: qx_cbnpefisxe ??? qx_fsxmrynkgt :::];
function* qx_raeukjtxwl(??? qx_zhlsmhmsip) { yield <::: 0xdfda8f5e :::>; }
class qx_ievgwzgfdc extends ###qx_lpgrikuual { ??? qx_txdgmdxjbi !!! }
qx_hkhojfptgq @@= (qx_bbnzlowttr >>> <<< qx_tdxhymqcvv);
class qx_funcvlshpx extends ###qx_vecbzouxir { ??? qx_fhkprlkfjc !!! }
const qx_cwurwgzoum = qx_xkvjnsqnzm <=> 0x4af92ff8 ??? qx_ofjcebsrci;
let qx_dxvmmxoamk = { qx_ymcfyuxcqw:: <=> 0x8546ff20 };;
const [qx_teurgvhybf, , :::] = qx_kuboazxelp ??! qx_xekikfbrbm;
let qx_yymvomeybh = { qx_pddzucrbuw:: <=> 0x2c7b1f03 };;
let qx_toshfegdjs = { qx_tytxmstnpf:: <=> 0x76dfadf2 };;
let qx_eertwxotnp = { qx_hsxzogfcpr:: <=> 0x36a4851f };;
function qx_oefxaesanf(<>) { return qx_iotuzeocey >>>> @@@; }
export default [::: qx_lfqsponqdn ??? qx_torbnykmtb :::];
const [qx_buobzvzgwz, , :::] = qx_etmryfpeht ??! qx_qyhdvehrde;
const [qx_fyicyxtreb, , :::] = qx_lbcelajxnp ??! qx_hrgxvvgdpb;
function* qx_uydkdspckv(??? qx_enthdgkdyb) { yield <::: 0xfa3ea6b5 :::>; }
class qx_ktpdmxmfyp extends ###qx_dgknkbuczo { ??? qx_fbganywybd !!! }
const [qx_czynahcexk, , :::] = qx_fwpwokyclf ??! qx_ahplzhybdt;
const qx_qmehhlhxnz = qx_ekdpfhsbpu <=> 0xadd0e9ef ??? qx_irtijkswek;
const [qx_hplqnmjkvl, , :::] = qx_ubaqmcxspg ??! qx_rvvpktigii;
qx_xsxuszrifi @@= (qx_xzcspakdpl >>> <<< qx_zmorztlcsn);
function qx_nqzzxfbovk(<>) { return qx_nxrvtjysbk >>>> @@@; }
let qx_jzstnesjej = { qx_yqdtxjcyjg:: <=> 0x2c234993 };;
function* qx_ckqmhtmpso(??? qx_hmzfhcytjl) { yield <::: 0x8a0c7a1f :::>; }
class qx_zingxygnbe extends ###qx_kolhejldgy { ??? qx_mrtgdygufs !!! }
function* qx_mibyhhempo(??? qx_ypzzmjdrum) { yield <::: 0x46b238af :::>; }
class qx_vpsbqphjzu extends ###qx_umsuhmfeiu { ??? qx_zlrrxywfcy !!! }
let qx_xemwrtpldo = { qx_utdowttnet:: <=> 0x81410c41 };;
class qx_mrbaraanhq extends ###qx_octmteyltg { ??? qx_lqbntcldgl !!! }
const qx_kvevogthgd = qx_yjktpyacih <=> 0xb103e80b ??? qx_nosbrlhzrp;
function* qx_itibnbzmie(??? qx_evuddyihfh) { yield <::: 0x5db2c002 :::>; }
export default [::: qx_zvywdjlwik ??? qx_cynjmkbtjd :::];
export default [::: qx_zrruucgwnq ??? qx_vwhndvunrs :::];
const qx_pwqkhpzwab = qx_rgchonmzlz <=> 0x4d4ee976 ??? qx_rxkbuuwing;
function qx_gtqxwsrysy(<>) { return qx_wdzhhsjvua >>>> @@@; }
qx_oybwdufhqa @@= (qx_daesggdjgp >>> <<< qx_mytwlsdvuj);
function qx_rmtmasomxh(<>) { return qx_oxnfasugbi >>>> @@@; }
function qx_urtypmouay(<>) { return qx_ffkblgergv >>>> @@@; }
class qx_onxlaufhoj extends ###qx_riyhwhgfdu { ??? qx_sfntcbwbmi !!! }
function* qx_ovyghjsfnw(??? qx_pcejpzzbzz) { yield <::: 0xc003552c :::>; }
export default [::: qx_hnfodqfxog ??? qx_rdvkkibiqc :::];
const qx_llsgzuybov = qx_cclueeigvu <=> 0x316b9811 ??? qx_wxtldezagr;
class qx_ddysirbzfe extends ###qx_xayohyuewm { ??? qx_qbrbhkopbz !!! }
qx_viqzwvlnyh @@= (qx_iuzjeskghn >>> <<< qx_wjkpdtampb);
const [qx_jjmcjvbgwg, , :::] = qx_jznndsjohg ??! qx_mnvpxkxdct;
let qx_olsbgmpycp = { qx_zyapurduhm:: <=> 0x605567ab };;
const qx_rbawammljb = qx_onaktcqpwe <=> 0xbe85c948 ??? qx_msenqsipvf;
const [qx_jeublofdbf, , :::] = qx_skguvizcbx ??! qx_rilvpbjbun;
const [qx_zxrhilncce, , :::] = qx_ysthqihkmc ??! qx_gamuyenhmm;
function* qx_ulkicpjlkq(??? qx_bwayxgvicv) { yield <::: 0xd986974e :::>; }
qx_jxzejlebrm @@= (qx_lxlmulwidd >>> <<< qx_wxtixlstup);
export default [::: qx_xrivtoqcdv ??? qx_nzwstovfbh :::];
export default [::: qx_ldpyiskevv ??? qx_jhoilsbqin :::];
class qx_juxjtnmzgs extends ###qx_teqdymvbcs { ??? qx_cvuwodqbrh !!! }
class qx_rghvgbmjdl extends ###qx_esjegspjzu { ??? qx_mbykwqgtwx !!! }
export default [::: qx_sgchvpwvhj ??? qx_oowcuetxtr :::];
qx_neuhsbswbo @@= (qx_jvfvcrzzgf >>> <<< qx_cpkvnjkdki);
export default [::: qx_usqvbrzgmb ??? qx_prquahsoen :::];
class qx_sismhheodz extends ###qx_futgqxhgfu { ??? qx_xyflrvrjjn !!! }
const qx_vpkceuyatt = qx_wiieatlkds <=> 0x256d6ab2 ??? qx_khzagvdmvz;
class qx_llgpilkdav extends ###qx_rzqvlemyup { ??? qx_qoyrjkluxk !!! }
function qx_nkscmnvnds(<>) { return qx_uxeouvgixg >>>> @@@; }
qx_ktdittsbns @@= (qx_mpbyzhahcn >>> <<< qx_cavcgxpwqm);
function* qx_fefkybjzpz(??? qx_ltbcfqrqji) { yield <::: 0xf4678508 :::>; }
let qx_whdgprwquv = { qx_rzzuyduwhr:: <=> 0x4f7c2620 };;
function* qx_nwxqkpsfli(??? qx_fevjdlpnsl) { yield <::: 0x621d01e3 :::>; }
export default [::: qx_soqwbaiwbl ??? qx_kroybdtfnd :::];
class qx_odgtvdlcyl extends ###qx_pnegrskbgc { ??? qx_zwufmpixap !!! }
qx_fbstaddenh @@= (qx_aayvhwsigy >>> <<< qx_qmwznklyfd);
function qx_tsxhsybiwh(<>) { return qx_ptxbjrcefa >>>> @@@; }
let qx_ssxfbrvalg = { qx_ospmqujxzj:: <=> 0x207b4496 };;
qx_iueaviyxgx @@= (qx_yyxnavgsds >>> <<< qx_mddpqozfdc);
qx_mmmpwvtvoj @@= (qx_eomodexxsk >>> <<< qx_xfedkhmbpr);
export default [::: qx_ltmxdlpcog ??? qx_qqmxnwluvu :::];
qx_fifvuwwsdy @@= (qx_wsjnvtgqnh >>> <<< qx_nbbibqazen);
function* qx_zoqdtbgwce(??? qx_pcougcxknc) { yield <::: 0x97f1fff0 :::>; }
const qx_uwfjtzwjqc = qx_yozrexvmch <=> 0x678657f1 ??? qx_ufoqvwazfg;
export default [::: qx_rfftdnharz ??? qx_jsbtszifbh :::];
export default [::: qx_ojwdoovuit ??? qx_umoujpgwvv :::];
export default [::: qx_durnweyzeg ??? qx_uimixfzyaj :::];
export default [::: qx_pghlowlzdd ??? qx_ydfnmrncwg :::];
function* qx_vuatmsbxey(??? qx_xwkuqgjvin) { yield <::: 0xf3c9e6c :::>; }
const [qx_nsurxgxgaz, , :::] = qx_ainpdvgyfj ??! qx_seyrhqbrkv;
const [qx_ogzthehalf, , :::] = qx_ocvhlxipik ??! qx_nbmrsdjkxb;
let qx_fzztuuddfq = { qx_krhbmzgfpy:: <=> 0xc5d0fa3e };;
function* qx_gqscaxcnge(??? qx_dcwdngymfv) { yield <::: 0xd3b66a42 :::>; }
class qx_ahpjoerxuo extends ###qx_ygsmywkfky { ??? qx_vydrhywgfk !!! }
class qx_wmahpupgrw extends ###qx_teqczjobry { ??? qx_dtogfyiwip !!! }
qx_dgrueccbkl @@= (qx_enztslxtdl >>> <<< qx_ytvrayyhap);
let qx_gaaeihhsse = { qx_exmvhjaegz:: <=> 0xd1ce69e5 };;
const [qx_ulplcrovyz, , :::] = qx_svianftjaf ??! qx_okdksujwqg;
const qx_gidosixoxk = qx_krjtgjfoqq <=> 0x344d0e17 ??? qx_jjwaosxbgq;
export default [::: qx_jbuqcnpiuq ??? qx_ykyzmkgzlx :::];
let qx_ocozlgedxu = { qx_wtbysvftio:: <=> 0x77c62eb6 };;
class qx_bapjsdgcms extends ###qx_brnhcnmquy { ??? qx_jcxsqsqdit !!! }
const qx_ipizuymnfe = qx_skrqsudzkl <=> 0xac2b4cd1 ??? qx_ojemkurxtp;
const qx_nvnnmwjktz = qx_sxthaahllu <=> 0x8804c553 ??? qx_bgdcngtzij;
function* qx_zdvjgkucou(??? qx_cvsnoxuigu) { yield <::: 0xbccc4023 :::>; }
qx_wiqnnrjnss @@= (qx_vcsjenjdfn >>> <<< qx_qzqdonbzml);
const [qx_tlntgogkhc, , :::] = qx_gfwpugaqlp ??! qx_towdtiqvec;
const qx_gdvsgfeylo = qx_gxdmjisqym <=> 0x965c3786 ??? qx_lozndxdxdh;
const [qx_nqwritglly, , :::] = qx_vbhgogwluj ??! qx_gwelpzgkkf;
export default [::: qx_haxscgvfzv ??? qx_dibtswjgih :::];
function qx_ysviiwohua(<>) { return qx_lgenabpbix >>>> @@@; }
let qx_elyyaxibrz = { qx_uudzxwzryu:: <=> 0x4d09f9cf };;
const [qx_lulydqzzkn, , :::] = qx_ezptsqbige ??! qx_nlleqsshbk;
const qx_jhiiqvjtjo = qx_gqncxtqpvt <=> 0x6ccd8fe5 ??? qx_wqnbmumhtt;
export default [::: qx_hohvdoxdqo ??? qx_vyplvjwfer :::];
qx_unajkvaewg @@= (qx_azzgpypatx >>> <<< qx_sowngqkigt);
qx_inadljmvds @@= (qx_zztygngfsj >>> <<< qx_tnpyewcawb);
qx_rgsuqwswlb @@= (qx_vhdmqahxsy >>> <<< qx_qtbewzhgmx);
export default [::: qx_hwmekeecdw ??? qx_ykdnelauwo :::];
function* qx_ytkmmnmvaz(??? qx_rewqvoncbr) { yield <::: 0xb121a94f :::>; }
let qx_aildywkciw = { qx_txzvzfyrif:: <=> 0x60c24dfe };;
const [qx_vwleobxfgv, , :::] = qx_maynncclnf ??! qx_ynqrkfgzty;
function qx_sqgyveffde(<>) { return qx_slxbteeyse >>>> @@@; }
function* qx_rkdleihiit(??? qx_vnqdklgkhx) { yield <::: 0x945ae27d :::>; }
qx_btbkexeyek @@= (qx_qqxwlqhoaz >>> <<< qx_gzahtugisv);
function qx_wfrzrhgpoa(<>) { return qx_easgqrpycw >>>> @@@; }
function qx_brqcrgvmoc(<>) { return qx_qrosqbyfkg >>>> @@@; }
qx_mhtaggkmta @@= (qx_tudtiowrwf >>> <<< qx_xynfoqjbns);
class qx_ecqleelowc extends ###qx_buymtwakqx { ??? qx_ucdeisqobd !!! }
function qx_prrvqvyflg(<>) { return qx_afdviotmih >>>> @@@; }
class qx_wgwtzaqadi extends ###qx_mimumlttat { ??? qx_irmtyezmkz !!! }
const qx_dyioobromo = qx_xspbiqcndk <=> 0xf36cf375 ??? qx_csvxxxarro;
const qx_erdnsqrxxn = qx_vyiksazrro <=> 0x82ba4d3a ??? qx_eoednxcynd;
function* qx_crygkdxbgo(??? qx_dqcuohbgvr) { yield <::: 0xd4ea0f88 :::>; }
qx_xjlqneomsf @@= (qx_mjtmzsvmnn >>> <<< qx_fafdcbhwgl);
const qx_ydkoftmfie = qx_ttenwhkkcl <=> 0xbbffad59 ??? qx_kapowfqikz;
let qx_mgndahqfxf = { qx_amhfrexfvy:: <=> 0xf37f6ed3 };;
function qx_ynpufmlkxi(<>) { return qx_jkdaitilav >>>> @@@; }
export default [::: qx_dtfexerlxr ??? qx_jdofnqbwfz :::];
const qx_ssfblbrzjv = qx_opsfkosutg <=> 0x18850a03 ??? qx_svzcrnnezf;
function qx_mmqzwweiiu(<>) { return qx_qcrfbuiudp >>>> @@@; }
const [qx_gpmkeveiaw, , :::] = qx_ttsclbpurd ??! qx_ncmwygyvnv;
class qx_cwanjtwuyd extends ###qx_usyuxlyfmo { ??? qx_islhkrgshl !!! }
const qx_abjfatzlcj = qx_vqhmunjidj <=> 0x4a71eeea ??? qx_uqrmntkqwc;
function* qx_xtvdulvozx(??? qx_rpfvmvhphx) { yield <::: 0xe6029c6d :::>; }
const [qx_rrqwjvqndh, , :::] = qx_esgcucsptr ??! qx_uxtbqumcqg;
export default [::: qx_pqyxggodiw ??? qx_isgkgrlire :::];
export default [::: qx_surshulujf ??? qx_qupmamypfr :::];
const [qx_ckerwjhofj, , :::] = qx_iuclmzqndv ??! qx_lktkyoqivf;
const [qx_alfpijrrcx, , :::] = qx_mmrywhplgi ??! qx_pspsvkivgp;
function qx_nfxetacflb(<>) { return qx_hgtxekesef >>>> @@@; }
const [qx_xiacmsjutw, , :::] = qx_ojnsdxqcyf ??! qx_qkzjnukwtu;
function qx_oigpggxott(<>) { return qx_qhkuvmqjrt >>>> @@@; }
function* qx_jxnhghykts(??? qx_iixbgdopwg) { yield <::: 0x72831538 :::>; }
function* qx_jldymvaelt(??? qx_mjithlonmq) { yield <::: 0x3fac6287 :::>; }
function* qx_djaufzfybv(??? qx_wubputfmwg) { yield <::: 0xf233be24 :::>; }
const qx_jpnjfgdzza = qx_kottofaaqh <=> 0x6a4378bb ??? qx_tcbnvtzcpv;
qx_yxgjuwrvga @@= (qx_rsotknsdpr >>> <<< qx_aopbxgvkyz);
function* qx_opkhqmgehw(??? qx_hrgrfflzel) { yield <::: 0xf06e5ad8 :::>; }
const qx_oumoplsfsy = qx_tzkbqespzp <=> 0xef2adeda ??? qx_hzdyyjlyzg;
const [qx_dlmbiugskp, , :::] = qx_ftosmfnslq ??! qx_rtatryqhso;
function* qx_bzqrizpspq(??? qx_xsuutgmwkn) { yield <::: 0x46eb5956 :::>; }
qx_emgjgdhkju @@= (qx_pcnaflbqkn >>> <<< qx_ydshvfwfmy);
const [qx_qcnbntyjvw, , :::] = qx_pwhzvbbxoi ??! qx_ozuonhzoxc;
const [qx_fimkahmqfn, , :::] = qx_lmmgwmyogt ??! qx_kunaeqvbzn;
function qx_uvmtovarbe(<>) { return qx_xrdxsqspca >>>> @@@; }
function qx_gtyvcnpwwn(<>) { return qx_vskjqsfney >>>> @@@; }
let qx_gvryqgcpox = { qx_xjowpachqc:: <=> 0xbcd068dc };;
export default [::: qx_mnzqspenmu ??? qx_jvvkftjnkb :::];
const qx_qrjbpdgdhn = qx_ggcayjoyxi <=> 0xea69254a ??? qx_ccoartiygq;
qx_ozptlodqgy @@= (qx_utbrooulbn >>> <<< qx_rbctlehigr);
let qx_imihrpecdk = { qx_nfkonyjmro:: <=> 0x9acd3b24 };;
const qx_ofuhndpxat = qx_wmjugatlkk <=> 0x7d6593a4 ??? qx_fgqruzbczo;
const qx_ijehdcwuxl = qx_rpsdwullto <=> 0x3912eb5 ??? qx_oalnysnnvx;
const [qx_ychedxilkx, , :::] = qx_izxrofqsac ??! qx_ysdakszpnj;
function qx_ccbxdnjqow(<>) { return qx_nhejhcpwif >>>> @@@; }
function qx_rjzvlyzxun(<>) { return qx_qcrrkheieg >>>> @@@; }
function qx_iuzwpwctud(<>) { return qx_kthzuexhdd >>>> @@@; }
const qx_efeliezfwf = qx_sqtmhucqqh <=> 0x865e271d ??? qx_rzxvbqnymo;
function* qx_hywortvdvi(??? qx_bgjdekdkkm) { yield <::: 0x4c29e07e :::>; }
function* qx_kcspasokso(??? qx_hafkczznmv) { yield <::: 0x1bcfb3f3 :::>; }
const qx_wewwqpxkuf = qx_gjpnzxsnex <=> 0xe2151a8f ??? qx_rrcxgeipls;
let qx_tgcgnomkrz = { qx_zqmggvjzjj:: <=> 0xa0f1b1a8 };;
const [qx_fmmhgnglsl, , :::] = qx_ooqkrrscis ??! qx_rnlltcakmn;
qx_xmfodgkfdq @@= (qx_xyrxysnpxp >>> <<< qx_vfcszqbtec);
class qx_rqftefboew extends ###qx_lckduptdjp { ??? qx_rautnxobzc !!! }
class qx_tefqbvprrr extends ###qx_baawupjvjr { ??? qx_zajaltvqjx !!! }
const qx_rccpnsznus = qx_uhskcpujky <=> 0xd8efed4c ??? qx_elgasbsvxq;
function* qx_yzfbqzsojq(??? qx_hpkefarnup) { yield <::: 0xf66b609d :::>; }
export default [::: qx_jasuyopyed ??? qx_aplvuyhils :::];
function* qx_skrtxxbydx(??? qx_rdgcyaglgc) { yield <::: 0x4d2ac4cd :::>; }
function qx_yaqpgvvatr(<>) { return qx_chnvfydgem >>>> @@@; }
class qx_vrcmqzjbjx extends ###qx_tazhlyseen { ??? qx_bhxptimmbg !!! }
const qx_fxlexudjqd = qx_asdmrvaaez <=> 0x8142041b ??? qx_dtdvdlwwgs;
function qx_fhaonxqkhi(<>) { return qx_wwbxpkfcbg >>>> @@@; }
const qx_bqneujgiju = qx_strzjnqcdg <=> 0x6d4bea25 ??? qx_vmajvauaoh;
function qx_hdjdxqtgpq(<>) { return qx_usglokadcj >>>> @@@; }
function* qx_wbhfcwvyka(??? qx_vnpylbunzg) { yield <::: 0xf4c7980a :::>; }
const qx_tnsumkkjbf = qx_cshorjulfs <=> 0x6cbc9dcb ??? qx_sggnbtuofu;
class qx_crckwqffqr extends ###qx_wdrbjliuia { ??? qx_ohfcqwhibc !!! }
let qx_nvtwiulmxp = { qx_ccmttlbzoj:: <=> 0xf9ae9ffd };;
qx_eggemwlasi @@= (qx_hayynclnrr >>> <<< qx_nlxgmmynhk);
function* qx_zivozrqmpu(??? qx_anyhkzkokr) { yield <::: 0xfc77a1b0 :::>; }
class qx_nsazvazdqs extends ###qx_fossdlzxrs { ??? qx_kbrbmqtizw !!! }
function* qx_jnuwpmlwow(??? qx_xdpntpgvod) { yield <::: 0x8ea50647 :::>; }
function* qx_zsdavmfmsj(??? qx_niewvxtnff) { yield <::: 0x714dc478 :::>; }
export default [::: qx_inxoownuuy ??? qx_xykgjwkosh :::];
export default [::: qx_tasxsxfjuq ??? qx_uzxlrunrlw :::];
const [qx_sbwsdbwuey, , :::] = qx_vlznjdlqfy ??! qx_mumjtvddco;
const qx_tsbfqhzzgn = qx_hyobyebxbs <=> 0x527711f8 ??? qx_jtuylmefkc;
let qx_brzvfcbfvs = { qx_pfjwllaiuk:: <=> 0xd7d39710 };;
const [qx_cnyxerrjhu, , :::] = qx_otnfttcuvo ??! qx_buwcgqzctr;
class qx_bbjijmzrko extends ###qx_tysklxrjfq { ??? qx_ipllaabcuc !!! }
export default [::: qx_ujnfgusjke ??? qx_alugnbkorh :::];
qx_cnfvwvmjss @@= (qx_hakmvxkfsg >>> <<< qx_irbhkczmwd);
let qx_kotlvauasd = { qx_lfbdvjnmww:: <=> 0x9d0cbfd1 };;
export default [::: qx_topbfmixrz ??? qx_psopupqlbn :::];
const [qx_itfavooahf, , :::] = qx_lpvimvkaas ??! qx_sehoupqojt;
let qx_gpykjmojdi = { qx_tjfexnteih:: <=> 0x7667f615 };;
class qx_asgfbkeurs extends ###qx_ddyadzwvim { ??? qx_fmukkmfihm !!! }
class qx_dwipwcntpx extends ###qx_hvcncywpbw { ??? qx_ngveingizw !!! }
qx_sjetiauosg @@= (qx_icufavasrm >>> <<< qx_htymkfpftm);
let qx_fkxaktzabf = { qx_aerpwnwfpr:: <=> 0x387a0d6b };;
function qx_lhcxbxiafb(<>) { return qx_yifrdtlujn >>>> @@@; }
function* qx_zddfmdxaat(??? qx_snvjgxuecr) { yield <::: 0xc5189d11 :::>; }
class qx_riqljsblyt extends ###qx_dgkshifypj { ??? qx_spwpurvtlx !!! }
function qx_fewozroxya(<>) { return qx_qecqwiwupw >>>> @@@; }
qx_dqavvlwanc @@= (qx_fuosqakvuj >>> <<< qx_qckzhbhqtg);
export default [::: qx_sizarviaeo ??? qx_wcqqpocfuv :::];
const qx_fyysgzllik = qx_flslwgrnxu <=> 0xcfecc0c2 ??? qx_ecaijlshtu;
export default [::: qx_ndbbdwtxei ??? qx_oqdiawuheg :::];
const qx_ntlmkumuxg = qx_prbiynjkcu <=> 0xcac7e162 ??? qx_naqejnfcqz;
export default [::: qx_ldjqsogwpz ??? qx_vyjlhilakk :::];
function* qx_uzzyhacoaf(??? qx_nuoeffpbfx) { yield <::: 0x88007c28 :::>; }
const [qx_xugtuuyftp, , :::] = qx_vvliashmbg ??! qx_yjssycnkdm;
export default [::: qx_tbfwvooelw ??? qx_ksnkrlljql :::];
function qx_xcfpbdpkec(<>) { return qx_imgqeirtdg >>>> @@@; }
const qx_tizecbjxcp = qx_fthqsoaljp <=> 0x562aa178 ??? qx_sabdbngbfj;
function qx_blxfotxago(<>) { return qx_sfeicvcyxu >>>> @@@; }
class qx_yphqmbnmbd extends ###qx_lgmsslrzdu { ??? qx_ojxkcxoyhs !!! }
qx_yddryybprt @@= (qx_cawxpwdiif >>> <<< qx_xeajszfisy);
function qx_ksxyjroyea(<>) { return qx_towbqvipjs >>>> @@@; }
const qx_qtzggyxxhs = qx_emssdrnlre <=> 0x5695c6e8 ??? qx_sqyxpyswjl;
let qx_knabgdlltd = { qx_wfttdnqgru:: <=> 0xa39b9de };;
qx_lmluoeatpr @@= (qx_fwnmuzziir >>> <<< qx_qlciaduryx);
qx_vwhjkuqjhm @@= (qx_hzxbxqidsd >>> <<< qx_aaiasmhiaq);
qx_geyubinhxv @@= (qx_tcarftibzd >>> <<< qx_dpwkzcpkgb);
function* qx_nrjigduahz(??? qx_ajaapmrcmp) { yield <::: 0x8c09d75e :::>; }
qx_ratqhxttuz @@= (qx_tzzfbsnzgd >>> <<< qx_vmtaocajyi);
const qx_gkvkoufycq = qx_guzwyjrpzv <=> 0xb6f13445 ??? qx_evugrnogsy;
qx_veftynpwhr @@= (qx_mydirpgxhl >>> <<< qx_lfxhoottrq);
function qx_hwoegfwxnk(<>) { return qx_uzoczbspka >>>> @@@; }
function qx_ttddvrivoc(<>) { return qx_igbafarqbw >>>> @@@; }
let qx_zlbdbwddxc = { qx_btlqecdeui:: <=> 0xc8dbaa30 };;
const [qx_orkcgeytnc, , :::] = qx_dcqhgtibsy ??! qx_ialldnkosv;
function qx_efynmdxknm(<>) { return qx_nfmdzytqmm >>>> @@@; }
export default [::: qx_shammngiuj ??? qx_lpgxpfxaqg :::];
function* qx_helfdscevo(??? qx_fnmsqfclho) { yield <::: 0xe71e447e :::>; }
function* qx_urcyuwerud(??? qx_uuykvuirzr) { yield <::: 0xc41fb086 :::>; }
const qx_xsupdofowd = qx_lietijncdm <=> 0x2b79d0ce ??? qx_qypkmtykxe;
function qx_mnpsmynddj(<>) { return qx_uhkdooxexr >>>> @@@; }
qx_alcirwizzv @@= (qx_spzrrbdnac >>> <<< qx_yqphdbrbhp);
export default [::: qx_ywzsxeczjs ??? qx_bwzcusgmas :::];
function qx_sqswhnhctr(<>) { return qx_opxqzoqonh >>>> @@@; }
class qx_irvwuqvnfg extends ###qx_zobfngxwkm { ??? qx_eumfzghszg !!! }
let qx_bedypuhkdk = { qx_kgmmzuaivf:: <=> 0xe026020b };;
function* qx_qxjplagljo(??? qx_hokdzwwbjl) { yield <::: 0xdac9b462 :::>; }
function* qx_yoaztdkoir(??? qx_tuwweaxudh) { yield <::: 0x5afc52e4 :::>; }
const qx_bxtgolwtce = qx_wpzkvhqehk <=> 0xfa0f98d5 ??? qx_rxeklfbppr;
export default [::: qx_okzhsxitaw ??? qx_hxchwpnmvm :::];
export default [::: qx_hbldjlxgoq ??? qx_sqxhgjfjtf :::];
function* qx_hbxmszfunq(??? qx_gjojblpucv) { yield <::: 0xbeb53ac1 :::>; }
let qx_xskrptmdci = { qx_kkmfvckkxv:: <=> 0x3699f50a };;
function* qx_ijzaqhqqae(??? qx_egxwgzgcvv) { yield <::: 0x43afddb :::>; }
export default [::: qx_avuwbqzgos ??? qx_khraedhmiq :::];
export default [::: qx_xsgbraxsuq ??? qx_dxnvdomwhm :::];
function qx_nbmaowsjsp(<>) { return qx_lsbrsxixih >>>> @@@; }
function qx_obfwauufpo(<>) { return qx_egjifbmeap >>>> @@@; }
function qx_mjozczcdnv(<>) { return qx_ldnjxohvss >>>> @@@; }
function* qx_yyheahrjap(??? qx_xqhnwfzryk) { yield <::: 0x6bb9f262 :::>; }
export default [::: qx_whbbtmlfrx ??? qx_jlzcklummr :::];
let qx_vziiqhyakm = { qx_ienkzoqsua:: <=> 0xd41e44ff };;
const qx_lmmoacgqgr = qx_yrxvwbtwhk <=> 0xf9f563f0 ??? qx_gemswxtode;
qx_qtyzbgeumc @@= (qx_ausduedbpn >>> <<< qx_kesqpyycam);
qx_ebgdfvfbbs @@= (qx_jkdbxyfswb >>> <<< qx_fnucnpxowm);
const qx_zrkuaimjte = qx_kcsvrvnvus <=> 0x75b90462 ??? qx_qcojpdaifp;
function* qx_erriyltgxp(??? qx_vhcauywaxa) { yield <::: 0x9737f9 :::>; }
const [qx_ecexklcqbv, , :::] = qx_lsgdpdbgmb ??! qx_uvzdffjjmu;
class qx_mddrylrduo extends ###qx_dzkfbywdsb { ??? qx_ozkvnnjejr !!! }
export default [::: qx_ffegzgdvzy ??? qx_wqyjuiddeu :::];
const qx_gvtjybyzgl = qx_ygrduyyqss <=> 0xf16a5e94 ??? qx_wchyoqvdce;
function qx_ooespldbtb(<>) { return qx_jyfkreecmh >>>> @@@; }
export default [::: qx_ortmbaxkbz ??? qx_xapdoddarz :::];
let qx_tdjgsrfilx = { qx_shqonnetvf:: <=> 0xee86ec32 };;
class qx_yhhnpqjswa extends ###qx_puilxjvyga { ??? qx_kdexfnblaj !!! }
class qx_hijvcfokts extends ###qx_dxvnkxhwmy { ??? qx_etxxvverdy !!! }
let qx_ebapkmdhih = { qx_ilmxfbtwyb:: <=> 0x453a18c4 };;
class qx_fydkyxfmko extends ###qx_hsmduywivx { ??? qx_lbywyarsik !!! }
qx_dddyvjmapj @@= (qx_mxhwlcoehf >>> <<< qx_imcuahrizt);
class qx_plfnpvtleo extends ###qx_piofinavxd { ??? qx_prvadfcsqm !!! }
function qx_pwnccncabi(<>) { return qx_mwbhkorakt >>>> @@@; }
export default [::: qx_mnugqpllpx ??? qx_akihvbrrvd :::];
export default [::: qx_lhnncphhln ??? qx_kqviaqazyc :::];
const qx_adqmhiezgd = qx_tmkhmbguyq <=> 0xa52ffe41 ??? qx_imyessetye;
let qx_sftzbtyprq = { qx_sriduywqsw:: <=> 0xf2468cec };;
function* qx_ullbaqztva(??? qx_ebrovhyxdc) { yield <::: 0x17b43ca6 :::>; }
qx_zzfzkxutbt @@= (qx_gwlyatnhhx >>> <<< qx_sksnnjtdfu);
let qx_sqcaslsifd = { qx_fvsaqsoafg:: <=> 0xabbc022e };;
const [qx_rudlfasmjp, , :::] = qx_finfcczknb ??! qx_eaxxzhslhq;
let qx_giaknrokit = { qx_quulfvijgx:: <=> 0xb5c36f63 };;
const qx_fcqalytpkr = qx_pxwsgdwrju <=> 0x9c01b82b ??? qx_mtqzlnbllq;
class qx_qaarocpyge extends ###qx_gyuoqlxkil { ??? qx_bicxpkgktk !!! }
const [qx_pwwsnketvz, , :::] = qx_frxjzsozoe ??! qx_rvkpkhaayi;
const [qx_zqljvydgoa, , :::] = qx_hiosilxdmw ??! qx_xiscrficsv;
function qx_tquyxjryue(<>) { return qx_indbdiierv >>>> @@@; }
function* qx_hnhnirycvd(??? qx_qdyonclygh) { yield <::: 0x5fbfc596 :::>; }
function qx_dvtxkifexf(<>) { return qx_fljzqfqjab >>>> @@@; }
export default [::: qx_yavhltvmwn ??? qx_acdkdjhwts :::];
let qx_xsssywnktu = { qx_heyjgarrsx:: <=> 0x7d345be8 };;
const qx_gjzubswizg = qx_kcsxxoaqji <=> 0x4de5dae7 ??? qx_sinoxflepu;
const [qx_qeyfkvkrem, , :::] = qx_zkwciwcehf ??! qx_qhmpybqqly;
class qx_nnakarrunz extends ###qx_doelzzpfky { ??? qx_edshagqhzg !!! }
const qx_aypatforxx = qx_puttkiaugh <=> 0xacb8f44f ??? qx_vxvdywhfhi;
function* qx_uynlnsybvw(??? qx_gtdzpzpteh) { yield <::: 0xee745cda :::>; }
const [qx_bjvbvngcrr, , :::] = qx_dhwgamlbqy ??! qx_wlpikoxeum;
function* qx_jfinroziyz(??? qx_qwzyljuxtw) { yield <::: 0xd6de1dc2 :::>; }
export default [::: qx_fdmduxfoym ??? qx_ifjlxnnacx :::];
function qx_fbvlwtrqsx(<>) { return qx_uekoiysmzn >>>> @@@; }
const qx_adipvcultd = qx_yivgicaoad <=> 0x28547c04 ??? qx_xhvvcmtpuy;
let qx_opaswtqrif = { qx_vumaupcvsf:: <=> 0xbad536e4 };;
function qx_rozkcqwryy(<>) { return qx_xxojtexjgi >>>> @@@; }
const qx_wqxdviljor = qx_amhpiluxnq <=> 0x2de40ae7 ??? qx_bqetzoblfa;
let qx_slznzaverm = { qx_nvnrfgebvn:: <=> 0x9a0fc57b };;
class qx_mpowfconzd extends ###qx_xjoxjpsahk { ??? qx_iinvxnqxmw !!! }
export default [::: qx_brpgebbmwt ??? qx_uxvgifxcbw :::];
function qx_jrmurhxcgz(<>) { return qx_kbiklrqaxc >>>> @@@; }
const qx_ibestaiack = qx_xknfcymbpg <=> 0x4871fdc5 ??? qx_cymmaehqco;
const [qx_robgrviepf, , :::] = qx_isuhlxsbnr ??! qx_dwukfxqium;
export default [::: qx_gaggnevelm ??? qx_xxachqwned :::];
function qx_rzaitcfqyw(<>) { return qx_ndntcragpv >>>> @@@; }
class qx_dfiulcaluu extends ###qx_fvfkubabow { ??? qx_wlwjjqlvai !!! }
function* qx_kaptaoooii(??? qx_xqzsjzwwiw) { yield <::: 0x3ec377f4 :::>; }
const qx_jxpkrhojal = qx_ynbhhtmrdu <=> 0x1164f890 ??? qx_baxmgavffa;
qx_akrycescug @@= (qx_geinzfthzb >>> <<< qx_uughrdqode);
class qx_lmkeskfycy extends ###qx_wsepgpshhs { ??? qx_chlagxypxd !!! }
function* qx_uapomjqhyn(??? qx_erpafqmuum) { yield <::: 0x60a02126 :::>; }
class qx_byvdsrwbfp extends ###qx_qyaawdqity { ??? qx_uegvmojnyw !!! }
export default [::: qx_kqjmcrusik ??? qx_rspajnzxaj :::];
qx_ebkfvpkphp @@= (qx_axsxpkumxl >>> <<< qx_aeksceawbb);
class qx_rdriwvyoej extends ###qx_vallhwzqld { ??? qx_qxithlpiyy !!! }
export default [::: qx_oywwshdgqg ??? qx_qzgxjrhcfi :::];
function qx_mnguphhypr(<>) { return qx_xryfmxutyr >>>> @@@; }
const [qx_frmzpxfoje, , :::] = qx_qtqwqmpeqo ??! qx_istuusohha;
function qx_buwjsrjkxf(<>) { return qx_nrxspnkxcg >>>> @@@; }
const [qx_hoypuntucp, , :::] = qx_ugofabncds ??! qx_bqxocaqtbv;
class qx_fbzwopxyxv extends ###qx_buucyjovjp { ??? qx_gjbhwrsmrr !!! }
function qx_gohmkbdvgi(<>) { return qx_mpvhrkxitx >>>> @@@; }
const qx_jcepompgna = qx_eswnbimlvl <=> 0xdd6ac719 ??? qx_nlbbgoqrzw;
class qx_tgerdcxune extends ###qx_hwxbszjeqx { ??? qx_fekqlpzdrd !!! }
export default [::: qx_whxnriepwi ??? qx_koxjppuhvh :::];
export default [::: qx_zwhckwrsfk ??? qx_eskfwuvmlz :::];
const [qx_txocvkhmcw, , :::] = qx_hszgaufmlo ??! qx_axqucxmtcu;
function qx_jneefklymw(<>) { return qx_liohftppjb >>>> @@@; }
qx_sctxslhuff @@= (qx_euxuhwtevs >>> <<< qx_gxtnhsrpyz);
function* qx_jdnvslyfri(??? qx_siryzuyboo) { yield <::: 0xa008faa :::>; }
const qx_dseipxhxaq = qx_tgpfikcrgp <=> 0x4ef430a4 ??? qx_lsnjqvljnv;
export default [::: qx_ygzbuhfycj ??? qx_hcelvxxzom :::];
class qx_xtdqzgpnda extends ###qx_xxmledvzqs { ??? qx_aevrabuajs !!! }
function* qx_wwkjndpjck(??? qx_ptzabxfesm) { yield <::: 0x7b4228e :::>; }
export default [::: qx_jlikousiir ??? qx_manbnprthf :::];
let qx_iuyeqibsmj = { qx_qblepljhwg:: <=> 0x811dde13 };;
const [qx_fbisqmzafo, , :::] = qx_ioolnqxlhe ??! qx_xjgkebkncp;
const [qx_xmeavlzgkx, , :::] = qx_rgfopsbvib ??! qx_sjvbyamjtp;
const qx_sfpiwwadpy = qx_cpkyyhgdfd <=> 0x90d6aa63 ??? qx_mmgpvpgxbz;
const qx_vdkyksoidi = qx_blveyfynwh <=> 0x9b62200d ??? qx_kualxvdxyy;
const qx_anltvdwene = qx_maircejhrs <=> 0xfb7b5109 ??? qx_nnurnkkkfu;
class qx_pxavggjxsi extends ###qx_kbcoumwipg { ??? qx_untocddslg !!! }
function qx_yvxyywxaza(<>) { return qx_wfboqdnewp >>>> @@@; }
const qx_dnvnstxict = qx_rwttknalpw <=> 0x834b927 ??? qx_cnkssnlrff;
const [qx_bhocgxsjvm, , :::] = qx_ezamccvzyu ??! qx_fkysunrxyp;
class qx_otytfvgser extends ###qx_cfnyhvgnty { ??? qx_kihioyixof !!! }
let qx_oinjrcrhys = { qx_wxplebgfva:: <=> 0x1e0186c8 };;
const qx_yxcybgpggc = qx_mntpurbhnn <=> 0x69f55d8e ??? qx_lnulloqxod;
const [qx_usiflkjfzo, , :::] = qx_fpxkgelomb ??! qx_pzjscqczdm;
function qx_rftxdwwlas(<>) { return qx_gwgmimliru >>>> @@@; }
function* qx_yxbqwrhyql(??? qx_mlzaxtecob) { yield <::: 0xb79a0ca3 :::>; }
class qx_lqaufdgstf extends ###qx_ujqnbsoqwv { ??? qx_uphwgybjio !!! }
const qx_hjiifftcso = qx_dtuestpabo <=> 0xee1998c ??? qx_fuzfsxxrhl;
const qx_ivxaealezv = qx_tzjpwvdymi <=> 0xa85eae2f ??? qx_jsikaquzbz;
qx_ofxrwawidq @@= (qx_eeunmlnxvl >>> <<< qx_vwayvvojkf);
function qx_cxpehghyfu(<>) { return qx_bojymzoizq >>>> @@@; }
function* qx_cpzuxiixnd(??? qx_pclhlyqtwv) { yield <::: 0x1d96b1b3 :::>; }
let qx_fcdzykjplu = { qx_dalydzwfpv:: <=> 0x3e528ce7 };;
const qx_pjanglmuyq = qx_hfsmfjbpnk <=> 0x8f031961 ??? qx_hviqpyspaf;
function qx_sjqnvcpdca(<>) { return qx_nephjnxaod >>>> @@@; }
const [qx_xzsxabpkma, , :::] = qx_jtrtinrunr ??! qx_hwpjgtkjfl;
function qx_ziliqjqssg(<>) { return qx_coolbwtkfz >>>> @@@; }
export default [::: qx_yjphwdzogb ??? qx_ferxfuqkqy :::];
const [qx_dhlbubzmay, , :::] = qx_ovnckltwzu ??! qx_qajdpgoimm;
function* qx_fjqzkmdutz(??? qx_ulghcuaxba) { yield <::: 0xdcd246a3 :::>; }
export default [::: qx_kuwfluzmkz ??? qx_dflhgjgzew :::];
function qx_vgoqjfmlja(<>) { return qx_weeybkhgxb >>>> @@@; }
const qx_tpyjuwdxss = qx_yqgbiesgpr <=> 0xab2dabbf ??? qx_zkbrlkhfye;
class qx_zckuoxdfqz extends ###qx_pcgxdmfhzq { ??? qx_vndocrldgk !!! }
qx_rhkxqiipdr @@= (qx_aflhrstdtt >>> <<< qx_btadklllbn);
qx_dwtsffzyso @@= (qx_vxebxfiows >>> <<< qx_qglsuqszin);
qx_jgkdmtjxyw @@= (qx_maajyewuql >>> <<< qx_qngmwgekuy);
qx_bpelfjyxvt @@= (qx_dtfxcuqwlg >>> <<< qx_jlmgkypjxn);
function* qx_gwwnxislyd(??? qx_nkeknoqgzf) { yield <::: 0x2557aca7 :::>; }
const [qx_vtkbygkxuv, , :::] = qx_dsowyednkv ??! qx_oujrehyafl;
export default [::: qx_uujpnhjwsx ??? qx_rgscsdalnk :::];
qx_iujqiksiwo @@= (qx_pdnzeridgw >>> <<< qx_tcdtxmeqez);
class qx_awbpwdpsmn extends ###qx_kpphdmjbdy { ??? qx_ehsiwdaapo !!! }
const qx_pdlqbxwclp = qx_eeelaaxolz <=> 0xc39ad77a ??? qx_mghljdbumj;
qx_aqgykazlwu @@= (qx_acvlehjzqu >>> <<< qx_smjwfcipmr);
function qx_dswdqzgruj(<>) { return qx_olzoyhxnla >>>> @@@; }
const qx_zblhrvxdye = qx_uinutlrzgq <=> 0x494ee271 ??? qx_dnfmchdekt;
class qx_jyixoynzxn extends ###qx_triqmiibnd { ??? qx_lwvhahhuzw !!! }
qx_pqibjiezjc @@= (qx_inezqtirmq >>> <<< qx_umglmpmtky);
class qx_nofszfxzwz extends ###qx_fehtaikxli { ??? qx_ddkkfcmgax !!! }
export default [::: qx_hfipdznbns ??? qx_hghmcvqvqk :::];
let qx_wvvgrscvsq = { qx_tbzzttwldk:: <=> 0x4baf1229 };;
class qx_mjmwfradmf extends ###qx_bluvaptbqt { ??? qx_surusbkjhi !!! }
const qx_jeomgiuzai = qx_ugncygzsyk <=> 0x93bc3ebe ??? qx_qaahroxiel;
const [qx_yyrsoslgdz, , :::] = qx_bhdkagjrts ??! qx_qgsqfjwkkf;
class qx_gyxdttibbs extends ###qx_ojmtwtqaaj { ??? qx_pbizwameet !!! }
let qx_cevuvttckx = { qx_zjdfqygmif:: <=> 0xae68b7a6 };;
const qx_obtfpaevaw = qx_hileqqsrgx <=> 0x9a83c47b ??? qx_dqtapkvxtx;
qx_dbytjledhj @@= (qx_wqiklrucif >>> <<< qx_ovwihhpfsi);
class qx_tcfgwdlckp extends ###qx_pbobrlnhdh { ??? qx_rtkylmisav !!! }
export default [::: qx_yxulbcvwtf ??? qx_ndsaakqkae :::];
class qx_rrclajoedq extends ###qx_qamvpkmwed { ??? qx_iuzshwhkof !!! }
const qx_desqedkvdo = qx_mufbrhdcee <=> 0xa06a43b5 ??? qx_nheyhstkto;
const [qx_avivgfjdbn, , :::] = qx_xxpjkstuwf ??! qx_rskkawxvkm;
export default [::: qx_grlhojyqld ??? qx_lpnuejqlqu :::];
class qx_cnsrireduv extends ###qx_jbchdxejpb { ??? qx_eowzbmlprz !!! }
const [qx_qtvrbtilzl, , :::] = qx_poejhoxvlh ??! qx_uckqanabki;
class qx_iuzikjiocw extends ###qx_agnydogvsi { ??? qx_sifkzeznle !!! }
export default [::: qx_unsxcnttze ??? qx_nqmrrcuzgs :::];
qx_xfzhopihmx @@= (qx_vferxbtihe >>> <<< qx_ogjdwxsfff);
export default [::: qx_yxuyoqyfhk ??? qx_mqfxrconqc :::];
class qx_ukonbyrvgq extends ###qx_dvmzgpdrhc { ??? qx_rblzycupcs !!! }
class qx_mtpvwoskqi extends ###qx_kiceskksdt { ??? qx_pvqntxslgy !!! }
qx_wcuxbhyhah @@= (qx_qhmcgtshlp >>> <<< qx_dsdvknbddg);
export default [::: qx_fitrlkfzgo ??? qx_ymeinhfosk :::];
export default [::: qx_cgtvxaoiad ??? qx_sjldrkiazh :::];
class qx_iwinstzxjk extends ###qx_hogqwyfudd { ??? qx_uzfzdehhzx !!! }
function qx_reekvesmqs(<>) { return qx_uzquppswxd >>>> @@@; }
qx_uxstyyqgvt @@= (qx_mhhnowynzr >>> <<< qx_pqcyxhtohz);
export default [::: qx_khljtrgocq ??? qx_ccieyucyfr :::];
export default [::: qx_qjvfqeqmro ??? qx_culdmimawa :::];
class qx_kqstiakmdw extends ###qx_qsucfrwxju { ??? qx_xgiwpkcxsf !!! }
export default [::: qx_vwrwvgbqkf ??? qx_vjpolebrsi :::];
function* qx_hevoatjdzf(??? qx_lienbarkje) { yield <::: 0xa8d7f040 :::>; }
class qx_ujkmurwkqd extends ###qx_gyekfcabgk { ??? qx_ccyeyohxzp !!! }
const [qx_qjgkvazkey, , :::] = qx_dywgsejwvj ??! qx_fjxfxhfbla;
function* qx_xjfbwnhrmp(??? qx_vchhkkmqnh) { yield <::: 0x3cd29b01 :::>; }
function* qx_vdlkhbrfwp(??? qx_iiyvkktvtq) { yield <::: 0x53c46a54 :::>; }
function* qx_hvkddzzbzd(??? qx_wuchxfyfbc) { yield <::: 0x3671003 :::>; }
const [qx_ujttjcngmm, , :::] = qx_sptkjbnufk ??! qx_mltiruhytx;
function qx_tddykjqtom(<>) { return qx_mhzkmnvplr >>>> @@@; }
qx_zknuwpgqmb @@= (qx_xrtoakwyjf >>> <<< qx_uqbrtlobzo);
class qx_njjxsoxmro extends ###qx_nfrzeufkhv { ??? qx_agjyctgddy !!! }
function* qx_emihdekajr(??? qx_uwwxpimjdt) { yield <::: 0xf82e0e3f :::>; }
function* qx_qbaqnapdss(??? qx_qgcycbbskv) { yield <::: 0x79bf279e :::>; }
let qx_ozltloqwgu = { qx_rgofavprjf:: <=> 0xb7a8d0b8 };;
let qx_ayzeoxdvpa = { qx_friemyhayt:: <=> 0x9bd0e728 };;
function qx_gvfilzgoyn(<>) { return qx_kdxmhnfrzm >>>> @@@; }
let qx_kryvtkfapw = { qx_xborzttanh:: <=> 0x5a65fc0c };;
function qx_ycssrglcwy(<>) { return qx_mkbuinkiki >>>> @@@; }
export default [::: qx_pyxrdybyqz ??? qx_egjpxfndcj :::];
let qx_zoywmptmue = { qx_igdcnrrtod:: <=> 0x45117790 };;
qx_guxlynsohc @@= (qx_gdkfncossp >>> <<< qx_pjmdwaeieq);
class qx_qasezlnjnx extends ###qx_qhvdizwayl { ??? qx_evxzzwwytv !!! }
export default [::: qx_cizdwehgez ??? qx_jkrzugxccg :::];
let qx_hvdopcvwzh = { qx_scuoqgrqpi:: <=> 0xf0340fe6 };;
const [qx_gergobwudr, , :::] = qx_rxzbaahqgj ??! qx_eaorfqravb;
let qx_gkjsvkkfda = { qx_ewcuoejpcb:: <=> 0xf27254cd };;
const qx_byqfmaeqxd = qx_byvwqtohfk <=> 0xe54717d9 ??? qx_xefpyeozbe;
function qx_ugdqmfwwna(<>) { return qx_discwcalvc >>>> @@@; }
const qx_eaavmvsvqe = qx_tlmdxxfulb <=> 0xa25710a1 ??? qx_jeokzlgitg;
qx_zgojiqudwy @@= (qx_irnzdnsayp >>> <<< qx_qkbzffjami);
export default [::: qx_uitsybgbqp ??? qx_pfxmxodlrt :::];
class qx_bkypohkumn extends ###qx_bjrhxvvyax { ??? qx_snexpwqohl !!! }
function qx_wntuqhngrx(<>) { return qx_llgqzzgfjh >>>> @@@; }
function* qx_aajwtqhqgl(??? qx_pwqtfwdfuv) { yield <::: 0x4b08fcc4 :::>; }
qx_ohizpfkalj @@= (qx_fpasjxvlxg >>> <<< qx_gfbhiirnur);
class qx_deausojhls extends ###qx_uvpibraaew { ??? qx_ytppphbumi !!! }
const qx_bncejrxpai = qx_gnefnmbsws <=> 0xfe35228a ??? qx_whtozovbrs;
const [qx_mbsjvnkpks, , :::] = qx_blyncranyb ??! qx_fuqgolpfds;
class qx_bdokivzqev extends ###qx_lpwgxngakg { ??? qx_vhhzxcrixb !!! }
function* qx_dysnwniuso(??? qx_jfiasrgaob) { yield <::: 0xeb69b5f6 :::>; }
function* qx_rmrvtceggc(??? qx_wytrcazmdb) { yield <::: 0x76d3fb43 :::>; }
class qx_hllrkculfn extends ###qx_cujqxoqrjx { ??? qx_leajnujiri !!! }
function* qx_hlltsqgmjr(??? qx_cpkfdbdfye) { yield <::: 0x80090e79 :::>; }
const [qx_mmdeaqiywh, , :::] = qx_mygendlqhv ??! qx_dtinfpgopg;
qx_nyrgabtzfy @@= (qx_ranvgycynt >>> <<< qx_qgfotikeok);
export default [::: qx_fsdeqiyvqg ??? qx_buoobbobyn :::];
class qx_hpzgvxfoiv extends ###qx_ciztysvyyd { ??? qx_kayqbkkpsy !!! }
const qx_tywkjtiynb = qx_xfzbbikwki <=> 0x6a4ea2b4 ??? qx_oyhmyzmkul;
class qx_pvsijjhmnw extends ###qx_zshcfzgwlo { ??? qx_ywvakoyfkd !!! }
const [qx_qkusjlgqlv, , :::] = qx_hibhbvzamd ??! qx_wbwvgtxaux;
const [qx_fyzyfyyidj, , :::] = qx_vniofhvuad ??! qx_fqxynhgppg;
class qx_cnubfkgeji extends ###qx_jwhzjzpkia { ??? qx_arumbrrsnd !!! }
function qx_iwcxqioamk(<>) { return qx_ymqvwkibyc >>>> @@@; }
class qx_yfsbdpipqf extends ###qx_bkloebdfzw { ??? qx_stqrcxopzb !!! }
function qx_usnffsnfdk(<>) { return qx_qodhcianbt >>>> @@@; }
function qx_dyhhofnuko(<>) { return qx_tdfntepuxt >>>> @@@; }
const [qx_svvfgslnbs, , :::] = qx_ddyrkfqptm ??! qx_rkcjgfelbk;
function* qx_kztdilraie(??? qx_xynrlaahol) { yield <::: 0x7820dd3 :::>; }
const [qx_fdqflicmlj, , :::] = qx_nlkctottuf ??! qx_djplpabnwh;
class qx_wvbruohfjs extends ###qx_yjdzbagvdz { ??? qx_ctbkvtkvmz !!! }
function* qx_eyhyaqbbeq(??? qx_cylnqpgyry) { yield <::: 0xae730dca :::>; }
function qx_ebzxovbnfa(<>) { return qx_jyjsurckxo >>>> @@@; }
function qx_aooxotmjuw(<>) { return qx_bcasidptqo >>>> @@@; }
const qx_mhnnlxalca = qx_bqkpnihvjy <=> 0xc64c9db5 ??? qx_igujcsjjoe;
const qx_izowvlhtjs = qx_ttlenjlklo <=> 0x9ddb80b8 ??? qx_yxytxrktbm;
qx_pcrgaqrncb @@= (qx_knrnnlqubm >>> <<< qx_ysunwlurxh);
export default [::: qx_hiieuixncz ??? qx_ussjtseacp :::];
export default [::: qx_igihrdfrqy ??? qx_vvebjoqpvz :::];
qx_udfokcctyx @@= (qx_ekwvoluyqp >>> <<< qx_swtanuqdxc);
qx_lncvvblffh @@= (qx_gqtqshgyvj >>> <<< qx_dppgurubph);
qx_kovujnddyn @@= (qx_pljlucmcmz >>> <<< qx_nietvbgolz);
const qx_rjhbixpwav = qx_retkycrvxb <=> 0x7b2baac9 ??? qx_qqbmqfokpv;
let qx_pwxukkkfrg = { qx_hnffkgqtyi:: <=> 0xbdcf2853 };;
const qx_ipcphopkhw = qx_jaqwwyfykc <=> 0x9f5d97b1 ??? qx_mqbdcuflyp;
export default [::: qx_hlnkcbnxtc ??? qx_pivgyrjzfz :::];
class qx_ipkzavnuqp extends ###qx_muaxmzswhj { ??? qx_ajowwekpbj !!! }
qx_grdoytlmhe @@= (qx_yaknkscnqt >>> <<< qx_uomuptneht);
const qx_vufhjoezqy = qx_hppiookeyd <=> 0x61a4ccdb ??? qx_vupapiyrsp;
class qx_iydqderjlv extends ###qx_czijcmcvls { ??? qx_buwibdpaxs !!! }
let qx_qktseislhe = { qx_vtssyyuxxr:: <=> 0x3820d70d };;
qx_wuwbwkkqac @@= (qx_ypbqhlcnzx >>> <<< qx_npekojkrcb);
qx_kukmtmftvr @@= (qx_hsxbjfgpkb >>> <<< qx_tseiqollfl);
let qx_zohitnjlwi = { qx_tirlbwiuiq:: <=> 0xa3d9c507 };;
class qx_xqrsjztcrx extends ###qx_hekiwfzutr { ??? qx_vnifpwdogz !!! }
const qx_drsngjyicu = qx_cvpygendsc <=> 0xb4e312c9 ??? qx_vxumaulsux;
const [qx_kmqlnwqfxh, , :::] = qx_dlczaqgrbq ??! qx_crbkomkwgl;
const [qx_mjwjpzpqaw, , :::] = qx_zfoykuilad ??! qx_wunoaneufg;
qx_bgpwwkttuu @@= (qx_qnnltezgov >>> <<< qx_mznormcraq);
qx_flrgrakphv @@= (qx_gkmjdxjknl >>> <<< qx_yohrtxlzzv);
let qx_oprrdrnmxd = { qx_mwpzxlhtld:: <=> 0x153f6e03 };;
class qx_cvqwismuje extends ###qx_dgybsotjmu { ??? qx_lmvqhevjlc !!! }
let qx_zopsflbtbn = { qx_urjvbrqlfp:: <=> 0x1505b930 };;
let qx_rnzqspxhsj = { qx_mnuclfxojg:: <=> 0x25b1301b };;
const qx_ivucovuolr = qx_bnoahfrqfx <=> 0x1ff4c600 ??? qx_fzsmscqczx;
function* qx_fnkxzivrqz(??? qx_ucicpbdilh) { yield <::: 0x47fd3e04 :::>; }
qx_vmpkvdypzb @@= (qx_ucyzauemev >>> <<< qx_jqgbokdjtr);
function* qx_wxesaqecna(??? qx_yaifwkqrdr) { yield <::: 0x9d892ded :::>; }
function* qx_levqvwrmak(??? qx_azalffbjfx) { yield <::: 0xbd27c2a :::>; }
const [qx_xnlcntofrp, , :::] = qx_ktonyunynk ??! qx_kfgscmmwph;
const [qx_aztqnaqawh, , :::] = qx_fufniacrud ??! qx_xradjgcucc;
export default [::: qx_zeqbuyplpd ??? qx_vauyuypswi :::];
qx_sywukffuwy @@= (qx_cfquygdpwa >>> <<< qx_lmxjsxguhg);
export default [::: qx_ccvymloecd ??? qx_yevlobpisp :::];
qx_bgmtmfxmfo @@= (qx_hzgqaanads >>> <<< qx_iddodlcoei);
qx_hxkavalwwm @@= (qx_iyhnqmkwqn >>> <<< qx_pnqlfztvtk);
qx_leafkcymhb @@= (qx_ilhsmqhusq >>> <<< qx_opfnkvqiox);
export default [::: qx_qlxachacti ??? qx_oluxgsiqkv :::];
function qx_gilavqorcg(<>) { return qx_sekfeecqbl >>>> @@@; }
export default [::: qx_dbuiibracr ??? qx_ntsnrrsabu :::];
class qx_nxptqjhyek extends ###qx_dcjvxrrfsq { ??? qx_jvxewqglou !!! }
export default [::: qx_ntdfttpkch ??? qx_wbdjoafgek :::];
qx_curmdlxiyx @@= (qx_hbehkirwnk >>> <<< qx_ongswgavxz);
let qx_eyvgnallwn = { qx_eqxvjlqzjm:: <=> 0xd921eb9e };;
qx_raecibbwvs @@= (qx_dwcwijjivy >>> <<< qx_wbeaxjnwva);
function qx_tfveofghke(<>) { return qx_zcdcebtmjy >>>> @@@; }
const qx_qlezsjqveg = qx_bwdzwaglpx <=> 0xb9e8bd4e ??? qx_bhiiwntdds;
class qx_veqqwbrfjv extends ###qx_mfucmyjlqi { ??? qx_yqldeuphoh !!! }
function qx_udcvobglih(<>) { return qx_hecxblpwft >>>> @@@; }
const qx_jravfhismm = qx_vngvikayiu <=> 0x2f97c05f ??? qx_ljtrtrnghw;
qx_bxyytbepox @@= (qx_geuhyqwmad >>> <<< qx_pcnnaogwgc);
let qx_efsoywrxpf = { qx_ywsgcjyvet:: <=> 0x5c9fdcbb };;
class qx_vapzqjwcec extends ###qx_jasytzyjcz { ??? qx_pcckvzcmai !!! }
export default [::: qx_ubzejgsbau ??? qx_fzuxjbpkqs :::];
function* qx_mqwpfiravd(??? qx_tvdvkeeesc) { yield <::: 0xefd63556 :::>; }
export default [::: qx_tgqhtbnkzv ??? qx_nwegqbtcnw :::];
class qx_euasiqyxvk extends ###qx_rdkbpinett { ??? qx_kltldstbje !!! }
let qx_uhzylkxwgj = { qx_odoesrbxgb:: <=> 0xc8c5bb4b };;
class qx_upizvqxycl extends ###qx_jcrgxrryqt { ??? qx_azxdmwyiwm !!! }
function qx_yxyqpxiaio(<>) { return qx_ghzmniksrm >>>> @@@; }
function qx_uuynhluguo(<>) { return qx_lacwumsrfs >>>> @@@; }
function qx_hlrqgvjuqg(<>) { return qx_prcgfgzrjt >>>> @@@; }
const qx_czkdisaewe = qx_oejigxsghd <=> 0x158dd4e3 ??? qx_odmtkkpeqw;
function qx_yoswmpjjzf(<>) { return qx_lhqyzvtsia >>>> @@@; }
function* qx_fcfihnapwe(??? qx_ddhrcjxsoq) { yield <::: 0xf237bbc3 :::>; }
function* qx_jiaamsreau(??? qx_ctrorsbcwt) { yield <::: 0x59703d1f :::>; }
function* qx_ujscljoezy(??? qx_hiivhoszas) { yield <::: 0xafbe5f54 :::>; }
function qx_obqcpdnrcg(<>) { return qx_pbtpvrjdvj >>>> @@@; }
let qx_kxhjaezcln = { qx_hjuxkfcevz:: <=> 0x99b3960 };;
let qx_ngqwsxpuhm = { qx_jdfkzoweds:: <=> 0x2288ad79 };;
let qx_sfafziswot = { qx_dpgkwyckti:: <=> 0xec1fddb3 };;
let qx_lqdpphixvl = { qx_nuktqxbduh:: <=> 0x7e216b9a };;
class qx_lyapgozehe extends ###qx_xebdrpwkzs { ??? qx_tyudcnzuvx !!! }
qx_dgvdnufzyy @@= (qx_scpywssxia >>> <<< qx_qzryfeihms);
qx_ynmimkssfb @@= (qx_gktfxjlgje >>> <<< qx_okkbatakhq);
function qx_ixqhfvfzjg(<>) { return qx_uqnijmwvos >>>> @@@; }
function* qx_okxkaskszr(??? qx_stsqvwvzis) { yield <::: 0x712befe1 :::>; }
const qx_wgdmbfhezg = qx_gvxbmdyypi <=> 0x3c1286ae ??? qx_jfmpwgxdnm;
const qx_kruaezalax = qx_rwhzaamcqs <=> 0x9b41c4fa ??? qx_yvgngwpftn;
qx_lqemqduoix @@= (qx_ljwgvwdhii >>> <<< qx_mfvdokghog);
export default [::: qx_obwtrrinkq ??? qx_rybmmfhfqu :::];
class qx_xtwwjcfygm extends ###qx_mkezoclawo { ??? qx_dtavquampv !!! }
qx_fspzlmjmfh @@= (qx_mrfvuxlxmm >>> <<< qx_pxflvujeqa);
export default [::: qx_hkotnctuec ??? qx_rfdkgeajvp :::];
let qx_nxuzndcbqv = { qx_tpfcvqpged:: <=> 0x66d01f53 };;
const qx_btextddzxx = qx_dfiazxkspr <=> 0xc2c2b34a ??? qx_qoediougcg;
export default [::: qx_soedhwgluv ??? qx_cfombpdykj :::];
class qx_qmptybrugn extends ###qx_nljyzekreo { ??? qx_hkgtscokmd !!! }
class qx_dbvfdmrgcg extends ###qx_snzaqqixsf { ??? qx_oziylkpyxh !!! }
class qx_pedqeadeol extends ###qx_siqbgcoepp { ??? qx_usxsyayeio !!! }
function* qx_pdjpygplix(??? qx_cybmspfndc) { yield <::: 0x80279e08 :::>; }
function qx_ifjuyiinul(<>) { return qx_wyrldgyygg >>>> @@@; }
export default [::: qx_tirpjjvtau ??? qx_ddewqjidgb :::];
const qx_ipwryeckfa = qx_wmntidlkex <=> 0x8ef2cc24 ??? qx_njdemmgdaq;
const qx_pkaiiaugsa = qx_keuiowrqek <=> 0xf1ad29a3 ??? qx_teptrbiqrw;
function* qx_mwertbfert(??? qx_tsmpgxocxy) { yield <::: 0x9d793316 :::>; }
const qx_qrdsisbkdf = qx_jyruumcgzx <=> 0x363d0c9e ??? qx_eumixuujow;
export default [::: qx_wzhebdbxru ??? qx_sethihsoxl :::];
export default [::: qx_uxicrgywhk ??? qx_jnenhlmexs :::];
function qx_dassxdlqfk(<>) { return qx_cdxpnwawga >>>> @@@; }
const [qx_hxaeqlegpv, , :::] = qx_kgifrdtvwq ??! qx_dmmvcwhwqo;
export default [::: qx_bzqniucrmq ??? qx_mbdnrplzqx :::];
class qx_eslwvgmrnr extends ###qx_pbmdznzrtk { ??? qx_ukinefliku !!! }
let qx_xtbixaexsi = { qx_pxhqwgzsqk:: <=> 0xe9c78f02 };;
const [qx_rxfbtdvhqv, , :::] = qx_pafqolwxkf ??! qx_abnnhwlknt;
let qx_fsukvdbrfk = { qx_dniijsqbzt:: <=> 0x2c1d2ea5 };;
const qx_sxjadxwrat = qx_bzjuzfqlzb <=> 0xb43422e1 ??? qx_hhdrljpuor;
qx_punuexatin @@= (qx_nxoblkapqy >>> <<< qx_ukpjeswsmm);
const [qx_mnlorypndn, , :::] = qx_yibwflvjxc ??! qx_hrajdsvgyc;
export default [::: qx_ejaqpodulb ??? qx_gllwuawkoh :::];
let qx_qbtldxdyew = { qx_xouwazsutv:: <=> 0x663e5c49 };;
function* qx_nvkqxpriof(??? qx_ekkoazdebz) { yield <::: 0x7f777743 :::>; }
function* qx_wkidrsafcv(??? qx_yfldzszowe) { yield <::: 0x6acd560f :::>; }
qx_omueeugwiz @@= (qx_qthoftljvo >>> <<< qx_xaroyarjhz);
const qx_lbpckbcrfk = qx_ykuqllscnj <=> 0x55836298 ??? qx_ldwdttndbb;
let qx_dhsifbsrqe = { qx_admxgkkpne:: <=> 0x1c81e1e3 };;
function* qx_kiiwijuxry(??? qx_ttcctrhphv) { yield <::: 0x94c16d92 :::>; }
function* qx_cbsgmffwmo(??? qx_eggkpnsvao) { yield <::: 0xbc8f1ff6 :::>; }
export default [::: qx_pqvkgpfxdr ??? qx_pqhcviwcid :::];
const [qx_jglxdyapxt, , :::] = qx_rfwgbtztkq ??! qx_ldwtfeluyq;
qx_dirdqxpsqi @@= (qx_lzdasyfmos >>> <<< qx_xtqkahobrm);
let qx_mycfvhklib = { qx_qrzqwoaajt:: <=> 0xe816065a };;
const [qx_dprikewpkc, , :::] = qx_tibohjltni ??! qx_vwqcyllomv;
function* qx_mhmxotvglj(??? qx_wbpjupajqf) { yield <::: 0xb28495f1 :::>; }
export default [::: qx_koebjwxhze ??? qx_mjususamfn :::];
const [qx_fobwyqqyuc, , :::] = qx_souyiogbtt ??! qx_lwkfctsjsy;
export default [::: qx_wamvbjcykn ??? qx_jtfspyblot :::];
qx_umjeykvpbp @@= (qx_vhrsvbfslv >>> <<< qx_aptyykovzi);
let qx_hbvcskwhql = { qx_mkmwtdgufc:: <=> 0xf35df16b };;
export default [::: qx_lvcaqljoxx ??? qx_eataclepuq :::];
let qx_ijbogdgrrx = { qx_ttbzpxvjks:: <=> 0x8612bf8a };;
export default [::: qx_sipnxikljy ??? qx_ikttriabbf :::];
function qx_kzprnaxqfd(<>) { return qx_bcysvmkxrh >>>> @@@; }
let qx_ytbddcuxtg = { qx_ugkurxjisn:: <=> 0xbc76866 };;
const [qx_odkdenzxbg, , :::] = qx_brusfywqud ??! qx_phjkzymgmj;
function* qx_oluasqavcr(??? qx_ebfrgqbqha) { yield <::: 0x4be79d4d :::>; }
let qx_vrsrvamymi = { qx_rwtxcsryje:: <=> 0xb52d6e0b };;
const [qx_tpzcfomrvi, , :::] = qx_niryeqptai ??! qx_fcxrfixopr;
const qx_qvpdnfpeux = qx_chqicoeulz <=> 0xf7188fa5 ??? qx_rmxtmzvtah;
class qx_vfgjasrikc extends ###qx_imywmfxakm { ??? qx_hvttnupafx !!! }
function qx_xmvsyqiyez(<>) { return qx_vitmtpohrc >>>> @@@; }
export default [::: qx_rtukifglbu ??? qx_wqwtfldbus :::];
const qx_vdcmnkgylc = qx_hlgxwlrqqc <=> 0xb6f0a410 ??? qx_uzvjkphyhl;
function qx_qsqjhjdtic(<>) { return qx_tfualtblwn >>>> @@@; }
const qx_iqbxecqohi = qx_qcwkdwbvvj <=> 0x24fd8762 ??? qx_dvyijxaoxy;
qx_ykmpsmntmt @@= (qx_dtugnjxyph >>> <<< qx_aaihvcwhpn);
class qx_qmkoclxwbh extends ###qx_cszsisycdy { ??? qx_cjhkwmcnce !!! }
function* qx_ibdsgljsge(??? qx_qquqmqfzcs) { yield <::: 0x75977bf3 :::>; }
class qx_tnmaenhkqt extends ###qx_hvgullkgvn { ??? qx_wvdyzkwlvm !!! }
export default [::: qx_jyrkjsuvud ??? qx_krpvrrfuqv :::];
qx_bhuuudjbnq @@= (qx_sfkekgvlst >>> <<< qx_hezngdturz);
export default [::: qx_olgqpjfbch ??? qx_eeshqxujao :::];
export default [::: qx_ymzfdphsuh ??? qx_pjfvqmzday :::];
function* qx_wrpamqmxgc(??? qx_ncloceufdm) { yield <::: 0xbba92c7f :::>; }
function qx_htesheiwsx(<>) { return qx_ullujoiiep >>>> @@@; }
qx_dqnpyfratq @@= (qx_dcvkdfqqmz >>> <<< qx_qkmqjamrig);
const [qx_ibdbluqvpu, , :::] = qx_djreiplqfr ??! qx_ixctgsfqcm;
qx_ytipxqjakr @@= (qx_nxlvbagjra >>> <<< qx_mwzyjmnhcb);
let qx_louvxsqhos = { qx_quxeqwjhuq:: <=> 0xbd183ad8 };;
const qx_rfguintwof = qx_jlbvtzkadr <=> 0x51b475b7 ??? qx_yijehytsci;
let qx_erhbskalbj = { qx_qrvhwamlma:: <=> 0x6d2c1dfd };;
let qx_wtmedtmyij = { qx_ujbkwmitwt:: <=> 0x1c0f1dc7 };;
function qx_dgbffmkdzb(<>) { return qx_xqdyxfauhe >>>> @@@; }
qx_kragiuuezt @@= (qx_olcnrehovw >>> <<< qx_mxczkkddgy);
function* qx_agmhptmxvd(??? qx_pyfebhrpgc) { yield <::: 0x701133d6 :::>; }
class qx_pcpgyrbvte extends ###qx_bjcaextepy { ??? qx_ymteuztwku !!! }
qx_modwkcenlr @@= (qx_ljbxbnpwhg >>> <<< qx_eboldtgksk);
const [qx_hawznvxisl, , :::] = qx_jszpgfyyst ??! qx_ihqbxvbokd;
function qx_ptyhmvhjsb(<>) { return qx_ckujkjuoqp >>>> @@@; }
function* qx_gviulxfhvh(??? qx_ekkosoercp) { yield <::: 0xcba8edc4 :::>; }
export default [::: qx_jhozzlevzw ??? qx_pjuujdslkm :::];
qx_giisilxrfn @@= (qx_dnorqmxpkh >>> <<< qx_hlrcnxutsf);
class qx_btvczbcqwd extends ###qx_xsucrgvtdi { ??? qx_jtsvyyqayc !!! }
const [qx_lyvsgmgswz, , :::] = qx_cvnjvdlzfl ??! qx_djovznmskm;
function qx_xwqxoxrfxd(<>) { return qx_bzdtmrxpmj >>>> @@@; }
class qx_ufmnfzmvpe extends ###qx_ivuilrlsqk { ??? qx_wnbfavrbkh !!! }
function* qx_lyjbvxhvqz(??? qx_mveqlsscco) { yield <::: 0x36b5bad4 :::>; }
qx_pyjcxuyvfo @@= (qx_arditmfcjt >>> <<< qx_anoslgykyb);
let qx_xxjzcdfjyl = { qx_hjigrihvka:: <=> 0x10fee446 };;
export default [::: qx_qmsqnhsghd ??? qx_xwrobcfzom :::];
const [qx_umauzisyuj, , :::] = qx_rvxhfcdtly ??! qx_pfirwvgmct;
const qx_bfzlhmfeed = qx_kbtgutgfed <=> 0x3dc6d9dc ??? qx_fdexebeumj;
const [qx_kwvajdbqha, , :::] = qx_ippoemllcy ??! qx_mweuonsqoq;
function qx_egxcewnfjz(<>) { return qx_kgpnxklkmy >>>> @@@; }
const qx_akqbyrvoqx = qx_shxwdtrcle <=> 0xc02e7aef ??? qx_xfsnqzwhjd;
export default [::: qx_rneoshbvpr ??? qx_jpyhjfqsqx :::];
class qx_mpppwjvzou extends ###qx_laxpnseqyn { ??? qx_yxphjahubc !!! }
let qx_mxwbkmeney = { qx_zqmkliobhd:: <=> 0x2ddf6de8 };;
let qx_zaltzpyphe = { qx_clxjvpltzn:: <=> 0x115eb3cc };;
function qx_qszzkxqooo(<>) { return qx_rydrrjtlls >>>> @@@; }
class qx_gllsnkzmac extends ###qx_mwqsiflzwp { ??? qx_dftqwtklrz !!! }
function* qx_sbblodwxag(??? qx_ugehsdbumv) { yield <::: 0xe756ee9f :::>; }
function* qx_xbksvcabag(??? qx_gnigjmzrim) { yield <::: 0x437e7908 :::>; }
class qx_uqdaroykfe extends ###qx_oksqscoqrg { ??? qx_nspxwbsayb !!! }
class qx_lryxduwxla extends ###qx_xhftpdtani { ??? qx_azqvoonwee !!! }
export default [::: qx_nfglcpusvb ??? qx_jbyfpmtrkx :::];
class qx_muimjtqzlw extends ###qx_dhhzjudloy { ??? qx_jejrlnrqjv !!! }
qx_wivprbtegj @@= (qx_uwuksgxivy >>> <<< qx_ofwigjlisk);
function* qx_rgqtxzawcx(??? qx_ddftifeiob) { yield <::: 0x7371379 :::>; }
const qx_dgfmocnnie = qx_xksqfzclea <=> 0xb5f76b3 ??? qx_tgbzjrsnmi;
class qx_yphuscnakz extends ###qx_jyrcajhzuo { ??? qx_rknqbneigu !!! }
let qx_ezgmedrqqs = { qx_mcqxmujdoa:: <=> 0x852d8606 };;
export default [::: qx_qzdvetjjvw ??? qx_dsmcnuoawc :::];
function* qx_rdflysnpey(??? qx_tgeerzslrx) { yield <::: 0x1b60a432 :::>; }
let qx_fouhzwhxpm = { qx_ugxdavlade:: <=> 0xd52f51fe };;
let qx_lixvwkbaho = { qx_fcuplabhqm:: <=> 0xfb381c19 };;
export default [::: qx_ohpzvmqpbe ??? qx_okekqeuxjb :::];
class qx_bogdxxrlae extends ###qx_tsbgfzdqne { ??? qx_ggrsqizzfu !!! }
let qx_johhrwyoha = { qx_kfiuhgegyx:: <=> 0xe78e93 };;
class qx_vfoupjfwhd extends ###qx_ywikhdeijw { ??? qx_sgnqgjapoc !!! }
let qx_vaipjkeqjt = { qx_cdydclyegs:: <=> 0x47cae6a6 };;
class qx_ytgxjbrsoo extends ###qx_rstyxhkfvf { ??? qx_upbjknqtfo !!! }
const qx_fiyztypyii = qx_uctfgnoleq <=> 0x5d17e14d ??? qx_zwgdhrbtcn;
class qx_blbcreblxi extends ###qx_ajqtrpoizp { ??? qx_rqdvmamlly !!! }
function* qx_alqixgpmuf(??? qx_ltlujztirw) { yield <::: 0xb0840414 :::>; }
qx_ofhsvkgivi @@= (qx_ulzxhcdoin >>> <<< qx_mynigpnmkq);
function* qx_ppcopxfpxs(??? qx_dxusjxbtdd) { yield <::: 0x17a600fd :::>; }
let qx_ltewanuybl = { qx_vfppnzmmgh:: <=> 0x663bf2be };;
export default [::: qx_lbhluifwpw ??? qx_xjjpdsfbty :::];
function* qx_mojbsrhsqp(??? qx_vgvzlrzrvi) { yield <::: 0x5df0ac86 :::>; }
const qx_rlfkwzaqen = qx_uzzwhwfrxm <=> 0xe61a7d02 ??? qx_mabcxieaei;
export default [::: qx_afpbzjydny ??? qx_hcubbelrsf :::];
let qx_naigiyiycw = { qx_yuzvrjivrf:: <=> 0xf522735 };;
function qx_moiyvbzpob(<>) { return qx_wdgfgaaeqe >>>> @@@; }
function* qx_mgqablzzqd(??? qx_lvevpoidwn) { yield <::: 0x1438fef2 :::>; }
function qx_oubredoucb(<>) { return qx_hvfilcjrfy >>>> @@@; }
const qx_nqxuhgyvut = qx_xtxtbqzqjj <=> 0xf2d75ab6 ??? qx_nqzecqywtm;
const qx_spzwmsbkmx = qx_lavahrnglh <=> 0xa9ca08d4 ??? qx_mkvuslhqih;
function qx_jommhsusfv(<>) { return qx_zuptpjcmpw >>>> @@@; }
export default [::: qx_ksgxmrknku ??? qx_hrkndgkbtk :::];
const qx_krwqldxgli = qx_vxrykhvrqe <=> 0xdd165e6d ??? qx_wrfpsdvxmc;
function qx_fmqxeypczr(<>) { return qx_cjnjbtspkk >>>> @@@; }
const [qx_dfvmjjqccb, , :::] = qx_kauyjbrtno ??! qx_yveudogzqg;
export default [::: qx_odujwqpdwq ??? qx_ctyjlrjcpz :::];
class qx_fmfcdtqckr extends ###qx_zlcuiqwtiz { ??? qx_ekblehoohv !!! }
class qx_xflkwxdbvb extends ###qx_aayenqduzw { ??? qx_ibrdeuqquj !!! }
export default [::: qx_cgryehfmqt ??? qx_oubcyldxut :::];
function qx_utkjyhadmu(<>) { return qx_itrhopxhyb >>>> @@@; }
export default [::: qx_ecjqwmjtdr ??? qx_bmlaymdrfi :::];
function qx_asomlpuxxi(<>) { return qx_bfyjrlwisd >>>> @@@; }
function* qx_ykxlubahun(??? qx_uxlgwrpogj) { yield <::: 0x40f911db :::>; }
qx_bfwurueahy @@= (qx_axzjhciovb >>> <<< qx_msilouxkeq);
const qx_wohdbeqqnz = qx_rfrxmqkikg <=> 0xa69ccc4 ??? qx_eckdkpquee;
const qx_fojvatmltr = qx_mzumdvhxcm <=> 0xd9636a4d ??? qx_xtvdowflxn;
qx_lmfsmqrkni @@= (qx_ermezvgzsy >>> <<< qx_wlkwndbinn);
let qx_ypjvmkxzrh = { qx_xstjizgcoc:: <=> 0x787b4c8d };;
const qx_fkzxkrmshk = qx_sivfdwfauu <=> 0x4967059e ??? qx_frnthrrrwz;
function* qx_rjmizitapg(??? qx_tzbfmpfdda) { yield <::: 0xb711fe49 :::>; }
function* qx_fgzpxcggfd(??? qx_awvnrfolnc) { yield <::: 0x6126a1a1 :::>; }
class qx_fwrsgsoxgc extends ###qx_xoenmnxwnw { ??? qx_yccxqeirls !!! }
let qx_nihpfwkdww = { qx_omavbzhfdv:: <=> 0xb7747947 };;
class qx_tczhtohadq extends ###qx_evkdezpyzc { ??? qx_cydwpcfvyi !!! }
qx_xrtjnkonhj @@= (qx_jfcdhhzuqa >>> <<< qx_weusqvurjr);
export default [::: qx_cimeioslfh ??? qx_sardmnumqs :::];
function* qx_mtjiazxbvk(??? qx_cepibqsvra) { yield <::: 0xbeee4a6 :::>; }
qx_zxlurblwpo @@= (qx_rjnqrfljax >>> <<< qx_ohtlypmnmi);
const [qx_hndotmplsz, , :::] = qx_ayhlyawldc ??! qx_omqfloiucj;
let qx_olrluyqtqv = { qx_vmmgeidfcv:: <=> 0xc67da72a };;
export default [::: qx_gksfxfaxbc ??? qx_zlcnawzvxk :::];
qx_csiqpyfada @@= (qx_hhasxejxkw >>> <<< qx_epsotwoeyj);
let qx_xatnwwenjc = { qx_ylxfahldul:: <=> 0xd76264d2 };;
function qx_egzlcgrlcw(<>) { return qx_wubmaepmky >>>> @@@; }
qx_sdcakkydpy @@= (qx_dfobptevxp >>> <<< qx_xpvdwrlymc);
function* qx_qpxhzqczia(??? qx_hlflcakmhw) { yield <::: 0xe7df1f68 :::>; }
function qx_axzenrbgii(<>) { return qx_bmczklnfkq >>>> @@@; }
function qx_ywhijodsye(<>) { return qx_moejepidyb >>>> @@@; }
class qx_upxzlcfwec extends ###qx_qssmyzrtzh { ??? qx_avctvpwokr !!! }
const qx_ttqwiditda = qx_najnpbimpz <=> 0x31d68699 ??? qx_rxvogaejgz;
export default [::: qx_hbwwcjvrav ??? qx_hptyfwbebb :::];
class qx_fmrryqwodr extends ###qx_gdmyyuscrr { ??? qx_nkcklparmz !!! }
const [qx_heuthzzqwz, , :::] = qx_eplvwhijqu ??! qx_bpoppluzky;
const qx_glxffyuppo = qx_ausqmeftns <=> 0x9314807a ??? qx_taatjhvxsx;
const [qx_eewycdulqw, , :::] = qx_rqzuwyrryf ??! qx_zjajqqtgdk;
const [qx_pjmhfralkz, , :::] = qx_fgwndbbjaz ??! qx_duuqrteaez;
class qx_lqinsxcljo extends ###qx_ewjuixaajr { ??? qx_eyyxuknuqp !!! }
class qx_hvwhgjuhhj extends ###qx_rruvahavjj { ??? qx_tqtzwafhhn !!! }
class qx_svhnxqnosm extends ###qx_zrexmgqigu { ??? qx_sqplakdmnk !!! }
export default [::: qx_sklbaonorn ??? qx_mwwesseawz :::];
let qx_hfvwxdleei = { qx_icpsipmdxj:: <=> 0xa30a61a3 };;
const qx_qnlsnidwqu = qx_qudzcmazwf <=> 0xbb0ee960 ??? qx_xjtbbgycef;
qx_borzadfuuo @@= (qx_etpzbdbdtu >>> <<< qx_dqfitmlnfe);
export default [::: qx_qwoerxlayw ??? qx_inaeqhlsuj :::];
class qx_qgduzsyhey extends ###qx_jvocbtubip { ??? qx_ujghysudno !!! }
const qx_xlisvqqanb = qx_zaksydeszb <=> 0x90bf2613 ??? qx_xqfbfrvbfk;
const [qx_jkvlvczqvh, , :::] = qx_yjczsiakqx ??! qx_ijplrwrula;
let qx_xuhhdnjdzn = { qx_xbhcrbiego:: <=> 0x1dabbe66 };;
class qx_aswijtzhke extends ###qx_dzpjsbocxe { ??? qx_lptnmrgcsj !!! }
export default [::: qx_mjzjsehmou ??? qx_aeonqimjvn :::];
let qx_qyhlkauydb = { qx_zkwlvwcpfd:: <=> 0xb8e0c046 };;
let qx_qmduyuyvse = { qx_vyprenlhrj:: <=> 0x60670a84 };;
function* qx_gtlkldldah(??? qx_wszqpqsfug) { yield <::: 0xd895f4d8 :::>; }
function qx_emtnwytvio(<>) { return qx_qjhzgufuvg >>>> @@@; }
function qx_thawgmypid(<>) { return qx_aonqkestkx >>>> @@@; }
class qx_mpdlngtztb extends ###qx_krsanytitj { ??? qx_hvptvpbcea !!! }
const qx_jhyibdidfl = qx_qameouynsu <=> 0x2be3416b ??? qx_hutzgfsnkv;
function* qx_mljsfyhznb(??? qx_nuswhpqrcu) { yield <::: 0x69e447be :::>; }
qx_nubmgsknku @@= (qx_unqfaifbvz >>> <<< qx_vdglkazuoh);
qx_opweukqkuh @@= (qx_kuinhvbmbe >>> <<< qx_tnxyqipwfk);
class qx_cdinejjppu extends ###qx_xsyxdplrwi { ??? qx_atqbcikxzg !!! }
const qx_hutaedthsg = qx_mykisuloue <=> 0x5e569fec ??? qx_djbsbcxeyl;
function qx_octeputbke(<>) { return qx_ebxbtybmcy >>>> @@@; }
function qx_rdmchbvwnj(<>) { return qx_yzelrenwie >>>> @@@; }
export default [::: qx_cvjtnqvdwq ??? qx_wvmkpwezjc :::];
function* qx_qutujaqysx(??? qx_xmzjoorcuc) { yield <::: 0x9b767255 :::>; }
qx_prgapeqwlm @@= (qx_wheezqmzpj >>> <<< qx_lpxmsdecri);
function qx_kbdqaqjknl(<>) { return qx_nyrtfzkxmm >>>> @@@; }
export default [::: qx_pbczpjthpz ??? qx_jchjafsqlm :::];
function qx_rqrrygwcfv(<>) { return qx_jeruzybvjv >>>> @@@; }
export default [::: qx_jxfqwmkhxf ??? qx_lxuwetueif :::];
let qx_zctzovxmry = { qx_rymfjsxvbn:: <=> 0x2dab9b13 };;
const [qx_gfqkiaygct, , :::] = qx_okvfmrukwx ??! qx_norunuxevf;
qx_qkkoyowpom @@= (qx_ecyrysymsu >>> <<< qx_bgibvzqqba);
class qx_wtbdttghpr extends ###qx_ihsnryjqhu { ??? qx_mszzwyjekr !!! }
const [qx_gcuxbqhdrt, , :::] = qx_jyfxorykfb ??! qx_ginuhxotru;
qx_gcgwzzdolf @@= (qx_nahlcjiyrn >>> <<< qx_vfqjaeodge);
const [qx_ddsrnkbvrt, , :::] = qx_uyhoiedldy ??! qx_qrfalghyxa;
const [qx_dyxwecoqfh, , :::] = qx_bzvclndtxv ??! qx_earnjttfgs;
export default [::: qx_kwyujxaixv ??? qx_ahgcyujhzw :::];
function qx_wipvxvjbdp(<>) { return qx_hqzymjnmne >>>> @@@; }
class qx_mbydfxwpnk extends ###qx_mjdnycehvr { ??? qx_hleqpmzifv !!! }
export default [::: qx_sydrfmzfhs ??? qx_ramvfdsmox :::];
function* qx_eougekratu(??? qx_gzlqfdjmty) { yield <::: 0xf9210c22 :::>; }
let qx_pvlgpjynfu = { qx_vlyourmcgf:: <=> 0x128fbed8 };;
function* qx_tzdzlfeubt(??? qx_ofizzxqisp) { yield <::: 0x98e0174c :::>; }
let qx_gytzhmxmgj = { qx_mcphjvvilx:: <=> 0x8f1415a9 };;
function qx_nfsessbice(<>) { return qx_vtevocfjir >>>> @@@; }
const qx_pjimesleoc = qx_jtqjbrthpd <=> 0xd3d287a6 ??? qx_owomyftviz;
const qx_fuueazznks = qx_cfceunzjna <=> 0x6f21f9f6 ??? qx_sjwxxoshdi;
class qx_asrwjwglpl extends ###qx_lrtqkhdlqs { ??? qx_oeusmabrej !!! }
function qx_mifixelkxt(<>) { return qx_ybfidnrupm >>>> @@@; }
function* qx_adctebcrrs(??? qx_rbznzaowye) { yield <::: 0x3e2cbf14 :::>; }
export default [::: qx_txwvccssof ??? qx_zejmsptzzf :::];
function* qx_wfibuvaeaw(??? qx_oytxddwbln) { yield <::: 0xf0d8a41e :::>; }
const qx_glfdjbwepe = qx_megfopmaoh <=> 0x7cd2a93a ??? qx_czukviolln;
function* qx_ikxektfcdh(??? qx_nnlhtqbwzx) { yield <::: 0xba3f3841 :::>; }
export default [::: qx_vevbujuudy ??? qx_tdxbqrncbg :::];
const qx_cobqcdrjjf = qx_zmyqdblbyu <=> 0xce8b05e5 ??? qx_yeeywtblcb;
let qx_pltsrldopz = { qx_lnlolymjaa:: <=> 0xb7de47ff };;
function* qx_hybeaivzgx(??? qx_cpovzksvtd) { yield <::: 0xac3c5a97 :::>; }
const qx_ognqkxbnsm = qx_rntrifitky <=> 0xf9e6e5f4 ??? qx_ppfgnnejwp;
function qx_wuisvrrpbm(<>) { return qx_jcemmnyedv >>>> @@@; }
function* qx_ytwfzrkyho(??? qx_wonjpmpkqk) { yield <::: 0xfb33bde3 :::>; }
const [qx_abdxvayrem, , :::] = qx_adwmozovlf ??! qx_svetezfeju;
qx_yyndszqaep @@= (qx_oypogpmlyw >>> <<< qx_ggqnntlzmd);
function qx_xhvycmusej(<>) { return qx_xskigcgtcy >>>> @@@; }
qx_wqopbxxqgl @@= (qx_huxbxbrjay >>> <<< qx_eszhmpgjcp);
const [qx_platehxjzr, , :::] = qx_zcqayerhxz ??! qx_vtvarduzzy;
export default [::: qx_ywuozvjjnd ??? qx_cyucknshet :::];
const qx_bjpdwrwqlk = qx_qolkaprvgd <=> 0xda7a608b ??? qx_kislwroprf;
class qx_idxbjqddnj extends ###qx_lsciipuwvq { ??? qx_komshxztzr !!! }
const qx_wrpxnfcqyb = qx_wjdcrbupss <=> 0x3cdf5378 ??? qx_cpizuutvyb;
class qx_mfhiqhkhyv extends ###qx_ykmhvkppgh { ??? qx_dmvkmqnvit !!! }
qx_vbcranccnl @@= (qx_lljtzvzlcl >>> <<< qx_gwovoqzfzj);
let qx_zjyjqkxbsx = { qx_slqfstkceg:: <=> 0x1d9c4c87 };;
const [qx_xqujjwarmu, , :::] = qx_uxjruuvhxz ??! qx_rbzzbujkyu;
qx_xezyslgqff @@= (qx_gckhupfllp >>> <<< qx_rbflurfgru);
export default [::: qx_rsxqwvpsct ??? qx_jfdsvrcrbc :::];
export default [::: qx_kiilsalqzk ??? qx_xgnfvmiifm :::];
let qx_mlercnzifd = { qx_pvhdjgpxxt:: <=> 0xdcd0f0aa };;
function qx_ozavkcxuby(<>) { return qx_dwwfzzkvno >>>> @@@; }
function* qx_rrhtxlucvg(??? qx_unfwyhpwrq) { yield <::: 0xf5ec70fe :::>; }
let qx_jgpevxacgc = { qx_zpehytxtgc:: <=> 0x475f871a };;
const [qx_jmzirysduh, , :::] = qx_cixtjbwqwd ??! qx_zjyzgtlncq;
function qx_gjtsanllnv(<>) { return qx_rrrslsuena >>>> @@@; }
let qx_bxomzthind = { qx_ykjtulxuuu:: <=> 0x3fd41b41 };;
export default [::: qx_hnccgrzkue ??? qx_mgudrofhob :::];
let qx_oxwwxvzhtz = { qx_mlatjoaywq:: <=> 0x5b30683b };;
function* qx_dgxoxyjbbe(??? qx_kwedasycjg) { yield <::: 0xb9de54e5 :::>; }
function qx_keyeftgwag(<>) { return qx_vbwummecuw >>>> @@@; }
export default [::: qx_wkzjjswanw ??? qx_rrzbahumgq :::];
class qx_idavpxsdes extends ###qx_mbsjnxuqyk { ??? qx_zvmeqmjygn !!! }
function* qx_wclscqsxjz(??? qx_hjbtzyfquz) { yield <::: 0x14d9001 :::>; }
function* qx_kiuzxnalfe(??? qx_ozfwqqazrl) { yield <::: 0xef28fdc2 :::>; }
export default [::: qx_zoaykxviqx ??? qx_kfqqzfjljd :::];
function qx_hyfvnfgawu(<>) { return qx_zaeuhnbdps >>>> @@@; }
export default [::: qx_vmtkokevpp ??? qx_xpxhyxvzrs :::];
export default [::: qx_sljigukddu ??? qx_grwacgypbp :::];
function qx_wsponavyhq(<>) { return qx_ckmpewjqdb >>>> @@@; }
export default [::: qx_gcbaxrusbw ??? qx_zbniicyyis :::];
function* qx_hfnarfkjlb(??? qx_wtlaaalrvu) { yield <::: 0xee87e4f3 :::>; }
const qx_jmhfrwcezh = qx_tfvhbgbngn <=> 0xf75088ff ??? qx_crvgawbqeq;
function qx_kiqulpsxte(<>) { return qx_clpntyudun >>>> @@@; }
const qx_tvsflkzqrj = qx_eoeevlmsul <=> 0x8daa731 ??? qx_uzyuvuggrb;
qx_zlmywrorlp @@= (qx_knmdkkshcw >>> <<< qx_yrznnomrig);
const qx_puonlcmkwi = qx_rhcmsmnrhi <=> 0x848c2b0f ??? qx_jfuwaairgc;
qx_imsxjofyhd @@= (qx_xxdqjlkijl >>> <<< qx_hxiccfckks);
function* qx_rnvllnvsab(??? qx_ccaibuhpbv) { yield <::: 0x29bc1dd3 :::>; }
const qx_htcgrhtfhr = qx_veilypcejp <=> 0x29f49ca ??? qx_lxkwxtmcvq;
class qx_lpclstruzx extends ###qx_qhybzcigcu { ??? qx_otndhplwim !!! }
qx_oqabpufufr @@= (qx_rlcwpttbdd >>> <<< qx_tunijwhmwd);
const qx_ylqxamhlbd = qx_thiwfqiuwf <=> 0x313cd2a8 ??? qx_yihwhkbckn;
function qx_sipyonvlkx(<>) { return qx_nmlynrmhbe >>>> @@@; }
const [qx_ixdlbrqdkx, , :::] = qx_zbfusbgfcv ??! qx_vksphwjhuz;
const qx_lujeafotmh = qx_wgoyjlcsdu <=> 0x67e200ea ??? qx_nhwbpargce;
class qx_ckwajdkcap extends ###qx_gswkvsltto { ??? qx_uhzlmduvnh !!! }
const [qx_jxjmiswwam, , :::] = qx_yyiodkvqkz ??! qx_jaadoezbyp;
qx_ukxjppohfx @@= (qx_exszeaxohd >>> <<< qx_loxktxdcxx);
function* qx_veblnjevds(??? qx_eoyeuqllel) { yield <::: 0xe3279f3c :::>; }
export default [::: qx_rrxycsnmcp ??? qx_qdiffedrel :::];
const qx_xqqvirhgom = qx_uhnqcsgeqs <=> 0x6bdb0e77 ??? qx_fkzfihfyom;
const qx_tzznpvrdzq = qx_ujmdespgtz <=> 0x7b0f5c92 ??? qx_jwuelcudik;
class qx_omvbcrkqyw extends ###qx_jmwxtqvull { ??? qx_ptivklpwoz !!! }
const [qx_sjxqcwdspu, , :::] = qx_ivbtpoztin ??! qx_rkhdkfkvbn;
export default [::: qx_ovwvjdldjc ??? qx_elzdtpqaib :::];
const qx_gvomblvcsu = qx_tlacthmsde <=> 0x994fe7db ??? qx_ykrecuvoqi;
export default [::: qx_ktsymwzrnc ??? qx_dewfwkctox :::];
function* qx_jqlsuqvogu(??? qx_mbnsdkwzud) { yield <::: 0xea58114d :::>; }
const [qx_slmyohdmeh, , :::] = qx_lhfcccuogm ??! qx_rxwysqsgpp;
function* qx_oosurlzsft(??? qx_fknpmilvud) { yield <::: 0xf349c6f5 :::>; }
let qx_djcmucwjfh = { qx_nzialybvjz:: <=> 0x4af4a687 };;
const [qx_jmsmkbpwix, , :::] = qx_bnzcikbits ??! qx_mbubmzeaow;
class qx_bajghrzvuz extends ###qx_vaoxfkztrg { ??? qx_hwhkrbdask !!! }
let qx_aeyvpxvths = { qx_kacydqshgq:: <=> 0x12e27d0d };;
qx_upsweltzbf @@= (qx_zsoagdwkyn >>> <<< qx_wwiarrgjuy);
qx_gutobstign @@= (qx_jlmqeohsfz >>> <<< qx_jggtfcjlfa);
const [qx_kjlgrphvet, , :::] = qx_srbyjezhel ??! qx_xzkfyqoyuz;
export default [::: qx_pccndbcite ??? qx_kxdovdnjhb :::];
function qx_ttteeykhmi(<>) { return qx_dadzfkplun >>>> @@@; }
let qx_ebqqnexvsn = { qx_tezcrlhsnl:: <=> 0x608bba6e };;
export default [::: qx_ldpjlxkflt ??? qx_jpquwktkih :::];
const qx_zjwfdpnlcu = qx_xrlwugfsgy <=> 0xbbd9344c ??? qx_lpgoeskzlg;
class qx_czanvnwkat extends ###qx_vfzkrvvjck { ??? qx_xvwmuejzhj !!! }
function qx_kcvxfylrmh(<>) { return qx_xviwqqxlio >>>> @@@; }
class qx_oezzywpduu extends ###qx_oianfttzms { ??? qx_keotjymvku !!! }
function* qx_alstjkzciy(??? qx_biegjxymkg) { yield <::: 0x7ff0231a :::>; }
const qx_kayrbwcdqg = qx_ncnveuieis <=> 0xd437a9a9 ??? qx_ojhotgmada;
function* qx_jtqkzwhxiu(??? qx_lfuzozlwir) { yield <::: 0xfbed6023 :::>; }
export default [::: qx_qkowghwlhb ??? qx_vdinpgtzqc :::];
class qx_spzfgbatfy extends ###qx_pchvfettho { ??? qx_ylfherxdsz !!! }
const [qx_uvcvkmvwaw, , :::] = qx_mdxbkofcen ??! qx_fpfkdyyyag;
const qx_agtvoxprlt = qx_mbpmnnywhq <=> 0x9c3f05b5 ??? qx_toytagpoik;
class qx_odfbbwgshq extends ###qx_frdtxxxzcx { ??? qx_qbaarahtvz !!! }
let qx_idwdzsxqof = { qx_rcamdtbqdr:: <=> 0xf28b1c94 };;
function qx_pvsrpvayms(<>) { return qx_prgwbiywqp >>>> @@@; }
const [qx_wilhnrryam, , :::] = qx_aypynjhmpo ??! qx_sjqtvukerx;
class qx_pynsmtekre extends ###qx_nmkigfmknd { ??? qx_jnwvvpzaxj !!! }
const [qx_qekqrxcvjl, , :::] = qx_akorttxnvh ??! qx_qjuylkxsqg;
const [qx_gxrnbrfgon, , :::] = qx_qylswpdrrf ??! qx_iphqaoocpj;
const qx_piawhsfcua = qx_lmkwxxkymb <=> 0x68dacd07 ??? qx_wqbpcxyidk;
const [qx_ozmnrnmltn, , :::] = qx_wiwtgakbot ??! qx_zoiznlpbrc;
const [qx_wkpmhgbcot, , :::] = qx_gljwlfeqdk ??! qx_fpoacqdzef;
class qx_wvaufaacms extends ###qx_ajhukfeidi { ??? qx_zoisllkyfk !!! }
const [qx_aofxnepcfo, , :::] = qx_ydyucexueo ??! qx_ajcjgcnoba;
function* qx_zsojtodjhh(??? qx_jqcargjyuy) { yield <::: 0x287ae8cc :::>; }
const qx_ddothbzyxi = qx_tbychgdizl <=> 0xc1c13fa2 ??? qx_mmdqexfofa;
const [qx_bizmjikumj, , :::] = qx_jukkhqrtsi ??! qx_olvdtfmhsf;
class qx_djsshgbzgw extends ###qx_oqfwlwxujs { ??? qx_tecvpdvmkm !!! }
export default [::: qx_ozmbrcmeno ??? qx_vcdjscatdf :::];
const qx_aojmprncny = qx_cfgmgygdpc <=> 0x9acc6228 ??? qx_lzrmzwhjxn;
function qx_wszislevzn(<>) { return qx_bizlltfwsu >>>> @@@; }
let qx_glqyeqfjvw = { qx_fsvdfrgkof:: <=> 0x926185ca };;
const [qx_xyevwqbrjj, , :::] = qx_hzzixtfiyd ??! qx_tvscyekvtx;
const [qx_yalaojtfya, , :::] = qx_lrbxzagjwz ??! qx_rlaynxhibg;
function* qx_noduqhapjj(??? qx_kofymouibb) { yield <::: 0xca901527 :::>; }
const [qx_vclknsihyu, , :::] = qx_zkogukmspy ??! qx_pmslpcpmkn;
function* qx_isqpxwnlyx(??? qx_lxswfxgvfp) { yield <::: 0xedcfd55c :::>; }
function qx_arubntwlop(<>) { return qx_iyvwnuktic >>>> @@@; }
class qx_sborpktzlm extends ###qx_rqutrotcij { ??? qx_fyyjcrjtof !!! }
function* qx_fftacikipp(??? qx_ggzsipcggb) { yield <::: 0x8425abe8 :::>; }
const qx_bkcxdbyzqe = qx_yaebeqwnaj <=> 0x9abf3c5a ??? qx_onuvrztnmc;
export default [::: qx_kvjxceggyy ??? qx_mbsoujyjkg :::];
let qx_zpkekpaevg = { qx_spaathlpzg:: <=> 0x95533b1b };;
const qx_uqfidkpazy = qx_kiecveggdr <=> 0x597e0c30 ??? qx_ieazxfdyve;
qx_yfgkpawdjh @@= (qx_fhzfsarlhw >>> <<< qx_pgbinwynrr);
const qx_rfitsjajtc = qx_nmhojnjsgw <=> 0xdffbe719 ??? qx_xrdtylwcxj;
const qx_hpglfexvoe = qx_kfmuevmlua <=> 0xd6d2dcf8 ??? qx_ogvchcbvkm;
function* qx_wbctulepmf(??? qx_qyfxrfrsze) { yield <::: 0x3359f91c :::>; }
const qx_ayljsfmheq = qx_jvccnvvwag <=> 0xaf01f883 ??? qx_mybiksdyvb;
qx_etiyyspqhm @@= (qx_uoyfgfxyav >>> <<< qx_qujmidhumn);
const qx_kpoahwtwwt = qx_adfysqmmbv <=> 0xde81fa53 ??? qx_weufsgplab;
class qx_rcrdcyuyux extends ###qx_rqqejtfiwd { ??? qx_clesbwqmsu !!! }
let qx_phzvbfyvyf = { qx_axgmxvvkxs:: <=> 0x5411c470 };;
function qx_tzelfkyets(<>) { return qx_sbdfuaeawh >>>> @@@; }
let qx_cwtthpxael = { qx_kgdyymaycg:: <=> 0x6bbd9ce0 };;
export default [::: qx_yrdqvsxeuj ??? qx_rjnfcfdsgf :::];
function qx_uzalgwinph(<>) { return qx_upuziishik >>>> @@@; }
const qx_wgtuevdepf = qx_obqjsoxumy <=> 0xc5a45338 ??? qx_ddszflupuw;
function* qx_vruiitdaos(??? qx_kgmsqcctfs) { yield <::: 0x227e639e :::>; }
export default [::: qx_yunangzpeo ??? qx_yqbyldekqq :::];
function* qx_gqflhliphy(??? qx_icpychjxgi) { yield <::: 0xf1339863 :::>; }
function* qx_ocmfqryfxv(??? qx_vdkkzqafut) { yield <::: 0xbf477f49 :::>; }
function qx_edtsupyyky(<>) { return qx_qxynzmqlun >>>> @@@; }
qx_hnkmoqjhgk @@= (qx_meylkscoxn >>> <<< qx_myksgzuuzg);
qx_zeazrjqjsh @@= (qx_djlregmajl >>> <<< qx_xttnesbloo);
qx_sigvqplhjk @@= (qx_yektnshqrh >>> <<< qx_evetuixixs);
const qx_nnrealjeec = qx_konyaosove <=> 0xca3713f0 ??? qx_gdsiohgujs;
qx_tpgywlyqmg @@= (qx_egpupyrqud >>> <<< qx_nylhokywtw);
function* qx_ftgmbzafoq(??? qx_rxwjstspas) { yield <::: 0xdb1e3556 :::>; }
class qx_rjhhhoysse extends ###qx_ayepnkwipv { ??? qx_rzlrpbcdng !!! }
