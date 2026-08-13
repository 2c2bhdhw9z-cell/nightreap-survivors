/**
 * Payout self-check. Run headless: `bun packages/mobile/game/save/payout.test.ts`
 *
 * The failures this file exists to prevent are all of the same shape: a number the player can see going
 * wrong in a way the game never admits to. Gold that wraps to nothing at the u32 ceiling. A run banked
 * twice. A refusal that still moved half the profile. A "new record" announced for equalling the old one.
 *
 * WHAT IT PROVES
 *   1. An ordinary run banks exactly what it earned, and the receipt agrees with the save.
 *   2. Every kind of nonsense in a delta is refused by name, and refusing changes nothing at all.
 *   3. A profile that already holds nonsense is refused rather than extended.
 *   4. Totals pin at the ceiling instead of wrapping, and the receipt says they were pinned.
 *   5. Best time is a high-water mark: strictly greater wins, equal is not a record.
 *   6. Taint accumulates and never clears.
 *   7. Banking twice pays twice — proving the guard against that has to live at the door, as documented.
 *   8. The two formatters agree with themselves at every boundary that shows on screen.
 */

import { createProfileDelta, profileDeltaFor, RunSummary, RUN_END } from "../sim/results";
import { PAYOUT, U32_MAX, bankRun, createPayoutReceipt, describePayout, formatDuration, formatGold } from "./payout";
import { createSaveData } from "./schema";

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

/** A profile with a little history already in it, so additions have something to add to. */
function profile() {
  const save = createSaveData(0xabcd, 1);
  save.gold = 500;
  save.goldLifetime = 5000;
  save.runsStarted = 20;
  save.runsCompleted = 3;
  save.secondsPlayed = 9000;
  save.bestSurvivalSeconds = 600;
  save.everTainted = 0b0010;
  return save;
}

/** A delta for an ordinary finished run. */
function run(gold = 340, seconds = 725, completed = 1) {
  const delta = createProfileDelta();
  delta.gold = gold;
  delta.runsStarted = 1;
  delta.runsCompleted = completed;
  delta.secondsPlayed = seconds;
  delta.bestSurvivalSeconds = seconds;
  delta.everTainted = 0;
  return delta;
}

/** Every field banking touches, as a comparable string. Used to prove a refusal changed nothing. */
function fingerprint(save: ReturnType<typeof profile>): string {
  return [
    save.gold,
    save.goldLifetime,
    save.runsStarted,
    save.runsCompleted,
    save.secondsPlayed,
    save.bestSurvivalSeconds,
    save.everTainted,
  ].join("/");
}

// ----------------------------------------------------------------- ordinary run

section("an ordinary run banks what it earned");
{
  const save = profile();
  const receipt = bankRun(save, run(340, 725), createPayoutReceipt());

  check("it is banked", receipt.code === PAYOUT.OK && receipt.banked, describePayout(receipt.code));
  check("gold is added", save.gold === 840, `${save.gold}`);
  check("lifetime gold is added too", save.goldLifetime === 5340, `${save.goldLifetime}`);
  check("the run is counted as started", save.runsStarted === 21, `${save.runsStarted}`);
  check("and as completed", save.runsCompleted === 4, `${save.runsCompleted}`);
  check("time played accumulates", save.secondsPlayed === 9725, `${save.secondsPlayed}`);
  check("a new best time is taken", save.bestSurvivalSeconds === 725, `${save.bestSurvivalSeconds}`);

  check("the receipt's earning matches", receipt.goldEarned === 340, `${receipt.goldEarned}`);
  check("the receipt knows where gold started", receipt.goldBefore === 500, `${receipt.goldBefore}`);
  check("the receipt agrees with the save", receipt.goldAfter === save.gold, `${receipt.goldAfter}`);
  check("the receipt reports the record", receipt.newBestTime);
  check("and the previous best, for the screen", receipt.bestSecondsBefore === 600);
  check("nothing was capped", !receipt.goldCapped && !receipt.lifetimeCapped && !receipt.timeCapped);
  check("no bad field is named", receipt.badField === "", receipt.badField);
}

