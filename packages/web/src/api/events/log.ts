/**
 * The append-only event log — the rules half.
 *
 * This is the thing every recovery story in `plan.md` depends on. Nothing about a player's account is
 * "the truth" because a column says so; the truth is the ordered list of things that happened, and every
 * balance, unlock, ladder row and ban is a projection over that list. That single decision is what makes
 * all of these possible instead of merely aspirational:
 *
 *   - a duplication exploit that ran for six hours is undone by reversing six hours of rows
 *   - a leaderboard is rebuilt by recomputing it, not by hand-editing a table
 *   - "who did this, when, from which build" always has an answer
 *   - a bad admin action is itself a row, so it can be reversed too
 *
 * FOUR RULES, AND THEY ARE THE WHOLE FILE.
 *
 * 1. NOTHING IS EVER OVERWRITTEN OR DELETED. There is no update path and no delete path — not a private
 *    one, not an admin one. Undoing something means appending its opposite. This is not tidiness: a log
 *    you can edit is a log that cannot prove anything, and the only reason to keep one is proof.
 *
 * 2. EVERY ROW COMMITS TO THE ONE BEFORE IT. Each row carries the hash of its predecessor and its own
 *    hash over its own contents. Change one byte of one old row and every hash after it stops matching, so
 *    silent tampering — by us, by a compromised admin session, by a bad migration — is detectable rather
 *    than deniable. This is a tripwire, not a security boundary: whoever can rewrite rows can rewrite
 *    hashes. What it buys is that they cannot do it *by accident* and cannot do it *partially*.
 *
 * 3. A REVERSAL IS A ROW. It names the row it undoes, it cannot undo a reversal, and it cannot undo the
 *    same row twice. Reversals come in groups so that "undo everything this exploit did" is one operation
 *    — the moderation design makes a bulk-reversal path mandatory, because the first time an automated
 *    ban wave hits innocent players we will need to undo thousands of rows in one action and be able to
 *    show exactly which ones.
 *
 * 4. THE SHAPE IS FIXED, THE VOCABULARY GROWS. Event kinds are numbers with an append-only registry, the
 *    same rule already in force for content ids, string ids and cue ids. A kind is never renamed and never
 *    reused, because a number in a row written last year has to still mean what it meant then.
 *
 * WHAT IS DELIBERATELY NOT HERE: the database. This file has no imports from the app at all, so the rules
 * can be tested exhaustively with no server, no connection and no fixtures — which is why it is possible
 * to be confident about them before there is a server worth protecting. The storage half is `store.ts`
 * and it is thin on purpose.
 *
 * CLOCKS. `at` is wall-clock milliseconds and is *not* trusted for ordering. Sequence numbers order the
 * log; the clock is evidence, and evidence is allowed to be wrong. A row whose timestamp is earlier than
 * its predecessor's is reported as an oddity worth looking at, never as a broken chain — server clocks
 * step backwards for real reasons and a log that refuses to accept that is a log that stops accepting
 * writes during an NTP correction.
 */

import { createHash } from "node:crypto";

/* ---------------------------------------------------------------------------------------------- */
/* Vocabulary                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Who did the thing.
 *
 * Attribution is not optional and there is no "unknown" — a row nobody can be held to is a row that
 * explains nothing six months later. `SYSTEM` is a scheduled job or an automatic rule and still names
 * which one in `actorId`; `SERVER` is request-handling code acting on a player's behalf.
 */
export const ACTOR = {
  SYSTEM: 1,
  SERVER: 2,
  PLAYER: 3,
  ADMIN: 4,
} as const;

export type ActorKind = (typeof ACTOR)[keyof typeof ACTOR];

/**
 * What happened. APPEND ONLY — never renumber, never reuse, never rename.
 *
 * Grouped by area, with gaps left between groups so a new event in an existing area does not have to be
 * bolted onto the end miles from its relatives. The gaps are cosmetic; the numbers are permanent.
 */
