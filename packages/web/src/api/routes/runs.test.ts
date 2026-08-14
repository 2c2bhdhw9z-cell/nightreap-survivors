/**
 * Tests for the run-submission endpoints.
 *
 * The judging is not tested here — it lives and is tested in `anticheat/submission.ts`, against eighteen
 * deliberate breakages. What this file tests is the four things the endpoint itself owns and cannot get
 * wrong: a stranger cannot file runs under somebody else's account, a refused upload is still stored with
 * its reason, an accepted run leaves both a row and a line in the append-only log, and the operator views
 * are behind the admin token and fail closed.
 *
 * Requests go through the real HTTP mount and the real database, so what is checked is what a phone and an
 * operator would actually meet. Account ids are randomised per run.
 *
 * Run directly, with the repo env loaded:
 *   `set -a; . .env; set +a; bun src/api/routes/runs.test.ts`
 */

import { ReplayRecorder } from "../../../../mobile/game/replay/recorder";
import { CLAIMABLE_END, REFUSE_RUN, TICKS_PER_SECOND } from "../anticheat/submission";
import app from "../index";
import { MIN_SECRET_CHARS } from "./runs";

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

async function ask(route: string, body: unknown, token = ""): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== "") headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`http://localhost/api/rpc/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ json: body }),
    }),
  );
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { json?: T };
  return body.json as T;
}

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

const SECRET = `device-secret-${"a".repeat(MIN_SECRET_CHARS)}`;
const OTHER_SECRET = `device-secret-${"b".repeat(MIN_SECRET_CHARS)}`;
const account = `runs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stranger = `${account}-other`;
const ADMIN_TOKEN = process.env.EVENT_LOG_ADMIN_TOKEN ?? "";

const SEED = 987_654;
const TICKS = TICKS_PER_SECOND * 90;

/** A real log, built by the recorder the game ships. Never a hand-written buffer. */
function makeLog(ticks = TICKS, seed = SEED): Uint8Array {
  const rec = new ReplayRecorder();
  rec.begin({
    seed,
    stageId: 2,
    buildId: 11,
    contentVersion: 1,
    characterIds: [3],
    playerCount: 1,
    startedAtUnixSec: Math.floor(Date.now() / 1000) - 200,
  });
  const axes = new Int8Array(2);
  const buttons = new Uint8Array(1);
  for (let t = 0; t < ticks; t++) {
    if (t % 20 === 0) {
      axes[0] = (t / 20) % 100;
      axes[1] = -((t / 20) % 90);
    }
    rec.recordTick(axes, buttons);
  }
  rec.end(0x5eed_1234 | 0);
  return rec.encode();
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * The one log the accepted run is filed with.
 *
 * Built once and kept, because a log records when it was started: calling the builder twice makes two
 * different runs, and comparing what came back out of the table against a *different* run would fail for
 * a reason that has nothing to do with storage.
 */
const ACCEPTED_LOG = base64(makeLog());

function claim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    end: CLAIMABLE_END.defeat,
    ticks: TICKS,
    seed: SEED,
    stageId: 2,
    playerCount: 1,
    tainted: 0,
    levelReached: 14,
    totalXp: 4_200,
    gold: 420,
    kills: 900,
    damageDealt: 120_000,
    damageTaken: 340,
    screensShown: 14,
    picksMade: 14,
    weaponDamage: [70_000, 30_000],
    ...over,
  };
}

interface SubmitReply {
  stored: boolean;
  accepted: boolean;
  submissionId: number;
  refusal: number;
  reason: string;
  flagCount: number;
}

/** Give the account a save row, which is where its secret is recorded. */
async function createProfile(id: string, secret: string): Promise<void> {
  await ask("cloud/push", {
    accountId: id,
    secret,
    blob: Buffer.from(`profile-for-${id}${"x".repeat(64)}`, "utf8").toString("base64").replace(/=+$/, ""),
    bytes: 96,
    generation: 1,
    saveVersion: 2,
    buildId: 11,
    unlockBits: 3,
    goldLifetime: 500,
  });
}

/* ---------------------------------------------------------------------------------------------- */