section("a quit run still pays");
{
  const save = profile();
  const receipt = bankRun(save, run(120, 300, 0), createPayoutReceipt());
  check("gold and time are kept", save.gold === 620 && save.secondsPlayed === 9300, `${save.gold}`);
  check("but it is not counted as completed", save.runsCompleted === 3, `${save.runsCompleted}`);
  check("it is still counted as started", save.runsStarted === 21, `${save.runsStarted}`);
  check("and it is banked", receipt.banked);
}

section("a run that earned nothing");
{
  const save = profile();
  const before = fingerprint(save);
  const receipt = bankRun(save, run(0, 0, 0), createPayoutReceipt());
  check("is still banked", receipt.code === PAYOUT.OK && receipt.banked);
  check("counts as a started run", save.runsStarted === 21, `${save.runsStarted}`);
  check("and does not claim a record", !receipt.newBestTime);
  check("so the profile did change", fingerprint(save) !== before);
}

// -------------------------------------------------------------------- refusals

section("nonsense in a run is refused by name");
{
  const cases: [string, number, keyof ReturnType<typeof run>, number][] = [
    ["negative gold", PAYOUT.NEGATIVE, "gold", -1],
    ["fractional gold", PAYOUT.FRACTIONAL, "gold", 10.5],
    ["gold of NaN", PAYOUT.NOT_FINITE, "gold", Number.NaN],
    ["infinite gold", PAYOUT.NOT_FINITE, "gold", Number.POSITIVE_INFINITY],
    ["absurd gold", PAYOUT.ABSURD, "gold", U32_MAX + 1],
    ["negative seconds", PAYOUT.NEGATIVE, "secondsPlayed", -5],
    ["fractional seconds", PAYOUT.FRACTIONAL, "secondsPlayed", 12.25],
    ["negative runs started", PAYOUT.NEGATIVE, "runsStarted", -1],
  ];
  for (const [name, code, field, value] of cases) {
    const save = profile();
    const before = fingerprint(save);
    const delta = run();
    (delta as unknown as Record<string, number>)[field as string] = value;
    const receipt = bankRun(save, delta, createPayoutReceipt());
    check(`${name} is refused`, receipt.code === code, describePayout(receipt.code));
    check(`  and nothing is banked`, !receipt.banked && fingerprint(save) === before);
    check(`  and the field is named`, receipt.badField === String(field), receipt.badField);
  }
}

section("a NaN is not mistaken for a fraction");
{
  // Number.isInteger(NaN) is false, so a naive order of checks sends a NaN bug report chasing rounding.
  const save = profile();
  const delta = run();
  delta.gold = Number.NaN;
  const receipt = bankRun(save, delta, createPayoutReceipt());
  check("it reports NOT_FINITE", receipt.code === PAYOUT.NOT_FINITE, describePayout(receipt.code));
}

section("a profile already holding nonsense is refused");
{
  for (const field of ["gold", "goldLifetime", "secondsPlayed", "bestSurvivalSeconds"] as const) {
    const save = profile();
    save[field] = -7;
    const receipt = bankRun(save, run(), createPayoutReceipt());
    check(`a broken ${field} refuses the payout`, receipt.code === PAYOUT.BAD_PROFILE, describePayout(receipt.code));
    check(`  and names it`, receipt.badField === field, receipt.badField);
  }
  const save = profile();
  save.gold = Number.NaN;
  const receipt = bankRun(save, run(), createPayoutReceipt());
  check("a NaN balance refuses too", receipt.code === PAYOUT.BAD_PROFILE);
  check("and the run's gold is not added to it", !receipt.banked);
}