export const EVENT = {
  /* currency and progression — 10s */
  GOLD_GRANTED: 10,
  GOLD_SPENT: 11,
  UNLOCK_GRANTED: 12,
  POWERUP_PURCHASED: 13,
  MARKS_GRANTED: 14,
  MARKS_SPENT: 15,

  /* runs — 20s */
  RUN_SUBMITTED: 20,
  RUN_ACCEPTED: 21,
  RUN_REJECTED: 22,
  RUN_REVOKED: 23,

  /* ladders and seasons — 30s */
  SCORE_POSTED: 30,
  SCORE_REMOVED: 31,
  SEASON_CLOSED: 32,
  SEASON_PAID: 33,

  /* accounts and moderation — 40s */
  ACCOUNT_CREATED: 40,
  ACCOUNT_FLAGGED: 41,
  ACCOUNT_SEGREGATED: 42,
  ACCOUNT_RESTORED: 43,
  CHAT_STRIKE: 44,
  CHAT_MUTED: 45,
  CHAT_BANNED: 46,
  CHAT_CLEARED: 47,

  /* operations — 50s */
  CONFIG_PUBLISHED: 50,
  BUILD_QUARANTINED: 51,
  BUILD_RELEASED: 52,
  ADMIN_NOTE: 53,

  /* the log talking about itself — 90s */
  REVERSAL: 90,
} as const;

export type EventKind = (typeof EVENT)[keyof typeof EVENT];

/** Names for readouts and the admin page. Never parsed, never stored — the number is what is stored. */
export const EVENT_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(EVENT).map(([name, id]) => [id, name])),
);

export function isKnownKind(kind: number): boolean {
  return Object.prototype.hasOwnProperty.call(EVENT_NAMES, kind);
}

/**
 * Which kinds a reversal is allowed to name.
 *
 * Not everything can be undone, and pretending otherwise is worse than refusing. `RUN_SUBMITTED` is a
 * statement that a thing arrived — reversing it would be a lie about history; the answer to a bad run is
 * `RUN_REVOKED`, which is itself a new fact. `ADMIN_NOTE` cannot be reversed because a note is somebody's
 * account of events and editing those is exactly what this file exists to prevent. And `REVERSAL` is not
 * reversible, so an undo cannot be undone: if the undo was wrong, re-apply the original as a fresh row
 * with its own attribution, and the log shows all three things happening in the order they happened.
 *
 * That re-application is a *restore*, and it is a first-class thing rather than an untracked new row — see
 * `restores` on the draft. The rule against reversing a reversal stays exactly as it is: a restore is a new
 * action of the original kind, fully reversible again, so an operator can go back and forth as many times
 * as needed without anybody ever having to count how many undos deep the account currently is.
 */
export const REVERSIBLE: ReadonlySet<number> = new Set<number>([
  EVENT.GOLD_GRANTED,
  EVENT.GOLD_SPENT,
  EVENT.UNLOCK_GRANTED,
  EVENT.POWERUP_PURCHASED,
  EVENT.MARKS_GRANTED,
  EVENT.MARKS_SPENT,
  EVENT.RUN_ACCEPTED,
  EVENT.RUN_REVOKED,
  EVENT.SCORE_POSTED,
  EVENT.SCORE_REMOVED,
  EVENT.SEASON_PAID,
  EVENT.ACCOUNT_FLAGGED,
  EVENT.ACCOUNT_SEGREGATED,
  EVENT.CHAT_STRIKE,
  EVENT.CHAT_MUTED,
  EVENT.CHAT_BANNED,
  EVENT.BUILD_QUARANTINED,
]);

/* ---------------------------------------------------------------------------------------------- */
/* The row                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** Payload values are primitives only. See `validate` for why. */
export type Scalar = string | number | boolean;

/** What a caller hands in. Everything the log itself owns — sequence, hashes — is added on append. */
export interface EventDraft {
  kind: number;
  actorKind: number;
  /** Which admin, which job, which player. Never empty. */
  actorId: string;
  /** The account this is about. Empty string for rows about the world rather than a person. */
  subjectId: string;
  /** The build the actor was running. 0 when it does not apply (a job, the admin page). */
  buildId: number;
  /** Wall-clock milliseconds. Evidence, not ordering. */
  at: number;
  /** Flat bag of primitives. */
  payload: Readonly<Record<string, Scalar>>;
  /** The sequence number this row undoes, or 0. */
  reverses: number;
  /**
   * The sequence number of the *reversal* this row puts back, or 0.
   *
   * This is the redo link. A restore is an ordinary row of the original kind — it is not a reversal, it
   * carries no special power, and it can itself be reversed like anything else. The only thing this field
   * adds is the sentence "this exists because the undo at row N was a mistake", so the three rows read as
   * one story instead of as an unexplained handout sitting next to an undo.
   *
   * Without it the history is still correct and still complete; it is just anonymous, and an anonymous
   * grant is the row somebody flags during an audit six months from now.
   */
  restores: number;
  /** Ties a bulk action together so it can be undone as one. Empty string for a lone row. */
  groupId: string;
}