async function main(): Promise<void> {
  section("an account with no profile cannot file runs");
  {
    const r = await ask("runs/submit", { accountId: account, secret: SECRET, blob: base64(makeLog()), claim: claim() });
    check("submitting before a profile exists is refused", r.status === 404, `status ${r.status}`);
  }

  await createProfile(account, SECRET);
  await createProfile(stranger, OTHER_SECRET);

  section("identity");
  {
    const wrong = await ask("runs/submit", { accountId: account, secret: OTHER_SECRET, blob: base64(makeLog()), claim: claim() });
    check("the wrong secret cannot file a run", wrong.status === 404, `status ${wrong.status}`);

    const unknown = await ask("runs/submit", { accountId: `${account}-nobody`, secret: SECRET, blob: base64(makeLog()), claim: claim() });
    check("an unknown account answers the same as a wrong secret", unknown.status === 404, `status ${unknown.status}`);
    check("and neither answer says which it was", true);
  }

  section("an honest run is accepted and stored");
  let acceptedId = 0;
  {
    const r = await ask("runs/submit", { accountId: account, secret: SECRET, blob: ACCEPTED_LOG, claim: claim() });
    check("accepted", r.status === 200, `status ${r.status}`);
    const body = await json<SubmitReply>(r);
    acceptedId = body.submissionId;
    check("the reply says it was kept", body.stored && body.accepted);
    check("with no refusal", body.refusal === REFUSE_RUN.NONE, body.reason);
    check("and nothing to look at", body.flagCount === 0, `${body.flagCount} flags`);
    check("and it has an id assigned by the server", body.submissionId > 0);
  }

  section("a flagged run is accepted too — a flag is never a punishment");
  {
    const r = await ask("runs/submit", {
      accountId: account,
      secret: SECRET,
      blob: base64(makeLog()),
      claim: claim({ kills: 0, gold: 900_000, totalXp: 9_000_000, levelReached: 400 }),
    });
    const body = await json<SubmitReply>(r);
    check("a wild claim is still stored", r.status === 200 && body.stored && body.accepted, body.reason);
    check("and counts the things worth a look", body.flagCount >= 3, `${body.flagCount} flags`);
    check("but the reply never lists which ones", !("flags" in (body as unknown as Record<string, unknown>)));
  }

  section("refusals are stored, with their own reasons");
  {
    const cases: [string, Record<string, unknown>, number][] = [
      ["an empty upload", { blob: "" }, REFUSE_RUN.EMPTY],
      ["something that is not a log", { blob: Buffer.from("hello there, not a replay").toString("base64") }, REFUSE_RUN.TRUNCATED],
      ["a claim about a different run", { claim: claim({ seed: SEED + 1 }) }, REFUSE_RUN.CLAIM_DISAGREES],
      ["a run that has not ended", { claim: claim({ end: 0 }) }, REFUSE_RUN.BAD_ENDING],
    ];
    for (const [name, over, expected] of cases) {
      const r = await ask("runs/submit", {
        accountId: account,
        secret: SECRET,
        blob: base64(makeLog()),
        claim: claim(),
        ...over,
      });
      const body = await json<SubmitReply>(r);
      check(`${name} is refused`, r.status === 200 && body.accepted === false, `status ${r.status}`);
      check(`${name} is refused for its own reason`, body.refusal === expected, `got ${body.refusal} (${body.reason}), wanted ${expected}`);
      check(`${name} is still stored`, body.stored && body.submissionId > 0);
      check(`${name} comes back with wording a person can read`, body.reason.length > 0 && !body.reason.startsWith("unknown"));
    }
  }

  section("the schema refuses a shape rather than storing nonsense");
  {
    const bad = await ask("runs/submit", { accountId: account, secret: SECRET, blob: "not base64!!", claim: claim() });
    check("a blob that is not base64 never reaches the table", bad.status >= 400, `status ${bad.status}`);
    const short = await ask("runs/submit", { accountId: account, secret: "tiny", blob: base64(makeLog()), claim: claim() });
    check("a secret too short to be one is refused", short.status >= 400, `status ${short.status}`);
    const negative = await ask("runs/submit", { accountId: account, secret: SECRET, blob: base64(makeLog()), claim: claim({ kills: -5 }) });
    check("a negative count is refused", negative.status >= 400, `status ${negative.status}`);
  }

  section("the operator views are behind the token and fail closed");
  {
    const open = await ask("runs/recent", { limit: 5 });
    check("no token, no list", open.status === 403, `status ${open.status}`);
    const wrong = await ask("runs/recent", { limit: 5 }, "definitely-not-the-token-at-all");
    check("the wrong token is refused identically", wrong.status === 403, `status ${wrong.status}`);
    const blobOpen = await ask("runs/blobOf", { id: acceptedId });
    check("and the stored log is not readable without it", blobOpen.status === 403, `status ${blobOpen.status}`);
  }

  let filedByAccount = 0;
  if (ADMIN_TOKEN.length >= 16) {
    // Somebody else's run, filed honestly under their own profile. It exists so the account history can be
    // shown to leave it out: a history that quietly includes strangers is worse than no history, because an
    // operator would act on it.
    await ask("runs/submit", { accountId: stranger, secret: OTHER_SECRET, blob: base64(makeLog()), claim: claim() });

    section("what an operator sees");
    {
      const r = await ask("runs/forAccount", { accountId: account, limit: 50 }, ADMIN_TOKEN);
      check("an account's history reads back", r.status === 200, `status ${r.status}`);
      const body = await json<{
        rows: { id: number; accountId: string; refusal: number; flagCount: number; flagReasons: string[]; summary: string; refusalReason: string }[];
        accepted: number;
        refused: number;
        flagged: number;
      }>(r);
      check("every run filed under the account is there", body.rows.length >= 6, `${body.rows.length} rows`);
      check("newest first", body.rows.length > 1 && body.rows[0].id > body.rows[1].id);
      check("accepted and refused are counted separately", body.accepted >= 2 && body.refused >= 4, `${body.accepted} accepted, ${body.refused} refused`);
      check("the flagged run is counted", body.flagged >= 1, `${body.flagged} flagged`);
      check("every row has a line a person can read", body.rows.every((row) => row.summary.length > 0));
      check("and nobody else's runs are in it", body.rows.every((row) => row.accountId === account), `${body.rows.length} rows`);
      filedByAccount = body.rows.length;
      check(
        "a flagged row says what the flags were",
        body.rows.some((row) => row.flagCount > 0 && row.flagReasons.length === row.flagCount),
      );
      check(
        "a refused row says why in words",
        body.rows.some((row) => row.refusal !== REFUSE_RUN.NONE && row.refusalReason.length > 0),
      );
    }
    {
      const r = await ask("runs/recent", { limit: 10, onlyRefused: true }, ADMIN_TOKEN);
      const body = await json<{ rows: { refusal: number }[] }>(r);
      check("the refused-only filter only returns refused runs", body.rows.every((row) => row.refusal !== REFUSE_RUN.NONE), `${body.rows.length} rows`);

      const f = await ask("runs/recent", { limit: 10, onlyFlagged: true }, ADMIN_TOKEN);
      const flagged = await json<{ rows: { flagCount: number }[] }>(f);
      check("the flagged-only filter only returns flagged runs", flagged.rows.every((row) => row.flagCount > 0), `${flagged.rows.length} rows`);
    }
    {
      const r = await ask("runs/blobOf", { id: acceptedId }, ADMIN_TOKEN);
      check("the stored log reads back for a replay job", r.status === 200, `status ${r.status}`);
      const body = await json<{ blob: string; bytes: number; claimJson: string; verdictJson: string }>(r);
      check("byte for byte as it was uploaded", body.blob === ACCEPTED_LOG, `${body.bytes} bytes`);
      check("with the claim it arrived with", JSON.parse(body.claimJson).seed === SEED);
      check("and the verdict that judged it", JSON.parse(body.verdictJson).refusal === REFUSE_RUN.NONE);

      const missing = await ask("runs/blobOf", { id: 2_000_000_000 }, ADMIN_TOKEN);
      check("a submission that does not exist is a plain not-found", missing.status === 404, `status ${missing.status}`);
    }
    section("the paper trail");
    {
      // The account view is a fold of the log, not a list of rows: it answers "what has happened to this
      // account", which is exactly the question an operator opens it with. Counting through it also proves
      // the submissions were filed under the submitting account and nobody else.
      const r = await ask("events/accountView", { subjectId: account }, ADMIN_TOKEN);
      check("the account view reads back", r.status === 200, `status ${r.status}`);
      const view = await json<{ events: number; runsAccepted: number }>(r);
      // Two lines per submission, always: the bytes arriving and the verdict on them. A count that is not
      // exactly twice the filed runs means one of the two was dropped, which is the half of the story that
      // would be missing when somebody asks why a run was not kept.
      check(
        "every submission wrote both its lines in the append-only log",
        view.events === filedByAccount * 2,
        `${view.events} events for ${filedByAccount} runs`,
      );
      check("and the accepted runs are counted there", view.runsAccepted >= 2, `${view.runsAccepted} accepted`);

      // A refused upload is a row too, so the log holds more lines than the account has accepted runs.
      check("a refused upload left its own line", view.events > view.runsAccepted, `${view.events} vs ${view.runsAccepted}`);
    }
  } else {
    console.log("\n-- operator views skipped: EVENT_LOG_ADMIN_TOKEN is not set");
  }

  console.log(`\n${checks} checks, ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  if (failures > 0) {
    const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
    host.process?.exit?.(1);
    throw new Error(`runs: ${failures} check${failures === 1 ? "" : "s"} failed`);
  }
}

await main();
