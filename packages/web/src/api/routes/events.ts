/**
 * The event log over the wire — the break-glass endpoints.
 *
 * These are the calls the admin page in `plan.md` is built on: look at what happened, prove nothing has
 * been edited, undo a bad wave, and read an account's standing rebuilt from the log rather than from a
 * cached column. There is no endpoint that changes a row and no endpoint that removes one, because those
 * do not exist anywhere in this system.
 *
 * WHO MAY CALL THESE
 * A shared admin token, checked in constant time, and nothing else — there is no sign-in yet, and shipping
 * this behind "we'll add auth later" is how a log that can hand out gold ends up open. When the token is
 * not configured every one of these refuses. FAIL CLOSED, ALWAYS: a misconfigured server that quietly
 * serves the log is worse than one that quietly serves nothing.
 *
 * `append` is here so the admin page and our own jobs can write rows before the rest of the game has
 * server-side write paths of its own. When those arrive they call `EventLog.append` directly, in-process,
 * rather than through this endpoint — the endpoint is the door for humans, not the plumbing.
 *
 * NOTE ON `at`. The caller does not get to choose it. Wall-clock time is evidence, and evidence that the
 * subject of an investigation can set is not evidence.
 */

import { ORPCError } from "@orpc/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { base } from "../__core/app";
import { ACTOR, BAD_NAMES, CHAIN_NAMES, EVENT_NAMES } from "../events/log";
import { APPEND, EventLog } from "../events/store";

/* ---------------------------------------------------------------------------------------------- */
/* Access                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** Constant-time string compare, so a wrong token cannot be guessed a character at a time. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Every procedure below sits behind this.
 *
 * The refusal is the same message whether the token is missing, wrong, or not configured at all. Telling a
 * caller *which* is how they learn whether there is anything to attack.
 */
const admin = base.use(({ context, next }) => {
  const expected = process.env.EVENT_LOG_ADMIN_TOKEN ?? "";
  if (expected.length < 16) {
    console.warn("[events] EVENT_LOG_ADMIN_TOKEN is not set — refusing every event-log call");
    throw new ORPCError("FORBIDDEN", { message: "The event log is not available." });
  }

  const header = context.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered === "" || !sameSecret(offered, expected)) {
    throw new ORPCError("FORBIDDEN", { message: "The event log is not available." });
  }

  return next();
});

/* ---------------------------------------------------------------------------------------------- */
/* The log instance                                                                                */
/* ---------------------------------------------------------------------------------------------- */

let instance: EventLog | null = null;

/**
 * Built on first use, not at import.
 *
 * The database client connects when it is imported, and the rules half of the log is deliberately usable
 * with no database at all. Loading it lazily keeps a server with no database configured able to start,
 * serve config, and say a clear no here.
 */
async function log(): Promise<EventLog> {
  if (instance !== null) return instance;
  const { DbEventBackend } = await import("../events/backend-db");
  instance = new EventLog(new DbEventBackend());
  return instance;
}

/* ---------------------------------------------------------------------------------------------- */
/* Shapes                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const draftInput = z.object({
  kind: z.number().int().nonnegative(),
  actorId: z.string().min(1).max(64),
  subjectId: z.string().max(64).default(""),
  buildId: z.number().int().nonnegative().default(0),
  payload: z.record(z.string(), scalar).default({}),
  reverses: z.number().int().nonnegative().default(0),
  groupId: z.string().max(64).default(""),
});

/* ---------------------------------------------------------------------------------------------- */
/* Procedures                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Write one row.
 *
 * The actor is always `ADMIN` — a call that arrived with the admin token is an admin action, whatever it
 * claims to be. Letting the caller name its own actor kind would make "who did this" a field the doer
 * fills in, and the first question of every incident is exactly that.
 */
const append = admin.input(draftInput).handler(async ({ input }) => {
  const result = await (await log()).append({
    kind: input.kind,
    actorKind: ACTOR.ADMIN,
    actorId: input.actorId,
    subjectId: input.subjectId,
    buildId: input.buildId,
    at: Date.now(),
    payload: input.payload,
    reverses: input.reverses,
    // A restore is never hand-written through this door. It is built from the row being put back, by
    // `restore` below, so the amount can never be something an operator typed while tired.
    restores: 0,
    groupId: input.groupId,
  });

  if (result.status === APPEND.REFUSED) {
    throw new ORPCError("BAD_REQUEST", {
      message: `The log refused that row: ${BAD_NAMES[result.reason] ?? String(result.reason)}`,
    });
  }

  return {
    duplicate: result.status === APPEND.DUPLICATE,
    seq: result.row?.seq ?? 0,
    hash: result.row?.hash ?? "",
    kindName: EVENT_NAMES[input.kind] ?? "UNKNOWN",
  };
});

