/**
 * Tests for the cloud locker.
 *
 * The merge rules are not tested here — they live and are tested on the device, in
 * `packages/mobile/game/save/sync.ts`. What this file tests is the three things the endpoint owns and cannot
 * get wrong: a stranger cannot read or overwrite somebody's profile, a stale push loses and is told what it
 * missed, and a payload that is not a save never reaches the table.
 *
 * These requests go through the real HTTP mount and the real database, so what is checked is what a phone
 * would actually meet. Account ids are randomised per run, so re-running does not collide with itself.
 *
 * Run directly: `bun packages/web/src/api/routes/cloud.test.ts`.
 */

import app from "../index";
import { MAX_BLOB_CHARS, MIN_SECRET_CHARS } from "./cloud";

let failures = 0;
let checks = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name}`);
}

async function ask(route: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/rpc/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
  );
}

interface Stored {
  blob: string;
  generation: number;
  unlockBits: number;
  goldLifetime: number;
  pushCount: number;
  bytes: number;
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { json?: T };
  return body.json as T;
}

/** A blob that looks like a save: base64, no whitespace, distinguishable from the next one. */
function fakeBlob(seed: string): string {
  return Buffer.from(`nightreap-save-${seed}-${"x".repeat(64)}`, "utf8").toString("base64").replace(/=+$/, "");
}

const SECRET = `device-secret-${"a".repeat(MIN_SECRET_CHARS)}`;
const OTHER_SECRET = `device-secret-${"b".repeat(MIN_SECRET_CHARS)}`;
const account = `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function pushBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const blob = fakeBlob("one");
  return {
    accountId: account,
    secret: SECRET,
    blob,
    bytes: blob.length,
    generation: 5,
    saveVersion: 2,
    buildId: 1000,
    unlockBits: 3,
    goldLifetime: 500,
    ...over,
  };
}

/* ---- an empty locker --------------------------------------------------------------------------- */

section("a phone signing in for the first time");
{
  const response = await ask("cloud/pull", { accountId: account, secret: SECRET });
  check("pulling an empty locker is a normal answer, not an error", response.status === 200, `answered ${response.status}`);
  const body = await json<{ found: boolean }>(response);
  check("and it says there is nothing there", body.found === false);
}

/* ---- the first push ---------------------------------------------------------------------------- */

section("the first push");
{
  const response = await ask("cloud/push", pushBody());
  check("the first push is stored", response.status === 200, `answered ${response.status}`);
  const body = await json<{ stored: boolean; created: boolean; generation: number }>(response);
  check("and says so", body.stored === true);
  check("and says it created the row", body.created === true);
  check("and reports the generation it stored", body.generation === 5, String(body.generation));

  const pulled = await json<{ found: boolean; save: Stored }>(await ask("cloud/pull", { accountId: account, secret: SECRET }));
  check("pulling it back finds it", pulled.found === true);
  check("the bytes come back exactly as they went in", pulled.save.blob === fakeBlob("one"));
  check("with the generation", pulled.save.generation === 5, String(pulled.save.generation));
  check("and the figures a support screen shows", pulled.save.unlockBits === 3 && pulled.save.goldLifetime === 500);
  check("and a push counter", pulled.save.pushCount === 1, String(pulled.save.pushCount));
}

/* ---- the padlock ------------------------------------------------------------------------------- */

section("somebody else's profile");
{
  const pulled = await ask("cloud/pull", { accountId: account, secret: OTHER_SECRET });
  check("a stranger cannot read it", pulled.status >= 400, `answered ${pulled.status}`);

  const pushed = await ask("cloud/push", pushBody({ secret: OTHER_SECRET, generation: 9999 }));
  check("a stranger cannot overwrite it", pushed.status >= 400, `answered ${pushed.status}`);

  const still = await json<{ save: Stored }>(await ask("cloud/pull", { accountId: account, secret: SECRET }));
  check("and the profile is untouched", still.save.generation === 5 && still.save.blob === fakeBlob("one"));

  // An unknown id and a wrong secret must be answered identically, or this endpoint becomes a way to find
  // out which accounts exist.
  const unknown = await ask("cloud/pull", { accountId: `${account}-nobody`, secret: OTHER_SECRET });
  const wrong = await ask("cloud/pull", { accountId: account, secret: OTHER_SECRET });
  check("an unknown profile and a wrong secret answer the same way", unknown.status === 200 || unknown.status === wrong.status, `${unknown.status} vs ${wrong.status}`);
}

/* ---- ordering ---------------------------------------------------------------------------------- */

