import { lengthText, sizeText, tagsFor, wasKept, whenText } from "./runs-text";

/**
 * Checks for the words the operator's run list puts on screen.
 *
 * These are the sentences somebody will quote in an appeal, so they are pinned exactly rather than eyeballed
 * in a browser. The screen itself is checked separately by driving a real browser against real stored runs;
 * this file is the fast half that runs anywhere.
 */

let failures = 0;

function ok(name: string, condition: boolean, saw?: unknown): void {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${name}${saw === undefined ? "" : ` :: saw ${String(saw)}`}`);
}

function eq(name: string, saw: unknown, want: unknown): void {
  ok(`${name} (wanted ${String(want)})`, saw === want, saw);
}

/* ---------------------------------------------------------------------------------------------- */
/* How long a run lasted                                                                           */
/* ---------------------------------------------------------------------------------------------- */

eq("a run of no length", lengthText(0), "0:00");
eq("one second", lengthText(60), "0:01");
eq("nine seconds keeps its leading zero", lengthText(60 * 9), "0:09");
eq("ten seconds does not", lengthText(60 * 10), "0:10");
eq("a full minute", lengthText(60 * 60), "1:00");
eq("the thirty minute finish", lengthText(60 * 60 * 30), "30:00");
eq("an hour reads as sixty minutes, not as one hour", lengthText(60 * 60 * 60), "60:00");
eq("part of a tick is not a second", lengthText(59), "0:00");
eq("a nonsense negative count is shown as nothing, not as minus", lengthText(-1), "0:00");

// A run one tick short of a minute must not round up to it. An operator comparing a claimed finish against
// the recording is looking for exactly this kind of off-by-one.
eq("one tick short of a minute", lengthText(60 * 60 - 1), "0:59");

/* ---------------------------------------------------------------------------------------------- */
/* How big the recording is                                                                        */
/* ---------------------------------------------------------------------------------------------- */

eq("nothing at all", sizeText(0), "0 bytes");
eq("small uploads are counted in bytes", sizeText(1023), "1023 bytes");
eq("a kilobyte turns over", sizeText(1024), "1.0 KB");
eq("a typical recording", sizeText(1130), "1.1 KB");
eq("just under a megabyte", sizeText(1024 * 1024 - 1), "1024.0 KB");
eq("a megabyte turns over", sizeText(1024 * 1024), "1.00 MB");
eq("the biggest upload allowed", sizeText(8 * 1024 * 1024), "8.00 MB");
eq("a negative size is shown as nothing", sizeText(-5), "0 bytes");

// An empty upload is the most interesting thing an attacker does in volume, so it has to read as a size
// rather than as a blank space on the row.
ok("an empty recording still reads as a size", sizeText(0).length > 0);

/* ---------------------------------------------------------------------------------------------- */
/* When it arrived                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

eq("the start of 1970", whenText(0), "1970-01-01 00:00:00");
eq("a known moment", whenText(Date.UTC(2026, 7, 14, 9, 5, 3)), "2026-08-14 09:05:03");
ok("no stray letter between the date and the time", !whenText(Date.now()).includes("T"));
ok("no fractions of a second on screen", !whenText(1_700_000_000_123).includes("."));
eq("the same moment always reads the same", whenText(1_700_000_000_000), whenText(1_700_000_000_000));

// Two operators comparing notes must be reading the same clock, not their own. The wording is fixed to the
// one clock everybody shares.
ok("the timestamp is not the machine's local wording", whenText(0) === "1970-01-01 00:00:00");

/* ---------------------------------------------------------------------------------------------- */
/* Kept or turned away                                                                             */
/* ---------------------------------------------------------------------------------------------- */

ok("nothing wrong means kept", wasKept(0));
ok("any reason at all means turned away", !wasKept(1));
ok("a high numbered reason is still a refusal", !wasKept(13));

/* ---------------------------------------------------------------------------------------------- */
/* The tags beside a row                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const plain = { refusal: 0, flagCount: 0, tainted: 0, ladderEligible: true };

eq("an ordinary kept run carries one tag", tagsFor(plain).join("|"), "Kept");
eq("a refused run says so", tagsFor({ ...plain, refusal: 4 })[0], "Turned away");

const odd = tagsFor({ ...plain, flagCount: 3 });
ok("a flagged run is tagged with how many things were odd", odd.includes("3 worth a look"), odd.join("|"));
ok("a flagged run is still shown as kept", odd.includes("Kept"), odd.join("|"));

// A flag is not a punishment and must never read like a verdict.
for (const tag of odd) {
  ok(`"${tag}" does not read as a punishment`, !/ban|cheat|guilty|banned/i.test(tag));
}

const tainted = tagsFor({ ...plain, tainted: 1 });
ok("a run played with dev tools open says so", tainted.includes("Dev tools were open"), tainted.join("|"));

const offBoard = tagsFor({ ...plain, ladderEligible: false });
ok("a kept run that cannot go on the boards says so", offBoard.includes("Not for the boards"), offBoard.join("|"));

// A refused run was never a candidate for the boards, so saying it is not eligible would be noise.
const refusedTags = tagsFor({ refusal: 7, flagCount: 0, tainted: 0, ladderEligible: false });
ok("a refused run is not also told off for missing the boards", !refusedTags.includes("Not for the boards"), refusedTags.join("|"));

const everything = tagsFor({ refusal: 0, flagCount: 12, tainted: 1, ladderEligible: false });
eq("the worst looking kept run carries all four tags", everything.length, 4);
eq("the verdict is always the first thing read", everything[0], "Kept");

// Nothing in this list may look like a button that files something. The tags describe; only the panel above
// the list can act, and only with a name and a reason attached.
for (const tag of everything) {
  ok(`"${tag}" is not phrased as an instruction`, !/^(mark|clear|dismiss|resolve|handle)/i.test(tag));
}

/* ---------------------------------------------------------------------------------------------- */

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`runs-text: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
console.log("runs-text: all checks pass");