/** A row that is in the log. `seq` is assigned by the log and is the only ordering that counts. */
export interface EventRow extends EventDraft {
  seq: number;
  prevHash: string;
  hash: string;
}

/** Limits. Generous enough that no honest row hits them, tight enough that a bug cannot fill the disk. */
export const LIMITS = {
  ACTOR_ID_CHARS: 64,
  SUBJECT_ID_CHARS: 64,
  GROUP_ID_CHARS: 64,
  PAYLOAD_KEYS: 24,
  PAYLOAD_KEY_CHARS: 32,
  PAYLOAD_STRING_CHARS: 512,
} as const;

/** The hash a first row commits to. Sixty-four zeroes: not a hash of anything, and obviously so. */
export const GENESIS_HASH = "0".repeat(64);

/* ---------------------------------------------------------------------------------------------- */
/* Canonical form and hashing                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The exact bytes a row's hash is taken over.
 *
 * Hand-built rather than `JSON.stringify(row)`, for the same reason the save snapshot walks keys in sorted
 * order: two runs of the same code must produce identical bytes for identical facts, forever, and
 * `JSON.stringify` on an object literal quietly depends on the order the fields were written in the
 * source. A field reordered during a refactor would invalidate every hash in the log — a whole-history
 * corruption caused by moving a line, discovered months later.
 *
 * Payload keys are sorted and each pair is length-prefixed, so `{ab:"c"}` and `{a:"bc"}` cannot serialize
 * to the same string. Without the lengths they could, and two different facts sharing a hash is exactly
 * the hole a tamper-evident log must not have.
 */
export function canonical(row: EventDraft & { seq: number; prevHash: string }): string {
  const parts: string[] = [
    // v2 added the redo link. The version prefix is here exactly so a format change is a visible, dated
    // fact rather than a silent one: rows written under an older prefix would still verify against the
    // reader that wrote them. Widening the row was free this once because the table held no real rows yet;
    // after launch a change like this needs the old canonical form kept alongside the new one.
    "v2",
    String(row.seq),
    String(row.kind),
    String(row.actorKind),
    field(row.actorId),
    field(row.subjectId),
    String(row.buildId),
    String(row.at),
    String(row.reverses),
    String(row.restores),
    field(row.groupId),
    row.prevHash,
  ];

  const keys = Object.keys(row.payload).sort();
  parts.push(String(keys.length));
  for (const key of keys) {
    const value = row.payload[key] as Scalar;
    parts.push(field(key));
    // The type letter is part of the bytes: the number 1, the string "1" and the boolean true are
    // different facts and must not hash alike.
    parts.push(typeof value === "string" ? `s${field(value)}` : typeof value === "number" ? `n${value}` : `b${value ? 1 : 0}`);
  }

  return parts.join("|");
}

/** Length-prefixed so a separator inside a value cannot be mistaken for a separator between values. */
function field(value: string): string {
  return `${value.length}:${value}`;
}

/** SHA-256 hex of the canonical bytes. */
export function hashOf(row: EventDraft & { seq: number; prevHash: string }): string {
  return createHash("sha256").update(canonical(row), "utf8").digest("hex");
}

/** Seal a draft into a row: assign its place in the chain and compute its hash. Never mutates the draft. */
export function seal(draft: EventDraft, seq: number, prevHash: string): EventRow {
  const base = { ...draft, payload: { ...draft.payload }, seq, prevHash };
  return { ...base, hash: hashOf(base) };
}