/** Read a slice, newest-usable-first left to the caller. Capped so one call cannot ask for everything. */
const range = admin
  .input(
    z.object({
      from: z.number().int().min(1),
      count: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(async ({ input }) => {
    const rows = await (await log()).read(input.from, input.from + input.count - 1);
    return {
      rows: rows.map((row) => ({ ...row, kindName: EVENT_NAMES[row.kind] ?? "UNKNOWN" })),
    };
  });

/**
 * Prove a slice has not been edited.
 *
 * Returns the report as it is, including the clock-step count — a slice can be perfectly intact and still
 * contain a backwards timestamp, and that is worth seeing without it being an alarm.
 */
const verify = admin
  .input(
    z.object({
      from: z.number().int().min(1).default(1),
      count: z.number().int().min(1).max(5000).default(1000),
    }),
  )
  .handler(async ({ input }) => {
    const report = await (await log()).verify(input.from, input.from + input.count - 1);
    return { ...report, faultName: CHAIN_NAMES[report.fault] ?? "UNKNOWN" };
  });

/** What undoing a bulk action would do. Writes nothing — this is the screen a human reads before agreeing. */
const planReversal = admin
  .input(z.object({ groupId: z.string().min(1).max(64), actorId: z.string().min(1).max(64), reason: z.string().max(512).default("") }))
  .handler(async ({ input }) => {
    const plan = await (await log()).planReversal(
      input.groupId,
      ACTOR.ADMIN,
      input.actorId,
      Date.now(),
      input.reason,
      `preview:${input.groupId}`,
    );
    return {
      willReverse: plan.drafts.length,
      skipped: plan.skipped.map((s) => ({ seq: s.seq, reason: BAD_NAMES[s.reason] ?? String(s.reason) })),
    };
  });

/**
 * Undo a bulk action for real.
 *
 * The reversals get their own group id so this undo can itself be looked up as one action — and so the
 * question "what did we do about that incident" has a single answer.
 */
const reverseGroup = admin
  .input(
    z.object({
      groupId: z.string().min(1).max(64),
      actorId: z.string().min(1).max(64),
      reason: z.string().min(1).max(512),
      newGroupId: z.string().min(1).max(64),
    }),
  )
  .handler(async ({ input }) => {
    const result = await (await log()).reverseGroup(
      input.groupId,
      ACTOR.ADMIN,
      input.actorId,
      Date.now(),
      input.reason,
      input.newGroupId,
    );
    return {
      reversed: result.appended.length,
      firstSeq: result.appended[0]?.seq ?? 0,
      skipped: result.skipped.map((s) => ({ seq: s.seq, reason: BAD_NAMES[s.reason] ?? String(s.reason) })),
    };
  });

/**
 * Put back what an undo took away — the redo.
 *
 * The caller names the reversal and gives a reason; everything else is read from the row being restored. The
 * result is an ordinary, fully reversible row of the original kind, so an operator can go back and forth as
 * many times as the situation needs without the history ever becoming ambiguous.
 */
const restore = admin
  .input(
    z.object({
      reversalSeq: z.number().int().min(1),
      actorId: z.string().min(1).max(64),
      reason: z.string().min(1).max(512),
      groupId: z.string().max(64).default(""),
    }),
  )
  .handler(async ({ input }) => {
    const result = await (await log()).restore(
      input.reversalSeq,
      ACTOR.ADMIN,
      input.actorId,
      Date.now(),
      input.reason,
      input.groupId,
    );

    if (result.status === APPEND.REFUSED) {
      throw new ORPCError("BAD_REQUEST", {
        message: `The log refused that restore: ${BAD_NAMES[result.reason] ?? String(result.reason)}`,
      });
    }

    return {
      duplicate: result.status === APPEND.DUPLICATE,
      seq: result.row?.seq ?? 0,
      hash: result.row?.hash ?? "",
      kindName: EVENT_NAMES[result.row?.kind ?? 0] ?? "UNKNOWN",
    };
  });

/** The did / undid / redid story around one row, in the order it happened. For the admin page. */
const story = admin.input(z.object({ seq: z.number().int().min(1) })).handler(async ({ input }) => {
  const steps = await (await log()).story(input.seq);
  return { steps: steps.map((step) => ({ ...step, kindName: EVENT_NAMES[step.kind] ?? "UNKNOWN" })) };
});

/** One account's standing, recomputed from the log every time it is asked for. */
const accountView = admin
  .input(z.object({ subjectId: z.string().min(1).max(64) }))
  .handler(async ({ input }) => (await log()).accountView(input.subjectId));

export const events = {
  append,
  range,
  verify,
  planReversal,
  reverseGroup,
  restore,
  story,
  accountView,
};