section("a refusal leaves the profile byte-identical");
{
  const save = profile();
  const before = fingerprint(save);
  const delta = run();
  // Something wrong late in the field list, so any early write would show.
  delta.bestSurvivalSeconds = -1;
  bankRun(save, delta, createPayoutReceipt());
  check("every field is unchanged", fingerprint(save) === before, fingerprint(save));
}

// ---------------------------------------------------------------- the ceiling

section("totals pin at the ceiling instead of wrapping");
{
  const save = profile();
  save.gold = U32_MAX - 10;
  const receipt = bankRun(save, run(500, 10), createPayoutReceipt());
  check("it is still banked", receipt.banked);
  check("gold stops at the ceiling", save.gold === U32_MAX, `${save.gold}`);
  check("and does not wrap to nothing", save.gold > 1000, `${save.gold}`);
  check("the receipt admits it was capped", receipt.goldCapped);
  check("the receipt's total matches the save", receipt.goldAfter === save.gold);
}

section("lifetime gold caps independently of the balance");
{
  const save = profile();
  save.goldLifetime = U32_MAX;
  const receipt = bankRun(save, run(100, 10), createPayoutReceipt());
  check("lifetime is pinned", save.goldLifetime === U32_MAX, `${save.goldLifetime}`);
  check("and says so", receipt.lifetimeCapped);
  check("but the spendable balance still grew", save.gold === 600, `${save.gold}`);
  check("and that one is not marked capped", !receipt.goldCapped);
}

section("time played caps as well");
{
  const save = profile();
  save.secondsPlayed = U32_MAX;
  const receipt = bankRun(save, run(10, 60), createPayoutReceipt());
  check("seconds pin", save.secondsPlayed === U32_MAX, `${save.secondsPlayed}`);
  check("and say so", receipt.timeCapped);
}

section("exactly reaching the ceiling is not a cap");
{
  const save = profile();
  save.gold = U32_MAX - 100;
  const receipt = bankRun(save, run(100, 10), createPayoutReceipt());
  check("the total is exact", save.gold === U32_MAX, `${save.gold}`);
  check("and it is not reported as capped", !receipt.goldCapped);
}

// --------------------------------------------------------------- the best time

section("best time is a high-water mark");
{
  const worse = profile();
  const r1 = bankRun(worse, run(10, 599), createPayoutReceipt());
  check("a worse run does not lower the record", worse.bestSurvivalSeconds === 600, `${worse.bestSurvivalSeconds}`);
  check("and does not claim one", !r1.newBestTime);
  check("but the receipt still reports the standing best", r1.bestSecondsAfter === 600);

  const equal = profile();
  const r2 = bankRun(equal, run(10, 600), createPayoutReceipt());
  check("equalling the record is not a new record", !r2.newBestTime);
  check("and leaves it alone", equal.bestSurvivalSeconds === 600);

  const better = profile();
  const r3 = bankRun(better, run(10, 601), createPayoutReceipt());
  check("one second more is a record", r3.newBestTime);
  check("and it is stored", better.bestSurvivalSeconds === 601, `${better.bestSurvivalSeconds}`);
}

// -------------------------------------------------------------------- taint

section("taint accumulates and never clears");
{
  const save = profile();
  const delta = run();
  delta.everTainted = 0b0100;
  bankRun(save, delta, createPayoutReceipt());
  check("the new bit is set", (save.everTainted & 0b0100) !== 0, save.everTainted.toString(2));
  check("the old bit survives", (save.everTainted & 0b0010) !== 0, save.everTainted.toString(2));

  const clean = profile();
  const noTaint = run();
  noTaint.everTainted = 0;
  bankRun(clean, noTaint, createPayoutReceipt());
  check("a clean run does not clear history", clean.everTainted === 0b0010, clean.everTainted.toString(2));
}

// -------------------------------------------------------- banking twice pays twice