/* ---------------------------------------------------------------------------------------------- */
/* Validation                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export const BAD = {
  NONE: 0,
  UNKNOWN_KIND: 1,
  UNKNOWN_ACTOR: 2,
  NO_ACTOR_ID: 3,
  TOO_LONG: 4,
  BAD_TIME: 5,
  BAD_BUILD: 6,
  BAD_PAYLOAD: 7,
  TOO_MANY_KEYS: 8,
  REVERSAL_NEEDS_TARGET: 9,
  REVERSAL_FORBIDDEN: 10,
  NOT_REVERSIBLE: 11,
  ALREADY_REVERSED: 12,
  NO_SUCH_TARGET: 13,
  TARGET_NOT_BEFORE: 14,
  SUBJECT_MISMATCH: 15,
  RESTORE_NEEDS_TARGET: 16,
  RESTORE_FORBIDDEN: 17,
  NOT_A_REVERSAL: 18,
  ALREADY_RESTORED: 19,
  RESTORE_KIND_MISMATCH: 20,
} as const;

export type BadReason = (typeof BAD)[keyof typeof BAD];

export const BAD_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(BAD).map(([name, id]) => [id, name])),
);

/**
 * Is this draft appendable at all, ignoring anything about the rest of the log.
 *
 * Payloads are flat bags of primitives and nothing else. No nested objects, no arrays, no null, no
 * undefined, no NaN, no Infinity. The reason is not fussiness: a payload that can hold a structure will
 * eventually hold a *different* structure for the same event kind, and then a reader six months from now
 * has to guess which shape a row is. Flat primitives keep every row readable by a reader that has never
 * heard of the kind — which is the reader who matters during an incident.
 */
export function validate(draft: EventDraft): BadReason {
  if (!isKnownKind(draft.kind)) return BAD.UNKNOWN_KIND;
  if (draft.actorKind !== ACTOR.SYSTEM && draft.actorKind !== ACTOR.SERVER && draft.actorKind !== ACTOR.PLAYER && draft.actorKind !== ACTOR.ADMIN) {
    return BAD.UNKNOWN_ACTOR;
  }
  if (draft.actorId === "") return BAD.NO_ACTOR_ID;
  if (draft.actorId.length > LIMITS.ACTOR_ID_CHARS) return BAD.TOO_LONG;
  if (draft.subjectId.length > LIMITS.SUBJECT_ID_CHARS) return BAD.TOO_LONG;
  if (draft.groupId.length > LIMITS.GROUP_ID_CHARS) return BAD.TOO_LONG;

  if (!Number.isSafeInteger(draft.at) || draft.at < 0) return BAD.BAD_TIME;
  if (!Number.isSafeInteger(draft.buildId) || draft.buildId < 0) return BAD.BAD_BUILD;
  if (!Number.isSafeInteger(draft.reverses) || draft.reverses < 0) return BAD.REVERSAL_NEEDS_TARGET;
  if (!Number.isSafeInteger(draft.restores) || draft.restores < 0) return BAD.RESTORE_NEEDS_TARGET;

  const keys = Object.keys(draft.payload);
  if (keys.length > LIMITS.PAYLOAD_KEYS) return BAD.TOO_MANY_KEYS;
  for (const key of keys) {
    if (key === "" || key.length > LIMITS.PAYLOAD_KEY_CHARS) return BAD.BAD_PAYLOAD;
    const value = draft.payload[key];
    if (typeof value === "string") {
      if (value.length > LIMITS.PAYLOAD_STRING_CHARS) return BAD.TOO_LONG;
      continue;
    }
    if (typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return BAD.BAD_PAYLOAD;
      continue;
    }
    return BAD.BAD_PAYLOAD;
  }

  // A reversal must name a target; nothing else may.
  if (draft.kind === EVENT.REVERSAL && draft.reverses === 0) return BAD.REVERSAL_NEEDS_TARGET;
  if (draft.kind !== EVENT.REVERSAL && draft.reverses !== 0) return BAD.REVERSAL_FORBIDDEN;

  // A row cannot be an undo and a redo at once. If that were allowed the two links would eventually
  // disagree with each other and the reader would have to pick which one to believe.
  if (draft.restores !== 0) {
    if (draft.kind === EVENT.REVERSAL) return BAD.RESTORE_FORBIDDEN;
    // A restore must be a kind that can be undone again, otherwise the very first redo would be a one-way
    // door — the opposite of the point.
    if (!REVERSIBLE.has(draft.kind)) return BAD.NOT_REVERSIBLE;
  }

  return BAD.NONE;
}

/**
 * What the log needs to know about a reversal's target before accepting it.
 *
 * Passed in rather than looked up, so this stays a pure rule: the storage half fetches the target row and
 * whether anything already reverses it, and the decision is made here where it can be tested.
 */
