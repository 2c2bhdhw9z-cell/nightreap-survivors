/**
 * The break-glass endpoints the admin page is built on.
 *
 * `routes/events.ts` is the log's own door — read a slice, prove nothing was edited, undo, redo, read the
 * story. This file is the *operator's* door: look an account up, see everything ever done to it, and take
 * one of the actions on the catalogue in `../events/actions.ts`. Every one of them writes a row through the
 * ordinary append path; there is no faster lane, and there is nothing here that edits or deletes.
 *
 * WHY THE CATALOGUE IS CONSULTED HERE AND NOT ON THE SCREEN
 * The screen asks what the buttons are, and the answer is computed from the catalogue every time. So a new
 * action appears with the right inputs and the right "cannot be undone" warning without a line of screen
 * code changing, and a screen running against an older server cannot invent an action that server does not
 * have.
 *
 * WHAT IS DELIBERATELY MISSING
 * Per-feature kill switches. Those are a config document rather than an action about a person, config is
 * still served from an environment value, and a button that writes a row saying a feature was killed while
 * the feature stays up is worse than no button — it is a log that lies. The button lands with the stored
 * config document, which is its own piece of work.
 */

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { buildAction, catalogueFaults, describeActions, REFUSE_NAMES } from "../events/actions";
import { adminOnly, log } from "../events/door";
import { ACTOR, BAD_NAMES, EVENT_NAMES, REVERSIBLE } from "../events/log";
import { APPEND } from "../events/store";

/* ---------------------------------------------------------------------------------------------- */
/* Startup self-check                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A catalogue that has drifted from the log's vocabulary is a startup failure, not a surprise during an
 * incident. This runs once, at import, and refuses to be quiet about it.
 */
const FAULTS = catalogueFaults();
if (FAULTS.length > 0) {
  console.error(`[admin] the action catalogue does not agree with the log:\n  ${FAULTS.join("\n  ")}`);
}

/* ---------------------------------------------------------------------------------------------- */
/* Procedures                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** What buttons exist, what each one needs, and which of them can be undone. Derived, never written down. */
const catalogue = adminOnly.handler(() => ({
  actions: describeActions(),
  faults: FAULTS,
}));

/**
 * One account, everything about it.
 *
 * The standing is recomputed from the rows every time rather than read from a column, which is the whole
 * argument of the event log made visible on a screen: if these two ever disagreed, the rows would be right.
 */
const account = adminOnly
  .input(z.object({ subjectId: z.string().min(1).max(64), limit: z.number().int().min(1).max(500).default(200) }))
  .handler(async ({ input }) => {
    const live = await log();
    const [view, rows] = await Promise.all([live.accountView(input.subjectId), live.subjectRows(input.subjectId)]);

    // Newest first — an operator opening an account is almost always asking "what just happened".
    const ordered = [...rows].sort((a, b) => b.seq - a.seq).slice(0, input.limit);

    // Which rows have been undone, and by what, so the screen can grey a row without a second round trip.
    const undoneBy = new Map<number, number>();
    for (const row of rows) if (row.reverses > 0) undoneBy.set(row.reverses, row.seq);

    return {
      view,
      total: rows.length,
      rows: ordered.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        kindName: EVENT_NAMES[row.kind] ?? "UNKNOWN",
        actorId: row.actorId,
        at: row.at,
        payload: row.payload,
        reverses: row.reverses,
        restores: row.restores,
        groupId: row.groupId,
        undoneBySeq: undoneBy.get(row.seq) ?? 0,
        // Answered here, from the log's own reversible set, so the screen never carries a second copy of
        // the rule. A screen that decided this for itself would eventually offer to lift something the log
        // will not lift, and the operator would learn that only after typing out a reason.
        undoable: REVERSIBLE.has(row.kind),
      })),
    };
  });

/**
 * Take an action.
 *
 * The operator supplies who they are, who it is about, why, and the action's own fields. They do not supply
 * the event kind, the actor kind, or the time: the catalogue decides the first two and the server decides
 * the third. Wall-clock time is evidence, and evidence the caller can set is not evidence.
 */
const act = adminOnly
  .input(
    z.object({
      actionId: z.string().min(1).max(64),
      actorId: z.string().min(1).max(64),
      subjectId: z.string().max(64).default(""),
      reason: z.string().max(512),
      fields: z.record(z.string(), scalar).default({}),
      groupId: z.string().max(64).default(""),
    }),
  )
  .handler(async ({ input }) => {
    const built = buildAction({ ...input, at: Date.now() });
    if (!built.ok) {
      throw new ORPCError("BAD_REQUEST", {
        message: `That action was refused: ${REFUSE_NAMES[built.refusal] ?? String(built.refusal)}${built.field ? ` (${built.field})` : ""}`,
      });
    }

    const result = await (await log()).append(built.draft);
    if (result.status === APPEND.REFUSED) {
      throw new ORPCError("BAD_REQUEST", {
        message: `The log refused that row: ${BAD_NAMES[result.reason] ?? String(result.reason)}`,
      });
    }

    return {
      duplicate: result.status === APPEND.DUPLICATE,
      seq: result.row?.seq ?? 0,
      kind: built.draft.kind,
      kindName: EVENT_NAMES[built.draft.kind] ?? "UNKNOWN",
    };
  });

/**
 * Undo one row.
 *
 * Separate from the bulk path in `events.ts` on purpose: a one-row undo is the common case at the screen,
 * and making an operator invent a group id to lift a single ban is how they end up not lifting it.
 */
const undo = adminOnly
  .input(
    z.object({
      seq: z.number().int().min(1),
      actorId: z.string().min(1).max(64),
      reason: z.string().min(1).max(512),
      groupId: z.string().max(64).default(""),
    }),
  )
  .handler(async ({ input }) => {
    const result = await (await log()).reverse(input.seq, ACTOR.ADMIN, input.actorId, Date.now(), input.reason, input.groupId);
    if (result.status === APPEND.REFUSED) {
      throw new ORPCError("BAD_REQUEST", {
        message: `The log refused that undo: ${BAD_NAMES[result.reason] ?? String(result.reason)}`,
      });
    }
    return { duplicate: result.status === APPEND.DUPLICATE, seq: result.row?.seq ?? 0 };
  });

export const admin = {
  catalogue,
  account,
  act,
  undo,
};