section("banking twice pays twice, which is why the caller must not");
{
  const save = profile();
  const receipt = createPayoutReceipt();
  bankRun(save, run(100, 60), receipt);
  bankRun(save, run(100, 60), receipt);
  check("gold was added both times", save.gold === 700, `${save.gold}`);
  check("and the run counted twice", save.runsStarted === 22, `${save.runsStarted}`);
  check("the receipt reports the second payment only", receipt.goldBefore === 600, `${receipt.goldBefore}`);
}

section("a receipt can be reused without leaking the previous verdict");
{
  const receipt = createPayoutReceipt();
  const capped = profile();
  capped.gold = U32_MAX;
  bankRun(capped, run(50, 10), receipt);
  check("first payout is capped", receipt.goldCapped);

  const fresh = profile();
  bankRun(fresh, run(50, 10), receipt);
  check("the second is not still marked capped", !receipt.goldCapped);
  check("nor still marked a record when it is not", !receipt.newBestTime);

  const bad = profile();
  const delta = run();
  delta.gold = -1;
  bankRun(bad, delta, receipt);
  check("a refusal clears banked", !receipt.banked);
  const good = profile();
  bankRun(good, run(), receipt);
  check("and a later success clears the bad field", receipt.badField === "");
}

// ----------------------------------------------------- wired to a real summary

section("a real run summary flows through to the profile");
{
  const summary = new RunSummary();
  summary.gold = 275;
  summary.ticks = 903 * 60;
  summary.end = RUN_END.survived;
  summary.tainted = 0;
  const delta = profileDeltaFor(summary, createProfileDelta());
  const save = profile();
  const receipt = bankRun(save, delta, createPayoutReceipt());
  check("it banks", receipt.banked, describePayout(receipt.code));
  check("the gold on screen is the gold banked", receipt.goldEarned === summary.gold, `${receipt.goldEarned}`);
  check("a survived run counts as completed", save.runsCompleted === 4, `${save.runsCompleted}`);
  check("and its time becomes the record", save.bestSurvivalSeconds === 903, `${save.bestSurvivalSeconds}`);
}

// ------------------------------------------------------------------ formatting

section("durations read the way a player expects");
{
  const cases: [number, string][] = [
    [0, "0:00"],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [61, "1:01"],
    [90, "1:30"],
    [600, "10:00"],
    [1800, "30:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [7325, "2:02:05"],
  ];
  for (const [seconds, want] of cases) {
    const got = formatDuration(seconds);
    check(`${seconds}s reads as ${want}`, got === want, got);
  }
  check("a fraction of a second is truncated", formatDuration(90.9) === "1:30", formatDuration(90.9));
  check("nonsense reads as zero", formatDuration(Number.NaN) === "0:00");
  check("negative reads as zero", formatDuration(-5) === "0:00");
}

section("gold reads with separators");
{
  const cases: [number, string][] = [
    [0, "0"],
    [7, "7"],
    [99, "99"],
    [100, "100"],
    [999, "999"],
    [1000, "1,000"],
    [1001, "1,001"],
    [12345, "12,345"],
    [123456, "123,456"],
    [1234567, "1,234,567"],
    [U32_MAX, "4,294,967,295"],
  ];
  for (const [amount, want] of cases) {
    const got = formatGold(amount);
    check(`${amount} reads as ${want}`, got === want, got);
  }
  check("a fraction is truncated", formatGold(1234.9) === "1,234", formatGold(1234.9));
  check("nonsense reads as zero", formatGold(Number.NaN) === "0");
}

section("the refusal codes are usable in a bug report");
{
  const seen = new Set<number>();
  for (const value of Object.values(PAYOUT)) {
    check(`${describePayout(value)} has a distinct number`, !seen.has(value), `${value}`);
    seen.add(value);
    check(`  and a name`, describePayout(value) !== "UNKNOWN", describePayout(value));
  }
  check("an unknown code does not crash", describePayout(999) === "UNKNOWN");
}

console.log();
if (failures > 0) {
  console.log(`FAIL — ${failures} check${failures === 1 ? "" : "s"} failed`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`payout: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log("PASS — run payout");