export interface TargetFacts {
  exists: boolean;
  seq: number;
  kind: number;
  subjectId: string;
  alreadyReversed: boolean;
}

/**
 * Can this reversal be appended.
 *
 * The subject check is the one that earns its keep: a reversal has to be about the same account as the row
 * it undoes. Without it, a mistyped account id in a bulk reversal takes gold away from a bystander and the
 * log dutifully records it as legitimate.
 */
export function validateReversal(draft: EventDraft, nextSeq: number, target: TargetFacts): BadReason {
  const basic = validate(draft);
  if (basic !== BAD.NONE) return basic;
  if (draft.kind !== EVENT.REVERSAL) return BAD.REVERSAL_FORBIDDEN;
  if (!target.exists) return BAD.NO_SUCH_TARGET;
  if (target.seq !== draft.reverses) return BAD.NO_SUCH_TARGET;
  if (draft.reverses >= nextSeq) return BAD.TARGET_NOT_BEFORE;
  if (target.kind === EVENT.REVERSAL) return BAD.NOT_REVERSIBLE;
  if (!REVERSIBLE.has(target.kind)) return BAD.NOT_REVERSIBLE;
  if (target.alreadyReversed) return BAD.ALREADY_REVERSED;
  if (target.subjectId !== draft.subjectId) return BAD.SUBJECT_MISMATCH;
  return BAD.NONE;
}

/* ---------------------------------------------------------------------------------------------- */
/* Restoring — the redo                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the log needs to know about the reversal a restore is putting back.
 *
 * `reversedKind` and `reversedSubjectId` are the *original* row's — the one the reversal undid. They are
 * carried here because the restore has to match them, and the rule that checks that has to be testable
 * without a database.
 */
export interface RestoreFacts {
  /** The reversal named by `draft.restores`. */
  exists: boolean;
  seq: number;
  /** The named row's own kind. Must be `REVERSAL`; anything else means the caller named the wrong row. */
  kind: number;
  subjectId: string;
  /** The kind of the row that reversal undid. */
  reversedKind: number;
  reversedSubjectId: string;
  /** Whether some earlier row already restored this same reversal. */
  alreadyRestored: boolean;
}

/**
 * Can this restore be appended.
 *
 * The three guards, and why each one is not paranoia:
 *
 * `NOT_A_REVERSAL` — a restore has to name a row that genuinely undid something. Without this the link
 * becomes a free-text justification: point it at any row at all and a gold grant acquires a story that
 * reads like an approved correction.
 *
 * `RESTORE_KIND_MISMATCH` and the subject checks — the restore must put back the same kind of thing, for the
 * same account, as the reversal took away. "I undid a mute, so here is 10,000 gold" is not a redo, and a
 * mistyped account id must not be able to turn one player's correction into another player's windfall. This
 * is the same reasoning as the subject check on reversals, which is the check that earns its keep there.
 *
 * `ALREADY_RESTORED` — one reversal, at most one restore. Going back and forth again is not another restore
 * of the same reversal; it is a reversal of the restore, then a restore of *that*. Each link therefore
 * points at exactly one thing and the chain reads in a single direction, which is what stops "how deep are
 * we" from ever becoming a question a human has to answer under pressure.
 */
export function validateRestore(draft: EventDraft, nextSeq: number, target: RestoreFacts): BadReason {
  const basic = validate(draft);
  if (basic !== BAD.NONE) return basic;
  if (draft.restores === 0) return BAD.RESTORE_NEEDS_TARGET;
  if (!target.exists) return BAD.NO_SUCH_TARGET;
  if (target.seq !== draft.restores) return BAD.NO_SUCH_TARGET;
  if (draft.restores >= nextSeq) return BAD.TARGET_NOT_BEFORE;
  if (target.kind !== EVENT.REVERSAL) return BAD.NOT_A_REVERSAL;
  if (target.alreadyRestored) return BAD.ALREADY_RESTORED;
  if (draft.kind !== target.reversedKind) return BAD.RESTORE_KIND_MISMATCH;
  if (draft.subjectId !== target.subjectId) return BAD.SUBJECT_MISMATCH;
  if (draft.subjectId !== target.reversedSubjectId) return BAD.SUBJECT_MISMATCH;
  return BAD.NONE;
}

