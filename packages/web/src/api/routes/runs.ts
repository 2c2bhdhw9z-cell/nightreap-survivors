/**
 * Submitted runs over the wire: a phone uploads a finished run, an operator reads what arrived.
 *
 * WHAT A SUBMISSION IS
 *
 * Two things stapled together: the input log, which is evidence, and the result claimed with it, which is
 * an assertion. `anticheat/submission.ts` does the judging and never trusts the second one; this file is
 * the door, the storage, and the paper trail.
 *
 * WHAT ARRIVING IS WORTH
 *
 * Nothing. A stored run is not a trusted run. Nothing here grants gold, unlocks anything, or moves a
 * leaderboard — the ladder is Phase 6, and when it arrives it is fed by runs that have been re-simulated
 * against the build they were played on, not by whatever a phone said. Accepting a submission means "this
 * was a real log, we kept it"; nothing more.
 *
 * WHY A REFUSED UPLOAD IS STILL STORED
 *
 * Refusals are what an attack looks like from here. A hundred refused uploads in a minute from one account
 * is the signal; a server that drops them keeps no signal. So a refusal is a row with its reason on it, and
 * the bytes are kept when there were any.
 *
 * WHY THERE IS NO PUNISHMENT ANYWHERE IN THIS FILE
 *
 * Every threshold in the rulebook is a guess about the ceiling of a game still being balanced, and a guess
 * that can ban people will ban honest players. Flags put a run in front of a person. The only thing that
 * changes an account is an operator pressing a button, and that already writes its own row with a name and
 * a reason against it.
 *
 * WHO MAY CALL WHAT
 *
 * `submit` is open to a device holding an account id and its secret — the same padlock the cloud locker
 * uses, and for the same reason: there is no sign-in yet, and the alternative is an endpoint anybody can
 * fill with rows attributed to a stranger. `recent`, `forAccount` and `blobOf` are admin-only, behind the
 * shared token, fail-closed.
 */

import { ORPCError } from "@orpc/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import {
  MAX_SUBMISSION_BYTES,
  REFUSE_RUN,
  describeFlag,
  describeRefusal,
  judge,
  verdictLine,
  type RunClaim,
  type RunVerdict,
} from "../anticheat/submission";
import { db } from "../database";
import { cloudSave, runSubmission } from "../database/schema";
import { adminOnly, log } from "../events/door";
import { ACTOR, EVENT } from "../events/log";

/* ---------------------------------------------------------------------------------------------- */
/* Shapes                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** Base64 of the log. Four characters per three bytes, plus room for padding. */
export const MAX_BLOB_CHARS = Math.ceil((MAX_SUBMISSION_BYTES * 4) / 3) + 4;

/** The shortest device secret we will treat as one, matching the cloud locker. */
export const MIN_SECRET_CHARS = 24;

/** How many rows an operator screen may ask for at once. */
export const MAX_PAGE = 100;

const accountId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "an account id is letters, digits, dashes and underscores");

const secret = z.string().min(MIN_SECRET_CHARS).max(256);

/**
 * No whitespace, so a blob's length is its length and a padding trick cannot smuggle bytes past the cap.
 *
 * There is deliberately no minimum. An empty or truncated upload is not a malformed request, it is the
 * most interesting thing an attacker does in volume, and the rulebook has its own reasons for both. A
 * schema minimum here would turn those into a shape error the operator screens never see, instead of a
 * stored row with a reason on it. The maximum stays: that one is about not filling a disk.
 */
const blob = z
  .string()
  .max(MAX_BLOB_CHARS)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "a run log is base64");

/**
 * The claimed result.
 *
 * Bounded generously rather than tightly. A tight bound here would be a second, undocumented rulebook
 * sitting in front of the real one: a number over the ceiling would come back as a schema error instead of
 * a stored, flagged row, and the flagged row is the thing worth having. So the schema only insists these
 * are whole non-negative numbers that fit in a signed 32-bit column, and the judging happens where the
 * judging is tested.
 */
const I32 = 2_147_483_647;
const count = z.number().int().nonnegative().max(I32);

const claimInput = z.object({
  end: z.number().int().nonnegative().max(255),
  ticks: count,
  seed: count,
  stageId: count,
  playerCount: z.number().int().nonnegative().max(8),
  tainted: count,
  levelReached: count,
  totalXp: count,
  gold: count,
  kills: count,
  damageDealt: count,
  damageTaken: count,
  screensShown: count,
  picksMade: count,
  weaponDamage: z.array(count).max(24).default([]),
});

const submitInput = z.object({
  accountId,
  secret,
  blob,
  claim: claimInput,
});

/* ---------------------------------------------------------------------------------------------- */
/* Identity — the same padlock the locker uses                                                     */
/* ---------------------------------------------------------------------------------------------- */

function ownerHashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time compare, so a secret cannot be guessed a character at a time. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * One refusal for "no such account" and for "not yours".
 *
 * Two different answers would make this endpoint a way to find out which account ids exist, which is the
 * first step of every attack on something shaped like this.
 */
function noAccount(): ORPCError<"NOT_FOUND", undefined> {
  return new ORPCError("NOT_FOUND", { message: "No profile for that account." });
}

/**
 * Confirm the caller holds the secret for the account it is submitting under.
 *
 * An account that has never pushed a save has no secret on file. That submission is refused rather than
 * silently recording the offered secret: a first save is a deliberate act by the device that owns the
 * profile, and letting a run upload mint an identity would make the padlock claimable by whoever gets
 * there first.
 */
async function assertOwner(id: string, offered: string): Promise<void> {
  const rows = await db.select().from(cloudSave).where(eq(cloudSave.accountId, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw noAccount();
  if (!sameHash(row.ownerHash, ownerHashOf(offered))) throw noAccount();
}

/* ---------------------------------------------------------------------------------------------- */
/* Storing                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

function decodeBase64(text: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(text, "base64"));
  } catch {
    // Buffer is forgiving, so this is belt and braces: an undecodable blob becomes an empty upload, which
    // the rulebook refuses on its own terms rather than throwing here.
    return new Uint8Array(0);
  }
}

/**
 * Write the row, then the paper trail.
 *
 * The row first, on purpose: the run is the evidence and the event is the note about it, so a crash between
 * the two leaves a stored run with no note rather than a note pointing at nothing. The note carries the
 * submission's id, so the two are findable from either side.
 */
async function store(
  id: string,
  blobText: string,
  bytes: number,
  claim: RunClaim,
  v: RunVerdict,
  now: number,
): Promise<number> {
  const inserted = await db
    .insert(runSubmission)
    .values({
      accountId: id,
      receivedAt: now,
      refusal: v.refusal,
      flagCount: v.flags.length,
      limitsVersion: v.limitsVersion,
      ladderEligible: v.ladderEligible ? 1 : 0,
      seed: v.seed,
      stageId: v.stageId,
      ticks: v.ticks,
      playerCount: v.playerCount,
      tainted: v.tainted,
      buildId: v.buildId,
      contentVersion: v.contentVersion,
      finalStateHash: v.finalStateHash,
      verdictJson: JSON.stringify(v),
      claimJson: JSON.stringify(claim),
      blob: blobText,
      bytes,
    })
    .returning({ id: runSubmission.id });

  const rowId = inserted[0]?.id ?? 0;

  // TWO ROWS, ON PURPOSE: the arrival and the verdict are different facts, and only one of them is an
  // opinion. "These bytes turned up under this account at this moment" is true forever. "This rulebook
  // version accepted them" is true of a rulebook that will be rewritten. Written as one row they could
  // never be separated again, and a re-judgement would have to overwrite history to say anything.
  //
  // Neither row is a punishment and neither grants anything. A rejection is a note that an upload was not
  // kept as a result, nothing more.
  const accepted = v.refusal === REFUSE_RUN.NONE;
  const facts = {
    submissionId: rowId,
    seed: v.seed,
    stageId: v.stageId,
    ticks: v.ticks,
    flags: v.flags.join(","),
    refusal: v.refusal,
    limitsVersion: v.limitsVersion,
    ladderEligible: v.ladderEligible,
  } as const;
  // A submission is a lone row about the account that filed it: it undoes nothing, puts nothing back, and
  // belongs to no batch. Spelled out rather than left off, because the log refuses a half-filled draft.
  const common = {
    actorKind: ACTOR.PLAYER,
    actorId: id,
    subjectId: id,
    buildId: v.buildId,
    at: now,
    payload: facts,
    reverses: 0,
    restores: 0,
    groupId: "",
  } as const;

  const events = await log();
  await events.append({ ...common, kind: EVENT.RUN_SUBMITTED });
  await events.append({ ...common, kind: accepted ? EVENT.RUN_ACCEPTED : EVENT.RUN_REJECTED });

  return rowId;
}

/* ---------------------------------------------------------------------------------------------- */
/* Procedures                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Upload a finished run.
 *
 * The answer tells the device the truth and nothing more: whether it was kept, why not if not, and how many
 * things a person may look at. It deliberately does not list which flags fired. A client that can read its
 * own flags is a client that can be tuned against them, and the honest player gains nothing from the list.
 */
const submit = base.input(submitInput).handler(async ({ input }) => {
  await assertOwner(input.accountId, input.secret);

  const bytes = decodeBase64(input.blob);
  const now = Date.now();
  const claim: RunClaim = { ...input.claim, weaponDamage: input.claim.weaponDamage };
  const verdict = judge(bytes, claim, Math.floor(now / 1000));

  const id = await store(input.accountId, input.blob, bytes.byteLength, claim, verdict, now);

  if (verdict.refusal !== REFUSE_RUN.NONE) {
    return {
      stored: true as const,
      accepted: false as const,
      submissionId: id,
      refusal: verdict.refusal,
      reason: describeRefusal(verdict.refusal),
      flagCount: 0,
    };
  }

  return {
    stored: true as const,
    accepted: true as const,
    submissionId: id,
    refusal: REFUSE_RUN.NONE,
    reason: describeRefusal(REFUSE_RUN.NONE),
    flagCount: verdict.flags.length,
  };
});

/** What an operator screen shows for one row. The log itself is a separate, deliberate fetch. */
function rowView(row: typeof runSubmission.$inferSelect) {
  let flags: number[] = [];
  try {
    const parsed = JSON.parse(row.verdictJson) as { flags?: number[] };
    flags = Array.isArray(parsed.flags) ? parsed.flags : [];
  } catch {
    // A row we cannot parse is still a row worth showing. Never let one bad document hide a page.
    flags = [];
  }
  return {
    id: row.id,
    accountId: row.accountId,
    receivedAt: row.receivedAt,
    refusal: row.refusal,
    refusalReason: describeRefusal(row.refusal),
    flagCount: row.flagCount,
    flagReasons: flags.map((f) => describeFlag(f)),
    limitsVersion: row.limitsVersion,
    ladderEligible: row.ladderEligible === 1,
    seed: row.seed,
    stageId: row.stageId,
    ticks: row.ticks,
    playerCount: row.playerCount,
    tainted: row.tainted,
    buildId: row.buildId,
    contentVersion: row.contentVersion,
    bytes: row.bytes,
    summary: verdictLine({
      refusal: row.refusal,
      limitsVersion: row.limitsVersion,
      ticks: row.ticks,
      seconds: Math.floor(row.ticks / 60),
      seed: row.seed,
      stageId: row.stageId,
      playerCount: row.playerCount,
      tainted: row.tainted,
      contentVersion: row.contentVersion,
      buildId: row.buildId,
      startedAtUnixSec: 0,
      finalStateHash: row.finalStateHash,
      inputRecords: 0,
      flags,
      ladderEligible: row.ladderEligible === 1,
    }),
  };
}

/**
 * The newest submissions, optionally only the ones worth looking at.
 *
 * "Worth looking at" is a filter, not a queue: nothing is marked as handled here, because marking a run
 * handled is an opinion and opinions belong in the event log where they have a name on them.
 */
const recent = adminOnly
  .input(
    z.object({
      limit: z.number().int().positive().max(MAX_PAGE).default(25),
      onlyFlagged: z.boolean().default(false),
      onlyRefused: z.boolean().default(false),
    }),
  )
  .handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(runSubmission)
      .orderBy(desc(runSubmission.id))
      .limit(input.onlyFlagged || input.onlyRefused ? MAX_PAGE : input.limit);

    let view = rows.map(rowView);
    if (input.onlyRefused) view = view.filter((r) => r.refusal !== REFUSE_RUN.NONE);
    if (input.onlyFlagged) view = view.filter((r) => r.flagCount > 0);
    return { rows: view.slice(0, input.limit) };
  });

