/**
 * Base64. Headless: `bun packages/mobile/game/save/base64.test.ts`
 *
 * This sits directly under the save file, so a rounding error here is a lost save. It is checked against
 * the platform's own implementation for every length from nothing to a kilobyte, which is the only way
 * to be sure "by hand" means "the same as everyone else's".
 *
 * WHAT IT PROVES
 *   1. It agrees with a known-correct implementation, at every length and every alignment.
 *   2. Every byte value survives the trip, including zero and 255.
 *   3. A real save-sized blob round-trips exactly.
 *   4. Padding is right, so anything else can read what we wrote.
 *   5. Rubbish decodes to something rather than throwing, because throwing inside a load loses a save.
 *
 * Exits non-zero on any failure.
 */

import { fromBase64, toBase64 } from "./base64";

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

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** A deterministic byte pattern — no randomness, so a failure is reproducible. */
function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed | 1;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */

section("it agrees with the platform, at every length");
{
  // Bun has a correct implementation. The phone does not, which is why ours exists — but the phone's
  // absence is no excuse for being different.
  const reference = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

  let mismatched = 0;
  let firstBad = -1;
  for (let n = 0; n <= 1024; n++) {
    const bytes = pattern(n, n + 7);
    if (toBase64(bytes) !== reference(bytes)) {
      mismatched++;
      if (firstBad < 0) firstBad = n;
    }
  }
  check("every length from 0 to 1024 encodes identically", mismatched === 0, `${mismatched} wrong, first at ${firstBad}`);

  let broken = 0;
  for (let n = 0; n <= 1024; n++) {
    const bytes = pattern(n, n + 31);
    if (!same(fromBase64(toBase64(bytes)), bytes)) broken++;
  }
  check("and every length round-trips", broken === 0, `${broken}`);

  let cannotRead = 0;
  for (let n = 0; n <= 256; n++) {
    const bytes = pattern(n, n + 99);
    if (!same(fromBase64(reference(bytes)), bytes)) cannotRead++;
  }
  check("we can read what the platform wrote", cannotRead === 0, `${cannotRead}`);
}

section("every byte value survives");
{
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  check("all 256 values round-trip", same(fromBase64(toBase64(all)), all));
  check("a run of zeroes survives", same(fromBase64(toBase64(new Uint8Array(64))), new Uint8Array(64)));
  const ones = new Uint8Array(64).fill(255);
  check("a run of 255s survives", same(fromBase64(toBase64(ones)), ones));
  check("nothing encodes to nothing", toBase64(new Uint8Array(0)) === "");
  check("and back again", fromBase64("").length === 0);
}

section("padding is right");
{
  check("one byte pads twice", toBase64(new Uint8Array([0x66])) === "Zg==");
  check("two bytes pad once", toBase64(new Uint8Array([0x66, 0x6f])) === "Zm8=");
  check("three bytes need no padding", toBase64(new Uint8Array([0x66, 0x6f, 0x6f])) === "Zm9v");
  check("a length divisible by three never pads", toBase64(pattern(300, 5)).endsWith("=") === false);
  check("the encoded length is always a multiple of four", toBase64(pattern(301, 5)).length % 4 === 0);
}

section("a save-sized blob, exactly");
{
  const save = pattern(4096, 1234);
  const text = toBase64(save);
  check("it grew by about a third, as base64 does", text.length > save.length && text.length < save.length * 1.4, `${text.length}`);
  check("and came back byte for byte", same(fromBase64(text), save));
  check("nothing in the string would break a key-value store", /^[A-Za-z0-9+/=]+$/.test(text));
}

section("rubbish decodes rather than throwing");
{
  check("whitespace is ignored", same(fromBase64("Zm9v\n"), fromBase64("Zm9v")));
  check("so are spaces in the middle", same(fromBase64("Zm 9v"), fromBase64("Zm9v")));
  check("an emoji in the middle is skipped, not fatal", fromBase64("Zm🦇9v").length === 3);
  check("a lone character decodes to nothing rather than half a byte", fromBase64("Z").length === 0);
  check("total nonsense is empty, not an exception", fromBase64("!!!! ???").length === 0);
  check("a truncated string still gives back what it can", fromBase64("Zm9").length === 2);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks`);
if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
}