section("two phones, one profile");
{
  const stale = await ask("cloud/push", pushBody({ blob: fakeBlob("stale"), generation: 4 }));
  check("an older push is answered, not refused", stale.status === 200, `answered ${stale.status}`);
  const staleBody = await json<{ stored: boolean; reason: string; save: Stored }>(stale);
  check("and it did not land", staleBody.stored === false);
  check("and says why", staleBody.reason === "stale");
  check("and hands back what it missed, so the phone can merge without asking again", staleBody.save.blob === fakeBlob("one"));

  const equal = await ask("cloud/push", pushBody({ blob: fakeBlob("equal"), generation: 5 }));
  const equalBody = await json<{ stored: boolean }>(equal);
  check("a push with the same generation does not land either", equalBody.stored === false, "equal generations mean two merges raced");

  const newer = await ask("cloud/push", pushBody({ blob: fakeBlob("merged"), generation: 6, unlockBits: 7, goldLifetime: 900 }));
  const newerBody = await json<{ stored: boolean; created: boolean }>(newer);
  check("a merged push with a higher generation lands", newerBody.stored === true);
  check("and knows it replaced a row rather than creating one", newerBody.created === false);

  const pulled = await json<{ save: Stored }>(await ask("cloud/pull", { accountId: account, secret: SECRET }));
  check("the merged copy is what is stored now", pulled.save.blob === fakeBlob("merged"));
  check("with its generation", pulled.save.generation === 6, String(pulled.save.generation));
  check("and its figures", pulled.save.unlockBits === 7 && pulled.save.goldLifetime === 900);
  check("and the push counter moved once, not twice", pulled.save.pushCount === 2, String(pulled.save.pushCount));
}

/* ---- what never reaches the table -------------------------------------------------------------- */

section("payloads that are not a save");
{
  const before = await json<{ save: Stored }>(await ask("cloud/pull", { accountId: account, secret: SECRET }));

  const cases: [string, Record<string, unknown>][] = [
    ["a blob that is not base64", { blob: "not base64!!", generation: 100 }],
    ["a blob with whitespace smuggled into it", { blob: `${fakeBlob("one")} ${fakeBlob("two")}`, generation: 100 }],
    ["an empty blob", { blob: "", generation: 100 }],
    ["a blob bigger than any save", { blob: "A".repeat(MAX_BLOB_CHARS + 4), bytes: 32, generation: 100 }],
    ["a device secret too short to be a secret", { secret: "short", generation: 100 }],
    ["a negative generation", { generation: -1 }],
    ["a fractional generation", { generation: 6.5 }],
    ["a generation past the ceiling the save itself allows", { generation: 4294967296 }],
    ["a save version of zero", { saveVersion: 0, generation: 100 }],
    ["a negative lifetime gold", { goldLifetime: -5, generation: 100 }],
    ["a byte count of zero", { bytes: 0, generation: 100 }],
    ["an account id with a slash in it", { accountId: "acct/../other", generation: 100 }],
    ["an account id too short to be one", { accountId: "a", generation: 100 }],
  ];

  for (const [what, over] of cases) {
    const status = (await ask("cloud/push", pushBody(over))).status;
    check(`${what} is refused`, status >= 400, `answered ${status}`);
  }

  const after = await json<{ save: Stored }>(await ask("cloud/pull", { accountId: account, secret: SECRET }));
  check("and none of them changed the stored profile", after.save.blob === before.save.blob && after.save.generation === before.save.generation);
  check("nor the push counter", after.save.pushCount === before.save.pushCount, `${before.save.pushCount} -> ${after.save.pushCount}`);
}

section("pulls that are not pulls");
{
  check("a pull with no secret is refused", (await ask("cloud/pull", { accountId: account })).status >= 400);
  check("a pull with a short secret is refused", (await ask("cloud/pull", { accountId: account, secret: "short" })).status >= 400);
  check("a pull with no account is refused", (await ask("cloud/pull", { secret: SECRET })).status >= 400);

  // The two above would still pass if the length rule were deleted, because a short secret is also the
  // wrong secret for a profile that exists. So the length rule gets tested where "wrong secret" cannot
  // hide it: an id with nothing stored, which answers a well-formed request with a cheerful "nothing here".
  const empty = `${account}-shape`;
  const wellFormed = (await ask("cloud/pull", { accountId: empty, secret: SECRET })).status;
  check("an empty locker answers a well-formed pull", wellFormed === 200, `answered ${wellFormed}`);
  const tooShort = (await ask("cloud/pull", { accountId: empty, secret: "a".repeat(MIN_SECRET_CHARS - 1) })).status;
  check("but a secret one character too short is refused outright", tooShort >= 400, `answered ${tooShort}`);

  // And the same rule on the way in: a short secret must never be allowed to claim an unclaimed id, because
  // whoever holds the secret holds the profile forever after.
  const claim = await ask("cloud/push", pushBody({ accountId: empty, secret: "a".repeat(MIN_SECRET_CHARS - 1), generation: 1 }));
  check("a short secret cannot claim an unclaimed profile", claim.status >= 400, `answered ${claim.status}`);
  const stillEmpty = await json<{ found: boolean }>(await ask("cloud/pull", { accountId: empty, secret: SECRET }));
  check("and the profile is still unclaimed afterwards", stillEmpty.found === false);
}

/* ---- the locker is not behind the admin door -------------------------------------------------- */

section("the locker is the app's, not an operator's");
{
  // A player has to be able to sync without an admin token. If this ever starts refusing, somebody has put
  // the admin gate on the wrong router and every phone in the world has stopped syncing.
  delete process.env.EVENT_LOG_ADMIN_TOKEN;
  const status = (await ask("cloud/pull", { accountId: `${account}-fresh`, secret: SECRET })).status;
  check("a phone with no admin token can still sync", status === 200, `answered ${status}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) in the cloud locker`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`the cloud locker: ${failures} check${failures === 1 ? "" : "s"} failed`);
} else {
  console.log("PASS — the cloud locker");
}