/** Every submission from one account, newest first. The shape of a player's history in one call. */
const forAccount = adminOnly
  .input(z.object({ accountId, limit: z.number().int().positive().max(MAX_PAGE).default(50) }))
  .handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(runSubmission)
      .where(eq(runSubmission.accountId, input.accountId))
      .orderBy(desc(runSubmission.id))
      .limit(input.limit);
    const view = rows.map(rowView);
    return {
      rows: view,
      accepted: view.filter((r) => r.refusal === REFUSE_RUN.NONE).length,
      refused: view.filter((r) => r.refusal !== REFUSE_RUN.NONE).length,
      flagged: view.filter((r) => r.flagCount > 0).length,
    };
  });

/**
 * The stored log bytes for one submission, for a replay job or an appeal.
 *
 * Separate from the list on purpose: the bytes are the largest thing in the table and no screen should be
 * pulling them by accident while scrolling.
 */
const blobOf = adminOnly
  .input(z.object({ id: z.number().int().positive() }))
  .handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(runSubmission)
      .where(and(eq(runSubmission.id, input.id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new ORPCError("NOT_FOUND", { message: "No such submission." });
    return { id: row.id, blob: row.blob, bytes: row.bytes, claimJson: row.claimJson, verdictJson: row.verdictJson };
  });

export const runs = {
  submit,
  recent,
  forAccount,
  blobOf,
};
