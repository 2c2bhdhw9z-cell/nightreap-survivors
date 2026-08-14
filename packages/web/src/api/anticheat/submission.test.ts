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