/** One step in a row's history, in the order the steps happened. */
export interface StoryStep {
  seq: number;
  kind: number;
  /** `did` the original thing, `undid` it, or `redid` it. */
  role: "did" | "undid" | "redid";
  actorKind: number;
  actorId: string;
  at: number;
}

/**
 * Stitch one row together with everything that was later done about it.
 *
 * This is what the admin page shows instead of three unrelated lines. Start from any row in the chain and
 * the whole story comes back in order — granted, undone, granted again, undone again — walked by following
 * the links rather than by guessing from timestamps, because timestamps here are evidence and not ordering.
 *
 * Pure, and given the rows rather than a database, so the walk can be tested on a chain far longer than
 * anybody will ever produce by hand.
 */
export function storyOf(rows: readonly EventRow[], seq: number): StoryStep[] {
  const bySeq = new Map<number, EventRow>();
  const reversalOf = new Map<number, EventRow>();
  const restoreOf = new Map<number, EventRow>();
  for (const row of rows) {
    bySeq.set(row.seq, row);
    if (row.kind === EVENT.REVERSAL && row.reverses > 0) reversalOf.set(row.reverses, row);
    if (row.restores > 0) restoreOf.set(row.restores, row);
  }

  // Walk backwards to the row that started it, so the caller can hand us any link in the chain.
  let root = bySeq.get(seq);
  const guard = new Set<number>();
  while (root !== undefined && !guard.has(root.seq)) {
    guard.add(root.seq);
    const back = root.kind === EVENT.REVERSAL ? root.reverses : root.restores;
    if (back <= 0) break;
    const previous = bySeq.get(back);
    if (previous === undefined) break;
    root = previous;
  }
  if (root === undefined) return [];

  const steps: StoryStep[] = [];
  const seen = new Set<number>();
  let current: EventRow | undefined = root;
  let role: StoryStep["role"] = "did";

  while (current !== undefined && !seen.has(current.seq)) {
    seen.add(current.seq);
    steps.push({
      seq: current.seq,
      kind: current.kind,
      role,
      actorKind: current.actorKind,
      actorId: current.actorId,
      at: current.at,
    });

    if (role === "undid") {
      current = restoreOf.get(current.seq);
      role = "redid";
    } else {
      current = reversalOf.get(current.seq);
      role = "undid";
    }
  }

  return steps;
}

/* ---------------------------------------------------------------------------------------------- */
/* Verifying a chain                                                                               */
/* ---------------------------------------------------------------------------------------------- */

export const CHAIN = {
  OK: 0,
  SEQ_NOT_ASCENDING: 1,
  SEQ_GAP: 2,
  PREV_MISMATCH: 3,
  HASH_MISMATCH: 4,
} as const;

export type ChainFault = (typeof CHAIN)[keyof typeof CHAIN];

export const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(CHAIN).map(([name, id]) => [id, name])),
);

export interface ChainReport {
  ok: boolean;
  fault: ChainFault;
  /** Index within the slice checked, not a sequence number. -1 when clean. */
  at: number;
  /** Rows whose timestamp is earlier than their predecessor's. Odd, never fatal. */
  clockSteps: number;
  checked: number;
  lastHash: string;
}

/**
 * Verify a contiguous run of rows.
 *
 * `expectedPrevHash` is what the row before the slice hashed to — `GENESIS_HASH` when checking from the
 * very beginning. Being able to check a slice matters: verifying a hundred million rows to answer a
 * question about last Tuesday is not a check anybody will run, and a check nobody runs is not a check.
 *
 * A gap in sequence numbers is a fault. It has to be: the whole promise is that nothing is removed, so a
 * missing number means either a deletion or a failed write that was never reconciled, and both need a
 * human. (A log that allocated a number and then failed to write the row must record that, which is what
 * a `REVERSAL` of nothing would be — so instead the storage half only ever allocates a number for a row it
 * has already accepted.)
 */
export function verifyChain(rows: readonly EventRow[], expectedPrevHash = GENESIS_HASH): ChainReport {
  const report: ChainReport = {
    ok: true,
    fault: CHAIN.OK,
    at: -1,
    clockSteps: 0,
    checked: rows.length,
    lastHash: expectedPrevHash,
  };

  let prevHash = expectedPrevHash;
  let prevSeq = -1;
  let prevAt = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as EventRow;

    if (prevSeq >= 0) {
      if (row.seq <= prevSeq) return fail(report, CHAIN.SEQ_NOT_ASCENDING, i, prevHash);
      if (row.seq !== prevSeq + 1) return fail(report, CHAIN.SEQ_GAP, i, prevHash);
    }
    if (row.prevHash !== prevHash) return fail(report, CHAIN.PREV_MISMATCH, i, prevHash);
    if (hashOf(row) !== row.hash) return fail(report, CHAIN.HASH_MISMATCH, i, prevHash);

    if (prevAt >= 0 && row.at < prevAt) report.clockSteps++;

    prevHash = row.hash;
    prevSeq = row.seq;
    prevAt = row.at;
  }

  report.lastHash = prevHash;
  return report;
}

function fail(report: ChainReport, fault: ChainFault, at: number, lastHash: string): ChainReport {
  report.ok = false;
  report.fault = fault;
  report.at = at;
  report.lastHash = lastHash;
  return report;
}

/* ---------------------------------------------------------------------------------------------- */
/* Bulk reversal                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export interface BulkPlan {
  /** Drafts to append, newest target first. */
  drafts: EventDraft[];
  /** Targets skipped, with the reason. A bulk reversal reports rather than refuses. */
  skipped: { seq: number; reason: BadReason }[];
}

/**
 * Plan the undo of a whole group.
 *
 * Newest first, deliberately. Reversals are applied in the opposite order to the events, so any projection
 * that is not perfectly commutative — a balance with a floor at zero, a "highest score" that only moves
 * up — unwinds through states that actually occurred rather than through states that never existed.
 *
 * Rows that cannot be reversed are skipped with a reason instead of aborting the whole plan. This is the
 * moderation requirement made concrete: when a bad automated wave has hit ten thousand accounts, an
 * all-or-nothing undo that trips over one already-reverted row leaves the other 9,999 punished. Report the
 * exceptions, undo everything else, and put the report in front of a human.
 *
 * The plan is pure — it appends nothing. The caller appends the drafts one at a time through the normal
 * path, so every reversal is validated, sealed and chained exactly like any other row. There is no bulk
 * fast lane, because a fast lane is a second way in, and a second way in is where the rule gets broken.
 */
export function planGroupReversal(
  rows: readonly EventRow[],
  groupId: string,
  reversedSeqs: ReadonlySet<number>,
  actorKind: number,
  actorId: string,
  at: number,
  reason: string,
  newGroupId: string,
): BulkPlan {
  const plan: BulkPlan = { drafts: [], skipped: [] };
  if (groupId === "") return plan;

  const targets = rows.filter((r) => r.groupId === groupId).sort((a, b) => b.seq - a.seq);

  for (const target of targets) {
    if (target.kind === EVENT.REVERSAL || !REVERSIBLE.has(target.kind)) {
      plan.skipped.push({ seq: target.seq, reason: BAD.NOT_REVERSIBLE });
      continue;
    }
    if (reversedSeqs.has(target.seq)) {
      plan.skipped.push({ seq: target.seq, reason: BAD.ALREADY_REVERSED });
      continue;
    }
    plan.drafts.push(reversalDraftFor(target, actorKind, actorId, at, reason, newGroupId));
  }

  return plan;
}

/**
 * Build the row that undoes one row.
 *
 * The single-row undo and the bulk undo produce the identical shape, because they are the same fact and a
 * reader during an incident should not have to know which screen produced it. The bulk planner calls this
 * too — one shape, one place, no drift.
 *
 * Nothing is checked here. Whether this target may be undone at all is decided by `validateReversal` on
 * append, with the log's own view of the target in hand; checking it twice in two places is how the two
 * answers eventually differ.
 */
export function reversalDraftFor(
  target: EventRow,
  actorKind: number,
  actorId: string,
  at: number,
  reason: string,
  groupId = "",
): EventDraft {
  return {
    kind: EVENT.REVERSAL,
    actorKind,
    actorId,
    subjectId: target.subjectId,
    buildId: 0,
    at,
    // The payload carries the *why* and enough of the *what* to read the reversal without fetching its
    // target. An undo nobody can explain is an undo nobody will trust enough to run.
    payload: { reason, ofKind: target.kind, ofGroup: target.groupId },
    reverses: target.seq,
    restores: 0,
    groupId,
  };
}

/**
 * Build the row that puts back what a reversal took away.
 *
 * The kind, the subject and the payload come from the *original* row, not from the caller. That is the whole
 * safety of the redo path: an operator asks to put row 412 back and gets exactly row 412's effect again, not
 * an amount they typed while tired. The only things the caller contributes are who they are, when, and why.
 *
 * `reason` is stored under its own key so it cannot collide with a payload field the original kind owns, and
 * the two link fields are recorded in the payload as well — so a reader looking at this single row, with no
 * ability to query anything else, can still see what it is putting back and why.
 */
export function restoreDraftFor(
  original: EventRow,
  reversal: EventRow,
  actorKind: number,
  actorId: string,
  at: number,
  reason: string,
  groupId = "",
): EventDraft {
  return {
    kind: original.kind,
    actorKind,
    actorId,
    subjectId: original.subjectId,
    buildId: 0,
    at,
    payload: { ...original.payload, restoreReason: reason, restoreOfSeq: original.seq, undoneBySeq: reversal.seq },
    reverses: 0,
    restores: reversal.seq,
    groupId,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Projection                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export interface AccountView {
  gold: number;
  marks: number;
  unlocks: number;
  runsAccepted: number;
  runsRevoked: number;
  strikes: number;
  muted: boolean;
  chatBanned: boolean;
  flagged: boolean;
  segregated: boolean;
  events: number;
  reversed: number;
}

export function emptyAccountView(): AccountView {
  return {
    gold: 0,
    marks: 0,
    unlocks: 0,
    runsAccepted: 0,
    runsRevoked: 0,
    strikes: 0,
    muted: false,
    chatBanned: false,
    flagged: false,
    segregated: false,
    events: 0,
    reversed: 0,
  };
}

/**
 * Rebuild one account's standing from the log alone.
 *
 * This is a demonstration as much as a feature: it is the proof that the log is sufficient, that nothing
 * important lives only in a column somewhere. If a fact cannot be recomputed here then it is not really in
 * the log, and the recovery stories that depend on the log are fiction for that fact.
 *
 * A reversed row contributes nothing. It is not removed and its numbers are not negated — the fold simply
 * skips it, which is why the reversal ordering above matters for projections with floors, and why "how did
 * we get to this number" always has an answer that reads forwards.
 */
export function foldAccount(rows: readonly EventRow[], subjectId: string): AccountView {
  const view = emptyAccountView();

  const reversed = new Set<number>();
  for (const row of rows) if (row.kind === EVENT.REVERSAL && row.reverses > 0) reversed.add(row.reverses);

  for (const row of rows) {
    if (row.subjectId !== subjectId) continue;
    view.events++;
    if (reversed.has(row.seq)) {
      view.reversed++;
      continue;
    }

    const amount = numberOf(row.payload.amount);

    switch (row.kind) {
      case EVENT.GOLD_GRANTED:
        view.gold += amount;
        break;
      case EVENT.GOLD_SPENT:
      case EVENT.POWERUP_PURCHASED:
        view.gold -= amount;
        break;
      case EVENT.MARKS_GRANTED:
      case EVENT.SEASON_PAID:
        view.marks += amount;
        break;
      case EVENT.MARKS_SPENT:
        view.marks -= amount;
        break;
      case EVENT.UNLOCK_GRANTED:
        view.unlocks++;
        break;
      case EVENT.RUN_ACCEPTED:
        view.runsAccepted++;
        break;
      case EVENT.RUN_REVOKED:
        view.runsRevoked++;
        break;
      case EVENT.CHAT_STRIKE:
        view.strikes++;
        break;
      case EVENT.CHAT_MUTED:
        view.muted = true;
        break;
      case EVENT.CHAT_BANNED:
        view.chatBanned = true;
        break;
      case EVENT.CHAT_CLEARED:
        // One row lifts both, because "cleared" is the moderation ladder's reset and splitting it into
        // two rows would allow a state where a player is unmuted but still banned, which means nothing.
        view.muted = false;
        view.chatBanned = false;
        view.strikes = 0;
        break;
      case EVENT.ACCOUNT_FLAGGED:
        view.flagged = true;
        break;
      case EVENT.ACCOUNT_SEGREGATED:
        view.segregated = true;
        break;
      case EVENT.ACCOUNT_RESTORED:
        view.flagged = false;
        view.segregated = false;
        break;
      default:
        break;
    }
  }

  return view;
}

function numberOf(value: Scalar | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
